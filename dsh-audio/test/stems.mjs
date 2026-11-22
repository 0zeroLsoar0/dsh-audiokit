/**
 * Stem export tests.
 *
 * What this proves, with numbers rather than claims:
 *
 * - four tracks with different gains and offsets become four frame-aligned
 *   stems plus a master, and the master is the sum of the stems (measured error,
 *   asserted under 1e-6);
 * - each stem's peak is its source peak plus its gain, and its content starts at
 *   exactly round(offset * rate), sample for sample;
 * - 8-bit and 24-bit encodes decode back within their quantisation step, and
 *   stereo interleaving is L,R per frame with identical channels;
 * - two runs produce identical SHA-256 for every file;
 * - a missing outDir is created and a bad track path names the file;
 * - a realistic 8 tracks x 5 s set is timed.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalize, measure, renderPreset } from '../lib/audio.js'
import { dbToGain, makeRng } from '../lib/dsp.js'
import { STEM_LIMITS, packageStems, planStems, renderStems } from '../lib/stems.js'
import { registerStemsTools } from '../lib/tools-stems.js'
import { decodeWav } from '../lib/wav.js'

const outRoot = fileURLToPath(new URL('./out/stems/', import.meta.url))
await rm(outRoot, { recursive: true, force: true })
await mkdir(outRoot, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const fmt = (value, digits = 2) => Number(value).toFixed(digits)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function exists (path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function renderTrack (preset, seed, duration, sampleRate = 44100) {
  const rendered = renderPreset({ preset, seed, duration, sampleRate })
  // Match what audio_synth writes: DC block, -1 dBFS peak, soft limit.
  finalize(rendered.samples, rendered.sampleRate, -1)
  return rendered.samples
}

/** Decode a file and compare channel 0 against the rendered stem. */
function quantisation (bytes, renderedSamples) {
  const decoded = decodeWav(bytes)
  const channel = decoded.channels[0]
  let maxAbsError = 0
  let sumSquares = 0
  const frames = Math.min(channel.length, renderedSamples.length)
  for (let index = 0; index < frames; index += 1) {
    const error = channel[index] - renderedSamples[index]
    const magnitude = Math.abs(error)
    if (magnitude > maxAbsError) maxAbsError = magnitude
    sumSquares += error * error
  }
  return {
    decoded,
    frames,
    channels: decoded.channels.length,
    sampleRate: decoded.sampleRate,
    maxAbsError,
    rmsError: Math.sqrt(sumSquares / Math.max(1, frames))
  }
}

/* -------------------------------------------------------------- fixtures -- */

const sampleRate = 44100
const tracks = [
  { id: 'impact', samples: renderTrack('impact', 11, 0.6), sampleRate, gainDb: 0, offsetSeconds: 0 },
  { id: 'chime', samples: renderTrack('chime', 12, 0.8), sampleRate, gainDb: -6, offsetSeconds: 0.25 },
  { id: 'whoosh', samples: renderTrack('whoosh', 13, 0.5), sampleRate, gainDb: -3, offsetSeconds: 0.5 },
  { id: 'zap', samples: renderTrack('zap', 14, 0.3), sampleRate, gainDb: -12, offsetSeconds: 0.1 }
]
const pureMaster = { peakDbfs: null, limiter: false }
const expectedFrames = Math.round(1.05 * sampleRate)

console.log(`node ${process.version} · sampleRate ${sampleRate}`)
for (const track of tracks) {
  const metrics = measure(track.samples, track.sampleRate)
  console.log(`  source ${track.id.padEnd(7)} ${track.samples.length} frames  peak ${fmt(metrics.peakDbfs)} dBFS  gain ${track.gainDb} dB  offset ${track.offsetSeconds}s`)
}

/* ------------------------------------------------------------------ plan -- */

