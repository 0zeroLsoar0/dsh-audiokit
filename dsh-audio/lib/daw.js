/**
 * Project and timeline export: hand a cue set or a stem set to a DAW, an NLE or
 * a spreadsheet.
 *
 * Cue sets and stems are assembled elsewhere in this plugin (`audio_bind`,
 * `audio_stems`), but until now the result could only be played back inside the
 * page or read back through `audio_probe`. A human who wants to *edit* the work
 * needs a project file. Eight formats, five audiences:
 *
 * - CMX3600 EDL — a cut list an NLE (Resolve, Premiere, Avid) imports. One
 *   record track, cut events only: no levels, no fades, no overlapping events.
 *   Everything the format cannot carry is said out loud in a warning or in a
 *   `*` comment line instead of being dropped in silence, because a cue sheet
 *   that quietly loses the level is worse than one that refuses.
 * - REAPER `.RPP` — a real project: one track per stem, one media item each,
 *   with position, length, gain and fades. The format that loses the least, and
 *   the reason this module parses `.RPP` back as well as writing it.
 * - CSV — an RFC4180 cue sheet for spreadsheets and scripts.
 * - Audacity labels — the annotation track of an audio editor.
 * - AAF (`lib/aaf.js`) and OMF (`lib/omf.js`) — the Avid/Pro Tools interchange
 *   formats. Both are MS-CFB containers: AAF is written as a documented
 *   structural subset (container, object graph and embedded PCM are real, the
 *   self-describing MetaDictionary layer is not), OMF is a labelled skeleton.
 * - OpenTimelineIO `.otio` (`lib/otio.js`) and FCP7 `xmeml` XML
 *   (`lib/xmeml.js`) — the two formats Resolve and Premiere open today, one
 *   JSON and sample-accurate, the other frame based and NLE-native.
 *
 * Everything here is pure and deterministic: no clock, no locale, no
 * `Math.random`, `\n` line endings only, and every number is formatted by hand
 * (never `toLocaleString`), so the same request always produces the same bytes.
 * The module reads no file and owns no state, which is why the caller supplies
 * the item duration the writer needs to place it on a timeline (the tool layer
 * measures the wav header for that) and, for AAF, the PCM to embed.
 *
 * Text policy, because two of these formats are legacy byte formats:
 * - generated content (title, keywords, comments) is pure ASCII;
 * - user text (a cue name, a path) is preserved as UTF-8 in CSV, labels, RPP,
 *   OTIO and xmeml, all of which are UTF-8 formats;
 * - EDL fields are forced to ASCII (`?` for anything else) and the loss is
 *   reported as a warning, since CMX3600 predates text encoding entirely.
 */

import { basename } from 'node:path'
import { dbToGain } from './dsp.js'
import { exportAaf } from './aaf.js'
import { exportOmf } from './omf.js'
import { exportOtio } from './otio.js'
import { exportXmeml } from './xmeml.js'

/* --------------------------------------------------------------- constants -- */

/** The eight export formats, in the order the tool documents them. */
export const EXPORT_FORMATS = Object.freeze(['edl', 'rpp', 'csv', 'labels', 'aaf', 'omf', 'otio', 'xmeml'])

/** Extension each format is normally written with. */
export const EXPORT_EXTENSIONS = Object.freeze({
  edl: 'edl',
  rpp: 'rpp',
  csv: 'csv',
  labels: 'txt',
  aaf: 'aaf',
  omf: 'omf',
  otio: 'otio',
  xmeml: 'xml'
})

/**
 * Frame rates a CMX3600 EDL can be written at.
 *
 * `fps` is the real rate (29.97 is exactly 30000/1001), `nominalFps` is the
 * integer the timecode field counts in, and `dropFrame` says whether label
 * skipping applies. 23.976 and 59.94 are deliberately absent from the table:
 * 23.976 has no CMX3600 representation and is mapped to 24 with a warning,
 * 59.94 is rejected outright.
 */
export const FRAME_RATES = Object.freeze({
  24: Object.freeze({ id: '24', fps: 24, nominalFps: 24, dropFrame: false, fcm: 'NON-DROP FRAME', label: '24 fps non-drop' }),
  25: Object.freeze({ id: '25', fps: 25, nominalFps: 25, dropFrame: false, fcm: 'NON-DROP FRAME', label: '25 fps non-drop' }),
  30: Object.freeze({ id: '30', fps: 30, nominalFps: 30, dropFrame: false, fcm: 'NON-DROP FRAME', label: '30 fps non-drop' }),
  '29.97': Object.freeze({ id: '29.97', fps: 30000 / 1001, nominalFps: 30, dropFrame: true, fcm: 'DROP FRAME', label: '29.97 fps drop-frame' })
})

/**
 * Accepted spellings of `frameRate`, mapped to a table entry.
 *
 * A separate table instead of trying every number keeps the error message
 * useful: a caller passing 59.94 is told CMX3600 cannot express it, and a
 * caller passing 23.976 is told *what* was written instead.
 */
const FRAME_RATE_LOOKUP = Object.freeze({
  24: { id: '24' },
  25: { id: '25' },
  30: { id: '30' },
  29.97: { id: '29.97' },
  '24fps': { id: '24' },
  '25fps': { id: '25' },
  '30fps': { id: '30' },
  '29.97fps': { id: '29.97' },
  '29.97df': { id: '29.97' },
  film: { id: '24' },
  pal: { id: '25' },
  ntsc: { id: '29.97' },
  drop: { id: '29.97' },
  '23.976': {
    id: '24',
    note: '23.976 fps was written as 24 fps non-drop: CMX3600 has no 23.976 rate, and the 0.1% speed difference is unavoidable in an EDL (a 23.976-aware NLE should re-read the frame rate from your project)'
  },
  '23.98': {
    id: '24',
    note: '23.98 fps was written as 24 fps non-drop: CMX3600 has no 23.98 rate, and the 0.1% speed difference is unavoidable in an EDL'
  }
})

