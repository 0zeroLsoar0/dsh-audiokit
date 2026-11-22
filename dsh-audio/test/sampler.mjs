/**
 * Acceptance tests for lib/sampler.js and the `audio_sampler` tool.
 *
 * Fixtures are generated with the plugin's own engines — `dsp.glideTone` for the
 * exact 220 Hz tone, `audio.renderPreset` for the percussive hit and the noise
 * takes — so the test is self-contained: no recording, no download, no bank.
 * That is also the point of the tier being tested.
 *
 * Every check prints the number it measured. The interesting number here is the
 * pitch/time coupling: a note +12 semitones measures 440 Hz *and* half the
 * duration, because playback is interpolated resampling. That is a documented
 * property of the tier, not an accident, and the test pins it down so it cannot
 * regress silently.
 *
 * Run it with node (the package is ESM):
 *
 *   node test/sampler.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSound } from '../lib/analyze.js'
import { renderPreset } from '../lib/audio.js'
import { glideTone } from '../lib/dsp.js'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { SAMPLER_LIMITS, buildKeymap, loadSample, midiToName, renderSampler, samplerInfo } from '../lib/sampler.js'
import { registerSamplerTools } from '../lib/tools-sampler.js'

const RATE = 44100
const TONE_HZ = 220
const TONE_SECONDS = 1.2
const TONE_AMPLITUDE = 0.25
const BPM = 96

let failures = 0

function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : `  (${detail})`}`)
}

function num (value, digits = 2) {
  return Number(value).toFixed(digits)
}

/* ------------------------------------------------------------- fixtures -- */

/** A steady sine at an exact frequency, from the engine's own tone primitive. */
function makeTone (hz = TONE_HZ, seconds = TONE_SECONDS, rate = RATE, amplitude = TONE_AMPLITUDE) {
  const frames = Math.round(seconds * rate)
  const tone = glideTone(frames, rate, hz, hz, 1, () => 1, 0)
  for (let i = 0; i < tone.length; i += 1) tone[i] *= amplitude
  return tone
}

async function writeWav (path, channels, rate, options = {}) {
  await writeFile(path, encodeWav(channels, rate, options))
}

/* --------------------------------------------------------- measurements -- */

function rmsIn (samples, rate, fromSeconds, toSeconds) {
  const from = Math.max(0, Math.round(fromSeconds * rate))
  const to = Math.min(samples.length, Math.round(toSeconds * rate))
  let sum = 0
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** Last sample index above a threshold: the duration of the *sound*, not the buffer. */
function lastSounding (samples, threshold = 1e-3) {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (Math.abs(samples[i]) > threshold) return i
  }
  return -1
}

function maxStep (samples, fromFrame, toFrame) {
  let step = 0
  const from = Math.max(1, fromFrame)
  const to = Math.min(samples.length, toFrame)
  for (let i = from; i < to; i += 1) {
    const current = Math.abs(samples[i] - samples[i - 1])
    if (current > step) step = current
  }
  return step
}

/** Largest step in a small window around a frame: robust to a 1-frame rounding. */
function stepNear (samples, frame, radius = 2) {
  return maxStep(samples, frame - radius, frame + radius + 1)
}

/** Fundamental measured by lib/analyze.js (present in this package). */
function measureF0 (samples, rate) {
  return analyzeSound(samples, rate, { f0Range: [100, 900] }).f0
}

/* ------------------------------------------------------------ fixtures --- */

const cwd = await mkdtemp(join(tmpdir(), 'dsh-sampler-'))
const tonePath = join(cwd, 'tone.wav')
const hitPath = join(cwd, 'hit.wav')
const noiseAPath = join(cwd, 'noise-a.wav')
const noiseBPath = join(cwd, 'noise-b.wav')
const takes = {}

await writeWav(tonePath, [makeTone()], RATE)
{
  const hit = renderPreset({ preset: 'impact', seed: 3, duration: 0.8 })
  await writeWav(hitPath, [hit.samples], hit.sampleRate)
  const noiseA = renderPreset({ preset: 'scrap', seed: 7, duration: 0.4 })
  await writeWav(noiseAPath, [noiseA.samples], noiseA.sampleRate)
  const noiseB = renderPreset({ preset: 'scrap', seed: 8, duration: 0.4 })
  await writeWav(noiseBPath, [noiseB.samples], noiseB.sampleRate)
}
for (const rate of [22050, 32000, 44100]) {
  takes[rate] = join(cwd, `take-${rate}.wav`)
  await writeWav(takes[rate], [makeTone(TONE_HZ, TONE_SECONDS, rate)], rate)
}
const silentPath = join(cwd, 'silent.wav')
// Dither off: the encoder's last-bit dither would otherwise leave a -90 dBFS
// floor, which is not "silent" and should not be mistaken for it.
await writeWav(silentPath, [new Float32Array(RATE / 10)], RATE, { dither: false })
const notWavPath = join(cwd, 'not-a-wav.bin')
await writeFile(notWavPath, Buffer.from('this is not a RIFF file, it is text'))

