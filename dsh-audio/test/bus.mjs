/**
 * Bus processor tests: measured numbers, asserted against theory.
 *
 * What this proves:
 *
 * - a second-order high-pass at 200 Hz attenuates a 60 Hz tone by the
 *   Butterworth value and leaves a 2 kHz tone flat, and the measured slope
 *   between 60 and 120 Hz matches the expected 12 dB/octave law;
 * - a low-pass on white noise lowers the measured spectral centroid;
 * - a peaking bell and a shelf move a tone by (about) their nominal gain;
 * - an RMS compressor above threshold reduces by (level - threshold)(1 - 1/ratio),
 *   leaves a below-threshold passage bit-identical, and makeup restores the peak;
 * - a duck reaches the requested dip, attacks and releases in the requested
 *   settle times, and returns to unity;
 * - pan -1 / 0 / +1 give the expected per-channel gains and `width` folds and
 *   widens the image;
 * - chain order changes the peak measurably, and the report says why;
 * - trimSilence removes exactly the leading and trailing silence;
 * - renderBus places, pans and limits, and with no master stage the master is
 *   exactly the sum of its stems;
 * - two identical buses produce identical bytes;
 * - an 8 track x 5 s bus is timed;
 * - the `audio_bus` tool registers, writes a decodable file, meters every track,
 *   delegates its stems to `lib/stems.js`, and refuses a self duck and a bad
 *   bit depth.
 *
 * Run with the node from WORKERS.md:
 *   node test/bus.mjs
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { measure } from '../lib/audio.js'
import {
  compressor,
  duck,
  highpass,
  lowpass,
  pan,
  peaking,
  processTrack,
  renderBus,
  shelf,
  trimSilence
} from '../lib/bus.js'
import { makeRng, noise } from '../lib/dsp.js'
import { registerBusTools } from '../lib/tools-bus.js'
import { encodeWavEx } from '../lib/wav-encode.js'
import { decodeWav } from '../lib/wav.js'

const RATE = 48000
const TAU = Math.PI * 2
const BUTTERWORTH_Q = Math.SQRT1_2

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const fmt = (value, digits = 2) => Number(value).toFixed(digits)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function sine (frames, hz, amplitude, sampleRate = RATE, phase = 0) {
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) out[index] = amplitude * Math.sin(TAU * hz * index / sampleRate + phase)
  return out
}

const track = (samples, sampleRate = RATE) => ({ samples, sampleRate })

/** RMS over a time window, in dBFS. Windows are whole cycles in every test below. */
function rmsDb (samples, sampleRate, fromSeconds = 0, toSeconds = Infinity) {
  const start = Math.max(0, Math.round(fromSeconds * sampleRate))
  const end = Math.min(samples.length, Math.round(Math.min(toSeconds, samples.length / sampleRate) * sampleRate))
  let sum = 0
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index]
  const rms = Math.sqrt(sum / Math.max(1, end - start))
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

function peakDb (samples, sampleRate, fromSeconds = 0, toSeconds = Infinity) {
  const start = Math.max(0, Math.round(fromSeconds * sampleRate))
  const end = Math.min(samples.length, Math.round(Math.min(toSeconds, samples.length / sampleRate) * sampleRate))
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const magnitude = Math.abs(samples[index])
    if (magnitude > peak) peak = magnitude
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120
}

/** Gain a filter applied to a steady tone: output RMS minus input RMS. */
function toneGainDb (input, output, sampleRate, from = 0.3, to = 0.95) {
  return rmsDb(output, sampleRate, from, to) - rmsDb(input, sampleRate, from, to)
}

/** The analogue second-order Butterworth high-pass magnitude at one frequency. */
function butterworthHighpassDb (hz, cornerHz) {
  const ratio = hz / cornerHz
  return 20 * Math.log10((ratio * ratio) / Math.sqrt(1 + Math.pow(ratio, 4)))
}

/** The dB gain a process applied to a steady tone, recovered by least squares. */
function gainCurve (input, output, windowFrames) {
  const curve = []
  for (let start = 0; start + windowFrames <= input.length; start += windowFrames) {
    let cross = 0
    let energy = 0
    for (let index = start; index < start + windowFrames; index += 1) {
      cross += output[index] * input[index]
      energy += input[index] * input[index]
    }
    const gain = energy > 0 ? cross / energy : 1
    curve.push({ at: start / RATE, gainDb: 20 * Math.log10(Math.max(gain, 1e-9)) })
  }
  return curve
}

const table = []
const row = (processor, settings, measured, expected) => table.push({ processor, settings, measured, expected })

console.log('bus processing: lib/bus.js')
console.log(`sample rate ${RATE} Hz, RBJ biquads, RMS detector, settle-time envelopes\n`)

/* ---------------------------------------------------------- high-pass -- */