/** Frames skipped at each minute boundary in 29.97 drop-frame timecode. */
const DROP_FRAME_COUNT = 2

/** Record timecode an EDL program starts at (broadcast convention; 0 is black). */
export const EDL_RECORD_START_SECONDS = 3600

/** Track/channel field values CMX3600 defines. `A` is one mono audio channel. */
const EDL_TRACK_TYPES = Object.freeze(['A', 'A2', 'AA', 'AA/V', 'V'])

/** CMX3600 timecode is a 24 hour clock; beyond this the export is meaningless. */
const MAX_TIMELINE_SECONDS = 86400

/** Event-number width CMX3600 specifies; more events still export, with a warning. */
const MAX_CMX_EVENTS = 999

/** One request cannot ask for more events than this (each format stays bounded). */
const MAX_EVENTS = 20000

/** Gain bounds inherited from the mixer (`MIX_GAIN_LIMITS_DB`), restated here to
 * keep this module free of the audio engine and its file system imports. */
const MIN_GAIN_DB = -120
const MAX_GAIN_DB = 24

/** Audacity needs a non-empty span; a cue with no duration becomes this long. */
const LABEL_MIN_SECONDS = 0.001

/** REAPER project version written in the header line. */
const RPP_PROJECT_VERSION = '7.0'

/**
 * Fixed project timestamp for the `.RPP` header.
 *
 * A real project stores the time it was created. This module must be
 * deterministic (the tool names the file after a content hash, so an unstable
 * byte stream would scatter identical exports across files), so the timestamp
 * is a constant: 2025-01-01T00:00:00Z. REAPER only shows it in project info.
 */
const RPP_EPOCH = 1735689600

/* ----------------------------------------------------------------- errors -- */

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

/** Throw the one error shape this module reports: `<caller>: <what is wrong>`. */
function fail (caller, message) {
  throw new Error(`${caller}: ${message}`)
}

/** Read an optional number, rejecting only values that have no meaning. */
function readNumber (caller, label, value, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(caller, `${label} is required`)
    return fallback
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    fail(caller, `${label} must be a number, got ${describeValue(value)}`)
  }
  if (typeof value === 'string' && value.trim() === '') {
    fail(caller, `${label} must be a number, got an empty string`)
  }
  const number = Number(value)
  if (!Number.isFinite(number)) fail(caller, `${label} must be a finite number, got ${describeValue(value)}`)
  return number
}

/** Read an optional number inside `[min, max]`. */
function readRange (caller, label, value, fallback, min, max) {
  const number = readNumber(caller, label, value, fallback)
  if (number < min || number > max) fail(caller, `${label} must be between ${min} and ${max}, got ${numberText(number)}`)
  return number
}

/* ------------------------------------------------------------ text / number -- */

/** Round to `digits` decimals, normalising `-0` (which would print as "-0"). */
function roundTo (value, digits) {
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return rounded === 0 ? 0 : rounded
}

/**
 * Deterministic, locale-free decimal text.
 *
 * `String(number)` is the only formatter that never consults a locale, but it
 * switches to exponent notation for very small magnitudes (a -120 dB gain is
 * `1e-7`), and RPP/CSV parsers expect a plain decimal. `toFixed` is used as the
 * fallback and then trimmed, so the output never carries trailing zeros.
 */
function numberText (value, digits = 6) {
  const rounded = roundTo(value, digits)
  let text = String(rounded)
  if (text.includes('e') || text.includes('E')) text = rounded.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

/**
 * Collapse anything that would break a line-oriented format into one line.
 *
 * A cue name reaches four formats with three different line grammars; a tab or
 * a newline inside a name would split a label track row or an EDL comment in
 * two. Control characters are turned into spaces and runs of whitespace are
 * squeezed, which is lossless for display purposes and safe everywhere.
 */
function singleLine (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * ASCII-only version of a display string, for the legacy CMX3600 fields.
 *
 * Returns the sanitised text; the caller compares it with `singleLine()` to
 * learn whether anything was lost and can warn once for the whole file.
 */
function asciiText (value) {
  return singleLine(value).replace(/[^\x20-\x7e]/g, '?')
}

/* --------------------------------------------------------------- normalize -- */

/** Display name of a cue/track: given name, else the file stem, else its index. */
function entryName (value, index, path, noun) {
  const given = singleLine(value)
  if (given !== '') return given
  if (path !== undefined) {
    const stem = basename(String(path).replace(/\\/g, '/')).replace(/\.[^.\\/]+$/, '')
    if (stem !== '') return stem
  }
  return `${noun} ${index + 1}`
}

/** A cue path as given, or `undefined` when the caller left it empty. */
function entryPath (value) {
  const path = singleLine(value)
  return path === '' ? undefined : path
}

/**
 * Validate and sort a cue list.
 *
 * Sorting by `at` (then by input order, so equal positions stay stable) is what
 * makes the exported file deterministic: two callers that list the same cues in
 * a different order get the same EDL, CSV and label track.
 *
 * @param {string} caller - error prefix, e.g. "edl".
 * @param {unknown} cues - caller-supplied `[{ name, path, at, duration, ... }]`.
 * @param {{ requirePath?: boolean, requireDuration?: boolean }} options
 * @returns {{ entries: object[], warnings: string[] }}
 */
function normalizeCues (caller, cues, options = {}) {
  if (!Array.isArray(cues) || cues.length === 0) {
    fail(caller, 'cues must be a non-empty array of { name, path, at, duration, gainDb?, fadeIn?, fadeOut? }')
  }
  if (cues.length > MAX_EVENTS) fail(caller, `${cues.length} cues exceeds the ${MAX_EVENTS} event limit`)

  const warnings = []
  const entries = []
  let missingPaths = 0
  let multiLineNames = 0
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    const label = `cue ${index + 1}`
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) fail(caller, `${label} must be an object`)
    const path = entryPath(cue.path)
    const name = entryName(cue.name, index, path, 'cue')
    if (/[\u0000-\u001f\u007f]/.test(cue.name === undefined || cue.name === null ? '' : String(cue.name))) multiLineNames += 1
    if (path === undefined) {
      if (options.requirePath === true) {
        fail(caller, `${label} ("${name}") has no path; an event needs a source file to point at`)
      }
      missingPaths += 1
    }
    const at = readRange(caller, `${label} at`, cue.at, 0, 0, MAX_TIMELINE_SECONDS)
    const duration = cue.duration === undefined || cue.duration === null
      ? undefined
      : readRange(caller, `${label} duration`, cue.duration, undefined, 0, MAX_TIMELINE_SECONDS)
    if (duration === 0) fail(caller, `${label} ("${name}") duration must be greater than 0, got 0`)
    if (options.requireDuration === true && duration === undefined) {
      fail(caller, `${label} ("${name}") has no duration; this format needs an end time`)
    }
    entries.push({
      index,
      name,
      path,
      at,
      duration,
      gainDb: readRange(caller, `${label} gainDb`, cue.gainDb, 0, MIN_GAIN_DB, MAX_GAIN_DB),
      fadeIn: readRange(caller, `${label} fadeIn`, cue.fadeIn, 0, 0, MAX_TIMELINE_SECONDS),
      fadeOut: readRange(caller, `${label} fadeOut`, cue.fadeOut, 0, 0, MAX_TIMELINE_SECONDS)
    })
  }
  if (missingPaths > 0) {
    warnings.push(`${missingPaths} cue(s) had no path; the path field was left empty (the edl and rpp formats need one, csv and labels do not)`)
  }
  if (multiLineNames > 0) {
    warnings.push(`${multiLineNames} cue name(s) contained a tab or a line break; they were written as single-line text (a tab is Audacity's field separator and a newline would split an EDL comment)`)
  }
  entries.sort((left, right) => (left.at === right.at ? left.index - right.index : left.at - right.at))
  return { entries, warnings }
}

