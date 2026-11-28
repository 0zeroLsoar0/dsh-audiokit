/**
 * The sampled tier: the user's own recording, played as an instrument.
 *
 * Everything else in this plugin synthesizes, which is why every sound it ships
 * is code and none of it has a licence attached. A sampler is the other half of
 * a sound toolkit — the kick, the pluck, the breath, the held pad the user
 * recorded themselves — and it is the half that normally arrives as a 20 MB
 * bank plus a licence question. There is deliberately no bank here: the caller
 * points at a file they already own, and this module pitches it, envelopes it,
 * loops it, layers it by velocity and sums it.
 *
 * Two consequences are stated up front rather than discovered later:
 *
 *   - Pitch and time are coupled. Playback is interpolated resampling, so a note
 *     an octave above the root plays twice as fast. That is what a sampler
 *     traditionally does (a tape-mellotron, an MPC pad, a tracker sample); a tier
 *     that decouples them is `lib/stretch.js`, and this one does not secretly
 *     reimplement it. `audio_stretch` is the answer when duration must stay put.
 *   - The module is synchronous. Loading a zone reads its file with
 *     `readFileSync`, because `buildKeymap` and `renderSampler` are plain
 *     expressions at the tool layer and in tests, and a sampler that has to be
 *     awaited once per chord is a worse interface than the few milliseconds a
 *     short wav read costs. `SAMPLER_LIMITS` names the caps that keep one request
 *     from reading or allocating an unreasonable amount.
 *
 * Zone selection is layered the way a sampler expects: key range and velocity
 * range choose the layer, then a deterministic round-robin cycles sibling takes
 * within that layer (same seeds = same bytes, always).
 *
 * Signal path, in the order it happens for one note:
 *
 *   zone + note -> pitch ratio -> interpolated read (loop-aware) -> ADSR applied
 *   to the *pitched* buffer -> velocity and zone gain -> sum into the master ->
 *   softLimit once at the end.
 *
 * The ADSR runs after the read on purpose: an attack applied to the source would
 * smear the recording's own transient, while an attack applied to the played-out
 * note shapes it without moving it.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { clamp, dbToGain, softLimit } from './dsp.js'
import { decodeWav } from './wav.js'

/** Caps that keep one request from reading or allocating an unreasonable amount. */
export const SAMPLER_LIMITS = Object.freeze({
  maxZones: 128,
  maxNotes: 4096,
  maxSeconds: 180,
  minLoopSeconds: 0.01,
  loopCrossfadeSeconds: 0.01,
  maxTuneCents: 2400,
  maxGainDb: 24,
  minSampleRate: 8000,
  maxSampleRate: 96000
})

/** Default ADSR, in seconds (sustain is 0..1). */
export const DEFAULT_ENVELOPE = Object.freeze({ attack: 0.002, decay: 0, sustain: 1, release: 0.05 })

const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])
/** `samplerInfo` prints this many zone lines, then counts the rest. */
const INFO_ZONE_LINES = 24
/** Notes outside the keymap are listed in the report up to this many. */
const REPORT_UNMAPPED_LINES = 16
/** Per-note picks listed in the report: enough to see the round-robin order. */
const REPORT_PICKS = 32

function finiteOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round (value, digits = 2) {
  return Number(Number(value).toFixed(digits))
}

