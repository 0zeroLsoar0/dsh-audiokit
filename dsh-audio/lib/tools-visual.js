/**
 * The two picture-facing tools: `audio_lipsync` and `audio_beats`.
 *
 * They exist because a model authoring an animation cannot hear the wav it just
 * rendered. `audio_probe` answers "what does this file measure"; these two answer
 * "what should the picture do at 1.23 s". Both return a bounded summary — path,
 * numbers, the first frames/beats — and never raw audio.
 *
 * Both accept either an existing file (`path`) or an inline render spec
 * (`render`), so a fresh sound can go straight from synthesis into a sync track
 * in one call, without the model having to remember the wav's path.
 */

import { join, relative } from 'node:path'
import { PRESETS, clamp } from './dsp.js'
import { hashSpec, readTrack, renderPreset, resolvePath, writeFileAtomic } from './audio.js'
import { VISEMES, analyzeVisemes, visemeToTimeline } from './lipsync.js'
import { analyzeBeats } from './beats.js'

const PRESET_NAMES = Object.keys(PRESETS)
const LIPSYNC_FORMATS = ['json', 'srt', 'css', 'ae']
const VISEME_SET = new Set(VISEMES)

/** How many illegal-viseme frames one warning list names before it summarises. */
const WARNING_FRAME_LIMIT = 32

/**
 * Frames whose `viseme` is not one of the whitelisted shapes.
 *
 * The formatters replace an unknown label with `none` (a closed mouth is the
 * safe rendering of "shape not understood") and the low-level sanitizer only
 * reports a count. A caller asking for warnings wants to know *which* frames,
 * because that is what tells it whether the track came from this engine (never
 * invalid) or from hand-edited/generated input — so this scan names the frame
 * index and the label it found. Returns strings for the same reason every other
 * warning list in this package does: they render as one text line and need no
 * shape contract of their own.
 *
 * @param {Array<object>} frames - frame list, possibly from outside this module.
 * @param {number} [limit=32] - how many frames to name before summarising.
 * @returns {string[]} one line per invalid frame, plus a summary line when the
 *   list was truncated; empty when every frame is whitelisted.
 */
export function visemeFallbackWarnings (frames, limit = WARNING_FRAME_LIMIT) {
  const list = Array.isArray(frames) ? frames : []
  const out = []
  let invalid = 0
  for (let index = 0; index < list.length; index += 1) {
    const frame = list[index]
    const viseme = frame !== null && typeof frame === 'object' ? frame.viseme : undefined
    if (typeof viseme === 'string' && VISEME_SET.has(viseme)) continue
    invalid += 1
    if (out.length >= limit) continue
    const label = typeof viseme === 'string' ? viseme : String(viseme)
    const shown = label.length > 24 ? `${label.slice(0, 24)}…` : label
    out.push(`lipsync: frame ${index} has viseme ${JSON.stringify(shown)} outside the whitelist; used "none"`)
  }
  if (invalid > out.length) out.push(`lipsync: ${invalid - out.length} more frame(s) had a viseme outside the whitelist; used "none"`)
  return out
}

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

/**
 * Load the signal an analysis tool should run on: a file on disk, or a fresh
 * render of one preset. Returns the resolved spec too, so the tool can name an
 * output file after exactly what produced the samples.
 */
async function loadSource (cwd, args, toolName) {
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const path = resolvePath(cwd, args.path)
    if (path === undefined) throw new Error(`${toolName} needs a readable .wav path`)
    const track = await readTrack(path)
    return {
      samples: track.samples,
      sampleRate: track.sampleRate,
      path,
      spec: null,
      label: displayPath(cwd, path)
    }
  }

  const render = args.render
  if (render !== null && typeof render === 'object') {
    const preset = String(render.preset ?? '')
    if (!PRESET_NAMES.includes(preset)) {
      throw new Error(`${toolName}: render.preset must be one of ${PRESET_NAMES.join(', ')}`)
    }
    const spec = {
      preset,
      params: render.params ?? {},
      duration: Number.isFinite(render.duration) ? render.duration : undefined,
      seed: Number.isFinite(render.seed) ? render.seed : 1,
      sampleRate: Number.isFinite(render.sampleRate) ? render.sampleRate : 44100,
      loop: render.loop === true
    }
    const rendered = renderPreset(spec)
    return {
      samples: rendered.samples,
      sampleRate: rendered.sampleRate,
      path: null,
      spec,
      label: `render ${preset}`
    }
  }

  throw new Error(`${toolName} needs either path (an existing .wav) or render (an inline preset spec)`)
}

