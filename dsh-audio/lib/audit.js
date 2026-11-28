/**
 * Three-way delivery audit: narration wav ↔ subtitle srt ↔ mouth track.
 *
 * A talking deliverable has three descriptions of the same timeline, written by
 * three different passes: the audio the voice provider returned, the subtitle
 * file built from its timestamps (or hand-edited afterwards), and the per-frame
 * mouth track generated from the audio. Nothing in the pipeline checks them
 * against each other, so the classic failures — a subtitle shifted by 200 ms, a
 * line whose cue was deleted, a caption over silence, a mouth that opens during
 * a pause, a one-frame viseme flicker — reach the page and are only visible to a
 * human watching it.
 *
 * This module is the automated reading of that page. Each of the three pairs is
 * compared against the same audio-derived speech map, so a defect shows up in
 * every pair that can see it instead of only where it originated:
 *
 *   - subtitle vs audio → cue over silence, speech with no cue, cue start off
 *     the first onset under it by more than `maxDriftMs`;
 *   - mouth vs audio → speech the mouth never covers, mouth open over silence,
 *     one-frame label chatter;
 *   - subtitle vs mouth → a caption whose interval has no open-mouth frame.
 *
 * Why it is built this way:
 *   - The audio is reduced to a *speech map* once (10 ms blocks, activity
 *     relative to the loudest block), and every comparison reads that map. Three
 *     independent detectors would disagree at the boundaries and report the same
 *     defect with three different numbers.
 *   - Nothing is auto-fixed. A gate that rewrites what it was asked to inspect
 *     cannot be used as a gate.
 *   - Every rule is a pure function of the inputs and the thresholds are named
 *     constants at the top, so the same files always produce byte-identical
 *     JSON: a report can be diffed between two takes and asserted in a test.
 *   - A combination that cannot run (no srt, no mouth track, silent audio) is
 *     reported as `skipped` with a reason rather than failing the call or
 *     inventing a clean verdict.
 *
 * The returned object is `{ ok, issues, summary, worstDriftMs, skipped,
 * checksRun, checks, metrics }`: `issues` is the flat defect list the caller acts
 * on, `checks` keeps the per-pair status (including `skipped`), `checksRun` says
 * how many pairs actually ran, `metrics` keeps the numbers the report was built
 * from, and `summary` is the one-line Chinese verdict. `ok` means *verified*: no
 * defect **and** at least one pair compared, so an unaudited call cannot gate a
 * delivery through.
 */

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { clamp } from './dsp.js'
import { peakEnvelope, readChannels, resolvePath } from './audio.js'
import { VISEMES } from './lipsync.js'

/** The three pairwise checks this module can run, in report order. */
export const AUDIT_CHECKS = Object.freeze(['subtitle-vs-audio', 'viseme-vs-audio', 'subtitle-vs-viseme'])

/** Chinese names for the check ids, so the tool and the tests spell them once. */
export const CHECK_LABELS = Object.freeze({
  'subtitle-vs-audio': '字幕↔音频',
  'viseme-vs-audio': '口型↔音频',
  'subtitle-vs-viseme': '字幕↔口型'
})

/** Default tolerance for a subtitle start against the first onset under it. */
export const DEFAULT_MAX_DRIFT_MS = 80

/** A tolerance of several seconds is no tolerance at all; clamp the input. */
const MAX_MAX_DRIFT_MS = 5000

/**
 * Length of one speech-map block. 10 ms is fine enough for an 80 ms drift
 * tolerance and coarse enough that a five-minute narration costs 30 000 blocks
 * instead of 13 million samples in the comparisons.
 */
const AUDIT_BLOCK_SECONDS = 0.01

/**
 * A block is "speech" when its RMS is at least this fraction of the loudest
 * block. Relative rather than absolute because TTS arrives at wildly different
 * levels, with `ACTIVE_FLOOR_RMS` only stopping a file whose loudest block is
 * itself near-silent (a digital-silence file) from declaring speech.
 */
const ACTIVE_PEAK_RATIO = 0.03
const ACTIVE_FLOOR_RMS = 1e-4

/**
 * Gaps shorter than this are bridged when active blocks are merged into speech
 * segments: a stop closure inside a word is 20-40 ms of near-silence and must
 * not split one line into two "uncovered" spans.
 */
const SEGMENT_BRIDGE_SECONDS = 0.06

/**
 * A gap between speech and its captions is only reported once it is long enough
 * to hear: below ~150 ms it is frame rounding, not a missing line.
 */
const MIN_MISSING_SECONDS = 0.15

/** Mouth/speech coverage: below WARN it is a defect, below ERROR it is broken. */
const COVERAGE_WARN = 0.85
const COVERAGE_ERROR = 0.5

/**
 * Open-mouth frames over silence are reported by the longest *contiguous* run,
 * not by the total: a correct mouth track legitimately holds a shape for one
 * frame past each burst boundary (jaw release and run-length smoothing), and
 * summing those single frames over a long file would flag every clean track.
 *
 * The tolerance is expressed in seconds but floored at one and a half frames,
 * because at 12 fps (which `audio_lipsync` supports) a single release frame is
 * already 83 ms: a fixed 80 ms threshold would flag every clean 12 fps track.
 * A hold that lasts 300 ms — and at least twice the release tolerance — is an
 * error rather than a warning.
 */
const SILENT_OPEN_MIN_RUN_SECONDS = 0.08
const SILENT_OPEN_RELEASE_FRAMES = 1.5
const SILENT_OPEN_ERROR_SECONDS = 0.3

/** One-frame label chatter is a warn until it is pervasive. */
const FLICKER_ERROR_COUNT = 8

/**
 * Per-kind cap on the flat issue list. A word-level subtitle set on a long
 * narration can miss hundreds of spans in one go; the report keeps the first 40
 * of each kind and folds the rest into one summary entry, so the JSON stays
 * readable without hiding that more were found.
 */
const MAX_ISSUES_PER_KIND = 40

const VISEME_SET = new Set(VISEMES)

/* --------------------------------------------------------------- helpers -- */

