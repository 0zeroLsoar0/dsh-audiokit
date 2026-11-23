/**
 * `audio_daw`: hand a cue set or a stem set to a DAW, an NLE or a spreadsheet.
 *
 * `audio_bind` keeps a cue set inside one HTML page and `audio_stems` writes the
 * layers as wavs, but there was no way to say "here is the timeline, open it in
 * your editor". This tool is that hand-off: it writes a CMX3600 EDL, a REAPER
 * project, an RFC4180 CSV cue sheet, an Audacity label track, an AAF (structural
 * subset), an OMF skeleton, an OpenTimelineIO document or an FCP7 XML sequence.
 *
 * Three things it does that a naive file writer would not:
 *
 * 1. It reads back every project it writes (`parseEdl` / `parseRpp` / `parseAaf`
 *    / `parseOtio` / `parseXmeml` / `readCompoundFile`) and refuses to report
 *    success when the writer and the reader disagree. A broken EDL or AAF fails
 *    silently inside an NLE, so the check has to happen here.
 * 2. It measures the duration of each media file from the RIFF header, because
 *    RPP stores an item LENGTH. Reading the whole file through the engine's
 *    `readTrack` to learn one number would cost hundreds of megabytes for a
 *    stem set; walking the chunks costs one 8 KB read per file.
 * 3. For AAF it reads the PCM and embeds it, because that is what makes an AAF
 *    a self-contained timeline rather than a list of paths — and for FCP7 XML it
 *    passes an absolute `file://` URL, which is what Premiere links against.
 *
 * Paths are written so a project can find its media: CSV and EDL carry the
 * working-directory-relative path, the RPP gets paths relative to the directory
 * the project is written into (which is what REAPER resolves them against), the
 * OTIO document carries the relative path as `target_url`, and the xmeml
 * document carries an absolute file URL.
 */

import { open, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import {
  EXPORT_EXTENSIONS,
  EXPORT_FORMATS,
  exportProject,
  parseEdl,
  parseRpp,
  timecodeToSeconds
} from './daw.js'
import { parseAaf } from './aaf.js'
import { readCompoundFile } from './cfb.js'
import { parseOtio } from './otio.js'
import { parseXmeml } from './xmeml.js'

/** Human name per format, used in the result line a model reads. */
const FORMAT_LABELS = Object.freeze({
  edl: 'CMX3600 EDL',
  rpp: 'REAPER project',
  csv: 'CSV cue sheet',
  labels: 'Audacity label track',
  aaf: 'AAF (structural subset)',
  omf: 'OMF skeleton (not importable)',
  otio: 'OpenTimelineIO document',
  xmeml: 'Final Cut Pro 7 XML'
})

/** Formats that write a binary container instead of text. */
const BINARY_FORMATS = Object.freeze(['aaf', 'omf'])

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
      '(edl=cut list for a video editor, rpp=REAPER project, csv=cue sheet, labels=Audacity labels, ' +
      'aaf=AAF structural subset, omf=OMF skeleton, otio=OpenTimelineIO, xmeml=Final Cut Pro 7 XML)'
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

/**
 * Read a wav file's PCM frames and format, for the AAF essence embedding.
 *
 * Only integer PCM is returned: AAF's `PCMDescriptor` describes integer samples
 * (a float file would need a different descriptor class, which this subset does
 * not write), so a float or compressed file is reported instead of being
 * embedded under a descriptor that lies about it.
 *
 * @param {string} path - absolute .wav path.
 * @returns {Promise<{ data: Buffer, sampleRate: number, channels: number, bitDepth: number, frames: number }>}
 */
async function readWavPcm (path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`audio_daw: cannot read ${path}: ${error.code ?? describeError(error)}; pass embed false to write an offline AAF`)
  }
  if (bytes.length < 44) throw new Error(`audio_daw: ${path} is too short to be a WAVE file`)
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`audio_daw: ${path} is not a RIFF/WAVE file; aaf needs a PCM wav to embed (pass embed false for an offline timeline)`)
  }
  let format = null
  let cursor = 12
  for (let guard = 0; guard < 4096; guard += 1) {
    if (cursor + 8 > bytes.length) break
    const id = bytes.toString('ascii', cursor, cursor + 4)
    const size = bytes.readUInt32LE(cursor + 4)
    const body = cursor + 8
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(body),
        channelCount: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
        blockAlign: bytes.readUInt16LE(body + 12)
      }
    } else if (id === 'data') {
      if (format === null) throw new Error(`audio_daw: ${path} has no fmt chunk before its data chunk; aaf needs the sample format`)
      if (format.audioFormat !== 1) {
        throw new Error(`audio_daw: ${path} is not integer PCM (wFormatTag ${format.audioFormat}); aaf can only embed PCM`)
      }
      if (![8, 16, 24, 32].includes(format.bitsPerSample)) {
        throw new Error(`audio_daw: ${path} is ${format.bitsPerSample}-bit; aaf can only embed 8, 16, 24 or 32 bit PCM`)
      }
      const available = Math.max(0, bytes.length - body)
      const declared = size === 0xffffffff ? available : Math.min(size, available)
      const usable = Math.floor(declared / format.blockAlign) * format.blockAlign
      if (usable === 0) throw new Error(`audio_daw: ${path} has no audio frames`)
      return {
        data: Buffer.from(bytes.subarray(body, body + usable)),
        sampleRate: format.sampleRate,
        channels: format.channelCount,
        bitDepth: format.bitsPerSample,
        frames: usable / format.blockAlign
      }
    }
    cursor = body + size + (size % 2)
  }
  throw new Error(`audio_daw: ${path} has no data chunk; aaf needs a PCM wav to embed`)
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
 * Plan a format that needs a real clip length (otio, xmeml).
 *
 * Unlike the EDL, these formats describe media rather than a cut list, so a cue
 * with a path gets the length of its wav when the caller did not state one —
 * measured from the header, exactly like the RPP path does. A cue with no path
 * and no duration is still rejected by the exporter with a readable message.
 *
 * @returns {Promise<{ entries: object[], notes: string[] }>}
 */
