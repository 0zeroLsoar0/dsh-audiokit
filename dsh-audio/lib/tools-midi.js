/**
 * `audio_midi`: the bridge between a compose score and a Standard MIDI File.
 *
 * One tool with three verbs, because they are three questions about the same
 * file format:
 *
 * - `export` — take music this plugin made (a score object, or a compose request)
 *   and write it as a `.mid` that a DAW, notation app or game engine can open.
 *   Without this the score died inside the plugin.
 * - `import` — read a `.mid` from the user and report what is in it; with
 *   `render: true` it also sings the melody to a `.wav`, so an existing tune
 *   becomes audio.
 * - `parse` — the same read, JSON only, no file written.
 *
 * Like every other tool here it returns a bounded summary, never audio bytes and
 * never a whole note list: the preview is capped, and `text` is the one human
 * line a model reads instead of listening.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { defaultOutputPath, hashSpec, measure, resolvePath, toWavBytes, writeFileAtomic } from './audio.js'
import { GENRES, KEYS, MODES, composeScore } from './compose.js'
import { clamp, specHash } from './dsp.js'
import { midiToPlan, parseMidiFile, scoreToMid, writeMidiFile } from './midi.js'
import { VOICE_PRESETS, renderSing, singPlan } from './sing.js'

const GENRE_NAMES = Object.keys(GENRES)
const KEY_NAMES = Object.keys(KEYS)
const MODE_NAMES = Object.keys(MODES)
const VOICE_NAMES = Object.keys(VOICE_PRESETS)

/** Bounds on the JSON this tool can hand back, so one big file cannot flood it. */
const MAX_TRACKS_LISTED = 12
const PREVIEW_NOTES = 6
/** A sung import is still one phrase: the `audio_sing` limits apply. */
const MAX_SING_NOTES = 256
const MAX_SING_SECONDS = 120

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

