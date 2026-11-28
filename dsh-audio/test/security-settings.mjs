/**
 * Security regressions for the settings endpoints.
 *
 * The settings page is served by the DSH web carrier on the same origin as the
 * page, but "served here" is not "can only be called from here": any page the
 * user has open can POST to these routes, and the plugin holds an API key that
 * the routes send as a bearer. These tests therefore drive the *real registered
 * handlers* with an attacker-shaped request and assert on the wire, not on the
 * wording:
 *
 *  1. `/dsh-audio/voices` ignores the request body. This was a blocker: the
 *     handler merged `body.tts` into the saved row, so a cross-site request
 *     could aim the saved key at any host. A fake attacker server asserts it
 *     receives *no* request at all, and that the body is refused outright.
 *  2. Same-origin enforcement: POST requires `Sec-Fetch-Site: same-origin`;
 *     without that header the strict `Origin` (scheme + host + port) versus
 *     `Host` comparison decides, and `same-site` / a foreign Origin are 403.
 *     GET is not gated (it only exposes the redacted view).
 *  3. `apiKeyEnv` is a whitelist: naming an unrelated process variable (the way
 *     to read a secret the plugin was never given) is a 400 with a reasonCode.
 *  4. `baseUrl` must be `https:` and must not point at loopback, a private
 *     network or a link-local address — every one of those is a 400, and a value
 *     stored before the rule existed is presented as unconfigured.
 *  5. Saving settings preserves the keys the UI never shows (`format`,
 *     `subtitle`, `volume`, `timeoutMs`, `outputFormat`, `endpoint`,
 *     `voiceListUrl`, `decodeAudio` …) instead of silently deleting them.
 *  6. Request policy: a body over `MAX_BODY` is answered with 413 *before* the
 *     socket is destroyed, an upload that never finishes is aborted with 408,
 *     a non-JSON media type is 415, and malformed JSON is a plain 400.
 *
 * A local `node:http` server plays the attacker (only counts connections) and a
 * second one plays an OpenAI-compatible provider, so the self-check section can
 * prove the probe now presents the provider's own env var (OPENAI_API_KEY) and
 * not the MiniMax one.
 *
 * Run: node test/security-settings.mjs
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerSettingsRoute } from '../lib/settings-route.js'
import { encodeWav } from '../lib/wav.js'

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** A deterministic sine WAV, so the fake provider answers with real audio. */
function sineWav (seconds, sampleRate = 24000) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) samples[index] = Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.4
  return encodeWav([samples], sampleRate, { dither: false })
}

/* ------------------------------------------------------ attacker server -- */

// The attack this test reproduces is "make the host send the saved key to my
// machine". The server records every request it ever sees; the handler must
// never reach it.
const attackerRequests = []
const attacker = createServer((request, response) => {
  attackerRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null })
  request.resume()
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ system_voice: [{ voice_id: 'stolen', voice_name: 'stolen' }] }))
})
await new Promise((resolve) => attacker.listen(0, '127.0.0.1', resolve))
const attackerBase = `http://127.0.0.1:${attacker.address().port}`

/* --------------------------------------------------- provider double -- */

const providerRequests = []
const provider = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    providerRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null })
    if (request.method === 'GET') {
      // The reachability probe lands here; any status proves the host answered.
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('nothing on the base URL')
      return
    }
    if (request.url === '/v1/audio/speech') {
      response.writeHead(200, { 'Content-Type': 'audio/wav' })
      response.end(sineWav(0.4))
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('nope')
  })
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const providerBase = `http://127.0.0.1:${provider.address().port}`

/* --------------------------------------------------------- plugin mount -- */

