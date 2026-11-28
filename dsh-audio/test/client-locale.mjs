/**
 * Tests for the settings page localization: `lib/locale-dict.js` and the copy
 * embedded in `client.js`.
 *
 * There is no browser in this environment, so the page is verified the way the
 * rest of this package verifies generated code: `client.js` runs inside a fake
 * `window.__ModuleLoader__` with a minimal `react` shim, the plugin is applied
 * to a fake Cordis-like client context, and the settings page renders through a
 * tiny hook runtime — the assertions read real text out of the component tree
 * instead of trusting the dictionary alone.
 *
 * The page also translates *server* failures: the host route sends a
 * `reasonCode` (see `REASON_CODES` in `lib/settings-route.js`) next to the
 * untouched `detail` text. This file checks that both languages exist for every
 * code the route can emit, that `client.js` maps exactly those codes, and that
 * a rendered failure in English contains no Chinese copy.
 *
 * What this does NOT prove: that the real browser React, the real slot
 * renderer, or the live Client locale service produce exactly this tree. See
 * the `--write` note below and the header of `lib/locale-dict.js` for why the
 * embedded copy exists.
 *
 * Usage:
 *   node test/client-locale.mjs           # verify
 *   node test/client-locale.mjs --write   # regenerate the copy inside client.js
 *   node test/client-locale.mjs --dump    # print the rendered zh/en text lists
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DICT, NS, en, t, zh } from '../lib/locale-dict.js'
import { REASON_CODES } from '../lib/settings-route.js'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const clientPath = join(pluginDir, 'client.js')
const dictPath = join(pluginDir, 'lib', 'locale-dict.js')
const writeCopy = process.argv.includes('--write')
const dumpCopy = process.argv.includes('--dump')

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// CJK ideographs, kana, CJK punctuation and fullwidth forms: every character a
// leftover Chinese string could be made of.
const CJK = /[\u2e80-\u2ef3\u2f00-\u2fd5\u3040-\u30ff\u3105-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/
const NON_ASCII = /[^\u0000-\u007f]/g
const PLACEHOLDER = /\{(\w+)\}/g

/** Report where two string lists diverge, for a readable failure. */
function firstDifference (actual, expected) {
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    if (actual[index] !== expected[index]) return { index, actual: actual[index], expected: expected[index] }
  }
  return null
}

/* ------------------------------------------------ dictionary parity -- */

console.log('-- dictionary parity --')

const keys = Object.keys(zh)
const serialized = Buffer.byteLength(JSON.stringify(DICT))
console.log(`  ${keys.length} keys per locale (zh ${Buffer.byteLength(JSON.stringify(zh))} B, en ${Buffer.byteLength(JSON.stringify(en))} B)`)

check('zh and en expose the same key set', JSON.stringify(keys) === JSON.stringify(Object.keys(en)),
  `${keys.filter((key) => !(key in en)).join(',')} missing in en; ${Object.keys(en).filter((key) => !(key in zh)).join(',')} extra in en`)
check('DICT points at the two maps and nothing else', JSON.stringify(Object.keys(DICT)) === '["zh","en"]' && DICT.zh === zh && DICT.en === en)
check('namespace is stable', NS === 'dsh.audio', NS)
// Reason keys are kebab-case codes (`reason.http-4xx`), every other group is
// camelCase after the dot.
const grouping = /^(page|field|provider|tts|check|status|error|buttons|note|reason)\.[a-z][A-Za-z0-9-]*$/
check('keys are grouped and flat', keys.every((key) => grouping.test(key)), keys.filter((key) => !grouping.test(key)).join(','))

