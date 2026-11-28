/**
 * Minimal RIFF/WAVE codec: 16-bit PCM encode, and a decoder that reads
 * 8/16/24/32-bit integer PCM plus 32-bit IEEE float, including the
 * WAVEFORMATEXTENSIBLE wrapper (`0xFFFE`) real encoders emit.
 *
 * The encoder writes interleaved channels from one Float32Array per channel.
 * Samples are clipped to [-1, 1] and dithered with a tiny triangular noise so
 * quiet fades do not collapse into quantisation steps.
 *
 * The dither is generated from a fixed-seed xorshift, never from Math.random:
 * the plugin's contract is that the same request produces the same bytes, and
 * `audio_regress` compares file hashes across processes. Random dither silently
 * broke that contract — same samples, different file every run.
 *
 * The decoder is deliberately strict. Treating every non-float tag as integer
 * PCM turns an A-law or ADPCM file into noise, and a 0/0 header into a
 * RangeError from the typed-array allocator; both are worse than a readable
 * "unsupported WAVE format" error, so the header is validated before a single
 * sample is allocated.
 */

const RIFF_HEADER_BYTES = 44

/** `wFormatTag` values the decoder can turn into samples. */
const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_IEEE_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE

/** Bit depths the sample readers below implement. */
const SUPPORTED_BIT_DEPTHS = Object.freeze([8, 16, 24, 32])

/** `fmt ` chunk sizes: the plain 16-byte header, and the 40-byte extensible one. */
const FMT_MIN_BYTES = 16
const FMT_EXTENSIBLE_BYTES = 40

/** Readable names for the compressed tags a caller is most likely to hit. */
const COMPRESSED_FORMATS = Object.freeze(new Map([
  [2, 'MS ADPCM'],
  [6, 'A-law'],
  [7, 'µ-law'],
  [0x11, 'IMA ADPCM'],
  [0x50, 'MPEG'],
  [0x55, 'MPEG Layer 3'],
  [0x2000, 'AC-3']
]))

