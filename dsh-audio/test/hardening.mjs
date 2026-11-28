/**
 * Adversarial hardening pass over the 17 model-facing tools.
 *
 * This is a bug-finding suite, not a fixing one: it drives the registered tools
 * through a fake Cordis context and a local TTS mock, then reports what breaks.
 * Every failing call prints the exact reproducing arguments so the lead can fix
 * it without reconstructing the case.
 *
 * What counts as BUG: a crash (a throw that is not a tool-authored `Error`), a
 * corrupt or silently empty output, a NaN/Infinity that leaks into a successful
 * result, a dishonest success (checked nothing / ignored work), or a resource
 * guard that only fires after the work was done. A poor-but-safe message or a
 * slow path is WARN.
 *
 * The process exits non-zero only when at least one BUG was observed.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Must be the first plugin import: every tool module snapshots
// Object.keys(PRESETS) when it is evaluated, so the extra presets have to be
// registered before their module bodies run (index.js has the same constraint).
import { registerExtraPresets } from '../lib/presets-extra.js'

import { measure } from '../lib/audio.js'
import { registerCheckTool } from '../lib/check.js'
import { STRETCH_LIMITS } from '../lib/stretch.js'
import { registerBindTools } from '../lib/tools-bind.js'
import { registerComposeTools } from '../lib/tools-compose.js'
import { registerConvertTools } from '../lib/tools-convert.js'
import { registerDesignTools } from '../lib/tools-design.js'
import { registerGenerateTools } from '../lib/tools-generate.js'
import { registerLoudnessTools } from '../lib/tools-loudness.js'
import { registerSingTools } from '../lib/tools-sing.js'
import { registerStretchTools } from '../lib/tools-stretch.js'
import { registerTools } from '../lib/tools.js'
import { registerTtsTool, registerVoicesTool } from '../lib/tts.js'
import { registerVisualTools } from '../lib/tools-visual.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

/* ------------------------------------------------------------- harness -- */

const results = { ok: 0, warn: 0, bug: 0 }
const bugList = []
const errorRows = []
let nonErrorThrows = 0
const startedAt = Date.now()

const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-hardening-'))
const workingDirectory = { get: () => cwd }

function makeRegistry () {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    get: (name) => (name === 'workingDirectory' ? workingDirectory : undefined)
  }
  return { tools, ctx }
}

const primary = makeRegistry()
const offline = makeRegistry()
const exec = { agent: { session: { id: 'hardening' } } }

function section (title) {
  console.log(`\n== ${title} ==`)
}

function showArgs (args) {
  const text = JSON.stringify(args ?? {}, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && value.length > 70) return `${value.slice(0, 50)}…(${value.length} chars)`
    if (Array.isArray(value) && value.length > 8) return [...value.slice(0, 3), `…${value.length} items`]
    return value
  })
  return text.length > 230 ? `${text.slice(0, 227)}…` : text
}

function messageFlags (error) {
  const text = String(error?.message ?? '')
  const flags = []
  if (text.trim() === '') flags.push('empty message')
  if (/undefined/.test(text)) flags.push('mentions undefined')
  if (/\[object Object\]/.test(text)) flags.push('[object Object]')
  if (/\bNaN\b/.test(text)) flags.push('mentions NaN')
  return flags
}

function brief (value) {
  if (value === null || typeof value !== 'object') return String(value)
  const parts = []
  const path = value.path ?? value.jsPath ?? value.relativePath
  if (path !== undefined) parts.push(String(path).split(/[\\/]/).pop())
  if (value.bytes !== undefined) parts.push(`${value.bytes} B`)
  if (value.durationSeconds !== undefined) parts.push(`${value.durationSeconds}s`)
  if (value.metrics !== undefined) {
    const bad = nonFinitePath(value.metrics)
    if (bad !== null) parts.push(`non-finite ${bad}`)
    else if (value.metrics.peakDbfs !== undefined) parts.push(`peak ${value.metrics.peakDbfs} dBFS`)
  }
  if (value.verdict !== undefined) parts.push(`verdict ${value.verdict}`)
  if (value.files !== undefined && Array.isArray(value.files)) parts.push(`${value.files.length} file(s)`)
  if (value.refused === true) parts.push('refused')
  if (parts.length === 0) return JSON.stringify(value).slice(0, 160)
  return parts.join(' · ')
}

/** First non-finite number anywhere in a result graph, as `a.b[0]=NaN`; null if clean. */
function nonFinitePath (value, path = 'result') {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}=${value}`
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = nonFinitePath(value[index], `${path}[${index}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = nonFinitePath(item, `${path}.${key}`)
      if (found !== null) return found
    }
  }
  return null
}

