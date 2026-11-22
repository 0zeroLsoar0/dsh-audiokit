/**
 * Runtime synthesis graph: a declarative DSL a model writes itself.
 *
 * The preset table in ./dsp.js answers "pick one of 38 sounds". This module
 * answers the next question: "invent a sound that is not in the table". A graph
 * is a small JSON document — oscillators (with FM), noise, filters with sweeps,
 * ADSR envelopes, LFOs, gain, drive, ring modulation, pan, reverb and summing —
 * composed at request time. The vocabulary stays open-ended while the output
 * stays deterministic and cheap to render.
 *
 * Design choices worth knowing before reading the code:
 *
 * - **References are ids or indices.** A model writes nodes in order; forcing
 *   it to invent an id for every node adds error surface. `input: 2` and
 *   `input: "pad"` both work, and auto ids are `n0`, `n1`, ... by position.
 *
 * - **Validation is separate from rendering and allocation-free.** The tool
 *   layer has to answer "what is wrong with this DSL" in a few milliseconds,
 *   with paths a model can act on, before a 132300-sample buffer is allocated
 *   for a graph that was never going to render. `validateGraph` therefore walks
 *   the document only; `renderGraph` calls it first and allocates after.
 *
 * - **Block processing.** Reachable nodes are evaluated in topological order on
 *   128-frame blocks, so every stateful node (oscillator phase, filter state,
 *   reverb combs, envelope position) advances in one pass and memory stays at
 *   one block per node instead of one buffer per node.
 *
 * Reused from ./dsp.js: `noise` (whole-buffer, so pink/brown colouring carries
 * one continuous state instead of resetting at every block), `filter`
 * (band-limiting a noise source once at setup), `makeRng`, `dbToGain`,
 * `clamp`, `addInto`.
 *
 * Written here because dsp.js has no block-stateful form of them: the
 * oscillator (with PolyBLEP anti-aliasing and FM), a TPT state-variable filter
 * that keeps its state across blocks, a Schroeder reverb with the same
 * topology as `dsp.reverb` but persistent state, the waveshapers
 * (soft/hard/wavefold), and a 2048-point FFT for the report's centroid. The
 * FFT is the one duplicated kernel: neither audio.js nor analyze.js exports
 * one and `analyzeSound` costs tens of milliseconds, which is too much for a
 * single report field the renderer can produce in a fraction of a millisecond.
 */

import { addInto, clamp, dbToGain, filter as dspFilter, makeRng, noise as dspNoise } from './dsp.js'

/* --------------------------------------------------------------- limits -- */

const TAU = Math.PI * 2

/**
 * Rendering quantum in frames. 128 is the classic audio block: small enough
 * that per-block bookkeeping is invisible next to the per-sample work, large
 * enough that nothing recomputes a constant 44100 times a second.
 */
const BLOCK = 128

/** How many problems a single validation pass reports before summarising. */
const MAX_ERRORS = 24

const DEFAULT_DURATION = 1
const DEFAULT_SAMPLE_RATE = 44100
const GUARD_FADE_SECONDS = 0.008

/** A graph is a cue, not a soundtrack; past these it is a mistake worth naming. */
const MAX_NODES = 64
const MAX_SUM_INPUTS = 16
const MIN_DURATION = 0.008
const MAX_DURATION = 30
const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 96000
const MIN_HZ = 8
const MAX_HZ = 20000
const MIN_Q = 0.15
const MAX_Q = 20
const MIN_DB = -60
const MAX_DB = 24

/**
 * Noise sources are generated whole-buffer (see `renderGraph`), so N noise
 * nodes at 30 s and 96 kHz would be N x 11.5 MB *before* the first block is
 * rendered. 96 MB is generous for a cue and still stops a document that would
 * only end in an out-of-memory crash.
 */
const NOISE_BUFFER_BUDGET = 96 * 1024 * 1024

/** Schneider-style comb/allpass delays, as fractions of a second. */
const COMB_SECONDS = [0.0297, 0.0371, 0.0411, 0.0437]
const ALLPASS_SECONDS = [0.005, 0.0017]

/** One Hann-windowed frame is enough for a brightness number. */
const FFT_SIZE = 2048

const SILENT_DB = -120

/** Every numeric bound the DSL and the renderer share, in one place. */
const LIMITS = Object.freeze({
  maxNodes: MAX_NODES,
  maxSumInputs: MAX_SUM_INPUTS,
  maxNoiseBufferBytes: NOISE_BUFFER_BUDGET,
  minDurationSeconds: MIN_DURATION,
  maxDurationSeconds: MAX_DURATION,
  minSampleRate: MIN_SAMPLE_RATE,
  maxSampleRate: MAX_SAMPLE_RATE,
  minHz: MIN_HZ,
  maxHz: MAX_HZ,
  minQ: MIN_Q,
  maxQ: MAX_Q,
  minDb: MIN_DB,
  maxDb: MAX_DB
})

/* --------------------------------------------------------------- schema -- */

/**
 * The documented node vocabulary, and the table the validator runs on.
 *
 * Documentation and validation are the same object on purpose: a field the tool
 * description promises but the validator does not accept (or the other way
 * around) is the most common way a DSL rots, and one table cannot disagree with
 * itself. `description` strings are written for the model; the tool layer
 * compacts them into its parameter help.
 */
