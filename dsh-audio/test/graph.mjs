/**
 * Synthesis-graph tests: the DSL, the validator, the renderer and the tool.
 *
 * The point of this file is evidence, not coverage theatre: every node type is
 * shown to do something measurable (a pitch tracker for the oscillator and its
 * vibrato, odd-harmonic growth for drive and FM, flatness for noise, a tail
 * ratio for reverb), every catalog example is fingerprinted so two sounds
 * cannot silently collapse into one, and the failure path is proven to be a
 * five-line list of document paths rather than a stack trace.
 *
 * Run: node test/graph.mjs   (non-zero exit on any failed check)
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSound } from '../lib/analyze.js'
import { finalize, measure, toWavBytes } from '../lib/audio.js'
import { GRAPH_SCHEMA, graphCatalog, renderGraph, validateGraph } from '../lib/graph.js'
import { registerGraphTools } from '../lib/tools-graph.js'
import { decodeWav } from '../lib/wav.js'

const SAMPLE_RATE = 44100
const NODE_TYPES = ['osc', 'noise', 'filter', 'env', 'lfo', 'gain', 'drive', 'ring', 'pan', 'reverb', 'sum']

let checks = 0
let failures = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}
const fmt = (value, digits = 2) => Number(value).toFixed(digits)
const pad = (value, width) => String(value).padStart(width)

/** One in-memory render with the test defaults. */
function render (graph, options = {}) {
  return renderGraph(graph, { duration: 1, sampleRate: SAMPLE_RATE, seed: 1, ...options })
}

/** RMS of a span of seconds. */
function rmsWindow (samples, sampleRate, from, to) {
  const start = Math.max(0, Math.floor(from * sampleRate))
  const end = Math.min(samples.length, Math.floor(to * sampleRate))
  let sum = 0
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, end - start))
}

/**
 * Instantaneous frequency from interpolated positive zero crossings.
 *
 * A plain zero-crossing count is quantised to whole samples (2 % error at
 * 440 Hz); interpolating the crossing between the two straddling samples gives
 * sub-sample resolution, which is what makes a 2 % vibrato visible as a pitch
 * deviation instead of sample noise.
 */
function pitchTrack (samples, sampleRate, from = 0.2, to = 0.8) {
  const start = Math.max(1, Math.floor(samples.length * from))
  const end = Math.min(samples.length, Math.floor(samples.length * to))
  const crossings = []
  for (let i = start; i < end; i += 1) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      const fraction = -samples[i - 1] / (samples[i] - samples[i - 1])
      crossings.push((i - 1 + fraction) / sampleRate)
    }
  }
  const frequencies = []
  for (let i = 1; i < crossings.length; i += 1) frequencies.push(1 / (crossings[i] - crossings[i - 1]))
  if (frequencies.length === 0) return { mean: 0, std: 0, count: 0 }
  const mean = frequencies.reduce((sum, value) => sum + value, 0) / frequencies.length
  const variance = frequencies.reduce((sum, value) => sum + (value - mean) ** 2, 0) / frequencies.length
  return { mean, std: Math.sqrt(variance), count: frequencies.length }
}

/** Amplitude at one frequency: a single-bin DFT (a cheap Goertzel). */
function toneAmplitude (samples, sampleRate, hz) {
  let real = 0
  let imag = 0
  const omega = 2 * Math.PI * hz / sampleRate
  for (let i = 0; i < samples.length; i += 1) {
    real += samples[i] * Math.cos(omega * i)
    imag += samples[i] * Math.sin(omega * i)
  }
  return Math.sqrt(real * real + imag * imag) / samples.length
}

/** Partials within `threshold` dB of the fundamental that a report can see. */
function harmonicCount (samples, f0Range, threshold = -45) {
  const report = analyzeSound(samples, SAMPLE_RATE, { maxHarmonics: 16, f0Range })
  return report.harmonics.filter((row) => row.relDb > threshold).length
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-graph-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition) } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'graph-test' } } }
registerGraphTools(ctx)
const tool = registered.get('audio_synth_graph')
const call = (args) => tool.execute(args, exec)

/* ------------------------------------------------------------------ dsl -- */

console.log('-- schema: one line per node type (fields in parentheses are optional) --')
console.log(`graph: { nodes: [...], output? } · limits: ${GRAPH_SCHEMA.limits.maxNodes} nodes, ${GRAPH_SCHEMA.limits.minDurationSeconds}..${GRAPH_SCHEMA.limits.maxDurationSeconds} s, ${GRAPH_SCHEMA.limits.minSampleRate}..${GRAPH_SCHEMA.limits.maxSampleRate} Hz, noise buffers <= ${GRAPH_SCHEMA.limits.maxNoiseBufferBytes / 1024 / 1024} MB`)
for (const type of NODE_TYPES) {
  const schema = GRAPH_SCHEMA.nodes[type]
  const fields = Object.entries(schema.fields)
    .map(([name, field]) => {
      if (field.type === 'number') return `${name} ${field.range[0]}..${field.range[1]}${field.required ? '*' : ''}`
      if (field.type === 'string') return `${name} ${field.values.join('|')}${field.required ? '*' : ''}`
      if (field.type === 'ref') return `${name} ref${field.required ? '*' : ''}`
      if (field.type === 'refs') return `${name} refs${field.required ? '*' : ''}`
      if (field.type === 'numbers') return `${name} dB[]`
      return `${name} {${Object.keys(field.fields).join(',')}}`
    })
    .join(', ')
  const optional = Object.entries(schema.fields)
    .filter(([, field]) => field.required !== true)
    .map(([name]) => name)
  console.log(`  ${type.padEnd(7)} ${fields}${optional.length > 0 ? `   (optional: ${optional.join(', ')})` : ''}`)
  check(`schema documents ${type}`, typeof schema.description === 'string' && schema.description.length > 20)
}
check('schema covers exactly the node types', Object.keys(GRAPH_SCHEMA.nodes).length === NODE_TYPES.length)
check('tool is registered as audio_synth_graph', tool !== undefined)
check('tool description names every node type', NODE_TYPES.every((type) => tool.description.includes(type)))
check('tool description explains references', /node id/i.test(tool.description) && /index/i.test(tool.description))
check('tool schema exposes graph and catalog', Object.keys(tool.parameters.properties).sort().join(',') === 'catalog,duration,graph,out,sampleRate,seed')

