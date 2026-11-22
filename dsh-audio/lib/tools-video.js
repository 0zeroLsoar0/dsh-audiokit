/**
 * `audio_mux`: the model-facing bridge between this plugin's wavs and a video.
 *
 * The plugin renders sounds and cue sheets, but the deliverable is often a
 * movie: a cue has to end up *on* an mp4/mov/mkv/webm, trimmed to the shot, and
 * the shot's cuts are where cues belong. This tool is the single call that does
 * those three things, and it reports measured numbers (duration, stream count,
 * peak) instead of a claim, because the model cannot watch or listen to the
 * result.
 *
 * One tool with an `action` rather than four tools, because all four answer
 * questions about the same object and the model should not have to remember
 * which of `video_probe` / `video_mux` / `video_cuts` / `video_extract` it needs:
 *   - probe   -> what is in this file (duration, codecs, fps, stream counts);
 *   - mux     -> put a wav onto the picture, replace / mix under / attach;
 *   - cuts    -> scene changes as `audio_bind`-shaped cue times;
 *   - extract -> the picture's audio as a wav the analysis tools can read.
 *
 * Scope boundary, stated in the tool description so the model does not ask this
 * tool for the wrong thing: it muxes and times audio, it does not analyse what
 * is *in* the picture (storyboards, transcripts, shot lists). The separate
 * `dsh-video-storyboard` plugin owns that.
 *
 * ffmpeg/ffprobe are required for mux/cuts/extract; when they are absent the
 * tool explains how to install them and fails, rather than pretending to work.
 */

import { stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import {
  finalize,
  hashSpec,
  measure,
  readTrack,
  renderPreset,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { PRESETS } from './dsp.js'
import {
  CONTAINER_EXTENSIONS,
  MEDIA_LIMITS,
  MUX_MODES,
  detectCuts,
  extractAudio,
  planMux,
  probeMedia,
  runMux
} from './video.js'

const PRESET_NAMES = Object.keys(PRESETS)
const ACTIONS = ['probe', 'mux', 'cuts', 'extract']

/* ---- helpers (same shape as lib/tools.js) ---- */

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
  if (!Number.isFinite(value)) return '?'
  // Round and re-print, so "3.000" becomes "3" and no trailing-zero regex has to
  // reason about integers ending in zero.
  return String(Number(Number(value).toFixed(digits)))
}

function sizeLabel (bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${JSON.stringify(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${JSON.stringify(value)}`)
  return number
}

function safeStem (path, fallback) {
  const name = basename(String(path), extname(String(path)))
  return name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || fallback
}

/** Format an optional stream summary for the report line. */
function videoLine (media) {
  if (media.video === null || media.video === undefined) return 'no video'
  const fps = media.video.fps === null ? '?fps' : `${fmt(media.video.fps, 3)}fps`
  const frames = media.video.frames === null ? '' : `, ${media.video.frames} frames`
  return `${media.video.codec ?? 'video'} ${media.video.width ?? '?'}x${media.video.height ?? '?'} @${fps}${frames}`
}

function audioLine (media) {
  if (media.audio === null || media.audio === undefined) return 'no audio'
  const channels = media.audio.channels === 2 ? 'stereo' : media.audio.channels === 1 ? 'mono' : `${media.audio.channels ?? '?'}ch`
  const bitrate = media.audio.bitrate === null ? '' : ` ${Math.round(media.audio.bitrate / 1000)} kbps`
  return `${media.audio.codec ?? 'audio'} ${media.audio.sampleRate ?? '?'} Hz ${channels}${bitrate}`
}

/** The shared "what is this file" sentence used by probe and by mux reports. */
function mediaSummaryLine (cwd, path, media) {
  const tracks = [
    `${media.videoTracks} video track(s)`,
    `${media.audioTracks} audio track(s)`
  ].join(', ')
  const duration = media.durationSeconds === null ? 'duration unknown' : `${fmt(media.durationSeconds, 3)}s`
  return `${displayPath(cwd, path)}: ${duration}, ${media.format ?? 'unknown container'}, ${videoLine(media)} · ${audioLine(media)} · ${tracks}`
}

/* ---- audio source resolution ---- */

/** Probe a duration, tolerating files ffprobe cannot read (mux still works). */
async function mediaDuration (path, ffmpegPath) {
  try {
    const media = await probeMedia(path, { ffmpegPath })
    return media.durationSeconds
  } catch {
    return null
  }
}

/**
 * Resolve the `audio` argument: a file on disk, or an inline render spec that is
 * synthesized to a deterministic wav first.
 *
 * Inline specs are finalized exactly like `audio_synth` (DC block, peak at
 * -1 dBFS, soft limit) so `{ preset: 'impact' }` means the same sound here as in
 * every other tool, and the wav is named from the spec hash so two identical
 * requests share one file instead of piling up copies.
 */
async function resolveAudioSource (cwd, audio, ffmpegPath) {
  if (typeof audio === 'string') {
    const path = resolvePath(cwd, audio)
    if (path === undefined) throw new Error('audio_mux: audio path is empty')
    let info
    try {
      info = await stat(path)
    } catch {
      throw new Error(`audio_mux: cannot read audio file ${displayPath(cwd, path)}`)
    }
    if (!info.isFile()) throw new Error(`audio_mux: ${displayPath(cwd, path)} is not a file`)
    return {
      path,
      label: displayPath(cwd, path),
      durationSeconds: await mediaDuration(path, ffmpegPath),
      rendered: false
    }
  }
  if (audio !== null && typeof audio === 'object') {
    const preset = String(audio.preset ?? '')
    if (!PRESET_NAMES.includes(preset)) {
      throw new Error(`audio_mux: audio.preset must be one of ${PRESET_NAMES.join(', ')}`)
    }
    if (audio.duration !== undefined && audio.duration !== null) {
      const duration = readNumber('audio_mux', 'audio.duration', audio.duration)
      if (!(duration > 0)) throw new Error('audio_mux: audio.duration must be a positive number of seconds')
    }
    const spec = {
      preset,
      params: audio.params ?? {},
      duration: audio.duration,
      seed: Number.isFinite(audio.seed) ? Math.round(audio.seed) : 1,
      sampleRate: Number.isFinite(audio.sampleRate) ? Math.round(audio.sampleRate) : 44100,
      loop: audio.loop === true
    }
    const rendered = renderPreset(spec)
    finalize(rendered.samples, rendered.sampleRate, -1, { loop: spec.loop })
    const hash = hashSpec({ purpose: 'mux-audio', ...spec })
    const path = join(cwd, 'assets', 'audio', `mux-audio-${preset}-${hash}.wav`)
    await writeFileAtomic(path, toWavBytes(rendered.samples, rendered.sampleRate))
    return {
      path,
      label: `render ${preset}`,
      durationSeconds: rendered.durationSeconds,
      rendered: true
    }
  }
  throw new Error('audio_mux: audio must be a file path or an inline render spec object ({ preset, params, duration, seed, loop })')
}

/* ---- actions ---- */

/** `action: 'probe'` — what is inside this file. */
async function runProbe (cwd, args) {
  const path = resolvePath(cwd, args.path)
  if (path === undefined) throw new Error('audio_mux: probe needs a file path')
  const media = await probeMedia(path, { ffmpegPath: args.ffmpegPath })
  return {
    ok: true,
    action: 'probe',
    path: media.path,
    relativePath: displayPath(cwd, media.path),
    bytes: media.sizeBytes,
    durationSeconds: media.durationSeconds,
    format: media.format,
    formatLong: media.formatLong,
    video: media.video,
    audio: media.audio,
    videoTracks: media.videoTracks,
    audioTracks: media.audioTracks,
    hasVideo: media.hasVideo,
    hasAudio: media.hasAudio,
    text: `Probed ${mediaSummaryLine(cwd, media.path, media)} (${sizeLabel(media.sizeBytes)})`
  }
}

/** `action: 'mux'` — put the audio onto the picture. */
async function runMuxAction (cwd, args) {
  const video = resolvePath(cwd, args.video)
  if (video === undefined) throw new Error('audio_mux: mux needs a video path')
  const source = await resolveAudioSource(cwd, args.audio, args.ffmpegPath)

  let picture
  try {
    picture = await probeMedia(video, { ffmpegPath: args.ffmpegPath })
  } catch (error) {
    throw new Error(`audio_mux: cannot read the video — ${error.message}`)
  }
  if (picture.hasVideo === false) {
    throw new Error(`audio_mux: ${displayPath(cwd, video)} has no video stream; use audio_mix or audio_convert for audio-only work`)
  }
  if (picture.durationSeconds === null && !(Number(args.durationSeconds) > 0)) {
    throw new Error(`audio_mux: ${displayPath(cwd, video)} has no readable duration; pass durationSeconds so the audio can be trimmed to the shot`)
  }

  const sourceExtension = extname(video).replace(/^\./, '').toLowerCase()
  const extension = CONTAINER_EXTENSIONS.includes(sourceExtension) ? sourceExtension : 'mp4'
  const hash = hashSpec({
    video: displayPath(cwd, video),
    audio: source.rendered ? source.label : displayPath(cwd, source.path),
    mode: args.mode ?? 'replace',
    offset: args.offsetSeconds ?? 0,
    fadeIn: args.fadeInSeconds ?? 0,
    fadeOut: args.fadeOutSeconds ?? 0,
    loop: args.loop === true,
    mixGainDb: args.mixGainDb ?? 0,
    duration: args.durationSeconds ?? picture.durationSeconds
  })
  const requestedOut = resolvePath(cwd, args.out)
  const outputPath = requestedOut ?? join(cwd, 'assets', 'video', `${safeStem(video, 'video')}-${args.mode ?? 'replace'}-${hash}.${extension}`)

  const plan = planMux({
    video,
    audio: source.path,
    mode: args.mode ?? 'replace',
    durationSeconds: args.durationSeconds,
    videoDurationSeconds: picture.durationSeconds,
    videoHasVideo: true,
    videoHasAudio: picture.hasAudio,
    videoCodec: picture.video?.codec ?? null,
    audioDurationSeconds: source.durationSeconds,
    offsetSeconds: args.offsetSeconds,
    fadeInSeconds: args.fadeInSeconds,
    fadeOutSeconds: args.fadeOutSeconds,
    loop: args.loop === true,
    mixGainDb: args.mixGainDb,
    out: outputPath
  })
  const result = await runMux(plan, { ffmpegPath: args.ffmpegPath })

  const notes = plan.estimated.notes.slice()
  for (const warning of result.warnings) notes.push(warning)
  const detail = [
    `${fmt(result.durationSeconds ?? plan.estimated.timelineSeconds, 3)}s`,
    `${result.media?.audioTracks ?? '?'} audio track(s)`,
    result.media === null ? 'output not probed' : audioLine(result.media),
    sizeLabel(result.bytes),
    `mode ${plan.estimated.mode}${plan.estimated.mode !== plan.estimated.requestedMode ? ` (from ${plan.estimated.requestedMode})` : ''}`,
    result.audioPeakDbfs === null ? null : `mix peak ${result.audioPeakDbfs.toFixed(1)} dBFS`,
    plan.estimated.offsetSeconds > 0 ? `offset ${fmt(plan.estimated.offsetSeconds, 3)}s` : null,
    plan.estimated.fadeInSeconds > 0 || plan.estimated.fadeOutSeconds > 0
      ? `fades ${fmt(plan.estimated.fadeInSeconds, 2)}s in / ${fmt(plan.estimated.fadeOutSeconds, 2)}s out`
      : null,
    plan.estimated.loop ? `looped${plan.estimated.repeats === null ? '' : ` ${plan.estimated.repeats}x`}` : null
  ].filter((part) => part !== null)

  return {
    ok: true,
    action: 'mux',
    path: result.outputPath,
    relativePath: displayPath(cwd, result.outputPath),
    bytes: result.bytes,
    durationSeconds: result.durationSeconds,
    mode: plan.estimated.mode,
    audioPath: source.path,
    relativeAudioPath: displayPath(cwd, source.path),
    audioDurationSeconds: source.durationSeconds,
    video: result.media?.video ?? null,
    audio: result.media?.audio ?? null,
    audioTracks: result.media?.audioTracks ?? null,
    audioPeakDbfs: result.audioPeakDbfs,
    measured: result.measured,
    notes,
    command: result.command,
    estimated: plan.estimated,
    text: [
      `Muxed ${source.label} onto ${displayPath(cwd, video)} -> ${displayPath(cwd, result.outputPath)} (${detail.join(', ')})`,
      notes.length > 0 ? `  notes: ${notes.join('; ')}` : null
    ].filter((line) => line !== null).join('\n')
  }
}

/**
 * `action: 'cuts'` — scene changes as `audio_bind` cue times.
 *
 * The cue plan is shaped exactly like `audio_bind`'s `cues` argument (name + at)
 * so it can be pasted in and given a path per cue; the times are the picture's,
 * not the audio's.
 */
async function runCutsAction (cwd, args) {
  const path = resolvePath(cwd, args.path)
  if (path === undefined) throw new Error('audio_mux: cuts needs a video path')
  const result = await detectCuts(path, {
    threshold: args.threshold,
    minSceneSeconds: args.minSceneSeconds,
    ffmpegPath: args.ffmpegPath
  })
  const cues = result.cuts.map((cut, index) => ({ name: `cut-${index + 1}`, at: cut.at }))
  const plan = { cues, durationSeconds: result.durationSeconds }
  const preview = result.cuts.slice(0, 8).map((cut) => `${fmt(cut.at, 3)}s`).join(' · ')
  const more = result.cuts.length > 8 ? ` · … +${result.cuts.length - 8}` : ''
  const how = result.method === 'scene'
    ? `${result.detected} scene change(s) at threshold ${result.threshold}`
    : result.method === 'even'
      ? `no scene change above threshold ${result.threshold}; fell back to evenly spaced anchors every ${result.fallbackSeconds}s`
      : `no scene change above threshold ${result.threshold} and no duration to space anchors by`
  return {
    ok: true,
    action: 'cuts',
    path: result.path,
    relativePath: displayPath(cwd, result.path),
    durationSeconds: result.durationSeconds,
    count: result.count,
    method: result.method,
    detected: result.detected,
    threshold: result.threshold,
    minSceneSeconds: result.minSceneSeconds,
    cuts: result.cuts.slice(0, 64),
    cuePlan: plan,
    text: [
      `Cuts in ${displayPath(cwd, result.path)} (${fmt(result.durationSeconds ?? 0, 3)}s): ${result.count} cut(s) — ${how}`,
      result.cuts.length > 0
        ? `  at ${preview}${more}; audio_bind cues: ${JSON.stringify(plan.cues)} (add a path per cue)`
        : '  no usable cut times; place cues with audio_beats or by hand'
    ].join('\n')
  }
}

/** `action: 'extract'` — the picture's audio as a wav the analysis tools read. */
async function runExtractAction (cwd, args) {
  const path = resolvePath(cwd, args.path)
  if (path === undefined) throw new Error('audio_mux: extract needs a media path')
  const sampleRate = readNumber('audio_mux', 'sampleRate', args.sampleRate)
  const channels = readNumber('audio_mux', 'channels', args.channels)
  if (channels !== undefined && channels !== 1 && channels !== 2) {
    throw new Error('audio_mux: channels must be 1 or 2')
  }
  const hash = hashSpec({
    source: displayPath(cwd, path),
    sampleRate: sampleRate ?? 48000,
    channels: channels ?? 1
  })
  const requestedOut = resolvePath(cwd, args.out)
  const outputPath = requestedOut ?? join(cwd, 'assets', 'audio', `${safeStem(path, 'media')}-audio-${hash}.wav`)
  const extracted = await extractAudio(path, outputPath, {
    sampleRate,
    channels,
    ffmpegPath: args.ffmpegPath
  })
  const track = await readTrack(extracted.outputPath)
  const metrics = { ...measure(track.samples, track.sampleRate), sampleRate: track.sampleRate }
  const notes = []
  if (metrics.clipping > 0) notes.push(`CLIPPING ${metrics.clipping} samples`)
  if (metrics.dcOffset > 0.02) notes.push('DC offset')
  return {
    ok: true,
    action: 'extract',
    path: extracted.outputPath,
    relativePath: displayPath(cwd, extracted.outputPath),
    sourcePath: displayPath(cwd, path),
    bytes: extracted.bytes,
    durationSeconds: metrics.durationSeconds,
    sampleRate: metrics.sampleRate,
    channels: track.channels,
    metrics,
    notes,
    command: extracted.command,
    text: `Extracted the audio of ${displayPath(cwd, path)} -> ${displayPath(cwd, extracted.outputPath)} ` +
      `(${fmt(metrics.durationSeconds, 3)}s, ${metrics.sampleRate} Hz, ${track.channels === 2 ? 'stereo' : 'mono'}, ${sizeLabel(extracted.bytes)}) ` +
      `· peak ${fmt(metrics.peakDbfs, 1)} dBFS · rms ${fmt(metrics.rmsDbfs, 1)} dBFS · crest ${fmt(metrics.crestDb, 1)} dB · onsets ${metrics.onsets}` +
      (notes.length > 0 ? ` · notes: ${notes.join(', ')}` : ' · clean')
  }
}

/* ---- tool ---- */

/** Register `audio_mux` on `ctx.tools`. */
export function registerVideoTools (ctx) {
  ctx.tools.register({
    name: 'audio_mux',
    description: 'Bridge to a video deliverable: probe an mp4/mov/mkv/webm (or any media file), mux a rendered .wav onto it without re-encoding the picture (replace the audio track, mix the new sound under the original, or attach it as a second track, with loop/offset/fades), detect the picture\'s cut times as a ready-to-paste audio_bind cue plan, and extract a video\'s audio to a wav the analysis tools can read. Requires ffmpeg and ffprobe (it explains how to install them when they are missing) and does not analyse what is in the picture — storyboards and transcripts belong to the separate dsh-video-storyboard plugin.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'probe = report the file\'s streams and duration; mux = put audio onto the video; cuts = scene cut times plus an audio_bind cue plan; extract = write the media\'s audio to a wav.'
        },
        path: { type: 'string', description: 'probe/cuts/extract: media file (video or audio), relative to the working directory or absolute.' },
        video: { type: 'string', description: 'mux: the video to keep; its picture is stream-copied, never re-encoded.' },
        audio: {
          anyOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true }
          ],
          description: 'mux: the sound to add — a .wav path, or an inline render spec { preset, params, duration, seed, loop, sampleRate } rendered first (named from its spec hash, finalized like audio_synth).'
        },
        out: { type: 'string', description: 'mux: output path (its extension picks the container: .mp4, .mov, .mkv or .webm); extract: output .wav path. Defaults to assets/video/<stem>-<mode>-<hash>.<ext> and assets/audio/<stem>-audio-<hash>.wav.' },
        mode: {
          type: 'string',
          enum: MUX_MODES,
          description: 'replace = swap the video\'s audio track for the new sound (default); mix = keep the original sound and mix the new one under it; attach = keep the original and add the new sound as a second audio track.'
        },
        offsetSeconds: { type: 'number', description: 'mux: when the new audio starts in the output (seconds, default 0; must be inside the timeline).' },
        fadeInSeconds: { type: 'number', description: 'mux: fade-in length starting at the offset; 0 (default) means no fade.' },
        fadeOutSeconds: { type: 'number', description: 'mux: fade-out length ending at the end of the audio timeline; 0 (default) means no fade.' },
        loop: { type: 'boolean', description: 'mux: repeat the audio to fill the timeline instead of padding it with silence (useful for a 0.4 s cue over a 3 s shot).' },
        mixGainDb: { type: 'number', description: 'mux (mix mode only): level trim on the new audio in dB, e.g. -6 to sit it under dialogue. Defaults to 0.' },
        durationSeconds: { type: 'number', description: 'mux: audio timeline length; defaults to the video duration and is clamped to it. The picture itself is never shortened.' },
        threshold: { type: 'number', description: 'cuts: scene-change threshold 0.01..0.99; lower finds more (and softer) changes. Defaults to 0.35.' },
        minSceneSeconds: { type: 'number', description: 'cuts: two detections closer than this are treated as one cut (a flash, a dissolve). Defaults to 0.4.' },
        sampleRate: { type: 'integer', description: 'extract: wav sample rate (default 48000); mux: rate of the muxed track (default 48000).' },
        channels: { type: 'integer', enum: [1, 2], description: 'extract: 1 = mono (default), 2 = keep stereo.' },
        ffmpegPath: { type: 'string', description: 'Optional explicit ffmpeg binary. Defaults to auto-detection: the DSH bundled ffmpeg (~/.dsh/tools/ffmpeg/bin), then PATH.' }
      },
      required: ['action'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'mux'
        ? `Mux audio onto ${typeof args.video === 'string' ? basename(args.video) : 'video'}`
        : args.action === 'cuts'
          ? 'Detect picture cuts'
          : args.action === 'extract'
            ? 'Extract audio'
            : 'Probe media',
      kind: 'other',
      rawInput: {
        action: args.action,
        path: args.path,
        video: args.video,
        audio: typeof args.audio === 'string' ? args.audio : (args.audio?.preset ?? undefined),
        mode: args.mode
      }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const action = String(args.action ?? '')
      if (!ACTIONS.includes(action)) {
        throw new Error(`audio_mux: action must be one of ${ACTIONS.join(' | ')}, got ${JSON.stringify(args.action ?? null)}`)
      }
      if (args.mode !== undefined && args.mode !== null && !MUX_MODES.includes(String(args.mode))) {
        throw new Error(`audio_mux: mode must be one of ${MUX_MODES.join(' | ')}, got ${JSON.stringify(args.mode)}`)
      }
      for (const key of ['offsetSeconds', 'fadeInSeconds', 'fadeOutSeconds', 'durationSeconds', 'mixGainDb', 'threshold', 'minSceneSeconds', 'sampleRate', 'channels']) {
        readNumber('audio_mux', key, args[key])
      }
      if (args.threshold !== undefined && args.threshold !== null) {
        const threshold = Number(args.threshold)
        if (!(threshold > 0 && threshold < 1)) throw new Error('audio_mux: threshold must be between 0 and 1 (exclusive)')
      }
      if (args.minSceneSeconds !== undefined && args.minSceneSeconds !== null) {
        const gap = Number(args.minSceneSeconds)
        if (!(gap > 0)) throw new Error('audio_mux: minSceneSeconds must be greater than 0')
      }
      if (args.durationSeconds !== undefined && args.durationSeconds !== null) {
        const duration = Number(args.durationSeconds)
        if (!(duration >= 0.02 && duration <= MEDIA_LIMITS.maxTimelineSeconds)) {
          throw new Error(`audio_mux: durationSeconds must be between 0.02 and ${MEDIA_LIMITS.maxTimelineSeconds}`)
        }
      }

      if (action === 'probe') return await runProbe(cwd, args)
      if (action === 'cuts') return await runCutsAction(cwd, args)
      if (action === 'extract') return await runExtractAction(cwd, args)
      return await runMuxAction(cwd, args)
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
