/**
 * Tests for lib/bind.js, lib/regress.js and lib/tools-bind.js.
 *
 * The interesting part is the generated player: it is executed in a mocked
 * browser with a controllable AudioContext clock, so scheduling, look-ahead,
 * loop protection, rapid re-triggering, pause/visibility and replay are
 * verified by observing `source.start(when)` timestamps instead of trusting
 * the source text.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAYER_TIMING, buildCueSheet, cueScheduleDrift, inlineAudio } from '../lib/bind.js'
import { compare, compareMetrics, snapshot } from '../lib/regress.js'
import { registerBindTools } from '../lib/tools-bind.js'
import { finalize, renderPreset } from '../lib/audio.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

// Private scratch dir: `test/out/` is shared with other workers' tests, so
// never clear the whole tree.
const outDir = new URL('./out/bind/', import.meta.url)
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

function wavBytes (preset, { params = {}, duration, seed = 1, sampleRate = 22050 } = {}) {
  const rendered = renderPreset({ preset, params, duration, seed, sampleRate })
  finalize(rendered.samples, rendered.sampleRate)
  return encodeWav([rendered.samples], rendered.sampleRate, { dither: false })
}

const tmp = await mkdtemp(join(tmpdir(), 'dsh-audio-bind-'))

/* ------------------------------------------------------------- cue sheet -- */

