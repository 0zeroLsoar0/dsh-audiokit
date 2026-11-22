/**
 * Spatial stage tests.
 *
 * The claims this file has to hold up are physical, so each one is measured
 * rather than asserted from the code: where does a source *land* in a 5.1
 * layout, does a binaural render really carry the Woodworth delay and a shadowed
 * far ear, does doubling the distance really cost 6 dB, and does a 6-channel
 * extensible WAVE header survive the plugin's own decoder.
 *
 * Which layout proves which cue:
 * - **stereo** (speakers at ±30°) is a *pan law* test: a hard-panned source must
 *   put all of its energy in one channel and exact silence in the other.
 * - **binaural** (ears at ±90°) is an *attenuation* test: the far ear must be
 *   clearly down because a head shadows it, but it must never be silent — a real
 *   head does not mute an ear, and a render that does is a pan, not spatial audio.
 *   That pair of numbers is the difference between the two layouts.
 * - **5.1 / quad / 7.1** are *pairwise constant-power* tests: exactly one speaker
 *   at a speaker angle, an equal split between the bracketing pair in between,
 *   and no leakage anywhere else.
 * - **mono** is used for the distance law, so no pan loss can hide inside the
 *   measurement.
 *
 * The direct-path measurements run with `room.wet = 0`: an early reflection is a
 * second arrival with its own delay and direction, and mixing it into an ITD
 * measurement would measure the room instead of the head. The symmetry test runs
 * with the room on, because that is where a broken mirrored tap would show up.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure } from '../lib/audio.js'
import { makeRng } from '../lib/dsp.js'
import {
  HEAD_MODEL,
  LAYOUTS,
  LAYOUT_IDS,
  ambisonics,
  encodeMultichannelWav,
  interauralDelay,
  placeSource,
  renderSpatial
} from '../lib/spatial.js'
import { registerSpatialTools } from '../lib/tools-spatial.js'
import { decodeWav } from '../lib/wav.js'

const RATE = 44100
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url))
await mkdir(OUT_DIR, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

function fmt (value, digits = 2) {
  if (!Number.isFinite(value)) return value > 0 ? '+inf' : '-inf'
  return Number(value).toFixed(digits)
}

/* -------------------------------------------------------------- test signals -- */

/** Deterministic white noise: flat spectrum, so "energy" and "level" agree. */
function whiteNoise (seconds, seed) {
  const rand = makeRng(seed)
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i += 1) out[i] = (rand() * 2 - 1) * 0.5
  return out
}

/**
 * Sparse full-band impulses. A click train measures a delay cleanly: the far
 * ear's impulse response starts exactly at the interaural delay, so the
 * correlation peak is the delay and not the group delay of the head-shadow
 * filter (which would bias a noise-based measurement by ~130 us).
 */
function clickTrain (seconds, seed) {
  const rand = makeRng(seed)
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i += 137) out[i] = rand() > 0.5 ? 0.9 : -0.9
  return out
}

/* --------------------------------------------------------------- measurements -- */

function energy (buffer) {
  let sum = 0
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
  return sum
}

function rmsDb (buffer) {
  const value = Math.sqrt(energy(buffer) / Math.max(1, buffer.length))
  return value > 0 ? 20 * Math.log10(value) : -Infinity
}

/** Per-channel share of the placed energy, summing to 1. */
function shares (placed) {
  const energies = placed.channels.map((channel) => energy(channel))
  const total = energies.reduce((sum, value) => sum + value, 0)
  return energies.map((value) => (total > 0 ? value / total : 0))
}

/** Normalised correlation, used for "W follows the source" and "Y flips sign". */
function correlation (a, b) {
  let cross = 0
  for (let i = 0; i < a.length; i += 1) cross += a[i] * b[i]
  const denominator = Math.sqrt(energy(a) * energy(b))
  return denominator > 0 ? cross / denominator : 0
}

/**
 * Cross-correlation lag between two ear signals, positive when `left` is the
 * delayed one. Parabolic interpolation around the integer peak puts the result
 * on a sub-sample grid, which is what makes a 10 us tolerance meaningful at
 * 44.1 kHz (one sample is 22.7 us).
 */
function measureLag (left, right, maxLag = 90) {
  const scores = new Float64Array(2 * maxLag + 1)
  let bestLag = -maxLag
  let best = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let n = Math.max(0, lag); n < left.length; n += 1) {
      const other = n - lag
      if (other < 0 || other >= right.length) continue
      sum += left[n] * right[other]
    }
    scores[lag + maxLag] = sum
    if (sum > best) {
      best = sum
      bestLag = lag
    }
  }
  const index = bestLag + maxLag
  const y0 = scores[index - 1] ?? 0
  const y1 = scores[index]
  const y2 = scores[index + 1] ?? 0
  const denominator = y0 - 2 * y1 + y2
  const offset = denominator !== 0 ? 0.5 * (y0 - y2) / denominator : 0
  const normaliser = Math.sqrt(energy(left) * energy(right))
  return { lag: bestLag + offset, peak: normaliser > 0 ? best / normaliser : 0 }
}

/**
 * Energy share above `cutoffHz`, via a 2nd-order RBJ high-pass. Used for the
 * head-shadow check: the same filter on both ears means the comparison is of the
 * ears, not of the filter.
 */
function highBandShare (buffer, cutoffHz) {
  const w0 = 2 * Math.PI * cutoffHz / RATE
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const cos = Math.cos(w0)
  const b0 = (1 + cos) / 2
  const b1 = -(1 + cos)
  const b2 = (1 + cos) / 2
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  let high = 0
  let total = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const x0 = buffer[i]
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    high += y0 * y0
    total += x0 * x0
  }
  return total > 0 ? high / total : 0
}

/* ---------------------------------------------------------------- layout table -- */

