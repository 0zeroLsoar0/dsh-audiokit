/**
 * Automation lanes on the in-page tier, checked without a browser.
 *
 * The feature has four claims that have to hold together and none of them can be
 * checked by listening: the lane vocabulary must be validated with readable
 * paths; the host must be able to describe the schedule a page would build; the
 * emitted script must actually schedule it on the AudioContext clock (with the
 * same voice limit and cleanup as before); and a build that asks for no lanes
 * must stay byte-for-byte what it was. The fake WebAudio environment below is
 * the same style as `test/live.mjs` -- deliberately strict, recording every node
 * and every AudioParam event -- so a bug in the generator shows up here as a
 * failed assertion instead of a silent page.
 *
 * The baseline numbers pinned below were measured on the implementation *before*
 * automation existed (`test/live.mjs` printed them): they are the regression
 * proof that adding automation did not change a play that does not use it.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTOMATION_CURVES,
  AUTOMATION_TARGETS,
  AUTOMATION_TARGET_NAMES,
  LIVE_AUTOMATION_VERSION,
  LIVE_VERSION,
  MAX_AUTOMATION_LANES,
  MAX_AUTOMATION_SECONDS,
  buildLiveScript,
  formatAutomationErrors,
  normalizeAutomation,
  renderLiveSpec,
  validateAutomation
} from '../lib/live.js'
import { registerLiveTools } from '../lib/tools-live.js'

const outDir = fileURLToPath(new URL('./out/automation/', import.meta.url))
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let failures = 0
let checks = 0
function check (label, ok, detail = '') {
  checks += 1
  if (ok) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
}
const num = (value, digits = 3) => Number(value).toFixed(digits).replace(/\.?0+$/, '')
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const near = (actual, expected, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance
/** Strictly increasing event times: two events at one instant are a bug. */
const ascending = (events) => events.every((event, index) => index === 0 || event.time > events[index - 1].time)

/** Measured on the pre-automation implementation; see the file header. */
const BASELINE = {
  allBytes: 16215,
  allSha256: '9ea1496528af0a28dad46dfc155b3ffc7f640e52cb75fb7707f339d20cea268c',
  impactEvents: 41,
  nodes: { impact: 26, whoosh: 14, tick: 6, chime: 22, riser: 18, zap: 18, thud: 14, scrap: 33, texture: 10 },
  defaultToolFile: 'live-1ad190b42332.js'
}

/* ------------------------------------------------------------- fake webaudio -- */

/**
 * A minimal but strict WebAudio implementation. It records what the page script
 * builds instead of producing sound: every node, every started source and every
 * AudioParam event. The strictness is the point -- an exponential ramp to a
 * non-positive value, a start before an unlock or a non-finite scheduled time
 * throws here, which are the exact mistakes a generated script tends to make.
 */
function createFakeAudio () {
  const contexts = []
  const nodes = []
  const sources = []
  const params = []
  const buffers = []

  class Param {
    constructor (value, label) {
      this.value = value
      this.label = label
      this.events = []
      params.push(this)
    }

    record (event) {
      if (event.time !== undefined && !Number.isFinite(event.time)) throw new Error(`${this.label}: non-finite time ${event.time}`)
      if (event.value !== undefined && !Number.isFinite(event.value)) throw new Error(`${this.label}: non-finite value ${event.value}`)
      this.events.push(event)
      return this
    }

    setValueAtTime (value, time) { this.value = value; return this.record({ type: 'set', value, time }) }

    linearRampToValueAtTime (value, time) { this.value = value; return this.record({ type: 'linear', value, time }) }

    exponentialRampToValueAtTime (value, time) {
      if (!(value > 0)) throw new Error(`${this.label}: exponential ramp to ${value} is invalid`)
      this.value = value
      return this.record({ type: 'exponential', value, time })
    }

    setTargetAtTime (value, time, constant) {
      if (!(constant > 0)) throw new Error(`${this.label}: setTargetAtTime constant ${constant} is invalid`)
      return this.record({ type: 'target', value, time, constant })
    }

    cancelScheduledValues (time) { return this.record({ type: 'cancel', time }) }
  }

  class Node {
    constructor (nodeType) {
      this.nodeType = nodeType
      this.outputs = []
      this.disconnected = false
      nodes.push(this)
    }

    connect (target) {
      this.outputs.push(target)
      return target
    }

    disconnect () { this.disconnected = true }
  }

  const WAVES = ['sine', 'square', 'sawtooth', 'triangle']
  const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']

  class GainNode extends Node {
    constructor () { super('gain'); this.gain = new Param(1, 'gain.gain') }
  }

  class BiquadNode extends Node {
    constructor () {
      super('biquad')
      this._type = 'lowpass'
      this.frequency = new Param(350, 'biquad.frequency')
      this.Q = new Param(1, 'biquad.Q')
      this.gain = new Param(0, 'biquad.gain')
    }

    get type () { return this._type }
    set type (value) { if (!FILTER_TYPES.includes(value)) throw new Error(`biquad type ${value} is invalid`); this._type = value }
  }

  class DelayNode extends Node {
    constructor (maxDelay) {
      super('delay')
      if (!(maxDelay > 0)) throw new Error(`delay max ${maxDelay} is invalid`)
      this.delayTime = new Param(0, 'delay.delayTime')
    }
  }

  class CompressorNode extends Node {
    constructor () {
      super('compressor')
      this.threshold = new Param(-24, 'compressor.threshold')
      this.knee = new Param(30, 'compressor.knee')
      this.ratio = new Param(12, 'compressor.ratio')
      this.attack = new Param(0.003, 'compressor.attack')
      this.release = new Param(0.25, 'compressor.release')
    }
  }

  class PannerNode extends Node {
    constructor () { super('panner'); this.pan = new Param(0, 'panner.pan') }
  }

  class SourceNode extends Node {
    constructor (sourceType) {
      super(sourceType)
      this.startedAt = null
      this.stoppedAt = null
      this.onended = null
    }

    start (time) {
      if (this.startedAt !== null) throw new Error(`${this.nodeType}: started twice`)
      if (!Number.isFinite(time) || time < 0) throw new Error(`${this.nodeType}: bad start time ${time}`)
      this.startedAt = time
      sources.push(this)
    }

    stop (time) {
      if (this.startedAt === null) throw new Error(`${this.nodeType}: stopped before start`)
      if (!Number.isFinite(time) || time < 0) throw new Error(`${this.nodeType}: bad stop time ${time}`)
      this.stoppedAt = time
    }
  }

  class OscillatorNode extends SourceNode {
    constructor () {
      super('oscillator')
      this._type = 'sine'
      this.frequency = new Param(440, 'oscillator.frequency')
      this.detune = new Param(0, 'oscillator.detune')
    }

    get type () { return this._type }
    set type (value) { if (!WAVES.includes(value)) throw new Error(`oscillator type ${value} is invalid`); this._type = value }
  }

  class BufferNode extends SourceNode {
    constructor () {
      super('bufferSource')
      this.buffer = null
      this.loop = false
      this.playbackRate = new Param(1, 'bufferSource.playbackRate')
      // Real browsers give AudioBufferSourceNode a detune AudioParam as well,
      // so the fake has one too: the runtime must classify a source by its
      // `frequency` / `playbackRate`, never by the presence of `detune`.
      this.detune = new Param(0, 'bufferSource.detune')
    }

    start (time) {
      if (this.buffer === null) throw new Error('bufferSource started without a buffer')
      super.start(time)
    }
  }

  class AudioBuffer {
    constructor (channels, length, sampleRate) {
      this.numberOfChannels = channels
      this.length = length
      this.sampleRate = sampleRate
      this.data = []
      for (let i = 0; i < channels; i += 1) this.data.push(new Float32Array(length))
    }

    getChannelData (channel) {
      if (this.data[channel] === undefined) throw new Error(`buffer channel ${channel} is out of range`)
      return this.data[channel]
    }
  }

  class FakeAudioContext {
    constructor (options = {}) {
      this.state = 'running'
      this.currentTime = 0
      this.sampleRate = options.sampleRate ?? 48000
      this.destination = new Node('destination')
      this.resumeCalls = 0
      contexts.push(this)
    }

    resume () { this.resumeCalls += 1; this.state = 'running'; return Promise.resolve() }

    createGain () { return new GainNode() }
    createBiquadFilter () { return new BiquadNode() }
    createDelay (maxDelay = 1) { return new DelayNode(maxDelay) }
    createDynamicsCompressor () { return new CompressorNode() }
    createStereoPanner () { return new PannerNode() }
    createOscillator () { return new OscillatorNode() }
    createBufferSource () { return new BufferNode() }

    createBuffer (channels, length, sampleRate) {
      if (!Number.isInteger(channels) || channels < 1) throw new Error(`createBuffer channels ${channels} is invalid`)
      if (!Number.isInteger(length) || length < 1) throw new Error(`createBuffer length ${length} is invalid`)
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`createBuffer sampleRate ${sampleRate} is invalid`)
      const buffer = new AudioBuffer(channels, length, sampleRate)
      buffers.push(buffer)
      return buffer
    }
  }

  // A source's `ended` fires when it reaches its scheduled stop; the page script
  // uses it for cleanup. Nothing here advances time, so the test fires the
  // events on demand.
  function fireEnded () {
    for (const source of sources) {
      if (source.stoppedAt === null || source.onended === null) continue
      const handler = source.onended
      source.onended = null
      handler({ type: 'ended' })
    }
  }

  return { contexts, nodes, sources, params, buffers, FakeAudioContext, fireEnded }
}

