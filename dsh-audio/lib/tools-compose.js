/**
 * The composition tool.
 *
 * `audio_compose` is the one call that turns "I need music under this scene"
 * into a file plus the numbers needed to cut picture to it: the beat grid in
 * seconds, the chord per bar, and per-track per-section levels. It is a
 * different job from `audio_synth` (one sound) and `audio_pattern` (one sound
 * repeated), so it gets its own tool rather than another preset.
 *
 * Like every other tool here it returns a bounded summary, never audio bytes,
 * and the file name is a hash of the render spec so identical requests converge
 * on one path.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { defaultOutputPath, hashSpec, measure, resolvePath, writeFileAtomic } from './audio.js'
import { GENRES, KEYS, MODES, composeScore, renderScore, toComposeWavBytes } from './compose.js'

const GENRE_NAMES = Object.keys(GENRES)
const KEY_NAMES = Object.keys(KEYS)
const MODE_NAMES = Object.keys(MODES)

/** The beat grid is capped so a long cue cannot flood the model's context. */
const BEAT_MAP_LIMIT = 256

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

/**
 * Subsample the beat grid to at most `BEAT_MAP_LIMIT` entries.
 * @returns {{ beatMap: number[], beatMapStride: number }}
 */
function beatMapWindow (beatMap) {
  const stride = Math.max(1, Math.ceil(beatMap.length / BEAT_MAP_LIMIT))
  const values = []
  for (let index = 0; index < beatMap.length; index += stride) values.push(beatMap[index])
  return { beatMap: values, beatMapStride: stride }
}

/** Chord line for the model: one `Am`/`G7` token per chord change, tagged by bar. */
function chordLine (score) {
  return score.chords.map((chord) => `bar ${chord.bar + 1} ${chord.name}`).join(' | ')
}

