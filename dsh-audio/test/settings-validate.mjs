/**
 * Settings self-check tests: the `/dsh-audio/validate` route and the endpoint
 * probe behind it.
 *
 * What the settings page needs from a failure is *data* — was the endpoint
 * reachable, what HTTP status did it answer, did the model accept the audio,
 * how long did it take — not an HTTP error, because the page has to render the
 * failure. So the real registered handler is driven exactly the way the web
 * carrier drives it (mock req/res, same-origin headers) against a local
 * provider double, and every number it reports is printed.
 *
 * The same failures also have to be *translatable*: the page cannot show the
 * route's Chinese sentence in an English UI. So every failure path here asserts
 * the machine-readable `reasonCode` it now carries (see `REASON_CODES` in
 * `lib/settings-route.js`) plus the `detail` / `envName` / `status` fields the
 * page interpolates, and the table at the end proves each code is reachable.
 * Cases a local provider double cannot produce (Edge's missing decoder) are
 * asserted through the exported `classifyFailure`.
 *
 * What this cannot prove: that Alibaba/DashScope really answers with the field
 * names assumed here, and that a live MiniMax call survives a probe. Both need
 * one real call with a real key — see README.
 *
 * Run: node test/settings-validate.mjs
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { REASON_CODES, classifyFailure, probeEndpoint, registerSettingsRoute } from '../lib/settings-route.js'
import { encodeWav } from '../lib/wav.js'

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// Every reason code a route response produced, with the path that produced it
// (first proof wins, so the table points at the real handler call rather than a
// classifier unit case). A code missing from it means a failure path lost its
// classification, or one was never tested.
const observedCodes = new Map()
function checkCode (label, actual, expected, proof) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (typeof actual === 'string' && !observedCodes.has(actual)) observedCodes.set(actual, proof)
}

/* ------------------------------------------------------ provider double -- */

// `mode` lets one server play the provider's moods: happy, key rejected, a
// model that answers far too much, a failing service, a 200 that is a proxy's
// HTML page, and (for the probe) a 404 on its base URL.
let mode = 'ok'
const requests = []

function sineWav (seconds, sampleRate = 24000) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) samples[i] = Math.sin(2 * Math.PI * 220 * (i / sampleRate)) * 0.4
  return encodeWav([samples], sampleRate, { dither: false })
}

const provider = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization ?? null,
      requestBytes: Buffer.byteLength(raw, 'utf8'),
      body: raw
    })

    if (mode === 'unauthorized') {
      // Every route refuses this key, the base URL included, so the probe sees
      // the same status a real provider returns for a bad key.
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
      return
    }
    if (mode === 'server-error' && request.method !== 'GET') {
      // The host answers (the probe still gets its 404) but the service fails.
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'internal provider failure' } }))
      return
    }
    if (mode === 'html-200' && request.method !== 'GET') {
      // A 200 that is a proxy's error page rather than audio: the case that used
      // to be played as raw PCM noise.
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body>proxy error page</body></html>')
      return
    }
    if (request.method === 'GET') {
      // This is where the reachability probe lands. 404 is the honest answer to
      // a bare base URL, and it proves "any status counts as reachable".
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('nothing lives on the base URL')
      return
    }
    if (request.url === '/v1/chat/completions') {
      const content = mode === 'long-answer'
        ? '这是一段刻意很长的回答，用来验证页面只会收到前三百个字符。'.repeat(12)
        : ' 像一声清脆的铃响。 '
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content } }] }))
      return
    }
    if (request.url === '/v1/audio/speech') {
      response.writeHead(200, { 'Content-Type': 'audio/wav' })
      response.end(sineWav(1))
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('nope')
  })
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${provider.address().port}`

// Accepts the connection but never answers: the only way to measure the abort
// branch of probeEndpoint without waiting on a real network timeout.
const silent = createServer((request) => { request.resume() })
await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
const silentBase = `http://127.0.0.1:${silent.address().port}`

/* --------------------------------------------------------- plugin mount -- */

