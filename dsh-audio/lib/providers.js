/**
 * Speech and audio-understanding adapters.
 *
 * MiniMax T2A v2 is the default speech provider; anything speaking the OpenAI
 * `/v1/audio/speech` shape goes through the same path, so "custom" needs no
 * separate code.
 *
 * Timestamps are the part that cannot be guessed: MiniMax returns them in a
 * shape that differs by endpoint and by `subtitle_type`, and the exact field
 * names/units are only visible in a live response. So the parser below accepts
 * every shape we know about, normalizes to seconds, and reports which key it
 * read — or reports `null` and says why, instead of inventing times.
 */

import { decodeWav, encodeWav } from './wav.js'

export const MINIMAX_DEFAULTS = {
  baseUrl: 'https://api.minimax.chat',
  model: 'speech-2.8-hd',
  voice: 'female-shaonv',
  sampleRate: 32000
}

export const OPENAI_TTS_DEFAULTS = {
  baseUrl: 'https://api.openai.com',
  model: 'tts-1',
  voice: 'alloy',
  sampleRate: 24000
}

export const CHAT_AUDIO_DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
  model: 'qwen2.5-omni-7b'
}

/**
 * A curated voice subset, so the model picks real ids instead of inventing one.
 * Any other id from the MiniMax console still works — this is a shortlist.
 */
export const VOICE_CATALOG = [
  { id: 'female-shaonv', note: '中文女声，通用旁白' },
  { id: 'male-qn-qingse', note: '中文男声，偏年轻' },
  { id: 'male-qn-jingying', note: '中文男声，播音腔' },
  { id: 'female-yujie', note: '中文女声，成熟' },
  { id: 'male-qn-badao', note: '中文男声，总裁感' },
  { id: 'female-chengshu', note: '中文女声，稳重' },
  { id: 'presenter_male', note: '中文男主持' },
  { id: 'presenter_female', note: '中文女主持' },
  { id: 'audiobook_male_1', note: '有声书男声' },
  { id: 'audiobook_female_1', note: '有声书女声' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', note: '中文，温暖闺蜜' },
  { id: 'Chinese (Mandarin)_Gentleman', note: '中文，沉稳绅士' },
  { id: 'English_expressive_narrator', note: '英文，表现力旁白' },
  { id: 'English_radiant_girl', note: '英文，明亮少女' },
  { id: 'English_magnetic_voiced_man', note: '英文，磁性男声' }
]

const trimUrl = (url) => String(url).replace(/\/+$/, '')

/**
 * Pull a voice list out of whatever shape `get_voice` answers with.
 * @param {any} payload - parsed response body.
 * @returns {{ id: string, name: string }[]} empty when the shape is unknown.
 */
export function normalizeVoiceList (payload) {
  const candidates = [
    payload?.system_voice,
    payload?.voice_list,
    payload?.voices,
    payload?.data?.system_voice,
    payload?.data?.voice_list,
    payload?.data?.voices
  ]
  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue
    const items = []
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = entry.voice_id ?? entry.voiceId ?? entry.id
      if (typeof id !== 'string' || id.trim().length === 0) continue
      const name = entry.voice_name ?? entry.name ?? entry.description ?? id
      items.push({ id: id.trim(), name: String(name).trim() })
    }
    if (items.length > 0) return items
  }
  return []
}

/**
 * Ask MiniMax for the account's system voices.
 * @throws when no key is configured or the endpoint refuses.
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function listVoices (config) {
  const key = requireKey('MiniMax', config, 'MINIMAX_API_KEY')
  const baseUrl = trimUrl(config?.baseUrl ?? MINIMAX_DEFAULTS.baseUrl)
  const response = await fetch(`${baseUrl}/v1/get_voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ voice_type: 'system' }),
    signal: AbortSignal.timeout(20000)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  const payload = JSON.parse(text)
  const status = payload?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw new Error(`MiniMax: ${payload?.base_resp?.status_msg ?? 'get_voice 失败'}`)
  }
  const items = normalizeVoiceList(payload)
  if (items.length === 0) throw new Error('接口没有返回可识别的音色列表')
  return items
}

/**
 * Resolve an API key from the row, the environment, or fail with instructions.
 *
 * The default env name is what makes the zero-config path work: setting
 * MINIMAX_API_KEY in the environment is enough to use the default provider,
 * without editing any config row.
 */
