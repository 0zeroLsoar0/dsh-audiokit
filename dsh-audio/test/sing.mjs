/**
 * Engine tests for the formant singing voice.
 *
 * These are measurements, not vibes: every claim here is a number printed from
 * the rendered samples. The four things that can quietly be wrong in a singing
 * synthesizer are pitch, vowel identity (formants), vibrato, and articulation
 * (consonants) — so each gets its own section with a real measurement, and the
 * thresholds are stated next to the numbers.
 */

import { measure } from '../lib/audio.js'
import { encodeWav } from '../lib/wav.js'
import {
  CONSONANTS,
  VOWELS,
  VOICE_PRESETS,
  measurePitch,
  midiToHz,
  parseMelody,
  parseSyllable,
  renderSing,
  singPlan,
  splitLyric,
  trackPitch
} from '../lib/sing.js'

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const fmt = (value, digits = 1) => Number(value).toFixed(digits)
const pct = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`

/* ------------------------------------------------------------------ FFT -- */

/** In-place iterative radix-2 FFT. */
function fft (real, imag) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len
    const wReal = Math.cos(angle)
    const wImag = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curReal = 1
      let curImag = 0
      for (let k = 0; k < len / 2; k += 1) {
        const uReal = real[i + k]
        const uImag = imag[i + k]
        const vReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag
        const vImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal
        real[i + k] = uReal + vReal
        imag[i + k] = uImag + vImag
        real[i + k + len / 2] = uReal - vReal
        imag[i + k + len / 2] = uImag - vImag
        const nextReal = curReal * wReal - curImag * wImag
        curImag = curReal * wImag + curImag * wReal
        curReal = nextReal
      }
    }
  }
}

/**
 * Harmonic amplitude envelope: the magnitude of each fundamental harmonic, taken
 * as the strongest FFT bin within +-f0/2 of where that harmonic should be.
 *
 * This is the honest way to look at a sung spectrum: a harmonic voice carries no
 * energy between harmonics, so "the spectrum peaks at 700 Hz" can only ever mean
 * "the harmonic near 700 Hz is strong". Reading a formant off raw FFT bins would
 * report whichever harmonic happens to sit closest, not where the formant is.
 */
function harmonicEnvelope (samples, sampleRate, from, f0) {
  const size = 16384
  const start = Math.round(from * sampleRate)
  if (start + size > samples.length) throw new Error('window too short for a 16384-point FFT')
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < size; i += 1) real[i] = samples[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)))
  fft(real, imag)
  const binHz = sampleRate / size
  const halfBand = Math.max(1, Math.round(f0 / 2 / binHz))
  const harmonics = []
  for (let k = 1; k * f0 < sampleRate * 0.45; k += 1) {
    const center = Math.round(k * f0 / binHz)
    let best = 0
    for (let b = Math.max(1, center - halfBand); b <= Math.min(size / 2 - 1, center + halfBand); b += 1) {
      best = Math.max(best, Math.hypot(real[b], imag[b]))
    }
    harmonics.push({ hz: k * f0, mag: best })
  }
  const top = Math.max(...harmonics.map((h) => h.mag))
  return harmonics.map((h) => ({ ...h, db: 20 * Math.log10(Math.max(h.mag, 1e-12) / top) }))
}

/** Local maxima of the harmonic envelope, sorted by frequency. */
function envelopePeaks (harmonics) {
  const peaks = []
  for (let k = 1; k < harmonics.length - 1; k += 1) {
    const prev = harmonics[k - 1]
    const cur = harmonics[k]
    const next = harmonics[k + 1]
    if (cur.mag >= prev.mag && cur.mag >= next.mag && cur.db > -45) {
      peaks.push({ hz: cur.hz, db: cur.db, dip: cur.mag / Math.max(1e-9, Math.min(prev.mag, next.mag)) })
    }
  }
  return peaks.sort((a, b) => a.hz - b.hz)
}

/** The envelope peak closest to a target formant frequency. */
function measureFormant (peaks, target) {
  let best = null
  for (const peak of peaks) {
    if (best === null || Math.abs(peak.hz - target) < Math.abs(best.hz - target)) best = peak
  }
  if (best === null) return { target, hz: 0, error: 1, db: -120, dip: 0 }
  return { target, hz: best.hz, error: (best.hz - target) / target, db: best.db, dip: best.dip }
}

/* ------------------------------------------------------- envelope helpers -- */

/** Short-time RMS envelope, 5 ms hop / 5 ms window. */
function rmsEnvelope (samples, sampleRate) {
  const hop = Math.max(1, Math.round(0.005 * sampleRate))
  const env = []
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sum = 0
    for (let i = 0; i < hop; i += 1) sum += samples[start + i] * samples[start + i]
    env.push(Math.sqrt(sum / hop))
  }
  return { env, hopSeconds: hop / sampleRate }
}

/** Largest single-hop RMS rise, as a fraction of the peak envelope. */
function maxTransient (samples, sampleRate) {
  const { env } = rmsEnvelope(samples, sampleRate)
  const peak = Math.max(...env)
  let best = 0
  for (let i = 1; i < env.length; i += 1) best = Math.max(best, env[i] - env[i - 1])
  return best / peak
}

/** Mean RMS inside a time window, for "is there energy before the vowel". */
function meanRms (samples, sampleRate, from, to) {
  const start = Math.max(0, Math.round(from * sampleRate))
  const end = Math.min(samples.length, Math.round(to * sampleRate))
  let sum = 0
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, end - start))
}

/** Power-weighted spectral centroid of a 46 ms window, in Hz. */
function windowCentroid (samples, sampleRate, from) {
  const size = 2048
  const start = Math.max(0, Math.round(from * sampleRate))
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < size; i += 1) real[i] = (samples[start + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)))
  fft(real, imag)
  let weighted = 0
  let total = 0
  for (let b = 1; b < size / 2; b += 1) {
    const power = real[b] * real[b] + imag[b] * imag[b]
    weighted += power * b * sampleRate / size
    total += power
  }
  return total > 0 ? weighted / total : 0
}

/* --------------------------------------------------------- 1. syllables -- */

console.log('-- parseSyllable: pinyin to consonant + vowels --')
const SYLLABLES = [
  'ma', 'ni', 'xue', 'zhang', 'xiao', 'shi', 'xi', 'ju', 'qu', 'yuan', 'jun',
  'lü', 'nv', 'zhuang', 'xiong', 'bao', 'gui', 'ai', 'er', '', '123', 'q',
  'xyz', 'ma1', 'ma3', "xi'an", '🙂', 'ng', 'HR', 'A'
]
for (const text of SYLLABLES) {
  let parsed
  try {
    parsed = parseSyllable(text)
  } catch (error) {
    check(`parseSyllable(${JSON.stringify(text)}) does not throw`, false, String(error))
    continue
  }
  const valid = Array.isArray(parsed.vowels) && parsed.vowels.length > 0 && parsed.vowels.every((id) => VOWELS[id] !== undefined)
  check(`parseSyllable(${JSON.stringify(text)}) yields known vowels`, valid, JSON.stringify(parsed))
}
for (const [text, expected] of [
  ['ma', ['m', 'a']],
  ['ni', ['n', 'i']],
  ['xue', ['x', 'v', 'e']],
  ['zhang', ['zh', 'ang']],
  ['shi', ['sh', 'i0']],
  ['ju', ['j', 'v']],
  ['nv', ['n', 'v']],
  ['lü', ['l', 'v']],
  ['yuan', ['y', 'v', 'an']],
  ['xiao', ['x', 'i', 'a', 'o']],
  ['er', ['-', 'er']]
]) {
  const parsed = parseSyllable(text)
  const got = [parsed.consonant ?? '-', ...parsed.vowels]
  check(`parse ${text}`, JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)} want ${JSON.stringify(expected)}`)
}
console.log(`  ${SYLLABLES.length} inputs parsed, none threw`)
console.log(`  table: ${Object.keys(VOWELS).length} vowels (${Object.keys(VOWELS).join(' ')})`)
console.log(`  table: ${Object.keys(CONSONANTS).length} consonants (${Object.keys(CONSONANTS).join(' ')})`)
console.log(`  spot checks: ma -> m+a, xue -> x+v+e, zhang -> zh+ang, shi -> sh+i0, yuan -> y+v+an`)