console.log('\n-- plan --')
const plan = planStems({ tracks, sampleRate, master: pureMaster })
console.log(`resolved rate=${plan.sampleRate} Hz tracks=${plan.stems.length} frames=${plan.frames} duration=${fmt(plan.durationSeconds, 6)}s`)
console.log(`budget: estimatedSumPeakDbfs=${plan.budget.estimatedSumPeakDbfs} assumedFullScaleTracks=${plan.budget.assumedFullScaleTracks} masterNormaliseDb=${plan.budget.masterNormaliseDb}`)
check('plan: 4 stems', plan.stems.length === 4)
check('plan: resolved rate', plan.sampleRate === 44100)
check('plan: timeline frames', plan.frames === expectedFrames, `${plan.frames} != ${expectedFrames}`)
check('plan: master mirrors timeline', plan.master.frames === expectedFrames && plan.master.limiter === false && plan.master.peakDbfs === null)
check('plan: every stem spans the timeline', plan.stems.every((stem) => stem.durationSeconds === plan.durationSeconds))
for (const track of tracks) {
  const stem = plan.stems.find((entry) => entry.id === track.id)
  const expectedStart = Math.round(track.offsetSeconds * sampleRate)
  console.log(`  ${track.id.padEnd(7)} startFrame=${String(stem.startFrame).padStart(6)} (expected ${expectedStart})  file=${fmt(stem.durationSeconds, 3)}s  source=${fmt(stem.sourceDurationSeconds, 3)}s`)
  check(`plan: ${track.id} offset`, stem.startFrame === expectedStart, `${stem.startFrame} != ${expectedStart}`)
}

console.log('-- plan: rejects nonsense --')
try {
  planStems({ tracks: [{ samples: tracks[0].samples, sampleRate, gainDb: 30 }] })
  check('plan: gain guard', false)
} catch (error) {
  console.log(`  gain guard: ${error.message}`)
  check('plan: gain guard', /gainDb/.test(error.message))
}
try {
  planStems({ tracks: [{ samples: tracks[0].samples, sampleRate }], master: { peakDbfs: 6 } })
  check('plan: peak guard', false)
} catch (error) {
  console.log(`  peak guard: ${error.message}`)
  check('plan: peak guard', /master\.peakDbfs/.test(error.message))
}

/* --------------------------------------------------------------- render -- */

console.log('\n-- render: master bypassed (pure stems) --')
const pure = renderStems(tracks, { sampleRate, master: pureMaster })
console.log(`stems=${pure.stems.length} frames=${pure.reconstruction.frames} duration=${fmt(pure.reconstruction.durationSeconds, 6)}s`)
console.log(`reconstruction: maxAbsError=${pure.reconstruction.maxAbsError.toExponential(3)} sumPeakDbfs=${pure.reconstruction.sumPeakDbfs} preMasterPeakDbfs=${pure.reconstruction.preMasterPeakDbfs} masterGainDb=${pure.reconstruction.masterGainDb}`)
check('render: 4 stems + master', pure.stems.length === 4 && pure.master.samples.length === expectedFrames)
check('render: aligned lengths', pure.stems.every((stem) => stem.samples.length === expectedFrames && stem.sampleRate === sampleRate))
check('render: master equals sum of stems (< 1e-6)', pure.reconstruction.maxAbsError < 1e-6, `error=${pure.reconstruction.maxAbsError}`)
check('render: master is metadata-complete', pure.master.metrics.sampleRate === sampleRate && typeof pure.master.metrics.peakDbfs === 'number')

