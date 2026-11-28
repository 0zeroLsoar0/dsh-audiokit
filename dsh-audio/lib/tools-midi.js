/**
 * `audio_midi`: the bridge between a compose score and a Standard MIDI File.
 *
 * One tool with two verbs, because they are two questions about the same file
 * format:
 *
 * - `export` — take music this plugin made (a score object, or a compose request)
 *   and write it as a `.mid` that a DAW, notation app or game engine can open.
 *   Without this the score died inside the plugin.
 * - `parse` — read a `.mid` from the user and report what is in it: tempo,
 *   tracks, note counts, ranges and a bounded preview.
 *
 * There is deliberately no "import to audio" verb. Singing an imported melody
 * needed the formant voice, and that engine is gone: singing belongs to a TTS
 * engine or an external plugin (see CHANGELOG 0.6.0).
 *
 * Like every other tool here it returns a bounded summary, never audio bytes and
 * never a whole note list: the preview is capped, and `text` is the one human
 * line a model reads instead of listening.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { resolvePath, writeFileAtomic } from './audio.js'
import { GENRES, KEYS, MODES, composeScore } from './compose.js'
import { specHash } from './dsp.js'
import { parseMidiFile, scoreToMid, writeMidiFile } from './midi.js'

const GENRE_NAMES = Object.keys(GENRES)
const KEY_NAMES = Object.keys(KEYS)
const MODE_NAMES = Object.keys(MODES)

/** Bounds on the JSON this tool can hand back, so one big file cannot flood it. */
const MAX_TRACKS_LISTED = 12
const PREVIEW_NOTES = 6

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
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

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function sizeText (bytes) {
  if (bytes >= 1024 * 1024) return `${fmt(bytes / 1024 / 1024, 2)} MB`
  return `${fmt(bytes / 1024, 1)} KB`
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Reject a non-numeric argument early instead of rendering NaN durations later. */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  return number
}

/** Content-addressed name for a `.mid`, so identical exports share one file. */
function contentHash (bytes) {
  return specHash(`midi/1|${bytes.length}|${bytes.toString('latin1')}`)
}

/** `assets/audio/<label>-<hash>.mid`, the MIDI twin of `defaultOutputPath`. */
function defaultMidiPath (cwd, label, hash) {
  const safe = String(label).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'midi'
  return join(cwd, 'assets', 'audio', `${safe}-${hash}.mid`)
}

/** Note range of a track, as [low, high] MIDI numbers, or null when empty. */
function noteRange (notes) {
  if (notes.length === 0) return null
  let low = 127
  let high = 0
  for (const note of notes) {
    if (note.midi < low) low = note.midi
    if (note.midi > high) high = note.midi
  }
  return [low, high]
}

/** One line naming the tracks and their note counts. */
function trackLine (parsed) {
  const parts = parsed.tracks.slice(0, 6).map((track) => `${track.name ?? `track ${track.index + 1}`} ${track.notes.length}n`)
  if (parsed.tracks.length > 6) parts.push(`+${parsed.tracks.length - 6} more`)
  return `tracks: ${parts.join(' · ')}`
}

/* ------------------------------------------------------------------ export -- */

/**
 * Compose (when only a genre was given) and write the `.mid`.
 * @returns {Promise<object>} the tool result.
 */