export const GRAPH_SCHEMA = Object.freeze({
  summary: 'A graph is { nodes: [ { id?, type, ... } ], output? }. Sources (osc, noise) have no input; processors take one `input`; sum takes `inputs`. A node is referenced by its id ("n0" by default) or by its 0-based index. `output` defaults to the last audio node. Rendering is deterministic: the same graph, duration, sample rate and seed always produce identical samples; the seed only changes noise.',
  limits: LIMITS,
  common: Object.freeze({
    id: 'optional name other nodes can reference; defaults to "n<index>"',
    input: 'the node this one processes (id or index); required on processors, rejected on sources',
    lfo: 'shorthand for an lfo node attached to this one: { hz, depth, target }'
  }),
  nodes: Object.freeze({
    osc: Object.freeze({
      description: 'Oscillator: the tuned part of a sound. PolyBLEP anti-aliasing on saw/square. fm turns it into a sideband generator; an lfo on pitch is vibrato.',
      fields: Object.freeze({
        wave: { type: 'string', values: ['sine', 'triangle', 'saw', 'square'], default: 'sine' },
        hz: { type: 'number', range: [MIN_HZ, MAX_HZ], required: true },
        detuneCents: { type: 'number', range: [-1200, 1200], default: 0 },
        phase: { type: 'number', range: [0, 1], default: 0 },
        fm: {
          type: 'object',
          description: 'Frequency modulation: hz = modulator rate, depth = peak deviation in Hz, decay = seconds for the index to fall to 1/e (the classic bell); omit decay for a steady tone.',
          fields: Object.freeze({
            hz: { type: 'number', range: [0.01, MAX_HZ], required: true },
            depth: { type: 'number', range: [0, MAX_HZ], default: 0 },
            decay: { type: 'number', range: [0.01, MAX_DURATION] }
          })
        }
      })
    }),
    noise: Object.freeze({
      description: 'Noise source. Give hz to band-limit it and q to set the width of that band (the difference between "a wind" and "a hiss"); leave hz out for broadband noise.',
      fields: Object.freeze({
        color: { type: 'string', values: ['white', 'pink', 'brown'], default: 'white' },
        hz: { type: 'number', range: [20, MAX_HZ] },
        q: { type: 'number', range: [MIN_Q, MAX_Q], default: 1.2 }
      })
    }),
    filter: Object.freeze({
      description: 'State-variable filter. sweepTo moves the cutoff exponentially (musical, not linear in Hz) over sweepTime; an lfo on filter wobbles it.',
      fields: Object.freeze({
        mode: { type: 'string', values: ['lp', 'hp', 'bp'], default: 'lp' },
        hz: { type: 'number', range: [20, MAX_HZ], required: true },
        q: { type: 'number', range: [MIN_Q, MAX_Q], default: 0.8 },
        sweepTo: { type: 'number', range: [20, MAX_HZ] },
        sweepTime: { type: 'number', range: [0.001, MAX_DURATION], default: 1 }
      })
    }),
    env: Object.freeze({
      description: 'ADSR amplitude envelope. sustain is a level (0 = a one-shot pluck that decays to silence, 1 = held); curve above 1 is a snappier attack and a faster decay.',
      fields: Object.freeze({
        attack: { type: 'number', range: [0, MAX_DURATION], default: 0.005 },
        decay: { type: 'number', range: [0, MAX_DURATION], default: 0.2 },
        sustain: { type: 'number', range: [0, 1], default: 0 },
        release: { type: 'number', range: [0, MAX_DURATION], default: 0.05 },
        curve: { type: 'number', range: [0.1, 4], default: 1 }
      })
    }),
    lfo: Object.freeze({
      description: 'Low-frequency oscillator attached to another node; it produces no audio of its own. target picks what it moves: pitch (osc only), amp (any node) or filter (filter only). target defaults from the modulated node type.',
      fields: Object.freeze({
        to: { type: 'ref', required: true },
        hz: { type: 'number', range: [0.01, 40], default: 5 },
        depth: { type: 'number', range: [0, 1], default: 0.5 },
        target: { type: 'string', values: ['pitch', 'amp', 'filter'] }
      })
    }),
    gain: Object.freeze({
      description: 'Level trim in dB. Use it to balance the branches that meet in a sum.',
      fields: Object.freeze({
        db: { type: 'number', range: [MIN_DB, MAX_DB], default: 0 }
      })
    }),
    drive: Object.freeze({
      description: 'Waveshaper. soft = tanh saturation (odd harmonics), hard = clipping, fold = wavefolding (harmonics climb and wrap). amount 1 is heavy.',
      fields: Object.freeze({
        amount: { type: 'number', range: [0, 1], default: 0.5 },
        kind: { type: 'string', values: ['soft', 'hard', 'fold'], default: 'soft' }
      })
    }),
    ring: Object.freeze({
      description: 'Ring modulation: multiplies the signal by a sine at hz, adding sum and difference sidebands. depth 1 is full ring, 0 leaves it untouched.',
      fields: Object.freeze({
        hz: { type: 'number', range: [0.01, MAX_HZ], required: true },
        depth: { type: 'number', range: [0, 1], default: 1 }
      })
    }),
    pan: Object.freeze({
      description: 'Constant-power pan. The render is mono, so a pan only attenuates its branch (centre passes, a hard pan is -3 dB); it is recorded for graphs exported to a stereo player.',
      fields: Object.freeze({
        pan: { type: 'number', range: [-1, 1], default: 0 }
      })
    }),
    reverb: Object.freeze({
      description: 'Schroeder reverb send: amount is the wet level, size the room. Use it last, and leave the envelope tail room to ring.',
      fields: Object.freeze({
        amount: { type: 'number', range: [0, 1], default: 0.3 },
        size: { type: 'number', range: [0, 1], default: 0.5 }
      })
    }),
    sum: Object.freeze({
      description: 'Add several branches into one. Per-input gains in dB keep the node count down; a chain of gain nodes does the same thing more verbosely.',
      fields: Object.freeze({
        inputs: { type: 'refs', required: true, max: MAX_SUM_INPUTS },
        gains: { type: 'numbers', range: [MIN_DB, MAX_DB] }
      })
    })
  })
})

/* ------------------------------------------------------------ numbers -- */

