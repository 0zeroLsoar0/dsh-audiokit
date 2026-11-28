/**
 * Real-transport tests for the optional external audio-generation backend.
 *
 * A local `node:http` server stands in for the upstream service, so every case
 * crosses a real socket: the request body and Authorization header are asserted
 * on the server side, the response body and failure classification on the
 * client side. The fake can switch behaviour between requests (binary wav,
 * base64 JSON, HTML 200, oversized, chunked oversized, 4xx/5xx, silent), which
 * covers the whole guard set in `lib/providers-generate.js` without a network.
 *
 * Checked, in order:
 *  1. `resolveGenerateConfig`: defaults, env fallbacks, config precedence,
 *     provider none / unknown, apiKeyEnv "" disabling the fallback, clamps.
 *  2. `generateAudio` happy path over HTTP: request shape and auth for both
 *     providers, exact bytes back, header measurements, deterministic=false.
 *  3. base64 JSON variants (`data[0].b64_json`, `audio_base64`, data URI,
 *     JSON mislabelled as octet-stream).
 *  4. Rejections: 200 text/html, JSON without audio, non-wav bytes, empty body.
 *  5. Size ceiling by Content-Length and by chunked streaming.
 *  6. HTTP 404 / 500 classification with the status preserved.
 *  7. Timeout: a fake that never answers fails inside the configured timeout.
 *  8. Missing configuration: no key / no endpoint / disabled / unknown provider,
 *     each refused before any request reaches the server.
 *  9. `saveGeneratedAudio`: content-hash default name, dedupe, explicit path,
 *     extension normalisation, and a decodeWav round-trip of what was written.
 * 10. `audio_generate` tool layer: schema size, happy path, overrides, default
 *     path, argument validation (before the network), offline registries, and a
 *     remote 404 surfaced as a readable coded error.
 * 11. `classifyGenerateFailure` fallbacks for errors that arrive without a code.
 *
 * Run: node test/generate.mjs
 *
 * What this cannot prove: that a real Stable Audio / AudioGen / vendor endpoint
 * uses these exact paths and field names. That needs one call with a real key
 * and a real service; the two shapes here are the documented contract.
 */

import { createHash } from 'node:crypto'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeWav, encodeWav } from '../lib/wav.js'
import {
  GENERATE_PROVIDERS,
  classifyGenerateFailure,
  generateAudio,
  inspectWavHeader,
  resolveGenerateConfig,
  saveGeneratedAudio
} from '../lib/providers-generate.js'
import { registerGenerateTools } from '../lib/tools-generate.js'

/* ---- harness ---- */

const fakes = []
let workdir = null
let failures = 0
let checks = 0

/** Start a fake and remember it so `main` can close every server in `finally`. */
async function fakeUp () {
  const fake = await startFake()
  fakes.push(fake)
  return fake
}

/** Record one assertion and print its measured detail either way. */
function check (label, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}${detail === '' ? '' : ` (${detail})`}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  return false
}

/** Run a promise-returning function and return its error instead of throwing. */
async function caught (run) {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

const fixed = (value, digits = 3) => Number(value).toFixed(digits)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/* ---- fixture audio ---- */

const CLIP_SECONDS = 0.2
const CLIP_RATE = 44100

function tone (seconds, sampleRate, hz = 330, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * hz * index / sampleRate) * amplitude
  }
  return samples
}

const CLIP = {
  seconds: CLIP_SECONDS,
  sampleRate: CLIP_RATE,
  frames: Math.round(CLIP_SECONDS * CLIP_RATE),
  bytes: encodeWav([tone(CLIP_SECONDS, CLIP_RATE)], CLIP_RATE)
}

/* ---- fake generation endpoint ---- */

const BEHAVIORS = Object.freeze([
  'wav',
  'b64-array',
  'b64-top',
  'b64-datauri',
  'b64-mislabeled',
  'html',
  'json-error',
  'not-wav',
  'empty',
  'oversize',
  'oversize-chunked',
  'http-404',
  'http-500',
  'silent'
])

function sendBytes (response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length)
  })
  response.end(body)
}

function sendJson (response, status, payload) {
  return sendBytes(response, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(payload), 'utf8'))
}

function b64Payload () {
  return { created: 0, data: [{ b64_json: CLIP.bytes.toString('base64'), revised_prompt: 'ignored' }] }
}

/** One request: record it, then answer according to the current behaviour. */
async function handle (fake, request, response) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  let json = null
  try {
    json = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null
  } catch {
    json = null
  }
  fake.requests.push({
    method: request.method,
    path: request.url,
    headers: { ...request.headers },
    bodySize: raw.length,
    json
  })

  // A client that aborts mid-read is expected in the size-limit tests; without
  // this listener Node would surface the EPIPE as an unhandled 'error'.
  response.on('error', () => {})

  const behavior = fake.behavior
  if (behavior === 'silent') {
    fake.pending.add(response)
    response.on('close', () => fake.pending.delete(response))
    return
  }
  if (behavior === 'html') {
    return sendBytes(response, 200, 'text/html; charset=utf-8',
      Buffer.from('<html><body>upstream login required, not audio</body></html>', 'utf8'))
  }
  if (behavior === 'json-error') return sendJson(response, 200, { error: { message: 'prompt rejected by moderator' } })
  if (behavior === 'b64-array') return sendJson(response, 200, b64Payload())
  if (behavior === 'b64-top') return sendJson(response, 200, { audio_base64: CLIP.bytes.toString('base64') })
  if (behavior === 'b64-datauri') {
    return sendJson(response, 200, { data: [{ b64_json: `data:audio/wav;base64,${CLIP.bytes.toString('base64')}` }] })
  }
  if (behavior === 'b64-mislabeled') {
    return sendBytes(response, 200, 'application/octet-stream', Buffer.from(JSON.stringify(b64Payload()), 'utf8'))
  }
  if (behavior === 'not-wav') {
    return sendBytes(response, 200, 'audio/mpeg', Buffer.from('ID3\u0004 this is an mp3 payload, not a wav file', 'utf8'))
  }
  if (behavior === 'empty') return sendBytes(response, 200, 'audio/wav', Buffer.alloc(0))
  if (behavior === 'oversize') return sendBytes(response, 200, 'audio/wav', Buffer.alloc(64 * 1024))
  if (behavior === 'oversize-chunked') {
    response.writeHead(200, { 'Content-Type': 'audio/wav' })
    for (let index = 0; index < 16; index += 1) response.write(Buffer.alloc(8 * 1024))
    return response.end()
  }
  if (behavior === 'http-404') return sendJson(response, 404, { error: { message: 'model not found', code: 'model_not_found' } })
  if (behavior === 'http-500') return sendJson(response, 500, { error: { message: 'internal server error' } })
  return sendBytes(response, 200, 'audio/wav', CLIP.bytes)
}

