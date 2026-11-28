/**
 * Composition engine tests.
 *
 * This file is the evidence for the two hardest claims the engine makes:
 *
 * 1. It is deterministic — same request, byte-identical WAV.
 * 2. It makes music rather than noise with a beat — harmony is diatonic, the
 *    lead is monophonic and phrased, the bass sits under the harmony, the mix is
 *    levelled, and the eight genres actually differ in spectral centroid, onset
 *    density and low-frequency weight.
 *
 * It also measures the timing contract (beatMap, first onset, tempo) and the
 * performance budget. `test/perf.mjs` is the performance gate (600 ms for the
 * slowest 16-bar cue, measured best-of-2, with a before/after table); this file
 * keeps a single-shot sweep assertion because the same renders already exist
 * here, and 700 ms absorbs the extra JIT/GC noise of a one-shot measurement.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measure } from '../lib/audio.js'
import {
  CHORD_QUALITIES,
  DRUM_PATTERNS,
  GENRES,
  KEYS,
  MODES,
  SCALES,
  composeScore,
  renderScore,
  toComposeWavBytes
} from '../lib/compose.js'
import { decodeWav } from '../lib/wav.js'
import { registerComposeTools } from '../lib/tools-compose.js'

const GENRE_NAMES = Object.keys(GENRES)

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const fmt = (value, digits = 1) => Number(value).toFixed(digits)
const median = (values) => {
  if (values.length === 0) return NaN
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const maxAbs = (samples) => {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return peak
}
const countNaNs = (samples) => {
  let count = 0
  for (const sample of samples) if (!Number.isFinite(sample)) count += 1
  return count
}

/**
 * Onset detector used throughout: 20 ms RMS windows on a 5 ms hop, an onset is
 * a 1.7x jump over two hops with an 80 ms refractory. The first window counts
 * as an onset when the cue starts loud (it always does: the downbeat is on beat
 * 0), which is what `measure()` cannot report because it returns only a count.
 */
function onsetTimes (samples, sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate * 0.005))
  const window = hop * 4
  const peak = maxAbs(samples)
  const energy = []
  for (let start = 0; start + window <= samples.length; start += hop) {
    let sum = 0
    for (let index = 0; index < window; index += 1) sum += samples[start + index] * samples[start + index]
    energy.push(Math.sqrt(sum / window))
  }
  const floor = peak * 0.012
  const onsets = []
  if (energy.length > 0 && energy[0] > floor) onsets.push(0)
  const refractory = Math.round(0.08 / 0.005)
  let last = 0
  for (let index = 2; index < energy.length; index += 1) {
    if (energy[index] > energy[index - 2] * 1.7 && energy[index] > floor && index - last > refractory) {
      onsets.push(index * 0.005)
      last = index
    }
  }
  return onsets
}

/** Low-band (kick) onsets: two cascaded one-pole low-passes, then energy jumps. */
function lowBandOnsets (samples, sampleRate) {
  const alpha = 1 - Math.exp(-2 * Math.PI * 120 / sampleRate)
  const filtered = new Float32Array(samples.length)
  let first = 0
  let second = 0
  for (let index = 0; index < samples.length; index += 1) {
    first += (samples[index] - first) * alpha
    second += (first - second) * alpha
    filtered[index] = second
  }
  const hop = Math.max(1, Math.round(sampleRate * 0.01))
  const window = hop * 2
  const peak = maxAbs(filtered)
  const energy = []
  for (let start = 0; start + window <= filtered.length; start += hop) {
    let sum = 0
    for (let index = 0; index < window; index += 1) sum += filtered[start + index] * filtered[start + index]
    energy.push(Math.sqrt(sum / window))
  }
  const onsets = []
  if (energy.length > 0 && energy[0] > peak * 0.08) onsets.push(0)
  const refractory = Math.round(0.12 / 0.01)
  let last = -1e9
  for (let index = 1; index < energy.length; index += 1) {
    if (energy[index] > energy[index - 1] * 1.6 && energy[index] > peak * 0.08 && index - last > refractory) {
      onsets.push(index * 0.01)
      last = index
    }
  }
  return onsets
}

/**
 * Trill detector: a rapid narrow A-B-A figure. Wider A-B-A shapes are normal
 * music (arpeggios and neighbour figures), so only alternations of two
 * semitones or less inside a beat and a half count as the algorithmic tell.
 */
