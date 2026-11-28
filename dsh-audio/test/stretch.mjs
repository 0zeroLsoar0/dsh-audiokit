/**
 * Acceptance tests for lib/stretch.js and the `audio_stretch` tool.
 *
 * Every check prints the number it measured: the point is a report you can read
 * without listening, showing *how* the stretcher behaves rather than only that
 * it exited zero. Run it with node (the package is ESM):
 *
 *   node test/stretch.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRng } from '../lib/dsp.js'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { STRETCH_LIMITS, changeTempo, fitToDuration, pitchShift, timeStretch } from '../lib/stretch.js'
import { legacyResampleTo } from './support/legacy-resample.mjs'
import { registerStretchTools } from '../lib/tools-stretch.js'

const RATE = 44100
let failures = 0

function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : `  (${detail})`}`)
}

function num (value, digits = 2) {
  return Number(value).toFixed(digits)
}

/* ------------------------------------------------------------- signals -- */

function sineWave (hz, seconds, rate = RATE, amplitude = 0.5) {
  const frames = Math.round(seconds * rate)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin(2 * Math.PI * hz * i / rate)
  return out
}

/** A short 100 bpm click train: 6 ms decaying 2 kHz bursts with silence between. */
function clickTrain (bpm, seconds, rate = RATE) {
  const frames = Math.round(seconds * rate)
  const out = new Float32Array(frames)
  const interval = 60 / bpm
  const clickFrames = Math.round(0.006 * rate)
  for (let at = 0.05; at < seconds - 0.01; at += interval) {
    const start = Math.round(at * rate)
    for (let i = 0; i < clickFrames && start + i < frames; i += 1) {
      const t = i / rate
      out[start + i] += Math.exp(-t / 0.0018) * Math.sin(2 * Math.PI * 2000 * t) * 0.85
    }
  }
  return out
}

/** A percussive hit: 0.7 ms noise click plus a decaying 140/320 Hz body. */
function decayingHit (rate = RATE, seconds = 0.7, atSeconds = 0.05) {
  const frames = Math.round(seconds * rate)
  const out = new Float32Array(frames)
  const start = Math.round(atSeconds * rate)
  const length = Math.round(0.35 * rate)
  const rand = makeRng(0x51ED7A1B)
  for (let i = 0; i < length && start + i < frames; i += 1) {
    const t = i / rate
    const body = Math.sin(2 * Math.PI * 140 * t) * 0.6 + Math.sin(2 * Math.PI * 320 * t) * 0.25
    const click = i < 30 ? (rand() * 2 - 1) * (1 - i / 30) * 0.9 : 0
    out[start + i] = (body + click) * Math.exp(-t / 0.06) * 0.9
  }
  return out
}

/** Deterministic tonal + noise bed, the worst case for the similarity search. */
function noiseBed (seconds, rate = RATE) {
  const frames = Math.round(seconds * rate)
  const out = new Float32Array(frames)
  const rand = makeRng(0x2545F491)
  let brown = 0
  for (let i = 0; i < frames; i += 1) {
    brown = brown * 0.995 + (rand() * 2 - 1) * 0.02
    out[i] = 0.25 * Math.sin(2 * Math.PI * 180 * i / rate) +
      0.12 * Math.sin(2 * Math.PI * 1450 * i / rate) +
      brown * 0.6
  }
  return out
}

/* ---------------------------------------------------------- measurements -- */

function rms (samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function mean (samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]
  return sum / Math.max(1, samples.length)
}

