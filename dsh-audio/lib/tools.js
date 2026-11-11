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
  mixTracks,
  readTrack,
  renderPattern,
  renderPreset,
  resolvePath,
  toWavBytes,
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
  return parts.join(' 路 ')
}

async function finish (cwd, samples, sampleRate, requestedOut, label, hash, options = {}) {
  finalize(samples, sampleRate, options.peakDbfs ?? -1)
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
        params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs in 0..1 (pitch is 0..1 for tick/chime/zap/thud/scrap and 0.5..2 for impact/whoosh): weight, hardness, metallic, space, tone, brightness, speed, rise, decay, density, roughness, movement, pitch, pitchJitter. For preset "texture" add kind: wind|rain|fire|room|hum.' },
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
      const spec = { preset: args.preset, params: args.params ?? {}, duration: args.duration, seed: args.seed ?? 1, loop: args.loop === true, sampleRate: args.sampleRate ?? 44100 }
      const hash = hashSpec(spec)
      const rendered = renderPreset({ ...spec, params: spec.params })
      const result = await finish(cwd, rendered.samples, rendered.sampleRate, args.out, args.preset, hash)
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
    description: 'Fill a span of time with a generated sequence of one preset: an even or accelerating train, a random scatter, or a riser. This is how dense textures are made without dozens of separate renders 鈥?one call with every=0.08 and an accelerating curve produces a hundred events that share a single coherent motion.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset repeated by the pattern.' },
        kind: { type: 'string', enum: ['train', 'scatter', 'riser'], description: 'train=evenly spaced (curve reshapes spacing), scatter=random positions, riser=one continuous rising sweep.' },
        from: { type: 'number', description: 'Start offset in seconds within the pattern file; defaults to 0.' },
        to: { type: 'number', description: 'End of the span in seconds; defaults to 4.' },
        every: { type: 'number', description: 'Spacing between events in seconds; ignored when count is given.' },
        count: { type: 'integer', description: 'Exact number of events instead of a spacing.' },
        curve: { type: 'string', enum: ['linear', 'accelerando', 'ritardando', 'ease'], description: 'How spacing changes across the span. accelerando crowds events toward the end.' },
        jitter: { type: 'number', description: '0..1 timing randomness; keeps a train from sounding mechanical.' },
        accentEvery: { type: 'integer', description: 'Accent every Nth event (e.g. 4 for a 4/4 feel).' },
        pitchFrom: { type: 'number', description: 'First event pitch knob (0..1); combined with pitchTo it glides across the span.' },
        pitchTo: { type: 'number', description: 'Last event pitch knob (0..1).' },
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
    description: 'Mix existing .wav files into one track with per-input gain, fades, peak normalisation and a limiter. Use it to assemble a finished cue from individually tweaked sounds, or to combine a bed with the hits that land on top of it.',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Input .wav paths, relative to the working directory or absolute.' },
        offsets: { type: 'array', items: { type: 'number' }, description: 'Start time of each input in seconds, same order as inputs. This is what turns a set of one-shots into a cue track; omit for 0.' },
        gains: { type: 'array', items: { type: 'number' }, description: 'Per-input gain in dB, same order as inputs (e.g. -6 quiets an input by 6 dB).' },
        durationSeconds: { type: 'number', description: 'Trim or pad the result to this length; defaults to the longest input.' },
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
      return {
        path: result.target,
        relativePath: displayPath(cwd, result.target),
        bytes: result.bytes,
        inputs: paths.length,
        durationSeconds: result.metrics.durationSeconds,
        metrics: result.metrics,
        text: summaryLine(`Mixed ${paths.length} track(s) into`, cwd, result.target, result.bytes, result.metrics)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })

  ctx.tools.register({
    name: 'audio_probe',
    description: 'Measure a .wav file: duration, sample rate, peak and RMS level, crest factor, DC offset, clipping, spectral centroid (brightness), onset count, and loop-seam level jump. Use it to verify a render, compare two takes numerically, or check that a loop will not thump.',
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
      const track = await readTrack(path)
      const metrics = { ...measure(track.samples, track.sampleRate), sampleRate: track.sampleRate }
      const info = await stat(path)
      const notes = []
      if (metrics.clipping > 0) notes.push('clipping')
      if (metrics.loopSeam > 6) notes.push('loop seam will thump (render with loop:true)')
      if (metrics.dcOffset > 0.02) notes.push('DC offset')
      if (Number.isFinite(args.expectDuration) && Math.abs(metrics.durationSeconds - args.expectDuration) > 0.05) {
        notes.push(`duration ${fmt(metrics.durationSeconds, 2)}s != expected ${fmt(args.expectDuration, 2)}s`)
      }
      const text = summaryLine('Measured', cwd, path, info.size, metrics, [
        `loop seam ${fmt(metrics.loopSeam)} dB`,
        notes.length > 0 ? `notes: ${notes.join(', ')}` : 'clean'
      ])
      return {
        path,
        relativePath: displayPath(cwd, path),
        bytes: info.size,
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

