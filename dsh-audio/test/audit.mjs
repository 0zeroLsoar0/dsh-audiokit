/**
 * Three-way audit tests: narration wav ↔ subtitle srt ↔ mouth track.
 *
 * The fixture is built from a known ground truth instead of being taken from a
 * previous run: six 200 ms bursts of tone separated by 200 ms of digital silence
 * at exactly 0, 0.4, … 2.0 s, a subtitle file whose cues sit on those bursts,
 * and a mouth track that opens for exactly the burst frames. Every defect case
 * is then one deliberate mutation of that truth (shift the cues, delete one,
 * add one, hold the mouth open through a pause, insert a one-frame wrong shape),
 * so each assertion compares the audit against the defect it was built from.
 *
 * What this cannot prove: that the thresholds are right for a real TTS voice.
 * That needs a real narration — the defaults are documented in lib/audit.js.
 *
 * Run: node test/audit.mjs
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toWavBytes, toWavBytesChannels, writeFileAtomic } from '../lib/audio.js'
import { auditDelivery, parseSrt } from '../lib/audit.js'
import { registerAuditTool } from '../lib/tools-audit.js'

const SAMPLE_RATE = 16000
const PULSE_SECONDS = 0.2
const PULSES = [0, 0.4, 0.8, 1.2, 1.6, 2.0]
const DURATION = 2.4
const FPS = 25

const scratch = fileURLToPath(new URL('./out/audit/', import.meta.url))
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const write = (name, bytes) => writeFileAtomic(join(scratch, name), bytes)

/* --------------------------------------------------------------- fixture -- */

/**
 * Six bursts of 440 Hz, 5 ms ramps, separated by digital silence. The ramps
 * keep the file click-free; the silence is what the "subtitle over silence" and
 * "mouth open in silence" cases need to find.
 */
function buildNarration () {
  const samples = new Float32Array(Math.round(DURATION * SAMPLE_RATE))
  const ramp = Math.round(0.005 * SAMPLE_RATE)
  for (const start of PULSES) {
    const from = Math.round(start * SAMPLE_RATE)
    const count = Math.round(PULSE_SECONDS * SAMPLE_RATE)
    for (let i = 0; i < count; i += 1) {
      const envelope = Math.min(1, i / ramp, (count - 1 - i) / ramp)
      samples[from + i] += 0.5 * envelope * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE)
    }
  }
  return samples
}

