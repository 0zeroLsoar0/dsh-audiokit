/**
 * Interaction audio: the sounds a UI makes, and the glue that binds them to DOM
 * events.
 *
 * `audio_bind` answers "which sound plays at 3.2 s". This module answers a
 * different question: "what does a button sound like". A UI is not a timeline —
 * its sounds fire on gestures, overlap unpredictably, and are heard dozens of
 * times a minute. That changes the deliverable in three ways:
 *
 *   - a *palette* voices every interaction inside one style family, so a whole
 *     page sounds like one product instead of a pile of unrelated one-shots;
 *   - every clip is normalised to the same peak and carries its own mixer gain,
 *     so "a hover is quiet, an error is loud" is a number, not an accident;
 *   - the output is a binding script, not a cue sheet: it decodes on the first
 *     gesture, never autoplays, caps how loud a rapid repeat can get, and binds
 *     `data-sound` attributes so a page needs no JavaScript of its own.
 *
 * The synthesis is not new: a cue is either an existing design recipe
 * (`designSound`) or an existing preset (`renderPreset`), biased by the
 * palette's pitch/space/tail knobs. The palette's tone is a mix-bus filter
 * (`dsp.filter`) applied after the render; nothing here invents a second
 * synthesis stack.
 *
 * Determinism: the same (palette, interactions, seed) produces the same wav
 * bytes and the same script text. Per-cue seeds are derived arithmetically, so
 * two cues in one set never share a noise surface.
 */

import { finalize, measure, renderPreset, toWavBytes } from './audio.js'
import { RECIPES, designSound } from './design.js'
import { PRESETS, clamp, filter, reverb, resolveParams } from './dsp.js'

/* ------------------------------------------------------- interaction table -- */

/**
 * The out-of-the-box interaction vocabulary.
 *
 * Each entry names an existing engine call, the clip length it wants, the
 * mixer gain it should be played at, and the DOM event a page would normally
 * hang it on. `gainDb` is *relative*: the clips are all normalised to -1 dBFS,
 * so a hover at -14 dB is genuinely a background sound next to an error at -2.
 *
 * `duration` is the authored length before the palette's tail bias; the cue
 * carries the resolved value.
 *
 * @type {Record<string, { id: string, description: string, engine: object, duration: number, gainDb: number, events: string[] }>}
 */