function hexTag (tag) {
  return `0x${Number(tag).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Name a format tag for an error message: `0x0006 A-law`, or just `0x1234`. */
function formatLabel (tag) {
  const name = COMPRESSED_FORMATS.get(tag)
  return name === undefined ? hexTag(tag) : `${hexTag(tag)} ${name}`
}

/**
 * Read and validate a `fmt ` chunk.
 *
 * `WAVEFORMATEXTENSIBLE` carries the real format in the first field of a GUID
 * at offset 24, so the tag alone is not enough to choose the sample reader. The
 * GUID is only present when the chunk is long enough and its `cbSize` says so;
 * trusting a 16-byte allocator-written chunk would read whatever follows it in
 * the file as a GUID.
 *
 * @returns {{ audioFormat: number, channelCount: number, sampleRate: number, bitDepth: number, blockAlign: number }}
 */
function readFormatChunk (view, body, size) {
  if (size < FMT_MIN_BYTES) {
    throw new Error(`decodeWav: fmt chunk is ${size} bytes; a WAVE format needs at least ${FMT_MIN_BYTES}`)
  }
  if (body + size > view.length) throw new Error('decodeWav: truncated fmt chunk')
  const tag = view.readUInt16LE(body)
  let audioFormat = tag
  if (tag === WAVE_FORMAT_EXTENSIBLE) {
    if (size < FMT_EXTENSIBLE_BYTES) {
      throw new Error(`decodeWav: WAVEFORMATEXTENSIBLE fmt chunk is ${size} bytes; the sub-format GUID needs ${FMT_EXTENSIBLE_BYTES}`)
    }
    const extensionBytes = view.readUInt16LE(body + 16)
    if (extensionBytes < 22) {
      throw new Error(`decodeWav: WAVEFORMATEXTENSIBLE fmt chunk declares cbSize ${extensionBytes}; the sub-format GUID is missing`)
    }
    audioFormat = view.readUInt32LE(body + 24)
  }
  const channelCount = view.readUInt16LE(body + 2)
  const sampleRate = view.readUInt32LE(body + 4)
  const blockAlign = view.readUInt16LE(body + 12)
  const bitDepth = view.readUInt16LE(body + 14)
  // Order matters for the message: a compressed tag explains itself better than
  // "bit depth 4", which is only a consequence of the codec.
  if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (bitDepth !== 32) throw new Error(`decodeWav: IEEE float WAVE must be 32-bit, got ${bitDepth}`)
  } else if (audioFormat !== WAVE_FORMAT_PCM) {
    throw new Error(`decodeWav: unsupported WAVE format (${formatLabel(audioFormat)}); only integer PCM and 32-bit IEEE float are supported`)
  } else if (!SUPPORTED_BIT_DEPTHS.includes(bitDepth)) {
    throw new Error(`decodeWav: unsupported bit depth ${bitDepth}; this decoder reads ${SUPPORTED_BIT_DEPTHS.join(', ')} bit PCM`)
  }
  if (channelCount < 1) throw new Error(`decodeWav: invalid channel count ${channelCount} (a WAVE file has at least one channel)`)
  if (sampleRate < 1) throw new Error(`decodeWav: invalid sample rate ${sampleRate} Hz`)
  return { audioFormat, channelCount, sampleRate, bitDepth, blockAlign }
}

/**
 * Deterministic triangular dither source.
 * @returns {() => number} uniform values in [0, 1).
 */
function makeDither () {
  let state = 0x9E3779B9
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 4294967296
  }
}

/**
 * Encode channel buffers as a 16-bit PCM WAVE file.
 * @param {Float32Array[]} channels - one Float32Array per channel, equal lengths.
 * @param {number} sampleRate - samples per second.
 * @param {{ dither?: boolean }} [options] - dither defaults to on.
 * @returns {Buffer} complete `.wav` bytes.
 */
export function encodeWav (channels, sampleRate, options = {}) {
  const channelCount = channels.length
  if (channelCount === 0) throw new Error('encodeWav: at least one channel is required')
  const frames = channels[0].length
  for (const channel of channels) {
    if (channel.length !== frames) throw new Error('encodeWav: channels must have equal length')
  }
  const blockAlign = channelCount * 2
  const dataBytes = frames * blockAlign
  const out = Buffer.alloc(RIFF_HEADER_BYTES + dataBytes)

  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channelCount, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * blockAlign, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)

  const dither = options.dither !== false
  const random = dither ? makeDither() : null
  let offset = RIFF_HEADER_BYTES
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      let sample = channels[channel][frame]
      if (dither) sample += (random() - random()) / 32768
      sample = sample > 1 ? 1 : sample < -1 ? -1 : sample
      out.writeInt16LE(Math.round(sample * 32767), offset)
      offset += 2
    }
  }
  return out
}

/**
 * Decode a WAVE file into channel buffers.
 *
 * Only integer PCM (8/16/24/32-bit) and 32-bit IEEE float are decoded; both the
 * plain and the `WAVEFORMATEXTENSIBLE` spelling of them are accepted. Anything
 * else — A-law, ADPCM, MPEG, an unknown tag — throws a readable error instead
 * of being silently read as integer PCM. A header that cannot describe a signal
 * (no channels, no rate, no usable bit depth) is rejected before allocation.
 *
 * @param {Buffer|Uint8Array} bytes - complete file bytes.
 * @returns {{ sampleRate: number, channels: Float32Array[], durationSeconds: number, bitDepth: number, audioFormat: number }}
 */
export function decodeWav (bytes) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (view.length < RIFF_HEADER_BYTES) throw new Error('decodeWav: file is too short to be a WAVE file')
  if (view.toString('ascii', 0, 4) !== 'RIFF' || view.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file')
  }

  let cursor = 12
  let format = null
  let data = null
  while (cursor + 8 <= view.length) {
    const id = view.toString('ascii', cursor, cursor + 4)
    const size = view.readUInt32LE(cursor + 4)
    const body = cursor + 8
    if (id === 'fmt ') {
      format = readFormatChunk(view, body, size)
    } else if (id === 'data') {
      // A body past the end of the file is a broken truncation, not an empty
      // clip; clamping it to a negative length used to reach the allocator.
      if (body > view.length) throw new Error('decodeWav: data chunk starts past the end of the file')
      data = { start: body, size: Math.min(size, view.length - body) }
      break
    }
    cursor = body + size + (size % 2)
  }
  if (format === null) throw new Error('decodeWav: missing fmt chunk')
  if (data === null) throw new Error('decodeWav: missing data chunk')

  const { channelCount, sampleRate, bitDepth, audioFormat } = format
  const floatSamples = audioFormat === WAVE_FORMAT_IEEE_FLOAT
  const bytesPerSample = bitDepth / 8
  const frameBytes = bytesPerSample * channelCount
  const frames = Math.floor(data.size / frameBytes)
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const at = data.start + (frame * channelCount + channel) * bytesPerSample
      let value
      if (floatSamples) value = view.readFloatLE(at)
      else if (bitDepth === 8) value = (view.readUInt8(at) - 128) / 128
      else if (bitDepth === 16) value = view.readInt16LE(at) / 32768
      else if (bitDepth === 24) value = view.readIntLE(at, 3) / 8388608
      else value = view.readInt32LE(at) / 2147483648
      channels[channel][frame] = value
    }
  }

  return {
    sampleRate,
    channels,
    bitDepth,
    audioFormat,
    durationSeconds: frames / sampleRate
  }
}