function roundTo (value, digits) {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

/** A time in the human text: seconds with millisecond precision, no trailing zeros. */
function fmtTime (seconds) {
  return String(roundTo(seconds, 3))
}

function fmtMs (milliseconds) {
  return String(roundTo(milliseconds, 1))
}

function percent (share) {
  return String(roundTo(share * 100, 1))
}

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function rmsDbfs (value) {
  return value > 0 ? roundTo(20 * Math.log10(value), 1) : -120
}

function makeIssue (kind, at, detail, severity) {
  return { kind, at: roundTo(Math.max(0, at), 3), detail, severity }
}

/* ------------------------------------------------------------------- srt -- */

/**
 * Parse one `HH:MM:SS,mmm` (or `MM:SS,mmm`) timecode. A single-digit millisecond
 * field is left-padded, because hand-edited SRTs write `,50` for 50 ms and the
 * naive `Number(',50')` reading would place it half a second off.
 *
 * @param {string} text - one timecode field.
 * @returns {number|null} seconds, or null when the field is not a timecode.
 */
function parseTimecode (text) {
  const value = String(text).trim()
  const long = /^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(value)
  if (long !== null) {
    return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]) + Number(long[4].padEnd(3, '0')) / 1000
  }
  const short = /^(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(value)
  if (short !== null) {
    return Number(short[1]) * 60 + Number(short[2]) + Number(short[3].padEnd(3, '0')) / 1000
  }
  return null
}

/** True when the line begins a new cue (a timing line, or an index before one). */
function looksLikeCueStart (lines, index) {
  const trimmed = String(lines[index] ?? '').trim()
  if (trimmed.includes('-->')) return true
  return /^\d+$/.test(trimmed) && String(lines[index + 1] ?? '').includes('-->')
}

/**
 * Parse a SubRip document into cues.
 *
 * The parser is deliberately tolerant of what hand-editing produces — BOM, CRLF,
 * `.` instead of `,` in the millisecond field, a missing index line, a missing
 * blank line between cues, multi-line text — and deliberately strict about what
 * it cannot represent: a block with no timing line, an unparsable timecode, or a
 * cue that ends before it starts is an error that names the line, because
 * "silently skipped" would turn a broken subtitle file into a clean audit.
 *
 * @param {string} input - the whole file content.
 * @param {string} [label='SRT'] - file name used in error messages.
 * @returns {Array<{ index: number, start: number, end: number, text: string }>}
 *   cues sorted in file order, times in seconds.
 */
export function parseSrt (input, label = 'SRT') {
  if (typeof input !== 'string') {
    throw new Error(`${label}：内容必须是字符串，收到 ${typeof input}`)
  }
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const cues = []
  let cursor = 0
  while (cursor < lines.length) {
    const trimmed = lines[cursor].trim()
    if (trimmed === '') {
      cursor += 1
      continue
    }
    let timing = null
    let timingLine = 0
    if (/^\d+$/.test(trimmed) && String(lines[cursor + 1] ?? '').includes('-->')) {
      timing = lines[cursor + 1]
      timingLine = cursor + 2
      cursor += 1
    } else if (trimmed.includes('-->')) {
      timing = trimmed
      timingLine = cursor + 1
    } else {
      throw new Error(`${label} 第 ${cursor + 1} 行既不是序号也不是时间行（"${trimmed.slice(0, 40)}"），不是合法的 SRT`)
    }
    const match = /^\s*(\S+)\s*-->\s*(\S+)/.exec(String(timing))
    const start = match === null ? null : parseTimecode(match[1])
    const end = match === null ? null : parseTimecode(match[2])
    if (start === null || end === null) {
      throw new Error(`${label} 第 ${timingLine} 行时间码不合法（"${String(timing).trim().slice(0, 40)}"），应形如 00:00:01,000 --> 00:00:02,000`)
    }
    if (end <= start) {
      throw new Error(`${label} 第 ${timingLine} 行结束时间 ${end}s 不晚于开始时间 ${start}s`)
    }
    cursor += 1
    const body = []
    while (cursor < lines.length && lines[cursor].trim() !== '' && !looksLikeCueStart(lines, cursor)) {
      body.push(lines[cursor])
      cursor += 1
    }
    cues.push({ index: cues.length + 1, start, end, text: body.join('\n').trim() })
  }
  return cues
}

/* -------------------------------------------------------- speech map ------ */

/**
 * Reduce a mono *level signal* to the speech map every comparison reads.
 *
 * `auditDelivery` passes `peakEnvelope(channels)` rather than a mono fold: a
 * fold sums the channels, so an out-of-phase stereo pair cancels to near-silence
 * and the whole file would be reported as silent. The envelope keeps the louder
 * channel's magnitude, which is what "is there speech here" means. The absolute
 * level is never used — only its ratio to the loudest block — so the rectified
 * envelope gives the same activity decisions a waveform would.
 *
 * Two products: `active`/`blockCount` (the per-block activity grid, for
 * time-weighted coverage) and `segments` (runs of activity with short gaps
 * bridged, for drift pairing and for "which line does this cue belong to").
 *
 * @param {Float32Array} samples - mono level signal (envelope or waveform).
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `blockSeconds`, `channelCount` (reported only).
 * @returns {object} speech map: levels, active grid, segments, duration.
 */
export function analyzeSpeech (samples, sampleRate, options = {}) {
  if (samples === null || typeof samples !== 'object' || typeof samples.length !== 'number') {
    throw new Error('analyzeSpeech 需要单声道样本数组')
  }
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`analyzeSpeech：采样率不合法（${String(sampleRate)}）`)
  const blockSeconds = clamp(
    Number.isFinite(options.blockSeconds) ? options.blockSeconds : AUDIT_BLOCK_SECONDS,
    0.005,
    0.05
  )
  const hop = Math.max(1, Math.round(rate * blockSeconds))
  const hopSeconds = hop / rate
  const durationSeconds = samples.length / rate
  const blockCount = Math.ceil(samples.length / hop)
  const levels = new Float64Array(blockCount)
  let peak = 0
  for (let block = 0; block < blockCount; block += 1) {
    const from = block * hop
    const to = Math.min(samples.length, from + hop)
    let sumSquares = 0
    for (let i = from; i < to; i += 1) {
      const sample = samples[i]
      sumSquares += sample * sample
    }
    const rms = to > from ? Math.sqrt(sumSquares / (to - from)) : 0
    levels[block] = rms
    if (rms > peak) peak = rms
  }

  const threshold = Math.max(peak * ACTIVE_PEAK_RATIO, ACTIVE_FLOOR_RMS)
  const active = new Uint8Array(blockCount)
  let activeBlocks = 0
  for (let block = 0; block < blockCount; block += 1) {
    if (levels[block] >= threshold) {
      active[block] = 1
      activeBlocks += 1
    }
  }

  // Merge runs of active blocks, bridging the short closures inside a word.
  const bridgeBlocks = Math.max(0, Math.round(SEGMENT_BRIDGE_SECONDS / hopSeconds))
  const segments = []
  let firstBlock = -1
  let lastBlock = -1
  const flush = () => {
    if (firstBlock < 0) return
    const start = firstBlock * hopSeconds
    const end = Math.min(durationSeconds, (lastBlock + 1) * hopSeconds)
    if (end > start) segments.push({ start, end, seconds: end - start })
    firstBlock = -1
    lastBlock = -1
  }
  for (let block = 0; block < blockCount; block += 1) {
    if (active[block] !== 1) continue
    if (firstBlock < 0) {
      firstBlock = block
      lastBlock = block
      continue
    }
    if (block - lastBlock - 1 > bridgeBlocks) {
      flush()
      firstBlock = block
    }
    lastBlock = block
  }
  flush()

  return {
    sampleRate: rate,
    channelCount: Number.isFinite(options.channelCount) ? options.channelCount : 1,
    blockSeconds: hopSeconds,
    hopSeconds,
    blockCount,
    durationSeconds,
    levels,
    active,
    activeBlocks,
    peakRms: peak,
    threshold,
    segments
  }
}

