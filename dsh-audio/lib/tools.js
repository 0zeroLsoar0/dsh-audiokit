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
  hashSpec,
  measure,
  measureChannels,
  mixTracks,
  readChannels,
  readTrack,
  renderPattern,
  renderPreset,
  resolvePath,
  toWavBytes,
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
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
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
    `centroid ${metrics.centroidHz} Hz`,
    `onsets ${metrics.onsets}`,
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

/** Register the audio tools on `ctx.tools`. */
export function registerTools (ctx) {
  ctx.tools.register({
    name: 'audio_synth',
    description: 'Render one synthesized sound effect to a .wav file. Deterministic: the same preset, params, seed and duration always produce identical bytes, so a render can be cached and referenced by path. Returns the path plus measurements (duration, peak, RMS, crest, brightness, onset count) so the result can be judged without listening.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Sound family. impact=weighty hit, whoosh=moving air, tick=very short click, chime=tonal bell, riser=tension build, zap=electric discharge, thud=soft low body, scrap=friction grains, texture=sustained bed (ambience).' },
        params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs in 0..1: weight, hardness, metallic, space, tone, speed, rise, decay, density, roughness, movement, pitchJitter. pitch is a frequency multiplier 0.5..2 on impact, whoosh, switch-click, water-drip, bubble, servo, motor-loop, alarm-beep, alarm-siren, hud-tick, creature-growl, insect-buzz, bell-toll and choir-pad; it is a 0..1 knob on tick, chime and zap; the other presets ignore it. For preset "texture" add kind: wind|rain|fire|room|hum.' },
        duration: { type: 'number', description: 'Length in seconds; defaults to the preset length (0.05 for tick, 1.6 for riser, 3 for texture).' },
        seed: { type: 'integer', description: 'Variation seed. Same seed reproduces the same take; change it to get a sibling variant.' },
        loop: { type: 'boolean', description: 'Render a seamless loop (for beds and hums). The file then repeats without a thump.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100. Use 22050 when file size matters (inline HTML), 48000 for video-grade output.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/<preset>-<hash>.wav.' }
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
    description: 'Fill a span of time with a generated sequence of one preset: an even or accelerating train, a random scatter, or a riser. This is how dense textures are made without dozens of separate renders — one call with every=0.08 and an accelerating curve produces a hundred events that share a single coherent motion.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset repeated by the pattern.' },
        kind: { type: 'string', enum: ['train', 'scatter', 'riser'], description: 'train=evenly spaced (curve reshapes spacing), scatter=random positions, riser=one continuous rising sweep (uses the riser synth and accepts `params.tone` / `params.tension`).' },
        from: { type: 'number', description: 'Start of the span in seconds; defaults to 0. The output timeline still begins at 0 s, so `from` only moves the placement window and the file lasts `to - from` seconds.' },
        to: { type: 'number', description: 'End of the span in seconds; defaults to 4. The span (to - from) is capped at 180 s and is the length of the written file.' },
        every: { type: 'number', description: 'Spacing between events in seconds; ignored when count is given.' },
        count: { type: 'integer', description: 'Exact number of events instead of a spacing; capped at 20000. Every event is placed inside the span so `events` matches what the file plays.' },
        curve: { type: 'string', enum: ['linear', 'accelerando', 'ritardando', 'ease'], description: 'How spacing changes across the span. accelerando crowds events toward the end.' },
        jitter: { type: 'number', description: '0..1 timing randomness; keeps a train from sounding mechanical.' },
        accentEvery: { type: 'integer', description: 'Accent every Nth event (e.g. 4 for a 4/4 feel).' },
        pitchFrom: { type: 'number', description: 'Pitch of the first event, in the preset\'s own pitch domain: a 0..1 tone knob for tick/chime/zap/riser, a 0.5..2 frequency multiplier for impact/whoosh (and the other pitched presets). Combined with pitchTo it glides across the span.' },
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
    description: 'Mix existing .wav files into one track with per-input gain, fades, peak normalisation and a limiter. The output is always a mono file: every input is folded to one channel by averaging it (a 2/4/6/8-channel input loses its stereo image and its LFE), so use audio_bus or audio_master for a stereo/surround deliverable. Use it to assemble a finished cue from individually tweaked sounds, or to combine a bed with the hits that land on top of it.',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Input .wav paths, relative to the working directory or absolute.' },
        offsets: { type: 'array', items: { type: 'number' }, description: 'Start time of each input in seconds, same order as inputs (finite, 0..180). This is what turns a set of one-shots into a cue track; omit for 0.' },
        gains: { type: 'array', items: { type: 'number' }, description: 'Per-input gain in dB, same order as inputs (finite, -120..24; e.g. -6 quiets an input by 6 dB).' },
        durationSeconds: { type: 'number', description: 'Trim or pad the result to this length (finite, > 0, at most 180 s); defaults to the longest input.' },
        fadeInSeconds: { type: 'number', description: 'Fade in length; omit for none.' },
        fadeOutSeconds: { type: 'number', description: 'Fade out length; omit for none.' },
        limiter: { type: 'boolean', description: 'Soft-limit the sum; defaults to true.' },
        peakDbfs: { type: 'number', description: 'Normalise the final peak to this level; defaults to -1.' },
        sampleRate: { type: 'integer', description: 'Output rate; inputs are resampled. Defaults to the highest input rate.' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/mix-<hash>.wav.' }
      },
      required: ['inputs'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Mix ${args.inputs?.length ?? 0} tracks`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      // Reject a bad offset/duration before any file is opened: the same check
      // runs inside mixTracks, but by then the inputs have already been read.
      validateMixOptions({ offsets: args.offsets ?? [], gains: args.gains ?? [], durationSeconds: args.durationSeconds })
      readNumber('audio_mix', 'sampleRate', args.sampleRate)
      readNumber('audio_mix', 'peakDbfs', args.peakDbfs)
      readNumber('audio_mix', 'fadeInSeconds', args.fadeInSeconds)
      readNumber('audio_mix', 'fadeOutSeconds', args.fadeOutSeconds)
      const paths = (args.inputs ?? []).map((input) => resolvePath(cwd, input)).filter(Boolean)
      if (paths.length === 0) throw new Error('audio_mix needs at least one input path')
      const tracks = []
      for (const path of paths) tracks.push(await readTrack(path))
      const hash = hashSpec({ inputs: paths, gains: args.gains ?? [], offsets: args.offsets ?? [], duration: args.durationSeconds, peak: args.peakDbfs ?? -1 })
      const mixed = mixTracks(tracks, {
        sampleRate: args.sampleRate,
        gains: args.gains ?? [],
        offsets: args.offsets ?? [],
        durationSeconds: args.durationSeconds,
        fadeInSeconds: args.fadeInSeconds ?? 0,
        fadeOutSeconds: args.fadeOutSeconds ?? 0,
        limiter: args.limiter !== false,
        peakDbfs: Number.isFinite(args.peakDbfs) ? args.peakDbfs : -1
      })
      const result = await finish(cwd, mixed.samples, mixed.sampleRate, args.out, 'mix', hash, { peakDbfs: args.peakDbfs ?? -1 })
      // Say it in the result too: a caller that fed in stereo must not be
      // surprised by a mono file.
      const widestInput = Math.max(...tracks.map((track) => track.channels ?? 1))
      const foldNote = widestInput > 1 ? [`mono output (${widestInput}-ch input folded by averaging)`] : ['mono output']
      return {
        path: result.target,
        relativePath: displayPath(cwd, result.target),
        bytes: result.bytes,
        inputs: paths.length,
        channels: 1,
        foldedFrom: widestInput,
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
    description: 'Measure a .wav file: duration, sample rate, peak and RMS level, crest factor, DC offset, clipping, spectral centroid (brightness), onset count, and loop-seam level jump. Every channel is measured, not a mono fold: peak, clipping and DC are the worst channel\'s and a stereo pair that cancels in mono still measures. Multi-channel files also report `perChannel` (peak/clipping/DC per channel). Use it to verify a render, compare two takes numerically, or check that a loop will not thump.',
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
      const notes = []
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
      const channelText = metrics.channelCount > 1
        ? [`${metrics.channelCount} ch`, ...(metrics.perChannel ?? []).map((channel, index) => `ch${index + 1} ${fmt(channel.peakDbfs)} dBFS${channel.clipping > 0 ? ' CLIP' : ''}`)].join(' · ')
        : 'mono'
      const text = summaryLine('Measured', cwd, path, info.size, metrics, [
        channelText,
        `loop seam ${fmt(metrics.loopSeam)} dB`,
        notes.length > 0 ? `notes: ${notes.join(', ')}` : 'clean'
      ])
      return {
        path,
        relativePath: displayPath(cwd, path),
        bytes: info.size,
        channels: decoded.channelCount,
        metrics,
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

