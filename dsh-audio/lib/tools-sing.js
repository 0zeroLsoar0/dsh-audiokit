/**
 * `audio_sing`: the model-facing seam over the formant singing voice.
 *
 * One tool, because a singer is one decision: what words, on what notes, in what
 * voice. The return value follows the same contract as the rest of the plugin —
 * a bounded summary, never audio bytes — plus the two things a caller cannot
 * re-derive by listening: the syllable timings in seconds (for subtitles) and a
 * measured pitch accuracy (so "it sang it" is a number, not a hope).
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  hashSpec,
  measure,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { measurePitch, midiToHz, renderSing, singPlan, VOICE_PRESETS } from './sing.js'

/** Hard bounds: a runaway request becomes a clear error, not a 10-minute render. */
const MAX_SECONDS = 120
const MAX_NOTES = 256
const MAX_TIMINGS = 64
const MAX_PITCH_NOTES = 16

const VOICE_NAMES = Object.keys(VOICE_PRESETS)

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

function round (value, digits = 2) {
  return Number(Number(value).toFixed(digits))
}

/** Peak/rms/crest/centroid line, shared with the other tools' vocabulary. */
function summaryLine (cwd, path, bytes, metrics, extra = []) {
  const size = bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
  return [
    `Wrote ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${metrics.sampleRate} Hz, ${size})`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${metrics.centroidHz} Hz`,
    `onsets ${metrics.onsets}`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping',
    ...extra
  ].join(' · ')
}

/**
 * Measure how close the sung pitch actually is to the planned pitch, per note.
 *
 * Measured on the sustain of each note by autocorrelation and reported in cents,
 * because "in tune" has to be a number: 1 % is about 17 cents.
 */
function pitchAccuracy (result, plan) {
  const items = []
  const limit = Math.min(plan.notes.length, result.syllableTimings.length, MAX_PITCH_NOTES)
  for (let index = 0; index < limit; index += 1) {
    const note = plan.notes[index]
    const timing = result.syllableTimings[index]
    const length = timing.end - timing.start
    const entering = timing.vowelStart - timing.start
    const from = Math.min(timing.start + entering + 0.04, timing.start + length * 0.5)
    const to = Math.max(from + 0.04, timing.end - Math.max(0.04, length * 0.15))
    if (to - from < 0.03) continue
    const measured = measurePitch(result.samples, result.sampleRate, { from, to, minHz: 50, maxHz: 2000 })
    if (!(measured.hz > 0) || measured.clarity < 0.5) continue
    const target = midiToHz(note.midi)
    items.push({
      syllable: timing.text,
      midi: note.midi,
      targetHz: round(target, 2),
      measuredHz: round(measured.hz, 2),
      cents: round(1200 * Math.log2(measured.hz / target), 1)
    })
  }
  if (items.length === 0) return { checked: 0, meanCents: 0, maxCents: 0, meanPercent: 0, items }
  const cents = items.map((item) => Math.abs(item.cents))
  const meanCents = cents.reduce((sum, value) => sum + value, 0) / cents.length
  return {
    checked: items.length,
    meanCents: round(meanCents, 1),
    maxCents: round(Math.max(...cents), 1),
    meanPercent: round((Math.pow(2, meanCents / 1200) - 1) * 100, 2),
    items
  }
}

/** One human line about pitch, in the units a musician reads. */
function pitchLine (accuracy, multiVoice) {
  if (accuracy.checked === 0) return 'pitch: not measurable (notes too short to analyse)'
  const worst = accuracy.items.reduce((a, b) => (Math.abs(a.cents) >= Math.abs(b.cents) ? a : b))
  const scope = multiVoice ? ' (melody voice only; the harmony layer is a mix)' : ''
  return `pitch ${accuracy.checked} note(s)${scope}: first ${accuracy.items[0].measuredHz} Hz on ${accuracy.items[0].syllable} (target ${accuracy.items[0].targetHz} Hz, ${fmt(accuracy.items[0].cents)} cents) · mean |error| ${fmt(accuracy.meanCents)} cents (${fmt(accuracy.meanPercent, 2)} %) · worst ${fmt(worst.cents)} cents`
}

/** Syllable timings as a short two-dot list, in seconds. */
function timingsLine (timings, total) {
  const shown = timings.slice(0, 12).map((item) => `${item.text} ${item.start.toFixed(2)}-${item.end.toFixed(2)}`)
  const more = total > shown.length ? ` … +${total - shown.length} more` : ''
  return `syllables (seconds, for subtitles): ${shown.join(' · ')}${more}`
}

/**
 * Register the `audio_sing` tool.
 * @param {object} ctx - registrant context with a `tools` service.
 */
export function registerSingTools (ctx) {
  ctx.tools.register({
    name: 'audio_sing',
    description: 'Sing words in a formant-synthesized voice: give notes (MIDI numbers or a melody string) and a pinyin lyric. Zero-asset and deterministic — no voicebank, no network, no key — so it is the always-available tier when audio_tts has no provider or when the cue is *melodic* rather than spoken. Returns the file, syllable timings in seconds for subtitles, and measured pitch accuracy in cents. The timbre is clearly synthetic; do not promise naturalness this engine cannot deliver.',
    parameters: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          description: 'Melody as explicit notes: {midi, dur, syllable?}. midi is a MIDI number (60 = C4, 69 = A4) or a name like "A3"/"C#4"; dur is in beats; syllable is pinyin and may be omitted (the lyric fills it, else "la").',
          items: {
            type: 'object',
            properties: {
              midi: { type: 'number', description: 'MIDI note number (60 = C4, 69 = A4, 57 = A3).' },
              dur: { type: 'number', description: 'Duration in beats (0.25 = a sixteenth at 4/4).' },
              syllable: { type: 'string', description: 'Pinyin syllable for this note, e.g. "ma". Omit to take it from the lyric.' },
              beat: { type: 'number', description: 'Optional absolute start in beats; otherwise notes follow each other.' },
              velocity: { type: 'number', description: 'Optional 0..1 loudness weighting for this note.' }
            },
            additionalProperties: true
          }
        },
        melody: { type: 'string', description: 'Compact melody such as "C4:1 E4:1 G4:2" (pitch:beats; "r" is a rest). Use this instead of notes for a quick line.' },
        lyric: { type: 'string', description: 'Words to sing, space separated, in pinyin ("wo ai ni"). Han characters cannot be romanized without a dictionary, so they fall back to "a" with a warning — pass pinyin.' },
        bpm: { type: 'number', description: 'Tempo; one beat is 60 / bpm seconds. Defaults to 96.' },
        voice: { type: 'string', enum: VOICE_NAMES, description: 'Voice colour: alto (default, neutral adult), child (higher formants, brighter), bass (lower formants, darker), breathy (more air), choir (three detuned voices plus room).' },
        vibrato: { type: 'number', description: '0..1 vibrato depth (1 is about ±55 cents) with a delayed onset. Defaults to the voice preset.' },
        breath: { type: 'number', description: '0..1 breathiness: gated noise shaped by the vowel formants. Defaults to the voice preset.' },
        harmony: { type: 'string', enum: ['third', 'fifth', 'octave'], description: 'Add a harmony voice that many semitones above. Fixed intervals, so pick the notes to stay in key.' },
        seed: { type: 'integer', description: 'Variation seed. Same seed and same request reproduce the same bytes.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100. Use 48000 when the deliverable is video.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/sing-<hash>.wav.' }
      },
      required: [],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Sing ${String(args.lyric ?? args.melody ?? (Array.isArray(args.notes) ? `${args.notes.length} notes` : 'a voice')).slice(0, 40)}`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const plan = singPlan({
        notes: args.notes,
        melody: args.melody,
        lyric: args.lyric,
        bpm: args.bpm
      })
      if (plan.notes.length > MAX_NOTES) {
        throw new Error(`audio_sing: ${plan.notes.length} notes exceeds the ${MAX_NOTES} note limit; split the phrase`)
      }
      if (plan.totalSeconds > MAX_SECONDS) {
        throw new Error(`audio_sing: ${fmt(plan.totalSeconds)} s exceeds the ${MAX_SECONDS} s limit; split the phrase or raise bpm`)
      }

      const options = {
        voice: args.voice,
        vibrato: args.vibrato,
        breath: args.breath,
        harmony: args.harmony,
        seed: Number.isFinite(args.seed) ? args.seed : 1,
        sampleRate: args.sampleRate
      }
      const rendered = renderSing(plan, options)
      const samples = rendered.samples
      const sampleRate = rendered.sampleRate
      const metrics = { ...measure(samples, sampleRate), sampleRate }

      const hash = hashSpec({
        engine: 'sing/1',
        notes: plan.notes.map((note) => [note.midi, note.startBeat, note.durBeats, note.syllable]),
        bpm: plan.bpm,
        voice: options.voice ?? 'alto',
        vibrato: options.vibrato ?? null,
        breath: options.breath ?? null,
        harmony: options.harmony ?? null,
        seed: options.seed,
        sampleRate
      })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'sing', hash)
      const bytes = toWavBytes(samples, sampleRate)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)

      const accuracy = pitchAccuracy(rendered, plan)
      const multiVoice = Boolean(args.harmony) || (VOICE_PRESETS[String(args.voice ?? '')]?.voices ?? 1) > 1
      // Autocorrelation on a two-voice mix locks onto the common period of the
      // harmony, not the melody (C4 + E4 reads as C3). When the render is a mix,
      // measure a melody-only copy so the reported accuracy describes the line.
      const measuredAccuracy = multiVoice
        ? pitchAccuracy(renderSing(plan, { ...options, harmony: undefined, voice: 'alto' }), plan)
        : accuracy
      const timings = rendered.syllableTimings
      const cappedTimings = timings.slice(0, MAX_TIMINGS)
      const cappedAccuracy = {
        ...measuredAccuracy,
        items: measuredAccuracy.items.slice(0, MAX_PITCH_NOTES)
      }
      const header = `voice ${String(args.voice ?? 'alto')} · bpm ${fmt(plan.bpm, 0)} · ${plan.notes.length} note(s) · ${timings.length} syllable(s)${args.harmony ? ` · harmony ${args.harmony}` : ''}`
      const warnings = rendered.warnings.map((warning) => `warning: ${warning}`)
      const text = [
        summaryLine(cwd, target, info.size, metrics, [header]),
        pitchLine(measuredAccuracy, multiVoice),
        timingsLine(cappedTimings, timings.length),
        ...warnings
      ].join('\n')

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: metrics.durationSeconds,
        sampleRate,
        bpm: plan.bpm,
        notes: plan.notes.length,
        voice: String(args.voice ?? 'alto'),
        metrics,
        syllableTimings: cappedTimings,
        syllableCount: timings.length,
        pitchAccuracy: cappedAccuracy,
        pitchTrack: { frameRate: rendered.pitchTrack.frameRate, samples: rendered.pitchTrack.hz.length },
        warnings: rendered.warnings,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
