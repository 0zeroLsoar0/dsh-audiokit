/**
 * `audio_analyze`: the ear.
 *
 * `audio_probe` answers "how loud and how long" and `audio_lipsync`/`audio_beats`
 * answer "what should the picture do"; this tool answers "what is inside the
 * sound" — fundamental, partials and inharmonicity, spectral tilt, noisiness,
 * formants, decay and onset. It is what lets an agent decide whether a
 * synthesised door slam reads as metal, whether a chime is too pure, or whether
 * a tweak kept the character (with `compareWith`).
 *
 * Like the other analysis tools it accepts either an existing file (`path`) or
 * an inline render spec (`render`), and returns a bounded summary plus the
 * report; the optional `out` writes the whole report as JSON.
 */

import { join, relative } from 'node:path'
import { PRESETS, clamp } from './dsp.js'
import { finalize, hashSpec, readTrack, renderPreset, resolvePath, writeFileAtomic } from './audio.js'
import { analyzeSound, compareSounds, describeReport } from './analyze.js'

const PRESET_NAMES = Object.keys(PRESETS)

/** Search limits for the fundamental, mirroring the tool's documented range. */
const F0_RANGE_LIMITS = Object.freeze([40, 2000])

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

function fmt (value, digits = 2) {
  if (!Number.isFinite(value)) return '-'
  return Number(value).toFixed(digits)
}

/** One table cell; `null` (not measurable) prints as n/a rather than 0. */
function cell (value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a'
}

/**
 * Resolve the file to write. A bare stem gets `.json` appended; an explicit
 * name is kept, because the caller may be feeding another tool that wants it.
 */
function outputTarget (cwd, requested, label, hash) {
  const resolved = resolvePath(cwd, requested)
  if (resolved === undefined) return join(cwd, 'assets', 'audio', `${label}-${hash}.json`)
  const base = resolved.split(/[\\/]/).pop() ?? ''
  return base.includes('.') ? resolved : `${resolved}.json`
}

/**
 * Load the signal to analyse: a file on disk, or a fresh render of one preset.
 * Returns the spec too, so an output file can be named after what produced the
 * samples and the summary can say which source it read.
 */
async function loadSource (cwd, args, toolName) {
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const path = resolvePath(cwd, args.path)
    if (path === undefined) throw new Error(`${toolName} needs a readable .wav path`)
    const track = await readTrack(path)
    return {
      samples: track.samples,
      sampleRate: track.sampleRate,
      path,
      spec: null,
      label: displayPath(cwd, path)
    }
  }

  const render = args.render
  if (render !== null && typeof render === 'object') {
    const preset = String(render.preset ?? '')
    if (!PRESET_NAMES.includes(preset)) {
      throw new Error(`${toolName}: render.preset must be one of ${PRESET_NAMES.join(', ')}`)
    }
    const spec = {
      preset,
      params: render.params ?? {},
      duration: Number.isFinite(render.duration) ? render.duration : undefined,
      seed: Number.isFinite(render.seed) ? render.seed : 1,
      sampleRate: Number.isFinite(render.sampleRate) ? render.sampleRate : 44100,
      loop: render.loop === true
    }
    const rendered = renderPreset(spec)
    // An inline render is analysed exactly as it would be written: DC removed,
    // peak normalised, soft-limited. Without this a report on `render` would
    // claim a peak above 0 dBFS and quote every partial a couple of dB hot
    // against the same sound read back from disk with `path`.
    finalize(rendered.samples, rendered.sampleRate, -1, { loop: spec.loop })
    return {
      samples: rendered.samples,
      sampleRate: rendered.sampleRate,
      path: null,
      spec,
      label: `render ${preset}`
    }
  }

  throw new Error(`${toolName} needs either path (an existing .wav) or render (an inline preset spec)`)
}

/**
 * Clamp the pitch search range. A caller that asks for [10, 5000] gets the
 * documented [40, 2000]; a reversed range is put back in order.
 */