/**
 * Start a loopback fake generation service.
 * @returns {Promise<object>} mutable `behavior`, `requests`, `errors`, `url`,
 *   `host`, `setBehavior(name)` and idempotent `close()`.
 */
async function startFake () {
  const fake = {
    behavior: 'wav',
    requests: [],
    errors: [],
    sockets: new Set(),
    pending: new Set(),
    closed: false
  }
  const server = createServer((request, response) => {
    handle(fake, request, response).catch((error) => {
      // A client aborting mid-request is part of the size tests, not a crash.
      if (!/aborted|ECONNRESET|EPIPE|write after end/i.test(String(error?.message ?? error))) {
        fake.errors.push(error)
      }
      try { response.destroy() } catch { /* already gone */ }
    })
  })
  fake.server = server
  server.on('connection', (socket) => {
    fake.sockets.add(socket)
    socket.on('close', () => fake.sockets.delete(socket))
    socket.on('error', () => { /* killed client */ })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  fake.port = server.address().port
  fake.host = `127.0.0.1:${fake.port}`
  fake.url = `http://${fake.host}`
  fake.setBehavior = (behavior) => {
    if (!BEHAVIORS.includes(behavior)) throw new Error(`fake: unknown behavior "${behavior}"`)
    fake.behavior = behavior
    return fake
  }
  fake.close = async () => {
    if (fake.closed) return
    fake.closed = true
    for (const response of fake.pending) {
      try { response.destroy() } catch { /* already closed */ }
    }
    fake.pending.clear()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    for (const socket of fake.sockets) {
      try { socket.destroy() } catch { /* already closed */ }
    }
    fake.sockets.clear()
    await new Promise((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    })
  }
  return fake
}

/* ---- 1. configuration resolution ---- */

function resolutionSection () {
  console.log('-- 1. resolveGenerateConfig: defaults, env, precedence --')
  const env = { AUDIO_GENERATE_API_KEY: 'env-key', AUDIO_GENERATE_BASE_URL: 'http://gen.example/' }

  const fromEnv = resolveGenerateConfig({}, env)
  check('env: provider defaults to openai-audio', fromEnv.provider === 'openai-audio', fromEnv.provider)
  check('env: baseUrl from AUDIO_GENERATE_BASE_URL, trailing slash trimmed',
    fromEnv.baseUrl === 'http://gen.example', fromEnv.baseUrl)
  check('env: key from AUDIO_GENERATE_API_KEY', fromEnv.apiKey === 'env-key', fromEnv.apiKey)
  check('env: apiKeyEnv names the documented variable',
    fromEnv.apiKeyEnv === 'AUDIO_GENERATE_API_KEY', fromEnv.apiKeyEnv)
  check('defaults: timeout 120000 ms and 32 MB ceiling',
    fromEnv.timeoutMs === 120000 && fromEnv.maxBytes === 32 * 1024 * 1024,
    `${fromEnv.timeoutMs} ms / ${fromEnv.maxBytes} B`)
  check('env: configured true, no missing fields', fromEnv.configured === true && fromEnv.missing.length === 0,
    JSON.stringify(fromEnv.missing))

  const unset = resolveGenerateConfig({}, {})
  check('unset: configured false, enabled true (provider not none)',
    unset.configured === false && unset.enabled === true, `configured ${unset.configured}`)
  check('unset: missing names baseUrl and apiKey',
    unset.missing.join(',') === 'baseUrl,apiKey', unset.missing.join(','))

  const configWins = resolveGenerateConfig({
    generate: {
      provider: 'CUSTOM',
      baseUrl: 'http://cfg.example/gen/',
      apiKey: 'cfg-key',
      model: 'acme-audio-1',
      timeoutMs: '5000',
      maxBytes: '4096',
      apiKeyEnv: 'CUSTOM_KEY'
    }
  }, { ...env, CUSTOM_KEY: 'env-custom' })
  check('config: provider is lowercased', configWins.provider === 'custom', configWins.provider)
  check('config: baseUrl wins and is trimmed', configWins.baseUrl === 'http://cfg.example/gen', configWins.baseUrl)
  check('config: inline key wins over the environment', configWins.apiKey === 'cfg-key', configWins.apiKey)
  check('config: model, timeout and maxBytes are applied',
    configWins.model === 'acme-audio-1' && configWins.timeoutMs === 5000 && configWins.maxBytes === 4096,
    `${configWins.model} / ${configWins.timeoutMs} ms / ${configWins.maxBytes} B`)
  check('config: fully configured', configWins.configured === true, JSON.stringify(configWins.missing))

  const disabled = resolveGenerateConfig({ generate: { provider: 'none' } }, env)
  check('none: enabled false, configured false, missing empty',
    disabled.enabled === false && disabled.configured === false && disabled.missing.length === 0,
    `enabled ${disabled.enabled}`)

  const unknown = resolveGenerateConfig({ generate: { provider: 'replicate', baseUrl: 'http://x', apiKey: 'k' } }, {})
  check('unknown provider is flagged, not thrown',
    unknown.unsupported === true && unknown.configured === false, `unsupported ${unknown.unsupported}`)

  const noFallback = resolveGenerateConfig({ generate: { baseUrl: 'http://x', apiKeyEnv: '' } }, env)
  check('apiKeyEnv "" disables the environment fallback',
    noFallback.apiKey === '' && noFallback.missing.includes('apiKey'), `key "${noFallback.apiKey}"`)

  const namedEnv = resolveGenerateConfig({ generate: { baseUrl: 'http://x', apiKeyEnv: 'MY_GEN_KEY' } }, { MY_GEN_KEY: 'mk' })
  check('a custom apiKeyEnv name is read', namedEnv.apiKey === 'mk', namedEnv.apiKey)

  const clamped = resolveGenerateConfig({ generate: { baseUrl: 'http://x', apiKey: 'k', timeoutMs: 1, maxBytes: 1 } }, {})
  check('timeout and maxBytes are clamped to sane floors',
    clamped.timeoutMs === 100 && clamped.maxBytes === 1024, `${clamped.timeoutMs} ms / ${clamped.maxBytes} B`)
}

/* ---- 2. binary wav over HTTP ---- */

async function binarySection (fake) {
  console.log('-- 2. generateAudio: binary wav, both providers --')
  fake.setBehavior('wav')
  const resolved = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'gen-secret', model: 'stable-audio-open-1.0', apiKeyEnv: '' }
  })
  const result = await generateAudio(resolved, { prompt: 'rain on a tin roof', duration: 3 })
  const sent = fake.requests.at(-1)

  check('openai-audio: one POST to /v1/audio/generations',
    sent?.method === 'POST' && sent?.path === '/v1/audio/generations', `${sent?.method} ${sent?.path}`)
  check('openai-audio: Authorization is Bearer <key>',
    sent?.headers.authorization === 'Bearer gen-secret', String(sent?.headers.authorization))
  check('openai-audio: Content-Type is application/json',
    sent?.headers['content-type'] === 'application/json', String(sent?.headers['content-type']))
  check('openai-audio: body carries model/prompt/duration/response_format',
    sent?.json?.model === 'stable-audio-open-1.0' &&
    sent?.json?.prompt === 'rain on a tin roof' &&
    sent?.json?.duration === 3 &&
    sent?.json?.response_format === 'wav',
    JSON.stringify({ model: sent?.json?.model, duration: sent?.json?.duration, format: sent?.json?.response_format }))
  check('openai-audio: body has no extra keys',
    JSON.stringify(Object.keys(sent?.json ?? {}).sort()) === JSON.stringify(['duration', 'model', 'prompt', 'response_format']),
    Object.keys(sent?.json ?? {}).join(','))
  check('openai-audio: bytes are exactly what the service returned',
    Buffer.compare(result.bytes, CLIP.bytes) === 0, `${result.bytes.length} B vs fake ${CLIP.bytes.length} B`)
  check('openai-audio: header measurements match the clip',
    result.sampleRate === CLIP_RATE && result.channels === 1 && result.bitDepth === 16 &&
    Math.abs(result.durationSeconds - CLIP_SECONDS) < 1e-9,
    `${result.sampleRate} Hz · ${result.channels} ch · ${result.bitDepth}-bit · ${fixed(result.durationSeconds)} s`)
  check('openai-audio: response status and type are reported',
    result.httpStatus === 200 && result.contentType === 'audio/wav',
    `HTTP ${result.httpStatus} · ${result.contentType}`)
  check('openai-audio: effective says deterministic=false',
    result.effective.deterministic === false && result.effective.remote === true,
    JSON.stringify({ deterministic: result.effective.deterministic, remote: result.effective.remote }))
  check('openai-audio: effective names provider/host/model',
    result.effective.provider === 'openai-audio' && result.effective.host === fake.host &&
    result.effective.model === 'stable-audio-open-1.0',
    `${result.effective.provider} / ${result.effective.host} / ${result.effective.model}`)

  const custom = resolveGenerateConfig({
    generate: { provider: 'custom', baseUrl: `${fake.url}/my/generate`, apiKey: 'custom-key', apiKeyEnv: '' }
  })
  const customResult = await generateAudio(custom, { prompt: 'a wooden door closes', duration: 1 })
  const customSent = fake.requests.at(-1)
  check('custom: posts to the configured endpoint verbatim',
    customSent?.path === '/my/generate', customSent?.path)
  check('custom: sends its own key',
    customSent?.headers.authorization === 'Bearer custom-key', String(customSent?.headers.authorization))
  check('custom: model is omitted when not configured',
    customSent?.json?.model === undefined && !('model' in (customSent?.json ?? {})),
    JSON.stringify(customSent?.json ?? {}))
  check('custom: audio comes back and decodes',
    Buffer.compare(customResult.bytes, CLIP.bytes) === 0 &&
    customResult.effective.provider === 'custom' && customResult.effective.model === null,
    `${customResult.bytes.length} B · ${customResult.effective.provider}`)

  const rawConfigResult = await generateAudio(
    { generate: { baseUrl: fake.url, apiKey: 'raw-key', apiKeyEnv: '' } },
    { prompt: 'resolved lazily', duration: 1 }
  )
  check('generateAudio accepts the raw plugin config too',
    rawConfigResult.effective.provider === 'openai-audio' && rawConfigResult.bytes.length === CLIP.bytes.length,
    `${rawConfigResult.bytes.length} B`)
}