export const INTERACTION_PRESETS = {
  hover: {
    id: 'hover',
    description: 'Pointer enters a target: a barely-there bright blip.',
    engine: { kind: 'design', recipe: 'ui-hover' },
    duration: 0.18,
    gainDb: -14,
    events: ['mouseenter']
  },

  press: {
    id: 'press',
    description: 'Primary button goes down: one short, hard, low click.',
    engine: { kind: 'preset', preset: 'tick', params: { pitch: 0.36, hardness: 0.85 } },
    duration: 0.06,
    gainDb: -8,
    events: ['pointerdown']
  },

  release: {
    id: 'release',
    description: 'Button comes back up: a lighter click, pitched above the press.',
    engine: { kind: 'preset', preset: 'tick', params: { pitch: 0.62, hardness: 0.35 } },
    duration: 0.05,
    gainDb: -13,
    events: ['pointerup']
  },

  'toggle-on': {
    id: 'toggle-on',
    description: 'Switch turns on: two rising bright notes.',
    engine: { kind: 'design', recipe: 'coin-pickup' },
    duration: 0.7,
    gainDb: -5,
    events: ['click']
  },

  'toggle-off': {
    id: 'toggle-off',
    description: 'Switch turns off: one dull, low note that settles.',
    engine: { kind: 'preset', preset: 'chime', params: { pitch: 0.28, decay: 0.2, metallic: 0.3, space: 0.2 } },
    duration: 0.45,
    gainDb: -9,
    events: ['click']
  },

  success: {
    id: 'success',
    description: 'Operation confirmed: two rising bell notes, clean and short.',
    engine: { kind: 'design', recipe: 'ui-success' },
    duration: 0.8,
    gainDb: -3,
    events: ['custom']
  },

  error: {
    id: 'error',
    description: 'Operation rejected: low buzz, muted chime, descending second buzz.',
    engine: { kind: 'design', recipe: 'ui-error' },
    duration: 0.6,
    gainDb: -2,
    events: ['custom']
  },

  warning: {
    id: 'warning',
    description: 'Something needs attention but did not fail: a short descending buzz.',
    engine: { kind: 'preset', preset: 'zap', params: { pitch: 0.28, roughness: 0.35, space: 0.15 } },
    duration: 0.28,
    gainDb: -5,
    events: ['custom']
  },

  'typing-key': {
    id: 'typing-key',
    description: 'One key of text: tiny tick with a pitch jitter so a run does not sound metronomic.',
    engine: { kind: 'preset', preset: 'tick', params: { pitch: 0.5, hardness: 0.65, pitchJitter: 0.45 } },
    duration: 0.05,
    gainDb: -16,
    events: ['keydown']
  },

  'scroll-tick': {
    id: 'scroll-tick',
    description: 'One notch of scrolling: the quietest possible high tick.',
    engine: { kind: 'preset', preset: 'tick', params: { pitch: 0.8, hardness: 0.5 } },
    duration: 0.035,
    gainDb: -20,
    events: ['wheel']
  },

  open: {
    id: 'open',
    description: 'Panel or menu opens: air rising into the reveal.',
    engine: { kind: 'preset', preset: 'whoosh', params: { speed: 0.4, tone: 0.5, rise: 0.35, space: 0.25 } },
    duration: 0.45,
    gainDb: -7,
    events: ['click']
  },

  close: {
    id: 'close',
    description: 'Panel or menu closes: air falling away.',
    engine: { kind: 'preset', preset: 'whoosh', params: { speed: 0.55, tone: 0.35, rise: 0.72, space: 0.2 } },
    duration: 0.4,
    gainDb: -8,
    events: ['click']
  },

  drop: {
    id: 'drop',
    description: 'Something is let go and lands: a soft low body with no ring.',
    engine: { kind: 'preset', preset: 'thud', params: { weight: 0.35, softness: 0.6, space: 0.12 } },
    duration: 0.3,
    gainDb: -6,
    events: ['custom']
  },

  'count-up': {
    id: 'count-up',
    description: 'A number ticks over: a dry mid click, quiet enough to repeat.',
    engine: { kind: 'preset', preset: 'tick', params: { pitch: 0.64, hardness: 0.45 } },
    duration: 0.04,
    gainDb: -18,
    events: ['custom']
  },

  focus: {
    id: 'focus',
    description: 'Keyboard focus lands: a soft, short bell.',
    engine: { kind: 'preset', preset: 'chime', params: { pitch: 0.72, decay: 0.06, metallic: 0.15, space: 0.1 } },
    duration: 0.18,
    gainDb: -15,
    events: ['focusin']
  },

  notify: {
    id: 'notify',
    description: 'Something arrived: one warm bell that rings just long enough to notice.',
    engine: { kind: 'preset', preset: 'chime', params: { pitch: 0.52, decay: 0.55, metallic: 0.45, space: 0.35 } },
    duration: 0.9,
    gainDb: -4,
    events: ['custom']
  }
}

/** Every interaction id, in table order. */
export const INTERACTION_IDS = Object.freeze(Object.keys(INTERACTION_PRESETS))

/**
 * What `interactions: 'auto'` means.
 *
 * The smallest set that makes a page stop feeling silent: pointer feedback,
 * both switch states, the two outcomes, text input and a notification. Release,
 * warning, scroll, open/close, drop, count-up and focus are opt-in.
 */
export const AUTO_INTERACTIONS = Object.freeze([
  'hover',
  'press',
  'release',
  'toggle-on',
  'toggle-off',
  'success',
  'error',
  'typing-key',
  'notify'
])

/* --------------------------------------------------------------- palettes -- */

/**
 * Style families: the bias applied to every cue in a set.
 *
 *   - `pitch`   multiplies the layer's pitch (a 0..1 pitch knob takes
 *               `(pitch - 1) * 0.6` instead, because a knob is not a ratio);
 *   - `edge`    added to a preset's `hardness` knob;
 *   - `space`   added to a preset's `space` knob; on a design it is extra room
 *               added on top of the recipe, never a removal of the space the
 *               recipe authored (UI recipes are authored dry on purpose);
 *   - `tail`    scales every clip's duration, so a whole set breathes together;
 *   - `gainDb`  a level bias on top of each interaction's own gain;
 *   - `tone`    a mix-bus filter applied after the render: low families get a
 *               low-pass, high families a high-pass. This is what makes the
 *               families measurably different rather than merely differently
 *               mixed.
 *
 * @type {Record<string, { id: string, description: string, pitch: number, edge: number, space: number, tail: number, gainDb: number, tone: { mode: 'lp'|'hp', hz: number, q: number } }>}
 */