/* -------------------------------------------------------------- catalog -- */

console.log('\n-- catalog: every example renders, is audible and is its own sound --')
const catalog = graphCatalog()
const fingerprints = new Map()
console.log(`  ${'id'.padEnd(14)} ${pad('nodes', 5)} ${pad('dur', 5)} ${pad('peak', 7)} ${pad('rms', 7)} ${pad('crest', 6)} ${pad('centroid', 8)} ${pad('f0', 7)} ${pad('flat', 6)} ${pad('ms', 6)} fingerprint`)
for (const entry of catalog) {
  const checkResult = validateGraph(entry.graph, { duration: entry.duration })
  check(`catalog ${entry.id} validates`, checkResult.ok, JSON.stringify(checkResult.errors))
  check(`catalog ${entry.id} is within the node budget`, entry.graph.nodes.length <= GRAPH_SCHEMA.limits.maxNodes)
  const started = performance.now()
  const rendered = render(entry.graph, { duration: entry.duration, seed: entry.seed })
  const elapsed = performance.now() - started
  const metrics = measure(rendered.samples, rendered.sampleRate)
  const analysis = analyzeSound(rendered.samples, rendered.sampleRate)
  const finite = rendered.samples.every((value) => Number.isFinite(value))
  const peak = rendered.samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
  // The renderer is deliberately not peak-normalised (the gain and pan checks
  // need the real level), so a saturator followed by a reverb may run a few dB
  // hot; what has to be clean is the file, which the tool normalises to -1 dBFS.
  const delivered = measure(finalize(Float32Array.from(rendered.samples), rendered.sampleRate), rendered.sampleRate)
  const fingerprint = `c${metrics.centroidHz}/x${fmt(metrics.crestDb, 1)}`
  fingerprints.set(entry.id, fingerprint)
  check(`catalog ${entry.id} is finite`, finite)
  check(`catalog ${entry.id} is not silent`, metrics.rmsDbfs > -60, `rms=${metrics.rmsDbfs}`)
  check(`catalog ${entry.id} raw level is sane`, peak > 0.05 && peak <= 4, `peak=${fmt(peak, 3)} (${fmt(rendered.report.peakDbfs)} dBFS)`)
  check(`catalog ${entry.id} normalises to a clean file`, delivered.peakDbfs <= 0 && delivered.clipping === 0, `peak=${delivered.peakDbfs} clipping=${delivered.clipping}`)
  check(`catalog ${entry.id} length`, Math.abs(rendered.durationSeconds - entry.duration) < 0.001, rendered.durationSeconds)
  check(`catalog ${entry.id} report agrees with measure`, rendered.report.centroidHz === metrics.centroidHz, `${rendered.report.centroidHz} vs ${metrics.centroidHz}`)
  console.log(`  ${entry.id.padEnd(14)} ${pad(rendered.report.nodeCount, 5)} ${pad(fmt(rendered.durationSeconds, 1), 5)} ${pad(fmt(metrics.peakDbfs), 7)} ${pad(fmt(metrics.rmsDbfs), 7)} ${pad(fmt(metrics.crestDb, 1), 6)} ${pad(metrics.centroidHz, 8)} ${pad(fmt(analysis.f0.hz, 1), 7)} ${pad(fmt(analysis.flatness, 2), 6)} ${pad(fmt(elapsed, 1), 6)} ${fingerprint}`)
}
const uniqueFingerprints = new Set(fingerprints.values())
check('every catalog example is a distinct sound', uniqueFingerprints.size === catalog.length, [...fingerprints].map(([id, value]) => `${id}=${value}`).join(' '))
check('graphCatalog returns a fresh copy', (() => {
  const first = graphCatalog()
  first[0].graph.nodes[0].hz = 12345
  return graphCatalog()[0].graph.nodes[0].hz !== 12345
})())

/* ---------------------------------------------------------- determinism -- */

console.log('\n-- determinism --')
const noisyGraph = { nodes: [{ type: 'noise', color: 'pink' }, { type: 'filter', input: 0, mode: 'bp', hz: 900, q: 2 }] }
const seedA = renderGraph(noisyGraph, { duration: 1, seed: 7 })
const seedA2 = renderGraph(noisyGraph, { duration: 1, seed: 7 })
const seedB = renderGraph(noisyGraph, { duration: 1, seed: 8 })
const identicalSamples = seedA.samples.every((value, index) => value === seedA2.samples[index])
const identicalBytes = Buffer.compare(toWavBytes(seedA.samples, SAMPLE_RATE), toWavBytes(seedA2.samples, SAMPLE_RATE)) === 0
const differsBySeed = seedA.samples.some((value, index) => value !== seedB.samples[index])
const differing = seedA.samples.reduce((count, value, index) => count + (value !== seedB.samples[index] ? 1 : 0), 0)
console.log(`  same seed: samples identical=${identicalSamples} wav bytes identical=${identicalBytes}`)
console.log(`  seed 8 differs by ${differing}/${seedA.samples.length} samples (${fmt(100 * differing / seedA.samples.length, 1)}%)`)
check('same seed gives identical samples', identicalSamples)
check('same seed gives identical wav bytes', identicalBytes)
check('different seed gives different samples', differsBySeed)

const pureGraph = { nodes: [{ type: 'osc', wave: 'saw', hz: 220 }, { type: 'filter', input: 0, mode: 'lp', hz: 1200 }] }
const pureA = renderGraph(pureGraph, { duration: 0.5, seed: 1 })
const pureB = renderGraph(pureGraph, { duration: 0.5, seed: 99 })
const pureSame = pureA.samples.every((value, index) => value === pureB.samples[index])
console.log(`  oscillators only: seed 1 and 99 identical=${pureSame} (the seed only moves noise)`)
check('a graph without noise ignores the seed', pureSame)