console.log('-- splitLyric / parseMelody --')
{
  const lyric = splitLyric("wo ai ni, xi'an ma")
  check('lyric splits on spaces and apostrophes', lyric.syllables.length === 6, JSON.stringify(lyric.syllables))
  const han = splitLyric('我爱你')
  check('han characters still yield singable syllables', han.syllables.length === 3 && han.warnings.length === 1, JSON.stringify(han))
  const melody = parseMelody('C4:1 E4:1.5 G4:2 r:1 A#3:0.5')
  check('melody tokens', melody.length === 5, JSON.stringify(melody))
  check('melody rest', melody[3].midi === null)
  check('C4 is midi 60', melody[0].midi === 60, String(melody[0].midi))
  check('A#3 is midi 58', melody[4].midi === 58, String(melody[4].midi))
}

/* ------------------------------------------------------------- 2. plan -- */

console.log('\n-- singPlan: three ways in --')
{
  const fromNotes = singPlan({ notes: [{ midi: 60, dur: 1 }, { midi: 64, dur: 1, syllable: 'ma' }], bpm: 120 })
  check('notes source', fromNotes.notes.length === 2, String(fromNotes.notes.length))
  check('notes seconds', Math.abs(fromNotes.totalSeconds - 1) < 1e-9, String(fromNotes.totalSeconds))
  const fromMelody = singPlan({ melody: 'C4:1 E4:1 G4:2', bpm: 60 })
  check('melody source', fromMelody.notes.map((n) => n.midi).join(',') === '60,64,67', JSON.stringify(fromMelody.notes.map((n) => n.midi)))
  check('melody total', Math.abs(fromMelody.totalSeconds - 4) < 1e-9, String(fromMelody.totalSeconds))
  const fromLyric = singPlan({ lyric: 'ma mi mu me mo', bpm: 90 })
  check('lyric source', fromLyric.notes.length === 5, String(fromLyric.notes.length))
  check('lyric syllables', fromLyric.notes.map((n) => n.syllable).join(' ') === 'ma mi mu me mo', fromLyric.notes.map((n) => n.syllable).join(' '))
  const empty = singPlan({})
  check('empty request still plans sound', empty.notes.length >= 1 && empty.totalSeconds > 0, JSON.stringify(empty.notes.length))
  const rests = singPlan({ melody: 'C4:1 r:1 C4:1', bpm: 60 })
  check('rest advances the beat', rests.notes.length === 2 && rests.notes[1].startBeat === 2, JSON.stringify(rests.notes.map((n) => n.startBeat)))
  check('plan is deterministic', JSON.stringify(singPlan({ lyric: 'la la' })) === JSON.stringify(singPlan({ lyric: 'la la' })))
  const pitched = singPlan({ notes: ['C4', 62, { note: 'E4', duration: 2 }], bpm: 60 })
  check('pitch names and numbers accepted', pitched.notes.map((n) => n.midi).join(',') === '60,62,64', JSON.stringify(pitched.notes.map((n) => n.midi)))
}

