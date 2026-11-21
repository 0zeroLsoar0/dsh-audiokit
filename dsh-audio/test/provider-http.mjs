/**
 * Real-transport tests for the speech and audio-understanding adapters.
 *
 * `test/tts-mock.mjs` runs the adapters against a mock created inside the test
 * module; this file runs them through the actual `fetch` / `WebSocket` code
 * paths against the reusable servers in `./fake-provider.mjs`, and asserts on
 * both sides of the wire: what the adapter sent (auth header, model, voice,
 * exact text, base64 audio) and what it returned (frames, sample rate,
 * duration, stitched offsets, error text).
 *
 * Checked, in order:
 *  1. OpenAI-compatible TTS: WAV over HTTP, non-silent samples, duration,
 *     `effective` echo, exact `Authorization`/body, plus a slow endpoint and
 *     HTTP 401/500.
 *  2. MiniMax T2A: hex PCM decodes to the requested frames/rate, timestamps
 *     come back in seconds, and `base_resp.status_code != 0` names the code.
 *  3. Audio understanding: `input_audio` base64 reaches the wire and the
 *     assistant text comes back; 401 / 500 / non-JSON each fail readably.
 *  4. Long text through `audio_tts`: three real requests, stitched duration,
 *     and chunk-offset timestamps.
 *  5. Provider switching openai -> minimax -> edge: each adapter hits only its
 *     own endpoint and carries only its own key.
 *  6. Timeouts: a fake that never answers fails within the documented timeout,
 *     and closing every server lets the process (and `node --test`) exit.
 *
 * Run: <node path from WORKERS.md> test/provider-http.mjs
 *      <node> --test test/provider-http.mjs
 *
 * What this cannot prove: that the live MiniMax/OpenAI/DashScope endpoints use
 * these exact field names and units. That needs one real call with a real key
 * (see README); every shape here is the shape the adapter currently assumes.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeAudio, speak, toWav } from '../lib/providers.js'
import { registerTtsTool, splitScript, toSrt } from '../lib/tts.js'
import { decodeWav } from '../lib/wav.js'
import { startFakeProvider } from './fake-provider.mjs'

/* ---- test harness ---- */

const fakes = []
let workdir = null
let failures = 0

/** Start a fake and remember it so `main` can close every server in `finally`. */
async function fakeUp (options) {
  const fake = await startFakeProvider(options)
  fakes.push(fake)
  return fake
}

/** Record one assertion and print its measured numbers either way. */
function check (label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}${detail === '' ? '' : ` (${detail})`}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  return false
}

/** Run a promise-returning function and return its error instead of throwing. */
async function caught (run) {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

/** Peak and RMS of decoded samples, plus the derived duration. */
function measure (samples, sampleRate) {
  let peak = 0
  let sumSquares = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
    sumSquares += sample * sample
  }
  return {
    frames: samples.length,
    durationSeconds: samples.length / sampleRate,
    peak,
    rms: Math.sqrt(sumSquares / samples.length)
  }
}

/** A deterministic sine tone, used to build a real WAV for the chat test. */
function tone (seconds, sampleRate, hz = 220, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * hz * index / sampleRate) * amplitude
  }
  return samples
}

const fixed = (value, digits = 3) => Number(value).toFixed(digits)

/* ---- 1. OpenAI-compatible TTS ---- */