console.log('-- highpass: 200 Hz on steady tones --')
{
  const corner = 200
  const attenuation = {}
  for (const hz of [60, 120, 2000]) {
    const frames = RATE
    const input = sine(frames, hz, 0.5)
    const filtered = highpass(track(input), { hz: corner })
    const measuredGain = toneGainDb(input, filtered.samples, RATE)
    attenuation[hz] = measuredGain
    const expected = hz < corner ? butterworthHighpassDb(hz, corner) : 0
    console.log(`  ${String(hz).padStart(4)} Hz: measured ${fmt(measuredGain, 2).padStart(7)} dB, theoretical ${fmt(expected, 2).padStart(7)} dB, delta ${fmt(measuredGain - expected, 2)} dB`)
    check(`highpass ${hz} Hz matches theory`, Math.abs(measuredGain - expected) <= 0.6,
      `measured ${fmt(measuredGain, 2)} expected ${fmt(expected, 2)}`)
    if (hz === 2000) check('highpass leaves 2 kHz within 0.5 dB', Math.abs(measuredGain) <= 0.5, `${fmt(measuredGain, 2)} dB`)
  }
  // Slope measured across one octave, compared with the same octave of the
  // theoretical curve: this is the 12 dB/octave law, measured rather than assumed.
  const measuredSlope = attenuation[120] - attenuation[60]
  const theorySlope = butterworthHighpassDb(120, corner) - butterworthHighpassDb(60, corner)
  console.log(`  slope 60 -> 120 Hz: measured ${fmt(measuredSlope, 2)} dB/oct (attenuation falls as frequency rises), theoretical ${fmt(theorySlope, 2)} dB/oct, asymptotic 12`)
  check('highpass measured slope matches the theoretical octave', Math.abs(measuredSlope - theorySlope) <= 0.5,
    `measured ${fmt(measuredSlope, 2)} theory ${fmt(theorySlope, 2)}`)
  check('highpass follows the 12 dB/octave law', measuredSlope > 11 && measuredSlope < 12.2, `${fmt(measuredSlope, 2)}`)

  const report = highpass(track(sine(RATE, 60, 0.5)), { hz: corner }).report
  console.log(`  report: hz ${report.hz}, order ${report.order}, slope ${report.slopeDbPerOctave} dB/oct, rms change ${fmt(report.rmsChangeDb, 2)} dB, dc ${fmt(report.dcBefore, 6)} -> ${fmt(report.dcAfter, 6)}`)
  check('highpass report names the corner', report.hz === 200 && report.order === 2, JSON.stringify(report))
  check('highpass report shows attenuation', report.rmsChangeDb <= -19, `${report.rmsChangeDb}`)
  row('highpass', `200 Hz Q ${fmt(BUTTERWORTH_Q, 3)}`, `60 Hz ${fmt(attenuation[60], 2)} dB, 2 kHz ${fmt(attenuation[2000], 2)} dB`, `theory ${fmt(butterworthHighpassDb(60, corner), 2)} / 0 dB`)
}

/* ----------------------------------------------------------- low-pass -- */

console.log('\n-- lowpass: white noise spectral centroid --')
{
  const inputSamples = noise(Math.round(1.5 * RATE), makeRng(7), 'white', RATE)
  const before = measure(inputSamples, RATE)
  const filtered = lowpass(track(inputSamples), { hz: 800 })
  const after = measure(filtered.samples, RATE)
  console.log(`  centroid: ${before.centroidHz} Hz -> ${after.centroidHz} Hz  (rms change ${fmt(filtered.report.rmsChangeDb, 2)} dB)`)
  console.log(`  brightness: ${before.brightness} -> ${after.brightness}, highRatio: ${before.highRatio} -> ${after.highRatio}`)
  check('lowpass lowers the centroid', after.centroidHz < before.centroidHz * 0.5, `${before.centroidHz} -> ${after.centroidHz}`)
  check('lowpass keeps a real body', after.centroidHz > 100, `${after.centroidHz} Hz`)
  check('lowpass removes energy', filtered.report.rmsChangeDb < -6, `${filtered.report.rmsChangeDb} dB`)
  check('lowpass output finite', filtered.samples.every((value) => Number.isFinite(value)))
  row('lowpass', '800 Hz Q .707 on white noise', `centroid ${before.centroidHz} -> ${after.centroidHz} Hz`, 'centroid falls')
}

/* --------------------------------------------------- bell and shelves -- */

console.log('\n-- peaking and shelving --')
{
  const bellInput = sine(RATE, 1000, 0.4)
  const bell = peaking(track(bellInput), { hz: 1000, q: 0.8, gainDb: 9 })
  const bellGain = toneGainDb(bellInput, bell.samples, RATE)
  console.log(`  peaking +9 dB @1 kHz: measured ${fmt(bellGain, 2)} dB at the centre`)
  check('peaking hits its nominal gain', Math.abs(bellGain - 9) <= 0.2, `${fmt(bellGain, 2)} dB`)
  row('peaking', '+9 dB @1 kHz Q 0.8', `${fmt(bellGain, 2)} dB at 1 kHz`, '+9 dB')

  const shelfInput = sine(RATE, 4000, 0.4)
  const high = shelf(track(shelfInput), { kind: 'high', hz: 2000, gainDb: 6 })
  const highGain = toneGainDb(shelfInput, high.samples, RATE)
  console.log(`  high shelf +6 dB @2 kHz: measured ${fmt(highGain, 2)} dB at 4 kHz`)
  check('high shelf lifts the top', highGain > 4 && highGain <= 6.2, `${fmt(highGain, 2)} dB`)
  row('shelf', 'high +6 dB @2 kHz', `${fmt(highGain, 2)} dB at 4 kHz`, 'approaches +6 dB')

  const lowInput = sine(RATE, 100, 0.4)
  const low = shelf(track(lowInput), { kind: 'low', hz: 200, gainDb: -6 })
  const lowGain = toneGainDb(lowInput, low.samples, RATE)
  console.log(`  low shelf -6 dB @200 Hz: measured ${fmt(lowGain, 2)} dB at 100 Hz`)
  check('low shelf cuts the bottom', lowGain < -4 && lowGain >= -6.2, `${fmt(lowGain, 2)} dB`)
}

/* --------------------------------------------------------- compressor -- */

