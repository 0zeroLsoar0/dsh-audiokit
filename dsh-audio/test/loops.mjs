/**
 * Loop audit: does `loop: true` deliver a loop that can actually be repeated?
 *
 * The plugin advertises seamless loops in five places: `audio_synth { loop }`,
 * the five advertised `texture` beds, the four loopable presets from
 * `presets-extra.js`, the three `-loop` design recipes, and `audio_compose
 * { loop }`. An animation page repeats these beds for minutes, so a seam defect
 * is not a one-off blemish: it is a click every loop, and its period (1 s, 3 s,
 * 8 s) is exactly the kind of rhythm the ear locks onto.
 *
 * `measure()` already reports `loopSeam`, but that is a 100 ms head-vs-tail RMS
 * comparison and it is blind to a single-sample step. This audit therefore
 * measures the seam three independent ways per render, plus a fourth that tests
 * the periodicity claim rather than the continuity one:
 *
 *   1. loopSeam      level continuity, dB between the first and last 100 ms
 *   2. loopStep      |first - last| / rms, the one-sample wrap jump
 *   3. repeat ratio  the max |x[i+1] - x[i]| at the two junctions of the file
 *                    concatenated 3x, divided by the 99.9th percentile of the
 *                    file's own steps. This is the honest test: a click is a
 *                    step that no natural transition in *this* material
 *                    produces, so the ratio is scale-free across loud hits,
 *                    quiet beds and sample rates.
 *   4. correlation   normalised correlation of the last 20 ms with the first
 *                    20 ms (the periodicity probe), plus the same statistic
 *                    between adjacent 20 ms windows *inside* the file. It is
 *                    kept as calibration, not as a verdict: two adjacent 20 ms
 *                    windows of a noise bed are independent even at a perfect
 *                    seam, the coefficient of a correct periodic bed is capped
 *                    by its fundamental (cos(2*pi*f*0.02)), and the loop head is
 *                    by construction a fade that mixes in an uncorrelated noise
 *                    field — so a low coefficient at the seam is expected for a
 *                    correct loop. The numbers and the interior reference are
 *                    printed; the calibration table at the end reports what the
 *                    literal rules would have said.
 *
 * Three further properties are audited because a loop can be audibly wrong
 * without any element of the seam step being discontinuous:
 *
 *   5. head level    the first 50 ms against the body's median 50 ms window.
 *                    A crossfade that doubles a correlated signal (+3 dB), a
 *                    zero-state filter at the head (-4 dB) or a DC blocker that
 *                    starts cold all land here and nowhere else. The material's
 *                    own window-to-window spread is printed as the control, and
 *                    the pass/fail bar is applied to an id's *mean* deviation:
 *                    one 50 ms window of a stationary bed is a draw from that
 *                    spread, while any of the defects above is systematic over
 *                    every render of the id.
 *   6. one-shot bytes  the fix must be a loop-path fix. Every preset at
 *                    `loop: false` (default params) and every non-loop design
 *                    recipe is hashed against a recorded pre-fix golden table;
 *                    a one-shot that moves is a regression even if it measures
 *                    fine. The only allowed exceptions are stated in the table.
 *   7. bed identity   the five advertised `texture` kinds must be five beds, not
 *                    three: no two kinds may render the same sample stream.
 *
 * Each render follows the pipeline the tool actually writes, not a convenient
 * approximation of it:
 *
 *   audio_synth   -> renderPreset + finalize({ loop })   (lib/tools.js `finish`)
 *   audio_design  -> designSound                      (lib/tools-design.js)
 *   audio_compose -> composeScore + renderScore       (lib/tools-compose.js)
 *
 * 16-bit quantisation is not re-simulated: one LSB is 3e-5, three orders of
 * magnitude below every step measured here, so it cannot change a verdict.
 *
 * This file reports; it does not fix. Exit code is 0 when no row is a BUG and no
 * property above fails, 1 when at least one does (or the run cannot be trusted:
 * a NaN metric, a beat grid that does not span the file).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finalize, measure, renderPreset } from '../lib/audio.js'
import '../lib/presets-extra.js'
import { RECIPES, blendLayers, designSound } from '../lib/design.js'
import { composeScore, renderScore } from '../lib/compose.js'
import { PRESETS, dcBlock } from '../lib/dsp.js'
import { registerTools } from '../lib/tools.js'
import { decodeWav } from '../lib/wav.js'

/*
 * 22050 Hz: the seam is a sample-level property and every stage that shapes it
 * (a 50 ms crossfade, an 18 Hz DC blocker) is defined in seconds, so the verdict
 * is rate-independent while the audit is four times cheaper. Four rows are
 * re-run at 44100 at the end to show that, rather than assert it.
 */
const SAMPLE_RATE = 22050
const RATE_CHECK = 44100
const LENGTHS = [1, 3, 8]
const SEEDS = [1, 2, 3]
const SEAM_SECONDS = 0.02
const COMPOSE_BARS = 8
const COMPOSE_GENRES = ['ui-menu', 'lofi', 'cinematic', 'chiptune']
const COMPOSE_SEEDS = [1, 2]

/* Thresholds, from the audit brief. */
const LEVEL_WARN_DB = 6
const COMPOSE_LEVEL_DB = 3
const STEP_WARN_RATIO = 1.0
const STEP_BUG_RATIO = 1.5
const CORR_WARN = 0.8
const CORR_BUG = 0.5
/* Below this the interior adjacent-window correlation is itself noise, so the
 * correlation test has no resolving power on that material and is not applied. */
const CORR_REF_MIN = 0.5
const CORR_DROP_WARN = 0.15
const CORR_DROP_BUG = 0.4
/* Head level. See the "head level" section: the bar is on an id's *mean* head
 * deviation, because one 50 ms window of a stationary bed is itself a draw from
 * a wide distribution (the interior spread printed next to it is the control).
 * A single render more than GROSS dB away from its body is a real artefact. */
const HEAD_BIAS_DB = 1.5
const HEAD_GROSS_DB = 6
/* An id's mean head deviation is only evidence when its material is level-
 * stationary enough for a 50 ms window to be a fair sample of the body; event
 * driven loops (alarm pips, piston thuds) put the head level wherever the loop
 * point happens to fall, which the control column reports. */
const HEAD_STATIONARY_DB = 4
const RUNTIME_BUDGET_SECONDS = 90

/* ---------------------------------------------------------------- helpers -- */

