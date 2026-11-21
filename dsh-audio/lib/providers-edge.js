/**
 * Microsoft Edge "Read Aloud" speech provider — free, no API key.
 *
 * Why this file exists: MiniMax bills per character, while the WebSocket the
 * Edge browser extension uses for "read aloud" needs no account at all. The
 * protocol is undocumented, so the parts that actually matter are spelled out
 * here rather than guessed at call sites:
 *
 *  1. Handshake. The service wants a time-limited anti-abuse token, not a key.
 *     Since around 2026-10-10 it accepts only the "v2" `Sec-MS-GEC` token:
 *     `<16 hex CS64 checksum>-<64 hex SHA-256>` over
 *     `<copyright line><Windows file time floored to 5 min><client token>`.
 *     The older single-SHA-256 token (still what most write-ups describe) is
 *     answered with HTTP 403; it is kept below as `v1` for diagnosis only.
 *     A clock disagreeing with the server also yields 403, so the retry path
 *     re-anchors on the server's `Date` header before giving up.
 *  2. Wire format. A text frame `speech.config` declares the audio format,
 *     then a text frame `ssml` carries the request. Binary frames come back as
 *     a 2-byte big-endian header length, ASCII headers, then payload. Text
 *     frames `Path:audio.metadata` carry word boundaries in 100 ns ticks and
 *     `Path:turn.end` terminates the turn.
 *  3. Output format — the hard limit. The service refuses every uncompressed
 *     format (verified 2026-11-21, exact close code 1007 / server text
 *     "Unsupported Edge output format: raw-24khz-16bit-mono-pcm."), including
 *     `riff-…-pcm`, 16 kHz and 8 kHz variants. Of ~30 Azure format names tried,
 *     the only ones accepted are compressed: `audio-24khz-48kbitrate-mono-mp3`,
 *     `audio-24khz-96kbitrate-mono-mp3` and `webm-24khz-16bit-mono-opus`.
 *     This package ships no audio codec (zero package dependencies), so it
 *     decodes the service bytes by shelling out to an ffmpeg binary — not a
 *     package, and detected in this order: `config.ffmpegPath`, DSH's bundled
 *     `~/.dsh/tools/ffmpeg/bin/ffmpeg[.exe]`, then `ffmpeg` on PATH. Decoding
 *     goes through a temp file under `os.tmpdir()` with a 15 s timeout and is
 *     always cleaned up. If no ffmpeg and no injected decoder exist, `speak()`
 *     fails with a precise `edgeCode: 'undecodable'` error instead of handing
 *     on garbage, and `audio_tts` can still write the MP3 bytes (browsers play
 *     them directly). Three escape hatches are built in:
 *       - `config.ffmpegPath` — pin or explicitly disable (`'nonexistent'`)
 *         the binary; the discovery result is cached per process.
 *       - `config.decodeAudio` — a host-provided
 *         `({ bytes, mimeType, format }) => ({ samples, sampleRate })` wins
 *         over ffmpeg, so a future native decoder needs no changes here.
 *       - `config.outputFormat` — if Microsoft ever re-enables PCM/riff,
 *         `speak()` decodes it (raw 16-bit LE or WAV) with no external tool.
 *
 * The built-in global `WebSocket` (Node >= 22) is used on purpose: Node's
 * implementation accepts `new WebSocket(url, { headers })`, and the service
 * checks browser-ish headers (Origin/User-Agent), so hand-rolling a TLS client
 * is unnecessary.
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import { normalizeVoiceList } from './providers.js'
import { decodeWav } from './wav.js'

/* ---- service constants ---- */

/** Public client token shared by every Edge read-aloud client. */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** The copyright line Microsoft's own client hashes ahead of the token seed. */
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.'

/** Chromium version reported in `Sec-MS-GEC-Version`; the server compares it. */
const CHROMIUM_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0]

const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const VOICE_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'

/**
 * The only format family the read-aloud service still serves (48 kbit/s CBR
 * MP3). Kept as a constant, and overridable, because Microsoft has changed the
 * accepted set before; see the header comment for the measurement.
 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** Compression rate from the format name, used to estimate duration. */
const OUTPUT_BITRATE_BPS = 48000

/** Bytes per frame of 16-bit mono PCM. */
const BYTES_PER_FRAME = 2

/** Microsoft metadata offsets are in 100 ns ticks. */
const TICKS_PER_SECOND = 1e7

/** Windows FILETIME epoch: 1601-01-01 in Unix seconds. */
const WIN_EPOCH_SECONDS = 11644473600n

/** `Sec-MS-GEC` is only valid inside a rolling 5-minute window. */
const GEC_WINDOW_SECONDS = 300n

/** The service caps one SSML request at 4096 bytes; bigger needs splitting. */
const MAX_REQUEST_BYTES = 4096

/** Used when the server's clock and ours disagree by more than this. */
const CLOCK_SKEW_RETRY_THRESHOLD_SECONDS = 30

/** How many first characters of a voice-list name to keep in a log line. */
const VOICE_NAME_LIMIT = 120

/** ffmpeg decode budget; a 60 s sentence decodes in well under a second. */
const FFMPEG_TIMEOUT_MS = 15000

/** DSH ships ffmpeg for its media tools; this is the standard location. */
const FFMPEG_BUNDLED_PATH = join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/**
 * Defaults for the whole provider. `speed`/`pitch`/`volume` follow the
 * plugin-wide convention (multiplier, semitones, multiplier) and are translated
 * into SSML prosody attributes here.
 */
export const EDGE_DEFAULTS = {
  voice: 'zh-CN-XiaoxiaoNeural',
  speed: 1,
  pitch: 0,
  volume: 1,
  timeoutMs: 10000,
  probeTimeoutMs: 8000,
  gecVersion: 2,
  chromiumVersion: CHROMIUM_VERSION,
  outputFormat: OUTPUT_FORMAT,
  wordBoundary: true,
  ffmpegPath: ''
}

/**
 * A shortlist for the settings page and for the model, so it picks real voice
 * ids instead of inventing one. `listVoices()` returns the full live catalogue
 * (318 voices when measured); any id from it also works.
 */
