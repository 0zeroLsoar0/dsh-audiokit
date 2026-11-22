/**
 * `audio_daw`: hand a cue set or a stem set to a DAW, an NLE or a spreadsheet.
 *
 * `audio_bind` keeps a cue set inside one HTML page and `audio_stems` writes the
 * layers as wavs, but there was no way to say "here is the timeline, open it in
 * your editor". This tool is that hand-off: it writes a CMX3600 EDL, a REAPER
 * project, an RFC4180 CSV cue sheet or an Audacity label track.
 *
 * Two things it does that a naive file writer would not:
 *
 * 1. It reads back every project it writes (`parseEdl` / `parseRpp`) and refuses
 *    to report success when the writer and the reader disagree. A broken EDL
 *    fails silently inside an NLE, so the check has to happen here.
 * 2. It measures the duration of each media file from the RIFF header, because
 *    RPP stores an item LENGTH. Reading the whole file through the engine's
 *    `readTrack` to learn one number would cost hundreds of megabytes for a
 *    stem set; walking the chunks costs one 8 KB read per file.
 *
 * Paths are written so a project can find its media: CSV and EDL carry the
 * working-directory-relative path, while the RPP gets paths relative to the
 * directory the project is written into (which is what REAPER resolves them
 * against).
 */

import { open, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import {
  EXPORT_EXTENSIONS,
  EXPORT_FORMATS,
  exportProject,
  parseEdl,
  parseRpp,
  timecodeToSeconds
} from './daw.js'

/** Human name per format, used in the result line a model reads. */
const FORMAT_LABELS = Object.freeze({
  edl: 'CMX3600 EDL',
  rpp: 'REAPER project',
  csv: 'CSV cue sheet',
  labels: 'Audacity label track'
})

/** A tool result is a summary: past this many warnings the rest is counted. */
const MAX_WARNINGS = 8

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : String(path).split('\\').join('/')
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

function fmt (value, digits = 2) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function sizeText (bytes) {
  if (bytes >= 1024 * 1024) return `${fmt(bytes / 1024 / 1024, 2)} MB`
  return `${fmt(bytes / 1024, 1)} KB`
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

function describeError (error) {
  return error instanceof Error ? error.message : String(error)
}

/** Reject a non-numeric argument early instead of writing a NaN into a project. */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  return number
}

/** The one place a bad `format` is turned into a readable list of choices. */
function readFormat (value) {
  const format = value === undefined || value === null ? '' : String(value).trim().toLowerCase()
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(
      `audio_daw: format must be one of ${EXPORT_FORMATS.join(', ')}, got ${describeValue(value)} ` +
      '(edl=cut list for a video editor, rpp=REAPER project, csv=cue sheet, labels=Audacity labels)'
    )
  }
  return format
}

/** Path of `absolutePath` relative to the project directory, forward-slashed. */
function projectPath (projectDir, absolutePath) {
  const rel = relative(projectDir, absolutePath)
  return (rel === '' ? absolutePath : rel).split('\\').join('/')
}

/**
 * Media length of a RIFF/WAVE file, read from its header only.
 *
 * Throws a readable error for anything that is not a plain PCM/float wav rather
 * than guessing, because a wrong LENGTH silently truncates an item in REAPER.
 *
 * @param {string} path - absolute .wav path.
 * @returns {Promise<number>} duration in seconds.
 */
