/**
 * Sound -> cue sheet: the reverse of `audio_bind`.
 *
 * `audio_beats` answers "where is the grid"; this module answers "where are the
 * hits, and where does the scene change". Both detectors share one level
 * envelope, and both are deliberately simple enough to explain in one sentence:
 *
 *   1. **onset** - a *sharp* jump of the short-term level, in decibels, above an
 *      adaptive local threshold. Working in dB is what makes the detector
 *      survive real material: a stationary noise bed fluctuates by a fraction of
 *      a dB per hop, while an impact jumps tens of dB, so the threshold does not
 *      have to scale with the file's loudness. The threshold is the local median
 *      plus four local mean deviations plus an absolute floor, so a quiet
 *      passage is judged against its own neighbourhood; a sharpness test rejects
 *      a slow swell, which has the same total rise but is not an impact. The
 *      candidate time is then refined to the first sample of the attack, so `at`
 *      is not quantised to the analysis hop.
 *   2. **section** - a *sustained* level change, measured over one second on each
 *      side of a 100 ms boundary. A transient of the same size does not last a
 *      second and cannot produce one; a slow amplitude ramp that is not a hit
 *      shows up here. When a section boundary coincides with an onset (a hit that
 *      permanently changes the level), the cue is reported as `section` because
 *      that is the larger structural fact.
 *
 * Determinism and monotonicity are part of the contract:
 *
 *   - the analysis never reads the clock, never uses `Math.random`, and its
 *     output depends only on (samples, sampleRate, options), so two runs on the
 *     same file are byte-identical;
 *   - `sensitivity` only moves a threshold. Candidates are computed
 *     independently of it and filtering is a superset relation, and the final
 *     minimum-spacing pick walks candidates in time order (the greedy that
 *     maximises the number of picks for a fixed spacing). A higher sensitivity
 *     can therefore only keep or add cues, never remove one - the property the
 *     test suite pins down.
 *
 * Limitations are documented and not hidden here: this is an impact detector,
 * not a music transcriber. A reverb tail, a legato note change or a sustained
 * pad can be missed or double-counted, and the section detector only sees
 * loudness, not instrumentation.
 */

import { clamp } from './dsp.js'

/** Cue kinds this detector can emit. */
export const CUE_KINDS = Object.freeze(['onset', 'section'])

/** Defaults documented on the `audio_cues` tool. */
export const CUE_DEFAULTS = Object.freeze({
  sensitivity: 0.5,
  minGapSeconds: 0.08,
  maxCues: 200
})

/** A file quieter than this peak frame RMS is treated as silence. */
const SILENCE_RMS = 1e-3
/** Analysis hop and smoothing window: a 5 ms hop keeps attack timing precise. */
const HOP_SECONDS = 0.005
const WINDOW_SECONDS = 0.01
/** The recent dip an impact must rise out of: 15 ms, shorter than a flam. */
const BRIDGE_SECONDS = 0.015
/** Half-window of the adaptive threshold's local median: 150 ms. */
const MEDIAN_SECONDS = 0.15
/** A jump narrower than this is an attack; wider is a swell, not an impact. */
const SHARP_SECONDS = 0.03
/** Absolute onset floor in dB, from sensitivity 0 to 1. */
const ONSET_DB_AT_ZERO = 12
const ONSET_DB_AT_ONE = 4
/** Section analysis: 100 ms blocks, 10 blocks (1 s) on each side. */
const SECTION_HOP_SECONDS = 0.1
const SECTION_WINDOW_BLOCKS = 10
const SECTION_REFRACTORY_SECONDS = 0.5
/** The level after a boundary must hold still for the change to be a section. */
const SECTION_STABILITY_DB = 4
/** Section threshold in dB, from sensitivity 0 to 1. */
const SECTION_DB_AT_ZERO = 12
const SECTION_DB_AT_ONE = 6