console.log('\n-- compressor: RMS detector, feed-forward, no lookahead --')
{
  const settings = { thresholdDb: -18, ratio: 4, attackMs: 20, releaseMs: 200, makeupDb: 0, kneeDb: 0 }
  const input = sine(Math.round(2 * RATE), 440, Math.pow(10, -6 / 20))
  const compressed = compressor(track(input), settings)
  const measuredRmsDb = rmsDb(input, RATE, 0.5, 1.9)
  const expectedGainReduction = (measuredRmsDb - settings.thresholdDb) * (1 - 1 / settings.ratio)
  const outputRmsDb = rmsDb(compressed.samples, RATE, 0.5, 1.9)
  const measuredGainReduction = measuredRmsDb - outputRmsDb
  console.log(`  input RMS ${fmt(measuredRmsDb, 2)} dBFS, output RMS ${fmt(outputRmsDb, 2)} dBFS`)
  console.log(`  gain reduction: measured ${fmt(measuredGainReduction, 2)} dB, theoretical ${fmt(expectedGainReduction, 2)} dB = (${fmt(measuredRmsDb, 2)} - (${settings.thresholdDb})) * (1 - 1/${settings.ratio})`)
  console.log(`  report: max GR ${fmt(compressed.report.maxGainReductionDb, 2)} dB, mean GR ${fmt(compressed.report.meanGainReductionDb, 2)} dB, ${compressed.report.reducedPercent}% of samples reduced, rms change ${fmt(compressed.report.rmsChangeDb, 2)} dB`)
  check('compressor gain reduction matches theory', Math.abs(measuredGainReduction - expectedGainReduction) <= 1,
    `measured ${fmt(measuredGainReduction, 2)} theory ${fmt(expectedGainReduction, 2)}`)
  check('compressor report agrees', Math.abs(compressed.report.maxGainReductionDb - expectedGainReduction) <= 1,
    `${compressed.report.maxGainReductionDb}`)

  const quietInput = sine(Math.round(1.5 * RATE), 440, Math.pow(10, -36 / 20))
  const quiet = compressor(track(quietInput), settings)
  let quietDifference = 0
  for (let index = 0; index < quietInput.length; index += 1) quietDifference = Math.max(quietDifference, Math.abs(quietInput[index] - quiet.samples[index]))
  console.log(`  quiet passage (-36 dBFS): max sample difference ${quietDifference}, max GR ${fmt(quiet.report.maxGainReductionDb, 2)} dB`)
  check('below-threshold passage is untouched', quietDifference === 0, `${quietDifference}`)
  check('below-threshold report says no GR', quiet.report.maxGainReductionDb === 0, `${quiet.report.maxGainReductionDb}`)

  const madeUp = compressor(track(input), { ...settings, makeupDb: measuredGainReduction })
  const inputPeakDb = peakDb(input, RATE, 0.5, 1.9)
  const madeUpPeakDb = peakDb(madeUp.samples, RATE, 0.5, 1.9)
  console.log(`  makeup ${fmt(measuredGainReduction, 2)} dB: steady peak ${fmt(inputPeakDb, 2)} dBFS -> ${fmt(madeUpPeakDb, 2)} dBFS`)
  check('makeup restores the peak', Math.abs(madeUpPeakDb - inputPeakDb) <= 0.5, `${fmt(madeUpPeakDb - inputPeakDb, 2)} dB`)
  row('compressor', '-18 dBFS, ratio 4, 20/200 ms', `GR ${fmt(measuredGainReduction, 2)} dB, quiet bit-identical`, `theory GR ${fmt(expectedGainReduction, 2)} dB`)
}

/* --------------------------------------------------------------- duck -- */

console.log('\n-- duck: sidechain dip and recovery --')
{
  const frames = Math.round(1.5 * RATE)
  const input = sine(frames, 1000, 0.5)
  const sidechain = new Float32Array(frames)
  const pulseStart = 0.4
  const pulseEnd = 0.5
  sidechain.set(sine(Math.round((pulseEnd - pulseStart) * RATE), 200, 1), Math.round(pulseStart * RATE))
  const settings = { amountDb: 12, attackMs: 20, releaseMs: 200 }
  const ducked = duck(track(input), track(sidechain), settings)
  const curve = gainCurve(input, ducked.samples, 96) // 2 ms windows: two 1 kHz periods

  let maxDipDb = 0
  for (const point of curve) maxDipDb = Math.max(maxDipDb, -point.gainDb)

  // Attack: time from the pulse onset until the dip is within 5 % of full depth.
  const attackTarget = -settings.amountDb * 0.95
  let attackSettle = null
  for (const point of curve) {
    if (point.at < pulseStart) continue
    if (point.gainDb <= attackTarget) { attackSettle = point.at - pulseStart; break }
  }
  // Release: time from the pulse end until the remaining dip is under 5 % again.
  const releaseTarget = -settings.amountDb * 0.05
  let releaseSettle = null
  for (const point of curve) {
    if (point.at < pulseEnd) continue
    if (point.gainDb >= releaseTarget) { releaseSettle = point.at - pulseEnd; break }
  }
  const beforeDip = -curve.find((point) => point.at >= 0.3).gainDb
  const afterDip = -curve[curve.length - 1].gainDb
  console.log(`  requested ${settings.amountDb} dB dip, measured ${fmt(maxDipDb, 2)} dB`)
  console.log(`  attack: settled in ${attackSettle === null ? 'n/a' : fmt(attackSettle * 1000, 1)} ms (requested ${settings.attackMs} ms; the 10 ms RMS detector is in front of the 20 ms gain smoother, so the response is longer than the knob)`)
  console.log(`  release: recovered to 5% in ${releaseSettle === null ? 'n/a' : fmt(releaseSettle * 1000, 1)} ms (requested ${settings.releaseMs} ms)`)
  console.log(`  dip before pulse ${fmt(beforeDip, 2)} dB, after recovery ${fmt(afterDip, 2)} dB; report max ${fmt(ducked.report.maxDuckDb, 2)} dB, sidechain peak ${fmt(ducked.report.sidechainPeakDbfs, 1)} dBFS`)
  check('duck reaches the requested dip', maxDipDb >= settings.amountDb - 0.1, `${fmt(maxDipDb, 2)} dB`)
  check('duck attack stays close to the request', attackSettle !== null && attackSettle * 1000 >= settings.attackMs && attackSettle * 1000 <= settings.attackMs * 2,
    `${attackSettle === null ? 'none' : fmt(attackSettle * 1000, 1)} ms`)
  check('duck release settle time', releaseSettle !== null && Math.abs(releaseSettle * 1000 - settings.releaseMs) <= settings.releaseMs * 0.2,
    `${releaseSettle === null ? 'none' : fmt(releaseSettle * 1000, 1)} ms`)
  check('duck leaves the passage before it alone', beforeDip < 0.2, `${fmt(beforeDip, 2)} dB`)
  check('duck recovers to unity', afterDip < 0.2, `${fmt(afterDip, 2)} dB`)
  row('duck', `${settings.amountDb} dB, ${settings.attackMs}/${settings.releaseMs} ms`, `dip ${fmt(maxDipDb, 2)} dB, attack ${attackSettle === null ? 'n/a' : fmt(attackSettle * 1000, 1)} ms, release ${releaseSettle === null ? 'n/a' : fmt(releaseSettle * 1000, 1)} ms`, `${settings.amountDb} dB, ${settings.attackMs}/${settings.releaseMs} ms`)
}

