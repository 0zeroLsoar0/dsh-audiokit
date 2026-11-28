/**
 * `audio_generate`: one prompt in, one wav file out, through a service the user
 * configured.
 *
 * The tool surface is intentionally tiny — five arguments, one line of prose —
 * because the capability is optional and should not tax the context of every
 * session that never uses it. All the protocol detail (two request shapes, the
 * content-type and size guards, the failure codes) lives in
 * `providers-generate.js`; this file only validates arguments, resolves the
 * session directory, writes the file and reports measurements.
 *
 * No configuration means no tool call: `generateAudio` refuses before opening a
 * socket, so an unconfigured plugin never leaves the machine.
 */

import { relative } from 'node:path'
import { measure, readTrack } from './audio.js'
import {
  GENERATE_PROVIDERS,
  classifyGenerateFailure,
  generateAudio,
  resolveGenerateConfig,
  saveGeneratedAudio
} from './providers-generate.js'

const MAX_PROMPT = 1000
const MIN_DURATION = 1
const MAX_DURATION = 60
const DEFAULT_DURATION = 5

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

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function readDuration (value) {
  if (value === undefined || value === null) return DEFAULT_DURATION
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new Error(
      `audio_generate: duration must be a number between ${MIN_DURATION} and ${MAX_DURATION} seconds, got ${JSON.stringify(value)}`
    )
  }
  return duration
}

function readOptionalString (name, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`audio_generate: ${name} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Re-throw a provider failure with its code in the message.
 *
 * The provider already carries `reasonCode`; putting it in the message as well
 * means the model (and a log) can see the category without inspecting the error
 * object, while the code stays available for callers that do inspect it.
 */
function toolError (error) {
  const info = classifyGenerateFailure(error)
  if (info.reasonCode === undefined) return error
  const wrapped = new Error(`audio_generate 失败 (${info.reasonCode})：${info.detail}`)
  wrapped.reasonCode = info.reasonCode
  if (info.status !== undefined) wrapped.status = info.status
  if (info.envName !== undefined) wrapped.envName = info.envName
  return wrapped
}

/** Register `audio_generate` on `ctx.tools`. */
export function registerGenerateTools (ctx, config = {}) {
  ctx.tools.register({
    name: 'audio_generate',
    description: 'Generate a .wav with the configured external audio-generation model (Stable Audio, AudioGen or an OpenAI-compatible endpoint). Remote and non-deterministic; fails when the generate config is unset.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate (≤1000 chars).' },
        duration: { type: 'number', description: 'Length in seconds, 1..60; default 5.' },
        model: { type: 'string', description: 'Override the configured model id.' },
        out: { type: 'string', description: 'Output .wav path; defaults to assets/audio/generate-<content-hash>.wav.' },
        provider: { type: 'string', enum: [...GENERATE_PROVIDERS], description: 'Override the configured request shape.' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Generate ${String(args?.prompt ?? '').slice(0, 60) || 'audio'}`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (prompt.length === 0) {
        throw new Error('audio_generate: prompt is required (a non-empty string)')
      }
      if (prompt.length > MAX_PROMPT) {
        throw new Error(`audio_generate: prompt is ${prompt.length} chars, over the ${MAX_PROMPT} limit`)
      }
      const duration = readDuration(input.duration)
      const model = readOptionalString('model', input.model)
      const provider = readOptionalString('provider', input.provider)?.toLowerCase()
      if (provider !== undefined && !GENERATE_PROVIDERS.includes(provider)) {
        throw new Error(`audio_generate: provider must be one of ${GENERATE_PROVIDERS.join(' / ')}`)
      }

      // Argument checks run before the config is consulted, so a bad prompt or
      // duration is reported as such instead of as "not configured".
      const resolved = resolveGenerateConfig(config)
      if (provider !== undefined) {
        resolved.provider = provider
        resolved.unsupported = false
      }
      if (model !== undefined) resolved.model = model

      const cwd = sessionCwd(ctx, exec)
      let generated
      try {
        generated = await generateAudio(resolved, { prompt, duration })
      } catch (error) {
        throw toolError(error)
      }

      const saved = await saveGeneratedAudio(cwd, generated.bytes, input.out)
      const track = await readTrack(saved.target)
      const metrics = { ...measure(track.samples, track.sampleRate), sampleRate: track.sampleRate }
      const effective = generated.effective
      const modelLabel = effective.model ?? 'default model'
      const text = [
        `Generated ${displayPath(cwd, saved.target)} (${fmt(metrics.durationSeconds, 2)}s, ${track.sampleRate} Hz, ${Math.max(1, Math.round(saved.bytes / 1024))} KB)`,
        `${effective.provider} · ${modelLabel} · peak ${metrics.peakDbfs} dBFS · rms ${metrics.rmsDbfs} dBFS`,
        `remote model: deterministic=false (the same prompt may return different audio; file name is a content hash)`
      ].join('\n')

      return {
        path: saved.target,
        relativePath: displayPath(cwd, saved.target),
        bytes: saved.bytes,
        durationSeconds: metrics.durationSeconds,
        sampleRate: track.sampleRate,
        channels: track.channels,
        prompt,
        metrics,
        effective,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
