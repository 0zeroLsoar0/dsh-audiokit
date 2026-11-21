/**
 * Conversion-layer tests: the format matrix, the resampler, the pure track ops,
 * and the real `audio_convert` tool against files on disk.
 *
 * Every assertion is backed by a measured number that this file prints, because
 * "within the format's quantisation" and "no aliasing" are claims that are only
 * worth what their measurements are.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { specHash } from '../lib/dsp.js'
import { decodeWav } from '../lib/wav.js'
import { encodeWavBase64, encodeWavEx, interleave } from '../lib/wav-encode.js'
import {
  applyGainDb,
  concat,
  fade,
  mixdown,
  padSilence,
  resampleHiFi,
  reverse,
  toStereo,
  trim
} from '../lib/convert.js'
import { registerConvertTools } from '../lib/tools-convert.js'

const TAU = Math.PI * 2

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const dbText = (value) => (value > 0 ? `${(20 * Math.log10(value)).toFixed(2)} dB` : '-inf dB')

/* ------------------------------------------------------------ test helpers -- */

function readHeader (bytes) {
  return {
    audioFormat: bytes.readUInt16LE(20),
    channelCount: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bitDepth: bytes.readUInt16LE(34),
    dataBytes: bytes.readUInt32LE(40),
    riffBytes: bytes.readUInt32LE(4),
    fmtChunkBytes: bytes.readUInt32LE(16)
  }
}

function maxError (actual, expected) {
  let error = 0
  let at = 0
  for (let index = 0; index < expected.length; index += 1) {
    const difference = Math.abs(actual[index] - expected[index])
    if (difference > error) {
      error = difference
      at = index
    }
  }
  return { error, at }
}

/**
 * Least-squares fit of one sine in a window that contains a whole number of
 * cycles, so the projection is orthogonal and the residual is real THD+N
 * (harmonics + noise) rather than leakage.
 */
function toneFit (samples, sampleRate, frequency, startSeconds, lengthSeconds) {
  const cycles = frequency * lengthSeconds
  if (Math.abs(cycles - Math.round(cycles)) > 1e-9) throw new Error(`toneFit: window must contain whole cycles, got ${cycles}`)
  const start = Math.round(startSeconds * sampleRate)
  const count = Math.round(lengthSeconds * sampleRate)
  let cosSum = 0
  let sinSum = 0
  for (let index = 0; index < count; index += 1) {
    const phase = TAU * frequency * (start + index) / sampleRate
    cosSum += samples[start + index] * Math.cos(phase)
    sinSum += samples[start + index] * Math.sin(phase)
  }
  const cosine = 2 * cosSum / count
  const sine = 2 * sinSum / count
  let residual = 0
  for (let index = 0; index < count; index += 1) {
    const phase = TAU * frequency * (start + index) / sampleRate
    const fitted = samples[start + index] - cosine * Math.cos(phase) - sine * Math.sin(phase)
    residual += fitted * fitted
  }
  return {
    amplitude: Math.hypot(cosine, sine),
    residualRms: Math.sqrt(residual / count)
  }
}

function sine (durationSeconds, sampleRate, frequency, amplitude = 0.5) {
  const out = new Float32Array(Math.round(durationSeconds * sampleRate))
  for (let index = 0; index < out.length; index += 1) {
    out[index] = amplitude * Math.sin(TAU * frequency * index / sampleRate)
  }
  return out
}

/* ------------------------------------------------------- wav encoder matrix -- */

console.log('-- wav encoder: 8/16/24/32-bit headers --')

const RATE = 44100
const FRAMES = 44100
const source = new Float64Array(FRAMES)
for (let index = 0; index < FRAMES; index += 1) {
  const time = index / RATE
  // 997 Hz keeps every partial off a simple sub-multiple of the rate. The decay
  // leaves the last 10% around -43 dBFS, which is where 8-bit truncation would
  // otherwise turn a smooth fade into a staircase.
  source[index] = 0.9 * Math.sin(TAU * 997 * time) * Math.exp(-time * 5)
}

const HALF_LSB = {
  8: 0.5 / 128,
  16: 0.5 / 32768,
  24: 0.5 / 8388608,
  32: Math.pow(2, -25) // half a float32 ULP for values in [0.5, 1)
}
const LSB = { 8: 1 / 128, 16: 1 / 32768, 24: 1 / 8388608, 32: Math.pow(2, -24) }

