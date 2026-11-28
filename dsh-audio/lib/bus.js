/**
 * Mix bus: the per-track processing a real cue needs, kept out of the mixer.
 *
 * `audio_mix` can set gain, offset, fades and a limiter. That is enough to place
 * sounds on a timeline and not enough to make them sit together: rumble has to be
 * high-passed, a bed has to be tucked under dialogue, a hit has to be brightened,
 * layers have to be glued or ducked, and anything with a stereo image has to be
 * panned. This module is that missing half.
 *
 * It is deliberately a separate module rather than an extension of `mixTracks`:
 * the existing mixer is a byte-stable contract shared by several tools and tests,
 * and adding a filter chain to it would move their output. A caller chooses the
 * bus when it wants the processing, and keeps `audio_mix` when it does not.
 *
 * Every processor is pure — samples in, a new buffer out, plus a `report` that
 * names what it did (peak and RMS change, maximum gain reduction, removed
 * seconds). The report is the point: a model cannot listen, so the effect of a
 * knob has to arrive as a number it can reason about.
 *
 * The imports are the channel-arithmetic vocabulary (`lib/multichannel.js`) and
 * the plugin's polyphase resampler (`lib/convert.js`): no render kernel, no
 * filesystem, no clock, no randomness, so identical input always produces
 * identical output bytes.
 *
 * A track is `{ samples: Float32Array, sampleRate: number }` for a mono layer,
 * or `{ channels: Float32Array[], sampleRate: number }` for a stereo/surround
 * layer. For convenience a processor also accepts a bare sample buffer when
 * `options.sampleRate` is given (the "pure function over Float32Array" shape).
 * A result is track-shaped in the same way — `{ samples, sampleRate, report }`
 * for a mono input, `{ channels, sampleRate, report }` for a multichannel one —
 * except `pan`, the one processor whose output is always a stereo pair:
 * `{ channels: [left, right], sampleRate, report }`.
 *
 * Multichannel policy, stated once because it is what makes a surround bus
 * possible at all:
 *
 * - dynamics processors (compressor, duck) use one **linked** detector across
 *   every channel and apply its gain to all of them — a per-channel detector
 *   would pump the channels differently and move the image;
 * - EQ runs per channel (the same filter design, independent state), because a
 *   spectrum is per channel by nature;
 * - `pan` is refused on a multichannel track: a stereo/surround layer already
 *   has an image, and moving it is `fitChannels`' decision, not a pan knob's;
 * - silence trimming, gain and placement operate on the frame axis, which is
 *   shared by every channel, so they are channel-agnostic.
 *
 * Time constants. `attackMs` and `releaseMs` are *settle* times: the envelope
 * reaches within 5 % of its target within the stated milliseconds. Internally
 * that is one pole with a time constant of one third of the settle time, which
 * is what makes the numbers in a report checkable against the request.
 */

import { resampleHiFi } from './convert.js'
import { CHANNEL_COUNTS, conversionKind, fitChannels, layoutFor, linkStemGain } from './multichannel.js'
import { YIELD_EVERY_FRAMES, driveAsync, driveSync } from './yield.js'

/* --------------------------------------------------------------- limits -- */

/** Hard bounds. They keep a bad request from allocating gigabytes or hanging. */
export const BUS_LIMITS = Object.freeze({
  /** More layers than this is a rename of "one file per sample". */
  maxTracks: 32,
  /** One cue, not a whole reel; matches the mix and stem paths. */
  maxSeconds: 180,
  minSampleRate: 8000,
  maxSampleRate: 96000,
  minGainDb: -120,
  maxGainDb: 24,
  /** Filter corners stay inside the audible band, well under Nyquist. */
  minHz: 10,
  /** A Q past this is a sine oscillator, not a filter. */
  maxQ: 20,
  /** Cut/boost range for one peaking or shelving band. */
  minBandGainDb: -24,
  maxBandGainDb: 24,
  minThresholdDb: -80,
  maxThresholdDb: 0,
  maxRatio: 40,
  maxKneeDb: 24,
  maxAttackMs: 2000,
  maxReleaseMs: 5000,
  maxDuckDb: 60,
  /** `width` 0 folds to mono, 1 is the pan image, above that widens the side. */
  maxWidth: 2,
  maxDriveDb: 24,
  /** Master peak targets are a normalisation, so they live on dBFS. */
  minMasterPeakDbfs: -120,
  maxMasterPeakDbfs: 0,
  /** The soft limiter's knee, copied from `dsp.softLimit` so both masters match. */
  limiterKnee: 0.85
})

/* -------------------------------------------------------------- numerics -- */

const TAU = Math.PI * 2
/** Butterworth Q: flattest passband, and the corner is exactly -3 dB. */
const BUTTERWORTH_Q = Math.SQRT1_2
/** Settle times are three time constants (95 % of the move). */
const SETTLE_FACTOR = 3
/**
 * The RMS detector's own window, as a settle time. It is deliberately fixed and
 * short: it exists to turn a waveform into a mean-square level, not to be the
 * attack knob. Attack and release shape the *gain* afterwards, which is the part
 * a listener hears and the part a report can be checked against.
 */
const DETECTOR_SETTLE_MS = 10

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)

function roundTo (value, digits) {
  return Number(Number(value).toFixed(digits))
}

function linearToDb (linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -120
}

function toDb (linear) {
  return roundTo(linearToDb(linear), 2)
}

