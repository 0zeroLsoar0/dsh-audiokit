/**
 * Host side of the settings page.
 *
 * Five endpoints on the browser HTTP carrier, all same-origin only:
 *   GET  /dsh-audio/config  → config the running plugin uses; API keys reduced
 *                             to "is it set" flags, never echoed back; plus the
 *                             read-only peer-plugin detection (`ecosystem`),
 *                             which carries names/versions/capabilities only;
 *   POST /dsh-audio/config  → merge a patch and persist it via the config editor;
 *   POST /dsh-audio/test    → really talk to the provider (synthesize a sentence,
 *                             or describe a sample) and return the audio so the
 *                             page can play what it just produced. For the Edge
 *                             provider it reports protocolOk/supported/reason
 *                             instead of hiding a missing decoder behind an error;
 *   POST /dsh-audio/voices  → ask the configured provider for its voices
 *                             (MiniMax account list or the Edge catalogue), and
 *                             fall back to the static shortlist with a marker.
 *                             The body must be an empty object: the provider row
 *                             is read from the saved config only, so a request
 *                             can never aim the saved API key at another host;
 *   POST /dsh-audio/validate → model self-check: probe the *saved* endpoint and
 *                             push one real sample through it, reporting
 *                             reachability, HTTP status, whether audio was
 *                             accepted and the latency. It reads the captured
 *                             config and nothing from the browser, so the page
 *                             cannot aim it at a URL the user never saved — the
 *                             point of a self-check is that it checks the
 *                             settings that are actually in effect.
 *
 * `/test` and `/validate` report a provider refusal as data (HTTP 200, or 400
 * for a malformed request) and carry a machine-readable `reasonCode` next to
 * the human `error` / `reason` text. The human text is left exactly as it was:
 * it holds the provider body, the transport cause and the fix instructions,
 * which is what a log or a model wants to read, while the code is what lets
 * the settings page say the same fact in the reader's language without parsing
 * Chinese prose on the client (see `REASON_CODES`).
 *
 * Request policy. Only the page this plugin ships may drive these endpoints,
 * and a page can be hosted on any origin, so every POST has to prove it is
 * same-origin: `Sec-Fetch-Site: same-origin` is the signal, and when a client
 * omits that header the strict `Origin` (scheme + host + port) versus `Host`
 * comparison decides; a missing `Origin` is refused rather than trusted. GET is
 * not gated (it only reads the redacted view). Every POST that parses a body
 * must declare `Content-Type: application/json` (415 otherwise), a body over
 * `MAX_BODY` gets 413 before the socket is torn down, and a stalled upload is
 * aborted after `BODY_TIMEOUT_MS`.
 *
 * Config values that end up on the wire are constrained, because the saved API
 * key travels with them: `apiKeyEnv` may only name a key the adapters know
 * (`API_KEY_ENVS`), `baseUrl` must be `https:` and must not point at loopback,
 * a private or a link-local address, and `ffmpegPath` may only pin a binary in
 * DSH's own tools directory or a `ffmpeg`/`ffprobe` found on `PATH`. A value
 * stored before these checks existed is presented as unconfigured instead of
 * being echoed back or used by `/voices` (see `presentSection`).
 *
 * The semantic (audio-understanding) layer is opt-in through `check.enabled`,
 * false by default. While it is off, `GET /config` exposes only that flag (the
 * model row is not even readable), and `/test` plus `/validate` answer from the
 * saved flag without a single outbound request: reporting a disabled feature is
 * data the page can render, not a provider failure to classify (see
 * `semanticCheckEnabled` and `SEMANTIC_DISABLED_TEXT`).
 *
 * Routes are registered inside `ctx.inject(['webServer'], …)`: on a cold boot
 * this plugin can activate before the HTTP carrier is mounted.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { finalize, renderPreset, toWavBytes } from './audio.js'
import { ecosystemStatus } from './interop.js'
import {
  CHAT_AUDIO_DEFAULTS,
  EDGE_VOICE_CATALOG,
  MINIMAX_DEFAULTS,
  OPENAI_TTS_DEFAULTS,
  describeAudio,
  listVoices,
  speak
} from './providers.js'
import { findFfmpeg } from './providers-edge.js'

const MAX_BODY = 64 * 1024
/** A client has this long to finish uploading a JSON body. */
const BODY_TIMEOUT_MS = 10_000

const TTS_FIELDS = ['provider', 'baseUrl', 'model', 'voice', 'speed', 'pitch', 'sampleRate', 'groupId', 'ffmpegPath', 'apiKey', 'apiKeyEnv']
const CHECK_FIELDS = ['enabled', 'provider', 'baseUrl', 'model', 'apiKey', 'apiKeyEnv', 'autoValidate']
/** Numeric fields, coerced by `pickFields`. */
const TTS_NUMERIC = ['speed', 'pitch', 'sampleRate']

/**
 * The only environment variables an adapter will ever read a key from.
 *
 * `apiKeyEnv` names a process variable, so an unrestricted value is a way to
 * make the plugin read a secret it was never meant to read (and send it as a
 * bearer to the configured endpoint). These are the names the three adapters
 * actually fall back to, so a whitelist costs nothing and closes that door.
 */
const API_KEY_ENVS = Object.freeze(['MINIMAX_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY'])

/** DSH installs its own tools under this directory; only those may be pinned. */
const FFMPEG_TOOLS_DIR = join(homedir(), '.dsh', 'tools', 'ffmpeg')

/** Bare binary names `ffmpegPath` may refer to when they resolve through PATH. */
const FFMPEG_COMMANDS = Object.freeze(['ffmpeg', 'ffmpeg.exe', 'ffprobe', 'ffprobe.exe'])

/** Default ports, folded away before an `Origin`/`Host` comparison. */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }

/** Defaults used when the config leaves the env name empty. */
const DEFAULT_ENV = { tts: 'MINIMAX_API_KEY', check: 'DASHSCOPE_API_KEY' }

/** The env var the OpenAI-compatible speech adapters fall back to. */
const OPENAI_ENV = 'OPENAI_API_KEY'

/**
 * Machine-readable failure codes, in the order the settings page lists them.
 *
 * One code per distinct thing the user has to fix — that is what makes the code
 * useful for copy and for tests, while the human `error` / `reason` text stays
 * unchanged:
 *
 *   missing-key          no key in the saved row and the environment variable is empty
 *   endpoint-unreachable DNS, TLS, refused or timed out before the provider answered
 *   http-4xx             the provider answered and refused (bad key, unknown model)
 *   http-5xx             the provider answered and failed on its own side
 *   not-audio            a 2xx whose body is not the content this endpoint returns
 *   no-base-url          no usable endpoint URL in the saved row
 *   provider-none        TTS is switched off (provider = none)
 *   decoder-missing      Edge returned compressed audio and no ffmpeg can decode it
 *   unsupported-target   the saved provider cannot serve this target at all
 *   semantic-disabled    the optional semantic layer (check.enabled) is off, so
 *                        nothing is asked and no request is made
 *
 * The page maps these to `reason.*` dictionary keys. `test/client-locale.mjs`
 * fails when a code has no Chinese or English string, and
 * `test/settings-validate.mjs` fails when a failure path stops reporting one.
 */
