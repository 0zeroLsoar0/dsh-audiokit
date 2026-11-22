/**
 * Multichannel pipeline tests: the seam between `audio_spatial`'s 4/6/8-channel
 * renders and the bus, master and converter that used to stop at two channels.
 *
 * Every claim is measured on the actual samples or the actual file bytes, not
 * inferred from the code:
 *
 * - the WAVE channel order and mask 5.1/7.1 mean are the ones a decoder assumes,
 *   and an extensible header round-trips through the plugin's own decoder;
 * - `fitChannels` puts a mono source in the centre (fronts exactly silent) and
 *   downmixes 5.1 to mono with the documented gains, LFE excluded;
 * - `renderBus` keeps the frame order of a 6-channel layer, links one compressor
 *   detector across all channels (equal gain reduction everywhere), sends an
 *   unpanned mono layer to the centre of a 5.1 master, and refuses pan on a
 *   surround layer;
 * - `masterChain` holds the true-peak ceiling on the loudest channel of a 5.1
 *   input (measured with lib/lufs.js per channel), excludes LFE from loudness,
 *   bypasses the stereo width stage and says so;
 * - 5.1 -> bus -> master -> audio_convert preserves the channel count and order;
 * - the 2-channel encoders/decoders are byte-identical to before (delegation
 *   only happens above two channels);
 * - everything is deterministic, and a 6-channel 5 s render+master is timed.
 *
 * Run with the node from WORKERS.md:
 *   node test/multichannel.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderBus, highpass } from '../lib/bus.js'
import { masterChain, stereoWidth, truePeakLimiter } from '../lib/master.js'
import {
  CHANNEL_COUNTS,
  CHANNEL_LAYOUTS,
  decodeAnyWav,
  deinterleave,
  encodeAnyWav,
  fitChannels,
  interleave,
  layoutFor,
  linkStemGain,
  perChannelMap
} from '../lib/multichannel.js'
import { analyzeLoudness, truePeak } from '../lib/lufs.js'
import { registerBusTools } from '../lib/tools-bus.js'
import { registerConvertTools } from '../lib/tools-convert.js'
import { registerMasterTools } from '../lib/tools-master.js'
import { renderSpatial } from '../lib/spatial.js'
import { decodeWav } from '../lib/wav.js'
import { encodeWavEx } from '../lib/wav-encode.js'

const RATE = 48000
const TAU = Math.PI * 2

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const fmt = (value, digits = 2) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '-inf')
const dbOf = (linear) => (linear > 0 ? 20 * Math.log10(linear) : -120)

/* --------------------------------------------------------------- signals -- */

function sine (frames, hz, amplitude, phase = 0, sampleRate = RATE) {
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) out[index] = amplitude * Math.sin(TAU * hz * index / sampleRate + phase)
  return out
}

/** Amplitude of one frequency by direct DFT: a probe for "which channel is this?". */
function toneAmplitude (samples, hz, sampleRate = RATE) {
  let real = 0
  let imaginary = 0
  for (let index = 0; index < samples.length; index += 1) {
    const angle = TAU * hz * index / sampleRate
    real += samples[index] * Math.cos(angle)
    imaginary += samples[index] * Math.sin(angle)
  }
  return 2 * Math.sqrt(real * real + imaginary * imaginary) / Math.max(1, samples.length)
}

/** The frequency index with the most energy in each channel. */
function dominantIndex (channels, frequencies) {
  return channels.map((channel) => {
    let best = 0
    let bestAmplitude = -1
    for (let index = 0; index < frequencies.length; index += 1) {
      const amplitude = toneAmplitude(channel, frequencies[index])
      if (amplitude > bestAmplitude) {
        bestAmplitude = amplitude
        best = index
      }
    }
    return best
  })
}

function peakOf (samples) {
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]))
  return peak
}

function rmsDbWindow (samples, fromSeconds, toSeconds) {
  const start = Math.max(0, Math.round(fromSeconds * RATE))
  const end = Math.min(samples.length, Math.round(toSeconds * RATE))
  let sum = 0
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index]
  return 10 * Math.log10(sum / Math.max(1, end - start))
}

function maximumDifference (a, b) {
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference = Math.max(difference, Math.abs(a[index] - b[index]))
  return difference
}

const allFinite = (channels) => channels.every((channel) => channel.every((value) => Number.isFinite(value)))

function channelPeaksDbfs (channels) {
  return channels.map((channel) => dbOf(peakOf(channel)))
}

/** Read the header fields a WAVE consumer actually depends on. */
function readHeader (bytes) {
  const fmtChunkBytes = bytes.readUInt32LE(16)
  const extensible = fmtChunkBytes >= 40
  return {
    audioFormat: bytes.readUInt16LE(20),
    channelCount: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    blockAlign: bytes.readUInt16LE(32),
    bitDepth: bytes.readUInt16LE(34),
    fmtChunkBytes,
    channelMask: extensible ? bytes.readUInt32LE(40) >>> 0 : null,
    dataBytes: bytes.readUInt32LE(extensible ? 64 : 40)
  }
}

console.log('multichannel: layouts, conversion, bus, master, convert')
console.log(`sample rate ${RATE} Hz\n`)

/* ---------------------------------------------------------------- layouts -- */

