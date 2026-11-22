/**
 * Spatial rendering: one mono source in, a multichannel image out.
 *
 * `audio_bus` can pan a track across a stereo pair, and `lib/wav-encode.js`
 * writes at most two channels. Neither is a spatial stage: there is no surround
 * panner, no head model, and no way to hand a 5.1 or B-format file to a player.
 * This module is that stage, and it deliberately needs nothing but `./dsp.js`
 * so the zero-dependency promise survives.
 *
 * Three coordinate systems meet here and they are easy to confuse, so they are
 * pinned down once:
 *
 * - **Listener frame (everything the caller passes and gets back).** Azimuth is
 *   degrees, 0 is straight ahead, positive moves to the listener's *right*,
 *   ±180 is behind. Elevation is degrees above ear height (+90 = overhead).
 *   Distance is metres from the listener; 1 m is the reference level (0 dB).
 * - **WAVE channel order (everything written to disk).** Each layout below lists
 *   its channels in the order the WAVE format defines for it, together with the
 *   `dwChannelMask` bits that say what each channel means. That order is what
 *   ffmpeg, a DAW and a browser's own decoder all assume; getting it wrong
 *   swaps the rear pair and sounds almost right, which is the worst failure.
 * - **FuMa B-format (only `ambisonics()`).** X forward, Y *left*, Z up. Because
 *   our azimuth convention is positive-right, the Y coefficient is negated.
 *
 * What is deliberately simple, and why:
 *
 * - **No HRTF dataset.** Binaural is the Woodworth delay formula, a broadband
 *   interaural level difference and a one-pole head-shadow low-pass. That gives
 *   the two cues that carry almost all of the localisation for broadband sound
 *   (ITD below ~1.5 kHz, ILD/shadow above ~2 kHz) and no elevation-dependent
 *   pinna notches, so a source overhead still sounds "up-ish" only because the
 *   lateral component shrinks. A real HRTF set is megabytes of measured data
 *   and could not ship inside this package.
 * - **No ray-traced room.** `room` is four discrete early reflections with wall
 *   delays scaled by room size, damped by a one-pole per pair and spread with
 *   the same panner as the direct path. There is no diffuse tail and no late
 *   reverberation: that is `dsp.reverb`'s job, on the mono sum, and pretending
 *   otherwise from four taps would only sound metallic.
 * - **No per-channel dynamics.** `renderSpatial` applies one joint gain to every
 *   channel, never a per-channel limiter or normaliser: a per-channel gain moves
 *   the image, and a limiter pumping differently in L and R is exactly the
 *   artefact a spatial render must not introduce.
 */

import { clamp, dbToGain, makeRng } from './dsp.js'

/* ---------------------------------------------------------------- constants -- */

const DEG = Math.PI / 180
const DEFAULT_ROOM = Object.freeze({ size: 0.35, damping: 0.5, wet: 0.18 })
const MIN_LEVEL_DB = -120

/**
 * Head geometry for the Woodworth interaural-time-difference model: a sphere of
 * radius 8.75 cm and 343 m/s. Both are exported so a test can predict the delay
 * a render should contain instead of hard-coding a magic number.
 */
export const HEAD_MODEL = Object.freeze({ headRadiusM: 0.0875, speedOfSound: 343 })

/**
 * Sanity limits, not quality limits: they stop a bad argument from allocating
 * gigabytes (a 10-minute 7.1 timeline is 2 GB) or producing non-finite gains.
 */
export const SPATIAL_LIMITS = Object.freeze({
  maxSources: 64,
  maxSeconds: 180,
  minSampleRate: 8000,
  maxSampleRate: 96000,
  minDistance: 0.1,
  maxDistance: 1000,
  minGainDb: -120,
  maxGainDb: 24
})

/**
 * Interaural level difference at a fully lateral source, in dB (before the
 * head-shadow filter, which adds a little more). 12 dB + the shadow low-pass
 * lands a hard-side source at roughly -16 dB on the far ear: clearly lateral,
 * but never a hard mute, because a real head never mutes an ear.
 */
const MAX_ILD_DB = 12

/**
 * How fast the head-shadow cutoff falls with laterality, in nepers per unit of
 * laterality. exp(-1.35) = 0.26, so a fully lateral source is shadowed at about
 * 5 kHz and a source dead ahead is not shadowed at all.
 */
const SHADOW_SLOPE = 1.35
const SHADOW_MIN_HZ = 400

/**
 * Air absorption: the cutoff a source loses per metre beyond the 1 m reference,
 * as a fraction of the reference bandwidth. 0.9 means 2 m is already tilted to
 * about half the available bandwidth, which is a strong audible cue for "far".
 */
const AIR_ABSORPTION_PER_METRE = 0.9

/**
 * Early reflections. The pairs are mirrored (±offset) and each pair shares one
 * delay and one gain — that is what keeps a dead-ahead source bit-symmetric in
 * the binaural layout, because whichever ear is "far" for one reflection is
 * "near" for its mirror and IEEE addition is commutative.
 */
const REFLECTION_TAPS = Object.freeze([
  Object.freeze({ azimuthOffset: 62, delayMs: 13.7, gain: 0.46, pair: 0 }),
  Object.freeze({ azimuthOffset: -62, delayMs: 13.7, gain: 0.46, pair: 0 }),
  Object.freeze({ azimuthOffset: 124, delayMs: 29.1, gain: 0.30, pair: 1 }),
  Object.freeze({ azimuthOffset: -124, delayMs: 29.1, gain: 0.30, pair: 1 })
])
/** The last wall to arrive is the outer pair, so its delay is the tail length. */
const REFLECTION_TAIL_SECONDS = REFLECTION_TAPS[REFLECTION_TAPS.length - 1].delayMs / 1000

/* ----------------------------------------------------------------- layouts -- */

/**
 * Build one frozen layout description.
 *
 * @param {string} id - the id callers pass as `layout`.
 * @param {Array<[string, number|null, string?]>} channels - `[name, azimuth, kind]`
 *   in WAVE order; a `null` azimuth marks a channel that has no direction (LFE,
 *   W/X/Y/Z), and only `kind: 'speaker'` channels participate in panning.
 * @param {number} mask - `dwChannelMask` bits for the layout (0 = non-standard,
 *   which is exactly how AmbiX-style files mark four abstract channels).
 * @param {{ panning: string, reflectionWidth?: number, note: string }} spec -
 *   which panner the layout uses and what a reader must know about it.
 * @returns {object} frozen layout record.
 */
function defineLayout (id, channels, mask, spec) {
  const list = channels.map(([name, azimuth, kind = 'speaker'], index) => Object.freeze({ index, name, azimuth, kind }))
  const speakers = list.filter((channel) => channel.kind === 'speaker' && Number.isFinite(channel.azimuth))
  return Object.freeze({
    id,
    channelCount: list.length,
    channels: Object.freeze(list),
    speakerIndices: Object.freeze(speakers.map((channel) => channel.index)),
    /** Channel names in WAVE order, the one line a reader needs to check a file. */
    wavOrder: list.map((channel) => channel.name).join(' '),
    mask,
    panning: spec.panning,
    reflectionWidth: spec.reflectionWidth ?? 1,
    note: spec.note
  })
}

/**
 * Every layout this module can render, keyed by the `layout` argument.
 *
 * WAVE order and masks follow the format definition, not a DAW's taste:
 * `mono` is M (mask 0x4, front centre); `stereo` is L R (0x3); `quad` is
 * FL FR BL BR (0x33, the rear pair at ±135); `5.1` is FL FR FC LFE BL BR (0x3F,
 * surrounds at ±110 as ITU-R BS.775 places them); `7.1` is FL FR FC LFE BL BR
 * SL SR (0x63F, sides at ±90, backs at ±150). `binaural` uses the same two
 * channels as `stereo` but they are *ears* at ±90 with a head between them, not
 * speakers at ±30 with a phantom centre — that is the whole difference between
 * the two layouts and the reason both exist. `ambisonic-first-order` is
 * W X Y Z (FuMa order) with mask 0.
 *
 * @type {Readonly<Record<string, object>>}
 */
