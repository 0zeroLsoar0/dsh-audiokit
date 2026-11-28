/**
 * Channel-layout helpers: the one place that knows what "5.1" means in a file.
 *
 * `audio_spatial` can render 4/6/8 channels, `lib/wav.js` decodes any channel
 * count and `lib/spatial.js` writes the extensible header that carries a
 * `dwChannelMask`. Everything downstream — the bus, the master chain and the
 * converter — used to assume at most two channels, so a surround render could
 * be produced and then not mixed, mastered or re-encoded. This module is the
 * shared vocabulary that closes that gap, and it is deliberately free of any
 * audio processing: it moves channels, changes their count sensibly, and reads
 * and writes them. The DSP stays in the modules that own it.
 *
 * Two facts are pinned down here once, because everything else depends on them:
 *
 * - **Channel order is WAVE order, not a DAW's taste.** 5.1 is
 *   `FL FR FC LFE BL BR`; 7.1 is `FL FR FC LFE BL BR SL SR`; quad is
 *   `FL FR BL BR`. That is the order ffmpeg, a WAVE decoder and a receiver
 *   assume, and swapping the rear pair sounds almost right, which is the worst
 *   possible failure. `CHANNEL_LAYOUTS` carries the order and the matching
 *   `dwChannelMask` bit pattern.
 * - **LFE is not a speaker a signal is "folded into".** A downmix never sums
 *   LFE into the mono/stereo fold: LFE is an effects channel with up to 10 dB
 *   of gain on playback, so folding it into a full-range output would make the
 *   fold louder (and possibly clip) for content that was never meant to be
 *   heard there. LFE is preserved by identity conversions and dropped by
 *   downmixes, and that is stated in every report.
 *
 * Downmix coefficients (all relative gains, the usual ITU/consumer fold):
 *
 * - front left / front right enter a mono fold at `0.5` each, so a
 *   centre-panned stereo pair sums to exactly unity — the same contract
 *   `lib/bus.js`'s stereo-to-mono fold has always had;
 * - the centre channel folds at `-3 dB` (`1/sqrt2`) into mono and into each
 *   front channel of a stereo fold;
 * - a surround folds at `-3 dB` below its same-side front (so `0.5 * 1/sqrt2`
 *   in a mono fold), which is the standard `0.7071` surround coefficient
 *   inside a stereo fold;
 * - the LFE folds at `0`.
 *
 * Upmix coefficients: mono goes to the centre channel when the target has one
 * (6/8 channels) at unity, and to a phantom front pair at `-3 dB` per side when
 * it does not (2/4 channels). Stereo keeps its image: L/R land in FL/FR at
 * unity and no centre channel is invented, because a real centre fed from the
 * L+R sum would change the tone of every phantom-centre element. Quad keeps its
 * four corners and leaves 5.1's centre/LFE silent. There is no angle
 * re-mapping: a bus moves slots, and a real spatial placement is
 * `audio_spatial`'s job.
 *
 * The module is deterministic and stateless. `fitChannels` always returns new
 * buffers (unless the count already matches, where the input buffers are
 * returned as-is — the caller must not mutate them), so a conversion cannot
 * alias its input.
 *
 * It also owns the one loudness-layout decision: `loudnessChannels` returns the
 * channels a BS.1770-4 measurement may use (LFE excluded) with their standard
 * weights (surrounds at +1.5 dB). That is layout knowledge, not signal
 * processing, and it keeps `audio_loudness` and the master chain from
 * disagreeing about what a 5.1 file reads.
 */

import { dbToGain } from './dsp.js'
import { encodeWavEx } from './wav-encode.js'
import { decodeWav } from './wav.js'

/* ---------------------------------------------------------------- layouts -- */

const M3 = Math.SQRT1_2
const HALF = 0.5

/**
 * Build one frozen layout description.
 *
 * @param {string} id - human id used in reports ("5.1", "7.1").
 * @param {string[]} names - channel names in WAVE order.
 * @param {number} mask - `dwChannelMask` bits for the layout.
 * @returns {object} frozen layout record.
 */
function defineLayout (id, names, mask) {
  const lfeIndex = names.indexOf('LFE')
  return Object.freeze({
    id,
    channelCount: names.length,
    names: Object.freeze([...names]),
    mask,
    lfeIndex,
    hasLfe: lfeIndex >= 0,
    /** The channel order as one line, the thing a reader checks a header against. */
    wavOrder: names.join(' ')
  })
}

