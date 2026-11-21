/**
 * Pure track operations: everything an agent needs to finish a cue without
 * re-rendering it.
 *
 * A track is `{ samples, sampleRate }` where `samples` is a Float32Array; every
 * function here takes tracks (or raw samples for the resampler) and returns a
 * new track, so operations compose: trim → fade → rate-change → stereo is one
 * expression, and nothing in between shares memory with the caller.
 *
 * The one operation the existing engine cannot do acceptably is a rate change:
 * `audio.js` resamples with linear interpolation, which is fine for rate-matched
 * mixes but folds a 15 kHz tone into 7 kHz when it downsamples. `resampleHiFi`
 * is a windowed-sinc polyphase resampler good enough to be the *final* step
 * (8-bit inline cue, 24-bit video master, 48 kHz deliverable), and cheap enough
 * that using it does not become the reason an agent skips the check.
 */

import { clamp, dbToGain, normalizePeak } from './dsp.js'

const TAU = Math.PI * 2

/* ----------------------------------------------------------------- shared -- */

function numberOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Validate a track and return its parts.
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
function readTrack (track) {
  if (track === null || typeof track !== 'object' || !ArrayBuffer.isView(track.samples)) {
    throw new Error('expected a track shaped { samples, sampleRate }')
  }
  const sampleRate = Math.round(numberOr(track.sampleRate, 0))
  if (sampleRate <= 0) throw new Error(`track sampleRate must be a positive number, got ${track.sampleRate}`)
  return { samples: track.samples, sampleRate }
}

function frame (seconds, sampleRate) {
  return Math.round(numberOr(seconds, 0) * sampleRate)
}

function seconds (frames, sampleRate) {
  return frames / sampleRate
}

/* ------------------------------------------------------------- resampling -- */

/** Greatest common divisor, for the rational polyphase decomposition. */
function greatestCommonDivisor (a, b) {
  let x = a
  let y = b
  while (y !== 0) {
    const remainder = x % y
    x = y
    y = remainder
  }
  return x
}

/**
 * Modified Bessel function of the first kind, order 0, used by the Kaiser
 * window. Only runs while building the kernel, so the serial expansion is fine.
 */
function besselI0 (value) {
  let sum = 1
  let term = 1
  const half = value / 2
  for (let order = 1; order < 50; order += 1) {
    term *= (half / order) * (half / order)
    sum += term
    if (term < sum * 1e-14) break
  }
  return sum
}

/** One branch of the windowed-sinc kernel, in units of input samples. */
function kernelAt (offset, design) {
  if (offset <= -design.half || offset >= design.half) return 0
  const x = TAU * design.fc * offset
  const sinc = x === 0 ? 1 : Math.sin(x) / x
  const u = offset / design.half
  const window = besselI0(design.beta * Math.sqrt(Math.max(0, 1 - u * u))) / design.windowNormal
  // 2*fc*sinc(2*fc*t): unit DC gain, so a passband signal keeps its amplitude.
  return 2 * design.fc * sinc * window
}

/**
 * Design the low-pass interpolation kernel.
 *
 * The cutoff sits at the *lower* of the two Nyquist frequencies (with a small
 * guard band) and the transition width is a fixed fraction of it, so the tap
 * count follows from the requested attenuation instead of being guessed. That
 * is what suppresses a 15 kHz tone instead of letting it fold to 7 kHz.
 */
function designResampler (ratio, attenuationDb) {
  const fc = 0.5 * Math.min(1, ratio) * 0.94
  const transition = fc * 0.35
  const taps = clamp(2 * Math.ceil((attenuationDb - 8) / (2.285 * TAU * transition) / 2), 8, 512)
  const beta = 0.1102 * (attenuationDb - 8.7)
  return { fc, taps, half: taps / 2, beta, windowNormal: besselI0(beta) }
}

/**
 * Render the fractionally-positioned kernel taps. Each output frame uses the
 * tap row of its interpolation phase, so the inner loop is multiplies only.
 */
