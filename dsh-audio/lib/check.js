/**
 * `audio_check`: the quality gate.
 *
 * Three layers, because they fail differently:
 *   - technical: measurable things a machine can be certain about (clipping,
 *     silence, late attacks, a cue that never plays, a sum that will clip);
 *   - local acoustic self-check: deterministic family-shape heuristics from
 *     `lib/selfcheck.js` — no model, no key, no network, so it always runs;
 *   - semantic: an optional opinion from an audio-understanding model, asked a
 *     question with a checkable answer instead of "does this sound good". It is
 *     optional on purpose: an unconfigured machine gets the local verdict
 *     instead of a configuration error.
 *
 * Every channel is measured, never a mono fold: a clipped channel averaged with
 * a silent one would stop reporting clipping, and an out-of-phase stereo pair
 * would average to digital silence.
 *
 * On top of the three layers above, this file wires in the delivery-verification
 * layer from `lib/verify.js`: platform loudness compliance (`target` /
 * `loudnessTarget`), phase and mono compatibility, and cue-vs-picture sync.
 * Those are pure judgements over samples and planned times — they report the gap
 * and never rewrite the file — and their blocks (`compliance`, `phase`, `sync`)
 * are optional additions: without the new arguments the result is byte-for-byte
 * the same shape it always was.
 */

import { relative } from 'node:path'
import {
  averageChannels,
  measureChannels,
  peakEnvelope,
  readChannels,
  resolvePath,
  toWavBytes
} from './audio.js'
import { describeAudio } from './providers.js'
import { selfCheck } from './selfcheck.js'
import { SEMANTIC_DISABLED_TEXT, semanticCheckEnabled } from './settings-route.js'
import {
  LOUDNESS_TARGET_IDS,
  resolveLoudnessTarget,
  verifyCueSync,
  verifyLoudness,
  verifyPhase
} from './verify.js'

const SILENT_PEAK_DB = -40
const LATE_ATTACK_SECONDS = 0.15
const CLIP_SUM_PEAK = 1.0

/**
 * How many per-file lines the human text repeats for the verification blocks
 * (compliance, phase). The JSON keeps every entry; the text stays readable
 * when a caller checks a whole cue set at once.
 */
const REPORT_LINE_LIMIT = 8

/**
 * Self-check failures that the file-level technical checks already report, so a
 * broken file does not produce the same sentence twice. Everything else the
 * local check catches (non-finite samples, family shape, loop seam, a duration
 * the caller stated in `spec`, sample rate) is new information.
 */
const DUPLICATE_WITH_FILE_CHECKS = new Set(['peak', 'clipping', 'dcOffset'])

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

/**
 * Inspect one decoded file: technical issues plus the metrics the report shows.
 *
 * @param {string} cwd - session directory, for display paths.
 * @param {string} path - absolute path of the file.
 * @param {number|undefined} expectDuration - requested duration, when the caller named one.
 * @param {object[]} issues - accumulator for file-level issues.
 * @param {Map<string, object>} stash - decoded channels, shared with the cue pass.
 * @returns {object} report entry, including the decoded channels for the self-check.
 */
