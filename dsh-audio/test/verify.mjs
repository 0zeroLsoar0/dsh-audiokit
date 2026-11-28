/**
 * `lib/verify.js` on its own: the delivery-verification arithmetic, without a
 * tool, a file on disk or a network.
 *
 * The three blocks fail in ways a rendered file cannot show, so they are pinned
 * on synthetic signals whose correct answer is known in close form:
 *
 *   - compliance: a 997 Hz sine at -X dBFS on every channel reads exactly
 *     -X.0 LUFS (the EBU Tech 3341 calibration point this plugin's meter is
 *     built around), so "delivered at the YouTube level" is a testable claim
 *     rather than a plausible one. The 5.1 case pins the shared meter: the
 *     compliance number must equal `analyzeLoudness` with the same channel
 *     decision `audio_loudness` uses, including LFE exclusion;
 *   - phase: L = -R is exactly -1 correlation and full cancellation, R silent
 *     is exactly the 6 dB pan law, and R = -0.5L is the boundary where the
 *     cancellation alarm has to fire;
 *   - sync: deviations are known to the millisecond from the numbers handed in,
 *     and the timeline checks (order, duplicate) are pinned independently of
 *     any audio.
 *
 * Run with the node from WORKERS.md:
 *   node test/verify.mjs
 */

import { analyzeLoudness } from '../lib/lufs.js'
import { loudnessChannels } from '../lib/multichannel.js'
import {
  LOUDNESS_TARGETS,
  LOUDNESS_TARGET_IDS,
  resolveLoudnessTarget,
  verifyCueSync,
  verifyLoudness,
  verifyPhase
} from '../lib/verify.js'

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

