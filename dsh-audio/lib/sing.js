/**
 * Zero-asset singing voice: a formant (source-filter) synthesizer.
 *
 * There is no voicebank and no neural network here. The engine is the classic
 * Fant/Klatt signal path: a glottal pulse train with jitter and shimmer, a
 * parallel bank of four formant resonators carrying the vowel, a nasal pole,
 * gated breath noise, and consonant noise segments shaped per phonetic class.
 * What that buys is availability — it ships with the plugin, needs no download
 * and no network, and every byte is deterministic. What it costs is
 * naturalness: this is recognizably a formant synthesizer singing words, not a
 * recording of a person.
 *
 * Why parallel (not cascade) formants: the vowel tables carry a relative
 * amplitude per formant, and a parallel bank can honour those amplitudes
 * directly (each resonator is peak-normalised) instead of letting the cascade
 * slope dictate them. That keeps the table honest and the formant peaks
 * measurable, which is what the tests check.
 *
 * Everything is seeded. Identical (plan, options) always produces identical
 * samples; `singPlan` and `parseSyllable` never throw, because a model will
 * eventually pass them something strange and a thrown render is worth less
 * than a sung 'a'.
 */

import {
  addInto,
  clamp,
  dbToGain,
  dcBlock,
  makeRng,
  normalizePeak,
  reverb,
  softLimit,
  unit
} from './dsp.js'

const TAU = Math.PI * 2
/** Control-rate block: formants and f0 are updated this often (0.73 ms at 44.1 kHz). */
const CONTROL_BLOCK = 32
/** Pitch track resolution handed to callers (5 ms), good enough for subtitle sync. */
const PITCH_TRACK_RATE = 200
/** Cents -> frequency ratio, first two terms of 2^(c/1200): error < 0.03 cents at 55. */
const CENTS_RATIO = Math.log(2) / 1200
/** Everything above this is a runaway request, not a cue. */
const MAX_SECONDS = 600

/* ------------------------------------------------------------------ vowels -- */

/**
 * Oral vowel formants (adult neutral tract, Hz) and resonator bandwidths.
 * `db` is the resonator's peak gain relative to F1. A vocal tract has roughly
 * equal peak gain at every formant, so these stay close to 0 dB and the natural
 * downward spectral slope comes from the glottal source instead — that is where
 * it comes from in a real voice too. The small per-vowel deviations are the
 * formant-balance character (F2 of /i/ is strong, F3 of /a/ is not).
 */
const ORAL_VOWELS = {
  // a: open central/front-ish — the loudest, most stable test vowel
  a: { f: [700, 1220, 2600, 3400], bw: [80, 90, 130, 160], db: [0, -2, -6, -10] },
  e: { f: [500, 1800, 2500, 3300], bw: [70, 95, 130, 160], db: [0, -3, -7, -11] },
  i: { f: [290, 2300, 3000, 3500], bw: [60, 95, 140, 170], db: [0, -1, -5, -9] },
  o: { f: [450, 800, 2830, 3500], bw: [70, 85, 130, 160], db: [0, -1, -6, -10] },
  u: { f: [320, 800, 2240, 3200], bw: [65, 85, 130, 160], db: [0, -1, -6, -10] },
  // ü (Mandarin 'u' after j/q/x/y): front rounded — high F1, front F2
  v: { f: [290, 1750, 2400, 3300], bw: [60, 95, 140, 170], db: [0, -2, -6, -10] },
  // apical [ɨ] of zhi/chi/shi/ri/zi/ci/si — not [i], which is why 'shi' can
  // sound different from 'xi' even with this small a table
  i0: { f: [400, 1400, 2500, 3400], bw: [80, 110, 150, 180], db: [0, -3, -7, -11] }
}

/**
 * Mandarin nasal finals are base vowels plus a velar/alveolar murmur, so they
 * are generated from the oral entries instead of duplicated: lower F2 a little,
 * widen F1, and drive the 250 Hz nasal pole.
 */
const NASAL_VOWELS = [
  ['an', 'a', { f2: 0.95, nasal: 0.55, bw1: 1.4 }],
  ['en', 'e', { f2: 0.96, nasal: 0.5, bw1: 1.4 }],
  ['in', 'i', { f2: 0.97, nasal: 0.45, bw1: 1.4 }],
  ['un', 'u', { f2: 1.02, nasal: 0.5, bw1: 1.4 }],
  ['vn', 'v', { f2: 0.97, nasal: 0.5, bw1: 1.4 }],
  ['ang', 'a', { f2: 0.86, nasal: 0.8, bw1: 1.5, f1: 1.02 }],
  ['eng', 'e', { f2: 0.88, nasal: 0.75, bw1: 1.5 }],
  ['ing', 'i', { f2: 0.9, nasal: 0.7, bw1: 1.5 }],
  ['ong', 'o', { f2: 0.86, nasal: 0.8, bw1: 1.6, f1: 1.1 }],
  // er (儿): retroflexed, F3 collapses towards F2
  ['er', 'e', { f2: 0.72, f3: 0.7, nasal: 0.25, bw1: 1.2 }]
]

function makeVowel (id, f, bw, db, extra = {}) {
  return {
    id,
    f1: f[0], f2: f[1], f3: f[2], f4: f[3],
    bw1: bw[0], bw2: bw[1], bw3: bw[2], bw4: bw[3],
    a1: dbToGain(db[0]), a2: dbToGain(db[1]), a3: dbToGain(db[2]), a4: dbToGain(db[3]),
    nasal: 0,
    ...extra
  }
}

/** Every vowel the engine can sing, keyed by the id `parseSyllable` emits. */
export const VOWELS = {}
for (const [id, spec] of Object.entries(ORAL_VOWELS)) VOWELS[id] = makeVowel(id, spec.f, spec.bw, spec.db)
for (const [id, baseId, tweak] of NASAL_VOWELS) {
  const base = ORAL_VOWELS[baseId]
  const f = base.f.slice()
  const bw = base.bw.slice()
  const db = base.db.slice()
  if (tweak.f1 !== undefined) f[0] *= tweak.f1
  if (tweak.f2 !== undefined) f[1] *= tweak.f2
  if (tweak.f3 !== undefined) f[2] *= tweak.f3
  if (tweak.bw1 !== undefined) bw[0] *= tweak.bw1
  // A nasal vowel loses F1 amplitude to the nasal pole; keep the total sane.
  db[0] -= 3
  VOWELS[id] = makeVowel(id, f, bw, db, { nasal: tweak.nasal })
}

/* -------------------------------------------------------------- consonants -- */

/**
 * Mandarin initials, one entry per pinyin letter group. Fields are the ones the
 * renderer actually consumes; anything missing falls back to a class default.
 *
 * Levels matter as much as timbres here: a consonant in speech sits well below
 * its vowel (about -10 dB for a nasal or /s/, -15 dB for /f/), and a consonant
 * at vowel level reads as a shout rather than a word. `murmur` and `noise.gain`
 * are calibrated against the vowel of the same syllable, measured in the tests.
 *
 *   class     plosive | fricative | affricate | nasal | liquid | semivowel
 *   voiced    whether the glottal source runs during the consonant (a murmur)
 *   murmur    murmur level relative to the vowel's amplitude (0 = silent)
 *   dur       nominal length in seconds (clamped to 45 % of the note slot)
 *   locus     formant target the vowel starts from (locus theory: the transition
 *             into the vowel is most of what makes a consonant readable)
 *   closure   seconds of stop closure before the burst
 *   burst     release burst: gain, dur, q, and `center` (0 = derive from F2)
 *   aspiration seconds of aspiration noise after the burst (aspirated stops)
 *   noise     frication: center Hz, q, gain, hp corner
 */
