/**
 * Broadcast loudness and true-peak metering: ITU-R BS.1770-4 / EBU R128.
 *
 * Why this module exists: peak and RMS answer "is it clipping?" and "is there
 * signal?", but neither answers the question that decides whether a cue sits in
 * a mix - "will this sound as loud as the audio next to it?". A peaky impact
 * and a flat bed can share a peak level and still be 15 LU apart in perceived
 * loudness, which is exactly how a render can measure "fine" and sound quiet
 * next to other audio. LUFS is the scale the streaming and broadcast targets
 * (-14 web / -16 podcast / -23 broadcast) are written in, so a file can be
 * normalised against real reference audio instead of against a peak number
 * that says nothing about loudness.
 *
 * Everything here is pure: identical samples give identical numbers. The
 * K-weighting filters are derived from their analog prototypes by bilinear
 * transform at the requested rate (BS.1770-4 Annex 1) instead of hardcoding the
 * 48 kHz coefficient table, because this harness renders at 22050, 44100 and
 * 48000 and every one of those readings has to be correct. At 48 kHz the
 * derivation reproduces the coefficients printed in the standard bit for bit,
 * which is the regression anchor for the whole module.
 *
 * Reading convention: a mono file is measured as *dual mono* (its power counts
 * twice), because that is how a mono asset is played - both speakers - and how
 * a stereo file's two channels would sum. This makes a -23 dBFS 997 Hz sine
 * read -23.0 LUFS, the EBU Tech 3341 calibration point, for both a stereo file
 * and the mono renders this plugin writes. Pass `{ dualMono: false }` for the
 * strict single-channel BS.1770 value, which is 3.01 LU lower.
 */

import { clamp } from './dsp.js'

/* ------------------------------------------------------------- constants -- */

/**
 * BS.1770 gating offset. A 997 Hz sine applied to every channel at 0 dBFS
 * reads 0 LUFS; the offset cancels the +0.691 dB the K-filter has at 997 Hz.
 * The same number is the reason a -23 dBFS dual-mono sine reads -23.0 LUFS.
 */
const LOUDNESS_OFFSET = -0.691

/** Absolute gate for integrated loudness and for every gated statistic. */
const ABSOLUTE_GATE_LUFS = -70

/** BS.1770-4: blocks more than 10 LU below the gated mean are excluded. */
const RELATIVE_GATE_LU = 10

/** EBU Tech 3342 gates the loudness range at 20 LU below the mean, not 10. */
const LRA_RELATIVE_GATE_LU = 20

/** EBU Tech 3342: LRA is the spread between the 10th and 95th percentile. */
const LRA_LOW_PERCENTILE = 0.1
const LRA_HIGH_PERCENTILE = 0.95

/**
 * Measurement grid: 400 ms blocks with 75 % overlap, built from four 100 ms
 * hops. Building every statistic from one hop-energy array keeps the pass
 * linear in the sample count and makes all the windows share the same grid.
 */
const HOP_SECONDS = 0.1
const BLOCK_HOPS = 4

/** Short-term window: 3 s, stepped one 100 ms hop at a time. */
const SHORT_TERM_HOPS = 30

/**
 * A single channel is counted twice (dual mono). See the module header: this is
 * the playback convention that makes mono and stereo readings comparable.
 */
const DUAL_MONO_WEIGHT = 2

// BS.1770-4 Annex 1 analog prototypes. The high-shelf is defined by its corner,
// its +4 dB high-frequency gain and its Q; Vb is the shelf-slope intermediate
// from the same annex (Vh ** 0.4996667741545416), which is what makes the
// derived 48 kHz coefficients match the standard exactly.
const SHELF_FREQ_HZ = 1681.974450955533
const SHELF_GAIN_DB = 3.999843853973347
const SHELF_Q = 0.7071752369554196
const SHELF_SLOPE_EXPONENT = 0.4996667741545416
const HIGH_PASS_FREQ_HZ = 38.13547087602444
const HIGH_PASS_Q = 0.5003270373238773

/**
 * True peak: 4x oversampling with a 64-tap windowed-sinc interpolator
 * (16 taps per phase, +/- 8 input samples of support). Measured against a 64x
 * reference interpolator, 32 total taps loses 1.2 dB at 18 kHz and 2 dB at
 * 20 kHz; 64 taps stays inside 0.1 dB to 18 kHz and 0.7 dB at 20 kHz, which is
 * the accuracy a 4x true-peak meter can be expected to deliver (the 4x grid
 * itself cannot resolve a 20 kHz crest better than ~0.25 dB).
 */