console.log('-- render: gain accuracy and offset placement --')
for (let index = 0; index < tracks.length; index += 1) {
  const track = tracks[index]
  const stem = pure.stems[index]
  const gain = dbToGain(track.gainDb)
  const sourcePeak = measure(track.samples, track.sampleRate).peakDbfs
  const stemPeak = measure(stem.samples, sampleRate).peakDbfs
  const delta = stemPeak - (sourcePeak + track.gainDb)
  const start = Math.round(track.offsetSeconds * sampleRate)

  let leadIn = 0
  for (let frame = 0; frame < start; frame += 1) if (stem.samples[frame] !== 0) leadIn += 1
  let exact = 0
  let mismatched = 0
  for (let frame = 0; frame < track.samples.length; frame += 1) {
    const expected = Math.fround(track.samples[frame] * gain)
    if (stem.samples[start + frame] === expected) exact += 1
    else mismatched += 1
  }
  const tailStart = start + track.samples.length
  let padding = 0
  for (let frame = tailStart; frame < stem.samples.length; frame += 1) if (stem.samples[frame] !== 0) padding += 1

  console.log(`  ${track.id.padEnd(7)} source peak ${fmt(sourcePeak)} dB + gain ${String(track.gainDb).padStart(3)} dB = ${fmt(sourcePeak + track.gainDb)} dB -> stem ${fmt(stemPeak)} dB (delta ${fmt(delta, 3)} dB)`)
  console.log(`  ${''.padEnd(7)} offset ${track.offsetSeconds}s -> startFrame ${start}: lead-in non-zero=${leadIn}, shifted samples exact=${exact}/${track.samples.length}, tail non-zero=${padding}`)
  check(`render: ${track.id} peak matches gain`, Math.abs(delta) <= 0.5, `delta=${delta} dB`)
  check(`render: ${track.id} offset shifts samples exactly`, exact === track.samples.length && mismatched === 0, `exact=${exact} mismatch=${mismatched}`)
  check(`render: ${track.id} starts at startFrame`, stem.samples[start] === Math.fround(track.samples[0] * gain))
  check(`render: ${track.id} zero before and after`, leadIn === 0 && padding === 0, `leadIn=${leadIn} padding=${padding}`)
  check(`render: ${track.id} plan startFrame`, stem.startFrame === start)
}

console.log('-- render: master bus normalisation is one shared gain --')
const normalised = renderStems(tracks, { sampleRate, master: { peakDbfs: -6, limiter: false } })
console.log(`masterGainDb=${normalised.reconstruction.masterGainDb} preMasterPeakDbfs=${normalised.reconstruction.preMasterPeakDbfs} -> masterPeakDbfs=${normalised.master.metrics.peakDbfs}`)
console.log(`reconstruction: maxAbsError=${normalised.reconstruction.maxAbsError.toExponential(3)} sumPeakDbfs=${normalised.reconstruction.sumPeakDbfs}`)
check('normalise: master peak at -6 dBFS', Math.abs(normalised.master.metrics.peakDbfs + 6) < 0.02, `peak=${normalised.master.metrics.peakDbfs}`)
check('normalise: master equals sum of stems', normalised.reconstruction.maxAbsError < 1e-6)
for (let index = 0; index < tracks.length; index += 1) {
  const before = measure(pure.stems[index].samples, sampleRate).peakDbfs
  const after = measure(normalised.stems[index].samples, sampleRate).peakDbfs
  const shifted = after - before
  console.log(`  ${tracks[index].id.padEnd(7)} stem peak ${fmt(before)} dB -> ${fmt(after)} dB (moved ${fmt(shifted, 3)} dB, master gain ${fmt(normalised.reconstruction.masterGainDb)} dB)`)
  check(`normalise: ${tracks[index].id} follows master gain`, Math.abs(shifted - normalised.reconstruction.masterGainDb) <= 0.05, `shift=${shifted}`)
}

console.log('-- render: limiter engages but the master still reconstructs --')
const hotTracks = tracks.map((track, index) => ({ ...track, gainDb: [6, 0, 9, -6][index] }))
const limited = renderStems(hotTracks, { master: { peakDbfs: -1, limiter: true } })
console.log(`limiterEngaged=${limited.reconstruction.limiterEngaged} masterGainDb=${limited.reconstruction.masterGainDb} preMasterPeakDbfs=${limited.reconstruction.preMasterPeakDbfs} masterPeakDbfs=${limited.master.metrics.peakDbfs}`)
console.log(`reconstruction: maxAbsError=${limited.reconstruction.maxAbsError.toExponential(3)} sumPeakDbfs=${limited.reconstruction.sumPeakDbfs}`)
check('limiter: engaged on a hot mix', limited.reconstruction.limiterEngaged === true)
check('limiter: master peak at -1 dBFS', Math.abs(limited.master.metrics.peakDbfs + 1) < 0.02, `peak=${limited.master.metrics.peakDbfs}`)
check('limiter: master equals sum of stems', limited.reconstruction.maxAbsError < 1e-6)

