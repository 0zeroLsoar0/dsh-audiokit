/**
 * Tool-layer coverage for the whole 30-tool surface: JSON-schema shape for every
 * tool, plus cheap invalid-argument rejection for every tool that has arguments.
 *
 * `tools-test.mjs` drives seven tools end to end (real renders, chunk stitching,
 * a mock TTS server). This file is the breadth counterweight and stays cheap: it
 * registers the whole surface through `apply()` — so `registerExtraPresets()`
 * has already run and every preset enum carries all 38 ids instead of the
 * original nine — then asserts the contracts the host and the model rely on
 * without rendering anything expensive.
 *
 * Two coverage tiers, both reported at the end:
 *   schema   — `parameters` is a closed object schema, every property is typed
 *              and described, `required` keys exist, enums are non-empty/unique
 *              and open with their documented first value, `output` and
 *              `isConcurrencySafe` are present, and the model-visible bytes are
 *              measured.
 *   behavior — 2-3 invalid calls per tool, each rejected as a plain `Error` that
 *              names the problem, before any render, with no file written.
 *              `audio_voices` is schema-only: it declares no parameters, so no
 *              invalid argument can be constructed for it.
 *
 * Run: node test/tool-schemas.mjs
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// index.js owns the registration order: it imports presets-extra first, whose
// module body registers the extra 29 presets before any tool module snapshots
// `Object.keys(PRESETS)` into its schema. Do not import a tool module above it.
import { apply } from '../index.js'
import { PRESETS } from '../lib/dsp.js'
import { RECIPES } from '../lib/design.js'

/**
 * The model-visible surface, exactly as `apply()` registers it. Two copies of
 * this contract exist — this list and `test/hardening.mjs`'s EXPECTED. This one
 * is the current surface; section 4 cross-checks the other copy instead of
 * demanding equality, because that file is extended on its own schedule.
 */
const EXPECTED = [
  'audio_analyze', 'audio_beats', 'audio_bind', 'audio_bus', 'audio_check',
  'audio_compose', 'audio_convert', 'audio_daw', 'audio_design', 'audio_generate',
  'audio_lipsync', 'audio_live', 'audio_loudness', 'audio_master', 'audio_midi',
  'audio_mix', 'audio_mouth', 'audio_mux', 'audio_pattern', 'audio_probe',
  'audio_react', 'audio_regress', 'audio_sampler', 'audio_spatial',
  'audio_stems', 'audio_stretch', 'audio_synth', 'audio_synth_graph', 'audio_tts',
  'audio_voices'
]

/** A tool description longer than this is a manual, not a choice. */
const MAX_DESCRIPTION_CHARS = 12_000
/** A rejected call that took longer than this did the work before checking. */
const SLOW_REJECTION_MS = 1_000

/**
 * The first value each enum must open with: the default the tool descriptions
 * and docs present to the model. `AUDIO_SYNTH`-style reordering or a truncated
 * preset table silently changes what the model sees as "the obvious choice", so
 * the first entry is pinned here. Keys are `<tool>.<schema path>`; arrays are
 * `[]`, e.g. `audio_design.layers[].preset`.
 */
