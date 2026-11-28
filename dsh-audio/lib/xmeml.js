/**
 * FCP7 XML (`xmeml`) export — the interchange format Premiere Pro and DaVinci
 * Resolve import directly, with no plugin and no adapter installed.
 *
 * The format is Final Cut Pro 7's project XML: one `<sequence>` with frame-based
 * timing, a `<clipitem>` per clip carrying `<start>/<end>` on the sequence
 * timeline and `<in>/<out>` inside its source file, a `<file>` element holding
 * the media reference, and `<filter>` elements for effects. It is old, verbose
 * and only loosely specified — but it is the one *textual* format that opens in
 * both NLEs named above, which makes it the practical companion to the OTIO
 * export (that one needs an adapter; this one does not).
 *
 * What is carried faithfully:
 *
 * - clip order, position and duration, quantised to the sequence frame rate;
 * - the media path as a `file://` URL (Premiere links by `<pathurl>`). A plain
 *   OS path is converted with `pathToFileURL`, so Windows backslashes, spaces
 *   and non-ASCII file names arrive percent-encoded instead of raw;
 * - the clip name, and a `<comment>` when the cue name differs from the file;
 * - audio gain through the standard `Audio Levels` filter, whose `level`
 *   parameter is a linear multiplier (1.0 = unity). UNIT TO BE VERIFIED: the
 *   linear multiplier is the documented meaning of the `audiolevels` effect id,
 *   but this writer has not been checked against an xmeml exported by a real
 *   FCP7 (or by Premiere), so do not "fix" the conversion on a guess; compare
 *   the `<value>` against a reference document first;
 * - per-clip source in/out, so a trimmed item stays trimmed.
 *
 * What is not: fades. FCP7 XML expresses a fade as an `<transitionitem>` with a
 * `Cross Fade (Audio)` effect, which editors interpret differently and which
 * would claim a shape the caller never asked for. The export reports them as
 * unapplied instead of inventing a transition.
 *
 * Frame quantisation: `<start>`/`<end>` are integer frame counts, so a cue at
 * 0.25 s on a 25 fps sequence lands at frame 6 (0.24 s). The writer reports the
 * worst-case error in the result; sub-frame exactness is what the OTIO export is
 * for, and a sound designer should use OTIO or AAF when the trim matters.
 */

import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dbToGain } from './dsp.js'

/** Sequence frame rates this writer accepts, mapped to their `timebase` integer. */
const FRAME_RATES = Object.freeze({
  24: { timebase: 24, ntsc: false, label: '24 fps' },
  25: { timebase: 25, ntsc: false, label: '25 fps' },
  30: { timebase: 30, ntsc: false, label: '30 fps' },
  50: { timebase: 50, ntsc: false, label: '50 fps' },
  60: { timebase: 60, ntsc: false, label: '60 fps' },
  '29.97': { timebase: 30, ntsc: true, label: '29.97 fps NTSC' },
  '23.976': { timebase: 24, ntsc: true, label: '23.976 fps NTSC' }
})

/** Video geometry written when the caller does not supply one (Resolve wants it). */
const DEFAULT_VIDEO = Object.freeze({ width: 1920, height: 1080 })

/** Gain bounds shared with the EDL and RPP writers (`MIX_GAIN_LIMITS_DB`). */
const MIN_GAIN_DB = -120
const MAX_GAIN_DB = 24

/** XML document prologue every FCP7 XML import expects. */
const XML_PROLOGUE = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n'

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

function fail (caller, message) {
  throw new Error(`${caller}: ${message}`)
}

