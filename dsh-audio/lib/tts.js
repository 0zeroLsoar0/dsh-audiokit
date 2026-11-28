/**
 * `audio_tts` + `audio_voices`: text to speech, with long text split into
 * speakable chunks and the chunks' timestamps stitched back into one timeline.
 *
 * The return value carries three things on purpose: the audio, the timestamps
 * (when the provider gives them) and the parameters that actually took effect.
 * Without the last two a caller can only play the file, not sync anything to it.
 *
 * Two output formats exist because providers differ in what they can deliver:
 * every provider that returns samples gets the normal `.wav` path, while the
 * free Edge engine — whose service only serves MP3 and whose decoder may be
 * absent — falls back to writing the service's MP3 frames to an `.mp3` file.
 * The fallback never claims a `.wav` that does not exist.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { EDGE_VOICE_CATALOG, VOICE_CATALOG, listVoices, speak } from './providers.js'

const MAX_TEXT = 8000
const CHUNK = 600
const GAP_SECONDS = 0.15
/** A silence between chunks longer than this is a timeline edit, not a gap. */
const MAX_GAP_SECONDS = 10

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

/**
 * Split text into chunks no longer than `size`, preferring sentence ends so a
 * chunk never cuts a word in half.
 */
export function splitScript (text, size = CHUNK) {
  const trimmed = text.trim()
  if (trimmed.length <= size) return [trimmed]
  const pieces = []
  let rest = trimmed
  while (rest.length > size) {
    const window = rest.slice(0, size)
    const sentence = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('!'), window.lastIndexOf('?'), window.lastIndexOf('. '),
      window.lastIndexOf('\n')
    )
    const soft = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf(' '))
    const cut = sentence > size * 0.4 ? sentence + 1 : soft > size * 0.4 ? soft + 1 : size
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim().length > 0) pieces.push(rest.trim())
  return pieces.filter((piece) => piece.length > 0)
}

function joinWithGaps (parts, sampleRate, gapSeconds) {
  const gap = new Float32Array(Math.round(gapSeconds * sampleRate))
  const total = parts.reduce((sum, part) => sum + part.length, 0) + gap.length * Math.max(0, parts.length - 1)
  const out = new Float32Array(total)
  const offsets = []
  let offset = 0
  parts.forEach((part, index) => {
    offsets.push(offset / sampleRate)
    out.set(part, offset)
    offset += part.length
    if (index < parts.length - 1) offset += gap.length
  })
  return { samples: out, offsets }
}

