/**
 * Live network test for the Edge "Read Aloud" provider and its integration.
 *
 * This test really talks to speech.platform.bing.com: it lists the live voice
 * catalogue, synthesizes Chinese and English sentences, and prints measured
 * numbers for every delivery path. Nothing here is mocked except the plugin
 * context (`ctx`) that the tools/settings routes normally receive.
 *
 * What it checks, in order:
 *  1. Offline: the v2 `Sec-MS-GEC` token shape and its SHA-256 half against a
 *     plain standard hash; provider shape; `findFfmpeg` ordering and caching.
 *  1b. Failure paths: an unreachable endpoint and a 1 ms timeout must reject
 *     promptly with a code, not hang or leak an unhandled rejection.
 *  2. Live voice list (318 voices measured).
 *  3. Live protocol: `synthesizeEncoded()` for zh + en; MP3 frame sanity;
 *     word-boundary timestamps that cover the spoken text.
 *  4. `speak()` through the auto-detected ffmpeg: non-silent samples. With
 *     ffmpeg explicitly disabled it must still fail cleanly with
 *     `edgeCode: 'undecodable'` and carry the MP3 bytes.
 *  5. The `config.decodeAudio` hook still wins over ffmpeg when supplied.
 *  6. Full `audio_tts` tool path with `provider: 'edge'`: WAV output for zh and
 *     en (path, format, duration, peak/RMS, word timestamps, SRT), then the
 *     MP3 fallback with ffmpeg forced unavailable: a real `.mp3` is written,
 *     frame-aligned, the tool does not throw, and no `.wav` is claimed.
 *  7. `audio_voices` with edge returns the live count.
 *  8. Settings routes: `/dsh-audio/test` reports protocolOk/supported/reason
 *     for edge, `/dsh-audio/voices` returns the live catalogue, and
 *     `provider: 'edge'` passes config validation.
 *  9. `probeEdge()`: supported with a decoder, protocol-only without one.
 *
 * Exit code is 0 when every check passes (network working, both paths as
 * designed); 1 on the first real failure with the exact evidence printed.
 */

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeWav } from '../lib/wav.js'
import { registerSettingsRoute } from '../lib/settings-route.js'
import { registerTtsTool, registerVoicesTool } from '../lib/tts.js'
import {
  EDGE_VOICE_CATALOG,
  edgeProvider,
  findFfmpeg,
  generateSecMsGec,
  listVoices,
  probeEdge,
  secMsGecV1,
  secMsGecV2,
  speak,
  synthesizeEncoded
} from '../lib/providers-edge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '.edge-out')

const WIN_EPOCH_SECONDS = 11644473600n
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.'

const ZH_TEXT = '你好，这是测试。'
const EN_TEXT = 'Hello, this is a test.'
const LONG_ZH_TEXT = ZH_TEXT.repeat(120) // > 600 chars, so audio_tts splits it

let failures = 0
const measurements = {}

/** Print and count one assertion. */
function check (label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}${detail === '' ? '' : ` (${detail})`}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  return false
}