/** Seconds of active speech inside `[from, to]`, time-weighted per block. */
function activeSecondsWithin (analysis, from, to) {
  const limit = Math.min(to, analysis.durationSeconds)
  const begin = Math.max(0, from)
  if (limit <= begin || analysis.blockCount === 0) return 0
  const hopSeconds = analysis.hopSeconds
  const firstBlock = Math.max(0, Math.floor(begin / hopSeconds))
  const lastBlock = Math.min(analysis.blockCount - 1, Math.floor((limit - 1e-9) / hopSeconds))
  let total = 0
  for (let block = firstBlock; block <= lastBlock; block += 1) {
    if (analysis.active[block] !== 1) continue
    const blockStart = block * hopSeconds
    const blockEnd = Math.min(analysis.durationSeconds, blockStart + hopSeconds)
    total += Math.min(limit, blockEnd) - Math.max(begin, blockStart)
  }
  return Math.max(0, total)
}

/** True when the audio block that owns `time` is speech. */
function activeAt (analysis, time) {
  if (analysis.blockCount === 0 || time < 0 || time >= analysis.durationSeconds) return false
  const index = Math.min(analysis.blockCount - 1, Math.floor(time / analysis.hopSeconds))
  return analysis.active[index] === 1
}

/** The first speech segment that overlaps a cue, or null. */
function firstOverlappingSegment (segments, cue) {
  for (const segment of segments) {
    if (segment.end > cue.start + 1e-9 && segment.start < cue.end - 1e-9) return segment
  }
  return null
}

/** Spans of `segment` not covered by any cue, merged and time-ordered. */
function uncoveredSpans (segment, cues) {
  const overlaps = []
  for (const cue of cues) {
    const start = Math.max(cue.start, segment.start)
    const end = Math.min(cue.end, segment.end)
    if (end > start) overlaps.push({ start, end })
  }
  overlaps.sort((left, right) => left.start - right.start)
  const gaps = []
  let cursor = segment.start
  for (const span of overlaps) {
    if (span.start > cursor + 1e-9) gaps.push({ start: cursor, end: span.start, seconds: span.start - cursor })
    if (span.end > cursor) cursor = span.end
  }
  if (cursor < segment.end - 1e-9) gaps.push({ start: cursor, end: segment.end, seconds: segment.end - cursor })
  return gaps
}

/* --------------------------------------------------------- viseme track --- */

function inferFps (frames) {
  const deltas = []
  for (let index = 1; index < Math.min(frames.length, 100); index += 1) {
    const delta = frames[index].t - frames[index - 1].t
    if (delta > 0) deltas.push(delta)
  }
  if (deltas.length === 0) return 24
  deltas.sort((left, right) => left - right)
  const median = deltas[Math.floor(deltas.length / 2)]
  const fps = 1 / median
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps) : 24
}

/**
 * Normalise an external mouth track to what the audit needs: sorted `{ t,
 * viseme }` frames plus a frame rate.
 *
 * Accepts the `audio_lipsync` JSON payload (`{ fps, frames }`), a bare
 * `{ frames }` object, or a bare frame array. Labels outside the module
 * whitelist are replaced with `none` (the same safe rendering `lipsync.js`
 * uses) and counted, so one hand-edited typo cannot crash the audit; a missing
 * `frames` array or a non-numeric `t` is an error, because that track cannot be
 * placed on the timeline at all.
 *
 * @param {object|Array} payload - track payload.
 * @param {string} [label='visemes'] - source name for error messages and metrics.
 * @returns {{ fps: number, frames: Array<{t: number, viseme: string}>, leadMs: number,
 *   unknownVisemes: number, firstUnknownAt: number|null, source: string }}
 */
export function normalizeVisemeTrack (payload, label = 'visemes') {
  const raw = Array.isArray(payload) ? { frames: payload } : payload
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`口型轨 ${label} 必须是 lipsync json（{ frames: [...] }）或帧数组`)
  }
  if (!Array.isArray(raw.frames)) {
    throw new Error(`口型轨 ${label} 缺少 frames 数组（给 audio_lipsync 的 json 输出即可）`)
  }
  const frames = []
  let unknownVisemes = 0
  let firstUnknownAt = null
  for (let index = 0; index < raw.frames.length; index += 1) {
    const frame = raw.frames[index]
    if (frame === null || typeof frame !== 'object') {
      throw new Error(`口型轨 ${label} 的第 ${index} 帧不是对象（${String(frame)}）`)
    }
    // `Number(null)` and `Number('')` are both 0, so a numeric cast would quietly
    // place a broken frame at the start of the film; accept only a number or a
    // numeric string and reject everything else by type.
    const rawT = frame.t
    const t = typeof rawT === 'number' ? rawT : typeof rawT === 'string' && rawT.trim() !== '' ? Number(rawT) : NaN
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`口型轨 ${label} 的第 ${index} 帧 t 不是合法时间（${String(rawT)}）`)
    }
    let viseme = frame.viseme
    if (typeof viseme !== 'string' || !VISEME_SET.has(viseme)) {
      unknownVisemes += 1
      if (firstUnknownAt === null) firstUnknownAt = t
      viseme = 'none'
    }
    frames.push({ t, viseme })
  }
  frames.sort((left, right) => left.t - right.t)
  let fps = Number(raw.fps)
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) fps = inferFps(frames)
  fps = clamp(Math.round(fps), 1, 240)
  const leadMs = Number.isFinite(raw.leadMs) ? raw.leadMs : 0
  return { fps, frames, leadMs, unknownVisemes, firstUnknownAt, source: label }
}