export const LAYOUTS = Object.freeze({
  mono: defineLayout('mono', [['M', 0]], 0x4, {
    panning: 'single',
    note: 'One speaker: every direction collapses to it at unity gain, so this layout measures the distance/room path without any pan loss.'
  }),
  stereo: defineLayout('stereo', [['L', -30], ['R', 30]], 0x3, {
    panning: 'clamped',
    reflectionWidth: 0.6,
    note: 'A ±30° speaker base. A source outside it collapses to the nearest speaker, which is what a mixing desk does with a hard pan; the centre is a phantom at -3 dB per side.'
  }),
  binaural: defineLayout('binaural', [['L', -90], ['R', 90]], 0x3, {
    panning: 'binaural',
    note: 'Two ears at ±90° with Woodworth ITD, ILD and a head-shadow low-pass. Headphones only: a speaker pair will not reconstruct it. The mask is the ordinary stereo mask because WAVE has no binaural mask — such a file is meant to be played as a stereo file.'
  }),
  quad: defineLayout('quad', [['FL', -45], ['FR', 45], ['BL', -135], ['BR', 135]], 0x33, {
    panning: 'pairwise',
    note: 'Four corners of a square: the front and rear pairs bracket 0° and 180° equally.'
  }),
  '5.1': defineLayout('5.1', [['FL', -30], ['FR', 30], ['FC', 0], ['LFE', null, 'lfe'], ['BL', -110], ['BR', 110]], 0x3f, {
    panning: 'pairwise',
    note: 'ITU-R BS.775 geometry: fronts at ±30°, centre at 0°, surrounds at ±110°. LFE is a low-frequency effect channel and never carries a panned source.'
  }),
  '7.1': defineLayout('7.1', [['FL', -30], ['FR', 30], ['FC', 0], ['LFE', null, 'lfe'], ['BL', -150], ['BR', 150], ['SL', -90], ['SR', 90]], 0x63f, {
    panning: 'pairwise',
    note: 'Same front stage as 5.1 plus sides at ±90° and backs at ±150°.'
  }),
  'ambisonic-first-order': defineLayout('ambisonic-first-order', [
    ['W', null, 'ambisonic'],
    ['X', null, 'ambisonic'],
    ['Y', null, 'ambisonic'],
    ['Z', null, 'ambisonic']
  ], 0, {
    panning: 'ambisonic',
    note: 'First-order B-format in FuMa order (W X Y Z) and FuMa weighting (W = 1/sqrt2). Channel mask 0 marks four abstract signals rather than speakers: decode it, do not play it.'
  })
})

/** Layout ids, in table order, for a tool's JSON schema enum. */
export const LAYOUT_IDS = Object.freeze(Object.keys(LAYOUTS))

const LAYOUT_ALIASES = Object.freeze({
  foa: 'ambisonic-first-order',
  ambisonic: 'ambisonic-first-order',
  ambi: 'ambisonic-first-order',
  '5.1-surround': '5.1',
  surround: '5.1'
})

/**
 * Resolve a caller-supplied layout id.
 * @param {string} [layout] - layout id or alias; defaults to `stereo`.
 * @returns {object} the frozen layout record.
 */
export function resolveLayout (layout = 'stereo') {
  const id = String(layout ?? 'stereo').trim().toLowerCase()
  const resolved = LAYOUT_ALIASES[id] ?? id
  const found = LAYOUTS[resolved]
  if (found === undefined) {
    throw new Error(`spatial: unknown layout "${layout}"; available: ${LAYOUT_IDS.join(', ')}`)
  }
  return found
}

/* --------------------------------------------------------------- ambisonics -- */

/**
 * B-format weightings. FuMa is the classic SoundField/traditional weighting
 * (W at -3 dB); SN3D is the AmbiX default; N3D is the "maxN" weighting a few
 * research tools use. Only the scale factors differ, so a decoder that knows
 * which one it is reading can consume any of them.
 */
const AMBISONIC_NORMALIZATIONS = Object.freeze({
  fuma: Object.freeze({ w: Math.SQRT1_2, dir: 1 }),
  sn3d: Object.freeze({ w: 1, dir: 1 }),
  n3d: Object.freeze({ w: 1, dir: Math.sqrt(3) })
})

/**
 * Encode one mono source as first-order B-format (W/X/Y/Z).
 *
 * FuMa axis convention: X points forward, Y points *left*, Z points up. Because
 * this module's azimuth is positive-to-the-right, `Y = -sin(azimuth)cos(elev)`
 * — a source on the left has a positive Y. That single sign is the classic
 * B-format bug, so it is stated in the return value as well.
 *
 * Ordering: `fuma` is `[W, X, Y, Z]`, `acn` is `[W, Y, Z, X]` (the AmbiX order).
 * `components` is keyed by name in both cases, so a consumer never has to index
 * by a remembered position.
 *
 * Distance and the room are *not* applied here: this is a direction encoder for
 * export to a spatial tool. `placeSource` with the `ambisonic-first-order`
 * layout is the version that includes gain, distance and reflections.
 *
 * `ordering`, `normalization` and `gainDb` live in `options`, but the same keys
 * are accepted in `position` as well: `ambisonics(s, rate, { azimuth: 90,
 * ordering: 'acn' })` is what a caller reaches for first, and silently ignoring
 * the extra key would have produced a FuMa file labelled ACN.
 *
 * @param {Float32Array|Float64Array|Array<Float32Array|Float64Array>} samples - mono source (or channels to fold).
 * @param {number} sampleRate - Hz; only used for the report.
 * @param {{ azimuth?: number, elevation?: number }} [position] - listener-frame direction in degrees.
 * @param {{ ordering?: 'fuma'|'acn', normalization?: 'fuma'|'sn3d'|'n3d', gainDb?: number }} [options]
 * @returns {{ channels: Float32Array[], order: string[], ordering: string, normalization: string,
 *   components: { W: Float32Array, X: Float32Array, Y: Float32Array, Z: Float32Array },
 *   energyFactor: number, report: object }}
 */
export function ambisonics (samples, sampleRate, position = {}, options = {}) {
  const rate = validateSampleRate(sampleRate, 'ambisonics')
  const settings = { ...position, ...options }
  const mono = toMono(samples, 'ambisonics')
  const azimuth = wrapAzimuth(numberOr(position.azimuth, 0, 'ambisonics azimuth'))
  const elevation = clamp(numberOr(position.elevation, 0, 'ambisonics elevation'), -90, 90)
  const ordering = settings.ordering === 'acn' ? 'acn' : 'fuma'
  const normalization = AMBISONIC_NORMALIZATIONS[settings.normalization] !== undefined ? settings.normalization : 'fuma'
  const weights = AMBISONIC_NORMALIZATIONS[normalization]
  const gain = dbToGain(clamp(Number(settings.gainDb ?? 0), SPATIAL_LIMITS.minGainDb, SPATIAL_LIMITS.maxGainDb))

  const cosElevation = Math.cos(elevation * DEG)
  const x = Math.cos(azimuth * DEG) * cosElevation
  const y = -Math.sin(azimuth * DEG) * cosElevation
  const z = Math.sin(elevation * DEG)

  const scale = { W: weights.w * gain, X: weights.dir * x * gain, Y: weights.dir * y * gain, Z: weights.dir * z * gain }
  const components = {
    W: scaleBuffer(mono, scale.W),
    X: scaleBuffer(mono, scale.X),
    Y: scaleBuffer(mono, scale.Y),
    Z: scaleBuffer(mono, scale.Z)
  }
  const order = ordering === 'acn' ? ['W', 'Y', 'Z', 'X'] : ['W', 'X', 'Y', 'Z']
  // First-order B-format is not power-normalised by construction: the sum of the
  // squared components is a fixed multiple of the source power whose size is set
  // by the weighting. Reporting it stops a consumer from thinking the encoder is
  // losing energy at some angles.
  const energyFactor = weights.w * weights.w + weights.dir * weights.dir
  return {
    channels: order.map((name) => components[name]),
    order,
    ordering,
    normalization,
    components,
    energyFactor,
    report: {
      sampleRate: rate,
      frames: mono.length,
      durationSeconds: mono.length / rate,
      azimuth,
      elevation,
      ordering,
      normalization,
      energyFactor,
      // The sum of the squared components is a *power* ratio, so its dB uses 10
      // log10: FuMa 1.5x (+1.76 dB), SN3D 2x (+3.01 dB), N3D 4x (+6.02 dB).
      energyFactorDb: round(10 * Math.log10(energyFactor), 3),
      direction: { x: round(x, 6), y: round(y, 6), z: round(z, 6) },
      coefficients: { W: scale.W, X: scale.X, Y: scale.Y, Z: scale.Z },
      note: 'FuMa axes: +X forward, +Y left, +Z up. Distance and room are not applied here.'
    }
  }
}