console.log('-- fixtures --')
console.log(`  220 Hz tone ${TONE_SECONDS}s @${RATE} Hz, linear amplitude ${TONE_AMPLITUDE}; impact + 2 scrap takes; takes at ${Object.keys(takes).join('/')} Hz`)

/* ---- 1. loadSample: decode, downmix, silence, missing files ---- */
console.log('\n-- loadSample --')
{
  const loaded = loadSample(tonePath)
  console.log(`  tone.wav: ${loaded.sampleRate} Hz, ${num(loaded.durationSeconds, 3)}s, ${loaded.channels} ch, peak ${num(loaded.peakDbfs)} dBFS, ${loaded.bytes} B`)
  check('load rate', loaded.sampleRate === RATE)
  check('load duration', Math.abs(loaded.durationSeconds - TONE_SECONDS) < 0.001, `${loaded.durationSeconds}`)
  check('load channels', loaded.channels === 1)
  check('load peak matches fixture', Math.abs(loaded.peakDbfs - 20 * Math.log10(TONE_AMPLITUDE)) < 0.05, `${loaded.peakDbfs}`)
  check('load samples are floats', loaded.samples instanceof Float32Array)

  // Stereo downmix: one live channel, one silent => half amplitude, i.e. -6 dB.
  const stereoBytes = encodeWav([makeTone(), new Float32Array(Math.round(TONE_SECONDS * RATE))], RATE)
  const stereo = loadSample(stereoBytes)
  console.log(`  stereo (one silent side): ${stereo.channels} ch -> peak ${num(stereo.peakDbfs)} dBFS (expect -18.06)`)
  check('stereo downmix to mono', stereo.channels === 2 && stereo.samples.length === Math.round(TONE_SECONDS * RATE))
  check('downmix averages channels', Math.abs(stereo.peakDbfs - (20 * Math.log10(TONE_AMPLITUDE) - 6.02)) < 0.05, `${stereo.peakDbfs}`)

  // Converting rate on load keeps the duration and changes the frame count.
  const at22 = loadSample(tonePath, { sampleRate: 22050 })
  console.log(`  resampled on load: ${at22.sampleRate} Hz, ${at22.samples.length} frames, ${num(at22.durationSeconds, 3)}s`)
  check('load resamples to requested rate', at22.sampleRate === 22050)
  check('load resample keeps duration', Math.abs(at22.durationSeconds - TONE_SECONDS) < 0.002, `${at22.durationSeconds}`)

  // Already-decoded input, for callers that generated the samples in memory.
  const decodedInput = loadSample({ samples: makeTone(), sampleRate: RATE })
  console.log(`  in-memory { samples, sampleRate }: ${decodedInput.samples.length} frames, peak ${num(decodedInput.peakDbfs)} dBFS`)
  check('decoded input accepted', decodedInput.samples.length === Math.round(TONE_SECONDS * RATE))

  const expectThrow = (label, run, pattern) => {
    try {
      run()
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 110)}`)
    }
  }
  expectThrow('missing file names the path', () => loadSample(join(cwd, 'does-not-exist.wav')), /does-not-exist\.wav/)
  expectThrow('silence rejected', () => loadSample(silentPath), /silent/)
  expectThrow('zero buffer rejected', () => loadSample(new Float32Array(4410), { sampleRate: RATE }), /silent/)
  expectThrow('non-wav bytes rejected', () => loadSample(notWavPath), /cannot decode.*not-a-wav\.bin/)
  expectThrow('empty source rejected', () => loadSample(undefined), /needs a \.wav path/)
}

/* ---- 2. buildKeymap: validation, gaps, overlaps, info ---- */
console.log('\n-- buildKeymap --')
{
  const single = buildKeymap([{ path: tonePath, name: 'tone', rootMidi: 57, lowMidi: 45, highMidi: 76 }])
  console.log(`  1 zone: ${single.count}, keys ${midiToName(single.lowMidi)}–${midiToName(single.highMidi)}, layers ${single.velocityLayers}, bytes ${single.totalBytes}`)
  check('single zone count', single.count === 1)
  check('zone root/range', single.zones[0].rootMidi === 57 && single.zones[0].lowMidi === 45 && single.zones[0].highMidi === 76)
  check('no gaps in one zone', single.gaps.length === 0)
  check('no overlaps in one zone', single.overlaps.length === 0)
  check('total bytes sums files', single.totalBytes === loadSample(tonePath).bytes)

  const gapped = buildKeymap([
    { path: tonePath, name: 'low', rootMidi: 43, lowMidi: 36, highMidi: 50 },
    { path: tonePath, name: 'high', rootMidi: 72, lowMidi: 62, highMidi: 84 }
  ])
  console.log(`  gap map: gaps ${JSON.stringify(gapped.gaps)}`)
  check('gap reported', gapped.gaps.length === 1 && gapped.gaps[0].lowMidi === 51 && gapped.gaps[0].highMidi === 61)

  const overlapping = buildKeymap([
    { path: tonePath, name: 'a', rootMidi: 60, lowMidi: 55, highMidi: 70 },
    { path: tonePath, name: 'b', rootMidi: 64, lowMidi: 55, highMidi: 70 }
  ])
  console.log(`  overlap map: ${overlapping.overlaps.length} overlap(s) ${JSON.stringify(overlapping.overlaps[0] ?? {})}`)
  check('overlap reported', overlapping.overlaps.length === 1 && overlapping.overlaps[0].lowMidi === 55)

  const layered = buildKeymap([
    { path: takes[44100], name: 'loud', rootMidi: 57, velocityLo: 0.5, velocityHi: 1 },
    { path: takes[22050], name: 'quiet', rootMidi: 57, velocityLo: 0, velocityHi: 0.5 }
  ])
  console.log(`  velocity layers: ${layered.velocityLayers} layer(s), overlaps ${layered.overlaps.length} (touching bands are not an overlap)`)
  check('velocity layers counted', layered.velocityLayers === 2)
  check('touching velocity bands are not an overlap', layered.overlaps.length === 0)

  const clamped = buildKeymap([{ path: tonePath, rootMidi: 57, tuneCents: 5000, gainDb: 100 }])
  console.log(`  clamps: tune ${clamped.zones[0].tuneCents}c, gain ${clamped.zones[0].gainDb} dB`)
  check('tune clamped', clamped.zones[0].tuneCents === SAMPLER_LIMITS.maxTuneCents)
  check('gain clamped', clamped.zones[0].gainDb === SAMPLER_LIMITS.maxGainDb)

  const autoLoop = buildKeymap([{ path: tonePath, rootMidi: 57, loop: true }])
  console.log(`  auto loop: ${num(autoLoop.zones[0].loop.startSeconds, 3)}–${num(autoLoop.zones[0].loop.endSeconds, 3)}s`)
  check('auto loop covers the sustain', autoLoop.zones[0].loop.startSeconds > 0 && autoLoop.zones[0].loop.endSeconds < TONE_SECONDS)

  const expectThrow = (label, run, pattern) => {
    try {
      run()
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 110)}`)
    }
  }
  expectThrow('empty map rejected', () => buildKeymap([]), /at least one zone/)
  expectThrow('rootMidi required', () => buildKeymap([{ path: tonePath }]), /rootMidi is required/)
  expectThrow('low above high rejected', () => buildKeymap([{ path: tonePath, rootMidi: 60, lowMidi: 70, highMidi: 60 }]), /lowMidi <= highMidi/)
  expectThrow('half a loop rejected', () => buildKeymap([{ path: tonePath, rootMidi: 60, loopStart: 0.2 }]), /both loopStart and loopEnd/)
  expectThrow('loop past the end rejected', () => buildKeymap([{ path: tonePath, rootMidi: 60, loopStart: 0.2, loopEnd: 9 }]), /past the end/)
  expectThrow('zone path missing names the path', () => buildKeymap([{ path: join(cwd, 'no-such-zone.wav'), rootMidi: 60 }]), /no-such-zone\.wav/)
  expectThrow('velocity band inverted rejected', () => buildKeymap([{ path: tonePath, rootMidi: 60, velocityLo: 0.8, velocityHi: 0.2 }]), /velocityLo < velocityHi/)

  // A loop whose end sits against the sample end is shortened rather than left
  // with an audible seam; the report says so.
  const trimmed = buildKeymap([{ path: tonePath, rootMidi: 57, loopStart: 0.2, loopEnd: TONE_SECONDS - 0.005 }])
  console.log(`  loop near the end: end ${num(trimmed.zones[0].loop.endSeconds, 3)}s, warning "${trimmed.warnings[0] ?? ''}"`)
  check('loop end trimmed with a warning', trimmed.zones[0].loop.endSeconds < TONE_SECONDS - 0.005 && trimmed.warnings.length === 1)

  const info = samplerInfo(single)
  console.log('  samplerInfo:')
  for (const line of info.split('\n')) console.log(`    ${line}`)
  check('info mentions zones and roots', info.includes('1 zone(s)') && info.includes('root A3'))
  check('info mentions range and bytes', info.includes('A2–E5') && info.includes('KB'))
  check('info mentions gaps', samplerInfo(gapped).includes('gaps'))
}