/** Duration of each frame, from the next timestamp (or one nominal frame). */
function frameSpans (track) {
  const frames = track.frames
  const fallback = 1 / track.fps
  const spans = new Float64Array(frames.length)
  for (let index = 0; index < frames.length; index += 1) {
    const next = index + 1 < frames.length ? frames[index + 1].t : frames[index].t + fallback
    const span = next - frames[index].t
    spans[index] = span > 0 && span <= 1 ? span : fallback
  }
  return spans
}

/** Maximal runs of equal labels, `{ label, start, end }` with inclusive indices. */
function labelRuns (labels) {
  const runs = []
  let current = null
  for (let index = 0; index < labels.length; index += 1) {
    if (current !== null && labels[index] === current.label) {
      current.end = index
      continue
    }
    if (current !== null) runs.push(current)
    current = { label: labels[index], start: index, end: index }
  }
  if (current !== null) runs.push(current)
  return runs
}

/* --------------------------------------------------- check 1: sub vs audio -- */

/**
 * Compare subtitles with the audio speech map: a cue that lands on silence, a
 * speech span no cue covers, and a cue start that misses the first onset under
 * it by more than the tolerance.
 *
 * The pairing rule matters: a cue is compared with the *first* speech segment it
 * overlaps, because a caption starts where its first word starts. A cue that
 * overlaps no speech is not paired at all (it is the silent-cue case) — pairing
 * it with the nearest segment would invent a nonsense drift for a deleted line.
 * Under a uniform offset every cue start lands over the *next* line's speech, so
 * the sign is then relative to that neighbour; the magnitude is the number that
 * identifies the defect and `worstDriftMs` is its maximum.
 */
function auditSubtitleVsAudio (analysis, cues, maxDriftMs, issues) {
  const deviations = []
  let pairedCues = 0
  let silentCues = 0
  let driftCues = 0
  let worst = null

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    const duration = cue.end - cue.start
    const active = activeSecondsWithin(analysis, cue.start, cue.end)
    const share = duration > 0 ? active / duration : 0
    const segment = firstOverlappingSegment(analysis.segments, cue)
    const entry = {
      index: index + 1,
      at: roundTo(cue.start, 3),
      end: roundTo(cue.end, 3),
      activeSeconds: roundTo(active, 3),
      onsetAt: null,
      deviationMs: null
    }

    if (segment !== null) {
      const deviationMs = roundTo((cue.start - segment.start) * 1000, 1)
      entry.onsetAt = roundTo(segment.start, 3)
      entry.deviationMs = deviationMs
      pairedCues += 1
      const magnitude = Math.abs(deviationMs)
      if (worst === null || magnitude > Math.abs(worst.deviationMs)) {
        worst = {
          index: index + 1,
          at: entry.at,
          onsetAt: entry.onsetAt,
          deviationMs
        }
      }
      if (magnitude > maxDriftMs) {
        driftCues += 1
        // No "late"/"early" word here: under a uniform offset the cue starts over
        // the *next* line's speech, so its sign is relative to that neighbour.
        // The magnitude is the defect; the two times let a reader see which way.
        issues.push(makeIssue(
          'subtitle-drift',
          cue.start,
          `第 ${index + 1} 条字幕 ${fmtTime(cue.start)}s 起，第一段重叠语音 ${fmtTime(segment.start)}s 起，` +
            `两者相差 ${fmtMs(magnitude)}ms（阈值 ${fmtMs(maxDriftMs)}ms）`,
          magnitude >= 2 * maxDriftMs ? 'error' : 'warn'
        ))
      }
    }

    deviations.push(entry)

    // A cue is empty when it holds almost no speech (5 % or 50 ms, whichever is
    // smaller) and merely quiet when it holds under a quarter. The broken case
    // is an error, the quiet one a warning: a caption that starts on the breath
    // before a line is normal, a caption over a pause is not.
    const emptyLimit = Math.min(0.05, duration * 0.05)
    const isEmpty = active <= emptyLimit
    const mostlySilent = active < duration * 0.25
    if (isEmpty || mostlySilent) {
      silentCues += 1
      const overrun = cue.end > analysis.durationSeconds + 0.05
        ? `，且末尾超出音频 ${fmtTime(cue.end - analysis.durationSeconds)}s`
        : ''
      issues.push(makeIssue(
        'subtitle-silent',
        cue.start,
        `第 ${index + 1} 条字幕 ${fmtTime(cue.start)}–${fmtTime(cue.end)}s 里只有 ${percent(share)}% 的语音能量（${fmtTime(active)}s）${overrun}`,
        isEmpty ? 'error' : 'warn'
      ))
    }
  }

  const totalSpeech = analysis.segments.reduce((sum, segment) => sum + segment.seconds, 0)
  let uncoveredSeconds = 0
  const missing = []
  for (const segment of analysis.segments) {
    for (const gap of uncoveredSpans(segment, cues)) {
      uncoveredSeconds += gap.seconds
      if (gap.seconds >= MIN_MISSING_SECONDS) missing.push(gap)
    }
  }
  for (const gap of missing) {
    issues.push(makeIssue(
      'subtitle-missing',
      gap.start,
      `语音 ${fmtTime(gap.start)}–${fmtTime(gap.end)}s（${Math.round(gap.seconds * 1000)}ms）没有字幕覆盖`,
      gap.seconds >= 0.3 ? 'error' : 'warn'
    ))
  }

  const worstDriftMs = worst === null ? null : Math.abs(worst.deviationMs)
  const metrics = {
    cues: cues.length,
    firstStartSeconds: cues.length > 0 ? roundTo(cues[0].start, 3) : null,
    lastEndSeconds: cues.length > 0 ? roundTo(cues[cues.length - 1].end, 3) : null,
    speechSegments: analysis.segments.length,
    speechCoverage: totalSpeech > 0 ? roundTo(Math.max(0, 1 - uncoveredSeconds / totalSpeech), 4) : null,
    pairedCues,
    silentCues,
    driftCues,
    missingSpans: missing.length,
    uncoveredSeconds: roundTo(uncoveredSeconds, 3),
    worstDriftMs,
    worst,
    deviations
  }
  const detail = cues.length === 0
    ? `srt 里没有字幕条目：${analysis.segments.length} 段语音全部视为漏字幕`
    : `${cues.length} 条字幕 / ${analysis.segments.length} 段语音：静音 ${silentCues} 条 · 漏字幕 ${missing.length} 处 · ` +
      `起点偏差超限 ${driftCues} 条 · 最差 ${worstDriftMs === null ? 'n/a' : `${fmtMs(worstDriftMs)}ms`}（阈值 ${fmtMs(maxDriftMs)}ms）`
  return { metrics, detail }
}

