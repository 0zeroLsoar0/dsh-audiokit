/**
 * `audio_mix` channel tests: the stereo image is preserved and a mono request
 * keeps its historical bytes.
 *
 * What this proves:
 *
 * 1. a stereo input keeps its image (`L != R`, and an out-of-phase pair stays
 *    out of phase instead of collapsing to silence in a mono average);
 * 2. an all-mono default request is still mono and byte-identical to the
 *    pre-stereo mixer (a frozen reference pipeline plus a SHA-256 anchor);
 * 3. stereo + mono: the mono input enters both sides at the equal-power pan
 *    gain, the stereo input is left untouched, and the L/R difference is
 *    unchanged;
 * 4. `channels: 1` reproduces the old average fold, byte for byte;
 * 5. linked peak normalisation / limiting keep the L/R ratio (per-channel
 *    processing is shown to drift, so the check is not vacuous);
 * 6. the same request twice produces identical bytes;
 * 7. a 5.1 input folds to L/R through the WAVE layout matrix with LFE dropped,
 *    for a stereo target and for a forced-mono one.
 *
 * Plus the option guards and the reported `channels` / `foldedFrom` /
 * `inputChannels` / `lfeDropped` fields.
 *
 * Run: node test/mix.mjs
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  finalizeChannels,
  measure,
  measureChannels,
  mixTracks,
  normalizeMixChannels,
  renderMix,
  resolveMixChannels
} from '../lib/audio.js'
import { addInto, dbToGain, dcBlock, normalizePeak, softLimit } from '../lib/dsp.js'
import { encodeAnyWav, fitChannels } from '../lib/multichannel.js'
import { registerTools } from '../lib/tools.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(pluginDir, 'test', 'out', 'mix')
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

const RATE = 44100
const M3 = Math.SQRT1_2
const TAU = Math.PI * 2

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const fmt = (value, digits = 2) => Number(value).toFixed(digits)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const absolute = (relativePath) => resolve(scratch, relativePath)

function sine (frames, hz, amplitude, sampleRate = RATE, phase = 0) {
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) out[index] = amplitude * Math.sin(TAU * hz * index / sampleRate + phase)
  return out
}

/** The exact fixture the byte-regression anchors were recorded with. */
function legacyFixtureA () {
  const frames = Math.round(0.6 * RATE)
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    const t = index / RATE
    out[index] = 0.4 * Math.sin(TAU * 220 * t) * Math.exp(-t * 2) + 0.2 * Math.sin(TAU * 440 * t + 0.3)
  }
  return out
}

function legacyFixtureB () {
  const frames = Math.round(0.4 * RATE)
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    const t = index / RATE
    out[index] = 0.25 * Math.sin(TAU * 330 * t) * Math.exp(-t * 3) + 0.1 * Math.sin(TAU * 550 * t)
  }
  return out
}

/** Peak of one channel over a time window, in dBFS (for the pan checks). */
function windowPeakDb (channel, sampleRate, fromSeconds, toSeconds) {
  const start = Math.max(0, Math.round(fromSeconds * sampleRate))
  const end = Math.min(channel.length, Math.round(toSeconds * sampleRate))
  let peak = 0
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(channel[index]))
  return peak > 0 ? 20 * Math.log10(peak) : -120
}

/** Normalised correlation, for the out-of-phase pair. */
function correlation (a, b) {
  let cross = 0
  let energyA = 0
  let energyB = 0
  for (let index = 0; index < a.length; index += 1) {
    cross += a[index] * b[index]
    energyA += a[index] * a[index]
    energyB += b[index] * b[index]
  }
  return energyA > 0 && energyB > 0 ? cross / Math.sqrt(energyA * energyB) : 0
}

/** Amplitude of one frequency by direct DFT: precise enough to prove a tone is absent. */
function toneAmplitude (samples, hz, sampleRate = RATE) {
  const omega = TAU * hz / sampleRate
  let real = 0
  let imaginary = 0
  for (let index = 0; index < samples.length; index += 1) {
    real += samples[index] * Math.cos(omega * index)
    imaginary += samples[index] * Math.sin(omega * index)
  }
  return 2 * Math.sqrt(real * real + imaginary * imaginary) / samples.length
}