// The captured "saved config" the route reads. `apiKey` values are real here on
// purpose: the page must never see them back, and the mock provider checks the
// bearer the route actually used.
const config = {
  tts: {
    provider: 'custom',
    baseUrl: base,
    model: 'tts-1',
    voice: 'alloy',
    speed: 1,
    pitch: 0,
    sampleRate: 24000,
    apiKey: 'tts-secret'
  },
  check: {
    provider: 'openai',
    baseUrl: base,
    model: 'qwen2.5-omni-7b',
    apiKey: 'check-secret',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    autoValidate: false,
    // The semantic layer is opt-in; every check-target case below wants it on.
    enabled: true
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
      // The real editor persists and the host restarts the plugin; applying the
      // change to the same row is the in-process equivalent, so the GET after
      // the POST observes exactly what a restarted plugin would observe.
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

const validate = (body) => callRoute('/dsh-audio/validate', {
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
})

/* -------------------------------------------------------- route surface -- */

console.log('-- 1. route surface --')
{
  const route = routes.get('/dsh-audio/validate')
  console.log(`  routes: ${[...routes.keys()].join(', ')}`)
  check('validate route registered', route !== undefined)
  check('validate route is an exact route', route?.kind === 'exact', String(route?.kind))
}

console.log('-- 2. same-origin guard and method --')
{
  const get = await callRoute('/dsh-audio/validate', { method: 'GET' })
  console.log(`  GET -> HTTP ${get.status} ${get.raw}`)
  check('non-POST is 405', get.status === 405 && get.json?.ok === false)

  const crossSite = await callRoute('/dsh-audio/validate', { headers: { 'sec-fetch-site': 'cross-site' }, body: '{"target":"check"}' })
  console.log(`  cross-site POST -> HTTP ${crossSite.status} ${crossSite.raw}`)
  check('cross-site is refused with 403', crossSite.status === 403 && crossSite.json?.ok === false)
}

console.log('-- 3. empty body defaults to target=check (mock provider) --')
{
  requests.length = 0
  const result = await validate(undefined)
  const body = result.json ?? {}
  const chatRequests = requests.filter((entry) => entry.url === '/v1/chat/completions')
  console.log(`  HTTP ${result.status} · ${result.raw.length} B · content-type ${result.headers?.['Content-Type']}`)
  console.log(`  target=${body.target} baseUrl=${body.baseUrl} model=${body.model}`)
  console.log(`  endpoint reachable=${body.endpoint?.reachable} status=${body.endpoint?.status} error=${JSON.stringify(body.endpoint?.error)}`)
  console.log(`  audioAccepted=${body.audioAccepted} answer=${JSON.stringify(body.answer)} latencyMs=${body.latencyMs}`)
  console.log(`  provider saw: ${requests.map((entry) => `${entry.method} ${entry.url} (${entry.requestBytes} B, auth ${entry.auth ?? 'none'})`).join(' ; ')}`)
  check('empty body answers 200', result.status === 200)
  check('empty body defaults to check', body.target === 'check' && body.ok === true)
  check('baseUrl comes from the saved config', body.baseUrl === base, String(body.baseUrl))
  check('model comes from the saved config', body.model === 'qwen2.5-omni-7b', String(body.model))
  check('endpoint is reported reachable', body.endpoint?.reachable === true)
  check('any HTTP status counts as reachable (404 here)', body.endpoint?.status === 404, String(body.endpoint?.status))
  check('no endpoint error when reachable', body.endpoint?.error === null, JSON.stringify(body.endpoint?.error))
  check('audio was accepted', body.audioAccepted === true)
  check('answer is non-empty', typeof body.answer === 'string' && body.answer.length > 0, JSON.stringify(body.answer))
  check('answer is the provider text, trimmed', body.answer === '像一声清脆的铃响。', JSON.stringify(body.answer))
  check('latencyMs is a measured number', typeof body.latencyMs === 'number' && Number.isFinite(body.latencyMs) && body.latencyMs >= 0, String(body.latencyMs))
  check('the probe used the saved key', requests.some((entry) => entry.method === 'GET' && entry.auth === 'Bearer check-secret'))
  check('the model call used the saved key', chatRequests.length === 1 && chatRequests[0].auth === 'Bearer check-secret')
  check('a real 0.5 s sample went out, not a placeholder', chatRequests[0].requestBytes > 20000, `${chatRequests[0]?.requestBytes} B`)
  check('the request carries an audio part', /"type":"input_audio"/.test(chatRequests[0]?.body ?? ''))
  check('no API key is echoed in the report', !result.raw.includes('check-secret'))
  check('a successful report carries no reason code', body.reasonCode === undefined && body.endpoint?.reasonCode === undefined,
    JSON.stringify({ reasonCode: body.reasonCode, endpoint: body.endpoint?.reasonCode }))
}

console.log('-- 4. the page cannot retarget the probe --')
{
  const result = await validate({ target: 'check', baseUrl: 'http://127.0.0.1:1', model: 'evil-model', apiKey: 'evil-key' })
  const body = result.json ?? {}
  console.log(`  body asked for baseUrl=http://127.0.0.1:1 model=evil-model -> report baseUrl=${body.baseUrl} model=${body.model} audioAccepted=${body.audioAccepted}`)
  check('baseUrl still comes from the saved config', body.baseUrl === base, String(body.baseUrl))
  check('model still comes from the saved config', body.model === 'qwen2.5-omni-7b', String(body.model))
  check('the sound still went to the saved endpoint', body.audioAccepted === true)
  check('the probe did not go to the body URL', body.endpoint?.reachable === true && body.endpoint?.status === 404)
}

console.log('-- 5. provider rejects the key (HTTP 401) --')
{
  mode = 'unauthorized'
  const result = await validate({ target: 'check' })
  mode = 'ok'
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} ok=${body.ok} audioAccepted=${body.audioAccepted} latencyMs=${body.latencyMs}`)
  console.log(`  endpoint reachable=${body.endpoint?.reachable} status=${body.endpoint?.status}`)
  console.log(`  error=${JSON.stringify(body.error)}`)
  console.log(`  reasonCode=${JSON.stringify(body.reasonCode)} status=${JSON.stringify(body.status)} envName=${JSON.stringify(body.envName)}`)
  check('still HTTP 200 so the page can display it', result.status === 200)
  check('ok is true: the check itself ran', body.ok === true)
  check('audioAccepted is false', body.audioAccepted === false)
  check('error names the provider status', typeof body.error === 'string' && /401/.test(body.error), body.error)
  check('error carries the provider message', /Incorrect API key provided/.test(body.error ?? ''), body.error)
  checkCode('a rejected key is classified http-4xx', body.reasonCode, 'http-4xx', 'provider answers 401')
  check('the provider status is exposed for interpolation', body.status === 401, String(body.status))
  check('detail is the server message, unchanged', body.detail === body.error, `${JSON.stringify(body.detail)} vs ${JSON.stringify(body.error)}`)
  check('a rejected key carries no env name', body.envName === undefined, JSON.stringify(body.envName))
  check('no answer is claimed on failure', body.answer === undefined)
  check('latencyMs is filled even on failure', typeof body.latencyMs === 'number' && body.latencyMs >= 0, String(body.latencyMs))
  check('the probe reports the real status', body.endpoint?.status === 401, String(body.endpoint?.status))
  check('the error is text, not a stack', !/\n\s+at /.test(body.error ?? ''))
}

console.log('-- 6. long answer is truncated to 300 chars --')
{
  mode = 'long-answer'
  const result = await validate({ target: 'check' })
  mode = 'ok'
  const body = result.json ?? {}
  console.log(`  provider answer ${'这是一段刻意很长的回答，用来验证页面只会收到前三百个字符。'.repeat(12).length} chars -> report ${body.answer?.length} chars`)
  check('answer is cut at the limit', body.answer?.length === 300, String(body.answer?.length))
  check('the cut keeps the provider prefix', body.answer?.startsWith('这是一段刻意很长的回答'), body.answer?.slice(0, 20))
  check('a truncated answer is still accepted', body.audioAccepted === true)
}

console.log('-- 7. unreachable endpoint --')
{
  const saved = config.check.baseUrl
  config.check.baseUrl = 'http://127.0.0.1:1'
  const result = await validate({ target: 'check' })
  config.check.baseUrl = saved
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} endpoint.reachable=${body.endpoint?.reachable} status=${body.endpoint?.status}`)
  console.log(`  endpoint.error=${JSON.stringify(body.endpoint?.error)}`)
  console.log(`  audioAccepted=${body.audioAccepted} error=${JSON.stringify(body.error)} latencyMs=${body.latencyMs}`)
  console.log(`  endpoint.reasonCode=${JSON.stringify(body.endpoint?.reasonCode)} reasonCode=${JSON.stringify(body.reasonCode)}`)
  check('HTTP 200 even when the endpoint is down', result.status === 200 && body.ok === true)
  check('endpoint.reachable is false', body.endpoint?.reachable === false)
  check('endpoint.error is a non-empty string', typeof body.endpoint?.error === 'string' && body.endpoint.error.length > 0)
  check('endpoint.error explains the transport, not just "failed"', /bad port|ECONNREFUSED|fetch failed/.test(body.endpoint?.error ?? ''), body.endpoint?.error)
  checkCode('an unreachable endpoint is classified endpoint-unreachable', body.endpoint?.reasonCode, 'endpoint-unreachable', 'probe on a refused address')
  checkCode('the failed model call carries endpoint-unreachable too', body.reasonCode, 'endpoint-unreachable', 'probe on a refused address (model call)')
  check('endpoint detail is the probe message, unchanged', body.endpoint?.detail === body.endpoint?.error)
  check('audioAccepted is false', body.audioAccepted === false)
  check('the failed call is reported too', typeof body.error === 'string' && body.error.length > 0, body.error)
  check('latencyMs is still filled', typeof body.latencyMs === 'number' && body.latencyMs >= 0, String(body.latencyMs))
}