console.log('-- channel layouts: WAVE order and channel mask --')
{
  for (const count of CHANNEL_COUNTS) {
    const layout = CHANNEL_LAYOUTS[count]
    console.log(`  ${String(count)} ch  ${layout.id.padEnd(7)} mask 0x${layout.mask.toString(16).padStart(3, '0')}  order ${layout.wavOrder}${layout.hasLfe ? `  LFE index ${layout.lfeIndex}` : ''}`)
  }
  check('five supported channel counts', CHANNEL_COUNTS.join(',') === '1,2,4,6,8', CHANNEL_COUNTS.join(','))
  check('5.1 is FL FR FC LFE BL BR', layoutFor(6).wavOrder === 'FL FR FC LFE BL BR', layoutFor(6).wavOrder)
  check('5.1 mask is 0x3f', layoutFor(6).mask === 0x3f, String(layoutFor(6).mask))
  check('7.1 is FL FR FC LFE BL BR SL SR', layoutFor(8).wavOrder === 'FL FR FC LFE BL BR SL SR', layoutFor(8).wavOrder)
  check('7.1 mask is 0x63f', layoutFor(8).mask === 0x63f, String(layoutFor(8).mask))
  check('LFE sits at index 3 in 5.1 and 7.1', layoutFor(6).lfeIndex === 3 && layoutFor(8).lfeIndex === 3)
  check('quad has no LFE', layoutFor(4).hasLfe === false)
  let threw = false
  try { layoutFor(3) } catch { threw = true }
  check('a 3-channel layout is refused', threw)
}

/* -------------------------------------------------------------- buffers -- */

console.log('\n-- interleave / deinterleave / linkStemGain --')
{
  const channels = Array.from({ length: 6 }, (_, channel) => {
    const buffer = new Float32Array(100)
    buffer.fill((channel + 1) / 10)
    return buffer
  })
  const interleaved = interleave(channels)
  const restored = deinterleave(interleaved, 6)
  check('interleave length is frames x channels', interleaved.length === 600, String(interleaved.length))
  check('deinterleave restores the channel count', restored.length === 6, String(restored.length))
  let orderPreserved = true
  for (let channel = 0; channel < 6; channel += 1) {
    if (maximumDifference(restored[channel], channels[channel]) !== 0) orderPreserved = false
  }
  check('deinterleave preserves channel order', orderPreserved)
  check('frame-major layout is channel-major in blocks of 6',
    interleaved[0] === channels[0][0] && interleaved[1] === channels[1][0] && interleaved[5] === channels[5][0] && interleaved[6] === channels[0][0])
  let oddThrew = false
  try { deinterleave(new Float32Array(7), 6) } catch { oddThrew = true }
  check('deinterleave refuses a partial frame', oddThrew)

  const doubled = perChannelMap(restored, (channel, index) => channel.map((value) => value * (index + 1)))
  check('perChannelMap keeps the channel count', doubled.length === 6)
  check('perChannelMap receives the channel index', Math.abs(doubled[2][0] - (3 / 10) * 3) < 1e-5, String(doubled[2][0]))

  const beforeChannel0 = dbOf(doubled[0][0])
  const beforeChannel5 = dbOf(doubled[5][0])
  const scaled = linkStemGain(doubled, -6)
  const expected = beforeChannel0 - 6
  console.log(`  linkStemGain -6 dB: channel 0 ${fmt(dbOf(scaled[0][0]), 2)} dBFS (expected ${fmt(expected, 2)})`)
  check('linkStemGain applies one gain to every channel', Math.abs(dbOf(scaled[5][0]) - (beforeChannel5 - 6)) < 1e-4)
}

/* ------------------------------------------------------------ conversions -- */

