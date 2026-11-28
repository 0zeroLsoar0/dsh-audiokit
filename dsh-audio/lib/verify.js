/**
 * Pre-delivery verification: the three questions the measurement tools leave
 * open, answered from samples alone.
 *
 * `audio_probe` answers "what does this file measure" and `audio_loudness`
 * answers "how loud is it"; neither says whether that level is acceptable for
 * the platform the file is going to, whether the stereo pair survives a mono
 * fold, or whether a cue lands on the second it was planned for. Those are the
 * three ways a technically clean render still fails delivery, so they are
 * verified here as pure functions: samples (or already-planned cue times) in,
 * numbers and per-check verdicts out. `test/verify.mjs` pins the arithmetic on
 * synthetic signals, which is why nothing in this module touches the file
 * system, the clock or the network.
 *
 * `lib/check.js` is the only caller. Every function only *reports*: it cannot
 * "fix" a delivery, so a caller can never be surprised by a file changing
 * under it.
 *
 * Conventions shared with the rest of the plugin:
 *   - loudness is ITU-R BS.1770-4 integrated LUFS from `lib/lufs.js`, using the
 *     channel decision from `lib/multichannel.js` (LFE excluded, surround
 *     channels at +1.5 dB) — the same one `audio_loudness` and `audio_master`
 *     use, so the compliance number and the meter cannot disagree. A mono file
 *     is measured at the standard single-channel weight of 1.0, which is what
 *     ffmpeg's `ebur128` reports for the same bytes;
 *   - true peak is the 4x-oversampled dBTP estimate from the same module,
 *     measured over **every** channel of the file (LFE included), because a
 *     ceiling is a property of the file the encoder sees — `lib/master.js`
 *     verifies its ceiling the same way, so "peak under the ceiling" means the
 *     same thing in both places. Only the loudness measure excludes the LFE;
 *   - the mono fold is `lib/multichannel.js`'s downmix (LFE dropped), i.e. the
 *     mono file this plugin would itself write.
 */

import { averageChannels } from './audio.js'
import { analyzeLoudness, truePeak } from './lufs.js'
import { fitChannels, layoutFor, loudnessChannels } from './multichannel.js'

/* ------------------------------------------------------------- constants -- */

/**
 * Integrated-loudness floor used when nothing clears the BS.1770 gate. Silence
 * has no LUFS value (`analyzeLoudness` returns -Infinity, which JSON turns into
 * null), so it is reported at the gate floor with `silent: true` and stays a
 * number here, the way `audio_loudness` reports it.
 */
const LOUDNESS_GATE_FLOOR_LUFS = -70

/** Peak floor: the plugin-wide "no signal" value (matches `audio_probe`). */
const PEAK_FLOOR_DBFS = -120

/** A true-peak estimate that found nothing is reported at this floor. */
const TRUE_PEAK_FLOOR_DBTP = -120

/**
 * Ceiling for the reported mono-fold loss. -120 dBFS is the measurement floor,
 * so a fully cancelled fold reads as "at least this much"; capping at 120 dB
 * keeps a report readable instead of printing +inf.
 */
const MAX_MONO_LOSS_DB = 120

/** Correlation below this is called antiphase: a mono device loses the content. */
const ANTIPHASE_CORRELATION = -0.5

/** Peak loss above this is called cancellation rather than a pan. */
const MONO_LOSS_ALARM_DB = 6

/**
 * An integrated-loudness miss more than this many tolerances away is an error:
 * inside the tolerance the platform itself lands the file, one tolerance away
 * is a warning a human can accept, and three tolerances away is the wrong file.
 */
const LOUDNESS_ERROR_TOLERANCE_FACTOR = 3

/**
 * Default cue tolerance: 50 ms. It is one frame at 20 fps and about the point
 * where a late hit is heard as late (sound arriving early is far less audible),
 * so it is the usual "did it land on the cut" answer without splitting a frame.
 */
const DEFAULT_SYNC_TOLERANCE_SECONDS = 0.05

/** Beyond this many tolerances (and this many seconds) a cue is an error. */
const SYNC_ERROR_TOLERANCE_FACTOR = 4
const SYNC_ERROR_FLOOR_SECONDS = 0.2