for (const bitDepth of [8, 16, 24, 32]) {
  const bytes = encodeWavEx(source, RATE, { bitDepth, dither: false })
  const header = readHeader(bytes)
  const decoded = decodeWav(bytes)
  const frames = FRAMES
  const blockAlign = bitDepth / 8
  const expectedTag = bitDepth === 32 ? 3 : 1
  console.log(
    ` ${String(bitDepth).padStart(2)}-bit  tag ${header.audioFormat}  blockAlign ${header.blockAlign}  byteRate ${header.byteRate}  ` +
    `data ${header.dataBytes} B  file ${bytes.length} B`
  )
  check(`${bitDepth}-bit format tag`, header.audioFormat === expectedTag, `${header.audioFormat}`)
  check(`${bitDepth}-bit blockAlign`, header.blockAlign === blockAlign, `${header.blockAlign}`)
  check(`${bitDepth}-bit byteRate`, header.byteRate === RATE * blockAlign, `${header.byteRate}`)
  check(`${bitDepth}-bit dataBytes`, header.dataBytes === frames * blockAlign, `${header.dataBytes}`)
  check(`${bitDepth}-bit riff size`, header.riffBytes === bytes.length - 8, `${header.riffBytes}`)
  check(`${bitDepth}-bit fmt chunk`, header.fmtChunkBytes === 16, `${header.fmtChunkBytes}`)
  check(`${bitDepth}-bit minimal riff`, bytes.indexOf('smpl') === -1 && bytes.indexOf('fact') === -1)
  check(`${bitDepth}-bit decodes`, decoded.bitDepth === bitDepth && decoded.sampleRate === RATE && decoded.channels.length === 1)
  check(`${bitDepth}-bit frame count`, decoded.channels[0].length === frames, `${decoded.channels[0].length}`)
  const dithered = encodeWavEx(source, RATE, { bitDepth, dither: true, ditherSeed: 7 })
  check(`${bitDepth}-bit deterministic`, dithered.equals(encodeWavEx(source, RATE, { bitDepth, dither: true, ditherSeed: 7 })))
}

console.log('\n-- wav round-trip: error vs the format quantisation --')

for (const bitDepth of [8, 16, 24, 32]) {
  const clean = decodeWav(encodeWavEx(source, RATE, { bitDepth, dither: false })).channels[0]
  const plain = maxError(clean, source)
  // 8/16-bit dither by default; measure it against a TPDF bound (rounding 0.5
  // LSB + triangular dither 1 LSB).
  const noisy = decodeWav(encodeWavEx(source, RATE, { bitDepth, dither: true, ditherSeed: 991 })).channels[0]
  const dithered = maxError(noisy, source)
  const plainBound = HALF_LSB[bitDepth]
  const ditherBound = bitDepth === 8 || bitDepth === 16 ? 1.5 * LSB[bitDepth] : plainBound
  console.log(
    ` ${String(bitDepth).padStart(2)}-bit  no-dither max|err| ${plain.error.toExponential(3)} (${dbText(plain.error)})  ` +
    `bound ${plainBound.toExponential(3)} (${dbText(plainBound)})  |  dithered max|err| ${dithered.error.toExponential(3)} (${dbText(dithered.error)})  ` +
    `bound ${ditherBound.toExponential(3)} (${dbText(ditherBound)})`
  )
  check(`${bitDepth}-bit within half LSB`, plain.error <= plainBound * (1 + 1e-9), `${plain.error} > ${plainBound}`)
  check(`${bitDepth}-bit dither within bound`, dithered.error <= ditherBound * (1 + 1e-9), `${dithered.error} > ${ditherBound}`)
  if (bitDepth <= 24) {
    // Every decoded value must land exactly on the integer grid the decoder
    // divides by; a mismatch would mean the writer and reader disagree on scale.
    let grid = 0
    for (const value of clean) {
      const steps = value * (2 ** (bitDepth - 1))
      grid = Math.max(grid, Math.abs(steps - Math.round(steps)))
    }
    check(`${bitDepth}-bit integer grid`, grid < 1e-3, `${grid}`)
    console.log(`        max off-grid distance ${grid.toExponential(2)} steps (0 = exact quantiser grid)`)
  }
  // A dithered quiet tail must not collapse into silence or a staircase: count
  // the distinct 8-bit codes and how often adjacent samples step, with and
  // without dither. An undithered tail holds plateaus (graining); a dithered one
  // keeps moving (decorrelated noise).
  const tailStart = Math.floor(FRAMES * 0.9)
  let tailRms = 0
  const ditheredCodes = new Set()
  const plainCodes = new Set()
  let ditheredSteps = 0
  let plainSteps = 0
  for (let index = tailStart; index < FRAMES; index += 1) {
    tailRms += noisy[index] * noisy[index]
    ditheredCodes.add(noisy[index])
    plainCodes.add(clean[index])
    if (index > tailStart) {
      if (noisy[index] !== noisy[index - 1]) ditheredSteps += 1
      if (clean[index] !== clean[index - 1]) plainSteps += 1
    }
  }
  tailRms = Math.sqrt(tailRms / (FRAMES - tailStart))
  check(`${bitDepth}-bit quiet tail survives`, tailRms > 0)
  if (bitDepth === 8) {
    const pairs = FRAMES - tailStart - 1
    console.log(
      `        8-bit quiet tail (last 0.1 s, rms ${dbText(tailRms)}): ${plainCodes.size} codes / ` +
      `${(100 * plainSteps / pairs).toFixed(1)}% adjacent steps without dither vs ` +
      `${ditheredCodes.size} codes / ${(100 * ditheredSteps / pairs).toFixed(1)}% with dither`
    )
    check('dither decorrelates the 8-bit quiet tail', ditheredSteps > plainSteps * 2, `${ditheredSteps} vs ${plainSteps}`)
  }
}

console.log('\n-- wav encoder: stereo, odd payload and base64 --')