async function openaiSpeechSection () {
  console.log('-- 1. openai-compatible TTS over real HTTP --')
  const fake = await fakeUp({ mode: 'openai-speech', wavSeconds: 1, wavSampleRate: 24000 })
  const config = { provider: 'openai', baseUrl: fake.url, apiKey: 'test-openai-key', model: 'tts-http-1', voice: 'alloy-http' }
  const text = 'The quick brown fox jumps over the lazy dog. 你好，世界！'

  const result = await speak(config, text)
  const measured = measure(result.samples, result.sampleRate)
  const sent = fake.requests[0]
  const expectedBody = Buffer.byteLength(JSON.stringify({
    model: 'tts-http-1', input: text, voice: 'alloy-http', response_format: 'wav', speed: 1
  }))

  check('openai: exactly one POST to /v1/audio/speech',
    fake.requests.length === 1 && sent?.method === 'POST' && sent?.path === '/v1/audio/speech',
    `${fake.requests.length} request(s): ${sent?.method} ${sent?.path}`)
  check('openai: fake saw its own Host header', sent?.headers.host === fake.host, String(sent?.headers.host))
  check('openai: Authorization is Bearer <key>', sent?.headers.authorization === 'Bearer test-openai-key', String(sent?.headers.authorization))
  check('openai: the exact text reached the wire',
    sent?.json?.input === text, `${String(sent?.json?.input).length} chars, ${Buffer.byteLength(String(sent?.json?.input))} bytes`)
  check('openai: model / voice / response_format arrived',
    sent?.json?.model === 'tts-http-1' && sent?.json?.voice === 'alloy-http' && sent?.json?.response_format === 'wav',
    JSON.stringify({ model: sent?.json?.model, voice: sent?.json?.voice, format: sent?.json?.response_format }))
  check('openai: body size is the adapter\'s exact JSON', sent?.bodySize === expectedBody,
    `${sent?.bodySize} bytes (expected ${expectedBody})`)
  check('openai: frame count matches the fake WAV', measured.frames === fake.wavClip.frames,
    `${measured.frames} samples (fake ${fake.wavClip.frames})`)
  check('openai: sample rate comes from the WAV header',
    result.sampleRate === 24000 && result.effective.sampleRate === 24000,
    `${result.sampleRate} Hz / effective ${result.effective.sampleRate} Hz`)
  check('openai: duration matches the fake clip',
    Math.abs(measured.durationSeconds - fake.wavClip.seconds) < 1e-9,
    `${fixed(measured.durationSeconds)} s (fake ${fixed(fake.wavClip.seconds)} s)`)
  check('openai: samples are non-silent', measured.peak > 0.3 && measured.rms > 0.2,
    `peak ${fixed(measured.peak)} · rms ${fixed(measured.rms)}`)
  check('openai: effective echoes model and voice',
    result.effective.model === 'tts-http-1' && result.effective.voice === 'alloy-http',
    `${result.effective.model} / ${result.effective.voice}`)
  check('openai: effective names the host actually used', result.effective.host === fake.host, String(result.effective.host))
  check('openai: effective provider is openai-compatible', result.effective.provider === 'openai-compatible', String(result.effective.provider))
  check('openai: no timestamps claimed', result.timestamps === null, String(result.timestamps))
  check('openai: fake recorded no internal error', fake.errors.length === 0, `${fake.errors.length} error(s)`)

  fake.setBehavior('slow', { delayMs: 200 })
  const slowStarted = Date.now()
  const slowResult = await speak(config, 'slow but fine')
  const slowElapsed = Date.now() - slowStarted
  check('openai: a 200 ms slow response still succeeds', slowResult.samples.length === fake.wavClip.frames,
    `${slowResult.samples.length} samples after ${slowElapsed} ms`)
  check('openai: the slow call really waited on the response', slowElapsed >= 150 && slowElapsed < 3000, `${slowElapsed} ms`)

  fake.setBehavior('http-401')
  const unauthorized = await caught(() => speak(config, 'denied'))
  check('openai: HTTP 401 is named in the error', /TTS HTTP 401/.test(unauthorized?.message ?? ''), unauthorized?.message)
  check('openai: 401 body is included (invalid api key)', /invalid api key/.test(unauthorized?.message ?? ''), unauthorized?.message)

  fake.setBehavior('http-500')
  const serverError = await caught(() => speak(config, 'boom'))
  check('openai: HTTP 500 is named in the error', /TTS HTTP 500/.test(serverError?.message ?? ''), serverError?.message)
  check('openai: 500 error is a readable string, not undefined',
    typeof serverError?.message === 'string' && serverError.message.length > 10 && !/undefined/.test(serverError.message),
    `${serverError?.name}: ${serverError?.message}`)

  // A 200 that is not audio must be rejected, not played as noise. This case
  // used to be printed as a "documented gap"; the adapter now checks the
  // Content-Type/body shape, so the assertion is that the user sees a readable
  // error instead of a burst of static.
  fake.setBehavior('non-json')
  const htmlError = await caught(() => speak(config, 'html'))
  check('openai: a 200 text/html body is rejected, not decoded as PCM', htmlError !== null, 'no error thrown')
  check('openai: that error names the content-type', /text\/html/.test(htmlError?.message ?? ''), htmlError?.message)
  check('openai: that error includes a body snippet', /bad gateway/.test(htmlError?.message ?? ''), htmlError?.message)
  console.log(`  ok   a 200 text/html body on the speech path throws: ${(htmlError?.message ?? '').slice(0, 90)}`)
}

