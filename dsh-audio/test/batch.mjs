/**
 * Batch tests: one call over a whole cue set, and the promises that make it
 * safe to use on a real folder.
 *
 * The batch tool is the one place in the plugin that touches dozens of files in
 * one call, so what these tests pin down is failure isolation and honesty
 * rather than DSP (the DSP itself is covered by test/master.mjs and
 * test/lufs.mjs):
 *
 *   - a healthy file, a clipped one, a silent one, a stereo one and a corrupt
 *     one are run through all four actions;
 *   - one bad file never aborts the batch — it lands in `items[].error` and the
 *     good files still get processed;
 *   - `normalize`/`master` write copies that measure within 1 LU of the target
 *     and at or below -1 dBTP, and never touch the source bytes;
 *   - an output path that collides with *any* input is refused, not written;
 *   - the pool never has more than N items in flight, its own counter agrees
 *     with an independent counter, and a synchronous worker reports 1 — the
 *     measurable form of "the CPU is still serial";
 *   - the same inputs produce the same items and the same bytes twice.
 *
 * Run: node test/batch.mjs
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BATCH_ACTIONS,
  BATCH_DEFAULT_OUT_DIR,
  BATCH_DEFAULT_TARGET_LUFS,
  BATCH_MAX_CONCURRENCY,
  cpuCount,
  defaultConcurrency,
  resolveBatchItems,
  resolveConcurrency,
  runBatch,
  runPool
} from '../lib/batch.js'
import { analyzeLoudness, truePeak } from '../lib/lufs.js'
import { registerBatchTools } from '../lib/tools-batch.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const RATE = 44100
const TAU = Math.PI * 2
const show = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '-inf')

/* ------------------------------------------------------------------ helpers -- */

/** Deterministic sine at a peak amplitude. */
function sine (seconds, hz, amplitude, rate = RATE) {
  const frames = Math.round(seconds * rate)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin(TAU * hz * i / rate)
  return out
}

/** Hard clip at full scale: what an encoder does to an over-driven render. */
function hardClip (samples) {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] > 1 ? 1 : samples[i] < -1 ? -1 : samples[i]
  return out
}

/** Scale one mono buffer to an exact integrated loudness, so a test starts where it says. */
function scaleToLufs (samples, rate, targetLufs) {
  const analysis = analyzeLoudness(samples, rate)
  const gain = Math.pow(10, (targetLufs - analysis.integratedLufs) / 20)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain
  return out
}

/** Scale a channel list by one gain until the file measures `targetLufs`. */
function scaleChannelsToLufs (channels, rate, targetLufs) {
  const analysis = analyzeLoudness(channels[0], rate, { channels })
  const gain = Math.pow(10, (targetLufs - analysis.integratedLufs) / 20)
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] * gain
    return out
  })
}

/** Loudness of decoded channels, measured the way the plugin measures a file. */
function lufsOfChannels (channels, rate) {
  return channels.length === 1
    ? analyzeLoudness(channels[0], rate).integratedLufs
    : analyzeLoudness(channels[0], rate, { channels }).integratedLufs
}

/** Worst 4x true peak of decoded channels, in dBTP. */
function worstTruePeak (channels, rate) {
  let peak = Number.NEGATIVE_INFINITY
  for (const channel of channels) {
    const value = truePeak(channel, rate)
    if (value > peak) peak = value
  }
  return peak
}

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const decodeFile = async (path) => decodeWav(await readFile(path))
const exists = async (path) => stat(path).then(() => true).catch(() => false)

/* --------------------------------------------------------------- fixtures -- */

const cwd = await mkdtemp(join(tmpdir(), 'dsh-batch-'))

// 1. A healthy but quiet cue: -30 LUFS, so normalize/master have real work to do.
const healthy = scaleToLufs(sine(1.5, 220, 0.25), RATE, -30)
await writeFile(join(cwd, 'normal.wav'), encodeWav([healthy], RATE))

