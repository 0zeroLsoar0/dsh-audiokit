/**
 * Loudness tests: BS.1770-4 / EBU R128 calibration, gating, true peak, gain
 * planning, and the tool layer.
 *
 * The calibration section is the important one: the meter has to read what
 * every other BS.1770 implementation reads, or a target means nothing.
 *   - a mono 997 Hz sine whose RMS is -20 dBFS reads -20.0 LUFS on every
 *     supported sample rate (BS.1770-4 single-channel weight, the number
 *     ffmpeg's `ebur128` and Youlean report);
 *   - the same sine at -20 dBFS *peak* reads -23.0 LUFS, because a sine's RMS
 *     is 3.01 dB below its peak;
 *   - the EBU Tech 3341 reference (997 Hz at -23 dBFS in both stereo channels)
 *     still reads -23.0 LUFS, so the stereo path did not move;
 *   - `{ dualMono: true }` restores this plugin's historical mono convention
 *     (+3.01 LU) for callers with old mono numbers to compare.
 * The bottom of the file cross-checks mono and stereo readings against a real
 * ffmpeg `ebur128` run when ffmpeg is available (skipped otherwise).
 *
 * Run: node test/lufs.mjs
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeLoudness,
  gainForTarget,
  kWeight,
  planGain,
  truePeak
} from '../lib/lufs.js'
import { finalize, measure, mixTracks, renderPreset, toWavBytes } from '../lib/audio.js'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { registerLoudnessTools } from '../lib/tools-loudness.js'

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const dbOf = (linear) => (linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY)
const showDb = (value) => (Number.isFinite(value) ? value.toFixed(3) : '-inf')

/** Deterministic sine at a peak level given in dBFS. */
function sine (seconds, sampleRate, hz, dbfs, phase = 0) {
  const frames = Math.round(seconds * sampleRate)
  const amplitude = Math.pow(10, dbfs / 20)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate + phase)
  return out
}

const SAMPLE_RATES = [22050, 32000, 44100, 48000, 96000]

/* ------------------------------------------------------------ filter gain -- */

console.log(`-- K-weighting gain at 997 Hz (the +0.691 dB the LUFS offset cancels) --`)
const filterGains = new Map()
for (const sampleRate of SAMPLE_RATES) {
  const source = sine(1, sampleRate, 997, -20)
  const weighted = kWeight(source, sampleRate)
  check(`${sampleRate} returns Float32Array`, weighted instanceof Float32Array)
  check(`${sampleRate} keeps length`, weighted.length === source.length)
  let sourceEnergy = 0
  let weightedEnergy = 0
  for (let i = 0; i < source.length; i += 1) {
    sourceEnergy += source[i] * source[i]
    weightedEnergy += weighted[i] * weighted[i]
  }
  const gainDb = 10 * Math.log10(weightedEnergy / sourceEnergy)
  filterGains.set(sampleRate, gainDb)
  console.log(`  ${String(sampleRate).padStart(5)} Hz -> ${gainDb.toFixed(4)} dB`)
  // The derivation is exact at 48 kHz; other rates differ only by the bilinear
  // mapping of the prototype, which the calibration tolerance covers.
  check(`${sampleRate} filter gain near +0.691 dB`, Math.abs(gainDb - 0.691) < 0.05, `${gainDb.toFixed(4)} dB`)
}

/* ------------------------------------------------------------ calibration -- */

console.log('\n-- calibration: mono 997 Hz sine with RMS -20 dBFS should read -20.0 LUFS --')
const calibration = new Map()
for (const sampleRate of SAMPLE_RATES) {
  // Level is defined as RMS here, not peak: BS.1770 loudness is an RMS measure,
  // so a sine whose peak is -20 dBFS is a -23 dBFS signal and reads -23 LUFS.
  const source = sine(3, sampleRate, 997, -20 + 20 * Math.log10(Math.SQRT2))
  const analysis = analyzeLoudness(source, sampleRate)
  calibration.set(sampleRate, analysis)
  console.log(
    `  ${String(sampleRate).padStart(5)} Hz -> ${analysis.integratedLufs.toFixed(3)} LUFS  ` +
    `(true peak ${analysis.truePeakDbtp.toFixed(3)} dBTP, ${analysis.gatedBlocks}/${analysis.blocksMeasured} gated blocks, ` +
    `${analysis.durationSeconds}s, weights [${analysis.channelWeights.join(',')}])`
  )
  check(`${sampleRate} mono RMS -20 dBFS reads -20 +/- 0.1`, Math.abs(analysis.integratedLufs + 20) <= 0.1, `${analysis.integratedLufs}`)
  check(`${sampleRate} mono true peak is the sine peak`, Math.abs(analysis.truePeakDbtp - (-20 + 20 * Math.log10(Math.SQRT2))) <= 0.05, `${analysis.truePeakDbtp}`)
  check(`${sampleRate} blocks gated`, analysis.gatedBlocks === analysis.blocksMeasured && analysis.gatedBlocks > 0)
  check(`${sampleRate} a mono file counts one channel once`, analysis.channelWeights.join(',') === '1' && analysis.dualMono === false,
    `${analysis.channelWeights.join(',')} / ${analysis.dualMono}`)
}

