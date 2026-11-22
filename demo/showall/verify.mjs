/**
 * Verify demo/showall/index.html — a single-file, offline, audio-reactive
 * showcase of all 24 dsh-audio tools.
 *
 *   node demo/showall/verify.mjs [path/to/index.html]
 *
 * Prints every number it measures. `BUG` lines are hard failures (exit 1);
 * `WARN` lines are advisory. Read-only: never touches the page or assets.
 */

import { readFileSync, statSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const PAGE = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? join(here, 'index.html'))

// `--shots` switches to the headless-Chrome frame capture (step 3) instead of
// the static checks. Same file, so the verify tool stays self-contained.
if (process.argv.includes('--shots')) {
  await runShots()
  process.exit(0)
}

const bugs = []
const warns = []
const bug = (msg) => { bugs.push(msg); console.log(`BUG  ${msg}`) }
const warn = (msg) => { warns.push(msg); console.log(`WARN ${msg}`) }
const ok = (msg) => console.log(`ok   ${msg}`)
const head = (msg) => console.log(`\n== ${msg} ==`)

/* ------------------------------------------------------------------ 0. file */

head('0. file')
if (!existsSync(PAGE)) {
  console.log(`BUG  missing ${PAGE}`)
  process.exit(1)
}
const raw = readFileSync(PAGE)
const size = raw.length
const limit = 2.2 * 1024 * 1024
if (size <= limit) ok(`size ${(size / 1024 / 1024).toFixed(3)} MB <= ${(limit / 1024 / 1024).toFixed(2)} MB`)
else bug(`size ${(size / 1024 / 1024).toFixed(3)} MB > 2.2 MB limit (+${(size - limit)} B)`)

let html = ''
try {
  html = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  ok(`valid UTF-8, ${html.length} chars, ${html.split('\n').length} lines`)
} catch (error) {
  bug(`not valid UTF-8: ${error.message}`)
  html = raw.toString('utf8')
}

/* --------------------------------------------------- 1. offline / no leaks */

