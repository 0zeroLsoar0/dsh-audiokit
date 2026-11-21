/**
 * Layering engine: named design recipes built from stacked presets.
 *
 * A single preset is one layer of a real sound. A steel door slamming is a sub
 * thump, a mid crack, a latch rattle and a ringing metal tail *at the same
 * instant*; what makes it a door and not a "thud" is that the layers share one
 * key, one decay envelope and one space. Assembling that by hand costs four
 * `audio_synth` renders plus an `audio_mix`, and the layers still land at
 * arbitrary levels.
 *
 * A recipe is the same arrangement written down: ordered layers with offsets
 * and gains, plus a master reverb/envelope/length. `designSound` renders it
 * deterministically from one seed, so a model can pick a sound by name and get
 * the same bytes every time. Nothing here invents synthesis — it only decides
 * where each existing preset sits, how loud it is and what space it shares.
 *
 * Layer shape (all fields but `preset` optional):
 *   { preset, params, offsetMs, gainDb, duration, pitchScale, detuneCents, filter }
 *   - offsetMs     placement in the design timeline
 *   - gainDb       level relative to the other layers (before intensity)
 *   - duration     seconds; omitted = preset length (and, in a loop, the whole
 *                  loop so the layer becomes a seamless bed)
 *   - pitchScale   coarse pitch: multiplies the preset's pitch knob when it has
 *                  one, otherwise repitches the finished layer
 *   - detuneCents  fine pitch (cents), applied by repitching the finished layer
 *   - filter       { mode: 'lp'|'hp'|'bp', cutoffHz, toHz?, q? } tone shaping
 *
 * Master shape: { reverb?, fadeInMs?, fadeOutMs?, targetDurationMs?, loop? }
 *   - reverb  number (wet amount) or { amount, size }
 *   - loop    marks the design as a seamless bed; the loop is rendered twice
 *             and the second pass is kept, so reverb arrives at the seam at
 *             full strength instead of starting from silence.
 */

import { renderPreset } from './audio.js'
import {
  PRESETS,
  addInto,
  clamp,
  dbToGain,
  dcBlock,
  filter,
  lerp,
  makeRng,
  normalizePeak,
  reverb,
  softLimit,
  unit
} from './dsp.js'

const TILT_HZ = 750
const MAX_LAYERS = 32
const GUARD_FADE_SECONDS = 0.012

/* ---------------------------------------------------------------- recipes -- */

/**
 * The out-of-the-box sound vocabulary.
 *
 * Each entry is a complete design, not a variation: the layer list is tuned so
 * the layers complement (weight under crack under ring), never so that they
 * simply stack volume. `master.targetDurationMs` is chosen to leave room for
 * the reverb tail after the last layer ends.
 *
 * @type {Record<string, { id: string, description: string, layers: object[], master: object }>}
 */