/* ------------------------------------------------------ node behaviour -- */

console.log('\n-- node behaviour: does each node do what it says? --')

// osc: the fundamental must be where it was asked for, within 1 %.
{
  const sine = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }] })
  const saw = render({ nodes: [{ type: 'osc', wave: 'saw', hz: 440 }] })
  const sineF0 = analyzeSound(sine.samples, SAMPLE_RATE, { f0Range: [200, 900] }).f0
  const sawF0 = analyzeSound(saw.samples, SAMPLE_RATE, { f0Range: [200, 900] }).f0
  const sineError = Math.abs(sineF0.hz - 440) / 440 * 100
  const sawError = Math.abs(sawF0.hz - 440) / 440 * 100
  console.log(`  osc sine 440 -> f0 ${fmt(sineF0.hz, 2)} Hz (${fmt(sineError, 3)} % error, confidence ${sineF0.confidence})`)
  console.log(`  osc saw  440 -> f0 ${fmt(sawF0.hz, 2)} Hz (${fmt(sawError, 3)} % error), pitch power at 440 = ${fmt(toneAmplitude(saw.samples, SAMPLE_RATE, 440), 3)}`)
  check('osc sine 440 measures f0 440 within 1%', sineError <= 1, `${sineError}%`)
  check('osc saw 440 measures f0 440 within 1%', sawError <= 1, `${sawError}%`)
  check('detune moves the pitch', (() => {
    const sharp = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440, detuneCents: 100 }] })
    const sharpF0 = analyzeSound(sharp.samples, SAMPLE_RATE, { f0Range: [200, 1000] }).f0
    return Math.abs(sharpF0.hz - 440 * 2 ** (100 / 1200)) < 440 * 0.01
  })())
}

// filter: a low-pass has to remove top end, measured as a centroid drop.
{
  const dry = measure(render({ nodes: [{ type: 'osc', wave: 'saw', hz: 110 }] }).samples, SAMPLE_RATE)
  const wet = measure(render({ nodes: [{ type: 'osc', wave: 'saw', hz: 110 }, { type: 'filter', input: 0, mode: 'lp', hz: 500 }] }).samples, SAMPLE_RATE)
  console.log(`  filter lp 500 on a 110 Hz saw: centroid ${dry.centroidHz} Hz -> ${wet.centroidHz} Hz (${fmt(wet.centroidHz / dry.centroidHz * 100, 0)} %)`)
  check('filter lp 500 lowers the centroid', wet.centroidHz < dry.centroidHz * 0.7, `${dry.centroidHz} -> ${wet.centroidHz}`)
  const highPassed = measure(render({ nodes: [{ type: 'osc', wave: 'saw', hz: 110 }, { type: 'filter', input: 0, mode: 'hp', hz: 1500 }] }).samples, SAMPLE_RATE)
  console.log(`  filter hp 1500 on the same saw: centroid ${highPassed.centroidHz} Hz (raises it)`)
  check('filter hp raises the centroid', highPassed.centroidHz > dry.centroidHz * 1.2, `${dry.centroidHz} -> ${highPassed.centroidHz}`)
  const swept = render({ nodes: [{ type: 'osc', wave: 'saw', hz: 110 }, { type: 'filter', input: 0, mode: 'lp', hz: 300, sweepTo: 4000, sweepTime: 1 }] }, { duration: 1 })
  const early = measure(swept.samples.slice(0, 11025), SAMPLE_RATE)
  const late = measure(swept.samples.slice(33075, 44100), SAMPLE_RATE)
  console.log(`  filter sweep 300 -> 4000 Hz over 1 s: centroid ${early.centroidHz} Hz early, ${late.centroidHz} Hz late`)
  check('filter sweep opens the tone', late.centroidHz > early.centroidHz * 1.5, `${early.centroidHz} -> ${late.centroidHz}`)
}

// drive: saturation adds odd partials to a pure sine.
{
  const clean = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }] })
  const soft = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'drive', input: 0, amount: 0.9, kind: 'soft' }] })
  const hard = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'drive', input: 0, amount: 0.6, kind: 'hard' }] })
  const fold = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'drive', input: 0, amount: 0.9, kind: 'fold' }] })
  const cleanCount = harmonicCount(clean.samples, [150, 300])
  const softCount = harmonicCount(soft.samples, [150, 300])
  const hardCount = harmonicCount(hard.samples, [150, 300])
  const foldCount = harmonicCount(fold.samples, [150, 300])
  console.log(`  drive on a 220 Hz sine: partials clean=${cleanCount} soft=${softCount} hard=${hardCount} fold=${foldCount}`)
  console.log(`  crest: clean ${fmt(measure(clean.samples, SAMPLE_RATE).crestDb, 2)} dB -> driven ${fmt(measure(soft.samples, SAMPLE_RATE).crestDb, 2)} dB (saturating a sine flattens it)`)
  check('drive soft adds odd harmonics', softCount > cleanCount && softCount >= 4, `${cleanCount} -> ${softCount}`)
  check('drive hard adds odd harmonics', hardCount > cleanCount, `${cleanCount} -> ${hardCount}`)
  check('drive fold adds harmonics', foldCount > cleanCount, `${cleanCount} -> ${foldCount}`)
}