for (const locale of ['zh', 'en']) {
  for (const [key, value] of Object.entries(DICT[locale])) {
    check(`${locale} "${key}" is a non-empty string`, typeof value === 'string' && value.trim() !== '', JSON.stringify(value))
    check(`${locale} "${key}" has no placeholder gone wrong`, !/undefined|\[object Object\]|NaN/.test(value), value)
    check(`${locale} "${key}" has no control characters`, !/[\u0000-\u001f\u007f]/.test(value), JSON.stringify(value))
    check(`${locale} "${key}" needs no escaping beyond the generator`, !/["'\\]/.test(value), value)
  }
}

// Placeholders must survive translation: a `{count}` missing from en shows the
// raw placeholder to an English reader.
for (const key of keys) {
  const zhVars = [...zh[key].matchAll(PLACEHOLDER)].map((match) => match[1]).sort()
  const enVars = [...en[key].matchAll(PLACEHOLDER)].map((match) => match[1]).sort()
  check(`"${key}" keeps its placeholders in en`, JSON.stringify(zhVars) === JSON.stringify(enVars),
    `zh ${JSON.stringify(zhVars)} vs en ${JSON.stringify(enVars)}`)
}

for (const key of keys) {
  const found = en[key].match(CJK)
  check(`en "${key}" contains no CJK`, found === null, `found ${JSON.stringify(found?.[0])} in ${JSON.stringify(en[key])}`)
}

// A value identical in both locales is only legitimate when the zh string has
// nothing to translate (a URL, a model id, a symbol, a product name).
const identical = keys.filter((key) => zh[key] === en[key])
console.log(`  identical in both locales: ${identical.length} (${identical.join(', ')})`)
for (const key of identical) {
  check(`"${key}" is identical only because it is language-neutral`, !CJK.test(zh[key]), `${JSON.stringify(zh[key])} needs an English spelling`)
}

// English must not overflow the fixed 320px control column: labels and buttons
// stay short, descriptions may be a sentence.
const shortLabel = /^(page\.title|field\.[a-zA-Z]+|provider\.[a-z]+|buttons\.[a-zA-Z]+|note\.[a-z]+|check\.testRow|tts\.testRow|check\.selfCheckRow)$/
const shortKeys = keys.filter((key) => shortLabel.test(key))
const longest = Math.max(...shortKeys.map((key) => en[key].length))
const tooLong = shortKeys.filter((key) => en[key].length > 40)
console.log(`  longest en short-label: ${longest} chars`)
check('en labels/buttons stay short', tooLong.length === 0, tooLong.map((key) => `${key}=${JSON.stringify(en[key])}`).join(','))

check('en template reads as English', !CJK.test(en['tts.testOk'].replace(PLACEHOLDER, '')), en['tts.testOk'])

/* ------------------------------------------------ server reason codes -- */

console.log('-- server reason codes --')

// The set the host route can emit. `client.js` may only translate these, and
// every one of them must read in both languages, or a failure would fall back
// to the server's Chinese sentence in the English UI (the acceptance bug).
const reasonCodes = [...REASON_CODES]
const reasonKeys = reasonCodes.map((code) => `reason.${code}`)
// Which placeholders each code's sentence needs, mirroring what the host route
// sends: `missing-key` names the env var, the HTTP codes the status, and an
// unsupported target the requested target name.
const REASON_VARS = {
  'missing-key': ['env'],
  'endpoint-unreachable': [],
  'http-4xx': ['status'],
  'http-5xx': ['status'],
  'not-audio': [],
  'no-base-url': [],
  'provider-none': [],
  'decoder-missing': [],
  'unsupported-target': ['target'],
  'semantic-disabled': []
}
console.log(`  ${reasonCodes.length} codes: ${reasonCodes.join(', ')}`)

check('the reason code list is unique', new Set(reasonCodes).size === reasonCodes.length, JSON.stringify(reasonCodes))
check('every reason code has a zh string', reasonKeys.every((key) => typeof zh[key] === 'string' && zh[key].trim() !== ''),
  reasonKeys.filter((key) => typeof zh[key] !== 'string' || zh[key].trim() === '').join(','))
check('every reason code has an en string', reasonKeys.every((key) => typeof en[key] === 'string' && en[key].trim() !== ''),
  reasonKeys.filter((key) => typeof en[key] !== 'string' || en[key].trim() === '').join(','))
check('no reason string exists without a server code',
  keys.filter((key) => key.startsWith('reason.')).every((key) => reasonCodes.includes(key.slice('reason.'.length))),
  keys.filter((key) => key.startsWith('reason.') && !reasonCodes.includes(key.slice('reason.'.length))).join(','))
check('reason keys are listed in the server code order', JSON.stringify(keys.filter((key) => key.startsWith('reason.'))) === JSON.stringify(reasonKeys),
  JSON.stringify(keys.filter((key) => key.startsWith('reason.'))))

for (const code of reasonCodes) {
  const key = `reason.${code}`
  for (const locale of ['zh', 'en']) {
    const value = DICT[locale][key]
    const vars = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).sort()
    check(`${locale} "${key}" interpolates ${JSON.stringify(REASON_VARS[code])}`, JSON.stringify(vars) === JSON.stringify(REASON_VARS[code]),
      JSON.stringify(vars))
    // Short reasons sit inside a status line, so they must not drag punctuation
    // of their own into it.
    check(`${locale} "${key}" has no trailing punctuation`, !/[.。,，;；:：]$/.test(value), value)
  }
}

/* -------------------------------------- semantic check switch copy -- */

console.log('-- semantic check switch copy --')

// The opt-in semantic layer adds page copy that must exist in both languages:
// a missing translation would leave the switch or its failure reason in Chinese
// on an English page, which is the acceptance bug this file already guards for
// server reasons.
const SEMANTIC_KEYS = ['check.enabledRow', 'check.enabledDesc', 'reason.semantic-disabled']
for (const key of SEMANTIC_KEYS) {
  check(`"${key}" exists in zh`, typeof zh[key] === 'string' && zh[key].trim() !== '', JSON.stringify(zh[key]))
  check(`"${key}" exists in en`, typeof en[key] === 'string' && en[key].trim() !== '', JSON.stringify(en[key]))
  check(`"${key}" is actually translated`, zh[key] !== en[key], JSON.stringify(zh[key]))
  check(`en "${key}" contains no CJK`, !CJK.test(en[key] ?? ''), JSON.stringify(en[key]))
}
check('the disabled reason says where to turn it on',
  zh['reason.semantic-disabled'].includes('设置') && /Settings/.test(en['reason.semantic-disabled']),
  `${JSON.stringify(zh['reason.semantic-disabled'])} / ${JSON.stringify(en['reason.semantic-disabled'])}`)

/* --------------------------------------------------------- t() helper -- */

console.log('-- t() helper --')

check('default locale is Chinese', t('field.provider') === zh['field.provider'], t('field.provider'))
check('explicit en locale reads English', t('field.provider', undefined, 'en') === en['field.provider'], t('field.provider', undefined, 'en'))
check('{name} interpolation (zh)', t('tts.voiceDescLive', { count: 7 }) === '实时列表：7 个音色，来自当前账号', t('tts.voiceDescLive', { count: 7 }))
check('{name} interpolation (en)', t('tts.voiceDescLive', { count: 7 }, 'en') === 'Live list: 7 voices from this account', t('tts.voiceDescLive', { count: 7 }, 'en'))
check('numbers interpolate as text', t('tts.testTimestamps', { count: 0 }, 'en') === '0 timestamps', t('tts.testTimestamps', { count: 0 }, 'en'))
check('an unknown placeholder variable stays visible', t('tts.keyEnvDetected', {}, 'en').includes('{env}'), t('tts.keyEnvDetected', {}, 'en'))
check('an undefined value never prints as undefined', !t('tts.testTimestamps', { count: undefined }, 'en').includes('undefined'), t('tts.testTimestamps', { count: undefined }, 'en'))
check('extra variables are ignored', t('page.title', { unused: 'x' }, 'en') === 'Sound', t('page.title', { unused: 'x' }, 'en'))
check('unknown key falls back to the key', t('nope.missing') === 'nope.missing', t('nope.missing'))
check('unknown locale falls back to zh', t('field.model', undefined, 'ja') === zh['field.model'], t('field.model', undefined, 'ja'))
check('null locale falls back to zh', t('field.model', undefined, null) === zh['field.model'], t('field.model', undefined, null))
check('undefined locale falls back to zh', t('field.model', undefined, undefined) === zh['field.model'])

/* ------------------------------------------------------- copy weight -- */

console.log('-- dictionary weight --')

const dictSource = await readFile(dictPath, 'utf8')
const sourceBytes = Buffer.byteLength(dictSource)
console.log(`  serialized data ${serialized} B, source file ${sourceBytes} B, keys ${keys.length}`)
// The 9 reason strings for server failure codes are part of the page's
// contract (a code without copy falls back to the server's Chinese sentence),
// so the budget moved from 8 KiB to 10 KiB; it still guards against unbounded
// copy growth in the literal client.js has to carry.
check('dictionary data stays under 10 KiB', serialized <= 10240, `${serialized} B`)
check('dictionary source stays under 16 KiB', sourceBytes <= 16384, `${sourceBytes} B`)

/* ------------------------------------------------------ client.js copy -- */

console.log('-- client.js --')

const clientSource = await readFile(clientPath, 'utf8')
const generatedBlock = /^[ \t]*\/\* ---- generated dictionary ---- \*\/[\s\S]*?\/\* ---- end generated dictionary ---- \*\//m
const literalPattern = /const DICT_JSON = ('(?:[^'\\]|\\.)*')/