/**
 * Every channel count this plugin can lay out, keyed by count.
 *
 * The counts and masks follow the WAVE format's speaker bit assignment; a count
 * outside this table has no standard meaning, so `layoutFor` refuses it rather
 * than guessing which channel is where.
 *
 * @type {Readonly<Record<number, object>>}
 */
export const CHANNEL_LAYOUTS = Object.freeze({
  1: defineLayout('mono', ['M'], 0x4),
  2: defineLayout('stereo', ['L', 'R'], 0x3),
  4: defineLayout('quad', ['FL', 'FR', 'BL', 'BR'], 0x33),
  6: defineLayout('5.1', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'], 0x3f),
  8: defineLayout('7.1', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'], 0x63f)
})

/** The supported channel counts, in table order, for a tool's JSON schema. */
export const CHANNEL_COUNTS = Object.freeze(Object.keys(CHANNEL_LAYOUTS).map(Number))

/**
 * Resolve a channel count to its frozen layout record.
 * @param {number} channelCount - 1, 2, 4, 6 or 8.
 * @returns {object} the frozen layout record.
 */
export function layoutFor (channelCount) {
  const count = Math.trunc(Number(channelCount))
  const layout = CHANNEL_LAYOUTS[count]
  if (layout === undefined) {
    throw new Error(`multichannel: ${channelCount} channels has no WAVE layout; supported counts are ${CHANNEL_COUNTS.join(', ')}`)
  }
  return layout
}

/* -------------------------------------------------------------- loudness -- */

/**
 * BS.1770-4 surround weight: Ls/Rs count 1.5 dB above L/R/C.
 *
 * The standard's channel table gives L, R and C a weight of 1.0 and each
 * surround channel +1.5 dB (10^(1.5/20) = 1.4125). Counting them equally is the
 * old compromise: a 5.1 file whose surrounds carry the action then reads too
 * quiet, and a master aimed at -23 LUFS pushes the fronts too hot.
 */
export const SURROUND_LOUDNESS_WEIGHT = 1.41

/** Channel names BS.1770-4 weights at +1.5 dB (every rear/side channel). */
const SURROUND_CHANNEL_NAMES = new Set(['BL', 'BR', 'SL', 'SR'])

/**
 * The channels and per-channel weights a loudness measurement may use.
 *
 * ITU-R BS.1770 does not include an LFE channel in the loudness measure — it is
 * an effects channel that plays up to 10 dB louder than its samples say — so it
 * is excluded here rather than counted, and each surround channel carries the
 * standard's +1.5 dB weight. This is the one place both `audio_loudness` and
 * the master chain take that decision from, so the two tools cannot disagree
 * about what a 5.1 file reads.
 *
 * @param {Float32Array[]} channels - channel list in WAVE order.
 * @returns {{ measured: Float32Array[], weights: number[], lfeExcluded: boolean, layout: object }}
 *   the metered channels, their BS.1770 weights, whether LFE was dropped, and
 *   the layout record that says why.
 */
export function loudnessChannels (channels) {
  const layout = layoutFor(channels.length)
  const measured = []
  const weights = []
  for (let index = 0; index < channels.length; index += 1) {
    if (index === layout.lfeIndex) continue
    measured.push(channels[index])
    weights.push(SURROUND_CHANNEL_NAMES.has(layout.names[index]) ? SURROUND_LOUDNESS_WEIGHT : 1)
  }
  return { measured, weights, lfeExcluded: layout.hasLfe, layout }
}

/* ------------------------------------------------------------ conversions -- */

/** One coefficient row: `[sourceChannel, gain]` pairs summed into the target channel. */
const plan = (...rows) => Object.freeze(rows.map((row) => Object.freeze(row.map((pair) => Object.freeze(pair)))))

/**
 * Sparse conversion matrix, `"<from>:<to>"` → one row per target channel.
 *
 * A row lists the source channels that feed it and their gains; an empty row is
 * a silent channel. Every pair of supported counts has a plan, so a conversion
 * never falls through to an invented rule. The comments name the intended
 * meaning in layout terms; the coefficients are the ones documented in the
 * module header.
 */
const CONVERSION_PLANS = Object.freeze({
  /* upmix: mono -> ... */
  '1:2': plan([[0, M3]], [[0, M3]]),
  '1:4': plan([[0, M3]], [[0, M3]], [], []),
  '1:6': plan([], [], [[0, 1]], [], [], []),
  '1:8': plan([], [], [[0, 1]], [], [], [], [], []),
  /* upmix: stereo -> ... */
  '2:4': plan([[0, 1]], [[1, 1]], [], []),
  '2:6': plan([[0, 1]], [[1, 1]], [], [], [], []),
  '2:8': plan([[0, 1]], [[1, 1]], [], [], [], [], [], []),
  /* upmix: quad -> ... */
  '4:6': plan([[0, 1]], [[1, 1]], [], [], [[2, 1]], [[3, 1]]),
  '4:8': plan([[0, 1]], [[1, 1]], [], [], [[2, 1]], [[3, 1]], [], []),
  /* upmix: 5.1 -> 7.1 (the side pair is silent: nothing is invented) */
  '6:8': plan([[0, 1]], [[1, 1]], [[2, 1]], [[3, 1]], [[4, 1]], [[5, 1]], [], []),

  /* downmix: ... -> mono */
  '2:1': plan([[0, HALF], [1, HALF]]),
  '4:1': plan([[0, HALF], [1, HALF], [2, HALF * M3], [3, HALF * M3]]),
  '6:1': plan([[0, HALF], [1, HALF], [2, M3], [4, HALF * M3], [5, HALF * M3]]),
  '8:1': plan([[0, HALF], [1, HALF], [2, M3], [4, HALF * M3], [5, HALF * M3], [6, HALF * M3], [7, HALF * M3]]),
  /* downmix: ... -> stereo */
  '4:2': plan([[0, 1], [2, M3]], [[1, 1], [3, M3]]),
  '6:2': plan([[0, 1], [2, M3], [4, M3]], [[1, 1], [2, M3], [5, M3]]),
  '8:2': plan([[0, 1], [2, M3], [4, M3], [6, M3]], [[1, 1], [2, M3], [5, M3], [7, M3]]),
  /* downmix: ... -> quad */
  '6:4': plan([[0, 1], [2, M3]], [[1, 1], [2, M3]], [[4, 1]], [[5, 1]]),
  '8:4': plan([[0, 1], [2, M3]], [[1, 1], [2, M3]], [[4, 1], [6, M3]], [[5, 1], [7, M3]]),
  /* downmix: 7.1 -> 5.1 (the side pair folds into the backs at -3 dB) */
  '8:6': plan([[0, 1]], [[1, 1]], [[2, 1]], [[3, 1]], [[4, 1], [6, M3]], [[5, 1], [7, M3]])
})

/**
 * Describe a conversion without running it: `identity`, `upmix` or `downmix`.
 * @param {number} from - source channel count.
 * @param {number} to - target channel count.
 * @returns {'identity'|'upmix'|'downmix'} the kind of move.
 */
export function conversionKind (from, to) {
  layoutFor(from)
  layoutFor(to)
  return from === to ? 'identity' : from < to ? 'upmix' : 'downmix'
}

/**
 * Validate a channel list and return its frames.
 *
 * @param {Float32Array[]|Float64Array[]} channels - one buffer per channel.
 * @param {string} caller - name used in error messages.
 * @returns {{ list: (Float32Array|Float64Array)[], frames: number }}
 */
function validateChannels (channels, caller) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error(`${caller}: channels must be a non-empty array of sample buffers`)
  }
  const frames = channels[0]?.length
  if (!Number.isInteger(frames) || frames < 0) {
    throw new Error(`${caller}: channel buffers must be typed arrays with a length`)
  }
  for (const channel of channels) {
    const isBuffer = channel instanceof Float32Array || channel instanceof Float64Array
    if (!isBuffer || channel.length !== frames) {
      throw new Error(`${caller}: every channel must be a Float32Array/Float64Array of equal length`)
    }
  }
  return { list: channels, frames }
}