/* ---- 2. MiniMax T2A ---- */

async function minimaxSection () {
  console.log('-- 2. MiniMax T2A over real HTTP --')
  const fake = await fakeUp({ mode: 'minimax', chunkSeconds: 1.5 })
  const config = {
    provider: 'minimax',
    baseUrl: `${fake.url}/`,
    apiKey: 'mm-test-key',
    model: 'speech-2.8-hd',
    voice: 'female-shaonv',
    sampleRate: 16000,
    groupId: 'group-42'
  }
  const text = '第一句。第二句。'

  const result = await speak(config, text)
  const measured = measure(result.samples, result.sampleRate)
  const sent = fake.requests[0]
  const expectedBody = Buffer.byteLength(JSON.stringify({
    model: 'speech-2.8-hd',
    text,
    stream: false,
    voice_setting: { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 16000, bitrate: 128000, format: 'pcm', channel: 1 },
    subtitle_enable: true,
    subtitle_type: 'sentence'
  }))

  check('minimax: one POST to /v1/t2a_v2 with GroupId',
    fake.requests.length === 1 && sent?.method === 'POST' && sent?.path === '/v1/t2a_v2?GroupId=group-42',
    `${sent?.method} ${sent?.path}`)
  check('minimax: fake saw its own Host header', sent?.headers.host === fake.host, String(sent?.headers.host))
  check('minimax: Authorization is Bearer <key>', sent?.headers.authorization === 'Bearer mm-test-key', String(sent?.headers.authorization))
  check('minimax: the exact text reached the wire', sent?.json?.text === text, `${sent?.json?.text?.length} chars`)
  check('minimax: model / voice / pcm format arrived',
    sent?.json?.model === 'speech-2.8-hd' &&
    sent?.json?.voice_setting?.voice_id === 'female-shaonv' &&
    sent?.json?.audio_setting?.format === 'pcm' &&
    sent?.json?.audio_setting?.sample_rate === 16000,
    JSON.stringify({ model: sent?.json?.model, voice: sent?.json?.voice_setting?.voice_id, format: sent?.json?.audio_setting?.format, rate: sent?.json?.audio_setting?.sample_rate }))
  check('minimax: subtitles requested as sentence marks',
    sent?.json?.subtitle_enable === true && sent?.json?.subtitle_type === 'sentence',
    JSON.stringify({ enable: sent?.json?.subtitle_enable, type: sent?.json?.subtitle_type }))
  check('minimax: body size is the adapter\'s exact JSON', sent?.bodySize === expectedBody,
    `${sent?.bodySize} bytes (expected ${expectedBody})`)
  check('minimax: hex PCM decoded to the expected frame count', measured.frames === sent?.speech?.frames,
    `${measured.frames} samples (fake ${sent?.speech?.frames} frames = ${sent?.speech?.pcmBytes} PCM bytes = ${sent?.speech?.hexChars} hex chars)`)
  check('minimax: sample rate is the requested one', result.sampleRate === 16000, `${result.sampleRate} Hz`)
  check('minimax: duration is exactly the fake clip length',
    Math.abs(measured.durationSeconds - 1.5) < 1e-9, `${fixed(measured.durationSeconds)} s (fake 1.500 s)`)
  check('minimax: decoded samples are non-silent', measured.peak > 0.3 && measured.rms > 0.2,
    `peak ${fixed(measured.peak)} · rms ${fixed(measured.rms)}`)
  check('minimax: millisecond subtitle marks converted to seconds',
    result.timestamps !== null && result.timestamps.items.length === 2 &&
    Math.abs(result.timestamps.items[1].start - 0.75) < 1e-6 &&
    Math.abs(result.timestamps.items[1].end - 1.5) < 1e-6,
    JSON.stringify(result.timestamps?.items ?? null))
  check('minimax: timestamp source says ms were converted',
    /data\.subtitle/.test(result.timestamps?.source ?? '') && /ms→s/.test(result.timestamps?.source ?? ''),
    String(result.timestamps?.source))
  check('minimax: effective echoes provider/model/voice/rate',
    result.effective.provider === 'minimax' && result.effective.model === 'speech-2.8-hd' &&
    result.effective.voice === 'female-shaonv' && result.effective.sampleRate === 16000,
    JSON.stringify({ provider: result.effective.provider, model: result.effective.model, voice: result.effective.voice, rate: result.effective.sampleRate }))
  check('minimax: effective host is the fake', result.effective.host === fake.host, String(result.effective.host))
  check('minimax: fake recorded no internal error', fake.errors.length === 0, `${fake.errors.length} error(s)`)

  fake.setBehavior('status-error')
  const providerError = await caught(() => speak(config, '测试'))
  check('minimax: non-zero base_resp.status_code throws', providerError !== null, String(providerError?.message))
  check('minimax: error names the provider', /MiniMax TTS/.test(providerError?.message ?? ''), providerError?.message)
  check('minimax: error names the provider code 1004', /1004/.test(providerError?.message ?? ''), providerError?.message)
  check('minimax: error carries the provider status_msg', /invalid api key/.test(providerError?.message ?? ''), providerError?.message)
  check('minimax: the error is readable, not undefined',
    typeof providerError?.message === 'string' && providerError.message.length > 10, `${providerError?.name}: ${providerError?.message}`)
  fake.setBehavior('ok')
}

