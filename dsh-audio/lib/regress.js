/**
 * The regression gate: prove that a change to a sound did not break the mix.
 *
 * A snapshot renders a list of specs, measures the samples with the same
 * `measure()` the tools report, and hashes a deterministic (undithered) wav
 * encoding of those samples. Snapshot data contains no timestamp: the same
 * engine and the same specs must serialize to the same bytes, so a baseline is
 * diffable in git and two runs of the gate agree.
 *
 * Note on the hash: the delivered `.wav` files are dithered with random noise
 * by `encodeWav`, so their bytes are not reproducible. The gate hashes the
 * same samples encoded without dither, which is why snapshots are compared to
 * snapshots, never a snapshot hash to a file hash.
 *
 * `compare` then turns the two snapshots into a table of rows, one per metric,
 * with a tolerance per metric. `strictBytes` is on by default: a byte change
 * is a regression even when the coarse metrics still look identical, because
 * an animation's mix was tuned against the previous take.
 */

import { createHash } from 'node:crypto'
import { ENGINE_VERSION, finalize, measure, renderPreset } from './audio.js'
import { clamp } from './dsp.js'
import { encodeWav } from './wav.js'

/**
 * Default tolerances. Units: dB for peak/rms/crest, percent for centroid,
 * seconds for duration, exact for onsets and sha256.
 */
export const DEFAULT_TOLERANCES = Object.freeze({
  peakDbfs: 0.5,
  rmsDbfs: 1.0,
  crestDb: 1.5,
  centroidPct: 8,
  durationSeconds: 0.01,
  onsets: 0,
  sha256: 0,
  strictBytes: true
})

const TOLERANCE_KEYS = Object.keys(DEFAULT_TOLERANCES)

/** Merge caller tolerances over the defaults, ignoring junk instead of throwing later. */
function resolveTolerances (tolerances = {}) {
  const resolved = { ...DEFAULT_TOLERANCES }
  if (tolerances === null || typeof tolerances !== 'object') return resolved
  for (const [key, value] of Object.entries(tolerances)) {
    if (!TOLERANCE_KEYS.includes(key)) continue
    if (key === 'strictBytes') {
      if (typeof value === 'boolean') resolved.strictBytes = value
    } else if (Number.isFinite(Number(value)) && Number(value) >= 0) {
      resolved[key] = Number(value)
    }
  }
  return resolved
}

const round = (value, digits) => Number(Number(value).toFixed(digits))

/* ---- snapshot ---- */

/**
 * Build a baseline from preset specs.
 *
 * Each spec has the same shape `audio_synth` accepts: `{ name, preset, params,
 * duration, seed, loop }`. Rendering applies `finalize()` exactly like
 * `audio_synth` does before writing, so the metrics match what `audio_probe`
 * would report on the delivered file. The wav bytes are encoded without
 * dither, because dither is random noise and would make the hash meaningless;
 * that also means a snapshot hash is comparable to another snapshot, not to
 * the bytes of a dsh-audio `.wav` file.
 *
 * @param {object[]} specs - render specs, `name` must be unique.
 * @param {{ label?: string, sampleRate?: number }} [options]
 * @returns {{ engine: number, specs: { name: string, metrics: object, sha256: string }[], createdAtNote: string }}
 */
export function snapshot (specs, options = {}) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('snapshot needs at least one spec')
  }
  const sampleRate = clamp(Math.round(Number(options.sampleRate) || 44100), 8000, 96000)
  const seen = new Set()
  const rendered = specs.map((raw, index) => {
    const spec = raw ?? {}
    const name = String(spec.name ?? `spec-${index + 1}`).trim() || `spec-${index + 1}`
    if (seen.has(name)) throw new Error(`duplicate spec name "${name}"`)
    seen.add(name)
    if (typeof spec.preset !== 'string' || spec.preset === '') {
      throw new Error(`spec "${name}" needs a preset`)
    }
    const result = renderPreset({
      preset: spec.preset,
      params: spec.params ?? {},
      duration: spec.duration,
      seed: Number.isFinite(Number(spec.seed)) ? Math.round(Number(spec.seed)) : 1,
      loop: spec.loop === true,
      sampleRate
    })
    finalize(result.samples, result.sampleRate)
    const bytes = encodeWav([result.samples], result.sampleRate, { dither: false })
    return {
      name,
      metrics: { ...measure(result.samples, result.sampleRate), sampleRate: result.sampleRate },
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  })
  return {
    engine: ENGINE_VERSION,
    specs: rendered,
    // Provenance without a clock: the caller labels the run, so two runs with
    // the same label are byte-identical and the baseline stays diffable.
    createdAtNote: String(options.label ?? '')
  }
}

/** One table row; `percent` makes the delta relative to the baseline. */
function bandRow (name, metric, baseline, current, tolerance, percent = false) {
  let delta = null
  if (typeof baseline === 'number' && typeof current === 'number' &&
      Number.isFinite(baseline) && Number.isFinite(current)) {
    if (percent) delta = baseline === 0 ? (current === 0 ? 0 : null) : (current - baseline) / Math.abs(baseline) * 100
    else delta = current - baseline
  }
  const status = delta === null ? 'fail' : Math.abs(delta) <= tolerance ? 'pass' : 'fail'
  return {
    name,
    metric,
    baseline: typeof baseline === 'number' ? round(baseline, 4) : baseline ?? null,
    current: typeof current === 'number' ? round(current, 4) : current ?? null,
    delta: delta === null ? null : round(delta, 4),
    tolerance,
    status
  }
}

