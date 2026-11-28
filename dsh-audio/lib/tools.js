/**
 * The four model-facing tools.
 *
 * They are deliberately few and verb-shaped: one sound, one span of sound, one
 * mix, one measurement. Each returns a bounded summary (path + numbers) rather
 * than audio bytes, because the model reasons about durations and levels far
 * better than about waveforms.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  finalizeChannels,
  hashSpec,
  measure,
  measureChannels,
  normalizeMixChannels,
  readChannels,
  renderMix,
  renderPattern,
  renderPreset,
  resolvePath,
  toWavBytes,
  toWavBytesChannels,
  validateMixOptions,
  writeFileAtomic
} from './audio.js'
import { PRESETS } from './dsp.js'

const PRESET_NAMES = Object.keys(PRESETS)

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
  const number = Number(value)
  // A metric computed over non-finite samples is NaN or ±Infinity. Printing
  // `Infinity dBFS` (or `NaN dB`) is worse than saying the number is unknown,
  // because it reads like a measurement rather than a broken input.
  if (!Number.isFinite(number)) return 'n/a'
  return number.toFixed(digits).replace(/\.0+$/, '')
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Read an optional numeric argument, rejecting only values that have no meaning.
 *
 * `undefined`/`null` mean "use the default" and a numeric string is accepted
 * because the host may send one. A literal NaN (or "abc") used to render a
 * 0-frame file whose report was full of NaN; Infinity is left alone because the
 * engine clamps it on purpose (`duration: 1e999` is the documented 30 s cap).
 */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  return number
}

function requirePreset (tool, preset) {
  if (typeof preset !== 'string' || preset.trim() === '') {
    throw new Error(`${tool}: preset is required and must be one of ${PRESET_NAMES.join(', ')}`)
  }
}