/* ------------------------------------------------------- 3. determinism -- */

console.log('\n-- determinism --')
const deterministicPlan = singPlan({ melody: 'A3:1 C4:1 E4:1 A4:2', lyric: 'ma ni xue la', bpm: 96 })
{
  const first = renderSing(deterministicPlan, { seed: 7 })
  const second = renderSing(deterministicPlan, { seed: 7 })
  const bytesA = encodeWav([first.samples], first.sampleRate, { dither: false })
  const bytesB = encodeWav([second.samples], second.sampleRate, { dither: false })
  check('identical sample count', first.samples.length === second.samples.length, `${first.samples.length} vs ${second.samples.length}`)
  check('identical bytes', Buffer.compare(bytesA, bytesB) === 0, `${bytesA.length} vs ${bytesB.length}`)
  let identical = true
  for (let i = 0; i < first.samples.length; i += 1) {
    if (first.samples[i] !== second.samples[i]) { identical = false; break }
  }
  check('identical samples', identical)
  const third = renderSing(deterministicPlan, { seed: 8 })
  let differs = false
  for (let i = 0; i < first.samples.length; i += 1) {
    if (first.samples[i] !== third.samples[i]) { differs = true; break }
  }
  check('different seed differs', differs)
  console.log(`  2 renders of the same plan: ${bytesA.length} bytes, byte-identical = yes; seed 8 differs = ${differs}`)
}

/* ---------------------------------------------------- 4. pitch accuracy -- */