function renderPolyphase (input, out, rows, starts, phaseCount, blockStep, design) {
  const length = input.length
  const outLength = out.length
  const first = design.half - 1
  const { taps, half } = design
  let frameIndex = 0
  for (let block = 0; frameIndex < outLength; block += 1) {
    const blockStart = block * blockStep
    for (let phase = 0; phase < phaseCount && frameIndex < outLength; phase += 1, frameIndex += 1) {
      const row = rows[phase]
      const base = blockStart + starts[phase]
      let sum = 0
      if (base - first >= 0 && base + half < length) {
        // Interior frame: every tap is in range, so skip the bounds checks.
        for (let tap = 0; tap < taps; tap += 1) sum += input[base + tap - first] * row[tap]
      } else {
        for (let tap = 0; tap < taps; tap += 1) {
          const index = base + tap - first
          if (index >= 0 && index < length) sum += input[index] * row[tap]
        }
      }
      out[frameIndex] = sum
    }
  }
}

/**
 * Fallback for rate pairs whose reduced denominator would need an unreasonable
 * phase table (exotic rates only). Same kernel, evaluated per frame.
 */
function renderDirect (input, out, ratio, design) {
  const first = design.half - 1
  for (let frameIndex = 0; frameIndex < out.length; frameIndex += 1) {
    const position = frameIndex / ratio
    const base = Math.floor(position)
    const fraction = position - base
    let sum = 0
    for (let tap = 0; tap < design.taps; tap += 1) {
      const index = base + tap - first
      if (index < 0 || index >= input.length) continue
      sum += input[index] * kernelAt(fraction - (tap - first), design)
    }
    out[frameIndex] = sum
  }
}

const PHASE_ROW_LIMIT = 2048

/**
 * Rate-convert with a Kaiser-windowed sinc polyphase kernel.
 *
 * Correct gain (each phase row is normalised to unity DC), no aliasing above
 * the new Nyquist, and passband ripple far below the 0.1 dB an ear can hear.
 * The cost is proportional to the tap count, not to the duration, so a 60 s
 * 44.1 → 48 kHz conversion is a fraction of a second.
 *
 * @param {Float32Array} samples - input samples.
 * @param {number} fromRate - input rate in Hz.
 * @param {number} toRate - output rate in Hz.
 * @param {{ attenuationDb?: number }} [options] - stopband target, default 80 dB.
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function resampleHiFi (samples, fromRate, toRate, options = {}) {
  if (!ArrayBuffer.isView(samples)) throw new Error('resampleHiFi: samples must be a typed array')
  const sourceRate = Math.round(numberOr(fromRate, 0))
  const targetRate = Math.round(numberOr(toRate, 0))
  if (sourceRate <= 0 || targetRate <= 0) throw new Error('resampleHiFi: sample rates must be positive')
  // Same rate still returns a fresh buffer: callers chain operations and must
  // never discover that one of them aliased the input.
  if (sourceRate === targetRate) return { samples: Float32Array.from(samples), sampleRate: targetRate }

  const ratio = targetRate / sourceRate
  const outLength = Math.max(1, Math.round(samples.length * ratio))
  const design = designResampler(ratio, clamp(numberOr(options.attenuationDb, 80), 50, 120))
  const divisor = greatestCommonDivisor(sourceRate, targetRate)
  const phaseCount = targetRate / divisor
  const blockStep = sourceRate / divisor
  const out = new Float32Array(outLength)

  if (phaseCount <= PHASE_ROW_LIMIT) {
    const rows = new Array(phaseCount)
    const starts = new Int32Array(phaseCount)
    for (let phase = 0; phase < phaseCount; phase += 1) {
      // frame = block*phaseCount + phase maps to input position block*blockStep
      // + phase*blockStep/phaseCount; only the fraction of that depends on phase.
      const fraction = ((phase * blockStep) % phaseCount) / phaseCount
      starts[phase] = Math.floor(phase * blockStep / phaseCount)
      const row = new Float64Array(design.taps)
      let sum = 0
      for (let tap = 0; tap < design.taps; tap += 1) {
        const value = kernelAt(fraction - (tap - (design.half - 1)), design)
        row[tap] = value
        sum += value
      }
      if (sum !== 0) for (let tap = 0; tap < design.taps; tap += 1) row[tap] /= sum
      rows[phase] = row
    }
    renderPolyphase(samples, out, rows, starts, phaseCount, blockStep, design)
  } else {
    renderDirect(samples, out, ratio, design)
  }
  return { samples: out, sampleRate: targetRate }
}

/* ------------------------------------------------------------ cut & shape -- */

