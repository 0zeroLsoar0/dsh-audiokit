/**
 * WAVE header and format validation.
 *
 * The decoder used to trust every header: `audioFormat === 3 && bitDepth === 32`
 * was the only float case, so a `WAVEFORMATEXTENSIBLE` float file (tag 0xFFFE)
 * was read as integer PCM (a ±0.49 square wave), identical samples for A-law and
 * ADPCM were returned as noise, and a 0-channel / 0-bit-depth header reached the
 * typed-array allocator as a RangeError. Every case below builds the exact bytes
 * a real encoder would write, so the assertions are about the decoder's contract
 * rather than about a previous run of it.
 *
 * Run: node test/wav-decode.mjs
 */

import { decodeWav, encodeWav } from '../lib/wav.js'

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const SUBFORMAT_GUID_TAIL = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71])

/**
 * Assemble a WAVE file from a deliberately arbitrary header.
 *
 * `fmtSize` and `cbSize` are knobs because the point of the suite is malformed
 * headers: a 14-byte fmt chunk, an extensible chunk that forgot its GUID, a
 * cbSize of zero. `subFormatTag` is the Data1 field of the extensible GUID.
 */
function waveBytes ({
  tag = 1,
  channels = 1,
  sampleRate = 8000,
  bitDepth = 16,
  data = Buffer.alloc(0),
  fmtSize = 16,
  cbSize = 22,
  subFormatTag = null
} = {}) {
  const blockAlign = Math.max(1, Math.floor(bitDepth / 8) * Math.max(1, channels))
  const fmt = Buffer.alloc(fmtSize)
  if (fmt.length >= 2) fmt.writeUInt16LE(tag, 0)
  if (fmt.length >= 4) fmt.writeUInt16LE(channels, 2)
  if (fmt.length >= 8) fmt.writeUInt32LE(sampleRate, 4)
  if (fmt.length >= 12) fmt.writeUInt32LE(Math.max(1, Math.floor(sampleRate * blockAlign)), 8)
  if (fmt.length >= 14) fmt.writeUInt16LE(blockAlign, 12)
  if (fmt.length >= 16) fmt.writeUInt16LE(bitDepth, 14)
  if (fmt.length >= 18) fmt.writeUInt16LE(cbSize, 16)
  if (fmt.length >= 40 && subFormatTag !== null) {
    const guid = Buffer.alloc(16)
    guid.writeUInt32LE(subFormatTag >>> 0, 0)
    SUBFORMAT_GUID_TAIL.copy(guid, 4)
    guid.copy(fmt, 24)
  }
  const out = Buffer.alloc(12 + 8 + fmt.length + 8 + data.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(fmt.length, 16)
  fmt.copy(out, 20)
  let cursor = 20 + fmt.length
  out.write('data', cursor, 'ascii')
  out.writeUInt32LE(data.length, cursor + 4)
  data.copy(out, cursor + 8)
  return out
}

/** 16-bit PCM body from full-scale values. */
function pcm16 (values) {
  const data = Buffer.alloc(values.length * 2)
  values.forEach((value, index) => data.writeInt16LE(Math.round(value * 32767), index * 2))
  return data
}

/** 24-bit PCM body from full-scale values. */
function pcm24 (values) {
  const data = Buffer.alloc(values.length * 3)
  values.forEach((value, index) => data.writeIntLE(Math.round(value * 8388607), index * 3, 3))
  return data
}

/** 32-bit IEEE float body. */
function float32 (values) {
  const data = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => data.writeFloatLE(value, index * 4))
  return data
}

function expectError (label, run, pattern) {
  checks += 1
  let error = null
  try {
    run()
  } catch (caught) {
    error = caught
  }
  if (error === null) {
    failures += 1
    console.log(`  FAIL ${label} did not throw`)
    return null
  }
  // A RangeError or TypeError is the failure mode this suite exists to prevent:
  // a broken header must be an Error whose message says what is unsupported.
  check(`${label}: throws a plain Error`, error.constructor === Error, `${error.constructor.name}: ${error.message}`)
  check(`${label}: message is readable`, pattern.test(error.message), error.message)
  return error
}

/* ------------------------------------------------------- positive paths -- */