console.log('\n-- BS.1770-4: a mono sine at -20 dBFS PEAK reads -23.0 LUFS (RMS is 3.01 dB lower) --')
for (const sampleRate of [44100, 48000]) {
  const analysis = analyzeLoudness(sine(3, sampleRate, 1000, -20), sampleRate)
  console.log(`  ${sampleRate} Hz -> ${analysis.integratedLufs.toFixed(3)} LUFS`)
  check(`${sampleRate} mono -20 dBFS peak reads -23 +/- 0.1`, Math.abs(analysis.integratedLufs + 23) <= 0.1, `${analysis.integratedLufs}`)
}

console.log('\n-- EBU Tech 3341 stereo reference: 997 Hz at -23 dBFS per channel -> -23.0 LUFS --')
{
  const left = sine(3, 48000, 997, -23)
  const right = sine(3, 48000, 997, -23, 0.9)
  const analysis = analyzeLoudness(left, 48000, { channels: [left, right] })
  console.log(`  48000 Hz stereo -> ${analysis.integratedLufs.toFixed(3)} LUFS (weights [${analysis.channelWeights.join(',')}], dualMono ${analysis.dualMono})`)
  check('stereo reads the EBU reference level', Math.abs(analysis.integratedLufs + 23) <= 0.05, `${analysis.integratedLufs}`)
  check('stereo keeps both channels at weight 1', analysis.channelWeights.join(',') === '1,1', analysis.channelWeights.join(','))
  check('stereo never reports the dual-mono convention', analysis.dualMono === false)
}

console.log('\n-- mono convention: standard single-channel weight by default, dual mono on request --')
{
  const source = sine(3, 48000, 997, -23)
  const standard = analyzeLoudness(source, 48000)
  const dual = analyzeLoudness(source, 48000, { dualMono: true })
  console.log(`  48000 Hz: standard ${standard.integratedLufs.toFixed(3)} LUFS (weight ${standard.channelWeights.join(',')}), ` +
    `dual mono ${dual.integratedLufs.toFixed(3)} LUFS (weight ${dual.channelWeights.join(',')}), difference ${(dual.integratedLufs - standard.integratedLufs).toFixed(3)} LU`)
  check('standard mono weight is 1.0', standard.channelWeights.join(',') === '1' && standard.dualMono === false)
  check('standard mono reads -26.01 for a -23 dBFS peak sine', Math.abs(standard.integratedLufs + 26.01) < 0.1, `${standard.integratedLufs}`)
  check('dual mono counts the channel twice', dual.channelWeights.join(',') === '2' && dual.dualMono === true)
  check('dual mono reads -23.0 and is 3.01 LU louder', Math.abs(dual.integratedLufs + 23) < 0.1 &&
    Math.abs((dual.integratedLufs - standard.integratedLufs) - 3.01) < 0.02,
  `${dual.integratedLufs} vs ${standard.integratedLufs}`)
  check('dualMono does not move a stereo reading',
    analyzeLoudness([source, source], 48000, { channels: [source, source], dualMono: true }).integratedLufs ===
    analyzeLoudness([source, source], 48000, { channels: [source, source] }).integratedLufs)
}

console.log('\n-- silence --')
{
  const analysis = analyzeLoudness(new Float32Array(48000 * 2), 48000)
  console.log(`  2 s of zeros -> integrated ${showDb(analysis.integratedLufs)} LUFS, true peak ${showDb(analysis.truePeakDbtp)} dBTP, sample peak ${analysis.samplePeakDbfs} dBFS, gated ${analysis.gatedBlocks}/${analysis.blocksMeasured}`)
  check('silence is not NaN', !Number.isNaN(analysis.integratedLufs))
  check('silence reads very low', analysis.integratedLufs === Number.NEGATIVE_INFINITY || analysis.integratedLufs < -60)
  check('silence has no gated blocks', analysis.gatedBlocks === 0)
  check('silence true peak is not NaN', !Number.isNaN(analysis.truePeakDbtp))
  check('silence sample peak floor', analysis.samplePeakDbfs === -120, String(analysis.samplePeakDbfs))
}

/* --------------------------------------------------------- song-ish mix -- */

