/**
 * `audio_mouth`: a mouth track from text, with no audio at all.
 *
 * `audio_lipsync` answers "what should the mouth do at 1.23 s of this wav". This
 * tool answers the same question for a caption, a typewriter line or a silent
 * comic, where there is nothing to analyse. It emits the same frame shape and
 * the same four formats, so a page written against one track drives the other
 * unchanged.
 *
 * Like every analysis tool here it returns a bounded summary — path, numbers,
 * the first frames — and never raw audio. Writes only when `out` is given.
 */

import { join, relative } from 'node:path'
import { clamp } from './dsp.js'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import {
  MOUTH_ALIGNMENTS,
  MOUTH_FORMATS,
  MOUTH_STYLES,
  formatMouth,
  mouthFromText,
  mouthFromTimeline
} from './mouth.js'
import { visemeFallbackWarnings } from './tools-visual.js'

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

function fmt (value, digits = 2) {
  return Number(value).toFixed(digits)
}

function extensionFor (format) {
  if (format === 'srt') return 'srt'
  if (format === 'css') return 'css'
  if (format === 'ae') return 'txt'
  return 'json'
}

/**
 * Resolve the file to write. A model that passes a bare stem ("assets/mouth")
 * gets the format's extension appended; a model that passes an explicit name
 * keeps it, because it may be feeding another tool that expects that name.
 */
function outputTarget (cwd, requested, label, hash, extension) {
  const resolved = resolvePath(cwd, requested)
  if (resolved === undefined) return join(cwd, 'assets', 'audio', `${label}-${hash}.${extension}`)
  const base = resolved.split(/[\\/]/).pop() ?? ''
  return base.includes('.') ? resolved : `${resolved}.${extension}`
}

/** Short, whitespace-normalised excerpt for the one-line summary. */
function excerpt (value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function cueSchema () {
  return {
    type: 'array',
    description: 'Timed caption spans, used instead of text: one entry per karaoke line. Text inside a line is spread across its duration; gaps between lines are closed mouth.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        at: { type: 'number', description: 'Start time in seconds.' },
        text: { type: 'string', description: 'Line shown from that time.' },
        dur: { type: 'number', description: 'How long the line is on screen, in seconds.' }
      },
      required: ['at', 'text', 'dur']
    }
  }
}