/* ------------------------------------------------- registered tool context -- */

const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
}
const exec = { agent: { session: { id: 'mix-test' } } }
registerTools(ctx)
const call = (args) => registered.get('audio_mix').execute(args, exec)

/* ------------------------------------ the frozen pre-stereo mono pipeline -- */

/**
 * The mono mixer as it was before channels were preserved, frozen from
 * `git show HEAD:./lib/audio.js` (mixTracks -> finalize -> toWavBytes). It is
 * the reference for "an all-mono request keeps its bytes", and is kept here
 * rather than re-read from git so the check stays valid after a commit.
 *
 * The copies below are deliberately verbatim: a "cleaned up" reference would
 * no longer prove byte compatibility.
 */
function legacyResample (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = toRate / fromRate
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index / ratio
    const whole = Math.floor(position)
    const fraction = position - whole
    const a = samples[whole] ?? 0
    const b = samples[whole + 1] ?? a
    out[index] = a + (b - a) * fraction
  }
  return out
}

function legacyFrameCount (seconds, sampleRate) {
  return Math.max(16, Math.round(seconds * sampleRate))
}

function legacyAverage (channels) {
  const frames = Math.min(...channels.map((channel) => channel.length))
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index]
    out[index] = sum / channels.length
  }
  return out
}

/** Old `mixTracks` + old `finish` (`finalize`, then `toWavBytes`), exactly. */
function legacyMixBytes (tracks, options = {}) {
  const sampleRate = Math.min(96000, Math.max(8000, Math.round(options.sampleRate ?? Math.max(...tracks.map((track) => track.sampleRate)))))
  const resampled = tracks.map((input, index) => {
    const gain = dbToGain(Number(options.gains?.[index] ?? 0))
    const samples = legacyResample(input.samples, input.sampleRate, sampleRate)
    const out = new Float32Array(samples.length)
    for (let sample = 0; sample < samples.length; sample += 1) out[sample] = samples[sample] * gain
    return out
  })
  const offsets = tracks.map((_, index) => Number(options.offsets?.[index] ?? 0))
  const longest = Math.max(...resampled.map((track, index) => track.length + Math.round(offsets[index] * sampleRate)))
  const targetFrames = options.durationSeconds !== undefined && options.durationSeconds !== null
    ? legacyFrameCount(Number(options.durationSeconds), sampleRate)
    : longest
  const master = new Float32Array(targetFrames)
  resampled.forEach((track, index) => addInto(master, track, Math.round(offsets[index] * sampleRate), 1))
  const fadeIn = Math.min(Math.round((options.fadeInSeconds ?? 0) * sampleRate), targetFrames)
  const fadeOut = Math.min(Math.round((options.fadeOutSeconds ?? 0) * sampleRate), targetFrames)
  for (let index = 0; index < fadeIn; index += 1) master[index] *= index / Math.max(1, fadeIn)
  for (let index = 0; index < fadeOut; index += 1) master[targetFrames - 1 - index] *= index / Math.max(1, fadeOut)
  if (options.limiter !== false) softLimit(master)
  if (Number.isFinite(options.peakDbfs)) normalizePeak(master, Number(options.peakDbfs))
  // finish(): finalize() -> dcBlock, normalizePeak(-1), softLimit, then encode.
  dcBlock(master, sampleRate)
  normalizePeak(master, -1)
  softLimit(master)
  return encodeWav([master], sampleRate)
}

/** Decode a file the way the old `readTrack` did: average every channel. */
async function legacyReadTrack (relativePath) {
  const decoded = decodeWav(await readFile(absolute(relativePath)))
  return { samples: legacyAverage(decoded.channels), sampleRate: decoded.sampleRate }
}

/**
 * SHA-256 anchors for the two byte regressions, recorded from `legacyMixBytes`
 * on this exact fixture (stereo pair = fresh 300 Hz left / 700 Hz right).
 * `git show HEAD:./lib/audio.js` produced the same bytes when this was written.
 */
const LEGACY_MONO_SHA256 = '6e4fb8cbee387b78e51cf7205a98104c293ec2f112dc2a88051d8227ed5c1236'
const LEGACY_FOLD_SHA256 = 'a47f5f1dfccd58c7a81d2419a15cb0192def5e706f9a8e214cd8d1ca73b27329'