function readF0Range (value) {
  const requested = Array.isArray(value) ? value : []
  const first = Number.isFinite(requested[0]) ? requested[0] : F0_RANGE_LIMITS[0]
  const second = Number.isFinite(requested[1]) ? requested[1] : F0_RANGE_LIMITS[1]
  const low = clamp(Math.min(first, second), F0_RANGE_LIMITS[0], F0_RANGE_LIMITS[1] - 1)
  const high = clamp(Math.max(first, second), low + 1, F0_RANGE_LIMITS[1])
  return [low, high]
}

function renderSchema () {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Inline render spec instead of path, rendered first.',
    properties: {
      preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset to render before analysing.' },
      params: { type: 'object', additionalProperties: true, description: 'Preset knobs, same names as audio_synth.' },
      duration: { type: 'number', description: 'Length in seconds; defaults to the preset length.' },
      seed: { type: 'integer', description: 'Variation seed; same seed reproduces the same take.' },
      sampleRate: { type: 'integer', description: 'Defaults to 44100.' },
      loop: { type: 'boolean', description: 'Render a seamless loop before analysis.' }
    },
    required: ['preset']
  }
}

/**
 * The comparison as a fixed-width table: the verdict line names the metrics
 * that changed, so an agent does not have to diff two reports by eye.
 */
function comparisonText (labelA, labelB, comparison) {
  const passed = comparison.rows.filter((row) => row.status === 'pass').length
  const failed = comparison.rows.filter((row) => row.status === 'fail').length
  const skipped = comparison.rows.filter((row) => row.status === 'skip').length
  const verdict = comparison.pass
    ? 'PASS - same character'
    : `FAIL - changed: ${comparison.failed.join(', ')}`
  const lines = [`Compared ${labelA} vs ${labelB}: ${passed} pass, ${failed} fail, ${skipped} skip - ${verdict}`]
  lines.push(
    `${'metric'.padEnd(28)}${'a'.padStart(11)}${'b'.padStart(11)}` +
    `${'delta'.padStart(11)}${'allowed'.padStart(11)}  verdict`
  )
  for (const row of comparison.rows) {
    const delta = Number.isFinite(row.delta) ? `${row.delta >= 0 ? '+' : ''}${cell(row.delta)}` : 'n/a'
    const allowed = Number.isFinite(row.tolerance) ? cell(row.tolerance) : 'n/a'
    lines.push(
      `${row.metric.padEnd(28)}${cell(row.a).padStart(11)}${cell(row.b).padStart(11)}` +
      `${delta.padStart(11)}${allowed.padStart(11)}  ${row.status.toUpperCase()}` +
      `${row.spec ? ` ${row.spec}` : ''}${row.note ? ` (${row.note})` : ''}`
    )
  }
  return lines.join('\n')
}