/* ---- 3. base64 JSON responses ---- */

async function base64Section (fake) {
  console.log('-- 3. generateAudio: base64 JSON response shapes --')
  const resolved = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', model: 'm', apiKeyEnv: '' }
  })

  fake.setBehavior('b64-array')
  let result = await generateAudio(resolved, { prompt: 'birds at dawn', duration: 2 })
  check('data[0].b64_json decodes to the same bytes',
    Buffer.compare(result.bytes, CLIP.bytes) === 0, `${result.bytes.length} B`)
  check('JSON response keeps the parsed clip measurements',
    result.sampleRate === CLIP_RATE && Math.abs(result.durationSeconds - CLIP_SECONDS) < 1e-9,
    `${result.sampleRate} Hz · ${fixed(result.durationSeconds)} s`)
  check('JSON response reports its content-type',
    result.contentType === 'application/json; charset=utf-8', result.contentType)

  fake.setBehavior('b64-top')
  result = await generateAudio(resolved, { prompt: 'a bell', duration: 2 })
  check('audio_base64 decodes', Buffer.compare(result.bytes, CLIP.bytes) === 0, `${result.bytes.length} B`)

  fake.setBehavior('b64-datauri')
  result = await generateAudio(resolved, { prompt: 'a gong', duration: 2 })
  check('a data: URI prefix is stripped before decoding',
    Buffer.compare(result.bytes, CLIP.bytes) === 0, `${result.bytes.length} B`)

  fake.setBehavior('b64-mislabeled')
  result = await generateAudio(resolved, { prompt: 'mislabeled json', duration: 2 })
  check('JSON with an octet-stream content-type is recognised by its first byte',
    result.contentType === 'application/octet-stream' && Buffer.compare(result.bytes, CLIP.bytes) === 0,
    `${result.contentType} · ${result.bytes.length} B`)
}