function inspectFile (cwd, path, expectDuration, issues, stash) {
  const label = displayPath(cwd, path)
  const decoded = stash.get(path)
  const metrics = {
    ...measureChannels(decoded.channels, decoded.sampleRate),
    sampleRate: decoded.sampleRate,
    channelCount: decoded.channelCount
  }
  // The peak envelope, not the mono fold: an out-of-phase stereo pair must keep
  // its attack and its level, and a one-sided clipped pair must keep its clip.
  const envelope = peakEnvelope(decoded.channels)
  const attack = leadingSilence(envelope, decoded.sampleRate)
  const worstChannel = metrics.perChannel === undefined
    ? -1
    : metrics.perChannel.findIndex((channel) => channel.clipping === metrics.clipping)
  const channelNote = metrics.channelCount > 1 && worstChannel >= 0
    ? `（最差声道 ${worstChannel + 1}/${metrics.channelCount}）`
    : ''

  if (metrics.clipping > 0) issues.push({ level: 'error', target: label, message: `${metrics.clipping} 个采样被削波${channelNote}` })
  if (metrics.peakDbfs <= SILENT_PEAK_DB) {
    issues.push({ level: 'error', target: label, message: `几乎无声（峰值 ${metrics.peakDbfs} dBFS${metrics.channelCount > 1 ? `，${metrics.channelCount} 声道最大值` : ''}）` })
  } else if (metrics.peakDbfs > -0.2) {
    issues.push({ level: 'warn', target: label, message: `峰值 ${metrics.peakDbfs} dBFS 贴顶，混在一起会破` })
  }
  if (metrics.dcOffset > 0.01) issues.push({ level: 'warn', target: label, message: `直流偏移 ${metrics.dcOffset}` })
  if (attack > 0.5) issues.push({ level: 'warn', target: label, message: `前 ${(attack * 1000).toFixed(0)}ms 是静音，声音会听起来晚` })
  else if (attack > LATE_ATTACK_SECONDS) issues.push({ level: 'info', target: label, message: `攻击前有 ${(attack * 1000).toFixed(0)}ms 静音，排拍点时要么算进去，要么裁掉` })
  if (fractionBelow(envelope, decoded.sampleRate) > 0.9) issues.push({ level: 'warn', target: label, message: '九成以上是静音，可能在申请一段没用满的文件' })
  if (Number.isFinite(expectDuration) && Math.abs(metrics.durationSeconds - expectDuration) > 0.05) {
    issues.push({ level: 'error', target: label, message: `时长 ${metrics.durationSeconds.toFixed(2)}s ≠ 期望 ${expectDuration.toFixed(2)}s` })
  }

  return {
    path,
    label,
    metrics,
    attack,
    channels: decoded.channels,
    sampleRate: decoded.sampleRate,
    channelCount: decoded.channelCount,
    expectedDuration: Number.isFinite(expectDuration) ? Number(expectDuration) : null,
    durationIssue: Number.isFinite(expectDuration) && Math.abs(metrics.durationSeconds - expectDuration) > 0.05,
    selfCheck: null
  }
}

/**
 * Register the `audio_check` tool.
 * @param {object} ctx - Cordis context with the tools service.
 * @param {object} [config] - plugin config; `config.check` configures the
 *   optional audio-understanding model. Its absence never fails a call.
 */