async function readWavDuration (path) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    throw new Error(`audio_daw: cannot read ${path}: ${error.code ?? describeError(error)}; pass duration to place it on the timeline without reading it`)
  }
  try {
    const info = await handle.stat()
    if (info.size < 44) throw new Error(`audio_daw: ${path} is too short to be a WAVE file; pass duration instead`)
    const header = Buffer.alloc(12)
    await handle.read(header, 0, 12, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`audio_daw: ${path} is not a RIFF/WAVE file; pass duration to place it on the timeline`)
    }
    const chunk = Buffer.alloc(8)
    let cursor = 12
    let format = null
    // A malformed file must not become an infinite chunk walk.
    for (let guard = 0; guard < 4096; guard += 1) {
      if (cursor + 8 > info.size) break
      const read = await handle.read(chunk, 0, 8, cursor)
      if (read.bytesRead < 8) break
      const id = chunk.toString('ascii', 0, 4)
      const size = chunk.readUInt32LE(4)
      const body = cursor + 8
      if (id === 'fmt ' && size >= 16) {
        const fmtChunk = Buffer.alloc(16)
        await handle.read(fmtChunk, 0, 16, body)
        format = {
          channelCount: fmtChunk.readUInt16LE(2),
          sampleRate: fmtChunk.readUInt32LE(4),
          blockAlign: fmtChunk.readUInt16LE(12)
        }
      } else if (id === 'data') {
        if (format === null || format.blockAlign === 0 || format.sampleRate === 0) {
          throw new Error(`audio_daw: ${path} has no usable fmt chunk; pass duration to place it on the timeline`)
        }
        // A truncated file, or an RF64 placeholder size, claims more bytes than
        // the file holds: measure what is there, so an item is never longer than
        // its media.
        const available = Math.max(0, info.size - body)
        const declared = size === 0xffffffff ? available : Math.min(size, available)
        const frames = Math.floor(declared / format.blockAlign)
        if (frames === 0) throw new Error(`audio_daw: ${path} has no audio frames`)
        return frames / format.sampleRate
      }
      cursor = body + size + (size % 2)
    }
    throw new Error(`audio_daw: ${path} has no data chunk; pass duration to place it on the timeline`)
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ plan -- */

/** Read a cue's `path` into both the display form and the resolved form. */
function readCuePath (cwd, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return { declared: undefined, absolute: undefined }
  const absolute = resolvePath(cwd, text)
  return { declared: displayPath(cwd, absolute), absolute }
}

/**
 * Turn the tool's `cues` argument into the flat entries the exporter wants.
 *
 * The module re-validates every number and range (it is a public API): this only
 * resolves paths and drops absent optional keys so a cue that says nothing about
 * gain keeps the module's default instead of an `undefined`.
 *
 * @returns {{ entries: object[], notes: string[] }}
 */
function planCues (cwd, args, format) {
  const cues = Array.isArray(args.cues) ? args.cues : undefined
  if (cues === undefined || cues.length === 0) {
    throw new Error(`audio_daw: ${format} needs cues: [{ name, path, at, duration, gainDb, fadeIn, fadeOut }] (rpp also accepts tracks)`)
  }
  const entries = cues.map((cue, index) => {
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) {
      throw new Error(`audio_daw: cues[${index}] must be an object, got ${describeValue(cue)}`)
    }
    const path = readCuePath(cwd, cue.path)
    return {
      name: cue.name,
      declared: path.declared,
      absolute: path.absolute,
      at: cue.at,
      duration: cue.duration,
      gainDb: cue.gainDb,
      fadeIn: cue.fadeIn,
      fadeOut: cue.fadeOut
    }
  })
  return { entries, notes: [] }
}

/**
 * Turn `tracks` (or, by convenience, `cues`) into REAPER tracks.
 *
 * A track without an explicit `duration` is measured from its wav header; that
 * measurement is reported as a note, so a caller that wanted a trimmed item
 * learns why its length may differ from what it expected.
 *
 * @returns {Promise<{ entries: object[], notes: string[] }>}
 */
async function planReaper (cwd, args) {
  const tracksGiven = Array.isArray(args.tracks)
  const fromCues = !tracksGiven || args.tracks.length === 0
  const source = fromCues ? args.cues : args.tracks
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('audio_daw: rpp needs tracks: [{ name, path, offsetSeconds, duration, gainDb, fadeIn, fadeOut }] (cues are also accepted, one track each)')
  }
  const notes = []
  if (fromCues && tracksGiven && Array.isArray(args.cues) && args.cues.length > 0) {
    notes.push('tracks was empty; cues were used instead')
  }
  const entries = []
  let measured = 0
  for (let index = 0; index < source.length; index += 1) {
    const track = source[index]
    if (track === null || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(`audio_daw: ${fromCues ? 'cues' : 'tracks'}[${index}] must be an object, got ${describeValue(track)}`)
    }
    const path = readCuePath(cwd, track.path)
    if (path.absolute === undefined) {
      throw new Error(`audio_daw: ${fromCues ? 'cues' : 'tracks'}[${index}] has no path; a REAPER item needs a media file`)
    }
    let duration = track.duration
    if (duration === undefined || duration === null) {
      duration = await readWavDuration(path.absolute)
      measured += 1
    }
    entries.push({
      name: track.name,
      declared: path.declared,
      absolute: path.absolute,
      offsetSeconds: fromCues ? track.at : track.offsetSeconds,
      duration,
      gainDb: track.gainDb,
      fadeIn: track.fadeIn,
      fadeOut: track.fadeOut
    })
  }
  if (fromCues) notes.push('cues were written as one REAPER track each (offset = cue at)')
  if (measured > 0) notes.push(`${measured} item length(s) measured from the wav header; pass duration to override`)
  return { entries, notes }
}

