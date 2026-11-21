/**
 * The second vocabulary.
 *
 * The nine presets in `lib/dsp.js` cover the grammar of a single animation
 * beat: hit, air, click, bell, build. A scene needs nouns, too - a floor that
 * sounds walked on, a door that sounds opened, water, machinery, creatures.
 * This module adds 29 of them.
 *
 * They are registered into the same `PRESETS` table the kernel owns, so
 * `renderPreset`, `renderPattern`, `presetCatalog` and the tools pick them up
 * with no other change. Every renderer composes the shared primitives
 * (`noise`, `filter`, `decayEnvelope`, `glideTone`, `addInto`, `reverb`)
 * rather than carrying its own kernels: that is what keeps a footstep and an
 * impact sounding like the same instrument.
 *
 * Frequencies in the loopable beds (`LOOPABLE_PRESETS`) are snapped to whole
 * cycles across the rendered buffer, so the renderer's loop crossfade has no
 * phase jump to hide.
 */

import {
  PRESETS,
  addInto,
  decayEnvelope,
  filter,
  glideTone,
  lerp,
  noise,
  reverb
} from './dsp.js'

const TAU = Math.PI * 2

/* ---------------------------------------------------------------- helpers -- */

/**
 * `decayEnvelope` as a lookup function.
 *
 * `glideTone` wants an envelope as a function of normalised time, while the
 * kernel ships `decayEnvelope` as an array. Wrapping one in the other keeps a
 * single definition of "exponential decay" for tones and for noise.
 * @param {number} frames - tone length.
 * @param {number} sampleRate - Hz.
 * @param {number} decaySeconds - time to fall to 1/e.
 * @param {number} [attackSeconds] - fade-in length.
 * @returns {(progress: number) => number}
 */
function envelopeOf (frames, sampleRate, decaySeconds, attackSeconds = 0.0015) {
  const curve = decayEnvelope(frames, sampleRate, decaySeconds, attackSeconds)
  const last = Math.max(0, frames - 1)
  return function at (progress) {
    return curve[Math.min(last, Math.max(0, Math.round(progress * last)))]
  }
}

/**
 * Normalised rise/hold/fall window.
 *
 * Sustained layers (a drawer sliding, a gust) need to start and stop without a
 * step, and a hard 0 -> 1 jump is a click. `rise` and `fall` are normalised widths.
 * @param {number} start - normalised start.
 * @param {number} end - normalised end.
 * @param {number} [rise] - normalised fade-in.
 * @param {number} [fall] - normalised fade-out.
 * @returns {(progress: number) => number}
 */
function gate (start, end, rise = 0.01, fall = 0.02) {
  return function at (progress) {
    if (progress <= start || progress >= end) return 0
    const up = Math.min(1, (progress - start) / Math.max(rise, 1e-6))
    const down = Math.min(1, (end - progress) / Math.max(fall, 1e-6))
    return up * down
  }
}

/**
 * One decaying tone partial. The body of knocks, pings, growls and sub hits:
 * pitch may glide, amplitude is exponential.
 * @param {number} frames - length.
 * @param {number} sampleRate - Hz.
 * @param {number} fromHz - starting frequency.
 * @param {number} toHz - ending frequency.
 * @param {object} [options] - decay, attack (seconds), glide, shape.
 * @returns {Float32Array}
 */
function tone (frames, sampleRate, fromHz, toHz, options = {}) {
  const envelope = envelopeOf(frames, sampleRate, options.decay ?? 0.05, options.attack ?? 0.0015)
  return glideTone(frames, sampleRate, Math.max(1, fromHz), Math.max(1, toHz),
    options.glide ?? 0.25, envelope, options.shape ?? 0)
}

/** `tone` placed into a master buffer at a time offset. */
function addTone (dst, sampleRate, atSeconds, gain, fromHz, toHz, options = {}) {
  const length = Math.max(4, Math.min(dst.length, Math.round((options.seconds ?? 0.2) * sampleRate)))
  addInto(dst, tone(length, sampleRate, fromHz, toHz, options), Math.round(atSeconds * sampleRate), gain)
}

/**
 * One filtered noise burst with an exponential envelope: the atom of foley
 * (click, grain, splash, hiss).
 * @param {Float32Array} dst - master buffer; only its length is used.
 * @param {number} sampleRate - Hz.
 * @param {() => number} rand - seeded PRNG.
 * @param {object} [options] - seconds, decay, attack, from, to, q, qTo, mode, color.
 * @returns {Float32Array}
 */
function burst (dst, sampleRate, rand, options = {}) {
  const length = Math.max(4, Math.min(dst.length, Math.round((options.seconds ?? 0.02) * sampleRate)))
  const source = noise(length, rand, options.color ?? 'white', sampleRate)
  const envelope = decayEnvelope(length, sampleRate, options.decay ?? 0.006, options.attack ?? 0.0008)
  for (let i = 0; i < length; i += 1) source[i] *= envelope[i]
  const from = options.from ?? 1500
  const to = options.to ?? from
  const q = options.q ?? 1
  const qTo = options.qTo ?? q
  return filter(source, sampleRate, (p) => lerp(from, to, p), (p) => lerp(q, qTo, p), options.mode ?? 'bp')
}

/** `burst` placed into a master buffer at a time offset. */
function addBurst (dst, sampleRate, rand, atSeconds, gain, options = {}) {
  addInto(dst, burst(dst, sampleRate, rand, options), Math.round(atSeconds * sampleRate), gain)
}

/**
 * Noise through a moving filter with an amplitude shape. Fabric, wind, breath
 * and water are all this one idea with different filter travel and envelope.
 * @param {Float32Array} dst - master buffer; only its length is used.
 * @param {number} sampleRate - Hz.
 * @param {() => number} rand - seeded PRNG.
 * @param {object} [options] - color, from, to, q, qTo, cutoffAt, qAt, mode, envelope.
 * @returns {Float32Array}
 */
function shapedNoise (dst, sampleRate, rand, options = {}) {
  const source = noise(dst.length, rand, options.color ?? 'pink', sampleRate)
  const from = options.from ?? 400
  const to = options.to ?? from
  const q = options.q ?? 0.8
  const qTo = options.qTo ?? q
  const cutoffAt = options.cutoffAt
  const qAt = options.qAt
  const filtered = filter(source, sampleRate,
    cutoffAt === undefined ? (p) => lerp(from, to, p) : cutoffAt,
    qAt === undefined ? (p) => lerp(q, qTo, p) : qAt,
    options.mode ?? 'bp')
  const shape = options.envelope
  if (shape !== undefined) {
    for (let i = 0; i < filtered.length; i += 1) filtered[i] *= shape(i / Math.max(1, filtered.length - 1))
  }
  return filtered
}

/** `shapedNoise` mixed into a master buffer, optionally at a time offset. */
function addShaped (dst, sampleRate, rand, gain, options = {}) {
  addInto(dst, shapedNoise(dst, sampleRate, rand, options), Math.round((options.at ?? 0) * sampleRate), gain)
}

/**
 * A small stack of decaying partials: the "hollow" or "resonant" character of
 * a knock. Ratios are deliberately not whole numbers - integer stacks read as
 * tone, not as a struck object.
 * @param {Float32Array} dst - master buffer.
 * @param {number} sampleRate - Hz.
 * @param {number} atSeconds - where the strike lands.
 * @param {object} [options] - hz, ratios, seconds, decay, gain, attack.
 */
function addRing (dst, sampleRate, atSeconds, options = {}) {
  const seconds = options.seconds ?? 0.25
  const length = Math.max(4, Math.min(dst.length, Math.round(seconds * sampleRate)))
  const base = options.hz ?? 220
  const ratios = options.ratios ?? [1, 2.4, 3.9]
  const decay = options.decay ?? 0.06
  const gain = options.gain ?? 0.3
  ratios.forEach((ratio, index) => {
    const partial = tone(length, sampleRate, base * ratio, base * ratio * (1 - 0.012 * index), {
      decay: decay / (1 + index * 0.7),
      glide: 1,
      attack: options.attack ?? 0.0012
    })
    addInto(dst, partial, Math.round(atSeconds * sampleRate), gain / (1 + index * 0.9))
  })
}

/**
 * Free-running oscillator with a frequency *function*.
 *
 * `glideTone` covers a single exponential glide; growls, sirens and motor
 * whines need a frequency that keeps moving (vibrato, FM, cylinder pulses), so
 * phase is accumulated here and the shared primitives do the shaping around it.
 * @param {number} frames - length.
 * @param {number} sampleRate - Hz.
 * @param {(t: number, index: number) => number} frequencyAt - Hz at time t.
 * @param {(t: number, index: number) => number} amplitudeAt - gain at time t.
 * @param {number} [shape] - 0 sine, 1 triangle, 2 tanh square.
 * @returns {Float32Array}
 */