/**
 * Load an emitted script into a fake window and return its API plus the
 * environment it built. `window` is supplied as an argument so nothing leaks
 * into this test process's globals, exactly as a `<script src>` would run it.
 */
function loadLive (script) {
  const env = createFakeAudio()
  const win = { AudioContext: env.FakeAudioContext }
  const factory = new Function('window', script) // eslint-disable-line no-new-func -- this is the artifact under test
  factory(win)
  return {
    ...env,
    win,
    api: win.dshLive,
    byType: (nodeType) => env.nodes.filter((node) => node.nodeType === nodeType),
    paramEventCount: () => env.params.reduce((sum, param) => sum + param.events.length, 0)
  }
}

/** The LFO depth gains: a gain node wired straight into an AudioParam. */
const depthNodesOf = (env) => env.nodes.filter((node) => node.nodeType === 'gain' && node.outputs.length > 0 && node.outputs.every((target) => target.label !== undefined))

/* --------------------------------------------------------------- vocabulary -- */

console.log(`dsh-live automation: ${AUTOMATION_TARGET_NAMES.length} target(s), ${AUTOMATION_CURVES.length} curve(s)`)
for (const name of AUTOMATION_TARGET_NAMES) {
  const def = AUTOMATION_TARGETS[name]
  console.log(`  ${name.padEnd(7)} ${def.unit.padEnd(6)} ${String(def.min).padStart(6)}..${String(def.max).padEnd(6)}  lfo depth 0..${String(def.lfoMax).padEnd(5)} on ${def.param}`)
}
check('the five documented targets exist', ['pitch', 'filter', 'gain', 'pan', 'send'].every((name) => AUTOMATION_TARGET_NAMES.includes(name)), AUTOMATION_TARGET_NAMES.join(','))
check('pitch is documented in cents over one octave each way', AUTOMATION_TARGETS.pitch.unit === 'cents' && AUTOMATION_TARGETS.pitch.min === -1200 * 2 && AUTOMATION_TARGETS.pitch.max === 1200 * 2)
check('filter is documented in Hz over the audible band', AUTOMATION_TARGETS.filter.unit === 'Hz' && AUTOMATION_TARGETS.filter.min === 20 && AUTOMATION_TARGETS.filter.max === 20000)
check('gain is documented in dB', AUTOMATION_TARGETS.gain.unit === 'dB' && AUTOMATION_TARGETS.gain.min < 0 && AUTOMATION_TARGETS.gain.max > 0)
check('pan is documented as -1..1', AUTOMATION_TARGETS.pan.min === -1 && AUTOMATION_TARGETS.pan.max === 1)
check('send is documented as 0..1', AUTOMATION_TARGETS.send.min === 0 && AUTOMATION_TARGETS.send.max === 1)
check('every target range ascends', AUTOMATION_TARGET_NAMES.every((name) => AUTOMATION_TARGETS[name].min < AUTOMATION_TARGETS[name].max))
check('every target bounds a positive lfo depth', AUTOMATION_TARGET_NAMES.every((name) => AUTOMATION_TARGETS[name].lfoMax > 0 && AUTOMATION_TARGETS[name].lfoMax <= AUTOMATION_TARGETS[name].max - AUTOMATION_TARGETS[name].min))
check('the curves are linear, exp, sine, step', AUTOMATION_CURVES.join(',') === 'linear,exp,sine,step')
check('the lane ceiling matches the validator', MAX_AUTOMATION_LANES === 32 && MAX_AUTOMATION_SECONDS === 60)

/* --------------------------------------------------------------- validation -- */

console.log('\n-- validation --')
const pitchLane = { target: 'pitch', from: -1200, to: 1200, duration: 1.5 }
const filterLane = { target: 'filter', from: 300, to: 8000, duration: 0.8, curve: 'exp' }
const gainLane = { target: 'gain', from: -12, to: 0, duration: 0.6, curve: 'sine', start: 0.1, lfo: { hz: 5, depth: 3, target: 'gain' } }
const lanes = [pitchLane, filterLane, gainLane]