/* ---------------------------------------------------------------- pan -- */

console.log('\n-- pan: per-channel gains and width --')
{
  const input = sine(RATE / 2, 1000, 0.5)
  const inputRms = rmsDb(input, RATE)
  const cases = {}

  for (const panValue of [-1, 0, 1]) {
    const result = pan(track(input), { pan: panValue, width: 1 })
    const left = result.channels[0]
    const right = result.channels[1]
    const leftDb = rmsDb(left, RATE)
    const rightDb = rmsDb(right, RATE)
    cases[panValue] = { leftDb, rightDb, left, right, report: result.report }
    const relative = (db) => (db <= -100 ? 'silent' : `${fmt(db - inputRms, 2)} dB`)
    console.log(`  pan ${String(panValue).padStart(2)}: left ${relative(leftDb)}, right ${relative(rightDb)}, L/R ${result.report.levelRatioDb === null ? 'one side only' : `${fmt(result.report.levelRatioDb, 2)} dB`}`)
  }
  // Hard left: the right channel is exactly silent, the left is +3 dB.
  check('pan -1 silences the right channel', cases[-1].right.every((value) => value === 0))
  check('pan -1 left is +3 dB', Math.abs((cases[-1].leftDb - inputRms) - 20 * Math.log10(Math.SQRT2)) <= 0.01,
    `${fmt(cases[-1].leftDb - inputRms, 3)} dB`)
  check('pan +1 silences the left channel', cases[1].left.every((value) => value === 0))
  check('pan +1 right is +3 dB', Math.abs((cases[1].rightDb - inputRms) - 20 * Math.log10(Math.SQRT2)) <= 0.01,
    `${fmt(cases[1].rightDb - inputRms, 3)} dB`)
  check('pan 0 is unity in both channels', Math.abs(cases[0].leftDb - inputRms) <= 0.01 && Math.abs(cases[0].rightDb - inputRms) <= 0.01,
    `${fmt(cases[0].leftDb - inputRms, 3)} / ${fmt(cases[0].rightDb - inputRms, 3)} dB`)
  let centreIdentical = true
  for (let index = 0; index < input.length; index += 1) {
    if (cases[0].left[index] !== cases[0].right[index]) { centreIdentical = false; break }
  }
  check('pan 0 duplicates the mono track', centreIdentical)

  // -0.5 pan: the constant-power law says L/R energy ratio is tan^-1 of the angle.
  const half = pan(track(input), { pan: -0.5, width: 1 })
  const halfRatioDb = rmsDb(half.channels[0], RATE) - rmsDb(half.channels[1], RATE)
  const halfTheory = 20 * Math.log10((Math.SQRT2 * Math.cos(Math.PI / 8)) / (Math.SQRT2 * Math.sin(Math.PI / 8)))
  console.log(`  pan -0.5: L/R ${fmt(halfRatioDb, 2)} dB (expected ${fmt(halfTheory, 2)} dB), report ${half.report.levelRatioDb} dB`)
  check('pan ratio follows the constant-power law', Math.abs(halfRatioDb - halfTheory) <= 0.05,
    `${fmt(halfRatioDb, 3)} vs ${fmt(halfTheory, 3)}`)

  // width 0 folds the panned image to mono at the mid level.
  const mono = pan(track(input), { pan: -0.5, width: 0 })
  let monoChannelsIdentical = true
  for (let index = 0; index < input.length; index += 1) {
    if (mono.channels[0][index] !== mono.channels[1][index]) { monoChannelsIdentical = false; break }
  }
  const monoGainDb = rmsDb(mono.channels[0], RATE) - inputRms
  console.log(`  width 0 at pan -0.5: channels identical ${monoChannelsIdentical}, level ${fmt(monoGainDb, 2)} dB (mid = ${fmt(20 * Math.log10(Math.cos(Math.PI / 8)), 2)} dB)`)
  check('width 0 folds to mono', monoChannelsIdentical)
  check('width 0 keeps the mid level', Math.abs(monoGainDb - 20 * Math.log10(Math.cos(Math.PI / 8))) <= 0.02,
    `${fmt(monoGainDb, 3)} dB`)

  // At centre the sides are zero, so width cannot change anything.
  const centredWide = pan(track(input), { pan: 0, width: 2 })
  let centreWidthSame = true
  for (let index = 0; index < input.length; index += 1) {
    if (centredWide.channels[0][index] !== cases[0].left[index] || centredWide.channels[1][index] !== cases[0].right[index]) { centreWidthSame = false; break }
  }
  check('width does nothing at centre', centreWidthSame)

  // width 2 doubles the side: L = mid + 2*side, R = mid - 2*side.
  const wide = pan(track(input), { pan: -0.5, width: 2 })
  const leftGain = Math.SQRT2 * Math.cos(Math.PI / 8)
  const rightGain = Math.SQRT2 * Math.sin(Math.PI / 8)
  const expectedWideLeft = 20 * Math.log10((leftGain + rightGain) / 2 + (leftGain - rightGain))
  const expectedWideRight = 20 * Math.log10((leftGain + rightGain) / 2 - (leftGain - rightGain))
  console.log(`  width 2 at pan -0.5: left ${fmt(rmsDb(wide.channels[0], RATE) - inputRms, 2)} dB (expected ${fmt(expectedWideLeft, 2)}), right ${fmt(rmsDb(wide.channels[1], RATE) - inputRms, 2)} dB (expected ${fmt(expectedWideRight, 2)})`)
  check('width 2 widens the side', Math.abs((rmsDb(wide.channels[0], RATE) - inputRms) - expectedWideLeft) <= 0.05 &&
    Math.abs((rmsDb(wide.channels[1], RATE) - inputRms) - expectedWideRight) <= 0.05)
  row('pan', '-1 / 0 / +1, width 0..2', '-1: L +3.01, R silent · 0: L=R unity · +1: L silent, R +3.01', 'constant power, unity at centre')
}