export function requireKey (label, config, defaultEnv) {
  const inline = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  if (inline.length > 0) return inline
  const envName = config?.apiKeyEnv ?? defaultEnv
  if (typeof envName === 'string' && envName.length > 0) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    throw new Error(`${label}: 环境变量 ${envName} 为空。在启动 DSH 的环境里设置它，或在插件 config 里写 apiKey。`)
  }
  throw new Error(`${label}: 没有配置密钥。给插件 config 加 apiKeyEnv（推荐）或 apiKey。`)
}

async function readError (response) {
  let detail = ''
  try { detail = (await response.text()).slice(0, 400) } catch { /* body already consumed */ }
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

async function postJson (url, body, key, timeoutMs = 120000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`${new URL(url).host} ${await readError(response)}`)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${new URL(url).host} 返回的不是 JSON：${text.slice(0, 160)}`)
  }
}

/** MiniMax returns hex in current APIs and base64 in some wrappers. */
function decodeAudioField (value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('MiniMax: 响应里没有 data.audio')
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 4 === 0) {
    const buffer = Buffer.from(value, 'hex')
    if (buffer.length % 2 === 0) return buffer
  }
  return Buffer.from(value, 'base64')
}

function pcmToWav (pcm, sampleRate, channels = 1) {
  const frames = Math.floor(pcm.length / (2 * channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768
  return { samples, sampleRate, channels }
}

const START_KEYS = ['start', 'start_time', 'startTime', 'begin', 'begin_time', 'onset', 'from']
const END_KEYS = ['end', 'end_time', 'endTime', 'finish', 'finish_time', 'offset', 'to']
const TEXT_KEYS = ['text', 'word', 'content', 'sentence', 'token']

function pick (object, keys) {
  for (const key of keys) {
    const value = object?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function pickText (object) {
  for (const key of TEXT_KEYS) {
    const value = object?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Find and normalize timestamps anywhere in a provider response.
 *
 * Accepts `data.subtitle`, `data.sentences`, `data.words`, top-level variants,
 * `start`/`start_time`/`begin` spellings, and seconds or milliseconds.
 * @param {any} payload - parsed response body.
 * @param {number} audioSeconds - duration of the decoded audio, used only to
 *   decide whether the numbers look like milliseconds.
 * @returns {{ source: string, items: {text: string, start: number, end: number}[] } | null}
 */
export function normalizeTimestamps (payload, audioSeconds) {
  const candidates = [
    ['data.subtitle', payload?.data?.subtitle],
    ['data.subtitles', payload?.data?.subtitles],
    ['data.sentences', payload?.data?.sentences],
    ['data.words', payload?.data?.words],
    ['subtitle', payload?.subtitle],
    ['subtitles', payload?.subtitles],
    ['sentences', payload?.sentences],
    ['words', payload?.words],
    ['extra_info.subtitle', payload?.extra_info?.subtitle],
    ['extra_info.sentences', payload?.extra_info?.sentences],
    ['extra_info.words', payload?.extra_info?.words]
  ]
  for (const [source, list] of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue
    const items = []
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      const start = pick(entry, START_KEYS)
      const text = pickText(entry)
      if (start === undefined || text === undefined) continue
      const end = pick(entry, END_KEYS) ?? start
      items.push({ text, start, end })
    }
    if (items.length === 0) continue
    // Milliseconds if the last mark runs far past the audio, or if the numbers
    // are simply too large to be seconds of this clip.
    const last = Math.max(...items.map((item) => item.end))
    const looksLikeMs = last > Math.max(audioSeconds * 1.5, 60) && last > 1000
    if (looksLikeMs) {
      for (const item of items) {
        item.start /= 1000
        item.end /= 1000
      }
    }
    return {
      source: `${source}${looksLikeMs ? ' (ms→s)' : ''} (${items.length} ${items.length === 1 ? 'item' : 'items'})`,
      items: items.map((item) => ({
        text: item.text,
        start: Number(item.start.toFixed(3)),
        end: Number(item.end.toFixed(3))
      }))
    }
  }
  return null
}

/**
 * Speak one chunk with MiniMax T2A v2.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, timestamps: object|null, effective: object }>}
 */
async function minimaxSpeech (config, text, options = {}) {
  const key = requireKey('MiniMax TTS', config, 'MINIMAX_API_KEY')
  const baseUrl = trimUrl(config.baseUrl ?? MINIMAX_DEFAULTS.baseUrl)
  const sampleRate = Math.round(options.sampleRate ?? config.sampleRate ?? MINIMAX_DEFAULTS.sampleRate)
  const model = options.model ?? config.model ?? MINIMAX_DEFAULTS.model
  const voice = options.voice ?? config.voice ?? MINIMAX_DEFAULTS.voice
  const speed = Number(options.speed ?? config.speed ?? 1)
  const pitch = Number(options.pitch ?? config.pitch ?? 0)
  const subtitle = options.subtitle ?? config.subtitle ?? true
  const subtitleType = options.subtitleType ?? config.subtitleType ?? 'sentence'
  const groupId = config.groupId ?? ''
  const url = `${baseUrl}/v1/t2a_v2${groupId ? `?GroupId=${encodeURIComponent(groupId)}` : ''}`

  const body = {
    model,
    text,
    stream: false,
    voice_setting: { voice_id: voice, speed, vol: Number(options.volume ?? config.volume ?? 1), pitch },
    audio_setting: { sample_rate: sampleRate, bitrate: 128000, format: 'pcm', channel: 1 }
  }
  if (subtitle) {
    body.subtitle_enable = true
    body.subtitle_type = subtitleType
  }

  const payload = await postJson(url, body, key)
  const status = payload?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw new Error(`MiniMax TTS 失败 (${status}): ${payload?.base_resp?.status_msg ?? 'unknown'}`)
  }
  const pcm = decodeAudioField(payload?.data?.audio)
  if (pcm.length < 32) throw new Error('MiniMax TTS 返回的音频为空')
  const decoded = pcmToWav(pcm, sampleRate, 1)

  return {
    ...decoded,
    timestamps: normalizeTimestamps(payload, decoded.samples.length / sampleRate),
    effective: {
      provider: 'minimax',
      host: new URL(url).host,
      model,
      voice,
      speed,
      pitch,
      sampleRate,
      subtitle: subtitle ? subtitleType : 'off'
    }
  }
}

async function openaiSpeech (config, text, options = {}) {
  const key = requireKey('TTS', config, 'OPENAI_API_KEY')
  const baseUrl = trimUrl(config.baseUrl ?? OPENAI_TTS_DEFAULTS.baseUrl)
  const sampleRate = Math.round(options.sampleRate ?? config.sampleRate ?? OPENAI_TTS_DEFAULTS.sampleRate)
  const url = `${baseUrl}/v1/audio/speech`
  const model = options.model ?? config.model ?? OPENAI_TTS_DEFAULTS.model
  const voice = options.voice ?? config.voice ?? OPENAI_TTS_DEFAULTS.voice
  const speed = Number(options.speed ?? config.speed ?? 1)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: config.format ?? 'wav',
      speed
    }),
    signal: AbortSignal.timeout(120000)
  })
  if (!response.ok) throw new Error(`TTS ${await readError(response)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const effective = { provider: 'openai-compatible', host: new URL(url).host, model, voice, speed, sampleRate: null, subtitle: 'unsupported' }

  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    const decoded = decodeWav(bytes)
    effective.sampleRate = decoded.sampleRate
    return { samples: decoded.channels[0], sampleRate: decoded.sampleRate, timestamps: null, effective }
  }
  if (bytes[0] === 0xff || bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    throw new Error('TTS 返回的是 mp3。把 config.tts.format 改成 wav（端点支持时改成 pcm）。')
  }
  effective.sampleRate = sampleRate
  const decoded = pcmToWav(bytes, sampleRate, 1)
  return { ...decoded, timestamps: null, effective }
}

