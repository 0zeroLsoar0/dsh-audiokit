/**
 * Local servers that impersonate the upstreams the speech adapters talk to.
 *
 * Why this file exists: `test/tts-mock.mjs` builds its mock inside the test, so
 * it can drift from what the adapters actually send. This factory is a reusable
 * stand-in for three HTTP shapes and one WebSocket shape, records every request
 * (path, headers, parsed body size, parsed body) so a test can assert on the
 * bytes that crossed the socket, and can switch behaviour at runtime so one
 * server covers the happy path, latency, and each failure mode.
 *
 * Modes:
 *  - `openai-speech`: `POST /v1/audio/speech` -> a small valid WAV encoded with
 *    `lib/wav.js` as `audio/wav`.
 *  - `openai-chat`: `POST /v1/chat/completions` -> an OpenAI-shaped completion
 *    whose assistant message is `assistantText`; the record states whether the
 *    request body really carried `input_audio` with base64 data, and how many
 *    bytes that decoded to.
 *  - `minimax`: `POST /v1/t2a_v2` -> `{ base_resp: { status_code: 0 },
 *    data: { audio: '<hex pcm>' } }`, plus two sentence marks in milliseconds
 *    when the request asked for subtitles.
 *  - `edge-ws`: the Edge "read aloud" WebSocket. The adapter only speaks
 *    WebSocket, so a plain HTTP fake cannot prove its transport; this mode
 *    completes the 101 upgrade and, in `ok` behaviour, sends one binary audio
 *    frame carrying a RIFF/WAV clip followed by `Path:turn.end`, exactly the
 *    frame layout `lib/providers-edge.js` parses.
 *
 * Behaviours (all HTTP modes): `ok`, `slow` (answers after `delayMs`),
 * `silent` (never answers), `http-401`, `http-500`, `non-json` (HTTP 200 with a
 * text/html body), and `status-error` (MiniMax only: HTTP 200 with
 * `base_resp.status_code = 1004`). For `edge-ws`, `silent` completes the
 * upgrade and then sends nothing, which is how a real hung read-aloud turn
 * looks from the client side.
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { encodeWav } from '../../lib/wav.js'

/* ---- protocol constants ---- */

/** WebSocket accept-key salt from RFC 6455. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A `turn.end` text frame in the shape `providers-edge.js` parses. */
const TURN_END_FRAME = 'X-RequestId:fake-provider\r\nPath:turn.end\r\n\r\n'

/** Body for `non-json`: syntactically valid HTTP, useless as JSON. */
const NON_JSON_BODY = '<html><body>bad gateway: upstream returned html, not json</body></html>'

/** Default assistant sentence for `openai-chat`; tests may override it. */
const DEFAULT_ASSISTANT_TEXT = '像一扇铁门在空旷的大厅里关上，回声拖了半秒。'

/** Upstream shapes this factory can stand in for. */
export const FAKE_MODES = Object.freeze(['openai-speech', 'openai-chat', 'minimax', 'edge-ws'])

/** Failure/latency behaviours `setBehavior` accepts. */
export const FAKE_BEHAVIORS = Object.freeze(['ok', 'slow', 'silent', 'http-401', 'http-500', 'non-json', 'status-error'])

/* ---- signal builders ---- */

/**
 * A deterministic sine tone.
 * @param {number} seconds - clip length.
 * @param {number} sampleRate - Hz.
 * @param {number} [hz] - tone frequency.
 * @param {number} [amplitude] - peak amplitude in 0..1.
 * @returns {Float32Array} mono samples.
 */
function tone (seconds, sampleRate, hz = 330, amplitude = 0.5) {
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * hz * index / sampleRate) * amplitude
  }
  return samples
}

/** Encode Float32 samples as interleaved 16-bit little-endian mono PCM. */
function pcm16 (samples) {
  const bytes = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(Math.round(samples[index] * 32767), index * 2)
  }
  return bytes
}

/**
 * Build a valid WAV clip plus the measurements a test needs.
 * @returns {{ seconds: number, sampleRate: number, frames: number, bytes: Buffer }}
 */