/* ------------------------------------------------- check 2: mouth vs audio -- */

/**
 * Compare the mouth track with the audio speech map: speech the mouth never
 * covers (a line with a closed mouth), open-mouth frames over silence, and
 * one-frame label chatter.
 *
 * Coverage is measured on the same 10 ms block grid as the audio, so the number
 * is comparable with the subtitle checks; "open over silence" is measured per
 * frame, because that defect is a *visible* one and frames are what the page
 * draws — but it is reported from the longest contiguous run (see
 * `SILENT_OPEN_MIN_RUN_SECONDS`), because one frame of jaw release at every
 * boundary is what a correct track looks like.
 *
 * Two timeline details decide the numbers:
 *   - A frame owns `[t, t + span)` and nothing after that. Treating the last
 *     frame as open-ended would make a truncated track (say the first second of
 *     a three-second read) look like perfect coverage.
 *   - `leadMs` is honoured: `audio_lipsync` analyses ahead by `leadMs`, so the
 *     shape at picture time `t` describes audio at `t + leadMs/1000`. Comparing
 *     raw picture times against the audio would fail every lead-compensated
 *     track by exactly that lead.
 */
function auditVisemeVsAudio (analysis, track, issues) {
  const frames = track.frames
  const spans = frameSpans(track)
  const blockCount = analysis.blockCount
  const hopSeconds = analysis.hopSeconds
  const leadSeconds = Number.isFinite(track.leadMs) ? track.leadMs / 1000 : 0

  // Mouth state on the audio grid: one monotonic pointer over picture times,
  // because frames are sorted and the block centres are increasing.
  const mouthOpen = new Uint8Array(blockCount)
  let cursor = 0
  for (let block = 0; block < blockCount; block += 1) {
    const picture = (block + 0.5) * hopSeconds - leadSeconds
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= picture) cursor += 1
    let open = 0
    if (frames.length > 0 && picture >= frames[0].t - 1e-9) {
      const frame = frames[cursor]
      if (picture < frame.t + spans[cursor] + 1e-9 && frame.viseme !== 'none') open = 1
    }
    mouthOpen[block] = open
  }

  let speechBlocks = 0
  let coveredBlocks = 0
  let firstUncoveredAt = null
  for (let block = 0; block < blockCount; block += 1) {
    if (analysis.active[block] !== 1) continue
    speechBlocks += 1
    if (mouthOpen[block] === 1) coveredBlocks += 1
    else if (firstUncoveredAt === null) firstUncoveredAt = block * hopSeconds
  }
  const speechCoverage = speechBlocks > 0 ? coveredBlocks / speechBlocks : null

  const labels = new Array(frames.length)
  let openFrames = 0
  let openOnSpeech = 0
  let openInSilence = 0
  let silentOpenRuns = 0
  let inSilentRun = false
  let firstSilentOpenAt = null
  let lastSilentOpenEnd = null
  let longestRunFrames = 0
  let longestRunSeconds = 0
  let longestRunAt = null
  let runStartAt = 0
  let runEndAt = 0
  let runFrames = 0
  for (let index = 0; index < frames.length; index += 1) {
    labels[index] = frames[index].viseme
    if (frames[index].viseme === 'none') {
      inSilentRun = false
      continue
    }
    openFrames += 1
    const center = frames[index].t + spans[index] / 2 + leadSeconds
    if (activeAt(analysis, center)) {
      openOnSpeech += 1
      inSilentRun = false
      continue
    }
    openInSilence += 1
    if (firstSilentOpenAt === null) firstSilentOpenAt = frames[index].t
    lastSilentOpenEnd = frames[index].t + spans[index]
    if (!inSilentRun) {
      silentOpenRuns += 1
      inSilentRun = true
      runStartAt = frames[index].t
      runFrames = 0
    }
    runFrames += 1
    runEndAt = frames[index].t + spans[index]
    const runSeconds = runEndAt - runStartAt
    if (runSeconds > longestRunSeconds) {
      longestRunSeconds = runSeconds
      longestRunFrames = runFrames
      longestRunAt = runStartAt
    }
  }

  // One-frame chatter: a run of length 1 whose neighbours agree. Counting runs
  // rather than frames is what makes "A B A" one defect instead of two, and the
  // label itself does not matter — a one-frame close inside a vowel is the same
  // visible flicker as a one-frame wrong vowel.
  const runs = labelRuns(labels)
  const flickers = []
  for (let index = 1; index + 1 < runs.length; index += 1) {
    if (runs[index].start !== runs[index].end) continue
    if (runs[index - 1].label !== runs[index + 1].label) continue
    flickers.push(frames[runs[index].start].t)
  }

  if (speechCoverage !== null && speechCoverage < COVERAGE_WARN) {
    issues.push(makeIssue(
      'mouth-coverage',
      firstUncoveredAt ?? 0,
      `语音段里只有 ${percent(speechCoverage)}% 的时间口型张开` +
        `${firstUncoveredAt === null ? '' : `，第一个没张嘴的语音块在 ${fmtTime(firstUncoveredAt)}s`}`,
      speechCoverage < COVERAGE_ERROR ? 'error' : 'warn'
    ))
  }

  const warnRunSeconds = Math.max(SILENT_OPEN_MIN_RUN_SECONDS, SILENT_OPEN_RELEASE_FRAMES / track.fps)
  const errorRunSeconds = Math.max(SILENT_OPEN_ERROR_SECONDS, warnRunSeconds * 2)
  const silentOpenSeconds = openInSilence / track.fps
  if (longestRunSeconds >= warnRunSeconds) {
    issues.push(makeIssue(
      'mouth-open-in-silence',
      longestRunAt ?? firstSilentOpenAt ?? 0,
      `静音处张嘴 ${openInSilence} 帧（约 ${Math.round(silentOpenSeconds * 1000)}ms，` +
        `${fmtTime(firstSilentOpenAt ?? 0)}–${fmtTime(lastSilentOpenEnd ?? firstSilentOpenAt ?? 0)}s，共 ${silentOpenRuns} 段；` +
        `最长一段 ${longestRunFrames} 帧 / ${Math.round(longestRunSeconds * 1000)}ms 在 ${fmtTime(longestRunAt ?? 0)}s）`,
      longestRunSeconds >= errorRunSeconds ? 'error' : 'warn'
    ))
  }

  if (flickers.length > 0) {
    issues.push(makeIssue(
      'mouth-flicker',
      flickers[0],
      `连续 1 帧抖动 ${flickers.length} 处（单帧换形后立刻换回），首个在 ${fmtTime(flickers[0])}s`,
      flickers.length > FLICKER_ERROR_COUNT ? 'error' : 'warn'
    ))
  }

  const metrics = {
    fps: track.fps,
    frames: frames.length,
    leadMs: track.leadMs,
    openFrames,
    openOnSpeech,
    openFrameCoverage: openFrames > 0 ? roundTo(openOnSpeech / openFrames, 4) : null,
    openFrameOvershoot: openFrames > 0 ? roundTo(openInSilence / openFrames, 4) : null,
    openInSilenceFrames: openInSilence,
    openInSilenceSeconds: roundTo(silentOpenSeconds, 3),
    firstOpenInSilenceAt: firstSilentOpenAt === null ? null : roundTo(firstSilentOpenAt, 3),
    silentOpenRuns,
    longestOpenInSilenceFrames: longestRunFrames,
    longestOpenInSilenceSeconds: roundTo(longestRunSeconds, 3),
    longestOpenInSilenceAt: longestRunAt === null ? null : roundTo(longestRunAt, 3),
    flickerCount: flickers.length,
    firstFlickerAt: flickers.length > 0 ? roundTo(flickers[0], 3) : null,
    flickerTimes: flickers.slice(0, 32).map((at) => roundTo(at, 3)),
    unknownVisemes: track.unknownVisemes,
    speechCoverage: speechCoverage === null ? null : roundTo(speechCoverage, 4),
    speechBlocks,
    coveredBlocks,
    firstUncoveredSpeechAt: firstUncoveredAt === null ? null : roundTo(firstUncoveredAt, 3)
  }
  const detail = frames.length === 0
    ? '口型轨是空的，无法与音频对账'
    : `口型 ${frames.length} 帧 @${track.fps}fps：语音覆盖 ${speechCoverage === null ? 'n/a' : `${percent(speechCoverage)}%`} · ` +
      `静音张嘴 ${openInSilence} 帧 · 1 帧抖动 ${flickers.length} 处`
  return { metrics, detail }
}