async function exportMidi (cwd, args) {
  let score = null
  let label = 'midi-score'
  if (args.score !== null && typeof args.score === 'object' && !Array.isArray(args.score)) {
    score = args.score
    const genre = typeof score.genre === 'string' && score.genre !== '' ? score.genre : 'score'
    label = `midi-${genre}`
  } else if (typeof args.genre === 'string' && args.genre !== '') {
    if (GENRES[args.genre] === undefined) {
      throw new Error(`audio_midi: unknown genre "${args.genre}"; available: ${GENRE_NAMES.join(', ')}`)
    }
    if (args.key !== undefined && KEYS[args.key] === undefined) {
      throw new Error(`audio_midi: unknown key "${args.key}"; available: ${KEY_NAMES.join(', ')}`)
    }
    if (args.mode !== undefined && MODES[args.mode] === undefined) {
      throw new Error(`audio_midi: unknown mode "${args.mode}"; available: ${MODE_NAMES.join(', ')}`)
    }
    if (args.sections !== undefined && !Array.isArray(args.sections)) {
      throw new Error('audio_midi: sections must be an array of { name, fromBar, toBar, intensity }')
    }
    score = composeScore({
      genre: args.genre,
      bpm: Number.isFinite(Number(args.bpm)) ? Number(args.bpm) : undefined,
      bars: Number.isFinite(Number(args.bars)) ? Math.round(Number(args.bars)) : 16,
      key: args.key,
      mode: args.mode,
      seed: Number.isFinite(Number(args.seed)) ? Math.round(Number(args.seed)) : 1,
      intensity: Number.isFinite(Number(args.intensity)) ? Number(args.intensity) : 0.6,
      loop: args.loop === true,
      sections: args.sections
    })
    label = `compose-${args.genre}`
  } else {
    throw new Error('audio_midi export needs either a score object (from audio_compose) or a genre to compose, e.g. { "action": "export", "genre": "cinematic", "bars": 8 }')
  }

  const request = scoreToMid(score)
  if (request.tracks.length === 0) throw new Error('audio_midi: the score has no tracks to export')
  const bytes = writeMidiFile(request, { ticksPerQuarter: args.ticksPerQuarter })
  // Re-read our own output: if the writer and the reader ever disagree, the
  // export would otherwise succeed while the DAW gets a broken file.
  let parsed
  try {
    parsed = parseMidiFile(bytes)
  } catch (error) {
    throw new Error(`audio_midi: the MIDI writer produced a file the reader rejects (${error.message}); this is a plugin bug, please report it`)
  }

  const target = resolvePath(cwd, args.out) ?? defaultMidiPath(cwd, label, contentHash(bytes))
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  const skipped = Number.isFinite(request.skippedNotes) ? request.skippedNotes : 0
  const extra = [skipped > 0 ? `${skipped} unpitched note(s) skipped` : null].filter(Boolean)

  const text = [
    `Wrote ${displayPath(cwd, target)} (${sizeText(info.size)}, format ${parsed.format}, ${parsed.tracks.length} track(s), ${parsed.noteCount} note(s), ${fmt(parsed.durationSeconds, 2)}s @ ${fmt(parsed.tempoBpm)} BPM, ${parsed.ticksPerQuarter} tpq)`,
    trackLine(parsed),
    extra.length > 0 ? `note: ${extra.join(' · ')}` : null
  ].filter(Boolean).join('\n')

  return {
    action: 'export',
    path: target,
    relativePath: displayPath(cwd, target),
    bytes: info.size,
    format: parsed.format,
    tracks: parsed.tracks.length,
    notes: parsed.noteCount,
    durationSeconds: parsed.durationSeconds,
    tempoBpm: parsed.tempoBpm,
    ticksPerQuarter: parsed.ticksPerQuarter,
    skippedNotes: skipped,
    text
  }
}

/* ------------------------------------------------------------- read/parse -- */

/**
 * Parse a `.mid` and report what is in it.
 * @returns {Promise<object>} the tool result.
 */
async function readMidi (cwd, args) {
  const path = resolvePath(cwd, args.path)
  if (path === undefined) throw new Error('audio_midi parse needs a .mid file path')
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`audio_midi: cannot read ${path}: ${error.code ?? error.message}`)
  }
  let parsed
  try {
    parsed = parseMidiFile(bytes)
  } catch (error) {
    throw new Error(`audio_midi: cannot parse ${path}: ${error.message}`)
  }

  const trackList = []
  let tracksOmitted = 0
  for (const track of parsed.tracks) {
    if (trackList.length >= MAX_TRACKS_LISTED) {
      tracksOmitted += 1
      continue
    }
    trackList.push({
      name: track.name,
      channel: track.channel,
      program: track.program,
      notes: track.notes.length,
      midiRange: noteRange(track.notes),
      events: track.events.length,
      // Compact preview: [midi, startTicks, durTicks, velocity].
      preview: track.notes.slice(0, PREVIEW_NOTES).map((note) => [note.midi, note.startTicks, note.durTicks, note.velocity])
    })
  }

  const warnings = parsed.warnings.slice()
  const header = `Read ${displayPath(cwd, path)} (${sizeText(bytes.length)}, format ${parsed.format}, ${parsed.tracks.length} track(s), ${parsed.noteCount} note(s), ${fmt(parsed.durationSeconds, 2)}s @ ${fmt(parsed.tempoBpm)} BPM, ${parsed.ticksPerQuarter} tpq)`
  const lines = [header, trackLine(parsed)]

  if (tracksOmitted > 0) lines.push(`note: ${tracksOmitted} more track(s) omitted from this summary`)
  for (const warning of warnings) lines.push(`warning: ${warning}`)

  return {
    action: 'parse',
    path,
    relativePath: displayPath(cwd, path),
    bytes: bytes.length,
    format: parsed.format,
    tracks: parsed.tracks.length,
    physicalTracks: parsed.physicalTrackCount,
    notes: parsed.noteCount,
    durationSeconds: parsed.durationSeconds,
    durationTicks: parsed.durationTicks,
    tempoBpm: parsed.tempoBpm,
    ticksPerQuarter: parsed.ticksPerQuarter,
    timeSignature: parsed.timeSignature,
    trackList,
    tracksOmitted,
    warnings,
    text: lines.join('\n')
  }
}