console.log('-- supported formats --')
{
  const plainPcm16 = decodeWav(waveBytes({ bitDepth: 16, data: pcm16([0.5, -0.25, 1]) }))
  console.log(`  16-bit PCM: ${plainPcm16.channels[0].length} frame(s), ${plainPcm16.sampleRate} Hz, ${plainPcm16.bitDepth}-bit, format ${plainPcm16.audioFormat}`)
  check('16-bit PCM decodes three frames', plainPcm16.channels[0].length === 3, String(plainPcm16.channels[0].length))
  check('16-bit PCM keeps the sample values', Math.abs(plainPcm16.channels[0][0] - 0.5) < 2e-4 && Math.abs(plainPcm16.channels[0][2] - 1) < 2e-4,
    [...plainPcm16.channels[0]].join(','))
  check('16-bit PCM reports PCM as the format', plainPcm16.audioFormat === 1, String(plainPcm16.audioFormat))

  const plainFloat = decodeWav(waveBytes({ tag: 3, bitDepth: 32, data: float32([0.25, -0.75, 0.5]) }))
  console.log(`  32-bit float: ${[...plainFloat.channels[0]].join(', ')}`)
  check('plain 32-bit float decodes exactly', plainFloat.channels[0][0] === 0.25 && plainFloat.channels[0][1] === -0.75)
  check('plain 32-bit float reports the float format', plainFloat.audioFormat === 3, String(plainFloat.audioFormat))

  // The regression: a real encoder writes float audio under tag 0xFFFE. Read as
  // integer PCM those bytes are a near-square wave, which is what this file
  // used to produce.
  const extensibleFloat = decodeWav(waveBytes({ tag: 0xFFFE, bitDepth: 32, fmtSize: 40, subFormatTag: 3, data: float32([0.25, -0.75, 0.5]) }))
  console.log(`  extensible float (0xFFFE + float GUID): ${[...extensibleFloat.channels[0]].join(', ')}`)
  check('extensible float decodes to the float samples', extensibleFloat.channels[0][0] === 0.25 && extensibleFloat.channels[0][1] === -0.75,
    [...extensibleFloat.channels[0]].join(','))
  check('extensible float reports the resolved float format', extensibleFloat.audioFormat === 3, String(extensibleFloat.audioFormat))
  const squareWave = Math.max(Math.abs(extensibleFloat.channels[0][0] - 0.25), Math.abs(extensibleFloat.channels[0][1] + 0.75))
  check('extensible float is not the old ±0.49 integer reading', squareWave < 1e-6, String(squareWave))

  const extensiblePcm = decodeWav(waveBytes({ tag: 0xFFFE, bitDepth: 24, fmtSize: 40, subFormatTag: 1, data: pcm24([0.5, -0.5]) }))
  console.log(`  extensible PCM 24-bit: ${[...extensiblePcm.channels[0]].join(', ')}`)
  check('extensible PCM resolves to the integer reader', Math.abs(extensiblePcm.channels[0][0] - 0.5) < 2e-4 && Math.abs(extensiblePcm.channels[0][1] + 0.5) < 2e-4,
    [...extensiblePcm.channels[0]].join(','))
  check('extensible PCM reports the resolved PCM format', extensiblePcm.audioFormat === 1, String(extensiblePcm.audioFormat))

  const stereo = decodeWav(waveBytes({
    channels: 2,
    bitDepth: 16,
    data: interleave16([[0.25, -0.25], [-0.5, 0.5]])
  }))
  console.log(`  stereo 16-bit: L ${[...stereo.channels[0]].join(',')} / R ${[...stereo.channels[1]].join(',')}`)
  check('stereo frames are de-interleaved', stereo.channels.length === 2 && Math.abs(stereo.channels[0][0] - 0.25) < 2e-4 && Math.abs(stereo.channels[1][0] + 0.5) < 2e-4,
    JSON.stringify(stereo.channels.map((channel) => [...channel])))

  // The encoder's own output must still round-trip: this is the format every
  // tool in the plugin writes.
  const rendered = new Float32Array([0.1, -0.2, 0.3, -0.4])
  const roundTrip = decodeWav(encodeWav([rendered], 44100, { dither: false }))
  const maxError = roundTrip.channels[0].reduce((worst, value, index) => Math.max(worst, Math.abs(value - rendered[index])), 0)
  console.log(`  encodeWav round trip: ${roundTrip.channels[0].length} frames, max error ${maxError.toExponential(2)}`)
  check('encodeWav output still decodes', roundTrip.channels[0].length === 4 && maxError < 1 / 32767)
  check('a zero-sample wav decodes to zero frames', decodeWav(encodeWav([new Float32Array(0)], 44100)).channels[0].length === 0)
}

/** Interleave two mono 16-bit value lists into one little-endian body. */
function interleave16 (channels) {
  const frames = channels[0].length
  const data = Buffer.alloc(frames * channels.length * 2)
  let at = 0
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      data.writeInt16LE(Math.round(channel[frame] * 32767), at)
      at += 2
    }
  }
  return data
}

/* --------------------------------------------------------- bad formats -- */

