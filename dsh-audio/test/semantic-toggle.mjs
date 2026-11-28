/**
 * Semantic-check switch tests: `check.enabled` is off by default, and "off"
 * means no outbound request on *any* surface that could make one.
 *
 * Three surfaces share the one flag, so all three are driven here against a
 * local provider double that counts every request it sees:
 *   - `GET /dsh-audio/config` may not expose the model row while off;
 *   - `POST /dsh-audio/test` and `POST /dsh-audio/validate` answer from the
 *     saved flag alone (readable data, not a 500, and not a provider error);
 *   - `audio_check`'s `question` is skipped before the key lookup, so no socket
 *     is opened at all.
 *
 * Then the switch is turned on and the same calls must reach the provider,
 * which proves the zero-request assertions are about the flag and not about a
 * stub that would never call anyway. The last section renders the real
 * `client.js` bundle in a fake module loader: the fields must disappear while
 * unchecked, come back when checked, and a saved `enabled: true` must survive a
 * config round trip.
 *
 * Run: node test/semantic-toggle.mjs
 */

import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerCheckTool } from '../lib/check.js'
import { SEMANTIC_DISABLED_TEXT, registerSettingsRoute, semanticCheckEnabled } from '../lib/settings-route.js'
import { encodeWav } from '../lib/wav.js'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const clientPath = join(pluginDir, 'client.js')

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ------------------------------------------------------ provider double -- */

// Counts every request: the disabled assertions are "this array did not grow".
const hits = []
const provider = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    hits.push({ method: request.method, url: request.url })
    if (request.method === 'GET') {
      // The reachability probe lands here; any status proves the host answered.
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('nothing lives on the base URL')
      return
    }
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '像一声清脆的铃响。' } }] }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('nope')
  })
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const providerBase = `http://127.0.0.1:${provider.address().port}`

/** A deterministic sine, so the tool has a real file to measure. */
function sineWav (seconds, sampleRate = 24000) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) samples[index] = Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.4
  return encodeWav([samples], sampleRate, { dither: false })
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-semantic-'))
await writeFile(join(scratch, 'tone.wav'), sineWav(0.4))

/* --------------------------------------------------------- plugin mount -- */

// The saved row a user would have before touching the switch: a real key
// (never echoed), a local endpoint the provider double answers on, and
// `enabled: false` — exactly the default.
const config = {
  tts: {
    provider: 'minimax',
    baseUrl: 'https://api.minimax.chat',
    model: 'speech-2.8-hd',
    voice: 'female-shaonv',
    apiKeyEnv: 'MINIMAX_API_KEY'
  },
  check: {
    enabled: false,
    provider: 'openai',
    baseUrl: providerBase,
    model: 'qwen2.5-omni-7b',
    apiKey: 'semantic-secret',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    autoValidate: false
  }
}

const routes = new Map()
const child = {
  webServer: {
    register ({ kind, path, handler }) {
      routes.set(path, { kind, path, handler })
      return () => {}
    }
  },
  effect: (factory) => factory(),
  get (name) {
    if (name !== 'configEditor') return undefined
    return {
      edit (entry, change) {
        const next = change(config)
        for (const key of Object.keys(next)) config[key] = next[key]
        return next
      }
    }
  },
  fiber: { entry: { id: 'dsh-audio', name: 'dsh-audiokit' } }
}
registerSettingsRoute({ inject: (_deps, callback) => callback(child) }, config, '0.0.0-test')

/* --------------------------------------------------------------- driver -- */

function makeRequest ({ method = 'POST', body, headers = {} } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }
  request.destroy = () => {}
  process.nextTick(() => {
    if (typeof body === 'string' && body.length > 0) request.emit('data', Buffer.from(body))
    request.emit('end')
  })
  return request
}

function makeResponse () {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead (status, headers) { this.statusCode = status; this.headers = headers },
    end (body) { this.payload = String(body) }
  }
}

async function callRoute (path, options = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  const response = makeResponse()
  await route.handler(makeRequest(options), response)
  let json = null
  try { json = JSON.parse(response.payload) } catch { /* leave null */ }
  return { status: response.statusCode, headers: response.headers, json, raw: response.payload }
}

const postConfig = (body) => callRoute('/dsh-audio/config', { body: JSON.stringify(body ?? {}) })
const postTest = (body) => callRoute('/dsh-audio/test', { body: JSON.stringify(body ?? {}) })
const postValidate = (body) => callRoute('/dsh-audio/validate', { body: JSON.stringify(body ?? {}) })