export const EDGE_VOICE_CATALOG = [
  { id: 'zh-CN-XiaoxiaoNeural', note: '中文女声，通用旁白（自然）' },
  { id: 'zh-CN-XiaoyiNeural', note: '中文女声，偏活泼' },
  { id: 'zh-CN-YunxiNeural', note: '中文男声，偏年轻' },
  { id: 'zh-CN-YunjianNeural', note: '中文男声，激情解说' },
  { id: 'zh-CN-YunyangNeural', note: '中文男声，新闻播报' },
  { id: 'zh-CN-YunxiaNeural', note: '中文男声，少年感' },
  { id: 'zh-TW-HsiaoChenNeural', note: '中文（台湾）女声' },
  { id: 'zh-HK-HiuMaanNeural', note: '中文（粤语）女声' },
  { id: 'en-US-AriaNeural', note: 'English female, expressive' },
  { id: 'en-US-JennyNeural', note: 'English female, friendly' },
  { id: 'en-US-GuyNeural', note: 'English male, news' },
  { id: 'en-US-AndrewMultilingualNeural', note: 'English male, multilingual' },
  { id: 'en-GB-SoniaNeural', note: 'English female, UK' },
  { id: 'ja-JP-NanamiNeural', note: '日本語 女声' }
]

/** Header set Edge's own read-aloud request sends; the service is picky. */
const BROWSER_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Language': 'en-US,en;q=0.9'
}

/**
 * Headers for the WebSocket upgrade. `Sec-WebSocket-Version`/`Upgrade` are set
 * by the client itself — passing them again makes the handshake non-conforming
 * (observed as a duplicated `13, 13` value), so only the browser-ish extras are
 * added here.
 */
const WS_HEADERS = {
  ...BROWSER_HEADERS,
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache'
}

/* ---- Sec-MS-GEC token ---- */

/** Turn a Unix timestamp into 100 ns Windows FILETIME ticks, 5-minute floored. */
function fileTimeTicks (unixSeconds) {
  const seconds = BigInt(Math.floor(unixSeconds)) + WIN_EPOCH_SECONDS
  return (seconds - seconds % GEC_WINDOW_SECONDS) * 10000000n
}

/**
 * Legacy (v1) token: SHA-256 over `<ticks><client token>`, uppercase hex.
 *
 * The server no longer accepts these since 2026-10, but keeping the function
 * documents the algorithm the wider ecosystem still describes and lets a future
 * server flip be diagnosed without re-deriving anything.
 * @param {{ unixSeconds?: number, clockSkewSeconds?: number }} [options]
 * @returns {string} 64 uppercase hex characters.
 */
export function secMsGecV1 (options = {}) {
  const unixSeconds = Number(options.unixSeconds ?? Date.now() / 1000) + Number(options.clockSkewSeconds ?? 0)
  const seed = `${fileTimeTicks(unixSeconds)}${TRUSTED_CLIENT_TOKEN}`
  return createHash('sha256').update(seed, 'ascii').digest('hex').toUpperCase()
}

const SWAP_FIRST_WORD = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 }
const SWAP_SECOND_WORD = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 }
const MIX_FIRST_WORD = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]
const MIX_SECOND_WORD = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69]

/** Rotate the halves of a 32-bit word (the CS64 mixing primitive). */
function swapHalves (value) {
  return ((value << 16) | (value >>> 16)) >>> 0
}

function swapTerm (word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord)
  const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0
  return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0
}

function mixWord (value, multipliers) {
  let mixed = value
  for (const multiplier of multipliers) mixed = Math.imul(swapHalves(mixed), multiplier) >>> 0
  return mixed
}

/**
 * The 64-bit "CS64" checksum half of a v2 token.
 *
 * A keyed two-lane mixing function over 32-bit word pairs, keyed by the first
 * 8 bytes of the SHA-256 digest. It is not a standard construction; the
 * constants and shape were reverse-engineered from Microsoft's client (see
 * rany2/edge-tts#492), which is why they are data tables rather than anything
 * recognisable.
 * @param {Buffer} message - bytes the digest was computed over.
 * @param {Buffer} digest - SHA-256 digest of `message`.
 * @returns {Buffer} 8 checksum bytes, little-endian word pairs.
 */
function cs64Checksum (message, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0

  // Word pairs, zero-padded; a trailing half-pair is padded, not dropped.
  const paddedLength = Math.ceil(message.length / 8) * 8
  const padded = Buffer.alloc(paddedLength)
  message.copy(padded)

  let swapSum = 0
  let lastSwap = 0
  let mix = 0
  let mixSum = 0
  for (let offset = 0; offset < paddedLength; offset += 8) {
    const firstWord = padded.readUInt32LE(offset)
    const secondWord = padded.readUInt32LE(offset + 4)

    const firstSwap = swapTerm(firstWord, keyA, SWAP_FIRST_WORD)
    lastSwap = swapTerm(secondWord, keyB, SWAP_SECOND_WORD)
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0

    mix = mixWord(Math.imul(mix + firstWord, keyA), MIX_FIRST_WORD)
    mixSum = (mixSum + mix) >>> 0
    mix = mixWord(Math.imul(mix + secondWord, keyB), MIX_SECOND_WORD)
    mixSum = (mixSum + mix) >>> 0
  }

  const checksum = Buffer.alloc(8)
  checksum.writeUInt32LE((lastSwap ^ mix) >>> 0, 0)
  checksum.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4)
  return checksum
}

/**
 * Current (v2) token: `<16 hex CS64>-<64 hex SHA-256>`.
 *
 * The SHA-256 is the plain standard hash over the copyright line, the floored
 * FILETIME ticks and the client token; only the checksum half is custom.
 * @param {{ unixSeconds?: number, clockSkewSeconds?: number }} [options]
 * @returns {string} e.g. `"EAEC494D4F2FCA1C-1474D8ED…"`.
 */