/** Readable rendering of a bad value for an error message. */
function describe (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 37)}...` : text
  } catch {
    return String(value)
  }
}

/** Round for a stable report; a non-finite intermediate becomes 0, never NaN. */
function round (value, digits) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Amplitude to dBFS, floored instead of -Infinity. */
function amplitudeDb (amplitude) {
  return amplitude > 0 ? Math.max(SILENT_DB, 20 * Math.log10(amplitude)) : SILENT_DB
}

/* -------------------------------------------------------------- kernels -- */

/** PolyBLEP correction for a discontinuous waveform: removes most aliasing. */
function polyBlep (phase, dt) {
  if (!(dt > 0)) return 0
  if (phase < dt) {
    const x = phase / dt
    return x + x - x * x - 1
  }
  if (phase > 1 - dt) {
    const x = (phase - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/**
 * One sample of a naive oscillator, with the saw/square discontinuities
 * smoothed by PolyBLEP. Phase is normalised 0..1.
 */
function waveAt (wave, phase, dt) {
  if (wave === 'sine') return Math.sin(TAU * phase)
  if (wave === 'saw') return 2 * phase - 1 - polyBlep(phase, dt)
  if (wave === 'square') {
    const value = phase < 0.5 ? 1 : -1
    return value + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1, dt)
  }
  return 4 * Math.abs(phase - 0.5) - 1
}

/**
 * Triangle wavefolder: a triangle of period 4 in the input, so an input of
 * +-1 maps to +-1 and every further unit folds back. Folding is what turns a
 * sine into a metallic, partial-rich waveform without clipping it flat.
 */
function wavefold (value) {
  const wrapped = ((value - 1) % 4 + 4) % 4
  return Math.abs(wrapped - 2) - 1
}

/** Waveshaper used by the drive node; amount is 0..1. */
function driveShape (value, amount, kind) {
  if (kind === 'hard') return clamp(value * (1 + amount * 30), -1, 1)
  if (kind === 'fold') return wavefold(value * (1 + amount * 8))
  return Math.tanh(value * (1 + amount * 15))
}

/**
 * Schroeder reverb with persistent state, so it can run one block at a time.
 *
 * The topology, delays and feedback are those of `dsp.reverb` (4 damped combs
 * into 2 allpasses) because the two should sound like the same space; only the
 * buffer ownership differs: `dsp.reverb` allocates its state per call and needs
 * the whole signal, which a graph node cannot afford inside a block loop.
 */
class BlockReverb {
  constructor (sampleRate, size) {
    this.feedback = 0.74 + size * 0.18
    this.combs = COMB_SECONDS.map((seconds) => ({
      buffer: new Float32Array(Math.max(2, Math.round(seconds * (0.7 + size * 0.9) * sampleRate))),
      index: 0,
      damping: 0
    }))
    this.allpasses = ALLPASS_SECONDS.map((seconds) => ({
      buffer: new Float32Array(Math.max(2, Math.round(seconds * sampleRate))),
      index: 0
    }))
  }

  /** Write `input + wet * amount` into `out` for `length` frames. */
  process (input, out, length, amount) {
    for (let i = 0; i < length; i += 1) {
      const sample = input[i]
      let sum = 0
      for (let c = 0; c < this.combs.length; c += 1) {
        const comb = this.combs[c]
        const delayed = comb.buffer[comb.index]
        comb.damping = delayed * 0.75 + comb.damping * 0.25
        comb.buffer[comb.index] = sample * 0.25 + comb.damping * this.feedback
        comb.index = (comb.index + 1) % comb.buffer.length
        sum += delayed
      }
      for (let a = 0; a < this.allpasses.length; a += 1) {
        const allpass = this.allpasses[a]
        const delayed = allpass.buffer[allpass.index]
        const output = -sum + delayed
        allpass.buffer[allpass.index] = sum + delayed * 0.5
        allpass.index = (allpass.index + 1) % allpass.buffer.length
        sum = output
      }
      out[i] = sample + sum * 0.22 * amount
    }
  }
}

/* ------------------------------------------------------------- spectrum -- */

/** Smallest power of two at or above a length. */
function nextPow2 (value) {
  let size = 1
  while (size < value) size <<= 1
  return size
}

const fftTables = new Map()

/**
 * Radix-2 FFT tables, built once per size. Precomputed twiddles and the
 * bit-reversal permutation keep the transform a few hundred microseconds at the
 * 2048 points the centroid needs.
 */
function fftFor (size) {
  const cached = fftTables.get(size)
  if (cached !== undefined) return cached
  const levels = Math.round(Math.log2(size))
  const half = size >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let i = 0; i < half; i += 1) {
    cos[i] = Math.cos(TAU * i / size)
    sin[i] = -Math.sin(TAU * i / size)
  }
  const reverse = new Uint32Array(size)
  for (let i = 0; i < size; i += 1) {
    let value = i
    let mirrored = 0
    for (let bit = 0; bit < levels; bit += 1) {
      mirrored = (mirrored << 1) | (value & 1)
      value >>= 1
    }
    reverse[i] = mirrored
  }
  const table = { size, half, cos, sin, reverse }
  fftTables.set(size, table)
  return table
}

/**
 * Spectral centroid of the loudest frame, in Hz.
 *
 * Measured on the loudest region like `measure` in audio.js, so the number the
 * tool reports and the number `audio_probe` reports on the written file agree.
 * Charges one 2048-point FFT (a few tenths of a millisecond), not a full
 * analysis pass.
 */
function spectralCentroid (samples, sampleRate) {
  const length = samples.length
  if (length === 0) return 0
  const size = Math.min(FFT_SIZE, Math.max(256, nextPow2(length)))
  const hop = Math.max(1, size >> 1)
  let bestStart = 0
  let bestEnergy = -1
  for (let start = 0; start < length; start += hop) {
    const end = Math.min(length, start + size)
    let energy = 0
    for (let i = start; i < end; i += 1) energy += samples[i] * samples[i]
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestStart = start
    }
  }
  if (!(bestEnergy > 0)) return 0
  const table = fftFor(size)
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    const sample = bestStart + i < length ? samples[bestStart + i] : 0
    real[i] = sample * (0.5 - 0.5 * Math.cos(TAU * i / size))
  }
  const { cos, sin, reverse } = table
  for (let i = 0; i < size; i += 1) {
    const j = reverse[i]
    if (j > i) {
      let swap = real[i]; real[i] = real[j]; real[j] = swap
      swap = imag[i]; imag[i] = imag[j]; imag[j] = swap
    }
  }
  for (let span = 2; span <= size; span <<= 1) {
    const quarter = span >> 1
    const step = size / span
    for (let start = 0; start < size; start += span) {
      for (let k = 0; k < quarter; k += 1) {
        const angle = k * step
        const wr = cos[angle]
        const wi = sin[angle]
        const a = start + k
        const b = a + quarter
        const tr = real[b] * wr - imag[b] * wi
        const ti = real[b] * wi + imag[b] * wr
        real[b] = real[a] - tr
        imag[b] = imag[a] - ti
        real[a] += tr
        imag[a] += ti
      }
    }
  }
  let weighted = 0
  let total = 0
  for (let bin = 1; bin < size / 2; bin += 1) {
    const hz = bin * sampleRate / size
    if (hz < 20) continue
    const power = real[bin] * real[bin] + imag[bin] * imag[bin]
    weighted += power * hz
    total += power
  }
  return total > 0 ? Math.round(weighted / total) : 0
}

/* ----------------------------------------------------------- validation -- */

const NODE_TYPES = ['osc', 'noise', 'filter', 'env', 'lfo', 'gain', 'drive', 'ring', 'pan', 'reverb', 'sum']
const AUDIO_TYPES = NODE_TYPES.filter((type) => type !== 'lfo')

/** Node types that consume one `input`. */
const PROCESSOR_TYPES = ['filter', 'env', 'gain', 'drive', 'ring', 'pan', 'reverb']

/** The `input` field of an lfo node, named for what it does. */
const COMMON_FIELDS = Object.freeze(['id', 'type'])

/** Which LFO targets a node type can accept. */
function defaultTargetFor (type) {
  if (type === 'osc') return 'pitch'
  if (type === 'filter') return 'filter'
  return 'amp'
}

function acceptsTarget (type, target) {
  if (target === 'pitch') return type === 'osc'
  if (target === 'filter') return type === 'filter'
  return AUDIO_TYPES.includes(type)
}

/**
 * The `lfo` shorthand on a node: the lfo node's fields minus `to`, because the
 * node itself is the target. Taken from GRAPH_SCHEMA so the shorthand and the
 * standalone node can never accept different ranges.
 */
const INLINE_LFO_FIELDS = Object.freeze({
  hz: GRAPH_SCHEMA.nodes.lfo.fields.hz,
  depth: GRAPH_SCHEMA.nodes.lfo.fields.depth,
  target: GRAPH_SCHEMA.nodes.lfo.fields.target
})

/**
 * Check and normalise one node's fields against the schema table.
 *
 * Shared by the top-level node and by nested objects (fm, LFO), so a nested
 * field gets exactly the same range and enum handling as a top-level one.
 */
function readFields (raw, fields, path, fail, normalised) {
  for (const key of Object.keys(fields)) {
    const field = fields[key]
    const value = raw[key]
    const fieldPath = `${path}.${key}`
    if (value === undefined || value === null) {
      if (field.required) fail(fieldPath, 'is required')
      else if (field.default !== undefined) normalised[key] = field.default
      continue
    }
    if (field.type === 'number') {
      if (!Number.isFinite(value)) {
        fail(fieldPath, `must be a finite number, got ${describe(value)}`)
        continue
      }
      if (value < field.range[0] || value > field.range[1]) {
        fail(fieldPath, `must be between ${field.range[0]} and ${field.range[1]}, got ${value}`)
        continue
      }
      normalised[key] = value
    } else if (field.type === 'string') {
      if (typeof value !== 'string' || !field.values.includes(value)) {
        fail(fieldPath, `must be one of ${field.values.join('|')}, got ${describe(value)}`)
        continue
      }
      normalised[key] = value
    } else if (field.type === 'ref') {
      normalised[key] = value
    } else if (field.type === 'refs') {
      if (!Array.isArray(value) || value.length === 0) {
        fail(fieldPath, 'must be a non-empty array of node references')
        continue
      }
      if (value.length > field.max) {
        fail(fieldPath, `takes at most ${field.max} inputs, got ${value.length}`)
        continue
      }
      normalised[key] = value.slice()
    } else if (field.type === 'numbers') {
      if (!Array.isArray(value)) {
        fail(fieldPath, 'must be an array of numbers')
        continue
      }
      const entries = []
      for (let i = 0; i < value.length; i += 1) {
        const entry = value[i]
        if (!Number.isFinite(entry)) {
          fail(`${fieldPath}[${i}]`, `must be a finite number, got ${describe(entry)}`)
          entries.push(0)
        } else if (entry < field.range[0] || entry > field.range[1]) {
          fail(`${fieldPath}[${i}]`, `must be between ${field.range[0]} and ${field.range[1]}, got ${entry}`)
          entries.push(0)
        } else {
          entries.push(entry)
        }
      }
      normalised[key] = entries
    } else if (field.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        fail(fieldPath, 'must be an object')
        continue
      }
      for (const nestedKey of Object.keys(value)) {
        if (field.fields[nestedKey] === undefined) {
          fail(`${fieldPath}.${nestedKey}`, `unknown field; valid: ${Object.keys(field.fields).join(', ')}`)
        }
      }
      const nested = {}
      readFields(value, field.fields, fieldPath, fail, nested)
      normalised[key] = nested
    }
  }
}

/** Format one collected problem for a thrown error. */
function formatErrors (errors) {
  const shown = errors.slice(0, 6).map((error) => `${error.path}: ${error.message}`)
  const rest = errors.length - shown.length
  return `invalid graph: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more problem${rest === 1 ? '' : 's'}` : ''}`
}