function sweepOsc (frames, sampleRate, frequencyAt, amplitudeAt, shape = 0) {
  const out = new Float32Array(frames)
  let phase = 0
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate
    phase += Math.max(1, frequencyAt(t, i)) / sampleRate
    if (phase >= 1) phase -= Math.floor(phase)
    const sine = Math.sin(TAU * phase)
    const wave = shape === 0
      ? sine
      : shape === 1
        ? 1 - 4 * Math.abs(phase - 0.5)
        : Math.tanh(3 * sine)
    out[i] = wave * amplitudeAt(t, i)
  }
  return out
}

/**
 * Gated buzzy blip: attack, hold, release. A beep is a *gated* tone, not a
 * decaying hit, which is why it does not use `tone`.
 * @param {Float32Array} dst - master buffer.
 * @param {number} sampleRate - Hz.
 * @param {number} atSeconds - start time.
 * @param {number} hz - pitch.
 * @param {number} seconds - blip length.
 * @param {object} [options] - attack, release, gain, hard (0 sine, 1 square-ish).
 */
function addBlip (dst, sampleRate, atSeconds, hz, seconds, options = {}) {
  const length = Math.max(4, Math.min(dst.length, Math.round(seconds * sampleRate)))
  const lengthSeconds = length / sampleRate
  const attack = options.attack ?? 0.004
  const release = options.release ?? 0.01
  const hard = options.hard ?? 0.7
  const drive = lerp(1.2, 4, hard)
  const out = new Float32Array(length)
  let phase = 0
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    phase += hz / sampleRate
    if (phase >= 1) phase -= 1
    const sine = Math.sin(TAU * phase)
    const wave = Math.tanh(drive * sine) + 0.18 * Math.sin(TAU * phase * 2)
    const shape = Math.min(1, t / Math.max(attack, 1e-5)) * Math.min(1, (lengthSeconds - t) / Math.max(release, 1e-5))
    out[i] = wave * shape
  }
  addInto(dst, out, Math.round(atSeconds * sampleRate), options.gain ?? 0.5)
  return out
}

/**
 * Snap a frequency to a whole number of cycles across the buffer.
 *
 * A hum that is half a cycle away from its starting phase clicks when the loop
 * wraps. Quantising to the render length makes every periodic layer return to
 * its starting phase, which is what "seamless" actually means for a bed.
 * @param {number} hz - desired frequency.
 * @param {number} frames - buffer length.
 * @param {number} sampleRate - Hz.
 * @returns {number}
 */
function loopFreq (hz, frames, sampleRate) {
  const cycles = Math.max(1, Math.round(hz * frames / sampleRate))
  return cycles * sampleRate / frames
}

/* ----------------------------------------------------------------- foley -- */

/**
 * The second vocabulary: foley, water and air, machinery, organic, musical.
 *
 * Same entry shape as the core `PRESETS` table. `defaults` is not optional:
 * `resolveParams` starts from it, so a preset without defaults would render
 * `undefined` knobs. `params` ranges are what the tools clamp a model guess to.
 * @type {Record<string, {
 *   description: string,
 *   defaultDuration: number,
 *   defaults: Record<string, number>,
 *   params: Record<string, [number, number]>,
 *   render: (params: object, frames: number, sampleRate: number, rand: () => number) => Float32Array
 * }>}
 */
