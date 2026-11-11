/**
 * Tool-layer tests: real files on disk, a fake Cordis context, and a mock
 * MiniMax endpoint. Covers the parts the engine tests cannot: argument
 * handling, chunk stitching, path resolution and the check verdicts.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerTools } from '../lib/tools.js'
import { registerTtsTool, registerVoicesTool, splitScript } from '../lib/tts.js'
import { registerCheckTool, leadingSilence } from '../lib/check.js'
import { decodeWav } from '../lib/wav.js'

const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-tools-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }

function pcmHex (seconds, sampleRate = 32000) {
  const frames = Math.round(seconds * sampleRate)
  const buffer = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / sampleRate) * 16000), i * 2)
  return buffer.toString('hex')
}

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    if (request.url.startsWith('/v1/t2a_v2')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        data: { audio: pcmHex(1.2), subtitle: [{ text: '句一', start: 0, end: 500 }, { text: '句二', start: 500, end: 1200 }] },
        base_resp: { status_code: 0 }
      }))
      return
    }
    response.writeHead(404)
    response.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${server.address().port}`

registerTools(ctx)
registerVoicesTool(ctx)
registerTtsTool(ctx, { tts: { provider: 'minimax', baseUrl: mockBase, apiKey: 'k', model: 'speech-2.8-hd', voice: 'female-shaonv' } })
registerCheckTool(ctx, {})

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}
const call = (name, args) => registered.get(name).execute(args, exec)

console.log('-- registered:', [...registered.keys()].join(', '))
check('seven tools', registered.size === 7, String(registered.size))

console.log('-- audio_synth --')
{
  const result = await call('audio_synth', { preset: 'impact', params: { weight: 0.9 }, duration: 0.5, out: 'a/slam.wav' })
  check('wrote file', result.relativePath === 'a/slam.wav', result.relativePath)
  check('metrics present', result.metrics.peakDbfs > -2 && result.metrics.clipping === 0, JSON.stringify(result.metrics.peakDbfs))
}

console.log('-- audio_check: clean --')
{
  const result = await call('audio_check', { paths: ['a/slam.wav'] })
  check('verdict ok', result.verdict === 'ok', JSON.stringify(result.issues))
}

console.log('-- audio_check: silent file is caught --')
{
  const { encodeWav } = await import('../lib/wav.js')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(cwd, 'silent.wav'), encodeWav([new Float32Array(16000)], 16000))
  const result = await call('audio_check', { paths: ['silent.wav'] })
  check('verdict fail', result.verdict === 'fail')
  check('says it is silent', result.issues.some((issue) => /几乎无声/.test(issue.message)), JSON.stringify(result.issues))
}

console.log('-- audio_check: cue timeline --')
{
  await call('audio_synth', { preset: 'chime', duration: 0.4, out: 'a/ding.wav' })
  const result = await call('audio_check', {
    cues: [{ at: 0, src: 'a/slam.wav' }, { at: 0.1, src: 'a/ding.wav' }],
    expectDuration: 1
  })
  check('summed peak reported', typeof result.summedPeakDbfs === 'number', String(result.summedPeakDbfs))
  check('timeline check runs', result.verdict !== undefined)
}

console.log('-- audio_tts: chunk stitching --')
{
  const long = '这是一句用来测试分块的旁白。'.repeat(60) // ~840 chars → 2 chunks
  const result = await call('audio_tts', { text: long, out: 'a/voice.wav' })
  check('chunks split', result.chunks >= 2, String(result.chunks))
  check('timestamps stitched', result.timestamps !== null && result.timestamps.items.length === result.chunks * 2,
    JSON.stringify(result.timestamps?.items?.length))
  check('second chunk offset', result.timestamps.items.some((item) => item.start > 1.3),
    JSON.stringify(result.timestamps.items.map((item) => item.start)))
  check('effective params', result.effective.model === 'speech-2.8-hd' && result.effective.chunks === result.chunks)
  const bytes = decodeWav(await readFile(join(cwd, 'a/voice.wav')))
  check('duration covers chunks + gaps', Math.abs(bytes.durationSeconds - (result.chunks * 1.2 + (result.chunks - 1) * 0.15)) < 0.02,
    String(bytes.durationSeconds))
}

console.log('-- audio_tts: guard rails --')
{
  try { await call('audio_tts', { text: 'x'.repeat(9000) }); check('length guard', false) } catch (error) { check('length guard', /8000/.test(error.message), error.message) }
  try { await call('audio_tts', { text: 'hi', speed: 5 }); check('speed guard', false) } catch (error) { check('speed guard', /0.5/.test(error.message), error.message) }
  try { await call('audio_tts', { text: 'hi', pitch: 20 }); check('pitch guard', false) } catch (error) { check('pitch guard', /12/.test(error.message), error.message) }
}

console.log('-- splitScript --')
{
  check('short stays one', splitScript('短句。').length === 1)
  const parts = splitScript('甲。'.repeat(400), 100)
  check('splits at sentence', parts.every((part) => part.length <= 101), parts.map((p) => p.length).join(','))
  check('no empty parts', parts.every((part) => part.length > 0))
}

console.log('-- leadingSilence --')
{
  const samples = new Float32Array(32000)
  for (let i = 16000; i < 32000; i += 1) samples[i] = 0.5
  check('detects 0.5s', Math.abs(leadingSilence(samples, 32000) - 0.5) < 0.01, String(leadingSilence(samples, 32000)))
}

console.log('-- audio_voices --')
{
  const result = await call('audio_voices', {})
  check('has catalog', Array.isArray(result.voices) && result.voices.length > 5)
}

server.close()
await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\nOK: tool layer behaves' : `\nFAILED: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
