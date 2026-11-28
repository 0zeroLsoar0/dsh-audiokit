/**
 * Mastering chain: multiband compression, stereo width, true-peak limiting and
 * the loop that lands a cue on an integrated-loudness target.
 *
 * Why this module exists: `audio_loudness` can measure a file and apply one
 * linear gain, but a gain alone cannot make a quiet cue sit next to commercial
 * audio — moving it +10 dB either clips or is refused, so the tool reports the
 * target as unreachable. A master earns that loudness with three stages instead:
 * band-split dynamics control, a width/bass-mono stage that keeps the low end
 * mono-compatible, and a lookahead limiter that holds the true peak while the
 * gain goes up. This file is those three stages plus the outer search that
 * decides how much gain they can take.
 *
 * Metering is deliberately *not* reimplemented here. Loudness and true peak are
 * read from `lib/lufs.js` (`analyzeLoudness` / `truePeak`), the same code the
 * reporting tools use, so the number a master is tuned against is the number
 * the next tool will report. The only DSP this module owns is the crossover,
 * the compressor detector, the mid/side matrix and the limiter's gain curve.
 *
 * Multichannel input (4/6/8 channels) is mastered without being folded: the
 * multiband detector is linked across every channel, the limiter's gain curve is
 * one curve for all channels, and the true-peak ceiling is verified on the
 * loudest channel with `lib/lufs.js`'s meter (so the promise is about the file,
 * not about a mono downmix). The stereo width stage is bypassed for a surround
 * layout and says so, because a mid/side matrix is defined on one stereo pair.
 * Loudness is measured on the non-LFE channels with the BS.1770-4 surround
 * weights (Ls/Rs at +1.5 dB), exactly as `audio_loudness` measures it, and a
 * mono input counts its single channel once (the standard weight, the number
 * ffmpeg reports) — so a mono master's target is the file's measured loudness,
 * not a dual-mono number 3 LU away from it. `multichannel.loudnessChannels` is
 * the shared decision and the report states the count used.
 *
 * Everything is pure and deterministic: the same samples, rate and options
 * produce identical output. No randomness, no state that survives a call — the
 * optional `telemetry` object a caller may pass to `masterChain` is written to
 * for diagnostics only and never read back into a result.
 */

import { clamp, dbToGain } from './dsp.js'
import { analyzeLoudness, truePeak } from './lufs.js'
import { CHANNEL_COUNTS, layoutFor, linkStemGain, loudnessChannels } from './multichannel.js'
import { YIELD_EVERY_FRAMES, driveAsync, driveSync } from './yield.js'

/* ---------------------------------------------------------------- constants -- */

/** The limiter detects inter-sample peaks on a 4x grid (the true-peak grid). */
const TRUE_PEAK_OVERSAMPLE = 4

/**
 * Detection kernel length. Detection runs on every sample, so it uses the
 * cheap 8-tap phase interpolator; the result is then *verified* against the
 * 16-tap meter kernel (lib/lufs.js) and trimmed. The guard below absorbs the
 * 8-tap kernel's underestimation of near-Nyquist peaks so the trim is usually
 * zero.
 */
const DETECTION_TAPS = 8
const METER_TAPS = 16

/** Headroom kept below the ceiling by the detector, in dB. */
const DETECTION_GUARD_DB = 0.3

/** A trim never lands exactly on the ceiling: a hundredth of a dB of margin. */
const TRIM_MARGIN_DB = 0.01

/** The chain stops iterating once the measured loudness is this close. */
const TARGET_TOLERANCE_LU = 0.3

/**
 * Secant corrections are oversized by this little factor: loudness is a concave
 * function of gain once the limiter works, so the slope measured between the
 * last two attempts is already stale by the time the step is applied.
 */
const SECANT_OVER_RELAXATION = 1.1

/** A gain move outside these limits is a bad request, not a mastering choice. */
const GAIN_LIMITS_DB = Object.freeze([-40, 40])

/**
 * The two ways `masterChain` can spend memory to save time.
 *
 * `memory` (the default) keeps a handful of scalars per attempt and re-renders
 * the winning gain once; `fast` keeps every attempt's rendered channel list so
 * the winner is handed back as-is. Both produce the same samples — the second
 * limiter pass `memory` pays for is redundant work, not a different result — so
 * the choice is purely a memory/time trade and is never allowed to move a
 * number.
 *
 * `memory` is the default because the fast path's cost grows with the request:
 * a 180 s / 48 kHz stereo master is ~69 MB per attempt, so keeping up to five
 * of them is ~345 MB of output buffers for one used result.
 */
export const MASTER_MODES = Object.freeze(['memory', 'fast'])
const DEFAULT_MASTER_MODE = 'memory'

/** One sentence per mode, so `report.mode` describes its own cost. */
const MODE_NOTES = Object.freeze({
  memory: 'attempts keep scalar measurements only; the selected gain is re-rendered once after the search (default, lowest memory)',
  fast: 'attempts keep their rendered samples, so the selected one is returned without a second limiter pass (saves one limiter pass, memory grows with every iteration)'
})

/**
 * `fast` mode earns a warning past these sizes.
 *
 * The trade is not a bug — the caller asked for it and the output is identical —
 * but silently holding hundreds of megabytes is the kind of thing that turns a
 * big request into an out-of-memory crash in the host. 256 MB is about a 180 s /
 * 48 kHz stereo master at four attempts, and 300 s is longer than any timeline
 * the plugin's own tools produce (they cap at 180 s), so a caller that reaches
 * the second limit brought a longer file than the presets were written for.
 */
const FAST_MODE_WARN_BYTES = 256e6
const FAST_MODE_WARN_SECONDS = 300

/**
 * The compressor updates its detector and gain law once per block of N samples
 * and interpolates the gain inside the block. At 48 kHz that is a 0.17 ms
 * attack resolution — far finer than any mastering attack time — and it removes
 * an `exp` and a branch per sample from the hot loop (3 bands x 2 channels x
 * 48 kHz is 288k transcendental calls a second otherwise).
 */
const COMPRESSOR_CONTROL_SAMPLES = 8

/** ln(10) / 20: converts a dB gain change to a natural-exponential factor. */
const DB_TO_NEPER = Math.LN10 / 20

/* ------------------------------------------------------------------ helpers -- */

function round3 (value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value
}

function round2 (value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

/**
 * Read a numeric option: `undefined`/`null` mean "use the default", anything
 * else must be finite (a NaN target silently producing silence is worse than an
 * error) and is clamped to the documented range.
 */
function numberOr (value, fallback, label, min, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number, got ${String(value)}`)
  return clamp(number, min, max)
}

function validateRate (sampleRate) {
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error(`mastering needs a sample rate between 8000 and 192000 Hz, got ${sampleRate}`)
  }
  return rate
}

/**
 * Read the memory/time mode, rejecting anything that is not one of the two
 * documented names.
 *
 * A silent fallback would be the worst outcome here: `mode: 'Fast'` would then
 * quietly hold hundreds of megabytes while the caller believes they got the
 * default, and a typo in `memory` would look like a working request. The error
 * names both modes and what each one costs, so the fix is in the message.
 */
function resolveMasterMode (value) {
  if (value === undefined || value === null) return DEFAULT_MASTER_MODE
  const text = String(value)
  if (MASTER_MODES.includes(text)) return text
  throw new Error(`mode must be "memory" (re-render the selected attempt once, lowest memory) or "fast" (keep every attempt's samples, one limiter pass less), got ${JSON.stringify(text)}`)
}

/**
 * Read the optional diagnostics accumulator.
 *
 * It is write-only: the chain fills it with how many limiter passes ran and how
 * many attempt buffers a mode retained, and nothing in the result depends on it.
 * It exists so a test can prove the memory claim with counters instead of RSS,
 * which is noisy, platform-specific and slow to settle.
 */
function readTelemetry (value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') {
    throw new Error('masterChain telemetry must be an object (diagnostics only; the result never depends on it)')
  }
  return value
}

function noteTelemetry (telemetry, key) {
  if (telemetry === null) return
  telemetry[key] = (telemetry[key] ?? 0) + 1
}

/**
 * Accept one mono buffer or one buffer per channel and validate the shape.
 *
 * A non-finite sample would poison every envelope and gain curve downstream, and
 * no deliverable should ever contain one, so the stages that read the input
 * sanitise it (see `sanitiseChannels`); this function only rejects a shape that
 * cannot be processed at all.
 *
 * Channel counts are restricted to the layouts the plugin can mean: 1, 2, 4, 6
 * or 8. A 3- or 5-channel array has no WAVE channel order, and mastering it
 * would be guessing which channel is the centre.
 */
function asChannelList (samples) {
  if (samples === null || samples === undefined) throw new Error('mastering needs sample data')
  const list = Array.isArray(samples) ? samples : [samples]
  if (list.length === 0) throw new Error('mastering needs at least one channel')
  if (!CHANNEL_COUNTS.includes(list.length)) {
    throw new Error(`mastering handles ${CHANNEL_COUNTS.join(', ')} channels (mono, stereo, quad, 5.1, 7.1), got ${list.length}`)
  }
  const frames = list[0] === null || list[0] === undefined ? 0 : list[0].length
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('mastering needs non-empty sample arrays')
  for (const channel of list) {
    if (channel === null || channel === undefined || typeof channel.length !== 'number' || channel.length !== frames) {
      throw new Error('mastering needs same-length sample arrays for every channel')
    }
  }
  return list
}

/** One block of a defensive channel copy (see `copyChannel`). */
function copyChannelRange (source, out, from, to) {
  for (let i = from; i < to; i += 1) {
    const value = source[i]
    out[i] = Number.isFinite(value) ? value : 0
  }
}

/** Copy a channel, replacing non-finite samples with silence, in yielded blocks. */
function* copyChannelGen (source) {
  const out = new Float32Array(source.length)
  for (let from = 0; from < source.length; from += YIELD_EVERY_FRAMES) {
    copyChannelRange(source, out, from, Math.min(source.length, from + YIELD_EVERY_FRAMES))
    yield
  }
  return out
}

/** Copy a channel, replacing non-finite samples with silence. */
function copyChannel (source) {
  return driveSync(copyChannelGen(source))
}

/** Copy a channel list defensively, in yielded blocks. */
function* copyChannels (list) {
  const out = []
  for (const channel of list) out.push(yield* copyChannelGen(channel))
  return out
}

/**
 * Read a channel list defensively: a clean list is used as-is (stage code only
 * reads its input), a list containing NaN/Infinity is copied with those samples
 * folded to silence first. Copying every input unconditionally costs a full
 * allocation pass per stage — tens of megabytes on a 60 s stereo master — so the
 * common clean case is scanned instead.
 */
function sanitiseChannels (list) {
  for (const channel of list) {
    for (let i = 0; i < channel.length; i += 1) {
      if (!Number.isFinite(channel[i])) return list.map(copyChannel)
    }
  }
  return list
}

/** Return the shape the caller used: one buffer stays mono, an array stays stereo. */
function restoreShape (channels, mono) {
  return mono ? channels[0] : channels
}

function scaleChannelsRange (channels, gain, from, to) {
  for (const channel of channels) {
    for (let i = from; i < to; i += 1) channel[i] *= gain
  }
}

/** Scale every channel by one gain, in yielded blocks. */
function* scaleChannels (channels, gain) {
  const frames = channels[0].length
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    scaleChannelsRange(channels, gain, from, to)
    yield
  }
}

