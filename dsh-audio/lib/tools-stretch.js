/**
 * `audio_stretch`: make a sound fit a length it was not rendered at.
 *
 * This is the tool an animation agent reaches for when the picture and the audio
 * disagree about time: "the shot is 4.3 s, the cue is 6 s", "this loop is 100
 * bpm, the cut is at 125", "the voice take is 5 % too slow". Everything it does
 * goes through lib/stretch.js, so the summary it returns states the exact
 * duration in and out — a stretched cue that is 1 sample off is a lip-sync bug,
 * so the text reports durations to the millisecond rather than "about 4 s".
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  readTrack,
  renderPreset,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { softLimit } from './dsp.js'
import { STRETCH_LIMITS, fitToDuration, pitchShift, timeStretch } from './stretch.js'

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

function fixed (value, digits = 3) {
  return Number(value).toFixed(digits)
}

function sizeLabel (bytes) {
  return bytes > 1024 * 1024 ? `${fixed(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Load the sound to transform: a file on disk, or an inline render spec (so a
 * one-shot can be fitted to a shot without a separate audio_synth round trip).
 */
async function loadSource (cwd, args) {
  const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
  const hasRender = args.render !== undefined && args.render !== null
  if (hasPath && hasRender) throw new Error('audio_stretch: give either path or render, not both')
  if (hasPath) {
    const path = resolvePath(cwd, args.path)
    if (path === undefined) throw new Error('audio_stretch: path is empty')
    const track = await readTrack(path)
    return {
      samples: track.samples,
      sampleRate: track.sampleRate,
      label: displayPath(cwd, path),
      key: displayPath(cwd, path)
    }
  }
  if (!hasRender) throw new Error('audio_stretch: needs a source — pass path or render')
  const spec = args.render
  if (typeof spec.preset !== 'string') throw new Error('audio_stretch: render needs a preset name')
  const sampleRate = Number.isFinite(args.sampleRate) ? args.sampleRate : spec.sampleRate
  const rendered = renderPreset({
    preset: spec.preset,
    params: spec.params ?? {},
    duration: spec.duration,
    seed: spec.seed ?? 1,
    loop: spec.loop === true,
    sampleRate
  })
  // Match audio_synth: a rendered source starts at the same ceiling the other
  // render tools produce, so the level after stretching is comparable.
  finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
  return {
    samples: rendered.samples,
    sampleRate: rendered.sampleRate,
    label: `render ${spec.preset}`,
    key: JSON.stringify({ preset: spec.preset, params: spec.params ?? {}, duration: spec.duration, seed: spec.seed ?? 1, loop: spec.loop === true })
  }
}

/** Exactly one of the three ways to say what should change. */
function pickMode (args) {
  const modes = []
  if (Number.isFinite(args.factor)) modes.push('factor')
  if (Number.isFinite(args.targetSeconds)) modes.push('targetSeconds')
  if (Number.isFinite(args.semitones)) modes.push('semitones')
  if (modes.length !== 1) {
    throw new Error('audio_stretch: give exactly one of factor, targetSeconds or semitones')
  }
  return modes[0]
}

/** Soft-limit only when the stretch pushed the peak over full scale. */
function guardPeak (samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  if (peak > 1) softLimit(samples)
  return peak
}