/**
 * Validate a stem/track list for the REAPER export.
 *
 * Track order is preserved (a DAW track stack is meaningful) and the duration is
 * required: RPP stores an item LENGTH, and guessing it would place a truncated
 * item on the timeline without telling anyone.
 */
function normalizeTracks (tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    fail('rpp', 'tracks must be a non-empty array of { name, path, offsetSeconds, duration, gainDb?, fadeIn?, fadeOut? }')
  }
  if (tracks.length > MAX_EVENTS) fail('rpp', `${tracks.length} tracks exceeds the ${MAX_EVENTS} item limit`)

  const warnings = []
  const entries = []
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    const label = `track ${index + 1}`
    if (track === null || typeof track !== 'object' || Array.isArray(track)) fail('rpp', `${label} must be an object`)
    const path = entryPath(track.path)
    const name = entryName(track.name, index, path, 'track')
    if (path === undefined) fail('rpp', `${label} ("${name}") has no path; a REAPER item needs a media file`)
    const duration = track.duration === undefined || track.duration === null ? undefined : readRange('rpp', `${label} duration`, track.duration, undefined, 0, MAX_TIMELINE_SECONDS)
    if (duration === undefined) {
      fail('rpp', `${label} ("${name}") has no duration; RPP stores an item length, so the caller must measure the wav (pass durationSeconds)`)
    }
    if (duration === 0) fail('rpp', `${label} ("${name}") duration must be greater than 0, got 0`)
    const fadeIn = readRange('rpp', `${label} fadeIn`, track.fadeIn, 0, 0, MAX_TIMELINE_SECONDS)
    const fadeOut = readRange('rpp', `${label} fadeOut`, track.fadeOut, 0, 0, MAX_TIMELINE_SECONDS)
    if (fadeIn + fadeOut > duration + 1e-9) {
      warnings.push(`track ${index + 1} ("${name}") has fades longer than the item (${numberText(fadeIn)} s + ${numberText(fadeOut)} s > ${numberText(duration)} s); REAPER will cross the fade shapes`)
    }
    entries.push({
      index,
      name,
      path,
      offsetSeconds: readRange('rpp', `${label} offsetSeconds`, track.offsetSeconds, 0, 0, MAX_TIMELINE_SECONDS),
      duration,
      gainDb: readRange('rpp', `${label} gainDb`, track.gainDb, 0, MIN_GAIN_DB, MAX_GAIN_DB),
      fadeIn,
      fadeOut
    })
  }
  return { entries, warnings }
}

/** Timeline end of a normalized list: the last second anything is audible. */
function timelineEnd (entries) {
  let end = 0
  for (const entry of entries) {
    const position = entry.at === undefined ? entry.offsetSeconds : entry.at
    // `csv` and `labels` tolerate a cue without a duration; it adds no time.
    end = Math.max(end, position + (entry.duration === undefined ? 0 : entry.duration))
  }
  return roundTo(end, 6)
}

/* --------------------------------------------------------------- timecode -- */

/** Milliseconds-free frame count for a non-negative number of seconds. */
function secondsToFrames (seconds, rate) {
  return Math.round(seconds * rate.fps)
}

/**
 * Apply drop-frame label skipping to a real frame count.
 *
 * In 29.97 drop-frame the *labels* `;00` and `;01` are skipped at the start of
 * every minute except every tenth, so that the label value tracks wall clock.
 * The frame count itself is unchanged; this returns the label number.
 */