function dbToGain (db) {
  return Math.pow(10, db / 20)
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Read an optional number, rejecting only values that cannot mean anything.
 * `undefined`/`null` fall back; a numeric string is accepted because a host may
 * send one. NaN and Infinity are errors, not clamps: silently treating
 * `highpassHz: NaN` as "no filter" hides a broken request.
 */
function numberArg (caller, label, value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${caller}: ${label} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${caller}: ${label} must be a finite number, got ${describeValue(value)}`)
  return number
}

function isSampleBuffer (value) {
  return ArrayBuffer.isView(value) && typeof value.length === 'number'
}

function isChannelArray (value) {
  return Array.isArray(value) && value.length > 0 && value.every(isSampleBuffer)
}

function peakRange (samples, from, to, state) {
  let peak = state[0]
  for (let index = from; index < to; index += 1) {
    const magnitude = Math.abs(samples[index])
    if (magnitude > peak) peak = magnitude
  }
  state[0] = peak
}

/** Peak magnitude of a buffer, in cooperatively-yielded blocks. */
function* peakOfGen (samples) {
  const state = new Float64Array(1)
  for (let from = 0; from < samples.length; from += YIELD_EVERY_FRAMES) {
    peakRange(samples, from, Math.min(samples.length, from + YIELD_EVERY_FRAMES), state)
    yield
  }
  return state[0]
}


function rmsRange (samples, from, to, state) {
  let sum = state[0]
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index]
  state[0] = sum
}

/** RMS of a buffer, in cooperatively-yielded blocks (same sum, same order). */
function* rmsOfGen (samples) {
  if (samples.length === 0) return 0
  const state = new Float64Array(1)
  for (let from = 0; from < samples.length; from += YIELD_EVERY_FRAMES) {
    rmsRange(samples, from, Math.min(samples.length, from + YIELD_EVERY_FRAMES), state)
    yield
  }
  return Math.sqrt(state[0] / samples.length)
}



/** Loudest sample of any channel: what a file peak is for a multichannel bus. */
function* peakOfChannelsGen (channels) {
  let peak = 0
  for (const channel of channels) {
    const channelPeak = yield* peakOfGen(channel)
    if (channelPeak > peak) peak = channelPeak
  }
  return peak
}

function peakOfChannels (channels) {
  return driveSync(peakOfChannelsGen(channels))
}

function rmsChannelsRange (samples, from, to, state) {
  let sum = state[0]
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index]
  state[0] = sum
}

/**
 * RMS averaged over every sample of every channel, in yielded blocks.
 *
 * Dividing by frames x channels rather than by frames means a dual-mono signal
 * reads the same level as the mono signal it came from: the layout must not
 * change the number a report prints. (An energy *sum* would read +3 dB for two
 * identical channels, which is a property of the fold, not of the cue.)
 *
 * The channels are still accumulated one after another, in channel order: the
 * sum is not re-associated by the block split.
 */
function* rmsOfChannelsGen (channels) {
  const state = new Float64Array(1)
  let count = 0
  for (const channel of channels) {
    for (let from = 0; from < channel.length; from += YIELD_EVERY_FRAMES) {
      rmsChannelsRange(channel, from, Math.min(channel.length, from + YIELD_EVERY_FRAMES), state)
      yield
    }
    count += channel.length
  }
  return count > 0 ? Math.sqrt(state[0] / count) : 0
}

function rmsOfChannels (channels) {
  return driveSync(rmsOfChannelsGen(channels))
}

function dcChannelsRange (samples, from, to, state) {
  let sum = state[0]
  for (let index = from; index < to; index += 1) sum += samples[index]
  state[0] = sum
}

/** Mean DC across every channel; zero for a clean file of any width. */
function* dcOffsetOfChannelsGen (channels) {
  const state = new Float64Array(1)
  let count = 0
  for (const channel of channels) {
    for (let from = 0; from < channel.length; from += YIELD_EVERY_FRAMES) {
      dcChannelsRange(channel, from, Math.min(channel.length, from + YIELD_EVERY_FRAMES), state)
      yield
    }
    count += channel.length
  }
  return count > 0 ? state[0] / count : 0
}

function dcOffsetOfChannels (channels) {
  return driveSync(dcOffsetOfChannelsGen(channels))
}

/** One-pole coefficient for a settle time, or 1 (instant) for 0 ms. */
function settleCoefficient (settleMs, sampleRate) {
  if (!(settleMs > 0)) return 1
  const tauSeconds = (settleMs / 1000) / SETTLE_FACTOR
  return 1 - Math.exp(-1 / (tauSeconds * sampleRate))
}

/* --------------------------------------------------------------- tracks -- */

/**
 * Validate a track and return its channels.
 *
 * Accepted shapes: a bare sample buffer plus `options.sampleRate` (mono), a
 * `{ samples, sampleRate }` track (mono), or a `{ channels: [...], sampleRate }`
 * track (2/4/6/8 channels). An array handed in as `samples` is treated as a
 * channel list too, so a decoded file can be passed straight through. The
 * channel count is checked against the layouts this plugin can mean: a
 * three-channel track has no WAVE order to name, and silently treating it as
 * "stereo plus something" would put the wrong channel in the wrong speaker.
 *
 * @param {object|Float32Array|Float64Array} track - track or bare sample buffer.
 * @param {{ sampleRate?: number }} [options] - rate used when `track` is a bare buffer.
 * @param {string} caller - processor name for error messages.
 * @returns {{ channels: (Float32Array|Float64Array)[], sampleRate: number }}
 */
function readTrackChannels (track, options, caller) {
  if (isSampleBuffer(track)) {
    const requested = numberArg(caller, 'sampleRate', options?.sampleRate, undefined)
    if (requested === undefined || requested <= 0) {
      throw new Error(`${caller}: a bare sample buffer needs options.sampleRate in Hz (e.g. ${caller}(samples, { sampleRate: 48000 }))`)
    }
    return { channels: [track], sampleRate: Math.round(requested) }
  }
  if (track === null || typeof track !== 'object') {
    throw new Error(`${caller}: expected a track shaped { samples: Float32Array, sampleRate } or { channels: Float32Array[], sampleRate }, got ${describeValue(track)}`)
  }
  const requested = numberArg(caller, 'sampleRate', track.sampleRate, undefined)
  if (requested === undefined || requested <= 0) {
    throw new Error(`${caller}: track sampleRate must be a positive number, got ${describeValue(track.sampleRate)}`)
  }
  const rawChannels = track.channels !== undefined ? track.channels : (Array.isArray(track.samples) ? track.samples : null)
  if (rawChannels === null) {
    if (!isSampleBuffer(track.samples)) {
      throw new Error(`${caller}: expected a track shaped { samples: Float32Array, sampleRate } or { channels: Float32Array[], sampleRate }, got ${describeValue(track)}`)
    }
    return { channels: [track.samples], sampleRate: Math.round(requested) }
  }
  const channels = isChannelArray(rawChannels) ? rawChannels : null
  if (channels === null) {
    throw new Error(`${caller}: channels must be a non-empty array of same-length Float32Arrays`)
  }
  if (channels.some((channel) => channel.length !== channels[0].length)) {
    throw new Error(`${caller}: every channel must have the same length`)
  }
  if (!CHANNEL_COUNTS.includes(channels.length)) {
    throw new Error(`${caller}: ${channels.length} channels has no WAVE layout; supported counts are ${CHANNEL_COUNTS.join(', ')}`)
  }
  return { channels, sampleRate: Math.round(requested) }
}

/** Build a result whose shape matches the input: mono stays `samples`, multichannel is `channels`. */
function shapeResult (channels, sampleRate, report) {
  return channels.length === 1
    ? { samples: channels[0], sampleRate, report }
    : { channels, sampleRate, report }
}

function monoResult (samples, sampleRate, report) {
  return { samples, sampleRate, report }
}

function stereoResult (channels, sampleRate, report) {
  return { channels, sampleRate, report }
}

/**
 * The measurements every processor reports: what the level was before, what it
 * is after, and how much the overall RMS moved. `rmsChangeDb` is the one number
 * that tells an author a filter did something at all. For a multichannel input
 * the peak is the loudest channel's and the RMS is averaged over all channels,
 * so the number means the same thing at any width.
 */
function levelReport (type, input, output, sampleRate, extra) {
  const rmsChange = linearToDb(rmsOfChannels(output)) - linearToDb(rmsOfChannels(input))
  const frames = output[0] === undefined ? 0 : output[0].length
  return {
    type,
    sampleRate,
    frames,
    durationSeconds: roundTo(frames / sampleRate, 6),
    channelCount: output.length,
    inputPeakDbfs: toDb(peakOfChannels(input)),
    outputPeakDbfs: toDb(peakOfChannels(output)),
    rmsChangeDb: roundTo(rmsChange, 2),
    ...extra
  }
}

/* -------------------------------------------------------------- biquads -- */

const BAND_TYPES = ['lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf']

/**
 * RBJ cookbook biquad design, normalised by a0.
 *
 * The cookbook is used rather than the TPT state-variable filter in `dsp.js`
 * because two band shapes there do not exist (peaking and shelving), and mixing
 * two different bilinear implementations inside one chain would make a
 * crossover between them incoherent. These coefficients are the standard ones,
 * so the response an author predicts from a textbook is what comes out.
 */
function designBiquad (type, sampleRate, options, caller) {
  if (!BAND_TYPES.includes(type)) {
    throw new Error(`${caller}: unknown filter type "${describeValue(type)}"; available: ${BAND_TYPES.join(', ')}`)
  }
  const defaultHz = type === 'highpass' ? 80 : type === 'lowpass' ? 12000 : 1000
  const requestedHz = numberArg(caller, 'hz', options.hz, defaultHz)
  const hz = clamp(requestedHz, BUS_LIMITS.minHz, sampleRate * 0.45)
  const q = clamp(numberArg(caller, 'q', options.q, BUTTERWORTH_Q), 0.1, BUS_LIMITS.maxQ)
  const gainDb = type === 'lowpass' || type === 'highpass'
    ? 0
    : clamp(numberArg(caller, 'gainDb', options.gainDb, 0), BUS_LIMITS.minBandGainDb, BUS_LIMITS.maxBandGainDb)
  const slope = clamp(numberArg(caller, 'slope', options.slope, 1), 0.1, 1)

  const omega = TAU * hz / sampleRate
  const cos = Math.cos(omega)
  const sin = Math.sin(omega)
  let b0
  let b1
  let b2
  let a0
  let a1
  let a2

  if (type === 'highpass' || type === 'lowpass') {
    const alpha = sin / (2 * q)
    if (type === 'highpass') {
      b0 = (1 + cos) / 2
      b1 = -(1 + cos)
      b2 = b0
    } else {
      b0 = (1 - cos) / 2
      b1 = 1 - cos
      b2 = b0
    }
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (type === 'peaking') {
    const amplitude = Math.pow(10, gainDb / 40)
    const alpha = sin / (2 * q)
    b0 = 1 + alpha * amplitude
    b1 = -2 * cos
    b2 = 1 - alpha * amplitude
    a0 = 1 + alpha / amplitude
    a1 = -2 * cos
    a2 = 1 - alpha / amplitude
  } else {
    // Shelves: `slope` 1 is the steepest shelf that does not overshoot.
    const amplitude = Math.pow(10, gainDb / 40)
    const alpha = sin / 2 * Math.sqrt((amplitude + 1 / amplitude) * (1 / slope - 1) + 2)
    const k = 2 * Math.sqrt(amplitude) * alpha
    const plus = amplitude + 1
    const minus = amplitude - 1
    if (type === 'lowshelf') {
      b0 = amplitude * (plus - minus * cos + k)
      b1 = 2 * amplitude * (minus - plus * cos)
      b2 = amplitude * (plus - minus * cos - k)
      a0 = plus + minus * cos + k
      a1 = -2 * (minus + plus * cos)
      a2 = plus + minus * cos - k
    } else {
      b0 = amplitude * (plus + minus * cos + k)
      b1 = -2 * amplitude * (minus + plus * cos)
      b2 = amplitude * (plus + minus * cos - k)
      a0 = plus - minus * cos + k
      a1 = 2 * (minus - plus * cos)
      a2 = plus - minus * cos - k
    }
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    hz,
    q,
    gainDb
  }
}

/**
 * Run a biquad over a buffer. State is Float64 and the output Float32: the
 * coefficients are double precision numbers, and keeping the two poles in double
 * stops a long low-frequency filter from drifting.
 */
function runBiquad (samples, design) {
  const out = new Float32Array(samples.length)
  const { b0, b1, b2, a1, a2 } = design
  let z1 = 0
  let z2 = 0
  for (let index = 0; index < samples.length; index += 1) {
    const input = samples[index]
    const output = b0 * input + z1
    z1 = b1 * input - a1 * output + z2
    z2 = b2 * input - a2 * output
    out[index] = output
  }
  return out
}

function filterProcessor (type, track, options, caller) {
  const { channels, sampleRate } = readTrackChannels(track, options, caller)
  const design = designBiquad(type, sampleRate, options, caller)
  // One design, one independent filter state per channel: a spectrum belongs to
  // one channel, so a shared state would smear the image.
  const out = channels.map((channel) => runBiquad(channel, design))
  const extra = {
    hz: roundTo(design.hz, 2),
    q: roundTo(design.q, 4),
    gainDb: roundTo(design.gainDb, 2),
    order: 2,
    /** A second-order section: 12 dB/octave on the slope of a high/low pass. */
    slopeDbPerOctave: type === 'highpass' || type === 'lowpass' ? 12 : null
  }
  if (type === 'highpass') {
    extra.dcBefore = roundTo(dcOffsetOfChannels(channels), 6)
    extra.dcAfter = roundTo(dcOffsetOfChannels(out), 6)
  }
  return shapeResult(out, sampleRate, levelReport(type, channels, out, sampleRate, extra))
}

/* ----------------------------------------------------------- processors -- */

/**
 * Second-order high-pass. The tool for rumble, DC and handling noise: it is the
 * first thing a mix needs and the mixer never had.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ hz?: number, q?: number, sampleRate?: number }} [options] - corner
 *   (default 80 Hz), resonance (default Butterworth 0.707), and the rate when
 *   `track` is a bare buffer.
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function highpass (track, options = {}) {
  return filterProcessor('highpass', track, options, 'highpass')
}

/**
 * Second-order low-pass. Tucks a bed under dialogue: everything above the corner
 * that made the bed read as "in front" is gone.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ hz?: number, q?: number, sampleRate?: number }} [options] - corner
 *   (default 12 kHz), resonance (default Butterworth 0.707).
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function lowpass (track, options = {}) {
  return filterProcessor('lowpass', track, options, 'lowpass')
}

/**
 * Peaking bell: a boost or cut around one frequency, which is how a hit is
 * brightened or a boxy resonance is pulled out.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ hz?: number, q?: number, gainDb?: number, sampleRate?: number }} [options] -
 *   centre (default 1 kHz), bandwidth (default 0.707), boost/cut in dB.
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function peaking (track, options = {}) {
  return filterProcessor('peaking', track, options, 'peaking')
}

/**
 * Shelving filter: `kind: 'low'` lifts or cuts everything below the corner,
 * `kind: 'high'` everything above. A high shelf is the "brighten a hit" knob; a
 * low shelf is the "take the weight out of a bed" knob.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ kind?: 'low'|'high', hz?: number, gainDb?: number, slope?: number, q?: number,
 *   sampleRate?: number }} [options] - shelf side, corner, dB, and shelf slope.
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function shelf (track, options = {}) {
  const caller = 'shelf'
  const kind = options.kind ?? options.side ?? 'high'
  if (kind !== 'low' && kind !== 'high') {
    throw new Error(`${caller}: kind must be "low" or "high", got ${describeValue(options.kind)}`)
  }
  const { channels, sampleRate } = readTrackChannels(track, options, caller)
  const design = designBiquad(kind === 'low' ? 'lowshelf' : 'highshelf', sampleRate, options, caller)
  const out = channels.map((channel) => runBiquad(channel, design))
  return shapeResult(out, sampleRate, levelReport('shelf', channels, out, sampleRate, {
    kind,
    hz: roundTo(design.hz, 2),
    gainDb: roundTo(design.gainDb, 2),
    slope: roundTo(clamp(numberArg(caller, 'slope', options.slope, 1), 0.1, 1), 2)
  }))
}

/**
 * Static gain reduction from one detector level, with an optional soft knee.
 * Pure and exported in spirit only — the formula is inside every report.
 */
function staticGainReduction (levelDb, thresholdDb, ratio, kneeDb) {
  const slope = 1 - 1 / ratio
  if (kneeDb > 0) {
    const lower = thresholdDb - kneeDb / 2
    const upper = thresholdDb + kneeDb / 2
    if (levelDb <= lower) return 0
    if (levelDb < upper) {
      const over = levelDb - lower
      return slope * over * over / (2 * kneeDb)
    }
  } else if (levelDb <= thresholdDb) {
    return 0
  }
  return (levelDb - thresholdDb) * slope
}

/**
 * Feed-forward compressor with an RMS detector and no lookahead.
 *
 * Feed-forward means the sidechain is the input itself — the honest, predictable
 * topology — and an RMS detector means a sustained tone is compressed by its
 * energy rather than by its first sample, so a hit and a sine at the same peak
 * behave differently, which is what glue is. No lookahead means a transient
 * survives its own attack, which is what keeps a hit sounding like a hit.
 *
 * The detector is a symmetric power average: averaging the power with the *same*
 * coefficient up and down measures the mean square, which is what "RMS" has to
 * mean. (An asymmetric power follower tracks waveform peaks instead — a -6 dBFS
 * sine then reports itself 2.3 dB louder than it is, and a ratio of 4 compresses
 * it by 8.3 dB instead of 6.7.) Attack and release smooth the resulting gain
 * reduction in dB, and that is where the time constants belong.
 *
 * The static curve is `(level - threshold) * (1 - 1/ratio)` above the knee, so
 * a report can be checked against that arithmetic.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ thresholdDb?: number, ratio?: number, attackMs?: number, releaseMs?: number,
 *   makeupDb?: number, kneeDb?: number, sampleRate?: number }} [options] - threshold
 *   (default -18 dBFS), ratio (default 4), gain settle times (10 ms / 120 ms),
 *   makeup gain (default 0) and soft-knee width (default 6 dB).
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function compressor (track, options = {}) {
  const caller = 'compressor'
  const { channels, sampleRate } = readTrackChannels(track, options, caller)
  const thresholdDb = clamp(numberArg(caller, 'thresholdDb', options.thresholdDb, -18), BUS_LIMITS.minThresholdDb, BUS_LIMITS.maxThresholdDb)
  const ratio = clamp(numberArg(caller, 'ratio', options.ratio, 4), 1, BUS_LIMITS.maxRatio)
  const attackMs = clamp(numberArg(caller, 'attackMs', options.attackMs, 10), 0, BUS_LIMITS.maxAttackMs)
  const releaseMs = clamp(numberArg(caller, 'releaseMs', options.releaseMs, 120), 0, BUS_LIMITS.maxReleaseMs)
  const makeupDb = clamp(numberArg(caller, 'makeupDb', options.makeupDb, 0), BUS_LIMITS.minBandGainDb, BUS_LIMITS.maxBandGainDb)
  const kneeDb = clamp(numberArg(caller, 'kneeDb', options.kneeDb, 6), 0, BUS_LIMITS.maxKneeDb)
  const detectorCoefficient = settleCoefficient(DETECTOR_SETTLE_MS, sampleRate)
  const attackCoefficient = settleCoefficient(attackMs, sampleRate)
  const releaseCoefficient = settleCoefficient(releaseMs, sampleRate)

  const channelCount = channels.length
  const frames = channels[0].length
  const out = channels.map(() => new Float32Array(frames))
  let power = 0
  let gainReductionDb = 0
  let maxGainReductionDb = 0
  let sumGainReductionDb = 0
  let samplesReduced = 0
  for (let index = 0; index < frames; index += 1) {
    // One detector sees the loudest channel at each instant, so a hard-panned
    // hit ducks the whole layer instead of only the channel it is in.
    let square = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = channels[channel][index]
      const valueSquare = value * value
      if (valueSquare > square) square = valueSquare
    }
    power += (square - power) * detectorCoefficient
    const levelDb = power > 1e-20 ? 10 * Math.log10(power) : -200
    const target = staticGainReduction(levelDb, thresholdDb, ratio, kneeDb)
    // Attack when the reduction has to deepen, release when it can let go.
    const coefficient = target > gainReductionDb ? attackCoefficient : releaseCoefficient
    gainReductionDb += (target - gainReductionDb) * coefficient
    if (gainReductionDb > maxGainReductionDb) maxGainReductionDb = gainReductionDb
    if (gainReductionDb > 0.01) samplesReduced += 1
    sumGainReductionDb += gainReductionDb
    const gain = dbToGain(makeupDb - gainReductionDb)
    for (let channel = 0; channel < channelCount; channel += 1) out[channel][index] = channels[channel][index] * gain
  }

  return shapeResult(out, sampleRate, levelReport('compressor', channels, out, sampleRate, {
    thresholdDb: roundTo(thresholdDb, 2),
    ratio: roundTo(ratio, 3),
    attackMs: roundTo(attackMs, 2),
    releaseMs: roundTo(releaseMs, 2),
    makeupDb: roundTo(makeupDb, 2),
    kneeDb: roundTo(kneeDb, 2),
    maxGainReductionDb: roundTo(maxGainReductionDb, 2),
    meanGainReductionDb: roundTo(frames > 0 ? sumGainReductionDb / frames : 0, 2),
    samplesReduced,
    reducedPercent: roundTo(frames > 0 ? (samplesReduced / frames) * 100 : 0, 1)
  }))
}

/**
 * Duck `track` under a sidechain, the classic dialogue-over-music move.
 *
 * The sidechain's own level sets the amount: a sidechain that reaches its peak
 * gets the full `amountDb`, a quieter one a proportional dip, so a narration bed
 * ducks exactly where words are. The level comes from a symmetric RMS detector
 * (the same mean-square measurement the compressor uses) and the dip is then
 * smoothed in dB with the attack/release settle times, so the numbers in the
 * report are directly checkable against the milliseconds that were requested.
 *
 * A production ducker on a *tonal* sidechain would stretch its attack: an
 * amplitude follower only receives energy on waveform peaks, so a 20 ms attack
 * measures nearer 40 ms. Measuring mean square first removes that dependence.
 * The gain smoother is the attack/release knob and the RMS detector adds its own
 * 10 ms in front of it, so a 20 ms attack measures about 24 ms end to end; the
 * release is unaffected, because after the sidechain stops the target falls to
 * zero long before the release has finished, and the measured recovery is then
 * the release time itself.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - the track to duck.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} sidechain - what
 *   triggers the duck, aligned to sample 0 of `track`. A shorter sidechain is
 *   treated as silence after its end, so the release still tails out.
 * @param {{ amountDb?: number, attackMs?: number, releaseMs?: number, sampleRate?: number }} [options] -
 *   full dip in dB (default 12), gain settle times (10 ms / 250 ms).
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function duck (track, sidechain, options = {}) {
  const caller = 'duck'
  const target = readTrackChannels(track, options, caller)
  const side = readTrackChannels(sidechain, { sampleRate: target.sampleRate }, `${caller} sidechain`)
  const amountDb = clamp(numberArg(caller, 'amountDb', options.amountDb, 12), 0, BUS_LIMITS.maxDuckDb)
  const attackMs = clamp(numberArg(caller, 'attackMs', options.attackMs, 10), 0, BUS_LIMITS.maxAttackMs)
  const releaseMs = clamp(numberArg(caller, 'releaseMs', options.releaseMs, 250), 0, BUS_LIMITS.maxReleaseMs)
  const detectorCoefficient = settleCoefficient(DETECTOR_SETTLE_MS, target.sampleRate)
  const attackCoefficient = settleCoefficient(attackMs, target.sampleRate)
  const releaseCoefficient = settleCoefficient(releaseMs, target.sampleRate)
  const frames = target.channels[0].length
  const sideChannels = side.channels
  const sideChannelCount = sideChannels.length
  const sideRate = side.sampleRate
  const sideScale = sideRate === target.sampleRate ? 1 : target.sampleRate / sideRate

  // Pass one measures the sidechain: its peak (for the report) and its running
  // mean square, which is monotone in a pulse and ripple-free on a tone. A
  // multichannel sidechain is detected as its loudest channel, the same linked
  // rule the compressor uses.
  const level = new Float64Array(frames)
  let levelMax = 0
  let sidePeak = 0
  let power = 0
  for (let index = 0; index < frames; index += 1) {
    // A sidechain at another rate is read by nearest sample: this is a level
    // detector, so interpolation buys nothing and would blur the attack.
    const at = sideScale === 1 ? index : Math.floor(index * sideScale)
    let magnitude = 0
    if (at < sideChannels[0].length) {
      for (let channel = 0; channel < sideChannelCount; channel += 1) {
        const value = Math.abs(sideChannels[channel][at])
        if (value > magnitude) magnitude = value
      }
    }
    if (magnitude > sidePeak) sidePeak = magnitude
    power += (magnitude * magnitude - power) * detectorCoefficient
    const amplitude = Math.sqrt(power)
    level[index] = amplitude
    if (amplitude > levelMax) levelMax = amplitude
  }

  // The full-duck reference is the mean level of the sidechain's loud part, not
  // its peak: a fast follower ripples at twice the sidechain's frequency, so the
  // peak of the level is a few percent above the level the tone actually holds.
  // Normalising by that peak would make every sustained trigger duck to 11.8 dB
  // when 12 was asked for; the mean of the loud samples is the true RMS of the
  // sustained part and averages the ripple out.
  const loudFloor = levelMax * 0.5
  let loudSum = 0
  let loudCount = 0
  for (let index = 0; index < frames; index += 1) {
    if (level[index] >= loudFloor) {
      loudSum += level[index]
      loudCount += 1
    }
  }
  const reference = loudCount > 0 ? loudSum / loudCount : 0

  // Pass two turns that level into a dip: the full amount at the sidechain's
  // reference level, proportional below it, then smoothed so the attack and
  // release times apply to the audible gain rather than to the measurement. One
  // gain per instant is applied to every target channel, so the duck cannot
  // move the image.
  const channelCount = target.channels.length
  const out = target.channels.map(() => new Float32Array(frames))
  let duckDb = 0
  let maxDuckDb = 0
  let sumDuckDb = 0
  let samplesDucked = 0
  for (let index = 0; index < frames; index += 1) {
    const normalized = reference > 0 ? Math.min(1, level[index] / reference) : 0
    const targetDuckDb = amountDb * normalized
    const coefficient = targetDuckDb > duckDb ? attackCoefficient : releaseCoefficient
    duckDb += (targetDuckDb - duckDb) * coefficient
    if (duckDb > maxDuckDb) maxDuckDb = duckDb
    if (duckDb > 0.01) samplesDucked += 1
    sumDuckDb += duckDb
    const gain = dbToGain(-duckDb)
    for (let channel = 0; channel < channelCount; channel += 1) out[channel][index] = target.channels[channel][index] * gain
  }

  return shapeResult(out, target.sampleRate, levelReport('duck', target.channels, out, target.sampleRate, {
    amountDb: roundTo(amountDb, 2),
    attackMs: roundTo(attackMs, 2),
    releaseMs: roundTo(releaseMs, 2),
    maxDuckDb: roundTo(maxDuckDb, 2),
    meanDuckDb: roundTo(frames > 0 ? sumDuckDb / frames : 0, 2),
    sidechainPeakDbfs: toDb(sidePeak),
    sidechainChannels: sideChannelCount,
    duckedPercent: roundTo(frames > 0 ? (samplesDucked / frames) * 100 : 0, 1)
  }))
}

/** One block of the constant-power pan / mid-side width matrix. */
function panRange (samples, left, right, leftGain, rightGain, widen, width, from, to) {
  for (let index = from; index < to; index += 1) {
    const value = samples[index]
    const leftValue = value * leftGain
    const rightValue = value * rightGain
    if (!widen) {
      left[index] = leftValue
      right[index] = rightValue
      continue
    }
    const mid = (leftValue + rightValue) / 2
    const side = (leftValue - rightValue) / 2 * width
    left[index] = mid + side
    right[index] = mid - side
  }
}

/**
 * Constant-power pan to a stereo pair, in cooperatively-yielded blocks.
 *
 * Centre is unity in *both* channels, so an unpanned track is bit-identical to
 * the mono track duplicated and a bus of unpanned tracks sums exactly like
 * `audio_mix`. Off centre the law is constant power: hard left puts +3 dB into
 * the left channel and silence in the right, and L² + R² stays constant across
 * the sweep, so the image moves without the track changing loudness.
 *
 * `width` is the mid/side width: 0 folds the panned image to mono at the mid
 * level, 1 leaves it alone, 2 doubles the side component. At centre the sides
 * are zero and width therefore does nothing, which is the correct behaviour.
 *
 * A multichannel track is refused: panning means placing a point source on a
 * stereo pair, and a 5.1/7.1 layer is already a layout. Changing that layout is
 * `fitChannels`' job (up/downmix) or `audio_spatial`'s (place a source), not a
 * pan knob's.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - mono source.
 * @param {{ pan?: number, width?: number, sampleRate?: number }} [options] - pan -1..1
 *   (default 0), width 0..2 (default 1).
 * @returns {{ channels: Float32Array[], sampleRate: number, report: object }}
 */
export function pan (track, options = {}) {
  return driveSync(panGen(track, options))
}

/**
 * Generator form of `pan`: the matrix yields between blocks and the report's
 * meters yield inside their own loops.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - mono source.
 * @param {{ pan?: number, width?: number, sampleRate?: number }} [options] - pan and width.
 * @returns {Generator<unknown, { channels: Float32Array[], sampleRate: number, report: object }, unknown>}
 */
export function* panGen (track, options = {}) {
  const caller = 'pan'
  const { channels, sampleRate } = readTrackChannels(track, options, caller)
  if (channels.length > 1) {
    throw new Error(`${caller}: pan places a mono track; this track already has ${channels.length} channels, and a stereo/surround layer has an image to fit rather than a position to set (use fitChannels to change the layout)`)
  }
  const samples = channels[0]
  const panValue = clamp(numberArg(caller, 'pan', options.pan, 0), -1, 1)
  const width = clamp(numberArg(caller, 'width', options.width, 1), 0, BUS_LIMITS.maxWidth)
  const theta = (panValue + 1) * Math.PI / 4
  // sin(pi/2) is 6.1e-17, not 0. A hard pan has to silence the far channel
  // exactly, otherwise the file carries a -320 dBFS ghost and reads as "not
  // silent" to anything that checks for zero.
  const snap = (gain) => (Math.abs(gain) < 1e-12 ? 0 : gain)
  const leftGain = snap(Math.SQRT2 * Math.cos(theta))
  const rightGain = snap(Math.SQRT2 * Math.sin(theta))
  const frames = samples.length
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const widen = width !== 1
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    panRange(samples, left, right, leftGain, rightGain, widen, width, from, Math.min(frames, from + YIELD_EVERY_FRAMES))
    yield
  }

  const leftRms = yield* rmsOfGen(left)
  const rightRms = yield* rmsOfGen(right)
  const inputPeak = yield* peakOfGen(samples)
  const leftPeak = yield* peakOfGen(left)
  const rightPeak = yield* peakOfGen(right)
  return stereoResult([left, right], sampleRate, {
    type: 'pan',
    sampleRate,
    frames,
    durationSeconds: roundTo(frames / sampleRate, 6),
    pan: roundTo(panValue, 3),
    width: roundTo(width, 3),
    leftGainDb: toDb(leftGain),
    rightGainDb: toDb(rightGain),
    inputPeakDbfs: toDb(inputPeak),
    leftPeakDbfs: toDb(leftPeak),
    rightPeakDbfs: toDb(rightPeak),
    leftRmsDbfs: toDb(leftRms),
    rightRmsDbfs: toDb(rightRms),
    // One side being silent is a hard pan, not an infinite ratio to print.
    levelRatioDb: leftRms > 0 && rightRms > 0
      ? roundTo(linearToDb(leftRms) - linearToDb(rightRms), 2)
      : null
  })
}

/**
 * Trim leading and trailing silence. A one-shot from a decay renderer is mostly
 * tail; placing it on a timeline by offset is only predictable when the start of
 * the audible part is sample-accurate.
 *
 * `thresholdDb` is absolute dBFS, not relative to the track peak: -60 dBFS means
 * -60 dBFS in the file, so two tracks trimmed with the same number have the same
 * noise floor. A silent track returns an empty buffer and `allSilent: true`
 * rather than a one-sample lie.
 * @param {{ samples: Float32Array, sampleRate: number }|Float32Array} track - source track.
 * @param {{ thresholdDb?: number, padMs?: number, sampleRate?: number }} [options] -
 *   gate (default -60 dBFS), padding kept at each end (default 0 ms).
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }}
 */
export function trimSilence (track, options = {}) {
  const caller = 'trimSilence'
  const { channels, sampleRate } = readTrackChannels(track, options, caller)
  const thresholdDb = clamp(numberArg(caller, 'thresholdDb', options.thresholdDb, -60), -120, 0)
  const padMs = clamp(numberArg(caller, 'padMs', options.padMs, 0), 0, 5000)
  const threshold = dbToGain(thresholdDb)
  const frames = channels[0].length
  // A frame is audible if *any* channel carries signal: trimming a surround
  // layer by its mono fold could cut a rear-only effect at the head or tail.
  const audible = (index) => channels.some((channel) => Math.abs(channel[index]) > threshold)
  let first = -1
  let last = -1
  for (let index = 0; index < frames; index += 1) {
    if (audible(index)) { first = index; break }
  }
  if (first === -1) {
    return shapeResult(channels.map(() => new Float32Array(0)), sampleRate, {
      type: 'trimSilence',
      sampleRate,
      frames: 0,
      durationSeconds: 0,
      channelCount: channels.length,
      thresholdDb: roundTo(thresholdDb, 2),
      padMs: roundTo(padMs, 2),
      framesBefore: frames,
      framesAfter: 0,
      removedStartSeconds: roundTo(frames / sampleRate, 6),
      removedEndSeconds: 0,
      removedSeconds: roundTo(frames / sampleRate, 6),
      allSilent: true
    })
  }
  for (let index = frames - 1; index >= 0; index -= 1) {
    if (audible(index)) { last = index; break }
  }
  const padFrames = Math.round(padMs / 1000 * sampleRate)
  const start = Math.max(0, first - padFrames)
  const end = Math.min(frames, last + 1 + padFrames)
  const out = channels.map((channel) => channel.slice(start, end))
  return shapeResult(out, sampleRate, {
    type: 'trimSilence',
    sampleRate,
    frames: end - start,
    durationSeconds: roundTo((end - start) / sampleRate, 6),
    channelCount: channels.length,
    thresholdDb: roundTo(thresholdDb, 2),
    padMs: roundTo(padMs, 2),
    framesBefore: frames,
    framesAfter: end - start,
    removedStartSeconds: roundTo(start / sampleRate, 6),
    removedEndSeconds: roundTo((frames - end) / sampleRate, 6),
    removedSeconds: roundTo((frames - (end - start)) / sampleRate, 6),
    allSilent: false
  })
}

/** Every processor by the `type` a chain entry names. */
export const PROCESSORS = Object.freeze({
  highpass,
  lowpass,
  peaking,
  shelf,
  compressor,
  duck,
  pan,
  trimSilence
})

/* ---------------------------------------------------------------- chains -- */

/**
 * Apply an ordered chain of processors to one track.
 *
 * Order is the whole point of a chain: high-pass before a compressor makes the
 * compressor react to the material that survives; high-pass after it makes the
 * compressor react to the rumble first and then throws the rumble away, which is
 * a different sound and a different peak. The report keeps every step in order so
 * the difference is visible.
 * @param {{ samples: Float32Array, sampleRate: number }|{ channels: Float32Array[], sampleRate: number }} track - source track.
 * @param {Array<{ type: string, [key: string]: any }>} [chain] - processors in order,
 *   e.g. `[{ type: 'highpass', hz: 120 }, { type: 'compressor', thresholdDb: -24 }]`.
 *   `pan` may only appear last and only on a mono track; `duck` needs a
 *   `sidechain` field.
 * @returns {{ samples?: Float32Array, channels?: Float32Array[], sampleRate: number, report: object }}
 *   the same shape as the input, or stereo when the chain ends in `pan`.
 */
export function processTrack (track, chain = []) {
  const caller = 'processTrack'
  if (!Array.isArray(chain)) {
    throw new Error(`${caller}: chain must be an array of { type, ...options }, got ${describeValue(chain)}`)
  }
  const start = readTrackChannels(track, {}, caller)
  let current = { channels: start.channels, sampleRate: start.sampleRate }
  let lastStereo = null
  let stereo = false
  const steps = []

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${caller}: chain[${index}] must be an object like { type: 'highpass', hz: 120 }, got ${describeValue(entry)}`)
    }
    const type = entry.type
    if (typeof type !== 'string' || PROCESSORS[type] === undefined) {
      throw new Error(`${caller}: chain[${index}] has no known type (got ${describeValue(type)}); available: ${Object.keys(PROCESSORS).join(', ')}`)
    }
    if (stereo) {
      throw new Error(`${caller}: chain[${index}] "${type}" cannot follow pan; pan is always the last step`)
    }
    let result
    if (type === 'duck') {
      if (entry.sidechain === undefined || entry.sidechain === null) {
        throw new Error(`${caller}: chain[${index}] duck needs a sidechain track`)
      }
      result = duck(current, entry.sidechain, entry)
    } else if (type === 'pan') {
      result = pan(current, entry)
      stereo = true
      lastStereo = result
    } else {
      result = PROCESSORS[type](current, entry)
    }
    steps.push(result.report)
    if (!stereo) current = { channels: result.channels ?? [result.samples], sampleRate: result.sampleRate }
  }

  let gainReductionDb = 0
  let maxDuckDb = 0
  for (const step of steps) {
    if (Number.isFinite(step.maxGainReductionDb) && step.maxGainReductionDb > gainReductionDb) gainReductionDb = step.maxGainReductionDb
    if (Number.isFinite(step.maxDuckDb) && step.maxDuckDb > maxDuckDb) maxDuckDb = step.maxDuckDb
  }
  const outputChannels = stereo ? lastStereo.channels : current.channels
  const report = {
    types: steps.map((step) => step.type),
    steps,
    stereo,
    channelCount: outputChannels.length,
    sampleRate: start.sampleRate,
    frames: outputChannels[0] === undefined ? 0 : outputChannels[0].length,
    durationSeconds: roundTo((outputChannels[0] === undefined ? 0 : outputChannels[0].length) / start.sampleRate, 6),
    gainReductionDb: roundTo(gainReductionDb, 2),
    maxDuckDb: roundTo(maxDuckDb, 2)
  }
  // An empty chain is a no-op and hands the input buffer back rather than
  // copying it: the bus copies before it processes, so ownership stays clear.
  return shapeResult(outputChannels, start.sampleRate, report)
}