/** One-line error description including the provider's own code. */
function describeError (error) {
  const code = error?.edgeCode === undefined ? '' : ` [edgeCode=${error.edgeCode}]`
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}${code}`
}

/** Peak and RMS of a sample buffer, plus duration. */
function measureSamples (samples, sampleRate) {
  let peak = 0
  let sumSquares = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
    sumSquares += sample * sample
  }
  return {
    frames: samples.length,
    sampleRate,
    durationSeconds: samples.length / sampleRate,
    peak,
    rms: Math.sqrt(sumSquares / samples.length)
  }
}

/** Pick the ffmpeg the provider's discovery would use, with an env override. */
function findTestFfmpeg () {
  const auto = findFfmpeg()
  if (auto !== null) return auto
  const override = typeof process.env.EDGE_TEST_FFMPEG === 'string' ? process.env.EDGE_TEST_FFMPEG : ''
  return findFfmpeg({ ffmpegPath: override })
}

/**
 * Test-side decoder: MP3 bytes in, Float32 samples out, via ffmpeg pipes so no
 * temporary file is written anywhere. The shipped package decodes through temp
 * files; this hook exists to prove the injected-decoder path still works.
 */
function makeFfmpegDecoder (ffmpegPath) {
  return ({ bytes }) => {
    const wav = execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1', '-ar', '24000',
      '-f', 'wav', 'pipe:1'
    ], { input: bytes, maxBuffer: 64 * 1024 * 1024 })
    const decoded = decodeWav(wav)
    return { samples: decoded.channels[0], sampleRate: decoded.sampleRate }
  }
}

/** Tool registry stub: enough of `ctx` for the two TTS tools to register. */
function setupTools (ttsConfig) {
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    get: () => undefined
  }
  registerTtsTool(ctx, { tts: ttsConfig })
  registerVoicesTool(ctx, { tts: ttsConfig })
  return tools
}

/** Settings-route stub: capture the registered handlers instead of an HTTP server. */
function mountSettingsRoutes (ttsConfig) {
  const routes = new Map()
  const child = {
    webServer: { register: ({ path, handler }) => { routes.set(path, handler) } },
    effect: (fn) => fn(),
    get: () => undefined
  }
  registerSettingsRoute({ inject: (_deps, callback) => callback(child) }, { tts: ttsConfig }, 'test')
  return routes
}

function makeRequest (method, body) {
  const request = new EventEmitter()
  request.method = method
  // The settings routes require a JSON media type on every POST; this helper is
  // the test's stand-in for the page, which sends it too.
  request.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
  request.destroy = () => {}
  request.setTimeout = () => request
  process.nextTick(() => {
    request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  })
  return request
}

function makeResponse () {
  return {
    statusCode: null,
    payload: null,
    writeHead (status) { this.statusCode = status },
    end (body) { this.payload = String(body) }
  }
}

async function callRoute (routes, path, method, body) {
  const response = makeResponse()
  await routes.get(path)(makeRequest(method, body), response)
  let json = null
  try { json = JSON.parse(response.payload) } catch { /* leave null */ }
  return { status: response.statusCode, json, raw: response.payload }
}

/** Frame size the service should use for a format, from its name. */
function expectedFrameBytes (format) {
  const khz = /^audio-(\d+)khz/i.exec(String(format))?.[1]
  const kbps = /(\d+)kbitrate/i.exec(String(format))?.[1]
  if (khz === undefined || kbps === undefined) return null
  return Math.floor((Number(khz) * 1000 <= 24000 ? 72 : 144) * Number(kbps) * 1000 / (Number(khz) * 1000))
}

/** Offline checks: token construction, provider shape, ffmpeg discovery. */
function offlineChecks () {
  console.log('-- 1. token, provider shape, ffmpeg discovery (offline) --')

  // Pick a timestamp whose seconds remainder is 100, so +100 stays in the same
  // 5-minute window and +300 is guaranteed to move to the next one.
  const fixed = 1795000000
  const token = secMsGecV2({ unixSeconds: fixed })
  const ticks = ((BigInt(fixed) + WIN_EPOCH_SECONDS) / 300n) * 300n * 10000000n
  const expectedSeed = `${EDGE_COPYRIGHT}${ticks}${TRUSTED_CLIENT_TOKEN}`
  const expectedSha = createHash('sha256').update(expectedSeed, 'utf8').digest('hex').toUpperCase()

  check('v2 token format is <16 hex>-<64 hex>', /^[0-9A-F]{16}-[0-9A-F]{64}$/.test(token), `${token.slice(0, 17)}…${token.slice(-8)}`)
  check('v2 SHA-256 half is the standard hash over copyright+ticks+token', token.split('-')[1] === expectedSha)
  check('v2 token is deterministic for one timestamp', secMsGecV2({ unixSeconds: fixed }) === token)
  check('v2 token is stable inside one 5-minute window', secMsGecV2({ unixSeconds: fixed + 100 }) === token)
  check('v2 token changes in the next 5-minute window', secMsGecV2({ unixSeconds: fixed + 300 }) !== token)
  check('legacy v1 token stays 64 hex for diagnosis', /^[0-9A-F]{64}$/.test(secMsGecV1({ unixSeconds: fixed })))
  check('generateSecMsGec dispatches on version',
    generateSecMsGec({ version: 2, unixSeconds: fixed }) === token &&
    /^[0-9A-F]{64}$/.test(generateSecMsGec({ version: 1, unixSeconds: fixed })))

  check('provider id is "edge"', edgeProvider.id === 'edge')
  check('provider needs no API key', edgeProvider.requiresKey === false)
  check('provider exposes speak/listVoices/probe/synthesizeEncoded/findFfmpeg',
    [speak, listVoices, probeEdge, synthesizeEncoded, findFfmpeg].every((fn) => typeof fn === 'function'))
  check('static catalogue covers Chinese and English',
    EDGE_VOICE_CATALOG.some((voice) => voice.id.startsWith('zh-CN-')) &&
    EDGE_VOICE_CATALOG.some((voice) => voice.id.startsWith('en-US-')))

  const started = Date.now()
  const auto = findFfmpeg()
  const firstLookupMs = Date.now() - started
  const cached = findFfmpeg() === auto
  measurements.ffmpeg = auto
  console.log(`  findFfmpeg(): ${auto ?? 'null'} (first ${firstLookupMs} ms, cached result reused: ${cached})`)
  check('ffmpeg discovery is cached per process', cached)
  check('explicit "nonexistent" resolves to null (fallback switch)',
    findFfmpeg({ ffmpegPath: 'nonexistent' }) === null)
  if (auto !== null) check('auto-detected binary is executable', existsSync(auto) || auto === 'ffmpeg')
}

/** Failure paths must reject promptly with a code, never hang or crash. */
async function failurePathChecks () {
  console.log('-- 1b. failure paths (no hang, clear error) --')
  const unreachableStarted = Date.now()
  try {
    await speak({ text: 'x' }, { endpoint: 'wss://127.0.0.1:9/edge/v1', timeoutMs: 2000 })
    check('unreachable endpoint rejects', false, 'returned audio unexpectedly')
  } catch (error) {
    const elapsed = Date.now() - unreachableStarted
    console.log(`  unreachable endpoint -> ${describeError(error)} (${elapsed} ms)`)
    check('unreachable endpoint reports a handshake error', error?.edgeCode === 'handshake', String(error?.edgeCode))
    check('handshake failure finishes promptly', elapsed < 10000, `${elapsed} ms`)
    check('handshake failure message is actionable', /握手/.test(error?.message ?? ''))
  }

  const timeoutStarted = Date.now()
  try {
    await speak({ text: ZH_TEXT }, { timeoutMs: 1 })
    check('tiny timeout rejects', false, 'returned audio unexpectedly')
  } catch (error) {
    const elapsed = Date.now() - timeoutStarted
    console.log(`  timeout=1 ms -> ${describeError(error)} (${elapsed} ms)`)
    check('tiny timeout produces a timeout error', error?.edgeCode === 'timeout', String(error?.edgeCode))
    check('timeout trips without hanging', elapsed < 5000, `${elapsed} ms`)
  }
}

/** Live voice list. */
async function voicesSection () {
  console.log('-- 2. live voice list (network) --')
  try {
    const started = Date.now()
    const voices = await listVoices({ provider: 'edge' })
    const elapsed = Date.now() - started
    const zhCount = voices.filter((voice) => voice.id.startsWith('zh-CN-')).length
    const enCount = voices.filter((voice) => voice.id.startsWith('en-US-')).length
    measurements.voices = voices.length
    console.log(`  voices: ${voices.length} in ${elapsed} ms (zh-CN: ${zhCount}, en-US: ${enCount})`)
    console.log(`  first ids: ${voices.slice(0, 6).map((voice) => voice.id).join(', ')}`)
    console.log(`  sample name: ${voices.find((voice) => voice.id === 'zh-CN-XiaoxiaoNeural')?.name ?? '(missing)'}`)
    check('voice list is large enough to be the live catalogue', voices.length >= 100, `${voices.length} voices`)
    check('voice list contains zh-CN-XiaoxiaoNeural', voices.some((voice) => voice.id === 'zh-CN-XiaoxiaoNeural'))
    check('voice list contains en-US-AriaNeural', voices.some((voice) => voice.id === 'en-US-AriaNeural'))
  } catch (error) {
    failures += 1
    console.log(`  FAIL live voice list: ${describeError(error)}`)
  }
}

/** Verify one `synthesizeEncoded()` result and return it. */
function checkEncoded (label, encoded) {
  const frameBytes = expectedFrameBytes(encoded.format)
  const encodedSeconds = encoded.encodedDurationSeconds
  measurements[`${label}Encoded`] = {
    bytes: encoded.bytes.length,
    mimeType: encoded.mimeType,
    format: encoded.format,
    encodedSeconds,
    speechSeconds: encoded.durationSeconds,
    marks: encoded.timestamps === null ? 0 : encoded.timestamps.items.length
  }
  console.log(`  ${label}: ${encoded.bytes.length} B, ${encoded.mimeType}, ${encoded.format}`)
  console.log(`  ${label}: encoded ${encodedSeconds === null ? '?' : encodedSeconds.toFixed(3)} s · ` +
    `speech ${encoded.durationSeconds === null ? '?' : encoded.durationSeconds.toFixed(3)} s · ` +
    `word marks ${encoded.timestamps === null ? 0 : encoded.timestamps.items.length}` +
    `${frameBytes === null ? '' : ` · ~${(encoded.bytes.length / frameBytes).toFixed(0)} frames of ${frameBytes} B`}`)

  check(`${label} returns audio bytes`, encoded.bytes.length > 1000, `${encoded.bytes.length} bytes`)
  check(`${label} reports an audio MIME type`, /^audio\//.test(encoded.mimeType), encoded.mimeType)
  check(`${label} encoded duration is plausible`, encodedSeconds !== null && encodedSeconds > 0.3 && encodedSeconds < 30,
    encodedSeconds === null ? 'unknown' : `${encodedSeconds.toFixed(3)} s`)
  check(`${label} word-boundary timestamps came back`, encoded.timestamps !== null && encoded.timestamps.items.length >= 2,
    encoded.timestamps === null ? 'null' : `${encoded.timestamps.items.length} items`)
  if (encoded.timestamps !== null) {
    const items = encoded.timestamps.items
    const sorted = items.every((item, index) => index === 0 || item.start >= items[index - 1].start)
    const positive = items.every((item) => item.text.length > 0 && item.start >= 0 && item.end > item.start)
    const insideAudio = encodedSeconds === null || items[items.length - 1].end <= encodedSeconds + 0.05
    check(`${label} marks are ordered and positive`, sorted && positive)
    check(`${label} last mark ends inside the encoded stream`, insideAudio,
      `${items[items.length - 1].end.toFixed(3)} s vs ${encodedSeconds === null ? '?' : encodedSeconds.toFixed(3)} s`)
  }
  if (frameBytes !== null) {
    check(`${label} byte count is a whole number of MP3 frames`, encoded.bytes.length % frameBytes === 0,
      `${encoded.bytes.length} % ${frameBytes} = ${encoded.bytes.length % frameBytes}`)
  }
  return encoded
}

/** Live protocol: Chinese, English, prosody. */
async function synthesisSection () {
  console.log('-- 3. live synthesis via synthesizeEncoded (network) --')
  try {
    const zh = checkEncoded('zh', await synthesizeEncoded(
      { text: ZH_TEXT, voice: 'zh-CN-XiaoxiaoNeural' },
      { timeoutMs: 20000 }
    ))
    const spoken = zh.timestamps === null ? '' : zh.timestamps.items.map((item) => item.text).join('')
    check('zh word marks spell the requested text', spoken.includes('你好') || spoken.includes('测试'), JSON.stringify(spoken))
    console.log(`  zh marks: ${JSON.stringify(zh.timestamps?.items ?? null)}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL zh synthesizeEncoded: ${describeError(error)}`)
  }

  try {
    const en = checkEncoded('en', await synthesizeEncoded({
      text: EN_TEXT,
      voice: 'en-US-AriaNeural',
      speed: 1.2,
      pitch: 2
    }, { timeoutMs: 20000 }))
    const spoken = en.timestamps === null ? '' : en.timestamps.items.map((item) => item.text).join(' ').toLowerCase()
    check('en word marks spell the requested text', spoken.includes('hello') || spoken.includes('test'), JSON.stringify(spoken))
    check('prosody (speed 1.2, pitch +2st) did not break synthesis', en.bytes.length > 1000)
  } catch (error) {
    failures += 1
    console.log(`  FAIL en synthesizeEncoded: ${describeError(error)}`)
  }
}

/** `speak()` with ffmpeg, and its clean failure when ffmpeg is forced off. */
async function speakSection () {
  console.log('-- 4. speak() decoding paths --')
  try {
    const started = Date.now()
    const result = await speak({ text: ZH_TEXT, voice: 'zh-CN-XiaoxiaoNeural' }, { timeoutMs: 20000 })
    const measured = measureSamples(result.samples, result.sampleRate)
    measurements.zhSpeak = measured
    console.log(`  speak() via ffmpeg: ${measured.frames} frames @ ${measured.sampleRate} Hz = ` +
      `${measured.durationSeconds.toFixed(3)} s · peak ${measured.peak.toFixed(4)} · rms ${measured.rms.toFixed(4)} · ` +
      `${Date.now() - started} ms · decoder ${result.effective.decoder}`)
    check('default speak() returns Float32 samples', result.samples instanceof Float32Array)
    check('default speak() decoded duration is plausible', measured.durationSeconds > 1 && measured.durationSeconds < 6,
      `${measured.durationSeconds.toFixed(3)} s`)
    check('default speak() decoded audio is non-silent', measured.peak > 0.05, `peak ${measured.peak.toFixed(4)} > 0.05`)
    check('default speak() audio has speech-level RMS', measured.rms > 0.002, `rms ${measured.rms.toFixed(4)}`)
    check('speak() names the decoder it used', /^(ffmpeg:|config\.decodeAudio)/.test(result.effective.decoder ?? ''),
      String(result.effective.decoder))
  } catch (error) {
    failures += 1
    console.log(`  FAIL speak() via ffmpeg: ${describeError(error)}`)
  }

  try {
    await speak({ text: ZH_TEXT }, { timeoutMs: 20000, ffmpegPath: 'nonexistent' })
    failures += 1
    console.log('  FAIL speak() with ffmpeg disabled unexpectedly returned samples')
  } catch (error) {
    console.log(`  speak() with ffmpeg disabled -> ${describeError(error)}`)
    check('ffmpeg-disabled speak() fails with the documented edgeCode', error?.edgeCode === 'undecodable', String(error?.edgeCode))
    check('ffmpeg-disabled error names the decoder options',
      typeof error?.message === 'string' && error.message.includes('ffmpeg') && error.message.includes('decodeAudio'))
    check('ffmpeg-disabled error carries the encoded bytes for audio_tts',
      error?.encoded !== undefined && Buffer.isBuffer(error.encoded.bytes) && error.encoded.bytes.length > 1000,
      error?.encoded === undefined ? 'none' : `${error.encoded.bytes.length} bytes`)
  }
}

/** The injected decoder hook still wins over ffmpeg. */
async function decoderHookSection (ffmpegPath) {
  console.log('-- 5. injected config.decodeAudio hook --')
  if (ffmpegPath === null) {
    console.log('  SKIP no ffmpeg available to build a decoder for this check')
    return
  }
  try {
    const result = await speak(
      { text: ZH_TEXT, voice: 'zh-CN-XiaoxiaoNeural' },
      { timeoutMs: 20000, decodeAudio: makeFfmpegDecoder(ffmpegPath) }
    )
    const measured = measureSamples(result.samples, result.sampleRate)
    console.log(`  via hook: ${measured.frames} frames = ${measured.durationSeconds.toFixed(3)} s · ` +
      `peak ${measured.peak.toFixed(4)} · decoder ${result.effective.decoder}`)
    check('injected decoder is preferred', result.effective.decoder === 'config.decodeAudio', String(result.effective.decoder))
    check('injected decoder audio is non-silent', measured.peak > 0.05, `peak ${measured.peak.toFixed(4)}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL injected decoder: ${describeError(error)}`)
  }
}

/** Full `audio_tts` WAV path through the real tool registration. */
async function ttsWavToolSection (ffmpegPath) {
  console.log('-- 6. audio_tts tool, WAV path (provider: edge, ffmpeg) --')
  if (ffmpegPath === null) {
    console.log('  SKIP no ffmpeg, so the WAV path cannot be exercised on this machine')
    return
  }
  const tools = setupTools({ provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural' })
  const cases = [
    { label: 'zh', text: ZH_TEXT, voice: 'zh-CN-XiaoxiaoNeural', out: join(OUT_DIR, 'tool-zh.wav'), srt: true, min: 1, max: 6 },
    { label: 'en', text: EN_TEXT, voice: 'en-US-AriaNeural', out: join(OUT_DIR, 'tool-en.wav'), srt: false, min: 0.8, max: 6 }
  ]
  for (const entry of cases) {
    try {
      const started = Date.now()
      const result = await tools.get('audio_tts').execute({
        text: entry.text,
        voice: entry.voice,
        out: entry.out,
        srt: entry.srt
      }, {})
      measurements[`tool${entry.label}Wav`] = {
        path: result.path,
        relativePath: result.relativePath,
        bytes: result.bytes,
        format: result.format,
        duration: result.durationSeconds,
        peakDbfs: result.metrics.peakDbfs,
        rmsDbfs: result.metrics.rmsDbfs,
        marks: result.timestamps === null ? 0 : result.timestamps.items.length
      }
      console.log(`  ${entry.label}: ${result.relativePath} · format ${result.format} · ${result.bytes} B · ` +
        `${result.durationSeconds.toFixed(3)} s · peak ${result.metrics.peakDbfs} dBFS · rms ${result.metrics.rmsDbfs} dBFS · ` +
        `${Date.now() - started} ms`)
      console.log(`  ${entry.label}: ${result.timestamps === null ? 0 : result.timestamps.items.length} word marks · ` +
        `first ${JSON.stringify(result.timestamps?.items?.[0] ?? null)}`)
      console.log(`  ${entry.label}: srt ${result.srtPath === null ? '(none)' : result.srtPath}`)
      check(`${entry.label} tool wrote .wav`, result.format === 'wav' && /\.wav$/i.test(result.path), result.path)
      check(`${entry.label} wav exists and is non-empty`, existsSync(result.path) && statSync(result.path).size > 2000)
      check(`${entry.label} duration is plausible`, result.durationSeconds >= entry.min && result.durationSeconds <= entry.max,
        `${result.durationSeconds.toFixed(3)} s`)
      check(`${entry.label} WAV metrics are real`, Number.isFinite(result.metrics.peakDbfs) && result.metrics.peakDbfs > -3 &&
        Number.isFinite(result.metrics.rmsDbfs) && result.metrics.rmsDbfs < -5,
        `peak ${result.metrics.peakDbfs} dBFS, rms ${result.metrics.rmsDbfs} dBFS`)
      check(`${entry.label} word timestamps present`, result.timestamps !== null && result.timestamps.items.length >= 2,
        result.timestamps === null ? 'null' : `${result.timestamps.items.length} items`)
      if (entry.srt) check(`${entry.label} SRT written next to wav`, result.srtPath !== null && existsSync(result.srtPath))
    } catch (error) {
      failures += 1
      console.log(`  FAIL ${entry.label} audio_tts wav: ${describeError(error)}`)
    }
  }
}

/** Full `audio_tts` MP3 fallback: ffmpeg forced off, tool must still deliver. */
async function ttsMp3FallbackSection () {
  console.log('-- 7. audio_tts tool, MP3 fallback (ffmpeg disabled) --')
  const tools = setupTools({ provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural', ffmpegPath: 'nonexistent' })

  try {
    const started = Date.now()
    const result = await tools.get('audio_tts').execute({
      text: ZH_TEXT,
      voice: 'zh-CN-XiaoxiaoNeural',
      out: join(OUT_DIR, 'fallback.wav') // deliberately .wav: output must become .mp3
    }, {})
    measurements.fallback = {
      path: result.path,
      relativePath: result.relativePath,
      bytes: result.bytes,
      format: result.format,
      duration: result.durationSeconds,
      frameBytes: result.metrics.mp3FrameBytes,
      frames: result.metrics.mp3Frames,
      aligned: result.metrics.mp3FrameAligned,
      marks: result.timestamps === null ? 0 : result.timestamps.items.length
    }
    const frameBytes = expectedFrameBytes(result.effective.outputFormat)
    console.log(`  tool returned: ${result.relativePath} · format ${result.format} · ${result.bytes} B · ` +
      `${result.durationSeconds.toFixed(3)} s · frames ${result.metrics.mp3Frames} × ${result.metrics.mp3FrameBytes} B ` +
      `(aligned ${result.metrics.mp3FrameAligned}) · ${Date.now() - started} ms`)
    console.log(`  timestamps: ${result.timestamps === null ? 0 : result.timestamps.items.length} · ` +
      `first ${JSON.stringify(result.timestamps?.items?.[0] ?? null)}`)
    console.log('  tool text:\n' + result.text.split('\n').map((line) => `    ${line}`).join('\n'))
    check('fallback tool did not throw and reported format mp3', result.format === 'mp3')
    check('fallback path ends in .mp3', /\.mp3$/i.test(result.path), result.path)
    check('fallback never claims a wav on disk', !existsSync(result.path.replace(/\.mp3$/i, '.wav')))
    check('fallback mp3 exists and is non-empty', existsSync(result.path) && statSync(result.path).size > 2000,
      `${result.bytes} bytes`)
    check('fallback mp3 size is frame-aligned', result.metrics.mp3FrameAligned === true &&
      (frameBytes === null || result.bytes % frameBytes === 0),
      `${result.bytes} % ${frameBytes} = ${frameBytes === null ? '?' : result.bytes % frameBytes}`)
    check('fallback mp3 carries word timestamps', result.timestamps !== null && result.timestamps.items.length >= 2,
      result.timestamps === null ? 'null' : `${result.timestamps.items.length} items`)
    check('fallback duration matches the encoded clip', Math.abs(result.durationSeconds - 2.232) < 0.5,
      `${result.durationSeconds.toFixed(3)} s`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL audio_tts mp3 fallback: ${describeError(error)}`)
  }

  try {
    const started = Date.now()
    const result = await tools.get('audio_tts').execute({
      text: LONG_ZH_TEXT,
      out: join(OUT_DIR, 'fallback-long.mp3'),
      srt: true
    }, {})
    measurements.fallbackLong = {
      chunks: result.chunks,
      bytes: result.bytes,
      format: result.format,
      duration: result.durationSeconds,
      frames: result.metrics.mp3Frames,
      aligned: result.metrics.mp3FrameAligned,
      marks: result.timestamps === null ? 0 : result.timestamps.items.length
    }
    const frameBytes = expectedFrameBytes(result.effective.outputFormat)
    const lastMark = result.timestamps === null ? null : result.timestamps.items[result.timestamps.items.length - 1]
    console.log(`  long: ${result.chunks} chunks · ${result.bytes} B · ${result.durationSeconds.toFixed(3)} s · ` +
      `${result.metrics.mp3Frames} frames (aligned ${result.metrics.mp3FrameAligned}) · ${Date.now() - started} ms`)
    console.log(`  long: ${result.timestamps === null ? 0 : result.timestamps.items.length} word marks · ` +
      `last ${JSON.stringify(lastMark)} · srt ${result.srtPath === null ? '(none)' : result.srtPath}`)
    check('long fallback really chunked', result.chunks >= 2, `${result.chunks} chunks`)
    check('long fallback stays frame-aligned across chunks', result.metrics.mp3FrameAligned === true &&
      (frameBytes === null || result.bytes % frameBytes === 0),
      `${result.bytes} % ${frameBytes} = ${frameBytes === null ? '?' : result.bytes % frameBytes}`)
    check('long fallback timestamps were offset across chunks', lastMark !== null && lastMark.start > 60,
      lastMark === null ? 'none' : `last start ${lastMark.start} s`)
    check('long fallback SRT written', result.srtPath !== null && existsSync(result.srtPath))
  } catch (error) {
    failures += 1
    console.log(`  FAIL audio_tts long mp3 fallback: ${describeError(error)}`)
  }
}