/**
 * Analyse a channel list with the shared meter.
 *
 * `multichannel.loudnessChannels` is the one place that decides which channels
 * a loudness measurement may use and how much each one counts: LFE is excluded
 * (BS.1770 does not include it) and each surround channel carries the standard's
 * +1.5 dB weight. `audio_loudness` takes the same decision from the same helper,
 * so the two tools cannot report different LUFS for one file.
 */
function analyseChannels (channels, rate) {
  const { measured, weights } = loudnessChannels(channels)
  return analyzeLoudness(measured[0], rate, { channels: measured, weights })
}

/**
 * Channel-aware true peak: the worst channel wins, like the meter reports it.
 *
 * A surround deliverable's ceiling is a property of the *file*, not of a fold:
 * one hot surround channel is a clipped file even when the mono downmix looks
 * fine. So every channel is measured with the same `lib/lufs.js` truePeak the
 * reporting tools use, the maximum is the file's dBTP, and the index says which
 * channel it was on so the report can name it.
 *
 * @param {Float32Array[]} channels - channel list.
 * @param {number} rate - sample rate in Hz.
 * @returns {{ dbtp: number, channel: number, byChannel: number[] }} worst peak and where.
 */
function measuredTruePeak (channels, rate) {
  const byChannel = channels.map((channel) => truePeak(channel, rate))
  let dbtp = Number.NEGATIVE_INFINITY
  let channel = 0
  for (let index = 0; index < byChannel.length; index += 1) {
    if (byChannel[index] > dbtp) {
      dbtp = byChannel[index]
      channel = index
    }
  }
  return { dbtp, channel, byChannel }
}

/** Peak of one block of one channel (accumulated into `state[0]`). */
function channelPeakRange (channel, from, to, state) {
  let peak = state[0]
  for (let index = from; index < to; index += 1) {
    const magnitude = Math.abs(channel[index])
    if (magnitude > peak) peak = magnitude
  }
  state[0] = peak
}

/** Per-channel sample peak in dBFS, floored at -120 like the meter does. */
function* samplePeaksDbfs (channels) {
  const peaks = []
  for (const channel of channels) {
    const state = new Float64Array(1)
    for (let from = 0; from < channel.length; from += YIELD_EVERY_FRAMES) {
      const to = Math.min(channel.length, from + YIELD_EVERY_FRAMES)
      channelPeakRange(channel, from, to, state)
      yield
    }
    peaks.push(round2(state[0] > 0 ? 20 * Math.log10(state[0]) : -120))
  }
  return peaks
}

/* ------------------------------------------------------------------ biquads -- */

/**
 * Second-order Butterworth (Q = 1/sqrt2) low/high pass, RBJ cookbook form.
 *
 * Two of these in series is a Linkwitz-Riley 4th order, which is the crossover
 * this module uses. Squaring the Butterworth pair is what makes the crossover
 * clean: LR4 low + LR4 high is an allpass (magnitude flat at every frequency),
 * so a split pair sums back to the input in magnitude and the crossover adds no
 * ripple. A bare 2nd-order pair does not have that property — at the corner its
 * low and high outputs cancel — which is exactly why LR4 is the standard.
 * Cascading two identical sections is also why both band outputs can be taken
 * from one pass over the input.
 */
function butterworthCoefficients (rate, hz, highPass) {
  const frequency = clamp(hz, 10, rate * 0.45)
  const w0 = 2 * Math.PI * frequency / rate
  const cosine = Math.cos(w0)
  const sine = Math.sin(w0)
  const alpha = sine / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const numerator = highPass ? (1 + cosine) / 2 : (1 - cosine) / 2
  return {
    b0: numerator / a0,
    b1: (highPass ? -(1 + cosine) : (1 - cosine)) / a0,
    b2: numerator / a0,
    a1: -2 * cosine / a0,
    a2: (1 - alpha) / a0
  }
}

/** One block of a single LR4 section pair (see `lr4Pass`). */
function lr4Range (channel, out, coeffs, from, to, state) {
  const b0 = coeffs.b0
  const b1 = coeffs.b1
  const b2 = coeffs.b2
  const a1 = coeffs.a1
  const a2 = coeffs.a2
  let x1 = state[0]
  let x2 = state[1]
  let y1 = state[2]
  let y2 = state[3]
  let u1 = state[4]
  let u2 = state[5]
  let v1 = state[6]
  let v2 = state[7]
  for (let i = from; i < to; i += 1) {
    const input = channel[i]
    const first = b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = input
    y2 = y1
    y1 = first
    const second = b0 * first + b1 * u1 + b2 * u2 - a1 * v1 - a2 * v2
    u2 = u1
    u1 = first
    v2 = v1
    v1 = second
    out[i] = second
  }
  state[0] = x1
  state[1] = x2
  state[2] = y1
  state[3] = y2
  state[4] = u1
  state[5] = u2
  state[6] = v1
  state[7] = v2
}

/** Run one channel through an LR4 low- or high-pass at `hz`, in yielded blocks. */
function* lr4Pass (channel, rate, hz, highPass) {
  const coeffs = butterworthCoefficients(rate, hz, highPass)
  const frames = channel.length
  const out = new Float32Array(frames)
  const state = new Float64Array(8)
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    lr4Range(channel, out, coeffs, from, Math.min(frames, from + YIELD_EVERY_FRAMES), state)
    yield
  }
  return out
}

/**
 * Split channels into bands with a cascaded LR4 tree.
 *
 * Band k is the high-path through splits[0..k-1] low-passed at splits[k]; the
 * last band is the high-path through every split. This tree (rather than
 * filtering every band from the dry signal in parallel) is what keeps the sum
 * free of the phase cancellation that a parallel split produces at each
 * crossover. Both sides of a split are produced in the same pass over the input
 * (four biquad sections per split per channel), so a three-band split costs two
 * passes over the file rather than eight.
 */
/** One block of one channel through the two LR4 sections of a split. */
function lr4PairRange (channel, low, high, lowPass, highPass, from, to, state) {
  const lb0 = lowPass.b0
  const lb1 = lowPass.b1
  const lb2 = lowPass.b2
  const la1 = lowPass.a1
  const la2 = lowPass.a2
  const hb0 = highPass.b0
  const hb1 = highPass.b1
  const hb2 = highPass.b2
  const ha1 = highPass.a1
  const ha2 = highPass.a2
  let lx1 = state[0]
  let lx2 = state[1]
  let ly1 = state[2]
  let ly2 = state[3]
  let lu1 = state[4]
  let lu2 = state[5]
  let lv1 = state[6]
  let lv2 = state[7]
  let hx1 = state[8]
  let hx2 = state[9]
  let hy1 = state[10]
  let hy2 = state[11]
  let hu1 = state[12]
  let hu2 = state[13]
  let hv1 = state[14]
  let hv2 = state[15]
  for (let i = from; i < to; i += 1) {
    const input = channel[i]
    const lowFirst = lb0 * input + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2
    lx2 = lx1
    lx1 = input
    ly2 = ly1
    ly1 = lowFirst
    const lowSecond = lb0 * lowFirst + lb1 * lu1 + lb2 * lu2 - la1 * lv1 - la2 * lv2
    lu2 = lu1
    lu1 = lowFirst
    lv2 = lv1
    lv1 = lowSecond
    low[i] = lowSecond
    const highFirst = hb0 * input + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2
    hx2 = hx1
    hx1 = input
    hy2 = hy1
    hy1 = highFirst
    const highSecond = hb0 * highFirst + hb1 * hu1 + hb2 * hu2 - ha1 * hv1 - ha2 * hv2
    hu2 = hu1
    hu1 = highFirst
    hv2 = hv1
    hv1 = highSecond
    high[i] = highSecond
  }
  state[0] = lx1
  state[1] = lx2
  state[2] = ly1
  state[3] = ly2
  state[4] = lu1
  state[5] = lu2
  state[6] = lv1
  state[7] = lv2
  state[8] = hx1
  state[9] = hx2
  state[10] = hy1
  state[11] = hy2
  state[12] = hu1
  state[13] = hu2
  state[14] = hv1
  state[15] = hv2
}

function* splitPair (channels, rate, hz) {
  const lowPass = butterworthCoefficients(rate, hz, false)
  const highPass = butterworthCoefficients(rate, hz, true)
  const lows = []
  const highs = []
  for (const channel of channels) {
    const frames = channel.length
    const low = new Float32Array(frames)
    const high = new Float32Array(frames)
    // Low-pass state, then high-pass state, both cascaded twice (LR4).
    const state = new Float64Array(16)
    for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
      lr4PairRange(channel, low, high, lowPass, highPass, from, Math.min(frames, from + YIELD_EVERY_FRAMES), state)
      yield
    }
    lows.push(low)
    highs.push(high)
  }
  return { low: lows, high: highs }
}

function* splitIntoBands (channels, rate, splits) {
  const bands = []
  let highPath = channels
  let lo = 0
  for (const splitHz of splits) {
    const pair = yield* splitPair(highPath, rate, splitHz)
    bands.push({ lo, hi: splitHz, channels: pair.low })
    highPath = pair.high
    lo = splitHz
  }
  bands.push({ lo, hi: rate / 2, channels: highPath })
  return bands
}

function bandName (index, count) {
  if (count === 1) return 'full'
  if (count === 2) return index === 0 ? 'low' : 'high'
  if (count === 3) return ['low', 'mid', 'high'][index]
  if (count === 4) return ['low', 'low-mid', 'high-mid', 'high'][index]
  return `band-${index + 1}`
}

/**
 * Resolve the caller's band list.
 *
 * `splitHz` is the crossover at the *top* of a band, so a three-band request
 * carries two split frequencies (the last band's `splitHz` is unused and may be
 * omitted). Bands are validated before any filtering: a split outside the
 * audible band or out of order would silently produce silence in a band rather
 * than an error the caller can act on.
 */
function resolveBands (requested, rate) {
  const source = requested === undefined || requested === null ? DEFAULT_BANDS : requested
  if (!Array.isArray(source) || source.length === 0) throw new Error('bands must be a non-empty array')
  if (source.length > 5) throw new Error('bands supports at most 5 bands')
  const resolved = []
  let previous = 0
  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index]
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      throw new Error(`bands[${index}] must be an object with ratio, thresholdDb, attackMs, releaseMs and makeupDb`)
    }
    const isLast = index === source.length - 1
    let splitHz = null
    if (!isLast) {
      const requestedSplit = numberOr(raw.splitHz, index === 0 ? 150 : previous * 4, `bands[${index}].splitHz`, 20, rate * 0.45)
      if (requestedSplit <= previous + 1) {
        throw new Error(`bands[${index}].splitHz (${requestedSplit} Hz) must be above the previous crossover (${previous} Hz)`)
      }
      splitHz = requestedSplit
      previous = splitHz
    }
    resolved.push({
      index,
      name: bandName(index, source.length),
      lo: index === 0 ? 0 : resolved[index - 1].hi,
      hi: splitHz === null ? rate / 2 : splitHz,
      splitHz,
      ratio: numberOr(raw.ratio, 1.5, `bands[${index}].ratio`, 1, 40),
      thresholdDb: numberOr(raw.thresholdDb, -30, `bands[${index}].thresholdDb`, -60, 0),
      attackMs: numberOr(raw.attackMs, 10, `bands[${index}].attackMs`, 0.1, 200),
      releaseMs: numberOr(raw.releaseMs, 120, `bands[${index}].releaseMs`, 5, 2000),
      makeupDb: numberOr(raw.makeupDb, 0, `bands[${index}].makeupDb`, -12, 24)
    })
  }
  return resolved
}