export const PALETTES = {
  soft: {
    id: 'soft',
    description: 'Rounded and quiet: lower, darker, longer tails, a little room.',
    pitch: 0.88,
    edge: -0.15,
    space: 0.15,
    tail: 0.22,
    gainDb: -1,
    tone: { mode: 'lp', hz: 2000, q: 0.7 }
  },

  crisp: {
    id: 'crisp',
    description: 'Tight and dry: bright attacks, short tails, almost no room.',
    pitch: 1.1,
    edge: 0.08,
    space: -0.1,
    tail: -0.22,
    gainDb: 0,
    tone: { mode: 'hp', hz: 420, q: 0.8 }
  },

  organic: {
    id: 'organic',
    description: 'Warm and slightly uneven: mid weight, small detune, a little room.',
    pitch: 0.99,
    edge: -0.04,
    space: 0.06,
    tail: 0.04,
    gainDb: -0.5,
    tone: { mode: 'lp', hz: 5200, q: 0.6 },
    detuneCents: 9
  },

  digital: {
    id: 'digital',
    description: 'Thin and synthetic: high-passed, very short, dead dry, pitched up.',
    pitch: 1.3,
    edge: 0.16,
    space: -0.25,
    tail: -0.38,
    gainDb: 1,
    tone: { mode: 'hp', hz: 1000, q: 0.9 }
  },

  cinematic: {
    id: 'cinematic',
    description: 'Big and slow: low, wide, long tails — use sparingly on a UI.',
    pitch: 0.8,
    edge: -0.12,
    space: 0.4,
    tail: 0.5,
    gainDb: -2,
    tone: { mode: 'lp', hz: 1500, q: 0.7 }
  }
}

/** Every palette id, in table order. */
export const PALETTE_NAMES = Object.freeze(Object.keys(PALETTES))

/** The family used when the caller does not pick one. */
export const DEFAULT_PALETTE = 'crisp'

/* ---------------------------------------------------------------- helpers -- */

const MIN_CLIP_SECONDS = 0.02
const MAX_CLIP_SECONDS = 3

function round (value, digits) {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

/** Resolve a palette name (case-insensitive; empty means the default). */
function resolvePalette (name) {
  if (name === undefined || name === null || name === '') return PALETTES[DEFAULT_PALETTE]
  const id = String(name).trim().toLowerCase()
  const palette = PALETTES[id]
  if (palette === undefined) {
    throw new Error(`unknown palette "${name}"; available: ${PALETTE_NAMES.join(', ')}`)
  }
  return palette
}

/** Expand `auto`, validate ids, and de-duplicate while keeping call order. */
function resolveInteractionIds (interactions) {
  if (interactions === undefined || interactions === null) return AUTO_INTERACTIONS.slice()
  const requested = typeof interactions === 'string' ? [interactions] : interactions
  if (!Array.isArray(requested)) throw new Error('interactions must be an array of ids or "auto"')
  const ids = []
  const add = (id) => { if (!ids.includes(id)) ids.push(id) }
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '') throw new Error(`interactions contains an empty id; available: ${INTERACTION_IDS.join(', ')} or "auto"`)
    if (id === 'auto') {
      for (const auto of AUTO_INTERACTIONS) add(auto)
      continue
    }
    if (INTERACTION_PRESETS[id] === undefined) {
      throw new Error(`unknown interaction "${id}"; available: ${INTERACTION_IDS.join(', ')} or "auto"`)
    }
    add(id)
  }
  // A copy, never the frozen array by reference: a caller reordering its result
  // must not reorder the module's default.
  return ids.length === 0 ? AUTO_INTERACTIONS.slice() : ids
}

/**
 * A cue's own seed. Multiplicative hashing decorrelates the cues so two chime
 * cues in one set do not share a random surface, while staying a pure function
 * of (seed, index) — the property that makes a whole set reproducible.
 */
function deriveSeed (seed, index) {
  return (Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(index + 1, 0x85EBCA6B)) >>> 0
}

/**
 * Palette bias on a preset's declared knobs.
 *
 * The knobs are whichever ones the preset actually declares (`resolveParams`
 * gives ranges and defaults), so this works for every present and future
 * preset without a per-preset table. A pitch knob declared 0..1 is perceptual
 * and takes an offset; a pitch knob declared as a ratio (0.5..2) takes a
 * multiplier.
 */