/** Render the dictionary as one single-quoted, ASCII-only JavaScript literal. */
function instantiateLiteral (dictionary) {
  const json = JSON.stringify(dictionary)
  // Backslashes and control characters would need a second escaping pass, and a
  // single quote would end the literal; the dictionary validation forbids both.
  const unsafe = /['\\\u0000-\u001f\u2028\u2029]/.exec(json)
  if (unsafe !== null) throw new Error(`dictionary text needs escaping beyond this generator: ${JSON.stringify(unsafe[0])}`)
  const escaped = json.replace(NON_ASCII, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `'${escaped}'`
}

function buildClientCopy (dictionary) {
  return '    /* ---- generated dictionary ---- */\n'
    + `    const DICT_JSON = ${instantiateLiteral(dictionary)}\n`
    + '    /* ---- end generated dictionary ---- */'
}

if (writeCopy) {
  const next = clientSource.replace(generatedBlock, buildClientCopy(DICT))
  if (next === clientSource) {
    console.log('  nothing to do: the generated block is already current')
  } else {
    await writeFile(clientPath, next)
    console.log(`  wrote the generated block into client.js (${Buffer.byteLength(next)} B)`)
  }
  process.exit(0)
}

check('client.js declares the generated dictionary block', generatedBlock.test(clientSource))
const literalMatch = clientSource.match(literalPattern)
check('client.js carries a DICT_JSON literal', literalMatch !== null)
if (literalMatch !== null) {
  // Evaluate only the literal, then parse the JSON text it holds.
  const jsonText = new Function(`return ${literalMatch[1]}`)()
  check('the embedded copy parses as JSON', typeof jsonText === 'string' && jsonText.startsWith('{"zh":'))
  check('the embedded copy is byte-identical to lib/locale-dict.js', jsonText === JSON.stringify(DICT),
    'run: node test/client-locale.mjs --write')
  const embeddedBytes = Buffer.byteLength(literalMatch[1])
  console.log(`  embedded literal ${embeddedBytes} B (${Math.round((embeddedBytes / Buffer.byteLength(clientSource)) * 100)}% of client.js)`)
}
const parsedClient = (() => {
  try { new Function('window', clientSource); return true } catch { return false }
})()
check('client.js syntax parses', parsedClient)

/* ------------------------------------------- leftover CJK in client.js -- */

console.log('-- leftover CJK in client.js --')

/** Blank out comments while keeping string literals, so a scan sees copy but not prose. */
function stripComments (source) {
  let out = ''
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 1; continue }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 1; continue }
      if (char === "'") { state = 'single'; out += char; continue }
      if (char === '"') { state = 'double'; out += char; continue }
      if (char === '`') { state = 'template'; out += char; continue }
      out += char
      continue
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += '\n' } else out += ' '
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 1; continue }
      out += char === '\n' ? '\n' : ' '
      continue
    }
    if (char === '\\') { out += char + (next ?? ''); index += 1; continue }
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) state = 'code'
    out += char
  }
  return out
}

const codeOnly = stripComments(clientSource)
const lineStarts = [0]
for (let index = 0; index < codeOnly.length; index += 1) if (codeOnly[index] === '\n') lineStarts.push(index + 1)
const leftovers = [...codeOnly.matchAll(new RegExp(CJK.source, 'g'))].map((match) => {
  let line = 0
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= match.index) line += 1
  const snippet = codeOnly.slice(Math.max(0, match.index - 12), match.index + 12).split('\n')[0]
  return { line: line + 1, char: match[0], snippet }
})
const nonAscii = [...new Set([...codeOnly.matchAll(new RegExp(NON_ASCII.source, 'g'))].map((match) => match[0]))]
console.log(`  ${leftovers.length} CJK character(s) outside comments, ${nonAscii.length} distinct non-ASCII code point(s) in total`)
if (nonAscii.length > 0) console.log(`  non-ASCII inventory: ${nonAscii.map((char) => `${JSON.stringify(char)} U+${char.codePointAt(0).toString(16).toUpperCase()}`).join(', ')}`)
for (const leftover of leftovers.slice(0, 20)) console.log(`  leftover line ${leftover.line}: ${JSON.stringify(leftover.char)} in ${JSON.stringify(leftover.snippet)}`)
check('no CJK string literals left in client.js', leftovers.length === 0, `${leftovers.length} character(s)`)

// Every dictionary key must be referenced from client.js, and every key the page
// asks for must exist — otherwise the copy drifts silently.
const unreferenced = keys.filter((key) => !clientSource.includes(`'${key}'`))
check('every dictionary key is referenced from client.js', unreferenced.length === 0, unreferenced.join(','))
const asked = [...new Set([...stripComments(clientSource).matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]))]
const unknown = asked.filter((key) => !(key in DICT.zh))
// The reason table is addressed through a computed key, so the literals in that
// table are not `t('reason.*')` call sites; count them separately.
const reasonLiterals = reasonKeys.filter((key) => clientSource.includes(`'${key}'`)).length
console.log(`  ${asked.length} distinct t() keys referenced, ${reasonLiterals} reason keys mapped, ${keys.length} dictionary keys`)
check('every t() key exists in the dictionary', unknown.length === 0, unknown.join(','))
check('t() and the reason table cover the dictionary', asked.length + reasonLiterals >= keys.length - 8,
  `${asked.length} call sites + ${reasonLiterals} reason keys for ${keys.length} keys`)
// The page may only translate codes it has copy for: an unmapped code would
// silently show the server's Chinese sentence instead.
const unmapped = reasonCodes.filter((code) => !clientSource.includes(`'${code}':`))
check('client.js maps every reason code to a dictionary key', unmapped.length === 0, unmapped.join(','))

/* --------------------------------------------- fake browser and react -- */

/**
 * Minimal React stand-in: element records, hooks backed by per-instance slots,
 * and effects re-run when their dependency list moves. Enough to render this
 * page; not a React implementation.
 */
