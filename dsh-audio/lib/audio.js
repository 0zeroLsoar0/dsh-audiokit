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
// Channel-layout knowledge lives in one module: a mix never guesses which
// channel is the centre or the LFE, it asks the WAVE layout table.
import { CHANNEL_COUNTS, fitChannels, layoutFor } from './multichannel.js'

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

/**
 * Every-channel measurements, for a file that is not mono.
 *
 * `measure` folds a file to one buffer, and that fold lies in the two cases a
 * deliverable actually hits: a clipped channel averaged with a silent one stops
 * reporting clipping (1.2 and 0 average to 0.6), and an out-of-phase stereo pair
 * averages to digital silence. So the numbers that describe a *file* are taken
 * across all of its channels:
 *
 * - peak, clipping count and DC offset are the **maximum** over the channels
 *   (a file is as clipped as its worst channel, and as DC-shifted);
 * - RMS is the **power average** (`sqrt(sum of squares / all samples)`), which
 *   is what the file actually delivers as sound and matches `measure` exactly
 *   for a mono file;
 * - the waveform-derived metrics `measure` also returns (onset count, spectrum,
 *   loop seam) come from the channel with the highest peak, because that is the
 *   channel a listener hears.
 *
 * @param {Float32Array[]} channels - one buffer per channel (WAVE order).
 * @param {number} sampleRate - Hz.
 * @returns {object} the shape `measure` returns, plus `channelCount` and, when
 *   there is more than one channel, `perChannel` and `analysisChannel`.
 */
export function measureChannels (channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('measureChannels needs at least one channel buffer')
  for (const channel of channels) {
    if (channel === null || channel === undefined || typeof channel.length !== 'number') {
      throw new Error('measureChannels needs a sample buffer for every channel')
    }
  }
  const frames = Math.min(...channels.map((channel) => channel.length))
  if (frames === 0) return { ...measure(new Float32Array(0), sampleRate), channelCount: channels.length }

  const db = (value) => (value > 0 ? Number((20 * Math.log10(value)).toFixed(2)) : -120)
  const perChannel = []
  let peak = 0
  let peakChannel = 0
  let clipping = 0
  let worstDc = 0
  let sumSquaresAll = 0
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index]
    let channelPeak = 0
    let channelClipped = 0
    let channelSum = 0
    let channelSquares = 0
    for (let i = 0; i < frames; i += 1) {
      const value = channel[i]
      const magnitude = Math.abs(value)
      if (magnitude > channelPeak) channelPeak = magnitude
      if (magnitude >= 0.999) channelClipped += 1
      channelSum += value
      channelSquares += value * value
    }
    const dc = channelSum / frames
    if (channelPeak > peak) {
      peak = channelPeak
      peakChannel = index
    }
    if (channelClipped > clipping) clipping = channelClipped
    if (Math.abs(dc) > Math.abs(worstDc)) worstDc = dc
    sumSquaresAll += channelSquares
    perChannel.push({
      peakDbfs: db(channelPeak),
      rmsDbfs: db(Math.sqrt(channelSquares / frames)),
      clipping: channelClipped,
      dcOffset: Number(dc.toFixed(5))
    })
  }

  // The power average: a mono file comes out bit-identical to `measure`.
  const rms = Math.sqrt(sumSquaresAll / (frames * channels.length))
  const base = measure(channels[peakChannel], sampleRate)
  const metrics = {
    ...base,
    peakDbfs: db(peak),
    rmsDbfs: db(rms),
    crestDb: Number((20 * Math.log10(Math.max(peak, 1e-6) / Math.max(rms, 1e-6))).toFixed(2)),
    dcOffset: Number(worstDc.toFixed(5)),
    clipping,
    channelCount: channels.length
  }
  if (channels.length > 1) {
    metrics.perChannel = perChannel
    metrics.analysisChannel = peakChannel
  }
  return metrics
}

