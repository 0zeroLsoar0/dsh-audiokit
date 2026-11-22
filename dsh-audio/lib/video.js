/**
 * Video bridge: probe a media file, mux a rendered soundtrack onto a video, and
 * read the timing of the picture back.
 *
 * Why this file exists: every other module in this plugin produces a `.wav`,
 * but the deliverable is usually a video. Two jobs are neither synthesis nor
 * measurement and do not belong in lib/audio.js:
 *
 *  1. Put a wav onto an mp4/mov/mkv/webm without re-encoding the picture
 *     (`planMux` builds the ffmpeg invocation, `runMux` executes it), with the
 *     cue looped/padded/trimmed to the shot, offset, faded, and optionally mixed
 *     under the original sound.
 *  2. Read the picture's timing: `probeMedia` for the facts a mux needs, and
 *     `detectCuts` for the scene changes an `audio_bind` cue sheet can land on.
 *     `extractAudio` pulls the soundtrack out to a wav so the rest of the plugin
 *     (`measure`, `audio_beats`, `audio_lipsync`) can analyse a video's audio.
 *
 * Boundary that matters for the product: this module deliberately does NOT
 * analyse what is *in* the picture — shots, faces, speech, transcripts. The
 * separate `dsh-video-storyboard` plugin already owns storyboard/transcript
 * analysis; reimplementing it here would duplicate that capability and drift
 * from it. Scene detection is used only as a *timing* source for cue placement.
 *
 * ffmpeg and ffprobe are external binaries, not package dependencies (the plugin
 * stays installable with no network). Discovery reuses `findFfmpeg` from
 * lib/providers-edge.js so the plugin has exactly one ffmpeg discovery
 * implementation; `findFfprobe` mirrors the same order for the probe binary.
 * A binary is only accepted after `-version` actually runs, because a stale
 * Windows Store alias or a half-deleted install otherwise fails mid-mux.
 *
 * A note on the filter graph, since the ordering is the whole contract:
 *   normalize (aformat 48 kHz stereo) -> trim to the timeline -> delay by
 *   `offsetSeconds` (adelay) -> pad with silence (apad) -> trim to the timeline
 *   again -> fade in at the offset -> fade out before the end
 * That order is what makes "the cue starts at 0.5 s" true after encoding, and it
 * is what keeps a looped cue from running past the video's last frame.
 */

import { execFile, execFileSync } from 'node:child_process'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { findFfmpeg as findFfmpegCached } from './providers-edge.js'

/* ---- limits and defaults ---- */

/**
 * Hard limits for the media operations.
 *
 * They exist so a bad number in a tool call fails with a sentence instead of
 * producing a 40 GB intermediate: `durationSeconds` becomes the `atrim`/`apad`
 * bound of the filter graph, and `offsetSeconds` becomes an `adelay` in
 * milliseconds.
 */
export const MEDIA_LIMITS = Object.freeze({
  maxTimelineSeconds: 3600,
  maxOffsetSeconds: 3600,
  maxFadeSeconds: 60,
  minSampleRate: 8000,
  maxSampleRate: 96000,
  defaultTimeoutMs: 120000,
  defaultProbeTimeoutMs: 20000,
  /** Scene-detection threshold; lower finds more (and softer) changes. */
  defaultCutThreshold: 0.35,
  /** Two detected cuts closer than this are one cut (a flash, a dissolve). */
  defaultMinSceneSeconds: 0.4,
  /** Spacing used when scene detection finds nothing at all. */
  defaultFallbackSeconds: 2
})

/** The three ways a new audio track can relate to the video's own sound. */
export const MUX_MODES = Object.freeze(['replace', 'mix', 'attach'])

/** Containers this module can write, in the order a picker should show them. */
export const CONTAINER_EXTENSIONS = Object.freeze(['mp4', 'mov', 'mkv', 'webm'])

/** Container rules: which audio codec fits, and whether mp4 needs faststart. */
const CONTAINERS = Object.freeze({
  mp4: { name: 'mp4', audioCodec: 'aac', audioBitrate: '192k', faststart: true },
  m4v: { name: 'mp4', audioCodec: 'aac', audioBitrate: '192k', faststart: true },
  mov: { name: 'mov', audioCodec: 'aac', audioBitrate: '192k', faststart: true },
  mkv: { name: 'matroska', audioCodec: 'aac', audioBitrate: '192k', faststart: false },
  webm: { name: 'webm', audioCodec: 'libopus', audioBitrate: '160k', faststart: false }
})

/** Video codecs a WebM container can hold when the picture is stream-copied. */
const WEBM_VIDEO_CODECS = Object.freeze(['vp8', 'vp9', 'av1'])

/** The DSH bundled tools directory; same layout as lib/providers-edge.js. */
const BUNDLED_TOOLS_DIR = join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin')

/** ffprobe discovery cache, keyed the same way as the ffmpeg cache. */
const PROBE_CACHE = new Map()

/* ---- small helpers ---- */

/** Trim a numeric option to a fixed 3-decimal string, so commands are stable. */
function secondsText (value) {
  return String(Number(Number(value).toFixed(3)))
}

/** A signed 32-bit exit code, because Windows reports ffmpeg's AVERROR unsigned. */
function signedExitCode (code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null
  return code > 0x7FFFFFFF ? code - 0x100000000 : code
}

/** Last non-empty stderr lines, as a single line for an error message. */
function tailText (stderr, count = 4, limit = 600) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const tail = lines.slice(-count).join(' | ')
  return tail.length > limit ? `…${tail.slice(-limit)}` : tail
}