/* ---- 3. pitch: interpolated resampling, and the coupling that comes with it ---- */
console.log('\n-- pitch (and the pitch/time coupling) --')
{
  const keymap = buildKeymap([{ path: tonePath, name: 'tone', rootMidi: 57, lowMidi: 45, highMidi: 76 }])
  const play = (midi) => renderSampler({
    keymap,
    notes: [{ midi, startBeat: 0, durBeats: 4, velocity: 1 }],
    bpm: BPM,
    envelope: { attack: 0.002, release: 0.02 }
  })

  const atRoot = play(57)
  const octaveUp = play(69)
  const f0Root = measureF0(atRoot.samples, atRoot.sampleRate)
  const f0Up = measureF0(octaveUp.samples, octaveUp.sampleRate)
  const rootSeconds = lastSounding(atRoot.samples) / atRoot.sampleRate
  const upSeconds = lastSounding(octaveUp.samples) / octaveUp.sampleRate
  console.log(`  midi 57 (root): f0 ${num(f0Root.hz)} Hz (want ${TONE_HZ}), confidence ${num(f0Root.confidence, 3)}, sounding ${num(rootSeconds, 3)}s, shift ${JSON.stringify(atRoot.report.pitchShiftRange)}`)
  console.log(`  midi 69 (+12):  f0 ${num(f0Up.hz)} Hz (want ${TONE_HZ * 2}), confidence ${num(f0Up.confidence, 3)}, sounding ${num(upSeconds, 3)}s, shift ${JSON.stringify(octaveUp.report.pitchShiftRange)}`)
  check('root note keeps 220 Hz', Math.abs(f0Root.hz - TONE_HZ) / TONE_HZ <= 0.01, `${f0Root.hz}`)
  check('+12 semitones measures 440 Hz', Math.abs(f0Up.hz - TONE_HZ * 2) / (TONE_HZ * 2) <= 0.01, `${f0Up.hz}`)
  check('root shift is 0', atRoot.report.pitchShiftRange.minSemitones === 0 && atRoot.report.pitchShiftRange.maxSemitones === 0)
  check('octave shift is +12', octaveUp.report.pitchShiftRange.minSemitones === 12 && octaveUp.report.pitchShiftRange.maxSemitones === 12)
  // The documented limitation: resampling couples pitch and time.
  const speedRatio = rootSeconds / upSeconds
  console.log(`  coupling: +12 semitones plays ${num(speedRatio, 3)}x faster (a transposer would keep 1.0x) — no time-stretch in this tier`)
  check('octave up is twice as fast', Math.abs(speedRatio - 2) <= 0.03, `${speedRatio}`)

  // A note below the root is proportionally slower and longer.
  const fifthDown = play(50)
  const f0Down = measureF0(fifthDown.samples, fifthDown.sampleRate)
  const downSeconds = lastSounding(fifthDown.samples) / fifthDown.sampleRate
  console.log(`  midi 50 (-7):   f0 ${num(f0Down.hz)} Hz (want ${num(TONE_HZ * Math.pow(2, -7 / 12))}), sounding ${num(downSeconds, 3)}s`)
  check('down a fifth is lower', f0Down.hz < TONE_HZ * 0.7 && f0Down.hz > TONE_HZ * 0.6, `${f0Down.hz}`)
  check('down a fifth is longer', downSeconds > rootSeconds * 1.4, `${downSeconds}`)

  // Tuning is applied as a pitch ratio, so a zone tuned +100 c is +1 semitone.
  const tuned = buildKeymap([{ path: tonePath, rootMidi: 57, tuneCents: 100 }])
  const tunedOut = renderSampler({ keymap: tuned, notes: [{ midi: 57, durBeats: 4, velocity: 1 }], bpm: BPM })
  const f0Tuned = measureF0(tunedOut.samples, tunedOut.sampleRate)
  console.log(`  +100 cents at midi 57: f0 ${num(f0Tuned.hz)} Hz (want ${num(TONE_HZ * Math.pow(2, 1 / 12))})`)
  check('tuneCents shifts pitch', Math.abs(f0Tuned.hz - TONE_HZ * Math.pow(2, 1 / 12)) / TONE_HZ < 0.01, `${f0Tuned.hz}`)
}