// A saved row the settings page would have written before the tests run: a real
// key (must never be echoed or signed with), a valid public endpoint, and every
// key the UI does not show, so preservation can be asserted.
const revert = {
  tts: {
    provider: 'minimax',
    baseUrl: 'https://api.minimax.chat',
    model: 'speech-2.8-hd',
    voice: 'female-shaonv',
    speed: 1,
    pitch: 0,
    sampleRate: 32000,
    apiKey: 'saved-tts-secret',
    apiKeyEnv: 'MINIMAX_API_KEY',
    ffmpegPath: '',
    format: 'mp3',
    subtitle: false,
    subtitleType: 'word',
    volume: 0.8,
    timeoutMs: 5000,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    endpoint: 'wss://example.invalid/edge/v1',
    voiceListUrl: 'https://example.invalid/edge/voices',
    decodeAudio: () => ({ samples: new Float32Array(2), sampleRate: 24000 })
  },
  check: {
    provider: 'openai',
    baseUrl: 'https://api.example.com/compatible-mode',
    model: 'qwen2.5-omni-7b',
    apiKey: 'saved-check-secret',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    autoValidate: false
  }
}
const config = JSON.parse(JSON.stringify({ ...revert, tts: { ...revert.tts }, check: { ...revert.check } }))
config.tts.decodeAudio = revert.tts.decodeAudio

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
      // change to the same row is the in-process equivalent.
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

/**
 * A request double. `body` is emitted once; `onEnd`/`timeout` shapes let a test
 * reproduce an oversized upload and a client that never finishes. `events` and
 * `response.events` share one array so "reply before destroy" is observable.
 */
function makeRequest ({ method = 'POST', body, headers = {}, fireTimeout = false, events = [] } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }
  request.events = events
  request.destroyed = false
  request.paused = false
  request.timeouts = []
  request.destroy = () => {
    if (request.destroyed) return
    request.destroyed = true
    events.push('destroy')
  }
  request.pause = () => { request.paused = true }
  request.resume = () => { request.paused = false }
  request.setTimeout = (ms, callback) => {
    request.timeouts.push(ms)
    if (fireTimeout && typeof callback === 'function') process.nextTick(callback)
    return request
  }
  if (!fireTimeout) {
    process.nextTick(() => {
      if (body !== undefined) request.emit('data', Buffer.from(body))
      request.emit('end')
    })
  }
  return request
}

function makeResponse (events) {
  return {
    statusCode: null,
    headers: null,
    headersSent: false,
    payload: null,
    events,
    writeHead (status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
      this.events.push('writeHead')
    },
    end (body) {
      this.payload = String(body)
      this.events.push('end')
    }
  }
}

async function callRoute (path, options = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  const events = []
  const request = makeRequest({ ...options, events })
  const response = makeResponse(events)
  await route.handler(request, response)
  let json = null
  try { json = JSON.parse(response.payload) } catch { /* leave null */ }
  return { status: response.statusCode, headers: response.headers, json, raw: response.payload, request, response, events }
}

const postConfig = (body, options = {}) => callRoute('/dsh-audio/config', {
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  ...options
})
const postVoices = (body, options = {}) => callRoute('/dsh-audio/voices', {
  body: JSON.stringify(body ?? {}),
  ...options
})
const postValidate = (body, options = {}) => callRoute('/dsh-audio/validate', {
  body: JSON.stringify(body ?? {}),
  ...options
})

/** Put the saved rows back, so one section's write cannot leak into the next. */
function restoreConfig () {
  config.tts = { ...revert.tts }
  config.check = { ...revert.check }
}

/**
 * Run `run` with `fetch` replaced by a recorder that fails immediately.
 *
 * `/voices` is the one settings route whose whole job is an outbound call, so
 * the only honest way to assert *where* the lookup would have gone is to
 * intercept the request before it leaves the process. Real MiniMax/DashScope
 * hosts must not be contacted from a unit test: it would be slow, flaky and
 * would leak a throwaway key to a third party.
 * @param {(calls: {url: string, authorization: string|null}[]) => Promise<any>} run
 *   the body of the test, given the recorded call list.
 * @returns {Promise<any>} whatever `run` returns.
 */
async function withStubbedFetch (run) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options?.headers?.Authorization ?? null })
    throw new Error('offline test: fetch stubbed out')
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = real
  }
}

// The key the fake provider would receive must come from *this* variable, and a
// real MiniMax variable being set would make `/voices` reach the real network.
const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY
}
delete process.env.MINIMAX_API_KEY
delete process.env.DASHSCOPE_API_KEY

/* -------------------------------------------------------- 1. surface ---- */

