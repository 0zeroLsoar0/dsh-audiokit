/**
 * Sound → mouth: per-frame viseme and jaw aperture from a monophonic signal.
 *
 * A mouth is the cheapest believable face in an animation, and it only reads as
 * *talking* when its shape lands on the audio. This module turns a rendered wav
 * into one viseme per animation frame, plus a continuous `openness` a jaw bone
 * (or a CSS `scaleY`) can follow without any further tuning.
 *
 * Why it is built this way:
 *   - The classifier works on band energy, formant peaks and noisiness (zero
 *     crossing rate + spectral flatness) because those three separate the
 *     physical mouth shapes: open vowels are loud and low, front vowels put
 *     energy at 1.8-2.4 kHz, fricatives are noisy and bright, a closed hum has
 *     almost no F2 at all.
 *   - Labels are then run-length smoothed with a minimum duration and a
 *     hysteresis pass. Frame-to-frame flicker (AA/AA/EH/AA) is the single most
 *     expensive artifact to fix downstream, so it is removed here.
 *   - Everything is pure and deterministic: the same samples and options give
 *     byte-identical JSON, which is what lets an animation author diff two
 *     takes and cache the track next to the wav.
 */

import { clamp } from './dsp.js'

const TAU = Math.PI * 2

/** The labels this module can emit, in a stable order. `none` is closed/rest. */
export const VISEMES = ['AA', 'EH', 'EE', 'OH', 'OO', 'MM', 'FF', 'TH', 'SS', 'DD', 'none']

/** Whitelist membership test, so every formatter uses the same set. */
const VISEME_SET = new Set(VISEMES)
/** A viseme is also used as a CSS class/selector fragment: no markup characters. */
const SAFE_VISEME = /^[A-Za-z0-9_-]+$/

/** Vowels, i.e. labels that require an open jaw. */
const VOWELS = new Set(['AA', 'EH', 'EE', 'OH', 'OO'])

/**
 * Jaw aperture per viseme, as a fraction of fully open. Used as the target for
 * the smoothed `openness` curve; a plosive is closed until it bursts.
 */
const OPENNESS = {
  AA: 1,
  EH: 0.62,
  EE: 0.42,
  OH: 0.78,
  OO: 0.34,
  MM: 0.03,
  FF: 0.16,
  TH: 0.24,
  SS: 0.14,
  DD: 0.22,
  none: 0
}

/**
 * Vowel prototypes in (F1, F2) space, plus the share of energy the 1.4-2.4 kHz
 * band should carry (front vowels ring there, back vowels do not). Distances are
 * measured in log-frequency, which is the scale formants are perceived on.
 */
const VOWEL_PROTOTYPES = [
  { viseme: 'AA', f1: 730, f2: 1180, front: 0.16 },
  { viseme: 'EH', f1: 560, f2: 1720, front: 0.34 },
  { viseme: 'EE', f1: 360, f2: 2180, front: 0.5 },
  { viseme: 'OH', f1: 480, f2: 830, front: 0.1 },
  { viseme: 'OO', f1: 370, f2: 720, front: 0.07 }
]

/**
 * Short runs of these labels are physically normal and must survive smoothing:
 * a plosive is one or two frames by definition, so stretching it to the minimum
 * duration would erase the only frame that reads as a consonant.
 */
const SHORT_RUN_EXEMPT = new Set(['DD'])

/** Normalised level below which a frame counts as silence. */
const SILENCE_LEVEL = 0.015

/* ------------------------------------------------------------------ fft -- */

function hann (size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos(TAU * i / (size - 1))
  return window
}

/**
 * Build a radix-2 FFT with precomputed bit reversal and twiddles. Twiddles are
 * shared across every frame, which is the difference between a 30 s analysis
 * that fits in a tool call and one that makes the model wait.
 * @param {number} size - power of two.
 * @returns {(real: Float64Array, imag: Float64Array) => void} in-place transform.
 */