/**
 * Platform delivery targets, as the platforms themselves publish them.
 *
 * The numbers are integrated LUFS (BS.1770-4) plus a true-peak ceiling: a
 * lossy encoder overshoots the sample peak, so the ceiling is what actually
 * survives encoding. `toleranceLu` is the practical landing tolerance this gate
 * accepts — the platforms normalise themselves, but not to the sample, and a
 * file that is a unit off is not worth rejecting.
 *
 * Cinema is deliberately not `-23`: a theatrical mix is played back at a fixed
 * reference level, so it is delivered much quieter and with more peak headroom
 * than broadcast (-27 LUFS / -2 dBTP is the usual theatrical reference), and a
 * broadcast-loud mix played at cinema gain is painful.
 */
export const LOUDNESS_TARGETS = Object.freeze({
  youtube: Object.freeze({ id: 'youtube', label: 'YouTube', targetLufs: -14, ceilingDbtp: -1, toleranceLu: 1 }),
  tiktok: Object.freeze({ id: 'tiktok', label: 'TikTok', targetLufs: -14, ceilingDbtp: -1, toleranceLu: 1 }),
  podcast: Object.freeze({ id: 'podcast', label: '播客', targetLufs: -16, ceilingDbtp: -1, toleranceLu: 1 }),
  broadcast: Object.freeze({ id: 'broadcast', label: '广播（EBU R128）', targetLufs: -23, ceilingDbtp: -1, toleranceLu: 1 }),
  cinema: Object.freeze({ id: 'cinema', label: '影院（theatrical）', targetLufs: -27, ceilingDbtp: -2, toleranceLu: 2 })
})

/** The target ids, in table order, for error messages and the tool schema. */
export const LOUDNESS_TARGET_IDS = Object.freeze(Object.keys(LOUDNESS_TARGETS))

/* ---------------------------------------------------------- small helpers -- */

function describeValue (value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function finiteOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** Peak magnitude in dBFS, floored at the plugin-wide -120 dB. */
function dbOf (peak) {
  return peak > 0 ? 20 * Math.log10(peak) : PEAK_FLOOR_DBFS
}

function round (value, digits = 2) {
  if (!Number.isFinite(value)) return value
  const rounded = Number(value.toFixed(digits))
  // `Number((-0.0001).toFixed(2))` is -0, which JSON flattens to 0 but
  // `Object.is(x, -0)` is false: normalise so a report never carries -0.
  return rounded === 0 ? 0 : rounded
}

/** One decimal by default, with -0 flattened so reports do not read "-0.0". */
function fmt (value, digits = 1) {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  const text = Number(value).toFixed(digits)
  return Number(text) === 0 ? '0' : text
}

function signed (value, digits = 1) {
  return `${value >= 0 ? '+' : ''}${fmt(value, digits)}`
}

function validateChannels (channels, caller) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error(`${caller} needs a non-empty array of channel buffers`)
  }
  for (const channel of channels) {
    if (channel === null || channel === undefined || typeof channel.length !== 'number') {
      throw new Error(`${caller} needs a sample buffer for every channel`)
    }
  }
}

/**
 * Resolve a target request to a frozen spec.
 *
 * Accepts a platform id (`'youtube'`) or a custom object
 * (`{ targetLufs, ceilingDbtp, toleranceLu }`) and validates the numbers: a
 * positive loudness target means clipping by construction, and a ceiling above
 * 0 dBTP is not a ceiling, so both are rejected instead of silently clamped —
 * the caller has to say what it means. A spec returned by this function (or an
 * entry of `LOUDNESS_TARGETS`) passes through unchanged.
 *
 * @param {string|object} request - platform id or `{ targetLufs, ceilingDbtp?, toleranceLu?, label? }`.
 * @returns {{ id: string, label: string, targetLufs: number, ceilingDbtp: number, toleranceLu: number }} frozen spec.
 */