function peakOf (samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/**
 * Attack detector: a peak envelope on `blockSeconds` blocks, then the first
 * block above 10 % and above 90 % of the loudest block. The peak envelope (not
 * an averaged one) is what makes this work on a 140 Hz body — a moving average
 * would follow the waveform rather than the envelope and report the period.
 */
function attackProfile (samples, rate = RATE, blockSeconds = 0.00025) {
  const block = Math.max(1, Math.round(blockSeconds * rate))
  const blocks = Math.floor(samples.length / block)
  const level = new Float64Array(blocks)
  let peak = 0
  for (let b = 0; b < blocks; b += 1) {
    let value = 0
    for (let i = b * block; i < (b + 1) * block; i += 1) {
      const magnitude = Math.abs(samples[i])
      if (magnitude > value) value = magnitude
    }
    level[b] = value
    if (value > peak) peak = value
  }
  let ten = -1
  let ninety = -1
  for (let b = 0; b < blocks; b += 1) {
    if (ten < 0 && level[b] > 0.1 * peak) ten = b
    if (ninety < 0 && level[b] > 0.9 * peak) { ninety = b; break }
  }
  const seconds = (index) => (index * block) / rate
  return { onset: seconds(ten), rise: seconds(ninety) - seconds(ten), peak }
}

/** Rising-edge onset detector on a peak envelope, used for the tempo check. */
function detectOnsets (samples, rate = RATE, thresholdRatio = 0.15, refractorySeconds = 0.05) {
  const hop = Math.max(8, Math.round(rate * 0.0005))
  const blocks = Math.floor(samples.length / hop)
  const level = new Float64Array(blocks)
  let peak = 0
  for (let b = 0; b < blocks; b += 1) {
    let value = 0
    for (let i = b * hop; i < (b + 1) * hop; i += 1) {
      const magnitude = Math.abs(samples[i])
      if (magnitude > value) value = magnitude
    }
    level[b] = value
    if (value > peak) peak = value
  }
  const threshold = peak * thresholdRatio
  const onsets = []
  let last = -Infinity
  let quiet = true
  for (let b = 0; b < blocks; b += 1) {
    if (quiet && level[b] > threshold && b - last > refractorySeconds / 0.0005) {
      onsets.push((b * hop) / rate)
      last = b
      quiet = false
    } else if (level[b] < threshold * 0.5) {
      quiet = true
    }
  }
  return onsets
}

/** Mean inter-onset interval in seconds, from the first to the last onset. */
function meanInterval (onsets) {
  if (onsets.length < 2) return 0
  return (onsets[onsets.length - 1] - onsets[0]) / (onsets.length - 1)
}

/**
 * Autocorrelation pitch estimate with sub-sample refinement. Peaks are picked
 * from the smallest lag that is within 10 % of the best one, which is what stops
 * a periodic signal from being reported an octave low.
 */
function autocorrelationPitch (samples, rate = RATE, minHz = 60, maxHz = 1200) {
  const start = Math.floor(samples.length * 0.3)
  const count = Math.min(Math.round(0.4 * rate), samples.length - start)
  const minLag = Math.max(2, Math.floor(rate / maxHz))
  const maxLag = Math.ceil(rate / minHz)
  const limit = count - maxLag
  if (limit < 64) return 0
  const correlation = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
    let dot = 0
    let left = 0
    let right = 0
    for (let i = 0; i < limit; i += 1) {
      const a = samples[start + i]
      const b = samples[start + i + lag]
      dot += a * b
      left += a * a
      right += b * b
    }
    correlation[lag] = dot / Math.sqrt(left * right + 1e-20)
  }
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) if (correlation[lag] > best) best = correlation[lag]
  let chosen = -1
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const isPeak = correlation[lag] >= correlation[lag - 1] && correlation[lag] >= correlation[lag + 1]
    if (isPeak && correlation[lag] >= best * 0.9) {
      chosen = lag
      break
    }
  }
  if (chosen < 0) return 0
  const left = correlation[chosen - 1]
  const middle = correlation[chosen]
  const right = correlation[chosen + 1]
  const denominator = left - 2 * middle + right
  const offset = Math.abs(denominator) < 1e-12 ? 0 : (0.5 * (left - right)) / denominator
  return rate / (chosen + offset)
}

/**
 * THD+N of a single known tone: least-squares fit of one sinusoid at `frequency`
 * over the middle half of the signal, then everything that is left over, in dB
 * relative to the fundamental. Measured on the interior on purpose — the first
 * and last windows are fade regions, not the steady state being judged.
 */