function makeFft (size) {
  const levels = Math.round(Math.log2(size))
  const reversed = new Uint32Array(size)
  for (let i = 0; i < size; i += 1) {
    let value = 0
    for (let bit = 0; bit < levels; bit += 1) value |= ((i >> bit) & 1) << (levels - 1 - bit)
    reversed[i] = value
  }
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos(TAU * i / size)
    sin[i] = Math.sin(TAU * i / size)
  }
  return function transform (real, imag) {
    for (let i = 0; i < size; i += 1) {
      const j = reversed[i]
      if (j <= i) continue
      let swap = real[i]; real[i] = real[j]; real[j] = swap
      swap = imag[i]; imag[i] = imag[j]; imag[j] = swap
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1
      const stride = size / length
      for (let start = 0; start < size; start += length) {
        for (let k = 0; k < half; k += 1) {
          const angle = k * stride
          const wr = cos[angle]
          const wi = sin[angle]
          const ar = real[start + k]
          const ai = imag[start + k]
          const br = real[start + k + half] * wr + imag[start + k + half] * wi
          const bi = imag[start + k + half] * wr - real[start + k + half] * wi
          real[start + k] = ar + br
          imag[start + k] = ai + bi
          real[start + k + half] = ar - br
          imag[start + k + half] = ai - bi
        }
      }
    }
  }
}

/* ------------------------------------------------------------- features -- */