/* ----------------------------------------------------------------- panners -- */

/**
 * Constant-power gains for a direction on a speaker layout.
 *
 * Two rules, both standard and both cheap:
 * - a full-circle layout uses pairwise panning over the arc between the two
 *   speakers that bracket the source, with `cos`/`sin` weights, so the sum of
 *   squared gains is 1 at every angle and a source exactly on a speaker gets
 *   exactly 1 and 0 (no phantom smear);
 * - a layout with a limited base (`stereo`, ±30°) clamps: outside the base the
 *   source collapses to the nearest speaker at unity. Spreading it across a
 *   300° "virtual back arc" between L and R would put a hard-left source partly
 *   in the right speaker, which no mixer would accept.
 *
 * Elevation is ignored: none of these layouts has a height channel, and tilting
 * a horizontal source into the fronts would be a lie rather than a cue.
 *
 * @param {object} layout - frozen layout record.
 * @param {number} azimuth - degrees, listener frame.
 * @returns {{ gains: Float64Array, kind: string, pair: number[]|null, arcDegrees: number }}
 */
function speakerGains (layout, azimuth) {
  const gains = new Float64Array(layout.channelCount)
  if (layout.panning === 'single') {
    gains[layout.speakerIndices[0]] = 1
    return { gains, kind: 'single', pair: null, arcDegrees: 0 }
  }

  const speakers = layout.speakerIndices.map((index) => ({ index, azimuth: layout.channels[index].azimuth }))
  if (layout.panning === 'clamped') {
    const first = speakers[0]
    const last = speakers[speakers.length - 1]
    const clamped = clamp(wrapAzimuth(azimuth), first.azimuth, last.azimuth)
    const span = last.azimuth - first.azimuth
    const t = span > 0 ? (clamped - first.azimuth) / span : 0
    gains[first.index] = Math.cos(t * Math.PI / 2)
    gains[last.index] = Math.sin(t * Math.PI / 2)
    // sin(pi/2) is 6.1e-17, not 0. A hard pan must silence the far speaker, or
    // "all the energy in one channel" becomes "99.99999 % of it".
    if (t <= 0) gains[last.index] = 0
    if (t >= 1) gains[first.index] = 0
    return { gains, kind: 'clamped', pair: [first.index, last.index], arcDegrees: span }
  }

  // Pairwise over a full circle: sort into [0, 360) and find the bracketing arc,
  // wrapping past the last speaker.
  const circle = speakers
    .map((speaker) => ({ index: speaker.index, azimuth: ((speaker.azimuth % 360) + 360) % 360 }))
    .sort((a, b) => a.azimuth - b.azimuth)
  const theta = ((wrapAzimuth(azimuth) % 360) + 360) % 360
  let left = circle[circle.length - 1]
  let right = circle[0]
  let rightAzimuth = right.azimuth + 360
  for (let i = 0; i < circle.length; i += 1) {
    const current = circle[i]
    const next = circle[(i + 1) % circle.length]
    const nextAzimuth = next.azimuth + (next.azimuth <= current.azimuth ? 360 : 0)
    if (theta >= current.azimuth && theta < nextAzimuth) {
      left = current
      right = next
      rightAzimuth = nextAzimuth
      break
    }
  }
  const span = rightAzimuth - left.azimuth
  const t = span > 0 ? clamp((theta - left.azimuth) / span, 0, 1) : 0
  gains[left.index] = Math.cos(t * Math.PI / 2)
  gains[right.index] = Math.sin(t * Math.PI / 2)
  if (t <= 0) gains[right.index] = 0
  if (t >= 1) gains[left.index] = 0
  return { gains, kind: 'pairwise', pair: [left.index, right.index], arcDegrees: span }
}

/**
 * Add one signal into a layout with a direction, at an integer sample offset.
 * Used for both speaker and B-format layouts; the caller has already folded the
 * distance gain into `gain`.
 *
 * @param {Float32Array[]} channels - destination channel buffers.
 * @param {object} layout - frozen layout record.
 * @param {Float32Array} signal - source (already air-absorbed).
 * @param {number} azimuth - degrees.
 * @param {number} elevation - degrees.
 * @param {number} gain - linear gain applied to every channel.
 * @param {number} offset - whole-sample start offset.
 * @param {{ normalization?: string }} options - ambisonic weighting, ignored by speaker layouts.
 * @returns {{ gains: Float64Array, kind: string, pair: number[]|null, arcDegrees: number }}
 */
function addDirectional (channels, layout, signal, azimuth, elevation, gain, offset, options) {
  let gains
  let kind
  let pair = null
  let arcDegrees = 0
  if (layout.panning === 'ambisonic') {
    const normalization = AMBISONIC_NORMALIZATIONS[options?.normalization] !== undefined ? options.normalization : 'fuma'
    const weights = AMBISONIC_NORMALIZATIONS[normalization]
    const cosElevation = Math.cos(elevation * DEG)
    gains = new Float64Array(layout.channelCount)
    gains[0] = weights.w
    gains[1] = weights.dir * Math.cos(azimuth * DEG) * cosElevation
    gains[2] = -weights.dir * Math.sin(azimuth * DEG) * cosElevation
    gains[3] = weights.dir * Math.sin(elevation * DEG)
    kind = 'ambisonic'
  } else {
    const panned = speakerGains(layout, azimuth)
    gains = panned.gains
    kind = panned.kind
    pair = panned.pair
    arcDegrees = panned.arcDegrees
  }
  for (let channel = 0; channel < gains.length; channel += 1) {
    if (gains[channel] !== 0) addScaledAt(channels[channel], signal, offset, gain * gains[channel])
  }
  return { gains, kind, pair, arcDegrees }
}

/**
 * Woodworth interaural time difference, in seconds, signed positive when the
 * source is on the listener's right (the right ear leads).
 *
 * The model is the standard one for a spherical head: a sound reaching the
 * shadowed ear travels an extra arc of length `a(theta + sin theta)` where `a`
 * is the head radius and `theta` the angle out of the median plane. At 90° that
 * is (0.0875/343)(pi/2 + 1) = 656 us, which is the number the audio literature
 * quotes for a human head and the number the test checks a render against.
 *
 * The angle is taken from the *lateral component* (`sin(az)cos(elev)`), so a
 * source overhead or directly behind gives an ITD of zero — the familiar
 * front/back and up/down ambiguity of a two-microphone head.
 *
 * @param {number} azimuth - degrees, listener frame.
 * @param {number} [elevation] - degrees above ear height.
 * @returns {number} seconds in [-656e-6, 656e-6].
 */
export function interauralDelay (azimuth, elevation = 0) {
  const lateral = lateralComponent(azimuth, elevation)
  const theta = Math.asin(clamp(lateral, -1, 1))
  const magnitude = (HEAD_MODEL.headRadiusM / HEAD_MODEL.speedOfSound) * (Math.abs(theta) + Math.abs(Math.sin(theta)))
  return magnitude * Math.sign(lateral)
}