function createReactShim () {
  let active = null
  let dirty = false
  const instances = new Map()

  const React = {
    createElement (type, props, ...children) {
      const element = { type, props: { ...(props ?? {}) } }
      if (children.length === 1) element.props.children = children[0]
      else if (children.length > 1) element.props.children = children
      return element
    },
    useState (initial) {
      const runtime = active
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(runtime.slots[index]) : next
        if (Object.is(value, runtime.slots[index])) return
        runtime.slots[index] = value
        dirty = true
      }
      return [runtime.slots[index], setState]
    },
    useEffect (fn, deps) {
      const runtime = active
      const index = runtime.cursor++
      const previous = runtime.effects[index]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      if (changed) runtime.pending.push({ index, fn, deps })
    },
    useCallback (fn) {
      const runtime = active
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = fn
      return runtime.slots[index]
    },
    useMemo (factory) {
      const runtime = active
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = factory()
      return runtime.slots[index]
    },
    useRef (initial) {
      const runtime = active
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = { current: initial }
      return runtime.slots[index]
    }
  }

  function runtimeFor (path) {
    let runtime = instances.get(path)
    if (runtime === undefined) {
      runtime = { slots: [], effects: [], cursor: 0, pending: [] }
      instances.set(path, runtime)
    }
    return runtime
  }

  function renderComponent (path, type, props) {
    const runtime = runtimeFor(path)
    runtime.cursor = 0
    runtime.pending = []
    const previous = active
    active = runtime
    let output
    try {
      output = type(props)
    } finally {
      active = previous
    }
    for (const effect of runtime.pending) {
      const prior = runtime.effects[effect.index]
      if (prior !== undefined && typeof prior.cleanup === 'function') {
        try { prior.cleanup() } catch { /* a stale cleanup must not stop the render */ }
      }
      const record = { deps: effect.deps, cleanup: undefined }
      const cleanup = effect.fn()
      if (typeof cleanup === 'function') record.cleanup = cleanup
      runtime.effects[effect.index] = record
    }
    return output
  }

  function expand (element, path) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (Array.isArray(element)) return element.map((child, index) => expand(child, `${path}[${index}]`))
    if (typeof element !== 'object') return element
    if (typeof element.type === 'function') {
      const output = renderComponent(path, element.type, element.props ?? {})
      return expand(output, `${path}/${element.type.name || 'anonymous'}`)
    }
    const props = element.props ?? {}
    if (props.children === undefined) return { ...element, props }
    return { ...element, props: { ...props, children: expand(props.children, `${path}.children`) } }
  }

  return {
    React,
    get dirty () { return dirty },
    clearDirty () { dirty = false },
    render (component) { return expand(React.createElement(component, {}), 'root') }
  }
}

/** Text nodes in tree order: what a reader would see, without props. */
function textsOf (tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { out.push(node); return }
    if (typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return out
}

function inputsOf (tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.type === 'input') out.push({ type: node.props.type, placeholder: node.props.placeholder, value: node.props.value })
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return out
}

function findClickable (tree, label) {
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.type === 'button' && textsOf(node).includes(label)) { found = node; return }
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return found
}

/** Fake Client locale service: the documented `register`/`getLocale`/`subscribe` shape. */
function createLocaleService ({ active = 'zh', services = ['zh', 'en'] } = {}) {
  const dictionaries = new Map()
  const listeners = new Set()
  // Mirrors the real catalog: Chinese and English are built in, extra languages
  // fall back to English.
  const locales = services.map((id) => ({ id, label: id, ...(id === 'en' ? {} : { fallback: 'en' }) }))
  let snapshot = { active, locales, revision: 0 }
  const service = {
    registrations: [],
    getLocale () { return snapshot },
    getSnapshot () { return snapshot },
    subscribe (fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    register (namespace, dicts) {
      service.registrations.push({ namespace, dicts })
      for (const [locale, dictionary] of Object.entries(dicts)) dictionaries.set(`${namespace}/${locale}`, dictionary)
      snapshot = { ...snapshot, revision: snapshot.revision + 1 }
      for (const fn of [...listeners]) fn()
      return () => {
        for (const locale of Object.keys(dicts)) dictionaries.delete(`${namespace}/${locale}`)
      }
    },
    bind (namespace) {
      return (key) => dictionaries.get(`${namespace}/${snapshot.active}`)?.[key] ?? key
    },
    setLocale (id) {
      if (id === snapshot.active) return
      snapshot = { ...snapshot, active: id, revision: snapshot.revision + 1 }
      for (const fn of [...listeners]) fn()
    }
  }
  return service
}

/** Fake Cordis client context: the seams `apply` touches, nothing more. */
function createClientContext ({ locale } = {}) {
  const context = {
    injections: [],
    effects: [],
    slotInjections: [],
    registrations: [],
    get (name) {
      if (name === 'locale') return locale
      return undefined
    },
    effect (fn, label) {
      const disposer = fn()
      context.effects.push({ label, disposer })
      return disposer
    },
    inject (deps, callback) {
      context.injections.push(deps)
      if (locale !== undefined && deps.includes('locale')) {
        callback({
          locale,
          effect (fn, label) {
            const disposer = fn()
            context.effects.push({ label, disposer })
            return disposer
          }
        })
      }
      return { then () { return this } }
    },
    slots: {
      inject (name, factory) {
        context.slotInjections.push(name)
        return factory()
      },
      register (options, component) {
        context.registrations.push({ options, component })
        return () => {}
      }
    }
  }
  return context
}

/** Execute client.js the way the browser loader does and return its registration. */
function evaluateBundle ({ React, fetch, setTimeout, console: consoleShim = { warn () {}, error () {} } }) {
  let registration = null
  const window = {
    __ModuleLoader__: {
      load (definition) {
        if (registration !== null) throw new Error('the bundle registered twice')
        registration = definition
      }
    }
  }
  const document = { addEventListener () {}, removeEventListener () {} }
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'console', clientSource)
  run(window, document, fetch, setTimeout, consoleShim)
  if (registration === null) throw new Error('the bundle did not register a factory')
  const plugin = registration.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
  return { registration, plugin }
}

/** Render one component to a tree and let its promises settle. */
function createPageHarness (component, shim) {
  let tree = shim.render(component)
  const settle = async () => {
    for (let turn = 0; turn < 80; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!shim.dirty) return tree
      shim.clearDirty()
      tree = shim.render(component)
    }
    throw new Error('the component tree did not settle')
  }
  return {
    get tree () { return tree },
    settle,
    texts () { return textsOf(tree) },
    inputs () { return inputsOf(tree) }
  }
}

/* ------------------------------------------- fake provider scenario -- */

function createTimers () {
  let now = 0
  let sequence = 0
  const queue = new Map()
  return {
    setTimeout (fn, ms = 0) {
      const id = ++sequence
      queue.set(id, { fn, due: now + Math.max(0, Number(ms) || 0) })
      return id
    },
    advance (ms) {
      now += ms
      for (;;) {
        let next = null
        for (const [id, timer] of queue) if (timer.due <= now && (next === null || timer.due < next.timer.due)) next = { id, timer }
        if (next === null) return
        queue.delete(next.id)
        next.timer.fn()
      }
    }
  }
}