console.log('\n-- fitChannels: upmix and downmix gains --')
{
  const mono = sine(RATE / 2, 330, 0.3)
  const six = fitChannels([mono], 6)
  const silentExceptCentre = [0, 1, 3, 4, 5].every((index) => peakOf(six[index]) === 0)
  console.log(`  mono -> 5.1: FC peak ${fmt(dbOf(peakOf(six[2])), 2)} dBFS, FL/FR/BL/BR/LFE peaks ${[0, 1, 3, 4, 5].map((index) => fmt(dbOf(peakOf(six[index])), 1)).join('/')} dBFS`)
  check('mono -> 5.1 lands in the centre at unity', maximumDifference(six[2], mono) === 0 && peakOf(six[2]) === peakOf(mono))
  check('mono -> 5.1 leaves the fronts and surrounds silent', silentExceptCentre)

  const quad = fitChannels([mono], 4)
  console.log(`  mono -> quad: FL/FR ${fmt(dbOf(peakOf(quad[0])), 2)}/${fmt(dbOf(peakOf(quad[1])), 2)} dBFS, BL/BR ${fmt(dbOf(peakOf(quad[2])), 1)}/${fmt(dbOf(peakOf(quad[3])), 1)} dBFS`)
  check('mono -> quad uses a -3 dB phantom front pair', Math.abs(dbOf(peakOf(quad[0])) - (dbOf(0.3) - 3.0103)) < 0.01)
  check('mono -> quad leaves the surrounds silent', peakOf(quad[2]) === 0 && peakOf(quad[3]) === 0)

  // 5.1 -> mono: the documented fold is 0.5*(FL+FR) + 0.7071*FC + 0.3536*(BL+BR),
  // LFE excluded. A constant per channel makes the expected gain exact.
  const frames = RATE / 4
  const constants = [0.4, 0.4, 0.4, 0.8, 0.2, 0.2]
  const flat = constants.map((value) => new Float32Array(frames).fill(value))
  const down = fitChannels(flat, 1)
  const expected = 0.5 * 0.4 + 0.5 * 0.4 + Math.SQRT1_2 * 0.4 + 0.5 * Math.SQRT1_2 * 0.2 + 0.5 * Math.SQRT1_2 * 0.2
  const measuredDb = dbOf(down[0][0])
  console.log(`  5.1 -> mono: measured ${fmt(measuredDb, 3)} dBFS, expected ${fmt(dbOf(expected), 3)} dBFS (LFE 0.8 contributes 0)`)
  check('5.1 -> mono matches the documented fold (+/-0.5 dB)', Math.abs(measuredDb - dbOf(expected)) <= 0.5,
    `${fmt(measuredDb, 3)} vs ${fmt(dbOf(expected), 3)} dB`)
  const lfeChanged = flat.map((channel) => Float32Array.from(channel))
  lfeChanged[3].fill(1.0)
  check('LFE is excluded from the downmix', maximumDifference(fitChannels(lfeChanged, 1)[0], down[0]) === 0)

  const stereo = [sine(RATE / 4, 440, 0.2), sine(RATE / 4, 660, 0.2)]
  const up = fitChannels(stereo, 6)
  console.log(`  stereo -> 5.1: FL/FR match ${maximumDifference(up[0], stereo[0]) === 0}/${maximumDifference(up[1], stereo[1]) === 0}, FC ${fmt(dbOf(peakOf(up[2])), 1)} dBFS, surrounds ${fmt(dbOf(peakOf(up[4])), 1)} dBFS`)
  check('stereo -> 5.1 keeps the image in FL/FR', maximumDifference(up[0], stereo[0]) === 0 && maximumDifference(up[1], stereo[1]) === 0)
  check('stereo -> 5.1 invents no centre or surrounds', peakOf(up[2]) === 0 && peakOf(up[4]) === 0)

  const fiveOneConstant = [0.2, 0, 0.3, 0, 0.1, 0].map((value) => new Float32Array(frames).fill(value))
  const folded = fitChannels(fiveOneConstant, 2)
  const expectedLeft = 0.2 + Math.SQRT1_2 * 0.3 + Math.SQRT1_2 * 0.1
  console.log(`  5.1 -> stereo: left ${fmt(dbOf(folded[0][0]), 3)} dBFS, expected ${fmt(dbOf(expectedLeft), 3)} dBFS`)
  check('5.1 -> stereo folds centre and surrounds at -3 dB', Math.abs(dbOf(folded[0][0]) - dbOf(expectedLeft)) <= 0.01)

  const sevenOne = Array.from({ length: 8 }, (_, channel) => new Float32Array(16).fill([0.1, 0.1, 0.1, 0.1, 0.4, 0.4, 0.2, 0.2][channel]))
  const fiveOne = fitChannels(sevenOne, 6)
  console.log(`  7.1 -> 5.1: BL ${fiveOne[4][0]} (expected ${0.4 + Math.SQRT1_2 * 0.2}), BR ${fiveOne[5][0]}`)
  check('7.1 -> 5.1 folds sides into backs at -3 dB', Math.abs(fiveOne[4][0] - (0.4 + Math.SQRT1_2 * 0.2)) < 1e-6)
  check('7.1 -> 5.1 keeps the front stage', Math.abs(fiveOne[0][0] - 0.1) < 1e-6 && Math.abs(fiveOne[2][0] - 0.1) < 1e-6)

  let badTarget = false
  try { fitChannels(flat, 3) } catch { badTarget = true }
  check('fitChannels refuses an unsupported target count', badTarget)
  let badSource = false
  try { fitChannels([new Float32Array(8), new Float32Array(8), new Float32Array(8)], 1) } catch { badSource = true }
  check('fitChannels refuses an unsupported source count', badSource)
}

/* ---------------------------------------------------------------- wav i/o -- */

console.log('\n-- encodeAnyWav / decodeAnyWav: extensible 5.1 header --')
{
  const frames = RATE / 4
  const six = [220, 260, 330, 40, 500, 620].map((hz, channel) => sine(frames, hz, 0.1 + channel * 0.02))
  const bytes = encodeAnyWav(six, RATE, { bitDepth: 24 })
  const header = readHeader(bytes)
  const decoded = decodeAnyWav(bytes)
  console.log(`  5.1 24-bit: ${bytes.length} B, fmt ${header.fmtChunkBytes} B, tag 0x${header.audioFormat.toString(16)}, mask 0x${header.channelMask.toString(16)}, ${header.channelCount} ch @ ${header.sampleRate} Hz`)
  check('multichannel writer uses WAVE_FORMAT_EXTENSIBLE', header.audioFormat === 0xfffe && header.fmtChunkBytes === 40, `${header.audioFormat}/${header.fmtChunkBytes}`)
  check('extensible header names 6 channels', header.channelCount === 6, String(header.channelCount))
  check('extensible header carries the 5.1 mask', header.channelMask === 0x3f, `0x${header.channelMask.toString(16)}`)
  check('encodeAnyWav round-trips the channel count', decoded.channelCount === 6 && decoded.sampleRate === RATE, `${decoded.channelCount}/${decoded.sampleRate}`)
  let orderPreserved = true
  for (let channel = 0; channel < 6; channel += 1) {
    if (maximumDifference(decoded.channels[channel], six[channel]) > 1.5 / 8388608) orderPreserved = false
  }
  check('encodeAnyWav round-trips the channel order', orderPreserved)

  const eight = Array.from({ length: 8 }, (_, channel) => sine(480, 200 + channel * 30, 0.05))
  const eightHeader = readHeader(encodeAnyWav(eight, RATE, { bitDepth: 16 }))
  check('7.1 is written with the 7.1 mask', eightHeader.channelCount === 8 && eightHeader.channelMask === 0x63f,
    `0x${eightHeader.channelMask.toString(16)}`)

  const stereo = [sine(480, 440, 0.25), sine(480, 660, 0.25)]
  const viaAny = encodeAnyWav(stereo, RATE, { bitDepth: 16 })
  const viaEx = encodeWavEx(stereo, RATE, { bitDepth: 16 })
  check('encodeAnyWav keeps the 2-channel bytes identical', viaAny.equals(viaEx))

  let eightBitRefused = false
  try { encodeAnyWav(six, RATE, { bitDepth: 8 }) } catch { eightBitRefused = true }
  check('8-bit multichannel is refused rather than mislabelled', eightBitRefused)
  let floatRefused = false
  try { encodeAnyWav(six, RATE, { bitDepth: 32 }) } catch { floatRefused = true }
  check('32-bit float multichannel is refused (the writer is integer PCM)', floatRefused)
}