console.log(`audio_mix channels: lib/audio.js + lib/tools.js · ${RATE} Hz`)
console.log(`-- registered: ${[...registered.keys()].join(', ')}\n`)

/* --------------------------------------------------------- 1. the image -- */

console.log('-- 1. a stereo input keeps its image --')
{
  const frames = Math.round(0.4 * RATE)
  const left = sine(frames, 300, 0.5)
  const right = sine(frames, 700, 0.25)
  await writeFile(join(scratch, 'stereo-pair.wav'), encodeWav([left, right], RATE))

  const result = await call({ inputs: ['stereo-pair.wav'], out: 'out/stereo-keep.wav' })
  const decoded = decodeWav(await readFile(absolute('out/stereo-keep.wav')))
  const metrics = measureChannels(decoded.channels, decoded.sampleRate)
  const [leftPeak, rightPeak] = metrics.perChannel.map((channel) => channel.peakDbfs)
  const ratioDb = leftPeak - rightPeak
  let distinct = false
  for (let index = 0; index < decoded.channels[0].length; index += 1) {
    if (decoded.channels[0][index] !== decoded.channels[1][index]) { distinct = true; break }
  }
  console.log(`  out ${result.channels} ch, L/R peaks ${fmt(leftPeak)} / ${fmt(rightPeak)} dBFS, ratio ${fmt(ratioDb)} dB (input 6.02 dB)`)
  console.log(`  channels differ ${distinct}, foldedFrom ${result.foldedFrom}, inputChannels ${result.inputChannels.join('/')}`)
  check('output is a stereo file', result.channels === 2 && decoded.channels.length === 2, `${result.channels}/${decoded.channels.length}`)
  check('the result reports the width', result.foldedFrom === 2 && result.inputChannels[0] === 2 && result.lfeDropped === false)
  // The residual above the nominal 6.02 dB is the static limiter reacting to the
  // louder side's waveform on uncorrelated tones (the peaks do not coincide), not
  // an image shift: section 5 proves the per-sample ratio is exact for a panned pair.
  check('the L/R ratio survives the mix', Math.abs(ratioDb - 20 * Math.log10(2)) <= 0.3, `${fmt(ratioDb)} dB`)
  check('the channels are not a duplicated mono track', distinct)
  check('the summary names the stereo width', result.text.includes('stereo output') && result.text.includes('input channels 2'), result.text)

  // An out-of-phase pair is the case a mono average destroys outright.
  const phase = sine(frames, 440, 0.4)
  const inverted = phase.map((value) => -value)
  await writeFile(join(scratch, 'stereo-inverted.wav'), encodeWav([phase, inverted], RATE))
  const invertedResult = await call({ inputs: ['stereo-inverted.wav'], out: 'out/stereo-inverted-out.wav' })
  const invertedDecoded = decodeWav(await readFile(absolute('out/stereo-inverted-out.wav')))
  const [invertedLeft, invertedRight] = invertedDecoded.channels
  const invertedCorrelation = correlation(invertedLeft, invertedRight)
  const foldPeak = measure(leftRightFold(invertedLeft, invertedRight), RATE).peakDbfs
  const monoFold = measure(legacyAverage([invertedLeft, invertedRight]), RATE)
  console.log(`  out-of-phase pair: L/R correlation ${fmt(invertedCorrelation, 4)}, mono fold of the output ${fmt(foldPeak)} dBFS, mono fold of the input ${fmt(monoFold.peakDbfs)} dBFS`)
  check('an out-of-phase pair survives', Math.max(...invertedLeft.map(Math.abs)) > 0.1 && invertedCorrelation < -0.999,
    `${fmt(invertedCorrelation, 4)}`)
  check('the old mono fold would have cancelled it', monoFold.peakDbfs < -40, `${fmt(monoFold.peakDbfs)} dBFS`)
  check('out-of-phase result is stereo', invertedResult.channels === 2)
}

/** The mono fold of a stereo pair, without the imported helper's averaging error. */
function leftRightFold (left, right) {
  const out = new Float32Array(Math.min(left.length, right.length))
  for (let index = 0; index < out.length; index += 1) out[index] = (left[index] + right[index]) / 2
  return out
}

