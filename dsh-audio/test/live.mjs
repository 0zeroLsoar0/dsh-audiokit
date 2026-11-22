/**
 * The in-page tier, checked without a browser.
 *
 * Three claims have to hold at once and none of them can be checked by listening:
 * the emitted script must be valid, small JavaScript; the graph descriptions must
 * be valid data; and the script must actually drive a WebAudio context (voice
 * limit, limiter, laziness, scheduling) rather than merely look right. The fake
 * WebAudio environment below is deliberately strict -- scheduled times and
 * values are validated as they are recorded, `exponentialRampToValueAtTime`
 * refuses a non-positive target the way the real API does -- so a bug in the
 * generator shows up here instead of on a user's page.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIVE_PRESETS, LIVE_PRESET_NAMES, buildLiveDemoHtml, buildLiveScript, renderLiveSpec } from '../lib/live.js'
import { registerLiveTools } from '../lib/tools-live.js'

const outDir = fileURLToPath(new URL('./out/live/', import.meta.url))
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
const kernels = (script, word) => (script.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length

/* ------------------------------------------------------------- fake webaudio -- */

/**
 * A minimal but strict WebAudio implementation.
 *
 * It records what the page script builds instead of producing sound: every node,
 * every started source, every AudioParam event. The strictness is the point --
 * the fake rejects an exponential ramp to zero, a start with no source, or a
 * non-finite scheduled time, which are the exact mistakes a generated script
 * tends to make.
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
      this.loopStart = 0
      this.loopEnd = 0
      this.playbackRate = new Param(1, 'bufferSource.playbackRate')
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
  // uses it to disconnect a stopped voice's bus. Nothing here advances time, so
  // the test fires the events on demand.
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
 * Load the emitted script into a fake window and return its API plus the
 * environment it built. The script is invoked exactly as a `<script src>` would
 * run it, with `window` supplied as an argument so nothing leaks into this test
 * process's globals.
 */
function loadLive (script) {
  const env = createFakeAudio()
  const win = { AudioContext: env.FakeAudioContext }
  const before = Object.keys(win).sort().join(',')
  const factory = new Function('window', script) // eslint-disable-line no-new-func -- this is the artifact under test
  factory(win)
  return {
    ...env,
    win,
    api: win.dshLive,
    addedKeys: Object.keys(win).filter((key) => !before.split(',').includes(key)),
    context: () => env.contexts[env.contexts.length - 1],
    byType: (nodeType) => env.nodes.filter((node) => node.nodeType === nodeType),
    scheduled: () => env.params.flatMap((param) => param.events)
  }
}

/* ---------------------------------------------------------------- script -- */

console.log(`dsh-live: ${LIVE_PRESET_NAMES.length} preset families`)

const all = buildLiveScript({})
console.log(`\n-- emitted script --`)
console.log(`  ${all.bytes} B = ${num(all.bytes / 1024, 2)} KB, ${all.script.split('\n').length} lines, ${all.script.length} chars, sha256 ${createHash('sha256').update(all.script).digest('hex').slice(0, 16)}`)

let parsed = false
try { new Function(all.script); parsed = true } catch (error) { check('script parses', false, error.message) }
check('script parses', parsed)
check('bytes match the string', all.bytes === Buffer.byteLength(all.script, 'utf8'))
check('script is ASCII', !/[^\x00-\x7F]/.test(all.script), 'non-ASCII byte in generated code')