const TRUE_PEAK_OVERSAMPLE = 4
const TRUE_PEAK_TAPS_PER_PHASE = 16

/* ---------------------------------------------------------- small helpers -- */

/** Round for reporting; keep non-finite sentinels (-Infinity means "nothing above the gate"). */
function round3 (value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value
}

/** BS.1770 loudness of a channel-summed mean-square value, in LUFS. */
function powerToLoudness (power) {
  return power > 0 && Number.isFinite(power) ? LOUDNESS_OFFSET + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY
}

function meanOf (values) {
  let sum = 0
  for (let i = 0; i < values.length; i += 1) sum += values[i]
  return sum / values.length
}

function maxOf (values) {
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i += 1) if (values[i] > best) best = values[i]
  return best
}

/** Nearest-rank percentile of an ascending-sorted array (EBU Tech 3342 style). */
function percentile (sorted, fraction) {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1)
  return sorted[index]
}

/** View a channel at the shared frame count without copying when possible. */
function sliceChannel (channel, frames) {
  if (channel.length === frames) return channel
  return typeof channel.subarray === 'function' ? channel.subarray(0, frames) : channel.slice(0, frames)
}

/* ------------------------------------------------------------ K-weighting -- */

/**
 * Derive the two K-weighting biquads for a sample rate from the BS.1770-4
 * analog prototypes with the bilinear transform.
 *
 * The RLB high-pass deliberately keeps numerator (1, -2, 1) undivided by a0:
 * that is the filter the standard prints, and it has exactly unity gain at
 * Nyquist. Dividing it by a0 (as a textbook bilinear transform would) puts the
 * whole passband 0.043 dB low, and the meter would read 0.043 LU quiet.
 *
 * @param {number} sampleRate - sample rate in Hz (8000..192000).
 * @returns {{ shelf: object, highPass: object }} normalized biquad coefficients.
 */
function designKWeighting (sampleRate) {
  const shelfK = Math.tan(Math.PI * SHELF_FREQ_HZ / sampleRate)
  const vh = Math.pow(10, SHELF_GAIN_DB / 20)
  const vb = Math.pow(vh, SHELF_SLOPE_EXPONENT)
  const shelfA0 = 1 + shelfK / SHELF_Q + shelfK * shelfK
  const shelf = {
    b0: (vh + vb * shelfK / SHELF_Q + shelfK * shelfK) / shelfA0,
    b1: 2 * (shelfK * shelfK - vh) / shelfA0,
    b2: (vh - vb * shelfK / SHELF_Q + shelfK * shelfK) / shelfA0,
    a1: 2 * (shelfK * shelfK - 1) / shelfA0,
    a2: (1 - shelfK / SHELF_Q + shelfK * shelfK) / shelfA0
  }

  const passK = Math.tan(Math.PI * HIGH_PASS_FREQ_HZ / sampleRate)
  const passA0 = 1 + passK / HIGH_PASS_Q + passK * passK
  const highPass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (passK * passK - 1) / passA0,
    a2: (1 - passK / HIGH_PASS_Q + passK * passK) / passA0
  }
  return { shelf, highPass }
}

/**
 * Apply BS.1770-4 K-weighting (high-shelf, then RLB high-pass) to a mono signal.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono samples.
 * @param {number} sampleRate - sample rate in Hz; 22050..96000 all supported.
 * @returns {Float32Array} K-weighted samples, same length.
 */
export function kWeight (samples, sampleRate) {
  if (samples === null || samples === undefined || typeof samples.length !== 'number') {
    throw new Error('kWeight needs a sample array')
  }
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error(`kWeight needs a sample rate between 8000 and 192000 Hz, got ${sampleRate}`)
  }
  const { shelf, highPass } = designKWeighting(rate)
  const frames = samples.length
  const out = new Float32Array(frames)
  // Direct form I: state is kept in doubles even for Float32 input so the
  // filter response (and therefore the calibration) does not drift.
  let shelfIn1 = 0
  let shelfIn2 = 0
  let shelfOut1 = 0
  let shelfOut2 = 0
  let passIn1 = 0
  let passIn2 = 0
  let passOut1 = 0
  let passOut2 = 0
  for (let i = 0; i < frames; i += 1) {
    const input = samples[i]
    const shelved = shelf.b0 * input + shelf.b1 * shelfIn1 + shelf.b2 * shelfIn2 - shelf.a1 * shelfOut1 - shelf.a2 * shelfOut2
    shelfIn2 = shelfIn1
    shelfIn1 = input
    shelfOut2 = shelfOut1
    shelfOut1 = shelved
    const weighted = highPass.b0 * shelved + highPass.b1 * passIn1 + highPass.b2 * passIn2 - highPass.a1 * passOut1 - highPass.a2 * passOut2
    passIn2 = passIn1
    passIn1 = shelved
    passOut2 = passOut1
    passOut1 = weighted
    out[i] = weighted
  }
  return out
}