/** A 3.4 s cue: room bed, three impacts of different levels, a chime and a riser. */
function buildSong () {
  const sampleRate = 48000
  const bed = renderPreset({ preset: 'texture', sampleRate, duration: 3, seed: 4, params: { kind: 'room', density: 0.6, tone: 0.35 } })
  finalize(bed.samples, sampleRate, -22)
  const hits = [0, 1.2, 2.4].map((_, index) => {
    const hit = renderPreset({ preset: 'impact', sampleRate, duration: 0.9, seed: 10 + index, params: { weight: 0.7, hardness: 0.5 } })
    finalize(hit.samples, sampleRate, [-6, -10, -4][index])
    return hit
  })
  const ding = renderPreset({ preset: 'chime', sampleRate, duration: 0.8, seed: 21, params: { decay: 0.7 } })
  finalize(ding.samples, sampleRate, -9)
  const riser = renderPreset({ preset: 'riser', sampleRate, duration: 1.2, seed: 31 })
  finalize(riser.samples, sampleRate, -12)
  return mixTracks([bed, hits[0], hits[1], hits[2], ding, riser], {
    sampleRate,
    offsets: [0, 0, 1.2, 2.4, 2.6, 1.8],
    limiter: true,
    peakDbfs: -3
  })
}

console.log('\n-- song-ish mix (3 s of material + tails) --')
const song = buildSong()
const songAnalysis = analyzeLoudness(song.samples, song.sampleRate)
console.log(
  `  ${songAnalysis.durationSeconds}s: ${songAnalysis.integratedLufs.toFixed(3)} LUFS integrated, ` +
  `short-term max ${songAnalysis.shortTermMaxLufs.toFixed(3)} LUFS (${songAnalysis.shortTermBasis}), ` +
  `momentary max ${songAnalysis.momentaryMaxLufs.toFixed(3)} LUFS, LRA ${songAnalysis.loudnessRangeLu.toFixed(3)} LU, ` +
  `true peak ${songAnalysis.truePeakDbtp.toFixed(3)} dBTP, sample peak ${songAnalysis.samplePeakDbfs.toFixed(3)} dBFS`
)
console.log(`  ${songAnalysis.blocksMeasured} blocks measured, ${songAnalysis.gatedBlocks} survive both gates, relative gate ${songAnalysis.relativeGateLufs.toFixed(2)} LUFS`)
check('mix duration ~3.4 s', Math.abs(songAnalysis.durationSeconds - 3.4) < 0.15, String(songAnalysis.durationSeconds))
check('mix reports a loudness range', songAnalysis.loudnessRangeLu > 0, String(songAnalysis.loudnessRangeLu))
check('mix LRA is plausible', songAnalysis.loudnessRangeLu > 0.2 && songAnalysis.loudnessRangeLu < 30, String(songAnalysis.loudnessRangeLu))
check('mix integrated plausible', songAnalysis.integratedLufs < 0 && songAnalysis.integratedLufs > -40, String(songAnalysis.integratedLufs))
// A 3 s window averages over the gaps between hits, so on short sparse cues the
// short-term maximum can sit below the gated integrated value; what must hold
// is that it never exceeds the momentary (400 ms) maximum.
check('short-term max <= momentary max', songAnalysis.shortTermMaxLufs <= songAnalysis.momentaryMaxLufs + 0.01,
  `${songAnalysis.shortTermMaxLufs} vs ${songAnalysis.momentaryMaxLufs}`)
check('short-term max is plausible', songAnalysis.shortTermMaxLufs > songAnalysis.integratedLufs - 15, String(songAnalysis.shortTermMaxLufs))
check('true peak >= sample peak', songAnalysis.truePeakDbtp >= songAnalysis.samplePeakDbfs - 0.001)
check('mix uses the 3 s window', songAnalysis.shortTermBasis === 'short-term', songAnalysis.shortTermBasis)

/* ------------------------------------------------------------- linearity -- */

console.log('\n-- gain linearity: +6 dB must add +6.0 LU --')
{
  // Exactly +6 dB (x1.9953), not x2: doubling amplitude is +6.0206 dB and would
  // make the expected rise 6.02 LU.
  const gain = Math.pow(10, 6 / 20)
  const louderSamples = new Float32Array(song.samples.length)
  for (let i = 0; i < song.samples.length; i += 1) louderSamples[i] = song.samples[i] * gain
  const louder = analyzeLoudness(louderSamples, song.sampleRate)
  const loudnessDelta = louder.integratedLufs - songAnalysis.integratedLufs
  const peakDelta = louder.truePeakDbtp - songAnalysis.truePeakDbtp
  console.log(`  integrated ${songAnalysis.integratedLufs.toFixed(3)} -> ${louder.integratedLufs.toFixed(3)} LUFS (${loudnessDelta >= 0 ? '+' : ''}${loudnessDelta.toFixed(3)} LU)`)
  console.log(`  true peak  ${songAnalysis.truePeakDbtp.toFixed(3)} -> ${louder.truePeakDbtp.toFixed(3)} dBTP (${peakDelta >= 0 ? '+' : ''}${peakDelta.toFixed(3)} dB)`)
  check('integrated rises exactly 6 LU', Math.abs(loudnessDelta - 6) <= 0.01, String(loudnessDelta))
  check('true peak rises exactly 6 dB', Math.abs(peakDelta - 6) <= 0.02, String(peakDelta))
  check('LRA is gain invariant', Math.abs(louder.loudnessRangeLu - songAnalysis.loudnessRangeLu) < 0.05, `${songAnalysis.loudnessRangeLu} vs ${louder.loudnessRangeLu}`)
}