/* ---- 4. bad 2xx responses ---- */

async function rejectionSection (fake) {
  console.log('-- 4. generateAudio: a 2xx that is not usable audio --')
  const resolved = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', apiKeyEnv: '' }
  })

  fake.setBehavior('html')
  const html = await caught(() => generateAudio(resolved, { prompt: 'html trap', duration: 1 }))
  check('200 text/html is rejected', html !== null, 'no error thrown')
  check('html rejection is coded bad-response', html?.reasonCode === 'bad-response', String(html?.reasonCode))
  check('html rejection names the content-type', /text\/html/.test(html?.message ?? ''), html?.message)
  check('html rejection carries a body snippet', /login required/.test(html?.message ?? ''), html?.message)

  fake.setBehavior('json-error')
  const jsonError = await caught(() => generateAudio(resolved, { prompt: 'rejected', duration: 1 }))
  check('JSON without an audio field is bad-response', jsonError?.reasonCode === 'bad-response', String(jsonError?.reasonCode))
  check('JSON error names the accepted fields', /b64_json|audio_base64/.test(jsonError?.message ?? ''), jsonError?.message)
  check('JSON error quotes the provider message', /prompt rejected by moderator/.test(jsonError?.message ?? ''), jsonError?.message)

  fake.setBehavior('not-wav')
  const mp3 = await caught(() => generateAudio(resolved, { prompt: 'mp3', duration: 1 }))
  check('non-wav bytes are rejected as not-wav', mp3?.reasonCode === 'not-wav', String(mp3?.reasonCode))
  check('that error names the mp3 hint', /mp3/.test(mp3?.message ?? ''), mp3?.message)

  fake.setBehavior('empty')
  const empty = await caught(() => generateAudio(resolved, { prompt: 'empty', duration: 1 }))
  check('an empty 200 body is bad-response', empty?.reasonCode === 'bad-response', String(empty?.reasonCode))
}

/* ---- 5. size ceiling ---- */

async function sizeSection (fake) {
  console.log('-- 5. generateAudio: response size ceiling --')
  const small = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', apiKeyEnv: '', maxBytes: 4096 }
  })

  fake.setBehavior('oversize')
  let before = fake.requests.length
  const declared = await caught(() => generateAudio(small, { prompt: 'too big', duration: 1 }))
  check('a declared oversized body is refused', declared?.reasonCode === 'too-large', String(declared?.reasonCode))
  check('the size error names bytes and limit',
    /65536/.test(declared?.message ?? '') && /4096/.test(declared?.message ?? ''), declared?.message)
  check('the oversized request did reach the server', fake.requests.length === before + 1,
    `${fake.requests.length - before} request(s)`)

  fake.setBehavior('oversize-chunked')
  before = fake.requests.length
  const chunked = await caught(() => generateAudio(small, { prompt: 'chunked too big', duration: 1 }))
  check('a chunked body with no Content-Length is stopped mid-read',
    chunked?.reasonCode === 'too-large', String(chunked?.reasonCode))
  check('the chunked rejection also names the limit',
    /4096/.test(chunked?.message ?? ''), chunked?.message)

  fake.setBehavior('wav')
  const generous = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', apiKeyEnv: '', maxBytes: CLIP.bytes.length + 1024 }
  })
  const fits = await generateAudio(generous, { prompt: 'fits', duration: 1 })
  check('a body under the ceiling still succeeds', fits.bytes.length === CLIP.bytes.length,
    `${fits.bytes.length} B <= ${generous.maxBytes} B`)
}