// 2. A clipped cue: the encoder clamps the over-driven sine to full scale.
await writeFile(join(cwd, 'clipping.wav'), encodeWav([hardClip(sine(1.5, 220, 2))], RATE))

// 3. Digital silence.
await writeFile(join(cwd, 'silent.wav'), encodeWav([new Float32Array(Math.round(0.5 * RATE))], RATE))

// 4. A stereo cue at -20 LUFS, with a different tone in each channel.
const stereoPair = scaleChannelsToLufs([sine(1.5, 220, 0.3), sine(1.5, 330, 0.2)], RATE, -20)
await writeFile(join(cwd, 'stereo.wav'), encodeWav(stereoPair, RATE))

// 5. A file that is not a WAV at all.
await writeFile(join(cwd, 'broken.wav'), Buffer.from('this is not a RIFF/WAVE file', 'utf8'))

const ALL = ['normal.wav', 'clipping.wav', 'silent.wav', 'stereo.wav', 'broken.wav']
const sourceHashes = {}
for (const name of ALL) sourceHashes[name] = await sha256(join(cwd, name))

/* ------------------------------------------------------------- lab context -- */

const registered = new Map()
const ctx = {
  tools: {
    register (definition) {
      registered.set(definition.name, definition)
      return () => {}
    }
  },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
registerBatchTools(ctx)
const exec = { agent: { session: { id: 'batch-test' } } }
const call = (args) => registered.get('audio_batch').execute(args, exec)
const byLabel = (result) => new Map(result.items.map((item) => [item.label, item]))

/** The deterministic part of a batch result: everything but `pool` timing, `text`, paths of the run. */
const comparable = (result) => JSON.stringify({
  action: result.action,
  targetLufs: result.targetLufs,
  ok: result.ok,
  items: result.items,
  summary: result.summary,
  warnings: result.warnings
})

console.log('batch: one call over a cue set — four actions, failure isolation, real concurrency accounting')
console.log(`sample rate ${RATE} Hz, ${cpuCount()} CPUs, ${ALL.length} fixture files\n`)

/* ---------------------------------------------------------------- the tool -- */

console.log('-- tool surface --')
{
  const definition = registered.get('audio_batch')
  check('registers exactly one tool', registered.size === 1 && definition !== undefined, [...registered.keys()].join(','))
  check('tool has execute/presentCall/output', typeof definition.execute === 'function' &&
    typeof definition.presentCall === 'function' && typeof definition.output?.render === 'function')
  check('tool is concurrency safe', definition.isConcurrencySafe === true)
  check('schema is an object with additionalProperties:false',
    definition.parameters.type === 'object' && definition.parameters.additionalProperties === false)
  check('schema exposes exactly the six batch arguments',
    JSON.stringify(Object.keys(definition.parameters.properties).sort()) ===
      JSON.stringify(['action', 'concurrency', 'cues', 'files', 'outDir', 'targetLufs']),
    Object.keys(definition.parameters.properties).join(','))
  check('schema enum lists the four actions',
    JSON.stringify(definition.parameters.properties.action.enum) === JSON.stringify([...BATCH_ACTIONS]),
    JSON.stringify(definition.parameters.properties.action.enum))
  check('presentCall summarises the request', definition.presentCall({ files: ['a.wav'], action: 'master' }).title.includes('master'))
  console.log(`  actions ${BATCH_ACTIONS.join(' / ')} · default target ${BATCH_DEFAULT_TARGET_LUFS} LUFS · outDir ${BATCH_DEFAULT_OUT_DIR} · max concurrency ${BATCH_MAX_CONCURRENCY}`)
}

/* -------------------------------------------------------------- arguments -- */

console.log('\n-- argument validation --')
{
  const auto = resolveConcurrency(undefined)
  console.log(`  ${cpuCount()} CPUs -> auto concurrency ${auto} (1..4), explicit 3 -> ${resolveConcurrency(3)}`)
  check('auto concurrency is within 1..4', auto >= 1 && auto <= 4, String(auto))
  check('auto concurrency follows the CPU count', defaultConcurrency(16) === 4 && defaultConcurrency(8) === 4 &&
    defaultConcurrency(2) === 1 && defaultConcurrency(1) === 1,
    `${defaultConcurrency(16)}/${defaultConcurrency(8)}/${defaultConcurrency(2)}/${defaultConcurrency(1)}`)
  check('explicit concurrency is honoured', resolveConcurrency(3) === 3 && resolveConcurrency('2') === 2)

  for (const invalid of [0, 9, 1.5, -2, 'lots']) {
    let error = null
    try { resolveConcurrency(invalid) } catch (caught) { error = caught }
    check(`concurrency ${JSON.stringify(invalid)} is rejected`, error !== null && /concurrency/.test(error.message), error?.message)
  }

  const deduped = resolveBatchItems(cwd, ['normal.wav', 'normal.wav', './normal.wav'], undefined)
  check('duplicate entries are collapsed', deduped.items.length === 1 && deduped.duplicates === 2,
    `${deduped.items.length}/${deduped.duplicates}`)
  check('paths are resolved absolute', deduped.items[0].path === join(cwd, 'normal.wav'), deduped.items[0].path)
  check('labels are session-relative', deduped.items[0].label === 'normal.wav', deduped.items[0].label)

  const cueItems = resolveBatchItems(cwd, undefined, [{ path: 'normal.wav', at: 1.25 }])
  check('cues keep their planned second', cueItems.items[0].at === 1.25, String(cueItems.items[0].at))

  for (const [label, args, pattern] of [
    ['no files or cues', {}, /files|cues/],
    ['empty lists', { files: [], cues: [] }, /files|cues/],
    ['files and cues together', { files: ['normal.wav'], cues: [{ path: 'normal.wav' }] }, /只能给一个/],
    ['unknown action', { files: ['normal.wav'], action: 'turbo' }, /action/],
    ['non-string path', { files: [42] }, /路径/],
    ['blank path', { files: ['  '] }, /路径/],
    ['cue without a path', { cues: [{ at: 1 }] }, /cues\[0\]/],
    ['negative cue second', { cues: [{ path: 'normal.wav', at: -1 }] }, /at/],
    ['target outside the chain range', { files: ['normal.wav'], action: 'normalize', targetLufs: 5 }, /targetLufs/],
    ['non-numeric target', { files: ['normal.wav'], action: 'normalize', targetLufs: 'loud' }, /targetLufs/],
    ['target on check', { files: ['normal.wav'], action: 'check', targetLufs: -14 }, /targetLufs/],
    ['blank outDir', { files: ['normal.wav'], action: 'normalize', outDir: ' ' }, /outDir/],
    ['concurrency out of range', { files: ['normal.wav'], action: 'normalize', concurrency: 9 }, /concurrency/]
  ]) {
    let error = null
    try { await call(args) } catch (caught) { error = caught }
    check(`${label} is rejected`, error !== null && pattern.test(error.message), error?.message)
  }

  // The module is callable without the tool wrapper (the tool is a router).
  const direct = await runBatch({ cwd, files: ['normal.wav'], action: 'check', concurrency: 1 })
  check('runBatch works without the tool wrapper', direct.ok === true && direct.items.length === 1 && typeof direct.text === 'string')
}

/* ------------------------------------------------------------------ check -- */

console.log('\n-- action check: clipping / silence / peak, nothing written --')
const checkRun = await call({ files: ALL, action: 'check' })
{
  const items = byLabel(checkRun)
  const normal = items.get('normal.wav')
  const clipping = items.get('clipping.wav')
  const silent = items.get('silent.wav')
  const stereo = items.get('stereo.wav')
  const broken = items.get('broken.wav')

  for (const line of checkRun.text.split('\n').slice(0, 2)) console.log(`  ${line}`)
  check('action is check', checkRun.action === 'check')
  check('check does not use a loudness target', checkRun.targetLufs === null, String(checkRun.targetLufs))
  check('check writes nothing', checkRun.outDir === null && (await exists(join(cwd, BATCH_DEFAULT_OUT_DIR))) === false)
  check('all five files are reported, in input order',
    checkRun.items.length === 5 && checkRun.items.map((item) => item.label).join(',') === ALL.join(','),
    checkRun.items.map((item) => item.label).join(','))

  check('the healthy file passes', normal.ok === true && normal.issues.length === 0, JSON.stringify(normal.issues))
  check('the clipped file fails', clipping.ok === false)
  check('the clipped file names the clipping', /削波/.test(clipping.issues[0]?.message ?? ''), JSON.stringify(clipping.issues))
  check('the clipped file counts clipped samples', clipping.metrics.clipping > 0, String(clipping.metrics.clipping))
  check('the silent file fails', silent.ok === false)
  check('the silent file says it is silent', /几乎无声/.test(silent.issues[0]?.message ?? ''), JSON.stringify(silent.issues))
  check('the stereo file passes', stereo.ok === true, JSON.stringify(stereo.issues))
  check('the stereo file reports two channels', stereo.metrics.channels === 2)
  check('the corrupt file is an item error, not a crash', broken.ok === false && /cannot decode|RIFF/i.test(broken.error ?? ''), broken.error)
  check('the corrupt file has no metrics', broken.metrics === null)

  check('summary counts the failures', checkRun.summary.total === 5 && checkRun.summary.ok === 2 && checkRun.summary.failed === 3,
    JSON.stringify({ total: checkRun.summary.total, ok: checkRun.summary.ok, failed: checkRun.summary.failed }))
  check('summary names every failure', checkRun.summary.failures.length === 3 &&
    checkRun.summary.failures.every((entry) => typeof entry.message === 'string' && entry.message.length > 0),
    JSON.stringify(checkRun.summary.failures))
  check('a batch with a failure is not ok', checkRun.ok === false)
  check('one bad file did not stop the others', checkRun.items.filter((item) => item.ok).length === 2)
  check('text carries the verdict and the concurrency line', /批量质检/.test(checkRun.text) && /并发/.test(checkRun.text), checkRun.text)
}

/* --------------------------------------------------------------- loudness -- */

console.log('\n-- action loudness: measure only, compliance flags --')
{
  const result = await call({ files: ALL, action: 'loudness' })
  const items = byLabel(result)
  const normal = items.get('normal.wav')
  const clipping = items.get('clipping.wav')
  const silent = items.get('silent.wav')
  const stereo = items.get('stereo.wav')

  console.log(`  LUFS range ${show(result.summary.lufsMin)}..${show(result.summary.lufsMax)}, worst true peak ${show(result.summary.truePeakMaxDbtp)} dBTP`)
  check('loudness writes nothing', result.outDir === null && (await exists(join(cwd, BATCH_DEFAULT_OUT_DIR))) === false)
  check('no target means no compliance target', result.targetLufs === null)
  check('the healthy file measures its -30 LUFS', Math.abs(normal.metrics.lufs + 30) <= 0.5, String(normal.metrics.lufs))
  check('the stereo file measures its -20 LUFS', Math.abs(stereo.metrics.lufs + 20) <= 0.5, String(stereo.metrics.lufs))
  check('the stereo file reports two channels', stereo.metrics.channels === 2)
  check('the silent file is flagged silent', silent.ok === false && silent.metrics.silent === true)
  check('the clipped file is over the true-peak ceiling', clipping.ok === false &&
    /dBTP/.test(clipping.issues.map((issue) => issue.message).join(' ')), JSON.stringify(clipping.issues))
  check('the corrupt file is an item error', items.get('broken.wav').ok === false)
  check('summary reports a LUFS range', result.summary.lufsMin <= result.summary.lufsMax,
    `${result.summary.lufsMin}/${result.summary.lufsMax}`)
  check('summary reports the worst true peak', result.summary.truePeakMaxDbtp > -1, String(result.summary.truePeakMaxDbtp))
  check('summary counts the silent files', result.summary.silent === 1, String(result.summary.silent))
  check('summary lists the non-compliant files with reasons',
    result.summary.nonCompliant.length === 3 &&
      result.summary.nonCompliant.every((entry) => Array.isArray(entry.reasons) && entry.reasons.length > 0),
    JSON.stringify(result.summary.nonCompliant.map((entry) => entry.label)))
  check('clean files are absent from the non-compliant list',
    !result.summary.nonCompliant.some((entry) => entry.label === 'normal.wav' || entry.label === 'stereo.wav'),
    JSON.stringify(result.summary.nonCompliant.map((entry) => entry.label)))

  // With an explicit target the report judges the distance instead of guessing one.
  const targeted = await call({ files: ['normal.wav'], action: 'loudness', targetLufs: -14 })
  console.log(`  explicit target: ${targeted.items[0].metrics.lufs} LUFS, off target ${targeted.summary.offTarget.length}`)
  check('an explicit target is reported', targeted.targetLufs === -14)
  check('an off-target file is listed', targeted.summary.offTarget.length === 1 &&
    Math.abs(targeted.summary.offTarget[0].deviationLu + 16) <= 1, JSON.stringify(targeted.summary.offTarget))
  check('off target is a warning, not a failure', targeted.items[0].ok === true &&
    targeted.items[0].issues.some((issue) => issue.level === 'warn'), JSON.stringify(targeted.items[0].issues))
}

/* -------------------------------------------------------------- normalize -- */

console.log('\n-- action normalize: a corrected copy per file, sources untouched --')
const normalizeRun = await call({ files: ALL, action: 'normalize' })
{
  const items = byLabel(normalizeRun)
  const normal = items.get('normal.wav')
  const clipping = items.get('clipping.wav')
  const silent = items.get('silent.wav')
  const stereo = items.get('stereo.wav')
  const broken = items.get('broken.wav')
  const outDir = join(cwd, BATCH_DEFAULT_OUT_DIR)

  console.log(`  ${normalizeRun.text.split('\n')[0]}`)
  check('normalize defaults to out/batch', normalizeRun.outDir === outDir, String(normalizeRun.outDir))
  check('three copies are written', normalizeRun.summary.written === 3, String(normalizeRun.summary.written))
  check('two items fail without stopping the batch', normalizeRun.summary.failed === 2 &&
    silent.ok === false && broken.ok === false, String(normalizeRun.summary.failed))
  check('the silent file explains why it was skipped', /静音/.test(silent.error ?? ''), silent.error)
  check('the corrupt file is still an item error', /cannot decode|RIFF/i.test(broken.error ?? ''), broken.error)
  check('a failed item writes no file', (await exists(join(outDir, 'silent-norm.wav'))) === false &&
    (await exists(join(outDir, 'broken-norm.wav'))) === false)

  for (const [name, item] of [['normal', normal], ['clipping', clipping], ['stereo', stereo]]) {
    const written = await decodeFile(join(outDir, `${name}-norm.wav`))
    const lufs = lufsOfChannels(written.channels, written.sampleRate)
    const peak = worstTruePeak(written.channels, written.sampleRate)
    console.log(`  ${name.padEnd(9)} gain ${show(item.gainDb)} dB -> ${show(item.out?.metrics.lufs)} LUFS ` +
      `(file ${show(lufs)}), true peak ${show(peak)} dBTP, ${written.channels.length} ch, ${written.bitDepth}-bit`)
    check(`${name}: a copy is written`, item.out !== null && (await exists(join(outDir, `${name}-norm.wav`))))
    check(`${name}: the copy is reported relative to the session`,
      item.out.label === `${BATCH_DEFAULT_OUT_DIR}/${name}-norm.wav`, item.out.label)
    check(`${name}: the copy lands within 1 LU of -14`, Math.abs(lufs + 14) <= 1, String(lufs))
    check(`${name}: the copy honours the -1 dBTP ceiling`, peak <= -1 + 0.05, String(peak))
    check(`${name}: the copy is 16-bit`, written.bitDepth === 16, String(written.bitDepth))
    check(`${name}: the report matches the file`, Math.abs(item.out.metrics.lufs - lufs) < 1e-6 &&
      item.out.metrics.sampleRate === written.sampleRate, `${item.out.metrics.lufs} vs ${lufs}`)
  }
  check('the stereo copy keeps two channels', (await decodeFile(join(outDir, 'stereo-norm.wav'))).channels.length === 2)
  check('the quiet file was raised', normal.gainDb > 10, String(normal.gainDb))
  check('the hot file was attenuated', clipping.gainDb < -5, String(clipping.gainDb))
  check('every copy is reported as on target',
    normalizeRun.summary.targetHit === 3 && normalizeRun.summary.targetMissed.length === 0,
    JSON.stringify(normalizeRun.summary.targetMissed))
  check('the summary reports the written LUFS range',
    normalizeRun.summary.lufsMin >= -15 && normalizeRun.summary.lufsMax <= -13,
    `${normalizeRun.summary.lufsMin}/${normalizeRun.summary.lufsMax}`)
  check('the summary reports the worst written true peak', normalizeRun.summary.truePeakMaxDbtp <= -1 + 0.05,
    String(normalizeRun.summary.truePeakMaxDbtp))

  // The whole point: a batch writer must not edit its inputs.
  let untouched = true
  for (const name of ALL) if ((await sha256(join(cwd, name))) !== sourceHashes[name]) untouched = false
  check('normalize leaves every source file byte-identical', untouched)
  check('the text names the output directory', normalizeRun.text.includes(BATCH_DEFAULT_OUT_DIR), normalizeRun.text)
}

/* ----------------------------------------------------------------- master -- */

console.log('\n-- action master: the chain per file, outDir override --')
const masterRun = await call({ files: ALL, action: 'master', outDir: 'out/mastered', concurrency: 2 })
{
  const items = byLabel(masterRun)
  const normal = items.get('normal.wav')
  const stereo = items.get('stereo.wav')
  const outDir = join(cwd, 'out', 'mastered')

  console.log(`  ${masterRun.text.split('\n')[0]}`)
  check('master honours outDir', masterRun.outDir === outDir && masterRun.outDirLabel === 'out/mastered',
    `${masterRun.outDir} / ${masterRun.outDirLabel}`)
  check('master writes three copies', masterRun.summary.written === 3, String(masterRun.summary.written))
  check('master reports the chain it ran', Number.isFinite(normal.metrics.limiterGainReductionDb) &&
    Number.isInteger(normal.metrics.iterations) && normal.metrics.iterations >= 1,
    JSON.stringify({ gr: normal.metrics?.limiterGainReductionDb, iterations: normal.metrics?.iterations }))
  check('master reports the applied gain', Number.isFinite(normal.gainDb) && normal.gainDb > 5, String(normal.gainDb))

  for (const [name, item] of [['normal', normal], ['clipping', items.get('clipping.wav')], ['stereo', stereo]]) {
    const written = await decodeFile(join(outDir, `${name}-master.wav`))
    const lufs = lufsOfChannels(written.channels, written.sampleRate)
    const peak = worstTruePeak(written.channels, written.sampleRate)
    console.log(`  ${name.padEnd(9)} ${show(item.metrics?.lufs)} -> ${show(lufs)} LUFS, true peak ${show(peak)} dBTP, ` +
      `gain ${show(item.gainDb)} dB, limiter GR ${show(item.metrics?.limiterGainReductionDb)} dB`)
    check(`${name}: the master lands within 1 LU of -14`, Math.abs(lufs + 14) <= 1, String(lufs))
    check(`${name}: the master honours the -1 dBTP ceiling`, peak <= -1 + 0.05, String(peak))
    check(`${name}: the master is reported on target`, item.targetHit === true, String(item.targetHit))
  }
  check('the stereo master keeps two channels', (await decodeFile(join(outDir, 'stereo-master.wav'))).channels.length === 2)
  check('the unreadable and silent files still fail alone',
    items.get('broken.wav').ok === false && items.get('silent.wav').ok === false)
  check('master leaves every source file byte-identical',
    (await Promise.all(ALL.map(async (name) => (await sha256(join(cwd, name))) === sourceHashes[name]))).every(Boolean))
}

/* ------------------------------------------------------ output name safety -- */

console.log('\n-- an output that would overwrite an input is refused --')
{
  const inputs = join(cwd, 'inputs')
  await mkdir(inputs, { recursive: true })
  await writeFile(join(inputs, 'pre2.wav'), encodeWav([healthy], RATE))
  await writeFile(join(inputs, 'pre2-norm.wav'), encodeWav([sine(1, 440, 0.2)], RATE))
  const collidedBefore = await sha256(join(inputs, 'pre2-norm.wav'))

  // `pre2.wav` normalises to `pre2-norm.wav` — which is another input here.
  const result = await call({ files: ['inputs/pre2.wav', 'inputs/pre2-norm.wav'], action: 'normalize', outDir: 'inputs' })
  const items = byLabel(result)
  const collision = items.get('inputs/pre2.wav')
  const survivor = items.get('inputs/pre2-norm.wav')
  console.log(`  collision: ${collision.error}`)
  check('the colliding item fails instead of writing', collision.ok === false && collision.out === null)
  check('the error names the refused overwrite', /拒绝覆盖输入/.test(collision.error ?? ''), collision.error)
  check('the pre-existing input is byte-identical', (await sha256(join(inputs, 'pre2-norm.wav'))) === collidedBefore)
  check('the other file in the same call still runs', survivor.ok === true && (await exists(join(inputs, 'pre2-norm-norm.wav'))),
    JSON.stringify(survivor.error))
  check('the batch reports the refusal as a failure', result.ok === false && result.summary.failed === 1,
    JSON.stringify(result.summary.failures))
}

/* ------------------------------------------------------------- concurrency -- */

console.log('\n-- concurrency: at most N files in flight, and it is measured --')
{
  // An independent counter proves the pool's own instrumentation: the worker
  // overlaps only while it waits, which is exactly what the pool reports.
  let inFlight = 0
  let observed = 0
  const pooled = await runPool([0, 1, 2, 3, 4, 5, 6], 2, async (value) => {
    inFlight += 1
    if (inFlight > observed) observed = inFlight
    await new Promise((resolve) => setTimeout(resolve, 4))
    inFlight -= 1
    return value * 10
  })
  console.log(`  async worker, limit 2: pool says ${pooled.maxInFlight}, worker counter says ${observed}, lanes ${pooled.lanes}`)
  check('an async worker never exceeds the limit', pooled.maxInFlight === 2 && observed === 2, `${pooled.maxInFlight}/${observed}`)
  check('the pool measures what the worker sees', pooled.maxInFlight === observed)
  check('results keep the input order',
    JSON.stringify(pooled.results) === JSON.stringify([0, 10, 20, 30, 40, 50, 60]), JSON.stringify(pooled.results))
  check('seven items use two lanes, not seven', pooled.lanes === 2, String(pooled.lanes))

  const serial = await runPool([0, 1, 2, 3], 4, (value) => value + 1)
  console.log(`  synchronous worker, limit 4: measured in flight ${serial.maxInFlight} (CPU is serial)`)
  check('a synchronous worker reports one item in flight', serial.maxInFlight === 1, String(serial.maxInFlight))
  check('a synchronous worker still returns every result', JSON.stringify(serial.results) === '[1,2,3,4]')

  const one = await runPool([0, 1, 2], 1, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return value
  })
  check('limit 1 allows no overlap', one.maxInFlight === 1 && one.lanes === 1, `${one.maxInFlight}/${one.lanes}`)

  const all = await runPool([0, 1, 2], 99, async (value) => value)
  check('lanes never exceed the item count', all.lanes === 3, String(all.lanes))

  // Through the real batch: the reported figures obey the requested limit.
  const serialRun = await call({ files: ALL, action: 'check', concurrency: 1 })
  const parallelRun = await call({ files: ALL, action: 'check', concurrency: 4 })
  console.log(`  batch check: concurrency 1 -> maxInFlight ${serialRun.pool.maxInFlight}; ` +
    `concurrency 4 -> maxInFlight ${parallelRun.pool.maxInFlight}, lanes ${parallelRun.pool.lanes}`)
  check('the batch runs serially at concurrency 1', serialRun.pool.limit === 1 && serialRun.pool.maxInFlight === 1,
    `${serialRun.pool.limit}/${serialRun.pool.maxInFlight}`)
  check('the batch never exceeds the requested limit', parallelRun.pool.limit === 4 &&
    parallelRun.pool.maxInFlight <= 4 && parallelRun.pool.maxInFlight >= 1, String(parallelRun.pool.maxInFlight))
  check('the report states the CPU is serial',
    /CPU/.test(parallelRun.pool.note) && parallelRun.pool.cpuBound === 'serial' && parallelRun.pool.cpuCount >= 1,
    parallelRun.pool.note)
  check('the text repeats the concurrency accounting', /上限 4/.test(parallelRun.text) && /同时在飞/.test(parallelRun.text),
    parallelRun.text)
}