/**
 * Lateral component of a direction: +1 hard right, -1 hard left, 0 dead ahead,
 * dead behind or overhead. Everything binaural keys off this one number, which
 * is why elevation and the front/back reversal behave consistently.
 * @param {number} azimuth - degrees.
 * @param {number} [elevation] - degrees.
 * @returns {number} in [-1, 1].
 */
function lateralComponent (azimuth, elevation = 0) {
  return Math.sin(wrapAzimuth(azimuth) * DEG) * Math.cos(clamp(elevation, -90, 90) * DEG)
}

/**
 * Head-shadow cutoff for a given laterality: unshadowed at the midline, ~5 kHz
 * at the side. One pole is coarse — a real head gives 20 dB of shadow above
 * 3 kHz — but it is the difference between "panned" and "outside the head", and
 * it costs one multiply per sample.
 * @param {number} lateral - lateral component magnitude.
 * @param {number} sampleRate - Hz.
 * @returns {number} cutoff in Hz.
 */
function headShadowCutoff (lateral, sampleRate) {
  const base = Math.min(20000, sampleRate * 0.45)
  return clamp(base * Math.exp(-SHADOW_SLOPE * Math.abs(lateral)), SHADOW_MIN_HZ, base)
}

/**
 * Add one signal through the binaural head model.
 *
 * The near ear gets the signal flat. The far ear gets the head-shadow low-pass
 * and the Woodworth delay; both ears draw from one constant-power gain pair, so
 * a source does not change overall level as it moves across the head (only its
 * balance does). At exactly dead ahead or dead behind the laterality is zero and
 * both ears take the identical dry signal, which is what makes the symmetry
 * check meaningful instead of a rounding accident.
 *
 * @param {Float32Array[]} channels - `[L, R]` destination.
 * @param {Float32Array} signal - source (already air-absorbed).
 * @param {number} sampleRate - Hz.
 * @param {number} azimuth - degrees.
 * @param {number} elevation - degrees.
 * @param {number} gain - linear gain for the pair.
 * @param {number} offset - whole-sample start offset.
 * @returns {object} the model values that were applied, for the report.
 */
function addBinaural (channels, signal, sampleRate, azimuth, elevation, gain, offset) {
  const lateral = lateralComponent(azimuth, elevation)
  const itd = interauralDelay(azimuth, elevation)
  const ild = dbToGain(-MAX_ILD_DB * Math.abs(lateral))
  const norm = 1 / Math.sqrt(1 + ild * ild)
  const nearGain = gain * norm
  const farGain = gain * ild * norm

  if (Math.abs(lateral) < 1e-9) {
    // Dead ahead or behind: no ear is shadowed, so both take the same samples.
    addScaledAt(channels[0], signal, offset, gain * Math.SQRT1_2)
    addScaledAt(channels[1], signal, offset, gain * Math.SQRT1_2)
    return {
      lateral: 0,
      itdSeconds: 0,
      itdMicroseconds: 0,
      nearEar: null,
      farEar: null,
      nearGainDb: round(20 * Math.log10(gain * Math.SQRT1_2), 3),
      farGainDb: round(20 * Math.log10(gain * Math.SQRT1_2), 3),
      shadowCutoffHz: null
    }
  }

  // Right ear is channel 1, left ear channel 0.
  const nearIndex = lateral > 0 ? 1 : 0
  const farIndex = lateral > 0 ? 0 : 1
  addScaledAt(channels[nearIndex], signal, offset, nearGain)
  const cutoff = headShadowCutoff(lateral, sampleRate)
  const shadowed = lowpass(signal, sampleRate, cutoff)
  // The shadowed copy is delayed by the ITD and started at the same offset: the
  // near ear leads by the Woodworth value, which is exactly what a correlation
  // between the two ear signals measures.
  addDelayed(channels[farIndex], shadowed, offset + Math.abs(itd) * sampleRate, farGain)
  return {
    lateral: round(lateral, 6),
    itdSeconds: itd,
    itdMicroseconds: round(itd * 1e6, 2),
    nearEar: nearIndex === 1 ? 'R' : 'L',
    farEar: farIndex === 1 ? 'R' : 'L',
    nearGainDb: round(20 * Math.log10(nearGain), 3),
    farGainDb: round(20 * Math.log10(farGain), 3),
    shadowCutoffHz: Math.round(cutoff)
  }
}

/* -------------------------------------------------------------------- room -- */

/**
 * Resolve the room settings.
 *
 * `room.size` scales the wall delays (a bigger room reflects later), `damping`
 * darkens and quietens the reflections, and `wet` is their overall level
 * relative to the direct sound. `roomSize` is accepted as a short form of
 * `room.size` because the brief for this stage named it that way.
 *
 * @param {object} [options] - `{ room, roomSize, damping, wet }`.
 * @returns {{ size: number, damping: number, wet: number }} clamped settings.
 */
export function resolveRoom (options = {}) {
  const room = options.room ?? {}
  return {
    size: clamp(numberOr(options.roomSize ?? room.size, DEFAULT_ROOM.size, 'room.size'), 0, 1),
    damping: clamp(numberOr(options.damping ?? room.damping, DEFAULT_ROOM.damping, 'room.damping'), 0, 1),
    wet: clamp(numberOr(options.wet ?? room.wet, DEFAULT_ROOM.wet, 'room.wet'), 0, 1)
  }
}

/**
 * Seconds of tail the reflections need after the source stops. `renderSpatial`
 * pads by this so the last reflection is not cut off mid-decay, which would be
 * a click at the end of every spatial file.
 * @param {{ size: number }} room - resolved room.
 * @returns {number} seconds.
 */
export function roomTailSeconds (room) {
  return REFLECTION_TAIL_SECONDS * (0.55 + 1.35 * room.size)
}

/**
 * Turn the room settings into concrete tap instructions.
 * @param {object} layout - frozen layout record.
 * @param {{ size: number, damping: number, wet: number }} room - resolved room.
 * @param {number} sampleRate - Hz.
 * @returns {Array<{ azimuthOffset: number, delaySeconds: number, delaySamples: number,
 *   gainDb: number, cutoffHz: number }>} empty when `wet` is 0.
 */
function reflectionPlan (layout, room, sampleRate) {
  if (!(room.wet > 0)) return []
  const sizeScale = 0.55 + 1.35 * room.size
  const base = Math.min(20000, sampleRate * 0.45)
  return REFLECTION_TAPS.map((tap) => ({
    azimuthOffset: tap.azimuthOffset * layout.reflectionWidth,
    delaySeconds: (tap.delayMs / 1000) * sizeScale,
    delaySamples: Math.round((tap.delayMs / 1000) * sizeScale * sampleRate),
    gainDb: round(20 * Math.log10(room.wet * tap.gain), 3),
    // Mirrored taps share a pair number, so their damping is identical too:
    // anything else and a dead-ahead source stops being symmetric.
    cutoffHz: clamp(base * (1 - room.damping * (0.45 + 0.25 * tap.pair)), 300, base)
  }))
}

/* -------------------------------------------------------- signal primitives -- */

/**
 * One-pole low-pass, `y[n] = y[n-1] + a(x[n] - y[n-1])`.
 * @param {Float32Array} input - source.
 * @param {number} sampleRate - Hz.
 * @param {number} cutoffHz - corner.
 * @returns {Float32Array} filtered copy.
 */
function lowpass (input, sampleRate, cutoffHz) {
  const out = new Float32Array(input.length)
  const a = onePoleCoefficient(sampleRate, cutoffHz)
  let state = 0
  for (let i = 0; i < input.length; i += 1) {
    state += a * (input[i] - state)
    out[i] = state
  }
  return out
}

/**
 * Coefficient of a one-pole low-pass for a corner frequency.
 * @param {number} sampleRate - Hz.
 * @param {number} cutoffHz - corner.
 * @returns {number} in (0, 1).
 */