function dropFrameLabel (frames, nominalFps, dropFrames) {
  const framesPerMinute = nominalFps * 60 - dropFrames
  const framesPer10Minutes = nominalFps * 600 - dropFrames * 9
  const blocks = Math.floor(frames / framesPer10Minutes)
  const remainder = frames % framesPer10Minutes
  const skipped = remainder > dropFrames
    ? dropFrames * 9 * blocks + dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute)
    : dropFrames * 9 * blocks
  return frames + skipped
}

/** Exact inverse of `dropFrameLabel`: a label number back to a real frame count. */
function dropFrameFrames (label, nominalFps, dropFrames) {
  const totalMinutes = Math.floor(label / nominalFps / 60)
  return label - dropFrames * (totalMinutes - Math.floor(totalMinutes / 10))
}

function twoDigits (value) {
  return String(value).padStart(2, '0')
}

/** Format a real frame count as `HH:MM:SS:FF` (or `HH:MM:SS;FF` when drop-frame). */
function timecodeFromFrames (frames, rate) {
  const nominalFps = rate.nominalFps
  const labelled = rate.dropFrame ? dropFrameLabel(frames, nominalFps, DROP_FRAME_COUNT) : frames
  const ff = labelled % nominalFps
  const totalSeconds = Math.floor(labelled / nominalFps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600) % 24
  const separator = rate.dropFrame ? ';' : ':'
  return `${twoDigits(hh)}:${twoDigits(mm)}:${twoDigits(ss)}${separator}${twoDigits(ff)}`
}

/**
 * Resolve a caller-supplied frame rate to the EDL table entry.
 *
 * @param {unknown} frameRate - 24|25|30|29.97, a numeric string, or an alias
 *   (`pal`, `ntsc`, `23.976`).
 * @returns {object} frozen rate descriptor; `note` is set when an alias had to
 *   be mapped to a rate the format can express.
 */
export function frameRateInfo (frameRate) {
  // Internal callers pass an already resolved descriptor (and so may callers of
  // this helper); returning it unchanged keeps `timecodeToSeconds(tc, rate)` from
  // being misread as a request for the rate named "[object Object]".
  if (frameRate !== null && typeof frameRate === 'object' && typeof frameRate.fps === 'number' && typeof frameRate.nominalFps === 'number') {
    return frameRate
  }
  const requested = frameRate === undefined || frameRate === null || frameRate === ''
    ? '24'
    : String(frameRate).trim().toLowerCase()
  const entry = FRAME_RATE_LOOKUP[requested]
  if (entry === undefined) {
    fail('edl', `unsupported frameRate ${JSON.stringify(String(frameRate))}; use 24, 25, 30 or 29.97 (23.976 is written as 24; 59.94 cannot be expressed in CMX3600)`)
  }
  const rate = FRAME_RATES[entry.id]
  return entry.note === undefined ? rate : Object.freeze({ ...rate, note: entry.note })
}

/**
 * Convert seconds to a CMX3600 timecode string.
 *
 * @param {number} seconds - timeline position, >= 0.
 * @param {unknown} frameRate - anything `frameRateInfo` accepts.
 * @returns {string} `HH:MM:SS:FF`, or `HH:MM:SS;FF` for 29.97 drop-frame.
 */
export function secondsToTimecode (seconds, frameRate) {
  const rate = frameRateInfo(frameRate)
  const value = readRange('edl', 'seconds', seconds, 0, 0, MAX_TIMELINE_SECONDS)
  // The clock wraps at 24 hours, so a value that would wrap is refused rather
  // than silently printed as 00:00:00:00.
  if (value >= MAX_TIMELINE_SECONDS) fail('edl', 'a CMX3600 timecode cannot express 24 hours or more')
  return timecodeFromFrames(secondsToFrames(value, rate), rate)
}

/**
 * Convert a timecode string back to seconds.
 *
 * Exact inverse of `secondsToTimecode` up to the frame rounding it applies,
 * including the drop-frame label skipping: this is what makes the EDL writer
 * testable without an NLE.
 *
 * @param {string} timecode - `HH:MM:SS:FF` or `HH:MM:SS;FF`.
 * @param {unknown} frameRate - anything `frameRateInfo` accepts.
 * @returns {number} seconds from the start of the timecode day.
 */
export function timecodeToSeconds (timecode, frameRate) {
  const rate = frameRateInfo(frameRate)
  const text = singleLine(timecode)
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(text)
  if (match === null) fail('edl', `timecode must be HH:MM:SS:FF or HH:MM:SS;FF, got ${describeValue(timecode)}`)
  const hh = Number(match[1])
  const mm = Number(match[2])
  const ss = Number(match[3])
  const ff = Number(match[5])
  const nominalFps = rate.nominalFps
  if (hh > 23 || mm > 59 || ss > 59 || ff >= nominalFps) {
    fail('edl', `timecode ${text} is not valid at ${rate.label}: hours must be below 24, minutes and seconds below 60 and frames below ${nominalFps}`)
  }
  let frames = ((hh * 60 + mm) * 60 + ss) * nominalFps + ff
  if (rate.dropFrame) frames = dropFrameFrames(frames, nominalFps, DROP_FRAME_COUNT)
  return frames / rate.fps
}

/* -------------------------------------------------------------------- edl -- */

/**
 * Reel field for a file-based cut.
 *
 * `AX` (auxiliary) is the CMX3600 convention for media that has no tape reel,
 * and it is what every NLE expects for file-based audio. Deriving an 8 character
 * reel from the file name instead would collide as soon as two names share a
 * prefix once truncated, which breaks the relink it was supposed to help; the
 * real media name is in `* FROM CLIP NAME` and `* SOURCE FILE`.
 */
function edlReel () {
  return 'AX'
}