export const REASON_CODES = Object.freeze([
  'missing-key',
  'endpoint-unreachable',
  'http-4xx',
  'http-5xx',
  'not-audio',
  'no-base-url',
  'provider-none',
  'decoder-missing',
  'unsupported-target',
  'semantic-disabled'
])

/**
 * The one sentence a switched-off semantic layer reports.
 *
 * Chinese is the tool/report language; the page never shows it raw when a
 * `reasonCode` is present (`reason.semantic-disabled` carries the same fact in
 * the reader's language), but `audio_check` has no i18n layer of its own, so the
 * shared constant is what both surfaces read.
 */
export const SEMANTIC_DISABLED_TEXT = '语义检查未启用（设置→声音里打开）'

/**
 * Whether the optional semantic (audio-understanding) layer is switched on.
 *
 * `check.enabled` is the single authority: false when absent, so a row written
 * before the switch existed behaves as off. Every no-network path reads this
 * one predicate, which is what keeps the "disabled means no request" promise
 * from depending on each call site remembering it.
 * @param {object} [checkSection] - the saved `config.check` row.
 * @returns {boolean} true only for an explicit `enabled: true`.
 */
export function semanticCheckEnabled (checkSection) {
  return checkSection !== null && typeof checkSection === 'object' && checkSection.enabled === true
}

/** How long a reachability probe may take before it is reported as a timeout. */
const PROBE_TIMEOUT_MS = 5000
/** The page shows the model's answer on one line; anything longer is noise. */
const ANSWER_LIMIT = 300
/** A provider error is displayable text, never a stack: keep one paragraph. */
const ERROR_LIMIT = 500

function sendJson (res, status, payload, extraHeaders = undefined) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

/**
 * A failure with an HTTP meaning, thrown by the request/config readers.
 *
 * `status` picks the response line (400 malformed JSON, 408 timeout, 413 body
 * too large, 415 wrong media type), `close` asks the reply to send
 * `Connection: close` and then tear the socket down, and `reasonCode` / `field`
 * are copied into the JSON body so a caller (and a test) can tell *which* rule
 * rejected the request without parsing the Chinese message.
 */
class RequestError extends Error {
  constructor (status, message, options = {}) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.close = options.close === true
    if (typeof options.reasonCode === 'string') this.reasonCode = options.reasonCode
    if (typeof options.field === 'string') this.field = options.field
  }
}

/** True for a value our own readers threw; anything else is an unexpected bug. */
function isRequestError (error) {
  return error instanceof RequestError
}

/**
 * Answer with `error`'s status and keep the response shape every failure uses.
 *
 * The response is written *before* a `close` error destroys the request: with
 * the fixed order (reply, then destroy) a 413 actually reaches the client
 * instead of dying with the socket. The write is best-effort because the peer
 * may already be gone (a timeout aborts the socket on purpose).
 */
function replyError (request, response, error) {
  const status = isRequestError(error) ? error.status : 400
  const payload = { ok: false, error: error?.message ?? String(error) }
  if (typeof error?.reasonCode === 'string') payload.reasonCode = error.reasonCode
  if (typeof error?.field === 'string') payload.field = error.field
  try {
    if (response?.headersSent !== true && response?.destroyed !== true && response?.writableEnded !== true) {
      // The socket may already be gone (a timeout destroyed it); a write error
      // on the response must not become an unhandled 'error' in the host.
      if (typeof response?.on === 'function') response.once('error', () => {})
      sendJson(response, status, payload, error?.close === true ? { Connection: 'close' } : undefined)
    }
  } catch { /* the peer is gone; there is nobody left to tell */ }
  if (error?.close === true && typeof request?.destroy === 'function') {
    const destroy = () => {
      try { request.destroy() } catch { /* already destroyed */ }
    }
    // Tear the socket down only once the reply has been flushed to the OS:
    // destroying first would discard the 413 the client is supposed to read.
    // `finish` is what guarantees that; a stub response without events gets the
    // immediate path (the ordering is asserted by test/security-settings.mjs).
    if (typeof response?.once === 'function' && response.writableFinished !== true) response.once('finish', destroy)
    else destroy()
  }
}

/**
 * Read a JSON request body with the request policy the endpoints document.
 *
 * Checks the media type first (a form-encoded or text body is not JSON, and
 * accepting it would only turn a caller bug into a confusing 400), then streams
 * the body with a hard size cap and an inactivity timeout. Over the cap it
 * pauses the upload and rejects with a 413 that carries `close`, so the caller
 * can reply and *then* destroy — the old code destroyed the socket first, which
 * made the 400 unverifiable. A parse failure is its own `RequestError`, so it
 * stays a 400 and never picks up a provider-style `reasonCode`.
 *
 * @param {import('node:http').IncomingMessage} request - the request to read.
 * @returns {Promise<object>} the parsed body, `{}` when it was empty.
 * @throws {RequestError} 408 / 413 / 415 / 400.
 */
function readJson (request) {
  return new Promise((resolve, reject) => {
    // Observe stream errors from the very start. A request rejected for its
    // media type is never consumed, and an unobserved 'error' when the peer
    // hangs up would become an unhandled event in the host process.
    request.on('error', () => {})

    const mediaType = String(request.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json') {
      reject(new RequestError(415, '请求必须使用 Content-Type: application/json'))
      return
    }

    const chunks = []
    let size = 0
    let settled = false
    let timer = null

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      // Release the socket timeout the abort guard installed; the request may
      // live on as a keep-alive connection after this body was read.
      if (typeof request.setTimeout === 'function') {
        try { request.setTimeout(0) } catch { /* no socket (test double or gone) */ }
      }
      if (error !== undefined) reject(error)
      else resolve(value)
    }

    const abort = () => {
      // Stop reading and let the reply path finish (`close: true`): the 408 is
      // written first, and the socket is torn down once it has been flushed.
      if (typeof request.pause === 'function') request.pause()
      finish(new RequestError(408, `请求体读取超时（${BODY_TIMEOUT_MS} ms）`, { close: true }))
    }

    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) {
        // Stop consuming: the upload is over budget, and the caller is about to
        // answer 413 and close the connection anyway.
        if (typeof request.pause === 'function') request.pause()
        finish(new RequestError(413, `请求体超过 ${MAX_BODY} 字节`, { close: true }))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        finish(undefined, {})
        return
      }
      try {
        finish(undefined, JSON.parse(raw))
      } catch {
        finish(new RequestError(400, '请求体不是合法 JSON'))
      }
    })
    request.on('error', (error) => finish(new RequestError(400, `读取请求体失败：${error?.message ?? error}`)))

    // Two guards: an inactivity timeout on a real socket, and a plain timer so a
    // stub request (tests, a transport that has no `setTimeout`) still settles.
    timer = setTimeout(abort, BODY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof request.setTimeout === 'function') request.setTimeout(BODY_TIMEOUT_MS, abort)
  })
}