/**
 * Index next to `target` where the waveform crosses zero.
 *
 * A cut through a non-zero sample steps the speaker cone, which is heard as a
 * click; moving the cut a few samples to the nearest crossing removes it.
 * Silences and DC have no crossing within the window, so `target` is kept.
 */
function nearestZeroCrossing (samples, target, windowFrames) {
  const at = clamp(target, 0, Math.max(0, samples.length - 1))
  const from = Math.max(0, at - windowFrames)
  const to = Math.min(samples.length - 1, at + windowFrames)
  let best = at
  let bestDistance = Infinity
  for (let index = from; index <= to; index += 1) {
    // Index 0 has no frame before it; it is a crossing only if it is silence.
    const before = index === 0 ? undefined : samples[index - 1]
    const after = samples[index]
    const crossing = index === 0
      ? after === 0
      : Math.sign(before) !== Math.sign(after) || (before === 0 && after === 0)
    if (!crossing) continue
    const distance = Math.abs(index - at)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/**
 * Cut a track to `[start, end)` in seconds.
 *
 * Frame indices are `Math.round(seconds * sampleRate)`; `end` is exclusive, so
 * `trim({ start: 0.1, end: 0.2 })` at 44.1 kHz is exactly 4410 frames and starts
 * on the frame the caller asked for. Set `snapToZeroCrossing` to move the cut to
 * the nearest crossing (within `snapWindowSeconds`, default 5 ms) when a click
 * matters more than the exact index.
 *
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @param {{ start?: number, end?: number, snapToZeroCrossing?: boolean, snapWindowSeconds?: number }} [options]
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function trim (track, options = {}) {
  const { samples, sampleRate } = readTrack(track)
  const duration = seconds(samples.length, sampleRate)
  let startFrame = clamp(frame(numberOr(options.start, 0), sampleRate), 0, samples.length)
  let endFrame = clamp(frame(numberOr(options.end, duration), sampleRate), 0, samples.length)
  if (options.snapToZeroCrossing === true) {
    const windowFrames = Math.max(1, frame(numberOr(options.snapWindowSeconds, 0.005), sampleRate))
    startFrame = nearestZeroCrossing(samples, startFrame, windowFrames)
    endFrame = nearestZeroCrossing(samples, endFrame, windowFrames)
  }
  if (endFrame <= startFrame) {
    throw new Error(`trim: end must be after start (frames ${startFrame}..${endFrame})`)
  }
  return { samples: samples.slice(startFrame, endFrame), sampleRate }
}

/**
 * Apply a gain in decibels.
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @param {number} gainDb - level change; negative attenuates.
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function applyGainDb (track, gainDb) {
  const { samples, sampleRate } = readTrack(track)
  const gain = dbToGain(numberOr(gainDb, 0))
  const out = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) out[index] = samples[index] * gain
  return { samples: out, sampleRate }
}

/** Fade curve: 0 at silence → 1 at full level. */
function curveGain (curve, progress) {
  const value = clamp(progress, 0, 1)
  if (curve === 'equalPower') return Math.sin(value * Math.PI / 2)
  return value
}

/**
 * Fade a track in and/or out.
 *
 * Gains are exact at the endpoints: the first sample of a fade-in is
 * multiplied by 0 and the sample a fade length past it is untouched (1), and a
 * fade-out's last sample is exactly 0. `curve: 'equalPower'` (sin shape) keeps
 * perceived loudness steadier than the default linear ramp.
 *
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @param {{ in?: number, out?: number, curve?: 'linear'|'equalPower' }} [options] - fade lengths in seconds.
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function fade (track, options = {}) {
  const { samples, sampleRate } = readTrack(track)
  const out = Float32Array.from(samples)
  const curve = options.curve === 'equalPower' ? 'equalPower' : 'linear'
  const inFrames = clamp(frame(numberOr(options.in, 0), sampleRate), 0, out.length)
  const outFrames = clamp(frame(numberOr(options.out, 0), sampleRate), 0, out.length)
  for (let index = 0; index < inFrames; index += 1) out[index] *= curveGain(curve, index / inFrames)
  for (let offset = 0; offset < outFrames; offset += 1) {
    out[out.length - 1 - offset] *= curveGain(curve, offset / outFrames)
  }
  return { samples: out, sampleRate }
}

/**
 * Play a track backwards.
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function reverse (track) {
  const { samples, sampleRate } = readTrack(track)
  const out = Float32Array.from(samples)
  out.reverse()
  return { samples: out, sampleRate }
}

/**
 * Add silence before and/or after a track.
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @param {{ lead?: number, tail?: number }} [options] - padding in seconds.
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function padSilence (track, options = {}) {
  const { samples, sampleRate } = readTrack(track)
  const lead = Math.max(0, frame(numberOr(options.lead, 0), sampleRate))
  const tail = Math.max(0, frame(numberOr(options.tail, 0), sampleRate))
  const out = new Float32Array(lead + samples.length + tail)
  out.set(samples, lead)
  return { samples: out, sampleRate }
}

/** A join gap/crossfade is an edit between takes; longer than this is a timeline move. */
export const MAX_JOIN_SECONDS = 60

/**
 * Validate one join length.
 *
 * A negative length is documented as "no join" and clamps to 0, but a
 * non-finite or absurd one used to reach `new Float32Array(Infinity)` and crash
 * with `RangeError` instead of naming the argument.
 * @param {string} key - option name, used in the message.
 * @param {number} [value] - requested seconds.
 * @returns {number} 0..MAX_JOIN_SECONDS.
 */
function joinSeconds (key, value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number > MAX_JOIN_SECONDS) {
    const shown = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value))
    throw new Error(`concat: ${key} must be a finite number of seconds at most ${MAX_JOIN_SECONDS}, got ${shown}`)
  }
  return Math.max(0, number)
}