/* ---- 6. HTTP errors ---- */

async function httpErrorSection (fake) {
  console.log('-- 6. generateAudio: HTTP 4xx / 5xx --')
  const resolved = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', apiKeyEnv: '' }
  })

  fake.setBehavior('http-404')
  const notFound = await caught(() => generateAudio(resolved, { prompt: 'missing model', duration: 1 }))
  check('404 is classified http-4xx', notFound?.reasonCode === 'http-4xx', String(notFound?.reasonCode))
  check('404 keeps the status', notFound?.status === 404, String(notFound?.status))
  check('404 names the status and the body', /HTTP 404/.test(notFound?.message ?? '') && /model not found/.test(notFound?.message ?? ''),
    notFound?.message)

  fake.setBehavior('http-500')
  const serverError = await caught(() => generateAudio(resolved, { prompt: 'boom', duration: 1 }))
  check('500 is classified http-5xx', serverError?.reasonCode === 'http-5xx', String(serverError?.reasonCode))
  check('500 keeps the status', serverError?.status === 500, String(serverError?.status))
  check('500 error is readable, not undefined',
    typeof serverError?.message === 'string' && /internal server error/.test(serverError.message), serverError?.message)
}

/* ---- 7. timeout ---- */

async function timeoutSection (fake) {
  console.log('-- 7. generateAudio: transport timeout --')
  fake.setBehavior('silent')
  const fast = resolveGenerateConfig({
    generate: { baseUrl: fake.url, apiKey: 'k', apiKeyEnv: '', timeoutMs: 200 }
  })
  const started = Date.now()
  const error = await caught(() => generateAudio(fast, { prompt: 'never answered', duration: 1 }))
  const elapsed = Date.now() - started
  check('the request reached the fake before aborting', fake.requests.length > 0, `${fake.requests.length} request(s)`)
  check('timeout is classified as timeout', error?.reasonCode === 'timeout', String(error?.reasonCode))
  check('timeout fires inside the configured 200 ms', elapsed >= 150 && elapsed <= 2000, `${elapsed} ms`)
  check('timeout message names the limit', /200 ms/.test(error?.message ?? ''), error?.message)
}

/* ---- 8. missing configuration ---- */

async function unconfiguredSection (fake) {
  console.log('-- 8. generateAudio: configuration failures before any network --')
  fake.setBehavior('wav')

  let before = fake.requests.length
  const noKey = resolveGenerateConfig({ generate: { baseUrl: fake.url, apiKeyEnv: '' } }, {})
  const missingKey = await caught(() => generateAudio(noKey, { prompt: 'x', duration: 1 }))
  check('missing key is classified missing-key', missingKey?.reasonCode === 'missing-key', String(missingKey?.reasonCode))
  check('missing key names the config field', /config\.generate\.apiKey/.test(missingKey?.message ?? ''), missingKey?.message)
  check('missing key sends nothing', fake.requests.length === before, `${fake.requests.length - before} request(s)`)

  const noUrl = resolveGenerateConfig({ generate: { apiKey: 'k' } }, {})
  const missingUrl = await caught(() => generateAudio(noUrl, { prompt: 'x', duration: 1 }))
  check('missing endpoint is no-base-url', missingUrl?.reasonCode === 'no-base-url', String(missingUrl?.reasonCode))
  check('missing endpoint names config and env', /config\.generate\.baseUrl/.test(missingUrl?.message ?? '') &&
    /AUDIO_GENERATE_BASE_URL/.test(missingUrl?.message ?? ''), missingUrl?.message)

  const namedEnv = resolveGenerateConfig({ generate: { baseUrl: fake.url, apiKeyEnv: 'MISSING_GEN_KEY' } }, {})
  const envError = await caught(() => generateAudio(namedEnv, { prompt: 'x', duration: 1 }))
  check('an empty custom apiKeyEnv is named in the error', /MISSING_GEN_KEY/.test(envError?.message ?? ''),
    envError?.message)
  check('that error carries envName', envError?.envName === 'MISSING_GEN_KEY', String(envError?.envName))

  const disabled = resolveGenerateConfig({ generate: { provider: 'none' } }, {})
  const disabledError = await caught(() => generateAudio(disabled, { prompt: 'x', duration: 1 }))
  check('provider none is provider-none', disabledError?.reasonCode === 'provider-none', String(disabledError?.reasonCode))
  check('provider none says it is switched off', /已关闭/.test(disabledError?.message ?? ''), disabledError?.message)

  const unknown = resolveGenerateConfig({ generate: { provider: 'replicate', baseUrl: fake.url, apiKey: 'k' } }, {})
  const unknownError = await caught(() => generateAudio(unknown, { prompt: 'x', duration: 1 }))
  check('an unknown provider is unsupported-target',
    unknownError?.reasonCode === 'unsupported-target', String(unknownError?.reasonCode))
  check('that error lists the supported shapes',
    GENERATE_PROVIDERS.every((provider) => (unknownError?.message ?? '').includes(provider)), unknownError?.message)

  check('none of the configuration failures hit the server',
    fake.requests.length === before, `${fake.requests.length - before} request(s) after all five`)
}

/* ---- 9. writing files ---- */

