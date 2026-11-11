/**
 * Deterministic synthesis kernel.
 *
 * Everything here is pure: identical (preset, params, duration, sampleRate,
 * seed) always produces identical samples. That property is what lets the
 * caller cache renders, diff two takes, and trust that the file a model
 * analysed is the file an animation will play.
 *
 * Signal path primitives are deliberately small: a TPT state-variable filter,
 * seeded noise, phase-accumulating oscillators, exponential envelopes, and a
 * Schroeder reverb. Presets compose those into *perceptual* parameters
 * (weight, hardness, metallic, brightness, space) instead of exposing Hz and Q,
 * because those are the knobs a language model can actually aim.
 */

const TAU = Math.PI * 2

/**
 * Mulberry32: small, fast, deterministic PRNG.
 * @param {number} seed - unsigned 32-bit seed.
 * @returns {() => number} uniform samples in [0, 1).
 */
export function makeRng (seed) {
  let state = seed >>> 0
  return function next () {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Clamp to [min, max]. */
export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)
/** Clamp to [0, 1]. */
export const unit = (value) => clamp(Number.isFinite(value) ? value : 0, 0, 1)
/** Linear interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t
/** Decibels to linear gain. */
export const dbToGain = (db) => Math.pow(10, db / 20)
/** ISO-ish deterministic hash for cache keys. */
export function specHash (text) {
  let h1 = 0x811C9DC5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x85EBCA6B) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

/** Topology-preserving state-variable filter (Cytomic form). */
class Svf {
  constructor () {
    this.ic1 = 0
    this.ic2 = 0
  }

  /**
   * @param {number} input - sample.
   * @param {number} cutoff - Hz.
   * @param {number} q - resonance (0.5 = flat).
   * @param {number} sampleRate - Hz.
   * @param {'lp'|'hp'|'bp'} mode - response.
   */
  process (input, cutoff, q, sampleRate, mode) {
    const fc = clamp(cutoff, 20, sampleRate * 0.45)
    const g = Math.tan(Math.PI * fc / sampleRate)
    const k = 1 / Math.max(q, 0.15)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = input - this.ic2
    const v1 = a1 * this.ic1 + a2 * v3
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    if (mode === 'bp') return v1
    if (mode === 'hp') return input - k * v1 - v2
    return v2
  }
}

/**
 * Run a signal through a filter whose cutoff and Q may move per sample.
 * @param {Float32Array} input - source samples.
 * @param {number} sampleRate - Hz.
 * @param {(progress: number) => number} cutoffAt - Hz at normalised position.
 * @param {(progress: number) => number} [qAt] - Q at normalised position.
 * @param {'lp'|'hp'|'bp'} [mode] - response.
 * @returns {Float32Array} filtered copy.
 */
export function filter (input, sampleRate, cutoffAt, qAt = () => 0.8, mode = 'lp') {
  const out = new Float32Array(input.length)
  const svf = new Svf()
  for (let i = 0; i < input.length; i += 1) {
    const p = input.length > 1 ? i / (input.length - 1) : 0
    out[i] = svf.process(input[i], cutoffAt(p), qAt(p), sampleRate, mode)
  }
  return out
}

/**
 * Seeded noise generator.
 * @param {number} frames - sample count.
 * @param {(p: number) => number} [cutoffAt] - optional low-pass corner over time.
 * @returns {Float32Array} noise with unit-ish RMS.
 */
export function noise (frames, rand, color = 'white', sampleRate = 48000) {
  const out = new Float32Array(frames)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let last = 0
  for (let i = 0; i < frames; i += 1) {
    const white = rand() * 2 - 1
    if (color === 'pink') {
      b0 = 0.99765 * b0 + white * 0.099046
      b1 = 0.963 * b1 + white * 0.2965164
      b2 = 0.57 * b2 + white * 1.0526913
      out[i] = (b0 + b1 + b2 + white * 0.1848) * 0.25
    } else if (color === 'brown') {
      last = clamp(last + white * 0.02, -1, 1)
      out[i] = last * 0.5
    } else {
      out[i] = white * 0.5
    }
  }
  return out
}

/**
 * Exponential percussive envelope.
 * @param {number} frames - length.
 * @param {number} sampleRate - Hz.
 * @param {number} decaySeconds - time to fall to 1/e.
 * @param {number} [attackSeconds] - fade-in length.
 * @param {number} [shape] - >1 makes the tail steeper.
 * @returns {Float32Array} envelope peaking at 1.
 */
export function decayEnvelope (frames, sampleRate, decaySeconds, attackSeconds = 0.001, shape = 1) {
  const out = new Float32Array(frames)
  const attack = Math.max(1, attackSeconds * sampleRate)
  const tau = Math.max(1 / sampleRate, decaySeconds) * sampleRate
  for (let i = 0; i < frames; i += 1) {
    const attackGain = i < attack ? i / attack : 1
    out[i] = attackGain * Math.pow(Math.exp(-i / tau), shape)
  }
  return out
}

/** Add `src` into `dst` at a sample offset with a gain. */
export function addInto (dst, src, offset, gain = 1) {
  const start = Math.max(0, Math.round(offset))
  const limit = Math.min(dst.length, start + src.length)
  for (let i = start; i < limit; i += 1) dst[i] += src[i - start] * gain
}

/**
 * Additive/glide tone with exponential pitch movement.
 * @param {number} frames - length.
 * @param {number} sampleRate - Hz.
 * @param {number} startHz - initial frequency.
 * @param {number} endHz - final frequency.
 * @param {number} glide - 0 = hold start pitch, 1 = reach end pitch within the decay.
 * @param {(t: number) => number} envelope - amplitude at normalised time.
 * @param {number} [shape] - waveform shape (0 sine, 1 triangle-ish, 2 tanh square).
 * @returns {Float32Array} tone.
 */
export function glideTone (frames, sampleRate, startHz, endHz, glide, envelope, shape = 0) {
  const out = new Float32Array(frames)
  let phase = 0
  for (let i = 0; i < frames; i += 1) {
    const p = frames > 1 ? i / (frames - 1) : 0
    const freq = lerp(startHz, endHz, Math.pow(p, 1 / Math.max(glide, 0.05)))
    phase += freq / sampleRate
    if (phase >= 1) phase -= 1
    const sine = Math.sin(TAU * phase)
    const sample = shape === 0
      ? sine
      : shape === 1
        ? 1 - 4 * Math.abs(phase - 0.5)
        : Math.tanh(3 * sine)
    out[i] = sample * envelope(p)
  }
  return out
}

/**
 * Schroeder reverb send.
 * @param {Float32Array} input - dry signal.
 * @param {number} sampleRate - Hz.
 * @param {number} amount - 0..1 wet amount.
 * @param {number} size - 0..1 room size.
 * @returns {Float32Array} input plus wet tail.
 */
export function reverb (input, sampleRate, amount, size = 0.5) {
  if (amount <= 0) return input
  const scale = sampleRate / 44100
  const combSeconds = [0.0297, 0.0371, 0.0411, 0.0437]
  const allpassSeconds = [0.005, 0.0017]
  const combs = combSeconds.map((seconds) => ({
    buffer: new Float32Array(Math.max(2, Math.round(seconds * scale * (0.7 + size * 0.9) * sampleRate / sampleRate * 44100 / 44100 * 1))),
    index: 0,
    damping: 0
  }))
  // Delay lengths in samples, computed once from the reference table.
  for (const comb of combs) comb.buffer = new Float32Array(Math.max(2, Math.round(combSeconds[combs.indexOf(comb)] * (0.7 + size * 0.9) * 44100 * scale)))
  const allpasses = allpassSeconds.map((seconds) => ({
    buffer: new Float32Array(Math.max(2, Math.round(seconds * 44100 * scale))),
    index: 0
  }))

  const wet = new Float32Array(input.length)
  const feedback = 0.74 + size * 0.18
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i]
    let sum = 0
    for (const comb of combs) {
      const delayed = comb.buffer[comb.index]
      comb.damping = delayed * 0.75 + comb.damping * 0.25
      comb.buffer[comb.index] = sample * 0.25 + comb.damping * feedback
      comb.index = (comb.index + 1) % comb.buffer.length
      sum += delayed
    }
    for (const allpass of allpasses) {
      const delayed = allpass.buffer[allpass.index]
      const output = -sum + delayed
      allpass.buffer[allpass.index] = sum + delayed * 0.5
      allpass.index = (allpass.index + 1) % allpass.buffer.length
      sum = output
    }
    wet[i] = sum * 0.22
  }

  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] + wet[i] * amount
  return out
}