console.log('-- 8. target=tts uses the saved TTS row --')
{
  requests.length = 0
  const result = await validate({ target: 'tts' })
  const body = result.json ?? {}
  const speechRequests = requests.filter((entry) => entry.url === '/v1/audio/speech')
  console.log(`  HTTP ${result.status} target=${body.target} baseUrl=${body.baseUrl} model=${body.model}`)
  console.log(`  endpoint reachable=${body.endpoint?.reachable} status=${body.endpoint?.status} · audioAccepted=${body.audioAccepted} durationSeconds=${body.durationSeconds} latencyMs=${body.latencyMs}`)
  check('tts target is reported', body.target === 'tts' && body.ok === true)
  check('tts endpoint comes from the saved row', body.baseUrl === base, String(body.baseUrl))
  check('tts audio was accepted', body.audioAccepted === true)
  check('durationSeconds is the real length', Math.abs((body.durationSeconds ?? 0) - 1) < 0.02, String(body.durationSeconds))
  check('tts used the speech endpoint', speechRequests.length === 1, String(speechRequests.length))
  check('tts used the saved key', speechRequests[0]?.auth === 'Bearer tts-secret', String(speechRequests[0]?.auth))
}

console.log('-- 9. malformed requests are the only HTTP errors --')
{
  const unknown = await validate({ target: 'voices' })
  console.log(`  target=voices -> HTTP ${unknown.status} ${unknown.raw}`)
  check('unknown target is 400', unknown.status === 400 && unknown.json?.ok === false)
  checkCode('an unknown target is classified unsupported-target', unknown.json?.reasonCode, 'unsupported-target', 'POST /validate target=voices')
  check('the requested target is echoed for interpolation', unknown.json?.target === 'voices', JSON.stringify(unknown.json?.target))
  check('the error wording is unchanged', unknown.json?.error === 'target 只能是 check 或 tts', JSON.stringify(unknown.json?.error))
  check('detail is the server message, unchanged', unknown.json?.detail === unknown.json?.error)

  const broken = await validate('{"target":')
  console.log(`  invalid JSON -> HTTP ${broken.status} ${broken.raw}`)
  check('invalid JSON is 400', broken.status === 400 && broken.json?.ok === false)
  check('an unreadable body carries no reason code', broken.json?.reasonCode === undefined, JSON.stringify(broken.json?.reasonCode))
}