/* ------------------------------------------------------------------ bus -- */

/**
 * Rate-convert one layer channel to the bus rate.
 *
 * Linear interpolation used to be considered good enough; it is not, because it
 * has no anti-alias/anti-image filter. A 48 kHz layer with 13 kHz content on a
 * 22.05 kHz bus folds that partial to 9 kHz, and a 22.05 kHz layer on a 48 kHz
 * bus paints its images at 12-14 kHz — both audible as a metallic top end, and
 * neither is a property of the cue the author asked for. `convert.resampleHiFi`
 * is the plugin's Kaiser-windowed polyphase resampler (the one `audio_convert`
 * uses), so a layer's rate stops being the reason a bus sounds unlike its
 * sources. Same-rate layers are handed back untouched: no copy, no filter.
 */
function resampleChannel (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  return resampleHiFi(samples, fromRate, toRate).samples
}

function resolveMaster (master, caller) {
  const source = master === undefined || master === null ? {} : master
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${caller}: master must be an object like { peakDbfs, limiter, drive }, got ${describeValue(master)}`)
  }
  let peakDbfs = -1
  if (source.peakDbfs === null) {
    peakDbfs = null
  } else if (source.peakDbfs !== undefined) {
    const value = numberArg(caller, 'master.peakDbfs', source.peakDbfs, -1)
    if (value < BUS_LIMITS.minMasterPeakDbfs || value > BUS_LIMITS.maxMasterPeakDbfs) {
      throw new Error(`${caller}: master.peakDbfs must be between ${BUS_LIMITS.minMasterPeakDbfs} and ${BUS_LIMITS.maxMasterPeakDbfs} dBFS, got ${describeValue(source.peakDbfs)}`)
    }
    peakDbfs = value
  }
  const drive = clamp(numberArg(caller, 'master.drive', source.drive ?? source.driveDb, 0), -BUS_LIMITS.maxDriveDb, BUS_LIMITS.maxDriveDb)
  const limiter = source.limiter !== false
  return { peakDbfs, limiter, drive }
}

function readChannels (caller, requested) {
  if (requested === undefined || requested === null) return undefined
  const value = numberArg(caller, 'channels', requested, undefined)
  if (!CHANNEL_COUNTS.includes(value)) {
    throw new Error(`${caller}: channels must be one of ${CHANNEL_COUNTS.join(', ')} (1 mono, 2 stereo, 4 quad, 6 5.1, 8 7.1), got ${describeValue(requested)}`)
  }
  return value
}

/** One block of the soft limiter (see `softLimit`). */
function softLimitRange (samples, knee, from, to) {
  for (let index = from; index < to; index += 1) {
    const value = samples[index]
    const magnitude = Math.abs(value)
    if (magnitude > knee) {
      const over = (magnitude - knee) / (1 - knee)
      samples[index] = Math.sign(value) * (knee + (1 - knee) * Math.tanh(over))
    }
  }
}

/** The soft limiter `dsp.softLimit` applies, repeated here to keep the module import-free. */
function* softLimit (samples) {
  const knee = BUS_LIMITS.limiterKnee
  for (let from = 0; from < samples.length; from += YIELD_EVERY_FRAMES) {
    softLimitRange(samples, knee, from, Math.min(samples.length, from + YIELD_EVERY_FRAMES))
    yield
  }
  return samples
}

/**
 * Mono fold of a stereo pair: the average of the two channels.
 *
 * Averaging (rather than summing) keeps a centre-panned track at its original
 * level, because `pan` puts unity in both channels at centre. This is also the
 * fold `measure` sees when a tool probes a stereo file, so a bus report and a
 * later `audio_probe` of the same file talk about the same signal.
 */
function* averageChannels (left, right) {
  const out = new Float32Array(left.length)
  for (let from = 0; from < left.length; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(left.length, from + YIELD_EVERY_FRAMES)
    for (let index = from; index < to; index += 1) out[index] = (left[index] + right[index]) / 2
    yield
  }
  return out
}

function uniqueId (base, used) {
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  used.add(id)
  return id
}

/** One block of the per-track gain stage. */
function trackGainRange (source, out, gain, from, to) {
  for (let index = from; index < to; index += 1) out[index] = source[index] * gain
}

/** Resolve one track request into a processed layer (one or more channels) plus its meters. */
function* renderOneTrackGen (spec, sampleRate, caller) {
  const sourceChannels = []
  for (const channel of spec.channels) {
    sourceChannels.push(resampleChannel(channel, spec.sampleRate, sampleRate))
    // Rate conversion is one pass in an untouched module (`lib/convert.js`); the
    // cooperation point is between channels rather than inside the resampler.
    yield
  }
  const gain = dbToGain(spec.gainDb)
  // Gain lands before the chain so a compressor sees the level the caller set,
  // which is the behaviour a fader feeding an insert chain has. One gain for
  // every channel: a per-channel gain would move the image before the chain
  // even ran.
  const driven = []
  for (const channel of sourceChannels) {
    const out = new Float32Array(channel.length)
    for (let from = 0; from < channel.length; from += YIELD_EVERY_FRAMES) {
      trackGainRange(channel, out, gain, from, Math.min(channel.length, from + YIELD_EVERY_FRAMES))
      yield
    }
    driven.push(out)
  }

  const chain = []
  for (const entry of spec.chain) {
    if (entry !== null && typeof entry === 'object' && entry.type === 'duck' && entry.sidechain !== undefined && entry.sidechain !== null) {
      const side = readTrackChannels(entry.sidechain, { sampleRate }, `${caller} tracks[i] duck sidechain`)
      const sideChannels = []
      for (const channel of side.channels) {
        sideChannels.push(resampleChannel(channel, side.sampleRate, sampleRate))
        yield
      }
      chain.push({ ...entry, sidechain: { channels: sideChannels, sampleRate } })
    } else {
      chain.push(entry)
    }
  }
  // One processor is a whole-track pass with its own detector state; the bus
  // yields between chain entries (and `processTrack` is a no-op for an empty
  // chain, which is the common case).
  const processed = processTrack({ channels: driven, sampleRate }, chain)
  yield
  if (processed.report.stereo) {
    throw new Error(`${caller}: a track chain must not end in pan; set the track's own pan/width instead`)
  }
  const outputChannels = processed.channels ?? [processed.samples]

  return {
    id: spec.id,
    channels: outputChannels,
    channelCount: outputChannels.length,
    sampleRate,
    offsetSeconds: spec.offsetSeconds,
    startFrame: Math.round(spec.offsetSeconds * sampleRate),
    gainDb: spec.gainDb,
    pan: spec.pan,
    width: spec.width,
    report: processed.report,
    peakInDbfs: toDb(yield* peakOfChannelsGen(sourceChannels)),
    rmsInDbfs: toDb(yield* rmsOfChannelsGen(sourceChannels)),
    peakOutDbfs: toDb(yield* peakOfChannelsGen(outputChannels)),
    rmsOutDbfs: toDb(yield* rmsOfChannelsGen(outputChannels))
  }
}