async function writeSection () {
  console.log('-- 9. saveGeneratedAudio: content hash, dedupe, decode round-trip --')
  const cwd = join(workdir, 'writes')

  const header = inspectWavHeader(CLIP.bytes)
  check('inspectWavHeader reads the container without decoding samples',
    header?.frames === CLIP.frames && header?.dataBytes === CLIP.frames * 2 &&
    Math.abs(header.durationSeconds - CLIP_SECONDS) < 1e-9,
    `${header?.frames} frames · ${header?.dataBytes} data bytes`)
  check('inspectWavHeader rejects bytes that are not a wav',
    inspectWavHeader(Buffer.from('not a wav file at all')) === null, 'non-wav parsed as a header')

  const saved = await saveGeneratedAudio(cwd, CLIP.bytes)
  const expectedHash = sha256(CLIP.bytes).slice(0, 12)
  check('default path is assets/audio/generate-<content-hash>.wav',
    /assets[\\/]audio[\\/]generate-[0-9a-f]{12}\.wav$/.test(saved.target), saved.target)
  check('the hash is the sha256 prefix of the bytes', saved.hash === expectedHash, `${saved.hash} vs ${expectedHash}`)
  check('default path embeds that hash', saved.target.includes(expectedHash), saved.target)
  check('written size matches the buffer', saved.bytes === CLIP.bytes.length, `${saved.bytes} B`)

  const decoded = decodeWav(await readFile(saved.target))
  check('the file on disk decodes back to the fake clip',
    decoded.sampleRate === CLIP_RATE && decoded.channels.length === 1 &&
    Math.abs(decoded.durationSeconds - CLIP_SECONDS) < 1e-9,
    `${decoded.sampleRate} Hz · ${fixed(decoded.durationSeconds)} s`)
  check('the on-disk bytes are byte-identical to the response',
    Buffer.compare(await readFile(saved.target), CLIP.bytes) === 0, saved.target)

  const again = await saveGeneratedAudio(cwd, CLIP.bytes)
  check('the same bytes resolve to the same default file', again.target === saved.target, again.target)

  const explicit = await saveGeneratedAudio(cwd, CLIP.bytes, 'takes/take-one.wav')
  check('an explicit out path is honoured', explicit.target.endsWith(join('takes', 'take-one.wav')), explicit.target)
  check('an explicit out file decodes too', decodeWav(await readFile(explicit.target)).durationSeconds > 0,
    explicit.target)

  const renamed = await saveGeneratedAudio(cwd, CLIP.bytes, 'takes/mislabeled.mp3')
  check('a non-wav audio extension becomes .wav', /mislabeled\.wav$/.test(renamed.target), renamed.target)

  const noExtension = await saveGeneratedAudio(cwd, CLIP.bytes, 'takes/nameless')
  check('a path without an extension gets .wav', /nameless\.wav$/.test(noExtension.target), noExtension.target)
}

/* ---- 10. tool layer ---- */

function makeRegistry (cwd) {
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  return { ctx, registered }
}

