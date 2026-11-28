/**
 * `audio_handoff`: write the contract for work this plugin should not do.
 *
 * Detection says who else is installed (see `lib/interop.js`); this tool turns
 * that into a file the user or another agent can act on: the target plugin, the
 * capabilities it owns, one request per track, and a pasteable natural-language
 * instruction. It deliberately does **not** call the peer — DSH's tool scope
 * does not allow one plugin to drive another's tools, and a handoff that
 * silently executed something in the other plugin would be a surprise, not a
 * contract.
 *
 * The result is deterministic: no timestamp in the brief, no absolute path, and
 * the default output name is a hash of the brief itself, so running the same
 * handoff twice rewrites the same bytes instead of growing a directory of
 * near-identical files.
 *
 * No network is touched. A machine with no peer still gets a brief — the same
 * division of labour, addressed to `null` — because knowing what to hand over
 * is useful before the peer is installed.
 */

import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { resolvePath, writeFileAtomic } from './audio.js'
import { capabilityNames, detectEcosystem, handoffFor, pickHandoffTarget, summarizeEcosystem } from './interop.js'

/** Format id written into the brief; bump when a field changes meaning. */
const SCHEMA = 'dsh-audiokit/handoff@1'

/** Roles a track may name, in the order the description lists them. */
const ROLES = Object.freeze(['music', 'narration', 'sfx'])

const MAX_PROMPT = 2000
const MIN_DURATION = 1
const MAX_DURATION = 3600
const DEFAULT_DURATION = 30
const DEFAULT_DIRECTORY = ['assets', 'audio']

/**
 * Per-role request, the capability that owns it and how the result is accepted.
 *
 * `capability` is the key into `HANDOFF_NOTES`: it is what the target plugin has
 * to declare for this track to be genuinely theirs. `ask` is the concrete
 * deliverable, `acceptance` is the loop back into this plugin's tools (measure,
 * normalise, quality gate), which is the part no peer replaces.
 */
const ROLE_GUIDANCE = Object.freeze({
  music: Object.freeze({
    capability: 'instruments',
    ask: '用采样乐器/音色库把这段音乐做成 wav（或 midi），保留分轨',
    acceptance: '拿到 wav 后：audio_probe 量峰值与时长，audio_loudness 定到目标响度（视频 −14 LUFS、播客 −16 LUFS），audio_check 过质量闸'
  }),
  narration: Object.freeze({
    capability: 'ttsProviders',
    ask: '输出 48 kHz 单声道旁白 wav（不要把背景音乐混进去）',
    acceptance: '拿到旁白后：audio_loudness 定到 −16 LUFS，audio_probe 确认采样率与峰值，需要口型时用 audio_lipsync'
  }),
  sfx: Object.freeze({
    capability: 'sfxLibrary',
    ask: '从素材库挑一段音效，输出原始 wav（不要预压缩）',
    acceptance: '拿到音效后：audio_probe 量峰值，audio_convert 剪到画面长度，audio_bus 做 EQ/压缩后混进总轨'
  })
})

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

/** `30` rather than `30.0`; keeps the brief free of float noise. */
function formatNumber (value) {
  return String(Number(value.toFixed(3)))
}

function readDuration (value) {
  if (value === undefined || value === null) return DEFAULT_DURATION
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new Error(
      `audio_handoff: durationSeconds must be a number between ${MIN_DURATION} and ${MAX_DURATION}, got ${JSON.stringify(value)}`
    )
  }
  return duration
}

/**
 * Validate the optional track list.
 *
 * The schema already restricts `role` to three ids, but `execute` is a public
 * entry point (tests and direct callers bypass the host schema), so the check
 * lives here too — before any file is written, and naming the exact index.
 * @param {any} value - the raw `tracks` argument.
 * @returns {{ role: string, style: string|null }[]} normalised tracks.
 */
