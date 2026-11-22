/**
 * Text → mouth: per-frame viseme and jaw aperture from written words.
 *
 * `audio_lipsync` derives a mouth from a voice file, but a lot of animation text
 * is silent: a caption, a typewriter line, a comic panel. This module builds the
 * same frame shape from the words themselves — `{ t, viseme, openness, energy,
 * voiced }` per frame, in the vocabulary and the formatters of `lipsync.js` — so
 * one page drives both tracks with the same code.
 *
 * Why it is built this way:
 *   - The syllable knowledge already ships in `sing.js` (the pinyin initial and
 *     vowel tables, `parseSyllable`), so the mouth is built from the same
 *     phonetics as the singing voice instead of a second, drifting table.
 *   - A viseme vocabulary is discrete: eleven labels cannot represent a blend.
 *     Coarticulation is therefore applied where it is physically visible — jaw
 *     aperture and energy move on a 30-60 ms time constant across every shape
 *     change — while the label itself switches once, and one-frame chatter is
 *     removed.
 *   - Scheduling is musical: one syllable per half beat up to 120 bpm (312 ms at
 *     96 bpm, close to conversational Mandarin), one per beat above it so a fast
 *     cue does not push the mouth past five shapes a second.
 *   - Deterministic: the same request always returns byte-identical frames. No
 *     clock, no randomness, no locale-sensitive formatting.
 *
 * Limitations, stated up front:
 *   - Chinese cannot be romanized here (no dictionary ships with the plugin).
 *     Han characters are mapped one syllable per character from their code point:
 *     the timing and the open/closed rhythm are right, the shapes are not the
 *     real vowels. Pass pinyin ("wo ai ni") for a mouth that says the words.
 *   - Only onsets and nuclei are rendered, because that is all `parseSyllable`
 *     returns; codas are not, so "world" reads as WO rather than WO-R-L-D.
 *   - English spelling is heuristic: the th/sh/ch/ph/wh/kn/wr/ck/qu digraphs are
 *     recognised, but silent letters and irregular spellings still fool it.
 */

import { clamp } from './dsp.js'
import { CONSONANTS, VOWELS, parseSyllable, primaryVowel } from './sing.js'
import { VISEMES, visemeToSrt, visemeToTimeline } from './lipsync.js'

/* ------------------------------------------------------------ vocabulary -- */

/** Output formats, identical to the ones `audio_lipsync` writes. */
export const MOUTH_FORMATS = ['json', 'srt', 'css', 'ae']

/** Performance styles: how much jaw and energy the same line gets. */
export const MOUTH_STYLES = ['neutral', 'excited', 'tired']

/** How `mouthFromText` places syllables; `cues` belongs to `mouthFromTimeline`. */
export const MOUTH_ALIGNMENTS = ['bpm', 'even', 'cues']

/**
 * Jaw aperture per viseme, as a fraction of fully open. These mirror the shape
 * targets `lipsync.js` uses for a sound-driven track so the two tracks look like
 * the same mouth; they live here because they are targets, not measurements.
 */
const APERTURE = {
  AA: 1,
  EH: 0.62,
  EE: 0.42,
  OH: 0.78,
  OO: 0.34,
  MM: 0.05,
  FF: 0.16,
  TH: 0.24,
  SS: 0.14,
  DD: 0.22,
  none: 0
}

/** Target energy per viseme: vowels carry the level, closures drop it. */
const LOUDNESS = {
  AA: 0.95,
  EH: 0.78,
  EE: 0.72,
  OH: 0.86,
  OO: 0.7,
  MM: 0.32,
  FF: 0.38,
  TH: 0.4,
  SS: 0.45,
  DD: 0.4,
  none: 0
}

/** Vowels that open the jaw; matches `isVowelViseme` in `lipsync.js`. */
const OPEN_VISEMES = new Set(['AA', 'EH', 'EE', 'OH', 'OO'])

/** Visemes that never carry voicing, whatever produced them. */
const UNVOICED_VISEMES = new Set(['none', 'FF', 'SS', 'TH'])

/**
 * Pinyin vowel id (as emitted by `parseSyllable`) → viseme. Every id in the
 * `VOWELS` table has an entry, including the nasal finals, which take the shape
 * of their base vowel.
 */
