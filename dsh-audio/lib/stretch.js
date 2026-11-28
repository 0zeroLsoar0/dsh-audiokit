/**
 * WSOLA time-stretching and pitch shifting: fit a sound to a duration the
 * render did not agree to.
 *
 * Animation work constantly needs audio that fits a *different* length than the
 * render: a 6 s cue must land on a 4.3 s shot, a 2 s loop must become 8 s, a
 * voice take must be 5 % faster. Resampling is the wrong tool for all three —
 * it changes pitch with speed, which is exactly the chipmunk artifact this
 * module exists to avoid.
 *
 * The core is WSOLA (waveform-similarity overlap-add), a time-domain method:
 * frames are cut out of the input at a hop derived from the factor, each frame
 * is moved to the offset whose waveform best continues the previous frame
 * (normalised cross-correlation, coarse-to-fine), and the frames are crossfaded
 * back together with a Hann window at 75 % overlap. Two consequences matter:
 *   - no FFT and no dependency: it is arithmetic on typed arrays only;
 *   - the output length is exact by construction (it is the accumulator size),
 *     so a "4.3 s" shot is 4.300 s rather than "about 4.3 s".
 *
 * Three details do most of the work on quality:
 *   - the splice position is refined below a sample (parabolic correlation peak
 *     plus a windowed-sinc readout). Rounding it to a whole sample detunes a
 *     sustained tone by a fraction of a percent, which is audible as a slow
 *     wobble over a few seconds;
 *   - detected attacks are anchored: every frame that covers an attack copies it
 *     to the same output sample, so a hit is not spread thin and shifted early
 *     by the crossfade (see `anchorBounds`);
 *   - the last overlap-add window is faded, so a cue never ends on a
 *     discontinuity.
 *
 * That tail fade is right for a one-shot and wrong for a loop: a stretched loop
 * ends on silence, so the repeat would drop out. Loops are better re-rendered at
 * the required length (`renderPreset({ loop: true, duration })`) than stretched,
 * because only the renderer knows where the seam is.
 *
 * Formants are NOT preserved. A pitch shift is a stretch by the pitch ratio
 * followed by a resample back to the original length, and the resample moves
 * the whole spectral envelope along with the fundamental: +7 semitones on a
 * voice raises its formants by 1.50x, which reads as a smaller/thinner speaker.
 * That is right for creature and cartoon effects and wrong for dubbing a human,
 * so do not use pitchShift to nudge an actor's key.
 *
 * Pure module: no imports at all (not even ./dsp.js) so it can be lifted into
 * another plugin or a worker unchanged. Every export returns a fresh
 * Float32Array and never mutates its input.
 */

/* --------------------------------------------------------------- limits -- */

const MIN_FACTOR = 0.25
const MAX_FACTOR = 4
const MAX_SEMITONES = 24
// Below this many samples a cue is a click, not a cue: the WSOLA search has no
// material to correlate, so those inputs are resampled instead (pitch moves).
const MIN_WORK_SAMPLES = 64
const MIN_FRAME_SIZE = 64
const MAX_FRAME_SIZE = 4096
const DEFAULT_OVERLAP = 0.75
// 12 ms: long enough that a voice fundamental down to ~90 Hz can be
// phase-locked, short enough that the overlap-add smear of an un-anchored
// transient stays inside a few milliseconds.
const DEFAULT_FRAME_SECONDS = 0.012
// How far the similarity search may move a frame from its nominal position.
// This is the classic WSOLA trade-off: a wider search locks lower tones and
// costs linearly more time; ~11.6 ms covers fundamentals above roughly 86 Hz.
const DEFAULT_TOLERANCE_SECONDS = 0.0116
const COARSE_STRIDE = 8
const DEFAULT_FADE_SECONDS = 0.002
const RESAMPLE_HALF = 8
const SINC_RESOLUTION = 256
// Support of the fractional-delay kernel used to place a frame between two
// input samples. 32 taps keeps the interpolation flat well into the top octave;
// a 16-tap kernel starts to shelve the treble of a shifted cue.
const FRAME_INTERP_HALF = 16
// Two waveform matches whose normalised correlation differ by less than this
// are treated as equally good, and the one nearer the nominal analysis position
// wins. The window is derived from the local peak curvature so that it always
// spans about half a search step: wide enough to prefer the rate-correct one of
// two equal matches, narrow enough that it can never drag a splice off a peak
// (the correlation peak of a low note is tens of samples wide, and a fixed
// window there would detune the note). The cap is what keeps the rule useful on
// near-miss matches: a one-sample phase error on a 1 kHz tone still scores 0.99,
// and treating that as "not a tie" is what leaves a sub-cent detune at the
// extreme factors.
const TIE_TOLERANCE_MIN = 1e-6
const TIE_TOLERANCE_MAX = 0.02
// Attack detector: envelope resolution, and how big a jump (and how loud) a
// block has to be to count as an onset worth anchoring a frame to.
const ONSET_BLOCK_SECONDS = 0.004
const ONSET_JUMP_RATIO = 2.2
const ONSET_MIN_LEVEL = 0.08

