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
 * The last sections cover the delivery-verification layer wired in from
 * `lib/verify.js`: `target`/`loudnessTarget` loudness compliance, the `phase`
 * block (including that an antiphase pair is now reported as a warning rather
 * than passing silently) and `sync`/`targets` cue deviations. A call without any
 * of the new arguments still returns the old shape — `compliance` and `sync` are
 * null — and only the always-on `phase` block can move such a verdict, which is
 * the one intentional behaviour change and is pinned below on an antiphase file.
 *
 * Run with the node from WORKERS.md:
 *   node test/check.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measure } from '../lib/audio.js'
import { registerCheckTool } from '../lib/check.js'
import { encodeAnyWav } from '../lib/multichannel.js'
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

/* ------------------------------------------ delivery verification blocks -- */

/** A stereo pair at `dbfs` per channel, `seconds` long. */
function stereoPair (seconds, dbfs) {
  const frames = Math.round(seconds * RATE)
  const amplitude = Math.pow(10, dbfs / 20)
  const left = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) left[index] = amplitude * Math.sin(TAU * 997 * index / RATE)
  return [left, left.slice()]
}

console.log('\n-- the old shape is untouched without the new arguments --')
{
  const legacy = await call('audio_check', { paths: ['mono.wav'] })
  console.log(`  legacy call: verdict ${legacy.verdict}, compliance ${legacy.compliance}, phase ${legacy.phase}, sync ${legacy.sync}`)
  check('legacy verdict is still ok', legacy.verdict === 'ok', JSON.stringify(legacy.issues))
  check('compliance is null without a target', legacy.compliance === null)
  check('phase is null for a mono file', legacy.phase === null)
  check('sync is null without cues', legacy.sync === null)
  check('the pre-existing fields are all still there',
    Array.isArray(legacy.issues) && Array.isArray(legacy.files) &&
    legacy.selfCheck !== null && legacy.summedPeakDbfs === null &&
    legacy.opinion === null && legacy.opinionSkipped === false && legacy.opinionError === null &&
    legacy.semanticDisabled === false && typeof legacy.text === 'string')
  check('the file entries kept their shape',
    legacy.files.length === 1 && typeof legacy.files[0].path === 'string' &&
    typeof legacy.files[0].label === 'string' && legacy.files[0].channels === 1 &&
    typeof legacy.files[0].attackSeconds === 'number' && legacy.files[0].selfCheck !== null)

  // Phase is the one block that runs without being asked: it is one pass over
  // the samples, and a stereo deliverable that collapses in mono is a defect
  // whether or not the caller knew to ask. So a legacy call on an antiphase
  // file now reports `warn` instead of passing silently — the documented,
  // intentional behaviour change (see docs/DETAIL.zh.md, 交付前验收).
  const legacyStereo = await call('audio_check', { paths: ['antiphase.wav'] })
  console.log(`  legacy stereo: verdict ${legacyStereo.verdict}, phase ${legacyStereo.phase?.files.length}, issues ${legacyStereo.issues.length}`)
  check('a stereo file always gets a phase report', legacyStereo.phase !== null && legacyStereo.phase.files[0].antiphase === true)
  check('an antiphase stereo file no longer passes silently', legacyStereo.verdict === 'warn' &&
    legacyStereo.issues.some((issue) => /反相/.test(issue.message)), JSON.stringify(legacyStereo.issues))
  check('an antiphase stereo file is still not a hard fail', legacyStereo.verdict !== 'fail')
}