/**
 * Fit one processed layer onto the bus's channel count.
 *
 * The legacy mono paths are bit-identical to the pre-multichannel bus: a mono
 * layer into a 1- or 2-channel bus is panned exactly as before (pan 0 is unity
 * in both channels, and the 1-channel fold is the average of the panned pair).
 * A mono layer into a surround bus goes to the centre speaker when it is
 * unpanned, which is what an upmix of a point source should do, and across the
 * front pair when it is panned. A multichannel layer is up/downmixed by
 * `fitChannels`, so a stereo layer in a 5.1 bus keeps its image in FL/FR and a
 * 5.1 layer in a stereo bus folds down with LFE dropped.
 *
 * @param {object} layer - processed layer from `renderOneTrack`.
 * @param {number} channels - bus channel count.
 * @param {number} sampleRate - Hz.
 * @returns {Float32Array[]} exactly `channels` buffers.
 */
function* fitLayerToBus (layer, channels, sampleRate) {
  if (layer.channels.length === 1) {
    if (channels <= 2) {
      const panned = yield* panGen({ samples: layer.channels[0], sampleRate }, { pan: layer.pan, width: layer.width })
      return channels === 2 ? panned.channels : [yield* averageChannels(panned.channels[0], panned.channels[1])]
    }
    const front = layer.pan === 0
      ? layer.channels
      : (yield* panGen({ samples: layer.channels[0], sampleRate }, { pan: layer.pan, width: layer.width })).channels
    // `fitChannels` is one pass in `lib/multichannel.js`, which this change does
    // not own; it is atomic, and the business of this module is to yield around
    // the passes it does own.
    return fitChannels(front, channels)
  }
  // A pan/width knob on a multichannel layer was rejected while the request was
  // validated, so the layer arrives here as a layout and is only re-laid-out.
  return fitChannels(layer.channels, channels)
}

