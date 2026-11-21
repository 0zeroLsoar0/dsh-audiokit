/**
 * Loudness tests: BS.1770-4 / EBU R128 calibration, gating, true peak, gain
 * planning, and the tool layer.
 *
 * The calibration section is the important one: a 997 Hz sine at -23 dBFS has
 * to read -23.0 LUFS on every supported sample rate. Everything downstream
 * (targets like -14 LUFS, the gain planner) is only meaningful if the filters
 * are right, so this file prints the measured numbers rather than asserting
 * against a hardcoded expectation it could not have produced.
 *
 * Run: node test/lufs.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

console.log('\n-- calibration: 997 Hz sine at -23 dBFS should read -23.0 LUFS --')
const calibration = new Map()
for (const sampleRate of SAMPLE_RATES) {
  const analysis = analyzeLoudness(sine(3, sampleRate, 997, -23), sampleRate)
  calibration.set(sampleRate, analysis)
  console.log(
    `  ${String(sampleRate).padStart(5)} Hz -> ${analysis.integratedLufs.toFixed(3)} LUFS  ` +
    `(true peak ${analysis.truePeakDbtp.toFixed(3)} dBTP, ${analysis.gatedBlocks}/${analysis.blocksMeasured} gated blocks, ` +
    `${analysis.durationSeconds}s)`
  )
  check(`${sampleRate} integrated -23 +/- 0.3`, Math.abs(analysis.integratedLufs + 23) <= 0.3, `${analysis.integratedLufs}`)
  check(`${sampleRate} true peak -23 +/- 0.05`, Math.abs(analysis.truePeakDbtp + 23) <= 0.05, `${analysis.truePeakDbtp}`)
  check(`${sampleRate} blocks gated`, analysis.gatedBlocks === analysis.blocksMeasured && analysis.gatedBlocks > 0)
}

console.log('\n-- 1 kHz sine at -20 dBFS should read -20 LUFS --')
for (const sampleRate of [44100, 48000]) {
  const analysis = analyzeLoudness(sine(3, sampleRate, 1000, -20), sampleRate)
  console.log(`  ${sampleRate} Hz -> ${analysis.integratedLufs.toFixed(3)} LUFS`)
  check(`${sampleRate} 1 kHz -20 +/- 0.4`, Math.abs(analysis.integratedLufs + 20) <= 0.4, `${analysis.integratedLufs}`)
}

console.log('\n-- mono playback convention (dual mono vs strict single channel) --')
{
  const source = sine(3, 48000, 997, -23)
  const dual = analyzeLoudness(source, 48000)
  const single = analyzeLoudness(source, 48000, { dualMono: false })
  console.log(`  48000 Hz: dual mono ${dual.integratedLufs.toFixed(3)} LUFS, single channel ${single.integratedLufs.toFixed(3)} LUFS, difference ${(dual.integratedLufs - single.integratedLufs).toFixed(3)} LU`)
  check('single-channel is 3.01 LU quieter', Math.abs((dual.integratedLufs - single.integratedLufs) - 3.01) < 0.02)
  check('single-channel still ~-26', Math.abs(single.integratedLufs + 26.01) < 0.3, `${single.integratedLufs}`)
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
  const third = analyzeLoudness(song.samples, song.sampleRate, { dualMono: false })
  console.log(`  twice: ${first.integratedLufs} / ${second.integratedLufs} LUFS, true peak ${first.truePeakDbtp} / ${second.truePeakDbtp} dBTP`)
  check('identical numbers', JSON.stringify(first) === JSON.stringify(second))
  check('single-channel option changes the result', Math.abs((first.integratedLufs - third.integratedLufs) - 3.01) < 0.02)
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
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(cwd, 'cue.wav'), bytes)
  const measured = await call('audio_loudness', { path: 'cue.wav' })
  console.log(`  file: ${measured.relativePath} -> ${measured.metrics.lufs} LUFS, ${measured.metrics.truePeakDbtp} dBTP, ${measured.bytes} bytes`)
  check('file measurement returns a path', measured.relativePath === 'cue.wav', String(measured.relativePath))
  check('file measurement reads bytes', measured.bytes === bytes.length, String(measured.bytes))
  const decodedCue = decodeWav(await readFile(join(cwd, 'cue.wav')))
  check('file measurement matches direct analysis', Math.abs(measured.metrics.lufs - analyzeLoudness(decodedCue.channels[0], decodedCue.sampleRate).integratedLufs) < 0.01)

  // Normalise the hot mix to -14 LUFS and prove the written file stays under
  // the true-peak ceiling.
  const hot = buildSong()
  finalize(hot.samples, 48000, -0.2)
  await writeFile(join(cwd, 'hot.wav'), toWavBytes(hot.samples, 48000))
  const written = await call('audio_loudness', { path: 'hot.wav', targetLufs: -14, out: 'normalised.wav' })
  console.log(`  ${written.text}`)
  check('wrote corrected copy', written.written !== null && written.relativePath === 'normalised.wav', String(written.relativePath))
  const correctedDecoded = decodeWav(await readFile(join(cwd, 'normalised.wav')))
  const correctedPeak = truePeak(correctedDecoded.channels[0], correctedDecoded.sampleRate)
  const correctedLufs = analyzeLoudness(correctedDecoded.channels[0], correctedDecoded.sampleRate).integratedLufs
  console.log(`  written file: ${correctedLufs.toFixed(3)} LUFS, true peak ${correctedPeak.toFixed(3)} dBTP (was ${written.before.lufs} LUFS / ${written.before.truePeakDbtp} dBTP)`)
  check('normalised copy hits the target', Math.abs(correctedLufs - (-14)) <= 0.15, String(correctedLufs))
  check('normalised copy never exceeds -1 dBTP', correctedPeak <= -1.0, String(correctedPeak))
  check('before/after both reported', Number.isFinite(written.before.lufs) && written.after !== null && Number.isFinite(written.after.lufs))
  check('metrics describe the written file', Math.abs(written.metrics.lufs - correctedLufs) < 0.01, String(written.metrics.lufs))

  // The same call twice must produce the same numbers (the dither can move the
  // last decimal of true peak, so compare loudness exactly and peak closely).
  const again = await call('audio_loudness', { path: 'hot.wav', targetLufs: -14, out: 'normalised-2.wav' })
  check('tool measurement is deterministic', measured.metrics.lufs === (await call('audio_loudness', { path: 'cue.wav' })).metrics.lufs)
  check('tool normalisation gain is deterministic', Math.abs(again.target.gainDb - written.target.gainDb) < 1e-9, `${again.target.gainDb} vs ${written.target.gainDb}`)

  // A target the file cannot reach without breaking the ceiling must still be
  // written at the largest safe gain, and the file must stay under -1 dBTP.
  const pushed = await call('audio_loudness', { path: 'hot.wav', targetLufs: -6, out: 'pushed.wav' })
  console.log(`  ${pushed.text}`)
  const pushedDecoded = decodeWav(await readFile(join(cwd, 'pushed.wav')))
  const pushedPeak = truePeak(pushedDecoded.channels[0], pushedDecoded.sampleRate)
  check('capped write respects the ceiling', pushedPeak <= -1.0, String(pushedPeak))
  check('capped write reports it fell short', pushed.written.targetHit === false && pushed.target.achievable === false)
  check('capped write says the peak is the limit', pushed.target.limitedBy === 'true-peak')

  // Measuring with a target but no out must predict and write nothing.
  const predicted = await call('audio_loudness', { path: 'hot.wav', targetLufs: -14 })
  check('prediction without out writes nothing', predicted.written === null && predicted.after === null)
  check('prediction reports a gain', predicted.target !== null && Number.isFinite(predicted.target.gainDb))

  // Stereo file: EBU Tech 3341's reference signal is a 997 Hz sine at -23 dBFS
  // in both channels, and it must read -23.0 LUFS. This exercises the channel
  // summing path (a stereo file must not be turned into a mono average).
  const left = sine(3, 48000, 997, -23)
  const right = sine(3, 48000, 997, -23, 0.9)
  await writeFile(join(cwd, 'stereo.wav'), encodeWav([left, right], 48000))
  const stereo = await call('audio_loudness', { path: 'stereo.wav' })
  console.log(`  stereo 997 Hz -23 dBFS per channel -> ${stereo.metrics.lufs} LUFS (${stereo.metrics.channelCount} channels)`)
  check('stereo file reads the EBU 3341 reference level', Math.abs(stereo.metrics.lufs + 23) <= 0.3, String(stereo.metrics.lufs))
  check('stereo channel count reported', stereo.metrics.channelCount === 2, String(stereo.metrics.channelCount))
  let error = null
  try { await call('audio_loudness', { path: 'stereo.wav', targetLufs: -14, out: 'stereo-out.wav' }) } catch (caught) { error = caught }
  check('refuses to mono-fold a stereo correction', error !== null && /mono/.test(error.message), error?.message)

  // Guard rails.
  try { await call('audio_loudness', {}) } catch (caught) { error = caught }
  check('needs path or render', error !== null && /path|render/.test(error.message), error?.message)
  error = null
  try { await call('audio_loudness', { path: 'cue.wav', render: { preset: 'tick' } }) } catch (caught) { error = caught }
  check('path and render are exclusive', error !== null && /not both/.test(error.message), error?.message)
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\nOK: loudness metering calibrates and behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
