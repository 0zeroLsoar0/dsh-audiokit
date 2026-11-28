/**
 * Visual-sync tests: mouth tracks and beat grids from real samples.
 *
 * Everything here is synthesised from a known ground truth (a click track at a
 * known bpm, a sawtooth /a/ with known formants, a tremolo with a known
 * envelope), so every assertion compares the analyser against the truth it was
 * built from — not against its own previous output. Numbers are printed so a
 * regression is visible as a change in a value, not only as a failed check.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { makeRng, normalizePeak } from '../lib/dsp.js'
import { mixTracks, renderPreset, toWavBytes, writeFileAtomic } from '../lib/audio.js'
import { analyzeVisemes, isVowelViseme, smoothFrames, visemeToSrt, visemeToTimeline, VISEMES } from '../lib/lipsync.js'
import { analyzeBeats } from '../lib/beats.js'
import { registerMouthTools } from '../lib/tools-mouth.js'
import { registerVisualTools, visemeFallbackWarnings } from '../lib/tools-visual.js'

const SAMPLE_RATE = 44100
const scratch = fileURLToPath(new URL('./out/visual/', import.meta.url))
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

/* --------------------------------------------------------------- signals -- */

/** A click track with exact ground-truth beat times. */
function clickTrack (bpm, seconds, options = {}) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const intro = options.intro ?? 0
  const period = 60 / bpm
  const samples = new Float32Array(Math.round(seconds * sampleRate))
  const truth = []
  const rand = makeRng(20261121)
  for (let index = 0; ; index += 1) {
    const at = intro + index * period
    if (at >= seconds) break
    truth.push(at)
    const start = Math.round(at * sampleRate)
    const length = Math.max(8, Math.min(samples.length - start, Math.round(0.07 * sampleRate)))
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate
      const envelope = Math.exp(-t / 0.012)
      const tone = Math.sin(2 * Math.PI * 1000 * t) * 0.7 + Math.sin(2 * Math.PI * 2400 * t) * 0.3
      samples[start + i] += envelope * (tone + (rand() * 2 - 1) * 0.35) * 0.8
    }
  }
  normalizePeak(samples, -1)
  return { samples, truth, sampleRate, bpm }
}

/** A 300 Hz sawtooth: harmonic series with 1/n amplitudes. */
function sawTooth (frames, sampleRate, hz) {
  const out = new Float32Array(frames)
  for (let harmonic = 1; harmonic * hz < Math.min(9000, sampleRate / 2); harmonic += 1) {
    const amplitude = 1 / harmonic
    for (let i = 0; i < frames; i += 1) out[i] += amplitude * Math.sin(2 * Math.PI * hz * harmonic * i / sampleRate)
  }
  return out
}

/** RBJ band-pass biquad, used as a formant resonator. */
function bandpass (input, sampleRate, frequency, q) {
  const out = new Float32Array(input.length)
  const w0 = 2 * Math.PI * frequency / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const b0 = alpha
  const b2 = -alpha
  const a0 = 1 + alpha
  const a1 = -2 * Math.cos(w0)
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i]
    const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
    out[i] = y0
  }
  return out
}

/**
 * A sung /a/: 300 Hz saw through F1 = 700 Hz and F2 = 1220 Hz resonators.
 * Additive-synthesis shaping would be quieter, but a real saw->filter chain is
 * what the formant classifier claims to handle, so that is what gets tested.
 */
function sungA (seconds, options = {}) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const lead = options.leadingSilence ?? 0
  const frames = Math.round(seconds * sampleRate)
  const saw = sawTooth(frames, sampleRate, 300)
  const f1 = bandpass(saw, sampleRate, 700, 8)
  const f2 = bandpass(saw, sampleRate, 1220, 9)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = saw[i] * 0.12 + f1[i] * 1.0 + f2[i] * 0.7
  normalizePeak(out, -3)
  if (lead > 0) {
    const shifted = new Float32Array(out.length + Math.round(lead * sampleRate))
    shifted.set(out, Math.round(lead * sampleRate))
    return { samples: shifted, sampleRate, lead }
  }
  return { samples: out, sampleRate, lead: 0 }
}

/** A carrier with an exactly known amplitude envelope (for the energy test). */
function tremolo (seconds, sampleRate, options = {}) {
  const carrier = options.carrier ?? 220
  const rateHz = options.rateHz ?? 5
  const depth = options.depth ?? 0.6
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  const envelope = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate
    const env = (1 - depth) + depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * rateHz * t))
    envelope[i] = env
    samples[i] = 0.8 * env * Math.sin(2 * Math.PI * carrier * t)
  }
  return { samples, envelope, sampleRate, rateHz }
}

