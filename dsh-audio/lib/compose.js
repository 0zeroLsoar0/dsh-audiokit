/**
 * Music composition engine.
 *
 * Two layers, deliberately separated:
 *
 * 1. `composeScore(request)` is pure music theory. It turns a genre, a key, a
 *    tempo and an intensity into a score: chords with real voice leading,
 *    sections with an intensity curve, and five tracks (bass, harmony, melody,
 *    colour, rhythm) whose notes carry bar/beat positions, velocities,
 *    durations and articulation. A score is data — it can be inspected,
 *    diffed and re-rendered.
 * 2. `renderScore(score, options)` is the synthesizer. It turns that score into
 *    samples with the same primitives the sound-effect presets use
 *    (polyBLEP saw/square, FM bells, Karplus-Strong plucks, noise drums,
 *    detuned pads) and reports per-track and per-section measurements.
 *
 * Everything is deterministic: the same request always produces the same score
 * and the same audio bytes (see `toComposeWavBytes`). No `Math.random`, no
 * clock reads, no locale-dependent formatting.
 *
 * The genre table is where "sounds like music" actually lives: each genre pins
 * mode, register, harmonic rhythm, bass pattern, melody subdivision, timbre and
 * drum groove. Genres differ by arrangement and instrumentation, not by a
 * renamed parameter.
 */

import {
  clamp,
  dbToGain,
  dcBlock,
  decayEnvelope,
  glideTone,
  lerp,
  makeRng,
  normalizePeak,
  softLimit
} from './dsp.js'
import { encodeWav } from './wav.js'

const TAU = Math.PI * 2
const A4 = 440
const MIDI_A4 = 69

/* ------------------------------------------------------------- helpers -- */

/** Round to four decimals; keeps scores readable and determinism obvious. */
const round4 = (value) => Math.round(value * 10000) / 10000
/** Round to two decimals. */
const round2 = (value) => Math.round(value * 100) / 100

/** Uniform pick from a non-empty array. */
function pick (rand, list) {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]
}

/** Deterministic coin flip. */
function chance (rand, probability) {
  return rand() < probability
}

/** Normalise any seed to an unsigned 32-bit integer. */
function normaliseSeed (seed) {
  if (!Number.isFinite(seed)) return 1
  return (Math.round(seed) >>> 0) || 1
}

/** Lowest MIDI note at or above `low` with the given pitch class. */
function lowestMidiWithPc (pitchClass, low) {
  const base = Math.ceil(low)
  const pc = ((Math.round(pitchClass) % 12) + 12) % 12
  const offset = (((pc - base) % 12) + 12) % 12
  return base + offset
}

/** Fold a value back into [low, high] by reflection, then clamp. */
function reflectRange (position, low, high) {
  if (high <= low) return low
  let value = position
  for (let guard = 0; guard < 8 && (value < low || value > high); guard += 1) {
    if (value < low) value = 2 * low - value
    if (value > high) value = 2 * high - value
  }
  return clamp(Math.round(value), low, high)
}

/** MIDI number for a scale position above `baseMidi` (base is the scale tonic). */
function scaleMidiAt (position, baseMidi, intervals) {
  const size = intervals.length
  const octave = Math.floor(position / size)
  const index = position - octave * size
  return baseMidi + 12 * octave + (intervals[index] - intervals[0])
}

/** Highest scale position whose note still fits under `high`. */
function maxScalePos (baseMidi, intervals, high) {
  let position = 0
  while (position < 128 && scaleMidiAt(position + 1, baseMidi, intervals) <= high) position += 1
  return position
}

/* --------------------------------------------------------------- theory -- */

/** Pitch-class names used for chord names and the `key` tool argument. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * The twelve keys a score can be written in: name → pitch class.
 * `C#` and `D#` are used instead of the ambiguous flat names so the tool
 * schema has exactly one spelling per pitch.
 */
export const KEYS = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
}

/**
 * Raw scale interval tables in semitones from the tonic.
 * Heptatonic scales are the ones harmony can be stacked from; pentatonic and
 * blues scales are melody-only (see `MODES[*].harmony`).
 */