/** Shared result summary: the numbers an agent needs to decide what to change. */
function summaryLine (label, cwd, path, bytes, metrics, extra = []) {
  const size = bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
  const parts = [
    `${label} ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${metrics.sampleRate} Hz, ${size})`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${fmt(metrics.centroidHz, 0)} Hz`,
    `onsets ${fmt(metrics.onsets, 0)}`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping',
    ...extra
  ]
  return parts.join(' · ')
}

async function finish (cwd, samples, sampleRate, requestedOut, label, hash, options = {}) {
  finalize(samples, sampleRate, options.peakDbfs ?? -1, { loop: options.loop === true })
  const bytes = toWavBytes(samples, sampleRate)
  const target = resolvePath(cwd, requestedOut) ?? defaultOutputPath(cwd, label, hash)
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  const metrics = { ...measure(samples, sampleRate), sampleRate }
  return { target, bytes: info.size ?? bytes.length, metrics, samples, sampleRate }
}

/**
 * Channel-preserving sibling of `finish`, used by `audio_mix`.
 *
 * Kept separate so the mono synthesis tools keep their exact pipeline (and
 * bytes); only the mix writes through here, because it is the one tool whose
 * output channel count follows its input. Finalisation, encoding and metering
 * all take the channel list, so a stereo mix keeps its image through every one
 * of them.
 */
async function finishChannels (cwd, channels, sampleRate, requestedOut, label, hash, options = {}) {
  finalizeChannels(channels, sampleRate, options.peakDbfs ?? -1, { loop: options.loop === true })
  const bytes = toWavBytesChannels(channels, sampleRate)
  const target = resolvePath(cwd, requestedOut) ?? defaultOutputPath(cwd, label, hash)
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  const metrics = { ...measureChannels(channels, sampleRate), sampleRate }
  return { target, bytes: info.size ?? bytes.length, metrics, channels, sampleRate }
}

/**
 * Count the NaN / ±Infinity samples a file carries, per channel.
 *
 * Every other measurement here is blind to them: `NaN > peak` is false, so a
 * file of NaNs measures as peak -120 dBFS and reads "clean", while +Infinity
 * measures as a peak of Infinity. Both are shapes that look like a healthy
 * report. This count is what lets `audio_probe` say the file is unusable
 * instead of printing those numbers as if they were measurements.
 *
 * @param {Float32Array[]} channels - decoded channel buffers.
 * @returns {{ nan: number, infinite: number, total: number, samples: number,
 *   perChannel: { nan: number, infinite: number }[] }}
 */
export function countNonFiniteSamples (channels) {
  let nan = 0
  let infinite = 0
  let samples = 0
  const perChannel = []
  for (const channel of channels) {
    let channelNan = 0
    let channelInfinite = 0
    for (let index = 0; index < channel.length; index += 1) {
      const value = channel[index]
      if (Number.isNaN(value)) channelNan += 1
      else if (!Number.isFinite(value)) channelInfinite += 1
    }
    nan += channelNan
    infinite += channelInfinite
    samples += channel.length
    perChannel.push({ nan: channelNan, infinite: channelInfinite })
  }
  return { nan, infinite, total: nan + infinite, samples, perChannel }
}

/** Register the audio tools on `ctx.tools`. */
export function registerTools (ctx) {
  ctx.tools.register({
    name: 'audio_synth',
    description: 'Render one synthesized sound effect from the built-in preset table to a .wav, with measurements. Deterministic: the same preset, params, seed and duration produce identical bytes. Presets and knobs are listed in the animation-sound skill.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset id (38 families); one line per preset is in the animation-sound skill.' },
        params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs 0..1 plus pitch; the full knob list is in the animation-sound skill.' },
        duration: { type: 'number', description: 'Length in seconds; defaults to the preset length (0.05 for tick, 1.6 for riser, 3 for texture).' },
        seed: { type: 'integer', description: 'Variation seed. Same seed reproduces the same take; change it to get a sibling variant.' },
        loop: { type: 'boolean', description: 'Render a seamless loop (for beds and hums). The file then repeats without a thump.' },
        sampleRate: { type: 'integer', description: 'Sample rate; default 44100 (22050 for inline, 48000 for video).' },
        out: { type: 'string', description: 'Output path; default assets/audio/<preset>-<hash>.wav.' }
      },
      required: ['preset'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Render ${args.preset ?? 'sound'}`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      readNumber('audio_synth', 'duration', args.duration)
      readNumber('audio_synth', 'sampleRate', args.sampleRate)
      readNumber('audio_synth', 'seed', args.seed)
      const spec = { preset: args.preset, params: args.params ?? {}, duration: args.duration, seed: args.seed ?? 1, loop: args.loop === true, sampleRate: args.sampleRate ?? 44100 }
      const hash = hashSpec(spec)
      const rendered = renderPreset({ ...spec, params: spec.params })
      const result = await finish(cwd, rendered.samples, rendered.sampleRate, args.out, args.preset, hash, { loop: spec.loop })
      const loopNote = args.loop === true ? [`loop seam ${fmt(result.metrics.loopSeam)} dB`] : []
      return {
        path: result.target,
        relativePath: displayPath(cwd, result.target),
        bytes: result.bytes,
        durationSeconds: result.metrics.durationSeconds,
        sampleRate: result.metrics.sampleRate ?? rendered.sampleRate,
        metrics: result.metrics,
        text: summaryLine('Wrote', cwd, result.target, result.bytes, result.metrics, loopNote)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_pattern',
    description: 'Fill a span of time with a generated sequence of one preset: an even or accelerating train, a random scatter, or a riser. One call replaces dozens of separate renders.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset repeated by the pattern.' },
        kind: { type: 'string', enum: ['train', 'scatter', 'riser'], description: 'train, scatter or riser; curve reshapes train spacing.' },
        from: { type: 'number', description: 'Span start in seconds; default 0. The file still starts at 0 s and lasts to-from.' },
        to: { type: 'number', description: 'Span end in seconds; default 4. Cap 180 s; this is also the file length.' },
        every: { type: 'number', description: 'Spacing between events in seconds; ignored when count is given.' },
        count: { type: 'integer', description: 'Exact event count instead of a spacing; capped at 20000.' },
        curve: { type: 'string', enum: ['linear', 'accelerando', 'ritardando', 'ease'], description: 'How spacing changes across the span. accelerando crowds events toward the end.' },
        jitter: { type: 'number', description: '0..1 timing randomness; keeps a train from sounding mechanical.' },
        accentEvery: { type: 'integer', description: 'Accent every Nth event (e.g. 4 for a 4/4 feel).' },
        pitchFrom: { type: 'number', description: 'First event pitch: 0..1 knob for tick/chime/zap/riser, else a 0.5..2 multiplier.' },
        pitchTo: { type: 'number', description: 'Pitch of the last event, same domain as pitchFrom.' },
        params: { type: 'object', additionalProperties: true, description: 'Base knobs for every event, same names as audio_synth.' },
        seed: { type: 'integer', description: 'Variation seed.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100.' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/<preset>-pattern-<hash>.wav.' }
      },
      required: ['preset'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Pattern ${args.preset ?? 'sound'}`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      requirePreset('audio_pattern', args.preset)
      readNumber('audio_pattern', 'from', args.from)
      readNumber('audio_pattern', 'to', args.to)
      readNumber('audio_pattern', 'every', args.every)
      readNumber('audio_pattern', 'count', args.count)
      readNumber('audio_pattern', 'sampleRate', args.sampleRate)
      readNumber('audio_pattern', 'seed', args.seed)
      const spec = {
        preset: args.preset,
        kind: args.kind ?? 'train',
        from: args.from ?? 0,
        to: args.to ?? 4,
        every: args.every,
        count: args.count,
        curve: args.curve ?? 'linear',
        jitter: args.jitter ?? 0,
        accentEvery: args.accentEvery ?? 0,
        pitchFrom: args.pitchFrom,
        pitchTo: args.pitchTo,
        params: args.params ?? {},
        seed: args.seed ?? 1,
        sampleRate: args.sampleRate ?? 44100
      }
      const hash = hashSpec(spec)
      const rendered = renderPattern(spec)
      const result = await finish(cwd, rendered.samples, rendered.sampleRate, args.out, `${args.preset}-pattern`, hash)
      return {
        path: result.target,
        relativePath: displayPath(cwd, result.target),
        bytes: result.bytes,
        events: rendered.events,
        durationSeconds: result.metrics.durationSeconds,
        metrics: result.metrics,
        text: summaryLine(`Wrote ${rendered.events} events to`, cwd, result.target, result.bytes, result.metrics)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_mix',
    description: 'Mix existing .wav files into one track with per-input gain, fades, peak normalisation and a limiter. Keeps the widest input\'s channel layout. Use audio_bus when the layers need EQ, compression or ducking.',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Input .wav paths, relative to the working directory or absolute.' },
        offsets: { type: 'array', items: { type: 'number' }, description: 'Start time per input in seconds, same order as inputs (0..180).' },
        gains: { type: 'array', items: { type: 'number' }, description: 'Per-input gain in dB, same order as inputs (-120..24).' },
        durationSeconds: { type: 'number', description: 'Trim or pad to this length (max 180 s); default the longest input.' },
        fadeInSeconds: { type: 'number', description: 'Fade in length; omit for none.' },
        fadeOutSeconds: { type: 'number', description: 'Fade out length; omit for none.' },
        limiter: { type: 'boolean', description: 'Soft-limit the sum; defaults to true.' },
        peakDbfs: { type: 'number', description: 'Normalise the final peak to this level; defaults to -1.' },
        sampleRate: { type: 'integer', description: 'Output rate; inputs are resampled. Defaults to the highest input rate.' },
        channels: {
          type: ['string', 'integer'],
          enum: ['auto', 1, 2],
          description: 'Output channels: auto (default), 1 mono or 2 stereo; LFE is dropped on a fold.'
        },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/mix-<hash>.wav.' }
      },
      required: ['inputs'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Mix ${args.inputs?.length ?? 0} tracks`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      // Reject a bad offset/duration/channels before any file is opened: the same
      // check runs inside renderMix, but by then the inputs have already been read.
      validateMixOptions({ offsets: args.offsets ?? [], gains: args.gains ?? [], durationSeconds: args.durationSeconds, channels: args.channels })
      readNumber('audio_mix', 'sampleRate', args.sampleRate)
      readNumber('audio_mix', 'peakDbfs', args.peakDbfs)
      readNumber('audio_mix', 'fadeInSeconds', args.fadeInSeconds)
      readNumber('audio_mix', 'fadeOutSeconds', args.fadeOutSeconds)
      const paths = (args.inputs ?? []).map((input) => resolvePath(cwd, input)).filter(Boolean)
      if (paths.length === 0) throw new Error('audio_mix needs at least one input path')
      // Read the real channels: `readTrack` folds a file to mono, and that fold
      // is exactly the information a stereo mix has to keep.
      const tracks = []
      for (const path of paths) tracks.push(await readChannels(path))
      const channelsChoice = normalizeMixChannels(args.channels)
      // The explicit channel choice belongs in the cache key; an `auto` request
      // is left out of it so an all-mono mix keeps its historical default path.
      const hash = hashSpec({
        inputs: paths,
        gains: args.gains ?? [],
        offsets: args.offsets ?? [],
        duration: args.durationSeconds,
        peak: args.peakDbfs ?? -1,
        channels: channelsChoice === 'auto' ? undefined : channelsChoice
      })
      const mixed = renderMix(tracks, {
        channels: channelsChoice,
        sampleRate: args.sampleRate,
        gains: args.gains ?? [],
        offsets: args.offsets ?? [],
        durationSeconds: args.durationSeconds,
        fadeInSeconds: args.fadeInSeconds ?? 0,
        fadeOutSeconds: args.fadeOutSeconds ?? 0,
        limiter: args.limiter !== false,
        peakDbfs: Number.isFinite(args.peakDbfs) ? args.peakDbfs : -1
      })
      const result = await finishChannels(cwd, mixed.channels, mixed.sampleRate, args.out, 'mix', hash, { peakDbfs: args.peakDbfs ?? -1 })
      // Say it in the result too: a caller that feeds in stereo must be able to
      // see that the image survived (or exactly where it was folded).
      const foldNote = [
        mixed.channelCount === 2
          ? 'stereo output'
          : (mixed.foldedFrom > 1 ? `mono output (${mixed.foldedFrom}-ch input folded)` : 'mono output'),
        mixed.lfeDropped ? 'LFE dropped' : null,
        `input channels ${mixed.inputChannels.join('/')}`
      ].filter(Boolean)
      return {
        path: result.target,
        relativePath: displayPath(cwd, result.target),
        bytes: result.bytes,
        inputs: paths.length,
        channels: mixed.channelCount,
        foldedFrom: mixed.foldedFrom,
        inputChannels: mixed.inputChannels,
        lfeDropped: mixed.lfeDropped,
        durationSeconds: result.metrics.durationSeconds,
        metrics: result.metrics,
        text: summaryLine(`Mixed ${paths.length} track(s) into`, cwd, result.target, result.bytes, result.metrics, foldNote)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_probe',
    description: 'Measure a .wav file: duration, peak/RMS, crest, DC, clipping, brightness, onsets and loop seam, per channel. Use it to verify a render or check that a loop will not thump.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Audio file to measure, relative to the working directory or absolute.' },
        expectDuration: { type: 'number', description: 'Optional expected duration in seconds; the report flags a mismatch beyond 50 ms.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Measure audio', kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const path = resolvePath(cwd, args.path)
      if (path === undefined) throw new Error('audio_probe needs a file path')
      // Read the real channels: `readTrack` folds to mono, and that fold is
      // exactly what hides one-sided clipping and cancels an out-of-phase pair.
      const decoded = await readChannels(path)
      const metrics = {
        ...measureChannels(decoded.channels, decoded.sampleRate),
        sampleRate: decoded.sampleRate,
        channelCount: decoded.channelCount
      }
      const info = await stat(path)
      const nonFinite = countNonFiniteSamples(decoded.channels)
      // A metric computed over poisoned samples is not a measurement. Hide the
      // level/analysis numbers behind `n/a` instead of printing the -120 dBFS
      // floor that NaN happens to produce, or `Infinity dBFS` for Inf: both
      // read like real readings and both are the bug, not the signal.
      const displayMetrics = nonFinite.total > 0
        ? {
            ...metrics,
            peakDbfs: Number.NaN,
            rmsDbfs: Number.NaN,
            crestDb: Number.NaN,
            dcOffset: Number.NaN,
            onsets: Number.NaN,
            loopSeam: Number.NaN,
            loopStep: Number.NaN,
            centroidHz: Number.NaN
          }
        : metrics
      const notes = []
      if (nonFinite.total > 0) {
        const where = nonFinite.perChannel
          .map((channel, index) => ({ index, ...channel }))
          .filter((channel) => channel.nan + channel.infinite > 0)
          .map((channel) => `ch${channel.index + 1} NaN ${channel.nan}, Inf ${channel.infinite}`)
          .join('; ')
        notes.push(`non-finite samples: ${nonFinite.total} of ${nonFinite.samples} (${where}); levels are not meaningful`)
      }
      const worstChannel = metrics.channelCount > 1 && metrics.perChannel !== undefined
        ? metrics.perChannel.findIndex((channel) => channel.clipping === metrics.clipping)
        : -1
      if (metrics.clipping > 0) {
        notes.push(worstChannel >= 0
          ? `clipping on channel ${worstChannel + 1}/${metrics.channelCount} (${metrics.clipping} samples)`
          : `clipping (${metrics.clipping} samples)`)
      }
      if (metrics.loopSeam > 6) notes.push('loop seam will thump (render with loop:true)')
      if (metrics.dcOffset > 0.02) notes.push(decoded.channelCount > 1 ? `DC offset (worst channel ${metrics.dcOffset})` : 'DC offset')
      if (metrics.channelCount > 1 && metrics.peakDbfs <= -40) notes.push('all channels are almost silent')
      if (Number.isFinite(args.expectDuration) && Math.abs(metrics.durationSeconds - args.expectDuration) > 0.05) {
        notes.push(`duration ${fmt(metrics.durationSeconds, 2)}s != expected ${fmt(args.expectDuration, 2)}s`)
      }
      const channelText = nonFinite.total > 0
        ? `${metrics.channelCount} ch (per-channel levels not meaningful)`
        : metrics.channelCount > 1
          ? [`${metrics.channelCount} ch`, ...(metrics.perChannel ?? []).map((channel, index) => `ch${index + 1} ${fmt(channel.peakDbfs)} dBFS${channel.clipping > 0 ? ' CLIP' : ''}`)].join(' · ')
          : 'mono'
      const text = summaryLine('Measured', cwd, path, info.size, displayMetrics, [
        channelText,
        `loop seam ${fmt(displayMetrics.loopSeam)} dB`,
        notes.length > 0 ? `notes: ${notes.join(', ')}` : 'clean'
      ])
      return {
        path,
        relativePath: displayPath(cwd, path),
        bytes: info.size,
        channels: decoded.channelCount,
        metrics: displayMetrics,
        nonFiniteSamples: nonFinite.total,
        notes,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

export { PRESET_NAMES }