/* --------------------------------------------------------- peak detection -- */

const KERNEL_CACHE = new Map()

/**
 * Windowed-sinc interpolation kernels for the 4x true-peak grid.
 *
 * This is the same construction `lib/lufs.js` uses (Blackman-windowed sinc,
 * DC-normalised, 16 taps per phase): detection and measurement then look at the
 * same inter-sample positions, so the limiter is not guarding against a metric
 * that is measured differently. The limiter asks for the 8-tap variant (cheap,
 * every sample) and verifies against the 16-tap meter.
 */
function interpolationKernel (taps) {
  const cached = KERNEL_CACHE.get(taps)
  if (cached !== undefined) return cached
  const radius = taps / 2
  const phases = []
  for (let phase = 0; phase < TRUE_PEAK_OVERSAMPLE; phase += 1) {
    const offset = phase / TRUE_PEAK_OVERSAMPLE
    const kernel = new Float64Array(taps)
    let sum = 0
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = offset - (tap - (taps / 2 - 1))
      const sinc = Math.abs(distance) < 1e-9 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance)
      const position = (distance + radius) / (2 * radius)
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * position) + 0.08 * Math.cos(4 * Math.PI * position)
      kernel[tap] = sinc * window
      sum += kernel[tap]
    }
    for (let tap = 0; tap < taps; tap += 1) kernel[tap] /= sum
    phases.push(kernel)
  }
  const built = { phases, taps }
  KERNEL_CACHE.set(taps, built)
  return built
}

/**
 * Peak envelope of a channel list on the 4x grid: for every sample position,
 * the largest magnitude between it and the next sample (or the sample itself).
 *
 * Only positions whose whole interpolation window fits inside the file are
 * evaluated, exactly like the meter: extending a file past its own samples
 * invents a peak the file does not contain.
 *
 * The 8-tap convolution is unrolled because this is the one loop in the module
 * that touches every sample of every channel; the phases are visited one at a
 * time so each pass over the channel is a straight, prefetch-friendly read.
 *
 * Yields between blocks. Max-accumulation into the envelope is order-independent
 * (and exact), so splitting this pass cannot change a single envelope value.
 */
function* peakEnvelope (channels) {
  const frames = channels[0].length
  const envelope = new Float32Array(frames)
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    envelopePeakRange(channels, envelope, from, to)
    yield
  }
  const { phases } = interpolationKernel(DETECTION_TAPS)
  const first = DETECTION_TAPS / 2 - 1
  const last = frames - DETECTION_TAPS / 2 - 1
  if (last < first) return envelope
  for (const channel of channels) {
    for (let phase = 1; phase < TRUE_PEAK_OVERSAMPLE; phase += 1) {
      const kernel = phases[phase]
      for (let from = first; from <= last; from += YIELD_EVERY_FRAMES) {
        const to = Math.min(last + 1, from + YIELD_EVERY_FRAMES)
        envelopeInterpRange(channel, envelope, kernel, first, from, to)
        yield
      }
    }
  }
  return envelope
}

/** One block of the sample-magnitude envelope: every channel's worst sample wins. */
function envelopePeakRange (channels, envelope, from, to) {
  for (const channel of channels) {
    for (let i = from; i < to; i += 1) {
      const magnitude = channel[i] < 0 ? -channel[i] : channel[i]
      if (magnitude > envelope[i]) envelope[i] = magnitude
    }
  }
}

/**
 * One block of one interpolation phase over one channel.
 *
 * `from` is an absolute sample position; the 8-tap window for position `i` starts
 * at `i - first`, exactly like the single-pass loop's running `base` counter.
 */
function envelopeInterpRange (channel, envelope, kernel, first, from, to) {
  const k0 = kernel[0]
  const k1 = kernel[1]
  const k2 = kernel[2]
  const k3 = kernel[3]
  const k4 = kernel[4]
  const k5 = kernel[5]
  const k6 = kernel[6]
  const k7 = kernel[7]
  let base = from - first
  for (let i = from; i < to; i += 1) {
    const accumulator = channel[base] * k0 + channel[base + 1] * k1 + channel[base + 2] * k2 +
      channel[base + 3] * k3 + channel[base + 4] * k4 + channel[base + 5] * k5 +
      channel[base + 6] * k6 + channel[base + 7] * k7
    const magnitude = accumulator < 0 ? -accumulator : accumulator
    if (magnitude > envelope[i]) envelope[i] = magnitude
    base += 1
  }
}

/* ----------------------------------------------------------------- limiter -- */

function resolveLimiterOptions (options = {}) {
  if (options === null || typeof options !== 'object') throw new Error('limiter options must be an object')
  return {
    ceilingDbtp: numberOr(options.ceilingDbtp, -1, 'ceilingDbtp', -20, 0),
    lookaheadMs: numberOr(options.lookaheadMs, 5, 'lookaheadMs', 0.5, 20),
    releaseMs: numberOr(options.releaseMs, 120, 'releaseMs', 20, 1000)
  }
}


/** One block of the backward lookahead ramp, in descending sample order. */
function requiredGainRange (envelope, gain, ceiling, inputGain, slope, from, to, state) {
  let next = state[0]
  for (let n = to - 1; n >= from; n -= 1) {
    const peak = envelope[n] * inputGain
    const required = peak > ceiling ? ceiling / peak : 1
    const limited = required < next + slope ? required : next + slope
    gain[n] = limited
    next = limited
  }
  state[0] = next
}

/** One block of the release smoothing, in ascending sample order. */
function releaseGainRange (gain, releaseCoefficient, from, to, state) {
  let smoothed = state[0]
  for (let n = from; n < to; n += 1) {
    const target = gain[n]
    smoothed = target < smoothed ? target : smoothed + (target - smoothed) * releaseCoefficient
    gain[n] = smoothed
  }
  state[0] = smoothed
}

/**
 * Build the gain curve that holds the peak envelope under the ceiling.
 *
 * Three passes are all it takes:
 *
 * 1. Required gain: r[n] = ceiling / peak[n] (clamped to 1). Gain at sample n
 *    never exceeds r[n], so the sample and its inter-sample peak cannot exceed
 *    the ceiling.
 * 2. Lookahead ramp: a backward min-filter with a slope limit,
 *    g[n] = min(r[n], g[n+1] + 1/W). It is a true lookahead (a peak W samples
 *    ahead already lowers the gain now) and the gain can fall by at most 1/W
 *    per sample, i.e. the whole dynamic range is covered exactly over the
 *    lookahead window. This is what turns a brickwall step into an attack ramp;
 *    a step is broadband and would itself create the inter-sample peak the
 *    limiter is trying to prevent.
 * 3. Release: g may only rise at the release rate, and never above step 2's
 *    value, so the ceiling bound survives smoothing.
 *
 * `inputGainDb` folds the chain's static gain into the required-gain
 * computation. Because scaling is linear it scales the envelope exactly, which
 * lets the outer loop re-plan the curve without re-running detection.
 *
 * Both passes are order-dependent, so they are split into blocks *in their own
 * direction* (descending for the lookahead ramp, ascending for the release) with
 * the loop-carried value in a one-double state: the values written are exactly
 * those of an unsplit pass.
 */
function* limiterGainCurveGen (envelope, rate, options) {
  const ceiling = dbToGain(options.ceilingDbtp - DETECTION_GUARD_DB)
  const inputGain = dbToGain(options.inputGainDb ?? 0)
  const frames = envelope.length
  const lookahead = Math.max(1, Math.round(options.lookaheadMs * 0.001 * rate))
  const slope = 1 / lookahead
  const gain = new Float32Array(frames)
  const rampState = new Float64Array(1)
  rampState[0] = 1
  for (let to = frames; to > 0; to -= YIELD_EVERY_FRAMES) {
    const from = Math.max(0, to - YIELD_EVERY_FRAMES)
    requiredGainRange(envelope, gain, ceiling, inputGain, slope, from, to, rampState)
    yield
  }
  const releaseCoefficient = 1 - Math.exp(-1 / Math.max(1, options.releaseMs * 0.001 * rate))
  const releaseState = new Float64Array(1)
  releaseState[0] = 1
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    releaseGainRange(gain, releaseCoefficient, from, to, releaseState)
    yield
  }
  return gain
}

/** One block of the mono gain-curve application. */
function gainCurveMonoRange (source, out, curve, inputGain, from, to) {
  for (let i = from; i < to; i += 1) out[i] = source[i] * curve[i] * inputGain
}

/** One block of the linked multichannel gain-curve application. */
function gainCurveChannelsRange (channels, output, curve, inputGain, from, to) {
  for (let i = from; i < to; i += 1) {
    const gain = curve[i] * inputGain
    for (let channel = 0; channel < channels.length; channel += 1) output[channel][i] = channels[channel][i] * gain
  }
}

/** Apply one linked gain curve to a channel list, in yielded blocks. */
function* applyGainCurve (channels, curve, inputGain = 1) {
  const frames = curve.length
  if (channels.length === 1) {
    const source = channels[0]
    const out = new Float32Array(frames)
    for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
      const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
      gainCurveMonoRange(source, out, curve, inputGain, from, to)
      yield
    }
    return [out]
  }
  // One gain curve for every channel: the limiter lowers a multichannel image
  // without deforming it, because all channels are scaled by the same number at
  // every instant.
  const output = channels.map(() => new Float32Array(frames))
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    gainCurveChannelsRange(channels, output, curve, inputGain, from, to)
    yield
  }
  return output
}

/** Minimum of one block of the curve, accumulated into `state[0]`. */
function curveMinimumRange (curve, from, to, state) {
  let minimum = state[0]
  for (let i = from; i < to; i += 1) if (curve[i] < minimum) minimum = curve[i]
  state[0] = minimum
}

function* maxGainReductionDb (curve) {
  const state = new Float64Array(1)
  state[0] = 1
  for (let from = 0; from < curve.length; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(curve.length, from + YIELD_EVERY_FRAMES)
    curveMinimumRange(curve, from, to, state)
    yield
  }
  return state[0] > 0 ? -20 * Math.log10(state[0]) : 120
}

/** Sum/count of one block of the stride-16 mean-reduction sample. */
function meanReductionRange (curve, stride, from, to, state) {
  let sum = state[0]
  let count = state[1]
  for (let i = from; i < to; i += stride) {
    const value = curve[i]
    if (value < 1) sum += -20 * Math.log10(value)
    count += 1
  }
  state[0] = sum
  state[1] = count
}