export const EXTRA_PRESETS = {
  'footstep-gravel': {
    description: 'Boot on loose gravel: hard contact transient, low body, and a scatter of crunch grains. Use for dirt paths, scree, rubble, chase scenes.',
    defaultDuration: 0.3,
    defaults: { weight: 0.55, surface: 0.6, space: 0.18 },
    params: { weight: [0, 1], surface: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const weight = params.weight
      const surface = params.surface
      const hz = lerp(132, 84, weight)
      // A step is recognised by its transient: contact lands before any body.
      addBurst(out, sampleRate, rand, 0, 0.7, { seconds: 0.014, decay: 0.0032, from: 3200, to: 2100, q: 0.7, mode: 'hp' })
      addTone(out, sampleRate, 0, 0.8, hz * 1.7, hz, { seconds: 0.14, decay: 0.042, glide: 0.22 })
      addTone(out, sampleRate, 0.004, 0.32 * weight, 56, 40, { seconds: 0.18, decay: 0.07, glide: 0.3 })
      // Crunch: grains land just after the heel, so they read as ground, not as ticks.
      const grains = Math.round(lerp(10, 30, surface))
      for (let g = 0; g < grains; g += 1) {
        const at = Math.pow(rand(), 1.7) * 0.085
        addBurst(out, sampleRate, rand, at, 0.14 + rand() * 0.3, {
          seconds: 0.004 + rand() * 0.012,
          decay: 0.0018 + rand() * 0.0035,
          from: 1500 + rand() * 3400,
          q: 1 + rand() * 2.6,
          mode: 'bp'
        })
      }
      // The sole drags across the surface a moment after the heel lands.
      addShaped(out, sampleRate, rand, 0.22, {
        color: 'white', from: 1600, to: 3200, q: 1.1,
        envelope: envelopeOf(frames, sampleRate, 0.035, 0.004)
      })
      // A low ground tone under the crunch keeps it from sounding like a tick cloud.
      addShaped(out, sampleRate, rand, 0.14, {
        color: 'brown', from: 520, to: 260, q: 0.7, mode: 'lp',
        envelope: envelopeOf(frames, sampleRate, 0.03, 0.002)
      })
      return reverb(out, sampleRate, params.space * 0.4, 0.35)
    }
  },

  'footstep-wood': {
    description: 'Boot on a wooden floor: heel click, hollow body knock and a short room. Use for interiors, stairs, porches, sneaking.',
    defaultDuration: 0.35,
    defaults: { weight: 0.6, hardness: 0.5, space: 0.2 },
    params: { weight: [0, 1], hardness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const weight = params.weight
      const hardness = params.hardness
      const hz = lerp(150, 100, weight)
      addBurst(out, sampleRate, rand, 0, 0.65 + 0.3 * hardness, {
        seconds: 0.012, decay: 0.0026, from: 2600, to: 1800, q: 0.7, mode: 'hp'
      })
      addTone(out, sampleRate, 0, 0.8, hz * 1.7, hz, { seconds: 0.16, decay: 0.045, glide: 0.24 })
      // The floor is a hollow box: a short inharmonic resonance is the "wood".
      addRing(out, sampleRate, 0, {
        hz: lerp(190, 285, hardness), seconds: 0.18, ratios: [1, 1.86, 2.72], decay: 0.045, gain: 0.4
      })
      addTone(out, sampleRate, 0.002, 0.22, 62, 46, { seconds: 0.2, decay: 0.08 })
      return reverb(out, sampleRate, params.space * 0.45, 0.4)
    }
  },

  'footstep-water': {
    description: 'Step into shallow water: impact thump, splashy noise and rising bubbles. Use for puddles, shorelines, rain-soaked ground.',
    defaultDuration: 0.5,
    defaults: { weight: 0.55, splash: 0.6, space: 0.2 },
    params: { weight: [0, 1], splash: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const weight = params.weight
      const splash = params.splash
      addTone(out, sampleRate, 0, 0.62, 210, 120, { seconds: 0.12, decay: 0.035, glide: 0.3 })
      addTone(out, sampleRate, 0.002, 0.3 * weight, 70, 50, { seconds: 0.16, decay: 0.06 })
      // Water opens bright at the entry, then closes as the surface settles.
      addShaped(out, sampleRate, rand, lerp(0.75, 1.15, splash), {
        color: 'white', from: 2600, to: 800, q: 1.1, qTo: 0.6,
        envelope: envelopeOf(frames, sampleRate, 0.075, 0.0015)
      })
      const bubbles = Math.round(lerp(5, 14, splash))
      for (let b = 0; b < bubbles; b += 1) {
        const at = 0.03 + rand() * 0.3
        const hz = lerp(520, 900, rand()) * (0.8 + 0.4 * weight)
        addTone(out, sampleRate, at, 0.08 + rand() * 0.16, hz, hz * 1.7, {
          seconds: 0.02 + rand() * 0.04, decay: 0.015, glide: 1
        })
        addBurst(out, sampleRate, rand, at, 0.03 + rand() * 0.05, {
          seconds: 0.004, decay: 0.002, from: 3000 + rand() * 3000, q: 1.5, mode: 'bp'
        })
      }
      return reverb(out, sampleRate, params.space * 0.55, 0.45)
    }
  },

  'door-open': {
    description: 'Hinge creak over a friction bed, ending on the door stop. Use for suspense, haunted houses, old interiors, slow reveals.',
    defaultDuration: 1.4,
    defaults: { creak: 0.6, weight: 0.5, space: 0.35 },
    params: { creak: [0, 1], weight: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const creak = params.creak
      // The handle is turned first: a small dry click before any movement.
      addBurst(out, sampleRate, rand, 0.02, 0.3, { seconds: 0.02, decay: 0.006, from: 2800, q: 1.1, mode: 'bp' })
      // A creak is stick-slip: separate chirps that walk in pitch, not one tone.
      const events = Math.round(lerp(8, 20, creak))
      const span = Math.max(0.25, Math.min(seconds * 0.6, seconds - 0.3))
      for (let e = 0; e < events; e += 1) {
        const u = events > 1 ? e / (events - 1) : 0
        const at = 0.12 + u * span * (0.85 + rand() * 0.3)
        const base = lerp(330, 560, rand()) * lerp(0.9, 1.1, params.weight)
        const arc = 0.35 + 0.65 * Math.sin(Math.PI * u)
        addTone(out, sampleRate, at, (0.15 + rand() * 0.2) * arc, base, base * (1.06 + rand() * 0.25), {
          seconds: 0.03 + rand() * 0.05, decay: 0.012 + rand() * 0.018, glide: 1, shape: 1
        })
      }
      // Friction and the mass of the panel moving air.
      addShaped(out, sampleRate, rand, 0.16, {
        color: 'pink', from: 520, to: 1350, q: 0.9,
        envelope: (p) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, (p - 0.06) / 0.72))), 2)
      })
      addShaped(out, sampleRate, rand, 0.09, {
        color: 'pink', from: 260, to: 520, q: 0.7, mode: 'lp',
        envelope: gate(0.02, 0.82, 0.08, 0.1)
      })
      // A low groan from the hinge plate gives the creak a body.
      const groan = sweepOsc(frames, sampleRate,
        (t) => lerp(88, 128, Math.min(1, t / Math.max(seconds * 0.7, 0.1))) * (1 + 0.03 * Math.sin(TAU * 5.5 * t)),
        (t) => 0.06 * gate(0.04, 0.8, 0.1, 0.12)(t / Math.max(seconds, 1e-3)), 2)
      addInto(out, groan, 0, 1)
      // The door reaches its stop: a soft body hit, no slam.
      const stopAt = seconds * 0.86
      addTone(out, sampleRate, stopAt, 0.14, 92, 62, { seconds: 0.14, decay: 0.05 })
      addRing(out, sampleRate, stopAt, { hz: 160, seconds: 0.2, ratios: [1, 1.9], decay: 0.05, gain: 0.07 })
      return reverb(out, sampleRate, params.space * 0.55, 0.5)
    }
  },

  'door-close': {
    description: 'Swing whoosh, wooden slam and latch rattle. Use for exits, room transitions, car doors, punctuation.',
    defaultDuration: 0.7,
    defaults: { force: 0.6, weight: 0.55, space: 0.3 },
    params: { force: [0, 1], weight: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const force = params.force
      const weight = params.weight
      const slamAt = Math.min(0.24, seconds * 0.4)
      // Air moves ahead of the panel; stopping the whoosh exactly at the slam
      // is what sells the speed of the close.
      addShaped(out, sampleRate, rand, 0.3, {
        color: 'pink', from: 420, to: 1150, q: 0.9,
        envelope: (p) => {
          const t = (p * seconds) / Math.max(slamAt, 0.01)
          if (t >= 1) return 0
          return Math.pow(Math.min(1, t), 0.9) * Math.pow(1 - t, 0.4)
        }
      })
      addBurst(out, sampleRate, rand, slamAt, 0.7, { seconds: 0.025, decay: 0.006, from: 2200, to: 1200, q: 0.7, mode: 'hp' })
      addTone(out, sampleRate, slamAt, 0.9, 95, 54, { seconds: 0.2, decay: 0.07, glide: 0.2 })
      addTone(out, sampleRate, slamAt + 0.002, 0.22 * weight, 58, 42, { seconds: 0.3, decay: 0.12 })
      addRing(out, sampleRate, slamAt, {
        hz: 180, seconds: 0.42, ratios: [1, 1.92, 2.86, 4.05], decay: 0.1, gain: 0.5 * weight
      })
      // The latch chatters a beat after the panel stops.
      const rattles = 2 + Math.round(force * 3)
      for (let r = 0; r < rattles; r += 1) {
        const at = slamAt + 0.02 + r * 0.011 + rand() * 0.008
        addBurst(out, sampleRate, rand, at, 0.18 + rand() * 0.12, {
          seconds: 0.008, decay: 0.0035, from: 3200 + rand() * 2600, q: 1.4, mode: 'bp'
        })
        addTone(out, sampleRate, at, 0.15, 1500 + rand() * 1300, 1300 + rand() * 900, { seconds: 0.012, decay: 0.005 })
      }
      return reverb(out, sampleRate, params.space * 0.6, 0.55)
    }
  },

  drawer: {
    description: 'Wooden drawer sliding out and knocking to a stop. Use for desks, cabinets, searching, prop handling.',
    defaultDuration: 0.7,
    defaults: { friction: 0.5, weight: 0.55, space: 0.2 },
    params: { friction: [0, 1], weight: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const weight = params.weight
      const slideEnd = Math.min(0.36, seconds * 0.55)
      // Stick-slip: the slide is a noisy bed with a chattery amplitude, not a hiss.
      const slide = shapedNoise(out, sampleRate, rand, {
        color: 'pink', from: 640, to: 1050, q: 0.9,
        envelope: (p) => {
          const t = (p * seconds) / Math.max(slideEnd, 0.01)
          if (t >= 1) return 0
          return Math.min(1, t / 0.12) * Math.pow(1 - t, 0.35)
        }
      })
      const chatter = lerp(8, 15, params.friction)
      for (let i = 0; i < slide.length; i += 1) {
        const t = i / sampleRate
        slide[i] *= 0.72 + 0.2 * Math.sin(TAU * chatter * t + 1.7) + 0.08 * Math.sin(TAU * 3.1 * t)
      }
      addInto(out, slide, 0, 0.9)
      // The initial tug and the stop are the two events a listener tracks.
      addTone(out, sampleRate, 0.02, 0.25, 150, 115, { seconds: 0.05, decay: 0.02 })
      addBurst(out, sampleRate, rand, 0.02, 0.18, { seconds: 0.008, decay: 0.003, from: 2200, q: 0.9, mode: 'hp' })
      const stopAt = slideEnd + 0.02
      addTone(out, sampleRate, stopAt, 0.4, 118, 82, { seconds: 0.14, decay: 0.045 })
      addRing(out, sampleRate, stopAt, { hz: 240, seconds: 0.2, ratios: [1, 1.77], decay: 0.05, gain: 0.2 * weight })
      addBurst(out, sampleRate, rand, stopAt, 0.3, { seconds: 0.012, decay: 0.004, from: 1800, q: 0.8, mode: 'hp' })
      // Whatever is inside shifts a moment later.
      const contents = 2 + Math.round(rand() * 2)
      for (let c = 0; c < contents; c += 1) {
        addBurst(out, sampleRate, rand, stopAt + 0.03 + c * 0.02, 0.06 + rand() * 0.06, {
          seconds: 0.006, decay: 0.0025, from: 1500 + rand() * 2500, q: 1.2, mode: 'bp'
        })
      }
      return reverb(out, sampleRate, params.space * 0.45, 0.4)
    }
  },

  'switch-click': {
    description: 'Mechanical switch: hard tick plus a spring release. Use for lights, buttons, toggles, appliances.',
    defaultDuration: 0.12,
    defaults: { pitch: 1, hardness: 0.6, space: 0.15 },
    params: { pitch: [0.5, 2], hardness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const pitch = params.pitch
      const hardness = params.hardness
      addBurst(out, sampleRate, rand, 0, 0.55, { seconds: 0.006, decay: 0.0015, from: 3800, to: 5200, q: 0.6, mode: 'hp' })
      addTone(out, sampleRate, 0, 0.5, 2600 * pitch, 1900 * pitch, { seconds: 0.014, decay: 0.004, glide: 1 })
      addTone(out, sampleRate, 0, 0.13, 320, 210, { seconds: 0.03, decay: 0.012 })
      // Two-part "click-clack": the spring bottoms out a beat after the contact.
      const second = Math.min(0.035, 0.012 + 0.02 * hardness)
      addTone(out, sampleRate, second, 0.2, 900 * pitch, 760 * pitch, { seconds: 0.02, decay: 0.007 })
      addBurst(out, sampleRate, rand, second, 0.18, { seconds: 0.005, decay: 0.0015, from: 2500, q: 0.8, mode: 'hp' })
      return reverb(out, sampleRate, params.space * 0.3, 0.3)
    }
  },

  cloth: {
    description: 'Soft fabric rustle with fine fiber grains. Use for clothing, movement, reveals, cloaks, bedsheets.',
    defaultDuration: 0.8,
    defaults: { movement: 0.6, tone: 0.45, space: 0.2 },
    params: { movement: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const swells = 2 + Math.round(params.movement * 2)
      // Fabric has no attack: it is already moving when it becomes audible.
      const envelope = (p) => {
        let sum = 0
        for (let k = 0; k < swells; k += 1) {
          const centre = (k + 0.5) / swells
          sum += Math.exp(-Math.pow((p - centre) / 0.18, 2))
        }
        return Math.min(1, sum)
      }
      addShaped(out, sampleRate, rand, 0.55, {
        color: 'pink', from: 700, to: lerp(1800, 3400, params.tone), q: 0.8, envelope
      })
      addShaped(out, sampleRate, rand, 0.22, { color: 'brown', from: 320, to: 180, q: 0.6, mode: 'lp', envelope })
      // Fiber crackle: many tiny grains at very low gains, unevenly spaced.
      const fibers = Math.round(lerp(40, 90, params.movement))
      for (let f = 0; f < fibers; f += 1) {
        addBurst(out, sampleRate, rand, rand() * seconds, 0.01 + rand() * 0.035, {
          seconds: 0.0015 + rand() * 0.003,
          decay: 0.0008 + rand() * 0.0018,
          from: 2500 + rand() * 4000,
          q: 1 + rand() * 2,
          mode: 'bp'
        })
      }
      return reverb(out, sampleRate, params.space * 0.4, 0.4)
    }
  },

  paper: {
    description: 'Crisp paper crinkles with no low end. Use for letters, maps, notes, page turns, wrappers.',
    defaultDuration: 0.55,
    defaults: { crinkle: 0.6, tone: 0.55, space: 0.15 },
    params: { crinkle: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      // Paper tears in clusters of snaps; one smooth sweep would read as cloth.
      const clusters = 2 + Math.round(params.crinkle * 3)
      for (let c = 0; c < clusters; c += 1) {
        const centre = 0.08 + (c / Math.max(1, clusters)) * seconds * 0.75 + rand() * 0.02
        const grains = 10 + Math.round(rand() * 16)
        for (let g = 0; g < grains; g += 1) {
          addBurst(out, sampleRate, rand, centre + (rand() - 0.5) * 0.07, 0.04 + rand() * 0.14, {
            seconds: 0.0015 + rand() * 0.0045,
            decay: 0.0008 + rand() * 0.0022,
            from: lerp(2400, 3800, params.tone) + rand() * 3200,
            q: 0.8 + rand() * 2,
            mode: 'bp'
          })
        }
      }
      // A smooth sheet rustle under the snaps keeps the cue continuous.
      addShaped(out, sampleRate, rand, 0.12, {
        color: 'white', from: 2400, to: 4200, q: 0.7, mode: 'hp',
        envelope: (p) => Math.pow(Math.sin(Math.PI * p), 2)
      })
      addShaped(out, sampleRate, rand, 0.08, {
        color: 'pink', from: 520, to: 300, q: 0.6, mode: 'lp',
        envelope: (p) => Math.pow(Math.sin(Math.PI * p), 2)
      })
      return reverb(out, sampleRate, params.space * 0.3, 0.35)
    }
  },

  /* ------------------------------------------------------------ water, air -- */

  'water-drip': {
    description: 'Single drip into water: rising plink, cavity plop and a small watery tail. Use for leaks, caves, empty rooms, time passing.',
    defaultDuration: 0.45,
    defaults: { pitch: 1, weight: 0.5, space: 0.3 },
    params: { pitch: [0.5, 2], weight: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const pitch = params.pitch
      const weight = params.weight
      // A drop is a rising resonance of the cavity it hits, plus a cavity plop
      // underneath: the rise is what makes it read as water and not as a bell.
      const drip = (at, scale, gain) => {
        const base = 520 * pitch * scale
        addTone(out, sampleRate, at + 0.003, gain, base, base * 1.9, { seconds: 0.14, decay: 0.032, glide: 0.9, attack: 0.003 })
        addTone(out, sampleRate, at, gain * 0.22, base * 0.4, base * 0.29, { seconds: 0.08, decay: 0.028 })
        addBurst(out, sampleRate, rand, at, gain * 0.16, { seconds: 0.004, decay: 0.0012, from: 5000, q: 0.8, mode: 'hp' })
      }
      drip(0.005, 1, 0.95)
      if (seconds > 0.25) drip(0.16, 1.5, 0.35 + 0.2 * (1 - weight))
      addShaped(out, sampleRate, rand, 0.08, {
        color: 'white', from: 1600, to: 900, q: 0.6, mode: 'lp',
        envelope: envelopeOf(frames, sampleRate, 0.05, 0.002)
      })
      return reverb(out, sampleRate, params.space * 0.45, 0.4)
    }
  },

  'water-splash': {
    description: 'Body of water being struck: broadband splash, low mass and a bubble tail. Use for oars, jumps, spills, impacts on water.',
    defaultDuration: 1,
    defaults: { force: 0.6, tone: 0.5, space: 0.3 },
    params: { force: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const force = params.force
      // The splash collapses from bright to dark as the cavity closes on itself.
      addShaped(out, sampleRate, rand, 0.9 * lerp(0.6, 1, force), {
        color: 'white', from: 4800, to: 700, q: 1.2, qTo: 0.5,
        envelope: envelopeOf(frames, sampleRate, 0.16, 0.0012)
      })
      addTone(out, sampleRate, 0, 0.55 * force, 130, 72, { seconds: 0.3, decay: 0.1, glide: 0.3 })
      addTone(out, sampleRate, 0, 0.25, 62, 40, { seconds: 0.35, decay: 0.13 })
      const bubbles = 8 + Math.round(params.tone * 10)
      for (let b = 0; b < bubbles; b += 1) {
        const at = 0.03 + rand() * 0.65
        const hz = lerp(320, 720, rand()) * lerp(1.15, 0.85, params.tone)
        addTone(out, sampleRate, at, 0.06 + rand() * 0.14, hz, hz * 1.8, {
          seconds: 0.02 + rand() * 0.04, decay: 0.015, glide: 1
        })
      }
      addShaped(out, sampleRate, rand, 0.2, {
        color: 'white', from: 3500, q: 0.6, mode: 'hp',
        envelope: envelopeOf(frames, sampleRate, 0.06, 0.002)
      })
      if (seconds < 0.03) return out
      return reverb(out, sampleRate, params.space * 0.6, 0.55)
    }
  },

  bubble: {
    description: 'One underwater bubble rising: rounded pitch rise and a soft surface pop. Use for underwater scenes, potions, breathing.',
    defaultDuration: 0.25,
    defaults: { pitch: 1, size: 0.5, space: 0.2 },
    params: { pitch: [0.5, 2], size: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const base = lerp(260, 420, params.size) * params.pitch
      // Bubbles rise in pitch and have no sharp attack - the opposite of a drip.
      addTone(out, sampleRate, 0.004, 0.85, base, base * 2.1, { seconds: 0.13, decay: 0.05, glide: 1, attack: 0.004 })
      addTone(out, sampleRate, 0, 0.25, base * 0.5, base * 0.7, { seconds: 0.1, decay: 0.04 })
      addBurst(out, sampleRate, rand, 0, 0.12, { seconds: 0.01, decay: 0.003, from: 1200, q: 1.5, mode: 'bp' })
      addBurst(out, sampleRate, rand, Math.min(seconds * 0.55, 0.13), 0.2, {
        seconds: 0.014, decay: 0.004, from: 2500, q: 1.2, mode: 'hp'
      })
      return reverb(out, sampleRate, params.space * 0.4, 0.4)
    }
  },

  'wind-gust': {
    description: 'Air gust with rumble, a whistle and a few debris ticks. Use for weather, height, emptiness, establishing shots.',
    defaultDuration: 2,
    defaults: { strength: 0.6, tone: 0.5, movement: 0.5, space: 0.4 },
    params: { strength: [0, 1], tone: [0, 1], movement: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const peak = 0.45
      const gust = (p) => Math.pow(p < peak ? p / peak : (1 - p) / (1 - peak), 1.6)
      // Three layers, one motion: rumble below, body in the middle, whistle on top.
      addShaped(out, sampleRate, rand, 0.5 * params.strength, {
        color: 'brown', from: 220, to: 120, q: 0.6, mode: 'lp', envelope: gust
      })
      addShaped(out, sampleRate, rand, 0.75, {
        color: 'pink', q: 0.7,
        cutoffAt: (p) => 280 + (900 + 800 * params.tone) * gust(p),
        envelope: (p) => Math.pow(gust(p), 1.15)
      })
      addShaped(out, sampleRate, rand, 0.22, {
        color: 'white', q: 7,
        cutoffAt: (p) => lerp(700, 1700, params.tone) * (0.8 + 0.5 * gust(p)),
        envelope: (p) => Math.pow(gust(p), 2)
      })
      // Small debris skittering adds scale without adding level.
      const debris = 8
      for (let d = 0; d < debris; d += 1) {
        const at = rand() * seconds
        addBurst(out, sampleRate, rand, at, (0.02 + rand() * 0.05) * params.movement, {
          seconds: 0.004, decay: 0.0015, from: 4000 + rand() * 4000, q: 0.8, mode: 'hp'
        })
      }
      return reverb(out, sampleRate, params.space * 0.45, 0.6)
    }
  },

  'breath-inhale': {
    description: 'Close breath drawn in: airy, rising intensity, no voice. Use for tension, POV, creatures, exhaustion, before a line.',
    defaultDuration: 1.3,
    defaults: { effort: 0.6, tone: 0.45, space: 0.2 },
    params: { effort: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      // An inhale builds to a cut, it does not decay: the swell shape is the gesture.
      const envelope = (p) => (p < 0.85 ? Math.pow(p / 0.85, 1.7) : Math.pow((1 - p) / 0.15, 0.8))
      const air = shapedNoise(out, sampleRate, rand, {
        color: 'white', q: 0.8,
        cutoffAt: (p) => lerp(520, lerp(1100, 1900, params.tone), Math.sin(Math.PI * Math.min(1, p))),
        envelope
      })
      // Turbulence flutter: air through a throat is never a steady hiss.
      const flutter = lerp(26, 44, params.effort)
      for (let i = 0; i < air.length; i += 1) {
        const t = i / sampleRate
        air[i] *= 1 - 0.18 * params.effort * (0.5 + 0.5 * Math.sin(TAU * flutter * t))
      }
      addInto(out, air, 0, 0.8)
      addShaped(out, sampleRate, rand, 0.1, {
        color: 'white', from: 3000, q: 0.7, mode: 'hp',
        envelope: (p) => envelope(p) * Math.pow(p, 1.3)
      })
      addShaped(out, sampleRate, rand, 0.18, { color: 'brown', from: 240, to: 150, q: 0.7, mode: 'lp', envelope })
      if (seconds < 0.03) return out
      return reverb(out, sampleRate, params.space * 0.3, 0.4)
    }
  },

  /* ------------------------------------------------- machinery & sci-fi -- */

  servo: {
    description: 'Small servo motor spinning: gear chatter and a rising whine. Use for robots, cameras, hatches, doors, machinery.',
    defaultDuration: 0.6,
    defaults: { pitch: 1, speed: 0.5, roughness: 0.4, space: 0.15 },
    params: { pitch: [0.5, 2], speed: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const base = lerp(340, 820, params.speed) * params.pitch
      const chatter = lerp(65, 155, params.roughness)
      // The servo accelerates: pitch ramps for ~1/3 of the take, then holds.
      const frequency = (t) => base * (0.62 + 0.55 * Math.min(1, t / 0.28)) * (1 + 0.012 * Math.sin(TAU * chatter * t))
      const amplitude = (t) => Math.min(1, t / 0.035) * Math.min(1, (seconds - t) / 0.12)
      const whine = sweepOsc(frames, sampleRate, frequency, (t) => amplitude(t) * 0.8, 2)
      for (let i = 0; i < whine.length; i += 1) {
        // Gear teeth chop the tone; without this it is just a rising buzz.
        whine[i] *= 0.7 + 0.3 * Math.sin(TAU * chatter * (i / sampleRate))
      }
      addInto(out, whine, 0, 1)
      addInto(out, sweepOsc(frames, sampleRate, (t) => frequency(t) * 0.5, (t) => amplitude(t) * 0.22, 2), 0, 1)
      // Gear mesh: a narrow high band that reads as metal teeth, not as noise.
      addShaped(out, sampleRate, rand, 0.1 + 0.08 * params.roughness, {
        color: 'white', q: 2.2,
        cutoffAt: (p) => frequency(p * seconds) * lerp(2.4, 3.4, params.roughness),
        envelope: (p) => amplitude(p * seconds)
      })
      addShaped(out, sampleRate, rand, 0.12, {
        color: 'pink', from: 900, to: 1700, q: 0.7, mode: 'lp',
        envelope: (p) => amplitude(p * seconds)
      })
      // Start and stop are mechanical, not musical: two dry clicks.
      addBurst(out, sampleRate, rand, 0.006, 0.22, { seconds: 0.008, decay: 0.003, from: 2500, q: 0.9, mode: 'hp' })
      addBurst(out, sampleRate, rand, Math.max(0.02, seconds - 0.16), 0.16, {
        seconds: 0.008, decay: 0.003, from: 1800, q: 0.9, mode: 'hp'
      })
      return reverb(out, sampleRate, params.space * 0.35, 0.35)
    }
  },

  'motor-start': {
    description: 'Starter whine then an engine catching and settling into a rumble. Use for vehicles, generators, power-ups, escapes.',
    defaultDuration: 1.6,
    defaults: { power: 0.6, roughness: 0.45, space: 0.3 },
    params: { power: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const catchAt = Math.min(0.5, seconds * 0.34)
      const starterChatter = lerp(70, 140, params.roughness)
      // Starter motor: a fast whine that is chopped by the pinion.
      const starter = sweepOsc(frames, sampleRate,
        (t) => lerp(185, 420, Math.min(1, t / Math.max(catchAt + 0.06, 0.08))) * (1 + 0.02 * Math.sin(TAU * 13 * t)),
        (t) => Math.min(1, t / 0.03) * Math.min(1, (catchAt + 0.12 - t) / 0.1), 2)
      for (let i = 0; i < starter.length; i += 1) {
        starter[i] *= 0.72 + 0.28 * Math.sin(TAU * starterChatter * (i / sampleRate))
      }
      addInto(out, starter, 0, 0.7)
      // Ignition: a click and a thump, then the engine is running.
      addBurst(out, sampleRate, rand, catchAt, 0.35, { seconds: 0.02, decay: 0.006, from: 2600, q: 0.8, mode: 'hp' })
      addTone(out, sampleRate, catchAt, 0.4, 90, 50, { seconds: 0.15, decay: 0.05 })
      const engineAmp = (t) => {
        const local = t - catchAt
        if (local < 0) return 0
        return Math.min(1, local / 0.12) * Math.min(1, (seconds - t) / 0.12) * lerp(0.6, 1, params.power)
      }
      const pulses = lerp(15, 24, params.roughness)
      const engineHz = (t) => (34 + 14 * Math.min(1, Math.max(0, t - catchAt) / 0.45)) * (1 + 0.03 * Math.sin(TAU * 7.3 * Math.max(0, t - catchAt)))
      const engine = sweepOsc(frames, sampleRate,
        (t) => engineHz(t) * 2, (t) => engineAmp(t) * 0.4, 2)
      for (let i = 0; i < engine.length; i += 1) {
        // Cylinder pulses are what separates an engine from a synth drone.
        engine[i] *= 0.6 + 0.4 * Math.sin(TAU * pulses * (i / sampleRate))
      }
      addInto(out, engine, 0, 1)
      addInto(out, sweepOsc(frames, sampleRate, engineHz, (t) => engineAmp(t) * 0.8, 2), 0, 0.55)
      addShaped(out, sampleRate, rand, 0.3, {
        color: 'brown', from: 300, to: 200, q: 0.6, mode: 'lp',
        envelope: (p) => {
          const t = p * seconds
          if (t < catchAt) return 0
          return Math.min(1, (t - catchAt) / 0.1) * Math.min(1, (seconds - t) / 0.15) * 0.8
        }
      })
      return reverb(out, sampleRate, params.space * 0.5, 0.5)
    }
  },

  'motor-loop': {
    description: 'Seamless running motor: hum harmonics, a whine and machine noise. Loop it under any machine scene; also usable as a one-shot bed.',
    defaultDuration: 2,
    defaults: { pitch: 1, speed: 0.5, roughness: 0.3, space: 0.1 },
    params: { pitch: [0.5, 2], speed: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand, timing) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      // Every periodic layer is snapped to whole cycles, so the loop returns to
      // its starting phase instead of clicking. `timing.loopFrames` is the loop
      // period of a loop render (the rendered buffer is one period plus the
      // overlap-add tail, so snapping to the buffer length would leave a phase
      // offset of exactly the crossfade). One-shots pass no timing and snap to
      // the buffer length, which is what they always did.
      const period = timing === undefined || !Number.isFinite(timing.loopFrames) ? frames : timing.loopFrames
      const f0 = loopFreq(58 * params.pitch * (0.85 + 0.3 * params.speed), period, sampleRate)
      const partials = [1, 2, 3, 4, 6]
      const gains = [0.34, 0.22, 0.14, 0.09, 0.05]
      partials.forEach((ratio, index) => {
        const hz = f0 * ratio
        for (let i = 0; i < frames; i += 1) out[i] += gains[index] * Math.sin(TAU * hz * (i / sampleRate))
      })
      // The whine sits above the hum; a slow wobble keeps it from sounding dead.
      const whineHz = loopFreq(lerp(600, 1250, params.speed) * params.pitch, period, sampleRate)
      const wobble = loopFreq(4.1, period, sampleRate)
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        out[i] += (0.2 + 0.14 * params.roughness) * (0.75 + 0.25 * Math.sin(TAU * wobble * t)) * Math.sin(TAU * whineHz * t)
        out[i] += 0.05 * Math.sin(TAU * whineHz * 2 * t)
      }
      // Machine tone: a hum for the frame and a noise bed for the air.
      const flutter = loopFreq(lerp(17, 37, params.roughness), period, sampleRate)
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        out[i] *= 1 + 0.06 * Math.sin(TAU * loopFreq(2.3, period, sampleRate) * t)
        out[i] += 0.016 * Math.sin(TAU * flutter * t)
      }
      addInto(out, filter(noise(frames, rand, 'pink', sampleRate), sampleRate, () => 1200, () => 0.6, 'lp'), 0, 0.05 + 0.09 * params.roughness)
      return reverb(out, sampleRate, params.space * 0.3, 0.4)
    }
  },

  'alarm-beep': {
    description: 'Piezo alarm: a run of hard beeps. Use for devices, warnings, countdowns, UI panic, smoke alarms.',
    defaultDuration: 0.9,
    defaults: { pitch: 1, softness: 0.25, space: 0.25 },
    params: { pitch: [0.5, 2], softness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const period = 0.17
      const beepSeconds = 0.082
      const hz = 880 * params.pitch
      // Evenly spaced, identical beeps: an alarm is a clock, not a phrase.
      const count = Math.max(1, Math.floor(Math.max(0, seconds - beepSeconds) / period) + 1)
      for (let b = 0; b < count; b += 1) {
        const at = b * period
        addBlip(out, sampleRate, at, hz, beepSeconds, {
          attack: 0.004, release: 0.012, gain: 0.5, hard: lerp(0.85, 0.35, params.softness)
        })
        addBurst(out, sampleRate, rand, at, 0.12, { seconds: 0.004, decay: 0.0015, from: 4000, q: 0.7, mode: 'hp' })
      }
      return reverb(out, sampleRate, params.space * 0.4, 0.4)
    }
  },

  'alarm-siren': {
    description: 'Wailing siren with a continuous wee-woo sweep. Loopable for emergency scenes; a single wail also works as a one-shot.',
    defaultDuration: 2,
    defaults: { pitch: 1, speed: 0.5, tone: 0.5, space: 0.3 },
    params: { pitch: [0.5, 2], speed: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand, timing) {
      const out = new Float32Array(frames)
      // Integer cycles for both the carrier and the sweep rate: the wail ends
      // where it began, which is the whole trick of a loopable siren. A loop
      // render snaps against its loop period (`timing.loopFrames`), not against
      // the rendered buffer, which is one period plus the overlap-add tail.
      const period = timing === undefined || !Number.isFinite(timing.loopFrames) ? frames : timing.loopFrames
      const f0 = loopFreq(640 * params.pitch, period, sampleRate)
      const rate = loopFreq(lerp(0.42, 0.95, params.speed), period, sampleRate)
      const depth = 0.28 + 0.14 * params.tone
      // Even the partials are snapped to whole cycles: a partial that ends mid
      // cycle is a click the crossfade only half hides.
      const harmonicHz = loopFreq(f0 * 2.02, period, sampleRate)
      const thirdHz = loopFreq(f0 * 3.04, period, sampleRate)
      const wail = sweepOsc(frames, sampleRate,
        (t) => f0 * (1 + depth * Math.sin(TAU * rate * t)), () => 0.55, 2)
      const harmonic = sweepOsc(frames, sampleRate,
        (t) => harmonicHz * (1 + depth * 0.85 * Math.sin(TAU * rate * t + 0.5)), () => 0.26, 0)
      const third = sweepOsc(frames, sampleRate,
        (t) => thirdHz * (1 + depth * 0.7 * Math.sin(TAU * rate * t + 1.1)), () => 0.12, 0)
      const breathe = loopFreq(3.2, period, sampleRate)
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        out[i] = wail[i] + harmonic[i] * (1 + 0.05 * Math.sin(TAU * breathe * t)) + third[i]
      }
      addInto(out, filter(noise(frames, rand, 'pink', sampleRate), sampleRate, () => 2500, () => 0.7, 'lp'), 0, 0.04)
      return reverb(out, sampleRate, params.space * 0.35, 0.5)
    }
  },

  'hud-tick': {
    description: 'Dry digital UI tick: tiny square blip plus a second confirmation blip. Use for HUD updates, selection, data, sci-fi interfaces.',
    defaultDuration: 0.1,
    defaults: { pitch: 1, tone: 0.5, space: 0.15 },
    params: { pitch: [0.5, 2], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const pitch = params.pitch
      addTone(out, sampleRate, 0, 0.55, 2100 * pitch, 1500 * pitch, { seconds: 0.035, decay: 0.008, glide: 1, shape: 2 })
      addTone(out, sampleRate, 0.002, 0.3, 900 * pitch, 700 * pitch, { seconds: 0.02, decay: 0.006 })
      addBurst(out, sampleRate, rand, 0, 0.35, { seconds: 0.004, decay: 0.0012, from: 5000, q: 0.7, mode: 'hp' })
      // A quieter echo a hair later makes it a two-state UI sound.
      addTone(out, sampleRate, 0.028, 0.18 * params.tone + 0.1, 3200 * pitch, 3000 * pitch, { seconds: 0.02, decay: 0.005 })
      return reverb(out, sampleRate, params.space * 0.3, 0.3)
    }
  },

  'energy-charge': {
    description: 'Rising charge tone with electrical crackle and a ready ping. Use for charging, power-up, teleport, sci-fi machinery.',
    defaultDuration: 1.5,
    defaults: { tone: 0.5, tension: 0.6, space: 0.4 },
    params: { tone: [0, 1], tension: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const chargeEnd = Math.min(1.18, seconds * 0.8)
      const topHz = lerp(620, 1150, params.tone)
      // The pitch is the charge meter; amplitude grows faster than pitch so it
      // feels like a capacitor filling, not like a slide whistle.
      // The charge cuts at the top: the ping that follows is the payoff, and a
      // tone that keeps sustaining past it would sound like a stuck synth.
      addInto(out, sweepOsc(frames, sampleRate,
        (t) => lerp(80, topHz, Math.pow(Math.min(1, t / chargeEnd), 1.6)),
        (t) => {
          const fill = Math.pow(Math.min(1, t / chargeEnd), 1.4) * 0.55
          if (t <= chargeEnd) return fill
          return fill * Math.max(0, 1 - (t - chargeEnd) / 0.04)
        }, 2), 0, 1)
      addShaped(out, sampleRate, rand, 0.18 * (0.5 + params.tension), {
        color: 'white', q: 1.2,
        cutoffAt: (p) => lerp(400, 3000 + 2000 * params.tone, Math.pow(Math.min(1, p), 2)),
        envelope: (p) => Math.pow(Math.min(1, p), 2)
      })
      // Crackle clusters near the top of the charge: sparse, bright, rising.
      const crackles = 18 + Math.round(params.tension * 20)
      for (let c = 0; c < crackles; c += 1) {
        const at = chargeEnd * Math.pow(rand(), 0.55)
        addBurst(out, sampleRate, rand, at, 0.05 + rand() * 0.12, {
          seconds: 0.004 + rand() * 0.006,
          decay: 0.0015 + rand() * 0.002,
          from: 3000 + rand() * 4000,
          q: 1.6,
          mode: 'bp'
        })
      }
      // Discharge into a ready ping: the payoff of the rise.
      addTone(out, sampleRate, chargeEnd, 0.28, 1240, 1180, { seconds: 0.22, decay: 0.07 })
      addTone(out, sampleRate, chargeEnd, 0.14, 1860, 1800, { seconds: 0.12, decay: 0.05 })
      addBurst(out, sampleRate, rand, chargeEnd, 0.15, { seconds: 0.01, decay: 0.003, from: 3000, q: 0.8, mode: 'hp' })
      return reverb(out, sampleRate, params.space * 0.55, 0.55)
    }
  },

  /* --------------------------------------------------------- organic, fear -- */

  'heartbeat-double': {
    description: 'Two low heartbeats (lub-dub) with a soft valve wash. Use for fear, life signs, tension, POV closeness.',
    defaultDuration: 0.9,
    defaults: { weight: 0.6, softness: 0.45, space: 0.2 },
    params: { weight: [0, 1], softness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const weight = params.weight
      const softness = params.softness
      const hz = lerp(66, 44, weight)
      // "Lub" is the big one; "dub" is quieter and slightly higher-tension.
      const beat = (at, gain, scale) => {
        addTone(out, sampleRate, at, gain, hz * scale * 1.5, hz * scale, {
          seconds: 0.3, decay: lerp(0.07, 0.13, softness), glide: 0.25
        })
        addTone(out, sampleRate, at + 0.004, gain * 0.3, hz * scale * 2.6, hz * scale * 2.2, { seconds: 0.12, decay: 0.04 })
        addBurst(out, sampleRate, rand, at, gain * 0.25, {
          seconds: 0.12, decay: 0.03, color: 'brown', from: 240, to: 150, q: 0.7, mode: 'lp'
        })
      }
      beat(0, 0.95, 1)
      beat(0.26, 0.62, 0.92)
      return reverb(out, sampleRate, params.space * 0.3, 0.35)
    }
  },

  'creature-growl': {
    description: 'Low growling creature with a modulated snarl. Use for monsters, beasts, distant threats, boss intros.',
    defaultDuration: 1.6,
    defaults: { pitch: 1, roughness: 0.6, space: 0.4 },
    params: { pitch: [0.5, 2], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const f0 = 84 * params.pitch
      const amplitude = (t) => Math.min(1, t / 0.18) * Math.min(1, Math.max(0, (seconds - t) / 0.3))
      // Two pitch LFOs keep the growl from ever settling on a note.
      const growl = sweepOsc(frames, sampleRate,
        (t) => f0 * (1 + 0.13 * Math.sin(TAU * 5.1 * t) + 0.05 * Math.sin(TAU * 12.7 * t + 1.3)),
        amplitude, 2)
      const snarl = (t) => 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(TAU * 22 * t + Math.sin(TAU * 3.3 * t) * 2))
      for (let i = 0; i < growl.length; i += 1) {
        const t = i / sampleRate
        growl[i] *= snarl(t)
      }
      addInto(out, growl, 0, 0.5)
      // Throat noise is what makes it an animal rather than a distorted sine.
      const throat = shapedNoise(out, sampleRate, rand, {
        color: 'pink', from: 260, to: 900, q: 0.9,
        envelope: (p) => amplitude(p * seconds) * snarl(p * seconds) * (0.6 + 0.4 * params.roughness)
      })
      addInto(out, throat, 0, 0.7)
      addShaped(out, sampleRate, rand, 0.2, {
        color: 'brown', from: 180, to: 120, q: 0.7, mode: 'lp',
        envelope: (p) => amplitude(p * seconds) * 0.9
      })
      // A moving formant is what makes a growl read as a throat, not as noise.
      addShaped(out, sampleRate, rand, 0.3, {
        color: 'pink', from: 380, to: 780, q: 2.2,
        envelope: (p) => amplitude(p * seconds) * snarl(p * seconds)
      })
      return reverb(out, sampleRate, params.space * 0.5, 0.5)
    }
  },

  'insect-buzz': {
    description: 'Loopable insect wing buzz with a fast tremolo. Use for swarms, summer ambience, unease, close-up creatures.',
    defaultDuration: 1.4,
    defaults: { pitch: 1, movement: 0.5, tone: 0.5, space: 0.06 },
    params: { pitch: [0.5, 2], movement: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand, timing) {
      const out = new Float32Array(frames)
      // Wing beat, tremolo and drift are all whole cycles across the loop, so
      // the buzz loops without a seam. A loop render snaps against its loop
      // period (`timing.loopFrames`), not against the rendered buffer, which is
      // one period plus the overlap-add tail.
      const period = timing === undefined || !Number.isFinite(timing.loopFrames) ? frames : timing.loopFrames
      const f0 = loopFreq(190 * params.pitch, period, sampleRate)
      const buzzRate = loopFreq(lerp(30, 58, params.tone), period, sampleRate)
      const wobble = loopFreq(2.7, period, sampleRate)
      const drift = loopFreq(3.3, period, sampleRate)
      const wing = sweepOsc(frames, sampleRate, (t) => f0 * (1 + 0.035 * Math.sin(TAU * wobble * t)), () => 1, 2)
      const wingHigh = sweepOsc(frames, sampleRate, (t) => f0 * 2 * (1 + 0.02 * Math.sin(TAU * wobble * t + 0.8)), () => 1, 0)
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        const tremolo = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(TAU * buzzRate * t))
        const motion = 0.8 + 0.2 * params.movement * Math.sin(TAU * drift * t)
        out[i] = (wing[i] * 0.5 + wingHigh[i] * 0.18) * tremolo * motion
      }
      addInto(out, filter(noise(frames, rand, 'white', sampleRate), sampleRate, () => 3500, () => 0.7, 'hp'), 0, 0.035)
      return reverb(out, sampleRate, params.space * 0.25, 0.4)
    }
  },

  'bone-crack': {
    description: 'Sharp bone snap with a resonant ring and a second smaller crack. Use for hits, breaks, body horror, creature damage.',
    defaultDuration: 0.3,
    defaults: { hardness: 0.65, tone: 0.55, space: 0.25 },
    params: { hardness: [0, 1], tone: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const pitch = lerp(0.8, 1.25, params.tone)
      addBurst(out, sampleRate, rand, 0, 0.8, {
        seconds: 0.012, decay: 0.0022, from: 4000, to: 2500, q: 0.6, mode: 'hp'
      })
      addTone(out, sampleRate, 0, 0.55 * lerp(0.7, 1.2, params.hardness), 1500 * pitch, 1150 * pitch, {
        seconds: 0.06, decay: 0.012, glide: 1, shape: 1
      })
      addRing(out, sampleRate, 0, { hz: 760 * pitch, seconds: 0.12, ratios: [1, 2.7], decay: 0.03, gain: 0.25 })
      addTone(out, sampleRate, 0.002, 0.2, 95, 66, { seconds: 0.1, decay: 0.035 })
      // A real break splits twice: the second crack is quieter and a beat later.
      addBurst(out, sampleRate, rand, 0.075, 0.35, { seconds: 0.01, decay: 0.002, from: 3000, q: 0.8, mode: 'hp' })
      addTone(out, sampleRate, 0.075, 0.18, 1200 * pitch, 900 * pitch, { seconds: 0.05, decay: 0.01 })
      return reverb(out, sampleRate, params.space * 0.35, 0.35)
    }
  },

  /* ------------------------------------------------------------- musical -- */

  'bass-drop': {
    description: 'Sub bass dropping in pitch with harmonic punch. Use for trailers, stingers, musical hits, transitions.',
    defaultDuration: 1.2,
    defaults: { weight: 0.6, drop: 0.6, roughness: 0.4, space: 0.25 },
    params: { weight: [0, 1], drop: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const startHz = lerp(120, 80, params.weight)
      const endHz = lerp(46, 24, params.drop)
      // Exponential fall: fast enough to feel like a drop, slow enough to hear.
      const frequency = (t) => endHz + (startHz - endHz) * Math.exp(-t / 0.22)
      const amplitude = (t) => Math.min(1, t / 0.005) *
        Math.min(1, Math.max(0, (seconds - t) / 0.25)) *
        (0.35 + 0.65 * Math.exp(-t / 0.45))
      const sub = sweepOsc(frames, sampleRate, frequency, amplitude, 2)
      for (let i = 0; i < sub.length; i += 1) {
        // Saturation is what puts harmonics on a sub so it survives a phone speaker.
        sub[i] = Math.tanh(lerp(1.5, 5, params.roughness) * sub[i] * 1.1)
      }
      addInto(out, sub, 0, 0.9)
      addTone(out, sampleRate, 0, 0.2, 160, 90, { seconds: 0.05, decay: 0.02 })
      addBurst(out, sampleRate, rand, 0, 0.22, { seconds: 0.006, decay: 0.002, from: 1200, q: 0.8, mode: 'hp' })
      return reverb(out, sampleRate, params.space * 0.35, 0.5)
    }
  },

  'riser-short': {
    description: 'Short accelerating pulse riser with a tonal sweep. Use for quick builds into a cut, impact or reveal.',
    defaultDuration: 0.7,
    defaults: { tone: 0.55, tension: 0.6, space: 0.3 },
    params: { tone: [0, 1], tension: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const span = Math.min(0.62, seconds * 0.9)
      const pulses = 24 + Math.round(params.tension * 18)
      // Accelerando: gaps shrink as u^0.65, so the roll speeds up into the cut.
      for (let p = 0; p < pulses; p += 1) {
        const u = pulses > 1 ? p / (pulses - 1) : 0
        const at = span * Math.pow(u, 0.65)
        addBurst(out, sampleRate, rand, at, 0.16 + 0.34 * u, {
          seconds: 0.008 + rand() * 0.004,
          decay: 0.003,
          from: lerp(1500, 4200, u) + rand() * 600,
          q: 1.1,
          mode: 'bp'
        })
        addTone(out, sampleRate, at, 0.08 + 0.12 * u, lerp(240, 1200, u), lerp(300, 1500, u), {
          seconds: 0.02, decay: 0.008
        })
      }
      addInto(out, sweepOsc(frames, sampleRate,
        (t) => lerp(180, lerp(900, 1800, params.tone), Math.pow(Math.min(1, t / Math.max(span, 1e-3)), 2.2)),
        (t) => Math.pow(Math.min(1, t / Math.max(span, 1e-3)), 2) * 0.18, 1), 0, 1)
      addShaped(out, sampleRate, rand, 0.18, {
        color: 'pink', q: 1.3,
        cutoffAt: (p) => lerp(400, 5000 + 2000 * params.tone, Math.pow(Math.min(1, p), 2.4)),
        envelope: (p) => Math.pow(Math.min(1, p), 2)
      })
      addBurst(out, sampleRate, rand, span, 0.3, { seconds: 0.01, decay: 0.003, from: 4000, q: 0.8, mode: 'hp' })
      return reverb(out, sampleRate, params.space * 0.45, 0.5)
    }
  },

  'bell-toll': {
    description: 'Large bell toll with inharmonic partials and a long beating tail. Use for churches, doom, announcements, sacred spaces.',
    defaultDuration: 3.4,
    defaults: { pitch: 1, decay: 0.6, metallic: 0.55, space: 0.45 },
    params: { pitch: [0.5, 2], decay: [0, 1], metallic: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const base = 196 * params.pitch
      // Real bell partial ratios, not a harmonic stack. The two detuned copies
      // of each partial beat against each other: that is the bell's warble.
      const partials = [
        { ratio: 0.5, decay: 2.6, gain: 0.5 },
        { ratio: 1, decay: 2, gain: 0.55 },
        { ratio: 1.19, decay: 1.5, gain: 0.42 },
        { ratio: 1.5, decay: 1.1, gain: 0.3 },
        { ratio: 2, decay: 0.95, gain: 0.35 },
        { ratio: 2.51, decay: 0.6, gain: 0.22 },
        { ratio: 2.66, decay: 0.55, gain: 0.16 },
        { ratio: 3.01, decay: 0.5, gain: 0.12 },
        { ratio: 4, decay: 0.32, gain: 0.08 }
      ]
      const decayScale = lerp(0.55, 1.3, params.decay)
      for (const partial of partials) {
        const hz = base * partial.ratio
        const detune = lerp(0.5, 1.8, params.metallic)
        for (const offset of [0, detune]) {
          const length = Math.max(8, Math.min(frames, Math.round(Math.min(seconds, partial.decay * decayScale * 1.6) * sampleRate)))
          addInto(out, tone(length, sampleRate, hz + offset, hz + offset, {
            decay: partial.decay * decayScale,
            glide: 1,
            attack: 0.002
          }), 0, partial.gain * (offset === 0 ? 0.5 : 0.28))
        }
      }
      // Strike noise: what a bell sounds like at the instant of contact.
      addBurst(out, sampleRate, rand, 0, 0.2 + 0.2 * params.metallic, {
        seconds: 0.02, decay: 0.006, from: 3000, q: 0.8, mode: 'hp'
      })
      addBurst(out, sampleRate, rand, 0, 0.18, { seconds: 0.08, decay: 0.02, from: 400, q: 0.7, mode: 'lp' })
      return reverb(out, sampleRate, params.space * 0.6, 0.65)
    }
  },

  'choir-pad': {
    description: 'Loopable choir-like chord pad with breath and slow movement. Use as a bed for dread, awe, sacred spaces, menu screens.',
    defaultDuration: 3.4,
    defaults: { pitch: 1, bright: 0.45, movement: 0.5, space: 0.2 },
    params: { pitch: [0.5, 2], bright: [0, 1], movement: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand, timing) {
      const out = new Float32Array(frames)
      // A loop render snaps every voice to the loop period (`timing.loopFrames`)
      // rather than to the rendered buffer, which is one period plus the
      // overlap-add tail.
      const period = timing === undefined || !Number.isFinite(timing.loopFrames) ? frames : timing.loopFrames
      const root = loopFreq(220 * params.pitch, period, sampleRate)
      const vibrato = loopFreq(4.2, period, sampleRate)
      const swellRate = loopFreq(0.26, period, sampleRate)
      // A minor stack plus an octave: voices, not a synth chord. Every voice is
      // a phase-spread detuned pair; without the spread all twelve start in
      // phase and the pad pokes out of the mix with a 12 dB crest.
      const ratios = [0.5, 1, 1.2, 1.5, 2, 2.4]
      const voicePhase = [0, 2.399, 4.799, 0.733, 3.142, 5.541]
      const copyPhase = [0.61, 2.05]
      const voiceHz = ratios.map((ratio) => [0, 1].map((copy) => loopFreq(root * ratio * (copy === 0 ? 1 : 1.0018), period, sampleRate)))
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        let sum = 0
        for (let voice = 0; voice < voiceHz.length; voice += 1) {
          const gain = 0.3 / (1 + voice * 0.35)
          for (let copy = 0; copy < copyPhase.length; copy += 1) {
            const hz = voiceHz[voice][copy]
            const phase = TAU * hz * t + voicePhase[voice] + copyPhase[copy]
            const angle = phase + 0.004 * Math.sin(TAU * vibrato * t + voice * 1.3 + copy)
            const wave = Math.sin(angle) + (0.12 + params.bright * 0.25) * Math.sin(2 * angle + 0.7)
            sum += gain * (copy === 0 ? 1 : 1 / 2.4) * wave
          }
        }
        out[i] = sum
      }
      // Breath and a slow swell stop it from sounding like three oscillators.
      addInto(out, filter(noise(frames, rand, 'pink', sampleRate), sampleRate, () => 1200, () => 0.7, 'lp'), 0, 0.05 + 0.04 * (1 - params.bright))
      addInto(out, filter(noise(frames, rand, 'white', sampleRate), sampleRate, () => 4000, () => 0.7, 'hp'), 0, 0.01 + 0.02 * params.bright)
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        out[i] *= 1 + 0.08 * params.movement * Math.sin(TAU * swellRate * t)
      }
      return reverb(out, sampleRate, params.space * 0.4, 0.6)
    }
  }
}

/* --------------------------------------------------------------- registry -- */

/**
 * Ids that are built from periodic, level-stationary layers and therefore make
 * a clean `loop: true` bed. Everything else is a one-shot.
 * @type {readonly string[]}
 */
export const LOOPABLE_PRESETS = Object.freeze(['motor-loop', 'alarm-siren', 'insect-buzz', 'choir-pad'])

/**
 * Register the extra presets into the shared `PRESETS` table.
 *
 * Importing this module already does this; the explicit call exists so
 * `index.js` can perform the registration in its own dependency order instead
 * of relying on import side effects. It is idempotent - re-registering the same
 * definitions cannot change a render.
 * @returns {typeof EXTRA_PRESETS} the definitions that were registered.
 */
export function registerExtraPresets () {
  Object.assign(PRESETS, EXTRA_PRESETS)
  return EXTRA_PRESETS
}

// Plain import is enough; no ordering requirement on the caller.
registerExtraPresets()