/** `undefined`/`NaN` fall back to the documented default. */
function finiteOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function round (value, digits) {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

/** Accept a typed array / plain array without copying a Float32Array. */
function asSamples (samples) {
  if (samples instanceof Float32Array) return samples
  if (Array.isArray(samples) || ArrayBuffer.isView(samples)) return Float32Array.from(samples)
  throw new TypeError('cues: samples must be an array-like of numbers')
}

/**
 * Overlapping per-hop RMS of the locally mean-removed signal, plus the loudest hop.
 *
 * The 10 ms window is two hops long, so a click still produces a steep level
 * curve while stationary noise is averaged down enough that its own fluctuations
 * stay well below the dB threshold. Removing the mean per window (not once for
 * the whole file) keeps a silent hop at exactly zero RMS even when a decaying
 * click leaves a small DC residual in the global average - that global-mean
 * version reported a phantom impact at 0 s.
 */
function frameRms (signal, hop, window) {
  const frames = Math.ceil(signal.length / hop)
  const rms = new Float64Array(frames)
  let peak = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hop
    const end = Math.min(signal.length, start + window)
    const length = Math.max(1, end - start)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += signal[i]
    const localMean = sum / length
    let squares = 0
    for (let i = start; i < end; i += 1) {
      const value = signal[i] - localMean
      squares += value * value
    }
    const value = Math.sqrt(squares / length)
    rms[frame] = value
    if (value > peak) peak = value
  }
  return { rms, peak }
}

/**
 * Rise in dB over the recent dip.
 *
 * Comparing hop f with the *minimum* of the previous few hops (a 15 ms bridge)
 * measures the whole jump of an attack instead of one hop of it: the smoothing
 * window spreads a click's level climb over two hops, so a plain hop-to-hop
 * difference would see only half of the jump. A stationary bed's own
 * fluctuations stay a couple of dB because they are symmetric around the local
 * level, and a slow swell rises by a fraction of a dB per hop - neither can
 * reach the absolute threshold.
 *
 * Frame 0 is compared with digital silence so a file that starts with a hit
 * still reports that hit; a file that starts with room tone does too, which is
 * the honest reading of "the sound began here".
 */
function levelRise (rms, epsilon, bridge) {
  const levels = new Float64Array(rms.length)
  for (let frame = 0; frame < rms.length; frame += 1) {
    levels[frame] = 20 * Math.log10(rms[frame] + epsilon)
  }
  const rise = new Float64Array(rms.length)
  const silence = 20 * Math.log10(epsilon)
  rise[0] = Math.max(0, levels[0] - silence)
  let peak = rise[0]
  for (let frame = 1; frame < rms.length; frame += 1) {
    let floor = levels[frame - 1]
    const from = Math.max(0, frame - bridge)
    for (let i = from; i < frame; i += 1) if (levels[i] < floor) floor = levels[i]
    const delta = levels[frame] - floor
    rise[frame] = delta > 0 ? delta : 0
    if (rise[frame] > peak) peak = rise[frame]
  }
  return { rise, peak }
}

/**
 * Whether a rise peak is narrow enough to be an attack.
 *
 * A click's rise spans a few hops at most; a 300 ms swell spans dozens. The
 * width is measured at half the peak's height on both sides, so a slow ramp
 * with one local maximum in the middle is rejected instead of being reported as
 * one giant impact.
 */
function isSharpRise (rise, frame, value, maxWidthFrames) {
  const half = value * 0.5
  let left = frame
  let right = frame
  while (left > 0 && rise[left - 1] >= half) left -= 1
  while (right + 1 < rise.length && rise[right + 1] >= half) right += 1
  return right - left + 1 <= maxWidthFrames
}

/** First sample of the attack inside one hop, relative to that hop's mean. */
function refineOnset (signal, frame, hop, window, rate) {
  const start = frame * hop
  const end = Math.min(signal.length, start + window)
  const length = Math.max(1, end - start)
  let sum = 0
  for (let i = start; i < end; i += 1) sum += signal[i]
  const localMean = sum / length
  let peak = 0
  for (let i = start; i < end; i += 1) {
    const value = Math.abs(signal[i] - localMean)
    if (value > peak) peak = value
  }
  if (!(peak > 0)) return start / rate
  const gate = Math.max(peak * 0.2, 1e-6)
  for (let i = start; i < end; i += 1) {
    if (Math.abs(signal[i] - localMean) >= gate) return i / rate
  }
  return start / rate
}

/**
 * Onset candidates, filtered by the adaptive dB threshold.
 *
 * The threshold depends on `sensitivity`; the candidates themselves do not, so
 * lowering the threshold only reveals more of the same list.
 */