console.log('-- 10. autoValidate boolean survives the config round trip --')
{
  const post = await callRoute('/dsh-audio/config', { body: JSON.stringify({ check: { autoValidate: true } }) })
  const posted = post.json?.config?.check?.autoValidate
  console.log(`  POST /dsh-audio/config -> HTTP ${post.status} ok=${post.json?.ok} check.autoValidate=${JSON.stringify(posted)} (${typeof posted})`)
  check('config write accepted', post.status === 200 && post.json?.ok === true)
  check('write response keeps a boolean', posted === true && typeof posted === 'boolean', typeof posted)

  const get = await callRoute('/dsh-audio/config', { method: 'GET' })
  const value = get.json?.config?.check?.autoValidate
  console.log(`  GET /dsh-audio/config -> HTTP ${get.status} check.autoValidate=${JSON.stringify(value)} (${typeof value})`)
  console.log(`  GET check section: ${JSON.stringify(get.json?.config?.check)}`)
  check('GET returns the boolean, not a string', value === true && typeof value === 'boolean', `${JSON.stringify(value)} (${typeof value})`)
  check('the JSON does not quote it', /"autoValidate":true/.test(get.raw), get.raw.slice(0, 200))
  check('the stored key is still not echoed', get.json?.config?.check?.keySet === true && !get.raw.includes('check-secret'))
}

