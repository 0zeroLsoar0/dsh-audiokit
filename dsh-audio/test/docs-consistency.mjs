/**
 * Docs-consistency gate.
 *
 * Three documents are read as truth by a model or a user: the standing prompt
 * section in `index.js`, the `animation-sound` skill in `lib/skill.js`, and
 * `README.md`. A renamed tool, a preset that left the table or a changed
 * argument shape must not survive in any of them, so this test loads the real
 * plugin through a fake Cordis context (no network, no profile) and compares
 * the documents with the registered surface and the id tables in the kernel.
 *
 * Hard failures (exit 1):
 *   - a document names an `audio_*` tool that is not registered;
 *   - an argument in a documented `audio_x({ ... })` call is not a parameter of
 *     that tool (including nested `cues[]` entries and `render` objects);
 *   - a tool is missing from the README tool table or the skill decision table;
 *   - an id inside a documented preset/recipe list is not a real id, or a real
 *     id is not listed by any document;
 *   - a count claim (`38 presets`, `26 个配方`, `8 genres`, ...) disagrees with
 *     the code;
 *   - a line that claims perceptual parameter ranges names a knob no preset
 *     accepts.
 *
 * Advisory (printed, exit 0): tools a document does not mention — the standing
 * prompt is owned by `index.js` and may be updated by its owner — and backticked
 * tokens that match no schema parameter, so a human can judge them.
 *
 * Prose claims about behaviour (ranges, provider capability, result fields) are
 * not inferable from schemas; the vocabulary checks below catch the names and
 * shapes they rest on.
 *
 * Usage: node test/docs-consistency.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, PROMPT_SECTION } from '../index.js'
import { GENRES } from '../lib/compose.js'
import { RECIPES } from '../lib/design.js'
import { PRESETS } from '../lib/dsp.js'
import { registerExtraPresets } from '../lib/presets-extra.js'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---- load the plugin the way the loader does, without the host ---- */