/**
 * Factor and semitone bounds, exported so tool schemas and error messages do
 * not have to duplicate (and then drift from) the numbers above.
 */
export const STRETCH_LIMITS = Object.freeze({
  minFactor: MIN_FACTOR,
  maxFactor: MAX_FACTOR,
  maxSemitones: MAX_SEMITONES
})

/* -------------------------------------------------------------- helpers -- */

function clamp (value, min, max) {
  return value < min ? min : value > max ? max : value
}

function toFloat32 (samples) {
  if (samples instanceof Float32Array) return samples
  if (samples !== null && typeof samples === 'object' && typeof samples.length === 'number') {
    return Float32Array.from(samples)
  }
  throw new TypeError('stretch: samples must be a Float32Array, Float64Array or number[]')
}

function checkSampleRate (sampleRate) {
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error(`stretch: sampleRate must be between 8000 and 192000 Hz, got ${sampleRate}`)
  }
  return Math.round(rate)
}

/** Hann window (periodic form, so four of them one hop apart sum to a constant). */
function hannWindow (size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return window
}

/**
 * Box-filter and decimate, for the coarse stage of the similarity search: a
 * plain stride sample of broadband audio aliases and would point the search at
 * the wrong offset, so blocks are averaged before they are compared.
 */
function decimate (input, stride) {
  const blocks = Math.floor(input.length / stride)
  const out = new Float64Array(blocks)
  for (let block = 0; block < blocks; block += 1) {
    let sum = 0
    const base = block * stride
    for (let k = 0; k < stride; k += 1) sum += input[base + k]
    out[block] = sum / stride
  }
  return out
}

/* ----------------------------------------------------- resampling kernel -- */

// A windowed-sinc kernel is needed in two places: converting the stretched
// signal back to its original length for a pitch shift, and the degenerate
// short-input fallback. The kernel is tabulated per support width so a tap
// costs two reads instead of a sin() and a cos(). The cache is a memo: same
// arguments in, same bytes out.
const sincTables = new Map()

function sincTable (half) {
  const cached = sincTables.get(half)
  if (cached !== undefined) return cached
  const length = half * SINC_RESOLUTION + 1
  const table = new Float64Array(length)
  for (let i = 0; i < length; i += 1) {
    const x = i / SINC_RESOLUTION
    // Blackman over [-half, half]: zero at the edge, so truncating the taps
    // does not introduce a step.
    const window = x >= half
      ? 0
      : 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half)
    table[i] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window
  }
  sincTables.set(half, table)
  return table
}

function kernelValue (table, x) {
  const position = x * SINC_RESOLUTION
  const index = position | 0
  if (index + 1 >= table.length) return 0
  const fraction = position - index
  const a = table[index]
  return a + (table[index + 1] - a) * fraction
}

/**
 * Resample to an exact frame count with a normalised windowed-sinc kernel.
 * Weights are normalised per output sample, so the edges neither lose level nor
 * pick up a DC step. Downsampling widens the kernel support and lowers its
 * corner, which is what keeps aliases out of the result.
 *
 * The window and the tap count are two different things and used to be
 * conflated: the table's taper must always span the fixed `RESAMPLE_HALF`
 * support, while `half` only says how many input taps the rescaled kernel
 * reaches. Building the table at `half` spreads the Blackman taper over
 * `half * cutoff` in the sinc's own argument, so as soon as `cutoff < 1` (every
 * upward pitch shift) the tap support ends where the window is still at ~0.34
 * instead of 0. That truncation costs the stopband its attenuation and folds
 * the top octave back into the output; a fixed-support window keeps it flat.
 */