console.log('\n-- pitch accuracy (autocorrelation, sustain window) --')
function pitchReport (label, hzExpected, result, from, to) {
  const measured = measurePitch(result.samples, result.sampleRate, { from, to })
  const error = (measured.hz - hzExpected) / hzExpected
  console.log(`  ${label.padEnd(16)} target ${fmt(hzExpected, 2)} Hz  measured ${fmt(measured.hz, 2)} Hz  error ${pct(error).padStart(8)}  clarity ${fmt(measured.clarity, 2)}`)
  check(`${label} within 1 %`, Math.abs(error) <= 0.01, pct(error))
}
pitchReport('A3 (220 Hz)', 220, renderSing(singPlan({ notes: [{ midi: 57, dur: 1.4 }], bpm: 60, lyric: 'a' }), { seed: 3 }), 0.25, 1.2)
for (const [name, midi] of [['C4', 60], ['E4', 64], ['A4', 69], ['A2', 45]]) {
  const note = renderSing(singPlan({ notes: [{ midi, dur: 1.2 }], bpm: 60, lyric: 'a' }), { seed: 4 })
  pitchReport(`${name} (${fmt(midiToHz(midi), 1)} Hz)`, midiToHz(midi), note, 0.3, 1.0)
}

/* ------------------------------------------------- 5. formant correctness -- */

console.log('\n-- formant peaks (FFT of the sustain, harmonic envelope) --')

/**
 * Render one sustained vowel and read its formants off the spectrum. The render
 * uses `formantScale: 1`, i.e. the vowel table's own numbers, so the measured
 * peaks are compared against exactly what the table says — not against a
 * voice-preset-scaled variant of it.
 *
 * The test note is chosen so a harmonic actually lands on each formant. At a
 * 98 Hz fundamental the harmonics are 98 Hz apart, which puts one within a few
 * percent of 290, 320, 700, 800, 1220 and 2300 Hz. At A3 (220 Hz) there is no
 * harmonic at all inside 246-334 Hz, so a 290 Hz formant cannot be represented
 * in that spectrum — that is harmonic sampling, not a defect of the voice.
 */
function formantReport (label, vowelId, midi) {
  const plan = singPlan({ notes: [{ midi, dur: 1.5, syllable: vowelId }], bpm: 60 })
  const result = renderSing(plan, { seed: 5, vibrato: 0, formantScale: 1 })
  const f0 = measurePitch(result.samples, result.sampleRate, { from: 0.5, to: 1.2 }).hz
  const harmonics = harmonicEnvelope(result.samples, result.sampleRate, 0.5, f0)
  const peaks = envelopePeaks(harmonics)
  const vowel = VOWELS[vowelId]
  const targets = [vowel.f1, vowel.f2]
  const found = targets.map((target) => measureFormant(peaks, target))
  const allPeaks = peaks.filter((peak) => peak.hz < 3800 && peak.db > -35).map((peak) => `${fmt(peak.hz, 0)}Hz`).join(' ')
  console.log(`  ${label.padEnd(7)} f0 ${fmt(f0, 2)} Hz  envelope maxima: ${allPeaks}`)
  console.log(`          ${targets.map((t, i) => `F${i + 1} table ${t} Hz -> measured ${fmt(found[i].hz, 1)} Hz (${pct(found[i].error)}, ${fmt(found[i].db, 0)} dB, dip ${fmt(found[i].dip, 1)}x)`).join('   ')}`)
  check(`${label} F1 within 15 %`, Math.abs(found[0].error) <= 0.15, pct(found[0].error))
  check(`${label} F2 within 15 %`, Math.abs(found[1].error) <= 0.15, pct(found[1].error))
}
// The letter of the brief: 'a' on A3, F1 700 / F2 1220.
formantReport('a @A3', 'a', 57)
// Harmonic-dense note for the rest, so every formant has a harmonic on it.
formantReport('a @G2', 'a', 43)
formantReport('i @G2', 'i', 43)
formantReport('u @G2', 'u', 43)

// A nasal variant must show the low nasal pole the oral vowel does not.
{
  const render = (syllable) => renderSing(singPlan({ notes: [{ midi: 45, dur: 1.4, syllable }], bpm: 60 }), { seed: 6, vibrato: 0, formantScale: 1 })
  const lowBand = (result) => {
    const f0 = measurePitch(result.samples, result.sampleRate, { from: 0.5, to: 1.1 }).hz
    const harmonics = harmonicEnvelope(result.samples, result.sampleRate, 0.5, f0)
    const total = harmonics.reduce((sum, h) => sum + h.mag * h.mag, 0)
    const below400 = harmonics.filter((h) => h.hz < 400).reduce((sum, h) => sum + h.mag * h.mag, 0)
    return below400 / total
  }
  const oralLow = lowBand(render('a'))
  const nasalLow = lowBand(render('an'))
  console.log(`  nasal pole: energy below 400 Hz is ${pct(oralLow)} for "a" and ${pct(nasalLow)} for "an"`)
  check('nasal vowel has more low-frequency energy', nasalLow > oralLow * 1.15, `${pct(oralLow)} vs ${pct(nasalLow)}`)
}