export function resolveLoudnessTarget (request) {
  if (typeof request === 'string') {
    const id = request.trim().toLowerCase()
    const known = LOUDNESS_TARGETS[id]
    if (known === undefined) {
      throw new Error(`unknown loudness target ${describeValue(request)}; known targets are ${LOUDNESS_TARGET_IDS.join(', ')}`)
    }
    return known
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`loudness target must be a platform id (${LOUDNESS_TARGET_IDS.join(', ')}) or an object { targetLufs, ceilingDbtp }, got ${describeValue(request)}`)
  }
  for (const known of Object.values(LOUDNESS_TARGETS)) if (known === request) return known

  // Numbers only: `Number(null)`, `Number('')` and `Number([])` are all 0,
  // which happens to be a legal loudness/ceiling boundary — silently accepting
  // a null as "-0 LUFS / 0 dBTP" would be a target nobody asked for.
  const targetLufs = request.targetLufs
  if (typeof targetLufs !== 'number' || !Number.isFinite(targetLufs) || targetLufs < -60 || targetLufs > 0) {
    throw new Error(`loudnessTarget.targetLufs must be a finite number between -60 and 0, got ${describeValue(targetLufs)}`)
  }
  const ceilingDbtp = request.ceilingDbtp === undefined ? -1 : request.ceilingDbtp
  if (typeof ceilingDbtp !== 'number' || !Number.isFinite(ceilingDbtp) || ceilingDbtp < -20 || ceilingDbtp > 0) {
    throw new Error(`loudnessTarget.ceilingDbtp must be a finite number between -20 and 0, got ${describeValue(request.ceilingDbtp)}`)
  }
  const toleranceLu = request.toleranceLu === undefined ? 1 : request.toleranceLu
  if (typeof toleranceLu !== 'number' || !Number.isFinite(toleranceLu) || toleranceLu <= 0 || toleranceLu > 6) {
    throw new Error(`loudnessTarget.toleranceLu must be a finite number in (0, 6], got ${describeValue(request.toleranceLu)}`)
  }
  const label = typeof request.label === 'string' && request.label.trim() !== ''
    ? request.label.trim()
    : '自定义目标'
  return Object.freeze({ id: 'custom', label, targetLufs, ceilingDbtp, toleranceLu })
}

/* ---------------------------------------------------- 1. loudness compliance -- */

/**
 * The channels and weights a BS.1770 measurement may use.
 *
 * The layout decision (LFE excluded, surrounds weighted) belongs to
 * `lib/multichannel.js` and is reused as-is for the standard channel counts.
 * A count outside the WAVE layout table (3/5/7 channels — files this plugin
 * never writes but can be handed) has no defined weighting, so it is measured
 * equally instead of refusing to judge it at all.
 *
 * @param {Float32Array[]} channels - channel list in WAVE order.
 * @returns {{ measured: Float32Array[], weights: number[], lfeExcluded: boolean }}
 */
function meteredChannels (channels) {
  try {
    const layout = loudnessChannels(channels)
    return { measured: layout.measured, weights: layout.weights, lfeExcluded: layout.lfeExcluded }
  } catch {
    return { measured: channels, weights: channels.map(() => 1), lfeExcluded: false }
  }
}

/**
 * The file's true peak: the worst channel wins, every channel counts.
 *
 * The ceiling a platform enforces is about the encoded file, so an LFE that
 * peaks above it is an over-ceiling file even though BS.1770 leaves LFE out of
 * the loudness measure (it plays up to 10 dB louder than its samples say, which
 * is exactly why it must not be *silent* in the peak check). This is the same
 * rule `lib/master.js` applies to its limiter ceiling.
 *
 * @param {Float32Array[]} channels - every channel of the file.
 * @param {number} rate - sample rate in Hz.
 * @param {object} analysis - the `analyzeLoudness` result for the metered
 *   (non-LFE) channels.
 * @returns {number} the file's true peak in dBTP.
 */
function fileTruePeak (channels, rate, analysis) {
  // Without an LFE the meter saw every channel, so its number is the file's.
  // A channel count outside the WAVE layout table is measured equally, i.e.
  // also in full.
  let hasLfe = false
  try {
    hasLfe = layoutFor(channels.length).hasLfe
  } catch {
    hasLfe = false
  }
  if (!hasLfe) return finiteOr(analysis.truePeakDbtp, TRUE_PEAK_FLOOR_DBTP)
  let worst = Number.NEGATIVE_INFINITY
  for (const channel of channels) {
    const peak = truePeak(channel, rate)
    if (peak > worst) worst = peak
  }
  // The meter rounds its reading to 3 decimals; do the same here so a surround
  // file's number and a stereo file's number are reported at the same precision.
  return round(finiteOr(worst, TRUE_PEAK_FLOOR_DBTP), 3)
}

/**
 * Judge one file's loudness against a delivery target.
 *
 * Reports the measured numbers, both gaps (loudness and true peak) and an
 * advisory gain. It never applies that gain: normalising is `audio_master`'s
 * or `audio_loudness`'s job, and a quality gate that quietly rewrites the file
 * it was asked to check is not a gate.
 *
 * @param {Float32Array[]} channels - the file's channels, WAVE order.
 * @param {number} sampleRate - Hz.
 * @param {string|object} target - platform id or custom `{ targetLufs, ceilingDbtp, toleranceLu }`.
 * @returns {object} compliance report: `ok`, `verdict`, `target`, `measured`,
 *   `lufsDelta`, `suggestedGainDb`, `peakHeadroomDbtp`, `peakOverDbtp`,
 *   `checks`, `summary`.
 */