function describe (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Scientific pitch name of a MIDI note ("C4", "A#3"), for reports and text.
 * @param {number} midi - note number, 0..127.
 * @returns {string} note name.
 */
export function midiToName (midi) {
  const value = Math.round(Number(midi))
  if (!Number.isFinite(value)) return '?'
  const note = clamp(value, 0, 127)
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`
}

/* ------------------------------------------------------------- decoding -- */

/** Interpolated downmix, matching `readTrack` so a zone sounds the same as a track. */
function mixToMono (channels) {
  if (channels.length === 1) return channels[0]
  const frames = channels[0].length
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum / channels.length
  }
  return out
}

/** Linear resampler, used only to honour `loadSample({ sampleRate })`. */
function resample (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const frames = Math.max(1, Math.round(samples.length * toRate / fromRate))
  const out = new Float32Array(frames)
  const last = samples.length - 1
  for (let i = 0; i < frames; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[Math.min(index, last)] ?? 0
    const b = samples[Math.min(index + 1, last)] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/**
 * Load and decode one recording, as mono samples at a known rate.
 *
 * `source` is a `.wav` path, the file's bytes, or already-decoded samples
 * (`Float32Array`, or `{ samples, sampleRate }`). A relative path resolves
 * against `process.cwd()`; the tool layer resolves against the session directory
 * first, because that is what the caller means by "my file".
 *
 * Silence is rejected rather than returned: a silent zone is never what the
 * caller meant, and every downstream report (peak, fades, loop seam) would be a
 * meaningless number about nothing.
 *
 * @param {string|Buffer|Uint8Array|Float32Array|{ samples: Float32Array|Float32Array[], sampleRate: number }} source
 * @param {object} [options]
 * @param {number} [options.sampleRate] - resample to this rate (default: the file's own).
 * @param {string} [options.label] - name used in error messages for byte/sample input.
 * @returns {{ samples: Float32Array, sampleRate: number, durationSeconds: number, peakDbfs: number,
 *   channels: number, bytes: number, sourceSampleRate: number, label: string }} the loaded sample.
 */
export function loadSample (source, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const label = typeof source === 'string' ? source : (typeof settings.label === 'string' && settings.label !== '' ? settings.label : 'buffer')

  let samples
  let sampleRate
  let channels = 1
  let bytes = 0

  if (typeof source === 'string') {
    let file
    try {
      file = readFileSync(source)
    } catch (error) {
      throw new Error(`cannot read ${source}: ${error.code ?? error.message}`)
    }
    const decoded = decodeOrThrow(file, label)
    samples = mixToMono(decoded.channels)
    sampleRate = decoded.sampleRate
    channels = decoded.channels.length
    bytes = file.length
  } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const decoded = decodeOrThrow(source, label)
    samples = mixToMono(decoded.channels)
    sampleRate = decoded.sampleRate
    channels = decoded.channels.length
    bytes = source.length
  } else if (source instanceof Float32Array) {
    samples = source
    sampleRate = finiteOr(settings.sampleRate, 44100)
    bytes = samples.length * 2
  } else if (source !== null && typeof source === 'object' && (source.samples instanceof Float32Array || Array.isArray(source.samples))) {
    const input = source.samples instanceof Float32Array ? [source.samples] : source.samples
    if (input.length === 0) throw new Error(`sampler: ${label} has no channels`)
    samples = mixToMono(input)
    sampleRate = finiteOr(source.sampleRate, finiteOr(settings.sampleRate, 44100))
    channels = input.length
    bytes = samples.length * 2
  } else {
    throw new Error('sampler: loadSample needs a .wav path, wav bytes, or { samples, sampleRate }')
  }

  if (!(samples.length > 0)) throw new Error(`sampler: ${label} has no audio frames`)
  sampleRate = clamp(Math.round(sampleRate), SAMPLER_LIMITS.minSampleRate, SAMPLER_LIMITS.maxSampleRate)

  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }
  // 1e-6 is -120 dBFS: below the last bit of a 16-bit file, so this catches a
  // buffer of zeros and a file of dither, and nothing that is actually audible.
  if (!(peak > 1e-6)) {
    throw new Error(`sampler: ${label} is silent (peak below -120 dBFS); a sampler zone needs a recording with sound in it`)
  }

  const sourceSampleRate = sampleRate
  const requestedRate = settings.sampleRate === undefined || settings.sampleRate === null
    ? sampleRate
    : clamp(Math.round(finiteOr(settings.sampleRate, sampleRate)), SAMPLER_LIMITS.minSampleRate, SAMPLER_LIMITS.maxSampleRate)
  if (requestedRate !== sampleRate) {
    samples = resample(samples, sampleRate, requestedRate)
    sampleRate = requestedRate
  }

  return {
    samples,
    sampleRate,
    durationSeconds: samples.length / sampleRate,
    peakDbfs: round(20 * Math.log10(peak), 2),
    channels,
    bytes,
    sourceSampleRate,
    label
  }
}

function decodeOrThrow (bytes, label) {
  try {
    return decodeWav(bytes)
  } catch (error) {
    throw new Error(`cannot decode ${label}: ${error.message}`)
  }
}

/* --------------------------------------------------------------- keymap -- */

function readMidi (label, value, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`sampler: ${label} is required (the MIDI note the recording was played at, 0..127)`)
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 127) {
    throw new Error(`sampler: ${label} must be a MIDI note 0..127, got ${describe(value)}`)
  }
  return Math.round(number)
}

function velocityInBand (velocity, zone) {
  return velocity >= zone.velocityLo && (velocity < zone.velocityHi || zone.velocityHi >= 1)
}

/**
 * Resolve a zone's loop region, keeping room after `loopEnd` for the crossfade.
 *
 * The crossfade does not fade the tail into the head — that only works when the
 * loop length happens to be a period multiple. It starts the loop with the
 * material that naturally *follows* `loopEnd`, so the wrap is a continuation and
 * the fade then blends back to the true head. That needs a little audio past
 * `loopEnd`; when the caller's region sits too close to the end of the file, the
 * region is shortened (and the report says so) instead of producing a seam.
 * @returns {{ startSeconds: number, endSeconds: number, crossfadeSeconds: number, adjusted: boolean }}
 */
function resolveLoop (index, name, durationSeconds, spec, warnings) {
  let start
  let end
  if (spec.loop === true) {
    // Auto sustain loop: skip the attack, stop before the tail. Sensible for a
    // held pad; a caller who means something else passes loopStart/loopEnd.
    start = durationSeconds * 0.25
    end = durationSeconds * 0.95
  } else {
    if (spec.loopStart === undefined || spec.loopStart === null || spec.loopEnd === undefined || spec.loopEnd === null) {
      throw new Error(`sampler: zone ${index} (${name}) needs both loopStart and loopEnd (seconds), or loop: true for an auto sustain loop`)
    }
    start = finiteOr(spec.loopStart, NaN)
    end = finiteOr(spec.loopEnd, NaN)
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`sampler: zone ${index} (${name}) loopStart/loopEnd must be seconds, got ${describe(spec.loopStart)} and ${describe(spec.loopEnd)}`)
    }
  }
  if (!(start >= 0)) throw new Error(`sampler: zone ${index} (${name}) loopStart must be 0 or more, got ${start}`)
  if (!(end > start)) throw new Error(`sampler: zone ${index} (${name}) needs loopEnd > loopStart, got ${start}..${end}`)
  if (end > durationSeconds + 1e-6) {
    throw new Error(`sampler: zone ${index} (${name}) loopEnd ${round(end, 3)}s is past the end of the sample (${round(durationSeconds, 3)}s)`)
  }
  const minLoop = Math.min(SAMPLER_LIMITS.minLoopSeconds, durationSeconds / 4)
  if (end - start < minLoop) {
    throw new Error(`sampler: zone ${index} (${name}) loop is ${round(end - start, 4)}s long; a loop needs at least ${round(minLoop, 4)}s`)
  }
  const crossfade = Math.min(SAMPLER_LIMITS.loopCrossfadeSeconds, (end - start) / 4)
  const available = durationSeconds - end
  if (available < crossfade) {
    const trimmed = durationSeconds - crossfade
    if (trimmed - start < minLoop) {
      throw new Error(`sampler: zone ${index} (${name}) loopEnd is too close to the end of the sample: the ${round(crossfade * 1000, 1)} ms crossfade needs material after loopEnd. Move loopEnd or loopStart earlier, or use a longer recording.`)
    }
    warnings.push(`zone ${index} (${name}): loopEnd moved from ${round(end, 3)}s to ${round(trimmed, 3)}s so the crossfade has material to run into`)
    end = trimmed
  }
  return { startSeconds: start, endSeconds: end, crossfadeSeconds: crossfade }
}

/**
 * Validate a zone map and load every zone's audio.
 *
 * A zone is `{ path | buffer, rootMidi, lowMidi?, highMidi?, loopStart?,
 * loopEnd?, loop?, tuneCents?, gainDb?, velocityLo?, velocityHi?, name? }`.
 * `rootMidi` is the note the recording was played at; `lowMidi`/`highMidi`
 * default to it, so a single-note zone covers exactly one key. Two zones may
 * overlap in key range as long as their velocity bands do not overlap — that is
 * how velocity layers are built — and overlapping in both is reported because
 * the pick is then a rule rather than an intention.
 *
 * @param {object[]} zoneSpecs - zone map, at least one.
 * @returns {{ zones: object[], count: number, gaps: object[], overlaps: object[],
 *   lowMidi: number, highMidi: number, totalBytes: number, velocityLayers: number, warnings: string[] }}
 */
export function buildKeymap (zoneSpecs) {
  if (!Array.isArray(zoneSpecs) || zoneSpecs.length === 0) {
    throw new Error('sampler: buildKeymap needs at least one zone')
  }
  if (zoneSpecs.length > SAMPLER_LIMITS.maxZones) {
    throw new Error(`sampler: ${zoneSpecs.length} zones is more than the ${SAMPLER_LIMITS.maxZones} a keymap holds`)
  }

  const warnings = []
  const zones = []
  let totalBytes = 0

  for (let index = 0; index < zoneSpecs.length; index += 1) {
    const spec = zoneSpecs[index]
    if (spec === null || typeof spec !== 'object') {
      throw new Error(`sampler: zone ${index} must be an object, got ${describe(spec)}`)
    }
    const hasPath = typeof spec.path === 'string' && spec.path.trim() !== ''
    const hasBuffer = spec.buffer !== undefined && spec.buffer !== null
    if (hasPath === hasBuffer) {
      throw new Error(`sampler: zone ${index} needs exactly one of path or buffer`)
    }
    const name = typeof spec.name === 'string' && spec.name.trim() !== ''
      ? spec.name.trim()
      : (hasPath ? basename(spec.path.replace(/[\\/]+$/, '')) : `zone ${index}`)
    const source = hasPath ? spec.path.trim() : spec.buffer
    const loaded = loadSample(source, { label: name })
    const rootMidi = readMidi(`zone ${index} (${name}) rootMidi`, spec.rootMidi)
    const lowMidi = readMidi(`zone ${index} (${name}) lowMidi`, spec.lowMidi, rootMidi)
    const highMidi = readMidi(`zone ${index} (${name}) highMidi`, spec.highMidi, rootMidi)
    if (lowMidi > highMidi) {
      throw new Error(`sampler: zone ${index} (${name}) needs lowMidi <= highMidi, got ${lowMidi}..${highMidi}`)
    }
    const velocityLo = clamp(finiteOr(spec.velocityLo, 0), 0, 1)
    const velocityHi = clamp(finiteOr(spec.velocityHi, 1), 0, 1)
    if (!(velocityLo < velocityHi)) {
      throw new Error(`sampler: zone ${index} (${name}) needs velocityLo < velocityHi, got ${velocityLo}..${velocityHi}`)
    }
    const loop = spec.loop === true || spec.loopStart !== undefined || spec.loopEnd !== undefined
      ? resolveLoop(index, name, loaded.durationSeconds, spec, warnings)
      : null

    totalBytes += loaded.bytes
    zones.push({
      index,
      name,
      path: hasPath ? spec.path.trim() : undefined,
      samples: loaded.samples,
      sampleRate: loaded.sampleRate,
      durationSeconds: loaded.durationSeconds,
      peakDbfs: loaded.peakDbfs,
      bytes: loaded.bytes,
      sourceSampleRate: loaded.sourceSampleRate,
      rootMidi,
      lowMidi,
      highMidi,
      velocityLo,
      velocityHi,
      tuneCents: clamp(finiteOr(spec.tuneCents, 0), -SAMPLER_LIMITS.maxTuneCents, SAMPLER_LIMITS.maxTuneCents),
      gainDb: clamp(finiteOr(spec.gainDb, 0), -120, SAMPLER_LIMITS.maxGainDb),
      loop
    })
  }

  const coverage = analyzeCoverage(zones)
  return {
    zones,
    count: zones.length,
    gaps: coverage.gaps,
    overlaps: coverage.overlaps,
    lowMidi: coverage.lowMidi,
    highMidi: coverage.highMidi,
    totalBytes,
    velocityLayers: new Set(zones.map((zone) => `${zone.velocityLo}-${zone.velocityHi}`)).size,
    warnings
  }
}

/**
 * Hole and ambiguity analysis over the mapped key board.
 *
 * A gap is a key nobody maps at all, so a note landing there produces nothing —
 * that is worth reporting before the render, not after. An overlap is a key whose
 * velocity band is claimed by two zones, where the pick becomes a rule (closest
 * root, then zone order) instead of a mapping.
 */
function analyzeCoverage (zones) {
  const sorted = zones.slice().sort((a, b) => a.lowMidi - b.lowMidi || a.index - b.index)
  const gaps = []
  let cursor = null
  for (const zone of sorted) {
    if (cursor === null) {
      cursor = zone.highMidi + 1
      continue
    }
    if (zone.lowMidi > cursor) gaps.push({ lowMidi: cursor, highMidi: zone.lowMidi - 1 })
    if (zone.highMidi + 1 > cursor) cursor = zone.highMidi + 1
  }
  const overlaps = []
  for (let a = 0; a < zones.length; a += 1) {
    for (let b = a + 1; b < zones.length; b += 1) {
      const keyLow = Math.max(zones[a].lowMidi, zones[b].lowMidi)
      const keyHigh = Math.min(zones[a].highMidi, zones[b].highMidi)
      if (keyLow > keyHigh) continue
      const velocityLow = Math.max(zones[a].velocityLo, zones[b].velocityLo)
      const velocityHigh = Math.min(zones[a].velocityHi, zones[b].velocityHi)
      // Bands are half-open ([lo, hi), except hi = 1 includes 1), so touching
      // boundaries — [0, 0.5) and [0.5, 1] — are not an overlap.
      if (!(velocityLow < velocityHigh)) continue
      overlaps.push({
        a: zones[a].index,
        b: zones[b].index,
        lowMidi: keyLow,
        highMidi: keyHigh,
        velocityLo: velocityLow,
        velocityHi: velocityHigh
      })
    }
  }
  return {
    gaps,
    overlaps,
    lowMidi: zones.reduce((min, zone) => Math.min(min, zone.lowMidi), 127),
    highMidi: zones.reduce((max, zone) => Math.max(max, zone.highMidi), 0)
  }
}

/* ------------------------------------------------------------- playback -- */

function envelopeLevel (frame, attackFrames, decayFrames, sustain) {
  if (frame < attackFrames) return frame / attackFrames
  const afterAttack = frame - attackFrames
  if (afterAttack < decayFrames) return 1 - (1 - sustain) * (afterAttack / decayFrames)
  return sustain
}

/**
 * Correlation between the loop head and the material that follows the loop end.
 *
 * Same reasoning as the synth loop wrap: identical signals need linear weights
 * (a^2 + b^2 = 1 sums to unity at the midpoint), independent ones need equal
 * power (a^2 + b^2 = 1 keeps the level but linear would dip 3 dB). The measured
 * correlation chooses the exponent between the two.
 */
function loopCorrelation (samples, start, end, length) {
  if (length < 2) return 1
  let meanHead = 0
  let meanContinuation = 0
  for (let i = 0; i < length; i += 1) {
    meanHead += samples[start + i]
    meanContinuation += samples[end + i]
  }
  meanHead /= length
  meanContinuation /= length
  let cross = 0
  let energyHead = 0
  let energyContinuation = 0
  for (let i = 0; i < length; i += 1) {
    const head = samples[start + i] - meanHead
    const continuation = samples[end + i] - meanContinuation
    cross += head * continuation
    energyHead += head * head
    energyContinuation += continuation * continuation
  }
  if (!(energyHead > 0) || !(energyContinuation > 0)) return 0
  return clamp(cross / Math.sqrt(energyHead * energyContinuation), -1, 1)
}

/** Weight exponent for the loop crossfade: 1 = linear (same signal), 0.5 = equal power. */
function crossfadeExponent (correlation) {
  return clamp(Math.log(2 * (1 + clamp(correlation, -1, 1))) / Math.log(4), 0.5, 1)
}

/**
 * Build the loop period for one zone.
 *
 * `buffer` holds exactly one loop period; `buffer[0]` is the sample that
 * continues `buffer[length - 1]`, which is what makes the wrap a continuation
 * rather than a jump. Reading it cyclically is the whole loop implementation.
 */
function buildLoop (zone, overrideSeconds, warnings) {
  const samples = zone.samples
  const rate = zone.sampleRate
  const start = clamp(Math.round(zone.loop.startSeconds * rate), 0, samples.length - 2)
  const end = clamp(Math.round(zone.loop.endSeconds * rate), start + 2, samples.length)
  const length = end - start
  const continuation = samples.length - end
  const budget = Math.min(continuation, Math.floor(length / 2))
  const requested = overrideSeconds === undefined || overrideSeconds === null
    ? zone.loop.crossfadeSeconds
    : finiteOr(overrideSeconds, zone.loop.crossfadeSeconds)
  const crossfade = clamp(Math.round(requested * rate), 0, Math.max(0, budget))
  if (overrideSeconds !== undefined && overrideSeconds !== null && requested * rate > crossfade) {
    warnings.push(`zone ${zone.index} (${zone.name}): loop crossfade clamped to ${round(crossfade / rate * 1000, 1)} ms (the sample has ${round(budget / rate * 1000, 1)} ms of material after loopEnd)`)
  }
  const correlation = loopCorrelation(samples, start, end, crossfade)
  const exponent = crossfadeExponent(correlation)
  const buffer = new Float32Array(length)
  buffer.set(samples.subarray(start, end))
  if (crossfade > 0) {
    for (let i = 0; i < crossfade; i += 1) {
      const t = i / crossfade
      // At i = 0 the weight is entirely on the material after loopEnd (a
      // continuation of the last frame); by i = crossfade it is entirely the
      // recording's own head, so the loop rejoins the note it was cut from.
      buffer[i] = samples[start + i] * Math.pow(t, exponent) + samples[end + i] * Math.pow(1 - t, exponent)
    }
  }
  return { start, end, length, crossfade, correlation: round(correlation, 3), exponent: round(exponent, 3), buffer }
}

/**
 * Read the zone at a fractional position, looping when a loop period exists.
 *
 * Positions are in the zone's own sample domain, so a pitch change only changes
 * how fast the cursor advances; the loop points themselves never move.
 */
function readZone (runtime, position) {
  const loop = runtime.loop
  if (loop === null) {
    if (position < 0 || position >= runtime.length - 1) return 0
    const index = Math.floor(position)
    const fraction = position - index
    const samples = runtime.samples
    const a = samples[index]
    const b = samples[index + 1]
    return a + (b - a) * fraction
  }
  if (position < loop.end) {
    if (position >= runtime.length - 1) return 0
    const index = Math.floor(position)
    const fraction = position - index
    const samples = runtime.samples
    const a = samples[index]
    const b = samples[index + 1]
    return a + (b - a) * fraction
  }
  // The playhead keeps advancing past loopEnd in zone-sample time and is folded
  // back into the period. Because buffer[0] continues buffer[length - 1], the
  // fold is inaudible; interpolating across the fold reads the continuation.
  const wrapped = (position - loop.end) % loop.length
  const index = Math.floor(wrapped)
  const fraction = wrapped - index
  const buffer = loop.buffer
  const a = buffer[index]
  const b = buffer[index + 1 === loop.length ? 0 : index + 1]
  return a + (b - a) * fraction
}

function resolveKeymap (request) {
  if (request.keymap !== undefined && request.keymap !== null) {
    const keymap = request.keymap
    if (typeof keymap !== 'object' || !Array.isArray(keymap.zones)) {
      throw new Error('sampler: keymap must be the object buildKeymap returns (it needs a zones array)')
    }
    return keymap
  }
  return buildKeymap(request.zones)
}

function resolveEnvelope (envelope) {
  const input = envelope !== null && typeof envelope === 'object' ? envelope : {}
  return {
    attack: clamp(finiteOr(input.attack, DEFAULT_ENVELOPE.attack), 0, 30),
    decay: clamp(finiteOr(input.decay, DEFAULT_ENVELOPE.decay), 0, 30),
    sustain: clamp(finiteOr(input.sustain, DEFAULT_ENVELOPE.sustain), 0, 1),
    release: clamp(finiteOr(input.release, DEFAULT_ENVELOPE.release), 0, 30)
  }
}

/**
 * Normalise the note list.
 *
 * Accepts `{ midi, startBeat?, durBeats?, velocity? }` objects (aliases `beat`,
 * `dur`, `duration` are honoured because the other timing tools use them) and
 * bare MIDI numbers, which are placed end to end. A note with `midi: null` (or
 * `rest: true`) is a rest: it advances the cursor and renders nothing, so a
 * melody transcribed with rests keeps its rhythm.
 */
function normalizeNotes (rawNotes) {
  if (rawNotes === undefined || rawNotes === null) return []
  if (!Array.isArray(rawNotes)) {
    throw new Error('sampler: notes must be an array of { midi, startBeat, durBeats, velocity }')
  }
  if (rawNotes.length > SAMPLER_LIMITS.maxNotes) {
    throw new Error(`sampler: ${rawNotes.length} notes is more than the ${SAMPLER_LIMITS.maxNotes} one render accepts`)
  }
  const notes = []
  let cursor = 0
  for (let index = 0; index < rawNotes.length; index += 1) {
    const item = rawNotes[index]
    if (item === null || item === undefined) continue
    if (typeof item === 'number' || typeof item === 'string') {
      const midi = readMidi(`note ${index} midi`, item)
      const durBeats = 1
      notes.push({ midi, startBeat: cursor, durBeats, velocity: 1 })
      cursor += durBeats
      continue
    }
    if (typeof item !== 'object') throw new Error(`sampler: note ${index} must be an object, got ${describe(item)}`)
    const durBeats = clamp(finiteOr(item.durBeats, finiteOr(item.dur, finiteOr(item.duration, 1))), 1 / 64, 32)
    const startBeat = item.startBeat !== undefined || item.beat !== undefined
      ? Math.max(0, finiteOr(item.startBeat, finiteOr(item.beat, cursor)))
      : cursor
    cursor = Math.max(cursor, startBeat + durBeats)
    if (item.midi === null || item.rest === true) continue
    if (item.midi === undefined) {
      throw new Error(`sampler: note ${index} needs a midi number (or midi: null for a rest)`)
    }
    const midi = readMidi(`note ${index} midi`, item.midi)
    notes.push({ midi, startBeat, durBeats, velocity: clamp(finiteOr(item.velocity, 1), 0, 1) })
  }
  return notes
}

/**
 * Deterministic round-robin groups: zones with the same key range and velocity
 * band are takes of one layer, and consecutive notes cycle through them.
 */
function buildGroups (zones) {
  const bySignature = new Map()
  for (const zone of zones) {
    const signature = `${zone.lowMidi}|${zone.highMidi}|${zone.velocityLo}|${zone.velocityHi}`
    let group = bySignature.get(signature)
    if (group === undefined) {
      group = { indices: [], plays: 0 }
      bySignature.set(signature, group)
    }
    group.indices.push(zone.index)
  }
  return [...bySignature.values()]
}

/**
 * Choose the zone for one note: key range and velocity band narrow it down,
 * closest root wins when several layers match, and round-robin picks the take.
 */
function pickZone (groups, zones, note, options) {
  let best = null
  for (const group of groups) {
    let distance = Infinity
    for (const index of group.indices) {
      const zone = zones[index]
      if (note.midi < zone.lowMidi || note.midi > zone.highMidi) continue
      if (!velocityInBand(note.velocity, zone)) continue
      const candidate = Math.abs(note.midi - zone.rootMidi)
      if (candidate < distance) distance = candidate
    }
    if (distance === Infinity) continue
    if (best === null || distance < best.distance || (distance === best.distance && group.indices[0] < best.order)) {
      best = { group, distance, order: group.indices[0] }
    }
  }
  if (best === null) return null
  const { group } = best
  const take = options.roundRobin
    ? (options.seed % group.indices.length + group.plays) % group.indices.length
    : 0
  group.plays += 1
  return { index: group.indices[take], take, takes: group.indices.length }
}

/**
 * Render a sampler performance: notes -> pitched, enveloped, layered audio.
 *
 * Pitch and speed move together (interpolated resampling), so a note above the
 * root is shorter and a note below is longer — the traditional sampler
 * trade-off. `audio_stretch` is the tool for a cue whose duration must not
 * change.
 *
 * @param {object} request
 * @param {object[]} [request.zones] - zone map, used when `keymap` is absent.
 * @param {object} [request.keymap] - a `buildKeymap` result; wins over `zones`.
 * @param {{ midi: number, startBeat?: number, durBeats?: number, velocity?: number }[]} [request.notes]
 * @param {number} [request.bpm] - beats per minute, default 96.
 * @param {{ attack?: number, decay?: number, sustain?: number, release?: number }} [request.envelope]
 * @param {boolean} [request.roundRobin] - cycle sibling takes, default true.
 * @param {number} [request.seed] - rotates which take plays first; default 1.
 * @param {number} [request.sampleRate] - output rate, default 44100.
 * @param {number} [request.loopCrossfadeSeconds] - override the zone loop crossfade
 *   (0 disables it, which is only useful for proving a seam is audible); default 0.01.
 * @returns {{ samples: Float32Array, sampleRate: number, report: object }} rendered audio and report.
 */
export function renderSampler (request = {}) {
  const input = request !== null && typeof request === 'object' ? request : {}
  const keymap = resolveKeymap(input)
  const zones = keymap.zones
  const sampleRate = clamp(Math.round(finiteOr(input.sampleRate, 44100)), SAMPLER_LIMITS.minSampleRate, SAMPLER_LIMITS.maxSampleRate)
  const bpm = clamp(finiteOr(input.bpm, 96), 20, 400)
  const secondsPerBeat = 60 / bpm
  const envelope = resolveEnvelope(input.envelope)
  const seed = Math.abs(Math.round(finiteOr(input.seed, 1)))
  const roundRobin = input.roundRobin !== false
  const notes = normalizeNotes(input.notes)
  if (notes.length === 0) {
    throw new Error('sampler: no notes to render (pass notes, or a melody for the tool to expand)')
  }

  const warnings = Array.isArray(keymap.warnings) ? keymap.warnings.slice() : []
  const runtime = zones.map((zone) => ({
    samples: zone.samples,
    sampleRate: zone.sampleRate,
    length: zone.samples.length,
    gain: dbToGain(zone.gainDb),
    loop: zone.loop === null || zone.loop === undefined
      ? null
      : buildLoop(zone, input.loopCrossfadeSeconds, warnings)
  }))
  const groups = buildGroups(zones)

  const attackFrames = Math.round(envelope.attack * sampleRate)
  const decayFrames = Math.round(envelope.decay * sampleRate)
  const releaseFrames = Math.round(envelope.release * sampleRate)
  const maxFrames = SAMPLER_LIMITS.maxSeconds * sampleRate

  // The buffer must be sized before rendering; notes that no zone covers are
  // trimmed off afterwards, so a melody reaching past the keymap cannot stretch
  // the file with silence.
  let totalFrames = 0
  for (const note of notes) {
    const gateFrames = Math.max(1, Math.round(note.durBeats * secondsPerBeat * sampleRate))
    const startFrame = Math.max(0, Math.round(note.startBeat * secondsPerBeat * sampleRate))
    totalFrames = Math.max(totalFrames, startFrame + gateFrames + releaseFrames)
  }
  if (totalFrames > maxFrames) {
    throw new Error(`sampler: the notes span ${round(totalFrames / sampleRate, 2)}s, more than the ${SAMPLER_LIMITS.maxSeconds}s one render accepts`)
  }

  const master = new Float32Array(totalFrames)
  const zoneHits = zones.map((zone) => ({
    index: zone.index,
    name: zone.name,
    rootMidi: zone.rootMidi,
    lowMidi: zone.lowMidi,
    highMidi: zone.highMidi,
    velocityLo: zone.velocityLo,
    velocityHi: zone.velocityHi,
    sampleRate: zone.sampleRate,
    takes: 1,
    hits: 0
  }))
  let noteCount = 0
  let loopedNotes = 0
  let loopWraps = 0
  let minSemitones = Infinity
  let maxSemitones = -Infinity
  const unmappedNotes = []
  const unmatchedVelocityNotes = []
  let keyMisses = 0
  let velocityMisses = 0
  const picks = []

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index]
    if (!(note.velocity > 0)) continue
    const picked = pickZone(groups, zones, note, { roundRobin, seed })
    if (picked === null) {
      // Two different misses, and a caller acting on the report needs to tell
      // them apart: a key that no zone reaches is a mapping hole, while a key
      // that is mapped but whose velocity falls between the bands means the
      // layers do not cover the whole 0..1 range. The second used to be skipped
      // silently and then described as "outside the keymap", which sent the
      // caller to fix the wrong thing.
      const mappedKey = zones.some((zone) => note.midi >= zone.lowMidi && note.midi <= zone.highMidi)
      if (mappedKey) {
        velocityMisses += 1
        if (unmatchedVelocityNotes.length < REPORT_UNMAPPED_LINES) {
          unmatchedVelocityNotes.push({ midi: note.midi, velocity: round(note.velocity, 3) })
          warnings.push(`sampler: note ${midiToName(note.midi)} (midi ${note.midi}) at velocity ${round(note.velocity, 3)} matched no velocity band; widen velocityLo/velocityHi or add a zone that covers it`)
        }
      } else {
        keyMisses += 1
        if (unmappedNotes.length < REPORT_UNMAPPED_LINES) unmappedNotes.push({ midi: note.midi, velocity: round(note.velocity, 3) })
      }
      continue
    }
    const zone = zones[picked.index]
    const play = runtime[picked.index]
    const semitones = note.midi - zone.rootMidi + zone.tuneCents / 100
    const ratio = Math.pow(2, semitones / 12)
    // Reverse the sample rate as well as the pitch: a 22.05 kHz recording plays
    // back at the right speed on a 44.1 kHz timeline.
    const increment = ratio * zone.sampleRate / sampleRate
    const gateFrames = Math.max(1, Math.round(note.durBeats * secondsPerBeat * sampleRate))
    const startFrame = Math.max(0, Math.round(note.startBeat * secondsPerBeat * sampleRate))
    const noteGain = note.velocity * play.gain
    const releaseStart = envelopeLevel(Math.max(0, gateFrames - 1), attackFrames, decayFrames, envelope.sustain)
    const total = gateFrames + releaseFrames
    let position = 0

    for (let i = 0; i < total; i += 1) {
      const frame = startFrame + i
      if (frame >= master.length) break
      const level = i < gateFrames
        ? envelopeLevel(i, attackFrames, decayFrames, envelope.sustain)
        : releaseStart * (1 - (i - gateFrames + 1) / Math.max(1, releaseFrames))
      master[frame] += readZone(play, position) * level * noteGain
      position += increment
      // A one-shot that runs out simply stops; holding the last sample would be
      // a DC click and repeating it is a loop, which is what loop points are for.
      if (play.loop === null && position >= play.length - 1) break
    }

    if (play.loop !== null && position > play.loop.end) {
      const wraps = Math.floor((position - play.loop.end) / play.loop.length) + 1
      loopWraps += wraps
      loopedNotes += 1
    }
    noteCount += 1
    minSemitones = Math.min(minSemitones, semitones)
    maxSemitones = Math.max(maxSemitones, semitones)
    zoneHits[picked.index].hits += 1
    zoneHits[picked.index].takes = picked.takes
    if (picks.length < REPORT_PICKS) {
      picks.push({
        midi: note.midi,
        startBeat: round(note.startBeat, 4),
        zoneIndex: picked.index,
        zoneName: zone.name,
        take: picked.take,
        takes: picked.takes
      })
    }
  }

  if (noteCount === 0) {
    if (velocityMisses > 0 && keyMisses === 0) {
      const bands = [...new Set(zones.map((zone) => `${round(zone.velocityLo, 2)}–${round(zone.velocityHi, 2)}`))].slice(0, 8)
      throw new Error(`sampler: none of the ${notes.length} note(s) matched a velocity band (zones cover ${bands.join(', ')}); widen velocityLo/velocityHi or add a zone that covers the missing range`)
    }
    const lowMidi = Number.isFinite(keymap.lowMidi) ? keymap.lowMidi : Math.min(...zones.map((zone) => zone.lowMidi))
    const highMidi = Number.isFinite(keymap.highMidi) ? keymap.highMidi : Math.max(...zones.map((zone) => zone.highMidi))
    throw new Error(`sampler: none of the ${notes.length} note(s) is covered by the keymap (keys ${midiToName(lowMidi)}–${midiToName(highMidi)}); extend lowMidi/highMidi or add a zone`)
  }

  // Trim the trailing silence a truncated zone leaves behind, so the reported
  // duration is the length of the sound rather than of the longest note.
  let lastSounding = -1
  for (let i = master.length - 1; i >= 0; i -= 1) {
    if (Math.abs(master[i]) > 1e-5) {
      lastSounding = i
      break
    }
  }
  if (lastSounding < 0) throw new Error('sampler: the render came out silent; check the zone level, the velocity and the envelope')
  const samples = master.subarray(0, lastSounding + 1)
  softLimit(samples)

  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
    sumSquares += samples[i] * samples[i]
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length))
  const amplitudeDb = (value) => (value > 0 ? round(20 * Math.log10(value), 2) : -120)

  return {
    samples,
    sampleRate,
    report: {
      zones: zones.length,
      noteCount,
      pitchShiftRange: {
        minSemitones: Number.isFinite(minSemitones) ? round(minSemitones, 2) : 0,
        maxSemitones: Number.isFinite(maxSemitones) ? round(maxSemitones, 2) : 0
      },
      loopedNotes,
      loopWraps,
      unmappedNotes,
      unmatchedVelocityNotes,
      unmatchedVelocityCount: velocityMisses,
      picks,
      zoneHits,
      bpm,
      durationSeconds: round(samples.length / sampleRate, 3),
      sampleRate,
      peakDbfs: amplitudeDb(peak),
      rmsDbfs: amplitudeDb(rms),
      warnings
    }
  }
}

/* ----------------------------------------------------------------- info -- */

function formatBytes (bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  return value > 1024 * 1024 ? `${round(value / 1024 / 1024, 2)} MB` : `${Math.round(value / 1024)} KB`
}

/**
 * A compact text block describing a keymap, for the tool result.
 *
 * Bounded on purpose: the caller reads the head of the instrument (which zones,
 * which roots, which ranges, how big), not a dump. Lines past the limit are
 * counted instead of printed.
 *
 * @param {object[]|object} zones - a raw zone map or a `buildKeymap` result.
 * @returns {string} multi-line description.
 */
export function samplerInfo (zones) {
  const keymap = Array.isArray(zones) ? buildKeymap(zones) : zones
  if (keymap === null || typeof keymap !== 'object' || !Array.isArray(keymap.zones) || keymap.zones.length === 0) {
    throw new Error('sampler: samplerInfo needs a zone array or a buildKeymap() result')
  }
  const totalBytes = Number.isFinite(keymap.totalBytes)
    ? keymap.totalBytes
    : keymap.zones.reduce((sum, zone) => sum + (Number.isFinite(zone.bytes) ? zone.bytes : zone.samples.length * 2), 0)
  const lowMidi = Number.isFinite(keymap.lowMidi) ? keymap.lowMidi : Math.min(...keymap.zones.map((zone) => zone.lowMidi))
  const highMidi = Number.isFinite(keymap.highMidi) ? keymap.highMidi : Math.max(...keymap.zones.map((zone) => zone.highMidi))
  const gaps = Array.isArray(keymap.gaps) ? keymap.gaps : []
  const overlaps = Array.isArray(keymap.overlaps) ? keymap.overlaps : []
  const layers = Number.isFinite(keymap.velocityLayers)
    ? keymap.velocityLayers
    : new Set(keymap.zones.map((zone) => `${zone.velocityLo}-${zone.velocityHi}`)).size
  const notes = []
  notes.push(overlaps.length === 0 ? 'no overlaps' : `${overlaps.length} overlap(s)`)
  notes.push(gaps.length === 0 ? 'no gaps' : `gaps ${gaps.map((gap) => `${midiToName(gap.lowMidi)}-${midiToName(gap.highMidi)}`).join(', ')}`)

  const lines = [
    `sampler: ${keymap.zones.length} zone(s), ${formatBytes(totalBytes)}, keys ${midiToName(lowMidi)}–${midiToName(highMidi)}, ${layers} velocity layer(s), ${notes.join(', ')}`
  ]
  for (const zone of keymap.zones.slice(0, INFO_ZONE_LINES)) {
    const parts = [
      `#${zone.index}`,
      zone.name,
      `root ${midiToName(zone.rootMidi)}`,
      `keys ${midiToName(zone.lowMidi)}–${midiToName(zone.highMidi)}`,
      `vel ${round(zone.velocityLo, 2)}–${round(zone.velocityHi, 2)}`
    ]
    if (zone.tuneCents !== 0 && Number.isFinite(zone.tuneCents)) parts.push(`tune ${zone.tuneCents > 0 ? '+' : ''}${zone.tuneCents}c`)
    if (zone.gainDb !== 0 && Number.isFinite(zone.gainDb)) parts.push(`gain ${zone.gainDb > 0 ? '+' : ''}${round(zone.gainDb, 1)} dB`)
    if (zone.loop) parts.push(`loop ${round(zone.loop.startSeconds, 3)}–${round(zone.loop.endSeconds, 3)}s`)
    parts.push(`peak ${round(zone.peakDbfs, 1)} dBFS`)
    parts.push(`${round(zone.durationSeconds, 3)}s @${zone.sampleRate} Hz`)
    parts.push(formatBytes(zone.bytes))
    lines.push(`  ${parts.join('  ')}`)
  }
  if (keymap.zones.length > INFO_ZONE_LINES) lines.push(`  ... and ${keymap.zones.length - INFO_ZONE_LINES} more zone(s)`)
  return lines.join('\n')
}