function resampleTo (input, outFrames) {
  const inFrames = input.length
  const out = new Float32Array(outFrames)
  if (inFrames === 0) return out
  if (outFrames === inFrames) return input.slice()
  if (inFrames === 1) {
    out.fill(input[0])
    return out
  }
  const step = inFrames / outFrames
  const cutoff = step > 1 ? 1 / step : 1
  // Tap count: the kernel reaches `RESAMPLE_HALF` in its rescaled distance, i.e.
  // `RESAMPLE_HALF / cutoff` input samples — the standard trade that keeps the
  // filter's transition width (in Hz) constant instead of letting heavy
  // downsampling degrade it.
  const half = Math.max(RESAMPLE_HALF, Math.ceil(RESAMPLE_HALF / cutoff))
  const table = sincTable(RESAMPLE_HALF)
  for (let i = 0; i < outFrames; i += 1) {
    const position = i * step
    const center = Math.floor(position)
    const fraction = position - center
    let sum = 0
    let norm = 0
    for (let tap = -half + 1; tap <= half; tap += 1) {
      const index = center + tap
      if (index < 0 || index >= inFrames) continue
      const distance = (fraction - tap) * cutoff
      const magnitude = distance < 0 ? -distance : distance
      // Past the window's support the kernel is zero (and truncated there): the
      // taps that remain are exactly those inside the fixed window.
      if (magnitude >= RESAMPLE_HALF) continue
      const weight = kernelValue(table, magnitude)
      sum += weight * input[index]
      norm += weight
    }
    out[i] = norm === 0 ? 0 : sum / norm
  }
  return out
}

/* ------------------------------------------------------------ WSOLA core -- */

/**
 * Choose which correlation peak to splice on.
 *
 * `scores` are normalised correlations on a regular grid of `spacing` samples
 * starting at `from`. The best sample wins unless another sample is within the
 * curvature-derived tie window, in which case the sample nearest `nominal` wins.
 * This is the rule that keeps a sustained tone on the requested rate: every
 * whole period away from the true continuation is an equally good match, and if
 * the algorithm kept taking the continuation it would stop advancing, then have
 * to jump back — audible as doubling. Because the window is only about half a
 * grid step wide, the chosen sample always sits beside a real peak, so the
 * parabolic refinement afterwards still lands on that peak.
 */
function pickPeak (scores, count, from, spacing, nominal) {
  if (count <= 0) return 0
  let bestIndex = 0
  let bestScore = scores[0]
  for (let index = 1; index < count; index += 1) {
    if (scores[index] > bestScore) {
      bestScore = scores[index]
      bestIndex = index
    }
  }
  let tolerance = TIE_TOLERANCE_MIN
  if (bestIndex > 0 && bestIndex < count - 1) {
    const curvature = 2 * bestScore - scores[bestIndex - 1] - scores[bestIndex + 1]
    if (curvature > 0) {
      tolerance = Math.min(TIE_TOLERANCE_MAX, Math.max(TIE_TOLERANCE_MIN, curvature / 8))
    }
  }
  let chosen = bestIndex
  let bestDistance = Math.abs(from + bestIndex * spacing - nominal)
  for (let index = 0; index < count; index += 1) {
    if (scores[index] < bestScore - tolerance) continue
    const distance = Math.abs(from + index * spacing - nominal)
    if (distance < bestDistance) {
      bestDistance = distance
      chosen = index
    }
  }
  return chosen
}

/**
 * Coarse similarity hint: block-mean correlation at stride resolution. Returns
 * a sample position near the best match, or undefined when there is no block
 * correlation to speak of (silence has nothing to match — the nominal position
 * is the honest answer).
 *
 * Both sides are read out of the same decimated array, i.e. from the same
 * 8-sample grid. Correlating template blocks anchored on the template start
 * against blocks anchored on the global grid instead would compare waveforms
 * that are up to half a block out of phase, which biases a 1 kHz tone by ~57
 * degrees and hands the fine stage a hint from the wrong place.
 *
 * The block grid rounds the template start to a whole block, so the answer is
 * corrected by that rounding: without it the hint can be a full block away from
 * the true peak, which leaves the peak on the edge of the fine search window
 * where the parabolic refinement cannot reach it (measurably: 46 ms frames on a
 * 1 kHz tone went from -66 dB to -28 dB THD+N).
 */