/* --------------------------------------------------------- true peak (dBTP) -- */

let truePeakKernelCache = null

/**
 * Build the 4-phase windowed-sinc interpolation kernels once.
 *
 * The interpolator works on the sample grid, so it is independent of the
 * sample rate: phase p/4 is the same fractional position at every rate. Each
 * phase is DC-normalised so a constant signal interpolates to exactly that
 * constant (otherwise a DC offset would read as a false peak).
 */
function truePeakKernel () {
  if (truePeakKernelCache !== null) return truePeakKernelCache
  const taps = TRUE_PEAK_TAPS_PER_PHASE
  const radius = taps / 2
  const phases = []
  for (let phase = 0; phase < TRUE_PEAK_OVERSAMPLE; phase += 1) {
    const offset = phase / TRUE_PEAK_OVERSAMPLE
    const kernel = new Float64Array(taps)
    let sum = 0
    for (let tap = 0; tap < taps; tap += 1) {
      // Tap `tap` of phase `offset` sits at fractional distance `offset - index`
      // from the output point, with index running -radius+1 .. radius.
      const distance = offset - (tap - (taps / 2 - 1))
      const sinc = Math.abs(distance) < 1e-9 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance)
      // Blackman window over the support [-radius, radius]: -58 dB sidelobes,
      // which keeps the interpolation error well below the 4x grid error it is
      // trying to measure.
      const position = (distance + radius) / (2 * radius)
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * position) + 0.08 * Math.cos(4 * Math.PI * position)
      kernel[tap] = sinc * window
      sum += kernel[tap]
    }
    for (let tap = 0; tap < taps; tap += 1) kernel[tap] /= sum
    phases.push(kernel)
  }
  truePeakKernelCache = { phases, taps }
  return truePeakKernelCache
}

/**
 * Highest magnitude of the 4x oversampled signal, ignoring the sample points
 * themselves (the caller already has the sample peak).
 *
 * Only positions whose whole interpolation window lies inside the file are
 * evaluated. Any extension of a file past its own samples - silence, reflection,
 * constant - is an invention, and the interpolation filter answers the mismatch
 * at that boundary with Gibbs ringing of up to +1 dB, i.e. a peak the file does
 * not contain. Restricting the scan keeps the number an honest property of the
 * signal; the first/last few samples still contribute through the sample peak.
 */
function oversampledPeak (samples) {
  const frames = samples.length
  if (frames < 2) return 0
  const { phases, taps } = truePeakKernel()
  // Tap k reads sample (i + k - (taps / 2 - 1)), so the window spans
  // [i - taps/2 + 1, i + taps/2] and is complete for i in [taps/2 - 1, frames - taps/2 - 1].
  const first = taps / 2 - 1
  const last = frames - taps / 2 - 1
  let peak = 0
  for (let i = first; i <= last; i += 1) {
    const base = i - first
    for (let phase = 1; phase < TRUE_PEAK_OVERSAMPLE; phase += 1) {
      const kernel = phases[phase]
      let acc = 0
      for (let tap = 0; tap < taps; tap += 1) acc += samples[base + tap] * kernel[tap]
      const magnitude = acc < 0 ? -acc : acc
      if (magnitude > peak) peak = magnitude
    }
  }
  return peak
}

/**
 * Estimate true peak in dBTP with 4x oversampling and a windowed-sinc
 * interpolator - the number a lossy encoder or a DA converter will actually
 * see, which is why it can sit above the sample peak.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono samples.
 * @param {number} sampleRate - sample rate in Hz (the interpolator is
 *   normalised to the sample grid, so the estimate is rate independent).
 * @returns {number} true peak in dBTP; -Infinity for digital silence.
 */