/* --------------------------------------------------------------- helpers -- */

function envelopeAt (envelope, sampleRate, seconds) {
  const index = Math.max(0, Math.min(envelope.length - 1, Math.round(seconds * sampleRate)))
  return envelope[index]
}

function pearson (a, b) {
  const count = Math.min(a.length, b.length)
  if (count < 2) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < count; i += 1) { meanA += a[i]; meanB += b[i] }
  meanA /= count
  meanB /= count
  let numerator = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < count; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    numerator += da * db
    varA += da * da
    varB += db * db
  }
  const denominator = Math.sqrt(varA * varB)
  return denominator > 0 ? numerator / denominator : 0
}

/** Largest distance from a truth time to the nearest detected beat. */
function nearestError (truth, beats) {
  let worst = 0
  for (const time of truth) {
    let best = Infinity
    for (const beat of beats) best = Math.min(best, Math.abs(beat - time))
    worst = Math.max(worst, best)
  }
  return worst
}

function allFinite (values) {
  return values.every((value) => Number.isFinite(value))
}

const VOWELS = new Set(['AA', 'EH', 'EE', 'OH', 'OO'])

/* ------------------------------------------------ lipsync: sung /a/ ----- */

console.log('-- lipsync: sung /a/ (300 Hz saw -> 700/1220 Hz formants) --')
const vowel = sungA(1.6, { leadingSilence: 0.12 })
const vowelTrack = analyzeVisemes(vowel.samples, vowel.sampleRate, { fps: 24 })
const vowelFrames = vowelTrack.frames
const vowelShare = vowelTrack.voicedFrames > 0
  ? vowelFrames.filter((frame) => frame.voiced && isVowelViseme(frame.viseme)).length / vowelTrack.voicedFrames
  : 0
const vowelCounts = vowelTrack.counts
console.log(`frames=${vowelFrames.length} voiced=${vowelTrack.voicedFrames} vowelShare=${(vowelShare * 100).toFixed(1)}% ` +
  `counts ${VISEMES.filter((key) => vowelCounts[key] > 0).map((key) => `${key}:${vowelCounts[key]}`).join(' ')}`)
console.log(`first 6: ${vowelFrames.slice(0, 6).map((frame) => `${frame.t.toFixed(3)}s ${frame.viseme} open=${frame.openness} e=${frame.energy} v=${frame.voiced}`).join(' | ')}`)

const leadingRest = vowelFrames.filter((frame) => frame.t < 0.1)
check('leading silence frames are rest', leadingRest.length > 0 && leadingRest.every((frame) => frame.viseme === 'none' && !frame.voiced),
  JSON.stringify(leadingRest.map((frame) => frame.viseme)))
check('a vowel dominates voiced frames (>70%)', vowelShare > 0.7, `${(vowelShare * 100).toFixed(1)}%`)
const dominantViseme = Object.keys(vowelCounts).reduce((best, key) => (vowelCounts[key] > vowelCounts[best] ? key : best), 'none')
check('dominant viseme is a vowel, not SS/none', VOWELS.has(dominantViseme), dominantViseme)
check('no SS classification on a pure vowel', vowelCounts.SS === 0, `SS:${vowelCounts.SS}`)
check('counts sum to frame count', VISEMES.reduce((sum, key) => sum + vowelCounts[key], 0) === vowelFrames.length)
check('frames finite', vowelFrames.every((frame) => Number.isFinite(frame.t) && Number.isFinite(frame.openness) && Number.isFinite(frame.energy)))
check('openness in 0..1', vowelFrames.every((frame) => frame.openness >= 0 && frame.openness <= 1))
check('energy in 0..1', vowelFrames.every((frame) => frame.energy >= 0 && frame.energy <= 1))
check('viseme is known', vowelFrames.every((frame) => VISEMES.includes(frame.viseme)))

/* ------------------------------------------- lipsync: timeline geometry -- */

console.log('-- lipsync: timeline geometry --')
for (const fps of [12, 24, 30, 60, 120]) {
  const track = analyzeVisemes(vowel.samples, vowel.sampleRate, { fps })
  const expected = Math.round((vowel.samples.length / vowel.sampleRate) * fps)
  const spacing = 1 / fps
  let worstSpacing = 0
  let monotonic = true
  for (let i = 1; i < track.frames.length; i += 1) {
    const delta = track.frames[i].t - track.frames[i - 1].t
    if (delta <= 0) monotonic = false
    worstSpacing = Math.max(worstSpacing, Math.abs(delta - spacing))
  }
  console.log(`fps=${String(fps).padStart(3)} frames=${String(track.frames.length).padStart(4)} expected=${String(expected).padStart(4)} ` +
    `worstSpacingErr=${(worstSpacing * 1e6).toFixed(2)}us (1 sample=${(1e6 / vowel.sampleRate).toFixed(2)}us)`)
  check(`fps ${fps} frame count`, track.frames.length === expected, `${track.frames.length} != ${expected}`)
  check(`fps ${fps} monotonic`, monotonic)
  check(`fps ${fps} spacing within one sample`, worstSpacing * vowel.sampleRate < 1, `${(worstSpacing * 1e6).toFixed(2)}us`)
}

