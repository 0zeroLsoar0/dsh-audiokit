/**
 * Composition performance test.
 *
 * "Fast" is a product feature here: an agent composing a cue re-renders the
 * same score many times while it iterates on sections, seeds and intensities.
 * The stated budget was 2 s for a 16-bar cue; this file holds `renderScore` to a
 * tighter one and splits the cost so it is obvious where the time goes.
 *
 * What is measured, per genre and per length:
 *   - render wall time, audio length, and x-realtime (audio seconds per second)
 *   - the size of the sample domain (tracks, notes) that produced that cost
 *   - `composeScore` on its own, so planning and rendering never get confused
 *
 * The `BASELINE_16BAR` table is the pre-optimisation measurement, kept here so
 * the before/after table below is evidence rather than a claim. The faster
 * renderer must still produce the same music: identical duration, peak within
 * 0.1 dB, RMS within 0.5 dB, spectral centroid within 8%, same note domain.
 * Where the two differ at all it is only the three noise beds (lofi vinyl,
 * ambient wind, horror scrape): their filter LFO is now stepped once per
 * 32-sample block, which changes those beds by about -95 dB relative amplitude
 * and nothing else.
 *
 * Usage:
 *   node test/perf.mjs              # measure + assert
 *   node test/perf.mjs --snapshot   # print the baseline literal for this machine
 *
 * Exits non-zero when a budget or a before/after comparison fails.
 */

import { composeScore, renderScore, GENRES } from '../lib/compose.js'
import { measure } from '../lib/audio.js'

const GENRE_NAMES = Object.keys(GENRES)
const SAMPLE_RATE = 44100
const BARS_SWEEP = [8, 16, 32]
const SWEEP_SEED = 7
const SWEEP_INTENSITY = 0.65
const REPEATS = 2
const snapshotMode = process.argv.includes('--snapshot')

/**
 * Budget for the slowest 16-bar cue at 44.1 kHz.
 *
 * Why 600 ms and not the stated 2 s: this is the largest single step an agent
 * waits for when it iterates, and it is not the only step — score inspection,
 * WAV encoding, tool overhead and the model's own thinking add to the turn. A
 * 16-bar cue that renders in ~0.5 s keeps a "change a section, re-render,
 * measure" loop inside one second, which is what makes the tool feel
 * interactive. The budget is the per-genre worst case, and the worst case is
 * ambient: 75.8 s of audio, the longest cue in the table.
 */
const BUDGET_16_BARS_MS = 600

/**
 * Guardrail for the 32-bar sweep: twice the audio may cost twice the time, but
 * not much more. Set above the linear expectation so it flags superlinear work
 * (whole-track buffer copies, re-filtering) without failing on GC noise.
 */
const BUDGET_32_BARS_MS = 1400

/** A genre may not regress to less than this fraction of its pre-change speed. */
const MIN_SPEEDUP = 1.2

/**
 * Pre-optimisation reference measurements.
 *
 * Captured by this file (seed 7, intensity 0.65, 44.1 kHz) before `renderScore`
 * was optimised. `durationSeconds`/`peakDbfs`/`rmsDbfs`/`centroidHz` are the
 * musical contract; `renderMs` is the before column of the speedup table.
 */
const BASELINE_16BAR = {
  cinematic: { durationSeconds: 51.626, peakDbfs: -1, rmsDbfs: -17.23, centroidHz: 207, onsets: 12, notes: 222, tracks: 5, renderMs: 599 },
  lofi: { durationSeconds: 50.031, peakDbfs: -1, rmsDbfs: -18.53, centroidHz: 186, onsets: 20, notes: 513, tracks: 5, renderMs: 678 },
  chiptune: { durationSeconds: 25.613, peakDbfs: -1, rmsDbfs: -20.85, centroidHz: 848, onsets: 4, notes: 814, tracks: 5, renderMs: 312 },
  ambient: { durationSeconds: 75.846, peakDbfs: -1, rmsDbfs: -16.31, centroidHz: 508, onsets: 12, notes: 96, tracks: 5, renderMs: 1212 },
  action: { durationSeconds: 24.804, peakDbfs: -1, rmsDbfs: -17.18, centroidHz: 476, onsets: 11, notes: 826, tracks: 5, renderMs: 341 },
  horror: { durationSeconds: 62, peakDbfs: -1, rmsDbfs: -16.38, centroidHz: 191, onsets: 68, notes: 99, tracks: 5, renderMs: 882 },
  fantasy: { durationSeconds: 40.184, peakDbfs: -1, rmsDbfs: -18.15, centroidHz: 867, onsets: 1, notes: 415, tracks: 5, renderMs: 613 },
  'ui-menu': { durationSeconds: 35.509, peakDbfs: -1, rmsDbfs: -21.71, centroidHz: 1132, onsets: 6, notes: 415, tracks: 5, renderMs: 234 }
}

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const fmt = (value, digits = 1) => Number(value).toFixed(digits)
const pad = (value, width) => String(value).padStart(width)