/* ---- 4. velocity layers and deterministic round-robin ---- */
console.log('\n-- velocity layers and round-robin --')
{
  const layered = buildKeymap([
    { path: takes[44100], name: 'loud', rootMidi: 57, velocityLo: 0.5, velocityHi: 1 },
    { path: takes[22050], name: 'quiet', rootMidi: 57, velocityLo: 0, velocityHi: 0.5 }
  ])
  const dynamic = renderSampler({
    keymap: layered,
    notes: [
      { midi: 57, startBeat: 0, durBeats: 1, velocity: 0.9 },
      { midi: 57, startBeat: 1, durBeats: 1, velocity: 0.2 }
    ],
    bpm: BPM
  })
  const loudHit = dynamic.report.zoneHits[0]
  const quietHit = dynamic.report.zoneHits[1]
  console.log(`  velocity 0.9 -> ${loudHit.name} (${loudHit.hits} hit, ${loudHit.sampleRate} Hz file); velocity 0.2 -> ${quietHit.name} (${quietHit.hits} hit, ${quietHit.sampleRate} Hz file)`)
  check('loud note picks the loud layer', dynamic.report.picks[0].zoneName === 'loud' && loudHit.hits === 1, JSON.stringify(dynamic.report.picks))
  check('quiet note picks the quiet layer', dynamic.report.picks[1].zoneName === 'quiet' && quietHit.hits === 1, JSON.stringify(dynamic.report.picks))
  check('layer marker is the file sample rate', loudHit.sampleRate === 44100 && quietHit.sampleRate === 22050)
  const loudRms = rmsIn(dynamic.samples, dynamic.sampleRate, 0.05, 0.2)
  const quietRms = rmsIn(dynamic.samples, dynamic.sampleRate, 0.68, 0.83)
  console.log(`  layer levels: loud note rms ${num(20 * Math.log10(loudRms))} dBFS, quiet note rms ${num(20 * Math.log10(quietRms))} dBFS`)
  check('quiet note is quieter', quietRms < loudRms * 0.5, `${num(quietRms)} vs ${num(loudRms)}`)

  const takesMap = buildKeymap(Object.values(takes).map((path, index) => ({ path, name: `take${index}`, rootMidi: 57 })))
  const orderOf = (seed) => {
    const out = renderSampler({
      keymap: takesMap,
      notes: [0, 1, 2].map((index) => ({ midi: 57, startBeat: index, durBeats: 1, velocity: 1 })),
      bpm: BPM,
      seed
    })
    return out.report.picks.map((pick) => `${pick.zoneName}:${pick.take}`)
  }
  const seed0 = orderOf(0)
  const seed1 = orderOf(1)
  const seed0Again = orderOf(0)
  console.log(`  round-robin order: seed 0 -> ${seed0.join(' ')}; seed 1 -> ${seed1.join(' ')}; seed 0 again -> ${seed0Again.join(' ')}`)
  check('round-robin cycles every take', new Set(seed0.map((entry) => entry.split(':')[0])).size === 3)
  check('seed rotates the first take', seed1[0] !== seed0[0])
  check('same seed reproduces the order', seed0.join('|') === seed0Again.join('|'))
  check('three notes use three different takes', new Set(seed0.map((entry) => entry.split(':')[1])).size === 3, seed0.join(' '))
}

