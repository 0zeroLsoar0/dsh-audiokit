/**
 * Optional backend: an external, pure audio-generation HTTP endpoint.
 *
 * Nothing in this module runs unless the user points it at a service. There is
 * no default host and no bundled client, so an unconfigured plugin stays
 * offline and dependency-free; a request only exists once `config.generate`
 * (or the AUDIO_GENERATE_* environment variables) names an endpoint.
 *
 * Two request shapes are supported:
 *
 *   openai-audio   POST {baseUrl}/v1/audio/generations
 *   custom         POST {baseUrl}   (the full endpoint the user entered)
 *
 * Both send `{ model?, prompt, duration, response_format: 'wav' }` with
 * `Authorization: Bearer <key>`, and both accept either a binary `audio/wav`
 * body or a JSON body carrying base64 audio in `data[0].b64_json` /
 * `audio_base64`. JSON inside a mislabelled content-type is still recognised by
 * its first byte; HTML is rejected even with HTTP 200, because a proxy login
 * page or gateway error rendered as "audio" would otherwise be written out as
 * a noise file and blamed on the model.
 *
 * Determinism is deliberately NOT promised: a remote model is not a seedable
 * function, so the same prompt may return different audio on every call. The
 * result therefore always says `effective.deterministic: false`, and the
 * default file name is a hash of the bytes actually received rather than of the
 * prompt — two different takes get two different files instead of silently
 * overwriting each other.
 *
 * Failure codes live here too (`GENERATE_REASON_CODES`) and are attached to the
 * thrown error as `reasonCode` (plus `status` / `envName` where known). The set
 * mirrors the settings page's `classifyFailure()` on purpose but does not
 * import it, so neither module can drag the other's failure contract along.
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { defaultOutputPath, resolvePath, writeFileAtomic } from './audio.js'

/** Defaults used when `config.generate` leaves a field empty. */
export const GENERATE_DEFAULTS = Object.freeze({
  provider: 'openai-audio',
  timeoutMs: 120000,
  maxBytes: 32 * 1024 * 1024
})

/** Request shapes this module knows how to speak. */
export const GENERATE_PROVIDERS = Object.freeze(['openai-audio', 'custom'])

/** Environment variables the resolver falls back to. */
export const GENERATE_ENV = Object.freeze({
  apiKey: 'AUDIO_GENERATE_API_KEY',
  baseUrl: 'AUDIO_GENERATE_BASE_URL'
})

/**
 * Machine-readable failure codes. One code per distinct thing the user can fix;
 * the human message stays the primary text and the code is what a tool, a log
 * or a caller can switch on.
 *
 *   missing-key          no key in config and the environment variable is empty
 *   no-base-url          no usable endpoint URL configured
 *   provider-none        generation is switched off (provider = none)
 *   unsupported-target   the configured provider name is not one of GENERATE_PROVIDERS
 *   endpoint-unreachable DNS, TLS, refused, or a network error before an answer
 *   http-4xx             the service answered and refused (bad key, unknown model)
 *   http-5xx             the service answered and failed on its own side
 *   timeout              no complete answer within config.generate.timeoutMs
 *   too-large            the response exceeded config.generate.maxBytes
 *   bad-response         a 2xx that is not the audio/JSON shape this endpoint returns
 *   not-wav              the audio delivered is not a decodable RIFF/WAVE file
 */
export const GENERATE_REASON_CODES = Object.freeze([
  'missing-key',
  'no-base-url',
  'provider-none',
  'unsupported-target',
  'endpoint-unreachable',
  'http-4xx',
  'http-5xx',
  'timeout',
  'too-large',
  'bad-response',
  'not-wav'
])

const OPENAI_AUDIO_PATH = '/v1/audio/generations'
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MIN_MAX_BYTES = 1024
const MAX_MAX_BYTES = 512 * 1024 * 1024
const ERROR_SNIPPET_LIMIT = 400
const WAV_HEAD_PLACEHOLDER = '未标注'

/* ---- errors ---- */

/**
 * Build a failure that carries its machine-readable code.
 * @param {string} reasonCode - one of GENERATE_REASON_CODES.
 * @param {string} message - readable Chinese text naming what to fix.
 * @param {object} [extra] - `status`, `envName`, `host`, `url`, `timeoutMs`, `limit`.
 * @returns {Error & { reasonCode: string }}
 */