function biasPresetParams (preset, params, palette) {
  const spec = PRESETS[preset]
  const ranges = spec.params ?? {}
  const resolved = resolveParams(preset, params)
  const set = (key, value) => {
    const range = ranges[key]
    if (range !== undefined) resolved[key] = clamp(value, range[0], range[1])
  }
  const pitchRange = ranges.pitch
  if (pitchRange !== undefined) {
    const perceptual = pitchRange[0] >= 0 && pitchRange[1] <= 1
    set('pitch', perceptual ? resolved.pitch + (palette.pitch - 1) * 0.6 : resolved.pitch * palette.pitch)
  }
  if (ranges.hardness !== undefined) set('hardness', resolved.hardness + palette.edge)
  if (ranges.space !== undefined) set('space', resolved.space + palette.space)
  if (ranges.decay !== undefined) set('decay', resolved.decay + palette.tail)
  return resolved
}

/** Palette bias on a design recipe's layer stack (the stack itself, not the mix). */
function biasLayers (layers, palette) {
  return layers.map((layer) => ({
    ...layer,
    params: layer.params === undefined ? undefined : { ...layer.params },
    pitchScale: clamp((layer.pitchScale ?? 1) * palette.pitch, 0.25, 4),
    detuneCents: clamp((layer.detuneCents ?? 0) + (palette.detuneCents ?? 0), -1200, 1200)
  }))
}

/* ------------------------------------------------------------ build the set -- */

/**
 * Turn a palette and an interaction list into a renderable, self-describing set.
 *
 * The result is pure data: every cue carries its resolved seed, duration, mixer
 * gain, layer stack and source engine, so `renderInteractionSet` (or any other
 * renderer) can reproduce it without re-resolving the palette.
 *
 * @param {object} [request]
 * @param {string} [request.palette] - one of PALETTE_NAMES; defaults to "crisp".
 * @param {string[]|string} [request.interactions] - ids, "auto", or omitted for AUTO_INTERACTIONS.
 * @param {number} [request.seed] - integer variation seed; defaults to 1.
 * @param {number} [request.sampleRate] - defaults to 22050 (UI blips; keeps a page small).
 * @returns {{ cues: object[], palette: object, seed: number, sampleRate: number }}
 */
export function buildInteractionSet (request = {}) {
  const palette = resolvePalette(request.palette)
  const ids = resolveInteractionIds(request.interactions)
  const requestedRate = Number(request.sampleRate)
  const sampleRate = Number.isFinite(requestedRate) ? clamp(Math.round(requestedRate), 8000, 96000) : 22050
  const requestedSeed = Number(request.seed)
  const seed = Number.isFinite(requestedSeed) ? Math.round(requestedSeed) : 1

  const cues = ids.map((id, index) => {
    const entry = INTERACTION_PRESETS[id]
    const durationSeconds = round(clamp(entry.duration * (1 + palette.tail), MIN_CLIP_SECONDS, MAX_CLIP_SECONDS), 4)
    const gainDb = round(clamp(entry.gainDb + palette.gainDb, -60, 12), 2)
    const cueSeed = deriveSeed(seed, index)

    if (entry.engine.kind === 'design') {
      const recipe = RECIPES[entry.engine.recipe]
      if (recipe === undefined) {
        throw new Error(`interaction "${id}" points at unknown recipe "${entry.engine.recipe}"`)
      }
      return {
        name: id,
        at: 0,
        file: `${id}.wav`,
        gainDb,
        durationSeconds,
        seed: cueSeed,
        source: { kind: 'design', recipe: recipe.id },
        layers: biasLayers(recipe.layers, palette)
      }
    }

    const preset = entry.engine.preset
    if (PRESETS[preset] === undefined) {
      throw new Error(`interaction "${id}" points at unknown preset "${preset}"`)
    }
    const params = biasPresetParams(preset, entry.engine.params ?? {}, palette)
    return {
      name: id,
      at: 0,
      file: `${id}.wav`,
      gainDb,
      durationSeconds,
      seed: cueSeed,
      source: { kind: 'preset', preset, params },
      layers: [{ preset, params, offsetMs: 0, gainDb: 0, durationSeconds }]
    }
  })

  return {
    cues,
    palette: { ...palette, tone: { ...palette.tone } },
    seed,
    sampleRate
  }
}

/* --------------------------------------------------------------- rendering -- */