/**
 * Join tracks in order, with a silent gap or an equal-power crossfade between
 * them.
 *
 * `gapSeconds` and `crossfadeSeconds` are mutually exclusive: a hard join needs
 * space, a smooth join needs overlap, and asking for both is a sign the caller
 * has not decided which edit they want. Tracks whose rates differ are converted
 * to the first track's rate first, so a join never changes pitch.
 *
 * @param {{ samples: Float32Array, sampleRate: number }[]} tracks
 * @param {{ gapSeconds?: number, crossfadeSeconds?: number }} [options]
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function concat (tracks, options = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('concat: at least one track is required')
  const prepared = tracks.map(readTrack)
  const sampleRate = prepared[0].sampleRate
  const parts = prepared.map((track) => (
    track.sampleRate === sampleRate ? track.samples : resampleHiFi(track.samples, track.sampleRate, sampleRate).samples
  ))
  const gapFrames = frame(joinSeconds('gapSeconds', options.gapSeconds), sampleRate)
  const crossfadeFrames = frame(joinSeconds('crossfadeSeconds', options.crossfadeSeconds), sampleRate)
  if (gapFrames > 0 && crossfadeFrames > 0) {
    throw new Error('concat: use gapSeconds or crossfadeSeconds, not both')
  }

  if (crossfadeFrames > 0) {
    const shortest = Math.min(...parts.map((part) => part.length))
    const overlap = Math.min(crossfadeFrames, shortest)
    const total = parts.reduce((sum, part) => sum + part.length, 0) - overlap * (parts.length - 1)
    if (total <= 0) throw new Error('concat: tracks are too short for the requested crossfade')
    const out = new Float32Array(total)
    out.set(parts[0], 0)
    let cursor = parts[0].length
    for (let index = 1; index < parts.length; index += 1) {
      const part = parts[index]
      const start = cursor - overlap
      for (let offset = 0; offset < overlap; offset += 1) {
        const progress = (offset + 1) / (overlap + 1)
        out[start + offset] = out[start + offset] * Math.cos(progress * Math.PI / 2) + part[offset] * Math.sin(progress * Math.PI / 2)
      }
      out.set(part.subarray(overlap), cursor)
      cursor += part.length - overlap
    }
    return { samples: out, sampleRate }
  }

  const total = parts.reduce((sum, part) => sum + part.length, gapFrames * (parts.length - 1), 0)
  const out = new Float32Array(Math.max(0, total))
  let cursor = 0
  parts.forEach((part, index) => {
    if (index > 0) cursor += gapFrames
    out.set(part, cursor)
    cursor += part.length
  })
  return { samples: out, sampleRate }
}

/* ---------------------------------------------------------------- stereo -- */