/** One block of the layer-summing loop. */
function sumLayerRange (bus, source, startFrame, from, to) {
  for (let index = from; index < to; index += 1) bus[index] += source[index - startFrame]
}

/** One block of the linked master fader. */
function masterGainRange (buses, masterGain, from, to) {
  for (const bus of buses) for (let index = from; index < to; index += 1) bus[index] *= masterGain
}

/** One block of the clipping / RMS meter (one channel, shared accumulators). */
function masterMeterRange (channel, from, to, state) {
  let clipping = state[0]
  let sumSquares = state[1]
  let sampleCount = state[2]
  for (let index = from; index < to; index += 1) {
    const value = channel[index]
    if (Math.abs(value) >= 0.999) clipping += 1
    sumSquares += value * value
    sampleCount += 1
  }
  state[0] = clipping
  state[1] = sumSquares
  state[2] = sampleCount
}

/**
 * Render a whole bus: process every track, place it on one timeline, pan it and
 * run the master stage.
 *
 * The master stage is deliberately the same shape as `audio_mix`'s: an optional
 * drive into the soft limiter, then a peak normalisation. That means a bus with
 * no chain, no pan and default settings lands where a mix of the same inputs
 * lands, and the difference in the file is exactly the processing the caller
 * asked for.
 *
 * Placement happens after processing so a track's offset is not affected by a
 * filter's group delay, and the timeline is bounded before anything is
 * allocated: an offset of 1e6 seconds is a bug, not a long cue.
 *
 * Channel count. A request may name 1/2/4/6/8 output channels. With no request
 * the bus infers it: the widest layer wins (so a project with one 5.1 layer is a
 * 5.1 bus), otherwise the historical rule (stereo when anything is panned, mono
 * when not). Every layer is then fitted to that count with `fitChannels`, so a
 * stereo input into a 6-channel master is upmixed instead of being rejected, and
 * the report names each layer's fit. The master stage is joint over all
 * channels: one drive gain, one soft limiter shape, one peak normalisation, so
 * the image is preserved and the peak printed is the file's real peak.
 *
 * @param {Array<object>} tracks - per layer: `{ id?, samples, channels?, sampleRate?, gainDb?,
 *   offsetSeconds?, pan?, width?, chain? }`. `samples` is a mono buffer; `channels`
 *   is one buffer per channel for a stereo/surround layer. `chain` is an ordered
 *   processor list (see `processTrack`). The source rate defaults to the bus rate.
 * @param {{ sampleRate?: number, channels?: 1|2|4|6|8, master?: { peakDbfs?: number|null,
 *   limiter?: boolean, drive?: number } }} [options] - bus rate (default 48 kHz),
 *   output channels (default: the widest layer, else 2 when any track is panned,
 *   else 1) and the master stage (default: limiter on, peak -1 dBFS, no drive).
 * @returns {{ sampleRate: number, channels: number, frames: number,
 *   durationSeconds: number, stems: object[], master: object, meter: object }} the
 *   rendered bus. `stems[i].samples` is the layer's first channel (mono layers
 *   keep the old shape), `stems[i].channels` is the full processed layer, and the
 *   master's `samples` is the mono fold of the real channels.
 */