// Vowel contrast: if this engine only produced one vowel colour, "singing words"
// would be a lie no matter what the formant peaks said. Compare the spectra of
// a / i / u on a common 100 Hz grid; a real vowel system is far apart.
{
  const spectra = {}
  for (const vowelId of ['a', 'i', 'u']) {
    const result = renderSing(singPlan({ notes: [{ midi: 45, dur: 1.4, syllable: vowelId }], bpm: 60 }), { seed: 7, vibrato: 0, formantScale: 1 })
    const f0 = measurePitch(result.samples, result.sampleRate, { from: 0.5, to: 1.1 }).hz
    const harmonics = harmonicEnvelope(result.samples, result.sampleRate, 0.5, f0)
    const grid = []
    for (let hz = 200; hz <= 3600; hz += 100) {
      const point = harmonics.reduce((best, item) => (Math.abs(item.hz - hz) < Math.abs(best.hz - hz) ? item : best), harmonics[0])
      grid.push(point.db)
    }
    spectra[vowelId] = grid
  }
  const distance = (x, y) => spectra[x].reduce((sum, value, index) => sum + Math.abs(value - spectra[y][index]), 0) / spectra[x].length
  const pairs = [['a', 'i'], ['a', 'u'], ['i', 'u']].map(([x, y]) => [`${x}/${y}`, distance(x, y)])
  console.log(`  vowel contrast (mean |dB| difference on a 200-3600 Hz grid): ${pairs.map(([name, value]) => `${name} ${fmt(value, 1)} dB`).join('  ')}`)
  for (const [name, value] of pairs) check(`vowels ${name} are distinct`, value > 6, `${fmt(value, 1)} dB`)
}

/* ------------------------------------------------------------- 6. vibrato -- */

console.log('\n-- vibrato (pitch track spread and modulation rate) --')
function vibratoStats (result, fromSeconds, toSeconds) {
  const track = trackPitch(result.samples, result.sampleRate, { frameSeconds: 0.03, hopSeconds: 0.005 })
  const values = []
  for (let i = 0; i < track.hz.length; i += 1) {
    const t = i / track.frameRate
    if (t < fromSeconds || t > toSeconds) continue
    if (track.hz[i] > 0) values.push(track.hz[i])
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length
  const std = Math.sqrt(variance)
  // Modulation rate: peak of the detrended pitch track's spectrum.
  const size = 1024
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < values.length && i < size; i += 1) {
    real[i] = (values[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (values.length - 1)))
  }
  fft(real, imag)
  let bestBin = 0
  let bestMag = 0
  const binHz = track.frameRate / size
  const lowBin = Math.max(1, Math.round(2 / binHz))
  const highBin = Math.min(size / 2 - 1, Math.round(12 / binHz))
  for (let b = lowBin; b <= highBin; b += 1) {
    const mag = Math.hypot(real[b], imag[b])
    if (mag > bestMag) { bestMag = mag; bestBin = b }
  }
  return { mean, std, rate: bestBin * binHz, frames: values.length }
}
{
  const longPlan = singPlan({ notes: [{ midi: 57, dur: 3 }], bpm: 60, lyric: 'a' })
  const flatStats = vibratoStats(renderSing(longPlan, { seed: 9, vibrato: 0, vibratoRate: 5.5 }), 0.5, 2.8)
  const wideStats = vibratoStats(renderSing(longPlan, { seed: 9, vibrato: 1, vibratoRate: 5.5 }), 0.5, 2.8)
  console.log(`  vibrato 0: mean ${fmt(flatStats.mean, 2)} Hz  std ${fmt(flatStats.std, 3)} Hz (${fmt(flatStats.std / flatStats.mean * 100, 2)} %)`)
  console.log(`  vibrato 1: mean ${fmt(wideStats.mean, 2)} Hz  std ${fmt(wideStats.std, 3)} Hz (${fmt(wideStats.std / wideStats.mean * 100, 2)} %)  modulation ${fmt(wideStats.rate, 2)} Hz (requested 5.5)`)
  check('vibrato raises the pitch spread', wideStats.std > flatStats.std * 3, `${fmt(flatStats.std, 3)} vs ${fmt(wideStats.std, 3)}`)
  check('vibrato depth is audible (>1 % of f0)', wideStats.std / wideStats.mean > 0.01, `${fmt(wideStats.std / wideStats.mean * 100, 2)} %`)
  check('modulation rate matches the request', Math.abs(wideStats.rate - 5.5) <= 0.8, `${fmt(wideStats.rate, 2)} Hz`)
  check('unmodulated track really is flat', flatStats.std / flatStats.mean < 0.01, `${fmt(flatStats.std / flatStats.mean * 100, 2)} %`)
}