export function registerCheckTool (ctx, config = {}) {
  const checkConfig = config.check ?? {}

  ctx.tools.register({
    name: 'audio_check',
    description: 'Quality gate before delivery: clipping, near-silence, late attacks, DC offset, duration mismatches, missing cue files and the summed peak, plus a keyless local acoustic self-check against the `spec` family. Optional `target`/`loudnessTarget` judges a platform delivery spec (LUFS, true peak) and reports the gap; `cues[].expectAt`/`targets` reports cue sync drift, and stereo or surround also gets a phase/mono report. `question` asks an audio-understanding model and needs the semantic check enabled and configured.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Audio files to check, relative to the working directory or absolute.' },
        cues: {
          type: 'array',
          description: 'Optional timeline: file plus the second it fires; `expectAt`/`targets` add sync drift.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              at: { type: 'number', description: 'Start time in seconds.' },
              src: { type: 'string', description: 'Audio file path.' },
              name: { type: 'string', description: 'Optional cue name used in the report and in sync messages.' },
              expectAt: { type: 'number', description: 'Second this cue was planned for; the sync block reports `at - expectAt` as late or early.' }
            },
            required: ['at', 'src']
          }
        },
        expectDuration: { type: 'number', description: 'Expected duration for a single file (used by paths).' },
        target: {
          type: 'string',
          enum: LOUDNESS_TARGET_IDS,
          description: 'Platform delivery spec; judges LUFS and true peak against its published target and reports the gap.'
        },
        loudnessTarget: {
          type: 'object',
          additionalProperties: false,
          description: 'Custom delivery target instead of `target`: { targetLufs, ceilingDbtp, toleranceLu, label }.',
          properties: {
            targetLufs: { type: 'number', description: 'Desired integrated loudness in LUFS (between -60 and 0).' },
            ceilingDbtp: { type: 'number', description: 'Maximum true peak in dBTP (between -20 and 0); defaults to -1.' },
            toleranceLu: { type: 'number', description: 'Accepted distance from the loudness target in LU (in (0, 6], default 1).' },
            label: { type: 'string', description: 'Name shown in the report; defaults to the numbers it was given.' }
          },
          required: ['targetLufs']
        },
        targets: {
          type: 'array',
          items: { type: 'number' },
          description: 'Target second per cue, parallel to `cues`; a per-cue `expectAt` wins.'
        },
        toleranceSeconds: { type: 'number', description: 'How far a cue may sit from its target second before it is reported; default 0.05 s.' },
        spec: {
          type: 'object',
          additionalProperties: false,
          description: 'Render spec the files were made with; adds family-shape comparison to the local check.',
          properties: {
            preset: { type: 'string', description: 'Preset id used by audio_synth, e.g. impact, texture.' },
            recipe: { type: 'string', description: 'Design recipe id used by audio_design, e.g. door-slam-metal, ui-success.' },
            duration: { type: 'number', description: 'Length in seconds that was requested; when omitted a known family\'s default length is expected.' },
            sampleRate: { type: 'integer', description: 'Sample rate that was requested.' },
            loop: { type: 'boolean', description: 'True when the file was rendered as a seamless loop; adds the loop-seam check.' }
          }
        },
        question: { type: 'string', description: 'Also ask an audio-understanding model; needs the semantic check enabled and configured.' },
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
      const stash = new Map()
      const files = []
      const seen = new Set()
      const paths = Array.isArray(args.paths) ? args.paths : []
      const cues = Array.isArray(args.cues) ? args.cues : []
      if (paths.length === 0 && cues.length === 0) {
        throw new Error('audio_check 需要 paths 或 cues：至少给一个要检查的音频文件或一条 cue')
      }
      if (args.spec !== undefined && args.spec !== null && (typeof args.spec !== 'object' || Array.isArray(args.spec))) {
        throw new Error(`audio_check: spec 必须是对象（{ preset, recipe, duration, sampleRate, loop }），收到 ${describeValue(args.spec)}`)
      }
      const checkSpec = args.spec ?? undefined

      // The delivery target and the cue targets are validated before any file is
      // read: a typo in `target` must fail fast instead of after decoding a
      // three-minute file, and a `targets` array that does not line up with
      // `cues` would silently shift every deviation by one entry.
      if (args.target !== undefined && args.loudnessTarget !== undefined) {
        throw new Error('audio_check: target 和 loudnessTarget 只能给一个（target 用平台名，loudnessTarget 用自定义数值）')
      }
      const loudnessRequest = args.target !== undefined ? args.target : args.loudnessTarget
      const loudnessSpec = loudnessRequest === undefined ? null : resolveLoudnessTarget(loudnessRequest)
      if (args.toleranceSeconds !== undefined &&
        (typeof args.toleranceSeconds !== 'number' || !Number.isFinite(args.toleranceSeconds) || args.toleranceSeconds <= 0 || args.toleranceSeconds > 2)) {
        throw new Error(`audio_check: toleranceSeconds 必须是 (0, 2] 之间的数字，收到 ${describeValue(args.toleranceSeconds)}`)
      }
      if (args.targets !== undefined && !Array.isArray(args.targets)) {
        throw new Error(`audio_check: targets 必须是数字数组（与 cues 一一对应的目标时间），收到 ${describeValue(args.targets)}`)
      }
      const cueTargets = args.targets ?? []
      if (args.targets !== undefined) {
        // An explicit `targets` array is a promise about every cue: an empty or
        // short one is a caller bug, not "no targets" (that is `undefined`).
        if (cues.length === 0) throw new Error('audio_check: targets 用来对齐 cues 的目标时间，但这次没有 cues')
        if (cueTargets.length !== cues.length) {
          throw new Error(`audio_check: targets 必须和 cues 一一对应（${cueTargets.length} 个目标 / ${cues.length} 条 cue）`)
        }
        for (let index = 0; index < cueTargets.length; index += 1) {
          const targetAt = cueTargets[index]
          if (typeof targetAt !== 'number' || !Number.isFinite(targetAt) || targetAt < 0) {
            throw new Error(`audio_check: targets[${index}] 不是合法的目标时间（${describeValue(targetAt)}）`)
          }
        }
      }

      // Cues are validated before any file is read (the cue sources included): a
      // cue with no `src` used to be skipped silently — which made a 0-file "ok"
      // verdict possible — and a null entry crashed with a raw TypeError. Doing
      // it first also means a typo in `expectAt` fails before a three-minute
      // render is decoded.
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index]
        if (cue === null || typeof cue !== 'object') {
          throw new Error(`audio_check: cues[${index}] 必须是 { at, src } 对象，收到 ${describeValue(cue)}`)
        }
        if (resolvePath(cwd, cue.src) === undefined) {
          const name = typeof cue.name === 'string' && cue.name.trim() !== '' ? `（cue "${cue.name}"）` : ''
          throw new Error(`audio_check: cues[${index}] 缺少可用的 src 路径${name}`)
        }
        if (cue.expectAt !== undefined && cue.expectAt !== null &&
          (typeof cue.expectAt !== 'number' || !Number.isFinite(cue.expectAt) || cue.expectAt < 0)) {
          throw new Error(`audio_check: cues[${index}].expectAt 不是合法的目标时间（${describeValue(cue.expectAt)}）`)
        }
      }

      for (let index = 0; index < paths.length; index += 1) {
        const path = resolvePath(cwd, paths[index])
        if (path === undefined) {
          throw new Error(`audio_check: paths[${index}] 不是可用的文件路径（${describeValue(paths[index])}）`)
        }
        if (seen.has(path)) continue
        seen.add(path)
        try {
          stash.set(path, await readChannels(path))
          files.push(inspectFile(cwd, path, paths.length === 1 ? args.expectDuration : undefined, issues, stash))
        } catch (error) {
          issues.push({ level: 'error', target: displayPath(cwd, path), message: `读不出来：${error.message}` })
        }
      }

      let summedPeak = 0
      let timelineEnd = 0
      // Cue sync entries, recorded while the timeline is built: a cue whose file
      // cannot be read still has a planned second, and the planned-vs-actual
      // pair is exactly what the deviation report is about.
      const syncEntries = []
      if (cues.length > 0) {
        const placed = []
        for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
          const cue = cues[cueIndex]
          const path = resolvePath(cwd, cue.src)
          if (path === undefined) continue
          const at = Number(cue.at)
          if (!Number.isFinite(at) || at < 0) {
            issues.push({ level: 'error', target: displayPath(cwd, path), message: `at=${cue.at} 不是合法时间` })
            continue
          }
          const expectedAt = cue.expectAt !== undefined && cue.expectAt !== null
            ? Number(cue.expectAt)
            : (cueTargets.length > 0 ? cueTargets[cueIndex] : null)
          const syncEntry = {
            index: cueIndex,
            name: typeof cue.name === 'string' && cue.name.trim() !== '' ? cue.name.trim() : null,
            src: displayPath(cwd, path),
            at,
            expectAt: expectedAt,
            durationSeconds: null
          }
          syncEntries.push(syncEntry)
          try {
            if (!stash.has(path)) stash.set(path, await readChannels(path))
            const decoded = stash.get(path)
            const entry = files.find((file) => file.path === path) ??
              (() => { const created = inspectFile(cwd, path, undefined, issues, stash); files.push(created); return created })()
            if (entry.metrics.peakDbfs <= SILENT_PEAK_DB) {
              issues.push({ level: 'error', target: displayPath(cwd, path), message: `cue 在 ${at.toFixed(2)}s，但文件是静音的` })
            }
            // The timeline sum models the mono cues these tools write, so it
            // sums the mono fold; the file-level check above is the one that
            // sees every channel.
            const mono = decoded.channels.length === 1 ? decoded.channels[0] : averageChannels(decoded.channels)
            placed.push({ at, mono, sampleRate: decoded.sampleRate })
            syncEntry.durationSeconds = mono.length / decoded.sampleRate
            timelineEnd = Math.max(timelineEnd, at + mono.length / decoded.sampleRate)
          } catch (error) {
            issues.push({ level: 'error', target: displayPath(cwd, path), message: `cue 在 ${at.toFixed(2)}s，但文件读不出来：${error.message}` })
          }
        }

        if (placed.length > 0) {
          const sampleRate = Math.max(...placed.map((item) => item.sampleRate))
          const frames = Math.ceil(timelineEnd * sampleRate) + 1
          const sum = new Float32Array(frames)
          for (const { at, mono, sampleRate: trackRate } of placed) {
            const start = Math.round(at * sampleRate)
            const step = trackRate / sampleRate
            for (let i = 0; start + i < frames && i < Math.ceil(mono.length / step); i += 1) {
              sum[start + i] += mono[Math.min(mono.length - 1, Math.round(i * step))]
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

      // --- local acoustic self-check (always runs, never needs a key) --------
      for (const file of files) {
        try {
          file.selfCheck = await selfCheck({ samples: file.channels, sampleRate: file.sampleRate, spec: checkSpec })
        } catch (error) {
          file.selfCheck = null
          issues.push({ level: 'warn', target: file.label, message: `本地自检失败：${error.message}` })
        }
        if (file.selfCheck === null) continue
        // Do not report a technical failure twice: the file-level checks above
        // already name the worst channel and the duration they compared against.
        const duplicates = new Set(DUPLICATE_WITH_FILE_CHECKS)
        if (file.durationIssue) duplicates.add('duration')
        for (const check of file.selfCheck.checks) {
          if (check.ok) continue
          if (duplicates.has(check.name)) continue
          issues.push({ level: check.level, target: file.label, message: `本地自检 ${check.name}：${check.detail}` })
        }
      }
      const checkedFiles = files.filter((file) => file.selfCheck !== null)
      const selfCheckBlock = {
        ok: checkedFiles.length > 0 && checkedFiles.every((file) => file.selfCheck.ok),
        family: checkedFiles.length > 0 ? checkedFiles[0].selfCheck.family : null,
        checks: checkedFiles.flatMap((file) => file.selfCheck.checks.map((check) => ({
          ...check,
          name: checkedFiles.length === 1 ? check.name : `${file.label}:${check.name}`
        }))),
        summary: checkedFiles.length === 0
          ? '本地自检没有可分析的文件'
          : checkedFiles.length === 1
            ? checkedFiles[0].selfCheck.summary
            : `本地自检：${checkedFiles.length} 个文件中 ${checkedFiles.filter((file) => !file.selfCheck.ok).length} 个未通过`,
        metrics: checkedFiles.length > 0 ? checkedFiles[0].selfCheck.metrics : null
      }
      if (checkedFiles.length === 0) {
        issues.push({ level: 'warn', target: 'selfcheck', message: '本地自检没有可分析的文件' })
      }

      // --- delivery verification (lib/verify.js) -----------------------------
      // Three optional blocks. Each one only reports: nothing here rewrites a
      // file, because a gate that quietly normalises what it was asked to
      // inspect cannot be used as a gate.

      // 1. platform loudness compliance, only when the caller named a target.
      let complianceBlock = null
      if (loudnessSpec !== null) {
        const reports = []
        for (const file of files) {
          try {
            const report = verifyLoudness(file.channels, file.sampleRate, loudnessSpec)
            reports.push({ path: file.path, label: file.label, ...report })
            const failed = report.checks.filter((check) => !check.ok)
            if (failed.length > 0) {
              issues.push({
                level: failed.some((check) => check.level === 'error') ? 'error' : 'warn',
                target: file.label,
                message: failed.map((check) => check.detail).join('；')
              })
            }
          } catch (error) {
            // A judgement that cannot run is a warning, not a failure of the
            // audio: an unusual channel count or a sample rate the meter
            // refuses must not fail an otherwise clean file.
            issues.push({ level: 'warn', target: file.label, message: `响度合规判定失败：${error.message}` })
          }
        }
        const offTarget = reports.filter((report) => !report.ok).length
        complianceBlock = {
          ok: reports.length > 0 && offTarget === 0,
          target: { ...loudnessSpec },
          files: reports,
          summary: reports.length === 0
            ? `${loudnessSpec.label} ${loudnessSpec.targetLufs} LUFS / ≤ ${loudnessSpec.ceilingDbtp} dBTP：没有可判定的文件（见 issues）`
            : `${loudnessSpec.label} ${loudnessSpec.targetLufs} LUFS / ≤ ${loudnessSpec.ceilingDbtp} dBTP：${reports.length} 个文件，${offTarget === 0 ? '全部合规' : `${offTarget} 个不合规`}`
        }
      }

      // 2. phase and mono compatibility of every multichannel file.
      const phaseReports = []
      for (const file of files) {
        let report
        try {
          report = verifyPhase(file.channels)
        } catch (error) {
          issues.push({ level: 'warn', target: file.label, message: `相位判定失败：${error.message}` })
          continue
        }
        if (report === null) continue
        phaseReports.push({ path: file.path, label: file.label, ...report })
        for (const check of report.checks) {
          if (check.ok) continue
          issues.push({ level: check.level, target: file.label, message: check.detail })
        }
      }
      const phaseBlock = phaseReports.length === 0
        ? null
        : {
            ok: phaseReports.every((report) => report.ok),
            files: phaseReports,
            worst: (() => {
              let worst = phaseReports[0]
              for (const report of phaseReports) {
                if (report.antiphase !== worst.antiphase) { if (report.antiphase) worst = report; continue }
                if (report.monoLossDb > worst.monoLossDb) worst = report
              }
              return { label: worst.label, pair: worst.pair, correlation: worst.correlation, antiphase: worst.antiphase, monoLossDb: worst.monoLossDb }
            })(),
            summary: `${phaseReports.length} 个多声道文件：${phaseReports.every((report) => report.ok) ? '全部正常' : `${phaseReports.filter((report) => !report.ok).length} 个异常`}`
          }

      // 3. cue-vs-picture sync / timeline consistency.
      let syncBlock = null
      if (syncEntries.length > 0) {
        try {
          const report = verifyCueSync(syncEntries, {
            toleranceSeconds: args.toleranceSeconds,
            expectDuration: args.expectDuration
          })
          syncBlock = report
          for (const check of report.checks) {
            if (check.ok) continue
            issues.push({ level: check.level, target: 'sync', message: check.detail })
          }
        } catch (error) {
          issues.push({ level: 'warn', target: 'sync', message: `cue 时间轴判定失败：${error.message}` })
        }
      }

      let verdict = 'ok'
      if (issues.some((issue) => issue.level === 'error')) verdict = 'fail'
      else if (issues.some((issue) => issue.level === 'warn')) verdict = 'warn'

      // --- optional external opinion ---------------------------------------
      // The semantic layer is opt-in (`config.check.enabled`, off by default).
      // While it is off, a `question` is skipped *before* any key lookup or
      // fetch: "off" has to mean no network, not "make a call and hope it
      // fails fast". The skip is an info note, so the local verdict still
      // stands on its own.
      let opinion = null
      let opinionSkipped = false
      let opinionError = null
      let semanticDisabled = false
      if (typeof args.question === 'string' && args.question.trim().length > 0) {
        const target = args.audio !== undefined
          ? resolvePath(cwd, args.audio)
          : files[0].path
        if (target === undefined) throw new Error('audio_check: 给了 question 但找不到要分析的音频')
        if (!semanticCheckEnabled(checkConfig)) {
          semanticDisabled = true
          opinionSkipped = true
          opinionError = SEMANTIC_DISABLED_TEXT
          issues.push({
            level: 'info',
            target: displayPath(cwd, target),
            message: `question 已跳过：${SEMANTIC_DISABLED_TEXT}`
          })
        } else {
          try {
            if (!stash.has(target)) stash.set(target, await readChannels(target))
            const decoded = stash.get(target)
            const mono = decoded.channels.length === 1 ? decoded.channels[0] : averageChannels(decoded.channels)
            opinion = await describeAudio(checkConfig, toWavBytes(mono, decoded.sampleRate), args.question.trim())
          } catch (error) {
            // No configured model is a normal state, not a failure of the file:
            // say so and keep the local verdict. A configured-but-failing endpoint
            // is a warning, because the caller asked for the opinion.
            const message = String(error?.message ?? error)
            const unconfigured = /没有配置密钥|环境变量|apiKey|API_KEY/.test(message)
            opinionSkipped = unconfigured
            opinionError = message
            issues.push({
              level: unconfigured ? 'info' : 'warn',
              target: displayPath(cwd, target),
              message: unconfigured
                ? `未配置音频理解模型，只运行本地自检（${message}）`
                : `外部听感模型调用失败，本地自检结果不受影响（${message}）`
            })
          }
        }
      }

      // The verdict may have moved because of the opinion note.
      verdict = 'ok'
      if (issues.some((issue) => issue.level === 'error')) verdict = 'fail'
      else if (issues.some((issue) => issue.level === 'warn')) verdict = 'warn'

      const lines = []
      lines.push(`Checked ${files.length} file(s)${cues.length > 0 ? `, ${cues.length} cue(s)` : ''} · verdict: ${verdict}`)
      for (const file of files) {
        const m = file.metrics
        const channels = m.channelCount > 1 ? ` · ${m.channelCount} ch` : ''
        lines.push(`  ${file.label}  ${m.durationSeconds.toFixed(2)}s${channels}  peak ${m.peakDbfs}  rms ${m.rmsDbfs}  attack ${(file.attack * 1000).toFixed(0)}ms`)
        if (m.perChannel !== undefined) {
          lines.push(`    per channel: ${m.perChannel.map((channel, index) => `ch${index + 1} peak ${channel.peakDbfs} dBFS${channel.clipping > 0 ? ` CLIP ${channel.clipping}` : ''}`).join(' · ')}`)
        }
        if (file.selfCheck !== null) lines.push(`    ${file.selfCheck.summary}`)
      }
      if (cues.length > 0) lines.push(`  叠加峰值 ${summedPeak > 0 ? (20 * Math.log10(summedPeak)).toFixed(1) : '-inf'} dBFS`)
      if (complianceBlock !== null) {
        lines.push(`  响度合规 · ${complianceBlock.summary}`)
        for (const report of complianceBlock.files.slice(0, REPORT_LINE_LIMIT)) {
          lines.push(`    ${report.label}: ${report.summary}`)
        }
        if (complianceBlock.files.length > REPORT_LINE_LIMIT) lines.push(`    …另有 ${complianceBlock.files.length - REPORT_LINE_LIMIT} 个文件，见 JSON`)
      }
      if (phaseBlock !== null) {
        const worst = phaseBlock.worst
        const correlation = worst.correlation === null ? 'n/a' : worst.correlation.toFixed(2)
        lines.push(`  相位与单声道兼容 · ${phaseBlock.summary}（最差 ${worst.label}：${worst.pair} 相关性 ${correlation}、折叠损失 ${worst.monoLossDb} dB${worst.antiphase ? '、反相' : ''}）`)
        for (const report of phaseBlock.files.slice(0, REPORT_LINE_LIMIT)) {
          if (report.ok) continue
          lines.push(`    ${report.label}: ${report.summary}`)
        }
      }
      if (syncBlock !== null) {
        lines.push(`  ${syncBlock.summary}`)
        for (const entry of syncBlock.cues) {
          if (entry.level === 'ok') continue
          const name = entry.name === null ? '' : ` "${entry.name}"`
          lines.push(`    cue #${entry.index + 1}${name}: 在 ${entry.at}s，目标 ${entry.expectAt}s，偏差 ${entry.deviationSeconds > 0 ? '+' : ''}${entry.deviationSeconds}s（${entry.level === 'error' ? '超过容差 4 倍' : '超出容差'}）`)
        }
      }
      for (const issue of issues) lines.push(`  ${issue.level.toUpperCase()} ${issue.target}: ${issue.message}`)
      if (opinion !== null) lines.push(`  听感：${opinion}`)
      else if (semanticDisabled) lines.push(`  听感：${SEMANTIC_DISABLED_TEXT}，已跳过（本地自检已给出结论）`)
      else if (opinionSkipped) lines.push('  听感：未配置音频理解模型，已跳过（本地自检已给出结论）')

      return {
        verdict,
        issues,
        files: files.map((file) => ({
          path: file.path,
          label: file.label,
          channels: file.channelCount,
          metrics: file.metrics,
          attackSeconds: Number(file.attack.toFixed(3)),
          selfCheck: file.selfCheck === null
            ? null
            : { ok: file.selfCheck.ok, family: file.selfCheck.family, summary: file.selfCheck.summary }
        })),
        selfCheck: selfCheckBlock,
        compliance: complianceBlock,
        phase: phaseBlock,
        sync: syncBlock,
        summedPeakDbfs: summedPeak > 0 ? Number((20 * Math.log10(summedPeak)).toFixed(2)) : null,
        opinion,
        opinionSkipped,
        opinionError,
        semanticDisabled,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