/* ------------------------------------------------------------ write back -- */

/** Throw the one error a self-check failure is allowed to produce. */
function pluginBug (detail) {
  throw new Error(`audio_daw: the exporter wrote a project it cannot read back (${detail}); this is a plugin bug, please report it`)
}

/**
 * Parse an EDL back and prove it says what was asked.
 *
 * The checks are the ones a broken EDL would fail silently inside an NLE: an
 * event count that does not match the cue count, a record that goes backwards,
 * a zero-length source, a timecode that does not parse at the declared rate.
 *
 * @returns {object} `{ events, lengthSeconds }` for the tool result.
 */
function verifyEdl (text, entries, frameRate) {
  let parsed
  try {
    parsed = parseEdl(text)
  } catch (error) {
    pluginBug(describeError(error))
  }
  if (parsed.events.length !== entries.length) pluginBug(`it holds ${parsed.events.length} event(s) for ${entries.length} cue(s)`)
  let previousOut = -1
  let firstIn = -1
  for (const event of parsed.events) {
    let srcIn
    let srcOut
    let recIn
    let recOut
    try {
      srcIn = timecodeToSeconds(event.srcIn, frameRate)
      srcOut = timecodeToSeconds(event.srcOut, frameRate)
      recIn = timecodeToSeconds(event.recIn, frameRate)
      recOut = timecodeToSeconds(event.recOut, frameRate)
    } catch (error) {
      pluginBug(describeError(error))
    }
    if (!(srcOut > srcIn)) pluginBug(`event ${event.number} has a zero length source (${event.srcIn} -> ${event.srcOut})`)
    if (!(recOut > recIn)) pluginBug(`event ${event.number} has a zero length record (${event.recIn} -> ${event.recOut})`)
    if (recIn + 1e-9 < previousOut) pluginBug(`event ${event.number} starts before the previous event ends (${event.recIn})`)
    if (event.clipName === null || event.clipName === '') pluginBug(`event ${event.number} has no FROM CLIP NAME`)
    previousOut = recOut
    if (firstIn === -1) firstIn = recIn
  }
  return { events: parsed.events.length, lengthSeconds: Math.round((previousOut - firstIn) * 1e6) / 1e6 }
}

/**
 * Parse an RPP back and prove every item carries the requested timing and gain.
 *
 * @returns {object} `{ tracks, items }` for the tool result.
 */
function verifyRpp (text, entries) {
  let parsed
  try {
    parsed = parseRpp(text)
  } catch (error) {
    pluginBug(describeError(error))
  }
  if (!parsed.balanced) pluginBug('its chunk structure is unbalanced')
  if (parsed.tracks.length !== entries.length) pluginBug(`it holds ${parsed.tracks.length} track(s) for ${entries.length} item(s)`)
  let items = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const trackItems = parsed.tracks[index].items
    if (trackItems.length !== 1) pluginBug(`track ${index + 1} holds ${trackItems.length} item(s) instead of 1`)
    const item = trackItems[0]
    items += 1
    if (Math.abs(item.position - entry.offsetSeconds) > 0.0005) {
      pluginBug(`item ${items} POSITION is ${item.position} instead of ${entry.offsetSeconds}`)
    }
    if (Math.abs(item.length - entry.duration) > 0.0005) {
      pluginBug(`item ${items} LENGTH is ${item.length} instead of ${entry.duration}`)
    }
    const gain = 20 * Math.log10(item.volume)
    const target = Number.isFinite(entry.gainDb) ? entry.gainDb : 0
    if (!Number.isFinite(gain) || Math.abs(gain - target) > 0.1) {
      pluginBug(`item ${items} VOLPAN is ${item.volume} (${gain} dB) instead of ${target} dB`)
    }
    if (item.file === null || item.file === '') pluginBug(`item ${items} has no SOURCE WAVE FILE`)
  }
  return { tracks: parsed.tracks.length, items }
}