export function generateError (reasonCode, message, extra = {}) {
  const error = new Error(message)
  error.name = 'GenerateProviderError'
  error.reasonCode = reasonCode
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) error[key] = value
  }
  return error
}

/**
 * Classify an arbitrary failure into a GENERATE_REASON_CODES value.
 *
 * The provider path attaches `reasonCode` itself, so this is the safety net for
 * errors that arrive without one (a caller's own guard, a fetch polyfill, an
 * unexpected throw). It only returns a code when the shape is recognisable:
 * inventing a code for an unknown error would replace a readable message with a
 * guess.
 * @param {any} error - anything thrown on the generation path.
 * @returns {{ detail: string, reasonCode?: string, status?: number, envName?: string }}
 */
export function classifyGenerateFailure (error) {
  const detail = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error)
  const base = { detail }
  const extra = (value, key) => (value !== undefined && value !== null && value !== '' ? { [key]: value } : {})

  if (typeof error?.reasonCode === 'string' && GENERATE_REASON_CODES.includes(error.reasonCode)) {
    return {
      ...base,
      reasonCode: error.reasonCode,
      ...extra(Number.isFinite(error?.status) ? error.status : undefined, 'status'),
      ...extra(typeof error?.envName === 'string' ? error.envName : undefined, 'envName')
    }
  }

  const statusMatch = /HTTP (\d{3})/.exec(detail)
  if (statusMatch !== null) {
    const status = Number(statusMatch[1])
    if (status >= 400 && status < 500) return { ...base, reasonCode: 'http-4xx', status }
    if (status >= 500 && status < 600) return { ...base, reasonCode: 'http-5xx', status }
  }
  const envMatch = /环境变量\s*([^\s，。：]+)\s*为空/.exec(detail)
  if (envMatch !== null) return { ...base, reasonCode: 'missing-key', envName: envMatch[1] }
  if (/没有配置密钥|apiKey|AUDIO_GENERATE_API_KEY/.test(detail)) return { ...base, reasonCode: 'missing-key' }
  if (/没有配置生成端点|baseUrl|AUDIO_GENERATE_BASE_URL|Failed to parse URL|Invalid URL/.test(detail)) {
    return { ...base, reasonCode: 'no-base-url' }
  }
  if (/超过(了)?上限|too large|maxBytes/.test(detail)) return { ...base, reasonCode: 'too-large' }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /超时|timed? ?out|aborted/i.test(detail)) {
    return { ...base, reasonCode: 'timeout' }
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up/i.test(detail)) {
    return { ...base, reasonCode: 'endpoint-unreachable' }
  }
  if (/不是 wav|not a RIFF|不是音频|text\/html|返回的是 HTML/i.test(detail)) return { ...base, reasonCode: 'not-wav' }
  return base
}

/* ---- configuration ---- */