/** The scheme a request arrived on, honouring a reverse proxy's header. */
function requestProtocol (request) {
  const forwarded = request.headers?.['x-forwarded-proto']
  if (typeof forwarded === 'string' && forwarded.trim() !== '') {
    return `${forwarded.split(',')[0].trim().toLowerCase().replace(/:$/, '')}:`
  }
  return request.socket?.encrypted === true ? 'https:' : 'http:'
}

/** `host[:port]` with the scheme's default port folded away. */
function normalizeHost (value, protocol) {
  const host = String(value ?? '').trim().toLowerCase()
  if (host === '') return ''
  const port = DEFAULT_PORTS[protocol] ?? ''
  if (port !== '' && host.endsWith(`:${port}`)) return host.slice(0, -(port.length + 1))
  return host
}

/**
 * Refuse a request that cannot prove it came from this origin.
 *
 * `Sec-Fetch-Site` is the reliable signal when present, and only its strictest
 * value passes: `same-site` is a *different* origin on the same site and must
 * not drive config writes, and `none` is not the settings page either. When the
 * header is absent (older client, proxy that strips it) the request falls back
 * to the classic comparison of `Origin` against the request's own scheme and
 * `Host`; a missing `Origin` is refused, because "no proof" is not "same
 * origin". GET/HEAD only read the redacted view and are not gated.
 */
function sameOriginOnly (request, response) {
  if (request.method === 'GET' || request.method === 'HEAD') return true

  const site = request.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site.length > 0) {
    if (site === 'same-origin') return true
    sendJson(response, 403, { ok: false, error: '只接受同源请求' })
    return false
  }

  const origin = request.headers?.origin
  const host = request.headers?.host
  if (typeof origin === 'string' && origin.length > 0 && typeof host === 'string' && host.length > 0) {
    try {
      const parsed = new URL(origin)
      const protocol = requestProtocol(request)
      if (parsed.protocol === protocol && normalizeHost(parsed.host, protocol) === normalizeHost(host, protocol)) return true
    } catch { /* a malformed Origin cannot match */ }
  }
  sendJson(response, 403, { ok: false, error: '只接受同源请求' })
  return false
}

/** Own-property test: a value inherited from Object.prototype is not set. */
function hasOwn (object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
}

