/**
 * Host side of the settings page.
 *
 * Five endpoints on the browser HTTP carrier, all same-origin only:
 *   GET  /dsh-audio/config  → config the running plugin uses; API keys reduced
 *                             to "is it set" flags, never echoed back;
 *   POST /dsh-audio/config  → merge a patch and persist it via the config editor;
 *   POST /dsh-audio/test    → really talk to the provider (synthesize a sentence,
 *                             or describe a sample) and return the audio so the
 *                             page can play what it just produced. For the Edge
 *                             provider it reports protocolOk/supported/reason
 *                             instead of hiding a missing decoder behind an error;
 *   POST /dsh-audio/voices  → ask the configured provider for its voices
 *                             (MiniMax account list or the Edge catalogue), and
 *                             fall back to the static shortlist with a marker;
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
 * Routes are registered inside `ctx.inject(['webServer'], …)`: on a cold boot
 * this plugin can activate before the HTTP carrier is mounted.
 */

import { finalize, renderPreset, toWavBytes } from './audio.js'
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

const TTS_FIELDS = ['provider', 'baseUrl', 'model', 'voice', 'speed', 'pitch', 'sampleRate', 'groupId', 'ffmpegPath', 'apiKey', 'apiKeyEnv']
const CHECK_FIELDS = ['provider', 'baseUrl', 'model', 'apiKey', 'apiKeyEnv', 'autoValidate']

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
  'unsupported-target'
])

/** How long a reachability probe may take before it is reported as a timeout. */
const PROBE_TIMEOUT_MS = 5000
/** The page shows the model's answer on one line; anything longer is noise. */
const ANSWER_LIMIT = 300
/** A provider error is displayable text, never a stack: keep one paragraph. */
const ERROR_LIMIT = 500

function sendJson (res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * Reject cross-site callers. `Sec-Fetch-Site` is the reliable signal; the
 * `Origin` equality check is deliberately gone because a reverse proxy or an
 * alias host (localhost vs 127.0.0.1) makes it false-positive and blocks the
 * save button.
 */
function sameOriginOnly (request, response) {
  const site = request.headers['sec-fetch-site']
  if (site === undefined || site === 'none') return true
  if (site === 'same-origin' || site === 'same-site') return true
  sendJson(response, 403, { ok: false, error: '只接受同源请求' })
  return false
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

function validate (section) {
  const tts = section.tts ?? {}
  if (tts.provider !== undefined && !['minimax', 'openai', 'custom', 'edge', 'none'].includes(tts.provider)) {
    throw new Error('供应商只能是 minimax / openai / custom / edge / none')
  }
  if (tts.speed !== undefined && (tts.speed < 0.5 || tts.speed > 2)) throw new Error('语速必须在 0.5–2.0 之间')
  if (tts.pitch !== undefined && (tts.pitch < -12 || tts.pitch > 12)) throw new Error('音调必须在 −12..12 半音之间')
  if (tts.sampleRate !== undefined && (tts.sampleRate < 8000 || tts.sampleRate > 48000)) throw new Error('采样率必须在 8000–48000 之间')
  return section
}

/** One section as the page sees it: values minus the key, plus key/env facts. */
function presentSection (section, defaultEnv) {
  const { apiKey, apiKeyEnv, ...rest } = section ?? {}
  const envName = (typeof apiKeyEnv === 'string' && apiKeyEnv.trim().length > 0) ? apiKeyEnv.trim() : defaultEnv
  return {
    ...rest,
    keySet: typeof apiKey === 'string' && apiKey.trim().length > 0,
    envName,
    envPresent: typeof process.env[envName] === 'string' && process.env[envName].trim().length > 0
  }
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
 * @param {object} section - the saved provider row.
 * @param {string} defaultEnv - env var to fall back to for this section.
 * @returns {string} the key, or '' when none is configured.
 */
function probeKey (section, defaultEnv) {
  const inline = typeof section?.apiKey === 'string' ? section.apiKey.trim() : ''
  if (inline.length > 0) return inline
  const envName = typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv.trim().length > 0
    ? section.apiKeyEnv.trim()
    : defaultEnv
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
  const named = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv.trim() : ''
  return named.length > 0 ? named : fallbackEnv
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
  const probe = await probeEndpoint(resolved.baseUrl, probeKey(section, DEFAULT_ENV[target]))
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
  const snapshot = () => ({
    tts: presentSection(config.tts, DEFAULT_ENV.tts),
    check: presentSection(config.check, DEFAULT_ENV.check)
  })

  ctx.inject(['webServer'], (child) => {
    const webServer = child.webServer

    const register = (path, handler) => child.effect(() => webServer.register({ kind: 'exact', path, handler }))

    register('/dsh-audio/config', async (request, response) => {
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, version, config: snapshot() })
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

        const tts = pickFields(body.tts, TTS_FIELDS, ['speed', 'pitch', 'sampleRate'])
        const check = pickFields(body.check, CHECK_FIELDS, [])
        // Merge into what is stored (not into the redacted view), so a field the
        // page never edited — including a stored key — survives the write.
        let saved = null
        await editor.edit(entry, (current) => {
          // Rebuild from the schema-known fields only: a key the schema no longer
          // declares (say, a removed field) must not survive in the stored row.
          const nextTts = { ...pickFields(current.tts ?? {}, TTS_FIELDS, ['speed', 'pitch', 'sampleRate']), ...tts }
          const nextCheck = { ...pickFields(current.check ?? {}, CHECK_FIELDS, []), ...check }
          saved = { tts: nextTts, check: nextCheck }
          return { ...current, tts: nextTts, check: nextCheck }
        })
        sendJson(response, 200, {
          ok: true,
          restarting: true,
          config: saved === null
            ? null
            : { tts: presentSection(saved.tts, DEFAULT_ENV.tts), check: presentSection(saved.check, DEFAULT_ENV.check) }
        })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
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
        const section = target === 'check' ? (config.check ?? {}) : (config.tts ?? {})
        const provider = target === 'check' ? null : String(section.provider ?? 'minimax').toLowerCase()
        pending = {
          target,
          provider,
          envName: keyEnvName(section, defaultEnvFor(target, { provider })),
          keyMissing: isKeyMissing(target, { provider, supported: true }, section)
        }

        if (target === 'tts' && (config.tts?.provider ?? 'minimax') === 'edge') {
          // Edge needs no key. Whether it works depends on the service handshake
          // and on a decoder (ffmpeg or config.decodeAudio) being present, so
          // report those facts instead of collapsing them into one error.
          try {
            const result = await speak(config.tts ?? {}, '这是一次连接测试。')
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
              ffmpegPath: findFfmpeg({ ffmpegPath: config.tts?.ffmpegPath }),
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
              ffmpegPath: findFfmpeg({ ffmpegPath: config.tts?.ffmpegPath }),
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
          const result = await speak(config.tts ?? {}, '这是一次连接测试。')
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
        const answer = await describeAudio(config.check ?? {}, sample.wav, '这是什么声音？用一句话回答。')
        sendJson(response, 200, {
          ok: true,
          target,
          answer,
          durationSeconds: sample.durationSeconds,
          wavBase64: sample.wav.toString('base64')
        })
      } catch (error) {
        // A provider refusal is data the page shows: `error` keeps the original
        // wording untruncated, and the reason fields say the same fact in a form
        // the page can translate.
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
        const ttsConfig = { ...(config.tts ?? {}), ...(body.tts ?? {}) }
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
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
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
        // the page's job, choosing an address is not.
        const section = target === 'check' ? (config.check ?? {}) : (config.tts ?? {})
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