export const CONSONANTS = {
  // --- plosives -------------------------------------------------------
  b: { class: 'plosive', voiced: true, dur: 0.075, murmur: 0.026, closure: 0.045, burst: { gain: 0.3, dur: 0.009, q: 1.0, center: 900 }, aspiration: 0.012, locus: [280, 900, 2200, 3300] },
  p: { class: 'plosive', voiced: false, dur: 0.095, closure: 0.042, burst: { gain: 0.34, dur: 0.009, q: 0.9, center: 900 }, aspiration: 0.048, locus: [280, 900, 2200, 3300] },
  d: { class: 'plosive', voiced: true, dur: 0.07, murmur: 0.024, closure: 0.042, burst: { gain: 0.28, dur: 0.009, q: 1.1, center: 2600 }, aspiration: 0.01, locus: [280, 1700, 2600, 3400] },
  t: { class: 'plosive', voiced: false, dur: 0.09, closure: 0.04, burst: { gain: 0.3, dur: 0.009, q: 0.9, center: 2600 }, aspiration: 0.045, locus: [280, 1700, 2600, 3400] },
  g: { class: 'plosive', voiced: true, dur: 0.075, murmur: 0.024, closure: 0.045, burst: { gain: 0.26, dur: 0.01, q: 1.1, center: 1800 }, aspiration: 0.012, locus: [280, 2000, 2500, 3300] },
  k: { class: 'plosive', voiced: false, dur: 0.095, closure: 0.042, burst: { gain: 0.28, dur: 0.01, q: 0.9, center: 1800 }, aspiration: 0.048, locus: [280, 2000, 2500, 3300] },

  // --- fricatives -----------------------------------------------------
  s: { class: 'fricative', voiced: false, dur: 0.12, noise: { center: 5400, q: 1.05, gain: 0.055, hp: 2800 }, locus: [300, 1600, 2800, 3500] },
  sh: { class: 'fricative', voiced: false, dur: 0.125, noise: { center: 3100, q: 1.3, gain: 0.062, hp: 1600 }, locus: [300, 1800, 2400, 3300] },
  x: { class: 'fricative', voiced: false, dur: 0.12, noise: { center: 4400, q: 1.25, gain: 0.055, hp: 2400 }, locus: [300, 2200, 3000, 3500] },
  f: { class: 'fricative', voiced: false, dur: 0.105, noise: { center: 1300, q: 0.75, gain: 0.05, hp: 500 }, locus: [300, 1200, 2400, 3300] },
  h: { class: 'fricative', voiced: false, dur: 0.1, noise: { center: 1500, q: 0.6, gain: 0.045, hp: 400 }, locus: [300, 1200, 2400, 3300] },

  // --- affricates: short closure, then frication ----------------------
  z: { class: 'affricate', voiced: false, dur: 0.115, closure: 0.03, noise: { center: 5400, q: 1.05, gain: 0.06, hp: 2800 }, locus: [300, 1600, 2800, 3500] },
  c: { class: 'affricate', voiced: false, dur: 0.13, closure: 0.028, noise: { center: 5400, q: 1.05, gain: 0.06, hp: 2800 }, aspiration: 0.03, locus: [300, 1600, 2800, 3500] },
  zh: { class: 'affricate', voiced: false, dur: 0.12, closure: 0.03, noise: { center: 3100, q: 1.3, gain: 0.065, hp: 1600 }, locus: [300, 1800, 2400, 3300] },
  ch: { class: 'affricate', voiced: false, dur: 0.135, closure: 0.028, noise: { center: 3100, q: 1.3, gain: 0.065, hp: 1600 }, aspiration: 0.03, locus: [300, 1800, 2400, 3300] },
  j: { class: 'affricate', voiced: false, dur: 0.115, closure: 0.03, noise: { center: 4400, q: 1.25, gain: 0.06, hp: 2400 }, locus: [300, 2200, 3000, 3500] },
  q: { class: 'affricate', voiced: false, dur: 0.13, closure: 0.028, noise: { center: 4400, q: 1.25, gain: 0.06, hp: 2400 }, aspiration: 0.03, locus: [300, 2200, 3000, 3500] },

  // --- nasals: voiced murmur through a low nasal formant --------------
  m: { class: 'nasal', voiced: true, dur: 0.075, murmur: 0.062, nasal: 0.9, locus: [250, 1000, 2200, 3300] },
  n: { class: 'nasal', voiced: true, dur: 0.065, murmur: 0.058, nasal: 0.85, locus: [250, 1600, 2600, 3400] },
  ng: { class: 'nasal', voiced: true, dur: 0.07, murmur: 0.052, nasal: 0.75, locus: [250, 2000, 2800, 3500] },

  // --- liquids --------------------------------------------------------
  l: { class: 'liquid', voiced: true, dur: 0.055, murmur: 0.30, locus: [350, 1100, 2700, 3400] },
  r: { class: 'liquid', voiced: true, dur: 0.055, murmur: 0.27, locus: [350, 1300, 1600, 3200] },

  // --- semivowels (glides) -------------------------------------------
  y: { class: 'semivowel', voiced: true, dur: 0.05, murmur: 0.30, locus: [280, 2200, 3000, 3500] },
  w: { class: 'semivowel', voiced: true, dur: 0.05, murmur: 0.27, locus: [300, 700, 2200, 3200] }
}

/** Relative formant gains while a voiced consonant is held (murmur timbre). */
const CLASS_GAINS = {
  nasal: [1, 0.35, 0.15, 0.08],
  liquid: [1, 0.7, 0.45, 0.25],
  semivowel: [1, 0.7, 0.45, 0.25],
  plosive: [1, 0.7, 0.5, 0.3],
  fricative: [1, 0.7, 0.5, 0.3],
  affricate: [1, 0.7, 0.5, 0.3]
}
const CLASS_BW = [90, 110, 150, 190]

/* ----------------------------------------------------------- voice presets -- */

/**
 * Voice colours. `formantScale` is the only one that changes the perceived
 * body size: a shorter tract (child) raises every formant, a longer one (bass)
 * lowers them. `tilt` is the glottal source's one-pole corner.
 */
export const VOICE_PRESETS = {
  alto: {
    label: 'alto',
    formantScale: 1.04, tiltHz: 2600, jitter: 0.0035, shimmer: 0.028,
    vibrato: 0.36, vibratoRate: 5.4, breath: 0.13, attack: 0.032, release: 0.085,
    portamento: 0.045, space: 0, voices: 1, detuneCents: 0
  },
  bass: {
    label: 'bass',
    formantScale: 0.86, tiltHz: 1900, jitter: 0.0030, shimmer: 0.022,
    vibrato: 0.28, vibratoRate: 5.0, breath: 0.09, attack: 0.040, release: 0.11,
    portamento: 0.055, space: 0, voices: 1, detuneCents: 0
  },
  child: {
    label: 'child',
    formantScale: 1.30, tiltHz: 3200, jitter: 0.0050, shimmer: 0.040,
    vibrato: 0.30, vibratoRate: 6.0, breath: 0.16, attack: 0.024, release: 0.070,
    portamento: 0.035, space: 0, voices: 1, detuneCents: 0
  },
  breathy: {
    label: 'breathy',
    formantScale: 1.00, tiltHz: 2400, jitter: 0.0050, shimmer: 0.050,
    vibrato: 0.32, vibratoRate: 5.2, breath: 0.45, attack: 0.045, release: 0.10,
    portamento: 0.05, space: 0, voices: 1, detuneCents: 0
  },
  choir: {
    label: 'choir',
    formantScale: 1.03, tiltHz: 2700, jitter: 0.0040, shimmer: 0.035,
    vibrato: 0.42, vibratoRate: 5.6, breath: 0.20, attack: 0.035, release: 0.10,
    portamento: 0.05, space: 0.35, voices: 3, detuneCents: 7
  }
}