function coarseHint (decimated, stride, templateStart, templateFrames, nominal, lo, hi, scores) {
  const blocks = Math.floor(templateFrames / stride)
  if (blocks < 2) return undefined
  const templateBlock = Math.round(templateStart / stride)
  if (templateBlock + blocks > decimated.length) return undefined
  const firstBlock = Math.ceil(lo / stride)
  const lastBlock = Math.min(Math.floor(hi / stride), decimated.length - blocks)
  if (lastBlock < firstBlock) return undefined
  const blockOffset = templateStart - templateBlock * stride

  const template = new Float64Array(blocks)
  let templateEnergy = 0
  for (let j = 0; j < blocks; j += 1) {
    const value = decimated[templateBlock + j]
    template[j] = value
    templateEnergy += value * value
  }
  if (templateEnergy <= 1e-12) return undefined

  let count = 0
  for (let block = firstBlock; block <= lastBlock; block += 1) {
    let dot = 0
    let energy = 0
    for (let j = 0; j < blocks; j += 1) {
      const value = decimated[block + j]
      dot += template[j] * value
      energy += value * value
    }
    scores[count] = dot / Math.sqrt(energy * templateEnergy + 1e-18)
    count += 1
  }
  const index = pickPeak(scores, count, firstBlock * stride, stride, nominal)
  return (firstBlock + index) * stride + blockOffset
}

/**
 * Kernel taps for a fractional delay, normalised to unity gain.
 *
 * The kernel depends only on the fractional part, so it is built once per frame
 * and then reused by every sample of that frame: a 529-sample frame costs 32
 * multiply-adds per sample instead of 32 table lookups.
 */
function buildKernel (fraction, half, table, weights) {
  let norm = 0
  for (let tap = -half + 1; tap <= half; tap += 1) {
    const distance = fraction - tap
    let weight = 0
    if (distance > -half && distance < half) {
      weight = kernelValue(table, distance < 0 ? -distance : distance)
    }
    weights[tap + half - 1] = weight
    norm += weight
  }
  if (norm !== 0) {
    for (let i = 0; i < weights.length; i += 1) weights[i] /= norm
  }
}

/** Read `length` samples from a fractional position with the taps from buildKernel. */
function readFrame (input, position, length, half, weights, out) {
  const inFrames = input.length
  const center = Math.floor(position)
  const span = 2 * half
  const safeFrom = Math.max(0, half - 1 - center)
  const safeTo = Math.min(length - 1, inFrames - 1 - half - center)
  for (let j = 0; j < length; j += 1) {
    let base = center + j - half + 1
    let sum = 0
    if (j >= safeFrom && j <= safeTo) {
      for (let k = 0; k < span; k += 1, base += 1) sum += weights[k] * input[base]
      out[j] = sum
      continue
    }
    // Only the very first and very last frames touch the buffer edge.
    let norm = 0
    for (let k = 0; k < span; k += 1, base += 1) {
      if (base < 0 || base >= inFrames) continue
      sum += weights[k] * input[base]
      norm += weights[k]
    }
    out[j] = norm !== 0 ? sum / norm : 0
  }
}

/**
 * Pick the analysis position for one synthesis frame: coarse block search, then
 * full-resolution normalised cross-correlation within one stride of the hint,
 * then a tie-break, then a parabolic refinement.
 *
 * The tie-break is what keeps a sustained tone honest. Every whole period away
 * from the true continuation is an equally good match, and the perfect
 * continuation is always available inside the search radius; if it wins, the
 * frame stops advancing at the requested rate and the following frames have to
 * jump back — audible as doubling. Among matches inside TIE_TOLERANCE the one
 * nearest the nominal analysis position wins instead.
 *
 * The parabolic vertex turns the integer offset into a fractional one. Rounding
 * the splice to a whole sample is not harmless: on a 1 kHz tone at 44.1 kHz a
 * half-sample phase step per hop is a 0.2 % detune, which is exactly the kind of
 * slow pitch wobble that makes a stretched cue sound seasick.
 *
 * Returns a fractional frame start, or undefined when the template is silence.
 */