/**
 * Per-frame maximum magnitude across the channels: the envelope a peak meter
 * follows, and the signal that says whether a file is "almost silent" without
 * letting an out-of-phase pair cancel itself.
 *
 * @param {Float32Array[]} channels - one buffer per channel.
 * @returns {Float32Array} per-frame absolute peak.
 */
export function peakEnvelope (channels) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('peakEnvelope needs at least one channel buffer')
  const frames = Math.min(...channels.map((channel) => channel.length))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let magnitude = 0
    for (const channel of channels) {
      const value = Math.abs(channel[i])
      if (value > magnitude) magnitude = value
    }
    out[i] = magnitude
  }
  return out
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

  // Train spacing is `span / count`, not `span / (count - 1)`: `count` events
  // placed across the span leaves one gap after the last one, so the last event
  // starts *inside* the file instead of exactly at its end (where the trim below
  // used to cut it off completely, making `events` a lie). The clamp is only a
  // guard for a curve that pushes the last event to the very edge.
  const lastGap = Math.min(0.02, span / 4)
  const latestStart = Math.max(0, span - lastGap)

  let events = 0
  if (kind === 'riser') {
    // The riser is one continuous sweep, so its own knobs are the ones that
    // matter: `tone`/`tension` keep their historical defaults and `params`
    // overrides them (it used to be ignored entirely).
    const rendered = PRESETS.riser.render(
      resolveParams('riser', { tone: request.tone ?? 0.6, tension: request.tension ?? 0.7, ...(request.params ?? {}) }),
      frameCount(span, sampleRate), sampleRate, rand)
    addInto(master, rendered, 0, 1)
    events = 1
  } else {
    const eventFrames = frameCount(spec.defaultDuration, sampleRate)
    for (let index = 0; index < count; index += 1) {
      const progress = count === 1 ? 0 : index / count
      let at = kind === 'scatter'
        ? rand() * latestStart
        : position(progress) * span
      at = clamp(at + (rand() - 0.5) * jitter * (span / Math.max(count, 1)) * 0.9, 0, latestStart)
      const pitchFrom = Number.isFinite(request.pitchFrom) ? request.pitchFrom : undefined
      const pitchTo = Number.isFinite(request.pitchTo) ? request.pitchTo : undefined
      const eventParams = { ...base }
      if (pitchFrom !== undefined || pitchTo !== undefined) {
        const startPitch = pitchFrom ?? base.pitch ?? 0.5
        const endPitch = pitchTo ?? startPitch
        const pitch = lerp(startPitch, endPitch, progress)
        // The pitch domain is the preset's own, not a hardcoded 0..1: `impact`
        // and `whoosh` take a 0.5..2 frequency multiplier while `tick` and
        // `chime` take a 0..1 tone knob. Clamping everything to 0..1 froze every
        // multiplier sweep at 1 and made pitchFrom/pitchTo a no-op there.
        const pitchRange = spec.params?.pitch ?? [0, 1]
        eventParams.pitch = clamp(pitch, pitchRange[0], pitchRange[1])
      }
      if (accentEvery > 0) {
        const gain = index % accentEvery === 0 ? 1 : 0.62
        for (const key of ['weight', 'hardness', 'tone']) {
          if (eventParams[key] !== undefined) eventParams[key] = clamp(eventParams[key] * gain, 0, 1)
        }
      }
      const one = spec.render(eventParams, eventFrames, sampleRate, rand)
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

/** Acceptable `channels` values for a mix: automatic, forced mono, forced stereo. */
export const MIX_CHANNELS = Object.freeze(['auto', 1, 2])

/**
 * Normalise the `channels` mix option.
 *
 * `'auto'` is the default: the output follows the widest input, so an all-mono
 * request keeps the historical mono output (byte for byte) while one stereo or
 * multichannel input can no longer be averaged away. A numeric string is
 * accepted because the host may send one, exactly like every other numeric
 * tool argument.
 *
 * @param {unknown} requested - 'auto', 1, 2 or a numeric string.
 * @returns {'auto'|1|2} the normalised choice.
 */
export function normalizeMixChannels (requested) {
  if (requested === undefined || requested === null || requested === 'auto') return 'auto'
  const numeric = typeof requested === 'number'
    ? requested
    : (typeof requested === 'string' && requested.trim() !== '' ? Number(requested) : Number.NaN)
  if (numeric === 1 || numeric === 2) return numeric
  throw new Error(`mix: channels must be 'auto', 1 or 2, got ${describeValue(requested)}`)
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
  normalizeMixChannels(options.channels)
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
 * The channel buffers of one mix input.
 *
 * A file decoded for a mix arrives as `{ channels }` — the layout-preserving
 * read. A direct caller may still pass the mono-era `{ samples }` shape, which
 * is exactly one channel, so both shapes stay accepted.
 *
 * @param {object} input - decoded track.
 * @param {number} index - position in the input list, for error messages.
 * @returns {Float32Array[]} one buffer per channel.
 */
function channelsOfInput (input, index) {
  const channels = Array.isArray(input?.channels)
    ? input.channels
    : (input?.samples === undefined ? null : [input.samples])
  if (channels === null || channels.length === 0) {
    throw new Error(`mix: input ${index} needs a samples buffer or a non-empty channels array`)
  }
  const frames = channels[0]?.length
  if (!Number.isInteger(frames) || frames < 0) {
    throw new Error(`mix: input ${index} channels must be sample buffers with a length`)
  }
  for (const channel of channels) {
    if (channel === null || channel === undefined || channel.length !== frames) {
      throw new Error(`mix: input ${index} channels must be sample buffers of equal length`)
    }
  }
  return channels
}

/**
 * Fold one input to the mix's channel count through the WAVE layout matrix.
 *
 * A stereo target sends a mono input through the layout's own 1->2 upmix (the
 * equal-power centre pan law: -3 dB per side, so a mono fold-down recovers the
 * original level) and a 4/6/8-channel input through its downmix to L/R, which
 * drops LFE. A mono target uses the layout downmix as well, so LFE never enters
 * a full-range mix. A count with no WAVE layout (3, 5, 7) has no speaker order
 * to guess, so it keeps the historical plain average and is only placed at the
 * target width.
 *
 * @param {Float32Array[]} channels - source channels, WAVE order when the count has a layout.
 * @param {1|2} target - output channel count.
 * @returns {Float32Array[]} the folded channels.
 */
function foldMixInput (channels, target) {
  if (channels.length === target) return channels
  if (CHANNEL_COUNTS.includes(channels.length)) return fitChannels(channels, target)
  return fitChannels([averageChannels(channels)], target)
}

/**
 * Whether folding this input to the target drops an LFE channel.
 * @param {Float32Array[]} channels - source channels.
 * @param {1|2} target - output channel count.
 * @returns {boolean} true when the layout has an LFE channel that is dropped.
 */
function foldDropsLfe (channels, target) {
  if (channels.length <= target || !CHANNEL_COUNTS.includes(channels.length)) return false
  const layout = layoutFor(channels.length)
  return layout.hasLfe && layout.lfeIndex >= target
}

/**
 * Resolve the output channel count of a mix.
 *
 * `auto` follows the widest input: any input with more than one channel makes
 * the output stereo (folded through the layout matrix when it is 4/6/8), and an
 * all-mono request stays mono.
 *
 * @param {object[]} inputs - mix inputs (`channels`, or a legacy `samples` buffer).
 * @param {'auto'|1|2} [requested] - the `channels` option.
 * @returns {1|2} the channel count to render.
 */
export function resolveMixChannels (inputs, requested = 'auto') {
  const choice = normalizeMixChannels(requested)
  if (choice !== 'auto') return choice
  return inputs.some((input, index) => channelsOfInput(input, index).length > 1) ? 2 : 1
}

/**
 * Peak-normalise channel buffers by one shared gain.
 *
 * `dsp.normalizePeak` is the mono reference; with more than one channel the
 * peak that drives the gain is the largest absolute value across every channel
 * and that same gain is applied to all of them. Normalising each channel to its
 * own peak would make the quieter side as loud as the louder one and move the
 * image, which is the bug this keeps out of a stereo mix.
 *
 * @param {Float32Array[]} channels - channels modified in place.
 * @param {number} [targetDbfs] - target peak.
 * @param {number} [ceilingDbfs] - gain ceiling.
 * @returns {number} the applied gain.
 */
function normalizePeakLinked (channels, targetDbfs = -1, ceilingDbfs = 0) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i])
      if (magnitude > peak) peak = magnitude
    }
  }
  if (peak === 0) return 0
  const target = dbToGain(targetDbfs)
  const ceiling = dbToGain(ceilingDbfs)
  const gain = Math.min(target / peak, ceiling / peak)
  if (gain !== 1) {
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i += 1) channel[i] *= gain
    }
  }
  return gain
}