/* ---- 3. audio understanding ---- */

async function understandingSection () {
  console.log('-- 3. audio understanding over real HTTP --')
  const assistantText = '  低沉的金属撞击声，混响约 3 秒。  '
  const fake = await fakeUp({ mode: 'openai-chat', assistantText })
  const wavBytes = toWav(tone(0.6, 16000), 16000)
  const question = '这段音频里是什么声音？'
  const config = { baseUrl: fake.url, apiKey: 'chat-test-key', model: 'qwen-omni-http' }

  const answer = await describeAudio(config, wavBytes, question)
  const sent = fake.requests[0]
  const base64 = wavBytes.toString('base64')
  const expectedBody = Buffer.byteLength(JSON.stringify({
    model: 'qwen-omni-http',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'input_audio', input_audio: { data: base64, format: 'wav' } }
      ]
    }]
  }))

  check('chat: one POST to /v1/chat/completions',
    fake.requests.length === 1 && sent?.method === 'POST' && sent?.path === '/v1/chat/completions',
    `${sent?.method} ${sent?.path}`)
  check('chat: fake saw its own Host header', sent?.headers.host === fake.host, String(sent?.headers.host))
  check('chat: Authorization is Bearer <key>', sent?.headers.authorization === 'Bearer chat-test-key', String(sent?.headers.authorization))
  check('chat: the model id arrived', sent?.json?.model === 'qwen-omni-http', String(sent?.json?.model))
  check('chat: the recorded body really contained input_audio base64', sent?.chat?.hasInputAudio === true,
    `format ${sent?.chat?.inputAudioFormat} · ${sent?.chat?.inputAudioBase64Chars} base64 chars · ${sent?.chat?.inputAudioBytes} decoded bytes`)
  check('chat: base64 decodes to the exact WAV bytes', sent?.chat?.inputAudioBytes === wavBytes.length,
    `${sent?.chat?.inputAudioBytes} decoded bytes (WAV ${wavBytes.length} bytes)`)
  check('chat: base64 string is byte-identical to the input',
    sent?.chat?.inputAudioBase64Chars === base64.length &&
    sent?.json?.messages?.[0]?.content?.[1]?.input_audio?.data === base64,
    `${base64.length} chars, exact match ${sent?.json?.messages?.[0]?.content?.[1]?.input_audio?.data === base64}`)
  check('chat: the question arrived before the audio',
    sent?.json?.messages?.[0]?.content?.[0]?.type === 'text' &&
    sent?.json?.messages?.[0]?.content?.[0]?.text === question,
    String(sent?.json?.messages?.[0]?.content?.[0]?.text))
  check('chat: body size is the adapter\'s exact JSON (base64 included)', sent?.bodySize === expectedBody,
    `${sent?.bodySize} bytes (expected ${expectedBody})`)
  check('chat: the assistant text came back trimmed', answer === assistantText.trim(),
    `${answer.length} chars: ${JSON.stringify(answer)}`)

  const cases = [
    ['http-401', /HTTP 401/],
    ['http-500', /HTTP 500/],
    ['non-json', /不是 JSON/]
  ]
  for (const [behavior, pattern] of cases) {
    fake.setBehavior(behavior)
    const error = await caught(() => describeAudio(config, wavBytes, question))
    check(`chat: ${behavior} fails with the HTTP status or a JSON parse complaint`,
      pattern.test(error?.message ?? ''), error?.message)
    check(`chat: ${behavior} error is a readable string, not undefined`,
      typeof error?.message === 'string' && error.message.length > 10 && !/undefined/.test(error.message),
      `${error?.name}: ${error?.message}`)
    check(`chat: ${behavior} error names the endpoint host`, (error?.message ?? '').includes(fake.host), String(fake.host))
  }
  fake.setBehavior('ok')
  check('chat: every error attempt still reached the fake', fake.requests.length === 4,
    `${fake.requests.length} requests (1 ok + 3 failures)`)
}

