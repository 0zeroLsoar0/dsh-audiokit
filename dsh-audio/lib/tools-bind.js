/**
 * `audio_bind` and `audio_regress`: the two tools that connect the synth to an
 * animation and keep it honest over time.
 *
 * `audio_bind` turns a list of rendered wav files plus cue times into a cue
 * sheet and a pasteable player. `audio_regress` snapshots the measurements of a
 * set of sounds and later proves a change did not move them — or names the
 * metric and sound that moved.
 */

import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import { DEFAULT_MAX_INLINE_BYTES, buildCueSheet, cueScheduleDrift, inlineAudio } from './bind.js'
import { PRESETS } from './dsp.js'
import { compare, snapshot } from './regress.js'
import { decodeWav } from './wav.js'

const PRESET_NAMES = Object.keys(PRESETS)
const DEFAULT_BASELINE = 'assets/audio/regress-baseline.json'

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

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatRow (row) {
  const show = (value) => {
    if (value === null || value === undefined) return '-'
    if (typeof value === 'number') return Number(value).toFixed(2)
    const text = String(value)
    return text.length > 12 ? `${text.slice(0, 10)}…` : text
  }
  return '  ' +
    String(row.name).padEnd(14) + ' ' +
    String(row.metric).padEnd(15) + ' ' +
    show(row.baseline).padStart(10) + ' ' +
    show(row.current).padStart(10) + ' ' +
    show(row.delta).padStart(9) + ' ' +
    String(row.tolerance).padStart(6) + '  ' +
    String(row.status).toUpperCase()
}

function renderTable (rows, limit = 40) {
  const lines = [
    '  ' + 'spec'.padEnd(14) + ' ' + 'metric'.padEnd(15) + ' ' +
    'baseline'.padStart(10) + ' ' + 'current'.padStart(10) + ' ' +
    'delta'.padStart(9) + ' ' + 'tol'.padStart(6) + '  status'
  ]
  for (const row of rows.slice(0, limit)) lines.push(formatRow(row))
  if (rows.length > limit) lines.push(`  … ${rows.length - limit} more row(s) not shown`)
  return lines
}

/** Validate and read one cue entry: the wav duration is needed for the timeline. */
async function loadCue (cwd, cue, index) {
  const name = String(cue?.name ?? '').trim() || `cue-${index + 1}`
  const at = Number(cue?.at)
  if (!Number.isFinite(at) || at < 0) throw new Error(`cue "${name}" needs at >= 0 seconds`)
  const requested = typeof cue?.path === 'string' ? cue.path.trim() : ''
  if (requested === '') throw new Error(`cue "${name}" needs a wav path`)
  const path = resolvePath(cwd, requested)
  if (path === undefined) throw new Error(`cue "${name}" has an unusable path "${cue.path}"`)
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`cue "${name}": cannot read ${displayPath(cwd, path)} (${error.code ?? error.message})`)
  }
  const decoded = decodeWav(bytes)
  return {
    name,
    at,
    path,
    bytes,
    durationSeconds: decoded.durationSeconds,
    gainDb: Number.isFinite(Number(cue?.gainDb)) ? Number(cue.gainDb) : 0,
    fadeIn: Number.isFinite(Number(cue?.fadeIn)) ? Number(cue.fadeIn) : 0,
    fadeOut: Number.isFinite(Number(cue?.fadeOut)) ? Number(cue.fadeOut) : 0,
    loop: cue?.loop === true
  }
}

/** Strip a `.json` / `.js` extension from a requested output stem. */
function outputStem (requested) {
  return requested.replace(/\.(?:json|js)$/i, '')
}

/* ---- tools ---- */