/* --------------------------------------------------------- 7. consonants -- */

console.log('\n-- consonants: "ma ma ma ma" vs "a a a a" --')
{
  const vowelOnly = renderSing(singPlan({ notes: [57, 57, 57, 57].map((midi) => ({ midi, dur: 1, syllable: 'a' })), bpm: 90 }), { seed: 11 })
  const nasal = renderSing(singPlan({ notes: [57, 57, 57, 57].map((midi) => ({ midi, dur: 1, syllable: 'ma' })), bpm: 90 }), { seed: 11 })
  const vowelOnsets = measure(vowelOnly.samples, vowelOnly.sampleRate).onsets
  const nasalOnsets = measure(nasal.samples, nasal.sampleRate).onsets
  const vowelTransient = maxTransient(vowelOnly.samples, vowelOnly.sampleRate)
  const nasalTransient = maxTransient(nasal.samples, nasal.sampleRate)
  const vowelLead = vowelOnly.syllableTimings[0].vowelStart - vowelOnly.syllableTimings[0].start
  const nasalLead = nasal.syllableTimings[0].vowelStart - nasal.syllableTimings[0].start
  console.log(`  "a"  onsets ${vowelOnsets}  largest 5 ms rise ${pct(vowelTransient)} of peak  vowel starts ${fmt(vowelLead, 3)} s in`)
  console.log(`  "ma" onsets ${nasalOnsets}  largest 5 ms rise ${pct(nasalTransient)} of peak  vowel starts ${fmt(nasalLead, 3)} s in`)
  check('"ma" adds onset events before the vowels', nasalOnsets >= vowelOnsets + 3, `${vowelOnsets} vs ${nasalOnsets}`)
  check('"ma" adds a sharper transient', nasalTransient > vowelTransient * 1.5, `${pct(vowelTransient)} vs ${pct(nasalTransient)}`)
  check('"a" has no consonant', vowelOnly.syllableTimings[0].consonant === null)
  check('"ma" murmur precedes the vowel', nasalLead > 0.04, String(nasalLead))
}

// Fricatives must put *broadband noise* before the vowel; a vowel-initial note
// starts with a vowel. Comparing RMS would be misleading (the vowel wins by
// level), so compare timbre: the fricative's energy sits at 3-6 kHz, a vowel's
// around F1.
{
  const sRender = renderSing(singPlan({ notes: [{ midi: 57, dur: 1 }], bpm: 60, lyric: 'sa' }), { seed: 12 })
  const aRender = renderSing(singPlan({ notes: [{ midi: 57, dur: 1 }], bpm: 60, lyric: 'a' }), { seed: 12 })
  const lead = sRender.syllableTimings[0].vowelStart - sRender.syllableTimings[0].start
  const sCentroid = windowCentroid(sRender.samples, sRender.sampleRate, 0)
  const aCentroid = windowCentroid(aRender.samples, aRender.sampleRate, 0)
  const sRms = meanRms(sRender.samples, sRender.sampleRate, 0, 0.046)
  console.log(`  first 46 ms: "sa" is noise (centroid ${fmt(sCentroid, 0)} Hz, rms ${fmt(sRms, 3)}), "a" is a vowel (centroid ${fmt(aCentroid, 0)} Hz)`)
  console.log(`  "sa" frication lasts ${fmt(lead, 3)} s before the vowel`)
  check('fricative lead-in is audible', sRms > 0.02, String(sRms))
  check('fricative lead-in is broadband, not a vowel', sCentroid > aCentroid * 2.5, `${fmt(sCentroid, 0)} vs ${fmt(aCentroid, 0)} Hz`)
}