const left = sine(0.25, RATE, 440, 0.25)
const right = sine(0.25, RATE, 440, -0.25)
const stereoBytes = encodeWavEx([left, right], RATE, { bitDepth: 24, channels: 2, dither: false })
const stereoHeader = readHeader(stereoBytes)
const stereoDecoded = decodeWav(stereoBytes)
check('stereo blockAlign', stereoHeader.blockAlign === 6, `${stereoHeader.blockAlign}`)
check('stereo channels decode', stereoDecoded.channels.length === 2)
check('stereo left matches', maxError(stereoDecoded.channels[0], left).error <= HALF_LSB[24] * (1 + 1e-9))
check('stereo right matches', maxError(stereoDecoded.channels[1], right).error <= HALF_LSB[24] * (1 + 1e-9))
console.log(` stereo 24-bit: ${stereoBytes.length} B, blockAlign ${stereoHeader.blockAlign}, byteRate ${stereoHeader.byteRate}, decoded ${stereoDecoded.channels.length} ch`)

const odd = encodeWavEx(new Float32Array([0.5, -0.5, 0.25]), RATE, { bitDepth: 8, dither: false })
const oddHeader = readHeader(odd)
check('odd 8-bit pad byte', odd.length === 44 + 3 + 1 && oddHeader.dataBytes === 3 && oddHeader.riffBytes === odd.length - 8,
  `${odd.length}/${oddHeader.dataBytes}/${oddHeader.riffBytes}`)
check('odd 8-bit decodes', decodeWav(odd).channels[0].length === 3)
console.log(` odd 8-bit mono: data ${oddHeader.dataBytes} B, file ${odd.length} B (+${odd.length - 44 - oddHeader.dataBytes} pad), decoded ${decodeWav(odd).channels[0].length} frames`)

const interleaved = interleave([left, right], { channels: 2 })
check('interleave frames', interleaved.length === left.length * 2 && interleaved[0] === left[0] && interleaved[1] === right[0])
console.log(` interleave: ${left.length} frames -> ${interleaved.length} values, [L0,R0,L1,R1] = [${interleaved[0].toFixed(4)}, ${interleaved[1].toFixed(4)}, ${interleaved[2].toFixed(4)}, ${interleaved[3].toFixed(4)}]`)

const inline = encodeWavBase64(source, RATE, { bitDepth: 16 })
const inlineBytes = encodeWavEx(source, RATE, { bitDepth: 16 })
check('base64 decodes to identical bytes', Buffer.from(inline.base64, 'base64').equals(inlineBytes))
check('base64 data uri prefix', inline.dataUri.startsWith('data:audio/wav;base64,'))
check('base64 byte length', inline.byteLength === inlineBytes.length && inline.dataUriLength === inline.dataUri.length)
console.log(` base64: ${inlineBytes.length} B -> ${inline.base64.length} chars, dataUri ${inline.dataUriLength} B (${(inline.dataUriLength / inlineBytes.length).toFixed(2)}x)`)

/* ------------------------------------------------------------- resampler -- */

console.log('\n-- resampler: 1 kHz 44.1k -> 22.05k -> 44.1k --')

const oneSecond = sine(1, 44100, 1000, 0.5)
const down = resampleHiFi(oneSecond, 44100, 22050)
const up = resampleHiFi(down.samples, 22050, 44100)
check('down length', down.samples.length === 22050, String(down.samples.length))
check('down rate', down.sampleRate === 22050, String(down.sampleRate))
check('up length', up.samples.length === 44100, String(up.samples.length))
check('up rate', up.sampleRate === 44100, String(up.sampleRate))
const roundTrip = toneFit(up.samples, 44100, 1000, 0.2, 0.4)
const levelDb = 20 * Math.log10(roundTrip.amplitude / 0.5)
const thdnDb = 20 * Math.log10(roundTrip.residualRms / (roundTrip.amplitude / Math.SQRT2))
console.log(` passband level ${levelDb.toFixed(4)} dB (amplitude ${roundTrip.amplitude.toFixed(6)} vs 0.5)`)
console.log(` THD+N ${thdnDb.toFixed(2)} dB (residual rms ${roundTrip.residualRms.toExponential(3)} vs fundamental rms ${(roundTrip.amplitude / Math.SQRT2).toFixed(6)})`)
check('passband level within 0.1 dB', Math.abs(levelDb) < 0.1, `${levelDb} dB`)
check('THD+N below -60 dB', thdnDb < -60, `${thdnDb} dB`)

const ripple = []
for (const frequency of [100, 1000, 4000, 8000]) {
  const tone = sine(1, 44100, frequency, 0.5)
  const result = resampleHiFi(resampleHiFi(tone, 44100, 22050).samples, 22050, 44100)
  const fit = toneFit(result.samples, 44100, frequency, 0.2, 0.4)
  const measured = 20 * Math.log10(fit.amplitude / 0.5)
  ripple.push(measured)
  console.log(`   ${String(frequency).padStart(5)} Hz passband level ${measured.toFixed(4)} dB`)
}
check('passband ripple < 0.1 dB across 100 Hz..8 kHz', ripple.every((value) => Math.abs(value) < 0.1), ripple.join(', '))