/**
 * Mean gain reduction over the file (sampled every 16th value).
 *
 * This is the link between peak control and loudness: the average dB the
 * limiter takes out of the signal is a good predictor of how much loudness the
 * static gain buys, which is what lets the chain plan the next move before
 * spending a measurement on it.
 */
function* meanGainReductionDb (curve) {
  const stride = 16
  const state = new Float64Array(2)
  for (let from = 0; from < curve.length; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(curve.length, from + YIELD_EVERY_FRAMES)
    meanReductionRange(curve, stride, from, to, state)
    yield
  }
  return state[1] > 0 ? state[0] / state[1] : 0
}

/** One limiting pass; no metering, so the chain can call it per iteration. */
function* limitOnce (channels, rate, envelope, options, inputGainDb) {
  const curve = yield* limiterGainCurveGen(envelope, rate, { ...options, inputGainDb })
  const samples = yield* applyGainCurve(channels, curve, dbToGain(inputGainDb))
  const gainReductionDb = yield* maxGainReductionDb(curve)
  return { samples, gainReductionDb }
}

/* --------------------------------------------------------- multiband comp -- */

/**
 * RMS compressor for one band, stereo-linked.
 *
 * The detector is a one-pole RMS follower across the loudest channel, so a hard
 * left-panned hit ducks both channels (an unlinked detector moves the stereo
 * image). Detector and gain law run once per control block of
 * `COMPRESSOR_CONTROL_SAMPLES` samples and the gain is interpolated inside the
 * block: at 48 kHz that is a 0.17 ms attack resolution, far finer than any
 * mastering attack time, and it removes a transcendental call and a branch per
 * sample from the hot loop.
 */
/** One block of `compressBand`, aligned to the control-block grid. */
function compressBandRange (channels, coeffs, from, to, state) {
  const channelCount = channels.length
  const slope = coeffs.slope
  const makeupGain = coeffs.makeupGain
  const attackCoefficient = coeffs.attackCoefficient
  const releaseCoefficient = coeffs.releaseCoefficient
  const halfKnee = coeffs.halfKnee
  const kneeDb = coeffs.kneeDb
  const thresholdDb = coeffs.thresholdDb
  let envelope = state[0]
  let maxGainReduction = state[1]
  let previousGain = state[2]
  for (let start = from; start < to; start += COMPRESSOR_CONTROL_SAMPLES) {
    const end = start + COMPRESSOR_CONTROL_SAMPLES < to ? start + COMPRESSOR_CONTROL_SAMPLES : to
    // Block peak power across *every* channel drives one linked detector, and
    // the resulting gain is written to every channel. A per-channel detector
    // would compress a hard-panned hit only where it lands and pump the surround
    // image; one linked gain is what keeps the image still.
    let power = 0
    for (let i = start; i < end; i += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const value = channels[channel][i]
        const square = value * value
        if (square > power) power = square
      }
    }
    envelope = power > envelope
      ? envelope + (power - envelope) * attackCoefficient
      : envelope + (power - envelope) * releaseCoefficient
    const levelDb = 10 * Math.log10(envelope + 1e-18)
    const overDb = levelDb - thresholdDb
    let gainReduction = 0
    if (overDb > halfKnee) gainReduction = overDb * slope
    else if (kneeDb > 0 && overDb > -halfKnee) {
      gainReduction = slope * (overDb + halfKnee) * (overDb + halfKnee) / (2 * kneeDb)
    }
    if (gainReduction > maxGainReduction) maxGainReduction = gainReduction
    const target = makeupGain * Math.exp(-gainReduction * DB_TO_NEPER)
    const step = (target - previousGain) / (end - start)
    for (let i = start; i < end; i += 1) {
      previousGain += step
      for (let channel = 0; channel < channelCount; channel += 1) channels[channel][i] *= previousGain
    }
  }
  state[0] = envelope
  state[1] = maxGainReduction
  state[2] = previousGain
}

/**
 * RMS compressor for one band, stereo-linked, in cooperatively-yielded blocks.
 *
 * The detector is a one-pole RMS follower across the loudest channel, so a hard
 * left-panned hit ducks both channels (an unlinked detector moves the stereo
 * image). Detector and gain law run once per control block of
 * `COMPRESSOR_CONTROL_SAMPLES` samples and the gain is interpolated inside the
 * block: at 48 kHz that is a 0.17 ms attack resolution, far finer than any
 * mastering attack time, and it removes a transcendental call and a branch per
 * sample from the hot loop.
 *
 * The cooperation interval is a whole number of control blocks, so a block
 * boundary never falls inside one: the detector sees exactly the same control
 * grid an unsplit pass would.
 * @returns {Generator<unknown, number, unknown>} the maximum gain reduction, dB.
 */
function* compressBand (channels, rate, spec, kneeDb) {
  const frames = channels[0].length
  const coeffs = {
    slope: spec.ratio > 1 ? 1 - 1 / spec.ratio : 0,
    makeupGain: dbToGain(spec.makeupDb),
    attackCoefficient: 1 - Math.exp(-(COMPRESSOR_CONTROL_SAMPLES / rate) / Math.max(1e-4, spec.attackMs * 0.001)),
    releaseCoefficient: 1 - Math.exp(-(COMPRESSOR_CONTROL_SAMPLES / rate) / Math.max(1e-4, spec.releaseMs * 0.001)),
    halfKnee: kneeDb / 2,
    kneeDb,
    thresholdDb: spec.thresholdDb
  }
  const state = new Float64Array(3)
  state[2] = coeffs.makeupGain
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    compressBandRange(channels, coeffs, from, to, state)
    yield
  }
  return state[1]
}

/* --------------------------------------------------------------- presets -- */

/**
 * Default multiband setup: three bands, near-transparent ratios.
 *
 * This is the "do no harm" split used when a caller asks for the chain without
 * describing its own bands. The ratios are close to 1 and the thresholds sit
 * high enough that quiet material passes essentially untouched, so the default
 * chain's dynamics work is delegated to the limiter; a caller who wants
 * compression to shape the material passes bands (or uses a preset).
 */
const DEFAULT_BANDS = [
  { splitHz: 160, ratio: 1.3, thresholdDb: -20, attackMs: 25, releaseMs: 250, makeupDb: 0 },
  { splitHz: 2400, ratio: 1.2, thresholdDb: -24, attackMs: 12, releaseMs: 180, makeupDb: 0 },
  { ratio: 1.1, thresholdDb: -30, attackMs: 6, releaseMs: 120, makeupDb: 0 }
]

/* ---------------------------------------------------------------- exports -- */

/**
 * Split the signal into bands and compress each one independently (Linkwitz-Riley
 * 4th-order crossovers, cascaded tree), then sum them back.
 *
 * The report is the number an agent needs to judge the result: per band, the
 * maximum gain reduction in dB. A band's reduction says whether the compressor
 * touched that part of the spectrum at all, which is the difference between
 * "the low end is being controlled" and "the whole mix is just quieter".
 *
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - band list and knee.
 * @param {object[]} [options.bands] - per band `{ splitHz, ratio, thresholdDb,
 *   attackMs, releaseMs, makeupDb }`; `splitHz` is the crossover at the band's
 *   top and is ignored on the last band.
 * @param {number} [options.kneeDb=6] - soft-knee width in dB.
 * @returns {{ samples: Float32Array|Float32Array[], report: { crossover: string,
 *   kneeDb: number, bandCount: number, bands: { name: string, lo: number,
 *   hi: number, gainReductionDb: number }[] } }}
 */
export function multibandCompressor (samples, sampleRate, options = {}) {
  return driveSync(multibandCompressorGen(samples, sampleRate, options))
}

/** One block of the band-sum: copy the first band, then add the others in order. */
function sumBandsRange (sum, sample, from, to, first) {
  if (first) {
    for (let i = from; i < to; i += 1) sum[i] = sample[i]
    return
  }
  for (let i = from; i < to; i += 1) sum[i] += sample[i]
}

/**
 * Split the signal into bands and compress each one independently (Linkwitz-Riley
 * 4th-order crossovers, cascaded tree), then sum them back.
 *
 * The report is the number an agent needs to judge the result: per band, the
 * maximum gain reduction in dB. A band's reduction says whether the compressor
 * touched that part of the spectrum at all, which is the difference between
 * "the low end is being controlled" and "the whole mix is just quieter".
 *
 * Generator form: every pass over the samples (the crossover tree, the per-band
 * compressor, the band sum) yields between blocks, so the chain can stay
 * interruptible end to end. `multibandCompressor` drains it synchronously.
 *
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - band list and knee.
 * @param {object[]} [options.bands] - per band `{ splitHz, ratio, thresholdDb,
 *   attackMs, releaseMs, makeupDb }`; `splitHz` is the crossover at the band's
 *   top and is ignored on the last band.
 * @param {number} [options.kneeDb=6] - soft-knee width in dB.
 * @returns {Generator<unknown, { samples: Float32Array|Float32Array[], report: {
 *   crossover: string, kneeDb: number, bandCount: number,
 *   bands: { name: string, lo: number, hi: number, gainReductionDb: number }[] } }, unknown>}
 */
export function* multibandCompressorGen (samples, sampleRate, options = {}) {
  const rate = validateRate(sampleRate)
  const mono = !Array.isArray(samples)
  const list = asChannelList(samples)
  if (options === null || typeof options !== 'object') throw new Error('multibandCompressor options must be an object')
  const bands = resolveBands(options.bands, rate)
  const kneeDb = numberOr(options.kneeDb, 6, 'kneeDb', 0, 24)
  const frames = list[0].length
  const splits = bands.slice(0, -1).map((band) => band.hi)
  // With no split the "bands" list is the input itself, which compression would
  // then modify in place; copy it so the caller's samples stay untouched.
  const working = splits.length === 0
    ? yield* copyChannels(list)
    : sanitiseChannels(list)
  const split = yield* splitIntoBands(working, rate, splits)

  const reports = []
  for (let index = 0; index < split.length; index += 1) {
    const band = split[index]
    const gainReductionDb = yield* compressBand(band.channels, rate, bands[index], kneeDb)
    reports.push({
      name: bands[index].name,
      lo: Math.round(band.lo),
      hi: Math.round(band.hi),
      gainReductionDb: round2(gainReductionDb)
    })
  }

  // Fuse the band sum into one destination write per sample: summing band by
  // band would stream the destination three times for a three-band split.
  const bandChannels = split.map((band) => band.channels)
  const mixed = []
  for (let channel = 0; channel < list.length; channel += 1) {
    const sum = new Float32Array(frames)
    for (let band = 0; band < bandChannels.length; band += 1) {
      const source = bandChannels[band][channel]
      for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
        const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
        sumBandsRange(sum, source, from, to, band === 0)
        yield
      }
    }
    mixed.push(sum)
  }

  return {
    samples: restoreShape(mixed, mono),
    report: {
      crossover: 'linkwitz-riley-4',
      kneeDb,
      bandCount: bands.length,
      channelCount: list.length,
      bands: reports
    }
  }
}