/**
 * Export a cue set as a CMX3600 EDL (a cut list for a video editor).
 *
 * The record timeline starts at 01:00:00:00 by default, the broadcast
 * convention: an NLE timeline rarely starts at zero, and a record timecode of
 * 00:00:00:00 is read as black/leader by several tools. Source in is
 * 00:00:00:00 for every event because a cue is placed untrimmed.
 *
 * CMX3600 has exactly one record track, so two cues that overlap on the
 * timeline cannot be expressed. Rather than dropping one, the later cue is
 * delayed to the end of the previous event (its duration is kept, and the
 * warning states the old and new position) so the file stays importable and the
 * loss is legible. Cues that merely *touch*, or that miss each other by less
 * than a frame, are not an overlap: cut points are quantised from their absolute
 * times, so every boundary lands within half a frame of the requested position
 * and a contiguous cue set stays contiguous.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, path, at, duration, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {unknown} [request.frameRate] - 24 (default), 25, 30 or 29.97.
 * @param {string} [request.title] - `TITLE:` line, ASCII-sanitised.
 * @param {string} [request.trackType] - `A` (default), `A2`, `AA`, `AA/V` or `V`.
 * @param {number|string} [request.recordStart] - seconds or a timecode such as
 *   `"01:00:00:00"`; defaults to `01:00:00:00`.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number, frameRate: string, frameRateLabel: string,
 *   dropFrame: boolean, recordStart: string, trackType: string }}
 */
export function exportEdl (request = {}) {
  const caller = 'edl'
  const rate = frameRateInfo(request.frameRate)
  const title = asciiText(request.title === undefined ? 'CUE SHEET' : request.title) || 'CUE SHEET'
  const trackType = singleLine(request.trackType === undefined ? 'A' : request.trackType).toUpperCase() || 'A'
  if (!EDL_TRACK_TYPES.includes(trackType)) {
    fail(caller, `trackType must be one of ${EDL_TRACK_TYPES.join(', ')}, got ${describeValue(request.trackType)}`)
  }

  let recordStartSeconds = EDL_RECORD_START_SECONDS
  if (request.recordStart !== undefined && request.recordStart !== null && request.recordStart !== '') {
    recordStartSeconds = typeof request.recordStart === 'string' && request.recordStart.includes(':')
      ? timecodeToSeconds(request.recordStart, rate)
      : readRange(caller, 'recordStart', request.recordStart, EDL_RECORD_START_SECONDS, 0, MAX_TIMELINE_SECONDS)
  }
  if (recordStartSeconds >= MAX_TIMELINE_SECONDS) {
    fail(caller, `recordStart must be less than 24 hours (${MAX_TIMELINE_SECONDS} s), got ${numberText(recordStartSeconds, 3)}`)
  }

  const { entries, warnings } = normalizeCues(caller, request.cues, { requirePath: true, requireDuration: true })
  if (rate.note !== undefined) warnings.push(rate.note)
  if (entries.length > MAX_CMX_EVENTS) {
    warnings.push(`${entries.length} events exceeds the 3 digit CMX3600 event number; readers may reject the file past 999, consider splitting the cue set`)
  }

  // Every EDL field goes through this, so the file is provably ASCII and the
  // caller hears about anything the legacy format could not carry.
  let asciiLosses = 0
  const field = (value) => {
    const clean = singleLine(value)
    const ascii = clean.replace(/[^\x20-\x7e]/g, '?')
    if (ascii !== clean) asciiLosses += 1
    return ascii
  }

  const startFrame = secondsToFrames(recordStartSeconds, rate)
  const header = [
    `TITLE:   ${title}`,
    `FCM: ${rate.fcm}`,
    '',
    `* dsh-audiokit CMX3600 EDL | ${entries.length} event(s) | ${rate.label} | audio track ${trackType} | record start ${timecodeFromFrames(startFrame, rate)}`,
    '* NOTE: CMX3600 carries cut timing only: gain, fades and overlapping events cannot be expressed in this format. The csv and rpp exports keep levels.'
  ]
  const lines = header.slice()
  let cursor = startFrame

  for (const cue of entries) {
    const requestedFrame = startFrame + secondsToFrames(cue.at, rate)
    // Quantise both *boundaries* rather than rounding the duration on its own:
    // 37.5 frames in and 18.75 frames long round to 38 + 19, which pushes the
    // next cue's start one frame into the past and fakes an overlap out of
    // nothing. Rounding `at` and `at + duration` keeps every cut within half a
    // frame of what was asked and keeps contiguous cues contiguous.
    let lengthFrames = secondsToFrames(cue.at + cue.duration, rate) - secondsToFrames(cue.at, rate)
    if (lengthFrames < 1) {
      lengthFrames = 1
      warnings.push(`cue ${cue.index + 1} ("${cue.name}") is ${numberText(cue.duration, 3)} s, shorter than one frame at ${rate.id} fps; rounded up to one frame`)
    }
    let inFrame = requestedFrame
    if (inFrame < cursor) {
      const movedTo = (cursor - startFrame) / rate.fps
      warnings.push(`cue ${cue.index + 1} ("${cue.name}") overlaps the previous event: CMX3600 has one record track and cannot express overlapping events, so it was clamped from ${numberText(cue.at, 3)} s to ${numberText(roundTo(movedTo, 3), 3)} s (its length was kept)`)
      inFrame = cursor
    }
    const outFrame = inFrame + lengthFrames
    // `>=`: a timeline ending at exactly 24 hours has no timecode (the clock
    // wraps to 00:00:00:00), so it is refused like anything longer.
    if (outFrame >= MAX_TIMELINE_SECONDS * rate.fps) {
      fail(caller, `the timeline ends at ${numberText(outFrame / rate.fps, 3)} s, beyond the 24 hour limit of CMX3600 timecode`)
    }
    cursor = outFrame

    const sourceIn = timecodeFromFrames(0, rate)
    const sourceOut = timecodeFromFrames(lengthFrames, rate)
    const recordIn = timecodeFromFrames(inFrame, rate)
    const recordOut = timecodeFromFrames(outFrame, rate)
    const eventNumber = String(cue.index + 1).padStart(3, '0')
    // The column widths reproduce the canonical CMX3600 event line exactly
    // (3 digit number, 8 char reel, 5 char track, 8 char edit type, 4 timecodes).
    lines.push(`${eventNumber}  ${edlReel().padEnd(8)} ${trackType.padEnd(5)} ${'C'.padEnd(8)} ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`)

    const clipName = field(basename(String(cue.path).replace(/\\/g, '/')))
    lines.push(`* FROM CLIP NAME: ${clipName}`)
    lines.push(`* SOURCE FILE: ${field(cue.path)}`)
    if (cue.name !== clipName.replace(/\.[^.]+$/, '')) lines.push(`* CUE NAME: ${field(cue.name)}`)
    if (cue.gainDb !== 0 || cue.fadeIn > 0 || cue.fadeOut > 0) {
      // Not expressible in the event line; a comment keeps the intent next to
      // the cut instead of only in the tool result.
      const parts = []
      if (cue.gainDb !== 0) parts.push(`gain ${numberText(cue.gainDb, 2)} dB`)
      if (cue.fadeIn > 0) parts.push(`fade in ${numberText(cue.fadeIn, 3)} s`)
      if (cue.fadeOut > 0) parts.push(`fade out ${numberText(cue.fadeOut, 3)} s`)
      lines.push(`* CUE LEVEL: ${parts.join(', ')} (apply in the DAW; CMX3600 cannot carry levels)`)
    }
  }

  if (asciiLosses > 0) {
    warnings.push(`${asciiLosses} EDL field(s) contained non-ASCII characters and were written as "?" - CMX3600 is a byte-oriented ASCII format; the csv and rpp exports keep the original text`)
  }

  const text = `${lines.join('\n')}\n`
  const durationSeconds = roundTo((cursor - startFrame) / rate.fps, 6)
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds,
    frameRate: rate.id,
    frameRateLabel: rate.label,
    dropFrame: rate.dropFrame,
    recordStart: timecodeFromFrames(startFrame, rate),
    trackType
  }
}