function findStart (input, decimated, stride, templateStart, templateFrames, nominal, lo, hi, scores, coarseScores) {
  if (hi <= lo) return lo

  let templateEnergy = 0
  for (let j = 0; j < templateFrames; j += 1) {
    const value = input[templateStart + j]
    templateEnergy += value * value
  }
  // Silence has no waveform to match; the nominal position is the honest answer
  // and it avoids dividing by a near-zero energy.
  if (templateEnergy <= 1e-12) return undefined

  let from = lo
  let to = hi
  if (stride > 1) {
    const hint = coarseHint(decimated, stride, templateStart, templateFrames, nominal, lo, hi, coarseScores)
    if (hint !== undefined) {
      from = Math.max(lo, hint - stride)
      to = Math.min(hi, hint + stride)
    }
  }

  const count = to - from + 1
  let energy = 0
  for (let j = 0; j < templateFrames; j += 1) {
    const value = input[from + j]
    energy += value * value
  }
  for (let index = 0; index < count; index += 1) {
    const start = from + index
    if (index > 0) {
      const leaving = input[start - 1]
      const entering = input[start + templateFrames - 1]
      energy += entering * entering - leaving * leaving
    }
    let dot = 0
    for (let j = 0; j < templateFrames; j += 1) {
      dot += input[templateStart + j] * input[start + j]
    }
    scores[index] = dot / Math.sqrt((energy > 0 ? energy : 0) * templateEnergy + 1e-18)
  }

  const bestIndex = pickPeak(scores, count, from, 1, nominal)
  let refine = 0
  if (bestIndex > 0 && bestIndex < count - 1) {
    const left = scores[bestIndex - 1]
    const middle = scores[bestIndex]
    const right = scores[bestIndex + 1]
    const denominator = left - 2 * middle + right
    if (denominator < -1e-12) refine = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
  }
  return from + bestIndex + refine
}

/**
 * The last window ends mid-rise, so the raw overlap-add output can stop at a
 * non-zero value and click when the file ends. A short raised-cosine fade on the
 * tail costs nothing musically and removes that click; the trade-off is that
 * content living only inside the final two milliseconds is attenuated, which
 * only matters if a cue was authored to end exactly on a hit. There is
 * deliberately no matching fade on the head: the head is reproduced
 * sample-exactly so an attack is never softened, and a click that exists at the
 * start of the input is not created here.
 */
function applyTailFade (out, rate, options) {
  const seconds = Number.isFinite(options.fadeOutSeconds) ? Number(options.fadeOutSeconds) : DEFAULT_FADE_SECONDS
  if (seconds <= 0) return
  const fade = Math.min(Math.round(seconds * rate), Math.floor(out.length / 4))
  if (fade < 2) return
  for (let k = 0; k < fade; k += 1) {
    out[out.length - 1 - k] *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fade)
  }
}

/**
 * Detect attack positions (sample indices) in the input.
 *
 * Only *jumps* count: a sustained tone, a noise bed or a loop has no onset and
 * is stretched exactly as it would be without this pass. The detector runs on a
 * 4 ms peak envelope, requires a 2.2x jump over the loudest of the four blocks
 * before it, and then refines to the first sample above a tenth of the block
 * peak so an anchor is accurate to a sample rather than to 4 ms.
 *
 * @param {Float32Array} input - mono signal.
 * @param {number} rate - Hz, sets the envelope resolution.
 * @returns {number[]} sample indices of detected attacks, ascending.
 */
function detectOnsets (input, rate) {
  const block = Math.max(8, Math.round(rate * ONSET_BLOCK_SECONDS))
  const blocks = Math.floor(input.length / block)
  if (blocks < 8) return []
  const level = new Float64Array(blocks)
  let peak = 0
  for (let b = 0; b < blocks; b += 1) {
    let value = 0
    for (let i = b * block; i < (b + 1) * block; i += 1) {
      const magnitude = Math.abs(input[i])
      if (magnitude > value) value = magnitude
    }
    level[b] = value
    if (value > peak) peak = value
  }
  if (peak < 1e-4) return []
  const floor = peak * ONSET_MIN_LEVEL
  const onsets = []
  let last = -Infinity
  for (let b = 1; b < blocks; b += 1) {
    if (level[b] <= floor) continue
    let previous = 0
    for (let k = Math.max(0, b - 4); k < b; k += 1) {
      if (level[k] > previous) previous = level[k]
    }
    if (level[b] <= previous * ONSET_JUMP_RATIO) continue
    const threshold = level[b] * 0.1
    const from = Math.max(0, (b - 1) * block)
    const to = Math.min(input.length, (b + 1) * block)
    let at = b * block
    for (let i = from; i < to; i += 1) {
      if (Math.abs(input[i]) > threshold) {
        at = i
        break
      }
    }
    if (at - last < block) continue
    onsets.push(at)
    last = at
  }
  return onsets
}