console.log('spatial stage — layouts')
for (const id of LAYOUT_IDS) {
  const layout = LAYOUTS[id]
  const azimuths = layout.channels.map((channel) => (Number.isFinite(channel.azimuth) ? `${channel.azimuth > 0 ? '+' : ''}${channel.azimuth}` : ' —')).join(' ')
  console.log(
    `  ${id.padEnd(22)} ${String(layout.channelCount).padStart(2)} ch  ${layout.wavOrder.padEnd(22)} az ${azimuths.padEnd(26)} mask 0x${layout.mask.toString(16)}  ${layout.panning}`
  )
}
const WAVE_ORDER = LAYOUT_IDS.map((id) => `${id}=[${LAYOUTS[id].wavOrder}]`).join(' ')
check('seven layouts', LAYOUT_IDS.length === 7, String(LAYOUT_IDS.length))
check('binaural reuses the stereo mask (WAVE has no binaural mask)', LAYOUTS.binaural.mask === LAYOUTS.stereo.mask)
check('ambisonic mask is 0 (abstract channels, not speakers)', LAYOUTS['ambisonic-first-order'].mask === 0, WAVE_ORDER)
check('5.1 and 7.1 keep LFE out of the speaker set',
  !LAYOUTS['5.1'].speakerIndices.includes(3) && !LAYOUTS['7.1'].speakerIndices.includes(3))

/* -------------------------------------------------------- 1. stereo hard pan -- */

console.log('\n1. stereo hard pan (pan law: all of it one side, exact silence the other)')
const panSource = whiteNoise(0.5, 101)
for (const [azimuth, expected] of [[-90, 'L'], [90, 'R']]) {
  const placed = placeSource(panSource, RATE, { position: { azimuth, distance: 1 }, layout: 'stereo', room: { wet: 0 } })
  const share = shares(placed)
  const loud = Math.max(share[0], share[1])
  const quiet = Math.min(share[0], share[1])
  // The far speaker is exactly 0, so the ratio is infinite, not 300 dB: report
  // that honestly instead of printing a made-up finite number.
  const ratioDb = quiet > 0 ? 10 * Math.log10(loud / quiet) : Infinity
  const quietDb = quiet > 0 ? 10 * Math.log10(quiet) : -Infinity
  const loudest = share[0] > share[1] ? 'L' : 'R'
  console.log(`  az ${String(azimuth).padStart(4)}° -> ${loudest} ${fmt(loud * 100, 1)}% of energy, other channel ${fmt(quietDb, 1)} dB of it ` +
    `(ratio ${fmt(ratioDb, 1)} dB)`)
  check(`stereo az ${azimuth} lands in ${expected}`, loudest === expected, loudest)
  check(`stereo az ${azimuth} hard-pan ratio > 20 dB`, ratioDb > 20, `${fmt(ratioDb)} dB`)
  check(`stereo az ${azimuth} far speaker is exact silence`, quiet === 0, String(quiet))
}
const centre = placeSource(panSource, RATE, { position: { azimuth: 0 }, layout: 'stereo', room: { wet: 0 } })
const centreShare = shares(centre)
console.log(`  az    0° -> L ${fmt(centreShare[0] * 100, 1)}% / R ${fmt(centreShare[1] * 100, 1)}% ` +
  `(${fmt(20 * Math.log10(Math.sqrt(centreShare[0])), 2)} dB per side: the phantom centre)`)
check('stereo centre is equal', Math.abs(20 * Math.log10(centreShare[0] / centreShare[1])) < 0.01)
check('stereo centre is -3.01 dB per side', Math.abs(20 * Math.log10(Math.sqrt(centreShare[0])) + 3.01) < 0.02)
// The distinction the brief asks to explain: the *stereo* far speaker is silent
// (a pan), the *binaural* far ear is not (section 3).
console.log('  note: a stereo hard pan leaves the far speaker at exactly 0 (silence, -inf dB) — that is a pan law, not a head. ' +
  'Section 3 is the layout where the far ear stays audible.')

/* ------------------------------------------------------------------ 2. 5.1 -- */