/* -------------------------------------------------------------- true peak -- */

console.log('\n-- true peak (4x oversampling, not the sample peak) --')
{
  const sampleRate = 48000
  const frames = sampleRate
  const hidden = new Float32Array(frames)
  // 12 kHz at 48 kHz is exactly four samples per cycle; a 45 degree phase puts
  // every sample 3.01 dB below the crest, so a sample-peak meter lies by 3 dB.
  for (let i = 0; i < frames; i += 1) hidden[i] = Math.sin(2 * Math.PI * 12000 * i / sampleRate + Math.PI / 4)
  const analysis = analyzeLoudness(hidden, sampleRate)
  console.log(`  12 kHz sine: sample peak ${analysis.samplePeakDbfs.toFixed(3)} dBFS -> true peak ${analysis.truePeakDbtp.toFixed(3)} dBTP`)
  check('sample peak misses the crest by ~3 dB', Math.abs(analysis.samplePeakDbfs + 3.0103) < 0.05, String(analysis.samplePeakDbfs))
  check('true peak finds the crest', analysis.truePeakDbtp > analysis.samplePeakDbfs + 2.5, String(analysis.truePeakDbtp))
  check('true peak within 0.2 dB of 0 dBTP', Math.abs(analysis.truePeakDbtp) <= 0.2, String(analysis.truePeakDbtp))

  const tone = sine(1, sampleRate, 997, -1)
  const tonePeak = truePeak(tone, sampleRate)
  console.log(`  997 Hz sine at -1 dBFS: true peak ${tonePeak.toFixed(3)} dBTP`)
  check('low-frequency true peak tracks the sample peak', Math.abs(tonePeak + 1) <= 0.05, String(tonePeak))
  check('truePeak of silence is -inf', truePeak(new Float32Array(64), sampleRate) === Number.NEGATIVE_INFINITY)
}

/* ---------------------------------------------------------- gain planner -- */

console.log('\n-- gainForTarget --')
{
  const quiet = analyzeLoudness(sine(2, 48000, 440, -30), 48000)
  const plan = gainForTarget(sine(2, 48000, 440, -30), 48000, -14, -1)
  console.log(`  -30 dBFS tone -> target -14 LUFS: gain ${plan.gainDb.toFixed(3)} dB, ${plan.limitedBy}, predicted ${plan.predictedLufs.toFixed(2)} LUFS / ${plan.predictedDbtp.toFixed(2)} dBTP`)
  check('measured integrated matches', Math.abs(plan.predictedLufs - (-14)) <= 0.001, String(plan.predictedLufs))
  check('loudness-limited plan is achievable', plan.achievable === true && plan.limitedBy === 'loudness')
  check('prediction never above ceiling', plan.predictedDbtp <= -1 + 1e-9, String(plan.predictedDbtp))
  check('quiet plan integrated sane', quiet.integratedLufs < -20)

  // Hot, peaky material: the target is louder than the ceiling allows.
  const hot = buildSong()
  finalize(hot.samples, hot.sampleRate, -0.2)
  const hotAnalysis = analyzeLoudness(hot.samples, hot.sampleRate)
  const capped = gainForTarget(hot.samples, hot.sampleRate, -6, -1)
  console.log(`  hot mix ${hotAnalysis.integratedLufs.toFixed(2)} LUFS / ${hotAnalysis.truePeakDbtp.toFixed(2)} dBTP -> target -6 LUFS: gain ${capped.gainDb.toFixed(3)} dB, ${capped.limitedBy}, predicted ${capped.predictedLufs.toFixed(2)} LUFS / ${capped.predictedDbtp.toFixed(2)} dBTP`)
  check('hot plan is capped by true peak', capped.limitedBy === 'true-peak' && capped.achievable === false)
  check('hot plan gain is the peak headroom', Math.abs(capped.gainDb - (-1 - hotAnalysis.truePeakDbtp)) < 0.002, String(capped.gainDb))
  check('hot plan lands on the ceiling', Math.abs(capped.predictedDbtp + 1) < 0.002, String(capped.predictedDbtp))

  const silent = gainForTarget(new Float32Array(48000), 48000, -14, -1)
  console.log(`  silence -> gain ${silent.gainDb}, achievable ${silent.achievable}, ${silent.limitedBy}`)
  check('silent plan has no NaN', !Number.isNaN(silent.gainDb) && !Number.isNaN(silent.predictedLufs))
  check('silent plan is not achievable', silent.achievable === false)

  // Property sweep over the planner: whatever it predicts must respect the
  // ceiling, and an achievable prediction has to hit the target.
  const signals = [
    { name: 'song', samples: song.samples },
    { name: 'hot', samples: hot.samples },
    { name: 'sine', samples: sine(1.2, 48000, 500, -6) }
  ].map((entry) => ({ ...entry, analysis: analyzeLoudness(entry.samples, 48000) }))
  let violations = 0
  let checked = 0
  for (const signal of signals) {
    for (const target of [-23, -16, -14, -9]) {
      for (const ceiling of [-1, -2, 0]) {
        const planned = planGain(signal.analysis, target, ceiling)
        checked += 1
        if (Number.isFinite(planned.predictedDbtp) && planned.predictedDbtp > planned.ceilingDbtp + 1e-9) violations += 1
        if (planned.achievable && Math.abs(planned.predictedLufs - target) > 1e-6) violations += 1
      }
    }
  }
  console.log(`  planner sweep: ${checked} combinations, ${violations} violations`)
  check('planner never predicts above the ceiling', violations === 0, String(violations))
}