const VOWEL_TARGET = {
  a: 'AA',
  e: 'EH',
  i: 'EE',
  o: 'OH',
  u: 'OO',
  // ü is front-rounded: the lips round like OO while the tongue sits forward
  // like EH. There is no blend label, so the shape is OO and the aperture is
  // the mean of the two (UMLAUT_APERTURE below).
  v: 'OO',
  // apical [ɨ] of zhi/chi/shi/zi/ci/si: close and unrounded
  i0: 'EH',
  an: 'AA',
  en: 'EH',
  in: 'EE',
  un: 'OO',
  vn: 'OO',
  ang: 'AA',
  eng: 'EH',
  ing: 'EE',
  ong: 'OH',
  er: 'EH'
}

/** Vowel ids whose lips are round but whose tongue is front. */
const UMLAUT_VOWELS = new Set(['v', 'vn'])
const UMLAUT_APERTURE = (APERTURE.OO + APERTURE.EH) / 2

/**
 * Pinyin initial (as emitted by `parseSyllable`) → viseme. The table follows
 * place of articulation, which is what is visible:
 *   - bilabial b/p/m close the lips (MM);
 *   - alveolar d/t/n/l, velar g/k and the r/l liquids show a tongue-tip or
 *     tongue-back closure with the lips apart (DD);
 *   - n is both a nasal and an alveolar, and the lips stay apart, so it reads as
 *     DD rather than the labial MM that m/ng get;
 *   - sibilants (s/sh/x and the z/c/zh/ch/j/q affricates) hiss (SS);
 *   - the non-sibilant fricatives f/h sit darker (FF).
 */
const CONSONANT_TARGET = {
  b: 'MM',
  p: 'MM',
  m: 'MM',
  d: 'DD',
  t: 'DD',
  n: 'DD',
  l: 'DD',
  g: 'DD',
  k: 'DD',
  r: 'DD',
  ng: 'MM',
  s: 'SS',
  sh: 'SS',
  x: 'SS',
  z: 'SS',
  c: 'SS',
  zh: 'SS',
  ch: 'SS',
  j: 'SS',
  q: 'SS',
  f: 'FF',
  h: 'FF',
  y: 'EE',
  w: 'OO',
  // English 'th' is not a pinyin initial but is common in captions.
  th: 'TH'
}

/** Fallback consonant timings for initials that are not in `CONSONANTS`. */
const TH_CONSONANT = { dur: 0.1, voiced: false }

/**
 * Style table. `blendMs` is the coarticulation time constant: excited speech
 * transitions in a third of the time a tired mouth does.
 */
const STYLES = {
  neutral: { openness: 1, energy: 1, blendMs: 45 },
  excited: { openness: 1.15, energy: 1.2, blendMs: 30 },
  tired: { openness: 0.72, energy: 0.65, blendMs: 60 }
}

/** Pause lengths, in syllable slots: a comma is half a slot, a full stop one. */
const WEAK_PAUSE = 0.5
const STRONG_PAUSE = 1
/** Rest appended after a line that does not end in punctuation. */
const CLOSING_PAUSE = 0.6

/** Characters that pause the mouth, grouped by how long the silence is. */
const WEAK_PUNCTUATION = ',;:、，；：·'
const STRONG_PUNCTUATION = '.!?。！？…‥'

/**
 * English onsets that `parseSyllable` would otherwise read letter by letter.
 * Pinyin initials (zh, ch, sh) are already in `CONSONANTS`, so the pinyin path
 * is unchanged; these mainly teach the scorer th/ph/wh/kn/wr/ck/qu.
 */
const ONSET_DIGRAPHS = [
  ['th', 'th'],
  ['sh', 'sh'],
  ['ch', 'ch'],
  ['ph', 'f'],
  ['wh', 'w'],
  ['kn', 'n'],
  ['wr', 'r'],
  ['ck', 'k'],
  ['qu', 'k']
]

/**
 * Tone-marked pinyin → the plain letter `parseSyllable` can match. Without this
 * "nǐ" would lose its vowel to the `[^a-z]` strip and fall back to "na".
 */
const TONE_GROUPS = [
  ['āáǎà', 'a'],
  ['ēéěè', 'e'],
  ['īíǐì', 'i'],
  ['ōóǒò', 'o'],
  ['ūúǔù', 'u'],
  ['ǖǘǚǜü', 'v'],
  ['ńňǹ', 'n'],
  ['ḿ', 'm']
]
const TONE_MAP = new Map()
for (const [chars, base] of TONE_GROUPS) for (const char of chars) TONE_MAP.set(char, base)