export function verifyLoudness (channels, sampleRate, target) {
  validateChannels(channels, 'verifyLoudness')
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error(`verifyLoudness needs a sample rate between 8000 and 192000 Hz, got ${describeValue(sampleRate)}`)
  }
  const spec = resolveLoudnessTarget(target)
  const metered = meteredChannels(channels)
  const analysis = analyzeLoudness(metered.measured[0], rate, {
    channels: metered.measured,
    weights: metered.weights
  })

  const silent = !Number.isFinite(analysis.integratedLufs)
  const lufs = finiteOr(analysis.integratedLufs, LOUDNESS_GATE_FLOOR_LUFS)
  // Loudness excludes the LFE (BS.1770); the peak ceiling does not (the file is
  // as hot as its hottest channel, LFE included — see fileTruePeak).
  const truePeakDbtp = fileTruePeak(channels, rate, analysis)
  const lufsDelta = round(lufs - spec.targetLufs, 2)
  const peakOverDbtp = Math.max(0, round(truePeakDbtp - spec.ceilingDbtp, 2))
  const loudnessOk = Math.abs(lufsDelta) <= spec.toleranceLu
  const peakOk = truePeakDbtp <= spec.ceilingDbtp
  const loudnessLevel = loudnessOk
    ? 'ok'
    : Math.abs(lufsDelta) > spec.toleranceLu * LOUDNESS_ERROR_TOLERANCE_FACTOR ? 'error' : 'warn'

  const loudnessDetail = silent
    ? `文件是静音的（积分响度低于 ${LOUDNESS_GATE_FLOOR_LUFS} LUFS 门限），达不到 ${spec.label} 目标 ${fmt(spec.targetLufs)} LUFS / ≤ ${fmt(spec.ceilingDbtp)} dBTP`
    : loudnessOk
      ? `${spec.label} 目标 ${fmt(spec.targetLufs)} LUFS：实测 ${fmt(lufs)} LUFS，在 ±${fmt(spec.toleranceLu)} LU 容差内`
      : `${spec.label} 目标 ${fmt(spec.targetLufs)} LUFS：实测 ${fmt(lufs)} LUFS（比目标${lufsDelta > 0 ? '响' : '轻'} ${fmt(Math.abs(lufsDelta))} LU，容差 ±${fmt(spec.toleranceLu)} LU）`
  const peakDetail = peakOk
    ? `真峰值 ${fmt(truePeakDbtp)} dBTP，在上限 ${fmt(spec.ceilingDbtp)} dBTP 内`
    : `真峰值 ${fmt(truePeakDbtp)} dBTP，超 ${fmt(spec.ceilingDbtp)} dBTP 上限 ${fmt(peakOverDbtp)} dB`

  const checks = [
    { name: 'integratedLoudness', ok: loudnessOk, level: loudnessLevel, detail: loudnessDetail },
    { name: 'truePeak', ok: peakOk, level: peakOk ? 'ok' : 'error', detail: peakDetail }
  ]
  const verdict = checks.some((check) => check.level === 'error')
    ? 'fail'
    : checks.some((check) => check.level === 'warn') ? 'warn' : 'ok'
  // No signal means no gain to plan: a "-70 LUFS" reading is the gate floor,
  // not a level, so the advisory numbers are withheld rather than derived from
  // it (a "+56 dB" suggestion for a silent file would be an invented answer).
  const suggestedGainDb = silent ? null : round(spec.targetLufs - lufs, 2)
  // State only the facts that explain a verdict: a compliant file does not need
  // a "+0.0 LU" parenthetical, and a file that only missed the peak ceiling does
  // not need to be told its loudness was fine to the tenth of a LU.
  const facts = []
  if (silent) facts.push(`实测静音（低于 ${LOUDNESS_GATE_FLOOR_LUFS} LUFS 门限）`)
  else if (loudnessOk) facts.push(`实测 ${fmt(lufs)} LUFS`)
  else facts.push(`实测 ${fmt(lufs)} LUFS（比目标${lufsDelta > 0 ? '响' : '轻'} ${fmt(Math.abs(lufsDelta))} LU）`)
  facts.push(peakOverDbtp > 0
    ? `真峰值 ${fmt(truePeakDbtp)} dBTP（超上限 ${fmt(peakOverDbtp)} dB）`
    : `真峰值 ${fmt(truePeakDbtp)} dBTP`)
  const summary = `${spec.label} ${fmt(spec.targetLufs)} LUFS / ≤ ${fmt(spec.ceilingDbtp)} dBTP：${facts.join('、')}${loudnessOk && peakOk ? '，合规' : ''}${loudnessOk || silent ? '' : `；按目标需 ${signed(suggestedGainDb)} dB 增益（仅建议，不改文件）`}`

  return {
    ok: loudnessOk && peakOk,
    verdict,
    target: { ...spec },
    measured: {
      lufs,
      truePeakDbtp,
      shortTermMaxLufs: finiteOr(analysis.shortTermMaxLufs, LOUDNESS_GATE_FLOOR_LUFS),
      loudnessRangeLu: finiteOr(analysis.loudnessRangeLu, 0),
      channelCount: channels.length,
      loudnessChannels: metered.measured.length,
      lfeExcluded: metered.lfeExcluded,
      silent
    },
    lufsDelta,
    suggestedGainDb,
    peakHeadroomDbtp: silent ? null : round(spec.ceilingDbtp - truePeakDbtp, 2),
    peakOverDbtp,
    checks,
    summary
  }
}