function round (value, digits) {
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

function asSamples (samples) {
  if (samples instanceof Float32Array) return samples
  if (Array.isArray(samples) || ArrayBuffer.isView(samples)) return Float32Array.from(samples)
  throw new TypeError('lipsync: samples must be an array-like of numbers')
}

/**
 * One frame of measurements. The time-domain block is short and centred on the
 * frame time so the level follows a tremolo without a phase lag; the FFT window
 * is longer because formant peaks need frequency resolution, not time precision.
 * @returns {object} energy, zcrHz, centroid, flatness, tonalRatio, f1, f2, bands, total.
 */
function analyseFrame (signal, rate, center, energyFrames, fft, window, real, imag) {
  const start = center - (energyFrames >> 1)
  const from = Math.max(0, start)
  const to = Math.min(signal.length, start + energyFrames)
  let sumSquares = 0
  let crossings = 0
  let previous = from < to ? signal[from] : 0
  for (let index = from; index < to; index += 1) {
    const sample = signal[index]
    sumSquares += sample * sample
    if (index > from && (sample < 0) !== (previous < 0)) crossings += 1
    previous = sample
  }
  const count = to - from
  const energy = count > 0 ? Math.sqrt(sumSquares / count) : 0
  const zcrHz = count > 1 ? (crossings / (count / rate)) / 2 : 0

  const size = real.length
  const half = size >> 1
  const windowStart = center - half
  for (let i = 0; i < size; i += 1) {
    const index = windowStart + i
    real[i] = (index >= 0 && index < signal.length ? signal[index] : 0) * window[i]
    imag[i] = 0
  }
  fft(real, imag)

  let total = 0
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let weighted = 0
  let logSum = 0
  let flatSum = 0
  let flatCount = 0
  let tonalMax = 0
  let tonalSum = 0
  let tonalCount = 0
  let f1Power = 0
  let f1 = 0
  for (let bin = 1; bin < half; bin += 1) {
    const hz = bin * rate / size
    const power = real[bin] * real[bin] + imag[bin] * imag[bin]
    if (hz >= 60 && hz < 9000) {
      total += power
      weighted += power * hz
      if (hz < 300) b0 += power
      else if (hz < 800) b1 += power
      else if (hz < 1400) b2 += power
      else if (hz < 2400) b3 += power
      else if (hz < 5000) b4 += power
      else b5 += power
    }
    if (hz >= 200 && hz <= 9000) {
      logSum += Math.log(power + 1e-12)
      flatSum += power
      flatCount += 1
    }
    if (hz >= 80 && hz <= 1200) {
      tonalSum += power
      tonalCount += 1
      if (power > tonalMax) tonalMax = power
    }
    if (hz >= 250 && hz <= 1100 && power > f1Power) {
      f1Power = power
      f1 = hz
    }
  }

  // F2 is searched above F1: a single strong harmonic must not be counted as
  // both formants, which would drag every back vowel towards AA.
  let f2Power = 0
  let f2 = 0
  const f2Low = Math.max(900, f1 * 1.15)
  for (let bin = 1; bin < half; bin += 1) {
    const hz = bin * rate / size
    if (hz < f2Low || hz > 2800) continue
    const power = real[bin] * real[bin] + imag[bin] * imag[bin]
    if (power > f2Power) {
      f2Power = power
      f2 = hz
    }
  }

  const arithmetic = flatCount > 0 ? flatSum / flatCount : 0
  const geometric = flatCount > 0 ? Math.exp(logSum / flatCount) : 0
  const flatness = arithmetic > 0 ? clamp(geometric / arithmetic, 0, 1) : 0
  const tonalRatio = tonalCount > 0 && tonalSum > 0 ? tonalMax / (tonalSum / tonalCount) : 0
  const centroid = total > 0 ? weighted / total : 0

  return {
    energy,
    zcrHz,
    centroid,
    flatness,
    tonalRatio,
    f1,
    f2,
    total,
    bands: [b0, b1, b2, b3, b4, b5],
    level: 0,
    voiced: false
  }
}

/**
 * Nearest vowel prototype in log(F1, F2) plus a frontness penalty. Peak picking
 * is used instead of a spectral centroid because harmonics of a low voice pull a
 * centroid around; the peak lands on the formant's harmonic regardless of pitch.
 */
function nearestVowel (frame) {
  const f1 = Math.max(frame.f1, 250)
  const f2 = Math.max(frame.f2, 400)
  const bands = frame.bands
  const front = bands[3] / (bands[1] + bands[2] + bands[3] + 1e-12)
  let best = 'AA'
  let bestScore = Infinity
  for (const proto of VOWEL_PROTOTYPES) {
    const d1 = Math.log2(f1 / proto.f1)
    const d2 = Math.log2(f2 / proto.f2)
    const dFront = front - proto.front
    const score = d1 * d1 + 0.85 * d2 * d2 + 1.6 * dFront * dFront
    if (score < bestScore) {
      bestScore = score
      best = proto.viseme
    }
  }
  return best
}

/**
 * One frame's raw label, from the acoustic evidence alone. Smoothing happens
 * afterwards; this function is intentionally stateless and easy to reason about.
 * @param {object} frame - output of `analyseFrame` with `level` assigned.
 * @param {number} previousLevel - level of the previous frame, for plosive bursts.
 * @returns {string} one of `VISEMES`.
 */
function classifyFrame (frame, previousLevel) {
  const level = frame.level
  if (level < SILENCE_LEVEL || frame.total <= 1e-12) return 'none'

  const voiced = level > 0.02 && frame.zcrHz < 2600 && frame.flatness < 0.4 && frame.tonalRatio > 3.5
  frame.voiced = voiced

  if (voiced) {
    const highRatio = (frame.bands[4] + frame.bands[5]) / (frame.total + 1e-12)
    // A hum: energy concentrated under 300 Hz, no F2 region at all, no fizz.
    // The 3x rule is what separates it from /u/ or /o/, whose second formant
    // still puts real energy in the 300-1400 Hz bands.
    if (frame.f1 < 340 && frame.bands[0] > 3 * (frame.bands[1] + frame.bands[2]) && highRatio < 0.08) return 'MM'
    return nearestVowel(frame)
  }

  // Unvoiced: fricatives and plosive bursts. Brightness separates the three
  // fricatives: SS hisses highest, FF sits in the middle, TH is the darkest.
  const noisy = frame.flatness > 0.35 || frame.zcrHz > 3000
  if (!noisy) return 'none'
  const burst = level > 0.2 && previousLevel < level * 0.5 && frame.centroid < 5200
  if (burst) return 'DD'
  if (frame.centroid >= 4800) return 'SS'
  if (frame.centroid >= 3000) return 'FF'
  if (frame.centroid >= 1200) return 'TH'
  return 'none'
}

/* ------------------------------------------------------------ smoothing -- */

/** Maximal runs of equal labels. */
function labelRuns (labels) {
  const runs = []
  let current = null
  for (let i = 0; i < labels.length; i += 1) {
    if (current !== null && labels[i] === current.label) {
      current.end = i
      continue
    }
    if (current !== null) runs.push(current)
    current = { label: labels[i], start: i, end: i }
  }
  if (current !== null) runs.push(current)
  return runs
}

/**
 * Merge runs shorter than `minFrames` into the longer neighbour. Repeated until
 * every run is long enough, so one noisy frame cannot flip a vowel and flip it
 * back two frames later.
 */
function mergeShortRuns (labels, minFrames, exempt) {
  // Each merge removes at least one run, so the loop cannot run longer than the
  // label count; the guard is belt and braces for pathological input.
  const guardLimit = labels.length + 16
  let guard = 0
  while (guard < guardLimit) {
    guard += 1
    const runs = labelRuns(labels)
    if (runs.length <= 1) break
    let merged = false
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]
      const length = run.end - run.start + 1
      if (length >= minFrames || exempt.has(run.label)) continue
      const before = runs[index - 1]
      const after = runs[index + 1]
      if (before === undefined && after === undefined) continue
      let target
      if (before === undefined) target = after.label
      else if (after === undefined) target = before.label
      else target = (before.end - before.start) >= (after.end - after.start) ? before.label : after.label
      if (target === run.label) continue
      for (let i = run.start; i <= run.end; i += 1) labels[i] = target
      merged = true
      break
    }
    if (!merged) break
  }
}