/* ------------------------------------------------------------ determinism -- */

console.log('\n-- determinism --')
{
  const first = analyzeLoudness(song.samples, song.sampleRate)
  const second = analyzeLoudness(song.samples, song.sampleRate)
  const legacy = analyzeLoudness(song.samples, song.sampleRate, { dualMono: true })
  console.log(`  twice: ${first.integratedLufs} / ${second.integratedLufs} LUFS, true peak ${first.truePeakDbtp} / ${second.truePeakDbtp} dBTP; dual mono ${legacy.integratedLufs}`)
  check('identical numbers', JSON.stringify(first) === JSON.stringify(second))
  check('the dual-mono option changes the result by 3.01 LU', Math.abs((legacy.integratedLufs - first.integratedLufs) - 3.01) < 0.02)
}

/* ------------------------------------------------------------ performance -- */

console.log('\n-- performance: 60 s of 48 kHz mono --')
{
  const sampleRate = 48000
  const frames = sampleRate * 60
  const long = new Float32Array(frames)
  let seed = 12345
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate
    const pulse = Math.exp(-((t * 2) % 1) * 6)
    long[i] = 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.22 * Math.sin(2 * Math.PI * 997 * t + 1) +
      0.15 * Math.sin(2 * Math.PI * 3200 * t) + 0.18 * (random() * 2 - 1) * (0.2 + pulse)
  }
  const started = process.hrtime.bigint()
  const analysis = analyzeLoudness(long, sampleRate)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`  analyzeLoudness(60 s): ${elapsedMs.toFixed(1)} ms -> ${analysis.integratedLufs.toFixed(2)} LUFS, ${analysis.blocksMeasured} blocks, true peak ${analysis.truePeakDbtp.toFixed(2)} dBTP`)
  check('60 s mono analyses in well under a second', elapsedMs < 1000, `${elapsedMs.toFixed(1)} ms`)
}

/* ------------------------------------------------------------- tool layer -- */

