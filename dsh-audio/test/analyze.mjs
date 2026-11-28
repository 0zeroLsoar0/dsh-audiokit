/**
 * Analysis tests.
 *
 * Every assertion is against a signal whose truth is known — the frequency it
 * was generated at, the RT60 that was applied to it, the vowel formants the
 * singer renders from — never against a previous run of the same code. A test
 * that only compares the analyser with itself would happily bless a wrong
 * number.
 *
 * Run: node test/analyze.mjs   (node path is in ../WORKERS.md)
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSound, compareSounds, describeReport } from '../lib/analyze.js'
import { registerAnalyzeTools } from '../lib/tools-analyze.js'
import { renderPreset, finalize, toWavBytes, writeFileAtomic } from '../lib/audio.js'
import { makeRng, noise } from '../lib/dsp.js'
import { VOWELS, renderSing, singPlan } from '../lib/sing.js'

const RATE = 44100
let failures = 0

function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

function fmt (value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '-'
}

/** First non-finite number anywhere in the report, as a path; null when clean. */
function findNonFinite (value, path = 'report') {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findNonFinite(value[index], `${path}[${index}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findNonFinite(value[key], `${path}.${key}`)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Band-limited harmonic stack: partial n at n·hz with amplitude 1/n, scaled to
 * `target` peak. With `rt60` set the amplitude envelope is 10^(-3t/rt60), i.e.
 * exactly -60 dB at t = rt60, which is the truth the decay fit is judged against.
 */
function harmonic (seconds, hz, partials, { rt60 = 0, target = 0.7 } = {}) {
  const frames = Math.round(seconds * RATE)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE
    const envelope = rt60 > 0 ? Math.pow(10, -3 * t / rt60) : 1
    let value = 0
    for (let n = 1; n <= partials; n += 1) value += Math.sin(2 * Math.PI * n * hz * t) / n
    out[i] = value * envelope
  }
  let peak = 0
  for (let i = 0; i < frames; i += 1) peak = Math.max(peak, Math.abs(out[i]))
  const scale = peak > 0 ? target / peak : 0
  for (let i = 0; i < frames; i += 1) out[i] *= scale
  return out
}

/* ------------------------------------------------------------- signals -- */

const sine440 = harmonic(3, 440, 1, { rt60: 1.6 })
const sine440Rt60 = 1.6
const harmonic440 = harmonic(3, 440, 6)
const saw220 = harmonic(3, 220, 40)
const white = noise(Math.round(3 * RATE), makeRng(20240117))
const vowel = renderSing(
  singPlan({ notes: [{ midi: 57, dur: 2 }], bpm: 60, lyric: 'a' }),
  { seed: 3, vibrato: 0, formantScale: 1, space: 0 }
)
const impact = renderPreset({ preset: 'impact', seed: 5, duration: 1 })
// A preset renders hot on purpose; finalize is what audio_synth writes to disk,
// so that is the signal whose peak a report should be judged on.
finalize(impact.samples, impact.sampleRate)

/* ------------------------------------------------------------- reports -- */

console.log(`-- signals at ${RATE} Hz --`)
const reportSine = analyzeSound(sine440, RATE)
const reportHarmonic = analyzeSound(harmonic440, RATE)
const reportSaw = analyzeSound(saw220, RATE, { maxHarmonics: 16 })
const reportNoise = analyzeSound(white, RATE)
const reportVowel = analyzeSound(vowel.samples, vowel.sampleRate)
const reportImpact = analyzeSound(impact.samples, impact.sampleRate)

console.log(
  `${'signal'.padEnd(24)}${'f0 Hz'.padStart(8)}${'conf'.padStart(6)}${'part'.padStart(5)}` +
  `${'tilt'.padStart(7)}${'flat'.padStart(7)}${'noisy'.padStart(7)}${'rt60'.padStart(7)}  formants Hz`
)
function printRow (label, report) {
  console.log(
    `${label.padEnd(24)}${fmt(report.f0.hz, 1).padStart(8)}${fmt(report.f0.confidence, 2).padStart(6)}` +
    `${String(report.harmonics.length).padStart(5)}${fmt(report.spectralTiltDbPerOctave, 1).padStart(7)}` +
    `${fmt(report.flatness, 3).padStart(7)}${fmt(report.noisiness, 2).padStart(7)}` +
    `${fmt(report.decay.rt60Seconds, 2).padStart(7)}  ${report.formants.map((row) => fmt(row.hz, 0)).join(' ') || '-'}`
  )
}
printRow('440 sine, rt60 1.6s', reportSine)
printRow('440 harmonic 1/n x6', reportHarmonic)
printRow('220 sawtooth 1/n x40', reportSaw)
printRow('white noise', reportNoise)
printRow('vowel /a/ A3 (220 Hz)', reportVowel)
printRow('impact preset', reportImpact)

/* ------------------------------------------------------ 440 Hz pure tone -- */

console.log('\n-- 440 Hz sine with an applied 1.60 s exponential decay --')
{
  const truth = 440
  const errorPercent = Math.abs(reportSine.f0.hz - truth) / truth * 100
  console.log(`f0 ${reportSine.f0.hz} Hz (${reportSine.f0.confidence} ${reportSine.f0.method}) = ${fmt(errorPercent, 3)} % error`)
  check('f0 within 0.5 %', errorPercent <= 0.5, `${fmt(errorPercent, 3)} %`)
  check('f0 confidence is high', reportSine.f0.confidence >= 0.5, String(reportSine.f0.confidence))

  // A pure sine has no 1/n partials. What is asserted here is that the analyser
  // lists the partials it was asked for and does not invent level for them; the
  // 1/n check runs on the harmonic tone below, where that truth actually holds.
  console.log(`partials ${reportSine.harmonics.map((row) => `${row.n}:${fmt(row.relDb, 1)}dB`).join(' ')}`)
  check('at least 3 partials listed', reportSine.harmonics.length >= 3, String(reportSine.harmonics.length))
  const invented = reportSine.harmonics.slice(1).filter((row) => row.relDb > -60)
  check('no invented partials above -60 dB', invented.length === 0, JSON.stringify(invented.map((row) => row.relDb)))

  console.log(`flatness ${reportSine.flatness} · noisiness ${reportSine.noisiness}`)
  check('flatness < 0.05', reportSine.flatness < 0.05, String(reportSine.flatness))
  check('noisiness < 0.2', reportSine.noisiness < 0.2, String(reportSine.noisiness))

  const rt60Error = Math.abs(reportSine.decay.rt60Seconds - sine440Rt60) / sine440Rt60 * 100
  console.log(`rt60 ${reportSine.decay.rt60Seconds} s vs applied ${sine440Rt60} s = ${fmt(rt60Error, 2)} % error ` +
    `(${reportSine.decay.curve}, fit R2 ${reportSine.decay.fitR2})`)
  check('rt60 within 10 %', rt60Error <= 10, `${fmt(rt60Error, 2)} %`)
  check('decay named exponential', reportSine.decay.curve === 'exp', reportSine.decay.curve)
  check('decay fit is tight', reportSine.decay.fitR2 > 0.99, String(reportSine.decay.fitR2))
}

/* -------------------------------------------------- 440 Hz harmonic tone -- */

console.log('\n-- 440 Hz harmonic tone (partial n at 1/n) --')
{
  const rows = reportHarmonic.harmonics.slice(0, 4)
  console.log(`partials ${rows.map((row) => `${row.n}:${fmt(row.hz, 1)}Hz ${fmt(row.relDb, 2)}dB`).join(' ')}`)
  check('partials listed', rows.length === 4, String(rows.length))
  let worst = 0
  for (const row of rows) {
    const expected = -20 * Math.log10(row.n)
    const error = Math.abs(row.relDb - expected)
    worst = Math.max(worst, error)
    check(`partial ${row.n} is 1/n (${fmt(expected, 2)} dB)`, error <= 2.5, `got ${row.relDb} dB`)
  }
  console.log(`worst 1/n deviation ${fmt(worst, 2)} dB`)
  check('fundamental at 441.0 Hz (refined)', Math.abs(reportHarmonic.f0.hz - 440) / 440 <= 0.005, String(reportHarmonic.f0.hz))
  check('flatness < 0.05', reportHarmonic.flatness < 0.05, String(reportHarmonic.flatness))
}

/* -------------------------------------------------------- sawtooth 220 -- */

console.log('\n-- 220 Hz sawtooth (40 partials, 1/n) --')
{
  const errorPercent = Math.abs(reportSaw.f0.hz - 220) / 220 * 100
  console.log(`f0 ${reportSaw.f0.hz} Hz = ${fmt(errorPercent, 3)} % error · inharmonicity ${reportSaw.inharmonicity} cents`)
  check('f0 within 0.5 %', errorPercent <= 0.5, `${fmt(errorPercent, 3)} %`)
  check('inharmonicity under 5 cents for an exact stack', reportSaw.inharmonicity < 5, String(reportSaw.inharmonicity))

  const strong = reportSaw.harmonics.filter((row) => row.relDb > -40)
  console.log(`partials above -40 dB: ${strong.length} (levels ${strong.map((row) => fmt(row.relDb, 1)).join(' ')})`)
  check('at least 8 partials above -40 dB', strong.length >= 8, String(strong.length))
  console.log(`tilt ${reportSaw.spectralTiltDbPerOctave} dB/oct`)
  check('tilt is negative (a 1/n stack darkens)', reportSaw.spectralTiltDbPerOctave < -1, String(reportSaw.spectralTiltDbPerOctave))
}

/* ------------------------------------------------------------ noise -- */

console.log('\n-- white noise --')
{
  console.log(`f0 ${reportNoise.f0.hz} Hz confidence ${reportNoise.f0.confidence} (${reportNoise.f0.method}) · ` +
    `flatness ${reportNoise.flatness} · noisiness ${reportNoise.noisiness} · tilt ${reportNoise.spectralTiltDbPerOctave} dB/oct`)
  check('no confident pitch', reportNoise.f0.confidence < 0.5, String(reportNoise.f0.confidence))
  check('no pitch invented', reportNoise.f0.hz === 0, String(reportNoise.f0.hz))
  check('flatness > 0.5', reportNoise.flatness > 0.5, String(reportNoise.flatness))
  check('noisiness high', reportNoise.noisiness > 0.6, String(reportNoise.noisiness))
  check('tilt near flat', Math.abs(reportNoise.spectralTiltDbPerOctave) < 1.5, String(reportNoise.spectralTiltDbPerOctave))
}

/* ------------------------------------------------------------ vowel -- */

console.log('\n-- vowel /a/ rendered by lib/sing.js at A3 (220 Hz) --')
{
  // The truth is the vowel table the renderer itself uses.
  const first = VOWELS.a.f1
  const second = VOWELS.a.f2
  const closest = (target) => reportVowel.formants.reduce(
    (best, row) => (Math.abs(row.hz - target) < Math.abs(best - target) ? row.hz : best),
    Infinity
  )
  const foundFirst = closest(first)
  const foundSecond = closest(second)
  console.log(`f0 ${reportVowel.f0.hz} Hz (${reportVowel.f0.confidence}) · ` +
    `onset latency ${reportVowel.onset.latencyMs} ms · attack ${reportVowel.onset.attackMs} ms · ${reportVowel.onset.type}`)
  console.log(`formants ${reportVowel.formants.map((row) => `${fmt(row.hz, 0)}Hz/${fmt(row.bandwidthHz, 0)}Hz`).join(' ')}`)
  console.log(`closest to F1 ${first} Hz -> ${foundFirst} Hz (${fmt((foundFirst - first) / first * 100, 1)} %) · ` +
    `closest to F2 ${second} Hz -> ${foundSecond} Hz (${fmt((foundSecond - second) / second * 100, 1)} %)`)
  check('f0 is the sung A3', Math.abs(reportVowel.f0.hz - 220) / 220 <= 0.01, String(reportVowel.f0.hz))
  check('F1 within 20 %', Math.abs(foundFirst - first) / first <= 0.2, `${foundFirst} Hz vs ${first} Hz`)
  check('F2 within 20 %', Math.abs(foundSecond - second) / second <= 0.2, `${foundSecond} Hz vs ${second} Hz`)
  check('formants are sorted ascending', reportVowel.formants.every((row, index) => index === 0 || reportVowel.formants[index - 1].hz < row.hz))
  check('no NaN in the report', findNonFinite(reportVowel) === null, findNonFinite(reportVowel) ?? '')
  // The alto preset attacks over 32 ms, so the 10-90 % rise must be of that
  // order and the sound must read as a held note, not a hit.
  check('attack reflects the sung 32 ms rise', reportVowel.onset.attackMs > 10 && reportVowel.onset.attackMs < 90,
    `${reportVowel.onset.attackMs} ms`)
  check('a held vowel reads as sustained', reportVowel.onset.type === 'sustained', reportVowel.onset.type)
}

/* ----------------------------------------------------------- impact -- */

console.log('\n-- percussive hit (renderPreset impact) --')
{
  console.log(`onset latency ${reportImpact.onset.latencyMs} ms · attack ${reportImpact.onset.attackMs} ms · type ${reportImpact.onset.type}`)
  console.log(`decay rt60 ${reportImpact.decay.rt60Seconds} s (${reportImpact.decay.curve}, fit R2 ${reportImpact.decay.fitR2})`)
  console.log(`formants ${reportImpact.formants.map((row) => `${fmt(row.hz, 0)}Hz`).join(' ') || '-'} · bands ` +
    `${reportImpact.bands.map((band) => `${band.name} ${fmt(band.relDb, 0)}`).join(' ')}`)
  check('onset latency is small', reportImpact.onset.latencyMs <= 25, `${reportImpact.onset.latencyMs} ms`)
  check('a hit reads as percussive', reportImpact.onset.type === 'percussive', reportImpact.onset.type)
  check('decay is finite', Number.isFinite(reportImpact.decay.rt60Seconds), String(reportImpact.decay.rt60Seconds))
  check('decay has a measured tail', reportImpact.decay.rt60Seconds > 0.05, String(reportImpact.decay.rt60Seconds))
  check('no NaN anywhere', findNonFinite(reportImpact) === null, findNonFinite(reportImpact) ?? '')
  check('signal starts at 0 dB-ish peak', reportImpact.peakDbfs > -3 && reportImpact.peakDbfs <= 0.5, String(reportImpact.peakDbfs))
}

/* ------------------------------------------- comparison (character) -- */

console.log('\n-- compareSounds --')
{
  const same = compareSounds(reportVowel, analyzeSound(vowel.samples, vowel.sampleRate))
  console.log(`vowel vs identical vowel: pass=${same.pass} rows=${same.rows.length} failed=${same.failed.length}`)
  check('identical sounds pass', same.pass === true, JSON.stringify(same.failed))
  check('every row passed', same.rows.every((row) => row.status !== 'fail'), JSON.stringify(same.failed))

  // Same envelope, same timbre shape, pitch three semitones up: the F0 row has
  // to fail and has to name itself.
  const shifted = harmonic(3, 440 * 2 ** (3 / 12), 6)
  const shiftedReport = analyzeSound(shifted, RATE)
  const changed = compareSounds(reportHarmonic, shiftedReport)
  console.log(`440 tone vs +3 semitones: pass=${changed.pass} failed=${JSON.stringify(changed.failed)}`)
  for (const row of changed.rows.slice(0, 6)) {
    console.log(`  ${row.metric.padEnd(28)} a=${fmt(row.a, 2)} b=${fmt(row.b, 2)} delta=${fmt(row.delta, 2)} ` +
      `allowed=${fmt(row.tolerance, 2)} ${row.status} ${row.spec ?? ''}`)
  }
  check('a pitch change fails', changed.pass === false)
  check('the f0 row fails', changed.failed.includes('f0.hz'), JSON.stringify(changed.failed))
  check('f0 delta is the three semitones', Math.abs((changed.rows[0].delta) - (440 * (2 ** (3 / 12) - 1))) < 2,
    String(changed.rows[0].delta))
  const shiftedTolerance = compareSounds(reportHarmonic, shiftedReport, { 'f0.hz': { relative: 0.5 } })
  check('tolerance override is honoured', shiftedTolerance.rows[0].status === 'pass', JSON.stringify(shiftedTolerance.rows[0]))

  // Two unvoiced sounds have no pitch to compare: the F0 row must skip rather
  // than divide 0 by 0, and the rest must still pass.
  const noiseBoth = compareSounds(reportNoise, analyzeSound(white, RATE))
  console.log(`noise vs identical noise: pass=${noiseBoth.pass} f0 row=${noiseBoth.rows[0].status} (${noiseBoth.rows[0].note})`)
  check('two noises pass', noiseBoth.pass === true, JSON.stringify(noiseBoth.failed))
  check('pitch row is skipped, not failed', noiseBoth.rows[0].status === 'skip', noiseBoth.rows[0].status)
}

/* ------------------------------------------------------------ describe -- */

console.log('\n-- describeReport --')
{
  const text = describeReport(reportVowel)
  console.log(text.split('\n').map((line) => `  ${line}`).join('\n'))
  const lines = text.split('\n')
  check('one line per aspect', lines.length >= 7, String(lines.length))
  for (const aspect of ['duration', 'f0', 'harmonics', 'tilt', 'formants', 'decay', 'onset', 'bands']) {
    check(`text mentions ${aspect}`, text.includes(aspect))
  }
  check('text has no NaN', !/NaN|Infinity|undefined/.test(text))
}

/* ----------------------------------------------------- determinism/perf -- */

console.log('\n-- determinism and performance --')
{
  const first = JSON.stringify(analyzeSound(white, RATE))
  const second = JSON.stringify(analyzeSound(white, RATE))
  console.log(`two runs of a 3 s noise report: ${first === second ? 'identical' : 'DIFFERENT'} (${first.length} bytes of JSON)`)
  check('same input, same numbers', first === second)

  const started = process.hrtime.bigint()
  const timed = analyzeSound(harmonic(3, 330, 10), RATE)
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`3.00 s at ${RATE} Hz analysed in ${fmt(milliseconds, 1)} ms (budget 150 ms)`)
  check('under 150 ms', milliseconds < 150, `${fmt(milliseconds, 1)} ms`)
  check('timed report is sane', timed.f0.hz > 0 || timed.f0.confidence === 0)
}

/* --------------------------------------------------------------- edges -- */

console.log('\n-- edges --')
{
  const empty = analyzeSound(new Float32Array(0), RATE)
  check('empty input: duration 0', empty.durationSeconds === 0, String(empty.durationSeconds))
  check('empty input: no NaN', findNonFinite(empty) === null, findNonFinite(empty) ?? '')
  const silent = analyzeSound(new Float32Array(RATE), RATE)
  check('silence: no pitch', silent.f0.hz === 0 && silent.f0.confidence === 0)
  check('silence: no NaN', findNonFinite(silent) === null, findNonFinite(silent) ?? '')
  check('silence: type silent', silent.onset.type === 'silent', silent.onset.type)
  const short = analyzeSound(new Float32Array(sine440.subarray(0, 512)), RATE)
  check('512-sample input does not throw or produce NaN', findNonFinite(short) === null, findNonFinite(short) ?? '')
  const fromArray = analyzeSound(Array.from(sine440.subarray(0, 8192)), RATE)
  console.log(`plain number[] input: f0 ${fmt(fromArray.f0.hz, 1)} Hz, ${fromArray.durationSeconds} s`)
  check('a plain number[] is accepted', Math.abs(fromArray.f0.hz - 440) / 440 <= 0.01, String(fromArray.f0.hz))
  check('a plain number[] gives the same character', fromArray.flatness < 0.05, String(fromArray.flatness))
}

/* ------------------------------------------------ non-finite samples -- */

console.log('\n-- non-finite samples read as silence --')
{
  // A Float32Array used to be returned to the analyser untouched: one NaN made
  // the frame energy NaN, so the spectrum collapsed and centroid/flatness came
  // back as the round() fallback 0 while the peak/rms were meaningless. The
  // contract is the same one the Float64Array/number[] paths already had — a
  // non-finite sample is silence — so the poisoned buffer must analyse exactly
  // like the same buffer with those samples zeroed.
  const clean = Float32Array.from(harmonic440.subarray(0, RATE))
  const dirty = Float32Array.from(clean)
  const poisoned = [0, 7, Math.floor(clean.length / 2)]
  dirty[poisoned[0]] = NaN
  dirty[poisoned[1]] = Infinity
  dirty[poisoned[2]] = -Infinity
  const zeroed = Float32Array.from(clean)
  for (const index of poisoned) zeroed[index] = 0
  const dirtyReport = analyzeSound(dirty, RATE)
  const zeroedReport = analyzeSound(zeroed, RATE)
  console.log(`NaN/Infinity input: f0 ${fmt(dirtyReport.f0.hz, 1)} Hz, centroid ${fmt(dirtyReport.centroidHz, 0)} Hz, ` +
    `flatness ${dirtyReport.flatness}, harmonics ${dirtyReport.harmonics.length}, peak ${fmt(dirtyReport.peakDbfs, 2)} dBFS, rms ${fmt(dirtyReport.rmsDbfs, 2)} dBFS`)
  check('a poisoned buffer is not the silent report', dirtyReport.centroidHz > 0 && dirtyReport.harmonics.length > 0,
    `centroid ${dirtyReport.centroidHz}, harmonics ${dirtyReport.harmonics.length}`)
  check('poison reads as silence (same report as the zeroed buffer)', JSON.stringify(dirtyReport) === JSON.stringify(zeroedReport),
    'reports differ')
  check('peak and rms stay finite around the poison', Number.isFinite(dirtyReport.peakDbfs) && Number.isFinite(dirtyReport.rmsDbfs) &&
    dirtyReport.peakDbfs === zeroedReport.peakDbfs && dirtyReport.rmsDbfs === zeroedReport.rmsDbfs,
  `${dirtyReport.peakDbfs}/${dirtyReport.rmsDbfs}`)
  check('flatness is measured rather than zeroed', dirtyReport.flatness === zeroedReport.flatness && dirtyReport.flatness >= 0,
    String(dirtyReport.flatness))
  // Flatness is only meaningfully non-zero on a broadband signal (a 1/n stack
  // rounds to 0.0000 by nature, not because of the poison), so the "not zero"
  // half of this contract is checked on noise.
  const dirtyNoise = Float32Array.from(white)
  const zeroedNoise = Float32Array.from(white)
  for (const index of [0, 1000, 40000]) {
    dirtyNoise[index] = index === 0 ? NaN : index === 1000 ? Infinity : -Infinity
    zeroedNoise[index] = 0
  }
  const dirtyNoiseReport = analyzeSound(dirtyNoise, RATE)
  const zeroedNoiseReport = analyzeSound(zeroedNoise, RATE)
  console.log(`poisoned noise: centroid ${fmt(dirtyNoiseReport.centroidHz, 0)} Hz, flatness ${dirtyNoiseReport.flatness}, ` +
    `noisiness ${dirtyNoiseReport.noisiness}, peak ${fmt(dirtyNoiseReport.peakDbfs, 2)} dBFS`)
  check('poisoned noise keeps a real centroid and flatness', dirtyNoiseReport.centroidHz > 0 && dirtyNoiseReport.flatness > 0.3,
    `centroid ${dirtyNoiseReport.centroidHz}, flatness ${dirtyNoiseReport.flatness}`)
  check('poisoned noise matches the zeroed buffer', JSON.stringify(dirtyNoiseReport) === JSON.stringify(zeroedNoiseReport))
  const dirtyCentroid = analyzeSound((() => { const buffer = Float32Array.from(clean); buffer[3] = NaN; return buffer })(), RATE)
  check('a single NaN does not hide the pitch', Math.abs(dirtyCentroid.f0.hz - 440) / 440 <= 0.01 && dirtyCentroid.f0.confidence > 0.5,
    `${dirtyCentroid.f0.hz} Hz @ ${dirtyCentroid.f0.confidence}`)
}

/* ----------------------------------------------------------- tool layer -- */

console.log('\n-- audio_analyze tool --')
{
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-analyze-'))
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  const exec = { agent: { session: { id: 'test' } } }
  registerAnalyzeTools(ctx)
  const call = (args) => registered.get('audio_analyze').execute(args, exec)
  check('registers audio_analyze', registered.has('audio_analyze'), [...registered.keys()].join(','))

  const fromRender = await call({ render: { preset: 'chime', duration: 1.5, seed: 2 }, out: 'ear/chime.json' })
  console.log(`render form: ${fromRender.relativePath} f0=${fmt(fromRender.f0Hz, 1)} Hz conf=${fmt(fromRender.f0Confidence, 2)} ` +
    `formants=${fromRender.formantHz.map((hz) => fmt(hz, 0)).join('/') || '-'}`)
  check('render form returns a report', Number.isFinite(fromRender.report.f0.hz), String(fromRender.report.f0.hz))
  check('wrote the JSON report', fromRender.relativePath === 'ear/chime.json', String(fromRender.relativePath))
  const payload = JSON.parse(await readFile(join(cwd, 'ear/chime.json'), 'utf8'))
  check('JSON payload carries the report', payload.format === 'dsh-audio-analyze' && payload.report.f0.hz === fromRender.report.f0.hz)
  check('text is the description block', fromRender.text.includes('f0') && fromRender.text.includes('decay'))

  await writeFileAtomic(join(cwd, 'tone.wav'), toWavBytes(harmonic(1.5, 440, 6, { target: 0.5 }), RATE))
  const fromPath = await call({ path: 'tone.wav', maxHarmonics: 4 })
  console.log(`path form: f0=${fmt(fromPath.f0Hz, 2)} Hz partials=${fromPath.report.harmonics.length}`)
  check('path form finds the tone', Math.abs(fromPath.f0Hz - 440) / 440 <= 0.01, String(fromPath.f0Hz))
  check('maxHarmonics bounds the list', fromPath.report.harmonics.length === 4, String(fromPath.report.harmonics.length))
  check('no file written without out', fromPath.path === null, String(fromPath.path))

  const shiftedWav = await call({ path: 'tone.wav', f0Range: [10, 5000] })
  check('f0Range is clamped, not rejected', Math.abs(shiftedWav.f0Hz - 440) / 440 <= 0.01, String(shiftedWav.f0Hz))
  await writeFileAtomic(join(cwd, 'low.wav'), toWavBytes(harmonic(1.5, 220, 10, { target: 0.5 }), RATE))
  const outOfRange = await call({ path: 'low.wav', f0Range: [600, 1200] })
  console.log(`f0Range [600,1200] on a 220 Hz tone -> ${fmt(outOfRange.f0Hz, 1)} Hz`)
  check('the search range is honoured', Math.abs(outOfRange.f0Hz - 220) > 11, String(outOfRange.f0Hz))

  const compared = await call({ path: 'tone.wav', compareWith: { render: { preset: 'impact', duration: 1, seed: 5 } } })
  console.log(compared.text)
  check('compareWith returns a table', compared.comparison !== null && compared.comparison.rows.length > 8, String(compared.comparison?.rows.length))
  check('comparison text is a table', compared.text.includes('metric') && compared.text.includes('verdict'))
  check('a tone vs a hit does not pass', compared.comparison.pass === false, JSON.stringify(compared.comparison.failed))

  const comparedPath = await call({ path: 'tone.wav', compareWith: 'low.wav', tolerances: { 'f0.hz': { relative: 2 } } })
  check('compareWith accepts a path string', comparedPath.comparison !== null)
  check('a wide f0 tolerance passes that row', comparedPath.comparison.rows[0].status === 'pass',
    JSON.stringify(comparedPath.comparison.rows[0]))

  let missing = ''
  try {
    await call({})
  } catch (error) {
    missing = error.message
  }
  check('rejects a call with no source', /needs either path/.test(missing), missing)

  let unreadable = ''
  try {
    await call({ path: 'tone.wav', compareWith: { path: 'nope.wav' } })
  } catch (error) {
    unreadable = error.message
  }
  check('names the unreadable compare file', /cannot read/.test(unreadable), unreadable)

  await rm(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nOK: analysis behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