/** The seams `index.js` resolves through `ctx`; anything else is a test bug. */
function makeLabContext () {
  const state = { tools: new Map(), sections: [], skillProviders: [], routes: [], edits: [], effects: [] }
  const services = new Map()
  services.set('systemPrompt', { section: (entry) => state.sections.push(entry) })
  services.set('skills', { registerProvider: (factory) => state.skillProviders.push(factory) })
  services.set('workingDirectory', { get: () => pluginDir })
  services.set('configEditor', { edit: (entry, change) => state.edits.push({ entry, change }) })
  services.set('webServer', { register: (route) => { state.routes.push(route); return () => {} } })
  const ctx = {
    tools: {
      register (definition) {
        if (state.tools.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`)
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      }
    },
    get: (name) => services.get(name),
    effect (factory) {
      const dispose = factory()
      state.effects.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject (names, callback) {
      const available = names.filter((name) => services.has(name))
      if (available.length === 0) return false
      const child = Object.create(ctx)
      for (const name of available) child[name] = services.get(name)
      callback(child)
      return true
    }
  }
  return { state, ctx }
}

const { state, ctx } = makeLabContext()
apply(ctx, {})
// `apply` already registers the extra presets; calling it again is idempotent
// and keeps this test honest if `index.js` ever drops that call.
registerExtraPresets()

/* ---- problem collectors ---- */

const failures = [] // hard: exit 1
const gaps = [] // advisory: a document does not mention a real tool
const loose = [] // advisory: backticked token in no schema

function fail (document, line, message) {
  failures.push({ document, line: line ?? null, message })
}

function failDoc (doc, docLine, message) {
  fail(doc.file, docLine === null ? null : doc.sourceLine(docLine), message)
}

/* ---- truth: tools, schemas, enums, id tables ---- */

const toolList = [...state.tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
const toolByName = new Map(toolList.map((tool) => [tool.name, tool]))
const toolNames = toolList.map((tool) => tool.name)

/** Every property key in a schema, at any depth, with its dotted path. */
function walkSchema (schema, path, entries) {
  if (schema === null || typeof schema !== 'object') return
  if (schema.properties !== undefined && schema.properties !== null) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const childPath = path === null ? key : `${path}.${key}`
      entries.push({ path: childPath, key, schema: child })
      walkSchema(child, childPath, entries)
    }
  }
  if (schema.items !== undefined && schema.items !== null) walkSchema(schema.items, path, entries)
  if (Array.isArray(schema.anyOf)) for (const variant of schema.anyOf) walkSchema(variant, path, entries)
}

function walkEnums (schema, values) {
  if (schema === null || typeof schema !== 'object') return
  if (Array.isArray(schema.enum)) for (const value of schema.enum) values.add(String(value))
  if (schema.properties !== undefined && schema.properties !== null) {
    for (const child of Object.values(schema.properties)) walkEnums(child, values)
  }
  if (schema.items !== undefined && schema.items !== null) walkEnums(schema.items, values)
  if (Array.isArray(schema.anyOf)) for (const variant of schema.anyOf) walkEnums(variant, values)
}

const schemaParams = new Set()
const enumValues = new Set()
const toolParams = new Map()
for (const tool of toolList) {
  const entries = []
  walkSchema(tool.parameters, null, entries)
  toolParams.set(tool.name, { top: tool.parameters?.properties ?? {}, entries })
  for (const entry of entries) schemaParams.add(entry.key)
  walkEnums(tool.parameters, enumValues)
}

// Preset knobs live in `PRESETS[].params`/`.defaults`, not in the JSON schema:
// `audio_synth.params` is an open object, so the kernel table is the only truth
// for names like `weight` and `hardness`.
const presetKnobs = new Set()
const presetKinds = new Set()
for (const spec of Object.values(PRESETS)) {
  for (const key of Object.keys(spec.defaults ?? {})) presetKnobs.add(key)
  for (const key of Object.keys(spec.params ?? {})) presetKnobs.add(key)
  for (const kind of spec.kinds ?? []) presetKinds.add(kind)
}
const paramTokens = new Set([...schemaParams, ...presetKnobs])

/**
 * Backticked words that legitimately belong to prose but are not tool
 * parameters: measured metrics, result fields, config keys, provider/protocol
 * names and browser APIs. Anything outside this set is printed for a human to
 * judge; it is not a hard failure because docs may quote a file name or a
 * result field that no schema describes.
 */
const PROSE_TOKENS = new Set([
  // metrics and result fields
  'rmsDbfs', 'crestDb', 'centroidHz', 'loopSeam', 'dcOffset', 'clipping', 'onsets',
  'durationSeconds', 'relativePath', 'metrics', 'bytes', 'ok', 'refused', 'engine', 'sha256',
  'timestamps', 'beatMap', 'beatMapStride', 'beatCount', 'beatTimes', 'downbeatGuess',
  'confidence', 'chords', 'tracks', 'grid', 'bars', 'viseme', 'openness', 'energy', 'voiced',
  'counts', 'frames', 'previewFrames', 'summedPeakDbfs', 'pageWeightBytes', 'srtPath', 'effective',
  'lufs', 'truePeakDbtp', 'loudnessRange',
  // config / settings keys (not tool arguments)
  'provider', 'tts', 'check', 'baseUrl', 'apiKey', 'apiKeyEnv', 'ffmpegPath', 'groupId',
  // provider, protocol and media names
  'minimax', 'edge', 'openai', 'custom', 'compatible', 'none', 'pcm', 'mp3', 'wav', 'opus',
  'subtitle_enable', 'ffmpeg',
  // browser and JS APIs quoted by the sync contract
  'AudioContext', 'requestAnimationFrame', 'setTimeout', 'decodeAudioData', 'dshAudio',
  // document and product names
  'animation-sound', 'dsh-audio', 'html'
])

const presetIds = new Set(Object.keys(PRESETS))
const recipeIds = new Set(Object.keys(RECIPES))
const genreIds = new Set(Object.keys(GENRES))

const EXPECTED = { presets: 38, recipes: 38, genres: 8 }

function enumOf (toolName, dottedPath) {
  let schema = toolByName.get(toolName)?.parameters
  for (const key of dottedPath.split('.')) {
    if (schema === null || schema === undefined) return null
    schema = key === 'items' || key.endsWith('[]') ? schema.items : schema.properties?.[key]
  }
  return Array.isArray(schema?.enum) ? schema.enum : null
}

function compareSets (label, actual, expected) {
  const actualSet = new Set(actual ?? [])
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter((value) => !actualSet.has(value))
  const extra = [...actualSet].filter((value) => !expectedSet.has(value))
  if (missing.length > 0 || extra.length > 0) {
    fail('schemas', null, `${label}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`)
  }
}

// The schemas must be snapshotted after `registerExtraPresets()`: the extra
// preset table is the classic thing a late import leaves behind.
const synthPresetEnum = enumOf('audio_synth', 'preset') ?? []
compareSets('audio_synth preset enum vs PRESETS', synthPresetEnum, presetIds)
compareSets('audio_design layer preset enum vs PRESETS', enumOf('audio_design', 'layers.items.preset') ?? [], presetIds)
compareSets('audio_design recipe enum vs RECIPES', enumOf('audio_design', 'recipe') ?? [], recipeIds)
compareSets('audio_compose genre enum vs GENRES', enumOf('audio_compose', 'genre') ?? [], genreIds)

for (const [label, actual, expected] of [
  ['presets', presetIds.size, EXPECTED.presets],
  ['recipes', recipeIds.size, EXPECTED.recipes],
  ['genres', genreIds.size, EXPECTED.genres]
]) {
  if (actual !== expected) fail('code tables', null, `${label}: code has ${actual}, the docs lock ${expected}`)
}

/* ---- documents: runtime text + source line mapping ---- */

const readText = async (relative) => (await readFile(resolve(pluginDir, relative), 'utf8')).replace(/\r\n?/g, '\n')
const readmeRaw = await readText('README.md')
const indexRaw = await readText('index.js')
const skillRaw = await readText('lib/skill.js')

// The section is no longer registered as a host system prompt (it was pure
// context tax for sessions that never touch audio); the exported text is still
// the third document this test cross-checks, so the check keeps its value.
const promptSection = state.sections.find((entry) => entry.name === 'dsh-audiokit:animation-sound')
const promptText = promptSection?.text ?? PROMPT_SECTION

let skillContent = ''
if (state.skillProviders.length === 0) {
  fail('lib/skill.js', null, 'plugin registered no skill provider')
} else {
  const provider = state.skillProviders[0]()
  const list = await provider.list()
  const entry = list.length > 0 ? await provider.get(list[0].name) : null
  skillContent = entry?.content ?? ''
  if (typeof skillContent !== 'string' || skillContent.length < 200) fail('lib/skill.js', null, 'skill provider returned no content')
}

/**
 * The prompt text is a `join('\n')` of one string literal per source line, so
 * the mapping is a block offset after a round-trip check. If `index.js` is ever
 * reshaped, the check fails open: lines are reported as `null`, the assertions
 * still run.
 */
function locatePrompt (raw, text) {
  const lines = raw.split('\n')
  const start = lines.findIndex((line) => line.startsWith('const PROMPT_SECTION = [') || line.startsWith('export const PROMPT_SECTION = ['))
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith('].join('))
  if (start < 0 || end <= start) return { sourceLine: () => null }
  const parts = []
  for (let index = start + 1; index < end; index += 1) {
    const match = /^\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(lines[index])
    if (match === null) return { sourceLine: () => null }
    parts.push(match[1].replace(/\\'/g, "'"))
  }
  if (parts.join('\n') !== text) return { sourceLine: () => null }
  return { sourceLine: (docLine) => start + docLine + 1 }
}

/** `const CONTENT = \`` starts the skill: content line 1 sits on that line. */
function locateSkill (raw, text) {
  const lines = raw.split('\n')
  const start = lines.findIndex((line) => line.startsWith('const CONTENT = `'))
  if (start < 0) return { sourceLine: () => null }
  const first = text.split('\n')[0].trim()
  if (first.length === 0 || !lines[start].includes(first)) return { sourceLine: () => null }
  return { sourceLine: (docLine) => start + docLine }
}

const docs = [
  { id: 'readme', file: 'README.md', text: readmeRaw, sourceLine: (docLine) => docLine },
  { id: 'skill', file: 'lib/skill.js', text: skillContent, sourceLine: locateSkill(skillRaw, skillContent).sourceLine },
  { id: 'prompt', file: 'index.js', text: promptText, sourceLine: locatePrompt(indexRaw, promptText).sourceLine }
]

for (const doc of docs) {
  doc.lines = doc.text.split('\n')
  doc.lineStarts = [0]
  for (let index = 0; index < doc.text.length; index += 1) if (doc.text[index] === '\n') doc.lineStarts.push(index + 1)
  doc.backticks = []
  const spanRe = /`([^`\n]*)`/g
  let span
  while ((span = spanRe.exec(doc.text)) !== null) {
    doc.backticks.push({ text: span[1], index: span.index, line: lineAtIndex(doc, span.index) })
  }
  doc.toolMentions = new Map()
  const mentionRe = /\baudio_[a-z][a-z0-9_]*\b/g
  let mention
  while ((mention = mentionRe.exec(doc.text)) !== null) {
    const line = lineAtIndex(doc, mention.index)
    if (!doc.toolMentions.has(mention[0])) doc.toolMentions.set(mention[0], new Set())
    doc.toolMentions.get(mention[0]).add(line)
  }
}

function lineAtIndex (doc, index) {
  let low = 0
  let high = doc.lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (doc.lineStarts[middle] <= index) low = middle
    else high = middle - 1
  }
  return low + 1
}

/** Lines of a region below a heading, 1-based and inclusive; `null` if absent. */
function findRegion (doc, startSource, endSource) {
  const start = doc.lines.findIndex((line) => new RegExp(startSource).test(line))
  if (start < 0) return null
  let end = doc.lines.length
  for (let index = start + 1; index < doc.lines.length; index += 1) {
    if (new RegExp(endSource).test(doc.lines[index])) { end = index; break }
  }
  return { headingLine: start + 1, from: start + 2, to: end }
}

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionsWord (text, token) {
  return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(token)}([^a-z0-9-]|$)`).test(text)
}

/* ---- (a) + (b): documented tools, per document ---- */

for (const doc of docs) {
  for (const [name, lines] of doc.toolMentions) {
    if (toolByName.has(name)) continue
    for (const line of lines) failDoc(doc, line, `names "${name}", which is not a registered tool`)
  }
}

const coverage = []

const readmeToolsTable = findRegion(docs[0], '^## 工具\\s*$', '^## ')
if (readmeToolsTable === null) {
  failDoc(docs[0], null, 'README.md has no "## 工具" table')
} else {
  const tableNames = new Set()
  for (let line = readmeToolsTable.from; line <= readmeToolsTable.to; line += 1) {
    const match = /^\|\s*`(audio_[a-z][a-z0-9_]*)`\s*\|/.exec(docs[0].lines[line - 1])
    if (match !== null) tableNames.add(match[1])
  }
  coverage.push({ document: 'README.md', label: 'tool table', present: toolNames.filter((name) => tableNames.has(name)).length, missing: toolNames.filter((name) => !tableNames.has(name)) })
}

const skillToolTable = findRegion(docs[1], '^## 决策', '^## ')
if (skillToolTable === null) {
  failDoc(docs[1], null, 'lib/skill.js has no "## 决策" table')
} else {
  const tableNames = new Set()
  for (let line = skillToolTable.from; line <= skillToolTable.to; line += 1) {
    const rowRe = /\baudio_[a-z][a-z0-9_]*\b/g
    let row
    while ((row = rowRe.exec(docs[1].lines[line - 1])) !== null) tableNames.add(row[0])
  }
  coverage.push({ document: 'lib/skill.js', label: 'decision table', present: toolNames.filter((name) => tableNames.has(name)).length, missing: toolNames.filter((name) => !tableNames.has(name)) })
}

const promptToolNames = new Set([...docs[2].toolMentions.keys()].filter((name) => toolByName.has(name)))
{
  const row = { document: 'index.js', label: 'prompt section', present: promptToolNames.size, missing: toolNames.filter((name) => !promptToolNames.has(name)) }
  coverage.push(row)
}

for (const row of coverage) {
  if (row.missing.length === 0) continue
  if (row.document === 'index.js') {
    gaps.push({ document: row.document, line: null, message: `${row.label} does not mention ${row.missing.length} tool(s): ${row.missing.join(', ')} (owned by index.js)` })
    continue
  }
  const anchor = row.document === 'README.md' ? readmeToolsTable?.from : skillToolTable?.from
  fail(row.document, anchor === undefined ? null : (row.document === 'README.md' ? anchor : docs[1].sourceLine(anchor)), `${row.label} misses ${row.missing.length} tool(s): ${row.missing.join(', ')}`)
}

/* ---- (d): id lists, counts, coverage ---- */

/**
 * A list region: every backticked lowercase id-shaped token may only be a real
 * id of that category (or a parameter/knob/enum word that a list may mention),
 * and every real id must be present.
 */
function checkIdList (doc, startSource, endSource, idSet, label) {
  const region = findRegion(doc, startSource, endSource)
  if (region === null) {
    failDoc(doc, null, `no ${label} list heading found`)
    return 0
  }
  const found = new Set()
  for (const span of doc.backticks) {
    if (span.line < region.from || span.line > region.to) continue
    const token = span.text.trim()
    if (!/^[a-z][a-z0-9-]*$/.test(token)) continue
    if (idSet.has(token)) { found.add(token); continue }
    if (knownProseToken(token)) continue
    failDoc(doc, span.line, `the ${label} list names "${token}", which is not a real ${label}`)
  }
  if (found.size !== idSet.size) {
    const missing = [...idSet].filter((id) => !found.has(id))
    failDoc(doc, region.headingLine, `${label} list has ${found.size}/${idSet.size} ids; misses: ${missing.join(', ')}`)
  }
  return found.size
}

/** Words that may legitimately appear inside a list region without being ids. */
function knownProseToken (token) {
  return paramTokens.has(token) || enumValues.has(token) || PROSE_TOKENS.has(token)
}

/**
 * Split a backticked span that is a plain token list (`weight/hardness/...`)
 * into its tokens. Spans that are prose, a path or a code fragment are skipped
 * whole: `~/.dsh/tools/ffmpeg` and `lyric: "wo ai ni"` must not leak fragments
 * into the vocabulary checks.
 */
function spanParts (text) {
  if (/[\s:]/.test(text)) return []
  if (text.startsWith('/') || /[.~]/.test(text)) return [] // file path or URL fragment
  const parts = text.split(/[/、|]+/).map((part) => part.trim()).filter((part) => part.length > 0)
  return parts.every((part) => /^[a-z][A-Za-z0-9_]*$/.test(part)) ? parts : []
}

const coverageCounts = {}
for (const doc of docs) {
  if (doc.id === 'readme') {
    coverageCounts.readmePresets = checkIdList(doc, '^### 预设\\s*$', '^#{2,3} ', presetIds, 'preset')
    coverageCounts.readmeRecipes = checkIdList(doc, '^### 设计配方\\s*$', '^#{2,3} ', recipeIds, 'recipe')
  } else if (doc.id === 'skill') {
    coverageCounts.skillPresets = checkIdList(doc, '^### \\d+ 个预设速查\\s*$', '^#{2,3} ', presetIds, 'preset')
    coverageCounts.skillRecipes = checkIdList(doc, '^### \\d+ 个设计配方\\s*$', '^#{2,3} ', recipeIds, 'recipe')
  }
}

// Genres are listed as plain words in README.md and backticked in the skill;
// check membership by word in both.
for (const doc of docs) {
  if (doc.id === 'prompt') continue
  const missing = [...genreIds].filter((id) => !mentionsWord(doc.text, id))
  if (missing.length > 0) failDoc(doc, null, `${doc.file} never lists genre(s): ${missing.join(', ')}`)
  if (doc.id === 'readme') coverageCounts.readmeGenres = genreIds.size - missing.length
  if (doc.id === 'skill') coverageCounts.skillGenres = genreIds.size - missing.length
}

// Every real id must be documented somewhere, even if one doc drops a line.
for (const [label, idSet] of [['preset', presetIds], ['recipe', recipeIds], ['genre', genreIds]]) {
  const union = new Set()
  for (const doc of docs) {
    for (const id of idSet) {
      if (label === 'genre' ? mentionsWord(doc.text, id) : doc.backticks.some((span) => span.text.trim() === id)) union.add(id)
    }
  }
  const missing = [...idSet].filter((id) => !union.has(id))
  if (missing.length > 0) fail('all documents', null, `${label}(s) never documented: ${missing.join(', ')}`)
}

// Count claims must match the code table, in every document that makes one.
const claims = [
  { label: 'presets', actual: presetIds.size, patterns: ['\\d+\\s*个(?:合成)?预设', '\\d+\\s+presets?\\b'] },
  { label: 'recipes', actual: recipeIds.size, patterns: ['\\d+\\s*个(?:设计|分层)?配方', '\\d+\\s+(?:layered\\s+)?recipes?\\b'] },
  { label: 'genres', actual: genreIds.size, patterns: ['\\d+\\s*种曲风', '\\d+\\s+genres?\\b'] }
]
for (const doc of docs) {
  for (const claim of claims) {
    for (const source of claim.patterns) {
      const pattern = new RegExp(source, 'g')
      let match
      while ((match = pattern.exec(doc.text)) !== null) {
        const value = Number(/\d+/.exec(match[0])?.[0] ?? NaN)
        if (value === claim.actual) continue
        failDoc(doc, lineAtIndex(doc, match.index), `claims "${match[0].trim()}" but the code has ${claim.actual} ${claim.label}`)
      }
    }
  }
}

/* ---- (c) + (e): documented calls, argument shapes, perceptual claims ---- */

function skipString (text, index) {
  const quote = text[index]
  let cursor = index + 1
  while (cursor < text.length) {
    if (text[cursor] === '\\') { cursor += 2; continue }
    if (text[cursor] === quote) return cursor + 1
    cursor += 1
  }
  return text.length
}

function findBalanced (text, start, open, close) {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\'' || char === '"' || char === '`') { index = skipString(text, index) - 1; continue }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Split at commas that sit at depth 0, keeping each part's offset. */
function splitTopLevel (text, separator = ',') {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\'' || char === '"' || char === '`') { index = skipString(text, index) - 1; continue }
    if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push({ text: text.slice(start, index), start })
      start = index + 1
    }
  }
  parts.push({ text: text.slice(start), start })
  return parts
}