function readTracks (value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`audio_handoff: tracks must be an array of { role, style? }, got ${JSON.stringify(value)}`)
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`audio_handoff: tracks[${index}] must be an object with a role`)
    }
    const role = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : ''
    if (!ROLES.includes(role)) {
      throw new Error(`audio_handoff: tracks[${index}].role must be one of ${ROLES.join(' / ')}, got ${JSON.stringify(entry.role)}`)
    }
    let style = null
    if (entry.style !== undefined && entry.style !== null) {
      if (typeof entry.style !== 'string') {
        throw new Error(`audio_handoff: tracks[${index}].style must be a string, got ${JSON.stringify(entry.style)}`)
      }
      const trimmed = entry.style.trim()
      style = trimmed === '' ? null : trimmed
    }
    return { role, style }
  })
}

/** One row per requested track: what to ask for, whose it is, how it comes back. */
function buildTracks (requested, ecosystem) {
  return requested.map((track) => {
    const guidance = ROLE_GUIDANCE[track.role]
    const handoff = handoffFor(guidance.capability, { ecosystem })
    return {
      role: track.role,
      style: track.style,
      capability: guidance.capability,
      owner: handoff === null ? null : handoff.plugin,
      ask: guidance.ask,
      boundary: handoff === null ? '' : handoff.suggest,
      acceptance: guidance.acceptance
    }
  })
}

/** Deduplicate while keeping first-seen order (acceptance lines repeat by role). */
function unique (values) {
  return [...new Set(values)]
}

/**
 * The natural-language instruction a human or another agent can paste.
 *
 * Written from the receiving side: what to deliver per track, then the
 * acceptance loop back into this plugin, then the boundary that keeps the two
 * plugins from claiming the same work. With no peer detected the first line
 * says so instead of pretending there is a recipient.
 */
function buildInstruction ({ prompt, durationSeconds, tracks, target }) {
  const lines = []
  if (target === null) {
    lines.push('没有检测到可接手的同类音频插件；这份简报先当分工清单用，装好 dsh-any-audio 后重跑 audio_handoff 即可补上目标插件。')
  } else {
    const version = target.version === null ? '' : ` v${target.version}`
    lines.push(`请接手这段音频工作（目标插件 ${target.name}${version}）。`)
  }
  lines.push('')
  lines.push(`目标：${prompt}`)
  lines.push(`时长：约 ${formatNumber(durationSeconds)} 秒`)
  if (tracks.length === 0) {
    lines.push('交付轨道：未指定，按目标自行决定分层。')
  } else {
    lines.push('交付轨道：')
    for (const track of tracks) {
      const style = track.style === null ? '' : `（${track.style}）`
      lines.push(`- ${track.role}${style}：${track.ask}`)
    }
  }
  const acceptance = unique(tracks.map((track) => track.acceptance))
  if (acceptance.length > 0) {
    lines.push('')
    lines.push('验收：')
    for (const line of acceptance) lines.push(`- ${line}`)
  }
  lines.push('')
  lines.push('边界：本插件不调用你的工具、不联网，这份简报只是交接合同；你产出的 wav / midi 回到本插件复检（audio_probe / audio_loudness / audio_check，工程交换用 audio_daw）。不要复制对方的音源、声库或音效素材，许可各自独立。')
  return lines.join('\n')
}

/**
 * Resolve the output file.
 *
 * `out` absent → `assets/audio/handoff-<content hash>.json`, so the same brief
 * always rewrites the same file. A trailing separator means "directory"; a
 * missing `.json` is added rather than silently writing a file the editor will
 * not recognise.
 */
function resolveOut (cwd, requested, text) {
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    throw new Error(`audio_handoff: out must be a string, got ${JSON.stringify(requested)}`)
  }
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (raw === '') {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 10)
    return resolvePath(cwd, [...DEFAULT_DIRECTORY, `handoff-${digest}.json`].join('/'))
  }
  const resolved = resolvePath(cwd, raw)
  if (/[\\/]$/.test(raw)) return resolvePath(cwd, raw.replace(/[\\/]+$/, '') + '/handoff.json')
  return /\.json$/i.test(resolved) ? resolved : `${resolved}.json`
}