function countTrills (melody, beatsPerBar) {
  let trills = 0
  for (let index = 2; index < melody.length; index += 1) {
    const first = melody[index - 2]
    const middle = melody[index - 1]
    const last = melody[index]
    if (last.midi !== first.midi || middle.midi === first.midi) continue
    const pitchGap = Math.abs(first.midi - middle.midi)
    const timeGap = (last.bar * beatsPerBar + last.beat) - (first.bar * beatsPerBar + first.beat)
    const shortNotes = Math.min(first.durBeats, last.durBeats) <= 1 && middle.durBeats <= 1.5
    if (pitchGap <= 2 && timeGap <= 1.5 && shortNotes) trills += 1
  }
  return trills
}

/** Whole-file band balance, a stabler "how dark is this" than one loud window. */
function bandBalance (samples, sampleRate) {
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 200 / sampleRate)
  const highAlpha = 1 - Math.exp(-2 * Math.PI * 2000 / sampleRate)
  let lowpass = 0
  let highpassState = 0
  let low = 0
  let mid = 0
  let high = 0
  for (const sample of samples) {
    lowpass += (sample - lowpass) * lowAlpha
    const residual = sample - lowpass
    highpassState += (residual - highpassState) * highAlpha
    high += highpassState * highpassState
    mid += (residual - highpassState) * (residual - highpassState)
    low += lowpass * lowpass
  }
  const total = low + mid + high
  return { low: low / total, mid: mid / total, high: high / total }
}

console.log('engine tables')
console.log(`  scales: ${Object.keys(SCALES).length}, modes: ${Object.keys(MODES).length}, chord qualities: ${Object.keys(CHORD_QUALITIES).length}`)
console.log(`  genres: ${GENRE_NAMES.join(', ')}`)
console.log(`  drum patterns: ${Object.keys(DRUM_PATTERNS).length}`)
check('eight genres', GENRE_NAMES.length === 8, String(GENRE_NAMES.length))
for (const genre of GENRE_NAMES) {
  const spec = GENRES[genre]
  const tracks = Object.keys(spec.tracks)
  check(`${genre} has five tracks`, tracks.length === 5, tracks.join(','))
  const pattern = DRUM_PATTERNS[spec.drums]
  check(`${genre} drum pattern exists`, pattern !== undefined, String(spec.drums))
  check(`${genre} every drum layer is a 16-step bar`, pattern.layers.every((layer) => layer.steps.length === 16),
    pattern.layers.map((layer) => layer.steps.length).join(','))
}

/* --------------------------------------------------------- determinism -- */

console.log('\ndeterminism')
{
  const request = { genre: 'lofi', bpm: 84, bars: 8, key: 'G', mode: 'dorian', seed: 42, intensity: 0.7 }
  const scoreA = composeScore(request)
  const scoreB = composeScore(request)
  check('same request gives the same score', JSON.stringify(scoreA) === JSON.stringify(scoreB))
  const renderA = renderScore(scoreA)
  const renderB = renderScore(scoreB)
  check('same score gives the same samples',
    renderA.samples.length === renderB.samples.length && renderA.samples.every((value, index) => value === renderB.samples[index]))
  const bytesA = toComposeWavBytes(renderA.samples, renderA.sampleRate, scoreA.seed)
  const bytesB = toComposeWavBytes(renderB.samples, renderB.sampleRate, scoreB.seed)
  check('same render gives byte-identical wav', bytesA.length === bytesB.length && bytesA.equals(bytesB),
    `${bytesA.length} vs ${bytesB.length}`)
  const decoded = decodeWav(bytesA)
  check('wav roundtrip duration', Math.abs(decoded.durationSeconds - renderA.durationSeconds) < 0.01)
  const scoreC = composeScore({ ...request, seed: 43 })
  check('a different seed gives a different score', JSON.stringify(scoreA) !== JSON.stringify(scoreC))
  const renderC = renderScore(scoreC)
  let differs = false
  for (let index = 0; index < Math.min(renderA.samples.length, renderC.samples.length); index += 1) {
    if (renderA.samples[index] !== renderC.samples[index]) { differs = true; break }
  }
  check('a different seed gives different audio', differs)
  console.log(`  same request -> ${bytesA.length} identical bytes; seed 43 differs`)
}

/* -------------------------------------------------------- genre sweep -- */

// Warm every voice path before timing anything: a cold first render of an
// instrument spends 20-40% of its wall clock in JIT compilation, which would
// make the sweep timings below a report about the compiler instead of the
// engine. Two bars are enough to compile every oscillator, drum and noise path.
for (const genre of GENRE_NAMES) renderScore(composeScore({ genre, bars: 2, seed: 7, intensity: 0.65 }))