/* ------------------------------------------------- 2. phase / mono compatibility -- */

/** The front pair's channel names, for the report ("L/R", "FL/FR"). */
function pairLabel (channelCount) {
  try {
    const layout = layoutFor(channelCount)
    return `${layout.names[0]}/${layout.names[1]}`
  } catch {
    return 'ch1/ch2'
  }
}

/** Peak magnitude of a mono buffer. */
function peakOf (samples) {
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index])
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/**
 * The mono fold the plugin itself would write: the layout downmix (LFE dropped)
 * for the standard channel counts, an equal-weight average otherwise.
 * @param {Float32Array[]} channels - channel list.
 * @returns {Float32Array} one mono buffer.
 */
function monoFoldOf (channels) {
  try {
    return fitChannels(channels, 1)[0]
  } catch {
    return averageChannels(channels)
  }
}

/**
 * Phase and mono-compatibility of the front pair (L/R, or FL/FR in a surround
 * file). Only the first two channels are judged: every other channel of a
 * surround mix folds into mono additively and cannot cancel the pair out.
 *
 * Two numbers, because they fail differently:
 *
 * - `correlation` is the classic phase-meter value: Pearson correlation of L
 *   and R over the whole file. Identical channels read +1, an antiphase pair
 *   reads -1, uncorrelated content reads about 0. Below -0.5 the pair is called
 *   out (`antiphase`): stereo playback still works, a mono device loses it.
 *   A channel with no energy has no correlation to report (`null`).
 * - `monoLossDb` is how much peak level the mono fold loses to cancellation,
 *   measured against the *unscaled* L+R on purpose. A 0.5-averaged fold loses
 *   6.0 dB on a hard-panned element for free (the pan law), so measuring
 *   against it would fire the alarm on any panned cue; against L+R a hard pan
 *   reads 0 dB and the > 6 dB alarm means "content cancelled". The loss is a
 *   peak ratio, so a fold that cancels exactly to zero reads the full 120 dB
 *   (the cap) instead of a meaningless "-120 dBFS minus -120 dBFS" 0 dB.
 *
 * `monoFoldPeakDbfs` is the informational number: the peak of the mono file a
 * mono device or a mono export would actually get.
 *
 * @param {Float32Array[]} channels - the file's channels, WAVE order.
 * @returns {object|null} phase report, or `null` for a mono file (nothing to
 *   compare).
 */
