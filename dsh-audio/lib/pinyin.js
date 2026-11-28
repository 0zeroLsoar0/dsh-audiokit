/**
 * Pinyin knowledge: the syllable tables and parsers shared by the mouth track.
 *
 * This module answers one question — "what sounds are in this written syllable"
 * — and nothing else. It renders no audio and knows no voice: `lib/mouth.js`
 * turns the ids below into visemes, and `lib/tools-sampler.js` reads pitch names
 * and compact melody strings. The tables live here, in one place, so the mouth
 * cannot drift away from the ids it switches on.
 *
 * What it carries:
 *   - `VOWELS`: every vowel id `parseSyllable` can emit, with the formant
 *     numbers that give each one its character. `lib/mouth.js` falls back to
 *     F1/F2 geometry for an id without an explicit viseme, so the numbers are
 *     part of the contract rather than decoration.
 *   - `CONSONANTS`: the pinyin initials. The mouth consumes `voiced` and `dur`;
 *     the rest of each entry (burst/noise/locus details) documents the
 *     articulation and is kept with the table.
 *   - `parseSyllable` / `primaryVowel`: longest-match romanization with no
 *     dictionary. They never throw — a model will eventually pass something
 *     strange, and a plausible syllable is worth more than an exception.
 *   - `noteToMidi` / `midiToHz` / `parseMelody`: the small pitch vocabulary the
 *     sampler tool reads (`"C4:1 E4:1.5 r:1"`).
 */

import { clamp, dbToGain } from './dsp.js'

/* ------------------------------------------------------------------ vowels -- */

/**
 * Oral vowel formants (adult neutral tract, Hz) and resonator bandwidths.
 * `db` is the formant's relative peak gain: a vocal tract has roughly equal peak
 * gain at every formant, so these stay close to 0 dB and the natural downward
 * spectral slope comes from the glottal source instead. The small per-vowel
 * deviations are the formant-balance character (F2 of /i/ is strong, F3 of /a/
 * is not).
 *
 * Numbers are Mandarin-centric adult values (F1/F2/F3 of [a ɤ i o u y ɨ ɚ]),
 * not a generic IPA table: pinyin 'e' is [ɤ] (back, F2 ~1300) and not the front
 * [e] of English. Frontness the id alone cannot express — [ɛ] in ie/üe, [e] in
 * ei, the retroflex [ɻ̩] of shi — is a property of the syllable context, which is
 * why the parser keeps the surrounding letters rather than adding new ids.
 */
const ORAL_VOWELS = {
  // a: open central — the loudest, most stable test vowel
  a: { f: [700, 1220, 2600, 3400], bw: [80, 90, 130, 160], db: [0, -2, -6, -10] },
  // e: Mandarin [ɤ], back unrounded. F2 1300 is what separates "he" from "hi".
  e: { f: [520, 1300, 2500, 3300], bw: [70, 95, 130, 160], db: [0, -2, -6, -10] },
  i: { f: [290, 2300, 3000, 3500], bw: [60, 95, 140, 170], db: [0, -1, -5, -9] },
  // o: rounded back, F1/F2 deliberately close (they merge in a real /o/ too)
  o: { f: [470, 810, 2500, 3400], bw: [70, 85, 130, 160], db: [0, -1, -6, -10] },
  u: { f: [320, 780, 2300, 3200], bw: [65, 85, 130, 160], db: [0, -1, -6, -10] },
  // ü (Mandarin 'u' after j/q/x/y): front rounded — low F1, front F2
  v: { f: [300, 1850, 2300, 3300], bw: [60, 95, 140, 170], db: [0, -2, -6, -10] },
  // apical [ɨ] of zi/ci/si — not [i]; the retroflex version (zhi/chi/shi/ri)
  // is resolved from the initial, see `parseSyllable`.
  i0: { f: [400, 1400, 2400, 3300], bw: [80, 110, 150, 180], db: [0, -3, -7, -11] },
  // er (儿) [ɚ]: rhotic, F3 collapses onto F2 — its own entry, not an e tweak
  er: { f: [500, 1380, 1700, 3300], bw: [80, 110, 170, 190], db: [0, -3, -8, -11] }
}

/**
 * Formant level compensation: `(Fk / F1)^FORMANT_PREEMPHASIS`, applied to the
 * stored gains so they stay comparable across vowels.
 *
 * A parallel formant bank driven by a sawtooth inherits the source's -6 dB/oct
 * slope, so F2 of /i/ would land 24 dB below F1 — measured, not guessed. Two
 * vowels whose only difference is F2 (i/u: 2300 vs 780 Hz) then sound alike,
 * which is exactly "I cannot hear what is being said". Tilting the *gains*
 * instead of the source keeps F1 anchored while bringing F2/F3 into the audible
 * balance, and F1 is still the peak of every vowel. 0.6 is ~3.6 dB/octave.
 */