/** |actual - expected| <= tolerance, with both numbers in the failure detail. */
function near (label, actual, expected, tolerance = 0.05) {
  check(label, Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`)
}

function throws (label, fn, match) {
  let error
  try { fn() } catch (caught) { error = caught }
  // A plain Error, not a TypeError/RangeError: a validation failure is a
  // decision about the input, not a crash, and callers render it verbatim.
  const problems = []
  if (!(error instanceof Error)) problems.push('did not throw')
  else if (error.constructor !== Error) problems.push(`threw ${error.constructor.name}: ${error.message}`)
  else if (match !== undefined && !match.test(error.message)) problems.push(`message does not match /${match.source}/: ${error.message}`)
  check(label, problems.length === 0, problems.join('; '))
  return error
}

/** A sine at `dbfs` peak amplitude; identical on every named channel. */
function sine (frames, hz, dbfs) {
  const amplitude = Math.pow(10, dbfs / 20)
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) out[index] = amplitude * Math.sin(TAU * hz * index / RATE)
  return out
}

/** A stereo pair at `dbfs` per channel; `seconds` long. */
function stereo (seconds, dbfs) {
  const frames = Math.round(seconds * RATE)
  return [sine(frames, 997, dbfs), sine(frames, 997, dbfs)]
}

/** The loudness `audio_loudness` would report for these channels (shared meter). */
function sharedLufs (channels) {
  const { measured, weights } = loudnessChannels(channels)
  return analyzeLoudness(measured[0], RATE, { channels: measured, weights }).integratedLufs
}

console.log('verify: platform loudness compliance, phase / mono, cue sync')
console.log(`sample rate ${RATE} Hz\n`)

/* ------------------------------------------------------- target table ---- */

console.log('-- 1. delivery targets --')
{
  console.log(`  ${LOUDNESS_TARGET_IDS.map((id) => `${id} ${LOUDNESS_TARGETS[id].targetLufs}/${LOUDNESS_TARGETS[id].ceilingDbtp}`).join(' · ')}`)
  check('five platform targets', LOUDNESS_TARGET_IDS.length === 5, LOUDNESS_TARGET_IDS.join(','))
  check('the table is frozen', Object.isFrozen(LOUDNESS_TARGETS) && Object.isFrozen(LOUDNESS_TARGETS.youtube))

  const youtube = resolveLoudnessTarget('youtube')
  check('youtube is -14 LUFS at -1 dBTP', youtube.targetLufs === -14 && youtube.ceilingDbtp === -1, JSON.stringify(youtube))
  check('tiktok is -14 LUFS at -1 dBTP', resolveLoudnessTarget('tiktok').targetLufs === -14)
  check('podcast is -16 LUFS', resolveLoudnessTarget('podcast').targetLufs === -16)
  check('broadcast is -23 LUFS (EBU R128)', resolveLoudnessTarget('broadcast').targetLufs === -23)
  const cinema = resolveLoudnessTarget('cinema')
  check('cinema is quieter and keeps 2 dB of peak headroom', cinema.targetLufs === -27 && cinema.ceilingDbtp === -2, JSON.stringify(cinema))
  check('streaming targets allow +/-1 LU', youtube.toleranceLu === 1 && resolveLoudnessTarget('podcast').toleranceLu === 1)
  check('a table spec passes through untouched', resolveLoudnessTarget(youtube) === youtube)
  check('an id is case and space insensitive', resolveLoudnessTarget(' YouTube ').id === 'youtube')

  const custom = resolveLoudnessTarget({ targetLufs: -20, ceilingDbtp: -2 })
  check('a custom target resolves', custom.id === 'custom' && custom.targetLufs === -20 && custom.ceilingDbtp === -2 && custom.toleranceLu === 1, JSON.stringify(custom))
  check('a custom target keeps its label', resolveLoudnessTarget({ targetLufs: -20, label: '店内广播' }).label === '店内广播')
  check('a custom target without a label names itself', resolveLoudnessTarget({ targetLufs: -20 }).label === '自定义目标')

  throws('an unknown platform id is rejected and names the known ones', () => resolveLoudnessTarget('myspace'), /unknown loudness target.*youtube, tiktok, podcast, broadcast, cinema/)
  throws('a custom target without targetLufs is rejected', () => resolveLoudnessTarget({ ceilingDbtp: -1 }), /targetLufs/)
  throws('a positive loudness target is rejected', () => resolveLoudnessTarget({ targetLufs: 2 }), /targetLufs/)
  throws('a null loudness target is rejected, not coerced to 0 LUFS', () => resolveLoudnessTarget({ targetLufs: null }), /targetLufs/)
  throws('an empty-string loudness target is rejected, not coerced', () => resolveLoudnessTarget({ targetLufs: '' }), /targetLufs/)
  throws('an array loudness target is rejected, not coerced', () => resolveLoudnessTarget({ targetLufs: [] }), /targetLufs/)
  throws('a null ceiling is rejected, not coerced to 0 dBTP', () => resolveLoudnessTarget({ targetLufs: -14, ceilingDbtp: null }), /ceilingDbtp/)
  throws('a ceiling above 0 dBTP is rejected', () => resolveLoudnessTarget({ targetLufs: -14, ceilingDbtp: 3 }), /ceilingDbtp/)
  throws('a zero tolerance is rejected', () => resolveLoudnessTarget({ targetLufs: -14, toleranceLu: 0 }), /toleranceLu/)
  throws('a null tolerance is rejected', () => resolveLoudnessTarget({ targetLufs: -14, toleranceLu: null }), /toleranceLu/)
  throws('a string is not a custom target', () => resolveLoudnessTarget(7), /platform id/)
}

/* ------------------------------------------------ loudness compliance ---- */

console.log('\n-- 2. loudness compliance --')
{
  // One file per platform level: a stereo sine at the platform's own number.
  const levels = [['youtube', -14], ['tiktok', -14], ['podcast', -16], ['broadcast', -23], ['cinema', -27]]
  for (const [id, dbfs] of levels) {
    const report = verifyLoudness(stereo(1.5, dbfs), RATE, id)
    console.log(`  ${id.padEnd(9)} ${dbfs} dBFS -> ok ${report.ok}, ${report.measured.lufs} LUFS, true peak ${report.measured.truePeakDbtp} dBTP, gain ${report.suggestedGainDb} dB`)
    check(`${id}: a file at the target level is compliant`, report.ok === true && report.verdict === 'ok', report.summary)
    near(`${id}: the meter reads the level it was given`, report.measured.lufs, dbfs, 0.05)
    near(`${id}: loudness delta is zero`, report.lufsDelta, 0, 0.05)
    near(`${id}: suggested gain is zero`, report.suggestedGainDb, 0, 0.05)
    check(`${id}: true peak is inside the ceiling`, report.measured.truePeakDbtp <= report.target.ceilingDbtp)
    check(`${id}: every check passes`, report.checks.length === 2 && report.checks.every((entry) => entry.ok))
  }

  // Too loud: the platform would turn it down, and the gap is reported signed.
  const hot = verifyLoudness(stereo(1.5, -8), RATE, 'youtube')
  console.log(`  hot: ok ${hot.ok}, verdict ${hot.verdict}, delta ${hot.lufsDelta} LU, gain ${hot.suggestedGainDb} dB | ${hot.summary}`)
  check('a hot file is not compliant', hot.ok === false && hot.verdict === 'fail')
  near('the hot loudness gap is +6 LU', hot.lufsDelta, 6, 0.05)
  near('the advice is to pull the level down 6 dB', hot.suggestedGainDb, -6, 0.05)
  check('the failing check is an error above 3x tolerance', hot.checks[0].level === 'error' && hot.checks[0].ok === false)
  check('the summary says it is louder than target', /比目标响/.test(hot.summary), hot.summary)

  // Too quiet: the loss is what the platform cannot fix (it does not boost).
  const quiet = verifyLoudness(stereo(1.5, -30), RATE, 'youtube')
  console.log(`  quiet: ok ${quiet.ok}, delta ${quiet.lufsDelta} LU, gain ${quiet.suggestedGainDb} dB | ${quiet.summary}`)
  check('a quiet file is not compliant', quiet.ok === false)
  near('the quiet gap is -16 LU', quiet.lufsDelta, -16, 0.05)
  near('the advice is to raise the level 16 dB', quiet.suggestedGainDb, 16, 0.05)
  check('the summary says it is quieter than target', /比目标轻/.test(quiet.summary), quiet.summary)

  // Inside the tolerance is compliant, outside it is a warning until 3x.
  const nearMiss = verifyLoudness(stereo(1.5, -12.2), RATE, 'youtube')
  check('1.8 LU off is not compliant', nearMiss.ok === false)
  check('1.8 LU off warns instead of failing', nearMiss.verdict === 'warn' && nearMiss.checks[0].level === 'warn')
  const relaxed = verifyLoudness(stereo(1.5, -12.2), RATE, { targetLufs: -14, toleranceLu: 2 })
  check('the same file passes a +/-2 LU tolerance', relaxed.ok === true, relaxed.summary)

  // The true peak can fail on its own: a bed at the right loudness with one
  // sample pushed to full scale.
  const frames = Math.round(1.5 * RATE)
  const spike = [sine(frames, 997, -16), sine(frames, 997, -16)]
  spike[0][Math.round(RATE * 0.75)] = 0.98
  const peakOnly = verifyLoudness(spike, RATE, 'podcast')
  console.log(`  peak only: ok ${peakOnly.ok}, ${peakOnly.measured.lufs} LUFS, ${peakOnly.measured.truePeakDbtp} dBTP, over ${peakOnly.peakOverDbtp} dB | ${peakOnly.summary}`)
  check('the loudness check passes on the bed', peakOnly.checks[0].ok === true)
  check('the true-peak check fails above the ceiling', peakOnly.checks[1].ok === false && peakOnly.checks[1].level === 'error')
  check('a peak-only miss still fails the verdict', peakOnly.ok === false && peakOnly.verdict === 'fail')
  check('the peak overshoot is reported', peakOnly.peakOverDbtp > 0 && peakOnly.peakHeadroomDbtp < 0, `${peakOnly.peakOverDbtp}/${peakOnly.peakHeadroomDbtp}`)

  // Silence has no loudness: the report says so instead of inventing -70 LUFS.
  const silent = verifyLoudness([new Float32Array(Math.round(0.5 * RATE))], RATE, 'youtube')
  console.log(`  silent: ok ${silent.ok}, silent ${silent.measured.silent}, lufs ${silent.measured.lufs} | ${silent.checks[0].detail}`)
  check('a silent file is flagged as silent', silent.measured.silent === true)
  check('a silent file is not compliant', silent.ok === false && silent.verdict === 'fail')
  check('a silent file reports the gate floor, not a reading', silent.measured.lufs === -70)
  check('a silent file gets no invented gain advice', silent.suggestedGainDb === null && silent.peakHeadroomDbtp === null)
  check('the silent detail explains the gate', /静音/.test(silent.checks[0].detail), silent.checks[0].detail)

  // A mono file is measured with the BS.1770-4 single-channel weight (the same
  // number `audio_loudness` and ffmpeg report), so a mono sine at -20 dBFS peak
  // is a -23.01 LUFS signal and lands on the broadcast target.
  const mono = verifyLoudness([sine(Math.round(1.5 * RATE), 997, -20)], RATE, 'broadcast')
  console.log(`  mono -20 dBFS peak: ${mono.measured.lufs} LUFS vs broadcast -23 (delta ${mono.lufsDelta})`)
  check('a mono -20 dBFS peak file reads -23.01 LUFS, like audio_loudness and ffmpeg', mono.ok === true && Math.abs(mono.measured.lufs + 23.01) < 0.1,
    `${mono.measured.lufs} / ${mono.summary}`)
  const mono23 = verifyLoudness([sine(Math.round(1.5 * RATE), 997, -23)], RATE, 'broadcast')
  check('a mono -23 dBFS peak file is 3 LU under the broadcast target', mono23.ok === false && Math.abs(mono23.lufsDelta + 3.01) < 0.1,
    `${mono23.measured.lufs}`)

  // Short renders (a one-shot cue) are still measurable through the whole-file
  // basis the meter falls back to under 400 ms.
  const short = verifyLoudness(stereo(0.4, -14), RATE, 'youtube')
  check('a 400 ms cue is measurable', short.ok === true, `${short.measured.lufs} LUFS`)

  // The 5.1 case pins the shared meter: this number must equal what
  // `audio_loudness` reports, i.e. LFE excluded and surrounds at +1.5 dB.
  const build51 = (lfeDbfs) => {
    const frames51 = Math.round(1.5 * RATE)
    return [
      sine(frames51, 220, -20),
      sine(frames51, 260, -20),
      sine(frames51, 330, -22),
      sine(frames51, 40, lfeDbfs),
      sine(frames51, 500, -23),
      sine(frames51, 620, -23)
    ]
  }
  const five = build51(-14)
  const fiveReport = verifyLoudness(five, RATE, 'broadcast')
  const fiveExpected = sharedLufs(five)
  console.log(`  5.1: ${fiveReport.measured.lufs} LUFS on ${fiveReport.measured.loudnessChannels} channels (LFE excluded ${fiveReport.measured.lfeExcluded}), audio_loudness would read ${fiveExpected}`)
  near('5.1 compliance uses the same meter as audio_loudness', fiveReport.measured.lufs, fiveExpected, 0.001)
  check('5.1 excludes the LFE and says so', fiveReport.measured.lfeExcluded === true && fiveReport.measured.loudnessChannels === 5)
  const hotLfe = verifyLoudness(build51(-2), RATE, 'broadcast')
  check('a hot LFE does not move the compliance reading', Math.abs(hotLfe.measured.lufs - fiveReport.measured.lufs) < 0.01,
    `${hotLfe.measured.lufs} vs ${fiveReport.measured.lufs}`)

  // …but the true-peak ceiling is a property of the file, LFE included: a
  // surround deliverable whose LFE peaks over the ceiling is over the ceiling
  // even though BS.1770 never looked at that channel (lib/master.js agrees).
  const hotPeak = verifyLoudness(build51(-0.5), RATE, 'broadcast')
  console.log(`  hot LFE peak: lufs ${hotPeak.measured.lufs}, true peak ${hotPeak.measured.truePeakDbtp} dBTP (ceiling ${hotPeak.target.ceilingDbtp}), peak ok ${hotPeak.checks[1].ok}`)
  near('the LFE peak is measured, not skipped', hotPeak.measured.truePeakDbtp, -0.5, 0.15)
  check('an LFE over the ceiling fails the peak check', hotPeak.checks[1].ok === false && hotPeak.checks[1].level === 'error')
  check('an LFE over the ceiling fails compliance', hotPeak.ok === false && hotPeak.verdict === 'fail')
  check('the loudness reading is unaffected by the LFE peak', hotPeak.measured.lufs === hotLfe.measured.lufs &&
    hotPeak.checks[0].level === hotLfe.checks[0].level, `${hotPeak.measured.lufs} vs ${hotLfe.measured.lufs}`)
  check('the peak overshoot is reported', hotPeak.peakOverDbtp > 0.3 && hotPeak.peakHeadroomDbtp < -0.3,
    `${hotPeak.peakOverDbtp}/${hotPeak.peakHeadroomDbtp}`)

  throws('an empty channel list is rejected', () => verifyLoudness([], RATE, 'youtube'), /channel/)
  throws('a nonsensical sample rate is rejected', () => verifyLoudness(stereo(0.2, -14), 0, 'youtube'), /sample rate/)
}

/* --------------------------------------------------- phase / mono ---- */

console.log('\n-- 3. phase and mono compatibility --')
{
  const frames = Math.round(0.5 * RATE)
  const left = sine(frames, 440, -6)

  const inPhase = verifyPhase([left, sine(frames, 440, -6)])
  console.log(`  in phase: corr ${inPhase.correlation}, loss ${inPhase.monoLossDb} dB, ok ${inPhase.ok} | ${inPhase.summary}`)
  near('identical channels correlate at +1', inPhase.correlation, 1, 0.001)
  check('identical channels are not antiphase', inPhase.antiphase === false)
  near('identical channels lose nothing in the mono fold', inPhase.monoLossDb, 0, 0.01)
  check('identical channels pass', inPhase.ok === true && inPhase.verdict === 'ok')
  check('the pair is named L/R', inPhase.pair === 'L/R')
  near('the fold equals one channel for an in-phase pair', inPhase.monoFoldPeakDbfs, -6.02, 0.05)

  const antiphase = verifyPhase([left, left.map((value) => -value)])
  console.log(`  antiphase: corr ${antiphase.correlation}, loss ${antiphase.monoLossDb} dB, ok ${antiphase.ok} | ${antiphase.summary}`)
  near('an antiphase pair correlates at -1', antiphase.correlation, -1, 0.001)
  check('an antiphase pair is flagged', antiphase.antiphase === true && antiphase.ok === false && antiphase.verdict === 'warn')
  check('an antiphase pair loses its whole peak', antiphase.monoLossDb >= 60 && antiphase.monoLossDb <= 120, String(antiphase.monoLossDb))
  check('both phase checks fail on an antiphase pair', antiphase.checks.every((entry) => entry.ok === false && entry.level === 'warn'))
  check('the correlation detail names the threshold', /-0\.5/.test(antiphase.checks[0].detail), antiphase.checks[0].detail)

  // A hard-panned element is not a phase problem: the 6 dB it loses in a
  // 0.5-averaged fold is the pan law, not cancellation, so it must read 0.
  const hardPan = verifyPhase([left, new Float32Array(frames)])
  console.log(`  hard pan: corr ${hardPan.correlation}, loss ${hardPan.monoLossDb} dB, fold ${hardPan.monoFoldPeakDbfs} dBFS, ok ${hardPan.ok}`)
  check('a silent second channel has no correlation', hardPan.correlation === null)
  check('a hard-panned element is not flagged as cancellation', hardPan.monoLossDb === 0 && hardPan.ok === true, String(hardPan.monoLossDb))
  near('the mono fold of a hard pan is 6 dB down (pan law)', hardPan.monoFoldPeakDbfs, -12.02, 0.05)

  // The alarm boundary: 0.5x antiphase loses exactly 6.02 dB (over the 6 dB
  // threshold), 0.4x loses 4.44 dB (under it).
  const halfAntiphase = verifyPhase([left, left.map((value) => -value * 0.5)])
  const mildAntiphase = verifyPhase([left, left.map((value) => -value * 0.4)])
  console.log(`  half antiphase: loss ${halfAntiphase.monoLossDb} dB (alarm ${!halfAntiphase.checks[1].ok}); 0.4x: loss ${mildAntiphase.monoLossDb} dB (alarm ${!mildAntiphase.checks[1].ok})`)
  near('0.5x antiphase loses 6.02 dB', halfAntiphase.monoLossDb, 6.02, 0.05)
  check('a fold loss above 6 dB alarms', halfAntiphase.checks[1].ok === false && halfAntiphase.checks[1].level === 'warn')
  near('0.4x antiphase loses 4.44 dB', mildAntiphase.monoLossDb, 4.44, 0.05)
  check('a fold loss under 6 dB does not alarm', mildAntiphase.checks[1].ok === true)

  // Surround: only the front pair is judged, and the fold is the layout downmix.
  const quad = verifyPhase([left, left.map((value) => -value), sine(frames, 300, -12), sine(frames, 300, -12)])
  console.log(`  quad: pair ${quad.pair}, corr ${quad.correlation}, fold ${quad.monoFoldPeakDbfs} dBFS, ok ${quad.ok}`)
  check('a surround file judges the front pair', quad.pair === 'FL/FR' && quad.antiphase === true)
  check('the surround fold comes from the layout downmix', quad.monoFoldPeakDbfs > -120 && quad.monoFoldPeakDbfs < 0, String(quad.monoFoldPeakDbfs))
  check('the surround summary names the scope', /FL\/FR/.test(quad.summary), quad.summary)

  // A channel count outside the WAVE layout table still gets an answer.
  const three = verifyPhase([left, left, sine(frames, 300, -12)])
  check('an unsupported channel count falls back to ch1/ch2', three.pair === 'ch1/ch2' && three.ok === true)

  check('mono has no phase report', verifyPhase([left]) === null)
  const empty = verifyPhase([new Float32Array(0), new Float32Array(0)])
  check('an empty stereo file does not crash', empty.correlation === null && empty.monoLossDb === 0 && empty.ok === true)

  // A denormal-level antiphase pair cancels exactly to zero. The loss must read
  // the cap (not 0 dB from a difference of two floored readings), otherwise the
  // correlation check would say "antiphase" while the fold check said "no loss".
  const tiny = sine(frames, 440, -300)
  const denormal = verifyPhase([tiny, tiny.map((value) => -value)])
  console.log(`  denormal antiphase: corr ${denormal.correlation}, loss ${denormal.monoLossDb} dB, fold check ok ${denormal.checks[1].ok}`)
  check('exact cancellation reports the full loss cap', denormal.monoLossDb === 120, String(denormal.monoLossDb))
  check('the fold check agrees with the correlation check', denormal.checks[1].ok === false && denormal.ok === false)

  throws('a non-array channel list is rejected', () => verifyPhase('stereo'), /channel/)
}

/* -------------------------------------------------------- cue sync ---- */

console.log('\n-- 4. cue sync and timeline coherence --')
{
  const onTarget = verifyCueSync([
    { index: 0, name: 'hit', src: 'a.wav', at: 0, expectAt: 0, durationSeconds: 0.3 },
    { index: 1, src: 'b.wav', at: 1, expectAt: 1, durationSeconds: 0.4 }
  ])
  console.log(`  on target: ok ${onTarget.ok}, max ${onTarget.maxDeviationSeconds}s | ${onTarget.summary}`)
  check('cues on their targets pass', onTarget.ok === true && onTarget.verdict === 'ok')
  check('cue times come back with zero deviation', onTarget.cues.every((entry) => entry.deviationSeconds === 0 && entry.level === 'ok'))
  check('a target-bearing sheet says so', onTarget.hasTargets === true && onTarget.maxDeviationSeconds === 0)
  check('the default tolerance is 50 ms', onTarget.toleranceSeconds === 0.05)

  const slightlyLate = verifyCueSync([{ at: 1.08, expectAt: 1 }])
  console.log(`  +80ms: dev ${slightlyLate.cues[0].deviationSeconds}s, level ${slightlyLate.cues[0].level}, verdict ${slightlyLate.verdict} | ${slightlyLate.checks.at(-1).detail}`)
  near('a deviation is signed and in seconds', slightlyLate.cues[0].deviationSeconds, 0.08, 0.0005)
  check('80 ms is a warning', slightlyLate.cues[0].level === 'warn' && slightlyLate.ok === false && slightlyLate.verdict === 'warn')
  check('late cues are counted', slightlyLate.late === 1 && slightlyLate.early === 0)

  const veryLate = verifyCueSync([{ at: 1.25, expectAt: 1 }])
  console.log(`  +250ms: dev ${veryLate.cues[0].deviationSeconds}s, level ${veryLate.cues[0].level}, verdict ${veryLate.verdict}`)
  check('250 ms is an error, not a warning', veryLate.cues[0].level === 'error' && veryLate.verdict === 'fail')
  check('the error threshold is max(4x tolerance, 0.2s)', veryLate.errorThresholdSeconds === 0.2)
  check('the instruction names the worst cue', /cue #1/.test(veryLate.checks.at(-1).detail), veryLate.checks.at(-1).detail)

  const early = verifyCueSync([{ at: 0.9, expectAt: 1 }])
  console.log(`  -100ms: dev ${early.cues[0].deviationSeconds}s, early ${early.early} | ${early.checks.at(-1).detail}`)
  check('an early cue gets a negative deviation', early.cues[0].deviationSeconds === -0.1 && early.early === 1 && early.late === 0)
  check('the detail says early', /早/.test(early.checks.at(-1).detail), early.checks.at(-1).detail)

  const loose = verifyCueSync([{ at: 1.08, expectAt: 1 }], { toleranceSeconds: 0.1 })
  console.log(`  loose tolerance: ok ${loose.ok}, threshold ${loose.errorThresholdSeconds}s`)
  check('a wider tolerance accepts the same deviation', loose.ok === true && loose.cues[0].level === 'ok')
  check('the error threshold follows the tolerance', loose.errorThresholdSeconds === 0.4)

  const worst = verifyCueSync([{ at: 0.02, expectAt: 0 }, { at: 5.4, expectAt: 5 }, { at: 9.01, expectAt: 9 }])
  console.log(`  worst of three: max ${worst.maxDeviationSeconds}s at cue #${worst.worstIndex + 1}`)
  check('the worst deviation is reported with its cue', worst.maxDeviationSeconds === 0.4 && worst.worstIndex === 1 && worst.verdict === 'fail')

  // A sheet with no target times cannot be judged for sync, only for coherence.
  const noTargets = verifyCueSync([{ at: 0, src: 'a.wav' }, { at: 1, src: 'b.wav' }])
  console.log(`  no targets: ok ${noTargets.ok}, hasTargets ${noTargets.hasTargets}, ${noTargets.summary}`)
  check('without targets there is no max deviation', noTargets.hasTargets === false && noTargets.maxDeviationSeconds === null)
  check('without targets a coherent sheet passes', noTargets.ok === true)
  check('without targets only the timeline checks run', noTargets.checks.length === 2 && noTargets.checks.every((entry) => entry.name !== 'cueTiming'))

  const unsorted = verifyCueSync([{ at: 2, src: 'a.wav' }, { at: 1, src: 'b.wav' }])
  console.log(`  unsorted: ok ${unsorted.ok} | ${unsorted.checks[0].detail}`)
  check('an out-of-order sheet is flagged', unsorted.ok === false && unsorted.checks[0].ok === false && unsorted.verdict === 'warn')
  check('the ordering detail names the cue', /第 2 条/.test(unsorted.checks[0].detail), unsorted.checks[0].detail)

  const duplicate = verifyCueSync([{ at: 1, src: 'a.wav' }, { at: 1, src: 'a.wav' }])
  console.log(`  duplicate: ok ${duplicate.ok} | ${duplicate.checks[1].detail}`)
  check('a cue scheduled twice at the same second is flagged', duplicate.ok === false && duplicate.checks[1].ok === false)
  check('the duplicate is listed in the timeline block', duplicate.timeline.duplicates.length === 1 && duplicate.timeline.duplicates[0].index === 1)
  const layered = verifyCueSync([{ at: 1, src: 'a.wav' }, { at: 1, src: 'b.wav' }])
  check('two different files at the same second are layering, not a duplicate', layered.ok === true)
  // Sub-millisecond differences are compared unrounded: 0.3 ms apart is two
  // cues, not "the same second twice", and 0.3 ms of disorder is still disorder.
  const microLayered = verifyCueSync([{ at: 1.0004, src: 'a.wav' }, { at: 1.0001, src: 'a.wav' }])
  check('a 0.3 ms offset is not a duplicate', microLayered.timeline.duplicates.length === 0 && microLayered.timeline.ordered === false,
    JSON.stringify(microLayered.timeline))

  const span = verifyCueSync([{ at: 0.5, src: 'a.wav', durationSeconds: 0.3 }, { at: 2, src: 'b.wav', durationSeconds: 1 }], { expectDuration: 4 })
  console.log(`  span: ${span.timeline.firstAt}-${span.timeline.endSeconds}s (span ${span.timeline.spanSeconds}s, target ${span.timeline.expectDuration}s)`)
  check('the timeline reports first/last/end/span', span.timeline.firstAt === 0.5 && span.timeline.lastAt === 2 &&
    span.timeline.endSeconds === 3 && span.timeline.spanSeconds === 2.5)
  check('the expected duration is carried through', span.timeline.expectDuration === 4)

  const mixed = verifyCueSync([{ at: 1, name: 'boom', expectAt: 1 }, { at: 2, name: 'bed' }])
  check('cues without a target time stay unjudged', mixed.hasTargets === true && mixed.cues[1].deviationSeconds === null && mixed.cues[1].ok === true)
  check('a cue name is carried into the report', mixed.cues[0].name === 'boom' && mixed.cues[1].name === 'bed')

  const emptySheet = verifyCueSync([])
  check('an empty cue sheet is coherent by definition', emptySheet.ok === true && emptySheet.cueCount === 0 && /没有 cue/.test(emptySheet.summary))

  // A caller that filtered its own cue list keeps its numbering.
  const filtered = verifyCueSync([{ index: 4, at: 2, expectAt: 1.9 }, { index: 7, at: 3, expectAt: 3 }])
  console.log(`  filtered sheet: indices ${filtered.cues.map((entry) => entry.index).join(',')}, worst #${filtered.worstIndex + 1}`)
  check('an explicit cue index is preserved', filtered.cues[0].index === 4 && filtered.cues[1].index === 7)
  check('the worst cue is named with its original index', filtered.worstIndex === 4 &&
    Math.abs(filtered.cues[0].deviationSeconds - 0.1) < 0.001)

  const noOptions = verifyCueSync([{ at: 1, expectAt: 1 }], null)
  check('null options mean defaults, not a crash', noOptions.ok === true && noOptions.toleranceSeconds === 0.05)
  const nullDuration = verifyCueSync([{ at: 1 }], { expectDuration: null })
  check('a null expectDuration is not coerced to 0', nullDuration.timeline.expectDuration === null)
  const roundedZero = verifyCueSync([{ at: 1, expectAt: 1.0004 }])
  check('a deviation that rounds to zero is not -0', Object.is(roundedZero.cues[0].deviationSeconds, 0) &&
    roundedZero.cues[0].level === 'ok', JSON.stringify(roundedZero.cues[0].deviationSeconds))

  throws('a non-object options bag is rejected', () => verifyCueSync([], 'loose'), /options/)
  throws('a cue without at is rejected', () => verifyCueSync([{ src: 'a.wav' }]), /cues\[0\]\.at/)
  throws('a non-finite cue time is rejected', () => verifyCueSync([{ at: Number.NaN }]), /cues\[0\]\.at/)
  throws('a numeric string cue time is rejected, not coerced', () => verifyCueSync([{ at: '1' }]), /cues\[0\]\.at/)
  throws('a non-numeric expectAt is rejected', () => verifyCueSync([{ at: 1, expectAt: '1' }]), /cues\[0\]\.expectAt/)
  throws('a non-numeric duration is rejected, not coerced', () => verifyCueSync([{ at: 1, durationSeconds: '1.5' }]), /cues\[0\]\.durationSeconds/)
  throws('a null cue is rejected', () => verifyCueSync([null]), /cues\[0\]/)
  throws('a zero tolerance is rejected', () => verifyCueSync([], { toleranceSeconds: 0 }), /toleranceSeconds/)
  throws('an over-wide tolerance is rejected', () => verifyCueSync([], { toleranceSeconds: 5 }), /toleranceSeconds/)
  throws('a non-array cue sheet is rejected', () => verifyCueSync('cues'), /array of cues/)
}

console.log(failures === 0 ? `\nOK: all ${checks} verification checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