const CONFIG = {
  tts: {
    provider: 'minimax', baseUrl: 'https://api.minimax.chat', model: 'speech-2.8-hd', voice: 'female-shaonv',
    speed: 1, pitch: 0, ffmpegPath: '', keySet: false, envName: 'MINIMAX_API_KEY', envPresent: true
  },
  check: {
    provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen2.5-omni-7b',
    autoValidate: false, keySet: true, enabled: true
  }
}
const VOICES = {
  ok: true,
  items: [{ id: 'female-shaonv', name: '通用女声' }, { id: 'male-qn-qingse', name: '青涩青年音色' }],
  source: 'static',
  note: null
}

function jsonResponse (body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text () { return JSON.stringify(body) },
    async json () { return body }
  }
}

/** One routed fake network; `route.*` decides what each endpoint answers. */
function createFetch (route) {
  return async (url, options) => {
    const method = options?.method ?? 'GET'
    route.calls.push({ url, method })
    if (url === '/dsh-audio/config' && method === 'GET') return route.config()
    if (url === '/dsh-audio/config' && method === 'POST') return route.save()
    if (url === '/dsh-audio/voices') return route.voices()
    if (url === '/dsh-audio/validate') return route.validate()
    if (url === '/dsh-audio/test') return route.test()
    throw new Error(`unexpected fetch ${JSON.stringify(url)}`)
  }
}

function createRoute (overrides = {}) {
  return {
    calls: [],
    config: () => jsonResponse({ ok: true, config: CONFIG }),
    save: () => jsonResponse({ ok: true }),
    voices: () => jsonResponse(VOICES),
    // Only used when a test clicks the self-check buttons; happy answers keep the
    // harness reusable without each scenario having to spell them out.
    validate: () => jsonResponse({
      ok: true,
      target: 'check',
      model: 'qwen2.5-omni-7b',
      endpoint: { reachable: true, status: 404, error: null },
      audioAccepted: true,
      answer: '像一声铃响',
      latencyMs: 120
    }),
    test: () => jsonResponse({
      ok: true,
      target: 'tts',
      durationSeconds: 1.2,
      effective: { model: 'speech-2.8-hd', voice: 'female-shaonv' },
      timestamps: 2
    }),
    ...overrides
  }
}

/* ----------------------------------------- expected settings page copy -- */

// The zh tree is frozen here: it is the page as it shipped before it was
// localized, so any drift in labels, descriptions, order or values fails loudly.
const ZH_TEXTS = [
  '声音',
  '合成、混音、音频检查的技术部分不需要密钥；这里配置旁白（TTS）和语义检查所用的服务。',
  '旁白 · TTS',
  '供应商',
  'MiniMax',
  '▾',
  '接口地址',
  '模型',
  'speech-2.8-hd 自动情感；speech-2.6-hd 支持手动情感',
  '音色',
  '静态名单，未联网校验；配置密钥后自动换成账号的实时列表',
  '通用女声 · female-shaonv',
  '▾',
  '语速',
  '0.5 – 2.0',
  '音调',
  '半音，−12 – 12',
  'ffmpeg',
  '仅 Edge 需要：它只提供压缩音频，用本机 ffmpeg 解码成波形。留空自动探测 ~/.dsh/tools/ffmpeg',
  'API 密钥',
  '留空则读环境变量 MINIMAX_API_KEY（已检测到）',
  '测试连接',
  '合成一句话并试听，用来确认密钥、模型、音色都对',
  '合成并试听',
  '音频检查 · 语义层（可选）',
  'MiniMax 没有音频理解接口，这里使用 OpenAI 兼容的 input_audio 端点（Qwen-Omni 等）。不填则只跑技术检查。',
  '语义检查（实验）',
  '默认关闭。关闭时测试识别和 audio_check 的 question 都不发请求；开启后才使用下面的地址、模型与密钥。',
  '接口地址',
  '模型',
  'API 密钥',
  '已保存密钥；留空保持不变',
  '测试识别',
  '送一段铃声给模型，看它能不能描述出来',
  '试听并识别',
  '模型自检（实验性）',
  '默认关闭。开启后每次保存都会用真实音频问模型一次，并显示端点状态、HTTP 状态与耗时；也可以点右边按钮立即校验。只校验已保存的配置。',
  '关闭（默认）',
  '▾',
  '立即校验',
  '保存',
  '重新读取'
]

const ZH_PLACEHOLDERS = [
  'https://api.minimax.chat',
  'speech-2.8-hd',
  '也可以直接填音色 id',
  '留空 = 自动探测',
  '留空则不修改',
  '留空则不修改'
]

// Provider data (a voice name returned by the API) is not page copy: it stays
// in the account's language in every UI locale.
const PROVIDER_DATA = new Set(['通用女声 · female-shaonv'])

/* ------------------------------------------------------ plugin wiring -- */

console.log('-- plugin wiring --')
{
  const locale = createLocaleService({ active: 'zh' })
  const probe = createReactShim()
  const { registration, plugin } = evaluateBundle({ React: probe.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })

  check('bundle registers the package id', registration.id === 'dsh-audiokit', registration.id)
  check('factory returns a plugin object', plugin !== null && typeof plugin === 'object')
  check('plugin requires slots only', JSON.stringify(plugin.inject) === '["slots"]', JSON.stringify(plugin.inject))
  check('plugin exposes apply', typeof plugin.apply === 'function')

  const context = createClientContext({ locale })
  plugin.apply(context)
  check('one settings.section registration', context.registrations.length === 1, String(context.registrations.length))
  const { options, component } = context.registrations[0]
  check('registers into settings.section', options.name === 'settings.section' && options.id === 'dsh-audiokit', JSON.stringify({ name: options.name, id: options.id }))
  check('keeps its navigation order', options.order === 50, String(options.order))
  check('nav label is a thunk', typeof options.label === 'function')
  check('nav label reads zh at registration', options.label() === '声音', JSON.stringify(options.label()))
  check('component is the settings page', typeof component === 'function' && component.name === 'SettingsPage', component?.name)
  check('locale is injected as an optional dependency', context.injections.some((deps) => deps.includes('locale')), JSON.stringify(context.injections))
  check('the section slot is declared through slots.inject', context.slotInjections.includes('settings.section'), JSON.stringify(context.slotInjections))
  check('dictionary registered through the service', locale.registrations.length === 1, String(locale.registrations.length))
  const registrationCall = locale.registrations[0]
  check('dictionary used the plugin namespace', registrationCall.namespace === NS, registrationCall?.namespace)
  check('zh dictionary registered verbatim', JSON.stringify(registrationCall.dicts.zh) === JSON.stringify(zh))
  check('en dictionary registered verbatim', JSON.stringify(registrationCall.dicts.en) === JSON.stringify(en))
  check('every effect is labelled for diagnostics', context.effects.length > 0 && context.effects.every((effect) => typeof effect.label === 'string' && effect.label.startsWith('dsh-audiokit:')),
    JSON.stringify(context.effects.map((effect) => effect.label)))

  locale.setLocale('en')
  check('nav label follows a language switch', options.label() === 'Sound', JSON.stringify(options.label()))
  locale.setLocale('zh')
  check('nav label returns to Chinese', options.label() === '声音', JSON.stringify(options.label()))
}

