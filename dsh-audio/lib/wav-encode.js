/**
 * WAVE writer for shipping deliverables.
 *
 * `wav.js` is the read side plus the original 16-bit write path. It stays
 * frozen: every existing tool and test depends on it, and its fixed-seed dither
 * and clipping are already baked into regression hashes and shipped files.
 * Changing that writer is a format change, not a bug fix, so it lives here.
 *
 * Shipping needs the rest of the format matrix. A cue inlined into a single
 * HTML file wants 8-bit (a quarter of the bytes of the same cue at 32-bit); a
 * video deliverable wants 24-bit; a lossless intermediate wants 32-bit IEEE
 * float; anything panning wants stereo. This module therefore writes
 * 8/16/24/32-bit, mono or stereo, and stands alone: no imports, its own seeded
 * TPDF dither, one deterministic byte layout. Same samples in, same bytes out
 * — that is what lets a cached file, a diffed take and an inline copy of the
 * same cue agree byte for byte.
 *
 * The writer is deliberately decoder-independent: `decodeWav` is not imported
 * here, and the test proves the output round-trips through it.
 */

/* ---------------------------------------------------------------- constants -- */

const RIFF_HEADER_BYTES = 44
const FORMAT_PCM = 1
const FORMAT_IEEE_FLOAT = 3
const BIT_DEPTHS = [8, 16, 24, 32]
const BYTES_PER_SAMPLE = { 8: 1, 16: 2, 24: 3, 32: 4 }
const DEFAULT_DITHER_SEED = 0x85EBCA6B

/* -------------------------------------------------------------- channel i/o -- */

/**
 * Mulberry32. A local copy instead of `dsp.makeRng` keeps this module free of
 * imports; the writer is the one file a tool can load without the synthesis
 * kernel, and the dither must never be `Math.random`.
 * @param {number} seed - unsigned 32-bit seed.
 * @returns {() => number} uniform samples in [0, 1).
 */