/** Vowel ids used for text without a romanisation (Han and other scripts). */
const CODE_POINT_VOWELS = ['a', 'e', 'i', 'o', 'u', 'an', 'ang', 'en', 'ong', 'i0']
/** Consonant ids used occasionally by the same deterministic mapping. */
const CODE_POINT_CONSONANTS = ['m', 'n', 's', 'l', 'd', 'h']
/** Letters that count as syllable nuclei when a Latin word is split. */
const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u'])

/* --------------------------------------------------------------- helpers -- */

function finiteOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundTo (value, digits) {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

function styleOf (name) {
  return STYLES[name] ?? STYLES.neutral
}

function apertureOf (viseme) {
  return APERTURE[viseme] ?? 0
}

function loudnessOf (viseme) {
  return LOUDNESS[viseme] ?? 0
}

function isHan (char) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(char)
}

function isLatinLetter (char) {
  return /[A-Za-z\u00c0-\u024f]/.test(char)
}

function isLetterOrDigit (char) {
  return /[\p{L}\p{N}]/u.test(char)
}

/** Most frequent: half a beat is the natural syllable slot, as documented. */
function syllableSeconds (bpm) {
  const beat = 60 / bpm
  const seconds = bpm <= 120 ? beat / 2 : beat * 0.75
  return clamp(seconds, 0.12, 1.5)
}

/* -------------------------------------------------- phonetics from words -- */

/**
 * One syllable for text we cannot romanize, chosen from the code point alone.
 * It is arbitrary by design but stable across runs, platforms and locales, and
 * it never throws: the alternative (refusing Chinese input) would be worse than
 * a mouth that moves in the right rhythm with the wrong vowels.
 *
 * @param {string} char - one code point (Han, kana, Hangul, a digit, ...).
 * @returns {{ consonant: string|null, vowel: string }} pinyin-shaped ids.
 */
function codePointSyllable (char) {
  const code = char.codePointAt(0) ?? 0
  const vowel = CODE_POINT_VOWELS[code % CODE_POINT_VOWELS.length]
  const consonant = code % 3 === 0
    ? CODE_POINT_CONSONANTS[Math.floor(code / 3) % CODE_POINT_CONSONANTS.length]
    : null
  return { consonant, vowel }
}

/**
 * Lower-case a Latin word and fold tone marks and umlauts into letters the
 * pinyin parser can match, then keep only a-z.
 * @param {string} word - raw word.
 * @returns {string} normalised letters, possibly empty.
 */
function normalizeWord (word) {
  let letters = ''
  for (const char of String(word).toLowerCase()) letters += TONE_MAP.get(char) ?? char
  return letters.replace(/[^a-z]/g, '')
}

/**
 * Split a Latin word into syllable chunks around its vowel groups. A single
 * consonant between two nuclei becomes the next onset (o-pen); a cluster splits
 * so only its last consonant is the onset (hel-lo, ex-tra).
 *
 * @param {string} letters - normalised a-z letters.
 * @returns {string[]} one string per syllable, each containing a vowel.
 */
function latinSyllables (letters) {
  const nuclei = []
  for (let index = 0; index < letters.length; index += 1) {
    if (!VOWEL_LETTERS.has(letters[index])) continue
    let end = index + 1
    while (end < letters.length && VOWEL_LETTERS.has(letters[end])) end += 1
    nuclei.push({ start: index, end })
    index = end - 1
  }
  // A final lone 'e' after another nucleus is usually silent in English
  // ("there", "make"); counting it as a nucleus would invent a syllable.
  if (nuclei.length > 1) {
    const last = nuclei[nuclei.length - 1]
    if (last.end === letters.length && last.end - last.start === 1 && letters[last.start] === 'e') {
      nuclei.pop()
    }
  }
  if (nuclei.length <= 1) return letters === '' ? [] : [letters]
  const chunks = []
  let start = 0
  for (let index = 1; index < nuclei.length; index += 1) {
    const gap = nuclei[index].start - nuclei[index - 1].end
    const cut = gap >= 2 ? nuclei[index].start - 1 : nuclei[index].start
    if (cut <= start) continue
    chunks.push(letters.slice(start, cut))
    start = cut
  }
  chunks.push(letters.slice(start))
  return chunks.filter((chunk) => chunk !== '')
}