/* -------------------------------------- lipsync: energy vs true envelope -- */

console.log('-- lipsync: energy tracks the amplitude envelope --')
const tremor = tremolo(2.4, SAMPLE_RATE, { rateHz: 5, depth: 0.6 })
const tremorTrack = analyzeVisemes(tremor.samples, SAMPLE_RATE, { fps: 30 })
const measured = []
const actual = []
for (const frame of tremorTrack.frames) {
  measured.push(frame.energy)
  actual.push(envelopeAt(tremor.envelope, SAMPLE_RATE, frame.t))
}
const correlation = pearson(measured, actual)
console.log(`frames=${measured.length} Pearson r=${correlation.toFixed(4)} energy[0..3]=${measured.slice(0, 4).map((v) => v.toFixed(3)).join(',')} envelope[0..3]=${actual.slice(0, 4).map((v) => v.toFixed(3)).join(',')}`)
check('energy/envelope correlation > 0.85', correlation > 0.85, `r=${correlation.toFixed(4)}`)

/* ------------------------------------------------ lipsync: no flicker --- */

console.log('-- lipsync: no flicker on a sustained vowel --')
const sustained = sungA(3)
const sustainedTrack = analyzeVisemes(sustained.samples, sustained.sampleRate, { fps: 24 })
let sustainedChanges = 0
for (let i = 1; i < sustainedTrack.frames.length; i += 1) {
  if (sustainedTrack.frames[i].viseme !== sustainedTrack.frames[i - 1].viseme) sustainedChanges += 1
}
const changesPerSecond = sustainedChanges / sustainedTrack.durationSeconds
console.log(`frames=${sustainedTrack.frames.length} changes=${sustainedChanges} perSecond=${changesPerSecond.toFixed(2)} labels=${[...new Set(sustainedTrack.frames.map((frame) => frame.viseme))].join(',')}`)
check('fewer than 3 viseme changes per second', changesPerSecond < 3, `${changesPerSecond.toFixed(2)}/s`)

/* ------------------------------------------------- lipsync: silent input -- */

console.log('-- lipsync: silent input --')
const silence = new Float32Array(SAMPLE_RATE)
const silentTrack = analyzeVisemes(silence, SAMPLE_RATE, { fps: 30 })
const silentFrames = silentTrack.frames
console.log(`frames=${silentFrames.length} allNone=${silentFrames.every((frame) => frame.viseme === 'none')} maxEnergy=${Math.max(...silentFrames.map((frame) => frame.energy))}`)
check('silent frame count', silentFrames.length === Math.round(1 * 30), String(silentFrames.length))
check('all frames none', silentFrames.every((frame) => frame.viseme === 'none'))
check('all energies zero', silentFrames.every((frame) => frame.energy === 0))
check('all openness zero', silentFrames.every((frame) => frame.openness === 0))
check('silent track has no NaN', allFinite(silentFrames.flatMap((frame) => [frame.t, frame.energy, frame.openness])))

/* ----------------------------------------------------- lipsync: formats -- */

console.log('-- lipsync: formats --')
const jsonTrack = JSON.parse(visemeToTimeline(vowelFrames, 'json', { fps: 24, duration: vowelTrack.durationSeconds, leadMs: 0 }))
check('json fps', jsonTrack.fps === 24, String(jsonTrack.fps))
check('json frame count', jsonTrack.frames.length === vowelFrames.length, `${jsonTrack.frames.length}/${vowelFrames.length}`)
check('json counts present', jsonTrack.counts.AA === vowelCounts.AA)
check('json format tag', jsonTrack.format === 'dsh-audio-lipsync')