console.log('\n2. 5.1 panning (0° centre, ±90 the side pairs, 180 the surrounds)')
const layout51 = LAYOUTS['5.1']
const surround = whiteNoise(0.5, 202)
const azimuthShares = new Map()
for (const azimuth of [0, 90, -90, 180]) {
  const placed = placeSource(surround, RATE, { position: { azimuth, distance: 1 }, layout: '5.1', room: { wet: 0 } })
  const share = shares(placed)
  azimuthShares.set(azimuth, share)
  const cells = layout51.channels.map((channel, index) => `${channel.name} ${fmt(share[index] * 100, 1)}%`).join('  ')
  // "Leakage" is everything outside the two loudest channels: pairwise panning
  // should leave exactly nothing there, so the printed number is -inf.
  const ordered = [...share].sort((a, b) => b - a)
  const leakage = ordered.slice(2).reduce((sum, value) => sum + value, 0)
  const leakageDb = 10 * Math.log10(Math.max(1e-30, leakage))
  console.log(`  az ${String(azimuth).padStart(4)}°  ${cells}  leakage ${leakage === 0 ? '-inf' : fmt(leakageDb, 1)} dB`)
  // Constant power: the total energy in the file equals the mono source's.
  const levelDelta = placed.report.level.rmsDbfs - rmsDb(surround)
  check(`5.1 az ${azimuth} keeps source power`, Math.abs(levelDelta) < 0.05, `${fmt(levelDelta, 3)} dB`)
  const sorted = [...share].sort((a, b) => b - a)
  check(`5.1 az ${azimuth} uses at most 2 channels`, share.filter((value) => value > 1e-9).length <= 2,
    String(share.filter((value) => value > 1e-9).length))
  check(`5.1 az ${azimuth} pairwise power sums to 1`, Math.abs(sorted[0] + (sorted[1] ?? 0) - 1) < 1e-6,
    String(sorted[0] + (sorted[1] ?? 0)))
}
{
  const centre51 = azimuthShares.get(0)
  check('5.1 0° goes to FC only', centre51[2] > 0.9999 && centre51.reduce((sum, value, index) => sum + (index === 2 ? 0 : value), 0) < 1e-9,
    JSON.stringify(centre51.map((value) => fmt(value, 4))))
  const right51 = azimuthShares.get(90)
  const left51 = azimuthShares.get(-90)
  // FL, FC and LFE and BL must be silent for a source on the right; BR is one of
  // the two channels that legitimately carries it.
  check('5.1 +90° lands on FR+BR only', right51[0] < 1e-12 && right51[2] < 1e-12 && right51[3] < 1e-12 && right51[4] < 1e-12,
    `FL ${fmt(right51[0], 6)} FC ${fmt(right51[2], 6)} LFE ${fmt(right51[3], 6)} BL ${fmt(right51[4], 6)}`)
  check('5.1 +90° puts all energy on the right pair', Math.abs(right51[1] + right51[5] - 1) < 1e-9, String(right51[1] + right51[5]))
  check('5.1 ±90° are mirror images',
    Math.abs(20 * Math.log10(right51[1] / left51[0])) < 0.01 && Math.abs(20 * Math.log10(right51[5] / left51[4])) < 0.01,
    `FR/L ${fmt(20 * Math.log10(right51[1] / left51[0]), 3)} BR/BL ${fmt(20 * Math.log10(right51[5] / left51[4]), 3)}`)
  const back51 = azimuthShares.get(180)
  check('5.1 180° goes to the surrounds equally',
    back51[0] < 1e-12 && back51[1] < 1e-12 && back51[2] < 1e-12 && Math.abs(back51[4] - back51[5]) < 1e-6,
    `BL ${fmt(back51[4], 6)} BR ${fmt(back51[5], 6)}`)
  check('5.1 LFE never carries a source', back51[3] < 1e-12 && right51[3] < 1e-12, String(back51[3]))
  console.log(`  az  90° splits FR/BR ${fmt(20 * Math.log10(right51[1] / right51[5]), 2)} dB apart ` +
    `(pairwise across the 80° arc between +30° and +110°); az 180° splits BL/BR ` +
    `${fmt(20 * Math.log10(back51[5] / back51[4]), 3)} dB apart (an equal phantom)`)
}

/* --------------------------------------- 2b. the other layouts and options -- */

console.log('\n2b. quad / 7.1 / mono / width / roomSize (the rest of the layout table)')
for (const [layoutId, azimuth, expected] of [['quad', 45, 'FR'], ['quad', 180, null], ['7.1', 90, 'SR'], ['7.1', 150, 'BR']]) {
  const placed = placeSource(surround, RATE, { position: { azimuth, distance: 1 }, layout: layoutId, room: { wet: 0 } })
  const share = shares(placed)
  const loudest = LAYOUTS[layoutId].channels.reduce((best, channel, index) => (share[index] > share[best.index] ? channel : best), { index: 0 })
  const cells = LAYOUTS[layoutId].channels.map((channel, index) => `${channel.name} ${fmt(share[index] * 100, 0)}%`).join(' ')
  console.log(`  ${layoutId.padEnd(4)} az ${String(azimuth).padStart(4)}°  ${cells}`)
  if (expected === null) {
    // 180° in quad is the rear pair: equal, like 5.1's surrounds.
    check('quad 180° splits equally across the rear pair', Math.abs(share[2] - share[3]) < 1e-6 && share[2] + share[3] > 0.9999,
      `BL ${fmt(share[2], 6)} BR ${fmt(share[3], 6)}`)
  } else {
    check(`${layoutId} az ${azimuth}° lands on ${expected}`, loudest.name === expected && share[loudest.index] > 0.9999,
      `${loudest.name} ${fmt(share[loudest.index], 6)}`)
  }
}
{
  const monoPlaced = placeSource(surround, RATE, { position: { azimuth: 137, distance: 1 }, layout: 'mono', room: { wet: 0 } })
  console.log(`  mono az 137° -> ${monoPlaced.channelCount} channel, level ${fmt(monoPlaced.report.level.rmsDbfs)} dBFS ` +
    `(no pan loss: ${fmt(monoPlaced.report.level.rmsDbfs - rmsDb(surround), 3)} dB vs the source)`)
  check('mono layout is one channel at unity', monoPlaced.channelCount === 1 && Math.abs(monoPlaced.report.level.rmsDbfs - rmsDb(surround)) < 0.01)

  // width: 0 folds the pair to mono, 2 widens it (and inverts the far side, as
  // every mid/side widener does).
  const hardLeft = placeSource(surround, RATE, { position: { azimuth: -90 }, layout: 'stereo', room: { wet: 0 } })
  const folded = placeSource(surround, RATE, { position: { azimuth: -90 }, layout: 'stereo', room: { wet: 0 }, width: 0 })
  const widened = placeSource(surround, RATE, { position: { azimuth: -90 }, layout: 'stereo', room: { wet: 0 }, width: 2 })
  console.log(`  width: 1 -> L ${fmt(hardLeft.report.channels[0].rmsDbfs, 1)} / R ${fmt(hardLeft.report.channels[1].rmsDbfs, 1)} dBFS · ` +
    `0 -> ${fmt(folded.report.channels[0].rmsDbfs, 1)} / ${fmt(folded.report.channels[1].rmsDbfs, 1)} · ` +
    `2 -> ${fmt(widened.report.channels[0].rmsDbfs, 1)} / ${fmt(widened.report.channels[1].rmsDbfs, 1)}`)
  check('width 0 folds the pair to mono', Math.abs(folded.report.channels[0].rmsDbfs - folded.report.channels[1].rmsDbfs) < 0.01)
  check('width 2 widens the image',
    widened.report.channels[0].rmsDbfs > hardLeft.report.channels[0].rmsDbfs + 3 && widened.report.channels[1].rmsDbfs > -30,
    `L ${fmt(widened.report.channels[0].rmsDbfs)} R ${fmt(widened.report.channels[1].rmsDbfs)} dBFS`)

  // roomSize (short form) must move the walls: a bigger room reflects later.
  const small = placeSource(surround, RATE, { position: { azimuth: 0 }, layout: 'stereo', roomSize: 0 })
  const large = placeSource(surround, RATE, { position: { azimuth: 0 }, layout: 'stereo', roomSize: 1 })
  const lastDelay = (placed) => placed.report.room.taps[placed.report.room.taps.length - 1].delayMs
  console.log(`  roomSize: 0 -> walls ${fmt(small.report.room.taps[0].delayMs, 2)}..${fmt(lastDelay(small), 2)} ms · ` +
    `1 -> ${fmt(large.report.room.taps[0].delayMs, 2)}..${fmt(lastDelay(large), 2)} ms (size moves the walls in time)`)
  check('roomSize scales the wall delays', lastDelay(large) > lastDelay(small) * 2,
    `${fmt(lastDelay(small), 2)} vs ${fmt(lastDelay(large), 2)} ms`)
  // Damping, not size, is what darkens the later pair.
  const damped = placeSource(surround, RATE, { position: { azimuth: 0 }, layout: 'stereo', room: { damping: 1, wet: 0.3 } })
  console.log(`  damping: 0.5 -> pair cutoffs ${large.report.room.taps[0].cutoffHz}/${large.report.room.taps[3].cutoffHz} Hz · ` +
    `1 -> ${damped.report.room.taps[0].cutoffHz}/${damped.report.room.taps[3].cutoffHz} Hz`)
  check('damping darkens the later reflections more', damped.report.room.taps[3].cutoffHz < damped.report.room.taps[0].cutoffHz)
  check('a dry room has no taps', placeSource(surround, RATE, { layout: 'stereo', room: { wet: 0 } }).report.room.taps.length === 0)
}