/**
 * Boost (or soften) transients with a two-envelope gain, then boost the sustain.
 *
 * Optional in the chain — this is a creative shaper, not part of the loudness
 * search. A fast envelope (attack tracks a click within ~1 ms) compared with a
 * slow one gives a "how much is this a transient right now" signal: where the
 * fast envelope leads, the attack term adds gain; where it trails, the sustain
 * term adds gain. Both are 0..1 so the maximum lift is +6 dB minus whatever the
 * other term already added, and a bare call with both terms zero is a bit-exact
 * pass-through. The gain is applied as a wide-band envelope, so it does not
 * oversample: a very aggressive setting can raise the true peak a little, which
 * is what the limiter after it is for.
 *
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ attack, sustain }`, each 0..1; 0 is a no-op.
 * @returns {{ samples: Float32Array|Float32Array[], report: { attack: number,
 *   sustain: number, applied: boolean, maxBoostDb: number } }}
 */
export function transientShaper (samples, sampleRate, options = {}) {
  const rate = validateRate(sampleRate)
  const mono = !Array.isArray(samples)
  const list = asChannelList(samples)
  if (options === null || typeof options !== 'object') throw new Error('transientShaper options must be an object')
  const attack = numberOr(options.attack, 0, 'attack', 0, 1)
  const sustain = numberOr(options.sustain, 0, 'sustain', 0, 1)
  const output = list.map(copyChannel)
  if (attack === 0 && sustain === 0) {
    return {
      samples: restoreShape(output, mono),
      report: { attack, sustain, applied: false, maxBoostDb: 0 }
    }
  }

  const fastAttack = 1 - Math.exp(-1 / Math.max(1, 0.001 * rate))
  const fastRelease = 1 - Math.exp(-1 / Math.max(1, 0.030 * rate))
  const slowAttack = 1 - Math.exp(-1 / Math.max(1, 0.012 * rate))
  const slowRelease = 1 - Math.exp(-1 / Math.max(1, 0.180 * rate))
  const frames = list[0].length
  const channelCount = list.length
  let fast = 0
  let slow = 0
  let maxGain = 1
  for (let i = 0; i < frames; i += 1) {
    let peak = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      const magnitude = Math.abs(list[channel][i])
      if (magnitude > peak) peak = magnitude
    }
    fast = peak > fast ? fast + (peak - fast) * fastAttack : fast + (peak - fast) * fastRelease
    slow = peak > slow ? slow + (peak - slow) * slowAttack : slow + (peak - slow) * slowRelease
    const reference = slow > 1e-9 ? slow : 1e-9
    const transient = clamp((fast - slow) / reference, 0, 1)
    const decay = clamp((slow - fast) / reference, 0, 1)
    const gain = 1 + attack * transient + sustain * decay
    if (gain > maxGain) maxGain = gain
    for (let channel = 0; channel < channelCount; channel += 1) output[channel][i] *= gain
  }

  return {
    samples: restoreShape(output, mono),
    report: {
      attack,
      sustain,
      applied: true,
      maxBoostDb: round2(20 * Math.log10(maxGain))
    }
  }
}

/** One block of the L/R -> mid/side matrix, accumulating the side energy. */
function midSideRange (input, mid, side, from, to, state) {
  let sideSquaresBefore = state[0]
  for (let i = from; i < to; i += 1) {
    const leftSample = input[0][i]
    const rightSample = input[1][i]
    mid[i] = (leftSample + rightSample) * 0.5
    side[i] = (leftSample - rightSample) * 0.5
    sideSquaresBefore += side[i] * side[i]
  }
  state[0] = sideSquaresBefore
}

/** One block of the width matrix and the mono-safety measurements. */
function widthRange (input, mid, shaped, left, right, width, from, to, state) {
  let maxMonoError = state[0]
  let monoScale = state[1]
  let sideSquaresAfter = state[2]
  let crossLeft = state[3]
  let crossRight = state[4]
  let energyLeft = state[5]
  let energyRight = state[6]
  for (let i = from; i < to; i += 1) {
    const scaled = shaped[i] * width
    const outLeft = mid[i] + scaled
    const outRight = mid[i] - scaled
    left[i] = outLeft
    right[i] = outRight
    const sideAfter = (outLeft - outRight) * 0.5
    sideSquaresAfter += sideAfter * sideAfter
    const sampleLeft = input[0][i]
    const sampleRight = input[1][i]
    const monoOriginal = Math.abs(sampleLeft + sampleRight)
    if (monoOriginal > monoScale) monoScale = monoOriginal
    const monoError = Math.abs(outLeft + outRight - sampleLeft - sampleRight)
    if (monoError > maxMonoError) maxMonoError = monoError
    crossLeft += sampleLeft * outLeft
    crossRight += sampleRight * outRight
    energyLeft += sampleLeft * sampleLeft
    energyRight += sampleRight * sampleRight
  }
  state[0] = maxMonoError
  state[1] = monoScale
  state[2] = sideSquaresAfter
  state[3] = crossLeft
  state[4] = crossRight
  state[5] = energyLeft
  state[6] = energyRight
}

/**
 * Mid/side stereo width with optional bass mono-folding.
 *
 * Width scales the side signal; the mid is untouched, so the mono fold-down
 * (L + R) is preserved exactly and the result stays mono-safe. Below
 * `bassMonoHz` the side is high-passed with a Linkwitz-Riley 4th order, which
 * removes the side's low content and therefore folds everything under the
 * corner to the centre without losing it — the standard fix for a wide synth
 * bass that cancels on a phone speaker. The report proves the promise rather
 * than asserting it: it measures the mono sum error and the polarity of each
 * channel against its input.
 *
 * A mono input has no side signal to widen; it is returned unchanged with
 * `applied: false` (inventing a stereo image from a mono source is a creative
 * decision, not a mastering one). A 4/6/8-channel input is returned unchanged
 * for the same reason in the other direction: mid/side is a matrix on one
 * stereo pair, and which pair of a surround layout it should touch is not a
 * decision a preset gets to make. The report says the stage was bypassed.
 *
 * Synchronous wrapper around `stereoWidthGen` (see that generator for the
 * cooperation points).
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ width, bassMonoHz }`; width 0 = mono, 1 =
 *   unchanged, 1.5 = wider, up to 2. `bassMonoHz` 0 disables bass mono.
 * @returns {{ samples: Float32Array|Float32Array[], report: { width: number,
 *   bassMonoHz: number, mode: string, applied: boolean, channelCount: number,
 *   sideEnergyBeforeDb: number, sideEnergyAfterDb: number, monoSumPreserved: boolean,
 *   polarityPreserved: boolean, monoSafe: boolean } }}
 */
export function stereoWidth (samples, sampleRate, options = {}) {
  return driveSync(stereoWidthGen(samples, sampleRate, options))
}

/**
 * Generator form of the width stage: the matrix passes yield between blocks.
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ width, bassMonoHz }`.
 * @returns {Generator<unknown, { samples: Float32Array|Float32Array[], report: object }, unknown>}
 */
export function* stereoWidthGen (samples, sampleRate, options = {}) {
  const rate = validateRate(sampleRate)
  const mono = !Array.isArray(samples)
  const list = asChannelList(samples)
  if (options === null || typeof options !== 'object') throw new Error('stereoWidth options must be an object')
  const width = numberOr(options.width, 1, 'width', 0, 2)
  const bassMonoHz = numberOr(options.bassMonoHz, 120, 'bassMonoHz', 0, 800)
  const input = sanitiseChannels(list)

  if (input.length > 2) {
    return {
      samples: restoreShape(input.map(copyChannel), mono),
      report: {
        width: 1,
        bassMonoHz,
        mode: 'multichannel',
        applied: false,
        channelCount: input.length,
        sideEnergyBeforeDb: -120,
        sideEnergyAfterDb: -120,
        monoSumPreserved: true,
        polarityPreserved: true,
        monoSafe: true,
        note: `width is a mid/side matrix on a stereo pair; a ${input.length}-channel input is passed through unchanged`
      }
    }
  }

  if (input.length < 2) {
    return {
      samples: restoreShape(input.map(copyChannel), mono),
      report: {
        width: 1,
        bassMonoHz,
        mode: 'mono',
        applied: false,
        channelCount: 1,
        sideEnergyBeforeDb: -120,
        sideEnergyAfterDb: -120,
        monoSumPreserved: true,
        polarityPreserved: true,
        monoSafe: true
      }
    }
  }

  const frames = input[0].length
  const mid = new Float32Array(frames)
  const side = new Float32Array(frames)
  const matrixState = new Float64Array(1)
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    midSideRange(input, mid, side, from, to, matrixState)
    yield
  }
  const sideSquaresBefore = matrixState[0]

  let shaped = side
  if (bassMonoHz > 0) {
    // Bass mono is a high-pass of the side signal: below the corner the side is
    // gone, so L and R share the same low content and fold to mono. Subtracting
    // a low-pass from the side would not do this — an LR4 low-pass shifted in
    // phase leaves a residual that can be *louder* than the original side at the
    // corner, which is the opposite of mono bass.
    shaped = yield* lr4Pass(side, rate, bassMonoHz, true)
  }

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const widthState = new Float64Array(7)
  for (let from = 0; from < frames; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(frames, from + YIELD_EVERY_FRAMES)
    widthRange(input, mid, shaped, left, right, width, from, to, widthState)
    yield
  }
  const maxMonoError = widthState[0]
  const monoScale = widthState[1]
  const sideSquaresAfter = widthState[2]
  const crossLeft = widthState[3]
  const crossRight = widthState[4]
  const energyLeft = widthState[5]
  const energyRight = widthState[6]
  const monoSumPreserved = maxMonoError <= Math.max(1e-5, monoScale * 1e-5)
  const denominator = Math.sqrt(energyLeft * energyRight)
  const polarityPreserved = denominator > 0 ? (crossLeft >= 0 && crossRight >= 0) : true
  const sideDbBefore = sideSquaresBefore > 0 ? 10 * Math.log10(sideSquaresBefore / frames) : -120
  const sideDbAfter = sideSquaresAfter > 0 ? 10 * Math.log10(sideSquaresAfter / frames) : -120

  return {
    samples: restoreShape([left, right], mono),
    report: {
      width,
      bassMonoHz,
      mode: 'stereo',
      applied: true,
      channelCount: 2,
      sideEnergyBeforeDb: round2(sideDbBefore),
      sideEnergyAfterDb: round2(sideDbAfter),
      monoSumPreserved,
      polarityPreserved,
      monoSafe: monoSumPreserved && polarityPreserved
    }
  }
}