console.log('\ngenre sweep: 16 bars, seed 7, 44.1 kHz')
const rows = {}
for (const genre of GENRE_NAMES) {
  const request = { genre, bars: 16, seed: 7, intensity: 0.65 }
  const composeStart = process.hrtime.bigint()
  const score = composeScore(request)
  const composeEnd = process.hrtime.bigint()
  const render = renderScore(score)
  const renderEnd = process.hrtime.bigint()
  const metrics = measure(render.samples, render.sampleRate)
  const onsets = onsetTimes(render.samples, render.sampleRate)
  const balance = bandBalance(render.samples, render.sampleRate)
  rows[genre] = {
    score,
    render,
    metrics,
    onsets,
    balance,
    composeMs: Number(composeEnd - composeStart) / 1e6,
    renderMs: Number(renderEnd - composeEnd) / 1e6
  }
  const secondsPerBeat = 60 / score.bpm
  console.log(
    `${genre.padEnd(10)} dur ${String(metrics.durationSeconds).padStart(6)}s  peak ${String(metrics.peakDbfs).padStart(5)} dBFS  ` +
    `rms ${String(metrics.rmsDbfs).padStart(6)} dBFS  crest ${String(metrics.crestDb).padStart(5)} dB  ` +
    `centroid ${String(metrics.centroidHz).padStart(4)} Hz  onsets ${String(onsets.length).padStart(3)}  ` +
    `low ${fmt(balance.low * 100, 0).padStart(3)}%  compose ${fmt(rows[genre].composeMs, 1)} ms  render ${fmt(rows[genre].renderMs, 0)} ms`
  )

  // Structure and timing contract.
  check(`${genre} five tracks`, score.tracks.length === 5, String(score.tracks.length))
  check(`${genre} beatMap length`, score.beatMap.length === score.bars * score.beatsPerBar,
    `${score.beatMap.length} vs ${score.bars * score.beatsPerBar}`)
  check(`${genre} beat spacing`, Math.abs((score.beatMap[1] - score.beatMap[0]) - secondsPerBeat) < 1e-3,
    String(score.beatMap[1] - score.beatMap[0]))
  check(`${genre} barMap length`, score.barMap.length === score.bars + 1)
  const firstOnset = onsets[0] ?? Infinity
  check(`${genre} first onset on beat 0 (<= 50 ms)`, firstOnset <= 0.05, `${(firstOnset * 1000).toFixed(0)} ms`)
  check(`${genre} duration matches bars`, metrics.durationSeconds > score.bars * score.beatsPerBar * secondsPerBeat - 0.01)
  // Single-shot budget: the steady-state gate (600 ms best-of-2) lives in
  // test/perf.mjs; a cold-ish single render gets 100 ms of slack for JIT/GC.
  check(`${genre} render under 700 ms`, rows[genre].renderMs < 700, `${fmt(rows[genre].renderMs, 0)} ms`)

  // Audio hygiene.
  check(`${genre} no NaN`, countNaNs(render.samples) === 0)
  check(`${genre} no clipping`, metrics.clipping === 0, String(metrics.clipping))
  check(`${genre} peak <= 0 dBFS`, metrics.peakDbfs <= 0.01, String(metrics.peakDbfs))
  check(`${genre} dc offset small`, Math.abs(metrics.dcOffset) <= 0.02, String(metrics.dcOffset))
  check(`${genre} audible`, metrics.rmsDbfs > -40, String(metrics.rmsDbfs))

  // Mix: every track sits at its stated target level in the finished file.
  const trackShift = render.trackStats.length > 0
    ? render.trackStats[0].rmsDbfs - render.trackStats[0].targetDbfs
    : 0
  check(`${genre} track levels hit their targets`,
    render.trackStats.every((track) => Math.abs(track.rmsDbfs - track.targetDbfs - trackShift) < 0.6),
    render.trackStats.map((track) => `${track.id}:${track.rmsDbfs}/${track.targetDbfs}`).join(' '))
  check(`${genre} track peaks stay under 0 dBFS`,
    render.trackStats.every((track) => track.peakDbfs <= 0.01),
    render.trackStats.map((track) => `${track.id}:${track.peakDbfs}`).join(' '))
  check(`${genre} sections have stats`, render.sectionStats.length === score.sections.length)
}

/* ------------------------------------------- genres must actually differ -- */

