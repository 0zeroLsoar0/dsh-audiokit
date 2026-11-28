/**
 * `audio_sampler`: the sampled tier behind one tool.
 *
 * This is the tool an agent reaches for when the sound already exists as a
 * recording — the user's own kick, a breath, a pluck, a held pad — and the job is
 * to play it as an instrument: pitch it across a keyboard, layer it by velocity,
 * cycle takes round-robin, loop a sustain, gate it with an envelope. It is also
 * the only tone generator here that ships no audio at all: the caller names a
 * file the user already owns, so there is no bank to download and no licence to
 * check.
 *
 * The one caveat is stated in the description rather than hidden in a doc: a
 * sampler pitches by resampling, so pitch and speed move together. The tool
 * therefore returns the pitch shift range it applied, and points at
 * `audio_stretch` for the case where duration must not change.
 *
 * The result is the same bounded summary the rest of the plugin returns — path,
 * bytes, duration, measured level — plus a zone table and the render report so
 * the caller can see which zone answered each note without listening.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { SAMPLER_LIMITS, buildKeymap, midiToName, renderSampler, samplerInfo } from './sampler.js'
import { noteToMidi, parseMelody } from './pinyin.js'

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

function sizeLabel (bytes) {
  return bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  return number
}

/** Accept a MIDI number or a note name ("A3") and return a MIDI number. */
function readMidi (tool, key, value) {
  if (value === undefined || value === null || value === '') return undefined
  const midi = typeof value === 'number' ? Math.round(value) : noteToMidi(value)
  if (midi === null || midi === undefined || !Number.isFinite(midi) || midi < 0 || midi > 127) {
    throw new Error(`${tool}: ${key} must be a MIDI note 0..127 or a name like "C4", got ${describeValue(value)}`)
  }
  return midi
}

/**
 * The loop options a zone inherits from the tool arguments.
 *
 * Per zone overrides first (a multi-sampled instrument may loop only its pad
 * zone), then the tool-level `loop`: true asks the engine for an auto sustain
 * loop, an object names the region, absent means one-shot.
 */
function loopFromArgs (tool, args, item) {
  if (item.loopStart !== undefined || item.loopEnd !== undefined) {
    return { loopStart: item.loopStart, loopEnd: item.loopEnd }
  }
  if (item.loop === false) return {}
  if (item.loop === true) return { loop: true }
  const loop = args.loop
  if (loop === undefined || loop === null || loop === false) return {}
  if (loop === true) return { loop: true }
  if (typeof loop === 'object') {
    if (loop.start === undefined || loop.end === undefined) {
      throw new Error(`${tool}: loop needs { start, end } in seconds, or true for an auto sustain loop`)
    }
    return { loopStart: readNumber(tool, 'loop.start', loop.start), loopEnd: readNumber(tool, 'loop.end', loop.end) }
  }
  throw new Error(`${tool}: loop must be true, false or { start, end }, got ${describeValue(loop)}`)
}

/**
 * Turn the `samples` argument into a zone map.
 *
 * A string is one zone; an array is either round-robin takes (plain paths, one
 * layer, one range) or explicit zone objects, which is how velocity layers and
 * multi-sampled instruments are expressed without a second tool.
 */