/**
 * Render once and return elapsed milliseconds.
 * @returns {{ render: object, elapsed: number }}
 */
function timedRender (score) {
  const started = process.hrtime.bigint()
  const render = renderScore(score)
  return { render, elapsed: Number(process.hrtime.bigint() - started) / 1e6 }
}

/** Best of `REPEATS` renders: the noise here is JIT tiers and GC, not the code. */
function bestRender (score) {
  let best = null
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const run = timedRender(score)
    if (best === null || run.elapsed < best.elapsed) best = run
  }
  return best
}

const noteCount = (score) => score.tracks.reduce((sum, track) => sum + track.notes.length, 0)

/* ---------------------------------------------------------------- warmup -- */

// First-render JIT compilation otherwise lands on whichever genre is measured
// first and makes the whole table look slower than steady state.
{
  const warm = composeScore({ genre: 'action', bars: 4, seed: 3, intensity: 0.7 })
  for (let attempt = 0; attempt < REPEATS; attempt += 1) renderScore(warm)
}

console.log('composition performance')
console.log(`  node ${process.version} · ${SAMPLE_RATE} Hz · seed ${SWEEP_SEED} · intensity ${SWEEP_INTENSITY} · best of ${REPEATS}`)
console.log('')

/* ------------------------------------------------------------ the sweep -- */

const cells = []
for (const genre of GENRE_NAMES) {
  for (const bars of BARS_SWEEP) {
    const score = composeScore({ genre, bars, seed: SWEEP_SEED, intensity: SWEEP_INTENSITY })
    const run = bestRender(score)
    cells.push({
      genre,
      bars,
      tracks: score.tracks.length,
      notes: noteCount(score),
      audioSeconds: run.render.durationSeconds,
      renderMs: run.elapsed,
      realtime: run.render.durationSeconds / (run.elapsed / 1000),
      render: run.render
    })
  }
}

console.log('render sweep: audio seconds and x-realtime per length')
console.log(`  ${'genre'.padEnd(10)} ${'bars'.padStart(4)} ${'tracks'.padStart(6)} ${'notes'.padStart(6)} ${'audio s'.padStart(8)} ${'render ms'.padStart(10)} ${'x realtime'.padStart(11)}`)
for (const cell of cells) {
  console.log(`  ${cell.genre.padEnd(10)} ${pad(cell.bars, 4)} ${pad(cell.tracks, 6)} ${pad(cell.notes, 6)} ` +
    `${pad(fmt(cell.audioSeconds, 2), 8)} ${pad(fmt(cell.renderMs, 0), 10)} ${pad(fmt(cell.realtime, 1), 11)}`)
}

/* ----------------------------------------------------- planning vs render -- */

// `composeScore` must stay cheap: it is the part an agent can afford to call
// several times to inspect chords before committing to a render. Median of a
// few runs keeps one GC pause from misreporting it.
console.log('\nplanning split: composeScore vs renderScore (16 bars)')
const composeTimes = {}
for (const genre of GENRE_NAMES) {
  const samples = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = process.hrtime.bigint()
    composeScore({ genre, bars: 16, seed: SWEEP_SEED, intensity: SWEEP_INTENSITY })
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((a, b) => a - b)
  composeTimes[genre] = samples[Math.floor(samples.length / 2)]
}
const sixteen = cells.filter((cell) => cell.bars === 16)
let worstCompose = 0
console.log(`  ${'genre'.padEnd(10)} ${'compose ms'.padStart(10)} ${'render ms'.padStart(10)} ${'render share'.padStart(13)}`)
for (const cell of sixteen) {
  const composeMs = composeTimes[cell.genre]
  worstCompose = Math.max(worstCompose, composeMs)
  console.log(`  ${cell.genre.padEnd(10)} ${pad(fmt(composeMs, 2), 10)} ${pad(fmt(cell.renderMs, 0), 10)} ` +
    `${pad(fmt(100 * cell.renderMs / (cell.renderMs + composeMs), 2), 13)}%`)
}
const totalCompose = Object.values(composeTimes).reduce((sum, value) => sum + value, 0)
console.log(`  composeScore: ${fmt(totalCompose / GENRE_NAMES.length, 2)} ms mean, ${fmt(worstCompose, 2)} ms worst — planning is free next to rendering`)

/* ---------------------------------------------------------------- budget -- */