function onePoleCoefficient (sampleRate, cutoffHz) {
  return 1 - Math.exp(-2 * Math.PI * clamp(cutoffHz, 1, sampleRate * 0.499) / sampleRate)
}

/**
 * Air absorption for a distance.
 *
 * The cutoff falls with distance (twice as far is about half the bandwidth) and
 * the loss is compensated analytically, so the filter *tilts* the spectrum
 * without changing its level. That separation matters: the distance law is a
 * pure 1/d measured in dB, and a filter that also removed energy would make a
 * doubling look like 7 dB instead of 6. The compensation factor is the exact
 * broadband gain of a one-pole on white noise, `sqrt((2 - a) / a)`, so the
 * correction is a property of the filter alone and never of the material.
 *
 * @param {Float32Array} input - source.
 * @param {number} sampleRate - Hz.
 * @param {number} distance - metres.
 * @returns {{ samples: Float32Array, cutoffHz: number, compensationDb: number, applied: boolean }}
 */
function airAbsorb (input, sampleRate, distance) {
  const reference = Math.min(20000, sampleRate * 0.45)
  if (!(distance > 1)) return { samples: input, cutoffHz: Math.round(reference), compensationDb: 0, applied: false }
  const cutoffHz = clamp(reference / (1 + AIR_ABSORPTION_PER_METRE * (distance - 1)), 300, reference)
  const a = onePoleCoefficient(sampleRate, cutoffHz)
  const compensation = Math.sqrt((2 - a) / a)
  const filtered = lowpass(input, sampleRate, cutoffHz)
  for (let i = 0; i < filtered.length; i += 1) filtered[i] *= compensation
  return { samples: filtered, cutoffHz: Math.round(cutoffHz), compensationDb: round(20 * Math.log10(compensation), 3), applied: true }
}

/**
 * `dst[i + offset] += src[i] * gain`, clipped to the destination.
 * @param {Float32Array} dst - destination.
 * @param {Float32Array} src - source.
 * @param {number} offset - whole-sample offset (negative is clamped to 0).
 * @param {number} gain - linear gain.
 */
function addScaledAt (dst, src, offset, gain) {
  const start = Math.max(0, Math.round(offset))
  if (start >= dst.length) return
  const count = Math.min(src.length, dst.length - start)
  for (let i = 0; i < count; i += 1) dst[start + i] += src[i] * gain
}

/**
 * Add a signal at a *fractional* sample delay.
 *
 * Third-order Lagrange interpolation on four points. A whole-sample delay takes
 * the exact copy path, which is what almost every early reflection uses; the
 * interpolator only runs for the binaural far ear, whose delay is the Woodworth
 * value (28.94 samples at 44.1 kHz for a hard-side source). Integer-only
 * delays would quantise that to 29 and put the measured ITD 0.06 samples
 * (1.4 us at 44.1 kHz) off; more taps would be more accurate than the head model
 * itself is.
 *
 * The node indexing is the part that is easy to get wrong: for output sample `n`
 * the wanted input position is `n - delay`, whose floor is `n - whole - 1` as
 * soon as `frac > 0`, and the interpolation weight is therefore `1 - frac`. Using
 * `n - whole` with weight `frac` instead quietly applies `whole - frac` samples
 * of delay — an error of nearly 2 samples at frac = 0.94, which is exactly the
 * ITD error the test caught.
 *
 * @param {Float32Array} dst - destination.
 * @param {Float32Array} src - source.
 * @param {number} delay - delay in samples, may be fractional.
 * @param {number} gain - linear gain.
 */
function addDelayed (dst, src, delay, gain) {
  if (!Number.isFinite(delay) || delay <= 0) {
    addScaledAt(dst, src, 0, gain)
    return
  }
  const whole = Math.floor(delay)
  const frac = delay - whole
  if (frac < 1e-9) {
    addScaledAt(dst, src, whole, gain)
    return
  }
  const f = 1 - frac
  // Lagrange weights for nodes at -1, 0, 1, 2 evaluated at `f`.
  const c0 = -f * (f - 1) * (f - 2) / 6
  const c1 = (f + 1) * (f - 1) * (f - 2) / 2
  const c2 = -(f + 1) * f * (f - 2) / 2
  const c3 = (f + 1) * f * (f - 1) / 6
  const last = src.length - 1
  for (let n = whole; n < dst.length; n += 1) {
    const i = n - whole - 1
    const s0 = i - 1 >= 0 ? src[i - 1] : 0
    const s1 = i >= 0 ? src[i] : 0
    const s2 = i + 1 <= last ? src[i + 1] : 0
    const s3 = i + 2 <= last ? src[i + 2] : 0
    dst[n] += (c0 * s0 + c1 * s1 + c2 * s2 + c3 * s3) * gain
  }
}

/** A copy of `input` scaled by `gain`. */
function scaleBuffer (input, gain) {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] * gain
  return out
}

/* -------------------------------------------------------------- placement -- */

/**
 * Channel peak/RMS levels in dB, and the joint power level across channels.
 *
 * The joint level sums the energy of all channels and divides by the *frame*
 * count, not by frames x channels. That makes it layout-independent: constant
 * power panning puts the same total energy into the file whatever the layout, so
 * a source reads at the same level in mono, stereo, 5.1 and B-format, and only
 * when it is actually louder does the number move. Dividing by frames x channels
 * would make the same source read 7.8 dB quieter in 5.1 than in mono purely
 * because the layout has more channels.
 *
 * @param {Float32Array[]} channels - channel buffers.
 * @param {object} layout - frozen layout record (for the channel names).
 * @returns {{ channels: Array<{index: number, name: string, azimuth: number|null, peakDbfs: number, rmsDbfs: number }>, peakDbfs: number, rmsDbfs: number }}
 */
function channelLevels (channels, layout) {
  let jointPeak = 0
  let jointSquares = 0
  let frames = 0
  const perChannel = channels.map((buffer, index) => {
    let peak = 0
    let squares = 0
    for (let i = 0; i < buffer.length; i += 1) {
      const value = buffer[i]
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
      squares += value * value
    }
    jointPeak = Math.max(jointPeak, peak)
    jointSquares += squares
    frames = Math.max(frames, buffer.length)
    return {
      index,
      name: layout.channels[index].name,
      azimuth: layout.channels[index].azimuth,
      peakDbfs: amplitudeDb(peak),
      rmsDbfs: amplitudeDb(Math.sqrt(squares / Math.max(1, buffer.length)))
    }
  })
  return {
    channels: perChannel,
    peakDbfs: amplitudeDb(jointPeak),
    rmsDbfs: amplitudeDb(Math.sqrt(jointSquares / Math.max(1, frames)))
  }
}

/**
 * Place one mono source in a layout.
 *
 * The signal path is: distance gain (1/d, 1 m = 0 dB) → air-absorption tilt →
 * the layout's panner (constant-power speakers, the binaural head model, or a
 * B-format encode) → four early reflections panned around the source's own
 * direction. `width` is a mid/side widen and only means anything for the stereo
 * pair: 0 folds it to mono, 1 is the pan image, 2 doubles the side signal.
 *
 * @param {Float32Array|Float64Array|Array<Float32Array|Float64Array>} samples - mono source.
 * @param {number} sampleRate - Hz.
 * @param {object} [options] - `{ position, layout, roomSize, damping, wet, room, width, gainDb, normalization }`.
 *   `position` may be omitted and its three keys given flat on `options`.
 * @returns {{ channels: Float32Array[], sampleRate: number, layout: string, channelCount: number, report: object }}
 */