export function secMsGecV2 (options = {}) {
  const unixSeconds = Number(options.unixSeconds ?? Date.now() / 1000) + Number(options.clockSkewSeconds ?? 0)
  const message = Buffer.from(`${EDGE_COPYRIGHT}${fileTimeTicks(unixSeconds)}${TRUSTED_CLIENT_TOKEN}`, 'utf8')
  const digest = createHash('sha256').update(message).digest()
  const checksum = cs64Checksum(message, digest)
  return `${checksum.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

/**
 * Generate the `Sec-MS-GEC` token for a protocol version.
 * @param {{ version?: number, unixSeconds?: number, clockSkewSeconds?: number }} [options]
 * @returns {string} token; version 1 is 64 hex chars, version 2 is `<16>-<64>`.
 */
export function generateSecMsGec (options = {}) {
  return Number(options.version ?? EDGE_DEFAULTS.gecVersion) >= 2 ? secMsGecV2(options) : secMsGecV1(options)
}

/* ---- text and SSML ---- */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * JavaScript-style UTC date string the service expects in frame headers.
 * Built by hand: `toLocaleString` would make the request locale-dependent.
 */
function dateToFrameString (date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    DAY_NAMES[date.getUTCDay()],
    MONTH_NAMES[date.getUTCMonth()],
    pad(date.getUTCDate()),
    date.getUTCFullYear(),
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
    'GMT+0000 (Coordinated Universal Time)'
  ].join(' ')
}

/** XML-escape text for SSML; order matters (`&` first). */
function escapeXml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Reverse of `escapeXml` for word-boundary text the service sends back. */
function unescapeXml (value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Strip characters the service rejects (notably vertical tab from OCR'd PDFs)
 * and translate MiniMax-style inline pauses `<#1.5#>` into SSML breaks, so a
 * script written for MiniMax keeps working after switching providers.
 */
function toSsmlBody (text) {
  const cleaned = String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
  const pieces = cleaned.split(/<#(\d{1,2}(?:\.\d{1,2})?)#>/)
  let body = ''
  for (let index = 0; index < pieces.length; index += 1) {
    if (index % 2 === 0) {
      body += escapeXml(pieces[index])
    } else {
      const seconds = Number(pieces[index])
      if (Number.isFinite(seconds) && seconds > 0) body += `<break time="${seconds}s"/>`
    }
  }
  return body
}

/** `speed` multiplier -> prosody rate, e.g. 1.2 -> `+20%`. */
function rateAttribute (speed) {
  const percent = Math.round((speed - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

/** `pitch` semitones -> prosody pitch, e.g. 2 -> `+2st`; 0 stays in Hz. */
function pitchAttribute (pitch) {
  const semitones = Math.round(pitch)
  if (semitones === 0) return '+0Hz'
  return `${semitones > 0 ? '+' : ''}${semitones}st`
}

/** `volume` multiplier -> prosody volume, e.g. 1 -> `+0%`. */
function volumeAttribute (volume) {
  const percent = Math.round((volume - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

/** First `xx-YY` of a voice id, used as the SSML language. */
function voiceLocale (voice) {
  const match = /^([a-z]{2,3}-[A-Za-z]{2})-/i.exec(String(voice))
  return match === null ? 'en-US' : match[1]
}

/** Build the SSML document for one request. */
function buildSsml (text, voice, speed, pitch, volume) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voiceLocale(voice)}'>` +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody rate='${rateAttribute(speed)}' pitch='${pitchAttribute(pitch)}' volume='${volumeAttribute(volume)}'>` +
    `${toSsmlBody(text)}` +
    '</prosody></voice></speak>'
}

/** `Path:speech.config` frame: declares output format and metadata switches. */
function speechConfigFrame (wordBoundary, outputFormat) {
  const payload = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: wordBoundary ? 'false' : 'true',
            wordBoundaryEnabled: wordBoundary ? 'true' : 'false'
          },
          outputFormat
        }
      }
    }
  }
  return `X-Timestamp:${dateToFrameString()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    `${JSON.stringify(payload)}\r\n`
}

/** `Path:ssml` frame: the actual synthesis request. */
function ssmlFrame (requestId, ssml) {
  return `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${dateToFrameString()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
}

/* ---- frame parsing ---- */

/** Parse `Key:value\r\n` header blocks, lower-cased keys. */
function parseHeaderBlock (block) {
  const headers = {}
  for (const line of String(block).split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return headers
}

/** Split a text frame into headers and body at the first blank line. */
function parseTextFrame (text) {
  const split = text.indexOf('\r\n\r\n')
  if (split < 0) return null
  return { headers: parseHeaderBlock(text.slice(0, split)), body: text.slice(split + 4) }
}

/** Parse one `audio.metadata` payload into normalized boundary items. */
function parseMetadataFrame (body) {
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return []
  }
  const list = Array.isArray(payload?.Metadata) ? payload.Metadata : []
  const items = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    // SessionEnd is bookkeeping; anything else unknown is ignored rather than
    // treated as a failure, because the service adds types over time.
    if (entry.Type !== 'WordBoundary' && entry.Type !== 'SentenceBoundary') continue
    const offset = Number(entry.Data?.Offset)
    const duration = Number(entry.Data?.Duration)
    const text = String(entry.Data?.text?.Text ?? '').trim()
    if (!Number.isFinite(offset) || text.length === 0) continue
    const start = offset / TICKS_PER_SECOND
    const end = (offset + (Number.isFinite(duration) ? duration : 0)) / TICKS_PER_SECOND
    items.push({
      text: unescapeXml(text),
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3))
    })
  }
  return items
}

/**
 * Split a binary audio frame into headers and payload.
 *
 * The documented layout is `<u16 BE header length><headers><audio>`, but at
 * least one known client locates the payload by searching for the ASCII
 * `Path:audio` header instead. Accept both: try the declared length first,
 * fall back to the delimiter search if it does not line up.
 */