/**
 * Up/downmix a channel list to another channel count.
 *
 * Correct gains are the point of this function: see the module header for the
 * coefficient table. A same-count conversion returns the input buffers as-is
 * (no copy) — `renderBus` relies on that to avoid copying every layer twice —
 * so a caller that needs ownership must copy first.
 *
 * @param {Float32Array[]|Float64Array[]} channels - source channels, WAVE order.
 * @param {number} target - target count: 1, 2, 4, 6 or 8.
 * @returns {Float32Array[]} target channels; new buffers when the count changes.
 */
export function fitChannels (channels, target) {
  const { list, frames } = validateChannels(channels, 'fitChannels')
  const sourceLayout = layoutFor(list.length)
  const targetLayout = layoutFor(target)
  if (list.length === targetLayout.channelCount) return list

  const matrix = CONVERSION_PLANS[`${sourceLayout.channelCount}:${targetLayout.channelCount}`]
  if (matrix === undefined) {
    throw new Error(`fitChannels: no conversion from ${sourceLayout.id} to ${targetLayout.id}`)
  }
  const out = Array.from({ length: targetLayout.channelCount }, () => new Float32Array(frames))
  for (let targetIndex = 0; targetIndex < matrix.length; targetIndex += 1) {
    const row = matrix[targetIndex]
    if (row.length === 0) continue
    const destination = out[targetIndex]
    for (const [sourceIndex, gain] of row) {
      const input = list[sourceIndex]
      if (gain === 1) {
        for (let index = 0; index < frames; index += 1) destination[index] += input[index]
      } else {
        for (let index = 0; index < frames; index += 1) destination[index] += input[index] * gain
      }
    }
  }
  return out
}

