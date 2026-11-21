/**
 * Sound → grid: onsets, tempo and a beat grid from an existing piece of music.
 *
 * Animation that "lands on the beat" does not need the whole track analysed —
 * it needs three numbers (bpm, phase, downbeat) and a list of times. The pipeline
 * is the classic one because it survives real material:
 *
 *   1. spectral-flux onset detection with an adaptive local threshold (music is
 *      not a metronome: a quiet intro or a loud chorus must both register);
 *   2. tempo from the autocorrelation of the onset envelope, scored as a comb so
 *      a subdivision does not win over the beat it subdivides;
 *   3. a beat phase (circular mean of the onsets) so the returned `beatTimes`
 *      are evenly spaced *and* aligned to the real transients.
 *
 * Because the grid is built from an absolute phase rather than from the first
 * onset, a track with a silent intro still gets beat times at 0.3, 0.9, 1.5, …
 * instead of a grid that starts where the music starts.
 *
 * The FFT is duplicated here instead of exported from another analysis module:
 * both modules are intended to be understandable on their own, and forty lines
 * of twiddle table are cheaper than a hidden cross-module dependency.
 */

import { clamp } from './dsp.js'

const TAU = Math.PI * 2

/* ------------------------------------------------------------------ fft -- */

function hann (size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos(TAU * i / (size - 1))
  return window
}

/**
 * Build a radix-2 FFT with precomputed bit reversal and twiddles.
 * @param {number} size - power of two.
 * @returns {(real: Float64Array, imag: Float64Array) => void} in-place transform.
 */
function makeFft (size) {
  const levels = Math.round(Math.log2(size))
  const reversed = new Uint32Array(size)
  for (let i = 0; i < size; i += 1) {
    let value = 0
    for (let bit = 0; bit < levels; bit += 1) value |= ((i >> bit) & 1) << (levels - 1 - bit)
    reversed[i] = value
  }
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos(TAU * i / size)
    sin[i] = Math.sin(TAU * i / size)
  }
  return function transform (real, imag) {
    for (let i = 0; i < size; i += 1) {
      const j = reversed[i]
      if (j <= i) continue
      let swap = real[i]; real[i] = real[j]; real[j] = swap
      swap = imag[i]; imag[i] = imag[j]; imag[j] = swap
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1
      const stride = size / length
      for (let start = 0; start < size; start += length) {
        for (let k = 0; k < half; k += 1) {
          const angle = k * stride
          const wr = cos[angle]
          const wi = sin[angle]
          const ar = real[start + k]
          const ai = imag[start + k]
          const br = real[start + k + half] * wr + imag[start + k + half] * wi
          const bi = imag[start + k + half] * wr - real[start + k + half] * wi
          real[start + k] = ar + br
          imag[start + k] = ai + bi
          real[start + k + half] = ar - br
          imag[start + k + half] = ai - bi
        }
      }
    }
  }
}

/* ------------------------------------------------------------- helpers -- */