function wavClip (seconds, sampleRate, hz, amplitude) {
  const samples = tone(seconds, sampleRate, hz, amplitude)
  return {
    seconds: samples.length / sampleRate,
    sampleRate,
    frames: samples.length,
    bytes: encodeWav([samples], sampleRate)
  }
}

/* ---- response helpers ---- */

function sendJson (response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length)
  })
  response.end(body)
}

function sendBytes (response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length)
  })
  response.end(body)
}

function sendWav (response, clip) {
  sendBytes(response, 200, 'audio/wav', clip.bytes)
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split a request URL into pathname and query without trusting its host. */
function pathParts (rawUrl) {
  try {
    const url = new URL(rawUrl ?? '/', 'http://fake-provider.local')
    return { pathname: url.pathname, query: url.search }
  } catch {
    return { pathname: '/', query: '' }
  }
}

/* ---- request parsing ---- */

function readBody (request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * Summarize an audio-chat request: did the model input really carry
 * `input_audio` with base64 data, and how many decoded bytes was that?
 * @param {any} json - parsed request body.
 */
function inspectChatRequest (json) {
  const content = json?.messages?.[0]?.content
  const parts = Array.isArray(content) ? content : []
  const audioPart = parts.find((part) => part?.type === 'input_audio')
  const data = audioPart?.input_audio?.data
  const base64 = typeof data === 'string' ? data : ''
  return {
    model: json?.model ?? null,
    text: parts.filter((part) => part?.type === 'text').map((part) => part?.text ?? '').join(''),
    hasInputAudio: base64.length > 0,
    inputAudioFormat: audioPart?.input_audio?.format ?? null,
    inputAudioBase64Chars: base64.length,
    inputAudioBytes: base64.length > 0 ? Buffer.from(base64, 'base64').length : 0
  }
}

/* ---- route payloads ---- */

/**
 * Build a MiniMax T2A response for one request.
 *
 * The PCM length comes from the requested `audio_setting.sample_rate`, because
 * MiniMax does not echo a rate: the adapter assumes the one it asked for. The
 * sentence marks are milliseconds, the shape `normalizeTimestamps` converts.
 */
function minimaxPayload (fake, record) {
  const requestedRate = Math.round(Number(record.json?.audio_setting?.sample_rate) || 32000)
  const seconds = fake.chunkSeconds
  const samples = tone(seconds, requestedRate, 330, 0.5)
  const hex = pcm16(samples).toString('hex')
  const endMs = Math.round(samples.length / requestedRate * 1000)
  record.speech = {
    seconds: samples.length / requestedRate,
    sampleRate: requestedRate,
    frames: samples.length,
    pcmBytes: samples.length * 2,
    hexChars: hex.length
  }
  const payload = {
    base_resp: { status_code: 0, status_msg: 'success' },
    data: { audio: hex, status: 2 },
    extra_info: { audio_length: endMs, audio_sample_rate: requestedRate, audio_size: samples.length * 2 }
  }
  if (record.json?.subtitle_enable === true) {
    const middle = Math.round(endMs / 2)
    payload.data.subtitle = [
      { text: '第一句', start: 0, end: middle },
      { text: '第二句', start: middle, end: endMs }
    ]
  }
  return payload
}

function chatCompletion (fake, record) {
  return {
    id: 'chatcmpl-fake-0001',
    object: 'chat.completion',
    created: 0,
    model: record.json?.model ?? 'fake-omni',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: fake.assistantText },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 }
  }
}

/* ---- HTTP routing ---- */

function respondRoute (fake, response, record) {
  const { pathname } = pathParts(record.path)

  if (fake.mode === 'openai-speech') {
    if (pathname !== '/v1/audio/speech') {
      return sendJson(response, 404, { error: { message: `fake-provider: no route ${pathname}`, type: 'invalid_request_error' } })
    }
    record.speech = {
      seconds: fake.wavClip.seconds,
      sampleRate: fake.wavClip.sampleRate,
      frames: fake.wavClip.frames,
      wavBytes: fake.wavClip.bytes.length
    }
    return sendWav(response, fake.wavClip)
  }

  if (fake.mode === 'openai-chat') {
    if (pathname !== '/v1/chat/completions') {
      return sendJson(response, 404, { error: { message: `fake-provider: no route ${pathname}`, type: 'invalid_request_error' } })
    }
    return sendJson(response, 200, chatCompletion(fake, record))
  }

  if (fake.mode === 'minimax') {
    if (pathname !== '/v1/t2a_v2') {
      return sendJson(response, 404, { error: { message: `fake-provider: no route ${pathname}`, type: 'invalid_request_error' } })
    }
    return sendJson(response, 200, minimaxPayload(fake, record))
  }

  return sendJson(response, 404, { error: { message: `fake-provider: mode ${fake.mode} has no HTTP routes`, type: 'invalid_request_error' } })
}