function zonesFromArgs (tool, args, cwd) {
  const raw = args.samples
  if (raw === undefined || raw === null) {
    throw new Error(`${tool}: samples is required — a .wav path, or an array of paths or zone objects`)
  }
  const items = Array.isArray(raw) ? raw : [raw]
  if (items.length === 0) throw new Error(`${tool}: samples is empty`)
  if (items.length > SAMPLER_LIMITS.maxZones) {
    throw new Error(`${tool}: ${items.length} samples is more than the ${SAMPLER_LIMITS.maxZones} zones a keymap holds`)
  }

  const defaultRoot = readMidi(tool, 'rootMidi', args.rootMidi) ?? 60
  const defaultLow = readMidi(tool, 'lowMidi', args.lowMidi) ?? 0
  const defaultHigh = readMidi(tool, 'highMidi', args.highMidi) ?? 127
  if (defaultLow > defaultHigh) throw new Error(`${tool}: lowMidi ${defaultLow} must not be above highMidi ${defaultHigh}`)
  const specs = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (typeof item === 'string') {
      const path = resolvePath(cwd, item)
      if (path === undefined) throw new Error(`${tool}: samples[${index}] is empty`)
      specs.push({
        path,
        rootMidi: defaultRoot,
        lowMidi: defaultLow,
        highMidi: defaultHigh,
        tuneCents: readNumber(tool, 'tuneCents', args.tuneCents) ?? 0,
        ...loopFromArgs(tool, args, {})
      })
      continue
    }
    if (item === null || typeof item !== 'object') {
      throw new Error(`${tool}: samples[${index}] must be a path or an object { path, rootMidi, lowMidi, highMidi, ... }, got ${describeValue(item)}`)
    }
    const path = resolvePath(cwd, item.path)
    if (path === undefined) throw new Error(`${tool}: samples[${index}] needs a path`)
    specs.push({
      path,
      name: typeof item.name === 'string' ? item.name : undefined,
      rootMidi: readMidi(tool, `samples[${index}].rootMidi`, item.rootMidi) ?? defaultRoot,
      lowMidi: readMidi(tool, `samples[${index}].lowMidi`, item.lowMidi) ?? defaultLow,
      highMidi: readMidi(tool, `samples[${index}].highMidi`, item.highMidi) ?? defaultHigh,
      tuneCents: readNumber(tool, `samples[${index}].tuneCents`, item.tuneCents) ?? readNumber(tool, 'tuneCents', args.tuneCents) ?? 0,
      gainDb: readNumber(tool, `samples[${index}].gainDb`, item.gainDb) ?? 0,
      velocityLo: readNumber(tool, `samples[${index}].velocityLo`, item.velocityLo) ?? 0,
      velocityHi: readNumber(tool, `samples[${index}].velocityHi`, item.velocityHi) ?? 1,
      ...loopFromArgs(tool, args, item)
    })
  }
  return { specs, defaultRoot }
}

/**
 * Expand `notes` / `melody` into the note list `renderSampler` expects.
 *
 * With neither, the root note is auditioned for two beats: pointing at a file
 * and asking nothing else is a legitimate first call, and returning silence
 * would be a worse answer than playing the recording back once.
 */
function notesFromArgs (tool, args, rootMidi, defaultVelocity) {
  const notes = []
  if (Array.isArray(args.notes) && args.notes.length > 0) {
    for (let index = 0; index < args.notes.length; index += 1) {
      const item = args.notes[index]
      if (item === null || item === undefined) continue
      if (typeof item === 'number' || typeof item === 'string') {
        notes.push({ midi: readMidi(tool, `notes[${index}]`, item), velocity: defaultVelocity })
        continue
      }
      if (typeof item !== 'object') throw new Error(`${tool}: notes[${index}] must be a note number, a note name or an object, got ${describeValue(item)}`)
      if (item.midi === null || item.rest === true) {
        notes.push({ midi: null, durBeats: readNumber(tool, `notes[${index}].durBeats`, item.durBeats ?? item.dur) ?? 1 })
        continue
      }
      const midi = readMidi(tool, `notes[${index}].midi`, item.midi ?? item.note)
      if (midi === undefined) throw new Error(`${tool}: notes[${index}] needs a midi number (or midi: null for a rest)`)
      notes.push({
        midi,
        startBeat: readNumber(tool, `notes[${index}].startBeat`, item.startBeat ?? item.beat),
        durBeats: readNumber(tool, `notes[${index}].durBeats`, item.durBeats ?? item.dur ?? item.duration),
        velocity: readNumber(tool, `notes[${index}].velocity`, item.velocity) ?? defaultVelocity
      })
    }
  } else if (typeof args.melody === 'string' && args.melody.trim() !== '') {
    for (const parsed of parseMelody(args.melody)) notes.push({ midi: parsed.midi, durBeats: parsed.durBeats, velocity: defaultVelocity })
  } else {
    notes.push({ midi: rootMidi, durBeats: 2, velocity: defaultVelocity })
  }
  if (notes.every((note) => note.midi === null)) {
    throw new Error(`${tool}: notes/melody contained no playable notes (only rests)`)
  }
  return notes
}