/**
 * Despike: a lone run whose neighbours agree is evidence, not a shape. This is
 * the hysteresis rule that makes the mouth *hold* a vowel until the next one is
 * clearly established, and it is what keeps `hysteresis` worth exposing.
 */
function despikeRuns (labels, switchFrames, exempt) {
  const guardLimit = labels.length + 16
  let guard = 0
  while (guard < guardLimit) {
    guard += 1
    const runs = labelRuns(labels)
    if (runs.length <= 2) break
    let changed = false
    for (let index = 1; index < runs.length - 1; index += 1) {
      const run = runs[index]
      const length = run.end - run.start + 1
      if (length >= switchFrames || exempt.has(run.label)) continue
      const before = runs[index - 1]
      const after = runs[index + 1]
      if (before.label !== after.label) continue
      for (let i = run.start; i <= run.end; i += 1) labels[i] = before.label
      changed = true
      break
    }
    if (!changed) break
  }
}

/* ----------------------------------------------------------------- api -- */

/**
 * Analyse a monophonic signal into one mouth shape per animation frame.
 *
 * @param {Float32Array|number[]} samples - mono samples.
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {number} [options.fps=24] - frames per second, 1..240.
 * @param {number} [options.minDurationMs=60] - shortest run a label may occupy.
 * @param {number} [options.hysteresis=0.5] - 0..1, how hard a vowel change must be
 *   to survive (0 = every frame stands, 1 = a change needs ~100 ms of evidence).
 * @param {number} [options.sensitivity=1] - level scaling before classification.
 * @param {number} [options.leadMs=0] - analyse this many ms ahead of each frame
 *   time, so the picture leads the sound by the display's latency budget.
 * @returns {{ fps: number, frames: Array<{ t: number, viseme: string, openness: number, energy: number, voiced: boolean }>, counts: object, leadMs: number, durationSeconds: number, voicedFrames: number }}
 */