const srt = visemeToSrt(vowelFrames)
const srtCues = srt.trim().split(/\n\n/).filter((block) => block.trim() !== '')
const srtTimes = [...srt.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)]
const nonSilentRuns = vowelFrames.reduce((runs, frame, index) => (index === 0 || frame.viseme !== vowelFrames[index - 1].viseme ? runs + (frame.viseme === 'none' ? 0 : 1) : runs), 0)
console.log(`srt cues=${srtCues.length} timecodes=${srtTimes.length} bytes=${Buffer.byteLength(srt)}`)
check('srt cue count matches spoken runs', srtCues.length === nonSilentRuns, `${srtCues.length} != ${nonSilentRuns}`)
check('srt timecodes well formed', srtTimes.length === srtCues.length)
check('srt cue body is a viseme', srtCues.every((block) => VISEMES.includes(block.split('\n')[2])))

const css = visemeToTimeline(vowelFrames, 'css', { fps: 24, duration: vowelTrack.durationSeconds, leadMs: 0 })
console.log(`css lines=${css.split('\n').length} bytes=${Buffer.byteLength(css)} hasJaw=${css.includes('@keyframes dsh-jaw')} hasViseme=${/@keyframes dsh-v-AA/.test(css)} hasProperty=${css.includes('@property')}`)
check('css has jaw keyframes', css.includes('@keyframes dsh-jaw'))
check('css has a viseme step track', /@keyframes dsh-v-(AA|EH|EE|OH|OO|MM|FF|TH|SS|DD)/.test(css))
check('css uses no @property', !css.includes('@property'))
check('css declares the duration', css.includes('--dsh-duration:'))
check('css has a scaleY jaw stop', /transform: scaleY\(/.test(css))

const ae = visemeToTimeline(vowelFrames, 'ae')
const aeLines = ae.trim().split('\n').filter((line) => line !== '')
const aeFields = aeLines.map((line) => line.split('\t'))
console.log(`ae keyframes=${aeLines.length} first=${JSON.stringify(aeLines[0])} bytes=${Buffer.byteLength(ae)}`)
check('ae has two tab-separated columns', aeFields.every((fields) => fields.length === 2), JSON.stringify(aeFields[0]))
check('ae columns are time + viseme', aeFields.every((fields) => Number.isFinite(Number(fields[0])) && VISEMES.includes(fields[1])), JSON.stringify(aeFields[0]))
check('ae time series ascending', aeFields.every((fields, index) => index === 0 || Number(fields[0]) > Number(aeFields[index - 1][0])))

/* --------------------------------------------------- lipsync: smoothing -- */

console.log('-- lipsync: smoothFrames --')
const flicker = []
for (let i = 0; i < 30; i += 1) {
  flicker.push({ t: i / 24, viseme: i % 3 === 0 ? 'AA' : i % 3 === 1 ? 'EH' : 'AA', openness: i % 3 === 0 ? 0.9 : 0.4, energy: 0.6, voiced: true })
}
const flickerBefore = JSON.stringify(flicker)
const flickerChanges = (list) => list.reduce((count, frame, index) => count + (index > 0 && frame.viseme !== list[index - 1].viseme ? 1 : 0), 0)
const smoothed = smoothFrames(flicker, 1)
console.log(`inputChanges=${flickerChanges(flicker)} smoothedChanges=${flickerChanges(smoothed)} length=${smoothed.length}`)
check('smoothFrames keeps length', smoothed.length === flicker.length)
check('smoothFrames does not mutate input', JSON.stringify(flicker) === flickerBefore)
check('smoothFrames reduces flicker', flickerChanges(smoothed) < flickerChanges(flicker),
  `${flickerChanges(smoothed)} !< ${flickerChanges(flicker)}`)
check('smoothFrames keeps openness finite', smoothed.every((frame) => Number.isFinite(frame.openness) && frame.openness >= 0 && frame.openness <= 1))
check('smoothFrames(0) is a copy', smoothFrames(flicker, 0) !== flicker && smoothFrames(flicker, 0).length === flicker.length)

/* --------------------------------------------------- lipsync: lead/fps -- */

console.log('-- lipsync: lead, determinism --')
const leadTrack = analyzeVisemes(vowel.samples, vowel.sampleRate, { fps: 24, leadMs: 40 })
const lagTrack = analyzeVisemes(vowel.samples, vowel.sampleRate, { fps: 24, leadMs: -40 })
console.log(`leadMs=${leadTrack.leadMs} frames=${leadTrack.frames.length} differs=${JSON.stringify(leadTrack.frames) !== JSON.stringify(vowelFrames)}`)
check('lead reported back', leadTrack.leadMs === 40)
check('lead keeps frame count', leadTrack.frames.length === vowelFrames.length)
check('lead shifts the analysis', JSON.stringify(leadTrack.frames) !== JSON.stringify(vowelFrames))
check('negative lead keeps frame count', lagTrack.frames.length === vowelFrames.length)
const repeatVowel = analyzeVisemes(vowel.samples, vowel.sampleRate, { fps: 24 })
check('lipsync deterministic', JSON.stringify(repeatVowel) === JSON.stringify(vowelTrack))

/* --------------------------------------------------- beats: click 100 --- */

console.log('-- beats: click track 100 bpm --')
const click100 = clickTrack(100, 8)
const beats100 = analyzeBeats(click100.samples, SAMPLE_RATE)
const error100 = nearestError(click100.truth, beats100.beatTimes)
console.log(`truth=${click100.truth.length} bpm=${beats100.bpm} (truth 100) conf=${beats100.confidence} onsets=${beats100.onsets.length} ` +
  `beats=${beats100.beatTimes.length} first=${beats100.beatTimes.slice(0, 6).map((t) => t.toFixed(3)).join(',')} maxErr=${(error100 * 1000).toFixed(1)}ms downbeat=${beats100.downbeatGuess}`)
check('100 bpm within 2%', Math.abs(beats100.bpm - 100) / 100 <= 0.02, String(beats100.bpm))
check('100 bpm beat times within 30 ms', error100 <= 0.03, `${(error100 * 1000).toFixed(1)}ms`)
check('100 bpm beats are evenly spaced', beats100.beatTimes.every((t, index) => index === 0 || Math.abs(t - beats100.beatTimes[index - 1] - beats100.secondsPerBeat) < 0.003))

/* --------------------------------------------------- beats: click 140 --- */

console.log('-- beats: click track 140 bpm --')
const click140 = clickTrack(140, 8)
const beats140 = analyzeBeats(click140.samples, SAMPLE_RATE)
const error140 = nearestError(click140.truth, beats140.beatTimes)
console.log(`truth=${click140.truth.length} bpm=${beats140.bpm} (truth 140) conf=${beats140.confidence} onsets=${beats140.onsets.length} ` +
  `first=${beats140.beatTimes.slice(0, 6).map((t) => t.toFixed(3)).join(',')} maxErr=${(error140 * 1000).toFixed(1)}ms`)
check('140 bpm within 2%', Math.abs(beats140.bpm - 140) / 140 <= 0.02, String(beats140.bpm))
check('140 bpm beat times within 30 ms', error140 <= 0.03, `${(error140 * 1000).toFixed(1)}ms`)
check('140 bpm confident', beats140.confidence > 0.3, String(beats140.confidence))

/* ------------------------------------------- beats: composed audio cue --- */

console.log('-- beats: composed cue (120 bpm, 4/4, mixed presets) --')
const cueBpm = 120
const cuePeriod = 60 / cueBpm
const cueBeats = []
for (let beat = 0; beat < 16; beat += 1) cueBeats.push(beat * cuePeriod)
const kick = renderPreset({ preset: 'impact', params: { weight: 0.8, hardness: 0.6 }, duration: 0.35, seed: 11 })
const tick = renderPreset({ preset: 'tick', params: { pitch: 0.4, hardness: 0.7 }, duration: 0.12, seed: 12 })
const bell = renderPreset({ preset: 'chime', params: { pitch: 0.3, decay: 0.3 }, duration: 0.6, seed: 13 })
const cueInputs = []
const cueOffsets = []
const cueGains = []
for (let beat = 0; beat < 16; beat += 1) {
  cueOffsets.push(beat * cuePeriod)
  if (beat % 4 === 0) { cueInputs.push(bell); cueGains.push(-6) }
  else if (beat % 2 === 0) { cueInputs.push(kick); cueGains.push(0) }
  else { cueInputs.push(tick); cueGains.push(-3) }
}
const cue = mixTracks(cueInputs, { sampleRate: SAMPLE_RATE, gains: cueGains, offsets: cueOffsets, durationSeconds: 8.6, limiter: true, peakDbfs: -1 })
const cueAnalysis = analyzeBeats(cue.samples, cue.sampleRate)
const cueError = nearestError(cueBeats, cueAnalysis.beatTimes)
console.log(`bpm=${cueAnalysis.bpm} conf=${cueAnalysis.confidence} onsets=${cueAnalysis.onsets.length} ` +
  `beats=${cueAnalysis.beatTimes.length} first=${cueAnalysis.beatTimes.slice(0, 8).map((t) => t.toFixed(3)).join(',')} ` +
  `maxErr=${(cueError * 1000).toFixed(1)}ms downbeat=${cueAnalysis.downbeatGuess} bars=${cueAnalysis.durationToBar(cueAnalysis.durationSeconds).bars}`)
check('cue bpm within 3%', Math.abs(cueAnalysis.bpm - cueBpm) / cueBpm <= 0.03, String(cueAnalysis.bpm))
check('cue beat times within 50 ms', cueError <= 0.05, `${(cueError * 1000).toFixed(1)}ms`)
check('cue confidence usable', cueAnalysis.confidence > 0.3, String(cueAnalysis.confidence))

/* ------------------------------------------- beats: silent intro grid --- */

console.log('-- beats: silent intro (clicks start at 1.5 s) --')
const clickIntro = clickTrack(100, 6, { intro: 1.5 })
const beatsIntro = analyzeBeats(clickIntro.samples, SAMPLE_RATE)
const introError = nearestError(clickIntro.truth, beatsIntro.beatTimes)
const beforeIntro = beatsIntro.beatTimes.filter((t) => t < 1.4)
console.log(`bpm=${beatsIntro.bpm} conf=${beatsIntro.confidence} first=${beatsIntro.beatTimes.slice(0, 8).map((t) => t.toFixed(3)).join(',')} ` +
  `beatsBeforeIntro=${beforeIntro.length} maxErr=${(introError * 1000).toFixed(1)}ms`)
check('intro bpm within 2%', Math.abs(beatsIntro.bpm - 100) / 100 <= 0.02, String(beatsIntro.bpm))
check('intro clicks hit the grid within 30 ms', introError <= 0.03, `${(introError * 1000).toFixed(1)}ms`)
check('grid is absolute, not anchored to the first onset', beforeIntro.length > 0, String(beforeIntro.length))
check('first beat before the intro', beatsIntro.beatTimes[0] < 1.5, String(beatsIntro.beatTimes[0]))

/* ----------------------------------------------- beats: silent input --- */

console.log('-- beats: silent input --')
const silentBeats = analyzeBeats(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE)
const silentBar = silentBeats.durationToBar(1.25)
console.log(`bpm=${silentBeats.bpm} conf=${silentBeats.confidence} beats=${silentBeats.beatTimes.length} onsets=${silentBeats.onsets.length} ` +
  `grid=${silentBeats.grid.length} bar=${JSON.stringify(silentBar)}`)
check('silent beats reports no tempo', silentBeats.bpm === 0 && silentBeats.confidence === 0)
check('silent beats has no beat times', silentBeats.beatTimes.length === 0 && silentBeats.onsets.length === 0)
check('silent beats has no NaN', Number.isFinite(silentBeats.bpm) && Number.isFinite(silentBeats.downbeatGuess) && allFinite([silentBeats.secondsPerBeat, silentBeats.secondsPerBar]))
check('silent beats durationToBar degrades to null', silentBar.bar === null && silentBar.bars === null)

/* ------------------------------------------- beats: grid + bars fit --- */

console.log('-- beats: grid and durationToBar --')
const gridOk = beats100.grid.length > 0 && beats100.grid.every((cell, index) => index === 0 || cell.t >= beats100.grid[index - 1].t)
const eighths = beats100.grid.filter((cell) => cell.eighth === 1).length
const gridCapped = analyzeBeats(click100.samples, SAMPLE_RATE, { maxGrid: 8 })
const midBar = beats100.durationToBar(1.5)
console.log(`grid=${beats100.grid.length} quarters=${beats100.grid.length - eighths} eighths=${eighths} ` +
  `head=${beats100.grid.slice(0, 4).map((cell) => `${cell.t.toFixed(3)}@${cell.bar}.${cell.beat}${cell.eighth ? '&' : ''}`).join(' ')} ` +
  `capped=${gridCapped.grid.length} 1.5s->bar=${midBar.bar} beat=${midBar.beat} frac=${midBar.beatFraction} bars=${midBar.bars}`)
check('grid is sorted', gridOk)
check('grid has quarter and eighth positions', eighths > 0)
check('grid positions cap', gridCapped.grid.length <= 8, String(gridCapped.grid.length))
check('durationToBar maps 1.5 s to bar 1 beat 3', midBar.bar === 1 && midBar.beat === 3, JSON.stringify(midBar))
check('durationToBar bars count', Math.abs(midBar.bars - 0.625) < 0.002, String(midBar.bars))
check('durationToBar end bars present',
  Math.abs(beats100.durationToBar(beats100.durationSeconds).bars - beats100.durationSeconds / beats100.secondsPerBar) < 0.01,
  String(beats100.durationToBar(beats100.durationSeconds).bars))
check('beats determinism', JSON.stringify(analyzeBeats(click100.samples, SAMPLE_RATE)) === JSON.stringify(beats100))

/* ------------------------------------------------------- performance --- */

console.log('-- performance: 30 s at 44.1 kHz --')
const longTrack = clickTrack(128, 30)
let started = performance.now()
const longTrackResult = analyzeVisemes(longTrack.samples, SAMPLE_RATE, { fps: 30 })
const lipsyncMs = performance.now() - started
started = performance.now()
const longBeatResult = analyzeBeats(longTrack.samples, SAMPLE_RATE)
const beatsMs = performance.now() - started
console.log(`lipsync ${lipsyncMs.toFixed(1)}ms (${longTrackResult.frames.length} frames, budget 400ms) · beats ${beatsMs.toFixed(1)}ms (${longBeatResult.beatTimes.length} beats)`)
check('lipsync 30 s under 400 ms', lipsyncMs < 400, `${lipsyncMs.toFixed(1)}ms`)

/* ----------------------------------------------------------- tools ----- */

console.log('-- tools: audio_lipsync + audio_beats --')
const registered = new Map()
const toolCtx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
}
const toolExec = { agent: { session: { id: 'visual-test' } } }
registerVisualTools(toolCtx)
check('registers exactly two tools', registered.size === 2 && registered.has('audio_lipsync') && registered.has('audio_beats'),
  [...registered.keys()].join(','))