export const SCALES = {
  major: { label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { label: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  harmonicMinor: { label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { label: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  majorPentatonic: { label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPentatonic: { label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] }
}

/**
 * Modes a score can be written in.
 *
 * `scale` is what the melody improvises on; `harmony` is the heptatonic parent
 * used to stack chords (pentatonic melodies over diatonic harmony is standard
 * practice). `brightness` 0..1 is metadata for tools and tests: horror sits at
 * the dark end, lydian at the bright end.
 */
export const MODES = {
  ionian: { label: 'Ionian (major)', scale: 'major', harmony: 'major', brightness: 1, third: 4 },
  dorian: { label: 'Dorian', scale: 'dorian', harmony: 'dorian', brightness: 0.62, third: 3 },
  phrygian: { label: 'Phrygian', scale: 'phrygian', harmony: 'phrygian', brightness: 0.3, third: 3 },
  lydian: { label: 'Lydian', scale: 'lydian', harmony: 'lydian', brightness: 0.92, third: 4 },
  mixolydian: { label: 'Mixolydian', scale: 'mixolydian', harmony: 'mixolydian', brightness: 0.78, third: 4 },
  aeolian: { label: 'Aeolian (minor)', scale: 'minor', harmony: 'minor', brightness: 0.2, third: 3 },
  locrian: { label: 'Locrian', scale: 'locrian', harmony: 'locrian', brightness: 0.04, third: 3 },
  harmonicMinor: { label: 'Harmonic minor', scale: 'harmonicMinor', harmony: 'harmonicMinor', brightness: 0.18, third: 3 },
  melodicMinor: { label: 'Melodic minor', scale: 'melodicMinor', harmony: 'melodicMinor', brightness: 0.35, third: 3 },
  majorPentatonic: { label: 'Major pentatonic', scale: 'majorPentatonic', harmony: 'major', brightness: 0.95, third: 4 },
  minorPentatonic: { label: 'Minor pentatonic', scale: 'minorPentatonic', harmony: 'minor', brightness: 0.26, third: 3 },
  blues: { label: 'Blues', scale: 'blues', harmony: 'minor', brightness: 0.3, third: 3 }
}

/**
 * Chord qualities: interval stack, display suffix and a 0..1 tension weight.
 * Tension is what drives harmonic colour (sevenths appear when it is high) and
 * the resolution curve at the end of a cue.
 */
export const CHORD_QUALITIES = {
  maj: { label: 'major', suffix: '', intervals: [0, 4, 7], tension: 0.18 },
  min: { label: 'minor', suffix: 'm', intervals: [0, 3, 7], tension: 0.24 },
  dim: { label: 'diminished', suffix: 'dim', intervals: [0, 3, 6], tension: 0.72 },
  aug: { label: 'augmented', suffix: 'aug', intervals: [0, 4, 8], tension: 0.66 },
  sus2: { label: 'suspended 2', suffix: 'sus2', intervals: [0, 2, 7], tension: 0.4 },
  sus4: { label: 'suspended 4', suffix: 'sus4', intervals: [0, 5, 7], tension: 0.48 },
  maj7: { label: 'major seventh', suffix: 'maj7', intervals: [0, 4, 7, 11], tension: 0.3 },
  min7: { label: 'minor seventh', suffix: 'm7', intervals: [0, 3, 7, 10], tension: 0.38 },
  dom7: { label: 'dominant seventh', suffix: '7', intervals: [0, 4, 7, 10], tension: 0.68 },
  m7b5: { label: 'half diminished', suffix: 'm7b5', intervals: [0, 3, 6, 10], tension: 0.78 },
  dim7: { label: 'diminished seventh', suffix: 'dim7', intervals: [0, 3, 6, 9], tension: 0.88 }
}

/** Exact interval-stack → quality lookup used when harmonising a scale. */
const QUALITY_BY_STACK = new Map()
for (const [name, quality] of Object.entries(CHORD_QUALITIES)) {
  QUALITY_BY_STACK.set(quality.intervals.join(','), name)
}

/** Roman numeral for a scale degree + quality. */
function romanFor (degree, quality) {
  const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
  const spec = CHORD_QUALITIES[quality] ?? CHORD_QUALITIES.maj
  let numeral = numerals[((degree % 7) + 7) % 7]
  if (spec.intervals[1] === 3) numeral = numeral.toLowerCase()
  if (quality === 'dim') return `${numeral}°`
  if (quality === 'dim7') return `${numeral}°7`
  if (quality === 'm7b5') return `${numeral}ø7`
  if (quality === 'min7') return `${numeral}7`
  if (quality === 'maj7') return `${numeral}maj7`
  if (quality === 'dom7') return `${numeral}7`
  return numeral
}

/** Display name for a chord, e.g. `Am7`, `F`, `G7`, `Bdim`. */
function chordName (rootPc, quality) {
  const spec = CHORD_QUALITIES[quality] ?? CHORD_QUALITIES.maj
  return `${NOTE_NAMES[((rootPc % 12) + 12) % 12]}${spec.suffix}`
}

/**
 * Build the diatonic chord on a scale degree by stacking scale thirds.
 * @returns {{ degree: number, rootPc: number, pcs: number[], quality: string, tension: number }}
 */
function diatonicChord (harmonyScale, degree, keyPc, withSeventh) {
  const intervals = SCALES[harmonyScale].intervals
  const stack = withSeventh ? [0, 2, 4, 6] : [0, 2, 4]
  const pcs = []
  for (const step of stack) {
    const position = degree + step
    const octave = Math.floor(position / 7)
    const index = position - octave * 7
    const pc = (((intervals[index] + 12 * octave) % 12) + 12) % 12
    const absolute = (keyPc + pc) % 12
    if (!pcs.includes(absolute)) pcs.push(absolute)
  }
  const rootPc = pcs[0]
  const stackKey = pcs.map((pc) => ((pc - rootPc + 12) % 12)).sort((a, b) => a - b).join(',')
  let quality = QUALITY_BY_STACK.get(stackKey)
  if (quality === undefined) {
    quality = pcs.some((pc) => ((pc - rootPc + 12) % 12) === 3) ? 'min' : 'maj'
  }
  return { degree, rootPc, pcs, quality, tension: CHORD_QUALITIES[quality].tension }
}

/* --------------------------------------------------------------- genres -- */

/**
 * Drum grooves, one entry per genre.
 *
 * `steps` is a 16-step bar of 16th notes (`x` hit, `X` accented hit). Each layer
 * has a velocity and a `minIntensity` gate, so the same groove can be thin in an
 * intro and full in the drop without writing two patterns. `firstBarOfSection`
 * layers only land on the first bar of a section (crashes).
 *
 * Drum note map (General MIDI-ish): 36 kick, 37 rim, 38 snare, 39 clap,
 * 41 low tom, 43 mid tom, 42 closed hat, 46 open hat, 49 crash, 70 shaker.
 */
export const DRUM_PATTERNS = {
  cinematic: {
    label: 'Timpani and low drums',
    swing: 0,
    humanize: 0.01,
    layers: [
      { midi: 36, steps: 'x.......x.......', vel: 0.95, minIntensity: 0 },
      { midi: 41, steps: '....x.......x...', vel: 0.5, minIntensity: 0.45 },
      { midi: 49, steps: 'x...............', vel: 0.55, minIntensity: 0.55, firstBarOfSection: true }
    ]
  },
  lofi: {
    label: 'Boom-bap with swung hats',
    swing: 0.14,
    humanize: 0.012,
    layers: [
      { midi: 36, steps: 'x.......x..x....', vel: 0.85, minIntensity: 0 },
      { midi: 38, steps: '....x.......x...', vel: 0.58, minIntensity: 0.3 },
      { midi: 42, steps: 'x.x.x.x.x.x.x.x.', vel: 0.26, minIntensity: 0.15 },
      { midi: 38, steps: '.......x..x.....', vel: 0.16, minIntensity: 0.5 },
      { midi: 37, steps: '..............x.', vel: 0.2, minIntensity: 0.4 }
    ]
  },
  chiptune: {
    label: 'Noise-channel rock kit',
    swing: 0,
    humanize: 0.004,
    layers: [
      { midi: 36, steps: 'x...x...x...x...', vel: 0.9, minIntensity: 0 },
      { midi: 38, steps: '....x.......x...', vel: 0.68, minIntensity: 0.3 },
      { midi: 42, steps: 'xxxxxxxxxxxxxxxx', vel: 0.16, minIntensity: 0.2 },
      { midi: 49, steps: 'x...............', vel: 0.4, minIntensity: 0.6, firstBarOfSection: true }
    ]
  },
  ambient: {
    label: 'Heartbeat',
    swing: 0,
    humanize: 0.02,
    layers: [
      { midi: 36, steps: 'x...............', vel: 0.3, minIntensity: 0 },
      { midi: 37, steps: '........x.......', vel: 0.12, minIntensity: 0.55 }
    ]
  },
  action: {
    label: 'Four on the floor with offbeat hats',
    swing: 0,
    humanize: 0.006,
    layers: [
      { midi: 36, steps: 'x...x...x...x...', vel: 1, minIntensity: 0 },
      { midi: 38, steps: '....x.......x...', vel: 0.82, minIntensity: 0.25 },
      { midi: 42, steps: 'x.x.x.x.x.x.x.x.', vel: 0.3, minIntensity: 0.1 },
      { midi: 46, steps: '..............x.', vel: 0.28, minIntensity: 0.5 },
      { midi: 49, steps: 'x...............', vel: 0.65, minIntensity: 0.65, firstBarOfSection: true }
    ]
  },
  horror: {
    label: 'Slow pulse and metal',
    swing: 0,
    humanize: 0.025,
    layers: [
      { midi: 36, steps: 'x...............', vel: 0.45, minIntensity: 0 },
      { midi: 37, steps: '............x...', vel: 0.28, minIntensity: 0.3 },
      { midi: 49, steps: 'x...............', vel: 0.3, minIntensity: 0.65, firstBarOfSection: true }
    ]
  },
  fantasy: {
    label: 'Hand drum and shaker',
    swing: 0.03,
    humanize: 0.01,
    layers: [
      { midi: 41, steps: 'x.......x.......', vel: 0.62, minIntensity: 0 },
      { midi: 43, steps: '....x.......x...', vel: 0.4, minIntensity: 0.25 },
      { midi: 70, steps: 'x.x.x.x.x.x.x.x.', vel: 0.18, minIntensity: 0.15 },
      { midi: 37, steps: '....x.......x...', vel: 0.26, minIntensity: 0.4 }
    ]
  },
  ui: {
    label: 'Soft ticks',
    swing: 0.02,
    humanize: 0.008,
    layers: [
      { midi: 36, steps: 'x...............', vel: 0.42, minIntensity: 0 },
      { midi: 37, steps: '....x.......x...', vel: 0.26, minIntensity: 0.2 },
      { midi: 70, steps: 'x...x...x...x...', vel: 0.14, minIntensity: 0.3 },
      { midi: 42, steps: 'x.x.x.x.x.x.x.x.', vel: 0.1, minIntensity: 0.5 }
    ]
  }
}

/**
 * The eight genres.
 *
 * Every field here is arrangement, not cosmetics:
 * - `mode`/`key`/`bpm` set the musical setting.
 * - `progressions` are scale degrees (0 = tonic), chosen by seed; `harmonicRhythm`
 *   is chords per bar. `chordExt` selects triads or sevenths.
 * - `tracks.*` carries register range, rhythmic pattern, subdivision, density and
 *   the synth voice. This is what makes lofi a warm low boom-bap and chiptune a
 *   bright square-wave arpeggio at double tempo.
 * - `masterTone` is a static master filter (tape warmth for lofi, air for
 *   ambient); `reverb` is the room. `tail` is how long the cue rings after the
 *   last bar.
 * - `gainDb` is per track a *target level* in dBFS RMS, not a fader:
 *   `renderScore` levels each track to it. A pad of sixteen long notes and an
 *   arp of a hundred short ones would otherwise land 15 dB apart and bury
 *   whichever is denser.
 */
export const GENRES = {
  cinematic: {
    label: 'Cinematic',
    bpm: 76,
    key: 'A',
    mode: 'aeolian',
    progressions: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 3, 4]],
    harmonicRhythm: 1,
    chordExt: 'triad',
    voicing: { voices: 4, low: 48, high: 79 },
    swing: 0,
    drums: 'cinematic',
    reverb: { amount: 0.32, size: 0.72 },
    masterTone: null,
    tail: 1.1,
    tracks: {
      bass: {
        instrument: 'contrabass',
        voice: { type: 'saw', cutoff: 380, resonance: 1.1, attack: 0.06, decay: 0.3, sustain: 0.8, release: 0.45, sub: 0.35, gain: 0.9 },
        low: 36, high: 47, pattern: 'whole'
      },
      harmony: {
        instrument: 'string-pad',
        voice: { type: 'pad', cutoff: 1200, resonance: 0.9, attack: 0.3, decay: 0.6, sustain: 0.8, release: 1.0, detune: 9, layers: 2, gain: 0.7 },
        rhythm: { span: 'chord', steps: [0], gate: 1 },
        voices: 4, low: 48, high: 79
      },
      melody: {
        instrument: 'horn-lead',
        voice: { type: 'saw', cutoff: 2400, resonance: 0.9, attack: 0.05, decay: 0.25, sustain: 0.75, release: 0.35, detune: 5, layers: 2, gain: 0.55 },
        low: 60, high: 81, subdivision: 1, density: 0.5, gate: 0.94, maxDur: 2.5, motifBars: 2
      },
      color: {
        instrument: 'fm-bell',
        voice: { type: 'fm', ratio: 2.5, index: 2.2, indexDecay: 0.5, attack: 0.004, decay: 1.6, sustain: 0, release: 0.8, gain: 0.35 },
        pattern: 'arp', order: 'updown', subdivision: 2, low: 74, high: 91, density: 0.22, gate: 0.85
      },
      rhythm: { instrument: 'timpani-kit', pattern: 'cinematic' }
    },
    gainDb: { bass: -16, harmony: -17.5, melody: -17, color: -26, rhythm: -19 }
  },

  lofi: {
    label: 'Lo-fi',
    bpm: 78,
    key: 'D',
    mode: 'dorian',
    progressions: [[1, 4, 0, 5], [0, 5, 1, 4], [3, 4, 0, 3]],
    harmonicRhythm: 1,
    chordExt: 'seventh',
    voicing: { voices: 4, low: 52, high: 76 },
    swing: 0.14,
    drums: 'lofi',
    reverb: { amount: 0.2, size: 0.5 },
    masterTone: { cutoff: 2600, mode: 'lp' },
    tail: 0.8,
    tracks: {
      bass: {
        instrument: 'upright',
        voice: { type: 'triangle', cutoff: 600, attack: 0.02, decay: 0.3, sustain: 0.7, release: 0.25, sub: 0.25, gain: 1 },
        low: 33, high: 45, pattern: 'lazy'
      },
      harmony: {
        instrument: 'electric-keys',
        voice: { type: 'fm', ratio: 1, index: 1.15, indexDecay: 0.35, attack: 0.01, decay: 0.5, sustain: 0.25, release: 0.45, gain: 0.55 },
        rhythm: { span: 'bar', steps: [0, 6, 10], gate: 0.55 },
        voices: 4, low: 52, high: 76, strum: 0.03
      },
      melody: {
        instrument: 'soft-lead',
        voice: { type: 'triangle', cutoff: 1600, attack: 0.03, decay: 0.3, sustain: 0.6, release: 0.3, gain: 0.5 },
        low: 62, high: 79, subdivision: 2, density: 0.38, gate: 0.85, maxDur: 1.5, motifBars: 2
      },
      color: {
        instrument: 'vinyl',
        voice: { type: 'noise-bed', kind: 'vinyl', attack: 0.4, release: 0.6, gain: 0.5 },
        pattern: 'bed'
      },
      rhythm: { instrument: 'boom-bap-kit', pattern: 'lofi' }
    },
    gainDb: { bass: -16, harmony: -18, melody: -18.5, color: -33, rhythm: -18 }
  },

  chiptune: {
    label: 'Chiptune',
    bpm: 152,
    key: 'C',
    mode: 'majorPentatonic',
    progressions: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 5]],
    harmonicRhythm: 1,
    chordExt: 'triad',
    voicing: { voices: 3, low: 60, high: 84 },
    swing: 0,
    drums: 'chiptune',
    reverb: { amount: 0.03, size: 0.2 },
    masterTone: null,
    tail: 0.35,
    tracks: {
      bass: {
        instrument: 'triangle-bass',
        voice: { type: 'triangle', cutoff: 5000, attack: 0.002, decay: 0.06, sustain: 0.5, release: 0.04, gain: 0.9 },
        low: 36, high: 48, pattern: 'eighths'
      },
      harmony: {
        instrument: 'pulse-stabs',
        voice: { type: 'square', cutoff: 6000, attack: 0.001, decay: 0.05, sustain: 0.15, release: 0.03, gain: 0.28 },
        rhythm: { span: 'bar', steps: [0, 6, 8, 14], gate: 0.5 },
        voices: 3, low: 60, high: 83
      },
      melody: {
        instrument: 'pulse-lead',
        voice: { type: 'square', cutoff: 8000, attack: 0.002, decay: 0.08, sustain: 0.55, release: 0.05, gain: 0.4 },
        low: 72, high: 91, subdivision: 2, density: 0.58, gate: 0.7, maxDur: 1, motifBars: 2
      },
      color: {
        instrument: 'pulse-arp',
        voice: { type: 'square', cutoff: 7000, attack: 0.001, decay: 0.06, sustain: 0.3, release: 0.04, gain: 0.2 },
        pattern: 'arp', order: 'up', subdivision: 4, low: 76, high: 96, density: 0.5, gate: 0.4
      },
      rhythm: { instrument: 'noise-kit', pattern: 'chiptune' }
    },
    gainDb: { bass: -18, harmony: -22, melody: -19, color: -25, rhythm: -19 }
  },

  ambient: {
    label: 'Ambient',
    bpm: 52,
    key: 'E',
    mode: 'lydian',
    progressions: [[0, 3, 5, 2], [0, 4, 1, 5]],
    harmonicRhythm: 2,
    chordExt: 'seventh',
    voicing: { voices: 4, low: 45, high: 74 },
    swing: 0,
    drums: 'ambient',
    reverb: { amount: 0.55, size: 0.92 },
    masterTone: { cutoff: 4200, mode: 'lp' },
    tail: 2,
    tracks: {
      bass: {
        instrument: 'sub-drone',
        voice: { type: 'sine', cutoff: 300, attack: 1.0, decay: 1.5, sustain: 0.9, release: 1.2, sub: 0.5, gain: 0.8 },
        low: 28, high: 40, pattern: 'drone'
      },
      harmony: {
        instrument: 'air-pad',
        voice: { type: 'pad', cutoff: 900, resonance: 0.8, attack: 0.9, decay: 1.0, sustain: 0.85, release: 1.6, detune: 12, layers: 2, gain: 0.65 },
        rhythm: { span: 'chord', steps: [0], gate: 1 },
        voices: 4, low: 45, high: 74
      },
      melody: {
        instrument: 'glass-bell',
        voice: { type: 'fm', ratio: 3.5, index: 1.6, indexDecay: 1.2, attack: 0.01, decay: 2.4, sustain: 0, release: 1.6, gain: 0.3 },
        low: 72, high: 91, subdivision: 1, density: 0.16, gate: 0.98, maxDur: 4, motifBars: 4
      },
      color: {
        instrument: 'wind-bed',
        voice: { type: 'noise-bed', kind: 'wind', attack: 1.2, release: 1.5, gain: 0.6 },
        pattern: 'bed'
      },
      rhythm: { instrument: 'heart-kit', pattern: 'ambient' }
    },
    gainDb: { bass: -16, harmony: -17, melody: -21, color: -26, rhythm: -27 }
  },

  action: {
    label: 'Action',
    bpm: 158,
    key: 'E',
    mode: 'phrygian',
    progressions: [[0, 1, 0, 6], [0, 1, 5, 3], [0, 3, 1, 4]],
    harmonicRhythm: 1,
    chordExt: 'triad',
    voicing: { voices: 3, low: 55, high: 76 },
    swing: 0,
    drums: 'action',
    reverb: { amount: 0.12, size: 0.35 },
    masterTone: null,
    tail: 0.5,
    tracks: {
      bass: {
        instrument: 'drive-bass',
        voice: { type: 'saw', cutoff: 700, resonance: 1.2, attack: 0.004, decay: 0.12, sustain: 0.55, release: 0.08, sub: 0.4, gain: 0.95 },
        low: 33, high: 45, pattern: 'ostinato'
      },
      harmony: {
        instrument: 'brass-stab',
        voice: { type: 'saw', cutoff: 2600, resonance: 0.9, attack: 0.008, decay: 0.18, sustain: 0.2, release: 0.12, detune: 7, layers: 2, gain: 0.5 },
        rhythm: { span: 'bar', steps: [2, 6, 10, 14], gate: 0.4 },
        voices: 3, low: 55, high: 76, strum: 0.015
      },
      melody: {
        instrument: 'lead-saw',
        voice: { type: 'saw', cutoff: 3800, resonance: 1.0, attack: 0.01, decay: 0.12, sustain: 0.6, release: 0.1, detune: 6, layers: 2, gain: 0.55 },
        low: 67, high: 86, subdivision: 2, density: 0.75, gate: 0.75, maxDur: 1, motifBars: 1
      },
      color: {
        instrument: 'power-chord',
        voice: { type: 'square', cutoff: 3200, attack: 0.004, decay: 0.1, sustain: 0.25, release: 0.06, gain: 0.26 },
        pattern: 'arp', order: 'pedal', subdivision: 2, low: 67, high: 84, density: 0.45, gate: 0.35
      },
      rhythm: { instrument: 'rock-kit', pattern: 'action' }
    },
    gainDb: { bass: -16, harmony: -20, melody: -18.5, color: -23, rhythm: -17 }
  },

  horror: {
    label: 'Horror',
    bpm: 64,
    key: 'C',
    mode: 'locrian',
    progressions: [[0, 1, 0, 4], [0, 6, 0, 1]],
    harmonicRhythm: 2,
    chordExt: 'seventh',
    voicing: { voices: 4, low: 40, high: 69 },
    swing: 0,
    drums: 'horror',
    reverb: { amount: 0.6, size: 0.95 },
    masterTone: null,
    tail: 2,
    tracks: {
      bass: {
        instrument: 'sub-drone',
        voice: { type: 'saw', cutoff: 260, resonance: 0.9, attack: 0.5, decay: 0.8, sustain: 0.85, release: 1.0, sub: 0.6, gain: 0.9 },
        low: 24, high: 38, pattern: 'drone', tritone: true
      },
      harmony: {
        instrument: 'dissonant-pad',
        voice: { type: 'pad', cutoff: 800, resonance: 0.85, attack: 0.7, decay: 1.0, sustain: 0.8, release: 1.4, detune: 14, layers: 2, gain: 0.6 },
        rhythm: { span: 'chord', steps: [0], gate: 1 },
        voices: 4, low: 40, high: 69
      },
      melody: {
        instrument: 'high-violin',
        voice: { type: 'saw', cutoff: 3000, attack: 0.15, decay: 0.5, sustain: 0.6, release: 0.8, detune: 18, layers: 2, gain: 0.3 },
        low: 76, high: 92, subdivision: 1, density: 0.2, gate: 0.95, maxDur: 3, motifBars: 4
      },
      color: {
        instrument: 'creak-bed',
        voice: { type: 'noise-bed', kind: 'scrape', attack: 0.8, release: 1.2, gain: 0.5 },
        pattern: 'bed'
      },
      rhythm: { instrument: 'heart-kit', pattern: 'horror' }
    },
    gainDb: { bass: -16, harmony: -18, melody: -26, color: -26, rhythm: -29 }
  },

  fantasy: {
    label: 'Fantasy',
    bpm: 98,
    key: 'G',
    mode: 'lydian',
    progressions: [[0, 4, 5, 3], [0, 2, 4, 0], [0, 5, 1, 4]],
    harmonicRhythm: 1,
    chordExt: 'triad',
    voicing: { voices: 4, low: 52, high: 74 },
    swing: 0.02,
    drums: 'fantasy',
    reverb: { amount: 0.38, size: 0.7 },
    masterTone: null,
    tail: 1,
    tracks: {
      bass: {
        instrument: 'cello',
        voice: { type: 'saw', cutoff: 900, resonance: 0.8, attack: 0.04, decay: 0.25, sustain: 0.8, release: 0.35, sub: 0.2, gain: 0.8 },
        low: 36, high: 48, pattern: 'half'
      },
      harmony: {
        instrument: 'warm-strings',
        voice: { type: 'pad', cutoff: 1800, resonance: 0.8, attack: 0.22, decay: 0.5, sustain: 0.85, release: 0.75, detune: 7, layers: 2, gain: 0.6 },
        rhythm: { span: 'chord', steps: [0], gate: 1 },
        voices: 4, low: 52, high: 74
      },
      melody: {
        instrument: 'flute',
        voice: { type: 'triangle', cutoff: 3600, attack: 0.06, decay: 0.2, sustain: 0.75, release: 0.25, gain: 0.5 },
        low: 69, high: 88, subdivision: 2, density: 0.5, gate: 0.9, maxDur: 1.5, motifBars: 2
      },
      color: {
        instrument: 'harp',
        voice: { type: 'pluck', damp: 0.997, bright: 0.7, attack: 0.002, decay: 0.6, sustain: 1, release: 0.9, gain: 0.55 },
        pattern: 'arp', order: 'updown', subdivision: 2, low: 72, high: 91, density: 0.5, gate: 0.9
      },
      rhythm: { instrument: 'hand-perc', pattern: 'fantasy' }
    },
    gainDb: { bass: -17, harmony: -18, melody: -17, color: -22, rhythm: -23 }
  },

  'ui-menu': {
    label: 'UI menu',
    bpm: 110,
    key: 'C',
    mode: 'ionian',
    progressions: [[0, 5, 3, 4], [0, 4, 5, 3]],
    harmonicRhythm: 1,
    chordExt: 'triad',
    voicing: { voices: 3, low: 60, high: 79 },
    swing: 0.03,
    drums: 'ui',
    reverb: { amount: 0.18, size: 0.4 },
    masterTone: { cutoff: 6000, mode: 'lp' },
    tail: 0.6,
    tracks: {
      bass: {
        instrument: 'soft-bass',
        voice: { type: 'triangle', cutoff: 800, attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.15, sub: 0.2, gain: 0.7 },
        low: 40, high: 52, pattern: 'sparse'
      },
      harmony: {
        instrument: 'marimba',
        voice: { type: 'pluck', damp: 0.995, bright: 0.55, attack: 0.001, decay: 0.2, sustain: 1, release: 0.25, gain: 0.5 },
        rhythm: { span: 'bar', steps: [0, 6, 10], gate: 0.5 },
        voices: 3, low: 60, high: 79, strum: 0.02
      },
      melody: {
        instrument: 'bell-lead',
        voice: { type: 'fm', ratio: 2, index: 1.0, indexDecay: 0.18, attack: 0.002, decay: 0.25, sustain: 0.1, release: 0.2, gain: 0.5 },
        low: 72, high: 88, subdivision: 2, density: 0.42, gate: 0.6, maxDur: 0.75, motifBars: 2
      },
      color: {
        instrument: 'click-perc',
        voice: { type: 'pluck', damp: 0.98, bright: 0.9, attack: 0.001, decay: 0.08, sustain: 1, release: 0.1, gain: 0.3 },
        pattern: 'arp', order: 'pedal', subdivision: 4, low: 84, high: 96, density: 0.14, gate: 0.4
      },
      rhythm: { instrument: 'ui-kit', pattern: 'ui' }
    },
    gainDb: { bass: -22, harmony: -22, melody: -20, color: -29, rhythm: -27 }
  }
}