/**
 * Lookahead true-peak limiter.
 *
 * Detection is 4x oversampled (see `peakEnvelope`), the gain curve is the
 * slope-limited lookahead ramp described on `limiterGainCurveGen`, and the result
 * is then *measured* with `lib/lufs.js`'s `truePeak` — the same meter the rest
 * of the plugin reports. If the measurement is above the ceiling (an 8-tap
 * detector can under-read near-Nyquist content by a fraction of a dB), the
 * whole file is trimmed by the exact ratio and measured again, so the promise
 * is "measured true peak <= ceiling", not "the curve says so".
 *
 * Trimming scales linearly, which lowers true peak by exactly the trim amount;
 * that is why one correction is enough and why the reported true peak is a real
 * measurement rather than a prediction.
 *
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ ceilingDbtp, lookaheadMs, releaseMs }`.
 * @returns {{ samples: Float32Array|Float32Array[], report: { ceilingDbtp: number,
 *   lookaheadMs: number, releaseMs: number, oversample: number, detectionTaps: number,
 *   verifiedTaps: number, detectionGuardDb: number, maxGainReductionDb: number,
 *   trimDb: number, truePeakBeforeDbtp: number, truePeakAfterDbtp: number,
 *   truePeakChannel: number, truePeakByChannelDbtp: number[], channelCount: number,
 *   overshootDb: number } }}
 */
export function truePeakLimiter (samples, sampleRate, options = {}) {
  return driveSync(truePeakLimiterGen(samples, sampleRate, options))
}

/**
 * Generator form of the lookahead true-peak limiter: detection, the gain curve,
 * the gain application and the trim all yield between blocks.
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ ceilingDbtp, lookaheadMs, releaseMs }`.
 * @returns {Generator<unknown, { samples: Float32Array|Float32Array[], report: object }, unknown>}
 */
export function* truePeakLimiterGen (samples, sampleRate, options = {}) {
  const rate = validateRate(sampleRate)
  const mono = !Array.isArray(samples)
  const list = asChannelList(samples)
  const settings = resolveLimiterOptions(options)
  const input = sanitiseChannels(list)
  const truePeakBefore = measuredTruePeak(input, rate)
  const envelope = yield* peakEnvelope(input)
  const pass = yield* limitOnce(input, rate, envelope, settings, 0)
  const output = pass.samples

  let trimDb = 0
  let truePeakAfter = measuredTruePeak(output, rate)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // `measuredTruePeak` is the worst of every channel, so a hot surround is
    // caught by the same trim as a hot front. A linear trim lowers the true peak
    // by exactly its dB value on every channel, so one correction per attempt is
    // enough and the reported number stays a real measurement.
    if (!Number.isFinite(truePeakAfter.dbtp) || truePeakAfter.dbtp <= settings.ceilingDbtp) break
    const correction = settings.ceilingDbtp - TRIM_MARGIN_DB - truePeakAfter.dbtp
    trimDb += correction
    yield* scaleChannels(output, dbToGain(correction))
    truePeakAfter = measuredTruePeak(output, rate)
  }

  return {
    samples: restoreShape(output, mono),
    report: {
      ceilingDbtp: settings.ceilingDbtp,
      lookaheadMs: settings.lookaheadMs,
      releaseMs: settings.releaseMs,
      oversample: TRUE_PEAK_OVERSAMPLE,
      detectionTaps: DETECTION_TAPS,
      verifiedTaps: METER_TAPS,
      detectionGuardDb: DETECTION_GUARD_DB,
      maxGainReductionDb: round2(pass.gainReductionDb),
      trimDb: round3(trimDb),
      channelCount: output.length,
      truePeakBeforeDbtp: round3(truePeakBefore.dbtp),
      truePeakAfterDbtp: round3(truePeakAfter.dbtp),
      truePeakChannel: truePeakAfter.channel,
      truePeakByChannelDbtp: truePeakAfter.byChannel.map((value) => round3(value)),
      overshootDb: round3(Math.max(0, truePeakAfter.dbtp - settings.ceilingDbtp))
    }
  }
}

/* ------------------------------------------------------------- master chain -- */

/**
 * What `mode: 'fast'` can keep alive, and the warning that size earns.
 *
 * One attempt is `channelCount * frames` Float32 samples — the output of
 * `applyGainCurve` for the whole file — so the retained set is one copy of the
 * deliverable per iteration, up to the iteration cap: a 180 s / 48 kHz stereo
 * master is ~69 MB per attempt and ~345 MB at five attempts, against ~69 MB for
 * `memory` mode's single re-rendered output. `attempts` here is that worst-case
 * cap (not how many iterations a particular file happened to run), because the
 * memory has to be held while the search is still going. The rest of the chain's
 * working set (the pre-mastered buffer and the peak envelope) is the same in
 * both modes and is not counted here.
 *
 * Exported because the number is the only thing the two modes disagree about:
 * a test asserts this estimate (and the warning threshold) directly, which is
 * cheaper and more precise than watching RSS.
 *
 * @param {number} frames - samples per channel.
 * @param {number} channelCount - retained channels.
 * @param {number} attempts - attempt buffers that can be alive at once (the cap).
 * @param {number} sampleRate - Hz, only used for the readable duration.
 * @returns {{ frames: number, channelCount: number, attempts: number, bytes: number,
 *   megabytes: number, oneAttemptBytes: number, oneAttemptMegabytes: number,
 *   warnings: string[] }}
 */
export function fastModeFootprint (frames, channelCount, attempts, sampleRate) {
  const oneAttemptBytes = frames * channelCount * Float32Array.BYTES_PER_ELEMENT
  const bytes = oneAttemptBytes * attempts
  const megabytes = Math.round((bytes / 1e6) * 10) / 10
  const oneAttemptMegabytes = Math.round((oneAttemptBytes / 1e6) * 10) / 10
  const seconds = sampleRate > 0 ? Math.round((frames / sampleRate) * 10) / 10 : 0
  const warnings = []
  if (bytes >= FAST_MODE_WARN_BYTES || seconds >= FAST_MODE_WARN_SECONDS) {
    warnings.push(`fast mode can hold up to ${attempts} attempt buffer(s) of this ${seconds}s ${channelCount}-channel master (~${megabytes} MB, one attempt ~${oneAttemptMegabytes} MB) while mode:'memory' holds the output once (~${oneAttemptMegabytes} MB) and re-renders it. The output bytes and every reported number are identical either way — this is a memory cost only.`)
  }
  return {
    frames,
    channelCount,
    attempts,
    bytes,
    megabytes,
    oneAttemptBytes,
    oneAttemptMegabytes,
    warnings
  }
}

function resolveChainOptions (options, rate) {
  if (options === null || typeof options !== 'object') throw new Error('masterChain options must be an object')
  return {
    mode: resolveMasterMode(options.mode),
    targetLufs: numberOr(options.targetLufs, -14, 'targetLufs', -45, 0),
    ceilingDbtp: numberOr(options.ceilingDbtp, -1, 'ceilingDbtp', -20, 0),
    bands: resolveBands(options.bands, rate),
    width: numberOr(options.width, 1, 'width', 0, 2),
    bassMonoHz: numberOr(options.bassMonoHz, 120, 'bassMonoHz', 0, 800),
    driveDb: numberOr(options.driveDb, 0, 'driveDb', -24, 24),
    kneeDb: numberOr(options.kneeDb, 6, 'kneeDb', 0, 24),
    lookaheadMs: numberOr(options.lookaheadMs, 5, 'lookaheadMs', 0.5, 20),
    releaseMs: numberOr(options.releaseMs, 120, 'releaseMs', 20, 1000),
    maxGainReductionDb: numberOr(options.maxGainReductionDb, 12, 'maxGainReductionDb', 0, 30),
    maxIterations: Math.round(numberOr(options.maxIterations, 5, 'maxIterations', 1, 8))
  }
}

/**
 * Offset and clamp a gain so the resulting limiter curve stays inside the
 * allowed gain-reduction budget.
 *
 * The limiter's gain reduction is monotone in the input gain, and near the cap
 * the two move one for one, so subtracting the overshoot lands within a few
 * tenths of a dB in one pass; the loop repeats because band-limited material
 * can have a shallower slope than 1. This is all curve arithmetic (no audio
 * pass, no measurement), which is why the chain can afford it before every
 * iteration.
 */
function* settleGainUnderCap (envelope, rate, settings, gainDb) {
  let gain = gainDb
  let curve = yield* limiterGainCurveGen(envelope, rate, { ...settings, inputGainDb: gain })
  let reduction = yield* maxGainReductionDb(curve)
  for (let attempt = 0; attempt < 8 && reduction > settings.maxGainReductionDb + 0.01; attempt += 1) {
    gain = Math.max(GAIN_LIMITS_DB[0], gain - (reduction - settings.maxGainReductionDb) - 0.15)
    curve = yield* limiterGainCurveGen(envelope, rate, { ...settings, inputGainDb: gain })
    reduction = yield* maxGainReductionDb(curve)
  }
  return {
    curve,
    gainDb: gain,
    gainReductionDb: reduction,
    // "At the cap" is deliberately not "exactly the cap": the settle loop stops
    // a fraction of a dB short so the curve never exceeds the budget, and the
    // difference between 11.9 and 12 dB of reduction is not a decision point.
    atCap: reduction >= settings.maxGainReductionDb - 0.5
  }
}

function selectAttempt (attempts, targetLufs) {
  let best = attempts[attempts.length - 1]
  let bestError = Math.abs(best.lufs - targetLufs)
  for (const attempt of attempts) {
    const error = Math.abs(attempt.lufs - targetLufs)
    if (error < bestError) {
      best = attempt
      bestError = error
    }
  }
  return best
}

/**
 * Plan the gain that should hit the target, using the measured residual.
 *
 * A limiter makes loudness a compressed function of gain, so the naive
 * "target - measured" step overshoots and the secant needs two measured points
 * to learn the slope — one measurement more than the budget really has. The
 * limiter's own gain reduction predicts that loss for free. It sits between the
 * *mean* reduction over the file (what happens to the quiet parts) and the
 * *maximum* reduction (what happens to the peaks); because loudness is an RMS
 * measure it is dominated by the loud passages, and half way between the two
 * tracks the measured loss closely on both sparse and dense material:
 *
 *   lufs(g) ~= lufsBefore + g - (meanGainReduction(g) + maxGainReduction(g)) / 2 + residual
 *
 * where `residual` is the part the model does not explain (compressor level
 * change, the trim, kernel bias), measured from the first real attempt. Solving
 * for g is a fixed-point iteration over a decimated copy of the peak envelope,
 * so it costs a handful of milliseconds instead of a metering pass; the
 * measured attempt that follows confirms it, or the chain falls back to the
 * measured secant.
 */
/** Peak of one decimated block of the envelope (see `predictGainForTarget`). */
function decimateEnvelopeRange (envelope, decimated, stride, from, to) {
  let block = from / stride
  for (let i = from; i < to; i += stride, block += 1) {
    let peak = 0
    const end = Math.min(i + stride, envelope.length)
    for (let j = i; j < end; j += 1) if (envelope[j] > peak) peak = envelope[j]
    decimated[block] = peak
  }
}