/* ------------------------------------------------------------ packaging -- */

function perFileReport (packaged, label) {
  console.log(`-- package: ${label} --`)
  for (const file of packaged.files) {
    console.log(`  ${file.file.padEnd(14)} ${String(file.bytes).padStart(8)} bytes  ${fmt(file.durationSeconds, 3)}s  peak ${fmt(file.peakDbfs)} dBFS  rms ${fmt(file.rmsDbfs)} dBFS  sha256 ${file.sha256.slice(0, 12)}`)
  }
  console.log(`  ${'stems.json'.padEnd(14)} ${String(packaged.manifest === null ? 0 : packaged.manifest.bytes).padStart(8)} bytes  sha256 ${packaged.manifest === null ? '-' : packaged.manifest.sha256.slice(0, 12)}`)
  console.log(`  total ${packaged.totalBytes} bytes (${fmt(packaged.totalBytes / 1024, 1)} KB) · ${packaged.bitDepth}-bit ${packaged.channels === 2 ? 'stereo' : 'mono'} ${packaged.sampleRate} Hz · ${packaged.frames} frames · ${fmt(packaged.durationSeconds, 6)}s`)
}

const dir24 = join(outRoot, 'stems-24')
check('package: outDir absent before', (await exists(dir24)) === false)
const pack24 = await packageStems(pure, { outDir: dir24, bitDepth: 24, channels: 1 })
perFileReport(pack24, '24-bit mono')
check('package: outDir created', await exists(dir24))
check('package: 4 stems + master written', pack24.files.length === 5 && pack24.stems.length === 4)
check('package: manifest written', pack24.manifestPath === join(dir24, 'stems.json') && (await exists(pack24.manifestPath)))
check('package: total bytes add up', pack24.totalBytes === pack24.files.reduce((sum, file) => sum + file.bytes, 0) + pack24.manifest.bytes)

const manifest = JSON.parse(await readFile(pack24.manifestPath, 'utf8'))
check('manifest: format', manifest.format === 'dsh-audio-stems' && manifest.version === 1)
check('manifest: 4 stems + master', manifest.stems.length === 4 && manifest.master.file === 'master.wav')
console.log(`manifest master: peak ${fmt(manifest.master.peakDbfs)} dBFS rms ${fmt(manifest.master.rmsDbfs)} dBFS sha256 ${manifest.master.sha256.slice(0, 12)}`)
console.log(`manifest reconstruction: maxAbsError=${Number(manifest.reconstruction.maxAbsError).toExponential(3)} sumPeakDbfs=${manifest.reconstruction.sumPeakDbfs} tolerance=${manifest.reconstruction.tolerance}`)
check('manifest: reconstruction recorded', Number(manifest.reconstruction.maxAbsError) < 1e-6)
for (const record of [...manifest.stems, manifest.master]) {
  const bytes = await readFile(join(dir24, record.file))
  check(`manifest: ${record.file} sha256 matches the file`, sha256(bytes) === record.sha256, `${sha256(bytes)} != ${record.sha256}`)
  check(`manifest: ${record.file} bytes match`, bytes.length === record.bytes)
}

console.log('-- package: manifest can be turned off --')
const dirNoManifest = join(outRoot, 'stems-no-manifest')
const packNoManifest = await packageStems(pure, { outDir: dirNoManifest, bitDepth: 16, channels: 1, manifest: false })
console.log(`  files=${packNoManifest.files.length} manifestPath=${packNoManifest.manifestPath} stems.json on disk=${await exists(join(dirNoManifest, 'stems.json'))} total=${packNoManifest.totalBytes} bytes`)
check('manifest off: writes wavs only', packNoManifest.files.length === 5)
check('manifest off: no manifestPath', packNoManifest.manifestPath === null)
check('manifest off: no stems.json on disk', (await exists(join(dirNoManifest, 'stems.json'))) === false)

