/**
 * `audio_audit`: the three-way delivery audit as a tool.
 *
 * The audit itself lives in `lib/audit.js`; this file is the seam — path
 * resolution, argument validation, the Chinese report text and the optional
 * JSON report — because that is the part every tool in this package repeats and
 * the part that must fail with a readable message instead of a raw stack.
 *
 * The tool is intentionally read-only: it never rewrites the wav, the srt or the
 * mouth track. A gate that normalises what it was asked to inspect cannot be
 * used as a gate, so a caller that wants a fix gets the issue list and applies
 * it itself.
 */

import { join, relative } from 'node:path'
import { resolvePath, writeFileAtomic } from './audio.js'
import { AUDIT_CHECKS, CHECK_LABELS, auditDelivery } from './audit.js'

/** The tolerance is a millisecond count; anything past this is a unit mistake. */
const MAX_DRIFT_LIMIT_MS = 5000

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

function describeValue (value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  // A model can hand over a whole mouth track by mistake; echoing it would make
  // the error message hundreds of kilobytes long. Name the shape, not the value.
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    return `对象（${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}）`
  }
  return String(value)
}

/** Case-insensitive on Windows, exact elsewhere: is `a` the same file as `b`? */
function samePath (a, b) {
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/**
 * The input files this call reads, resolved. Used to refuse an `out` that points
 * at one of them: the audit is read-only, and `out: 'narration.wav'` would
 * replace the narration with the JSON report.
 * @returns {string[]} absolute paths.
 */
function inputPaths (cwd, args) {
  const candidates = [args.audio, args.srt, typeof args.visemes === 'string' ? args.visemes : null]
  const resolved = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const path = resolvePath(cwd, candidate)
    if (path !== undefined) resolved.push(path)
  }
  return resolved
}

/**
 * Resolve the report path. A model that passes a bare stem ("out/audit") gets
 * `.json` appended; an explicit file name is kept as given.
 */
function outputTarget (cwd, requested) {
  const resolved = resolvePath(cwd, requested)
  if (resolved === undefined) return join(cwd, 'assets', 'audio', 'audit.json')
  const base = resolved.split(/[\\/]/).pop() ?? ''
  return base.includes('.') ? resolved : `${resolved}.json`
}

/**
 * Render one Chinese report: the verdict line, one line per pairwise check
 * (including the skipped ones and why), then every issue in discovery order.
 */
function reportText (report, written) {
  const lines = [report.summary]
  for (const id of AUDIT_CHECKS) {
    const check = report.checks[id]
    if (check === undefined) continue
    lines.push(`  ${CHECK_LABELS[id]}：${check.detail}`)
  }
  for (const issue of report.issues) {
    const level = issue.severity === 'error' ? 'ERROR' : 'WARN'
    lines.push(`  ${level} ${issue.kind} @${issue.at}s：${issue.detail}`)
  }
  lines.push(written === null ? '  未写报告文件（传 out 可保存 JSON）' : `  报告：${written}`)
  return lines.join('\n')
}