console.log('-- 1. route surface --')
{
  for (const path of ['/dsh-audio/config', '/dsh-audio/test', '/dsh-audio/voices', '/dsh-audio/validate']) {
    check(`${path} is registered exactly`, routes.get(path)?.kind === 'exact', String(routes.get(path)?.kind))
  }
}

/* ------------------------------------- 2. /voices cannot be retargeted ---- */

console.log('-- 2. /voices reads the saved row only (blocker) --')
{
  attackerRequests.length = 0
  // No key configured: a provider lookup then stops at the key check, so this
  // section can never reach the network. (The stale-row case below installs an
  // inline key on purpose, with `fetch` stubbed so the destination is still
  // recorded without being contacted.)
  config.tts.apiKey = ''
  config.tts.apiKeyEnv = 'MINIMAX_API_KEY'

  const result = await postVoices({ tts: { baseUrl: attackerBase, provider: 'minimax', apiKey: 'injected-key' } })
  console.log(`  body override -> HTTP ${result.status} ${result.raw}`)
  console.log(`  attacker saw ${attackerRequests.length} request(s)`)
  check('a body that tries to override the saved row is refused', result.status === 400 && result.json?.ok === false, result.raw)
  check('the saved provider row was not changed by the body', config.tts.baseUrl === revert.tts.baseUrl, String(config.tts.baseUrl))
  check('the attacker server received nothing at all', attackerRequests.length === 0, JSON.stringify(attackerRequests))
  check('no saved key is echoed in the refusal', !result.raw.includes('saved-tts-secret') && !result.raw.includes('saved-check-secret'))

  // The Edge service URLs are overrides too: a body must not be able to point
  // the voice-list WebSocket/HTTP calls somewhere else either.
  const edgeOverride = await postVoices({ tts: { endpoint: 'ws://127.0.0.1:1/v1', voiceListUrl: attackerBase } })
  console.log(`  endpoint/voiceListUrl override -> HTTP ${edgeOverride.status}`)
  check('endpoint / voiceListUrl cannot be overridden from the body',
    edgeOverride.status === 400 && edgeOverride.json?.ok === false, edgeOverride.raw)
  check('the service URLs in the saved row were untouched',
    config.tts.endpoint === revert.tts.endpoint && config.tts.voiceListUrl === revert.tts.voiceListUrl,
    JSON.stringify({ endpoint: config.tts.endpoint, voiceListUrl: config.tts.voiceListUrl }))
  check('the service-URL attempt reached no attacker', attackerRequests.length === 0, JSON.stringify(attackerRequests))

  const empty = await postVoices({})
  console.log(`  empty body -> HTTP ${empty.status} source=${empty.json?.source} items=${empty.json?.items?.length}`)
  check('the page-shaped empty body is accepted', empty.status === 200 && empty.json?.ok === true)
  check('an empty body still reaches no attacker', attackerRequests.length === 0, JSON.stringify(attackerRequests))

  // The stale-row half of the same problem: a baseUrl persisted before the
  // endpoint checks existed must not receive the saved key either. This is the
  // case with a real key present, so it is the one worth intercepting.
  restoreConfig()
  config.tts.baseUrl = attackerBase
  config.tts.apiKey = 'old-saved-key'
  config.tts.apiKeyEnv = 'MINIMAX_API_KEY'
  attackerRequests.length = 0
  const stale = await withStubbedFetch(async (calls) => ({ response: await postVoices({}), calls }))
  const attempted = stale.calls.map((call) => call.url)
  console.log(`  stale saved baseUrl=${attackerBase} -> HTTP ${stale.response.status} source=${stale.response.json?.source}`)
  console.log(`  the lookup would have gone to: ${attempted.join(', ') || '(no request)'}`)
  check('the stale saved host is not used for the lookup', attempted.every((url) => !url.includes('127.0.0.1')),
    JSON.stringify(attempted))
  check('the lookup falls back to the provider default host',
    attempted.length === 1 && attempted[0] === 'https://api.minimax.chat/v1/get_voice', JSON.stringify(attempted))
  check('the saved key is not sent to a stale host',
    stale.calls.every((call) => !call.url.includes('127.0.0.1') || call.authorization === null), JSON.stringify(stale.calls))
  check('the attacker server received nothing from the stale row', attackerRequests.length === 0, JSON.stringify(attackerRequests))
  check('the response falls back to the static list', stale.response.status === 200 && stale.response.json?.source === 'static',
    stale.response.raw)
  restoreConfig()
}