/**
 * Transient anchoring, expressed as a bound on this frame's analysis window
 * rather than a forced position.
 *
 * Overlap-add alone smears an attack: each frame that reads the transient copies
 * it to a different output sample, weighted by the window, so the hit arrives
 * early by about a quarter of a frame and its leading edge softens. The fix is
 * to make every frame that covers the transient's scaled output time copy the
 * transient to that same sample, and to push the other frames clear of it.
 *
 * Returns either `{ forced }` — this frame owns the onset and must place it at
 * `forced` — or `{ lo, hi }`, the window the similarity search may use.
 *
 * @param {{start: number, out: number}[]} anchors - detected attacks.
 * @param {number} cursor - index of the first anchor whose output time is not behind.
 * @param {number} position - this frame's output position.
 * @param {number} nominal - rate-correct analysis position.
 * @param {number} frameSize - window length in samples.
 * @param {number} tolerance - search radius in samples.
 * @param {number} maxStart - largest legal analysis start.
 */
function anchorBounds (anchors, cursor, position, nominal, frameSize, tolerance, maxStart) {
  let lo = Math.max(0, nominal - tolerance)
  let hi = Math.min(maxStart, nominal + tolerance)
  const inside = anchors[cursor]
  if (inside !== undefined && inside.out < position + frameSize) {
    return { forced: clamp(position + inside.start - inside.out, 0, maxStart) }
  }
  // Never read across an onset that has already been placed, and never let the
  // window reach into an onset that is still ahead: either would add a second
  // copy of the attack somewhere the onset does not belong.
  const behind = anchors[cursor - 1]
  if (behind !== undefined && lo < behind.start) lo = behind.start
  const ahead = anchors[cursor]
  if (ahead !== undefined) hi = Math.min(hi, ahead.start - frameSize)
  if (hi < lo) hi = lo
  return { lo, hi }
}

/** The overlap-add engine. Callers have already validated rate and ratio. */
function wsola (input, rate, ratio, options) {
  const frames = input.length
  const outFrames = Math.max(1, Math.round(frames * ratio))
  const overlap = clamp(Number(options.overlap ?? DEFAULT_OVERLAP), 0.5, 0.875)
  const requestedFrame = Number.isFinite(options.frameSize)
    ? Math.round(Number(options.frameSize))
    : Math.round(rate * DEFAULT_FRAME_SECONDS)
  let frameSize = clamp(requestedFrame, MIN_FRAME_SIZE, MAX_FRAME_SIZE)
  // The search correlates a frame against its own continuation, so the input
  // must be at least two windows long; halve until it is.
  while (frameSize > MIN_FRAME_SIZE && frameSize * 2 > frames) frameSize = Math.floor(frameSize / 2)
  const hop = Math.max(8, Math.round(frameSize * (1 - overlap)))
  const templateFrames = frameSize - hop
  const maxStart = Math.max(0, frames - frameSize)
  const nominalTolerance = Number.isFinite(options.tolerance)
    ? Math.round(Number(options.tolerance))
    : Math.round(rate * DEFAULT_TOLERANCE_SECONDS)
  const tolerance = clamp(nominalTolerance, 0, Math.max(0, maxStart))
  const stride = tolerance >= COARSE_STRIDE * 4 ? COARSE_STRIDE : 1
  const decimated = stride > 1 ? decimate(input, stride) : undefined
  const window = hannWindow(frameSize)
  const accumulator = new Float64Array(outFrames)
  const weights = new Float64Array(outFrames)
  const half = FRAME_INTERP_HALF
  const interpTable = sincTable(half)
  const kernel = new Float64Array(2 * half)
  const frame = new Float32Array(frameSize)
  const scores = new Float64Array(2 * Math.max(tolerance, stride) + 3)
  const coarseScores = new Float64Array(Math.ceil((2 * tolerance) / stride) + 3)
  // Anchors are the attacks that must survive the stretch exactly. Two attacks
  // closer together than a window cannot both be honoured, so the earlier wins.
  const anchors = []
  let previousAnchor = -Infinity
  for (const at of detectOnsets(input, rate)) {
    if (at - previousAnchor < frameSize) continue
    // An onset with less than a window of material behind it cannot be anchored
    // without pushing frames past the end of the buffer, so it keeps the plain
    // overlap-add behaviour instead.
    if (at + frameSize > frames) break
    if (at * ratio >= outFrames) break
    previousAnchor = at
    anchors.push({ start: at, out: at * ratio })
  }
  let anchorCursor = 0
  let previous = 0

  for (let position = 0; position < outFrames; position += hop) {
    // Where this frame would come from if nothing were adjusted: the output
    // clock divided by the factor. Absolute (not accumulated) so a bad match
    // cannot make the timing drift.
    const nominal = clamp(Math.round(position / ratio), 0, maxStart)
    while (anchorCursor < anchors.length && anchors[anchorCursor].out < position) anchorCursor += 1
    const bounds = anchorBounds(anchors, anchorCursor, position, nominal, frameSize, tolerance, maxStart)
    let start
    if (bounds.forced !== undefined) {
      // Rounding costs at most half a sample (11 us) of onset timing, and it
      // keeps the transient out of the fractional-delay kernel: sinc
      // interpolation of a broadband click rings and overshoots by about 2 dB.
      start = clamp(Math.round(bounds.forced), 0, maxStart)
    } else {
      start = clamp(nominal, bounds.lo, bounds.hi)
      if (position > 0 && templateFrames > 1) {
        // The template is the true continuation of the previous frame, i.e. the
        // waveform the new frame has to join. It is read from the integer
        // approximation of the previous start; the fractional part is carried into
        // the read position below so the splice still lands between samples.
        const previousFix = Math.round(previous)
        const templateStart = previousFix + hop
        const found = findStart(input, decimated, stride, templateStart, templateFrames, nominal, bounds.lo, bounds.hi, scores, coarseScores)
        if (found !== undefined) start = found + (previous - previousFix)
        start = clamp(start, bounds.lo, bounds.hi)
      }
    }
    buildKernel(start - Math.floor(start), half, interpTable, kernel)
    readFrame(input, start, frameSize, half, kernel, frame)
    const limit = Math.min(frameSize, outFrames - position)
    for (let j = 0; j < limit; j += 1) {
      const weight = window[j]
      accumulator[position + j] += weight * frame[j]
      weights[position + j] += weight
    }
    previous = start
  }

  const out = new Float32Array(outFrames)
  for (let i = 0; i < outFrames; i += 1) {
    const weight = weights[i]
    // The first sample of the first window is exactly zero; fall back to the
    // source so the file does not start with a hole.
    out[i] = weight > 1e-6 ? accumulator[i] / weight : input[Math.min(i, frames - 1)]
  }
  applyTailFade(out, rate, options)
  return out
}