function ok (label, detail = '') {
  results.ok += 1
  console.log(`ok   ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function warn (label, detail) {
  results.warn += 1
  console.log(`WARN ${label} — ${detail}`)
}

function bug (label, detail) {
  results.bug += 1
  bugList.push({ label, detail })
  console.log(`BUG  ${label} — ${detail}`)
}

async function invoke (name, args, registry = primary) {
  const definition = registry.tools.get(name)
  if (definition === undefined) throw new Error(`unregistered tool "${name}"`)
  const before = Date.now()
  try {
    const value = await definition.execute(args, exec)
    return { ok: true, value, ms: Date.now() - before }
  } catch (error) {
    return { ok: false, error, ms: Date.now() - before }
  }
}

async function exists (path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Call a tool that must reject the request, and grade the rejection.
 * A throw whose constructor is not `Error` is a crash (BUG); a success is an
 * accepted invalid request (BUG); an empty/undefined/NaN message is WARN.
 */
async function expectError (label, name, args, options = {}) {
  const outcome = await invoke(name, args, options.registry ?? primary)
  const where = `${name} ${showArgs(args)}`
  if (outcome.ok) {
    bug(`${label}: accepted an invalid request`, `${where} -> ${brief(outcome.value)}`)
    return outcome.value
  }
  const error = outcome.error
  const message = String(error?.message ?? '')
  const flags = messageFlags(error)
  errorRows.push({ label, where, ms: outcome.ms, message, flags: flags.join(', ') })
  if (!(error instanceof Error)) {
    nonErrorThrows += 1
    bug(`${label}: threw a non-Error value`, `${where} -> ${String(error)}`)
    return error
  }
  if (error.constructor !== Error) {
    bug(`${label}: crashed instead of rejecting (${error.constructor.name})`, `${where} -> ${message}`)
    return error
  }
  if (flags.length > 0) warn(`${label}: poor error message`, `${where} -> "${message}" [${flags.join(', ')}]`)
  if (options.match instanceof RegExp && !options.match.test(message)) {
    warn(`${label}: message does not explain the rejection`, `${where} -> "${message}"`)
  }
  if (options.maxMs !== undefined && outcome.ms > options.maxMs) {
    bug(`${label}: guard fired after doing the work`, `${outcome.ms}ms > ${options.maxMs}ms | ${where}`)
    return error
  }
  ok(label)
  return error
}

/** Call a tool that must succeed and whose result must respect the render invariants. */
async function checkRender (label, name, args, options = {}) {
  const first = await invoke(name, args)
  const where = `${name} ${showArgs(args)}`
  if (!first.ok) {
    bug(`${label}: render threw`, `${where} -> ${String(first.error?.message ?? first.error)}`)
    return null
  }
  const value = first.value
  const problems = []
  const bad = nonFinitePath(value)
  if (bad !== null) problems.push(`non-finite number at ${bad}`)
  const duration = Number(value.durationSeconds ?? value.metrics?.durationSeconds)
  if (!(duration > 0)) problems.push(`durationSeconds=${duration}`)
  if (options.peak !== false && value.metrics !== undefined && !(Number(value.metrics.peakDbfs) <= 0)) {
    problems.push(`peakDbfs=${value.metrics.peakDbfs}`)
  }
  if (options.allowNoPath === true && (value.path === undefined || value.path === null)) {
    // A measurement-only call legitimately writes nothing.
  } else if (value.path === undefined || value.path === null) problems.push('no output path')
  else if (!await exists(value.path)) problems.push(`output file missing: ${value.path}`)

  let firstBytes = null
  if (options.deterministic !== false && typeof value.path === 'string') {
    firstBytes = await readFile(value.path).catch(() => null)
  }
  if (options.deterministic !== false && firstBytes !== null) {
    const second = await invoke(name, args)
    if (!second.ok) problems.push('second identical call threw')
    else {
      const secondBytes = await readFile(value.path).catch(() => null)
      if (secondBytes === null || !firstBytes.equals(secondBytes)) problems.push('second identical call produced different bytes')
    }
  }
  if (problems.length > 0) {
    bug(`${label}: ${problems.join('; ')}`, where)
    return value
  }
  const metrics = value.metrics ?? {}
  const detail = [
    `${Number(duration).toFixed(3)}s`,
    metrics.peakDbfs === undefined ? null : `peak ${Number(metrics.peakDbfs).toFixed(2)} dBFS`,
    value.bytes === undefined ? null : `${value.bytes} B`,
    `${options.deterministic === false ? 'single call' : 'byte-identical repeat'}`
  ].filter(Boolean).join(' · ')
  ok(`${label}`, detail)
  return value
}

/** Measure a written wav and return { peakDbfs, rmsDbfs, durationSeconds } of the file. */
async function probeFile (path) {
  const decoded = decodeWav(await readFile(path))
  const mono = decoded.channels.length === 1
    ? decoded.channels[0]
    : (() => {
        const out = new Float32Array(decoded.channels[0].length)
        for (const channel of decoded.channels) for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / decoded.channels.length
        return out
      })()
  const metrics = measure(mono, decoded.sampleRate)
  return { peakDbfs: metrics.peakDbfs, rmsDbfs: metrics.rmsDbfs, durationSeconds: decoded.durationSeconds, frameCount: mono.length }
}

/* ------------------------------------------------------- TTS mock server -- */
// The MiniMax path is exercised with a local endpoint so no key or network is
// needed and chunk stitching, guards and error paths stay offline.

const ttsRequests = []
const ttsServer = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    let body = {}
    try { body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { body = {} }
    ttsRequests.push({ url: request.url, body })
    if (request.url.startsWith('/v1/t2a_v2')) {
      const frames = Math.round(0.3 * 32000)
      const pcm = Buffer.alloc(frames * 2)
      for (let i = 0; i < frames; i += 1) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / 32000) * 12000), i * 2)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        data: { audio: pcm.toString('hex'), subtitle: [{ text: '第一句。', start: 0, end: 300 }, { text: '第二句。', start: 320, end: 600 }] },
        base_resp: { status_code: 0 }
      }))
      return
    }
    response.writeHead(404)
    response.end('no such endpoint')
  })
})
await new Promise((resolveListen) => ttsServer.listen(0, '127.0.0.1', resolveListen))
const ttsBase = `http://127.0.0.1:${ttsServer.address().port}`
const ttsConfig = { tts: { provider: 'minimax', baseUrl: ttsBase, apiKey: 'test-key', model: 'speech-2.8-hd', voice: 'female-shaonv' } }

/* ----------------------------------------------------------- fixtures -- */

registerExtraPresets()
registerTools(primary.ctx)
registerTtsTool(primary.ctx, ttsConfig)
registerVoicesTool(primary.ctx, ttsConfig)
registerCheckTool(primary.ctx, {})
registerGenerateTools(primary.ctx, {})
registerConvertTools(primary.ctx)
registerLoudnessTools(primary.ctx)
registerDesignTools(primary.ctx)
registerVisualTools(primary.ctx)
registerBindTools(primary.ctx)
registerComposeTools(primary.ctx)
registerSingTools(primary.ctx)
registerStretchTools(primary.ctx)
// A second registry with no provider configured: proves the "no key" errors
// name a configuration field instead of failing on the wire.
registerTtsTool(offline.ctx, {})
registerVoicesTool(offline.ctx, {})
registerCheckTool(offline.ctx, {})

await mkdir(join(cwd, 'adir'), { recursive: true })
await writeFile(join(cwd, 'zero.wav'), Buffer.alloc(0))
await writeFile(join(cwd, 'text.wav'), Buffer.from('this is not a wav file at all, only text padding to pass the header length'))
await writeFile(join(cwd, 'trunc.wav'), encodeWav([new Float32Array(4410)], 44100).subarray(0, 20))
await writeFile(join(cwd, 'cut.wav'), encodeWav([new Float32Array(4410).fill(0.1)], 44100).subarray(0, 44 + 200))
await writeFile(join(cwd, 'empty.wav'), encodeWav([new Float32Array(0)], 44100))
await writeFile(join(cwd, 'silent.wav'), encodeWav([new Float32Array(16000)], 16000))
await mkdir(join(cwd, 'fixtures'), { recursive: true })
{
  const seeded = await invoke('audio_synth', { preset: 'impact', duration: 0.3, out: 'fixtures/ok.wav' })
  if (!seeded.ok) {
    console.log(`setup failed: audio_synth threw ${seeded.error?.message}`)
    process.exit(1)
  }
}

/* ------------------------------------------------ 1. tool registration -- */

section('1. registration and tool shape')
{
  const EXPECTED = [
    'audio_synth', 'audio_pattern', 'audio_mix', 'audio_probe', 'audio_tts', 'audio_voices',
    'audio_check', 'audio_convert', 'audio_loudness', 'audio_design', 'audio_lipsync',
    'audio_beats', 'audio_bind', 'audio_regress', 'audio_compose', 'audio_sing', 'audio_stretch',
    'audio_generate'
  ]
  const names = [...primary.tools.keys()].sort()
  const missing = EXPECTED.filter((name) => !primary.tools.has(name))
  const extra = names.filter((name) => !EXPECTED.includes(name))
  if (missing.length > 0 || extra.length > 0) bug('registration: tool set mismatch', `missing ${missing.join(',') || '-'} · unexpected ${extra.join(',') || '-'}`)
  else ok('registration', `${names.length} tools: ${names.join(', ')}`)

  const shapeProblems = []
  const shapeWarnings = []
  for (const [name, definition] of primary.tools) {
    if (typeof definition.execute !== 'function') shapeProblems.push(`${name}: no execute`)
    if (definition.parameters?.type !== 'object') shapeProblems.push(`${name}: parameters is not an object schema`)
    if (definition.parameters?.additionalProperties !== false) shapeProblems.push(`${name}: additionalProperties not false`)
    if (typeof definition.output?.render !== 'function') shapeProblems.push(`${name}: no output.render`)
    if (definition.isConcurrencySafe !== true) shapeProblems.push(`${name}: not marked concurrency safe`)
    if (typeof definition.presentCall !== 'function') shapeWarnings.push(name)
  }
  if (shapeProblems.length > 0) bug('tool shape: contract violations', shapeProblems.join(' · '))
  else ok('tool shape', 'every tool has execute, an object schema with additionalProperties:false, output.render and isConcurrencySafe')
  if (shapeWarnings.length > 0) warn('tool shape: no presentCall', `${shapeWarnings.join(', ')} registered without presentCall, so the host has no card title/payload for it; every other tool sets one`)
}

/* --------------------------------------------- 2. bad argument matrix -- */

section('2. bad arguments')
{
  // -- audio_synth --
  await expectError('audio_synth missing preset', 'audio_synth', {})
  await expectError('audio_synth unknown preset', 'audio_synth', { preset: 'nope' })
  await expectError('audio_synth empty preset', 'audio_synth', { preset: '' })
  await expectError('audio_synth numeric preset', 'audio_synth', { preset: 42 })

  // -- audio_pattern --
  await expectError('audio_pattern unknown preset', 'audio_pattern', { preset: 'nope' })

  // -- audio_mix --
  await expectError('audio_mix missing inputs', 'audio_mix', {})
  await expectError('audio_mix empty inputs', 'audio_mix', { inputs: [] })
  await expectError('audio_mix non-path input', 'audio_mix', { inputs: [42] })
  await expectError('audio_mix missing file', 'audio_mix', { inputs: ['missing.wav'] })
  await expectError('audio_mix directory input', 'audio_mix', { inputs: ['adir'] })
  await expectError('audio_mix huge offset', 'audio_mix', { inputs: ['fixtures/ok.wav'], offsets: [1e308] })
  await expectError('audio_mix huge duration', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: 1e308 })
  await expectError('audio_mix zero duration', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: 0 })
  await expectError('audio_mix negative duration', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: -5 })

  // -- audio_probe --
  await expectError('audio_probe missing path', 'audio_probe', {})
  await expectError('audio_probe empty path', 'audio_probe', { path: '' })
  await expectError('audio_probe numeric path', 'audio_probe', { path: 42 })
  await expectError('audio_probe missing file', 'audio_probe', { path: 'missing.wav' })
  await expectError('audio_probe directory input', 'audio_probe', { path: 'adir' })
  await expectError('audio_probe zero-byte file', 'audio_probe', { path: 'zero.wav' })
  await expectError('audio_probe text renamed .wav', 'audio_probe', { path: 'text.wav' })
  await expectError('audio_probe truncated header', 'audio_probe', { path: 'trunc.wav' })

  // -- audio_tts --
  await expectError('audio_tts missing text', 'audio_tts', {})
  await expectError('audio_tts empty text', 'audio_tts', { text: '' })
  await expectError('audio_tts whitespace text', 'audio_tts', { text: '   ' })
  await expectError('audio_tts 8001 chars', 'audio_tts', { text: 'x'.repeat(8001) }, { match: /8000/, maxMs: 1000 })
  await expectError('audio_tts speed below range', 'audio_tts', { text: 'hi', speed: 0.49 })
  await expectError('audio_tts speed above range', 'audio_tts', { text: 'hi', speed: 2.01 })
  await expectError('audio_tts pitch above range', 'audio_tts', { text: 'hi', pitch: 13 })
  const longText = '这是一句用来测试分块拼接的长旁白。'.repeat(50) // > 600 chars → > 1 chunk
  await expectError('audio_tts negative inter-chunk gap', 'audio_tts', { text: longText, gapSeconds: -1 })
  await expectError('audio_tts huge inter-chunk gap', 'audio_tts', { text: longText, gapSeconds: 1e308 })
  await expectError('audio_tts no provider key', 'audio_tts', { text: 'hi' }, { registry: offline, match: /API_KEY|apiKey/ })

  // -- audio_check --
  await expectError('audio_check no work at all', 'audio_check', {})
  await expectError('audio_check empty paths', 'audio_check', { paths: [] })
  await expectError('audio_check empty-cue work reports ok', 'audio_check', { cues: [] })
  await expectError('audio_check blank path report ok', 'audio_check', { paths: [''] })
  // The local self-check must never need a model: with no `config.check` a
  // question is *skipped* (info note), not an error, and the file still gets a
  // verdict plus the deterministic self-check block.
  {
    const outcome = await invoke('audio_check', { paths: ['fixtures/ok.wav'], question: '像什么？' }, offline)
    if (!outcome.ok) bug('audio_check question without a model threw', String(outcome.error?.message ?? outcome.error))
    else if (outcome.value.selfCheck === undefined || outcome.value.selfCheck === null) bug('audio_check question without a model has no self-check block', brief(outcome.value))
    else if (outcome.value.opinion !== null) bug('audio_check invented an opinion with no model configured', String(outcome.value.opinion))
    else if (outcome.value.verdict === 'fail') warn('audio_check fails a clean file when no model is configured', JSON.stringify(outcome.value.issues))
    else ok('audio_check question without a model: local self-check only')
  }

  // -- audio_convert --
  await expectError('audio_convert missing inputs', 'audio_convert', { op: 'convert' })
  await expectError('audio_convert missing op', 'audio_convert', { inputs: ['fixtures/ok.wav'] })
  await expectError('audio_convert empty inputs', 'audio_convert', { inputs: [], op: 'convert' })
  await expectError('audio_convert unknown op', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'bogus' })
  await expectError('audio_convert bad bitDepth', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', bitDepth: 12 })
  await expectError('audio_convert fractional bitDepth', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', bitDepth: 8.5 })
  await expectError('audio_convert bad channels', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', channels: 3 })
  await expectError('audio_convert huge sampleRate', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', sampleRate: 1e9 })
  await expectError('audio_convert tiny sampleRate', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', sampleRate: 1 })
  await expectError('audio_convert non-path input', 'audio_convert', { inputs: [42], op: 'convert' })
  await expectError('audio_convert empty path input', 'audio_convert', { inputs: [''], op: 'convert' })
  await expectError('audio_convert missing file', 'audio_convert', { inputs: ['missing.wav'], op: 'convert' })
  await expectError('audio_convert directory input', 'audio_convert', { inputs: ['adir'], op: 'convert' })
  await expectError('audio_convert trim empty span', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'trim', start: 0.2, end: 0.1 })
  await expectError('audio_convert trim huge start', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'trim', start: 1e308 })
  await expectError('audio_convert gain-scan peak above 0', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'gain-scan', peakDbfs: 5 })
  await expectError('audio_convert gain-scan peak below -60', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'gain-scan', peakDbfs: -61 })
  await expectError('audio_convert multi-input convert', 'audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'convert' })
  await expectError('audio_convert gain-scan file out with 2 inputs', 'audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'gain-scan', out: 'x.wav' })
  await expectError('audio_convert concat both joins', 'audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'concat', gapSeconds: 0.1, crossfadeSeconds: 0.1 })
  await expectError('audio_convert concat huge gap', 'audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'concat', gapSeconds: 1e308 })

  // -- audio_loudness --
  await expectError('audio_loudness no source', 'audio_loudness', {})
  await expectError('audio_loudness path and render', 'audio_loudness', { path: 'fixtures/ok.wav', render: { preset: 'impact' } })
  await expectError('audio_loudness missing file', 'audio_loudness', { path: 'missing.wav' })
  await expectError('audio_loudness unknown render preset', 'audio_loudness', { render: { preset: 'nope' } })
  await expectError('audio_loudness zero-byte file', 'audio_loudness', { path: 'zero.wav' })
  await expectError('audio_loudness directory input', 'audio_loudness', { path: 'adir' })
  await expectError('audio_loudness normalise silent file', 'audio_loudness', { path: 'silent.wav', targetLufs: -14, out: 'loud/silent.wav' })

  // -- audio_design --
  await expectError('audio_design no recipe or layers', 'audio_design', {})
  await expectError('audio_design empty layers', 'audio_design', { layers: [] })
  await expectError('audio_design unknown recipe', 'audio_design', { recipe: 'nope' })
  await expectError('audio_design unknown layer preset', 'audio_design', { layers: [{ preset: 'nope' }] })
  await expectError('audio_design layers wrong type', 'audio_design', { layers: 'nope' })

  // -- audio_lipsync / audio_beats --
  await expectError('audio_lipsync no source', 'audio_lipsync', {})
  await expectError('audio_lipsync missing file', 'audio_lipsync', { path: 'missing.wav' })
  await expectError('audio_lipsync unknown render preset', 'audio_lipsync', { render: { preset: 'nope' } })
  await expectError('audio_lipsync directory input', 'audio_lipsync', { path: 'adir' })
  await expectError('audio_beats no source', 'audio_beats', {})
  await expectError('audio_beats missing file', 'audio_beats', { path: 'missing.wav' })
  await expectError('audio_beats unknown render preset', 'audio_beats', { render: { preset: 'nope' } })

  // -- audio_bind --
  await expectError('audio_bind missing cues', 'audio_bind', {})
  await expectError('audio_bind empty cues', 'audio_bind', { cues: [] })
  await expectError('audio_bind cue without at', 'audio_bind', { cues: [{ path: 'fixtures/ok.wav' }] })
  await expectError('audio_bind cue without path', 'audio_bind', { cues: [{ at: 0 }] })
  await expectError('audio_bind cue negative at', 'audio_bind', { cues: [{ at: -1, path: 'fixtures/ok.wav' }] })
  await expectError('audio_bind cue missing file', 'audio_bind', { cues: [{ at: 0, path: 'missing.wav' }] })
  await expectError('audio_bind cue not a wav', 'audio_bind', { cues: [{ at: 0, path: 'text.wav' }] })
  await expectError('audio_bind duplicate cue names', 'audio_bind', { cues: [{ name: 'a', at: 0, path: 'fixtures/ok.wav' }, { name: 'a', at: 0.1, path: 'fixtures/ok.wav' }] })
  await expectError('audio_bind duration before last cue', 'audio_bind', { cues: [{ at: 2, path: 'fixtures/ok.wav' }], duration: 1 })
  await expectError('audio_bind huge cue at', 'audio_bind', { cues: [{ at: 1e308, path: 'fixtures/ok.wav' }] })

  // -- audio_regress --
  await expectError('audio_regress missing action', 'audio_regress', {})
  await expectError('audio_regress unknown action', 'audio_regress', { action: 'bogus' })
  await expectError('audio_regress snapshot without specs', 'audio_regress', { action: 'snapshot' })
  await expectError('audio_regress snapshot empty specs', 'audio_regress', { action: 'snapshot', specs: [] })
  await expectError('audio_regress compare without baseline', 'audio_regress', { action: 'compare', specs: [{ name: 'a', preset: 'impact' }], baselinePath: 'missing-baseline.json' })
  await expectError('audio_regress invalid spec preset', 'audio_regress', { action: 'snapshot', specs: [{ name: 'a', preset: 'nope' }] })
  await expectError('audio_regress duplicate spec names', 'audio_regress', { action: 'snapshot', specs: [{ name: 'a', preset: 'impact' }, { name: 'a', preset: 'tick' }] })
  await expectError('audio_regress unusable baselinePath', 'audio_regress', { action: 'snapshot', specs: [{ name: 'a', preset: 'impact' }], baselinePath: '' })

  // -- audio_compose --
  await expectError('audio_compose missing genre', 'audio_compose', {})
  await expectError('audio_compose unknown genre', 'audio_compose', { genre: 'nope' })
  await expectError('audio_compose unknown key', 'audio_compose', { genre: 'lofi', key: 'H' })
  await expectError('audio_compose unknown mode', 'audio_compose', { genre: 'lofi', mode: 'mixolydiann' })
  await expectError('audio_compose sections wrong type', 'audio_compose', { genre: 'lofi', sections: 'nope' })

  // -- audio_sing --
  await expectError('audio_sing 257 notes', 'audio_sing', { notes: Array.from({ length: 257 }, () => ({ midi: 60, dur: 1 })) }, { match: /256/, maxMs: 1000 })
  await expectError('audio_sing over 120 s', 'audio_sing', { notes: [{ midi: 60, dur: 32, beat: 3000 }], bpm: 20 }, { match: /120/, maxMs: 1000 })

  // -- audio_stretch --
  await expectError('audio_stretch no source', 'audio_stretch', {})
  await expectError('audio_stretch no mode', 'audio_stretch', { render: { preset: 'impact' } })
  await expectError('audio_stretch factor out of range', 'audio_stretch', { render: { preset: 'impact' }, factor: 0.1 })
  await expectError('audio_stretch targetSeconds zero', 'audio_stretch', { render: { preset: 'impact' }, targetSeconds: 0 })
  await expectError('audio_stretch semitones out of range', 'audio_stretch', { render: { preset: 'impact' }, semitones: STRETCH_LIMITS.maxSemitones + 1 })
  await expectError('audio_stretch missing file', 'audio_stretch', { path: 'missing.wav', factor: 1.1 })
  await expectError('audio_stretch path and render', 'audio_stretch', { path: 'fixtures/ok.wav', render: { preset: 'impact' }, factor: 1.1 })
  await expectError('audio_stretch target too small', 'audio_stretch', { render: { preset: 'impact' }, targetSeconds: 0.00001 })
}

// NaN and wrong-type numbers cannot arrive through JSON (NaN) or the host's
// schema (strings where numbers are declared), but `execute` is public enough
// that leaving them unchecked writes a corrupt 44-byte "wav" with a 0 s
// duration. One aggregate BUG line keeps the reproductions together.
section('2a. NaN and wrong-type numeric arguments')
{
  const cases = [
    ['audio_synth duration NaN', 'audio_synth', { preset: 'impact', duration: NaN }],
    ['audio_synth duration "abc"', 'audio_synth', { preset: 'impact', duration: 'abc' }],
    ['audio_synth sampleRate NaN', 'audio_synth', { preset: 'impact', sampleRate: NaN }],
    ['audio_synth sampleRate "abc"', 'audio_synth', { preset: 'impact', sampleRate: 'abc' }],
    ['audio_pattern to NaN', 'audio_pattern', { preset: 'tick', to: NaN }],
    ['audio_pattern to "abc"', 'audio_pattern', { preset: 'tick', to: 'abc' }],
    ['audio_mix gains [NaN]', 'audio_mix', { inputs: ['fixtures/ok.wav'], gains: [NaN] }],
    ['audio_mix offsets [NaN]', 'audio_mix', { inputs: ['fixtures/ok.wav'], offsets: [NaN] }]
  ]
  const accepted = []
  for (const [label, name, args] of cases) {
    const outcome = await invoke(name, args)
    if (!outcome.ok) {
      if (outcome.error.constructor !== Error) bug(`${label}: crashed while rejecting`, `${name} ${showArgs(args)} -> ${outcome.error.message}`)
      else ok(label, `rejected in ${outcome.ms}ms`)
      continue
    }
    accepted.push(`${label} -> ${brief(outcome.value)}`)
  }
  if (accepted.length > 0) bug('NaN/wrong-type numbers are not rejected and produce corrupt output', accepted.join(' · '))
  else ok('NaN/wrong-type numbers are rejected before rendering')
}

// Shapes the host schema would reject before `execute` ever runs. Reported as
// WARN: the model cannot reach them, but a direct caller can.
section('2b. schema-guarded shapes (WARN only)')
{
  const outcomes = []
  const tune = async (label, name, args) => {
    const outcome = await invoke(name, args)
    outcomes.push({ label, name, args, outcome })
  }
  await tune('audio_pattern missing required preset', 'audio_pattern', {})
  await tune('audio_check non-string path', 'audio_check', { paths: [42] })
  await tune('audio_check cue without src', 'audio_check', { cues: [{ at: 0 }] })
  await tune('audio_check null cue', 'audio_check', { cues: [null] })
  const accepted = []
  const crashes = []
  for (const { label, name, args, outcome } of outcomes) {
    if (!outcome.ok) {
      if (outcome.error.constructor !== Error) crashes.push(`${label} -> ${outcome.error.constructor.name}: ${outcome.error.message}`)
      continue
    }
    accepted.push(`${label} -> ${brief(outcome.value)}`)
  }
  if (accepted.length > 0) warn('schema-guarded inputs are accepted by execute', `${accepted.join(' · ')} — the host schema blocks these, but execute should still name the invalid field`)
  if (crashes.length > 0) warn('schema-guarded inputs crash execute', `${crashes.join(' · ')} — reachable only when schema validation is bypassed`)
  if (accepted.length === 0 && crashes.length === 0) ok('schema-guarded shapes are rejected cleanly')
}

// Tolerated coercions and documented clamps: these must succeed, and the
// boundary they land on is part of the reproduction.
section('2c. tolerated coercions and documented clamps')
{
  const record = (label, outcome, test) => {
    if (!outcome.ok) {
      bug(`${label}: rejected a value the tool documents as clamped/coerced`, String(outcome.error?.message))
      return
    }
    const problem = test(outcome.value)
    if (problem !== null) bug(`${label}: ${problem}`, brief(outcome.value))
    else ok(`${label}`, brief(outcome.value))
  }
  record('audio_synth duration 1e999 clamps to the 30 s cap', await invoke('audio_synth', { preset: 'riser', duration: 1e999, sampleRate: 8000, out: 'clamp/max.wav' }), (v) => (Math.abs(v.durationSeconds - 30) < 0.05 ? null : `duration ${v.durationSeconds} != 30`))
  record('audio_synth duration -5 clamps to the 0.008 s floor', await invoke('audio_synth', { preset: 'impact', duration: -5, out: 'clamp/min.wav' }), (v) => (Math.abs(v.durationSeconds - 0.008) < 0.001 ? null : `duration ${v.durationSeconds}`))
  record('audio_synth sampleRate 0 clamps to 8000', await invoke('audio_synth', { preset: 'tick', sampleRate: 0, out: 'clamp/rate0.wav' }), (v) => (v.sampleRate === 8000 ? null : `rate ${v.sampleRate}`))
  record('audio_synth sampleRate 1e308 clamps to 96000', await invoke('audio_synth', { preset: 'tick', sampleRate: 1e308, out: 'clamp/ratebig.wav' }), (v) => (v.sampleRate === 96000 ? null : `rate ${v.sampleRate}`))
  record('audio_synth string number duration is coerced', await invoke('audio_synth', { preset: 'impact', duration: '0.2', sampleRate: '22050', out: 'clamp/str.wav' }), (v) => (Math.abs(v.durationSeconds - 0.2) < 0.01 && v.sampleRate === 22050 ? null : `duration ${v.durationSeconds} rate ${v.sampleRate}`))
  record('audio_synth out-of-range params clamp', await invoke('audio_synth', { preset: 'impact', params: { weight: 5, pitch: -3 }, out: 'clamp/params.wav' }), (v) => (nonFinitePath(v) === null ? null : nonFinitePath(v)))
  record('audio_pattern count -3 falls back to the spacing', await invoke('audio_pattern', { preset: 'tick', to: 1, count: -3, out: 'clamp/count.wav' }), (v) => (v.events >= 1 ? null : `events ${v.events}`))
  record('audio_pattern to < from clamps to a 0.02 s span', await invoke('audio_pattern', { preset: 'tick', from: 2, to: 1, out: 'clamp/span.wav' }), (v) => (v.durationSeconds > 0 ? null : `duration ${v.durationSeconds}`))
  record('audio_convert bitDepth "8" is coerced', await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', bitDepth: '8', out: 'clamp/b8.wav' }), (v) => (v.bitDepth === 8 ? null : `bitDepth ${v.bitDepth}`))
  record('audio_convert trim start -5 clamps to 0', await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'trim', start: -5, end: 999999, out: 'clamp/trimneg.wav' }), (v) => (Math.abs(v.durationSeconds - 0.3) < 0.01 ? null : `duration ${v.durationSeconds}`))
  record('audio_convert concat negative gap clamps to 0', await invoke('audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'concat', gapSeconds: -1, out: 'clamp/neg-gap.wav' }), (v) => (Math.abs(v.durationSeconds - 0.6) < 0.01 ? null : `duration ${v.durationSeconds}`))
  record('audio_loudness ceilingDbtp 5 clamps to 0', await invoke('audio_loudness', { path: 'fixtures/ok.wav', targetLufs: -14, ceilingDbtp: 5, out: 'clamp/loud.wav' }), (v) => (v.target?.ceilingDbtp === 0 ? null : `ceiling ${v.target?.ceilingDbtp}`))
  record('audio_tts speed "1.5" is coerced', await invoke('audio_tts', { text: 'hi', speed: '1.5', out: 'clamp/tts.wav' }), (v) => (v.effective?.speed === 1.5 ? null : `speed ${v.effective?.speed}`))
  record('audio_tts text number is coerced', await invoke('audio_tts', { text: 42, out: 'clamp/tts-num.wav' }), (v) => (v.chunks >= 1 ? null : `chunks ${v.chunks}`))
  record('audio_lipsync fps 1e308 clamps to 120', await invoke('audio_lipsync', { path: 'fixtures/ok.wav', fps: 1e308 }), (v) => (v.fps === 120 ? null : `fps ${v.fps}`))
  record('audio_beats beatsPerBar garbage falls back to 4', await invoke('audio_beats', { path: 'fixtures/ok.wav', beatsPerBar: 'abc' }), (v) => (v.beatsPerBar === 4 ? null : `beatsPerBar ${v.beatsPerBar}`))
  record('audio_sing empty request still sings (documented)', await invoke('audio_sing', { out: 'clamp/sing-empty.wav' }), (v) => (v.notes >= 1 ? null : `notes ${v.notes}`))
  record('audio_sing invalid melody still sings (documented)', await invoke('audio_sing', { melody: 'H9:x', out: 'clamp/sing-bad-melody.wav' }), (v) => (v.notes >= 1 ? null : `notes ${v.notes}`))
  record('audio_design unknown intensity is ignored', await invoke('audio_design', { recipe: 'ui-success', intensity: 'loud', out: 'clamp/design-intensity.wav' }), (v) => (v.intensity === 1 ? null : `intensity ${v.intensity}`))
  record('audio_synth extra unknown property is ignored', await invoke('audio_synth', { preset: 'tick', bogus: true, out: 'clamp/extra-synth.wav' }), (v) => (v.durationSeconds > 0 ? null : `duration ${v.durationSeconds}`))
  record('audio_convert extra unknown property is ignored', await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', bogus: 1, out: 'clamp/extra-convert.wav' }), (v) => (v.durationSeconds > 0 ? null : `duration ${v.durationSeconds}`))
  record('audio_compose bpm 1e6 clamps to 220', await invoke('audio_compose', { genre: 'lofi', bars: 1, bpm: 1e6, out: 'clamp/compose-bpm.wav' }), (v) => (v.bpm === 220 ? null : `bpm ${v.bpm}`))
  record('audio_compose bars 0 clamps to 1', await invoke('audio_compose', { genre: 'lofi', bars: 0, out: 'clamp/compose-bars.wav' }), (v) => (v.bars === 1 ? null : `bars ${v.bars}`))
  record('audio_lipsync fps 0 clamps to 12', await invoke('audio_lipsync', { path: 'fixtures/ok.wav', fps: 0 }), (v) => (v.fps === 12 ? null : `fps ${v.fps}`))
  record('audio_design duration 0 becomes a short design', await invoke('audio_design', { recipe: 'ui-toggle', duration: 0, out: 'clamp/design-zero.wav' }), (v) => (v.durationSeconds > 0 ? null : `duration ${v.durationSeconds}`))

  // Size-cap arguments of 0 / negative silently fall back to the default cap.
  const capIgnores = []
  {
    const convert = await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', inline: true, maxInlineBytes: -5, out: 'clamp/cap-negative.wav' })
    if (convert.ok && convert.value.inline !== null) capIgnores.push('audio_convert {maxInlineBytes:-5} inlines anyway (negative cap ignored)')
    const bind = await invoke('audio_bind', { cues: [{ at: 0, path: 'fixtures/ok.wav' }], inline: true, maxBytes: 0, out: 'clamp/cap-zero' })
    if (bind.ok && bind.value.ok === true && bind.value.refused !== true) capIgnores.push('audio_bind {maxBytes:0} inlines under the 2 MB default (zero cap ignored)')
  }
  if (capIgnores.length > 0) warn('size-cap arguments of 0 / negative are ignored, not enforced', capIgnores.join(' · '))
  else ok('size-cap arguments of 0 / negative are enforced')

  // Infinity numeric arguments that are silently dropped rather than reported.
  const silentInfinities = []
  {
    const probe = await invoke('audio_probe', { path: 'fixtures/ok.wav', expectDuration: 1e308 })
    if (probe.ok && !(probe.value.notes ?? []).some((note) => /duration/.test(note))) silentInfinities.push('audio_probe {expectDuration:1e308} ignored')
    const convert = await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'gain', gainDb: 1e308, out: 'clamp/gain-inf.wav' })
    if (convert.ok) silentInfinities.push(`audio_convert {gainDb:1e308} writes a near-silent file (peak ${convert.value.metrics.peakDbfs} dBFS): the encoder zeroes the non-finite gain instead of rejecting it`)
    const bind = await invoke('audio_bind', { cues: [{ at: 0, path: 'fixtures/ok.wav' }], duration: 1e308, out: 'clamp/dur-inf' })
    if (bind.ok && bind.value.ok === true) silentInfinities.push('audio_bind {duration:1e308} replaced by the computed timeline')
    const loudness = await invoke('audio_loudness', { path: 'fixtures/ok.wav', targetLufs: 1e308, out: 'clamp/lufs-inf.wav' })
    if (loudness.ok && loudness.value.written === null) silentInfinities.push('audio_loudness {targetLufs:1e308} ignored (no plan, no file)')
  }
  if (silentInfinities.length > 0) warn('Infinity numeric arguments are silently ignored instead of rejected', silentInfinities.join(' · '))
  else ok('Infinity numeric arguments are rejected')
}

// Silent enum fallbacks and honest-but-ugly reporting, grouped as WARN.
{
  const fallbacks = []
  const pattern = await invoke('audio_pattern', { preset: 'tick', kind: 'nope', curve: 'nope', to: 0.5, out: 'warn/pattern-enum.wav' })
  if (pattern.ok) fallbacks.push("audio_pattern {kind:'nope',curve:'nope'} → train/linear")
  const tts = await invoke('audio_tts', { text: 'hi', subtitleType: 'wordz', out: 'warn/tts-enum.wav' })
  if (tts.ok && tts.value.effective?.subtitle === 'wordz') fallbacks.push("audio_tts {subtitleType:'wordz'} forwarded and echoed as 'wordz'")
  const lipsync = await invoke('audio_lipsync', { path: 'fixtures/ok.wav', format: 'nope' })
  if (lipsync.ok && lipsync.value.format === 'json') fallbacks.push("audio_lipsync {format:'nope'} → json")
  const sing = await invoke('audio_sing', { melody: 'C4:1', voice: 'nope', out: 'warn/sing-voice.wav' })
  if (sing.ok && sing.value.voice === 'nope') fallbacks.push("audio_sing {voice:'nope'} renders alto but reports voice:'nope'")
  if (fallbacks.length > 0) warn('unknown enum ids are accepted silently (schema normally blocks them)', fallbacks.join(' · '))
  else ok('unknown enum ids are rejected or reported honestly')
}

/* ------------------------------- 2d. hard guards (regression pins) -- */

// Every guard added by the hardening pass must reject with a message that names
// the parameter it refused, and it must do so before the expensive work.
section('2d. hard guards name their parameter')
{
  const longScript = '这是一句用来测试分块拼接的长旁白。'.repeat(50)
  await expectError('mix offset names offsets', 'audio_mix', { inputs: ['fixtures/ok.wav'], offsets: [1e308] }, { match: /offsets/, maxMs: 1000 })
  await expectError('mix duration names durationSeconds', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: 1e308 }, { match: /durationSeconds/, maxMs: 1000 })
  await expectError('mix zero duration is rejected', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: 0 }, { match: /durationSeconds/ })
  await expectError('mix negative duration is rejected', 'audio_mix', { inputs: ['fixtures/ok.wav'], durationSeconds: -5 }, { match: /durationSeconds/ })
  await expectError('tts gap below range names gapSeconds', 'audio_tts', { text: longScript, gapSeconds: -1 }, { match: /gapSeconds/, maxMs: 1000 })
  await expectError('tts huge gap names gapSeconds', 'audio_tts', { text: longScript, gapSeconds: 1e308 }, { match: /gapSeconds/, maxMs: 1000 })
  await expectError('convert huge gap names gapSeconds', 'audio_convert', { inputs: ['fixtures/ok.wav', 'fixtures/ok.wav'], op: 'concat', gapSeconds: 1e308 }, { match: /gapSeconds/, maxMs: 1000 })
  await expectError('convert huge gain names gainDb', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'gain', gainDb: 1e308 }, { match: /gainDb/, maxMs: 1000 })
  await expectError('convert zero inline budget names maxInlineBytes', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', inline: true, maxInlineBytes: 0 }, { match: /maxInlineBytes/, maxMs: 1000 })
  await expectError('convert unknown curve is rejected', 'audio_convert', { inputs: ['fixtures/ok.wav'], op: 'fade', curve: 'nope' }, { match: /curve/, maxMs: 1000 })
  await expectError('bind zero inline budget names maxBytes', 'audio_bind', { cues: [{ at: 0, path: 'fixtures/ok.wav' }], inline: true, maxBytes: 0 }, { match: /maxBytes/, maxMs: 1000 })
  await expectError('check blank path names paths', 'audio_check', { paths: [''] }, { match: /paths/, maxMs: 1000 })
  await expectError('check empty cue list is rejected', 'audio_check', { cues: [] }, { match: /paths|cues/, maxMs: 1000 })
  await expectError('check cue without src is named', 'audio_check', { cues: [{ at: 0 }] }, { match: /cues\[0\]|src/, maxMs: 1000 })
  await expectError('check null cue is a clean error', 'audio_check', { cues: [null] }, { match: /cues\[0\]/, maxMs: 1000 })
  await expectError('regress missing action names action', 'audio_regress', {}, { match: /action/, maxMs: 1000 })
  await expectError('pattern span over the cap names 180', 'audio_pattern', { preset: 'tick', to: 600, every: 10 }, { match: /180/, maxMs: 1000 })
  await expectError('pattern event count over the cap names 20000', 'audio_pattern', { preset: 'tick', to: 1, count: 1e9 }, { match: /20000/, maxMs: 1000 })

  // NaN still has to be rejected, but the message echoes it, so a `match` check
  // would trip the "mentions NaN" quality flag — assert the rejection directly.
  const nanCases = [
    ['audio_synth duration NaN', 'audio_synth', { preset: 'impact', duration: NaN }],
    ['audio_synth duration "abc"', 'audio_synth', { preset: 'impact', duration: 'abc' }],
    ['audio_synth sampleRate NaN', 'audio_synth', { preset: 'impact', sampleRate: NaN }],
    ['audio_synth sampleRate "abc"', 'audio_synth', { preset: 'impact', sampleRate: 'abc' }],
    ['audio_pattern to NaN', 'audio_pattern', { preset: 'tick', to: NaN }],
    ['audio_pattern to "abc"', 'audio_pattern', { preset: 'tick', to: 'abc' }],
    ['audio_mix gains [NaN]', 'audio_mix', { inputs: ['fixtures/ok.wav'], gains: [NaN] }],
    ['audio_mix offsets [NaN]', 'audio_mix', { inputs: ['fixtures/ok.wav'], offsets: [NaN] }]
  ]
  const nanProblems = []
  for (const [label, name, args] of nanCases) {
    const outcome = await invoke(name, args)
    if (outcome.ok) nanProblems.push(`${label} -> ${brief(outcome.value)}`)
    else if (outcome.error.constructor !== Error) nanProblems.push(`${label} -> ${outcome.error.constructor.name}: ${outcome.error.message}`)
  }
  if (nanProblems.length > 0) bug('NaN arguments are not rejected cleanly', nanProblems.join(' · '))
  else ok('NaN arguments are rejected before rendering', `${nanCases.length} case(s)`)

  // Decode/read failures must name the file they failed on (they used to report
  // a bare `decodeWav: ...` or `EISDIR: ...` with no path).
  const unnamed = []
  for (const file of ['zero.wav', 'text.wav', 'adir']) {
    const outcome = await invoke('audio_probe', { path: file })
    if (outcome.ok) unnamed.push(`${file} was accepted`)
    else if (!String(outcome.error.message).includes(file)) unnamed.push(`${file} -> "${outcome.error.message}"`)
  }
  if (unnamed.length > 0) bug('decode/read errors do not name the file', unnamed.join(' · '))
  else ok('decode/read errors name the file', 'zero.wav, text.wav, adir')

  // An unknown voice is a schema escape hatch, not a crash: report what sang.
  {
    const outcome = await invoke('audio_sing', { melody: 'C4:1', voice: 'nope', out: 'warn/sing-voice.wav' })
    if (!outcome.ok) bug('audio_sing unknown voice threw', String(outcome.error?.message))
    else if (outcome.value.voice !== 'alto') bug('audio_sing unknown voice reports an id that did not sing', `voice=${outcome.value.voice}`)
    else if (!(outcome.value.warnings ?? []).some((line) => /unknown voice/.test(line))) bug('audio_sing unknown voice does not say it fell back', JSON.stringify(outcome.value.warnings))
    else ok('audio_sing reports the voice that actually sang', `voice ${outcome.value.voice} · ${(outcome.value.warnings ?? []).find((line) => /unknown voice/.test(line))}`)
  }
}

/* ------------------------------------------ 3. filesystem edge cases -- */

section('3. filesystem edges')
{
  // Missing input: the fs error names the file.
  {
    const outcome = await invoke('audio_probe', { path: 'missing.wav' })
    if (outcome.ok) bug('missing input was accepted', brief(outcome.value))
    else if (!String(outcome.error.message).includes('missing.wav')) warn('ENOENT message does not name the file', String(outcome.error.message))
    else ok('missing input errors and names the file')
  }
  // Directory as input: rejected, but the EISDIR message drops the path.
  {
    const outcome = await invoke('audio_probe', { path: 'adir' })
    if (outcome.ok) bug('directory input was accepted', brief(outcome.value))
    else if (!String(outcome.error.message).includes('adir')) warn('directory input error does not name the path', `audio_probe {path:'adir'} -> "${outcome.error.message}"`)
    else ok('directory input errors and names the path')
  }
  // 0-byte and renamed-text inputs: rejected, but decodeWav's message drops the file.
  {
    const zero = await invoke('audio_probe', { path: 'zero.wav' })
    const text = await invoke('audio_probe', { path: 'text.wav' })
    if (zero.ok || text.ok) bug('0-byte/text inputs were accepted', `${brief(zero.value ?? {})} ${brief(text.value ?? {})}`)
    else if (!String(zero.error.message).includes('zero.wav') && !String(text.error.message).includes('text.wav')) {
      warn('decode errors do not name the file', `audio_probe {path:'zero.wav'} -> "${zero.error.message}" · audio_probe {path:'text.wav'} -> "${text.error.message}"`)
    } else ok('0-byte and text inputs error and name the file')
  }
  // Truncated header: rejected.
  {
    const outcome = await invoke('audio_probe', { path: 'trunc.wav' })
    if (outcome.ok) bug('truncated wav header was accepted', brief(outcome.value))
    else ok('truncated wav header is rejected', `"${outcome.error.message}"`)
  }
  // Truncated body: a header that claims more frames than the file holds is
  // decoded to the frames that exist, honestly (no crash, no invented duration).
  {
    const outcome = await invoke('audio_probe', { path: 'cut.wav' })
    if (!outcome.ok) bug('truncated data body threw', String(outcome.error.message))
    else {
      const duration = outcome.value.metrics.durationSeconds
      if (!(duration > 0) || duration > 0.01) bug('truncated data body reported a wrong duration', `cut.wav -> ${duration}s (expected 100 frames = 0.002s)`)
      else ok('truncated data body decodes the surviving frames', `${duration}s from a header claiming 0.1 s`)
    }
  }
  // Valid wav with 0 samples: measure() must stay finite. Checked once here and
  // once more as a root-cause block below to avoid double-reporting.
  {
    const outcome = await invoke('audio_probe', { path: 'empty.wav' })
    if (!outcome.ok) bug('valid 0-sample wav threw', String(outcome.error.message))
    else {
      const bad = nonFinitePath(outcome.value.metrics)
      if (bad !== null) console.log(`     (0-sample NaN root cause confirmed via audio_probe: ${bad})`)
      else ok('valid 0-sample wav measures clean', brief(outcome.value))
    }
  }
  // Nested output directory is created.
  {
    const outcome = await invoke('audio_synth', { preset: 'tick', out: 'deep/nested/dir/x.wav' })
    if (!outcome.ok) bug('nested output directory was not created', String(outcome.error.message))
    else if (!await exists(join(cwd, 'deep', 'nested', 'dir', 'x.wav'))) bug('nested output path missing after a successful call', brief(outcome.value))
    else ok('output in a non-existent nested directory is created', brief(outcome.value))
  }
  // Output path that is an existing directory: errors (safe) but the message
  // leaks the temp file name instead of naming `out`.
  {
    const outcome = await invoke('audio_synth', { preset: 'tick', out: 'adir' })
    if (outcome.ok) bug('directory output path was accepted', brief(outcome.value))
    else if (/\.tmp-\d+/.test(String(outcome.error.message))) warn('directory output error leaks the temp file name', `audio_synth {out:'adir'} -> "${outcome.error.message}"`)
    else ok('directory output path is rejected', `"${outcome.error.message}"`)
  }
  // Relative path that escapes the working directory: resolved against cwd, as
  // documented (not a crash, not silently redirected into cwd).
  {
    const name = `hardening-escape-${process.pid}.wav`
    const expected = resolve(cwd, '..', name)
    const outcome = await invoke('audio_synth', { preset: 'tick', out: `../${name}` })
    if (!outcome.ok) bug('relative ../ output path threw', String(outcome.error.message))
    else if (outcome.value.path !== expected) bug('../ output path is not resolved against cwd', `expected ${expected} got ${outcome.value.path}`)
    else if (!await exists(expected)) bug('../ output path was not written where the path resolved', expected)
    else ok('relative ../ output resolves against cwd (documented)', `wrote ${expected}`)
    await rm(expected, { force: true })
  }
}

/* ------------------------------ 4. number hygiene and determinism -- */

section('4. number hygiene and determinism')
{
  const okPath = 'fixtures/ok.wav'

  await checkRender('synth min duration 0.008 s @ 8000 Hz', 'audio_synth', { preset: 'tick', duration: 0.008, sampleRate: 8000, out: 'hygiene/synth-min.wav' })
  await checkRender('synth 1e999 duration clamps to 30 s @ 8000 Hz', 'audio_synth', { preset: 'riser', duration: 1e999, sampleRate: 8000, out: 'hygiene/synth-max.wav' })
  await checkRender('synth 96000 Hz', 'audio_synth', { preset: 'chime', duration: 0.2, sampleRate: 96000, out: 'hygiene/synth-96k.wav' })
  await checkRender('synth params at 0 and pitch at 0.5', 'audio_synth', { preset: 'impact', params: { weight: 0, pitch: 0.5 }, seed: -7, duration: 0.3, out: 'hygiene/synth-low.wav' })
  await checkRender('synth params at 1 with a large unsigned seed', 'audio_synth', { preset: 'impact', params: { weight: 1, pitch: 2 }, seed: 2147483647, duration: 0.3, out: 'hygiene/synth-high.wav' })
  await checkRender('synth loop at the 0.008 s floor', 'audio_synth', { preset: 'tick', duration: 0.008, loop: true, out: 'hygiene/synth-loop.wav' })

  await checkRender('pattern at the 0.01 s spacing floor', 'audio_pattern', { preset: 'tick', to: 0.5, every: 0.01, out: 'hygiene/pattern-dense.wav' })
  await checkRender('pattern scatter at jitter 1 with accents and a pitch glide', 'audio_pattern', { preset: 'scrap', kind: 'scatter', from: 0, to: 1, count: 6, jitter: 1, accentEvery: 4, pitchFrom: 0, pitchTo: 1, curve: 'ease', out: 'hygiene/pattern-scatter.wav' })
  await checkRender('pattern riser branch', 'audio_pattern', { preset: 'tick', kind: 'riser', from: 0, to: 1, out: 'hygiene/pattern-riser.wav' })

  await checkRender('mix gains at -60 dB with fades and a peak target', 'audio_mix', { inputs: [okPath], offsets: [0], gains: [-60], fadeInSeconds: 0.05, fadeOutSeconds: 0.05, peakDbfs: -6, limiter: true, out: 'hygiene/mix-fade.wav' })
  await checkRender('mix two inputs at 8000 Hz without the limiter', 'audio_mix', { inputs: [okPath, okPath], offsets: [0, 0.2], gains: [0, -6], sampleRate: 8000, limiter: false, peakDbfs: -1, out: 'hygiene/mix-8k.wav' })
  await checkRender('mix pads to a longer duration', 'audio_mix', { inputs: [okPath], durationSeconds: 0.5, out: 'hygiene/mix-pad.wav' })

  await checkRender('design at intensity 0 with a variant', 'audio_design', { recipe: 'door-slam-metal', seed: 0, variant: 3, intensity: 0, out: 'hygiene/design-a.wav' })
  await checkRender('design layer stack at every extreme', 'audio_design', { layers: [{ preset: 'impact', offsetMs: 50, gainDb: -3, duration: 0.2, pitchScale: 4, detuneCents: 1200, filter: { mode: 'hp', cutoffHz: 8000, q: 10 } }], seed: 1, out: 'hygiene/design-b.wav' })
  await checkRender('design loop recipe with a duration override', 'audio_design', { recipe: 'sci-fi-hum-loop', seed: 4, duration: 0.5, out: 'hygiene/design-loop.wav' })

  await checkRender('compose at 220 bpm and 22050 Hz', 'audio_compose', { genre: 'lofi', bars: 2, bpm: 220, seed: 0, intensity: 1, sampleRate: 22050, out: 'hygiene/compose-a.wav' })
  await checkRender('compose loop, 40 bpm, non-default key and mode', 'audio_compose', { genre: 'ui-menu', bars: 1, bpm: 40, loop: true, key: 'F#', mode: 'lydian', out: 'hygiene/compose-b.wav' })

  await checkRender('convert to 8-bit stereo at width 0', 'audio_convert', { inputs: [{ preset: 'impact', duration: 0.3 }], op: 'convert', bitDepth: 8, channels: 2, pan: -1, width: 0, out: 'hygiene/convert-8.wav' })
  await checkRender('convert to 32-bit float stereo at 96000 Hz', 'audio_convert', { inputs: [{ preset: 'impact', duration: 0.3 }], op: 'convert', bitDepth: 32, channels: 2, sampleRate: 96000, out: 'hygiene/convert-32.wav' })
  await checkRender('convert 24-bit with zero-crossing trim and fades', 'audio_convert', { inputs: [okPath], op: 'trim', start: 0.05, end: 0.2, snapToZeroCrossing: true, fadeInSeconds: 0.01, fadeOutSeconds: 0.01, bitDepth: 24, out: 'hygiene/convert-trim.wav' })
  await checkRender('convert gain at -60 dB', 'audio_convert', { inputs: [okPath], op: 'gain', gainDb: -60, out: 'hygiene/convert-gain.wav' })
  await checkRender('convert equal-power fade', 'audio_convert', { inputs: [okPath], op: 'fade', fadeInSeconds: 0.05, fadeOutSeconds: 0.05, curve: 'equalPower', out: 'hygiene/convert-fade.wav' })
  await checkRender('convert reverse', 'audio_convert', { inputs: [okPath], op: 'reverse', out: 'hygiene/convert-rev.wav' })
  await checkRender('convert concat with a gap', 'audio_convert', { inputs: [okPath, okPath], op: 'concat', gapSeconds: 0.05, out: 'hygiene/convert-concat.wav' })
  await checkRender('convert concat with a crossfade', 'audio_convert', { inputs: [okPath, okPath], op: 'concat', crossfadeSeconds: 0.05, out: 'hygiene/convert-cross.wav' })
  await checkRender('convert gain-scan of two takes', 'audio_convert', { inputs: [okPath, okPath], op: 'gain-scan', peakDbfs: -3, out: 'hygiene/scan' })

  await checkRender('stretch at the 0.25 factor floor', 'audio_stretch', { render: { preset: 'impact' }, factor: 0.25, out: 'hygiene/stretch-min.wav' })
  await checkRender('stretch at the 4x factor ceiling', 'audio_stretch', { render: { preset: 'impact' }, factor: 4, out: 'hygiene/stretch-max.wav' })
  await checkRender('stretch +12 semitones', 'audio_stretch', { render: { preset: 'impact' }, semitones: 12, out: 'hygiene/stretch-up.wav' })
  await checkRender('stretch -12 semitones', 'audio_stretch', { render: { preset: 'impact' }, semitones: -12, out: 'hygiene/stretch-down.wav' })
  await checkRender(`stretch +${STRETCH_LIMITS.maxSemitones} semitones (limit)`, 'audio_stretch', { render: { preset: 'impact' }, semitones: STRETCH_LIMITS.maxSemitones, out: 'hygiene/stretch-limit-up.wav' })
  await checkRender('stretch fit to exactly 0.5 s', 'audio_stretch', { path: okPath, targetSeconds: 0.5, out: 'hygiene/stretch-fit.wav' })

  await checkRender('sing MIDI 0 and 127 at 20 bpm', 'audio_sing', { notes: [{ midi: 0, dur: 0.0625 }, { midi: 127, dur: 0.0625 }], bpm: 20, out: 'hygiene/sing-edges.wav' })
  await checkRender('sing 256 notes with a choir harmony', 'audio_sing', { notes: Array.from({ length: 256 }, (_, index) => ({ midi: 60 + (index % 12), dur: 0.0625 })), bpm: 300, voice: 'choir', harmony: 'fifth', vibrato: 0, breath: 1, seed: 2, out: 'hygiene/sing-256.wav' })

  await checkRender('tts speed 0.5 and pitch -12', 'audio_tts', { text: 'hello world', speed: 0.5, pitch: -12, subtitle: false, out: 'hygiene/tts-min.wav' })
  await checkRender('tts speed 2 and pitch +12 with SRT', 'audio_tts', { text: 'hello world', speed: 2, pitch: 12, sampleRate: 48000, srt: true, out: 'hygiene/tts-max.wav' })

  await checkRender('loudness of an existing file', 'audio_loudness', { path: okPath }, { deterministic: false })
  await checkRender('loudness target -23 LUFS with a -20 dBTP ceiling', 'audio_loudness', { path: okPath, targetLufs: -23, ceilingDbtp: -20, out: 'hygiene/loud.wav' })
  await checkRender('loudness plan from an inline render', 'audio_loudness', { render: { preset: 'impact', duration: 0.5 }, targetLufs: -14 }, { deterministic: false, allowNoPath: true })

  await checkRender('lipsync SRT at 12 fps', 'audio_lipsync', { path: okPath, fps: 12, sensitivity: 0.25, leadMs: -200, format: 'srt', out: 'hygiene/lip.srt' })
  await checkRender('lipsync CSS at 120 fps', 'audio_lipsync', { render: { preset: 'chime' }, fps: 120, sensitivity: 4, leadMs: 200, format: 'css', out: 'hygiene/lip.css' })
  await checkRender('lipsync After Effects text from a bare stem', 'audio_lipsync', { render: { preset: 'impact' }, format: 'ae', out: 'hygiene/lip-ae' })

  await checkRender('beats JSON at beatsPerBar 1 and maxGrid 4', 'audio_beats', { path: okPath, beatsPerBar: 1, maxGrid: 4, out: 'hygiene/beats-a.json' })
  await checkRender('beats render at beatsPerBar 12 and maxGrid 4096', 'audio_beats', { render: { preset: 'tick' }, beatsPerBar: 12, maxGrid: 4096, out: 'hygiene/beats-b.json' })

  await checkRender('tts srt sibling is written next to the wav', 'audio_tts', { text: 'hello world', srt: true, out: 'hygiene/tts-srt.wav' })
  {
    const outcome = await invoke('audio_tts', { text: 'hello world', srt: true, out: 'hygiene/tts-srt2.wav' })
    if (outcome.ok && outcome.value.srtPath !== null && await exists(outcome.value.srtPath)) ok('tts writes the .srt file it reports', outcome.value.srtPath.split(/[\\/]/).pop())
    else if (outcome.ok) bug('tts reported an srt path that does not exist', brief(outcome.value))
  }

  // audio_bind: two files (json + js) and a deterministic pair.
  {
    const args = { cues: [{ at: 0, path: okPath }, { at: 0.2, path: okPath, gainDb: -6, fadeIn: 0.05, fadeOut: 0.05 }], duration: 1, out: 'hygiene/cue' }
    const first = await invoke('audio_bind', args)
    const second = await invoke('audio_bind', args)
    const problems = []
    if (!first.ok) problems.push(`threw ${first.error.message}`)
    else {
      if (first.value.ok !== true) problems.push('not ok')
      if (!await exists(first.value.jsPath) || !await exists(first.value.jsonPath)) problems.push('json/js missing')
      if (first.value.durationSeconds !== 1) problems.push(`duration ${first.value.durationSeconds}`)
      const bad = nonFinitePath(first.value)
      if (bad !== null) problems.push(`non-finite ${bad}`)
      if (second.ok) {
        const a = await readFile(first.value.jsPath)
        const b = await readFile(second.value.jsPath)
        if (!a.equals(b)) problems.push('cue sheet not byte-identical on repeat')
      } else problems.push('second call threw')
    }
    if (problems.length > 0) bug('audio_bind cue sheet', problems.join('; '))
    else ok('audio_bind cue sheet', `${first.value.cueCount} cue(s) · json ${first.value.jsonBytes} B · js ${first.value.jsBytes} B · byte-identical repeat`)
  }

  // audio_regress round trip: snapshot then compare must pass with the same specs.
  {
    const specs = [{ name: 'a', preset: 'impact', seed: 2 }, { name: 'b', preset: 'tick' }]
    const snap = await invoke('audio_regress', { action: 'snapshot', specs, label: 'hardening' })
    const cmp = await invoke('audio_regress', { action: 'compare', specs })
    const problems = []
    if (!snap.ok) problems.push(`snapshot threw ${snap.error.message}`)
    if (!cmp.ok) problems.push(`compare threw ${cmp.error.message}`)
    if (snap.ok && cmp.ok) {
      if (cmp.value.pass !== true) problems.push(`${cmp.value.failing} row(s) failed on an unchanged spec`)
      if (nonFinitePath(cmp.value.rows) !== null) problems.push(`non-finite ${nonFinitePath(cmp.value.rows)}`)
    }
    if (problems.length > 0) bug('audio_regress round trip', problems.join('; '))
    else ok('audio_regress round trip', `snapshot ${snap.value.specs} spec(s) · compare ${cmp.value.rows.length} rows pass`)
  }

  // audio_voices: static fallback must still return a non-empty catalog.
  {
    const outcome = await invoke('audio_voices', {})
    if (!outcome.ok) bug('audio_voices threw', String(outcome.error.message))
    else if (!Array.isArray(outcome.value.voices) || outcome.value.voices.length === 0) bug('audio_voices returned no catalogue', brief(outcome.value))
    else ok('audio_voices', `${outcome.value.source} list, ${outcome.value.voices.length} voices`)
  }

  ok('boundary values exercised', `duration 0.008 s..30 s (1e999 clamp) · rates 8000/22050/44100/48000/96000 · bit depths 8/16/24/32 · channels 1/2 · mix gains -60..0 dB · stretch factors ${STRETCH_LIMITS.minFactor}/${STRETCH_LIMITS.maxFactor} and semitones ±${STRETCH_LIMITS.maxSemitones} · sing 256 notes / bpm 20..300 · tts speed 0.5..2 and pitch ±12`)
}

// NaN and 0-frame root causes: every one of these must reject or stay finite.
section('4b. NaN and empty-signal hygiene')
{
  const emptyWavCalls = [
    ['audio_probe', { path: 'empty.wav' }],
    ['audio_convert', { inputs: ['empty.wav'], op: 'convert' }],
    ['audio_mix', { inputs: ['empty.wav'] }],
    ['audio_loudness', { path: 'empty.wav' }],
    ['audio_stretch', { path: 'empty.wav', factor: 2 }]
  ]
  const leaks = []
  for (const [name, args] of emptyWavCalls) {
    const outcome = await invoke(name, args)
    if (!outcome.ok) continue
    const bad = nonFinitePath(outcome.value.metrics)
    if (bad !== null) leaks.push(`${name} ${showArgs(args)} -> ${bad} (durationSeconds ${outcome.value.metrics?.durationSeconds ?? outcome.value.durationSeconds})`)
  }
  const direct = measure(new Float32Array(0), 44100)
  const directBad = nonFinitePath(direct, 'measure(empty)')
  if (leaks.length > 0) bug('a valid 0-sample wav leaks NaN into successful results', `measure() on an empty Float32Array emits ${directBad ?? 'non-finite values'} (loopSeam/loopStep); reported by ${leaks.join(' · ')}`)
  else ok('valid 0-sample wav stays finite across probe/convert/mix/loudness/stretch')

  // audio_check must never claim "ok" while reading zero files.
  {
    const outcome = await invoke('audio_check', { paths: [''] })
    if (outcome.ok && outcome.value.verdict === 'ok' && outcome.value.files.length === 0) {
      console.log('     (zero-work ok verdict already reported under bad arguments)')
    } else if (outcome.ok) ok('audio_check blank paths does not claim a clean verdict', `verdict ${outcome.value.verdict}`)
  }
}

/* --------------------------------------- 5. resource and size guards -- */

section('5. resource and size guards')
{
  const checkGuard = (label, outcome, limitMs) => {
    if (outcome.ok) bug(`${label}: not rejected before rendering`, `${outcome.ms}ms · ${brief(outcome.value)}`)
    else if (outcome.ms > limitMs) bug(`${label}: rejection is slow`, `${outcome.ms}ms > ${limitMs}ms`)
    else ok(`${label}`, `rejected in ${outcome.ms}ms`)
  }

  // Text length ceiling 8000.
  checkGuard('tts text ceiling (8001 chars)', await invoke('audio_tts', { text: 'x'.repeat(8001) }), 1000)
  {
    const outcome = await invoke('audio_tts', { text: 'x'.repeat(8000), out: 'guard/tts-8000.wav' })
    if (!outcome.ok) bug('tts text at the 8000 char limit was rejected', String(outcome.error.message))
    else if (outcome.ms > 5000) bug('tts at the 8000 char limit is slow', `${outcome.ms}ms`)
    else ok('tts text at the 8000 char limit is accepted', `${outcome.value.chunks} chunk(s) in ${outcome.ms}ms`)
  }

  // Compose caps: bars clamp to 96, then a 180 s audio ceiling.
  checkGuard('compose 500 bars is rejected before rendering', await invoke('audio_compose', { genre: 'ambient', bars: 500 }), 1000)
  checkGuard('compose 96 bars at 52 bpm (443 s) is rejected', await invoke('audio_compose', { genre: 'ambient', bars: 96 }), 1000)
  {
    const outcome = await invoke('audio_compose', { genre: 'lofi', bpm: 220, bars: 96, sampleRate: 8000, out: 'guard/compose-long.wav' })
    if (!outcome.ok) bug('compose of 105 s (inside the 180 s cap) was rejected', String(outcome.error.message))
    else if (outcome.ms > 5000) bug('compose of 105 s is slow', `${outcome.ms}ms`)
    else ok('compose inside the 180 s cap renders and is bounded', `${outcome.value.durationSeconds}s in ${outcome.ms}ms, ${outcome.value.bytes} B`)
  }

  // Pattern span: `to` is clamped to 600 s but never rejected — the whole span
  // is allocated and rendered first.
  {
    const outcome = await invoke('audio_pattern', { preset: 'tick', to: 600, every: 10, out: 'guard/pattern-600.wav' })
    if (outcome.ok) {
      bug('pattern to=600 s is rendered instead of rejected', `rendered ${outcome.value.durationSeconds}s / ${outcome.value.bytes} B in ${outcome.ms}ms; args audio_pattern {"preset":"tick","to":600,"every":10} (to:1e308 clamps to the same 600 s)`)
      if (typeof outcome.value.path === 'string') await rm(outcome.value.path, { force: true })
    } else if (outcome.ms < 1000) ok('pattern to=600 s is rejected quickly', `${outcome.ms}ms`)
    else bug('pattern to=600 s rejection is slow', `${outcome.ms}ms`)
  }
  // Pattern event count: the guard must fire before the renderer allocates.
  {
    const toolsUrl = new URL('../lib/tools.js', import.meta.url).href
    const extrasUrl = new URL('../lib/presets-extra.js', import.meta.url).href
    const childCode = `
const { registerExtraPresets } = await import(${JSON.stringify(extrasUrl)})
registerExtraPresets()
const { registerTools } = await import(${JSON.stringify(toolsUrl)})
const registry = new Map()
registerTools({
  tools: { register: (definition) => registry.set(definition.name, definition) },
  get: (name) => (name === 'workingDirectory' ? { get: () => process.cwd() } : undefined)
})
const started = Date.now()
try {
  const result = await registry.get('audio_pattern').execute({ preset: 'tick', to: 1, count: 1e9 }, { agent: { session: { id: 'child' } } })
  console.log('finished ' + JSON.stringify({ ms: Date.now() - started, events: result.events }))
} catch (error) {
  console.log('rejected ' + JSON.stringify({ ms: Date.now() - started, message: String(error.message) }))
  process.exitCode = 3
}
`
    const childStarted = Date.now()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { cwd, timeout: 2500, encoding: 'utf8' })
    const childMs = Date.now() - childStarted
    const childText = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
    // Three outcomes are distinguishable, and only the two below are honest:
    // it returned (never rejected), or it was killed by the timeout (kept
    // rendering). A fast non-zero exit that carries the limit is the pass.
    if (child.signal !== null && child.signal !== undefined) {
      bug('pattern count=1e9 runs unbounded work (no guard)', `audio_pattern {"preset":"tick","to":1,"count":1e9} still rendering after ${childMs}ms; child killed (signal ${child.signal})`)
    } else if (child.status === 0) {
      bug('pattern count=1e9 returned, but it should be rejected', childText)
    } else if (!/20000/.test(childText)) {
      bug('pattern count=1e9 rejected without naming the event limit', `${childMs}ms · "${childText.slice(0, 180)}"`)
    } else if (childMs > 1000) {
      bug('pattern count=1e9 rejection is slow', `${childMs}ms > 1000ms`)
    } else {
      ok('pattern count=1e9 is rejected before rendering', `${childMs}ms · ${childText.split('\n')[0].slice(0, 140)}`)
    }
  }

  // Sing caps: 256 notes and 120 s.
  checkGuard('sing 257 notes', await invoke('audio_sing', { notes: Array.from({ length: 257 }, () => ({ midi: 60, dur: 1 })) }), 1000)
  checkGuard('sing over 120 s', await invoke('audio_sing', { notes: [{ midi: 60, dur: 32, beat: 3000 }], bpm: 20 }), 1000)
  {
    const started = Date.now()
    const outcome = await invoke('audio_sing', { notes: Array.from({ length: 256 }, (_, index) => ({ midi: 60 + (index % 12), dur: 0.0625 })), bpm: 300, out: 'guard/sing-256.wav' })
    if (!outcome.ok) bug('sing at the 256 note limit was rejected', String(outcome.error.message))
    else if (Date.now() - started > 5000) bug('sing at the 256 note limit is slow', `${Date.now() - started}ms`)
    else ok('sing at the 256 note limit is accepted', `${outcome.value.notes} notes in ${Date.now() - started}ms`)
  }

  // Bind inline budget: refusal must be a bounded answer, not a 40 MB page.
  {
    const before = Date.now()
    const outcome = await invoke('audio_bind', { cues: [{ at: 0, path: 'fixtures/ok.wav' }], inline: true, maxBytes: 1024, out: 'guard/refused' })
    const ms = Date.now() - before
    if (!outcome.ok) bug('audio_bind inline over budget threw instead of refusing', String(outcome.error.message))
    else if (outcome.value.ok !== false || outcome.value.refused !== true) bug('audio_bind inline over budget did not refuse', brief(outcome.value))
    else if (ms > 1000) bug('audio_bind inline refusal is slow', `${ms}ms`)
    else if (await exists(join(cwd, 'guard', 'refused.json'))) bug('audio_bind wrote the cue sheet despite refusing to inline', 'guard/refused.json exists')
    else ok('audio_bind inline over budget refuses before writing', `${ms}ms, page would be ${outcome.value.pageWeightBytes} B > ${outcome.value.maxBytes} B`)
  }
  {
    const outcome = await invoke('audio_bind', { cues: [{ at: 0, path: 'fixtures/ok.wav' }], inline: true, out: 'guard/inline' })
    if (!outcome.ok) bug('audio_bind inline under budget threw', String(outcome.error.message))
    else if (outcome.value.ok !== true || !(outcome.value.pageWeightBytes > 0)) bug('audio_bind inline under budget did not inline', brief(outcome.value))
    else ok('audio_bind inline under budget inlines', `${outcome.value.pageWeightBytes} B page weight`)
  }

  // Convert inline budget: over-cap is a documented skip, not an error.
  {
    const outcome = await invoke('audio_convert', { inputs: ['fixtures/ok.wav'], op: 'convert', inline: true, maxInlineBytes: 1024, out: 'guard/convert-inline.wav' })
    if (!outcome.ok) bug('audio_convert inline over cap threw', String(outcome.error.message))
    else if (outcome.value.inline !== null) bug('audio_convert returned base64 over the cap', `inline ${outcome.value.inline?.dataUriBytes} B > 1024 B`)
    else ok('audio_convert inline over cap is skipped with a note', outcome.ms + 'ms')
  }
}

/* ------------------------------------------------- 6. error quality -- */

section('6. error message table (every rejection path)')
{
  const flagged = errorRows.filter((row) => row.flags !== '')
  const noMessage = errorRows.filter((row) => row.message.trim() === '')
  console.log(`     ${errorRows.length} failure paths · ${flagged.length} flagged · ${noMessage.length} empty-message`)
  console.log(`     ${'#'.padStart(3)} ${'label'.padEnd(38)} ${'arguments'.padEnd(64)} ${'ms'.padStart(5)} message`)
  let index = 0
  for (const row of errorRows) {
    index += 1
    const args = row.where.length > 62 ? `${row.where.slice(0, 61)}…` : row.where
    const message = row.message.length > 78 ? `${row.message.slice(0, 77)}…` : row.message
    console.log(`     ${String(index).padStart(3)} ${row.label.padEnd(38).slice(0, 38)} ${args.padEnd(64)} ${String(row.ms).padStart(4)}ms ${row.flags === '' ? '' : `[${row.flags}] `}${message}`)
  }
  if (flagged.length > 0) warn('flagged messages', `${flagged.length} message(s) contain undefined/NaN/[object Object]/nothing: ${flagged.map((row) => row.label).join(', ')}`)
  else ok('all error messages are clean', 'no empty, undefined, [object Object] or NaN text')
  if (nonErrorThrows === 0) ok('every rejection throws an Error instance', `${errorRows.length} paths`)
  else bug('some rejections did not throw Error instances', `${nonErrorThrows} non-Error throw(s), see the table`)
}

/* ------------------------------------------------- 7. concurrency -- */

section('7. concurrency: 8 different tools at once')
{
  const jobs = [
    ['audio_synth', { preset: 'impact', duration: 0.4, out: 'conc/synth.wav' }],
    ['audio_pattern', { preset: 'tick', to: 1, every: 0.1, out: 'conc/pattern.wav' }],
    ['audio_design', { recipe: 'glass-break', out: 'conc/design.wav' }],
    ['audio_compose', { genre: 'lofi', bars: 2, sampleRate: 22050, out: 'conc/compose.wav' }],
    ['audio_convert', { inputs: [{ preset: 'whoosh', duration: 0.4 }], op: 'convert', out: 'conc/convert.wav' }],
    ['audio_stretch', { render: { preset: 'riser' }, factor: 1.2, out: 'conc/stretch.wav' }],
    ['audio_lipsync', { render: { preset: 'impact' }, out: 'conc/lipsync.json' }],
    ['audio_beats', { render: { preset: 'impact' }, out: 'conc/beats.json' }]
  ]
  const started = Date.now()
  const outcomes = await Promise.all(jobs.map(([name, args]) => invoke(name, args)))
  const ms = Date.now() - started
  const problems = []
  const paths = []
  for (let index = 0; index < jobs.length; index += 1) {
    const name = jobs[index][0]
    const outcome = outcomes[index]
    if (!outcome.ok) {
      problems.push(`${name} threw "${outcome.error?.message}"`)
      continue
    }
    const value = outcome.value
    if (typeof value.path !== 'string') {
      problems.push(`${name} returned no path`)
      continue
    }
    paths.push(value.path)
    if (!await exists(value.path)) problems.push(`${name} file missing at ${value.path}`)
    if (value.path.endsWith('.wav')) {
      const probe = await probeFile(value.path)
      if (!(probe.peakDbfs > -60)) problems.push(`${name} output is silent (peak ${probe.peakDbfs} dBFS)`)
      if (!(probe.durationSeconds > 0)) problems.push(`${name} output is empty`)
    } else {
      const info = await stat(value.path)
      if (!(info.size > 0)) problems.push(`${name} output is empty`)
    }
  }
  const distinct = new Set(paths).size
  if (distinct !== paths.length) problems.push(`${paths.length} outputs collapsed onto ${distinct} distinct paths`)
  if (problems.length > 0) bug('concurrent renders', problems.join('; '))
  else ok('8 concurrent renders', `${distinct} distinct paths, every file exists, none silent, ${ms}ms total`)
}

/* ----------------------------------------------------- 8. summary -- */

console.log('\n== summary ==')
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`ok ${results.ok} · WARN ${results.warn} · BUG ${results.bug} · ${errorRows.length} failure paths · ${elapsed}s`)
if (bugList.length > 0) {
  console.log('\n-- BUG reproductions --')
  for (const item of bugList) console.log(`BUG  ${item.label} — ${item.detail}`)
}
console.log(`\n${results.bug === 0 ? 'OK: no BUG observed' : `FAIL: ${results.bug} BUG(s) observed`}`)

ttsServer.close()
await rm(cwd, { recursive: true, force: true })
process.exit(results.bug === 0 ? 0 : 1)