/* -------------------------------------------------------------- 3. binaural -- */

console.log('\n3. binaural head model (ITD from Woodworth, ILD + head shadow, symmetry)')
const headSource = whiteNoise(0.5, 303)

// Symmetry: with the room ON, because mirrored reflections are where asymmetry
// would hide. A dead-ahead source must reach both ears identically.
const symmetric = placeSource(headSource, RATE, { position: { azimuth: 0 }, layout: 'binaural' })
const symmetricL = rmsDb(symmetric.channels[0])
const symmetricR = rmsDb(symmetric.channels[1])
let symmetryWorst = 0
for (let i = 0; i < symmetric.channels[0].length; i += 1) {
  symmetryWorst = Math.max(symmetryWorst, Math.abs(symmetric.channels[0][i] - symmetric.channels[1][i]))
}
console.log(`  az    0°  L ${fmt(symmetricL)} dBFS · R ${fmt(symmetricR)} dBFS · difference ${fmt(Math.abs(symmetricL - symmetricR), 4)} dB ` +
  `· worst sample ${symmetryWorst.toExponential(1)} (room on: ${symmetric.report.room.taps.length} taps)`)
check('binaural 0° is symmetric within 0.5 dB', Math.abs(symmetricL - symmetricR) < 0.5,
  `${fmt(Math.abs(symmetricL - symmetricR), 4)} dB`)
// Not bit-identical: the two ears accumulate the mirrored reflections in the
// opposite order, and `(d + a) + b` and `(d + b) + a` round differently in the
// last ulp. Anything below -120 dBFS of difference is float bookkeeping, not a
// model asymmetry, so that is the bound the test holds the render to.
check('binaural 0° is symmetric to the last bit of float noise', symmetryWorst < 1e-6, symmetryWorst.toExponential(2))

// ITD on a click train, direct path only: an early reflection is a second
// arrival with its own delay, so it would be measured instead of the head.
// Five azimuths, because the *residual* is the interesting part: it is a
// constant ~0.2 samples at every angle and every fractional part, which is the
// head-shadow filter's own group delay plus the interpolator's phase error, not
// a direction-dependent error in the model.
const clicks = clickTrain(0.4, 304)
const itdModel = interauralDelay(90, 0)
const residuals = []
for (const azimuth of [90, -90, 45, 30, 0]) {
  const placed = placeSource(clicks, RATE, { position: { azimuth }, layout: 'binaural', room: { wet: 0 } })
  const lag = measureLag(placed.channels[0], placed.channels[1])
  const measuredUs = lag.lag / RATE * 1e6
  const expectedUs = interauralDelay(azimuth, 0) * 1e6
  const appliedSamples = placed.report.binaural.itdSeconds * RATE
  if (azimuth !== 0) residuals.push(lag.lag - appliedSamples)
  console.log(`  az ${String(azimuth).padStart(4)}°  ITD measured ${fmt(measuredUs, 2)} us (${fmt(lag.lag, 3)} samples, peak ${fmt(lag.peak, 3)}) · ` +
    `Woodworth predicts ${fmt(expectedUs, 2)} us (${fmt(appliedSamples, 3)} samples) · error ${fmt(measuredUs - expectedUs, 2)} us`)
  if (azimuth === 0) check('binaural 0° ITD is zero', Math.abs(measuredUs) < 2, `${fmt(measuredUs)} us`)
  else check(`binaural ${azimuth}° ITD matches Woodworth within 10 us`, Math.abs(measuredUs - expectedUs) <= 10,
    `${fmt(measuredUs - expectedUs)} us`)
  check(`binaural ${azimuth}° ITD sign follows the side`, Math.sign(lag.lag) === Math.sign(azimuth) || azimuth === 0, String(lag.lag))
}
const residualMagnitude = Math.max(...residuals.map(Math.abs))
console.log(`  |residual| across those azimuths: ${fmt(Math.min(...residuals.map(Math.abs)) * 1e6 / RATE, 2)}..` +
  `${fmt(residualMagnitude * 1e6 / RATE, 2)} us (constant to ${fmt(residualMagnitude, 3)} samples regardless of angle or fractional part: ` +
  'the shadow filter\'s group delay plus the interpolator phase error, not a direction error)')