/**
 * Render every cue in a set to samples and a 16-bit wav.
 *
 * Each clip is rendered by its own engine, then the palette's mix-bus tone is
 * applied, then `finalize` normalises it to `peakDbfs` (-1 by default). That is
 * what makes the cue's `gainDb` the only thing that decides how loud the
 * interaction is relative to the others.
 *
 * @param {{ cues: object[], palette?: object, sampleRate?: number }} set - from buildInteractionSet.
 * @param {{ sampleRate?: number, peakDbfs?: number }} [options] - sampleRate overrides the set's.
 * @returns {{ clips: object[], totalBytes: number }}
 */
export function renderInteractionSet (set, options = {}) {
  if (set === null || typeof set !== 'object' || !Array.isArray(set.cues) || set.cues.length === 0) {
    throw new Error('renderInteractionSet needs a set with at least one cue')
  }
  const requestedRate = Number(options.sampleRate)
  const sampleRate = Number.isFinite(requestedRate)
    ? clamp(Math.round(requestedRate), 8000, 96000)
    : clamp(Math.round(Number(set.sampleRate) || 22050), 8000, 96000)
  const requestedPeak = Number(options.peakDbfs)
  const peakDbfs = Number.isFinite(requestedPeak) ? requestedPeak : -1
  const palette = set.palette ?? null
  const tone = palette !== null && palette.tone !== undefined ? palette.tone : null
  const room = palette !== null && Number.isFinite(palette.space) && palette.space > 0 ? palette.space * 0.6 : 0

  const clips = set.cues.map((cue) => {
    let samples = renderCue(cue, sampleRate, room)
    // The palette tone is a bus treatment, so it runs on both engine kinds and
    // after the design's own reverb, exactly like a mix-bus EQ would.
    if (tone !== null && Number.isFinite(tone.hz)) {
      samples = filter(samples, sampleRate, () => tone.hz, () => tone.q, tone.mode)
    }
    finalize(samples, sampleRate, peakDbfs)
    const bytes = toWavBytes(samples, sampleRate)
    const metrics = measure(samples, sampleRate)
    return {
      name: cue.name,
      samples,
      sampleRate,
      durationSeconds: samples.length / sampleRate,
      bytes,
      gainDb: cue.gainDb,
      peakDbfs: metrics.peakDbfs,
      rmsDbfs: metrics.rmsDbfs,
      centroidHz: metrics.centroidHz,
      onsets: metrics.onsets
    }
  })

  return { clips, totalBytes: clips.reduce((sum, clip) => sum + clip.bytes.length, 0) }
}

/** Render one cue with its own engine; `room` is the palette's extra wet tail. */
function renderCue (cue, sampleRate, room) {
  const source = cue.source ?? {}
  const seed = Number.isFinite(cue.seed) ? cue.seed : 1
  const duration = Number.isFinite(cue.durationSeconds) ? cue.durationSeconds : MIN_CLIP_SECONDS

  if (source.kind === 'preset') {
    return renderPreset({
      preset: source.preset,
      params: source.params ?? {},
      duration,
      seed,
      sampleRate
    }).samples
  }

  if (source.kind === 'design') {
    if (!Array.isArray(cue.layers) || cue.layers.length === 0) {
      throw new Error(`cue "${cue.name}" is a design but has no layers`)
    }
    // `designSound` takes the recipe id for its reverb/envelope master and the
    // biased layer stack for the sound, so a recipe stays one entry in RECIPES
    // rather than being forked per palette.
    const rendered = designSound({
      recipe: source.recipe,
      layers: cue.layers,
      duration,
      seed,
      sampleRate
    })
    let samples = rendered.samples
    if (room > 0) samples = reverb(samples, sampleRate, room, 0.6)
    return samples
  }

  throw new Error(`cue "${cue.name}" has an unknown source kind "${String(source.kind)}"`)
}

/* ----------------------------------------------------------- binding script -- */

/**
 * The generated runtime.
 *
 * Two tokens are filled by `buildBindingScript`: `__DATA__` (the clip payload
 * and the selector bindings) and `__READER__` (base64-only for an inline page,
 * base64-plus-fetch when clips live next to the script). The inline variant
 * contains no fetch, no URL and no import, so an offline single-file page
 * provably cannot reach the network.
 *
 * Contract baked into the player:
 *   - no AudioContext exists until the first gesture, so nothing can autoplay;
 *   - `play()` before a gesture is a silent no-op (it never opens the context);
 *   - a clip decodes once, on first use (or on unlock when `preload` is set);
 *   - the live voices of one clip share one hit's level, so a burst can never
 *     be louder than a single press, and a press younger than STEAL_SECONDS is
 *     replaced instead of layered.
 */