/**
 * Apply the current behaviour to one recorded request.
 *
 * `silent` deliberately returns without touching the response: the request stays
 * open until the client's own timeout fires, which is what makes it a real
 * transport timeout rather than a simulated one.
 */
async function respond (fake, response, record) {
  const behavior = fake.behavior
  if (behavior === 'silent') return
  if (behavior === 'slow') await delay(fake.delayMs)
  if (behavior === 'http-401') {
    return sendJson(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } })
  }
  if (behavior === 'http-500') {
    return sendJson(response, 500, { error: { message: 'internal server error', type: 'server_error', code: 'internal_error' } })
  }
  if (behavior === 'non-json') {
    return sendBytes(response, 200, 'text/html; charset=utf-8', Buffer.from(NON_JSON_BODY, 'utf8'))
  }
  if (behavior === 'status-error') {
    if (fake.mode !== 'minimax') return respondRoute(fake, response, record)
    return sendJson(response, 200, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } })
  }
  return respondRoute(fake, response, record)
}

async function handleRequest (fake, request, response) {
  const raw = await readBody(request)
  let json = null
  try {
    json = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null
  } catch {
    json = null
  }
  const record = {
    method: request.method,
    path: request.url,
    headers: { ...request.headers },
    bodySize: raw.length,
    json
  }
  if (fake.mode === 'openai-chat') record.chat = inspectChatRequest(json)
  fake.requests.push(record)
  await respond(fake, response, record)
}

/* ---- Edge WebSocket ---- */

/** One unmasked server-to-client WebSocket frame. */
function wsFrame (opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * The binary `Path:audio` frame the Edge service sends: a 2-byte big-endian
 * header length, the ASCII headers, then the encoded payload. A RIFF/WAV
 * payload is legal here (the adapter decodes any frame that starts with
 * `RIFF`), which lets this fake exercise the real WebSocket parser and the real
 * WAV decoder without shipping an MP3 encoder.
 */
function edgeAudioFrame (clip) {
  const headers = Buffer.from('Path:audio\r\nContent-Type:audio/wav\r\n', 'latin1')
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(headers.length, 0)
  return Buffer.concat([prefix, headers, clip.bytes])
}

function handleUpgrade (fake, request, socket, head) {
  const { pathname, query } = pathParts(request.url)
  fake.upgrades.push({ path: pathname, query, headers: { ...request.headers } })

  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }

  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )

  // A hung read-aloud turn: handshake succeeds, then nothing ever arrives.
  if (fake.behavior === 'silent') return

  // Wait for the client's own frames so its message handlers are installed;
  // fall back to a timer in case a client sends nothing after the upgrade.
  let answered = false
  const answer = () => {
    if (answered) return
    answered = true
    clearTimeout(fallback)
    try {
      socket.write(wsFrame(0x2, edgeAudioFrame(fake.edgeClip)))
      socket.write(wsFrame(0x1, Buffer.from(TURN_END_FRAME, 'utf8')))
    } catch { /* client vanished mid-turn */ }
  }
  const fallback = setTimeout(answer, 500)
  fallback.unref()
  socket.once('data', answer)
  if (head !== undefined && head.length > 0) answer()
}

/* ---- factory ---- */