head('1. offline + template leaks')
const URL_RX = /(?:https?|ftp):\/\/[^\s"'`<>()\\]*/gi
const urls = [...html.matchAll(URL_RX)].map((m) => m[0])
const namespaceUrls = urls.filter((u) => /^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1998\/Math)/i.test(u))
const foreignUrls = urls.filter((u) => !namespaceUrls.includes(u))
console.log(`urls   total ${urls.length}, svg/xml namespaces ${namespaceUrls.length}, foreign ${foreignUrls.length}`)
if (foreignUrls.length === 0 && namespaceUrls.length <= 4) ok('no http(s):// beyond SVG/XSL namespaces')
else {
  for (const u of foreignUrls.slice(0, 8)) bug(`network URL "${u}"`)
  if (namespaceUrls.length > 4) bug(`${namespaceUrls.length} namespace URLs (expected <= 4)`)
}
const srcTags = [...html.matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length
const linkHref = [...html.matchAll(/<link\b[^>]*\bhref\s*=/gi)].length
const imgSrc = [...html.matchAll(/<img\b[^>]*\bsrc\s*=(?!\s*["']?data:)/gi)].length
const cssImport = [...html.matchAll(/@import\b/gi)].length
const fetchCalls = [...html.matchAll(/\bfetch\s*\(/gi)].length
const xhr = [...html.matchAll(/XMLHttpRequest/g)].length
if (srcTags === 0 && linkHref === 0 && imgSrc === 0 && cssImport === 0) ok('no <script src>, <link href>, external <img src>, @import')
else bug(`external refs: script src ${srcTags}, link href ${linkHref}, img src ${imgSrc}, @import ${cssImport}`)
if (fetchCalls === 0 && xhr === 0) ok('no fetch()/XMLHttpRequest (fully offline)')
else warn(`network calls in JS: fetch ${fetchCalls}, XHR ${xhr}`)

const leftoverTokens = [...html.matchAll(/__[A-Z][A-Z0-9_]{2,}__|@[A-Z][A-Z0-9_]{2,}@|\{\{[a-zA-Z0-9_.]+\}\}|%%[A-Z][A-Z0-9_]{2,}%%/g)].map((m) => m[0])
const realLeftovers = []
const pageInternals = []
for (const token of new Set(leftoverTokens)) {
  // A `__NAME__` that the page itself defines (var/let/const/window.__NAME__ =) is a
  // deliberate global, not an unreplaced build placeholder.
  const defined = new RegExp(`(?:window\\.|globalThis\\.|self\\.|var\\s+|let\\s+|const\\s+|function\\s+)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=({]`).test(html)
  const uses = html.split(token).length - 1
  if (defined) pageInternals.push(`${token} x${uses} (defined by the page)`)
  else realLeftovers.push(`${token} x${uses}`)
}
if (pageInternals.length > 0) console.log(`       page globals: ${pageInternals.join(', ')}`)
if (realLeftovers.length === 0) ok('no unreplaced __TOKEN__ / @TOKEN@ / {{token}} / %%TOKEN%% placeholders')
else bug(`template leftovers: ${realLeftovers.slice(0, 8).join(', ')}`)

/* ------------------------------------------------------- 2. spec + scenes */

head('2. showall-spec')
const specMatch = html.match(/<script[^>]*\btype\s*=\s*["']application\/json["'][^>]*\bid\s*=\s*["']showall-spec["'][^>]*>([\s\S]*?)<\/script>/i) ??
  html.match(/<script[^>]*\bid\s*=\s*["']showall-spec["'][^>]*>([\s\S]*?)<\/script>/i)
let spec = null
if (specMatch === null) {
  bug('no <script type="application/json" id="showall-spec"> block')
} else {
  try {
    spec = JSON.parse(specMatch[1].replace(/<\/script[\s\S]*$/i, ''))
    ok(`spec JSON parses: top-level keys [${Object.keys(spec).join(', ')}], ${specMatch[1].length} chars`)
  } catch (error) {
    bug(`spec JSON does not parse: ${error.message}`)
  }
}

const duration = Number(spec?.duration ?? spec?.seconds ?? spec?.length)
if (!Number.isFinite(duration)) bug('spec.duration missing / not a number')
else if (duration >= 40 && duration <= 48) ok(`duration ${duration}s within 40..48`)
else bug(`duration ${duration}s outside 40..48`)

const scenes = Array.isArray(spec?.scenes) ? spec.scenes : Array.isArray(spec?.scene) ? spec.scene : []
if (scenes.length === 0) {
  bug('spec.scenes missing or empty')
} else {
  const nums = (o) => ({
    at: Number(o.at ?? o.start ?? o.t ?? o.time ?? o.from),
    dur: Number(o.duration ?? o.dur ?? o.len ?? o.length ?? NaN),
    to: Number(o.to ?? o.end ?? NaN)
  })
  const rows = scenes.map((s, i) => ({ i, name: s.name ?? s.id ?? s.title ?? `#${i}`, ...nums(s) }))
  for (const r of rows) {
    if (!Number.isFinite(r.at)) bug(`scene[${r.i}] "${r.name}" has no start time`)
    if (!Number.isFinite(r.to)) r.to = r.at + r.dur
    if (!Number.isFinite(r.to)) bug(`scene[${r.i}] "${r.name}" has no end/duration`)
  }
  console.log(`scenes ${rows.length}: ` + rows.map((r) => `${r.name}@${r.at}-${Number(r.to.toFixed?.(2) ?? r.to)}`).join(' '))
  const first = rows[0]
  if (Math.abs(first.at) > 0.001) bug(`first scene starts at ${first.at}s, expected 0`)
  let contiguous = true
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].at - rows[i - 1].to
    if (Math.abs(gap) > 0.02) {
      contiguous = false
      bug(`scenes not contiguous at ${i - 1}->${i}: gap ${gap.toFixed(3)}s (${rows[i - 1].to}s -> ${rows[i].at}s)`)
    }
  }
  const lastTo = rows[rows.length - 1].to
  if (contiguous) ok(`scenes contiguous (${rows.length} spans, 0 -> ${lastTo}s)`)
  if (lastTo > duration + 0.02) bug(`last scene ends at ${lastTo}s, past duration ${duration}s`)
  else ok(`last scene ends ${lastTo}s inside duration ${duration}s (tail ${(duration - lastTo).toFixed(2)}s)`)
  const empty = rows.filter((r) => !(r.to > r.at))
  if (empty.length > 0) bug(`${empty.length} scene(s) with non-positive length: ${empty.map((r) => r.name).join(', ')}`)
  const names = rows.map((r) => r.name)
  if (new Set(names).size !== names.length) warn(`duplicate scene names (${names.length} scenes, ${new Set(names).size} unique)`)
}

/* ---------------------------------------------------- 3. tool coverage 24/24 */

head('3. tool coverage')
let realTools = []
try {
  const { loadPlugin } = await import(pathToFileURL(join(root, 'dsh-audio-lab', 'harness', 'ctx.mjs')).href)
  const { ctx } = await loadPlugin(join(root, 'dsh-audio'), {})
  realTools = [...ctx.state.tools.keys()]
  ok(`plugin loaded via loadPlugin: ${realTools.length} tools registered`)
} catch (error) {
  warn(`harness loadPlugin failed (${error.message}); falling back to regex over dsh-audio/index.js`)
  try {
    const src = readFileSync(join(root, 'dsh-audio', 'index.js'), 'utf8')
    realTools = [...new Set([...src.matchAll(/name\s*:\s*['"](audio_[a-z0-9_]+)['"]/g)].map((m) => m[1]))]
    ok(`regex fallback found ${realTools.length} tool names`)
  } catch (inner) {
    bug(`cannot read plugin tool list: ${inner.message}`)
  }
}

const specTools = Array.isArray(spec?.tools) ? spec.tools : Array.isArray(spec?.tool) ? spec.tool : null
if (specTools === null) {
  bug('spec.tools missing / not an array')
} else {
  const names = specTools.map((t) => typeof t === 'string' ? t : (t?.name ?? t?.id ?? t?.tool ?? ''))
  const unique = [...new Set(names)]
  console.log(`tools  spec ${names.length} entries, ${unique.length} unique; plugin ${realTools.length}`)
  console.log(`       spec: ${unique.join(', ')}`)
  if (unique.length >= 24) ok(`spec.tools has >= 24 unique names`)
  else bug(`spec.tools has ${unique.length} unique names, expected at least 24 (dupes: ${names.length - unique.length})`)

  const norm = (s) => String(s).toLowerCase().replace(/^audio[_\-\s]?/, '').replace(/[^a-z0-9]/g, '')
  const realSet = new Set(realTools)
  const normSet = new Set(realTools.map(norm))
  const missing = unique.filter((n) => !realSet.has(n) && !normSet.has(norm(n)))
  const uncovered = realTools.filter((r) => !unique.includes(r) && !unique.some((n) => norm(n) === norm(r)))
  const coverage = realTools.length === 0 ? 0 : realTools.filter((r) => unique.includes(r) || unique.some((n) => norm(n) === norm(r))).length
  if (missing.length === 0 && uncovered.length === 0) ok(`tool coverage ${coverage}/24 — every scene tool is a real registered tool`)
  else {
    if (missing.length > 0) bug(`${missing.length} spec tool name(s) not registered: ${missing.join(', ')}`)
    if (uncovered.length > 0) bug(`${uncovered.length} plugin tool(s) not represented: ${uncovered.join(', ')}`)
    console.log(`       coverage ${coverage}/${realTools.length}`)
  }
}

/* ------------------------------------------------ 4. embedded audio data URIs */

head('4. inline audio')
const b64Rx = /data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/gi
const audioUris = [...html.matchAll(b64Rx)]
console.log(`uris   ${audioUris.length} data:audio URIs, ${(audioUris.reduce((n, m) => n + m[2].length, 0) / 1024 / 1024).toFixed(2)} MB of base64`)
if (audioUris.length === 0) {
  console.log('uris   0 data:audio URIs — checking for unprefixed base64 clip payloads next')
}
let audioBytes = 0
let decoded = 0
let silent = 0
let tooLong = 0
const mimes = new Map()
let decodeWav = null
try {
  const wavModule = await import(pathToFileURL(join(root, 'dsh-audio-lab', 'plugin', 'lib', 'wav.js')).href)
  decodeWav = wavModule.decodeWav
  ok('decodeWav imported from dsh-audio-lab/plugin/lib/wav.js')
} catch (error) {
  bug(`cannot import decodeWav: ${error.message}`)
}
const seen = new Set()
for (const [index, match] of audioUris.entries()) {
  const mime = match[1].toLowerCase()
  mimes.set(mime, (mimes.get(mime) ?? 0) + 1)
  const b64 = match[2].replace(/\s+/g, '')
  if (seen.has(b64)) continue
  seen.add(b64)
  const bytes = Buffer.from(b64, 'base64')
  audioBytes += bytes.length
  const prefix = `audio[${index}] ${mime} ${(bytes.length / 1024).toFixed(1)} KB`
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    bug(`${prefix}: not a RIFF/WAVE payload (magic "${bytes.toString('ascii', 0, 4)}")`)
    continue
  }
  if (decodeWav === null) continue
  try {
    const wav = decodeWav(bytes)
    decoded += 1
    const channels = wav.channels ?? wav.channelData ?? []
    let peak = 0
    for (const channel of channels) for (let i = 0; i < channel.length; i += 1) {
      const v = Math.abs(channel[i]); if (v > peak) peak = v
    }
    const seconds = Number.isFinite(wav.durationSeconds)
      ? wav.durationSeconds
      : (wav.frames ?? (channels[0]?.length ?? 0)) / (wav.sampleRate || 1)
    if (peak <= 0.01) { silent += 1; bug(`${prefix}: silent, peak ${peak.toFixed(4)} <= 0.01`) }
    if (seconds > 45) { tooLong += 1; bug(`${prefix}: ${seconds.toFixed(2)}s > 45s`) }
    if (index < 4) console.log(`       ${prefix}: ${channels.length}ch ${wav.sampleRate}Hz ${seconds.toFixed(2)}s peak ${peak.toFixed(3)}`)
  } catch (error) {
    bug(`${prefix}: decodeWav threw "${error.message}"`)
  }
}
// Some builders inline clips as a JSON field — `{"name":"hover","data":"UklGR…"}`
// without the `data:audio/…;base64,` prefix. Those are the same payloads.
const bareCandidates = [...html.matchAll(/["']data["']\s*:\s*["']([A-Za-z0-9+/=]{80,})["']/g)].map((m) => m[1])
let bareDecoded = 0
for (const [index, b64] of bareCandidates.entries()) {
  if (seen.has(b64)) continue
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') continue
  seen.add(b64)
  audioBytes += bytes.length
  const prefix = `clip[${index}] wav ${(bytes.length / 1024).toFixed(1)} KB (unprefixed base64)`
  if (decodeWav === null) continue
  try {
    const wav = decodeWav(bytes)
    bareDecoded += 1
    decoded += 1
    const channels = wav.channels ?? wav.channelData ?? []
    let peak = 0
    for (const channel of channels) for (let i = 0; i < channel.length; i += 1) {
      const v = Math.abs(channel[i]); if (v > peak) peak = v
    }
    const seconds = Number.isFinite(wav.durationSeconds) ? wav.durationSeconds : (channels[0]?.length ?? 0) / (wav.sampleRate || 1)
    if (peak <= 0.01) { silent += 1; bug(`${prefix}: silent, peak ${peak.toFixed(4)}`) }
    if (seconds > 45) { tooLong += 1; bug(`${prefix}: ${seconds.toFixed(2)}s > 45s`) }
    if (bareDecoded <= 3) console.log(`       ${prefix}: ${seconds.toFixed(2)}s peak ${peak.toFixed(3)}`)
  } catch (error) {
    bug(`${prefix}: decodeWav threw "${error.message}"`)
  }
}
if (bareDecoded > 0) console.log(`clips  ${bareDecoded} additional unprefixed base64 WAV clip(s) decoded`)

console.log(`audio  mimes [${[...mimes].map(([m, n]) => `${m}x${n}`).join(', ')}]; unique ${seen.size}, decoded ${decoded}, silent ${silent}, >45s ${tooLong}, total ${(audioBytes / 1024 / 1024).toFixed(2)} MB`)
if (decoded === seen.size && seen.size > 0 && silent === 0 && tooLong === 0) ok(`all ${decoded} unique audio payloads decode, peak > 0.01, <= 45s`)
else if (seen.size === 0) warn('no embedded audio payloads found — check the page actually carries sound (assets/*.js inlined?)')

/* --------------------------------------------- 5. inline scripts evaluate */

head('5. inline scripts')
const startGateRx = /\b(id|class)\s*=\s*["'][^"']*(gate|start|intro|cover|splash|enter)/i
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
console.log(`scripts ${scripts.length} inline <script> blocks, ${(scripts.reduce((n, m) => n + m[2].length, 0) / 1024).toFixed(1)} KB of JS`)
const scriptBlocks = scripts.map((m, i) => {
  const attrs = m[1]
  const id = (attrs.match(/\bid\s*=\s*["']([^"']+)["']/) ?? [])[1] ?? `anonymous-${i}`
  const isJson = /\btype\s*=\s*["']application\/json["']/i.test(attrs)
  return { id, attrs, code: m[2], isJson }
})
const byId = new Map(scriptBlocks.map((s) => [s.id, s]))

function parseOnly(name, code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code)
    ok(`<script id="${name}"> parses (new Function, ${code.length} B)`)
    return true
  } catch (error) {
    bug(`<script id="${name}"> does not parse: ${error.message}`)
    return false
  }
}

function fakeBrowser() {
  const param = () => ({
    value: 0,
    setValueAtTime() { return this },
    linearRampToValueAtTime() { return this },
    exponentialRampToValueAtTime() { return this },
    setTargetAtTime() { return this },
    setCurve() { return this },
    cancelScheduledValues() { return this },
    cancelAndHoldAtTime() { return this }
  })
  const node = (extra = {}) => {
    const n = {
      type: 'sine', value: 0, loop: false, loopStart: 0, loopEnd: 0, buffer: null, curve: null,
      bufferSize: 256, frequencyBinCount: 32, numberOfInputs: 1, numberOfOutputs: 1,
      gain: param(), frequency: param(), detune: param(), Q: param(), pan: param(), offset: param(),
      delayTime: param(), playbackRate: param(), reduction: 0,
      connect(...args) { for (const a of args) if (a && typeof a === 'object') connects.push(a); return args[0] ?? n },
      disconnect() { return n },
      start() { started += 1; return n },
      stop() { stopped += 1; return n },
      setPeriodicWave() { return n },
      getByteFrequencyData(arr) { if (arr && arr.fill) arr.fill(0) },
      getFloatTimeDomainData(arr) { if (arr && arr.fill) arr.fill(0) },
      getByteTimeDomainData(arr) { if (arr && arr.fill) arr.fill(128) },
      ...extra
    }
    return n
  }
  let started = 0
  let stopped = 0
  const connects = []
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.01,
    destination: node(),
    listener: { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() },
    createGain() { return node() },
    createOscillator() { return node() },
    createBiquadFilter() { return node({ type: 'lowpass' }) },
    createBufferSource() { return node() },
    createStereoPanner() { return node() },
    createPanner() { return node() },
    createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }) },
    createConvolver() { return node() },
    createWaveShaper() { return node() },
    createDelay() { return node() },
    createAnalyser() { return node() },
    createConstantSource() { return node() },
    createChannelMerger() { return node() },
    createChannelSplitter() { return node() },
    createIIRFilter() { return node() },
    createPeriodicWave() { return { setPeriodicWave() {} } },
    createBuffer(channels = 1, frames = 1, rate = 48000) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames))
      return { numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate, getChannelData: (i) => data[i] ?? data[0] }
    },
    decodeAudioData(bytes) {
      return Promise.resolve({ numberOfChannels: 1, length: 48000, sampleRate: 48000, duration: 1, getChannelData: () => new Float32Array(48000) })
    },
    resume() { return Promise.resolve() },
    suspend() { return Promise.resolve() },
    close() { return Promise.resolve() },
    addEventListener() {}, removeEventListener() {},
    setTargetAtTime() {}, cancelScheduledValues() {},
    get stats() { return { started, stopped, connects: connects.length } }
  }
  return { ctx, node, param }
}

// The builder may inline the two asset scripts without ids, so identify them by
// signature first and only fall back to id="live-sfx"/id="ui-sfx".
const liveBlock = byId.get('live-sfx') ??
  scriptBlocks.find((s) => !s.isJson && /root\.dshLive\s*=\s*api|dsh-live [\d.]+|function liveHash/.test(s.code))
const uiBlock = byId.get('ui-sfx') ??
  scriptBlocks.find((s) => !s.isJson && s !== liveBlock && /dsh-audio interaction sounds|["']clips["']\s*:/.test(s.code))
if (liveBlock === undefined) bug('no live-sfx script found (id="live-sfx" or the dsh-live payload)')
if (uiBlock === undefined) bug('no ui-sfx script found (id="ui-sfx" or the interaction-sounds payload)')

let parseFails = 0
for (const block of scriptBlocks) {
  if (block.isJson) continue
  const label = block === liveBlock ? 'live-sfx' : block === uiBlock ? 'ui-sfx' : block.id
  if (!parseOnly(label, block.code)) parseFails += 1
  else if (block === liveBlock || block === uiBlock) {
    console.log(`       ${label}: ${(block.code.length / 1024).toFixed(1)} KB, ${block.code.split('\n').length} lines`)
  }
}
if (parseFails > 0) bug(`${parseFails} inline script block(s) failed to parse`)
else ok(`all ${scriptBlocks.filter((b) => !b.isJson).length} inline script blocks parse`)

const liveExposes = { dshLive: false, detail: '' }
if (liveBlock !== undefined) {
  const { ctx } = fakeBrowser()
  const doc = {
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, style: {} },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {}, getContext: () => null }),
    addEventListener() {}, removeEventListener() {}, readyState: 'complete',
    hidden: false, visibilityState: 'visible'
  }
  const win = {
    AudioContext: function () { return ctx },
    webkitAudioContext: function () { return ctx },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    performance: { now: () => 0, timeOrigin: 0 },
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
    navigator: { userAgent: 'verify.mjs', maxTouchPoints: 0 },
    location: { href: 'file:///demo/showall/index.html' },
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {} }
  }
  const probe = `${liveBlock.code}\n;return (typeof window !== 'undefined' && window.dshLive) ? window.dshLive : (typeof dshLive !== 'undefined' ? dshLive : undefined);`
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('window', 'document', 'globals', 'AudioContext', 'webkitAudioContext', 'performance', 'navigator', 'location', 'console', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'documentElement', probe)
    const exposed = factory(win, doc, win, win.AudioContext, win.AudioContext, win.performance, win.navigator, win.location, win.console, win.requestAnimationFrame, win.cancelAnimationFrame, win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval, doc.documentElement)
    if (exposed !== undefined && exposed !== null) {
      liveExposes.dshLive = true
      const keys = typeof exposed === 'object' ? Object.keys(exposed) : []
      liveExposes.detail = `${typeof exposed}${keys.length ? ` [${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}]` : ''}`
      ok(`live-sfx evaluates against fake window/AudioContext and exposes window.dshLive: ${liveExposes.detail}`)
    } else {
      bug('live-sfx evaluated but window.dshLive is undefined')
    }
  } catch (error) {
    bug(`live-sfx failed against fake window/AudioContext: ${error.message}`)
  }
  console.log(`       fake AudioContext touched: ${ctx.stats.started} source.start(), ${ctx.stats.connects} connect() calls`)
}

/* ------------------------------------------------------------- 6. palette */

head('6. palette')
const REQUIRED = [
  { name: 'stage', hex: '#121212' },
  { name: 'ink', hex: '#e6e6e6' },
  { name: 'accent (violet)', hex: '#c56bd6' }
]
const hexToRgb = (hex) => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const rgbForms = (hex) => {
  const [r, g, b] = hexToRgb(hex)
  return [hex.toLowerCase(), `rgb(${r}, ${g}, ${b})`, `rgb(${r},${g},${b})`, `rgba(${r}, ${g}, ${b}`, `rgba(${r},${g},${b}`]
}
const lowerHtml = html.toLowerCase()
for (const token of REQUIRED) {
  const hits = rgbForms(token.hex).reduce((n, form) => n + lowerHtml.split(form).length - 1, 0)
  if (hits > 0) ok(`token ${token.name} ${token.hex} present (${hits} occurrence${hits === 1 ? '' : 's'})`)
  else bug(`token ${token.name} ${token.hex} absent`)
}

/* The direction is black-and-white archive: neutrals everywhere, a little
   violet (plus blue only to separate two states), and NO warm hue at all. */
const srgbToHsl = ([r, g, b]) => {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb); const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  return { h, s, l }
}
const colourHits = new Map()
for (const m of html.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
  const hex = `#${m[1].toLowerCase()}`
  colourHits.set(hex, (colourHits.get(hex) ?? 0) + 1)
}
for (const m of html.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) {
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])]
  const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
  colourHits.set(hex, (colourHits.get(hex) ?? 0) + 1)
}
console.log(`colours ${colourHits.size} distinct hex/rgb literals in CSS+JS`)

const warm = []
const cool = []
const alien = []
let totalLit = 0
for (const [hex, count] of colourHits) {
  totalLit += count
  let rgb = hexToRgb(hex)
  if (hex.length === 4) rgb = [rgb[0] * 17, rgb[1] * 17, rgb[2] * 17]
  if (rgb.some((v) => Number.isNaN(v))) continue
  const { h, s, l } = srgbToHsl(rgb)
  const neutral = s < 0.22 || l < 0.16 || l > 0.96
  if (neutral) continue
  if (h >= 8 && h <= 55 && s > 0.3) warm.push({ hex, count, h: Math.round(h), s: Number(s.toFixed(2)) })
  else if ((h >= 265 && h <= 330) || (h >= 200 && h <= 245)) cool.push({ hex, count, h: Math.round(h), s: Number(s.toFixed(2)) })
  else alien.push({ hex, count, h: Math.round(h), s: Number(s.toFixed(2)) })
}
if (warm.length === 0) ok('no warm/orange hue anywhere (black-and-white direction)')
else {
  for (const w of warm.slice(0, 6)) console.log(`       - ${w.hex} x${w.count} hue ${w.h}deg sat ${w.s}`)
  bug(`warm/orange hue used ${warm.length} time(s)/family: ${warm.slice(0, 4).map((w) => w.hex).join(', ')}`)
}
if (alien.length === 0) ok('no saturated hue outside the violet/blue families')
else bug(`unexpected saturated hue: ${alien.slice(0, 4).map((a) => `${a.hex} hue ${a.h}`).join(', ')}`)
const coolLit = cool.reduce((n, c) => n + c.count, 0)
const coolShare = totalLit === 0 ? 0 : coolLit / totalLit
console.log(`cool  ${cool.length} violet/blue literal(s), ${coolLit} of ${totalLit} occurrences (${(coolShare * 100).toFixed(1)}%)`)
if (coolShare <= 0.2) ok(`violet/blue stays an accent (${(coolShare * 100).toFixed(1)}% <= 20%)`)
else bug(`violet/blue is used as a fill, not an accent (${(coolShare * 100).toFixed(1)}% > 20%)`)


/* -------------------------------------------------- 7. interactivity */

head('7. interactive affordances')
const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
const buttonsSelfClose = [...html.matchAll(/<button\b[^>]*\/>/gi)].length
const buttonTotal = buttons.length + buttonsSelfClose
const buttonText = buttons.map((m) => m[0])
if (buttonTotal >= 3) ok(`${buttonTotal} <button> elements (>= 3)`)
else bug(`only ${buttonTotal} <button> element(s), need >= 3`)

const startGate = buttonText.some((b) => /start|play|begin|enter|开始|播放|进入/i.test(b)) ||
  startGateRx.test(html) || /\bgate\b/i.test(html) ||
  /(start|play)\s*(gate|overlay|screen)/i.test(html)
if (startGate) ok('start gate present (start/play control + gate markup)')
else bug('no start gate (start/play button or gate overlay) found')

const replay = /replay|again|replay-all|重播|再看|重新播放/i.test(html) || /replay/i.test(html)
if (replay) ok('replay control present')
else bug('no replay control (replay/again) found')

const listeners = [...html.matchAll(/addEventListener\s*\(\s*['"]([a-z]+)['"]/gi)].map((m) => m[1].toLowerCase())
const listenerCounts = listeners.reduce((acc, e) => { acc[e] = (acc[e] ?? 0) + 1; return acc }, {})
const onAttrs = [...html.matchAll(/\son(click|pointerdown|mousedown|keydown|touchstart)\s*=/gi)].length
console.log(`events addEventListener calls ${listeners.length} [${Object.entries(listenerCounts).map(([e, n]) => `${e}x${n}`).join(', ')}], inline on* handlers ${onAttrs}`)
const clickish = listeners.filter((e) => ['click', 'pointerdown', 'pointerup', 'mousedown', 'touchstart', 'keydown'].includes(e)).length + onAttrs
if (clickish >= 2) ok(`${clickish} input listeners (click/pointer/key)`)
else warn(`only ${clickish} input listener(s) visible`)

const canvas = [...html.matchAll(/<canvas\b/gi)].length
const svg = [...html.matchAll(/<svg\b/gi)].length
const raf = [...html.matchAll(/requestAnimationFrame/gi)].length
console.log(`dom    <canvas> ${canvas}, <svg> ${svg}, requestAnimationFrame refs ${raf}, style/script ${(html.length / 1024).toFixed(0)} KB total`)
if (canvas === 0 && svg === 0) warn('no <canvas> or <svg> — verify the page actually renders visuals')

/* ------------------------------------------ 8. freshness / needs rebuild */

head('8. freshness')
const assetsDir = join(here, 'assets')
let newestAsset = 0
let assetFiles = []
if (existsSync(assetsDir)) {
  assetFiles = readdirSync(assetsDir).filter((f) => /\.(js|wav|json)$/i.test(f))
  for (const f of assetFiles) {
    const st = statSync(join(assetsDir, f))
    if (st.mtimeMs > newestAsset) newestAsset = st.mtimeMs
  }
}
const pageStat = statSync(PAGE)
console.log(`times  page ${new Date(pageStat.mtimeMs).toISOString()}, newest asset ${newestAsset === 0 ? 'none' : new Date(newestAsset).toISOString()}, ${assetFiles.length} asset file(s)`)
if (newestAsset > pageStat.mtimeMs + 1000) {
  bug(`needs rebuild: index.html is ${((newestAsset - pageStat.mtimeMs) / 1000).toFixed(1)}s older than newest asset`
    + ` (${assetFiles.join(', ')}) — inlined audio is stale`)
} else if (assetFiles.length === 0) {
  warn('no assets/*.js or *.wav found beside the page (fine if audio is inlined and assets were already folded in)')
} else ok('page is newer than all assets (inlined build is fresh)')

const buildScript = join(here, 'build.mjs')
if (existsSync(buildScript)) {
  const buildAge = statSync(buildScript).mtimeMs - pageStat.mtimeMs
  if (buildAge > 1000) warn(`needs rebuild: build.mjs is ${(buildAge / 1000).toFixed(1)}s newer than index.html — the page predates the latest build script`)
  else ok(`build.mjs not newer than the page (+${(-buildAge / 1000).toFixed(1)}s)`)
}

/* -------------------------------------------------------------- verdict */

head('verdict')
console.log(`sections 8 | BUG ${bugs.length} | WARN ${warns.length}`)
for (const w of warns) console.log(`WARN ${w}`)
for (const b of bugs) console.log(`BUG  ${b}`)
console.log(bugs.length === 0 ? 'RESULT PASS — demo/showall/index.html is ready to show' : `RESULT FAIL — ${bugs.length} hard failure(s)`)
process.exit(bugs.length === 0 ? 0 : 1)

/* ------------------------------------------------------------------------- */
/* `--shots`: drive headless Chrome through CDP, click the start gate, grab    */
/* frames at 2/7/12/17/23/29/35/42 s and report console errors.                */
/* ------------------------------------------------------------------------- */

async function runShots () {
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const AT = [2, 7, 12, 17, 23, 29, 35, 42]
  const outDir = join(here, 'frames')
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(PAGE)) {
    console.log(`BUG  cannot shoot: ${PAGE} does not exist`)
    return
  }
  const PORT = 9346
  const profile = join(outDir, '.chrome-profile')
  const url = `file:///${PAGE.replace(/\\/g, '/')}`
  console.log(`shots  page ${url}`)
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,720', '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' })
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

  async function targets () {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        const list = await response.json()
        const page = list.find((entry) => entry.type === 'page')
        if (page !== undefined) return page
      } catch { /* chrome not up yet */ }
      await sleep(200)
    }
    throw new Error('chrome did not expose a page target')
  }

  function connect (wsUrl) {
    return new Promise((done, fail) => {
      const socket = new WebSocket(wsUrl)
      let nextId = 1
      const pending = new Map()
      const events = []
      socket.addEventListener('open', () => done({
        events,
        send (method, params = {}) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { res, rej }))
        },
        close () { socket.close() }
      }))
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id === undefined) { events.push(message); return }
        const waiter = pending.get(message.id)
        if (waiter === undefined) return
        pending.delete(message.id)
        if (message.error) waiter.rej(new Error(`${message.error.code}: ${message.error.message}`))
        else waiter.res(message.result)
      })
      socket.addEventListener('error', () => fail(new Error('websocket error')))
    })
  }

  const consoleErrors = []
  try {
    const page = await targets()
    const cdp = await connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.navigate', { url })
    await sleep(1200)

    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const buttons = [...document.querySelectorAll('button')].filter((b) => !/replay|again|\\u91cd\\u64ad/i.test(b.textContent || ''));
        const start = buttons.find((b) => /^\\s*(start|play|begin|enter|\\u5f00\\u59cb|\\u64ad\\u653e|\\u8fdb\\u5165)/i.test(b.textContent || '')) || buttons[0];
        const r = start ? start.getBoundingClientRect() : null;
        return JSON.stringify({
          readyState: document.readyState,
          buttons: document.querySelectorAll('button').length,
          start: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (start.textContent || '').trim().slice(0, 24) } : null,
          dshLive: typeof window.dshLive,
          hasAudio: typeof (window.AudioContext || window.webkitAudioContext)
        });
      })()`,
      returnByValue: true
    })
    const info = JSON.parse(probe.result.value)
    console.log(`page   readyState=${info.readyState} buttons=${info.buttons} dshLive=${info.dshLive} AudioContext=${info.hasAudio}`)
    if (info.start === null) {
      console.log('BUG  no start control to click')
    } else {
      console.log(`click  "${info.start.text}" at ${info.start.x},${info.start.y}`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.start.x, y: info.start.y })
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: info.start.x, y: info.start.y, button: 'left', clickCount: 1 })
      }
    }
    await sleep(150)
    const startedAt = Date.now()
    const frames = []
    for (const at of AT) {
      await sleep(Math.max(0, at * 1000 - (Date.now() - startedAt)))
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const buf = Buffer.from(shot.data, 'base64')
      const file = join(outDir, `t${String(at).padStart(2, '0')}s.png`)
      writeFileSync(file, buf)
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 8)
      const clock = await cdp.send('Runtime.evaluate', {
        expression: `(() => JSON.stringify({
          S: window.__SHOWALL__ ? (window.__SHOWALL__.time ?? window.__SHOWALL__.t ?? window.__SHOWALL__.clock ?? null) : null,
          status: document.body?.dataset?.status ?? null,
          scene: document.body?.dataset?.scene ?? document.querySelector('[data-scene]')?.dataset?.scene ?? null,
          gate: !!document.querySelector('[data-gate],#gate,.gate'),
          canvases: document.querySelectorAll('canvas').length
        }))()`,
        returnByValue: true
      }).catch(() => ({ result: { value: 'null' } }))
      frames.push({ at, file, bytes: buf.length, hash, state: clock.result.value })
      console.log(`frame  t=${at}s ${(buf.length / 1024).toFixed(1)} KB ${hash} -> ${file} state=${clock.result.value}`)
    }

    for (const event of cdp.events) {
      if (event.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params.type)) {
        consoleErrors.push(`console.${event.params.type}: ${event.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200)}`)
      }
      if (event.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(`exception: ${(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text ?? '').split('\n')[0].slice(0, 200)}`)
      }
      if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        consoleErrors.push(`log: ${event.params.entry.text.slice(0, 200)}`)
      }
    }
    const nonEmpty = frames.filter((f) => f.bytes > 12 * 1024)
    const distinct = new Set(frames.map((f) => f.hash)).size
    console.log(`frames ${frames.length} captured, ${nonEmpty.length} non-empty (> 12 KB), ${distinct} distinct image hash(es): ${frames.map((f) => `${f.at}s`).join(' ')}`)
    console.log(`errors ${consoleErrors.length} console error(s)`)
    for (const line of consoleErrors.slice(0, 10)) console.log(`       ${line}`)
    cdp.close()
  } catch (error) {
    console.log(`BUG  headless capture failed: ${error.message}`)
  } finally {
    chrome.kill()
  }
}