/** Quote one argv element for display only; never used to build the command. */
function quoteArg (arg) {
  const text = String(arg)
  return /[\s"']/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

/** Render a readable command line from a binary and argv (display only). */
function formatCommand (binary, args) {
  return [binary, ...args].map(quoteArg).join(' ')
}

/** Validate a required path argument and name the caller when it is missing. */
function requiredPath (caller, key, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${caller}: ${key} is required (a file path)`)
  return text
}

/**
 * Read an optional seconds argument.
 * @returns {number|null} the value, or null when it was not supplied.
 */
function optionalSeconds (caller, key, value, min, max) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${caller}: ${key} must be a finite number of seconds, got ${String(value)}`)
  if (number < min || number > max) throw new Error(`${caller}: ${key} must be between ${min} and ${max} seconds, got ${number}`)
  return number
}

/** Read an optional integer argument, clamped into a range. */
function optionalInteger (caller, key, value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${caller}: ${key} must be a number, got ${String(value)}`)
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** True when a value is a usable absolute/relative path string. */
function pathText (value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Execute a binary and capture both streams.
 *
 * Every ffmpeg/ffprobe call in this module goes through here so timeout, stderr
 * capture and exit-code normalisation are identical everywhere. stdout is not
 * streamed to the caller: ffmpeg writes media to a file and its diagnostics go
 * to stderr, and the one command that prints to stdout (`-f null -`) prints
 * nothing we need.
 * @param {string} binary - absolute path to ffmpeg/ffprobe.
 * @param {string[]} args - argv, without the program name.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, elapsedMs: number }>}
 */
function runProcess (binary, args, options = {}) {
  const timeoutMs = optionalInteger('runProcess', 'timeoutMs', options.timeoutMs, MEDIA_LIMITS.defaultTimeoutMs, 1000, 3600000)
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error === null || error === undefined) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', elapsedMs: Date.now() - startedAt })
        return
      }
      const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT'
      // A spawn failure (`ENOENT` after deleting the binary, `EACCES` on a
      // locked one) has no exit code; report it as "could not start" instead of
      // "exited ?", which reads like a media problem.
      const spawnCode = !timedOut && typeof error.code === 'string' ? error.code : null
      const failure = new Error(timedOut
        ? `${basename(binary)} timed out after ${timeoutMs} ms`
        : spawnCode !== null
          ? `${basename(binary)} could not be started (${spawnCode})`
          : `${basename(binary)} exited ${signedExitCode(error.code) ?? error.code ?? '?'}`)
      failure.code = timedOut ? 'TIMEOUT' : 'PROCESS_FAILED'
      failure.exitCode = spawnCode === null ? signedExitCode(error.code) : null
      failure.spawnCode = spawnCode
      failure.signal = error.signal ?? null
      failure.stderr = stderr ?? ''
      failure.command = formatCommand(binary, args)
      failure.elapsedMs = Date.now() - startedAt
      reject(failure)
    })
  })
}

/**
 * Turn a failed process into an error that names the operation and quotes the
 * tool's own last words, which is what makes "mux failed" actionable.
 */
function processError (label, failure, hint = '') {
  const tail = tailText(failure?.stderr)
  const reason = failure?.code === 'TIMEOUT'
    ? failure.message
    : failure?.spawnCode !== undefined && failure.spawnCode !== null
      ? failure.spawnCode
      : `exit ${failure?.exitCode ?? '?'}`
  const detail = tail === '' ? `(${failure?.message ?? 'no stderr'})` : `: ${tail}`
  const suffix = hint === '' ? '' : ` — ${hint}`
  const error = new Error(`${label} failed (ffmpeg ${reason})${detail}${suffix}`)
  error.code = failure?.code === 'TIMEOUT' ? 'TIMEOUT' : label.includes('probe') ? 'PROBE_FAILED' : 'PROCESS_FAILED'
  error.stderr = failure?.stderr ?? ''
  error.command = failure?.command ?? ''
  return error
}

/* ---- binary discovery ---- */

/**
 * Find an ffmpeg binary.
 *
 * Order: explicit `ffmpegPath` → DSH's bundled ffmpeg → PATH → null. The
 * discovery itself lives in lib/providers-edge.js (which needs it to decode
 * Edge TTS audio), so this is a thin, documented re-export that adds no second
 * implementation — and reuses its per-process cache, so probing never spawns a
 * process more than once.
 * @param {{ ffmpegPath?: string }} [options] - explicit binary to use or reject.
 * @returns {string|null} a command that successfully ran `-version`, or null.
 */
export function findFfmpeg (options = {}) {
  return findFfmpegCached({ ffmpegPath: pathText(options.ffmpegPath) ?? '' })
}

/**
 * True when `candidate` runs `-version` and looks like the tool it claims to be.
 * The version output is checked as well as the exit code because a wrapper or a
 * Windows Store stub can exit 0 without being ffmpeg/ffprobe.
 */
function usableBinary (candidate, expectedName) {
  const text = pathText(candidate)
  if (text === null) return null
  try {
    const output = execFileVersion(text)
    if (!/version/i.test(output) || !output.toLowerCase().includes(expectedName)) return null
    return text
  } catch {
    return null
  }
}

/** Synchronous `-version` probe; discovery runs once per process, so this is fine. */
function execFileVersion (binary) {
  // Deliberately synchronous: execFileSync keeps discovery's answer cacheable in
  // a single expression and matches lib/providers-edge.js, which validates the
  // ffmpeg binary the same way.
  return execFileSync(binary, ['-version'], { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString('utf8')
}

/** Ask the OS which binary would run from PATH (`where` / `which`). */
function locateOnPath (name) {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(command, [name], { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString('utf8')
    for (const line of output.split(/\r?\n/)) {
      const found = usableBinary(line, name)
      if (found !== null) return found
    }
  } catch { /* not on PATH */ }
  return null
}

/** The ffprobe filename for this platform. */
function probeBinaryName () {
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
}

/**
 * Find an ffprobe binary for `probeMedia`.
 *
 * Order: explicit `ffprobePath` → a sibling of an explicit `ffmpegPath` (a
 * custom install keeps both binaries together) → DSH's bundled ffprobe → PATH →
 * null. Cached per process, and only accepted after `-version` runs.
 * @param {{ ffmpegPath?: string, ffprobePath?: string }} [options]
 * @returns {string|null} a command that successfully ran `-version`, or null.
 */
export function findFfprobe (options = {}) {
  const explicit = pathText(options.ffprobePath)
  const ffmpegPath = pathText(options.ffmpegPath)
  const key = `${explicit ?? ''}|${ffmpegPath ?? ''}`
  if (PROBE_CACHE.has(key)) return PROBE_CACHE.get(key)

  let found = null
  if (explicit !== null) {
    found = usableBinary(explicit, 'ffprobe')
  } else {
    if (ffmpegPath !== null) {
      const sibling = join(dirname(ffmpegPath), probeBinaryName())
      found = usableBinary(sibling, 'ffprobe')
    }
    if (found === null) found = usableBinary(join(BUNDLED_TOOLS_DIR, probeBinaryName()), 'ffprobe')
    if (found === null) found = locateOnPath('ffprobe')
  }
  PROBE_CACHE.set(key, found)
  return found
}

/**
 * The sentence a tool returns when the binary is genuinely absent.
 *
 * Written as instructions instead of "not supported" because the caller cannot
 * fix a missing binary by retrying the same call.
 * @param {'ffmpeg'|'ffprobe'} [which] - the missing binary.
 * @returns {string} one paragraph naming every location checked and the fix.
 */
export function ffmpegInstallHint (which = 'ffmpeg') {
  const windows = process.platform === 'win32'
  const install = windows
    ? 'winget install --id Gyan.FFmpeg -e (or download a static build from ffmpeg.org)'
    : 'brew install ffmpeg (macOS) or apt install ffmpeg (Debian/Ubuntu)'
  return `${which} was not found, so no media can be read or muxed. ` +
    'Checked: an explicit path, the DSH bundled directory ' +
    `${BUNDLED_TOOLS_DIR}, and PATH. Fix it by installing ffmpeg (${install}) ` +
    'and placing ffmpeg + ffprobe there, or by passing ffmpegPath.'
}

/** The ffprobe binary or a precise error; `null` never reaches a command line. */
function requireFfprobe (options = {}) {
  const found = findFfprobe({ ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath })
  if (found !== null) return found
  const error = new Error(ffmpegInstallHint('ffprobe'))
  error.code = 'FFPROBE_NOT_FOUND'
  throw error
}

/** The ffmpeg binary or a precise error. */
function requireFfmpeg (options = {}) {
  const found = findFfmpeg({ ffmpegPath: options.ffmpegPath })
  if (found !== null) return found
  const error = new Error(ffmpegInstallHint('ffmpeg'))
  error.code = 'FFMPEG_NOT_FOUND'
  throw error
}

/* ---- probing ---- */

/** Parse an ffprobe rational rate ("30000/1001", "25/1", "0/0") into a number. */
function parseRate (text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? '').trim())
  if (match === null) {
    const plain = Number(text)
    return Number.isFinite(plain) && plain > 0 ? plain : null
  }
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!(numerator > 0) || !(denominator > 0)) return null
  return numerator / denominator
}

/** Round to 3 decimals without ever producing -0. */
function round3 (value) {
  const rounded = Number(Number(value).toFixed(3))
  return Object.is(rounded, -0) ? 0 : rounded
}

/** A finite number from an ffprobe string field, or null. */
function numberOrNull (value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Summarize one video stream.
 * @returns {{ codec: string|null, width: number|null, height: number|null,
 *   fps: number|null, frames: number|null, durationSeconds: number|null,
 *   bitrate: number|null }}
 */
function summarizeVideo (stream, containerSeconds) {
  const fps = parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate)
  const duration = numberOrNull(stream.duration) ?? containerSeconds
  const declaredFrames = numberOrNull(stream.nb_frames)
  const frames = declaredFrames !== null && declaredFrames > 0
    ? Math.round(declaredFrames)
    : (fps !== null && duration !== null ? Math.round(fps * duration) : null)
  return {
    codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
    width: numberOrNull(stream.width),
    height: numberOrNull(stream.height),
    fps: fps === null ? null : round3(fps),
    frames,
    durationSeconds: duration === null ? null : round3(duration),
    bitrate: numberOrNull(stream.bit_rate)
  }
}

/**
 * Summarize one audio stream.
 * @returns {{ codec: string|null, sampleRate: number|null, channels: number|null,
 *   bitrate: number|null, durationSeconds: number|null }}
 */
function summarizeAudio (stream, containerSeconds) {
  const bitrate = numberOrNull(stream.bit_rate)
  const duration = numberOrNull(stream.duration) ?? containerSeconds
  return {
    codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
    sampleRate: numberOrNull(stream.sample_rate),
    channels: numberOrNull(stream.channels),
    // A stream bit_rate is often absent (mkv/webm); null is honest, while a
    // container share would silently include the picture's bytes.
    bitrate: bitrate === null ? null : Math.round(bitrate),
    durationSeconds: duration === null ? null : round3(duration)
  }
}

/**
 * Read a media file's facts with ffprobe.
 *
 * This is what a mux needs to plan (duration, whether the video already has
 * sound) and what a report should state (codecs, fps, stream count). It also
 * works on audio-only files, which is how `audio_mux action=probe` answers
 * questions about a wav/mp3 too.
 * @param {string} path - media file; relative paths resolve against the process
 *   working directory (tools pass an absolute path from the session cwd).
 * @param {{ ffmpegPath?: string, ffprobePath?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   path: string, durationSeconds: number|null, format: string|null,
 *   formatLong: string|null, sizeBytes: number|null, bitrateBps: number|null,
 *   video: object|null, audio: object|null, videoTracks: number,
 *   audioTracks: number, hasVideo: boolean, hasAudio: boolean
 * }>}
 * @throws when the file is missing or ffprobe cannot parse it; the message says
 *   which of the two happened.
 */
export async function probeMedia (path, options = {}) {
  const target = requiredPath('probeMedia', 'path', path)
  const absolute = isAbsolute(target) ? target : resolve(target)
  const ffprobe = requireFfprobe(options)

  let info
  try {
    const stats = await stat(absolute)
    if (!stats.isFile()) {
      const error = new Error(`probeMedia: ${absolute} is not a file`)
      error.code = 'MEDIA_NOT_FOUND'
      throw error
    }
    info = stats
  } catch (error) {
    if (error?.code === 'MEDIA_NOT_FOUND') throw error
    const wrapped = new Error(`probeMedia: media file not found: ${absolute}`)
    wrapped.code = 'MEDIA_NOT_FOUND'
    throw wrapped
  }

  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', absolute]
  let result
  try {
    result = await runProcess(ffprobe, args, { timeoutMs: options.timeoutMs ?? MEDIA_LIMITS.defaultProbeTimeoutMs })
  } catch (error) {
    throw processError(`probeMedia (${basename(absolute)})`, error, 'the file may be corrupt or not media at all')
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    // ffprobe exiting 0 with unparseable output is a tool-version problem, not a
    // media problem; say which so a missing `-of json` support is diagnosable.
    const wrapped = new Error(`probeMedia: ffprobe returned JSON this module cannot read (${String(error?.message ?? error)})`)
    wrapped.code = 'PROBE_FAILED'
    throw wrapped
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
  const container = parsed?.format ?? {}
  const videoStreams = streams.filter((stream) => stream?.codec_type === 'video' && stream?.disposition?.attached_pic !== 1)
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio')
  const containerSeconds = numberOrNull(container.duration)

  // The container duration is authoritative for a mux plan; when it is missing
  // (some webm/ogg files), the longest stream is the best available answer.
  const streamSeconds = streams
    .map((stream) => numberOrNull(stream?.duration))
    .filter((value) => value !== null)
  const durationSeconds = containerSeconds ?? (streamSeconds.length > 0 ? Math.max(...streamSeconds) : null)

  const containerBitrate = numberOrNull(container.bit_rate)
  return {
    path: absolute,
    durationSeconds: durationSeconds === null ? null : round3(durationSeconds),
    format: typeof container.format_name === 'string' ? container.format_name : null,
    formatLong: typeof container.format_long_name === 'string' ? container.format_long_name : null,
    sizeBytes: numberOrNull(container.size) ?? info.size ?? null,
    bitrateBps: containerBitrate === null ? null : Math.round(containerBitrate),
    video: videoStreams.length === 0 ? null : summarizeVideo(videoStreams[0], durationSeconds),
    audio: audioStreams.length === 0 ? null : summarizeAudio(audioStreams[0], durationSeconds),
    videoTracks: videoStreams.length,
    audioTracks: audioStreams.length,
    hasVideo: videoStreams.length > 0,
    hasAudio: audioStreams.length > 0
  }
}

/* ---- mux planning ---- */

/** Pick the container rules from the output extension. */
function containerFor (outputPath, videoCodec) {
  const extension = extname(String(outputPath ?? '')).replace(/^\./, '').toLowerCase()
  const container = CONTAINERS[extension]
  if (container === undefined) {
    throw new Error(
      `planMux: unsupported output container "${extension === '' ? '(no extension)' : extension}"; ` +
      'use .mp4, .mov, .mkv or .webm'
    )
  }
  if (container.name === 'webm' && typeof videoCodec === 'string' && videoCodec !== '' && !WEBM_VIDEO_CODECS.includes(videoCodec)) {
    throw new Error(
      `planMux: a ${videoCodec} picture cannot be stream-copied into WebM (WebM holds ${WEBM_VIDEO_CODECS.join('/')}); ` +
      'write .mp4 or .mkv instead of renaming the track'
    )
  }
  return container
}

/**
 * Validate a mux mode and degrade `attach` to `replace` when there is no
 * original track to attach beside. Returns the effective mode plus a note.
 */
function resolveMode (requested, videoHasAudio) {
  const mode = requested === undefined || requested === null ? 'replace' : String(requested)
  if (!MUX_MODES.includes(mode)) {
    throw new Error(`planMux: mode must be one of ${MUX_MODES.join(' | ')}, got "${mode}"`)
  }
  if (mode === 'attach' && videoHasAudio === false) {
    return { mode: 'replace', notes: ['attach needs an original audio track; the video has none, so the new track replaced it'] }
  }
  return { mode, notes: [] }
}

/** The timeline a mux is built to: explicit duration, else the video's length. */
function resolveTimeline (durationSeconds, videoDurationSeconds, notes) {
  if (durationSeconds !== null && videoDurationSeconds !== null && durationSeconds > videoDurationSeconds + 0.001) {
    notes.push(`durationSeconds ${secondsText(durationSeconds)}s is longer than the video (${secondsText(videoDurationSeconds)}s), so the output ends with the picture`)
  }
  const timeline = durationSeconds !== null && videoDurationSeconds !== null
    ? Math.min(durationSeconds, videoDurationSeconds)
    : (durationSeconds ?? videoDurationSeconds)
  if (timeline === null) {
    throw new Error('planMux: needs durationSeconds or videoDurationSeconds to know how long the output should be (probe the video first)')
  }
  if (!(timeline > 0.02)) throw new Error(`planMux: the timeline is ${secondsText(timeline)}s, too short to mux`)
  return timeline
}

/**
 * Build the ffmpeg invocation that puts `audio` onto `video`.
 *
 * The result is data, not a side effect: `runMux` is what executes it, so a
 * caller (or the tool layer) can validate the plan, show the command, or run it
 * with a different binary. The argument list stops *before* the output path on
 * purpose — only the caller knows where the deliverable goes — and `command`
 * shows `<out>` where that path will be appended.
 *
 * What the filter graph does, in order (see the file header for why):
 *   - normalize the new audio to 48 kHz stereo (`aformat`); ffmpeg's mono→stereo
 *     matrix is power-preserving (-3.01 dB per channel), so a mono cue keeps its
 *     loudness when the stereo track is played back and cannot clip its channels;
 *   - trim it to the timeline, so a long cue cannot outlive the picture;
 *   - delay it by `offsetSeconds` with `adelay`;
 *   - pad with `apad` and trim again, so a short cue still fills the timeline;
 *   - fade in at the offset and out before the end with `afade`;
 *   - `mix` mode sums it under the original with `amix` (`normalize=0`, so the
 *     original keeps its level) and an optional `mixGainDb` on the new track;
 *   - `attach` mode maps it as a second audio track and leaves the original.
 *
 * `loop: true` implies the audio input is opened with `-stream_loop -1`, so a
 * 0.4 s cue repeats across the whole shot instead of leaving silence.
 *
 * The picture is never shortened by this function: `durationSeconds` bounds the
 * audio timeline (default: the video's duration) and the filter graph pads or
 * trims the new track to it. In `replace` mode an audio timeline shorter than
 * the video therefore leaves the tail silent rather than cutting the shot.
 * @param {object} request
 * @param {string} request.video - video to keep (picture is always stream-copied).
 * @param {string} request.audio - audio file to add.
 * @param {'replace'|'mix'|'attach'} [request.mode='replace']
 * @param {number} [request.durationSeconds] - audio timeline length; defaults to
 *   the video's duration and is clamped to it.
 * @param {number} [request.offsetSeconds=0] - when the new audio starts.
 * @param {number} [request.fadeInSeconds=0] / @param {number} [request.fadeOutSeconds=0]
 * @param {boolean} [request.loop=false] - repeat the audio to fill the timeline.
 * @param {number} [request.mixGainDb=0] - level trim on the new track in mix mode.
 * @param {number} [request.sampleRate=48000] - rate of the new audio track.
 * @param {string} [request.out] - output path (its extension picks the container).
 * @param {number} [request.videoDurationSeconds] - probe result; required when
 *   `durationSeconds` is omitted.
 * @param {boolean} [request.videoHasAudio] - probe result; required for `mix`
 *   and used to degrade `attach`.
 * @param {string} [request.videoCodec] - probe result; validated for WebM.
 * @param {number} [request.audioDurationSeconds] - probe result; improves the
 *   pad/trim/repeat numbers in `estimated`.
 * @returns {{
 *   args: string[], command: string, container: string, audioCodec: string,
 *   outputExtension: string, outputPath: string|null, inputs: object,
 *   filterGraph: string, audioLabel: string,
 *   estimated: { mode: string, requestedMode: string, timelineSeconds: number,
 *     audioStartSeconds: number, audioEndSeconds: number, fadeInSeconds: number,
 *     fadeOutSeconds: number, loop: boolean, mixGainDb: number, sampleRate: number,
 *     channels: number, repeated: boolean, padSeconds: number|null,
 *     trimSeconds: number|null, notes: string[] }
 * }}
 * @throws when a path, mode, container, offset or fade is meaningless.
 */
export function planMux (request = {}) {
  const caller = 'planMux'
  const video = requiredPath(caller, 'video', request.video)
  const audio = requiredPath(caller, 'audio', request.audio)
  const notes = []

  const videoHasAudio = request.videoHasAudio === undefined || request.videoHasAudio === null
    ? null
    : request.videoHasAudio === true
  if (request.videoHasVideo === false) {
    throw new Error(`${caller}: ${basename(video)} has no video stream; use audio_mix/audio_convert for audio-only work`)
  }

  const requestedMode = request.mode === undefined || request.mode === null ? 'replace' : String(request.mode)
  const resolvedMode = resolveMode(requestedMode, videoHasAudio)
  const mode = resolvedMode.mode
  notes.push(...resolvedMode.notes)
  if (mode === 'mix' && videoHasAudio === null) {
    notes.push('the video was not probed for an original audio track; if it has none, use mode replace')
  }

  const durationSeconds = optionalSeconds(caller, 'durationSeconds', request.durationSeconds, 0.02, MEDIA_LIMITS.maxTimelineSeconds)
  const videoDurationSeconds = optionalSeconds(caller, 'videoDurationSeconds', request.videoDurationSeconds, 0, MEDIA_LIMITS.maxTimelineSeconds)
  const timeline = resolveTimeline(durationSeconds, videoDurationSeconds, notes)

  const offsetSeconds = optionalSeconds(caller, 'offsetSeconds', request.offsetSeconds, 0, MEDIA_LIMITS.maxOffsetSeconds) ?? 0
  if (offsetSeconds >= timeline) {
    throw new Error(`${caller}: offsetSeconds ${secondsText(offsetSeconds)}s is not inside the ${secondsText(timeline)}s timeline; the audio would never be heard`)
  }
  let fadeInSeconds = optionalSeconds(caller, 'fadeInSeconds', request.fadeInSeconds, 0, MEDIA_LIMITS.maxFadeSeconds) ?? 0
  let fadeOutSeconds = optionalSeconds(caller, 'fadeOutSeconds', request.fadeOutSeconds, 0, MEDIA_LIMITS.maxFadeSeconds) ?? 0
  // A fade longer than the space it has would silently never finish; report the
  // values that will actually be applied instead of pretending they were used.
  if (fadeInSeconds > timeline - offsetSeconds) {
    notes.push(`fadeInSeconds ${secondsText(fadeInSeconds)}s clamped to ${secondsText(timeline - offsetSeconds)}s (the audio only starts at ${secondsText(offsetSeconds)}s)`)
    fadeInSeconds = Number((timeline - offsetSeconds).toFixed(3))
  }
  if (fadeOutSeconds > timeline) {
    notes.push(`fadeOutSeconds ${secondsText(fadeOutSeconds)}s clamped to the ${secondsText(timeline)}s timeline`)
    fadeOutSeconds = Number(timeline.toFixed(3))
  }
  const fadeRoom = Math.max(0, timeline - offsetSeconds)
  if (fadeInSeconds + fadeOutSeconds > fadeRoom && fadeInSeconds > 0 && fadeOutSeconds > 0) {
    notes.push(`the fades (${secondsText(fadeInSeconds)}s in + ${secondsText(fadeOutSeconds)}s out) overlap; both are applied and the later one wins`)
  }

  const loop = request.loop === true
  let mixGainDb = 0
  if (request.mixGainDb !== undefined && request.mixGainDb !== null) {
    mixGainDb = Number(request.mixGainDb)
    if (!Number.isFinite(mixGainDb)) {
      throw new Error(`${caller}: mixGainDb must be a finite number of dB, got ${String(request.mixGainDb)}`)
    }
    mixGainDb = Math.min(24, Math.max(-60, mixGainDb))
  }

  const outputPath = pathText(request.out)
  const container = containerFor(outputPath ?? video, request.videoCodec)
  let sampleRate = optionalInteger(caller, 'sampleRate', request.sampleRate, 48000, MEDIA_LIMITS.minSampleRate, MEDIA_LIMITS.maxSampleRate)
  // libopus accepts 48/24/16/12/8 kHz only; anything else would be resampled by
  // the encoder in a second, invisible stage. Say so instead.
  if (container.name === 'webm' && sampleRate !== 48000) {
    notes.push(`WebM/Opus needs 48 kHz; sampleRate ${sampleRate} Hz was replaced with 48000`)
    sampleRate = 48000
  }

  // How the cue fills the timeline. `room` is the space after the offset; a
  // looped cue repeats until `atrim` cuts it, anything else is padded or cut.
  const audioDurationSeconds = optionalSeconds(caller, 'audioDurationSeconds', request.audioDurationSeconds, 0, MEDIA_LIMITS.maxTimelineSeconds)
  const room = Math.max(0, Number((timeline - offsetSeconds).toFixed(3)))
  const repeats = audioDurationSeconds !== null && audioDurationSeconds > 0 && loop
    ? Math.max(1, Math.ceil(room / audioDurationSeconds))
    : (loop ? 1 : null)
  const repeatsNeeded = repeats !== null && repeats > 1
  const padSeconds = audioDurationSeconds === null
    ? null
    : Math.max(0, Number((room - (repeatsNeeded ? room : audioDurationSeconds)).toFixed(3)))
  const trimSeconds = audioDurationSeconds === null
    ? null
    : repeatsNeeded
      ? 0
      : Math.max(0, Number((audioDurationSeconds - room).toFixed(3)))
  const audioSpan = repeatsNeeded ? room : Math.min(room, audioDurationSeconds ?? room)

  const total = secondsText(timeline)
  const offsetMs = Math.round(offsetSeconds * 1000)
  // A filterchain is `filter,filter,filter[label]`: the output label binds to the
  // last filter directly, so it must not be comma-joined with the filters.
  const chainFilters = [
    `[1:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`,
    `atrim=0:${total}`,
    'asetpts=PTS-STARTPTS',
    offsetMs > 0 ? `adelay=${offsetMs}:all=1` : null,
    'apad',
    `atrim=0:${total}`,
    fadeInSeconds > 0 ? `afade=t=in:st=${secondsText(offsetSeconds)}:d=${secondsText(fadeInSeconds)}` : null,
    fadeOutSeconds > 0 ? `afade=t=out:st=${secondsText(timeline - fadeOutSeconds)}:d=${secondsText(fadeOutSeconds)}` : null,
    mode === 'mix' && mixGainDb !== 0 ? `volume=${secondsText(mixGainDb)}dB` : null
  ].filter((part) => part !== null).join(',')
  const chain = `${chainFilters}[muxa]`

  const graphParts = [chain]
  let audioLabel = '[muxa]'
  if (mode === 'mix') {
    graphParts.push(`[0:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=0:${total}[origa]`)
    graphParts.push('[origa][muxa]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[muxed]')
    audioLabel = '[muxed]'
  }
  const filterGraph = graphParts.join(';')

  const mapArgs = ['-map', '0:v:0']
  if (mode === 'attach') mapArgs.push('-map', '0:a:0')
  mapArgs.push('-map', audioLabel)

  const codecArgs = ['-c:v', 'copy']
  if (mode === 'attach') {
    codecArgs.push('-c:a:0', 'copy', '-c:a:1', container.audioCodec, '-b:a:1', container.audioBitrate)
    codecArgs.push('-metadata:s:a:1', 'title=dsh-audio')
  } else {
    codecArgs.push('-c:a', container.audioCodec, '-b:a', container.audioBitrate)
  }

  // `-shortest` may only be used where it cannot truncate something real: an
  // attach copy loses its last packet to it, and an audio timeline shorter than
  // the picture would cut the picture. That leaves the common loop case.
  const pictureCoversTimeline = videoDurationSeconds === null || timeline >= videoDurationSeconds - 0.05
  const useShortest = loop && mode !== 'attach' && pictureCoversTimeline

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', video,
    ...(loop ? ['-stream_loop', '-1'] : []),
    '-i', audio,
    '-filter_complex', filterGraph,
    ...mapArgs,
    ...codecArgs,
    // The picture is never shortened: `durationSeconds` bounds the *audio*
    // timeline, and the filter graph already trims/pads the new track to it, so
    // neither `-t` nor `-shortest` is needed to make the output finite.
    // `-shortest` is still added for a looped cue as a failsafe against an
    // input that the filter did not bound — but only where it cannot truncate:
    // not in attach mode (it would drop the last copied audio packet, measured
    // as 21 ms with ffmpeg 9.1) and not when the audio timeline is shorter than
    // the picture (it would then cut the picture).
    ...(useShortest ? ['-shortest'] : []),
    ...(container.faststart ? ['-movflags', '+faststart'] : [])
  ]

  return {
    args,
    command: formatCommand('ffmpeg', [...args, '<out>']),
    container: container.name,
    audioCodec: container.audioCodec,
    outputExtension: outputPath === null ? extname(video).replace(/^\./, '') : extname(outputPath).replace(/^\./, ''),
    outputPath: outputPath === null ? null : outputPath,
    inputs: { video, audio },
    filterGraph,
    audioLabel,
    estimated: {
      mode,
      requestedMode,
      timelineSeconds: round3(timeline),
      audioStartSeconds: round3(offsetSeconds),
      audioEndSeconds: round3(offsetSeconds + audioSpan),
      fadeInSeconds: round3(fadeInSeconds),
      fadeOutSeconds: round3(fadeOutSeconds),
      loop,
      mixGainDb: round3(mixGainDb),
      sampleRate,
      channels: 2,
      repeated: repeatsNeeded,
      repeats,
      padSeconds,
      trimSeconds,
      notes
    }
  }
}

/* ---- mux execution ---- */

/**
 * Measure a muxed file's audio peak with ffmpeg's pass-through `volumedetect`.
 *
 * A mix sums two full-scale signals, so it is the one mode that can clip. The
 * number is reported rather than silently "fixed" by a limiter: ffmpeg's
 * alimiter delays its output by its 5 ms lookahead, which would shift the
 * soundtrack against the picture — worse than a loud mix the caller can fix
 * with `mixGainDb`.
 * @returns {Promise<number|null>} max sample level in dBFS, or null if unknown.
 */
async function measureAudioPeak (ffmpegPath, path, options = {}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-nostats', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-']
  try {
    const result = await runProcess(ffmpegPath, args, { timeoutMs: options.timeoutMs ?? MEDIA_LIMITS.defaultTimeoutMs })
    const match = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(result.stderr)
    if (match === null || match[1] === '-inf') return null
    const value = Number(match[1])
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Execute a plan from `planMux`.
 *
 * Runs ffmpeg with a hard timeout (120 s by default), never streams media to the
 * caller, and turns a non-zero exit into an error that quotes the last stderr
 * lines — the difference between "mux failed" and "exit 1: Stream map '0:a:0'
 * matches no streams". On failure any half-written output is removed, so a
 * broken deliverable is never left at the target path.
 * @param {object} plan - the object `planMux` returned.
 * @param {{ out?: string, ffmpegPath?: string, timeoutMs?: number,
 *   measurePeak?: boolean }} [options] - `out` overrides the plan's path;
 *   `measurePeak: false` skips the mix-mode level check.
 * @returns {Promise<{
 *   outputPath: string, bytes: number, durationSeconds: number|null,
 *   command: string, stderrTail: string, elapsedMs: number,
 *   media: object|null, measured: boolean, audioPeakDbfs: number|null,
 *   warnings: string[], estimated: object
 * }>}
 * @throws when ffmpeg is absent, the output path is missing, or ffmpeg fails.
 */
export async function runMux (plan, options = {}) {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.args)) {
    throw new Error('runMux: needs a plan object from planMux (with an args array)')
  }
  const ffmpegPath = requireFfmpeg({ ffmpegPath: options.ffmpegPath })
  const requested = pathText(options.out) ?? pathText(plan.outputPath)
  if (requested === null) {
    throw new Error('runMux: no output path; pass options.out or set out when planning')
  }
  const outputPath = resolve(requested)
  // The plan chose an audio codec and muxer flags for one container; a different
  // extension here would silently ask ffmpeg for something the plan did not
  // build for (aac into webm, for example), so refuse instead of half-muxing.
  const plannedExtension = plan.outputExtension === undefined || plan.outputExtension === null
    ? ''
    : String(plan.outputExtension).replace(/^\./, '').toLowerCase()
  const actualExtension = extname(outputPath).replace(/^\./, '').toLowerCase()
  if (plannedExtension !== '' && actualExtension !== '' && actualExtension !== plannedExtension) {
    throw new Error(
      `runMux: ${basename(outputPath)} is a .${actualExtension} file but the plan was built for .${plannedExtension} ` +
      `(${plan.container ?? 'unknown'} container, ${plan.audioCodec ?? 'unknown'} audio); call planMux with the new out`
    )
  }
  await mkdir(dirname(outputPath), { recursive: true })

  const args = [...plan.args, outputPath]
  const command = formatCommand(ffmpegPath, args)
  const timeoutMs = optionalInteger('runMux', 'timeoutMs', options.timeoutMs, MEDIA_LIMITS.defaultTimeoutMs, 1000, 3600000)

  let result
  try {
    result = await runProcess(ffmpegPath, args, { timeoutMs })
  } catch (failure) {
    await unlink(outputPath).catch(() => {})
    const hint = plan.estimated?.mode === 'mix'
      ? 'if the video has no original audio track, plan the mux with mode replace'
      : ''
    throw processError('runMux', failure, hint)
  }

  let bytes = 0
  try {
    bytes = (await stat(outputPath)).size
  } catch {
    throw new Error(`runMux: ffmpeg reported success but ${outputPath} was not written`)
  }

  // The probe is the only proof the file is playable; when ffprobe is missing
  // the plan's own timeline is reported as an estimate rather than a fact.
  let media = null
  let durationSeconds = null
  try {
    media = await probeMedia(outputPath, { ffmpegPath: options.ffmpegPath })
    durationSeconds = media.durationSeconds
  } catch {
    durationSeconds = plan.estimated?.timelineSeconds ?? null
  }

  const warnings = []
  let audioPeakDbfs = null
  if (plan.estimated?.mode === 'mix' && options.measurePeak !== false) {
    audioPeakDbfs = await measureAudioPeak(ffmpegPath, outputPath, { timeoutMs })
    if (audioPeakDbfs !== null && audioPeakDbfs > -0.2) {
      warnings.push(
        `${plan.estimated.mode} peak ${audioPeakDbfs.toFixed(1)} dBFS is at full scale; ` +
        'lower mixGainDb (e.g. -6) or the original sound is already normalised to 0 dBFS'
      )
    }
  }
  if (media !== null && media.hasAudio === false) warnings.push('the output has no audio track')
  if (media !== null && plan.estimated !== undefined && media.hasVideo === false) warnings.push('the output has no video track')

  return {
    outputPath,
    bytes,
    durationSeconds,
    command,
    stderrTail: tailText(result.stderr, 6),
    elapsedMs: result.elapsedMs,
    media,
    measured: media !== null,
    audioPeakDbfs,
    warnings,
    estimated: plan.estimated ?? null
  }
}

/* ---- cut detection ---- */

/**
 * Derive evenly spaced timing anchors for a video with no detectable cuts.
 * @param {number} durationSeconds - media length.
 * @param {number} everySeconds - spacing.
 * @returns {{ at: number, score: number }[]}
 */
function evenCuts (durationSeconds, everySeconds) {
  const cuts = []
  if (!(durationSeconds > 0) || !(everySeconds > 0)) return cuts
  for (let at = everySeconds; at < durationSeconds - 0.15 && cuts.length < 16; at += everySeconds) {
    cuts.push({ at: round3(at), score: 0 })
  }
  return cuts
}

/** Pair the `metadata=print` lines of the scene pass into { at, score } entries. */
function parseSceneOutput (stderr) {
  const found = []
  let current = null
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    const timeMatch = /pts_time:(-?[\d.]+)/.exec(line)
    if (timeMatch !== null) {
      const at = Number(timeMatch[1])
      if (Number.isFinite(at) && at >= 0) {
        current = { at, score: 0 }
        found.push(current)
      }
      continue
    }
    const scoreMatch = /lavfi\.scene_score=([\d.]+)/.exec(line)
    if (scoreMatch !== null && current !== null) {
      const score = Number(scoreMatch[1])
      if (Number.isFinite(score)) current.score = score
    }
  }
  return found
}

/** Collapse cuts closer than `minGapSeconds`, keeping the highest score. */
function collapseCuts (entries, minGapSeconds) {
  const sorted = entries.slice().sort((left, right) => left.at - right.at)
  const kept = []
  for (const entry of sorted) {
    const last = kept[kept.length - 1]
    if (last !== undefined && entry.at - last.at < minGapSeconds) {
      if (entry.score > last.score) kept[kept.length - 1] = entry
      continue
    }
    kept.push(entry)
  }
  return kept
}

/**
 * Detect scene cuts in a video, as cue anchors for an `audio_bind` plan.
 *
 * Uses ffmpeg's `select='gt(scene,threshold)'` score and prints each surviving
 * frame's PTS with `metadata=print`, so one pass yields both time and score.
 * When the picture has no usable change (a static shot, a single take), the
 * answer falls back to evenly spaced anchors and says so via `method`, because
 * an empty plan is less useful than a rough one — as long as it is labelled.
 * @param {string} path - video file.
 * @param {{ threshold?: number, minSceneSeconds?: number, fallbackSeconds?: number,
 *   ffmpegPath?: string, ffprobePath?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   path: string, durationSeconds: number|null, cuts: { at: number, score: number }[],
 *   count: number, method: 'scene'|'even'|'none', detected: number,
 *   threshold: number, minSceneSeconds: number, fallbackSeconds: number,
 *   command: string, stderrTail: string
 * }>}
 * @throws when ffmpeg/ffprobe are absent, the file has no video stream, or
 *   ffmpeg itself fails.
 */
export async function detectCuts (path, options = {}) {
  const target = requiredPath('detectCuts', 'path', path)
  const absolute = isAbsolute(target) ? target : resolve(target)
  const ffmpegPath = requireFfmpeg({ ffmpegPath: options.ffmpegPath })
  const threshold = Math.min(0.99, Math.max(0.01, Number.isFinite(options.threshold) ? Number(options.threshold) : MEDIA_LIMITS.defaultCutThreshold))
  const minSceneSeconds = Math.min(60, Math.max(0.01, Number.isFinite(options.minSceneSeconds) ? Number(options.minSceneSeconds) : MEDIA_LIMITS.defaultMinSceneSeconds))
  const fallbackSeconds = Math.min(60, Math.max(0.25, Number.isFinite(options.fallbackSeconds) ? Number(options.fallbackSeconds) : MEDIA_LIMITS.defaultFallbackSeconds))

  // Duration is needed for the fallback and for the report; the video check
  // stops a confusing ffmpeg failure on an audio-only file.
  let durationSeconds = null
  try {
    const media = await probeMedia(absolute, { ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath })
    if (media.hasVideo === false) {
      const error = new Error(`detectCuts: ${basename(absolute)} has no video stream; there are no picture cuts to find`)
      error.code = 'NO_VIDEO'
      throw error
    }
    durationSeconds = media.durationSeconds
  } catch (error) {
    if (error?.code === 'NO_VIDEO') throw error
    // A probe failure must not stop the scene pass: ffmpeg can still report
    // cuts, only the fallback spacing needs a duration.
  }

  const filter = `select=gt(scene\\,${threshold}),metadata=print:key=lavfi.scene_score`
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-i', absolute, '-an', '-vf', filter, '-f', 'null', '-']
  const command = formatCommand(ffmpegPath, args)
  let result
  try {
    result = await runProcess(ffmpegPath, args, { timeoutMs: options.timeoutMs ?? MEDIA_LIMITS.defaultTimeoutMs })
  } catch (failure) {
    throw processError(`detectCuts (${basename(absolute)})`, failure, 'the file may not be decodable video')
  }

  const detected = parseSceneOutput(result.stderr).filter((entry) => entry.at > 0.05)
  const collapsed = collapseCuts(detected, minSceneSeconds)
  const sceneCuts = collapsed.map((entry) => ({ at: round3(entry.at), score: round3(entry.score) }))

  let cuts = sceneCuts
  let method = 'scene'
  if (cuts.length === 0) {
    cuts = evenCuts(durationSeconds ?? 0, fallbackSeconds)
    method = cuts.length === 0 ? 'none' : 'even'
  }

  return {
    path: absolute,
    durationSeconds: durationSeconds === null ? null : round3(durationSeconds),
    cuts,
    count: cuts.length,
    method,
    detected: detected.length,
    threshold,
    minSceneSeconds,
    fallbackSeconds,
    command,
    stderrTail: tailText(result.stderr, 4)
  }
}

/* ---- audio extraction ---- */

/** Map ffmpeg's "no audio stream" wording onto an error the caller can act on. */
function extractionHint (stderr) {
  const text = String(stderr ?? '')
  // ffmpeg says "matches no streams" when the map is simply absent, but when an
  // audio-only option is forced onto a video-only file it reports the map value
  // instead; both mean the same thing to the caller.
  if (/matches no streams|does not contain any stream|for option 'map'|stream map|no stream/i.test(text)) {
    return 'the file has no audio track to extract'
  }
  return 'the file may not be decodable media'
}

/**
 * Pull a media file's audio out to a wav the rest of the plugin can analyse.
 *
 * The output is always 16-bit PCM WAV at `sampleRate` (48 kHz by default, which
 * is what video audio is usually at) and mono by default: `measure`,
 * `audio_beats` and `audio_lipsync` all read mono wavs, and a stereo video track
 * is downmixed by the encoder rather than left for them to fold.
 *
 * Level convention worth knowing when comparing the wav against the video: the
 * 16-bit path downmixes stereo→mono with ffmpeg's amplitude-preserving 0.5·(L+R)
 * law, so a mono cue that `planMux` upmixed to stereo (-3.01 dB per channel)
 * measures 3 dB below its rendered amplitude here — the stereo deliverable holds
 * the same total power, and the downmix cannot clip.
 * @param {string} path - media file with audio.
 * @param {string} outPath - target `.wav`; its directory is created.
 * @param {{ sampleRate?: number, channels?: 1|2, ffmpegPath?: string,
 *   timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   outputPath: string, bytes: number, durationSeconds: number|null,
 *   sampleRate: number, channels: number, command: string, stderrTail: string
 * }>}
 * @throws when ffmpeg is absent, the source has no audio, or ffmpeg fails.
 */
export async function extractAudio (path, outPath, options = {}) {
  const source = requiredPath('extractAudio', 'path', path)
  const destination = requiredPath('extractAudio', 'outPath', outPath)
  const absoluteSource = isAbsolute(source) ? source : resolve(source)
  const absoluteOut = resolve(destination)
  const ffmpegPath = requireFfmpeg({ ffmpegPath: options.ffmpegPath })
  const sampleRate = optionalInteger('extractAudio', 'sampleRate', options.sampleRate, 48000, MEDIA_LIMITS.minSampleRate, MEDIA_LIMITS.maxSampleRate)
  const channels = Number(options.channels) === 2 ? 2 : 1
  await mkdir(dirname(absoluteOut), { recursive: true })

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', absoluteSource,
    '-vn', '-map', '0:a:0',
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    absoluteOut
  ]
  const command = formatCommand(ffmpegPath, args)
  let result
  try {
    result = await runProcess(ffmpegPath, args, { timeoutMs: options.timeoutMs ?? MEDIA_LIMITS.defaultTimeoutMs })
  } catch (failure) {
    await unlink(absoluteOut).catch(() => {})
    throw processError(`extractAudio (${basename(absoluteSource)})`, failure, extractionHint(failure?.stderr))
  }

  // Report the file's real duration from the wav header rather than trusting the
  // arithmetic: a mismatched rate here would desynchronise everything downstream.
  let durationSeconds = null
  let finalRate = sampleRate
  try {
    const media = await probeMedia(absoluteOut, { ffmpegPath: options.ffmpegPath })
    durationSeconds = media.durationSeconds
    if (media.audio?.sampleRate) finalRate = media.audio.sampleRate
  } catch { /* the caller can still decode the wav itself */ }

  return {
    outputPath: absoluteOut,
    bytes: (await stat(absoluteOut)).size,
    durationSeconds,
    sampleRate: finalRate,
    channels,
    command,
    stderrTail: tailText(result.stderr, 4)
  }
}

/* ---- misc exports used by the tool layer ---- */

/**
 * Round a duration to milliseconds, the precision every report in this plugin
 * states times at. Exported so the tool layer formats numbers identically.
 * @param {number} value - seconds.
 * @returns {number} seconds rounded to 3 decimals, never `-0`.
 */
export function roundSeconds (value) {
  return round3(value)
}