/** Read an optional number, rejecting values that have no meaning (`NaN`). */
function readNumber (caller, label, value, fallback) {
  if (value === undefined || value === null) return fallback
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

/**
 * Read an optional number inside `[min, max]`.
 *
 * Gain goes through this before it reaches `dbToGain`, so a `NaN` or an
 * out-of-range level is a readable error instead of `<value>NaN</value>` in a
 * document the editor then refuses to import.
 */
function readRange (caller, label, value, fallback, min, max) {
  const number = readNumber(caller, label, value, fallback)
  if (number < min || number > max) fail(caller, `${label} must be between ${min} and ${max}, got ${number}`)
  return number
}

/** Collapse control characters: XML 1.0 cannot carry them at all. */
function singleLineText (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Escape the five characters XML reserves, so any cue name round-trips. */
function xmlText (value) {
  return singleLineText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Deterministic, locale-free decimal text with `digits` decimals. */
function numberText (value, digits = 6) {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits
  if (rounded === 0) return '0'
  return String(rounded)
}

/** Basename of a path written with either separator, for `<file><name>`. */
function pathBasename (path) {
  return basename(String(path).replace(/\\/g, '/'))
}

/** Basename of a URL's pathname, decoded; the fallback when there is no path. */
function urlBasename (url, fallback) {
  try {
    return decodeURIComponent(pathBasename(new URL(url).pathname)) || fallback
  } catch {
    return fallback
  }
}

/**
 * The `<pathurl>` value for a media reference.
 *
 * Premiere and Resolve resolve a clip by `<pathurl>`, and it has to be a URL: a
 * raw OS path (Windows backslashes, an unencoded space, a Chinese file name) is
 * not one, and the relink fails without a usable error. `pathToFileURL` turns
 * the separators into `/` and percent-encodes everything a URL cannot carry. A
 * relative path is resolved against the process working directory, which is the
 * only base a pure writer can assume; the tool layer passes an absolute `url`
 * (built from the session's absolute media path) and that value is trusted.
 */
function mediaUrl (path, url) {
  if (url !== '') return url
  if (path === '') return ''
  if (/^(?:file|https?):/i.test(path)) return path
  return pathToFileURL(path).href
}

/** The `<file><name>` value: the media file's basename, never a whole path. */
function mediaName (path, url, fallback) {
  if (path !== '') return pathBasename(path)
  if (url !== '') return urlBasename(url, fallback)
  return fallback
}

/** Spellings accepted for the sequence frame rate, mapped to a table key. */
const FRAME_RATE_ALIASES = Object.freeze({
  24: '24',
  25: '25',
  30: '30',
  50: '50',
  60: '60',
  '29.97': '29.97',
  '23.976': '23.976',
  '23.98': '23.976',
  '24fps': '24',
  '25fps': '25',
  '30fps': '30',
  '50fps': '50',
  '60fps': '60',
  '29.97fps': '29.97',
  '29.97df': '29.97',
  '23.976fps': '23.976',
  film: '24',
  pal: '25',
  ntsc: '29.97',
  drop: '29.97'
})

/** Resolve the sequence rate from a number, a numeric string or an alias. */
function readFrameRate (caller, value) {
  if (value !== null && typeof value === 'object' && typeof value.nominalFps === 'number') {
    // An EDL rate descriptor may also arrive (the tool layer resolves
    // `frameRate` through the CMX3600 table first); convert it back to the
    // xmeml spelling so NTSC sequences keep their `ntsc` flag.
    const key = value.dropFrame === true ? '29.97' : String(value.nominalFps)
    const entry = FRAME_RATES[key]
    if (entry !== undefined) return { ...entry, fps: value.fps ?? entry.timebase }
  }
  if (value === undefined || value === null || value === '') return { ...FRAME_RATES[25], fps: 25 }
  const requested = String(value).trim().toLowerCase()
  const key = FRAME_RATE_ALIASES[requested]
  const entry = key === undefined ? undefined : FRAME_RATES[key]
  if (entry === undefined) {
    fail(caller, `unsupported frameRate ${JSON.stringify(String(value))}; use 24, 25, 30, 50, 60, 23.976 or 29.97`)
  }
  const fps = key === '29.97' ? 30000 / 1001 : key === '23.976' ? 24000 / 1001 : entry.timebase
  return { ...entry, fps }
}

/** `HH:MM:SS:FF` for a frame count at the sequence timebase (XML timecode needs text). */
function timecodeText (frames, timebase, dropFrame) {
  const nominal = timebase
  let labelled = frames
  if (dropFrame) {
    // 29.97 drop-frame label skipping, as in the EDL writer: two labels are
    // skipped at every minute except every tenth.
    const dropFrames = 2
    const framesPerMinute = nominal * 60 - dropFrames
    const framesPer10Minutes = nominal * 600 - dropFrames * 9
    const blocks = Math.floor(frames / framesPer10Minutes)
    const remainder = frames % framesPer10Minutes
    const skipped = remainder > dropFrames
      ? dropFrames * 9 * blocks + dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute)
      : dropFrames * 9 * blocks
    labelled = frames + skipped
  }
  const ff = labelled % nominal
  const totalSeconds = Math.floor(labelled / nominal)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600) % 24
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${dropFrame ? ';' : ':'}${pad(ff)}`
}

/** Seconds to whole frames, rounding half up so a cut lands where it was asked. */
function framesOf (seconds, rate) {
  return Math.round(seconds * rate)
}

/** `<rate>` element text shared by the sequence, the clips and the file. */
function rateBlock (rate, indent) {
  return `${indent}<rate>\n${indent}  <timebase>${rate.timebase}</timebase>\n${indent}  <ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${indent}</rate>`
}

/**
 * Export a cue set as a Final Cut Pro 7 XML sequence.
 *
 * One `<track>` per lane: FCP7 audio tracks cannot hold two overlapping
 * clipitems, so cues are packed into the minimum number of lanes (the same
 * interval partitioning the AAF and OTIO writers use). A caller that knows its
 * cues never overlap gets exactly one track.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, path?, url?, at, duration, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {number|object} [request.frameRate] - 24 (default 25), 25, 30, 50, 60, 23.976, 29.97.
 * @param {number} [request.sampleRate] - declared media sample rate, default 48000.
 * @param {string} [request.title] - sequence name.
 * @param {{width: number, height: number}} [request.video] - sequence geometry.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number, frames: number, timebase: number, ntsc: boolean, tracks: number }}
 */
export function exportXmeml (request = {}) {
  const caller = 'xmeml'
  const cues = request.cues
  if (!Array.isArray(cues) || cues.length === 0) {
    fail(caller, 'cues must be a non-empty array of { name, path, at, duration }')
  }
  if (cues.length > 20000) fail(caller, `${cues.length} cues exceeds the 20000 event limit`)
  const rate = readFrameRate(caller, request.frameRate)
  const sampleRate = Math.round(Number(request.sampleRate ?? 48000))
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
    fail(caller, `sampleRate must be between 1000 and 384000, got ${describeValue(request.sampleRate)}`)
  }
  const video = {
    width: Math.round(Number(request.video?.width ?? DEFAULT_VIDEO.width)),
    height: Math.round(Number(request.video?.height ?? DEFAULT_VIDEO.height))
  }
  const warnings = []

  const entries = cues.map((cue, index) => {
    const label = `cue ${index + 1}`
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) fail(caller, `${label} must be an object`)
    const at = Number(cue.at ?? 0)
    const duration = Number(cue.duration)
    if (!Number.isFinite(at) || at < 0) fail(caller, `${label} at must be a non-negative finite number, got ${describeValue(cue.at)}`)
    if (!Number.isFinite(duration) || duration <= 0) fail(caller, `${label} duration must be greater than 0, got ${describeValue(cue.duration)}`)
    const path = singleLineText(cue.path)
    const url = singleLineText(cue.url)
    const name = singleLineText(cue.name) || (path === '' ? `Cue ${index + 1}` : pathBasename(path).replace(/\.[^.]+$/, ''))
    const startFrame = framesOf(at, rate.fps)
    const endFrame = Math.max(startFrame + 1, framesOf(at + duration, rate.fps))
    return {
      index,
      name,
      path,
      url,
      pathUrl: mediaUrl(path, url),
      mediaName: mediaName(path, url, name),
      at,
      duration,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      gainDb: readRange(caller, `${label} gainDb`, cue.gainDb, 0, MIN_GAIN_DB, MAX_GAIN_DB),
      fadeIn: Number(cue.fadeIn ?? 0),
      fadeOut: Number(cue.fadeOut ?? 0)
    }
  })

  let worstQuantisation = 0
  for (const entry of entries) {
    worstQuantisation = Math.max(
      worstQuantisation,
      Math.abs(entry.startFrame / rate.fps - entry.at),
      Math.abs(entry.endFrame / rate.fps - (entry.at + entry.duration))
    )
  }
  if (worstQuantisation > 1e-9) {
    warnings.push(`times were quantised to whole frames at ${rate.label}: the worst cut moved ${(worstQuantisation * 1000).toFixed(1)} ms (a frame is ${(1000 / rate.fps).toFixed(2)} ms); use otio for sample-accurate placement`)
  }
  const faded = entries.filter((entry) => entry.fadeIn > 0 || entry.fadeOut > 0).length
  if (faded > 0) {
    warnings.push(`${faded} cue(s) have a fade; FCP7 XML expresses fades as audio transitions, which this writer does not emit — apply the fades in the editor (the gains are written)`)
  }
  const missing = entries.filter((entry) => entry.url === '' && entry.path === '').length
  if (missing > 0) warnings.push(`${missing} cue(s) have no media path; their <file> element will not resolve`)

  // Lane packing: a lane becomes one <track>.
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (left.entry.at === right.entry.at ? left.index - right.index : left.entry.at - right.entry.at))
  const lanes = []
  const laneEnds = []
  for (const item of ordered) {
    let lane = laneEnds.findIndex((end) => end <= item.entry.startFrame)
    if (lane === -1) {
      lane = lanes.length
      lanes.push([])
      laneEnds.push(0)
    }
    lanes[lane].push(item.entry)
    laneEnds[lane] = item.entry.endFrame
  }
  if (lanes.length > 1) {
    warnings.push(`${entries.length} cues overlapped, so they were packed into ${lanes.length} audio tracks (one FCP7 track cannot hold two clips at the same time)`)
  }

  const totalFrames = Math.max(0, ...entries.map((entry) => entry.endFrame))
  const dropFrame = rate.ntsc === true && rate.timebase === 30
  const lines = []
  lines.push(XML_PROLOGUE.trimEnd())
  lines.push('<xmeml version="4">')
  lines.push('  <sequence id="sequence-1">')
  lines.push(`    <name>${xmlText(singleLineText(request.title) || 'dsh-audiokit timeline')}</name>`)
  lines.push(`    <duration>${totalFrames}</duration>`)
  lines.push(rateBlock(rate, '    '))
  lines.push('    <timecode>')
  lines.push(rateBlock(rate, '      '))
  lines.push(`      <string>${timecodeText(0, rate.timebase, dropFrame)}</string>`)
  lines.push('      <frame>0</frame>')
  lines.push(`      <displayformat>${dropFrame ? 'DF' : 'NDF'}</displayformat>`)
  lines.push('    </timecode>')
  lines.push('    <media>')
  lines.push('      <video>')
  lines.push('        <format>')
  lines.push('          <samplecharacteristics>')
  lines.push(rateBlock(rate, '            '))
  lines.push(`            <width>${video.width}</width>`)
  lines.push(`            <height>${video.height}</height>`)
  lines.push('            <anamorphic>FALSE</anamorphic>')
  lines.push('            <pixelaspectratio>square</pixelaspectratio>')
  lines.push('            <fielddominance>none</fielddominance>')
  lines.push('          </samplecharacteristics>')
  lines.push('        </format>')
  lines.push('      </video>')
  lines.push('      <audio>')
  lines.push('        <format>')
  lines.push('          <samplecharacteristics>')
  lines.push('            <depth>16</depth>')
  lines.push(`            <samplerate>${sampleRate}</samplerate>`)
  lines.push('          </samplecharacteristics>')
  lines.push('        </format>')

  let clipItemCount = 0
  let fileCount = 0
  for (const lane of lanes) {
    lines.push('        <track>')
    for (const entry of lane) {
      clipItemCount += 1
      const fileId = (fileCount += 1)
      const level = dbToGain(entry.gainDb)
      lines.push(`          <clipitem id="clipitem-${clipItemCount}">`)
      lines.push(`            <name>${xmlText(entry.name)}</name>`)
      lines.push('            <enabled>TRUE</enabled>')
      lines.push(`            <duration>${entry.durationFrames}</duration>`)
      lines.push(rateBlock(rate, '            '))
      lines.push(`            <start>${entry.startFrame}</start>`)
      lines.push(`            <end>${entry.endFrame}</end>`)
      lines.push('            <in>0</in>')
      lines.push(`            <out>${entry.durationFrames}</out>`)
      lines.push(`            <file id="file-${fileId}">`)
      const baseName = entry.mediaName
      lines.push(`              <name>${xmlText(baseName)}</name>`)
      if (entry.pathUrl !== '') lines.push(`              <pathurl>${xmlText(entry.pathUrl)}</pathurl>`)
      lines.push(rateBlock(rate, '              '))
      lines.push(`              <duration>${entry.durationFrames}</duration>`)
      lines.push('              <timecode>')
      lines.push(rateBlock(rate, '                '))
      lines.push(`                <string>${timecodeText(0, rate.timebase, dropFrame)}</string>`)
      lines.push('                <frame>0</frame>')
      lines.push(`                <displayformat>${dropFrame ? 'DF' : 'NDF'}</displayformat>`)
      lines.push('              </timecode>')
      lines.push('              <media>')
      lines.push('                <audio>')
      lines.push('                  <samplecharacteristics>')
      lines.push('                    <depth>16</depth>')
      lines.push(`                    <samplerate>${sampleRate}</samplerate>`)
      lines.push('                  </samplecharacteristics>')
      lines.push('                  <channelcount>1</channelcount>')
      lines.push('                </audio>')
      lines.push('              </media>')
      lines.push('            </file>')
      lines.push('            <sourcetrack>')
      lines.push('              <mediatype>audio</mediatype>')
      lines.push('              <trackindex>1</trackindex>')
      lines.push('            </sourcetrack>')
      if (entry.gainDb !== 0) {
        // The standard FCP7 audio level filter; Premiere and Resolve both map it
        // to the clip's volume, and the value is a linear amplitude multiplier.
        lines.push('            <filter>')
        lines.push('              <effect>')
        lines.push('                <name>Audio Levels</name>')
        lines.push('                <effectid>audiolevels</effectid>')
        lines.push('                <effectcategory>audio</effectcategory>')
        lines.push('                <effecttype>audiolevels</effecttype>')
        lines.push('                <mediatype>audio</mediatype>')
        lines.push('                <parameter>')
        lines.push('                  <parameterid>level</parameterid>')
        lines.push('                  <name>Level</name>')
        lines.push(`                  <value>${numberText(level, 6)}</value>`)
        lines.push('                </parameter>')
        lines.push('              </effect>')
        lines.push('            </filter>')
      }
      if (entry.name !== baseName.replace(/\.[^.]+$/, '')) {
        lines.push(`            <comment>${xmlText(entry.name)}</comment>`)
      }
      lines.push('          </clipitem>')
    }
    lines.push('        </track>')
  }
  lines.push('      </audio>')
  lines.push('    </media>')
  lines.push('  </sequence>')
  lines.push('</xmeml>')

  const text = `${lines.join('\n')}\n`
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds: Math.round((totalFrames / rate.fps) * 1e6) / 1e6,
    frames: totalFrames,
    timebase: rate.timebase,
    ntsc: rate.ntsc,
    frameRateLabel: rate.label,
    sampleRate,
    tracks: lanes.length
  }
}

/**
 * Parse an `xmeml` document written by `exportXmeml` back into clips.
 *
 * A deliberately small reader — `<sequence>`, `<track>`, `<clipitem>`,
 * `<file>/<pathurl>` and the `Audio Levels` parameter — which is exactly enough
 * to prove the writer correct without pulling an XML parser into a
 * zero-dependency plugin. Anything it does not recognise is ignored, so a real
 * FCP7 XML file also parses.
 *
 * @param {string} text
 * @returns {{ name: string|null, duration: number|null, tracks: Array<{clips: object[]}>, warnings: string[] }}
 */
export function parseXmeml (text) {
  const caller = 'xmeml'
  if (typeof text !== 'string' || text.trim() === '') fail(caller, 'cannot parse an empty document')
  if (!/<xmeml\b/.test(text)) fail(caller, 'no <xmeml> element found')
  /** Read the text content of the first `<tag …>` inside `source`. */
  const contentOf = (source, tag) => {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(source)
    return match === null ? null : match[1]
  }
  const numberFrom = (source, tag) => {
    const value = contentOf(source, tag)
    return value === null ? null : Number(value)
  }
  const warnings = []
  const sequence = contentOf(text, 'sequence')
  if (sequence === null) fail(caller, 'no <sequence> element found')
  const name = contentOf(sequence, 'name')
  const duration = numberFrom(sequence, 'duration')
  const rateText = contentOf(sequence, 'rate') ?? ''
  const timebase = numberFrom(rateText, 'timebase')
  if (timebase === null) warnings.push('the sequence has no <rate>/<timebase>; frame positions cannot be converted to seconds')
  const ntsc = /<ntsc>TRUE<\/ntsc>/.test(rateText)
  const fps = timebase === null ? 1 : (ntsc ? timebase * 1000 / 1001 : timebase)

  const tracks = []
  const trackPattern = /<track(?:\s[^>]*)?>([\s\S]*?)<\/track>/g
  let trackMatch
  while ((trackMatch = trackPattern.exec(sequence)) !== null) {
    const body = trackMatch[1]
    if (/<clipitem\b/.test(body) === false) continue
    const clips = []
    const clipPattern = /<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g
    let clipMatch
    while ((clipMatch = clipPattern.exec(body)) !== null) {
      const clipBody = clipMatch[1]
      const start = numberFrom(clipBody, 'start')
      const end = numberFrom(clipBody, 'end')
      if (start === null || end === null) {
        warnings.push('a clipitem has no <start>/<end>; it was skipped')
        continue
      }
      const fileBody = contentOf(clipBody, 'file') ?? ''
      const levelMatch = /<parameterid>level<\/parameterid>[\s\S]*?<value>([^<]*)<\/value>/.exec(clipBody)
      clips.push({
        name: contentOf(clipBody, 'name'),
        start,
        end,
        at: start / fps,
        duration: (end - start) / fps,
        in: numberFrom(clipBody, 'in'),
        out: numberFrom(clipBody, 'out'),
        pathUrl: contentOf(fileBody, 'pathurl'),
        gainDb: levelMatch === null ? null : 20 * Math.log10(Number(levelMatch[1]))
      })
    }
    tracks.push({ clips })
  }
  return { name, duration, timebase, ntsc, tracks, warnings }
}