function seededRandom (seed) {
  let state = seed >>> 0
  return function next () {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Accept one mono buffer or an array of channel buffers, validate the shape,
 * and report the frame count.
 * @param {Float32Array|Float32Array[]|Float64Array|Float64Array[]} samples - one buffer per channel or one mono buffer.
 * @param {number|undefined} requestedChannels - `options.channels`, validated when present.
 * @returns {{ list: (Float32Array|Float64Array)[], frames: number, channelCount: number }}
 */
function channelList (samples, requestedChannels) {
  if (samples === undefined || samples === null) throw new Error('encodeWavEx: samples are required')
  const list = Array.isArray(samples) ? samples : [samples]
  if (list.length === 0) throw new Error('encodeWavEx: at least one channel is required')
  if (list.length > 2) throw new Error(`encodeWavEx: only mono or stereo is supported, got ${list.length} channels`)
  const frames = list[0]?.length
  if (!Number.isInteger(frames) || frames < 0) throw new Error('encodeWavEx: channel buffers must have a length')
  for (const channel of list) {
    // Float64Array is accepted too: a render pipeline may keep double precision
    // until the very last step.
    const isBuffer = channel instanceof Float32Array || channel instanceof Float64Array
    if (!isBuffer || channel.length !== frames) {
      throw new Error('encodeWavEx: channels must be Float32Array/Float64Array buffers of equal length')
    }
  }
  if (requestedChannels !== undefined) {
    const expected = Number(requestedChannels)
    if (expected !== list.length) {
      throw new Error(`encodeWavEx: channels=${expected} was requested but ${list.length} channel buffer(s) were given`)
    }
  }
  return { list, frames, channelCount: list.length }
}

/**
 * Flatten one buffer per channel into a single frame-major buffer.
 * @param {Float32Array[]|Float32Array} channels - one buffer per channel, or one mono buffer.
 * @param {{ channels?: number }} [options] - optional channel-count assertion.
 * @returns {Float32Array} interleaved samples, L R L R for stereo.
 */
export function interleave (channels, options = {}) {
  const { list, frames, channelCount } = channelList(channels, options.channels)
  const out = new Float32Array(frames * channelCount)
  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * channelCount
    for (let channel = 0; channel < channelCount; channel += 1) {
      out[base + channel] = list[channel][frame]
    }
  }
  return out
}

/* ------------------------------------------------------------------ header -- */

/**
 * Write the canonical 44-byte RIFF header. Minimal on purpose: `fmt ` + `data`
 * only, so no reader has to understand an extra `smpl`/`fact` chunk and the
 * byte layout stays exactly predictable.
 */
function writeHeader (out, { formatTag, channelCount, sampleRate, bitDepth, blockAlign, dataBytes, padBytes }) {
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes + padBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(formatTag, 20)
  out.writeUInt16LE(channelCount, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * blockAlign, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bitDepth, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)
}

/* ----------------------------------------------------------------- encoder -- */

/**
 * Encode samples as a complete WAVE file at 8/16/24/32-bit, mono or stereo.
 *
 * 8-bit is unsigned PCM (offset 128), 16/24-bit are signed little-endian PCM,
 * and 32-bit is IEEE float (`fmt ` tag 3) — the de-facto interchange format for
 * lossless intermediates. Samples are clipped to [-1, 1] because a delivered
 * cue should never hand a player values that need interpreter-specific repair.
 * 8/16-bit are dithered with seeded TPDF unless `dither: false`; the same input
 * and seed therefore always produce identical bytes.
 *
 * @param {Float32Array|Float64Array|(Float32Array|Float64Array)[]} samples - mono buffer, or one buffer per channel.
 * @param {number} sampleRate - samples per second (integer Hz).
 * @param {{ bitDepth?: 8|16|24|32, channels?: 1|2, dither?: boolean, ditherSeed?: number }} [options]
 * @returns {Buffer} complete `.wav` bytes.
 */
export function encodeWavEx (samples, sampleRate, options = {}) {
  const bitDepth = Number(options.bitDepth ?? 16)
  if (!BIT_DEPTHS.includes(bitDepth)) {
    throw new Error(`encodeWavEx: bitDepth must be one of ${BIT_DEPTHS.join(', ')}, got ${options.bitDepth}`)
  }
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`encodeWavEx: sampleRate must be a positive number, got ${sampleRate}`)

  const { list, frames, channelCount } = channelList(samples, options.channels)
  const bytesPerSample = BYTES_PER_SAMPLE[bitDepth]
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = frames * blockAlign
  // The RIFF chunk length is even by definition; an odd 8-bit payload gets one
  // padding byte that is not counted in the `data` chunk size.
  const padBytes = dataBytes % 2
  const isFloat = bitDepth === 32
  const out = Buffer.alloc(RIFF_HEADER_BYTES + dataBytes + padBytes)

  writeHeader(out, {
    formatTag: isFloat ? FORMAT_IEEE_FLOAT : FORMAT_PCM,
    channelCount,
    sampleRate: rate,
    bitDepth,
    blockAlign,
    dataBytes,
    padBytes
  })

  const dither = options.dither !== false && (bitDepth === 8 || bitDepth === 16)
  const seed = Number.isFinite(options.ditherSeed) ? options.ditherSeed : DEFAULT_DITHER_SEED
  const random = seededRandom(seed >>> 0)
  const scale = 2 ** (bitDepth - 1)
  let offset = RIFF_HEADER_BYTES

  for (let frame = 0; frame < frames; frame += 1) {
    // One dither draw per frame, shared by all channels. A centre-panned mono
    // cue is bit-identical in both channels, and independent per-channel noise
    // would round them differently; the shared draw keeps that promise. The
    // noise is ~90 dB down, so the (correlated) stereo hiss is inaudible.
    const noise = dither ? (random() - random()) / scale : 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      let value = list[channel][frame]
      if (!Number.isFinite(value)) value = 0
      if (dither) {
        // TPDF: the difference of two uniform draws has a triangular density,
        // so the quantisation error decorrelates from the signal and a quiet
        // fade-out becomes a soft hiss instead of a staircase.
        value += noise
      }
      value = value > 1 ? 1 : value < -1 ? -1 : value
      if (bitDepth === 32) {
        out.writeFloatLE(value, offset)
      } else if (bitDepth === 8) {
        const quantised = Math.round(value * 128) + 128
        out.writeUInt8(quantised > 255 ? 255 : quantised, offset)
      } else if (bitDepth === 16) {
        const quantised = Math.round(value * 32768)
        out.writeInt16LE(quantised > 32767 ? 32767 : quantised, offset)
      } else {
        const quantised = Math.round(value * 8388608)
        out.writeIntLE(quantised > 8388607 ? 8388607 : quantised, offset, 3)
      }
      offset += bytesPerSample
    }
  }
  return out
}

/**
 * Encode and wrap the file in a base64 data URI, ready to paste into a
 * single-file HTML page.
 *
 * Base64 costs 4/3 of the wav size, which is why 8-bit exists: the same cue as
 * a data URI is a third of the 16-bit size and a quarter of the 32-bit size.
 *
 * @param {Float32Array|Float64Array|(Float32Array|Float64Array)[]} samples - mono buffer, or one buffer per channel.
 * @param {number} sampleRate - samples per second (integer Hz).
 * @param {{ bitDepth?: 8|16|24|32, channels?: 1|2, dither?: boolean, ditherSeed?: number }} [options]
 * @returns {{ base64: string, dataUri: string, byteLength: number, dataUriLength: number }}
 */
export function encodeWavBase64 (samples, sampleRate, options = {}) {
  const bytes = encodeWavEx(samples, sampleRate, options)
  const base64 = bytes.toString('base64')
  const dataUri = `data:audio/wav;base64,${base64}`
  return { base64, dataUri, byteLength: bytes.length, dataUriLength: dataUri.length }
}