/* ---- 5. loop: longer than the recording, no click at the seam ---- */
console.log('\n-- loop --')
{
  const loopStart = 0.2
  // Deliberately not a whole number of 220 Hz periods (0.50123s is 110.27
  // cycles), so a naive loop really is discontinuous and the crossfade has
  // something audible to hide.
  const loopEnd = 0.50123
  const loopMap = buildKeymap([{ path: tonePath, name: 'tone', rootMidi: 57, lowMidi: 45, highMidi: 76, loopStart, loopEnd }])
  const playLoop = (crossfade) => renderSampler({
    keymap: loopMap,
    notes: [{ midi: 57, startBeat: 0, durBeats: 2, velocity: 1 }],
    bpm: BPM,
    envelope: { attack: 0.002, release: 0.05 },
    loopCrossfadeSeconds: crossfade
  })
  const looped = playLoop(undefined)
  const naive = playLoop(0)
  const endFrame = Math.round(loopEnd * RATE)
  const lengthFrames = endFrame - Math.round(loopStart * RATE)
  const wrapFrames = [0, 1, 2].map((k) => endFrame + k * lengthFrames)
  const interior = maxStep(looped.samples, Math.round(0.25 * RATE), Math.round(0.45 * RATE))
  const seamSteps = wrapFrames.map((frame) => stepNear(looped.samples, frame))
  const naiveSeamSteps = wrapFrames.map((frame) => stepNear(naive.samples, frame))

  console.log(`  loop ${num(loopStart, 3)}–${num(loopEnd, 3)}s = ${lengthFrames} frames; note 2 beats = 1.25s, sample ${TONE_SECONDS}s`)
  console.log(`  looped duration ${num(looped.report.durationSeconds, 3)}s, wraps ${looped.report.loopWraps}, loopedNotes ${looped.report.loopedNotes}; one-shot of the same zone would stop at ${TONE_SECONDS}s`)
  console.log(`  interior max step ${num(interior, 5)}; seam steps with crossfade ${seamSteps.map((step) => num(step, 5)).join(' ')}`)
  console.log(`  seam steps without crossfade ${naiveSeamSteps.map((step) => num(step, 5)).join(' ')}`)
  check('loop plays longer than the recording', looped.report.durationSeconds > TONE_SECONDS, `${looped.report.durationSeconds}`)
  check('loop wraps three times', looped.report.loopWraps === 3, `${looped.report.loopWraps}`)
  check('report counts the looped note', looped.report.loopedNotes === 1)
  check('crossfaded seam is below the interior step', Math.max(...seamSteps) < interior * 1.5, `${Math.max(...seamSteps)} vs ${interior}`)
  check('the metric does detect an uncrossfaded seam', Math.max(...naiveSeamSteps) > interior * 10, `${Math.max(...naiveSeamSteps)} vs ${interior}`)

  // One-shot control: the same zone without loop points is cut where the file ends.
  const oneShotMap = buildKeymap([{ path: tonePath, name: 'tone', rootMidi: 57 }])
  const oneShot = renderSampler({ keymap: oneShotMap, notes: [{ midi: 57, startBeat: 0, durBeats: 2, velocity: 1 }], bpm: BPM })
  console.log(`  one-shot control: ${num(oneShot.report.durationSeconds, 3)}s (recording ends at ${TONE_SECONDS}s)`)
  check('one-shot stops at the end of the recording', Math.abs(oneShot.report.durationSeconds - TONE_SECONDS) < 0.05, `${oneShot.report.durationSeconds}`)
}