/** Format seconds as an SRT timestamp. */
function srtTime (seconds) {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.round((total - Math.floor(total)) * 1000)
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`
}

/** Render timestamp items as an SRT subtitle file. */
export function toSrt (items) {
  return items.map((item, index) => {
    const end = item.end > item.start ? item.end : item.start + 0.8
    return `${index + 1}\n${srtTime(item.start)} --> ${srtTime(end)}\n${item.text}\n`
  }).join('\n')
}

/**
 * Frame geometry of the MP3 the Edge service returns, from its format name.
 *
 * Every format Edge accepts is MPEG-2 Layer III at 24 kHz (576 samples/frame),
 * i.e. `frameBytes = 72 * bitrate / sampleRate`. The service writes the padding
 * bit as 0, so the frame size is exact and the total size is a multiple of it —
 * which is what lets chunk concatenation stay at frame level.
 * @returns {{ frameBytes: number, frames: number, aligned: boolean }|null}
 */
function mp3FrameInfo (format, bytes) {
  const khz = /^audio-(\d+)khz/i.exec(String(format))?.[1]
  const kbps = /(\d+)kbitrate/i.exec(String(format))?.[1]
  if (khz === undefined || kbps === undefined) return null
  const sampleRate = Number(khz) * 1000
  const bitrate = Number(kbps) * 1000
  if (!(sampleRate > 0) || !(bitrate > 0)) return null
  const frameBytes = Math.floor((sampleRate <= 24000 ? 72 : 144) * bitrate / sampleRate)
  if (frameBytes <= 0) return null
  return { frameBytes, frames: bytes.length / frameBytes, aligned: bytes.length % frameBytes === 0 }
}

/** Keep the caller's extension only when it is already `.mp3`. */
function withMp3Extension (target) {
  if (/\.mp3$/i.test(target)) return target
  if (/\.wav$/i.test(target)) return target.replace(/\.wav$/i, '.mp3')
  return `${target}.mp3`
}

/**
 * Join per-chunk encoded clips into one playable stream.
 *
 * Concatenation is at MP3-frame level (no decode, no transcode): each service
 * response is a whole frame-aligned MP3 stream, so plain byte concatenation is
 * a valid MP3. Chunk offsets for the subtitle timeline come from each chunk's
 * container duration (which includes the service's trailing silence), because
 * no silence is inserted between chunks — the file must not grow frames that
 * are not encoded.
 * @param {{ bytes: Buffer, durationSeconds: number|null, timestamps: object|null }[]} clips
 * @returns {{ bytes: Buffer, durationSeconds: number, timestamps: object|null }}
 */
function joinEncodedClips (clips) {
  const parts = []
  const items = []
  let offset = 0
  let complete = true
  let source = null
  for (const clip of clips) {
    parts.push(clip.bytes)
    if (clip.timestamps === null || clip.timestamps === undefined) {
      complete = false
    } else {
      source = source ?? clip.timestamps.source
      for (const item of clip.timestamps.items) {
        items.push({
          text: item.text,
          start: Number((item.start + offset).toFixed(3)),
          end: Number((item.end + offset).toFixed(3))
        })
      }
    }
    offset += Number(clip.durationSeconds ?? 0)
  }
  return {
    bytes: Buffer.concat(parts),
    durationSeconds: offset,
    timestamps: items.length > 0 ? { unit: 'seconds', complete, source, items } : null
  }
}

/**
 * Write the encoded (MP3) output when no decoder could produce samples.
 *
 * This is the honest second delivery path: the browser can play the MP3 the
 * service produced, and the subtitle timeline still comes from the provider's
 * word boundaries. `format: 'mp3'` in the result is the contract callers check;
 * a `.wav` is never written or claimed here.
 * @param {{ cwd: string, args: object, clips: object[], chunks: number, ttsConfig: object }} input
 * @returns {Promise<object>} the same bounded summary shape as the WAV path.
 */
async function writeEncodedOutput ({ cwd, args, clips, chunks, ttsConfig }) {
  const joined = joinEncodedClips(clips)
  const format = clips[0].format
  const frame = mp3FrameInfo(format, joined.bytes)
  const hash = hashSpec({
    text: String(args.text ?? ''),
    voice: args.voice ?? ttsConfig.voice,
    model: args.model ?? ttsConfig.model,
    speed: Number(args.speed ?? 1),
    pitch: Number(args.pitch ?? 0),
    subtitleType: args.subtitleType ?? ttsConfig.subtitleType,
    sampleRate: args.sampleRate ?? ttsConfig.sampleRate,
    provider: ttsConfig.provider ?? 'edge',
    format: 'mp3'
  })
  const requested = resolvePath(cwd, args.out)
  const target = requested === undefined
    ? defaultOutputPath(cwd, 'voice', hash).replace(/\.wav$/i, '.mp3')
    : withMp3Extension(requested)
  await writeFileAtomic(target, joined.bytes)
  const info = await stat(target)

  let srtPath = null
  if (args.srt === true && joined.timestamps !== null) {
    srtPath = target.replace(/\.(wav|mp3)$/i, '') + '.srt'
    await writeFileAtomic(srtPath, Buffer.from(toSrt(joined.timestamps.items), 'utf8'))
  }

  const metrics = {
    sampleRate: null,
    durationSeconds: Number(joined.durationSeconds.toFixed(3)),
    peakDbfs: null,
    rmsDbfs: null,
    format: 'mp3',
    mp3FrameBytes: frame === null ? null : frame.frameBytes,
    mp3Frames: frame === null ? null : frame.frames,
    mp3FrameAligned: frame === null ? null : frame.aligned
  }
  const effective = {
    provider: 'edge',
    model: 'edge-readaloud',
    voice: args.voice ?? ttsConfig.voice ?? null,
    speed: Number(args.speed ?? 1),
    pitch: Number(args.pitch ?? 0),
    sampleRate: null,
    format: 'mp3',
    outputFormat: format,
    chunks,
    gapSeconds: 0,
    decoder: null
  }
  const stampNote = joined.timestamps === null
    ? '时间戳：无（服务没返回；字幕只能按容器时长估算）'
    : `时间戳：${joined.timestamps.items.length} 条，${joined.timestamps.complete ? '完整' : '部分 chunk 缺失'}，来源 ${joined.timestamps.source}`
  const frameNote = frame === null
    ? ''
    : ` · MP3 ${frame.aligned ? '帧对齐' : '未对齐'}（${frame.frameBytes} B/帧 × ${frame.frames.toFixed(0)}）`
  const text2 = [
    `Wrote ${displayPath(cwd, target)} (${metrics.durationSeconds.toFixed(2)}s, MP3, ${Math.round(info.size / 1024)} KB)${frameNote}`,
    `${chunks} chunk(s) · format mp3（服务只返回压缩音频，未解码；浏览器可直接播放）`,
    stampNote,
    srtPath === null
      ? (args.srt === true ? 'SRT：未生成（没有时间戳）' : 'SRT：未要求')
      : `SRT：${displayPath(cwd, srtPath)}`,
    `生效参数：edge · mp3 · ${effective.voice} · speed=${effective.speed} · pitch=${effective.pitch}`
  ].join('\n')

  return {
    path: target,
    relativePath: displayPath(cwd, target),
    bytes: info.size,
    chunks,
    format: 'mp3',
    durationSeconds: metrics.durationSeconds,
    metrics,
    timestamps: joined.timestamps,
    srtPath,
    effective,
    text: text2
  }
}

/** Register the `audio_tts` tool. */
export function registerTtsTool (ctx, config = {}) {
  const ttsConfig = config.tts ?? {}

  ctx.tools.register({
    name: 'audio_tts',
    description: 'Render narration or dialogue to a file through MiniMax (default), any OpenAI-compatible endpoint, or the free Edge engine. Returns the file plus timestamps when the provider supplies them, so subtitles and lip-sync can be driven from one call.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say (鈮?000 chars); inline pauses like <#1.5#> are supported by MiniMax.' },
        voice: { type: 'string', description: 'Voice id; lists are in the animation-sound skill, or call audio_voices.' },
        speed: { type: 'number', description: 'Speaking rate, 0.5..2.0. Defaults to 1.' },
        pitch: { type: 'number', description: 'Pitch shift in semitones, -12..12. Defaults to 0.' },
        subtitle: { type: 'boolean', description: 'Ask the provider for timestamps. Defaults to true; the result says whether any came back.' },
        subtitleType: { type: 'string', enum: ['sentence', 'word'], description: 'Timestamp granularity, sentence or word; word is not always returned.' },
        model: { type: 'string', description: 'Provider model id. Defaults to the provider setting (MiniMax speech-2.8-hd).' },
        gapSeconds: { type: 'number', description: 'Silence between chunks of a long script, 0..10 s; default 0.15.' },
        sampleRate: { type: 'integer', description: 'Output rate for providers that accept it; the Edge engine fixes PCM at 24000.' },
        srt: { type: 'boolean', description: 'Also write an .srt next to the audio when timestamps came back.' },
        out: { type: 'string', description: 'Output path; default assets/audio/voice-<hash>.wav (.mp3 for Edge).' }
      },
      required: ['text'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Text to speech', kind: 'other', rawInput: { text: String(args.text ?? '').slice(0, 80) } }),
    async execute (args, exec) {
      const text = String(args.text ?? '').trim()
      if (text.length === 0) throw new Error('audio_tts needs non-empty text')
      if (text.length > MAX_TEXT) throw new Error(`audio_tts: 文本 ${text.length} 字，超过上限 ${MAX_TEXT}；拆成多次调用。`)
      if (ttsConfig.provider === 'none') throw new Error('audio_tts 已关闭（config.tts.provider = none）')
      const speed = Number(args.speed ?? 1)
      if (!(speed >= 0.5 && speed <= 2)) throw new Error('audio_tts: speed 必须在 0.5..2.0 之间')
      const pitch = Number(args.pitch ?? 0)
      if (!(pitch >= -12 && pitch <= 12)) throw new Error('audio_tts: pitch 必须在 -12..12 半音之间')
      // Validate the inter-chunk gap before the provider is called: a bad value
      // used to crash the typed-array allocation only after every chunk had
      // already been paid for.
      const gapSeconds = Number(args.gapSeconds ?? GAP_SECONDS)
      if (!Number.isFinite(gapSeconds) || gapSeconds < 0 || gapSeconds > MAX_GAP_SECONDS) {
        throw new Error(`audio_tts: gapSeconds must be a finite number between 0 and ${MAX_GAP_SECONDS} seconds`)
      }

      const cwd = sessionCwd(ctx, exec)
      const chunks = splitScript(text)
      const rendered = []
      const encodedClips = []
      for (const chunk of chunks) {
        try {
          rendered.push(await speak(ttsConfig, chunk, {
            voice: args.voice,
            model: args.model,
            speed,
            pitch,
            subtitle: args.subtitle !== false,
            subtitleType: args.subtitleType,
            sampleRate: args.sampleRate
          }))
        } catch (error) {
          // The Edge service only serves MP3. When no decoder is available the
          // provider hands back the encoded bytes instead of samples, and this
          // tool writes a playable .mp3 rather than failing the request.
          if (error?.edgeCode === 'undecodable' && error.encoded !== undefined) {
            encodedClips.push(error.encoded)
            continue
          }
          throw error
        }
      }

      if (encodedClips.length > 0) {
        if (rendered.length > 0) {
          throw new Error('audio_tts: 各 chunk 解码状态不一致（部分返回 samples、部分只有编码音频），无法拼接；请给所有 chunk 提供解码器')
        }
        return await writeEncodedOutput({ cwd, args, clips: encodedClips, chunks: chunks.length, ttsConfig })
      }

      const sampleRate = rendered[0].sampleRate
      const joined = rendered.length === 1
        ? { samples: rendered[0].samples, offsets: [0] }
        : joinWithGaps(rendered.map((part) => part.samples), sampleRate, gapSeconds)

      // Stitch per-chunk timestamps onto the joined timeline.
      const items = []
      let complete = true
      let source = null
      rendered.forEach((part, index) => {
        if (part.timestamps === null) { complete = false; return }
        source = source ?? part.timestamps.source
        const base = joined.offsets[index] ?? 0
        for (const item of part.timestamps.items) {
          items.push({
            text: item.text,
            start: Number((item.start + base).toFixed(3)),
            end: Number((item.end + base).toFixed(3))
          })
        }
      })
      const timestamps = items.length > 0 ? { unit: 'seconds', complete, source, items } : null

      const samples = joined.samples
      finalize(samples, sampleRate, -1)
      const effective = {
        ...(rendered[0].effective ?? {}),
        chunks: chunks.length,
        gapSeconds: rendered.length > 1 ? gapSeconds : 0
      }
      const hash = hashSpec({
        text,
        voice: args.voice ?? ttsConfig.voice,
        model: args.model ?? ttsConfig.model,
        speed,
        pitch,
        subtitleType: args.subtitleType ?? ttsConfig.subtitleType,
        sampleRate: args.sampleRate ?? ttsConfig.sampleRate,
        provider: ttsConfig.provider ?? 'minimax'
      })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'voice', hash)
      const bytes = toWavBytes(samples, sampleRate)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)
      const metrics = { ...measure(samples, sampleRate), sampleRate }

      let srtPath = null
      if (args.srt === true) {
        if (timestamps === null) {
          srtPath = null
        } else {
          srtPath = target.replace(/\.wav$/i, '') + '.srt'
          await writeFileAtomic(srtPath, Buffer.from(toSrt(timestamps.items), 'utf8'))
        }
      }

      const stampNote = timestamps === null
        ? '时间戳：无（该端点没返回；字幕只能按时长估算）'
        : `时间戳：${timestamps.items.length} 条，${timestamps.complete ? '完整' : '部分 chunk 缺失'}，来源 ${timestamps.source}`
      const text2 = [
        `Wrote ${displayPath(cwd, target)} (${metrics.durationSeconds.toFixed(2)}s, ${sampleRate} Hz, ${Math.round(info.size / 1024)} KB)`,
        `${chunks.length} chunk(s) · peak ${metrics.peakDbfs} dBFS · rms ${metrics.rmsDbfs} dBFS`,
        stampNote,
        srtPath === null
          ? (args.srt === true ? 'SRT：未生成（没有时间戳）' : 'SRT：未要求')
          : `SRT：${displayPath(cwd, srtPath)}`,
        `生效参数：${effective.provider} · ${effective.model} · ${effective.voice} · speed=${effective.speed ?? 1} · pitch=${effective.pitch ?? 0}`
      ].join('\n')

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        chunks: chunks.length,
        format: 'wav',
        durationSeconds: metrics.durationSeconds,
        metrics,
        timestamps,
        srtPath,
        effective,
        text: text2
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

/** Register the `audio_voices` tool: live list when possible, shortlist otherwise. */
export function registerVoicesTool (ctx, config = {}) {
  const ttsConfig = config.tts ?? {}
  const provider = String(ttsConfig.provider ?? 'minimax').toLowerCase()
  const edge = provider === 'edge'
  const catalog = edge ? EDGE_VOICE_CATALOG : VOICE_CATALOG
  const liveLabel = edge ? 'Edge 实时音色（来自微软公开列表）' : 'MiniMax 实时音色（来自当前账号）'
  const staticLabel = edge
    ? 'Edge 常用音色（静态短名单；联网后这里会换成实时列表）：'
    : 'MiniMax 常用音色（静态短名单，未联网校验；配置密钥后这里会换成账号的实时列表）：'

  ctx.tools.register({
    name: 'audio_voices',
    description: 'List the voice ids available for the configured TTS provider (the live MiniMax list or the free Edge catalogue). Reads only; produces no audio.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    presentCall: () => ({ card: 'generic', title: 'List TTS voices', kind: 'other', rawInput: {} }),
    async execute () {
      try {
        const items = await listVoices(ttsConfig)
        const lines = [`${liveLabel}（${items.length} 个）：`]
        for (const voice of items.slice(0, 80)) lines.push(`  ${voice.id.padEnd(38)} ${voice.name}`)
        if (items.length > 80) lines.push(`  … 共 ${items.length} 个`)
        return { source: 'live', provider, voices: items, text: lines.join('\n') }
      } catch {
        // fall through to the static shortlist
      }
      const lines = [staticLabel]
      for (const voice of catalog) lines.push(`  ${voice.id.padEnd(38)} ${voice.note}`)
      return { source: 'static', provider, voices: catalog, text: lines.join('\n') }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