console.log('\n-- audio_loudness tool --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-lufs-'))
{
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  registerLoudnessTools(ctx)
  const exec = { agent: { session: { id: 'lufs-test' } } }
  const call = (name, args) => registered.get(name).execute(args, exec)

  check('registers exactly one tool', registered.size === 1 && registered.has('audio_loudness'), [...registered.keys()].join(','))
  const definition = registered.get('audio_loudness')
  check('tool has execute/presentCall/output', typeof definition.execute === 'function' && typeof definition.presentCall === 'function' && definition.output !== undefined)
  check('tool is concurrency safe', definition.isConcurrencySafe === true)

  // Inline render, no file written.
  const first = await call('audio_loudness', { render: { preset: 'impact', duration: 1, seed: 7 } })
  console.log(`  inline render: ${first.metrics.lufs} LUFS, ${first.metrics.truePeakDbtp} dBTP`)
  console.log(`  ${first.text}`)
  check('inline render reports lufs', typeof first.metrics.lufs === 'number' && Number.isFinite(first.metrics.lufs))
  check('inline render writes nothing', first.path === null && first.written === null)
  check('text mentions LUFS', /LUFS/.test(first.text))

  // Measure a file written by the engine.
  const bytes = toWavBytes(finalize(buildSong().samples, 48000, -3), 48000)
  await writeFile(join(cwd, 'cue.wav'), bytes)
  const measured = await call('audio_loudness', { path: 'cue.wav' })
  console.log(`  file: ${measured.relativePath} -> ${measured.metrics.lufs} LUFS, ${measured.metrics.truePeakDbtp} dBTP, ${measured.bytes} bytes`)
  check('file measurement returns a path', measured.relativePath === 'cue.wav', String(measured.relativePath))
  check('file measurement reads bytes', measured.bytes === bytes.length, String(measured.bytes))
  const decodedCue = decodeWav(await readFile(join(cwd, 'cue.wav')))
  check('file measurement matches direct analysis', Math.abs(measured.metrics.lufs - analyzeLoudness(decodedCue.channels[0], decodedCue.sampleRate).integratedLufs) < 0.01)

  // Normalise a mono cue to a target and prove the written file lands on it:
  // after the mono weight fix a mono target is the file's own measured LUFS,
  // not 3 LU off. `mono23.wav` is a -23 dBFS peak 997 Hz sine, i.e. -26.01 LUFS
  // on the standard single-channel weight, so +6 dB of gain is needed.
  const mono23 = sine(3, 48000, 997, -23)
  await writeFile(join(cwd, 'mono23.wav'), toWavBytes(mono23, 48000))
  const monoMeasured = await call('audio_loudness', { path: 'mono23.wav' })
  const monoDual = await call('audio_loudness', { path: 'mono23.wav', dualMono: true })
  console.log(`  mono -23 dBFS peak: ${monoMeasured.metrics.lufs} LUFS standard (weights [${monoMeasured.metrics.channelWeights}], dualMono ${monoMeasured.metrics.dualMono}), ` +
    `${monoDual.metrics.lufs} LUFS with dualMono (weights [${monoDual.metrics.channelWeights}])`)
  check('mono standard weight is reported', monoMeasured.metrics.channelWeights.join(',') === '1' && monoMeasured.metrics.dualMono === false)
  check('the dualMono option restores the old mono number', Math.abs(monoDual.metrics.lufs + 23) <= 0.1, String(monoDual.metrics.lufs))
  check('the dualMono option is reported back', monoDual.metrics.dualMono === true && monoDual.metrics.channelWeights.join(',') === '2')
  check('the default mono reading matches BS.1770', Math.abs(monoMeasured.metrics.lufs + 26.01) <= 0.1, String(monoMeasured.metrics.lufs))

  const monoCopy = await call('audio_loudness', { path: 'mono23.wav', targetLufs: -20, out: 'mono-target.wav' })
  console.log(`  ${monoCopy.text}`)
  const monoCopyDecoded = decodeWav(await readFile(join(cwd, 'mono-target.wav')))
  const monoCopyLufs = analyzeLoudness(monoCopyDecoded.channels[0], monoCopyDecoded.sampleRate).integratedLufs
  const monoCopyPeak = truePeak(monoCopyDecoded.channels[0], monoCopyDecoded.sampleRate)
  console.log(`  mono copy: ${monoCopyLufs.toFixed(3)} LUFS, true peak ${monoCopyPeak.toFixed(3)} dBTP, gain ${monoCopy.written.appliedGainDb} dB, targetHit ${monoCopy.written.targetHit}`)
  check('mono copy lands on the target', Math.abs(monoCopyLufs - (-20)) <= 0.15, String(monoCopyLufs))
  check('mono copy respects the ceiling', monoCopyPeak <= -1.0, String(monoCopyPeak))
  check('mono copy reports the gain it applied', Math.abs(monoCopy.written.appliedGainDb - 6.01) < 0.1, String(monoCopy.written.appliedGainDb))
  check('mono copy reports the measured true peak', Math.abs(monoCopy.written.truePeakDbtp - monoCopyPeak) <= 0.01, `${monoCopy.written.truePeakDbtp} vs ${monoCopyPeak}`)
  check('mono copy reports targetHit', monoCopy.written.targetHit === true)

  // Normalise the hot mix to a reachable target and prove the written file
  // stays under the true-peak ceiling.
  const hot = buildSong()
  finalize(hot.samples, 48000, -0.2)
  await writeFile(join(cwd, 'hot.wav'), toWavBytes(hot.samples, 48000))
  const written = await call('audio_loudness', { path: 'hot.wav', targetLufs: -17, out: 'normalised.wav' })
  console.log(`  ${written.text}`)
  check('wrote corrected copy', written.written !== null && written.relativePath === 'normalised.wav', String(written.relativePath))
  const correctedDecoded = decodeWav(await readFile(join(cwd, 'normalised.wav')))
  const correctedPeak = truePeak(correctedDecoded.channels[0], correctedDecoded.sampleRate)
  const correctedLufs = analyzeLoudness(correctedDecoded.channels[0], correctedDecoded.sampleRate).integratedLufs
  console.log(`  written file: ${correctedLufs.toFixed(3)} LUFS, true peak ${correctedPeak.toFixed(3)} dBTP (was ${written.before.lufs} LUFS / ${written.before.truePeakDbtp} dBTP)`)
  check('normalised copy hits the target', Math.abs(correctedLufs - (-17)) <= 0.15, String(correctedLufs))
  check('normalised copy never exceeds -1 dBTP', correctedPeak <= -1.0, String(correctedPeak))
  check('before/after both reported', Number.isFinite(written.before.lufs) && written.after !== null && Number.isFinite(written.after.lufs))
  check('metrics describe the written file', Math.abs(written.metrics.lufs - correctedLufs) < 0.01, String(written.metrics.lufs))
  check('the written copy kept its 16-bit mono shape', correctedDecoded.channels.length === 1 && written.written.channelLayout === 'mono' && written.written.bitDepth === 16,
    `${correctedDecoded.channels.length} ch / ${written.written.channelLayout} / ${written.written.bitDepth}-bit`)

  // The same call twice must produce the same numbers (the dither can move the
  // last decimal of true peak, so compare loudness exactly and peak closely).
  const again = await call('audio_loudness', { path: 'hot.wav', targetLufs: -17, out: 'normalised-2.wav' })
  check('tool measurement is deterministic', measured.metrics.lufs === (await call('audio_loudness', { path: 'cue.wav' })).metrics.lufs)
  check('tool normalisation gain is deterministic', Math.abs(again.target.gainDb - written.target.gainDb) < 1e-9, `${again.target.gainDb} vs ${written.target.gainDb}`)
  {
    const firstBytes = await readFile(join(cwd, 'normalised.wav'))
    const secondBytes = await readFile(join(cwd, 'normalised-2.wav'))
    check('tool normalisation is byte-deterministic', firstBytes.equals(secondBytes), `${firstBytes.length} vs ${secondBytes.length}`)
  }

  // A target the file cannot reach without breaking the ceiling must still be
  // written at the largest safe gain, and the file must stay under -1 dBTP.
  const pushed = await call('audio_loudness', { path: 'hot.wav', targetLufs: -6, out: 'pushed.wav' })
  console.log(`  ${pushed.text}`)
  const pushedDecoded = decodeWav(await readFile(join(cwd, 'pushed.wav')))
  const pushedPeak = truePeak(pushedDecoded.channels[0], pushedDecoded.sampleRate)
  check('capped write respects the ceiling', pushedPeak <= -1.0, String(pushedPeak))
  check('capped write reports it fell short', pushed.written.targetHit === false && pushed.target.achievable === false)
  check('capped write says the peak is the limit', pushed.target.limitedBy === 'true-peak')
  check('capped write reports a shortfall', pushed.written.shortfallLu > 0.3, String(pushed.written.shortfallLu))

  // Measuring with a target but no out must predict and write nothing.
  const predicted = await call('audio_loudness', { path: 'hot.wav', targetLufs: -14 })
  check('prediction without out writes nothing', predicted.written === null && predicted.after === null)
  check('prediction reports a gain', predicted.target !== null && Number.isFinite(predicted.target.gainDb))

  // Stereo file: EBU Tech 3341's reference signal is a 997 Hz sine at -23 dBFS
  // in both channels, and it must read -23.0 LUFS. This exercises the channel
  // summing path (a stereo file must not be turned into a mono average), and a
  // stereo correction is now written as stereo instead of being refused.
  const left = sine(3, 48000, 997, -23)
  const right = sine(3, 48000, 997, -23, 0.9)
  await writeFile(join(cwd, 'stereo.wav'), encodeWav([left, right], 48000))
  const stereo = await call('audio_loudness', { path: 'stereo.wav' })
  console.log(`  stereo 997 Hz -23 dBFS per channel -> ${stereo.metrics.lufs} LUFS (${stereo.metrics.channelCount} channels)`)
  check('stereo file reads the EBU 3341 reference level', Math.abs(stereo.metrics.lufs + 23) <= 0.3, String(stereo.metrics.lufs))
  check('stereo channel count reported', stereo.metrics.channelCount === 2, String(stereo.metrics.channelCount))
  const stereoCopy = await call('audio_loudness', { path: 'stereo.wav', targetLufs: -20, out: 'stereo-out.wav' })
  const stereoCopyDecoded = decodeWav(await readFile(join(cwd, 'stereo-out.wav')))
  const stereoCopyLufs = analyzeLoudness(stereoCopyDecoded.channels[0], stereoCopyDecoded.sampleRate, { channels: stereoCopyDecoded.channels }).integratedLufs
  console.log(`  stereo copy: ${stereoCopyLufs.toFixed(3)} LUFS, ${stereoCopyDecoded.channels.length} ch, true peak ${stereoCopy.written.truePeakDbtp} dBTP, targetHit ${stereoCopy.written.targetHit}`)
  check('a stereo correction is written instead of refused', stereoCopy.written !== null && stereoCopyDecoded.channels.length === 2)
  check('stereo copy lands on the target', Math.abs(stereoCopyLufs - (-20)) <= 0.15, String(stereoCopyLufs))
  check('stereo copy keeps both channels', stereoCopy.written.channelLayout === 'stereo', String(stereoCopy.written.channelLayout))

  // A file carrying NaN/±Infinity is described as broken, not as a level: no
  // `Infinity dBFS`, no fake "silent" reading, and it cannot be normalised into
  // a plausible-looking deliverable. `encodeWav` clamps such samples, so the
  // fixture is a hand-written 32-bit IEEE float WAVE that really carries them.
  {
    const frames = 4800
    const poisoned = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) poisoned[i] = 0.1 * Math.sin(2 * Math.PI * 997 * i / 48000)
    poisoned[100] = Number.NaN
    poisoned[200] = Number.POSITIVE_INFINITY
    const data = Buffer.alloc(frames * 4)
    for (let i = 0; i < frames; i += 1) data.writeFloatLE(poisoned[i], i * 4)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(3, 20) // IEEE float
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(48000, 24)
    header.writeUInt32LE(48000 * 4, 28)
    header.writeUInt16LE(4, 32)
    header.writeUInt16LE(32, 34)
    header.write('data', 36)
    header.writeUInt32LE(data.length, 40)
    await writeFile(join(cwd, 'poisoned.wav'), Buffer.concat([header, data]))
    const result = await call('audio_loudness', { path: 'poisoned.wav' })
    console.log(`  poisoned file: nonFiniteSamples ${result.nonFiniteSamples}, silent ${result.metrics.silent}, ` +
      `lufs ${result.metrics.lufs}, peak ${result.metrics.peakDbfs} | ${result.text}`)
    check('a poisoned file reports the non-finite count', result.nonFiniteSamples === 2, String(result.nonFiniteSamples))
    check('a poisoned file is not called silent', result.metrics.silent === false, String(result.metrics.silent))
    check('a poisoned file reports no invented level', result.metrics.lufs === null && result.metrics.peakDbfs === null &&
      result.metrics.rmsDbfs === null && result.metrics.truePeakDbtp === null,
    JSON.stringify({ lufs: result.metrics.lufs, peak: result.metrics.peakDbfs, rms: result.metrics.rmsDbfs, tp: result.metrics.truePeakDbtp }))
    check('the text explains the non-finite samples', /non-finite samples: 2 of 4800/.test(result.text), result.text)
    let error = null
    try { await call('audio_loudness', { path: 'poisoned.wav', targetLufs: -20, out: 'poisoned-out.wav' }) } catch (caught) { error = caught }
    check('a poisoned file cannot be normalised', error !== null && /non-finite/.test(error.message), error?.message)
  }

  // The corrected copy must never overwrite its own input.
  let error = null
  for (const out of ['cue.wav', './cue.wav', join(cwd, 'cue.wav')]) {
    try { await call('audio_loudness', { path: 'cue.wav', targetLufs: -20, out }) } catch (caught) { error = caught }
    check(`overwrite of the input is refused (${out})`, error !== null && /overwrite/.test(error.message), error?.message)
    error = null
  }

  // Guard rails.
  try { await call('audio_loudness', {}) } catch (caught) { error = caught }
  check('needs path or render', error !== null && /path|render/.test(error.message), error?.message)
  error = null
  try { await call('audio_loudness', { path: 'cue.wav', render: { preset: 'tick' } }) } catch (caught) { error = caught }
  check('path and render are exclusive', error !== null && /not both/.test(error.message), error?.message)
}