console.log('-- buildCueSheet --')
{
  const sheet = buildCueSheet({
    cues: [
      { name: 'ding', at: 1.6, src: 'ding.wav', gainDb: -3, fadeIn: 0.02 },
      { name: 'slam', at: 0.35, src: '/abs/slam.wav' },
      { name: 'bed', at: 0, src: 'texture.wav', loop: true, fadeOut: 0.4 }
    ],
    duration: 4,
    basePath: 'assets/audio/'
  })
  const data = JSON.parse(sheet.json)
  console.log(`  ${sheet.cues.length} cues, sorted: ${sheet.cues.map((c) => `${c.name}@${c.at}`).join(', ')}`)
  console.log(`  script ${sheet.script.length} B for one URL cue, json ${sheet.json.length} B`)
  check('cues are sorted by at', sheet.cues.map((c) => c.name).join(',') === 'bed,slam,ding')
  check('basePath prefixes relative sources', sheet.cues[2].src === 'assets/audio/ding.wav', sheet.cues[2].src)
  check('absolute src untouched', sheet.cues[1].src === '/abs/slam.wav', sheet.cues[1].src)
  check('json round-trips', JSON.stringify(data.cues) === JSON.stringify(sheet.cues))
  check('duration kept', data.duration === 4)
  check('gain rounded', sheet.cues[2].gainDb === -3)
  check('fade kept', sheet.cues[2].fadeIn === 0.02)
  check('loop flag kept', sheet.cues[0].loop === true)

  let duplicate = false
  try { buildCueSheet({ cues: [{ name: 'a', at: 0, src: 'a.wav' }, { name: 'a', at: 1, src: 'b.wav' }] }) } catch { duplicate = true }
  check('duplicate names refused', duplicate)

  let tooShort = false
  try { buildCueSheet({ cues: [{ name: 'a', at: 2, src: 'a.wav' }], duration: 1 }) } catch { tooShort = true }
  check('duration before last cue refused', tooShort)

  let badAt = false
  try { buildCueSheet({ cues: [{ name: 'a', at: -1, src: 'a.wav' }] }) } catch { badAt = true }
  check('negative at refused', badAt)

  // The player source itself is the deliverable, so measure it without audio data.
  const bare = buildCueSheet({ cues: [{ name: 'a', at: 1.234, src: 'a.wav' }], duration: 2 })
  const dataChars = JSON.stringify({ duration: 2, cues: bare.cues }).length
  const playerChars = bare.script.length - dataChars
  console.log(`  player code ${playerChars} B (excluding ${dataChars} B of cue data)`)
  check('player code is small', playerChars < 5632, `${playerChars} B`)
  check('cue time survives into the script verbatim', bare.script.includes('"at":1.234'))
  check('script is an IIFE', /^\s*\/\*[\s\S]*?\*\/\s*\(\(\)\s*=>/.test(bare.script))
  check('script parses', (() => { try { new Function(bare.script); return true } catch { return false } })())
  check('script has no eval', !/\beval\s*\(/.test(bare.script))
  check('script has no new Function', !/new\s+Function/.test(bare.script))
  check('script has no document.write', !/document\.write/.test(bare.script))
  check('script exposes the API', ['play', 'stop', 'stopAll', 'pause', 'resume', 'setMuted', 'currentTime']
    .every((method) => bare.script.includes(`${method}`)))
  check('timing tokens were replaced', !/__[A-Z]+__/.test(bare.script))
}

/* --------------------------------------------------------- drift budget -- */

console.log('-- cueScheduleDrift --')
{
  const drift = cueScheduleDrift([{ name: 'hit', at: 1.234 }, { name: 'tail', at: 2.10001 }], 48000)
  const row = drift.cues[0]
  console.log(`  cue "hit" at 1.234 s: ${row.at} * 48000 = ${row.exactFrames} frames -> start frame ${row.frame}, error ${row.errorSamples} sample(s)`)
  console.log(`  budget: ${drift.math}`)
  console.log(`  worst cue ${drift.worstCue.name} (${drift.worstCue.at}s) error ${drift.worstCue.errorSamples} samples = ${drift.worstCue.errorMs} ms`)
  console.log(`  lookahead ${drift.lookahead.aheadSeconds}s > wake ${drift.lookahead.wakeSeconds}s -> ${drift.lookahead.marginSeconds}s slack, timer can shift cue: ${drift.lookahead.timerCanShiftCue}`)
  check('1.234 s is 59232 whole frames', row.exactFrames === 59232 && row.frame === 59232)
  check('1.234 s has zero sample error', row.errorSamples === 0, String(row.errorSamples))
  check('budget is at most 1 sample', drift.worstCaseSamples <= 1, String(drift.worstCaseSamples))
  check('budget is at least 1 sample', drift.worstCaseSamples >= 1)
  check('non-integer cue stays under half a sample', drift.worstCue.errorSamples <= 0.5, String(drift.worstCue.errorSamples))
  check('lookahead window leaves slack', drift.lookahead.aheadSeconds > drift.lookahead.wakeSeconds)
  check('one sample is small in ms', drift.worstCaseMs < 0.03, `${drift.worstCaseMs} ms`)
  check('48 kHz sample length', drift.sampleMs === 0.020833, String(drift.sampleMs))
}

/* ---------------------------------------------------------------- inline -- */

console.log('-- inlineAudio --')
const sourceBytes = wavBytes('impact', { params: { weight: 0.8 }, duration: 0.4, seed: 5 })
const sourcePath = join(tmp, 'slam.wav')
await writeFile(sourcePath, sourceBytes)
{
  const inlined = await inlineAudio({ entries: [{ name: 'slam', path: sourcePath }], maxBytes: 1024 * 1024 })
  const entry = inlined.entries[0]
  const prefix = 'data:audio/wav;base64,'
  const decoded = Buffer.from(entry.src.slice(prefix.length), 'base64')
  console.log(`  ${sourceBytes.length} raw B -> ${entry.src.length} data-URI B (${inlined.totalBytes} total page weight)`)
  check('data URI prefix', entry.src.startsWith(prefix))
  check('base64 decodes to the exact file bytes', decoded.equals(sourceBytes))
  check('raw byte count reported', inlined.rawBytes === sourceBytes.length, String(inlined.rawBytes))
  check('page weight is the data URI length', inlined.totalBytes === entry.src.length, String(inlined.totalBytes))
  check('page weight is 4/3 of raw plus prefix',
    inlined.totalBytes === Math.ceil(sourceBytes.length / 3) * 4 + prefix.length, String(inlined.totalBytes))

  let refused = null
  try {
    await inlineAudio({ entries: [{ name: 'slam', path: sourcePath }], maxBytes: 100 })
  } catch (error) {
    refused = error
  }
  console.log(`  refusal: ${refused?.code}: ${refused?.message}`)
  check('over-budget inline is refused', refused !== null && refused.code === 'AUDIO_TOO_LARGE')
  check('refusal is polite and actionable', /budget/.test(refused?.message ?? '') && /sampleRate|maxBytes|Shorten/.test(refused?.message ?? ''))
  check('refusal reports both sizes', refused?.totalBytes > 100 && refused?.maxBytes === 100)

  let notWav = null
  try { await inlineAudio({ entries: [{ name: 'x', bytes: Buffer.from('not a wav') }] }) } catch (error) { notWav = error }
  check('non-wav entry refused', notWav !== null && /RIFF\/WAVE/.test(notWav.message))
}

/* --------------------------------------------------------------- regress -- */

console.log('-- snapshot determinism --')
const specs = [
  { name: 'slam', preset: 'impact', params: { weight: 0.8, hardness: 0.5 }, duration: 0.6, seed: 7 },
  { name: 'blip', preset: 'tick', params: { hardness: 0.5 }, duration: 0.05, seed: 3 },
  { name: 'swoosh', preset: 'whoosh', params: { tone: 0.6 }, duration: 0.5, seed: 9 }
]
const first = snapshot(specs, { label: 'baseline-v1' })
const second = snapshot(specs, { label: 'baseline-v1' })
console.log(`  engine v${first.engine}, ${first.specs.length} specs, note "${first.createdAtNote}"`)
for (const spec of first.specs) {
  const m = spec.metrics
  console.log(`  ${spec.name.padEnd(8)} ${m.durationSeconds}s  peak ${m.peakDbfs}  rms ${m.rmsDbfs}  crest ${m.crestDb}  centroid ${m.centroidHz}  onsets ${m.onsets}  sha ${spec.sha256.slice(0, 12)}`)
}
check('snapshot is deterministic', JSON.stringify(first) === JSON.stringify(second))
check('hashes are stable', first.specs.every((spec, index) => spec.sha256 === second.specs[index].sha256))
check('no timestamps in snapshot data', !/20\d\d-\d\d-\d\dT/.test(JSON.stringify(first)))
check('label is stored as createdAtNote', first.createdAtNote === 'baseline-v1')
check('hash is a full sha256', first.specs.every((spec) => /^[0-9a-f]{64}$/.test(spec.sha256)))

console.log('-- compare: identical -> PASS --')
const identical = compare(first, second)
console.log(`  pass=${identical.pass} rows=${identical.rows.length} failures=${identical.failures.length}`)
check('identical snapshots pass', identical.pass === true)
check('every row passes', identical.rows.every((row) => row.status === 'pass'))
check('row set covers every metric', identical.rows.length === specs.length * 7, String(identical.rows.length))

console.log('-- compare: changed hardness -> FAIL, named --')
// tick's `hardness` controls the decay: the changed take is quieter and more
// click-like, so rms/crest are the metric rows that have to move. Impact's
// hardness only colours its transient, which the normalised metrics barely
// see — the sha256 row is what catches that change.
const changed = specs.map((spec) => spec.name === 'blip'
  ? { ...spec, params: { ...spec.params, hardness: 0.95 } }
  : spec)
const broken = compare(first, snapshot(changed, { label: 'baseline-v1' }))
console.log(`  pass=${broken.pass}, ${broken.failures.length} failing row(s):`)
for (const row of broken.failures) {
  console.log(`    ${row.name} ${row.metric}: ${row.baseline} -> ${row.current} (delta ${row.delta}, tol ${row.tolerance}) FAIL`)
}
check('changed sound fails the gate', broken.pass === false)
check('failing rows name the changed spec', broken.failures.every((row) => row.name === 'blip'), JSON.stringify(broken.failures.map((r) => r.name)))
check('expected metric row (rmsDbfs) is reported', broken.failures.some((row) => row.name === 'blip' && row.metric === 'rmsDbfs'))
check('byte hash row is reported', broken.failures.some((row) => row.name === 'blip' && row.metric === 'sha256'))
check('untouched specs keep passing', broken.rows.filter((row) => row.name !== 'blip').every((row) => row.status === 'pass'))

console.log('-- tolerance logic (0.4 dB passes, 0.6 dB fails) --')
const metricBase = { name: 'mix', peakDbfs: -1, rmsDbfs: -20, crestDb: 12, centroidHz: 1000, durationSeconds: 1, onsets: 2 }
const near = { ...metricBase, peakDbfs: -1.4 }
const far = { ...metricBase, peakDbfs: -1.6 }
const nearResult = compareMetrics(metricBase, near)
const farResult = compareMetrics(metricBase, far)
const peakNear = nearResult.rows.find((row) => row.metric === 'peakDbfs')
const peakFar = farResult.rows.find((row) => row.metric === 'peakDbfs')
console.log(`  -1.0 -> -1.4 dB: delta ${peakNear.delta} tol ${peakNear.tolerance} -> ${peakNear.status}`)
console.log(`  -1.0 -> -1.6 dB: delta ${peakFar.delta} tol ${peakFar.tolerance} -> ${peakFar.status}`)
check('0.4 dB change passes', nearResult.pass === true && peakNear.status === 'pass')
check('0.6 dB change fails', farResult.pass === false && peakFar.status === 'fail')
check('failure is only the peak row', farResult.failures.length === 1 && farResult.failures[0].metric === 'peakDbfs')
const shaA = 'a'.repeat(64)
const shaB = { ...metricBase, sha256: 'b'.repeat(64) }
check('sha change fails under strictBytes', compareMetrics({ ...metricBase, sha256: shaA }, shaB).pass === false)
check('sha ignored when strictBytes is off', compareMetrics({ ...metricBase, sha256: shaA }, shaB, { strictBytes: false }).pass === true)
check('centroid uses the 8 % band', compareMetrics(metricBase, { ...metricBase, centroidHz: 1085 }).pass === false)
check('centroid inside the 8 % band passes', compareMetrics(metricBase, { ...metricBase, centroidHz: 1070 }).pass === true)
check('missing metric fails rather than hiding', compareMetrics(metricBase, { ...metricBase, rmsDbfs: undefined }).pass === false)

/* ------------------------------------------------------- audio_regress -- */

console.log('-- audio_regress tool --')
const cwd = join(tmp, 'workspace')
await mkdir(cwd, { recursive: true })
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }
registerBindTools(ctx)
const call = (name, args) => registered.get(name).execute(args, exec)

check('both tools registered', registered.has('audio_bind') && registered.has('audio_regress'), [...registered.keys()].join(','))

{
  const snapArgs = { action: 'snapshot', specs, baselinePath: 'baselines/mix.json', label: 'v1' }
  const snap1 = await call('audio_regress', snapArgs)
  const bytes1 = await readFile(join(cwd, 'baselines/mix.json'))
  const snap2 = await call('audio_regress', snapArgs)
  const bytes2 = await readFile(join(cwd, 'baselines/mix.json'))
  console.log(`  snapshot: ${snap1.specs} spec(s), ${snap1.bytes} B, engine v${snap1.engine}`)
  console.log(`  snapshot text:\n${snap1.text.split('\n').map((line) => `    ${line}`).join('\n')}`)
  check('baseline file written', snap1.ok === true && snap1.relativePath === 'baselines/mix.json', snap1.relativePath)
  check('baseline bytes are reproducible', bytes1.equals(bytes2))

  const passResult = await call('audio_regress', { action: 'compare', specs, baselinePath: 'baselines/mix.json' })
  console.log(`  compare identical: pass=${passResult.pass} failing=${passResult.failing}`)
  check('compare identical passes', passResult.pass === true && passResult.failing === 0)
  check('compare text starts with PASS', passResult.text.startsWith('PASS'), passResult.text.split('\n')[0])
  check('compare table has all rows', passResult.rows.length === specs.length * 7, String(passResult.rows.length))

  const failResult = await call('audio_regress', { action: 'compare', specs: changed, baselinePath: 'baselines/mix.json' })
  console.log(`  compare changed: pass=${failResult.pass} failing=${failResult.failing}`)
  const failText = failResult.text.split('\n')
  console.log(failText.slice(0, 14).join('\n'))
  check('compare changed fails', failResult.pass === false && failResult.failing > 0)
  check('text starts with FAIL', failResult.text.startsWith('FAIL'), failText[0])
  check('text names the spec and metric', /blip/.test(failResult.text) && /rmsDbfs/.test(failResult.text))
  check('failures carry spec names', failResult.failures.every((row) => row.name === 'blip'))
  check('default tolerances reported', failResult.tolerances.peakDbfs === 0.5 && failResult.tolerances.centroidPct === 8)

  let missing = null
  try { await call('audio_regress', { action: 'compare', specs, baselinePath: 'baselines/nope.json' }) } catch (error) { missing = error }
  check('missing baseline gives a clear error', missing !== null && /run action=snapshot/.test(missing.message), missing?.message)
}

/* ---------------------------------------------------------- audio_bind -- */

console.log('-- audio_bind tool --')
{
  const audioDir = join(cwd, 'assets', 'audio')
  await mkdir(audioDir, { recursive: true })
  await writeFile(join(audioDir, 'slam.wav'), wavBytes('impact', { params: { weight: 0.9 }, duration: 0.35, seed: 2 }))
  await writeFile(join(audioDir, 'ding.wav'), wavBytes('chime', { params: { pitch: 0.7 }, duration: 0.3, seed: 4 }))

  const cues = [
    { name: 'slam', at: 0.35, path: 'assets/audio/slam.wav' },
    { name: 'ding', at: 1.6, path: 'assets/audio/ding.wav', gainDb: -3 }
  ]
  const external = await call('audio_bind', { cues, out: 'player/cues', sampleRate: 48000 })
  console.log(external.text)
  const jsText = await readFile(join(cwd, 'player/cues.js'), 'utf8')
  const jsonText = JSON.parse(await readFile(join(cwd, 'player/cues.json'), 'utf8'))
  check('audio_bind writes both files', external.ok === true && external.relativeJsPath === 'player/cues.js' && external.relativeJsonPath === 'player/cues.json')
  check('external script parses', (() => { try { new Function(jsText); return true } catch { return false } })())
  check('external src is a relative path', jsonText.cues[0].src === 'assets/audio/slam.wav', jsonText.cues[0].src)
  check('json has both cues', jsonText.cues.length === 2)
  check('duration covers the last wav', Math.abs(jsonText.duration - 1.9) < 0.001, String(jsonText.duration))
  check('text quotes the drift budget', /drift budget/.test(external.text))
  check('text lists the first cues', /0\.350s slam/.test(external.text) && /1\.600s ding/.test(external.text))

  const inlined = await call('audio_bind', { cues, out: 'player/inline-cues', inline: true })
  console.log(inlined.text)
  const inlineJs = await readFile(join(cwd, 'player/inline-cues.js'), 'utf8')
  const inlineJson = JSON.parse(await readFile(join(cwd, 'player/inline-cues.json'), 'utf8'))
  check('inline script contains data URIs', (inlineJs.match(/data:audio\/wav;base64,/g) ?? []).length === 2)
  check('inline json contains data URIs', inlineJson.cues.every((cue) => cue.src.startsWith('data:audio/wav;base64,')))
  check('inline page weight reported', inlined.pageWeightBytes > inlined.jsBytes, `${inlined.pageWeightBytes} vs ${inlined.jsBytes}`)
  check('inline script parses', (() => { try { new Function(inlineJs); return true } catch { return false } })())
  check('inline text reports page weight', /page weight/.test(inlined.text))

  const refused = await call('audio_bind', { cues, out: 'player/too-big', inline: true, maxBytes: 100 })
  console.log(`  ${refused.text}`)
  check('inline over budget is refused, not written', refused.ok === false && refused.refused === true && /Refused/.test(refused.text))
}

/* --------------------------------------- generated player, mocked browser -- */

console.log('-- generated player in a mocked browser --')
{
  // Four cues, all inline: this is exactly the single-file shape a page gets.
  const inline = await inlineAudio({
    entries: [
      { name: 'slam', bytes: wavBytes('impact', { params: { weight: 0.9 }, duration: 0.3, seed: 2 }) },
      { name: 'ding', bytes: wavBytes('chime', { params: { pitch: 0.7 }, duration: 0.3, seed: 4 }) },
      { name: 'bed', bytes: wavBytes('texture', { params: { kind: 'room', density: 0.3 }, duration: 0.5, seed: 6, loop: true }) },
      { name: 'tail', bytes: wavBytes('chime', { params: { pitch: 0.4 }, duration: 0.3, seed: 8 }) }
    ]
  })
  const src = new Map(inline.entries.map((entry) => [entry.name, entry.src]))
  const sheet = buildCueSheet({
    cues: [
      { name: 'slam', at: 0.25, src: src.get('slam') },
      { name: 'bed', at: 0.5, src: src.get('bed'), loop: true, fadeOut: 0.2 },
      { name: 'ding', at: 1.234, src: src.get('ding') },
      { name: 'tail', at: 2, src: src.get('tail') },
      // A bare-base64 `data:` cue (no src at all) is the documented alternative shape.
      { name: 'raw', at: 0.1, data: Buffer.from(wavBytes('zap', { duration: 0.2, seed: 3 })).toString('base64') }
    ],
    duration: 3
  })

  const clock = { t: 0 }
  const timers = new Map()
  let timerId = 0
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerId
    timers.set(id, { fn, due: clock.t + Math.max(0, Number(ms) || 0) / 1000 })
    return id
  }
  const clearTimeoutMock = (id) => { timers.delete(id) }
  async function advance (seconds) {
    const target = clock.t + seconds
    for (;;) {
      let dueId = null
      let dueTimer = null
      for (const [id, timer] of timers) {
        if (timer.due <= target && (dueTimer === null || timer.due < dueTimer.due)) {
          dueId = id
          dueTimer = timer
        }
      }
      if (dueTimer === null) break
      timers.delete(dueId)
      clock.t = Math.max(clock.t, dueTimer.due)
      dueTimer.fn()
      // Let the player's decode/schedule promise chain run before time moves on.
      await Promise.resolve()
      await Promise.resolve()
    }
    clock.t = target
    await Promise.resolve()
    await Promise.resolve()
  }

  const sources = []
  const gains = []
  const contexts = []
  class MockGain {
    constructor () {
      this.gain = {
        value: 1,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        setTargetAtTime: () => {},
        cancelScheduledValues: () => {}
      }
      gains.push(this)
    }

    connect (node) { return node }

    disconnect () {}
  }
  class MockSource {
    constructor () {
      this.buffer = null
      this.loop = false
      this.startedAt = null
      this.stoppedAt = null
      this.onended = null
    }

    connect (node) { return node }

    start (when) {
      if (this.startedAt !== null) throw new Error('mock source started twice')
      this.startedAt = when
      sources.push(this)
    }

    stop (when) { this.stoppedAt = when }
  }
  class MockCompressor {
    constructor () {
      this.threshold = { value: 0 }
      this.ratio = { value: 1 }
      this.attack = { value: 0 }
    }

    connect (node) { return node }
  }
  class MockAudioContext {
    constructor () {
      this.state = 'running'
      this.destination = {}
      this.sampleRate = 48000
      this.skew = 0
      this.pausedAt = 0
      contexts.push(this)
    }

    // Mirrors a real context: currentTime freezes while suspended.
    get currentTime () { return (this.state === 'suspended' ? this.pausedAt : clock.t) - this.skew }

    createGain () { return new MockGain() }

    createDynamicsCompressor () { return new MockCompressor() }

    createBufferSource () { return new MockSource() }

    async resume () {
      if (this.state === 'suspended') this.skew += clock.t - this.pausedAt
      this.state = 'running'
    }

    async suspend () {
      if (this.state === 'running') {
        this.state = 'suspended'
        this.pausedAt = clock.t
      }
    }

    async decodeAudioData (bytes) {
      const decoded = decodeWav(Buffer.from(bytes))
      return { duration: decoded.durationSeconds, sampleRate: decoded.sampleRate }
    }
  }

  const events = []
  const doc = {
    hidden: false,
    handlers: [],
    addEventListener (type, fn) { if (type === 'visibilitychange') this.handlers.push(fn) },
    fire () { for (const fn of this.handlers) fn() }
  }
  const win = {
    AudioContext: MockAudioContext,
    dispatchEvent (event) { events.push(event.type); return true }
  }
  let fetchCalls = 0
  const fetchMock = () => { fetchCalls += 1; return Promise.reject(new Error('network is not allowed here')) }
  const factory = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'atob', 'console', sheet.script)
  factory(win, doc, fetchMock, setTimeoutMock, clearTimeoutMock, atob, { warn () {} })

  const audio = win.dshAudio
  const context = contexts[0]
  check('player installed window.dshAudio', audio !== null && typeof audio === 'object')
  const api = ['play', 'stop', 'stopAll', 'pause', 'resume', 'setMuted', 'currentTime']
  check('player API complete', api.every((method) => typeof audio[method] === 'function'), api.join(','))

  const started = await audio.resume()
  const t0 = PLAYER_TIMING.leadSeconds
  check('resume unlocks and starts', started === true)
  check('start event fired', events.includes('dshaudio:start'))
  check('inline audio never fetched', fetchCalls === 0)
  check('currentTime is negative during the lead', audio.currentTime() < 0 && audio.currentTime() >= -PLAYER_TIMING.leadSeconds - 1e-9)

  const slamSource = sources.find((source) => source.startedAt === t0 + 0.25)
  check('first cue scheduled at t0 + at', slamSource !== undefined, sources.map((s) => s.startedAt).join(','))
  const rawSource = sources.find((source) => source.startedAt === t0 + 0.1)
  check('bare-base64 cue scheduled with no fetch', rawSource !== undefined && fetchCalls === 0, sources.map((s) => s.startedAt).join(','))
  if (slamSource !== undefined) {
    const errorSamples = Math.abs(slamSource.startedAt - (t0 + 0.25)) * 48000
    console.log(`  cue slam @0.25 s started at ${slamSource.startedAt.toFixed(6)} s (expected ${(t0 + 0.25).toFixed(6)}), error ${errorSamples} sample(s)`)
    check('first cue error under one sample', errorSamples < 1)
  }

  // Look-ahead: the 1.234 s cue is outside the first window and must be placed
  // when the scheduler wakes, still at exactly t0 + 1.234.
  await advance(1.0)
  const dingSource = sources.find((source) => Math.abs((source.startedAt ?? 0) - (t0 + 1.234)) < 1e-12)
  console.log(`  after advancing 1.0 s: ${sources.length} source(s) placed`)
  check('far cue scheduled by the look-ahead wake-up', dingSource !== undefined, sources.map((s) => s.startedAt).join(','))
  if (dingSource !== undefined) {
    const errorSamples = Math.abs(dingSource.startedAt - (t0 + 1.234)) * 48000
    console.log(`  cue ding @1.234 s started at ${dingSource.startedAt.toFixed(6)} s, error ${errorSamples} sample(s) -> ${errorSamples < 1 ? 'within 1 sample' : 'TOO LATE'}`)
    check('1.234 s cue within one sample', errorSamples < 1)
    check('1.234 s cue is sample-aligned', Math.abs((dingSource.startedAt * 48000) - Math.round(dingSource.startedAt * 48000)) < 1e-9)
  }

  const loopSource = sources.find((source) => source.loop === true)
  check('loop bed scheduled with loop flag', loopSource !== undefined)
  check('loop bed is stopped at the timeline end', loopSource !== undefined && Math.abs(loopSource.stoppedAt - (t0 + 3)) < 1e-12,
    String(loopSource?.stoppedAt))

  // Double-start protection for loops: both the timeline loop and play() agree.
  const secondPlay = await audio.play('bed')
  check('loop refuses to double-start', secondPlay === false)

  const beforeRapid = sources.length
  const rapid = await Promise.all([audio.play('slam'), audio.play('slam'), audio.play('slam')])
  check('rapid one-shot re-trigger all start', rapid.every((value) => value === true), JSON.stringify(rapid))
  check('rapid re-trigger is polyphonic', sources.length === beforeRapid + 3, `${sources.length - beforeRapid}`)
  check('re-triggered hits land on the audio clock', sources.slice(beforeRapid).every((source) => Math.abs(source.startedAt - (context.currentTime + PLAYER_TIMING.lateSeconds)) < 1e-12))

  audio.stop('slam')
  check('stop(name) silences all voices of that cue', sources.filter((source) => source.stoppedAt !== null).length >= 3)

  check('unknown cue returns false', (await audio.play('nope')) === false)
  check('setMuted(true) zeroes the master gain', audio.setMuted(true) === true && gains[0].gain.value === 0)
  check('setMuted(false) restores it', audio.setMuted(false) === false && gains[0].gain.value === 1)

  // Pause: the audio clock must freeze, and resume must continue from there.
  const beforePause = audio.currentTime()
  const pauseResult = await audio.pause()
  check('pause suspends the context', pauseResult === true && context.state === 'suspended')
  await advance(0.5)
  check('currentTime freezes while paused', Math.abs(audio.currentTime() - beforePause) < 1e-9, `${audio.currentTime()} vs ${beforePause}`)
  check('resume after pause unlocks again', (await audio.resume()) === true && context.state === 'running')
  await advance(0.2)
  check('clock continues after resume', Math.abs(audio.currentTime() - (beforePause + 0.2)) < 1e-9, String(audio.currentTime()))

  // Visibility: hidden pauses; visible resumes (only if the page did not pause itself).
  doc.hidden = true
  doc.fire()
  check('visibilitychange to hidden suspends the clock', context.state === 'suspended')
  const hiddenAt = audio.currentTime()
  await advance(0.3)
  check('timeline does not advance while hidden', Math.abs(audio.currentTime() - hiddenAt) < 1e-9)
  doc.hidden = false
  doc.fire()
  await Promise.resolve()
  check('visibilitychange back resumes the clock', context.state === 'running')
  await advance(1.5)
  console.log(`  after pause/visibility: clock ${clock.t.toFixed(3)} s, timeline ${audio.currentTime().toFixed(3)} s`)
  check('currentTime tracks the audio clock', Math.abs(audio.currentTime() - (context.currentTime - t0)) < 1e-9)

  // The cue at 2.0 s was still pending when the tab hid; it must now be placed
  // on the audio clock, not fired late by a timer.
  const tailSource = sources.find((source) => Math.abs((source.startedAt ?? -1) - (t0 + 2)) < 1e-12)
  check('pending cue survives pause and is placed on time', tailSource !== undefined, sources.map((s) => s.startedAt).join(','))

  audio.stopAll()
  check('stopAll resets the clock', audio.currentTime() === 0)
  const beforeReplay = sources.length
  const replayed = await audio.resume()
  check('resume after stopAll replays from the top', replayed === true)
  const replayT0 = context.currentTime + PLAYER_TIMING.leadSeconds
  check('replay schedules the first cue again', sources.length > beforeReplay &&
    sources.slice(beforeReplay).some((source) => Math.abs(source.startedAt - (replayT0 + 0.25)) < 1e-12),
  sources.slice(beforeReplay).map((s) => s.startedAt).join(','))
  check('replay does not fetch', fetchCalls === 0)
}

/* ----------------------------------------------------------------- done -- */

await rm(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: bind + regress behave' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