function splitAudioFrame (buffer) {
  if (buffer.length < 4) return null
  const declared = buffer.readUInt16BE(0)
  for (const start of [2 + declared, declared]) {
    if (start < 2 || start > buffer.length) continue
    const headerText = buffer.toString('latin1', 2, start)
    if (!headerText.includes('Path:audio')) continue
    return { headers: parseHeaderBlock(headerText), payload: buffer.subarray(start) }
  }
  const marker = buffer.indexOf('Path:audio\r\n', 0, 'latin1')
  if (marker >= 0) {
    const start = marker + 'Path:audio\r\n'.length
    const headerText = buffer.toString('latin1', 2, start)
    return { headers: parseHeaderBlock(headerText), payload: buffer.subarray(start) }
  }
  return null
}

/** Little-endian 16-bit PCM -> Float32 samples. */
function pcm16ToSamples (pcm, sampleRate) {
  const frames = Math.floor(pcm.length / BYTES_PER_FRAME)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = pcm.readInt16LE(index * BYTES_PER_FRAME) / 32768
  }
  return { samples, sampleRate }
}

/** Sample rate embedded in a raw format name, e.g. `raw-24khz-…` -> 24000. */
function rawPcmSampleRate (format) {
  const match = /^raw-(\d+)-16bit-mono-pcm$/i.exec(String(format))
  if (match === null) return null
  const khz = Number(match[1])
  return Number.isFinite(khz) && khz > 0 ? khz * 1000 : null
}

/* ---- external decoder ---- */

/**
 * Per-process cache: `''` is the auto-discovery answer, anything else is a
 * caller-pinned path. Discovery spawns a process, so it must not run per chunk.
 */
const FFMPEG_CACHE = new Map()

/** True when `candidate` is an ffmpeg that actually runs. */
function usableFfmpeg (candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null
  const trimmed = candidate.trim()
  try {
    execFileSync(trimmed, ['-version'], { stdio: 'pipe', timeout: 5000, windowsHide: true, env: process.env })
    return trimmed
  } catch {
    return null
  }
}

