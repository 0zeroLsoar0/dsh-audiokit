/**
 * `audio_probe` / `audio_check` on multichannel files: the measurement must see
 * every channel instead of a mono fold.
 *
 * The two failure modes this pins down are the ones a fold hides:
 *   - one-sided clipping (L slammed into the ceiling, R silent) averaged to a
 *     healthy-looking 0.5 and stopped reporting clipping at all;
 *   - an out-of-phase stereo pair (L = -R) averaged to digital silence and
 *     reported as "almost silent" even though it is a full-level file.
 *
 * It also checks that the mono path is byte-for-byte the old one (a mono file's
 * metrics still equal `measure`) and that the local self-check is always part of
 * an `audio_check` result, with family shape checks when `spec` names the preset.
 *
 * Run with the node from WORKERS.md:
 *   node test/check.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measure } from '../lib/audio.js'
import { registerCheckTool } from '../lib/check.js'
import { registerTools } from '../lib/tools.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const RATE = 44100
const TAU = Math.PI * 2

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-check-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
registerTools(ctx)
registerCheckTool(ctx, {})
const exec = { agent: { session: { id: 'check-test' } } }
const call = (name, args) => registered.get(name).execute(args, exec)

/** A sine at `amplitude`, clipped by the encoder when amplitude > 1. */
function sine (frames, hz, amplitude, phase = 0) {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin(TAU * hz * i / RATE + phase)
  return out
}

const frames = Math.round(0.5 * RATE)

console.log('check: multichannel measurement, mono path, local self-check')
console.log(`sample rate ${RATE} Hz\n`)

/* --------------------------------------------------- one-sided clipping -- */

console.log('-- stereo with one clipped channel --')
{
  const left = sine(frames, 220, 1.6) // encoder clips this to full scale
  const right = new Float32Array(frames)
  await writeFile(join(cwd, 'one-sided.wav'), encodeWav([left, right], RATE))

  const decoded = decodeWav(encodeWav([left, right], RATE))
  const folded = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) folded[i] = (decoded.channels[0][i] + decoded.channels[1][i]) / 2
  const foldedPeak = measure(folded, RATE).peakDbfs

  const probe = await call('audio_probe', { path: 'one-sided.wav' })
  const clipping = probe.metrics.perChannel?.[0]?.clipping ?? 0
  console.log(`  fold peak ${foldedPeak} dBFS (clipping ${measure(folded, RATE).clipping}) -> probe peak ${probe.metrics.peakDbfs} dBFS, clipping ${probe.metrics.clipping} (ch1 ${clipping}, ch2 ${probe.metrics.perChannel?.[1]?.clipping})`)
  check('probe reports two channels', probe.channels === 2 && probe.metrics.channelCount === 2)
  check('probe reports per-channel metrics', Array.isArray(probe.metrics.perChannel) && probe.metrics.perChannel.length === 2)
  check('one-sided clipping is detected', probe.metrics.clipping > 0, String(probe.metrics.clipping))
  check('the clipped channel is named', clipping > 0 && probe.metrics.perChannel[1].clipping === 0, `${clipping}/${probe.metrics.perChannel[1].clipping}`)
  check('peak is the worst channel, not the fold', probe.metrics.peakDbfs > -0.1 && probe.metrics.peakDbfs > foldedPeak,
    `${probe.metrics.peakDbfs} vs fold ${foldedPeak}`)
  check('the probe text names the channels', /2 ch/.test(probe.text), probe.text)
  check('the probe notes the clipping channel', probe.notes.some((note) => /clipping on channel 1\/2/.test(note)), JSON.stringify(probe.notes))

  const verdict = await call('audio_check', { paths: ['one-sided.wav'] })
  console.log(`  audio_check verdict ${verdict.verdict}: ${verdict.issues.map((issue) => issue.message).join(' | ')}`)
  check('audio_check fails the one-sided clip', verdict.verdict === 'fail')
  check('audio_check says it is clipped', verdict.issues.some((issue) => /削波/.test(issue.message)), JSON.stringify(verdict.issues))
  check('audio_check always includes the self-check block', verdict.selfCheck !== undefined && verdict.selfCheck !== null && Array.isArray(verdict.selfCheck.checks))
  check('the self-check block fails on a clipped file', verdict.selfCheck.ok === false)
}

/* ---------------------------------------------------- out-of-phase pair -- */

console.log('\n-- out-of-phase stereo (L = -R) is not silence --')
{
  const left = sine(frames, 440, 0.5)
  const right = left.map((value) => -value)
  await writeFile(join(cwd, 'antiphase.wav'), encodeWav([left, right], RATE))
  const probe = await call('audio_probe', { path: 'antiphase.wav' })
  const verdict = await call('audio_check', { paths: ['antiphase.wav'] })
  const silentIssues = (verdict.issues ?? []).filter((issue) => /几乎无声|静音/.test(issue.message))
  console.log(`  probe peak ${probe.metrics.peakDbfs} dBFS (mono fold would be -120), verdict ${verdict.verdict}, silent issues ${silentIssues.length}`)
  check('the pair measures at its real level', Math.abs(probe.metrics.peakDbfs + 6.02) < 0.1, String(probe.metrics.peakDbfs))
  check('the pair is not reported as silence', probe.metrics.peakDbfs > -40)
  check('audio_check does not call it almost silent', silentIssues.length === 0, JSON.stringify(silentIssues))
  check('audio_check does not fail it', verdict.verdict !== 'fail', verdict.verdict)
  check('the attack is not the whole file', (verdict.files?.[0]?.attackSeconds ?? 1) < 0.1, String(verdict.files?.[0]?.attackSeconds))
}