/* --------------------------------- 2. mono default is byte-compatible -- */

console.log('\n-- 2. all-mono default: still mono, same bytes as before --')
{
  await writeFile(join(scratch, 'mono-a.wav'), encodeWav([legacyFixtureA()], RATE))
  await writeFile(join(scratch, 'mono-b.wav'), encodeWav([legacyFixtureB()], RATE))
  const result = await call({
    inputs: ['mono-a.wav', 'mono-b.wav'],
    gains: [-3, -6],
    offsets: [0, 0.11],
    peakDbfs: -1,
    limiter: true,
    out: 'out/mono-default.wav'
  })
  const bytes = await readFile(absolute('out/mono-default.wav'))
  const legacyBytes = legacyMixBytes(
    [await legacyReadTrack('mono-a.wav'), await legacyReadTrack('mono-b.wav')],
    { gains: [-3, -6], offsets: [0, 0.11], peakDbfs: -1, limiter: true }
  )
  const decoded = decodeWav(bytes)
  console.log(`  out ${result.channels} ch (${decoded.channels.length} in file), ${bytes.length} B, sha256 ${sha256(bytes)}`)
  console.log(`  frozen legacy pipeline      ${legacyBytes.length} B, sha256 ${sha256(legacyBytes)}`)
  check('default all-mono output is mono', result.channels === 1 && decoded.channels.length === 1, `${result.channels}/${decoded.channels.length}`)
  check('result reports mono width', result.foldedFrom === 1 && result.inputChannels.join('/') === '1/1' && result.lfeDropped === false)
  check('bytes match the frozen legacy pipeline', bytes.equals(legacyBytes), `${sha256(bytes)} != ${sha256(legacyBytes)}`)
  check('bytes match the recorded legacy sha256', sha256(bytes) === LEGACY_MONO_SHA256, `${sha256(bytes)} != ${LEGACY_MONO_SHA256}`)
  check('the summary says mono', result.text.includes('mono output') && result.text.includes('input channels 1/1'), result.text)
}

/* ------------------------------------- 3. stereo + mono: both sides -- */

console.log('\n-- 3. stereo + mono: the mono input enters both sides, the stereo stays --')
{
  const frames = Math.round(0.4 * RATE)
  const monoFrames = Math.round(0.15 * RATE)
  const left = sine(frames, 300, 0.5)
  const right = sine(frames, 700, 0.25)
  const mono = sine(monoFrames, 1200, 0.3)
  const mixed = renderMix(
    [{ channels: [left, right], sampleRate: RATE }, { samples: mono, sampleRate: RATE }],
    { limiter: false }
  )

  let tailSame = true
  for (let index = monoFrames; index < frames; index += 1) {
    if (mixed.channels[0][index] !== left[index] || mixed.channels[1][index] !== right[index]) { tailSame = false; break }
  }
  let panGainError = 0
  let imageError = 0
  for (let index = 0; index < monoFrames; index += 1) {
    const leftContribution = mixed.channels[0][index] - left[index]
    const rightContribution = mixed.channels[1][index] - right[index]
    panGainError = Math.max(panGainError, Math.abs(leftContribution - mono[index] * M3), Math.abs(rightContribution - mono[index] * M3))
    imageError = Math.max(imageError, Math.abs((mixed.channels[0][index] - mixed.channels[1][index]) - (left[index] - right[index])))
  }
  console.log(`  tail identical to the stereo input: ${tailSame}; mono gain error ${panGainError.toExponential(2)} (expected -3.01 dB per side)`)
  console.log(`  L-R difference error ${imageError.toExponential(2)} (the stereo image is untouched)`)
  check('the mono input is placed at -3 dB per side', panGainError <= 1e-6, panGainError.toExponential(2))
  check('the stereo image is unchanged', tailSame && imageError <= 1e-6, `${tailSame}/${imageError.toExponential(2)}`)

  // The same statement through the real tool and real files.
  await writeFile(join(scratch, 'mono-tail.wav'), encodeWav([sine(Math.round(0.15 * RATE), 1200, 0.3)], RATE))
  await call({
    inputs: ['stereo-pair.wav', 'mono-tail.wav'],
    gains: [0, -6],
    offsets: [0, 0.5],
    out: 'out/stereo-plus-mono.wav'
  })
  const decoded = decodeWav(await readFile(absolute('out/stereo-plus-mono.wav')))
  const [outLeft, outRight] = decoded.channels
  const stereoOnlyRatio = windowPeakDb(outLeft, RATE, 0.05, 0.35) - windowPeakDb(outRight, RATE, 0.05, 0.35)
  let monoPairError = 0
  const monoStart = Math.round(0.53 * RATE)
  const monoEnd = Math.round(0.63 * RATE)
  for (let index = monoStart; index < monoEnd; index += 1) monoPairError = Math.max(monoPairError, Math.abs(outLeft[index] - outRight[index]))
  console.log(`  file: ${decoded.channels.length} ch; stereo-only L/R ${fmt(stereoOnlyRatio)} dB; mono-only |L-R| ${monoPairError.toExponential(2)}`)
  check('the tool writes stereo for a stereo + mono mix', decoded.channels.length === 2)
  check('the stereo part is not folded or panned', Math.abs(stereoOnlyRatio - 20 * Math.log10(2)) <= 0.2, `${fmt(stereoOnlyRatio)} dB`)
  check('the mono part is equal in both channels', monoPairError < 2e-3, monoPairError.toExponential(2))
}