// fm: sidebands appear that a plain sine does not have.
{
  const carrier = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }] })
  const modulated = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440, fm: { hz: 440, depth: 600 } }] })
  const decaying = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 523.25, fm: { hz: 1831.4, depth: 620, decay: 0.3 } }] })
  const carrierCount = harmonicCount(carrier.samples, [300, 700])
  const modulatedCount = harmonicCount(modulated.samples, [300, 700])
  const sideband = toneAmplitude(modulated.samples, SAMPLE_RATE, 880)
  const coldSideband = toneAmplitude(carrier.samples, SAMPLE_RATE, 880)
  const strike = toneAmplitude(decaying.samples.slice(0, 4410), SAMPLE_RATE, 523.25)
  console.log(`  fm {hz 440, depth 600} on 440 Hz: partials ${carrierCount} -> ${modulatedCount}, energy at 880 Hz ${fmt(coldSideband, 4)} -> ${fmt(sideband, 4)}`)
  console.log(`  fm with decay on 523 Hz carrier: in-band energy in the first 100 ms = ${fmt(strike, 3)}`)
  check('fm adds sidebands (harmonic count grows)', modulatedCount > carrierCount, `${carrierCount} -> ${modulatedCount}`)
  check('fm decay still leaves a carrier', strike > 0.01, String(strike))
}

// noise: flatness is what separates noise from a tone.
{
  const results = {}
  for (const color of ['white', 'pink', 'brown']) {
    const rendered = render({ nodes: [{ type: 'noise', color }] }, { duration: 1 })
    results[color] = analyzeSound(rendered.samples, SAMPLE_RATE)
    results[color].centroid = measure(rendered.samples, SAMPLE_RATE).centroidHz
  }
  console.log(`  noise flatness: white ${fmt(results.white.flatness, 3)} (centroid ${results.white.centroid} Hz), pink ${fmt(results.pink.flatness, 3)} (${results.pink.centroid} Hz), brown ${fmt(results.brown.flatness, 3)} (${results.brown.centroid} Hz)`)
  check('noise white has flatness above 0.5', results.white.flatness > 0.5, String(results.white.flatness))
  check('noise colour ordering is white > pink > brown', results.white.flatness > results.pink.flatness && results.pink.flatness > results.brown.flatness)
  check('noise colour ordering is white > pink > brown (centroid)', results.white.centroid > results.pink.centroid && results.pink.centroid > results.brown.centroid)
  const banded = measure(render({ nodes: [{ type: 'noise', color: 'white', hz: 1000, q: 6 }] }).samples, SAMPLE_RATE)
  console.log(`  noise band-passed at 1000 Hz q 6: centroid ${banded.centroidHz} Hz`)
  check('noise hz band-limits the source', banded.centroidHz < results.white.centroid * 0.6, `${results.white.centroid} -> ${banded.centroidHz}`)
}

// lfo: vibrato is a measurable pitch deviation, tremolo a measurable level one.
{
  const steady = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }] }, { duration: 1.5 })
  const vibrato = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440, lfo: { hz: 5, depth: 0.02, target: 'pitch' } }] }, { duration: 1.5 })
  const steadyPitch = pitchTrack(steady.samples, SAMPLE_RATE)
  const vibratoPitch = pitchTrack(vibrato.samples, SAMPLE_RATE)
  console.log(`  lfo pitch 5 Hz depth 0.02: mean ${fmt(vibratoPitch.mean, 2)} Hz, std ${fmt(vibratoPitch.std, 3)} Hz (${vibratoPitch.count} cycles); without lfo std ${fmt(steadyPitch.std, 4)} Hz`)
  check('lfo on pitch produces measurable vibrato', vibratoPitch.std > 1, String(vibratoPitch.std))
  check('vibrato keeps the mean pitch', Math.abs(vibratoPitch.mean - 440) < 4, String(vibratoPitch.mean))
  check('no lfo means no vibrato', steadyPitch.std < 0.1, String(steadyPitch.std))
  const tremolo = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440, lfo: { hz: 4, depth: 1, target: 'amp' } }] }, { duration: 1 })
  let minimum = 1
  let maximum = 0
  for (let at = 0.2; at < 0.9; at += 0.02) {
    const level = rmsWindow(tremolo.samples, SAMPLE_RATE, at, at + 0.02)
    minimum = Math.min(minimum, level)
    maximum = Math.max(maximum, level)
  }
  const steadyLevel = rmsWindow(steady.samples, SAMPLE_RATE, 0.2, 0.9)
  console.log(`  lfo amp 4 Hz depth 1: 20 ms rms swings ${fmt(minimum, 3)}..${fmt(maximum, 3)} (steady ${fmt(steadyLevel, 3)})`)
  check('lfo on amp trembles the level', maximum > minimum * 10 && maximum > steadyLevel * 0.9, `${minimum}..${maximum}`)
}

// env: the attack and the sustain are both visible in the envelope.
{
  const slow = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'env', input: 0, attack: 0.3, decay: 0.1, sustain: 1, release: 0.2 }] })
  const pluck = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'env', input: 0, attack: 0.001, decay: 0.1, sustain: 0, release: 0.2 }] })
  const slowEarly = rmsWindow(slow.samples, SAMPLE_RATE, 0.01, 0.06)
  const pluckEarly = rmsWindow(pluck.samples, SAMPLE_RATE, 0.01, 0.06)
  const slowLate = rmsWindow(slow.samples, SAMPLE_RATE, 0.6, 0.7)
  const pluckLate = rmsWindow(pluck.samples, SAMPLE_RATE, 0.6, 0.7)
  console.log(`  env attack 300 ms vs 1 ms: rms at 10-60 ms ${fmt(slowEarly, 3)} vs ${fmt(pluckEarly, 3)}`)
  console.log(`  env sustain 1 vs 0: rms at 600-700 ms ${fmt(slowLate, 3)} vs ${fmt(pluckLate, 3)}`)
  check('env attack is slower than the control', slowEarly < pluckEarly * 0.6, `${slowEarly} vs ${pluckEarly}`)
  check('env sustain holds and a pluck decays', slowLate > 0.5 && pluckLate < 0.01, `${slowLate} vs ${pluckLate}`)
  check('env curve steepens the decay', (() => {
    const gentle = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'env', input: 0, attack: 0.001, decay: 0.5, sustain: 0, curve: 0.3 }] })
    const steep = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'env', input: 0, attack: 0.001, decay: 0.5, sustain: 0, curve: 4 }] })
    return rmsWindow(steep.samples, SAMPLE_RATE, 0.15, 0.25) < rmsWindow(gentle.samples, SAMPLE_RATE, 0.15, 0.25)
  })())
}

