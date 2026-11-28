/**
 * Context-budget guard for the tool surface.
 *
 * DSH sends the model only `name`, `description` and `parameters` per tool
 * (`dsh-tools/src/contracts.ts`: "NEVER sent to the model -- `schemas()`
 * whitelists only name/description/parameters"). Everything else in a tool
 * definition (output schema, isConcurrencySafe, ...) costs nothing, so this
 * test measures exactly the model-visible payload and fails when the surface
 * grows past its budget.
 *
 * The budget is deliberately a hard ceiling, not a target: `docs/SCHEMA_DIET.zh.md`
 * tracks the reduction plan (prose is 65% of the payload; the DSL manual in
 * `audio_synth_graph`'s description is the single biggest line item).
 *
 * Run: node test/schema-budget.mjs
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Total model-visible bytes the surface may cost per session. */
const MAX_TOTAL_BYTES = 105_000
/** Any single tool above this is a smell: it is one choice, not a manual. */
const MAX_TOOL_BYTES = 9_000
/** Prose should not dominate structure by more than this ratio. */
const MAX_PROSE_SHARE = 0.75

const failures = []
let checks = 0
function check (label, ok, detail = '') {
  checks += 1
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` (${detail})`}`)
}

/* ---- load the plugin the way the loader does, without the host ---- */

function makeLabContext () {
  const tools = new Map()
  const services = new Map()
  services.set('workingDirectory', { get: () => pluginDir })
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

/** Exactly what the model receives per tool. */
function modelPayload (definition) {
  return {
    name: definition.name,
    description: definition.description ?? '',
    parameters: definition.parameters
  }
}

const rows = [...tools.values()]
  .map((definition) => {
    const payload = modelPayload(definition)
    const text = JSON.stringify(payload)
    const parameters = JSON.stringify(payload.parameters ?? {})
    const description = payload.description
    return {
      name: payload.name,
      bytes: Buffer.byteLength(text, 'utf8'),
      parametersBytes: Buffer.byteLength(parameters, 'utf8'),
      descriptionBytes: Buffer.byteLength(description, 'utf8')
    }
  })
  .sort((a, b) => b.bytes - a.bytes)

const total = rows.reduce((sum, row) => sum + row.bytes, 0)
const parametersTotal = rows.reduce((sum, row) => sum + row.parametersBytes, 0)
const descriptionTotal = rows.reduce((sum, row) => sum + row.descriptionBytes, 0)

/** Every `description` string buried in a schema is prose the model pays for. */
function proseBytes (value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + proseBytes(item), 0)
  if (value === null || typeof value !== 'object') return 0
  let sum = 0
  for (const [key, item] of Object.entries(value)) {
    if (key === 'description' && typeof item === 'string') sum += Buffer.byteLength(item, 'utf8')
    else sum += proseBytes(item)
  }
  return sum
}

const proseTotal = rows.reduce((sum, row) => {
  const definition = tools.get(row.name)
  return sum + row.descriptionBytes + proseBytes(definition.parameters)
}, 0)
const proseShare = total === 0 ? 0 : proseTotal / total

console.log(`\n-- model-visible tool payload --`)
console.log(`  ${rows.length} tools, ${total} B (${(total / 1024).toFixed(1)} KB, ~${Math.round(total / 3.2 / 1000)}k tokens)`)
console.log(`  description ${descriptionTotal} B · parameters ${parametersTotal} B · prose share ${(proseShare * 100).toFixed(1)}%`)
console.log(`  top 5: ${rows.slice(0, 5).map((row) => `${row.name} ${row.bytes}`).join(' · ')}`)

check('the plugin registers its tool surface', rows.length >= 30, `${rows.length} tool(s)`)
check('the model-visible payload stays under budget', total <= MAX_TOTAL_BYTES, `${total} B > ${MAX_TOTAL_BYTES} B`)
check('no single tool carries a manual', rows[0] === undefined || rows[0].bytes <= MAX_TOOL_BYTES, `${rows[0]?.name ?? '-'} is ${rows[0]?.bytes ?? 0} B`)
check('prose does not crowd out structure', proseShare <= MAX_PROSE_SHARE, `${(proseShare * 100).toFixed(1)}% > ${MAX_PROSE_SHARE * 100}%`)

if (failures.length > 0) {
  console.error('\nFAILED:')
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  process.exit(1)
}

console.log(`\nOK: ${checks} schema-budget checks passed — ${rows.length} tools cost ${total} B model-visible (budget ${MAX_TOTAL_BYTES} B)`)
