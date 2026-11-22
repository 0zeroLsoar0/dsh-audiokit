/**
 * Stem export: split a cue set into one file per layer plus a master whose sum
 * reconstructs the mix.
 *
 * `audio_mix` collapses N tracks into one file. A video, game or DAW pipeline
 * needs the opposite: the layers on separate files, all aligned on one timeline,
 * with a master that still equals their sum — the editor will mute one layer,
 * process another in isolation, or rebalance the mix two weeks after the render.
 *
 * Three layers, in order:
 *
 * 1. `planStems` validates a request and resolves it onto one timeline without
 *    touching samples: sample rates, per-track gain, offsets, master options and
 *    a worst-case reconstruction budget.
 * 2. `renderStems` places every track on that timeline with its own gain and
 *    offset, sums them, and runs the *same* master stage as `mixTracks` (soft
 *    limiter, peak normalisation). The master-bus processing is applied to the
 *    stems as one shared per-sample gain, so `sum(stems) === master`; that
 *    invariant is asserted, not promised.
 * 3. `packageStems` encodes 8/16/24/32-bit mono or stereo WAVs plus a
 *    `stems.json` manifest that hashes every file.
 *
 * Determinism is total: no `Math.random`, no clock, no locale-dependent
 * formatting, so two runs of the same request produce identical bytes and the
 * manifest can be used to prove that.
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { measure, writeFileAtomic } from './audio.js'
import { clamp, dbToGain, normalizePeak, softLimit } from './dsp.js'
import { decodeWav } from './wav.js'
import { encodeWavEx } from './wav-encode.js'

/** Hard limits. They match the mix path where they overlap and bound memory. */
export const STEM_LIMITS = Object.freeze({
  /** A stem set with more layers than this is a rename of "one file per sample". */
  maxTracks: 32,
  /** One cue, not a whole reel: the mix path caps a timeline the same way. */
  maxSeconds: 180,
  /** The synthetic engine's supported rate window. */
  minSampleRate: 8000,
  maxSampleRate: 96000,
  minGainDb: -120,
  maxGainDb: 24,
  minMasterPeakDbfs: -120,
  maxMasterPeakDbfs: 0,
  /**
   * `sum(stems)` may differ from the master only by the master's own float32
   * rounding. The stems are Float64 for that reason: a Float32 stem rounds each
   * one of up to 32 layers and the sum would drift into the micro-dB range that
   * this tolerance exists to catch.
   */
  reconstructionTolerance: 1e-6
})

/** Output formats `packageStems` can write. */
export const STEM_BIT_DEPTHS = Object.freeze([8, 16, 24, 32])
/** Stems are deliverables, so the default is the 24-bit video master, not 16-bit. */
const DEFAULT_BIT_DEPTH = 24
/** All sources are mono; stereo is dual-mono until a tool exposes panning. */
const DEFAULT_CHANNELS = 1
/** The knee of `dsp.softLimit`; a sum that stays under it passes through clean. */
const LIMITER_KNEE = 0.85

/* ---------------------------------------------------------------- helpers -- */

function fail (caller, message) {
  throw new Error(`${caller}: ${message}`)
}