/** Register the `audio_stretch` tool. */
export function registerStretchTools (ctx) {
  ctx.tools.register({
    name: 'audio_stretch',
    description: 'Change how long a sound lasts without changing its pitch (or shift its pitch without changing its length). Use it when the audio and the picture disagree about time: fit a 6 s cue onto a 4.3 s shot, retime a loop from 100 to 125 bpm, or nudge a voice up a couple of semitones. WSOLA time-domain stretching, so a stretch keeps pitch and a pitch shift keeps duration; formants move with pitch.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Source .wav, relative to the working directory or absolute. Give this or render, not both. Multi-channel files are summed to mono.' },
        render: {
          type: 'object',
          additionalProperties: true,
          description: 'Inline render instead of a file: { preset, params, duration, seed, loop } exactly as audio_synth accepts. Give this or path, not both.'
        },
        factor: { type: 'number', description: `Output length divided by input length: 0.5 = half as long (twice the tempo), 2 = twice as long. Range ${STRETCH_LIMITS.minFactor}..${STRETCH_LIMITS.maxFactor}. Give exactly one of factor, targetSeconds, semitones.` },
        targetSeconds: { type: 'number', description: 'Stretch so the result is exactly this long — e.g. fit a 6 s cue onto a 4.3 s shot. Pitch is kept.' },
        semitones: { type: 'number', description: `Pitch shift in semitones (-${STRETCH_LIMITS.maxSemitones}..${STRETCH_LIMITS.maxSemitones}) with the duration preserved. +12 = one octave up, same length.` },
        sampleRate: { type: 'integer', description: 'Sample rate for an inline render (default 44100). A path input keeps the file\'s own rate.' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/stretch-<hash>.wav.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Stretch ${typeof args.path === 'string' ? args.path : (args.render?.preset ?? 'audio')}`,
      kind: 'other',
      rawInput: { path: args.path, render: args.render?.preset, factor: args.factor, targetSeconds: args.targetSeconds, semitones: args.semitones }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const source = await loadSource(cwd, args)
      const rate = source.sampleRate
      const input = source.samples
      const mode = pickMode(args)
      const inputSeconds = input.length / rate

      let output
      let factor
      let method
      let change

      if (mode === 'semitones') {
        const semitones = Number(args.semitones)
        if (Math.abs(semitones) > STRETCH_LIMITS.maxSemitones) {
          throw new Error(`audio_stretch: ${semitones} semitones is outside -${STRETCH_LIMITS.maxSemitones}..${STRETCH_LIMITS.maxSemitones}`)
        }
        output = pitchShift(input, rate, semitones)
        factor = 1
        method = 'pitch'
        const ratio = Math.pow(2, semitones / 12)
        change = `${semitones > 0 ? '+' : ''}${fixed(semitones, 2)} semitones (pitch x${fixed(ratio, 3)}, duration kept)`
      } else if (mode === 'factor') {
        factor = Number(args.factor)
        if (factor < STRETCH_LIMITS.minFactor || factor > STRETCH_LIMITS.maxFactor) {
          throw new Error(`audio_stretch: factor ${factor} is outside ${STRETCH_LIMITS.minFactor}..${STRETCH_LIMITS.maxFactor} (output length / input length)`)
        }
        output = timeStretch(input, rate, factor)
        method = 'stretch'
        change = `factor ${fixed(factor, 3)} (${factor < 1 ? `${fixed((1 - factor) * 100, 1)}% shorter` : `${fixed((factor - 1) * 100, 1)}% longer`}, pitch kept)`
      } else {
        const target = Number(args.targetSeconds)
        if (!Number.isFinite(target) || target <= 0) throw new Error(`audio_stretch: targetSeconds must be positive, got ${args.targetSeconds}`)
        const fitted = fitToDuration(input, rate, target)
        output = fitted.samples
        factor = fitted.factor
        method = fitted.method
        change = `fit to ${fixed(target, 3)}s (factor ${fixed(fitted.factor, 3)}, pitch kept)`
      }

      guardPeak(output)
      const metrics = { ...measure(output, rate), sampleRate: rate }
      const outputSeconds = output.length / rate
      const hash = hashSpec({
        source: source.key,
        mode,
        factor,
        semitones: mode === 'semitones' ? Number(args.semitones) : undefined,
        targetSeconds: mode === 'targetSeconds' ? Number(args.targetSeconds) : undefined,
        sampleRate: rate
      })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'stretch', hash)
      const bytes = toWavBytes(output, rate)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)

      const text = [
        `Stretched ${source.label} ${fixed(inputSeconds)}s -> ${fixed(outputSeconds)}s`,
        change,
        `${rate} Hz`,
        `peak ${Number(metrics.peakDbfs).toFixed(1)} dBFS`,
        `rms ${Number(metrics.rmsDbfs).toFixed(1)} dBFS`,
        sizeLabel(info.size ?? bytes.length)
      ].join(' · ')

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size ?? bytes.length,
        durationSeconds: Number(outputSeconds.toFixed(4)),
        inputDurationSeconds: Number(inputSeconds.toFixed(4)),
        sampleRate: rate,
        factor: Number(factor.toFixed(6)),
        method,
        metrics,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