const FIRST_LEGAL = new Map([
  ['audio_synth.preset', 'impact'],
  ['audio_synth_graph.catalog', 'metal-clang'],
  ['audio_pattern.preset', 'impact'],
  ['audio_pattern.kind', 'train'],
  ['audio_pattern.curve', 'linear'],
  ['audio_tts.subtitleType', 'sentence'],
  ['audio_generate.provider', 'openai-audio'],
  ['audio_analyze.render.preset', 'impact'],
  ['audio_convert.op', 'trim'],
  ['audio_convert.curve', 'linear'],
  ['audio_convert.bitDepth', 8],
  ['audio_convert.channels', 1],
  ['audio_loudness.render.preset', 'impact'],
  ['audio_design.recipe', 'door-slam-metal'],
  ['audio_design.layers[].preset', 'impact'],
  ['audio_design.layers[].filter.mode', 'lp'],
  ['audio_master.preset', 'streaming-safe'],
  ['audio_master.render.preset', 'impact'],
  ['audio_master.bitDepth', 8],
  ['audio_lipsync.render.preset', 'impact'],
  ['audio_lipsync.format', 'json'],
  ['audio_beats.render.preset', 'impact'],
  ['audio_mouth.format', 'json'],
  ['audio_mouth.style', 'neutral'],
  ['audio_mouth.alignment', 'bpm'],
  ['audio_bus.tracks[].shelf.kind', 'low'],
  ['audio_bus.bitDepth', 8],
  ['audio_bus.channels', 1],
  ['audio_spatial.layout', 'mono'],
  ['audio_spatial.bitDepth', 16],
  ['audio_mux.action', 'probe'],
  ['audio_mux.mode', 'replace'],
  ['audio_mux.channels', 1],
  ['audio_regress.action', 'snapshot'],
  ['audio_regress.specs[].preset', 'impact'],
  ['audio_react.interactions[]', 'hover'],
  ['audio_react.palette', 'soft'],
  ['audio_live.presets[]', 'impact'],
  ['audio_live.automation[].target', 'pitch'],
  ['audio_live.automation[].curve', 'linear'],
  ['audio_compose.genre', 'cinematic'],
  ['audio_compose.key', 'C'],
  ['audio_compose.mode', 'ionian'],
  ['audio_compose.sections[].name', 'intro'],
  ['audio_midi.action', 'export'],
  ['audio_midi.genre', 'cinematic'],
  ['audio_midi.key', 'C'],
  ['audio_midi.mode', 'ionian'],
  ['audio_stems.bitDepth', 8],
  ['audio_stems.channels', 1],
  ['audio_daw.format', 'edl']
])

/**
 * Tools with no invalid-argument path at all, and why. Anything listed here must
 * keep declaring zero parameters: if it grows one, the behaviour tier has to grow
 * a case for it.
 */
const SCHEMA_ONLY = new Map([
  ['audio_voices', 'declares no parameters, so no invalid argument can be constructed']
])

/**
 * One cheap invalid call per row: `[tool, label, arguments, message match?]`.
 * Every row must reject before any render — no real preset is rendered, no
 * network is touched, and the output paths named below must stay unwritten (the
 * whole scratch directory is asserted empty after this block). The optional
 * match is what a readable rejection has to name: the parameter or the limit.
 */