/** The one-line summary a model reads instead of listening. */
function summaryText (cwd, target, sourceLabel, rootLabel, rangeLabel, metrics, report, size) {
  const parts = [
    `Sampled ${report.noteCount} note${report.noteCount === 1 ? '' : 's'} from ${sourceLabel} (${rootLabel}${rangeLabel}), ${fmt(metrics.durationSeconds, 2)} s, peak ${fmt(metrics.peakDbfs, 1)} dBFS`,
    `wrote ${displayPath(cwd, target)} (${size})`,
    `rms ${fmt(metrics.rmsDbfs, 1)} dBFS`,
    report.loopedNotes > 0 ? `looped ${report.loopedNotes} note${report.loopedNotes === 1 ? '' : 's'} (${report.loopWraps} wrap${report.loopWraps === 1 ? '' : 's'})` : 'one-shot',
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping'
  ]
  if (report.unmappedNotes.length > 0) {
    const list = report.unmappedNotes.map((note) => midiToName(note.midi)).join(', ')
    parts.push(`${report.unmappedNotes.length} note(s) outside the keymap (${list})`)
  }
  if (report.unmatchedVelocityCount > 0) {
    const list = report.unmatchedVelocityNotes
      .map((note) => `${midiToName(note.midi)}@${fmt(note.velocity, 2)}`)
      .join(', ')
    parts.push(`${report.unmatchedVelocityCount} note(s) matched no velocity band${list === '' ? '' : ` (${list})`}`)
  }
  return parts.join(' · ')
}