console.log('\ngenre differentiation')
const lofi = rows.lofi.metrics
const chiptune = rows.chiptune.metrics
console.log(`  lofi centroid ${lofi.centroidHz} Hz vs chiptune ${chiptune.centroidHz} Hz (${fmt(chiptune.centroidHz / lofi.centroidHz, 2)}x brighter)`)
check('lofi is far darker than chiptune', lofi.centroidHz * 2 < chiptune.centroidHz,
  `${lofi.centroidHz} vs ${chiptune.centroidHz}`)
console.log(`  action onsets ${rows.action.onsets.length} vs ambient ${rows.ambient.onsets.length} (${fmt(rows.action.onsets.length / Math.max(1, rows.ambient.onsets.length), 1)}x denser)`)
check('action is far busier than ambient', rows.action.onsets.length > rows.ambient.onsets.length * 3,
  `${rows.action.onsets.length} vs ${rows.ambient.onsets.length}`)

// Every pair must be distinguishable by at least one of: brightness, onset
// density, low-frequency weight.
let distinguishablePairs = 0
let totalPairs = 0
let mostSimilarPair = ''
let mostSimilarScore = Infinity
for (let first = 0; first < GENRE_NAMES.length; first += 1) {
  for (let second = first + 1; second < GENRE_NAMES.length; second += 1) {
    const a = rows[GENRE_NAMES[first]]
    const b = rows[GENRE_NAMES[second]]
    totalPairs += 1
    const centroidRatio = Math.max(a.metrics.centroidHz, 1) / Math.max(b.metrics.centroidHz, 1)
    const onsetRatio = Math.max(a.onsets.length, 1) / Math.max(b.onsets.length, 1)
    const lowRatio = Math.max(a.balance.low, 0.001) / Math.max(b.balance.low, 0.001)
    const ratio = (value) => Math.max(value, 1 / value)
    const verdict = ratio(centroidRatio) > 1.25 || ratio(onsetRatio) > 1.5 || ratio(lowRatio) > 1.2
    if (verdict) distinguishablePairs += 1
    const similarity = Math.min(ratio(centroidRatio) * 5, ratio(onsetRatio), ratio(lowRatio) * 3)
    if (similarity < mostSimilarScore) {
      mostSimilarScore = similarity
      mostSimilarPair = `${GENRE_NAMES[first]}/${GENRE_NAMES[second]} (centroid x${fmt(ratio(centroidRatio), 2)}, onsets x${fmt(ratio(onsetRatio), 2)}, low x${fmt(ratio(lowRatio), 2)})`
    }
  }
}
console.log(`  ${distinguishablePairs}/${totalPairs} genre pairs differ measurably; closest pair: ${mostSimilarPair}`)
check('every genre pair is audibly different', distinguishablePairs === totalPairs,
  `${distinguishablePairs}/${totalPairs}`)

/* ------------------------------------------------------- musicality -- */