/* ------------------------------------------------------------------- tools -- */

/**
 * Register the MIDI export/read tool on `ctx.tools`.
 * @param {object} ctx - Cordis registrant context.
 */
export function registerMidiTools (ctx) {
  ctx.tools.register({
    name: 'audio_midi',
    description: 'Export a score (the audio_compose shape, or a genre composed in one call) to a Standard MIDI File a DAW can open, or parse an existing .mid and report tempo, tracks, note counts and ranges.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'parse'], description: 'export=score or genre in, .mid out. parse=.mid in, JSON summary only (no audio is rendered).' },
        score: { type: 'object', additionalProperties: true, description: 'The score to export, in the audio_compose shape (bpm, beatsPerBar, bars, tracks[].notes[]).' },
        genre: { type: 'string', enum: GENRE_NAMES, description: 'Export by composing in one call (same genres as audio_compose).' },
        bpm: { type: 'number', description: 'Export only: the file tempo (defaults to the genre tempo).' },
        bars: { type: 'integer', description: 'Export only: length in bars; defaults to 16.' },
        key: { type: 'string', enum: KEY_NAMES, description: 'Export only: tonic note name; defaults to the genre key.' },
        mode: { type: 'string', enum: MODE_NAMES, description: 'Export only: scale/mode; defaults to the genre mode.' },
        intensity: { type: 'number', description: 'Export only: arrangement energy 0..1; defaults to 0.6.' },
        seed: { type: 'integer', description: 'Export only: variation seed; same seed, same score, same .mid bytes.' },
        loop: { type: 'boolean', description: 'Export only: compose a loop-safe form (no intro/outro).' },
        sections: {
          type: 'array',
          description: 'Export only: optional section form override, same shape as audio_compose.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', enum: ['intro', 'build', 'drop', 'outro'] },
              fromBar: { type: 'integer' },
              toBar: { type: 'integer' },
              intensity: { type: 'number' }
            },
            required: ['name', 'fromBar', 'toBar'],
            additionalProperties: false
          }
        },
        path: { type: 'string', description: 'parse: the .mid file to read, relative to the working directory or absolute.' },
        out: { type: 'string', description: 'Export output path. Defaults to assets/audio/<label>-<hash>.mid; parse writes no file.' },
        ticksPerQuarter: { type: 'integer', description: 'export: MIDI timing resolution, 24..9600; default 480.' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `MIDI ${String(args.action ?? 'convert')} ${String(args.genre ?? args.path ?? args.score?.genre ?? '').slice(0, 40)}`.trim(),
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const action = String(args.action ?? '')
      readNumber('audio_midi', 'bpm', args.bpm)
      readNumber('audio_midi', 'bars', args.bars)
      readNumber('audio_midi', 'seed', args.seed)
      readNumber('audio_midi', 'intensity', args.intensity)
      readNumber('audio_midi', 'ticksPerQuarter', args.ticksPerQuarter)
      if (action === 'export') return exportMidi(cwd, args)
      if (action === 'parse') return readMidi(cwd, args)
      throw new Error(`audio_midi: action must be "export" or "parse", got ${describeValue(args.action)}`)
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