console.log('-- 10b. semantic check off: /config hides the row and nothing is sent --')
{
  const saved = { ...config.check }
  config.check = { ...saved, enabled: false }

  const get = await callRoute('/dsh-audio/config', { method: 'GET' })
  const view = get.json?.config?.check ?? {}
  console.log(`  GET /dsh-audio/config -> check=${JSON.stringify(view)}`)
  check('the disabled row reports enabled=false', view.enabled === false)
  check('the disabled row hides the endpoint', view.baseUrl === undefined, JSON.stringify(view.baseUrl))
  check('the disabled row hides the model', view.model === undefined, JSON.stringify(view.model))
  check('the disabled row hides the key facts', view.keySet === undefined && view.envName === undefined, JSON.stringify(view))
  check('the disabled row does not echo the saved key', !get.raw.includes('check-secret'))

  requests.length = 0
  const test = await callRoute('/dsh-audio/test', { body: JSON.stringify({ target: 'check' }) })
  const testBody = test.json ?? {}
  console.log(`  POST /dsh-audio/test -> HTTP ${test.status} ${test.raw}`)
  check('a disabled /test is data, not a server error', test.status === 200 && testBody.ok === false)
  checkCode('a disabled /test is classified semantic-disabled', testBody.reasonCode, 'semantic-disabled', 'POST /test target=check with check.enabled=false')
  check('a disabled /test says why in readable text', /语义检查未启用/.test(testBody.error ?? ''), testBody.error)
  check('the disabled /test names the target it skipped', testBody.target === 'check' && testBody.disabled === true, JSON.stringify(testBody.target))
  check('the disabled /test sent nothing', requests.length === 0,
    requests.map((entry) => `${entry.method} ${entry.url}`).join(' ; '))

  requests.length = 0
  const valid = await validate({ target: 'check' })
  const validBody = valid.json ?? {}
  console.log(`  POST /dsh-audio/validate -> HTTP ${valid.status} ${valid.raw}`)
  check('a disabled /validate answers 200 with a skip report', valid.status === 200 && validBody.ok === true && validBody.disabled === true)
  checkCode('a disabled /validate is classified semantic-disabled', validBody.reasonCode, 'semantic-disabled', 'POST /validate target=check with check.enabled=false')
  check('a disabled /validate probes nothing',
    validBody.endpoint?.reachable === null && validBody.endpoint?.reasonCode === 'semantic-disabled', JSON.stringify(validBody.endpoint))
  check('a disabled /validate accepts no audio', validBody.audioAccepted === false)
  check('the disabled /validate reason is readable', /语义检查未启用/.test(validBody.error ?? ''), validBody.error)
  check('the disabled /validate sent nothing', requests.length === 0,
    requests.map((entry) => `${entry.method} ${entry.url}`).join(' ; '))

  config.check = saved
}

console.log('-- 11. probeEndpoint on its own --')
{
  const reachable = await probeEndpoint(base, '', 2000)
  console.log(`  live server (404): reachable=${reachable.reachable} status=${reachable.status} error=${JSON.stringify(reachable.error)}`)
  check('a reachable server is reachable', reachable.reachable === true)
  check('its status is passed through untouched', reachable.status === 404, String(reachable.status))

  // A port that was listening a moment ago and is now free: the OS refuses at
  // once. (Port 1, used by the route test above, is a *fetch-spec "bad port"*
  // and is blocked before a socket opens, so it cannot show this branch.)
  const ephemeral = createServer((request, response) => { response.end() })
  await new Promise((resolve) => ephemeral.listen(0, '127.0.0.1', resolve))
  const closedPort = ephemeral.address().port
  await new Promise((resolve) => ephemeral.close(resolve))
  const refused = await probeEndpoint(`http://127.0.0.1:${closedPort}`, '', 2000)
  console.log(`  closed port ${closedPort}: reachable=${refused.reachable} status=${refused.status} error=${JSON.stringify(refused.error)}`)
  check('a closed port is unreachable', refused.reachable === false && refused.status === 0)
  check('the refused cause is kept', /ECONNREFUSED/.test(refused.error ?? ''), refused.error)

  const startedAt = Date.now()
  const timedOut = await probeEndpoint(silentBase, '', 150)
  const elapsed = Date.now() - startedAt
  console.log(`  silent server, 150 ms budget: reachable=${timedOut.reachable} status=${timedOut.status} error=${JSON.stringify(timedOut.error)} (measured ${elapsed} ms)`)
  check('a silent server reports a timeout', timedOut.reachable === false && timedOut.error === '超时 150 ms', JSON.stringify(timedOut.error))
  check('the timeout honours the budget', elapsed >= 140 && elapsed < 2000, `${elapsed} ms`)

  const invalid = await probeEndpoint('not a url', 'key', 100)
  console.log(`  invalid URL: reachable=${invalid.reachable} status=${invalid.status} error=${JSON.stringify(invalid.error)}`)
  check('an invalid URL never throws', invalid.reachable === false && invalid.status === 0)
  check('an invalid URL explains itself', typeof invalid.error === 'string' && invalid.error.length > 0, invalid.error)
}

