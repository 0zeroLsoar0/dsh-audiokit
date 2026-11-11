/**
 * One-shot probe for the live MiniMax response.
 *
 *   $env:MINIMAX_API_KEY = "..."      # PowerShell
 *   node tools/probe-minimax.mjs "你好，这是第一句。这是第二句。"
 *
 * It prints the *shape* of the response — which keys exist, whether the audio
 * is hex or base64, and what the timestamp array looks like — instead of the
 * audio blob. Run this once before trusting the parser: field names and units
 * are the one thing that cannot be guessed from documentation.
 *
 * Env overrides: MINIMAX_BASE_URL, MINIMAX_MODEL, MINIMAX_VOICE, SUBTITLE_TYPE.
 */

import { writeFileSync } from 'node:fs'
import { normalizeTimestamps } from '../lib/providers.js'

const key = process.env.MINIMAX_API_KEY
if (!key) {
  console.error('需要环境变量 MINIMAX_API_KEY')
  process.exit(2)
}

const text = process.argv[2] ?? '你好，这是第一句。这是第二句。'
const baseUrl = (process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.chat').replace(/\/+$/, '')
const model = process.env.MINIMAX_MODEL ?? 'speech-2.8-hd'
const voice = process.env.MINIMAX_VOICE ?? 'female-shaonv'
const subtitleType = process.env.SUBTITLE_TYPE ?? 'sentence'

const body = {
  model,
  text,
  stream: false,
  voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
  audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'pcm', channel: 1 },
  subtitle_enable: true,
  subtitle_type: subtitleType
}

console.log(`POST ${baseUrl}/v1/t2a_v2  model=${model} voice=${voice} subtitle=${subtitleType}`)
const started = Date.now()
const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000)
})
const raw = await response.text()
console.log(`HTTP ${response.status}  ${Date.now() - started}ms  ${raw.length} bytes`)

if (!response.ok) {
  console.log(raw.slice(0, 800))
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(raw)
} catch {
  console.log('返回不是 JSON：', raw.slice(0, 400))
  process.exit(1)
}

const audio = payload?.data?.audio
const encoding = typeof audio !== 'string'
  ? 'none'
  : /^[0-9a-fA-F]+$/.test(audio) && audio.length % 4 === 0 ? 'hex' : 'base64'
const audioBytes = typeof audio === 'string'
  ? Math.floor(encoding === 'hex' ? audio.length / 2 : audio.length * 0.75)
  : 0

console.log('\n--- 结构 ---')
console.log('顶层键：', Object.keys(payload).join(', '))
console.log('data 键：', Object.keys(payload.data ?? {}).join(', ') || '(无)')
console.log('extra_info 键：', Object.keys(payload.extra_info ?? {}).join(', ') || '(无)')
console.log('base_resp：', JSON.stringify(payload.base_resp ?? {}))
console.log(`音频：${encoding}，约 ${audioBytes} 字节 ≈ ${(audioBytes / 2 / 32000).toFixed(2)}s（按 32k/16bit/单声道估）`)

// Strip the audio and keep the rest: that is what we actually need to read.
const { data, ...rest } = payload
writeFileSync('minimax-response.json', JSON.stringify({ ...rest, data: { ...data, audio: '<stripped>' } }, null, 2))
console.log('已把响应骨架写到 minimax-response.json（音频已剔除）')

const timestamps = normalizeTimestamps(payload, audioBytes / 2 / 32000)
console.log('\n--- 时间戳 ---')
if (timestamps === null) {
  console.log('没有解析到任何时间戳。可能原因：')
  console.log('  1) 该模型/接口不返回；2) 字段名不在已知集合里；3) 需要流式或异步长文本接口。')
  console.log('把 minimax-response.json 发我，我按真实结构改解析器。')
} else {
  console.log(`来源：${timestamps.source}`)
  for (const item of timestamps.items.slice(0, 6)) {
    console.log(`  [${item.start.toFixed(3)} → ${item.end.toFixed(3)}] ${item.text}`)
  }
  if (timestamps.items.length > 6) console.log(`  … 共 ${timestamps.items.length} 条`)
}