function round (value, digits) {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

function asSamples (samples) {
  if (samples instanceof Float32Array) return samples
  if (Array.isArray(samples) || ArrayBuffer.isView(samples)) return Float32Array.from(samples)
  throw new TypeError('beats: samples must be an array-like of numbers')
}

/** Median of `values[0..count)`, reordering the scratch buffer in place. */
function median (values, count) {
  if (count <= 0) return 0
  const slice = values.subarray(0, count)
  slice.sort()
  return slice[count >> 1]
}

/**
 * How much the adjacent onset intervals agree with a candidate period.
 *
 * Autocorrelation alone hears a kick/hat/kick/hat bar as two beats long, because
 * the accent pattern repeats every two beats. The intervals do not: a gap of one
 * beat is direct evidence for that beat length, so this term keeps the tempo at
 * the beat instead of dropping an octave. Gaps that are a multiple of the period
 * vote proportionally less (a two-beat gap is weaker evidence than a one-beat one).
 */
function ioiSupport (onsets, period, tolerance = 0.08) {
  if (onsets.length < 2) return 0
  let votes = 0
  let counted = 0
  for (let i = 1; i < onsets.length; i += 1) {
    const gap = onsets[i].at - onsets[i - 1].at
    if (!(gap > 0.02)) continue
    const multiple = Math.round(gap / period)
    if (multiple < 1) continue
    counted += 1
    const error = Math.abs(gap - multiple * period)
    if (error > tolerance * period) continue
    votes += (1 - error / (tolerance * period)) / multiple
  }
  return counted > 0 ? votes / counted : 0
}

/**
 * Refine the period from inter-onset intervals: every pair of adjacent onsets
 * votes for `gap / round(gap / period)`, and a least-squares fit over those votes
 * recovers a period far more precisely than one-hop autocorrelation resolution.
 * Votes more than 5 % away from the autocorrelation period are ignored, so a
 * wrong octave cannot win here.
 * @returns {number} refined period in seconds.
 */
function refinePeriod (onsets, period) {
  let numerator = 0
  let denominator = 0
  let votes = 0
  for (let i = 1; i < onsets.length; i += 1) {
    const gap = onsets[i].at - onsets[i - 1].at
    if (!(gap > 0.03)) continue
    const multiple = Math.round(gap / period)
    if (multiple < 1) continue
    const candidate = gap / multiple
    if (Math.abs(candidate - period) > period * 0.05) continue
    const weight = 0.25 + onsets[i].strength
    numerator += weight * multiple * gap
    denominator += weight * multiple * multiple
    votes += 1
  }
  if (votes < 3 || denominator <= 0) return period
  return numerator / denominator
}

/**
 * Map a time to a bar/beat position against a detected grid.
 * `bar` is 1-based; the pickup before the first downbeat is bar 0.
 */
function makeDurationToBar (period, downbeat, beatsPerBar) {
  return function durationToBar (seconds) {
    const value = Number(seconds)
    const bar = { seconds: Number.isFinite(value) ? round(value, 3) : null, bars: null, bar: null, beat: null, beatFraction: null, snappedSeconds: null }
    if (!Number.isFinite(value) || !(period > 0)) return bar
    const beatsFromDownbeat = (value - downbeat) / period
    const barFloat = beatsFromDownbeat / beatsPerBar
    const barIndex = Math.floor(barFloat)
    const inBar = beatsFromDownbeat - barIndex * beatsPerBar
    const beatIndex = Math.floor(inBar)
    return {
      seconds: round(value, 3),
      bars: round(barFloat, 3),
      bar: barIndex + 1,
      beat: beatIndex + 1,
      beatFraction: round(inBar - beatIndex, 3),
      snappedSeconds: round(downbeat + Math.round(beatsFromDownbeat) * period, 3)
    }
  }
}

/* ----------------------------------------------------------------- api -- */

/**
 * Analyse a track into a beat grid.
 *
 * @param {Float32Array|number[]} samples - mono samples.
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {number} [options.minBpm=40] - slowest tempo searched.
 * @param {number} [options.maxBpm=240] - fastest tempo searched.
 * @param {number} [options.beatsPerBar=4] - metre used for bar/downbeat numbering.
 * @param {number} [options.maxGrid=512] - cap on grid entries (1/4 + 1/8 notes).
 * @returns {{ bpm: number, confidence: number, beatTimes: number[], downbeatGuess: number, onsets: Array<{ t: number, strength: number }>, grid: Array<{ t: number, bar: number, beat: number, eighth: number }>, beatsPerBar: number, secondsPerBeat: number, secondsPerBar: number, durationSeconds: number, sampleRate: number, durationToBar: (seconds: number) => object }}
 */
export function analyzeBeats (samples, sampleRate, options = {}) {
  const signal = asSamples(samples)
  const rate = clamp(Number(sampleRate) || 0, 1000, 384000)
  const minBpm = clamp(Number.isFinite(options.minBpm) ? options.minBpm : 40, 20, 300)
  const maxBpm = clamp(Number.isFinite(options.maxBpm) ? options.maxBpm : 240, minBpm + 5, 400)
  const beatsPerBar = clamp(Math.round(Number.isFinite(options.beatsPerBar) ? options.beatsPerBar : 4), 1, 12)
  const maxGrid = clamp(Math.round(Number.isFinite(options.maxGrid) ? options.maxGrid : 512), 4, 4096)
  const durationSeconds = signal.length / rate

  const empty = (onsets = []) => ({
    bpm: 0,
    confidence: 0,
    beatTimes: [],
    downbeatGuess: 0,
    onsets,
    grid: [],
    beatsPerBar,
    secondsPerBeat: 0,
    secondsPerBar: 0,
    durationSeconds: round(durationSeconds, 3),
    sampleRate: rate,
    durationToBar: makeDurationToBar(0, 0, beatsPerBar)
  })

  if (signal.length === 0) return empty()

  const fftSize = rate <= 24000 ? 512 : 1024
  const hop = Math.max(64, Math.round(rate * 0.01))
  const fft = makeFft(fftSize)
  const window = hann(fftSize)
  const bins = fftSize >> 1
  const real = new Float64Array(fftSize)
  const imag = new Float64Array(fftSize)
  const previous = new Float64Array(bins)
  const frameCount = Math.max(0, Math.floor((signal.length - 1) / hop) + 1)
  if (frameCount < 8) return empty()

  // ---- 1. spectral flux, frames centred on their nominal time so a transient
  // at t=0 lands in frame 0 rather than in the zero-valued edge of a Hann window.
  const flux = new Float64Array(frameCount)
  let globalMaxFlux = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hop - (fftSize >> 1)
    for (let i = 0; i < fftSize; i += 1) {
      const index = start + i
      real[i] = (index >= 0 && index < signal.length ? signal[index] : 0) * window[i]
      imag[i] = 0
    }
    fft(real, imag)
    let sum = 0
    for (let bin = 1; bin < bins; bin += 1) {
      const hz = bin * rate / fftSize
      if (hz > 12000) continue
      const magnitude = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin])
      const delta = magnitude - previous[bin]
      if (delta > 0) sum += delta
      previous[bin] = magnitude
    }
    flux[frame] = sum
    if (sum > globalMaxFlux) globalMaxFlux = sum
  }
  if (globalMaxFlux <= 0) return empty()

  // ---- 2. adaptive threshold: local median of the flux, so a quiet passage and
  // a loud one are judged against their own neighbourhood.
  const hopSeconds = hop / rate
  const halfWindow = Math.max(3, Math.round(0.12 / hopSeconds))
  const threshold = new Float64Array(frameCount)
  const scratch = new Float64Array(halfWindow * 2 + 1)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const from = Math.max(0, frame - halfWindow)
    const to = Math.min(frameCount, frame + halfWindow + 1)
    let sum = 0
    let count = 0
    for (let i = from; i < to; i += 1) {
      scratch[count] = flux[i]
      sum += flux[i]
      count += 1
    }
    const localMedian = median(scratch, count)
    threshold[frame] = localMedian * 1.25 + (sum / count) * 0.3 + globalMaxFlux * 1e-4
  }

  // ---- 3. peak picking with sub-frame interpolation and a refractory gap.
  // The refractory window is deliberately longer than a percussion attack: a
  // reverb/limiter tail can ring 50-60 ms after the hit and would otherwise be
  // counted as a second onset, which pulls the refined tempo off by several bpm.
  const onsets = []
  const refractory = 0.07
  let lastAt = -Infinity
  for (let frame = 0; frame < frameCount; frame += 1) {
    const value = flux[frame]
    if (value < threshold[frame] || value < globalMaxFlux * 0.02) continue
    const left = frame > 0 ? flux[frame - 1] : -1
    const right = frame + 1 < frameCount ? flux[frame + 1] : -1
    if (value <= left || value < right) continue
    let offset = 0
    if (left >= 0 && right >= 0) {
      const denominator = left - 2 * value + right
      if (denominator !== 0) offset = clamp(0.5 * (left - right) / denominator, -1, 1)
    }
    let at = frame * hopSeconds + offset * hopSeconds
    if (at < 0) at = 0
    const strength = value / globalMaxFlux
    if (at - lastAt < refractory) {
      // A second peak inside the refractory window is the same event ringing;
      // keep the stronger of the two so a sharp transient is not lost.
      if (onsets.length > 0 && strength > onsets[onsets.length - 1].strength) {
        onsets[onsets.length - 1] = { at, strength, flux: value }
        lastAt = at
      }
      continue
    }
    onsets.push({ at, strength, flux: value })
    lastAt = at
  }
  const publicOnsets = onsets.map((onset) => ({ t: round(onset.at, 3), strength: round(onset.strength, 3) }))
  if (onsets.length < 2) return empty(publicOnsets)

  // ---- 4. tempo from the autocorrelation of the onset envelope, scored as a
  // comb (period + its multiples) so the beat beats its own subdivision.
  const envelope = new Float64Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) envelope[frame] = flux[frame]
  const minLag = Math.max(2, Math.floor((60 / maxBpm) / hopSeconds))
  const maxLag = Math.min(frameCount - 2, Math.ceil((60 / minBpm) / hopSeconds))
  if (maxLag <= minLag) return empty(publicOnsets)
  const acfMaxLag = Math.min(frameCount - 2, maxLag * 4)
  const acf = new Float64Array(acfMaxLag + 1)
  for (let lag = 1; lag <= acfMaxLag; lag += 1) {
    let numerator = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let i = 0; i + lag < frameCount; i += 1) {
      const a = envelope[i]
      const b = envelope[i + lag]
      numerator += a * b
      leftEnergy += a * a
      rightEnergy += b * b
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy)
    acf[lag] = denominator > 0 ? numerator / denominator : 0
  }
  const combWeights = [1, 0.65, 0.45, 0.3]
  // Autocorrelation peaks are one frame wide. A candidate whose true period is
  // fractional (140 bpm is 42.86 frames) would lose its harmonics to an
  // off-by-one frame, so each comb term is the local maximum within ±2 frames.
  const combTolerance = 2
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0
    let weightSum = 0
    for (let harmonic = 1; harmonic <= combWeights.length; harmonic += 1) {
      const center = lag * harmonic
      if (center - combTolerance > acfMaxLag) break
      let peak = 0
      for (let offset = -combTolerance; offset <= combTolerance; offset += 1) {
        const index = center + offset
        if (index < 1 || index > acfMaxLag) continue
        if (acf[index] > peak) peak = acf[index]
      }
      score += combWeights[harmonic - 1] * peak
      weightSum += combWeights[harmonic - 1]
    }
    if (weightSum === 0) continue
    // Mild preference for the 60-190 bpm band that human tempo perception
    // favours; strong enough to resolve octave ties, too weak to move the beat.
    const bpmAtLag = 60 / (lag * hopSeconds)
    const prior = 0.8 + 0.2 * Math.exp(-Math.pow(Math.log2(bpmAtLag / 120), 2) / (2 * 0.7 * 0.7))
    const intervals = ioiSupport(onsets, lag * hopSeconds)
    const scoreWeighted = (score / weightSum) * prior * (0.55 + 0.45 * intervals)
    if (scoreWeighted > bestScore) {
      bestScore = scoreWeighted
      bestLag = lag
    }
  }
  let periodFrames = bestLag
  const acfLeft = acf[bestLag - 1] ?? acf[bestLag]
  const acfCenter = acf[bestLag]
  const acfRight = acf[bestLag + 1] ?? acfCenter
  const acfDenominator = acfLeft - 2 * acfCenter + acfRight
  if (acfDenominator !== 0) periodFrames += clamp(0.5 * (acfLeft - acfRight) / acfDenominator, -1, 1)
  let period = periodFrames * hopSeconds

  // ---- 5. refine the period on the real onset intervals, then fit the phase.
  const refined = refinePeriod(onsets, period)
  if (refined > 0) {
    const refinedBpm = 60 / refined
    if (refinedBpm >= minBpm && refinedBpm <= maxBpm) period = refined
  }
  let sumSin = 0
  let sumCos = 0
  for (const onset of onsets) {
    const angle = TAU * onset.at / period
    const weight = 0.25 + onset.strength
    sumSin += weight * Math.sin(angle)
    sumCos += weight * Math.cos(angle)
  }
  let phase = Math.atan2(sumSin, sumCos) / TAU * period
  if (phase >= period / 2) phase -= period
  if (phase < -period / 2) phase += period

  const startK = Math.ceil((-phase) / period - 0.05)
  const beatTimes = []
  for (let k = startK; k < startK + 20000; k += 1) {
    let at = phase + k * period
    if (at > durationSeconds + 0.001) break
    if (at < 0) at = 0
    beatTimes.push(round(at, 3))
  }
  if (beatTimes.length === 0) return empty(publicOnsets)

  // ---- 6. confidence: periodicity of the envelope plus how tightly the onsets
  // sit on the fitted grid.
  let fitSum = 0
  let fitWeight = 0
  for (const onset of onsets) {
    const relative = (onset.at - phase) / period
    const error = Math.abs(onset.at - (phase + Math.round(relative) * period))
    const fit = clamp(1 - error / (0.25 * period), 0, 1)
    const weight = 0.25 + onset.strength
    fitSum += fit * weight
    fitWeight += weight
  }
  const gridFit = fitWeight > 0 ? fitSum / fitWeight : 0
  const confidence = clamp(0.55 * Math.max(0, acf[bestLag]) + 0.45 * gridFit, 0, 1)

  // ---- 7. downbeat guess: which beat index carries the most onset weight.
  const beatScores = new Array(beatsPerBar).fill(0)
  for (const onset of onsets) {
    const relative = Math.round((onset.at - phase) / period)
    const beatIndex = ((relative % beatsPerBar) + beatsPerBar) % beatsPerBar
    beatScores[beatIndex] += 0.25 + onset.strength
  }
  let downbeatOffset = 0
  for (let index = 1; index < beatsPerBar; index += 1) {
    if (beatScores[index] > beatScores[downbeatOffset]) downbeatOffset = index
  }
  let downbeatIndex = startK
  while (((downbeatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar !== downbeatOffset) downbeatIndex += 1
  const downbeat = Math.max(0, phase + downbeatIndex * period)

  // ---- 8. quarter + eighth grid, capped, with bar/beat numbering from the downbeat.
  const grid = []
  for (let k = startK; k < startK + 200000 && grid.length < maxGrid; k += 1) {
    const at = phase + k * period
    if (at > durationSeconds + 0.001) break
    const relative = k - downbeatIndex
    const bar = Math.floor(relative / beatsPerBar) + 1
    const beat = ((relative % beatsPerBar) + beatsPerBar) % beatsPerBar + 1
    grid.push({ t: round(Math.max(0, at), 3), bar, beat, eighth: 0 })
    if (grid.length >= maxGrid) break
    const eighthAt = at + period / 2
    if (eighthAt <= durationSeconds + 0.001) {
      grid.push({ t: round(Math.max(0, eighthAt), 3), bar, beat, eighth: 1 })
    }
  }

  return {
    bpm: round(60 / period, 2),
    confidence: round(confidence, 3),
    beatTimes,
    downbeatGuess: round(downbeat, 3),
    onsets: publicOnsets,
    grid,
    beatsPerBar,
    secondsPerBeat: round(period, 4),
    secondsPerBar: round(period * beatsPerBar, 4),
    durationSeconds: round(durationSeconds, 3),
    sampleRate: rate,
    durationToBar: makeDurationToBar(period, downbeat, beatsPerBar)
  }
}