/** Ask the OS which ffmpeg would run from PATH (`where` / `which`). */
function locateFfmpegOnPath () {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(command, ['ffmpeg'], { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString('utf8')
    for (const line of output.split(/\r?\n/)) {
      const found = usableFfmpeg(line)
      if (found !== null) return found
    }
  } catch { /* not on PATH */ }
  return null
}

/**
 * Find an ffmpeg binary for decoding the service's MP3/Opus bytes.
 *
 * Order: explicit `ffmpegPath` (a wrong path deliberately resolves to `null`,
 * which is also how the MP3 fallback is tested) → DSH's bundled ffmpeg →
 * PATH → `null`. The answer is cached per process because each probe spawns
 * a process. A binary is only accepted if `-version` runs, so a stale alias
 * (e.g. a Windows Store stub) is rejected instead of failing mid-decode.
 * @param {{ ffmpegPath?: string }} [options] - explicit binary to use.
 * @returns {string|null} absolute path/command, or null when none works.
 */
export function findFfmpeg (options = {}) {
  const explicit = typeof options.ffmpegPath === 'string' ? options.ffmpegPath.trim() : ''
  const key = explicit === '' ? '' : `path:${explicit}`
  if (FFMPEG_CACHE.has(key)) return FFMPEG_CACHE.get(key)

  let found = null
  if (explicit !== '') {
    found = usableFfmpeg(explicit)
  } else {
    found = usableFfmpeg(FFMPEG_BUNDLED_PATH)
    if (found === null) found = locateFfmpegOnPath()
  }
  FFMPEG_CACHE.set(key, found)
  return found
}

/**
 * Decode one encoded speech clip by piping it through ffmpeg via temp files.
 *
 * The file handed to ffmpeg keeps its real extension (`.mp3`/`.webm`) because
 * ffmpeg's probe is happier with one; the output is 24 kHz mono 16-bit WAV,
 * which `decodeWav` then turns into Float32 samples. The temp directory is
 * removed in `finally` on every path, including timeout and spawn failure.
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
function decodeWithFfmpeg (rendered, ffmpegPath) {
  const extension = /webm|opus/i.test(`${rendered.mimeType} ${rendered.format}`) ? 'webm' : 'mp3'
  const directory = mkdtempSync(join(tmpdir(), 'dsh-edge-'))
  const input = join(directory, `speech.${extension}`)
  const output = join(directory, 'speech.wav')
  try {
    writeFileSync(input, rendered.bytes)
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input,
      '-ac', '1', '-ar', '24000',
      '-f', 'wav', output
    ], { stdio: 'pipe', timeout: FFMPEG_TIMEOUT_MS, windowsHide: true })
    const decoded = decodeWav(readFileSync(output))
    if (decoded.channels.length === 0 || decoded.channels[0].length === 0) {
      throw new Error('ffmpeg 解码结果为空')
    }
    return { samples: decoded.channels[0], sampleRate: decoded.sampleRate }
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() : ''
    const exit = error?.status === undefined ? '' : `，exit ${error.status}`
    const detail = stderr !== '' ? `：${stderr.slice(0, 300)}` : `（${error?.code ?? error?.message ?? error}）`
    const wrapped = new Error(`Edge TTS: ffmpeg 解码失败（${ffmpegPath}${exit}）${detail}`)
    wrapped.edgeCode = 'decode'
    wrapped.cause = error
    throw wrapped
  } finally {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/* ---- transport ---- */

/** Testing hook: a fixed clock lets token generation be checked offline. */
function nowSeconds (config) {
  const fixed = Number(config?.now)
  return Number.isFinite(fixed) ? fixed : Date.now() / 1000
}

function extraCookieHeader () {
  // Edge's own client sends a random MUID with every connection.
  return `muid=${randomBytes(16).toString('hex').toUpperCase()};`
}

/** Build the upgrade URL with a fresh token and connection id. */
function buildWssUrl (config, clockSkewSeconds) {
  const gecVersion = Number(config.gecVersion ?? EDGE_DEFAULTS.gecVersion) >= 2 ? 2 : 1
  const chromiumVersion = String(config.chromiumVersion ?? EDGE_DEFAULTS.chromiumVersion)
  const endpoint = String(config.endpoint ?? WSS_URL)
  const token = generateSecMsGec({
    version: gecVersion,
    unixSeconds: nowSeconds(config),
    clockSkewSeconds
  })
  const query = new URLSearchParams()
  query.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN)
  query.set('ConnectionId', randomUUID().replace(/-/g, ''))
  query.set('Sec-MS-GEC', token)
  query.set('Sec-MS-GEC-Version', `${gecVersion}-${chromiumVersion}`)
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query.toString()}`
}

/**
 * A handshake failure tells us nothing through the WebSocket API (Node reports
 * a bare TypeError and close code 1006). This repeats the upgrade with plain
 * HTTPS purely to learn the HTTP status, so the error the caller sees says
 * "HTTP 403" instead of "something failed".
 */
function probeHandshakeStatus (url, timeoutMs) {
  return new Promise((resolve) => {
    let request
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { request?.destroy() } catch { /* already gone */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ status: null, error: `握手探测超时（${timeoutMs} ms）` }), timeoutMs)
    try {
      const target = new URL(url.replace(/^wss:/, 'https:'))
      request = https.request({
        host: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          ...WS_HEADERS,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64')
        }
      })
      request.on('upgrade', (response, socket) => {
        socket.destroy()
        finish({ status: response.statusCode, date: response.headers.date })
      })
      request.on('response', (response) => {
        response.resume()
        finish({ status: response.statusCode, date: response.headers.date })
      })
      request.on('error', (error) => finish({ status: null, error: error.message }))
      request.end()
    } catch (error) {
      finish({ status: null, error: error?.message ?? String(error) })
    }
  })
}

/** Read the server clock from a plain HTTPS response's `Date` header. */
async function readServerClockSkew (config, timeoutMs) {
  const url = String(config.voiceListUrl ?? `${VOICE_LIST_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`)
  const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  const date = response.headers.get('date')
  if (date === null) throw new Error('响应里没有 Date 头')
  const serverTime = Date.parse(date)
  if (!Number.isFinite(serverTime)) throw new Error(`无法解析 Date 头：${date}`)
  return (serverTime - Date.now()) / 1000
}

/* ---- synthesis ---- */

/**
 * One WebSocket turn. Resolves with the encoded audio bytes the service sent
 * (whatever `outputFormat` produced), the MIME type, and boundary marks;
 * rejects with an Error carrying `edgeCode` (`handshake` / `timeout` / `closed`
 * / `empty`) so the retry logic can tell a clock problem from a real failure.
 */
function synthesizeOnce (job, config, clockSkewSeconds) {
  const timeoutMs = Number(config.timeoutMs ?? EDGE_DEFAULTS.timeoutMs)
  const url = buildWssUrl(config, clockSkewSeconds)
  const requestId = randomUUID().replace(/-/g, '')
  const audioChunks = []
  const marks = []
  const contentTypes = new Set()
  let socket = null
  let timer = null
  let settled = false
  let opened = false

  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try { socket?.close(1000, 'done') } catch { /* socket already closing */ }
      if (error) reject(error)
      else resolve(value)
    }

    const fail = (message, edgeCode) => {
      const error = new Error(message)
      error.edgeCode = edgeCode
      finish(error)
    }

    const armTimeout = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        fail(`Edge TTS: ${timeoutMs} ms 内没有收到完整音频（turn.end），请求已中止`, 'timeout')
      }, timeoutMs)
    }

    armTimeout()

    try {
      socket = new WebSocket(url, { headers: { ...WS_HEADERS, Cookie: extraCookieHeader() } })
    } catch (error) {
      fail(`Edge TTS: 无法创建 WebSocket（${error?.message ?? error}）`, 'handshake')
      return
    }
    socket.binaryType = 'arraybuffer'

    socket.addEventListener('open', () => {
      opened = true
      armTimeout()
      try {
        socket.send(speechConfigFrame(job.wordBoundary, job.outputFormat))
        socket.send(ssmlFrame(requestId, job.ssml))
      } catch (error) {
        fail(`Edge TTS: 发送 SSML 失败（${error?.message ?? error}）`, 'closed')
      }
    })

    socket.addEventListener('message', (event) => {
      if (settled) return
      const data = event.data
      if (typeof data === 'string') {
        const frame = parseTextFrame(data)
        if (frame === null) return
        const path = frame.headers.path ?? ''
        if (path === 'turn.end') {
          if (audioChunks.length === 0) {
            fail('Edge TTS: 服务返回了 turn.end，但没有任何音频帧', 'empty')
            return
          }
          const encoded = Buffer.concat(audioChunks)
          if (encoded.length < 64) {
            fail(`Edge TTS: 音频数据太短（${encoded.length} 字节），不像有效语音`, 'empty')
            return
          }
          finish(null, {
            bytes: encoded,
            mimeType: [...contentTypes][0] ?? 'application/octet-stream',
            format: job.outputFormat,
            marks,
            url
          })
          return
        }
        if (path === 'audio.metadata') {
          armTimeout()
          for (const item of parseMetadataFrame(frame.body)) marks.push(item)
          return
        }
        // `response` and `turn.start` carry no data; unknown paths are ignored
        // so a future server addition cannot break synthesis.
        return
      }

      const buffer = Buffer.from(data)
      const frame = splitAudioFrame(buffer)
      if (frame === null) return
      armTimeout()
      const contentType = frame.headers['content-type']
      if (typeof contentType === 'string' && contentType.length > 0) contentTypes.add(contentType)
      if (frame.payload.length > 0) audioChunks.push(Buffer.from(frame.payload))
    })

    socket.addEventListener('error', () => {
      // Node exposes no detail here; report the phase, not a guessed cause.
      if (opened) {
        fail('Edge TTS: WebSocket 连接在合成过程中中断', 'closed')
      } else {
        fail(
          'Edge TTS: WebSocket 握手失败（服务端未完成升级；v1 令牌、过期令牌或出口限流都会这样）',
          'handshake'
        )
      }
    })

    socket.addEventListener('close', (event) => {
      if (settled) return
      const reason = typeof event.reason === 'string' && event.reason.length > 0 ? `：${event.reason}` : ''
      if (opened) {
        fail(`Edge TTS: 连接在 turn.end 之前关闭（close code ${event.code}${reason}）`, 'closed')
      } else {
        fail(`Edge TTS: 握手被关闭（close code ${event.code}${reason}）`, 'handshake')
      }
    })
  })
}

/**
 * Synthesize with a one-shot clock-skew retry.
 *
 * A 403 in this protocol is usually a stale token or a skewed clock. When the
 * handshake fails, compare our clock with the server's `Date` header and retry
 * once if the difference is large enough to move the 5-minute token window;
 * otherwise fail with the HTTP status the probe observed.
 */
async function synthesizeWithRetry (job, config) {
  let handshakeError
  try {
    return await synthesizeOnce(job, config, Number(config.clockSkewSeconds ?? 0))
  } catch (error) {
    if (error?.edgeCode !== 'handshake') throw error
    handshakeError = error
  }

  const probeTimeout = Math.min(Number(config.timeoutMs ?? EDGE_DEFAULTS.timeoutMs), 5000)
  let clockSkew = null
  try {
    clockSkew = await readServerClockSkew(config, probeTimeout)
  } catch { /* diagnostics only; fall through to the original error */ }

  if (clockSkew !== null && Math.abs(clockSkew) >= CLOCK_SKEW_RETRY_THRESHOLD_SECONDS) {
    return synthesizeOnce(job, config, clockSkew)
  }

  const status = await probeHandshakeStatus(buildWssUrl(config, Number(config.clockSkewSeconds ?? 0)), probeTimeout)
  const detail = status.status !== null
    ? `握手探测 HTTP ${status.status}`
    : `握手探测失败（${status.error ?? '未知原因'}）`
  const skewNote = clockSkew === null ? '' : `，本机与服务器时差 ${clockSkew.toFixed(1)} 秒`
  const error = new Error(`${handshakeError.message}；${detail}${skewNote}`)
  error.edgeCode = 'handshake'
  throw error
}

/** Turn raw boundary marks into the same shape `normalizeTimestamps` produces. */
function buildTimestamps (marks) {
  if (marks.length === 0) return null
  return {
    source: `audio.metadata WordBoundary (${marks.length} items)`,
    items: marks
      .slice()
      .sort((left, right) => left.start - right.start)
      .map((item) => ({ text: item.text, start: item.start, end: item.end }))
  }
}

/** Duration of the encoded stream from its byte count (CBR formats only). */
function estimateEncodedSeconds (format, bytes) {
  const name = String(format)
  const match = /(\d+)kbitrate/i.exec(name)
  const bitrate = match !== null ? Number(match[1]) * 1000 : (/(mpeg|mp3)/i.test(name) ? OUTPUT_BITRATE_BPS : NaN)
  if (Number.isFinite(bitrate) && bitrate > 0) return (bytes.length * 8) / bitrate
  // Only uncompressed audio has a byte-to-time relation we can trust; guessing
  // for Opus would silently misreport duration, so return null instead.
  const rawRate = rawPcmSampleRate(name)
  if (rawRate !== null) return bytes.length / (rawRate * BYTES_PER_FRAME)
  return null
}

/**
 * Build the error returned when the service's audio is in a format this
 * dependency-free package cannot decode. The donor bytes are attached so a
 * caller can still write them to disk or hand them to a decoder.
 */
function undecodableError (rendered, durationSeconds) {
  const error = new Error(
    `Edge TTS: 服务只返回压缩音频（${rendered.format}，${rendered.bytes.length} 字节，MIME ${rendered.mimeType}），` +
    '但没有可用的解码器：没找到 ffmpeg（查过 config.ffmpegPath、~/.dsh/tools/ffmpeg、PATH），也没有 config.decodeAudio。' +
    '三条出路：配置 ffmpegPath、传 config.decodeAudio，或改用 synthesizeEncoded() 拿到原始字节（audio_tts 会自动写成 .mp3）。'
  )
  error.edgeCode = 'undecodable'
  error.encoded = {
    bytes: rendered.bytes,
    mimeType: rendered.mimeType,
    format: rendered.format,
    durationSeconds,
    timestamps: buildTimestamps(rendered.marks)
  }
  return error
}

/**
 * Convert the service's encoded audio into Float32 samples.
 *
 * Order of preference, per the product decision: an injected decoder
 * (host-provided, wins over everything), then uncompressed formats the service
 * refuses today but may serve again, then the auto-detected ffmpeg binary.
 * Anything else becomes a precise `undecodable` error — never silent garbage.
 * Each return tags which decoder produced the samples so callers can report it.
 */
function decodeRendered (rendered, config) {
  const durationSeconds = estimateEncodedSeconds(rendered.format, rendered.bytes)

  if (typeof config.decodeAudio === 'function') {
    let decoded
    try {
      decoded = config.decodeAudio({
        bytes: rendered.bytes,
        mimeType: rendered.mimeType,
        format: rendered.format,
        timestamps: buildTimestamps(rendered.marks)
      })
    } catch (error) {
      // Keep the decoder's own message but say whose hook failed and what it
      // was handed, so a host-side integration bug is not mistaken for a
      // protocol failure.
      const wrapped = new Error(
        `Edge TTS: config.decodeAudio 解码失败（${error?.message ?? error}）；` +
        `输入 ${rendered.bytes.length} 字节 ${rendered.format}（${rendered.mimeType}）`
      )
      wrapped.edgeCode = 'decode'
      wrapped.cause = error
      throw wrapped
    }
    if (decoded === null || typeof decoded !== 'object' || !(decoded.samples instanceof Float32Array)) {
      throw new Error('Edge TTS: config.decodeAudio 必须返回 { samples: Float32Array, sampleRate: number }')
    }
    const sampleRate = Number(decoded.sampleRate)
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('Edge TTS: config.decodeAudio 返回的 sampleRate 不合法')
    }
    return { samples: decoded.samples, sampleRate, decoder: 'config.decodeAudio' }
  }

  const rawRate = rawPcmSampleRate(rendered.format)
  if (rawRate !== null) return { ...pcm16ToSamples(rendered.bytes, rawRate), decoder: 'raw-pcm' }

  if (/^riff-.*\.?(pcm|wav)$/i.test(rendered.format) || rendered.bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    const decoded = decodeWav(rendered.bytes)
    return { samples: decoded.channels[0], sampleRate: decoded.sampleRate, decoder: 'wav' }
  }

  const ffmpegPath = findFfmpeg({ ffmpegPath: config.ffmpegPath })
  if (ffmpegPath !== null) {
    return { ...decodeWithFfmpeg(rendered, ffmpegPath), decoder: `ffmpeg:${ffmpegPath}` }
  }

  throw undecodableError(rendered, durationSeconds)
}

/** Validate and normalize the arguments shared by `speak`/`synthesizeEncoded`. */
function prepareJob (params, config) {
  const text = String(params.text ?? '').trim()
  if (text.length === 0) throw new Error('Edge TTS: 文本为空')

  const voice = String(params.voice ?? config.voice ?? EDGE_DEFAULTS.voice)
  const speed = Number(params.speed ?? config.speed ?? EDGE_DEFAULTS.speed)
  if (!(speed >= 0.5 && speed <= 2)) throw new Error('Edge TTS: speed 必须在 0.5..2.0 之间')
  const pitch = Number(params.pitch ?? config.pitch ?? EDGE_DEFAULTS.pitch)
  if (!(pitch >= -12 && pitch <= 12)) throw new Error('Edge TTS: pitch 必须在 -12..12 半音之间')
  const volume = Number(params.volume ?? config.volume ?? EDGE_DEFAULTS.volume)
  if (!(volume >= 0 && volume <= 2)) throw new Error('Edge TTS: volume 必须在 0..2 之间')

  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength > MAX_REQUEST_BYTES) {
    throw new Error(
      `Edge TTS: 单次请求 ${byteLength} 字节，超过服务上限 ${MAX_REQUEST_BYTES}；` +
      '把文本拆成多段（audio_tts 已自动按 600 字切分）'
    )
  }

  const outputFormat = String(params.outputFormat ?? config.outputFormat ?? EDGE_DEFAULTS.outputFormat)
  return {
    text,
    voice,
    speed,
    pitch,
    volume,
    outputFormat,
    wordBoundary: Boolean(params.wordBoundary ?? config.wordBoundary ?? EDGE_DEFAULTS.wordBoundary),
    ssml: buildSsml(text, voice, speed, pitch, volume)
  }
}

/** The `effective` block every provider reports: what actually took effect. */
function effectiveBlock (job, timestamps, sampleRate, extra = {}) {
  return {
    provider: 'edge',
    host: 'speech.platform.bing.com',
    model: 'edge-readaloud',
    voice: job.voice,
    speed: job.speed,
    pitch: job.pitch,
    volume: job.volume,
    sampleRate,
    outputFormat: job.outputFormat,
    subtitle: timestamps === null ? 'unsupported' : 'word',
    ...extra
  }
}

/**
 * Synthesize one chunk and return the service's encoded audio plus timestamps,
 * without decoding anything.
 *
 * This is the dependency-free integration point: an `.mp3` file is exactly what
 * Edge itself hands to the browser, so a caller can write `bytes` to a file and
 * play it. `speak()` is the samples-returning wrapper on top.
 * @param {{ text: string, voice?: string, speed?: number, pitch?: number, volume?: number, outputFormat?: string }} params
 * @param {object} [config] - provider row; see `speak`.
 * @returns {Promise<{ bytes: Buffer, mimeType: string, format: string, durationSeconds: number|null, encodedDurationSeconds: number|null, timestamps: object|null, effective: object }>}
 *   `durationSeconds` is where the last spoken word ends (from metadata);
 *   `encodedDurationSeconds` is the container duration of the whole stream,
 *   which includes the service's leading/trailing silence.
 */
export async function synthesizeEncoded (params = {}, config = {}) {
  const job = prepareJob(params, config)
  const rendered = await synthesizeWithRetry(job, config)
  const timestamps = buildTimestamps(rendered.marks)
  const encodedDurationSeconds = estimateEncodedSeconds(rendered.format, rendered.bytes)
  const durationSeconds = timestamps !== null && timestamps.items.length > 0
    ? timestamps.items[timestamps.items.length - 1].end
    : encodedDurationSeconds

  return {
    bytes: rendered.bytes,
    mimeType: rendered.mimeType,
    format: rendered.format,
    durationSeconds,
    encodedDurationSeconds,
    timestamps,
    effective: effectiveBlock(job, timestamps, null, { encoded: true })
  }
}

/**
 * Speak one chunk with Edge Read Aloud.
 *
 * The service only serves compressed audio, so samples come from the first
 * decoder that exists: `config.decodeAudio` if supplied, otherwise the
 * auto-detected ffmpeg binary (see `findFfmpeg`). Without either, this throws
 * `edgeCode: 'undecodable'` after a successful synthesis (with the MP3 bytes
 * attached) rather than returning silence. `config.ffmpegPath` pins or
 * disables the binary.
 * @param {{ text: string, voice?: string, speed?: number, pitch?: number, volume?: number, sampleRate?: number, outputFormat?: string, wordBoundary?: boolean }} params
 *   `voice` is a voice id such as `zh-CN-XiaoxiaoNeural`; `speed` is a 0.5–2.0
 *   multiplier, `pitch` is semitones (−12..12), `volume` a 0–2 multiplier.
 *   `sampleRate` is reported by the service, not negotiated: the Edge engine
 *   fixes PCM at 24 kHz, so the returned rate is whatever the decoder produced.
 * @param {object} [config] - provider row: `voice`, `timeoutMs`, `wordBoundary`,
 *   `outputFormat`, `decodeAudio`, `ffmpegPath`, `gecVersion`,
 *   `chromiumVersion`, `endpoint`, plus `now`/`clockSkewSeconds` test hooks.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, channels: number, timestamps: object|null, effective: object }>}
 */
export async function speak (params = {}, config = {}) {
  const job = prepareJob(params, config)
  const rendered = await synthesizeWithRetry(job, config)
  const timestamps = buildTimestamps(rendered.marks)
  const decoded = decodeRendered(rendered, config)

  return {
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
    channels: 1,
    timestamps,
    effective: effectiveBlock(job, timestamps, decoded.sampleRate, { decoder: decoded.decoder })
  }
}

/**
 * List the live Edge voice catalogue.
 * @param {object} [config] - provider row; `timeoutMs` and `voiceListUrl` are
 *   recognised.
 * @throws when the endpoint refuses or returns an unknown shape.
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function listVoices (config = {}) {
  const timeoutMs = Number(config.timeoutMs ?? EDGE_DEFAULTS.timeoutMs)
  const url = String(config.voiceListUrl ?? `${VOICE_LIST_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`)
  let response
  try {
    response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(Math.max(timeoutMs, 5000))
    })
  } catch (error) {
    // `fetch failed` on its own says nothing actionable; name the host and the
    // underlying code (ENOTFOUND, ECONNREFUSED, …) instead.
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    let host = url
    try { host = new URL(url).host } catch { /* keep the raw URL */ }
    throw new Error(`Edge 音色列表请求失败（${host}）：${cause}`)
  }
  if (!response.ok) throw new Error(`Edge 音色列表 HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload)) throw new Error('Edge 音色列表不是数组，接口形状可能已变化')

  // Map the service's field names onto the shape the shared parser accepts, so
  // there is exactly one voice-list parser in this plugin.
  const items = normalizeVoiceList({
    voices: payload
      .filter((entry) => typeof entry?.ShortName === 'string' && entry.ShortName.length > 0)
      .map((entry) => ({
        voice_id: entry.ShortName,
        voice_name: typeof entry.FriendlyName === 'string' && entry.FriendlyName.length > 0
          ? entry.FriendlyName.slice(0, VOICE_NAME_LIMIT)
          : entry.ShortName
      }))
  })
  if (items.length === 0) throw new Error('Edge 音色列表为空或形状未知')
  return items
}

