/**
 * Verification for the optional recorded-voice tier (`lib/voicebank.js`).
 *
 * The voicebank itself is NOT part of the plugin, so this test skips cleanly when
 * no bank is installed. Point it at one with `DSH_AUDIO_VOICEBANK=<dir>` or drop a
 * bank at `../../assets/voicebank/hitsuboku-kumi-chn`.
 *
 * Everything printed here is measured: pitch by normalised autocorrelation
 * (the same estimator the renderer uses, validated against synthetic tones
 * below), discontinuities by comparing the steepest sample-to-sample step in the
 * render against the steepest step in the raw recording.
 *
 * `node test/voicebank.mjs --smoke` runs only the loader plus a two-note render
 * and prints the measured cents — that is the end-to-end gate for
 * `tools/fetch-voicebank.mjs`, without waiting for the whole suite.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  estimateF0,
  loadVoicebank,
  measureF0,
  midiToHz,
  parseNoteScript,
  renderVoicebank
} from '../lib/voicebank.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bankDir = process.env.DSH_AUDIO_VOICEBANK ?? resolve(here, '../../assets/voicebank/hitsuboku-kumi-chn')
const outDir = new URL('./out/', import.meta.url)
const outPath = resolve(here, 'out', 'voicebank-scale.wav')

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}
const cents = (measured, target) => (measured > 0 && target > 0 ? 1200 * Math.log2(measured / target) : 0)
const fixed = (value, digits = 2) => Number(value.toFixed(digits))

if (!existsSync(bankDir)) {
  console.log(`voicebank not installed at ${bankDir}`)
  console.log('SKIP: recorded-voice test needs an external voicebank (see assets/voicebank/README.md)')
  process.exit(0)
}

/* ---- 0. smoke gate: loader + two notes, measured ---- */