/**
 * Parse one syllable chunk with the shared pinyin knowledge, after pulling off
 * an English onset digraph the pinyin table does not know.
 * @param {string} chunk - normalised a-z syllable.
 * @returns {{ consonant: string|null, vowels: string[] }} ids from `sing.js`.
 */
function parseChunk (chunk) {
  let rest = chunk
  let consonant = null
  for (const [prefix, key] of ONSET_DIGRAPHS) {
    if (!rest.startsWith(prefix)) continue
    consonant = key
    rest = rest.slice(prefix.length)
    break
  }
  const parsed = parseSyllable(rest)
  return { consonant: consonant ?? parsed.consonant, vowels: parsed.vowels }
}

/**
 * Resolve a pinyin vowel id to its shape. Unknown ids fall back to formant
 * geometry from the imported `VOWELS` table, so a future table entry still gets
 * a plausible shape instead of throwing.
 * @param {string} id - vowel id.
 * @returns {{ viseme: string, aperture: number }} shape target.
 */
function vowelTarget (id) {
  const viseme = VOWEL_TARGET[id]
  if (viseme !== undefined) {
    return { viseme, aperture: UMLAUT_VOWELS.has(id) ? UMLAUT_APERTURE : APERTURE[viseme] }
  }
  const spec = VOWELS[id]
  if (spec === undefined) return { viseme: 'AA', aperture: APERTURE.AA }
  let fallback = 'OH'
  if (spec.f1 >= 600) fallback = 'AA'
  else if (spec.f2 >= 1900) fallback = 'EE'
  else if (spec.f2 >= 1300) fallback = 'EH'
  else if (spec.f1 <= 420 && spec.f2 <= 900) fallback = 'OO'
  return { viseme: fallback, aperture: APERTURE[fallback] }
}

/**
 * Build the internal event for one syllable. Consonant timing and voicing come
 * from the imported `CONSONANTS` table, which is what keeps text and singing on
 * the same phonetics.
 * @param {string|null} consonant - pinyin initial id or null.
 * @param {string} vowelId - pinyin vowel id.
 * @param {string} text - source text, kept for debugging.
 * @returns {object} a `syllable` event.
 */
function syllableFrom (consonant, vowelId, text) {
  const target = vowelTarget(vowelId)
  const spec = consonant === null
    ? null
    : (CONSONANTS[consonant] ?? (consonant === 'th' ? TH_CONSONANT : null))
  return {
    type: 'syllable',
    text,
    consonant,
    consonantViseme: consonant === null ? null : (CONSONANT_TARGET[consonant] ?? 'DD'),
    consonantVoiced: spec !== null && spec.voiced === true,
    consonantSeconds: spec !== null && Number.isFinite(spec.dur) ? spec.dur : 0.085,
    vowelViseme: target.viseme,
    vowelAperture: target.aperture,
    vowelEnergy: loudnessOf(target.viseme)
  }
}

/**
 * One Latin word → its syllables.
 * @param {string} word - raw word.
 * @returns {object[]} syllable events, possibly empty for a word with no letters.
 */
function wordSyllables (word) {
  const letters = normalizeWord(word)
  if (letters === '') return []
  return latinSyllables(letters).map((chunk) => {
    const parsed = parseChunk(chunk)
    return syllableFrom(parsed.consonant, primaryVowel(parsed.vowels), chunk)
  })
}

/**
 * Turn text into mouth events: syllables in order, with weighted pauses for
 * punctuation. Spaces, quotes, brackets and dashes are boundaries but not
 * silences.
 *
 * @param {string} raw - caption, lyric or any text.
 * @returns {{ events: object[], syllables: number, warnings: string[] }}
 */