/**
 * Start one fake provider on an ephemeral loopback port.
 *
 * @param {object} [options]
 * @param {'openai-speech'|'openai-chat'|'minimax'|'edge-ws'} [options.mode] - default `openai-speech`.
 * @param {'ok'|'slow'|'silent'|'http-401'|'http-500'|'non-json'|'status-error'} [options.behavior] - default `ok`.
 * @param {number} [options.delayMs] - `slow` delay, default 200.
 * @param {number} [options.wavSeconds] - openai-speech clip length, default 1.
 * @param {number} [options.wavSampleRate] - openai-speech clip rate, default 24000.
 * @param {number} [options.chunkSeconds] - minimax clip length per request, default 1.5.
 * @param {number} [options.edgeSeconds] - edge-ws clip length, default 0.4.
 * @param {number} [options.edgeSampleRate] - edge-ws clip rate, default 24000.
 * @param {string} [options.assistantText] - openai-chat assistant sentence.
 * @returns {Promise<object>} the started fake: mutable `behavior`, `requests`,
 *   `upgrades`, `errors`, `wavClip`, `edgeClip`, `url`/`host`/`port`,
 *   `wsUrl(path)`, `setBehavior(name, options)` and idempotent `close()`.
 */
export async function startFakeProvider (options = {}) {
  const mode = String(options.mode ?? 'openai-speech')
  if (!FAKE_MODES.includes(mode)) throw new Error(`fake-provider: unknown mode "${mode}" (use ${FAKE_MODES.join(' / ')})`)
  const behavior = String(options.behavior ?? 'ok')
  if (!FAKE_BEHAVIORS.includes(behavior)) throw new Error(`fake-provider: unknown behavior "${behavior}" (use ${FAKE_BEHAVIORS.join(' / ')})`)

  const fake = {
    mode,
    behavior,
    delayMs: Math.max(0, Number(options.delayMs ?? 200)),
    assistantText: typeof options.assistantText === 'string' ? options.assistantText : DEFAULT_ASSISTANT_TEXT,
    chunkSeconds: Math.max(0.05, Number(options.chunkSeconds ?? 1.5)),
    requests: [],
    upgrades: [],
    errors: [],
    sockets: new Set(),
    closed: false
  }
  fake.wavClip = wavClip(
    Math.max(0.05, Number(options.wavSeconds ?? 1)),
    Math.round(Number(options.wavSampleRate ?? 24000)),
    440,
    0.5
  )
  fake.edgeClip = wavClip(
    Math.max(0.05, Number(options.edgeSeconds ?? 0.4)),
    Math.round(Number(options.edgeSampleRate ?? 24000)),
    330,
    0.5
  )

  const server = createServer((request, response) => {
    handleRequest(fake, request, response).catch((error) => {
      fake.errors.push(error)
      try {
        sendJson(response, 500, { error: { message: `fake-provider crash: ${error?.message ?? error}` } })
      } catch { /* response already gone */ }
    })
  })
  fake.server = server

  server.on('upgrade', (request, socket, head) => {
    try {
      handleUpgrade(fake, request, socket, head)
    } catch (error) {
      fake.errors.push(error)
      socket.destroy()
    }
  })

  server.on('connection', (socket) => {
    fake.sockets.add(socket)
    socket.on('close', () => fake.sockets.delete(socket))
    socket.on('error', () => { /* a killed client is part of the test */ })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const port = server.address().port
  fake.port = port
  fake.host = `127.0.0.1:${port}`
  fake.url = `http://${fake.host}`
  fake.wsUrl = (path = '/edge') => `ws://${fake.host}${path}`

  /**
   * Switch behaviour between requests; `slow` accepts its delay here too.
   * @param {string} nextBehavior - one of `FAKE_BEHAVIORS`.
   * @param {{ delayMs?: number }} [nextOptions]
   */
  fake.setBehavior = (nextBehavior, nextOptions = {}) => {
    if (!FAKE_BEHAVIORS.includes(nextBehavior)) throw new Error(`fake-provider: unknown behavior "${nextBehavior}"`)
    fake.behavior = nextBehavior
    if (Number.isFinite(nextOptions.delayMs)) fake.delayMs = Math.max(0, Number(nextOptions.delayMs))
    return fake
  }

  /**
   * Close the listener and every socket it owns (including upgraded WebSocket
   * connections and requests that never got an answer).
   */
  fake.close = async () => {
    if (fake.closed) return
    fake.closed = true
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