export function placeSource (samples, sampleRate, options = {}) {
  const rate = validateSampleRate(sampleRate, 'placeSource')
  const layout = resolveLayout(options.layout)
  const position = resolvePosition(options.position ?? options)
  const room = resolveRoom(options)
  const mono = toMono(samples, 'placeSource')
  if (mono.length === 0) throw new Error('placeSource: the source has no samples')

  const distance = clamp(position.distance, SPATIAL_LIMITS.minDistance, SPATIAL_LIMITS.maxDistance)
  const distanceGain = 1 / distance
  const requestedGain = clamp(numberOr(options.gainDb, 0, 'gainDb'), SPATIAL_LIMITS.minGainDb, SPATIAL_LIMITS.maxGainDb)
  const sourceGain = dbToGain(requestedGain) * distanceGain
  const air = airAbsorb(mono, rate, distance)

  const channels = Array.from({ length: layout.channelCount }, () => new Float32Array(mono.length))

  // Direct sound.
  const direct = layout.panning === 'binaural'
    ? { binaural: addBinaural(channels, air.samples, rate, position.azimuth, position.elevation, sourceGain, 0) }
    : { panned: addDirectional(channels, layout, air.samples, position.azimuth, position.elevation, sourceGain, 0, options) }

  // Early reflections, panned around the source direction.
  const taps = reflectionPlan(layout, room, rate)
  const appliedTaps = []
  for (const tap of taps) {
    const tapAzimuth = wrapAzimuth(position.azimuth + tap.azimuthOffset)
    const tapSignal = room.damping > 0 ? lowpass(air.samples, rate, tap.cutoffHz) : air.samples
    const tapGain = sourceGain * dbToGain(tap.gainDb)
    if (layout.panning === 'binaural') {
      addBinaural(channels, tapSignal, rate, tapAzimuth, position.elevation, tapGain, tap.delaySamples)
    } else {
      addDirectional(channels, layout, tapSignal, tapAzimuth, position.elevation, tapGain, tap.delaySamples, options)
    }
    appliedTaps.push({
      azimuth: tapAzimuth,
      delayMs: round(tap.delaySeconds * 1000, 2),
      gainDb: tap.gainDb,
      cutoffHz: Math.round(tap.cutoffHz)
    })
  }

  const width = clamp(numberOr(options.width, 1, 'width'), 0, 4)
  if (layout.id === 'stereo' && width !== 1) applyWidth(channels, width)

  const levels = channelLevels(channels, layout)
  const report = {
    layout: layout.id,
    wavOrder: layout.wavOrder,
    channelCount: layout.channelCount,
    sampleRate: rate,
    frames: mono.length,
    durationSeconds: round(mono.length / rate, 6),
    position: { azimuth: position.azimuth, elevation: position.elevation, distance },
    panning: layout.panning,
    gain: {
      sourceDb: requestedGain,
      distanceDb: round(20 * Math.log10(distanceGain), 3),
      totalDb: round(20 * Math.log10(sourceGain), 3)
    },
    airAbsorption: { cutoffHz: air.cutoffHz, compensationDb: air.compensationDb, applied: air.applied },
    speakers: speakerReport(layout, direct.panned),
    binaural: direct.binaural ?? null,
    room: { size: room.size, damping: room.damping, wet: room.wet, taps: appliedTaps },
    channels: levels.channels,
    level: { peakDbfs: levels.peakDbfs, rmsDbfs: levels.rmsDbfs }
  }
  if (layout.id === 'stereo') report.width = width
  return { channels, sampleRate: rate, layout: layout.id, channelCount: layout.channelCount, report }
}

/**
 * The non-zero panner gains as `{ channel, name, azimuth, gainDb }`, loudest
 * first — the one line that explains where a source actually went.
 * @param {object} layout - frozen layout record.
 * @param {object} panned - result of `speakerGains`/ambisonic encoding.
 * @returns {Array<object>} gains in dBFS relative to the source gain.
 */
function speakerReport (layout, panned) {
  if (panned === undefined) return []
  const entries = []
  for (let channel = 0; channel < panned.gains.length; channel += 1) {
    const gain = panned.gains[channel]
    if (gain === 0) continue
    entries.push({
      channel,
      name: layout.channels[channel].name,
      azimuth: layout.channels[channel].azimuth,
      gainDb: round(20 * Math.log10(Math.abs(gain)), 3),
      sign: gain < 0 ? -1 : 1
    })
  }
  entries.sort((a, b) => b.gainDb - a.gainDb)
  return entries
}

/**
 * Mid/side width. Applied after placement, so it also widens the reflections.
 * @param {Float32Array[]} channels - exactly two channels, modified in place.
 * @param {number} width - 0 mono, 1 unchanged, >1 wider.
 */
function applyWidth (channels, width) {
  const left = channels[0]
  const right = channels[1]
  for (let i = 0; i < left.length; i += 1) {
    const mid = (left[i] + right[i]) * 0.5
    const side = (left[i] - right[i]) * 0.5
    left[i] = mid + width * side
    right[i] = mid - width * side
  }
}

/* --------------------------------------------------------- spatial renderer -- */

/**
 * Render a set of placed sources into one multichannel master.
 *
 * Master length is the requested span plus the room tail (`report.roomTailSeconds`),
 * because cutting the last reflection mid-decay is an audible click at the end
 * of the file. A source longer than the span is truncated to it; a shorter one
 * is padded, and because the padding happens *before* placement its reflections
 * still decay into the tail. `loop: true` tiles a source across the span, which
 * is how a spatial ambience bed is built without baking a five-second file into
 * the cue.
 *
 * The only processing after the sum is one *joint* peak normalisation: every
 * channel is multiplied by the same number, so the image is untouched. Per
 * channel normalisation or limiting is deliberately absent — see the module
 * header.
 *
 * @param {object} request - `{ sources, layout, durationSeconds, room, roomSize, damping, wet,
 *   sampleRate, normalizeDbfs }`.
 * @param {Array<{ samples: Float32Array|Float64Array|Array, sampleRate?: number,
 *   position?: { azimuth?: number, distance?: number, elevation?: number }, gainDb?: number,
 *   loop?: boolean, label?: string }>} request.sources - sources to place.
 * @returns {{ channels: Float32Array[], sampleRate: number, layout: string, channelCount: number, report: object }}
 */
