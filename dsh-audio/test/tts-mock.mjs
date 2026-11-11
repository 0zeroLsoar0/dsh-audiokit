/**
 * Adapter tests against a local mock, so the TTS and audio-understanding paths
 * are exercised end to end without a real key.
 *
 * What this cannot prove: whether the live MiniMax response uses the field
 * names and units assumed here. That needs one real call — see README.
 */

import { createServer } from 'node:http'
import { normalizeTimestamps, speak, describeAudio } from '../lib/providers.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const seen = []
let mode = 'ok'

function pcmHex (seconds, sampleRate = 32000, hz = 440) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) samples[i] = Math.sin(2 * Math.PI * hz * (i / sampleRate)) * 0.5
  const buffer = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(Math.round(samples[i] * 32767), i * 2)
  return buffer.toString('hex')
}

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw.length > 0 ? JSON.parse(raw) : {}
    seen.push({ url: request.url, auth: request.headers.authorization, body })

    if (request.url.startsWith('/v1/t2a_v2')) {
      if (mode === 'error') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }))
        return
      }
      const seconds = 1.2
      const payload = {
        data: { audio: pcmHex(seconds), status: 2 },
        extra_info: { audio_length: seconds * 1000 }
      }
      if (body.subtitle_enable) {
        payload.data.subtitle = [
          { text: '第一句。', start: 0, end: 600 },
          { text: '第二句。', start: 600, end: 1200 }
        ]
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
      return
    }

    if (request.url === '/v1/audio/speech') {
      if (mode === 'mp3') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' })
        response.end(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]))
        return
      }
      const samples = new Float32Array(24000)
      for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(2 * Math.PI * 220 * i / 24000) * 0.4
      response.writeHead(200, { 'Content-Type': 'audio/wav' })
      response.end(encodeWav([samples], 24000))
      return
    }

    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: ' 像一扇铁门在空旷大厅里关上。' } }] }))
      return
    }

    response.writeHead(404)
    response.end('nope')
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const config = () => ({ provider: 'minimax', baseUrl: base, model: 'speech-2.8-hd', voice: 'female-shaonv', apiKey: 'test-key' })

console.log('-- minimax happy path --')
{
  seen.length = 0
  const result = await speak(config(), '第一句。第二句。')
  check('audio decodes', Math.abs(result.samples.length / result.sampleRate - 1.2) < 0.01, `${result.samples.length}`)
  check('timestamps parsed', result.timestamps !== null)
  if (result.timestamps) {
    check('two marks', result.timestamps.items.length === 2, JSON.stringify(result.timestamps.items))
    check('ms converted', Math.abs(result.timestamps.items[1].start - 0.6) < 1e-6, String(result.timestamps.items[1].start))
    check('source named', result.timestamps.source.includes('data.subtitle'), result.timestamps.source)
  }
  const sent = seen[0].body
  check('sent subtitle_enable', sent.subtitle_enable === true)
  check('sent subtitle_type', sent.subtitle_type === 'sentence')
  check('auto emotion is omitted', sent.voice_setting.emotion === undefined, JSON.stringify(sent.voice_setting))
  check('requests pcm', sent.audio_setting.format === 'pcm')
  check('bearer token', seen[0].auth === 'Bearer test-key', String(seen[0].auth))
  check('effective params reported', result.effective.model === 'speech-2.8-hd' && result.effective.sampleRate === 32000, JSON.stringify(result.effective))
}

console.log('-- explicit emotion / subtitle off --')
{
  seen.length = 0
  await speak(config(), '测试', { emotion: 'sad', subtitle: false })
  const sent = seen[0].body
  check('emotion forwarded', sent.voice_setting.emotion === 'sad')
  check('no subtitle when off', sent.subtitle_enable === undefined)
}

console.log('-- provider error --')
{
  mode = 'error'
  try {
    await speak(config(), '测试')
    check('error surfaced', false, 'no throw')
  } catch (error) {
    check('error mentions status', /1004|invalid api key/i.test(error.message), error.message)
  }
  mode = 'ok'
}

console.log('-- openai-compatible path --')
{
  seen.length = 0
  const result = await speak({ provider: 'openai', baseUrl: base, apiKey: 'k', model: 'tts-1', voice: 'alloy' }, 'hello')
  check('wav decoded', Math.abs(result.samples.length / result.sampleRate - 1) < 0.01, String(result.sampleRate))
  check('no timestamps claimed', result.timestamps === null)
  check('effective says unsupported', result.effective.subtitle === 'unsupported')

  mode = 'mp3'
  try {
    await speak({ provider: 'openai', baseUrl: base, apiKey: 'k' }, 'hello')
    check('mp3 rejected', false)
  } catch (error) {
    check('mp3 message is actionable', /mp3/.test(error.message), error.message)
  }
  mode = 'ok'
}

console.log('-- audio understanding --')
{
  const answer = await describeAudio({ baseUrl: base, apiKey: 'k', model: 'qwen3-omni-flash' }, Buffer.from('RIFFfake'), '像什么？')
  check('answer returned', answer.includes('铁门'), answer)
}

console.log('-- missing key --')
{
  try {
    await speak({ provider: 'minimax', baseUrl: base }, 'x')
    check('missing key rejected', false)
  } catch (error) {
    check('error names the config field', /apiKeyEnv|apiKey/.test(error.message), error.message)
  }
}

console.log('-- timestamp shapes --')
{
  const shapes = [
    ['start/end', { data: { subtitle: [{ text: 'a', start: 0.1, end: 0.5 }] } }],
    ['start_time ms', { data: { sentences: [{ text: 'a', start_time: 100, end_time: 500 }] } }],
    ['begin/word', { words: [{ word: 'hi', begin: 0.2, finish: 0.4 }] }],
    ['string numbers', { data: { words: [{ content: 'hi', start: '0.2', end: '0.4' }] } }]
  ]
  for (const [label, payload] of shapes) {
    const parsed = normalizeTimestamps(payload, 1)
    check(`shape ${label}`, parsed !== null && parsed.items.length === 1, JSON.stringify(parsed))
  }
  check('unknown shape returns null', normalizeTimestamps({ data: {} }, 1) === null)
  const ms = normalizeTimestamps({ data: { subtitle: [{ text: 'a', start: 0, end: 1200 }] } }, 1.2)
  check('ms detected from duration', ms !== null && ms.items[0].end === 1.2, JSON.stringify(ms))
}

server.close()

console.log('-- wav round trip of a decoded provider payload --')
{
  const bytes = encodeWav([new Float32Array(100).fill(0.1)], 32000)
  const decoded = decodeWav(bytes)
  check('wav ok', decoded.sampleRate === 32000 && decoded.channels[0].length === 100)
}

console.log(failures === 0 ? '\nOK: adapters behave against the mock' : `\nFAILED: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