/**
 * Speak one chunk with the configured provider.
 */
export async function speak (config, text, options = {}) {
  const provider = String(options.provider ?? config?.provider ?? 'minimax').toLowerCase()
  if (provider === 'minimax') return minimaxSpeech(config ?? {}, text, options)
  if (provider === 'openai' || provider === 'custom' || provider === 'compatible') {
    return openaiSpeech(config ?? {}, text, options)
  }
  throw new Error(`未知的 TTS provider "${provider}"，支持 minimax / openai / custom。`)
}

/**
 * Ask an audio-input chat model about a wav buffer.
 */
export async function describeAudio (config, wavBytes, question) {
  const key = requireKey('音频理解', config, 'DASHSCOPE_API_KEY')
  const baseUrl = trimUrl(config.baseUrl ?? CHAT_AUDIO_DEFAULTS.baseUrl)
  const url = `${baseUrl}/v1/chat/completions`
  const payload = await postJson(url, {
    model: config.model ?? CHAT_AUDIO_DEFAULTS.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'input_audio', input_audio: { data: wavBytes.toString('base64'), format: 'wav' } }
      ]
    }]
  }, key, 180000)

  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('').trim()
  }
  throw new Error('音频理解端点没有返回可读内容')
}

export function toWav (samples, sampleRate) {
  return encodeWav([samples], sampleRate)
}