/* ---- 4. long text through audio_tts ---- */

async function longTextSection () {
  console.log('-- 4. audio_tts long text: chunking + stitching over real HTTP --')
  const fake = await fakeUp({ mode: 'minimax', chunkSeconds: 1.5 })
  const tools = new Map()
  registerTtsTool({
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: () => undefined
  }, {
    tts: {
      provider: 'minimax',
      baseUrl: fake.url,
      apiKey: 'mm-long-key',
      model: 'speech-2.8-hd',
      voice: 'female-shaonv',
      sampleRate: 16000
    }
  })

  const sentence = `${'甲'.repeat(249)}。`
  const longText = sentence.repeat(6)
  const expectedChunks = splitScript(longText)
  const gapSeconds = 0.15
  const outPath = join(workdir, 'voice-long.wav')

  const result = await tools.get('audio_tts').execute({ text: longText, out: outPath, srt: true }, {})
  const sentTexts = fake.requests.map((request) => request.json?.text ?? '')
  const partSeconds = fake.requests.map((request) => request.speech?.seconds ?? 0)
  const sumParts = partSeconds.reduce((sum, seconds) => sum + seconds, 0)
  const expectedSeconds = sumParts + (fake.requests.length - 1) * gapSeconds

  check('long: 1500 characters really split', expectedChunks.length >= 2 && longText.length === 1500,
    `${longText.length} chars -> ${expectedChunks.length} chunks (${expectedChunks.map((part) => part.length).join(' + ')} chars)`)
  check('long: every chunk became one real HTTP request', fake.requests.length === expectedChunks.length,
    `${fake.requests.length} requests on ${fake.host}`)
  check('long: requests are byte-identical to the split chunks',
    sentTexts.join('|') === expectedChunks.join('|') && sentTexts.join('') === longText,
    sentTexts.map((part) => part.length).join(' + '))
  check('long: no chunk exceeds the 600-char split size',
    sentTexts.every((part) => part.length <= 600), `max ${Math.max(...sentTexts.map((part) => part.length))} chars`)
  check('long: every response carried usable PCM', fake.requests.every((request) => (request.speech?.frames ?? 0) > 0),
    partSeconds.map((seconds) => fixed(seconds)).join(' + ') + ` s`)

  const decoded = decodeWav(await readFile(result.path))
  const fileDuration = decoded.durationSeconds
  const deltaMs = Math.abs(fileDuration - expectedSeconds) * 1000
  check('long: stitched duration equals sum(parts) + gaps within 50 ms', deltaMs <= 50,
    `file ${fixed(fileDuration, 4)} s vs expected ${fixed(expectedSeconds, 4)} s (sum ${fixed(sumParts)} + ${fake.requests.length - 1} x ${gapSeconds} gap; delta ${fixed(deltaMs, 2)} ms)`)
  check('long: reported duration matches the file on disk',
    Math.abs(result.durationSeconds - fileDuration) < 1e-6,
    `result ${fixed(result.durationSeconds)} s · file ${fixed(fileDuration)} s`)
  check('long: file size is the decoded frame count',
    result.bytes === 44 + decoded.channels[0].length * 2,
    `${result.bytes} bytes (44 header + ${decoded.channels[0].length} frames x 2)`)
  check('long: effective reports the chunk count and gap',
    result.effective.chunks === expectedChunks.length && result.effective.gapSeconds === gapSeconds &&
    result.effective.sampleRate === 16000,
    JSON.stringify({ chunks: result.effective.chunks, gap: result.effective.gapSeconds, rate: result.effective.sampleRate }))
  check('long: stitched audio is non-silent', result.metrics.peakDbfs > -2 && result.metrics.clipping === 0,
    `peak ${result.metrics.peakDbfs} dBFS · rms ${result.metrics.rmsDbfs} dBFS · clipping ${result.metrics.clipping}`)

  const expectedMarks = []
  let base = 0
  for (let index = 0; index < fake.requests.length; index += 1) {
    for (const mark of [[0, 750], [750, 1500]]) {
      expectedMarks.push({ start: Number(((base + mark[0] / 1000)).toFixed(3)), end: Number(((base + mark[1] / 1000)).toFixed(3)) })
    }
    base += partSeconds[index] + gapSeconds
  }
  const items = result.timestamps?.items ?? []
  const offsetsCorrect = items.length === expectedMarks.length &&
    items.every((item, index) => Math.abs(item.start - expectedMarks[index].start) <= 0.001 && Math.abs(item.end - expectedMarks[index].end) <= 0.001)
  check('long: chunk timestamps are offset onto the stitched timeline', offsetsCorrect,
    `${items.length} marks: starts ${items.map((item) => item.start).join(', ')}`)
  check('long: timestamp source and completeness are reported',
    result.timestamps?.complete === true && /data\.subtitle/.test(result.timestamps?.source ?? ''),
    `${result.timestamps?.source} · complete=${result.timestamps?.complete}`)
  check('long: last mark ends at the stitched duration',
    items.length > 0 && Math.abs(items[items.length - 1].end - expectedSeconds) <= 0.001,
    `last end ${items[items.length - 1]?.end} s vs ${fixed(expectedSeconds)} s`)

  const srtText = await readFile(result.srtPath, 'utf8')
  check('long: SRT uses the same offset timeline', srtText === toSrt(items) && srtText.includes('00:00:01,650'),
    `${srtText.split('\n').length} SRT lines, second chunk starts at ${srtText.match(/(\d{2}:\d{2}:\d{2},\d{3}) -->/g)?.[2] ?? 'missing'}`)
  check('long: fake recorded no internal error', fake.errors.length === 0, `${fake.errors.length} error(s)`)
}