export function truePeak (samples, sampleRate) {
  if (samples === null || samples === undefined || typeof samples.length !== 'number') {
    throw new Error('truePeak needs a sample array')
  }
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`truePeak needs a positive sample rate, got ${sampleRate}`)
  let samplePeak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > samplePeak) samplePeak = magnitude
  }
  const interpolated = oversampledPeak(samples)
  const peak = interpolated > samplePeak ? interpolated : samplePeak
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
}

/* ------------------------------------------------------------- analysis -- */

/** Peak of a mono signal in dBFS, floored at -120 like the rest of the plugin. */
function samplePeakDbfs (samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120
}

/**
 * Measure a signal the way broadcast does: gated integrated loudness,
 * short-term maximum, EBU Tech 3342 loudness range, and true peak.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono samples. Ignored
 *   when `options.channels` is given (kept for signature symmetry).
 * @param {number} sampleRate - sample rate in Hz.
 * @param {object} [options] - measurement options.
 * @param {Float32Array[]} [options.channels] - use these channels instead of
 *   `samples`; their K-weighted powers are summed (mono/stereo files; surround
 *   weighting is not applied).
 * @param {boolean} [options.dualMono=true] - count a single-channel signal
 *   twice (playback on both speakers). Set false for strict single-channel.
 * @returns {{ integratedLufs: number, shortTermMaxLufs: number, loudnessRangeLu: number,
 *   truePeakDbtp: number, samplePeakDbfs: number, gatedBlocks: number, durationSeconds: number,
 *   momentaryMaxLufs: number, relativeGateLufs: number, blocksMeasured: number,
 *   shortTermBasis: 'short-term'|'momentary'|'whole-file', blockSeconds: number,
 *   hopSeconds: number, channelCount: number, dualMono: boolean }}
 *   `integratedLufs` / `shortTermMaxLufs` / `truePeakDbtp` are -Infinity when
 *   nothing in the file clears the -70 LUFS gate (no NaN anywhere);
 *   `blocksMeasured` counts standard 400 ms blocks, so 0 means the file was
 *   shorter than one block and the whole signal was gated as a single block;
 *   `shortTermBasis` says which window produced `shortTermMaxLufs`; `gatedBlocks`
 *   is how many blocks survive the absolute *and* relative gates.
 */