const BAD_CALLS = [
  ['audio_synth', 'missing required preset', {}],
  ['audio_synth', 'unknown preset', { preset: 'nope', out: 'reject/synth.wav' }, /preset/],

  ['audio_synth_graph', 'neither graph nor catalog', {}],
  ['audio_synth_graph', 'unknown catalog id', { catalog: 'nope', out: 'reject/graph.wav' }, /catalog/],

  ['audio_pattern', 'missing required preset', {}],
  ['audio_pattern', 'unknown preset', { preset: 'nope', out: 'reject/pattern.wav' }, /preset/],
  ['audio_pattern', 'event count over the cap', { preset: 'tick', to: 1, count: 1e9, out: 'reject/pattern-cap.wav' }, /20000/],

  ['audio_mix', 'missing required inputs', {}],
  ['audio_mix', 'empty inputs', { inputs: [], out: 'reject/mix.wav' }, /inputs|input path/],

  ['audio_probe', 'missing required path', {}],
  ['audio_probe', 'missing file', { path: 'missing.wav' }, /missing\.wav/],

  ['audio_tts', 'missing required text', {}],
  ['audio_tts', 'speed out of range', { text: 'hi', speed: 5, out: 'reject/tts.wav' }, /0\.5|speed/],

  ['audio_check', 'no work at all', {}],
  ['audio_check', 'empty work lists', { paths: [], cues: [] }, /paths|cues/],

  ['audio_convert', 'missing required inputs/op', {}],
  ['audio_convert', 'unknown op', { inputs: ['missing.wav'], op: 'bogus', out: 'reject/convert.wav' }, /op/],
  ['audio_convert', 'unknown bit depth', { inputs: ['missing.wav'], op: 'convert', bitDepth: 12, out: 'reject/convert-8.wav' }, /bitDepth/],

  ['audio_loudness', 'no source', {}],
  ['audio_loudness', 'unknown render preset', { render: { preset: 'nope' }, out: 'reject/loud.wav' }, /preset/],

  ['audio_design', 'neither recipe nor layers', {}],
  ['audio_design', 'unknown recipe', { recipe: 'nope', out: 'reject/design.wav' }, /recipe/],
  ['audio_design', 'empty layers', { layers: [], out: 'reject/design-2.wav' }, /recipe|layers/],

  ['audio_lipsync', 'no source', {}],
  ['audio_lipsync', 'unknown render preset', { render: { preset: 'nope' }, out: 'reject/lip.json' }, /preset/],

  ['audio_beats', 'no source', {}],
  ['audio_beats', 'unknown render preset', { render: { preset: 'nope' }, out: 'reject/beats.json' }, /preset/],

  ['audio_bind', 'missing required cues', {}],
  ['audio_bind', 'empty cue list', { cues: [], out: 'reject/bind' }, /cue/],

  ['audio_regress', 'missing required action', {}],
  ['audio_regress', 'unknown action', { action: 'bogus' }, /action/],

  ['audio_compose', 'missing required genre', {}],
  ['audio_compose', 'unknown genre', { genre: 'nope', out: 'reject/compose.wav' }, /genre/],

  ['audio_stretch', 'no source', {}],
  ['audio_stretch', 'missing source file', { path: 'missing.wav', factor: 1.1, out: 'reject/stretch.wav' }, /missing\.wav/],

  ['audio_generate', 'missing required prompt', {}],
  ['audio_generate', 'duration out of range', { prompt: 'rain', duration: 9999, out: 'reject/gen.wav' }, /duration/],

  ['audio_analyze', 'no source', {}],
  ['audio_analyze', 'missing source file', { path: 'missing.wav' }, /missing\.wav/],

  ['audio_bus', 'missing required tracks', {}],
  ['audio_bus', 'empty tracks', { tracks: [], out: 'reject/bus.wav' }, /tracks/],
  ['audio_bus', 'track without path or render', { tracks: [{ preset: 'nope' }], out: 'reject/bus-2.wav' }, /tracks\[0\]/],

  ['audio_daw', 'missing required format', {}],
  ['audio_daw', 'unknown format', { format: 'nope' }, /format/],

  ['audio_live', 'unknown preset id', { presets: ['nope'], out: 'reject/live.js' }, /preset/],
  ['audio_live', 'duration out of range', { duration: 999, out: 'reject/live-2.js' }, /duration/],

  ['audio_master', 'no source', {}],
  ['audio_master', 'unknown mastering preset', { render: { preset: 'impact' }, preset: 'nope', out: 'reject/master.wav' }, /preset/],

  ['audio_midi', 'missing required action', {}],
  ['audio_midi', 'unknown action', { action: 'bogus' }, /action/],

  ['audio_mouth', 'neither text nor cues', {}],
  ['audio_mouth', 'both text and cues', { text: 'hi', cues: [{ at: 0, text: 'a', dur: 1 }], out: 'reject/mouth.json' }, /text|cues/],

  ['audio_mux', 'missing required action', {}],
  ['audio_mux', 'unknown action', { action: 'bogus' }, /action/],
  ['audio_mux', 'probe without a path', { action: 'probe' }, /path/],

  ['audio_react', 'unknown interaction id', { interactions: ['nope'], out: 'reject/react' }, /interaction/],
  ['audio_react', 'unknown palette', { palette: 'nope', out: 'reject/react-2' }, /palette/],

  ['audio_sampler', 'missing required samples', {}],
  ['audio_sampler', 'missing sample file', { samples: 'missing.wav', out: 'reject/sampler.wav' }, /missing\.wav/],

  ['audio_spatial', 'missing required sources', {}],
  ['audio_spatial', 'empty sources', { sources: [], out: 'reject/spatial.wav' }, /sources/],
  ['audio_spatial', 'source without path or render', { sources: [{ preset: 'nope' }], out: 'reject/spatial-2.wav' }, /sources\[0\]/],

  ['audio_stems', 'missing required tracks', {}],
  ['audio_stems', 'empty tracks', { tracks: [], outDir: 'reject/stems' }, /tracks/]
]