/* ---- 5. provider switching ---- */

async function providerSwitchSection () {
  console.log('-- 5. provider switch: no base URL / key leak --')
  const openaiFake = await fakeUp({ mode: 'openai-speech' })
  const minimaxFake = await fakeUp({ mode: 'minimax' })
  const edgeFake = await fakeUp({ mode: 'edge-ws' })

  const first = await speak({ provider: 'openai', baseUrl: openaiFake.url, apiKey: 'openai-key-A', model: 'tts-a', voice: 'alloy-a' }, 'alpha')
  check('switch 1: openai used only its own endpoint',
    openaiFake.requests.length === 1 && openaiFake.requests[0].headers.host === openaiFake.host,
    `${openaiFake.requests.length} request on ${openaiFake.requests[0]?.headers.host}`)
  check('switch 1: openai sent only its own key',
    openaiFake.requests[0].headers.authorization === 'Bearer openai-key-A',
    String(openaiFake.requests[0].headers.authorization))
  check('switch 1: minimax and edge servers untouched',
    minimaxFake.requests.length === 0 && edgeFake.upgrades.length === 0,
    `${minimaxFake.requests.length} minimax / ${edgeFake.upgrades.length} edge requests`)
  check('switch 1: openai audio decoded', first.samples.length === openaiFake.wavClip.frames && first.effective.host === openaiFake.host,
    `${first.samples.length} samples from ${first.effective.host}`)

  const second = await speak({ provider: 'minimax', baseUrl: minimaxFake.url, apiKey: 'minimax-key-B', model: 'speech-b', voice: 'female-shaonv', sampleRate: 16000 }, 'beta')
  check('switch 2: minimax used only its own endpoint',
    minimaxFake.requests.length === 1 && minimaxFake.requests[0].headers.host === minimaxFake.host,
    `${minimaxFake.requests.length} request on ${minimaxFake.requests[0]?.headers.host}`)
  check('switch 2: minimax sent only its own key',
    minimaxFake.requests[0].headers.authorization === 'Bearer minimax-key-B',
    String(minimaxFake.requests[0].headers.authorization))
  check('switch 2: the previous openai server got no second request', openaiFake.requests.length === 1,
    `${openaiFake.requests.length} openai request(s)`)
  check('switch 2: the openai key never appears on the minimax wire',
    !JSON.stringify(minimaxFake.requests).includes('openai-key-A'),
    `minimax request contains openai-key-A: ${JSON.stringify(minimaxFake.requests).includes('openai-key-A')}`)
  check('switch 2: effective host is the minimax fake', second.effective.host === minimaxFake.host, String(second.effective.host))

  const edgeConfig = {
    provider: 'edge',
    endpoint: edgeFake.wsUrl('/edge'),
    timeoutMs: 3000,
    voice: 'zh-CN-XiaoxiaoNeural',
    baseUrl: minimaxFake.url,
    apiKey: 'openai-key-A'
  }
  const third = await speak(edgeConfig, 'gamma')
  const upgrade = edgeFake.upgrades[0]
  const upgradeHeaders = JSON.stringify(upgrade?.headers ?? {})
  check('switch 3: edge used only its own endpoint',
    edgeFake.upgrades.length === 1 && upgrade?.path === '/edge' && upgrade?.headers?.host === edgeFake.host,
    `${edgeFake.upgrades.length} upgrade on ${upgrade?.headers?.host} at ${upgrade?.path}`)
  check('switch 3: edge sent no Authorization header', upgrade?.headers?.authorization === undefined,
    String(upgrade?.headers?.authorization))
  check('switch 3: the previous key never travels on the edge upgrade', !upgradeHeaders.includes('openai-key-A'),
    `upgrade headers contain openai-key-A: ${upgradeHeaders.includes('openai-key-A')}`)
  check('switch 3: previous HTTP servers got no new request',
    openaiFake.requests.length === 1 && minimaxFake.requests.length === 1,
    `${openaiFake.requests.length} openai / ${minimaxFake.requests.length} minimax`)
  check('switch 3: edge decoded its own WAV frame over WebSocket',
    third.effective.provider === 'edge' && third.effective.decoder === 'wav' &&
    third.samples.length === edgeFake.edgeClip.frames,
    `${third.samples.length} samples · decoder ${third.effective.decoder}`)
  check('switch 3: edge sample rate comes from the frame',
    third.sampleRate === edgeFake.edgeClip.sampleRate, `${third.sampleRate} Hz`)
  const thirdMeasured = measure(third.samples, third.sampleRate)
  check('switch 3: edge audio is non-silent', thirdMeasured.peak > 0.3, `peak ${fixed(thirdMeasured.peak)}`)
}