console.log('-- package: 24-bit quantisation --')
const step24 = 1 / 8388608
let worst24 = 0
for (let index = 0; index < pack24.stems.length; index += 1) {
  const file = pack24.stems[index]
  const measured = quantisation(await readFile(file.path), pure.stems[index].samples)
  worst24 = Math.max(worst24, measured.maxAbsError)
  console.log(`  ${file.file.padEnd(14)} frames=${measured.frames} maxErr=${measured.maxAbsError.toExponential(3)} rmsErr=${measured.rmsError.toExponential(3)} (half step ${(step24 / 2).toExponential(3)})`)
  check(`24-bit: ${file.file} frames`, measured.frames === expectedFrames)
  check(`24-bit: ${file.file} channels`, measured.channels === 1)
  check(`24-bit: ${file.file} within quantisation`, measured.maxAbsError <= step24 / 2 + 1e-12, `maxErr=${measured.maxAbsError}`)
}
console.log(`worst 24-bit error ${worst24.toExponential(3)} (step ${step24.toExponential(3)})`)

console.log('-- package: 8-bit quantisation --')
const dir8 = join(outRoot, 'stems-8')
const pack8 = await packageStems(pure, { outDir: dir8, bitDepth: 8, channels: 1 })
const step8 = 1 / 128
let worst8 = 0
for (let index = 0; index < pack8.stems.length; index += 1) {
  const file = pack8.stems[index]
  const measured = quantisation(await readFile(file.path), pure.stems[index].samples)
  worst8 = Math.max(worst8, measured.maxAbsError)
  console.log(`  ${file.file.padEnd(14)} ${String(file.bytes).padStart(7)} bytes  frames=${measured.frames} maxErr=${fmt(measured.maxAbsError, 6)} rmsErr=${fmt(measured.rmsError, 6)} (half step ${fmt(step8 / 2, 6)})`)
  check(`8-bit: ${file.file} within quantisation`, measured.maxAbsError <= step8 / 2 + 1e-9, `maxErr=${measured.maxAbsError}`)
  check(`8-bit: ${file.file} rms error near step/sqrt(12)`, measured.rmsError > 0.001 && measured.rmsError < 0.0035, `rmsErr=${measured.rmsError}`)
}
console.log(`worst 8-bit error ${fmt(worst8, 6)} (step ${fmt(step8, 6)}, step/sqrt(12)=${fmt(step8 / Math.sqrt(12), 6)})`)

console.log('-- package: 24-bit stereo interleaving --')
const dirStereo = join(outRoot, 'stems-stereo')
const packStereo = await packageStems(pure, { outDir: dirStereo, bitDepth: 24, channels: 2 })
const stereoFile = packStereo.stems[0]
const stereoBytes = await readFile(stereoFile.path)
const stereoDecoded = decodeWav(stereoBytes)
const stereoMeasured = quantisation(stereoBytes, pure.stems[0].samples)
let channelMismatch = 0
let rawMismatch = 0
const compareFrames = Math.min(2000, stereoDecoded.channels[0].length)
for (let frame = 0; frame < compareFrames; frame += 1) {
  if (stereoDecoded.channels[0][frame] !== stereoDecoded.channels[1][frame]) channelMismatch += 1
  // Canonical 44-byte header, 3 bytes per sample, L then R.
  const left = stereoBytes.subarray(44 + frame * 6, 44 + frame * 6 + 3)
  const right = stereoBytes.subarray(44 + frame * 6 + 3, 44 + frame * 6 + 6)
  if (!left.equals(right)) rawMismatch += 1
}
console.log(`  ${stereoFile.file}: ${stereoFile.bytes} bytes, channels=${stereoDecoded.channels.length}, frames=${stereoDecoded.channels[0].length}, rate=${stereoDecoded.sampleRate}`)
console.log(`  L/R unequal frames=${channelMismatch}, raw bytes differ=${rawMismatch} (checked ${compareFrames}), maxErr vs rendered=${stereoMeasured.maxAbsError.toExponential(3)}`)
check('stereo: two channels', stereoDecoded.channels.length === 2)
check('stereo: frame count', stereoDecoded.channels[0].length === expectedFrames)
check('stereo: L equals R', channelMismatch === 0, `mismatch=${channelMismatch}`)
check('stereo: interleaved L,R pairs', rawMismatch === 0, `mismatch=${rawMismatch}`)
check('stereo: within 24-bit quantisation', stereoMeasured.maxAbsError <= step24 / 2 + 1e-12)