function onsetCandidates (signal, rate, rms, peakRms, sensitivity) {
  const hop = Math.max(1, Math.round(rate * HOP_SECONDS))
  const window = Math.max(hop, Math.round(rate * WINDOW_SECONDS))
  const bridge = Math.max(1, Math.round(BRIDGE_SECONDS / HOP_SECONDS))
  const epsilon = Math.max(peakRms * 1e-4, 1e-9)
  const { rise, peak: peakRise } = levelRise(rms, epsilon, bridge)
  if (!(peakRise > 0)) return []
  const hopSeconds = hop / rate
  const half = Math.max(2, Math.round(MEDIAN_SECONDS / hopSeconds))
  const scratch = new Float64Array(half * 2 + 1)
  const threshold = new Float64Array(rise.length)
  const minDb = ONSET_DB_AT_ZERO - (ONSET_DB_AT_ZERO - ONSET_DB_AT_ONE) * sensitivity
  for (let frame = 0; frame < rise.length; frame += 1) {
    const from = Math.max(0, frame - half)
    const to = Math.min(rise.length, frame + half + 1)
    let count = 0
    for (let i = from; i < to; i += 1) {
      scratch[count] = rise[i]
      count += 1
    }
    scratch.subarray(0, Math.max(1, count)).sort()
    const median = scratch[count >> 1]
    let deviation = 0
    for (let i = 0; i < count; i += 1) deviation += Math.abs(scratch[i] - median)
    // Median + spread tracks a noisy neighbourhood; the absolute dB floor is
    // what a stationary bed can never cross no matter how loud it is.
    threshold[frame] = median + (deviation / Math.max(1, count)) * 4 + minDb
  }
  const maxWidthFrames = Math.max(2, Math.round(SHARP_SECONDS / hopSeconds))
  const onsets = []
  for (let frame = 0; frame < rise.length; frame += 1) {
    const value = rise[frame]
    if (!(value >= threshold[frame])) continue
    const left = frame > 0 ? rise[frame - 1] : -Infinity
    const right = frame + 1 < rise.length ? rise[frame + 1] : -Infinity
    // Local maximum: strict on the left so a plateau is accepted only once.
    if (value <= left || value < right) continue
    if (!isSharpRise(rise, frame, value, maxWidthFrames)) continue
    onsets.push({
      at: refineOnset(signal, frame, hop, window, rate),
      strength: clamp(value / peakRise, 0, 1),
      kind: 'onset'
    })
  }
  return onsets
}

/**
 * Section candidates: sustained energy steps on a coarse grid.
 *
 * Two one-second windows (10 blocks each) are compared; both must carry signal,
 * because a step from silence is an onset's job. The level after the boundary
 * must hold still for half a window, which is what separates a section change
 * from a decay ending. Candidates are then thinned to one per half second
 * (strongest first) so a noisy plateau around one step cannot produce a burst
 * of section cues.
 */
function sectionCandidates (signal, rate, peakRms, sensitivity) {
  const hop = Math.max(1, Math.round(rate * SECTION_HOP_SECONDS))
  const blocks = Math.floor(signal.length / hop)
  const width = SECTION_WINDOW_BLOCKS
  if (blocks < width * 2 + 2) return []
  const energy = new Float64Array(blocks)
  for (let block = 0; block < blocks; block += 1) {
    const start = block * hop
    let sum = 0
    for (let i = start; i < start + hop; i += 1) sum += signal[i] * signal[i]
    energy[block] = sum / hop
  }
  const prefix = new Float64Array(blocks + 1)
  for (let block = 0; block < blocks; block += 1) prefix[block + 1] = prefix[block] + energy[block]
  const minimumEnergy = Math.max(1e-10, peakRms * peakRms * 1e-5)
  const thresholdDb = SECTION_DB_AT_ZERO - (SECTION_DB_AT_ZERO - SECTION_DB_AT_ONE) * sensitivity
  const deltas = new Float64Array(blocks + 1)
  deltas.fill(-Infinity)
  for (let boundary = width; boundary + width <= blocks; boundary += 1) {
    const before = (prefix[boundary] - prefix[boundary - width]) / width
    const after = (prefix[boundary + width] - prefix[boundary]) / width
    if (before < minimumEnergy || after < minimumEnergy) continue
    // A decay is not a section: the level after the boundary has to settle.
    const halfWidth = width >> 1
    const afterFirst = (prefix[boundary + halfWidth] - prefix[boundary]) / halfWidth
    const afterSecond = (prefix[boundary + width] - prefix[boundary + halfWidth]) / halfWidth
    if (afterFirst < minimumEnergy || afterSecond < minimumEnergy) continue
    const stability = Math.abs(10 * Math.log10(afterSecond / afterFirst))
    if (!(stability <= SECTION_STABILITY_DB)) continue
    deltas[boundary] = Math.abs(10 * Math.log10(after / before))
  }
  const raw = []
  for (let boundary = width; boundary + width <= blocks; boundary += 1) {
    const value = deltas[boundary]
    if (!(value >= thresholdDb)) continue
    const left = deltas[boundary - 1]
    const right = boundary + 1 <= blocks ? deltas[boundary + 1] : -Infinity
    if (value <= left || value < right) continue
    raw.push({
      at: boundary * hop / rate,
      strength: clamp(value / 30, 0.05, 1),
      kind: 'section'
    })
  }
  // Strongest first, then keep half-second spacing: one boundary per change.
  raw.sort((a, b) => b.strength - a.strength || a.at - b.at)
  const sections = []
  for (const candidate of raw) {
    if (sections.some((kept) => Math.abs(kept.at - candidate.at) < SECTION_REFRACTORY_SECONDS)) continue
    sections.push(candidate)
  }
  sections.sort((a, b) => a.at - b.at)
  return sections
}