// ring: the sum and difference frequencies must appear.
{
  const carrier = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }] })
  const ringed = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'ring', input: 0, hz: 330, depth: 1 }] })
  const clean550 = toneAmplitude(carrier.samples, SAMPLE_RATE, 550)
  const ring550 = toneAmplitude(ringed.samples, SAMPLE_RATE, 550)
  const ring110 = toneAmplitude(ringed.samples, SAMPLE_RATE, 110)
  console.log(`  ring 330 Hz on a 220 Hz carrier: 550 Hz sideband ${fmt(clean550, 5)} -> ${fmt(ring550, 4)}, 110 Hz sideband ${fmt(ring110, 4)}`)
  check('ring modulation adds sidebands', ring550 > clean550 * 100 && ring110 > 0.05, `${clean550} -> ${ring550}`)
  check('ring depth 0 is transparent', (() => {
    const untouched = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 220 }, { type: 'ring', input: 0, hz: 330, depth: 0 }] })
    return untouched.samples.every((value, index) => Math.abs(value - carrier.samples[index]) < 1e-6)
  })())
}

// reverb: a tail after the dry sound has stopped.
{
  const dry = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'env', input: 0, attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 }] }, { duration: 1.5 })
  const wet = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'env', input: 0, attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 }, { type: 'reverb', input: 1, amount: 0.8, size: 0.8 }] }, { duration: 1.5 })
  const dryTail = rmsWindow(dry.samples, SAMPLE_RATE, 0.8, 1.4)
  const wetTail = rmsWindow(wet.samples, SAMPLE_RATE, 0.8, 1.4)
  console.log(`  reverb tail at 800-1400 ms: dry ${fmt(dryTail, 6)} -> wet ${fmt(wetTail, 6)} (${fmt(20 * Math.log10(wetTail / Math.max(dryTail, 1e-9)), 1)} dB)`)
  check('reverb leaves a tail after the dry sound stops', wetTail > dryTail * 10, `${dryTail} -> ${wetTail}`)
}

// gain, pan, sum: level tools must be numerically honest.
{
  const base = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }] })
  const quieter = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'gain', input: 0, db: -6 }] })
  const panned = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'pan', input: 0, pan: -1 }] })
  const gainDelta = quieter.report.peakDbfs - base.report.peakDbfs
  const panDelta = panned.report.peakDbfs - base.report.peakDbfs
  console.log(`  gain -6 dB: peak ${fmt(gainDelta, 3)} dB; pan hard left in mono: peak ${fmt(panDelta, 3)} dB (constant power, documented)`)
  check('gain -6 dB is -6 dB', Math.abs(gainDelta + 6) < 0.1, String(gainDelta))
  check('pan hard in mono is -3 dB', Math.abs(panDelta + 3.01) < 0.1, String(panDelta))
  const summed = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'osc', wave: 'sine', hz: 660 }, { type: 'sum', inputs: [0, 1], gains: [-6, 0] }] })
  const ratio = 20 * Math.log10(toneAmplitude(summed.samples, SAMPLE_RATE, 440) / toneAmplitude(summed.samples, SAMPLE_RATE, 660))
  console.log(`  sum gains [-6, 0]: 440 Hz sits ${fmt(ratio, 2)} dB against 660 Hz`)
  check('sum mixes both branches', toneAmplitude(summed.samples, SAMPLE_RATE, 660) > 0.1)
  check('sum per-input gains are exact', Math.abs(ratio + 6) < 0.1, String(ratio))
  check('sum of one input equals the input', (() => {
    const one = render({ nodes: [{ type: 'osc', wave: 'sine', hz: 440 }, { type: 'sum', inputs: [0] }] })
    return one.samples.every((value, index) => Math.abs(value - base.samples[index]) < 1e-6)
  })())
}

// References by id and by index are the same graph.
{
  const byIndex = render({ nodes: [{ type: 'osc', hz: 330 }, { type: 'filter', input: 0, mode: 'lp', hz: 800 }] })
  const byId = render({ nodes: [{ type: 'osc', id: 'tone', hz: 330 }, { type: 'filter', input: 'tone', mode: 'lp', hz: 800 }] })
  const byOutput = render({ nodes: [{ type: 'osc', id: 'tone', hz: 330 }, { type: 'filter', input: 'tone', mode: 'lp', hz: 800 }], output: 'n1' })
  check('ids and indices reference the same node', byIndex.samples.every((value, index) => value === byId.samples[index]))
  check('output accepts an id', byOutput.samples.every((value, index) => value === byIndex.samples[index]))
  check('output defaults to the last audio node', (() => {
    const explicit = render({ nodes: [{ type: 'osc', hz: 330 }, { type: 'osc', hz: 550 }], output: 1 })
    const implicit = render({ nodes: [{ type: 'osc', hz: 330 }, { type: 'osc', hz: 550 }] })
    return explicit.samples.every((value, index) => value === implicit.samples[index])
  })())
  check('a node modulated by an lfo node still validates', validateGraph({ nodes: [{ type: 'osc', hz: 440 }, { type: 'lfo', to: 'n0', hz: 5, depth: 0.1 }] }).ok)
  check('unreachable nodes are allowed but not rendered', (() => {
    const withDeadEnd = render({ nodes: [{ type: 'osc', hz: 330 }, { type: 'osc', hz: 990 }], output: 0 })
    const same = withDeadEnd.samples.length === SAMPLE_RATE && withDeadEnd.report.nodeCount === 2
    return same && validateGraph({ nodes: [{ type: 'osc', hz: 330 }, { type: 'osc', hz: 990 }], output: 0 }).ok
  })())
}

/* ----------------------------------------------------------- validation -- */