console.log('\n-- resampler: anti-alias at 15 kHz -> 22.05k --')

const tone15 = sine(1, 44100, 15000, 0.5)
const folded = resampleHiFi(tone15, 44100, 22050)
const aliasFit = toneFit(folded.samples, 22050, 7050, 0.2, 0.4)
const sourceFit = toneFit(tone15, 44100, 15000, 0.2, 0.4)
const aliasDb = 20 * Math.log10(aliasFit.amplitude / sourceFit.amplitude)
console.log(` 15 kHz source magnitude ${sourceFit.amplitude.toFixed(6)} (${(20 * Math.log10(sourceFit.amplitude)).toFixed(2)} dBFS)`)
console.log(` 7.05 kHz alias magnitude ${aliasFit.amplitude.toExponential(3)} (${(20 * Math.log10(aliasFit.amplitude)).toFixed(2)} dBFS), ${aliasDb.toFixed(2)} dBc`)
check('15 kHz tone does not fold back strongly', aliasDb < -60, `${aliasDb} dBc`)

const tone5 = sine(1, 44100, 5000, 0.5)
const fiveDown = resampleHiFi(tone5, 44100, 22050)
const fiveFit = toneFit(fiveDown.samples, 22050, 5000, 0.2, 0.4)
const fiveLevel = 20 * Math.log10(fiveFit.amplitude / 0.5)
console.log(` 5 kHz passband after downsample ${fiveFit.amplitude.toFixed(6)} (${fiveLevel.toFixed(4)} dB) — the anti-alias filter is not eating the band`)
check('downsampled passband preserved', Math.abs(fiveLevel) < 0.05, `${fiveLevel} dB`)

console.log('\n-- resampler: 60 s throughput --')

const longSource = new Float32Array(60 * 44100)
for (let index = 0; index < longSource.length; index += 1) {
  longSource[index] = 0.4 * Math.sin(TAU * 997 * index / 44100) + 0.2 * Math.sin(TAU * 137 * index / 44100)
}
let started = process.hrtime.bigint()
const longResult = resampleHiFi(longSource, 44100, 48000)
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
console.log(` 60 s 44.1k -> 48k: ${elapsedMs.toFixed(0)} ms for ${longResult.samples.length} frames (${(60000 / elapsedMs).toFixed(0)}x realtime)`)
check('60 s resample under 1.5 s', elapsedMs < 1500, `${elapsedMs.toFixed(0)} ms`)
started = process.hrtime.bigint()
resampleHiFi(longSource, 44100, 22050)
const downMs = Number(process.hrtime.bigint() - started) / 1e6
console.log(` 60 s 44.1k -> 22.05k: ${downMs.toFixed(0)} ms (${(60000 / downMs).toFixed(0)}x realtime)`)
check('60 s downsample under 1.5 s', downMs < 1500, `${downMs.toFixed(0)} ms`)

/* ------------------------------------------------------------------ edits -- */

console.log('\n-- trim --')

const ramp = new Float32Array(44100)
for (let index = 0; index < ramp.length; index += 1) ramp[index] = index / 44100
const cut = trim({ samples: ramp, sampleRate: 44100 }, { start: 0.1, end: 0.2 })
console.log(` request 0.1s..0.2s -> ${cut.samples.length} frames, first ${cut.samples[0]} (ramp[4410] ${ramp[4410]}), last ${cut.samples[cut.samples.length - 1]} (ramp[8819] ${ramp[8819]})`)
check('trim exact start frame', cut.samples[0] === ramp[4410], `${cut.samples[0]} != ${ramp[4410]}`)
check('trim exact end frame', cut.samples[cut.samples.length - 1] === ramp[8819])
check('trim exact length', cut.samples.length === 4410, String(cut.samples.length))
const clamped = trim({ samples: ramp, sampleRate: 44100 }, { start: 0.9, end: 5 })
check('trim clamps to duration', clamped.samples.length === 4410, String(clamped.samples.length))
check('trim keeps rate', cut.sampleRate === 44100)

const sliced = sine(1, 44100, 1000, 0.8)
const requestedFrame = Math.round(0.1007 * 44100)
const snapped = trim({ samples: sliced, sampleRate: 44100 }, { start: 0.1007, end: 0.5, snapToZeroCrossing: true })
let snappedFrame = -1
for (let candidate = requestedFrame - 220; candidate <= requestedFrame + 220; candidate += 1) {
  if (candidate > 0 && snapped.samples[0] === sliced[candidate] && snapped.samples[5] === sliced[candidate + 5]) {
    snappedFrame = candidate
    break
  }
}
const crossing = snappedFrame > 0 && (Math.sign(sliced[snappedFrame - 1]) !== Math.sign(sliced[snappedFrame]) || Math.abs(sliced[snappedFrame]) < 1e-7)
console.log(` snap from requested frame ${requestedFrame} (${Math.abs(sliced[requestedFrame]).toFixed(4)}) to frame ${snappedFrame} (${Math.abs(sliced[snappedFrame]).toFixed(6)}) — moved ${Math.abs(snappedFrame - requestedFrame)} frames, crossing=${crossing}`)
check('zero-crossing snap found a slice', snappedFrame > 0)
check('zero-crossing snap lands on a crossing', crossing)
check('zero-crossing snap moved no further than the window', Math.abs(snappedFrame - requestedFrame) <= 220)