const FORMANT_PREEMPHASIS = 0.6

/**
 * Mandarin nasal finals are base vowels plus a velar/alveolar murmur, so they
 * are generated from the oral entries instead of duplicated: lower F2 a little,
 * widen F1, and drive the 250 Hz nasal pole. The tweaks follow the actual final:
 * 'un' is [uən] (schwa nucleus, F2 well above [u]) and 'ong' is [ʊŋ].
 */
const NASAL_VOWELS = [
  ['an', 'a', { f2: 0.95, nasal: 0.6, bw1: 1.4 }],
  ['en', 'e', { f1: 1.02, f2: 1.05, nasal: 0.55, bw1: 1.4 }],
  ['in', 'i', { f2: 0.97, nasal: 0.5, bw1: 1.4 }],
  ['un', 'u', { f1: 1.15, f2: 1.35, nasal: 0.6, bw1: 1.5 }],
  ['vn', 'v', { f2: 0.97, nasal: 0.5, bw1: 1.4 }],
  ['ang', 'a', { f2: 0.86, nasal: 0.8, bw1: 1.5, f1: 1.02 }],
  ['eng', 'e', { f2: 0.95, nasal: 0.8, bw1: 1.5 }],
  ['ing', 'i', { f2: 0.9, nasal: 0.7, bw1: 1.5 }],
  ['ong', 'o', { f1: 1.05, f2: 1.0, nasal: 0.85, bw1: 1.6 }]
]

function makeVowel (id, f, bw, db, extra = {}) {
  const lift = (index) => dbToGain(db[index]) * Math.pow(f[index] / f[0], FORMANT_PREEMPHASIS)
  return {
    id,
    f1: f[0], f2: f[1], f3: f[2], f4: f[3],
    bw1: bw[0], bw2: bw[1], bw3: bw[2], bw4: bw[3],
    a1: lift(0), a2: lift(1), a3: lift(2), a4: lift(3),
    nasal: 0,
    ...extra
  }
}