/* ------------------------------------------------------------- harness -- */

const workspace = await mkdtemp(join(tmpdir(), 'dsh-audio-schemas-'))
const exec = { agent: { session: { id: 'tool-schemas' } } }

/**
 * The same minimal Cordis context `schema-budget.mjs` builds: the tool registry
 * plus the optional seams `apply()` touches (settings/editor pages, the skill).
 * No provider config on purpose — a TTS or generation call would then fail on
 * configuration (offline) instead of reaching the network.
 */
function makeLabContext () {
  const tools = new Map()
  const services = new Map()
  services.set('workingDirectory', { get: () => workspace })
  services.set('webServer', { register: () => () => {} })
  services.set('skills', { registerProvider: () => {} })
  services.set('configEditor', { edit: () => {} })
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    get: (name) => services.get(name),
    effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    inject (names, callback) {
      const available = names.filter((name) => services.has(name))
      if (available.length === 0) return false
      const child = Object.create(ctx)
      for (const name of available) child[name] = services.get(name)
      callback(child)
      return true
    }
  }
  return { tools, ctx }
}

const { tools, ctx } = makeLabContext()
apply(ctx, {})

const failures = []
const warnings = []
let checks = 0
let schemaBytes = 0

/** Count and report one assertion; a failure prints immediately next to its case. */
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return true
  failures.push(detail === '' ? label : `${label} — ${detail}`)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

/** A message cut to one readable line for a pass row. */
function oneLine (text, max = 96) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** A non-fatal observation: poor-but-safe behaviour, the hardening convention. */
function warn (label, detail) {
  warnings.push(`${label} — ${detail}`)
  console.log(`  WARN ${label} — ${detail}`)
}

/** Every entry below `root`, relative and sorted; `[]` when the tree is empty. */
async function listEntries (root) {
  return (await readdir(root, { recursive: true }).catch(() => [])).sort()
}

/**
 * Visit every schema node in a parameter tree. Paths are dotted, arrays are
 * `[]` and anyOf variants are `<anyOf:n>`, e.g. `layers[].preset`, so a failure
 * names the exact place in the JSON the model receives.
 */
function walkSchema (node, path, visit) {
  if (node === null || typeof node !== 'object') return
  visit(path, node)
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    walkSchema(child, path === '' ? name : `${path}.${name}`, visit)
  }
  if (node.items !== undefined) walkSchema(node.items, `${path}[]`, visit)
  for (const [index, variant] of (node.anyOf ?? []).entries()) walkSchema(variant, `${path}<anyOf:${index}>`, visit)
}

/**
 * Visit every declared *property* (not array items or anyOf variants, which have
 * no description of their own), including the ones nested inside array items.
 * `inheritedDescription` is the nearest enclosing property's description, so a
 * nested block of fields can be documented once by its parent (`tolerances`,
 * `sections`, `render`) instead of repeating the prose on every field.
 */
function forEachProperty (node, path, inheritedDescription, visit) {
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const childPath = path === '' ? name : `${path}.${name}`
    visit(childPath, child, inheritedDescription)
    forEachProperty(child, childPath, child.description ?? inheritedDescription, visit)
  }
  if (node.items !== undefined) forEachProperty(node.items, `${path}[]`, inheritedDescription, visit)
  for (const [index, variant] of (node.anyOf ?? []).entries()) forEachProperty(variant, `${path}<anyOf:${index}>`, inheritedDescription, visit)
}

