/**
 * Rendering orchestration: turn a declarative request into samples, measure
 * what came out, and put it on disk atomically.
 *
 * Every file name is derived from a hash of the exact render spec, so two
 * agents (or two sub-agents) asking for the same sound converge on one path
 * and an identical byte sequence instead of racing on a shared name.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  PRESETS,
  addInto,
  clamp,
  dbToGain,
  dcBlock,
  dcBlockLoop,
  decayEnvelope,
  lerp,
  makeRng,
  normalizePeak,
  presetCatalog,
  resolveParams,
  softLimit,
  specHash,
  unit
} from './dsp.js'
import { decodeWav, encodeWav } from './wav.js'

/** Bumped whenever synthesis changes in a way that alters output bytes. */
export const ENGINE_VERSION = 2

/* ------------------------------------------------------------------ FFT -- */

function fftInPlace (real, imag) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len
    const wReal = Math.cos(angle)
    const wImag = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curReal = 1
      let curImag = 0
      for (let k = 0; k < len / 2; k += 1) {
        const uReal = real[i + k]
        const uImag = imag[i + k]
        const vReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag
        const vImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal
        real[i + k] = uReal + vReal
        imag[i + k] = uImag + vImag
        real[i + k + len / 2] = uReal - vReal
        imag[i + k + len / 2] = uImag - vImag
        const nextReal = curReal * wReal - curImag * wImag
        curImag = curReal * wImag + curImag * wReal
        curReal = nextReal
      }
    }
  }
}

/**
 * Spectral summary over a Hann-windowed 2048-sample frame taken from the
 * loudest region of the signal.
 * @returns {{ centroidHz: number, brightness: number, lowRatio: number, highRatio: number }}
 */
function spectrum (samples, sampleRate) {
  const size = 2048
  const frames = Math.max(1, Math.floor(samples.length / size))
  let bestStart = 0
  let bestEnergy = -1
  for (let f = 0; f < frames; f += 1) {
    const start = f * size
    let energy = 0
    for (let i = 0; i < size; i += 1) energy += samples[start + i] * samples[start + i]
    if (energy > bestEnergy) { bestEnergy = energy; bestStart = start }
  }
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    const sample = samples[bestStart + i] ?? 0
    real[i] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)))
  }
  fftInPlace(real, imag)
  let weighted = 0
  let total = 0
  let low = 0
  let high = 0
  for (let bin = 1; bin < size / 2; bin += 1) {
    const hz = bin * sampleRate / size
    const power = real[bin] * real[bin] + imag[bin] * imag[bin]
    weighted += power * hz
    total += power
    if (hz < 250) low += power
    if (hz > 2000) high += power
  }
  const centroidHz = total > 0 ? weighted / total : 0
  return {
    centroidHz: Math.round(centroidHz),
    brightness: Number(clamp(Math.log2(Math.max(centroidHz, 40) / 80) / 6, 0, 1).toFixed(3)),
    lowRatio: total > 0 ? Number((low / total).toFixed(3)) : 0,
    highRatio: total > 0 ? Number((high / total).toFixed(3)) : 0
  }
}

/**
 * Deterministic measurements an agent can reason about without listening.
 * @param {Float32Array} samples - mono signal.
 * @param {number} sampleRate - Hz.
 * @returns {object} metric summary.
 */