export function verifyPhase (channels) {
  validateChannels(channels, 'verifyPhase')
  if (channels.length < 2) return null
  const frames = Math.min(...channels.map((channel) => channel.length))
  const left = channels[0]
  const right = channels[1]
  let sumLeftRight = 0
  let sumLeftSquares = 0
  let sumRightSquares = 0
  let pairPeak = 0
  let sumPeak = 0
  for (let index = 0; index < frames; index += 1) {
    const l = left[index]
    const r = right[index]
    sumLeftRight += l * r
    sumLeftSquares += l * l
    sumRightSquares += r * r
    const leftMagnitude = l < 0 ? -l : l
    const rightMagnitude = r < 0 ? -r : r
    const magnitude = leftMagnitude > rightMagnitude ? leftMagnitude : rightMagnitude
    if (magnitude > pairPeak) pairPeak = magnitude
    const summed = Math.abs(l + r)
    if (summed > sumPeak) sumPeak = summed
  }
  const correlation = sumLeftSquares > 0 && sumRightSquares > 0
    ? round(sumLeftRight / Math.sqrt(sumLeftSquares * sumRightSquares), 3)
    : null
  const antiphase = correlation !== null && correlation < ANTIPHASE_CORRELATION
  const pairPeakDbfs = dbOf(pairPeak)
  // The loss is the ratio between the pair's peak and the *unscaled* sum, not a
  // difference of floored dB values: a difference would read 0 dB for a pair
  // whose fold is exactly zero but whose own peak is below -120 dBFS (both
  // sides then report the floor), i.e. the check would call a total cancellation
  // "no loss" while the correlation check calls it antiphase. A zero sum is the
  // full 120 dB of cancellation, capped so the report stays a number.
  const monoLossDb = pairPeak > 0
    ? sumPeak > 0
      ? round(Math.min(MAX_MONO_LOSS_DB, Math.max(0, 20 * Math.log10(pairPeak / sumPeak))), 2)
      : MAX_MONO_LOSS_DB
    : 0
  const monoFoldPeakDbfs = dbOf(peakOf(monoFoldOf(channels)))
  const pair = pairLabel(channels.length)
  const monoLossOk = monoLossDb <= MONO_LOSS_ALARM_DB

  const correlationDetail = correlation === null
    ? `${pair} 之一没有能量，相关性没有定义（静音、空文件或非有限采样）`
    : antiphase
      ? `左右声道相关性 ${fmt(correlation, 2)} < ${ANTIPHASE_CORRELATION}，反相：单声道设备会丢失这部分内容`
      : `左右声道相关性 ${fmt(correlation, 2)}`
  const monoLossDetail = monoLossOk
    ? `单声道折叠峰值损失 ${fmt(monoLossDb, 1)} dB（≤ ${MONO_LOSS_ALARM_DB} dB）`
    : `单声道折叠峰值损失 ${fmt(monoLossDb, 1)} dB（> ${MONO_LOSS_ALARM_DB} dB，反相内容在折叠时抵消）`

  const checks = [
    { name: 'correlation', ok: !antiphase, level: antiphase ? 'warn' : 'ok', detail: correlationDetail },
    { name: 'monoFold', ok: monoLossOk, level: monoLossOk ? 'ok' : 'warn', detail: monoLossDetail }
  ]
  const ok = checks.every((check) => check.ok)
  const scope = channels.length > 2 ? `（判定 ${pair} 前两个声道）` : ''
  const summary = ok
    ? `${pair} 相关性 ${correlation === null ? 'n/a' : fmt(correlation, 2)}、单声道折叠损失 ${fmt(monoLossDb, 1)} dB${scope}`
    : `${pair} 相关性 ${correlation === null ? 'n/a' : fmt(correlation, 2)}、单声道折叠损失 ${fmt(monoLossDb, 1)} dB${scope}：${antiphase ? '反相' : '单声道不兼容'}`

  return {
    ok,
    verdict: ok ? 'ok' : 'warn',
    channelCount: channels.length,
    pair,
    correlation,
    antiphase,
    pairPeakDbfs: round(pairPeakDbfs),
    monoFoldPeakDbfs: round(monoFoldPeakDbfs),
    monoLossDb,
    checks,
    summary
  }
}

/* -------------------------------------------------- 3. cue / picture sync -- */

/** Signed seconds, i.e. "how late", as a human-facing phrase. */
function lateLabel (deviationSeconds) {
  if (deviationSeconds === 0) return '准点'
  return deviationSeconds > 0
    ? `晚 ${fmt(Math.abs(deviationSeconds), 3)}s`
    : `早 ${fmt(Math.abs(deviationSeconds), 3)}s`
}

/**
 * Check a cue sheet against the times it was planned for, or just against
 * itself when no target times were given.
 *
 * With targets (`cues[].expectAt`, or a parallel `targets` array — per-cue
 * values win when both are present) every cue is compared with the second it
 * should fire: the deviation is signed (`at - expectAt`; positive = late),
 * within `toleranceSeconds` (default 50 ms) passes, beyond it warns, and beyond
 * `max(4x tolerance, 200 ms)` is an error because a hit that far off the picture
 * is heard as a mistake. The report keeps every cue's number plus the worst one.
 *
 * Without targets there is nothing to compare against, so the block only checks
 * that the timeline is coherent — ascending order and no cue scheduled twice at
 * the same second — and reports its span. Overlapping cues are *not* flagged:
 * layered sound design overlaps by design.
 *
 * @param {object[]} cues - `[{ index?, name?, src?, at, expectAt?, durationSeconds? }]`.
 *   `index` is a 0-based cue position when the caller keeps its own numbering
 *   (a filtered sheet); it defaults to the array position and is what
 *   `worstIndex` reports.
 * @param {object} [options] - `{ toleranceSeconds?, expectDuration? }`; `null` means defaults.
 * @returns {object} sync report: `ok`, `verdict`, `cueCount`, `hasTargets`,
 *   `toleranceSeconds`, `cues`, `maxDeviationSeconds`, `worstIndex`, `late`,
 *   `early`, `timeline`, `checks`, `summary`.
 */
