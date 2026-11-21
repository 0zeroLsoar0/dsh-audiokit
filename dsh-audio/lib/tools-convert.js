/**
 * `audio_convert`: the finishing tool.
 *
 * Rendering produces a raw cue; shipping it needs an edit. This tool owns the
 * four things an animation agent actually asks for: cut a span, fade its edges,
 * join takes, and write the file a deliverable needs — 8-bit for a data URI
 * that has to fit in one HTML file, 24-bit for video, 32-bit float for a
 * lossless pass, stereo when anything pans.
 *
 * It also owns the one batch operation that makes a cue set sound like a set:
 * `gain-scan` peels every input to a common peak and reports the gains it
 * applied, so the quiet hit and the loud hit stop fighting.
 *
 * Like the render tools it returns a bounded summary (path + numbers) rather
 * than audio, except when `inline: true` asks for a base64 data URI that the
 * caller will paste into a page.
 */

import { stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  readTrack,
  renderPreset,
  resolvePath,
  writeFileAtomic
} from './audio.js'
import { clamp } from './dsp.js'
import { decodeWav } from './wav.js'
import { applyGainDb, concat, fade, reverse, resampleHiFi, toStereo, trim, MAX_JOIN_SECONDS } from './convert.js'
import { encodeWavEx } from './wav-encode.js'

const BIT_DEPTHS = [8, 16, 24, 32]
const OPS = ['trim', 'gain', 'fade', 'reverse', 'concat', 'gain-scan', 'convert']
const SINGLE_INPUT_OPS = ['trim', 'gain', 'fade', 'reverse', 'convert']
const CURVES = ['linear', 'equalPower']
const GAIN_DB_LIMITS = Object.freeze([-120, 24])
const DEFAULT_MAX_INLINE_BYTES = 2 * 1024 * 1024
const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 96000