console.log('\nmusicality invariants')
let worstMotion = 0
let worstRange = 0
let minVelocityVariety = Infinity
let minMelodyNotes = Infinity
const allArticulations = new Set()
for (const genre of GENRE_NAMES) {
  const score = rows[genre].score
  const keyPc = KEYS[score.key]
  const harmonyScale = SCALES[MODES[score.mode].harmony].intervals
  const scalePcs = new Set(harmonyScale.map((interval) => (keyPc + interval) % 12))
  let nonDiatonic = 0
  for (const chord of score.chords) {
    for (const midi of chord.midi) if (!scalePcs.has(((midi % 12) + 12) % 12)) nonDiatonic += 1
  }
  check(`${genre} chords are diatonic`, nonDiatonic === 0, `${nonDiatonic} foreign tones`)

  const motions = []
  for (let index = 1; index < score.chords.length; index += 1) {
    const before = score.chords[index - 1].midi
    const after = score.chords[index].midi
    const voices = Math.min(before.length, after.length)
    let sum = 0
    for (let voice = 0; voice < voices; voice += 1) sum += Math.abs(after[voice] - before[voice])
    motions.push(sum / voices)
    worstMotion = Math.max(worstMotion, sum / voices)
  }
  const meanMotion = motions.reduce((sum, value) => sum + value, 0) / Math.max(1, motions.length)
  check(`${genre} voice leading is smooth`, meanMotion < 6, `${fmt(meanMotion, 2)} semitones mean motion`)

  const bass = score.tracks.find((track) => track.id === 'bass').notes
  const harmony = score.tracks.find((track) => track.id === 'harmony').notes
  const melody = score.tracks.find((track) => track.id === 'melody').notes
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  check(`${genre} bass sits below harmony`, mean(bass.map((note) => note.midi)) < mean(harmony.map((note) => note.midi)) - 6,
    `${fmt(mean(bass.map((note) => note.midi)), 1)} vs ${fmt(mean(harmony.map((note) => note.midi)), 1)}`)
  check(`${genre} melody has notes`, melody.length >= 8, String(melody.length))
  minMelodyNotes = Math.min(minMelodyNotes, melody.length)

  // The lead is a line, not a chord: no two melody notes may overlap.
  const collisions = []
  for (let index = 1; index < melody.length; index += 1) {
    const previous = melody[index - 1]
    const current = melody[index]
    const previousEnd = previous.bar * score.beatsPerBar + previous.beat + previous.durBeats
    const currentStart = current.bar * score.beatsPerBar + current.beat
    if (previousEnd > currentStart + 0.02) collisions.push([previous, current])
  }
  check(`${genre} melody is monophonic`, collisions.length === 0, `${collisions.length} overlaps`)

  // No algorithmic two-note trill anywhere in the lead.
  const trills = countTrills(melody, score.beatsPerBar)
  check(`${genre} melody avoids two-note trills`, trills === 0, String(trills))

  // Strong beats state the chord: the line is written against the harmony, not
  // against a scale. 100% is not required (pentatonic melodies legitimately
  // borrow), but it has to be the norm.
  const chordAt = (bar) => {
    let found = score.chords[0]
    for (const chord of score.chords) if (chord.bar <= bar) found = chord
    return found
  }
  const strongNotes = melody.filter((note) => Math.abs(note.beat) < 1e-6 || Math.abs(note.beat - 2) < 1e-6)
  const strongChordTones = strongNotes.filter((note) =>
    chordAt(note.bar).pcs.includes(((note.midi % 12) + 12) % 12)).length
  const chordToneRate = strongNotes.length > 0 ? strongChordTones / strongNotes.length : 1
  check(`${genre} strong beats state the chord`, chordToneRate >= 0.9,
    `${strongChordTones}/${strongNotes.length} = ${fmt(chordToneRate, 2)}`)

  // The bass states the root on the downbeat of every chord change.
  const downbeats = bass.filter((note) => Math.abs(note.beat) < 1e-6)
  const roots = downbeats.filter((note) => chordAt(note.bar).pcs[0] === ((note.midi % 12) + 12) % 12).length
  check(`${genre} bass states the root on downbeats`, downbeats.length > 0 && roots === downbeats.length,
    `${roots}/${downbeats.length}`)

  // Velocity and articulation are varied: no machine-gun flat dynamics.
  for (const track of score.tracks) {
    minVelocityVariety = Math.min(minVelocityVariety, new Set(track.notes.map((note) => note.velocity)).size)
    for (const note of track.notes) allArticulations.add(note.artic)
  }
  const melodyRange = Math.max(...melody.map((note) => note.midi)) - Math.min(...melody.map((note) => note.midi))
  worstRange = Math.max(worstRange, melodyRange)
  check(`${genre} melody spans a phrase range`, melodyRange >= 4, `${melodyRange} semitones`)

  // Drums land on the 16th-note grid (plus the genre swing on the offbeat
  // eighth and a small humanisation) so hits can be synced to picture.
  const drums = score.tracks.find((track) => track.id === 'rhythm').notes
  const pattern = DRUM_PATTERNS[GENRES[genre].drums]
  const humanize = pattern.humanize ?? 0.008
  const swingShift = GENRES[genre].swing ?? 0
  const allowedBeats = []
  for (let step = 0; step < 16; step += 1) {
    allowedBeats.push(step * 0.25)
    if (step % 4 === 2 && swingShift > 0) allowedBeats.push(step * 0.25 + swingShift)
  }
  const offGrid = drums.filter((note) => note.beat < 0 || note.beat >= score.beatsPerBar ||
    !allowedBeats.some((beat) => Math.abs(note.beat - beat) <= humanize + 1e-6))
  check(`${genre} drums are on the 16th grid`, offGrid.length === 0, `${offGrid.length} off-grid hits`)

  // Sections form a contiguous cover of the cue.
  let cursor = 0
  let contiguous = true
  for (const section of score.sections) {
    if (section.fromBar !== cursor) contiguous = false
    cursor = section.toBar
  }
  check(`${genre} sections cover every bar`, contiguous && cursor === score.bars, `${cursor}/${score.bars}`)
}
console.log(`  every genre: diatonic chords, mean voice motion <= ${fmt(worstMotion, 2)} semitones, melody range up to ${worstRange} semitones, >= ${minVelocityVariety} velocities per track, articulations ${[...allArticulations].join('/')}`)
check('each track varies velocity', minVelocityVariety >= 2, String(minVelocityVariety))
check('articulation is varied', allArticulations.size >= 2, [...allArticulations].join(','))
check('every genre has a real melody', minMelodyNotes >= 8, String(minMelodyNotes))