const validationCases = [
  ['valid lane', [pitchLane], true],
  ['valid lane with an lfo', [{ target: 'gain', from: -6, to: 0, duration: 1, lfo: { hz: 4, depth: 3 } }], true],
  ['empty lane list', [], true],
  ['unknown target', [{ target: 'cutoff', from: 200, to: 900, duration: 0.5 }], false],
  ['prototype-chain target', [{ target: 'constructor', from: 0, to: 1, duration: 1 }], false],
  ['descending lane', [{ target: 'filter', from: 8000, to: 300, duration: 0.8, curve: 'exp' }], true],
  ['descending gain duck', [{ target: 'gain', from: 0, to: -24, duration: 0.4 }], true],
  ['duration over 60 s', [{ target: 'filter', from: 200, to: 900, duration: 90 }], false],
  ['NaN endpoint', [{ target: 'pitch', from: Number.NaN, to: 200, duration: 0.5 }], false],
  ['missing duration', [{ target: 'pitch', from: 0, to: 200 }], false],
  ['unknown curve', [{ target: 'pitch', from: 0, to: 200, duration: 1, curve: 'wobble' }], false],
  ['value outside the target range', [{ target: 'filter', from: 5, to: 900, duration: 1 }], false],
  ['lfo out of range', [{ target: 'pitch', from: 0, to: 200, duration: 1, lfo: { hz: 90, depth: 100 } }], false],
  ['unknown lane field', [{ target: 'pitch', from: 0, to: 200, duration: 1, note: 'slide' }], false],
  ['non-array automation', { target: 'pitch' }, false]
]
const verdicts = new Map()
for (const [label, value, expected] of validationCases) {
  const verdict = validateAutomation(value)
  verdicts.set(label, verdict)
  const first = verdict.errors[0]
  console.log(`  ${label.padEnd(28)} ok=${String(verdict.ok).padEnd(5)} ${first === undefined ? '' : `${first.path}: ${first.message}`}`)
  check(`validation: ${label}`, verdict.ok === expected, JSON.stringify(verdict.errors))
}
const errorsOf = (label) => verdicts.get(label).errors
check('unknown target names the path and the vocabulary', errorsOf('unknown target').some((error) => error.path === 'automation[0].target' && /"cutoff"/.test(error.message) && /pitch/.test(error.message)))
check('a prototype-chain target is not a target', errorsOf('prototype-chain target').some((error) => error.path === 'automation[0].target' && /unknown target "constructor"/.test(error.message)))
check('a prototype-chain target is dropped by normalisation', normalizeAutomation([{ target: 'constructor', from: 0, to: 1, duration: 1 }]).length === 0)
check('a descending lane is legal (direction is not a validation concern)', verdicts.get('descending lane').errors.length === 0 && verdicts.get('descending gain duck').errors.length === 0)
check('a long lane names the 60 s limit', errorsOf('duration over 60 s').some((error) => error.path === 'automation[0].duration' && /60 s/.test(error.message)))
check('NaN names the field and the value', errorsOf('NaN endpoint').some((error) => error.path === 'automation[0].from' && /finite/.test(error.message)))
check('an out-of-range value names the target range', errorsOf('value outside the target range').some((error) => error.path === 'automation[0].from' && /20/.test(error.message)))
check('lfo errors carry the nested path', errorsOf('lfo out of range').some((error) => error.path === 'automation[0].lfo.hz'))
check('a typo field is named', errorsOf('unknown lane field').some((error) => error.path === 'automation[0].note'))
check('non-array automation is reported at the root', errorsOf('non-array automation')[0].path === 'automation')

console.log(`  readable one line: ${formatAutomationErrors(errorsOf('unknown target'))}`)
let invalidBuild = null
let buildMessage = ''
try { invalidBuild = buildLiveScript({ automation: [{ target: 'cutoff', from: 1, to: 2, duration: 1 }] }) } catch (error) { buildMessage = error.message }
console.log(`  buildLiveScript throws: ${buildMessage}`)
check('an invalid lane produces no script at all', invalidBuild === null && /invalid automation/.test(buildMessage) && /automation\[0\]\.target/.test(buildMessage), buildMessage)
let specMessage = ''
try { renderLiveSpec('impact', {}, { automation: [{ target: 'pitch', from: 0, to: 0, duration: 0 }] }) } catch (error) { specMessage = error.message }
check('renderLiveSpec rejects an invalid lane too', /invalid automation/.test(specMessage) && /automation\[0\]\.duration/.test(specMessage), specMessage)
let durationMessage = ''
try { buildLiveScript({ duration: 61 }) } catch (error) { durationMessage = error.message }
check('a bad baked duration is refused', /duration 61s is outside/.test(durationMessage), durationMessage)

/* ------------------------------------------------------------------- script -- */

console.log('\n-- emitted script --')
const presets = ['impact', 'tick']
const auto = buildLiveScript({ presets, automation: lanes })
const autoAgain = buildLiveScript({ presets, automation: lanes })
const reordered = buildLiveScript({ presets, automation: [{ duration: 1.5, to: 1200, from: -1200, target: 'pitch' }, filterLane, gainLane] })
const changedLane = buildLiveScript({ presets, automation: [{ ...pitchLane, to: 600 }, filterLane, gainLane] })
const plain = buildLiveScript({})
const plainSubset = buildLiveScript({ presets })
const supportNoLanes = buildLiveScript({ presets, automation: [] })
const durationOnly = buildLiveScript({ presets: ['tick'], duration: 2 })