/* --------------------------------------------------------- worst-channel DC -- */

console.log('\n-- DC offset is the worst channel, not the average --')
{
  const left = sine(frames, 220, 0.3)
  const right = sine(frames, 220, 0.3)
  for (let i = 0; i < frames; i += 1) left[i] += 0.05
  await writeFile(join(cwd, 'dc.wav'), encodeWav([left, right], RATE))
  const probe = await call('audio_probe', { path: 'dc.wav' })
  console.log(`  dcOffset ${probe.metrics.dcOffset} (average fold would be ~0.025)`)
  check('DC offset reports the worst channel', Math.abs(probe.metrics.dcOffset - 0.05) < 0.005, String(probe.metrics.dcOffset))
}

/* ------------------------------------------------------- mono is unchanged -- */

console.log('\n-- the mono path still equals `measure` --')
{
  await call('audio_synth', { preset: 'impact', duration: 0.4, seed: 3, out: 'mono.wav' })
  const probe = await call('audio_probe', { path: 'mono.wav' })
  const decoded = decodeWav(await (await import('node:fs/promises')).readFile(join(cwd, 'mono.wav')))
  const direct = measure(decoded.channels[0], decoded.sampleRate)
  console.log(`  mono peak ${probe.metrics.peakDbfs}/${direct.peakDbfs}, rms ${probe.metrics.rmsDbfs}/${direct.rmsDbfs}, crest ${probe.metrics.crestDb}/${direct.crestDb}, onsets ${probe.metrics.onsets}/${direct.onsets}`)
  check('mono peak is identical', probe.metrics.peakDbfs === direct.peakDbfs)
  check('mono rms is identical', probe.metrics.rmsDbfs === direct.rmsDbfs)
  check('mono crest is identical', probe.metrics.crestDb === direct.crestDb)
  check('mono dc is identical', probe.metrics.dcOffset === direct.dcOffset)
  check('mono clipping is identical', probe.metrics.clipping === direct.clipping)
  check('mono onset count is identical', probe.metrics.onsets === direct.onsets)
  check('mono has no perChannel noise', probe.metrics.perChannel === undefined)
  check('mono reports one channel', probe.channels === 1 && probe.metrics.channelCount === 1)
}

/* --------------------------------------------------- self-check in check -- */

console.log('\n-- audio_check runs the local self-check --')
{
  const plain = await call('audio_check', { paths: ['mono.wav'] })
  console.log(`  generic: ok=${plain.selfCheck.ok}, scopes ${[...new Set(plain.selfCheck.checks.map((entry) => entry.scope))].join(',')}`)
  check('a clean mono file passes the gate', plain.verdict === 'ok', JSON.stringify(plain.issues))
  check('the self-check block is a real report', typeof plain.selfCheck.ok === 'boolean' &&
    plain.selfCheck.checks.every((entry) => typeof entry.name === 'string' && typeof entry.ok === 'boolean' && typeof entry.detail === 'string'))
  check('without a spec only generic checks run', plain.selfCheck.checks.every((entry) => entry.scope === 'generic'))
  check('generic family is reported', plain.selfCheck.metrics.family === 'generic')
  check('the per-file result carries its own summary', plain.files[0].selfCheck !== null && /本地自检/.test(plain.files[0].selfCheck.summary))
  check('the text carries the self-check summary', /本地自检/.test(plain.text), plain.text)

  const specified = await call('audio_check', { paths: ['mono.wav'], spec: { preset: 'impact', duration: 0.4, sampleRate: RATE } })
  console.log(`  with spec: family ${JSON.stringify(specified.selfCheck.family)}, checks ${specified.selfCheck.checks.map((entry) => entry.name).join(',')}`)
  check('spec resolves the preset family', specified.selfCheck.family !== null && specified.selfCheck.family.id === 'impact')
  check('the family checks are present', specified.selfCheck.checks.some((entry) => entry.name === 'crestFactor' && entry.scope === 'family'))
  check('a matching render still passes', specified.selfCheck.ok === true, specified.selfCheck.summary)
  check('verdict stays ok', specified.verdict === 'ok', JSON.stringify(specified.issues))

  // A deliberately wrong duration must be caught by the self-check.
  const wrongDuration = await call('audio_check', { paths: ['mono.wav'], spec: { preset: 'impact', duration: 2 } })
  console.log(`  wrong duration: selfcheck ok=${wrongDuration.selfCheck.ok}, verdict ${wrongDuration.verdict}`)
  check('a wrong duration fails the self-check', wrongDuration.selfCheck.ok === false &&
    wrongDuration.selfCheck.checks.some((entry) => entry.name === 'duration' && !entry.ok))
  check('the wrong duration reaches the verdict', wrongDuration.verdict === 'fail' || wrongDuration.verdict === 'warn', wrongDuration.verdict)

  let threw = false
  try { await call('audio_check', { paths: ['mono.wav'], spec: 'impact' }) } catch (error) { threw = /spec/.test(error.message) }
  check('a non-object spec is rejected', threw)

  // A silent file fails, and the self-check agrees.
  const silent = new Float32Array(Math.round(0.3 * RATE))
  await writeFile(join(cwd, 'silent.wav'), encodeWav([silent], RATE))
  const silentResult = await call('audio_check', { paths: ['silent.wav'] })
  check('silent file fails the gate', silentResult.verdict === 'fail')
  check('silent file fails the self-check', silentResult.selfCheck.ok === false)
  check('silent file names the peak check', silentResult.selfCheck.checks.some((entry) => entry.name === 'peak' && !entry.ok))
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: all ${checks} measurement checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