function* predictGainForTarget (envelope, rate, settings, lufsBefore, residual) {
  const stride = 8
  const decimated = new Float32Array(Math.ceil(envelope.length / stride))
  for (let from = 0; from < envelope.length; from += YIELD_EVERY_FRAMES) {
    const to = Math.min(envelope.length, from + YIELD_EVERY_FRAMES)
    decimateEnvelopeRange(envelope, decimated, stride, from, to)
    yield
  }
  // The lookahead is a sample count and the release is a per-sample coefficient,
  // so both time constants must be scaled by the decimation stride for the
  // decimated curve to describe the same limiter in real time.
  const decimatedSettings = {
    ...settings,
    lookaheadMs: settings.lookaheadMs / stride,
    releaseMs: settings.releaseMs / stride
  }
  let gain = clamp(settings.targetLufs - lufsBefore - residual, GAIN_LIMITS_DB[0], GAIN_LIMITS_DB[1])
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const settled = yield* settleGainUnderCap(decimated, rate, decimatedSettings, gain)
    const loss = ((yield* meanGainReductionDb(settled.curve)) + settled.gainReductionDb) / 2
    const predicted = lufsBefore + settled.gainDb - loss + residual
    const error = settings.targetLufs - predicted
    if (Math.abs(error) <= 0.02) return settled.gainDb
    if (Math.abs(error) <= 0.02) return settled.gainDb
    gain = clamp(settled.gainDb + error, GAIN_LIMITS_DB[0], GAIN_LIMITS_DB[1])
  }
  return gain
}

/**
 * Master a cue onto a loudness target without ever clipping.
 *
 * The chain is fixed once and the search only moves the gain: drive into the
 * multiband compressor (its thresholds are absolute dBFS, so the drive knob is
 * what decides how hard it works), width/bass-mono, then gain and limiter. The
 * compressor and width stages are level-independent in structure, so they run
 * once and every iteration re-plans the limiter curve over the cached peak
 * envelope — an iteration costs one limiter apply plus one loudness
 * measurement, not a full re-render.
 *
 * Iteration: pick a gain, settle it under the gain-reduction budget, limit,
 * measure. The next gain comes from the measured response (secant on the last
 * two attempts) because a limiter makes loudness a compressed function of gain:
 * a naive "+error dB" overshoots and oscillates on hot material. The loop stops
 * when the target is inside +/-0.3 LU, when the gain-reduction budget is the
 * limit, or when the iteration cap is reached — and in the last two cases it
 * says so instead of clipping: the output is the loudest attempt that respected
 * both the ceiling and the budget, and the report carries the shortfall.
 *
 * Memory: an attempt is a handful of scalars (gain, LUFS, true peak, trim,
 * gain reduction), not the rendered buffer. The winning gain is re-rendered
 * once after the search, so a master holds one output buffer instead of
 * `maxIterations` copies of it — the difference between ~69 MB and ~345 MB of
 * attempt storage for the documented 180 s / 48 kHz stereo maximum. That is
 * the `mode: 'memory'` path. `mode: 'fast'` is the opposite trade: every
 * attempt's channel list is kept, so the winner is returned without the extra
 * limiter pass (~10 % of a search), at one output buffer per iteration. The two
 * modes run the same arithmetic in the same order and are byte-identical; only
 * the memory and the number of limiter passes differ, and the report says which
 * one ran (`mode` + `modeNote`).
 *
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ targetLufs, ceilingDbtp, bands, width,
 *   bassMonoHz, driveDb }` plus `kneeDb`, `lookaheadMs`, `releaseMs`,
 *   `maxGainReductionDb` (default 12), `maxIterations` (default 5) and `mode`
 *   (`'memory'` default, or `'fast'`).
 * @returns {{ samples: Float32Array|Float32Array[],
 *   report: { mode: string, modeNote: string, warnings: string[],
 *   lufsBefore: number, lufsAfter: number, truePeakBefore: number,
 *   truePeakAfter: number, truePeakChannel: number, truePeakByChannelDbtp: number[],
 *   channelCount: number, channelLayout: string, channelPeaksDbfs: number[],
 *   gainReductionDb: number, bands: object[], iterations: number,
 *   achievable: boolean, shortfallLu: number, limitedBy: string } }}
 */
export function masterChain (samples, sampleRate, options = {}) {
  return driveSync(masterChainGen(samples, sampleRate, options))
}

/**
 * Master without holding the event loop for the whole chain.
 *
 * Same generator, same arithmetic, same bytes as `masterChain`; every block
 * boundary also waits for a `setImmediate`. One gap remains, honestly: the
 * loudness meter (`lib/lufs.js`, not owned by this change) is a single atomic
 * pass, so the longest uninterruptible stretch is one metering pass per
 * iteration.
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - see `masterChain`.
 * @returns {Promise<{ samples: Float32Array|Float32Array[], report: object }>}
 */
export function masterChainAsync (samples, sampleRate, options = {}) {
  return driveAsync(masterChainGen(samples, sampleRate, options))
}

/**
 * Cooperatively-yielded form of `masterChain`.
 *
 * Every pass over the samples that this module owns yields between blocks
 * (`copyChannels`, the multiband compressor, the width stage, the peak envelope,
 * the limiter curve, the gain application and every meter loop). The loudness
 * measurement itself is `lib/lufs.js`'s `analyzeLoudness`, which is one atomic
 * pass in a module this change does not own: `audio_master` therefore still has
 * a per-iteration gap the length of one loudness measurement, and says so.
 *
 * The arithmetic is the synchronous chain's: the same calls in the same order,
 * with only `await` points inserted between blocks.
 * @param {Float32Array|Float32Array[]} samples - mono buffer or one per channel.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - see `masterChain`.
 * @returns {Generator<unknown, { samples: Float32Array|Float32Array[], report: object }, unknown>}
 */