const BINDING_SOURCE = `/* dsh-audiokit interaction sounds: paste once; the first gesture unlocks audio. */
(() => {
  'use strict'
  const D = __DATA__
  const MAX_VOICES = 2
  const STEAL_SECONDS = 0.04
  const clips = new Map(D.clips.map((clip) => [clip.name, clip]))
  const decoded = new Map()
  const voices = new Map()
  let ctx = null
  let opening = null
  let unlocked = false
  let enabled = true

  const audio = () => (ctx === null ? (ctx = new (window.AudioContext || window.webkitAudioContext)()) : ctx)
  const read = __READER__

  const load = (clip) => {
    let promise = decoded.get(clip.name)
    if (promise === undefined) {
      promise = read(clip).then((bytes) => audio().decodeAudioData(bytes))
      decoded.set(clip.name, promise)
    }
    return promise
  }

  const list = (name) => {
    let bucket = voices.get(name)
    if (bucket === undefined) {
      bucket = []
      voices.set(name, bucket)
    }
    return bucket
  }

  // A stolen voice is cut short, not faded, or it would overlap the next press.
  // onended is unhooked first so a manual stop and a natural end cannot remove
  // the same record twice.
  const silence = (voice) => {
    voice.src.onended = null
    try { voice.src.stop() } catch (error) { /* already stopped */ }
    try { voice.gain.disconnect() } catch (error) { /* already gone */ }
  }

  const remove = (voice) => {
    const bucket = voices.get(voice.name)
    if (bucket === undefined) return
    const at = bucket.indexOf(voice)
    if (at >= 0) bucket.splice(at, 1)
  }

  // Level policy: the live voices of one clip share one hit's level (1/N each),
  // so two overlapping presses are never louder than a single press. Two voices
  // is the cap; a press younger than STEAL_SECONDS is replaced rather than
  // layered, which is how a key repeat should read.
  const fire = (name) => {
    const clip = clips.get(name)
    if (clip === undefined) return Promise.resolve(false)
    return load(clip).then((buffer) => {
      if (!enabled) return false
      const now = audio().currentTime
      const bucket = list(name)
      const young = bucket.find((voice) => now - voice.at < STEAL_SECONDS)
      if (young !== undefined) {
        silence(young)
        remove(young)
      } else if (bucket.length >= MAX_VOICES) {
        silence(bucket[0])
        remove(bucket[0])
      }
      const live = list(name)
      const count = live.length + 1
      const level = Math.pow(10, (clip.gainDb || 0) / 20) / count
      // Rebalance the voices already sounding, not just the new one: N voices
      // at 1/N each sum to exactly one hit's level, so no overlap pattern can
      // make the stack louder than a single press.
      live.forEach((voice) => {
        voice.gain.gain.setValueAtTime(level, now)
        voice.scale = 1 / count
      })
      const gain = audio().createGain()
      gain.gain.setValueAtTime(level, now)
      const src = audio().createBufferSource()
      src.buffer = buffer
      src.connect(gain)
      gain.connect(audio().destination)
      const voice = { name: name, src: src, gain: gain, at: now, scale: 1 / count }
      src.onended = () => remove(voice)
      live.push(voice)
      src.start(now)
      return true
    }).catch(() => false)
  }

  // play() never opens the audio context. Before a gesture there is nothing to
  // play into, and a sound fired on page load is a bug in the page, not a
  // feature of the player. During the first gesture the pending unlock is
  // joined, so a click handler can call play() and still be heard.
  const play = (name) => {
    if (!enabled) return Promise.resolve(false)
    const ready = unlocked ? Promise.resolve(true) : opening === null ? Promise.resolve(false) : opening
    return ready.then((ok) => (ok ? fire(name) : false))
  }

  const unlock = () => {
    if (unlocked) return Promise.resolve(true)
    if (opening !== null) return opening
    const engine = audio()
    const started = engine.state === 'running'
      ? Promise.resolve(true)
      : engine.resume().then(() => engine.state === 'running')
    opening = started.then((ok) => {
      opening = null
      if (!ok) return false
      unlocked = true
      if (D.preload) D.clips.forEach((clip) => { load(clip).catch(() => {}) })
      return true
    }, () => {
      opening = null
      return false
    })
    return opening
  }

  const setEnabled = (value) => {
    enabled = value !== false
    if (!enabled) {
      voices.forEach((bucket) => bucket.slice().forEach((voice) => {
        silence(voice)
        remove(voice)
      }))
    }
    return enabled
  }

  const hook = (node, shape) => {
    if (typeof shape.click === 'string') node.addEventListener('click', () => trigger(shape.click))
    if (typeof shape.press === 'string') node.addEventListener('pointerdown', () => trigger(shape.press))
    if (typeof shape.enter === 'string') node.addEventListener('mouseenter', () => trigger(shape.enter))
    if (typeof shape.leave === 'string') node.addEventListener('mouseleave', () => trigger(shape.leave))
  }

  // A bound event is itself the gesture: open the context, then fire. A bare
  // clip name binds on click; { press } binds on pointerdown (the physical
  // press, before the click completes); { enter, leave } bind pointer hover.
  const trigger = (name) => (enabled ? unlock().then((ok) => (ok ? fire(name) : false)) : Promise.resolve(false))

  const bind = (selector, spec) => {
    const shape = typeof spec === 'string' ? { click: spec } : (spec || {})
    const nodes = document.querySelectorAll(selector)
    nodes.forEach((node) => hook(node, shape))
    return nodes.length
  }

  D.bindings.forEach((entry) => {
    document.querySelectorAll(entry.selector).forEach((node) => {
      hook(node, { click: entry.click, press: entry.press, enter: entry.enter, leave: entry.leave })
    })
  })

  // data-sound="press" plays on click; the enter/leave attributes add hover
  // sound, so a page needs no JavaScript of its own. Only elements present when
  // this runs are hooked; bind nodes added later with dshUI.bind.
  document.querySelectorAll('[data-sound], [data-sound-enter], [data-sound-leave]').forEach((node) => {
    hook(node, {
      click: node.getAttribute('data-sound'),
      enter: node.getAttribute('data-sound-enter'),
      leave: node.getAttribute('data-sound-leave')
    })
  })

  // One gesture anywhere opens the context, so a later play() from page code
  // (a success after an async save, say) is already allowed. Capture phase is
  // deliberate: it runs before a target's own handlers, so the very same click
  // that opens the context can still sound.
  const open = () => { if (!unlocked && opening === null) unlock() }
  document.addEventListener('pointerdown', open, true)
  document.addEventListener('keydown', open, true)

  const voiceState = () => {
    const state = {}
    voices.forEach((bucket, name) => {
      if (bucket.length === 0) return
      let sumGain = 0
      bucket.forEach((voice) => { sumGain += voice.scale })
      state[name] = { count: bucket.length, gainScale: bucket[bucket.length - 1].scale, sumGain: sumGain }
    })
    return state
  }

  window.dshUI = { play: play, bind: bind, setEnabled: setEnabled, unlock: unlock, voices: voiceState }
})()
`