function thdPlusNoiseDb (samples, rate = RATE, frequency = 1000) {
  const start = Math.floor(samples.length * 0.25)
  const count = Math.min(Math.floor(samples.length * 0.5), Math.round(rate * 0.5))
  const weights = new Float64Array(count)
  for (let i = 0; i < count; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count)
    weights[i] = hann * hann
  }
  const omega = (2 * Math.PI * frequency) / rate
  let sinSin = 0
  let cosCos = 0
  let sinCos = 0
  let xSin = 0
  let xCos = 0
  for (let i = 0; i < count; i += 1) {
    const weight = weights[i]
    const s = Math.sin(omega * i)
    const c = Math.cos(omega * i)
    const x = samples[start + i]
    sinSin += weight * s * s
    cosCos += weight * c * c
    sinCos += weight * s * c
    xSin += weight * x * s
    xCos += weight * x * c
  }
  const determinant = sinSin * cosCos - sinCos * sinCos
  const a = (xCos * sinCos - xSin * cosCos) / -determinant
  const b = (xSin * sinCos - xCos * sinSin) / -determinant
  let fundamental = 0
  let residual = 0
  for (let i = 0; i < count; i += 1) {
    const weight = weights[i]
    const phase = omega * i
    const fitted = a * Math.sin(phase) + b * Math.cos(phase)
    const error = samples[start + i] - fitted
    fundamental += weight * fitted * fitted
    residual += weight * error * error
  }
  return 10 * Math.log10(residual / fundamental)
}

function identicalBytes (left, right) {
  if (left.length !== right.length) return false
  return Buffer.compare(Buffer.from(left.buffer), Buffer.from(right.buffer)) === 0
}

/* -------------------------------------------------------------- report -- */

console.log(`stretch.js acceptance  ·  ${RATE} Hz  ·  factors ${STRETCH_LIMITS.minFactor}..${STRETCH_LIMITS.maxFactor}  ·  +/-${STRETCH_LIMITS.maxSemitones} semitones\n`)

/* ---- 1. duration exactness ---- */
console.log('-- duration exactness --')
{
  const cue = sineWave(440, 1, RATE)
  for (const factor of [0.5, 0.75, 1.33, 2]) {
    const stretched = timeStretch(cue, RATE, factor)
    const expected = Math.round(cue.length * factor)
    const delta = stretched.length - expected
    check(`factor ${factor} length`, Math.abs(delta) <= 1, `got ${stretched.length}, want ${expected}`)
    check(`factor ${factor} not silent`, rms(stretched) > 0.01, `rms ${num(rms(stretched), 4)}`)
    console.log(
      `  factor ${String(factor).padEnd(4)}  ${cue.length} -> ${stretched.length} samples ` +
      `(want ${expected}, delta ${delta} sample)  ${num(stretched.length / RATE, 3)} s  rms ${num(rms(stretched), 4)}`
    )
  }
  const identity = timeStretch(cue, RATE, 1)
  check('factor 1 is a copy', identicalBytes(identity, cue) && identity !== cue)
  console.log(`  factor 1      ${identity.length} samples, byte-identical copy: ${identicalBytes(identity, cue)}`)
}

/* ---- 2. tempo ---- */
console.log('\n-- tempo (inter-onset spacing) --')
{
  const train = clickTrain(100, 4)
  const nonAnchoredRms = rms(train)
  const retimed = changeTempo(train, RATE, 100, 125)
  const onsetsIn = detectOnsets(train)
  const onsetsOut = detectOnsets(retimed)
  const inBpm = 60 / meanInterval(onsetsIn)
  const outBpm = 60 / meanInterval(onsetsOut)
  const expectedLength = Math.round(train.length * 0.8)
  console.log(`  in   ${onsetsIn.length} onsets, mean spacing ${num(meanInterval(onsetsIn) * 1000, 1)} ms -> ${num(inBpm, 2)} bpm, rms ${num(nonAnchoredRms, 4)}`)
  console.log(`  0.8x ${onsetsOut.length} onsets, mean spacing ${num(meanInterval(onsetsOut) * 1000, 1)} ms -> ${num(outBpm, 2)} bpm`)
  check('tempo length', Math.abs(retimed.length - expectedLength) <= 1, `${retimed.length} vs ${expectedLength}`)
  check('tempo 125 bpm', Math.abs(outBpm - 125) <= 125 * 0.02, `measured ${num(outBpm, 2)} bpm`)
  check('tempo keeps click count', onsetsOut.length === onsetsIn.length, `${onsetsOut.length} vs ${onsetsIn.length}`)
}