export function analyzeVisemes (samples, sampleRate, options = {}) {
  const signal = asSamples(samples)
  const rate = clamp(Number(sampleRate) || 0, 1000, 384000)
  const fps = clamp(Math.round(Number(options.fps) || 24), 1, 240)
  const sensitivity = clamp(Number.isFinite(options.sensitivity) ? options.sensitivity : 1, 0.1, 8)
  const leadMs = clamp(Number.isFinite(options.leadMs) ? options.leadMs : 0, -500, 500)
  const minDurationMs = clamp(Number.isFinite(options.minDurationMs) ? options.minDurationMs : 60, 0, 400)
  const hysteresis = clamp(Number.isFinite(options.hysteresis) ? options.hysteresis : 0.5, 0, 1)
  const durationSeconds = signal.length / rate
  const frameCount = Math.max(0, Math.round(durationSeconds * fps))

  const counts = {}
  for (const viseme of VISEMES) counts[viseme] = 0
  if (frameCount === 0) {
    return { fps, frames: [], counts, leadMs, durationSeconds, voicedFrames: 0 }
  }

  const fftSize = rate <= 24000 ? 512 : 1024
  const fft = makeFft(fftSize)
  const window = hann(fftSize)
  const real = new Float64Array(fftSize)
  const imag = new Float64Array(fftSize)
  const leadSamples = Math.round(leadMs / 1000 * rate)
  const energyFrames = clamp(Math.round(rate / fps), 64, Math.round(rate * 0.05))

  const features = new Array(frameCount)
  let maxEnergy = 0
  for (let i = 0; i < frameCount; i += 1) {
    const center = Math.round(i * rate / fps) + leadSamples
    const frame = analyseFrame(signal, rate, center, energyFrames, fft, window, real, imag)
    features[i] = frame
    if (frame.energy > maxEnergy) maxEnergy = frame.energy
  }

  // Level is normalised against the loudest frame, so `sensitivity` means the
  // same thing for a whisper and for a scream, and a silent file stays at 0.
  const labels = new Array(frameCount)
  const targetOpen = new Float64Array(frameCount)
  let previousLevel = 0
  for (let i = 0; i < frameCount; i += 1) {
    const frame = features[i]
    frame.level = maxEnergy > 0 ? clamp(frame.energy / maxEnergy * sensitivity, 0, 1) : 0
    labels[i] = classifyFrame(frame, previousLevel)
    const gate = 0.4 + 0.6 * frame.level
    targetOpen[i] = OPENNESS[labels[i]] * gate
    previousLevel = frame.level
  }

  const minFrames = Math.max(1, Math.ceil(minDurationMs / 1000 * fps))
  const switchFrames = Math.max(2, Math.round((0.03 + hysteresis * 0.07) * fps))
  mergeShortRuns(labels, minFrames, SHORT_RUN_EXEMPT)
  despikeRuns(labels, switchFrames, SHORT_RUN_EXEMPT)

  // Jaw aperture: fast attack, slower release. A mouth that snaps shut at the
  // same rate it opens reads as a puppet; the asymmetric one reads as a jaw.
  const attack = 1 - Math.exp(-(1 / fps) / 0.02)
  const release = 1 - Math.exp(-(1 / fps) / 0.09)
  let openness = 0
  const frames = new Array(frameCount)
  let voicedFrames = 0
  for (let i = 0; i < frameCount; i += 1) {
    const target = targetOpen[i]
    openness += (target - openness) * (target > openness ? attack : release)
    const frame = features[i]
    const viseme = labels[i]
    if (frame.voiced) voicedFrames += 1
    counts[viseme] += 1
    frames[i] = {
      t: round(i / fps, 6),
      viseme,
      openness: round(clamp(openness, 0, 1), 3),
      energy: round(frame.level, 3),
      voiced: frame.voiced
    }
  }

  return { fps, frames, counts, leadMs, durationSeconds: round(durationSeconds, 6), voicedFrames }
}

function inferFps (frames, fallback = 24) {
  if (frames.length >= 2) {
    const delta = frames[1].t - frames[0].t
    if (delta > 0) return Math.max(1, Math.round(1 / delta))
  }
  return fallback
}

function inferDuration (frames, fps) {
  if (frames.length === 0) return 0
  return frames[frames.length - 1].t + 1 / fps
}

function countVisemes (frames) {
  const counts = {}
  for (const viseme of VISEMES) counts[viseme] = 0
  for (const frame of frames) {
    if (counts[frame.viseme] !== undefined) counts[frame.viseme] += 1
  }
  return counts
}