console.log('\n-- fade --')

const flat = new Float32Array(44100).fill(1)
const inFrames = Math.round(0.1 * 44100)
const outFrames = Math.round(0.2 * 44100)
const faded = fade({ samples: flat, sampleRate: 44100 }, { in: 0.1, out: 0.2 })
console.log(` fade 0.1s in / 0.2s out: first ${faded.samples[0]}, fade-in end ${faded.samples[inFrames]}, midpoint ${faded.samples[Math.round(inFrames / 2)].toFixed(4)}, fade-out boundary ${faded.samples[44100 - 1 - outFrames]}, last ${faded.samples[44099]}`)
check('fade in starts at 0', faded.samples[0] === 0)
check('fade in reaches unity', faded.samples[inFrames] === 1)
check('fade out ends at 0', faded.samples[faded.samples.length - 1] === 0)
check('fade out reaches unity', faded.samples[faded.samples.length - 1 - outFrames] === 1)
check('linear fade midpoint', Math.abs(faded.samples[Math.round(inFrames / 2)] - 0.5) < 0.01, `${faded.samples[Math.round(inFrames / 2)]}`)
const equalPower = fade({ samples: flat, sampleRate: 44100 }, { in: 0.1, out: 0, curve: 'equalPower' })
console.log(` equalPower fade-in midpoint ${equalPower.samples[Math.round(inFrames / 2)].toFixed(4)} (expected ~0.7071), endpoints ${equalPower.samples[0]} .. ${equalPower.samples[inFrames]}`)
check('equalPower curve', Math.abs(equalPower.samples[Math.round(inFrames / 2)] - Math.SQRT1_2) < 0.01)
check('equalPower endpoints', equalPower.samples[0] === 0 && equalPower.samples[inFrames] === 1)

console.log('\n-- reverse / pad / mixdown --')

const rampCopy = { samples: new Float32Array([0, 1, 2, 3, 4]), sampleRate: 44100 }
const backwards = reverse(rampCopy)
check('reverse', backwards.samples[0] === 4 && backwards.samples[4] === 0, [...backwards.samples].join(','))
check('reverse leaves input alone', rampCopy.samples[0] === 0)
const padded = padSilence({ samples: new Float32Array(44100).fill(0.5), sampleRate: 44100 }, { lead: 0.1, tail: 0.2 })
console.log(` pad 0.1s lead + 0.2s tail on a 1s take: ${padded.samples.length} frames (${(padded.samples.length / 44100).toFixed(2)}s), first ${padded.samples[0]}, at 0.1s ${padded.samples[Math.round(0.1 * 44100)]}`)
check('pad length', padded.samples.length === Math.round(1.3 * 44100), String(padded.samples.length))
check('pad silence before signal', padded.samples[0] === 0 && padded.samples[Math.round(0.1 * 44100) - 1] === 0)
check('pad keeps signal', padded.samples[Math.round(0.1 * 44100)] === 0.5)

const quiet = { samples: new Float32Array(4410).fill(0.25), sampleRate: 44100 }
const loud = { samples: new Float32Array(4410).fill(0.25), sampleRate: 44100 }
const summed = mixdown([quiet, loud])
console.log(` mixdown 2 x 0.25 constants -> ${summed.samples[0].toFixed(4)} (expected 0.5)`)
check('mixdown sums', Math.abs(summed.samples[0] - 0.5) < 1e-6)
const trimmedMix = mixdown([quiet, loud], { gainsDb: [0, -6], peakDbfs: -1 })
console.log(` mixdown with gainsDb [0, -6] + peakDbfs -1 -> peak ${dbText(Math.abs(trimmedMix.samples[0]))}`)
check('mixdown peak normalisation', Math.abs(Math.abs(trimmedMix.samples[0]) - Math.pow(10, -1 / 20)) < 1e-5)

console.log('\n-- concat --')

const takeA = { samples: new Float32Array(22050).fill(0.1), sampleRate: 44100 }
const takeB = { samples: new Float32Array(22050).fill(0.2), sampleRate: 44100 }
const takeC = { samples: new Float32Array(22050).fill(0.3), sampleRate: 44100 }
const joined = concat([takeA, takeB, takeC], { gapSeconds: 0.25 })
const joinedSeconds = joined.samples.length / joined.sampleRate
const expectedSeconds = 3 * 0.5 + 2 * 0.25
const gapFrames = Math.round(0.25 * 44100)
const secondStart = 22050 + gapFrames
console.log(` concat 3 x 0.5s with 0.25s gap: ${joinedSeconds.toFixed(4)}s (expected ${expectedSeconds}s), gap sample ${joined.samples[22050 + 1].toFixed(4)}, take B starts ${joined.samples[secondStart].toFixed(4)}`)
check('concat duration = sum + gap', Math.abs(joinedSeconds - expectedSeconds) <= 0.001, `${joinedSeconds}s`)
check('concat gap is silent', joined.samples[22050] === 0 && joined.samples[22050 + gapFrames - 1] === 0)
check('concat places takes',
  Math.abs(joined.samples[secondStart] - 0.2) < 1e-6 && Math.abs(joined.samples[secondStart + 22050 + gapFrames] - 0.3) < 1e-6,
  `${joined.samples[secondStart]} / ${joined.samples[secondStart + 22050 + gapFrames]}`)