/* --------------------------------------------------------------- edl read -- */

/** One CMX3600 event line: number, reel, track, edit, then four timecodes. */
const EDL_EVENT_LINE = /^(\d{2,6})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s+(\d{2}:\d{2}:\d{2}[:;]\d{2})\s*$/

/**
 * Parse an EDL back into events.
 *
 * The writer is only trustworthy if it can be read: the tool layer parses every
 * EDL it writes and refuses to report success when the two disagree, which is
 * the same contract `lib/midi.js` follows. `*` lines stay attached to the event
 * above them, which is how `FROM CLIP NAME` recovers the media name.
 *
 * @param {string} text - EDL text.
 * @returns {{ title: string|null, fcm: string|null, dropFrame: boolean,
 *   events: object[], warnings: string[] }} the parsed event list.
 */
export function parseEdl (text) {
  if (typeof text !== 'string' || text.trim() === '') fail('edl', 'cannot parse an empty EDL')
  const result = { title: null, fcm: null, dropFrame: false, events: [], warnings: [] }
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (line.startsWith('TITLE:')) {
      result.title = line.slice(6).trim()
      continue
    }
    if (line.startsWith('FCM:')) {
      result.fcm = line.slice(4).trim()
      result.dropFrame = /drop/i.test(result.fcm) && !/non-?drop/i.test(result.fcm)
      continue
    }
    const match = EDL_EVENT_LINE.exec(line)
    if (match !== null) {
      current = {
        number: Number(match[1]),
        reel: match[2],
        track: match[3],
        editType: match[4],
        srcIn: match[5],
        srcOut: match[6],
        recIn: match[7],
        recOut: match[8],
        clipName: null,
        sourceFile: null,
        cueName: null,
        notes: []
      }
      result.events.push(current)
      continue
    }
    if (line.startsWith('*')) {
      const body = line.slice(1).trim()
      const separator = body.indexOf(':')
      const key = (separator === -1 ? body : body.slice(0, separator)).trim().toUpperCase()
      const value = separator === -1 ? '' : body.slice(separator + 1).trim()
      if (current !== null) {
        if (key === 'FROM CLIP NAME') current.clipName = value
        else if (key === 'SOURCE FILE' || key === 'FROM FILE') current.sourceFile = value
        else if (key === 'CUE NAME') current.cueName = value
        else if (key === 'CUE LEVEL' || key === 'NOTE') current.notes.push(value)
      }
      continue
    }
    result.warnings.push(`unrecognised EDL line: ${line.slice(0, 60)}`)
  }
  if (result.events.length === 0 && result.title === null && result.fcm === null) fail('edl', 'no CMX3600 content found')
  return result
}

/* -------------------------------------------------------------------- rpp -- */

/**
 * An RPP string field.
 *
 * REAPER parses bare tokens and `"quoted"` strings; it has no escape sequence,
 * so a value that contains a double quote cannot be represented faithfully. The
 * quote is replaced by an apostrophe (a name is a label, not a path) rather than
 * producing a project the parser would read as a different name.
 */