/* -------------------------------------------------------- trimSilence -- */

console.log('\n-- trimSilence --')
{
  const padded = new Float32Array(RATE)
  padded.set(sine(Math.round(0.3 * RATE), 1000, 0.5), Math.round(0.3 * RATE))
  const trimmed = trimSilence(track(padded), { thresholdDb: -60 })
  console.log(`  1.000 s buffer with a 0.300 s beep + 0.400 s tail: kept ${fmt(trimmed.samples.length / RATE, 3)} s, removed start ${fmt(trimmed.report.removedStartSeconds, 3)} s, removed end ${fmt(trimmed.report.removedEndSeconds, 3)} s, trimmed at ${fmt(-trimmed.report.removedSeconds, 2)} dB`)
  check('trimSilence trims the head', Math.abs(trimmed.report.removedStartSeconds - 0.3) <= 0.002, `${trimmed.report.removedStartSeconds}`)
  check('trimSilence trims the tail', Math.abs(trimmed.report.removedEndSeconds - 0.4) <= 0.002, `${trimmed.report.removedEndSeconds}`)
  check('trimSilence keeps the beep', Math.abs(trimmed.samples.length / RATE - 0.3) <= 0.005, `${trimmed.samples.length / RATE}`)
  const paddedTrim = trimSilence(track(padded), { thresholdDb: -60, padMs: 50 })
  console.log(`  with padMs 50: kept ${fmt(paddedTrim.samples.length / RATE, 3)} s, removed start ${fmt(paddedTrim.report.removedStartSeconds, 3)} s`)
  check('trimSilence honours padMs', Math.abs(paddedTrim.report.removedStartSeconds - 0.25) <= 0.002, `${paddedTrim.report.removedStartSeconds}`)
  const silent = trimSilence(track(new Float32Array(RATE)), {})
  console.log(`  all-silent buffer: ${silent.samples.length} frames, allSilent ${silent.report.allSilent}, removed ${fmt(silent.report.removedSeconds, 2)} s`)
  check('trimSilence reports an all-silent track', silent.samples.length === 0 && silent.report.allSilent === true)
  row('trimSilence', '-60 dBFS, no pad', `removed ${fmt(trimmed.report.removedSeconds, 3)} s of silence`, '0.700 s')
}

/* ---------------------------------------------------------- chain order -- */

console.log('\n-- chain order: highpass before vs after the compressor --')
{
  const frames = Math.round(1.5 * RATE)
  const input = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    const t = index / RATE
    input[index] = 0.45 * Math.sin(TAU * 60 * t) + 0.08 * Math.sin(TAU * 2000 * t)
  }
  const compressorSettings = { thresholdDb: -24, ratio: 8, attackMs: 5, releaseMs: 80, makeupDb: 0, kneeDb: 0 }
  const highpassBefore = processTrack(track(input), [
    { type: 'highpass', hz: 200 },
    { type: 'compressor', ...compressorSettings }
  ])
  const highpassAfter = processTrack(track(input), [
    { type: 'compressor', ...compressorSettings },
    { type: 'highpass', hz: 200 }
  ])
  const peakBefore = peakDb(highpassBefore.samples, RATE, 0.3, 1.4)
  const peakAfter = peakDb(highpassAfter.samples, RATE, 0.3, 1.4)
  const difference = peakBefore - peakAfter
  console.log(`  highpass -> compressor: peak ${fmt(peakBefore, 2)} dBFS, GR ${fmt(highpassBefore.report.gainReductionDb, 2)} dB`)
  console.log(`  compressor -> highpass: peak ${fmt(peakAfter, 2)} dBFS, GR ${fmt(highpassAfter.report.gainReductionDb, 2)} dB`)
  console.log(`  difference ${fmt(difference, 2)} dB: the compressor is level-dependent, so removing the 60 Hz body first lowers the level it reacts to`)
  check('chain order changes the peak measurably', difference > 3, `${fmt(difference, 2)} dB`)
  check('report keeps the chain order', highpassBefore.report.types.join('>') === 'highpass>compressor' && highpassAfter.report.types.join('>') === 'compressor>highpass',
    `${highpassBefore.report.types.join('>')} / ${highpassAfter.report.types.join('>')}`)
  row('chain order', 'highpass(200) vs compressor(-24, 8:1)', `peak differs by ${fmt(difference, 2)} dB`, 'order matters above 3 dB')
}