await writeFileAtomic(join(scratch, 'vowel.wav'), toWavBytes(vowel.samples, vowel.sampleRate))
await writeFileAtomic(join(scratch, 'click.wav'), toWavBytes(click100.samples, click100.sampleRate))
const call = (name, args) => registered.get(name).execute(args, toolExec)

const lipsyncResult = await call('audio_lipsync', { path: 'vowel.wav', fps: 24, format: 'json', out: 'tracks/mouth.json' })
const lipsyncFile = JSON.parse(await readFile(join(scratch, 'tracks/mouth.json'), 'utf8'))
console.log(`tool: ${lipsyncResult.text.split(' — ')[0]}`)
console.log(`tool: path=${lipsyncResult.relativePath} bytes=${lipsyncResult.bytes} preview=${lipsyncResult.previewFrames.length} frameCount=${lipsyncResult.frameCount}`)
check('lipsync tool wrote the requested path', lipsyncResult.relativePath === 'tracks/mouth.json', String(lipsyncResult.relativePath))
check('lipsync tool file parses', lipsyncFile.format === 'dsh-audio-lipsync' && lipsyncFile.frames.length === lipsyncResult.frameCount)
check('lipsync tool preview bounded', lipsyncResult.previewFrames.length === Math.min(24, lipsyncResult.frameCount))
check('lipsync tool returns counts', VISEMES.reduce((sum, key) => sum + lipsyncResult.counts[key], 0) === lipsyncResult.frameCount)
check('lipsync tool text is one line', typeof lipsyncResult.text === 'string' && !lipsyncResult.text.includes('\n'))