export function renderBus (tracks, options = {}) {
  return driveSync(renderBusGen(tracks, options))
}

/**
 * Render a bus without holding the event loop for the whole render.
 *
 * Same generator, same arithmetic, same bytes as `renderBus`; every block
 * boundary also waits for a `setImmediate`.
 * @param {Array<object>} tracks - per layer, see `renderBus`.
 * @param {object} [options] - bus options, see `renderBus`.
 * @returns {Promise<{ sampleRate: number, channels: number, frames: number,
 *   durationSeconds: number, stems: object[], master: object, meter: object }>}
 */
export function renderBusAsync (tracks, options = {}) {
  return driveAsync(renderBusGen(tracks, options))
}

/**
 * Cooperatively-yielded form of `renderBus`.
 *
 * Same validation, same arithmetic, same bytes as `renderBus`: every pass this
 * module owns (the per-track gain and meter loops, `pan`, the layer sum, the soft
 * limiter, the master fader and the final meters) yields between blocks, so a
 * multi-second bus render leaves the host event loop able to run timers and I/O.
 * What stays atomic is what this module does not own: `fitChannels` from
 * `lib/multichannel.js` and the per-processor chain (`processTrack`), whose
 * detectors are whole-track state machines; the bus yields on both sides of
 * them. The tool layer calls this one.
 * @param {Array<object>} tracks - per layer, see `renderBus`.
 * @param {object} [options] - bus options, see `renderBus`.
 * @returns {Generator<unknown, { sampleRate: number, channels: number, frames: number,
 *   durationSeconds: number, stems: object[], master: object, meter: object }, unknown>}
 */