/**
 * Check one tool's schema against the host contract and the doc-facing shape.
 * Returns the problems found plus the enum count (for the report row).
 */
function schemaProblems (definition) {
  const problems = []
  let enums = 0
  const schema = definition.parameters
  const name = definition.name

  if (schema === null || typeof schema !== 'object') return { problems: ['parameters is not an object'], enums }
  if (schema.type !== 'object') problems.push(`parameters.type is ${JSON.stringify(schema.type)}, expected "object"`)
  if (schema.additionalProperties !== false) problems.push(`parameters.additionalProperties is ${JSON.stringify(schema.additionalProperties)}, expected false`)
  if (typeof definition.execute !== 'function') problems.push('execute is missing')
  if (typeof definition.output?.render !== 'function') problems.push('output.render is missing (host contract)')
  if (definition.isConcurrencySafe !== true) problems.push(`isConcurrencySafe is ${JSON.stringify(definition.isConcurrencySafe)}, expected true`)
  if (typeof definition.presentCall !== 'function') problems.push('presentCall is missing (host card title/payload)')

  const description = typeof definition.description === 'string' ? definition.description : ''
  if (description.trim().length <= 10) problems.push(`tool description is ${description.trim().length} char(s), too short for the model to choose`)
  if (description.length > MAX_DESCRIPTION_CHARS) problems.push(`tool description is ${description.length} chars, more manual than choice`)
  if (/\b(TODO|FIXME|TBD)\b/.test(description)) problems.push('tool description contains a placeholder marker')

  forEachProperty(schema, '', '', (path, property, inheritedDescription) => {
    if (property.type === undefined && property.anyOf === undefined) problems.push(`property ${path} has neither type nor anyOf`)
    const own = typeof property.description === 'string' ? property.description.trim() : ''
    // A field may be undocumented itself when the block it belongs to is
    // described (the parent property explains the whole shape).
    const documenting = own.length > 10 ? own : String(inheritedDescription ?? '').trim()
    if (documenting.length <= 10) problems.push(`property ${path} has no description and no described parent block`)
  })

  walkSchema(schema, '', (path, node) => {
    if (node.type === 'object' && node.properties !== undefined) {
      for (const required of node.required ?? []) {
        if (!(required in node.properties)) problems.push(`required "${required}" is not a declared property at ${path === '' ? 'the root' : path}`)
      }
    }
    if (node.enum === undefined) return
    enums += 1
    const values = Array.isArray(node.enum) ? node.enum : []
    if (values.length === 0) problems.push(`enum at ${path === '' ? 'the root' : path} is empty`)
    if (new Set(values).size !== values.length) problems.push(`enum at ${path === '' ? 'the root' : path} repeats a value`)
    if (values.some((value) => value === null || typeof value === 'object')) problems.push(`enum at ${path === '' ? 'the root' : path} holds a non-primitive value`)
    if (node.default !== undefined && !values.includes(node.default)) {
      problems.push(`default ${JSON.stringify(node.default)} is not one of the enum values at ${path}`)
    }

    const key = path === '' ? name : `${name}.${path}`
    const expectedFirst = FIRST_LEGAL.get(key)
    if (expectedFirst !== undefined && values[0] !== expectedFirst) {
      problems.push(`enum at ${path} opens with ${JSON.stringify(values[0])}, expected ${JSON.stringify(expectedFirst)} (the first value the docs present)`)
    }

    // `audio_master.preset` selects a mastering preset, not a synth preset.
    const presetFamily = (path === 'preset' || path.endsWith('.preset') || path === 'presets[]') && key !== 'audio_master.preset'
    if (presetFamily) {
      const table = Object.keys(PRESETS)
      const unknown = values.filter((value) => PRESETS[value] === undefined)
      if (unknown.length > 0) problems.push(`preset enum at ${path} names unknown preset(s): ${unknown.join(', ')}`)
      // The nine-id snapshot bug: a tool module evaluated before
      // registerExtraPresets() freezes the schema with only the core presets.
      if (path !== 'presets[]' && values.length !== table.length) {
        problems.push(`preset enum at ${path} has ${values.length} ids; the registered preset table has ${table.length} (registerExtraPresets() must run first)`)
      }
    }
    if (path === 'recipe') {
      const table = Object.keys(RECIPES)
      const unknown = values.filter((value) => RECIPES[value] === undefined)
      if (unknown.length > 0) problems.push(`recipe enum names unknown recipe(s): ${unknown.join(', ')}`)
      if (values.length !== table.length) problems.push(`recipe enum has ${values.length} ids; the recipe table has ${table.length}`)
    }
  })

  return { problems, enums }
}

