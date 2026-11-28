/**
 * Multichannel loudness agreement: `audio_loudness` and `audio_master` must
 * report the same LUFS for the same file, because a model uses one to measure
 * and the other to hit a target.
 *
 * The meter has to follow ITU-R BS.1770-4 on a surround file, which means two
 * decisions that are easy to get subtly wrong:
 *   - LFE is not part of the loudness measure (it plays up to 10 dB louder than
 *     its samples say), so a hot LFE must not move the number;
 *   - each surround channel carries the standard's +1.5 dB weight (x1.41), so a
 *     5.1 file does not read like the same signal folded to stereo.
 *
 * Everything is asserted against the actual meter on the actual samples: the
 * expected LUFS is computed with `analyzeLoudness` and the same
 * `multichannel.loudnessChannels` decision the two tools share.
 *
 * Run with the node from WORKERS.md:
 *   node test/loudness.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeLoudness } from '../lib/lufs.js'
import { masterChain } from '../lib/master.js'
import { encodeAnyWav, layoutFor, loudnessChannels } from '../lib/multichannel.js'
import { registerLoudnessTools } from '../lib/tools-loudness.js'
import { registerMasterTools } from '../lib/tools-master.js'
import { decodeWav } from '../lib/wav.js'

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

function sine (frames, hz, dbfs, phase = 0) {
  const amplitude = Math.pow(10, dbfs / 20)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin(TAU * hz * i / RATE + phase)
  return out
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-loudness-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
registerLoudnessTools(ctx)
registerMasterTools(ctx)
const exec = { agent: { session: { id: 'loudness-test' } } }
const call = (name, args) => registered.get(name).execute(args, exec)

console.log('loudness: 5.1 LFE exclusion, surround weighting, tool agreement')
console.log(`sample rate ${RATE} Hz\n`)

/* --------------------------------------------------------------- helpers -- */

/** A 5.1 signal: one tone per speaker, fronts at -20 dBFS, surrounds -23, LFE -14. */
function fiveOne (seconds = 3, lfeDbfs = -14) {
  const frames = Math.round(seconds * RATE)
  const levels = [-20, -20, -22, lfeDbfs, -23, -23]
  const frequencies = [220, 260, 330, 40, 500, 620]
  return levels.map((level, channel) => sine(frames, frequencies[channel], level, channel * 0.4))
}

/** The expected loudness, computed with the shared channel/weight decision. */
function expectedLufs (channels) {
  const { measured, weights } = loudnessChannels(channels)
  return analyzeLoudness(measured[0], RATE, { channels: measured, weights }).integratedLufs
}

/* -------------------------------------------------------- channel logic -- */

console.log('-- one channel decision for 5.1 / 7.1 / stereo --')
{
  const five = fiveOne(1)
  const six = loudnessChannels(five)
  console.log(`  5.1: ${five.length} channels -> measured ${six.measured.length}, weights [${six.weights.join(', ')}], LFE excluded ${six.lfeExcluded}`)
  check('5.1 measures five channels', six.measured.length === 5)
  check('5.1 excludes LFE', six.lfeExcluded === true)
  check('5.1 weights the surrounds at 1.41',
    six.weights.join(',') === '1,1,1,1.41,1.41', six.weights.join(','))
  check('the LFE index is dropped, not a different channel', Math.abs(layoutFor(6).lfeIndex - 3) === 0)

  const sevenOne = Array.from({ length: 8 }, (_, channel) => sine(1200, 200 + channel * 20, -20))
  const eight = loudnessChannels(sevenOne)
  console.log(`  7.1: 8 channels -> measured ${eight.measured.length}, weights [${eight.weights.join(', ')}]`)
  check('7.1 measures seven channels', eight.measured.length === 7)
  check('7.1 weights both surround pairs', eight.weights.join(',') === '1,1,1,1.41,1.41,1.41,1.41', eight.weights.join(','))

  const stereo = loudnessChannels([sine(4800, 997, -23), sine(4800, 997, -23)])
  check('stereo keeps both channels at weight 1', stereo.measured.length === 2 && stereo.weights.join(',') === '1,1')
  const mono = loudnessChannels([sine(4800, 997, -23)])
  check('mono stays one channel', mono.measured.length === 1 && mono.weights.join(',') === '1')
}

/* ---------------------------------------------- tool: LFE + weighting -- */