/** One human-readable multi-line report; the model reads this instead of listening. */
function buildText (score, rendered, metrics, cwd, path, bytes, beatMapStride) {
  const size = bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
  const secondsPerBeat = 60 / score.bpm
  const mode = MODES[score.mode]
  const totalNotes = score.tracks.reduce((sum, track) => sum + track.notes.length, 0)
  const summary = [
    `Composed ${score.genre} ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${score.bars} bars @ ${fmt(score.bpm)} BPM, ${size})`,
    `key ${score.key} ${mode.label}`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${metrics.centroidHz} Hz`,
    `${totalNotes} notes`,
    `onsets ${metrics.onsets}`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping',
    `progression ${score.progression.join(' ')}`
  ].join(' · ')

  const sections = rendered.sectionStats
    .map((section) => `${section.name} bars ${section.fromBar + 1}-${section.toBar} (i${fmt(section.intensity, 2)}, rms ${fmt(section.rmsDbfs)} dBFS)`)
    .join(' · ')

  const tracks = rendered.trackStats
    .map((track) => `${track.id}/${track.instrument} ${track.notes}n ${fmt(track.rmsDbfs)} dBFS`)
    .join(' · ')

  const timing = [
    `beat ${fmt(secondsPerBeat, 3)}s`,
    `bar ${fmt(secondsPerBeat * score.beatsPerBar, 3)}s`,
    `beatMap ${score.beatMap.length} entries (stride ${beatMapStride})`,
    score.loop ? `loop seam ${fmt(metrics.loopSeam)} dB` : `tail ${fmt(metrics.durationSeconds - score.bars * score.beatsPerBar * secondsPerBeat, 2)}s`
  ].join(' · ')

  return [summary, `sections: ${sections}`, `chords: ${chordLine(score)}`, `tracks: ${tracks}`, `timing: ${timing}`].join('\n')
}

/**
 * Register the composition tool on `ctx.tools`.
 * @param {object} ctx - Cordis registrant context.
 */
export function registerComposeTools (ctx) {
  ctx.tools.register({
    name: 'audio_compose',
    description: 'Compose and render a short music cue for an animation: real harmony (diatonic chords, genre progressions, voice leading), sections (intro/build/drop/outro), five arranged tracks and a drum groove, deterministic from the seed. Returns the file, the beattimes in seconds, the chord per bar and per-track levels so hits can be synced to picture.',
    parameters: {
      type: 'object',
      properties: {
        genre: {
          type: 'string',
          enum: GENRE_NAMES,
          description: 'Musical style. cinematic=slow orchestral pads and timpani, lofi=warm swung boom-bap with seventh chords, chiptune=fast square arps and noise drums, ambient=very slow pads and bells, action=driving sixteenth bass and rock kit, horror=dissonant drones and metal, fantasy=lydian harp and flute, ui-menu=short bright plucks for interface loops.'
        },
        bpm: { type: 'number', description: 'Tempo 40..220; defaults to the genre\'s tempo (52 ambient .. 158 action).' },
        bars: { type: 'integer', description: 'Length in bars of 4/4, 1..96; defaults to 16. Sixteen bars is a complete cue with intro, build, drop and outro; cues are capped at 180 seconds of audio.' },
        key: { type: 'string', enum: KEY_NAMES, description: 'Tonic note name; defaults to the genre\'s key.' },
        mode: {
          type: 'string',
          enum: MODE_NAMES,
          description: 'Scale the melody uses; harmony is stacked from the diatonic parent. aeolian=minor, ionian=major, dorian=lofi jazz, phrygian=action tension, lydian=fantasy, locrian=horror.'
        },
        seed: { type: 'integer', description: 'Variation seed: same seed, same score and same audio bytes. Change it for a sibling arrangement.' },
        intensity: { type: 'number', description: 'Arrangement energy 0..1; scales note density, drum layers, register and how many chord tones are voiced. Defaults to 0.6.' },
        loop: { type: 'boolean', description: 'Render a loop-safe cue: no intro/outro, a turnaround into the loop point and tails folded back onto the head, so it repeats without a thump. Use for interface/menu music.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100. Use 22050 for small inline files, 48000 for video-grade output.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/compose-<genre>-<hash>.wav.' },
        sections: {
          type: 'array',
          description: 'Optional section form override; each entry is a contiguous bar range and an intensity. Without it the form is intro/build/drop/outro (or build/drop when loop is true).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', enum: ['intro', 'build', 'drop', 'outro'], description: 'Section role; build ramps up, outro tapers, drop holds the peak.' },
              fromBar: { type: 'integer', description: 'First bar of the section, 0-based.' },
              toBar: { type: 'integer', description: 'Bar after the last bar of the section, 0-based.' },
              intensity: { type: 'number', description: '0..1 target energy for this section.' }
            },
            required: ['name', 'fromBar', 'toBar'],
            additionalProperties: false
          }
        }
      },
      required: ['genre'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Compose ${args.genre ?? 'music'}`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const genre = String(args.genre ?? '')
      if (GENRES[genre] === undefined) {
        throw new Error(`unknown genre "${genre}"; available: ${GENRE_NAMES.join(', ')}`)
      }
      if (args.key !== undefined && KEYS[args.key] === undefined) {
        throw new Error(`unknown key "${args.key}"; available: ${KEY_NAMES.join(', ')}`)
      }
      if (args.mode !== undefined && MODES[args.mode] === undefined) {
        throw new Error(`unknown mode "${args.mode}"; available: ${MODE_NAMES.join(', ')}`)
      }
      if (args.sections !== undefined && !Array.isArray(args.sections)) {
        throw new Error('sections must be an array of { name, fromBar, toBar, intensity }')
      }

      const cwd = sessionCwd(ctx, exec)
      const spec = {
        genre,
        bpm: Number.isFinite(Number(args.bpm)) ? Number(args.bpm) : undefined,
        bars: Number.isFinite(Number(args.bars)) ? Math.round(Number(args.bars)) : 16,
        key: args.key,
        mode: args.mode,
        seed: Number.isFinite(Number(args.seed)) ? Math.round(Number(args.seed)) : 1,
        intensity: Number.isFinite(Number(args.intensity)) ? Number(args.intensity) : 0.6,
        loop: args.loop === true,
        sampleRate: Number.isFinite(Number(args.sampleRate)) ? Math.round(Number(args.sampleRate)) : 44100,
        sections: args.sections
      }
      const hash = hashSpec(spec)
      const score = composeScore(spec)
      // Rendering is linear in cue length; a forty-minute ambient cue is a
      // mistake worth reporting instead of silently allocating gigabytes.
      const cueSeconds = score.bars * score.beatsPerBar * 60 / score.bpm
      if (cueSeconds > 180) {
        throw new Error(`cue is too long to render (${Math.round(cueSeconds)}s); reduce bars or raise bpm (limit 180s)`)
      }
      const rendered = renderScore(score, { sampleRate: spec.sampleRate })
      const bytes = toComposeWavBytes(rendered.samples, rendered.sampleRate, score.seed)
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, `compose-${genre}`, hash)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)
      const metrics = { ...measure(rendered.samples, rendered.sampleRate), sampleRate: rendered.sampleRate }
      const grid = beatMapWindow(score.beatMap)
      const trackStats = rendered.trackStats

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: metrics.durationSeconds,
        sampleRate: rendered.sampleRate,
        bpm: score.bpm,
        bars: score.bars,
        beatsPerBar: score.beatsPerBar,
        key: score.key,
        mode: score.mode,
        genre: score.genre,
        seed: score.seed,
        loop: score.loop,
        progression: score.progression,
        sections: rendered.sectionStats.map((section) => ({
          name: section.name,
          fromBar: section.fromBar,
          toBar: section.toBar,
          intensity: section.intensity,
          rmsDbfs: section.rmsDbfs
        })),
        chords: score.chords.map((chord) => ({
          bar: chord.bar,
          beat: chord.beat,
          name: chord.name,
          midi: chord.midi,
          root: chord.root,
          pcs: chord.pcs
        })),
        beatMap: grid.beatMap,
        beatMapStride: grid.beatMapStride,
        beatCount: score.beatMap.length,
        tracks: trackStats.map((track) => ({
          id: track.id,
          role: track.role,
          instrument: track.instrument,
          notes: track.notes,
          targetDbfs: track.targetDbfs,
          rmsDbfs: track.rmsDbfs,
          peakDbfs: track.peakDbfs
        })),
        metrics,
        text: buildText(score, rendered, metrics, cwd, target, info.size, grid.beatMapStride)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