function encodeText (raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  const events = []
  const warnings = []
  let syllables = 0
  let unromanized = 0
  let word = ''

  const flushWord = () => {
    if (word === '') return
    for (const syllable of wordSyllables(word)) {
      events.push(syllable)
      syllables += 1
    }
    word = ''
  }

  const pushPause = (weight) => {
    const last = events[events.length - 1]
    // "?!" or "..." is one pause in a mouth track, not three.
    if (last !== undefined && last.type === 'pause') {
      last.weight = Math.max(last.weight, weight)
      return
    }
    events.push({ type: 'pause', weight })
  }

  const pushCodePoint = (char) => {
    const syllable = codePointSyllable(char)
    events.push(syllableFrom(syllable.consonant, syllable.vowel, char))
    syllables += 1
    unromanized += 1
  }

  for (const char of text) {
    if (isHan(char)) {
      flushWord()
      pushCodePoint(char)
      continue
    }
    // Tone digits belong to the syllable they follow ("ma1"), a leading number
    // is read as one open/close per digit because there is nothing to romanize.
    if (/[0-9]/.test(char)) {
      if (word !== '') {
        word += char
        continue
      }
      flushWord()
      pushCodePoint(char)
      continue
    }
    if (isLatinLetter(char)) {
      word += char
      continue
    }
    flushWord()
    if (/\s/.test(char)) continue
    if (STRONG_PUNCTUATION.includes(char)) {
      pushPause(STRONG_PAUSE)
      continue
    }
    if (WEAK_PUNCTUATION.includes(char)) {
      pushPause(WEAK_PAUSE)
      continue
    }
    if (isLetterOrDigit(char)) pushCodePoint(char)
    // Everything else (quotes, brackets, dashes) is a shape boundary only.
  }
  flushWord()

  if (unromanized > 0) {
    warnings.push(`${unromanized} character(s) outside Latin script were mapped from their code point, not romanized; pass pinyin for real mouth shapes`)
  }
  return { events, syllables, warnings }
}

/* ------------------------------------------------------------ scheduling -- */

/**
 * Give every event a duration. `bpm` keeps punctuation weighted (a comma is
 * shorter than a full stop); `even` gives every event the same slice, which is
 * what a word-per-shot caption wants.
 *
 * @param {object[]} events - from `encodeText`.
 * @param {{ bpm: number, alignment: string, durationSeconds?: number }} options
 * @returns {{ paced: { event: object, seconds: number }[], duration: number }}
 */
function paceText (events, options) {
  if (events.length === 0) return { paced: [], duration: 0 }
  const slot = syllableSeconds(options.bpm)
  const paced = events.map((event) => ({
    event,
    seconds: event.type === 'pause' ? slot * event.weight : slot
  }))

  // End on a closed mouth: a final punctuation pause already does that, but a
  // line that stops on a syllable would otherwise leave the jaw open.
  const last = paced[paced.length - 1].event
  if (last.type !== 'pause') {
    paced.push({ event: { type: 'pause', weight: CLOSING_PAUSE }, seconds: slot * CLOSING_PAUSE })
  }

  let total = paced.reduce((sum, item) => sum + item.seconds, 0)
  if (options.alignment === 'even') {
    const each = options.durationSeconds !== undefined ? options.durationSeconds / paced.length : slot
    for (const item of paced) item.seconds = each
    total = each * paced.length
  } else if (options.durationSeconds !== undefined) {
    if (total > options.durationSeconds) {
      const scale = options.durationSeconds / total
      for (const item of paced) item.seconds *= scale
      total = options.durationSeconds
    } else if (total < options.durationSeconds) {
      // Padding goes into the closing rest so the text keeps its natural speed.
      paced[paced.length - 1].seconds += options.durationSeconds - total
      total = options.durationSeconds
    }
  }
  return { paced, duration: total }
}

/**
 * Flatten one event into a timeline unit. The consonant share is capped below
 * half a syllable so the vowel always gets frames, and floored so a short slot
 * still closes the lips at least once.
 *
 * @param {object} event - syllable or pause event.
 * @param {number} start - seconds.
 * @param {number} seconds - duration.
 * @returns {object} unit consumed by `rasterise`.
 */
function unitFromEvent (event, start, seconds) {
  if (event.type === 'pause') return { type: 'pause', start, seconds }
  const span = Math.max(seconds, 1e-6)
  return {
    type: 'syllable',
    start,
    seconds,
    consonantViseme: event.consonantViseme,
    consonantVoiced: event.consonantVoiced,
    vowelViseme: event.vowelViseme,
    vowelAperture: event.vowelAperture,
    vowelEnergy: event.vowelEnergy,
    consonantShare: event.consonantViseme === null
      ? 0
      : clamp(event.consonantSeconds / span, 0.1, 0.45)
  }
}

/**
 * Lay paced events out from zero.
 * @param {{ event: object, seconds: number }[]} paced
 * @returns {{ units: object[], duration: number }}
 */
function toUnits (paced) {
  const units = []
  let start = 0
  for (const { event, seconds } of paced) {
    units.push(unitFromEvent(event, start, seconds))
    start += seconds
  }
  return { units, duration: start }
}

/* --------------------------------------------------------- rasterisation -- */