export function* masterChainGen (samples, sampleRate, options = {}) {
  const rate = validateRate(sampleRate)
  const mono = !Array.isArray(samples)
  const list = asChannelList(samples)
  const settings = resolveChainOptions(options, rate)
  // Diagnostics only; `readTelemetry` returns null unless a caller injected one.
  const telemetry = readTelemetry(options.telemetry)
  if (telemetry !== null) {
    telemetry.mode = settings.mode
    telemetry.limiterApplies = 0
    telemetry.retainedAttemptBuffers = 0
    telemetry.rerenderedPasses = 0
    telemetry.retainedBytes = 0
  }
  const source = yield* copyChannels(list)
  const before = analyseChannels(source, rate)
  const lufsBefore = before.integratedLufs
  const loudness = loudnessChannels(source)
  const layout = layoutFor(source.length)
  // The ceiling is a property of the whole file, LFE included: a hot LFE channel
  // is a clipped file even though it is not part of the loudness measure. For
  // mono/stereo, `analyzeLoudness` already measured the pair's worst channel, so
  // no second pass is needed; a surround layout needs the all-channel scan
  // because the loudness measurement legitimately skips LFE.
  const surround = source.length > 2
  const truePeakBefore = surround
    ? measuredTruePeak(source, rate)
    : {
        dbtp: before.truePeakDbtp,
        channel: source.length === 1 ? 0 : null,
        byChannel: source.length === 1 ? [before.truePeakDbtp] : null
      }

  // --- fixed front of the chain: drive, compression, width ------------------
  linkStemGain(source, settings.driveDb)
  const compression = yield* multibandCompressorGen(source, rate, { bands: settings.bands, kneeDb: settings.kneeDb })
  yield
  const width = yield* stereoWidthGen(compression.samples, rate, { width: settings.width, bassMonoHz: settings.bassMonoHz })
  const preMastered = asChannelList(width.samples)
  const compressorGainReductionDb = compression.report.bands.reduce(
    (maximum, band) => (band.gainReductionDb > maximum ? band.gainReductionDb : maximum), 0)

  const baseReport = {
    // Which memory/time trade ran, and what it means: the two modes differ in
    // nothing else, so a caller that sees "fast" in a report knows the bytes are
    // the same as "memory" and the cost was RAM, not a different result.
    mode: settings.mode,
    modeNote: MODE_NOTES[settings.mode],
    warnings: [],
    targetLufs: round2(settings.targetLufs),
    ceilingDbtp: round2(settings.ceilingDbtp),
    lufsBefore: round3(lufsBefore),
    truePeakBefore: round3(truePeakBefore.dbtp),
    truePeakChannelBefore: truePeakBefore.channel,
    gainReductionDb: 0,
    bands: compression.report.bands,
    iterations: 0,
    crossover: compression.report.crossover,
    compressorGainReductionDb: round2(compressorGainReductionDb),
    appliedGainDb: 0,
    trimDb: 0,
    driveDb: round2(settings.driveDb),
    width: width.report.width,
    widthApplied: width.report.applied,
    widthNote: width.report.note ?? null,
    bassMonoHz: width.report.bassMonoHz,
    channelCount: source.length,
    channelLayout: layout.id,
    channelNames: [...layout.names],
    /** How many channels the loudness meter used: LFE is not one of them. */
    loudnessChannels: loudness.measured.length,
    lfeExcluded: loudness.lfeExcluded,
    maxGainReductionDb: round2(settings.maxGainReductionDb),
    detectionGuardDb: DETECTION_GUARD_DB,
    lufsTolerance: TARGET_TOLERANCE_LU
  }

  if (!Number.isFinite(lufsBefore)) {
    // No loudness to move: a gain derived from -infinity is meaningless, so the
    // chain hands back the shaped silence instead of inventing a number.
    return {
      samples: restoreShape(preMastered, mono),
      report: {
        ...baseReport,
        lufsAfter: Number.NEGATIVE_INFINITY,
        truePeakAfter: Number.NEGATIVE_INFINITY,
        truePeakChannel: -1,
        truePeakByChannelDbtp: [],
        channelPeaksDbfs: [],
        achievable: false,
        shortfallLu: Number.POSITIVE_INFINITY,
        limitedBy: 'silence'
      }
    }
  }

  const envelope = yield* peakEnvelope(preMastered)
  const boundedBefore = clamp(settings.targetLufs - lufsBefore, GAIN_LIMITS_DB[0], GAIN_LIMITS_DB[1])
  let gainDb = boundedBefore
  const attempts = []
  let achieved = false

  for (let round = 1; round <= settings.maxIterations; round += 1) {
    // The planned gain is what the settle loop is fed; keeping it (a scalar) is
    // what lets the chosen iteration be re-rendered bit-identically at the end
    // instead of every iteration's samples being kept alive.
    const plannedGainDb = gainDb
    const settled = yield* settleGainUnderCap(envelope, rate, settings, plannedGainDb)
    gainDb = settled.gainDb
    const limited = yield* applyGainCurve(preMastered, settled.curve, dbToGain(gainDb))
    noteTelemetry(telemetry, 'limiterApplies')
    // Loudness is measured by `lib/lufs.js` in one indivisible pass; the chain
    // yields on both sides of it rather than trying to split a meter it does not
    // own.
    yield
    const analysis = analyseChannels(limited, rate)
    // `analyzeLoudness` already measured the true peak of every channel it used,
    // and for mono/stereo that is every channel — measuring it a second time in
    // the hot search loop would buy nothing and cost a true-peak pass per
    // iteration. A surround master gets the explicit all-channel scan because
    // the loudness meter skips LFE.
    const peakMeasured = surround ? measuredTruePeak(limited, rate) : null
    const peakDbtp = peakMeasured === null ? analysis.truePeakDbtp : peakMeasured.dbtp

    // The limiter promises the *sample* grid plus a detection guard; the meter
    // is the authority, and a linear trim is an exact correction.
    let trimDb = 0
    if (Number.isFinite(peakDbtp) && peakDbtp > settings.ceilingDbtp) {
      trimDb = settings.ceilingDbtp - TRIM_MARGIN_DB - peakDbtp
      yield* scaleChannels(limited, dbToGain(trimDb))
    }
    const lufsAfter = analysis.integratedLufs + trimDb
    const truePeakAfter = Number.isFinite(peakDbtp) ? peakDbtp + trimDb : Number.NEGATIVE_INFINITY
    const error = settings.targetLufs - lufsAfter
    const meanReductionDb = yield* meanGainReductionDb(settled.curve)
    const attempt = {
      plannedGainDb,
      gainDb,
      lufs: lufsAfter,
      truePeak: truePeakAfter,
      truePeakChannel: peakMeasured === null ? (source.length === 1 ? 0 : null) : peakMeasured.channel,
      truePeakByChannel: peakMeasured === null
        ? (source.length === 1 ? [truePeakAfter] : null)
        : peakMeasured.byChannel.map((value) => value + trimDb),
      channelPeaksDbfs: yield* samplePeaksDbfs(limited),
      trimDb,
      gainReductionDb: settled.gainReductionDb,
      atCap: settled.atCap
    }
    // `memory` (default): only measurements and scalars are kept per iteration.
    // A 180 s stereo deliverable is ~69 MB per channel list, so holding one per
    // attempt would be five copies of the whole output (hundreds of MB) to
    // ultimately use one; the winning iteration is re-rendered from
    // `plannedGainDb` after selection.
    //
    // `fast`: the pre-refactor behaviour — keep the rendered attempt so the
    // selected one needs no second limiter pass. The buffer already carries this
    // iteration's trim, because the trim was applied to this very buffer above,
    // which is what makes the two paths bit-identical.
    if (settings.mode === 'fast') {
      attempt.samples = limited
      noteTelemetry(telemetry, 'retainedAttemptBuffers')
    }
    attempts.push(attempt)

    if (Math.abs(error) <= TARGET_TOLERANCE_LU) {
      achieved = true
      break
    }
    // At the budget there is nothing left to give: more gain would only mean
    // more limiting than the chain is willing to apply.
    if (settled.atCap && error > 0) break

    // Next move. The first round plans the gain from the limiter loss model;
    // later rounds have two measured points and use a secant step, which
    // handles whatever the model could not explain.
    let nextGain
    if (attempts.length === 1) {
      // Residual of the same loss model the predictor uses, measured on the one
      // real attempt the chain has: the model itself is not assumed exact.
      const modelLoss = (meanReductionDb + settled.gainReductionDb) / 2
      const residual = lufsAfter - (lufsBefore + gainDb - modelLoss)
      nextGain = yield* predictGainForTarget(envelope, rate, settings, lufsBefore, residual)
    } else {
      const previous = attempts[attempts.length - 2]
      const gainDelta = gainDb - previous.gainDb
      let step = error / 0.7
      if (Math.abs(gainDelta) > 1e-6) {
        // The loudness-vs-gain curve is concave (each further dB of gain buys
        // less loudness once the limiter is working), so the secant's slope is
        // steeper than the local one by the time the correction is applied; a
        // small over-relaxation lands on the target instead of one step short.
        const slope = clamp((lufsAfter - previous.lufs) / gainDelta, 0.1, 1.2)
        step = (error / slope) * SECANT_OVER_RELAXATION
      }
      nextGain = gainDb + step
    }
    nextGain = clamp(nextGain, GAIN_LIMITS_DB[0], GAIN_LIMITS_DB[1])
    if (Math.abs(nextGain - gainDb) < 0.05) break
    gainDb = nextGain
  }

  const chosen = selectAttempt(attempts, settings.targetLufs)
  const hitTarget = Math.abs(chosen.lufs - settings.targetLufs) <= TARGET_TOLERANCE_LU

  let output
  if (settings.mode === 'fast') {
    // The retained attempt is the answer: same samples, one limiter pass less.
    output = chosen.samples
  } else {
    // Re-render the winning iteration. `settleGainUnderCap` is deterministic in
    // (envelope, rate, settings, planned gain) and every attempt stored the exact
    // planned gain it was called with, so this computes the same curve and the
    // same trim the pass that produced `chosen`'s measurements computed: the
    // samples are bit-identical to keeping each iteration's output, at one
    // output's worth of memory instead of `iterations` copies.
    const settledChosen = yield* settleGainUnderCap(envelope, rate, settings, chosen.plannedGainDb)
    output = yield* applyGainCurve(preMastered, settledChosen.curve, dbToGain(settledChosen.gainDb))
    noteTelemetry(telemetry, 'limiterApplies')
    noteTelemetry(telemetry, 'rerenderedPasses')
    if (chosen.trimDb !== 0) yield* scaleChannels(output, dbToGain(chosen.trimDb))
  }

  // Cost of the mode that ran. `memory` holds one output, so it needs no
  // estimate; `fast` can hold one per attempt until the cap, and past a point
  // that is worth saying out loud instead of silently taking the RAM.
  const footprint = settings.mode === 'fast'
    ? fastModeFootprint(source[0].length, source.length, settings.maxIterations, rate)
    : null
  if (telemetry !== null && footprint !== null) {
    telemetry.retainedBytes = footprint.oneAttemptBytes * attempts.length
  }

  return {
    samples: restoreShape(output, mono),
    report: {
      ...baseReport,
      warnings: footprint === null ? [] : footprint.warnings,
      lufsAfter: round3(chosen.lufs),
      truePeakAfter: round3(chosen.truePeak),
      // The ceiling promise is about every channel: name the one that is closest
      // to it and report all of them when they were measured separately, so a
      // surround deliverable can be checked without decoding it again.
      truePeakChannel: chosen.truePeakChannel,
      truePeakByChannelDbtp: chosen.truePeakByChannel === null
        ? null
        : chosen.truePeakByChannel.map((value) => round3(value)),
      channelPeaksDbfs: chosen.channelPeaksDbfs,
      gainReductionDb: round2(chosen.gainReductionDb),
      appliedGainDb: round2(chosen.gainDb),
      trimDb: round3(chosen.trimDb),
      iterations: attempts.length,
      achievable: hitTarget,
      shortfallLu: hitTarget ? 0 : round2(Math.max(0, settings.targetLufs - chosen.lufs)),
      lufsErrorLu: round2(chosen.lufs - settings.targetLufs),
      limitedBy: hitTarget ? 'target' : (chosen.atCap ? 'true-peak' : 'iterations')
    }
  }
}

/**
 * Named mastering presets: defensible starting points, not magic.
 *
 * The numbers follow the published delivery targets: streaming services
 * normalise to -14 LUFS and lossy encoders need about 1 dB of true-peak
 * headroom (AES TD1004), EBU R128 broadcast is -23 LUFS at <= -1 dBTP, Apple
 * Podcasts is -16 LUFS at <= -1 dBTP. `streaming-loud` deliberately sits above
 * the -14 normalisation target: that is where loud commercial masters live, and
 * a normaliser turns the extra level back down — the reason to use it is the
 * *compression character*, not a louder playback.
 *
 * Every preset returns a fresh object, so a caller may mutate its bands.
 *
 * @returns {Record<string, { description: string, targetLufs: number,
 *   ceilingDbtp: number, bands: object[], width: number, bassMonoHz: number,
 *   driveDb: number, maxGainReductionDb: number }>}
 */
export function masterPresets () {
  const streaming = [
    { splitHz: 140, ratio: 2.4, thresholdDb: -26, attackMs: 18, releaseMs: 200, makeupDb: 0 },
    { splitHz: 1800, ratio: 1.8, thresholdDb: -28, attackMs: 9, releaseMs: 140, makeupDb: 0 },
    { ratio: 1.5, thresholdDb: -32, attackMs: 5, releaseMs: 100, makeupDb: 0 }
  ]
  const broadcast = [
    { splitHz: 120, ratio: 2.0, thresholdDb: -30, attackMs: 20, releaseMs: 240, makeupDb: 0 },
    { splitHz: 2000, ratio: 1.6, thresholdDb: -32, attackMs: 10, releaseMs: 160, makeupDb: 0 },
    { ratio: 1.4, thresholdDb: -36, attackMs: 6, releaseMs: 120, makeupDb: 0 }
  ]
  const voice = [
    { splitHz: 180, ratio: 1.8, thresholdDb: -28, attackMs: 20, releaseMs: 220, makeupDb: 0 },
    { splitHz: 2600, ratio: 1.5, thresholdDb: -30, attackMs: 10, releaseMs: 150, makeupDb: 0 },
    { ratio: 1.3, thresholdDb: -34, attackMs: 6, releaseMs: 110, makeupDb: 0 }
  ]
  return {
    'streaming-safe': {
      description: 'The default web target: -14 LUFS integrated (streaming normalisation) at <= -1 dBTP, gentle 3-band control, a touch of width. Use when the cue must not be turned down by a normaliser.',
      targetLufs: -14,
      ceilingDbtp: -1,
      bands: streaming.map((band) => ({ ...band })),
      width: 1.05,
      bassMonoHz: 110,
      driveDb: 0,
      maxGainReductionDb: 12
    },
    'streaming-loud': {
      description: 'Commercial loud master: -9 LUFS integrated at <= -1 dBTP, harder band compression and 2 dB of drive. Playback is normalised back to -14, so use it for density and character, not for a louder result.',
      targetLufs: -9,
      ceilingDbtp: -1,
      bands: streaming.map((band) => ({ ...band })),
      width: 1.12,
      bassMonoHz: 120,
      driveDb: 2,
      maxGainReductionDb: 14
    },
    'broadcast-23': {
      description: 'EBU R128 broadcast delivery: -23 LUFS integrated at <= -1 dBTP, slower attacks and a stricter band balance so the loudness meter stays inside the +/-0.5 LU tolerance.',
      targetLufs: -23,
      ceilingDbtp: -1,
      bands: broadcast.map((band) => ({ ...band })),
      width: 1,
      bassMonoHz: 90,
      driveDb: 0,
      maxGainReductionDb: 10
    },
    podcast: {
      description: 'Podcast delivery (Apple/AES): -16 LUFS integrated at <= -1 dBTP, dialogue-first band split with the low band left comparatively alone.',
      targetLufs: -16,
      ceilingDbtp: -1,
      bands: voice.map((band) => ({ ...band })),
      width: 1,
      bassMonoHz: 0,
      driveDb: 0,
      maxGainReductionDb: 10
    },
    gentle: {
      description: 'Transparent touch-up: -16 LUFS at <= -2 dBTP with near-transparent band ratios and no width change. Use when the material is already well mixed and only needs levelling and peak safety.',
      targetLufs: -16,
      ceilingDbtp: -2,
      bands: DEFAULT_BANDS.map((band) => ({ ...band })),
      width: 1,
      bassMonoHz: 80,
      driveDb: 0,
      maxGainReductionDb: 6
    }
  }
}