/** Register `audio_analyze` on `ctx.tools`. */
export function registerAnalyzeTools (ctx) {
  ctx.tools.register({
    name: 'audio_analyze',
    description: 'Report what is inside a sound rather than only how loud it is: fundamental, partials, spectral tilt/centroid, noisiness, formants, RT60 and onset shape. With compareWith it returns a metric-by-metric comparison, so a change can be proven to keep the character.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing .wav, relative to cwd or absolute; omit when using render.' },
        render: renderSchema(),
        f0Range: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Fundamental search range in Hz, clamped to 40..2000; default [40, 2000].'
        },
        maxHarmonics: { type: 'integer', description: 'Partials to list, 1..64; default 8.' },
        compareWith: {
          type: 'object',
          additionalProperties: false,
          description: 'Second sound (a path string or an object); returns a metric-by-metric comparison table.',
          properties: {
            path: { type: 'string', description: 'Existing .wav to compare against, relative to the working directory or absolute.' },
            render: renderSchema()
          }
        },
        tolerances: {
          type: 'object',
          additionalProperties: true,
          description: 'Per-metric tolerance overrides (a number, or { relative } / { absolute }); keys in skill.'
        },
        out: { type: 'string', description: 'Write the JSON report here (defaults to no file; the report is still returned inline).' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: args.compareWith ? 'Compare sounds' : 'Analyse sound',
      kind: 'other',
      rawInput: { source: args.path ?? args.render?.preset, compareWith: args.compareWith?.path ?? args.compareWith?.render?.preset ?? args.compareWith }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const f0Range = readF0Range(args.f0Range)
      const maxHarmonics = clamp(Math.round(Number.isFinite(args.maxHarmonics) ? args.maxHarmonics : 8), 1, 64)
      const source = await loadSource(cwd, args, 'audio_analyze')
      const options = { f0Range, maxHarmonics }
      const report = analyzeSound(source.samples, source.sampleRate, options)

      let other = null
      let otherReport = null
      let comparison = null
      if (args.compareWith !== undefined && args.compareWith !== null) {
        const requested = typeof args.compareWith === 'string' ? { path: args.compareWith } : args.compareWith
        if (requested === null || typeof requested !== 'object') {
          throw new Error('audio_analyze: compareWith must be a path string, { path } or { render }')
        }
        other = await loadSource(cwd, requested, 'audio_analyze compareWith')
        otherReport = analyzeSound(other.samples, other.sampleRate, options)
        const tolerances = args.tolerances !== null && typeof args.tolerances === 'object' ? args.tolerances : {}
        comparison = compareSounds(report, otherReport, tolerances)
      }

      let target = null
      let bytes = 0
      if (typeof args.out === 'string' && args.out.trim() !== '') {
        const hash = hashSpec({
          source: source.spec ?? source.path,
          compareWith: other === null ? null : (other.spec ?? other.path),
          f0Range,
          maxHarmonics
        })
        target = outputTarget(cwd, args.out, 'analyze', hash)
        const payload = {
          format: 'dsh-audio-analyze',
          version: 1,
          source: {
            path: source.path === null ? null : displayPath(cwd, source.path),
            spec: source.spec,
            durationSeconds: report.durationSeconds,
            sampleRate: report.sampleRate
          },
          options: { f0Range, maxHarmonics },
          report,
          compareWith: other === null
            ? null
            : {
                path: other.path === null ? null : displayPath(cwd, other.path),
                spec: other.spec,
                report: otherReport,
                comparison
              }
        }
        const content = JSON.stringify(payload, null, 2)
        bytes = Buffer.byteLength(content)
        await writeFileAtomic(target, Buffer.from(content, 'utf8'))
      }

      const where = target === null
        ? 'no file written (pass out to save the JSON)'
        : `wrote ${displayPath(cwd, target)} (${(bytes / 1024).toFixed(1)} KB)`
      const header = `Analysed ${source.label}: ${fmt(report.durationSeconds, 2)} s @ ${report.sampleRate} Hz - ${where}`
      const text = comparison === null
        ? `${header}\n${describeReport(report)}`
        : `${header}\n${comparisonText(source.label, other.label, comparison)}`

      return {
        path: target,
        relativePath: target === null ? null : displayPath(cwd, target),
        bytes,
        durationSeconds: report.durationSeconds,
        sampleRate: report.sampleRate,
        f0Hz: report.f0.hz,
        f0Confidence: report.f0.confidence,
        formantHz: report.formants.map((row) => row.hz),
        centroidHz: report.centroidHz,
        noisiness: report.noisiness,
        rt60Seconds: report.decay.rt60Seconds,
        onsetType: report.onset.type,
        report,
        comparison: comparison === null
          ? null
          : { pass: comparison.pass, failed: comparison.failed, skipped: comparison.skipped, rows: comparison.rows },
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

/** Exported for docs/settings, mirroring `PRESET_NAMES` in tools.js. */
export { F0_RANGE_LIMITS, PRESET_NAMES }