/**
 * Health probe for the settings page so it can grey the provider out honestly.
 *
 * It really synthesizes one short word and separates three facts: `protocolOk`
 * (handshake + audio received), `supported` (can this package return samples),
 * and `reason` (the exact blocker). With ffmpeg or `config.decodeAudio`
 * available `supported` is true and `decoder` names the path used; without
 * either it is `protocolOk: true, supported: false` because the service only
 * serves MP3/Opus.
 * @param {object} [config] - provider row; overrides are honoured, including
 *   `ffmpegPath`, `decodeAudio` and `probeTimeoutMs`.
 * @returns {Promise<{ supported: boolean, protocolOk: boolean, reason: string|null, latencyMs: number, decoder?: string|null, ffmpegPath?: string|null, format?: string, mimeType?: string, encodedBytes?: number, pcmBytes?: number, metadataItems?: number, durationSeconds?: number|null }>}
 */
export async function probeEdge (config = {}) {
  const started = Date.now()
  const probeConfig = {
    ...config,
    timeoutMs: Number(config.probeTimeoutMs ?? EDGE_DEFAULTS.probeTimeoutMs)
  }
  const ffmpegPath = findFfmpeg({ ffmpegPath: config.ffmpegPath })
  try {
    const rendered = await speak({ text: 'test', voice: config.voice ?? EDGE_DEFAULTS.voice }, probeConfig)
    return {
      supported: true,
      protocolOk: true,
      reason: null,
      latencyMs: Date.now() - started,
      decoder: rendered.effective.decoder ?? null,
      ffmpegPath,
      format: rendered.effective.outputFormat ?? null,
      pcmBytes: rendered.samples.length * BYTES_PER_FRAME,
      metadataItems: rendered.timestamps === null ? 0 : rendered.timestamps.items.length,
      durationSeconds: Number((rendered.samples.length / rendered.sampleRate).toFixed(3))
    }
  } catch (error) {
    if (error?.edgeCode === 'undecodable' && error.encoded !== undefined) {
      // Protocol is fine and the service delivered real audio; only decoding
      // is unavailable. Report exactly that so the page can explain the fix.
      return {
        supported: false,
        protocolOk: true,
        reason: error.message,
        latencyMs: Date.now() - started,
        decoder: null,
        ffmpegPath,
        format: error.encoded.format,
        mimeType: error.encoded.mimeType,
        encodedBytes: error.encoded.bytes.length,
        metadataItems: error.encoded.timestamps === null ? 0 : error.encoded.timestamps.items.length,
        durationSeconds: error.encoded.durationSeconds === null ? null : Number(error.encoded.durationSeconds.toFixed(3))
      }
    }
    // A failure after the audio arrived (a broken decoder hook, for example)
    // still proves the protocol works, so only network/format codes count as
    // protocol failures.
    const networkCodes = ['handshake', 'closed', 'timeout', 'empty']
    return {
      supported: false,
      protocolOk: !networkCodes.includes(error?.edgeCode),
      reason: error?.message ?? String(error),
      latencyMs: Date.now() - started,
      decoder: null,
      ffmpegPath,
      format: null,
      mimeType: null,
      encodedBytes: null,
      metadataItems: 0,
      durationSeconds: null
    }
  }
}

/**
 * The provider object the registry/`speak` dispatcher can keep beside MiniMax
 * and the OpenAI-compatible one. `speak` takes `(params, config)` and
 * `listVoices` takes `(config)`; no key is required, so `requiresKey` is false.
 * `requiresDecoder` is true because the service only serves compressed audio:
 * ffmpeg (auto-detected) or an injected decoder supplies the samples.
 */
export const edgeProvider = {
  id: 'edge',
  label: 'Microsoft Edge 朗读（免费，无需 API Key）',
  requiresKey: false,
  requiresDecoder: true,
  defaultVoice: EDGE_DEFAULTS.voice,
  catalog: EDGE_VOICE_CATALOG,
  speak,
  synthesizeEncoded,
  listVoices,
  probe: probeEdge,
  findFfmpeg
}

export { normalizeVoiceList }