/**
 * Soft-limit channel buffers with one gain curve.
 *
 * `dsp.softLimit` is a per-sample waveshaper, so calling it channel by channel
 * clips the louder side harder and pulls a hard-panned hit towards the centre.
 * This runs the same knee and curve but takes the frame's largest absolute
 * value across the channels as the detector and multiplies every channel by
 * that one gain, so the ratio between channels (the pan position) survives
 * limiting.
 *
 * @param {Float32Array[]} channels - channels modified in place.
 * @param {number} [knee] - the linear threshold `dsp.softLimit` uses.
 * @returns {Float32Array[]} the same channels.
 */
function softLimitLinked (channels, knee = 0.85) {
  const frames = Math.min(...channels.map((channel) => channel.length))
  for (let i = 0; i < frames; i += 1) {
    let magnitude = 0
    for (const channel of channels) {
      const value = Math.abs(channel[i])
      if (value > magnitude) magnitude = value
    }
    if (magnitude <= knee) continue
    const over = (magnitude - knee) / (1 - knee)
    const gain = (knee + (1 - knee) * Math.tanh(over)) / magnitude
    for (const channel of channels) channel[i] *= gain
  }
  return channels
}

/**
 * Render a mix and keep its channels.
 *
 * The mono-era mixer folded every input to one channel by averaging, which is
 * wrong for a cue assembled from stereo material: an out-of-phase pair came out
 * silent and a panned image came out flat. This is the channel-preserving core:
 * each input is folded to the target count by the layout matrix (never by
 * guessing the channel order), the sums are per channel, and the limiter and
 * peak normaliser are driven by the frame's worst channel and apply that same
 * gain to every channel, so the image cannot drift.
 *
 * The single-channel path calls the exact historical primitives
 * (`softLimit`/`normalizePeak`), which is why an all-mono mix is byte-compatible
 * with what the plugin wrote before this function existed.
 *
 * @param {{ channels?: Float32Array[], samples?: Float32Array, sampleRate: number }[]} inputs - decoded tracks.
 * @param {object} options - channels ('auto'|1|2), sampleRate, gains (dB), offsets (seconds), peakDbfs, limiter, durationSeconds, fades.
 * @returns {{ channels: Float32Array[], channelCount: number, sampleRate: number, durationSeconds: number, inputChannels: number[], foldedFrom: number, lfeDropped: boolean }}
 */