/* ---- 6. timeouts ---- */

async function timeoutSection () {
  console.log('-- 6. timeouts: a fake that never answers --')

  const edgeFake = await fakeUp({ mode: 'edge-ws', behavior: 'silent' })
  const edgeStarted = Date.now()
  const edgeError = await caught(() => speak({
    provider: 'edge',
    endpoint: edgeFake.wsUrl('/edge-silent'),
    voice: 'zh-CN-XiaoxiaoNeural',
    timeoutMs: 300
  }, '超时测试'))
  const edgeElapsed = Date.now() - edgeStarted
  check('timeout (edge): the WebSocket handshake was accepted', edgeFake.upgrades.length === 1,
    `${edgeFake.upgrades.length} upgrade at ${edgeFake.upgrades[0]?.path}`)
  check('timeout (edge): fails inside the documented timeoutMs=300', edgeElapsed >= 250 && edgeElapsed <= 2000,
    `${edgeElapsed} ms (configured 300 ms)`)
  check('timeout (edge): error carries edgeCode=timeout', edgeError?.edgeCode === 'timeout', String(edgeError?.edgeCode))
  check('timeout (edge): message names the timeout and the missing audio',
    /300 ms/.test(edgeError?.message ?? '') && /没有收到/.test(edgeError?.message ?? ''), edgeError?.message)
  check('timeout (edge): message is readable, not undefined',
    typeof edgeError?.message === 'string' && edgeError.message.length > 10, `${edgeError?.name}: ${edgeError?.message}`)

  const httpFake = await fakeUp({ mode: 'openai-speech', behavior: 'silent' })
  const realTimeout = AbortSignal.timeout
  const capMs = 250
  let requestedTimeoutMs = null
  AbortSignal.timeout = (ms) => {
    requestedTimeoutMs = ms
    return realTimeout.call(AbortSignal, Math.min(ms, capMs))
  }
  const httpStarted = Date.now()
  let httpError = null
  try {
    await speak({ provider: 'openai', baseUrl: httpFake.url, apiKey: 'timeout-key' }, 'never answered')
  } catch (error) {
    httpError = error
  } finally {
    AbortSignal.timeout = realTimeout
  }
  const httpElapsed = Date.now() - httpStarted
  check('timeout (http): adapter asks for its documented 120000 ms', requestedTimeoutMs === 120000,
    `${requestedTimeoutMs} ms requested; the test capped the wait at ${capMs} ms`)
  check('timeout (http): the request reached the fake before aborting', httpFake.requests.length === 1,
    `${httpFake.requests.length} request recorded`)
  check('timeout (http): rejects in bounded time', httpElapsed >= capMs - 50 && httpElapsed <= 2000, `${httpElapsed} ms`)
  check('timeout (http): readable TimeoutError, not undefined',
    (httpError?.name === 'TimeoutError' || /timeout/i.test(httpError?.message ?? '')) &&
    typeof httpError?.message === 'string' && httpError.message.length > 0,
    `${httpError?.name}: ${httpError?.message}`)
  console.log(`  note: the HTTP path surfaces Node's own message ("${httpError?.message}") without naming the endpoint; only the Edge adapter wraps its timeout.`)
}