// Every consonant class must render distinctly and never silent.
console.log('-- consonant inventory renders --')
{
  const classes = {}
  for (const [id, entry] of Object.entries(CONSONANTS)) {
    classes[entry.class] = classes[entry.class] ?? []
    classes[entry.class].push(id)
  }
  for (const [cls, ids] of Object.entries(classes)) {
    for (const id of ids.slice(0, 2)) {
      const result = renderSing(singPlan({ notes: [{ midi: 57, dur: 1 }], bpm: 60, lyric: `${id}a` }), { seed: 13 })
      let peak = 0
      let finite = true
      for (const sample of result.samples) {
        if (!Number.isFinite(sample)) finite = false
        peak = Math.max(peak, Math.abs(sample))
      }
      const vowelLead = result.syllableTimings[0].vowelStart - result.syllableTimings[0].start
      const pre = meanRms(result.samples, result.sampleRate, 0, Math.max(0.005, vowelLead * 0.8))
      console.log(`  ${`${id}a`.padEnd(4)} ${cls.padEnd(10)} vowel at ${fmt(vowelLead, 3)} s  lead-in RMS ${fmt(pre, 3)}  peak ${fmt(20 * Math.log10(Math.max(peak, 1e-9)), 1)} dBFS`)
      check(`${id}a finite`, finite)
      check(`${id}a not silent`, peak > 0.05, String(peak))
    }
  }
}

/* ------------------------------------------------------------- 8. hygiene -- */

console.log('\n-- hygiene: NaN, clipping, DC, timing --')
{
  const plan = singPlan({ melody: 'A3:1 C4:2 E4:1 A4:2', lyric: 'ma ni xue la', bpm: 96 })
  const result = renderSing(plan, { seed: 13 })
  const metrics = measure(result.samples, result.sampleRate)
  let finite = true
  let peak = 0
  for (const sample of result.samples) {
    if (!Number.isFinite(sample)) finite = false
    peak = Math.max(peak, Math.abs(sample))
  }
  const timingSum = result.syllableTimings.reduce((sum, t) => sum + (t.end - t.start), 0)
  const duration = result.samples.length / result.sampleRate
  console.log(`  duration ${fmt(duration, 3)} s  peak ${fmt(metrics.peakDbfs, 2)} dBFS  rms ${fmt(metrics.rmsDbfs, 2)} dBFS  crest ${fmt(metrics.crestDb, 2)} dB`)
  console.log(`  dcOffset ${metrics.dcOffset}  clipping ${metrics.clipping}  onsets ${metrics.onsets}  centroid ${metrics.centroidHz} Hz`)
  console.log(`  syllableTimings sum ${fmt(timingSum, 3)} s vs file duration ${fmt(duration, 3)} s (delta ${fmt(Math.abs(timingSum - duration) * 1000, 1)} ms)`)
  console.log(`  first syllables, in seconds: ${result.syllableTimings.slice(0, 4).map((t) => `${t.text} ${t.start}-${t.end}`).join(', ')}`)
  check('all samples finite', finite)
  check('peak <= 1', peak <= 1.0001, String(peak))
  check('no clipping', metrics.clipping === 0, String(metrics.clipping))
  check('dc offset < 0.02', Math.abs(metrics.dcOffset) < 0.02, String(metrics.dcOffset))
  check('timing sum matches duration within 30 ms', Math.abs(timingSum - duration) < 0.03, `${fmt(Math.abs(timingSum - duration) * 1000, 1)} ms`)
  check('not silent', metrics.rmsDbfs > -40, String(metrics.rmsDbfs))
  check('pitch track frame rate', result.pitchTrack.frameRate === 200, String(result.pitchTrack.frameRate))
  check('pitch track covers the file', result.pitchTrack.hz.length >= Math.ceil(duration * 200), `${result.pitchTrack.hz.length} frames`)
}