/* ----------------------------------------------------------- tempo -- */

console.log('\ntempo accuracy (120 BPM)')
{
  const score = composeScore({ genre: 'action', bpm: 120, bars: 4, seed: 1, intensity: 0.8 })
  check('beatMap beat is 0.5 s', Math.abs(score.beatMap[1] - 0.5) < 1e-6, String(score.beatMap[1]))
  // One track, one kick per beat: the cleanest possible tempo probe of the
  // whole scheduler (score beat grid -> sample frame).
  const kickNotes = []
  for (let bar = 0; bar < 4; bar += 1) {
    for (let beat = 0; beat < 4; beat += 1) kickNotes.push({ bar, beat, durBeats: 0.25, midi: 36, velocity: 0.9, artic: 'accent' })
  }
  const pulse = {
    ...score,
    tracks: [{ id: 'rhythm', role: 'rhythm', instrument: 'pulse-kit', gainDb: -12, notes: kickNotes }]
  }
  const rendered = renderScore(pulse)
  const onsets = lowBandOnsets(rendered.samples, rendered.sampleRate)
  const intervals = []
  for (let index = 1; index < onsets.length; index += 1) intervals.push(onsets[index] - onsets[index - 1])
  const detected = median(intervals)
  console.log(`  16 kicks expected, ${onsets.length} detected; median inter-onset ${fmt(detected, 4)} s; first onset ${fmt(onsets[0] ?? -1, 3)} s`)
  check('all 16 kicks detected', onsets.length === 16, String(onsets.length))
  check('tempo accurate within 5%', Math.abs(detected - 0.5) <= 0.5 * 0.05, `${detected} s`)
  check('kicks land on the beat grid', onsets.every((at, index) => Math.abs(at - index * 0.5) < 0.02),
    onsets.map((at, index) => (at - index * 0.5).toFixed(3)).join(','))
}

/* ------------------------------------------------------------ loops -- */

console.log('\nloop safety (16 bars)')
{
  for (const genre of GENRE_NAMES) {
    const score = composeScore({ genre, bars: 16, seed: 7, intensity: 0.65, loop: true })
    const sectionNames = score.sections.map((section) => section.name)
    check(`${genre} loop has no intro/outro`, !sectionNames.includes('intro') && !sectionNames.includes('outro'),
      sectionNames.join(','))
    const rendered = renderScore(score)
    const metrics = measure(rendered.samples, rendered.sampleRate)
    const expected = score.bars * score.beatsPerBar * 60 / score.bpm
    console.log(`  ${genre.padEnd(10)} seam ${String(metrics.loopSeam).padStart(4)} dB  step ${String(metrics.loopStep).padStart(6)}  duration ${fmt(metrics.durationSeconds, 3)} s (expected ${fmt(expected, 3)})`)
    check(`${genre} loop seam below 6 dB`, metrics.loopSeam < 6, String(metrics.loopSeam))
    check(`${genre} loop length exact`, Math.abs(metrics.durationSeconds - expected) < 0.03,
      `${metrics.durationSeconds} vs ${expected}`)
    check(`${genre} loop does not clip`, metrics.clipping === 0, String(metrics.clipping))
  }
}

/* ------------------------------------------------ score API robustness -- */