/* ---- main ---- */

async function main () {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-audio-http-'))
  try {
    await openaiSpeechSection()
    await minimaxSection()
    await understandingSection()
    await longTextSection()
    await providerSwitchSection()
    await timeoutSection()
  } finally {
    for (const fake of fakes) await fake.close()
    await rm(workdir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  failures += 1
  console.log(`  FAIL test crashed: ${error?.stack ?? error}`)
}

// Proof the run leaves nothing behind: every server is closed, and the process
// exits on its own (no process.exit) so `node --test` can see a clean exit.
const stillListening = fakes.filter((fake) => fake.server.listening || !fake.closed).length
check('finally: every fake server was closed', stillListening === 0, `${stillListening} open of ${fakes.length}`)
let resources = process.getActiveResourcesInfo()
for (let attempt = 0; attempt < 10 && resources.includes('TCPServerWrap'); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
  resources = process.getActiveResourcesInfo()
}
check('finally: no TCP server handle remains', !resources.includes('TCPServerWrap'),
  `active handles: ${resources.length === 0 ? '(none)' : resources.join(', ')}`)

console.log('')
if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s) — see FAIL lines above`)
  process.exitCode = 1
} else {
  console.log('OK: adapters behave over real HTTP — 6 sections, every number above measured on loopback')
  process.exitCode = 0
}