/* ------------------------------------------------------- sections + form -- */

/** Intensity each section type aims for, as a fraction of the requested level. */
const SECTION_LEVEL = { intro: 0.42, build: 0.86, drop: 1, outro: 0.45 }

/**
 * Default form: intro → build → drop → outro for a long cue; a single drop for a
 * very short one. Loops skip intro/outro so the first and last bar are both at
 * full level and the loop point does not fall into a fade.
 * @returns {{ name: string, fromBar: number, toBar: number, intensity: number }[]}
 */
function autoSections (bars, loop, intensity) {
  const base = clamp(intensity, 0, 1)
  if (loop) {
    if (bars <= 2) return [{ name: 'drop', fromBar: 0, toBar: bars, intensity: round2(base) }]
    const buildEnd = clamp(Math.round(bars * 0.25), 1, bars - 1)
    return [
      { name: 'build', fromBar: 0, toBar: buildEnd, intensity: round2(base * SECTION_LEVEL.build) },
      { name: 'drop', fromBar: buildEnd, toBar: bars, intensity: round2(base) }
    ]
  }
  if (bars <= 2) return [{ name: 'drop', fromBar: 0, toBar: bars, intensity: round2(base) }]
  if (bars <= 4) {
    return [
      { name: 'intro', fromBar: 0, toBar: 1, intensity: round2(base * SECTION_LEVEL.intro) },
      { name: 'drop', fromBar: 1, toBar: bars - 1, intensity: round2(base) },
      { name: 'outro', fromBar: bars - 1, toBar: bars, intensity: round2(base * SECTION_LEVEL.outro) }
    ]
  }
  const intro = Math.max(1, Math.round(bars * 0.15))
  const outro = Math.max(1, Math.round(bars * 0.2))
  let build = bars >= 8 ? Math.max(1, Math.round(bars * 0.15)) : 1
  let drop = bars - intro - build - outro
  if (drop < 1) { build = 0; drop = bars - intro - outro }
  if (drop < 1) { return [{ name: 'drop', fromBar: 0, toBar: bars, intensity: round2(base) }] }
  const sections = [{ name: 'intro', fromBar: 0, toBar: intro, intensity: round2(base * SECTION_LEVEL.intro) }]
  if (build > 0) sections.push({ name: 'build', fromBar: intro, toBar: intro + build, intensity: round2(base * SECTION_LEVEL.build) })
  sections.push({ name: 'drop', fromBar: intro + build, toBar: intro + build + drop, intensity: round2(base) })
  sections.push({ name: 'outro', fromBar: intro + build + drop, toBar: bars, intensity: round2(base * SECTION_LEVEL.outro) })
  return sections
}

/**
 * Turn a caller-supplied section list into a contiguous, clipped form.
 * Gaps are filled with a drop at reduced level so the score always covers every
 * bar; overlaps are resolved in favour of the earlier section.
 */
function normaliseSections (override, bars, intensity) {
  if (!Array.isArray(override) || override.length === 0) return null
  const raw = []
  for (const entry of override) {
    if (entry === null || typeof entry !== 'object') continue
    const fromBar = clamp(Math.round(Number(entry.fromBar)), 0, bars)
    const toBar = clamp(Math.round(Number(entry.toBar)), 0, bars)
    if (!(toBar > fromBar)) continue
    const name = String(entry.name ?? 'drop').toLowerCase().replace(/[^a-z-]+/g, '') || 'drop'
    const level = Number.isFinite(Number(entry.intensity)) ? clamp(Number(entry.intensity), 0, 1) : clamp(intensity, 0, 1)
    raw.push({ name, fromBar, toBar, intensity: round2(level) })
  }
  if (raw.length === 0) return null
  raw.sort((a, b) => a.fromBar - b.fromBar)
  const sections = []
  let cursor = 0
  for (const entry of raw) {
    const from = Math.max(cursor, entry.fromBar)
    const to = Math.min(bars, entry.toBar)
    if (to <= from) continue
    if (from > cursor) {
      sections.push({ name: 'drop', fromBar: cursor, toBar: from, intensity: round2(clamp(intensity, 0, 1) * 0.7) })
    }
    sections.push({ name: entry.name, fromBar: from, toBar: to, intensity: entry.intensity })
    cursor = to
  }
  if (cursor < bars) sections.push({ name: 'drop', fromBar: cursor, toBar: bars, intensity: round2(clamp(intensity, 0, 1)) })
  return sections
}

/**
 * Per-bar intensity curve derived from the section list.
 * build ramps up, outro tapers, everything else holds its section level.
 * @returns {{ bars: Float64Array, sectionAtBar: object[] }}
 */
function intensityCurve (sections, bars) {
  const levels = new Float64Array(bars)
  const sectionAtBar = new Array(bars)
  for (const section of sections) {
    const length = section.toBar - section.fromBar
    for (let bar = section.fromBar; bar < section.toBar; bar += 1) {
      const progress = length <= 1 ? 1 : (bar - section.fromBar + 0.5) / length
      let level
      if (section.name === 'build') level = lerp(section.intensity * 0.5, section.intensity, progress)
      else if (section.name === 'outro') level = lerp(section.intensity, section.intensity * 0.3, progress)
      else if (section.name === 'intro') level = lerp(section.intensity * 0.75, section.intensity, progress)
      else level = section.intensity
      levels[bar] = clamp(level, 0.04, 1)
      sectionAtBar[bar] = section
    }
  }
  return { levels, sectionAtBar }
}

/** Beat grid in seconds: one entry per beat. */
function buildBeatMap (bars, beatsPerBar, bpm) {
  const secondsPerBeat = 60 / bpm
  const count = bars * beatsPerBar
  const map = new Array(count)
  for (let index = 0; index < count; index += 1) map[index] = round4(index * secondsPerBeat)
  return map
}

/** Bar grid in seconds, `bars + 1` entries so the last one is the end time. */
function buildBarMap (bars, beatsPerBar, bpm) {
  const barSeconds = beatsPerBar * (60 / bpm)
  const map = new Array(bars + 1)
  for (let bar = 0; bar <= bars; bar += 1) map[bar] = round4(bar * barSeconds)
  return map
}

/* ------------------------------------------------------------- harmony -- */

/** All permutations of a short array (≤ 4 elements). */
function permutations (items) {
  if (items.length <= 1) return [items.slice()]
  const out = []
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index]
    const rest = items.slice(0, index).concat(items.slice(index + 1))
    for (const tail of permutations(rest)) out.push([head, ...tail])
  }
  return out
}

/**
 * Choose the tones a voicing actually uses: if the chord has more tones than
 * voices, keep the root, the third and the top colour tone (shell voicing).
 */
function selectVoicingTones (pcs, count) {
  const root = pcs[0]
  const ranked = pcs.slice()
  if (ranked.length <= count) {
    while (ranked.length < count) ranked.push(root)
    return ranked
  }
  const third = pcs.find((pc) => [3, 4].includes(((pc - root + 12) % 12))) ?? pcs[1]
  const top = pcs[pcs.length - 1]
  const chosen = [root]
  if (count >= 2) chosen.push(third)
  if (count >= 3) chosen.push(top)
  for (const pc of pcs) {
    if (chosen.length >= count) break
    if (!chosen.includes(pc)) chosen.push(pc)
  }
  return chosen.slice(0, Math.max(1, count))
}

/**
 * Voice a chord so it moves as little as possible from the previous one.
 *
 * Enumerates ascending orderings of the selected chord tones and picks the one
 * with the smallest total semitone motion plus a register penalty. This is what
 * keeps the harmony from jumping around: real voice leading, not random octaves.
 */
function chooseVoicing (tonePcs, count, low, high, previous) {
  const tones = selectVoicingTones(tonePcs, count)
  let best = null
  let bestCost = Infinity
  const starts = [low, low + 12]
  for (const order of permutations(tones)) {
    for (const start of starts) {
      const voicing = []
      let floor = start - 7
      for (const pc of order) {
        const pitchClass = ((Math.round(pc) % 12) + 12) % 12
        let midi = floor + ((((pitchClass - floor) % 12) + 12) % 12)
        if (midi <= floor) midi += 12
        voicing.push(midi)
        floor = midi
      }
      let cost = 0
      for (let index = 0; index < voicing.length; index += 1) {
        if (previous !== null && index < previous.length) cost += Math.abs(voicing[index] - previous[index])
        if (voicing[index] < low - 2) cost += (low - 2 - voicing[index]) * 4
        if (voicing[index] > high + 7) cost += (voicing[index] - high - 7) * 4
      }
      if (previous === null) {
        const target = low + 5
        cost += Math.abs(voicing[0] - target) * 0.5
      }
      if (cost < bestCost) { bestCost = cost; best = voicing }
    }
  }
  return best ?? [low, low + 4, low + 7].slice(0, Math.max(1, count))
}

/**
 * Build the harmonic skeleton: one chord slot per chord change, each with a
 * voiced set of MIDI notes, plus the progression labels.
 *
 * Resolution: when the cue is not a loop the last chord is forced to the tonic,
 * so the piece actually lands. Loops keep the progression cycling and rely on
 * the turnaround implied by the progression itself.
 */
function buildHarmony (options) {
  const { genre, mode, keyPc, bars, barsPerChord, loop, intensity, barLevels, rand } = options
  const harmonyScale = MODES[mode].harmony
  const progression = pick(rand, genre.progressions).slice()
  const slotCount = Math.ceil(bars / barsPerChord)
  const slots = []

  let previousVoicing = null
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const bar = slotIndex * barsPerChord
    const level = barLevels[bar] ?? intensity
    let degree = progression[slotIndex % progression.length]
    if (!loop && slotIndex === slotCount - 1) degree = 0
    if (!loop && slotIndex === slotCount - 2 && slotCount >= 3) degree = 4 % 7
    const seventh = genre.chordExt === 'seventh' || (genre.chordExt === 'triad' && level > 0.9)
    const chord = diatonicChord(harmonyScale, degree, keyPc, seventh)
    const tension = clamp(chord.tension + (degree === 4 ? 0.2 : 0) + (degree === 0 ? -0.12 : 0.04), 0, 1)
    const durations = Math.min(barsPerChord, bars - bar)
    const voicing = chooseVoicing(chord.pcs, genre.voicing.voices, genre.voicing.low, genre.voicing.high, previousVoicing)
    previousVoicing = voicing
    slots.push({
      bar,
      beat: 0,
      durBeats: durations * 4,
      degree,
      quality: chord.quality,
      rootPc: chord.rootPc,
      pcs: chord.pcs,
      tension,
      voicing,
      name: chordName(chord.rootPc, chord.quality),
      roman: romanFor(degree, chord.quality)
    })
  }

  // Bars in a chord slot all point at the same slot.
  const slotByBar = new Array(bars)
  let slotIndex = 0
  for (let bar = 0; bar < bars; bar += 1) {
    while (slotIndex + 1 < slots.length && slots[slotIndex + 1].bar <= bar) slotIndex += 1
    slotByBar[bar] = slotIndex
  }

  return { slots, slotByBar, progression: slots.map((slot) => slot.roman) }
}

/* --------------------------------------------------------------- tracks -- */

/** Rhythmic shapes for the bass track, in beats and semitones from the root. */
function bassPattern (pattern, slotDurBeats) {
  switch (pattern) {
    case 'whole':
      return [{ at: 0, semi: 0, len: Math.max(0.5, slotDurBeats - 0.06), vel: 1 }]
    case 'drone':
      return [{ at: 0, semi: 0, len: Math.max(0.5, slotDurBeats - 0.06), vel: 0.9 }]
    case 'half':
      return [{ at: 0, semi: 0, len: 1.9, vel: 1 }, { at: 2, semi: 0, len: 1.8, vel: 0.8 }]
    case 'sparse':
      return [{ at: 0, semi: 0, len: 1.6, vel: 0.95 }, { at: 2.5, semi: 7, len: 0.5, vel: 0.45 }]
    case 'lazy':
      return [
        { at: 0, semi: 0, len: 3.1, vel: 1 },
        { at: 2.5, semi: 7, len: 0.7, vel: 0.62 },
        { at: 3.5, semi: 0, len: 0.35, vel: 0.36 }
      ]
    case 'eighths': {
      const semis = [0, 0, 7, 0, 0, 7, 0, 12]
      const vels = [1, 0.68, 0.8, 0.66, 0.95, 0.7, 0.8, 0.86]
      return semis.map((semi, index) => ({ at: index * 0.5, semi, len: 0.44, vel: vels[index] }))
    }
    case 'ostinato': {
      const semis = [0, 0, 7, 0, 0, 7, 0, 12]
      const vels = [1, 0.5, 0.78, 0.52, 0.92, 0.5, 0.78, 0.66]
      const events = []
      for (let index = 0; index < 16; index += 1) {
        events.push({ at: index * 0.25, semi: semis[index % semis.length], len: 0.2, vel: vels[index % vels.length] * (index % 4 === 0 ? 1 : 0.85) })
      }
      return events
    }
    default:
      return [{ at: 0, semi: 0, len: 1, vel: 0.9 }]
  }
}

