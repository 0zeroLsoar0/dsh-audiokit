/**
 * Host side of the settings page.
 *
 * Two endpoints on the browser HTTP carrier:
 *   GET  /dsh-audio/config  → the config the running plugin actually uses, with
 *                             the API key reduced to "is it set" flags;
 *   POST /dsh-audio/config  → merge a patch and persist it through the config
 *                             editor, which writes the user's profile layer.
 *
 * Key handling follows the DSH convention the user asked for: leave the key
 * field empty and the provider reads its default environment variable; type
 * something and that value *is* the key. A stored key is never echoed back to
 * the page — only whether one exists.
 *
 * The route is registered inside `ctx.inject(['webServer'], …)` because on a
 * cold boot this plugin can activate before the HTTP carrier is mounted.
 */

const MAX_BODY = 64 * 1024

const TTS_FIELDS = ['provider', 'baseUrl', 'model', 'voice', 'emotion', 'speed', 'pitch', 'sampleRate', 'groupId', 'apiKey', 'apiKeyEnv']
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
    child.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-audio/config',
      handler: async (request, response) => {
        try {
          // Same-origin only: any page open in the browser could otherwise POST
          // to 127.0.0.1:<port> and rewrite the config (a plain form post needs
          // no preflight, so the endpoint has to check for itself).
          const site = request.headers['sec-fetch-site']
          if (site !== undefined && site !== 'same-origin' && site !== 'none') {
            sendJson(response, 403, { ok: false, error: '只接受同源请求' })
            return
          }
          const origin = request.headers.origin
          if (origin !== undefined) {
            let originHost
            try { originHost = new URL(origin).host } catch { originHost = undefined }
            if (originHost !== request.headers.host) {
              sendJson(response, 403, { ok: false, error: '只接受同源请求' })
              return
            }
          }

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
          // Merge into what is stored (not into the redacted view), so a field
          // the page never edited — including a stored key — survives the write.
          let saved = null
          await editor.edit(entry, (current) => {
            const nextTts = { ...(current.tts ?? {}), ...tts }
            const nextCheck = { ...(current.check ?? {}), ...check }
            saved = { tts: nextTts, check: nextCheck }
            return { ...current, tts: nextTts, check: nextCheck }
          })
          sendJson(response, 200, { ok: true, restarting: true, config: saved === null ? null : {
            tts: presentSection(saved.tts, DEFAULT_ENV.tts),
            check: presentSection(saved.check, DEFAULT_ENV.check)
          } })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
      }
    }))
  })
  return true
}