/* ---- 6. polyphony: per-note gain, sum, softLimit ---- */
console.log('\n-- polyphony --')
{
  const keymap = buildKeymap([{ path: tonePath, name: 'tone', rootMidi: 57, lowMidi: 45, highMidi: 76 }])
  const play = (notes) => renderSampler({ keymap, notes, bpm: BPM, envelope: { attack: 0.002, release: 0.02 } })
  // Velocity 0.25 keeps the chord under the limiter knee, so the sum is linear.
  const single = play([{ midi: 57, startBeat: 0, durBeats: 4, velocity: 0.25 }])
  const chord = play([57, 60, 64].map((midi) => ({ midi, startBeat: 0, durBeats: 4, velocity: 0.25 })))
  const singleRms = rmsIn(single.samples, single.sampleRate, 0.1, 0.3)
  const chordRms = rmsIn(chord.samples, chord.sampleRate, 0.1, 0.3)
  const energyDb = 20 * Math.log10(chordRms / singleRms)
  const idealDb = 10 * Math.log10(3)
  console.log(`  3 uncorrelated voices: single rms ${num(singleRms, 5)}, chord rms ${num(chordRms, 5)} -> +${num(energyDb)} dB (3x energy = +${num(idealDb)} dB)`)
  check('chord sums to 3x energy', Math.abs(energyDb - idealDb) <= 0.5, `${energyDb} vs ${idealDb}`)
  check('chord does not clip', chord.report.peakDbfs < 0, `${chord.report.peakDbfs}`)

  // A deliberately over-loud cluster must be caught by the end-of-chain softLimit.
  const loud = play([57, 59, 60, 62, 64, 65, 67, 69].map((midi) => ({ midi, startBeat: 0, durBeats: 4, velocity: 1 })))
  let maxAbs = 0
  let atOne = 0
  for (const sample of loud.samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > maxAbs) maxAbs = magnitude
    if (magnitude >= 1) atOne += 1
  }
  console.log(`  8-voice cluster at velocity 1: peak ${num(loud.report.peakDbfs)} dBFS, max |x| ${num(maxAbs, 6)}, samples at full scale ${atOne}`)
  check('softLimit holds the ceiling', maxAbs < 1 && atOne === 0, `${maxAbs}`)
}

/* ---- 7. envelope: release extends, attack shapes the transient ---- */
console.log('\n-- envelope --')
{
  const hitMap = buildKeymap([{ path: hitPath, name: 'hit', rootMidi: 60 }])
  const play = (envelope, durBeats = 0.4) => renderSampler({ keymap: hitMap, notes: [{ midi: 60, startBeat: 0, durBeats, velocity: 1 }], bpm: BPM, envelope })
  const shortRelease = play({ attack: 0.002, release: 0.01 })
  const longRelease = play({ attack: 0.002, release: 0.5 })
  const releaseDelta = longRelease.report.durationSeconds - shortRelease.report.durationSeconds
  console.log(`  release 0.01s -> ${num(shortRelease.report.durationSeconds, 3)}s; release 0.50s -> ${num(longRelease.report.durationSeconds, 3)}s (delta ${num(releaseDelta, 3)}s)`)
  check('long release extends the tail', Math.abs(releaseDelta - 0.49) <= 0.03, `${releaseDelta}`)

  const shortAttack = play({ attack: 0.002, release: 0.01 }, 2)
  const longAttack = play({ attack: 0.2, release: 0.01 }, 2)
  const shortOnset = analyzeSound(shortAttack.samples, shortAttack.sampleRate).onset
  const longOnset = analyzeSound(longAttack.samples, longAttack.sampleRate).onset
  console.log(`  attack 0.002s: onset ${num(shortOnset.latencyMs, 1)} ms, attack ${num(shortOnset.attackMs, 1)} ms (${shortOnset.type})`)
  console.log(`  attack 0.200s: onset ${num(longOnset.latencyMs, 1)} ms, attack ${num(longOnset.attackMs, 1)} ms (${longOnset.type})`)
  check('short attack keeps the transient', shortOnset.attackMs <= 20, `${shortOnset.attackMs}`)
  check('long attack shapes the transient', longOnset.attackMs >= 100, `${longOnset.attackMs}`)
  check('attack is applied after pitch', longOnset.attackMs - shortOnset.attackMs >= 80, `${longOnset.attackMs - shortOnset.attackMs}`)
}