async function toolSection (fake) {
  console.log('-- 10. audio_generate tool layer --')
  const cwd = join(workdir, 'tool')
  const { ctx, registered } = makeRegistry(cwd)
  const exec = { agent: { session: { id: 'generate-test' } } }
  registerGenerateTools(ctx, {
    generate: { baseUrl: fake.url, apiKey: 'tool-secret', model: 'cfg-model', apiKeyEnv: '', timeoutMs: 5000 }
  })
  const tool = registered.get('audio_generate')

  check('exactly one tool is registered under the expected name',
    registered.size === 1 && tool !== undefined, [...registered.keys()].join(','))
  const properties = Object.keys(tool?.parameters?.properties ?? {}).sort()
  check('schema is small: five documented arguments',
    JSON.stringify(properties) === JSON.stringify(['duration', 'model', 'out', 'prompt', 'provider']),
    properties.join(','))
  check('schema requires only prompt',
    JSON.stringify(tool?.parameters?.required) === JSON.stringify(['prompt']), JSON.stringify(tool?.parameters?.required))
  check('schema rejects extra properties', tool?.parameters?.additionalProperties === false,
    String(tool?.parameters?.additionalProperties))
  check('provider enum matches the supported shapes',
    JSON.stringify(tool?.parameters?.properties?.provider?.enum) === JSON.stringify([...GENERATE_PROVIDERS]),
    JSON.stringify(tool?.parameters?.properties?.provider?.enum))
  check('description stays within two lines',
    String(tool?.description).split('\n').length <= 2, `${String(tool?.description).length} chars`)
  check('tool contract: concurrency-safe, output.render, presentCall',
    tool?.isConcurrencySafe === true && typeof tool?.output?.render === 'function' &&
    typeof tool?.presentCall === 'function', 'shape ok')

  fake.setBehavior('wav')
  let before = fake.requests.length
  const ok = await tool.execute({ prompt: 'thunder over a city', duration: 1, out: 'gen/thunder.wav' }, exec)
  const sent = fake.requests.at(-1)
  check('success: one request, openai-audio path',
    fake.requests.length === before + 1 && sent?.path === '/v1/audio/generations', sent?.path)
  check('success: configured model and duration reach the wire',
    sent?.json?.model === 'cfg-model' && sent?.json?.duration === 1 && sent?.json?.prompt === 'thunder over a city',
    JSON.stringify({ model: sent?.json?.model, duration: sent?.json?.duration }))
  check('success: the configured key is used', sent?.headers.authorization === 'Bearer tool-secret',
    String(sent?.headers.authorization))
  check('success: file is written at the requested relative path',
    ok.relativePath === 'gen/thunder.wav', ok.relativePath)
  check('success: result measurements come from the written file',
    ok.sampleRate === CLIP_RATE && Math.abs(ok.durationSeconds - CLIP_SECONDS) < 1e-9 && ok.bytes === CLIP.bytes.length,
    `${ok.sampleRate} Hz · ${fixed(ok.durationSeconds)} s · ${ok.bytes} B`)
  check('success: the written file decodes back',
    Math.abs(decodeWav(await readFile(ok.path)).durationSeconds - CLIP_SECONDS) < 1e-9, ok.path)
  check('success: metrics are measured, not zero',
    ok.metrics.peakDbfs > -10 && ok.metrics.peakDbfs < 0 && ok.metrics.rmsDbfs < ok.metrics.peakDbfs,
    `peak ${ok.metrics.peakDbfs} dBFS · rms ${ok.metrics.rmsDbfs} dBFS`)
  check('success: effective says deterministic=false with provider and model',
    ok.effective.deterministic === false && ok.effective.provider === 'openai-audio' && ok.effective.model === 'cfg-model',
    JSON.stringify({ deterministic: ok.effective.deterministic, provider: ok.effective.provider }))
  check('success: text says the result is not deterministic',
    /deterministic=false/.test(ok.text) && /same prompt/.test(ok.text), ok.text.split('\n').join(' | '))

  fake.setBehavior('wav')
  const override = await tool.execute({ prompt: 'custom shape', model: 'override-model', provider: 'custom', out: 'gen/custom.wav' }, exec)
  const overrideSent = fake.requests.at(-1)
  check('model/provider overrides are applied: custom posts to baseUrl itself',
    overrideSent?.path === '/' && overrideSent?.json?.model === 'override-model',
    `${overrideSent?.path} · ${overrideSent?.json?.model}`)
  check('override result names the overridden provider and model',
    override.effective.provider === 'custom' && override.effective.model === 'override-model',
    `${override.effective.provider}/${override.effective.model}`)

  const defaultOut = await tool.execute({ prompt: 'default name', duration: 1 }, exec)
  const defaultHash = sha256(await readFile(defaultOut.path)).slice(0, 12)
  check('default out lands in assets/audio with a content hash',
    /assets[\\/]audio[\\/]generate-[0-9a-f]{12}\.wav$/.test(defaultOut.path), defaultOut.path)
  check('that file name is the hash of the actual bytes', defaultOut.path.includes(defaultHash),
    `${defaultHash}`)

  // Argument guards run before any request: a bad call must cost no network.
  const beforeInvalid = fake.requests.length
  const missingPrompt = await caught(() => tool.execute({}, exec))
  check('prompt is required', /prompt/.test(missingPrompt?.message ?? ''), missingPrompt?.message)
  const longPrompt = await caught(() => tool.execute({ prompt: 'x'.repeat(1001) }, exec))
  check('prompt over 1000 chars is refused', /1000/.test(longPrompt?.message ?? ''), longPrompt?.message)
  const numericPrompt = await caught(() => tool.execute({ prompt: 42 }, exec))
  check('a non-string prompt is refused', /prompt/.test(numericPrompt?.message ?? ''), numericPrompt?.message)
  const shortDuration = await caught(() => tool.execute({ prompt: 'x', duration: 0.5 }, exec))
  check('duration below 1 s is refused', /duration/.test(shortDuration?.message ?? '') && /1 and 60/.test(shortDuration?.message ?? ''),
    shortDuration?.message)
  const longDuration = await caught(() => tool.execute({ prompt: 'x', duration: 61 }, exec))
  check('duration above 60 s is refused', /duration/.test(longDuration?.message ?? '') && /1 and 60/.test(longDuration?.message ?? ''),
    longDuration?.message)
  const nanDuration = await caught(() => tool.execute({ prompt: 'x', duration: 'abc' }, exec))
  check('a non-numeric duration is refused', /duration/.test(nanDuration?.message ?? ''), nanDuration?.message)
  const badProvider = await caught(() => tool.execute({ prompt: 'x', provider: 'replicate' }, exec))
  check('an unknown provider override is refused', /provider/.test(badProvider?.message ?? ''), badProvider?.message)
  const emptyModel = await caught(() => tool.execute({ prompt: 'x', model: '' }, exec))
  check('an empty model override is refused', /model/.test(emptyModel?.message ?? ''), emptyModel?.message)
  check('invalid arguments cost no network call', fake.requests.length === beforeInvalid,
    `${fake.requests.length - beforeInvalid} request(s)`)

  fake.setBehavior('http-404')
  const before404 = fake.requests.length
  const remote404 = await caught(() => tool.execute({ prompt: 'missing', out: 'gen/404.wav' }, exec))
  check('a remote 404 surfaces as a coded tool error',
    remote404?.reasonCode === 'http-4xx' && /\(http-4xx\)/.test(remote404?.message ?? '') && /HTTP 404/.test(remote404?.message ?? ''),
    remote404?.message)
  check('a failed generation writes no file',
    await stat(join(cwd, 'gen/404.wav')).then(() => false, () => true), 'gen/404.wav exists')
  check('the 404 request did reach the server', fake.requests.length === before404 + 1,
    `${fake.requests.length - before404} request(s)`)
  fake.setBehavior('wav')

  // An offline registry: configured endpoint but no key.
  const noKeyRegistry = makeRegistry(join(workdir, 'tool-nokey'))
  registerGenerateTools(noKeyRegistry.ctx, { generate: { baseUrl: fake.url, apiKeyEnv: '' } })
  const offlineKey = await caught(() => noKeyRegistry.registered.get('audio_generate').execute({ prompt: 'x' }, exec))
  check('an unconfigured key fails as missing-key at the tool layer',
    offlineKey?.reasonCode === 'missing-key' && /\(missing-key\)/.test(offlineKey?.message ?? ''),
    offlineKey?.message)

  // Nothing configured at all (env lookups for the two names are blocked in main).
  const bareRegistry = makeRegistry(join(workdir, 'tool-bare'))
  registerGenerateTools(bareRegistry.ctx, {})
  const bare = await caught(() => bareRegistry.registered.get('audio_generate').execute({ prompt: 'x' }, exec))
  check('a completely unconfigured plugin refuses with no-base-url',
    bare?.reasonCode === 'no-base-url' && /AUDIO_GENERATE_BASE_URL/.test(bare?.message ?? ''), bare?.message)

  const noneRegistry = makeRegistry(join(workdir, 'tool-none'))
  registerGenerateTools(noneRegistry.ctx, { generate: { provider: 'none' } })
  const disabled = await caught(() => noneRegistry.registered.get('audio_generate').execute({ prompt: 'x' }, exec))
  check('provider none refuses at the tool layer',
    disabled?.reasonCode === 'provider-none' && /已关闭/.test(disabled?.message ?? ''), disabled?.message)
}