/* ----------------------------------------------------- 3. same-origin ---- */

console.log('-- 3. same-origin enforcement --')
{
  // The one accepted POST below would otherwise run a provider lookup; with no
  // key it stops at the key check and stays offline.
  restoreConfig()
  config.tts.apiKey = ''

  const sameSite = await postVoices({}, { headers: { 'sec-fetch-site': 'same-site' } })
  console.log(`  Sec-Fetch-Site: same-site -> HTTP ${sameSite.status} ${sameSite.raw}`)
  check('same-site is not same-origin: 403', sameSite.status === 403 && sameSite.json?.ok === false, sameSite.raw)

  const crossSite = await postVoices({}, { headers: { 'sec-fetch-site': 'cross-site' } })
  console.log(`  Sec-Fetch-Site: cross-site -> HTTP ${crossSite.status}`)
  check('cross-site is 403', crossSite.status === 403 && crossSite.json?.ok === false, crossSite.raw)

  const noHeaderForeign = await postVoices({}, {
    headers: { 'sec-fetch-site': undefined, origin: 'http://127.0.0.1:9999', host: '127.0.0.1:50291' }
  })
  console.log(`  no Sec-Fetch-Site, foreign Origin -> HTTP ${noHeaderForeign.status} ${noHeaderForeign.raw}`)
  check('a foreign Origin is 403 when the header is missing', noHeaderForeign.status === 403 && noHeaderForeign.json?.ok === false, noHeaderForeign.raw)

  const noHeaderNoOrigin = await postVoices({}, { headers: { 'sec-fetch-site': undefined } })
  check('a missing Origin is refused, not trusted', noHeaderNoOrigin.status === 403, noHeaderNoOrigin.raw)

  const noHeaderSame = await postVoices({}, {
    headers: { 'sec-fetch-site': undefined, origin: 'http://127.0.0.1:50291', host: '127.0.0.1:50291' }
  })
  console.log(`  no Sec-Fetch-Site, matching Origin -> HTTP ${noHeaderSame.status}`)
  check('a matching Origin/Host pair passes the fallback', noHeaderSame.status === 200, noHeaderSame.raw)

  const getCrossSite = await callRoute('/dsh-audio/config', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  console.log(`  GET /config with Sec-Fetch-Site: cross-site -> HTTP ${getCrossSite.status}`)
  check('GET is not gated (it only reads the redacted view)', getCrossSite.status === 200 && getCrossSite.json?.ok === true)
  check('the GET view never contains a key', !getCrossSite.raw.includes('saved-tts-secret') && !getCrossSite.raw.includes('saved-check-secret'))
  restoreConfig()
}

/* ------------------------------------------------- 4. request policy ---- */

console.log('-- 4. content type, body limit, malformed JSON --')
{
  const noType = await postConfig({ tts: { voice: 'x' } }, { headers: { 'content-type': undefined } })
  console.log(`  no Content-Type -> HTTP ${noType.status} ${noType.raw}`)
  check('a POST without a media type is 415', noType.status === 415 && noType.json?.ok === false, noType.raw)
  check('the 415 error is readable', /application\/json/.test(noType.json?.error ?? ''), String(noType.json?.error))

  const textType = await postConfig({ tts: { voice: 'x' } }, { headers: { 'content-type': 'text/plain' } })
  check('a text body is 415', textType.status === 415, textType.raw)
  check('the 415 saved nothing', config.tts.voice === revert.tts.voice, String(config.tts.voice))

  const broken = await postConfig('{"tts":', {})
  console.log(`  invalid JSON -> HTTP ${broken.status} ${broken.raw}`)
  check('malformed JSON is 400', broken.status === 400 && broken.json?.ok === false, broken.raw)
  check('malformed JSON carries no provider reason code', broken.json?.reasonCode === undefined, JSON.stringify(broken.json?.reasonCode))

  const oversized = 'x'.repeat(80 * 1024)
  const big = await postConfig(oversized, {})
  console.log(`  ${oversized.length} B body -> HTTP ${big.status} headers=${JSON.stringify(big.headers)}`)
  console.log(`  handler events: ${big.events.join(' -> ')}`)
  check('an oversized body is 413', big.status === 413 && big.json?.ok === false, big.raw)
  check('the 413 asks for Connection: close', big.headers?.Connection === 'close', JSON.stringify(big.headers))
  check('the reply is written before the socket is destroyed',
    big.events.indexOf('end') !== -1 && big.events.indexOf('end') < big.events.indexOf('destroy'),
    big.events.join(' -> '))
  check('the oversized request really was destroyed', big.request.destroyed === true)

  const slow = await postConfig({ tts: { voice: 'x' } }, { fireTimeout: true })
  console.log(`  stalled upload (fake socket timeout) -> HTTP ${slow.status} ${slow.raw}`)
  check('a stalled upload is aborted', slow.status === 408 && slow.json?.ok === false, slow.raw)
  check('the abort uses a 10 s request timeout', slow.request.timeouts.includes(10_000), JSON.stringify(slow.request.timeouts))
  check('the stalled request was destroyed', slow.request.destroyed === true)
}

/* --------------------------------------------------- 5. apiKeyEnv ---- */

console.log('-- 5. apiKeyEnv whitelist --')
{
  restoreConfig()
  const foreign = await postConfig({ tts: { apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' } })
  console.log(`  apiKeyEnv=AWS_SECRET_ACCESS_KEY -> HTTP ${foreign.status} ${foreign.raw}`)
  check('an unrelated env variable is 400', foreign.status === 400 && foreign.json?.ok === false, foreign.raw)
  check('the refusal names the field', foreign.json?.field === 'apiKeyEnv', JSON.stringify(foreign.json?.field))
  check('the refusal carries a reasonCode', typeof foreign.json?.reasonCode === 'string' && foreign.json.reasonCode.length > 0,
    JSON.stringify(foreign.json?.reasonCode))
  check('the rejected write changed nothing', config.tts.apiKeyEnv === revert.tts.apiKeyEnv, String(config.tts.apiKeyEnv))

  const injected = await postConfig({ check: { apiKeyEnv: 'OPENAI_API_KEY' } })
  console.log(`  check.apiKeyEnv=OPENAI_API_KEY -> HTTP ${injected.status} check.apiKeyEnv=${config.check.apiKeyEnv}`)
  check('a whitelisted variable is accepted', injected.status === 200 && injected.json?.ok === true, injected.raw)
  check('the accepted value was persisted', config.check.apiKeyEnv === 'OPENAI_API_KEY', String(config.check.apiKeyEnv))

  // A saved row written before the whitelist existed must be read as if the
  // field were unset: no arbitrary process variable is consulted.
  restoreConfig()
  config.check.apiKeyEnv = 'AWS_SECRET_ACCESS_KEY'
  const view = await callRoute('/dsh-audio/config', { method: 'GET' })
  console.log(`  stored apiKeyEnv=AWS_SECRET_ACCESS_KEY -> GET envName=${JSON.stringify(view.json?.config?.check?.envName)}`)
  check('a stored non-whitelisted env name falls back to the provider default',
    view.json?.config?.check?.envName === 'DASHSCOPE_API_KEY', JSON.stringify(view.json?.config?.check?.envName))
  restoreConfig()
}

/* ------------------------------------------------------- 6. baseUrl ---- */

console.log('-- 6. baseUrl scheme and address rules --')
{
  const rejected = [
    ['http://127.0.0.1:1', 'loopback over http'],
    ['http://example.com', 'plain http'],
    ['https://127.0.0.1', 'https loopback'],
    ['https://10.1.2.3', '10/8'],
    ['https://172.20.0.1', '172.16/12'],
    ['https://192.168.1.5', '192.168/16'],
    ['https://169.254.0.1', 'link-local IPv4'],
    ['https://[::1]', 'IPv6 loopback'],
    ['https://[fc00::1]', 'unique-local IPv6'],
    ['https://[fe80::1]', 'IPv6 link-local'],
    ['https://[febf::1]', 'IPv6 link-local (range end)'],
    ['https://[fdff::1]', 'unique-local IPv6 (range end)'],
    // `URL` canonicalises these spellings of 127.0.0.1 before the check sees
    // them; the assertions prove the canonical form is what is classified.
    ['https://[::ffff:127.0.0.1]', 'IPv4-mapped IPv6 loopback'],
    ['https://2130706433', 'decimal loopback'],
    ['https://0x7f.1', 'hex-shorthand loopback'],
    ['https://127.0.0.1.', 'trailing-dot loopback'],
    ['https://localhost', 'localhost name'],
    ['not a url', 'malformed URL']
  ]
  for (const [value, label] of rejected) {
    restoreConfig()
    const result = await postConfig({ check: { baseUrl: value } })
    console.log(`  ${value.padEnd(24)} (${label}) -> HTTP ${result.status} ${JSON.stringify(result.json?.reasonCode)}`)
    check(`${label} is 400`, result.status === 400 && result.json?.ok === false, result.raw)
    check(`${label} is not persisted`, config.check.baseUrl === revert.check.baseUrl, String(config.check.baseUrl))
    check(`${label} carries a reasonCode`, typeof result.json?.reasonCode === 'string', JSON.stringify(result.json?.reasonCode))
  }

  restoreConfig()
  const publicUrl = await postConfig({ check: { baseUrl: 'https://api.example.com/v1' } })
  console.log(`  https://api.example.com/v1 -> HTTP ${publicUrl.status} stored=${config.check.baseUrl}`)
  check('a public https endpoint is accepted', publicUrl.status === 200 && config.check.baseUrl === 'https://api.example.com/v1', publicUrl.raw)

  const cleared = await postConfig({ check: { baseUrl: '' } })
  check('clearing the endpoint is allowed', cleared.status === 200 && config.check.baseUrl === '', cleared.raw)

  // A value saved before the rule existed is shown as unconfigured, not echoed.
  restoreConfig()
  config.check.baseUrl = 'http://169.254.169.254/latest/meta-data'
  const view = await callRoute('/dsh-audio/config', { method: 'GET' })
  console.log(`  stored private baseUrl -> GET check.baseUrl=${JSON.stringify(view.json?.config?.check?.baseUrl)}`)
  check('a stored invalid baseUrl is presented as unconfigured', view.json?.config?.check?.baseUrl === undefined,
    JSON.stringify(view.json?.config?.check?.baseUrl))
  check('the page still loads with that row', view.status === 200 && view.json?.ok === true)
  restoreConfig()
}

/* --------------------------------------------------- 7. ffmpegPath ---- */

console.log('-- 7. ffmpegPath may only pin a trusted binary --')
{
  restoreConfig()
  const arbitrary = await postConfig({ tts: { ffmpegPath: 'C:\\Windows\\System32\\cmd.exe' } })
  console.log(`  arbitrary path -> HTTP ${arbitrary.status} stored=${JSON.stringify(config.tts.ffmpegPath)}`)
  check('an arbitrary executable path is ignored, not stored', arbitrary.status === 200 && config.tts.ffmpegPath === '', arbitrary.raw)
  check('the ignored value is not echoed as configured', !String(arbitrary.json?.config?.tts?.ffmpegPath ?? '').includes('cmd.exe'),
    String(arbitrary.json?.config?.tts?.ffmpegPath))
  check('an ignored pin leaves the row on auto-detection', arbitrary.json?.config?.tts?.ffmpegPath === '',
    JSON.stringify(arbitrary.json?.config?.tts?.ffmpegPath))

  const bundled = join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const pinned = await postConfig({ tts: { ffmpegPath: bundled } })
  console.log(`  bundled path -> HTTP ${pinned.status} stored=${JSON.stringify(config.tts.ffmpegPath)}`)
  check('a binary inside DSH tools is accepted', pinned.status === 200 && config.tts.ffmpegPath === bundled, pinned.raw)

  const traversal = await postConfig({ tts: { ffmpegPath: '..\\..\\..\\Windows\\System32\\cmd.exe' } })
  console.log(`  traversal path -> HTTP ${traversal.status} stored=${JSON.stringify(config.tts.ffmpegPath)}`)
  check('a path escaping the tools directory is ignored', traversal.status === 200 && config.tts.ffmpegPath === '', traversal.raw)
  restoreConfig()
}

/* --------------------------------------------- 8. field preservation ---- */

console.log('-- 8. saving keeps the keys the UI does not show --')
{
  restoreConfig()
  const before = { ...config.tts }
  const result = await postConfig({ tts: { voice: 'male-qn-qingse', speed: 1.1 } })
  console.log(`  POST -> HTTP ${result.status} · stored keys: ${Object.keys(config.tts).join(', ')}`)
  check('the submitted fields are applied', result.status === 200 && config.tts.voice === 'male-qn-qingse' && config.tts.speed === 1.1, result.raw)

  const mustSurvive = ['format', 'subtitle', 'subtitleType', 'volume', 'timeoutMs', 'outputFormat', 'endpoint', 'voiceListUrl']
  for (const key of mustSurvive) {
    check(`tts.${key} survives the write`, JSON.stringify(config.tts[key]) === JSON.stringify(before[key]),
      `${JSON.stringify(config.tts[key])} vs ${JSON.stringify(before[key])}`)
  }
  check('tts.decodeAudio survives the write', typeof config.tts.decodeAudio === 'function')
  check('the stored key survives the write', config.tts.apiKey === 'saved-tts-secret', String(config.tts.apiKey))
  check('the stored check row is untouched', JSON.stringify(config.check) === JSON.stringify(revert.check), JSON.stringify(config.check))
  check('the response config still hides the key', result.json?.config?.tts?.keySet === true && !result.raw.includes('saved-tts-secret'))

  const checkOnly = await postConfig({ check: { model: 'another-model' } })
  check('a check-only patch keeps the tts row byte-identical',
    checkOnly.status === 200 && config.tts.voice === 'male-qn-qingse' && config.tts.format === 'mp3',
    JSON.stringify(config.tts))
  restoreConfig()
}

/* --------------------------------- 9. the probe uses the provider env ---- */

console.log('-- 9. the self-check probe presents the provider default env var --')
{
  config.tts = {
    provider: 'openai',
    baseUrl: providerBase,
    model: 'tts-1',
    voice: 'alloy',
    speed: 1,
    sampleRate: 24000,
    apiKey: '',
    apiKeyEnv: ''
  }
  config.check = { provider: 'openai', baseUrl: '', model: 'qwen', apiKey: '', apiKeyEnv: '' }
  process.env.OPENAI_API_KEY = 'openai-probe-key'
  delete process.env.MINIMAX_API_KEY

  providerRequests.length = 0
  const result = await postValidate({ target: 'tts' })
  const probe = providerRequests.find((entry) => entry.method === 'GET') ?? null
  const speech = providerRequests.find((entry) => entry.url === '/v1/audio/speech') ?? null
  console.log(`  /validate tts -> HTTP ${result.status} audioAccepted=${result.json?.audioAccepted} baseUrl=${result.json?.baseUrl}`)
  console.log(`  probe: ${probe?.method} ${probe?.url} auth=${probe?.authorization}`)
  console.log(`  speech: ${speech?.method} ${speech?.url} auth=${speech?.authorization}`)
  check('the self-check still probes the saved endpoint', probe !== null && probe.url === '/', JSON.stringify(probe))
  check('the probe uses the provider default env (OPENAI_API_KEY), not MiniMax', probe?.authorization === 'Bearer openai-probe-key',
    String(probe?.authorization))
  check('the real speech call uses the same key', speech?.authorization === 'Bearer openai-probe-key', String(speech?.authorization))
  check('the saved row was not modified by the check', config.tts.baseUrl === providerBase && config.tts.provider === 'openai')
  restoreConfig()
}

/* ---------------------------------------------------------------- done -- */

// Environment hygiene: the guards above delete variables to keep provider calls
// offline; put back whatever the machine had.
for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

attacker.closeAllConnections?.()
provider.closeAllConnections?.()
attacker.close()
provider.close()

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0
  ? 'OK: settings endpoints are same-origin only, cannot be retargeted, validate dangerous config values and keep hidden keys'
  : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