export function renderMix (inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('mix requires at least one input')
  validateMixOptions(options)
  const targetChannels = resolveMixChannels(inputs, options.channels)
  const sampleRate = clamp(Math.round(options.sampleRate ?? Math.max(...inputs.map((i) => i.sampleRate))), 8000, 96000)
  const inputChannels = []
  const lfeDropped = []
  const resampled = inputs.map((input, index) => {
    const gain = dbToGain(Number(options.gains?.[index] ?? 0))
    const source = channelsOfInput(input, index)
    inputChannels.push(source.length)
    lfeDropped.push(foldDropsLfe(source, targetChannels))
    // Every channel goes through the same linear resampler and the same gain,
    // so the per-channel alignment (the stereo image) cannot change here.
    return foldMixInput(source, targetChannels).map((channel) => {
      const samples = resample(channel, input.sampleRate, sampleRate)
      const out = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain
      return out
    })
  })
  const offsets = inputs.map((_, index) => Number(options.offsets?.[index] ?? 0))
  const longest = Math.max(...resampled.map((track, index) => track[0].length + Math.round(offsets[index] * sampleRate)))
  const targetFrames = options.durationSeconds !== undefined && options.durationSeconds !== null
    ? frameCount(Number(options.durationSeconds), sampleRate)
    : longest
  const master = Array.from({ length: targetChannels }, () => new Float32Array(targetFrames))
  resampled.forEach((track, index) => {
    const start = Math.round(offsets[index] * sampleRate)
    for (let channel = 0; channel < targetChannels; channel += 1) addInto(master[channel], track[channel], start, 1)
  })

  // One fade shape for every channel: the same multiplier per frame, so the
  // image is untouched by a fade.
  const fadeIn = Math.min(Math.round((options.fadeInSeconds ?? 0) * sampleRate), targetFrames)
  const fadeOut = Math.min(Math.round((options.fadeOutSeconds ?? 0) * sampleRate), targetFrames)
  for (let i = 0; i < fadeIn; i += 1) {
    const gain = i / Math.max(1, fadeIn)
    for (const channel of master) channel[i] *= gain
  }
  for (let i = 0; i < fadeOut; i += 1) {
    const gain = i / Math.max(1, fadeOut)
    for (const channel of master) channel[targetFrames - 1 - i] *= gain
  }

  if (targetChannels === 1) {
    // Keep the mono bytes exactly as they were: the historical primitives are
    // the regression contract for every existing caller.
    if (options.limiter !== false) softLimit(master[0])
    if (Number.isFinite(options.peakDbfs)) normalizePeak(master[0], Number(options.peakDbfs))
  } else {
    if (options.limiter !== false) softLimitLinked(master)
    if (Number.isFinite(options.peakDbfs)) normalizePeakLinked(master, Number(options.peakDbfs))
  }
  return {
    channels: master,
    channelCount: targetChannels,
    sampleRate,
    durationSeconds: targetFrames / sampleRate,
    inputChannels,
    foldedFrom: Math.max(...inputChannels),
    lfeDropped: lfeDropped.some(Boolean)
  }
}