/* ------------------------------------------------------------- note names -- */

const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/**
 * Scientific pitch name ("C4", "A#3", "Bb5") or a MIDI number to MIDI.
 * C4 is middle C (60), A4 is 69 (440 Hz).
 * @returns {number|null} MIDI note or null when the token is not a pitch.
 */
export function noteToMidi (text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const value = Math.round(Number(raw))
    return value >= 0 && value <= 127 ? value : null
  }
  const match = /^([a-gA-G])([#b]?)(-?\d+)?$/.exec(raw)
  if (match === null) return null
  const octave = match[3] === undefined ? 4 : Number(match[3])
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0
  const midi = 12 * (octave + 1) + NOTE_OFFSETS[match[1].toLowerCase()] + accidental
  return midi >= 0 && midi <= 127 ? midi : null
}

/**
 * MIDI note number to frequency in Hz (fractional MIDI allowed, which is how
 * detune in cents is applied).
 * @param {number} midi - note number, 69 = A4.
 * @returns {number} Hz.
 */
export function midiToHz (midi) {
  return 440 * Math.pow(2, (Number(midi) - 69) / 12)
}

/* --------------------------------------------------------- syllable parser -- */

const VOWEL_KEYS = Object.keys(VOWELS).sort((a, b) => b.length - a.length)
const INITIAL_KEYS = Object.keys(CONSONANTS).filter((key) => key !== 'ng').sort((a, b) => b.length - a.length)
/** After these initials, pinyin 'i' is the apical vowel [ɨ], not [i]. */
const APICAL_INITIALS = new Set(['z', 'c', 's', 'zh', 'ch', 'sh', 'r'])
/** After j/q/x/y, pinyin 'u' is really ü. */
const UMLAUT_INITIALS = new Set(['j', 'q', 'x', 'y'])

/**
 * Parse one romanized syllable into its consonant and vowel sequence.
 *
 * No dictionary: longest-match the initial, then greedily longest-match vowel
 * ids out of what is left. Pinyin orthography quirks that change the vowel are
 * handled explicitly (xue = x + ü + e, ju = j + ü, zhi = zh + [ɨ]). Unknown
 * input never throws — unrecognised letters are skipped and a syllable with no
 * vowel at all falls back to the vowel the string can see, else 'a'.
 *
 * @param {string} text - pinyin-ish syllable, e.g. "ma", "ni", "xue", "zhang".
 * @returns {{ consonant: string|null, vowels: string[], text: string }}
 */
export function parseSyllable (text) {
  const original = typeof text === 'string' ? text : String(text ?? '')
  // Tone digits, punctuation, tone marks and ü are normalised away before
  // matching; ü becomes 'v' because that is the ASCII id the table uses.
  let rest = original
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')
    .replace(/[^a-z]/g, '')

  if (rest.length === 0) {
    return { consonant: null, vowels: ['a'], text: original }
  }

  let consonant = null
  for (const key of INITIAL_KEYS) {
    if (rest.startsWith(key)) {
      consonant = key
      rest = rest.slice(key.length)
      break
    }
  }

  if (consonant !== null && UMLAUT_INITIALS.has(consonant) && rest.startsWith('u')) {
    rest = `v${rest.slice(1)}`
  }

  const vowels = []
  let cursor = 0
  while (cursor < rest.length) {
    let matched = null
    for (const key of VOWEL_KEYS) {
      if (rest.startsWith(key, cursor)) {
        matched = key
        break
      }
    }
    if (matched === null) {
      cursor += 1
      continue
    }
    vowels.push(matched)
    cursor += matched.length
  }

  if (vowels.length === 0) {
    // Fall back to the vowel the string can see anywhere, else the default.
    const seen = /[aeiouv]/.exec(rest) ?? /[aeiouv]/.exec(original.toLowerCase())
    return { consonant, vowels: [seen === null ? 'a' : seen[0]], text: original }
  }

  // zhi/chi/shi/ri/zi/ci/si: the vowel is apical, and it is the first vowel.
  if (vowels[0] === 'i' && consonant !== null && APICAL_INITIALS.has(consonant)) vowels[0] = 'i0'

  return { consonant, vowels, text: original }
}

/**
 * The vowel a listener would call "the vowel" of a syllable: for a diphthong
 * that is the nucleus, which is the last (longest) segment in this engine.
 * @param {string[]} vowels - ids from `parseSyllable`.
 * @returns {string} one vowel id.
 */
export function primaryVowel (vowels) {
  if (!Array.isArray(vowels) || vowels.length === 0) return 'a'
  return vowels[vowels.length - 1]
}

/* ------------------------------------------------------------ lyric split -- */

/**
 * Split a lyric into singable syllables. Whitespace, commas, hyphens and
 * apostrophes separate syllables ("xi'an" is two: xi + an). Han characters each
 * become one syllable but cannot be romanized without a dictionary, so they are
 * flagged for the caller to replace with pinyin.
 *
 * @param {string} text - lyric, pinyin or mixed.
 * @returns {{ syllables: string[], warnings: string[] }}
 */
export function splitLyric (text) {
  const warnings = []
  const raw = typeof text === 'string' ? text : ''
  const tokens = raw
    .split(/[\s,;:/|、。，；：！？!?.'’`\-–—+&()（）[\]{}]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  const syllables = []
  let unromanized = 0
  for (const token of tokens) {
    // Han/Kana/Kana-ish blocks: one syllable each, romanization impossible here.
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(token)) {
      for (const _char of token) {
        syllables.push('a')
        unromanized += 1
      }
      continue
    }
    syllables.push(token)
  }
  if (unromanized > 0) {
    warnings.push(`${unromanized} syllable(s) were not romanized; pass pinyin (e.g. "wo ai ni") to sing real words`)
  }
  return { syllables, warnings }
}

/* ------------------------------------------------------------------ melody -- */

/**
 * Parse a compact melody string like `"C4:1 E4:1 G4:2"` or `"A3:.5 r:1 B3:1.5"`.
 * A token is `<pitch>[:<beats>]`; `r` or `-` is a rest. Unknown tokens are
 * skipped rather than thrown on.
 * @param {string} melody - space/comma separated tokens.
 * @returns {{ midi: number|null, durBeats: number }[]} midi null = rest.
 */
export function parseMelody (melody) {
  const notes = []
  const tokens = String(melody ?? '').split(/[\s,|]+/).filter((token) => token.length > 0)
  for (const token of tokens) {
    const parts = token.split(':')
    const head = (parts[0] ?? '').trim()
    const beats = clamp(Number(parts[1] ?? 1) || 1, 0.0625, 16)
    if (head === '') continue
    if (head === 'r' || head === 'R' || head === '-') {
      notes.push({ midi: null, durBeats: beats })
      continue
    }
    const midi = noteToMidi(head)
    if (midi === null) continue
    notes.push({ midi, durBeats: beats })
  }
  return notes
}

/** Default tune used when the caller only supplies a lyric: a pentatonic walk. */
const DEFAULT_TUNE = [0, 2, 4, 7, 9, 7, 4, 2]

/* --------------------------------------------------------------- planning -- */

function finiteOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function positiveOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Turn a request into a note plan. Never throws: an empty request still plans
 * a short "la la la la" so a caller gets sound instead of an exception.
 *
 * Sources, in priority order: explicit `notes`, a `melody` string, a `lyric`
 * (one note per syllable on the default tune). A `lyric` also fills syllables
 * onto notes that did not name one.
 *
 * @param {object} request
 * @param {{midi?:number|string,dur?:number,beat?:number,syllable?:string,velocity?:number}[]} [request.notes]
 * @param {string} [request.melody] - e.g. "C4:1 E4:1 G4:2".
 * @param {string} [request.lyric] - space separated syllables.
 * @param {number} [request.bpm] - 20..300, default 96.
 * @returns {{ notes: {midi:number,startBeat:number,durBeats:number,syllable:string,vowel:string,consonant:string|null,vowels:string[],velocity:number}[], bpm:number, totalBeats:number, totalSeconds:number, warnings:string[] }}
 */
export function singPlan (request = {}) {
  const input = request !== null && typeof request === 'object' ? request : {}
  const warnings = []
  const bpm = clamp(finiteOr(input.bpm, 96), 20, 300)
  const secondsPerBeat = 60 / bpm
  const lyric = splitLyric(input.lyric)
  warnings.push(...lyric.warnings)
  const lyricSyllables = lyric.syllables

  /** @type {{midi:number|null,durBeats:number,syllable?:string,beat?:number,velocity:number}[]} */
  let source = []

  if (Array.isArray(input.notes) && input.notes.length > 0) {
    for (const item of input.notes) {
      if (item === null || item === undefined) continue
      if (typeof item === 'number' || typeof item === 'string') {
        const midi = noteToMidi(item)
        if (midi === null) continue
        source.push({ midi, durBeats: 1, velocity: 1 })
        continue
      }
      if (typeof item !== 'object') continue
      const midi = typeof item.midi === 'string' ? noteToMidi(item.midi) : (Number.isFinite(item.midi) ? Math.round(item.midi) : noteToMidi(item.note))
      source.push({
        midi: midi === null || !Number.isFinite(midi) ? null : clamp(midi, 0, 127),
        durBeats: clamp(positiveOr(item.dur, positiveOr(item.duration, 1)), 0.0625, 32),
        syllable: typeof item.syllable === 'string' ? item.syllable : undefined,
        beat: Number.isFinite(item.beat) ? item.beat : undefined,
        velocity: clamp(finiteOr(item.velocity, 1), 0.05, 1)
      })
    }
  }

  if (source.length === 0 && typeof input.melody === 'string' && input.melody.trim() !== '') {
    for (const parsed of parseMelody(input.melody)) {
      source.push({ midi: parsed.midi, durBeats: parsed.durBeats, velocity: 1 })
    }
  }

  if (source.length === 0) {
    const count = lyricSyllables.length > 0 ? Math.min(lyricSyllables.length, 64) : 4
    for (let index = 0; index < count; index += 1) {
      source.push({
        midi: 60 + DEFAULT_TUNE[index % DEFAULT_TUNE.length],
        durBeats: 1,
        syllable: lyricSyllables[index],
        velocity: 1
      })
    }
  }

  // Rest tokens become silence: they advance the beat cursor but produce no note.
  const notes = []
  let cursor = 0
  let lyricCursor = 0
  for (const item of source) {
    const durBeats = item.durBeats
    const startBeat = item.beat !== undefined ? Math.max(0, item.beat) : cursor
    cursor = startBeat + durBeats
    if (item.midi === null || !Number.isFinite(item.midi)) continue
    let syllableText = item.syllable
    if (syllableText === undefined && lyricSyllables.length > 0) {
      // Reuse the last syllable when the tune is longer than the lyric, which is
      // what a singer told "la la la on these notes" would do.
      syllableText = lyricSyllables[Math.min(lyricCursor, lyricSyllables.length - 1)]
      lyricCursor += 1
    }
    if (syllableText === undefined || syllableText === '') syllableText = 'la'
    const parsed = parseSyllable(syllableText)
    notes.push({
      midi: clamp(Math.round(item.midi), 0, 127),
      startBeat: Number(startBeat.toFixed(6)),
      durBeats: Number(durBeats.toFixed(6)),
      syllable: syllableText,
      vowel: primaryVowel(parsed.vowels),
      consonant: parsed.consonant,
      vowels: parsed.vowels,
      velocity: item.velocity
    })
  }

  notes.sort((a, b) => a.startBeat - b.startBeat)
  if (notes.length === 0) {
    // Everything was a rest: one audible note beats a silent file.
    notes.push({
      midi: 60, startBeat: 0, durBeats: 1, syllable: 'la', vowel: 'a', consonant: 'l', vowels: ['a'], velocity: 1
    })
  }

  let totalBeats = 0
  for (const note of notes) totalBeats = Math.max(totalBeats, note.startBeat + note.durBeats)
  if (lyricSyllables.length > notes.length) {
    warnings.push(`${lyricSyllables.length} lyric syllables but only ${notes.length} notes; extra syllables ignored`)
  }

  return {
    notes,
    bpm,
    totalBeats,
    totalSeconds: totalBeats * secondsPerBeat,
    warnings
  }
}

/* --------------------------------------------------------------- synthesis -- */

function ledger (options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const preset = VOICE_PRESETS[String(source.voice ?? '')] ?? VOICE_PRESETS.alto
  const cfg = { ...preset }
  // Caller overrides win; note that 0 is a meaningful override (no vibrato).
  if (source.vibrato !== undefined) cfg.vibrato = unit(source.vibrato)
  if (source.breath !== undefined) cfg.breath = unit(source.breath)
  if (source.vibratoRate !== undefined) cfg.vibratoRate = clamp(finiteOr(source.vibratoRate, preset.vibratoRate), 3, 9)
  if (source.jitter !== undefined) cfg.jitter = clamp(finiteOr(source.jitter, preset.jitter), 0, 0.02)
  if (source.shimmer !== undefined) cfg.shimmer = clamp(finiteOr(source.shimmer, preset.shimmer), 0, 0.15)
  if (source.formantScale !== undefined) cfg.formantScale = clamp(finiteOr(source.formantScale, preset.formantScale), 0.7, 1.6)
  if (source.tiltHz !== undefined) cfg.tiltHz = clamp(finiteOr(source.tiltHz, preset.tiltHz), 600, 6000)
  if (source.portamento !== undefined) cfg.portamento = clamp(finiteOr(source.portamento, preset.portamento), 0, 0.4)
  if (source.attack !== undefined) cfg.attack = clamp(finiteOr(source.attack, preset.attack), 0.002, 0.4)
  if (source.release !== undefined) cfg.release = clamp(finiteOr(source.release, preset.release), 0.004, 0.6)
  if (source.space !== undefined) cfg.space = unit(source.space)
  cfg.vibratoDepthCents = cfg.vibrato * 55
  cfg.vibratoDelay = 0.2
  cfg.vibratoRamp = 0.28
  return cfg
}

/** Copies of a note list transposed, used by the harmony and choir layers. */
function transposePlan (plan, semitones, cents = 0) {
  const shift = semitones + cents / 100
  return {
    ...plan,
    notes: plan.notes.map((note) => ({ ...note, midi: note.midi + shift }))
  }
}

/** Target formant set for one vowel id, already scaled to the voice. */
function vowelTarget (id, scale) {
  const vowel = VOWELS[id] ?? VOWELS.a
  return {
    f: [vowel.f1 * scale, vowel.f2 * scale, vowel.f3 * scale, vowel.f4 * scale],
    bw: [vowel.bw1, vowel.bw2, vowel.bw3, vowel.bw4],
    g: [vowel.a1, vowel.a2, vowel.a3, vowel.a4],
    nasal: vowel.nasal
  }
}

/** Target formant set for a consonant's locus or murmur. */
function consonantTarget (entry) {
  const cls = entry?.class ?? 'plosive'
  const gains = CLASS_GAINS[cls] ?? CLASS_GAINS.plosive
  const locus = Array.isArray(entry?.locus) ? entry.locus : [300, 1200, 2500, 3300]
  return {
    f: locus.slice(),
    bw: CLASS_BW.slice(),
    g: gains.slice(),
    nasal: entry?.class === 'nasal' ? (entry.nasal ?? 0.8) : 0
  }
}

/** One-pole smoothing coefficient for a time constant, at the control rate. */
function smoothing (seconds, sampleRate) {
  if (!(seconds > 0)) return 1
  return 1 - Math.exp(-(CONTROL_BLOCK / sampleRate) / seconds)
}

/**
 * Coefficients for a two-pole/two-zero formant resonator with unity gain at its
 * centre frequency:
 *
 *     y[n] = A (x[n] - x[n-2]) + B y[n-1] + C y[n-2]
 *
 * The numerator's zero sits at DC on purpose. A plain two-pole resonator has
 * unity gain at DC *and* unity gain at its peak after normalisation, so summing
 * four of them piles up the fundamental: the first harmonic came out only 3 dB
 * below F1, which is what makes a parallel-formant synthesizer sound like a
 * buzzer with a vowel painted on it. The DC zero turns each resonator into a
 * real bandpass (about -28 dB at 220 Hz for a 700 Hz F1) and the formants come
 * out dominant, which is both more voice-like and directly measurable.
 */
function setResonator (coeff, index, freq, bandwidth, sampleRate) {
  const clampedFreq = clamp(freq, 40, sampleRate * 0.45)
  const clampedBw = clamp(bandwidth, 5, sampleRate * 0.6)
  const w = TAU * clampedFreq / sampleRate
  const r = Math.exp(-Math.PI * clampedBw / sampleRate)
  const b = 2 * r * Math.cos(w)
  const c = -r * r
  const cosW = Math.cos(w)
  const sinW = Math.sin(w)
  const cos2 = 2 * cosW * cosW - 1
  const sin2 = 2 * sinW * cosW
  const re = 1 - b * cosW - c * cos2
  const im = b * sinW + c * sin2
  const den = Math.sqrt(re * re + im * im)
  const amplitude = den > 1e-9 && sinW > 1e-6 ? den / (2 * sinW) : 1
  coeff[index * 3] = amplitude
  coeff[index * 3 + 1] = b
  coeff[index * 3 + 2] = c
}

/** Bandpass (RBJ, 0 dB peak) coefficients for consonant noise. */
function bandpass (freq, q, sampleRate) {
  const w = TAU * clamp(freq, 60, sampleRate * 0.45) / sampleRate
  const alpha = Math.sin(w) / (2 * Math.max(0.2, q))
  const a0 = 1 + alpha
  return {
    b0: alpha / a0,
    b2: -alpha / a0,
    a1: -2 * Math.cos(w) / a0,
    a2: (1 - alpha) / a0
  }
}

/**
 * Render one consonant's noise: the release burst of a stop, the frication of a
 * fricative/affricate, and the aspiration that follows an aspirated stop. This
 * is deliberately a separate buffer added at the note start — keeping it out of
 * the voiced loop keeps that loop tight, and the murmur stays in the voice where
 * it belongs.
 */
function renderConsonantNoise (entry, vowelF2, lengthSamples, sampleRate, rand) {
  const out = new Float32Array(Math.max(0, lengthSamples))
  if (out.length === 0 || entry === null) return out
  const cls = entry.class
  const noise = entry.noise ?? null
  const burst = entry.burst ?? null
  const open = (freq, q, gain, start, end, attackSec, decaySec) => {
    if (end <= start) return
    const band = bandpass(freq, q, sampleRate)
    const attack = Math.max(1, Math.round(attackSec * sampleRate))
    const decay = Math.max(1, Math.round(decaySec * sampleRate))
    const span = Math.max(0, Math.min(end, out.length) - start)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < span; i += 1) {
      const x = rand() * 2 - 1
      const y = band.b0 * x + band.b2 * x2 - band.a1 * y1 - band.a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      let env = 1
      if (i < attack) {
        const p = i / attack
        env = p * p * (3 - 2 * p)
      }
      const remain = span - i
      if (remain < decay) {
        const p = remain / decay
        env *= p * p
      }
      out[start + i] += y * gain * env
    }
  }

  if (cls === 'fricative') {
    if (noise === null) return out
    open(noise.center, noise.q, noise.gain, 0, out.length,
      Math.min(0.015, out.length / sampleRate * 0.3), Math.min(0.02, out.length / sampleRate * 0.35))
    return out
  }

  if (cls === 'plosive' || cls === 'affricate') {
    const aspirationSamples = Math.round((entry.aspiration ?? 0) * sampleRate)
    const burstSamples = burst === null ? 0 : Math.round((burst.dur ?? 0.009) * sampleRate)
    if (cls === 'plosive' && burst !== null) {
      const burstStart = Math.max(0, out.length - aspirationSamples - burstSamples)
      const center = burst.center > 0 ? burst.center : clamp(vowelF2 * 1.05, 500, sampleRate * 0.4)
      open(center, burst.q ?? 1.0, burst.gain ?? 0.5, burstStart, burstStart + burstSamples, 0.0012, 0.009)
      if (aspirationSamples > 0) {
        // Aspiration is noise shaped by the *following* vowel's F2, which is why
        // 'pa' and 'ta' sound different even though both are just air.
        open(clamp(vowelF2 * 1.4, 700, sampleRate * 0.4), 0.9, entry.aspirationGain ?? 0.09,
          out.length - aspirationSamples, out.length, 0.006, 0.02)
      }
      return out
    }
    // Affricate: closure then frication to the end of the consonant.
    if (noise === null) return out
    const closureSamples = Math.min(out.length, Math.round((entry.closure ?? 0.03) * sampleRate))
    open(noise.center, noise.q, noise.gain, closureSamples, out.length, 0.006, 0.015)
    return out
  }

  return out
}

/**
 * Render one voice layer into `master`. The voice state (phase, formant
 * resonators) deliberately survives note boundaries: carrying it is what keeps
 * legato notes click-free.
 */
function renderLayer (master, plan, sampleRate, cfg, rand, gain, offsetSamples, pitchTrack) {
  const secondsPerBeat = 60 / plan.bpm
  const totalFrames = master.length
  const frameStep = sampleRate / PITCH_TRACK_RATE

  // Cross-note voice state.
  const voice = {
    phase: 0,
    tilt: 0,
    jitter: 1,
    shimmer: 1,
    vibPhase: 0,
    f: [700, 1220, 2600, 3400],
    bw: [80, 90, 130, 160],
    g: [1, 0.5, 0.2, 0.1],
    nasal: 0,
    state: new Float64Array(28), // 7 resonators x (x1, x2, y1, y2)
    coeff: new Float64Array(21), // 7 resonators x (A, B, C)
    rg: new Float64Array(7)
  }
  const rs = voice.state
  const rc = voice.coeff
  const rg = voice.rg
  const smoothFast = smoothing(0.012, sampleRate)
  const smoothSlow = smoothing(0.028, sampleRate)
  const tiltCoef = 1 - Math.exp(-TAU * cfg.tiltHz / sampleRate)

  const notes = plan.notes
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index]
    const noteStart = Math.round(note.startBeat * secondsPerBeat * sampleRate)
    const noteEnd = Math.round((note.startBeat + note.durBeats) * secondsPerBeat * sampleRate)
    const length = Math.max(8, noteEnd - noteStart)
    if (noteStart + offsetSamples >= totalFrames) continue

    const prev = index > 0 ? notes[index - 1] : null
    const next = index + 1 < notes.length ? notes[index + 1] : null
    const contiguousPrev = prev !== null && Math.abs(prev.startBeat + prev.durBeats - note.startBeat) < 1e-6
    const contiguousNext = next !== null && Math.abs(next.startBeat - (note.startBeat + note.durBeats)) < 1e-6
    const entry = note.consonant === null ? null : (CONSONANTS[note.consonant] ?? null)
    const durSec = length / sampleRate

    // Consonant length: nominal, but never more than 45 % of the slot so a short
    // note still has a vowel to sing.
    let consonantSamples = 0
    if (entry !== null) {
      consonantSamples = Math.round((entry.dur ?? 0.08) * sampleRate)
      consonantSamples = Math.min(consonantSamples, Math.floor(length * 0.45), length - Math.round(0.02 * sampleRate))
      consonantSamples = Math.max(0, consonantSamples)
    }

    // Release only when the voice is going to stop: at the end, before a rest,
    // or before a consonant (a consonant starts with the glottis closed).
    const releases = !contiguousNext || (next !== null && next.consonant !== null)
    const attackSec = contiguousPrev && note.consonant === null ? 0 : cfg.attack
    const releaseSec = releases ? Math.min(cfg.release, durSec * 0.4) : 0
    const glideSec = contiguousPrev ? Math.min(cfg.portamento, durSec * 0.35) : 0
    const noteHz = midiToHz(note.midi)
    const prevHz = prev !== null ? midiToHz(prev.midi) : noteHz
    const attackSamples = Math.max(1, Math.round(attackSec * sampleRate))
    const releaseSamples = Math.round(releaseSec * sampleRate)
    const releaseStart = length - releaseSamples
    const glideSamples = Math.max(1, Math.round(glideSec * sampleRate))
    const vowelOnsetSamples = Math.max(1, Math.round(0.006 * sampleRate))
    const murmurRise = Math.max(1, Math.round(0.012 * sampleRate))
    const murmurFall = Math.max(1, Math.round(0.012 * sampleRate))
    const murmurLevel = entry !== null && entry.voiced === true ? (entry.murmur ?? 0) : 0
    const velocity = note.velocity ?? 1

    // Vowel segments: a diphthong is a sequence of targets the formant state
    // glides through, which is exactly how the ear hears a glide.
    const vowelIds = Array.isArray(note.vowels) && note.vowels.length > 0 ? note.vowels : [note.vowel ?? 'a']
    const weights = vowelIds.length === 1
      ? [1]
      : vowelIds.length === 2
        ? [0.4, 0.6]
        : vowelIds.length === 3 ? [0.25, 0.35, 0.4] : vowelIds.map(() => 1 / vowelIds.length)
    const vowelSpan = length - consonantSamples
    const segments = []
    let weightSum = 0
    for (let k = 0; k < vowelIds.length; k += 1) weightSum += weights[k]
    let cursor = consonantSamples
    for (let k = 0; k < vowelIds.length; k += 1) {
      const start = cursor
      const end = k === vowelIds.length - 1 ? length : Math.round(consonantSamples + vowelSpan * (weights.slice(0, k + 1).reduce((a, b) => a + b, 0) / weightSum))
      segments.push({ start, end: Math.max(start + 1, end), target: vowelTarget(vowelIds[k], cfg.formantScale) })
      cursor = end
    }

    const consonantSound = entry === null
      ? null
      : consonantTarget(entry)
    if (consonantSound !== null) {
      consonantSound.f = consonantSound.f.map((f) => f * cfg.formantScale)
    }

    // Start the formant state somewhere sensible: at the consonant locus when
    // there is one (the vowel then glides out of it), otherwise from the first
    // vowel when the note starts fresh.
    if (consonantSound !== null) {
      for (let k = 0; k < 4; k += 1) {
        voice.f[k] = consonantSound.f[k]
        voice.bw[k] = consonantSound.bw[k]
        voice.g[k] = consonantSound.g[k]
      }
      voice.nasal = consonantSound.nasal
    } else if (!contiguousPrev) {
      const first = segments[0].target
      for (let k = 0; k < 4; k += 1) {
        voice.f[k] = first.f[k]
        voice.bw[k] = first.bw[k]
        voice.g[k] = first.g[k]
      }
      voice.nasal = first.nasal
    }

    // Consonant noise is its own buffer. It carries the same velocity as the
    // voice: scaling only the voiced path made a soft note keep a full-level
    // consonant, so the syllable got *noisier* as the note got quieter.
    if (entry !== null && consonantSamples > 0) {
      const noise = renderConsonantNoise(entry, segments[0].target.f[1], consonantSamples, sampleRate, rand)
      addInto(master, noise, noteStart + offsetSamples, velocity)
    }

    let targetIndex = 0
    const writeLimit = Math.min(length, totalFrames - noteStart - offsetSamples)
    const startOffset = noteStart + offsetSamples

    for (let i = 0; i < writeLimit; i += 1) {
      // ---- control block: formants, f0 -----------------------------------
      if ((i & (CONTROL_BLOCK - 1)) === 0) {
        while (targetIndex < segments.length - 1 && i >= segments[targetIndex].end) targetIndex += 1
        const inConsonant = i < consonantSamples && consonantSound !== null
        const target = inConsonant ? consonantSound : segments[targetIndex].target
        const fastEnough = inConsonant || i - consonantSamples < 0.05 * sampleRate
        const alpha = fastEnough ? smoothFast : smoothSlow
        for (let k = 0; k < 4; k += 1) {
          voice.f[k] += (target.f[k] - voice.f[k]) * alpha
          voice.bw[k] += (target.bw[k] - voice.bw[k]) * alpha
          voice.g[k] += (target.g[k] - voice.g[k]) * alpha
          setResonator(rc, k, voice.f[k], voice.bw[k], sampleRate)
          rg[k] = voice.g[k]
        }
        voice.nasal += (target.nasal - voice.nasal) * alpha
        setResonator(rc, 4, 250 * cfg.formantScale, 110, sampleRate)
        rg[4] = voice.nasal * 0.9
        // Breath is a wide-band whisper riding the first two formants; narrow
        // resonators would whistle, so its bandwidths are widened.
        setResonator(rc, 5, voice.f[0], voice.bw[0] * 3.5, sampleRate)
        setResonator(rc, 6, voice.f[1], voice.bw[1] * 3.0, sampleRate)

        // f0 with portamento, then vibrato with a delayed onset.
        const t = i / sampleRate
        let f0 = noteHz
        if (glideSec > 0 && i < glideSamples) {
          const p = i / glideSamples
          f0 = prevHz + (noteHz - prevHz) * (p * p * (3 - 2 * p))
        }
        const depthProgress = cfg.vibratoDepthCents > 0
          ? clamp((t - cfg.vibratoDelay) / cfg.vibratoRamp, 0, 1)
          : 0
        if (depthProgress > 0) {
          voice.vibPhase += TAU * cfg.vibratoRate * CONTROL_BLOCK / sampleRate
          if (voice.vibPhase > TAU) voice.vibPhase -= TAU
          const cents = cfg.vibratoDepthCents * depthProgress * Math.sin(voice.vibPhase)
          f0 *= 1 + cents * CENTS_RATIO * (1 + cents * CENTS_RATIO * 0.5)
        }
        voice.f0 = f0
        if (pitchTrack !== null) {
          const frame = Math.floor((startOffset + i) / frameStep)
          if (frame >= 0 && frame < pitchTrack.length) pitchTrack[frame] = f0
        }
      }

      // ---- amplitude: consonant murmur, vowel onset, attack, release -------
      let amp
      if (i < consonantSamples) {
        if (murmurLevel > 0) {
          let shape = 1
          if (i < murmurRise) {
            const p = i / murmurRise
            shape = p * p * (3 - 2 * p)
          }
          const remain = consonantSamples - i
          if (remain < murmurFall) {
            const p = remain / murmurFall
            shape *= p * p
          }
          amp = murmurLevel * shape
        } else {
          amp = 0
        }
      } else if (consonantSamples > 0) {
        const p = Math.min(1, (i - consonantSamples) / vowelOnsetSamples)
        amp = p * p * (3 - 2 * p)
      } else {
        amp = 1
      }
      if (i < attackSamples) {
        const p = i / attackSamples
        amp *= p * p * (3 - 2 * p)
      }
      if (releaseSamples > 0 && i > releaseStart) {
        const p = (length - i) / releaseSamples
        amp *= p * p
      }
      amp *= velocity

      // ---- glottal source --------------------------------------------------
      const f0 = voice.f0 ?? noteHz
      let inc = f0 * voice.jitter / sampleRate
      voice.phase += inc
      if (voice.phase >= 1) {
        voice.phase -= 1
        // Jitter and shimmer change once per glottal cycle, which is where the
        // real irregularity lives.
        voice.jitter = 1 + (rand() * 2 - 1) * cfg.jitter
        voice.shimmer = 1 + (rand() * 2 - 1) * cfg.shimmer
        inc = f0 * voice.jitter / sampleRate
      }
      const phase = voice.phase
      let saw = 2 * phase - 1
      // polyBLEP: band-limit the wrap instead of letting it alias
      if (phase < inc) {
        const x = phase / inc
        saw -= x + x - x * x - 1
      } else if (phase > 1 - inc) {
        const x = (phase - 1) / inc
        saw -= x * x + x + x + 1
      }
      saw *= voice.shimmer * 0.5
      voice.tilt += (saw - voice.tilt) * tiltCoef
      const source = voice.tilt

      // ---- formant bank (bandpass resonators, unit gain at centre) ----------
      let sum = 0
      for (let k = 0; k < 4; k += 1) {
        const slot = k * 4
        const y = rc[k * 3] * (source - rs[slot + 1]) + rc[k * 3 + 1] * rs[slot + 2] + rc[k * 3 + 2] * rs[slot + 3]
        rs[slot + 1] = rs[slot]
        rs[slot] = source
        rs[slot + 3] = rs[slot + 2]
        rs[slot + 2] = y
        sum += y * rg[k]
      }
      {
        const y = rc[12] * (source - rs[17]) + rc[13] * rs[18] + rc[14] * rs[19]
        rs[17] = rs[16]
        rs[16] = source
        rs[19] = rs[18]
        rs[18] = y
        sum += y * rg[4]
      }

      // ---- breath noise, gated by voicing ---------------------------------
      if (cfg.breath > 0 && amp > 0.001) {
        const white = rand() * 2 - 1
        {
          const slot = 20
          const y = rc[15] * (white - rs[slot + 1]) + rc[16] * rs[slot + 2] + rc[17] * rs[slot + 3]
          rs[slot + 1] = rs[slot]
          rs[slot] = white
          rs[slot + 3] = rs[slot + 2]
          rs[slot + 2] = y
          sum += y * 0.9 * cfg.breath * amp * 0.35
        }
        {
          const slot = 24
          const y = rc[18] * (white - rs[slot + 1]) + rc[19] * rs[slot + 2] + rc[20] * rs[slot + 3]
          rs[slot + 1] = rs[slot]
          rs[slot] = white
          rs[slot + 3] = rs[slot + 2]
          rs[slot + 2] = y
          sum += y * 1.2 * cfg.breath * amp * 0.35
        }
      }

      master[startOffset + i] += sum * amp * gain
    }
  }
}