/** Wav summary in the same vocabulary as the other tools. */
function wavLine (cwd, path, bytes, metrics) {
  return [
    `Sang ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${metrics.sampleRate} Hz, ${sizeText(bytes)})`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${fmt(metrics.centroidHz)} Hz`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping'
  ].join(' · ')
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

/* ------------------------------------------------------------- read/import -- */

/**
 * Parse a `.mid`; for `import` also plan (and optionally sing) the melody.
 * @returns {Promise<object>} the tool result.
 */
async function readMidi (cwd, args, action) {
  const path = resolvePath(cwd, args.path)
  if (path === undefined) throw new Error(`audio_midi ${action} needs a .mid file path`)
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

  const result = {
    action,
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
    text: ''
  }

  if (action === 'import') {
    // A sung line has to be monophonic and in range; the plan reports both.
    const plan = midiToPlan(parsed, {
      track: args.track,
      bpm: args.bpm,
      maxNotes: args.maxNotes,
      maxSeconds: MAX_SING_SECONDS,
      syllable: args.syllable
    })
    warnings.push(...plan.warnings)
    result.singable = {
      track: plan.source.track,
      trackIndex: plan.source.trackIndex,
      channel: plan.source.channel,
      notes: plan.notes.length,
      bpm: plan.bpm,
      totalSeconds: plan.totalSeconds,
      preview: plan.notes.slice(0, PREVIEW_NOTES).map((note) => [note.midi, note.startBeat, note.durBeats])
    }

    if (args.render === true) {
      const request = singPlan({ bpm: plan.bpm, notes: plan.notes })
      if (request.notes.length > MAX_SING_NOTES) {
        throw new Error(`audio_midi: ${request.notes.length} notes exceeds the ${MAX_SING_NOTES} note singing limit; raise maxNotes or pick a shorter track`)
      }
      if (request.totalSeconds > MAX_SING_SECONDS) {
        throw new Error(`audio_midi: ${fmt(request.totalSeconds)} s exceeds the ${MAX_SING_SECONDS} s singing limit; lower maxNotes or raise bpm`)
      }
      const requestedVoice = args.voice === undefined || args.voice === null ? 'alto' : String(args.voice)
      const voice = VOICE_PRESETS[requestedVoice] !== undefined ? requestedVoice : 'alto'
      if (voice !== requestedVoice) warnings.push(`unknown voice "${requestedVoice}"; sang with "${voice}"`)
      const sampleRate = clamp(Math.round(Number(args.sampleRate ?? 44100)), 8000, 96000)
      const rendered = renderSing(request, {
        voice,
        vibrato: args.vibrato,
        breath: args.breath,
        harmony: args.harmony,
        seed: 1,
        sampleRate
      })
      const wavBytes = toWavBytes(rendered.samples, rendered.sampleRate)
      const hash = hashSpec({
        engine: 'midi/import-render/1',
        notes: request.notes.map((note) => [note.midi, note.startBeat, note.durBeats]),
        bpm: request.bpm,
        voice,
        seed: 1,
        sampleRate: rendered.sampleRate
      })
      const stem = basename(path).replace(/\.[^.\\/]+$/, '') || 'midi'
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, `midi-${stem}`, hash)
      await writeFileAtomic(target, wavBytes)
      const info = await stat(target)
      const metrics = { ...measure(rendered.samples, rendered.sampleRate), sampleRate: rendered.sampleRate }
      result.render = {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: metrics.durationSeconds,
        sampleRate: rendered.sampleRate,
        bpm: request.bpm,
        notes: request.notes.length,
        voice,
        metrics
      }
      lines.push(wavLine(cwd, target, info.size, metrics))
    } else if (args.render !== undefined && args.render !== false) {
      warnings.push('render only accepts true/false; nothing was sung')
    }
  }

  const sang = result.singable === undefined
    ? ''
    : `singable: ${result.singable.notes} note(s) from "${result.singable.track ?? `track ${result.singable.trackIndex + 1}`}" at ${fmt(result.singable.bpm)} BPM (${fmt(result.singable.totalSeconds, 2)}s)`
  if (sang !== '') lines.push(sang)
  if (tracksOmitted > 0) lines.push(`note: ${tracksOmitted} more track(s) omitted from this summary`)
  for (const warning of warnings) lines.push(`warning: ${warning}`)
  result.text = lines.join('\n')
  return result
}

/* ------------------------------------------------------------------- tools -- */

/**
 * Register the MIDI export/import tool on `ctx.tools`.
 * @param {object} ctx - Cordis registrant context.
 */
export function registerMidiTools (ctx) {
  ctx.tools.register({
    name: 'audio_midi',
    description: 'Export a composed score to a Standard MIDI File (.mid) a DAW or notation app can open, or import an existing .mid as notes (optionally singing it to a .wav). Use it when the deliverable must be editable music rather than rendered audio, or when the user brings music in. export accepts a score object (the audio_compose result) or a genre to compose in one call; import/parse read a .mid and return its tempo, tracks, note count and duration.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'import', 'parse'], description: 'export=score or genre in, .mid out. import=.mid in, summary plus optional sung .wav. parse=.mid in, JSON summary only.' },
        score: { type: 'object', additionalProperties: true, description: 'The score to export, in the audio_compose shape (bpm, beatsPerBar, bars, tracks[].notes[]). Use this to export music already composed in the conversation instead of composing again.' },
        genre: { type: 'string', enum: GENRE_NAMES, description: 'Export by composing in one call: the same eight genres as audio_compose. Ignored when score is given.' },
        bpm: { type: 'number', description: 'Tempo 40..220. Export: the file tempo (defaults to the genre tempo). import+render: retimes the sung line instead of using the file tempo.' },
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
        path: { type: 'string', description: 'import/parse: the .mid file to read, relative to the working directory or absolute.' },
        out: { type: 'string', description: 'Output path. export defaults to assets/audio/<label>-<hash>.mid; import+render defaults to assets/audio/midi-<name>-<hash>.wav.' },
        render: { type: 'boolean', description: 'import only: also sing the melody to a .wav with the built-in formant voice, so the imported tune is audible.' },
        track: { anyOf: [{ type: 'string' }, { type: 'integer' }], description: 'import only: which track to sing. An index, or part of a track name ("melody"). Defaults to the track named like a melody, else the one with the most notes.' },
        voice: { type: 'string', enum: VOICE_NAMES, description: 'Singing voice for render, same ids as audio_sing; default alto.' },
        vibrato: { type: 'number', description: 'Formant voice vibrato depth 0..1; 0 keeps the pitch measurable on import.' },
        breath: { type: 'number', description: 'Formant voice breathiness 0..1.' },
        harmony: { type: 'string', enum: ['third', 'fifth', 'octave'], description: 'Add a harmony voice a third/fifth/octave above while singing.' },
        syllable: { type: 'string', description: 'Pinyin syllable to sing on every note; default "la".' },
        maxNotes: { type: 'integer', description: 'import: cap on notes sung from the file (default 256, hard limit 256).' },
        ticksPerQuarter: { type: 'integer', description: 'export: MIDI timing resolution, 24..9600; default 480.' },
        sampleRate: { type: 'integer', description: 'import+render: defaults to 44100.' }
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
      readNumber('audio_midi', 'maxNotes', args.maxNotes)
      readNumber('audio_midi', 'sampleRate', args.sampleRate)
      readNumber('audio_midi', 'vibrato', args.vibrato)
      readNumber('audio_midi', 'breath', args.breath)
      if (action === 'export') return exportMidi(cwd, args)
      if (action === 'import' || action === 'parse') return readMidi(cwd, args, action)
      throw new Error(`audio_midi: action must be "export", "import" or "parse", got ${describeValue(args.action)}`)
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