export function renderSpatial (request = {}) {
  const sources = request.sources
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('renderSpatial: sources must be a non-empty array')
  if (sources.length > SPATIAL_LIMITS.maxSources) {
    throw new Error(`renderSpatial: ${sources.length} sources exceeds the ${SPATIAL_LIMITS.maxSources} source limit`)
  }

  const layout = resolveLayout(request.layout)
  const room = resolveRoom(request)
  const rate = validateSampleRate(
    request.sampleRate ?? sources[0].sampleRate ?? 44100, 'renderSpatial')
  const tailFrames = Math.round(roomTailSeconds(room) * rate)

  // Convert every source to mono at the master rate and find the span.
  const prepared = sources.map((source, index) => {
    const samples = toMono(source?.samples, `renderSpatial sources[${index}]`)
    const sourceRate = validateSampleRate(source?.sampleRate ?? rate, `renderSpatial sources[${index}].sampleRate`)
    const mono = resample(samples, sourceRate, rate)
    return {
      index,
      mono,
      loop: source.loop === true,
      label: typeof source.label === 'string' ? source.label : undefined,
      position: resolvePosition(source.position ?? source, `renderSpatial sources[${index}].position`),
      gainDb: clamp(numberOr(source.gainDb, 0, `sources[${index}].gainDb`), SPATIAL_LIMITS.minGainDb, SPATIAL_LIMITS.maxGainDb)
    }
  })

  const requestedSpan = request.durationSeconds !== undefined && request.durationSeconds !== null
    ? Number(request.durationSeconds)
    : Math.max(...prepared.map((source) => source.mono.length / rate))
  if (!Number.isFinite(requestedSpan) || requestedSpan <= 0) {
    throw new Error(`renderSpatial: durationSeconds must be a positive number of seconds, got ${request.durationSeconds}`)
  }
  if (requestedSpan > SPATIAL_LIMITS.maxSeconds) {
    throw new Error(`renderSpatial: ${requestedSpan} s exceeds the ${SPATIAL_LIMITS.maxSeconds} s limit; render shorter spans and assemble them with audio_mix`)
  }
  const bodyFrames = Math.max(1, Math.round(requestedSpan * rate))
  const totalFrames = bodyFrames + tailFrames

  const master = Array.from({ length: layout.channelCount }, () => new Float32Array(totalFrames))
  const entries = []
  for (const source of prepared) {
    // The padding is not silence to trim later: it is the space the reflections
    // of the last source sample need to decay into.
    const buffer = new Float32Array(totalFrames)
    if (source.loop) {
      const period = source.mono.length
      if (period === 0) throw new Error(`renderSpatial: sources[${source.index}] is empty`)
      for (let i = 0; i < bodyFrames; i += 1) buffer[i] = source.mono[i % period]
    } else {
      buffer.set(source.mono.subarray(0, Math.min(source.mono.length, bodyFrames)))
    }
    const placed = placeSource(buffer, rate, {
      position: source.position,
      layout: layout.id,
      room,
      gainDb: source.gainDb,
      normalization: request.normalization
    })
    for (let channel = 0; channel < master.length; channel += 1) {
      const target = master[channel]
      const contribution = placed.channels[channel]
      for (let i = 0; i < totalFrames; i += 1) target[i] += contribution[i]
    }
    entries.push({
      index: source.index,
      label: source.label,
      loop: source.loop,
      position: { azimuth: source.position.azimuth, elevation: source.position.elevation, distance: source.position.distance },
      gainDb: source.gainDb,
      level: placed.report.level,
      channels: placed.report.channels,
      pan: placed.report.speakers,
      binaural: placed.report.binaural,
      roomTaps: placed.report.room.taps.length
    })
  }

  // One joint gain for every channel: the image is the thing this stage exists
  // to preserve, so no per-channel processing happens after the sum.
  let peak = 0
  for (const channel of master) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i])
      if (magnitude > peak) peak = magnitude
    }
  }
  const normalizeDbfs = request.normalizeDbfs === null ? null : Number(request.normalizeDbfs ?? -1)
  if (normalizeDbfs !== null && !Number.isFinite(normalizeDbfs)) {
    throw new Error(`renderSpatial: normalizeDbfs must be a number or null, got ${request.normalizeDbfs}`)
  }
  let appliedDb = 0
  if (normalizeDbfs !== null && peak > 0) {
    const target = dbToGain(clamp(normalizeDbfs, -120, 0))
    appliedDb = 20 * Math.log10(target / peak)
    const gain = target / peak
    for (const channel of master) {
      for (let i = 0; i < channel.length; i += 1) channel[i] *= gain
    }
  }

  const levels = channelLevels(master, layout)
  const report = {
    layout: layout.id,
    wavOrder: layout.wavOrder,
    channelMask: layout.mask,
    channelCount: layout.channelCount,
    sampleRate: rate,
    frames: totalFrames,
    bodyFrames,
    durationSeconds: round(totalFrames / rate, 6),
    bodySeconds: round(bodyFrames / rate, 6),
    roomTailSeconds: round(tailFrames / rate, 6),
    normalize: normalizeDbfs === null ? null : { targetDbfs: normalizeDbfs, appliedDb: round(appliedDb, 3) },
    peakDbfs: levels.peakDbfs,
    sources: entries,
    channels: levels.channels,
    room: { size: room.size, damping: room.damping, wet: room.wet, tapCount: room.wet > 0 ? REFLECTION_TAPS.length : 0 },
    widest: widestSource(entries, layout)
  }
  return { channels: master, sampleRate: rate, layout: layout.id, channelCount: layout.channelCount, report }
}

/**
 * Which source occupies the most of the layout — the number an agent reads to
 * know whether a pair actually spread out or collapsed into one speaker.
 *
 * `spreadChannels` counts channels within 20 dB of that source's loudest
 * channel; `spreadDegrees` is the *shortest* arc that covers those speakers
 * (360 minus the largest gap). Taking `max - min` instead would call a rear
 * source in a 5.1 layout 220° wide, because BL is -110 and BR is +110 while the
 * angle between them through the back is 140°. For B-format the source is in all
 * four components by construction, so the spread is reported as the full circle.
 *
 * @param {Array<object>} entries - per-source report entries.
 * @param {object} layout - frozen layout record.
 * @returns {object|null} the widest source, or null when there are no sources.
 */
function widestSource (entries, layout) {
  let best = null
  for (const entry of entries) {
    const loudest = Math.max(...entry.channels.map((channel) => channel.rmsDbfs))
    const carrying = entry.channels.filter((channel) => channel.rmsDbfs >= loudest - 20)
    const azimuths = carrying.map((channel) => channel.azimuth).filter((azimuth) => Number.isFinite(azimuth))
    let spreadDegrees = 0
    if (layout.panning === 'ambisonic') {
      spreadDegrees = 360
    } else if (azimuths.length >= 2) {
      const sorted = [...azimuths].sort((a, b) => a - b)
      let largestGap = 0
      for (let i = 0; i < sorted.length; i += 1) {
        const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360
        largestGap = Math.max(largestGap, next - sorted[i])
      }
      spreadDegrees = Math.round(360 - largestGap)
    }
    const candidate = {
      index: entry.index,
      azimuth: entry.position.azimuth,
      spreadChannels: carrying.length,
      spreadDegrees,
      channelNames: carrying.map((channel) => channel.name)
    }
    if (best === null || candidate.spreadChannels > best.spreadChannels ||
      (candidate.spreadChannels === best.spreadChannels && candidate.spreadDegrees > best.spreadDegrees)) {
      best = candidate
    }
  }
  return best
}

/* ------------------------------------------------------ multichannel writer -- */

const FORMAT_PCM = 1
const FORMAT_EXTENSIBLE = 0xFFFE
const EXTENSIBLE_FMT_BYTES = 40
const PLAIN_FMT_BYTES = 16
const EXTENSIBLE_HEADER_BYTES = 68
const PLAIN_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = { 16: 2, 24: 3 }
const DITHER_SEED = 0x2545F491

/** `KSDATAFORMAT_SUBTYPE_PCM`, the sub-format GUID of extensible integer PCM. */
const SUBTYPE_PCM = Buffer.from('0100000000001000800000aa00389b71', 'hex')

/**
 * `dwChannelMask` for each channel count this writer accepts. The masks follow
 * the WAVE format's speaker bit assignment; a count outside this table has no
 * standard meaning, which is why the writer refuses it instead of guessing.
 */
const MASK_BY_CHANNEL_COUNT = Object.freeze({ 1: 0x4, 2: 0x3, 4: 0x33, 6: 0x3f, 8: 0x63f })

/**
 * Write multichannel integer PCM as a WAVE file.
 *
 * `lib/wav.js` encodes 16-bit mono/stereo into a 44-byte canonical header, and
 * `lib/wav-encode.js` adds bit depths but caps at stereo. Multichannel needs the
 * third thing: a `WAVE_FORMAT_EXTENSIBLE` `fmt ` chunk, whose `dwChannelMask`
 * tells a decoder which of the six channels is the centre and which two are the
 * surrounds. Without it a 5.1 file decodes as six anonymous channels and every
 * player guesses the order.
 *
 * Every file this writes is extensible (`fmt ` = 40 bytes, mask from the layout),
 * because that is the only header that carries the order. `extensible: false` is
 * kept as the documented fallback for 1/2 channels — a plain 44-byte PCM header,
 * byte-identical in shape to what the rest of the plugin writes — for a consumer
 * that turns out to reject the extension.
 *
 * `decodeWav` in `lib/wav.js` reads the channel count at `fmt `+2 and the bit
 * depth at `fmt `+14, both of which are at the same offsets in an extensible
 * header, and any format tag other than 3 takes the integer path: 16- and
 * 24-bit extensible files therefore decode correctly, which the test proves on
 * real bytes. Only 32-bit IEEE float would be misread (its extensible tag is not
 * 3), so this writer offers integer PCM only.
 *
 * @param {Float32Array[]|Float64Array[]} channels - one buffer per channel, equal lengths.
 * @param {number} sampleRate - samples per second.
 * @param {{ bitDepth?: 16|24, channelMask?: number, layout?: string, extensible?: boolean, dither?: boolean }} [options]
 *   `layout` looks the mask up in `LAYOUTS` (an ambisonic layout legitimately has
 *   mask 0), `channelMask` overrides it, `dither` defaults to on at 16-bit.
 * @returns {Buffer} complete `.wav` bytes.
 */