const crossfaded = concat([takeA, takeB], { crossfadeSeconds: 0.1 })
const crossfadedSeconds = crossfaded.samples.length / crossfaded.sampleRate
console.log(` concat 2 x 0.5s with 0.1s crossfade: ${crossfadedSeconds.toFixed(4)}s (expected 0.9s), overlap midpoint ${crossfaded.samples[22050 - Math.round(0.05 * 44100)].toFixed(4)} (equal-power 0.1+0.2)`)
check('crossfade shortens by the overlap', Math.abs(crossfadedSeconds - 0.9) <= 0.001, `${crossfadedSeconds}s`)
let overlapBroken = false
try { concat([takeA, takeB], { gapSeconds: 0.1, crossfadeSeconds: 0.1 }) } catch { overlapBroken = true }
check('gap and crossfade are mutually exclusive', overlapBroken)

const mixedRates = concat(
  [{ samples: new Float32Array(22050).fill(0.1), sampleRate: 22050 }, takeA],
  { gapSeconds: 0 }
)
check('concat converts to the first rate', mixedRates.sampleRate === 22050 && mixedRates.samples.length === 33075,
  `${mixedRates.sampleRate}/${mixedRates.samples.length}`)
console.log(` concat mixed rates 1.0s @ 22.05k + 0.5s @ 44.1k -> ${mixedRates.sampleRate} Hz, ${mixedRates.samples.length} frames (1.5s)`)

console.log('\n-- stereo --')

const mono = { samples: sine(0.5, 44100, 440, 0.5), sampleRate: 44100 }
const centred = toStereo(mono, { pan: 0 })
const centredDecoded = decodeWav(encodeWavEx(centred.samples, 44100, { bitDepth: 16, channels: 2 }))
check('stereo has two channels', centred.samples.length === 2 && centredDecoded.channels.length === 2)
let equal = true
for (let index = 0; index < centredDecoded.channels[0].length; index += 1) {
  if (centredDecoded.channels[0][index] !== centredDecoded.channels[1][index]) { equal = false; break }
}
check('centred channels decode equal', equal)
console.log(` centred pan 0: L==R after encode+decode = ${equal}, L0 ${centredDecoded.channels[0][0]}, R0 ${centredDecoded.channels[1][0]}`)

const panned = toStereo(mono, { pan: -0.5 })
const pannedDecoded = decodeWav(encodeWavEx(panned.samples, 44100, { bitDepth: 16, channels: 2 }))
let difference = 0
let leftEnergy = 0
let rightEnergy = 0
for (let index = 0; index < pannedDecoded.channels[0].length; index += 1) {
  const l = pannedDecoded.channels[0][index]
  const r = pannedDecoded.channels[1][index]
  difference = Math.max(difference, Math.abs(l - r))
  leftEnergy += l * l
  rightEnergy += r * r
}
console.log(` pan -0.5: max |L-R| ${difference.toFixed(4)}, left rms ${dbText(Math.sqrt(leftEnergy / pannedDecoded.channels[0].length))}, right rms ${dbText(Math.sqrt(rightEnergy / pannedDecoded.channels[1].length))}`)
check('pan makes channels differ', difference > 0.1, `${difference}`)
check('hard-left pan leans left', leftEnergy > rightEnergy)

const narrow = toStereo(mono, { pan: -0.5, width: 0 })
let narrowEqual = true
for (let index = 0; index < narrow.samples[0].length; index += 1) {
  if (narrow.samples[0][index] !== narrow.samples[1][index]) { narrowEqual = false; break }
}
check('width 0 folds to mono', narrowEqual)

/* ------------------------------------------------------------ determinism -- */

console.log('\n-- determinism of the whole chain --')

function runChain () {
  let track = { samples: sine(1, 44100, 220, 0.4), sampleRate: 44100 }
  track = trim(track, { start: 0.05, end: 0.9, snapToZeroCrossing: true })
  track = fade(track, { in: 0.02, out: 0.05 })
  track = applyGainDb(track, -3)
  track = resampleHiFi(track.samples, track.sampleRate, 48000)
  const stereo = toStereo(track, { pan: -0.25 })
  const bytes = encodeWavEx(stereo.samples, 48000, { bitDepth: 16, channels: 2, ditherSeed: 424242 })
  return { bytes, track, stereo }
}
const firstRun = runChain()
const secondRun = runChain()
const chainBytesEqual = firstRun.bytes.equals(secondRun.bytes)
console.log(` chain bytes ${firstRun.bytes.length} B, identical on rerun = ${chainBytesEqual}, specHash ${specHash(firstRun.bytes.toString('base64'))}`)
check('whole chain is deterministic', chainBytesEqual)
check('chain output is stereo 48k', firstRun.track.sampleRate === 48000 && firstRun.stereo.samples.length === 2)