/** Maximal runs of equal labels, as `{ label, start, end }` inclusive frames. */
function labelRuns (labels) {
  const runs = []
  let current = null
  for (let index = 0; index < labels.length; index += 1) {
    if (current !== null && labels[index] === current.label) {
      current.end = index
      continue
    }
    if (current !== null) runs.push(current)
    current = { label: labels[index], start: index, end: index }
  }
  if (current !== null) runs.push(current)
  return runs
}

/**
 * Remove one-frame label chatter: a lone frame whose neighbours agree is a
 * rounding artefact, not a shape change. A one-frame consonant between two
 * different vowels is real phonology and survives.
 * @param {string[]} labels - mutated in place.
 */
function despike (labels) {
  const guard = labels.length + 8
  for (let pass = 0; pass < guard; pass += 1) {
    const runs = labelRuns(labels)
    if (runs.length < 3) return
    let changed = false
    for (let index = 1; index < runs.length - 1; index += 1) {
      if (runs[index].end !== runs[index].start) continue
      if (runs[index - 1].label !== runs[index + 1].label) continue
      labels[runs[index].start] = runs[index - 1].label
      changed = true
      break
    }
    if (!changed) return
  }
}

/**
 * Paint units onto frames, then smooth the jaw and the level. Labels are
 * rasterised first and de-spiked; aperture and energy are then filtered with an
 * asymmetric one-pole whose time constant is `style.blendMs`, which is the
 * coarticulation the eye actually sees.
 *
 * @param {object[]} units - timeline units.
 * @param {{ fps: number, frameCount: number, style: object }} options
 * @returns {{ labels: string[], openness: Float64Array, energy: Float64Array, voiced: boolean[] }}
 */
function rasterise (units, options) {
  const { fps, frameCount, style } = options
  const labels = new Array(frameCount).fill('none')
  const opennessTarget = new Float64Array(frameCount)
  const energyTarget = new Float64Array(frameCount)
  const voicing = new Uint8Array(frameCount)

  for (const unit of units) {
    if (unit.type !== 'syllable') continue
    const from = clamp(Math.round(unit.start * fps), 0, frameCount)
    const to = clamp(Math.round((unit.start + unit.seconds) * fps), from, frameCount)
    const span = to - from
    if (span <= 0) continue
    let consonantFrames = 0
    if (unit.consonantViseme !== null && span > 1) {
      consonantFrames = clamp(Math.round(span * unit.consonantShare), 1, span - 1)
    }
    for (let index = from; index < to; index += 1) {
      const consonant = index - from < consonantFrames
      labels[index] = consonant ? unit.consonantViseme : unit.vowelViseme
      const targetOpen = consonant ? apertureOf(unit.consonantViseme) : unit.vowelAperture
      const targetEnergy = consonant ? loudnessOf(unit.consonantViseme) : unit.vowelEnergy
      opennessTarget[index] = clamp(targetOpen * style.openness, 0, 1)
      energyTarget[index] = clamp(targetEnergy * style.energy, 0, 1)
      voicing[index] = consonant ? (unit.consonantVoiced ? 1 : 0) : 1
    }
  }

  despike(labels)

  // One-pole with a faster attack than release: the mouth anticipates a shape
  // and lets it go slowly, which reads as a jaw rather than a puppet.
  const step = 1 / fps
  const blend = style.blendMs / 1000
  const attack = 1 - Math.exp(-step / (blend * 0.55))
  const release = 1 - Math.exp(-step / (blend * 1.4))
  const openness = new Float64Array(frameCount)
  const energy = new Float64Array(frameCount)
  const voiced = new Array(frameCount)
  let open = 0
  let level = 0
  for (let index = 0; index < frameCount; index += 1) {
    const targetOpen = opennessTarget[index]
    open += (targetOpen - open) * (targetOpen > open ? attack : release)
    const targetEnergy = energyTarget[index]
    level += (targetEnergy - level) * (targetEnergy > level ? attack : release)
    openness[index] = open
    energy[index] = level
    const label = labels[index]
    voiced[index] = !UNVOICED_VISEMES.has(label) && (OPEN_VISEMES.has(label) || voicing[index] === 1)
  }
  return { labels, openness, energy, voiced }
}