/**
 * Render a plan to samples.
 *
 * Layers: one base voice, plus (for the `choir` preset) two detuned siblings,
 * plus an optional harmony voice a third/fifth/octave above. Everything is
 * mixed, DC-blocked, peak-normalised to -1 dBFS and soft-limited.
 *
 * @param {object} plan - output of {@link singPlan} (or any object with notes).
 * @param {object} [options]
 * @param {string} [options.voice] - alto | bass | child | breathy | choir.
 * @param {number} [options.vibrato] - 0..1; 1 is roughly ±55 cents.
 * @param {number} [options.breath] - 0..1 aspiration amount.
 * @param {number} [options.vibratoRate] - Hz, default 5.4.
 * @param {'third'|'fifth'|'octave'} [options.harmony] - add a harmony voice.
 * @param {number} [options.seed] - deterministic variation seed.
 * @param {number} [options.sampleRate] - default 44100.
 * @returns {{ samples: Float32Array, sampleRate: number, syllableTimings: {text:string,start:number,end:number,vowel:string,consonant:string|null,vowelStart:number}[], pitchTrack: {frameRate:number,hz:Float32Array}, bpm:number, warnings:string[] }}
 */
export function renderSing (plan, options = {}) {
  // A plan from `singPlan` always carries startBeat/durBeats. Anything else that
  // looks like a note list is re-planned here, so a caller cannot hand the engine
  // a shape that renders as NaN.
  const usable = plan !== null && typeof plan === 'object' && Array.isArray(plan.notes) &&
    plan.notes.length > 0 && plan.notes.every((note) => Number.isFinite(note?.startBeat) && Number.isFinite(note?.durBeats) && Number.isFinite(note?.midi))
  const input = usable ? plan : singPlan(plan)
  const opts = options !== null && typeof options === 'object' ? options : {}
  const sampleRate = clamp(Math.round(finiteOr(opts.sampleRate, 44100)), 8000, 96000)
  const cfg = ledger(opts)
  const seed = Math.round(finiteOr(opts.seed, 1)) >>> 0
  const totalSeconds = clamp(finiteOr(input.totalSeconds, 1), 0.02, MAX_SECONDS)
  const frames = Math.max(16, Math.round(totalSeconds * sampleRate))
  const master = new Float32Array(frames)
  const secondsPerBeat = 60 / finiteOr(input.bpm, 96)
  const pitchHz = new Float32Array(Math.ceil(totalSeconds * PITCH_TRACK_RATE) + 1)

  const layers = []
  if (cfg.voices > 1) {
    for (let v = 0; v < cfg.voices; v += 1) {
      const spread = v - (cfg.voices - 1) / 2
      layers.push({
        midiShift: 0,
        cents: spread * cfg.detuneCents,
        // Offsets are non-negative on purpose: a negative write offset would
        // truncate the first note of the first voice and misalign its consonant.
        offsetSamples: Math.round(v * 0.006 * sampleRate),
        gain: 1,
        seedShift: 104729 * (v + 1),
        // The pitch track comes from the undetuned middle voice, so it reads the
        // written melody rather than a layer's detune.
        capture: Math.abs(spread) < 1e-9
      })
    }
  } else {
    layers.push({ midiShift: 0, cents: 0, offsetSamples: 0, gain: 1, seedShift: 0, capture: true })
  }
  const harmony = String(opts.harmony ?? '')
  const HARMONY_SHIFT = { third: 4, fifth: 7, octave: 12 }
  if (Object.prototype.hasOwnProperty.call(HARMONY_SHIFT, harmony)) {
    layers.push({
      midiShift: HARMONY_SHIFT[harmony],
      cents: harmony === 'octave' ? 0 : 2,
      offsetSamples: Math.round(0.004 * sampleRate),
      gain: 0.55,
      seedShift: 7919 * 11,
      capture: false
    })
  }

  for (const layer of layers) {
    const rand = makeRng(((seed ^ layer.seedShift) + 0x9E3779B9) >>> 0)
    const layerPlan = layer.midiShift === 0 && layer.cents === 0
      ? input
      : transposePlan(input, layer.midiShift, layer.cents)
    // Formant scale varies slightly between choir voices; that small spread is
    // most of what makes a section sound like people rather than one person.
    const layerCfg = layer.seedShift === 0
      ? cfg
      : { ...cfg, formantScale: cfg.formantScale * (1 + ((layer.seedShift / 104729) - 1) * 0.012) }
    renderLayer(master, layerPlan, sampleRate, layerCfg, rand, layer.gain, layer.offsetSamples,
      layer.capture ? pitchHz : null)
  }

  let samples = master
  if (cfg.space > 0.02) samples = reverb(samples, sampleRate, cfg.space, 0.55)
  dcBlock(samples, sampleRate)
  normalizePeak(samples, -1)
  softLimit(samples)

  const syllableTimings = []
  for (const note of input.notes) {
    const startSample = Math.round(note.startBeat * secondsPerBeat * sampleRate)
    const endSample = Math.round((note.startBeat + note.durBeats) * secondsPerBeat * sampleRate)
    const length = Math.max(8, endSample - startSample)
    const entry = note.consonant === null ? null : (CONSONANTS[note.consonant] ?? null)
    let consonantSamples = 0
    if (entry !== null) {
      consonantSamples = Math.round((entry.dur ?? 0.08) * sampleRate)
      consonantSamples = Math.min(consonantSamples, Math.floor(length * 0.45), length - Math.round(0.02 * sampleRate))
      consonantSamples = Math.max(0, consonantSamples)
    }
    const round3 = (value) => Number(value.toFixed(3))
    syllableTimings.push({
      text: note.syllable,
      start: round3(Math.min(startSample, frames) / sampleRate),
      end: round3(Math.min(endSample, frames) / sampleRate),
      vowel: note.vowel,
      consonant: note.consonant,
      vowelStart: round3(Math.min(startSample + consonantSamples, frames) / sampleRate)
    })
  }

  return {
    samples,
    sampleRate,
    syllableTimings,
    pitchTrack: { frameRate: PITCH_TRACK_RATE, hz: pitchHz },
    bpm: finiteOr(input.bpm, 96),
    warnings: Array.isArray(input.warnings) ? input.warnings.slice() : []
  }
}