/* ---- 3. pitch ---- */
console.log('\n-- pitch shift --')
{
  const tone = sineWave(220, 1.5, RATE)
  const expected = 220 * Math.pow(2, 7 / 12)
  const shifted = pitchShift(tone, RATE, 7)
  const measured = autocorrelationPitch(shifted, RATE)
  console.log(`  220 Hz +7 semitones -> ${num(measured, 2)} Hz (want ${num(expected, 2)}), duration ${num(shifted.length / RATE, 3)} s vs ${num(tone.length / RATE, 3)} s`)
  check('pitch frequency', Math.abs(measured - expected) <= expected * 0.01, `measured ${num(measured, 2)}`)
  check('pitch duration preserved', Math.abs(shifted.length - tone.length) <= 1, `${shifted.length} vs ${tone.length}`)
  check('pitch not silent', rms(shifted) > 0.01, `rms ${num(rms(shifted), 4)}`)
  const down = pitchShift(tone, RATE, -7)
  const measuredDown = autocorrelationPitch(down, RATE)
  const expectedDown = 220 / Math.pow(2, 7 / 12)
  console.log(`  220 Hz -7 semitones -> ${num(measuredDown, 2)} Hz (want ${num(expectedDown, 2)})`)
  check('pitch down', Math.abs(measuredDown - expectedDown) <= expectedDown * 0.01, `measured ${num(measuredDown, 2)}`)
}

/* ---- 3b. upward pitch shift: the anti-alias window ---- */
console.log('\n-- pitch shift up: mirror rejection versus the old resampler --')
{
  // `resampleTo` builds the window at `half` (the tap count) instead of at the
  // fixed support, so on every upward shift the taps end where the Blackman
  // taper is still at ~0.34. The truncated kernel loses stopband attenuation
  // and folds the top band of the stretched signal back into the output.
  //
  // A band-limited stimulus is what can *measure* that: white noise has real
  // content everywhere, and after an octave up its own passband replicates into
  // 11-22 kHz through the decimation itself, so a band total cannot tell signal
  // from mirror. A noise-like multitone above the 11.025 kHz fold (written as
  // sines, so it is exactly band-limited and deterministic) puts all of its
  // energy where the correct kernel has to reject it: everything that appears
  // below 10.5 kHz afterwards is the mirror the old kernel let through.
  function bandNoise (loHz, hiHz, seconds, seed = 0x51ED7A1B) {
    const rand = makeRng(seed)
    const frames = Math.round(seconds * RATE)
    const components = []
    for (let hz = loHz; hz <= hiHz; hz += 400) components.push({ hz: hz + (rand() - 0.5) * 120, phase: rand() * Math.PI * 2 })
    const amplitude = 0.6 / Math.sqrt(components.length)
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) {
      let value = 0
      for (const component of components) value += Math.sin(2 * Math.PI * component.hz * i / RATE + component.phase)
      out[i] = value * amplitude
    }
    return out
  }

  /** Energy in [lo, hi) by direct DFT, in dB: a precise probe for "is the band empty?". */
  function bandEnergyDb (samples, lo, hi, stepHz = 200) {
    const start = Math.floor(samples.length * 0.2)
    const count = Math.min(samples.length - start, Math.round(RATE * 0.8))
    let energy = 0
    for (let hz = lo; hz < hi; hz += stepHz) {
      let real = 0
      let imaginary = 0
      const omega = 2 * Math.PI * hz / RATE
      for (let i = 0; i < count; i += 1) {
        const value = samples[start + i]
        real += value * Math.cos(omega * i)
        imaginary += value * Math.sin(omega * i)
      }
      const amplitude = 2 * Math.sqrt(real * real + imaginary * imaginary) / count
      energy += amplitude * amplitude
    }
    return 10 * Math.log10(energy + 1e-24)
  }

  for (const [loHz, hiHz] of [[14000, 21000], [16000, 21000]]) {
    const input = bandNoise(loHz, hiHz, 1.5)
    // The stretch half of pitchShift is shared: only the resample stage differs.
    const stretched = timeStretch(input, RATE, 2)
    const shifted = pitchShift(input, RATE, 12)
    const legacy = legacyResampleTo(stretched, input.length)
    const mirrorOld = bandEnergyDb(legacy, 100, 10500)
    const mirrorNew = bandEnergyDb(shifted, 100, 10500)
    const improvement = mirrorOld - mirrorNew
    console.log(`  ${String(loHz).padStart(5)}-${String(hiHz).padStart(5)} Hz +12 st: mirror energy 0-10.5 kHz ` +
      `old ${num(mirrorOld, 1)} dB -> new ${num(mirrorNew, 1)} dB (${num(improvement, 1)} dB better)`)
    check(`+12 st ${loHz}-${hiHz} Hz has a measurable mirror in the old kernel`, mirrorOld > -100, `${num(mirrorOld, 1)} dB`)
    check(`+12 st ${loHz}-${hiHz} Hz mirror is at least 20 dB lower`, improvement >= 20, `${num(improvement, 1)} dB`)
  }

  // Passband control on full-band white noise: the 11-22 kHz band after an
  // octave up is the shifted passband (not an alias product), so the fix has to
  // leave its level alone rather than "lower" it.
  const white = noiseBed(1.5)
  const whiteStretched = timeStretch(white, RATE, 2)
  const whiteLegacy = legacyResampleTo(whiteStretched, white.length)
  const whiteShifted = pitchShift(white, RATE, 12)
  const passbandOld = bandEnergyDb(whiteLegacy, 11025, 22050)
  const passbandNew = bandEnergyDb(whiteShifted, 11025, 22050)
  console.log(`  white noise control: output 11-22 kHz (the shifted passband) old ${num(passbandOld, 1)} dB -> new ${num(passbandNew, 1)} dB`)
  check('white-noise passband level is unchanged', Math.abs(passbandNew - passbandOld) <= 1.5, `${num(passbandNew - passbandOld, 2)} dB`)
}