function srtTime (seconds) {
  const total = Math.round(seconds * 1000)
  const millis = total % 1000
  const secs = Math.floor(total / 1000) % 60
  const mins = Math.floor(total / 60000) % 60
  const hours = Math.floor(total / 3600000)
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(mins, 2)}:${pad(secs, 2)},${pad(millis, 3)}`
}

/** `{ start, end, text }[]` → SRT document. */
function buildSrt (cues) {
  return cues.map((cue, index) => {
    const text = cue.text ?? `第 ${index + 1} 句`
    return `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${text}\n`
  }).join('\n')
}

/**
 * A mouth track whose open frames are exactly the pulse frames, then patched at
 * named frame indices so each defect case differs from the truth in one place.
 *
 * `shiftFrames` moves every open window later, to model a lead/delay-compensated
 * track; `leadMs` records the `audio_lipsync` field that says so; `frameCount`
 * truncates the track.
 */
function buildVisemes (options = {}) {
  const fps = options.fps ?? FPS
  const frameCount = options.frameCount ?? Math.round(DURATION * fps)
  const openFrames = PULSES.map((start) => Math.round(start * fps))
  const openLength = Math.round(PULSE_SECONDS * fps)
  const shift = options.shiftFrames ?? 0
  const frames = []
  for (let index = 0; index < frameCount; index += 1) {
    // Frame-index arithmetic, not `t < start + 0.2`: `0.4 + 0.2` is greater than
    // the double `0.6`, so a float compare marks the frame on the burst boundary
    // as open and the fixture would disagree with its own ground truth.
    const open = openFrames.some((first) => index >= first + shift && index < first + openLength + shift)
    frames.push({
      t: Number((index / fps).toFixed(6)),
      viseme: open ? 'AA' : 'none',
      openness: open ? 0.9 : 0,
      energy: open ? 0.8 : 0,
      voiced: open
    })
  }
  for (const patch of options.patches ?? []) {
    frames[patch.frame] = {
      ...frames[patch.frame],
      viseme: patch.viseme,
      openness: patch.viseme === 'none' ? 0 : 0.5,
      voiced: patch.viseme !== 'none'
    }
  }
  return { format: 'dsh-audio-lipsync', version: 1, fps, duration: DURATION, leadMs: options.leadMs ?? 0, frames }
}

const PERFECT_CUES = PULSES.map((start) => ({ start, end: start + 0.3 }))

const narration = buildNarration()
const narrationBytes = toWavBytes(narration, SAMPLE_RATE)
await write('narration.wav', narrationBytes)
await write('silent.wav', toWavBytes(new Float32Array(Math.round(DURATION * SAMPLE_RATE)), SAMPLE_RATE))
// Left/right in antiphase: a mono fold cancels to near-silence, so the speech map
// must be built from a per-channel envelope, not a fold.
const inverted = new Float32Array(narration.length)
for (let i = 0; i < narration.length; i += 1) inverted[i] = -narration[i]
await write('antiphase.wav', toWavBytesChannels([narration, inverted], SAMPLE_RATE))
await write('empty.srt', Buffer.from('', 'utf8'))
const perfectSrt = buildSrt(PERFECT_CUES)
const perfectTrack = buildVisemes()
await write('perfect.srt', Buffer.from(perfectSrt, 'utf8'))
await write('perfect.json', Buffer.from(JSON.stringify(perfectTrack), 'utf8'))

const audit = (overrides = {}) => auditDelivery({
  cwd: scratch,
  audio: 'narration.wav',
  ...overrides
})

/* --------------------------------------------------------- perfect case -- */

console.log('-- perfect alignment --')
{
  const report = await audit({ srt: 'perfect.srt', visemes: 'perfect.json' })
  console.log(`  ${report.summary}`)
  console.log(`  issues=${report.issues.length} drift=${report.worstDriftMs}ms skipped=${report.skipped.length}`)
  console.log(`  ${report.checks['subtitle-vs-audio'].detail}`)
  console.log(`  ${report.checks['viseme-vs-audio'].detail}`)
  console.log(`  ${report.checks['subtitle-vs-viseme'].detail}`)

  check('perfect: ok', report.ok === true)
  check('perfect: no issues', report.issues.length === 0, JSON.stringify(report.issues))
  check('perfect: worst drift is 0 ms', report.worstDriftMs === 0, String(report.worstDriftMs))
  check('perfect: nothing skipped', report.skipped.length === 0, report.skipped.join(','))
  check('perfect: all three checks ran', report.checksRun === 3, String(report.checksRun))
  check('perfect: all three checks ran ok', Object.values(report.checks).every((entry) => entry.status === 'ok'),
    JSON.stringify(Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.status]))))
  check('perfect: six speech segments', report.metrics.audio.segments === 6, String(report.metrics.audio.segments))
  check('perfect: speech is 1.2 s', report.metrics.audio.speechSeconds === 1.2, String(report.metrics.audio.speechSeconds))
  check('perfect: every cue deviation is 0',
    report.metrics.subtitle.deviations.length === 6 && report.metrics.subtitle.deviations.every((entry) => entry.deviationMs === 0),
    JSON.stringify(report.metrics.subtitle.deviations.map((entry) => entry.deviationMs)))
  check('perfect: mouth covers all speech', report.metrics.visemeAudio.speechCoverage === 1,
    String(report.metrics.visemeAudio.speechCoverage))
  check('perfect: no open mouth in silence', report.metrics.visemeAudio.openInSilenceFrames === 0)
  check('perfect: no flicker', report.metrics.visemeAudio.flickerCount === 0)
  check('perfect: every cue has a mouth frame', report.metrics.subtitleViseme.cuesWithMouth === 6)
  check('perfect: summary says it passed', report.summary.includes('通过'), report.summary)
  check('perfect: issues carry the documented fields',
    report.issues.every((issue) => typeof issue.kind === 'string' && Number.isFinite(issue.at) &&
      typeof issue.detail === 'string' && (issue.severity === 'error' || issue.severity === 'warn')))
}

/* -------------------------------------------------- subtitle 200 ms late -- */

console.log('-- subtitles shifted by 200 ms --')
{
  const shifted = PERFECT_CUES.map((cue) => ({ ...cue, start: cue.start + 0.2, end: cue.end + 0.2 }))
  await write('offset.srt', Buffer.from(buildSrt(shifted), 'utf8'))
  const report = await audit({ srt: 'offset.srt', visemes: 'perfect.json' })
  const drift = report.issues.filter((issue) => issue.kind === 'subtitle-drift')
  const missing = report.issues.filter((issue) => issue.kind === 'subtitle-missing')
  console.log(`  ${report.summary}`)
  console.log(`  drift=${drift.length} missing=${missing.length} first drift @${drift[0]?.at}s ${drift[0]?.detail}`)

  check('offset: not ok', report.ok === false)
  check('offset: reports drift', drift.length > 0, String(drift.length))
  check('offset: worst drift is 200 ms', Math.abs(report.worstDriftMs - 200) <= 10, String(report.worstDriftMs))
  check('offset: worst entry is the first cue', report.metrics.subtitle.worst.index === 1,
    JSON.stringify(report.metrics.subtitle.worst))
  check('offset: first drift sits on cue 1', Math.abs(drift[0].at - 0.2) <= 0.011, String(drift[0]?.at))
  const firstLate = drift.find((issue) => issue.at === 0.2)
  check('offset: drift before twice the tolerance is an error',
    drift.every((issue) => issue.severity === 'error'), JSON.stringify(drift.map((issue) => issue.severity)))
  // The +200 ms shift makes every cue start over the *next* line's speech, so
  // the paired onset is that line's start; the report must name both times and
  // the 200 ms gap, whatever direction word it uses.
  check('offset: the cue is described against the paired onset',
    firstLate !== undefined && firstLate.detail.includes('200') && firstLate.detail.includes('0.4'),
    String(firstLate?.detail))
  check('offset: the uncovered first line is reported',
    missing.some((issue) => Math.abs(issue.at) <= 0.011), JSON.stringify(missing.map((issue) => issue.at)))
  check('offset: summary names the worst drift', report.summary.includes('200'), report.summary)
  // Requirement: "per-cue deviations and the worst one" — the five cues that
  // still overlap speech must each carry the 200 ms figure, not only the first.
  const deviationValues = report.metrics.subtitle.deviations.map((entry) => entry.deviationMs)
  const pairedDeviations = deviationValues.filter((value) => value !== null)
  check('offset: all six cues have a deviation slot', deviationValues.length === 6, JSON.stringify(deviationValues))
  check('offset: five paired cues are each 200 ms off',
    pairedDeviations.length === 5 && pairedDeviations.every((value) => Math.abs(value + 200) <= 10),
    JSON.stringify(pairedDeviations))
  check('offset: the unpairable silent cue stays null', deviationValues[5] === null, JSON.stringify(deviationValues[5]))
  check('offset: the worst entry carries its deviation',
    report.metrics.subtitle.worst.deviationMs === -200, JSON.stringify(report.metrics.subtitle.worst))
}

/* ------------------------------------------------------------ missing line -- */

console.log('-- one subtitle deleted --')
{
  const withoutThird = PERFECT_CUES.filter((_cue, index) => index !== 2)
  await write('missing.srt', Buffer.from(buildSrt(withoutThird), 'utf8'))
  const report = await audit({ srt: 'missing.srt', visemes: 'perfect.json' })
  const missing = report.issues.filter((issue) => issue.kind === 'subtitle-missing')
  console.log(`  ${report.summary}`)
  console.log(`  missing=${missing.length} ${missing.map((issue) => `${issue.at}s/${issue.severity}`).join(' ')}`)

  check('missing: not ok', report.ok === false)
  check('missing: one uncovered span', missing.length === 1, String(missing.length))
  check('missing: the span is the deleted line', Math.abs(missing[0].at - 0.8) <= 0.011, String(missing[0]?.at))
  check('missing: a 200 ms span is a warning', missing[0].severity === 'warn', String(missing[0]?.severity))
  check('missing: cue count drops to 5', report.metrics.subtitle.cues === 5, String(report.metrics.subtitle.cues))
  check('missing: the remaining cues still align', report.issues.filter((issue) => issue.kind === 'subtitle-drift').length === 0)
}

/* -------------------------------------------------------------- extra cue -- */

console.log('-- one subtitle added over a pause --')
{
  const withExtra = [...PERFECT_CUES, { start: 1.0, end: 1.2, text: '多出来的一句' }]
  await write('extra.srt', Buffer.from(buildSrt(withExtra), 'utf8'))
  const report = await audit({ srt: 'extra.srt', visemes: 'perfect.json' })
  const silent = report.issues.filter((issue) => issue.kind === 'subtitle-silent')
  const mouth = report.issues.filter((issue) => issue.kind === 'subtitle-mouth-missing')
  console.log(`  ${report.summary}`)
  console.log(`  silent=${silent.length} mouth=${mouth.length} ${silent[0]?.detail}`)

  check('extra: not ok', report.ok === false)
  check('extra: one silent cue', silent.length === 1, String(silent.length))
  check('extra: the silent cue is the extra one', Math.abs(silent[0].at - 1.0) <= 0.011, String(silent[0]?.at))
  check('extra: a fully silent cue is an error', silent[0].severity === 'error', String(silent[0]?.severity))
  check('extra: subtitle-vs-mouth flags it too',
    mouth.some((issue) => Math.abs(issue.at - 1.0) <= 0.011), JSON.stringify(mouth.map((issue) => issue.at)))
  check('extra: all seven cues are loaded', report.metrics.subtitle.cues === 7, String(report.metrics.subtitle.cues))
}

/* --------------------------------------------------------- mouth over pause -- */

console.log('-- mouth held open through a pause --')
{
  // Frames 25-29 are 1.00-1.16 s, i.e. the gap between the third and fourth
  // bursts: the mouth stays open where the voice is silent.
  const patches = [25, 26, 27, 28, 29].map((frame) => ({ frame, viseme: 'AA' }))
  await write('open-silence.json', Buffer.from(JSON.stringify(buildVisemes({ patches })), 'utf8'))
  const report = await audit({ srt: 'perfect.srt', visemes: 'open-silence.json' })
  const open = report.issues.filter((issue) => issue.kind === 'mouth-open-in-silence')
  console.log(`  ${report.summary}`)
  console.log(`  openInSilence=${report.metrics.visemeAudio.openInSilenceFrames} frames, ${open[0]?.detail}`)

  check('open-in-silence: not ok', report.ok === false)
  check('open-in-silence: one aggregate issue', open.length === 1, String(open.length))
  check('open-in-silence: starts at 1.0 s', Math.abs(open[0].at - 1.0) <= 0.011, String(open[0]?.at))
  check('open-in-silence: five frames measured', report.metrics.visemeAudio.openInSilenceFrames === 5,
    String(report.metrics.visemeAudio.openInSilenceFrames))
  check('open-in-silence: one run', report.metrics.visemeAudio.silentOpenRuns === 1,
    String(report.metrics.visemeAudio.silentOpenRuns))
  check('open-in-silence: detail names the count', open[0].detail.includes('5 帧'), open[0].detail)
  check('open-in-silence: five frames is a warning', open[0].severity === 'warn', open[0].severity)
  check('open-in-silence: the run is 200 ms', Math.abs(report.metrics.visemeAudio.longestOpenInSilenceSeconds - 0.2) <= 0.001,
    String(report.metrics.visemeAudio.longestOpenInSilenceSeconds))
  check('open-in-silence: overshoot share is measured',
    Math.abs(report.metrics.visemeAudio.openFrameOvershoot - 5 / 35) < 0.001,
    String(report.metrics.visemeAudio.openFrameOvershoot))
  check('open-in-silence: speech coverage is untouched',
    report.metrics.visemeAudio.speechCoverage === 1, String(report.metrics.visemeAudio.speechCoverage))
}

/* --------------------------------------------- one-frame boundary spill -- */

console.log('-- one-frame jaw release at every boundary is tolerated --')
{
  // A real audio_lipsync track holds a shape for about one frame past each
  // burst (attack/release smoothing). Those single frames are the same labels as
  // the burst, so they show up on the "open over silence" counter but must not
  // be reported: the longest contiguous silent run is 40 ms, under the 80 ms
  // threshold that separates a boundary artefact from a mouth left open.
  const patches = [5, 15, 25, 35, 45, 55].map((frame) => ({ frame, viseme: 'AA' }))
  await write('spill.json', Buffer.from(JSON.stringify(buildVisemes({ patches })), 'utf8'))
  const report = await audit({ srt: 'perfect.srt', visemes: 'spill.json' })
  console.log(`  ${report.summary}`)
  console.log(`  silentOpen=${report.metrics.visemeAudio.openInSilenceFrames} frames, ` +
    `longestRun=${report.metrics.visemeAudio.longestOpenInSilenceSeconds}s`)
  check('spill: six single frames are counted', report.metrics.visemeAudio.openInSilenceFrames === 6,
    String(report.metrics.visemeAudio.openInSilenceFrames))
  check('spill: the longest run is one frame', Math.abs(report.metrics.visemeAudio.longestOpenInSilenceSeconds - 0.04) <= 0.001,
    String(report.metrics.visemeAudio.longestOpenInSilenceSeconds))
  check('spill: no open-in-silence issue', !report.issues.some((issue) => issue.kind === 'mouth-open-in-silence'),
    JSON.stringify(report.issues.map((issue) => issue.kind)))
  check('spill: the deliverable stays ok', report.ok === true, JSON.stringify(report.issues))
}

/* ------------------------------------- jaw release tolerance and long holds -- */

console.log('-- jaw release tolerance scales with the frame rate --')
{
  // A sparser fixture — two bursts with an 800 ms pause between them — so a hold
  // can be longer than the 200 ms gaps in the main fixture. It proves both sides
  // of the rule: one frame of jaw release is tolerated at any frame rate, a hold
  // that a viewer sees is reported, and the tolerance scales with the frame rate.
  const sparseRate = 16000
  const sparse = new Float32Array(Math.round(2.0 * sparseRate))
  const sparseRamp = Math.round(0.005 * sparseRate)
  for (const start of [0, 1.0]) {
    const from = Math.round(start * sparseRate)
    const count = Math.round(PULSE_SECONDS * sparseRate)
    for (let i = 0; i < count; i += 1) {
      const envelope = Math.min(1, i / sparseRamp, (count - 1 - i) / sparseRamp)
      sparse[from + i] += 0.5 * envelope * Math.sin(2 * Math.PI * 440 * i / sparseRate)
    }
  }
  await write('sparse.wav', toWavBytes(sparse, sparseRate))
  await write('sparse.srt', Buffer.from(buildSrt([{ start: 0, end: 0.3 }, { start: 1.0, end: 1.3 }]), 'utf8'))

  function sparseTrack (fps, extraWindows = []) {
    const frames = []
    const frameCount = Math.round(2.0 * fps)
    for (let index = 0; index < frameCount; index += 1) {
      const t = index / fps
      const burst = (t >= 0 && t < PULSE_SECONDS) || (t >= 1.0 && t < 1.0 + PULSE_SECONDS)
      const extra = extraWindows.some(([from, to]) => t >= from - 1e-9 && t < to - 1e-9)
      frames.push({ t: Number(t.toFixed(6)), viseme: burst || extra ? 'AA' : 'none' })
    }
    return { format: 'dsh-audio-lipsync', version: 1, fps, duration: 2, leadMs: 0, frames }
  }

  const sparseAudit = (fps, extraWindows) => auditDelivery({
    cwd: scratch,
    audio: 'sparse.wav',
    srt: 'sparse.srt',
    visemes: sparseTrack(fps, extraWindows)
  })
  const silentIssues = (report) => report.issues.filter((issue) => issue.kind === 'mouth-open-in-silence')

  const release25 = await sparseAudit(25, [[0.2, 0.24]])
  check('release: 25 fps one frame is tolerated', silentIssues(release25).length === 0,
    JSON.stringify(release25.issues.map((issue) => issue.kind)))
  check('release: the 40 ms run is measured',
    Math.abs(release25.metrics.visemeAudio.longestOpenInSilenceSeconds - 0.04) <= 0.001,
    String(release25.metrics.visemeAudio.longestOpenInSilenceSeconds))
  check('release: the deliverable stays ok', release25.ok === true, JSON.stringify(release25.issues))

  const hold25 = await sparseAudit(25, [[0.4, 0.84]])
  console.log(`  25 fps hold: ${silentIssues(hold25)[0]?.detail}`)
  check('hold: 25 fps 440 ms is an error',
    silentIssues(hold25).length === 1 && silentIssues(hold25)[0].severity === 'error',
    JSON.stringify(silentIssues(hold25).map((issue) => issue.severity)))
  check('hold: the run is 440 ms',
    Math.abs(hold25.metrics.visemeAudio.longestOpenInSilenceSeconds - 0.44) <= 0.005,
    String(hold25.metrics.visemeAudio.longestOpenInSilenceSeconds))

  // At 10 fps one frame is 100 ms: a fixed 80 ms threshold would flag a clean
  // track, so the release tolerance is 1.5 frames.
  const release10 = await sparseAudit(10, [[0.2, 0.3]])
  check('release: 10 fps one frame is tolerated', silentIssues(release10).length === 0,
    JSON.stringify(release10.issues.map((issue) => issue.kind)))
  check('release: the 100 ms run is measured',
    Math.abs(release10.metrics.visemeAudio.longestOpenInSilenceSeconds - 0.1) <= 0.001,
    String(release10.metrics.visemeAudio.longestOpenInSilenceSeconds))

  const hold10 = await sparseAudit(10, [[0.2, 0.4]])
  check('hold: 10 fps 200 ms is a warning',
    silentIssues(hold10).length === 1 && silentIssues(hold10)[0].severity === 'warn',
    JSON.stringify(silentIssues(hold10).map((issue) => issue.severity)))
}

/* --------------------------------------------- leadMs and truncated tracks -- */

console.log('-- leadMs is honoured, a truncated track is not coverage --')
{
  // A track generated with `leadMs: -200` analyses 200 ms late: the shape at
  // picture time t describes audio at t - 0.2. Shifting the open windows 200 ms
  // later and declaring that lead must audit as a perfect match.
  const leaked = buildVisemes({ shiftFrames: 5, leadMs: -200 })
  await write('leaded.json', Buffer.from(JSON.stringify(leaked), 'utf8'))
  const leaded = await audit({ srt: 'perfect.srt', visemes: 'leaded.json' })
  console.log(`  lead: ${leaded.summary}`)
  check('lead: coverage is 100% once leadMs is applied',
    leaded.metrics.visemeAudio.speechCoverage === 1, String(leaded.metrics.visemeAudio.speechCoverage))
  check('lead: no coverage issue', !leaded.issues.some((issue) => issue.kind === 'mouth-coverage'),
    JSON.stringify(leaded.issues.map((issue) => issue.kind)))
  check('lead: no open-in-silence issue', !leaded.issues.some((issue) => issue.kind === 'mouth-open-in-silence'),
    JSON.stringify(leaded.issues.map((issue) => issue.kind)))

  // 17 of 60 frames: the first 0.68 s only. The last frame must not be treated as
  // open-ended, so the uncovered speech has to be reported.
  const truncated = buildVisemes({ frameCount: 17 })
  await write('truncated.json', Buffer.from(JSON.stringify(truncated), 'utf8'))
  const short = await audit({ srt: 'perfect.srt', visemes: 'truncated.json' })
  const coverage = short.issues.filter((issue) => issue.kind === 'mouth-coverage')
  const mouthMissing = short.issues.filter((issue) => issue.kind === 'subtitle-mouth-missing')
  console.log(`  truncated: ${short.summary}`)
  check('truncated: not ok', short.ok === false)
  check('truncated: coverage is reported short',
    coverage.length === 1 && coverage[0].severity === 'error', JSON.stringify(coverage.map((issue) => issue.severity)))
  check('truncated: coverage number is below a third',
    short.metrics.visemeAudio.speechCoverage < 0.4, String(short.metrics.visemeAudio.speechCoverage))
  check('truncated: captions after the track end have no mouth', mouthMissing.length === 4,
    JSON.stringify(mouthMissing.map((issue) => issue.at)))
}

/* ------------------------------------------------------------ flicker ---- */

console.log('-- one-frame viseme flicker --')
{
  // Frame 2 (0.08 s) turns EH between two AA frames, frame 12 (0.48 s) OH
  // between two AA frames: A B A twice, one defect each.
  const patches = [{ frame: 2, viseme: 'EH' }, { frame: 12, viseme: 'OH' }]
  await write('flicker.json', Buffer.from(JSON.stringify(buildVisemes({ patches })), 'utf8'))
  const report = await audit({ srt: 'perfect.srt', visemes: 'flicker.json' })
  const flicker = report.issues.filter((issue) => issue.kind === 'mouth-flicker')
  console.log(`  ${report.summary}`)
  console.log(`  flicker=${report.metrics.visemeAudio.flickerCount} ${flicker[0]?.detail}`)

  check('flicker: not ok', report.ok === false)
  check('flicker: one aggregate issue', flicker.length === 1, String(flicker.length))
  check('flicker: two single-frame runs', report.metrics.visemeAudio.flickerCount === 2,
    String(report.metrics.visemeAudio.flickerCount))
  check('flicker: first one at 0.08 s', Math.abs(flicker[0].at - 0.08) <= 0.0011, String(flicker[0]?.at))
  check('flicker: detail names two', flicker[0].detail.includes('2 处'), flicker[0].detail)
  check('flicker: every occurrence is timed',
    report.metrics.visemeAudio.flickerTimes.length === 2 &&
      Math.abs(report.metrics.visemeAudio.flickerTimes[1] - 0.48) <= 0.0011,
    JSON.stringify(report.metrics.visemeAudio.flickerTimes))
  check('flicker: two runs is a warning', flicker[0].severity === 'warn', flicker[0].severity)
}

/* ------------------------------------------------- maxDriftMs threshold -- */

console.log('-- maxDriftMs threshold --')
{
  const lead = PERFECT_CUES.map((cue) => ({ ...cue, start: cue.start + 0.1, end: cue.end + 0.1 }))
  await write('lead.srt', Buffer.from(buildSrt(lead), 'utf8'))
  const strict = await audit({ srt: 'lead.srt', visemes: 'perfect.json' })
  const relaxed = await audit({ srt: 'lead.srt', visemes: 'perfect.json', maxDriftMs: 150 })
  const strictDrift = strict.issues.filter((issue) => issue.kind === 'subtitle-drift')
  console.log(`  strict: ${strict.summary}`)
  console.log(`  relaxed: ${relaxed.summary}`)

  check('threshold: 100 ms is reported at the default 80 ms', strictDrift.length > 0, String(strictDrift.length))
  check('threshold: 100 ms stays a warning below twice the tolerance',
    strictDrift.every((issue) => issue.severity === 'warn'), JSON.stringify(strictDrift.map((issue) => issue.severity)))
  check('threshold: worst drift is 100 ms', Math.abs(strict.worstDriftMs - 100) <= 10, String(strict.worstDriftMs))
  check('threshold: 100 ms passes at maxDriftMs 150', relaxed.ok === true, JSON.stringify(relaxed.issues))
  check('threshold: the drift is still measured when it passes',
    Math.abs(relaxed.worstDriftMs - 100) <= 10, String(relaxed.worstDriftMs))
}

/* ------------------------------------------------------- skipped checks -- */

console.log('-- partial inputs are skipped, not failed --')
{
  const audioOnly = await audit()
  console.log(`  audio only: ${audioOnly.summary}`)
  // Nothing was compared, so the call must not certify the delivery: `ok` means
  // "verified", and an unaudited file is not verified.
  check('audio only: not a pass', audioOnly.ok === false, String(audioOnly.ok))
  check('audio only: no issues', audioOnly.issues.length === 0, JSON.stringify(audioOnly.issues.map((issue) => issue.kind)))
  check('audio only: all three checks skipped', audioOnly.skipped.length === 3, audioOnly.skipped.join(','))
  check('audio only: no check ran', audioOnly.checksRun === 0, String(audioOnly.checksRun))
  check('audio only: checks marked skipped',
    Object.values(audioOnly.checks).every((entry) => entry.status === 'skipped'))
  check('audio only: worst drift is null', audioOnly.worstDriftMs === null, String(audioOnly.worstDriftMs))
  check('audio only: summary says it did not audit', audioOnly.summary.includes('未对账'), audioOnly.summary)
  check('audio only: summary names what it skipped', audioOnly.summary.includes('跳过'), audioOnly.summary)

  const srtOnly = await audit({ srt: 'perfect.srt' })
  check('srt only: two checks skipped',
    srtOnly.skipped.length === 2 && srtOnly.skipped.includes('viseme-vs-audio') &&
      srtOnly.skipped.includes('subtitle-vs-viseme'), srtOnly.skipped.join(','))
  check('srt only: subtitle-vs-audio ran', srtOnly.checks['subtitle-vs-audio'].status === 'ok')
  check('srt only: one check ran', srtOnly.checksRun === 1, String(srtOnly.checksRun))
  check('srt only: still ok', srtOnly.ok === true)

  const visemesOnly = await audit({ visemes: 'perfect.json' })
  check('visemes only: two checks skipped',
    visemesOnly.skipped.length === 2 && visemesOnly.skipped.includes('subtitle-vs-audio') &&
      visemesOnly.skipped.includes('subtitle-vs-viseme'), visemesOnly.skipped.join(','))
  check('visemes only: viseme-vs-audio ran', visemesOnly.checks['viseme-vs-audio'].status === 'ok')
  check('visemes only: still ok', visemesOnly.ok === true)
}

/* --------------------------------------------------------- empty subtitle -- */

console.log('-- an srt with no cues --')
{
  const report = await audit({ srt: 'empty.srt', visemes: 'perfect.json' })
  const missing = report.issues.filter((issue) => issue.kind === 'subtitle-missing')
  console.log(`  ${report.summary}`)
  check('empty srt: every speech span is missing', missing.length === 6, String(missing.length))
  check('empty srt: not ok', report.ok === false)
  check('empty srt: the detail does not contradict the verdict',
    report.checks['subtitle-vs-audio'].detail.includes('没有字幕条目'), report.checks['subtitle-vs-audio'].detail)
  check('empty srt: caption-vs-mouth is skipped with a reason', report.skipped.includes('subtitle-vs-viseme') &&
    report.checks['subtitle-vs-viseme'].detail.includes('没有字幕条目'), JSON.stringify(report.skipped))
  check('empty srt: two checks ran', report.checksRun === 2, String(report.checksRun))
}

/* ------------------------------------------------------- silent narration -- */

console.log('-- silent narration --')
{
  const report = await auditDelivery({ cwd: scratch, audio: 'silent.wav', srt: 'perfect.srt', visemes: 'perfect.json' })
  console.log(`  ${report.summary}`)
  check('silent: one audio-silent issue', report.issues.length === 1 && report.issues[0].kind === 'audio-silent',
    JSON.stringify(report.issues.map((issue) => issue.kind)))
  check('silent: not ok', report.ok === false)
  check('silent: the two audio-dependent checks are skipped',
    report.skipped.length === 2 && report.skipped.includes('subtitle-vs-audio') &&
      report.skipped.includes('viseme-vs-audio'), JSON.stringify(report.skipped))
  // Caption vs mouth does not read the audio, so a silent file still gets it.
  check('silent: caption-vs-mouth still runs',
    report.checks['subtitle-vs-viseme'].status === 'ok', report.checks['subtitle-vs-viseme'].detail)
  check('silent: one check ran', report.checksRun === 1, String(report.checksRun))
}

/* --------------------------------------------------- antiphase narration -- */

console.log('-- out-of-phase stereo narration --')
{
  const report = await auditDelivery({ cwd: scratch, audio: 'antiphase.wav', srt: 'perfect.srt', visemes: 'perfect.json' })
  console.log(`  ${report.summary}`)
  check('antiphase: not reported as silent', !report.issues.some((issue) => issue.kind === 'audio-silent'),
    JSON.stringify(report.issues.map((issue) => issue.kind)))
  check('antiphase: stereo is reported', report.metrics.audio.channelCount === 2, String(report.metrics.audio.channelCount))
  check('antiphase: the speech map still sees six segments', report.metrics.audio.segments === 6,
    String(report.metrics.audio.segments))
  check('antiphase: the deliverable audits clean', report.ok === true, JSON.stringify(report.issues))
}

/* --------------------------------------------------- inline / odd input -- */

console.log('-- inline payloads and out-of-whitelist labels --')
{
  const inline = await audit({ visemes: buildVisemes() })
  check('inline: a frames payload is accepted', inline.checks['viseme-vs-audio'].status === 'ok')

  const weird = buildVisemes()
  weird.frames[0].viseme = 'ZZ'
  const report = await audit({ visemes: weird })
  const unknown = report.issues.filter((issue) => issue.kind === 'viseme-unknown')
  console.log(`  ${report.summary}`)
  check('unknown label: reported once', unknown.length === 1, String(unknown.length))
  check('unknown label: counted', report.metrics.visemeAudio.unknownVisemes === 1,
    String(report.metrics.visemeAudio.unknownVisemes))
  check('unknown label: not ok', report.ok === false)
  check('unknown label: the label is still treated as closed',
    report.metrics.visemeAudio.openInSilenceFrames === 0, String(report.metrics.visemeAudio.openInSilenceFrames))
}

/* -------------------------------------------------------------- parser --- */

console.log('-- SRT parser --')
{
  const parsed = parseSrt('\uFEFF1\r\n00:00:01.500 --> 00:00:02.250\r\n第一行\r\n第二行\r\n\r\n00:03,000 --> 00:03,750\r\n短格式\r\n')
  console.log(`  cues=${parsed.length} first=${parsed[0]?.start}-${parsed[0]?.end} second=${parsed[1]?.start}-${parsed[1]?.end}`)
  check('parser: two cues', parsed.length === 2, String(parsed.length))
  check('parser: dot separator and BOM and CRLF', parsed[0].start === 1.5 && parsed[0].end === 2.25,
    JSON.stringify(parsed[0]))
  check('parser: multi-line text is kept', parsed[0].text === '第一行\n第二行', JSON.stringify(parsed[0].text))
  check('parser: missing index and short timecode work', parsed[1].start === 3 && parsed[1].end === 3.75,
    JSON.stringify(parsed[1]))

  const compact = parseSrt('00:00:00,000 --> 00:00:00,500\nA\n00:00:00,500 --> 00:00:01,000\nB\n')
  check('parser: cues without blank lines between them', compact.length === 2, String(compact.length))

  const empty = parseSrt('')
  check('parser: an empty document has no cues', empty.length === 0)

  let bad = null
  try {
    parseSrt('这不是字幕\n完全没有时间码')
  } catch (error) {
    bad = error
  }
  check('parser: a bad document throws a readable error',
    bad instanceof Error && /第 1 行|时间行/.test(bad.message), String(bad?.message))

  let inverted = null
  try {
    parseSrt('1\n00:00:02,000 --> 00:00:01,000\n倒序\n')
  } catch (error) {
    inverted = error
  }
  check('parser: an inverted cue throws a readable error',
    inverted instanceof Error && /不晚于/.test(inverted.message), String(inverted?.message))

  let garbled = null
  try {
    parseSrt('1\n00:00:ab --> 00:00:01,000\nx\n')
  } catch (error) {
    garbled = error
  }
  check('parser: a garbled timecode throws a readable error',
    garbled instanceof Error && /时间码/.test(garbled.message), String(garbled?.message))
}

/* --------------------------------------------------------------- errors -- */

console.log('-- unreadable inputs fail with a readable message --')
{
  async function expectThrow (label, run, pattern) {
    try {
      await run()
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, error instanceof Error && pattern.test(error.message), String(error?.message))
    }
  }

  await write('broken.srt', Buffer.from('这不是字幕\n也没有时间码\n', 'utf8'))
  await write('broken.json', Buffer.from('{ not json', 'utf8'))
  await write('shape.json', Buffer.from('{ "frames": "nope" }', 'utf8'))

  await expectThrow('missing wav names the file', () => audit({ audio: 'nope.wav' }), /nope\.wav|读不出音频/)
  await expectThrow('missing srt names the file', () => audit({ srt: 'nope.srt' }), /nope\.srt|读不出字幕/)
  await expectThrow('missing visemes names the file', () => audit({ visemes: 'nope.json' }), /nope\.json|读不出口型轨/)
  await expectThrow('broken srt content is readable', () => audit({ srt: 'broken.srt' }), /时间行|SRT/)
  await expectThrow('broken viseme json is readable', () => audit({ visemes: 'broken.json' }), /JSON/)
  await expectThrow('viseme payload without frames is readable', () => audit({ visemes: 'shape.json' }), /frames/)
  await expectThrow('a missing audio argument is named', () => auditDelivery({ cwd: scratch }), /audio/)
}

/* ---------------------------------------------------------------- tool --- */

console.log('-- audio_audit tool --')
{
  const registered = new Map()
  const toolCtx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
  }
  const toolExec = { agent: { session: { id: 'audit-test' } } }
  registerAuditTool(toolCtx)
  check('tool: registered as audio_audit', registered.has('audio_audit'))
  const definition = registered.get('audio_audit')
  check('tool: audio is the only required parameter',
    Array.isArray(definition.parameters.required) && definition.parameters.required.length === 1 &&
      definition.parameters.required[0] === 'audio', JSON.stringify(definition.parameters.required))
  const call = (args) => definition.execute(args, toolExec)

  const passed = await call({ audio: 'narration.wav', srt: 'perfect.srt', visemes: 'perfect.json', out: 'reports/perfect' })
  console.log(`  ${passed.text.split('\n')[0]}`)
  check('tool: perfect report is ok', passed.ok === true)
  check('tool: wrote the JSON report', passed.relativePath === 'reports/perfect.json', String(passed.relativePath))
  const payload = JSON.parse(await readFile(join(scratch, 'reports', 'perfect.json'), 'utf8'))
  check('tool: report is tagged', payload.format === 'dsh-audio-audit' && payload.version === 1, String(payload.format))
  check('tool: report carries the contract keys',
    Array.isArray(payload.issues) && typeof payload.ok === 'boolean' &&
      typeof payload.summary === 'string' && 'worstDriftMs' in payload && Array.isArray(payload.skipped))
  check('tool: text is a Chinese report', /对账/.test(passed.text) && /字幕↔音频/.test(passed.text), passed.text.split('\n')[0])
  check('tool: text names the written report', passed.text.includes('reports/perfect.json'))
  check('tool: text lists the three pairwise checks',
    passed.text.includes('字幕↔音频') && passed.text.includes('口型↔音频') && passed.text.includes('字幕↔口型'))

  const failed = await call({ audio: 'narration.wav', srt: 'offset.srt', visemes: 'perfect.json' })
  check('tool: a broken sync is not ok', failed.ok === false)
  check('tool: the text names the drift issue', failed.text.includes('subtitle-drift'), failed.text.split('\n').slice(-4).join(' | '))
  check('tool: returned issues keep kind/at/detail/severity',
    failed.issues.length > 0 && failed.issues.every((issue) => typeof issue.kind === 'string' &&
      Number.isFinite(issue.at) && typeof issue.detail === 'string' &&
      (issue.severity === 'error' || issue.severity === 'warn')))

  const marked = await call({ audio: 'narration.wav' })
  check('tool: skipped checks are returned',
    marked.skipped.length === 3 && marked.ok === false && marked.checksRun === 0,
    `${marked.skipped.length}/${marked.ok}/${marked.checksRun}`)
  check('tool: no report file without out', marked.path === null && marked.relativePath === null)

  // The audit is read-only. `out` pointing at an input must be refused, not
  // written: otherwise the JSON report replaces the narration it audited.
  const oversized = Array.from({ length: 9000 }, (_value, index) => ({ t: index / 25, viseme: 'AA' }))
  for (const [label, args, pattern] of [
    ['tool: rejects a missing audio', {}, /audio/],
    ['tool: rejects a bad tolerance', { audio: 'narration.wav', maxDriftMs: -5 }, /maxDriftMs/],
    ['tool: rejects a non-path srt', { audio: 'narration.wav', srt: 42 }, /srt/],
    ['tool: rejects an array visemes', { audio: 'narration.wav', visemes: [1, 2] }, /visemes/],
    ['tool: refuses out over the narration', { audio: 'narration.wav', out: 'narration.wav' }, /覆盖输入|输入文件/],
    ['tool: refuses out over the subtitle', { audio: 'narration.wav', srt: 'perfect.srt', out: 'perfect.srt' }, /覆盖输入|输入文件/],
    ['tool: refuses out over the mouth track', { audio: 'narration.wav', visemes: 'perfect.json', out: 'perfect.json' }, /覆盖输入|输入文件/]
  ]) {
    let threw = null
    try {
      await call(args)
    } catch (error) {
      threw = error
    }
    check(label, threw instanceof Error && pattern.test(threw.message), String(threw?.message))
  }

  // The guard runs before the write, so the input is still the wav it was.
  const narrationAfter = await readFile(join(scratch, 'narration.wav'))
  check('tool: the refused out left the narration intact',
    Buffer.compare(narrationAfter, Buffer.from(narrationBytes)) === 0, String(narrationAfter.length))

  // A malformed viseme payload must produce a short message, not echo the track.
  let oversizedError = null
  try {
    await call({ audio: 'narration.wav', visemes: oversized })
  } catch (error) {
    oversizedError = error
  }
  check('tool: a huge bad visemes payload gives a short error',
    oversizedError instanceof Error && oversizedError.message.length < 400 && /visemes/.test(oversizedError.message),
    String(oversizedError?.message?.length))

  let missingFile = null
  try {
    await call({ audio: 'nope.wav' })
  } catch (error) {
    missingFile = error
  }
  check('tool: an unreadable wav is reported', missingFile instanceof Error && /nope\.wav/.test(missingFile.message),
    String(missingFile?.message))

  // A frame whose `t` is null used to land at 0 s through a numeric cast.
  let nullTime = null
  try {
    await audit({ visemes: { fps: 25, frames: [{ t: null, viseme: 'AA' }] } })
  } catch (error) {
    nullTime = error
  }
  check('tool: a frame with a null time is rejected', nullTime instanceof Error && /t 不是合法时间/.test(nullTime.message),
    String(nullTime?.message))
}

/* ------------------------------------------------------- determinism ----- */

console.log('-- determinism --')
{
  const first = await audit({ srt: 'offset.srt', visemes: 'flicker.json' })
  const second = await audit({ srt: 'offset.srt', visemes: 'flicker.json' })
  check('same inputs give byte-identical JSON', JSON.stringify(first) === JSON.stringify(second))
  check('two runs agree on the verdict and the worst drift',
    first.ok === second.ok && first.worstDriftMs === second.worstDriftMs,
    `${first.ok}/${first.worstDriftMs} vs ${second.ok}/${second.worstDriftMs}`)
}

/* ------------------------------------------------------------- summary --- */

await rm(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: three-way audit behaves' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
