/**
 * Host side of the settings page.
 *
 * Four endpoints on the browser HTTP carrier, all same-origin only:
 *   GET  /dsh-audio/config  → config the running plugin uses; API keys reduced
 *                             to "is it set" flags, never echoed back;
 *   POST /dsh-audio/config  → merge a patch and persist it via the config editor;
 *   POST /dsh-audio/test    → really talk to the provider (synthesize a sentence,
 *                             or describe a sample) and return the audio so the
 *                             page can play what it just produced;
 *   POST /dsh-audio/voices  → ask MiniMax for the account's system voices, and
 *                             fall back to the static shortlist with a marker.
 *
 * Routes are registered inside `ctx.inject(['webServer'], …)`: on a cold boot
 * this plugin can activate before the HTTP carrier is mounted.
 */

import { finalize, renderPreset, toWavBytes } from './audio.js'
import { describeAudio, listVoices, speak } from './providers.js'

const MAX_BODY = 64 * 1024

const TTS_FIELDS = ['provider', 'baseUrl', 'model', 'voice', 'speed', 'pitch', 'sampleRate', 'groupId', 'apiKey', 'apiKeyEnv']
const CHECK_FIELDS = ['provider', 'baseUrl', 'model', 'apiKey', 'apiKeyEnv']

/** Defaults used when the config leaves the env name empty. */
const DEFAULT_ENV = { tts: 'MINIMAX_API_KEY', check: 'DASHSCOPE_API_KEY' }

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
    } else {
      if (value !== null && typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
      out[field] = (value ?? '').trim()
    }
  }
  return out
}

function validate (section) {
  const tts = section.tts ?? {}
  if (tts.provider !== undefined && !['minimax', 'openai', 'custom', 'none'].includes(tts.provider)) {
    throw new Error('供应商只能是 minimax / openai / custom / none')
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
      try {
        if (!sameOriginOnly(request, response)) return
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: `不支持 ${request.method}` })
          return
        }
        const body = await readJson(request)
        const target = body.target === 'check' ? 'check' : 'tts'

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
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
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
        if ((ttsConfig.provider ?? 'minimax') !== 'minimax') {
          sendJson(response, 200, { ok: true, source: 'static', items: [], note: '只有 MiniMax 提供音色列表' })
          return
        }
        try {
          const items = await listVoices(ttsConfig)
          sendJson(response, 200, { ok: true, source: 'live', items, note: null })
        } catch (error) {
          sendJson(response, 200, { ok: true, source: 'static', items: [], note: `实时查询失败：${error?.message ?? error}` })
        }
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
      }
    })
  })
  return true
}