check('ITD residual is sub-sample and constant', residualMagnitude < 0.5, `${fmt(residualMagnitude, 3)} samples`)
const headRadius = HEAD_MODEL.headRadiusM
const woodworthMax = (headRadius / HEAD_MODEL.speedOfSound) * (Math.PI / 2 + 1)
console.log(`  head model: ${(headRadius * 100).toFixed(2)} cm sphere at ${HEAD_MODEL.speedOfSound} m/s -> max ITD ` +
  `${fmt(woodworthMax * 1e6, 2)} us; measured ${fmt(itdModel * 1e6, 2)} us at 90°`)

// ILD and head shadow, direct path only.
const side = placeSource(headSource, RATE, { position: { azimuth: 90 }, layout: 'binaural', room: { wet: 0 } })
const nearEar = side.channels[1]
const farEar = side.channels[0]
const nearDb = rmsDb(nearEar)
const farDb = rmsDb(farEar)
const ild = farDb - nearDb
console.log(`  az   90°  near ear (R) ${fmt(nearDb)} dBFS · far ear (L) ${fmt(farDb)} dBFS · ILD ${fmt(ild)} dB ` +
  `(${fmt(10 ** (ild / 10) * 100, 1)}% of the near ear's power) · shadow cutoff ${side.report.binaural.shadowCutoffHz} Hz`)
// The brief's second number belongs to *this* layout, not to the stereo pan above.
check('binaural far ear is at least -20 dB (audible, not muted)', ild >= -20, `${fmt(ild)} dB`)
check('binaural far ear is clearly attenuated', ild < -6, `${fmt(ild)} dB`)
check('binaural near ear is the right ear for a right source', side.report.binaural.nearEar === 'R', side.report.binaural.nearEar)

const nearBand = highBandShare(nearEar, 4000)
const farBand = highBandShare(farEar, 4000)
const nearCentroid = measure(nearEar, RATE).centroidHz
const farCentroid = measure(farEar, RATE).centroidHz
console.log(`  az   90°  head shadow: 4 kHz+ share ${fmt(farBand * 100, 1)}% far vs ${fmt(nearBand * 100, 1)}% near ` +
  `(${fmt(10 * Math.log10(farBand / nearBand), 2)} dB) · centroid ${farCentroid} Hz far vs ${nearCentroid} Hz near`)
check('binaural far ear loses high frequencies', farBand < nearBand * 0.8,
  `${fmt(10 * Math.log10(farBand / nearBand), 2)} dB`)
check('binaural far ear centroid is lower', farCentroid < nearCentroid * 0.75, `${farCentroid} vs ${nearCentroid} Hz`)
const rear = placeSource(headSource, RATE, { position: { azimuth: 180 }, layout: 'binaural', room: { wet: 0 } })
check('binaural 180° is the front/back ambiguity (no ITD)', Math.abs(measureLag(rear.channels[0], rear.channels[1]).lag) < 0.5)
const overhead = placeSource(headSource, RATE, { position: { azimuth: 90, elevation: 90 }, layout: 'binaural', room: { wet: 0 } })
console.log(`  az   90° elevation 90°: ITD ${fmt(interauralDelay(90, 90) * 1e6, 2)} us ` +
  '(overhead: the lateral component vanishes, so the head has no cue left)')
check('binaural overhead has no lateral cue', Math.abs(interauralDelay(90, 90)) < 1e-6)

/* -------------------------------------------------------------- 4. distance -- */

console.log('\n4. distance (inverse-distance law, and air absorption tilting the far field)')
const distanceSource = whiteNoise(0.5, 404)
const near = placeSource(distanceSource, RATE, { position: { azimuth: 0, distance: 1 }, layout: 'mono', room: { wet: 0 } })
const doubled = placeSource(distanceSource, RATE, { position: { azimuth: 0, distance: 2 }, layout: 'mono', room: { wet: 0 } })
const levelDelta = rmsDb(doubled.channels[0]) - rmsDb(near.channels[0])
const nearMetrics = measure(near.channels[0], RATE)
const farMetrics = measure(doubled.channels[0], RATE)
console.log(`  1 m vs 2 m: level ${fmt(rmsDb(near.channels[0]))} -> ${fmt(rmsDb(doubled.channels[0]))} dBFS ` +
  `= ${fmt(levelDelta, 3)} dB (expected -6.02)`)
console.log(`  1 m vs 2 m: centroid ${nearMetrics.centroidHz} -> ${farMetrics.centroidHz} Hz ` +
  `(${fmt(100 * farMetrics.centroidHz / nearMetrics.centroidHz, 1)}%) · air absorption ${doubled.report.airAbsorption.cutoffHz} Hz ` +
  `with ${fmt(doubled.report.airAbsorption.compensationDb)} dB level compensation`)
check('doubling distance costs 6 dB (+/-0.5)', Math.abs(levelDelta + 6.0206) <= 0.5, `${fmt(levelDelta, 3)} dB`)
check('air absorption is applied beyond 1 m', doubled.report.airAbsorption.applied === true && near.report.airAbsorption.applied === false)
check('doubling distance lowers the centroid', farMetrics.centroidHz < nearMetrics.centroidHz * 0.85,
  `${farMetrics.centroidHz} vs ${nearMetrics.centroidHz} Hz`)