/* -------------------------------------------------------------- buffers -- */

/**
 * Split a frame-major (interleaved) sample buffer into one buffer per channel.
 *
 * @param {Float32Array|Float64Array} buffer - interleaved samples.
 * @param {number} channelCount - channels per frame.
 * @returns {Float32Array[]} one buffer per channel.
 */
export function deinterleave (buffer, channelCount) {
  if (!ArrayBuffer.isView(buffer) || typeof buffer.length !== 'number') {
    throw new Error('deinterleave: buffer must be a sample buffer')
  }
  const count = Math.trunc(Number(channelCount))
  if (!Number.isFinite(count) || count < 1) throw new Error(`deinterleave: channelCount must be a positive integer, got ${channelCount}`)
  if (buffer.length % count !== 0) {
    throw new Error(`deinterleave: ${buffer.length} samples is not a whole number of ${count}-channel frames`)
  }
  const frames = buffer.length / count
  const channels = Array.from({ length: count }, () => new Float32Array(frames))
  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * count
    for (let channel = 0; channel < count; channel += 1) channels[channel][frame] = buffer[base + channel]
  }
  return channels
}

/**
 * Join one buffer per channel into a frame-major (interleaved) sample buffer.
 *
 * @param {Float32Array[]|Float64Array[]} channels - one buffer per channel.
 * @returns {Float32Array} interleaved samples.
 */
export function interleave (channels) {
  const { list, frames } = validateChannels(channels, 'interleave')
  const count = list.length
  const out = new Float32Array(frames * count)
  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * count
    for (let channel = 0; channel < count; channel += 1) out[base + channel] = list[channel][frame]
  }
  return out
}

/**
 * Map a function over every channel, keeping the channel structure.
 *
 * The callback must return a buffer of the same length as its input; anything
 * else would silently change the timeline of one channel and break the alignment
 * that makes a multichannel file a multichannel file.
 *
 * @param {Float32Array[]|Float64Array[]} channels - source channels.
 * @param {(channel: Float32Array|Float64Array, index: number) => Float32Array|Float64Array} fn - per-channel transform.
 * @returns {Float32Array[]} the transformed channels.
 */
export function perChannelMap (channels, fn) {
  const { list } = validateChannels(channels, 'perChannelMap')
  if (typeof fn !== 'function') throw new Error('perChannelMap: fn must be a function')
  return list.map((channel, index) => {
    const output = fn(channel, index)
    if (!ArrayBuffer.isView(output) || output.length !== channel.length) {
      throw new Error(`perChannelMap: fn must return a sample buffer of the same length for channel ${index}`)
    }
    return output
  })
}