export function measure (samples, sampleRate) {
  // A 0-frame wav is a legal file (an empty clip), and five tools measure one.
  // Every metric has a defined zero here; the NaN this used to return for the
  // seam/step leaked into all of their reports.
  if (samples.length === 0) {
    return {
      durationSeconds: 0,
      peakDbfs: -120,
      rmsDbfs: -120,
      crestDb: 0,
      dcOffset: 0,
      clipping: 0,
      onsets: 0,
      loopSeam: 0,
      loopStep: 0,
      centroidHz: 0,
      brightness: 0,
      lowRatio: 0,
      highRatio: 0
    }
  }
  let peak = 0
  let sumSquares = 0
  let sum = 0
  let clipped = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    if (magnitude >= 0.999) clipped += 1
    sumSquares += value * value
    sum += value
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length))
  const db = (value) => (value > 0 ? Number((20 * Math.log10(value)).toFixed(2)) : -120)
  const spectrumResult = spectrum(samples, sampleRate)

  const hop = Math.max(16, Math.round(sampleRate * 0.005))
  let onsets = 0
  let previousEnergy = 0
  let lastOnsetAt = -Infinity
  // A percussive transient can ripple as partials and reverb arrive; require a
  // fresh jump after a refractory gap so one hit counts once.
  const refractory = sampleRate * 0.08
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let energy = 0
    for (let i = 0; i < hop; i += 1) energy += samples[start + i] * samples[start + i]
    energy = Math.sqrt(energy / hop)
    if (energy - previousEnergy > peak * 0.22 && energy > 1e-4 && start - lastOnsetAt > refractory) {
      onsets += 1
      lastOnsetAt = start
    }
    previousEnergy = energy
  }

  const edge = Math.max(1, Math.min(Math.round(0.1 * sampleRate), Math.floor(samples.length / 8)))
  const rmsOver = (start, end) => {
    let sum = 0
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
    return Math.sqrt(sum / Math.max(1, end - start))
  }
  const headRms = rmsOver(0, edge)
  const tailRms = rmsOver(samples.length - edge, samples.length)
  // Level continuity is what actually causes an audible thump when a loop
  // wraps: a decaying hit has a loud head and a silent tail. Reported in dB
  // because that is the scale the difference is audible on.
  const levelDeltaDb = 20 * Math.log10(Math.max(headRms, 1e-6) / Math.max(tailRms, 1e-6))
  const loopSeam = Number(Math.min(60, Math.abs(levelDeltaDb)).toFixed(1))
  const loopStep = Number((Math.abs(samples[0] - samples[samples.length - 1]) / Math.max(rms, 1e-6)).toFixed(3))

  return {
    durationSeconds: Number((samples.length / sampleRate).toFixed(3)),
    peakDbfs: db(peak),
    rmsDbfs: db(rms),
    crestDb: Number((20 * Math.log10(Math.max(peak, 1e-6) / Math.max(rms, 1e-6))).toFixed(2)),
    dcOffset: Number((sum / Math.max(1, samples.length)).toFixed(5)),
    clipping: clipped,
    onsets,
    loopSeam,
    loopStep,
    ...spectrumResult
  }
}

/* ------------------------------------------------------------- rendering -- */

function frameCount (seconds, sampleRate) {
  return Math.max(16, Math.round(seconds * sampleRate))
}

/**
 * Normalised correlation of two equal-length windows of one buffer.
 *
 * Used to decide how a loop head should be faded into the tail's continuation.
 * Returns 0 when either window is silent: "no evidence of correlation" is the
 * right answer there, and it keeps the equal-power branch.
 * @param {Float32Array} buffer - source.
 * @param {number} offsetA - start of the first window.
 * @param {number} offsetB - start of the second window.
 * @param {number} length - window length in samples.
 * @returns {number} correlation in [-1, 1].
 */
function windowCorrelation (buffer, offsetA, offsetB, length) {
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < length; i += 1) { meanA += buffer[offsetA + i]; meanB += buffer[offsetB + i] }
  meanA /= length
  meanB /= length
  let cross = 0
  let energyA = 0
  let energyB = 0
  for (let i = 0; i < length; i += 1) {
    const a = buffer[offsetA + i] - meanA
    const b = buffer[offsetB + i] - meanB
    cross += a * b
    energyA += a * a
    energyB += b * b
  }
  if (!(energyA > 0) || !(energyB > 0)) return 0
  return cross / Math.sqrt(energyA * energyB)
}

/**
 * Crossfade weight exponent for a measured correlation.
 *
 * The head of a loop is the tail's continuation faded into the renderer's own
 * first 50 ms; the two sides are the *same signal* when the material is periodic,
 * so amplitude-complementary weights (p = 1) reconstruct it exactly. They are
 * independent when the material is noise, where equal power (p = 0.5) is the
 * level-preserving choice. Equal power on the same signal sums two copies (+3 dB
 * swell once per repeat); linear weights on noise dip 3 dB. Solving
 * `a^2 + b^2 + 2*c*a*b = 1` at the midpoint, with `a = b = 2^-p`, gives the
 * exponent whose level is correct for the material's own correlation; away from
 * the midpoint the error is under 0.2 dB for any c because a^2 + b^2 stays
 * within (1 - c) t(1-t) of unity.
 * @param {number} correlation - measured head/continuation correlation.
 * @returns {number} exponent in [0.5, 1].
 */