export function analyzeLoudness (samples, sampleRate, options = {}) {
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error(`analyzeLoudness needs a sample rate between 8000 and 192000 Hz, got ${sampleRate}`)
  }
  const channelList = Array.isArray(options.channels) && options.channels.length > 0 ? options.channels : [samples]
  for (const channel of channelList) {
    if (channel === null || channel === undefined || typeof channel.length !== 'number') {
      throw new Error('analyzeLoudness needs sample arrays for every channel')
    }
  }
  const frames = Math.min(...channelList.map((channel) => channel.length))
  const dualMono = options.dualMono !== false
  const channelWeight = channelList.length === 1 && dualMono ? DUAL_MONO_WEIGHT : 1

  const hopFrames = Math.max(1, Math.round(rate * HOP_SECONDS))
  const blockFrames = hopFrames * BLOCK_HOPS
  const hopCount = Math.floor(frames / hopFrames)

  // One pass per channel: K-weight, then fold the squares into 100 ms hops.
  // Every statistic below is a sum of hops, so nothing else touches the samples.
  const hopEnergies = new Float64Array(hopCount)
  let wholeEnergy = 0
  for (const channel of channelList) {
    const slice = sliceChannel(channel, frames)
    const weighted = kWeight(slice, rate)
    let channelEnergy = 0
    let offset = 0
    for (let hop = 0; hop < hopCount; hop += 1) {
      const end = offset + hopFrames
      let sum = 0
      for (let i = offset; i < end; i += 1) {
        const value = weighted[i]
        sum += value * value
      }
      channelEnergy += sum
      hopEnergies[hop] += sum * channelWeight
      offset = end
    }
    for (let i = offset; i < frames; i += 1) {
      const value = weighted[i]
      channelEnergy += value * value
    }
    wholeEnergy += channelEnergy * channelWeight
  }

  // --- 400 ms blocks, 75 % overlap, absolute then relative gate --------------
  const blockPowers = []
  for (let hop = 0; hop + BLOCK_HOPS <= hopCount; hop += 1) {
    let sum = 0
    for (let k = 0; k < BLOCK_HOPS; k += 1) sum += hopEnergies[hop + k]
    blockPowers.push(sum / blockFrames)
  }
  const absoluteGatePower = Math.pow(10, (ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10)

  let gatedBlocks = 0
  let integratedLufs = Number.NEGATIVE_INFINITY
  let relativeGateLufs = Number.NEGATIVE_INFINITY
  let momentaryMaxLufs = Number.NEGATIVE_INFINITY
  const aboveAbsoluteGate = blockPowers.filter((power) => power > absoluteGatePower)
  if (aboveAbsoluteGate.length > 0) {
    momentaryMaxLufs = powerToLoudness(maxOf(aboveAbsoluteGate))
    const gatedMean = meanOf(aboveAbsoluteGate)
    relativeGateLufs = powerToLoudness(gatedMean) - RELATIVE_GATE_LU
    const relativeGatePower = gatedMean * Math.pow(10, -RELATIVE_GATE_LU / 10)
    const aboveRelativeGate = aboveAbsoluteGate.filter((power) => power > relativeGatePower)
    gatedBlocks = aboveRelativeGate.length
    if (gatedBlocks > 0) integratedLufs = powerToLoudness(meanOf(aboveRelativeGate))
  } else if (blockPowers.length === 0 && frames > 0) {
    // Shorter than one 400 ms block: the standard has no gated measurement
    // here. Treat the whole signal as a single block rather than telling the
    // caller a 300 ms impact is silent; the result reports shortTermBasis
    // 'whole-file' so the extension is visible.
    const wholeLoudness = powerToLoudness(wholeEnergy / frames)
    if (wholeLoudness > ABSOLUTE_GATE_LUFS) {
      integratedLufs = wholeLoudness
      momentaryMaxLufs = wholeLoudness
      gatedBlocks = 1
    }
  }

  // --- 3 s short-term windows and EBU Tech 3342 loudness range -------------
  let shortTermMaxLufs = Number.NEGATIVE_INFINITY
  let shortTermBasis = 'whole-file'
  let loudnessRangeLu = 0
  if (hopCount >= SHORT_TERM_HOPS) {
    shortTermBasis = 'short-term'
    const shortTermPowers = []
    for (let hop = 0; hop + SHORT_TERM_HOPS <= hopCount; hop += 1) {
      let sum = 0
      for (let k = 0; k < SHORT_TERM_HOPS; k += 1) sum += hopEnergies[hop + k]
      shortTermPowers.push(sum / (SHORT_TERM_HOPS * hopFrames))
    }
    const shortTermGated = shortTermPowers.filter((power) => power > absoluteGatePower)
    if (shortTermGated.length > 0) {
      shortTermMaxLufs = powerToLoudness(maxOf(shortTermGated))
      if (shortTermGated.length > 1) {
        // Tech 3342: relative gate at -20 LU (not -10), then the 10th and 95th
        // percentile of what survives. A wider gate than integrated loudness is
        // used because LRA is meant to describe intentional dynamics.
        const gatedMean = meanOf(shortTermGated)
        const relativeGatePower = gatedMean * Math.pow(10, -LRA_RELATIVE_GATE_LU / 10)
        const kept = shortTermGated
          .filter((power) => power > relativeGatePower)
          .map((power) => powerToLoudness(power))
          .sort((left, right) => left - right)
        if (kept.length > 1) {
          loudnessRangeLu = Math.max(0, percentile(kept, LRA_HIGH_PERCENTILE) - percentile(kept, LRA_LOW_PERCENTILE))
        }
      }
    }
  } else if (blockPowers.length > 0) {
    // File shorter than the 3 s window: the momentary (400 ms) maximum is the
    // loudest thing the file actually does, so report that instead of a
    // meaningless -inf. shortTermBasis says which measure was used.
    shortTermBasis = 'momentary'
    shortTermMaxLufs = momentaryMaxLufs
  } else if (gatedBlocks > 0) {
    shortTermBasis = 'whole-file'
    shortTermMaxLufs = integratedLufs
  }

  let truePeakDbtp = Number.NEGATIVE_INFINITY
  let channelPeakDbfs = -120
  for (const channel of channelList) {
    const channelSlice = sliceChannel(channel, frames)
    const channelTruePeak = truePeak(channelSlice, rate)
    if (channelTruePeak > truePeakDbtp) truePeakDbtp = channelTruePeak
    const channelPeak = samplePeakDbfs(channelSlice)
    if (channelPeak > channelPeakDbfs) channelPeakDbfs = channelPeak
  }

  return {
    integratedLufs: round3(integratedLufs),
    shortTermMaxLufs: round3(shortTermMaxLufs),
    loudnessRangeLu: round3(loudnessRangeLu),
    truePeakDbtp: round3(truePeakDbtp),
    samplePeakDbfs: round3(channelPeakDbfs),
    gatedBlocks,
    durationSeconds: round3(frames / rate),
    momentaryMaxLufs: round3(momentaryMaxLufs),
    relativeGateLufs: round3(relativeGateLufs),
    blocksMeasured: blockPowers.length,
    shortTermBasis,
    blockSeconds: round3(blockFrames / rate),
    hopSeconds: round3(hopFrames / rate),
    channelCount: channelList.length,
    dualMono: channelList.length === 1 && dualMono
  }
}