/** Peak-normalise to a target dBFS, never boosting above `ceiling`, returning applied gain. */
export function normalizePeak (buffer, targetDbfs = -1, ceilingDbfs = 0) {
  let peak = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const magnitude = Math.abs(buffer[i])
    if (magnitude > peak) peak = magnitude
  }
  if (peak === 0) return 0
  const target = dbToGain(targetDbfs)
  const ceiling = dbToGain(ceilingDbfs)
  const gain = Math.min(target / peak, ceiling / peak)
  if (gain !== 1) for (let i = 0; i < buffer.length; i += 1) buffer[i] *= gain
  return gain
}

/** Peak-limiting soft clip; linear below the knee, tanh above. */
export function softLimit (buffer, knee = 0.85) {
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i]
    const magnitude = Math.abs(value)
    if (magnitude > knee) {
      const over = (magnitude - knee) / (1 - knee)
      buffer[i] = Math.sign(value) * (knee + (1 - knee) * Math.tanh(over))
    }
  }
  return buffer
}

/**
 * One-pole DC blocker.
 *
 * Sub-audio wander (a noise bed, a slow random walk) is inaudible but eats
 * headroom and reads as a DC offset in the metrics, which sends an agent
 * chasing a problem that is not there. Removing everything below the audible
 * band keeps the "dcOffset" measurement meaningful.
 * @param {Float32Array} buffer - samples, modified in place.
 * @param {number} sampleRate - Hz.
 * @param {number} [cutoff] - corner frequency in Hz.
 */