function crossfadeExponent (correlation) {
  return clamp(Math.log(2 * (1 + clamp(correlation, -1, 1))) / Math.log(4), 0.5, 1)
}

/**
 * Replace the head of a loop with a fade from the tail's natural continuation.
 *
 * At i = 0 the output is `rendered[main]`, i.e. the sample that continues the
 * last sample of the loop, so the wrap is a continuation rather than a jump; by
 * i = crossfade it is the renderer's own output, so the startup transient of any
 * internal filter is gone. The weights preserve the level of the material
 * itself, which is what keeps the head from swelling or dipping.
 * @param {Float32Array} samples - destination loop buffer (length `main`).
 * @param {Float32Array} rendered - renderer output (length `main + crossfade`).
 * @param {number} main - loop length in samples.
 * @param {number} crossfade - fade length in samples.
 */
function wrapCrossfade (samples, rendered, main, crossfade) {
  if (crossfade <= 0) return
  const correlation = clamp(windowCorrelation(rendered, 0, main, crossfade), -1, 1)
  const exponent = crossfadeExponent(correlation)
  for (let i = 0; i < crossfade; i += 1) {
    const t = i / crossfade
    samples[i] = rendered[i] * Math.pow(t, exponent) + rendered[main + i] * Math.pow(1 - t, exponent)
  }
}

/**
 * Render one preset.
 * @param {object} request - preset, params, duration, seed, sampleRate, loop.
 * @returns {{ samples: Float32Array, sampleRate: number, durationSeconds: number, spec: object }}
 */
export function renderPreset (request) {
  const preset = String(request.preset ?? '')
  const spec = PRESETS[preset]
  if (spec === undefined) throw new Error(`unknown preset "${preset}"; available: ${Object.keys(PRESETS).join(', ')}`)
  const sampleRate = clamp(Math.round(request.sampleRate ?? 44100), 8000, 96000)
  const params = resolveParams(preset, request.params ?? {})
  const seed = Number.isFinite(request.seed) ? Math.round(request.seed) : 1
  const duration = clamp(Number(request.duration ?? spec.defaultDuration), 0.008, 30)
  const loop = request.loop === true
  const main = frameCount(duration, sampleRate)
  const crossfade = loop ? Math.min(Math.round(0.05 * sampleRate), Math.floor(main / 4)) : 0
  const frames = main + crossfade
  const rand = makeRng((seed ^ 0x9E3779B9) >>> 0)
  // A loop render tells the preset its loop period: periodic layers inside the
  // preset snap to *that*, not to `main + crossfade`, or the wrap carries the
  // crossfade's worth of phase and the fade cannot hide it. One-shots pass
  // nothing, so their renderers take exactly the path they always took.
  const timing = loop ? { loop: true, loopFrames: main, crossfade } : undefined
  const rendered = spec.render(params, frames, sampleRate, rand, timing)

  let samples
  if (loop) {
    samples = new Float32Array(main)
    samples.set(rendered.subarray(0, main))
    // Overlap-add: blend the natural continuation of the signal (samples past
    // `main`) into the head, so replaying the loop is a continuation rather
    // than a jump back to the initial transient.
    wrapCrossfade(samples, rendered, main, crossfade)
  } else {
    samples = rendered
    // Cutting a still-decaying tail clicks; every one-shot ends with a fade.
    const fade = Math.min(Math.round(0.008 * sampleRate), Math.floor(main / 8))
    for (let i = 0; i < fade; i += 1) samples[main - 1 - i] *= i / fade
  }

  return { samples, sampleRate, durationSeconds: samples.length / sampleRate, spec: { preset, params, seed, duration, loop } }
}

/**
 * Pattern limits. A pattern is the texture of one cue, not a whole soundtrack:
 * past these the request is a timeline to assemble with `audio_mix`, and the
 * renderer would allocate tens of megabytes before the caller notices.
 */
export const PATTERN_LIMITS = Object.freeze({ maxSpanSeconds: 180, maxEvents: 20000 })