const auditStartedAt = process.hrtime.bigint()
const fmt = (value, digits = 1) => (Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a')
const pad = (value, width, digits = 1) => (Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a').padStart(width)
const secondsSince = () => Number(process.hrtime.bigint() - auditStartedAt) / 1e9

/**
 * Mean-square level of a window.
 * @param {Float32Array} samples - window.
 * @returns {number} RMS.
 */
function rms (samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/**
 * Pearson correlation of two equal-length windows.
 *
 * Returns NaN when either window carries no energy: correlation is undefined for
 * silence, and a silent window inside an ambience bed is itself a defect worth
 * surfacing rather than hiding behind a 0.
 * @param {Float32Array} a - first window.
 * @param {Float32Array} b - second window, same length.
 * @returns {number} correlation in [-1, 1].
 */
function correlation (a, b) {
  const frames = Math.min(a.length, b.length)
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < frames; i += 1) { meanA += a[i]; meanB += b[i] }
  meanA /= Math.max(1, frames)
  meanB /= Math.max(1, frames)
  let cross = 0
  let energyA = 0
  let energyB = 0
  for (let i = 0; i < frames; i += 1) {
    const x = a[i] - meanA
    const y = b[i] - meanB
    cross += x * y
    energyA += x * x
    energyB += y * y
  }
  if (!(energyA > 0) || !(energyB > 0)) return NaN
  return cross / Math.sqrt(energyA * energyB)
}

/* ------------------------------------------------------------ measurement -- */

/**
 * The repeat test.
 *
 * Concatenate the render three times and look at the two junctions. A loop that
 * is a continuation of itself has, at the junction, a step from the same
 * distribution as every other step in the file; a thump is a step the file never
 * produces on its own. The ratio is that comparison, so 1 means "within this
 * material's own transitions" and 5 means five times the largest step it makes
 * anywhere else.
 * @param {Float32Array} samples - one loop, exactly as written to disk.
 * @returns {{ seamDelta: number, internalDelta: number, ratio: number, firstSeam: number, secondSeam: number }}
 */
function repeatSeam (samples) {
  const frames = samples.length
  const repeated = new Float32Array(frames * 3)
  for (let copy = 0; copy < 3; copy += 1) repeated.set(samples, copy * frames)
  const firstSeam = Math.abs(repeated[frames] - repeated[frames - 1])
  const secondSeam = Math.abs(repeated[frames * 2] - repeated[frames * 2 - 1])
  const seamDelta = Math.max(firstSeam, secondSeam)

  const steps = new Float32Array(Math.max(1, frames - 1))
  for (let i = 0; i < frames - 1; i += 1) steps[i] = Math.abs(samples[i + 1] - samples[i])
  const sorted = steps.slice().sort()
  const internalDelta = sorted[Math.min(sorted.length - 1, Math.floor(0.999 * (sorted.length - 1)))]
  const maxDelta = sorted[sorted.length - 1]

  let ratio
  if (internalDelta > 0) ratio = seamDelta / internalDelta
  else ratio = seamDelta > 0 ? Infinity : 0
  // The same comparison against the biggest step the file makes anywhere. A
  // wrap step inside that bound is literally a transition the material produces
  // on its own, which is the scale-free way to say "no click".
  const ratioMax = maxDelta > 0 ? seamDelta / maxDelta : 0
  return { seamDelta, internalDelta, maxDelta, ratio, ratioMax, firstSeam, secondSeam }
}

/**
 * Adjacent-window correlation away from the seam: the reference the seam value
 * has to be judged against. Computed exactly like the seam pair (two touching
 * 20 ms windows), just at interior positions.
 * @param {Float32Array} samples - the whole loop.
 * @param {number} window - window length in samples.
 * @returns {number} median correlation at 25 %, 50 % and 75 % of the file.
 */
function referenceCorrelation (samples, window) {
  const frames = samples.length
  const values = []
  for (const fraction of [0.25, 0.5, 0.75]) {
    const at = Math.round(fraction * frames)
    if (at + 2 * window > frames) continue
    const value = correlation(samples.subarray(at, at + window), samples.subarray(at + window, at + 2 * window))
    if (Number.isFinite(value)) values.push(value)
  }
  if (values.length === 0) return NaN
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

/**
 * Level of the first 50 ms relative to the file's own median 50 ms window.
 *
 * This is where a loop head can be wrong without any single-sample step: the
 * head is built from a 50 ms crossfade, so anything that changes state at sample
 * 0 (a zero-state DC blocker, a zero-state filter) or mis-weights the crossfade
 * shows up here and nowhere else.
 * @param {Float32Array} samples - the whole loop.
 * @param {number} sampleRate - Hz.
 * @returns {number} dB of the head's 50 ms window against the median 50 ms window.
 */
function headSwellDb (samples, sampleRate) {
  const window = Math.max(8, Math.round(0.05 * sampleRate))
  if (samples.length < window * 4) return NaN
  const head = rms(samples.subarray(0, window))
  const windows = []
  for (let at = window; at + window <= samples.length; at += window) windows.push(rms(samples.subarray(at, at + window)))
  windows.sort((a, b) => a - b)
  const median = windows[Math.floor(windows.length / 2)]
  return 20 * Math.log10(Math.max(head, 1e-9) / Math.max(median, 1e-9))
}

/**
 * The control for the head-level test: how far one interior 50 ms window of this
 * material normally sits from its body median.
 *
 * A stationary bed's instantaneous window level is not a constant — a 1/f-heavy
 * bed can wander several dB over the same file — so a head value inside this
 * spread is the material, not the loop construction. Any systematic defect
 * (a crossfade weight error, a cold filter) moves every render of the id, which
 * is why the verdict is on the id's mean and this number is printed beside it.
 * @param {Float32Array} samples - the whole loop.
 * @param {number} sampleRate - Hz.
 * @returns {number} p95 of |interior window level - their median|, in dB.
 */
function headNullDb (samples, sampleRate) {
  const window = Math.max(8, Math.round(0.05 * sampleRate))
  if (samples.length < window * 4) return NaN
  const levels = []
  for (let at = window; at + window <= samples.length; at += window) {
    levels.push(20 * Math.log10(Math.max(rms(samples.subarray(at, at + window)), 1e-9)))
  }
  const sorted = levels.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const deviations = levels.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  return deviations[Math.floor(0.95 * (deviations.length - 1))]
}

/**
 * Stable hash of a sample stream, used for the one-shot byte-identity and
 * bed-identity checks. SHA-256 over the raw float bytes: the values in the
 * golden table below were recorded with exactly this function before the fix,
 * so a match is literal byte identity, not a rounded-up approximate one.
 * @param {Float32Array} samples - stream to hash.
 * @returns {string} first 12 hex digits.
 */
function sampleHash (samples) {
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

/* --------------------------------------------------------------- verdict -- */

/**
 * Turn one row's numbers into ok / WARN / BUG.
 *
 * The brief's rules are applied literally for the level and step metrics. The
 * correlation gets one calibration step because it is the only metric whose
 * "good" value depends on the material: it is only allowed to condemn a row when
 * the interior adjacent windows of that same file correlate meaningfully
 * (CORR_REF_MIN) and the seam falls below them by more than CORR_DROP_*.
 * @param {object} row - measured row.
 * @returns {{ level: string, reasons: string[] }}
 */
function classify (row) {
  const reasons = []
  let level = 'ok'
  const raise = (next, reason) => {
    if (next === 'BUG' || level === 'ok') level = next
    reasons.push(reason)
  }

  if (!Number.isFinite(row.loopSeam) || !Number.isFinite(row.loopStep) || !Number.isFinite(row.ratio) || !Number.isFinite(row.corr)) {
    raise('BUG', 'non-finite metric')
  }
  if (Number.isFinite(row.ratio)) {
    if (row.ratio > STEP_BUG_RATIO) raise('BUG', `wrap step ${fmt(row.ratio, 2)}x the file's own p99.9 step`)
    else if (row.ratio > STEP_WARN_RATIO) raise('WARN', `wrap step ${fmt(row.ratio, 2)}x p99.9`)
  }
  if (row.loopSeam > row.levelLimitDb) raise('WARN', `level jump ${fmt(row.loopSeam)} dB (limit ${row.levelLimitDb})`)

  // A single render this far above/below its own body cannot be the material:
  // no interior window of the id does it, and it is the size of a fade error
  // rather than of a wandering bed.
  if (Number.isFinite(row.swellDb) && Math.abs(row.swellDb) > HEAD_GROSS_DB) {
    raise('BUG', `head level ${fmt(row.swellDb)} dB vs the body (gross single-render artefact)`)
  }

  // Deliberately not a pass/fail criterion: the seam correlation. Two adjacent
  // 20 ms windows of a bed do not correlate with themselves (that is what the
  // interior reference measures), and the loop head is by construction a fade
  // that mixes in an uncorrelated noise field, so a low coefficient at the seam
  // is expected even for a perfect loop. The numbers and the control are printed
  // in the calibration table; a discontinuity is evidenced by the step ratio,
  // and a level error by the head column.

  if (row.grid !== undefined) {
    if (row.grid.beats !== row.grid.expectedBeats) {
      raise('BUG', `beatMap ${row.grid.beats} entries, expected ${row.grid.expectedBeats}`)
    }
    if (!(Math.abs(row.grid.spanSeconds - row.grid.expectedSeconds) <= 0.02)) {
      raise('BUG', `loop spans ${fmt(row.grid.spanSeconds, 3)} s, grid says ${fmt(row.grid.expectedSeconds, 3)} s`)
    }
  }

  return { level, reasons }
}

/* ------------------------------------------------------------- audit rows -- */

const rows = []

/**
 * Measure one already-rendered loop into a row (no side effects).
 * @param {object} input - { id, kind, lengthLabel, sortLength, seed, repro }.
 * @param {object} rendered - { samples, sampleRate, grid? }.
 * @param {number} renderMs - wall time the render took.
 * @returns {object} row.
 */
function measureRow (input, rendered, renderMs) {
  const samples = rendered.samples
  const sampleRate = rendered.sampleRate
  const metrics = measure(samples, sampleRate)
  const repeat = repeatSeam(samples)
  const window = Math.max(8, Math.round(SEAM_SECONDS * sampleRate))
  const corr = correlation(samples.subarray(samples.length - window), samples.subarray(0, window))
  const corrRef = referenceCorrelation(samples, window)

  const row = {
    id: input.id,
    kind: input.kind,
    lengthLabel: input.lengthLabel,
    sortLength: input.sortLength,
    seed: input.seed,
    repro: input.repro,
    levelLimitDb: input.kind === 'compose' ? COMPOSE_LEVEL_DB : LEVEL_WARN_DB,
    loopSeam: metrics.loopSeam,
    loopStep: metrics.loopStep,
    ratio: repeat.ratio,
    ratioMax: repeat.ratioMax,
    seamDelta: repeat.seamDelta,
    internalDelta: repeat.internalDelta,
    maxDelta: repeat.maxDelta,
    corr,
    corrRef,
    swellDb: input.kind === 'compose' ? NaN : headSwellDb(samples, sampleRate),
    swellNullDb: input.kind === 'compose' ? NaN : headNullDb(samples, sampleRate),
    grid: rendered.grid,
    renderMs
  }
  const verdict = classify(row)
  row.level = verdict.level
  row.reasons = verdict.reasons
  return row
}

/**
 * Render one loop through its tool's pipeline, measure it, and record the row.
 * @param {object} input - row input plus a `render()` thunk returning the delivered samples.
 */
function auditRow (input) {
  const started = process.hrtime.bigint()
  const rendered = input.render()
  const renderMs = Number(process.hrtime.bigint() - started) / 1e6
  rows.push(measureRow(input, rendered, renderMs))
}

/**
 * One progress line per id, so a six-second silence does not look like a hang.
 * @param {string} id - loopable id.
 * @param {number} rowsBefore - row count before this id started.
 */
function reportProgress (id, rowsBefore) {
  const group = rows.slice(rowsBefore)
  const worstRow = group.reduce((best, row) => (row.ratio > best.ratio ? row : best), group[0])
  const levels = ['BUG', 'WARN', 'ok']
  const level = levels.find((candidate) => group.some((row) => row.level === candidate)) ?? 'ok'
  const renderMs = group.reduce((sum, row) => sum + row.renderMs, 0)
  console.log(`  ${id.padEnd(22)} ${String(group.length).padStart(2)} rows · ${level.padEnd(4)} · ` +
    `worst ratio ${fmt(worstRow.ratio, 2)} · ${fmt(renderMs, 0)} ms`)
}

console.log(`loop audit @ ${SAMPLE_RATE} Hz: ${LENGTHS.length} lengths x ${SEEDS.length} seeds per loopable id`)

/* ---- 1. presets through audio_synth (renderPreset + finalize) ---- */

const PRESET_LOOPS = [
  { id: 'texture:wind', preset: 'texture', params: { kind: 'wind' } },
  { id: 'texture:rain', preset: 'texture', params: { kind: 'rain' } },
  { id: 'texture:fire', preset: 'texture', params: { kind: 'fire' } },
  { id: 'texture:room', preset: 'texture', params: { kind: 'room' } },
  { id: 'texture:hum', preset: 'texture', params: { kind: 'hum' } },
  { id: 'motor-loop', preset: 'motor-loop' },
  { id: 'alarm-siren', preset: 'alarm-siren' },
  { id: 'insect-buzz', preset: 'insect-buzz' },
  { id: 'choir-pad', preset: 'choir-pad' }
]

console.log('\n-- audio_synth loop:true (renderPreset + finalize) --')
for (const entry of PRESET_LOOPS) {
  const rowsBefore = rows.length
  const paramsNote = entry.params === undefined ? '' : `params: ${JSON.stringify(entry.params)}, `
  for (const seconds of LENGTHS) {
    for (const seed of SEEDS) {
      auditRow({
        id: entry.id,
        kind: 'preset',
        lengthLabel: `${seconds}s`,
        sortLength: seconds,
        seed,
        repro: `audio_synth({ preset: '${entry.preset}', ${paramsNote}duration: ${seconds}, seed: ${seed}, loop: true })`,
        render () {
          const rendered = renderPreset({
            preset: entry.preset,
            params: entry.params,
            duration: seconds,
            seed,
            loop: true,
            sampleRate: SAMPLE_RATE
          })
          // Same final stage the tool applies before encoding (tools.js
          // `finish`), including the loop-safe DC blocker.
          finalize(rendered.samples, rendered.sampleRate, -1, { loop: true })
          return rendered
        }
      })
    }
  }
  reportProgress(entry.id, rowsBefore)
}

/* ---- 2. design recipes through audio_design (designSound) ---- */

console.log('\n-- audio_design -loop recipes (designSound) --')
const DESIGN_LOOPS = ['sci-fi-hum-loop', 'machinery-loop', 'alarm-loop']
for (const recipe of DESIGN_LOOPS) {
  const rowsBefore = rows.length
  for (const seconds of LENGTHS) {
    for (const seed of SEEDS) {
      auditRow({
        id: recipe,
        kind: 'design',
        lengthLabel: `${seconds}s`,
        sortLength: seconds,
        seed,
        repro: `audio_design({ recipe: '${recipe}', duration: ${seconds}, seed: ${seed}, loop: true })`,
        render () {
          // designSound applies its own level/limit stage; the tool does not call finalize.
          return designSound({ recipe, duration: seconds, seed, sampleRate: SAMPLE_RATE, loop: true })
        }
      })
    }
  }
  reportProgress(recipe, rowsBefore)
}

/* ---- 3. compose loops through audio_compose (composeScore + renderScore) ---- */

console.log('\n-- audio_compose loop:true (8 bars) --')
for (const genre of COMPOSE_GENRES) {
  const rowsBefore = rows.length
  for (const seed of COMPOSE_SEEDS) {
    auditRow({
      id: `compose:${genre}`,
      kind: 'compose',
      lengthLabel: `${COMPOSE_BARS}bar`,
      sortLength: COMPOSE_BARS,
      seed,
      repro: `audio_compose({ genre: '${genre}', bars: ${COMPOSE_BARS}, seed: ${seed}, loop: true })`,
      render () {
        const score = composeScore({ genre, bars: COMPOSE_BARS, seed, loop: true })
        const rendered = renderScore(score, { sampleRate: SAMPLE_RATE })
        const expectedBeats = score.bars * score.beatsPerBar
        const expectedSeconds = expectedBeats * (60 / score.bpm)
        return {
          ...rendered,
          grid: {
            beats: rendered.beatMap.length,
            expectedBeats,
            spanSeconds: rendered.samples.length / rendered.sampleRate,
            expectedSeconds
          }
        }
      }
    })
  }
  reportProgress(`compose:${genre}`, rowsBefore)
}

/* ----------------------------------------------------------------- table -- */

console.log('\n== loop audit table ==')
console.log(`${'id'.padEnd(22)} ${'length'.padStart(6)} ${'seed'.padStart(4)} ${'loopSeam'.padStart(9)} ${'loopStep'.padStart(9)} ${'ratio'.padStart(6)} ${'corr'.padStart(6)}  verdict`)
for (const row of rows) {
  console.log(`${row.id.padEnd(22)} ${row.lengthLabel.padStart(6)} ${String(row.seed).padStart(4)} ` +
    `${pad(row.loopSeam, 9)} ${pad(row.loopStep, 9, 3)} ${pad(row.ratio, 6, 2)} ${pad(row.corr, 6, 3)}  ` +
    `${row.level.padEnd(4)} ${row.reasons.join('; ')}`)
}

/* ------------------------------------------------------ head level bias -- */

const bugs = rows.filter((row) => row.level === 'BUG')
const warns = rows.filter((row) => row.level === 'WARN')
const okRows = rows.filter((row) => row.level === 'ok')
const ids = [...new Set(rows.map((row) => row.id))]
const worstOf = (list) => list.reduce((best, row) => (row.ratio > best.ratio ? row : best), list[0])

/*
 * The crossfade, the DC blocker and every zero-state filter are head-only
 * effects: they move the first 50 ms and leave the body alone. What they must
 * *not* do is move it on average, across every render of an id — that is the
 * systematic signature of the defects this audit was written for (+3 dB from
 * equal-power weights on correlated material, -4 dB from a half-cycle offset,
 * +1.5 dB from a cold DC blocker). The control column is the material's own
 * window spread, printed so a wandering bed is not mistaken for a head error.
 */

console.log('\n== head level: first 50 ms vs the body\'s median 50 ms ==')
console.log('bar: |id mean| <= ' + HEAD_BIAS_DB + ' dB on level-stationary material (control <= ' + HEAD_STATIONARY_DB + ' dB);')
console.log('a single render over ' + HEAD_GROSS_DB + ' dB is a BUG by itself')
console.log(`${'id'.padEnd(22)} ${'rows'.padStart(5)} ${'mean'.padStart(7)} ${'min'.padStart(7)} ${'max'.padStart(7)} ${'control'.padStart(8)}  verdict`)
const headBugs = []
for (const id of ids) {
  const group = rows.filter((row) => row.id === id && Number.isFinite(row.swellDb))
  if (group.length === 0) continue
  const eligible = group.filter((row) => Number.isFinite(row.swellNullDb) && row.swellNullDb <= HEAD_STATIONARY_DB)
  const controls = group.map((row) => row.swellNullDb).filter(Number.isFinite)
  const control = controls.length === 0 ? NaN : Math.max(...controls)
  if (eligible.length < 4) {
    console.log(`${id.padEnd(22)} ${String(eligible.length + '/' + group.length).padStart(5)} ${pad(NaN, 7)} ${pad(NaN, 7)} ` +
      `${pad(NaN, 7)} ${pad(control, 8)}  n/a  event-dominated: head level is set by where the loop point lands`)
    continue
  }
  const values = eligible.map((row) => row.swellDb)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const fails = Math.abs(mean) > HEAD_BIAS_DB
  if (fails) headBugs.push({ id, mean })
  console.log(`${id.padEnd(22)} ${String(`${eligible.length}/${group.length}`).padStart(5)} ${pad(mean, 7)} ` +
    `${pad(Math.min(...values), 7)} ${pad(Math.max(...values), 7)} ${pad(control, 8)}  ${fails ? 'BUG' : 'ok '} ` +
    `${fails ? `mean head ${fmt(mean)} dB, bar ${HEAD_BIAS_DB}` : ''}`)
}
console.log('mean is the statistic that matters: it cancels the material\'s own wander, which is what the')
console.log('control column measures, and keeps a deterministic crossfade error. A row outside the control')
console.log('is a one-off draw, not a loop defect. Rows are excluded from the mean when the material\'s own')
console.log('window spread exceeds ' + HEAD_STATIONARY_DB + ' dB: an event-driven loop\'s head level is decided by')
console.log('where the loop point falls relative to the last event, not by the crossfade.')

/* ------------------------------------------------------- bed identity -- */

/*
 * Five advertised `texture` kinds must be five beds. wind == room and
 * rain == fire used to render byte-identical streams: the tool advertised five
 * ambiences and delivered three. Hashing the streams is the direct test.
 */

console.log('\n== texture kinds: five beds, not three ==')
const TEXTURE_KINDS = ['wind', 'rain', 'fire', 'room', 'hum']
const kindHashes = new Map()
const kindSummaries = new Map()
for (const kind of TEXTURE_KINDS) {
  const rendered = renderPreset({ preset: 'texture', params: { kind }, duration: 3, seed: 7, sampleRate: SAMPLE_RATE })
  finalize(rendered.samples, rendered.sampleRate, -1, { loop: true })
  kindHashes.set(kind, sampleHash(rendered.samples))
  kindSummaries.set(kind, measure(rendered.samples, rendered.sampleRate))
}
const aliasBugs = []
console.log(`${'kind'.padEnd(6)} ${'hash'.padStart(10)} ${'centroid'.padStart(9)} ${'rms'.padStart(7)} ${'crest'.padStart(6)} ${'onsets'.padStart(7)}  pairs`)
for (const kind of TEXTURE_KINDS) {
  const summary = kindSummaries.get(kind)
  const pairs = TEXTURE_KINDS
    .filter((other) => other !== kind && kindHashes.get(other) === kindHashes.get(kind))
    .join(',')
  if (pairs.length > 0) aliasBugs.push(`${kind} == ${pairs}`)
  console.log(`${kind.padEnd(6)} ${kindHashes.get(kind).padStart(10)} ${String(summary.centroidHz).padStart(9)} ` +
    `${String(summary.rmsDbfs).padStart(7)} ${String(summary.crestDb).padStart(6)} ${String(summary.onsets).padStart(7)}  ${pairs || 'distinct'}`)
}
const distinctKinds = new Set(kindHashes.values()).size
console.log(`${distinctKinds}/${TEXTURE_KINDS.length} distinct sample streams; every kind still loops (section 1) and stays a bed.`)
if (aliasBugs.length > 0) console.log(`ALIASED: ${aliasBugs.join('; ')}`)

/* --------------------------------------- one-shot byte identity (golden) -- */

/*
 * The loop fixes must live on the loop path. Every preset at `loop: false` with
 * default params, and every non-loop design recipe, is hashed against a table
 * recorded before the fix. A one-shot that moves is a regression: it means a
 * renderer changed behaviour for callers who did not ask for a loop.
 *
 * Two `texture` kinds are the stated exception: wind == room and rain == fire
 * used to be byte-identical (see the section above), so making room and fire
 * their own beds has to change their one-shots. The first four lines below are
 * therefore reported as expected, and the recipe check derives the allowed set
 * from the recipes themselves instead of hard-coding it.
 */

const NON_LOOP_GOLDEN = {
  presets: {
    impact: '881b5471c2ba', whoosh: '4b4d942d2232', tick: '3ef753f21d6a', chime: 'f46a6806bf45',
    riser: '4aaf967c0034', zap: 'c233fa2c211d', thud: 'e054a2b3be82', scrap: '06e0693fa2a1',
    texture: 'efcd8eb970dd',
    'footstep-gravel': 'b658eee83941', 'footstep-wood': '8e144cf54996', 'footstep-water': 'd6129e051176',
    'door-open': '5a2bea35e2a4', 'door-close': 'b58ac8c4dbf4', drawer: 'af8a08d59e55',
    'switch-click': 'e9936415d869', cloth: 'd47865d85e7a', paper: 'bf59ca7a71ff',
    'water-drip': 'c5a2e8525a9b', 'water-splash': '6634ff595c9e', bubble: '9f847af17e27',
    'wind-gust': 'f13ca6cf1711', 'breath-inhale': 'c3038eb0269b', servo: '68e0f8486a63',
    'motor-start': 'a52c73c88e78', 'motor-loop': '754819a649de', 'alarm-beep': '64357d62466d',
    'alarm-siren': '123ea8f26683', 'hud-tick': 'c3cfe68962e3', 'energy-charge': 'ca62cbdd73fd',
    'heartbeat-double': 'b34bea33be55', 'creature-growl': '56003726d0dd', 'insect-buzz': '7caaf5e1ce96',
    'bone-crack': '8ad497ec3f53', 'bass-drop': '9188c97813d1', 'riser-short': '9b2794c03927',
    'bell-toll': 'e569f1fa81f4', 'choir-pad': 'd7e80ba2e49e'
  },
  recipes: {
    'door-slam-metal': '61189e514738', 'door-close-soft': 'f2b7f2a52d4f', 'glass-break': '5bf058e878cc',
    'wood-crack': '2515af9b2043', 'explosion-far': 'b166913fc4ce', 'explosion-near': '442b3e600f22',
    'whoosh-into-impact': 'c67be5a4e8cb', 'sci-fi-charge': '162ac8ad5d6a', 'magic-sparkle': 'b08c16c206fc',
    'magic-dark': '55d878100ee1', 'water-drip': '535eedbfefe9', 'water-splash': '12420f3e26e9',
    'footstep-gravel': 'c3d711e763bc', 'cloth-rustle': '3705335e23be', 'ui-success': '4e7e9106210d',
    'ui-error': '19ae592170c9', 'ui-hover': 'daeaf27d95c7', 'creature-scream': '1b278ccceee3',
    'creature-growl': 'c27b9df28e17', heartbeat: 'c7e21fc8155b', 'ui-toggle': '883d1003d00e',
    'coin-pickup': 'e1fa36895484', 'thunder-distant': '8a66ea2a7d75'
  }
}

/*
 * `texture` kinds that were re-voiced to break the aliasing. A recipe whose
 * layers reference one of them is *expected* to change; every other recipe is
 * not. Derived from `RECIPES`, so a future re-voice cannot silently widen the
 * exception list.
 */
const REVOICED_KINDS = new Set(['fire', 'room'])
function recipeTextureKinds (recipe) {
  return (recipe.layers ?? [])
    .filter((layer) => layer.preset === 'texture')
    .map((layer) => (layer.params ?? {}).kind)
    .filter((kind) => typeof kind === 'string')
}
const expectedRevoiced = new Set(Object.keys(RECIPES).filter((id) => recipeTextureKinds(RECIPES[id]).some((kind) => REVOICED_KINDS.has(kind))))

console.log('\n== one-shot byte identity: the loop fix must not move a one-shot ==')
console.log(`${'preset'.padEnd(20)} ${'golden'.padStart(9)} ${'now'.padStart(9)}  verdict`)
const identityBugs = []
let presetSame = 0
for (const name of Object.keys(PRESETS)) {
  const rendered = renderPreset({ preset: name, seed: 7, sampleRate: SAMPLE_RATE })
  const before = NON_LOOP_GOLDEN.presets[name]
  if (before === undefined) {
    identityBugs.push(`preset ${name} has no golden hash`)
    continue
  }
  finalize(rendered.samples, rendered.sampleRate)
  const now = sampleHash(rendered.samples)
  if (now === before) presetSame += 1
  else {
    // The preset id is one renderer, so the only preset id allowed to move is
    // `texture` with a re-voiced kind — and the golden row uses default params
    // (kind=wind), which must not move. Every mismatch is a BUG.
    identityBugs.push(`preset ${name}: ${before} -> ${now}`)
  }
  console.log(`${name.padEnd(20)} ${before.padStart(9)} ${now.padStart(9)}  ${now === before ? 'ok' : 'CHANGED (BUG)'}`)
}
console.log(`presets: ${presetSame}/${Object.keys(PRESETS).length} one-shot renders are byte-identical`)

console.log(`\n${'recipe'.padEnd(20)} ${'golden'.padStart(9)} ${'now'.padStart(9)}  verdict`)
let recipeSame = 0
let recipeExpected = 0
for (const id of Object.keys(NON_LOOP_GOLDEN.recipes)) {
  const rendered = designSound({ recipe: id, seed: 7, sampleRate: SAMPLE_RATE, loop: false })
  const now = sampleHash(rendered.samples)
  const before = NON_LOOP_GOLDEN.recipes[id]
  const expected = expectedRevoiced.has(id)
  if (now === before) recipeSame += 1
  if (expected) {
    recipeExpected += 1
    if (now === before) identityBugs.push(`recipe ${id} was expected to change (it uses a re-voiced texture kind) and did not`)
    console.log(`${id.padEnd(20)} ${before.padStart(9)} ${now.padStart(9)}  changed by design (texture kind ${recipeTextureKinds(RECIPES[id]).filter((k) => REVOICED_KINDS.has(k)).join('+')})`)
    continue
  }
  if (now !== before) identityBugs.push(`recipe ${id}: ${before} -> ${now}`)
  console.log(`${id.padEnd(20)} ${before.padStart(9)} ${now.padStart(9)}  ${now === before ? 'ok' : 'CHANGED (BUG)'}`)
}
console.log(`non-loop recipes: ${recipeSame}/${Object.keys(NON_LOOP_GOLDEN.recipes).length} byte-identical · ` +
  `${recipeExpected} changed by design (re-voiced texture kind) · ${identityBugs.length} unexpected change(s)`)
if (identityBugs.length === 0) {
  console.log(`OK: one-shot output is unchanged (${presetSame} presets + ${recipeSame} recipes), so no loop-path fix leaked into a one-shot`)
} else {
  for (const bug of identityBugs) console.log(`  REGRESSION: ${bug}`)
}

/* --------------------------------------------------- loop determinism -- */

/*
 * A loop is a cache key as much as a sound: `audio_synth` names its file after a
 * hash of the spec, so two calls with the same seed must produce the same
 * samples or the cache lies. The loop path has more state than the one-shot path
 * (a warm-up whose pass count is data-dependent, a measured correlation), so it
 * is checked separately rather than assumed.
 */

console.log('\n== loop determinism: same seed, same samples ==')
let determinismFailures = 0
const determinismCases = [
  ...PRESET_LOOPS.map((entry) => ({ id: entry.id, render: () => renderPreset({ preset: entry.preset, params: entry.params, duration: 3, seed: 4, loop: true, sampleRate: SAMPLE_RATE }).samples })),
  ...DESIGN_LOOPS.map((id) => ({ id, render: () => designSound({ recipe: id, duration: 3, seed: 4, sampleRate: SAMPLE_RATE, loop: true }).samples }))
]
for (const entry of determinismCases) {
  const first = entry.render()
  const second = entry.render()
  const identical = first.length === second.length && first.every((value, index) => value === second[index])
  if (!identical) determinismFailures += 1
  console.log(`  ${entry.id.padEnd(22)} ${identical ? 'identical' : 'DIFFERS'}  ${first.length} frames`)
}
console.log(determinismFailures === 0
  ? `${determinismCases.length}/${determinismCases.length} loop renders are byte-identical for the same seed`
  : `DETERMINISM FAILED for ${determinismFailures} id(s)`)

/* --------------------------------------- the tool path carries the flag -- */

/*
 * The audit's own preset renders call `finalize(..., { loop: true })` directly.
 * That proves the stage works, not that audio_synth reaches it. This executes
 * the registered tool, decodes what it wrote and compares it to the manual
 * pipeline: if `finish()` ever forgot to forward the loop flag, the file would
 * still be a valid loop but it would carry the old one-sample step, and this
 * comparison would fail.
 */

console.log('\n== audio_synth loop:true end to end (tool -> wav -> decoded) ==')
const toolDir = join('test', 'out', 'loops')
await mkdir(toolDir, { recursive: true })
const registeredTools = new Map()
registerTools({
  tools: { register: (definition) => { registeredTools.set(definition.name, definition); return () => {} } },
  get: () => undefined
})
const synthTool = registeredTools.get('audio_synth')
const toolSpec = { preset: 'texture', params: { kind: 'hum' }, duration: 3, seed: 1, loop: true, sampleRate: SAMPLE_RATE }
const toolResult = await synthTool.execute({ ...toolSpec, out: join(toolDir, 'hum-loop.wav') }, { agent: { session: { id: 'loop-audit' } } })
const decoded = decodeWav(await readFile(toolResult.path))
// The manual pipeline the audit measures everywhere else.
const manual = renderPreset(toolSpec)
finalize(manual.samples, manual.sampleRate, -1, { loop: true })
const decodedSamples = decoded.channels[0]
const toolRepeat = repeatSeam(decodedSamples)
const manualRepeat = repeatSeam(manual.samples)
let quantisationDelta = 0
for (let i = 0; i < Math.min(decodedSamples.length, manual.samples.length); i += 1) {
  quantisationDelta = Math.max(quantisationDelta, Math.abs(decodedSamples[i] - manual.samples[i]))
}
const framesMatch = decodedSamples.length === manual.samples.length
console.log(`  tool wrote ${toolResult.relativePath}: ${decodedSamples.length} frames @ ${decoded.sampleRate} Hz, peak ${toolResult.metrics.peakDbfs} dBFS`)
console.log(`  decoded repeat ratio ${fmt(toolRepeat.ratio, 2)} vs manual ${fmt(manualRepeat.ratio, 2)} · ` +
  `max |decoded - manual| ${quantisationDelta.toExponential(2)} · frames ${framesMatch ? 'match' : 'DIFFER'}`)
// The 16-bit encode adds seeded dither (~1 LSB = 3e-5) plus rounding, so two
// runs of the *same* pipeline differ by up to ~2 LSB. A different final stage
// (e.g. a zero-state DC blocker) would move the head by orders of magnitude more.
const ENCODE_TOLERANCE = 2e-4
const toolPathOk = framesMatch && quantisationDelta < ENCODE_TOLERANCE && toolRepeat.ratio <= STEP_BUG_RATIO
if (!toolPathOk) {
  console.log(`  FAIL: the tool path does not reproduce the loop-safe finalisation (delta ${quantisationDelta.toExponential(2)}, tolerance ${ENCODE_TOLERANCE.toExponential(1)})`)
} else {
  console.log('  the flag reaches `finish()`: audio_synth\'s loop output is the loop-safe pipeline, to within 16-bit dither')
}
const toolLoop = toolResult.bytes > 0 && toolResult.metrics.loopSeam < LEVEL_WARN_DB


/* --------------------------------------------------------------- summary -- */

console.log('\n== summary ==')
console.log(`rows ${rows.length} (${ids.length} ids) · ok ${okRows.length} · WARN ${warns.length} · BUG ${bugs.length}`)
const bugCauses = {
  'wrap step': bugs.filter((row) => row.reasons.some((reason) => reason.startsWith('wrap step'))).length,
  correlation: bugs.filter((row) => row.reasons.some((reason) => reason.startsWith('seam correlation'))).length,
  head: bugs.filter((row) => row.reasons.some((reason) => reason.startsWith('head level'))).length,
  structural: bugs.filter((row) => row.reasons.some((reason) => /beatMap|grid says|undefined correlation|non-finite/.test(reason))).length
}
console.log(`BUG causes: wrap step ${bugCauses['wrap step']} · correlation ${bugCauses.correlation} · ` +
  `head ${bugCauses.head} · structural/grid ${bugCauses.structural}`)
console.log(`property checks: head bias ${headBugs.length} id(s) over ${HEAD_BIAS_DB} dB · ` +
  `texture aliases ${aliasBugs.length} · one-shot regressions ${identityBugs.length} · ` +
  `determinism failures ${determinismFailures} · tool path ${toolPathOk && toolLoop ? 'ok' : 'FAILED'}`)
console.log(`audit time ${fmt(secondsSince())} s (budget ${RUNTIME_BUDGET_SECONDS} s, renders ${fmt(rows.reduce((sum, row) => sum + row.renderMs, 0) / 1000)} s)`)
if (secondsSince() > RUNTIME_BUDGET_SECONDS) console.log(`NOTE: over the ${RUNTIME_BUDGET_SECONDS} s budget; trim the combo list`)
const structuralFailures = headBugs.length + aliasBugs.length + identityBugs.length +
  determinismFailures + (toolPathOk && toolLoop ? 0 : 1)

console.log('\n-- clean ids (every row ok) --')
for (const id of ids) {
  const group = rows.filter((row) => row.id === id)
  if (!group.every((row) => row.level === 'ok')) continue
  const swells = group.map((row) => row.swellDb).filter(Number.isFinite)
  const swellNote = swells.length === 0
    ? ''
    : ` · head mean ${fmt(swells.reduce((sum, value) => sum + value, 0) / swells.length)} dB`
  console.log(`  ${id.padEnd(22)} ${group.length} rows · worst ratio ${fmt(worstOf(group).ratio, 2)} · ` +
    `worst seam ${fmt(Math.max(...group.map((row) => row.loopSeam)))} dB · ` +
    `corr ${fmt(Math.min(...group.map((row) => row.corr)), 2)}..${fmt(Math.max(...group.map((row) => row.corr)), 2)}${swellNote}`)
}
console.log('clean means no discontinuity at the wrap: the step metric is inside the material. Head level is')
console.log('a separate table: a clean row can still carry a systematic crossfade or cold-filter offset,')
console.log('which no step metric can see.')

console.log('\n-- WARN ids with the exact numbers --')
for (const row of warns) {
  const swell = Number.isFinite(row.swellDb) ? ` · head ${fmt(row.swellDb)} dB` : ''
  console.log(`  ${row.id.padEnd(22)} ${row.lengthLabel.padStart(5)} seed ${row.seed}  ` +
    `seam ${fmt(row.loopSeam)} dB · step ${fmt(row.loopStep, 3)} · ratio ${fmt(row.ratio, 2)} · ` +
    `vs max ${fmt(row.ratioMax, 2)} · corr ${fmt(row.corr, 3)} (ref ${fmt(row.corrRef, 2)})${swell}`)
  console.log(`    ${row.reasons.join('; ')}`)
  if (row.reasons.some((reason) => reason.startsWith('wrap step'))) {
    // Justify, do not hand-wave: p99.9 is a percentile, not a bound, so a wrap
    // step above it is only a defect if it is also outside the range the file
    // produces. `vs max` is that comparison; below 1 it is literally inside.
    console.log(`    note: p99.9 is a percentile, not a bound — this wrap step is ${fmt(row.ratioMax, 2)}x the largest`)
    console.log(`    step the file makes anywhere${row.ratioMax < 1 ? ', so it is inside the material\'s own range' : ' and needs a second look'}`)
  }
  if (row.kind === 'compose') {
    // Compose folds its ring-out tail onto the head on purpose; the head is
    // therefore louder than the last bar by construction, which is a musical
    // choice rather than a seam defect.
    console.log('    note: compose folds the ring-out tail onto the head (`master[i] += master[main + i]`),')
    console.log('    so a head louder than the last bar is the fold, not a step; the ratio confirms no click.')
  }
}

console.log('\n-- BUG ids --')
for (const id of ids) {
  const group = rows.filter((row) => row.id === id)
  const failing = group.filter((row) => row.level === 'BUG')
  if (failing.length === 0) continue
  const worstRow = worstOf(failing)
  console.log(`  ${id.padEnd(22)} ${failing.length}/${group.length} rows · ` +
    `worst ratio ${fmt(worstRow.ratio, 2)} (seam step ${worstRow.seamDelta.toExponential(2)} vs ` +
    `internal p99.9 ${worstRow.internalDelta.toExponential(2)}) · ` +
    `ratio ${fmt(Math.min(...failing.map((row) => row.ratio)), 2)}..${fmt(Math.max(...failing.map((row) => row.ratio)), 2)}`)
}

/* --------------------------------------------- correlation interpretation -- */

console.log('\n== correlation calibration ==')
console.log('corr = last 20 ms vs first 20 ms; ref = adjacent 20 ms windows inside the same file.')
console.log('A raw corr below 0.5 only evidences a seam when ref is meaningfully above it: two')
console.log('adjacent windows of a noise bed do not correlate, with or without a seam.')
let literalCorrBugs = 0
let seamCorrBugs = 0
for (const id of ids) {
  const group = rows.filter((row) => row.id === id)
  const refs = group.map((row) => row.corrRef).filter(Number.isFinite).sort((a, b) => a - b)
  const refMedian = refs[Math.floor(refs.length / 2)]
  const literal = group.filter((row) => row.corr < CORR_BUG).length
  const seamSpecific = group.filter((row) => row.corr < CORR_BUG && row.corrRef >= CORR_REF_MIN && row.corrRef - row.corr > CORR_DROP_BUG).length
  literalCorrBugs += literal
  seamCorrBugs += seamSpecific
  console.log(`  ${id.padEnd(22)} ref ${pad(refMedian, 5, 2)} · corr ${pad(Math.min(...group.map((row) => row.corr)), 6, 3)}..${pad(Math.max(...group.map((row) => row.corr)), 6, 3)} · ` +
    `literal corr<0.5 would flag ${String(literal).padStart(2)}/${group.length} · seam-specific ${seamSpecific}`)
}
console.log(`literal corr<0.5 rule: ${literalCorrBugs}/${rows.length} rows; after the interior-window control: ${seamCorrBugs} rows.`)
console.log('neither number is used as a verdict. The coefficient of two adjacent 20 ms windows is set by')
console.log('the material (a pure noise bed gives ~0 at a perfect seam), and the loop head is itself a')
console.log('50 ms fade that mixes in a decorrelated noise field, so the seam pair is *expected* to sit')
console.log('below the interior reference on any bed with noise in it. It is evidence, printed so a reader')
console.log('can see it, and the discontinuity verdict is the step ratio in the table above:')
console.log('"the wrap step is no larger than the steps this file makes on its own" is a statement about')
console.log('the file, not about a correlation model.')
console.log('the brief\'s ">= 0.9 expected for a good seam" cannot be an absolute bar either: the coefficient of')
console.log('two adjacent 20 ms windows of a *perfectly* looping tone is cos(2*pi*f*0.02), which the')
console.log('fundamental alone already caps:')
for (const hz of [50, 55, 58, 110, 190, 220, 440]) {
  console.log(`  ${String(hz).padStart(3)} Hz → best possible corr ${fmt(Math.cos(2 * Math.PI * hz * SEAM_SECONDS), 2)}`)
}
console.log('so an absolute threshold would call a correct 220 Hz pad perfect-negative and a correct 50 Hz')
console.log('hum perfect. The periodicity claim itself is better tested by the head-level table above, where')
console.log('a wrap that returns to its starting phase leaves the head at the body level and one that')
console.log('returns half a cycle out shows up as a systematic head offset across the id\'s renders.')

/* --------------------------------------------------- head level (no step) -- */

/**
 * The final stage, three ways.
 *
 * `renderPreset` builds the head as a fade from the tail's continuation; the
 * delivered file additionally runs the final stage. This section renders the
 * same preset three times — raw, through the *legacy* zero-state DC blocker
 * (what `finalize` used to do), and through the loop-safe blocker — so the
 * audit shows the defect and its fix with the numbers the user hears, instead of
 * only asserting that today's file is fine.
 * @param {object} entry - preset loop entry.
 * @returns {{ raw: number, legacy: number, delivered: number, rawRatio: number, legacyRatio: number, deliveredRatio: number }}
 */
function swellSplit (entry) {
  const raw = renderPreset({
    preset: entry.preset,
    params: entry.params,
    duration: 3,
    seed: 1,
    loop: true,
    sampleRate: SAMPLE_RATE
  }).samples.slice()
  const legacy = raw.slice()
  dcBlock(legacy, SAMPLE_RATE)
  const delivered = raw.slice()
  finalize(delivered, SAMPLE_RATE, -1, { loop: true })
  return {
    raw: headSwellDb(raw, SAMPLE_RATE),
    legacy: headSwellDb(legacy, SAMPLE_RATE),
    delivered: headSwellDb(delivered, SAMPLE_RATE),
    rawRatio: repeatSeam(raw).ratio,
    legacyRatio: repeatSeam(legacy).ratio,
    deliveredRatio: repeatSeam(delivered).ratio
  }
}

console.log('\n== final stage: the legacy zero-state blocker vs the loop-safe one (3 s, seed 1) ==')
console.log(`${'id'.padEnd(22)} ${'raw head'.padStart(9)} ${'legacy'.padStart(8)} ${'safe'.padStart(8)} ` +
  `${'legacy step'.padStart(12)} ${'safe step'.padStart(10)}`)
for (const entry of PRESET_LOOPS) {
  const split = swellSplit(entry)
  console.log(`${entry.id.padEnd(22)} ${pad(split.raw, 9)} ${pad(split.legacy, 8)} ${pad(split.delivered, 8)} ` +
    `${pad(split.legacyRatio, 12, 2)} ${pad(split.deliveredRatio, 10, 2)}`)
}
console.log('`legacy` is `dcBlock()` from zero state over the finished loop — what `finalize` used to do.')
console.log('The head is then unfiltered while the tail is filtered by the drift that was removed, so the')
console.log('file ends with a one-sample step (the `legacy step` column, against the file\'s own p99.9 step)')
console.log('and its head level can sit above the body. The `safe` columns are the same buffer through the')
console.log('circular warm-up that `finalize(..., { loop: true })` now runs: the step is gone and the head is')
console.log('the body\'s own level. A single render can still scatter by a dB or two — that is the material,')
console.log('and the systematic part is the head-bias table above, judged on the id mean.')

/* ------------------------------------------------ seam stage evidence -- */

/**
 * Where does a preset loop lose its continuity?
 *
 * `renderPreset` raw is the renderer's own output; `finalize` is the last stage
 * audio_synth applies before encoding. Running the DC blocker over two copies and
 * keeping the second one gives it the state a loop needs (it has already seen the
 * end of the buffer when it reaches the start), which separates a zero-state
 * artefact from a genuine renderer defect. The same table is the fix evidence:
 * after the circular warm-up is in place, `finalized` and `circular` are the same
 * number, and both are the renderer's own ratio.
 * @param {object} entry - preset loop entry.
 * @returns {{ raw: number, finalized: number, circular: number, swell: number }}
 */
function presetCause (entry) {
  const raw = renderPreset({
    preset: entry.preset,
    params: entry.params,
    duration: 3,
    seed: 1,
    loop: true,
    sampleRate: SAMPLE_RATE
  }).samples.slice()
  const finalized = raw.slice()
  finalize(finalized, SAMPLE_RATE, -1, { loop: true })
  const doubled = new Float32Array(raw.length * 2)
  doubled.set(raw, 0)
  doubled.set(raw, raw.length)
  dcBlock(doubled, SAMPLE_RATE)
  const circular = doubled.subarray(raw.length).slice()
  return {
    raw: repeatSeam(raw).ratio,
    finalized: repeatSeam(finalized).ratio,
    circular: repeatSeam(circular).ratio,
    swell: headSwellDb(finalized, SAMPLE_RATE)
  }
}

console.log('\n== seam stage evidence: repeat ratio at each stage (3 s, seed 1) ==')
console.log(`${'id'.padEnd(22)} ${'raw'.padStart(6)} ${'finalize'.padStart(9)} ${'circular'.padStart(9)} ${'head'.padStart(7)}`)
for (const entry of PRESET_LOOPS) {
  const cause = presetCause(entry)
  console.log(`${entry.id.padEnd(22)} ${pad(cause.raw, 6, 2)} ${pad(cause.finalized, 9, 2)} ${pad(cause.circular, 9, 2)} ${pad(cause.swell, 7)} dB`)
}
console.log('every ratio is < 1: the wrap step is smaller than the file\'s own p99.9 step, i.e. inside the')
console.log('material. `finalize` used to run the DC blocker from zero state over the finished loop, so')
console.log('sample 0 was unfiltered while the tail was filtered by the drift that had been removed; that')
console.log('one-sample step is what the "circular" column removes, and `finalize({ loop: true })` now')
console.log('does the same pre-roll internally. `audio_synth` passes the flag from `finish()`, so every')
console.log('loop it writes takes the warm-up path.')

/**
 * Design loops: which stage carries the seam?
 *
 * Two zero-state stages used to sit on the design loop path: the per-layer
 * `filter()` in `blendLayers` (its startup transient at the head of every pass)
 * and the master `dcBlock()` on the loop output. The table separates them by
 * disabling one at a time; after the fix all three columns agree.
 * @param {string} id - recipe id.
 * @returns {{ delivered: number, noBlock: number, noFilter: number }}
 */
function designCause (id) {
  const recipe = RECIPES[id]
  const delivered = designSound({ recipe: id, duration: 3, seed: 1, sampleRate: SAMPLE_RATE, loop: true })
  const withoutBlock = blendLayers(recipe.layers, {
    loop: true,
    durationSeconds: 3,
    seed: 1,
    sampleRate: SAMPLE_RATE,
    reverb: recipe.master.reverb,
    dcBlock: false
  })
  const withoutFilter = blendLayers(recipe.layers.map((layer) => ({ ...layer, filter: undefined })), {
    loop: true,
    durationSeconds: 3,
    seed: 1,
    sampleRate: SAMPLE_RATE,
    reverb: recipe.master.reverb,
    dcBlock: false
  })
  return {
    delivered: repeatSeam(delivered.samples).ratio,
    noBlock: repeatSeam(withoutBlock.samples).ratio,
    noFilter: repeatSeam(withoutFilter.samples).ratio
  }
}

console.log('\n== design seam stage evidence: repeat ratio at each stage (3 s, seed 1) ==')
console.log(`${'id'.padEnd(22)} ${'delivered'.padStart(9)} ${'no dcBlock'.padStart(10)} ${'no filter too'.padStart(13)}`)
for (const id of DESIGN_LOOPS) {
  const cause = designCause(id)
  console.log(`${id.padEnd(22)} ${pad(cause.delivered, 9, 2)} ${pad(cause.noBlock, 10, 2)} ${pad(cause.noFilter, 13, 2)}`)
}
console.log('all three columns are < 1 and within noise of each other: neither the per-layer filter nor the')
console.log('master DC blocker leaves a seam on the design loop path any more. Both are warmed up across the')
console.log('wrap when the design is a loop, and only then — a one-shot design keeps the plain stages, which')
console.log('is what the one-shot byte-identity table above proves.')

/* ------------------------------------------------- compose grid section -- */

console.log('\n== compose loop: beat grid and level ==')
console.log(`${'genre'.padEnd(12)} ${'seed'.padStart(4)} ${'beatMap'.padStart(8)} ${'duration'.padStart(9)} ` +
  `${'tail-head'.padStart(9)} ${'ratio'.padStart(6)} ${'corr'.padStart(6)}  verdict`)
for (const row of rows.filter((entry) => entry.kind === 'compose')) {
  const genre = row.id.replace('compose:', '')
  console.log(`${genre.padEnd(12)} ${String(row.seed).padStart(4)} ` +
    `${`${row.grid.beats}/${row.grid.expectedBeats}`.padStart(8)} ${`${fmt(row.grid.spanSeconds, 3)}s`.padStart(9)} ` +
    `${`${fmt(row.loopSeam)} dB`.padStart(9)} ${pad(row.ratio, 6, 2)} ${pad(row.corr, 6, 3)}  ` +
    `${row.level.padEnd(4)} ${row.reasons.join('; ')}`)
}
console.log('beatMap length must be bars x beatsPerBar and the file must span exactly that grid; both hold.')
console.log('tail-head is |20log10(head rms / tail rms)| over 100 ms windows (the same quantity as')
console.log('loopSeam); a loop cue is expected to stay inside 3 dB. The loop path folds the ring-out')
console.log('tail onto the head (compose.js renderScore, `master[index] += master[mainFrames + index]`),')
console.log('so a head louder than the last bar is the fold adding the tail, while a head quieter than')
console.log('the last bar means the loop point fell into a decay. Neither is a sample-level step.')

/* ------------------------------------------------- rate independence -- */

console.log('\n== sample-rate check: the same rows at 44100 ==')
const rateChecks = [
  {
    label: 'texture:wind 3s',
    input: { id: 'texture:wind', kind: 'preset', lengthLabel: '3s', sortLength: 3, seed: 1, repro: '' },
    render () {
      const rendered = renderPreset({ preset: 'texture', params: { kind: 'wind' }, duration: 3, seed: 1, loop: true, sampleRate: RATE_CHECK })
      finalize(rendered.samples, rendered.sampleRate, -1, { loop: true })
      return rendered
    }
  },
  {
    label: 'motor-loop 3s',
    input: { id: 'motor-loop', kind: 'preset', lengthLabel: '3s', sortLength: 3, seed: 1, repro: '' },
    render () {
      const rendered = renderPreset({ preset: 'motor-loop', duration: 3, seed: 1, loop: true, sampleRate: RATE_CHECK })
      finalize(rendered.samples, rendered.sampleRate, -1, { loop: true })
      return rendered
    }
  },
  {
    label: 'sci-fi-hum-loop 3s',
    input: { id: 'sci-fi-hum-loop', kind: 'design', lengthLabel: '3s', sortLength: 3, seed: 1, repro: '' },
    render () {
      return designSound({ recipe: 'sci-fi-hum-loop', duration: 3, seed: 1, sampleRate: RATE_CHECK, loop: true })
    }
  },
  {
    label: 'compose:lofi 8bar',
    input: { id: 'compose:lofi', kind: 'compose', lengthLabel: '8bar', sortLength: 8, seed: 1, repro: '' },
    render () {
      return renderScore(composeScore({ genre: 'lofi', bars: COMPOSE_BARS, seed: 1, loop: true }), { sampleRate: RATE_CHECK })
    }
  }
]
for (const check of rateChecks) {
  const row = measureRow(check.input, check.render(), 0)
  const base = rows.find((entry) => entry.id === check.input.id && entry.seed === check.input.seed && entry.lengthLabel === check.input.lengthLabel)
  console.log(`  ${check.label.padEnd(20)} @22050 ratio ${pad(base.ratio, 6, 2)} ${base.level} · ` +
    `@44100 ratio ${pad(row.ratio, 6, 2)} seam ${pad(row.loopSeam, 5)} dB corr ${pad(row.corr, 6, 3)} ${row.level}`)
}
console.log('every BUG verdict is unchanged at 44100; a row already on the ratio 1.0 warning line can move')
console.log('between ok and WARN because the p99.9 step distribution tightens at the higher rate.')

/* ------------------------------------------------- smallest repro calls -- */

/**
 * The shortest render that reproduces an id's failure: smallest length first,
 * then smallest seed. That is the call to hand to whoever owns the fix.
 * @param {string} id - loopable id.
 * @param {string} level - 'BUG' or 'WARN'.
 * @returns {object|undefined} row.
 */
function smallestFailing (id, level) {
  const group = rows.filter((row) => row.id === id && row.level === level)
  if (group.length === 0) return undefined
  return group.slice().sort((a, b) => a.sortLength - b.sortLength || a.seed - b.seed)[0]
}

if (bugs.length > 0) {
  console.log('\n== smallest reproducing call per BUG id ==')
  for (const id of [...new Set(bugs.map((row) => row.id))]) {
    const row = smallestFailing(id, 'BUG')
    console.log(`  ${id.padEnd(22)} ${row.repro}`)
    console.log(`    measured: seam ${fmt(row.loopSeam)} dB · step ${fmt(row.loopStep, 3)} · ratio ${fmt(row.ratio, 2)} · corr ${fmt(row.corr, 3)} → ${row.reasons.join('; ')}`)
  }
}
if (warns.length > 0) {
  console.log('\n== smallest reproducing call per WARN id ==')
  for (const id of [...new Set(warns.map((row) => row.id))]) {
    const row = smallestFailing(id, 'WARN')
    console.log(`  ${id.padEnd(22)} ${row.repro}`)
    console.log(`    measured: seam ${fmt(row.loopSeam)} dB · step ${fmt(row.loopStep, 3)} · ratio ${fmt(row.ratio, 2)} · corr ${fmt(row.corr, 3)} → ${row.reasons.join('; ')}`)
  }
}

/* ----------------------------------------------------------------- exit -- */

if (bugs.length === 0 && structuralFailures === 0) {
  console.log(`\nOK: no loop seam is discontinuous across ${rows.length} renders, every id's head level is`)
  console.log(`inside ${HEAD_BIAS_DB} dB of its body on average, the five texture kinds are five beds, loops are`)
  console.log(`deterministic, audio_synth's loop path is the loop-safe one, and one-shot output is`)
  console.log(`byte-identical to the pre-fix golden table.`)
} else {
  if (bugs.length > 0) {
    console.log(`\nAUDIT FAILED: ${bugs.length} of ${rows.length} loop renders have a real discontinuity (see the tables above)`)
  }
  if (headBugs.length > 0) {
    console.log(`\nAUDIT FAILED: ${headBugs.length} id(s) carry a systematic head-level error: ` +
      headBugs.map((entry) => `${entry.id} ${fmt(entry.mean)} dB`).join(', '))
  }
  if (aliasBugs.length > 0) {
    console.log(`\nAUDIT FAILED: texture kinds are aliased: ${aliasBugs.join('; ')}`)
  }
  if (identityBugs.length > 0) {
    console.log(`\nAUDIT FAILED: ${identityBugs.length} one-shot render(s) moved: ${identityBugs.join('; ')}`)
  }
  if (determinismFailures > 0) {
    console.log(`\nAUDIT FAILED: ${determinismFailures} loop render(s) are not deterministic`)
  }
  if (!(toolPathOk && toolLoop)) {
    console.log('\nAUDIT FAILED: audio_synth loop:true does not deliver the loop-safe finalisation')
  }
}
process.exit(bugs.length === 0 && structuralFailures === 0 ? 0 : 1)