/* ------------------------------------------------------------- measurement -- */

/**
 * Fundamental frequency of one window by normalised autocorrelation.
 *
 * The peak is chosen as the *first* local maximum close to the global one, which
 * is what stops a strong formant (or a missing fundamental) from reporting an
 * octave error. Sub-sample resolution comes from a parabolic fit around the peak.
 *
 * @param {Float32Array} samples - mono signal.
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {number} [options.from] - window start in seconds.
 * @param {number} [options.to] - window end in seconds.
 * @param {number} [options.minHz] - default 60.
 * @param {number} [options.maxHz] - default 1200.
 * @returns {{ hz: number, clarity: number, rms: number }} hz is 0 when unclear.
 */
export function measurePitch (samples, sampleRate, options = {}) {
  const total = samples.length
  const from = clamp(Math.round(finiteOr(options.from, 0) * sampleRate), 0, Math.max(0, total - 64))
  const to = clamp(Math.round(finiteOr(options.to, total / sampleRate) * sampleRate), from + 64, total)
  const minHz = clamp(finiteOr(options.minHz, 60), 20, sampleRate / 8)
  const maxHz = clamp(finiteOr(options.maxHz, 1200), minHz * 1.05, sampleRate / 4)
  return pitchAt(samples, from, to - from, sampleRate, minHz, maxHz)
}