/* --------------------------------------------- check 3: subtitle vs mouth -- */

/**
 * Compare subtitles with the mouth track: every caption interval should contain
 * at least one open-mouth frame — a caption on screen over a closed mouth is the
 * "silent talking head" defect, and it is invisible to both of the audio-based
 * checks when the audio is fine.
 *
 * This check never reads the audio: caption and mouth are both on the page
 * timeline, so it still runs when the narration is silent or missing.
 *
 * Frames are sampled by their centre, so a boundary frame is claimed by exactly
 * one cue and a cue whose interval falls between two frames is reported as
 * uncovered rather than counted as closed. `leadMs` is *not* applied here for
 * the same reason the check ignores the audio: the caption and the mouth are
 * what the viewer sees at the same instant.
 */
function auditSubtitleVsViseme (cues, track, issues) {
  const frames = track.frames
  const spans = frameSpans(track)
  const lastFrameEnd = frames.length > 0
    ? frames[frames.length - 1].t + spans[spans.length - 1]
    : 0
  let withMouth = 0
  let closedCues = 0
  let uncoveredCues = 0
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    let total = 0
    let open = 0
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const center = frames[frameIndex].t + spans[frameIndex] / 2
      if (center < cue.start) continue
      if (center >= cue.end) break
      total += 1
      if (frames[frameIndex].viseme !== 'none') open += 1
    }
    if (total === 0) {
      uncoveredCues += 1
      issues.push(makeIssue(
        'subtitle-mouth-missing',
        cue.start,
        `第 ${index + 1} 条字幕 ${fmtTime(cue.start)}–${fmtTime(cue.end)}s 内没有口型帧（口型轨只到 ${fmtTime(lastFrameEnd)}s）`,
        'error'
      ))
      continue
    }
    if (open === 0) {
      closedCues += 1
      issues.push(makeIssue(
        'subtitle-mouth-missing',
        cue.start,
        `第 ${index + 1} 条字幕 ${fmtTime(cue.start)}–${fmtTime(cue.end)}s 内 ${total} 帧口型全是 none（一条台词配了一个闭嘴）`,
        'error'
      ))
      continue
    }
    withMouth += 1
  }
  const metrics = {
    cuesChecked: cues.length,
    cuesWithMouth: withMouth,
    cuesClosed: closedCues,
    cuesUncovered: uncoveredCues,
    mouthShare: cues.length > 0 ? roundTo(withMouth / cues.length, 4) : null
  }
  const detail = cues.length === 0
    ? '没有字幕条目，无法与口型对账'
    : `${cues.length} 条字幕：${withMouth} 条区间内有张嘴帧` +
      `${closedCues > 0 ? `，${closedCues} 条全闭` : ''}${uncoveredCues > 0 ? `，${uncoveredCues} 条没有口型帧覆盖` : ''}`
  return { metrics, detail }
}

/* ------------------------------------------------------------- assembly --- */

/** Fold issues past the per-kind cap into one summary entry. */
function capIssues (issues) {
  const kept = []
  const counts = new Map()
  const overflow = new Map()
  for (const issue of issues) {
    const seen = counts.get(issue.kind) ?? 0
    counts.set(issue.kind, seen + 1)
    if (seen < MAX_ISSUES_PER_KIND) {
      kept.push(issue)
      continue
    }
    const existing = overflow.get(issue.kind)
    if (existing === undefined) {
      overflow.set(issue.kind, { count: 1, at: issue.at, severity: issue.severity })
    } else {
      existing.count += 1
    }
  }
  for (const [kind, entry] of overflow) {
    kept.push({
      kind,
      at: entry.at,
      detail: `另有 ${entry.count} 处同类问题（每类只列前 ${MAX_ISSUES_PER_KIND} 条）`,
      severity: entry.severity
    })
  }
  return kept
}

function checkRecord (status, issueCount, detail) {
  return { status, issues: issueCount, detail }
}

/**
 * The subtitle metrics every report carries, including the ones the drift check
 * fills in. Keeping the keys present (null / empty) when that check is skipped
 * means a consumer never has to branch on which pair ran.
 */