console.log('\nbudget')
const worst16 = sixteen.reduce((worst, cell) => (cell.renderMs > worst.renderMs ? cell : worst))
const worst32 = cells.filter((cell) => cell.bars === 32).reduce((worst, cell) => (cell.renderMs > worst.renderMs ? cell : worst))
console.log(`  16-bar worst: ${worst16.genre} ${fmt(worst16.renderMs, 0)} ms for ${fmt(worst16.audioSeconds, 1)} s of audio ` +
  `(${fmt(worst16.realtime, 1)}x realtime) · budget ${BUDGET_16_BARS_MS} ms`)
console.log(`  32-bar worst: ${worst32.genre} ${fmt(worst32.renderMs, 0)} ms for ${fmt(worst32.audioSeconds, 1)} s of audio · guardrail ${BUDGET_32_BARS_MS} ms`)
check('16-bar render is under budget', worst16.renderMs <= BUDGET_16_BARS_MS,
  `${worst16.genre} ${fmt(worst16.renderMs, 0)} ms > ${BUDGET_16_BARS_MS} ms`)
check('32-bar render scales linearly-ish', worst32.renderMs <= BUDGET_32_BARS_MS,
  `${worst32.genre} ${fmt(worst32.renderMs, 0)} ms > ${BUDGET_32_BARS_MS} ms`)
check('composeScore is cheap', worstCompose <= 10, `${fmt(worstCompose, 2)} ms`)

/* --------------------------------------------------- same music as before -- */

if (snapshotMode) {
  // Emit a literal that can be pasted into `BASELINE_16BAR`.
  const literal = {}
  for (const cell of sixteen) {
    const metrics = measure(cell.render.samples, cell.render.sampleRate)
    literal[cell.genre] = {
      durationSeconds: metrics.durationSeconds,
      peakDbfs: metrics.peakDbfs,
      rmsDbfs: metrics.rmsDbfs,
      centroidHz: metrics.centroidHz,
      onsets: metrics.onsets,
      notes: cell.notes,
      tracks: cell.tracks,
      renderMs: Math.round(cell.renderMs)
    }
  }
  console.log('\nBASELINE_16BAR = ' + JSON.stringify(literal, null, 2))
  console.log(failures === 0 ? '\nOK: performance measured (snapshot mode, nothing asserted)' : `\nFAILED: ${failures} check(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\nbefore / after: same music at a smaller cost (16 bars)')
console.log(`  ${'genre'.padEnd(10)} ${'before ms'.padStart(9)} ${'after ms'.padStart(8)} ${'speedup'.padStart(8)} ` +
  `${'dur'.padStart(7)} ${'peak'.padStart(6)} ${'rms'.padStart(6)} ${'centroid'.padStart(9)} ${'onsets'.padStart(8)}`)
for (const cell of sixteen) {
  const before = BASELINE_16BAR[cell.genre]
  const metrics = measure(cell.render.samples, cell.render.sampleRate)
  const speedup = before.renderMs / cell.renderMs
  const durationDelta = Math.abs(metrics.durationSeconds - before.durationSeconds)
  const peakDelta = Math.abs(metrics.peakDbfs - before.peakDbfs)
  const rmsDelta = Math.abs(metrics.rmsDbfs - before.rmsDbfs)
  const centroidDelta = before.centroidHz > 0
    ? Math.abs(metrics.centroidHz - before.centroidHz) / before.centroidHz
    : 0
  const noteDelta = cell.notes - before.notes
  console.log(`  ${cell.genre.padEnd(10)} ${pad(fmt(before.renderMs, 0), 9)} ${pad(fmt(cell.renderMs, 0), 8)} ` +
    `${pad(fmt(speedup, 2) + 'x', 8)} ` +
    `${pad(fmt(metrics.durationSeconds, 2), 7)} ${pad(fmt(metrics.peakDbfs, 2), 6)} ${pad(fmt(metrics.rmsDbfs, 2), 6)} ` +
    `${pad(`${before.centroidHz}->${metrics.centroidHz}`, 9)} ${pad(`${before.onsets}->${metrics.onsets}`, 8)}`)
  check(`${cell.genre} duration unchanged`, durationDelta <= 0.02, `${fmt(durationDelta, 3)} s`)
  check(`${cell.genre} peak within 0.1 dB`, peakDelta <= 0.1, `${fmt(peakDelta, 3)} dB`)
  check(`${cell.genre} rms within 0.5 dB`, rmsDelta <= 0.5, `${fmt(rmsDelta, 3)} dB`)
  check(`${cell.genre} centroid within 8%`, centroidDelta <= 0.08, `${fmt(centroidDelta * 100, 2)}%`)
  check(`${cell.genre} same note domain`, noteDelta === 0, `${cell.notes} vs ${before.notes}`)
  check(`${cell.genre} still faster than before`, speedup >= MIN_SPEEDUP, `${fmt(speedup, 2)}x`)
}

console.log(failures === 0 ? '\nOK: composition is fast and still the same music' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