/** Note generator: low root movement that follows the chord changes exactly. */
function makeBassNotes (context) {
  const { cfg, bars, beatsPerBar, chords, slotByBar, barLevels, rand, loop } = context
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const slot = chords[slotByBar[bar]]
    const isFirstBar = bar === slot.bar
    const holdPattern = cfg.pattern === 'whole' || cfg.pattern === 'drone'
    if (holdPattern && !isFirstBar) continue
    const events = bassPattern(cfg.pattern, slot.durBeats)
    let rootMidi = lowestMidiWithPc(slot.rootPc, cfg.low)
    while (rootMidi > cfg.high) rootMidi -= 12
    const tritoneBar = cfg.tritone === true && ((bar - slot.bar) % 2 === 1)
    for (const event of events) {
      if (event.at >= 4) continue
      const midi = clamp(rootMidi + event.semi + (tritoneBar ? 6 : 0), 21, 108)
      const level = barLevels[bar] ?? 0.6
      const velocity = clamp(event.vel * (0.5 + 0.5 * level) * (0.94 + rand() * 0.12), 0.1, 1)
      const durBeats = holdPattern ? event.len : Math.min(event.len, 4 - event.at)
      notes.push({
        bar,
        beat: round4(event.at),
        durBeats: round4(Math.max(0.08, durBeats)),
        midi,
        velocity: round2(velocity),
        artic: durBeats > 0.9 ? 'legato' : 'staccato'
      })
    }
  }
  if (!loop && notes.length > 0) {
    const last = notes[notes.length - 1]
    last.durBeats = round4(Math.min(4, Math.max(last.durBeats, 2)))
  }
  if (loop && cfg.pattern !== 'whole' && cfg.pattern !== 'drone') {
    // A loop has no exit bar: hold the root through the wrap so the seam is a
    // musical continuation rather than a drop in level.
    const lastBar = bars - 1
    const slot = chords[slotByBar[lastBar]]
    let rootMidi = lowestMidiWithPc(slot.rootPc, cfg.low)
    while (rootMidi > cfg.high) rootMidi -= 12
    notes.push({
      bar: lastBar,
      beat: round4(beatsPerBar - 1),
      durBeats: round4(beatsPerBar - 2),
      midi: rootMidi,
      velocity: 0.86,
      artic: 'legato'
    })
  }
  return notes
}

/** Note generator: the sustained/hit harmony, using the voiced chord tones. */
function makeHarmonyNotes (context) {
  const { cfg, bars, beatsPerBar, chords, slotByBar, barLevels, rand, loop } = context
  const rhythm = cfg.rhythm ?? { span: 'chord', steps: [0], gate: 1 }
  const stepBeats = beatsPerBar / 16
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const slot = chords[slotByBar[bar]]
    const isFirstBar = bar === slot.bar
    if (rhythm.span === 'chord' && !isFirstBar) continue
    const level = barLevels[bar] ?? 0.6
    const gate = clamp(rhythm.gate ?? 1, 0.1, 1)
    for (const step of rhythm.steps) {
      const beat = step * stepBeats
      const accent = step === 0 ? 1 : (step % 8 === 0 ? 0.82 : 0.68)
      const baseDur = rhythm.span === 'chord' ? slot.durBeats * gate : stepBeats * gate * 2
      for (let voice = 0; voice < slot.voicing.length; voice += 1) {
        const strum = (cfg.strum ?? 0) * voice
        const velocity = clamp((0.34 + 0.36 * level) * accent * (0.93 + rand() * 0.14), 0.08, 1)
        notes.push({
          bar,
          beat: round4(clamp(beat + strum, 0, beatsPerBar - 0.05)),
          durBeats: round4(Math.max(0.06, baseDur)),
          midi: slot.voicing[voice],
          velocity: round2(velocity),
          artic: gate >= 0.85 ? 'legato' : 'staccato'
        })
      }
    }
  }
  if (loop && rhythm.span !== 'chord' && bars > 0) {
    // Loop point: restate the chord on the last beat and again on the final
    // sixteenth so the chord is still sounding across the wrap. Musically that
    // is a turnaround; technically it is what stops the seam from opening a
    // level gap.
    const lastBar = bars - 1
    const slot = chords[slotByBar[lastBar]]
    const level = barLevels[lastBar] ?? 0.6
    const accents = [
      { beat: beatsPerBar - 1, dur: beatsPerBar - 3 },
      { beat: beatsPerBar - 0.25, dur: 0.25 }
    ]
    for (const accent of accents) {
      if (notes.some((note) => note.bar === lastBar && Math.abs(note.beat - accent.beat) < 0.06)) continue
      for (let voice = 0; voice < slot.voicing.length; voice += 1) {
        notes.push({
          bar: lastBar,
          beat: round4(accent.beat + (cfg.strum ?? 0) * voice),
          durBeats: round4(accent.dur),
          midi: slot.voicing[voice],
          velocity: round2(clamp((0.34 + 0.36 * level) * 0.92, 0.08, 1)),
          artic: 'legato'
        })
      }
    }
  }
  return notes
}

/**
 * Note generator: the melody.
 *
 * A rhythmic motif is generated once for `motifBars` bars and then repeated with
 * diatonic transpositions and small contour variations, which is what makes it
 * sound composed rather than random. Pitch selection is chord-aware: a strong
 * beat lands on a chord tone, the notes between them move by scale step, leaps
 * are answered by a step back, and the register is reflected at its edges so the
 * line cannot pin itself to the top of its range.
 */
function makeMelodyNotes (context) {
  const { cfg, bars, beatsPerBar, chords, slotByBar, barLevels, sectionAtBar, rand, keyPc, scale, loop } = context
  const intervals = scale.intervals
  const subdivision = Math.max(0.5, cfg.subdivision ?? 2)
  const beatsPerSlot = 1 / subdivision
  const slotsPerBar = Math.max(1, Math.round(beatsPerBar * subdivision))
  // Start one octave below the range so the whole register is available: a
  // scale index is the position above `baseMidi`, and starting at the range
  // minimum would throw away every note below the tonic and leave seven steps
  // to compose in (which pins the line to the top of the range).
  const baseMidi = lowestMidiWithPc(keyPc, cfg.low) - 12
  const maxPos = maxScalePos(baseMidi, intervals, cfg.high)
  let minPos = 0
  while (minPos < maxPos && scaleMidiAt(minPos, baseMidi, intervals) < cfg.low) minPos += 1
  const motifBars = clamp(Math.round(cfg.motifBars ?? 2), 1, Math.max(1, bars))
  const motifSlots = slotsPerBar * motifBars
  const gate = clamp(cfg.gate ?? 0.9, 0.2, 1)
  const maxDurBeats = Math.max(beatsPerSlot, cfg.maxDur ?? beatsPerSlot * 2.5)

  // Rhythmic cell: strong slots are likelier to speak, weak slots are filigree.
  const mask = new Array(motifSlots).fill(false)
  for (let slot = 0; slot < motifSlots; slot += 1) {
    const beatPosition = (slot % slotsPerBar) / subdivision
    const onBeat = Math.abs(beatPosition - Math.round(beatPosition)) < 1e-9
    const downBeat = Math.round(beatPosition) % 2 === 0
    let probability = clamp(cfg.density ?? 0.5, 0.05, 1)
    if (onBeat) probability *= downBeat ? 1.5 : 1.1
    else probability *= 0.5
    mask[slot] = chance(rand, clamp(probability, 0.03, 0.95))
  }
  for (let bar = 0; bar < motifBars; bar += 1) {
    const from = bar * slotsPerBar
    if (!mask.slice(from, from + slotsPerBar).some(Boolean)) mask[from] = true
  }
  // A purely random cell is sometimes almost empty (and then the "melody" is
  // three notes in two bars). Top it up on the strongest free slots until it
  // carries the density the genre asked for.
  const targetNotes = Math.max(motifBars, Math.round(motifSlots * clamp(cfg.density ?? 0.5, 0.05, 1) * 0.9))
  let maskedNotes = mask.reduce((count, hit) => count + (hit ? 1 : 0), 0)
  const slotStrength = []
  for (let slot = 0; slot < motifSlots; slot += 1) {
    const beatPosition = (slot % slotsPerBar) / subdivision
    const onBeat = Math.abs(beatPosition - Math.round(beatPosition)) < 1e-9
    const strong = onBeat ? (Math.round(beatPosition) % 2 === 0 ? 3 : 2) : 1
    slotStrength.push({ slot, score: strong - (slot % slotsPerBar) * 0.001 })
  }
  slotStrength.sort((a, b) => b.score - a.score)
  for (const entry of slotStrength) {
    if (maskedNotes >= targetNotes) break
    if (mask[entry.slot]) continue
    mask[entry.slot] = true
    maskedNotes += 1
  }

  // Contour cell. A melody is mostly steps with the occasional leap, and it
  // moves in *runs*: an arch or a valley over the phrase. Generating each
  // interval independently produces a trill (79 81 79 81...), which is why the
  // direction is held for a few notes and only then turned.
  const deltas = new Array(motifSlots).fill(0)
  const half = Math.max(1, Math.round(motifSlots / 2))
  const contour = chance(rand, 0.5) ? [1, -1] : [-1, 1]
  let momentum = chance(rand, 0.5) ? 1 : -1
  let lastDelta = 0
  for (let slot = 0; slot < motifSlots; slot += 1) {
    if (!mask[slot]) continue
    const segment = slot < half ? contour[0] : contour[1]
    if (chance(rand, 0.7)) momentum = segment
    let delta
    const roll = rand()
    if (roll < 0.72) delta = momentum * (chance(rand, 0.85) ? 1 : 2)
    else if (roll < 0.9) delta = momentum * (3 + Math.floor(rand() * 2))
    else delta = -momentum
    if (chance(rand, 0.1)) delta = 0
    // A leap is answered by a step back in the other direction, never by
    // another leap into a whole-tone trill.
    if (Math.abs(lastDelta) >= 2 && Math.sign(delta) === -Math.sign(lastDelta) && Math.abs(delta) >= 2) delta = -Math.sign(lastDelta)
    deltas[slot] = delta
    lastDelta = delta
    if (Math.abs(delta) >= 3) momentum = -momentum
  }

  const events = []
  const registerCentre = Math.round((minPos + maxPos) / 2)
  let position = minPos + Math.round((maxPos - minPos) * 0.46)
  let phrase = -1
  let invertPhrase = false
  const transposes = [0, 2, -1, 1, 0]
  for (let bar = 0; bar < bars; bar += 1) {
    const section = sectionAtBar[bar] ?? { name: 'drop' }
    const level = barLevels[bar] ?? 0.6
    if (bar % motifBars === 0) {
      phrase += 1
      if (phrase > 0) {
        // New phrase: transpose, but pull back toward the middle of the
        // register. Without the pull the cumulative transpositions pin the line
        // against the top of its range, where reflection turns it into a
        // two-note trill.
        const pull = Math.round((registerCentre - position) * 0.4)
        position = reflectRange(position + transposes[phrase % transposes.length] + pull, minPos, maxPos)
      }
      // Every other repetition turns the contour upside down: same rhythm, new
      // shape, which is what makes a repeated motif read as development.
      invertPhrase = phrase > 0 && chance(rand, 0.35)
    }
    let densityScale = 1
    if (section.name === 'intro') densityScale = 0.35
    else if (section.name === 'outro') densityScale = 0.55
    else if (section.name === 'build') densityScale = 0.85
    for (let slot = 0; slot < slotsPerBar; slot += 1) {
      const cellSlot = (bar % motifBars) * slotsPerBar + slot
      if (!mask[cellSlot]) continue
      if (chance(rand, 1 - clamp(densityScale, 0, 1))) continue
      const beatInBar = slot / subdivision
      const onBeat = Math.abs(beatInBar - Math.round(beatInBar)) < 1e-9
      // Strong beats (1 and 3 in 4/4) are where the chord must be stated; the
      // notes between them are passing tones and should be free to move. Snapping
      // every note to a chord tone turns the melody into a two-note trill.
      const strongBeat = onBeat && Math.round(beatInBar) % 2 === 0
      let delta = deltas[cellSlot]
      if (invertPhrase) delta = -delta
      if (phrase > 0 && chance(rand, 0.18)) delta += chance(rand, 0.5) ? 1 : -1
      const target = reflectRange(position + delta, minPos, maxPos)
      const chordPcs = chords[slotByBar[bar]].pcs
      const previousNote = events.length >= 1 ? events[events.length - 1].midi : null
      const twoBackNote = events.length >= 2 ? events[events.length - 2].midi : null
      const chosen = chooseMelodyPosition({
        target,
        minPos,
        maxPos,
        baseMidi,
        intervals,
        chordPcs,
        strongBeat: strongBeat || chance(rand, 0.06),
        previousMidi: previousNote,
        twoBackMidi: twoBackNote,
        chromatic: scale.intervals.length < 7
      })
      position = chosen.position
      const midi = chosen.midi
      // Soft boundaries: drift back toward the centre instead of pinning the
      // line against the edge of the register.
      const span = Math.max(1, maxPos - minPos)
      if (position > minPos + span * 0.84) position = Math.max(minPos, position - 1)
      else if (position < minPos + span * 0.16) position = Math.min(maxPos, position + 1)
      let velocity = 0.4 + 0.42 * level
      if (onBeat) velocity += 0.1
      if (beatInBar === 0) velocity += 0.06
      if (!onBeat) velocity -= 0.05
      velocity *= 0.9 + rand() * 0.18
      events.push({
        bar,
        beat: round4(beatInBar),
        midi,
        velocity: round2(clamp(velocity, 0.12, 1)),
        artic: gate >= 0.85 ? 'legato' : 'staccato'
      })
    }
  }

  // Durations from the gap to the next onset: legato notes breathe, staccato
  // notes leave space. This is what gives the line phrasing instead of a wall.
  const totalBeats = bars * beatsPerBar
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const at = event.bar * beatsPerBar + event.beat
    const next = index + 1 < events.length
      ? events[index + 1].bar * beatsPerBar + events[index + 1].beat
      : totalBeats
    const span = Math.max(beatsPerSlot * 0.8, next - at)
    event.durBeats = round4(Math.max(0.06, Math.min(maxDurBeats, span) * gate))
  }
  if (!loop && events.length > 0) events[events.length - 1].durBeats = round4(Math.max(events[events.length - 1].durBeats, 1.2))
  return events
}

/**
 * Pick the next melody position around a target.
 *
 * Candidates are the target plus small offsets. Scoring prefers: a chord tone
 * on a strong beat (that is what makes the line sit on the harmony), a nearby
 * position (so the contour is not thrown away), no immediate pitch repeat (a
 * stuck-sequencer tell) and no two-note trill. This one scorer replaces the
 * snap / repeat / trill clean-up passes and keeps them from fighting.
 * @returns {{ position: number, midi: number }}
 */