/** Runs of equal viseme with start/end in seconds, for the textual formats. */
function visemeRuns (frames, fps) {
  const runs = []
  let current = null
  const step = 1 / fps
  for (const frame of frames) {
    if (current !== null && frame.viseme === current.viseme) {
      current.end = frame.t + step
      continue
    }
    if (current !== null) runs.push(current)
    current = { viseme: frame.viseme, start: frame.t, end: frame.t + step }
  }
  if (current !== null) runs.push(current)
  return runs
}

function timecode (seconds) {
  const total = Math.max(0, Math.round(seconds * 1000))
  const milliseconds = total % 1000
  const secs = Math.floor(total / 1000) % 60
  const mins = Math.floor(total / 60000) % 60
  const hours = Math.floor(total / 3600000)
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(mins, 2)}:${pad(secs, 2)},${pad(milliseconds, 3)}`
}

/**
 * Force every frame's `viseme` onto the module whitelist.
 *
 * The textual formats interpolate the label straight into an SRT cue or a CSS
 * selector, so a hand-edited track (or one from another tool) could inject
 * arbitrary text there. An unknown label becomes `none` — a closed mouth is the
 * safe rendering of "shape not understood" — and the substitution is reported
 * through `warnings` when the caller passes an array. Frames that are already
 * valid are returned by reference, so an engine-generated track formats exactly
 * as before.
 *
 * @param {Array<object>} frames - frame list, possibly from outside this module.
 * @param {string[]} [warnings] - optional sink for a summary line.
 * @returns {Array<object>} frames whose `viseme` is in `VISEMES`.
 */
function sanitiseFrames (frames, warnings) {
  const list = Array.isArray(frames) ? frames : []
  const clean = new Array(list.length)
  const unknown = new Map()
  let replaced = 0
  for (let i = 0; i < list.length; i += 1) {
    const frame = list[i] !== null && typeof list[i] === 'object' ? list[i] : { t: 0 }
    const viseme = frame.viseme
    if (typeof viseme === 'string' && VISEME_SET.has(viseme)) {
      clean[i] = frame
      continue
    }
    const label = typeof viseme === 'string' ? viseme : String(viseme)
    const shown = label.length > 24 ? `${label.slice(0, 24)}…` : label
    unknown.set(shown, (unknown.get(shown) ?? 0) + 1)
    replaced += 1
    clean[i] = { ...frame, viseme: 'none' }
  }
  if (replaced > 0 && Array.isArray(warnings)) {
    const labels = [...unknown.entries()].map(([label, count]) => `${JSON.stringify(label)}×${count}`).join(', ')
    warnings.push(`lipsync: ${replaced} frame(s) had a viseme outside the whitelist (${labels}); used "none"`)
  }
  return clean
}

/**
 * Render the track as SubRip cues, one cue per viseme run.
 *
 * Synthesis has no sentences to subtitle, so the "text" of each cue is the
 * viseme code: a player can read the SRT and switch the mouth layer directly.
 * Silent gaps are omitted (absence of a cue already means closed mouth), which
 * is also what keeps the file small enough to ship next to a page.
 *
 * @param {Array<object>} frames - frames from `analyzeVisemes` (or any frame list;
 *   labels outside `VISEMES` are replaced with `none`).
 * @param {object} [options] - `fps`, `includeSilence` (default false), `warnings`
 *   (array that receives a note when an unknown viseme was replaced).
 * @returns {string} SRT document.
 */
export function visemeToSrt (frames, options = {}) {
  const list = sanitiseFrames(frames, options.warnings)
  const fps = Number.isFinite(options.fps) ? options.fps : inferFps(list)
  const includeSilence = options.includeSilence === true
  const lines = []
  let index = 0
  for (const run of visemeRuns(list, fps)) {
    if (!includeSilence && run.viseme === 'none') continue
    index += 1
    lines.push(String(index))
    lines.push(`${timecode(run.start)} --> ${timecode(run.end)}`)
    lines.push(run.viseme)
    lines.push('')
  }
  return lines.length > 0 ? lines.join('\n') : ''
}

/* ---- css: a keyframe track usable without registering custom properties -- */

function percentage (value) {
  return `${round(clamp(value, 0, 100), 2)}%`
}

/**
 * CSS cannot interpolate an unregistered custom property, so the track is split
 * the way the browser can actually animate it: one `@keyframes` per viseme that
 * switches an opacity step (`steps(1, end)`), plus one continuous `@keyframes`
 * for the jaw that scales a layer on Y. No `@property`, no JavaScript required.
 */
function buildCssTrack (frames, meta) {
  const runs = visemeRuns(frames, meta.fps)
  const duration = meta.duration > 0 ? meta.duration : 1 / meta.fps
  const lines = []
  lines.push('/* dsh-audiokit lipsync track')
  lines.push(`   ${meta.fps} fps · ${duration.toFixed(3)} s · ${frames.length} frames · lead ${meta.leadMs} ms`)
  lines.push('   markup: <div class="dsh-mouth"><i class="v-AA"></i>…<i class="dsh-jaw"></i></div>')
  lines.push('   .v-* layers switch with steps(1,end); .dsh-jaw scales continuously on Y. */')
  lines.push(`.dsh-mouth { --dsh-fps: ${meta.fps}; --dsh-duration: ${duration.toFixed(3)}s; --dsh-lead: ${meta.leadMs}ms; --dsh-frames: ${frames.length}; position: relative; }`)
  lines.push('.dsh-mouth > i { position: absolute; inset: 0; opacity: 0; animation-duration: var(--dsh-duration); animation-fill-mode: both; animation-timing-function: steps(1, end); }')
  lines.push('.dsh-mouth > .dsh-jaw { opacity: 1; transform-origin: 50% 100%; animation: dsh-jaw var(--dsh-duration) linear both; }')

  const present = []
  for (const viseme of VISEMES) {
    if (viseme === 'none') continue
    // The label becomes a class name and a keyframes name below; keep that
    // filter even though `sanitiseFrames` already guarantees the whitelist.
    if (!SAFE_VISEME.test(viseme)) continue
    if (runs.some((run) => run.viseme === viseme)) present.push(viseme)
  }
  for (const viseme of present) {
    lines.push(`.dsh-mouth > .v-${viseme} { animation-name: dsh-v-${viseme}; }`)
  }
  for (const viseme of present) {
    const ranges = runs
      .filter((run) => run.viseme === viseme)
      .map((run) => [run.start / duration * 100, run.end / duration * 100])
    const stops = []
    if (ranges[0][0] > 0.001) stops.push('0% { opacity: 0 }')
    for (const [start, end] of ranges) {
      stops.push(`${percentage(start)} { opacity: 1 }`)
      if (end < 99.999) stops.push(`${percentage(end)} { opacity: 0 }`)
    }
    lines.push(`@keyframes dsh-v-${viseme} { ${stops.join(' ')} }`)
  }

  // Jaw: emit a keyframe only where the aperture actually moves, which is what
  // keeps a 30 s track down to a few dozen lines instead of one per frame.
  const jaw = []
  let previousOpen = -1
  for (let i = 0; i < frames.length; i += 1) {
    const open = clamp(frames[i].openness, 0, 1)
    if (i === 0 || i === frames.length - 1 || Math.abs(open - previousOpen) > 0.02) {
      jaw.push({ at: i / frames.length * 100, open })
      previousOpen = open
    }
  }
  if (jaw.length > 0 && jaw[jaw.length - 1].at < 99.999) jaw.push({ at: 100, open: jaw[jaw.length - 1].open })
  const jawStops = jaw.map((point) => `${percentage(point.at)} { transform: scaleY(${point.open.toFixed(3)}) }`)
  lines.push(`@keyframes dsh-jaw { ${jawStops.join(' ')} }`)
  return lines.join('\n') + '\n'
}

/* ---- ae: After Effects keyframe paste ---- */

function buildAeTrack (frames) {
  const lines = []
  let previous = null
  for (const frame of frames) {
    if (frame.viseme === previous) continue
    lines.push(`${frame.t.toFixed(3)}\t${frame.viseme}`)
    previous = frame.viseme
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * Format a viseme track for a consumer that is not this library.
 *
 * - `json`: the complete analysis, `{ format, version, fps, duration, leadMs, counts, frames }`.
 * - `srt`: SubRip cues (see `visemeToSrt`), readable by any subtitle/sync player.
 * - `css`: an opacity-step + jaw-scale keyframe track, no `@property` needed.
 * - `ae`: After Effects text-keyframe paste, one `time<TAB>shape` line per change.
 *
 * @param {Array<object>} frames - frames from `analyzeVisemes` (or any frame list;
 *   labels outside `VISEMES` are replaced with `none` before formatting).
 * @param {'json'|'srt'|'css'|'ae'} [format='json'] - target consumer.
 * @param {object} [options] - `fps`, `leadMs`, `duration`, `includeSilence`,
 *   `warnings` (array that receives a note when an unknown viseme was replaced).
 * @returns {string} the formatted track.
 */
export function visemeToTimeline (frames, format = 'json', options = {}) {
  const list = sanitiseFrames(frames, options.warnings)
  const fps = Number.isFinite(options.fps) ? options.fps : inferFps(list)
  const duration = Number.isFinite(options.duration) ? options.duration : inferDuration(list, fps)
  const leadMs = Number.isFinite(options.leadMs) ? options.leadMs : 0
  const meta = { fps, duration, leadMs }
  switch (format) {
    case 'json': {
      const payload = {
        format: 'dsh-audio-lipsync',
        version: 1,
        fps,
        duration: round(duration, 3),
        leadMs,
        counts: countVisemes(list),
        frames: list
      }
      return JSON.stringify(payload, null, 2)
    }
    case 'srt':
      return visemeToSrt(list, { fps, includeSilence: options.includeSilence === true })
    case 'css':
      return buildCssTrack(list, meta)
    case 'ae':
      return buildAeTrack(list)
    default:
      throw new Error(`unknown lipsync format "${format}"; use json, srt, css or ae`)
  }
}

/**
 * Soften an existing track. Two things change: `openness` and `energy` are
 * smoothed with a phase-neutral forward+backward filter, and runs shorter than
 * the requested strength are merged, so a hand-edited track can be de-flickered
 * without re-running the analysis.
 *
 * @param {Array<object>} frames - frames from `analyzeVisemes`.
 * @param {number} [amount=0.5] - 0..1 smoothing strength.
 * @returns {Array<object>} a new array; the input is never mutated.
 */
export function smoothFrames (frames, amount = 0.5) {
  if (!Array.isArray(frames)) throw new TypeError('smoothFrames: frames must be an array')
  const strength = clamp(Number.isFinite(amount) ? amount : 0.5, 0, 1)
  const out = frames.map((frame) => ({ ...frame }))
  if (out.length === 0 || strength === 0) return out

  const alpha = strength * 0.75
  for (const field of ['openness', 'energy']) {
    if (typeof out[0][field] !== 'number') continue
    for (const direction of [1, -1]) {
      const start = direction === 1 ? 0 : out.length - 1
      const end = direction === 1 ? out.length : -1
      let previous = out[start][field] ?? 0
      for (let i = start; i !== end; i += direction) {
        const value = out[i][field] ?? 0
        previous += (value - previous) * alpha
        out[i][field] = round(previous, 3)
      }
    }
  }

  const labels = out.map((frame) => frame.viseme)
  mergeShortRuns(labels, Math.max(2, Math.round(2 + strength * 4)), SHORT_RUN_EXEMPT)
  for (let i = 0; i < out.length; i += 1) out[i].viseme = labels[i]
  return out
}

/** True when a viseme label opens the jaw, exported for consumers that need it. */
export function isVowelViseme (viseme) {
  return VOWELS.has(viseme)
}