/** Keep only known fields, and coerce the numeric ones. */
function pickFields (source, fields, numeric) {
  const out = {}
  if (source === undefined || source === null || typeof source !== 'object') return out
  for (const field of fields) {
    if (!(field in source)) continue
    const value = source[field]
    if (numeric.includes(field)) {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${field} 必须是数字`)
      out[field] = number
    } else if (typeof value === 'boolean') {
      out[field] = value
    } else {
      if (value !== null && typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
      out[field] = (value ?? '').trim()
    }
  }
  return out
}

/**
 * The env var name a saved row may use, or '' when it is not on the whitelist.
 *
 * Read-side mirror of the save check: a row persisted before the whitelist
 * existed must not make an adapter read an arbitrary process variable, so an
 * unrecognised name is treated as "not configured" (the adapter then falls back
 * to its own default variable) instead of being used or crashing the page.
 */
function usableEnvName (value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return API_KEY_ENVS.includes(name) ? name : ''
}

/** Refuse an `apiKeyEnv` outside the whitelist; empty clears the field. */
function assertApiKeyEnv (row) {
  if (!hasOwn(row, 'apiKeyEnv')) return
  const raw = row.apiKeyEnv
  if (raw === null || raw === undefined) return
  const name = String(raw).trim()
  if (name === '' || API_KEY_ENVS.includes(name)) return
  throw new RequestError(
    400,
    `apiKeyEnv 只允许 ${API_KEY_ENVS.join(' / ')}（收到 "${name.slice(0, 64)}"）`,
    { reasonCode: 'invalid-api-key-env', field: 'apiKeyEnv' }
  )
}

/** Strip the brackets WHATWG URLs keep around an IPv6 literal. */
function bareHostname (hostname) {
  return String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
}

/**
 * True for an address that is this machine, a private network or link-local.
 *
 * `URL` already canonicalises exotic IPv4 spellings (`0x7f000001`, `127.1`) and
 * IPv4-mapped IPv6 (`::ffff:7f00:1`), so the dotted-quad and `fc`/`fe80` checks
 * below see a normalised host. DNS names are matched only for `localhost`; a
 * name that *resolves* to a private address cannot be seen without a lookup,
 * and a lookup would make the save path network-bound.
 */
function isLocalOrPrivateHostname (hostname) {
  const host = bareHostname(hostname)
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (dotted !== null) {
    const [a, b] = [Number(dotted[1]), Number(dotted[2])]
    return a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
  }
  // WHATWG normalises `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return isLocalOrPrivateHostname(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`)
  }

  if (host === '::' || host === '::1') return true
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true
  return false
}

/**
 * Whether a URL is a usable provider endpoint: absolute, `https:`, public.
 * Never throws — read paths ask this about values stored before validation
 * existed, and a malformed string must simply count as "not usable".
 */
function isAllowedBaseUrl (value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return true
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return !isLocalOrPrivateHostname(parsed.hostname)
}

/** Refuse a `baseUrl` the saved key must never be sent to; empty is allowed. */
function assertBaseUrl (row) {
  if (!hasOwn(row, 'baseUrl')) return
  const raw = row.baseUrl
  if (raw === null || raw === undefined) return
  const value = String(raw).trim()
  if (value === '') return

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new RequestError(
      400,
      `baseUrl 必须是完整的 URL（例如 https://api.example.com），收到 "${value.slice(0, 120)}"`,
      { reasonCode: 'invalid-base-url', field: 'baseUrl' }
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new RequestError(
      400,
      `baseUrl 只允许 https://（收到 "${parsed.protocol}"）：API 密钥只会发往加密的公开端点`,
      { reasonCode: 'invalid-base-url', field: 'baseUrl' }
    )
  }
  if (isLocalOrPrivateHostname(parsed.hostname)) {
    throw new RequestError(
      400,
      `baseUrl 不允许指向本机、内网或链路本地地址（${bareHostname(parsed.hostname)}）`,
      { reasonCode: 'invalid-base-url', field: 'baseUrl' }
    )
  }
}

/** True when `candidate` is a path strictly inside `directory`. */
function insideDirectory (directory, candidate) {
  const rel = relative(directory, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Find an executable on PATH without spawning a process (`where`/`which`). */
function executableOnPath (name) {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const directories = String(pathValue).split(process.platform === 'win32' ? ';' : ':').filter((part) => part !== '')
  if (directories.length === 0) return null
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((part) => part !== '')
    : ['']
  const lower = name.toLowerCase()
  const candidates = extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? [name]
    : extensions.map((extension) => `${name}${extension}`)
  for (const directory of directories) {
    for (const candidate of candidates) {
      try {
        if (existsSync(join(directory, candidate))) return join(directory, candidate)
      } catch { /* an unreadable PATH entry is just not a match */ }
    }
  }
  return null
}

/**
 * Normalise a user-supplied `ffmpegPath`, or null when it must be ignored.
 *
 * Only two shapes are accepted, because this value names a binary the plugin
 * executes: a path inside DSH's own `~/.dsh/tools/ffmpeg` directory, or a bare
 * `ffmpeg`/`ffprobe` that really resolves through `PATH`. Anything else is
 * dropped and the provider's auto-detection applies — silently, since the field
 * means "pin this decoder" and an unusable pin has a documented fallback.
 * @returns {string|null} the value to store ('' means auto-detect), or null to ignore.
 */
function allowedFfmpegPath (value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return ''
  const name = basename(raw).toLowerCase()
  const looksLikePath = isAbsolute(raw) || raw.includes('/') || raw.includes('\\') || raw.startsWith('~')

  if (!looksLikePath) {
    if (!FFMPEG_COMMANDS.includes(name)) return null
    return executableOnPath(name) === null ? null : name
  }

  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(FFMPEG_TOOLS_DIR, expanded)
  return insideDirectory(FFMPEG_TOOLS_DIR, resolved) ? resolved : null
}

/**
 * Validate the patch a POST /config carries.
 *
 * All messages are user-facing: the page prints `error` verbatim. The dangerous
 * fields carry a `reasonCode` (+ `field`) so a test or a caller can tell which
 * rule fired; the numeric/provider checks keep their original wording (the
 * settings page and its tests match on it).
 */
function validate (section) {
  const tts = section?.tts ?? {}
  const check = section?.check ?? {}
  if (tts.provider !== undefined && !['minimax', 'openai', 'custom', 'edge', 'none'].includes(tts.provider)) {
    throw new Error('供应商只能是 minimax / openai / custom / edge / none')
  }
  if (tts.speed !== undefined && (tts.speed < 0.5 || tts.speed > 2)) throw new Error('语速必须在 0.5–2.0 之间')
  if (tts.pitch !== undefined && (tts.pitch < -12 || tts.pitch > 12)) throw new Error('音调必须在 −12..12 半音之间')
  if (tts.sampleRate !== undefined && (tts.sampleRate < 8000 || tts.sampleRate > 48000)) throw new Error('采样率必须在 8000–48000 之间')
  // The switch itself must be a real boolean: a stored `"true"` string would
  // read as off (`=== true`) and silently hide the fields the user just filled.
  if (check.enabled !== undefined && typeof check.enabled !== 'boolean') throw new Error('check.enabled 必须是布尔值')
  for (const row of [tts, check]) {
    assertApiKeyEnv(row)
    assertBaseUrl(row)
  }
  return section
}

/**
 * One section as the page sees it: values minus the key, plus key/env facts.
 *
 * Values this module now refuses to persist are shown as unconfigured instead
 * of being echoed back: a `baseUrl`/`ffmpegPath` stored before the checks
 * existed is dropped from the view (so the field renders empty and the user can
 * replace it) and a non-whitelisted `apiKeyEnv` falls back to the provider's
 * default variable. Nothing here throws — an old config must never break the
 * settings page.
 */
function presentSection (section, defaultEnv) {
  const { apiKey, apiKeyEnv, ...rest } = section ?? {}
  const view = { ...rest }
  if (typeof view.baseUrl === 'string' && view.baseUrl.trim() !== '' && !isAllowedBaseUrl(view.baseUrl)) delete view.baseUrl
  if (typeof view.ffmpegPath === 'string' && view.ffmpegPath.trim() !== '' && allowedFfmpegPath(view.ffmpegPath) === null) delete view.ffmpegPath
  const envName = usableEnvName(apiKeyEnv) || defaultEnv
  return {
    ...view,
    keySet: typeof apiKey === 'string' && apiKey.trim().length > 0,
    envName,
    envPresent: typeof process.env[envName] === 'string' && process.env[envName].trim().length > 0
  }
}

/**
 * The `check` section as `GET /config` (and a save response) may show it.
 *
 * Off is not "empty": the row exists but is not readable. Returning only
 * `{ enabled: false }` means a stale endpoint/model/key env name can never leak
 * into a disabled page, and the page has exactly one fact to render (the
 * checkbox) instead of several empty fields that look configured.
 * @param {object} section - saved `config.check` row.
 * @returns {object} `{ enabled: false }`, or the redacted row when enabled.
 */
function presentCheck (section) {
  if (!semanticCheckEnabled(section)) return { enabled: false }
  return presentSection(section, DEFAULT_ENV.check)
}

/**
 * The saved row as provider code may read it (`/test`, `/validate`).
 *
 * Only the key source is rewritten: a non-whitelisted `apiKeyEnv` is dropped so
 * `requireKey` falls back to the adapter's documented variable, and the page's
 * `envName`/`envPresent` facts agree with what the call will really do. The
 * endpoint and decoder are left exactly as saved, because these two endpoints
 * exist to exercise the configuration that is in effect.
 */
function providerSection (section) {
  if (section === null || typeof section !== 'object') return {}
  const stored = typeof section.apiKeyEnv === 'string' ? section.apiKeyEnv.trim() : ''
  const usable = usableEnvName(stored)
  if (usable === stored && usable !== '') return section
  const next = { ...section }
  // An empty `apiKeyEnv` means "use the adapter's default variable", which
  // `requireKey` only does when the field is absent (`''` would short-circuit
  // the fallback), so the empty string is removed rather than forwarded.
  if (usable === '') delete next.apiKeyEnv
  else next.apiKeyEnv = usable
  return next
}

/**
 * The saved row `/voices` may call out with.
 *
 * This endpoint's only job is to read the saved voice list, so a `baseUrl`
 * persisted before validation existed is treated as unconfigured here: the
 * lookup then uses the provider's own public default host instead of sending
 * the saved key wherever that stale value points.
 */
function voiceLookupSection (section) {
  const next = { ...providerSection(section) }
  if (typeof next.baseUrl === 'string' && next.baseUrl.trim() !== '' && !isAllowedBaseUrl(next.baseUrl)) delete next.baseUrl
  return next
}

/** A short chime used as the sample for "test the audio-understanding endpoint". */
function sampleWav (seconds = 0.6) {
  const rendered = renderPreset({ preset: 'chime', seed: 1, duration: seconds, sampleRate: 24000 })
  finalize(rendered.samples, rendered.sampleRate, -3)
  return { wav: toWavBytes(rendered.samples, rendered.sampleRate), durationSeconds: seconds }
}

/* ---- model self-check ---- */

/**
 * A thrown value as one displayable line.
 *
 * `fetch` says only "fetch failed" for network problems and hides the useful
 * part in `cause` (`connect ECONNREFUSED 127.0.0.1:1`, `getaddrinfo ENOTFOUND
 * …`). A self-check exists precisely to show that part, so it is appended.
 * No stack: the page has a single row for the reason.
 * @param {any} error - the thrown value.
 * @returns {string} at most `ERROR_LIMIT` characters, never empty.
 */
function failureText (error) {
  const message = error?.message ?? String(error)
  const cause = error?.cause?.message
  const text = typeof cause === 'string' && cause.length > 0 && !message.includes(cause)
    ? `${message}（${cause}）`
    : message
  return text.slice(0, ERROR_LIMIT)
}

/* ---- failure reasons ---- */

/**
 * Classify a thrown provider/transport error into one of `REASON_CODES`.
 *
 * Structured facts come first — an Edge `edgeCode`, an unsupported provider id,
 * or the key the route already resolved — and message shapes are only the
 * fallback, because `providers.js` belongs to another module and its wording is
 * not a contract. Mixed on purpose: the first fact that decides what the user
 * has to fix wins.
 *
 * `detail` is always the full original message, unchanged, so the page can show
 * it when the translation would lose the provider's own words.
 * @param {any} error - the value a provider call threw.
 * @param {{ target?: string, provider?: string|null, unsupported?: boolean,
 *   envName?: string, keyMissing?: boolean }} [context] - what the route knows
 *   about the call that threw; all fields optional so a test can classify alone.
 * @returns {{ detail: string, reasonCode?: string, envName?: string, status?: number }}
 *   `reasonCode` is omitted when the failure matches no known shape: a code the
 *   page cannot translate would only replace a readable message with a guess.
 */
export function classifyFailure (error, context = {}) {
  const detail = failureText(error)
  const provider = typeof context?.provider === 'string' ? context.provider : null
  const base = { detail }

  // Edge speaks WebSocket to a fixed service and tags its own failures; the
  // missing-decoder case in particular has no HTTP status and no message shape
  // worth matching after the tag is there.
  const edgeCode = typeof error?.edgeCode === 'string' ? error.edgeCode : ''
  if (edgeCode === 'undecodable') return { ...base, reasonCode: 'decoder-missing' }
  // ffmpeg ran and could not turn the service bytes into audio: the provider
  // returned something this machine cannot read as audio.
  if (edgeCode === 'decode') return { ...base, reasonCode: 'not-audio' }
  if (edgeCode === 'handshake' || edgeCode === 'closed' || edgeCode === 'timeout' || edgeCode === 'empty') {
    return { ...base, reasonCode: 'endpoint-unreachable' }
  }

  if (context?.unsupported === true) return { ...base, reasonCode: 'unsupported-target' }
  // A target that is switched off cannot fail for any other reason.
  if (provider === 'none') return { ...base, reasonCode: 'provider-none' }

  // The key lookup runs before any network call, so `keyMissing` is a fact this
  // route knows without reading the provider's message; the message is still
  // preferred when it names the variable, because that is what the page shows.
  const envInMessage = /环境变量\s*([^\s，。：]+)\s*为空/.exec(detail)
  if (envInMessage !== null) return { ...base, reasonCode: 'missing-key', envName: envInMessage[1] }
  if (context?.keyMissing === true || /没有配置密钥/.test(detail)) {
    const envName = typeof context?.envName === 'string' ? context.envName : ''
    return { ...base, reasonCode: 'missing-key', envName }
  }

  // `readError` / `postJson` put the status right in the text a provider refused
  // with, which is the one number the page interpolates for these codes.
  const statusMatch = /HTTP (\d{3})/.exec(detail)
  if (statusMatch !== null) {
    const status = Number(statusMatch[1])
    if (status >= 400 && status < 500) return { ...base, reasonCode: 'http-4xx', status }
    if (status >= 500 && status < 600) return { ...base, reasonCode: 'http-5xx', status }
  }

  // A URL the fetch spec refuses to parse is a configuration problem of the same
  // kind as a missing one: there is no usable endpoint URL.
  if (/没有 baseUrl|Failed to parse URL|Invalid URL/.test(detail)) return { ...base, reasonCode: 'no-base-url' }

  if (/fetch failed|bad port|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|aborted|timeout|超时/i.test(detail)) {
    return { ...base, reasonCode: 'endpoint-unreachable' }
  }

  // Every one of these means the answer was not the content this endpoint is
  // read as: a TTS body that is not audio, a chat endpoint that did not answer.
  if (/不是音频|返回的是 mp3|响应里没有 data\.audio|返回的音频为空|返回的不是 JSON|端点返回了空内容|没有返回可读内容/.test(detail)) {
    return { ...base, reasonCode: 'not-audio' }
  }

  if (/未知的 TTS provider/.test(detail)) return { ...base, reasonCode: 'unsupported-target' }

  return base
}

/** The reason fields for a failure row, ready to spread onto a report. */
function reasonFields (error, facts) {
  const info = classifyFailure(error, facts)
  const fields = { detail: info.detail }
  if (info.reasonCode !== undefined) fields.reasonCode = info.reasonCode
  if (info.envName !== undefined) fields.envName = info.envName
  if (info.status !== undefined) fields.status = info.status
  return fields
}

/** Trailing slashes would double up with the provider's `/v1/...` suffix. */
function trimBaseUrl (url) {
  return String(url ?? '').replace(/\/+$/, '')
}

/**
 * The key a real provider call would present, without throwing.
 *
 * The reachability probe only needs *a* key to be representative — a 401 still
 * proves the host answered — while the actual self-check call goes through
 * `describeAudio` / `speak`, which fail with instructions when no key exists.
 * So this mirrors their row-then-environment lookup but returns '' instead of
 * throwing, and `requireKey` stays the only place that defines "missing key".
 * A non-whitelisted `apiKeyEnv` (see `usableEnvName`) is ignored the same way
 * the provider side now ignores it, so the probe and the real call agree.
 * @param {object} section - the saved provider row.
 * @param {string} defaultEnv - env var to fall back to for this section.
 * @returns {string} the key, or '' when none is configured.
 */
function probeKey (section, defaultEnv) {
  const inline = typeof section?.apiKey === 'string' ? section.apiKey.trim() : ''
  if (inline.length > 0) return inline
  const envName = usableEnvName(section?.apiKeyEnv) || defaultEnv
  const value = process.env[envName]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The env var a provider call would read, named for the page to interpolate.
 *
 * `providers.js#requireKey` reads `apiKeyEnv` and falls back to a provider
 * default; this mirrors the same fallback so a `missing-key` row can say which
 * variable is empty. The message itself stays authoritative — see
 * `classifyFailure`, which prefers an env name found in the provider's text.
 * @param {object} section - the saved provider row.
 * @param {string} fallbackEnv - provider default env var.
 * @returns {string} the env var name, never empty.
 */
function keyEnvName (section, fallbackEnv) {
  return usableEnvName(section?.apiKeyEnv) || fallbackEnv
}

/** The env var a provider's `requireKey` falls back to. */
function defaultEnvFor (target, resolved) {
  if (target === 'check') return DEFAULT_ENV.check
  const provider = resolved?.provider
  if (provider === 'openai' || provider === 'custom' || provider === 'compatible') return OPENAI_ENV
  return DEFAULT_ENV.tts
}

/**
 * Whether a real provider call would stop at a missing key before any network
 * I/O. Edge and `none` need no key, and an unsupported provider is reported as
 * such instead of as a key problem.
 */
function isKeyMissing (target, resolved, section) {
  if (resolved?.supported === false) return false
  if (target === 'tts' && (resolved?.provider === 'edge' || resolved?.provider === 'none')) return false
  return probeKey(section, defaultEnvFor(target, resolved)).length === 0
}

/**
 * The endpoint and model a self-check will really use, resolved from the
 * *saved* section alone.
 *
 * The URL deliberately comes from the provider defaults rather than from the
 * request body: the page may choose a section (`check` / `tts`) but never an
 * address, otherwise the "check" would validate nothing that is in effect.
 * `baseUrl: null` means this provider has no user-configurable HTTP base —
 * Edge speaks WebSocket to a fixed service and `none` is off — so there is
 * nothing honest to probe.
 * @param {'check'|'tts'} target - section to resolve.
 * @param {object} section - the saved config row for that section.
 * @returns {{ provider: string|null, baseUrl: string|null, model: string|null,
 *   supported: boolean }} `supported` is false for a provider id no adapter
 *   knows, which is what makes `unsupported-target` reportable without waiting
 *   for the provider call to throw.
 */
function resolveSelfCheckTarget (target, section) {
  const source = section ?? {}
  if (target === 'check') {
    // describeAudio always speaks the OpenAI-compatible chat shape; the row's
    // `provider` field is cosmetic for this section.
    return {
      provider: null,
      baseUrl: trimBaseUrl(source.baseUrl ?? CHAT_AUDIO_DEFAULTS.baseUrl),
      model: source.model ?? CHAT_AUDIO_DEFAULTS.model,
      supported: true
    }
  }
  const provider = String(source.provider ?? 'minimax').toLowerCase()
  if (provider === 'edge' || provider === 'none') {
    return { provider, baseUrl: null, model: source.model ?? null, supported: true }
  }
  if (provider === 'minimax') {
    return {
      provider,
      baseUrl: trimBaseUrl(source.baseUrl ?? MINIMAX_DEFAULTS.baseUrl),
      model: source.model ?? MINIMAX_DEFAULTS.model,
      supported: true
    }
  }
  if (provider === 'openai' || provider === 'custom' || provider === 'compatible') {
    return {
      provider,
      baseUrl: trimBaseUrl(source.baseUrl ?? OPENAI_TTS_DEFAULTS.baseUrl),
      model: source.model ?? OPENAI_TTS_DEFAULTS.model,
      supported: true
    }
  }
  // Unknown provider: speak() will reject it with its own message, and there is
  // no default URL, so only a configured one can be probed.
  return {
    provider,
    baseUrl: source.baseUrl === undefined || source.baseUrl === null ? null : trimBaseUrl(source.baseUrl),
    model: source.model ?? null,
    supported: false
  }
}

/**
 * Whether the saved endpoint answers at all.
 *
 * A GET on the base URL is enough: even 401/404 proves DNS, TLS and the host
 * are fine, and that is the fact the settings page cannot see any other way.
 * Never throws — the report exists to *show* a failure, not to become one.
 * @param {string} baseUrl - absolute endpoint URL to probe.
 * @param {string} [apiKey] - sent as a bearer when present; optional on purpose.
 * @param {number} [timeoutMs] - abort budget; the abort is reported as a timeout.
 * @returns {Promise<{ reachable: boolean, status: number, error?: string }>}
 */
export async function probeEndpoint (baseUrl, apiKey, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    if (typeof apiKey === 'string' && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetch(String(baseUrl ?? ''), { method: 'GET', headers, signal: controller.signal })
    // Any status counts as reachable: the host answered, which is all this
    // claims. Cancel the body so a streamed response cannot keep a socket open.
    try { await response.body?.cancel() } catch { /* the body is irrelevant here */ }
    return { reachable: true, status: response.status }
  } catch (error) {
    if (controller.signal.aborted) return { reachable: false, status: 0, error: `超时 ${timeoutMs} ms` }
    return { reachable: false, status: 0, error: failureText(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The `endpoint` row of the self-check report.
 *
 * A reachability probe only makes sense when the provider really speaks HTTP
 * to a saved base URL; the remaining cases are reported as "not applicable" or
 * "missing" instead of a fake failure, because that distinction decides what
 * the user has to fix. Every row that is not simply reachable also carries the
 * `reasonCode` for that distinction, and keeps its original `error` wording.
 * @param {'check'|'tts'} target - section being validated.
 * @param {{ provider: string|null, baseUrl: string|null }} resolved - saved target.
 * @param {object} section - saved row, for the probe's bearer token.
 * @returns {Promise<{ reachable: boolean|null, status: number, error: string|null,
 *   detail?: string, reasonCode?: string }>}
 */
async function checkEndpoint (target, resolved, section) {
  if (target === 'tts' && resolved.provider === 'none') {
    const message = 'TTS 已关闭（provider = none），没有端点可探测'
    return { reachable: null, status: 0, error: message, detail: message, reasonCode: 'provider-none' }
  }
  if (resolved.baseUrl === null) {
    const message = `${resolved.provider} 没有 baseUrl（直连固定服务），端点探测不适用`
    return { reachable: null, status: 0, error: message, detail: message, reasonCode: 'no-base-url' }
  }
  if (resolved.baseUrl.length === 0) {
    const message = '配置里没有 baseUrl'
    return { reachable: false, status: 0, error: message, detail: message, reasonCode: 'no-base-url' }
  }
  // The probe presents the same key a real call would. The fallback therefore
  // has to be the *provider's* variable (`defaultEnvFor`), not the section's
  // generic default: for an openai/custom TTS row the speech adapter reads
  // OPENAI_API_KEY, and probing with MINIMAX_API_KEY would report a key that the
  // saved configuration never uses.
  const probe = await probeEndpoint(resolved.baseUrl, probeKey(section, defaultEnvFor(target, resolved)))
  if (probe.reachable) return { reachable: true, status: probe.status, error: null }
  return { reachable: false, status: 0, error: probe.error, detail: probe.error, reasonCode: 'endpoint-unreachable' }
}

/**
 * Register the settings endpoints.
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved config captured at activation.
 * @param {string} version - plugin version, echoed to the page.
 * @returns {boolean} whether the injection was registered.
 */
export function registerSettingsRoute (ctx, config, version) {
  // The page shows which environment variable a blank key field would read, so
  // the default has to follow the provider: an openai/custom speech row reads
  // OPENAI_API_KEY, not the MiniMax one.
  const snapshot = () => ({
    tts: presentSection(config.tts, defaultEnvFor('tts', { provider: config.tts?.provider })),
    check: presentCheck(config.check)
  })

  ctx.inject(['webServer'], (child) => {
    const webServer = child.webServer

    const register = (path, handler) => child.effect(() => webServer.register({ kind: 'exact', path, handler }))

    register('/dsh-audio/config', async (request, response) => {
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method === 'GET') {
          // Peer-plugin detection travels with the read-only view. It is a fact
          // about the profile on this machine (names, versions, capabilities —
          // see `lib/interop.js`), never about the saved keys, and a failed
          // detection is an empty `plugins` list rather than a broken page.
          sendJson(response, 200, { ok: true, version, config: snapshot(), ecosystem: ecosystemStatus() })
          return
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: `不支持 ${request.method}` })
          return
        }

        const body = validate(await readJson(request))
        const editor = child.get('configEditor')
        const entry = child.fiber?.entry
        if (editor === undefined || entry === undefined) {
          sendJson(response, 503, { ok: false, error: '这个 profile 不支持写配置' })
          return
        }

        const tts = pickFields(body.tts, TTS_FIELDS, TTS_NUMERIC)
        const check = pickFields(body.check, CHECK_FIELDS, [])
        // `ffmpegPath` pins a binary the plugin executes, so only a trusted
        // location is kept. An unusable pin is not an error the page has to
        // translate: it is ignored and the row falls back to auto-detection
        // (empty string), which is the documented meaning of the field.
        if (hasOwn(tts, 'ffmpegPath')) {
          const pinned = allowedFfmpegPath(tts.ffmpegPath)
          tts.ffmpegPath = pinned === null ? '' : pinned
        }
        // Merge into what is stored (not into the redacted view), so a field the
        // page never edited — including a stored key — survives the write.
        let saved = null
        await editor.edit(entry, (current) => {
          // Overlay only the keys the page submitted. Rebuilding from
          // `TTS_FIELDS` used to delete every key the settings UI does not show
          // (format, subtitle, subtitleType, volume, timeoutMs, outputFormat,
          // endpoint, voiceListUrl, decodeAudio …) on each save; those values
          // are not the page's to erase, so they are carried over untouched.
          const nextTts = { ...(current?.tts ?? {}), ...tts }
          const nextCheck = { ...(current?.check ?? {}), ...check }
          saved = { tts: nextTts, check: nextCheck }
          return { ...current, tts: nextTts, check: nextCheck }
        })
        sendJson(response, 200, {
          ok: true,
          restarting: true,
          config: saved === null
            ? null
            : {
                tts: presentSection(saved.tts, defaultEnvFor('tts', { provider: saved.tts?.provider })),
                check: presentCheck(saved.check)
              }
        })
      } catch (error) {
        replyError(request, response, error)
      }
    })

    register('/dsh-audio/test', async (request, response) => {
      // What a thrown value is classified against, filled in once the request
      // says which target it wants, so the catch below can still name the cause.
      let pending = null
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: `不支持 ${request.method}` })
          return
        }
        const body = await readJson(request)
        const target = body.target === 'check' ? 'check' : 'tts'
        // A switched-off semantic layer is a configuration state, not a provider
        // failure: answer from the saved flag alone, with no outbound request at
        // all, and let the page translate the reason code.
        if (target === 'check' && !semanticCheckEnabled(config.check)) {
          sendJson(response, 200, {
            ok: false,
            target,
            disabled: true,
            error: SEMANTIC_DISABLED_TEXT,
            detail: SEMANTIC_DISABLED_TEXT,
            reasonCode: 'semantic-disabled'
          })
          return
        }
        const section = providerSection(target === 'check' ? (config.check ?? {}) : (config.tts ?? {}))
        const provider = target === 'check' ? null : String(section.provider ?? 'minimax').toLowerCase()
        pending = {
          target,
          provider,
          envName: keyEnvName(section, defaultEnvFor(target, { provider })),
          keyMissing: isKeyMissing(target, { provider, supported: true }, section)
        }

        if (target === 'tts' && (section.provider ?? 'minimax') === 'edge') {
          // Edge needs no key. Whether it works depends on the service handshake
          // and on a decoder (ffmpeg or config.decodeAudio) being present, so
          // report those facts instead of collapsing them into one error.
          try {
            const result = await speak(section, '这是一次连接测试。')
            finalize(result.samples, result.sampleRate, -3)
            const wav = toWavBytes(result.samples, result.sampleRate)
            sendJson(response, 200, {
              ok: true,
              target,
              provider: 'edge',
              supported: true,
              protocolOk: true,
              reason: null,
              decoder: result.effective?.decoder ?? null,
              ffmpegPath: findFfmpeg({ ffmpegPath: section.ffmpegPath }),
              durationSeconds: Number((result.samples.length / result.sampleRate).toFixed(2)),
              sampleRate: result.sampleRate,
              effective: result.effective,
              timestamps: result.timestamps === null ? null : result.timestamps.items.length,
              wavBase64: wav.toString('base64')
            })
          } catch (error) {
            const undecodable = error?.edgeCode === 'undecodable'
            const networkCodes = ['handshake', 'closed', 'timeout', 'empty']
            const info = classifyFailure(error, pending)
            const report = {
              ok: true,
              target,
              provider: 'edge',
              supported: false,
              protocolOk: undecodable ? true : !networkCodes.includes(error?.edgeCode),
              reason: error?.message ?? String(error),
              reasonCode: info.reasonCode ?? null,
              detail: info.detail,
              decoder: null,
              ffmpegPath: findFfmpeg({ ffmpegPath: section.ffmpegPath }),
              format: undecodable ? error.encoded?.format ?? null : null,
              encodedBytes: undecodable ? error.encoded?.bytes?.length ?? null : null,
              timestamps: undecodable && error.encoded?.timestamps ? error.encoded.timestamps.items.length : null,
              durationSeconds: undecodable ? error.encoded?.durationSeconds ?? null : null
            }
            if (info.envName !== undefined) report.envName = info.envName
            if (info.status !== undefined) report.status = info.status
            sendJson(response, 200, report)
          }
          return
        }

        if (target === 'tts') {
          const result = await speak(section, '这是一次连接测试。')
          finalize(result.samples, result.sampleRate, -3)
          const wav = toWavBytes(result.samples, result.sampleRate)
          sendJson(response, 200, {
            ok: true,
            target,
            durationSeconds: Number((result.samples.length / result.sampleRate).toFixed(2)),
            sampleRate: result.sampleRate,
            effective: result.effective,
            timestamps: result.timestamps === null ? null : result.timestamps.items.length,
            wavBase64: wav.toString('base64')
          })
          return
        }

        const sample = sampleWav()
        const answer = await describeAudio(section, sample.wav, '这是什么声音？用一句话回答。')
        sendJson(response, 200, {
          ok: true,
          target,
          answer,
          durationSeconds: sample.durationSeconds,
          wavBase64: sample.wav.toString('base64')
        })
      } catch (error) {
        // A malformed request is an HTTP error; a provider refusal is data the
        // page shows, with `error` keeping the original wording untruncated and
        // the reason fields saying the same fact in a form the page can translate.
        if (isRequestError(error)) {
          replyError(request, response, error)
          return
        }
        const report = { ok: false, error: error?.message ?? String(error) }
        if (pending !== null) {
          const info = classifyFailure(error, pending)
          report.target = pending.target
          report.detail = info.detail
          if (info.reasonCode !== undefined) report.reasonCode = info.reasonCode
          if (info.envName !== undefined) report.envName = info.envName
          if (info.status !== undefined) report.status = info.status
        }
        sendJson(response, 400, report)
      }
    })

    register('/dsh-audio/voices', async (request, response) => {
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: `不支持 ${request.method}` })
          return
        }
        const body = await readJson(request)
        // The provider row comes from the saved config and nowhere else. The
        // page sends `{}`; a body that tries to override the row would be a way
        // to point the saved API key — `listVoices` sends it as a bearer — at a
        // host of the caller's choosing, so any non-empty body is refused.
        const overrides = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null
        if (overrides === null || overrides.length > 0) {
          const received = overrides === null ? '不是 JSON 对象' : overrides.slice(0, 8).join(', ')
          sendJson(response, 400, {
            ok: false,
            error: `音色列表只读取已保存的配置，不接受请求体覆盖（收到：${received}）；页面应发送空对象 {}`
          })
          return
        }
        // A baseUrl persisted before the endpoint checks existed is treated as
        // unconfigured here, so the saved key cannot be sent to that stale host.
        const ttsConfig = voiceLookupSection(config.tts)
        const provider = String(ttsConfig.provider ?? 'minimax').toLowerCase()
        if (provider !== 'minimax' && provider !== 'edge') {
          sendJson(response, 200, { ok: true, source: 'static', provider, items: [], note: `provider ${provider} 不提供音色列表` })
          return
        }
        try {
          const items = await listVoices(ttsConfig)
          sendJson(response, 200, { ok: true, source: 'live', provider, items, note: null })
        } catch (error) {
          const fallback = provider === 'edge' ? EDGE_VOICE_CATALOG : []
          sendJson(response, 200, {
            ok: true,
            source: 'static',
            provider,
            items: fallback,
            note: `实时查询失败：${error?.message ?? error}`
          })
        }
      } catch (error) {
        replyError(request, response, error)
      }
    })

    register('/dsh-audio/validate', async (request, response) => {
      const started = Date.now()
      let pending = null
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: `不支持 ${request.method}` })
          return
        }
        const body = await readJson(request)
        const requested = body.target
        const target = requested === undefined || requested === null || requested === ''
          ? 'check'
          : String(requested).toLowerCase()
        if (target !== 'check' && target !== 'tts') {
          const message = 'target 只能是 check 或 tts'
          sendJson(response, 400, {
            ok: false,
            error: message,
            reasonCode: 'unsupported-target',
            detail: message,
            target: typeof requested === 'string' ? requested.slice(0, 64) : null
          })
          return
        }

        // Only the saved row is consulted from here on: choosing the section is
        // the page's job, choosing an address is not. A switched-off semantic
        // layer stops before the row is even resolved: disabled means no probe,
        // no sample and no request, reported as one readable row.
        if (target === 'check' && !semanticCheckEnabled(config.check)) {
          sendJson(response, 200, {
            ok: true,
            target,
            disabled: true,
            baseUrl: null,
            model: null,
            endpoint: {
              reachable: null,
              status: 0,
              error: SEMANTIC_DISABLED_TEXT,
              detail: SEMANTIC_DISABLED_TEXT,
              reasonCode: 'semantic-disabled'
            },
            audioAccepted: false,
            error: SEMANTIC_DISABLED_TEXT,
            detail: SEMANTIC_DISABLED_TEXT,
            reasonCode: 'semantic-disabled',
            latencyMs: Date.now() - started
          })
          return
        }
        const section = providerSection(target === 'check' ? (config.check ?? {}) : (config.tts ?? {}))
        const resolved = resolveSelfCheckTarget(target, section)
        // Everything a failure needs to name its cause, resolved before the call
        // so a thrown value can still be classified against the saved row.
        pending = {
          target,
          provider: resolved.provider,
          unsupported: resolved.supported === false,
          envName: keyEnvName(section, defaultEnvFor(target, resolved)),
          keyMissing: isKeyMissing(target, resolved, section)
        }
        const report = {
          ok: true,
          target,
          baseUrl: resolved.baseUrl,
          model: resolved.model,
          endpoint: await checkEndpoint(target, resolved, section),
          audioAccepted: false
        }

        if (target === 'check') {
          const sample = sampleWav(0.5)
          try {
            const answer = await describeAudio(section, sample.wav, '这是什么声音？用一句话回答。')
            if (answer.length === 0) throw new Error('端点返回了空内容')
            report.audioAccepted = true
            report.answer = answer.slice(0, ANSWER_LIMIT)
          } catch (error) {
            report.error = failureText(error)
            Object.assign(report, reasonFields(error, pending))
          }
        } else {
          try {
            const result = await speak(section, '自检。')
            report.audioAccepted = true
            report.durationSeconds = Number((result.samples.length / result.sampleRate).toFixed(2))
          } catch (error) {
            report.error = failureText(error)
            Object.assign(report, reasonFields(error, pending))
          }
        }

        // The page has to *display* a provider failure, so even a rejected key
        // leaves here as HTTP 200 with the facts filled in.
        report.latencyMs = Date.now() - started
        sendJson(response, 200, report)
      } catch (error) {
        // Only an unreadable request is an HTTP error; everything the provider
        // did or refused is data the page shows.
        if (isRequestError(error)) {
          replyError(request, response, error)
          return
        }
        const report = { ok: false, error: failureText(error) }
        if (pending !== null) {
          const info = classifyFailure(error, pending)
          report.target = pending.target
          report.detail = info.detail
          if (info.reasonCode !== undefined) report.reasonCode = info.reasonCode
          if (info.envName !== undefined) report.envName = info.envName
          if (info.status !== undefined) report.status = info.status
        }
        sendJson(response, 400, report)
      }
    })
  })
  return true
}