/* ------------------------------- 4. channels:1 is the old average fold -- */

console.log('\n-- 4. channels: 1 reproduces the old average fold --')
{
  const frames = Math.round(0.4 * RATE)
  const left = sine(frames, 300, 0.5)
  const right = sine(frames, 700, 0.25)
  const folded = mixTracks([{ channels: [left, right], sampleRate: RATE }], { channels: 1, limiter: false })
  const expected = legacyAverage([left, right])
  let same = folded.samples.length === expected.length
  let maxDifference = 0
  for (let index = 0; same && index < expected.length; index += 1) {
    if (folded.samples[index] !== expected[index]) { same = false; maxDifference = Math.abs(folded.samples[index] - expected[index]) }
  }
  console.log(`  api: ${folded.channelCount} ch, frames ${folded.samples.length}, bit-identical to the average: ${same}`)
  check('channels:1 returns one channel', folded.channelCount === 1 && folded.samples.length === frames)
  check('channels:1 is the average fold, bit for bit', same, `first difference ${maxDifference}`)

  const result = await call({ inputs: ['stereo-pair.wav'], channels: 1, out: 'out/fold-mono.wav' })
  const bytes = await readFile(absolute('out/fold-mono.wav'))
  const legacyBytes = legacyMixBytes([await legacyReadTrack('stereo-pair.wav')], { peakDbfs: -1 })
  console.log(`  file: ${result.channels} ch (${bytes.length} B), legacy ${legacyBytes.length} B, sha256 ${sha256(bytes)}`)
  check('channels:1 writes a mono file', result.channels === 1 && decodeWav(bytes).channels.length === 1)
  check('channels:1 bytes match the old fold', bytes.equals(legacyBytes), `${sha256(bytes)} != ${sha256(legacyBytes)}`)
  check('channels:1 bytes match the recorded sha256', sha256(bytes) === LEGACY_FOLD_SHA256, `${sha256(bytes)} != ${LEGACY_FOLD_SHA256}`)

  // The numeric string the host may send is accepted and means the same thing.
  const stringResult = await call({ inputs: ['stereo-pair.wav'], channels: '1', out: 'out/fold-mono-string.wav' })
  check('channels:"1" is accepted and identical', stringResult.channels === 1 && (await readFile(absolute('out/fold-mono-string.wav'))).equals(bytes))
  check('resolveMixChannels: mono only -> mono width', resolveMixChannels([{ samples: left, sampleRate: RATE }, { samples: right, sampleRate: RATE }]) === 1)
  check('resolveMixChannels: any stereo -> stereo width', resolveMixChannels([{ samples: left, sampleRate: RATE }, { channels: [left, right], sampleRate: RATE }]) === 2)
  check('resolveMixChannels: an explicit choice wins', resolveMixChannels([{ channels: [left, right], sampleRate: RATE }], 1) === 1)
}

/* ------------------------- 4b. channels:2 places an all-mono mix there -- */