/** Exact row for hashes: any difference fails. */
function exactRow (name, metric, baseline, current, tolerance) {
  const same = typeof baseline === 'string' && typeof current === 'string' && baseline === current
  return {
    name,
    metric,
    baseline: baseline ?? null,
    current: current ?? null,
    delta: same ? 0 : null,
    tolerance,
    status: same ? 'pass' : 'fail'
  }
}

function metricRows (name, baseline, current, t) {
  const rows = []
  const left = baseline.metrics ?? {}
  const right = current.metrics ?? {}
  const numeric = [
    ['peakDbfs', t.peakDbfs, false],
    ['rmsDbfs', t.rmsDbfs, false],
    ['crestDb', t.crestDb, false],
    ['centroidHz', t.centroidPct, true],
    ['durationSeconds', t.durationSeconds, false],
    ['onsets', t.onsets, false]
  ]
  for (const [metric, tolerance, percent] of numeric) {
    rows.push(bandRow(name, metric, left[metric], right[metric], tolerance, percent))
  }
  if (t.strictBytes) rows.push(exactRow(name, 'sha256', baseline.sha256, current.sha256, 'exact'))
  return rows
}

/* ---- compare ---- */

/**
 * Compare two snapshots (or any two arrays of `{ name, metrics, sha256 }`).
 *
 * An engine-version change is reported in `engine` but does not fail the gate
 * by itself: the metric rows and the byte hashes are what decide.
 *
 * @param {object} baseline - snapshot() output.
 * @param {object} current - snapshot() output.
 * @param {object} [tolerances] - overrides from DEFAULT_TOLERANCES.
 * @returns {{ pass: boolean, rows: object[], failures: object[], engine: object, tolerances: object }}
 */
export function compare (baseline, current, tolerances = {}) {
  if (baseline === null || typeof baseline !== 'object' || !Array.isArray(baseline.specs)) {
    throw new Error('compare: baseline must be a snapshot with a specs array')
  }
  if (current === null || typeof current !== 'object' || !Array.isArray(current.specs)) {
    throw new Error('compare: current must be a snapshot with a specs array')
  }
  const t = resolveTolerances(tolerances)
  const currentByName = new Map(current.specs.map((spec) => [spec?.name, spec]))
  const baselineByName = new Map(baseline.specs.map((spec) => [spec?.name, spec]))
  const rows = []

  for (const spec of baseline.specs) {
    if (!currentByName.has(spec?.name)) {
      rows.push({ name: spec?.name ?? 'unknown', metric: 'presence', baseline: 'present', current: 'missing', delta: null, tolerance: 'exact', status: 'fail' })
    }
  }
  for (const spec of current.specs) {
    if (!baselineByName.has(spec?.name)) {
      rows.push({ name: spec?.name ?? 'unknown', metric: 'presence', baseline: 'missing', current: 'present', delta: null, tolerance: 'exact', status: 'fail' })
    }
  }
  for (const baseSpec of baseline.specs) {
    const currentSpec = currentByName.get(baseSpec?.name)
    if (currentSpec === undefined) continue
    rows.push(...metricRows(baseSpec.name, baseSpec, currentSpec, t))
  }

  const failures = rows.filter((row) => row.status === 'fail')
  return {
    pass: failures.length === 0,
    rows,
    failures,
    engine: {
      baseline: baseline.engine ?? null,
      current: current.engine ?? null,
      same: baseline.engine === current.engine
    },
    tolerances: t
  }
}

/**
 * Compare two arbitrary metric objects with the same tolerance rules. This is
 * the gate for renderers that do not produce a preset snapshot (a composed
 * track, a synthesized voice): pass their `make()` metrics in and get rows.
 *
 * The metric object may carry `name` and `sha256`; when `strictBytes` is true
 * and either side has a hash, an exact `sha256` row is added.
 *
 * @param {object} a - baseline metrics.
 * @param {object} b - current metrics.
 * @param {object} [tolerances] - overrides from DEFAULT_TOLERANCES.
 * @returns {{ pass: boolean, rows: object[], failures: object[], tolerances: object }}
 */
export function compareMetrics (a, b, tolerances = {}) {
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
    throw new Error('compareMetrics needs two metric objects')
  }
  const t = resolveTolerances(tolerances)
  const name = String(a.name ?? b.name ?? 'metrics')
  const rows = []
  const numeric = [
    ['peakDbfs', t.peakDbfs, false],
    ['rmsDbfs', t.rmsDbfs, false],
    ['crestDb', t.crestDb, false],
    ['centroidHz', t.centroidPct, true],
    ['durationSeconds', t.durationSeconds, false],
    ['onsets', t.onsets, false]
  ]
  for (const [metric, tolerance, percent] of numeric) {
    if (a[metric] === undefined && b[metric] === undefined) continue
    rows.push(bandRow(name, metric, a[metric], b[metric], tolerance, percent))
  }
  if (t.strictBytes && (a.sha256 !== undefined || b.sha256 !== undefined)) {
    rows.push(exactRow(name, 'sha256', a.sha256, b.sha256, 'exact'))
  }
  const failures = rows.filter((row) => row.status === 'fail')
  return { pass: failures.length === 0, rows, failures, tolerances: t }
}