/** Exactly what the model receives per tool, the way schema-budget.mjs measures it. */
function modelPayloadBytes (definition) {
  return Buffer.byteLength(JSON.stringify({
    name: definition.name,
    description: definition.description ?? '',
    parameters: definition.parameters
  }), 'utf8')
}

/* ------------------------------------------- 1. registration and bytes -- */

console.log(`dsh-audiokit tool coverage · node ${process.version} · ${EXPECTED.length} expected tools`)

/** Deterministic code-unit ordering: localeCompare depends on the machine locale. */
function compareNames (a, b) { return a < b ? -1 : a > b ? 1 : 0 }

const registered = [...tools.keys()].sort(compareNames)

console.log('\n-- 1. registration --')
{
  const missing = EXPECTED.filter((name) => !tools.has(name))
  const extra = registered.filter((name) => !EXPECTED.includes(name))
  check('the registered set equals the EXPECTED list (update it when a tool is added or removed)',
    missing.length === 0 && extra.length === 0 && registered.length === EXPECTED.length,
    `missing ${missing.join(', ') || '-'} · unexpected ${extra.join(', ') || '-'} · ${registered.length} registered`)
  check('every tool is named like an audio tool', registered.every((name) => /^audio_[a-z0-9_]+$/.test(name)),
    registered.filter((name) => !/^audio_[a-z0-9_]+$/.test(name)).join(', '))
  console.log(`  ${registered.length} tools: ${registered.join(', ')}`)

  // The extra preset table is the difference between 9 and 38 preset ids; the
  // per-tool enum checks below pin every preset enum to the live table.
  const presetCount = Object.keys(PRESETS).length
  const recipeCount = Object.keys(RECIPES).length
  check('the extra preset table was registered before the tool modules', presetCount > 9, `${presetCount} preset(s)`)
  console.log(`  preset table: ${presetCount} · recipe table: ${recipeCount}`)

  const rows = registered.map((name) => {
    const definition = tools.get(name)
    const payload = modelPayloadBytes(definition)
    return {
      name,
      bytes: payload,
      parametersBytes: Buffer.byteLength(JSON.stringify(definition.parameters ?? {}), 'utf8'),
      descriptionBytes: Buffer.byteLength(definition.description ?? '', 'utf8')
    }
  })
  const total = rows.reduce((sum, row) => sum + row.bytes, 0)
  const totalParameters = rows.reduce((sum, row) => sum + row.parametersBytes, 0)
  const totalDescription = rows.reduce((sum, row) => sum + row.descriptionBytes, 0)
  const heaviest = [...rows].sort((a, b) => b.parametersBytes - a.parametersBytes).slice(0, 5)
  check('every tool has a non-empty model-visible payload', rows.every((row) => row.bytes > 0))
  console.log(`  schema bytes: ${total} B model-visible (parameters ${totalParameters} B · description ${totalDescription} B)`)
  console.log(`  heaviest parameters: ${heaviest.map((row) => `${row.name} ${row.parametersBytes} B`).join(' · ')}`)
  // The budget itself is schema-budget.mjs's job; this file only measures the
  // same payload so a schema edit shows its byte cost in the tool-layer report.
  schemaBytes = total
}