export function verifyCueSync (cues, options) {
  if (!Array.isArray(cues)) throw new Error(`verifyCueSync needs an array of cues, got ${describeValue(cues)}`)
  // `options = {}` in the signature would be bypassed by an explicit null, and
  // "null" is how a caller writes "no options" often enough to matter.
  const settings = options === undefined || options === null ? {} : options
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`verifyCueSync options must be an object { toleranceSeconds, expectDuration }, got ${describeValue(options)}`)
  }
  const toleranceSeconds = settings.toleranceSeconds === undefined
    ? DEFAULT_SYNC_TOLERANCE_SECONDS
    : settings.toleranceSeconds
  if (typeof toleranceSeconds !== 'number' || !Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0 || toleranceSeconds > 2) {
    throw new Error(`toleranceSeconds must be a finite number in (0, 2], got ${describeValue(settings.toleranceSeconds)}`)
  }
  const expectDuration = typeof settings.expectDuration === 'number' && Number.isFinite(settings.expectDuration)
    ? settings.expectDuration
    : null
  const errorThreshold = Math.max(SYNC_ERROR_FLOOR_SECONDS, toleranceSeconds * SYNC_ERROR_TOLERANCE_FACTOR)

  const entries = []
  // Unrounded times for the coherence checks: two layered hits 0.3 ms apart are
  // two cues, not "the same second twice", and a 0.3 ms disorder is still a
  // disorder. Only the report rounds.
  const exact = []
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) {
      throw new Error(`cues[${index}] must be an object { at, expectAt }, got ${describeValue(cue)}`)
    }
    // Times are taken as numbers, not coerced: this layer is the last check
    // before delivery, and "1" is a bug in the caller, not a cue at 1 s.
    if (typeof cue.at !== 'number' || !Number.isFinite(cue.at)) {
      throw new Error(`cues[${index}].at must be a finite number, got ${describeValue(cue.at)}`)
    }
    const at = cue.at
    const hasExpect = cue.expectAt !== undefined && cue.expectAt !== null
    if (hasExpect && (typeof cue.expectAt !== 'number' || !Number.isFinite(cue.expectAt))) {
      throw new Error(`cues[${index}].expectAt must be a finite number, got ${describeValue(cue.expectAt)}`)
    }
    const hasDuration = cue.durationSeconds !== undefined && cue.durationSeconds !== null
    if (hasDuration && (typeof cue.durationSeconds !== 'number' || !Number.isFinite(cue.durationSeconds))) {
      throw new Error(`cues[${index}].durationSeconds must be a finite number, got ${describeValue(cue.durationSeconds)}`)
    }
    const expectAt = hasExpect ? cue.expectAt : null
    const deviationSeconds = expectAt === null ? null : round(at - expectAt, 3)
    const magnitude = deviationSeconds === null ? 0 : Math.abs(deviationSeconds)
    const entryIndex = typeof cue.index === 'number' && Number.isFinite(cue.index) ? cue.index : index
    const src = typeof cue.src === 'string' && cue.src !== '' ? cue.src : null
    exact.push({ index: entryIndex, at, src })
    entries.push({
      // An explicit index wins: a caller that filtered its own cue list (as
      // `audio_check` does for an unreadable cue) must not have its remaining
      // cues renumbered in the report.
      index: entryIndex,
      name: typeof cue.name === 'string' && cue.name.trim() !== '' ? cue.name.trim() : null,
      src,
      at: round(at, 3),
      expectAt: expectAt === null ? null : round(expectAt, 3),
      durationSeconds: hasDuration && cue.durationSeconds > 0 ? round(cue.durationSeconds, 3) : null,
      deviationSeconds,
      ok: deviationSeconds === null || magnitude <= toleranceSeconds,
      level: deviationSeconds === null || magnitude <= toleranceSeconds
        ? 'ok'
        : magnitude > errorThreshold ? 'error' : 'warn'
    })
  }

  const timed = entries.filter((entry) => entry.expectAt !== null)
  const hasTargets = timed.length > 0
  const late = timed.filter((entry) => entry.deviationSeconds > toleranceSeconds).length
  const early = timed.filter((entry) => entry.deviationSeconds < -toleranceSeconds).length
  let worst = null
  for (const entry of timed) {
    if (worst === null || Math.abs(entry.deviationSeconds) > Math.abs(worst.deviationSeconds)) worst = entry
  }

  const ordered = exact.every((entry, index) => index === 0 || entry.at >= exact[index - 1].at)
  const duplicates = []
  const seen = new Map()
  for (const entry of exact) {
    if (entry.src === null) continue
    const key = `${entry.at}|${entry.src}`
    if (seen.has(key)) duplicates.push({ index: entry.index, firstIndex: seen.get(key), at: round(entry.at, 3), src: entry.src })
    else seen.set(key, entry.index)
  }
  const firstAt = entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.at))
  const lastAt = entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.at))
  let endSeconds = lastAt
  for (const entry of entries) {
    if (entry.durationSeconds === null) continue
    const end = entry.at + entry.durationSeconds
    if (endSeconds === null || end > endSeconds) endSeconds = end
  }

  const checks = [
    {
      name: 'timelineOrder',
      ok: ordered,
      level: ordered ? 'ok' : 'warn',
      detail: ordered
        ? `${entries.length} 条 cue 按时间升序`
        : `cue 列表不是按时间升序（第 ${entries.findIndex((entry, index) => index > 0 && entry.at < entries[index - 1].at) + 1} 条比前一条早），播放顺序可能和编排不一致`
    },
    {
      name: 'duplicateCue',
      ok: duplicates.length === 0,
      level: duplicates.length === 0 ? 'ok' : 'warn',
      detail: duplicates.length === 0
        ? '同一时间没有重复的 cue'
        : `${duplicates.length} 处 cue 在同一秒重复了同一个文件（会叠成两倍电平）：${duplicates.map((entry) => `#${entry.index + 1} 与 #${entry.firstIndex + 1} 都在 ${fmt(entry.at, 3)}s`).join('、')}`
    }
  ]
  if (hasTargets) {
    const worstMagnitude = worst === null ? 0 : Math.abs(worst.deviationSeconds)
    checks.push({
      name: 'cueTiming',
      ok: worstMagnitude <= toleranceSeconds,
      level: worstMagnitude <= toleranceSeconds ? 'ok' : worstMagnitude > errorThreshold ? 'error' : 'warn',
      detail: worstMagnitude <= toleranceSeconds
        ? `${timed.length} 条有目标时间的 cue 都在 ±${fmt(toleranceSeconds, 3)}s 内（最大偏差 ${fmt(worstMagnitude, 3)}s）`
        : `最大偏差 ${fmt(worstMagnitude, 3)}s（cue #${worst.index + 1}${worst.name === null ? '' : ` "${worst.name}"`}，${lateLabel(worst.deviationSeconds)}），容差 ±${fmt(toleranceSeconds, 3)}s，${late} 条偏晚 / ${early} 条偏早`
    })
  }

  const verdict = checks.some((check) => check.level === 'error')
    ? 'fail'
    : checks.some((check) => check.level === 'warn') ? 'warn' : 'ok'
  const timelineText = entries.length === 0
    ? '没有 cue'
    : `${fmt(firstAt, 3)}–${fmt(endSeconds ?? lastAt, 3)}s${ordered ? '' : '，顺序错乱'}${duplicates.length > 0 ? `，${duplicates.length} 处重复` : ''}`
  const summary = hasTargets
    ? `cue 同步：${entries.length} 条中 ${timed.length} 条有目标时间，最大偏差 ${fmt(worst === null ? 0 : Math.abs(worst.deviationSeconds), 3)}s（cue #${(worst?.index ?? 0) + 1}，${lateLabel(worst?.deviationSeconds ?? 0)}），容差 ±${fmt(toleranceSeconds, 3)}s`
    : `cue 时间轴：${timelineText}`

  return {
    ok: checks.every((check) => check.ok),
    verdict,
    cueCount: entries.length,
    hasTargets,
    toleranceSeconds,
    errorThresholdSeconds: round(errorThreshold, 3),
    cues: entries,
    maxDeviationSeconds: worst === null ? null : round(Math.abs(worst.deviationSeconds), 3),
    worstIndex: worst === null ? null : worst.index,
    late,
    early,
    timeline: {
      firstAt: firstAt === null ? null : round(firstAt, 3),
      lastAt: lastAt === null ? null : round(lastAt, 3),
      endSeconds: endSeconds === null ? null : round(endSeconds, 3),
      spanSeconds: firstAt === null || endSeconds === null ? null : round(endSeconds - firstAt, 3),
      ordered,
      duplicates,
      expectDuration
    },
    checks,
    summary
  }
}