const documentedArgs = new Map() // key -> count, for the summary line
let callSites = 0

function noteArg (key) {
  documentedArgs.set(key, (documentedArgs.get(key) ?? 0) + 1)
}

/**
 * Validate the elements of an array-of-objects argument (`cues`, `sections`,
 * `layers`, `notes`, ...) or the keys of an object argument (`render`), but
 * only where the schema actually enumerates properties. Open bags such as
 * `params` (additionalProperties: true) are skipped on purpose.
 */
function checkNestedValue (doc, line, toolName, key, schema, rest) {
  if (schema === null || typeof schema !== 'object') return
  const itemProperties = schema.items?.properties
  const objectProperties = schema.properties
  if (itemProperties === undefined || rest.startsWith('[') === false) {
    if (objectProperties === undefined || rest.startsWith('{') === false) return
    const close = findBalanced(rest, 0, '{', '}')
    if (close < 0) return
    for (const field of splitTopLevel(rest.slice(1, close))) {
      const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(field.text)
      if (match === null) continue
      if (objectProperties[match[1]] !== undefined) { noteArg(match[1]); continue }
      failDoc(doc, line, `${toolName}({ ${key}: { ${match[1]}: ... } }) — "${match[1]}" is not a property of ${key}`)
    }
    return
  }
  const close = findBalanced(rest, 0, '[', ']')
  if (close < 0) return
  for (const element of splitTopLevel(rest.slice(1, close))) {
    const objectText = element.text.trim()
    if (!objectText.startsWith('{')) continue
    const objectEnd = findBalanced(objectText, 0, '{', '}')
    if (objectEnd < 0) continue
    for (const field of splitTopLevel(objectText.slice(1, objectEnd))) {
      const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(field.text)
      if (match === null) continue
      if (itemProperties[match[1]] !== undefined) { noteArg(match[1]); continue }
      failDoc(doc, line, `${toolName}({ ${key}: [{ ${match[1]}: ... }] }) — "${key}[]" has no "${match[1]}"; known fields: ${Object.keys(itemProperties).join(', ')}`)
    }
  }
}

