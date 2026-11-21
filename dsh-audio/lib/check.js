/**
 * `audio_check`: the quality gate.
 *
 * Two layers, because they fail differently:
 *   - technical: measurable things a machine can be certain about (clipping,
 *     silence, late attacks, a cue that never plays, a sum that will clip);
 *   - semantic: an optional opinion from an audio-understanding model, asked a
 *     question with a checkable answer instead of "does this sound good".
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { measure, readTrack, resolvePath, toWavBytes } from './audio.js'
import { describeAudio, toWav } from './providers.js'

const SILENT_PEAK_DB = -40
const LATE_ATTACK_SECONDS = 0.15
const CLIP_SUM_PEAK = 1.0

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function describeValue (value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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

/** Seconds until the signal first crosses a threshold, i.e. how late the attack is. */
export function leadingSilence (samples, sampleRate, thresholdDb = SILENT_PEAK_DB) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak === 0) return samples.length / sampleRate
  const threshold = Math.pow(10, thresholdDb / 20)
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > threshold) return i / sampleRate
  }
  return samples.length / sampleRate
}

function fractionBelow (samples, sampleRate, thresholdDb = SILENT_PEAK_DB) {
  const threshold = Math.pow(10, thresholdDb / 20)
  let quiet = 0
  for (let i = 0; i < samples.length; i += 1) if (Math.abs(samples[i]) < threshold) quiet += 1
  return samples.length === 0 ? 1 : quiet / samples.length
}

function inspectFile (cwd, path, expectDuration, issues, trackCache) {
  const label = displayPath(cwd, path)
  const track = trackCache.get(path)
  const metrics = { ...measure(track.samples, track.sampleRate), sampleRate: track.sampleRate }
  const attack = leadingSilence(track.samples, track.sampleRate)

  if (metrics.clipping > 0) issues.push({ level: 'error', target: label, message: `${metrics.clipping} 个采样被削波` })
  if (metrics.peakDbfs <= SILENT_PEAK_DB) issues.push({ level: 'error', target: label, message: `几乎无声（峰值 ${metrics.peakDbfs} dBFS）` })
  else if (metrics.peakDbfs > -0.2) issues.push({ level: 'warn', target: label, message: `峰值 ${metrics.peakDbfs} dBFS 贴顶，混在一起会破` })
  if (metrics.dcOffset > 0.01) issues.push({ level: 'warn', target: label, message: `直流偏移 ${metrics.dcOffset}` })
  if (attack > 0.5) issues.push({ level: 'warn', target: label, message: `前 ${(attack * 1000).toFixed(0)}ms 是静音，声音会听起来晚` })
  else if (attack > LATE_ATTACK_SECONDS) issues.push({ level: 'info', target: label, message: `攻击前有 ${(attack * 1000).toFixed(0)}ms 静音，排拍点时要么算进去，要么裁掉` })
  if (fractionBelow(track.samples, track.sampleRate) > 0.9) issues.push({ level: 'warn', target: label, message: '九成以上是静音，可能在申请一段没用满的文件' })
  if (Number.isFinite(expectDuration) && Math.abs(metrics.durationSeconds - expectDuration) > 0.05) {
    issues.push({ level: 'error', target: label, message: `时长 ${metrics.durationSeconds.toFixed(2)}s ≠ 期望 ${expectDuration.toFixed(2)}s` })
  }

  return { path, label, metrics, attack }
}