for (const [label, pattern] of [
  ['http', /https?:\/\//],
  ['eval', /\beval\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['new Function', /new\s+Function/],
  ['document', /\bdocument\b/],
  ['arrow', /=>/],
  ['require', /\brequire\s*\(/]
]) {
  const hits = pattern.test(all.script)
  check(`script has no ${label}`, !hits, `${hits} hit(s)`)
}
console.log(`  forbidden tokens: http none, eval none, fetch none, new Function none, document none, arrow none, require none`)
check('script is an IIFE', /^\s*\/\*[\s\S]*?\*\/\s*;?\(function \(root\)/.test(all.script))
check('script is strict', all.script.includes("'use strict'"))
check('script assigns window.dshLive', /root\.dshLive=api/.test(all.script))
check('script reports the live version', all.script.includes('dsh-live 1.0.0'))

console.log(`\n-- byte budget (canonical order, cumulative) --`)
const emptyBuild = buildLiveScript({ presets: [] })
let running = emptyBuild.bytes
let contributions = 0
const lines = []
for (const name of LIVE_PRESET_NAMES) {
  const prefix = LIVE_PRESET_NAMES.slice(0, LIVE_PRESET_NAMES.indexOf(name) + 1)
  const bytes = buildLiveScript({ presets: prefix }).bytes
  const marginal = bytes - running
  running = bytes
  contributions += marginal
  lines.push(`${name} ${marginal} B`)
  check(`${name} costs bytes`, marginal > 0, String(marginal))
}
console.log(`  ${lines.join(' · ')}`)
console.log(`  runtime only ${emptyBuild.bytes} B (${num(emptyBuild.bytes / 1024, 2)} KB) + contributions ${contributions} B = ${emptyBuild.bytes + contributions} B = total ${all.bytes} B`)
check('contributions account for the total', emptyBuild.bytes + contributions === all.bytes, `${emptyBuild.bytes} + ${contributions} != ${all.bytes}`)
check('total fits the 8-16 KB guide', all.bytes <= 16 * 1024, `${all.bytes} B`)
check('runtime alone is a sensible floor', emptyBuild.bytes > 4 * 1024, `${emptyBuild.bytes} B`)

console.log(`\n-- determinism --`)
const same = buildLiveScript({})
const reordered = buildLiveScript({ presets: LIVE_PRESET_NAMES.slice().reverse() })
const otherSeed = buildLiveScript({ seed: 2 })
const otherVoices = buildLiveScript({ maxVoices: 4 })
console.log(`  same options identical: ${same.script === all.script} · reversed preset order identical: ${reordered.script === all.script} · seed 1 vs 2 identical: ${otherSeed.script === all.script} · maxVoices 12 vs 4 identical: ${otherVoices.script === all.script}`)
check('same options produce identical bytes', same.script === all.script && same.bytes === all.bytes)
check('preset order does not change the bytes', reordered.script === all.script)
check('a different seed changes the bytes', otherSeed.script !== all.script)
check('a different voice limit changes the bytes', otherVoices.script !== all.script)
const subset = buildLiveScript({ presets: ['tick', 'impact'] })
console.log(`  two presets only: ${subset.bytes} B (${num(subset.bytes / 1024, 2)} KB), exports [${subset.exports.join(', ')}]`)
check('subset keeps canonical order', subset.exports.join(',') === 'impact,tick')
check('subset is smaller than all', subset.bytes < all.bytes)

/* -------------------------------------------------------------- plans -- */

const colorSet = ['white', 'pink', 'brown', 'drops', 'pops']
const waveSet = ['sine', 'triangle', 'sawtooth', 'square']
const filterSet = ['lowpass', 'highpass', 'bandpass']

function walkPlan (spec) {
  const problems = []
  const note = (message) => problems.push(message)
  const finite = (value, label) => { if (!Number.isFinite(value)) note(`${label} is not finite (${value})`) }
  const contour = (value, label, { positive = false } = {}) => {
    if (value === null || value === undefined || !Array.isArray(value.pts)) return note(`${label} has no breakpoints`)
    if (value.pts.length < 2) note(`${label} has ${value.pts.length} breakpoint(s)`)
    for (const [index, point] of value.pts.entries()) {
      if (!Array.isArray(point) || point.length !== 2) note(`${label}[${index}] is not [fraction, value]`)
      else {
        finite(point[0], `${label}[${index}].fraction`)
        finite(point[1], `${label}[${index}].value`)
        if (point[0] < 0 || point[0] > 1) note(`${label}[${index}].fraction ${point[0]} is outside 0..1`)
        if (positive && !(point[1] > 0)) note(`${label}[${index}].value ${point[1]} is not positive`)
      }
    }
    if (value.curve !== 'lin' && value.curve !== 'exp') note(`${label}.curve is ${value.curve}`)
    if (value.pts[0][0] !== 0) note(`${label} does not start at 0`)
    if (value.pts[value.pts.length - 1][0] !== 1) note(`${label} does not end at 1`)
  }

  finite(spec.durationSeconds, 'durationSeconds')
  if (!(spec.durationSeconds > 0)) note('duration is not positive')
  finite(spec.master.gain, 'master.gain')
  if (spec.space !== null) {
    finite(spec.space.amount, 'space.amount')
    finite(spec.space.feedback, 'space.feedback')
    finite(spec.space.damping, 'space.damping')
    if (!(spec.space.amount >= 0 && spec.space.amount <= 1)) note(`space.amount ${spec.space.amount} outside 0..1`)
    if (!(spec.space.feedback > 0 && spec.space.feedback < 0.9)) note(`space.feedback ${spec.space.feedback} is not a stable send`)
    if (!(spec.space.damping > 0)) note('space.damping is not positive')
  }
  if (spec.layers.length === 0) note('no layers')
  let longest = 0
  for (const [index, layer] of spec.layers.entries()) {
    const at = `layer[${index}] ${layer.id}`
    if (typeof layer.id !== 'string' || layer.id === '') note(`${at}: missing id`)
    finite(layer.gain, `${at}.gain`)
    if (!(layer.gain > 0)) note(`${at}.gain ${layer.gain} is not positive`)
    finite(layer.at ?? 0, `${at}.at`)
    if ((layer.at ?? 0) < 0) note(`${at}.at is negative`)
    if (layer.env === null || layer.env === undefined) {
      if (spec.loop !== true) note(`${at}: one-shot layer has no envelope`)
      longest = Math.max(longest, spec.durationSeconds)
    } else if (layer.env.pts !== undefined) {
      contour(layer.env, `${at}.env`)
      longest = Math.max(longest, spec.durationSeconds)
    } else {
      finite(layer.env.a, `${at}.env.a`)
      finite(layer.env.d, `${at}.env.d`)
      if (!(layer.env.a > 0)) note(`${at}.env.a ${layer.env.a} is not positive`)
      if (!(layer.env.d > 0)) note(`${at}.env.d ${layer.env.d} is not positive`)
      longest = Math.max(longest, (layer.at ?? 0) + layer.env.a + layer.env.d * 1.5)
    }
    if (layer.source.type === 'osc') {
      if (!waveSet.includes(layer.source.wave)) note(`${at}: wave ${layer.source.wave}`)
      contour(layer.source.freq, `${at}.source.freq`, { positive: true })
    } else if (layer.source.type === 'noise') {
      if (!colorSet.includes(layer.source.color)) note(`${at}: colour ${layer.source.color}`)
      finite(layer.source.seconds, `${at}.source.seconds`)
      if (!(layer.source.seconds > 0)) note(`${at}.source.seconds ${layer.source.seconds} is not positive`)
      if (spec.loop === true && layer.source.type === 'noise' && layer.source.loop !== true) note(`${at}: a bed's noise layer must loop`)
    } else {
      note(`${at}: source type ${layer.source.type}`)
    }
    if (layer.filter !== null && layer.filter !== undefined) {
      if (!filterSet.includes(layer.filter.type)) note(`${at}: filter ${layer.filter.type}`)
      contour(layer.filter.freq, `${at}.filter.freq`, { positive: true })
      if (typeof layer.filter.q === 'number') {
        finite(layer.filter.q, `${at}.filter.q`)
        if (!(layer.filter.q > 0)) note(`${at}.filter.q is not positive`)
      } else {
        contour(layer.filter.q, `${at}.filter.q`, { positive: true })
      }
    }
    if (layer.lfo !== null && layer.lfo !== undefined) {
      contour(layer.lfo.freq, `${at}.lfo.freq`, { positive: true })
      finite(layer.lfo.depth, `${at}.lfo.depth`)
      if (!(layer.lfo.depth >= 0)) note(`${at}.lfo.depth is negative`)
      if (layer.lfo.target !== 'gain' && layer.lfo.target !== 'filter') note(`${at}: lfo target ${layer.lfo.target}`)
    }
  }
  return { problems, longest }
}

console.log(`\n-- graph descriptions (renderLiveSpec) --`)
for (const name of LIVE_PRESET_NAMES) {
  const spec = renderLiveSpec(name, {}, { seed: 7 })
  const { problems, longest } = walkPlan(spec)
  const rampEnvelopes = spec.layers.filter((layer) => layer.env?.d !== undefined).length
  const pointEnvelopes = spec.layers.filter((layer) => layer.env?.pts !== undefined).length
  const envText = `${rampEnvelopes} ramp + ${pointEnvelopes} breakpoint env(s)`
  console.log(
    `  ${name.padEnd(8)} ${String(spec.layers.length).padStart(2)} layers  ${num(spec.durationSeconds, 3)}s  ` +
    `${spec.loop ? 'bed ' : 'one-shot'}  ${envText}, layer span up to ${num(longest, 2)}s  space ${spec.space ? num(spec.space.amount, 2) : '-'}`
  )
  for (const problem of problems) check(`${name} plan`, false, problem)
  check(`${name} plan is valid`, problems.length === 0, problems.join('; '))
}

console.log(`\n-- parameter sensitivity --`)
const flatten = (value, prefix = '', out = new Map()) => {
  if (typeof value === 'number') out.set(prefix, value)
  else if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) flatten(value[key], prefix === '' ? key : `${prefix}.${key}`, out)
  return out
}
const graph = (spec) => ({ layers: spec.layers, space: spec.space, master: spec.master })
function graphDelta (specA, specB) {
  const a = flatten(graph(specA))
  const b = flatten(graph(specB))
  let changed = 0
  let added = 0
  let removed = 0
  let max = 0
  for (const [key, value] of a) {
    if (!b.has(key)) removed += 1
    else {
      const difference = Math.abs(b.get(key) - value)
      if (difference > 1e-9) {
        changed += 1
        if (difference > max) max = difference
      }
    }
  }
  for (const key of b.keys()) if (!a.has(key)) added += 1
  return { changed, added, removed, max, total: changed + added + removed }
}

for (const name of LIVE_PRESET_NAMES) {
  const entry = LIVE_PRESETS[name]
  const base = renderLiveSpec(name, {}, { seed: 3 })
  let best = { knob: '-', total: 0, max: 0 }
  let moving = 0
  for (const [knob, range] of Object.entries(entry.ranges)) {
    const low = renderLiveSpec(name, { [knob]: range[0] }, { seed: 3 })
    const high = renderLiveSpec(name, { [knob]: range[1] }, { seed: 3 })
    const delta = graphDelta(low, high)
    if (delta.total > 0) moving += 1
    if (delta.total > best.total || (delta.total === best.total && delta.max > best.max)) best = { knob, total: delta.total, max: delta.max }
  }
  const kindDelta = name === 'texture'
    ? graphDelta(renderLiveSpec('texture', { kind: 'hum' }, { seed: 3 }), renderLiveSpec('texture', { kind: 'rain' }, { seed: 3 })).total
    : 0
  console.log(`  ${name.padEnd(8)} ${moving}/${Object.keys(entry.ranges).length} knobs move the graph${name === 'texture' ? ` (+ kind: ${kindDelta} nodes changed)` : ''}; strongest ${best.knob} (${best.total} values, max ${num(best.max, 2)})`)
  check(`${name} responds to knobs`, moving > 0 || kindDelta > 0, `${moving} moving knobs`)
  if (name === 'texture') check('texture kind changes the graph', kindDelta > 4, String(kindDelta))
}

{
  const cutoff = (weight) => renderLiveSpec('thud', { weight }).layers.find((layer) => layer.id === 'tail').filter.freq.pts[0][1]
  const soft = cutoff(0.1)
  const heavy = cutoff(0.9)
  console.log(`  thud weight 0.1 -> 0.9: tail low-pass ${num(soft, 1)} Hz -> ${num(heavy, 1)} Hz (${num(heavy - soft, 1)} Hz)`)
  check('weight lowers the thud filter cutoff', heavy < soft - 100, `${soft} -> ${heavy}`)
}
{
  const decay = (hardness) => renderLiveSpec('tick', { hardness }).layers.find((layer) => layer.id === 'tone').env.d
  const soft = decay(0.2) * 1000
  const hard = decay(0.9) * 1000
  console.log(`  tick hardness 0.2 -> 0.9: tone decay ${num(soft, 1)} ms -> ${num(hard, 1)} ms (${num(hard - soft, 1)} ms)`)
  check('hardness shortens the tick decay', hard < soft, `${soft} -> ${hard}`)
}
{
  const pitch = (weight) => renderLiveSpec('impact', { weight }).layers.find((layer) => layer.id === 'body').source.freq.pts[0][1]
  const light = pitch(0.1)
  const heavy = pitch(0.9)
  console.log(`  impact weight 0.1 -> 0.9: body start pitch ${num(light, 1)} Hz -> ${num(heavy, 1)} Hz`)
  check('weight lowers the impact body pitch', heavy < light, `${light} -> ${heavy}`)
}
{
  const metallic = (value) => renderLiveSpec('impact', { metallic: value }).layers.length
  console.log(`  impact metallic 0 -> 0.9: layers ${metallic(0)} -> ${metallic(0.9)} (ring partials appear)`)
  check('metallic adds ring partials', metallic(0.9) > metallic(0), `${metallic(0)} -> ${metallic(0.9)}`)
}
{
  const kinds = ['wind', 'rain', 'fire', 'room', 'hum']
  const rows = kinds.map((kind) => `${kind}:${renderLiveSpec('texture', { kind }).layers.length}`)
  console.log(`  texture kinds keep the bed looping: ${rows.join(' ')}`)
  check('every texture kind is a looping bed', kinds.every((kind) => {
    const spec = renderLiveSpec('texture', { kind })
    return spec.loop === true && spec.layers.length >= 2 && spec.layers.every((layer) => layer.source.type === 'osc' || layer.source.loop === true)
  }))
  check('an unknown kind falls back to wind', renderLiveSpec('texture', { kind: 'lava' }).layers.map((layer) => layer.id).join(',') === renderLiveSpec('texture', { kind: 'wind' }).layers.map((layer) => layer.id).join(','))
}

/* --------------------------------------------------------- fake webaudio -- */

console.log(`\n-- fake WebAudio: lazy context --`)
{
  const live = loadLive(all.script)
  console.log(`  after load: contexts ${live.contexts.length}, nodes ${live.nodes.length}, added window keys [${live.addedKeys.join(', ')}]`)
  check('nothing is created before unlock', live.contexts.length === 0 && live.nodes.length === 0)
  check('only window.dshLive is added', live.addedKeys.join(',') === 'dshLive', live.addedKeys.join(','))
  check('script installs the API', live.api !== undefined && typeof live.api.play === 'function')
  const apiKeys = Object.keys(live.api).sort().join(',')
  console.log(`  api: ${apiKeys}`)
  check('api surface complete', apiKeys === 'activeVoices,isUnlocked,play,setVolume,stop,stopAll,unlock,version', apiKeys)
  check('locked before unlock', live.api.isUnlocked() === false)
  const locked = live.api.play('impact')
  console.log(`  play() before unlock returns ${locked === null ? 'null' : typeof locked}; contexts still ${live.contexts.length}, nodes ${live.nodes.length}`)
  check('play before unlock is a no-op', locked === null && live.contexts.length === 0 && live.nodes.length === 0)
}

console.log(`\n-- fake WebAudio: unlock and play --`)
{
  const live = loadLive(all.script)
  const unlocked = live.api.unlock()
  const again = live.api.unlock()
  const context = live.context()
  console.log(`  unlock -> ${unlocked}, repeated unlock -> ${again}, contexts ${live.contexts.length}, state ${context.state}, rate ${context.sampleRate}`)
  check('unlock creates exactly one context', live.contexts.length === 1)
  check('unlock is idempotent', again === true && live.contexts.length === 1)
  check('unlocked reports true', live.api.isUnlocked() === true)
  check('limiter is a compressor wired to the destination', live.byType('compressor').length === 1 && live.byType('compressor')[0].threshold.value === -6 && live.byType('compressor')[0].ratio.value === 12)
  const master = live.byType('gain').find((node) => node.outputs.includes(context.destination))
  check('master gain reaches the destination', master !== undefined)

  const before = { nodes: live.nodes.length, sources: live.sources.length, params: live.params.length }
  const handle = live.api.play('impact', { weight: 0.8, metallic: 0.6 })
  const created = live.nodes.length - before.nodes
  const started = live.byType('oscillator').filter((node) => node.startedAt !== null).length + live.byType('bufferSource').filter((node) => node.startedAt !== null).length
  const scheduled = live.scheduled().length
  const gains = live.byType('gain').length
  const biquads = live.byType('biquad').length
  console.log(`  play('impact') -> ${handle === null ? 'null' : `handle(gain ${num(handle.gain, 3)}, bed ${handle.bed})`}, created ${created} nodes (${live.byType('oscillator').length} osc, ${live.byType('bufferSource').length} buffer, ${biquads} biquad, ${gains} gain), started ${started} sources, ${scheduled} scheduled param events`)
  check('play after unlock returns a handle', handle !== null && typeof handle.stop === 'function')
  check('play creates at least 3 nodes', created >= 3, String(created))
  check('play starts sources', started >= 3, String(started))
  check('play schedules parameter events', scheduled > 10, String(scheduled))
  check('play builds the graph from every node kind', live.byType('oscillator').length > 0 && live.byType('bufferSource').length > 0 && biquads > 0 && gains > 3)
  check('sources are scheduled at or after now', live.sources.every((source) => source.startedAt !== null && source.startedAt >= 0))
  const events = live.scheduled()
  check('every scheduled event is finite', events.every((event) => (event.time === undefined || Number.isFinite(event.time)) && (event.value === undefined || Number.isFinite(event.value))))
  const firstStart = Math.min(...live.sources.map((source) => source.startedAt))
  console.log(`  earliest start ${num(firstStart, 4)} s (context clock ${context.currentTime}), stop times ${live.sources.filter((source) => source.stoppedAt !== null).length}/${live.sources.length}`)
  check('voices are scheduled ahead of the clock', firstStart > context.currentTime)
  check('one-shot sources are scheduled to stop', live.sources.filter((source) => source.stoppedAt !== null).length === live.sources.length)
  check('activeVoices counts the new voice', live.api.activeVoices() === 1)

  const stopAllResult = live.api.stopAll()
  console.log(`  stopAll() -> ${stopAllResult}, activeVoices ${live.api.activeVoices()}`)
  check('stopAll returns true when something was playing', stopAllResult === true)
  check('stopAll leaves no active voice', live.api.activeVoices() === 0)
  const stopped = live.sources.filter((source) => source.stoppedAt !== null).length
  check('stopAll stops every source', stopped === live.sources.length, `${stopped}/${live.sources.length}`)
  check('stopAll is harmless when idle', live.api.stopAll() === false)
  check('unknown preset is refused', live.api.play('not-a-preset') === null)
}

console.log(`\n-- fake WebAudio: voices, gain compensation, limiter --`)
{
  const limited = buildLiveScript({ maxVoices: 4 })
  const live = loadLive(limited.script)
  live.api.unlock()
  const gains = []
  let worst = 0
  let plays = 0
  for (let i = 0; i < 100; i += 1) {
    const handle = live.api.play('impact')
    if (handle === null) break
    plays += 1
    if (gains.length < 4) gains.push(handle.gain)
    worst = Math.max(worst, live.api.activeVoices())
  }
  const stopped = live.sources.filter((source) => source.stoppedAt !== null).length
  console.log(`  100 rapid plays: ${plays} accepted, peak activeVoices ${worst} (limit 4), ${live.sources.length} sources created, ${stopped} stopped, ${live.byType('gain').length} gain nodes`)
  check('100 rapid plays all accepted', plays === 100, String(plays))
  check('active voices stay within maxVoices', worst <= 4, String(worst))
  check('every voice is a live graph', live.sources.length > 4 * 3, String(live.sources.length))
  check('stolen voices are stopped', stopped > 0, String(stopped))
  const expected = [1, 1 / Math.sqrt(2), 1 / Math.sqrt(3), 1 / Math.sqrt(4)].map((scale) => scale * 0.85)
  console.log(`  voice gains 1..4: ${gains.map((gain) => num(gain, 3)).join(' ')} (expected ${expected.map((gain) => num(gain, 3)).join(' ')})`)
  check('gain compensation follows 1/sqrt(1+sounding)', gains.every((gain, index) => Math.abs(gain - expected[index]) < 1e-9), gains.map((gain) => num(gain, 4)).join(','))
  check('later voices are attenuated', gains[1] < gains[0] && gains[3] < gains[1])
  check('no non-finite parameter events after 100 plays', live.scheduled().every((event) => (event.time === undefined || Number.isFinite(event.time)) && (event.value === undefined || Number.isFinite(event.value))))
  live.api.stopAll()
  check('stopAll clears 100-play state', live.api.activeVoices() === 0)
  const compressor = live.byType('compressor')[0]
  const wiredToLimiter = () => live.byType('gain').filter((node) => !node.disconnected && node.outputs.includes(compressor)).length
  const beforeCleanup = wiredToLimiter()
  live.fireEnded()
  const afterCleanup = wiredToLimiter()
  console.log(`  voice buses still wired to the limiter: ${beforeCleanup} before onended cleanup, ${afterCleanup} after (the one shared space return stays wired)`)
  check('stopped voices release their bus', afterCleanup < beforeCleanup && afterCleanup <= 2, `${beforeCleanup} -> ${afterCleanup}`)
  console.log(`  noise buffers created across 100 plays: ${live.buffers.length} (cached by colour+length, so rapid plays reuse them)`)
  check('rapid plays reuse cached noise buffers', live.buffers.length <= 4, String(live.buffers.length))
}

console.log(`\n-- fake WebAudio: every preset plays --`)
{
  // A designer that leaves a field undefined only fails when the page tries to
  // build it, so play all nine (and all five bed kinds) through the strict fake:
  // an invalid oscillator wave, filter type or bufferless source throws there.
  const live = loadLive(all.script)
  live.api.unlock()
  const rows = []
  for (const name of LIVE_PRESET_NAMES) {
    const before = live.nodes.length
    let handle = null
    let error = null
    try { handle = live.api.play(name) } catch (thrown) { error = thrown.message }
    const nodes = live.nodes.length - before
    rows.push(`${name}:${error === null ? nodes : 'ERR'}`)
    check(`${name} plays through the fake API`, error === null && handle !== null && nodes >= 4, error ?? `${nodes} nodes`)
    live.api.stopAll()
  }
  for (const kind of ['wind', 'rain', 'fire', 'room', 'hum']) {
    let handle = null
    let error = null
    try { handle = live.api.play('texture', { kind }) } catch (thrown) { error = thrown.message }
    check(`texture ${kind} plays through the fake API`, error === null && handle !== null && handle.bed === true, error ?? 'no handle')
    live.api.stopAll()
  }
  live.fireEnded()
  console.log(`  nodes built per preset: ${rows.join(' ')}`)
  const events = live.scheduled()
  console.log(`  ${events.length} scheduled events across every preset, all finite: ${events.every((event) => (event.time === undefined || Number.isFinite(event.time)) && (event.value === undefined || Number.isFinite(event.value)))}`)
  check('every preset schedules only finite values', events.every((event) => (event.time === undefined || Number.isFinite(event.time)) && (event.value === undefined || Number.isFinite(event.value))))
}

console.log(`\n-- fake WebAudio: beds, volume, stop(name) --`)
{
  const live = loadLive(all.script)
  live.api.unlock()
  const bed = live.api.play('texture', { kind: 'rain' })
  const loops = live.byType('bufferSource').filter((node) => node.loop === true).length
  console.log(`  play('texture', kind rain) -> bed ${bed.bed}, ${loops} looping source(s), ${live.byType('bufferSource').length} buffer source(s)`)
  check('texture reports a bed', bed.bed === true)
  check('texture loops its noise sources', loops > 0)
  check('texture node has stop()', typeof bed.stop === 'function')
  bed.stop()
  const allStopped = live.byType('bufferSource').every((node) => node.stoppedAt !== null)
  console.log(`  bed.stop() -> sources stopped ${allStopped}, activeVoices ${live.api.activeVoices()}`)
  check('stopping a bed stops its sources', allStopped)
  check('stopping a bed releases the voice', live.api.activeVoices() === 0)

  const ping = live.api.play('chime')
  const stoppedByName = live.api.stop('chime')
  console.log(`  stop('chime') -> ${stoppedByName}, activeVoices ${live.api.activeVoices()}`)
  check('stop(name) stops that preset', ping !== null && stoppedByName === true && live.api.activeVoices() === 0)
  check('stop(name) is false for a preset that is not playing', live.api.stop('zap') === false)

  // Grains are the one preset whose buffer length used to be random per play; a
  // page would then mint a new noise buffer every time it fired a scrape.
  const grainsBefore = live.buffers.length
  for (let i = 0; i < 40; i += 1) live.api.play('scrap', { density: 1 })
  live.api.stopAll()
  live.fireEnded()
  console.log(`  scrap x40 with density 1: ${live.buffers.length - grainsBefore} new noise buffer(s) (must stay bounded)`)
  check('scrape grains reuse one buffer', live.buffers.length - grainsBefore <= 2, String(live.buffers.length - grainsBefore))

  const master = live.byType('gain').find((node) => node.outputs.some((output) => output.nodeType === 'destination'))
  const volume = live.api.setVolume(-6)
  const target = master.gain.events.filter((event) => event.type === 'target').pop()
  console.log(`  setVolume(-6) -> ${volume}, master target ${target ? `${num(target.value, 4)} (expected ${num(Math.pow(10, -6 / 20), 4)})` : 'none'}`)
  check('setVolume returns the applied dB', volume === -6)
  check('setVolume schedules the linear gain', target !== undefined && Math.abs(target.value - Math.pow(10, -6 / 20)) < 1e-6)
  check('setVolume clamps high', live.api.setVolume(99) === 12)
  check('setVolume clamps low', live.api.setVolume(-999) === -60)
  check('setVolume ignores a non-number', live.api.setVolume('loud') === 0)
}

/* ------------------------------------------------------------------ demo -- */

console.log(`\n-- demo page --`)
{
  const demo = buildLiveDemoHtml({ presets: ['impact', 'tick'], scriptName: 'sfx.js', volumeDb: -3 })
  const inline = /<script>([\s\S]*?)<\/script>/.exec(demo)
  let inlineParses = false
  try { new Function(inline[1]); inlineParses = true } catch (error) { check('demo inline script parses', false, error.message) }
  const buttons = ['impact', 'tick'].filter((name) => demo.includes(`data-preset="${name}"`))
  console.log(`  direct builder: ${demo.length} B, script tag ${demo.includes('src="sfx.js"') ? 'sfx.js' : 'MISSING'}, buttons [${buttons.join(', ')}], inline script parses ${inlineParses}`)
  check('demo references the script by relative name', demo.includes('<script src="sfx.js"></script>'))
  check('demo buttons are wired by name', buttons.length === 2)
  check('demo inline script parses', inlineParses)
  check('demo drives dshLive', inline[1].includes('window.dshLive') && inline[1].includes('.play(') && inline[1].includes('.unlock()') && inline[1].includes('.stopAll()'))
  check('demo is network-free', !/https?:\/\/|@import|fetch\(|src="\/\//.test(demo))
  check('demo is a complete document', demo.startsWith('<!DOCTYPE html>') && demo.includes('</html>'))
}

/* ------------------------------------------------------------------ tool -- */

console.log(`\n-- audio_live tool --`)
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

check('registers exactly audio_live', [...registered.keys()].join(',') === 'audio_live', [...registered.keys()].join(','))
{
  const result = await call('audio_live', { presets: ['impact', 'tick'], seed: 4, maxVoices: 6, out: 'live/sfx', demo: true })
  const scriptText = await readFile(join(toolCwd, result.relativePath), 'utf8')
  const demoText = await readFile(join(toolCwd, result.demoRelativePath), 'utf8')
  const scriptStat = await stat(join(toolCwd, result.relativePath))
  console.log(`  wrote ${result.relativePath} (${result.bytes} B, stat ${scriptStat.size} B), demo ${result.demoRelativePath} (${result.demoBytes} B)`)
  console.log(`  text: ${result.text}`)
  check('script path has the requested name', result.relativePath === 'live/sfx.js', result.relativePath)
  check('file bytes match the summary', scriptStat.size === result.bytes && result.bytes === result.scriptBytes)
  check('written script is the built script', scriptText === buildLiveScript({ presets: ['impact', 'tick'], seed: 4, maxVoices: 6 }).script)
  check('demo path mirrors the script name', result.demoRelativePath === 'live/sfx.html', result.demoRelativePath)
  check('demo references only the script', demoText.includes('src="sfx.js"') && !/https?:\/\//.test(demoText))
  check('tool reports its presets', result.presets.join(',') === 'impact,tick' && result.presetCount === 2)
  check('tool reports per-preset bytes', Object.keys(result.presetBytes).sort().join(',') === 'impact,tick' && Object.values(result.presetBytes).every((bytes) => bytes > 0), JSON.stringify(result.presetBytes))
  check('tool reports the voice limit and seed', result.maxVoices === 6 && result.seed === 4)
  check('text is one actionable line', result.text.includes('Wrote in-page synth') && result.text.includes('live/sfx.js') && result.text.includes('no audio bytes'))
  const inline = /<script>([\s\S]*?)<\/script>/.exec(demoText)
  let parses = false
  try { new Function(inline[1]); parses = true } catch { /* reported below */ }
  check('written demo inline script parses', parses)
}
{
  const result = await call('audio_live', {})
  console.log(`  default out: ${result.relativePath} (${result.bytes} B), demo ${result.demoRelativePath}`)
  check('default output path is assets/audio/live-<hash>.js', /^assets\/audio\/live-[0-9a-f]+\.js$/.test(result.relativePath), result.relativePath)
  check('demo is off by default', result.demoPath === null && result.demoBytes === 0)
  check('default preset set is all nine', result.presets.length === 9)
  check('default maxVoices is 12', result.maxVoices === 12)
}
{
  const requested = ['tick', 'impact']
  const result = await call('audio_live', { presets: requested, maxVoices: 999, volumeDb: 99, out: 'live/canonical' })
  const text = await readFile(join(toolCwd, result.relativePath), 'utf8')
  console.log(`  reversed request -> presets [${result.presets.join(', ')}], clamped maxVoices ${result.maxVoices}, volumeDb ${result.volumeDb}`)
  check('summary reports canonical preset order', result.presets.join(',') === 'impact,tick')
  check('script content uses canonical order', text === buildLiveScript({ presets: requested, maxVoices: 64, volumeDb: 12 }).script)
  check('summary reports the clamped voice limit', result.maxVoices === 64)
  check('summary reports the clamped volume', result.volumeDb === 12)
}
{
  const result = await call('audio_live', { presets: ['tick'], out: 'live/page.html', demo: true })
  console.log(`  .html out -> script ${result.relativePath}, demo ${result.demoRelativePath}`)
  check('a demo never overwrites the script it demos', result.relativePath === 'live/page.html' && result.demoRelativePath === 'live/page.html.html', `${result.relativePath} / ${result.demoRelativePath}`)
}
{
  let message = ''
  try { await call('audio_live', { presets: ['wind'] }) } catch (error) { message = error.message }
  console.log(`  unknown preset error: ${message.slice(0, 100)}`)
  check('unknown preset is a hard error', /unknown live preset/.test(message) && /whoosh/.test(message), message)
  let emptyMessage = ''
  try { await call('audio_live', { presets: [] }) } catch (error) { emptyMessage = error.message }
  check('empty preset list is a hard error', /at least one preset/.test(emptyMessage), emptyMessage)
}

await rm(outDir, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: ${checks} checks — the in-page tier is valid, small and drives a fake WebAudio graph` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
