/**
 * `audio_tts` + `audio_voices`: text to speech, with long text split into
 * speakable chunks and the chunks' timestamps stitched back into one timeline.
 *
 * The return value carries three things on purpose: the audio, the timestamps
 * (when the provider gives them) and the parameters that actually took effect.
 * Without the last two a caller can only play the file, not sync anything to it.
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
import { EMOTIONS, VOICE_CATALOG, speak } from './providers.js'

const MAX_TEXT = 8000
const CHUNK = 600
const GAP_SECONDS = 0.15

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

/** Register the `audio_tts` tool. */
export function registerTtsTool (ctx, config = {}) {
  const ttsConfig = config.tts ?? {}

  ctx.tools.register({
    name: 'audio_tts',
    description: 'Render narration or dialogue to a .wav file with MiniMax T2A (default) or any OpenAI-compatible speech endpoint. Returns the file plus sentence/word timestamps when the provider supplies them, and the parameters that actually took effect — so subtitles, lip-sync or typewriter effects can be driven from the same call. Text accepts inline pauses like <#1.5#> (0.01–99.99 s).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say (≤8000 chars; longer scripts are split at sentence boundaries). Supports MiniMax inline pauses: <#1.5#> for a 1.5 s pause.' },
        voice: { type: 'string', description: `Voice id. Shortlist: ${VOICE_CATALOG.map((voice) => voice.id).join(', ')}. Any other id from the MiniMax console also works; call audio_voices to see the shortlist with descriptions.` },
        emotion: { type: 'string', enum: EMOTIONS, description: 'Emotion. "auto" lets the model decide from the text, which is usually better than forcing one. Ignored by non-MiniMax providers.' },
        speed: { type: 'number', description: 'Speaking rate, 0.5..2.0. Defaults to 1.' },
        pitch: { type: 'number', description: 'Pitch shift in semitones, -12..12. Defaults to 0.' },
        subtitle: { type: 'boolean', description: 'Ask the provider for timestamps. Defaults to true; the result says whether any came back.' },
        subtitleType: { type: 'string', enum: ['sentence', 'word'], description: 'Timestamp granularity to request. Word level is finer but not every model or endpoint returns it — check the result before relying on it.' },
        model: { type: 'string', description: 'Provider model. Defaults to speech-2.8-hd (best quality, auto emotion). Use speech-2.6-hd when you need manual emotion control with lower latency.' },
        gapSeconds: { type: 'number', description: 'Silence inserted between chunks of a long script; defaults to 0.15.' },
        sampleRate: { type: 'integer', description: 'Output rate; defaults to the provider setting (MiniMax 32000).' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/voice-<hash>.wav.' }
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

      const cwd = sessionCwd(ctx, exec)
      const chunks = splitScript(text)
      const rendered = []
      for (const chunk of chunks) {
        rendered.push(await speak(ttsConfig, chunk, {
          voice: args.voice,
          model: args.model,
          emotion: args.emotion,
          speed,
          pitch,
          subtitle: args.subtitle !== false,
          subtitleType: args.subtitleType,
          sampleRate: args.sampleRate
        }))
      }

      const sampleRate = rendered[0].sampleRate
      const joined = rendered.length === 1
        ? { samples: rendered[0].samples, offsets: [0] }
        : joinWithGaps(rendered.map((part) => part.samples), sampleRate, Number(args.gapSeconds ?? GAP_SECONDS))

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
        gapSeconds: rendered.length > 1 ? Number(args.gapSeconds ?? GAP_SECONDS) : 0
      }
      const hash = hashSpec({
        text,
        voice: args.voice ?? ttsConfig.voice,
        model: args.model ?? ttsConfig.model,
        emotion: args.emotion ?? ttsConfig.emotion,
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

      const stampNote = timestamps === null
        ? '时间戳：无（该端点没返回；字幕只能按时长估算）'
        : `时间戳：${timestamps.items.length} 条，${timestamps.complete ? '完整' : '部分 chunk 缺失'}，来源 ${timestamps.source}`
      const text2 = [
        `Wrote ${displayPath(cwd, target)} (${metrics.durationSeconds.toFixed(2)}s, ${sampleRate} Hz, ${Math.round(info.size / 1024)} KB)`,
        `${chunks.length} chunk(s) · peak ${metrics.peakDbfs} dBFS · rms ${metrics.rmsDbfs} dBFS`,
        stampNote,
        `生效参数：${effective.provider} · ${effective.model} · ${effective.voice} · emotion=${effective.emotion ?? '-'} · speed=${effective.speed ?? 1} · pitch=${effective.pitch ?? 0}`
      ].join('\n')

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        chunks: chunks.length,
        durationSeconds: metrics.durationSeconds,
        metrics,
        timestamps,
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

/** Register the `audio_voices` tool: a shortlist, not a whitelist. */
export function registerVoicesTool (ctx) {
  ctx.tools.register({
    name: 'audio_voices',
    description: 'List the curated MiniMax voice ids this plugin documents, with a one-line note each. It is a shortlist to keep the model from inventing ids, not a whitelist — any voice id from the provider console can still be passed to audio_tts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    async execute () {
      const lines = ['MiniMax 常用音色（只是短名单，控制台里的其他 id 也能直接用）：']
      for (const voice of VOICE_CATALOG) lines.push(`  ${voice.id.padEnd(38)} ${voice.note}`)
      return { voices: VOICE_CATALOG, text: lines.join('\n') }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
