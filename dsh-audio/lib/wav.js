/**
 * Minimal RIFF/WAVE codec: 16-bit PCM encode, and a decoder that reads
 * 8/16/24/32-bit integer plus 32-bit float PCM.
 *
 * The encoder writes interleaved channels from one Float32Array per channel.
 * Samples are clipped to [-1, 1] and dithered with a tiny triangular noise so
 * quiet fades do not collapse into quantisation steps.
 *
 * The dither is generated from a fixed-seed xorshift, never from Math.random:
 * the plugin's contract is that the same request produces the same bytes, and
 * `audio_regress` compares file hashes across processes. Random dither silently
 * broke that contract — same samples, different file every run.
 */

const RIFF_HEADER_BYTES = 44

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
 * @param {Buffer|Uint8Array} bytes - complete file bytes.
 * @returns {{ sampleRate: number, channels: Float32Array[], durationSeconds: number, bitDepth: number }}
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
      format = {
        audioFormat: view.readUInt16LE(body),
        channelCount: view.readUInt16LE(body + 2),
        sampleRate: view.readUInt32LE(body + 4),
        bitDepth: view.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, view.length - body) }
      break
    }
    cursor = body + size + (size % 2)
  }
  if (format === null) throw new Error('decodeWav: missing fmt chunk')
  if (data === null) throw new Error('decodeWav: missing data chunk')

  const { channelCount, sampleRate, bitDepth, audioFormat } = format
  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(data.size / (bytesPerSample * channelCount))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const at = data.start + (frame * channelCount + channel) * bytesPerSample
      let value
      if (audioFormat === 3 && bitDepth === 32) value = view.readFloatLE(at)
      else if (bitDepth === 8) value = (view.readUInt8(at) - 128) / 128
      else if (bitDepth === 16) value = view.readInt16LE(at) / 32768
      else if (bitDepth === 24) value = view.readIntLE(at, 3) / 8388608
      else if (bitDepth === 32) value = view.readInt32LE(at) / 2147483648
      else throw new Error(`decodeWav: unsupported bit depth ${bitDepth}`)
      channels[channel][frame] = value
    }
  }

  return {
    sampleRate,
    channels,
    bitDepth,
    durationSeconds: frames / sampleRate
  }
}