/** Register `audio_bind` and `audio_regress` on `ctx.tools`. */
export function registerBindTools (ctx) {
  ctx.tools.register({
    name: 'audio_bind',
    description: 'Turn rendered wav files plus cue times into a cue sheet player for an HTML animation. Writes <out>.json and <out>.js; with inline:true the wavs are embedded as base64 so the page is one self-contained file with no network requests. Returns the written paths, page weight and a sample-level drift budget.',
    parameters: {
      type: 'object',
      properties: {
        cues: {
          type: 'array',
          description: 'One entry per sound event: the wav path (relative to the working directory) and the second it should fire. Times are on the animation timeline, not the wav timeline.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Cue name used by dshAudio.play(name); defaults to cue-1, cue-2, ...' },
              at: { type: 'number', description: 'Start time in seconds from the beginning of the animation.' },
              path: { type: 'string', description: 'Wav file path, relative to the working directory or absolute.' },
              gainDb: { type: 'number', description: 'Level trim in dB applied in the page; defaults to 0.' },
              fadeIn: { type: 'number', description: 'Fade-in seconds; use it for ambience beds, not for hits. Defaults to 0.' },
              fadeOut: { type: 'number', description: 'Fade-out seconds; default 0.' },
              loop: { type: 'boolean', description: 'Loop until the end of the timeline. Loops cannot be double-started.' }
            },
            required: ['at', 'path']
          }
        },
        out: { type: 'string', description: 'Output stem, relative to the working directory; writes <out>.json and <out>.js. Defaults to assets/audio/cues-<hash>.' },
        duration: { type: 'number', description: 'Timeline length in seconds; defaults to the end of the last cue, including its wav.' },
        inline: { type: 'boolean', description: 'Embed the wavs as base64 data URIs so the HTML has zero network requests. Defaults to false.' },
        maxBytes: { type: 'integer', description: `Inline page-weight budget in bytes; defaults to ${DEFAULT_MAX_INLINE_BYTES} (2 MB).` },
        basePath: { type: 'string', description: 'Prefix for relative cue sources when not inlining, e.g. "assets/audio/".' },
        sampleRate: { type: 'integer', description: 'Device sample rate used for the drift budget; defaults to 48000.' }
      },
      required: ['cues'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Bind ${args.cues?.length ?? 0} cue(s)`, kind: 'other', rawInput: { cues: args.cues?.length ?? 0, inline: args.inline === true } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      if (!Array.isArray(args.cues) || args.cues.length === 0) throw new Error('audio_bind needs at least one cue')

      const loaded = []
      for (let index = 0; index < args.cues.length; index += 1) {
        loaded.push(await loadCue(cwd, args.cues[index], index))
      }
      // A name is how the page triggers a cue, so duplicates are a bug, not a detail.
      const names = new Set()
      for (const cue of loaded) {
        if (names.has(cue.name)) throw new Error(`duplicate cue name "${cue.name}"`)
        names.add(cue.name)
      }

      const timelineEnd = Math.max(...loaded.map((cue) => cue.at + cue.durationSeconds))
      const duration = Number.isFinite(Number(args.duration)) ? Number(args.duration) : Math.round(timelineEnd * 1000) / 1000
      const sampleRate = Number.isFinite(Number(args.sampleRate)) ? Number(args.sampleRate) : 48000

      let inlineResult = null
      if (args.inline === true) {
        try {
          inlineResult = await inlineAudio({
            entries: loaded.map((cue) => ({ name: cue.name, bytes: cue.bytes })),
            maxBytes: args.maxBytes,
            cwd
          })
        } catch (error) {
          if (error.code !== 'AUDIO_TOO_LARGE') throw error
          return {
            ok: false,
            refused: true,
            inline: true,
            maxBytes: error.maxBytes,
            pageWeightBytes: error.totalBytes,
            rawBytes: error.rawBytes,
            text: `Refused to inline ${loaded.length} cue(s): ${error.message}`
          }
        }
      }
      const inlineByName = new Map((inlineResult?.entries ?? []).map((entry) => [entry.name, entry.src]))
      const cueInputs = loaded.map((cue) => ({
        name: cue.name,
        at: cue.at,
        ...(args.inline === true ? { src: inlineByName.get(cue.name) } : { src: displayPath(cwd, cue.path) }),
        gainDb: cue.gainDb,
        fadeIn: cue.fadeIn,
        fadeOut: cue.fadeOut,
        loop: cue.loop
      }))

      const sheet = buildCueSheet({
        cues: cueInputs,
        duration,
        basePath: args.inline === true ? '' : String(args.basePath ?? '')
      })
      const drift = cueScheduleDrift(sheet.cues, sampleRate)

      const hash = hashSpec({ duration, inline: args.inline === true, cues: cueInputs.map((cue) => [cue.name, cue.at, cue.src, cue.gainDb, cue.fadeIn, cue.fadeOut, cue.loop]) })
      const requested = resolvePath(cwd, args.out) ?? resolvePath(cwd, `assets/audio/cues-${hash}`)
      const stem = outputStem(requested)
      const jsonPath = `${stem}.json`
      const jsPath = `${stem}.js`
      const jsonBytes = Buffer.byteLength(sheet.json, 'utf8')
      const jsBytes = Buffer.byteLength(sheet.script, 'utf8')
      await writeFileAtomic(jsonPath, Buffer.from(sheet.json, 'utf8'))
      await writeFileAtomic(jsPath, Buffer.from(sheet.script, 'utf8'))
      const info = await stat(jsPath)

      const pageWeightBytes = jsBytes + (inlineResult?.totalBytes ?? 0)
      const preview = sheet.cues.slice(0, 5)
        .map((cue) => `${fmt(cue.at, 3)}s ${cue.name}${cue.loop ? ' (loop)' : ''}`)
        .join(' · ')
      const more = sheet.cues.length > preview.length ? ` · … +${sheet.cues.length - preview.length} more` : ''
      const lines = [
        `Wrote cue sheet ${displayPath(cwd, jsPath)} + ${displayPath(cwd, jsonPath)} ` +
        `(${sheet.cues.length} cue(s), ${fmt(duration, 2)}s, script ${formatBytes(jsBytes)}, json ${formatBytes(jsonBytes)}, ${info.size} B on disk)`,
        args.inline === true
          ? `  inline: ${loaded.length} sound(s), ${formatBytes(inlineResult.totalBytes)} of base64 (${formatBytes(inlineResult.rawBytes)} raw), page weight ${formatBytes(pageWeightBytes)} of ${formatBytes(inlineResult.maxBytes)} budget`
          : '  external: the page resolves cue paths as written; keep the wavs next to the HTML or set basePath',
        `  drift budget ≤ ${drift.worstCaseSamples} sample(s) at ${drift.sampleRate} Hz (${drift.worstCaseMs} ms): ${drift.math}; ` +
        `timer jitter cannot move a cue (lookahead ${drift.lookahead.aheadSeconds}s > wake ${drift.lookahead.wakeSeconds}s)`,
        `  cues: ${preview}${more}`
      ]

      return {
        ok: true,
        jsonPath,
        jsPath,
        relativeJsonPath: displayPath(cwd, jsonPath),
        relativeJsPath: displayPath(cwd, jsPath),
        jsonBytes,
        jsBytes,
        pageWeightBytes,
        inline: args.inline === true,
        cueCount: sheet.cues.length,
        durationSeconds: duration,
        // Bounded summary: never echo inline base64 back to the model.
        drift: { ...drift, cues: drift.cues.slice(0, 24) },
        cues: sheet.cues.slice(0, 12).map(({ name, at, gainDb, fadeIn, fadeOut, loop }) => ({ name, at, gainDb, fadeIn, fadeOut, loop })),
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_regress',
    description: 'Snapshot a set of sound specs (same shape as audio_synth) as a baseline JSON, then compare a later render against it. Returns a PASS/FAIL table with one row per metric, so a change to a sound can be proven not to break the mix — or the exact metric and spec that broke can be named.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'compare'], description: 'snapshot writes the baseline; compare renders specs again and diffs against baselinePath.' },
        specs: {
          type: 'array',
          description: 'Sound specs to render. Each is the same shape audio_synth accepts plus a unique name.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Spec label used in the table; must be unique.' },
              preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset, same values as audio_synth.' },
              params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs, same names as audio_synth.' },
              duration: { type: 'number', description: 'Length in seconds; defaults to the preset length.' },
              seed: { type: 'integer', description: 'Variation seed; defaults to 1.' },
              loop: { type: 'boolean', description: 'Render a seamless loop.' }
            },
            required: ['name', 'preset']
          }
        },
        baselinePath: { type: 'string', description: `Baseline JSON path, relative to the working directory. Defaults to ${DEFAULT_BASELINE}.` },
        label: { type: 'string', description: 'Snapshot-only note stored as createdAtNote (there are no timestamps, so runs stay byte-identical).' },
        sampleRate: { type: 'integer', description: 'Render rate for the snapshot; defaults to 44100.' },
        tolerances: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional overrides. Defaults: peak ±0.5 dB, rms ±1 dB, crest ±1.5 dB, centroid ±8 %, duration ±10 ms, onsets exact, bytes exact.',
          properties: {
            peakDbfs: { type: 'number' },
            rmsDbfs: { type: 'number' },
            crestDb: { type: 'number' },
            centroidPct: { type: 'number' },
            durationSeconds: { type: 'number' },
            onsets: { type: 'number' },
            strictBytes: { type: 'boolean', description: 'Compare sha256 of the wav bytes; defaults to true.' }
          }
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Regression ${args.action ?? 'snapshot'}`, kind: 'other', rawInput: { action: args.action, specs: args.specs?.length ?? 0 } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const baselinePath = resolvePath(cwd, args.baselinePath ?? DEFAULT_BASELINE)
      if (baselinePath === undefined) throw new Error('audio_regress: unusable baselinePath')

      if (args.action === 'snapshot') {
        if (!Array.isArray(args.specs) || args.specs.length === 0) throw new Error('audio_regress snapshot needs specs')
        const data = snapshot(args.specs, { label: args.label, sampleRate: args.sampleRate })
        const json = `${JSON.stringify(data, null, 2)}\n`
        await writeFileAtomic(baselinePath, Buffer.from(json, 'utf8'))
        const info = await stat(baselinePath)
        const lines = [
          `Baseline written to ${displayPath(cwd, baselinePath)} (${data.specs.length} spec(s), engine v${data.engine}, ${formatBytes(info.size)})` +
          (data.createdAtNote ? ` · note "${data.createdAtNote}"` : ''),
          ...data.specs.slice(0, 10).map((spec) => {
            const m = spec.metrics
            return `  ${spec.name.padEnd(14)} ${fmt(m.durationSeconds, 2)}s  peak ${fmt(m.peakDbfs)}  rms ${fmt(m.rmsDbfs)}  ` +
              `centroid ${m.centroidHz} Hz  onsets ${m.onsets}  sha256 ${spec.sha256.slice(0, 12)}`
          })
        ]
        if (data.specs.length > 10) lines.push(`  … ${data.specs.length - 10} more spec(s) not shown`)
        return {
          ok: true,
          action: 'snapshot',
          path: baselinePath,
          relativePath: displayPath(cwd, baselinePath),
          bytes: info.size,
          engine: data.engine,
          specs: data.specs.length,
          createdAtNote: data.createdAtNote,
          text: lines.join('\n')
        }
      }

      if (args.action !== 'compare') throw new Error(`audio_regress action must be snapshot or compare, got "${args.action}"`)
      if (!Array.isArray(args.specs) || args.specs.length === 0) throw new Error('audio_regress compare needs specs to re-render')
      let baseline
      try {
        baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
      } catch (error) {
        throw new Error(`audio_regress: cannot read baseline ${displayPath(cwd, baselinePath)} (${error.code ?? error.message}); run action=snapshot first`)
      }
      const current = snapshot(args.specs, { label: args.label, sampleRate: args.sampleRate })
      const result = compare(baseline, current, args.tolerances)
      const engineLine = result.engine.same
        ? `engine v${result.engine.current}`
        : `engine v${result.engine.baseline} → v${result.engine.current} (changed, bytes will differ)`
      const lines = [
        `${result.pass ? 'PASS' : 'FAIL'}  ${result.failures.length} failing row(s), ${current.specs.length} spec(s), ${engineLine}` +
        (baseline.createdAtNote ? ` · baseline note "${baseline.createdAtNote}"` : ''),
        ...renderTable(result.rows)
      ]
      return {
        ok: result.pass,
        pass: result.pass,
        action: 'compare',
        failing: result.failures.length,
        baselinePath,
        relativeBaselinePath: displayPath(cwd, baselinePath),
        engine: result.engine,
        tolerances: result.tolerances,
        rows: result.rows,
        failures: result.failures,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
