/**
 * The in-page tier: a WebAudio synth that is generated as source code.
 *
 * Every other module in this plugin renders a wav. A wav is the right
 * deliverable for delivery and the wrong one for interaction: the page cannot
 * bend its pitch in response to input, cannot re-randomise it without asking the
 * host for another render, and has to ship the bytes. This module closes that
 * gap by emitting a small dependency-free script whose preset character follows
 * the same perceptual knobs as `lib/dsp.js` (`weight`, `hardness`, `metallic`,
 * `space`, `tone`, `speed`, `rise`, `decay`, `density`, `roughness`, `movement`,
 * `pitch`). The page then re-synthesises on demand: zero audio bytes, parameters
 * live, and no network.
 *
 * The module is pure: it emits text and returns data, so every claim in it is
 * testable without a browser. The same designer functions are used twice -- the
 * host calls them directly (`renderLiveSpec`) and the generated script carries
 * their source (`buildLiveScript`), so the graph a test inspects structurally is
 * the graph the page builds. That is why the designers take their helpers as an
 * argument (`h`) instead of closing over module imports: a closure would not
 * survive being stringified into the page, and `h.osc`/`h.noise` keep a layer
 * description short enough for the emitted script to stay small.
 *
 * Fidelity, per knob:
 *   - exact-ish (the same mapping an offline render uses): `weight` on impact
 *     and thud, `hardness` on tick and impact, `softness` on thud, `pitch` on
 *     tick/chime/zap/whoosh, `density`/`roughness`/`movement` on scrap and
 *     texture, `metallic` on chime and impact, `rise`/`tone` on whoosh and
 *     riser, `space` everywhere as a send amount.
 *   - approximate: envelopes (offline multiplies a per-sample exponential curve;
 *     live schedules ramps or `setTargetAtTime`), filter sweeps (offline pow
 *     curves become 2-3 point ramps), reverb (a two-tap feedback delay instead of
 *     the Schroeder network), noise (same spectral tilt, different samples),
 *     per-partial decay ratios on chime, and scattered grain density on scrap.
 *   - declared by an offline preset but unused there: `impact.tone` (live drops
 *     it rather than inventing a meaning the wav does not have), and
 *     `whoosh.speed`, which live does use (it sharpens the band-pass sweep).
 *
 * House rules for this file: the designers and the runtime below are emitted into
 * the page (squeezed by `squeezeSource`), so they must be self-contained -- no
 * closures over module state, no imports, only helpers passed in as `h` or
 * declared in this file.
 */

import { PRESETS } from './dsp.js'

/** Plan format tag; a page or a test can tell what it is looking at. */
export const LIVE_FORMAT = 'dsh-live-graph'

/** Script format version. Bumped only when the `window.dshLive` surface changes. */
export const LIVE_VERSION = '1.0.0'

/* --------------------------------------------------------------- helpers -- */
/* These are emitted into the page script verbatim, so each one is
 * self-contained: a helper may call another helper by name (function
 * declarations hoist inside the IIFE) but never a module-level constant. */

/**
 * 32-bit FNV-1a string hash. Deterministic across engines (no locale, no
 * overflow surprises beyond the deliberate `Math.imul`).
 * @param {string} text - seed material.
 * @returns {number} unsigned 32-bit hash.
 */
function liveHash (text) {
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h >>> 0
}

/**
 * Mulberry32 seeded from a string. The page must be able to randomise a take
 * without a re-render, but the same page load must produce the same sequence:
 * a seeded generator gives both.
 * @param {string} seedText - seed material.
 * @returns {() => number} uniform samples in [0, 1).
 */