/* ---- 4. quality ---- */
console.log('\n-- quality: distortion, DC, transient --')
{
  const tone = sineWave(1000, 2, RATE)
  const stretched = timeStretch(tone, RATE, 1.5)
  const inputThdn = thdPlusNoiseDb(tone, RATE, 1000)
  const outputThdn = thdPlusNoiseDb(stretched, RATE, 1000)
  console.log(`  1 kHz x1.5: THD+N ${num(outputThdn, 1)} dB (input baseline ${num(inputThdn, 1)} dB)`)
  check('1 kHz THD+N below -30 dB', outputThdn < -30, `measured ${num(outputThdn, 1)} dB`)

  const inputDc = mean(tone)
  const outputDc = mean(stretched)
  console.log(`  DC offset: output ${outputDc.toExponential(2)} / input ${inputDc.toExponential(2)}  (peak ${num(peakOf(stretched), 3)})`)
  check('no added DC offset', Math.abs(outputDc) < 5e-4, `mean ${outputDc}`)
  check('peak stays in range', peakOf(stretched) <= 1.001, `peak ${peakOf(stretched)}`)

  const hit = decayingHit()
  const stretchedHit = timeStretch(hit, RATE, 1.5)
  const before = attackProfile(hit)
  const after = attackProfile(stretchedHit)
  const expectedOnset = before.onset * 1.5
  console.log(
    `  percussive hit: onset ${num(before.onset * 1000, 2)} ms -> ${num(after.onset * 1000, 2)} ms ` +
    `(want ${num(expectedOnset * 1000, 2)} ms, delta ${num((after.onset - expectedOnset) * 1000, 2)} ms)`
  )
  console.log(
    `                  rise ${num(before.rise * 1000, 2)} ms -> ${num(after.rise * 1000, 2)} ms, ` +
    `peak ${num(before.peak, 3)} -> ${num(after.peak, 3)}`
  )
  check('attack not smeared', Math.abs(after.onset - expectedOnset) <= 0.005,
    `onsets differ by ${num((after.onset - expectedOnset) * 1000, 2)} ms`)
  check('attack rise not widened', after.rise - before.rise <= 0.005,
    `rise ${num(after.rise * 1000, 2)} ms vs ${num(before.rise * 1000, 2)} ms`)
  check('attack level kept', Math.abs(after.peak - before.peak) / before.peak < 0.15,
    `peak ${num(after.peak, 3)} vs ${num(before.peak, 3)}`)
}

/* ---- 5. fitToDuration ---- */
console.log('\n-- fitToDuration (6 s cue onto a 4.3 s shot) --')
{
  const cue = sineWave(300, 6, RATE)
  const fitted = fitToDuration(cue, RATE, 4.3)
  const expectedFrames = Math.round(4.3 * RATE)
  console.log(
    `  6.000 s -> ${num(fitted.samples.length / RATE, 3)} s (factor ${num(fitted.factor, 4)}, method ${fitted.method}), ` +
    `expected ${expectedFrames} frames, got ${fitted.samples.length}`
  )
  check('fit length exact', Math.abs(fitted.samples.length - expectedFrames) <= 1, `${fitted.samples.length}`)
  check('fit factor', Math.abs(fitted.factor - 4.3 / 6) < 1e-6, `${fitted.factor}`)
  check('fit method', fitted.method === 'stretch', fitted.method)
  const same = fitToDuration(cue, RATE, 6)
  check('same length is a no-op', same.method === 'none' && same.factor === 1 && same.samples.length === cue.length,
    `${same.method} ${same.factor}`)
  console.log(`  already 6.000 s: method ${same.method}, factor ${same.factor}`)
}