/** Register `audio_mouth` on `ctx.tools`. */
export function registerMouthTools (ctx) {
  ctx.tools.register({
    name: 'audio_mouth',
    description: 'Build a mouth track from text alone (a caption, a typewriter line, a silent comic): the same per-frame viseme/openness/energy shape audio_lipsync returns, so one page can drive both. Schedules one syllable per half beat, with a 190 ms floor so fast tempos stay legible (the slot never gets longer at a faster bpm), closes the mouth on punctuation, and writes json/srt/css/ae when `out` is given. Use it when there is no voice audio yet; use audio_lipsync when there is. `includeWarnings` (default off) returns the text notes and any viseme outside the whitelist.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Words to mouth: pinyin ("wo ai ni") or any Latin-script caption. Chinese is accepted but mapped per character; pass pinyin for the real shapes.' },
        cues: cueSchema(),
        bpm: { type: 'number', description: 'Tempo the syllables are scheduled to, 20..300; defaults to 96. Ignored when cues are supplied.' },
        fps: { type: 'integer', description: 'Animation frames per second, 12..120; must match the page or CSS track, defaults to 24.' },
        durationSeconds: { type: 'number', description: 'Force the track length in seconds when using text; syllables compress to fit or the closing rest pads. Cues carry their own times instead. Defaults to the text\'s natural length.' },
        format: { type: 'string', enum: MOUTH_FORMATS, description: 'json = full track, srt = cue sheet, css = keyframes (opacity steps + jaw scale, no @property), ae = After Effects time<TAB>shape paste. Defaults to json.' },
        style: { type: 'string', enum: MOUTH_STYLES, description: 'Performance: neutral, excited (wider jaw, faster transitions) or tired (smaller jaw, slower transitions). Defaults to neutral.' },
        alignment: { type: 'string', enum: MOUTH_ALIGNMENTS, description: 'bpm = syllables on the musical grid (default), even = every event gets an equal slice, cues = drive from the timed cues list.' },
        includeWarnings: { type: 'boolean', description: 'Also return a warnings array (default false) with the text notes and viseme labels outside the whitelist.' },
        out: { type: 'string', description: 'Output path. Defaults to no file; when omitted the summary and first frames are still returned.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Build text mouth track',
      kind: 'other',
      rawInput: {
        source: args.text ?? `${Array.isArray(args.cues) ? args.cues.length : 0} cues`,
        fps: args.fps ?? 24,
        format: args.format ?? 'json'
      }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const fps = clamp(Math.round(Number.isFinite(args.fps) ? args.fps : 24), 12, 120)
      const bpm = clamp(Number.isFinite(args.bpm) ? args.bpm : 96, 20, 300)
      const format = MOUTH_FORMATS.includes(args.format) ? args.format : 'json'
      const style = MOUTH_STYLES.includes(args.style) ? args.style : 'neutral'
      const alignment = MOUTH_ALIGNMENTS.includes(args.alignment) ? args.alignment : 'bpm'
      const hasText = typeof args.text === 'string' && args.text.trim() !== ''
      const hasCues = Array.isArray(args.cues) && args.cues.length > 0

      if (hasText && hasCues) throw new Error('audio_mouth takes text or cues, not both')
      if (!hasText && !hasCues) throw new Error('audio_mouth needs text (a line to mouth) or cues (timed caption spans)')
      if (!hasCues && alignment === 'cues') throw new Error('audio_mouth: alignment "cues" needs the cues list; pass text with bpm or even')

      const requested = Number.isFinite(args.durationSeconds) && args.durationSeconds > 0
        ? clamp(args.durationSeconds, 1 / fps, 600)
        : undefined
      const track = hasCues
        ? mouthFromTimeline({ cues: args.cues, fps, style })
        : mouthFromText({ text: args.text, bpm, fps, style, alignment, durationSeconds: requested })

      const content = formatMouth(track, format, { fps: track.fps, duration: track.durationSeconds })
      const hash = hashSpec({
        text: hasCues ? null : args.text,
        cues: hasCues ? args.cues : null,
        bpm,
        fps,
        style,
        alignment,
        durationSeconds: requested,
        format
      })

      let target = null
      let bytes = 0
      if (typeof args.out === 'string' && args.out.trim() !== '') {
        target = outputTarget(cwd, args.out, 'mouth', hash, extensionFor(format))
        bytes = Buffer.byteLength(content)
        await writeFileAtomic(target, Buffer.from(content, 'utf8'))
      }

      const counts = track.counts
      const total = track.frames.length
      const shapes = Object.keys(counts)
        .filter((viseme) => counts[viseme] > 0)
        .map((viseme) => `${viseme} ${counts[viseme]}`)
        .join(' · ') || 'none 0'
      const previewFrames = track.frames.slice(0, 24)
      const source = hasCues
        ? `${track.cueCount} cue(s), ${track.syllableCount} syllable(s)`
        : `${track.syllableCount} syllable(s) from "${excerpt(args.text, 48)}"`
      const where = target === null
        ? 'no file written (pass out to save)'
        : `wrote ${displayPath(cwd, target)} (${(bytes / 1024).toFixed(1)} KB)`
      const text = [
        `text mouth: ${total} frames @${track.fps}fps, ${shapes}`,
        `${source} · ${style}, ${track.alignment} alignment, ${fmt(track.durationSeconds)}s — ${where}`
      ].join(' · ')

      const warnings = [...visemeFallbackWarnings(track.frames), ...track.warnings]
      return {
        path: target,
        relativePath: target === null ? null : displayPath(cwd, target),
        bytes,
        source: 'text',
        durationSeconds: Number(track.durationSeconds.toFixed(3)),
        fps: track.fps,
        format,
        style,
        alignment: track.alignment,
        frameCount: total,
        syllableCount: track.syllableCount,
        ...(hasCues ? { cueCount: track.cueCount } : {}),
        voicedFrames: track.voicedFrames,
        counts,
        previewFrames,
        // Off by default: the warnings are diagnostic notes a caller opts into,
        // so a normal call keeps the same shape it always had.
        ...(args.includeWarnings === true ? { warnings: [...new Set(warnings)] } : {}),
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