/**
 * Assemble the public track object: frames, counts, provenance. Frame count is
 * the rounded duration so `round(durationSeconds * fps)` always equals
 * `frames.length`, the same geometry `analyzeVisemes` guarantees.
 *
 * @param {object} options - `units`, `durationSeconds`, `fps`, `style`,
 *   `alignment`, `extra`.
 * @returns {object} the track.
 */
function buildTrack (options) {
  const fps = options.fps
  const frameCount = Math.max(0, Math.round(options.durationSeconds * fps))
  const painted = rasterise(options.units, {
    fps,
    frameCount,
    style: styleOf(options.style)
  })
  const counts = {}
  for (const viseme of VISEMES) counts[viseme] = 0
  let voicedFrames = 0
  const frames = new Array(frameCount)
  for (let index = 0; index < frameCount; index += 1) {
    const viseme = painted.labels[index]
    if (counts[viseme] !== undefined) counts[viseme] += 1
    if (painted.voiced[index]) voicedFrames += 1
    frames[index] = {
      t: roundTo(index / fps, 6),
      viseme,
      openness: roundTo(clamp(painted.openness[index], 0, 1), 3),
      energy: roundTo(clamp(painted.energy[index], 0, 1), 3),
      voiced: painted.voiced[index]
    }
  }
  const extra = options.extra !== undefined ? options.extra : {}
  return {
    fps,
    frames,
    counts,
    source: 'text',
    durationSeconds: roundTo(frameCount / fps, 6),
    leadMs: 0,
    voicedFrames,
    style: options.style,
    alignment: options.alignment,
    ...extra
  }
}

/* ------------------------------------------------------------ formatting -- */

/**
 * Format a text-driven track for a consumer that is not this library, using the
 * same renderers as an audio-driven one. `json` additionally records that the
 * track came from text, so a cache or a debug view can tell the two apart; the
 * frames themselves are identical in shape.
 *
 * @param {object} mouth - a track from `mouthFromText` / `mouthFromTimeline`.
 * @param {'json'|'srt'|'css'|'ae'} [format='json'] - target consumer.
 * @param {object} [options] - `fps`, `duration`, `includeSilence`.
 * @returns {string} the formatted track.
 */
export function formatMouth (mouth, format = 'json', options = {}) {
  const track = mouth !== null && typeof mouth === 'object' ? mouth : {}
  const frames = Array.isArray(track.frames) ? track.frames : []
  const fps = Number.isFinite(options.fps)
    ? options.fps
    : (Number.isFinite(track.fps) ? track.fps : 24)
  const duration = Number.isFinite(options.duration)
    ? options.duration
    : (Number.isFinite(track.durationSeconds) ? track.durationSeconds : undefined)
  const leadMs = Number.isFinite(track.leadMs) ? track.leadMs : 0

  if (format === 'srt') {
    return visemeToSrt(frames, { fps, includeSilence: options.includeSilence === true })
  }
  if (format === 'json') {
    const payload = JSON.parse(visemeToTimeline(frames, 'json', { fps, duration, leadMs }))
    payload.source = 'text'
    if (Number.isFinite(track.syllableCount)) payload.syllables = track.syllableCount
    if (typeof track.style === 'string') payload.style = track.style
    return JSON.stringify(payload, null, 2)
  }
  return visemeToTimeline(frames, format, { fps, duration, leadMs })
}

/* ------------------------------------------------------------------- api -- */

/**
 * Build a mouth track from text, scheduled on the musical grid.
 *
 * @param {object} [request]
 * @param {string} [request.text] - words: pinyin ("wo ai ni"), a Latin-script
 *   caption, or Chinese (mapped per character, see the module notes).
 * @param {number} [request.bpm=96] - tempo, 20..300.
 * @param {number} [request.fps=24] - frames per second, 1..240.
 * @param {number} [request.durationSeconds] - force the track length; text is
 *   compressed to fit, or the closing rest is padded.
 * @param {'neutral'|'excited'|'tired'} [request.style='neutral'] - jaw and
 *   energy scale, and the coarticulation speed.
 * @param {'bpm'|'even'} [request.alignment='bpm'] - punctuation-weighted slots,
 *   or one equal slice per event.
 * @returns {{ fps: number, frames: Array<object>, counts: object, source: string,
 *   durationSeconds: number, leadMs: number, voicedFrames: number, style: string,
 *   alignment: string, bpm: number, syllableCount: number, warnings: string[] }}
 */