/** Autocorrelation pitch over an explicit sample range (no allocation). */
function pitchAt (samples, start, length, sampleRate, minHz, maxHz) {
  const lagMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const lagMax = Math.min(length - 2, Math.ceil(sampleRate / minHz))
  if (length < 64 || lagMax <= lagMin + 2) return { hz: 0, clarity: 0, rms: 0 }

  let mean = 0
  for (let i = 0; i < length; i += 1) mean += samples[start + i]
  mean /= length
  let energy = 0
  for (let i = 0; i < length; i += 1) {
    const value = samples[start + i] - mean
    energy += value * value
  }
  const rms = Math.sqrt(energy / length)
  if (rms < 1e-5) return { hz: 0, clarity: 0, rms }

  const count = lagMax - lagMin + 1
  const curve = new Float32Array(count)
  let best = 0
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let dot = 0
    let e0 = 0
    let e1 = 0
    const limit = length - lag
    for (let i = 0; i < limit; i += 1) {
      const a = samples[start + i] - mean
      const b = samples[start + i + lag] - mean
      dot += a * b
      e0 += a * a
      e1 += b * b
    }
    const norm = Math.sqrt(e0 * e1)
    const value = norm > 1e-12 ? dot / norm : 0
    curve[lag - lagMin] = value
    if (value > best) best = value
  }
  if (best <= 0.05) return { hz: 0, clarity: best, rms }

  let chosen = -1
  const floor = best * 0.9
  for (let k = 1; k < count - 1; k += 1) {
    if (curve[k] >= floor && curve[k] >= curve[k - 1] && curve[k] >= curve[k + 1]) {
      chosen = k
      break
    }
  }
  if (chosen < 0) {
    for (let k = 0; k < count; k += 1) if (curve[k] === best) { chosen = k; break }
  }
  let lag = lagMin + chosen
  if (chosen > 0 && chosen < count - 1) {
    const y0 = curve[chosen - 1]
    const y1 = curve[chosen]
    const y2 = curve[chosen + 1]
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-9) lag += 0.5 * (y0 - y2) / denom
  }
  const hz = sampleRate / lag
  return { hz: hz >= minHz * 0.95 && hz <= maxHz * 1.05 ? hz : 0, clarity: curve[chosen], rms }
}