/** The three-line Chinese summary a tool result leads with. */
function buildText ({ path, bytes, target, tracks, ecosystem }) {
  const lines = [`交接简报：${path}（${bytes} B）`]
  if (target === null) {
    lines.push('目标：null（未检测到同类音频插件；简报仍可当分工清单）')
  } else {
    const capabilities = capabilityNames(target.capabilities)
    const version = target.version === null ? '' : ` v${target.version}`
    lines.push(`目标：${target.name}${version}${capabilities.length === 0 ? '（能力未知）' : `（能力：${capabilities.join(' / ')}）`}`)
  }
  lines.push(tracks.length === 0
    ? '轨道：未指定（简报里没有逐轨请求）'
    : `轨道：${tracks.map((track) => track.role).join(' / ')}（${tracks.length} 条，各带请求、边界与验收）`)
  lines.push(`生态：${summarizeEcosystem(ecosystem)}`)
  return lines.join('\n')
}

/** Register `audio_handoff` on `ctx.tools`. */
export function registerHandoffTools (ctx) {
  ctx.tools.register({
    name: 'audio_handoff',
    description: "Write a handoff brief (JSON) that divides an audio job between this plugin and a detected peer audio plugin (e.g. dsh-any-audio): target plugin + capabilities, one request per track, and a pasteable instruction. Read-only profile detection; no network and no cross-plugin tool calls — the peer's wav/midi comes back to audio_probe / audio_loudness / audio_check. Also useful with no peer installed: the brief is then a division-of-labour checklist.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: `What the sound work is (≤${MAX_PROMPT} chars). The sentence handed to the peer plugin.` },
        durationSeconds: { type: 'number', description: `Planned length in seconds, ${MIN_DURATION}..${MAX_DURATION}; defaults to ${DEFAULT_DURATION}.` },
        tracks: {
          type: 'array',
          description: 'Tracks to hand over; each names a role and, optionally, its style. Omitted = no per-track requests.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: [...ROLES], description: 'music = instruments/arrangement, narration = voice, sfx = a library sound.' },
              style: { type: 'string', description: 'Free-form style hint for this track (e.g. "8-bit", "warm and slow").' }
            },
            required: ['role']
          }
        },
        out: { type: 'string', description: 'Output .json path; defaults to assets/audio/handoff-<content-hash>.json.' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Handoff ${String(args?.prompt ?? '').slice(0, 60) || 'audio'}`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (prompt.length === 0) {
        throw new Error('audio_handoff: prompt is required (a non-empty string)')
      }
      if (prompt.length > MAX_PROMPT) {
        throw new Error(`audio_handoff: prompt is ${prompt.length} chars, over the ${MAX_PROMPT} limit`)
      }
      // Argument validation runs before any detection or write, so a bad call
      // never leaves a file behind or touches the profile.
      const durationSeconds = readDuration(input.durationSeconds)
      const requestedTracks = readTracks(input.tracks)

      const ecosystem = detectEcosystem()
      const target = pickHandoffTarget(ecosystem)
      const tracks = buildTracks(requestedTracks, ecosystem)
      const instruction = buildInstruction({ prompt, durationSeconds, tracks, target })

      const brief = {
        schema: SCHEMA,
        generator: 'dsh-audiokit',
        prompt,
        durationSeconds,
        target,
        tracks,
        instruction,
        acceptance: unique(tracks.map((track) => track.acceptance))
      }
      const text = `${JSON.stringify(brief, null, 2)}\n`
      const cwd = sessionCwd(ctx, exec)
      const outputPath = resolveOut(cwd, input.out, text)
      await writeFileAtomic(outputPath, Buffer.from(text, 'utf8'))

      const shown = displayPath(cwd, outputPath)
      const bytes = Buffer.byteLength(text, 'utf8')
      return {
        path: outputPath,
        relativePath: shown,
        bytes,
        schema: SCHEMA,
        prompt,
        durationSeconds,
        target,
        tracks,
        instruction,
        ecosystem: { plugins: ecosystem.plugins, summary: summarizeEcosystem(ecosystem) },
        text: buildText({ path: shown, bytes, target, tracks, ecosystem })
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