/* ------------------------------------------------------------ renderBus -- */

console.log('\n-- renderBus: placement, pan, master, meters --')
{
  const layerA = sine(Math.round(0.5 * RATE), 440, 0.4)
  const layerB = sine(Math.round(0.4 * RATE), 660, 0.3)
  const bus = renderBus([
    { id: 'a', samples: layerA, sampleRate: RATE, gainDb: -3, chain: [{ type: 'highpass', hz: 120 }, { type: 'compressor', thresholdDb: -20, ratio: 3 }] },
    { id: 'b', samples: layerB, sampleRate: RATE, gainDb: -6, offsetSeconds: 0.25 }
  ], { sampleRate: RATE, master: { peakDbfs: null, limiter: false } })
  const expectedFrames = Math.max(Math.round(0.5 * RATE), Math.round(0.25 * RATE) + Math.round(0.4 * RATE))
  console.log(`  default channels ${bus.channels} (no pan), frames ${bus.frames}, duration ${fmt(bus.durationSeconds, 3)} s, expected ${expectedFrames} frames`)
  check('unpanned bus stays mono', bus.channels === 1)
  check('timeline covers the last cue', Math.abs(bus.frames - expectedFrames) <= 1, `${bus.frames} vs ${expectedFrames}`)

  // With no master stage the master must be exactly the placed sum of the stems.
  const reconstructed = new Float32Array(bus.frames)
  for (const stem of bus.stems) {
    const start = Math.round(stem.offsetSeconds * RATE)
    for (let index = 0; index < stem.samples.length && start + index < reconstructed.length; index += 1) {
      reconstructed[start + index] += stem.samples[index]
    }
  }
  let sumError = 0
  for (let index = 0; index < bus.frames; index += 1) sumError = Math.max(sumError, Math.abs(reconstructed[index] - bus.master.samples[index]))
  console.log(`  stems placed and summed vs master: max abs error ${sumError}`)
  check('master is the sum of its stems', sumError <= 1e-6, `${sumError}`)

  const statsA = bus.meter.trackStats.find((stats) => stats.id === 'a')
  console.log(`  track a: in ${fmt(statsA.peakInDbfs, 2)} dBFS, out ${fmt(statsA.peakOutDbfs, 2)} dBFS, GR ${fmt(statsA.gainReductionDb, 2)} dB, chain ${statsA.chain.join('>')}`)
  check('track meters report before and after', statsA.peakInDbfs > statsA.peakOutDbfs, `${statsA.peakInDbfs} -> ${statsA.peakOutDbfs}`)
  check('track gain reduction reaches the meter', bus.meter.gainReductionDb > 0.5, `${bus.meter.gainReductionDb}`)
  check('track offset is honoured', Math.abs(statsA.offsetSeconds) < 1e-9 && Math.abs(bus.meter.trackStats[1].offsetSeconds - 0.25) < 1e-9)

  // A panned bus switches to stereo and the image is where it was sent. The
  // layers are offset so each channel can be measured alone: 0..0.5 s is track
  // a only, 0.55..0.95 s is track b only.
  const stereoBus = renderBus([
    { id: 'left', samples: layerA, sampleRate: RATE, gainDb: -6, pan: -1 },
    { id: 'right', samples: layerB, sampleRate: RATE, gainDb: -6, pan: 1, offsetSeconds: 0.55 }
  ], { sampleRate: RATE })
  const stereoLeft = stereoBus.master.channelSamples[0]
  const stereoRight = stereoBus.master.channelSamples[1]
  console.log(`  panned bus: channels ${stereoBus.channels}, channel peaks L ${fmt(stereoBus.master.channelPeaksDbfs[0], 2)} / R ${fmt(stereoBus.master.channelPeaksDbfs[1], 2)} dBFS, file peak ${fmt(stereoBus.master.peakDbfs, 2)} dBFS, mono fold peak ${fmt(stereoBus.master.monoFoldPeakDbfs, 2)} dBFS`)
  check('pan switches the bus to stereo', stereoBus.channels === 2)
  const earlyLeft = rmsDb(stereoLeft, RATE, 0.1, 0.3)
  const earlyRight = rmsDb(stereoRight, RATE, 0.1, 0.3)
  const lateLeft = rmsDb(stereoLeft, RATE, 0.6, 0.8)
  const lateRight = rmsDb(stereoRight, RATE, 0.6, 0.8)
  console.log(`  image: 0.1..0.3 s L ${fmt(earlyLeft, 1)} / R ${fmt(earlyRight, 1)} dBFS, 0.6..0.8 s L ${fmt(lateLeft, 1)} / R ${fmt(lateRight, 1)} dBFS`)
  check('pan puts the first track left', earlyLeft - earlyRight > 20, `${fmt(earlyLeft - earlyRight, 1)} dB`)
  check('pan puts the second track right', lateRight - lateLeft > 20, `${fmt(lateRight - lateLeft, 1)} dB`)
  check('default master normalises the file peak to -1 dBFS', Math.abs(stereoBus.master.peakDbfs + 1) <= 0.01, `${stereoBus.master.peakDbfs}`)

  // A duck declared in a chain must find its sidechain and reduce the layer.
  const music = sine(Math.round(1.2 * RATE), 440, 0.3)
  const dialogue = new Float32Array(Math.round(1.2 * RATE))
  dialogue.set(sine(Math.round(0.1 * RATE), 300, 0.6), Math.round(0.4 * RATE))
  const duckBus = renderBus([
    { id: 'music', samples: music, sampleRate: RATE, chain: [{ type: 'duck', sidechain: dialogue, amountDb: 12, attackMs: 20, releaseMs: 200 }] },
    { id: 'dialogue', samples: dialogue, sampleRate: RATE, gainDb: -6 }
  ], { sampleRate: RATE, master: { peakDbfs: null, limiter: false } })
  const musicStem = duckBus.stems.find((stem) => stem.id === 'music')
  const dipDb = rmsDb(musicStem.samples, RATE, 0.2, 0.3) - rmsDb(musicStem.samples, RATE, 0.42, 0.48)
  const musicStats = duckBus.meter.trackStats.find((stats) => stats.id === 'music')
  console.log(`  ducked chain: music dips ${fmt(dipDb, 2)} dB under the dialogue pulse (report ${fmt(musicStats.maxDuckDb, 2)} dB)`)
  check('renderBus resolves a duck sidechain', dipDb > 9, `${fmt(dipDb, 2)} dB`)
  check('renderBus reports the duck', musicStats.maxDuckDb >= 11.9, `${musicStats.maxDuckDb}`)
  row('renderBus', '2 tracks, hp + compressor, offset', `${bus.frames} frames, GR ${fmt(bus.meter.gainReductionDb, 2)} dB, sum error ${sumError}`, 'master = sum(stems)')
}