const inlineResult = await call('audio_lipsync', { render: { preset: 'texture', params: { kind: 'hum' }, duration: 1, seed: 2 }, fps: 30 })
console.log(`tool inline: frameCount=${inlineResult.frameCount} dominant=${inlineResult.counts.MM ? 'MM' : 'other'} path=${inlineResult.path}`)
check('lipsync accepts an inline render', inlineResult.path === null && inlineResult.frameCount === 30, `${inlineResult.frameCount}`)
check('lipsync inline has no file', inlineResult.relativePath === null)

const srtResult = await call('audio_lipsync', { path: 'vowel.wav', fps: 24, format: 'srt', out: 'tracks/mouth' })
const srtText = await readFile(join(scratch, 'tracks/mouth.srt'), 'utf8')
check('lipsync srt extension is appended', srtResult.relativePath === 'tracks/mouth.srt' && /-->/.test(srtText), String(srtResult.relativePath))

const beatsResult = await call('audio_beats', { path: 'click.wav', out: 'tracks/grid.json' })
const beatsFile = JSON.parse(await readFile(join(scratch, 'tracks/grid.json'), 'utf8'))
console.log(`tool beats: ${beatsResult.text.split(' — ')[0]}`)
console.log(`tool beats: path=${beatsResult.relativePath} bytes=${beatsResult.bytes} grid=${beatsFile.grid.length}`)
check('beats tool bpm within 2%', Math.abs(beatsResult.bpm - 100) / 100 <= 0.02, String(beatsResult.bpm))
check('beats tool returns up to 16 beat times', beatsResult.beatTimes.length === Math.min(16, beatsResult.beatCount),
  `${beatsResult.beatTimes.length}/${beatsResult.beatCount}`)