/* ------------------------------------------------ 2. schema shape -- */

console.log(`\n-- 2. schema shape (${registered.length} tools × contract assertions) --`)
for (const name of registered) {
  const definition = tools.get(name)
  const { problems, enums } = schemaProblems(definition)
  const parameters = Object.keys(definition.parameters?.properties ?? {}).length
  if (check(`${name}: schema`, problems.length === 0, problems.join(' · '))) {
    console.log(`  ok   ${name.padEnd(18)} ${String(parameters).padStart(2)} params · ${String(enums).padStart(2)} enums · ${String(modelPayloadBytes(definition)).padStart(5)} B`)
  }
}

/* ------------------------------------ 3. behaviour: invalid arguments -- */

console.log(`\n-- 3. argument validation (${BAD_CALLS.length} cheap invalid calls) --`)

const rejections = []
const filesBefore = await listEntries(workspace)

/**
 * Call a tool that must reject the request, and grade the rejection the way
 * `hardening.mjs` does: a crash (a non-`Error` throw, or a `RangeError`/`TypeError`
 * subclass) and an accepted request are failures; a plain `Error` that decides
 * before the render is a pass; a readable-but-ugly message (it echoes an
 * `undefined`/`NaN`/`[object Object]` it was handed) is a WARN, not a failure.
 */
async function expectReject (name, label, args, match) {
  const definition = tools.get(name)
  if (definition === undefined) return check(`${name}: ${label}`, false, 'tool is not registered')
  const startedAt = performance.now()
  let value
  try {
    value = await definition.execute(args, exec)
  } catch (error) {
    const ms = Math.round(performance.now() - startedAt)
    const message = String(error?.message ?? '')
    const problems = []
    const poorMessage = []
    if (!(error instanceof Error)) problems.push(`threw a non-Error value (${typeof error})`)
    else if (error.constructor !== Error) problems.push(`crashed with ${error.constructor.name}: ${message}`)
    if (message.trim() === '') problems.push('error message is empty')
    if (/undefined|\[object Object\]|\bNaN\b/.test(message)) poorMessage.push(`message echoes an internal value: "${oneLine(message, 110)}"`)
    if (match !== undefined && !match.test(message)) problems.push(`message does not name the rejected input (/${match.source}/): "${message}"`)
    if (ms > SLOW_REJECTION_MS) problems.push(`took ${ms}ms; a rejected call must not do the work first`)
    rejections.push({ name, label, ms, message })
    if (check(`${name}: ${label}`, problems.length === 0, problems.join('; '))) {
      console.log(`  ok   ${name.padEnd(18)} ${label.padEnd(34)} ${String(ms).padStart(4)}ms  ${oneLine(message)}`)
      for (const warning of poorMessage) warn(`${name}: ${label}`, warning)
    }
    return
  }
  check(`${name}: ${label}`, false, `accepted the invalid request -> ${oneLine(JSON.stringify(value), 120)}`)
}

for (const [name, label, args, match] of BAD_CALLS) await expectReject(name, label, args, match)

const filesAfter = await listEntries(workspace)
const written = filesAfter.filter((entry) => !filesBefore.includes(entry))
check('no rejected call wrote a file (bad calls never render)', written.length === 0, written.join(', '))