/* ---------------------------------------------------------------- the bus -- */

console.log('\n-- renderBus: 6 channels, per-channel processing, linked dynamics --')
{
  const frames = RATE
  const frequencies = [220, 260, 330, 40, 500, 620]
  const six = frequencies.map((hz) => sine(frames, hz, 0.15))
  const bus = renderBus([
    { id: 'surround', channels: six, sampleRate: RATE, chain: [{ type: 'highpass', hz: 100 }] }
  ], { channels: 6, master: { peakDbfs: null, limiter: false } })
  console.log(`  bus: ${bus.channels} ch ${bus.channelLayout} (${bus.channelNames.join(' ')}), frames ${bus.frames}, peak ${fmt(bus.master.peakDbfs)} dBFS`)
  check('renderBus honours the requested 6 channels', bus.channels === 6 && bus.master.channelSamples.length === 6, String(bus.channels))
  check('renderBus names the 5.1 layout', bus.channelLayout === '5.1' && bus.channelNames.join(' ') === 'FL FR FC LFE BL BR', bus.channelNames.join(' '))
  check('renderBus keeps the layer at 6 channels', bus.stems[0].channelCount === 6 && bus.stems[0].channels.length === 6)
  check('per-channel peaks are reported and finite', bus.master.channelPeaksDbfs.length === 6 && bus.master.channelPeaksDbfs.every((peak) => Number.isFinite(peak)))
  check('the mix gain is reported', Number.isFinite(bus.master.mixGainDb), String(bus.master.mixGainDb))
  // EQ runs per channel with independent state: each output must equal the
  // single-channel filter applied to that same input channel.
  let eqMatches = 0
  for (let channel = 0; channel < 6; channel += 1) {
    const solo = highpass({ samples: six[channel], sampleRate: RATE }, { hz: 100 })
    if (maximumDifference(solo.samples, bus.master.channelSamples[channel]) === 0) eqMatches += 1
  }
  check('EQ is applied independently per channel', eqMatches === 6, `${eqMatches}/6`)

  // A mono layer with no pan goes to the centre speaker of a surround master.
  const mono = sine(RATE / 2, 330, 0.2)
  const centred = renderBus([{ id: 'mono', samples: mono, sampleRate: RATE }], {
    channels: 6,
    master: { peakDbfs: null, limiter: false }
  })
  console.log(`  mono -> 5.1 bus: centre peak ${fmt(dbOf(peakOf(centred.master.channelSamples[2])), 2)} dBFS, fronts ${[0, 1, 4, 5].map((index) => fmt(dbOf(peakOf(centred.master.channelSamples[index])), 1)).join('/')} dBFS`)
  check('an unpanned mono layer lands in the centre', maximumDifference(centred.master.channelSamples[2], mono) === 0)
  check('an unpanned mono layer leaves the fronts silent', [0, 1, 3, 4, 5].every((index) => peakOf(centred.master.channelSamples[index]) === 0))

  // A stereo layer in a 5.1 master is upmixed with fitChannels: FL/FR keep it.
  const stereoLayer = [sine(RATE / 4, 440, 0.2), sine(RATE / 4, 660, 0.2)]
  const inferredStereo = renderBus([{ id: 'stereo', channels: stereoLayer, sampleRate: RATE }], {
    master: { peakDbfs: null, limiter: false }
  })
  console.log(`  bus with a stereo layer only: inferred ${inferredStereo.channels} ch (${inferredStereo.channelLayout})`)
  check('the bus follows the widest layer (stereo in -> stereo out)', inferredStereo.channels === 2)
  check('an inferred stereo bus keeps the stereo image', maximumDifference(inferredStereo.master.channelSamples[0], stereoLayer[0]) === 0 &&
    maximumDifference(inferredStereo.master.channelSamples[1], stereoLayer[1]) === 0)

  const upmixed = renderBus([{ id: 'stereo', channels: stereoLayer, sampleRate: RATE }], {
    channels: 6,
    master: { peakDbfs: null, limiter: false }
  })
  console.log(`  stereo -> 5.1 bus: fit ${upmixed.stems[0].fit.kind} ${upmixed.stems[0].fit.from}->${upmixed.stems[0].fit.to}, FL/FR match ${maximumDifference(upmixed.master.channelSamples[0], stereoLayer[0]) === 0}/${maximumDifference(upmixed.master.channelSamples[1], stereoLayer[1]) === 0}`)
  check('a stereo layer is upmixed, not folded', upmixed.stems[0].fit.kind === 'upmix')
  check('the stereo image stays in FL/FR', maximumDifference(upmixed.master.channelSamples[0], stereoLayer[0]) === 0 &&
    maximumDifference(upmixed.master.channelSamples[1], stereoLayer[1]) === 0)
  check('the upmixed 5.1 master has silent centre and surrounds', peakOf(upmixed.master.channelSamples[2]) === 0 && peakOf(upmixed.master.channelSamples[4]) === 0)

  // Linked compressor: one hot channel must reduce every channel by the same
  // number of dB, which is what keeps the image still.
  const hot = six.map((channel) => Float32Array.from(channel))
  hot[0] = sine(frames, 220, 0.5)
  const compressed = renderBus([
    {
      id: 'linked',
      channels: hot,
      sampleRate: RATE,
      chain: [{ type: 'compressor', thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 120, kneeDb: 0 }]
    }
  ], { channels: 6, master: { peakDbfs: null, limiter: false } })
  const gains = []
  for (let channel = 0; channel < 6; channel += 1) {
    gains.push(rmsDbWindow(compressed.master.channelSamples[channel], 0.4, 0.95) - rmsDbWindow(hot[channel], 0.4, 0.95))
  }
  const gainSpread = Math.max(...gains) - Math.min(...gains)
  console.log(`  linked compressor: max GR ${fmt(compressed.meter.gainReductionDb, 2)} dB, per-channel gain ${gains.map((gain) => fmt(gain, 2)).join(' / ')} dB, spread ${fmt(gainSpread, 4)} dB`)
  check('the linked compressor reduces every channel equally', gainSpread < 0.01, `${fmt(gainSpread, 4)} dB`)
  check('the linked compressor actually engaged', compressed.meter.gainReductionDb > 3, String(compressed.meter.gainReductionDb))

  let panRefused = false
  try {
    renderBus([{ channels: six, sampleRate: RATE, pan: -0.5 }], { channels: 6 })
  } catch (error) {
    panRefused = /pan\/width|mono layer/.test(error.message)
  }
  check('pan on a multichannel layer is refused with a reason', panRefused)

  const first = encodeAnyWav(bus.master.channelSamples, RATE, { bitDepth: 16 })
  const second = encodeAnyWav(renderBus([
    { id: 'surround', channels: frequencies.map((hz) => sine(frames, hz, 0.15)), sampleRate: RATE, chain: [{ type: 'highpass', hz: 100 }] }
  ], { channels: 6, master: { peakDbfs: null, limiter: false } }).master.channelSamples, RATE, { bitDepth: 16 })
  console.log(`  6-channel bus bytes: ${first.length} B, determinism ${first.equals(second)}`)
  check('a 6-channel bus is byte-deterministic', first.equals(second))
}

