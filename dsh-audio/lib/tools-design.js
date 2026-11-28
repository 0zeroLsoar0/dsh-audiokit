/**
 * `audio_design`: the layering tool.
 *
 * One call instead of "render four presets, then mix them": the model names a
 * recipe (or hands in a layer stack) and gets one file whose layers share a
 * seed, an envelope, a reverb and a peak target. It returns the same bounded
 * summary as the other render tools, plus the layer breakdown — the arrangement
 * is the interesting part, so the model should see it without listening.
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { defaultOutputPath, hashSpec, measure, resolvePath, toWavBytes, writeFileAtomic } from './audio.js'
import { PRESETS } from './dsp.js'
import { RECIPES, designSound } from './design.js'

const PRESET_NAMES = Object.keys(PRESETS)
const RECIPE_IDS = Object.keys(RECIPES)

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
  return parts.join(' · ')
}

/** The arrangement, in the order it was rendered. */
function layerLine (layers) {
  const parts = layers.map((layer) => `${layer.preset} ${fmt(layer.gainDb)} dB @ ${Math.round(layer.offsetSeconds * 1000)} ms`)
  return `layers (${layers.length}): ${parts.join(' · ')}`
}

/** Register the `audio_design` tool. */
export function registerDesignTools (ctx) {
  ctx.tools.register({
    name: 'audio_design',
    description: 'Render a complete layered sound design in one call: give `recipe` for a tuned multi-layer design or `layers` for a hand-built stack, sharing one seed, envelope, reverb and key. Deterministic, and returns the layer breakdown.',
    parameters: {
      type: 'object',
      properties: {
        recipe: {
          type: 'string',
          enum: RECIPE_IDS,
          description: 'Named design recipe with layers, envelope, reverb and length already tuned (one line per recipe in the animation-sound skill). Creature recipes: insect-swarm, hoofbeats, wing-flap, creature-breath, creature-hiss, bird-chirp, bird-flock, whale-song, wolf-howl, frog-croak, rodent-squeak, bat-echolocation.'
        },
        layers: {
          type: 'array',
          description: 'Explicit layer stack instead of `recipe`; each layer is one preset on the design timeline.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              preset: { type: 'string', enum: PRESET_NAMES, description: 'Preset that becomes this layer.' },
              params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs for that preset (same names as audio_synth).' },
              offsetMs: { type: 'number', description: 'Placement in the design timeline, in milliseconds; defaults to 0.' },
              gainDb: { type: 'number', description: 'Level of this layer relative to the others, in dB; defaults to 0.' },
              duration: { type: 'number', description: 'Layer length in seconds; defaults to the preset length.' },
              pitchScale: { type: 'number', description: 'Coarse pitch multiplier (0.25..4); defaults to 1.' },
              detuneCents: { type: 'number', description: 'Fine detune in cents (-1200..1200), applied by repitching the layer.' },
              filter: {
                type: 'object',
                additionalProperties: false,
                description: 'Tone shaping for this layer only.',
                properties: {
                  mode: { type: 'string', enum: ['lp', 'hp', 'bp'], description: 'Low-pass, high-pass or band-pass; defaults to lp.' },
                  cutoffHz: { type: 'number', description: 'Cutoff in Hz; defaults to 2000.' },
                  toHz: { type: 'number', description: 'Optional cutoff after the layer ends, for a sweep.' },
                  q: { type: 'number', description: 'Resonance; defaults to 0.8.' }
                }
              }
            },
            required: ['preset']
          }
        },
        seed: { type: 'integer', description: 'Variation seed. Same seed reproduces the same take; 1 by default.' },
        variant: { type: 'integer', description: 'Alternative take of the same design; use seed for a different random surface.' },
        intensity: { type: 'number', description: '0..1 (default 1): below 1 is gentler, darker and quieter.' },
        duration: { type: 'number', description: 'Override the design length in seconds; longer pads the tail, shorter trims it.' },
        sampleRate: { type: 'integer', description: 'Sample rate; default 44100 (22050 for inline, 48000 for video).' },
        loop: { type: 'boolean', description: 'Render a seamless loop. Recipe loops (ids ending in -loop) already default to true.' },
        out: { type: 'string', description: 'Output path; default assets/audio/<recipe>-<hash>.wav.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Design ${args.recipe ?? `${args.layers?.length ?? 0} layers`}`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const wantsLayers = Array.isArray(args.layers) && args.layers.length > 0
      if (typeof args.recipe !== 'string' && !wantsLayers) {
        throw new Error('audio_design needs a `recipe` id or a non-empty `layers` array')
      }

      const seed = Number.isFinite(args.seed) ? Math.round(args.seed) : 1
      const variant = Number.isFinite(args.variant) ? Math.round(args.variant) : 0
      const intensity = Number.isFinite(args.intensity) ? Number(args.intensity) : 1
      const sampleRate = Number.isFinite(args.sampleRate) ? Math.round(args.sampleRate) : 44100

      const design = designSound({
        recipe: args.recipe,
        layers: wantsLayers ? args.layers : undefined,
        seed,
        variant,
        intensity,
        sampleRate,
        loop: typeof args.loop === 'boolean' ? args.loop : undefined,
        duration: Number.isFinite(args.duration) ? Number(args.duration) : undefined
      })

      // Hash the resolved design, not the raw arguments: a recipe and the same
      // arrangement written out as explicit layers are the same sound and
      // should land on the same file name.
      const hash = hashSpec({
        recipe: design.recipe,
        layers: design.layers.map((layer) => [layer.preset, layer.offsetSeconds, layer.gainDb, layer.durationSeconds]),
        seed,
        variant,
        intensity: design.intensity,
        sampleRate: design.sampleRate,
        loop: design.loop,
        durationSeconds: design.durationSeconds
      })
      const label = design.recipe === 'custom' ? 'design' : design.recipe
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, label, hash)
      // The encoder's dither is seeded (see lib/wav.js), so the same design
      // always produces the same bytes and the hash in the file name stays
      // trustworthy as a cache key.
      await writeFileAtomic(target, toWavBytes(design.samples, design.sampleRate))
      const info = await stat(target)
      const metrics = { ...measure(design.samples, design.sampleRate), sampleRate: design.sampleRate }
      const extra = design.loop ? [`loop seam ${fmt(metrics.loopSeam)} dB`] : []
      const headline = summaryLine(`Designed ${design.recipe} into`, cwd, target, info.size, metrics, extra)

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: metrics.durationSeconds,
        sampleRate: design.sampleRate,
        recipe: design.recipe,
        loop: design.loop,
        intensity: design.intensity,
        layers: design.layers,
        metrics,
        text: `${headline}\n${layerLine(design.layers)}`
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