function renderSchema () {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Inline render spec instead of path, rendered first.',
    properties: {
      preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset to render before analysing.' },
      params: { type: 'object', additionalProperties: true, description: 'Preset knobs, same names as audio_synth.' },
      duration: { type: 'number', description: 'Length in seconds; defaults to the preset length.' },
      seed: { type: 'integer', description: 'Variation seed; same seed reproduces the same take.' },
      sampleRate: { type: 'integer', description: 'Defaults to 44100.' },
      loop: { type: 'boolean', description: 'Render a seamless loop before analysis.' }
    },
    required: ['preset']
  }
}

/** Register `audio_lipsync` and `audio_beats` on `ctx.tools`. */
export function registerVisualTools (ctx) {
  ctx.tools.register({
    name: 'audio_lipsync',
    description: 'Analyse a voice file into a per-frame mouth track: viseme, jaw openness, frame energy and voiced flag, from a .wav or an inline render. Writes json/srt/css/ae. Use audio_mouth when there is only text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing .wav, relative to cwd or absolute; omit when using render.' },
        render: renderSchema(),
        fps: { type: 'integer', description: 'Frames per second, 12..120; match the page or CSS track. Default 24.' },
        format: { type: 'string', enum: LIPSYNC_FORMATS, description: 'json (default), srt, css or ae (After Effects paste).' },
        sensitivity: { type: 'number', description: 'Level scaling before classification, 0.25..4; raise for quiet dialogue.' },
        leadMs: { type: 'number', description: 'Analyse this many ms ahead so the picture leads the audio; -200..200.' },
        includeWarnings: { type: 'boolean', description: 'Also return a warnings array; default false.' },
        out: { type: 'string', description: 'Output path; without it the summary is still returned.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Build mouth track', kind: 'other', rawInput: { source: args.path ?? args.render?.preset, fps: args.fps ?? 24, format: args.format ?? 'json' } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const fps = clamp(Math.round(Number.isFinite(args.fps) ? args.fps : 24), 12, 120)
      const format = LIPSYNC_FORMATS.includes(args.format) ? args.format : 'json'
      const sensitivity = clamp(Number.isFinite(args.sensitivity) ? args.sensitivity : 1, 0.25, 4)
      const leadMs = clamp(Number.isFinite(args.leadMs) ? args.leadMs : 0, -200, 200)
      const includeWarnings = args.includeWarnings === true
      const source = await loadSource(cwd, args, 'audio_lipsync')
      const analysis = analyzeVisemes(source.samples, source.sampleRate, { fps, sensitivity, leadMs })
      const content = visemeToTimeline(analysis.frames, format, {
        fps: analysis.fps,
        leadMs: analysis.leadMs,
        duration: analysis.durationSeconds
      })
      const hash = hashSpec({ source: source.spec ?? source.path, fps, format, sensitivity, leadMs })

      let target = null
      let bytes = 0
      if (typeof args.out === 'string' && args.out.trim() !== '') {
        target = outputTarget(cwd, args.out, 'lipsync', hash, extensionFor(format))
        bytes = Buffer.byteLength(content)
        await writeFileAtomic(target, Buffer.from(content, 'utf8'))
      }

      const counts = analysis.counts
      const total = analysis.frames.length
      let dominant = 'none'
      for (const key of Object.keys(counts)) if (counts[key] > counts[dominant]) dominant = key
      const vowels = counts.AA + counts.EH + counts.EE + counts.OH + counts.OO
      const vowelShare = total > 0 ? Math.round(vowels / total * 100) : 0
      const previewFrames = analysis.frames.slice(0, 24)
      const where = target === null ? 'no file written (pass out to save)' : `wrote ${displayPath(cwd, target)} (${(bytes / 1024).toFixed(1)} KB)`
      const text = [
        `Lip-sync ${fmt(analysis.durationSeconds)}s @ ${analysis.fps}fps from ${source.label}: ${total} frames, ${vowels} vowel (${vowelShare}%), dominant ${dominant}, ${analysis.leadMs}ms lead — ${where}`,
        `shapes ${Object.entries(counts).filter(([, count]) => count > 0).map(([key, count]) => `${key}:${count}`).join(' ')}`
      ].join(' · ')

      const result = {
        path: target,
        relativePath: target === null ? null : displayPath(cwd, target),
        bytes,
        durationSeconds: Number(analysis.durationSeconds.toFixed(3)),
        sampleRate: source.sampleRate,
        fps: analysis.fps,
        leadMs: analysis.leadMs,
        format,
        frameCount: total,
        voicedFrames: analysis.voicedFrames,
        counts,
        previewFrames,
        text
      }
      // Off by default: a track this engine generates is always whitelisted, so an
      // always-present empty array would only cost tokens. When asked, report the
      // frames that would fall back (none today, all of them for outside data).
      if (includeWarnings) result.warnings = visemeFallbackWarnings(analysis.frames)
      return result
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_beats',
    description: 'Detect tempo, onsets and a beat grid in a music/rhythm file so animation can land on the beat. Returns bpm, confidence, beat times, a downbeat guess and the quarter/eighth grid; writes the grid as JSON when `out` is given.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing .wav, relative to cwd or absolute; omit when using render.' },
        render: renderSchema(),
        beatsPerBar: { type: 'integer', description: 'Metre used for bar/downbeat numbering, 1..12; defaults to 4.' },
        maxGrid: { type: 'integer', description: 'Cap on grid entries (quarter + eighth positions); defaults to 512.' },
        out: { type: 'string', description: 'Output path for the JSON grid. Defaults to no file; the summary is still returned.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Find the beat', kind: 'other', rawInput: { source: args.path ?? args.render?.preset } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const beatsPerBar = clamp(Math.round(Number.isFinite(args.beatsPerBar) ? args.beatsPerBar : 4), 1, 12)
      const maxGrid = clamp(Math.round(Number.isFinite(args.maxGrid) ? args.maxGrid : 512), 4, 4096)
      const source = await loadSource(cwd, args, 'audio_beats')
      const analysis = analyzeBeats(source.samples, source.sampleRate, { beatsPerBar, maxGrid })
      const firstBeats = analysis.beatTimes.slice(0, 16)
      const firstOnsets = analysis.onsets.slice(0, 8)
      const endBar = analysis.durationToBar(analysis.durationSeconds)

      let target = null
      let bytes = 0
      if (typeof args.out === 'string' && args.out.trim() !== '') {
        const hash = hashSpec({ source: source.spec ?? source.path, beatsPerBar, maxGrid })
        target = outputTarget(cwd, args.out, 'beats', hash, 'json')
        const payload = {
          format: 'dsh-audio-beats',
          version: 1,
          source: {
            path: source.path === null ? null : displayPath(cwd, source.path),
            spec: source.spec,
            durationSeconds: analysis.durationSeconds,
            sampleRate: analysis.sampleRate
          },
          bpm: analysis.bpm,
          confidence: analysis.confidence,
          beatsPerBar: analysis.beatsPerBar,
          secondsPerBeat: analysis.secondsPerBeat,
          secondsPerBar: analysis.secondsPerBar,
          downbeatGuess: analysis.downbeatGuess,
          bars: endBar.bars,
          beatTimes: analysis.beatTimes,
          grid: analysis.grid,
          onsets: analysis.onsets
        }
        const content = JSON.stringify(payload, null, 2)
        bytes = Buffer.byteLength(content)
        await writeFileAtomic(target, Buffer.from(content, 'utf8'))
      }

      const found = analysis.bpm > 0
      const beatStep = analysis.secondsPerBeat
      const eighthStep = beatStep / 2
      const where = target === null ? 'no file written (pass out to save)' : `wrote ${displayPath(cwd, target)} (${(bytes / 1024).toFixed(1)} KB)`
      const text = found
        ? [
            `Beat grid from ${source.label}: ${analysis.bpm} BPM (confidence ${analysis.confidence}), ${analysis.beatsPerBar}/4, beat ${fmt(beatStep, 3)}s = ${fmt(analysis.secondsPerBar, 3)}s/bar, downbeat ${fmt(analysis.downbeatGuess, 3)}s, ${fmt(analysis.durationSeconds)}s = ${endBar.bars} bars, ${analysis.onsets.length} onsets`,
            `first beats ${firstBeats.map((t) => fmt(t, 3)).join(' ') || '-'} — land motion every ${fmt(beatStep, 3)}s (beat) or ${fmt(eighthStep, 3)}s (eighth) — ${where}`
          ].join(' · ')
        : `No stable tempo found in ${source.label} (${fmt(analysis.durationSeconds)}s): ${analysis.onsets.length} onsets, too weak or too irregular for a grid. Use a rhythmic source (audio_pattern, a cue with hits) or plan against the onsets returned. — ${where}`

      return {
        path: target,
        relativePath: target === null ? null : displayPath(cwd, target),
        bytes,
        durationSeconds: Number(analysis.durationSeconds.toFixed(3)),
        sampleRate: source.sampleRate,
        bpm: analysis.bpm,
        confidence: analysis.confidence,
        beatTimes: firstBeats,
        beatCount: analysis.beatTimes.length,
        downbeatGuess: analysis.downbeatGuess,
        beatsPerBar: analysis.beatsPerBar,
        secondsPerBeat: analysis.secondsPerBeat,
        secondsPerBar: analysis.secondsPerBar,
        bars: endBar.bars,
        onsets: firstOnsets,
        onsetCount: analysis.onsets.length,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

/** Exported for the settings page / docs, mirroring `PRESET_NAMES` in tools.js. */
export { LIPSYNC_FORMATS, PRESET_NAMES }