/** Register the `audio_check` tool. */
export function registerCheckTool (ctx, config = {}) {
  const checkConfig = config.check ?? {}

  ctx.tools.register({
    name: 'audio_check',
    description: 'Check rendered audio before it ships: clipping, near-silence, late attacks, DC offset, duration mismatches, cue files that do not exist, and a summed peak that tells you whether the cues will clip when they play together. Give `question` to also have an audio-understanding model judge whether the sound matches what you intended.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Audio files to check, relative to the working directory or absolute.' },
        cues: {
          type: 'array',
          description: 'Optional timeline to validate: each entry names a file and the second it should fire, which catches a cue that points at a silent or missing file.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              at: { type: 'number', description: 'Start time in seconds.' },
              src: { type: 'string', description: 'Audio file path.' }
            },
            required: ['at', 'src']
          }
        },
        expectDuration: { type: 'number', description: 'Expected duration for a single file (used by paths).' },
        question: { type: 'string', description: 'Optional: ask an audio-understanding model about the sound, e.g. "does this match a heavy metal door slamming in a large hall?". Requires config.check.' },
        audio: { type: 'string', description: 'Which file to send with `question`; defaults to the first path or cue source.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Check audio', kind: 'other', rawInput: { files: (args.paths ?? []).length, cues: (args.cues ?? []).length } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const issues = []
      // Per-call cache: a module-level one would be cleared by a concurrent
      // call from another sub-agent while this one is still folding.
      const trackCache = new Map()
      const files = []
      const seen = new Set()
      const paths = Array.isArray(args.paths) ? args.paths : []
      const cues = Array.isArray(args.cues) ? args.cues : []
      if (paths.length === 0 && cues.length === 0) {
        throw new Error('audio_check 需要 paths 或 cues：至少给一个要检查的音频文件或一条 cue')
      }

      for (let index = 0; index < paths.length; index += 1) {
        const path = resolvePath(cwd, paths[index])
        if (path === undefined) {
          throw new Error(`audio_check: paths[${index}] 不是可用的文件路径（${describeValue(paths[index])}）`)
        }
        if (seen.has(path)) continue
        seen.add(path)
        try {
          const track = await readTrack(path)
          trackCache.set(path, track)
          files.push(inspectFile(cwd, path, paths.length === 1 ? args.expectDuration : undefined, issues, trackCache))
        } catch (error) {
          issues.push({ level: 'error', target: displayPath(cwd, path), message: `读不出来：${error.message}` })
        }
      }

      // Cues are validated before any of them is read: a cue with no `src` used
      // to be skipped silently (which made a 0-file "ok" verdict possible) and a
      // null entry crashed with a raw TypeError.
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index]
        if (cue === null || typeof cue !== 'object') {
          throw new Error(`audio_check: cues[${index}] 必须是 { at, src } 对象，收到 ${describeValue(cue)}`)
        }
        if (resolvePath(cwd, cue.src) === undefined) {
          const name = typeof cue.name === 'string' && cue.name.trim() !== '' ? `（cue "${cue.name}"）` : ''
          throw new Error(`audio_check: cues[${index}] 缺少可用的 src 路径${name}`)
        }
      }

      let summedPeak = 0
      let timelineEnd = 0
      if (cues.length > 0) {
        const placed = []
        for (const cue of cues) {
          const path = resolvePath(cwd, cue.src)
          if (path === undefined) continue
          const at = Number(cue.at)
          if (!Number.isFinite(at) || at < 0) {
            issues.push({ level: 'error', target: displayPath(cwd, path), message: `at=${cue.at} 不是合法时间` })
            continue
          }
          try {
            if (!trackCache.has(path)) trackCache.set(path, await readTrack(path))
            const track = trackCache.get(path)
            if (!files.some((file) => file.path === path)) {
              files.push(inspectFile(cwd, path, undefined, issues, trackCache))
            }
            const metrics = measure(track.samples, track.sampleRate)
            if (metrics.peakDbfs <= SILENT_PEAK_DB) {
              issues.push({ level: 'error', target: displayPath(cwd, path), message: `cue 在 ${at.toFixed(2)}s，但文件是静音的` })
            }
            placed.push({ at, track })
            timelineEnd = Math.max(timelineEnd, at + track.samples.length / track.sampleRate)
          } catch (error) {
            issues.push({ level: 'error', target: displayPath(cwd, path), message: `cue 在 ${at.toFixed(2)}s，但文件读不出来：${error.message}` })
          }
        }

        if (placed.length > 0) {
          const sampleRate = Math.max(...placed.map((item) => item.track.sampleRate))
          const frames = Math.ceil(timelineEnd * sampleRate) + 1
          const sum = new Float32Array(frames)
          for (const { at, track } of placed) {
            const start = Math.round(at * sampleRate)
            const step = track.sampleRate / sampleRate
            for (let i = 0; start + i < frames && i < Math.ceil(track.samples.length / step); i += 1) {
              sum[start + i] += track.samples[Math.min(track.samples.length - 1, Math.round(i * step))]
            }
          }
          for (let i = 0; i < frames; i += 1) summedPeak = Math.max(summedPeak, Math.abs(sum[i]))
          if (summedPeak > CLIP_SUM_PEAK) {
            issues.push({ level: 'error', target: 'timeline', message: `叠加峰值 ${(20 * Math.log10(summedPeak)).toFixed(1)} dBFS，会削波：降几条 cue 的增益，或在页面里加总线压缩` })
          } else if (summedPeak > 0.95) {
            issues.push({ level: 'warn', target: 'timeline', message: `叠加峰值 ${(20 * Math.log10(summedPeak)).toFixed(1)} dBFS，已经贴顶` })
          }
          if (Number.isFinite(args.expectDuration) && Math.abs(timelineEnd - Number(args.expectDuration)) > 0.1) {
            issues.push({ level: 'warn', target: 'timeline', message: `最后一条 cue 在 ${timelineEnd.toFixed(2)}s 结束，动画是 ${Number(args.expectDuration).toFixed(2)}s` })
          }
        }
      }

      // Nothing readable is an error, not a clean verdict: an "ok · 0 file(s)"
      // report hid a blank path or an empty cue list.
      if (files.length === 0) {
        const reasons = issues.map((issue) => `${issue.target}: ${issue.message}`).join('；')
        throw new Error(`audio_check: 没有可读的音频文件${reasons === '' ? '' : `（${reasons}）`}`)
      }

      let verdict = 'ok'
      if (issues.some((issue) => issue.level === 'error')) verdict = 'fail'
      else if (issues.some((issue) => issue.level === 'warn')) verdict = 'warn'

      let opinion = null
      if (typeof args.question === 'string' && args.question.trim().length > 0) {
        const target = args.audio !== undefined
          ? resolvePath(cwd, args.audio)
          : (files.length > 0 ? files[0].path : undefined)
        if (target === undefined) throw new Error('audio_check: 给了 question 但找不到要分析的音频')
        const track = trackCache.get(target) ?? await readTrack(target)
        opinion = await describeAudio(checkConfig, toWavBytes(track.samples, track.sampleRate), args.question.trim())
      }

      const lines = []
      lines.push(`Checked ${files.length} file(s)${cues.length > 0 ? `, ${cues.length} cue(s)` : ''} · verdict: ${verdict}`)
      for (const file of files) {
        const m = file.metrics
        lines.push(`  ${file.label}  ${m.durationSeconds.toFixed(2)}s  peak ${m.peakDbfs}  rms ${m.rmsDbfs}  attack ${(file.attack * 1000).toFixed(0)}ms`)
      }
      if (cues.length > 0) lines.push(`  叠加峰值 ${summedPeak > 0 ? (20 * Math.log10(summedPeak)).toFixed(1) : '-inf'} dBFS`)
      for (const issue of issues) lines.push(`  ${issue.level.toUpperCase()} ${issue.target}: ${issue.message}`)
      if (opinion !== null) lines.push(`  听感：${opinion}`)

      return {
        verdict,
        issues,
        files: files.map((file) => ({ path: file.path, metrics: file.metrics, attackSeconds: Number(file.attack.toFixed(3)) })),
        summedPeakDbfs: summedPeak > 0 ? Number((20 * Math.log10(summedPeak)).toFixed(2)) : null,
        opinion,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