console.log('\n-- audio_check: platform loudness compliance --')
{
  await writeFile(join(cwd, 'youtube.wav'), encodeWav(stereoPair(1.5, -14), RATE))
  await writeFile(join(cwd, 'podcast.wav'), encodeWav(stereoPair(1.5, -16), RATE))
  await writeFile(join(cwd, 'quiet.wav'), encodeWav(stereoPair(1.5, -30), RATE))

  const compliant = await call('audio_check', { paths: ['youtube.wav'], target: 'youtube' })
  console.log(`  youtube target: verdict ${compliant.verdict}, ${compliant.compliance.files[0].measured.lufs} LUFS | ${compliant.compliance.summary}`)
  check('a file at the platform level passes', compliant.verdict === 'ok', JSON.stringify(compliant.issues))
  check('the compliance block is present and ok', compliant.compliance !== null && compliant.compliance.ok === true)
  check('the target is echoed back', compliant.compliance.target.id === 'youtube' &&
    compliant.compliance.target.targetLufs === -14 && compliant.compliance.target.ceilingDbtp === -1)
  check('the compliance gap is reported per file', Array.isArray(compliant.compliance.files) &&
    compliant.compliance.files.length === 1 && typeof compliant.compliance.files[0].lufsDelta === 'number')
  check('the measured loudness is the platform level', Math.abs(compliant.compliance.files[0].measured.lufs + 14) < 0.05,
    String(compliant.compliance.files[0].measured.lufs))
  check('the text carries the compliance line', /响度合规/.test(compliant.text), compliant.text)
  check('the stereo file also gets a phase report', compliant.phase !== null && compliant.phase.ok === true)

  const off = await call('audio_check', { paths: ['quiet.wav'], target: 'youtube' })
  console.log(`  quiet file: verdict ${off.verdict}, delta ${off.compliance.files[0].lufsDelta} LU, issues ${off.issues.length}`)
  check('a 16 LU quiet file fails the target gate', off.verdict === 'fail')
  check('the compliance block says it is off target', off.compliance.ok === false && off.compliance.files[0].ok === false)
  check('the gap is reported signed', Math.abs(off.compliance.files[0].lufsDelta + 16) < 0.05, String(off.compliance.files[0].lufsDelta))
  check('the gap names the loudness problem', off.issues.some((issue) => /比目标轻|响度/.test(issue.message)), JSON.stringify(off.issues))

  const custom = await call('audio_check', { paths: ['podcast.wav'], loudnessTarget: { targetLufs: -16 } })
  console.log(`  custom target: verdict ${custom.verdict}, target ${JSON.stringify(custom.compliance.target)}`)
  check('a custom loudnessTarget is judged', custom.verdict === 'ok' && custom.compliance.ok === true, JSON.stringify(custom.issues))
  check('a custom target defaults the ceiling to -1 dBTP', custom.compliance.target.ceilingDbtp === -1)

  // The true-peak ceiling can fail while the loudness is on target.
  const spikePair = stereoPair(1.5, -16)
  spikePair[0][Math.round(RATE * 0.75)] = 0.98
  await writeFile(join(cwd, 'spike.wav'), encodeWav(spikePair, RATE))
  const peakOnly = await call('audio_check', { paths: ['spike.wav'], target: 'podcast' })
  console.log(`  peak-only miss: verdict ${peakOnly.verdict}, true peak ${peakOnly.compliance.files[0].measured.truePeakDbtp} dBTP`)
  check('a true-peak overshoot fails the gate', peakOnly.verdict === 'fail')
  check('the loudness check passes while the peak check fails',
    peakOnly.compliance.files[0].checks[0].ok === true && peakOnly.compliance.files[0].checks[1].ok === false)

  let threw = false
  try { await call('audio_check', { paths: ['youtube.wav'], target: 'myspace' }) } catch (error) { threw = /unknown loudness target/.test(error.message) }
  check('an unknown platform is rejected', threw)

  // A file the meter refuses (below 8 kHz) must not be reported as "compliant":
  // no file was judged, so the block says so and the issue explains why.
  const lowFrames = Math.round(0.3 * 4000)
  const lowRate = new Float32Array(lowFrames)
  for (let index = 0; index < lowFrames; index += 1) lowRate[index] = 0.2 * Math.sin(TAU * 200 * index / 4000)
  await writeFile(join(cwd, 'lowrate.wav'), encodeWav([lowRate], 4000))
  const unjudgeable = await call('audio_check', { paths: ['lowrate.wav'], target: 'youtube' })
  console.log(`  unjudgeable: verdict ${unjudgeable.verdict}, files judged ${unjudgeable.compliance.files.length} | ${unjudgeable.compliance.summary}`)
  check('a file the meter cannot analyse is not called compliant', unjudgeable.compliance.ok === false &&
    unjudgeable.compliance.files.length === 0)
  check('the compliance summary says nothing was judged', /没有可判定/.test(unjudgeable.compliance.summary), unjudgeable.compliance.summary)
  check('the refusal is explained as a warning', unjudgeable.issues.some((issue) => issue.level === 'warn' && /响度合规判定失败/.test(issue.message)),
    JSON.stringify(unjudgeable.issues))
  threw = false
  try {
    await call('audio_check', { paths: ['youtube.wav'], target: 'youtube', loudnessTarget: { targetLufs: -14 } })
  } catch (error) { threw = /只能给一个/.test(error.message) }
  check('target and loudnessTarget together are rejected', threw)
  threw = false
  try { await call('audio_check', { paths: ['missing.wav'], target: 'myspace' }) } catch (error) { threw = /unknown loudness target/.test(error.message) }
  check('an unknown target is rejected before any file is read', threw)
}