/* ---------------------------------------------------------------- public -- */

/**
 * Change the duration of a sound without changing its pitch.
 *
 * `factor` is output length divided by input length: 0.5 makes it half as long
 * (twice the tempo), 2 makes it twice as long. The result is exactly
 * `round(samples.length * factor)` frames long, so callers can cut to it.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono input.
 * @param {number} sampleRate - Hz, used for window and search sizing.
 * @param {number} factor - duration ratio, 0.25..4.
 * @param {object} [options] - tuning knobs; defaults are right for cues.
 * @param {number} [options.overlap] - crossfade overlap, 0.5..0.875 (0.75).
 * @param {number} [options.frameSize] - frame length in samples (12 ms).
 * @param {number} [options.tolerance] - similarity search radius in samples.
 * @param {number} [options.fadeOutSeconds] - tail fade length, 0 disables (0.002).
 * @returns {Float32Array} stretched copy, exactly round(n * factor) frames.
 */
export function timeStretch (samples, sampleRate, factor, options = {}) {
  const input = toFloat32(samples)
  const rate = checkSampleRate(sampleRate)
  const ratio = Number(factor)
  if (!Number.isFinite(ratio)) throw new Error(`timeStretch: factor must be a number, got ${factor}`)
  if (ratio < MIN_FACTOR || ratio > MAX_FACTOR) {
    throw new Error(`timeStretch: factor ${ratio} is outside ${MIN_FACTOR}..${MAX_FACTOR} (output length / input length)`)
  }
  if (input.length === 0) return new Float32Array(0)
  const outFrames = Math.max(1, Math.round(input.length * ratio))
  if (outFrames === input.length) return input.slice()
  // Too short to correlate: fall back to interpolation. Pitch moves with speed
  // on that path, which is why the threshold is far below any real cue.
  if (input.length < MIN_WORK_SAMPLES) return resampleTo(input, outFrames)
  return wsola(input, rate, ratio, options)
}

/**
 * Shift pitch by semitones while keeping the duration.
 *
 * Implemented as a stretch by the pitch ratio followed by a resample back to the
 * original frame count: the stretch changes duration with pitch intact, the
 * resample changes pitch with duration restored. Formants shift with the pitch
 * (see the module note) — a "+1 octave" here is a cartoon voice, not a
 * transposition of the same speaker.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono input.
 * @param {number} sampleRate - Hz.
 * @param {number} semitones - -24..24; +12 is one octave up.
 * @param {object} [options] - forwarded to {@link timeStretch}.
 * @returns {Float32Array} shifted copy, exactly the input's frame count.
 */