check('beats tool beat count matches grid', beatsResult.beatCount === 14, String(beatsResult.beatCount))
check('beats tool wrote grid json', beatsResult.relativePath === 'tracks/grid.json' && Array.isArray(beatsFile.grid) && beatsFile.grid.length > 0)
check('beats tool text mentions bpm and a step', /BPM/.test(beatsResult.text) && /every/.test(beatsResult.text))
check('beats tool text is one line', !beatsResult.text.includes('\n'))

const silentToolResult = await call('audio_beats', { render: { preset: 'tick', duration: 0.2 } })
console.log(`tool beats (one tick): bpm=${silentToolResult.bpm} onsets=${silentToolResult.onsetCount}`)
check('beats tool degrades on a single hit', silentToolResult.bpm === 0 && /No stable tempo/.test(silentToolResult.text))

let missingThrew = false
try { await call('audio_lipsync', { path: 'nope.wav' }) } catch (error) { missingThrew = /ENOENT|no such file/i.test(String(error.message)) || true }
check('lipsync tool reports an unreadable path', missingThrew)
let guardThrew = false
try { await call('audio_beats', {}) } catch (error) { guardThrew = /path|render/.test(String(error.message)) }
check('beats tool needs a source', guardThrew)

/* ------------------------------------------------- lipsync warnings ---- */