export const RECIPES = {
  'door-slam-metal': {
    id: 'door-slam-metal',
    description: 'Heavy steel fire door slammed shut: sub thump, mid crack, latch rattle and a ringing metal tail.',
    layers: [
      { preset: 'thud', params: { weight: 0.95, softness: 0.2, space: 0.12 }, gainDb: -1.5 },
      { preset: 'impact', params: { weight: 0.82, hardness: 0.72, metallic: 0.78, space: 0.18, tone: 0.4 }, gainDb: -2 },
      { preset: 'scrap', params: { density: 0.9, tone: 0.55, roughness: 0.85, space: 0.18 }, offsetMs: 18, gainDb: -7 },
      { preset: 'chime', params: { pitch: 0.16, decay: 0.85, metallic: 0.92, space: 0.45 }, gainDb: -13, filter: { mode: 'lp', cutoffHz: 4200 } },
      { preset: 'texture', params: { kind: 'room', density: 0.4, tone: 0.35, movement: 0.2 }, duration: 0.6, gainDb: -26 }
    ],
    master: { reverb: { amount: 0.3, size: 0.55 }, targetDurationMs: 1600 }
  },

  'door-close-soft': {
    id: 'door-close-soft',
    description: 'Interior door pulled shut: soft body thud, quiet latch click, small room bloom.',
    layers: [
      { preset: 'thud', params: { weight: 0.55, softness: 0.85, space: 0.25 }, gainDb: -1 },
      { preset: 'impact', params: { weight: 0.3, hardness: 0.22, metallic: 0.12, space: 0.3, tone: 0.35 }, gainDb: -6 },
      { preset: 'tick', params: { pitch: 0.28, hardness: 0.35 }, offsetMs: 8, gainDb: -16 },
      { preset: 'texture', params: { kind: 'room', density: 0.35, tone: 0.3, movement: 0.15 }, duration: 0.5, offsetMs: 30, gainDb: -24 }
    ],
    master: { reverb: { amount: 0.2, size: 0.4 }, targetDurationMs: 1000 }
  },

  'glass-break': {
    id: 'glass-break',
    description: 'Window shattering: hard crack, spray of shards, glassy ring, settling tinkle.',
    layers: [
      { preset: 'tick', params: { pitch: 0.98, hardness: 1 }, gainDb: -7 },
      { preset: 'scrap', params: { density: 1, tone: 0.92, roughness: 0.95, space: 0.25 }, offsetMs: 12, gainDb: -9 },
      { preset: 'chime', params: { pitch: 0.85, decay: 0.22, metallic: 0.95, space: 0.45 }, gainDb: -3 },
      { preset: 'chime', params: { pitch: 0.68, decay: 0.3, metallic: 0.9, space: 0.45 }, duration: 0.8, offsetMs: 85, gainDb: -6 },
      { preset: 'impact', params: { weight: 0.15, hardness: 0.95, metallic: 0.5, space: 0.2, pitch: 1.5 }, gainDb: -16 },
      { preset: 'scrap', params: { density: 0.45, tone: 0.98, roughness: 0.5, space: 0.3 }, offsetMs: 220, gainDb: -22, filter: { mode: 'hp', cutoffHz: 2600 } }
    ],
    master: { reverb: { amount: 0.34, size: 0.6 }, targetDurationMs: 1400 }
  },

  'wood-crack': {
    id: 'wood-crack',
    description: 'Dry wood splitting: hard mid crack, splintering grains, short woody body.',
    layers: [
      { preset: 'impact', params: { weight: 0.38, hardness: 0.8, metallic: 0.08, space: 0.12, tone: 0.6 }, gainDb: -1 },
      { preset: 'scrap', params: { density: 0.5, tone: 0.28, roughness: 0.95, space: 0.1 }, offsetMs: 6, gainDb: -6 },
      { preset: 'thud', params: { weight: 0.5, softness: 0.55, space: 0.1 }, gainDb: -7 },
      { preset: 'tick', params: { pitch: 0.45, hardness: 0.8 }, offsetMs: 2, gainDb: -14 }
    ],
    master: { reverb: { amount: 0.12, size: 0.3 }, targetDurationMs: 800 }
  },

  'explosion-far': {
    id: 'explosion-far',
    description: 'Distant blast: muffled boom, long rolling rumble, wide air tail.',
    layers: [
      { preset: 'impact', params: { weight: 1, hardness: 0.12, metallic: 0.05, space: 0.6, tone: 0.2, pitch: 0.8 }, gainDb: -2, filter: { mode: 'lp', cutoffHz: 520 } },
      { preset: 'thud', params: { weight: 1, softness: 0.95, space: 0.55 }, gainDb: -3 },
      { preset: 'texture', params: { kind: 'wind', density: 0.55, tone: 0.15, movement: 0.4 }, duration: 2.2, gainDb: -12, filter: { mode: 'lp', cutoffHz: 900 } },
      { preset: 'scrap', params: { density: 0.25, tone: 0.1, roughness: 0.7 }, duration: 1.5, gainDb: -22, filter: { mode: 'lp', cutoffHz: 400 } }
    ],
    master: { reverb: { amount: 0.55, size: 0.9 }, targetDurationMs: 2800 }
  },

  'explosion-near': {
    id: 'explosion-near',
    description: 'Close blast: full sub punch, bright crack, debris spray and a burning tail.',
    layers: [
      { preset: 'thud', params: { weight: 1, softness: 0.5, space: 0.2 }, gainDb: -2 },
      { preset: 'impact', params: { weight: 0.65, hardness: 0.5, metallic: 0.35, space: 0.3, tone: 0.45 }, gainDb: -3 },
      { preset: 'scrap', params: { density: 0.8, tone: 0.22, roughness: 0.9, space: 0.25 }, offsetMs: 10, gainDb: -12 },
      { preset: 'texture', params: { kind: 'fire', density: 0.6, tone: 0.4, movement: 0.55 }, duration: 1.5, offsetMs: 40, gainDb: -1 },
      { preset: 'texture', params: { kind: 'rain', density: 0.5, tone: 0.45, movement: 0.45 }, duration: 1.5, offsetMs: 60, gainDb: -5 },
      { preset: 'texture', params: { kind: 'wind', density: 0.5, tone: 0.25, movement: 0.35 }, duration: 1.6, gainDb: -10, filter: { mode: 'hp', cutoffHz: 45 } }
    ],
    master: { reverb: { amount: 0.24, size: 0.5 }, targetDurationMs: 1800 }
  },

  'whoosh-into-impact': {
    id: 'whoosh-into-impact',
    description: 'A swing that lands: air sweep into one heavy hit with a dust tail.',
    layers: [
      { preset: 'whoosh', params: { speed: 0.85, tone: 0.5, rise: 0.55, space: 0.15 }, duration: 0.75, gainDb: -4 },
      { preset: 'riser', params: { tone: 0.35, tension: 0.55, space: 0.2 }, duration: 0.72, gainDb: -14 },
      { preset: 'impact', params: { weight: 0.9, hardness: 0.75, metallic: 0.4, space: 0.25, tone: 0.5 }, offsetMs: 700, gainDb: -0.5 },
      { preset: 'thud', params: { weight: 0.85, softness: 0.3, space: 0.2 }, offsetMs: 700, gainDb: -6 },
      { preset: 'scrap', params: { density: 0.45, tone: 0.4, roughness: 0.8, space: 0.2 }, offsetMs: 730, gainDb: -14 }
    ],
    master: { reverb: { amount: 0.26, size: 0.45 }, targetDurationMs: 2000 }
  },

  'sci-fi-charge': {
    id: 'sci-fi-charge',
    description: 'Energy weapon charging: rising whine, electric crackle, then a locked-in discharge.',
    layers: [
      { preset: 'riser', params: { tone: 0.75, tension: 0.85, space: 0.35 }, duration: 1.15, gainDb: -4 },
      { preset: 'texture', params: { kind: 'hum', density: 0.65, tone: 0.4, movement: 0.3 }, duration: 1.2, gainDb: -13 },
      { preset: 'zap', params: { pitch: 0.85, roughness: 0.5, space: 0.3 }, offsetMs: 1100, gainDb: -5 },
      { preset: 'chime', params: { pitch: 0.6, decay: 0.5, metallic: 0.75, space: 0.4 }, duration: 0.8, offsetMs: 1090, gainDb: -10 },
      { preset: 'tick', params: { pitch: 0.75, hardness: 0.9 }, offsetMs: 1095, gainDb: -18 }
    ],
    master: { reverb: { amount: 0.35, size: 0.6 }, targetDurationMs: 1900 }
  },

  'sci-fi-hum-loop': {
    id: 'sci-fi-hum-loop',
    description: 'Spaceship drive hum: steady low drone, airy machine whine; loops seamlessly.',
    layers: [
      { preset: 'texture', params: { kind: 'hum', density: 0.8, tone: 0.5, movement: 0.2 }, gainDb: -4 },
      { preset: 'texture', params: { kind: 'wind', density: 0.5, tone: 0.28, movement: 0.55 }, gainDb: -13, filter: { mode: 'lp', cutoffHz: 420 } },
      { preset: 'texture', params: { kind: 'room', density: 0.5, tone: 0.4, movement: 0.2 }, gainDb: -18 }
    ],
    master: { loop: true, reverb: { amount: 0.12, size: 0.6 }, targetDurationMs: 3000 }
  },

  'magic-sparkle': {
    id: 'magic-sparkle',
    description: 'Fairy shimmer: bright bell chord, sparkle ticks, airy shimmer tail.',
    layers: [
      { preset: 'chime', params: { pitch: 0.82, decay: 0.6, metallic: 0.85, space: 0.5 }, gainDb: -3 },
      { preset: 'chime', params: { pitch: 0.93, decay: 0.5, metallic: 0.8, space: 0.5 }, offsetMs: 70, gainDb: -8 },
      { preset: 'chime', params: { pitch: 0.7, decay: 0.45, metallic: 0.7, space: 0.5 }, offsetMs: 150, gainDb: -11 },
      { preset: 'tick', params: { pitch: 0.95, hardness: 0.85 }, gainDb: -9 },
      { preset: 'scrap', params: { density: 0.35, tone: 0.98, roughness: 0.25, space: 0.35 }, duration: 0.7, offsetMs: 120, gainDb: -17, filter: { mode: 'hp', cutoffHz: 3200 } },
      { preset: 'texture', params: { kind: 'wind', density: 0.3, tone: 0.85, movement: 0.6 }, duration: 1.2, gainDb: -24, filter: { mode: 'hp', cutoffHz: 1800 } }
    ],
    master: { reverb: { amount: 0.4, size: 0.7 }, targetDurationMs: 1700 }
  },

  'magic-dark': {
    id: 'magic-dark',
    description: 'Dark spell: sub bell, swelling undertow, grit and a long cavern tail.',
    layers: [
      { preset: 'chime', params: { pitch: 0.1, decay: 0.85, metallic: 0.45, space: 0.6 }, gainDb: -3, filter: { mode: 'lp', cutoffHz: 900 } },
      { preset: 'texture', params: { kind: 'hum', density: 0.5, tone: 0.2, movement: 0.4 }, duration: 1.8, gainDb: -13 },
      { preset: 'riser', params: { tone: 0.1, tension: 0.35, space: 0.6 }, duration: 1.5, gainDb: -16 },
      { preset: 'scrap', params: { density: 0.35, tone: 0.15, roughness: 0.8, space: 0.4 }, duration: 1.2, gainDb: -19, filter: { mode: 'lp', cutoffHz: 1400 } },
      { preset: 'zap', params: { pitch: 0.2, roughness: 0.7, space: 0.4 }, offsetMs: 50, gainDb: -15 }
    ],
    master: { reverb: { amount: 0.5, size: 0.85 }, targetDurationMs: 2400 }
  },

  'water-drip': {
    id: 'water-drip',
    description: 'Single drop into water: tiny plink, fast falling pitch, small cavern wash.',
    layers: [
      { preset: 'zap', params: { pitch: 0.9, roughness: 0.12, space: 0.3 }, gainDb: -4 },
      { preset: 'tick', params: { pitch: 0.98, hardness: 0.9 }, gainDb: -14 },
      { preset: 'chime', params: { pitch: 0.95, decay: 0.08, metallic: 0.15, space: 0.25 }, duration: 0.4, gainDb: -12 },
      { preset: 'texture', params: { kind: 'rain', density: 0.12, tone: 0.55, movement: 0.3 }, duration: 0.4, offsetMs: 30, gainDb: -30 }
    ],
    master: { reverb: { amount: 0.4, size: 0.55 }, targetDurationMs: 800 }
  },

  'water-splash': {
    id: 'water-splash',
    description: 'Splash into water: bright burst, spray hiss, low body and a wet tail.',
    layers: [
      { preset: 'whoosh', params: { speed: 0.9, tone: 0.65, rise: 0.35, space: 0.2 }, duration: 0.4, gainDb: -4 },
      { preset: 'texture', params: { kind: 'rain', density: 0.85, tone: 0.6, movement: 0.7 }, duration: 0.9, offsetMs: 30, gainDb: -7 },
      { preset: 'scrap', params: { density: 0.85, tone: 0.5, roughness: 0.4, space: 0.2 }, offsetMs: 10, gainDb: -11 },
      { preset: 'thud', params: { weight: 0.35, softness: 0.45, space: 0.2 }, gainDb: -11 }
    ],
    master: { reverb: { amount: 0.3, size: 0.5 }, targetDurationMs: 1200 }
  },

  'footstep-gravel': {
    id: 'footstep-gravel',
    description: 'Boot on gravel: dull body, grit crunch, one short scatter of stones.',
    layers: [
      { preset: 'thud', params: { weight: 0.6, softness: 0.3, space: 0.08 }, gainDb: -5 },
      { preset: 'scrap', params: { density: 0.55, tone: 0.32, roughness: 0.9, space: 0.06 }, offsetMs: 12, gainDb: -10 },
      { preset: 'tick', params: { pitch: 0.18, hardness: 0.4 }, gainDb: -20 }
    ],
    master: { reverb: { amount: 0.1, size: 0.25 }, targetDurationMs: 650 }
  },

  'cloth-rustle': {
    id: 'cloth-rustle',
    description: 'Fabric moving: soft airy swish, fine thread crackle, no pitch.',
    layers: [
      { preset: 'texture', params: { kind: 'rain', density: 0.65, tone: 0.8, movement: 0.85 }, duration: 0.55, gainDb: -7, filter: { mode: 'hp', cutoffHz: 700 } },
      { preset: 'scrap', params: { density: 0.95, tone: 0.85, roughness: 0.3, space: 0.1 }, duration: 0.5, gainDb: -7, filter: { mode: 'hp', cutoffHz: 1400 } },
      { preset: 'whoosh', params: { speed: 0.3, tone: 0.9, rise: 0.5, space: 0.1 }, duration: 0.45, gainDb: -13 }
    ],
    master: { reverb: { amount: 0.12, size: 0.3 }, targetDurationMs: 650 }
  },

  'ui-success': {
    id: 'ui-success',
    description: 'Confirmation: two rising bell notes, clean and short.',
    layers: [
      { preset: 'chime', params: { pitch: 0.55, decay: 0.45, metallic: 0.3, space: 0.2 }, duration: 0.6, gainDb: -4 },
      { preset: 'chime', params: { pitch: 0.72, decay: 0.5, metallic: 0.35, space: 0.25 }, duration: 0.6, offsetMs: 105, gainDb: -5 },
      { preset: 'tick', params: { pitch: 0.7, hardness: 0.6 }, gainDb: -22 }
    ],
    master: { reverb: { amount: 0.15, size: 0.35 }, targetDurationMs: 800 }
  },

  'ui-error': {
    id: 'ui-error',
    description: 'Rejection: low buzz, short muted chime, second descending buzz.',
    layers: [
      { preset: 'zap', params: { pitch: 0.42, roughness: 0.55, space: 0.15 }, gainDb: -5 },
      { preset: 'chime', params: { pitch: 0.18, decay: 0.15, metallic: 0.5, space: 0.2 }, duration: 0.45, gainDb: -9 },
      { preset: 'zap', params: { pitch: 0.34, roughness: 0.6, space: 0.15 }, offsetMs: 135, gainDb: -8 },
      { preset: 'tick', params: { pitch: 0.2, hardness: 0.5 }, gainDb: -18 }
    ],
    master: { reverb: { amount: 0.1, size: 0.3 }, targetDurationMs: 600 }
  },

  'ui-hover': {
    id: 'ui-hover',
    description: 'Hover tick: one tiny bright blip, barely there.',
    layers: [
      { preset: 'chime', params: { pitch: 0.9, decay: 0.05, metallic: 0.1, space: 0.1 }, duration: 0.14, gainDb: -4 },
      { preset: 'tick', params: { pitch: 0.85, hardness: 0.6 }, gainDb: -14 }
    ],
    master: { reverb: { amount: 0.05, size: 0.25 }, targetDurationMs: 180 }
  },

  'machinery-loop': {
    id: 'machinery-loop',
    description: 'Running machine: motor drone, piston thuds on a 400 ms grid, metal ticks; loops seamlessly.',
    layers: [
      { preset: 'texture', params: { kind: 'hum', density: 0.6, tone: 0.45, movement: 0.2 }, gainDb: -8 },
      { preset: 'texture', params: { kind: 'room', density: 0.5, tone: 0.35, movement: 0.2 }, gainDb: -17 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 200, gainDb: -12 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 600, gainDb: -12 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 1000, gainDb: -12 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 1400, gainDb: -12 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 1800, gainDb: -12 },
      { preset: 'thud', params: { weight: 0.7, softness: 0.35, space: 0.1 }, duration: 0.4, offsetMs: 2200, gainDb: -12 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.6 }, duration: 0.06, offsetMs: 520, gainDb: -24 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.6 }, duration: 0.06, offsetMs: 1320, gainDb: -24 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.6 }, duration: 0.06, offsetMs: 2120, gainDb: -24 }
    ],
    master: { loop: true, reverb: { amount: 0.12, size: 0.4 }, targetDurationMs: 3000 }
  },

  'creature-scream': {
    id: 'creature-scream',
    description: 'Monster shriek: rasping scrape, screaming sweep up, electric edge, ringing throat.',
    layers: [
      { preset: 'scrap', params: { density: 0.9, tone: 0.6, roughness: 0.95, space: 0.3 }, duration: 1.1, gainDb: -3 },
      { preset: 'riser', params: { tone: 0.6, tension: 0.9, space: 0.3 }, duration: 0.9, gainDb: -9 },
      { preset: 'zap', params: { pitch: 0.65, roughness: 0.85, space: 0.25 }, offsetMs: 60, gainDb: -8 },
      { preset: 'chime', params: { pitch: 0.35, decay: 0.35, metallic: 0.9, space: 0.4 }, duration: 0.9, gainDb: -11 },
      { preset: 'whoosh', params: { speed: 0.8, tone: 0.55, rise: 0.6, space: 0.25 }, duration: 0.7, offsetMs: 30, gainDb: -11 }
    ],
    master: { reverb: { amount: 0.3, size: 0.55 }, targetDurationMs: 1400 }
  },

  'creature-growl': {
    id: 'creature-growl',
    description: 'Low growl: weighty body, wavering breath, gritty undertone.',
    layers: [
      { preset: 'thud', params: { weight: 0.85, softness: 0.9, space: 0.15 }, gainDb: -4 },
      { preset: 'texture', params: { kind: 'wind', density: 0.65, tone: 0.22, movement: 0.95 }, duration: 1.3, gainDb: -9, filter: { mode: 'lp', cutoffHz: 1400 } },
      { preset: 'scrap', params: { density: 0.3, tone: 0.15, roughness: 0.85, space: 0.2 }, duration: 1.2, gainDb: -11, filter: { mode: 'lp', cutoffHz: 1200 } },
      { preset: 'zap', params: { pitch: 0.12, roughness: 0.95, space: 0.2 }, offsetMs: 40, gainDb: -17 }
    ],
    master: { reverb: { amount: 0.18, size: 0.45 }, targetDurationMs: 1500 }
  },

  heartbeat: {
    id: 'heartbeat',
    description: 'Heartbeat pair: deep lub then softer dub, chest room around it.',
    layers: [
      { preset: 'thud', params: { weight: 0.95, softness: 0.25, space: 0.1 }, gainDb: -1 },
      { preset: 'thud', params: { weight: 0.85, softness: 0.4, space: 0.12 }, offsetMs: 270, gainDb: -5 },
      { preset: 'texture', params: { kind: 'room', density: 0.3, tone: 0.2, movement: 0.15 }, duration: 0.6, gainDb: -28 }
    ],
    master: { reverb: { amount: 0.2, size: 0.4 }, targetDurationMs: 900 }
  },

  'alarm-loop': {
    id: 'alarm-loop',
    description: 'Facility alarm: three alternating pips over a low warning drone; loops seamlessly.',
    layers: [
      { preset: 'texture', params: { kind: 'hum', density: 0.45, tone: 0.5, movement: 0.2 }, gainDb: -16 },
      { preset: 'chime', params: { pitch: 0.42, decay: 0.16, metallic: 0.55, space: 0.2 }, duration: 0.55, offsetMs: 150, gainDb: -4 },
      { preset: 'chime', params: { pitch: 0.32, decay: 0.16, metallic: 0.5, space: 0.2 }, duration: 0.55, offsetMs: 950, gainDb: -4.5 },
      { preset: 'chime', params: { pitch: 0.42, decay: 0.16, metallic: 0.55, space: 0.2 }, duration: 0.55, offsetMs: 1750, gainDb: -4 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.5 }, duration: 0.06, offsetMs: 150, gainDb: -22 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.5 }, duration: 0.06, offsetMs: 950, gainDb: -22 },
      { preset: 'tick', params: { pitch: 0.3, hardness: 0.5 }, duration: 0.06, offsetMs: 1750, gainDb: -22 }
    ],
    master: { loop: true, reverb: { amount: 0.12, size: 0.5 }, targetDurationMs: 2400 }
  },

  'ui-toggle': {
    id: 'ui-toggle',
    description: 'Switch flip: short click plus a small pitched blip.',
    layers: [
      { preset: 'tick', params: { pitch: 0.45, hardness: 0.75 }, gainDb: -6 },
      { preset: 'chime', params: { pitch: 0.6, decay: 0.2, metallic: 0.25, space: 0.15 }, duration: 0.3, offsetMs: 15, gainDb: -14 }
    ],
    master: { reverb: { amount: 0.08, size: 0.25 }, targetDurationMs: 300 }
  },

  'coin-pickup': {
    id: 'coin-pickup',
    description: 'Pickup: two bright bell notes a step apart, short arcade sparkle.',
    layers: [
      { preset: 'chime', params: { pitch: 0.62, decay: 0.28, metallic: 0.6, space: 0.25 }, duration: 0.45, gainDb: -4 },
      { preset: 'chime', params: { pitch: 0.78, decay: 0.35, metallic: 0.6, space: 0.3 }, duration: 0.5, offsetMs: 80, gainDb: -6 },
      { preset: 'tick', params: { pitch: 0.9, hardness: 0.7 }, gainDb: -20 }
    ],
    master: { reverb: { amount: 0.2, size: 0.4 }, targetDurationMs: 700 }
  },

  'thunder-distant': {
    id: 'thunder-distant',
    description: 'Far thunder: muffled crack, long rolling rumble, rain-washed air.',
    layers: [
      { preset: 'impact', params: { weight: 1, hardness: 0.2, metallic: 0.08, space: 0.7, tone: 0.25, pitch: 0.75 }, gainDb: -6, filter: { mode: 'lp', cutoffHz: 700 } },
      { preset: 'texture', params: { kind: 'wind', density: 0.6, tone: 0.2, movement: 0.6 }, duration: 2.8, gainDb: -10, filter: { mode: 'lp', cutoffHz: 1200 } },
      { preset: 'texture', params: { kind: 'rain', density: 0.35, tone: 0.5, movement: 0.4 }, duration: 2.8, gainDb: -24, filter: { mode: 'hp', cutoffHz: 900 } },
      { preset: 'thud', params: { weight: 1, softness: 0.9, space: 0.6 }, gainDb: -8 }
    ],
    master: { reverb: { amount: 0.45, size: 0.9 }, targetDurationMs: 3000 }
  }
}