function chooseMelodyPosition (options) {
  const { target, minPos, maxPos, baseMidi, intervals, chordPcs, strongBeat, previousMidi, twoBackMidi, chromatic } = options
  let bestPosition = clamp(target, minPos, maxPos)
  let bestMidi = scaleMidiAt(bestPosition, baseMidi, intervals)
  let bestScore = Infinity
  for (const offset of [0, 1, -1, 2, -2, 3, -3]) {
    const candidate = target + offset
    if (candidate < minPos || candidate > maxPos) continue
    const candidateMidi = scaleMidiAt(candidate, baseMidi, intervals)
    const pitchClass = ((candidateMidi % 12) + 12) % 12
    const chordTone = chordPcs.includes(pitchClass)
    let score = Math.abs(offset) * 1.5
    if (strongBeat && !chordTone) score += 100
    if (!strongBeat && chordTone) score -= 3
    if (candidateMidi === previousMidi) score += 40
    if (twoBackMidi !== null && candidateMidi === twoBackMidi) score += 25
    if (chromatic && !chordTone) score += 2
    if (score < bestScore) {
      bestScore = score
      bestPosition = candidate
      bestMidi = candidateMidi
    }
  }
  return { position: bestPosition, midi: bestMidi }
}

/** Arpeggio order over the chord tones for the colour track. */
function arpIndex (order, step, size) {
  if (size <= 1) return 0
  if (order === 'down') return size - 1 - (step % size)
  if (order === 'updown') {
    const cycle = 2 * size - 2
    const phase = step % cycle
    return phase < size ? phase : cycle - phase
  }
  if (order === 'pedal') {
    if (step % 2 === 0) return 0
    return 1 + (Math.floor(step / 2) % Math.max(1, size - 1))
  }
  return step % size
}

/** Note generator: arpeggio/harp/arp colour line, or a sustaining noise bed. */
function makeColorNotes (context) {
  const { cfg, bars, beatsPerBar, chords, slotByBar, barLevels, sections, rand } = context
  if (cfg.pattern === 'bed') {
    const notes = []
    for (const section of sections) {
      const level = section.intensity
      notes.push({
        bar: section.fromBar,
        beat: 0,
        durBeats: round4(Math.max(0.5, (section.toBar - section.fromBar) * beatsPerBar - 0.05)),
        midi: 0,
        velocity: round2(clamp(0.25 + 0.5 * level, 0.1, 1)),
        artic: 'sustain'
      })
    }
    return notes
  }
  const subdivision = Math.max(0.5, cfg.subdivision ?? 2)
  const stepsPerBar = Math.max(1, Math.round(beatsPerBar * subdivision))
  const stepBeats = beatsPerBar / stepsPerBar
  const gate = clamp(cfg.gate ?? 0.8, 0.1, 1)
  const density = clamp(cfg.density ?? 0.4, 0.02, 1)
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const slot = chords[slotByBar[bar]]
    const level = barLevels[bar] ?? 0.6
    const order = cfg.order ?? 'up'
    for (let step = 0; step < stepsPerBar; step += 1) {
      const onBeat = step % Math.max(1, Math.round(subdivision)) === 0
      let probability = density * (0.55 + 0.9 * level)
      probability *= onBeat ? 1.35 : 0.7
      if (!chance(rand, clamp(probability, 0.02, 0.98))) continue
      const pcs = slot.pcs
      const pc = pcs[arpIndex(order, step, pcs.length) % pcs.length]
      let midi = lowestMidiWithPc(pc, cfg.low)
      while (midi > cfg.high) midi -= 12
      if (onBeat && step % 8 === 0 && midi + 12 <= cfg.high) midi += 12
      const velocity = clamp((0.3 + 0.4 * level) * (onBeat ? 1.15 : 0.85) * (0.9 + rand() * 0.2), 0.08, 1)
      notes.push({
        bar,
        beat: round4(step * stepBeats),
        durBeats: round4(Math.max(0.05, stepBeats * gate)),
        midi,
        velocity: round2(velocity),
        artic: gate >= 0.8 ? 'legato' : 'staccato'
      })
    }
  }
  return notes
}

/**
 * Note generator: drums.
 *
 * The groove comes from `DRUM_PATTERNS`; intensity gates layers in and out,
 * swing and humanisation come from the pattern, chord changes force a kick on
 * the bar, section starts get an accent, and every fourth bar ends with a fill.
 * This keeps the kick locked to the harmonic rhythm.
 */
function makeDrumNotes (context) {
  const { cfg, bars, beatsPerBar, chords, slotByBar, barLevels, sections, rand, genre, loop } = context
  const pattern = DRUM_PATTERNS[cfg.pattern] ?? DRUM_PATTERNS.cinematic
  const swing = clamp(Number(genre.swing) || pattern.swing || 0, 0, 0.35)
  const humanize = pattern.humanize ?? 0.008
  const notes = []

  const sectionStartBars = new Set(sections.map((section) => section.fromBar))

  for (let bar = 0; bar < bars; bar += 1) {
    const level = barLevels[bar] ?? 0.6
    const slot = chords[slotByBar[bar]]
    const isChordChange = bar === slot.bar
    const isSectionStart = sectionStartBars.has(bar)
    const isFillBar = (bar % 4 === 3 && bars >= 4) || bar === bars - 1
    const velocityScale = 0.62 + 0.38 * level

    for (const layer of pattern.layers) {
      if (level < layer.minIntensity) continue
      if (layer.firstBarOfSection && !isSectionStart) continue
      for (let step = 0; step < 16; step += 1) {
        const hit = layer.steps[step]
        if (hit !== 'x' && hit !== 'X') continue
        // Swung offbeats: only the second and fourth eighth of each beat shift.
        const swung = step % 4 === 2 ? swing : 0
        const jitter = (rand() - 0.5) * humanize * 2
        // Humanisation must never push a downbeat before the bar: the first
        // kick of the cue has to land on beat 0, not be dropped by the guard.
        const beat = clamp(step * 0.25 + swung + jitter, 0, beatsPerBar - 0.001)
        if (beat >= beatsPerBar) continue
        const accent = hit === 'X' ? 1.25 : 1
        const velocity = clamp(layer.vel * velocityScale * accent * (0.9 + rand() * 0.18), 0.05, 1)
        notes.push({
          bar,
          beat: round4(beat),
          durBeats: 0.1,
          midi: layer.midi,
          velocity: round2(velocity),
          artic: velocity > 0.7 ? 'accent' : (velocity < 0.25 ? 'ghost' : 'normal')
        })
      }
    }

    // Keep the kick married to the harmonic rhythm: a chord change lands on a
    // kick even if the groove would otherwise leave beat 0 empty.
    if (isChordChange && !notes.some((note) => note.bar === bar && note.midi === 36 && note.beat < 0.06)) {
      const kickLayer = pattern.layers.find((layer) => layer.midi === 36)
      if (kickLayer !== undefined) {
        notes.push({ bar, beat: 0, durBeats: 0.1, midi: 36, velocity: round2(clamp(kickLayer.vel * velocityScale, 0.05, 1) * 0.9), artic: 'accent' })
      }
    }

    // Loop turnaround: the final bar of a loop gets an accent on its last
    // eighth. Musically it hands over to the downbeat the wrap leads into;
    // technically it is what keeps the loop seam level-continuous.
    if (loop && bar === bars - 1) {
      const anchor = pattern.layers.find((layer) => layer.midi === 36) ?? pattern.layers[0]
      const snare = pattern.layers.some((layer) => layer.midi === 38) ? 38 : anchor.midi
      notes.push({ bar, beat: 3.5, durBeats: 0.1, midi: anchor.midi, velocity: round2(clamp(anchor.vel * 1.05, 0.1, 1)), artic: 'accent' })
      notes.push({ bar, beat: 3.5, durBeats: 0.1, midi: 46, velocity: round2(clamp(anchor.vel * 0.9, 0.1, 1)), artic: 'normal' })
      notes.push({ bar, beat: 3.75, durBeats: 0.1, midi: anchor.midi, velocity: round2(clamp(anchor.vel * 0.8, 0.1, 1)), artic: 'accent' })
      notes.push({ bar, beat: 3.75, durBeats: 0.1, midi: snare, velocity: round2(clamp(anchor.vel * 0.85, 0.1, 1)), artic: 'accent' })
    }

    // Fill: last beat of a phrase becomes a rising snare run so sections hand
    // over instead of stopping dead.
    if (isFillBar && level > 0.45 && pattern.layers.some((layer) => layer.midi === 36)) {
      for (let step = 12; step < 16; step += 1) {
        const velocity = 0.28 + (step - 12) * 0.16
        notes.push({
          bar,
          beat: round4(step * 0.25 + (step % 4 === 2 ? swing : 0)),
          durBeats: 0.1,
          midi: 38,
          velocity: round2(clamp(velocity * (0.7 + 0.3 * level), 0.05, 1)),
          artic: velocity > 0.6 ? 'accent' : 'normal'
        })
      }
    }
  }
  return notes
}

/* ---------------------------------------------------------------- score -- */

/** Sort notes by score time; stable because the generator order is stable. */
function sortNotes (notes, beatsPerBar) {
  return notes.sort((a, b) => (a.bar * beatsPerBar + a.beat) - (b.bar * beatsPerBar + b.beat) || a.midi - b.midi)
}

/** Coerce a request number, falling back when the value is missing/not numeric. */
function finiteOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Compose a score from a request.
 *
 * @param {object} [request] - `genre`, `bpm`, `bars`, `key`, `mode`, `seed`,
 *   `intensity`, `loop`, optional `sections` override.
 * @returns {object} score: bpm, bars, beatsPerBar, key, mode, genre, seed,
 *   sections, tracks, beatMap, barMap, chords (plus progression/loop/intensity
 *   metadata). Each track carries `gainDb`, its target RMS level in dBFS.
 *   Deterministic for a given request.
 */
export function composeScore (request = {}) {
  const genreName = typeof request.genre === 'string' ? request.genre : 'cinematic'
  if (GENRES[genreName] === undefined) {
    throw new Error(`unknown genre "${genreName}"; available: ${Object.keys(GENRES).join(', ')}`)
  }
  const genre = GENRES[genreName]
  const modeName = typeof request.mode === 'string' && MODES[request.mode] !== undefined ? request.mode : genre.mode
  if (MODES[modeName] === undefined) {
    throw new Error(`unknown mode "${modeName}"; available: ${Object.keys(MODES).join(', ')}`)
  }
  const keyName = typeof request.key === 'string' && KEYS[request.key] !== undefined ? request.key : genre.key
  const keyPc = KEYS[keyName]
  // A non-numeric `bars`/`bpm` used to become NaN and then `new Array(NaN)`
  // (a crash) or a score whose beatMap was all NaN; fall back like `intensity`.
  const bars = clamp(Math.round(finiteOr(request.bars ?? 16, 16)), 1, 96)
  const beatsPerBar = 4
  const bpm = clamp(Math.round(finiteOr(request.bpm ?? genre.bpm, genre.bpm)), 40, 220)
  const seed = normaliseSeed(request.seed ?? 1)
  const intensity = clamp(Number.isFinite(Number(request.intensity)) ? Number(request.intensity) : 0.6, 0, 1)
  const loop = request.loop === true
  const barsPerChord = Math.max(1, Math.round(genre.harmonicRhythm ?? 1))
  const rand = makeRng((seed ^ 0xC0FFEE11) >>> 0)

  const sections = normaliseSections(request.sections, bars, intensity) ?? autoSections(bars, loop, intensity)
  const curve = intensityCurve(sections, bars)
  const barLevels = curve.levels
  const sectionAtBar = curve.sectionAtBar
  const harmony = buildHarmony({ genre, mode: modeName, keyPc, bars, barsPerChord, loop, intensity, barLevels, rand })
  const chords = harmony.slots
  const scale = SCALES[MODES[modeName].scale]

  const context = {
    genre,
    mode: modeName,
    keyPc,
    scale,
    bpm,
    bars,
    beatsPerBar,
    barsPerChord,
    chords,
    slotByBar: harmony.slotByBar,
    sections,
    barLevels,
    sectionAtBar,
    loop,
    rand
  }

  const trackOrder = [
    ['bass', makeBassNotes],
    ['harmony', makeHarmonyNotes],
    ['melody', makeMelodyNotes],
    ['color', makeColorNotes],
    ['rhythm', makeDrumNotes]
  ]
  const tracks = []
  for (const [role, generator] of trackOrder) {
    const cfg = genre.tracks[role]
    if (cfg === undefined) continue
    // A per-track rng keeps one track's changes from rewriting another's notes.
    const trackRand = makeRng((seed ^ Math.imul(trackOrder.findIndex(([name]) => name === role) + 1, 0x9E3779B1)) >>> 0)
    const notes = sortNotes(generator({ ...context, rand: trackRand, cfg }), beatsPerBar)
      .filter((note) => note.bar >= 0 && note.bar < bars && note.beat >= 0 && note.beat < beatsPerBar)
    tracks.push({
      id: role,
      role,
      instrument: cfg.instrument,
      gainDb: clamp(Number(genre.gainDb?.[role] ?? -18), -60, 0),
      notes
    })
  }

  const chordList = chords.map((slot) => ({
    bar: slot.bar,
    beat: slot.beat,
    name: slot.name,
    midi: slot.voicing.slice(),
    root: NOTE_NAMES[slot.rootPc],
    pcs: slot.pcs.slice(),
    degree: slot.degree,
    quality: slot.quality,
    tension: round2(slot.tension)
  }))

  return {
    bpm,
    bars,
    beatsPerBar,
    key: keyName,
    mode: modeName,
    genre: genreName,
    seed,
    sections: sections.map((section) => ({ name: section.name, fromBar: section.fromBar, toBar: section.toBar, intensity: section.intensity })),
    tracks,
    beatMap: buildBeatMap(bars, beatsPerBar, bpm),
    barMap: buildBarMap(bars, beatsPerBar, bpm),
    chords: chordList,
    progression: harmony.progression,
    loop,
    intensity: round2(intensity)
  }
}

/* ------------------------------------------------------------- synthesis -- */

/**
 * PolyBLEP residual used to band-limit a discontinuous waveform edge.
 * Cheap (no tables, no per-note setup) and alias-free: a saw or pulse made from
 * this stays clean even in the top octaves where a naive oscillator buzzes.
 */