const quarter = placeSource(distanceSource, RATE, { position: { azimuth: 0, distance: 4 }, layout: 'mono', room: { wet: 0 } })
console.log(`  1 m vs 4 m: ${fmt(rmsDb(quarter.channels[0]) - rmsDb(near.channels[0]), 3)} dB (expected -12.04), ` +
  `centroid ${measure(quarter.channels[0], RATE).centroidHz} Hz`)
check('4x distance costs 12 dB (+/-0.5)', Math.abs(rmsDb(quarter.channels[0]) - rmsDb(near.channels[0]) + 12.0412) <= 0.5)

/* --------------------------------------------- 5. multichannel WAV roundtrip -- */

console.log('\n5. multichannel WAVE writer (extensible header, mask, channel order)')
for (const bitDepth of [16, 24]) {
  const channels = Array.from({ length: 6 }, (_, channel) => {
    const buffer = new Float32Array(2048)
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = (channel + 1) * 0.1
    return buffer
  })
  const bytes = encodeMultichannelWav(channels, RATE, { bitDepth, layout: '5.1' })
  const fmtSize = bytes.readUInt32LE(16)
  const formatTag = bytes.readUInt16LE(20)
  const mask = bytes.readUInt32LE(40)
  const cbSize = bytes.readUInt16LE(36)
  const validBits = bytes.readUInt16LE(38)
  const guid = bytes.toString('hex', 44, 60)
  const decoded = decodeWav(bytes)
  const step = 1 / 2 ** (bitDepth - 1)
  let maxError = 0
  for (let channel = 0; channel < 6; channel += 1) {
    for (let i = 0; i < channels[channel].length; i += 1) {
      maxError = Math.max(maxError, Math.abs(decoded.channels[channel][i] - channels[channel][i]))
    }
  }
  const order = decoded.channels.map((channel) => fmt(channel[0], 3)).join(',')
  console.log(`  ${bitDepth}-bit: ${bytes.length} B · fmt ${fmtSize} B tag 0x${formatTag.toString(16)} validBits ${validBits} cbSize ${cbSize} ` +
    `mask 0x${mask.toString(16)} · decodeWav -> ${decoded.channels.length} ch @ ${decoded.sampleRate} Hz, ${decoded.bitDepth}-bit · ` +
    `max error ${fmt(maxError / step, 3)} LSB · order ${order}`)
  check(`wav ${bitDepth}-bit extensible header`, fmtSize === 40 && formatTag === 0xfffe && cbSize === 22 && validBits === bitDepth)
  check(`wav ${bitDepth}-bit 5.1 mask`, mask === 0x3f, `0x${mask.toString(16)}`)
  check(`wav ${bitDepth}-bit PCM subformat GUID`, guid === '0100000000001000800000aa00389b71', guid)
  check(`wav ${bitDepth}-bit decodeWav reads 6 channels`, decoded.channels.length === 6, String(decoded.channels.length))
  check(`wav ${bitDepth}-bit rate preserved`, decoded.sampleRate === RATE)
  check(`wav ${bitDepth}-bit within quantisation`, maxError <= step * (bitDepth === 16 ? 2 : 0.75), `${fmt(maxError / step, 3)} LSB`)
  check(`wav ${bitDepth}-bit channel order preserved`,
    decoded.channels.every((channel, index) => Math.abs(channel[0] - (index + 1) * 0.1) < step * 2),
    order)
}
for (const [channelCount, expectedMask] of [[1, 0x4], [2, 0x3], [4, 0x33], [6, 0x3f], [8, 0x63f]]) {
  const channels = Array.from({ length: channelCount }, () => new Float32Array(64).fill(0.25))
  const bytes = encodeMultichannelWav(channels, RATE, { bitDepth: 16 })
  const mask = bytes.readUInt32LE(40)
  const decoded = decodeWav(bytes)
  console.log(`  ${channelCount} ch -> mask 0x${mask.toString(16)} (expected 0x${expectedMask.toString(16)}), decodeWav ${decoded.channels.length} ch`)
  check(`wav ${channelCount} ch mask`, mask === expectedMask, `0x${mask.toString(16)}`)
  check(`wav ${channelCount} ch roundtrip`, decoded.channels.length === channelCount)
}
{
  // An ambisonic file is four abstract signals, not four speakers: mask 0 is the
  // correct answer and the writer must take it from the layout.
  const ambiBytes = encodeMultichannelWav(Array.from({ length: 4 }, () => new Float32Array(64).fill(0.1)), RATE, { bitDepth: 16, layout: 'ambisonic-first-order' })
  const ambiDecoded = decodeWav(ambiBytes)
  console.log(`  ambisonic-first-order -> mask 0x${ambiBytes.readUInt32LE(40).toString(16)}, decodeWav ${ambiDecoded.channels.length} ch`)
  check('wav ambisonic mask is 0', ambiBytes.readUInt32LE(40) === 0)
  check('wav ambisonic roundtrip', ambiDecoded.channels.length === 4)
  // The documented fallback: a plain 44-byte PCM header for 1/2 channels.
  const plain = encodeMultichannelWav([new Float32Array(64).fill(0.5), new Float32Array(64).fill(-0.5)], RATE, { bitDepth: 16, extensible: false })
  const plainDecoded = decodeWav(plain)
  console.log(`  plain fallback (2 ch): ${plain.length} B, fmt ${plain.readUInt32LE(16)} B tag 0x${plain.readUInt16LE(20).toString(16)}, decodeWav ${plainDecoded.channels.length} ch`)
  check('plain fallback keeps a 44-byte header', plain.readUInt32LE(16) === 16 && plain.readUInt16LE(20) === 1 && plain.length === 44 + 64 * 4)
  check('plain fallback roundtrips', plainDecoded.channels.length === 2 && plainDecoded.channels[1][0] === -0.5)
  let rejected = false
  try { encodeMultichannelWav(Array.from({ length: 3 }, () => new Float32Array(8)), RATE) } catch { rejected = true }
  check('writer refuses a channel count with no mask', rejected)
}