console.log('\n-- audio_loudness on a 5.1 file --')
{
  const five = fiveOne(3)
  await writeFile(join(cwd, 'surround51.wav'), encodeAnyWav(five, RATE, { bitDepth: 24 }))
  const measured = await call('audio_loudness', { path: 'surround51.wav' })
  const expected = expectedLufs(five)
  console.log(`  audio_loudness: ${fmt(measured.metrics.lufs, 3)} LUFS, measured on ${measured.metrics.loudnessChannels} channels, LFE excluded ${measured.metrics.lfeExcluded}; expected ${fmt(expected, 3)} LUFS`)
  check('audio_loudness reports the layout channel count', measured.metrics.channelCount === 6, String(measured.metrics.channelCount))
  check('audio_loudness excludes LFE and says so', measured.metrics.lfeExcluded === true && measured.metrics.loudnessChannels === 5)
  check('audio_loudness matches the shared meter', Math.abs(measured.metrics.lufs - expected) < 0.01, `${measured.metrics.lufs} vs ${expected}`)
  check('audio_loudness names the surround weight in its text', /环绕声道权重 ×1\.41/.test(measured.text), measured.text)

  // A hot LFE must not move the loudness reading at all.
  const hotFive = fiveOne(3, -2)
  await writeFile(join(cwd, 'hot-lfe.wav'), encodeAnyWav(hotFive, RATE, { bitDepth: 24 }))
  const hotMeasured = await call('audio_loudness', { path: 'hot-lfe.wav' })
  console.log(`  hot LFE (-2 dBFS): ${fmt(hotMeasured.metrics.lufs, 3)} LUFS vs ${fmt(measured.metrics.lufs, 3)} LUFS (LFE excluded)`)
  check('a hot LFE does not change loudness', Math.abs(hotMeasured.metrics.lufs - measured.metrics.lufs) < 0.01,
    `${hotMeasured.metrics.lufs} vs ${measured.metrics.lufs}`)

  // The weight is real: energy only in the surround pair reads +1.49 dB louder
  // than the same energy with every measured channel at weight 1.
  const frames = Math.round(3 * RATE)
  const surroundOnly = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames), new Float32Array(frames), sine(frames, 997, -23), sine(frames, 997, -23)]
  await writeFile(join(cwd, 'surround-only.wav'), encodeAnyWav(surroundOnly, RATE, { bitDepth: 24 }))
  const surroundMeasured = await call('audio_loudness', { path: 'surround-only.wav' })
  const { measured: equalChannels } = loudnessChannels(surroundOnly)
  const equalWeighted = analyzeLoudness(equalChannels[0], RATE, { channels: equalChannels, weights: [1, 1, 1, 1, 1] }).integratedLufs
  const gainFromWeight = surroundMeasured.metrics.lufs - equalWeighted
  console.log(`  surround-only 997 Hz: weighted ${fmt(surroundMeasured.metrics.lufs, 3)} LUFS, equal-weight ${fmt(equalWeighted, 3)} LUFS -> +${fmt(gainFromWeight, 2)} dB (expected +${fmt(10 * Math.log10(1.41), 2)})`)
  check('the surround weight adds the standard 1.5 dB', Math.abs(gainFromWeight - 10 * Math.log10(1.41)) < 0.02, `${fmt(gainFromWeight, 3)} dB`)
}

/* ------------------------------------- agreement with audio_master -- */

console.log('\n-- audio_master reports the same LUFS as audio_loudness --')
{
  const five = fiveOne(3)
  const channels = decodeWav(await readFile(join(cwd, 'surround51.wav'))).channels
  const beforeMaster = await call('audio_loudness', { path: 'surround51.wav' })
  const mastered = await call('audio_master', { path: 'surround51.wav', targetLufs: -20, out: 'mastered51.wav' })
  console.log(`  audio_loudness ${fmt(beforeMaster.metrics.lufs, 3)} LUFS vs audio_master before ${fmt(mastered.before.lufs, 3)} LUFS (report: ${mastered.channels} ch, loudness on ${mastered.after ? '' : ''}${mastered.text.match(/loudness on \d+ channels[^|]*/)?.[0] ?? 'n/a'})`)
  check('audio_master keeps the 5.1 layout', mastered.channels === 6, String(mastered.channels))
  check('the two tools agree on the input loudness', Math.abs(mastered.before.lufs - beforeMaster.metrics.lufs) < 0.01,
    `${mastered.before.lufs} vs ${beforeMaster.metrics.lufs}`)
  check('audio_master says LFE was excluded from loudness', /LFE excluded/.test(mastered.text), mastered.text)

  // And the master chain itself (no tool wrapper) agrees with the meter.
  const chain = masterChain(channels, RATE, { targetLufs: -20, ceilingDbtp: -1 })
  console.log(`  masterChain report lufsBefore ${fmt(chain.report.lufsBefore, 3)}, measured on ${chain.report.loudnessChannels} ch (LFE excluded ${chain.report.lfeExcluded})`)
  check('the master chain agrees with the shared meter', Math.abs(chain.report.lufsBefore - expectedLufs(channels)) < 0.02,
    `${chain.report.lufsBefore} vs ${expectedLufs(channels)}`)
  check('the master chain reports five metered channels', chain.report.loudnessChannels === 5 && chain.report.lfeExcluded === true)

  // The written 5.1 file must read back at the same loudness the master reported.
  const written = decodeWav(await readFile(join(cwd, 'mastered51.wav')))
  const writtenReadBack = await call('audio_loudness', { path: 'mastered51.wav' })
  console.log(`  written 5.1 file reads ${fmt(writtenReadBack.metrics.lufs, 3)} LUFS (master reported ${fmt(mastered.after.lufs, 3)}), ${written.channels.length} ch`)
  check('the written file reads back at the mastered loudness', Math.abs(writtenReadBack.metrics.lufs - mastered.after.lufs) < 0.05,
    `${writtenReadBack.metrics.lufs} vs ${mastered.after.lufs}`)
  check('the written file is still 5.1', written.channels.length === 6 && writtenReadBack.metrics.channelCount === 6)
}

/* ------------------------------------------------- stereo stays unchanged -- */

console.log('\n-- stereo and mono readings are unchanged --')
{
  const left = sine(Math.round(3 * RATE), 997, -23)
  const right = sine(Math.round(3 * RATE), 997, -23, 0.9)
  await writeFile(join(cwd, 'stereo.wav'), encodeAnyWav([left, right], RATE, { bitDepth: 24 }))
  const stereo = await call('audio_loudness', { path: 'stereo.wav' })
  console.log(`  stereo 997 Hz -23 dBFS per channel -> ${fmt(stereo.metrics.lufs, 3)} LUFS (EBU Tech 3341 expects -23.0)`)
  check('stereo still reads the EBU reference level', Math.abs(stereo.metrics.lufs + 23) <= 0.1, String(stereo.metrics.lufs))
  check('stereo does not claim LFE exclusion', stereo.metrics.lfeExcluded === false)
  check('stereo weights are both 1', stereo.metrics.channelWeights.join(',') === '1,1', stereo.metrics.channelWeights.join(','))
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: all ${checks} loudness-agreement checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