/* ------------------------------------------------------------- tool layer -- */

console.log('\n-- audio_convert tool --')

const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-convert-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'convert-test' } } }
registerConvertTools(ctx)
const tool = registered.get('audio_convert')
check('audio_convert registered', tool !== undefined)
check('tool surface', tool !== undefined && typeof tool.execute === 'function' && tool.parameters?.properties !== undefined && tool.output !== undefined && tool.isConcurrencySafe === true)
const call = (args) => tool.execute(args, exec)

const takeAFile = new Float32Array(44100 * 0.4)
const takeBFile = new Float32Array(44100 * 0.4)
for (let index = 0; index < takeAFile.length; index += 1) {
  takeAFile[index] = 0.5 * Math.sin(TAU * 440 * index / 44100) * Math.exp(-index / 44100 * 3)
  takeBFile[index] = 0.125 * Math.sin(TAU * 660 * index / 44100) * Math.exp(-index / 44100 * 3)
}
await writeFile(join(cwd, 'a.wav'), encodeWavEx([takeAFile], 44100, { bitDepth: 16 }))
await writeFile(join(cwd, 'b.wav'), encodeWavEx([takeBFile], 44100, { bitDepth: 16 }))

const trimmed = await call({ inputs: ['a.wav'], op: 'trim', start: 0.05, end: 0.25, bitDepth: 8, inline: true })
const trimmedFile = await readFile(join(cwd, trimmed.relativePath))
const trimmedDecoded = decodeWav(trimmedFile)
check('trim reports the written format', trimmed.bitDepth === 8 && trimmed.channels === 1 && trimmed.sampleRate === 44100,
  `${trimmed.bitDepth}/${trimmed.channels}/${trimmed.sampleRate}`)
check('trim duration', Math.abs(trimmed.durationSeconds - 0.2) < 0.001, String(trimmed.durationSeconds))
check('trim decoded bit depth', trimmedDecoded.bitDepth === 8, String(trimmedDecoded.bitDepth))
check('inline base64 decodes to the file bytes', Buffer.from(trimmed.inline.base64, 'base64').equals(trimmedFile))
check('inline data uri present', trimmed.inline.dataUri.startsWith('data:audio/wav;base64,'), trimmed.inline.dataUri.slice(0, 24))
console.log(` trim 0.05..0.25 + 8-bit + inline: ${trimmed.relativePath}, ${trimmed.bytes} B, duration ${trimmed.durationSeconds}s, dataUri ${trimmed.inline.dataUriBytes} B`)
console.log(`   ${trimmed.text}`)

const sameAs16 = await call({ inputs: ['a.wav'], op: 'trim', start: 0.05, end: 0.25, bitDepth: 16 })
console.log(` same 0.2s cue: 8-bit ${trimmed.bytes} B vs 16-bit ${sameAs16.bytes} B (${(sameAs16.bytes / trimmed.bytes).toFixed(1)}x smaller)`)
check('8-bit is smaller than 16-bit', trimmed.bytes < sameAs16.bytes)

const stereoOut = await call({
  inputs: ['a.wav'],
  op: 'convert',
  bitDepth: 24,
  channels: 2,
  sampleRate: 22050,
  pan: -0.6,
  out: 'out/stereo24.wav',
  inline: true
})
const stereoFile = await readFile(join(cwd, 'out/stereo24.wav'))
const stereoOutDecoded = decodeWav(stereoFile)
let stereoDifference = 0
for (let index = 0; index < stereoOutDecoded.channels[0].length; index += 1) {
  stereoDifference = Math.max(stereoDifference, Math.abs(stereoOutDecoded.channels[0][index] - stereoOutDecoded.channels[1][index]))
}
check('tool stereo format', stereoOut.bitDepth === 24 && stereoOut.channels === 2 && stereoOut.sampleRate === 22050,
  `${stereoOut.bitDepth}/${stereoOut.channels}/${stereoOut.sampleRate}`)
check('tool stereo file decodes', stereoOutDecoded.bitDepth === 24 && stereoOutDecoded.channels.length === 2 && stereoOutDecoded.sampleRate === 22050)
check('tool stereo pan differs', stereoDifference > 0.05, `${stereoDifference}`)
check('tool inline matches the stereo file', Buffer.from(stereoOut.inline.base64, 'base64').equals(stereoFile))
console.log(` convert 24-bit stereo 22050 Hz pan -0.6: ${stereoOut.relativePath}, ${stereoOut.bytes} B, max |L-R| ${stereoDifference.toFixed(4)}`)

const guarded = await call({ inputs: ['a.wav'], op: 'convert', bitDepth: 16, inline: true, maxInlineBytes: 256 })
check('inline size guard skips', guarded.inline === null)
check('inline size guard explains', /inline skipped/.test(guarded.text), guarded.text)
console.log(` inline guard: file ${guarded.bytes} B > maxInlineBytes 256 B -> inline ${guarded.inline === null ? 'skipped' : 'returned'}`)