let parses = false
try { new Function(auto.script); parses = true } catch (error) { check('automation script parses', false, error.message) }
check('automation script parses', parses)
check('bytes match the string', auto.bytes === Buffer.byteLength(auto.script, 'utf8'))
check('automation script is ASCII', !/[^\x00-\x7F]/.test(auto.script), 'non-ASCII byte in generated code')
for (const [label, pattern] of [
  ['http', /https?:\/\//],
  ['eval', /\beval\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['new Function', /new\s+Function/],
  ['document', /\bdocument\b/],
  ['arrow', /=>/],
  ['require', /\brequire\s*\(/]
]) {
  check(`automation script has no ${label}`, !pattern.test(auto.script))
}
check('an automation build carries the feature version', auto.script.includes(`dsh-live ${LIVE_AUTOMATION_VERSION}`) && auto.script.includes(`var VERSION=${JSON.stringify(LIVE_AUTOMATION_VERSION)}`))
check('an automation build carries the lane table and runtime', auto.script.includes('var AUTOLANES=') && auto.script.includes('var AUTORANGE=') && auto.script.includes('livePlayAuto'))
check('identical input is byte-identical', autoAgain.script === auto.script && autoAgain.bytes === auto.bytes)
check('lane key order does not change the bytes', reordered.script === auto.script)
check('changing one lane changes the bytes', changedLane.script !== auto.script && changedLane.bytes !== auto.bytes)
check('the baked lanes survive canonicalisation', auto.automation !== null && auto.automation.lanes.length === 3 && Object.keys(auto.automation.lanes[0]).join(',') === 'target,from,to,start,duration,curve,lfo', JSON.stringify(auto.automation))
check('no baked duration means null', auto.automation.duration === null)
check('an empty lane list still emits support', supportNoLanes.script.includes('var AUTOLANES=[]') && supportNoLanes.script.includes('livePlayAuto') && supportNoLanes.bytes > plainSubset.bytes)
check('a duration alone emits support and the value', durationOnly.script.includes('var AUTODUR=2') && durationOnly.automation.lanes.length === 0 && durationOnly.automation.duration === 2)
console.log(`  plain ${plain.bytes} B · automation ${auto.bytes} B (+${auto.bytes - plain.bytes}) · support without lanes ${supportNoLanes.bytes} B (tick only ${plainSubset.bytes} B -> ${supportNoLanes.bytes} B) · duration only ${durationOnly.bytes} B`)

// The regression that matters most: a build that asks for no automation must be
// the script the previous implementation emitted, byte for byte.
console.log('\n-- regression: the no-automation script is untouched --')
console.log(`  plain build ${plain.bytes} B, sha256 ${sha(plain.script).slice(0, 32)}… (baseline ${BASELINE.allBytes} B, ${BASELINE.allSha256.slice(0, 32)}…)`)
check('the no-automation script is byte-identical to the pre-automation implementation', plain.bytes === BASELINE.allBytes && sha(plain.script) === BASELINE.allSha256, `${plain.bytes} B ${sha(plain.script).slice(0, 16)}`)
check('the no-automation script carries no automation code', !plain.script.includes('AUTOLANES') && !plain.script.includes('livePlayAuto') && !plain.script.includes('AUTORANGE'))
check('the no-automation script reports the old version', plain.script.includes(`dsh-live ${LIVE_VERSION}`) && !plain.script.includes(LIVE_AUTOMATION_VERSION))

/* ------------------------------------------------------------ renderLiveSpec -- */

console.log('\n-- renderLiveSpec: the schedule a page would build --')
const described = renderLiveSpec('impact', {}, { seed: 7, automation: lanes })
const automation = described.automation
console.log(`  impact: ${automation.lanes.length} lane(s), ${automation.eventCount} event(s), ${automation.scheduledParamEvents} param event(s), ${automation.lfoCount} lfo(s), voice ${num(automation.durationSeconds, 2)}s`)
for (const lane of automation.lanes) {
  const kinds = lane.events.map((event) => event.type[0]).join('')
  console.log(`    ${lane.target.padEnd(7)} ${num(lane.from, 1)}->${num(lane.to, 1)} ${lane.curve.padEnd(6)} ${lane.events.length} event(s) [${kinds}] on ${lane.params.map((entry) => `${entry.param}x${entry.nodes}`).join(', ')}${lane.lfo === null ? '' : ` + lfo ${lane.lfo.hz}Hz on ${lane.lfo.target}`}`)
  check(`${lane.target} lane times ascend`, ascending(lane.events))
}
const oscillatorCount = described.layers.filter((layer) => layer.source.type === 'osc').length
const noiseCount = described.layers.length - oscillatorCount
const [pitchSpec, filterSpec, gainSpec] = automation.lanes
check('a linear pitch lane is a set plus one ramp', pitchSpec.target === 'pitch' && pitchSpec.events.length === 2 && pitchSpec.events[0].type === 'set' && pitchSpec.events[0].value === -1200 && pitchSpec.events[0].time === 0 && pitchSpec.events[1].type === 'linear' && pitchSpec.events[1].value === 1200 && pitchSpec.events[1].time === 1.5)
check('a pitch lane reaches every oscillator and every noise source', pitchSpec.params.some((entry) => entry.param === 'oscillator.detune' && entry.nodes === oscillatorCount) && pitchSpec.params.some((entry) => entry.param === 'bufferSource.playbackRate' && entry.nodes === noiseCount))
check('an exponential lane on positive values emits an exponential event', filterSpec.events.length === 2 && filterSpec.events[0].type === 'set' && filterSpec.events[1].type === 'exponential' && filterSpec.events[1].value === 8000 && filterSpec.events[1].time === 0.8)
check('a sine lane is an S-curve sampled at eight points', gainSpec.events.length === 9 && gainSpec.events[0].type === 'set' && gainSpec.events[0].value === -12 && gainSpec.events[8].type === 'linear' && gainSpec.events[8].value === 0 && gainSpec.events[8].time === 0.7)
check('the description counts every scheduled param event', automation.scheduledParamEvents === 2 * (oscillatorCount + noiseCount) + 2 + 9, `${automation.scheduledParamEvents}`)
check('the lfo is described with its target', automation.lfoCount === 1 && gainSpec.lfo !== null && gainSpec.lfo.target === 'gain' && gainSpec.lfo.hz === 5 && gainSpec.lfo.nodes === 1)
check('no automation argument means a null description', renderLiveSpec('impact').automation === null)
check('the duration override is reported with the description', renderLiveSpec('tick', {}, { automation: [pitchLane], duration: 3 }).automation.durationSeconds === 3)
const stepSpec = renderLiveSpec('tick', {}, { automation: [{ target: 'gain', from: -12, to: 0, duration: 1, curve: 'step' }] }).automation.lanes[0]
check('a step lane is two set events', stepSpec.events.length === 2 && stepSpec.events.every((event) => event.type === 'set') && stepSpec.events[1].value === 0)
const crossingSpec = renderLiveSpec('tick', {}, { automation: [{ target: 'pan', from: -1, to: 1, duration: 1, curve: 'exp' }] }).automation.lanes[0]
console.log(`  pan exp lane crossing zero degrades to ${crossingSpec.events[1].type} (WebAudio's exponential formula is a ratio)`)
check('an exp lane crossing zero falls back to linear', crossingSpec.events[1].type === 'linear')
const clamped = normalizeAutomation([{ target: 'pitch', from: -99999, to: 99999, duration: 0.5 }])[0]
console.log(`  normalizeAutomation clamps: pitch -99999..99999 -> ${clamped.from}..${clamped.to}, start ${clamped.start}, curve ${clamped.curve}`)
check('normalisation clamps to the documented range and fills defaults', clamped.from === -2400 && clamped.to === 2400 && clamped.start === 0 && clamped.curve === 'linear')

/* ------------------------------------------------------- fake webaudio: pitch -- */

console.log('\n-- fake WebAudio: pitch lane --')
const pitchBuilt = buildLiveScript({ presets: ['impact'], automation: [pitchLane] })
const pitchEnv = loadLive(pitchBuilt.script)
pitchEnv.api.unlock()
const pitchHandle = pitchEnv.api.play('impact')
const detuneParams = pitchEnv.byType('oscillator').filter((node) => node.startedAt !== null).map((node) => node.detune)
const detuned = detuneParams.filter((param) => param.events.length > 0)
const playbackParams = pitchEnv.byType('bufferSource').filter((node) => node.startedAt !== null).map((node) => node.playbackRate).filter((param) => param.events.length > 0)
console.log(`  play('impact') -> handle automation ${JSON.stringify(pitchHandle.automation)}, ${detuned.length}/${detuneParams.length} detune params scheduled (${detuned[0]?.events.length} event(s) each), ${playbackParams.length} playbackRate param(s) scheduled`)
check('the handle reports the lane count and events', pitchHandle.automation !== null && pitchHandle.automation.lanes === 1 && pitchHandle.automation.events === 2 && pitchHandle.automation.duration === 0.9)
check('every oscillator detune is scheduled', detuned.length === detuneParams.length && detuned.length > 1, `${detuned.length}/${detuneParams.length}`)
check('the pitch lane at least two events per detune with ascending times', detuned.every((param) => param.events.length >= 2 && ascending(param.events)))
const firstDetune = detuned[0]
console.log(`  detune: [${firstDetune.events.map((event) => `${event.type} ${num(event.value, 1)} @ ${num(event.time, 4)}s`).join(', ')}] (voice starts at 0.004 s)`)
check('the pitch lane starts at -1200 cents and ramps to +1200', near(firstDetune.events[0].time, 0.004) && firstDetune.events[0].type === 'set' && firstDetune.events[0].value === -1200 && firstDetune.events[1].type === 'linear' && firstDetune.events[1].value === 1200 && near(firstDetune.events[1].time, 0.004 + 1.5))
check('the noise source is detuned through its playback rate', playbackParams.length === 1 && near(playbackParams[0].events[0].value, 0.5) && near(playbackParams[0].events[1].value, 2) && playbackParams[0].events[1].type === 'linear')
const noiseNodes = pitchEnv.byType('bufferSource').filter((node) => node.startedAt !== null)
check('a noise source uses playbackRate, not its detune param', noiseNodes.length > 0 && noiseNodes.every((node) => node.playbackRate.events.length === 2 && node.detune.events.length === 0))
// The host preview and the page schedule must agree event for event.
const previewEvents = renderLiveSpec('impact', {}, { automation: [pitchLane] }).automation.lanes[0].events
check('the host description matches what the page scheduled', previewEvents.length === firstDetune.events.length && previewEvents.every((event, index) => event.type === firstDetune.events[index].type && event.value === firstDetune.events[index].value && near(event.time + 0.004, firstDetune.events[index].time)))
pitchEnv.api.stopAll()

/* ------------------------------------------------- fake webaudio: descending -- */

console.log('\n-- fake WebAudio: descending lanes --')
const descendingLanes = [
  { target: 'filter', from: 8000, to: 300, duration: 0.8, curve: 'exp' },
  { target: 'gain', from: 0, to: -24, duration: 0.4 }
]
const descendingEnv = loadLive(buildLiveScript({ presets: ['impact'], automation: descendingLanes }).script)
descendingEnv.api.unlock()
const descendingHandle = descendingEnv.api.play('impact')
const descendingFilter = descendingEnv.byType('biquad').find((node) => node.frequency.events.some((event) => event.type === 'exponential'))
const descendingGain = descendingEnv.byType('gain').find((node) => node.gain.events.length === 2 && node.gain.events[0].value === 1)
console.log(`  filter 8000->300 exp: [${(descendingFilter?.frequency.events ?? []).map((event) => `${event.type} ${num(event.value, 1)} @ ${num(event.time, 4)}s`).join(', ')}]`)
console.log(`  gain 0->-24 dB: [${(descendingGain?.gain.events ?? []).map((event) => `${event.type} ${num(event.value, 4)} @ ${num(event.time, 4)}s`).join(', ')}]`)
check('a descending exp lane is accepted and stays exponential', descendingFilter !== undefined && descendingFilter.frequency.events.length === 2 && descendingFilter.frequency.events[0].type === 'set' && descendingFilter.frequency.events[0].value === 8000 && descendingFilter.frequency.events[1].type === 'exponential' && descendingFilter.frequency.events[1].value === 300 && near(descendingFilter.frequency.events[1].time, 0.004 + 0.8))
check('a descending lane keeps monotonic event times', descendingFilter !== undefined && ascending(descendingFilter.frequency.events) && descendingGain !== undefined && ascending(descendingGain.gain.events))
check('a descending gain duck ends at the mapped end value', descendingGain !== undefined && near(descendingGain.gain.events[0].value, 1) && near(descendingGain.gain.events[1].value, Math.pow(10, -24 / 20)) && near(descendingGain.gain.events[1].time, 0.004 + 0.4))
check('the handle reports the descending lanes', descendingHandle.automation !== null && descendingHandle.automation.lanes === 2 && descendingHandle.automation.events === 4)
const descendingSpec = renderLiveSpec('impact', {}, { automation: descendingLanes }).automation.lanes
check('the host description keeps from first and to second', descendingSpec[0].events[0].value === 8000 && descendingSpec[0].events[1].value === 300 && descendingSpec[1].events[0].value === 0 && descendingSpec[1].events[1].value === -24)
descendingEnv.api.stopAll()
descendingEnv.fireEnded()

/* ------------------------------------------------------ fake webaudio: filter -- */

console.log('\n-- fake WebAudio: filter lane --')
const filterBuilt = buildLiveScript({ presets: ['impact'], automation: [filterLane] })
const filterEnv = loadLive(filterBuilt.script)
filterEnv.api.unlock()
const filterHandle = filterEnv.api.play('impact')
const biquads = filterEnv.byType('biquad')
const autoFilter = biquads.find((node) => node.frequency.events.some((event) => event.type === 'exponential'))
console.log(`  play('impact') -> ${biquads.length} biquad(s), the voice filter is lowpass Q ${autoFilter?.Q.value}: [${(autoFilter?.frequency.events ?? []).map((event) => `${event.type} ${num(event.value, 1)} @ ${num(event.time, 4)}s`).join(', ')}]`)
check('the filter lane creates one voice-wide biquad', biquads.filter((node) => node.frequency.events.some((event) => event.type === 'exponential')).length === 1)
check('the filter lane schedules on the biquad frequency', autoFilter !== undefined && autoFilter.frequency.events.length === 2 && ascending(autoFilter.frequency.events))
check('the filter lane ramps exponentially from 300 Hz to 8000 Hz', autoFilter !== undefined && autoFilter.frequency.events[0].value === 300 && autoFilter.frequency.events[1].type === 'exponential' && autoFilter.frequency.events[1].value === 8000 && near(autoFilter.frequency.events[1].time, 0.004 + 0.8))
check('the voice filter is a lowpass wired to the limiter', autoFilter !== undefined && autoFilter.type === 'lowpass' && autoFilter.Q.value === 0.7 && autoFilter.outputs.includes(filterEnv.byType('compressor')[0]))
check('the handle reports the filtered lane', filterHandle.automation !== null && filterHandle.automation.lanes === 1)
filterEnv.api.stopAll()

console.log('\n-- fake WebAudio: pan and send lanes --')
const spatialEnv = loadLive(buildLiveScript({ presets: ['impact'], automation: [{ target: 'pan', from: -1, to: 1, duration: 0.7 }] }).script)
spatialEnv.api.unlock()
spatialEnv.api.play('impact')
const panner = spatialEnv.byType('panner')[0]
console.log(`  pan lane -> ${spatialEnv.byType('panner').length} panner(s): [${(panner?.pan.events ?? []).map((event) => `${event.type} ${num(event.value, 2)} @ ${num(event.time, 3)}s`).join(', ')}], wired to the limiter: ${panner?.outputs.includes(spatialEnv.byType('compressor')[0])}`)
check('a pan lane creates one StereoPanner and ramps it', panner !== undefined && panner.pan.events.length === 2 && panner.pan.events[0].value === -1 && panner.pan.events[1].value === 1 && near(panner.pan.events[1].time, 0.004 + 0.7))
check('the panner sits in the voice chain and reaches the limiter', panner !== undefined && panner.outputs.includes(spatialEnv.byType('compressor')[0]))
spatialEnv.api.stopAll()
spatialEnv.fireEnded()
check('the panner is disconnected with the voice', panner !== undefined && panner.disconnected === true)

const sendEnv = loadLive(buildLiveScript({ presets: ['tick'], automation: [{ target: 'send', from: 0, to: 0.6, duration: 0.5 }] }).script)
sendEnv.api.unlock()
sendEnv.api.play('tick')
const sendGain = sendEnv.byType('gain').find((node) => node.gain.events.length === 2 && node.gain.events[0].value === 0)
console.log(`  send lane on a dry preset -> send gain [${(sendGain?.gain.events ?? []).map((event) => `${event.type} ${num(event.value, 2)} @ ${num(event.time, 3)}s`).join(', ')}], feeds ${sendGain?.outputs[0]?.nodeType} (a default room)`)
check('a send lane on a dry preset builds a room to send into', sendGain !== undefined && near(sendGain.gain.events[1].value, 0.6) && sendGain.outputs[0]?.nodeType === 'gain')
sendEnv.api.stopAll()
sendEnv.fireEnded()
check('the send gain is disconnected with the voice', sendGain !== undefined && sendGain.disconnected === true)

/* ---------------------------------------------------------- fake webaudio: lfo -- */

console.log('\n-- fake WebAudio: LFO --')
const lfoLane = { target: 'pitch', from: 0, to: 0, duration: 1, lfo: { hz: 6.25, depth: 300, target: 'pitch' } }
const lfoEnv = loadLive(buildLiveScript({ presets: ['impact'], automation: [lfoLane] }).script)
lfoEnv.api.unlock()
const lfoHandle = lfoEnv.api.play('impact')
const lfoOscillators = lfoEnv.byType('oscillator').filter((node) => node.startedAt !== null && node.frequency.value === 6.25)
const lfo = lfoOscillators[0]
const lfoDepth = lfo === undefined ? undefined : lfo.outputs[0]
console.log(`  play('impact') -> ${lfoOscillators.length} LFO oscillator(s) at ${lfo?.frequency.value} Hz, depth gain ${lfoDepth?.gain.value} connected to ${lfoDepth?.outputs.length} param(s), started ${num(lfo?.startedAt, 4)}s stopped ${num(lfo?.stoppedAt, 4)}s`)
check('exactly one LFO oscillator is created', lfoOscillators.length === 1, String(lfoOscillators.length))
check('the LFO is a sine at the requested rate', lfo !== undefined && lfo.type === 'sine' && lfo.frequency.value === 6.25)
check('the LFO output goes through one depth gain', lfo !== undefined && lfo.outputs.length === 1 && lfoDepth.nodeType === 'gain' && lfoDepth.gain.value === 300)
check('the depth gain is connected to every detune param', lfoDepth !== undefined && lfoDepth.outputs.length === detuneParams.length && lfoDepth.outputs.every((target) => target.label === 'oscillator.detune'))
check('the LFO is stopped with the voice', lfo !== undefined && lfo.stoppedAt !== null && near(lfo.stoppedAt, 0.004 + 0.9 + 0.15))
check('the handle still reports the lanes', lfoHandle.automation.lanes === 1 && lfoHandle.automation.events === 2)
lfoEnv.api.stopAll()
check('stopAll force-stops the LFO at once', lfo !== undefined && near(lfo.stoppedAt, 0.04), String(lfo?.stoppedAt))
lfoEnv.fireEnded()
check('the LFO depth gain is disconnected with the voice', lfoDepth !== undefined && lfoDepth.disconnected === true)

// An LFO targeting a node that no lane names must still create that node, or the
// LFO would be connected to nothing.
const gainLfoLane = { target: 'gain', from: -12, to: 0, duration: 0.5, lfo: { hz: 5, depth: 6, target: 'gain' } }
const gainEnv = loadLive(buildLiveScript({ presets: ['impact'], automation: [gainLfoLane] }).script)
gainEnv.api.unlock()
gainEnv.api.play('impact')
const automationGain = gainEnv.byType('gain').find((node) => node.gain.events.length === 2 && near(node.gain.events[0].value, Math.pow(10, -12 / 20)))
const gainLfoOsc = gainEnv.byType('oscillator').find((node) => node.frequency.value === 5)
const gainLfoDepth = gainLfoOsc === undefined ? undefined : gainLfoOsc.outputs[0]
console.log(`  gain lane: [${(automationGain?.gain.events ?? []).map((event) => `${event.type} ${num(event.value, 4)} @ ${num(event.time, 4)}s`).join(', ')}], LFO depth ${num(gainLfoDepth?.gain.value, 4)} on the gain param: ${gainLfoDepth?.outputs.includes(automationGain?.gain)}`)
check('a gain lane schedules dB converted to linear amplitude', automationGain !== undefined && near(automationGain.gain.events[0].value, Math.pow(10, -12 / 20)) && near(automationGain.gain.events[1].value, 1) && near(automationGain.gain.events[1].time, 0.004 + 0.5))
check('a gain LFO depth is a linear offset around unity', gainLfoDepth !== undefined && near(gainLfoDepth.gain.value, Math.pow(10, 6 / 20) - 1))
check('a gain LFO connects to the gain node of its lane', automationGain !== undefined && gainLfoDepth !== undefined && gainLfoDepth.outputs.includes(automationGain.gain))
gainEnv.api.stopAll()
gainEnv.fireEnded()
check('the gain node and the LFO depth are disconnected with the voice', automationGain !== undefined && automationGain.disconnected === true && gainLfoDepth !== undefined && gainLfoDepth.disconnected === true)

/* -------------------------------------------------- fake webaudio: 50 plays -- */

console.log('\n-- fake WebAudio: 50 rapid plays with automation --')
const rapidLane = { target: 'pitch', from: -600, to: 600, duration: 0.4, lfo: { hz: 6.25, depth: 200 } }
const rapidEnv = loadLive(buildLiveScript({ presets: ['impact'], maxVoices: 4, automation: [rapidLane] }).script)
rapidEnv.api.unlock()
const nodesBefore = rapidEnv.nodes.length
let accepted = 0
let peak = 0
for (let i = 0; i < 50; i += 1) {
  const handle = rapidEnv.api.play('impact')
  if (handle === null) break
  accepted += 1
  peak = Math.max(peak, rapidEnv.api.activeVoices())
}
// buildLayer schedules every one-shot stop up front, so `stoppedAt !== null`
// says nothing. The meaningful probe is the stop *time*: a voice that is still
// sounding keeps the preset tail (1.054 s here), and every voice the runtime
// tears down has been force-stopped earlier. Counting LFOs and sources still on
// the natural tail before/after stopAll is the node-count cleanup check.
const naturalTail = 0.004 + 0.9 + 0.15
const onTail = (list) => list.filter((node) => node.stoppedAt !== null && near(node.stoppedAt, naturalTail)).length
const lfos = rapidEnv.byType('oscillator').filter((node) => node.frequency.value === 6.25 && node.startedAt !== null)
const activeBefore = rapidEnv.api.activeVoices()
const voicesOnTailBefore = onTail(rapidEnv.sources)
const lfosOnTailBefore = onTail(lfos)
rapidEnv.api.stopAll()
const activeAfter = rapidEnv.api.activeVoices()
const voicesOnTailAfter = onTail(rapidEnv.sources)
const lfosOnTailAfter = onTail(lfos)
const forceStopped = lfos.filter((node) => node.stoppedAt !== null && node.stoppedAt < naturalTail).length
const nodesAfter = rapidEnv.nodes.length
const nodesPerPlay = (nodesAfter - nodesBefore) / accepted
console.log(`  50 plays: ${accepted} accepted, peak activeVoices ${peak} (limit 4), ${lfos.length} LFO oscillator(s) created; ${activeBefore} voice(s) left sounding`)
console.log(`  on the natural ${num(naturalTail, 3)}s tail: ${voicesOnTailBefore} source(s) / ${lfosOnTailBefore} LFO(s) before stopAll -> ${voicesOnTailAfter} / ${lfosOnTailAfter} after; ${forceStopped}/${lfos.length} LFOs force-stopped; graph nodes ${nodesBefore} -> ${nodesAfter} (+${num(nodesPerPlay, 1)} per play)`)
check('all 50 rapid plays are accepted', accepted === 50, String(accepted))
check('automation stays within maxVoices', peak <= 4, String(peak))
check('every play creates its own LFO', lfos.length === 50, String(lfos.length))
check('the live voices keep their LFOs before stopAll', lfosOnTailBefore === activeBefore && voicesOnTailBefore === activeBefore * 9, `${lfosOnTailBefore}/${activeBefore} lfos, ${voicesOnTailBefore} sources`)
check('stopAll leaves no voice sounding', activeAfter === 0, String(activeAfter))
check('stopAll removes every source from the tail', voicesOnTailAfter === 0, String(voicesOnTailAfter))
check('stopAll cleans up every LFO', lfosOnTailAfter === 0 && forceStopped === lfos.length, `${lfosOnTailAfter} on tail, ${forceStopped} force-stopped`)
check('every LFO has a bounded stop time', lfos.every((node) => node.stoppedAt !== null && node.stoppedAt < 0.1))
check('an automated play stays a bounded graph', nodesPerPlay < 40, `${num(nodesPerPlay, 1)} nodes/play`)
const depthGains = depthNodesOf(rapidEnv)
rapidEnv.fireEnded()
const detached = depthGains.filter((node) => node.disconnected === true).length
console.log(`  LFO depth gains disconnected on voice end: ${detached}/${depthGains.length}`)
check('every LFO depth gain disconnects with its voice', depthGains.length === 50 && detached === 50, `${detached}/${depthGains.length}`)
rapidEnv.api.stopAll()

/* --------------------------------------------------- duration schedules the stop -- */

console.log('\n-- duration schedules the stop --')
const tickBuilt = buildLiveScript({ presets: ['tick'], automation: [pitchLane] })
const tickEnv = loadLive(tickBuilt.script)
tickEnv.api.unlock()
const tickDefault = tickEnv.api.play('tick')
const defaultSources = tickEnv.sources.slice()
const defaultStops = defaultSources.map((source) => source.stoppedAt)
tickEnv.api.stopAll()
const sourceMark = tickEnv.sources.length
const longTick = tickEnv.api.play('tick', {}, { duration: 2 })
const longSources = tickEnv.sources.slice(sourceMark)
console.log(`  play('tick') -> handle ${JSON.stringify(tickDefault.automation)}, sources stopped at ${defaultStops.map((time) => num(time, 3)).join(', ')}s (now 0.004 + 0.05 + 0.15 tail)`)
console.log(`  play('tick', {}, { duration: 2 }) -> handle ${JSON.stringify(longTick.automation)}, sources stopped at ${longSources.map((source) => num(source.stoppedAt, 3)).join(', ')}s`)
check('the preset length decides the default stop', defaultStops.every((time) => near(time, 0.004 + 0.05 + 0.15)) && tickDefault.automation.duration === 0.05)
check('options.duration moves the scheduled stop', longSources.length > 0 && longSources.every((source) => near(source.stoppedAt, 0.004 + 2 + 0.15)))
check('the handle reports the applied duration', longTick.automation.duration === 2 && longTick.automation.lanes === 1)
check('the emitted play accepts a duration argument', /function livePlayAuto \(name, over, opts\)|function livePlayAuto\(name,over,opts\)/.test(tickBuilt.script))
tickEnv.api.stopAll()

const baked = buildLiveScript({ presets: ['tick'], automation: [pitchLane], duration: 1.2 })
check('a baked duration lands in the script', baked.script.includes('var AUTODUR=1.2') && baked.automation.duration === 1.2)
const bakedEnv = loadLive(baked.script)
bakedEnv.api.unlock()
bakedEnv.api.play('tick')
const bakedStops = bakedEnv.sources.map((source) => source.stoppedAt)
const bakedMark = bakedEnv.sources.length
const bakedOverride = bakedEnv.api.play('tick', {}, { duration: 0.5 })
const overrideStops = bakedEnv.sources.slice(bakedMark).map((source) => source.stoppedAt)
console.log(`  baked duration 1.2 -> stop ${bakedStops.map((time) => num(time, 3)).join(', ')}s; per-play 0.5 -> ${overrideStops.map((time) => num(time, 3)).join(', ')}s`)
check('the baked default duration schedules the stop', bakedStops.every((time) => near(time, 0.004 + 1.2 + 0.15)))
check('a per-play duration overrides the baked one', bakedOverride.automation.duration === 0.5 && overrideStops.every((time) => near(time, 0.004 + 0.5 + 0.15)))
bakedEnv.api.stopAll()

// A build that emits support without baking lanes still accepts per-play lanes;
// a build without support must ignore the same argument (that path is the old
// script, unchanged).
const supportEnv = loadLive(buildLiveScript({ presets: ['tick'], automation: [] }).script)
supportEnv.api.unlock()
const perPlayHandle = supportEnv.api.play('tick', {}, { automation: [pitchLane] })
const perPlayDetuned = supportEnv.byType('oscillator').filter((node) => node.startedAt !== null).filter((node) => node.detune.events.length > 0).length
console.log(`  support without baked lanes: play('tick', {}, { automation: [pitch lane] }) -> handle ${JSON.stringify(perPlayHandle.automation)}, ${perPlayDetuned} detuned oscillator(s)`)
check('an empty baked lane list still accepts per-play lanes', perPlayHandle.automation !== null && perPlayHandle.automation.lanes === 1 && perPlayDetuned === 1)
supportEnv.api.stopAll()

const legacyEnv = loadLive(plainSubset.script)
legacyEnv.api.unlock()
const legacyHandle = legacyEnv.api.play('tick', {}, { automation: [pitchLane] })
const legacyDetuned = legacyEnv.byType('oscillator').filter((node) => node.startedAt !== null).filter((node) => node.detune.events.length > 0).length
console.log(`  plain script: play('tick', {}, { automation: ... }) -> handle automation ${String(legacyHandle.automation)}, ${legacyDetuned} detuned oscillator(s) (the old contract is unchanged)`)
check('a script without automation support ignores the third argument', legacyHandle.automation === undefined && legacyDetuned === 0)
legacyEnv.api.stopAll()

/* ------------------------------------------------- regression: node counts -- */

console.log('\n-- regression: node counts without automation --')
const nodeRows = []
for (const [name, expected] of Object.entries(BASELINE.nodes)) {
  const plainRun = loadLive(buildLiveScript({ presets: [name] }).script)
  plainRun.api.unlock()
  const plainBefore = plainRun.nodes.length
  plainRun.api.play(name)
  const plainCreated = plainRun.nodes.length - plainBefore
  const supportRun = loadLive(buildLiveScript({ presets: [name], automation: [] }).script)
  supportRun.api.unlock()
  const supportBefore = supportRun.nodes.length
  supportRun.api.play(name)
  const supportCreated = supportRun.nodes.length - supportBefore
  nodeRows.push(`${name}:${plainCreated}/${supportCreated}`)
  check(`${name} creates the same node count as the old implementation`, plainCreated === expected, `${plainCreated} vs ${expected}`)
  check(`${name} creates no extra node when support is emitted but no lane is used`, supportCreated === expected, `${supportCreated} vs ${expected}`)
}
console.log(`  nodes per play (plain / support without lanes): ${nodeRows.join(' ')}`)

const eventRun = loadLive(buildLiveScript({ presets: ['impact'] }).script)
eventRun.api.unlock()
const eventsBefore = eventRun.paramEventCount()
const eventHandle = eventRun.api.play('impact')
const eventsScheduled = eventRun.paramEventCount() - eventsBefore
const supportEventRun = loadLive(buildLiveScript({ presets: ['impact'], automation: [] }).script)
supportEventRun.api.unlock()
const supportBefore = supportEventRun.paramEventCount()
supportEventRun.api.play('impact')
const supportEvents = supportEventRun.paramEventCount() - supportBefore
console.log(`  play('impact') schedules ${eventsScheduled} param event(s) (baseline ${BASELINE.impactEvents}); with support but no lanes ${supportEvents}`)
check('a plain play schedules the same 41 param events as before', eventsScheduled === BASELINE.impactEvents, String(eventsScheduled))
check('support without lanes adds no param event', supportEvents === BASELINE.impactEvents, String(supportEvents))
check('a plain play has no automation summary on its handle', eventHandle.automation === undefined)

/* ------------------------------------------------------------------- tool -- */

console.log('\n-- audio_live tool --')
const registered = new Map()
const toolCwd = join(outDir, 'tool')
await mkdir(toolCwd, { recursive: true })
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => toolCwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }
registerLiveTools(ctx)
const call = (name, args) => registered.get(name).execute(args, exec)
const filesIn = async () => (await readdir(toolCwd)).sort()

check('registers exactly audio_live', [...registered.keys()].join(',') === 'audio_live', [...registered.keys()].join(','))
const schema = registered.get('audio_live').parameters
check('the schema offers automation and duration', schema.properties.automation !== undefined && schema.properties.duration !== undefined)
check('the automation schema enumerates the lane fields', schema.properties.automation.items.properties.target.enum.join(',') === AUTOMATION_TARGET_NAMES.join(',') && schema.properties.automation.items.properties.curve.enum.join(',') === AUTOMATION_CURVES.join(',') && schema.properties.automation.items.properties.lfo.properties.hz !== undefined)
{
  const result = await call('audio_live', { presets: ['impact'], automation: [pitchLane, filterLane], duration: 1.5, out: 'auto/slide', demo: true })
  const scriptText = await readFile(join(toolCwd, result.relativePath), 'utf8')
  const demoText = await readFile(join(toolCwd, result.demoRelativePath), 'utf8')
  const info = await stat(join(toolCwd, result.relativePath))
  console.log(`  wrote ${result.relativePath} (${result.bytes} B, ${result.automationLanes} lane(s), duration ${result.duration})`)
  console.log(`  text: ${result.text}`)
  check('the file is the built script', scriptText === buildLiveScript({ presets: ['impact'], automation: [pitchLane, filterLane], duration: 1.5 }).script)
  check('the file contains the lanes and duration', scriptText.includes('var AUTOLANES=') && scriptText.includes('var AUTODUR=1.5') && scriptText.includes(`dsh-live ${LIVE_AUTOMATION_VERSION}`))
  check('the summary reports the lanes and duration', result.automationLanes === 2 && result.duration === 1.5 && result.automation !== null && result.automation.lanes.length === 2)
  check('the text mentions the lanes and the duration', /automation: pitch -1200->1200/.test(result.text) && /filter 300->8000/.test(result.text) && /voice 1\.5s/.test(result.text) && /Wrote in-page synth/.test(result.text) && /no audio bytes/.test(result.text))
  check('the file size matches the summary', info.size === result.bytes && result.bytes === result.scriptBytes)
  check('the demo page is still network-free', demoText.includes('src="slide.js"') && !/https?:\/\//.test(demoText))
  // The demo calls play(name) with no arguments, so the baked lanes are what a
  // human hears when they click a button.
  const demoInline = /<script>([\s\S]*?)<\/script>/.exec(demoText)
  check('the demo still drives the generated API', demoInline !== null && demoInline[1].includes('window.dshLive') && demoInline[1].includes('.play('))
}
{
  const withLanes = await call('audio_live', { presets: ['impact'] })
  const defaultResult = await call('audio_live', {})
  console.log(`  default call: ${defaultResult.relativePath} (${defaultResult.bytes} B), automation ${String(defaultResult.automation)}, lanes ${defaultResult.automationLanes}`)
  console.log(`  default text: ${defaultResult.text}`)
  check('a request without automation keeps the old default file name', defaultResult.relativePath === `assets/audio/${BASELINE.defaultToolFile}`, defaultResult.relativePath)
  check('a request without automation reports no lanes', defaultResult.automation === null && defaultResult.automationLanes === 0 && defaultResult.duration === null)
  check('the text says automation is off', /automation: none/.test(defaultResult.text))
  console.log(`  lanes-only call: ${withLanes.relativePath} (${withLanes.bytes} B)`)
  check('baking lanes changes the file name', withLanes.relativePath !== `assets/audio/${BASELINE.defaultToolFile}`)
}
{
  const durationOnly = await call('audio_live', { presets: ['tick'], duration: 0.4, out: 'auto/length' })
  const scriptText = await readFile(join(toolCwd, durationOnly.relativePath), 'utf8')
  console.log(`  duration-only call: ${durationOnly.relativePath}, automation ${JSON.stringify(durationOnly.automation)}`)
  check('a duration alone emits the automation runtime', scriptText.includes('var AUTODUR=0.4') && durationOnly.automation !== null && durationOnly.automation.lanes.length === 0)
  check('the text mentions the voice length', /voice 0\.4s/.test(durationOnly.text))
}
{
  const before = await filesIn()
  let message = ''
  try { await call('audio_live', { presets: ['impact'], automation: [{ target: 'cutoff', from: 200, to: 900, duration: 0.5 }] }) } catch (error) { message = error.message }
  console.log(`  invalid lane error: ${message}`)
  check('the tool refuses an unknown target with a path', /audio_live: invalid automation/.test(message) && /automation\[0\]\.target/.test(message) && /cutoff/.test(message), message)
  check('no file is written for an invalid lane', (await filesIn()).join(',') === before.join(','))
  let durationMessage = ''
  try { await call('audio_live', { presets: ['impact'], duration: 0 }) } catch (error) { durationMessage = error.message }
  check('the tool refuses a zero duration', /duration must be between 0\.02 and 60/.test(durationMessage), durationMessage)
  let longMessage = ''
  try { await call('audio_live', { presets: ['impact'], duration: 90 }) } catch (error) { longMessage = error.message }
  check('the tool refuses a duration over 60 s', /duration must be between 0\.02 and 60/.test(longMessage), longMessage)
  let curveMessage = ''
  try { await call('audio_live', { presets: ['impact'], automation: [{ target: 'pitch', from: 0, to: 100, duration: 1, curve: 'wobble' }] }) } catch (error) { curveMessage = error.message }
  check('the tool refuses an unknown curve with a path', /automation\[0\]\.curve/.test(curveMessage) && /wobble/.test(curveMessage), curveMessage)
  let rangeMessage = ''
  try { await call('audio_live', { presets: ['impact'], automation: [{ target: 'pitch', from: -99999, to: 0, duration: 1 }] }) } catch (error) { rangeMessage = error.message }
  check('the tool refuses a value outside the target range', /automation\[0\]\.from/.test(rangeMessage) && /outside pitch/.test(rangeMessage), rangeMessage)
}

await rm(outDir, { recursive: true, force: true })

console.log(failures === 0
  ? `\nOK: ${checks} checks — automation lanes validate, describe, schedule and stay out of the plain script`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