// Coverage completeness, so a new tool cannot land without a rejection case and
// a schema-only exemption cannot quietly acquire parameters.
{
  const casesByTool = new Map()
  for (const [name] of BAD_CALLS) casesByTool.set(name, (casesByTool.get(name) ?? 0) + 1)
  const thin = registered.filter((name) => !SCHEMA_ONLY.has(name) && (casesByTool.get(name) ?? 0) < 2)
  check('every tool with parameters has at least two bad-call cases', thin.length === 0, thin.join(', '))
  const stray = [...casesByTool.keys()].filter((name) => !registered.includes(name))
  check('every bad-call case targets a registered tool', stray.length === 0, stray.join(', '))
  for (const [name, reason] of SCHEMA_ONLY) {
    const parameters = Object.keys(tools.get(name)?.parameters?.properties ?? {}).length
    check(`${name} is legitimately schema-only`, parameters === 0,
      `${reason}; it now declares ${parameters} parameter(s), so add bad-call cases for it`)
  }
}

/* --------------------------------------- 4. cross-check: hardening.mjs -- */

console.log('\n-- 4. cross-check against test/hardening.mjs --')
{
  // The hardening suite keeps its own copy of the surface. It is older than this
  // list (it covers a subset of the surface as this file is written), so the hard
  // assertion is one-directional: every name it still lists must be a real tool,
  // and any tool it does not list is reported, never silently accepted. When that
  // file is extended to the full surface, the reported number simply reaches the
  // surface size.
  const source = await readFile(new URL('./hardening.mjs', import.meta.url), 'utf8')
  const block = /const EXPECTED = \[([\s\S]*?)\]/.exec(source)
  const hardeningExpected = block === null ? [] : [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((item) => item[1])
  check('hardening.mjs still declares an EXPECTED list', block !== null && hardeningExpected.length > 0,
    'no `const EXPECTED = [...]` found; the cross-check cannot verify the other copy')
  const unknown = hardeningExpected.filter((name) => !registered.includes(name))
  check('every name in hardening.mjs EXPECTED is a registered tool', unknown.length === 0,
    `unknown: ${unknown.join(', ')}`)
  const uncovered = registered.filter((name) => !hardeningExpected.includes(name))
  console.log(`  hardening EXPECTED: ${hardeningExpected.length} name(s) · covers ${registered.length - uncovered.length}/${registered.length} of this surface`)
  if (uncovered.length > 0) {
    console.log(`  note hardening.mjs does not list: ${uncovered.join(', ')} (extending it is outside this file's write scope)`)
  }
  check('this file and hardening.mjs agree on the names they share', unknown.length === 0,
    'update both lists together — they are two copies of one contract')
}

/* ----------------------------------------------------- 5. coverage -- */

const behaviourTools = registered.filter((name) => !SCHEMA_ONLY.has(name))
console.log('\n-- 5. coverage --')
console.log(`  schema-level:   ${registered.length}/${registered.length} tools (shape, enums, descriptions, host contract, bytes)`)
console.log(`  behaviour-level: ${behaviourTools.length}/${registered.length} tools (${rejections.length} cheap invalid calls, every one a plain Error, nothing written)`)
console.log(`  schema-only:    ${SCHEMA_ONLY.size}/${registered.length} — ${[...SCHEMA_ONLY].map(([name, reason]) => `${name} (${reason})`).join(', ')}`)
console.log(`  render-heavy tools are covered by tools-test.mjs / smoke.mjs instead; nothing here renders`)
console.log('  unknown properties are refused by the host schema (additionalProperties:false, section 2), not by')
console.log('  execute — execute ignores extras by design, which hardening.mjs section 2c documents and tolerates')

/* ------------------------------------------------------- summary -- */

await rm(workspace, { recursive: true, force: true })

if (warnings.length > 0) {
  console.log(`\n-- warnings (${warnings.length}) --`)
  for (const warning of warnings) console.log(`  WARN ${warning}`)
}

if (failures.length > 0) {
  console.error('\nFAILED:')
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  console.error(`\nFAILED: ${failures.length} check(s) of ${checks}`)
  process.exit(1)
}

console.log(`\nOK: ${checks} checks · ${registered.length} tools · ${rejections.length} invalid calls rejected cleanly · ${warnings.length} warning(s) · ${schemaBytes} B model-visible schema`)
process.exit(0)