/* -------------------------------------------------------------- the master -- */

console.log('\n-- masterChain: linked multiband, ceiling on the loudest channel --')
{
  const frames = Math.round(1.5 * RATE)
  const input = [sine(frames, 12000, 1.4), sine(frames, 220, 0.1), sine(frames, 330, 0.1), sine(frames, 50, 0.2), sine(frames, 440, 0.05), sine(frames, 550, 0.05)]
  const inputPeaks = input.map((channel) => truePeak(channel, RATE))
  const hotChannel = inputPeaks.indexOf(Math.max(...inputPeaks))
  const mastered = masterChain(input, RATE, { targetLufs: -1, ceilingDbtp: -1, maxGainReductionDb: 12 })
  const output = mastered.samples
  const outputPeaks = output.map((channel) => truePeak(channel, RATE))
  const worst = Math.max(...outputPeaks)
  console.log(`  5.1 input true peaks ${inputPeaks.map((peak) => fmt(peak, 1)).join('/')} dBTP (hot ${layoutFor(6).names[hotChannel]}) -> output ${outputPeaks.map((peak) => fmt(peak, 1)).join('/')} dBTP`)
  check('master keeps 6 channels', output.length === 6, String(output.length))
  check('the ceiling holds on every channel', worst <= -1 + 1e-9, `${fmt(worst, 4)} dBTP`)
  check('the hot 5.1 master actually used the limiter', mastered.report.gainReductionDb > 0.5, String(mastered.report.gainReductionDb))
  check('the report names the worst channel', mastered.report.truePeakChannel === hotChannel, `${mastered.report.truePeakChannel} vs ${hotChannel}`)
  check('the report lists per-channel true peaks', Array.isArray(mastered.report.truePeakByChannelDbtp) && mastered.report.truePeakByChannelDbtp.length === 6)
  check('per-channel sample peaks are finite', mastered.report.channelPeaksDbfs.length === 6 && mastered.report.channelPeaksDbfs.every((peak) => Number.isFinite(peak)))
  console.log(`  report: layout ${mastered.report.channelLayout}, true peak ${fmt(mastered.report.truePeakAfter)} dBTP on ${layoutFor(6).names[mastered.report.truePeakChannel]}, loudness on ${mastered.report.loudnessChannels} ch (LFE excluded ${mastered.report.lfeExcluded}), width applied ${mastered.report.widthApplied}`)
  check('loudness is measured on the non-LFE channels', mastered.report.loudnessChannels === 5 && mastered.report.lfeExcluded === true)
  check('the width stage is bypassed for surround and says so', mastered.report.widthApplied === false && /mid\/side|passed through/.test(mastered.report.widthNote ?? ''), String(mastered.report.widthNote))

  // A channel is preserved, not merged: the tones are still where they were.
  const frequencies = [12000, 220, 330, 50, 440, 550]
  const order = dominantIndex(output, frequencies)
  console.log(`  channel order after mastering: ${order.map((index) => index).join(',')} (expected 0,1,2,3,4,5)`)
  check('mastering preserves the channel order', order.every((index, channel) => index === channel))

  const widthBypassed = stereoWidth(input, RATE, { width: 1.5, bassMonoHz: 120 })
  check('stereoWidth passes a surround layout through', widthBypassed.samples.length === 6 && widthBypassed.report.applied === false && widthBypassed.report.mode === 'multichannel')

  let threeRefused = false
  try { masterChain([input[0], input[1], input[2]], RATE, {}) } catch { threeRefused = true }
  check('mastering refuses a 3-channel layout it cannot name', threeRefused)

  const limited = truePeakLimiter(input, RATE, { ceilingDbtp: -1 })
  const limitedPeaks = limited.samples.map((channel) => truePeak(channel, RATE))
  console.log(`  standalone limiter: ${limited.samples.length} ch, peaks ${limitedPeaks.map((peak) => fmt(peak, 1)).join('/')} dBTP, worst ${fmt(Math.max(...limitedPeaks))} dBTP, channel ${limited.report.truePeakChannel}`)
  check('truePeakLimiter holds the ceiling on every channel', Math.max(...limitedPeaks) <= -1 + 1e-9)
  check('truePeakLimiter reports the worst channel', limited.report.truePeakChannel === hotChannel && limited.report.truePeakByChannelDbtp.length === 6)
}