/** Base64 decoder for a page whose clips are embedded in this script. */
const INLINE_READER = '(clip) => Promise.resolve(Uint8Array.from(atob(clip.data), (character) => character.charCodeAt(0)).buffer)'

/** Base64 or fetch, for a page whose clips are separate wav files. */
const EXTERNAL_READER = `(clip) => clip.data === undefined
    ? fetch(clip.src).then((response) => {
      if (!response.ok) throw new Error('dshUI ' + response.status + ' ' + clip.src)
      return response.arrayBuffer()
    })
    : Promise.resolve(Uint8Array.from(atob(clip.data), (character) => character.charCodeAt(0)).buffer)`

/**
 * Escape a JSON payload so it can sit inside a `<script>` element: `<` would
 * let a clip name close the tag, and the two line separators are valid JSON but
 * not valid JavaScript string content.
 */
function scriptData (value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Accept a selector map as an object or an array; normalize every binding. */
function normalizeBindings (selectorMap, clipNames) {
  if (selectorMap === undefined || selectorMap === null) return []
  const entries = Array.isArray(selectorMap)
    ? selectorMap.map((entry) => [entry?.selector, entry])
    : typeof selectorMap === 'object'
      ? Object.entries(selectorMap)
      : null
  if (entries === null) throw new Error('selectorMap must be an object of selector -> binding or an array of bindings')
  const bindings = []
  const seen = new Set()
  for (const [rawSelector, rawSpec] of entries) {
    const selector = typeof rawSelector === 'string' ? rawSelector.trim() : ''
    if (selector === '') throw new Error('selectorMap needs a non-empty selector for every binding')
    if (seen.has(selector)) throw new Error(`selectorMap binds "${selector}" twice`)
    seen.add(selector)
    const spec = typeof rawSpec === 'string' ? { click: rawSpec } : typeof rawSpec === 'object' && rawSpec !== null ? rawSpec : null
    if (spec === null) throw new Error(`selectorMap["${selector}"] must be a clip name or { click, press, enter, leave }`)
    const binding = { selector }
    let bound = false
    for (const event of ['click', 'press', 'enter', 'leave']) {
      const name = spec[event]
      if (name === undefined || name === null) continue
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`selectorMap["${selector}"].${event} must be a clip name`)
      }
      if (!clipNames.has(name)) {
        throw new Error(`selectorMap["${selector}"].${event} names unknown clip "${name}"; available: ${[...clipNames].join(', ')}`)
      }
      binding[event] = name
      bound = true
    }
    if (!bound) throw new Error(`selectorMap["${selector}"] binds no event; use a clip name or { click, press, enter, leave }`)
    bindings.push(binding)
  }
  return bindings
}