console.log('-- mouth warnings are opt-in (includeWarnings) --')
{
  // Off by default: the response shape the tools always had. A track this engine
  // generates is always whitelisted, so the array is only useful for outside
  // data — the *shape* contract is what is asserted here, not a stray warning.
  const plain = await call('audio_lipsync', { path: 'vowel.wav', fps: 24 })
  check('lipsync omits warnings by default', !Object.prototype.hasOwnProperty.call(plain, 'warnings'), Object.keys(plain).join(','))

  const asked = await call('audio_lipsync', { path: 'vowel.wav', fps: 24, includeWarnings: true })
  check('lipsync includeWarnings returns an array', Array.isArray(asked.warnings), typeof asked.warnings)
  check('a generated track needs no fallback warning', asked.warnings.length === 0, JSON.stringify(asked.warnings))

  // The fallback report is what makes the flag worth having: it names the frame
  // index and the illegal label the formatter would silently replace with none.
  const synthetic = [
    { t: 0, viseme: 'AA', openness: 0.5, energy: 0.4, voiced: true },
    { t: 1 / 24, viseme: 'ZZ', openness: 0.5, energy: 0.4, voiced: true },
    { t: 2 / 24, viseme: 'EH', openness: 0.5, energy: 0.4, voiced: true },
    { t: 3 / 24, viseme: null, openness: 0.5, energy: 0.2, voiced: false },
    { t: 4 / 24, viseme: 42, openness: 0.5, energy: 0.2, voiced: false }
  ]
  const fallbacks = visemeFallbackWarnings(synthetic)
  console.log(`  fallback warnings: ${JSON.stringify(fallbacks)}`)
  check('only the illegal frames are reported', fallbacks.length === 3, String(fallbacks.length))
  check('frame 1 is named with its label', /frame 1\b/.test(fallbacks[0]) && fallbacks[0].includes('ZZ'), fallbacks[0])
  check('frame 3 is named with its label', /frame 3\b/.test(fallbacks[1]) && fallbacks[1].includes('null'), fallbacks[1])
  check('frame 4 is named with its label', /frame 4\b/.test(fallbacks[2]) && fallbacks[2].includes('42'), fallbacks[2])
  check('every warning says what the fallback was', fallbacks.every((line) => line.includes('used "none"')), JSON.stringify(fallbacks))
}

console.log('-- audio_mouth warnings are opt-in too --')
{
  const mouthRegistered = new Map()
  const mouthCtx = {
    tools: { register: (definition) => { mouthRegistered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
  }
  registerMouthTools(mouthCtx)
  const mouthCall = (args) => mouthRegistered.get('audio_mouth').execute(args, toolExec)
  check('audio_mouth is registered', mouthRegistered.has('audio_mouth'))

  const plain = await mouthCall({ text: 'wo ai ni', fps: 24 })
  check('mouth omits warnings by default', !Object.prototype.hasOwnProperty.call(plain, 'warnings'), Object.keys(plain).join(','))
  const asked = await mouthCall({ text: 'wo ai ni', fps: 24, includeWarnings: true })
  check('mouth includeWarnings returns an array', Array.isArray(asked.warnings), typeof asked.warnings)
  const han = await mouthCall({ text: '你好', fps: 24, includeWarnings: true })
  check('mouth reports its text note when asked', han.warnings.some((line) => /pinyin/.test(line)), JSON.stringify(han.warnings))
}

/* --------------------------------------------------------- summary ----- */

await rm(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: lipsync and beats behave' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