/** Every vowel id `parseSyllable` can emit, keyed by id. */
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
 * Mandarin initials, one entry per pinyin letter group.
 *
 * `lib/mouth.js` consumes two fields — `voiced` (whether the glottal source runs
 * during the consonant) and `dur` (nominal length in seconds) — and falls back to
 * an 85 ms default for an id it does not know. The remaining fields describe the
 * articulation for the other classes (burst, noise band, locus, formant
 * transition) and are kept here as the reference description of each initial;
 * the mouth track does not read them.
 *
 *   class      plosive | fricative | affricate | nasal | liquid | semivowel
 *   voiced     whether the glottal source runs during the consonant (a murmur)
 *   murmur     murmur level, linear, relative to the vowel's amplitude (0 = silent)
 *   dur        nominal length in seconds
 *   closure    seconds of stop closure before the release burst
 *   burst      release burst: peak level in dB, `dur`, `q`, `center` Hz
 *              (0 = derive from the following vowel's F2)
 *   aspiration frication after an aspirated stop: RMS level dB relative to the
 *              vowel, and `dur`; shaped by the following vowel's formants
 *   noise      steady frication: center Hz, q, RMS level dB relative to the
 *              vowel, `hp` corner, and optional `wide` secondary band (offset dB)
 *   locus      formant target the vowel starts from (locus theory: the transition
 *              into the vowel is most of what makes a consonant readable)
 *   transitionMs / durRangeMs / levelRangeDb / centroidRangeHz
 *              the transition length and the ranges the removed singing engine
 *              measured for this consonant. Kept as phonetic reference.
 */
export const CONSONANTS = {
  // --- plosives -------------------------------------------------------
  // Voiced unaspirated: a quiet voice bar through the closure, then a burst.
  b: { class: 'plosive', voiced: true, dur: 0.085, murmur: 0.05, closure: 0.05, burst: { center: 900, q: 0.8, dur: 0.012, levelDb: -5 }, locus: [280, 900, 2200, 3300], transitionMs: 55, durRangeMs: [78, 92], levelRangeDb: [-20, -6], centroidRangeHz: [700, 3000] },
  d: { class: 'plosive', voiced: true, dur: 0.08, murmur: 0.05, closure: 0.045, burst: { center: 2800, q: 0.9, dur: 0.01, levelDb: -5 }, locus: [280, 1700, 2600, 3400], transitionMs: 55, durRangeMs: [73, 87], levelRangeDb: [-20, -6], centroidRangeHz: [1800, 5000] },
  g: { class: 'plosive', voiced: true, dur: 0.085, murmur: 0.05, closure: 0.05, burst: { center: 1800, q: 1.0, dur: 0.011, levelDb: -5 }, locus: [280, 2000, 2500, 3300], transitionMs: 55, durRangeMs: [78, 92], levelRangeDb: [-20, -6], centroidRangeHz: [1200, 4000] },
  // Voiceless aspirated: closure, burst, then vowel-shaped aspiration. The
  // aspiration carries the following vowel's formants — that is the difference
  // between "pa" and "ta" once the 10 ms burst is over.
  p: { class: 'plosive', voiced: false, dur: 0.11, closure: 0.045, burst: { center: 900, q: 0.8, dur: 0.012, levelDb: -4 }, aspiration: { dur: 0.05, levelDb: -12 }, locus: [280, 900, 2200, 3300], transitionMs: 50, durRangeMs: [100, 120], levelRangeDb: [-16, -4], centroidRangeHz: [1200, 5000] },
  t: { class: 'plosive', voiced: false, dur: 0.105, closure: 0.04, burst: { center: 2800, q: 0.9, dur: 0.01, levelDb: -4 }, aspiration: { dur: 0.05, levelDb: -12 }, locus: [280, 1700, 2600, 3400], transitionMs: 50, durRangeMs: [95, 115], levelRangeDb: [-16, -4], centroidRangeHz: [1800, 6000] },
  k: { class: 'plosive', voiced: false, dur: 0.11, closure: 0.045, burst: { center: 1800, q: 1.0, dur: 0.011, levelDb: -4 }, aspiration: { dur: 0.05, levelDb: -12 }, locus: [280, 2000, 2500, 3300], transitionMs: 50, durRangeMs: [100, 120], levelRangeDb: [-16, -4], centroidRangeHz: [1300, 4500] },

  // --- fricatives -----------------------------------------------------
  s: { class: 'fricative', voiced: false, dur: 0.13, noise: { center: 5600, q: 1.0, levelDb: -7, hp: 3000 }, locus: [300, 1600, 2800, 3500], transitionMs: 45, durRangeMs: [120, 145], levelRangeDb: [-13, -3], centroidRangeHz: [4200, 8500] },
  sh: { class: 'fricative', voiced: false, dur: 0.135, noise: { center: 3100, q: 1.2, levelDb: -7, hp: 1700, wide: { center: 4800, offsetDb: -8 } }, locus: [300, 1800, 2400, 3300], transitionMs: 45, durRangeMs: [122, 148], levelRangeDb: [-14, -4], centroidRangeHz: [2200, 6000] },
  x: { class: 'fricative', voiced: false, dur: 0.13, noise: { center: 4300, q: 1.1, levelDb: -7, hp: 2200 }, locus: [300, 2200, 3000, 3500], transitionMs: 45, durRangeMs: [120, 145], levelRangeDb: [-13, -3], centroidRangeHz: [3000, 7000] },
  f: { class: 'fricative', voiced: false, dur: 0.115, noise: { center: 2500, q: 0.5, levelDb: -13, hp: 700, wide: { center: 5200, offsetDb: -14 } }, locus: [300, 1200, 2400, 3300], transitionMs: 45, durRangeMs: [103, 128], levelRangeDb: [-20, -8], centroidRangeHz: [1200, 5000] },
  // h is the following vowel whispered: vowel-shaped noise, no fixed band.
  h: { class: 'fricative', voiced: false, dur: 0.115, noise: { center: 0, q: 1.1, levelDb: -12, hp: 350 }, locus: [300, 1200, 2400, 3300], transitionMs: 60, durRangeMs: [103, 128], levelRangeDb: [-18, -6], centroidRangeHz: [400, 5000] },

  // --- affricates: short closure, a burst, then frication -------------
  z: { class: 'affricate', voiced: false, dur: 0.125, closure: 0.028, burst: { center: 5600, q: 1.0, dur: 0.008, levelDb: -6 }, noise: { center: 5600, q: 1.0, levelDb: -8, hp: 3000 }, locus: [300, 1600, 2800, 3500], transitionMs: 45, durRangeMs: [115, 140], levelRangeDb: [-13, -3], centroidRangeHz: [4200, 8500] },
  zh: { class: 'affricate', voiced: false, dur: 0.13, closure: 0.028, burst: { center: 3100, q: 1.2, dur: 0.008, levelDb: -6 }, noise: { center: 3100, q: 1.2, levelDb: -8, hp: 1700 }, locus: [300, 1800, 2400, 3300], transitionMs: 45, durRangeMs: [120, 145], levelRangeDb: [-13, -3], centroidRangeHz: [2200, 6000] },
  j: { class: 'affricate', voiced: false, dur: 0.125, closure: 0.028, burst: { center: 4300, q: 1.1, dur: 0.008, levelDb: -6 }, noise: { center: 4300, q: 1.1, levelDb: -8, hp: 2200 }, locus: [300, 2200, 3000, 3500], transitionMs: 45, durRangeMs: [115, 140], levelRangeDb: [-13, -3], centroidRangeHz: [3000, 7000] },
  c: { class: 'affricate', voiced: false, dur: 0.14, closure: 0.026, burst: { center: 5600, q: 1.0, dur: 0.008, levelDb: -5 }, aspiration: { dur: 0.022, levelDb: -12 }, noise: { center: 5600, q: 1.0, levelDb: -8, hp: 3000 }, locus: [300, 1600, 2800, 3500], transitionMs: 45, durRangeMs: [130, 155], levelRangeDb: [-13, -2], centroidRangeHz: [4200, 8500] },
  ch: { class: 'affricate', voiced: false, dur: 0.145, closure: 0.026, burst: { center: 3100, q: 1.2, dur: 0.008, levelDb: -5 }, aspiration: { dur: 0.022, levelDb: -12 }, noise: { center: 3100, q: 1.2, levelDb: -8, hp: 1700 }, locus: [300, 1800, 2400, 3300], transitionMs: 45, durRangeMs: [135, 160], levelRangeDb: [-13, -2], centroidRangeHz: [2200, 6000] },
  q: { class: 'affricate', voiced: false, dur: 0.14, closure: 0.026, burst: { center: 4300, q: 1.1, dur: 0.008, levelDb: -5 }, aspiration: { dur: 0.022, levelDb: -12 }, noise: { center: 4300, q: 1.1, levelDb: -8, hp: 2200 }, locus: [300, 2200, 3000, 3500], transitionMs: 45, durRangeMs: [130, 155], levelRangeDb: [-13, -2], centroidRangeHz: [3000, 7000] },

  // --- nasals: voiced murmur through a low nasal pole, plus an F2
  // transition whose direction is the place cue (m low, n mid, ng high) ----
  m: { class: 'nasal', voiced: true, dur: 0.085, murmur: 0.10, nasal: 0.9, locus: [250, 1000, 2200, 3300], transitionMs: 70, durRangeMs: [78, 95], levelRangeDb: [-18, -6], centroidRangeHz: [150, 700] },
  n: { class: 'nasal', voiced: true, dur: 0.075, murmur: 0.09, nasal: 0.85, locus: [250, 1600, 2600, 3400], transitionMs: 65, durRangeMs: [68, 85], levelRangeDb: [-19, -7], centroidRangeHz: [150, 800] },
  ng: { class: 'nasal', voiced: true, dur: 0.08, murmur: 0.08, nasal: 0.8, locus: [250, 2000, 2800, 3500], transitionMs: 65, durRangeMs: [73, 90], levelRangeDb: [-20, -8], centroidRangeHz: [150, 900] },

  // --- liquids --------------------------------------------------------
  l: { class: 'liquid', voiced: true, dur: 0.065, murmur: 0.32, locus: [350, 1100, 2700, 3400], transitionMs: 55, durRangeMs: [58, 75], levelRangeDb: [-15, -3], centroidRangeHz: [250, 1500] },
  r: { class: 'liquid', voiced: true, dur: 0.065, murmur: 0.30, locus: [350, 1300, 1600, 3200], transitionMs: 55, durRangeMs: [58, 75], levelRangeDb: [-16, -3], centroidRangeHz: [250, 1600] },

  // --- semivowels (glides) -------------------------------------------
  y: { class: 'semivowel', voiced: true, dur: 0.06, murmur: 0.34, locus: [280, 2200, 3000, 3500], transitionMs: 70, durRangeMs: [53, 70], levelRangeDb: [-12, -2], centroidRangeHz: [200, 1500] },
  w: { class: 'semivowel', voiced: true, dur: 0.06, murmur: 0.32, locus: [300, 700, 2200, 3200], transitionMs: 70, durRangeMs: [53, 70], levelRangeDb: [-14, -2], centroidRangeHz: [200, 1200] }
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