/* ----------------------------------------------------------- determinism -- */

console.log('\n-- determinism --')
const again = renderStems(tracks, { sampleRate, master: pureMaster })
let renderDiffs = 0
for (let index = 0; index < pure.stems.length; index += 1) {
  for (let frame = 0; frame < pure.stems[index].samples.length; frame += 1) {
    if (pure.stems[index].samples[frame] !== again.stems[index].samples[frame]) renderDiffs += 1
  }
}
console.log(`render: identical samples=${renderDiffs === 0} differences=${renderDiffs}`)
check('determinism: render samples identical', renderDiffs === 0)

const detA = await packageStems(pure, { outDir: join(outRoot, 'det-a'), bitDepth: 24, channels: 1 })
const detB = await packageStems(pure, { outDir: join(outRoot, 'det-b'), bitDepth: 24, channels: 1 })
let identical = 0
let compared = 0
for (const fileA of detA.files) {
  const fileB = detB.files.find((file) => file.file === fileA.file)
  compared += 1
  const same = fileB !== undefined && fileA.sha256 === fileB.sha256
  if (same) identical += 1
}
const manifestA = await readFile(detA.manifestPath)
const manifestB = await readFile(detB.manifestPath)
const manifestSame = manifestA.equals(manifestB)
console.log(`package: identical file hashes=${identical}/${compared}, manifest identical=${manifestSame}`)
console.log(`  first stem sha256 ${detA.stems[0].sha256}`)
check('determinism: every file hash identical', identical === compared, `${identical}/${compared}`)
check('determinism: manifest bytes identical', manifestSame)
check('determinism: same spec as pack24 hashes', detA.stems.every((stem, index) => stem.sha256 === pack24.stems[index].sha256))

/* ----------------------------------------------------------- tool layer -- */

console.log('\n-- tool: audio_stems --')
const toolCwd = join(outRoot, 'tool-cwd')
await mkdir(toolCwd, { recursive: true })
const registered = new Map()
registerStemsTools({
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => {}
    }
  },
  get: (name) => (name === 'workingDirectory' ? { get: () => toolCwd } : undefined)
})
const exec = { agent: { session: { id: 'stems-test' } } }
check('tool: registered', registered.has('audio_stems'))
const tool = registered.get('audio_stems')

const badName = 'missing-stem-file.wav'
try {
  await tool.execute({ tracks: [{ path: badName }] }, exec)
  check('tool: rejects a bad path', false)
} catch (error) {
  console.log(`  bad path error: ${error.message}`)
  check('tool: error names the file', error.message.includes(badName), error.message)
}

const toolResult = await tool.execute({
  tracks: [
    { render: { preset: 'impact', duration: 0.3, seed: 1 }, name: 'hit', gainDb: 0, offsetSeconds: 0 },
    { render: { preset: 'tick', duration: 0.2, seed: 2 }, name: 'tick', gainDb: -6, offsetSeconds: 0.1 }
  ],
  outDir: 'tool-stems',
  bitDepth: 24,
  channels: 1,
  sampleRate: 22050
}, exec)
console.log(`  text: ${toolResult.text}`)
console.log(`  files: ${toolResult.stems.map((stem) => `${stem.file} ${stem.bytes}B`).join(', ')}, master.wav ${toolResult.master.bytes}B, manifest ${toolResult.relativeManifestPath}`)
check('tool: two stems + master', toolResult.stems.length === 2 && toolResult.master.file === 'master.wav')
check('tool: manifest path', toolResult.relativeManifestPath === 'tool-stems/stems.json')
check('tool: text names every file', ['hit.wav', 'tick.wav', 'master.wav', 'stems.json'].every((name) => toolResult.text.includes(name)), toolResult.text)
check('tool: text names the reconstruction error', /max error/.test(toolResult.text), toolResult.text)
check('tool: sample rate resolved', toolResult.sampleRate === 22050 && toolResult.stems.every((stem) => stem.offsetSeconds !== undefined))
check('tool: files exist', await exists(join(toolCwd, 'tool-stems', 'hit.wav')) && await exists(join(toolCwd, 'tool-stems', 'master.wav')) && await exists(join(toolCwd, 'tool-stems', 'stems.json')))
check('tool: stems frame-aligned', toolResult.stems.every((stem) => Math.abs(stem.durationSeconds - toolResult.durationSeconds) < 1e-6))