const audioRegistered = new Map()
const audioCtx = {
  tools: { register: (definition) => { audioRegistered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
}
// The tool snapshots `config.check` by reference at registration time, which is
// the same object the route reads — so toggling its `enabled` property below is
// the in-process equivalent of a plugin restart after a save.
registerCheckTool(audioCtx, config)
const audioExec = { agent: { session: { id: 'semantic-toggle' } } }
const audioCheck = (args) => audioRegistered.get('audio_check').execute(args, audioExec)

/* ----------------------------------------------------- 1. off by default -- */

console.log('-- 1. the flag is off unless it is exactly true --')
{
  check('a row without the flag is off', semanticCheckEnabled({}) === false && semanticCheckEnabled(undefined) === false)
  check('a truthy string is not "on"', semanticCheckEnabled({ enabled: 'true' }) === false && semanticCheckEnabled({ enabled: 1 }) === false)
  check('only enabled:true switches it on', semanticCheckEnabled({ enabled: true }) === true)
  check('the readable reason is the shared sentence', SEMANTIC_DISABLED_TEXT.includes('语义检查未启用'), SEMANTIC_DISABLED_TEXT)
}

console.log('-- 2. disabled config view exposes the switch and nothing else --')
{
  hits.length = 0
  const result = await callRoute('/dsh-audio/config', { method: 'GET' })
  const view = result.json?.config?.check ?? {}
  console.log(`  GET /dsh-audio/config -> HTTP ${result.status} check=${JSON.stringify(view)}`)
  check('the config still answers 200', result.status === 200 && result.json?.ok === true)
  check('the view reports enabled=false', view.enabled === false)
  check('the view hides the endpoint', view.baseUrl === undefined, JSON.stringify(view.baseUrl))
  check('the view hides the model', view.model === undefined, JSON.stringify(view.model))
  check('the view hides the key facts', view.keySet === undefined && view.envName === undefined, JSON.stringify(view))
  check('the view is exactly the one flag', JSON.stringify(view) === '{"enabled":false}', JSON.stringify(view))
  check('the response never mentions the model', !result.raw.includes('qwen2.5-omni-7b'), result.raw)
  check('the response never mentions the key', !result.raw.includes('semantic-secret'), result.raw)
  check('reading the config sent nothing', hits.length === 0, JSON.stringify(hits))
}

/* ------------------------------------ 3. disabled /test and /validate ---- */

console.log('-- 3. disabled /test answers without a request --')
{
  hits.length = 0
  const result = await postTest({ target: 'check' })
  const body = result.json ?? {}
  console.log(`  POST /dsh-audio/test -> HTTP ${result.status} ${result.raw}`)
  check('a disabled /test is not a server error', result.status === 200, String(result.status))
  check('a disabled /test reports ok:false', body.ok === false)
  check('the skip carries the semantic-disabled code', body.reasonCode === 'semantic-disabled', JSON.stringify(body.reasonCode))
  check('the skip is readable on its own', /语义检查未启用/.test(body.error ?? ''), String(body.error))
  check('the skip names the target and says it was disabled', body.target === 'check' && body.disabled === true)
  check('the skip keeps a detail field for the page', body.detail === body.error, JSON.stringify(body.detail))
  check('a disabled /test sent nothing', hits.length === 0, JSON.stringify(hits))
}

console.log('-- 4. disabled /validate answers without a request --')
{
  hits.length = 0
  const result = await postValidate({ target: 'check' })
  const body = result.json ?? {}
  console.log(`  POST /dsh-audio/validate -> HTTP ${result.status} ${result.raw}`)
  check('a disabled /validate is still data', result.status === 200 && body.ok === true && body.disabled === true)
  check('the skip carries the semantic-disabled code', body.reasonCode === 'semantic-disabled', JSON.stringify(body.reasonCode))
  check('nothing is marked reachable', body.endpoint?.reachable === null, JSON.stringify(body.endpoint))
  check('the endpoint row carries the same code', body.endpoint?.reasonCode === 'semantic-disabled', JSON.stringify(body.endpoint?.reasonCode))
  check('no audio is claimed accepted', body.audioAccepted === false)
  check('the reason is readable', /语义检查未启用/.test(body.error ?? ''), String(body.error))
  check('a disabled /validate sent nothing', hits.length === 0, JSON.stringify(hits))
}

console.log('-- 5. disabled audio_check question is skipped before any key lookup --')
{
  hits.length = 0
  const result = await audioCheck({ paths: ['tone.wav'], question: '这是什么声音？' })
  console.log(`  verdict=${result.verdict} opinion=${JSON.stringify(result.opinion)} skipped=${result.opinionSkipped} disabled=${result.semanticDisabled}`)
  check('the local check still produces a verdict', typeof result.verdict === 'string', String(result.verdict))
  check('no opinion is invented', result.opinion === null)
  check('the skip is reported as data', result.opinionSkipped === true && result.semanticDisabled === true)
  check('the summary text says the switch is off', (result.text ?? '').includes('语义检查未启用'), result.text)
  check('an info issue names the skipped file', result.issues.some((issue) => issue.level === 'info' && /语义检查未启用/.test(issue.message)))
  check('a disabled question sent nothing', hits.length === 0, JSON.stringify(hits))
}

/* --------------------------------------------------- 6. switched on ---- */

console.log('-- 6. switched on, every surface really calls the provider --')
{
  config.check.enabled = true

  // The saved row points at the local double for the calls below, and the
  // read-side redaction deliberately hides a non-https/loopback endpoint; use a
  // public https endpoint for the one view assertion so "the row is visible" is
  // about the switch and not about the URL rules.
  const localBase = config.check.baseUrl
  config.check.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode'
  const view = await callRoute('/dsh-audio/config', { method: 'GET' })
  const checkView = view.json?.config?.check ?? {}
  console.log(`  GET /dsh-audio/config -> check=${JSON.stringify(checkView)}`)
  check('the enabled view reports enabled=true', checkView.enabled === true)
  check('the enabled view returns the saved endpoint', checkView.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode', JSON.stringify(checkView.baseUrl))
  check('the enabled view returns the saved model', checkView.model === 'qwen2.5-omni-7b', JSON.stringify(checkView.model))
  check('the enabled view reports the key as set without echoing it', checkView.keySet === true && !view.raw.includes('semantic-secret'))
  check('the enabled view reports the env fallback', checkView.envName === 'DASHSCOPE_API_KEY', JSON.stringify(checkView.envName))
  config.check.baseUrl = localBase

  hits.length = 0
  const tested = await postTest({ target: 'check' })
  const testedBody = tested.json ?? {}
  console.log(`  POST /dsh-audio/test -> HTTP ${tested.status} answer=${JSON.stringify(testedBody.answer)} hits=${hits.length}`)
  check('an enabled /test reaches the provider once', hits.length === 1 && hits[0].url === '/v1/chat/completions', JSON.stringify(hits))
  check('an enabled /test returns the model answer', tested.status === 200 && testedBody.ok === true && testedBody.answer === '像一声清脆的铃响。', tested.raw)
  check('a successful test carries no reason code', testedBody.reasonCode === undefined, JSON.stringify(testedBody.reasonCode))

  hits.length = 0
  const validated = await postValidate({ target: 'check' })
  const validatedBody = validated.json ?? {}
  console.log(`  POST /dsh-audio/validate -> HTTP ${validated.status} audioAccepted=${validatedBody.audioAccepted} hits=${hits.length}`)
  check('an enabled /validate probes and asks the model', hits.length === 2 &&
    hits.some((entry) => entry.method === 'GET') &&
    hits.some((entry) => entry.url === '/v1/chat/completions'), JSON.stringify(hits))
  check('an enabled /validate accepts the audio', validated.status === 200 && validatedBody.audioAccepted === true, validated.raw)
  check('an enabled /validate reports no disabled flag', validatedBody.disabled === undefined, JSON.stringify(validatedBody.disabled))

  hits.length = 0
  const checked = await audioCheck({ paths: ['tone.wav'], question: '这是什么声音？' })
  console.log(`  audio_check opinion=${JSON.stringify(checked.opinion)} hits=${hits.length}`)
  check('an enabled question asks the model', hits.length === 1 && hits[0].url === '/v1/chat/completions', JSON.stringify(hits))
  check('an enabled question returns the opinion', checked.opinion === '像一声清脆的铃响。', JSON.stringify(checked.opinion))
  check('an enabled question is not reported as skipped', checked.opinionSkipped === false && checked.semanticDisabled === false)
}

/* ------------------------------------------------ 7. persistence round trip -- */

console.log('-- 7. the saved flag survives a reload and keeps the hidden row --')
{
  const off = await postConfig({ check: { enabled: false } })
  console.log(`  POST enabled=false -> HTTP ${off.status} ${off.raw.slice(0, 160)}`)
  check('the off write is accepted', off.status === 200 && off.json?.ok === true, off.raw)
  check('the off write response hides the row again', JSON.stringify(off.json?.config?.check) === '{"enabled":false}', JSON.stringify(off.json?.config?.check))

  const hidden = await callRoute('/dsh-audio/config', { method: 'GET' })
  check('a reload after saving off still shows only the switch', JSON.stringify(hidden.json?.config?.check) === '{"enabled":false}',
    JSON.stringify(hidden.json?.config?.check))
  check('the stored row kept the endpoint while hidden', config.check.baseUrl === providerBase, JSON.stringify(config.check.baseUrl))
  check('the stored row kept the model while hidden', config.check.model === 'qwen2.5-omni-7b', JSON.stringify(config.check.model))

  const on = await postConfig({ check: { enabled: true } })
  const onView = on.json?.config?.check ?? {}
  console.log(`  POST enabled=true -> HTTP ${on.status} check=${JSON.stringify(onView)}`)
  check('the on write is accepted', on.status === 200 && on.json?.ok === true, on.raw)
  check('re-enabling does not resend the fields and still finds them',
    onView.model === 'qwen2.5-omni-7b' && config.check.baseUrl === providerBase,
    JSON.stringify({ viewModel: onView.model, storedBaseUrl: config.check.baseUrl }))

  const bad = await postConfig({ check: { enabled: 'yes' } })
  console.log(`  POST enabled="yes" -> HTTP ${bad.status} ${bad.raw}`)
  check('a non-boolean switch is refused', bad.status === 400 && bad.json?.ok === false, bad.raw)
  check('the refusal explains the switch type', /布尔/.test(bad.json?.error ?? ''), String(bad.json?.error))

  // Leave the saved row on for the UI section, which renders an enabled page.
  const restore = await postConfig({ check: { enabled: true } })
  check('the enabled row is in effect for the UI section', restore.json?.config?.check?.enabled === true)
}

/* ------------------------------------------------------------ 8. the page -- */

/**
 * Minimal React stand-in for the bundle: element records, per-instance hooks and
 * effects re-run when their dependency list moves. The same approach as
 * test/client-locale.mjs, trimmed to what this page renders.
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
      const changed = previous === undefined || deps === undefined || previous.deps === undefined ||
        deps.length !== previous.deps.length || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      if (changed) runtime.pending.push({ index, fn, deps })
    },
    useCallback (fn) {
      const runtime = active
      const index = runtime.cursor++
      if (!(index in runtime.slots)) runtime.slots[index] = fn
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
      return expand(renderComponent(path, element.type, element.props ?? {}), `${path}/${element.type.name || 'anonymous'}`)
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
    if (node.type === 'input') out.push({ type: node.props.type, checked: node.props.checked })
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return out
}

function findCheckbox (tree) {
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.type === 'input' && node.props.type === 'checkbox') { found = node; return }
    if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(tree)
  return found
}

const clientSource = await readFile(clientPath, 'utf8')

/** Mock Cordis client context: only what `apply` touches. */
function createClientContext () {
  const context = {
    registrations: [],
    injections: [],
    effects: [],
    slotInjections: [],
    get () { return undefined },
    effect (fn, label) {
      const disposer = fn()
      context.effects.push({ label, disposer })
      return disposer
    },
    inject () {},
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

function jsonResponse (body) {
  return { ok: true, status: 200, async text () { return JSON.stringify(body) }, async json () { return body } }
}

/**
 * Render the real bundle with one config view; returns text/input readers over
 * the settled tree plus the raw tree for interaction.
 */
async function renderPage (configView) {
  const shim = createReactShim()
  const window = { __ModuleLoader__: { load (definition) { this.definition = definition } } }
  const document = { addEventListener () {}, removeEventListener () {} }
  const fetch = async (url, options) => {
    const method = options?.method ?? 'GET'
    if (url === '/dsh-audio/config' && method === 'GET') return jsonResponse({ ok: true, version: 'test', config: configView })
    if (url === '/dsh-audio/voices') return jsonResponse({ ok: true, items: [], source: 'static', note: null })
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'console', clientSource)
  run(window, document, fetch, () => 0, { warn () {}, error () {} })
  const plugin = window.__ModuleLoader__.definition.factory((id) => {
    if (id === 'react') return shim.React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
  const context = createClientContext()
  plugin.apply(context)
  const component = context.registrations[0].component

  let tree = shim.render(component)
  const settle = async () => {
    for (let turn = 0; turn < 80; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!shim.dirty) return
      shim.clearDirty()
      tree = shim.render(component)
    }
    throw new Error('the component tree did not settle')
  }
  await settle()
  return {
    get tree () { return tree },
    settle,
    texts: () => textsOf(tree),
    inputs: () => inputsOf(tree)
  }
}

const TTS_VIEW = {
  provider: 'minimax',
  baseUrl: 'https://api.minimax.chat',
  model: 'speech-2.8-hd',
  voice: 'female-shaonv',
  speed: 1,
  pitch: 0,
  ffmpegPath: '',
  keySet: false,
  envName: 'MINIMAX_API_KEY',
  envPresent: false
}

console.log('-- 8. unchecked hides every model field of the semantic layer --')
{
  check('client.js gates the fields on the switch', /check\.enabled === true/.test(clientSource))
  check('client.js maps the disabled reason to a dictionary key', clientSource.includes("'semantic-disabled': 'reason.semantic-disabled'"))

  const page = await renderPage({ tts: TTS_VIEW, check: { enabled: false } })
  const texts = page.texts()
  console.log(`  disabled page: ${texts.length} text node(s), ${page.inputs().filter((input) => input.type === 'checkbox').length} checkbox(es)`)
  check('the switch itself is rendered', texts.includes('语义检查（实验）'), JSON.stringify(texts.filter((text) => text.includes('语义'))))
  check('the switch explains the off state', texts.some((text) => text.includes('默认关闭') && text.includes('不发请求')), JSON.stringify(texts))
  check('the endpoint field is hidden', texts.filter((text) => text === '接口地址').length === 1, String(texts.filter((text) => text === '接口地址').length))
  check('the model field is hidden', texts.filter((text) => text === '模型').length === 1, String(texts.filter((text) => text === '模型').length))
  check('the test button is hidden', !texts.includes('试听并识别'), JSON.stringify(texts.slice(-8)))
  check('the self-check row is hidden', !texts.includes('模型自检（实验性）'), JSON.stringify(texts.slice(-8)))
  check('the check key field is hidden', page.inputs().filter((input) => input.type === 'password').length === 1,
    JSON.stringify(page.inputs().map((input) => input.type)))
  const box = findCheckbox(page.tree)
  check('the switch starts unchecked', box !== null && box.props.checked === false, JSON.stringify(box?.props.checked))

  box.props.onChange({ target: { checked: true } })
  await page.settle()
  const shown = page.texts()
  check('checking the switch reveals the fields', shown.filter((text) => text === '接口地址').length === 2,
    String(shown.filter((text) => text === '接口地址').length))
  check('checking the switch reveals the check test button', shown.includes('试听并识别'), JSON.stringify(shown.slice(-10)))
  check('checking the switch reveals the self-check row', shown.includes('模型自检（实验性）'))
  check('checking the switch reveals the second key field', page.inputs().filter((input) => input.type === 'password').length === 2)
}
{
  // A reload with the saved row on: the checkbox must come back checked and the
  // fields visible without the user touching anything.
  const page = await renderPage({
    tts: TTS_VIEW,
    check: {
      enabled: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
      model: 'qwen2.5-omni-7b',
      keySet: true,
      envName: 'DASHSCOPE_API_KEY',
      envPresent: false
    }
  })
  const box = findCheckbox(page.tree)
  console.log(`  enabled page: checkbox=${JSON.stringify(box?.props.checked)} texts=${page.texts().length}`)
  check('a saved enabled=true re-renders checked', box !== null && box.props.checked === true, JSON.stringify(box?.props.checked))
  check('a saved enabled=true shows the fields immediately', page.texts().includes('试听并识别') && page.texts().filter((text) => text === '接口地址').length === 2)
  check('the enabled page shows the stored key state', page.texts().some((text) => text.includes('已保存密钥')), JSON.stringify(page.texts().slice(-10)))
}

/* ---------------------------------------------------------------- done -- */

provider.closeAllConnections?.()
provider.close()
await rm(scratch, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0
  ? 'OK: semantic check is off by default, sends nothing while off, and the settings row hides its fields'
  : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