console.log('\n-- audio_check: phase and mono compatibility --')
{
  // antiphase.wav already exists from the out-of-phase section above.
  const anti = await call('audio_check', { paths: ['antiphase.wav'] })
  console.log(`  antiphase: verdict ${anti.verdict}, correlation ${anti.phase.files[0].correlation}, loss ${anti.phase.files[0].monoLossDb} dB`)
  check('a stereo file gets a phase block', anti.phase !== null && anti.phase.files.length === 1)
  check('an antiphase pair correlates at -1', anti.phase.files[0].correlation === -1)
  check('an antiphase pair is flagged', anti.phase.files[0].antiphase === true && anti.phase.ok === false)
  check('the fold loss is reported, not just the flag', anti.phase.files[0].monoLossDb > 6)
  check('the phase problem is an audible warning, not a hard fail', anti.verdict === 'warn' && anti.issues.every((issue) => issue.level !== 'error'), anti.verdict)
  check('the phase issue does not read as silence', anti.issues.every((issue) => !/几乎无声|静音/.test(issue.message)), JSON.stringify(anti.issues))
  check('the text carries the phase line', /相位与单声道兼容/.test(anti.text), anti.text)

  // A hard-panned file is not a phase problem: the 6 dB it loses is the pan law.
  await writeFile(join(cwd, 'hard-pan.wav'), encodeWav([stereoPair(0.5, -6)[0], new Float32Array(Math.round(0.5 * RATE))], RATE))
  const hardPan = await call('audio_check', { paths: ['hard-pan.wav'] })
  console.log(`  hard pan: verdict ${hardPan.verdict}, correlation ${hardPan.phase.files[0].correlation}, loss ${hardPan.phase.files[0].monoLossDb}`)
  check('a hard-panned file is not flagged', hardPan.phase.files[0].monoLossDb === 0 && hardPan.phase.ok === true)
  check('a hard-panned file still passes the gate', hardPan.verdict === 'ok', JSON.stringify(hardPan.issues))
}