/* ---- 6. determinism ---- */
console.log('\n-- determinism --')
{
  const bed = noiseBed(1)
  const first = timeStretch(bed, RATE, 1.33)
  const second = timeStretch(bed, RATE, 1.33)
  const samplesEqual = identicalBytes(first, second)
  const wavA = encodeWav([first], RATE, { dither: false })
  const wavB = encodeWav([second], RATE, { dither: false })
  const bytesEqual = Buffer.compare(wavA, wavB) === 0
  const pitchFirst = pitchShift(bed, RATE, -3)
  const pitchSecond = pitchShift(bed, RATE, -3)
  console.log(`  timeStretch twice: samples identical ${samplesEqual}, wav bytes identical (dither off) ${bytesEqual}`)
  console.log(`  pitchShift twice: samples identical ${identicalBytes(pitchFirst, pitchSecond)}`)
  check('stretch is deterministic', samplesEqual)
  check('wav bytes deterministic without dither', bytesEqual)
  check('pitch shift is deterministic', identicalBytes(pitchFirst, pitchSecond))
  // The file on disk must be reproducible too, because a cached path is only a
  // useful cache if the bytes behind it cannot change between runs.
  const plainA = encodeWav([first], RATE)
  const plainB = encodeWav([second], RATE)
  const plainEqual = Buffer.compare(plainA, plainB) === 0
  console.log(`  wav bytes identical with default options: ${plainEqual}`)
  check('wav bytes deterministic with default options', plainEqual)
}

console.log('\n-- boundary trim --')
{
  // The last overlap-add window ends mid-rise, so without a tail fade the file
  // would stop at a non-zero sample and click. A 2 ms raised-cosine tail and an
  // untouched head are the contract: the head is a sample-exact copy so an
  // attack is never softened.
  const tone = sineWave(997, 1, RATE)
  const stretched = timeStretch(tone, RATE, 1.5)
  const headExact = stretched[0] === tone[0] && stretched[10] === tone[10] && stretched[100] === tone[100]
  const tailSample = Math.abs(stretched[stretched.length - 1])
  console.log(`  first 101 samples identical to the input: ${headExact}; last sample ${tailSample.toExponential(2)} (input last sample ${Math.abs(tone[tone.length - 1]).toExponential(2)})`)
  check('head is a sample-exact copy', headExact)
  check('tail fades to silence', tailSample < 1e-3, `last sample ${tailSample}`)
  const abrupt = new Float32Array(RATE)
  for (let i = 0; i < abrupt.length; i += 1) abrupt[i] = 0.8 * Math.sin(2 * Math.PI * 220 * i / RATE)
  const faded = timeStretch(abrupt, RATE, 2)
  check('tail fade applied on a sustained tone', Math.abs(faded[faded.length - 1]) < 1e-3, `${faded[faded.length - 1]}`)
}

