/**
 * Host side of the settings page.
 *
 * Two endpoints on the browser HTTP carrier:
 *   GET  /dsh-audio/config  → the resolved config the running plugin actually
 *                             uses (defaults included, not the raw patch);
 *   POST /dsh-audio/config  → merge a patch and persist it through the config
 *                             editor, which writes the user's profile layer.
 *
 * Writing through the config editor (rather than editing the patch file) keeps
 * the user's comments and other plugins' rows intact, and it makes the change
 * survive plugin upgrades.
 *
 * The route is registered inside `ctx.effect` so it is disposed with the
 * plugin: an un-owned route outlives a reload and the next activation dies on
 * "duplicate exact route".
 */

const MAX_BODY = 64 * 1024

const TTS_FIELDS = ['provider', 'baseUrl', 'model', 'voice', 'emotion', 'speed', 'pitch', 'sampleRate', 'groupId', 'apiKeyEnv']
const CHECK_FIELDS = ['provider', 'baseUrl', 'model', 'apiKeyEnv']

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
      if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
      out[field] = value.trim()
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

/**
 * Register the settings endpoints.
 *
 * Waits for the `webServer` service instead of reading it eagerly: on a cold
 * boot this plugin may activate before the HTTP carrier is mounted, and an
 * eager `ctx.get('webServer')` would silently return undefined and leave the
 * page fetching a 404.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved config captured at activation.
 * @param {string} version - plugin version, echoed to the page.
 * @returns {boolean} whether the injection was registered.
 */
export function registerSettingsRoute (ctx, config, version) {
  const snapshot = () => ({
    tts: { ...(config.tts ?? {}) },
    check: { ...(config.check ?? {}) }
  })

  ctx.inject(['webServer'], (child) => {
    const webServer = child.webServer
    child.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-audio/config',
      handler: async (request, response) => {
        try {
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

          const next = { ...snapshot() }
          const tts = pickFields(body.tts, TTS_FIELDS, ['speed', 'pitch', 'sampleRate'])
          const check = pickFields(body.check, CHECK_FIELDS, [])
          if (Object.keys(tts).length > 0) next.tts = { ...next.tts, ...tts }
          if (Object.keys(check).length > 0) next.check = { ...next.check, ...check }

          await editor.edit(entry, (current) => ({
            ...current,
            tts: next.tts,
            check: next.check
          }))
          sendJson(response, 200, { ok: true, config: next, restarting: true })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
      }
    }))
  })
  return true
}