/** Register the `audio_sampler` tool. */
export function registerSamplerTools (ctx) {
  const tool = 'audio_sampler'
  ctx.tools.register({
    name: tool,
    description: 'Play the user\'s own recorded .wav as an instrument: pitch it across the keyboard, map velocity layers and round-robin takes, loop a sustain region with a click-free crossfade, and gate it with an ADSR envelope. This is the sampled tier — it ships no audio, so there is nothing to license and nothing to download: point it at a file the user already has. Playback is interpolated resampling, so pitch and speed move together (a note an octave up plays twice as fast); use audio_stretch when the duration must not change.',
    parameters: {
      type: 'object',
      properties: {
        samples: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } }
          ],
          description: 'The recording(s) to play: a .wav path, or an array of paths (extra takes of the same note, cycled round-robin), or an array of zone objects { path, rootMidi, lowMidi, highMidi, loopStart, loopEnd, tuneCents, gainDb, velocityLo, velocityHi, name } for velocity layers and multi-sampled instruments. Relative paths resolve against the working directory.'
        },
        rootMidi: { type: 'integer', description: 'MIDI note the recording was played at (60 = C4, 69 = A4 = 440 Hz); default 60. A zone object overrides it.' },
        lowMidi: { type: 'integer', description: 'Lowest MIDI note the sample answers; default 0. A zone object overrides it.' },
        highMidi: { type: 'integer', description: 'Highest MIDI note the sample answers; default 127. A zone object overrides it.' },
        notes: {
          type: 'array',
          items: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'object', additionalProperties: true }] },
          description: 'Notes to play, in order: { midi, startBeat?, durBeats?, velocity? } (midi may be a number or a name; midi: null is a rest), or bare MIDI numbers / note names placed end to end. Omit with no melody to audition the sample once.'
        },
        melody: { type: 'string', description: 'Compact melody such as "C4:1 E4:1 G4:2" (pitch:beats; "r" is a rest), same syntax as audio_midi note lists. Used when notes is absent.' },
        bpm: { type: 'number', description: 'Tempo the startBeat/durBeats are measured in (20..400); default 96.' },
        envelope: { type: 'object', additionalProperties: true, description: 'ADSR: { attack, decay, release } in seconds and { sustain } 0..1. Default a 2 ms de-click attack and a 50 ms release. Applied after pitch, so a recorded transient survives a slow pitch.' },
        loop: {
          anyOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: true }],
          description: 'true = auto sustain loop (25%..95% of each sample); { start, end } = loop region in seconds; omit for a one-shot. The loop is crossfaded, so the seam does not click.'
        },
        tuneCents: { type: 'number', description: 'Fine tuning in cents, applied to every zone (a zone object can override); default 0.' },
        velocity: { type: 'number', description: 'Velocity for every note that does not carry one, 0..1; default 1. It also selects the layer when zones define velocityLo/velocityHi, and scales the note gain.' },
        seed: { type: 'integer', description: 'Rotates which round-robin take plays first; the same seed renders the same bytes. Default 1.' },
        sampleRate: { type: 'integer', description: 'Output rate; defaults to 44100. Zones recorded at another rate are converted on playback.' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/sampler-<hash>.wav.' }
      },
      required: ['samples'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Sample ${typeof args.samples === 'string' ? args.samples : (Array.isArray(args.samples) ? `${args.samples.length} file(s)` : 'recording')}`,
      kind: 'other',
      rawInput: { samples: args.samples, rootMidi: args.rootMidi, notes: args.notes, melody: args.melody, bpm: args.bpm, loop: args.loop }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      if (args.envelope !== undefined && args.envelope !== null && (typeof args.envelope !== 'object' || Array.isArray(args.envelope))) {
        throw new Error(`${tool}: envelope must be an object like { attack: 0.002, decay: 0, sustain: 1, release: 0.05 }`)
      }
      const sampleRate = readNumber(tool, 'sampleRate', args.sampleRate) ?? 44100
      const bpm = readNumber(tool, 'bpm', args.bpm) ?? 96
      const seed = readNumber(tool, 'seed', args.seed) ?? 1
      const velocity = readNumber(tool, 'velocity', args.velocity) ?? 1
      if (!(velocity >= 0 && velocity <= 1)) throw new Error(`${tool}: velocity must be 0..1, got ${velocity}`)

      const { specs, defaultRoot } = zonesFromArgs(tool, args, cwd)
      const notes = notesFromArgs(tool, args, defaultRoot, velocity)
      const keymap = buildKeymap(specs)
      const rendered = renderSampler({
        keymap,
        notes,
        bpm,
        envelope: args.envelope ?? undefined,
        seed,
        sampleRate
      })
      const report = rendered.report

      finalize(rendered.samples, rendered.sampleRate, -1)
      const bytes = toWavBytes(rendered.samples, rendered.sampleRate)
      const hash = hashSpec({
        samples: keymap.zones.map((zone) => ({
          path: zone.path === undefined ? zone.name : displayPath(cwd, zone.path),
          root: zone.rootMidi,
          low: zone.lowMidi,
          high: zone.highMidi,
          velocity: `${zone.velocityLo}-${zone.velocityHi}`,
          loop: zone.loop === null ? null : [Number(zone.loop.startSeconds.toFixed(4)), Number(zone.loop.endSeconds.toFixed(4))],
          tune: zone.tuneCents,
          gain: zone.gainDb
        })),
        notes: notes.map((note) => ({
          midi: note.midi,
          startBeat: Number.isFinite(note.startBeat) ? Number(note.startBeat.toFixed(6)) : null,
          durBeats: Number((Number.isFinite(note.durBeats) ? note.durBeats : 1).toFixed(6)),
          velocity: Number((Number.isFinite(note.velocity) ? note.velocity : 1).toFixed(4))
        })),
        bpm,
        envelope: args.envelope ?? null,
        seed,
        sampleRate: rendered.sampleRate
      })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'sampler', hash)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)
      const metrics = { ...measure(rendered.samples, rendered.sampleRate), sampleRate: rendered.sampleRate }

      const zoneCount = keymap.count
      const sourceLabel = zoneCount === 1 ? keymap.zones[0].name : `${zoneCount} zones`
      const roots = [...new Set(keymap.zones.map((zone) => midiToName(zone.rootMidi)))].sort()
      const rootLabel = roots.length === 1 ? `root ${roots[0]}` : `roots ${roots.join('/')}`
      const rangeLabel = keymap.lowMidi === keymap.highMidi || (keymap.lowMidi === 0 && keymap.highMidi === 127)
        ? ''
        : `, range ${midiToName(keymap.lowMidi)}–${midiToName(keymap.highMidi)}`
      const size = info.size ?? bytes.length

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: size,
        durationSeconds: metrics.durationSeconds,
        sampleRate: rendered.sampleRate,
        zones: zoneCount,
        noteCount: report.noteCount,
        metrics,
        report,
        zonesText: samplerInfo(keymap),
        text: summaryText(cwd, target, sourceLabel, rootLabel, rangeLabel, metrics, report, sizeLabel(size))
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