const scanned = await call({ inputs: ['a.wav', 'b.wav'], op: 'gain-scan', peakDbfs: -1, out: 'norm' })
check('gain-scan writes one file per input', scanned.files.length === 2, String(scanned.files.length))
check('gain-scan reports the written format', scanned.bitDepth === 16 && scanned.channels === 1 && scanned.sampleRate === 44100)
const scanPeaks = []
for (const file of scanned.files) {
  const decoded = decodeWav(await readFile(join(cwd, file.relativePath)))
  let peak = 0
  for (const value of decoded.channels[0]) peak = Math.max(peak, Math.abs(value))
  scanPeaks.push(20 * Math.log10(peak))
}
const peakSpread = Math.max(...scanPeaks) - Math.min(...scanPeaks)
check('gain-scan levels every file to one peak', peakSpread < 0.1, scanPeaks.join(','))
check('gain-scan gains are reported', scanned.gains.length === 2 && scanned.gains.every((entry) => Number.isFinite(entry.gainDb)))
console.log(` gain-scan: gains ${scanned.gains.map((entry) => `${entry.input} ${entry.gainDb >= 0 ? '+' : ''}${entry.gainDb.toFixed(2)} dB`).join(', ')}`)
console.log(`   written peaks ${scanPeaks.map((value) => value.toFixed(2)).join(' / ')} dBFS (spread ${peakSpread.toFixed(3)} dB)`)
console.log(`   ${scanned.text}`)

const joinedTool = await call({ inputs: ['a.wav', 'b.wav'], op: 'concat', gapSeconds: 0.25 })
console.log(` concat via tool: ${joinedTool.relativePath}, ${joinedTool.durationSeconds.toFixed(3)}s (0.4 + 0.25 + 0.4 = 1.05s)`)
check('concat through the tool', Math.abs(joinedTool.durationSeconds - 1.05) <= 0.002, String(joinedTool.durationSeconds))

const renderedInput = await call({ inputs: [{ preset: 'tick', duration: 0.2, seed: 3 }], op: 'convert', bitDepth: 16 })
check('inline render spec input works', renderedInput.durationSeconds > 0.1 && renderedInput.bitDepth === 16, String(renderedInput.durationSeconds))
console.log(` render spec input: ${renderedInput.relativePath}, ${renderedInput.durationSeconds}s, peak ${renderedInput.metrics.peakDbfs} dBFS`)

const fadeTool = await call({ inputs: ['a.wav'], op: 'fade', fadeInSeconds: 0.1, fadeOutSeconds: 0.1 })
const fadeToolDecoded = decodeWav(await readFile(join(cwd, fadeTool.relativePath))).channels[0]
check('fade through the tool ends at 0', fadeToolDecoded[0] === 0 && fadeToolDecoded[fadeToolDecoded.length - 1] === 0,
  `${fadeToolDecoded[0]}/${fadeToolDecoded[fadeToolDecoded.length - 1]}`)
console.log(` fade op through the tool: first ${fadeToolDecoded[0]}, last ${fadeToolDecoded[fadeToolDecoded.length - 1]}`)

const inputPeak = decodeWav(await readFile(join(cwd, 'a.wav'))).channels[0].reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)
const gained = await call({ inputs: ['a.wav'], op: 'gain', gainDb: -6 })
const gainedDecoded = decodeWav(await readFile(join(cwd, gained.relativePath))).channels[0]
const gainedPeak = gainedDecoded.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)
check('gain through the tool is -6 dB', Math.abs(20 * Math.log10(gainedPeak / inputPeak) + 6) < 0.1,
  `${(20 * Math.log10(gainedPeak / inputPeak)).toFixed(2)} dB`)
console.log(` gain op -6 dB: ${(20 * Math.log10(inputPeak)).toFixed(2)} dBFS -> ${(20 * Math.log10(gainedPeak)).toFixed(2)} dBFS`)

const defaultFormat = await call({ inputs: ['a.wav'], op: 'convert' })
check('default output format', defaultFormat.bitDepth === 16 && defaultFormat.channels === 1 && defaultFormat.sampleRate === 44100,
  `${defaultFormat.bitDepth}/${defaultFormat.channels}/${defaultFormat.sampleRate}`)
console.log(` default format: ${defaultFormat.bitDepth}-bit ${defaultFormat.channels === 2 ? 'stereo' : 'mono'} ${defaultFormat.sampleRate} Hz`)

for (const [label, args] of [
  ['multi-input single-input op rejected', { inputs: ['a.wav', 'b.wav'], op: 'trim' }],
  ['bad bit depth rejected', { inputs: ['a.wav'], op: 'convert', bitDepth: 12 }],
  ['empty inputs rejected', { inputs: [], op: 'convert' }],
  ['unknown op rejected', { inputs: ['a.wav'], op: 'bogus' }],
  ['missing file surfaces', { inputs: ['missing.wav'], op: 'convert' }],
  ['gain-scan refuses inline', { inputs: ['a.wav'], op: 'gain-scan', inline: true }]
]) {
  let threw = false
  try { await call(args) } catch { threw = true }
  check(label, threw)
}

await rm(cwd, { recursive: true, force: true })

/* ------------------------------------------------------------------ result -- */

console.log(failures === 0 ? '\nOK: conversion layer behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