/** An Error that carries the structured validation errors on `.errors`. */
function graphError (errors) {
  const error = new Error(formatErrors(errors))
  error.errors = errors
  return error
}

/**
 * Validate a graph and, when it is valid, compile it into a render plan.
 *
 * @param {unknown} spec - the graph document.
 * @param {object} [options] - render settings the budgets depend on.
 * @param {number} [options.duration] - seconds, 0.008..30; default 1.
 * @param {number} [options.sampleRate] - Hz, 8000..96000; default 44100.
 * @param {number} [options.seed] - any finite number; default 1.
 * @returns {{ ok: boolean, errors: { path: string, message: string }[], plan: object|null }}
 */
function compileGraph (spec, options = {}) {
  const errors = []
  let overflowed = false
  const fail = (path, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ path, message })
    else if (!overflowed) {
      overflowed = true
      errors.push({ path: '', message: `and further problems were omitted after the first ${MAX_ERRORS}` })
    }
  }

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('graph', 'must be an object with a nodes array, e.g. { nodes: [ { type: "osc", hz: 440 } ] }')
    return { ok: false, errors, plan: null }
  }
  for (const key of Object.keys(spec)) {
    if (key === 'nodes' || key === 'output') continue
    if (key === 'duration' || key === 'seed' || key === 'sampleRate') {
      fail(key, `"${key}" is a render argument, not part of the graph; pass it next to the graph, not inside it`)
    } else {
      fail(key, 'unknown graph field; a graph has only nodes and output')
    }
  }
  const rawNodes = spec.nodes
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    fail('nodes', 'must be a non-empty array of node objects')
    return { ok: false, errors, plan: null }
  }
  // The budget check comes before any per-node work so a 10 000-node document
  // is rejected in constant time, not walked once per node.
  if (rawNodes.length > MAX_NODES) {
    fail('nodes', `node count ${rawNodes.length} exceeds the ${MAX_NODES}-node budget; build the sound from fewer nodes or layer it with audio_design`)
    return { ok: false, errors, plan: null }
  }

  const settings = options !== null && typeof options === 'object' ? options : {}
  let duration = settings.duration
  if (duration === undefined || duration === null) duration = DEFAULT_DURATION
  const durationValid = Number.isFinite(duration) && duration >= MIN_DURATION && duration <= MAX_DURATION
  if (!durationValid) {
    fail('duration', `must be a finite number of seconds between ${MIN_DURATION} and ${MAX_DURATION}, got ${describe(duration)}`)
  }
  let sampleRate = settings.sampleRate
  if (sampleRate === undefined || sampleRate === null) sampleRate = DEFAULT_SAMPLE_RATE
  if (!Number.isFinite(sampleRate) || Math.round(sampleRate) < MIN_SAMPLE_RATE || Math.round(sampleRate) > MAX_SAMPLE_RATE) {
    fail('sampleRate', `must be a finite number of Hz between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE}, got ${describe(sampleRate)}`)
  }
  const seed = Number.isFinite(settings.seed) ? Math.round(settings.seed) : 1
  const sampleRateValid = Number.isFinite(sampleRate) && Math.round(sampleRate) >= MIN_SAMPLE_RATE && Math.round(sampleRate) <= MAX_SAMPLE_RATE
  // Frequencies above the render's Nyquist cannot be represented; catching that
  // here is the difference between an error and silent aliasing. When the
  // sample rate itself is the bad value, skip these: the same mistake would
  // otherwise be reported once per node as a consequence of it.
  const maxRenderHz = sampleRateValid ? Math.min(MAX_HZ, Math.round(sampleRate) * 0.45) : MAX_HZ
  const nyquistHz = sampleRateValid ? Math.round(sampleRate) * 0.5 : MAX_HZ

  /* ---- pass 1: node shape, ids, fields ---- */

  const nodes = []
  const ids = new Map()
  const pendingModulators = []

  for (let index = 0; index < rawNodes.length; index += 1) {
    const raw = rawNodes[index]
    const path = `nodes[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(path, 'must be a node object with a type')
      nodes.push(null)
      continue
    }
    const type = raw.type
    if (typeof type !== 'string' || !NODE_TYPES.includes(type)) {
      fail(`${path}.type`, `unknown node type ${describe(type)}; a type is one of ${NODE_TYPES.join(', ')}`)
      nodes.push(null)
      continue
    }
    const schema = GRAPH_SCHEMA.nodes[type]
    const fields = schema.fields
    let id
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(raw.id)) {
        fail(`${path}.id`, 'must be a letter followed by up to 31 letters, digits, "_" or "-"')
      } else {
        id = raw.id
      }
    }
    if (id === undefined) id = `n${index}`
    if (ids.has(id)) {
      fail(`${path}.id`, `duplicate node id ${describe(id)} (already used by node ${ids.get(id)}; auto ids are "n<index>")`)
    } else {
      ids.set(id, index)
    }

    // Unknown fields are rejected, not ignored: a model that writes `freq`
    // instead of `hz` should be told, because a silently dropped field renders
    // a wrong sound that still "works".
    const allowed = new Set(COMMON_FIELDS)
    allowed.add('input')
    allowed.add('lfo')
    for (const key of Object.keys(fields)) allowed.add(key)
    const usesInput = PROCESSOR_TYPES.includes(type)
    for (const key of Object.keys(raw)) {
      if (allowed.has(key)) continue
      fail(`${path}.${key}`, `unknown field for node type "${type}"; valid: ${[...allowed].join(', ')}`)
    }

    const node = { index, id, type, path, inputIndex: -1, inputIndices: null, modulator: null }
    readFields(raw, fields, path, fail, node)
    if (sampleRateValid && node.fm !== undefined) {
      // A modulator rate above Nyquist is meaningless and would only alias.
      if (node.fm.hz > nyquistHz) fail(`${path}.fm.hz`, `must be at or below Nyquist (${nyquistHz} Hz) for this sample rate`)
    }
    if (sampleRateValid && node.hz !== undefined && node.hz > maxRenderHz) {
      fail(`${path}.hz`, `must be at or below 0.45 x sampleRate (${maxRenderHz} Hz), got ${node.hz}`)
    }
    if (sampleRateValid && type === 'filter' && node.sweepTo !== undefined && node.sweepTo > maxRenderHz) {
      fail(`${path}.sweepTo`, `must be at or below 0.45 x sampleRate (${maxRenderHz} Hz), got ${node.sweepTo}`)
    }
    if (sampleRateValid && type === 'ring' && node.hz > nyquistHz) {
      fail(`${path}.hz`, `must be at or below Nyquist (${nyquistHz} Hz) for this sample rate`)
    }

    if (usesInput) {
      if (raw.input === undefined || raw.input === null) fail(`${path}.input`, 'is required: this node processes another node\'s output')
      else node.inputRef = raw.input
    } else if (raw.input !== undefined && raw.input !== null) {
      fail(`${path}.input`, `${type} takes no input; sources start a chain and sum takes inputs`)
    }

    if (type === 'sum') {
      if (node.gains !== undefined && node.inputs !== undefined && node.gains.length !== node.inputs.length) {
        fail(`${path}.gains`, `needs the same number of entries as inputs (${node.inputs.length}), got ${node.gains.length}`)
      }
      node.inputRefs = node.inputs ?? []
    }

    if (raw.lfo !== undefined && raw.lfo !== null) {
      if (typeof raw.lfo !== 'object' || Array.isArray(raw.lfo)) {
        fail(`${path}.lfo`, 'must be an object like { hz: 5, depth: 0.1, target: "pitch" }')
      } else {
        for (const key of Object.keys(raw.lfo)) {
          if (INLINE_LFO_FIELDS[key] === undefined) fail(`${path}.lfo.${key}`, `unknown lfo field; valid: ${Object.keys(INLINE_LFO_FIELDS).join(', ')}`)
        }
        const modulator = {}
        readFields(raw.lfo, INLINE_LFO_FIELDS, `${path}.lfo`, fail, modulator)
        const target = modulator.target ?? defaultTargetFor(type)
        if (!acceptsTarget(type, target)) {
          fail(`${path}.lfo.target`, `"${target}" does not apply to a ${type} node`)
        } else {
          pendingModulators.push({ target: index, modulator: { hz: modulator.hz, depth: modulator.depth, target }, path: `${path}.lfo` })
        }
      }
    }

    if (type === 'lfo') node.toRef = raw.to
    nodes.push(node)
  }

  // The noise buffers are the one allocation whose size is not bounded by the
  // timeline alone, so they get their own budget rather than an out-of-memory
  // crash part-way through a render.
  if (durationValid && sampleRateValid) {
    const frames = Math.max(1, Math.round(duration * Math.round(sampleRate)))
    const noiseNodes = nodes.reduce((count, node) => count + (node !== null && node.type === 'noise' ? 1 : 0), 0)
    const bytes = noiseNodes * frames * 4
    if (bytes > NOISE_BUFFER_BUDGET) {
      const megabytes = (bytes / 1024 / 1024).toFixed(0)
      const budget = (NOISE_BUFFER_BUDGET / 1024 / 1024).toFixed(0)
      fail('nodes', `${noiseNodes} noise nodes over ${Number(duration.toFixed(3))} s at ${Math.round(sampleRate)} Hz need ${megabytes} MB of noise buffers; the budget is ${budget} MB — use fewer noise nodes, or a shorter or lower-rate render`)
    }
  }

  /* ---- pass 2: references, cycles, output ---- */

  const resolveRef = (ref, path) => {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= nodes.length) {
        fail(path, `must be a node index between 0 and ${nodes.length - 1}, got ${ref}`)
        return -1
      }
      if (nodes[ref] === null) return -1
      return ref
    }
    if (typeof ref === 'string') {
      const found = ids.get(ref)
      if (found === undefined) {
        const known = [...ids.keys()].slice(0, 10).join(', ')
        fail(path, `unknown node reference ${describe(ref)}; known ids: ${known}${ids.size > 10 ? ', ...' : ''}`)
        return -1
      }
      return found
    }
    fail(path, `must be a node id or 0-based index, got ${describe(ref)}`)
    return -1
  }

  const requireAudio = (target, path) => {
    if (target < 0) return -1
    const node = nodes[target]
    if (node === null) return -1
    if (node.type === 'lfo') {
      fail(path, `node ${describe(node.id)} is an lfo modulator and produces no audio`)
      return -1
    }
    return target
  }

  for (const node of nodes) {
    if (node === null) continue
    if (node.inputRef !== undefined) {
      const target = requireAudio(resolveRef(node.inputRef, `${node.path}.input`), `${node.path}.input`)
      node.inputIndex = target
      node.children = target >= 0 ? [{ index: target, path: `${node.path}.input` }] : []
    } else if (node.type === 'sum') {
      const children = []
      for (let i = 0; i < node.inputRefs.length; i += 1) {
        const path = `${node.path}.inputs[${i}]`
        const target = requireAudio(resolveRef(node.inputRefs[i], path), path)
        if (target >= 0) children.push({ index: target, path })
      }
      node.inputIndices = children.map((child) => child.index)
      node.children = children
    } else {
      node.children = []
    }
  }

  // A cycle in a sum (or any chain) would make the topological render order
  // infinite; report the edge that closes the loop, with the chain in the
  // message so the model sees which nodes to break.
  const colour = new Uint8Array(nodes.length)
  const stack = []
  const walk = (index) => {
    colour[index] = 1
    stack.push(index)
    for (const child of nodes[index].children) {
      if (colour[child.index] === 1) {
        const at = stack.indexOf(child.index)
        const chain = stack.slice(at).concat([child.index]).map((i) => nodes[i].id).join(' -> ')
        fail(child.path, `cycle: ${chain}`)
      } else if (colour[child.index] === 0) {
        walk(child.index)
      }
    }
    stack.pop()
    colour[index] = 2
  }
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i] !== null && colour[i] === 0) walk(i)
  }

  // LFO nodes attach to their target; a target can carry one modulator, and
  // two attachments is a modelling mistake worth naming rather than summing.
  for (const node of nodes) {
    if (node === null || node.type !== 'lfo') continue
    const target = resolveRef(node.toRef, `${node.path}.to`)
    if (target < 0) continue
    const targetNode = nodes[target]
    if (targetNode === null) continue
    if (targetNode.type === 'lfo') {
      fail(`${node.path}.to`, 'cannot modulate another lfo; modulate an audio node')
      continue
    }
    const modulatorTarget = node.target ?? defaultTargetFor(targetNode.type)
    if (!acceptsTarget(targetNode.type, modulatorTarget)) {
      fail(`${node.path}.target`, `"${modulatorTarget}" does not apply to ${describe(targetNode.id)} (${targetNode.type})`)
      continue
    }
    node.attachedTo = target
    pendingModulators.push({ target, modulator: { hz: node.hz, depth: node.depth, target: modulatorTarget }, path: node.path })
  }
  for (const pending of pendingModulators) {
    const targetNode = nodes[pending.target]
    if (targetNode === null) continue
    if (targetNode.modulator !== null) {
      fail(pending.path, `node ${describe(targetNode.id)} already has an lfo; merge them or modulate different nodes`)
      continue
    }
    targetNode.modulator = pending.modulator
  }

  // The output: an explicit reference, else the last audio node, which is the
  // node the model usually writes last (usually the reverb send).
  let output = -1
  if (spec.output !== undefined && spec.output !== null) {
    output = requireAudio(resolveRef(spec.output, 'output'), 'output')
  } else {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (nodes[i] !== null && nodes[i].type !== 'lfo') { output = i; break }
    }
    // Only worth reporting when nothing else already failed: after a bad node
    // type there is no audio node left, and that is a consequence, not a second
    // mistake to fix.
    if (output < 0 && errors.length === 0) fail('nodes', 'has no audio node to render; every node is an lfo')
  }

  if (errors.length > 0) return { ok: false, errors, plan: null }

  /* ---- render order: post-order from the output ---- */

  const order = []
  const seen = new Uint8Array(nodes.length)
  const visit = (index) => {
    if (seen[index] === 1) return
    seen[index] = 1
    for (const child of nodes[index].children) visit(child.index)
    order.push(index)
  }
  visit(output)

  return {
    ok: true,
    errors: [],
    plan: {
      nodes,
      order,
      output,
      nodeCount: nodes.length,
      duration,
      sampleRate: Math.round(sampleRate),
      seed
    }
  }
}

/**
 * Validate a graph document without rendering or allocating audio buffers.
 *
 * @param {unknown} spec - the graph, e.g. `{ nodes: [{ type: 'osc', hz: 440 }, { type: 'env', input: 0 }] }`.
 * @param {object} [options] - render settings the range and budget checks use.
 * @param {number} [options.duration] - seconds, 0.008..30; default 1.
 * @param {number} [options.sampleRate] - Hz, 8000..96000; default 44100.
 * @param {number} [options.seed] - accepted but irrelevant to validity.
 * @returns {{ ok: boolean, errors: { path: string, message: string }[] }} the verdict; `path` is a document path such as `nodes[2].hz`.
 */
export function validateGraph (spec, options = {}) {
  const compiled = compileGraph(spec, options)
  return { ok: compiled.ok, errors: compiled.errors }
}

/* ------------------------------------------------------------ rendering -- */

/** One reusable block buffer per reachable node, plus per-node DSP state. */
function makeRuntime (plan, sampleRate) {
  const { nodes } = plan
  const state = nodes.map(() => null)
  for (const index of plan.order) {
    const node = nodes[index]
    const entry = {
      buffer: new Float32Array(BLOCK),
      phase: node.phase ?? 0,
      ic1: 0,
      ic2: 0,
      reverb: null,
      envelope: null,
      gain: 1,
      driveKind: node.kind ?? 'soft',
      driveAmount: node.amount ?? 0,
      sumGains: null
    }
    if (node.type === 'env') {
      const curve = node.curve ?? 1
      const k = curve * 4
      const e = Math.exp(-k)
      entry.envelope = {
        attack: node.attack ?? 0.005,
        decay: node.decay ?? 0.2,
        sustain: node.sustain ?? 0,
        release: node.release ?? 0.05,
        invCurve: 1 / curve,
        k,
        e,
        oneMinusE: 1 - e
      }
    }
    if (node.type === 'gain') entry.gain = dbToGain(node.db ?? 0)
    if (node.type === 'pan') {
      const angle = ((node.pan ?? 0) + 1) * Math.PI / 4
      entry.gain = (Math.cos(angle) + Math.sin(angle)) / Math.SQRT2
    }
    if (node.type === 'sum') {
      const gains = node.gains
      entry.sumGains = gains === undefined ? null : gains.map((db) => dbToGain(db))
    }
    if (node.type === 'reverb') entry.reverb = new BlockReverb(sampleRate, node.size ?? 0.5)
    state[index] = entry
  }
  return state
}

/** Amplitude multiplier from an amp-target LFO at time t. */
function ampAt (modulator, t) {
  return 1 - modulator.depth * 0.5 + modulator.depth * 0.5 * Math.sin(TAU * modulator.hz * t)
}

/** ADSR level at time t for the constants in `envelope`. */
function envelopeAt (envelope, t, duration) {
  const { attack, decay, sustain, release } = envelope
  let level
  if (attack > 0 && t < attack) {
    level = Math.pow(t / attack, envelope.invCurve)
  } else if (decay > 0 && t < attack + decay) {
    const progress = (t - attack) / decay
    level = sustain + (1 - sustain) * ((Math.exp(-envelope.k * progress) - envelope.e) / envelope.oneMinusE)
  } else {
    level = sustain
  }
  if (release > 0 && t > duration - release) level *= Math.max(0, (duration - t) / release)
  return level < 0 ? 0 : level
}

/** Render one node's block into its own buffer. */
function renderBlock (plan, state, sources, index, start, length) {
  const node = plan.nodes[index]
  const out = state[index].buffer
  const sampleRate = plan.sampleRate
  const modulator = node.modulator
  const ampModulator = modulator !== null && modulator.target === 'amp' ? modulator : null

  if (node.type === 'osc') {
    const pitchModulator = modulator !== null && modulator.target === 'pitch' ? modulator : null
    const fm = node.fm
    const ratio = Math.pow(2, (node.detuneCents ?? 0) / 1200)
    let phase = state[index].phase
    const maxHz = sampleRate * 0.49
    for (let i = 0; i < length; i += 1) {
      const t = (start + i) / sampleRate
      let hz = node.hz * ratio
      if (fm !== undefined) {
        const depth = fm.decay === undefined ? fm.depth : fm.depth * Math.exp(-t / fm.decay)
        hz += depth * Math.sin(TAU * fm.hz * t)
      }
      if (pitchModulator !== null) hz *= 1 + pitchModulator.depth * Math.sin(TAU * pitchModulator.hz * t)
      // FM must be allowed to swing through zero: a negative instantaneous
      // frequency is the phase running backwards, and it is exactly that
      // excursion which puts a sideband *below* the carrier. Clamping at 0 here
      // (the obvious clamp) folds the waveform and all but erases the pair, so
      // only the magnitude is bounded.
      hz = clamp(hz, -maxHz, maxHz)
      const dt = hz / sampleRate
      phase += dt
      phase -= Math.floor(phase)
      let value = waveAt(node.wave ?? 'sine', phase, Math.abs(dt))
      if (ampModulator !== null) value *= ampAt(ampModulator, t)
      out[i] = value
    }
    state[index].phase = phase
    return
  }

  if (node.type === 'noise') {
    const source = sources.get(index)
    for (let i = 0; i < length; i += 1) {
      let value = source[start + i]
      if (ampModulator !== null) value *= ampAt(ampModulator, (start + i) / sampleRate)
      out[i] = value
    }
    return
  }

  if (node.type === 'filter') {
    const input = state[node.inputIndex].buffer
    const filterModulator = modulator !== null && modulator.target === 'filter' ? modulator : null
    const isStatic = node.sweepTo === undefined && filterModulator === null
    let ic1 = state[index].ic1
    let ic2 = state[index].ic2
    const q = Math.max(node.q ?? 0.8, 0.15)
    let g = 0
    let k = 0
    let a1 = 0
    let a2 = 0
    let a3 = 0
    if (isStatic) {
      const fc = clamp(node.hz, 20, sampleRate * 0.45)
      g = Math.tan(Math.PI * fc / sampleRate)
      k = 1 / q
      a1 = 1 / (1 + g * (g + k))
      a2 = g * a1
      a3 = g * a2
    }
    for (let i = 0; i < length; i += 1) {
      const t = (start + i) / sampleRate
      if (!isStatic) {
        let cutoff = node.hz
        if (node.sweepTo !== undefined) {
          const progress = Math.min(1, t / (node.sweepTime ?? 1))
          cutoff *= Math.pow(node.sweepTo / node.hz, progress)
        }
        if (filterModulator !== null) cutoff *= 1 + filterModulator.depth * Math.sin(TAU * filterModulator.hz * t)
        const fc = clamp(cutoff, 20, sampleRate * 0.45)
        g = Math.tan(Math.PI * fc / sampleRate)
        k = 1 / q
        a1 = 1 / (1 + g * (g + k))
        a2 = g * a1
        a3 = g * a2
      }
      const sample = input[i]
      const v3 = sample - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      let value = node.mode === 'bp' ? v1 : node.mode === 'hp' ? sample - k * v1 - v2 : v2
      if (ampModulator !== null) value *= ampAt(ampModulator, t)
      out[i] = value
    }
    state[index].ic1 = ic1
    state[index].ic2 = ic2
    return
  }

  if (node.type === 'env') {
    const input = state[node.inputIndex].buffer
    const envelope = state[index].envelope
    for (let i = 0; i < length; i += 1) out[i] = input[i] * envelopeAt(envelope, (start + i) / sampleRate, plan.duration)
    return
  }

  if (node.type === 'gain' || node.type === 'pan') {
    const input = state[node.inputIndex].buffer
    const gain = state[index].gain
    for (let i = 0; i < length; i += 1) {
      let value = input[i] * gain
      if (ampModulator !== null) value *= ampAt(ampModulator, (start + i) / sampleRate)
      out[i] = value
    }
    return
  }

  if (node.type === 'drive') {
    const input = state[node.inputIndex].buffer
    const amount = state[index].driveAmount
    const kind = state[index].driveKind
    for (let i = 0; i < length; i += 1) {
      let value = driveShape(input[i], amount, kind)
      if (ampModulator !== null) value *= ampAt(ampModulator, (start + i) / sampleRate)
      out[i] = value
    }
    return
  }

  if (node.type === 'ring') {
    const input = state[node.inputIndex].buffer
    const depth = node.depth ?? 1
    for (let i = 0; i < length; i += 1) {
      const t = (start + i) / sampleRate
      let value = input[i] * ((1 - depth) + depth * Math.sin(TAU * node.hz * t))
      if (ampModulator !== null) value *= ampAt(ampModulator, t)
      out[i] = value
    }
    return
  }

  if (node.type === 'reverb') {
    const input = state[node.inputIndex].buffer
    state[index].reverb.process(input, out, length, node.amount ?? 0.3)
    if (ampModulator !== null) {
      for (let i = 0; i < length; i += 1) out[i] *= ampAt(ampModulator, (start + i) / sampleRate)
    }
    return
  }

  // sum: zero the block, then add each branch. The stale tail past `length` is
  // never read: every consumer only looks at the frames it asked for.
  out.fill(0, 0, length)
  const gains = state[index].sumGains
  for (let branch = 0; branch < node.inputIndices.length; branch += 1) {
    const gain = gains === null ? 1 : gains[branch]
    addInto(out, state[node.inputIndices[branch]].buffer, 0, gain)
  }
  if (ampModulator !== null) {
    for (let i = 0; i < length; i += 1) out[i] *= ampAt(ampModulator, (start + i) / sampleRate)
  }
}

/**
 * Render a synthesis graph to mono samples.
 *
 * @param {object} spec - the graph document (see GRAPH_SCHEMA).
 * @param {object} [options]
 * @param {number} [options.sampleRate] - Hz, 8000..96000; default 44100.
 * @param {number} [options.duration] - seconds, 0.008..30; default 1.
 * @param {number} [options.seed] - variation seed; only noise nodes are random.
 * @returns {{ samples: Float32Array, sampleRate: number, durationSeconds: number, report: { nodeCount: number, peakDbfs: number, rmsDbfs: number, centroidHz: number } }}
 * @throws {Error} when the graph is invalid; `.errors` carries `{ path, message }[]`.
 */
export function renderGraph (spec, options = {}) {
  const compiled = compileGraph(spec, options)
  if (!compiled.ok) throw graphError(compiled.errors)
  const plan = compiled.plan
  const { nodes, order, output, sampleRate, duration, seed } = plan
  const frames = Math.max(1, Math.round(duration * sampleRate))

  // Noise is generated whole-buffer by the dsp kernel: its pink/brown colouring
  // is a recursive filter, and restarting it every 128 frames would put a seam
  // in the bed every 2.9 ms. One buffer per noise node also lets the band-pass
  // be a single dsp.filter call instead of a stateful filter in the hot loop.
  const sources = new Map()
  for (const index of order) {
    const node = nodes[index]
    if (node.type !== 'noise') continue
    const rand = makeRng((seed ^ Math.imul(index + 1, 0x85EBCA6B)) >>> 0)
    const raw = dspNoise(frames, rand, node.color ?? 'white', sampleRate)
    sources.set(index, node.hz === undefined ? raw : dspFilter(raw, sampleRate, () => node.hz, () => node.q ?? 1.2, 'bp'))
  }

  const state = makeRuntime(plan, sampleRate)
  const master = new Float32Array(frames)
  for (let start = 0; start < frames; start += BLOCK) {
    const length = Math.min(BLOCK, frames - start)
    for (let i = 0; i < order.length; i += 1) renderBlock(plan, state, sources, order[i], start, length)
    // addInto clamps to the destination length, so the last block's unused tail
    // cannot write past the end of the render.
    addInto(master, state[output].buffer, start, 1)
  }
  sources.clear()

  // Every file this plugin writes ends with a short fade; a graph cut mid-cycle
  // clicks, and a one-shot is the only thing a graph renders today.
  const fade = Math.min(Math.round(GUARD_FADE_SECONDS * sampleRate), Math.floor(frames / 8))
  for (let i = 0; i < fade; i += 1) master[frames - 1 - i] *= i / fade

  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < frames; i += 1) {
    const value = master[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    sumSquares += value * value
  }
  const rms = Math.sqrt(sumSquares / frames)

  return {
    samples: master,
    sampleRate,
    durationSeconds: frames / sampleRate,
    report: {
      nodeCount: nodes.length,
      peakDbfs: round(amplitudeDb(peak), 2),
      rmsDbfs: round(amplitudeDb(rms), 2),
      centroidHz: spectralCentroid(master, sampleRate)
    }
  }
}

/* -------------------------------------------------------------- catalog -- */

/**
 * Worked examples, and the answer to "what does this DSL actually sound like".
 *
 * Each entry is a complete graph tuned as a sound, not a variation on one: the
 * bell's FM ratio is inharmonic, the clang's partials are deliberately off the
 * harmonic series, the wind is a band-passed noise bed with a slow filter LFO,
 * and the drone folds a detuned pair. They double as documentation because the
 * fastest way for a model to learn the DSL is to read one that works.
 */
const CATALOG = Object.freeze({
  'metal-clang': {
    description: 'Struck metal: an inharmonic partial stack, a bright noise strike, high-pass, light drive and a medium room.',
    duration: 1.6,
    seed: 1,
    graph: {
      nodes: [
        { type: 'osc', wave: 'sine', hz: 311.13 },
        { type: 'env', input: 0, attack: 0.001, decay: 0.72, sustain: 0, release: 0.1 },
        { type: 'gain', input: 1, db: -2 },
        { type: 'osc', wave: 'sine', hz: 858.72 },
        { type: 'env', input: 3, attack: 0.001, decay: 0.42, sustain: 0, release: 0.08 },
        { type: 'gain', input: 4, db: -6 },
        { type: 'osc', wave: 'sine', hz: 1680.1 },
        { type: 'env', input: 6, attack: 0.001, decay: 0.24, sustain: 0, release: 0.06 },
        { type: 'gain', input: 7, db: -9 },
        { type: 'noise', color: 'white', hz: 3400, q: 2.4 },
        { type: 'env', input: 9, attack: 0.0005, decay: 0.09, sustain: 0, release: 0.03 },
        { type: 'gain', input: 10, db: -12 },
        { type: 'sum', inputs: [2, 5, 8, 11] },
        { type: 'filter', input: 12, mode: 'hp', hz: 300, q: 0.7 },
        { type: 'drive', input: 13, amount: 0.45, kind: 'soft' },
        { type: 'reverb', input: 14, amount: 0.28, size: 0.5 }
      ]
    }
  },
  'glassy-pluck': {
    description: 'Plucked glass: two high triangle/sine partials plus a tick of band-passed noise, driven a little and sent to a large bright room.',
    duration: 1.2,
    seed: 2,
    graph: {
      nodes: [
        { type: 'osc', wave: 'triangle', hz: 1318.5 },
        { type: 'env', input: 0, attack: 0.001, decay: 0.28, sustain: 0, release: 0.06 },
        { type: 'gain', input: 1, db: 0 },
        { type: 'osc', wave: 'sine', hz: 2637 },
        { type: 'env', input: 3, attack: 0.0005, decay: 0.16, sustain: 0, release: 0.05 },
        { type: 'gain', input: 4, db: -10 },
        { type: 'noise', color: 'white', hz: 6000, q: 1.2 },
        { type: 'env', input: 6, attack: 0.0005, decay: 0.03, sustain: 0, release: 0.02 },
        { type: 'gain', input: 7, db: -16 },
        { type: 'sum', inputs: [2, 5, 8] },
        { type: 'filter', input: 9, mode: 'hp', hz: 900, q: 0.7 },
        { type: 'drive', input: 10, amount: 0.18, kind: 'soft' },
        { type: 'reverb', input: 11, amount: 0.4, size: 0.6 }
      ]
    }
  },
  'hollow-wind': {
    description: 'Hollow wind: a pink-noise bed through a resonant band-pass that sweeps upward while a slow filter LFO breathes through it.',
    duration: 3.5,
    seed: 3,
    graph: {
      nodes: [
        { type: 'noise', color: 'pink', hz: 700, q: 1.1 },
        { type: 'filter', input: 0, mode: 'bp', hz: 320, q: 2.4, sweepTo: 1500, sweepTime: 2.2 },
        { type: 'lfo', to: 1, hz: 0.17, depth: 0.25, target: 'filter' },
        { type: 'env', input: 1, attack: 1.1, decay: 2.4, sustain: 0.55, release: 0.8 },
        { type: 'gain', input: 3, db: 0 },
        { type: 'reverb', input: 4, amount: 0.5, size: 0.75 }
      ]
    }
  },
  'fm-bell': {
    description: 'FM bell: a sine carrier with an inharmonic modulator whose index decays, so the strike is bright and the tail is pure; a noise tick and a large room finish it.',
    duration: 2,
    seed: 4,
    graph: {
      nodes: [
        { type: 'osc', wave: 'sine', hz: 523.25, fm: { hz: 1831.4, depth: 620, decay: 0.3 } },
        { type: 'env', input: 0, attack: 0.002, decay: 1.4, sustain: 0, release: 0.2 },
        { type: 'gain', input: 1, db: -2 },
        { type: 'noise', color: 'white', hz: 5200, q: 1.5 },
        { type: 'env', input: 3, attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
        { type: 'gain', input: 4, db: -19 },
        { type: 'sum', inputs: [2, 5] },
        { type: 'reverb', input: 6, amount: 0.35, size: 0.55 }
      ]
    }
  },
  'folded-drone': {
    description: 'Folded drone: two saws nine cents apart beat against each other, a wavefolder turns the beating into moving partials, and a slow filter LFO opens the tone.',
    duration: 2.5,
    seed: 5,
    graph: {
      nodes: [
        { type: 'osc', wave: 'saw', hz: 55 },
        { type: 'osc', wave: 'saw', hz: 55, detuneCents: 9 },
        { type: 'sum', inputs: [0, 1], gains: [-3, -3] },
        { type: 'drive', input: 2, amount: 0.6, kind: 'fold' },
        { type: 'filter', input: 3, mode: 'lp', hz: 1100, q: 1.1 },
        { type: 'lfo', to: 4, hz: 0.35, depth: 0.35, target: 'filter' },
        { type: 'env', input: 4, attack: 0.4, decay: 3, sustain: 0.7, release: 1.2 },
        { type: 'reverb', input: 6, amount: 0.3, size: 0.6 }
      ]
    }
  }
})

/**
 * The example graphs, as documentation and as ready-made starting points.
 * @returns {{ id: string, description: string, duration: number, seed: number, graph: object, nodeCount: number }[]} deep copies, so a caller cannot mutate the catalog.
 */
export function graphCatalog () {
  return Object.keys(CATALOG).map((id) => {
    const entry = CATALOG[id]
    return {
      id,
      description: entry.description,
      duration: entry.duration,
      seed: entry.seed,
      nodeCount: entry.graph.nodes.length,
      graph: JSON.parse(JSON.stringify(entry.graph))
    }
  })
}