console.log('-- 12. a missing key is classified missing-key --')
{
  const savedKey = config.check.apiKey
  const savedEnvName = config.check.apiKeyEnv
  const hadEnv = process.env.DASHSCOPE_API_KEY
  config.check.apiKey = ''
  config.check.apiKeyEnv = 'DASHSCOPE_API_KEY'
  delete process.env.DASHSCOPE_API_KEY
  const result = await validate({ target: 'check' })
  config.check.apiKey = savedKey
  config.check.apiKeyEnv = savedEnvName
  if (hadEnv !== undefined) process.env.DASHSCOPE_API_KEY = hadEnv
  const body = result.json ?? {}
  const chatRequests = requests.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions')
  console.log(`  HTTP ${result.status} ok=${body.ok} audioAccepted=${body.audioAccepted}`)
  console.log(`  endpoint reachable=${body.endpoint?.reachable} status=${body.endpoint?.status}`)
  console.log(`  reasonCode=${JSON.stringify(body.reasonCode)} envName=${JSON.stringify(body.envName)}`)
  console.log(`  error=${JSON.stringify(body.error)}`)
  check('a missing key is still HTTP 200 data', result.status === 200 && body.ok === true)
  // The reacher: reachability and key presence are different facts, and the page
  // shows both, so the probe must still have reported the endpoint.
  check('the endpoint is still probed and reachable', body.endpoint?.reachable === true && body.endpoint?.status === 404)
  check('no request was made without a key', !chatRequests.some((entry) => entry.auth !== null))
  checkCode('a missing key is classified missing-key', body.reasonCode, 'missing-key', 'check row without apiKey or env var')
  check('the env var name is exposed for interpolation', body.envName === 'DASHSCOPE_API_KEY', JSON.stringify(body.envName))
  check('the error text is unchanged (still names the env var)', /环境变量 DASHSCOPE_API_KEY 为空/.test(body.error ?? ''), body.error)
  check('detail keeps the full server message', body.detail === body.error)
  check('no answer is claimed', body.answer === undefined)
}

console.log('-- 13. an empty base URL is classified no-base-url --')
{
  const savedBaseUrl = config.tts.baseUrl
  config.tts.baseUrl = ''
  const result = await validate({ target: 'tts' })
  config.tts.baseUrl = savedBaseUrl
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} endpoint=${JSON.stringify(body.endpoint)}`)
  console.log(`  reasonCode=${JSON.stringify(body.reasonCode)} error=${JSON.stringify(body.error)}`)
  check('the endpoint row reports no reachable endpoint', body.endpoint?.reachable === false)
  checkCode('the endpoint row is no-base-url', body.endpoint?.reasonCode, 'no-base-url', 'tts row with baseUrl=""')
  check('its error wording is unchanged', body.endpoint?.error === '配置里没有 baseUrl', JSON.stringify(body.endpoint?.error))
  checkCode('the model call is no-base-url too', body.reasonCode, 'no-base-url', 'tts row with baseUrl="" (model call)')
  check('the reported baseUrl is the empty saved one', body.baseUrl === '', JSON.stringify(body.baseUrl))
}

console.log('-- 14. TTS switched off is classified provider-none --')
{
  const savedProvider = config.tts.provider
  config.tts.provider = 'none'
  const result = await validate({ target: 'tts' })
  config.tts.provider = savedProvider
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} endpoint=${JSON.stringify(body.endpoint)}`)
  console.log(`  reasonCode=${JSON.stringify(body.reasonCode)} error=${JSON.stringify(body.error)}`)
  check('nothing is probed for a disabled provider', body.endpoint?.reachable === null)
  checkCode('the endpoint row is provider-none', body.endpoint?.reasonCode, 'provider-none', 'tts provider=none')
  check('its error wording is unchanged', body.endpoint?.error === 'TTS 已关闭（provider = none），没有端点可探测', JSON.stringify(body.endpoint?.error))
  checkCode('the model call is provider-none', body.reasonCode, 'provider-none', 'tts provider=none (model call)')
}

console.log('-- 15. a provider 500 is classified http-5xx --')
{
  mode = 'server-error'
  const result = await validate({ target: 'check' })
  mode = 'ok'
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} endpoint.status=${body.endpoint?.status} reasonCode=${JSON.stringify(body.reasonCode)} status=${JSON.stringify(body.status)}`)
  console.log(`  error=${JSON.stringify(body.error)}`)
  check('the host answered, so the endpoint is reachable', body.endpoint?.reachable === true)
  checkCode('a provider 500 is classified http-5xx', body.reasonCode, 'http-5xx', 'mock provider answers 500')
  check('the provider status is exposed for interpolation', body.status === 500, String(body.status))
  check('the provider body is kept in the detail', /internal provider failure/.test(body.detail ?? ''), body.detail)
  check('the error keeps the status and the body', /HTTP 500/.test(body.error ?? '') && /internal provider failure/.test(body.error ?? ''), body.error)
}

console.log('-- 16. a 200 that is not audio is classified not-audio --')
{
  mode = 'html-200'
  const result = await validate({ target: 'tts' })
  mode = 'ok'
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} audioAccepted=${body.audioAccepted} reasonCode=${JSON.stringify(body.reasonCode)}`)
  console.log(`  error=${JSON.stringify(body.error)}`)
  check('the refusal is still HTTP 200 data', result.status === 200 && body.ok === true)
  check('audio is not accepted', body.audioAccepted === false)
  check('the endpoint still answered', body.endpoint?.reachable === true)
  checkCode('a non-audio 200 is classified not-audio', body.reasonCode, 'not-audio', 'mock provider answers HTML with 200')
  check('the error keeps the content-type the provider sent', /content-type/.test(body.error ?? ''), body.error)
  check('detail is the unchanged server message', body.detail === body.error)
}