/* ------------------------------------------------- ffmpeg ebur128 agreement -- */

/**
 * Locate an ffmpeg binary: an explicit override, the copy DSH ships, then PATH.
 * The cross-check below is skipped (not failed) when none is available, so CI
 * without ffmpeg still runs the rest of the suite.
 */
function findFfmpeg () {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? null
  const candidates = [
    process.env.DSH_FFMPEG_PATH,
    home === null ? null : join(home, '.dsh', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg'
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
      if (probe.status === 0) return 'ffmpeg'
    } else if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** Integrated loudness of a wav file according to ffmpeg's ebur128 meter, or NaN. */
function ffmpegLufs (ffmpeg, path) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', path,
    '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const matches = [...text.matchAll(/I:\s+(-?[\d.]+) LUFS/g)]
  return matches.length === 0 ? Number.NaN : Number(matches[matches.length - 1][1])
}

console.log('\n-- ffmpeg ebur128 cross-check: mono and stereo must read the same LUFS --')
{
  const ffmpeg = findFfmpeg()
  if (ffmpeg === null) {
    console.log('  SKIP: no ffmpeg found (set DSH_FFMPEG_PATH, or install ffmpeg) — the plugin/ebur128 agreement is not checked here')
  } else {
    console.log(`  ffmpeg: ${ffmpeg}`)
    const cases = [
      // These are real rendered files on disk, not sines: the number has to
      // agree for actual material, which is what the red-team report compared.
      ['mono cue', 'cue.wav', (decoded) => analyzeLoudness(decoded.channels[0], decoded.sampleRate).integratedLufs],
      ['mono copy', 'mono-target.wav', (decoded) => analyzeLoudness(decoded.channels[0], decoded.sampleRate).integratedLufs],
      ['stereo cue', 'stereo.wav', (decoded) => analyzeLoudness(decoded.channels[0], decoded.sampleRate, { channels: decoded.channels }).integratedLufs]
    ]
    for (const [label, file, pluginReader] of cases) {
      const decoded = decodeWav(await readFile(join(cwd, file)))
      const plugin = pluginReader(decoded)
      const measured = ffmpegLufs(ffmpeg, join(cwd, file))
      console.log(`  ${label.padEnd(11)} plugin ${plugin.toFixed(3)} LUFS · ffmpeg ${Number.isFinite(measured) ? measured.toFixed(1) : 'n/a'} LUFS · diff ${Number.isFinite(measured) ? Math.abs(plugin - measured).toFixed(3) : 'n/a'} LU`)
      check(`${label}: plugin and ffmpeg agree within 0.1 LU`, Number.isFinite(measured) && Math.abs(plugin - measured) <= 0.1,
        `${plugin} vs ${measured}`)
    }
  }
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\nOK: loudness metering calibrates and behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