/* ------------------------------------------------------------- 6. ambisonics -- */

console.log('\n6. first-order B-format (W omnidirectional, Y flips front-left/right, constant energy)')
const ambiSource = whiteNoise(0.4, 606)
const azimuthEnergies = []
const coefficientW = []
for (let azimuth = 0; azimuth < 360; azimuth += 10) {
  const encoded = ambisonics(ambiSource, RATE, { azimuth })
  const total = energy(encoded.components.W) + energy(encoded.components.X) +
    energy(encoded.components.Y) + energy(encoded.components.Z)
  azimuthEnergies.push(10 * Math.log10(total / energy(ambiSource)))
  coefficientW.push(encoded.components.W[1000] / ambiSource[1000])
}
const ambiLeft = ambisonics(ambiSource, RATE, { azimuth: -90 })
const ambiRight = ambisonics(ambiSource, RATE, { azimuth: 90 })
const wCorrelation = correlation(ambiLeft.components.W, ambiSource)
const yLeftCorrelation = correlation(ambiLeft.components.Y, ambiSource)
const yRightCorrelation = correlation(ambiRight.components.Y, ambiSource)
const spread = Math.max(...azimuthEnergies) - Math.min(...azimuthEnergies)
console.log(`  W: correlation with the source ${fmt(wCorrelation, 6)}, coefficient ${fmt(coefficientW[0], 6)} at every one of 36 azimuths ` +
  `(spread ${fmt(Math.max(...coefficientW) - Math.min(...coefficientW), 9)}) — omnidirectional and all-positive`)
console.log(`  Y: correlation ${fmt(yLeftCorrelation, 4)} for a left source, ${fmt(yRightCorrelation, 4)} for a right source ` +
  `(Y = ${fmt(ambiLeft.report.coefficients.Y, 3)} vs ${fmt(ambiRight.report.coefficients.Y, 3)}) — FuMa +Y is left, so it flips`)
console.log(`  energy: W+X+Y+Z is ${fmt(azimuthEnergies[0])} dB above the source at every azimuth, spread ${fmt(spread, 6)} dB ` +
  '(FuMa weights W by 1/sqrt2, so the constant is 1.5x = +1.76 dB; SN3D is +3.01, N3D +6.02)')
check('W is omnidirectional', Math.abs(wCorrelation - 1) < 1e-6, fmt(wCorrelation, 6))
check('W coefficient is identical at every azimuth', Math.max(...coefficientW) - Math.min(...coefficientW) < 1e-9)
check('W coefficient is positive (all-positive)', Math.min(...coefficientW) > 0)
check('Y flips sign between left and right', Math.abs(yLeftCorrelation + yRightCorrelation) < 1e-6 &&
  yLeftCorrelation > 0.99 && yRightCorrelation < -0.99, `${fmt(yLeftCorrelation, 4)} / ${fmt(yRightCorrelation, 4)}`)
check('energy is conserved across azimuth within 0.5 dB', spread < 0.5, `${fmt(spread, 6)} dB`)
check('FuMa energy factor is 1.5x (+1.76 dB)', Math.abs(azimuthEnergies[0] - 1.7609) < 0.01, fmt(azimuthEnergies[0], 3))
for (const normalization of ['fuma', 'sn3d', 'n3d']) {
  const encoded = ambisonics(ambiSource, RATE, { azimuth: 33, normalization })
  const factor = 10 * Math.log10(encoded.report.energyFactor)
  const measured = 10 * Math.log10((energy(encoded.components.W) + energy(encoded.components.X) +
    energy(encoded.components.Y) + energy(encoded.components.Z)) / energy(ambiSource))
  console.log(`  ${normalization.padEnd(4)}: factor ${fmt(factor, 3)} dB (measured ${fmt(measured, 3)} dB), order [${encoded.order.join(' ')}]`)
  check(`ambisonic ${normalization} factor matches`, Math.abs(measured - factor) < 0.02, `${fmt(measured)} vs ${fmt(factor)}`)
}
const acn = ambisonics(ambiSource, RATE, { azimuth: 90 }, { ordering: 'acn' })
console.log(`  ordering: fuma [${ambiRight.order.join(' ')}] vs acn [${acn.order.join(' ')}] (same signals, AmbiX puts Y Z X)`)
check('acn reorders to W Y Z X', acn.order.join(' ') === 'W Y Z X' && acn.channels[1] === acn.components.Y)
check('fuma order is W X Y Z', ambiRight.order.join(' ') === 'W X Y Z')

/* ----------------------------------------------- 7. determinism + performance -- */

console.log('\n7. determinism and performance (8 sources x 5 s -> 5.1)')
const renderSpec = () => ({
  sources: [
    { samples: whiteNoise(2, 701), position: { azimuth: -60, distance: 1 } },
    { samples: whiteNoise(2, 702), position: { azimuth: 45, distance: 2.5 }, gainDb: -4 },
    { samples: whiteNoise(2, 703), position: { azimuth: 180, distance: 1, elevation: 20 }, gainDb: -8 }
  ],
  layout: '5.1',
  durationSeconds: 2,
  room: { size: 0.5, damping: 0.4, wet: 0.25 }
})
const first = renderSpatial(renderSpec())
const second = renderSpatial(renderSpec())
const firstBytes = encodeMultichannelWav(first.channels, first.sampleRate, { bitDepth: 16, layout: first.layout })
const secondBytes = encodeMultichannelWav(second.channels, second.sampleRate, { bitDepth: 16, layout: second.layout })
console.log(`  same request twice: ${firstBytes.length} bytes each, ${Buffer.compare(firstBytes, secondBytes) === 0 ? 'identical' : 'DIFFERENT'}`)
check('renderSpatial is deterministic', Buffer.compare(firstBytes, secondBytes) === 0)
const different = encodeMultichannelWav(renderSpatial({
  ...renderSpec(),
  sources: [{ samples: whiteNoise(2, 701), position: { azimuth: 0, distance: 1 } }]
}).channels, RATE, { bitDepth: 16, layout: '5.1' })
check('a different azimuth changes the bytes', Buffer.compare(firstBytes, different) !== 0)

