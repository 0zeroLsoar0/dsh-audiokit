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
import { GRAPH_SCHEMA, graphCatalog, renderGraph, validateGraph } from './graph.js'

const CATALOG = graphCatalog()
const CATALOG_IDS = CATALOG.map((entry) => entry.id)
const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]))

/* ------------------------------------------------------------- help text -- */

/** One field of a node, in the compact form the tool description uses. */
function fieldText (field) {
  const star = field.required === true ? '*' : ''
  const fallback = field.default === undefined ? '' : ` (=${field.default})`
  if (field.type === 'number') return `${field.range[0]}..${field.range[1]}${star}${fallback}`
  if (field.type === 'string') return `${field.values.join('|')}${star}${fallback}`
  if (field.type === 'ref') return `ref${star}`
  if (field.type === 'refs') return `refs${star}`
  if (field.type === 'numbers') return 'dB[]'
  return 'object'
}

/**
 * Generated from GRAPH_SCHEMA, so the promise in the description and the table
 * the validator enforces cannot drift apart.
 */
const NODE_HELP = Object.entries(GRAPH_SCHEMA.nodes)
  .map(([type, schema]) => {
    const parts = Object.entries(schema.fields).map(([name, field]) => {
      if (field.type === 'object') {
        const nested = Object.entries(field.fields).map(([key, inner]) => `${key} ${fieldText(inner)}`).join(', ')
        return `${name}={${nested}}`
      }
      return `${name} ${fieldText(field)}`
    })
    return `${type} [${schema.description}]: ${parts.join(', ')}`
  })
  .join('\n')

const CATALOG_HELP = CATALOG.map((entry) => `${entry.id}: ${entry.description}`).join('\n')

/** How long a description may be before a host truncates it is not our call. */
const GRAPH_REFERENCE = [
  'Graph shape: { nodes: [ { type, id?, input?, lfo?, ...fields } ], output? }. A source (osc, noise) starts a chain, a processor takes one `input`, sum takes `inputs`. A reference is a node id ("n0" by default) or a 0-based index; `output` defaults to the last audio node. Fields are optional unless marked *; "(=v)" is the default.',
  'Node reference:',
  NODE_HELP,
  'Add `lfo: { hz, depth, target }` to any node instead of writing a separate lfo node. depth is a fraction: 0.02 on pitch is about 34 cents of vibrato, 0.3 on filter moves the cutoff +-30 %.',
  'The render is mono and ends with an 8 ms guard fade. The seed only changes nodes that use noise, so a graph of pure oscillators is identical for every seed.'
].join('\n')

const TOOL_DESCRIPTION = [
  'Render a sound from a synthesis graph: a small JSON DSL the model writes itself (oscillators with FM, noise, filters with sweeps, ADSR envelopes, LFOs, gain, drive, wavefolding, ring modulation, pan, reverb, summing). Use it instead of audio_synth when the fixed preset table cannot express the sound you need, and instead of audio_design when no preset stack gets there. The graph is validated before anything is rendered: an invalid document comes back as a short list of document paths (nodes[2].hz) instead of a stack trace. Deterministic: the same graph, duration, seed and sample rate always produce identical bytes.',
  GRAPH_REFERENCE
].join('\n\n')

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
          description: 'The synthesis graph: { nodes: [ { type, ... } ], output? }. Node types and fields are listed in the tool description. References are node ids ("n0" by default) or 0-based indices.'
        },
        catalog: {
          type: 'string',
          enum: CATALOG_IDS,
          description: `Named example graph, rendered with its own length and seed when duration/seed are omitted. Use it to hear the DSL, or copy its nodes as a starting point.\n${CATALOG_HELP}`
        },
        duration: { type: 'number', description: 'Length in seconds, 0.008..30; defaults to the catalog example\'s length, else 1 s. The render is cut at exactly this length and ends with an 8 ms fade.' },
        seed: { type: 'integer', description: 'Variation seed; only nodes that use noise change. Defaults to the catalog example\'s seed, else 1.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100. Use 22050 when file size matters (inline HTML), 48000 for video-grade output.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/<catalog id or "graph">-<hash>.wav.' }
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