console.log('\n-- 4b. channels: 2 places a mono source on both sides --')
{
  const frames = Math.round(0.3 * RATE)
  const mono = sine(frames, 500, 0.4)
  const stereo = renderMix([{ samples: mono, sampleRate: RATE }], { channels: 2, limiter: false })
  let placementError = 0
  let duplicated = true
  for (let index = 0; index < frames; index += 1) {
    placementError = Math.max(placementError, Math.abs(stereo.channels[0][index] - mono[index] * M3), Math.abs(stereo.channels[1][index] - mono[index] * M3))
    if (stereo.channels[0][index] !== stereo.channels[1][index]) duplicated = false
  }
  console.log(`  api: ${stereo.channelCount} ch, gain error vs -3.01 dB per side ${placementError.toExponential(2)}, channels identical ${duplicated}`)
  check('channels:2 forces stereo', stereo.channelCount === 2 && stereo.foldedFrom === 1 && stereo.inputChannels.join('/') === '1')
  check('a mono source is placed at -3 dB per side', placementError <= 1e-6, placementError.toExponential(2))
  check('a mono source is the same in both channels', duplicated)

  const result = await call({ inputs: ['mono-a.wav'], channels: 2, out: 'out/forced-stereo.wav' })
  const decoded = decodeWav(await readFile(absolute('out/forced-stereo.wav')))
  let pairError = 0
  let pairPeak = 0
  for (let index = 0; index < decoded.channels[0].length; index += 1) {
    pairError = Math.max(pairError, Math.abs(decoded.channels[0][index] - decoded.channels[1][index]))
    pairPeak = Math.max(pairPeak, Math.abs(decoded.channels[0][index]))
  }
  console.log(`  file: ${result.channels} ch, foldedFrom ${result.foldedFrom}, |L-R| max ${pairError.toExponential(2)}, peak ${fmt(20 * Math.log10(pairPeak))} dBFS`)
  check('the tool writes stereo for a forced-mono request', result.channels === 2 && decoded.channels.length === 2)
  check('the two sides carry the same mono signal', pairError < 2e-3 && pairPeak > 0.1, `${pairError.toExponential(2)}`)
}

/* ------------------- 5. linked normalisation / limiting keep the ratio -- */

console.log('\n-- 5. linked normalisation and limiting keep the L/R ratio --')
{
  const frames = 4096
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    left[index] = 1.7 * Math.sin(TAU * 200 * index / RATE)
    right[index] = left[index] * 0.5
  }
  const mixed = renderMix([{ channels: [left, right], sampleRate: RATE }], { limiter: true, peakDbfs: 0 })
  let ratioError = 0
  let peak = 0
  for (let index = 0; index < frames; index += 1) {
    const magnitude = Math.abs(mixed.channels[0][index])
    peak = Math.max(peak, magnitude, Math.abs(mixed.channels[1][index]))
    if (magnitude > 1e-4) ratioError = Math.max(ratioError, Math.abs(mixed.channels[1][index] / mixed.channels[0][index] - 0.5))
  }
  console.log(`  after linked limit + normalise: peak ${fmt(20 * Math.log10(peak))} dBFS (target 0), max ratio error ${ratioError.toExponential(2)}`)
  check('the linked limiter keeps the pan ratio', ratioError <= 1e-6, ratioError.toExponential(2))
  check('the peak lands on the requested level', Math.abs(peak - 1) <= 0.01, `${fmt(peak, 4)}`)

  const finalized = finalizeChannels(mixed.channels.map((channel) => channel.slice()), RATE, -1)
  let finalRatioError = 0
  for (let index = 0; index < frames; index += 1) {
    if (Math.abs(finalized[0][index]) <= 1e-4) continue
    finalRatioError = Math.max(finalRatioError, Math.abs(finalized[1][index] / finalized[0][index] - 0.5))
  }
  const finalPeak = Math.max(...finalized[0].map(Math.abs), ...finalized[1].map(Math.abs))
  console.log(`  after finalizeChannels: peak ${fmt(20 * Math.log10(finalPeak))} dBFS (target -1), max ratio error ${finalRatioError.toExponential(2)}`)
  check('finalizeChannels keeps the pan ratio', finalRatioError <= 1e-6, finalRatioError.toExponential(2))
  check('finalizeChannels normalises the file peak', Math.abs(20 * Math.log10(finalPeak) + 1) <= 0.05, `${fmt(20 * Math.log10(finalPeak))} dBFS`)

  // The counterfactual: a per-channel waveshaper drifts the image, so the
  // assertion above is a real one.
  const naiveLeft = left.slice()
  const naiveRight = right.slice()
  softLimit(naiveLeft)
  softLimit(naiveRight)
  let naiveError = 0
  for (let index = 0; index < frames; index += 1) {
    if (Math.abs(naiveLeft[index]) <= 0.9) continue
    naiveError = Math.max(naiveError, Math.abs(naiveRight[index] / naiveLeft[index] - 0.5))
  }
  console.log(`  per-channel (unlinked) limiting would drift by ${naiveError.toExponential(2)}; linked is ${ratioError.toExponential(2)}`)
  check('the unlinked counterfactual really drifts', naiveError > 1e-3, naiveError.toExponential(2))
}