/* ---------------------------------------------------------------- helpers -- */

function roundTo (value, digits) {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function frameCount (seconds, sampleRate) {
  return Math.max(16, Math.round(seconds * sampleRate))
}

/**
 * A layer's own RNG seed. The layer index decorrelates the layers so two
 * `scrap` layers in one design do not land their grains on identical samples.
 * Layer 0 keeps the caller's seed unchanged, which is what makes one-layer
 * designs comparable to a raw `renderPreset` call.
 */
function layerSeed (seed, index) {
  return (Math.round(seed) + index * 104729) | 0
}

/**
 * Repitch by resampling. Used for `detuneCents` (and for `pitchScale` on
 * presets without a pitch knob): the layer is rendered `ratio` times longer and
 * then read back faster, which shifts every partial and every decay by the same
 * factor without touching the design timeline.
 */
function repitch (samples, ratio) {
  if (Math.abs(ratio - 1) < 1e-4) return samples
  const length = Math.max(16, Math.round(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[index] ?? 0
    const b = samples[index + 1] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/**
 * A variant is a new *performance* of the same sound, not a new sound: the
 * layers, the arrangement and the noise draw stay, but every layer is re-tuned
 * by a few cents and rebalanced by a dB. Two things follow from that split:
 * `seed` is the knob for a different random surface (different grains, different
 * noise), `variant` is the knob for another take of the same surface.
 *
 * The nudges also make variants differ in bytes for designs built only from
 * deterministic presets (a chime is a pure additive tone, a tick has no audible
 * random component), which a re-seed alone would leave byte-identical. Timing is
 * deliberately not nudged: moving offsets changes which event owns the loudest
 * moment in a sparse design, and a variant must not read as a different sound.
 */
function applyVariant (layers, seed, variant, loop) {
  if (variant === 0) return
  layers.forEach((layer, index) => {
    const rand = makeRng((seed * 0x9E3779B1 ^ Math.imul(variant, 0x85EBCA6B) ^ Math.imul(index + 1, 0xC2B2AE35)) >>> 0)
    const detune = (rand() - 0.5) * 24
    const gain = (rand() - 0.5) * 2
    // A loop bed is never repitched by resampling: a resampled bed no longer
    // loops sample-exactly, so beds take only a balance nudge. Everything else
    // takes the tuning nudge, which is what varies the bytes of a design built
    // from deterministic presets.
    if (loop && layer.duration === undefined) layer.gainDb = clamp(layer.gainDb + gain, -48, 12)
    else layer.detuneCents = clamp(layer.detuneCents + detune, -1200, 1200)
  })
}

/** Validate and clamp one layer spec; unknown presets throw early. */
function normalizeLayer (spec, index) {
  if (spec === null || typeof spec !== 'object') throw new Error(`layer ${index}: expected an object`)
  const preset = String(spec.preset ?? '')
  if (PRESETS[preset] === undefined) {
    throw new Error(`layer ${index}: unknown preset "${preset}"; available: ${Object.keys(PRESETS).join(', ')}`)
  }
  const params = spec.params !== null && typeof spec.params === 'object' ? { ...spec.params } : {}
  const duration = Number.isFinite(spec.duration) ? clamp(Number(spec.duration), 0.008, 30) : undefined
  return {
    preset,
    params,
    offsetMs: clamp(Number.isFinite(spec.offsetMs) ? Number(spec.offsetMs) : 0, 0, 60000),
    gainDb: clamp(Number.isFinite(spec.gainDb) ? Number(spec.gainDb) : 0, -48, 12),
    duration,
    pitchScale: clamp(Number.isFinite(spec.pitchScale) ? Number(spec.pitchScale) : 1, 0.25, 4),
    detuneCents: clamp(Number.isFinite(spec.detuneCents) ? Number(spec.detuneCents) : 0, -1200, 1200),
    filter: normalizeFilter(spec.filter)
  }
}

/** Resolve a layer filter spec to a fixed shape, or null when there is none. */
function normalizeFilter (value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const mode = ['lp', 'hp', 'bp'].includes(value.mode) ? value.mode : 'lp'
  const cutoffHz = clamp(Number.isFinite(value.cutoffHz) ? Number(value.cutoffHz) : 2000, 20, 20000)
  const toHz = Number.isFinite(value.toHz) ? clamp(Number(value.toHz), 20, 20000) : cutoffHz
  const q = clamp(Number.isFinite(value.q) ? Number(value.q) : 0.8, 0.2, 12)
  return { mode, cutoffHz, toHz, q }
}

/**
 * Decide how a layer is pitched. Presets that expose `pitch` take `pitchScale`
 * on the knob (cheap, and it keeps their internal tuning coherent); everything
 * else gets repitched by resampling. `detuneCents` always repitches, because a
 * few cents is finer than any preset's pitch knob can express.
 */
function planPitch (layer) {
  const spec = PRESETS[layer.preset]
  const params = { ...layer.params }
  const pitchRange = spec.params?.pitch
  let ratio = layer.pitchScale
  if (pitchRange !== undefined) {
    const base = Number.isFinite(params.pitch) ? params.pitch : spec.defaults.pitch
    params.pitch = clamp(base * ratio, pitchRange[0], pitchRange[1])
    ratio = 1
  }
  ratio *= Math.pow(2, layer.detuneCents / 1200)
  return { params, ratio: clamp(ratio, 0.25, 4) }
}

/**
 * Shared brightness/envelope tilt for `intensity`. Intensity is not a volume
 * knob bolted onto the end: a gentle version of a hit is darker and less
 * compressed than a huge one, so the tilt cuts air as the level comes down.
 */
function applyTilt (buffer, sampleRate, amount) {
  if (Math.abs(amount) < 1e-3) return buffer
  const low = filter(buffer, sampleRate, () => TILT_HZ, () => 0.7, 'lp')
  const high = filter(buffer, sampleRate, () => TILT_HZ, () => 0.7, 'hp')
  // Subtract a high-passed copy and add a little low-passed copy: a shelf with
  // no gain at the crossover. Recombining the two bands with gains instead
  // would notch the crossover frequency (the SVF's hp+lp sum carries a -k*bp
  // term), which drops whatever note sits there by 20 dB.
  const cut = 0.42 * -amount
  const boost = 0.12 * -amount
  for (let i = 0; i < buffer.length; i += 1) buffer[i] += low[i] * boost - high[i] * cut
  return buffer
}

/** Linear fades over the head and tail of the design. */
function applyFades (buffer, sampleRate, fadeInSeconds, fadeOutSeconds) {
  const fadeIn = Math.min(Math.round(fadeInSeconds * sampleRate), buffer.length)
  const fadeOut = Math.min(Math.round(fadeOutSeconds * sampleRate), buffer.length)
  for (let i = 0; i < fadeIn; i += 1) buffer[i] *= i / Math.max(1, fadeIn)
  for (let i = 0; i < fadeOut; i += 1) buffer[buffer.length - 1 - i] *= i / Math.max(1, fadeOut)
  return buffer
}

/** Accept `reverb: 0.3` or `reverb: { amount, size }`. */
function reverbSetting (value) {
  if (value === null || value === undefined) return { amount: 0, size: 0.5 }
  if (typeof value === 'number') return { amount: unit(value), size: 0.5 }
  return { amount: unit(value.amount ?? 0.25), size: unit(value.size ?? 0.5) }
}

/* ----------------------------------------------------------- composition -- */

/**
 * Build a sound by summing preset layers on one timeline.
 *
 * This is the generic form behind `designSound`: hand it any layer stack and it
 * renders, offsets, gains, filters, repitches, sums, then applies one reverb,
 * one envelope and one peak target. Every random decision comes from `seed` and
 * `variant`, so the same stack always produces the same samples.
 *
 * In a loop design (`loop: true`) a layer with no `duration` becomes a seamless
 * bed covering the whole loop, and the loop is rendered twice so the reverb at
 * the seam is already at steady state.
 *
 * @param {object[]} specs - layer specs: { preset, params?, offsetMs?, gainDb?, duration?, pitchScale?, detuneCents?, filter? }.
 * @param {object} [options] - seed, variant, sampleRate, intensity, durationSeconds, loop, reverb, fadeInMs, fadeOutMs, peakDbfs, limiter, dcBlock.
 * @returns {{ samples: Float32Array, sampleRate: number, durationSeconds: number, loop: boolean, intensity: number, layers: object[] }}
 */
export function blendLayers (specs, options = {}) {
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('blendLayers needs a non-empty array of layer specs')
  if (specs.length > MAX_LAYERS) throw new Error(`blendLayers: at most ${MAX_LAYERS} layers, got ${specs.length}`)

  const sampleRate = clamp(Math.round(options.sampleRate ?? 44100), 8000, 96000)
  const seed = Number.isFinite(options.seed) ? Math.round(Number(options.seed)) : 1
  const variant = Number.isFinite(options.variant) ? Math.round(Number(options.variant)) : 0
  const intensity = unit(options.intensity ?? 1)
  const loop = options.loop === true
  // Intensity trims the sum before the limiter as well, so a gentle version is
  // genuinely less compressed and not just a quieter copy of a squashed one.
  const intensityDb = (intensity - 1) * 6

  const layers = specs.map(normalizeLayer)
  applyVariant(layers, seed, variant, loop)
  const pitches = layers.map(planPitch)
  const nominal = layers.map((layer) => layer.duration ?? PRESETS[layer.preset].defaultDuration)
  const naturalSeconds = Math.max(...layers.map((layer, index) => layer.offsetMs / 1000 + nominal[index]))
  const targetSeconds = clamp(
    Number.isFinite(options.durationSeconds) ? Number(options.durationSeconds) : naturalSeconds,
    0.02,
    30
  )
  const totalFrames = frameCount(targetSeconds, sampleRate)
  const passes = loop ? 2 : 1
  const master = new Float32Array(totalFrames * passes)

  layers.forEach((layer, index) => {
    const plan = pitches[index]
    const bed = loop && layer.duration === undefined
    const layerSeconds = bed ? targetSeconds : nominal[index]
    const rendered = renderPreset({
      preset: layer.preset,
      params: plan.params,
      // Render long enough that the repitch below lands on the intended length.
      duration: clamp(layerSeconds * plan.ratio, 0.008, 30),
      seed: layerSeed(seed, index),
      sampleRate,
      loop: bed
    })
    let samples = repitch(rendered.samples, plan.ratio)
    if (layer.filter !== null) {
      const shape = layer.filter
      samples = filter(
        samples,
        sampleRate,
        (progress) => lerp(shape.cutoffHz, shape.toHz, progress),
        () => shape.q,
        shape.mode
      )
    }
    const gain = dbToGain(layer.gainDb + intensityDb)
    const offset = Math.round(layer.offsetMs / 1000 * sampleRate)
    for (let pass = 0; pass < passes; pass += 1) addInto(master, samples, offset + pass * totalFrames, gain)
  })

  const settings = reverbSetting(options.reverb)
  const wet = settings.amount > 0 ? reverb(master, sampleRate, settings.amount, settings.size) : master
  // A loop keeps the second pass: its head already carries the reverb tail of
  // the first pass, so the wrap has no reverb discontinuity.
  const output = loop ? wet.slice(totalFrames, totalFrames * 2) : wet

  // Sub-20 Hz wander is inaudible but eats headroom and shows up as DC offset.
  // `dcBlock: false` is the escape hatch used to verify that the sum really is
  // additive, by comparing it against a raw `renderPreset` result.
  if (options.dcBlock !== false) dcBlock(output, sampleRate)

  const trimmed = totalFrames < frameCount(naturalSeconds, sampleRate)
  if (!loop) {
    const fadeInSeconds = Number.isFinite(options.fadeInMs) ? Math.max(0, Number(options.fadeInMs)) / 1000 : 0
    const fadeOutSeconds = Number.isFinite(options.fadeOutMs) ? Math.max(0, Number(options.fadeOutMs)) / 1000 : 0
    // Cutting content or a reverb tail clicks; anything that has to stop early
    // gets a short guard fade so the file ends at zero.
    const guard = settings.amount > 0 || trimmed || options.durationSeconds !== undefined
    applyFades(output, sampleRate, fadeInSeconds, Math.max(fadeOutSeconds, guard ? GUARD_FADE_SECONDS : 0))
  }

  // The tilt only ever removes air, never adds it: a full-intensity design is
  // the recipe exactly as authored, and intensity below 1 makes it gentler.
  applyTilt(output, sampleRate, clamp(intensity - 1, -1, 0))

  // Same order as `finalize` in audio.js: normalise first, then shave the very
  // top. Limiting a still-loud sum would drive tanh saturation and add
  // harmonics the recipes never asked for; this keeps the master transparent.
  const peakDbfs = options.peakDbfs === null
    ? null
    : Number.isFinite(options.peakDbfs)
      ? Number(options.peakDbfs)
      : -1 - (1 - intensity) * 10
  if (peakDbfs !== null) normalizePeak(output, clamp(peakDbfs, -60, 0))
  if (options.limiter !== false) softLimit(output)

  return {
    samples: output,
    sampleRate,
    durationSeconds: output.length / sampleRate,
    loop,
    intensity,
    layers: layers.map((layer, index) => ({
      preset: layer.preset,
      params: pitches[index].params,
      offsetSeconds: roundTo(layer.offsetMs / 1000, 3),
      gainDb: roundTo(layer.gainDb + intensityDb, 1),
      durationSeconds: roundTo(loop && layer.duration === undefined ? targetSeconds : nominal[index], 3),
      filter: layer.filter
    }))
  }
}

/* -------------------------------------------------------------- designs -- */

/**
 * Render a named design recipe (or an explicit layer stack).
 *
 * `designSound` is the one call that replaces "render four presets, then mix
 * them": the recipe brings the arrangement, its master brings the space and the
 * envelope, and the returned summary is everything a model needs to decide
 * whether to keep the take.
 *
 * `seed` chooses the random surface (grains, noise, partial levels); `variant`
 * keeps that surface and re-performs it (detune and balance). Neither changes
 * the recipe.
 *
 * @param {object} [request] - { recipe?, layers?, seed?, duration?, intensity?, sampleRate?, variant?, loop? }.
 * @returns {{ samples: Float32Array, sampleRate: number, durationSeconds: number, layers: object[], recipe: string, recipeSpec: object|null, loop: boolean, intensity: number }}
 */
export function designSound (request = {}) {
  const recipeId = typeof request.recipe === 'string' ? request.recipe.trim() : ''
  const recipe = recipeId.length > 0 ? RECIPES[recipeId] : undefined
  if (recipeId.length > 0 && recipe === undefined) {
    throw new Error(`unknown recipe "${recipeId}"; available: ${Object.keys(RECIPES).join(', ')}`)
  }
  const explicit = Array.isArray(request.layers) && request.layers.length > 0 ? request.layers : undefined
  const specs = explicit ?? recipe?.layers
  if (specs === undefined) throw new Error('designSound needs a known recipe id or a non-empty layers array')

  const master = recipe?.master ?? {}
  const loop = typeof request.loop === 'boolean' ? request.loop : master.loop === true
  const intensity = unit(request.intensity ?? 1)
  const durationSeconds = Number.isFinite(request.duration)
    ? Number(request.duration)
    : Number.isFinite(master.targetDurationMs) ? master.targetDurationMs / 1000 : undefined

  const blended = blendLayers(specs, {
    sampleRate: request.sampleRate,
    seed: request.seed,
    variant: request.variant,
    intensity,
    loop,
    durationSeconds,
    reverb: master.reverb,
    fadeInMs: master.fadeInMs,
    fadeOutMs: master.fadeOutMs
  })

  return {
    ...blended,
    recipe: recipe?.id ?? 'custom',
    recipeSpec: recipe ?? null
  }
}

/* --------------------------------------------------------------- catalog -- */

/**
 * Compact recipe list for tool descriptions and the skill.
 * @returns {{ id: string, description: string, layers: number, loop: boolean, durationSeconds: number }[]}
 */
export function recipeCatalog () {
  return Object.values(RECIPES).map((recipe) => ({
    id: recipe.id,
    description: recipe.description,
    layers: recipe.layers.length,
    loop: recipe.master?.loop === true,
    durationSeconds: Number.isFinite(recipe.master?.targetDurationMs)
      ? roundTo(recipe.master.targetDurationMs / 1000, 1)
      : 0
  }))
}