console.log('-- 17. an unknown provider is classified unsupported-target --')
{
  const savedProvider = config.tts.provider
  const savedBaseUrl = config.tts.baseUrl
  config.tts.provider = 'nonsense'
  config.tts.baseUrl = base
  const result = await validate({ target: 'tts' })
  config.tts.provider = savedProvider
  config.tts.baseUrl = savedBaseUrl
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} baseUrl=${JSON.stringify(body.baseUrl)} reasonCode=${JSON.stringify(body.reasonCode)}`)
  console.log(`  error=${JSON.stringify(body.error)}`)
  check('the report still probes the saved URL', body.baseUrl === base, JSON.stringify(body.baseUrl))
  checkCode('an unknown provider is classified unsupported-target', body.reasonCode, 'unsupported-target', 'tts provider=nonsense')
  check('the provider error wording is unchanged', /未知的 TTS provider/.test(body.error ?? ''), body.error)
}

console.log('-- 18. classifyFailure: the codes a local provider cannot produce --')
{
  // Edge needs a live WebSocket handshake, so its failure modes are asserted on
  // the exported classifier rather than through the route. The other codes above
  // are all reached through a real handler call.
  const edgeFailure = (edgeCode, message) => Object.assign(new Error(message), { edgeCode })
  const cases = [
    ['decoder-missing', edgeFailure('undecodable', 'Edge TTS: 服务返回了音频，但没有可用的解码器'), { target: 'tts', provider: 'edge' }, 'classifyFailure(edgeCode=undecodable)'],
    ['not-audio', edgeFailure('decode', 'Edge TTS: ffmpeg 解码失败（ffmpeg.exe -1）'), { target: 'tts', provider: 'edge' }, 'classifyFailure(edgeCode=decode)'],
    ['endpoint-unreachable', edgeFailure('handshake', 'Edge TTS: 握手失败'), { target: 'tts', provider: 'edge' }, 'classifyFailure(edgeCode=handshake)'],
    ['provider-none', new Error('未知的 TTS provider "none"'), { target: 'tts', provider: 'none' }, 'classifyFailure(provider=none)'],
    ['missing-key', new Error('音频理解: 环境变量 DASHSCOPE_API_KEY 为空。'), { target: 'check', envName: 'DASHSCOPE_API_KEY', keyMissing: true }, 'classifyFailure(env var in message)'],
    ['no-base-url', new Error('配置里没有 baseUrl'), { target: 'tts' }, 'classifyFailure(no baseUrl message)'],
    ['missing-key', new Error('TTS: 没有配置密钥。给插件 config 加 apiKeyEnv（推荐）或 apiKey。'), { target: 'tts', envName: 'MINIMAX_API_KEY', keyMissing: true }, 'classifyFailure(no key at all message)'],
    ['unsupported-target', new Error('未知的 TTS provider "zzz"'), { target: 'tts', provider: 'zzz', unsupported: true }, 'classifyFailure(unsupported provider)']
  ]
  for (const [expected, error, context, proof] of cases) {
    const info = classifyFailure(error, context)
    console.log(`  ${expected.padEnd(22)} <- ${String(info.reasonCode).padEnd(22)} detail ${String(info.detail?.length ?? '?')} chars (${proof})`)
    checkCode(`${expected}: classified by its own fact`, info.reasonCode, expected, proof)
    check(`${expected}: detail is the original message`, info.detail === error.message, JSON.stringify(info.detail))
  }
  // An unrecognized failure keeps no code on purpose: a code the page cannot
  // translate would replace the provider's own words with a guess.
  const opaque = classifyFailure(new Error('MiniMax TTS 失败 (1004): invalid api key'), { target: 'tts', provider: 'minimax' })
  console.log(`  opaque provider error -> ${JSON.stringify(opaque)}`)
  check('an unrecognized provider failure gets no code', opaque.reasonCode === undefined, JSON.stringify(opaque.reasonCode))
  check('its message is still carried as detail', opaque.detail === 'MiniMax TTS 失败 (1004): invalid api key', JSON.stringify(opaque.detail))
}

console.log('-- 19. /dsh-audio/test carries the same reason codes --')
{
  const post = (body) => callRoute('/dsh-audio/test', { body: JSON.stringify(body ?? {}) })

  mode = 'unauthorized'
  const rejected = await post({ target: 'check' })
  mode = 'ok'
  const rejectedBody = rejected.json ?? {}
  console.log(`  rejected -> HTTP ${rejected.status} ok=${rejectedBody.ok} reasonCode=${JSON.stringify(rejectedBody.reasonCode)} status=${JSON.stringify(rejectedBody.status)}`)
  console.log(`  error=${JSON.stringify(rejectedBody.error)}`)
  check('a provider refusal is still an HTTP error for /test', rejected.status === 400 && rejectedBody.ok === false)
  checkCode('/test classifies a rejected key as http-4xx', rejectedBody.reasonCode, 'http-4xx', 'POST /test target=check, provider 401')
  check('/test exposes the provider status', rejectedBody.status === 401, String(rejectedBody.status))
  check('/test detail is the server message, unchanged', rejectedBody.detail === rejectedBody.error)
  check('/test names the target it failed on', rejectedBody.target === 'check', JSON.stringify(rejectedBody.target))

  const savedKey = config.check.apiKey
  const savedEnvName = config.check.apiKeyEnv
  const hadEnv = process.env.DASHSCOPE_API_KEY
  config.check.apiKey = ''
  config.check.apiKeyEnv = 'DASHSCOPE_API_KEY'
  delete process.env.DASHSCOPE_API_KEY
  const missing = await post({ target: 'check' })
  config.check.apiKey = savedKey
  config.check.apiKeyEnv = savedEnvName
  if (hadEnv !== undefined) process.env.DASHSCOPE_API_KEY = hadEnv
  const missingBody = missing.json ?? {}
  console.log(`  missing key -> HTTP ${missing.status} reasonCode=${JSON.stringify(missingBody.reasonCode)} envName=${JSON.stringify(missingBody.envName)}`)
  checkCode('/test classifies a missing key as missing-key', missingBody.reasonCode, 'missing-key', 'POST /test target=check, no key')
  check('/test exposes the env var name', missingBody.envName === 'DASHSCOPE_API_KEY', JSON.stringify(missingBody.envName))
  check('/test keeps the server error text', /环境变量 DASHSCOPE_API_KEY 为空/.test(missingBody.error ?? ''), missingBody.error)

  const okTest = await post({ target: 'tts' })
  const okBody = okTest.json ?? {}
  console.log(`  tts success -> HTTP ${okTest.status} ok=${okBody.ok} reasonCode=${JSON.stringify(okBody.reasonCode)} durationSeconds=${okBody.durationSeconds}`)
  check('a successful /test is unchanged', okTest.status === 200 && okBody.ok === true && typeof okBody.wavBase64 === 'string')
  check('a successful /test carries no reason code', okBody.reasonCode === undefined, JSON.stringify(okBody.reasonCode))

  const broken = await callRoute('/dsh-audio/test', { body: '{"target":' })
  check('a malformed /test body carries no reason code', broken.json?.reasonCode === undefined, JSON.stringify(broken.json?.reasonCode))
}

/* ---- reason code table ---- */

console.log('\n-- reason code table --')
for (const code of REASON_CODES) {
  const proof = observedCodes.get(code)
  console.log(`  ${code.padEnd(22)} ${proof === undefined ? 'MISSING ' : 'covered '} ${proof ?? ''}`)
}
check('every reason code is produced by a tested failure path', REASON_CODES.every((code) => observedCodes.has(code)),
  REASON_CODES.filter((code) => !observedCodes.has(code)).join(','))
check('no tested failure path invents an unknown code', [...observedCodes.keys()].every((code) => REASON_CODES.includes(code)),
  [...observedCodes.keys()].filter((code) => !REASON_CODES.includes(code)).join(','))

/* ----------------------------------------------------------------- done -- */

provider.closeAllConnections?.()
silent.closeAllConnections?.()
provider.close()
silent.close()

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(`reason codes: ${REASON_CODES.length} defined, ${observedCodes.size} covered by a tested failure path`)
console.log(failures === 0
  ? 'OK: self-check reports reachability, audio acceptance, latency and a translatable reason code (200 even on provider failure)'
  : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