// Portamento: a legato jump must slide through the intermediate pitches instead
// of stepping. A 30 ms analysis window cannot resolve a 45 ms octave glide (no
// pitch estimator can — the signal is not periodic over the window), so the test
// asks for the documented slow setting, portamento = 250 ms.
{
  const plan = singPlan({ notes: [{ midi: 57, dur: 1 }, { midi: 69, dur: 1 }], bpm: 60, lyric: 'a a' })
  const result = renderSing(plan, { seed: 14, vibrato: 0, portamento: 0.25 })
  const early = measurePitch(result.samples, result.sampleRate, { from: 0.9, to: 0.98 })
  const sliding = measurePitch(result.samples, result.sampleRate, { from: 1.05, to: 1.09 })
  const arrived = measurePitch(result.samples, result.sampleRate, { from: 1.35, to: 1.45 })
  console.log(`  portamento A3->A4: ${fmt(early.hz, 1)} Hz before (target 220), ${fmt(sliding.hz, 1)} Hz mid-glide at 1.05-1.09 s, ${fmt(arrived.hz, 1)} Hz after (target 440)`)
  check('portamento starts from the lower note', Math.abs(early.hz - 220) / 220 < 0.02, String(early.hz))
  check('portamento passes between the notes', sliding.hz > 230 && sliding.hz < 380, String(sliding.hz))
  check('portamento lands on the upper note', Math.abs(arrived.hz - 440) / 440 < 0.02, String(arrived.hz))
}

/* ------------------------------------------------------------ edge cases -- */
console.log('\n-- edge cases (must not throw) --')
{
  const cases = [
    ['empty plan', singPlan({}), {}],
    ['single short note', singPlan({ notes: [{ midi: 60, dur: 0.25 }] }), {}],
    ['very long lyric', singPlan({ lyric: Array.from({ length: 40 }, () => 'la').join(' ') }), {}],
    ['harmony third', singPlan({ lyric: 'la la la la' }), { harmony: 'third' }],
    ['harmony octave', singPlan({ lyric: 'ma mi' }), { harmony: 'octave' }],
    ['48 kHz', singPlan({ lyric: 'ma mi' }), { sampleRate: 48000 }],
    ['choir', singPlan({ lyric: 'la la' }), { voice: 'choir' }],
    ['child', singPlan({ lyric: 'ma ma' }), { voice: 'child' }],
    ['bass', singPlan({ lyric: 'ma ma' }), { voice: 'bass' }],
    ['breathy', singPlan({ lyric: 'ma ma' }), { voice: 'breathy' }],
    ['unknown voice falls back', singPlan({ lyric: 'la' }), { voice: 'not-a-voice' }],
    ['no vibrato', singPlan({ lyric: 'la' }), { vibrato: 0 }],
    ['zero seed', singPlan({ lyric: 'la' }), { seed: 0 }],
    ['lantern lyric', singPlan({ lyric: 'wo ai ni' }), {}]
  ]
  for (const [label, plan, options] of cases) {
    let ok = true
    let detail = ''
    try {
      const result = renderSing(plan, options)
      ok = result.samples.length > 0 && result.samples.every((v) => Number.isFinite(v))
      detail = `${result.samples.length} frames`
    } catch (error) {
      ok = false
      detail = String(error)
    }
    check(label, ok, detail)
  }
  console.log(`  ${cases.length} edge cases rendered without throwing`)
}

/* --------------------------------------------------------- 9. performance -- */

console.log('\n-- performance --')
{
  const plan = singPlan({ melody: 'C4:1 D4:1 E4:1 F4:1 G4:1 A4:1 G4:1 E4:1', lyric: 'ma ni mu me mo la la la', bpm: 60 })
  check('performance plan is 8 s', Math.abs(plan.totalSeconds - 8) < 1e-6, String(plan.totalSeconds))
  // Warm the JIT first so the number is a steady-state render cost, then report
  // the first (cold) call too, because a tool call is always cold in practice.
  renderSing(singPlan({ lyric: 'la la' }), { seed: 1 })
  const coldStart = performance.now()
  renderSing(plan, { seed: 1 })
  const coldMs = performance.now() - coldStart
  const start = performance.now()
  const result = renderSing(plan, { seed: 1 })
  const ms = performance.now() - start
  const audioSeconds = result.samples.length / result.sampleRate
  console.log(`  renderSing: ${fmt(audioSeconds, 2)} s of audio in ${fmt(ms, 1)} ms warm (${fmt(audioSeconds / (ms / 1000), 1)}x realtime), ${fmt(coldMs, 1)} ms on the preceding call`)
  check('8 s of audio under 300 ms', ms < 300, `${fmt(ms, 1)} ms`)
}

/* ---------------------------------------------------------------- summary -- */

console.log('')
console.log(`voice presets: ${Object.keys(VOICE_PRESETS).join(', ')}`)
console.log(failures === 0 ? 'OK: every check passed' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