/* ---- 11. classify fallbacks ---- */

function classifySection () {
  console.log('-- 11. classifyGenerateFailure: errors that arrive without a code --')
  const cases = [
    ['http 503', Object.assign(new Error('upstream HTTP 503: busy'), {}), 'http-5xx', { status: 503 }],
    ['missing env', new Error('环境变量 AUDIO_GENERATE_API_KEY 为空。'), 'missing-key', { envName: 'AUDIO_GENERATE_API_KEY' }],
    ['timeout name', Object.assign(new Error('the operation was aborted'), { name: 'TimeoutError' }), 'timeout', {}],
    ['unreachable', new Error('fetch failed ECONNREFUSED 127.0.0.1'), 'endpoint-unreachable', {}],
    ['too large', new Error('响应超过上限 4096 字节'), 'too-large', {}],
    ['not wav', new Error('返回的不是 wav：content-type audio/mpeg'), 'not-wav', {}],
    ['unknown', new Error('something odd happened'), undefined, {}]
  ]
  for (const [label, error, expectedCode, expectedExtra] of cases) {
    const info = classifyGenerateFailure(error)
    const codeOk = info.reasonCode === expectedCode
    const extraOk = Object.entries(expectedExtra).every(([key, value]) => info[key] === value)
    check(`classify ${label} -> ${expectedCode ?? '(no code)'}`, codeOk && extraOk,
      `${String(info.reasonCode)}${info.status === undefined ? '' : ` · ${info.status}`}`)
  }

  const coded = generateAudioErrorPreservation()
  check('a provider error keeps its reasonCode, status and envName',
    coded.reasonCode === 'http-5xx' && coded.status === 503 && coded.envName === 'SOME_KEY',
    JSON.stringify(coded))
}

/** Build one already-coded error and make sure classify passes it through. */
function generateAudioErrorPreservation () {
  const error = new Error('HTTP 503: busy')
  error.reasonCode = 'http-5xx'
  error.status = 503
  error.envName = 'SOME_KEY'
  return classifyGenerateFailure(error)
}

/* ---- main ---- */

async function main () {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-audio-generate-'))
  // Deterministic offline behaviour: a developer machine that happens to export
  // the generation variables must not change what "unconfigured" means here.
  const savedEnv = {
    key: process.env.AUDIO_GENERATE_API_KEY,
    url: process.env.AUDIO_GENERATE_BASE_URL
  }
  delete process.env.AUDIO_GENERATE_API_KEY
  delete process.env.AUDIO_GENERATE_BASE_URL
  try {
    resolutionSection()
    const fake = await fakeUp()
    await binarySection(fake)
    await base64Section(fake)
    await rejectionSection(fake)
    await sizeSection(fake)
    await httpErrorSection(fake)
    await timeoutSection(fake)
    await unconfiguredSection(fake)
    await writeSection()
    await toolSection(fake)
    classifySection()

    const unexpected = fake.errors.filter((error) => !/aborted|ECONNRESET|EPIPE/i.test(String(error?.message ?? error)))
    check('test server: no unexpected request-handler crash', unexpected.length === 0,
      `${fake.errors.length} handler error(s) total`)
  } finally {
    if (savedEnv.key === undefined) delete process.env.AUDIO_GENERATE_API_KEY
    else process.env.AUDIO_GENERATE_API_KEY = savedEnv.key
    if (savedEnv.url === undefined) delete process.env.AUDIO_GENERATE_BASE_URL
    else process.env.AUDIO_GENERATE_BASE_URL = savedEnv.url
    for (const fake of fakes) await fake.close()
    await rm(workdir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  failures += 1
  console.log(`  FAIL test crashed: ${error?.stack ?? error}`)
}

check('finally: every fake server was closed', fakes.every((fake) => fake.closed), `${fakes.length} fake(s)`)
// No process.exit: the process must end on its own so `node --test`-style
// wrappers can see a clean exit. A lingering server handle would be a bug.
let resources = process.getActiveResourcesInfo()
for (let attempt = 0; attempt < 10 && resources.includes('TCPServerWrap'); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
  resources = process.getActiveResourcesInfo()
}
check('finally: no TCP server handle remains', !resources.includes('TCPServerWrap'),
  `active handles: ${resources.length === 0 ? '(none)' : resources.join(', ')}`)

console.log('')
if (failures > 0) {
  console.log(`FAILED: ${failures} of ${checks} assertion(s) — see FAIL lines above`)
  process.exitCode = 1
} else {
  console.log(`OK: external audio generation behaves over real HTTP — ${checks} assertions, every number measured on loopback`)
  process.exitCode = 0
}