export function pitchShift (samples, sampleRate, semitones, options = {}) {
  const input = toFloat32(samples)
  const rate = checkSampleRate(sampleRate)
  const shift = Number(semitones)
  if (!Number.isFinite(shift)) throw new Error(`pitchShift: semitones must be a number, got ${semitones}`)
  if (Math.abs(shift) > MAX_SEMITONES) {
    throw new Error(`pitchShift: ${shift} semitones is outside -${MAX_SEMITONES}..${MAX_SEMITONES}`)
  }
  if (input.length === 0) return new Float32Array(0)
  // The stretch half of the operation needs material to correlate; below this
  // the resample fallback would pitch-shift twice (once per pass) and return the
  // wrong note, which is worse than refusing.
  if (input.length < MIN_WORK_SAMPLES) {
    throw new Error(`pitchShift: input is ${input.length} samples; at least ${MIN_WORK_SAMPLES} are needed to analyse a pitch`)
  }
  const ratio = Math.pow(2, shift / 12)
  if (Math.abs(ratio - 1) < 1e-9) return input.slice()
  const stretched = timeStretch(input, rate, ratio, options)
  return resampleTo(stretched, input.length)
}

/**
 * Convenience wrapper for "this loop is 100 bpm, the cut is at 125 bpm".
 * The factor is bpmFrom / bpmTo, so raising the tempo shortens the sound.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono input.
 * @param {number} sampleRate - Hz.
 * @param {number} bpmFrom - tempo the sound is currently at.
 * @param {number} bpmTo - tempo it has to sit at.
 * @param {object} [options] - forwarded to {@link timeStretch}.
 * @returns {Float32Array} retimed copy.
 */
export function changeTempo (samples, sampleRate, bpmFrom, bpmTo, options = {}) {
  const from = Number(bpmFrom)
  const to = Number(bpmTo)
  if (!Number.isFinite(from) || from <= 0) throw new Error(`changeTempo: bpmFrom must be positive, got ${bpmFrom}`)
  if (!Number.isFinite(to) || to <= 0) throw new Error(`changeTempo: bpmTo must be positive, got ${bpmTo}`)
  const factor = from / to
  if (factor < MIN_FACTOR || factor > MAX_FACTOR) {
    throw new Error(
      `changeTempo: ${from} bpm -> ${to} bpm needs factor ${factor.toFixed(3)}, ` +
      `outside ${MIN_FACTOR}..${MAX_FACTOR}. Stretch it in two steps instead.`
    )
  }
  return timeStretch(samples, sampleRate, factor, options)
}

/**
 * One call for the common request: "make this exactly as long as the shot".
 *
 * Returns the factor that was applied as well as the method, so a caller can
 * report what happened instead of guessing: `none` means the input was already
 * the right length, `stretch` means WSOLA ran, `resample` is the sub-64-sample
 * fallback. An impossible target (a factor outside 0.25..4) throws rather than
 * silently returning something the wrong length.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono input.
 * @param {number} sampleRate - Hz.
 * @param {number} targetSeconds - wanted output duration.
 * @param {object} [options] - forwarded to {@link timeStretch}.
 * @returns {{ samples: Float32Array, sampleRate: number, factor: number, method: 'none'|'stretch'|'resample' }}
 */
export function fitToDuration (samples, sampleRate, targetSeconds, options = {}) {
  const input = toFloat32(samples)
  const rate = checkSampleRate(sampleRate)
  const target = Number(targetSeconds)
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error(`fitToDuration: targetSeconds must be positive, got ${targetSeconds}`)
  }
  if (input.length === 0) throw new Error('fitToDuration: cannot fit an empty buffer to a duration')
  const targetFrames = Math.max(1, Math.round(target * rate))
  if (targetFrames === input.length) {
    return { samples: input.slice(), sampleRate: rate, factor: 1, method: 'none' }
  }
  const factor = targetFrames / input.length
  if (factor < MIN_FACTOR || factor > MAX_FACTOR) {
    throw new Error(
      `fitToDuration: ${(input.length / rate).toFixed(3)}s -> ${target.toFixed(3)}s needs factor ` +
      `${factor.toFixed(3)}, outside ${MIN_FACTOR}..${MAX_FACTOR}. Stretch it in two steps instead.`
    )
  }
  const stretched = timeStretch(input, rate, factor, options)
  const method = input.length < MIN_WORK_SAMPLES ? 'resample' : 'stretch'
  return { samples: stretched, sampleRate: rate, factor: stretched.length / input.length, method }
}