export function mouthFromText (request = {}) {
  const input = request !== null && typeof request === 'object' ? request : {}
  const fps = clamp(Math.round(finiteOr(input.fps, 24)), 1, 240)
  const bpm = clamp(finiteOr(input.bpm, 96), 20, 300)
  const style = MOUTH_STYLES.includes(input.style) ? input.style : 'neutral'
  const alignment = input.alignment === 'even' ? 'even' : 'bpm'
  const requested = finiteOr(input.durationSeconds, 0)
  const durationSeconds = requested > 0 ? clamp(requested, 1 / fps, 600) : undefined

  const encoded = encodeText(input.text)
  const warnings = encoded.warnings.slice()
  if (input.alignment === 'cues') {
    warnings.push('alignment "cues" is for timed captions; mouthFromText paced the text by bpm instead')
  }

  const scheduled = paceText(encoded.events, { bpm, alignment, durationSeconds })
  let units
  let duration
  if (scheduled.paced.length > 0) {
    const built = toUnits(scheduled.paced)
    units = built.units
    duration = built.duration
  } else {
    // No words: an empty track, or a silent window when a length was requested.
    units = durationSeconds === undefined ? [] : [{ type: 'pause', start: 0, seconds: durationSeconds }]
    duration = durationSeconds ?? 0
  }

  return buildTrack({
    fps,
    style,
    alignment,
    durationSeconds: duration,
    units,
    extra: { bpm, syllableCount: encoded.syllables, warnings }
  })
}

/**
 * Build a mouth track from text that already has times (captions, karaoke
 * lines). Each cue owns `[at, at + dur)`; text inside a cue is spread across the
 * cue by weight, and gaps between cues are closed mouth. When cues overlap, the
 * later cue wins.
 *
 * @param {object} [request]
 * @param {{ at: number, text: string, dur: number }[]} [request.cues] - timed
 *   lines in seconds; `dur` is optional and falls back to roughly 96 bpm.
 * @param {number} [request.fps=24] - frames per second, 1..240.
 * @param {'neutral'|'excited'|'tired'} [request.style='neutral'] - jaw and
 *   energy scale, and the coarticulation speed.
 * @returns {{ fps: number, frames: Array<object>, counts: object, source: string,
 *   durationSeconds: number, leadMs: number, voicedFrames: number, style: string,
 *   alignment: string, cueCount: number, syllableCount: number, warnings: string[] }}
 */
export function mouthFromTimeline (request = {}) {
  const input = request !== null && typeof request === 'object' ? request : {}
  const fps = clamp(Math.round(finiteOr(input.fps, 24)), 1, 240)
  const style = MOUTH_STYLES.includes(input.style) ? input.style : 'neutral'
  const rawCues = Array.isArray(input.cues) ? input.cues : []
  const cues = []
  const warnings = []
  let syllables = 0
  let duration = 0

  for (const raw of rawCues) {
    if (raw === null || typeof raw !== 'object') continue
    const encoded = encodeText(raw.text)
    syllables += encoded.syllables
    warnings.push(...encoded.warnings)
    const at = Math.max(0, finiteOr(raw.at, 0))
    const requested = finiteOr(raw.dur, 0)
    if (encoded.events.length === 0) {
      // A cue with no words is still a window where the mouth is closed.
      const dur = requested > 0 ? clamp(requested, 1 / fps, 600) : 1 / fps
      duration = Math.max(duration, at + dur)
      continue
    }
    const weights = encoded.events.map((event) => (event.type === 'pause' ? event.weight : 1))
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const dur = requested > 0
      ? clamp(requested, 1 / fps, 600)
      : clamp(totalWeight * syllableSeconds(96), 1 / fps, 600)
    cues.push({ at, dur, events: encoded.events, weights, totalWeight })
    duration = Math.max(duration, at + dur)
  }

  cues.sort((left, right) => left.at - right.at)
  const units = []
  for (const cue of cues) {
    let cursor = cue.at
    for (let index = 0; index < cue.events.length; index += 1) {
      const seconds = cue.dur * cue.weights[index] / cue.totalWeight
      units.push(unitFromEvent(cue.events[index], cursor, seconds))
      cursor += seconds
    }
  }
  if (cues.length === 0) warnings.push('no cues to place; pass [{ at, text, dur }] in seconds')

  return buildTrack({
    fps,
    style,
    alignment: 'cues',
    durationSeconds: duration,
    units,
    extra: { cueCount: cues.length, syllableCount: syllables, warnings: [...new Set(warnings)] }
  })
}