const smoke = process.argv.includes('--smoke')
if (smoke) {
  const loadStart = Date.now()
  const loaded = loadVoicebank(bankDir)
  const loadMs = Date.now() - loadStart
  const notes = parseNoteScript('C4:1 E4:1')
  const started = Date.now()
  const rendered = renderVoicebank(
    { notes: notes.map((note) => ({ midi: note.midi, note: note.note, duration: note.beats })), syllables: ['a'], bpm: 120 },
    { bank: loaded, seed: 5 }
  )
  const renderMs = Date.now() - started
  let worst = 0
  const parts = rendered.syllableTimings.map((timing) => {
    const target = midiToHz(timing.midi)
    const from = Math.round((timing.startSeconds + timing.durationSeconds * 0.35) * rendered.sampleRate)
    const to = Math.round((timing.startSeconds + timing.durationSeconds * 0.92) * rendered.sampleRate)
    const measured = estimateF0(rendered.samples, rendered.sampleRate, from, to)
    const error = cents(measured.f0Hz, target)
    worst = Math.max(worst, Math.abs(error))
    const name = timing.noteName || `midi${timing.midi}`
    return `${name} ${error >= 0 ? '+' : ''}${error.toFixed(1)}c`
  })
  const syllables = loaded.meta.names.filter((name) => !name.endsWith('+') && !name.endsWith(' R'))
  console.log(
    `smoke: ${loaded.syllables.size} takes / ${syllables.length} syllables from ${loaded.meta.files} wav files, ` +
    `${(rendered.samples.length / rendered.sampleRate).toFixed(2)} s rendered, ${parts.join(', ')} ` +
    `(worst ${worst.toFixed(1)} cents), load ${loadMs} ms, render ${renderMs} ms`
  )
  check('smoke notes are within 30 cents', worst <= 30, `worst ${worst.toFixed(1)} cents`)
  console.log(failures === 0 ? 'OK: smoke passed' : `FAILED: ${failures} check(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

/* ---- 1. estimator sanity on synthetic tones ---- */

console.log('-- pitch estimator on synthetic tones --')
let worstTone = 0
for (const hz of [110, 196, 261.63, 392, 440, 587.33]) {
  const frames = 8192
  const tone = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / 44100
    tone[i] = 0.6 * Math.sin(2 * Math.PI * hz * t) +
      0.3 * Math.sin(2 * Math.PI * 2 * hz * t) +
      0.08 * Math.sin(2 * Math.PI * 3 * hz * t)
  }
  const measured = measureF0(tone, 44100, 1024, 4096)
  const error = cents(measured.f0Hz, hz)
  worstTone = Math.max(worstTone, Math.abs(error))
  console.log(`  ${String(hz).padStart(7)} Hz -> ${measured.f0Hz.toFixed(3)} Hz  (${error.toFixed(2)} cents)`)
}
check('estimator accurate to 1 cent on known tones', worstTone < 1, `worst ${worstTone.toFixed(2)} cents`)

/* ---- 2. bank load ---- */

console.log('\n-- voicebank --')
const loadStart = Date.now()
const bank = loadVoicebank(bankDir)
const loadMs = Date.now() - loadStart
console.log(`  dir ${bank.meta.dir}`)
console.log(`  oto.ini files ${bank.meta.otoFiles.length}, entries ${bank.meta.entries}, usable ${bank.meta.syllables}, ` +
  `wav files ${bank.meta.files}, missing (subset bank) ${bank.meta.missingEntries}`)
console.log(`  sample rate ${bank.meta.sampleRate} Hz, base syllables: ${bank.meta.names.filter((n) => !n.endsWith('+') && !n.endsWith(' R')).join(' ')}`)
console.log(`  load ${loadMs} ms`)
check('bank loaded', bank.syllables.size > 0)
check('bank rate is 44.1 kHz', bank.meta.sampleRate === 44100, `${bank.meta.sampleRate}`)
check('onset aliases parsed', bank.syllables.has('- a'), 'missing alias "- a"')
check('sustain alias parsed', bank.syllables.has('a+'), 'missing alias "a+"')
check('pitch suffix parsed', Math.abs((bank.syllables.get('- a_A4')?.pitchHz ?? 0) - 440) < 0.1)

// The bank's own pitch labels ("A3", "A4", "D5") are an outside opinion about the
// recording. Comparing them with our measurement is evidence in both directions:
// the deltas below are measured, and for this bank they are large, which is why
// the renderer must trust its ears rather than the labels.
console.log('\n-- measured take pitch vs the bank\'s labels (raw recording) --')
const takePitches = []
for (const alias of ['- a_A3', '- a_A4', '- a_D5']) {
  const record = bank.syllables.get(alias)
  const target = midiToHz(noteMidiOfLabel(record.pitch))
  const measured = estimateF0(record.samples, record.sampleRate, Math.round(record.offsetMs / 1000 * record.sampleRate), Math.round(record.playEndMs / 1000 * record.sampleRate))
  takePitches.push({ record, measured: measured.f0Hz })
  console.log(`  ${alias.padEnd(8)} label ${record.pitch} = ${target.toFixed(2)} Hz, measured ${measured.f0Hz.toFixed(2)} Hz ` +
    `(${cents(measured.f0Hz, target).toFixed(1)} cents, ${measured.frames} frames)`)
  check(`${alias} is measurable`, measured.f0Hz > 0)
}
takePitches.push({
  record: bank.syllables.get('- a'),
  measured: estimateF0(bank.syllables.get('- a').samples, 44100, Math.round(bank.syllables.get('- a').offsetMs / 1000 * 44100), Math.round(bank.syllables.get('- a').playEndMs / 1000 * 44100)).f0Hz
})
const byOffset = takePitches.slice().sort((a, b) => a.record.offsetMs - b.record.offsetMs)
const ordered = byOffset.every((entry, i) => i === 0 || entry.measured > byOffset[i - 1].measured)
check('take pitches rise with file offset (sanity)', ordered, byOffset.map((e) => `${e.record.alias}@${e.measured.toFixed(1)}`).join(' < '))

/* ---- 3. five-note scale ---- */

console.log('\n-- five-note scale (sustained "a") --')
const scaleNotes = parseNoteScript('C4:1 D4:1 E4:1 G4:1 A4:2')
const scaleStart = Date.now()
const scale = renderVoicebank(
  { notes: scaleNotes.map((note) => ({ midi: note.midi, note: note.note, duration: note.beats })), syllables: ['a'], bpm: 120 },
  { bank, seed: 7 }
)
const scaleMs = Date.now() - scaleStart
console.log(`  rendered ${scale.samples.length} frames = ${(scale.samples.length / scale.sampleRate).toFixed(3)} s in ${scaleMs} ms`)

let worstMedian = 0
let worstInstant = 0
for (const timing of scale.syllableTimings) {
  const target = midiToHz(timing.midi)
  // Measure the sustained part only: the recorded attack scoops into the note by
  // design, so including it would measure the recording, not the transposition.
  const from = Math.round((timing.startSeconds + timing.durationSeconds * 0.35) * scale.sampleRate)
  const to = Math.round((timing.startSeconds + timing.durationSeconds * 0.92) * scale.sampleRate)
  const median = estimateF0(scale.samples, scale.sampleRate, from, to)
  const perFrame = []
  for (let at = from; at + 2048 <= to; at += 1024) {
    const frame = measureF0(scale.samples, scale.sampleRate, at, 2048)
    if (frame.f0Hz > 0) perFrame.push(cents(frame.f0Hz, target))
  }
  const low = perFrame.length > 0 ? Math.min(...perFrame) : 0
  const high = perFrame.length > 0 ? Math.max(...perFrame) : 0
  const error = cents(median.f0Hz, target)
  worstMedian = Math.max(worstMedian, Math.abs(error))
  worstInstant = Math.max(worstInstant, Math.abs(low), Math.abs(high))
  console.log(`  ${timing.noteName.padEnd(3)} ${String(timing.midi).padStart(3)} ${timing.alias.padEnd(7)} ` +
    `tune ${error.toFixed(1).padStart(6)} cents  instant ${low.toFixed(1)}..${high.toFixed(1)}  ` +
    `loop ${String(timing.looped).padEnd(5)} source ${timing.sourceF0Hz.toFixed(1)} Hz`)
}
console.log(`  worst median error ${worstMedian.toFixed(1)} cents, worst single frame ${worstInstant.toFixed(1)} cents`)
check('scale pitch error <= 30 cents per note', worstMedian <= 30, `worst ${worstMedian.toFixed(1)} cents`)

/* ---- 4. phrase with consonants ---- */

console.log('\n-- phrase with consonants --')
const phraseNotes = parseNoteScript('C4:1 C4:1 D4:1 E4:2')
const phraseStart = Date.now()
const phrase = renderVoicebank(
  {
    notes: phraseNotes.map((note) => ({ midi: note.midi, note: note.note, duration: note.beats })),
    syllables: ['ka', 'la', 'ma', 'na'],
    bpm: 120
  },
  { bank, seed: 3 }
)
const phraseMs = Date.now() - phraseStart
console.log(`  rendered ${(phrase.samples.length / phrase.sampleRate).toFixed(3)} s in ${phraseMs} ms`)
console.log('  ' + phrase.syllableTimings.map((t) => `${t.syllable}:${t.noteName}(${t.alias})`).join(' '))
check('phrase used one take per syllable', phrase.syllableTimings.every((t) => t.alias !== null))
check('phrase syllables match the plan', phrase.syllableTimings.map((t) => t.syllable).join(',') === 'ka,la,ma,na')
check('phrase takes are onsets (so the consonant is kept)', phrase.syllableTimings.every((t) => t.alias.startsWith('- ')), phrase.syllableTimings.map((t) => t.alias).join(' '))

/* ---- 5. discontinuities ---- */

console.log('\n-- discontinuities --')

/** Steepest sample-to-sample step, normalised to peak 1 so renders compare. */
function maxStep (samples, from = 0, to = samples.length) {
  let peak = 0
  for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak <= 0) return 0
  let step = 0
  for (let i = from + 1; i < to; i += 1) step = Math.max(step, Math.abs(samples[i] - samples[i - 1]))
  return step / peak
}

const sourceRecord = bank.syllables.get('- a')
const sourceStep = maxStep(sourceRecord.samples)
const scaleStep = maxStep(scale.samples)
const phraseStep = maxStep(phrase.samples)
console.log(`  steepest step: raw recording ${sourceStep.toFixed(4)}, scale ${scaleStep.toFixed(4)}, phrase ${phraseStep.toFixed(4)} (normalised)`)
check('scale adds no step above the recording', scaleStep <= sourceStep * 1.25, `${scaleStep.toFixed(4)} vs ${sourceStep.toFixed(4)}`)
check('phrase adds no step above the recording', phraseStep <= sourceStep * 1.25, `${phraseStep.toFixed(4)} vs ${sourceStep.toFixed(4)}`)

/** Longest run of near-silence inside the sounding note spans. */
function longestGap (samples, sampleRate, spans) {
  const window = Math.round(0.01 * sampleRate)
  let longest = 0
  for (const [from, to] of spans) {
    let run = 0
    for (let at = from; at + window <= to; at += window) {
      let energy = 0
      for (let i = 0; i < window; i += 1) energy += samples[at + i] * samples[at + i]
      const rms = Math.sqrt(energy / window)
      run = rms < 0.003 ? run + window : 0
      longest = Math.max(longest, run)
    }
  }
  return longest / sampleRate
}

const spans = scale.syllableTimings.map((t) => [
  Math.round(t.startSeconds * scale.sampleRate),
  Math.round((t.startSeconds + t.durationSeconds) * scale.sampleRate)
])
const gap = longestGap(scale.samples, scale.sampleRate, spans)
console.log(`  longest silent run inside a note: ${(gap * 1000).toFixed(1)} ms`)
check('no silence gap inside the notes', gap < 0.05, `${(gap * 1000).toFixed(1)} ms`)

/* ---- 6. determinism ---- */

console.log('\n-- determinism --')
const again = renderVoicebank(
  { notes: scaleNotes.map((note) => ({ midi: note.midi, note: note.note, duration: note.beats })), syllables: ['a'], bpm: 120 },
  { bank, seed: 7 }
)
let identical = again.samples.length === scale.samples.length
if (identical) {
  for (let i = 0; i < scale.samples.length; i += 1) {
    if (scale.samples[i] !== again.samples[i]) { identical = false; break }
  }
}
check('same plan + seed -> identical samples', identical)

const drifted = renderVoicebank(
  { notes: scaleNotes.map((note) => ({ midi: note.midi, note: note.note, duration: note.beats })), syllables: ['a'], bpm: 120 },
  { bank, seed: 9, driftCents: 12 }
)
let differs = false
for (let i = 0; i < Math.min(scale.samples.length, drifted.samples.length); i += 1) {
  if (Math.abs(scale.samples[i] - drifted.samples[i]) > 1e-6) { differs = true; break }
}
check('different seed with drift -> different samples', differs)

/* ---- 7. write the scale for a human to hear ---- */

const bytes = encodeWav([scale.samples], scale.sampleRate, { dither: false })
await mkdir(outDir, { recursive: true })
await import('node:fs/promises').then((fs) => fs.writeFile(outPath, bytes))
const decoded = decodeWav(bytes)
console.log(`\nwrote ${outPath} (${bytes.length} bytes, ${decoded.durationSeconds.toFixed(3)} s, ${decoded.sampleRate} Hz)`)
check('wav roundtrip', Math.abs(decoded.durationSeconds - scale.samples.length / scale.sampleRate) < 0.01)

console.log(`\nrender time: scale ${scaleMs} ms, phrase ${phraseMs} ms, load ${loadMs} ms`)
console.log(failures === 0 ? '\nOK: all checks passed' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

/** MIDI number of an alias pitch label such as `A4`. */
function noteMidiOfLabel (label) {
  if (!label) return 69
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(label)
  if (!match) return 69
  const offsets = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  return offsets[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + (Number(match[3]) + 1) * 12
}