export function* renderBusGen (tracks, options = {}) {
  const caller = 'renderBus'
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error(`${caller}: tracks must be a non-empty array of { samples | channels, sampleRate, gainDb?, offsetSeconds?, pan?, chain? }`)
  }
  if (tracks.length > BUS_LIMITS.maxTracks) {
    throw new Error(`${caller}: ${tracks.length} tracks exceeds the ${BUS_LIMITS.maxTracks}-track limit; render the cue in parts`)
  }
  const sampleRate = clamp(
    Math.round(numberArg(caller, 'sampleRate', options.sampleRate, 48000)),
    BUS_LIMITS.minSampleRate,
    BUS_LIMITS.maxSampleRate
  )
  const masterOptions = resolveMaster(options.master, caller)
  const requestedChannels = readChannels(caller, options.channels)
  const usedIds = new Set()

  const specs = tracks.map((track, index) => {
    if (track === null || typeof track !== 'object') {
      throw new Error(`${caller}: tracks[${index}] must be an object, got ${describeValue(track)}`)
    }
    const rawChannels = track.channels !== undefined
      ? track.channels
      : (Array.isArray(track.samples) ? track.samples : (isSampleBuffer(track.samples) ? [track.samples] : null))
    if (!isChannelArray(rawChannels)) {
      throw new Error(`${caller}: tracks[${index}] needs samples (a Float32Array) or channels (a non-empty array of them), got ${describeValue(track.samples)}`)
    }
    const sourceFrames = rawChannels[0].length
    if (rawChannels.some((channel) => channel.length !== sourceFrames)) {
      throw new Error(`${caller}: tracks[${index}] channels must all have the same length`)
    }
    if (!CHANNEL_COUNTS.includes(rawChannels.length)) {
      throw new Error(`${caller}: tracks[${index}] has ${rawChannels.length} channels, which has no WAVE layout; supported counts are ${CHANNEL_COUNTS.join(', ')}`)
    }
    const sourceRate = Math.round(numberArg(caller, `tracks[${index}].sampleRate`, track.sampleRate, sampleRate))
    if (sourceRate < BUS_LIMITS.minSampleRate || sourceRate > BUS_LIMITS.maxSampleRate) {
      throw new Error(`${caller}: tracks[${index}].sampleRate must be between ${BUS_LIMITS.minSampleRate} and ${BUS_LIMITS.maxSampleRate} Hz, got ${describeValue(track.sampleRate)}`)
    }
    const gainDb = clamp(numberArg(caller, `tracks[${index}].gainDb`, track.gainDb, 0), BUS_LIMITS.minGainDb, BUS_LIMITS.maxGainDb)
    const offsetSeconds = clamp(numberArg(caller, `tracks[${index}].offsetSeconds`, track.offsetSeconds, 0), 0, BUS_LIMITS.maxSeconds)
    const panValue = clamp(numberArg(caller, `tracks[${index}].pan`, track.pan, 0), -1, 1)
    const width = clamp(numberArg(caller, `tracks[${index}].width`, track.width, 1), 0, BUS_LIMITS.maxWidth)
    if (rawChannels.length > 1 && (panValue !== 0 || width !== 1)) {
      throw new Error(`${caller}: tracks[${index}] is a ${rawChannels.length}-channel layer; pan/width place a mono layer, so a multichannel layer must be laid out with fitChannels (or the bus's channels option) instead`)
    }
    const rawChain = track.chain === undefined || track.chain === null ? [] : track.chain
    if (!Array.isArray(rawChain)) {
      throw new Error(`${caller}: tracks[${index}].chain must be an array of processors, got ${describeValue(track.chain)}`)
    }
    const baseId = String(track.id ?? track.name ?? `track-${index + 1}`).trim() || `track-${index + 1}`
    return {
      id: uniqueId(baseId, usedIds),
      channels: rawChannels,
      sampleRate: sourceRate,
      gainDb,
      offsetSeconds,
      pan: panValue,
      width,
      chain: rawChain
    }
  })

  const layers = []
  for (const spec of specs) {
    layers.push(yield* renderOneTrackGen(spec, sampleRate, caller))
    // One track's processing is the outer unit of work; a track with no chain
    // offers no other cooperation point before the next one starts.
    yield
  }
  const longest = layers.reduce((max, layer) => Math.max(max, layer.startFrame + layer.channels[0].length), 0)
  const frames = Math.max(1, longest)
  const maximumFrames = BUS_LIMITS.maxSeconds * sampleRate
  if (frames > maximumFrames) {
    throw new Error(`${caller}: timeline ${roundTo(frames / sampleRate, 3)} s exceeds the ${BUS_LIMITS.maxSeconds} s limit; place the cues with audio_mix or shorter offsets`)
  }

  const needsStereo = layers.some((layer) => layer.pan !== 0 || layer.width !== 1)
  const widestLayer = layers.reduce((widest, layer) => Math.max(widest, layer.channelCount), 1)
  // The widest layer wins, so handing the bus a 5.1 render makes a 5.1 bus and a
  // stereo layer keeps its two channels. Only a bus made of mono layers falls
  // back to the historical rule (stereo when something is panned, else mono).
  const channels = requestedChannels ?? (widestLayer > 1 ? widestLayer : (needsStereo ? 2 : 1))
  // Float32 buses, like `mixTracks`: it is the precision the mixer has always
  // summed in, so a bus and a mix of the same inputs agree at the bit level.
  const buses = Array.from({ length: channels }, () => new Float32Array(frames))
  for (const layer of layers) {
    const fitted = yield* fitLayerToBus(layer, channels, sampleRate)
    layer.fit = { from: layer.channelCount, to: channels, kind: conversionKind(layer.channelCount, channels) }
    const sourceFrames = fitted[0].length
    const limit = Math.min(frames, layer.startFrame + sourceFrames)
    for (let channel = 0; channel < channels; channel += 1) {
      const bus = buses[channel]
      const source = fitted[channel]
      for (let from = layer.startFrame; from < limit; from += YIELD_EVERY_FRAMES) {
        const to = Math.min(limit, from + YIELD_EVERY_FRAMES)
        sumLayerRange(bus, source, layer.startFrame, from, to)
        yield
      }
    }
  }

  // One linked fader for every channel of the master: a per-channel gain here
  // would tilt the image, and the drive knob is a level into the limiter, not a
  // balance control. `linkStemGain` is one pass in `lib/multichannel.js`; the bus
  // yields around it.
  yield
  linkStemGain(buses, masterOptions.drive)

  let limiterEngaged = false
  let preLimitPeak = 0
  for (const bus of buses) {
    const peak = yield* peakOfGen(bus)
    if (peak > preLimitPeak) preLimitPeak = peak
  }
  if (masterOptions.limiter) {
    if (preLimitPeak > BUS_LIMITS.limiterKnee) limiterEngaged = true
    for (const bus of buses) yield* softLimit(bus)
  }
  let limiterReductionDb = 0
  if (limiterEngaged && preLimitPeak > 0) {
    let postLimitPeak = 0
    for (const bus of buses) {
      const peak = yield* peakOfGen(bus)
      if (peak > postLimitPeak) postLimitPeak = peak
    }
    limiterReductionDb = roundTo(linearToDb(postLimitPeak) - linearToDb(preLimitPeak), 2)
  }

  let masterGain = 1
  if (masterOptions.peakDbfs !== null) {
    let peak = 0
    for (const bus of buses) {
      const busPeak = yield* peakOfGen(bus)
      if (busPeak > peak) peak = busPeak
    }
    if (peak > 0) {
      masterGain = dbToGain(masterOptions.peakDbfs) / peak
      for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
        const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
        masterGainRange(buses, masterGain, from, to)
        yield
      }
    }
  }

  // The encoded files own their buffers; the caller may mutate them freely.
  yield
  const channelSamples = buses.map((bus) => bus.slice())
  // The mono fold is a real downmix, not an average of the first pair: it drops
  // LFE and folds the centre and surrounds at their standard gains, so a probe
  // of a 5.1 bus and a probe of its mono fold describe the same signal. For a
  // stereo bus this is exactly the old average of L and R.
  const monoFold = channels === 1 ? channelSamples[0].slice() : fitChannels(channelSamples, 1)[0]
  const layout = layoutFor(channels)

  let masterPeak = 0
  const channelPeaksDbfs = []
  const meterState = new Float64Array(3)
  for (const channel of channelSamples) {
    const channelPeak = yield* peakOfGen(channel)
    if (channelPeak > masterPeak) masterPeak = channelPeak
    channelPeaksDbfs.push(toDb(channelPeak))
    for (let from = 0; from < channel.length; from += YIELD_EVERY_FRAMES) {
      const to = Math.min(channel.length, from + YIELD_EVERY_FRAMES)
      masterMeterRange(channel, from, to, meterState)
      yield
    }
  }
  const clipping = meterState[0]
  const sumSquares = meterState[1]
  const sampleCount = meterState[2]
  const masterRms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0
  const monoPeak = yield* peakOfGen(monoFold)
  const monoRms = yield* rmsOfGen(monoFold)
  const crestOf = (peak, rms) => (peak > 0 ? roundTo(linearToDb(peak) - linearToDb(rms), 2) : 0)
  const masterMetrics = {
    sampleRate,
    channels,
    channelLayout: layout.id,
    channelNames: [...layout.names],
    channelMask: layout.mask,
    frames,
    durationSeconds: roundTo(frames / sampleRate, 6),
    // The peak of the *file* is the loudest sample in any channel; `audio_probe`
    // will later measure the mono fold of the same file, so both are reported
    // and neither can be mistaken for the other.
    peakDbfs: toDb(masterPeak),
    rmsDbfs: toDb(masterRms),
    crestDb: crestOf(masterPeak, masterRms),
    clipping,
    channelPeaksDbfs,
    monoFoldPeakDbfs: toDb(monoPeak),
    monoFoldRmsDbfs: toDb(monoRms)
  }

  let gainReductionDb = 0
  const trackStats = layers.map((layer) => {
    if (layer.report.gainReductionDb > gainReductionDb) gainReductionDb = layer.report.gainReductionDb
    return {
      id: layer.id,
      offsetSeconds: roundTo(layer.offsetSeconds, 6),
      gainDb: roundTo(layer.gainDb, 2),
      pan: roundTo(layer.pan, 3),
      width: roundTo(layer.width, 3),
      channels: layer.channelCount,
      fit: layer.fit,
      chain: layer.report.types,
      peakInDbfs: layer.peakInDbfs,
      rmsInDbfs: layer.rmsInDbfs,
      peakOutDbfs: layer.peakOutDbfs,
      rmsOutDbfs: layer.rmsOutDbfs,
      gainReductionDb: layer.report.gainReductionDb,
      maxDuckDb: layer.report.maxDuckDb
    }
  })

  return {
    sampleRate,
    channels,
    channelLayout: layout.id,
    channelNames: [...layout.names],
    channelMask: layout.mask,
    frames,
    durationSeconds: roundTo(frames / sampleRate, 6),
    stems: layers.map((layer) => ({
      id: layer.id,
      // `samples` is the layer's first channel so mono callers keep the old
      // shape; `channels` is the full processed layer, post-chain and pre-fit.
      samples: layer.channels[0],
      channels: layer.channels,
      channelCount: layer.channelCount,
      sampleRate,
      offsetSeconds: layer.offsetSeconds,
      startFrame: layer.startFrame,
      gainDb: layer.gainDb,
      pan: layer.pan,
      width: layer.width,
      fit: layer.fit,
      peakDbfs: layer.peakOutDbfs,
      rmsDbfs: layer.rmsOutDbfs,
      report: layer.report
    })),
    master: {
      sampleRate,
      channels,
      channelLayout: layout.id,
      channelNames: [...layout.names],
      channelMask: layout.mask,
      frames,
      durationSeconds: roundTo(frames / sampleRate, 6),
      samples: monoFold,
      channelSamples,
      peakDbfs: masterMetrics.peakDbfs,
      rmsDbfs: masterMetrics.rmsDbfs,
      crestDb: masterMetrics.crestDb,
      clipping: masterMetrics.clipping,
      channelPeaksDbfs: masterMetrics.channelPeaksDbfs,
      monoFoldPeakDbfs: masterMetrics.monoFoldPeakDbfs,
      monoFoldRmsDbfs: masterMetrics.monoFoldRmsDbfs,
      driveDb: roundTo(masterOptions.drive, 2),
      /** The linked master fader: one gain for every channel (normalisation). */
      mixGainDb: roundTo(linearToDb(masterGain), 2),
      gainDb: roundTo(linearToDb(masterGain), 2),
      limiter: masterOptions.limiter,
      limiterEngaged,
      limiterReductionDb
    },
    meter: {
      trackStats,
      gainReductionDb: roundTo(gainReductionDb, 2),
      master: {
        peakDbfs: masterMetrics.peakDbfs,
        rmsDbfs: masterMetrics.rmsDbfs,
        crestDb: masterMetrics.crestDb,
        clipping: masterMetrics.clipping,
        mixGainDb: roundTo(linearToDb(masterGain), 2),
        gainDb: roundTo(linearToDb(masterGain), 2),
        limiterEngaged,
        limiterReductionDb
      }
    }
  }
}