/**
 * Build a stereo track from a mono one.
 *
 * `pan` is equal-power: -1 hard left, 0 centre at -3 dB per side (so a mono
 * fold-down recovers the original level), 1 hard right. `width` shrinks the
 * side signal — 1 keeps the pan image, 0 folds both channels to the same value.
 * At dead centre both channels are computed with the same gain, so they are
 * bit-identical and re-encoding never invents a channel imbalance.
 *
 * @param {{ samples: Float32Array, sampleRate: number }} track
 * @param {{ pan?: number, width?: number }} [options]
 * @returns {{ samples: [Float32Array, Float32Array], sampleRate: number }}
 */
export function toStereo (track, options = {}) {
  const { samples, sampleRate } = readTrack(track)
  const pan = clamp(numberOr(options.pan, 0), -1, 1)
  const width = clamp(numberOr(options.width, 1), 0, 1)
  const left = new Float32Array(samples.length)
  const right = new Float32Array(samples.length)
  if (pan === 0) {
    const gain = Math.SQRT1_2
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index] * gain
      left[index] = value
      right[index] = value
    }
    return { samples: [left, right], sampleRate }
  }
  // Rotate the pan position around the listener: 45 degrees is centre.
  const angle = (pan + 1) * Math.PI / 4
  const leftGain = Math.cos(angle)
  const rightGain = Math.sin(angle)
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    const leftValue = value * leftGain
    const rightValue = value * rightGain
    const mid = (leftValue + rightValue) / 2
    const side = (leftValue - rightValue) / 2
    left[index] = mid + side * width
    right[index] = mid - side * width
  }
  return { samples: [left, right], sampleRate }
}

/**
 * Sum tracks down to one.
 *
 * This is a plain sum: it does not normalise or limit, because the caller may be
 * summing tracks that are meant to stay quiet. Pass `peakDbfs` to normalise the
 * result and `gainsDb` for per-track trims.
 *
 * @param {{ samples: Float32Array, sampleRate: number }[]} tracks
 * @param {{ sampleRate?: number, gainsDb?: number[], peakDbfs?: number }} [options]
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function mixdown (tracks, options = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('mixdown: at least one track is required')
  const prepared = tracks.map(readTrack)
  const sampleRate = Math.round(numberOr(options.sampleRate, Math.max(...prepared.map((track) => track.sampleRate))))
  const gains = Array.isArray(options.gainsDb) ? options.gainsDb : []
  const parts = prepared.map((track) => (
    track.sampleRate === sampleRate ? track.samples : resampleHiFi(track.samples, track.sampleRate, sampleRate).samples
  ))
  const out = new Float32Array(Math.max(0, ...parts.map((part) => part.length)))
  parts.forEach((part, index) => {
    const gain = dbToGain(numberOr(gains[index], 0))
    for (let frameIndex = 0; frameIndex < part.length; frameIndex += 1) out[frameIndex] += part[frameIndex] * gain
  })
  if (Number.isFinite(options.peakDbfs)) normalizePeak(out, Number(options.peakDbfs))
  return { samples: out, sampleRate }
}