console.log('\nscore API robustness')
{
  const minimal = {
    bpm: 120,
    bars: 2,
    beatsPerBar: 4,
    sections: [{ name: 'drop', fromBar: 0, toBar: 2, intensity: 0.7 }],
    tracks: [
      { id: 'bass', role: 'bass', instrument: 'default-bass', gainDb: -16, notes: [{ bar: 0, beat: 0, durBeats: 2, midi: 45, velocity: 0.8, artic: 'legato' }] }
    ]
  }
  const rendered = renderScore(minimal)
  check('a hand-written score renders', rendered.samples.length > 0 && rendered.trackStats.length === 1)
  const alternative = renderScore(minimal, { sampleRate: 22050 })
  check('sampleRate option is honoured', alternative.sampleRate === 22050)
  check('sampleRate does not change duration', Math.abs(alternative.durationSeconds - rendered.durationSeconds) < 0.02,
    `${alternative.durationSeconds} vs ${rendered.durationSeconds}`)
  const section = rendered.sectionStats[0]
  check('section stats present', section !== undefined && section.name === 'drop' && typeof section.rmsDbfs === 'number')
  console.log(`  hand-written score: ${fmt(rendered.durationSeconds, 2)} s at ${rendered.sampleRate} Hz; ` +
    `22050 Hz render is ${fmt(alternative.durationSeconds, 2)} s; section "${section.name}" rms ${fmt(section.rmsDbfs)} dBFS`)
}

/* ---------------------------------------- non-numeric request fields ---- */

// `bars: 'abc'` used to become NaN and then `new Array(NaN)` (a crash), and
// `bpm: 'fast'` a score whose beatMap was NaN. Both now fall back like
// `intensity` does, so a model that writes a word instead of a number gets a
// default-tempo cue instead of a broken score.
console.log('\nnon-numeric bars/bpm fall back instead of producing NaN')
{
  const score = composeScore({ genre: 'lofi', bars: 'abc', bpm: 'fast', seed: 3 })
  const beatsFinite = score.beatMap.every((beat) => Number.isFinite(beat))
  const barsFinite = score.barMap.every((beat) => Number.isFinite(beat))
  const notes = score.tracks.flatMap((track) => track.notes)
  const notesFinite = notes.every((note) => Number.isFinite(note.midi) && Number.isFinite(note.velocity) && Number.isFinite(note.bar) && Number.isFinite(note.beat))
  const loop = composeScore({ genre: 'action', bars: NaN, bpm: Infinity, seed: 5 })
  console.log(`  bars "abc" -> ${score.bars}, bpm "fast" -> ${score.bpm} (genre ${GENRES.lofi.bpm}); ` +
    `beatMap finite ${beatsFinite}, barMap finite ${barsFinite}, ${notes.length} notes finite ${notesFinite}`)
  console.log(`  bars NaN -> ${loop.bars}, bpm Infinity -> ${loop.bpm} (genre ${GENRES.action.bpm})`)
  check('non-numeric bars falls back to 16', score.bars === 16, String(score.bars))
  check('non-numeric bpm falls back to the genre tempo', score.bpm === GENRES.lofi.bpm, String(score.bpm))
  check('fallback beatMap and barMap are finite', beatsFinite && barsFinite)
  check('fallback notes are finite', notesFinite)
  check('NaN/Infinity fields also fall back',
    loop.bars === 16 && loop.bpm === GENRES.action.bpm && loop.beatMap.every(Number.isFinite),
    `${loop.bars}/${loop.bpm}`)
}

/* ------------------------------------------------------------- tools -- */