/**
 * Fill a span with generated events.
 * @param {object} request - preset/kind/from/to/count/every/curve/params/seed.
 * @returns {{ samples: Float32Array, sampleRate: number, events: number, durationSeconds: number, spec: object }}
 */
export function renderPattern (request) {
  const preset = String(request.preset ?? 'tick')
  const spec = PRESETS[preset]
  if (spec === undefined) throw new Error(`unknown preset "${preset}"; available: ${Object.keys(PRESETS).join(', ')}`)
  const sampleRate = clamp(Math.round(request.sampleRate ?? 44100), 8000, 96000)
  const kind = ['train', 'scatter', 'riser'].includes(request.kind) ? request.kind : 'train'
  // Validate the shape before allocating anything: `to: 600` used to render a
  // 52 MB file and `count: 1e9` never returned at all.
  const requestedFrom = Number(request.from ?? 0)
  const requestedTo = Number(request.to ?? 4)
  if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo)) {
    throw new Error(`audio_pattern: from and to must be finite seconds, got from=${requestedFrom}, to=${requestedTo}`)
  }
  const requestedSpan = requestedTo - requestedFrom
  if (requestedSpan > PATTERN_LIMITS.maxSpanSeconds) {
    throw new Error(`audio_pattern: span ${Number(requestedSpan.toFixed(3))} s exceeds the ${PATTERN_LIMITS.maxSpanSeconds} s limit; render shorter patterns and place them with audio_mix`)
  }
  const requestedCount = Number.isFinite(request.count) && request.count > 0 ? Math.round(request.count) : null
  if (requestedCount !== null && requestedCount > PATTERN_LIMITS.maxEvents) {
    throw new Error(`audio_pattern: count ${requestedCount} exceeds the ${PATTERN_LIMITS.maxEvents} event limit; render the pattern in parts`)
  }
  // The clamps stay inside the validated cap, so they can never allocate more
  // than the limits above allow.
  const from = clamp(requestedFrom, 0, PATTERN_LIMITS.maxSpanSeconds)
  const to = clamp(requestedTo, from + 0.02, from + PATTERN_LIMITS.maxSpanSeconds)
  const seed = Number.isFinite(request.seed) ? Math.round(request.seed) : 1
  const base = resolveParams(preset, request.params ?? {})
  const curve = ['linear', 'accelerando', 'ritardando', 'ease'].includes(request.curve) ? request.curve : 'linear'
  const jitter = unit(request.jitter ?? 0)
  const accentEvery = Math.max(0, Math.round(request.accentEvery ?? 0))
  const rand = makeRng((seed ^ 0x85EBCA6B) >>> 0)
  const span = to - from
  const frames = frameCount(span + 2, sampleRate)
  const master = new Float32Array(frames)

  const every = Number(request.every ?? 0.25)
  const count = requestedCount ?? Math.max(1, Math.round(span / Math.max(0.01, Number.isFinite(every) ? every : 0.25)))

  const position = (progress) => {
    if (curve === 'accelerando') return Math.pow(progress, 0.62)
    if (curve === 'ritardando') return Math.pow(progress, 1.7)
    if (curve === 'ease') return progress * progress * (3 - 2 * progress)
    return progress
  }

  let events = 0
  if (kind === 'riser') {
    const rendered = PRESETS.riser.render(
      resolveParams('riser', { tone: request.tone ?? 0.6, tension: request.tension ?? 0.7 }),
      frameCount(span, sampleRate), sampleRate, rand)
    addInto(master, rendered, 0, 1)
    events = 1
  } else {
    const stamp = new Float32Array(frames + Math.round(spec.defaultDuration * sampleRate) + sampleRate)
    for (let index = 0; index < count; index += 1) {
      const progress = count === 1 ? 0 : index / (count - 1)
      let at = kind === 'scatter'
        ? rand() * span
        : position(progress) * span
      at = clamp(at + (rand() - 0.5) * jitter * (span / Math.max(count, 1)) * 0.9, 0, span)
      const pitchFrom = Number.isFinite(request.pitchFrom) ? request.pitchFrom : undefined
      const pitchTo = Number.isFinite(request.pitchTo) ? request.pitchTo : undefined
      const eventParams = { ...base }
      if (pitchFrom !== undefined || pitchTo !== undefined) {
        const startPitch = pitchFrom ?? base.pitch ?? 0.5
        const endPitch = pitchTo ?? startPitch
        const pitch = lerp(startPitch, endPitch, progress)
        eventParams.pitch = clamp(pitch, 0, 1)
      }
      if (accentEvery > 0) {
        const gain = index % accentEvery === 0 ? 1 : 0.62
        for (const key of ['weight', 'hardness', 'tone']) {
          if (eventParams[key] !== undefined) eventParams[key] = clamp(eventParams[key] * gain, 0, 1)
        }
      }
      const one = spec.render(eventParams, frameCount(spec.defaultDuration, sampleRate), sampleRate, rand)
      addInto(master, one, Math.round(at * sampleRate), 1)
      events += 1
    }
  }

  const trimmed = master.subarray(0, frameCount(span, sampleRate)).slice()
  return {
    samples: trimmed,
    sampleRate,
    events,
    durationSeconds: trimmed.length / sampleRate,
    spec: { preset, kind, from, to, count: events, curve, jitter, seed }
  }
}