function describeValue (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Round to `digits` decimals without going through locale formatting. */
function roundTo (value, digits) {
  return Number(Number(value).toFixed(digits))
}

function toDb (linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -120
}

/**
 * Read an optional number, rejecting only values that cannot mean anything.
 * `undefined`/`null` fall back; numeric strings are accepted because a host may
 * send one.
 */
function readNumber (caller, label, value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' && typeof value !== 'string') {
    fail(caller, `${label} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) fail(caller, `${label} must be a number, got ${describeValue(value)}`)
  return number
}

/** Round an optional integer argument. */
function readInteger (caller, label, value, fallback) {
  const number = readNumber(caller, label, value, fallback)
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    fail(caller, `${label} must be a whole number, got ${describeValue(value)}`)
  }
  return number
}

/** Frames for a duration, matching the mix path's `Math.round`. */
function frameCount (seconds, sampleRate) {
  return Math.max(0, Math.round(seconds * sampleRate))
}

/** Length of a source buffer after a rate conversion; 0 stays 0. */
function resampledFrameCount (frames, fromRate, toRate) {
  if (frames <= 0) return 0
  if (fromRate === toRate) return frames
  return Math.max(1, Math.round(frames * toRate / fromRate))
}

/**
 * Linear-interpolation resampler.
 *
 * This is deliberately the same algorithm `audio.js` uses for `mixTracks`: a
 * stem set made by this module must place a 48 kHz bed exactly where `audio_mix`
 * places it, or the stems would not line up with the mixed cue they replace.
 */
function resampleLinear (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = toRate / fromRate
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index / ratio
    const floor = Math.floor(position)
    const fraction = position - floor
    const a = samples[floor] ?? 0
    const b = samples[floor + 1] ?? a
    out[index] = a + (b - a) * fraction
  }
  return out
}

/**
 * Resolve the output sample rate: the request wins, otherwise the highest input
 * rate. Out-of-window values clamp to the engine's 8–96 kHz limits exactly as
 * `mixTracks` does; a non-numeric rate is an error, not a guess.
 */
function resolveSampleRate (requested, fallbacks, caller) {
  let chosen
  if (requested !== undefined && requested !== null) {
    const value = Number(requested)
    if (!Number.isFinite(value) || value <= 0) {
      fail(caller, `sampleRate must be a positive number, got ${describeValue(requested)}`)
    }
    chosen = Math.round(value)
  } else {
    const usable = fallbacks.filter((value) => Number.isFinite(value) && value > 0)
    if (usable.length === 0) fail(caller, 'a sampleRate is required; no input declares one')
    chosen = Math.round(Math.max(...usable))
  }
  return clamp(chosen, STEM_LIMITS.minSampleRate, STEM_LIMITS.maxSampleRate)
}

/**
 * The master stage, resolved:
 * - `limiter` is on unless explicitly `false` (the mix path default).
 * - `peakDbfs` is `null` when normalisation is off. An omitted `master` object
 *   means "behave like `audio_mix`" (limiter on, peak -1 dBFS); passing a
 *   `master` object without `peakDbfs` means "keep the sum unnormalised".
 */
function resolveMaster (master, caller) {
  const defaulted = master === undefined
  const source = master === null || master === undefined ? {} : master
  if (typeof source !== 'object' || Array.isArray(source)) {
    fail(caller, `master must be an object like { peakDbfs, limiter }, got ${describeValue(master)}`)
  }
  const limiter = source.limiter !== false
  let peakDbfs = defaulted ? -1 : null
  if (source.peakDbfs !== undefined && source.peakDbfs !== null) {
    const value = Number(source.peakDbfs)
    if (!Number.isFinite(value) || value < STEM_LIMITS.minMasterPeakDbfs || value > STEM_LIMITS.maxMasterPeakDbfs) {
      fail(caller, `master.peakDbfs must be a finite number between ${STEM_LIMITS.minMasterPeakDbfs} and ${STEM_LIMITS.maxMasterPeakDbfs} dBFS, got ${describeValue(source.peakDbfs)}`)
    }
    peakDbfs = value
  }
  return { limiter, peakDbfs }
}

/** Make an id unique within a stem set; ids are labels, filenames are sanitised later. */
function uniqueId (base, used) {
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  used.add(id)
  return id
}

function validateFiniteSamples (samples, caller, id) {
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) {
      fail(caller, `track "${id}" sample ${index} is ${describeValue(samples[index])}; stems cannot contain NaN or Infinity`)
    }
  }
}

/**
 * Validate and normalise a track list.
 *
 * The same shape is accepted by `planStems` (metadata is enough when `samples`
 * are absent and `durationSeconds` is given) and by `renderStems` (samples are
 * mandatory), so the two cannot disagree about an id, gain or offset.
 */
function normaliseTracks (tracks, caller, options = {}) {
  const requireSamples = options.requireSamples === true
  if (!Array.isArray(tracks) || tracks.length === 0) {
    fail(caller, 'tracks must be a non-empty array of { id?, samples, sampleRate, gainDb?, offsetSeconds? }')
  }
  if (tracks.length > STEM_LIMITS.maxTracks) {
    fail(caller, `${tracks.length} tracks exceeds the ${STEM_LIMITS.maxTracks}-track limit; export the set in groups`)
  }
  const used = new Set()
  return tracks.map((track, index) => {
    if (track === null || typeof track !== 'object') {
      fail(caller, `tracks[${index}] must be an object, got ${describeValue(track)}`)
    }
    const rawId = String(track.id ?? track.name ?? '').trim()
    const id = uniqueId(rawId === '' ? `stem-${index + 1}` : rawId, used)
    const name = track.name === undefined || track.name === null ? id : String(track.name)
    const gainDb = readNumber(caller, `tracks[${index}] "${id}" gainDb`, track.gainDb, 0)
    if (!Number.isFinite(gainDb) || gainDb < STEM_LIMITS.minGainDb || gainDb > STEM_LIMITS.maxGainDb) {
      fail(caller, `tracks[${index}] "${id}" gainDb must be a finite number between ${STEM_LIMITS.minGainDb} and ${STEM_LIMITS.maxGainDb} dB, got ${describeValue(track.gainDb)}`)
    }
    const offsetSeconds = readNumber(caller, `tracks[${index}] "${id}" offsetSeconds`, track.offsetSeconds, 0)
    if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0 || offsetSeconds > STEM_LIMITS.maxSeconds) {
      fail(caller, `tracks[${index}] "${id}" offsetSeconds must be a finite number between 0 and ${STEM_LIMITS.maxSeconds} seconds, got ${describeValue(track.offsetSeconds)}`)
    }
    const sampleRateValue = Number(track.sampleRate)
    if (!Number.isFinite(sampleRateValue) || sampleRateValue <= 0) {
      fail(caller, `tracks[${index}] "${id}" sampleRate must be a positive number, got ${describeValue(track.sampleRate)}`)
    }
    let samples
    let durationSeconds = Number(track.durationSeconds)
    if (track.samples !== undefined && track.samples !== null) {
      if (!ArrayBuffer.isView(track.samples)) {
        fail(caller, `tracks[${index}] "${id}" samples must be a typed array, got ${describeValue(track.samples)}`)
      }
      samples = track.samples
      if (requireSamples) validateFiniteSamples(samples, caller, id)
      durationSeconds = samples.length / sampleRateValue
    } else if (requireSamples) {
      fail(caller, `tracks[${index}] "${id}" needs samples`)
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      fail(caller, `tracks[${index}] "${id}" needs samples or a finite durationSeconds to be placed on the timeline`)
    }
    const peakDbfs = Number.isFinite(Number(track.peakDbfs)) ? Number(track.peakDbfs) : null
    return { id, name, samples, sampleRate: sampleRateValue, gainDb, offsetSeconds, durationSeconds, peakDbfs }
  })
}

function peakOf (samples) {
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index])
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

function averageChannels (channels) {
  if (channels.length === 1) return channels[0]
  const frames = channels[0].length
  const out = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index]
    out[index] = sum / channels.length
  }
  return out
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A filename-safe form of an id. Never returns a path separator. */
function sanitiseId (value, index) {
  const base = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return base === '' ? `stem-${index + 1}` : base
}

/** Pick a file name that does not collide with an earlier stem, master or manifest. */
function nextFileName (base, used) {
  let candidate = `${base}.wav`
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}.wav`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

/* ------------------------------------------------------------------ plan -- */

/**
 * Validate a stem request and resolve it onto one common timeline.
 *
 * Nothing is rendered here: this is what a caller inspects before allocating
 * buffers. It reports each stem's start frame, the shared timeline length, the
 * resolved sample rate and a conservative reconstruction budget (the sum peak
 * the master stage will see if every source reaches the peak it declares).
 *
 * @param {object} request - `tracks`, optional `sampleRate`, optional `master`.
 * @param {Array<object>} request.tracks - per layer: `{ id?, name?, samples?,
 *   sampleRate, durationSeconds?, gainDb?, offsetSeconds?, peakDbfs? }`.
 *   Tracks without samples must carry `durationSeconds`.
 * @param {number} [request.sampleRate] - output rate; defaults to the highest
 *   input rate, then clamps to the engine's 8–96 kHz window.
 * @param {{ peakDbfs?: number|null, limiter?: boolean }} [request.master] -
 *   master stage. Omit the whole object for the mix-path defaults (limiter on,
 *   peak -1 dBFS); omit `peakDbfs` inside it to keep the sum unnormalised.
 * @returns {{ sampleRate: number, frames: number, durationSeconds: number,
 *   stems: object[], master: object, budget: object }} the resolved plan.
 */
export function planStems (request = {}) {
  const caller = 'planStems'
  const tracks = normaliseTracks(request.tracks, caller, { requireSamples: false })
  const sampleRate = resolveSampleRate(request.sampleRate, tracks.map((track) => track.sampleRate), caller)
  const master = resolveMaster(request.master, caller)
  const maxFrames = frameCount(STEM_LIMITS.maxSeconds, sampleRate)

  const stems = []
  let longest = 0
  let worstCaseSumPeak = 0
  let assumedFullScale = 0
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    const startFrame = Math.round(track.offsetSeconds * sampleRate)
    const sourceFrames = track.samples !== undefined && track.samples !== null
      ? resampledFrameCount(track.samples.length, track.sampleRate, sampleRate)
      : frameCount(track.durationSeconds, sampleRate)
    const endFrame = startFrame + sourceFrames
    if (endFrame > longest) longest = endFrame
    const gain = dbToGain(track.gainDb)
    const sourcePeak = track.peakDbfs === null ? 1 : dbToGain(track.peakDbfs)
    if (track.peakDbfs === null) assumedFullScale += 1
    worstCaseSumPeak += gain * sourcePeak
    stems.push({
      id: track.id,
      name: track.name,
      gainDb: roundTo(track.gainDb, 2),
      offsetSeconds: roundTo(track.offsetSeconds, 6),
      startFrame,
      sourceDurationSeconds: roundTo(sourceFrames / sampleRate, 6),
      // The file length is the shared timeline, so every stem is frame-aligned;
      // it is filled in once the longest track is known.
      durationSeconds: 0
    })
  }
  if (longest > maxFrames) {
    fail(caller, `timeline ${roundTo(longest / sampleRate, 3)} s exceeds the ${STEM_LIMITS.maxSeconds} s limit; export shorter stems`)
  }

  const durationSeconds = longest / sampleRate
  for (const stem of stems) stem.durationSeconds = roundTo(durationSeconds, 6)
  const worstCaseSumPeakDbfs = worstCaseSumPeak > 0 ? roundTo(toDb(worstCaseSumPeak), 2) : -120

  return {
    sampleRate,
    frames: longest,
    durationSeconds: roundTo(durationSeconds, 6),
    stems,
    master: {
      sampleRate,
      frames: longest,
      durationSeconds: roundTo(durationSeconds, 6),
      peakDbfs: master.peakDbfs,
      limiter: master.limiter
    },
    budget: {
      // Worst case means "every track peaks in phase at its declared level".
      estimatedSumPeakDbfs: worstCaseSumPeakDbfs,
      assumedFullScaleTracks: assumedFullScale,
      targetMasterPeakDbfs: master.peakDbfs,
      // How much the master normaliser will move the sum (negative = attenuate).
      masterNormaliseDb: master.peakDbfs === null ? null : roundTo(master.peakDbfs - worstCaseSumPeakDbfs, 2),
      reconstructionTolerance: STEM_LIMITS.reconstructionTolerance
    }
  }
}

/* ---------------------------------------------------------------- render -- */

/**
 * Render a stem set and its master.
 *
 * Each stem is its track resampled to the plan's rate, multiplied by its gain
 * and placed at its offset on the shared timeline (zero-padded to the end, so
 * summing the files is sample-aligned). The master is the sum with the mix
 * path's master stage: `softLimit` when `limiter` is on, then `normalizePeak`
 * when `peakDbfs` is set.
 *
 * The reconstruction guarantee: the master stage is a gain *curve* shared by
 * every stem, not a per-stem effect. A linear normaliser is one scalar, a soft
 * limiter is one scalar per sample, and both are derivable from the sum. Stems
 * are therefore printed through that curve, and `sum(stems)` equals the master
 * to within the master's own float32 rounding. The invariant is checked here
 * and a request that cannot satisfy it throws instead of writing lying files.
 *
 * @param {Array<object>} tracks - `{ id?, name?, samples, sampleRate, gainDb?,
 *   offsetSeconds? }`; samples must be finite.
 * @param {object} [options] - `sampleRate`, `master` (as in `planStems`).
 * @returns {{ stems: object[], master: object, reconstruction: object, plan: object }}
 *   `stems[i].samples` is Float64 (see `STEM_LIMITS.reconstructionTolerance`),
 *   `master.samples` is Float32 (the mix path's bus precision).
 */
export function renderStems (tracks, options = {}) {
  const caller = 'renderStems'
  const inputs = normaliseTracks(tracks, caller, { requireSamples: true })
  const plan = planStems({ tracks: inputs, sampleRate: options.sampleRate, master: options.master })
  const sampleRate = plan.sampleRate
  const frames = plan.frames

  const placed = []
  const sum = new Float32Array(frames)
  for (let index = 0; index < inputs.length; index += 1) {
    const track = inputs[index]
    const meta = plan.stems[index]
    const resampled = track.sampleRate === sampleRate
      ? track.samples
      : resampleLinear(track.samples, track.sampleRate, sampleRate)
    const gain = dbToGain(track.gainDb)
    const out = new Float32Array(frames)
    const limit = Math.min(frames, meta.startFrame + resampled.length)
    for (let sample = meta.startFrame; sample < limit; sample += 1) {
      const value = resampled[sample - meta.startFrame] * gain
      out[sample] = value
      // Accumulate in track order: this is the sum a caller would get by
      // adding the stems in the order they are returned.
      sum[sample] += value
    }
    placed.push(out)
  }

  const masterSamples = sum.slice()
  let limiterEngaged = false
  if (plan.master.limiter) {
    for (let sample = 0; sample < frames; sample += 1) {
      if (Math.abs(sum[sample]) > LIMITER_KNEE) {
        limiterEngaged = true
        break
      }
    }
    softLimit(masterSamples)
  }
  let masterGain = 1
  if (plan.master.peakDbfs !== null) masterGain = normalizePeak(masterSamples, plan.master.peakDbfs)
  const masterGainDb = masterGain > 0 ? roundTo(toDb(masterGain), 2) : 0

  // The master bus as a single gain curve. Where the sum is exactly zero the
  // master is zero too (both stages are odd and pass zero), so the curve is 0
  // and the stems contribute nothing there — the sum still matches.
  const busGain = new Float64Array(frames)
  for (let sample = 0; sample < frames; sample += 1) {
    busGain[sample] = sum[sample] === 0 ? 0 : masterSamples[sample] / sum[sample]
  }

  const stems = placed.map((samples, index) => {
    const meta = plan.stems[index]
    const out = new Float64Array(frames)
    for (let sample = 0; sample < frames; sample += 1) out[sample] = samples[sample] * busGain[sample]
    return {
      id: meta.id,
      name: meta.name,
      sampleRate,
      gainDb: meta.gainDb,
      offsetSeconds: meta.offsetSeconds,
      startFrame: meta.startFrame,
      samples: out,
      metrics: { ...measure(out, sampleRate), sampleRate }
    }
  })

  // Assert the contract: the master file is exactly what the stems add up to.
  const verified = new Float64Array(frames)
  for (const stem of stems) {
    const samples = stem.samples
    for (let sample = 0; sample < frames; sample += 1) verified[sample] += samples[sample]
  }
  let maxAbsError = 0
  let sumPeak = 0
  for (let sample = 0; sample < frames; sample += 1) {
    const error = Math.abs(verified[sample] - masterSamples[sample])
    if (error > maxAbsError) maxAbsError = error
    const magnitude = Math.abs(verified[sample])
    if (magnitude > sumPeak) sumPeak = magnitude
  }
  if (!(maxAbsError <= STEM_LIMITS.reconstructionTolerance)) {
    fail(caller, `master does not reconstruct from its stems: max abs error ${maxAbsError.toExponential(3)} exceeds the ${STEM_LIMITS.reconstructionTolerance} tolerance`)
  }

  const preMasterPeak = peakOf(sum)
  return {
    stems,
    master: {
      samples: masterSamples,
      sampleRate,
      gainDb: masterGainDb,
      limiterEngaged,
      metrics: { ...measure(masterSamples, sampleRate), sampleRate }
    },
    reconstruction: {
      maxAbsError,
      sumPeakDbfs: sumPeak > 0 ? roundTo(toDb(sumPeak), 2) : -120,
      preMasterPeakDbfs: preMasterPeak > 0 ? roundTo(toDb(preMasterPeak), 2) : -120,
      masterGainDb,
      limiterEngaged,
      frames,
      durationSeconds: roundTo(frames / sampleRate, 6),
      tolerance: STEM_LIMITS.reconstructionTolerance
    },
    plan
  }
}

/* --------------------------------------------------------------- package -- */

function fileRecord (entry) {
  return {
    id: entry.id,
    file: entry.file,
    bytes: entry.bytes,
    sha256: entry.sha256,
    durationSeconds: entry.durationSeconds,
    peakDbfs: entry.peakDbfs,
    rmsDbfs: entry.rmsDbfs,
    crestDb: entry.crestDb,
    clipping: entry.clipping,
    gainDb: entry.gainDb === undefined ? 0 : entry.gainDb,
    offsetSeconds: entry.offsetSeconds === undefined ? null : entry.offsetSeconds
  }
}

/**
 * Encode a rendered stem set to disk: `<id>.wav` per stem, `master.wav`, and a
 * `stems.json` manifest carrying each file's duration, peak, RMS and SHA-256.
 *
 * Files are written through the format writer `lib/wav-encode.js` (8-bit is
 * unsigned PCM, 16/24-bit signed PCM, 32-bit IEEE float, mono or stereo).
 * The file name is the stem id lower-cased and reduced to `[a-z0-9_-]`; a
 * collision with an earlier stem gets a `-2`, `-3` suffix, and nothing may
 * overwrite `master.wav` or `stems.json`.
 * Dither is disabled on purpose: a stem is summed or processed downstream, so
 * independent dither noise on every layer would accumulate and no longer
 * reconstruct the master. Dither belongs at the final delivery encode, not on
 * the stems.
 *
 * Quantisation is exact before encode: the manifest's `reconstruction` block
 * reports the pre-encode float invariant (max abs error, sum peak), while each
 * file record reports what the decoded file actually contains.
 *
 * @param {object} rendered - the object `renderStems` returned.
 * @param {object} options - `outDir` (required), `bitDepth` 8/16/24/32
 *   (default 24), `channels` 1/2 (default 1), `sampleRate` (must match the
 *   rendered rate), `manifest` (default true).
 * @returns {Promise<{ outDir: string, sampleRate: number, bitDepth: number,
 *   channels: number, frames: number, durationSeconds: number, stems: object[],
 *   master: object, files: object[], manifestPath: string|null,
 *   totalBytes: number, reconstruction: object|null }>} the written file list.
 */
export async function packageStems (rendered, options = {}) {
  const caller = 'packageStems'
  if (rendered === null || typeof rendered !== 'object' || !Array.isArray(rendered.stems) || rendered.stems.length === 0) {
    fail(caller, 'rendered must be the object renderStems returned, with a non-empty stems array')
  }
  if (rendered.master === null || typeof rendered.master !== 'object' || rendered.master.samples === undefined) {
    fail(caller, 'rendered.master is missing; pass the object renderStems returned')
  }
  const outDir = typeof options.outDir === 'string' ? options.outDir.trim() : ''
  if (outDir === '') {
    fail(caller, 'outDir is required; pass the directory <stem>.wav, master.wav and stems.json are written into')
  }
  const bitDepth = readInteger(caller, 'bitDepth', options.bitDepth, DEFAULT_BIT_DEPTH)
  if (!STEM_BIT_DEPTHS.includes(bitDepth)) {
    fail(caller, `bitDepth must be one of ${STEM_BIT_DEPTHS.join(', ')}, got ${describeValue(options.bitDepth)}`)
  }
  const channels = readInteger(caller, 'channels', options.channels, DEFAULT_CHANNELS)
  if (channels !== 1 && channels !== 2) {
    fail(caller, `channels must be 1 or 2, got ${describeValue(options.channels)}`)
  }
  const sampleRate = Number(rendered.master.sampleRate ?? rendered.stems[0]?.sampleRate)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    fail(caller, `rendered master has no usable sampleRate: ${describeValue(rendered.master.sampleRate)}`)
  }
  if (options.sampleRate !== undefined && options.sampleRate !== null) {
    const requested = Number(options.sampleRate)
    if (!Number.isFinite(requested) || Math.round(requested) !== Math.round(sampleRate)) {
      // Resampling here would move every file independently and quietly break
      // the frame alignment the stems exist for; render at the delivery rate.
      fail(caller, `sampleRate ${describeValue(options.sampleRate)} does not match the rendered rate ${sampleRate}; render at the delivery rate so stems stay frame-aligned`)
    }
  }
  const frames = rendered.master.samples.length
  const durationSeconds = frames / sampleRate
  const includeManifest = options.manifest !== false

  await mkdir(outDir, { recursive: true })
  // Reserve the files every stem must not silently overwrite.
  const usedNames = new Set(['master.wav', 'stems.json'])

  const stems = []
  for (let index = 0; index < rendered.stems.length; index += 1) {
    const stem = rendered.stems[index]
    if (stem === null || typeof stem !== 'object' || stem.samples === undefined) {
      fail(caller, `rendered.stems[${index}] has no samples`)
    }
    // Frame alignment is the whole point of a stem set: summing the files has
    // to be a sample-wise addition, so a stem of a different length is refused
    // here rather than silently padded or truncated.
    if (stem.samples.length !== frames) {
      fail(caller, `rendered.stems[${index}] has ${stem.samples.length} frames but the master has ${frames}; stems must be frame-aligned`)
    }
    const id = stem.id ?? stem.name ?? `stem-${index + 1}`
    const file = nextFileName(sanitiseId(id, index), usedNames)
    const channelBuffers = channels === 2 ? [stem.samples, stem.samples] : [stem.samples]
    const bytes = encodeWavEx(channelBuffers, sampleRate, { bitDepth, channels, dither: false })
    const decoded = decodeWav(bytes)
    if (decoded.channels.length !== channels || decoded.sampleRate !== sampleRate) {
      fail(caller, `encoder produced ${decoded.channels.length} channel(s) at ${decoded.sampleRate} Hz, expected ${channels} at ${sampleRate}`)
    }
    const target = join(outDir, file)
    await writeFileAtomic(target, bytes)
    const metrics = { ...measure(averageChannels(decoded.channels), sampleRate), sampleRate }
    stems.push({
      id: String(id),
      name: stem.name === undefined || stem.name === null ? String(id) : String(stem.name),
      file,
      path: target,
      bytes: bytes.length,
      sha256: sha256(bytes),
      frames: decoded.channels[0].length,
      durationSeconds: metrics.durationSeconds,
      peakDbfs: metrics.peakDbfs,
      rmsDbfs: metrics.rmsDbfs,
      crestDb: metrics.crestDb,
      clipping: metrics.clipping,
      gainDb: roundTo(Number(stem.gainDb ?? 0), 2),
      offsetSeconds: roundTo(Number(stem.offsetSeconds ?? 0), 6),
      metrics
    })
  }

  const masterBuffers = channels === 2 ? [rendered.master.samples, rendered.master.samples] : [rendered.master.samples]
  const masterBytes = encodeWavEx(masterBuffers, sampleRate, { bitDepth, channels, dither: false })
  const masterDecoded = decodeWav(masterBytes)
  if (masterDecoded.channels.length !== channels || masterDecoded.sampleRate !== sampleRate) {
    fail(caller, `master encoder produced ${masterDecoded.channels.length} channel(s) at ${masterDecoded.sampleRate} Hz, expected ${channels} at ${sampleRate}`)
  }
  const masterPath = join(outDir, 'master.wav')
  await writeFileAtomic(masterPath, masterBytes)
  const masterMetrics = { ...measure(averageChannels(masterDecoded.channels), sampleRate), sampleRate }
  const master = {
    id: 'master',
    file: 'master.wav',
    path: masterPath,
    bytes: masterBytes.length,
    sha256: sha256(masterBytes),
    frames: masterDecoded.channels[0].length,
    durationSeconds: masterMetrics.durationSeconds,
    peakDbfs: masterMetrics.peakDbfs,
    rmsDbfs: masterMetrics.rmsDbfs,
    crestDb: masterMetrics.crestDb,
    clipping: masterMetrics.clipping,
    gainDb: roundTo(Number(rendered.master.gainDb ?? 0), 2),
    limiterEngaged: rendered.master.limiterEngaged === true,
    metrics: masterMetrics
  }

  const files = [...stems, master]
  let manifestPath = null
  let manifestEntry = null
  if (includeManifest) {
    const reconstruction = rendered.reconstruction ?? {}
    const manifest = {
      format: 'dsh-audio-stems',
      version: 1,
      sampleRate,
      bitDepth,
      channels,
      frames,
      durationSeconds: roundTo(durationSeconds, 6),
      master: fileRecord(master),
      stems: stems.map(fileRecord),
      reconstruction: {
        maxAbsError: Number(reconstruction.maxAbsError ?? 0),
        sumPeakDbfs: reconstruction.sumPeakDbfs ?? masterMetrics.peakDbfs,
        preMasterPeakDbfs: reconstruction.preMasterPeakDbfs ?? masterMetrics.peakDbfs,
        masterGainDb: reconstruction.masterGainDb ?? master.gainDb,
        limiterEngaged: reconstruction.limiterEngaged === true,
        tolerance: STEM_LIMITS.reconstructionTolerance
      }
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    manifestPath = join(outDir, 'stems.json')
    await writeFileAtomic(manifestPath, manifestBytes)
    manifestEntry = {
      file: 'stems.json',
      path: manifestPath,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes)
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0) + (manifestEntry === null ? 0 : manifestEntry.bytes)
  return {
    outDir,
    sampleRate,
    bitDepth,
    channels,
    frames,
    durationSeconds: roundTo(durationSeconds, 6),
    stems,
    master,
    files,
    manifestPath,
    manifest: manifestEntry,
    totalBytes,
    reconstruction: rendered.reconstruction ?? null
  }
}

/* ---------------------------------------------------------- score stems -- */
/*
 * `stemsFromScore(score, options)` is deliberately not implemented.
 *
 * A compose score has per-track structure (`score.tracks`), but `renderScore`
 * is the only code that knows how to turn a track into samples: the voice
 * dispatch, the per-track RMS levelling, the master tone filter, the reverb,
 * the DC block and the loop fold all live inside that one function, and none of
 * those internals are exported. Printing score stems would require extracting
 * the per-track render loop into a shared helper and defining where stems sit
 * relative to the nonlinear master bus. That is a refactor of
 * `lib/compose.js`, well beyond the one-line export this brief allows, and it
 * would put the byte-identical `renderScore` output at risk.
 *
 * Proposed minimal addition for a future pass (not written here):
 *
 *   // lib/compose.js
 *   export function renderScoreStems (score, options = {}) {
 *     // returns [{ id, samples }]: each track after its gainDb->RMS levelling,
 *     // before masterTone/reverb/dcBlock/normalisation, on the loop-folded or
 *     // tail length the master uses.
 *   }
 *
 * The stem renderer here would then call it and hand the tracks to
 * `renderStems`, which owns the master bus and the reconstruction assert.
 * Until then the tool stays mix-based: `audio_stems` takes rendered tracks
 * (files or inline render specs), not a score.
 */