/* ------------------------------------------------------------ determinism -- */

console.log('\n-- determinism --')
{
  function fixture () {
    return [
      {
        id: 'hit',
        samples: sine(Math.round(0.8 * RATE), 120, 0.5),
        sampleRate: RATE,
        gainDb: -2,
        pan: -0.6,
        chain: [
          { type: 'highpass', hz: 120 },
          { type: 'peaking', hz: 3000, q: 1, gainDb: 4 },
          { type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 150 }
        ]
      },
      {
        id: 'bed',
        samples: noise(Math.round(1 * RATE), makeRng(11), 'pink', RATE),
        sampleRate: RATE,
        gainDb: -9,
        pan: 0.6,
        width: 0.6,
        chain: [{ type: 'lowpass', hz: 2400 }, { type: 'shelf', kind: 'high', hz: 1200, gainDb: -3 }]
      }
    ]
  }
  const first = renderBus(fixture(), { sampleRate: RATE, master: { peakDbfs: -1, limiter: true, drive: 2 } })
  const second = renderBus(fixture(), { sampleRate: RATE, master: { peakDbfs: -1, limiter: true, drive: 2 } })
  const firstBytes = encodeWavEx(first.master.channelSamples, RATE, { bitDepth: 16, channels: first.channels })
  const secondBytes = encodeWavEx(second.master.channelSamples, RATE, { bitDepth: 16, channels: second.channels })
  let stemsIdentical = true
  for (let index = 0; index < first.stems.length; index += 1) {
    const a = first.stems[index].samples
    const b = second.stems[index].samples
    if (a.length !== b.length) { stemsIdentical = false; break }
    for (let sample = 0; sample < a.length; sample += 1) {
      if (a[sample] !== b[sample]) { stemsIdentical = false; break }
    }
    if (!stemsIdentical) break
  }
  console.log(`  bytes ${firstBytes.length}, sha256 ${sha256(firstBytes)}`)
  console.log(`  twice:   sha256 ${sha256(secondBytes)}`)
  check('identical bytes twice', firstBytes.equals(secondBytes), `${sha256(firstBytes)} != ${sha256(secondBytes)}`)
  check('identical stems twice', stemsIdentical)
  check('master peak is the requested level', Math.abs(first.master.peakDbfs + 1) <= 0.01, `${first.master.peakDbfs}`)
  console.log(`  master peak ${fmt(first.master.peakDbfs, 2)} dBFS, rms ${fmt(first.master.rmsDbfs, 2)} dBFS, crest ${fmt(first.master.crestDb, 2)} dB, drive ${fmt(first.master.driveDb, 2)} dB, gain ${fmt(first.master.gainDb, 2)} dB, limiter engaged ${first.master.limiterEngaged}`)
}

/* ------------------------------------------------------------ bare buffer -- */

console.log('\n-- bare Float32Array input --')
{
  const samples = sine(RATE / 4, 60, 0.5)
  const fromTrack = highpass(track(samples), { hz: 200 })
  const fromBuffer = highpass(samples, { sampleRate: RATE, hz: 200 })
  let same = fromTrack.samples.length === fromBuffer.samples.length
  for (let index = 0; same && index < fromTrack.samples.length; index += 1) same = fromTrack.samples[index] === fromBuffer.samples[index]
  check('bare buffer equals track-shaped input', same)
  try {
    highpass(samples, { hz: 200 })
    check('bare buffer without a rate is rejected', false)
  } catch (error) {
    check('bare buffer without a rate is rejected', /sampleRate/.test(error.message), error.message)
  }
  console.log('  highpass(samples, { sampleRate }) === highpass({ samples, sampleRate }) and a missing rate is a clear error')
}

/* ------------------------------------------------------------ performance -- */