/** `audio_voices` with edge through the tool. */
async function voicesToolSection () {
  console.log('-- 8. audio_voices tool (provider: edge) --')
  try {
    const started = Date.now()
    const tools = setupTools({ provider: 'edge' })
    const result = await tools.get('audio_voices').execute({}, {})
    measurements.voicesTool = { source: result.source, count: result.voices.length }
    console.log(`  source ${result.source} · provider ${result.provider} · ${result.voices.length} voices · ` +
      `${Date.now() - started} ms`)
    console.log(`  first: ${result.text.split('\n').slice(0, 2).join(' | ')}`)
    check('audio_voices returns the live Edge catalogue', result.source === 'live', result.source)
    check('audio_voices count is the live count', result.voices.length >= 100, `${result.voices.length} voices`)
    check('audio_voices includes a Chinese voice', result.voices.some((voice) => voice.id === 'zh-CN-XiaoxiaoNeural'))
  } catch (error) {
    failures += 1
    console.log(`  FAIL audio_voices: ${describeError(error)}`)
  }
}

/** Settings route edge branches, through the registered handlers. */
async function settingsSection () {
  console.log('-- 9. settings routes (edge) --')
  try {
    const routes = mountSettingsRoutes({ provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural' })
    const tested = await callRoute(routes, '/dsh-audio/test', 'POST', {})
    const json = tested.json ?? {}
    measurements.settingsTest = {
      status: tested.status,
      supported: json.supported,
      protocolOk: json.protocolOk,
      decoder: json.decoder ?? null,
      wavBase64Bytes: typeof json.wavBase64 === 'string' ? json.wavBase64.length : 0
    }
    console.log(`  /dsh-audio/test -> HTTP ${tested.status} · supported ${json.supported} · protocolOk ${json.protocolOk} · ` +
      `decoder ${json.decoder ?? 'null'} · duration ${json.durationSeconds} s · wavBase64 ${measurements.settingsTest.wavBase64Bytes} chars`)
    check('/dsh-audio/test reports edge supported', json.ok === true && json.supported === true && json.protocolOk === true)
    check('/dsh-audio/test returns playable audio', measurements.settingsTest.wavBase64Bytes > 1000)
    check('/dsh-audio/test names the decoder', typeof json.decoder === 'string' && json.decoder.startsWith('ffmpeg:'), String(json.decoder))

    const voices = await callRoute(routes, '/dsh-audio/voices', 'POST', {})
    console.log(`  /dsh-audio/voices -> HTTP ${voices.status} · source ${voices.json?.source} · ${voices.json?.items?.length} items`)
    check('/dsh-audio/voices returns the live edge list',
      voices.status === 200 && voices.json?.source === 'live' && voices.json.items.length >= 100)

    const bogus = await callRoute(routes, '/dsh-audio/config', 'POST', { tts: { provider: 'bogus' } })
    console.log(`  config provider=bogus -> HTTP ${bogus.status} · ${bogus.json?.error}`)
    check('config validation still rejects unknown providers', bogus.status === 400 && /供应商/.test(bogus.json?.error ?? ''))
    const edgeConfig = await callRoute(routes, '/dsh-audio/config', 'POST', { tts: { provider: 'edge', ffmpegPath: 'C:/tools/ffmpeg.exe' } })
    console.log(`  config provider=edge -> HTTP ${edgeConfig.status} · ${edgeConfig.json?.error}`)
    check('config validation accepts provider=edge (fails later only on missing editor)',
      edgeConfig.status === 503 && /不支持写配置/.test(edgeConfig.json?.error ?? ''))
  } catch (error) {
    failures += 1
    console.log(`  FAIL settings routes: ${describeError(error)}`)
  }

  try {
    const routes = mountSettingsRoutes({ provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural', ffmpegPath: 'nonexistent' })
    const tested = await callRoute(routes, '/dsh-audio/test', 'POST', {})
    const json = tested.json ?? {}
    measurements.settingsTestNoFfmpeg = {
      status: tested.status,
      supported: json.supported,
      protocolOk: json.protocolOk,
      reason: String(json.reason ?? '').slice(0, 120)
    }
    console.log(`  /dsh-audio/test (no ffmpeg) -> HTTP ${tested.status} · supported ${json.supported} · ` +
      `protocolOk ${json.protocolOk} · format ${json.format} · encodedBytes ${json.encodedBytes}`)
    console.log(`  reason: ${measurements.settingsTestNoFfmpeg.reason}`)
    check('/dsh-audio/test with no ffmpeg reports protocolOk but not supported',
      json.ok === true && json.supported === false && json.protocolOk === true)
    check('/dsh-audio/test with no ffmpeg explains the blocker',
      typeof json.reason === 'string' && json.reason.includes('解码器'))
  } catch (error) {
    failures += 1
    console.log(`  FAIL settings routes without ffmpeg: ${describeError(error)}`)
  }
}

/** Probe semantics: supported with decoder, protocol-only without. */
async function probeSection () {
  console.log('-- 10. probeEdge() health probe --')
  try {
    const plain = await probeEdge()
    measurements.probe = plain
    console.log(`  probe (auto): ${JSON.stringify(plain)}`)
    check('probe reports supported with the auto decoder',
      plain.supported === true && plain.protocolOk === true, `supported ${plain.supported}`)
    check('probe names the ffmpeg decoder', typeof plain.decoder === 'string' && plain.decoder.startsWith('ffmpeg:'), String(plain.decoder))
    check('probe measured real samples', plain.pcmBytes > 1000, `${plain.pcmBytes} bytes`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL probeEdge(): ${describeError(error)}`)
  }

  try {
    const blocked = await probeEdge({ ffmpegPath: 'nonexistent', probeTimeoutMs: 20000 })
    measurements.probeNoFfmpeg = blocked
    console.log(`  probe (no ffmpeg): ${JSON.stringify(blocked)}`)
    check('probe without any decoder reports protocolOk but not supported',
      blocked.supported === false && blocked.protocolOk === true)
    check('probe without any decoder still measured the encoded audio', blocked.encodedBytes > 1000,
      `${blocked.encodedBytes} bytes`)
    check('probe without any decoder explains the blocker', typeof blocked.reason === 'string' && blocked.reason.length > 20)
  } catch (error) {
    failures += 1
    console.log(`  FAIL probeEdge() without ffmpeg: ${describeError(error)}`)
  }
}

/** Remove the generated audio so the repo stays clean (process.exit skips finally). */
function cleanup () {
  try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Print the numbers, then decide the exit code. */
function printResult () {
  console.log('')
  console.log('== measured numbers ==')
  console.log(`  ffmpeg: ${measurements.ffmpeg ?? 'not found'}`)
  console.log(`  voices (provider list): ${measurements.voices ?? 'n/a'}`)
  for (const label of ['zhEncoded', 'enEncoded']) {
    const entry = measurements[label]
    if (entry === undefined) continue
    console.log(`  ${label}: ${entry.bytes} B · ${entry.encodedSeconds === null ? '?' : entry.encodedSeconds.toFixed(3)} s encoded · ` +
      `${entry.speechSeconds === null ? '?' : entry.speechSeconds.toFixed(3)} s speech · ${entry.marks} word marks`)
  }
  for (const label of ['zhSpeak']) {
    const entry = measurements[label]
    if (entry === undefined) continue
    console.log(`  ${label}: ${entry.frames} samples · ${entry.durationSeconds.toFixed(3)} s · ` +
      `peak ${entry.peak.toFixed(4)} · rms ${entry.rms.toFixed(4)}`)
  }
  for (const label of ['toolzhWav', 'toolenWav']) {
    const entry = measurements[label]
    if (entry === undefined) continue
    console.log(`  ${label}: ${entry.relativePath} · ${entry.bytes} B · ${entry.duration.toFixed(3)} s · ` +
      `peak ${entry.peakDbfs} dBFS · rms ${entry.rmsDbfs} dBFS · ${entry.marks} marks`)
  }
  if (measurements.fallback !== undefined) {
    const entry = measurements.fallback
    console.log(`  mp3 fallback: ${entry.relativePath} · ${entry.bytes} B · ${entry.duration.toFixed(3)} s · ` +
      `${entry.frames} frames × ${entry.frameBytes} B (aligned ${entry.aligned}) · ${entry.marks} marks`)
  }
  if (measurements.fallbackLong !== undefined) {
    const entry = measurements.fallbackLong
    console.log(`  mp3 fallback long: ${entry.chunks} chunks · ${entry.bytes} B · ${entry.duration.toFixed(3)} s · ` +
      `${entry.frames} frames (aligned ${entry.aligned}) · ${entry.marks} marks`)
  }
  if (measurements.voicesTool !== undefined) {
    console.log(`  audio_voices: ${measurements.voicesTool.source} · ${measurements.voicesTool.count} voices`)
  }
  if (measurements.settingsTest !== undefined) {
    console.log(`  settings /test: HTTP ${measurements.settingsTest.status} · supported ${measurements.settingsTest.supported} · ` +
      `protocolOk ${measurements.settingsTest.protocolOk} · decoder ${measurements.settingsTest.decoder}`)
  }
  if (measurements.settingsTestNoFfmpeg !== undefined) {
    console.log(`  settings /test (no ffmpeg): supported ${measurements.settingsTestNoFfmpeg.supported} · ` +
      `protocolOk ${measurements.settingsTestNoFfmpeg.protocolOk}`)
  }

  console.log('')
  if (failures > 0) {
    console.log(`FAILED: ${failures} assertion(s) — see FAIL lines above`)
    cleanup()
    process.exit(1)
  }
  console.log('OK: Edge provider works live — protocol, ffmpeg-decoded WAV path, and MP3 fallback all verified')
  cleanup()
  process.exit(0)
}

async function main () {
  mkdirSync(OUT_DIR, { recursive: true })
  try {
    offlineChecks()
    await failurePathChecks()
    await voicesSection()
    await synthesisSection()
    await speakSection()
    const ffmpegPath = findTestFfmpeg()
    console.log(`-- test decoder: ${ffmpegPath ?? 'not found (sample-level checks skipped)'} --`)
    await decoderHookSection(ffmpegPath)
    await ttsWavToolSection(ffmpegPath)
    await ttsMp3FallbackSection()
    await voicesToolSection()
    await settingsSection()
    await probeSection()
    printResult()
  } finally {
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`TEST CRASHED: ${describeError(error)}`)
  console.error(error?.stack ?? '')
  rmSync(OUT_DIR, { recursive: true, force: true })
  process.exit(1)
})