/**
 * Detect impact points and section boundaries in a mono signal.
 *
 * @param {Float32Array|number[]} samples - mono samples (the tool folds stereo).
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {number} [options.sensitivity=0.5] - 0..1; higher keeps weaker hits.
 *   The number of cues is monotonically non-decreasing in this value.
 * @param {number} [options.minGapSeconds=0.08] - minimum spacing; a later cue
 *   closer than this to an accepted one is dropped, so a flam counts once.
 * @param {number} [options.maxCues=200] - cap; the strongest cues are kept and
 *   a warning reports how many were dropped.
 * @returns {{ cues: Array<{ at: number, strength: number, kind: string }>, durationSeconds: number, sampleRate: number, warnings: string[] }}
 */
export function detectCues (samples, sampleRate, options = {}) {
  const signal = asSamples(samples)
  const rate = Number(sampleRate)
  const warnings = []
  const summary = (cues) => ({
    cues,
    durationSeconds: rate > 0 ? round(signal.length / rate, 3) : 0,
    sampleRate: rate > 0 ? rate : 0,
    warnings
  })
  if (!(rate > 0) || !Number.isFinite(rate)) {
    warnings.push('cues: sampleRate must be a positive number; no analysis was run')
    return summary([])
  }
  if (signal.length === 0) {
    warnings.push('cues: the audio has no samples (0 frames); no cues')
    return summary([])
  }

  const sensitivity = clamp(finiteOr(options.sensitivity, CUE_DEFAULTS.sensitivity), 0, 1)
  const minGap = clamp(finiteOr(options.minGapSeconds, CUE_DEFAULTS.minGapSeconds), 0.005, 1)
  const maxCues = Math.max(1, Math.round(clamp(finiteOr(options.maxCues, CUE_DEFAULTS.maxCues), 1, 1000)))

  const hop = Math.max(1, Math.round(rate * HOP_SECONDS))
  const window = Math.max(hop, Math.round(rate * WINDOW_SECONDS))
  const { rms, peak } = frameRms(signal, hop, window)
  if (peak < SILENCE_RMS) {
    warnings.push(`cues: the audio is (near-)silent (peak frame RMS ${round(peak, 6)}); no cues`)
    return summary([])
  }

  const sections = sectionCandidates(signal, rate, peak, sensitivity)
  const candidates = [
    ...onsetCandidates(signal, rate, rms, peak, sensitivity),
    ...sections
  ]
  // Time order maximises the number of picks for a fixed spacing, and makes the
  // count monotone when a lower sensitivity hides candidates: every cue kept at
  // a high threshold is still kept when the threshold drops.
  candidates.sort((a, b) => a.at - b.at || b.strength - a.strength || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  const accepted = []
  let lastAt = -Infinity
  for (const candidate of candidates) {
    if (candidate.at - lastAt < minGap) continue
    accepted.push(candidate)
    lastAt = candidate.at
  }

  // A hit that starts a lasting level change is the section boundary too; the
  // larger fact is the more useful label for the animation.
  const sectionTimes = sections.map((section) => section.at)
  for (const cue of accepted) {
    if (cue.kind !== 'onset') continue
    if (sectionTimes.some((at) => Math.abs(at - cue.at) < minGap)) cue.kind = 'section'
  }

  let cues = accepted
  if (cues.length > maxCues) {
    const dropped = cues.length - maxCues
    const kept = cues.slice().sort((a, b) => b.strength - a.strength || a.at - b.at).slice(0, maxCues)
    kept.sort((a, b) => a.at - b.at || b.strength - a.strength)
    cues = kept
    warnings.push(`cues: kept the strongest ${maxCues} of ${maxCues + dropped} cues (maxCues=${maxCues}); ${dropped} weaker cue(s) dropped`)
  }

  return summary(cues.map((cue) => ({
    at: round(cue.at, 4),
    strength: round(cue.strength, 3),
    kind: cue.kind
  })))
}