/**
 * Build the drop-in script that binds a rendered clip set to a page.
 *
 * Clip entries accept in-memory wav bytes (`bytes`, what `renderInteractionSet`
 * returns), a base64 string (`data`) or a URL (`src`). When every clip carries
 * bytes/data the script embeds them and contains no network code at all; when
 * any clip is a URL the script decodes the embedded ones and fetches the rest.
 *
 * `selectorMap` binds elements up front: `{ 'button.save': 'press' }` is a click
 * binding, `{ '.card': { enter: 'hover', leave: 'close', press: 'press' } }`
 * binds the named events. A page can also skip the map entirely and use
 * `data-sound` attributes.
 *
 * @param {object} request
 * @param {object[]} request.clips - rendered clips: { name, gainDb?, bytes?|data?|src? }.
 * @param {object|object[]} [request.selectorMap] - selector -> name or { click, press, enter, leave }.
 * @param {boolean} [request.preload] - decode every clip on unlock instead of on first play.
 * @returns {{ script: string, json: string, bytes: number }} script is the pasteable IIFE, json is the clip manifest (no base64), bytes is the script's UTF-8 length.
 */
export function buildBindingScript (request = {}) {
  const rawClips = request.clips
  if (!Array.isArray(rawClips) || rawClips.length === 0) {
    throw new Error('buildBindingScript needs at least one clip')
  }
  const names = new Set()
  const clips = rawClips.map((raw, index) => {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    if (name === '') throw new Error(`clip ${index + 1} has no name`)
    if (names.has(name)) throw new Error(`duplicate clip name "${name}"`)
    names.add(name)
    const requestedGain = Number(raw?.gainDb)
    const gainDb = round(clamp(Number.isFinite(requestedGain) ? requestedGain : 0, -60, 12), 2)
    let data = typeof raw?.data === 'string' && raw.data !== '' ? raw.data : undefined
    if (data === undefined && raw?.bytes !== undefined) data = Buffer.from(raw.bytes).toString('base64')
    const src = typeof raw?.src === 'string' ? raw.src.trim() : ''
    if (data === undefined && src === '') throw new Error(`clip "${name}" needs bytes, data or src`)
    const clip = { name, gainDb }
    if (data !== undefined) clip.data = data
    else clip.src = src
    return clip
  })

  const bindings = normalizeBindings(request.selectorMap, names)
  const inline = clips.every((clip) => clip.data !== undefined)
  const payload = {
    clips,
    bindings,
    preload: request.preload === true
  }
  const script = BINDING_SOURCE
    .replace('__DATA__', () => scriptData(payload))
    .replace('__READER__', () => (inline ? INLINE_READER : EXTERNAL_READER))

  const manifest = {
    inline,
    preload: payload.preload,
    clips: clips.map((clip) => (clip.data === undefined
      ? { name: clip.name, gainDb: clip.gainDb, src: clip.src }
      : { name: clip.name, gainDb: clip.gainDb, dataBytes: Buffer.byteLength(clip.data, 'base64') })),
    bindings
  }
  const json = JSON.stringify(manifest, null, 2)

  return { script, json, bytes: Buffer.byteLength(script, 'utf8') }
}