function resample (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = toRate / fromRate
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[index] ?? 0
    const b = samples[index + 1] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/** A mix longer than this means a bad offset, not a long cue. */
export const MIX_MAX_SECONDS = 180
/** Gains outside this range are meaningless and only produce non-finite samples. */
export const MIX_GAIN_LIMITS_DB = Object.freeze([-120, 24])

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Validate the numeric mix options.
 *
 * Offsets and `durationSeconds` become `Float32Array` lengths, so one bad value
 * turns into `RangeError: Invalid typed array length: Infinity` — after every
 * input was already read. Both the tool boundary (before any file is opened)
 * and `mixTracks` call this, so a direct caller is guarded too.
 * @param {object} [options] - the same object `mixTracks` accepts.
 */
export function validateMixOptions (options = {}) {
  const offsets = Array.isArray(options.offsets) ? options.offsets : []
  for (let index = 0; index < offsets.length; index += 1) {
    const value = Number(offsets[index])
    if (!Number.isFinite(value) || value < 0 || value > MIX_MAX_SECONDS) {
      throw new Error(`mix: offsets[${index}] must be a finite number of seconds between 0 and ${MIX_MAX_SECONDS}, got ${describeValue(offsets[index])}`)
    }
  }
  if (options.durationSeconds !== undefined && options.durationSeconds !== null) {
    const value = Number(options.durationSeconds)
    if (!Number.isFinite(value) || value <= 0 || value > MIX_MAX_SECONDS) {
      throw new Error(`mix: durationSeconds must be a finite number of seconds greater than 0 and at most ${MIX_MAX_SECONDS}, got ${describeValue(options.durationSeconds)}`)
    }
  }
  const gains = Array.isArray(options.gains) ? options.gains : []
  for (let index = 0; index < gains.length; index += 1) {
    const value = Number(gains[index])
    if (!Number.isFinite(value) || value < MIX_GAIN_LIMITS_DB[0] || value > MIX_GAIN_LIMITS_DB[1]) {
      throw new Error(`mix: gains[${index}] must be a finite number of dB between ${MIX_GAIN_LIMITS_DB[0]} and ${MIX_GAIN_LIMITS_DB[1]}, got ${describeValue(gains[index])}`)
    }
  }
}

/**
 * Sum decoded tracks into one file.
 * @param {{ samples: Float32Array, sampleRate: number }[]} inputs - decoded tracks.
 * @param {object} options - sampleRate, gains (dB), offsets (seconds), normalizePeakDbfs, limiter, durationSeconds.
 */
export function mixTracks (inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('mix requires at least one input')
  validateMixOptions(options)
  const sampleRate = clamp(Math.round(options.sampleRate ?? Math.max(...inputs.map((i) => i.sampleRate))), 8000, 96000)
  const resampled = inputs.map((input, index) => {
    const gain = dbToGain(Number(options.gains?.[index] ?? 0))
    const samples = resample(input.samples, input.sampleRate, sampleRate)
    const out = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain
    return out
  })
  const offsets = inputs.map((_, index) => Number(options.offsets?.[index] ?? 0))
  const longest = Math.max(...resampled.map((track, index) => track.length + Math.round(offsets[index] * sampleRate)))
  const targetFrames = options.durationSeconds !== undefined && options.durationSeconds !== null
    ? frameCount(Number(options.durationSeconds), sampleRate)
    : longest
  const master = new Float32Array(targetFrames)
  resampled.forEach((track, index) => addInto(master, track, Math.round(offsets[index] * sampleRate), 1))

  const fadeIn = Math.min(Math.round((options.fadeInSeconds ?? 0) * sampleRate), targetFrames)
  const fadeOut = Math.min(Math.round((options.fadeOutSeconds ?? 0) * sampleRate), targetFrames)
  for (let i = 0; i < fadeIn; i += 1) master[i] *= i / Math.max(1, fadeIn)
  for (let i = 0; i < fadeOut; i += 1) master[targetFrames - 1 - i] *= i / Math.max(1, fadeOut)

  if (options.limiter !== false) softLimit(master)
  if (Number.isFinite(options.peakDbfs)) normalizePeak(master, Number(options.peakDbfs))
  return { samples: master, sampleRate, durationSeconds: master.length / sampleRate }
}

/**
 * Apply DC removal, peak normalisation and the ceiling used before encoding.
 *
 * `options.loop` puts the DC blocker into its circular mode: the file is a
 * period, so the blocker is warmed up across the wrap instead of starting from
 * zero state (which would leave the head unfiltered while the tail is filtered,
 * i.e. a one-sample step at every repeat). One-shots keep the plain blocker and
 * their output bytes do not move.
 * @param {Float32Array} samples - mono signal, modified in place.
 * @param {number} sampleRate - Hz, needed by the DC blocker.
 * @param {number} [peakDbfs] - target peak.
 * @param {{ loop?: boolean }} [options] - `loop: true` for a seamless bed.
 */
export function finalize (samples, sampleRate, peakDbfs = -1, options = {}) {
  if (options !== null && typeof options === 'object' && options.loop === true) dcBlockLoop(samples, sampleRate)
  else dcBlock(samples, sampleRate)
  normalizePeak(samples, peakDbfs)
  softLimit(samples)
  return samples
}

/* ----------------------------------------------------------------- files -- */

/** Resolve a caller-supplied path against the session directory. */
export function resolvePath (cwd, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return undefined
  const value = requested.trim()
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

/** Default output path for a render spec. */
export function defaultOutputPath (cwd, label, hash) {
  const safe = String(label).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'audio'
  return join(cwd, 'assets', 'audio', `${safe}-${hash}.wav`)
}

/**
 * Write bytes without ever exposing a half-written file: write a sibling temp
 * name, then rename over the target. Concurrent writers of the same spec
 * produce identical bytes, so a lost rename race is harmless.
 */
export async function writeFileAtomic (target, bytes) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, bytes)
  try {
    await rename(temp, target)
  } catch (error) {
    try {
      const existing = await stat(target)
      if (existing.isFile() && existing.size === bytes.length) {
        await unlink(temp).catch(() => {})
        return
      }
    } catch { /* fall through to the original error */ }
    await unlink(temp).catch(() => {})
    // Name the file the caller asked for, not the internal temp name, so the
    // error reads as "cannot write <out>" instead of leaking a sibling path.
    throw new Error(`cannot write ${target}: ${error.code ?? error.message}`)
  }
}

/** Read a wav file and decode it to mono. */
export async function readTrack (path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.code ?? error.message}`)
  }
  let decoded
  try {
    decoded = decodeWav(bytes)
  } catch (error) {
    throw new Error(`cannot decode ${path}: ${error.message}`)
  }
  const samples = decoded.channels.length === 1
    ? decoded.channels[0]
    : averageChannels(decoded.channels)
  return { samples, sampleRate: decoded.sampleRate, channels: decoded.channels.length, bitDepth: decoded.bitDepth }
}

function averageChannels (channels) {
  const frames = channels[0].length
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum / channels.length
  }
  return out
}

/** Encode samples as a 16-bit wav buffer. */
export function toWavBytes (samples, sampleRate, bitDepth = 16) {
  if (bitDepth !== 16) throw new Error('only 16-bit output is supported')
  return encodeWav([samples], sampleRate)
}

/** Hash a render spec so identical requests share one file name. */
export function hashSpec (spec) {
  return specHash(`${ENGINE_VERSION}|${JSON.stringify(spec)}`)
}

export { presetCatalog }