/* ------------------------------------------------------------------ text -- */

/** Does any entry carry a level or fade the EDL cannot express? */
function hasLevels (entries) {
  return entries.some((entry) => (entry.gainDb !== undefined && entry.gainDb !== 0) || (entry.fadeIn ?? 0) > 0 || (entry.fadeOut ?? 0) > 0)
}

/** The one line that says what the editor on the other side will show. */
function dawLine (format, result, entries) {
  if (format === 'edl') {
    const levels = hasLevels(entries) ? '; gain and fades are written as comments only' : ''
    return `A video editor sees ${result.events} cut(s) on audio track ${result.trackType} starting at record ${result.recordStart}, each sourced from the start of its file${levels}.`
  }
  if (format === 'rpp') {
    return `REAPER sees ${result.tracks} track(s) with one item each at ${result.sampleRate} Hz and ${fmt(result.bpm, 2)} BPM; item volume carries the gain and the fade fields carry the fades.`
  }
  if (format === 'csv') {
    return `A spreadsheet or script sees ${result.events} row(s) of name,path,at,duration,gainDb,fadeIn,fadeOut.`
  }
  return `Audacity (File > Import > Labels) sees ${result.events} label(s) spanning the same timeline.`
}

/* ----------------------------------------------------------------- tools -- */

/**
 * Register the project-export tool on `ctx.tools`.
 * @param {object} ctx - Cordis registrant context.
 */