/* ----------------------------------------------------- 6. determinism -- */

console.log('\n-- 6. determinism --')
{
  const args = { inputs: ['stereo-pair.wav', 'mono-tail.wav'], gains: [-2, -9], offsets: [0, 0.1], out: 'out/deterministic.wav' }
  const first = await call(args)
  const firstBytes = await readFile(absolute('out/deterministic.wav'))
  const second = await call(args)
  const secondBytes = await readFile(absolute('out/deterministic.wav'))
  const api = renderMix([{ channels: [sine(2048, 300, 0.3), sine(2048, 500, 0.15)], sampleRate: RATE }], { limiter: true, peakDbfs: -1 })
  const apiAgain = renderMix([{ channels: [sine(2048, 300, 0.3), sine(2048, 500, 0.15)], sampleRate: RATE }], { limiter: true, peakDbfs: -1 })
  let apiIdentical = api.channels[0].every((value, index) => value === apiAgain.channels[0][index])
  apiIdentical = apiIdentical && api.channels[1].every((value, index) => value === apiAgain.channels[1][index])
  console.log(`  tool bytes ${first.bytes} -> sha256 ${sha256(firstBytes)}, twice: ${sha256(secondBytes)}`)
  check('the same request twice writes identical bytes', firstBytes.equals(secondBytes))
  check('renderMix is deterministic', apiIdentical)
  check('the tool result is stable', first.channels === second.channels && first.foldedFrom === second.foldedFrom)
}

/* ------------------------------------------------- 7. 5.1 folds, no LFE -- */