{
  // No locale service at all: the page must still register and stay Chinese.
  const context = createClientContext({})
  const probe = createReactShim()
  const { plugin } = evaluateBundle({ React: probe.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })
  let threw = false
  try { plugin.apply(context) } catch { threw = true }
  check('apply survives a composition without the locale service', threw === false)
  check('renders without a locale service', context.registrations.length === 1)
  check('nav label degrades to Chinese', context.registrations[0].options.label() === '声音')
  check('no dictionary effect without the service', context.effects.every((effect) => effect.label !== 'dsh-audiokit: locale dictionaries'))
}

{
  // A service whose register throws must not take the page down.
  const locale = createLocaleService({ active: 'en' })
  locale.register = () => { throw new Error('dictionary clash') }
  const context = createClientContext({ locale })
  const probe = createReactShim()
  const { plugin } = evaluateBundle({ React: probe.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })
  let threw = false
  try { plugin.apply(context) } catch { threw = true }
  check('a throwing register does not break apply', threw === false)
  check('the page still registers its section', context.registrations.length === 1)
}

{
  // A service with an unexpected shape: no subscribe, no register, and a
  // getLocale that throws. The page must keep rendering in Chinese.
  const brokenLocale = {
    getLocale () { throw new Error('unsupported') }
  }
  const shim = createReactShim()
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })
  const context = createClientContext({ locale: brokenLocale })
  let threw = false
  try { plugin.apply(context) } catch { threw = true }
  check('an unexpected service shape does not break apply', threw === false)
  check('nav label still resolves in Chinese with a broken service', context.registrations[0].options.label() === '声音')
  const page = createPageHarness(context.registrations[0].component, shim)
  await page.settle()
  check('the page still renders in Chinese with a broken service', JSON.stringify(page.texts()) === JSON.stringify(ZH_TEXTS),
    `first difference at ${JSON.stringify(firstDifference(page.texts(), ZH_TEXTS))}`)
}

/* ------------------------------------------------------ rendered page -- */

console.log('-- rendered page (zh) --')

{
  const shim = createReactShim()
  const timers = createTimers()
  const route = createRoute()
  const locale = createLocaleService({ active: 'zh' })
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(route), setTimeout: timers.setTimeout })
  const context = createClientContext({ locale })
  plugin.apply(context)
  const page = createPageHarness(context.registrations[0].component, shim)

  check('first paint shows the loading hint', page.texts().includes('读取中…'), JSON.stringify(page.texts()))
  await page.settle()

  const zhTexts = page.texts()
  if (dumpCopy) console.log(JSON.stringify(zhTexts, null, 2))
  check('zh page shows every expected text, in order', JSON.stringify(zhTexts) === JSON.stringify(ZH_TEXTS),
    `first difference at ${JSON.stringify(firstDifference(zhTexts, ZH_TEXTS))}`)

  const inputs = page.inputs()
  const placeholders = inputs.map((input) => input.placeholder).filter((placeholder) => placeholder !== undefined)
  check('zh placeholders are unchanged', JSON.stringify(placeholders) === JSON.stringify(ZH_PLACEHOLDERS), JSON.stringify(placeholders))
  check('both API key fields are password inputs', inputs.filter((input) => input.type === 'password').length === 2,
    JSON.stringify(inputs.map((input) => input.type)))
  check('number fields stay numeric', inputs.filter((input) => input.type === 'number').length === 2)

  // Language switch: the same tree, translated in place.
  locale.setLocale('en')
  await page.settle()
  const enTexts = page.texts()
  if (dumpCopy) console.log(JSON.stringify(enTexts, null, 2))
  check('en page keeps the same number of text nodes', enTexts.length === ZH_TEXTS.length, `${enTexts.length} vs ${ZH_TEXTS.length}`)
  const leftoverCjk = enTexts.filter((text) => CJK.test(text) && !PROVIDER_DATA.has(text))
  check('en page has no Chinese copy left', leftoverCjk.length === 0, leftoverCjk.slice(0, 3).join(' | '))
  check('provider data stays in its own language', enTexts.filter((text) => PROVIDER_DATA.has(text)).length === 1)
  check('en page shows English section titles', enTexts.includes('Narration · TTS') && enTexts.includes('Audio check · semantic layer (optional)'), JSON.stringify(enTexts.slice(0, 4)))
  check('en page shows the semantic switch in English', enTexts.includes(en['check.enabledRow']), JSON.stringify(enTexts.filter((text) => /semantic/i.test(text))))
  check('en page shows English field labels', ['Provider', 'Endpoint', 'Model', 'Voice', 'Speed', 'Pitch', 'API key'].every((label) => enTexts.includes(label)), JSON.stringify(enTexts.slice(3, 12)))
  check('en page shows English buttons', ['Synthesize & listen', 'Listen & identify', 'Validate now', 'Save', 'Reload'].every((label) => enTexts.includes(label)), JSON.stringify(enTexts.slice(-8)))
  check('en page shows English descriptions', enTexts.includes(en['tts.voiceDescStatic']) && enTexts.includes(en['tts.keyStored']) && enTexts.includes(en['tts.keyEnvDetected'].replace('{env}', 'MINIMAX_API_KEY')))
  const enPlaceholders = page.inputs().map((input) => input.placeholder).filter((placeholder) => placeholder !== undefined)
  check('en placeholders are translated', enPlaceholders.includes('Or type a voice id') && enPlaceholders.includes('Empty = auto-detect'), JSON.stringify(enPlaceholders))
  check('en page still has 2 password fields', page.inputs().filter((input) => input.type === 'password').length === 2)

  locale.setLocale('zh')
  await page.settle()
  check('switching back restores the Chinese page exactly', JSON.stringify(page.texts()) === JSON.stringify(ZH_TEXTS))
}