for (const doc of docs) {
  const callRe = /\baudio_[a-z][a-z0-9_]*\s*\(/g
  let match
  while ((match = callRe.exec(doc.text)) !== null) {
    const name = match[0].replace(/\s*\($/, '')
    const line = lineAtIndex(doc, match.index)
    const tool = toolByName.get(name)
    if (tool === undefined) continue // already reported as an unknown tool
    const openParen = match.index + match[0].length - 1
    const closeParen = findBalanced(doc.text, openParen, '(', ')')
    if (closeParen < 0) continue
    const inside = doc.text.slice(openParen + 1, closeParen)
    if (inside.trim() === '') { callSites += 1; continue }
    if (!inside.trim().startsWith('{')) continue
    const braceStart = openParen + 1 + inside.indexOf('{')
    const braceEnd = findBalanced(doc.text, braceStart, '{', '}')
    if (braceEnd < 0) continue
    callSites += 1
    const properties = tool.parameters?.properties ?? {}
    for (const segment of splitTopLevel(doc.text.slice(braceStart + 1, braceEnd))) {
      const raw = segment.text.trim()
      if (raw === '') continue
      const segmentLine = lineAtIndex(doc, braceStart + 1 + segment.start)
      const keyed = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(raw)
      if (keyed !== null) {
        const key = keyed[1]
        if (properties[key] === undefined) {
          failDoc(doc, segmentLine, `${name}({ ${key}: ... }) — "${key}" is not a parameter of ${name}`)
          continue
        }
        noteArg(key)
        checkNestedValue(doc, segmentLine, name, key, properties[key], raw.slice(keyed[0].length).trim())
        continue
      }
      // Shorthand signature list: `audio_synth({ preset, params, ... })`.
      for (const part of raw.split(/[|,]/)) {
        const token = part.trim()
        if (!/^[A-Za-z_$][\w$]*$/.test(token)) continue
        if (properties[token] === undefined) {
          failDoc(doc, segmentLine, `${name}({ ... ${token} ... }) — "${token}" is not a parameter of ${name}`)
          continue
        }
        noteArg(token)
      }
    }
  }
}

// Shape expressions such as `cues[].path` / `render.preset`: if the base is a
// real array-of-object property, the field must exist on those objects. This is
// the `cues[].src` vs `cues[].path` class of drift.
for (const doc of docs) {
  const shapeRe = /`([A-Za-z_$][\w$]*)(\[\])?\.([A-Za-z_$][\w$]*)`/g
  let shape
  while ((shape = shapeRe.exec(doc.text)) !== null) {
    const [, base, isArray, field] = shape
    const owners = toolList.filter((tool) => {
      const schema = tool.parameters?.properties?.[base]
      if (schema === undefined) return false
      const properties = isArray === '[]' ? schema.items?.properties : schema.properties
      return properties !== undefined && properties !== null
    })
    // A dotted token can be a browser API (`audio.currentTime`) or a file path;
    // only enforce when the base really is an object-shaped argument.
    if (owners.length === 0) continue
    const known = owners.some((tool) => {
      const schema = tool.parameters.properties[base]
      const properties = isArray === '[]' ? schema?.items?.properties : schema?.properties
      return properties !== undefined && properties !== null && properties[field] !== undefined
    })
    if (!known) failDoc(doc, lineAtIndex(doc, shape.index), `claims "${base}${isArray ?? ''}.${field}", but no tool schema has that field`)
  }
}

// Lines that claim perceptual parameter ranges must only name real knobs.
for (const doc of docs) {
  const claimLines = new Set()
  doc.lines.forEach((line, index) => {
    if (/0\.\.1|0\.5\.\.2|感知量/.test(line)) { claimLines.add(index + 1); claimLines.add(index + 2) }
  })
  if (claimLines.size === 0) continue
  for (const span of doc.backticks) {
    if (!claimLines.has(span.line)) continue
    for (const part of spanParts(span.text)) {
      const token = part.trim()
      if (!/^[a-z][A-Za-z0-9_]*$/.test(token)) continue
      if (token.startsWith('audio_')) continue // tool-name drift is reported above
      if (paramTokens.has(token) || presetIds.has(token) || enumValues.has(token) || PROSE_TOKENS.has(token)) continue
      if (toolByName.has(token)) continue
      failDoc(doc, span.line, `claims "${token}" as a perceptual parameter, but no preset accepts it`)
    }
  }
}

/* ---- advisory: backticked tokens in no schema ---- */

// These are plugin/profile settings, never tool arguments. Quoting one within
// two lines of a tool name is the `provider` mistrust: it tells a model to pass
// a setting as an argument, where it is silently ignored.
const CONFIG_ONLY = new Set(['provider', 'baseUrl', 'apiKey', 'apiKeyEnv', 'ffmpegPath', 'groupId'])

for (const doc of docs) {
  const toolLines = [...doc.toolMentions.values()].flatMap((lines) => [...lines])
  for (const span of doc.backticks) {
    for (const part of spanParts(span.text)) {
      const token = part.trim()
      if (!/^[a-z][A-Za-z0-9_]*$/.test(token)) continue
      const nearTool = toolLines.some((line) => Math.abs(line - span.line) <= 2)
      if (CONFIG_ONLY.has(token) && nearTool) {
        failDoc(doc, span.line, `quotes the setting "${token}" next to a tool name; it is not an argument of any tool`)
        continue
      }
      if (paramTokens.has(token) || enumValues.has(token) || PROSE_TOKENS.has(token)) continue
      if (toolByName.has(token) || presetIds.has(token) || recipeIds.has(token) || genreIds.has(token)) continue
      loose.push({ document: doc.file, line: doc.sourceLine(span.line), token, nearTool })
    }
  }
}

/* ---- (f): prose claims that once named the wrong thing ---- */

// `audio_convert` accepts every layout its `channels` enum lists; the README row
// used to advertise "单双声道" while the tool wrote 1/2/4/6/8 channels. The enum is
// the truth here, so the row is checked against it rather than a copied list.
{
  const convertRow = docs[0].lines.find((line) => /^\|\s*`audio_convert`\s*\|/.test(line))
  const channelEnum = toolByName.get('audio_convert')?.parameters?.properties?.channels?.enum ?? []
  if (convertRow === undefined) {
    fail('README.md', null, 'the audio_convert row is missing from the tool table')
  } else if (channelEnum.length === 0) {
    fail('lib/tools-convert.js', null, 'audio_convert has no channels enum to check the README claim against')
  } else if (!convertRow.includes(`${channelEnum.join('/')} 声道`)) {
    fail('README.md', lineAtIndex(docs[0], docs[0].text.indexOf(convertRow)),
      `audio_convert claims ${channelEnum.join('/')} channels in code, but the README row does not (${convertRow.trim()})`)
  }
}

// A doc that names the wrong result key sends a caller to a field that does not
// exist: `audio_master` has no `report` key — the chain report is nested under
// `chain`, and that is where `mode` / `modeNote` / `warnings` live.
{
  const detail = await readText('docs/DETAIL.zh.md')
  for (const stale of ['`report.mode`', '`report.modeNote`', '`report.warnings`']) {
    if (detail.includes(stale)) {
      fail('docs/DETAIL.zh.md', null, `${stale} is not an audio_master result key; the chain report is under \`chain\``)
    }
  }
  for (const key of ['`chain.mode`', '`chain.modeNote`', '`chain.warnings`']) {
    if (!detail.includes(key)) {
      fail('docs/DETAIL.zh.md', null, `${key} is not documented although audio_master returns it`)
    }
  }
}

/* ---- report ---- */

const pad = (value, width) => String(value).padEnd(width)
const num = (value) => String(value)

console.log('dsh-audio documentation gate\n')
console.log('surface (loaded through the fake lab context, no network)')
console.log(`  tools          ${toolNames.length}`)
console.log(`  presets        ${presetIds.size}  (audio_synth enum ${synthPresetEnum.length}, design layers enum ${(enumOf('audio_design', 'layers.items.preset') ?? []).length})`)
console.log(`  recipes        ${recipeIds.size}  (audio_design enum ${(enumOf('audio_design', 'recipe') ?? []).length})`)
console.log(`  genres         ${genreIds.size}  (audio_compose enum ${(enumOf('audio_compose', 'genre') ?? []).length})`)
console.log(`  parameter tokens ${paramTokens.size}  (schema keys ${schemaParams.size} + preset knobs ${presetKnobs.size}, incl. preset kinds ${[...presetKinds].join('/')})`)

console.log('\ntool coverage per document')
for (const row of coverage) {
  const status = row.missing.length === 0 ? `${row.present}/${toolNames.length}` : `${row.present}/${toolNames.length}  gap: ${row.missing.join(', ')}`
  console.log(`  ${pad(row.document, 22)} ${pad(row.label, 16)} ${status}`)
}

console.log('\nid lists')
console.log(`  presets   README.md ${num(coverageCounts.readmePresets ?? 0)}/${presetIds.size}   lib/skill.js ${num(coverageCounts.skillPresets ?? 0)}/${presetIds.size}`)
console.log(`  recipes   README.md ${num(coverageCounts.readmeRecipes ?? 0)}/${recipeIds.size}   lib/skill.js ${num(coverageCounts.skillRecipes ?? 0)}/${recipeIds.size}`)
console.log(`  genres    README.md ${num(coverageCounts.readmeGenres ?? 0)}/${genreIds.size}   lib/skill.js ${num(coverageCounts.skillGenres ?? 0)}/${genreIds.size}`)

console.log('\ndocumented calls')
console.log(`  ${callSites} call site(s), ${documentedArgs.size} distinct argument key(s), ${failures.filter((entry) => /is not a parameter|has no "|is not a property of/.test(entry.message)).length} bad argument claim(s)`)

function printTable (title, rows) {
  console.log(`\n${title}`)
  if (rows.length === 0) {
    console.log('  none')
    return
  }
  const documentWidth = Math.max(8, ...rows.map((row) => String(row.document).length))
  const lineWidth = Math.max(4, ...rows.map((row) => String(row.line ?? '?').length))
  console.log(`  ${pad('document', documentWidth)}  ${pad('line', lineWidth)}  problem`)
  for (const row of rows) {
    console.log(`  ${pad(row.document, documentWidth)}  ${pad(row.line ?? '?', lineWidth)}  ${row.message}`)
  }
}

printTable('hard mismatches', failures)
printTable('gaps (advisory: a document does not mention a real tool)', gaps)

const shown = loose.slice(0, 40)
printTable('tokens in no schema (advisory: judge by hand)', shown.map((entry) => ({
  document: entry.document,
  line: entry.line,
  message: `\`${entry.token}\`${entry.nearTool ? ' (near a tool name)' : ''}`
})))
if (loose.length > shown.length) console.log(`  ... and ${loose.length - shown.length} more`)

console.log('')
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} hard mismatch(es); ${gaps.length} advisory gap(s)`)
  process.exit(1)
}
console.log(`OK: docs match the registered surface (${failures.length} hard mismatches, ${gaps.length} advisory gap(s), ${loose.length} token(s) for human judgement)`)