/* ---- 7. guards ---- */
console.log('\n-- guards --')
{
  const tone = sineWave(440, 0.5, RATE)
  const expectThrow = (label, run, pattern) => {
    try {
      run()
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 96)}`)
    }
  }
  expectThrow('factor below range', () => timeStretch(tone, RATE, 0.1), /0\.25/)
  expectThrow('factor above range', () => timeStretch(tone, RATE, 5), /4/)
  expectThrow('semitones above range', () => pitchShift(tone, RATE, 30), /24/)
  expectThrow('bad sample rate', () => timeStretch(tone, 100, 1.5), /sampleRate/)
  expectThrow('tempo factor out of range', () => changeTempo(tone, RATE, 100, 1000), /outside 0\.25\.\.4/)
  expectThrow('impossible fit', () => fitToDuration(tone, RATE, 10), /outside 0\.25\.\.4/)
}

/* ---- 8. performance ---- */
console.log('\n-- performance --')
{
  const bed = noiseBed(10)
  for (const factor of [0.75, 1.5]) {
    const started = process.hrtime.bigint()
    const stretched = timeStretch(bed, RATE, factor)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const expected = Math.round(bed.length * factor)
    console.log(`  10 s bed x${factor}: ${stretched.length} samples (want ${expected}) in ${num(ms, 0)} ms`)
    check(`10 s x${factor} under 1 s`, ms < 1000, `${num(ms, 0)} ms`)
    check(`10 s x${factor} length exact`, Math.abs(stretched.length - expected) <= 1)
  }
}

/* ---- 9. tool layer ---- */
console.log('\n-- audio_stretch tool --')
{
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-stretch-'))
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  const exec = { agent: { session: { id: 'stretch-test' } } }
  registerStretchTools(ctx)
  const call = (args) => registered.get('audio_stretch').execute(args, exec)
  const durationOf = async (path) => decodeWav(await readFile(join(cwd, path))).durationSeconds

  check('tool registered', registered.size === 1 && registered.has('audio_stretch'), [...registered.keys()].join(','))
  console.log(`  registered: ${[...registered.keys()].join(', ')}`)

  const rendered = await call({ render: { preset: 'chime', duration: 1.2, seed: 4 }, factor: 0.5, out: 'out/half.wav' })
  const halfDuration = await durationOf('out/half.wav')
  console.log(`  render 1.2 s x0.5: ${rendered.text}`)
  check('tool render factor duration', Math.abs(halfDuration - 0.6) < 0.002, `${halfDuration}`)
  check('tool reports input duration', rendered.inputDurationSeconds === 1.2, `${rendered.inputDurationSeconds}`)
  check('tool text states both durations', rendered.text.includes('1.200s -> 0.600s'), rendered.text)
  check('tool reports factor', rendered.factor === 0.5, `${rendered.factor}`)

  const fittedCall = await call({ path: 'out/half.wav', targetSeconds: 0.9, out: 'out/fit.wav' })
  const fitDuration = await durationOf('out/fit.wav')
  console.log(`  path 0.6 s -> 0.9 s: ${fittedCall.text}`)
  check('tool target duration', Math.abs(fitDuration - 0.9) < 0.002, `${fitDuration}`)
  check('tool target factor', Math.abs(fittedCall.factor - 1.5) < 1e-6, `${fittedCall.factor}`)

  const pitchedCall = await call({ path: 'out/fit.wav', semitones: 7, out: 'out/pitch.wav' })
  const pitchDuration = await durationOf('out/pitch.wav')
  console.log(`  pitch +7: ${pitchedCall.text}`)
  check('tool pitch keeps duration', Math.abs(pitchDuration - 0.9) < 0.002, `${pitchDuration}`)
  check('tool pitch reports factor 1', pitchedCall.factor === 1, `${pitchedCall.factor}`)

  const stretchedPath = await call({ path: 'out/fit.wav', factor: 2, out: 'out/long.wav' })
  const longDuration = await durationOf('out/long.wav')
  console.log(`  path 0.9 s x2: ${stretchedPath.text}`)
  check('tool path factor duration', Math.abs(longDuration - 1.8) < 0.002, `${longDuration}`)

  const defaults = await call({ render: { preset: 'tick' }, factor: 1.5 })
  console.log(`  default out path: ${defaults.relativePath}`)
  check('default output under assets/audio', defaults.relativePath.startsWith('assets/audio/stretch-'), defaults.relativePath)

  const toolThrows = async (label, args, pattern) => {
    try {
      await call(args)
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 96)}`)
    }
  }
  await toolThrows('no mode given', { render: { preset: 'tick' } }, /exactly one of/)
  await toolThrows('two modes given', { render: { preset: 'tick' }, factor: 2, semitones: 3 }, /exactly one of/)
  await toolThrows('no source given', { factor: 2 }, /path or render/)
  await toolThrows('both sources given', { path: 'out/fit.wav', render: { preset: 'tick' }, factor: 2 }, /not both/)
  await toolThrows('factor out of range', { render: { preset: 'tick' }, factor: 9 }, /outside 0\.25\.\.4/)
  await toolThrows('semitones out of range', { render: { preset: 'tick' }, semitones: 30 }, /24/)

  const printed = await import('node:fs/promises')
  const listed = await printed.readdir(join(cwd, 'out'))
  console.log(`  wrote ${listed.length} file(s): ${listed.join(', ')}`)
  check('tool wrote files', listed.length === 4, listed.join(','))
  await rm(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nOK: stretch behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