console.log('\n-- 7. a 5.1 input folds to L/R with LFE dropped --')
{
  const frames = Math.round(0.5 * RATE)
  const amplitudes = [0.3, 0.2, 0.15, 0.8, 0.12, 0.1]
  const frequencies = [200, 300, 400, 1000, 500, 600]
  const surround = frequencies.map((hz, index) => sine(frames, hz, amplitudes[index]))
  await writeFile(join(scratch, 'surround-51.wav'), encodeAnyWav(surround, RATE, { bitDepth: 16 }))
  const fileChannels = decodeWav(await readFile(join(scratch, 'surround-51.wav'))).channels
  check('the fixture really is 5.1', fileChannels.length === 6, `${fileChannels.length}`)

  // Level-independent proof: zeroing the LFE channel changes nothing at all.
  const withoutLfe = fileChannels.map((channel, index) => (index === 3 ? new Float32Array(channel.length) : channel))
  const withLfeMix = renderMix([{ channels: fileChannels, sampleRate: RATE }], { limiter: false })
  const withoutLfeMix = renderMix([{ channels: withoutLfe, sampleRate: RATE }], { limiter: false })
  const lfeIrrelevant = withLfeMix.channels.every((channel, channelIndex) =>
    channel.every((value, index) => value === withoutLfeMix.channels[channelIndex][index]))
  // And the fold is the documented layout matrix: L = FL + FC*M3 + BL*M3.
  let matrixError = 0
  for (let index = 0; index < frames; index += 1) {
    const expectedLeft = fileChannels[0][index] + fileChannels[2][index] * M3 + fileChannels[4][index] * M3
    const expectedRight = fileChannels[1][index] + fileChannels[2][index] * M3 + fileChannels[5][index] * M3
    matrixError = Math.max(matrixError, Math.abs(withLfeMix.channels[0][index] - expectedLeft), Math.abs(withLfeMix.channels[1][index] - expectedRight))
  }
  console.log(`  raw fold: ${withLfeMix.channelCount} ch, LFE changes bytes: ${!lfeIrrelevant}, matrix error ${matrixError.toExponential(2)}`)
  check('a 5.1 input folds to stereo', withLfeMix.channelCount === 2 && withLfeMix.inputChannels[0] === 6 && withLfeMix.foldedFrom === 6)
  check('the fold reports the dropped LFE', withLfeMix.lfeDropped === true)
  check('LFE contributes nothing to the fold', lfeIrrelevant)
  check('the fold uses the WAVE layout matrix', matrixError <= 1e-6, matrixError.toExponential(2))

  // A forced mono fold drops LFE too.
  const monoWithLfe = renderMix([{ channels: fileChannels, sampleRate: RATE }], { channels: 1, limiter: false })
  const monoWithoutLfe = renderMix([{ channels: withoutLfe, sampleRate: RATE }], { channels: 1, limiter: false })
  const monoSame = monoWithLfe.channels[0].every((value, index) => value === monoWithoutLfe.channels[0][index])
  check('a forced mono fold also drops LFE', monoSame && monoWithLfe.channelCount === 1 && monoWithLfe.lfeDropped === true)

  // Through the real tool: the output file must not contain the 1000 Hz LFE tone.
  const result = await call({ inputs: ['surround-51.wav'], out: 'out/surround-fold.wav' })
  const decoded = decodeWav(await readFile(absolute('out/surround-fold.wav')))
  const [outLeft, outRight] = decoded.channels
  const lfeLeft = toneAmplitude(outLeft, 1000)
  const lfeRight = toneAmplitude(outRight, 1000)
  const frontLeft = toneAmplitude(outLeft, 200)
  const frontRight = toneAmplitude(outRight, 300)
  console.log(`  tool: ${result.channels} ch, foldedFrom ${result.foldedFrom}, inputChannels ${result.inputChannels.join('/')}, lfeDropped ${result.lfeDropped}`)
  console.log(`  1000 Hz LFE residual L ${lfeLeft.toExponential(2)} / R ${lfeRight.toExponential(2)}; front tones ${fmt(frontLeft)} / ${fmt(frontRight)}`)
  check('the tool reports the 5.1 fold', result.channels === 2 && result.foldedFrom === 6 && result.inputChannels[0] === 6 && result.lfeDropped === true)
  check('the summary says the LFE was dropped', result.text.includes('LFE dropped'), result.text)
  check('no LFE tone reaches the stereo file', lfeLeft < 1e-3 && lfeRight < 1e-3, `${lfeLeft.toExponential(2)}/${lfeRight.toExponential(2)}`)
  check('the front channels are present', frontLeft > 0.02 && frontRight > 0.02, `${fmt(frontLeft)}/${fmt(frontRight)}`)
}

/* ---------------------------------------------------------------- guards -- */

console.log('\n-- option guards --')
{
  check('normalizeMixChannels defaults to auto', normalizeMixChannels(undefined) === 'auto' && normalizeMixChannels('auto') === 'auto')
  check('normalizeMixChannels accepts 1, 2 and their strings', normalizeMixChannels(1) === 1 && normalizeMixChannels('2') === 2)
  for (const value of [0, 3, 'x', true]) {
    let rejected = false
    try { normalizeMixChannels(value) } catch (error) { rejected = /channels/.test(error.message) }
    check(`normalizeMixChannels rejects ${JSON.stringify(value)}`, rejected)
  }
  let message = ''
  try { await call({ inputs: ['stereo-pair.wav'], channels: 3 }) } catch (error) { message = error.message }
  check('the tool rejects channels:3 before reading', /channels/.test(message) && /auto/.test(message), message)
  message = ''
  try { await call({ inputs: ['does-not-exist.wav'], channels: 7 }) } catch (error) { message = error.message }
  check('a bad channels value is rejected before any file is opened', /channels/.test(message), message)
}

console.log(failures === 0 ? `\nOK: all ${checks} audio_mix channel checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