/* ------------------------------------------------------------------ helpers -- */

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

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function sizeLabel (bytes) {
  if (bytes >= 1024 * 1024) return `${fmt(bytes / 1024 / 1024, 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function positive (value) {
  return Number.isFinite(value) && value > 0
}

/** The inline budget: a positive byte count, or the documented default. */
function resolveInlineLimit (requested) {
  if (requested === undefined || requested === null) return DEFAULT_MAX_INLINE_BYTES
  const limit = Number(requested)
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`audio_convert: maxInlineBytes must be a positive integer (default ${DEFAULT_MAX_INLINE_BYTES})`)
  }
  return Math.round(limit)
}

/** Validate the `gain` op level: a meaningless dB value must not be turned into a silent file. */
function resolveGainDb (value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < GAIN_DB_LIMITS[0] || number > GAIN_DB_LIMITS[1]) {
    throw new Error(`audio_convert: gainDb must be a finite number of dB between ${GAIN_DB_LIMITS[0]} and ${GAIN_DB_LIMITS[1]}`)
  }
  return number
}

/** Validate one concat join length before the takes are even read. */
function checkJoinSeconds (key, value) {
  if (value === undefined || value === null) return
  const number = Number(value)
  if (!Number.isFinite(number) || number > MAX_JOIN_SECONDS) {
    throw new Error(`audio_convert: ${key} must be a finite number of seconds at most ${MAX_JOIN_SECONDS}`)
  }
}

function safeLabel (label) {
  return String(label).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'audio'
}

function labelFromPath (path) {
  return basename(path, extname(path))
}

/** Fold a decoded channel list to mono, which is the shape `measure` wants. */
function foldToMono (channels) {
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const channel of channels) {
    for (let index = 0; index < out.length; index += 1) out[index] += channel[index]
  }
  for (let index = 0; index < out.length; index += 1) out[index] /= channels.length
  return out
}

/**
 * Read one input: a wav path, or a render spec that is synthesized first.
 *
 * Render specs are finalized the same way `audio_synth` finalizes them (DC
 * block, peak at -1 dBFS, soft limit), so `{ preset: 'impact' }` means the same
 * sound here as it does there.
 */
async function readInput (cwd, entry) {
  if (typeof entry === 'string') {
    const path = resolvePath(cwd, entry)
    if (path === undefined) throw new Error('audio_convert: input path is empty')
    const track = await readTrack(path)
    return { samples: track.samples, sampleRate: track.sampleRate, label: labelFromPath(path), source: path }
  }
  if (entry !== null && typeof entry === 'object') {
    const preset = String(entry.preset ?? '')
    const spec = {
      preset,
      params: entry.params ?? {},
      duration: entry.duration,
      seed: Number.isFinite(entry.seed) ? Math.round(entry.seed) : 1,
      sampleRate: Number.isFinite(entry.sampleRate) ? Math.round(entry.sampleRate) : 44100,
      loop: entry.loop === true
    }
    const rendered = renderPreset(spec)
    finalize(rendered.samples, rendered.sampleRate, Number.isFinite(entry.peakDbfs) ? Number(entry.peakDbfs) : -1)
    return {
      samples: rendered.samples,
      sampleRate: rendered.sampleRate,
      label: `${preset}-${spec.seed}`,
      spec: { ...spec, params: { ...spec.params } }
    }
  }
  throw new Error('audio_convert: every input must be a .wav path or a render spec object')
}

/** Resolve the requested output format, with defaults that match the current tools. */
function resolveFormat (args) {
  const bitDepth = args.bitDepth === undefined ? 16 : Number(args.bitDepth)
  if (!BIT_DEPTHS.includes(bitDepth)) {
    throw new Error(`audio_convert: bitDepth must be one of ${BIT_DEPTHS.join(', ')}`)
  }
  const channels = args.channels === undefined ? 1 : Number(args.channels)
  if (channels !== 1 && channels !== 2) throw new Error('audio_convert: channels must be 1 or 2')
  let sampleRate = null
  if (args.sampleRate !== undefined && args.sampleRate !== null) {
    sampleRate = Math.round(Number(args.sampleRate))
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
      throw new Error(`audio_convert: sampleRate must be between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE} Hz`)
    }
  }
  const pan = clamp(Number.isFinite(args.pan) ? Number(args.pan) : 0, -1, 1)
  const width = clamp(Number.isFinite(args.width) ? Number(args.width) : 1, 0, 1)
  return { bitDepth, channels, sampleRate, pan, width }
}

/** Apply the requested rate/channel layout and encode the bytes. */
function encodeTrack (track, format) {
  let samples = track.samples
  let sampleRate = track.sampleRate
  const targetRate = format.sampleRate ?? sampleRate
  if (targetRate !== sampleRate) {
    const resampled = resampleHiFi(samples, sampleRate, targetRate)
    samples = resampled.samples
    sampleRate = resampled.sampleRate
  }
  const channelBuffers = format.channels === 2
    ? toStereo({ samples, sampleRate }, { pan: format.pan, width: format.width }).samples
    : [samples]
  return { bytes: encodeWavEx(channelBuffers, sampleRate, { bitDepth: format.bitDepth, channels: format.channels }), sampleRate }
}

/**
 * Encode, write atomically, and measure the decoded file. Measuring the
 * decoded bytes rather than the in-memory track is what makes `bitDepth`,
 * `channels`, `sampleRate` and the metrics describe what is actually on disk.
 */
async function writeTrack (cwd, track, format, target) {
  const { bytes } = encodeTrack(track, format)
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  const written = decodeWav(bytes)
  const metrics = { ...measure(foldToMono(written.channels), written.sampleRate), sampleRate: written.sampleRate }
  return {
    path: target,
    relativePath: displayPath(cwd, target),
    bytes: info.size ?? bytes.length,
    bitDepth: written.bitDepth,
    channels: written.channels.length,
    sampleRate: written.sampleRate,
    durationSeconds: written.durationSeconds,
    metrics,
    bytesBuffer: bytes
  }
}

/** Wrap the encoded bytes as a base64 data URI, enforcing the size guard. */
function buildInline (bytes, limit) {
  if (bytes.length > limit) {
    return {
      inline: null,
      note: `inline skipped: ${sizeLabel(bytes.length)} > maxInlineBytes ${sizeLabel(limit)}; pick a smaller bit depth or raise maxInlineBytes`
    }
  }
  const base64 = bytes.toString('base64')
  const dataUri = `data:audio/wav;base64,${base64}`
  const overhead = (dataUri.length / bytes.length).toFixed(2)
  return {
    inline: { base64, dataUri, byteLength: bytes.length, dataUriBytes: dataUri.length },
    note: `inline data URI ${sizeLabel(dataUri.length)} (page grows by ~${sizeLabel(dataUri.length)}, ${overhead}x the file)`
  }
}

function summaryLine (label, result, extra) {
  const format = `${result.bitDepth}-bit ${result.channels === 2 ? 'stereo' : 'mono'} ${result.sampleRate} Hz`
  const parts = [
    `${label} ${result.relativePath} (${fmt(result.durationSeconds, 2)}s, ${format}, ${sizeLabel(result.bytes)})`,
    `peak ${fmt(result.metrics.peakDbfs)} dBFS`,
    `rms ${fmt(result.metrics.rmsDbfs)} dBFS`,
    result.metrics.clipping > 0 ? `CLIPPING ${result.metrics.clipping} samples` : 'no clipping',
    ...extra
  ]
  return parts.join(' | ')
}

function applyRequestedFades (track, args) {
  if (!positive(args.fadeInSeconds) && !positive(args.fadeOutSeconds)) return track
  return fade(track, { in: args.fadeInSeconds, out: args.fadeOutSeconds, curve: args.curve })
}

/** Hash the exact request so identical requests converge on one deterministic name. */
function requestHash (op, tracks, args) {
  return hashSpec({
    op,
    inputs: tracks.map((track) => track.source ?? track.spec),
    start: args.start,
    end: args.end,
    snapToZeroCrossing: args.snapToZeroCrossing === true,
    gainDb: args.gainDb,
    fadeInSeconds: args.fadeInSeconds,
    fadeOutSeconds: args.fadeOutSeconds,
    curve: args.curve,
    gapSeconds: args.gapSeconds,
    crossfadeSeconds: args.crossfadeSeconds,
    peakDbfs: args.peakDbfs,
    pan: args.pan,
    width: args.width,
    bitDepth: args.bitDepth ?? 16,
    channels: args.channels ?? 1,
    sampleRate: args.sampleRate ?? null
  })
}

/* -------------------------------------------------------------------- ops -- */

/** One track in, one file out. */
async function runSingleOp (cwd, tracks, args, op, format, inlineLimit) {
  const source = tracks[0]
  let track
  if (op === 'trim') {
    track = trim(source, {
      start: args.start,
      end: args.end,
      snapToZeroCrossing: args.snapToZeroCrossing === true
    })
  } else if (op === 'gain') {
    track = applyGainDb(source, args.gainDb)
  } else if (op === 'fade') {
    track = fade(source, { in: args.fadeInSeconds, out: args.fadeOutSeconds, curve: args.curve })
  } else if (op === 'reverse') {
    track = reverse(source)
  } else if (op === 'concat') {
    track = concat(tracks, { gapSeconds: args.gapSeconds, crossfadeSeconds: args.crossfadeSeconds })
  } else {
    track = source
  }
  // Fades after the edit, so `trim + fadeInSeconds` trims a click-free head
  // without needing a second call.
  if (op !== 'fade') track = applyRequestedFades(track, args)

  const hash = requestHash(op, tracks, args)
  const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, `${op}-${source.label}`, hash)
  const written = await writeTrack(cwd, track, format, target)
  const extra = []
  if (args.inline === true) {
    const inline = buildInline(written.bytesBuffer, inlineLimit)
    extra.push(inline.note)
    const result = {
      path: written.path,
      relativePath: written.relativePath,
      bytes: written.bytes,
      op,
      bitDepth: written.bitDepth,
      channels: written.channels,
      sampleRate: written.sampleRate,
      durationSeconds: written.durationSeconds,
      metrics: written.metrics,
      inline: inline.inline,
      text: summaryLine(`Wrote ${op}`, written, extra)
    }
    return result
  }
  return {
    path: written.path,
    relativePath: written.relativePath,
    bytes: written.bytes,
    op,
    bitDepth: written.bitDepth,
    channels: written.channels,
    sampleRate: written.sampleRate,
    durationSeconds: written.durationSeconds,
    metrics: written.metrics,
    text: summaryLine(`Wrote ${op}`, written, extra)
  }
}

/**
 * Level a whole batch to one peak. This is the operation that makes a cue set
 * consistent: the reported gains are the answer to "why does the door slam
 * louder than the chime".
 */
async function runGainScan (cwd, tracks, args, format) {
  if (args.inline === true) {
    throw new Error('audio_convert: inline only applies to a single output; gain-scan writes one file per input')
  }
  const targetPeakDbfs = Number.isFinite(args.peakDbfs) ? Number(args.peakDbfs) : -1
  if (targetPeakDbfs > 0 || targetPeakDbfs < -60) {
    throw new Error('audio_convert: peakDbfs must be between -60 and 0 for gain-scan')
  }
  const requestedOut = resolvePath(cwd, args.out)
  if (tracks.length > 1 && requestedOut !== undefined && /\.wav$/i.test(requestedOut)) {
    throw new Error('audio_convert: with several inputs, out must be a directory (one .wav per input is written)')
  }
  const hash = requestHash('gain-scan', tracks, args)
  const directory = requestedOut ?? join(cwd, 'assets', 'audio', `gain-scan-${hash}`)
  // A single file has a file name; a batch gets a directory of numbered takes.
  const singleTarget = requestedOut ?? defaultOutputPath(cwd, `gain-scan-${tracks[0].label}`, hash)
  const files = []
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    let peak = 0
    for (let frame = 0; frame < track.samples.length; frame += 1) {
      const magnitude = Math.abs(track.samples[frame])
      if (magnitude > peak) peak = magnitude
    }
    const inputPeakDbfs = peak > 0 ? 20 * Math.log10(peak) : -120
    const gainDb = peak > 0 ? targetPeakDbfs - inputPeakDbfs : 0
    let adjusted = applyGainDb(track, gainDb)
    adjusted = applyRequestedFades(adjusted, args)
    const target = tracks.length === 1
      ? singleTarget
      : join(directory, `${String(index + 1).padStart(2, '0')}-${safeLabel(track.label)}.wav`)
    const written = await writeTrack(cwd, adjusted, format, target)
    files.push({
      path: written.path,
      relativePath: written.relativePath,
      label: track.label,
      bytes: written.bytes,
      gainDb: Number(gainDb.toFixed(2)),
      inputPeakDbfs: Number(inputPeakDbfs.toFixed(2)),
      peakDbfs: written.metrics.peakDbfs,
      durationSeconds: written.durationSeconds,
      bitDepth: written.bitDepth,
      channels: written.channels,
      sampleRate: written.sampleRate
    })
  }
  const first = files[0]
  const destination = tracks.length === 1 ? first.relativePath : `${displayPath(cwd, directory)}/`
  const formatText = `${first.bitDepth}-bit ${first.channels === 2 ? 'stereo' : 'mono'} ${first.sampleRate} Hz`
  const gainText = files.map((file) => `${file.label} ${file.gainDb >= 0 ? '+' : ''}${file.gainDb.toFixed(1)} dB`).join(', ')
  const text = `Scanned ${files.length} file(s) to a common ${fmt(targetPeakDbfs)} dBFS peak -> ${destination} (${formatText}) | ${gainText}`
  return {
    path: first.path,
    relativePath: first.relativePath,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    op: 'gain-scan',
    files,
    gains: files.map((file) => ({ input: file.label, gainDb: file.gainDb })),
    bitDepth: first.bitDepth,
    channels: first.channels,
    sampleRate: first.sampleRate,
    durationSeconds: first.durationSeconds,
    metrics: first.metrics,
    text
  }
}

/* ------------------------------------------------------------------- tool -- */

/** Register the `audio_convert` tool. */
export function registerConvertTools (ctx) {
  ctx.tools.register({
    name: 'audio_convert',
    description: 'Edit and finish a rendered cue: trim a span, apply a gain, fade in/out, reverse, join takes with a gap or crossfade, level a whole cue set to one common peak (gain-scan), or just re-encode the format. Writes 8-bit (tiny, for a base64 data URI in one HTML file), 16-bit, 24-bit (video master) or 32-bit float, mono or stereo, at any sample rate with a windowed-sinc resampler. Use it after audio_synth/audio_pattern/audio_tts instead of re-rendering with different settings. Returns the path plus the format actually written; `inline: true` also returns the bytes as a base64 data URI.',
    parameters: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'object', additionalProperties: true }
            ]
          },
          description: 'Input tracks in order: a .wav path (relative to the working directory or absolute), or an inline render spec { preset, params, duration, seed, sampleRate, loop } that is rendered first. trim/gain/fade/reverse/convert take exactly one; concat and gain-scan take one or more.'
        },
        op: {
          type: 'string',
          enum: OPS,
          description: 'trim=cut to start..end; gain=apply gainDb; fade=fade in/out; reverse=play backwards; concat=join takes with a gap or crossfade; gain-scan=normalise a batch to one common peak and report each gain; convert=re-encode at the requested format only.'
        },
        start: { type: 'number', description: 'trim: start of the span in seconds (default 0).' },
        end: { type: 'number', description: 'trim: end of the span in seconds (default end of the track).' },
        snapToZeroCrossing: { type: 'boolean', description: 'trim only: move the cut to the nearest zero crossing (within 5 ms) so the edit does not click.' },
        gainDb: { type: 'number', description: 'gain: level change in dB (finite, -120..24); negative attenuates.' },
        fadeInSeconds: { type: 'number', description: 'Fade-in length in seconds; applied after the op (or as the fade op itself).' },
        fadeOutSeconds: { type: 'number', description: 'Fade-out length in seconds; applied after the op (or as the fade op itself).' },
        curve: { type: 'string', enum: ['linear', 'equalPower'], description: 'Fade shape; equalPower keeps perceived loudness steadier.' },
        gapSeconds: { type: 'number', description: 'concat: silent gap between takes (finite, at most 60 s; negative clamps to 0); use this or crossfadeSeconds, not both.' },
        crossfadeSeconds: { type: 'number', description: 'concat: overlap between takes instead of a gap (finite, at most 60 s; negative clamps to 0).' },
        peakDbfs: { type: 'number', description: 'gain-scan: the common peak to hit in dBFS (default -1).' },
        pan: { type: 'number', description: 'Stereo placement, -1 left .. 0 centre .. 1 right; only used when channels is 2.' },
        width: { type: 'number', description: 'Stereo width 0..1: 0 folds both channels to mono, 1 keeps the pan image.' },
        bitDepth: { type: 'integer', enum: BIT_DEPTHS, description: '8=smallest, good for an inline HTML data URI; 16=default; 24=video master; 32=32-bit IEEE float. Defaults to 16.' },
        channels: { type: 'integer', enum: [1, 2], description: '1=mono (default), 2=stereo built from the mono track with pan/width.' },
        sampleRate: { type: 'integer', description: 'Output rate in Hz; defaults to the input rate. Uses a windowed-sinc resampler, safe as the final rate change.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/<op>-<label>-<hash>.wav. For gain-scan with several inputs this is a directory.' },
        inline: { type: 'boolean', description: 'Also return the written file as a base64 data URI (audio/wav) for single-file HTML. Skipped when the file exceeds maxInlineBytes.' },
        maxInlineBytes: { type: 'integer', description: `Size guard for inline output (positive; defaults to ${DEFAULT_MAX_INLINE_BYTES} = 2 MB).` }
      },
      required: ['inputs', 'op'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Convert ${args.op ?? 'audio'}`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const entries = Array.isArray(args.inputs) ? args.inputs : []
      if (entries.length === 0) throw new Error('audio_convert: inputs must contain at least one wav path or render spec')
      const op = String(args.op ?? '')
      if (!OPS.includes(op)) throw new Error(`audio_convert: op must be one of ${OPS.join(' | ')}`)
      const format = resolveFormat(args)
      // Validate the request's own numeric/enum options before reading a single
      // input: a bad join or gain must not cost a decode, and a zero inline
      // budget must not silently mean "the default".
      if (args.curve !== undefined && args.curve !== null && !CURVES.includes(args.curve)) {
        throw new Error(`audio_convert: curve must be one of ${CURVES.join(' | ')}`)
      }
      if (op === 'gain') resolveGainDb(args.gainDb)
      if (op === 'concat') {
        checkJoinSeconds('gapSeconds', args.gapSeconds)
        checkJoinSeconds('crossfadeSeconds', args.crossfadeSeconds)
      }
      const inlineLimit = args.inline === true ? resolveInlineLimit(args.maxInlineBytes) : null

      const tracks = []
      for (const entry of entries) tracks.push(await readInput(cwd, entry))
      if (SINGLE_INPUT_OPS.includes(op) && tracks.length !== 1) {
        throw new Error(`audio_convert: op "${op}" takes exactly one input; use concat to join takes`)
      }

      if (op === 'gain-scan') return runGainScan(cwd, tracks, args, format)
      return runSingleOp(cwd, tracks, args, op, format, inlineLimit)
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