function polyBlep (phase, dt) {
  if (phase < dt) {
    const x = phase / dt
    return x + x - x * x - 1
  }
  if (phase > 1 - dt) {
    const x = (phase - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/** One oscillator sample for the requested waveform. */
function oscSample (type, phase, dt) {
  if (type === 'saw') return 2 * phase - 1 - polyBlep(phase, dt)
  if (type === 'square') return (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1, dt)
  if (type === 'triangle') return 1 - 4 * Math.abs(phase - 0.5)
  return Math.sin(TAU * phase)
}

/** MIDI note number → Hz. */
function midiToHz (midi) {
  return A4 * Math.pow(2, (midi - MIDI_A4) / 12)
}

/**
 * Attack/decay/sustain envelope with a smooth release after `durFrames`.
 * The release tapers with a squared curve so cutting a held note never clicks.
 * @returns {Float32Array} amplitude per sample, peaking at 1.
 */
function makeAmpEnvelope (total, durFrames, spec, releaseSeconds, sampleRate) {
  const env = new Float32Array(total)
  const attack = Math.max(1, Math.round((spec.attack ?? 0.005) * sampleRate))
  const decay = Math.max(1, Math.round((spec.decay ?? 0.2) * sampleRate))
  const sustain = clamp(spec.sustain ?? 0.7, 0, 1)
  const release = Math.max(1, Math.round(releaseSeconds * sampleRate))
  for (let index = 0; index < total; index += 1) {
    let amp
    if (index < attack) amp = index / attack
    else if (index < attack + decay) amp = 1 - (1 - sustain) * ((index - attack) / decay)
    else amp = sustain
    if (index >= durFrames) {
      const progress = (index - durFrames) / release
      const taper = 1 - progress
      amp *= taper > 0 ? taper * taper : 0
    }
    env[index] = amp
  }
  return env
}

/** Articulation shortens a staccato release and lengthens a sustained one. */
function releaseFor (spec, artic) {
  const base = clamp(spec.release ?? 0.2, 0.01, 4)
  if (artic === 'staccato') return Math.max(0.01, base * 0.55)
  if (artic === 'sustain') return Math.min(4, base * 1.5)
  return base
}

/**
 * Envelope lookup shared by the note renderers.
 *
 * A four-voice pad renders four notes with the same voice and the same length,
 * so the same envelope was being rebuilt from scratch four times per chord —
 * and the same is true of a bass track's repeated note lengths. The cache is
 * per-track (see `renderScore`), so it cannot grow across renders, and it is
 * bounded so a melody with many distinct note lengths cannot pin megabytes.
 *
 * @param {Map<string, Float32Array>|undefined} cache - per-track envelope cache.
 * @returns {Float32Array} amplitude envelope, identical to `makeAmpEnvelope`.
 */
function envelopeFor (cache, spec, total, durFrames, releaseSeconds, sampleRate) {
  if (cache === undefined) {
    return makeAmpEnvelope(total, durFrames, spec, releaseSeconds, sampleRate)
  }
  const key = `${total}|${durFrames}|${releaseSeconds}|${sampleRate}|${spec.attack ?? ''}|${spec.decay ?? ''}|${spec.sustain ?? ''}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const env = makeAmpEnvelope(total, durFrames, spec, releaseSeconds, sampleRate)
  if (cache.size >= 16) cache.delete(cache.keys().next().value)
  cache.set(key, env)
  return env
}

/**
 * Constant-cutoff state-variable filter coefficients.
 *
 * Every voice in the genre table has a fixed cutoff, so the block loop in
 * `renderSubtractive` was recomputing `tan()` coefficients 32 samples at a time
 * for values that never change. Computing them once is the same arithmetic with
 * the same inputs, which keeps the samples bit-identical.
 */
function staticFilter (q, cutoff, sampleRate) {
  const g = Math.tan(Math.PI * cutoff / sampleRate)
  const k = 1 / Math.max(q, 0.15)
  const a1 = 1 / (1 + g * (g + k))
  const a2 = g * a1
  return { k, a1, a2, a3: g * a2 }
}

/**
 * One band-limited saw sample.
 *
 * `phase` must already be the float32-rounded value the original phase array
 * held, and `dt` the float32 increment, so the polyBLEP correction lands on the
 * same samples as before.
 */
function polyBlepSaw (phase, dt) {
  let sample = 2 * phase - 1
  if (phase < dt) {
    const x = phase / dt
    sample -= x + x - x * x - 1
  } else if (phase > 1 - dt) {
    const x = (phase - 1) / dt
    sample -= x * x + x + x + 1
  }
  return sample
}

/** One subtractive oscillator layer plus its sub, before the shared filter. */
function renderOscLayer (type, out, env, total, dt, phase, subAmount, subIncrement, subPhase, filter, gainScale) {
  const a1 = filter.a1
  const a2 = filter.a2
  const a3 = filter.a3
  let ic1 = 0
  let ic2 = 0
  for (let index = 0; index < total; index += 1) {
    phase = Math.fround(phase + dt)
    if (phase >= 1) phase = Math.fround(phase - 1)
    let sample
    if (type === 'saw') {
      sample = polyBlepSaw(phase, dt)
    } else if (type === 'square') {
      sample = phase < 0.5 ? 1 : -1
      if (phase < dt) {
        const x = phase / dt
        sample += x + x - x * x - 1
      } else if (phase > 1 - dt) {
        const x = (phase - 1) / dt
        sample += x * x + x + x + 1
      }
      const shifted = (phase + 0.5) % 1
      if (shifted < dt) {
        const x = shifted / dt
        sample -= x + x - x * x - 1
      } else if (shifted > 1 - dt) {
        const x = (shifted - 1) / dt
        sample -= x * x + x + x + 1
      }
    } else if (type === 'triangle') {
      sample = 1 - 4 * Math.abs(phase - 0.5)
    } else {
      sample = Math.sin(TAU * phase)
    }
    if (subAmount > 0) {
      subPhase += subIncrement
      if (subPhase >= 1) subPhase -= 1
      sample += Math.sin(TAU * subPhase) * subAmount * 1.3
    }
    const v3 = sample - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    out[index] = v2 * env[index] * gainScale
  }
}

/** Two detuned saw layers summed before the filter, the pad/lead case. */
function renderSawLayers (out, env, total, dt, phaseA, phaseB, dtB, filter, gainScale) {
  const a1 = filter.a1
  const a2 = filter.a2
  const a3 = filter.a3
  let ic1 = 0
  let ic2 = 0
  for (let index = 0; index < total; index += 1) {
    phaseA = Math.fround(phaseA + dt)
    if (phaseA >= 1) phaseA = Math.fround(phaseA - 1)
    phaseB = Math.fround(phaseB + dtB)
    if (phaseB >= 1) phaseB = Math.fround(phaseB - 1)
    const sample = polyBlepSaw(phaseA, dt) + polyBlepSaw(phaseB, dtB)
    const v3 = sample - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    out[index] = v2 * env[index] * gainScale
  }
}

/**
 * Detuned subtractive voice: one or two polyBLEP oscillators through a
 * resonant state-variable low-pass with an optional filter envelope, plus an
 * optional sine sub for weight. This is the workhorse behind pads, basses and
 * leads; the genre tables choose the waveform, cutoff, detune and envelope.
 *
 * The waveform dispatch and the per-layer loop are hoisted out of the sample
 * loop for the cases the genre table actually uses (one oscillator of any
 * waveform, or two saws). The remaining cases keep the original per-sample
 * dispatch. Both paths compute the same numbers in the same order, so the
 * output is unchanged — only the work spent getting there is.
 */
function renderSubtractive (spec, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes) {
  const release = releaseFor(spec, artic)
  const durFrames = Math.max(8, Math.round(durSeconds * sampleRate))
  const total = durFrames + Math.round(release * sampleRate)
  const env = envelopeFor(envelopes, spec, total, durFrames, release, sampleRate)
  const out = new Float32Array(total)
  const type = spec.type === 'pad' ? 'saw' : (spec.type ?? 'saw')
  const layers = Math.max(1, Math.round(spec.layers ?? (spec.type === 'pad' ? 2 : 1)))
  const detune = clamp(spec.detune ?? 0, 0, 50)
  const subAmount = clamp(spec.sub ?? 0, 0, 1)
  const subIncrement = (freq * 0.5) / sampleRate
  const baseCutoff = clamp(spec.cutoff ?? 3000, 30, sampleRate * 0.45)
  const cutoffEnv = clamp(spec.cutoffEnv ?? 0, 0, 8)
  const cutoffDecay = Math.max(0.01, spec.cutoffDecay ?? 0.2) * sampleRate
  const q = clamp(spec.resonance ?? 0.9, 0.2, 8)
  const gainScale = (spec.gain ?? 1) * velocity * (0.62 / Math.sqrt(layers))

  if (cutoffEnv === 0 && layers === 1) {
    const filter = staticFilter(q, baseCutoff, sampleRate)
    // A single layer has no detune, so its increment is exactly freq / rate; the
    // original computes `freq * 1 / rate` and stores it in a float32 array.
    renderOscLayer(type, out, env, total, Math.fround(freq / sampleRate), 0, subAmount, subIncrement, 0, filter, gainScale)
    return out
  }
  if (cutoffEnv === 0 && layers === 2 && type === 'saw') {
    const filter = staticFilter(q, baseCutoff, sampleRate)
    const dtA = Math.fround((freq * Math.pow(2, -detune / 1200)) / sampleRate)
    const dtB = Math.fround((freq * Math.pow(2, detune / 1200)) / sampleRate)
    // The phase array is float32, so the 0.37 offset is the float32 value of it.
    renderSawLayers(out, env, total, dtA, 0, Math.fround(0.37), dtB, filter, gainScale)
    return out
  }

  // Rare path: a moving filter envelope, more than two layers, or a detuned
  // non-saw. Kept as the original block loop so unusual voices still render.
  const phases = new Float32Array(layers)
  const increments = new Float32Array(layers)
  for (let layer = 0; layer < layers; layer += 1) {
    const cents = layers === 1 ? 0 : -detune + (2 * detune * layer) / (layers - 1)
    increments[layer] = (freq * Math.pow(2, cents / 1200)) / sampleRate
    phases[layer] = (layer * 0.37) % 1
  }
  let subPhase = 0
  const k = 1 / q
  const blockSize = 32
  let ic1 = 0
  let ic2 = 0
  let a1 = 0
  let a2 = 0
  let a3 = 0
  for (let start = 0; start < total; start += blockSize) {
    const cutoff = cutoffEnv > 0
      ? baseCutoff * (1 + cutoffEnv * Math.exp(-start / cutoffDecay))
      : baseCutoff
    const fc = clamp(cutoff, 30, sampleRate * 0.45)
    const g = Math.tan(Math.PI * fc / sampleRate)
    a1 = 1 / (1 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
    const end = Math.min(total, start + blockSize)
    for (let index = start; index < end; index += 1) {
      let sample = 0
      for (let layer = 0; layer < layers; layer += 1) {
        phases[layer] += increments[layer]
        if (phases[layer] >= 1) phases[layer] -= 1
        sample += oscSample(type, phases[layer], increments[layer])
      }
      if (subAmount > 0) {
        subPhase += subIncrement
        if (subPhase >= 1) subPhase -= 1
        sample += Math.sin(TAU * subPhase) * subAmount * 1.3
      }
      const v3 = sample - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      out[index] = v2 * env[index] * gainScale
    }
  }
  return out
}

/**
 * Two-operator FM voice: one sine modulating another with a decaying index.
 * Fast attack + long decay makes it a bell; slower index decay and ratio 1 make
 * it an electric piano. Both live in the same six lines.
 */
function renderFm (spec, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes) {
  const release = releaseFor(spec, artic)
  const durFrames = Math.max(8, Math.round(durSeconds * sampleRate))
  const total = durFrames + Math.round(release * sampleRate)
  const env = envelopeFor(envelopes, spec, total, durFrames, release, sampleRate)
  const out = new Float32Array(total)
  const ratio = Math.max(0.25, spec.ratio ?? 2)
  const index0 = clamp(spec.index ?? 2, 0, 12)
  const indexDecay = Math.max(0.02, spec.indexDecay ?? 0.3)
  const gainScale = (spec.gain ?? 1) * velocity * 0.8
  const carrierIncrement = freq / sampleRate
  const modulatorIncrement = (freq * ratio) / sampleRate
  let carrierPhase = 0
  let modulatorPhase = 0
  const blockSize = 32
  for (let start = 0; start < total; start += blockSize) {
    // The modulation index only moves every block, so the expensive exp stays
    // out of the sample loop.
    const indexAmount = index0 * Math.exp(-(start / sampleRate) / indexDecay)
    const end = Math.min(total, start + blockSize)
    for (let sample = start; sample < end; sample += 1) {
      carrierPhase += carrierIncrement
      if (carrierPhase >= 1) carrierPhase -= 1
      modulatorPhase += modulatorIncrement
      if (modulatorPhase >= 1) modulatorPhase -= 1
      const modulation = Math.sin(TAU * modulatorPhase)
      out[sample] = Math.sin(TAU * carrierPhase + indexAmount * modulation) * env[sample] * gainScale
    }
  }
  return out
}

/**
 * Karplus-Strong plucked string: a filtered noise burst circulating in a tuned
 * delay line. Fractional delay with linear interpolation keeps high notes in
 * tune; `damp` controls how long the string rings, `bright` how noisy the pick
 * is.
 */
/** Envelope spec every Karplus-Strong note shares, hoisted so it can be cached. */
const PLUCK_ENVELOPE = { attack: 0.002, decay: 0.01, sustain: 1 }

function renderPluck (spec, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes) {
  const release = releaseFor(spec, artic)
  const durFrames = Math.max(8, Math.round(durSeconds * sampleRate))
  const total = durFrames + Math.round(release * sampleRate)
  const env = envelopeFor(envelopes, PLUCK_ENVELOPE, total, durFrames, release, sampleRate)
  const out = new Float32Array(total)
  const damp = clamp(spec.damp ?? 0.996, 0.9, 0.99995)
  const bright = clamp(spec.bright ?? 0.5, 0, 1)
  const delayLength = Math.max(2, sampleRate / Math.max(20, freq) - 0.5)
  const whole = Math.floor(delayLength)
  const fraction = delayLength - whole
  const line = new Float32Array(whole + 2)
  const size = line.length
  let excitationFilter = 0
  for (let index = 0; index < size; index += 1) {
    const white = rng() * 2 - 1
    excitationFilter += (white - excitationFilter) * (0.12 + bright * 0.85)
    line[index] = excitationFilter
  }
  const gainScale = (spec.gain ?? 1) * velocity * 1.1
  let cursor = 0
  let previous = 0
  for (let index = 0; index < total; index += 1) {
    const first = line[cursor]
    // `% size` is the natural spelling; the branch is the same value with no
    // integer division in the hottest loop of the pluck voice.
    const second = line[cursor + 1 < size ? cursor + 1 : 0]
    const value = first + (second - first) * fraction
    const feedback = (value + previous) * 0.5 * damp
    line[cursor] = feedback
    previous = value
    cursor += 1
    if (cursor >= size) cursor = 0
    out[index] = value * env[index] * gainScale
  }
  return out
}

/**
 * Sustained noise texture: wind, room, hiss, vinyl crackle or scraped metal.
 * Used for the colour track of ambient/lofi/horror, where the arrangement needs
 * atmosphere rather than notes.
 */
function renderNoiseBed (spec, durSeconds, velocity, sampleRate, rng, artic, envelopes) {
  const release = releaseFor(spec, artic)
  const durFrames = Math.max(16, Math.round(durSeconds * sampleRate))
  const total = durFrames + Math.round(release * sampleRate)
  const env = envelopeFor(envelopes, { attack: spec.attack ?? 0.4, decay: 0.6, sustain: 0.9 }, total, durFrames, release, sampleRate)
  const out = new Float32Array(total)
  const kind = spec.kind ?? 'wind'
  const gainScale = (spec.gain ?? 1) * velocity
  // Hoist everything that depends on `kind`. The original re-decided movement,
  // cutoff and the hiss branch with three string comparisons per sample.
  const movement = kind === 'wind' ? 0.55 : kind === 'scrape' ? 0.4 : 0.15
  const baseCutoff = kind === 'hiss' ? 5200 : kind === 'room' ? 1500 : 900
  const subtractLowpass = kind === 'hiss'
  // Pink noise inlined from `noise(..., 'pink')`: identical sums, but it no
  // longer allocates a second full-length buffer for the bed.
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let lowpass = 0
  // The wobble is a 0.07 Hz LFO; it moves the cutoff by a few parts per million
  // across one 32-sample block, so the one-pole coefficient is refreshed per
  // block instead of per sample. This is the one place where a faster renderer
  // is not bit-identical: the bed differs from the old one by ~1e-5 relative
  // amplitude (-95 dB), far below the 16-bit dither and below the audible
  // threshold by a wide margin. A `sin` and an `exp` per sample was most of the
  // cost of the wind, vinyl and scrape tracks.
  const wobbleBlock = 32
  let alpha = 0
  let nextWobbleAt = 0
  for (let index = 0; index < total; index += 1) {
    if (index >= nextWobbleAt) {
      const wobble = 0.75 + movement * 0.25 * Math.sin(TAU * 0.07 * (index / sampleRate) + 1.3)
      const cutoff = baseCutoff * wobble
      alpha = clamp(1 - Math.exp(-TAU * cutoff / sampleRate), 0.0001, 0.9)
      nextWobbleAt = index + wobbleBlock
    }
    const white = rng() * 2 - 1
    b0 = 0.99765 * b0 + white * 0.099046
    b1 = 0.963 * b1 + white * 0.2965164
    b2 = 0.57 * b2 + white * 1.0526913
    const base = Math.fround((b0 + b1 + b2 + white * 0.1848) * 0.25)
    lowpass += (base - lowpass) * alpha
    const sample = subtractLowpass ? base - lowpass * 0.7 : lowpass
    out[index] = sample * env[index] * gainScale
  }
  if (kind === 'vinyl') {
    const crackles = Math.round((total / sampleRate) * 7)
    for (let crackle = 0; crackle < crackles; crackle += 1) {
      const at = Math.floor(rng() * Math.max(1, total - 32))
      const level = (0.05 + rng() * 0.12) * gainScale
      for (let index = 0; index < 24 && at + index < total; index += 1) {
        out[at + index] += (rng() * 2 - 1) * level * Math.exp(-index / 5)
      }
    }
  }
  if (kind === 'scrape') {
    const grains = Math.round((total / sampleRate) * 5)
    const attackFrames = Math.max(1, 0.001 * sampleRate)
    const burst = new Float32Array(Math.max(64, Math.round(0.062 * sampleRate) + 1))
    for (let grain = 0; grain < grains; grain += 1) {
      const at = Math.floor(rng() * Math.max(1, total - 4096))
      const length = Math.max(64, Math.round((0.012 + rng() * 0.05) * sampleRate))
      // The rng order is part of the score: noise draws first, then the decay
      // draw, then the centre, then one q draw per filtered sample.
      for (let index = 0; index < length; index += 1) burst[index] = (rng() * 2 - 1) * 0.5
      const tau = Math.max(1 / sampleRate, 0.006 + rng() * 0.02) * sampleRate
      for (let index = 0; index < length; index += 1) {
        const attackGain = index < attackFrames ? index / attackFrames : 1
        burst[index] = Math.fround(burst[index] * Math.fround(attackGain * Math.exp(-index / tau)))
      }
      const centre = 900 + rng() * 2600
      // Static cutoff, per-sample resonance: the filter's `tan` was being
      // recomputed for a cutoff that never moves inside one grain.
      const g = Math.tan(Math.PI * clamp(centre, 20, sampleRate * 0.45) / sampleRate)
      const addGain = gainScale * 0.7
      let ic1 = 0
      let ic2 = 0
      for (let index = 0; index < length; index += 1) {
        const input = burst[index]
        const k = 1 / Math.max(4 + rng() * 4, 0.15)
        const a1 = 1 / (1 + g * (g + k))
        const a2 = g * a1
        const a3 = g * a2
        const v3 = input - ic2
        const v1 = a1 * ic1 + a2 * v3
        const v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        if (at + index < total) out[at + index] = Math.fround(out[at + index] + Math.fround(v1) * addGain)
      }
    }
  }
  return out
}

/** Drum note → voice family (General MIDI-ish, matching `DRUM_PATTERNS`). */
const DRUM_VOICES = {
  36: 'kick',
  37: 'rim',
  38: 'snare',
  39: 'clap',
  41: 'tomLow',
  43: 'tomMid',
  42: 'hat',
  46: 'openHat',
  49: 'crash',
  70: 'shaker'
}

/* ------------------------------------------------------------ drum cache -- */

/**
 * Static (per-family, per-sample-rate) parts of a drum hit.
 *
 * Every kick in a cue is the same kick: same body sweep, same click envelope,
 * same filter. Rebuilding that body from `glideTone` for every hit spent most
 * of the drum track's time recomputing identical samples — a sine sweep with a
 * `Math.pow` pitch curve and an exponential envelope per sample, per hit. The
 * body, the noise envelopes and the filter coefficients are cached here; the
 * hits still differ because every noise layer keeps drawing from the per-note
 * rng, exactly as before.
 *
 * The cache is bounded so a session rendering at many sample rates cannot
 * accumulate voices forever.
 */
const DRUM_CACHE_LIMIT = 32
const DRUM_CACHE = new Map()

/**
 * Build the static parts of one drum family.
 * @returns {{ frames: number, body: Float32Array|null, bodyGain: number, layers: object[] }}
 */
function buildDrumVoice (family, sampleRate) {
  const tone = (frames, startHz, endHz, glide, rate, shape) =>
    glideTone(frames, sampleRate, startHz, endHz, glide, (progress) => Math.exp(-progress * rate), shape)
  const noiseLayer = (frames, env, cutoff, q, mode, gain, color = 0) => ({
    frames,
    env,
    coeffs: staticFilter(q, cutoff, sampleRate),
    mode,
    gain,
    color
  })

  if (family === 'kick') {
    const frames = Math.max(16, Math.round(0.45 * sampleRate))
    const clickFrames = Math.min(frames, Math.round(0.012 * sampleRate))
    return {
      frames,
      body: tone(frames, 175, 46, 0.3, 6.5, 0),
      bodyGain: 0.95,
      layers: [{ offset: 0, ...noiseLayer(clickFrames, decayEnvelope(clickFrames, sampleRate, 0.0035), 3000, 0.9, 2, 0.4) }]
    }
  }

  if (family === 'snare') {
    const frames = Math.max(16, Math.round(0.26 * sampleRate))
    const noiseFrames = Math.min(frames, Math.round(0.2 * sampleRate))
    return {
      frames,
      body: tone(frames, 245, 185, 0.6, 14, 1),
      bodyGain: 0.3,
      layers: [{ offset: 0, ...noiseLayer(noiseFrames, decayEnvelope(noiseFrames, sampleRate, 0.13), 1800, 1.3, 1, 0.85) }]
    }
  }

  if (family === 'clap') {
    const frames = Math.max(16, Math.round(0.24 * sampleRate))
    const length = Math.max(64, Math.round(0.09 * sampleRate))
    const env = decayEnvelope(length, sampleRate, 0.03)
    const layers = [0, 0.019, 0.041].map((at) => ({
      offset: Math.round(at * sampleRate),
      ...noiseLayer(length, env, 1500, 1.1, 1, 0.55)
    }))
    return { frames, body: null, bodyGain: 0, layers }
  }

  if (family === 'hat' || family === 'openHat') {
    const decay = family === 'hat' ? 0.03 : 0.26
    const frames = Math.max(16, Math.round((decay * 3 + 0.02) * sampleRate))
    return {
      frames,
      body: null,
      bodyGain: 0,
      layers: [{
        offset: 0,
        ...noiseLayer(frames, decayEnvelope(frames, sampleRate, decay, 0.0005), 7200, 0.85, 2, 1)
      }]
    }
  }

  if (family === 'rim') {
    const frames = Math.max(16, Math.round(0.09 * sampleRate))
    return {
      frames,
      body: tone(frames, 940, 780, 0.7, 26, 1),
      bodyGain: 0.35,
      layers: [{ offset: 0, ...noiseLayer(frames, decayEnvelope(frames, sampleRate, 0.018), 2600, 1.1, 2, 0.6) }]
    }
  }

  if (family === 'tomLow' || family === 'tomMid') {
    const frames = Math.max(16, Math.round(0.4 * sampleRate))
    const start = family === 'tomLow' ? 145 : 205
    const end = family === 'tomLow' ? 78 : 118
    return {
      frames,
      body: tone(frames, start, end, 0.35, 7.5, 0),
      bodyGain: 0.9,
      layers: [{ offset: 0, ...noiseLayer(frames, decayEnvelope(frames, sampleRate, 0.08), 520, 0.8, 0, 0.5, 1) }]
    }
  }

  if (family === 'crash') {
    const frames = Math.max(16, Math.round(1.1 * sampleRate))
    return {
      frames,
      body: null,
      bodyGain: 0,
      env: decayEnvelope(frames, sampleRate, 0.45, 0.002, 1),
      bright: staticFilter(0.8, 5200, sampleRate),
      shimmer: staticFilter(2.2, 2600, sampleRate),
      layers: []
    }
  }

  // Shaker: a short, soft, high noise brush.
  const frames = Math.max(16, Math.round(0.1 * sampleRate))
  return {
    frames,
    body: null,
    bodyGain: 0,
    layers: [{
      offset: 0,
      ...noiseLayer(frames, decayEnvelope(frames, sampleRate, 0.05, 0.008), 5400, 1.1, 2, 1)
    }]
  }
}

/** Look up (and build once) the static parts of a drum family. */
function drumVoice (family, sampleRate) {
  const key = `${family}|${sampleRate}`
  const cached = DRUM_CACHE.get(key)
  if (cached !== undefined) return cached
  const voice = buildDrumVoice(family, sampleRate)
  if (DRUM_CACHE.size >= DRUM_CACHE_LIMIT) DRUM_CACHE.delete(DRUM_CACHE.keys().next().value)
  DRUM_CACHE.set(key, voice)
  return voice
}

/**
 * Run a static-cutoff state-variable filter over `input`.
 * `mode`: 0 = low-pass, 1 = band-pass, 2 = high-pass.
 */
function filterStatic (input, coeffs, mode) {
  const out = new Float32Array(input.length)
  const a1 = coeffs.a1
  const a2 = coeffs.a2
  const a3 = coeffs.a3
  const k = coeffs.k
  let ic1 = 0
  let ic2 = 0
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]
    const v3 = value - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    out[index] = mode === 0 ? v2 : mode === 1 ? v1 : value - k * v1 - v2
  }
  return out
}

/**
 * Generate one cached noise layer into `out`.
 *
 * The noise is drawn from the note's own rng (so consecutive hits differ), then
 * enveloped and filtered exactly as `noise()` + `decayEnvelope()` + `filter()`
 * did, but with the filter coefficients already computed and the buffer
 * assignments collapsed into one pass.
 */
function addNoiseLayer (out, rng, layer) {
  const frames = layer.frames
  const env = layer.env
  const a1 = layer.coeffs.a1
  const a2 = layer.coeffs.a2
  const a3 = layer.coeffs.a3
  const k = layer.coeffs.k
  const mode = layer.mode
  const gain = layer.gain
  const brown = layer.color === 1
  const start = layer.offset
  let ic1 = 0
  let ic2 = 0
  let walk = 0
  for (let index = 0; index < frames; index += 1) {
    const white = rng() * 2 - 1
    let excitation
    if (brown) {
      walk = clamp(walk + white * 0.02, -1, 1)
      excitation = Math.fround(walk * 0.5)
    } else {
      excitation = Math.fround(white * 0.5)
    }
    const value = Math.fround(excitation * env[index])
    const v3 = value - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    const filtered = Math.fround(mode === 0 ? v2 : mode === 1 ? v1 : value - k * v1 - v2)
    if (start + index < out.length) out[start + index] = Math.fround(out[start + index] + filtered * gain)
  }
}

/** Crash: one noise bed through a high-pass and a band-pass, then mixed. */
function renderCrash (voice, velocity, rng) {
  const frames = voice.frames
  const env = voice.env
  const noiseBed = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    noiseBed[index] = Math.fround(Math.fround((rng() * 2 - 1) * 0.5) * env[index])
  }
  const bright = filterStatic(noiseBed, voice.bright, 2)
  const shimmer = filterStatic(noiseBed, voice.shimmer, 1)
  for (let index = 0; index < frames; index += 1) {
    bright[index] = bright[index] * 0.7 + shimmer[index] * 0.5
  }
  for (let index = 0; index < frames; index += 1) bright[index] *= velocity
  return bright
}

/**
 * Synthesized drum hit. Every voice is a pitched body plus an enveloped noise
 * layer through a filter — the same construction the `impact`/`thud` presets
 * use, tuned per drum family so a kick, a snare and a shaker are three
 * different timbres rather than one hit at three pitches.
 */
function renderDrumNote (midi, velocity, sampleRate, rng) {
  const family = DRUM_VOICES[midi] ?? 'hat'
  const voice = drumVoice(family, sampleRate)
  if (family === 'crash') return renderCrash(voice, velocity, rng)
  const out = new Float32Array(voice.frames)
  if (voice.body !== null) {
    const body = voice.body
    const gain = voice.bodyGain
    for (let index = 0; index < body.length; index += 1) out[index] = body[index] * gain
  }
  for (const layer of voice.layers) addNoiseLayer(out, rng, layer)
  for (let index = 0; index < out.length; index += 1) out[index] *= velocity
  return out
}

/** Fallback voices so a hand-written score without a genre still renders. */
const DEFAULT_VOICES = {
  bass: { type: 'saw', cutoff: 600, attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.2, sub: 0.3, gain: 0.85 },
  harmony: { type: 'pad', cutoff: 1400, attack: 0.15, decay: 0.4, sustain: 0.8, release: 0.6, detune: 6, layers: 2, gain: 0.6 },
  melody: { type: 'saw', cutoff: 3000, attack: 0.02, decay: 0.2, sustain: 0.65, release: 0.2, gain: 0.5 },
  color: { type: 'pluck', damp: 0.996, bright: 0.6, attack: 0.002, decay: 0.4, sustain: 1, release: 0.4, gain: 0.4 },
  rhythm: { type: 'pluck', damp: 0.99, bright: 0.8, attack: 0.001, decay: 0.1, sustain: 1, release: 0.1, gain: 0.3 }
}

/** Dispatch a score note to the voice family its instrument asks for. */
function renderNote (voice, midi, durSeconds, velocity, sampleRate, rng, artic, envelopes) {
  const kind = voice.type ?? 'saw'
  if (kind === 'noise-bed') return renderNoiseBed(voice, durSeconds, velocity, sampleRate, rng, artic, envelopes)
  const freq = midiToHz(clamp(midi, 0, 127))
  if (kind === 'fm') return renderFm(voice, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes)
  if (kind === 'pluck') return renderPluck(voice, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes)
  return renderSubtractive(voice, freq, durSeconds, velocity, sampleRate, rng, artic, envelopes)
}

/**
 * Schroeder reverb send, applied in place.
 *
 * This is the same algorithm as `reverb()` from `dsp.js` specialised for the
 * one way a score uses it: over a full-length master buffer, straight away.
 * The arithmetic and its order are unchanged, so the samples are identical;
 * what changes is that the four combs and two allpasses are unrolled into local
 * variables (no object property reads or `%` per sample) and the wet signal is
 * folded back into the buffer instead of being materialised in two extra
 * full-length arrays. Reverb was the largest single master-stage cost.
 */
function applyReverb (buffer, sampleRate, amount, size) {
  const scale = sampleRate / 44100
  const feedback = 0.74 + size * 0.18
  const factor = 0.7 + size * 0.9
  const c0 = new Float32Array(Math.max(2, Math.round(0.0297 * factor * 44100 * scale)))
  const c1 = new Float32Array(Math.max(2, Math.round(0.0371 * factor * 44100 * scale)))
  const c2 = new Float32Array(Math.max(2, Math.round(0.0411 * factor * 44100 * scale)))
  const c3 = new Float32Array(Math.max(2, Math.round(0.0437 * factor * 44100 * scale)))
  const a0 = new Float32Array(Math.max(2, Math.round(0.005 * 44100 * scale)))
  const a1 = new Float32Array(Math.max(2, Math.round(0.0017 * 44100 * scale)))
  const n0 = c0.length
  const n1 = c1.length
  const n2 = c2.length
  const n3 = c3.length
  const m0 = a0.length
  const m1 = a1.length
  let i0 = 0
  let i1 = 0
  let i2 = 0
  let i3 = 0
  let j0 = 0
  let j1 = 0
  let d0 = 0
  let d1 = 0
  let d2 = 0
  let d3 = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const sample = buffer[index]
    let sum = c0[i0]
    d0 = sum * 0.75 + d0 * 0.25
    c0[i0] = sample * 0.25 + d0 * feedback
    i0 += 1
    if (i0 >= n0) i0 = 0
    let delayed = c1[i1]
    d1 = delayed * 0.75 + d1 * 0.25
    c1[i1] = sample * 0.25 + d1 * feedback
    i1 += 1
    if (i1 >= n1) i1 = 0
    sum += delayed
    delayed = c2[i2]
    d2 = delayed * 0.75 + d2 * 0.25
    c2[i2] = sample * 0.25 + d2 * feedback
    i2 += 1
    if (i2 >= n2) i2 = 0
    sum += delayed
    delayed = c3[i3]
    d3 = delayed * 0.75 + d3 * 0.25
    c3[i3] = sample * 0.25 + d3 * feedback
    i3 += 1
    if (i3 >= n3) i3 = 0
    sum += delayed
    delayed = a0[j0]
    const firstOutput = -sum + delayed
    a0[j0] = sum + delayed * 0.5
    j0 += 1
    if (j0 >= m0) j0 = 0
    delayed = a1[j1]
    const output = -firstOutput + delayed
    a1[j1] = firstOutput + delayed * 0.5
    j1 += 1
    if (j1 >= m1) j1 = 0
    buffer[index] = sample + Math.fround(output * 0.22) * amount
  }
}

/** Static 2-pole low/high-pass over a finished buffer (master tone shaping). */
function applyTone (buffer, sampleRate, spec) {
  if (spec === null || spec === undefined) return buffer
  const mode = spec.mode === 'hp' ? 'hp' : 'lp'
  const cutoff = clamp(Number(spec.cutoff) || 4000, 60, sampleRate * 0.45)
  const k = 1 / 0.8
  const g = Math.tan(Math.PI * cutoff / sampleRate)
  const a1 = 1 / (1 + g * (g + k))
  const a2 = g * a1
  const a3 = g * a2
  let ic1 = 0
  let ic2 = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const input = buffer[index]
    const v3 = input - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    buffer[index] = mode === 'hp' ? input - k * v1 - v2 : v2
  }
  return buffer
}

/** dB from a linear level, floored so silence reports -120 rather than -Infinity. */
function levelDb (value) {
  return value > 0 ? round2(20 * Math.log10(value)) : -120
}

/* ---------------------------------------------------------------- render -- */

/**
 * Render a score to mono samples.
 *
 * Each track is rendered on its own, levelled to the RMS level its `gainDb`
 * states, then summed; the master gets the genre's tone filter and reverb, a DC
 * blocker, peak normalisation and a soft-limit ceiling. Loop scores are folded at
 * the loop point instead of faded out.
 *
 * @param {object} score - produced by `composeScore` (or hand written).
 * @param {object} [options] - `sampleRate`, `peakDbfs`, `tailSeconds`.
 * @returns {{ samples: Float32Array, sampleRate: number, beatMap: number[],
 *   trackStats: object[], sectionStats: object[], durationSeconds: number,
 *   loop: boolean }}
 */
export function renderScore (score, options = {}) {
  if (score === null || typeof score !== 'object') throw new Error('renderScore needs a score object')
  const sampleRate = clamp(Math.round(Number(options.sampleRate ?? 44100)), 8000, 96000)
  const genre = GENRES[score.genre] ?? GENRES.cinematic
  const bpm = clamp(Number(score.bpm) || 100, 20, 300)
  const bars = Math.max(1, Math.round(Number(score.bars) || 1))
  const beatsPerBar = Math.max(1, Math.round(Number(score.beatsPerBar) || 4))
  const secondsPerBeat = 60 / bpm
  const totalBeats = bars * beatsPerBar
  const loop = score.loop === true
  const mainFrames = Math.max(16, Math.round(totalBeats * secondsPerBeat * sampleRate))
  const loopTailSeconds = clamp(2 * secondsPerBeat, 1.2, 4)
  const tailSeconds = loop
    ? loopTailSeconds
    : Math.max(0, Number(options.tailSeconds ?? genre.tail ?? 0.8))
  const tailFrames = Math.max(0, Math.round(tailSeconds * sampleRate))
  const renderFrames = mainFrames + tailFrames
  const seed = normaliseSeed(score.seed ?? 1)
  const tracks = Array.isArray(score.tracks) ? score.tracks : []

  const master = new Float32Array(renderFrames)
  const scratch = new Float32Array(renderFrames)
  const trackStats = []

  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const track = tracks[trackIndex]
    const roleCfg = genre.tracks?.[track.role]
    const voice = roleCfg?.voice ?? DEFAULT_VOICES[track.role] ?? DEFAULT_VOICES.melody
    const isDrumKit = track.role === 'rhythm'
    // `gainDb` is the level this track should sit at (target RMS in dBFS), not a
    // raw fader: a pad with 16 long notes and an arp with 120 short ones would
    // otherwise land 15 dB apart and bury whatever is dense. renderScore levels
    // each track to its stated level, which is what keeps the mix musical.
    const targetDb = clamp(Number.isFinite(Number(track.gainDb)) ? Number(track.gainDb) : -18, -60, 0)
    const targetRms = dbToGain(targetDb)
    const notes = Array.isArray(track.notes) ? track.notes : []
    // Reused across the notes of this track: a pad renders four identical-length
    // notes per chord and a bass repeats note lengths, so the envelopes repeat.
    const envelopes = new Map()
    scratch.fill(0)
    let rendered = 0
    for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
      const note = notes[noteIndex]
      const midi = clamp(Math.round(Number(note.midi) || 0), 0, 127)
      const startBeat = (Number(note.bar) || 0) * beatsPerBar + (Number(note.beat) || 0)
      if (startBeat < 0) continue
      const offset = Math.round(startBeat * secondsPerBeat * sampleRate)
      if (offset >= renderFrames) continue
      const durBeats = Math.max(0.02, Number(note.durBeats) || 0.5)
      const velocity = clamp(Number(note.velocity) || 0.6, 0.02, 1)
      const rng = makeRng((seed ^ Math.imul(trackIndex + 1, 0x9E3779B1) ^ Math.imul(noteIndex + 1, 0x85EBCA6B)) >>> 0)
      const voiceSamples = isDrumKit
        ? renderDrumNote(midi, velocity, sampleRate, rng)
        : renderNote(voice, midi, durBeats * secondsPerBeat, velocity, sampleRate, rng, note.artic, envelopes)
      // `addInto(scratch, voiceSamples, offset, 1)` inlined: the source buffer is
      // accumulated note by note in order, so the sum is identical; dropping the
      // function call and the multiply by unity is free accuracy-wise.
      const limit = Math.min(renderFrames, offset + voiceSamples.length)
      for (let index = offset; index < limit; index += 1) scratch[index] += voiceSamples[index - offset]
      rendered += 1
    }

    let rawSumSquares = 0
    for (let index = 0; index < renderFrames; index += 1) {
      const value = scratch[index]
      rawSumSquares += value * value
    }
    const rawRms = Math.sqrt(rawSumSquares / Math.max(1, renderFrames))
    const levelScale = rawRms > 1e-7 ? clamp(targetRms / rawRms, 0, 1000) : 0

    let peak = 0
    let sumSquares = 0
    for (let index = 0; index < renderFrames; index += 1) {
      const value = scratch[index] * levelScale
      master[index] += value
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
      sumSquares += value * value
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, renderFrames))
    trackStats.push({
      id: track.id ?? track.role ?? `track-${trackIndex}`,
      role: track.role ?? 'melody',
      instrument: track.instrument ?? 'unknown',
      notes: rendered,
      targetDbfs: round2(targetDb),
      peakDbfs: levelDb(peak),
      rmsDbfs: levelDb(rms)
    })
  }

  applyTone(master, sampleRate, genre.masterTone ?? null)
  if (genre.reverb !== undefined && genre.reverb.amount > 0) {
    applyReverb(master, sampleRate, genre.reverb.amount, genre.reverb.size ?? 0.5)
  }
  dcBlock(master, sampleRate)

  let samples
  if (loop) {
    // Fold everything that would ring past the loop point back onto the head, so
    // replaying the file is a continuation rather than a cut.
    const fold = Math.min(tailFrames, mainFrames)
    for (let index = 0; index < fold; index += 1) master[index] += master[mainFrames + index]
    samples = master.slice(0, mainFrames)
  } else {
    // Cutting a still-ringing reverb tail clicks; every cue ends with a fade.
    const fade = Math.min(Math.round(0.05 * sampleRate), Math.floor(mainFrames / 8))
    for (let index = 0; index < fade; index += 1) master[renderFrames - 1 - index] *= index / fade
    samples = master
  }
  const targetPeakDbfs = Number.isFinite(Number(options.peakDbfs)) ? Number(options.peakDbfs) : -1
  const masterGain = normalizePeak(samples, targetPeakDbfs)
  const masterGainDb = masterGain > 0 ? 20 * Math.log10(masterGain) : 0
  softLimit(samples, 0.92)
  // Report track levels as they sit in the finished file, not as they were
  // before peak normalisation, so no track can look like it is over 0 dBFS.
  for (const track of trackStats) {
    track.peakDbfs = round2(track.peakDbfs + masterGainDb)
    track.rmsDbfs = round2(track.rmsDbfs + masterGainDb)
  }

  const beatMap = Array.isArray(score.beatMap) && score.beatMap.length === totalBeats
    ? score.beatMap
    : buildBeatMap(bars, beatsPerBar, bpm)
  const barMap = Array.isArray(score.barMap) && score.barMap.length === bars + 1
    ? score.barMap
    : buildBarMap(bars, beatsPerBar, bpm)
  const sections = Array.isArray(score.sections) && score.sections.length > 0
    ? score.sections
    : [{ name: 'full', fromBar: 0, toBar: bars, intensity: 1 }]

  const sectionStats = sections.map((section) => {
    const fromBar = clamp(Math.round(section.fromBar), 0, bars)
    const toBar = clamp(Math.round(section.toBar), fromBar, bars)
    const startFrame = Math.min(samples.length, Math.round(fromBar * beatsPerBar * secondsPerBeat * sampleRate))
    const endFrame = Math.min(samples.length, Math.round(toBar * beatsPerBar * secondsPerBeat * sampleRate))
    let peak = 0
    let sumSquares = 0
    for (let index = startFrame; index < endFrame; index += 1) {
      const value = samples[index]
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
      sumSquares += value * value
    }
    let noteCount = 0
    for (const track of tracks) {
      for (const note of track.notes ?? []) {
        const bar = Number(note.bar) || 0
        if (bar >= fromBar && bar < toBar) noteCount += 1
      }
    }
    return {
      name: section.name,
      fromBar,
      toBar,
      intensity: round2(Number(section.intensity) || 0),
      notes: noteCount,
      durationSeconds: round2((endFrame - startFrame) / sampleRate),
      peakDbfs: levelDb(peak),
      rmsDbfs: levelDb(Math.sqrt(sumSquares / Math.max(1, endFrame - startFrame)))
    }
  })

  return {
    samples,
    sampleRate,
    beatMap,
    barMap,
    trackStats,
    sectionStats,
    durationSeconds: round2(samples.length / sampleRate),
    loop
  }
}

/* ------------------------------------------------------------- encoding -- */

/**
 * Encode rendered samples as deterministic 16-bit WAV bytes.
 *
 * The codec's own dither uses `Math.random`, which would make two renders of
 * one score differ by a few least-significant bits. Music cues are cached and
 * diffed, so this applies a seeded triangular dither instead and asks the codec
 * not to add its own: same score in, byte-identical file out.
 *
 * @param {Float32Array} samples - mono samples.
 * @param {number} sampleRate - Hz.
 * @param {number} seed - score seed.
 * @returns {Buffer} complete `.wav` bytes.
 */
export function toComposeWavBytes (samples, sampleRate, seed = 1) {
  const rand = makeRng((normaliseSeed(seed) ^ 0x5F356495) >>> 0)
  const dithered = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    dithered[index] = samples[index] + (rand() - rand()) / 32768
  }
  return encodeWav([dithered], sampleRate, { dither: false })
}