export function dcBlock (buffer, sampleRate, cutoff = 18) {
  const r = Math.exp(-2 * Math.PI * cutoff / sampleRate)
  let previousInput = 0
  let previousOutput = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const input = buffer[i]
    const output = input - previousInput + r * previousOutput
    previousInput = input
    previousOutput = output
    buffer[i] = output
  }
  return buffer
}

/* ---------------------------------------------------------------- presets -- */

/**
 * Resolve a preset's parameters: defaults, then caller overrides clamped by the
 * declared range. Unknown keys are ignored so a stale model guess cannot throw.
 */
export function resolveParams (preset, params = {}) {
  const spec = PRESETS[preset]
  if (spec === undefined) throw new Error(`unknown preset "${preset}"; available: ${Object.keys(PRESETS).join(', ')}`)
  const resolved = { ...spec.defaults }
  for (const [key, range] of Object.entries(spec.params ?? {})) {
    const raw = params[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    resolved[key] = clamp(raw, range[0], range[1])
  }
  if (typeof params.kind === 'string' && spec.kinds?.includes(params.kind)) resolved.kind = params.kind
  return resolved
}

/** Every preset's defaults and parameter ranges, for tool schemas and docs. */
export const PRESETS = {
  impact: {
    description: 'Weighty hit: body thump, transient click, optional metallic ring. Use for collisions, slams, landings.',
    defaultDuration: 0.9,
    defaults: { weight: 0.6, hardness: 0.5, metallic: 0.2, space: 0.2, pitch: 1, tone: 0.5 },
    params: { weight: [0, 1], hardness: [0, 1], metallic: [0, 1], space: [0, 1], pitch: [0.5, 2], tone: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const weight = params.weight
      const baseHz = lerp(150, 52, weight) * params.pitch
      const bodyDecay = lerp(0.16, 0.85, weight)
      const body = glideTone(frames, sampleRate, baseHz * 2.4, baseHz, 0.18, (t) => Math.exp(-t * 5.2), 0)
      addInto(out, body, 0, 0.9)
      const sub = glideTone(frames, sampleRate, baseHz * 0.5, baseHz * 0.45, 0.1, (t) => Math.exp(-t * 3.2), 0)
      addInto(out, sub, 0, 0.55 * weight)
      const clickFrames = Math.min(frames, Math.round(0.012 * sampleRate))
      const click = noise(clickFrames, rand, 'white', sampleRate)
      const clickDecay = decayEnvelope(clickFrames, sampleRate, 0.004)
      for (let i = 0; i < clickFrames; i += 1) click[i] *= clickDecay[i]
      const brightClick = filter(click, sampleRate, () => lerp(1800, 5200, params.hardness), () => 0.9, 'hp')
      addInto(out, brightClick, 0, 0.5 * lerp(0.6, 1, params.hardness))
      const metallic = params.metallic
      if (metallic > 0.01) {
        const ratios = [1, 1.71, 2.43, 3.17, 4.61]
        const partialFrames = Math.min(frames, Math.round(lerp(0.2, 1.4, metallic) * sampleRate))
        for (const ratio of ratios) {
          const partial = glideTone(partialFrames, sampleRate, baseHz * 3.1 * ratio, baseHz * 3.1 * ratio, 1,
            (t) => Math.exp(-t * lerp(9, 2.2, metallic)) * (0.6 + rand() * 0.6), 0)
          addInto(out, partial, 0, metallic * 0.18)
        }
      }
      return reverb(out, sampleRate, params.space * 0.5, 0.35 + params.space * 0.4)
    }
  },

  whoosh: {
    description: 'Moving air: filtered-noise sweep with a doppler-ish arc. Use for passes, transitions, swings, reveals.',
    defaultDuration: 0.8,
    defaults: { speed: 0.5, tone: 0.5, space: 0.25, rise: 0.5, pitch: 1 },
    params: { speed: [0, 1], tone: [0, 1], space: [0, 1], rise: [0, 1], pitch: [0.5, 2] },
    render (params, frames, sampleRate, rand) {
      const peak = lerp(0.32, 0.75, 1 - params.rise)
      const bed = noise(frames, rand, 'pink', sampleRate)
      const startHz = 260 * params.pitch
      const peakHz = lerp(900, 4200, params.tone) * params.pitch
      const endHz = lerp(180, 700, params.tone) * params.pitch
      const swept = filter(bed, sampleRate,
        (p) => (p < peak ? lerp(startHz, peakHz, Math.pow(p / peak, 1.6)) : lerp(peakHz, endHz, Math.pow((p - peak) / (1 - peak), 0.7))),
        (p) => lerp(1.2, 5.5, Math.sin(Math.PI * p)),
        'bp')
      for (let i = 0; i < frames; i += 1) {
        const p = i / frames
        const arc = p < peak
          ? Math.pow(p / peak, 1.4)
          : Math.pow(1 - (p - peak) / (1 - peak), 1.7)
        swept[i] *= arc
      }
      const tonal = glideTone(frames, sampleRate, startHz * 2.2, endHz * 2.6, 1, (p) => Math.sin(Math.PI * p) * 0.12, 0)
      addInto(swept, tonal, 0, lerp(0.1, 0.35, params.tone))
      return reverb(swept, sampleRate, params.space * 0.55, 0.4)
    }
  },

  tick: {
    description: 'Very short click/blip. The building block for dense event trains (typing, clocks, UI state changes).',
    defaultDuration: 0.05,
    defaults: { pitch: 0.5, hardness: 0.6, pitchJitter: 0 },
    params: { pitch: [0, 1], hardness: [0, 1], pitchJitter: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const hz = lerp(900, 5200, params.pitch) * (1 + (rand() - 0.5) * params.pitchJitter * 0.4)
      const decay = lerp(0.004, 0.03, 1 - params.hardness)
      const tone = glideTone(frames, sampleRate, hz, hz * 0.92, 1, (t) => Math.exp(-t * (2.2 / Math.max(decay, 0.001) / 100)), 0)
      addInto(out, tone, 0, 0.7)
      const burstFrames = Math.min(frames, Math.round(decay * 2 * sampleRate))
      const burst = noise(burstFrames, rand, 'white', sampleRate)
      const burstEnv = decayEnvelope(burstFrames, sampleRate, decay)
      for (let i = 0; i < burstFrames; i += 1) burst[i] *= burstEnv[i]
      addInto(filter(burst, sampleRate, () => lerp(1200, 6000, params.hardness), () => 0.9, 'hp'), 0, 0.45)
      return out
    }
  },

  chime: {
    description: 'Tonal bell/blip with inharmonic partials. Use for notifications, pickups, confirmations, magic.',
    defaultDuration: 1.1,
    defaults: { pitch: 0.5, decay: 0.6, metallic: 0.5, space: 0.3 },
    params: { pitch: [0, 1], decay: [0, 1], metallic: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const base = lerp(320, 1400, params.pitch)
      const ratios = [1, 2.76, 5.4, 8.93]
      ratios.forEach((ratio, index) => {
        const gain = index === 0 ? 1 : lerp(0.12, 0.55, params.metallic) / (index + 0.6)
        const partial = glideTone(frames, sampleRate, base * ratio, base * ratio, 1,
          (t) => Math.exp(-t * lerp(7.5, 1.1, params.decay)) * (index === 0 ? 1 : Math.exp(-t * index * 1.4)), 0)
        addInto(out, partial, 0, gain * 0.42)
      })
      const shimmer = glideTone(frames, sampleRate, base * 2, base * 2, 1,
        (t) => Math.exp(-t * lerp(14, 4, params.decay)) * 0.25, 0)
      for (let i = 0; i < frames; i += 1) {
        shimmer[i] *= 0.6 + 0.4 * Math.sin(TAU * (base * 0.5) * (i / sampleRate))
      }
      addInto(out, shimmer, 0, 0.3)
      return reverb(out, sampleRate, params.space * 0.6, 0.55)
    }
  },

  riser: {
    description: 'Tension build: accelerating noise/pitch sweep. Use before impacts, transitions, escalations.',
    defaultDuration: 1.6,
    defaults: { tone: 0.5, tension: 0.6, space: 0.3 },
    params: { tone: [0, 1], tension: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const bed = noise(frames, rand, 'pink', sampleRate)
      const swept = filter(bed, sampleRate,
        (p) => lerp(180, lerp(3000, 9000, params.tone), Math.pow(p, 1.7)),
        (p) => lerp(0.9, 7, params.tension),
        'bp')
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) {
        const p = i / frames
        const tremolo = 0.65 + 0.35 * Math.sin(TAU * lerp(3, 14, p * params.tension) * (i / sampleRate))
        out[i] = swept[i] * Math.pow(p, 1.6) * tremolo
      }
      const tone = glideTone(frames, sampleRate, 90, lerp(500, 1500, params.tone), 1, (p) => Math.pow(p, 2) * 0.25, 1)
      addInto(out, tone, 0, 0.6)
      return reverb(out, sampleRate, params.space * 0.5, 0.6)
    }
  },

  zap: {
    description: 'Electric discharge: fast downward chirp plus crackle. Use for energy, teleports, devices, damage.',
    defaultDuration: 0.3,
    defaults: { pitch: 0.5, roughness: 0.5, space: 0.2 },
    params: { pitch: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const startHz = lerp(1400, 5200, params.pitch)
      const endHz = lerp(60, 220, params.pitch)
      const chirp = glideTone(frames, sampleRate, startHz, endHz, 0.55,
        (t) => Math.exp(-t * lerp(6, 3, params.roughness)), 2)
      const out = new Float32Array(frames)
      addInto(out, chirp, 0, 0.8)
      const crackleFrames = Math.min(frames, Math.round(0.06 * sampleRate))
      const crackle = noise(crackleFrames, rand, 'white', sampleRate)
      const env = decayEnvelope(crackleFrames, sampleRate, 0.02)
      for (let i = 0; i < crackleFrames; i += 1) crackle[i] *= env[i] * (rand() > 0.85 ? 1 : 0.25)
      addInto(filter(crackle, sampleRate, () => 3200, () => 1.2, 'hp'), 0, 0.5 * lerp(0.5, 1, params.roughness))
      return reverb(out, sampleRate, params.space * 0.4, 0.3)
    }
  },

  thud: {
    description: 'Soft low body hit with almost no transient. Use for footsteps, distant impacts, heartbeat, weight.',
    defaultDuration: 0.35,
    defaults: { weight: 0.7, softness: 0.5, space: 0.15 },
    params: { weight: [0, 1], softness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const hz = lerp(95, 46, params.weight)
      const body = glideTone(frames, sampleRate, hz * 1.6, hz, 0.2,
        (t) => Math.exp(-t * lerp(9, 4, params.softness)), 0)
      const out = new Float32Array(frames)
      addInto(out, body, 0, 0.9)
      const tail = noise(frames, rand, 'brown', sampleRate)
      const bodyFrames = Math.round(frames * lerp(0.3, 0.7, params.softness))
      const env = decayEnvelope(bodyFrames, sampleRate, lerp(0.05, 0.16, params.softness))
      for (let i = 0; i < bodyFrames; i += 1) tail[i] *= env[i]
      addInto(filter(tail, sampleRate, () => lerp(180, 420, 1 - params.weight), () => 0.7, 'lp'), 0, 0.35)
      return reverb(out, sampleRate, params.space * 0.45, 0.3)
    }
  },

  scrap: {
    description: 'Grains of friction: several clustered bursts with metallic bite. Use for scraping, tearing, debris, creatures.',
    defaultDuration: 0.6,
    defaults: { density: 0.5, tone: 0.5, roughness: 0.6, space: 0.2 },
    params: { density: [0, 1], tone: [0, 1], roughness: [0, 1], space: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const grains = Math.max(2, Math.round(lerp(2, 14, params.density)))
      for (let g = 0; g < grains; g += 1) {
        const at = Math.floor(rand() * frames * 0.85)
        const length = Math.max(8, Math.round((0.006 + rand() * 0.03) * sampleRate))
        const grain = noise(length, rand, 'white', sampleRate)
        const env = decayEnvelope(length, sampleRate, 0.004 + rand() * 0.012)
        for (let i = 0; i < length; i += 1) grain[i] *= env[i]
        const hz = lerp(700, 5200, params.tone) * (0.7 + rand() * 0.8)
        addInto(out, filter(grain, sampleRate, () => hz, () => lerp(2, 9, params.roughness), 'bp'), at, 0.5 + rand() * 0.5)
      }
      return reverb(out, sampleRate, params.space * 0.5, 0.4)
    }
  },

  texture: {
    description: 'Sustained bed: wind, rain, fire, room tone, or electric hum. Loopable; use for ambience under a scene.',
    defaultDuration: 3,
    defaults: { kind: 'wind', density: 0.5, tone: 0.5, movement: 0.4 },
    kinds: ['wind', 'rain', 'fire', 'room', 'hum'],
    params: { density: [0, 1], tone: [0, 1], movement: [0, 1] },
    render (params, frames, sampleRate, rand) {
      const out = new Float32Array(frames)
      const seconds = frames / sampleRate
      const base = noise(frames, rand, 'pink', sampleRate)
      const kind = params.kind
      if (kind === 'hum') {
        for (let i = 0; i < frames; i += 1) {
          const t = i / sampleRate
          out[i] = 0.22 * Math.sin(TAU * 55 * t) + 0.1 * Math.sin(TAU * 110 * t) + 0.05 * Math.sin(TAU * 165 * t)
        }
        addInto(out, filter(base, sampleRate, () => 400, () => 0.6, 'lp'), 0, 0.15 * params.density)
        return out
      }
      const lowBed = filter(base, sampleRate, (p) => lerp(180, 900, params.tone), () => 0.7, 'lp')
      for (let i = 0; i < frames; i += 1) {
        const t = i / sampleRate
        const slow = 1 + params.movement * 0.5 * Math.sin(TAU * (1 / Math.max(seconds, 0.5)) * t + 0.7)
        out[i] = lowBed[i] * slow
      }
      if (kind === 'rain' || kind === 'fire') {
        const drops = Math.round(frames / sampleRate * lerp(40, 220, params.density))
        for (let d = 0; d < drops; d += 1) {
          const at = Math.floor(rand() * (frames - 1))
          const length = Math.max(6, Math.round(0.0015 * sampleRate * (0.5 + rand())))
          for (let i = 0; i < length && at + i < frames; i += 1) {
            out[at + i] += (rand() * 2 - 1) * 0.4 * Math.exp(-i / (length * 0.4))
          }
        }
        const hiss = noise(frames, rand, 'white', sampleRate)
        addInto(out, filter(hiss, sampleRate, () => lerp(1500, 6000, params.tone), () => 0.8, 'hp'), 0, lerp(0.03, 0.14, params.density))
      }
      return out
    }
  }
}

/** Human-readable catalogue used by tool descriptions and the skill. */
export function presetCatalog () {
  return Object.entries(PRESETS).map(([name, spec]) => ({
    name,
    description: spec.description,
    defaultDuration: spec.defaultDuration,
    knobs: Object.keys(spec.params ?? {}),
    kinds: spec.kinds
  }))
}