/**
 * Apply one gain to every channel, in place.
 *
 * This is the "linked fader" for a stem set: scaling all channels by one number
 * changes the level of the set without touching its image, which is exactly
 * what a bus master gain and a stem trim have to do. Per-channel gains would
 * move the image, and a surround deliverable must never do that by accident.
 *
 * @param {Float32Array[]|Float64Array[]} channels - channels to scale in place.
 * @param {number} gainDb - gain in dB, applied to every channel.
 * @returns {Float32Array[]|Float64Array[]} the same array (mutated in place).
 */
export function linkStemGain (channels, gainDb) {
  const { list } = validateChannels(channels, 'linkStemGain')
  const db = Number(gainDb)
  if (!Number.isFinite(db)) throw new Error(`linkStemGain: gainDb must be a finite number, got ${gainDb}`)
  const gain = db === 0 ? 1 : dbToGain(db)
  if (gain === 1) return list
  for (const channel of list) {
    for (let index = 0; index < channel.length; index += 1) channel[index] *= gain
  }
  return list
}

/* ----------------------------------------------------------------- wav i/o -- */

/**
 * The extensible writer from `lib/spatial.js`, loaded lazily.
 *
 * `lib/wav-encode.js` stops at two channels and `lib/spatial.js` owns the
 * `WAVE_FORMAT_EXTENSIBLE` writer that carries `dwChannelMask` for 4/6/8
 * channels. Loading it with a dynamic import keeps this module usable (and its
 * clear error message deliverable) if that file is ever absent, instead of
 * breaking every tool that imports the channel helpers.
 */
let encodeMultichannelWav = null
let multichannelWriterError = null
try {
  const spatial = await import('./spatial.js')
  if (typeof spatial.encodeMultichannelWav === 'function') {
    encodeMultichannelWav = spatial.encodeMultichannelWav
  } else {
    multichannelWriterError = 'lib/spatial.js does not export encodeMultichannelWav'
  }
} catch (error) {
  multichannelWriterError = error instanceof Error ? error.message : String(error)
}

/**
 * Encode channels as a WAVE file at the widest bit-depth support available.
 *
 * Mono and stereo go through `lib/wav-encode.js` (8/16/24/32-bit, byte layout
 * the rest of the plugin already writes). Four, six and eight channels delegate
 * to `lib/spatial.js`'s extensible writer, which supports 16- and 24-bit PCM
 * only: its header is what tells a decoder which channel is the centre and
 * which pair are the surrounds. An 8- or 32-bit surround request is refused
 * rather than written under a header that lies about the format.
 *
 * @param {Float32Array[]|Float64Array[]} channels - one buffer per channel, WAVE order.
 * @param {number} sampleRate - samples per second.
 * @param {{ bitDepth?: 8|16|24|32 }} [options] - bit depth, default 16.
 * @returns {Buffer} complete `.wav` bytes.
 */
export function encodeAnyWav (channels, sampleRate, options = {}) {
  const { list } = validateChannels(channels, 'encodeAnyWav')
  const bitDepth = Number(options.bitDepth ?? 16)
  if (list.length > 2) {
    if (encodeMultichannelWav === null) {
      throw new Error(`encodeAnyWav: ${list.length}-channel output needs lib/spatial.js's extensible writer, which is unavailable (${multichannelWriterError})`)
    }
    if (bitDepth !== 16 && bitDepth !== 24) {
      throw new Error(`encodeAnyWav: ${list.length}-channel output supports 16 or 24-bit PCM (the extensible writer); got ${bitDepth}-bit`)
    }
    return encodeMultichannelWav(list, sampleRate, { bitDepth })
  }
  return encodeWavEx(list, sampleRate, { bitDepth, channels: list.length })
}

/**
 * Decode any WAVE file into its true channels.
 *
 * `lib/audio.js`'s `readTrack` deliberately folds to mono, which is what the
 * mono-era tools want. A multichannel path needs the real channels, so this
 * wrapper states the shape explicitly: `{ channels, sampleRate, channelCount }`.
 *
 * @param {Buffer|Uint8Array} bytes - complete file bytes.
 * @returns {{ channels: Float32Array[], sampleRate: number, channelCount: number }}
 */
export function decodeAnyWav (bytes) {
  const decoded = decodeWav(bytes)
  return {
    channels: decoded.channels,
    sampleRate: decoded.sampleRate,
    channelCount: decoded.channels.length
  }
}
