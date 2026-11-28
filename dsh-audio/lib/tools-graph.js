/**
 * `audio_synth_graph`: the runtime-synthesis tool.
 *
 * `audio_synth` hands the model 38 finished sounds to choose from; this tool
 * hands it the vocabulary to build one. The model writes a small JSON graph
 * (oscillators, noise, filters, envelopes, LFOs, drive, ring, reverb, sums) and
 * gets a wav plus the usual bounded summary.
 *
 * The important difference from every other render tool is the failure path: a
 * graph is a program written by a language model, so the common case is a typo
 * or a range mistake. On an invalid document this tool throws one readable
 * message naming the first five problems by document path (`nodes[2].hz`), not a
 * stack trace, and nothing is rendered or written — validation runs first and
 * allocates no audio.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { defaultOutputPath, finalize, hashSpec, measure, resolvePath, toWavBytes, writeFileAtomic } from './audio.js'
import { graphCatalog, renderGraph, validateGraph } from './graph.js'

const CATALOG = graphCatalog()
const CATALOG_IDS = CATALOG.map((entry) => entry.id)
const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]))

/* ------------------------------------------------------------- help text -- */

/**
 * Two sentences: what the DSL is and where the field reference lives. The node
 * table that used to sit here is now a section of the `animation-sound` skill,
 * which the model loads on demand instead of paying for it on every request.
 * `test/graph.mjs` still requires every node type, "node id" and "index" to be
 * named here, so this string doubles as the tool's one-line index.
 */
const TOOL_DESCRIPTION = 'Render a sound from a JSON synthesis graph the model writes itself (nodes: osc, noise, filter, env, lfo, gain, drive, ring, pan, reverb, sum). Use it when no preset or recipe expresses the sound; references are a node id string or a 0-based index, and the field-by-field DSL is in the animation-sound skill.'

/* --------------------------------------------------------------- helpers -- */

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

/**
 * Read an optional numeric argument, rejecting only values that have no meaning.
 * Mirrors `readNumber` in lib/tools.js: `undefined`/`null` mean "use the
 * default", a numeric string is accepted because the host may send one, and a
 * literal NaN is a caller error worth reporting.
 */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number`)
  return number
}

/** Shared result summary: the numbers an agent needs to decide what to change. */
function summaryLine (label, cwd, path, bytes, metrics, extra = []) {
  const size = bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
  const parts = [
    `${label} ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${metrics.sampleRate} Hz, ${size})`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${metrics.centroidHz} Hz`,
    `onsets ${metrics.onsets}`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping',
    ...extra
  ]
  return parts.join(' · ')
}

/**
 * The failure path this tool exists for: turn validation errors into one line
 * a model can act on. Five is enough to fix the first round of mistakes without
 * burying the message in a 10 000-node document's every complaint.
 */
function invalidGraphMessage (errors) {
  const shown = errors.slice(0, 5).map((error) => `${error.path}: ${error.message}`)
  const rest = errors.length - shown.length
  const more = rest > 0 ? `; and ${rest} more problem${rest === 1 ? '' : 's'}` : ''
  return `audio_synth_graph: invalid graph — ${shown.join('; ')}${more}`
}

/** Resolve the graph the caller asked for, with catalog defaults for length. */
function resolveRequest (args) {
  const hasGraph = args.graph !== undefined && args.graph !== null
  const hasCatalog = args.catalog !== undefined && args.catalog !== null
  if (hasGraph && hasCatalog) {
    throw new Error('audio_synth_graph: give either `graph` (your own DSL) or `catalog` (an example id), not both — pass the example\'s graph if you want to change it')
  }
  if (!hasGraph && !hasCatalog) {
    throw new Error(`audio_synth_graph: needs a \`graph\` (the DSL) or \`catalog\` (${CATALOG_IDS.join(', ')})`)
  }
  if (hasCatalog) {
    if (typeof args.catalog !== 'string' || !CATALOG_BY_ID.has(args.catalog)) {
      throw new Error(`audio_synth_graph: unknown catalog id ${JSON.stringify(args.catalog)}; available: ${CATALOG_IDS.join(', ')}`)
    }
    const entry = CATALOG_BY_ID.get(args.catalog)
    return { graph: entry.graph, catalogId: entry.id, label: entry.id, duration: entry.duration, seed: entry.seed }
  }
  return { graph: args.graph, catalogId: null, label: 'graph', duration: 1, seed: 1 }
}

/** Register the `audio_synth_graph` tool on `ctx.tools`. */
export function registerGraphTools (ctx) {
  ctx.tools.register({
    name: 'audio_synth_graph',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        graph: {
          type: 'object',
          additionalProperties: true,
          description: 'Graph object { nodes, output? }; DSL in the animation-sound skill.'
        },
        catalog: {
          type: 'string',
          enum: CATALOG_IDS,
          description: 'Example graph id; its length and seed are built in.'
        },
        duration: { type: 'number', description: 'Length in seconds, 0.008..30; default the example length, else 1.' },
        seed: { type: 'integer', description: 'Variation seed; only nodes that use noise change. Default 1.' },
        sampleRate: { type: 'integer', description: 'Sample rate; default 44100 (22050 for inline, 48000 for video).' },
        out: { type: 'string', description: 'Output path; default assets/audio/<catalog or graph>-<hash>.wav.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => {
      const nodes = Array.isArray(args.graph?.nodes) ? args.graph.nodes.length : null
      const label = typeof args.catalog === 'string' ? args.catalog : nodes === null ? 'synth graph' : `${nodes} nodes`
      return { card: 'generic', title: `Synthesize ${label}`, kind: 'other', rawInput: args }
    },
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const request = resolveRequest(args)
      const durationArg = readNumber('audio_synth_graph', 'duration', args.duration)
      const seedArg = readNumber('audio_synth_graph', 'seed', args.seed)
      const sampleRateArg = readNumber('audio_synth_graph', 'sampleRate', args.sampleRate)
      const duration = durationArg === undefined ? request.duration : durationArg
      const seed = seedArg === undefined ? request.seed : Math.round(seedArg)
      const sampleRate = sampleRateArg === undefined ? 44100 : Math.round(sampleRateArg)

      // Validate before rendering: the buffer this graph would allocate is the
      // largest thing in the call, and a model learns more from paths than from
      // a RangeError after 5 MB of ticks.
      const check = validateGraph(request.graph, { duration, sampleRate })
      if (!check.ok) throw new Error(invalidGraphMessage(check.errors))

      const rendered = renderGraph(request.graph, { duration, sampleRate, seed })
      finalize(rendered.samples, sampleRate, -1)
      const bytes = toWavBytes(rendered.samples, sampleRate)
      const hash = hashSpec({ kind: 'graph', graph: request.graph, duration: rendered.durationSeconds, seed, sampleRate })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, request.label, hash)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)
      const metrics = { ...measure(rendered.samples, sampleRate), sampleRate }
      const nodeCount = rendered.report.nodeCount
      const origin = request.catalogId === null ? `${nodeCount} nodes` : `${request.catalogId} example, ${nodeCount} nodes`
      const text = summaryLine(`Synthesized ${origin} into`, cwd, target, info.size, metrics, [`seed ${seed}`])

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: metrics.durationSeconds,
        sampleRate,
        catalogId: request.catalogId,
        nodeCount,
        metrics,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