console.log('\n-- compressed and unknown formats are refused --')
{
  expectError('A-law (0x0006)', () => decodeWav(waveBytes({ tag: 6, bitDepth: 8, data: Buffer.alloc(16) })), /unsupported WAVE format \(0x0006 A-law\)/)
  expectError('IMA ADPCM (0x0011)', () => decodeWav(waveBytes({ tag: 0x11, bitDepth: 4, data: Buffer.alloc(16) })), /unsupported WAVE format \(0x0011 IMA ADPCM\)/)
  expectError('MS ADPCM (0x0002)', () => decodeWav(waveBytes({ tag: 2, bitDepth: 4, data: Buffer.alloc(16) })), /0x0002/)
  expectError('unknown tag (0x1234)', () => decodeWav(waveBytes({ tag: 0x1234, bitDepth: 16, data: Buffer.alloc(16) })), /unsupported WAVE format \(0x1234\)/)
  expectError('extensible unknown GUID', () => decodeWav(waveBytes({ tag: 0xFFFE, bitDepth: 16, fmtSize: 40, subFormatTag: 0xABCD, data: Buffer.alloc(16) })), /0xABCD/)
}

console.log('\n-- malformed headers are refused before allocation --')
{
  expectError('zero channels', () => decodeWav(waveBytes({ channels: 0, bitDepth: 16, data: Buffer.alloc(16) })), /channel count 0/)
  expectError('zero sample rate', () => decodeWav(waveBytes({ sampleRate: 0, bitDepth: 16, data: Buffer.alloc(16) })), /sample rate 0/)
  expectError('zero bit depth', () => decodeWav(waveBytes({ bitDepth: 0, data: Buffer.alloc(16) })), /bit depth 0/)
  expectError('20-bit depth', () => decodeWav(waveBytes({ bitDepth: 20, data: Buffer.alloc(16) })), /bit depth 20/)
  expectError('64-bit float', () => decodeWav(waveBytes({ tag: 3, bitDepth: 64, data: Buffer.alloc(16) })), /IEEE float WAVE must be 32-bit/)
  expectError('fmt chunk of 14 bytes', () => decodeWav(waveBytes({ bitDepth: 16, fmtSize: 14, data: Buffer.alloc(16) })), /fmt chunk is 14 bytes/)
  expectError('extensible fmt chunk with no GUID', () => decodeWav(waveBytes({ tag: 0xFFFE, bitDepth: 16, fmtSize: 16, data: Buffer.alloc(16) })), /sub-format GUID needs 40/)
  expectError('extensible fmt chunk with cbSize 0', () => decodeWav(waveBytes({ tag: 0xFFFE, bitDepth: 16, fmtSize: 40, cbSize: 0, data: Buffer.alloc(16) })), /cbSize 0/)
}

console.log('\n-- truncated containers --')
{
  const whole = waveBytes({ bitDepth: 16, data: pcm16([0.5, 0.5]) })
  const dataSizeAt = 12 + 8 + 16 + 4
  expectError('zero-byte file', () => decodeWav(Buffer.alloc(0)), /file is too short/)
  expectError('text renamed .wav', () => decodeWav(Buffer.from('this is not a wav file at all, only text padding over the header')), /not a RIFF\/WAVE/)
  // A fmt chunk that claims more bytes than the file holds is a truncation: the
  // old decoder read past the buffer and produced whatever was there.
  const shortFmt = Buffer.alloc(44)
  shortFmt.write('RIFF', 0, 'ascii')
  shortFmt.writeUInt32LE(36, 4)
  shortFmt.write('WAVE', 8, 'ascii')
  shortFmt.write('fmt ', 12, 'ascii')
  shortFmt.writeUInt32LE(40, 16)
  expectError('fmt chunk claims more bytes than the file has', () => decodeWav(shortFmt), /truncated fmt chunk/)
  // A header that claims a longer data body than the file holds decodes the
  // frames that exist (the documented truncation behaviour), not the claim.
  const cut = Buffer.from(whole)
  cut.writeUInt32LE(4096, dataSizeAt)
  const surviving = decodeWav(cut)
  check('truncated data body decodes the surviving frames', surviving.channels[0].length === 2, String(surviving.channels[0].length))
  // A data chunk header at the very end of the file has no body at all.
  const noBody = Buffer.from(whole)
  noBody.writeUInt32LE(0xFFFFFFFF, dataSizeAt)
  const clamped = decodeWav(noBody)
  check('a data size past EOF clamps to the bytes present', clamped.channels[0].length === 2, String(clamped.channels[0].length))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: WAVE decoder validates formats and rejects broken headers' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