console.log('\n-- validation: readable errors with document paths --\n')
const invalidCases = [
  ['unknown node type', { nodes: [{ type: 'laser', hz: 440 }] }, /^nodes\[0\]\.type$/],
  ['NaN hz', { nodes: [{ type: 'osc', hz: NaN }] }, /^nodes\[0\]\.hz$/],
  ['Infinity hz', { nodes: [{ type: 'osc', hz: Infinity }] }, /^nodes\[0\]\.hz$/],
  ['string hz', { nodes: [{ type: 'osc', hz: '440' }] }, /^nodes\[0\]\.hz$/],
  ['out-of-range hz', { nodes: [{ type: 'osc', hz: 90000 }] }, /^nodes\[0\]\.hz$/],
  ['out-of-range q', { nodes: [{ type: 'osc', hz: 440 }, { type: 'filter', input: 0, hz: 500, q: 99 }] }, /^nodes\[1\]\.q$/],
  ['unknown field', { nodes: [{ type: 'osc', hz: 440, freq: 2 }] }, /^nodes\[0\]\.freq$/],
  ['cycle in sum', { nodes: [{ type: 'osc', hz: 440, id: 'a' }, { type: 'sum', id: 'b', inputs: ['c'] }, { type: 'sum', id: 'c', inputs: ['b'] }] }, /^nodes\[2\]\.inputs\[0\]$/],
  ['self cycle', { nodes: [{ type: 'sum', id: 'a', inputs: ['a'] }] }, /^nodes\[0\]\.inputs\[0\]$/],
  ['10 000 nodes', { nodes: Array.from({ length: 10000 }, () => ({ type: 'osc', hz: 440 })) }, /^nodes$/],
  ['noise buffer budget', { nodes: Array.from({ length: 64 }, () => ({ type: 'noise' })) }, /^nodes$/, { duration: 30, sampleRate: 96000 }],
  ['duration 1e9', { nodes: [{ type: 'osc', hz: 440 }] }, /^duration$/, { duration: 1e9 }],
  ['duration 0', { nodes: [{ type: 'osc', hz: 440 }] }, /^duration$/, { duration: 0 }],
  ['sampleRate 1', { nodes: [{ type: 'osc', hz: 440 }] }, /^sampleRate$/, { sampleRate: 1 }],
  ['hz above 0.45 x sampleRate', { nodes: [{ type: 'osc', hz: 5000 }] }, /^nodes\[0\]\.hz$/, { sampleRate: 8000 }],
  ['missing input', { nodes: [{ type: 'osc', hz: 440 }, { type: 'gain', db: -6 }] }, /^nodes\[1\]\.input$/],
  ['source with an input', { nodes: [{ type: 'osc', hz: 440 }, { type: 'noise', input: 0 }] }, /^nodes\[1\]\.input$/],
  ['bad reference', { nodes: [{ type: 'osc', hz: 440 }, { type: 'filter', input: 'nope', hz: 500 }] }, /^nodes\[1\]\.input$/],
  ['index out of range', { nodes: [{ type: 'osc', hz: 440 }, { type: 'filter', input: 5, hz: 500 }] }, /^nodes\[1\]\.input$/],
  ['lfo pitch on a filter', { nodes: [{ type: 'osc', hz: 440 }, { type: 'filter', input: 0, hz: 500 }, { type: 'lfo', to: 1, target: 'pitch', depth: 0.1 }] }, /^nodes\[2\]\.target$/],
  ['two lfos on one node', { nodes: [{ type: 'osc', hz: 440, lfo: { hz: 5, depth: 0.1 } }, { type: 'lfo', to: 0, hz: 3, depth: 0.2 }] }, /^nodes\[1\]$/],
  ['sum gains length', { nodes: [{ type: 'osc', hz: 440 }, { type: 'sum', inputs: [0], gains: [0, -3] }] }, /^nodes\[1\]\.gains$/],
  ['output is an lfo', { nodes: [{ type: 'osc', hz: 440 }, { type: 'lfo', to: 0, hz: 5, depth: 0.1 }], output: 1 }, /^output$/],
  ['duration inside the graph', { nodes: [{ type: 'osc', hz: 440 }], duration: 2 }, /^duration$/],
  ['empty nodes', { nodes: [] }, /^nodes$/],
  ['not an object', null, /^graph$/]
]
for (const [label, spec, expectedPath, options] of invalidCases) {
  const result = validateGraph(spec, options)
  const first = result.errors[0] ?? { path: '(none)', message: '(no error)' }
  check(`rejects ${label}`, !result.ok && result.errors.length > 0, `${result.ok} ${result.errors.length}`)
  check(`names ${label} by path`, expectedPath.test(first.path), `${first.path}: ${first.message}`)
  check(`${label} message is readable`, first.message.length > 10 && !/undefined|\[object/.test(first.message), first.message)
  console.log(`  ${label.padEnd(24)} ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}  ${first.path}: ${first.message}`)
}

// A graph with several mistakes must report several, not stop at the first.
{
  const broken = {
    nodes: [
      { type: 'osc', hz: NaN },
      { type: 'osc', hz: 'x' },
      { type: 'osc', hz: -1 },
      { type: 'osc', hz: 440, wave: 'noise' },
      { type: 'drive', input: 0, amount: 9 },
      { type: 'osc', hz: 440, foo: 1 },
      { type: 'osc', hz: 1e9 }
    ]
  }
  const result = validateGraph(broken)
  const paths = result.errors.map((error) => error.path)
  console.log(`  many mistakes -> ${result.errors.length} errors: ${paths.join(', ')}`)
  check('collects one error per problem', result.errors.length === 7, String(result.errors.length))
  check('every problem has its own path', new Set(paths).size === paths.length)
}

// Valid documents must stay valid: the validator has to be able to say yes.
{
  const valid = [
    ['all eleven node types', {
      nodes: [
        { type: 'osc', id: 'tone', hz: 220 },
        { type: 'noise', color: 'pink' },
        { type: 'lfo', to: 'tone', hz: 5, depth: 0.05, target: 'pitch' },
        { type: 'filter', input: 'tone', mode: 'bp', hz: 800, q: 2, sweepTo: 1600, sweepTime: 0.8 },
        { type: 'env', input: 3, attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.1, curve: 1.5 },
        { type: 'gain', input: 4, db: -3 },
        { type: 'drive', input: 5, amount: 0.2, kind: 'fold' },
        { type: 'ring', input: 6, hz: 330, depth: 0.5 },
        { type: 'pan', input: 7, pan: 0 },
        { type: 'reverb', input: 8, amount: 0.3, size: 0.5 },
        { type: 'sum', inputs: [1, 9], gains: [-6, 0] }
      ],
      output: 10
    }],
    ['inline lfo shorthand', { nodes: [{ type: 'osc', hz: 440, lfo: { hz: 4, depth: 0.1 } }] }],
    ['16-way sum', { nodes: [Object.assign({ type: 'osc', hz: 220 }, {}), { type: 'sum', inputs: Array.from({ length: 16 }, () => 0) }] }],
    ['minimum duration', { nodes: [{ type: 'osc', hz: 440 }] }, { duration: 0.008 }],
    ['maximum budget', { nodes: Array.from({ length: 64 }, () => ({ type: 'osc', hz: 440 })), output: 63 }]
  ]
  for (const [label, spec, options] of valid) {
    const result = validateGraph(spec, options)
    check(`accepts ${label}`, result.ok, JSON.stringify(result.errors).slice(0, 160))
  }
  const everyType = validateGraph(valid[0][1])
  console.log(`  all eleven node types in one graph: ok=${everyType.ok}${everyType.ok ? ' (rendered below)' : ''}`)
  const rendered = render(valid[0][1], { duration: 0.5 })
  check('all node types render together', rendered.samples.every((value) => Number.isFinite(value)) && rendered.report.rmsDbfs > -60, JSON.stringify(rendered.report))
  console.log(`  all-node graph: ${rendered.report.nodeCount} nodes, peak ${fmt(rendered.report.peakDbfs)} dBFS, rms ${fmt(rendered.report.rmsDbfs)} dBFS, centroid ${rendered.report.centroidHz} Hz`)
}

/* -------------------------------------------------- budget without alloc -- */

console.log('\n-- budgets: rejected before a single audio buffer exists --')
const hugeGraph = { nodes: Array.from({ length: 10000 }, () => ({ type: 'osc', hz: 440 })) }
const time = (fn) => {
  const started = performance.now()
  try { fn() } catch { /* the throw is the expected outcome */ }
  return performance.now() - started
}
const validateHuge = time(() => validateGraph(hugeGraph))
const renderHuge = time(() => renderGraph(hugeGraph, { duration: 1 }))
const renderEons = time(() => renderGraph({ nodes: [{ type: 'osc', hz: 440 }] }, { duration: 1e9 }))
const validateValid = time(() => validateGraph(catalog[3].graph, { duration: catalog[3].duration }))
console.log(`  validateGraph(10 000 nodes)          ${fmt(validateHuge, 3)} ms`)
console.log(`  renderGraph(10 000 nodes)            ${fmt(renderHuge, 3)} ms  (throws: no buffer is allocated)`)
console.log(`  renderGraph(duration 1e9)            ${fmt(renderEons, 3)} ms  (throws: no buffer is allocated)`)
console.log(`  validateGraph(valid ${catalog[3].graph.nodes.length}-node graph) ${fmt(validateValid, 3)} ms`)
check('validation of 10 000 nodes is under 5 ms', validateHuge < 5, `${validateHuge} ms`)
check('renderGraph rejects 10 000 nodes before allocating', renderHuge < 5, `${renderHuge} ms`)
check('renderGraph rejects duration 1e9 before allocating', renderEons < 5, `${renderEons} ms`)
check('validating a real graph is well under 5 ms', validateValid < 5, `${validateValid} ms`)

/* ------------------------------------------------------------ performance -- */

console.log('\n-- performance --')
const performanceGraphs = [
  ['metal-clang 16-node graph', catalog.find((entry) => entry.id === 'metal-clang').graph, 3],
  ['folded-drone 8-node graph', catalog.find((entry) => entry.id === 'folded-drone').graph, 3]
]
for (const [label, graph, seconds] of performanceGraphs) {
  render(graph, { duration: seconds, sampleRate: SAMPLE_RATE }) // warm up JIT and FFT tables
  const started = performance.now()
  const rendered = renderGraph(graph, { duration: seconds, sampleRate: SAMPLE_RATE, seed: 1 })
  const elapsed = performance.now() - started
  const frames = rendered.samples.length
  console.log(`  ${label.padEnd(28)} ${seconds} s mono @ ${SAMPLE_RATE} Hz = ${frames} frames, ${rendered.report.nodeCount} nodes: ${fmt(elapsed, 2)} ms (${fmt(seconds * 1000 / elapsed, 0)}x realtime)`)
  check(`${label} renders 3 s under 200 ms`, elapsed < 200, `${elapsed} ms`)
  check(`${label} fills the requested length`, frames === seconds * SAMPLE_RATE, String(frames))
  check(`${label} reports honest numbers`, Number.isFinite(rendered.report.peakDbfs) && rendered.report.centroidHz > 0, JSON.stringify(rendered.report))
}

/* --------------------------------------------------------------- tool -- */

console.log('\n-- tool layer: audio_synth_graph --')
{
  const fmBell = catalog.find((entry) => entry.id === 'fm-bell')
  const catalogCall = await call({ catalog: 'fm-bell', out: 'renders/bell.wav' })
  console.log(`  ${catalogCall.text}`)
  check('catalog shortcut writes the requested path', catalogCall.relativePath === 'renders/bell.wav', catalogCall.relativePath)
  check('catalog shortcut reports the node count', catalogCall.nodeCount === fmBell.graph.nodes.length, String(catalogCall.nodeCount))
  check('catalog shortcut reports the catalog id', catalogCall.catalogId === 'fm-bell', String(catalogCall.catalogId))
  check('catalog shortcut uses the example duration', Math.abs(catalogCall.durationSeconds - fmBell.duration) < 0.001, String(catalogCall.durationSeconds))
  check('metrics come back populated', catalogCall.metrics.peakDbfs > -3 && catalogCall.metrics.clipping === 0 && catalogCall.metrics.centroidHz > 0, JSON.stringify(catalogCall.metrics))

  // The file on disk must be exactly what the renderer produced in memory.
  const written = await readFile(join(cwd, 'renders/bell.wav'))
  const fresh = renderGraph(fmBell.graph, { duration: fmBell.duration, seed: fmBell.seed, sampleRate: SAMPLE_RATE })
  finalize(fresh.samples, SAMPLE_RATE, -1)
  const expected = toWavBytes(fresh.samples, SAMPLE_RATE)
  const decoded = decodeWav(written)
  const fileMetrics = measure(decoded.channels[0], decoded.sampleRate)
  console.log(`  file: ${written.length} bytes, decoded ${fmt(decoded.durationSeconds, 3)} s @ ${decoded.sampleRate} Hz, ${decoded.channels.length} channel(s)`)
  console.log(`  decoded peak ${fmt(fileMetrics.peakDbfs)} dBFS / centroid ${fileMetrics.centroidHz} Hz vs tool ${fmt(catalogCall.metrics.peakDbfs)} dBFS / ${catalogCall.metrics.centroidHz} Hz`)
  check('written file is byte-identical to the in-memory render', Buffer.compare(written, expected) === 0, `${written.length} vs ${expected.length} bytes`)
  check('written file decodes', decoded.channels.length === 1 && decoded.sampleRate === SAMPLE_RATE)
  check('decoded duration matches the summary', Math.abs(decoded.durationSeconds - catalogCall.durationSeconds) < 0.001)
  check('decoded metrics match the summary', Math.abs(fileMetrics.peakDbfs - catalogCall.metrics.peakDbfs) < 0.1 && Math.abs(fileMetrics.centroidHz - catalogCall.metrics.centroidHz) <= 1)

  // The shortcut and the equivalent explicit graph are one sound, one file name.
  const explicit = await call({ graph: fmBell.graph, duration: fmBell.duration, seed: fmBell.seed, out: 'renders/bell-explicit.wav' })
  const explicitBytes = await readFile(join(cwd, 'renders/bell-explicit.wav'))
  const defaultPath = await call({ catalog: 'glassy-pluck' })
  console.log(`  explicit graph: ${explicit.nodeCount} nodes, ${explicit.bytes} bytes; default output landed at ${defaultPath.relativePath}`)
  check('catalog and explicit graph render identical bytes', Buffer.compare(written, explicitBytes) === 0 && explicit.bytes === catalogCall.bytes)
  check('default output path is assets/audio/<id>-<hash>.wav', /^assets\/audio\/glassy-pluck-[0-9a-f]{12}\.wav$/.test(defaultPath.relativePath), defaultPath.relativePath)
  check('default output file exists', (await readFile(join(cwd, defaultPath.relativePath))).length === defaultPath.bytes)

  // Invalid DSL: one readable message, first five paths, no stack.
  const broken = {
    nodes: [
      { type: 'osc', hz: NaN },
      { type: 'osc', hz: 'x' },
      { type: 'osc', hz: -1 },
      { type: 'osc', hz: 440, wave: 'noise' },
      { type: 'drive', input: 0, amount: 9 },
      { type: 'osc', hz: 440, foo: 1 },
      { type: 'osc', hz: 1e9 }
    ]
  }
  let brokenMessage = ''
  const filesBeforeBroken = new Set(await readdir(join(cwd, 'assets/audio')))
  try { await call({ graph: broken }) } catch (error) { brokenMessage = error.message }
  const filesAfterBroken = new Set(await readdir(join(cwd, 'assets/audio')))
  console.log(`  invalid graph -> ${brokenMessage}`)
  const shownPaths = brokenMessage.match(/nodes\[\d+\]/g) ?? []
  check('invalid graph rejects', brokenMessage.length > 0)
  check('invalid graph message lists paths', shownPaths.length === 5, String(shownPaths.length))
  check('invalid graph message says how many remain', /and 2 more/.test(brokenMessage), brokenMessage)
  check('invalid graph message is one line, not a stack', !/\n\s+at /.test(brokenMessage) && brokenMessage.split('\n').length === 1)
  check('invalid graph message names the tool', brokenMessage.startsWith('audio_synth_graph:'), brokenMessage.slice(0, 40))
  check('invalid graph writes no file', filesBeforeBroken.size === filesAfterBroken.size && [...filesAfterBroken].every((name) => filesBeforeBroken.has(name)))

  // Argument guards.
  const rejects = async (label, args, pattern) => {
    let message = ''
    try { await call(args) } catch (error) { message = error.message }
    check(label, pattern.test(message), message)
    console.log(`  ${label.padEnd(28)} ${message.slice(0, 150)}`)
  }
  await rejects('neither graph nor catalog', {}, /needs a `graph`/)
  await rejects('unknown catalog id', { catalog: 'nope' }, /unknown catalog id "nope"/)
  await rejects('both graph and catalog', { catalog: 'fm-bell', graph: { nodes: [{ type: 'osc', hz: 440 }] } }, /not both/)
  await rejects('unknown node type', { graph: { nodes: [{ type: 'laser', hz: 440 }] } }, /nodes\[0\]\.type: unknown node type "laser"/)
  await rejects('cycle in sum', { graph: { nodes: [{ type: 'sum', id: 'a', inputs: ['b'] }, { type: 'sum', id: 'b', inputs: ['a'] }] } }, /cycle: a -> b -> a/)
  await rejects('duration out of budget', { graph: { nodes: [{ type: 'osc', hz: 440 }] }, duration: 1e9 }, /duration: must be a finite number of seconds/)
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: ${checks} checks passed` : `\nFAILED: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