/* ------------------------------------------------------------- round trip -- */

console.log('\n-- 7.1 spatial render -> bus -> master --')
{
  // The actual seam this work exists for: the spatial stage's 8-channel output
  // has to survive the mix bus and the master chain without being folded.
  const rendered = renderSpatial({
    sources: [{ samples: sine(RATE / 4, 440, 0.3), sampleRate: RATE, position: { azimuth: -60, distance: 1 } }],
    layout: '7.1',
    durationSeconds: 0.25,
    sampleRate: RATE,
    room: { wet: 0 }
  })
  const bus = renderBus([{ id: 'spatial', channels: rendered.channels, sampleRate: RATE }], {
    channels: 8,
    master: { peakDbfs: -1, limiter: true }
  })
  const master = masterChain(bus.master.channelSamples, RATE, { targetLufs: -20, ceilingDbtp: -1 })
  console.log(`  spatial ${rendered.channelCount} ch (${rendered.report.wavOrder}) -> bus ${bus.channels} ch (${bus.channelLayout}) -> master ${master.samples.length} ch, peaks ${master.report.channelPeaksDbfs.map((peak) => fmt(peak, 1)).join('/')} dBFS`)
  check('a spatial 7.1 render passes through the bus', rendered.channelCount === 8 && bus.channels === 8 && master.samples.length === 8)
  check('the 7.1 master respects the ceiling', master.report.truePeakAfter <= -1 + 1e-9, String(master.report.truePeakAfter))
  check('the 7.1 master reports finite per-channel peaks', master.report.channelPeaksDbfs.length === 8 && master.report.channelPeaksDbfs.every((peak) => Number.isFinite(peak)))
}