/* ------------------------------------------------------------- determinism -- */

console.log('\n-- determinism: same inputs, same items, same bytes --')
{
  const first = await call({ files: ['normal.wav', 'stereo.wav', 'clipping.wav'], action: 'normalize', outDir: 'out/repeat' })
  const firstBytes = new Map()
  for (const item of first.items) firstBytes.set(item.label, await readFile(item.out.path))
  const second = await call({ files: ['normal.wav', 'stereo.wav', 'clipping.wav'], action: 'normalize', outDir: 'out/repeat' })

  const sameBytes = (await Promise.all(first.items.map(async (item) => {
    const written = await readFile(item.out.path)
    return written.equals(firstBytes.get(item.label))
  }))).every(Boolean)
  console.log(`  items+summary identical: ${comparable(first) === comparable(second)}, bytes identical: ${sameBytes}`)
  check('two runs report identical items and summary', comparable(first) === comparable(second))
  check('two runs write identical bytes', sameBytes)
  check('the copy counts stay put', first.summary.written === second.summary.written &&
    first.summary.targetHit === second.summary.targetHit)
  // The pool fields are observational (I/O timing); they must not leak into the
  // deterministic part of the report.
  check('pool timing is not part of the item report',
    !JSON.stringify(first.items).includes('maxInFlight') && !JSON.stringify(first.summary).includes('maxInFlight'))
}

/* ------------------------------------------------------------ text output -- */

console.log('\n-- human text --')
{
  const result = await call({ files: ['normal.wav', 'silent.wav'], action: 'loudness' })
  const text = result.text
  for (const line of text.split('\n')) console.log(`  ${line}`)
  check('text is a bounded summary, not JSON', typeof text === 'string' && !text.startsWith('{'))
  check('text reports totals', /2 个文件/.test(text) && /成功 1/.test(text) && /失败 1/.test(text), text.split('\n')[0])
  check('text lists per-file lines', /normal\.wav/.test(text) && /silent\.wav/.test(text))
  check('text explains the failure', /静音/.test(text), text)
  check('text states the CPU serial fact', /CPU/.test(text), text)
  check('text ends with the concurrency line', /并发：/.test(text.split('\n').at(-1) ?? ''), text.split('\n').at(-1))
}

/* ---------------------------------------------------------------- summary -- */

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0
  ? `\nOK: batch operations hold their promises (${checks} checks)`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