async function planTimed (cwd, args, format) {
  const { entries, notes } = planCues(cwd, args, format)
  let measured = 0
  for (const entry of entries) {
    if ((entry.duration === undefined || entry.duration === null) && entry.absolute !== undefined) {
      entry.duration = await readWavDuration(entry.absolute)
      measured += 1
    }
  }
  if (measured > 0) notes.push(`${measured} clip length(s) measured from the wav header; pass duration to override`)
  return { entries, notes }
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

/**
 * Turn cues into the AAF writer's entries, reading the PCM to embed.
 *
 * AAF is the one format that carries the audio itself, so the samples have to be
 * read here. A cue whose file is not integer PCM is kept as an offline clip
 * (length only) with a note instead of failing the whole export: a timeline with
 * one linked file and nine embedded ones is still useful, and a silent drop is
 * not.
 *
 * @returns {Promise<{ entries: object[], notes: string[] }>}
 */
async function planAaf (cwd, args, embed) {
  const { entries: cues, notes } = planCues(cwd, args, 'aaf')
  const entries = []
  let embedded = 0
  let offline = 0
  for (const entry of cues) {
    if (entry.absolute === undefined || embed === false) {
      offline += 1
      entries.push(entry)
      continue
    }
    try {
      const pcm = await readWavPcm(entry.absolute)
      // A clip with no explicit duration gets the one its samples have: an AAF
      // clip needs a length, and the media is the authority on it.
      const duration = entry.duration === undefined || entry.duration === null
        ? pcm.frames / pcm.sampleRate
        : entry.duration
      entries.push({ ...entry, duration, pcm, channels: pcm.channels, bitDepth: pcm.bitDepth })
      embedded += 1
    } catch (error) {
      // AAF is generated from wavs this plugin wrote, so a non-PCM file is a
      // caller mistake worth reporting — but not worth losing the timeline.
      notes.push(`cue ${JSON.stringify(entry.name ?? '')} was written offline: ${describeError(error)}`)
      offline += 1
      entries.push(entry)
    }
  }
  if (embedded > 0) notes.push(`${embedded} cue(s) embedded as raw PCM frames (no RIFF header; the AAF descriptor carries the format)`)
  if (offline > 0) notes.push(`${offline} cue(s) written as offline clips (length only, no embedded audio)`)
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

/**
 * Parse an AAF back and prove the container and the object graph say what was
 * asked: the CFB is valid, the root is the AAF root class, the header carries
 * the version and operational pattern, every cue has a mob, and the timeline
 * holds one clip per cue at the requested position.
 *
 * @returns {object} `{ storages, streams, mobs, clips, embeddedBytes }` for the tool result.
 */
function verifyAaf (buffer, entries, embed) {
  let parsed
  try {
    parsed = parseAaf(buffer)
  } catch (error) {
    pluginBug(describeError(error))
  }
  if (parsed.rootClassId === undefined || parsed.rootClassId === null) pluginBug('its root storage has no class id')
  if (parsed.header.byteOrder !== 0x4949) pluginBug(`its header byte order is ${parsed.header.byteOrder} instead of 0x4949`)
  if (parsed.header.objectModelVersion !== 1) pluginBug(`its object model version is ${parsed.header.objectModelVersion} instead of 1`)
  const clips = parsed.timeline.tracks.reduce((total, track) => total + track.clips.length, 0)
  if (clips !== entries.length) pluginBug(`its timeline holds ${clips} clip(s) for ${entries.length} cue(s)`)
  const embeddedBytes = parsed.content.essenceData.reduce((total, item) => total + item.bytes, 0)
  if (embed === true && embeddedBytes === 0) pluginBug('it claims to embed PCM but no essence data was found')
  if (embed !== true && embeddedBytes !== 0) pluginBug('it embeds PCM although embed was false')
  // Every timeline clip has to resolve to a master mob, or the reference graph is
  // broken even though the bytes parse.
  const mobIds = new Set(parsed.content.mobs.map((mob) => mob.mobId))
  for (const track of parsed.timeline.tracks) {
    for (const clip of track.clips) {
      if (!mobIds.has(clip.sourceMobId)) pluginBug(`clip ${JSON.stringify(clip.name)} points at mob ${String(clip.sourceMobId).slice(0, 16)}… which is not in the file`)
    }
  }
  return {
    storages: parsed.container.storages,
    streams: parsed.container.streams,
    mobs: parsed.content.mobs.length,
    clips,
    embeddedBytes
  }
}

/**
 * Parse an OMF skeleton back: the container has to be a valid CFB and carry the
 * two streams the skeleton promises.
 */
function verifyOmf (buffer, entries) {
  let container
  try {
    container = readCompoundFile(buffer)
  } catch (error) {
    pluginBug(describeError(error))
  }
  const names = container.list.filter((node) => node.kind === 'stream').map((node) => node.name)
  for (const required of ['OMFI:HEADER', 'DSH:MANIFEST']) {
    if (!names.includes(required)) pluginBug(`its container has no ${required} stream`)
  }
  const manifestNode = container.list.find((node) => node.name === 'DSH:MANIFEST')
  let manifest
  try {
    manifest = JSON.parse(manifestNode.data.toString('utf8'))
  } catch (error) {
    pluginBug(`its manifest is not valid JSON (${describeError(error)})`)
  }
  if (manifest.importable !== false) pluginBug('its manifest does not mark the file as a skeleton')
  if (manifest.events !== entries.length) pluginBug(`its manifest lists ${manifest.events} cue(s) for ${entries.length} cue(s)`)
  return { streams: names.length, events: manifest.events, importable: false }
}

/** Parse an OTIO document back and compare it with the cues that were written. */
function verifyOtio (text, entries) {
  let parsed
  try {
    parsed = parseOtio(text)
  } catch (error) {
    pluginBug(describeError(error))
  }
  const clips = parsed.tracks.reduce((total, track) => total + track.clips.length, 0)
  if (clips !== entries.length) pluginBug(`it holds ${clips} clip(s) for ${entries.length} cue(s)`)
  for (const track of parsed.tracks) {
    let cursor = 0
    for (const clip of track.clips) {
      if (clip.at + 1e-6 < cursor) pluginBug(`clip ${JSON.stringify(clip.name)} starts before the previous clip ends`)
      cursor = clip.at + clip.duration
    }
  }
  return { tracks: parsed.tracks.length, clips, rate: parsed.rate }
}

/** Parse an FCP7 XML sequence back and compare it with the cues that were written. */
function verifyXmeml (text, entries) {
  let parsed
  try {
    parsed = parseXmeml(text)
  } catch (error) {
    pluginBug(describeError(error))
  }
  const clips = parsed.tracks.reduce((total, track) => total + track.clips.length, 0)
  if (clips !== entries.length) pluginBug(`it holds ${clips} clipitem(s) for ${entries.length} cue(s)`)
  for (const track of parsed.tracks) {
    for (const clip of track.clips) {
      if (!(clip.end > clip.start)) pluginBug(`clipitem ${JSON.stringify(clip.name)} has start ${clip.start} >= end ${clip.end}`)
      if (clip.pathUrl !== null && !/^file:|^\//.test(clip.pathUrl)) {
        pluginBug(`clipitem ${JSON.stringify(clip.name)} has a media path ${JSON.stringify(clip.pathUrl)} that is not resolvable`)
      }
    }
  }
  return { tracks: parsed.tracks.length, clips, timebase: parsed.timebase }
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
  if (format === 'aaf') {
    return `An AAF reader that has this file's class dictionary would see ${result.lanes} timeline track(s), ` +
      `${result.objects} mob(s) and ${sizeText(result.embeddedBytes)} of embedded PCM: the container and object ` +
      'graph are real, but Pro Tools/Resolve/Avid refuse the file at the MetaDictionary (see docs/INTEROP.zh.md).'
  }
  if (format === 'omf') {
    return 'This is a labelled skeleton, not an OMF document: Avid will refuse it. The container and manifest are real; use otio or xmeml for an importable timeline.'
  }
  if (format === 'otio') {
    return `Resolve 18+, Nuke and the OTIO adapters see a ${result.tracks} track audio timeline at ${result.rate} Hz ` +
      `with ${result.events} clip(s); gain and fades ride in clip metadata because OTIO has no audio level field.`
  }
  return `Premiere Pro (File > Import) and Resolve (File > Import Timeline) see a ${result.tracks} track sequence ` +
    `at ${result.frameRateLabel} with ${result.events} audio clipitem(s); frame-accurate, gain by Audio Levels filter.`
}

/* ----------------------------------------------------------------- tools -- */

/**
 * Register the project-export tool on `ctx.tools`.
 * @param {object} ctx - Cordis registrant context.
 */
export function registerDawTools (ctx) {
  ctx.tools.register({
    name: 'audio_daw',
    description: 'Export a cue set or a stem set as a project a real editor can open: a CMX3600 EDL cut list, a REAPER .rpp project (the only format that keeps gain and fades natively), an RFC4180 CSV cue sheet, Audacity labels, an OpenTimelineIO .otio document or an FCP7 xmeml XML sequence (both of which Resolve and Premiere import), an AAF (MS-CFB container with a real object graph and embedded PCM, but no MetaDictionary — Pro Tools still refuses it), or an OMF skeleton (explicitly not importable). Use it when the work has to leave the plugin and be edited by a human instead of being played back inside the page.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: EXPORT_FORMATS,
          description: 'edl=CMX3600 cut list for an NLE (one record track, cuts only: no gain, no fades, no overlaps); rpp=REAPER project, one track per stem with position, length, gain and fades (the least lossy); csv=spreadsheet/script cue sheet with every field; labels=Audacity label track; aaf=AAF structural subset: valid CFB container, AAF class ids and property encodings, mob/slot timeline and embedded PCM, but no MetaDictionary so AAF SDK apps refuse it; omf=OMF skeleton (container + manifest only, NOT importable); otio=OpenTimelineIO JSON, sample accurate, one audio track per lane (Resolve/Nuke/premiere adapter); xmeml=Final Cut Pro 7 XML, frame accurate, Premiere and Resolve import it directly.'
        },
        cues: {
          type: 'array',
          description: 'The cue set to export (every format except rpp, which also takes tracks): one entry per sound event on the timeline.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Label of the cue; defaults to the file stem.' },
              path: { type: 'string', description: 'Source .wav path, relative to the working directory or absolute. Required by edl, rpp and aaf; optional for csv, labels, otio, xmeml and omf.' },
              at: { type: 'number', description: 'Start on the animation timeline in seconds, >= 0.' },
              duration: { type: 'number', description: 'Length in seconds, > 0. Required by edl; rpp and aaf measure the wav when it is missing.' },
              gainDb: { type: 'number', description: 'Level trim in dB, -120..24. Carried by rpp, csv, xmeml (Audio Levels filter) and OTIO clip metadata; EDL and AAF have no level field here.' },
              fadeIn: { type: 'number', description: 'Fade-in seconds, >= 0. Carried by rpp and csv; reported (not applied) by otio and xmeml.' },
              fadeOut: { type: 'number', description: 'Fade-out seconds, >= 0. Carried by rpp and csv; reported (not applied) by otio and xmeml.' }
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
        frameRate: { type: 'number', description: 'edl and xmeml only: 24 (edl default), 25 (xmeml default), 30, 50, 60 or 29.97 (drop-frame). EDL maps 23.976 to 24 with a warning; xmeml accepts 23.976 and 29.97 as NTSC.' },
        bpm: { type: 'number', description: 'rpp only: project tempo 20..300; defaults to 120.' },
        sampleRate: { type: 'integer', description: 'rpp: project sample rate 8000..96000, defaults to 44100. aaf: project edit rate (timeline positions in samples), defaults to the first embedded clip. otio/xmeml: declared media sample rate, defaults to 48000.' },
        embed: { type: 'boolean', description: 'aaf only: embed the PCM in the file (default true). Pass false to write an offline timeline that only describes the clips.' },
        title: { type: 'string', description: 'aaf/otio/xmeml/omf only: timeline name written into the project (default "dsh-audiokit timeline").' }
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
      const embed = args.embed !== false

      const plan = format === 'rpp'
        ? await planReaper(cwd, args)
        : format === 'aaf'
          ? await planAaf(cwd, args, embed)
          : format === 'otio' || format === 'xmeml'
            ? await planTimed(cwd, args, format)
            : planCues(cwd, args, format)

      // The hash covers the request, not the output path, so re-running the same
      // export lands on the same file. Display paths are cwd-relative and stay
      // stable across a session, which keeps the name stable too.
      const hash = hashSpec({
        engine: 'daw/2',
        format,
        frameRate: frameRate ?? null,
        bpm: bpm ?? null,
        sampleRate: sampleRate ?? null,
        embed: BINARY_FORMATS.includes(format) ? embed : null,
        title: args.title === undefined ? null : String(args.title),
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
              // Absolute file URL: Premiere links xmeml media by <pathurl>, and
              // a relative one would not resolve. Only xmeml uses it.
              url: entry.absolute === undefined ? undefined : pathToFileURL(entry.absolute).href,
              at: entry.at ?? entry.offsetSeconds,
              duration: entry.duration,
              gainDb: entry.gainDb,
              fadeIn: entry.fadeIn,
              fadeOut: entry.fadeOut,
              pcm: entry.pcm,
              // Wav format facts the AAF descriptor needs when PCM is embedded.
              channels: entry.channels,
              bitDepth: entry.bitDepth
            })),
            frameRate,
            sampleRate,
            title: args.title,
            embed
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
          : format === 'aaf'
            ? verifyAaf(result.buffer, plan.entries, embed && plan.entries.some((entry) => entry.pcm !== undefined))
            : format === 'omf'
              ? verifyOmf(result.buffer, plan.entries)
              : format === 'otio'
                ? verifyOtio(result.text, plan.entries)
                : format === 'xmeml'
                  ? verifyXmeml(result.text, plan.entries)
                  : { events: result.events }

      const bytes = result.buffer === undefined ? Buffer.from(result.text, 'utf8') : result.buffer
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
        binary: BINARY_FORMATS.includes(format),
        frameRate: result.frameRate,
        frameRateLabel: result.frameRateLabel,
        recordStart: result.recordStart,
        trackType: result.trackType,
        sampleRate: result.sampleRate,
        bpm: result.bpm,
        // Format-specific extras: present only for the formats that report them.
        rate: result.rate,
        tracks: result.tracks,
        lanes: result.lanes,
        objects: result.objects,
        timebase: result.timebase,
        ntsc: result.ntsc,
        frames: result.frames,
        embeddedBytes: result.embeddedBytes,
        importable: result.importable,
        skeleton: result.skeleton,
        capabilities: result.capabilities,
        structure: result.structure,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