/* ---- 8. validation and unmapped notes ---- */
console.log('\n-- validation --')
{
  const gapped = buildKeymap([
    { path: tonePath, name: 'low', rootMidi: 43, lowMidi: 36, highMidi: 50 },
    { path: tonePath, name: 'high', rootMidi: 72, lowMidi: 62, highMidi: 84 }
  ])
  const partial = renderSampler({
    keymap: gapped,
    notes: [
      { midi: 48, startBeat: 0, durBeats: 1, velocity: 1 },
      { midi: 60, startBeat: 1, durBeats: 1, velocity: 1 }
    ],
    bpm: BPM
  })
  console.log(`  notes straddling a key gap: rendered ${partial.report.noteCount}, unmapped ${JSON.stringify(partial.report.unmappedNotes)}`)
  check('unmapped note reported, covered note rendered', partial.report.noteCount === 1 && partial.report.unmappedNotes.length === 1 && partial.report.unmappedNotes[0].midi === 60)

  const expectThrow = (label, run, pattern) => {
    try {
      run()
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 116)}`)
    }
  }
  expectThrow('no notes rejected', () => renderSampler({ keymap: gapped, notes: [] }), /no notes to render/)
  expectThrow('all notes off the keymap rejected', () => renderSampler({ keymap: gapped, notes: [{ midi: 60, durBeats: 1, velocity: 1 }] }), /none of the .* covered by the keymap/)
  expectThrow('keymap shape checked', () => renderSampler({ keymap: { zones: 3 }, notes: [{ midi: 60, velocity: 1 }] }), /keymap must be/)
  expectThrow('notes must be an array', () => renderSampler({ keymap: gapped, notes: 'C4' }), /notes must be an array/)
  expectThrow('note midi must be in range', () => renderSampler({ keymap: gapped, notes: [{ midi: 200, durBeats: 1 }] }), /note 0 midi must be a MIDI note 0\.\.127/)
  expectThrow('a 180 s request is refused', () => renderSampler({
    keymap: gapped,
    notes: [{ midi: 48, startBeat: 4000, durBeats: 1, velocity: 1 }],
    bpm: 20
  }), /more than the 180s one render accepts/)
  const tightLoopStart = TONE_SECONDS - 0.01
  expectThrow('a loop with no room for the crossfade is refused', () => renderSampler({
    zones: [{ path: tonePath, rootMidi: 57, loopStart: tightLoopStart, loopEnd: TONE_SECONDS }],
    notes: [{ midi: 57, startBeat: 0, durBeats: 1, velocity: 1 }],
    loopCrossfadeSeconds: 0.01
  }), /too close to the end/)
}

/* ---- 9. determinism and performance ---- */
console.log('\n-- determinism and performance --')
{
  const hitMap = buildKeymap([{ path: hitPath, name: 'hit', rootMidi: 60 }])
  const spec = { keymap: hitMap, notes: [{ midi: 60, startBeat: 0, durBeats: 1, velocity: 0.8 }], bpm: 120, seed: 3 }
  const first = renderSampler(spec)
  const second = renderSampler(spec)
  let identical = first.samples.length === second.samples.length
  if (identical) {
    for (let i = 0; i < first.samples.length; i += 1) {
      if (first.samples[i] !== second.samples[i]) {
        identical = false
        break
      }
    }
  }
  console.log(`  same spec twice: ${identical ? 'identical' : 'DIFFERENT'} (${first.samples.length} frames)`)
  check('same spec renders identical samples', identical)

  const fiveZones = buildKeymap([
    { path: tonePath, name: 'z1', rootMidi: 57, lowMidi: 45, highMidi: 57 },
    { path: takes[22050], name: 'z2', rootMidi: 57, lowMidi: 58, highMidi: 64 },
    { path: hitPath, name: 'z3', rootMidi: 60, lowMidi: 65, highMidi: 72 },
    { path: noiseAPath, name: 'z4', rootMidi: 60, lowMidi: 73, highMidi: 84 },
    { path: noiseBPath, name: 'z5', rootMidi: 60, lowMidi: 85, highMidi: 96 }
  ])
  const notes = [57, 60, 68, 70, 76, 80, 88, 57].map((midi, index) => ({ midi, startBeat: index * 0.5, durBeats: 0.5, velocity: 0.8 }))
  const started = process.hrtime.bigint()
  const performed = renderSampler({ keymap: fiveZones, notes, bpm: 120, seed: 5 })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const realtime = performed.report.durationSeconds / (elapsedMs / 1000)
  console.log(`  ${num(performed.report.durationSeconds, 2)} s of audio from 5 zones: ${num(elapsedMs, 1)} ms (${num(realtime, 0)}x realtime), peak ${num(performed.report.peakDbfs)} dBFS`)
  check('five-zone render covers two seconds', performed.report.durationSeconds >= 1.9, `${performed.report.durationSeconds}`)
  check('five-zone render is fast', elapsedMs < 500, `${num(elapsedMs, 1)} ms`)
}

/* ---- 10. the audio_sampler tool ---- */
console.log('\n-- audio_sampler tool --')
{
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  const exec = { agent: { session: { id: 'sampler-test' } } }
  registerSamplerTools(ctx)
  const call = (args) => registered.get('audio_sampler').execute(args, exec)
  const durationOf = async (path) => decodeWav(await readFile(join(cwd, path))).durationSeconds

  check('tool registered', registered.size === 1 && registered.has('audio_sampler'), [...registered.keys()].join(','))
  console.log(`  registered: ${[...registered.keys()].join(', ')}`)
  console.log(`  schema inputs: ${Object.keys(registered.get('audio_sampler').parameters.properties).join(', ')}`)
  check('schema takes samples and notes', Boolean(
    registered.get('audio_sampler').parameters.properties.samples &&
    registered.get('audio_sampler').parameters.properties.notes &&
    registered.get('audio_sampler').parameters.properties.envelope &&
    registered.get('audio_sampler').parameters.properties.loop
  ))

  const melody = await call({ samples: 'tone.wav', rootMidi: 'A3', bpm: 120, melody: 'C4:1 E4:1', out: 'out/melody.wav' })
  const melodyDuration = await durationOf('out/melody.wav')
  console.log(`  melody: ${melody.text}`)
  console.log(`  zonesText:\n${melody.zonesText.split('\n').map((line) => `    ${line}`).join('\n')}`)
  check('tool wrote the file', melody.relativePath === 'out/melody.wav')
  check('tool reports both notes', melody.noteCount === 2 && melody.report.noteCount === 2, `${melody.noteCount}`)
  check('tool text starts with the sampled summary', /^Sampled 2 notes from tone\.wav \(root A3/.test(melody.text), melody.text)
  check('tool text states duration and peak', melody.text.includes('peak -1 dBFS'), melody.text)
  check('tool melody duration', melodyDuration > 0.95 && melodyDuration < 1.15, `${melodyDuration}`)
  check('tool raises the peak to -1 dBFS', Math.abs(melody.metrics.peakDbfs - (-1)) < 0.1, `${melody.metrics.peakDbfs}`)
  check('tool reports no clipping', melody.metrics.clipping === 0)
  check('tool zonesText names the root', melody.zonesText.includes('root A3'), melody.zonesText)

  const layered = await call({
    samples: [
      { path: 'take-44100.wav', name: 'loud', velocityLo: 0.5, velocityHi: 1 },
      { path: 'take-22050.wav', name: 'quiet', velocityLo: 0, velocityHi: 0.5 }
    ],
    rootMidi: 57,
    bpm: 96,
    notes: [{ midi: 57, velocity: 0.9 }, { midi: 57, startBeat: 1, velocity: 0.2 }],
    out: 'out/layers.wav'
  })
  console.log(`  velocity layers via zone objects: ${layered.text}`)
  check('tool layer 1 hit', layered.report.zoneHits[0].name === 'loud' && layered.report.zoneHits[0].hits === 1)
  check('tool layer 2 hit', layered.report.zoneHits[1].name === 'quiet' && layered.report.zoneHits[1].hits === 1)
  check('tool reports 2 zones', layered.zones === 2)

  const looped = await call({ samples: 'tone.wav', rootMidi: 57, loop: { start: 0.2, end: 0.50123 }, bpm: 96, melody: 'A3:2', out: 'out/looped.wav' })
  const loopedDuration = await durationOf('out/looped.wav')
  console.log(`  looped: ${looped.text}`)
  check('tool loop wraps', looped.report.loopWraps === 3 && looped.report.loopedNotes === 1, `${looped.report.loopWraps}`)
  check('tool looped duration beats one-shot', loopedDuration > TONE_SECONDS, `${loopedDuration}`)
  check('tool text mentions the loop', looped.text.includes('looped 1 note'), looped.text)

  const audition = await call({ samples: 'hit.wav' })
  console.log(`  audition (no notes): ${audition.text}`)
  check('audition defaults to the root note', audition.noteCount === 1 && audition.report.picks[0].midi === 60, JSON.stringify(audition.report.picks))
  check('default output path', audition.relativePath.startsWith('assets/audio/sampler-'), audition.relativePath)
  check('audition text names one note', /^Sampled 1 note from hit\.wav \(root C4/.test(audition.text), audition.text)

  const velocityDefault = await call({ samples: 'tone.wav', rootMidi: 57, velocity: 0.2, melody: 'A3:1', out: 'out/soft.wav' })
  console.log(`  velocity default 0.2: pre-finalize peak ${num(velocityDefault.report.peakDbfs)} dBFS, file rms ${num(velocityDefault.metrics.rmsDbfs)} dBFS`)
  check('tool applies the default velocity', velocityDefault.report.picks[0].midi === 57 && velocityDefault.report.peakDbfs < -20, `${velocityDefault.report.peakDbfs}`)

  const toolThrows = async (label, args, pattern) => {
    try {
      await call(args)
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
      console.log(`  ${label}: ${error.message.slice(0, 116)}`)
    }
  }
  await toolThrows('samples required', {}, /samples is required/)
  await toolThrows('missing sample names the path', { samples: 'nope.wav' }, /nope\.wav/)
  await toolThrows('bad rootMidi', { samples: 'tone.wav', rootMidi: 200 }, /rootMidi must be a MIDI note/)
  await toolThrows('bad envelope shape', { samples: 'tone.wav', envelope: 5 }, /envelope must be an object/)
  await toolThrows('loop object needs both ends', { samples: 'tone.wav', loop: { start: 0.2 } }, /loop needs \{ start, end \}/)
  await toolThrows('velocity out of range', { samples: 'tone.wav', velocity: 2 }, /velocity must be 0\.\.1/)
  await toolThrows('unplayable melody', { samples: 'tone.wav', melody: 'zzz:1' }, /no playable notes/)
  await toolThrows('all notes off the keymap', { samples: 'tone.wav', rootMidi: 60, lowMidi: 60, highMidi: 60, melody: 'G4:1 A4:1' }, /covered by the keymap/)

  const listed = (await import('node:fs/promises')).readdir(join(cwd, 'out'))
  const files = await listed
  console.log(`  wrote ${files.length} file(s): ${files.sort().join(', ')}`)
  check('tool wrote every requested file', files.length === 4, files.join(','))
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\nOK: the sampler behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