function liveRng (seedText) {
  let state = liveHash(seedText)
  return function next () {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear interpolation (mirrors `lerp` in dsp.js, kept local for emission). */
function liveLerp (a, b, t) {
  return a + (b - a) * t
}

/** Clamp to [min, max] (mirrors `clamp` in dsp.js, kept local for emission). */
function liveClamp (value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** A constant contour, so every frequency field has the same plan shape. */
function liveHz (value) {
  return { pts: [[0, value], [1, value]], curve: 'lin' }
}

/** A two-point contour. `exp` reads as a doppler-ish glide, not a linear ramp. */
function liveRamp (from, to) {
  return { pts: [[0, from], [1, to]], curve: 'exp' }
}

/**
 * A three-point contour: `from` -> `mid` at normalised position `at` -> `to`.
 * Used where the offline renderer sweeps up and then back down (a whoosh's
 * band-pass centre, an impact body's pitch drop).
 */
function liveArc (from, mid, to, at) {
  return { pts: [[0, from], [at, mid], [1, to]], curve: 'exp' }
}

/** One oscillator layer: `id`, waveform, frequency contour, gain, envelope. */
function liveOsc (id, wave, freq, gain, env, extra) {
  const layer = { id: id, source: { type: 'osc', wave: wave, freq: freq }, gain: gain, env: env }
  if (extra) for (const key in extra) layer[key] = extra[key]
  return layer
}

/** One noise layer: buffer colour/length, optional biquad, gain, envelope. */
function liveNoise (id, color, seconds, filter, gain, env, extra) {
  const layer = { id: id, source: { type: 'noise', color: color, seconds: seconds }, filter: filter, gain: gain, env: env }
  if (extra) for (const key in extra) layer[key] = extra[key]
  return layer
}

/**
 * Bundle the primitives a designer may use. Designers call `h.rand()` for
 * per-take variation and never touch globals, which is what lets the emitted
 * copy behave identically to the host copy.
 * @param {() => number} rand - seeded generator, one stream per call site.
 */
function liveHelpers (rand) {
  return {
    lerp: liveLerp,
    hz: liveHz,
    ramp: liveRamp,
    arc: liveArc,
    osc: liveOsc,
    noise: liveNoise,
    rand: rand
  }
}

/**
 * Resolve and clamp a preset's knobs: defaults first, then any finite numeric
 * override on a declared knob, clamped by its declared range.
 *
 * A knob's range is `[0, 1]` unless the preset declares something else (a pitch
 * multiplier, for instance), so the emitted table only needs the exceptions --
 * that convention is what keeps the page script small. Mirrors `resolveParams`
 * in dsp.js: unknown keys are ignored so a stale guess cannot throw, and the
 * `kind` enum is the one place a string is accepted.
 * @param {string} name - preset.
 * @param {object} [over] - caller overrides.
 * @param {object} defaults - per-preset defaults.
 * @param {object} ranges - per-preset range exceptions.
 * @param {object} kinds - per-preset string enum, if any.
 * @returns {object} resolved params.
 */
function liveResolve (name, over, defaults, ranges, kinds) {
  const out = {}
  const def = defaults[name] || {}
  const range = ranges[name] || {}
  for (const key in def) out[key] = def[key]
  if (over && typeof over === 'object') {
    for (const key in over) {
      const limit = range[key] || [0, 1]
      if (typeof over[key] === 'number' && isFinite(over[key]) && def[key] !== undefined) {
        out[key] = liveClamp(over[key], limit[0], limit[1])
      }
    }
    const allowed = kinds[name]
    if (allowed && allowed.indexOf(over.kind) >= 0) out.kind = over.kind
  }
  return out
}

/* -------------------------------------------------------------- presets -- */
/* Each designer returns { layers, space, master } and optionally `loop` and
 * `duration`. A layer is one source -> optional filter -> gain envelope chain;
 * the runtime in the emitted script walks the array, so the designers stay pure
 * data and every graph can be asserted without a browser. Envelope and filter
 * contours are normalised to the preset's duration, except a percussive
 * envelope `{ a, d }` whose times are seconds. */

/**
 * impact: body thump + sub + transient click + inharmonic ring. Offline the ring
 * is five decaying sines; here each ratio is its own layer, so the sum has the
 * same inharmonic spread.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function impactPlan (p, h) {
  const L = h.lerp, Z = h.hz, R = h.ramp, A = h.arc
  const base = L(150, 52, p.weight) * p.pitch
  const body = L(0.1, 0.5, p.weight)
  const layers = [
    h.osc('body', 'sine', A(base * 2.4, base * 1.35, base, 0.18), 0.9, { a: 0.002, d: body }),
    h.osc('sub', 'sine', R(base * 0.5, base * 0.45), 0.55 * p.weight, { a: 0.004, d: body * 1.1 }),
    h.noise('click', 'white', 0.08, { type: 'highpass', freq: Z(L(1800, 5200, p.hardness)), q: 0.9 }, 0.5 * L(0.6, 1, p.hardness), { a: 0.0005, d: L(0.012, 0.003, p.hardness) })
  ]
  if (p.metallic > 0.01) {
    const ratios = [1, 1.71, 2.43, 3.17, 4.61]
    const ring = L(0.1, 0.42, p.metallic)
    for (let i = 0; i < ratios.length; i += 1) {
      layers.push(h.osc('ring' + i, 'sine', Z(base * 3.1 * ratios[i]), p.metallic * 0.18 * (0.6 + h.rand() * 0.6), { a: 0.001, d: ring * (1 - i * 0.12) }))
    }
  }
  return { layers: layers, space: { amount: p.space * 0.5, feedback: 0.4, damping: 3200, spread: 0.01 + p.space * 0.03 }, master: { gain: 0.85 } }
}

/**
 * whoosh: pink noise through a band-pass whose centre sweeps up and back down,
 * plus a faint tonal arc. `rise` moves the amplitude peak (the offline formula);
 * `speed` sharpens the sweep's Q, which the offline renderer declares but ignores.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function whooshPlan (p, h) {
  const L = h.lerp, Z = h.hz, A = h.arc
  const peak = L(0.32, 0.75, 1 - p.rise)
  const lo = 260 * p.pitch
  const hi = L(900, 4200, p.tone) * p.pitch
  const out = L(180, 700, p.tone) * p.pitch
  return {
    layers: [
      h.noise('air', 'pink', 0.8, { type: 'bandpass', freq: A(lo, hi, out, peak), q: { pts: [[0, 1.2], [peak, L(2.5, 7.5, p.speed)], [1, 1.2]], curve: 'lin' } }, 0.9, { pts: [[0, 0], [peak * 0.5, 0.55], [peak, 1], [1, 0]], curve: 'lin' }),
      h.osc('tone', 'sine', A(lo * 2.2, hi * 1.3, out * 2.6, peak), L(0.06, 0.22, p.tone), { pts: [[0, 0], [peak, 1], [1, 0]], curve: 'lin' })
    ],
    space: { amount: p.space * 0.55, feedback: 0.45, damping: 2600 },
    master: { gain: 0.9 }
  }
}

/**
 * tick: the shortest sound in the vocabulary. A sine blip plus a high-passed
 * noise burst; `hardness` shortens both (the documented contract the tests pin),
 * `pitchJitter` detunes each play.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function tickPlan (p, h) {
  const L = h.lerp, Z = h.hz
  const hz = L(900, 5200, p.pitch) * (1 + (h.rand() - 0.5) * 0.4 * p.pitchJitter)
  const d = L(0.03, 0.004, p.hardness)
  return {
    layers: [
      h.osc('tone', 'sine', Z(hz), 0.7, { a: 0.0005, d: d }),
      h.noise('burst', 'white', 0.05, { type: 'highpass', freq: Z(L(1200, 6000, p.hardness)), q: 0.9 }, 0.45, { a: 0.0005, d: d * 0.8 })
    ],
    space: null,
    master: { gain: 0.9 }
  }
}

/**
 * chime: four inharmonic sine partials with shorter decays for higher partials,
 * plus an audio-rate amplitude-modulated shimmer (the offline renderer multiplies
 * the shimmer by a sine of its own pitch, which is the same trick as an LFO).
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function chimePlan (p, h) {
  const L = h.lerp, Z = h.hz
  const base = L(320, 1400, p.pitch)
  const ratios = [1, 2.76, 5.4, 8.93]
  const d = L(0.1, 0.6, p.decay)
  const layers = []
  for (let i = 0; i < ratios.length; i += 1) {
    layers.push(h.osc('partial' + i, 'sine', Z(base * ratios[i]), (i === 0 ? 1 : L(0.12, 0.55, p.metallic) / (i + 0.6)) * 0.42, { a: 0.0015, d: i === 0 ? d : d / (1 + i * 0.7) }))
  }
  layers.push(h.osc('shimmer', 'sine', Z(base * 2), 0.075, { a: 0.001, d: d * 0.55 }, { lfo: { freq: Z(base * 0.5), depth: 0.4, target: 'gain' } }))
  return { layers: layers, space: { amount: p.space * 0.6, feedback: 0.5, damping: 4200, spread: 0.02 }, master: { gain: 0.62 } }
}

/**
 * riser: a band-pass sweeping upward under a rising amplitude with an
 * accelerating tremolo, plus a saw tone climbing underneath.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function riserPlan (p, h) {
  const L = h.lerp, Z = h.hz
  const top = L(3000, 9000, p.tone)
  const tension = p.tension
  return {
    layers: [
      h.noise('air', 'pink', 1.6, { type: 'bandpass', freq: { pts: [[0, 180], [0.5, top * 0.45], [1, top]], curve: 'exp' }, q: Z(L(0.9, 7, tension)) }, 0.85, { pts: [[0, 0.02], [0.55, 0.4], [1, 1]], curve: 'exp' }, { lfo: { freq: { pts: [[0, 3], [1, L(3, 14, tension)]], curve: 'lin' }, depth: 0.3, target: 'gain' } }),
      h.osc('tone', 'sawtooth', { pts: [[0, 90], [1, L(500, 1500, p.tone)]], curve: 'exp' }, 0.3, { pts: [[0, 0], [0.7, 0.35], [1, 1]], curve: 'exp' }, { filter: { type: 'lowpass', freq: Z(L(1200, 5200, p.tone)), q: 0.7 } })
    ],
    space: { amount: p.space * 0.5, feedback: 0.48, damping: 3000, spread: 0.02 },
    master: { gain: 0.72 }
  }
}

/**
 * zap: a downward chirp (a saw through a low-pass stands in for the offline
 * tanh-sharpened square), a bright crackle burst and a band-passed fizz offset a
 * few milliseconds later so the discharge reads as several events.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function zapPlan (p, h) {
  const L = h.lerp, Z = h.hz
  const start = L(1400, 5200, p.pitch)
  const end = L(60, 220, p.pitch)
  const d = L(0.05, 0.16, p.roughness)
  return {
    layers: [
      h.osc('chirp', 'sawtooth', { pts: [[0, start], [0.35, end * 3], [1, end]], curve: 'exp' }, 0.8, { a: 0.001, d: d }, { filter: { type: 'lowpass', freq: Z(L(2600, 7000, p.pitch)), q: 1.1 } }),
      h.noise('crackle', 'white', 0.08, { type: 'highpass', freq: Z(3200), q: 1.2 }, 0.5 * L(0.5, 1, p.roughness), { a: 0.0005, d: 0.02 }),
      h.noise('fizz', 'white', 0.12, { type: 'bandpass', freq: Z(L(1800, 5200, p.pitch)), q: 2.2 }, 0.2 * p.roughness, { a: 0.001, d: d * 0.8 }, { at: 0.012 })
    ],
    space: { amount: p.space * 0.4, feedback: 0.42, damping: 3600 },
    master: { gain: 0.8 }
  }
}

/**
 * thud: sine body plus a low-passed brown-noise tail. `weight` lowers the tail
 * cutoff (the offline renderer maps it exactly this way), `softness` stretches
 * the decay.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function thudPlan (p, h) {
  const L = h.lerp, Z = h.hz, A = h.arc
  const hz = L(95, 46, p.weight)
  return {
    layers: [
      h.osc('body', 'sine', A(hz * 1.6, hz, hz, 0.25), 0.9, { a: 0.004, d: L(0.11, 0.25, p.softness) }),
      h.noise('tail', 'brown', 0.4, { type: 'lowpass', freq: Z(L(180, 420, 1 - p.weight)), q: 0.7 }, 0.35, { a: 0.002, d: L(0.05, 0.16, p.softness) })
    ],
    space: { amount: p.space * 0.45, feedback: 0.38, damping: 1800 },
    master: { gain: 0.92 }
  }
}

/**
 * scrap: a cluster of short band-passed noise grains. `density` sets how many,
 * `tone` their centre, `roughness` their Q. Each grain is an independent layer
 * with its own start offset, which is how the offline renderer scatters them.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function scrapPlan (p, h) {
  const L = h.lerp, Z = h.hz
  const grains = Math.max(2, Math.round(L(2, 14, p.density)))
  const layers = []
  for (let i = 0; i < grains; i += 1) {
    const d = 0.006 + h.rand() * 0.03
    // One fixed buffer length for every grain (0.06 s covers the longest decay):
    // the page caches noise buffers by length, so a per-grain length would mint a
    // new buffer on every play and grow the cache forever.
    layers.push(h.noise('grain' + i, 'white', 0.06, { type: 'bandpass', freq: Z(L(700, 5200, p.tone) * (0.7 + h.rand() * 0.8)), q: L(2, 9, p.roughness) }, 0.28 + h.rand() * 0.28, { a: 0.0005, d: d }, { at: h.rand() * 0.52 }))
  }
  return { layers: layers, space: { amount: p.space * 0.5, feedback: 0.44, damping: 3800 }, master: { gain: 0.7 } }
}

/**
 * texture: a looping bed. Wind/rain/fire/room are filtered noise with a slow
 * movement LFO; rain adds a baked droplet pattern and fire a baked pop pattern
 * (an event buffer is a cheaper way to get sparse transients than a scheduler,
 * and a 3 s noise loop has no seam a listener can hear). The `hum` bed is a 55 Hz
 * sawtooth through a low-pass -- its own harmonics are the 110/165 Hz partials,
 * and 55 Hz is a whole number of cycles in 3 s, so it loops clean.
 * @param {object} p - resolved knobs.
 * @param {object} h - helpers.
 */
function texturePlan (p, h) {
  const L = h.lerp, Z = h.hz
  const dur = 3
  const tone = p.tone, dens = p.density, move = p.movement
  const kind = p.kind
  const drift = { freq: Z(L(0.15, 0.45, move)), depth: 0.35 * move, target: 'gain' }
  // A local function declaration, not a closure over module state: the emitted
  // copy of this designer has to be self-contained. `source.loop` is what makes
  // one buffer repeat for the life of the bed.
  function bed (id, color, filter, gain, lfo) {
    const layer = h.noise(id, color, dur, filter, gain, null, { lfo: lfo })
    layer.source.loop = true
    return layer
  }
  let layers
  if (kind === 'hum') {
    // A 55 Hz sawtooth through a low-pass is the mains hum: the harmonics the
    // offline renderer adds as three separate sines are already in the wave, and
    // 55 Hz covers a whole number of cycles in the 3 s loop.
    layers = [
      h.osc('mains', 'sawtooth', Z(55), 0.16, null, { filter: { type: 'lowpass', freq: Z(180), q: 0.7 } }),
      bed('air', 'pink', { type: 'lowpass', freq: Z(400), q: 0.6 }, 0.15 * dens)
    ]
  } else if (kind === 'fire') {
    layers = [
      bed('roar', 'pink', { type: 'lowpass', freq: Z(L(320, 1400, tone)), q: 0.8 }, 1.1, { freq: Z(L(4, 9, move)), depth: 0.3 + 0.4 * dens, target: 'gain' }),
      bed('pops', 'pops', { type: 'bandpass', freq: Z(L(1600, 5600, tone)), q: 1.4 }, 0.35 + 0.5 * dens)
    ]
  } else if (kind === 'room') {
    layers = [
      bed('body', 'pink', { type: 'lowpass', freq: Z(L(200, 420, tone)), q: 0.65 }, 1.1, drift),
      bed('modes', 'pink', { type: 'bandpass', freq: Z(190), q: 5 }, 0.28),
      bed('sub', 'brown', { type: 'lowpass', freq: Z(95), q: 0.6 }, 0.45)
    ]
  } else {
    layers = [
      bed('bed', 'pink', { type: 'lowpass', freq: Z(L(180, 900, tone)), q: 0.7 }, 1, drift),
      bed('gust', 'white', { type: 'highpass', freq: Z(L(700, 2200, tone)), q: 0.7 }, 0.02 + 0.03 * (1 - dens))
    ]
  }
  if (kind === 'rain') {
    layers.push(bed('drops', 'drops', { type: 'highpass', freq: Z(900), q: 0.8 }, 0.18 + 0.32 * dens))
    layers.push(bed('hiss', 'white', { type: 'highpass', freq: Z(L(1500, 6000, tone)), q: 0.8 }, 0.03 + 0.11 * dens))
  }
  return { layers: layers, space: null, master: { gain: 0.85 }, duration: dur, loop: true }
}

/** Canonical order and factory table. Order is part of the output bytes. */
const CORE_NAMES = ['impact', 'whoosh', 'tick', 'chime', 'riser', 'zap', 'thud', 'scrap', 'texture']
const DESIGNS = {
  impact: impactPlan,
  whoosh: whooshPlan,
  tick: tickPlan,
  chime: chimePlan,
  riser: riserPlan,
  zap: zapPlan,
  thud: thudPlan,
  scrap: scrapPlan,
  texture: texturePlan
}

/** Where each preset diverges from its offline render. Shown by tools/docs. */
const APPROXIMATIONS = {
  impact: ['ring partials share one decay-envelope family instead of five independent noise-weighted envelopes', 'reverb is a two-tap feedback delay, not the Schroeder network'],
  whoosh: ['the amplitude arc is a four-point ramp, not a pow curve', 'speed sharpens the band-pass Q (the offline renderer ignores speed)'],
  tick: ['the offline renderer scales a per-sample exponential; live uses ramp decay seconds', 'pitchJitter is drawn per play in the page instead of per render'],
  chime: ['per-partial decay ratios are approximated by dividing the fundamental decay', 'the shimmer is an audio-rate gain LFO rather than a multiplied sine'],
  riser: ['the sweep is a three-point ramp with an exponential curve', 'the tremolo depth is fixed at 0.3'],
  zap: ['the chirp is a low-passed sawtooth instead of a tanh square', 'the crackle is one burst plus an offset fizz rather than gated noise'],
  thud: ['the tail noise is a brown buffer through a biquad rather than a per-sample low-pass', 'the body pitch arc is a three-point ramp'],
  scrap: ['grain timing and gains come from the page RNG at play time, so each play differs', 'grain decay uses ramp envelopes'],
  texture: ['droplets and pops are baked into a 3 s event buffer at a fixed density instead of Poisson-distributed grains', 'tonal layers are loop-safe; noise layers loop with a small sample step']
}

/**
 * Knobs an offline preset declares but never reads. Live drops them rather than
 * inventing a meaning the wav does not have (`impact.tone` is the only one in the
 * core nine). Every other default and range is copied from `PRESETS`, so the two
 * tiers cannot drift.
 */
const UNUSED_KNOBS = { impact: ['tone'] }

/** Defaults/ranges/kinds are shared with the offline tier so the two cannot drift. */
const LIVE_DEFAULTS = {}
const LIVE_RANGES = {}
const LIVE_KINDS = {}
const LIVE_DURATIONS = {}
for (const name of CORE_NAMES) {
  const skip = UNUSED_KNOBS[name] ?? []
  const defaults = {}
  const ranges = {}
  for (const [key, value] of Object.entries(PRESETS[name].defaults)) if (!skip.includes(key)) defaults[key] = value
  for (const [key, value] of Object.entries(PRESETS[name].params)) if (!skip.includes(key)) ranges[key] = value
  LIVE_DEFAULTS[name] = defaults
  LIVE_RANGES[name] = ranges
  LIVE_DURATIONS[name] = PRESETS[name].defaultDuration
  if (PRESETS[name].kinds !== undefined) LIVE_KINDS[name] = PRESETS[name].kinds
}

/**
 * The live preset catalogue: nine families, each a designer that turns perceptual
 * knobs into a WebAudio graph description.
 * @type {Record<string, {name: string, description: string, bed: boolean, defaults: object, ranges: object, kinds?: string[], design: Function, approximations: string[]}>}
 */
export const LIVE_PRESETS = {}
for (const name of CORE_NAMES) {
  LIVE_PRESETS[name] = {
    name,
    description: PRESETS[name].description,
    bed: name === 'texture',
    defaults: LIVE_DEFAULTS[name],
    ranges: LIVE_RANGES[name],
    kinds: LIVE_KINDS[name],
    design: DESIGNS[name],
    approximations: APPROXIMATIONS[name]
  }
}

/** The live preset ids, in canonical order. */
export const LIVE_PRESET_NAMES = CORE_NAMES.slice()

/* ----------------------------------------------------------- plan maker -- */

/**
 * Describe the graph a page would build for one preset without touching any
 * browser API. The returned data is what the emitted script computes internally:
 * `layers` are source -> filter -> gain-envelope chains, `space` is the send to
 * the delay network, `master` is the preset's output trim.
 *
 * Envelope and contour conventions: `{ pts: [[fraction, value], ...] }` is a
 * breakpoint contour normalised to the preset duration; a percussive envelope is
 * `{ a, d }` in seconds. An osc source carries `freq`, a noise source a `color`
 * (`white|pink|brown|drops|pops`) and a buffer length.
 * @param {string} name - preset id, one of LIVE_PRESET_NAMES.
 * @param {object} [params] - perceptual knobs; unknown keys are ignored.
 * @param {{seed?: number, sampleRate?: number}} [options] - seed for the
 *   per-call random stream (ring gains, grain placement) and the sample rate.
 * @returns {object} plain-JSON graph description.
 */
export function renderLiveSpec (name, params = {}, options = {}) {
  if (LIVE_PRESETS[name] === undefined) {
    throw new Error(`unknown live preset "${name}"; available: ${LIVE_PRESET_NAMES.join(', ')}`)
  }
  const seed = Number.isFinite(options.seed) ? options.seed : 1
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 44100
  const resolved = liveResolve(name, params, LIVE_DEFAULTS, LIVE_RANGES, LIVE_KINDS)
  const body = LIVE_PRESETS[name].design(resolved, liveHelpers(liveRng(`spec:${name}:${seed}`)))
  return {
    format: LIVE_FORMAT,
    version: LIVE_VERSION,
    name,
    loop: body.loop === true,
    durationSeconds: body.duration ?? LIVE_DURATIONS[name],
    sampleRate,
    seed,
    params: resolved,
    layers: body.layers,
    space: body.space ?? null,
    master: body.master
  }
}

/* ------------------------------------------------------------- emitted JS -- */

/**
 * Remove every byte of whitespace inside a statement that is not needed to
 * separate two tokens, while keeping the line breaks that end a statement.
 *
 * The generated script is page weight, so it ships squeezed while the readable
 * source lives here. A line break is preserved because JavaScript's automatic
 * semicolon insertion depends on it (`f()` followed by `for(...)` is only a
 * statement boundary because of the newline); removing it would change the
 * program. Within a line the pass is whitespace-only and never inspects a token:
 * string literals are copied verbatim (so a space inside a string is safe), and a
 * space survives only where dropping it would fuse two word characters
 * (`var x`), turn `+ +` into `++`, open a comment (`/ /`) or start an HTML
 * comment (`< !`). It does not rename identifiers and does not remove code,
 * which is why the test can parse and run the result and mean it.
 * @param {string} source - readable JavaScript.
 * @returns {string} squeezed JavaScript.
 */
function squeezeSource (source) {
  const word = /[A-Za-z0-9_$]/
  let out = ''
  let quote = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (quote !== '') {
      out += ch
      if (ch === '\\') {
        out += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      let end = i
      while (end < source.length && /[ \n\t\r]/.test(source[end])) end += 1
      const run = source.slice(i, end)
      const prev = out[out.length - 1]
      const next = source[end]
      const fuse = word.test(prev === undefined ? '' : prev) && word.test(next === undefined ? '' : next)
      const operator = (prev === '+' || prev === '-') && next === prev
      const comment = prev === '/' && (next === '/' || next === '*')
      const htmlComment = prev === '<' && next === '!'
      if (run.indexOf('\n') >= 0) {
        // Keep the statement break; the trailing trim below removes any run of
        // them left by blank lines.
        if (out !== '' && next !== undefined) out += '\n'
      } else if (fuse || operator || comment || htmlComment) {
        out += ' '
      }
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out.replace(/\n{2,}/g, '\n')
}

/**
 * Strip the host-side indentation and standalone comments from a function, then
 * squeeze it, so it can be pasted into the page script. Only lines that start
 * with `//` are dropped: the designers contain no multi-line strings, so trimming
 * a line can never change a literal.
 * @param {Function} fn - function to serialise.
 * @returns {string} squeezed source.
 */
function compactSource (fn) {
  const lines = fn.toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  return squeezeSource(lines.join('\n'))
}

/** UTF-8 byte length, so `bytes` means bytes and not JS string units. */
function utf8Bytes (text) {
  return new TextEncoder().encode(text).length
}

function json (value) {
  return JSON.stringify(value)
}

/* The runtime is the part of the script that is hand-written here and shipped
 * squeezed. It never creates an AudioContext before `unlock()` (browsers refuse
 * to start audio outside a gesture and warn if you try), keeps at most
 * `maxVoices` sounding voices by stealing the oldest with a short fade, scales
 * each new voice by 1/sqrt(1 + sounding) so a rapid retrigger does not sum into
 * the limiter, and routes every voice through one DynamicsCompressorNode. Beds
 * keep a shared two-delay feedback network; a voice's send gain is its
 * `space.amount`. Every envelope is designed to finish inside its preset's
 * duration, which is why a voice can stop a fixed 150 ms after it. */
const RUNTIME = squeezeSource([
  'var ctx=null,limiter=null,master=null,cache={},spaces={},voices=[],volumeDb=VOL',
  "var rand=liveRng('live:'+SEED)",
  'function unlock(){',
  'if(ctx===null){',
  'var AC=root.AudioContext||root.webkitAudioContext',
  'if(!AC)return false',
  'try{ctx=new AC({sampleRate:SR})}catch(e){try{ctx=new AC()}catch(e2){ctx=null;return false}}',
  'limiter=ctx.createDynamicsCompressor()',
  'limiter.threshold.value=-6',
  'limiter.knee.value=6',
  'limiter.ratio.value=12',
  'limiter.attack.value=0.003',
  'limiter.release.value=0.12',
  'master=ctx.createGain()',
  'master.gain.value=Math.pow(10,volumeDb/20)',
  'limiter.connect(master)',
  'master.connect(ctx.destination)}',
  "if(ctx.state==='suspended'&&ctx.resume){try{ctx.resume()}catch(e){}}",
  'return true}',
  'function isUnlocked(){return ctx!==null}',
  'function setVolume(db){',
  "volumeDb=typeof db==='number'&&isFinite(db)?liveClamp(db,-60,12):0",
  'if(master!==null){var g=Math.pow(10,volumeDb/20);try{master.gain.setTargetAtTime(g,ctx.currentTime,0.02)}catch(e){master.gain.value=g}}',
  'return volumeDb}',
  'function bufferFor(color,seconds){',
  "var key=color+':'+seconds",
  'if(cache[key]!==undefined)return cache[key]',
  'var frames=Math.max(8,Math.round(seconds*SR)),buffer=ctx.createBuffer(1,frames,SR),data=buffer.getChannelData(0)',
  "var r=liveRng('buf:'+SEED+':'+key),i,w,b0=0,b1=0,b2=0,last=0",
  "if(color==='drops'||color==='pops'){",
  "var count=Math.round(seconds*(color==='drops'?90:45))",
  'for(var e=0;e<count;e+=1){',
  "var len=Math.max(4,Math.round((color==='drops'?0.0016:0.0022)*SR*(0.6+r()*0.9))),at=Math.floor(r()*Math.max(1,frames-len-2)),amp=0.35+r()*0.65",
  'for(i=0;i<len;i+=1)data[at+i]+=amp*(r()*2-1)*Math.exp(-i/(len*0.4))}}else{',
  'for(i=0;i<frames;i+=1){',
  'w=r()*2-1',
  "if(color==='pink'){b0=0.99765*b0+w*0.099046;b1=0.963*b1+w*0.2965164;b2=0.57*b2+w*1.0526913;data[i]=(b0+b1+b2+w*0.1848)*0.25}",
  "else if(color==='brown'){last=liveClamp(last+w*0.02,-1,1);data[i]=last*0.5}",
  'else data[i]=w*0.5}}',
  'cache[key]=buffer',
  'return buffer}',
  'function sched(param,base,span,spec){',
  'if(!spec||!spec.pts)return',
  'var pts=spec.pts,exp=spec.curve==="exp",i',
  'param.setValueAtTime(pts[0][1],base+pts[0][0]*span)',
  'for(i=1;i<pts.length;i+=1){',
  'var t=base+pts[i][0]*span,v=pts[i][1]',
  'if(exp&&pts[i-1][1]>0&&v>0)param.exponentialRampToValueAtTime(v,t)',
  'else param.linearRampToValueAtTime(v,t)}}',
  'function envAt(param,base,span,env,level){',
  'if(env.pts!==undefined){',
  'var scaled=[],i',
  'for(i=0;i<env.pts.length;i+=1)scaled.push([env.pts[i][0],env.pts[i][1]*level])',
  'sched(param,base,span,{pts:scaled,curve:env.curve})',
  'return}',
  'var a=Math.max(env.a,0.0005),d=Math.max(env.d,0.002)',
  'param.setValueAtTime(0.0001,base)',
  'param.linearRampToValueAtTime(level,base+a)',
  'param.setTargetAtTime(0.0001,base+a,d/4)}',
  'function buildLayer(voice,plan,layer,now){',
  'var dur=plan.duration,t0=now+(layer.at||0),tail=plan.loop===true?null:voice.stopAt,src',
  'if(layer.source.type==="osc"){',
  'src=ctx.createOscillator()',
  'src.type=layer.source.wave',
  'if(layer.source.detune)src.detune.value=layer.source.detune',
  'sched(src.frequency,t0,dur,layer.source.freq)}else{',
  'src=ctx.createBufferSource()',
  'src.buffer=bufferFor(layer.source.color,layer.source.seconds)',
  'src.loop=layer.source.loop===true||plan.loop===true}',
  'src.start(t0)',
  'if(tail!==null&&!(layer.source.type==="noise"&&plan.loop===true))src.stop(tail)',
  'voice.sources.push(src)',
  'src.onended=function(){retire(voice)}',
  'var node=src,flt=null',
  'if(layer.filter){',
  'flt=ctx.createBiquadFilter()',
  'flt.type=layer.filter.type',
  'sched(flt.frequency,t0,dur,layer.filter.freq)',
  'if(typeof layer.filter.q==="number")flt.Q.value=layer.filter.q',
  'else sched(flt.Q,t0,dur,layer.filter.q)',
  'node.connect(flt)',
  'node=flt}',
  'var g=ctx.createGain()',
  'if(!layer.env)g.gain.value=layer.gain',
  'else envAt(g.gain,t0,dur,layer.env,layer.gain)',
  'node.connect(g)',
  'node=g',
  'if(layer.lfo){',
  'var lfo=ctx.createOscillator(),depth=ctx.createGain()',
  'sched(lfo.frequency,t0,dur,layer.lfo.freq)',
  'if(layer.lfo.target==="filter"&&flt!==null){',
  'depth.gain.value=layer.lfo.depth',
  'lfo.connect(depth)',
  'depth.connect(flt.frequency)}else{',
  'var half=layer.lfo.depth*0.5,trem=ctx.createGain()',
  'trem.gain.value=1-half',
  'depth.gain.value=half',
  'lfo.connect(depth)',
  'depth.connect(trem.gain)',
  'node.connect(trem)',
  'node=trem}',
  'lfo.start(t0)',
  'if(tail!==null)lfo.stop(tail)',
  'voice.sources.push(lfo)}',
  'node.connect(voice.bus)}',
  'function spaceIn(spec){',
  'var key=Math.round(spec.damping/100)+":"+Math.round(spec.feedback*20)+":"+Math.round((spec.spread||0)*50)',
  'if(spaces[key]!==undefined)return spaces[key]',
  'var input=ctx.createGain(),a=ctx.createDelay(0.4),b=ctx.createDelay(0.4)',
  'a.delayTime.value=0.029+(spec.spread||0)',
  'b.delayTime.value=0.041+(spec.spread||0)*1.6',
  'var lp=ctx.createBiquadFilter()',
  'lp.type="lowpass"',
  'lp.frequency.value=spec.damping',
  'var fa=ctx.createGain(),fb=ctx.createGain(),wet=ctx.createGain()',
  'fa.gain.value=Math.min(spec.feedback,0.72)',
  'fb.gain.value=Math.min(spec.feedback*0.93,0.7)',
  'wet.gain.value=0.6',
  'input.connect(a)',
  'input.connect(b)',
  'a.connect(lp)',
  'b.connect(lp)',
  'lp.connect(fa)',
  'fa.connect(a)',
  'lp.connect(fb)',
  'fb.connect(b)',
  'lp.connect(wet)',
  'wet.connect(limiter)',
  'spaces[key]=input',
  'return input}',
  'function retire(voice){',
  'if(voice.end!==0)return',
  'if(voice.send)try{voice.send.disconnect()}catch(e){}',
  'try{voice.bus.disconnect()}catch(e){}}',
  'function hardStop(voice,fade){',
  'var t=ctx.currentTime,gap=Math.max(fade,0.005)',
  'try{voice.bus.gain.cancelScheduledValues(t)',
  'voice.bus.gain.setValueAtTime(voice.gain,t)',
  'voice.bus.gain.linearRampToValueAtTime(0.0001,t+gap)}catch(e){}',
  'for(var i=0;i<voice.sources.length;i+=1){try{voice.sources[i].stop(t+gap+0.01)}catch(e){}}',
  'voice.end=0}',
  'function sweep(now){',
  'for(var i=voices.length-1;i>=0;i-=1){',
  'if(voices[i].end<=now){try{voices[i].bus.disconnect();if(voices[i].send)voices[i].send.disconnect()}catch(e){}',
  'voices.splice(i,1)}}}',
  'function play(name,over){',
  'if(ctx===null||PLANS[name]===undefined)return null',
  'if(ctx.state==="suspended"&&ctx.resume){try{ctx.resume()}catch(e){}}',
  'var resolved=liveResolve(name,over,DEF,RNG,KINDS),body=PLANS[name](resolved,liveHelpers(rand))',
  'var plan={loop:body.loop===true,duration:body.duration||DUR[name],layers:body.layers,space:body.space,master:body.master}',
  'var now=ctx.currentTime+0.004',
  'sweep(now)',
  'var sounding=0,i',
  'for(i=0;i<voices.length;i+=1)if(voices[i].end>now)sounding+=1',
  'while(voices.length>=MAXV){hardStop(voices[0],0.012)',
  'voices.shift()',
  'sounding=Math.min(sounding,MAXV-1)}',
  'var comp=1/Math.sqrt(1+sounding),bus=ctx.createGain()',
  'bus.gain.value=comp*plan.master.gain',
  'bus.connect(limiter)',
  'var tail=now+plan.duration+0.15',
  'var voice={name:name,bus:bus,gain:bus.gain.value,stopAt:tail,sources:[],end:plan.loop?Infinity:tail}',
  'for(i=0;i<plan.layers.length;i+=1)buildLayer(voice,plan,plan.layers[i],now)',
  'if(plan.space!==null){',
  'var send=ctx.createGain()',
  'send.gain.value=plan.space.amount',
  'bus.connect(send)',
  'send.connect(spaceIn(plan.space))',
  'voice.send=send}',
  'voices.push(voice)',
  'return{name:name,gain:voice.gain,bed:plan.loop,stop:function(){hardStop(voice,0.03)',
  'return true}}}',
  'function stop(name){',
  'var n=0',
  'for(var i=voices.length-1;i>=0;i-=1)if(voices[i].name===name){hardStop(voices[i],0.03)',
  'voices.splice(i,1)',
  'n+=1}',
  'return n>0}',
  'function stopAll(){',
  'var n=voices.length',
  'for(var i=0;i<voices.length;i+=1)hardStop(voices[i],0.03)',
  'voices.length=0',
  'return n>0}',
  'function activeVoices(){if(ctx===null)return 0',
  'sweep(ctx.currentTime)',
  'return voices.length}',
  'var api={play:play,stop:stop,stopAll:stopAll,setVolume:setVolume,unlock:unlock,isUnlocked:isUnlocked,activeVoices:activeVoices,version:VERSION}',
  'root.dshLive=api',
  'return api'
].join('\n'))


/**
 * The emitted range table: only the exceptions to the `[0, 1]` convention, so a
 * script that uses nine presets does not pay for ~40 identical `[0, 1]` pairs.
 * @param {string[]} names - presets in the build.
 * @returns {object} per-preset overrides.
 */
function rangeExceptions (names) {
  const out = {}
  for (const name of names) {
    const overrides = {}
    for (const [key, range] of Object.entries(LIVE_RANGES[name])) {
      if (range[0] !== 0 || range[1] !== 1) overrides[key] = range
    }
    if (Object.keys(overrides).length > 0) out[name] = overrides
  }
  return out
}

/** Everything the emitted script needs before the runtime: helpers + tables. */
function emitLibrary (names) {
  const helperSources = [
    compactSource(liveHash),
    compactSource(liveRng),
    compactSource(liveLerp),
    compactSource(liveClamp),
    compactSource(liveHz),
    compactSource(liveRamp),
    compactSource(liveArc),
    compactSource(liveOsc),
    compactSource(liveNoise),
    compactSource(liveHelpers),
    compactSource(liveResolve)
  ]
  const presetPlans = names.map((name) => `PLANS[${json(name)}]=${compactSource(DESIGNS[name])};`)
  return [
    ...helperSources,
    `var DEF=${json(pick(LIVE_DEFAULTS, names))}`,
    `var RNG=${json(rangeExceptions(names))}`,
    `var KINDS=${json(pick(LIVE_KINDS, names))}`,
    `var DUR=${json(pick(LIVE_DURATIONS, names))}`,
    'var PLANS={}',
    ...presetPlans
  ].join('\n')
}

function pick (table, names) {
  const out = {}
  for (const name of names) if (table[name] !== undefined) out[name] = table[name]
  return out
}

function intOption (value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.round(value) : fallback
  return liveClamp(number, min, max)
}

/**
 * Normalise a requested preset list: unknown ids are dropped, duplicates are
 * removed and the result is sorted into canonical order, so the same set always
 * produces the same bytes no matter how the caller spelled it. An omitted list
 * means every live preset; an explicit empty list means "runtime only", which is
 * useful for measuring what a preset actually costs.
 * @param {string[]|undefined} presets - requested ids.
 * @returns {string[]} canonical list.
 */
function normalizePresets (presets) {
  if (presets === undefined || presets === null) return CORE_NAMES.slice()
  if (!Array.isArray(presets)) throw new Error('buildLiveScript: presets must be an array of preset ids')
  const wanted = new Set(presets.filter((name) => LIVE_PRESETS[name] !== undefined))
  return CORE_NAMES.filter((name) => wanted.has(name))
}

/**
 * Emit the in-page synth.
 *
 * The script is a dependency-free IIFE that assigns `window.dshLive` and creates
 * no AudioContext until the page calls `unlock()` from a gesture. It carries the
 * preset designers, never a rendered sample: a page that loads it can play any
 * preset at any knobs, and re-randomise per interaction, for the size of the code
 * alone. The same options always produce the same bytes.
 * @param {{presets?: string[], seed?: number, sampleRate?: number, maxVoices?: number, volumeDb?: number}} [options]
 *   `presets` defaults to all nine, `seed` to 1, `sampleRate` to 44100,
 *   `maxVoices` to 12 and `volumeDb` to 0.
 * @returns {{script: string, bytes: number, exports: string[]}} the script text,
 *   its UTF-8 size, and the preset ids it can play.
 */
export function buildLiveScript (options = {}) {
  const names = normalizePresets(options.presets)
  const seed = intOption(options.seed, 1, 0, 2147483647)
  const sampleRate = intOption(options.sampleRate, 44100, 8000, 96000)
  const maxVoices = intOption(options.maxVoices, 12, 1, 64)
  const volumeDb = liveClamp(Number.isFinite(options.volumeDb) ? options.volumeDb : 0, -60, 12)
  const banner = `/* dsh-live ${LIVE_VERSION} - generated by dsh-audio lib/live.js; ` +
    'no audio bytes, no network. API: play/stop/stopAll/setVolume/unlock/isUnlocked/activeVoices/version. */'
  const script = [
    banner,
    '(function (root) {',
    "'use strict'",
    `var VERSION=${json(LIVE_VERSION)}`,
    `var SEED=${seed},SR=${sampleRate},MAXV=${maxVoices},VOL=${volumeDb}`,
    emitLibrary(names),
    RUNTIME,
    '})(typeof window === "undefined" ? globalThis : window)',
    ''
  ].join('\n')
  return { script, bytes: utf8Bytes(script), exports: names.slice() }
}

/**
 * Build the throwaway demo page for a generated script: one button per preset, a
 * stop-all button and a volume slider. It references the script by relative file
 * name and nothing else -- no network, no framework -- so a human can open it
 * next to the .js and hear the tier in one click.
 * @param {{presets?: string[], scriptName?: string, title?: string, volumeDb?: number}} [options]
 * @returns {string} complete HTML document.
 */
export function buildLiveDemoHtml (options = {}) {
  const names = normalizePresets(options.presets)
  const scriptName = typeof options.scriptName === 'string' && options.scriptName !== '' ? options.scriptName : 'live.js'
  const title = typeof options.title === 'string' && options.title !== '' ? options.title : 'dsh-live synth'
  const volume = liveClamp(Number.isFinite(options.volumeDb) ? options.volumeDb : 0, -60, 12)
  const buttons = names.map((name) => `      <button type="button" data-preset="${name}">${name}</button>`).join('\n')
  const css = [
    ':root{color-scheme:dark}',
    'body{margin:0;padding:32px;background:#101216;color:#e8eef6;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}',
    'h1{margin:0 0 4px;font-size:20px;letter-spacing:.02em}',
    'p{margin:0 0 20px;color:#8ea0b6;max-width:52ch}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px;margin-bottom:20px}',
    'button{appearance:none;border:1px solid #2b3442;background:#171c24;color:#e8eef6;border-radius:8px;padding:12px 10px;font:inherit;cursor:pointer}',
    'button:hover{border-color:#4d6b8f;background:#1c2430}',
    'button:active{transform:translateY(1px)}',
    '.row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;color:#8ea0b6}',
    '#last{color:#6fd6b0;font-variant-numeric:tabular-nums}'
  ].join('\n')
  const inline = [
    '(function () {',
    '  var live = window.dshLive',
    "  var last = document.getElementById('last')",
    '  if (!live) { last.textContent = "script did not load"; return }',
    '  function fire (name) {',
    '    live.unlock()',
    '    var handle = live.play(name)',
    '    last.textContent = handle ? name : "click again (audio needs a gesture)"',
    '  }',
    "  var buttons = document.querySelectorAll('[data-preset]')",
    '  for (var i = 0; i < buttons.length; i += 1) {',
    '    buttons[i].addEventListener("click", function () { fire(this.getAttribute("data-preset")) })',
    '  }',
    "  document.getElementById('stop').addEventListener('click', function () { live.stopAll(); last.textContent = 'stopped' })",
    "  document.getElementById('volume').addEventListener('input', function () { live.setVolume(Number(this.value)); last.textContent = 'volume ' + this.value + ' dB' })",
    '})()'
  ].join('\n')
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    `<p>${names.length} generated WebAudio preset${names.length === 1 ? '' : 's'} from <code>${scriptName}</code> -- no audio files, no network. The first click unlocks the AudioContext.</p>`,
    '<div class="grid">',
    buttons,
    '</div>',
    '<div class="row">',
    '  <button type="button" id="stop">stop all</button>',
    `  <label>volume <input id="volume" type="range" min="-24" max="6" step="1" value="${volume}"></label>`,
    '  <span id="last">ready</span>',
    '</div>',
    `<script src="${scriptName}"></script>`,
    '<script>',
    inline,
    '</script>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