function basicSubtitleMetrics (cues) {
  return {
    cues: cues.length,
    firstStartSeconds: cues.length > 0 ? roundTo(cues[0].start, 3) : null,
    lastEndSeconds: cues.length > 0 ? roundTo(cues[cues.length - 1].end, 3) : null,
    pairedCues: 0,
    silentCues: 0,
    driftCues: 0,
    missingSpans: 0,
    uncoveredSeconds: 0,
    speechCoverage: null,
    worstDriftMs: null,
    worst: null,
    deviations: []
  }
}

function basicVisemeMetrics (track) {
  return {
    fps: track.fps,
    frames: track.frames.length,
    leadMs: track.leadMs,
    unknownVisemes: track.unknownVisemes
  }
}

/**
 * The one-line Chinese verdict.
 *
 * `issueCount` is the number found *before* the per-kind cap: the capped list
 * keeps the report readable, but a verdict that silently shrinks 106 defects to
 * 47 would understate the work left.
 */
function buildSummary ({ issueCount, ranChecks, metrics, skipped, worstDriftMs }) {
  const parts = [`语音 ${metrics.audio.segments} 段 / ${metrics.audio.speechSeconds}s`]
  if (metrics.subtitle !== null) parts.push(`字幕 ${metrics.subtitle.cues} 条`)
  if (metrics.viseme !== null) parts.push(`口型 ${metrics.viseme.frames} 帧`)
  if (worstDriftMs !== null) parts.push(`最差字幕偏差 ${fmtMs(worstDriftMs)}ms`)
  const skip = skipped.length > 0
    ? `；跳过 ${skipped.map((id) => CHECK_LABELS[id] ?? id).join('、')}`
    : ''
  const head = ranChecks === 0
    ? '未对账（三条配对检查都跑不了，不能算通过）'
    : issueCount === 0
      ? '对账通过'
      : `对账失败：${issueCount} 处问题`
  return `${head}：${parts.join(' · ')}${skip}`
}

/**
 * The pure core: audit already-loaded timelines.
 *
 * @param {object} options
 * @param {object} options.analysis - `analyzeSpeech()` result.
 * @param {Array<object>|null} [options.cues] - parsed SRT cues, or null when no
 *   subtitle file was given.
 * @param {object|null} [options.track] - `normalizeVisemeTrack()` result, or null.
 * @param {number} [options.maxDriftMs=DEFAULT_MAX_DRIFT_MS] - subtitle start
 *   tolerance in milliseconds.
 * @param {{audio?: string, srt?: string|null, visemes?: string|null}} [options.labels]
 *   - display paths recorded in `metrics`.
 * @returns {{ ok: boolean, issues: Array<{kind: string, at: number, detail: string,
 *   severity: string}>, summary: string, worstDriftMs: number|null,
 *   skipped: string[], checksRun: number, checks: object, metrics: object }}
 *   `ok` is true only when no defect was found and at least one pair ran.
 */
export function auditTimelines (options = {}) {
  const analysis = options.analysis
  if (analysis === null || typeof analysis !== 'object' || !(analysis.active instanceof Uint8Array)) {
    throw new Error('auditTimelines 需要 analyzeSpeech() 的结果')
  }
  const cues = Array.isArray(options.cues) ? options.cues : null
  const track = options.track !== undefined && options.track !== null ? options.track : null
  const labels = options.labels !== undefined && options.labels !== null ? options.labels : {}
  const maxDriftMs = clamp(
    Number.isFinite(options.maxDriftMs) ? options.maxDriftMs : DEFAULT_MAX_DRIFT_MS,
    0,
    MAX_MAX_DRIFT_MS
  )
  const issues = []
  const checks = {}
  const skipped = []
  const hasSpeech = analysis.segments.length > 0

  if (!hasSpeech) {
    issues.push(makeIssue(
      'audio-silent',
      0,
      `音频 ${fmtTime(analysis.durationSeconds)}s 内没有检测到语音能量（最响块电平 ${rmsDbfs(analysis.peakRms)} dBFS），三条时间轴都没有可对的内容`,
      'error'
    ))
  }
  if (track !== null && track.unknownVisemes > 0) {
    issues.push(makeIssue(
      'viseme-unknown',
      track.firstUnknownAt ?? 0,
      `口型轨有 ${track.unknownVisemes} 帧的 viseme 不在白名单里，已按 none（闭嘴）参与对账`,
      'warn'
    ))
  }

  const totalSpeech = analysis.segments.reduce((sum, segment) => sum + segment.seconds, 0)
  const metrics = {
    audio: {
      path: typeof labels.audio === 'string' ? labels.audio : null,
      durationSeconds: roundTo(analysis.durationSeconds, 3),
      sampleRate: analysis.sampleRate,
      channelCount: analysis.channelCount,
      blockSeconds: roundTo(analysis.hopSeconds, 3),
      peakLevelDbfs: rmsDbfs(analysis.peakRms),
      speechSeconds: roundTo(totalSpeech, 3),
      segments: analysis.segments.length,
      firstOnsetSeconds: analysis.segments.length > 0 ? roundTo(analysis.segments[0].start, 3) : null,
      onsets: analysis.segments.slice(0, 64).map((segment) => roundTo(segment.start, 3))
    },
    subtitle: cues === null ? null : basicSubtitleMetrics(cues),
    viseme: track === null ? null : basicVisemeMetrics(track),
    visemeAudio: null,
    subtitleViseme: null
  }

  // 1. subtitle vs audio
  if (cues === null) {
    checks['subtitle-vs-audio'] = checkRecord('skipped', 0, '已跳过：没有提供 srt')
    skipped.push('subtitle-vs-audio')
  } else if (!hasSpeech) {
    checks['subtitle-vs-audio'] = checkRecord('skipped', 0, '已跳过：音频里没有检测到语音')
    skipped.push('subtitle-vs-audio')
  } else {
    const before = issues.length
    const run = auditSubtitleVsAudio(analysis, cues, maxDriftMs, issues)
    metrics.subtitle = { ...basicSubtitleMetrics(cues), ...run.metrics }
    checks['subtitle-vs-audio'] = checkRecord(
      issues.length > before ? 'issues' : 'ok',
      issues.length - before,
      run.detail
    )
  }

  // 2. mouth vs audio
  if (track === null) {
    checks['viseme-vs-audio'] = checkRecord('skipped', 0, '已跳过：没有提供 visemes')
    skipped.push('viseme-vs-audio')
  } else if (!hasSpeech) {
    checks['viseme-vs-audio'] = checkRecord('skipped', 0, '已跳过：音频里没有检测到语音')
    skipped.push('viseme-vs-audio')
  } else {
    const before = issues.length
    const run = auditVisemeVsAudio(analysis, track, issues)
    metrics.visemeAudio = run.metrics
    checks['viseme-vs-audio'] = checkRecord(
      issues.length > before ? 'issues' : 'ok',
      issues.length - before,
      run.detail
    )
  }

  // 3. subtitle vs mouth: both timelines live on the page, so this check needs
  // no speech — it still runs when the narration is silent (the caption still
  // must not sit over a closed mouth). With an empty srt there is no cue to test.
  if (track === null) {
    checks['subtitle-vs-viseme'] = checkRecord('skipped', 0, '已跳过：没有提供 visemes')
    skipped.push('subtitle-vs-viseme')
  } else if (cues === null) {
    checks['subtitle-vs-viseme'] = checkRecord('skipped', 0, '已跳过：没有提供 srt')
    skipped.push('subtitle-vs-viseme')
  } else if (cues.length === 0) {
    checks['subtitle-vs-viseme'] = checkRecord('skipped', 0, '已跳过：srt 里没有字幕条目')
    skipped.push('subtitle-vs-viseme')
  } else {
    const before = issues.length
    const run = auditSubtitleVsViseme(cues, track, issues)
    metrics.subtitleViseme = run.metrics
    checks['subtitle-vs-viseme'] = checkRecord(
      issues.length > before ? 'issues' : 'ok',
      issues.length - before,
      run.detail
    )
  }

  const totalIssues = issues.length
  const capped = capIssues(issues)
  const ranChecks = AUDIT_CHECKS.length - skipped.length
  const worstDriftMs = metrics.subtitle === null || metrics.subtitle.worstDriftMs === undefined
    ? null
    : metrics.subtitle.worstDriftMs
  return {
    // `ok` means "verified": no defect and at least one pair actually checked.
    // A call that could not run any comparison must not gate a delivery through.
    ok: capped.length === 0 && ranChecks > 0,
    issues: capped,
    summary: buildSummary({ issueCount: totalIssues, ranChecks, metrics, skipped, worstDriftMs }),
    worstDriftMs,
    skipped,
    checksRun: ranChecks,
    checks,
    metrics
  }
}