/* ---------------------------------------------------------- gain planning -- */

/**
 * Plan a gain move toward a target loudness that can never push the true peak
 * above `ceilingDbtp`.
 *
 * Pure maths on an existing analysis, so a caller that already measured does
 * not have to measure again. When the peak ceiling is what stops the move the
 * plan says so (`limitedBy: 'true-peak'`, `achievable: false`) instead of
 * quietly predicting a loudness the file cannot reach without clipping.
 *
 * @param {object} analysis - result of analyzeLoudness().
 * @param {number} targetLufs - desired integrated loudness, e.g. -14 web,
 *   -16 podcast, -23 broadcast.
 * @param {number} [ceilingDbtp=-1] - maximum allowed true peak; clamped to
 *   [-20, 0] because above 0 dBTP means clipping by construction.
 * @returns {{ gainDb: number, achievable: boolean, limitedBy: string,
 *   predictedLufs: number, predictedDbtp: number, targetLufs: number, ceilingDbtp: number }}
 */
export function planGain (analysis, targetLufs, ceilingDbtp = -1) {
  if (analysis === null || typeof analysis !== 'object') throw new Error('planGain needs an analyzeLoudness() result')
  const target = Number(targetLufs)
  if (!Number.isFinite(target)) throw new Error(`targetLufs must be a finite number, got ${targetLufs}`)
  const requestedCeiling = Number(ceilingDbtp)
  const ceiling = clamp(Number.isFinite(requestedCeiling) ? requestedCeiling : -1, -20, 0)
  const integrated = Number(analysis.integratedLufs)
  const peak = Number(analysis.truePeakDbtp)
  const base = { targetLufs: target, ceilingDbtp: ceiling }

  if (!Number.isFinite(integrated)) {
    // Silent (or entirely below the gate): no gain can be derived from a
    // loudness that does not exist.
    return { ...base, gainDb: 0, achievable: false, limitedBy: 'loudness', predictedLufs: Number.NEGATIVE_INFINITY, predictedDbtp: peak }
  }
  const desiredGainDb = target - integrated
  const peakHeadroomDb = Number.isFinite(peak) ? ceiling - peak : Number.POSITIVE_INFINITY
  const peakLimited = peakHeadroomDb < desiredGainDb
  const gainDb = peakLimited ? peakHeadroomDb : desiredGainDb
  return {
    ...base,
    gainDb,
    achievable: !peakLimited,
    limitedBy: peakLimited ? 'true-peak' : 'loudness',
    predictedLufs: integrated + gainDb,
    predictedDbtp: Number.isFinite(peak) ? peak + gainDb : Number.NEGATIVE_INFINITY
  }
}

/**
 * How much gain this signal needs to hit `targetLufs`, and how much of it is
 * actually safe under a true-peak ceiling.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono samples.
 * @param {number} sampleRate - sample rate in Hz.
 * @param {number} targetLufs - desired integrated loudness.
 * @param {number} [ceilingDbtp=-1] - maximum allowed true peak.
 * @returns {{ gainDb: number, achievable: boolean, limitedBy: 'loudness'|'true-peak',
 *   predictedLufs: number, predictedDbtp: number, targetLufs: number, ceilingDbtp: number }}
 */
export function gainForTarget (samples, sampleRate, targetLufs, ceilingDbtp = -1) {
  return planGain(analyzeLoudness(samples, sampleRate), targetLufs, ceilingDbtp)
}