console.log('\n-- 5.1 round trip: spatial bytes -> bus -> master -> audio_convert --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-multichannel-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
registerBusTools(ctx)
registerMasterTools(ctx)
registerConvertTools(ctx)
const exec = { agent: { session: { id: 'multichannel-test' } } }
const call = (name, args) => registered.get(name).execute(args, exec)

{
  const frames = Math.round(0.8 * RATE)
  const frequencies = [220, 260, 330, 40, 500, 620]
  const source = frequencies.map((hz) => sine(frames, hz, 0.12))
  // The file the spatial stage would write: 5.1, 24-bit extensible.
  await writeFile(join(cwd, 'surround.wav'), encodeAnyWav(source, RATE, { bitDepth: 24 }))

  const busResult = await call('audio_bus', { tracks: [{ path: 'surround.wav', name: 'surround' }], channels: 6, out: 'bus.wav' })
  const busBytes = decodeWav(await readFile(join(cwd, 'bus.wav')))
  console.log(`  audio_bus: ${busResult.channels} ch, ${busResult.text.slice(0, 150)}...`)
  check('audio_bus accepts a 5.1 file and writes 5.1', busResult.channels === 6 && busBytes.channels.length === 6, String(busResult.channels))
  check('audio_bus reports the layout and per-channel peaks', busResult.channelLayout === '5.1' &&
    busResult.metrics.channelPeaksDbfs.length === 6 && busResult.metrics.channelPeaksDbfs.every((peak) => Number.isFinite(peak)))
  check('audio_bus names the surround layout in its text', /5\.1|6-ch/.test(busResult.text), busResult.text)

  const masterResult = await call('audio_master', { path: 'bus.wav', targetLufs: -20, ceilingDbtp: -1, out: 'mastered.wav' })
  const masteredBytes = decodeWav(await readFile(join(cwd, 'mastered.wav')))
  const masteredHeader = readHeader(await readFile(join(cwd, 'mastered.wav')))
  console.log(`  audio_master: ${masterResult.channels} ch, ${masterResult.text.slice(0, 170)}...`)
  check('audio_master masters a 5.1 file and writes 5.1', masterResult.channels === 6 && masteredBytes.channels.length === 6)
  check('the mastered 5.1 file keeps the extensible header', masteredHeader.audioFormat === 0xfffe && masteredHeader.channelMask === 0x3f)
  check('audio_master reports per-channel true peaks', Array.isArray(masterResult.after.truePeakByChannelDbtp) && masterResult.after.truePeakByChannelDbtp.length === 6)
  check('audio_master names the worst channel in its text', /true peak by channel/.test(masterResult.text) && /worst/.test(masterResult.text), masterResult.text)
  const wiredPeaks = masteredBytes.channels.map((channel) => truePeak(channel, masteredBytes.sampleRate))
  console.log(`  written 5.1 true peaks: ${wiredPeaks.map((peak) => fmt(peak, 1)).join('/')} dBTP`)
  check('the written 5.1 file respects the ceiling on every channel', Math.max(...wiredPeaks) <= -1 + 1e-9)

  const convertResult = await call('audio_convert', { inputs: ['mastered.wav'], op: 'convert', bitDepth: 24, out: 'converted.wav' })
  const converted = decodeWav(await readFile(join(cwd, 'converted.wav')))
  const convertedHeader = readHeader(await readFile(join(cwd, 'converted.wav')))
  console.log(`  audio_convert: ${convertResult.channels} ch ${convertResult.channelLayout}, ${convertedHeader.audioFormat === 0xfffe ? 'extensible' : 'plain'} header, mask 0x${convertedHeader.channelMask?.toString(16)}`)
  check('audio_convert defaults to keeping the 5.1 layout', convertResult.channels === 6 && converted.channels.length === 6)
  check('audio_convert writes the 5.1 channel mask', convertedHeader.audioFormat === 0xfffe && convertedHeader.channelMask === 0x3f)

  const convertedOrder = dominantIndex(converted.channels, frequencies)
  console.log(`  5.1 channel order after convert: ${convertedOrder.join(',')} (expected 0,1,2,3,4,5)`)
  check('the round trip preserves channel count and order', convertedOrder.every((index, channel) => index === channel))

  // Every pass-through op keeps the width.
  for (const [op, extra] of [
    ['trim', { start: 0.1, end: 0.3 }],
    ['gain', { gainDb: -6 }],
    ['fade', { fadeInSeconds: 0.05, fadeOutSeconds: 0.05 }]
  ]) {
    const result = await call('audio_convert', { inputs: ['surround.wav'], op, ...extra, out: `${op}.wav` })
    const decoded = decodeWav(await readFile(join(cwd, `${op}.wav`)))
    console.log(`  audio_convert ${op.padEnd(5)}: ${decoded.channels.length} ch, ${fmt(result.durationSeconds, 3)} s`)
    check(`audio_convert ${op} passes the 6 channels through`, decoded.channels.length === 6, String(decoded.channels.length))
  }
  const trimmed = decodeWav(await readFile(join(cwd, 'trim.wav')))
  check('audio_convert trim cuts every channel to the same span', Math.abs(trimmed.durationSeconds - 0.2) <= 0.002, String(trimmed.durationSeconds))

  // An explicit 2-channel request is a real downmix, LFE excluded.
  const down2 = await call('audio_convert', { inputs: ['surround.wav'], op: 'convert', channels: 2, bitDepth: 24, out: 'down2.wav' })
  const down2Bytes = decodeWav(await readFile(join(cwd, 'down2.wav')))
  const left220 = toneAmplitude(down2Bytes.channels[0], 220)
  const left330 = toneAmplitude(down2Bytes.channels[0], 330)
  const leftLfe = toneAmplitude(down2Bytes.channels[0], 40)
  const ratio330 = dbOf(left330 / left220)
  console.log(`  5.1 -> stereo: FL 220 Hz ${fmt(dbOf(left220), 2)} dBFS, FC fold 330 Hz ${fmt(ratio330, 2)} dB (expected -3.01), LFE 40 Hz ${fmt(dbOf(leftLfe), 1)} dBFS`)
  check('a 5.1 -> stereo conversion writes 2 channels', down2.channels === 2 && down2Bytes.channels.length === 2)
  check('the centre folds at -3 dB into stereo', Math.abs(ratio330 + 3.0103) <= 0.2, `${fmt(ratio330, 2)} dB`)
  check('LFE is dropped by the stereo downmix', dbOf(leftLfe) < -60, `${fmt(dbOf(leftLfe), 1)} dBFS`)

  const down1 = await call('audio_convert', { inputs: ['surround.wav'], op: 'convert', channels: 1, out: 'down1.wav' })
  const down1Bytes = decodeWav(await readFile(join(cwd, 'down1.wav')))
  const monoFl = toneAmplitude(down1Bytes.channels[0], 220)
  const monoFc = toneAmplitude(down1Bytes.channels[0], 330)
  const monoLfe = toneAmplitude(down1Bytes.channels[0], 40)
  const monoRatio = dbOf(monoFc / monoFl)
  console.log(`  5.1 -> mono: FL 220 Hz ${fmt(dbOf(monoFl), 2)} dBFS, FC fold 330 Hz ${fmt(monoRatio, 2)} dB (expected ${fmt(dbOf(Math.SQRT1_2 / 0.5), 2)}), LFE ${fmt(dbOf(monoLfe), 1)} dBFS`)
  check('a 5.1 -> mono conversion writes 1 channel', down1.channels === 1 && down1Bytes.channels.length === 1)
  check('the centre folds at -3 dB into mono', Math.abs(monoRatio - dbOf(Math.SQRT1_2 / 0.5)) <= 0.2, `${fmt(monoRatio, 2)} dB`)
  check('LFE is dropped by the mono downmix', dbOf(monoLfe) < -60, `${fmt(dbOf(monoLfe), 1)} dBFS`)

  // Honest refusals where the operation has no meaning.
  const refusals = [
    ['pan on a surround input', { inputs: ['surround.wav'], op: 'convert', channels: 2, pan: 0.5 }, /pan/],
    ['width on a surround input', { inputs: ['surround.wav'], op: 'convert', channels: 2, width: 0.5 }, /width/],
    ['8-bit surround output', { inputs: ['surround.wav'], op: 'convert', bitDepth: 8 }, /16 or 24|extensible/],
    ['concat of a surround take', { inputs: ['surround.wav', 'surround.wav'], op: 'concat' }, /concat|mono/]
  ]
  for (const [label, args, pattern] of refusals) {
    let message = null
    try { await call('audio_convert', args) } catch (error) { message = error.message }
    check(`audio_convert refuses ${label}`, message !== null && pattern.test(message), String(message))
  }

  // Stems are a mono reconstruction set: a surround bus must refuse rather than
  // write something that does not sum back to the file.
  let stemsMessage = null
  try {
    await call('audio_bus', { tracks: [{ path: 'surround.wav' }], channels: 6, stems: true, out: 'stems.wav' })
  } catch (error) {
    stemsMessage = error.message
  }
  check('audio_bus refuses stems for a surround bus', stemsMessage !== null && /stems/i.test(stemsMessage), String(stemsMessage))

  // An explicit stereo width knob on a surround master is refused, not ignored.
  let widthMessage = null
  try {
    await call('audio_master', { path: 'bus.wav', width: 1.4, out: 'width.wav' })
  } catch (error) {
    widthMessage = error.message
  }
  check('audio_master refuses an explicit stereo width on a surround input', widthMessage !== null && /width/i.test(widthMessage), String(widthMessage))
}

/* ------------------------------------------------------------ determinism -- */

console.log('\n-- determinism: the same 5.1 request twice --')
{
  const frames = Math.round(0.5 * RATE)
  const frequencies = [220, 260, 330, 40, 500, 620]
  const build = () => renderBus([
    { id: 'surround', channels: frequencies.map((hz) => sine(frames, hz, 0.12)), sampleRate: RATE, chain: [{ type: 'compressor', thresholdDb: -18, ratio: 3 }] }
  ], { channels: 6, master: { peakDbfs: -1, limiter: true } })
  const firstBus = build()
  const secondBus = build()
  const firstMaster = masterChain(firstBus.master.channelSamples, RATE, { targetLufs: -20, ceilingDbtp: -1 })
  const secondMaster = masterChain(secondBus.master.channelSamples, RATE, { targetLufs: -20, ceilingDbtp: -1 })
  const firstBytes = encodeAnyWav(firstMaster.samples, RATE, { bitDepth: 24 })
  const secondBytes = encodeAnyWav(secondMaster.samples, RATE, { bitDepth: 24 })
  console.log(`  bus peak ${fmt(firstBus.master.peakDbfs)} dBFS, master ${fmt(firstMaster.report.lufsAfter)} LUFS, bytes ${firstBytes.length}, identical ${firstBytes.equals(secondBytes)}`)
  check('the 5.1 bus+master is byte-deterministic', firstBytes.equals(secondBytes))
  check('the 5.1 report is deterministic', JSON.stringify(firstMaster.report) === JSON.stringify(secondMaster.report))
}

/* ------------------------------------------------------------ performance -- */

console.log('\n-- performance: 6 channels x 5 s render + master --')
{
  const seconds = 5
  const frames = seconds * RATE
  const frequencies = [110, 180, 260, 40, 420, 560]
  const tracks = [{
    id: 'surround',
    channels: frequencies.map((hz, channel) => sine(frames, hz, 0.12 + channel * 0.01)),
    sampleRate: RATE,
    chain: [{ type: 'highpass', hz: 80 }, { type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 15, releaseMs: 150 }]
  }]
  const started = process.hrtime.bigint()
  const bus = renderBus(tracks, { channels: 6, master: { peakDbfs: -3, limiter: true } })
  const chain = masterChain(bus.master.channelSamples, RATE, { targetLufs: -16, ceilingDbtp: -1 })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const realtime = seconds / (elapsedMs / 1000)
  const peaks = chain.samples.map((channel) => peakOf(channel))
  console.log(`  6 ch x ${seconds} s (${(frames * 6 / 1e6).toFixed(2)}M samples): ${fmt(elapsedMs, 0)} ms = ${fmt(realtime, 1)}x realtime`)
  console.log(`  master ${fmt(chain.report.lufsAfter, 2)} LUFS, true peak ${fmt(chain.report.truePeakAfter, 2)} dBTP, limiter GR ${fmt(chain.report.gainReductionDb, 1)} dB, ${chain.report.iterations} iteration(s)`)
  check('a 6-channel 5 s render + master completes', chain.samples.length === 6 && chain.samples[0].length > 0)
  check('every channel peak is finite', peaks.every((peak) => Number.isFinite(peak) && peak > 0))
  check('the 6-channel master respects the ceiling', chain.report.truePeakAfter <= -1 + 1e-9, String(chain.report.truePeakAfter))
  check('the 6-channel render+master is not pathologically slow', elapsedMs < 30000, `${fmt(elapsedMs, 0)} ms`)
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: all ${checks} multichannel checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