/** Register the `audio_audit` tool. */
export function registerAuditTool (ctx) {
  ctx.tools.register({
    name: 'audio_audit',
    description: 'Three-way delivery audit: narration wav ↔ subtitle srt ↔ mouth track. Compares whichever of the three sources the call provides: a subtitle cue over silence, speech with no subtitle, a subtitle start that misses the first onset under it by more than maxDriftMs; a mouth track that does not cover the speech (its declared leadMs is honoured), an open mouth over silence, one-frame viseme flicker; and a caption interval with no open-mouth frame. Returns { ok, issues:[{kind,at,detail,severity}], summary, worstDriftMs, skipped, checksRun } and never modifies an input file (`out` may not point at one). A combination that cannot run is reported as skipped; ok is false when no pair could run, because an unaudited delivery is not a pass. The report text is Chinese.',
    parameters: {
      type: 'object',
      properties: {
        audio: { type: 'string', description: 'Narration .wav to audit, relative to the working directory or absolute. Mono or multichannel; the speech map is built from a per-channel peak envelope, so an out-of-phase stereo pair is not read as silence.' },
        srt: { type: 'string', description: 'Optional .srt subtitle file, normally the one audio_tts wrote next to the wav.' },
        visemes: {
          anyOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true }
          ],
          description: 'Optional mouth track: a path to the audio_lipsync JSON track, or the payload inline ({ fps, frames:[{t,viseme}] }). Viseme labels outside the module whitelist are treated as none and counted.'
        },
        maxDriftMs: { type: 'number', description: 'How far a subtitle start may sit from the first speech onset under it before it is reported, in ms (0..5000, default 80). Past twice this it is an error.' },
        out: { type: 'string', description: 'Optional output path for the JSON report (.json appended to a bare stem); the summary is returned either way.' }
      },
      required: ['audio'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Audit narration sync',
      kind: 'other',
      rawInput: {
        audio: String(args.audio ?? ''),
        srt: args.srt ?? null,
        visemes: typeof args.visemes === 'string' ? args.visemes : 'inline'
      }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)

      // Validate everything before reading the wav: a typo in a tolerance or a
      // mistyped visemes value must not cost a decode first.
      if (typeof args.audio !== 'string' || args.audio.trim() === '') {
        throw new Error('audio_audit 需要 audio（旁白 .wav 路径）')
      }
      if (args.srt !== undefined && (typeof args.srt !== 'string' || args.srt.trim() === '')) {
        throw new Error(`audio_audit: srt 必须是 .srt 文件路径，收到 ${describeValue(args.srt)}`)
      }
      const inlineVisemes = args.visemes !== undefined && args.visemes !== null
      if (inlineVisemes) {
        const isPath = typeof args.visemes === 'string'
        const isPayload = typeof args.visemes === 'object' && !Array.isArray(args.visemes)
        if (!isPath && !isPayload) {
          throw new Error(`audio_audit: visemes 必须是 lipsync json 路径或 { frames: [...] } 对象，收到 ${describeValue(args.visemes)}`)
        }
      }
      let maxDriftMs
      if (args.maxDriftMs !== undefined) {
        const value = Number(args.maxDriftMs)
        if (!Number.isFinite(value) || value < 0 || value > MAX_DRIFT_LIMIT_MS) {
          throw new Error(`audio_audit: maxDriftMs 必须是 0..${MAX_DRIFT_LIMIT_MS} 之间的毫秒数，收到 ${describeValue(args.maxDriftMs)}`)
        }
        maxDriftMs = value
      }
      if (args.out !== undefined && (typeof args.out !== 'string' || args.out.trim() === '')) {
        throw new Error(`audio_audit: out 必须是文件路径，收到 ${describeValue(args.out)}`)
      }
      // Resolve the report path before reading anything: an `out` that names one
      // of the inputs is a hard error, not a write that silently destroys the wav
      // the audit was asked to inspect.
      const requestedOut = typeof args.out === 'string' && args.out.trim() !== '' ? args.out : null
      const target = requestedOut === null ? null : outputTarget(cwd, requestedOut)
      if (target !== null) {
        const clash = inputPaths(cwd, args).find((path) => samePath(path, target))
        if (clash !== undefined) {
          throw new Error(`audio_audit: out 指向了输入文件 ${displayPath(cwd, clash)}；对账只读，不会覆盖输入，请换一个输出名`)
        }
      }

      const report = await auditDelivery({
        cwd,
        audio: args.audio,
        srt: args.srt,
        visemes: args.visemes,
        maxDriftMs
      })

      let bytes = 0
      if (target !== null) {
        const payload = {
          format: 'dsh-audio-audit',
          version: 1,
          ok: report.ok,
          summary: report.summary,
          worstDriftMs: report.worstDriftMs,
          skipped: report.skipped,
          checksRun: report.checksRun,
          sources: report.sources,
          checks: report.checks,
          metrics: report.metrics,
          issues: report.issues
        }
        const content = JSON.stringify(payload, null, 2)
        bytes = Buffer.byteLength(content)
        await writeFileAtomic(target, Buffer.from(content, 'utf8'))
      }

      const relativePath = target === null ? null : displayPath(cwd, target)
      return {
        ok: report.ok,
        issues: report.issues,
        summary: report.summary,
        worstDriftMs: report.worstDriftMs,
        skipped: report.skipped,
        checksRun: report.checksRun,
        checks: report.checks,
        metrics: report.metrics,
        sources: report.sources,
        path: target,
        relativePath,
        bytes,
        text: reportText(report, relativePath)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