const toolDefault = await tool.execute({
  tracks: [{ render: { preset: 'chime', duration: 0.2, seed: 3 }, name: 'ding' }],
  bitDepth: 8,
  sampleRate: 16000
}, exec)
console.log(`  default outDir: ${toolDefault.relativePath} (8-bit ${toolDefault.sampleRate} Hz, ${toolDefault.bytes} bytes)`)
check('tool: default outDir is hashed under assets/audio', /^assets\/audio\/stems-[0-9a-f]{12}$/.test(toolDefault.relativePath), toolDefault.relativePath)
check('tool: default outDir files exist', await exists(toolDefault.manifestPath))

/* ----------------------------------------------------------- performance -- */

console.log('\n-- performance: 8 tracks x 5 s --')
const perfFrames = 5 * 44100
const perfTracks = []
for (let index = 0; index < 8; index += 1) {
  const random = makeRng(1000 + index)
  const samples = new Float32Array(perfFrames)
  const hz = 110 + index * 37
  for (let frame = 0; frame < perfFrames; frame += 1) {
    samples[frame] = Math.sin(2 * Math.PI * hz * frame / 44100) * 0.25 + (random() * 2 - 1) * 0.015
  }
  perfTracks.push({
    id: `layer-${index + 1}`,
    samples,
    sampleRate: 44100,
    gainDb: -3 - (index % 4) * 2,
    offsetSeconds: index * 0.05
  })
}
const audioSeconds = perfTracks.length * 5
const renderStart = performance.now()
const perf = renderStems(perfTracks, { master: { peakDbfs: -1, limiter: true } })
const renderMs = performance.now() - renderStart
const packStart = performance.now()
const perfPack = await packageStems(perf, { outDir: join(outRoot, 'perf'), bitDepth: 24, channels: 1 })
const packMs = performance.now() - packStart
const realtime = audioSeconds / (renderMs / 1000)
console.log(`render: ${perfFrames} frames/track, 8 tracks = ${audioSeconds} s of audio -> ${fmt(renderMs, 1)} ms (${fmt(realtime, 1)}x realtime, ${fmt(renderMs / (perfFrames * 8) * 1e6, 3)} µs/sample)`)
console.log(`package: 8 stems + master at 24-bit mono -> ${fmt(packMs, 1)} ms, ${perfPack.totalBytes} bytes (${fmt(perfPack.totalBytes / 1024 / 1024, 2)} MB)`)
console.log(`reconstruction: maxAbsError=${perf.reconstruction.maxAbsError.toExponential(3)} sumPeakDbfs=${perf.reconstruction.sumPeakDbfs} limiterEngaged=${perf.reconstruction.limiterEngaged} masterPeakDbfs=${perf.master.metrics.peakDbfs}`)
check('perf: master reconstructs', perf.reconstruction.maxAbsError < 1e-6)
check('perf: 9 files written', perfPack.files.length === 9, String(perfPack.files.length))
check('perf: render under 20 s', renderMs < 20000, `${renderMs} ms`)

/* --------------------------------------------------------------- summary -- */

console.log(`\n${failures === 0 ? 'OK: stems behave' : `FAILED: ${failures} check(s)`} (tolerance ${STEM_LIMITS.reconstructionTolerance}, ${failures === 0 ? 'all' : 'some'} checks passed)`)
process.exit(failures === 0 ? 0 : 1)