function rppString (value) {
  const text = singleLine(value).replace(/"/g, "'")
  if (text !== '' && /^[A-Za-z0-9_.-]+$/.test(text)) return text
  return `"${text}"`
}

/** An RPP media path: always quoted, always forward slashes. */
function rppPath (value) {
  const text = singleLine(value).replace(/\\/g, '/').replace(/"/g, '')
  return `"${text}"`
}

/**
 * Export a stem (or cue) set as a REAPER project.
 *
 * The written project is deliberately small: one `<TRACK` per entry, one
 * `<ITEM` with a `<SOURCE WAVE` inside it. Every field that carries the timing
 * and level the caller asked for is written explicitly rather than left to a
 * default: `POSITION`, `LENGTH`, `SOFFS 0`, `VOLPAN` (item gain as a linear
 * multiplier, so -6 dB is 0.501187), and the two fade fields.
 *
 * @param {object} request
 * @param {Array<object>} request.tracks - `[{ name, path, offsetSeconds, duration, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {number} [request.sampleRate] - project rate, 8000..96000, default 44100.
 * @param {number} [request.bpm] - project tempo, 20..300, default 120.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number, tracks: number, sampleRate: number, bpm: number }}
 */
export function exportReaper (request = {}) {
  const caller = 'rpp'
  const sampleRate = Math.round(readRange(caller, 'sampleRate', request.sampleRate, 44100, 8000, 96000))
  const bpm = readRange(caller, 'bpm', request.bpm, 120, 20, 300)
  const { entries, warnings } = normalizeTracks(request.tracks)

  const lines = [
    `<REAPER_PROJECT 0.1 "${RPP_PROJECT_VERSION}" ${RPP_EPOCH}`,
    '  RIPPLE 0 0',
    '  PROJOFFS 0 0 0',
    `  SAMPLERATE ${sampleRate} 0 0`,
    `  TEMPO ${numberText(bpm, 3)} 4 4`
  ]
  for (const track of entries) {
    lines.push('  <TRACK')
    lines.push(`    NAME ${rppString(track.name)}`)
    lines.push('    <ITEM')
    lines.push(`      POSITION ${numberText(track.offsetSeconds)}`)
    lines.push('      SNAPOFFS 0')
    lines.push(`      LENGTH ${numberText(track.duration)}`)
    lines.push('      LOOP 0')
    lines.push(`      FADEIN 1 ${numberText(track.fadeIn)} 0 1 0 0 0`)
    lines.push(`      FADEOUT 1 ${numberText(track.fadeOut)} 0 1 0 0 0`)
    lines.push('      MUTE 0 0')
    lines.push('      SEL 0')
    lines.push(`      NAME ${rppString(track.name)}`)
    // Item volume is a linear multiplier in RPP, not dB.
    lines.push(`      VOLPAN ${numberText(dbToGain(track.gainDb), 6)} 0 1 -1`)
    lines.push('      SOFFS 0')
    lines.push('      <SOURCE WAVE')
    lines.push(`        FILE ${rppPath(track.path)}`)
    lines.push('      >')
    lines.push('    >')
    lines.push('  >')
  }
  lines.push('>')

  const text = `${lines.join('\n')}\n`
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds: timelineEnd(entries.map((track) => ({ offsetSeconds: track.offsetSeconds, duration: track.duration }))),
    tracks: entries.length,
    sampleRate,
    bpm
  }
}

/**
 * Parse a REAPER project back into project settings and items.
 *
 * Only the subset this module writes is interpreted (project `SAMPLERATE` and
 * `TEMPO`, per-track `NAME`, per-item `POSITION`/`LENGTH`/`SOFFS`/`VOLPAN`/
 * fades and the `<SOURCE WAVE` `FILE`), which is exactly enough to prove the
 * writer correct. Unknown chunks are skipped, so a real REAPER project also
 * parses without error.
 *
 * @param {string} text - RPP text.
 * @returns {{ sampleRate: number|null, bpm: number|null, tracks: object[],
 *   balanced: boolean, lines: number }} the parsed structure.
 */
export function parseRpp (text) {
  if (typeof text !== 'string' || text.trim() === '') fail('rpp', 'cannot parse an empty project')
  const result = { sampleRate: null, bpm: null, tracks: [], balanced: true, lines: 0 }
  const stack = []
  let track = null
  let item = null
  const assign = (key, value) => {
    const top = stack.length === 0 ? '' : stack[stack.length - 1]
    if (top === 'REAPER_PROJECT') {
      if (key === 'SAMPLERATE') result.sampleRate = Number(value.split(/\s+/)[0])
      else if (key === 'TEMPO') result.bpm = Number(value.split(/\s+/)[0])
      return
    }
    if (top === 'TRACK' && track !== null) {
      if (key === 'NAME') track.name = unquote(value)
      return
    }
    if (top === 'SOURCE' && item !== null) {
      if (key === 'FILE') item.file = unquote(value)
      return
    }
    if (top !== 'ITEM' || item === null) return
    if (key === 'POSITION') item.position = Number(value.split(/\s+/)[0])
    else if (key === 'LENGTH') item.length = Number(value.split(/\s+/)[0])
    else if (key === 'SOFFS') item.soffs = Number(value.split(/\s+/)[0])
    else if (key === 'NAME') item.name = unquote(value)
    else if (key === 'VOLPAN') {
      const parts = value.split(/\s+/)
      item.volume = Number(parts[0])
      item.pan = Number(parts[1])
    } else if (key === 'FADEIN') {
      const parts = value.split(/\s+/)
      item.fadeIn = Number(parts[1])
    } else if (key === 'FADEOUT') {
      const parts = value.split(/\s+/)
      item.fadeOut = Number(parts[1])
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    result.lines += 1
    if (line.startsWith('<')) {
      const token = line.slice(1).split(/\s+/)[0].toUpperCase()
      stack.push(token)
      if (token === 'TRACK') {
        track = { name: null, items: [] }
        result.tracks.push(track)
        item = null
      } else if (token === 'ITEM' && track !== null) {
        item = { position: 0, length: 0, soffs: 0, volume: 1, pan: 0, fadeIn: 0, fadeOut: 0, name: null, file: null }
        track.items.push(item)
      }
      continue
    }
    if (line === '>') {
      const token = stack.pop()
      if (token === undefined) {
        result.balanced = false
        continue
      }
      if (token === 'ITEM') item = null
      else if (token === 'TRACK') {
        track = null
        item = null
      }
      continue
    }
    const space = line.indexOf(' ')
    const key = (space === -1 ? line : line.slice(0, space)).toUpperCase()
    const value = space === -1 ? '' : line.slice(space + 1).trim()
    assign(key, value)
  }
  if (stack.length > 0) result.balanced = false
  return result
}

/** Strip the surrounding quotes of an RPP string field. */
function unquote (value) {
  const text = String(value).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

/* -------------------------------------------------------------------- csv -- */

/**
 * Quote one CSV field per RFC4180.
 *
 * A field is quoted when it contains a comma, a double quote or a line break,
 * or when it has leading/trailing whitespace that must survive. Double quotes
 * are doubled. This is the whole of RFC4180's field syntax; the record
 * separator is `\n` instead of CRLF on purpose (every spreadsheet accepts it,
 * and one line terminator across all four formats keeps the exports uniform).
 */
function csvField (value) {
  const text = String(value === undefined || value === null ? '' : value)
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * Export a cue set as an RFC4180 CSV cue sheet.
 *
 * Columns are fixed: `name,path,at,duration,gainDb,fadeIn,fadeOut`. Rows are
 * sorted by `at`, numbers are plain decimals (never `1,5` — no locale), and a
 * cue without a path keeps an empty path cell instead of being dropped, because
 * a cue sheet is also useful before any audio exists.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, path, at, duration, ... }]`.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number }}
 */
export function exportCsv (request = {}) {
  const caller = 'csv'
  const { entries, warnings } = normalizeCues(caller, request.cues)
  const lines = ['name,path,at,duration,gainDb,fadeIn,fadeOut']
  for (const cue of entries) {
    lines.push([
      cue.name,
      cue.path === undefined ? '' : cue.path,
      numberText(cue.at),
      numberText(cue.duration === undefined ? 0 : cue.duration),
      numberText(cue.gainDb),
      numberText(cue.fadeIn),
      numberText(cue.fadeOut)
    ].map(csvField).join(','))
  }
  const text = `${lines.join('\n')}\n`
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds: timelineEnd(entries)
  }
}

/* ----------------------------------------------------------------- labels -- */

/**
 * Export a cue set as an Audacity label track.
 *
 * One line per label: `start<TAB>end<TAB>name`, sorted by start. Audacity's
 * importer treats a tab as the field separator and offers no escape, so a tab
 * inside a name becomes a space (and is reported). A cue with no duration is
 * written as a 1 ms label rather than a zero-width one, which Audacity drops.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, at, duration, ... }]`.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number }}
 */