const perfSources = Array.from({ length: 8 }, (_, index) => ({
  samples: whiteNoise(5, 900 + index),
  sampleRate: RATE,
  position: { azimuth: -180 + index * 45, distance: 1 + index * 0.7 },
  gainDb: -6
}))
const startedAt = performance.now()
const perfRender = renderSpatial({ sources: perfSources, layout: '5.1', durationSeconds: 5 })
const renderMs = performance.now() - startedAt
const encodeStartedAt = performance.now()
const perfBytes = encodeMultichannelWav(perfRender.channels, RATE, { bitDepth: 16, layout: '5.1' })
const encodeMs = performance.now() - encodeStartedAt
const audioSeconds = perfRender.report.durationSeconds
const realtimeFactor = audioSeconds / ((renderMs + encodeMs) / 1000)
console.log(`  ${perfSources.length} sources x 5 s -> ${perfRender.channelCount} ch ${fmt(audioSeconds, 3)} s (incl. ${fmt(perfRender.report.roomTailSeconds * 1000, 0)} ms tail): ` +
  `render ${fmt(renderMs, 1)} ms + encode ${fmt(encodeMs, 1)} ms = ${fmt(renderMs + encodeMs, 1)} ms ` +
  `(${fmt(realtimeFactor, 1)}x realtime, ${fmt(perfBytes.length / 1024, 0)} KB)`)
check('8 sources x 5 s renders faster than realtime', realtimeFactor > 1, `${fmt(realtimeFactor, 1)}x`)
check('8 sources x 5 s renders in under 8 s', renderMs + encodeMs < 8000, `${fmt(renderMs + encodeMs, 0)} ms`)
check('every channel of the perf render is finite',
  perfRender.channels.every((channel) => channel.every((value) => Number.isFinite(value))))
// LFE is deliberately empty: the 0.1 channel is a low-frequency effects feed, and
// panning a source into it is wrong (it is not a speaker position).
check('perf render fills every directional channel, and only those',
  perfRender.report.channels.every((channel) => LAYOUTS['5.1'].channels[channel.index].kind !== 'speaker' || channel.rmsDbfs > -120),
  JSON.stringify(perfRender.report.channels.map((channel) => channel.rmsDbfs)))
check('perf render leaves the LFE empty', perfRender.report.channels[3].rmsDbfs === -120,
  String(perfRender.report.channels[3].rmsDbfs))

/* ------------------------------------------------------------------- 8. tool -- */

console.log('\n8. audio_spatial tool (fake Cordis context, real files)')
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => OUT_DIR } : undefined)
}
const exec = { agent: { session: { id: 'spatial-test' } } }
registerSpatialTools(ctx)
check('registers audio_spatial', registered.has('audio_spatial'), [...registered.keys()].join(','))
{
  const tool = registered.get('audio_spatial')
  const toolArgs = {
    sources: [
      { render: { preset: 'impact', duration: 0.6, seed: 3 }, azimuth: 40, distance: 1.5 },
      { render: { preset: 'chime', duration: 0.6, seed: 4 }, azimuth: -80, distance: 1, gainDb: -3 },
      { render: { preset: 'tick', duration: 0.3, seed: 5 }, azimuth: 175, distance: 3, gainDb: -9, loop: true }
    ],
    layout: '5.1',
    durationSeconds: 1.2,
    bitDepth: 24,
    out: join(OUT_DIR, 'spatial-51.wav')
  }
  const result = await tool.execute(toolArgs, exec)
  const file = await readFile(result.path)
  const decoded = decodeWav(file)
  console.log(`  ${result.relativePath} · ${result.bytes} B · ${decoded.channels.length} ch ${decoded.bitDepth}-bit @ ${decoded.sampleRate} Hz ` +
    `· ${fmt(result.durationSeconds, 3)} s · peak ${fmt(result.report.peakDbfs)} dBFS`)
  console.log(`  text: ${result.text}`)
  check('tool wrote a 6-channel 24-bit 5.1 file', decoded.channels.length === 6 && decoded.bitDepth === 24 && result.layout === '5.1')
  check('tool summary is bounded', typeof result.text === 'string' && result.text.includes('5.1') && result.text.includes('6-ch'))
  check('tool reports per-channel peaks', result.channels.length === 6 && result.channels.every((channel) => Number.isFinite(channel.peakDbfs)))
  check('tool reports the widest source', result.report.widest !== null && typeof result.report.widest.spreadChannels === 'number')
  check('tool text names the widest source', /widest source #\d/.test(result.text))
  check('tool reports the room tail', result.report.durationSeconds > 1.19 && result.report.roomTailSeconds > 0)
  check('tool keeps the source count', result.report.sources.length === 3)
  // The whole promise of the plugin is "same request, same bytes": the tool has
  // to hold it end to end, not only inside renderSpatial.
  const second = await tool.execute(toolArgs, exec)
  check('tool output is byte-identical on a second run', Buffer.compare(file, await readFile(second.path)) === 0)
  let rejected = false
  try { await tool.execute({ sources: [{ render: { preset: 'impact' } }], layout: 'dolby-atmos' }, exec) } catch { rejected = true }
  check('tool rejects an unknown layout', rejected)
}

/* ------------------------------------------------------------------ summary -- */

console.log(failures === 0 ? '\nOK: spatial stage behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