function readString (value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readFinite (value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** A resolved object is what this module produces, as opposed to the raw plugin config. */
function isResolved (value) {
  return value !== null && typeof value === 'object' &&
    typeof value.provider === 'string' &&
    typeof value.apiKeyEnv === 'string' &&
    Array.isArray(value.missing) &&
    Number.isFinite(value.timeoutMs) &&
    Number.isFinite(value.maxBytes)
}

/**
 * Normalize `config.generate` (plus the AUDIO_GENERATE_* environment fallbacks)
 * into the shape `generateAudio` and `audio_generate` both consume.
 *
 * This never throws and never opens a socket: an unconfigured plugin simply
 * comes back with `configured: false` and a `missing` list, so registration and
 * documentation can run offline. The actual "why can't I generate" error is
 * raised at call time by `generateAudio`, where it is actionable.
 *
 * Lookup order for each value: the config row, then the environment variable.
 * Setting `apiKeyEnv: ''` explicitly disables the environment fallback (useful
 * for a key that must live in the config file only).
 * @param {object} [config] - the plugin config; only `config.generate` is read.
 * @param {Record<string, string|undefined>} [env] - environment source, `process.env` by default.
 * @returns {{ provider: string, baseUrl: string, apiKey: string, apiKeyEnv: string,
 *   model: string, timeoutMs: number, maxBytes: number, enabled: boolean,
 *   unsupported: boolean, configured: boolean, missing: string[] }}
 */
export function resolveGenerateConfig (config, env = process.env) {
  const section = config?.generate !== null && typeof config?.generate === 'object' ? config.generate : {}
  const rawEnv = env !== null && typeof env === 'object' ? env : {}

  const provider = readString(section.provider).toLowerCase() || GENERATE_DEFAULTS.provider
  const unsupported = provider !== 'none' && !GENERATE_PROVIDERS.includes(provider)

  const apiKeyEnv = 'apiKeyEnv' in section ? readString(section.apiKeyEnv) : GENERATE_ENV.apiKey
  const envKey = apiKeyEnv === '' ? '' : readString(rawEnv[apiKeyEnv])
  const apiKey = readString(section.apiKey) || envKey

  const baseUrl = (readString(section.baseUrl) || readString(rawEnv[GENERATE_ENV.baseUrl])).replace(/\/+$/, '')
  const model = readString(section.model)
  const timeoutMs = clamp(
    Math.round(readFinite(section.timeoutMs, GENERATE_DEFAULTS.timeoutMs)),
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  )
  const maxBytes = clamp(
    Math.round(readFinite(section.maxBytes, GENERATE_DEFAULTS.maxBytes)),
    MIN_MAX_BYTES,
    MAX_MAX_BYTES
  )

  const missing = []
  if (provider !== 'none' && !unsupported) {
    if (baseUrl === '') missing.push('baseUrl')
    if (apiKey === '') missing.push('apiKey')
  }

  return {
    provider,
    baseUrl,
    apiKey,
    apiKeyEnv,
    model,
    timeoutMs,
    maxBytes,
    enabled: provider !== 'none',
    unsupported,
    configured: provider !== 'none' && !unsupported && missing.length === 0,
    missing
  }
}

/** Fail with the actionable reason when the resolved settings cannot make a call. */
function assertUsable (resolved) {
  if (resolved.provider === 'none') {
    throw generateError('provider-none', 'audio_generate 已关闭（config.generate.provider = none）')
  }
  if (resolved.unsupported) {
    throw generateError(
      'unsupported-target',
      `未知的生成 provider "${resolved.provider}"，支持 ${GENERATE_PROVIDERS.join(' / ')}（或 provider: none 关闭）`
    )
  }
  if (resolved.baseUrl === '') {
    throw generateError(
      'no-base-url',
      '没有配置生成端点：给插件 config.generate.baseUrl 填 URL，或设置环境变量 AUDIO_GENERATE_BASE_URL'
    )
  }
  if (resolved.apiKey === '') {
    throw generateError(
      'missing-key',
      resolved.apiKeyEnv === ''
        ? '没有配置密钥：给 config.generate.apiKey（config.generate.apiKeyEnv 为空，已禁用环境变量回退）'
        : `没有配置密钥：给 config.generate.apiKey，或在环境里设置 ${resolved.apiKeyEnv}`,
      { envName: resolved.apiKeyEnv }
    )
  }
}

/**
 * Turn the resolved provider/baseUrl into a request URL and its host.
 * `openai-audio` appends the fixed path (so baseUrl is a host root, consistent
 * with the TTS rows); `custom` uses the configured value verbatim.
 */
function endpointUrl (resolved) {
  const raw = resolved.provider === 'custom'
    ? resolved.baseUrl
    : `${resolved.baseUrl}${OPENAI_AUDIO_PATH}`
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw generateError('no-base-url', `生成端点不是合法 URL：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw generateError('no-base-url', `生成端点必须是 http(s)：${raw}`)
  }
  return { url: parsed.href, host: parsed.host }
}

function requestBody (resolved, modelOverride, prompt, duration) {
  const model = readString(modelOverride) || resolved.model
  const body = { prompt, duration, response_format: 'wav' }
  // An empty model is left out instead of sent as "": a service that validates
  // model names rejects "" with a 4xx that looks like a bad prompt.
  if (model !== '') body.model = model
  return body
}

/* ---- response handling ---- */

function cancelBody (response) {
  try {
    response?.body?.cancel?.()
  } catch { /* body already closed */ }
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * Content-Length is checked first (so an oversized answer is refused without
 * downloading it), and the running total is checked on every chunk (so a
 * chunked response with no length cannot stream past the limit either).
 * @param {Response} response - fetch response.
 * @param {number} limit - maximum accepted bytes.
 * @param {string} host - endpoint host, used in the error message.
 * @returns {Promise<Buffer>}
 */
async function readBodyBounded (response, limit, host) {
  const declared = Number.parseInt(String(response.headers.get('content-length') ?? ''), 10)
  if (Number.isFinite(declared) && declared > limit) {
    cancelBody(response)
    throw generateError(
      'too-large',
      `${host} 的响应声明 ${declared} 字节，超过上限 ${limit} 字节（config.generate.maxBytes）`,
      { limit, bytes: declared, host }
    )
  }
  if (response.body === null || response.body === undefined) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        try { await reader.cancel() } catch { /* stream already errored */ }
        throw generateError(
          'too-large',
          `${host} 的响应超过上限 ${limit} 字节（config.generate.maxBytes），已中止读取`,
          { limit, bytes: total, host }
        )
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
  return Buffer.concat(chunks)
}

/** Read at most `limit` characters of a failing response for the error text. */
async function readErrorSnippet (response, limit = ERROR_SNIPPET_LIMIT) {
  try {
    const bytes = await readBodyBounded(response, Math.max(limit, 1024), 'endpoint')
    return bytes.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, limit)
  } catch {
    cancelBody(response)
    return ''
  }
}

/** Value of the first non-whitespace byte, or -1 when the body is blank. */
function firstContentByte (bytes) {
  for (let index = 0; index < Math.min(bytes.length, 512); index += 1) {
    const byte = bytes[index]
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte
  }
  return -1
}

/** Pull the first base64 audio payload out of the JSON shapes we accept. */
function firstBase64Audio (payload) {
  const data = payload?.data
  const candidates = [
    Array.isArray(data) ? data[0]?.b64_json : data?.b64_json,
    payload?.audio_base64,
    payload?.data?.audio_base64
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

function decodeJsonAudio (bytes, host, contentType, status) {
  let payload
  try {
    payload = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw generateError('bad-response', `${host} 返回的 JSON 无法解析：${error.message}`, { status, contentType, host })
  }
  const base64 = firstBase64Audio(payload)
  if (base64 === '') {
    const providerMessage = payload?.error?.message ?? payload?.error ?? payload?.message
    const note = typeof providerMessage === 'string' && providerMessage.trim() !== ''
      ? `（provider 说明：${providerMessage.trim().slice(0, 200)}）`
      : ''
    throw generateError(
      'bad-response',
      `${host} 的 JSON 里没有音频：需要 data[0].b64_json 或 audio_base64${note}`,
      { status, contentType, host }
    )
  }
  // Some gateways wrap the payload as a data URI; the prefix is not base64.
  const audio = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64')
  if (audio.length === 0) {
    throw generateError('bad-response', `${host} 的 base64 音频解码后为空`, { status, contentType, host })
  }
  return audio
}

function notWavError (bytes, host, contentType, status) {
  const head = bytes.subarray(0, 16).toString('hex')
  const asciiHead = bytes.subarray(0, 8).toString('ascii').trimStart()
  const hint = bytes[0] === 0xff || bytes.subarray(0, 3).toString('ascii') === 'ID3'
    ? '（返回的是 mp3 一类编码音频；本工具只接受 wav）'
    : asciiHead.startsWith('<')
      ? '（返回的是 HTML 页面）'
      : ''
  return generateError(
    'not-wav',
    `${host} 返回的不是 wav（content-type: ${contentType || WAV_HEAD_PLACEHOLDER}，头部 ${head}）${hint}`,
    { status, contentType, host }
  )
}

/**
 * Inspect the RIFF/WAVE container without decoding samples.
 *
 * The full decoder lives in `wav.js`, but a remote response can be megabytes
 * and all this path needs is the header: sample rate, channels, bit depth and
 * how many frames the data chunk actually holds. Returning null means "this is
 * not a usable WAVE file", which the caller turns into `not-wav`.
 * @param {Buffer} bytes - complete candidate file bytes.
 * @returns {{ audioFormat: number, channels: number, sampleRate: number, bitDepth: number,
 *   frames: number, dataBytes: number, durationSeconds: number } | null}
 */
export function inspectWavHeader (bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return null
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null

  let cursor = 12
  let format = null
  let data = null
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString('ascii', cursor, cursor + 4)
    const size = bytes.readUInt32LE(cursor + 4)
    const start = cursor + 8
    if (id === 'fmt ') {
      if (start + 16 > bytes.length) return null
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bitDepth: bytes.readUInt16LE(start + 14)
      }
    } else if (id === 'data') {
      // A streaming writer may leave 0xFFFFFFFF here; only the bytes present
      // can be trusted.
      data = { start, size: Math.min(size, bytes.length - start) }
      break
    }
    cursor = start + size + (size % 2)
  }
  if (format === null || data === null) return null

  const bytesPerSample = format.bitDepth / 8
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) return null
  if (!(format.channels > 0) || !(format.sampleRate > 0)) return null
  if (data.size < bytesPerSample * format.channels) return null
  const frames = Math.floor(data.size / (bytesPerSample * format.channels))
  if (frames <= 0) return null
  return { ...format, frames, dataBytes: data.size, durationSeconds: frames / format.sampleRate }
}

/**
 * Read a successful response and turn it into an audio result.
 *
 * Order matters: a text/html 200 is rejected before the body is treated as
 * audio, the size cap applies before and during the read, JSON is recognised by
 * content-type or first byte, and only then is the WAVE header validated.
 * @param {Response} response - a 2xx fetch response.
 * @param {object} resolved - resolved generate config.
 * @param {string} host - endpoint host.
 * @returns {Promise<{ bytes: Buffer, wav: object, httpStatus: number, contentType: string, url: string, host: string }>}
 */
async function readSuccessResponse (response, resolved, host) {
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  const status = response.status

  // A proxy's HTML error page with a 200 is the classic trap; the content-type
  // is enough to refuse it before a byte is interpreted as audio.
  if (contentType.includes('html') || (contentType.startsWith('text/') && !contentType.includes('json'))) {
    const snippet = await readErrorSnippet(response, 200)
    throw generateError(
      'bad-response',
      `${host} 返回的是 ${contentType || 'text/html'} 而不是音频${snippet === '' ? '' : `：${snippet}`}`,
      { status, contentType, host }
    )
  }

  const received = await readBodyBounded(response, resolved.maxBytes, host)
  if (received.length === 0) {
    throw generateError(
      'bad-response',
      `${host} 返回了空响应（HTTP ${status}，content-type: ${contentType || WAV_HEAD_PLACEHOLDER}）`,
      { status, contentType, host }
    )
  }

  // JSON by declared type, or by its opening brace when a server mislabels it.
  const jsonLike = contentType.includes('json') || firstContentByte(received) === 0x7b
  const audioBytes = jsonLike ? decodeJsonAudio(received, host, contentType, status) : received

  const wav = inspectWavHeader(audioBytes)
  if (wav === null) throw notWavError(audioBytes, host, contentType, status)

  return {
    bytes: audioBytes,
    wav,
    httpStatus: status,
    contentType,
    url: response.url ?? '',
    host
  }
}

/** Map a transport/read failure to a coded, readable error. */
function transportError (error, signal, resolved, host) {
  if (typeof error?.reasonCode === 'string') return error
  const aborted = signal?.aborted === true || error?.name === 'TimeoutError' || error?.name === 'AbortError'
  if (aborted) {
    return generateError(
      'timeout',
      `音频生成超时：${host} 在 ${resolved.timeoutMs} ms 内没有返回（config.generate.timeoutMs）`,
      { timeoutMs: resolved.timeoutMs, host }
    )
  }
  return generateError('endpoint-unreachable', `无法连接生成端点 ${host}：${error?.message ?? error}`, { host })
}

/* ---- generation ---- */

/**
 * Send one prompt to the configured audio-generation service.
 *
 * The bytes returned are exactly what the service delivered (validated, never
 * re-encoded): callers write them as-is, so a later `decodeWav` sees the real
 * container. Writing is `saveGeneratedAudio`'s job, keeping this function easy
 * to test without touching the filesystem.
 *
 * @param {object} configOrResolved - the plugin config (with `generate`) or the
 *   object returned by `resolveGenerateConfig`.
 * @param {{ prompt: string, duration: number, model?: string }} request
 * @returns {Promise<{ bytes: Buffer, wav: object, durationSeconds: number,
 *   sampleRate: number, channels: number, bitDepth: number, httpStatus: number,
 *   contentType: string, url: string, host: string, effective: object }>}
 * @throws {Error & { reasonCode: string }} a GENERATE_REASON_CODES failure.
 */
export async function generateAudio (configOrResolved, request = {}) {
  const resolved = isResolved(configOrResolved) ? configOrResolved : resolveGenerateConfig(configOrResolved)
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('generateAudio: prompt must be a non-empty string')
  const duration = Number(request?.duration ?? 5)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('generateAudio: duration must be a positive number')

  assertUsable(resolved)
  const { url, host } = endpointUrl(resolved)
  const body = requestBody(resolved, request?.model, prompt, duration)
  // The only timeout clock: it covers connect, headers and body streaming, and
  // it is the caller's configured value, not a hard-coded one.
  const signal = AbortSignal.timeout(resolved.timeoutMs)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/wav, application/json',
        Authorization: `Bearer ${resolved.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    throw transportError(error, signal, resolved, host)
  }

  if (!response.ok) {
    const detail = await readErrorSnippet(response)
    const status = response.status
    const reasonCode = status >= 500 ? 'http-5xx' : status >= 400 ? 'http-4xx' : 'bad-response'
    throw generateError(
      reasonCode,
      `${host} HTTP ${status}${detail === '' ? '' : `: ${detail}`}`,
      { status, host, url }
    )
  }

  let received
  try {
    received = await readSuccessResponse(response, resolved, host)
  } catch (error) {
    throw transportError(error, signal, resolved, host)
  }

  return {
    bytes: received.bytes,
    wav: received.wav,
    durationSeconds: received.wav.durationSeconds,
    sampleRate: received.wav.sampleRate,
    channels: received.wav.channels,
    bitDepth: received.wav.bitDepth,
    httpStatus: received.httpStatus,
    contentType: received.contentType,
    url: received.url,
    host: received.host,
    effective: {
      provider: resolved.provider,
      host: received.host,
      model: resolved.model === '' ? null : resolved.model,
      responseFormat: 'wav',
      sampleRate: received.wav.sampleRate,
      channels: received.wav.channels,
      durationSeconds: received.wav.durationSeconds,
      requestedDurationSeconds: duration,
      remote: true,
      // A remote model is not a seedable function: the same prompt may return
      // different audio on every call, and nothing here can promise otherwise.
      deterministic: false
    }
  }
}

/** Keep the promised wav contract: a non-wav audio extension becomes `.wav`. */
function withWavExtension (target) {
  if (/\.wav$/i.test(target)) return target
  if (/\.(mp3|flac|ogg|m4a|opus|aac)$/i.test(target)) return target.replace(/\.[a-z0-9]+$/i, '.wav')
  return `${target}.wav`
}

/**
 * Write received audio through the same atomic writer every other tool uses.
 *
 * The default name is `<first 12 hex of sha256(bytes)>.wav` under
 * `assets/audio/` — a content hash, so re-running the same prompt after the
 * model changed its mind produces a new file instead of overwriting the old
 * take. The requested `out` wins when given.
 * @param {string} cwd - session directory.
 * @param {Buffer} bytes - validated wav bytes.
 * @param {string} [requestedOut] - caller path, relative or absolute.
 * @returns {Promise<{ target: string, hash: string, bytes: number }>}
 */
export async function saveGeneratedAudio (cwd, bytes, requestedOut) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('saveGeneratedAudio: bytes must be a non-empty Buffer')
  }
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const requested = resolvePath(cwd, requestedOut)
  const target = requested === undefined
    ? defaultOutputPath(cwd, 'generate', hash)
    : withWavExtension(requested)
  await writeFileAtomic(target, bytes)
  let size = bytes.length
  try {
    size = (await stat(target)).size
  } catch { /* keep the in-memory length */ }
  return { target, hash, bytes: size }
}