console.log('\ntool layer: audio_compose')
{
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-compose-'))
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  const exec = { agent: { session: { id: 'compose-test' } } }
  registerComposeTools(ctx)
  const tool = registered.get('audio_compose')
  check('audio_compose registered', tool !== undefined)
  const call = (args) => tool.execute(args, exec)

  const result = await call({ genre: 'cinematic', bars: 8, seed: 4, out: 'music/intro.wav' })
  check('tool reports relative path', result.relativePath === 'music/intro.wav', result.relativePath)
  check('tool writes bytes', result.bytes > 1000, String(result.bytes))
  check('tool returns beatMap', Array.isArray(result.beatMap) && result.beatMap.length === result.beatCount,
    `${result.beatMap.length}/${result.beatCount}`)
  check('beatMap is bounded', result.beatMap.length <= 256 && result.beatMapStride >= 1,
    `${result.beatMap.length} stride ${result.beatMapStride}`)
  check('beatMap stride is consistent',
    result.beatMap.length === Math.ceil(result.beatCount / result.beatMapStride),
    `${result.beatMap.length} entries for ${result.beatCount} beats at stride ${result.beatMapStride}`)
  check('tool returns chords per bar', result.chords.length === 8, String(result.chords.length))
  check('tool returns track stats', result.tracks.length === 5, String(result.tracks.length))
  check('tool returns sections', result.sections.length >= 3, String(result.sections.length))
  check('tool returns metrics', result.metrics.clipping === 0 && result.metrics.peakDbfs <= 0)
  check('tool text has chords and tracks',
    /chords:/.test(result.text) && /tracks:/.test(result.text) && /beatMap/.test(result.text),
    result.text.slice(0, 120))
  check('tool text has per-track levels', result.tracks.every((track) => typeof track.rmsDbfs === 'number'))
  const wav = decodeWav(await readFile(join(cwd, 'music', 'intro.wav')))
  check('tool wav decodes', Math.abs(wav.durationSeconds - result.durationSeconds) < 0.02,
    `${wav.durationSeconds} vs ${result.durationSeconds}`)
  check('tool wav is mono 44.1 kHz', wav.channels.length === 1 && wav.sampleRate === 44100)
  console.log(`  wrote ${result.bytes} bytes (${fmt(result.durationSeconds, 2)} s) to ${result.relativePath}; ` +
    `${result.beatMap.length} beat times (stride ${result.beatMapStride}), ${result.chords.length} chords, ${result.tracks.length} tracks`)
  console.log(`  ${result.text.split('\n')[0]}`)

  const loopResult = await call({ genre: 'ui-menu', bars: 8, loop: true, seed: 4, out: 'music/menu.wav' })
  check('loop cue reports a seam', /loop seam/.test(loopResult.text), loopResult.text.slice(-80))
  check('loop cue is loop length', Math.abs(loopResult.durationSeconds - loopResult.bars * loopResult.beatsPerBar * 60 / loopResult.bpm) < 0.03)

  // A 96-bar cue is 384 beats: the returned grid must stay bounded by
  // subsampling, and beatMapStride must describe that subsampling.
  const longCue = await call({ genre: 'ui-menu', bars: 96, bpm: 220, seed: 2, out: 'music/long.wav' })
  check('long cue grid is capped at 256 entries', longCue.beatMap.length <= 256, String(longCue.beatMap.length))
  check('long cue grid is subsampled', longCue.beatMapStride > 1, String(longCue.beatMapStride))
  check('long cue grid length honours the stride',
    longCue.beatMap.length === Math.ceil(longCue.beatCount / longCue.beatMapStride),
    `${longCue.beatMap.length} entries for ${longCue.beatCount} beats at stride ${longCue.beatMapStride}`)
  console.log(`  ${longCue.bars}-bar cue: ${fmt(longCue.durationSeconds, 1)} s, ${longCue.beatCount} beats -> ` +
    `${longCue.beatMap.length} beatMap entries (stride ${longCue.beatMapStride})`)

  const custom = await call({
    genre: 'cinematic',
    bars: 8,
    seed: 4,
    out: 'music/custom.wav',
    sections: [{ name: 'drop', fromBar: 0, toBar: 8, intensity: 0.9 }]
  })
  check('sections override is respected', custom.sections.length === 1 && custom.sections[0].name === 'drop',
    JSON.stringify(custom.sections))

  let unknownGenre = ''
  try { await call({ genre: 'polka' }) } catch (error) { unknownGenre = error.message }
  check('unknown genre is rejected', /unknown genre/.test(unknownGenre), unknownGenre)
  let unknownKey = ''
  try { await call({ genre: 'lofi', key: 'H' }) } catch (error) { unknownKey = error.message }
  check('unknown key is rejected', /unknown key/.test(unknownKey), unknownKey)
  let tooLong = ''
  try { await call({ genre: 'ambient', bars: 64 }) } catch (error) { tooLong = error.message }
  check('over-long cue is rejected before rendering', /too long/.test(tooLong), tooLong)

  await rm(cwd, { recursive: true, force: true })
}

/* ------------------------------------------------------- performance -- */

console.log('\nperformance: 16 bars x 5 tracks at 44.1 kHz')
let worstRender = 0
let worstGenre = ''
for (const genre of GENRE_NAMES) {
  const row = rows[genre]
  if (row.renderMs > worstRender) { worstRender = row.renderMs; worstGenre = genre }
  console.log(`  ${genre.padEnd(10)} compose ${fmt(row.composeMs, 1).padStart(6)} ms  render ${fmt(row.renderMs, 0).padStart(5)} ms`)
}
console.log(`  worst: ${worstGenre} ${fmt(worstRender, 0)} ms (single-shot budget 700 ms; steady-state gate is 600 ms in test/perf.mjs)`)
check('worst render under 700 ms', worstRender < 700, `${fmt(worstRender, 0)} ms`)

console.log(failures === 0 ? '\nOK: composition engine behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