console.log('\n-- audio_check: cue / picture sync --')
{
  // A low bed keeps the summed peak out of these assertions: the point here is
  // the cue timing, not the mix level (the sum is covered by its own section).
  const late = await call('audio_check', {
    cues: [
      { at: 0, src: 'quiet.wav', name: 'bed' },
      { at: 1.25, src: 'mono.wav', expectAt: 1, name: 'hit' }
    ]
  })
  console.log(`  late cue: verdict ${late.verdict}, max deviation ${late.sync.maxDeviationSeconds}s, ${late.sync.summary}`)
  check('a cue sheet gets a sync block', late.sync !== null && late.sync.cueCount === 2)
  check('the deviation is measured against expectAt', late.sync.cues[1].expectAt === 1 &&
    Math.abs(late.sync.cues[1].deviationSeconds - 0.25) < 0.001)
  check('the worst deviation is summarised', late.sync.maxDeviationSeconds === 0.25 && late.sync.worstIndex === 1)
  check('a 250 ms miss is an error', late.sync.cues[1].level === 'error' && late.sync.verdict === 'fail')
  check('the verdict carries the sync error', late.verdict === 'fail')
  check('the sync issue names the worst cue', late.issues.some((issue) => /cue #2/.test(issue.message)), JSON.stringify(late.issues))
  check('the sync line is in the text', /cue 同步/.test(late.text), late.text)
  check('the cue name survives into the report', late.sync.cues[1].name === 'hit')

  const onTarget = await call('audio_check', {
    cues: [{ at: 0, src: 'quiet.wav' }, { at: 1, src: 'mono.wav' }],
    targets: [0, 1.03]
  })
  console.log(`  targets array: verdict ${onTarget.verdict}, max ${onTarget.sync.maxDeviationSeconds}s`)
  check('a parallel targets array is applied', onTarget.sync.cues[1].expectAt === 1.03 &&
    Math.abs(onTarget.sync.cues[1].deviationSeconds - -0.03) < 0.001)
  check('a cue inside the tolerance passes', onTarget.sync.ok === true && onTarget.sync.verdict === 'ok')

  const coherent = await call('audio_check', {
    cues: [{ at: 0, src: 'quiet.wav' }, { at: 1, src: 'mono.wav' }]
  })
  console.log(`  no target times: hasTargets ${coherent.sync.hasTargets}, ${coherent.sync.summary}`)
  check('without target times the sheet is only checked for coherence', coherent.sync.hasTargets === false &&
    coherent.sync.maxDeviationSeconds === null && coherent.sync.ok === true)
  check('without target times there is no timing check', coherent.sync.checks.every((entry) => entry.name !== 'cueTiming'))

  const unsorted = await call('audio_check', {
    cues: [{ at: 1, src: 'mono.wav' }, { at: 0, src: 'quiet.wav' }]
  })
  console.log(`  unsorted cues: verdict ${unsorted.verdict}`)
  check('an out-of-order cue sheet is reported', unsorted.sync.timeline.ordered === false && unsorted.verdict === 'warn')

  const duplicate = await call('audio_check', {
    cues: [{ at: 0.5, src: 'quiet.wav' }, { at: 0.5, src: 'quiet.wav' }]
  })
  check('a cue scheduled twice is reported', duplicate.sync.timeline.duplicates.length === 1 && duplicate.verdict === 'warn',
    JSON.stringify(duplicate.sync.timeline.duplicates))

  let threw = false
  try { await call('audio_check', { paths: ['mono.wav'], targets: [0] }) } catch (error) { threw = /没有 cues/.test(error.message) }
  check('targets without cues are rejected', threw)
  threw = false
  try {
    await call('audio_check', { cues: [{ at: 0, src: 'mono.wav' }], targets: [0, 1] })
  } catch (error) { threw = /一一对应/.test(error.message) }
  check('targets that do not line up with cues are rejected', threw)
  threw = false
  try { await call('audio_check', { cues: [{ at: 0, src: 'mono.wav', expectAt: -1 }] }) } catch (error) { threw = /expectAt/.test(error.message) }
  check('a negative expectAt is rejected', threw)
  threw = false
  try {
    await call('audio_check', { cues: [{ at: 0, src: 'mono.wav' }], targets: [0], toleranceSeconds: 0 })
  } catch (error) { threw = /toleranceSeconds/.test(error.message) }
  check('a zero tolerance is rejected', threw)

  threw = false
  try { await call('audio_check', { cues: [{ at: 0, src: 'mono.wav' }], targets: [] }) } catch (error) { threw = /一一对应/.test(error.message) }
  check('an explicit empty targets array is a length mismatch, not "no targets"', threw)
}

console.log('\n-- audio_check: surround goes through both new blocks --')
{
  // A 5.1 file: compliance must use the same meter as audio_loudness (LFE
  // excluded, surrounds weighted), phase must judge the FL/FR pair, and the
  // true-peak ceiling must be the file's — LFE included, the way audio_master
  // enforces it. So the LFE is deliberately hot: the loudness reading must not
  // move, and the peak verdict must fail.
  const frames51 = Math.round(1.5 * RATE)
  const tone = (hz, dbfs) => {
    const amplitude = Math.pow(10, dbfs / 20)
    const out = new Float32Array(frames51)
    for (let index = 0; index < frames51; index += 1) out[index] = amplitude * Math.sin(TAU * hz * index / RATE)
    return out
  }
  await writeFile(join(cwd, 'surround51.wav'), encodeAnyWav(
    [tone(220, -26), tone(260, -26), tone(330, -28), tone(40, -0.5), tone(500, -29), tone(620, -29)],
    RATE,
    { bitDepth: 24 }
  ))
  const surround = await call('audio_check', { paths: ['surround51.wav'], target: 'broadcast' })
  const surroundFile = surround.compliance.files[0]
  console.log(`  5.1: ${surroundFile.measured.lufs} LUFS on ${surroundFile.measured.loudnessChannels} channels (LFE excluded ${surroundFile.measured.lfeExcluded}), true peak ${surroundFile.measured.truePeakDbtp} dBTP, phase pair ${surround.phase.files[0].pair}`)
  check('5.1 compliance reports the six-channel file', surroundFile.measured.channelCount === 6)
  check('5.1 compliance excludes the LFE from the meter', surroundFile.measured.lfeExcluded === true &&
    surroundFile.measured.loudnessChannels === 5)
  check('5.1 true peak includes the LFE', surroundFile.measured.truePeakDbtp > -1,
    String(surroundFile.measured.truePeakDbtp))
  check('5.1 an over-ceiling LFE fails the peak check', surroundFile.checks[1].ok === false && surroundFile.peakOverDbtp > 0)
  check('5.1 the LFE does not move the loudness reading', Math.abs(surroundFile.lufsDelta) <= 3,
    String(surroundFile.lufsDelta))
  check('5.1 phase judges the front pair', surround.phase.files[0].pair === 'FL/FR' && surround.phase.files[0].correlation !== null)
}

console.log('\n-- audio_check: bad verification arguments fail before reading files --')
{
  const cases = [
    ['unknown target', { paths: ['missing.wav'], target: 'myspace' }, /unknown loudness target/],
    ['null loudness target', { paths: ['missing.wav'], loudnessTarget: { targetLufs: null } }, /targetLufs/],
    ['null ceiling', { paths: ['missing.wav'], loudnessTarget: { targetLufs: -14, ceilingDbtp: null } }, /ceilingDbtp/],
    ['negative cue target', { cues: [{ at: 0, src: 'missing.wav', expectAt: -2 }] }, /expectAt/],
    ['string cue target', { cues: [{ at: 0, src: 'missing.wav', expectAt: '1' }] }, /expectAt/]
  ]
  for (const [label, args, match] of cases) {
    let message = ''
    try { await call('audio_check', args) } catch (error) { message = error.message }
    check(`rejected before reading: ${label}`, match.test(message), message)
  }
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: all ${checks} measurement checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