/* ---------------------------------------------------------------- loading -- */

/**
 * Read a mouth track from a path (`lipsync` JSON) or accept an inline payload.
 *
 * @param {string|object} input - path, payload or frame array.
 * @param {object} context - `cwd` and the argument name for error messages.
 * @returns {Promise<object>} normalized track.
 */
async function loadVisemeTrack (input, { cwd, name }) {
  if (typeof input === 'string') {
    const path = resolvePath(cwd, input)
    if (path === undefined) throw new Error(`audio_audit: ${name} 不是可用的文件路径`)
    const label = displayPath(cwd, path)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`读不出口型轨 ${label}：${error.code ?? error.message}`)
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new Error(`口型轨 ${label} 不是合法 JSON：${error.message}`)
    }
    return normalizeVisemeTrack(payload, label)
  }
  return normalizeVisemeTrack(input, 'inline')
}

/**
 * Load the three sources and audit them.
 *
 * Accepts `srtText` as well as `srt` so a caller that already holds the
 * subtitle document (a test, another tool) does not have to write it to disk
 * first; the tool itself only exposes the path form.
 *
 * @param {object} input
 * @param {string} [input.cwd=process.cwd()] - session directory for path resolution.
 * @param {string} input.audio - narration .wav, relative or absolute.
 * @param {string} [input.srt] - .srt file path.
 * @param {string} [input.srtText] - raw SRT content, used instead of `srt`.
 * @param {string|object} [input.visemes] - lipsync JSON path or inline payload.
 * @param {number} [input.maxDriftMs] - subtitle start tolerance.
 * @returns {Promise<object>} `auditTimelines()` result plus `sources`.
 */
export async function auditDelivery (input = {}) {
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  const audioRef = input.audio
  if (typeof audioRef !== 'string' || audioRef.trim() === '') {
    throw new Error('audio_audit 需要 audio（旁白 .wav 路径）')
  }
  const audioPath = resolvePath(cwd, audioRef)
  if (audioPath === undefined) throw new Error('audio_audit: audio 不是可用的文件路径')
  const audioLabel = displayPath(cwd, audioPath)
  let decoded
  try {
    decoded = await readChannels(audioPath)
  } catch (error) {
    throw new Error(`读不出音频 ${audioLabel}：${error.message}`)
  }
  // The envelope, not a mono fold: averaging an out-of-phase pair cancels it to
  // near-silence and the audit would report a silent file instead of noting that
  // the channels disagree (which `audio_check`'s phase block is for).
  const activity = peakEnvelope(decoded.channels)
  const analysis = analyzeSpeech(activity, decoded.sampleRate, { channelCount: decoded.channelCount })

  let cues = null
  let srtLabel = null
  if (typeof input.srtText === 'string') {
    cues = parseSrt(input.srtText, 'srt')
    srtLabel = 'inline'
  } else if (input.srt !== undefined && input.srt !== null) {
    if (typeof input.srt !== 'string' || input.srt.trim() === '') {
      throw new Error('audio_audit: srt 必须是 .srt 文件路径')
    }
    const srtPath = resolvePath(cwd, input.srt)
    if (srtPath === undefined) throw new Error('audio_audit: srt 不是可用的文件路径')
    srtLabel = displayPath(cwd, srtPath)
    let text
    try {
      text = await readFile(srtPath, 'utf8')
    } catch (error) {
      throw new Error(`读不出字幕 ${srtLabel}：${error.code ?? error.message}`)
    }
    cues = parseSrt(text, srtLabel)
  }

  let track = null
  let visemeLabel = null
  if (input.visemes !== undefined && input.visemes !== null) {
    track = await loadVisemeTrack(input.visemes, { cwd, name: 'visemes' })
    visemeLabel = track.source === 'inline' ? 'inline' : track.source
  }

  const result = auditTimelines({
    analysis,
    cues,
    track,
    maxDriftMs: input.maxDriftMs,
    labels: { audio: audioLabel, srt: srtLabel, visemes: visemeLabel }
  })
  return {
    ...result,
    sources: {
      audio: audioLabel,
      srt: srtLabel,
      visemes: visemeLabel
    }
  }
}