/**
 * Sum decoded tracks into one buffer.
 *
 * The mono-shaped wrapper around `renderMix`, kept so the many existing callers
 * that pass `{ samples }` tracks and read `.samples` keep working. `samples` is
 * the mono buffer of a mono mix and the mono fold-down of a stereo one (use
 * `channels` for the real result); `channels`/`channelCount` are always
 * present.
 *
 * @param {{ samples?: Float32Array, channels?: Float32Array[], sampleRate: number }[]} inputs - decoded tracks.
 * @param {object} options - channels, sampleRate, gains (dB), offsets (seconds), peakDbfs, limiter, durationSeconds, fades.
 * @returns {{ samples: Float32Array, channels: Float32Array[], channelCount: number, sampleRate: number, durationSeconds: number, foldedFrom: number }}
 */
export function mixTracks (inputs, options = {}) {
  const mixed = renderMix(inputs, options)
  return {
    samples: mixed.channelCount === 1 ? mixed.channels[0] : averageChannels(mixed.channels),
    channels: mixed.channels,
    channelCount: mixed.channelCount,
    sampleRate: mixed.sampleRate,
    durationSeconds: mixed.durationSeconds,
    foldedFrom: mixed.foldedFrom
  }
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

/**
 * The channel-preserving `finalize`: DC-block every channel, then one linked
 * peak normalisation and one linked limiter.
 *
 * A single channel delegates to `finalize`, so every mono file the plugin
 * already wrote is reproduced exactly. The linked stages are the whole point for
 * stereo: normalising or limiting each channel separately would change the L/R
 * ratio and move the image, while one shared gain keeps it.
 *
 * @param {Float32Array[]} channels - one buffer per channel, modified in place.
 * @param {number} sampleRate - Hz.
 * @param {number} [peakDbfs] - target peak.
 * @param {{ loop?: boolean }} [options] - `loop: true` for the circular DC blocker.
 * @returns {Float32Array[]} the same channel list.
 */
export function finalizeChannels (channels, sampleRate, peakDbfs = -1, options = {}) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('finalizeChannels needs at least one channel buffer')
  if (channels.length === 1) {
    finalize(channels[0], sampleRate, peakDbfs, options)
    return channels
  }
  const loop = options !== null && typeof options === 'object' && options.loop === true
  for (const channel of channels) {
    if (loop) dcBlockLoop(channel, sampleRate)
    else dcBlock(channel, sampleRate)
  }
  normalizePeakLinked(channels, peakDbfs)
  softLimitLinked(channels)
  return channels
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

/**
 * Read a wav file and decode it into its true channels.
 *
 * This is the channel-preserving read: `readTrack` deliberately folds to mono
 * for the tools that reason about one waveform, which loses exactly the
 * information a measurement needs (one clipped channel, an out-of-phase stereo
 * pair). A measurement tool reads through here instead, and decides for itself
 * what to do with the channels.
 *
 * @param {string} path - file to read.
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, channelCount: number, bitDepth: number }>}
 */
export async function readChannels (path) {
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
  return {
    channels: decoded.channels,
    sampleRate: decoded.sampleRate,
    channelCount: decoded.channels.length,
    bitDepth: decoded.bitDepth
  }
}

/** Read a wav file and decode it to one mono buffer (multi-channel is averaged). */
export async function readTrack (path) {
  const decoded = await readChannels(path)
  const samples = decoded.channels.length === 1
    ? decoded.channels[0]
    : averageChannels(decoded.channels)
  return { samples, sampleRate: decoded.sampleRate, channels: decoded.channels.length, bitDepth: decoded.bitDepth }
}

/**
 * Average a channel list into one mono buffer.
 *
 * This is a *fold for processing* (mix the material into one track), not a
 * measurement: averaging a clipped channel with a silent one hides the clipping,
 * and averaging an out-of-phase pair hides the sound. Measurement goes through
 * `measureChannels` / `peakEnvelope` instead.
 *
 * @param {Float32Array[]} channels - one buffer per channel.
 * @returns {Float32Array} mono fold.
 */
export function averageChannels (channels) {
  const frames = Math.min(...channels.map((channel) => channel.length))
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

/**
 * Encode the channel list of a mix as a 16-bit wav.
 *
 * `toWavBytes` writes one channel; the writer underneath (`encodeWav`) already
 * emits any channel count as plain 16-bit PCM, which is what a stereo cue needs
 * and what every decoder reads back. The mono path stays on `toWavBytes` so its
 * bytes do not move.
 *
 * @param {Float32Array[]} channels - one buffer per channel, equal lengths.
 * @param {number} sampleRate - samples per second.
 * @returns {Buffer} complete `.wav` bytes.
 */
export function toWavBytesChannels (channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('toWavBytesChannels needs at least one channel buffer')
  return encodeWav(channels, sampleRate)
}

/** Hash a render spec so identical requests share one file name. */
export function hashSpec (spec) {
  return specHash(`${ENGINE_VERSION}|${JSON.stringify(spec)}`)
}

export { presetCatalog }