/**
 * Frame-by-frame fundamental track, decimated to keep it cheap and smoothed
 * enough to read visually: the intended use is vibrato analysis, lip-sync and
 * "did the pitch land where the plan said".
 *
 * @param {Float32Array} samples - mono signal.
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {number} [options.frameSeconds] - analysis window, default 0.03.
 * @param {number} [options.hopSeconds] - frame spacing, default 0.005.
 * @param {number} [options.minHz] - default 60.
 * @param {number} [options.maxHz] - default 1200.
 * @returns {{ frameRate: number, hz: Float32Array, frameSeconds: number }} 0 = unvoiced.
 */
export function trackPitch (samples, sampleRate, options = {}) {
  const decimation = Math.max(1, Math.round(sampleRate / clamp(finiteOr(options.decimatedRate, 8000), 2000, 24000)))
  const rate = sampleRate / decimation
  const low = new Float32Array(Math.floor(samples.length / decimation))
  for (let i = 0; i < low.length; i += 1) {
    let sum = 0
    for (let k = 0; k < decimation; k += 1) sum += samples[i * decimation + k]
    low[i] = sum / decimation
  }
  const minHz = clamp(finiteOr(options.minHz, 60), 20, rate / 8)
  const maxHz = clamp(finiteOr(options.maxHz, 1200), minHz * 1.05, rate / 4)
  const frame = Math.max(64, Math.round(clamp(finiteOr(options.frameSeconds, 0.03), 0.008, 0.2) * rate))
  const hop = Math.max(1, Math.round(clamp(finiteOr(options.hopSeconds, 0.005), 0.0005, 0.1) * rate))
  const frames = low.length > frame ? Math.floor((low.length - frame) / hop) + 1 : 0
  const hz = new Float32Array(Math.max(1, frames))
  for (let f = 0; f < frames; f += 1) {
    const result = pitchAt(low, f * hop, frame, rate, minHz, maxHz)
    hz[f] = result.clarity > 0.45 && result.rms > 5e-4 ? Number(result.hz.toFixed(2)) : 0
  }
  return { frameRate: rate / hop, hz, frameSeconds: frame / rate }
}