console.log('\n-- performance: 8 tracks x 5 s --')
{
  const tracks = []
  for (let index = 0; index < 8; index += 1) {
    tracks.push({
      id: `t${index + 1}`,
      samples: sine(Math.round(5 * RATE), 200 + index * 110, 0.3),
      sampleRate: RATE,
      gainDb: -6,
      offsetSeconds: index * 0.05,
      pan: (index / 7) * 2 - 1,
      chain: [
        { type: 'highpass', hz: 120 },
        { type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 15, releaseMs: 150 }
      ]
    })
  }
  const startedAt = process.hrtime.bigint()
  const bus = renderBus(tracks, { sampleRate: RATE, master: { peakDbfs: -1, limiter: true } })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  const audioSeconds = 8 * 5
  console.log(`  ${audioSeconds} audio seconds (${bus.frames} frames, ${bus.channels} ch) rendered in ${fmt(elapsedMs, 0)} ms = ${fmt(audioSeconds / (elapsedMs / 1000), 1)}x realtime`)
  console.log(`  master peak ${fmt(bus.master.peakDbfs, 2)} dBFS, max track GR ${fmt(bus.meter.gainReductionDb, 2)} dB`)
  check('8 x 5 s bus completes', bus.frames === Math.round((5 + 7 * 0.05) * RATE), `${bus.frames}`)
  check('8 x 5 s bus is not pathologically slow', elapsedMs < 30000, `${fmt(elapsedMs, 0)} ms`)
}

/* ---------------------------------------------------------------- tool -- */

console.log('\n-- audio_bus tool: register, write, meters, stems, guards --')
{
  const outRoot = join(process.cwd(), 'test', 'out', 'bus-tool')
  await rm(outRoot, { recursive: true, force: true })
  await mkdir(outRoot, { recursive: true })
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => process.cwd() } : undefined)
  }
  registerBusTools(ctx)
  const exec = { agent: { session: { id: 'bus-test' } } }
  const call = (args) => registered.get('audio_bus').execute(args, exec)
  check('registerBusTools registers audio_bus', registered.has('audio_bus'), [...registered.keys()].join(','))

  const args = {
    tracks: [
      { render: { preset: 'impact', duration: 0.5, seed: 3 }, name: 'hit', gainDb: -3, highpassHz: 90, compressor: { thresholdDb: -20, ratio: 3 } },
      { render: { preset: 'chime', duration: 0.8, seed: 4 }, name: 'ding', gainDb: -10, offsetSeconds: 0.2, lowpassHz: 3000, pan: 0.5 }
    ],
    bitDepth: 16,
    out: 'test/out/bus-tool/cue.wav'
  }
  const first = await call(args)
  const second = await call(args)
  const firstBytes = await readFile(join(process.cwd(), first.relativePath))
  const secondBytes = await readFile(join(process.cwd(), second.relativePath))
  const decoded = decodeWav(firstBytes)
  console.log(`  wrote ${first.relativePath} (${first.bytes} bytes, ${fmt(first.durationSeconds, 3)} s, ${first.channels} ch)`)
  console.log(`  text: ${first.text}`)
  check('audio_bus writes a decodable file', decoded.sampleRate === first.sampleRate && decoded.channels.length === first.channels)
  check('audio_bus pans to stereo', first.channels === 2, `${first.channels}`)
  check('audio_bus normalises the master peak', Math.abs(first.metrics.peakDbfs + 1) <= 0.01, `${first.metrics.peakDbfs}`)
  check('audio_bus meters every track', first.tracks.length === 2 && first.tracks[0].gainReductionDb > 0.5,
    JSON.stringify(first.tracks.map((entry) => entry.gainReductionDb)))
  check('audio_bus text names the file and the numbers', first.text.includes(first.relativePath) && first.text.includes('peak') && first.text.includes('GR'), first.text)
  check('audio_bus is deterministic', firstBytes.equals(secondBytes))

  const stemmed = await call({
    tracks: [{ render: { preset: 'chime', duration: 0.5, seed: 5 }, name: 'bell', pan: -0.5 }],
    stems: true,
    outDir: 'test/out/bus-tool/stems',
    out: 'test/out/bus-tool/stem-cue.wav'
  })
  const manifest = JSON.parse(await readFile(join(process.cwd(), stemmed.stems.relativeOutDir, 'stems.json'), 'utf8'))
  console.log(`  stems: ${stemmed.stems.files.map((file) => file.file).join(', ')} + ${stemmed.stems.masterFile} + stems.json, max sum error ${stemmed.stems.maxAbsError.toExponential(2)}`)
  check('audio_bus delegates stems to lib/stems.js', manifest.format === 'dsh-audio-stems' && manifest.stems.length === 1 && stemmed.stems.maxAbsError <= 1e-6,
    JSON.stringify({ format: manifest.format, stems: manifest.stems?.length, error: stemmed.stems.maxAbsError }))
  check('audio_bus says stems are pre-pan mono', stemmed.text.includes('pre-pan'), stemmed.text)

  try {
    await call({ tracks: [{ render: 'tick', name: 'solo', duckFrom: 0 }] })
    check('audio_bus rejects a self duck', false)
  } catch (error) {
    check('audio_bus rejects a self duck', /itself/.test(error.message), error.message)
  }
  try {
    await call({ tracks: [{ render: 'tick' }], bitDepth: 20 })
    check('audio_bus rejects a bad bit depth', false)
  } catch (error) {
    check('audio_bus rejects a bad bit depth', /bitDepth/.test(error.message), error.message)
  }
}

/* ----------------------------------------------------------------- table -- */

console.log('\n-- processor table --')
const nameWidth = Math.max(...table.map((entry) => entry.processor.length), 'processor'.length)
const settingsWidth = Math.max(...table.map((entry) => entry.settings.length), 'settings'.length)
console.log(`  ${'processor'.padEnd(nameWidth)}  ${'settings'.padEnd(settingsWidth)}  measured`)
for (const entry of table) {
  console.log(`  ${entry.processor.padEnd(nameWidth)}  ${entry.settings.padEnd(settingsWidth)}  ${entry.measured}`)
}

console.log(failures === 0 ? `\nOK: all ${checks} bus checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