console.log('-- server failure reasons in the rendered page --')
{
  // This is the acceptance bug, reproduced as a render assertion: the English
  // page used to print the route's Chinese reason because the reason arrived as
  // opaque text. The route now sends `reasonCode` + the untouched `detail`, and
  // the page must show the English sentence while keeping any provider payload.
  const shim = createReactShim()
  const timers = createTimers()
  const route = createRoute()
  const locale = createLocaleService({ active: 'zh' })
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(route), setTimeout: timers.setTimeout })
  const context = createClientContext({ locale })
  plugin.apply(context)
  const page = createPageHarness(context.registrations[0].component, shim)
  await page.settle()

  const MISSING_KEY = {
    ok: true,
    target: 'check',
    model: 'qwen2.5-omni-7b',
    endpoint: { reachable: true, status: 404, error: null },
    audioAccepted: false,
    error: '音频理解: 环境变量 DASHSCOPE_API_KEY 为空。在启动 DSH 的环境里设置它，或在插件 config 里写 apiKey。',
    detail: '音频理解: 环境变量 DASHSCOPE_API_KEY 为空。在启动 DSH 的环境里设置它，或在插件 config 里写 apiKey。',
    reasonCode: 'missing-key',
    envName: 'DASHSCOPE_API_KEY',
    latencyMs: 41
  }

  const click = async (label) => {
    const button = findClickable(page.tree, label)
    check(`the "${label}" button exists`, button !== null)
    if (button === null) return
    button.props.onClick()
    await page.settle()
  }
  const lineContaining = (needle) => page.texts().find((text) => text.includes(needle))

  route.validate = () => jsonResponse(MISSING_KEY)
  await click('立即校验')
  const zhLine = lineContaining('模型未通过')
  console.log(`  zh validate: ${JSON.stringify(zhLine)}`)
  check('zh failure uses the translated reason instead of pasting the server sentence',
    zhLine === '端点可达（HTTP 404） · 模型未通过：缺少 API 密钥（DASHSCOPE_API_KEY） · qwen2.5-omni-7b', JSON.stringify(zhLine))
  check('the Chinese fix instruction is not repeated in the reason line',
    !(zhLine ?? '').includes('在启动 DSH 的环境里设置它'), JSON.stringify(zhLine))

  locale.setLocale('en')
  await page.settle()
  route.validate = () => jsonResponse(MISSING_KEY)
  await click('Validate now')
  const enLine = lineContaining('Model failed')
  console.log(`  en validate: ${JSON.stringify(enLine)}`)
  check('en failure uses the translated reason', enLine === 'Endpoint reachable (HTTP 404) · Model failed: missing API key (DASHSCOPE_API_KEY) · qwen2.5-omni-7b',
    JSON.stringify(enLine))
  check('en failure carries no Chinese copy', enLine !== undefined && !CJK.test(enLine), JSON.stringify(enLine))

  // A provider body is language-neutral data the page must keep: the translated
  // sentence alone would hide "Incorrect API key provided".
  route.validate = () => jsonResponse({
    ok: true,
    target: 'check',
    model: 'qwen2.5-omni-7b',
    endpoint: { reachable: true, status: 404, error: null },
    audioAccepted: false,
    error: 'api.minimax.chat HTTP 401: {"error":{"message":"Incorrect API key provided"}}',
    detail: 'api.minimax.chat HTTP 401: {"error":{"message":"Incorrect API key provided"}}',
    reasonCode: 'http-4xx',
    status: 401,
    latencyMs: 22
  })
  await click('Validate now')
  const httpLine = lineContaining('Model failed')
  console.log(`  en http-4xx: ${JSON.stringify(httpLine)}`)
  check('en failure interpolates the provider status', (httpLine ?? '').includes('provider rejected the request (HTTP 401)'), JSON.stringify(httpLine))
  check('the provider body is kept after the translation', (httpLine ?? '').includes('Incorrect API key provided'), JSON.stringify(httpLine))
  check('a translated HTTP failure carries no Chinese copy', httpLine !== undefined && !CJK.test(httpLine), JSON.stringify(httpLine))

  // A transport cause lives inside full-width parentheses; the page keeps that
  // ASCII cause and drops the rest of the server sentence.
  const transportLine = 'fetch failed（connect ECONNREFUSED 127.0.0.1:1）'
  route.validate = () => jsonResponse({
    ok: true,
    target: 'check',
    model: 'qwen2.5-omni-7b',
    endpoint: { reachable: false, status: 0, error: transportLine, detail: transportLine, reasonCode: 'endpoint-unreachable' },
    audioAccepted: false,
    error: transportLine,
    detail: transportLine,
    reasonCode: 'endpoint-unreachable',
    latencyMs: 3
  })
  await click('Validate now')
  const unreachableLine = lineContaining('Endpoint unreachable')
  console.log(`  en endpoint down: ${JSON.stringify(unreachableLine)}`)
  check('en endpoint failure is translated', /Endpoint unreachable: connection failed/.test(unreachableLine ?? ''), JSON.stringify(unreachableLine))
  check('the transport cause survives the translation', (unreachableLine ?? '').includes('connect ECONNREFUSED 127.0.0.1:1'), JSON.stringify(unreachableLine))
  check('the transport line carries no Chinese copy', unreachableLine !== undefined && !CJK.test(unreachableLine), JSON.stringify(unreachableLine))

  // A probe that does not apply (provider off / no URL) must not be called
  // "unreachable": the row has its own line and a translated reason.
  route.validate = () => jsonResponse({
    ok: true,
    target: 'tts',
    model: 'speech-2.8-hd',
    endpoint: {
      reachable: null,
      status: 0,
      error: 'TTS 已关闭（provider = none），没有端点可探测',
      detail: 'TTS 已关闭（provider = none），没有端点可探测',
      reasonCode: 'provider-none'
    },
    audioAccepted: false,
    error: '未知的 TTS provider "none"，支持 minimax / edge / openai / custom。',
    detail: '未知的 TTS provider "none"，支持 minimax / edge / openai / custom。',
    reasonCode: 'provider-none',
    latencyMs: 0
  })
  await click('Validate now')
  const notApplicableLine = lineContaining('Endpoint probe not applicable')
  console.log(`  en endpoint n/a: ${JSON.stringify(notApplicableLine)}`)
  check('an inapplicable probe says so in English', (notApplicableLine ?? '').includes('narration is off (provider = none)'), JSON.stringify(notApplicableLine))
  check('the inapplicable line carries no Chinese copy', notApplicableLine !== undefined && !CJK.test(notApplicableLine), JSON.stringify(notApplicableLine))

  // Malformed data must never reach the DOM as `[object Object]` / `undefined`:
  // the route is supposed to send strings, but the page cannot trust that.
  route.validate = () => jsonResponse({
    ok: true,
    target: 'check',
    model: { name: 'weird' },
    endpoint: { reachable: false },
    audioAccepted: false,
    error: { code: 42 },
    reasonCode: 'no-such-code',
    envName: { not: 'a string' }
  })
  await click('Validate now')
  const brokenLine = lineContaining('Endpoint unreachable')
  console.log(`  en malformed response: ${JSON.stringify(brokenLine)}`)
  check('a malformed response never prints [object Object]', !/\[object Object\]/.test(brokenLine ?? ''), JSON.stringify(brokenLine))
  check('a malformed response never prints undefined or NaN', !/undefined|NaN/.test(brokenLine ?? ''), JSON.stringify(brokenLine))
  check('an unknown reason code falls back to the unknown-reason copy', (brokenLine ?? '').includes('unknown reason'), JSON.stringify(brokenLine))
  check('a missing model falls back to the no-model copy', (brokenLine ?? '').includes('no model set'), JSON.stringify(brokenLine))

  // The test-connection row takes the same path through `error.testFail`.
  route.test = () => jsonResponse({
    ok: false,
    target: 'tts',
    error: 'MiniMax TTS: 环境变量 MINIMAX_API_KEY 为空。在启动 DSH 的环境里设置它，或在插件 config 里写 apiKey。',
    detail: 'MiniMax TTS: 环境变量 MINIMAX_API_KEY 为空。在启动 DSH 的环境里设置它，或在插件 config 里写 apiKey。',
    reasonCode: 'missing-key',
    envName: 'MINIMAX_API_KEY'
  })
  await click('Synthesize & listen')
  const testFailLine = lineContaining('Failed:')
  console.log(`  en test failure: ${JSON.stringify(testFailLine)}`)
  check('a failed connection test uses the translated reason', testFailLine === 'Failed: missing API key (MINIMAX_API_KEY)', JSON.stringify(testFailLine))
  check('a failed connection test carries no Chinese copy', testFailLine !== undefined && !CJK.test(testFailLine), JSON.stringify(testFailLine))

  // Same server payload in Chinese: the copy is the Chinese sentence, so the
  // page keeps the row in one language here too.
  locale.setLocale('zh')
  await page.settle()
  await click('试听并识别')
  const zhTestFailLine = lineContaining('测试失败') ?? lineContaining('失败：')
  console.log(`  zh test failure: ${JSON.stringify(zhTestFailLine)}`)
  check('a zh test failure reads the Chinese reason', zhTestFailLine === '失败：缺少 API 密钥（MINIMAX_API_KEY）', JSON.stringify(zhTestFailLine))
}