export function registerDawTools (ctx) {
  ctx.tools.register({
    name: 'audio_daw',
    description: 'Export a cue set or a stem set as a project a real editor can open: a CMX3600 EDL cut list for a video editor, a REAPER .rpp project (the only format that keeps gain and fades), an RFC4180 CSV cue sheet, or Audacity labels. Use it when the work has to leave the plugin and be edited by a human, instead of being played back inside the page.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: EXPORT_FORMATS,
          description: 'edl=CMX3600 cut list for an NLE (one record track, cuts only: no gain, no fades, no overlaps); rpp=REAPER project, one track per stem with position, length, gain and fades (the least lossy); csv=spreadsheet/script cue sheet with every field; labels=Audacity label track.'
        },
        cues: {
          type: 'array',
          description: 'The cue set to export (edl, csv, labels, and rpp unless tracks is given): one entry per sound event on the timeline.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Label of the cue; defaults to the file stem.' },
              path: { type: 'string', description: 'Source .wav path, relative to the working directory or absolute. Required by edl and rpp; optional for csv and labels.' },
              at: { type: 'number', description: 'Start on the animation timeline in seconds, >= 0.' },
              duration: { type: 'number', description: 'Length in seconds, > 0. Required by edl; rpp measures the wav when it is missing.' },
              gainDb: { type: 'number', description: 'Level trim in dB, -120..24. Carried by rpp and csv only; EDL has no level field.' },
              fadeIn: { type: 'number', description: 'Fade-in seconds, >= 0. Carried by rpp and csv only.' },
              fadeOut: { type: 'number', description: 'Fade-out seconds, >= 0. Carried by rpp and csv only.' }
            },
            required: ['at'],
            additionalProperties: false
          }
        },
        tracks: {
          type: 'array',
          description: 'rpp only: the stem set to place, one REAPER track per entry (order is preserved). Takes precedence over cues.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Track name; defaults to the file stem.' },
              path: { type: 'string', description: 'Stem .wav path, relative to the working directory or absolute.' },
              offsetSeconds: { type: 'number', description: 'Where the item starts on the timeline in seconds, >= 0.' },
              duration: { type: 'number', description: 'Item length in seconds; measured from the wav header when omitted.' },
              gainDb: { type: 'number', description: 'Item volume trim in dB, -120..24, written to VOLPAN as a linear gain.' },
              fadeIn: { type: 'number', description: 'Fade-in seconds, >= 0 (written to the item FADEIN field).' },
              fadeOut: { type: 'number', description: 'Fade-out seconds, >= 0 (written to the item FADEOUT field).' }
            },
            required: ['path'],
            additionalProperties: false
          }
        },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/<format>-<hash>.<ext>.' },
        frameRate: { type: 'number', description: 'edl only: 24 (default), 25, 30 or 29.97 (drop-frame). 23.976 is written as 24 with a warning; 59.94 cannot be expressed in CMX3600.' },
        bpm: { type: 'number', description: 'rpp only: project tempo 20..300; defaults to 120.' },
        sampleRate: { type: 'integer', description: 'rpp only: project sample rate 8000..96000; defaults to 44100.' }
      },
      required: ['format'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Export ${String(args.format ?? 'project')} (${Array.isArray(args.cues) ? args.cues.length : Array.isArray(args.tracks) ? args.tracks.length : 0} events)`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const format = readFormat(args.format)
      const frameRate = readNumber('audio_daw', 'frameRate', args.frameRate)
      const bpm = readNumber('audio_daw', 'bpm', args.bpm)
      const sampleRate = readNumber('audio_daw', 'sampleRate', args.sampleRate)

      const plan = format === 'rpp' ? await planReaper(cwd, args) : planCues(cwd, args, format)

      // The hash covers the request, not the output path, so re-running the same
      // export lands on the same file. Display paths are cwd-relative and stay
      // stable across a session, which keeps the name stable too.
      const hash = hashSpec({
        engine: 'daw/1',
        format,
        frameRate: frameRate ?? null,
        bpm: bpm ?? null,
        sampleRate: sampleRate ?? null,
        entries: plan.entries.map((entry) => [
          entry.name ?? null,
          entry.declared ?? null,
          entry.at ?? entry.offsetSeconds ?? 0,
          entry.duration ?? null,
          entry.gainDb ?? 0,
          entry.fadeIn ?? 0,
          entry.fadeOut ?? 0
        ])
      })

      const extension = EXPORT_EXTENSIONS[format]
      const target = resolvePath(cwd, args.out) ?? join(cwd, 'assets', 'audio', `${format}-${hash}.${extension}`)

      // REAPER resolves a relative FILE against the project directory, so the
      // media path in an .rpp has to be relative to *it*, not to the session.
      const projectDir = dirname(target)
      const request = format === 'rpp'
        ? {
            format,
            tracks: plan.entries.map((entry) => ({
              name: entry.name,
              path: projectPath(projectDir, entry.absolute),
              offsetSeconds: entry.offsetSeconds,
              duration: entry.duration,
              gainDb: entry.gainDb,
              fadeIn: entry.fadeIn,
              fadeOut: entry.fadeOut
            })),
            sampleRate,
            bpm
          }
        : {
            format,
            cues: plan.entries.map((entry) => ({
              name: entry.name,
              path: entry.declared,
              at: entry.at,
              duration: entry.duration,
              gainDb: entry.gainDb,
              fadeIn: entry.fadeIn,
              fadeOut: entry.fadeOut
            })),
            frameRate
          }

      let result
      try {
        result = exportProject(request)
      } catch (error) {
        throw new Error(`audio_daw: ${describeError(error)}`)
      }

      const verified = format === 'edl'
        ? verifyEdl(result.text, plan.entries, result.frameRate)
        : format === 'rpp'
          ? verifyRpp(result.text, plan.entries)
          : { events: result.events }

      const bytes = Buffer.from(result.text, 'utf8')
      await writeFileAtomic(target, bytes)
      const info = await stat(target)

      const warnings = result.warnings.slice(0, MAX_WARNINGS)
      const omitted = result.warnings.length - warnings.length
      const timeline = fmt(result.durationSeconds, 2)
      const lines = [
        `Wrote ${displayPath(cwd, target)} (${sizeText(info.size)}, ${FORMAT_LABELS[format]}, ${result.events} event(s), ${timeline}s timeline)`,
        dawLine(format, result, plan.entries)
      ]
      for (const note of plan.notes) lines.push(`note: ${note}`)
      for (const warning of warnings) lines.push(`warning: ${warning}`)
      if (omitted > 0) lines.push(`note: ${omitted} more warning(s) not shown`)

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        format,
        events: result.events,
        durationSeconds: result.durationSeconds,
        verified,
        warnings,
        warningsOmitted: omitted,
        frameRate: result.frameRate,
        frameRateLabel: result.frameRateLabel,
        recordStart: result.recordStart,
        trackType: result.trackType,
        sampleRate: result.sampleRate,
        bpm: result.bpm,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