export function encodeMultichannelWav (channels, sampleRate, options = {}) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('encodeMultichannelWav: at least one channel is required')
  const channelCount = channels.length
  if (MASK_BY_CHANNEL_COUNT[channelCount] === undefined && options.channelMask === undefined) {
    throw new Error(`encodeMultichannelWav: ${channelCount} channels has no WAVE channel mask; supported counts are ${Object.keys(MASK_BY_CHANNEL_COUNT).join(', ')} (or pass channelMask)`)
  }
  const frames = channels[0]?.length
  if (!Number.isInteger(frames)) throw new Error('encodeMultichannelWav: channel buffers must be typed arrays with a length')
  for (const channel of channels) {
    const isBuffer = channel instanceof Float32Array || channel instanceof Float64Array
    if (!isBuffer || channel.length !== frames) {
      throw new Error('encodeMultichannelWav: channels must be Float32Array/Float64Array buffers of equal length')
    }
  }
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`encodeMultichannelWav: sampleRate must be positive, got ${sampleRate}`)
  const bitDepth = Number(options.bitDepth ?? 16)
  if (BYTES_PER_SAMPLE[bitDepth] === undefined) {
    throw new Error(`encodeMultichannelWav: bitDepth must be 16 or 24, got ${options.bitDepth}`)
  }
  const extensible = options.extensible !== false
  if (!extensible && channelCount > 2) {
    throw new Error(`encodeMultichannelWav: a plain PCM header cannot describe ${channelCount} channels; use extensible`)
  }

  let mask = options.channelMask
  if (mask === undefined) {
    mask = options.layout !== undefined
      ? resolveLayout(options.layout).mask
      : MASK_BY_CHANNEL_COUNT[channelCount]
  }
  mask = Math.trunc(Number(mask))
  if (!Number.isFinite(mask) || mask < 0 || mask > 0x3ffff) throw new Error(`encodeMultichannelWav: invalid channelMask ${options.channelMask}`)

  const bytesPerSample = BYTES_PER_SAMPLE[bitDepth]
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = frames * blockAlign
  const padBytes = dataBytes % 2
  const headerBytes = extensible ? EXTENSIBLE_HEADER_BYTES : PLAIN_HEADER_BYTES
  const out = Buffer.alloc(headerBytes + dataBytes + padBytes)

  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(headerBytes - 8 + dataBytes + padBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(extensible ? EXTENSIBLE_FMT_BYTES : PLAIN_FMT_BYTES, 16)
  out.writeUInt16LE(extensible ? FORMAT_EXTENSIBLE : FORMAT_PCM, 20)
  out.writeUInt16LE(channelCount, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * blockAlign, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bitDepth, 34)
  if (extensible) {
    out.writeUInt16LE(22, 36) // cbSize: the extensible tail is 22 bytes
    out.writeUInt16LE(bitDepth, 38) // wValidBitsPerSample
    out.writeUInt32LE(mask >>> 0, 40) // dwChannelMask
    SUBTYPE_PCM.copy(out, 44)
  }
  out.write('data', extensible ? 60 : 36, 'ascii')
  out.writeUInt32LE(dataBytes, extensible ? 64 : 40)

  const dither = options.dither !== false && bitDepth === 16
  const random = makeRng(DITHER_SEED)
  const scale = 2 ** (bitDepth - 1)
  let offset = headerBytes
  for (let frame = 0; frame < frames; frame += 1) {
    // One dither draw per frame shared by all channels, exactly as
    // `lib/wav-encode.js` does and for the same reason: a mono signal written to
    // two identical channels must stay bit-identical, and independent per-channel
    // noise would round them apart.
    const noise = dither ? (random() - random()) / scale : 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      let value = channels[channel][frame]
      if (!Number.isFinite(value)) value = 0
      value += noise
      value = value > 1 ? 1 : value < -1 ? -1 : value
      if (bitDepth === 16) {
        const quantised = Math.round(value * 32768)
        out.writeInt16LE(quantised > 32767 ? 32767 : quantised, offset)
      } else {
        const quantised = Math.round(value * 8388608)
        out.writeIntLE(quantised > 8388607 ? 8388607 : quantised, offset, 3)
      }
      offset += bytesPerSample
    }
  }
  return out
}

/* ------------------------------------------------------------------ helpers -- */

/** Validate a sample rate into the supported range. */
function validateSampleRate (sampleRate, caller) {
  const rate = Math.round(Number(sampleRate))
  if (!Number.isFinite(rate) || rate < SPATIAL_LIMITS.minSampleRate || rate > SPATIAL_LIMITS.maxSampleRate) {
    throw new Error(`${caller}: sampleRate must be ${SPATIAL_LIMITS.minSampleRate}..${SPATIAL_LIMITS.maxSampleRate} Hz, got ${sampleRate}`)
  }
  return rate
}

/**
 * Resolve a position, clamping what can be clamped and rejecting what cannot be
 * interpreted. Azimuth wraps; distance beyond the limits is clamped because a
 * caller asking for 0 m means "close" and a caller asking for 1e9 m means "far".
 */
function resolvePosition (position = {}, caller = 'spatial') {
  return {
    azimuth: wrapAzimuth(numberOr(position?.azimuth, 0, `${caller} azimuth`)),
    elevation: clamp(numberOr(position?.elevation, 0, `${caller} elevation`), -90, 90),
    distance: clamp(numberOr(position?.distance, 1, `${caller} distance`), SPATIAL_LIMITS.minDistance, SPATIAL_LIMITS.maxDistance)
  }
}

/** Wrap an azimuth into (-180, 180]. */
function wrapAzimuth (azimuth) {
  const wrapped = ((Number(azimuth) + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}

/** One number argument with a clear error for NaN/Infinity. */
function numberOr (value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`spatial: ${label} must be a finite number, got ${value}`)
  return number
}

/**
 * Fold a source to mono. A stereo input (or one of `readTrack`'s channel arrays)
 * is averaged rather than summed, so a duplicated mono file does not arrive 6 dB
 * hot.
 */
function toMono (samples, caller) {
  if (samples === undefined || samples === null) throw new Error(`${caller}: samples are required`)
  if (Array.isArray(samples)) {
    if (samples.length === 0) throw new Error(`${caller}: samples array is empty`)
    const frames = samples[0].length
    const out = new Float32Array(frames)
    for (const channel of samples) {
      if (channel.length !== frames) throw new Error(`${caller}: channels must have equal length`)
      for (let i = 0; i < frames; i += 1) out[i] += channel[i]
    }
    for (let i = 0; i < frames; i += 1) out[i] /= samples.length
    return out
  }
  if (samples instanceof Float32Array) return samples
  if (samples instanceof Float64Array) return Float32Array.from(samples)
  throw new Error(`${caller}: samples must be a Float32Array, a Float64Array or an array of channel buffers`)
}

/**
 * Linear-interpolation resampler, same shape as `audio.js`'s: spatial placement
 * is a gain/delay problem, so a spatial render must not resample twice with two
 * different kernels.
 */
function resample (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = toRate / fromRate
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[index] ?? 0
    const b = samples[index + 1] ?? a
    out[i] = a + (b - a) * fraction
  }
  return out
}

/** Amplitude to dBFS with a floor, matching `audio.js`'s convention. */
function amplitudeDb (amplitude) {
  return amplitude > 0 ? round(20 * Math.log10(amplitude), 2) : MIN_LEVEL_DB
}

/** Round to a digit count, keeping null/undefined and infinities intact. */
function round (value, digits = 2) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