console.log('-- language without a dictionary follows the fallback chain --')
{
  // The service ships eight locales; this plugin only translates two. A
  // Japanese reader must get the English copy (ja -> en), never Chinese.
  const shim = createReactShim()
  const locale = createLocaleService({ active: 'zh', services: ['zh', 'en', 'ja'] })
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })
  const context = createClientContext({ locale })
  plugin.apply(context)
  const page = createPageHarness(context.registrations[0].component, shim)
  await page.settle()
  locale.setLocale('ja')
  await page.settle()
  const texts = page.texts()
  check('an untranslated language reads its declared fallback (en)', texts.includes('Narration · TTS') && !texts.includes('旁白 · TTS'),
    JSON.stringify(texts.slice(0, 4)))
  check('the nav label follows the same fallback chain', context.registrations[0].options.label() === 'Sound',
    JSON.stringify(context.registrations[0].options.label()))
  check('no Chinese copy leaks into the fallback language', texts.filter((text) => CJK.test(text) && !PROVIDER_DATA.has(text)).length === 0,
    texts.filter((text) => CJK.test(text) && !PROVIDER_DATA.has(text)).slice(0, 3).join(' | '))
}

console.log('-- rendered page without the locale service --')
{
  const shim = createReactShim()
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(createRoute()), setTimeout: () => 0 })
  const context = createClientContext({})
  plugin.apply(context)
  const page = createPageHarness(context.registrations[0].component, shim)
  await page.settle()
  check('a composition without locale renders the Chinese page', JSON.stringify(page.texts()) === JSON.stringify(ZH_TEXTS),
    `first difference at ${JSON.stringify(firstDifference(page.texts(), ZH_TEXTS))}`)
  check('and the navigation label stays Chinese', context.registrations[0].options.label() === '声音')
}

console.log('-- failure path --')
{
  const shim = createReactShim()
  const timers = createTimers()
  let attempts = 0
  const route = createRoute({ config: () => { attempts += 1; throw new Error('boom') } })
  const { plugin } = evaluateBundle({ React: shim.React, fetch: createFetch(route), setTimeout: timers.setTimeout })
  const context = createClientContext({ locale: createLocaleService({ active: 'zh' }) })
  plugin.apply(context)
  const page = createPageHarness(context.registrations[0].component, shim)
  await page.settle()
  // Three retries are queued 700 ms apart; drive the fake clock past them.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    timers.advance(700)
    await page.settle()
  }
  check('a failed load is retried three times', attempts === 4, `${attempts} attempt(s)`)
  check('a failed load shows the Chinese error line', page.texts().includes('读取失败：boom'), JSON.stringify(page.texts()))
  check('a failed load offers the retry button', page.texts().includes('重试'), JSON.stringify(page.texts()))

  const retryButton = findClickable(page.tree, '重试')
  check('the retry button exists', retryButton !== null)
  const previousAttempts = attempts
  route.config = () => { attempts += 1; return jsonResponse({ ok: true, config: CONFIG }) }
  retryButton.props.onClick()
  await page.settle()
  check('retry loads the form', attempts > previousAttempts && page.texts().includes('旁白 · TTS'),
    `attempts ${previousAttempts} -> ${attempts}, ${page.texts().length} text node(s): ${JSON.stringify(page.texts().slice(0, 4))}`)
}

/* ---------------------------------------------------------------- end -- */

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(`dictionary: ${keys.length} keys (${reasonCodes.length} server reason codes), ${serialized} B serialized, ${leftovers.length} CJK leftover(s) in client.js`)
console.log(failures === 0 ? 'OK: locale dictionaries are complete, in sync, and render' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