export function exportLabels (request = {}) {
  const caller = 'labels'
  const { entries, warnings } = normalizeCues(caller, request.cues)
  const lines = []
  let pointLabels = 0
  for (const cue of entries) {
    let end = cue.duration === undefined ? cue.at : cue.at + cue.duration
    if (!(end > cue.at)) {
      end = cue.at + LABEL_MIN_SECONDS
      pointLabels += 1
    }
    lines.push(`${numberText(cue.at)}\t${numberText(end)}\t${cue.name}`)
  }
  if (pointLabels > 0) warnings.push(`${pointLabels} cue(s) had no duration; a ${numberText(LABEL_MIN_SECONDS)} s label was written because Audacity drops zero width labels`)
  const text = `${lines.join('\n')}\n`
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds: timelineEnd(entries)
  }
}

/* --------------------------------------------------------------- dispatch -- */

/**
 * The exporter behind each format name.
 *
 * A table instead of a chain of ternaries: the keys have to match
 * `EXPORT_FORMATS`, and `exportProject` resolves both the name and the extension
 * from the same list, so a format cannot be advertised without an implementation.
 * The FCP7 writer resolves its own frame rate (it has its own default of 25 fps
 * and its own accepted set including 50/60/23.976), which is why the raw request
 * is passed through untouched.
 */
const EXPORTERS = Object.freeze({
  edl: exportEdl,
  rpp: exportReaper,
  csv: exportCsv,
  labels: exportLabels,
  aaf: exportAaf,
  omf: exportOmf,
  otio: exportOtio,
  xmeml: exportXmeml
})

/**
 * Export a project in one of the eight formats.
 *
 * One entry point for the tool layer, so the format name, the extension and the
 * error message stay in one place. Every format returns the same envelope plus
 * its own extras; `text` is always `\n`-terminated and `bytes` is its UTF-8
 * length on disk — except the binary formats (`aaf`, `omf`), which return a
 * `buffer` instead and set `binary: true`, because a container format is not a
 * string and pretending otherwise would corrupt it.
 *
 * @param {object} request - `{ format, ... }`, where the rest is the argument
 *   object of the chosen exporter (`cues` for most, `tracks` for rpp).
 * @param {'edl'|'rpp'|'csv'|'labels'|'aaf'|'omf'|'otio'|'xmeml'} request.format
 * @returns {{ text?: string, buffer?: Buffer, binary: boolean, bytes: number,
 *   format: string, extension: string, warnings: string[], events: number,
 *   durationSeconds: number }}
 */
export function exportProject (request = {}) {
  const requested = request.format === undefined || request.format === null ? '' : String(request.format).trim().toLowerCase()
  if (!EXPORT_FORMATS.includes(requested)) {
    fail('daw', `format must be one of ${EXPORT_FORMATS.join(', ')}, got ${describeValue(request.format)}`)
  }
  const result = EXPORTERS[requested](request)
  const binary = Buffer.isBuffer(result.buffer)
  return {
    ...result,
    binary,
    bytes: binary ? result.buffer.length : Buffer.byteLength(result.text, 'utf8'),
    format: requested,
    extension: EXPORT_EXTENSIONS[requested]
  }
}
