/**
 * Signal analysis: what is *inside* one sound.
 *
 * `measure` in ./audio.js answers "how loud and how long"; this module answers
 * "what does it sound like" — fundamental, partials and their inharmonicity,
 * spectral tilt and centroid, how noisy it is, where its formants sit, how it
 * decays, how it starts. All of it deterministic and bounded, so an agent can
 * decide "this door slam reads as a tin can, weight it up" without hearing it,
 * and `compareSounds` can prove a tweak kept the character.
 *
 * Honest limits, stated up front because an agent will trust these numbers:
 * - **F0** is normalised autocorrelation with a "first peak near the global
 *   maximum" rule (so a strong partial cannot pull it an octave down), then
 *   refined by a least-squares fit through the measured partials. Trust it for
 *   a periodic sound; for noise the confidence stays low and `hz` is 0 rather
 *   than a guess.
 * - **Harmonics** are the local maxima of the (windowed, frame-averaged) power
 *   spectrum within ±4 % of n·f0. `levelDb` is an absolute amplitude in dBFS
 *   (a full-scale sine reads about -3 dB); `relDb` is against the fundamental.
 * - **Inharmonicity** is the RMS cents deviation of those partials from exact
 *   integer multiples of the refined f0. A sawtooth is a fraction of a cent, a
 *   bell or a struck plate is tens of cents.
 * - **Formants** are the local maxima of a *smoothed log-power spectrum*: the
 *   log spectrum is moving-average filtered over roughly one and a half
 *   partials, which is the cheap cousin of cepstral liftering / LPC. There is
 *   no vocal-tract model behind them, so they are a spectral-envelope
 *   description (good to a few percent for a sustained vowel, approximate for a
 *   short transient) and the reported bandwidth is the -3 dB width of that
 *   smoothed envelope with the smoothing width subtracted — a rough figure,
 *   not a Q measurement.
 * - **RT60** is a straight-line fit through the RMS envelope from the peak down
 *   60 dB. Exact for a single exponential tail; for a multi-stage decay the
 *   slope is an average and `fitR2` says how much to believe it (`curve` is
 *   'exp', 'linear' or 'irregular'). 0 means "no decay measurable".
 * - **Onset** latency is the first sample above 2 % of the peak; attack is the
 *   10 %→90 % amplitude rise time on a 5 ms envelope; `type` is 'swell'
 *   (attack ≥ 120 ms), 'sustained' (within 6 dB of the peak for ≥ 250 ms),
 *   'percussive' (attack ≤ 15 ms and no plateau), 'plucked' (in between) or
 *   'silent'.
 *
 * Cost is a handful of 4096-point FFTs: 3 s at 44.1 kHz analyses in a few tens
 * of milliseconds. Identical input gives identical numbers — no randomness, no
 * clock, no locale-dependent formatting.
 */

import { clamp } from './dsp.js'

/* --------------------------------------------------------------- limits -- */

/** Analysis window ceiling. 4096 at 44.1 kHz is 93 ms: 3.7 periods of 40 Hz. */
const FFT_CAP = 4096

/** Reported when a level is below anything a 16-bit file can carry. */
const SILENT_DB = -120

/** Frames averaged for the spectrum: one frame is a coin flip on a noisy sound. */
const MAX_SPECTRUM_FRAMES = 8

/** Envelope hop for onset/decay, in seconds. 5 ms is fine for a 2 ms attack. */
const ENVELOPE_HOP_SECONDS = 0.005

/** Bands an agent can reason about ("it has no low end"). `relDb` is vs loudest. */
const BAND_TABLE = Object.freeze([
  { name: 'sub', lo: 20, hi: 60 },
  { name: 'low', lo: 60, hi: 250 },
  { name: 'lowMid', lo: 250, hi: 500 },
  { name: 'mid', lo: 500, hi: 2000 },
  { name: 'highMid', lo: 2000, hi: 6000 },
  { name: 'high', lo: 6000, hi: 12000 },
  { name: 'air', lo: 12000, hi: 20000 }
])

/* -------------------------------------------------------------- numbers -- */

/** Round for a stable report; a non-finite intermediate becomes 0, never NaN. */
function round (value, digits = 3) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Amplitude → dBFS, floored instead of -Infinity. */
function amplitudeDb (amplitude) {
  return amplitude > 0 ? Math.max(SILENT_DB, 20 * Math.log10(amplitude)) : SILENT_DB
}

/** Accept any array-like of samples; non-finite values read as silence. */
function asSamples (input) {
  if (input instanceof Float32Array) {
    // The clean buffer is the common case and is used as-is; copying a
    // multi-second cue to learn it contained nothing to fix would be waste. A
    // single NaN, however, must be folded to silence first: one poison sample
    // is enough to make the window energy non-finite, and every metric that
    // depends on it then collapses to 0 through `round()`.
    for (let i = 0; i < input.length; i += 1) {
      if (!Number.isFinite(input[i])) {
        const out = new Float32Array(input.length)
        for (let j = 0; j < input.length; j += 1) out[j] = Number.isFinite(input[j]) ? input[j] : 0
        return out
      }
    }
    return input
  }
  if (ArrayBuffer.isView(input)) {
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i += 1) out[i] = Number.isFinite(input[i]) ? input[i] : 0
    return out
  }
  if (Array.isArray(input)) {
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i += 1) out[i] = Number.isFinite(input[i]) ? input[i] : 0
    return out
  }
  throw new Error('analyzeSound: samples must be a Float32Array or an array of numbers')
}

function nextPow2 (value) {
  let size = 1
  while (size < value) size <<= 1
  return size
}

/* ------------------------------------------------------------------ FFT -- */

const fftCache = new Map()

/**
 * Radix-2 decimation-in-time FFT with precomputed twiddles and a bit-reversal
 * table. The table lives with the returned closure, so analysing a batch of
 * sounds pays for it once.
 * @param {number} size - power of two.
 * @returns {(real: Float64Array, imag: Float64Array) => void} in-place transform.
 */
function makeFft (size) {
  const levels = Math.round(Math.log2(size))
  const half = size >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let i = 0; i < half; i += 1) {
    cos[i] = Math.cos(2 * Math.PI * i / size)
    sin[i] = -Math.sin(2 * Math.PI * i / size)
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
  return function fft (real, imag) {
    for (let i = 0; i < size; i += 1) {
      const j = reverse[i]
      if (j > i) {
        let swap = real[i]; real[i] = real[j]; real[j] = swap
        swap = imag[i]; imag[i] = imag[j]; imag[j] = swap
      }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const step = size / span
      const quarter = span >> 1
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
  }
}

function fftFor (size) {
  let fft = fftCache.get(size)
  if (fft === undefined) {
    fft = makeFft(size)
    fftCache.set(size, fft)
  }
  return fft
}

/** Inverse by conjugation: ifft(x) = conj(fft(conj(x))) / size. */
function inverseFft (fft, real, imag) {
  const size = real.length
  for (let i = 0; i < size; i += 1) imag[i] = -imag[i]
  fft(real, imag)
  for (let i = 0; i < size; i += 1) {
    real[i] /= size
    imag[i] = -imag[i] / size
  }
}

function hannWindow (size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size)
  return window
}

/* --------------------------------------------------------------- spectrum -- */

/**
 * Longest power-of-two frame the signal can hold, capped at FFT_CAP. A 3 s file
 * gets the full 4096; a 50 ms tick gets 2048, which still holds plenty of
 * periods of anything above 80 Hz.
 */
function frameSizeFor (length) {
  let size = 256
  while (size * 2 <= FFT_CAP && size * 2 <= length) size *= 2
  return size
}

/**
 * Frames the spectrum is measured on.
 *
 * Only frames within 12 dB of the loudest one are used (silence would drag the
 * flatness and band balance toward the noise floor), and up to eight of them
 * are spread across the loud region so the whole sound is represented rather
 * than only its first attack frame.
 */
function selectFrames (signal, frameSize) {
  const hop = Math.max(1, frameSize >> 1)
  const starts = []
  const energies = []
  let loudestIndex = 0
  let loudestEnergy = 0
  for (let start = 0; start + frameSize <= signal.length; start += hop) {
    let energy = 0
    for (let i = 0; i < frameSize; i += 1) {
      const value = signal[start + i]
      energy += value * value
    }
    if (energy > loudestEnergy) {
      loudestEnergy = energy
      loudestIndex = starts.length
    }
    starts.push(start)
    energies.push(energy)
  }
  if (starts.length === 0) return { starts: [0], loudestStart: 0 }
  const threshold = loudestEnergy * 0.0625
  const loud = []
  for (let index = 0; index < starts.length; index += 1) {
    if (energies[index] > 0 && energies[index] >= threshold) loud.push(index)
  }
  const picked = []
  if (loud.length <= MAX_SPECTRUM_FRAMES) {
    picked.push(...loud)
  } else {
    for (let k = 0; k < MAX_SPECTRUM_FRAMES; k += 1) {
      picked.push(loud[Math.round(k * (loud.length - 1) / (MAX_SPECTRUM_FRAMES - 1))])
    }
  }
  if (picked.length === 0) picked.push(loudestIndex)
  return { starts: picked.map((index) => starts[index]), loudestStart: starts[loudestIndex] }
}

/**
 * Mean power spectrum of the selected frames.
 *
 * The amplitudes come out calibrated: for a Hann window and a sinusoid of
 * amplitude A at a bin centre, |X| = A·sum(w)/2, so `2·sqrt(mean power)/sum(w)`
 * is A again. That is what makes `levelDb` an honest dBFS number.
 * @returns {{ power: Float64Array, binHz: number, windowSum: number, frameSize: number, frames: number, loudestStart: number }}
 */
function buildSpectrum (signal, sampleRate) {
  const frameSize = frameSizeFor(signal.length)
  const { starts, loudestStart } = selectFrames(signal, frameSize)
  const fft = fftFor(frameSize)
  const window = hannWindow(frameSize)
  let windowSum = 0
  for (let i = 0; i < frameSize; i += 1) windowSum += window[i]
  const bins = (frameSize >> 1) + 1
  const power = new Float64Array(bins)
  const real = new Float64Array(frameSize)
  const imag = new Float64Array(frameSize)
  for (const start of starts) {
    for (let i = 0; i < frameSize; i += 1) {
      const index = start + i
      real[i] = (index < signal.length ? signal[index] : 0) * window[i]
      imag[i] = 0
    }
    fft(real, imag)
    for (let bin = 0; bin < bins; bin += 1) power[bin] += real[bin] * real[bin] + imag[bin] * imag[bin]
  }
  const count = Math.max(1, starts.length)
  for (let bin = 0; bin < bins; bin += 1) power[bin] /= count
  return { power, binHz: sampleRate / frameSize, windowSum, frameSize, frames: count, loudestStart }
}

/* ---------------------------------------------------------- spectral math -- */

/** Parabolic peak frequency of a magnitude spectrum around `bin`. */
function peakHz (power, bin, binHz) {
  const left = Math.sqrt(Math.max(0, power[bin - 1] ?? 0))
  const centre = Math.sqrt(Math.max(0, power[bin]))
  const right = Math.sqrt(Math.max(0, power[bin + 1] ?? 0))
  const denominator = left - 2 * centre + right
  const delta = Math.abs(denominator) > 1e-12 ? 0.5 * (left - right) / denominator : 0
  return (bin + clamp(delta, -0.5, 0.5)) * binHz
}

/** Parabolic peak amplitude (full-scale units) of a windowed power spectrum. */
function peakAmplitude (power, bin, windowSum) {
  const left = Math.sqrt(Math.max(0, power[bin - 1] ?? 0))
  const centre = Math.sqrt(Math.max(0, power[bin]))
  const right = Math.sqrt(Math.max(0, power[bin + 1] ?? 0))
  const denominator = left - 2 * centre + right
  const delta = Math.abs(denominator) > 1e-12 ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0
  const vertex = Math.max(0, centre - 0.25 * (left - right) * delta)
  return windowSum > 0 ? 2 * vertex / windowSum : 0
}

/* ----------------------------------------------------------------- pitch -- */

/**
 * Biased autocorrelation over one window, computed by FFT (Wiener–Khinchin) so
 * the lag search costs two transforms instead of N·maxLag multiplies.
 * @returns {Float64Array} r[lag]; r[0] is the window energy.
 */
function autocorrelation (signal, start, length) {
  const size = nextPow2(Math.max(2 * length, 256))
  const fft = fftFor(size)
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  let mean = 0
  for (let i = 0; i < length; i += 1) mean += signal[start + i]
  mean /= Math.max(1, length)
  for (let i = 0; i < length; i += 1) real[i] = signal[start + i] - mean
  fft(real, imag)
  for (let i = 0; i < size; i += 1) {
    real[i] = real[i] * real[i] + imag[i] * imag[i]
    imag[i] = 0
  }
  inverseFft(fft, real, imag)
  return real
}

/**
 * Fundamental from autocorrelation.
 *
 * The peak is picked as the first local maximum within 90 % of the global one:
 * every multiple of the true period correlates about as well as the period
 * itself, so taking the global maximum reports an octave (or two) low on any
 * harmonic-rich sound.
 * @returns {{ hz: number, clarity: number }} clarity is r[lag]/r[0].
 */
function autocorrelationPitch (signal, start, sampleRate, minHz, maxHz) {
  const available = signal.length - start
  const length = Math.min(available, FFT_CAP)
  if (length < 32) return { hz: 0, clarity: 0 }
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz))
  const maxLag = Math.min(Math.floor(sampleRate / minHz), length - 2)
  if (maxLag <= minLag) return { hz: 0, clarity: 0 }
  const r = autocorrelation(signal, start, length)
  const r0 = r[0]
  if (!(r0 > 0)) return { hz: 0, clarity: 0 }
  let bestLag = minLag
  let bestValue = -Infinity
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = r[lag] / r0
    if (value > bestValue) {
      bestValue = value
      bestLag = lag
    }
  }
  const threshold = bestValue * 0.9
  let chosen = -1
  for (let lag = Math.max(minLag, 2); lag < maxLag; lag += 1) {
    const value = r[lag] / r0
    if (value >= threshold && value >= r[lag - 1] / r0 && value >= r[lag + 1] / r0) {
      chosen = lag
      break
    }
  }
  if (chosen < 0) chosen = bestLag
  const left = r[chosen - 1] / r0
  const centre = r[chosen] / r0
  const right = r[chosen + 1] / r0
  const denominator = left - 2 * centre + right
  const delta = Math.abs(denominator) > 1e-12 ? 0.5 * (left - right) / denominator : 0
  const lag = chosen + clamp(delta, -0.5, 0.5)
  return { hz: lag > 0 ? sampleRate / lag : 0, clarity: clamp(centre, 0, 1) }
}

/**
 * Harmonic product spectrum, used as a cross-check on the autocorrelation.
 *
 * Each candidate fundamental is scored by the geometric mean of the power at
 * its first five multiples; a harmonic stack towers over its neighbours, a
 * noise floor does not. The score is compared with the median over the search
 * range, which is what turns "the product is big" into a confidence.
 * @returns {{ hz: number, confidence: number }} hz=0 when nothing stands out.
 */
function harmonicProductPitch (spectrum, minHz, maxHz) {
  const { power, binHz } = spectrum
  const bins = power.length - 1
  const factor = 5
  if (bins < 16) return { hz: 0, confidence: 0 }
  const minBin = Math.max(1, Math.ceil(minHz / binHz))
  const maxBin = Math.min(bins - 2, Math.floor(Math.min(maxHz, binHz * (bins - 1) / factor) / binHz))
  if (maxBin <= minBin + 2) return { hz: 0, confidence: 0 }
  let maxPower = 0
  for (let bin = 1; bin < bins; bin += 1) if (power[bin] > maxPower) maxPower = power[bin]
  if (!(maxPower > 0)) return { hz: 0, confidence: 0 }
  const floor = maxPower * 1e-12
  const scores = new Float64Array(maxBin - minBin + 1)
  let bestScore = -Infinity
  let bestBin = minBin
  for (let bin = minBin; bin <= maxBin; bin += 1) {
    let score = 0
    for (let k = 1; k <= factor; k += 1) score += Math.log(power[bin * k] + floor)
    score /= factor
    scores[bin - minBin] = score
    if (score > bestScore) {
      bestScore = score
      bestBin = bin
    }
  }
  const sorted = Float64Array.from(scores).sort()
  const median = sorted[sorted.length >> 1]
  const peakinessDb = (bestScore - median) * 10 / Math.LN10
  return { hz: bestBin * binHz, confidence: clamp((peakinessDb - 8) / 25, 0, 1) }
}

/* ------------------------------------------------------------ harmonics -- */

/**
 * The partials of `f0` that are actually present.
 * @returns {{ n: number, hz: number, levelDb: number, relDb: number }[]}
 */
function readHarmonics (spectrum, f0, maxHarmonics) {
  const { power, binHz, windowSum } = spectrum
  const lastBin = power.length - 1
  const nyquist = lastBin * binHz
  const rows = []
  if (!(f0 > 0)) return rows
  for (let n = 1; n <= maxHarmonics; n += 1) {
    const expected = n * f0
    if (expected >= nyquist * 0.98) break
    // The window must stay inside one harmonic spacing, or at high n it reaches
    // past its neighbours and a 1/n stack reports the strong lower partial as
    // if it were this one — that read 30 cents of "inharmonicity" on a perfect
    // sawtooth. Two bins is the floor: a peak has to be found at all.
    const halfWidth = Math.max(binHz * 2, Math.min(expected * 0.04, f0 * 0.45))
    const lo = Math.max(1, Math.floor((expected - halfWidth) / binHz))
    const hi = Math.min(lastBin - 2, Math.ceil((expected + halfWidth) / binHz))
    if (hi < lo) continue
    let peak = lo
    for (let bin = lo; bin <= hi; bin += 1) if (power[bin] > power[peak]) peak = bin
    rows.push({
      n,
      hz: round(peakHz(power, peak, binHz), 2),
      levelDb: round(amplitudeDb(peakAmplitude(power, peak, windowSum)), 2),
      relDb: 0
    })
  }
  const base = rows.length > 0 ? rows[0].levelDb : 0
  for (const row of rows) row.relDb = round(row.levelDb - base, 2)
  return rows
}

/**
 * Refine f0 against the measured partials.
 *
 * Each partial is a measurement of the same number (`hz_n / n`), weighted by
 * how loud it is; the least-squares fit through the origin averages their
 * independent interpolation errors, which is what turns a ~0.3 % F0 into a
 * ~0.03 % one on a sawtooth. Partial rows more than 40 dB down are ignored —
 * those are noise-floor peaks and would only add variance.
 */
function refineF0 (rows, coarse) {
  if (!(coarse > 0) || rows.length === 0) return coarse
  const base = rows[0].levelDb
  let numerator = 0
  let denominator = 0
  for (const row of rows) {
    if (row.n > 12) continue
    if (row.levelDb < base - 40) continue
    const weight = Math.pow(10, row.levelDb / 20)
    numerator += weight * row.n * row.hz
    denominator += weight * row.n * row.n
  }
  if (!(denominator > 0)) return coarse
  const refined = numerator / denominator
  // A refinement further than a semitone from the coarse estimate is not a
  // refinement, it is a different pitch class: keep the original.
  return Math.abs(1200 * Math.log2(refined / coarse)) < 100 ? refined : coarse
}

/** RMS deviation of the measured partials from exact multiples of f0, in cents. */
function inharmonicityOf (rows, f0) {
  if (!(f0 > 0) || rows.length === 0) return 0
  const base = rows[0].levelDb
  let sumSquares = 0
  let count = 0
  for (const row of rows) {
    if (row.n < 2) continue
    if (row.levelDb < base - 40) continue
    const cents = 1200 * Math.log2(row.hz / (row.n * f0))
    sumSquares += cents * cents
    count += 1
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0
}

/* ------------------------------------------------------------- formants -- */

/**
 * Formant (spectral-envelope) estimation.
 *
 * Two estimators, because a voice and a resonant noise carry different
 * evidence:
 *
 * 1. **Voiced** — four or more partials within 30 dB of the fundamental. The
 *    partials *sample* the envelope, so the envelope is drawn through them and
 *    its local maxima are the formants, located by parabolic interpolation over
 *    three adjacent partials. This is the harmonic-synchronous form of a
 *    spectral envelope, and it is the only thing that works when partials sit
 *    220 Hz apart: no smoothing window can both erase that comb and keep two
 *    formants 500 Hz apart. The price is resolution — peak positions are good
 *    to about one partial, and a resonance narrower than the partial spacing
 *    cannot be seen.
 * 2. **Broadband** — no partial stack but energy spread over at least three
 *    octaves within 40 dB of the loudest band (a hit, a filtered noise): the
 *    power spectrum is averaged over a third of an octave and its prominent
 *    maxima are the resonances. Running this on a pure tone would report the
 *    tone itself as a "formant", which is why the caller has to vouch that
 *    there is an envelope to read.
 *
 * Neither is LPC on a vocal tract. `hz` is a few percent on a sustained vowel,
 * and `bandwidthHz` is a coarse figure in both modes (it cannot go below one
 * partial in voiced mode).
 *
 * @param {object} spectrum - from `buildSpectrum`.
 * @param {object[]} partials - all measured partials (not only the reported ones).
 * @param {number} richness - partials within 30 dB of the fundamental.
 * @param {boolean} broadband - energy spread over several octaves.
 * @returns {{ hz: number, bandwidthHz: number, levelDb: number }[]} max 4, ascending.
 */
function readFormants (spectrum, partials, richness, broadband) {
  if (richness < 4 && !broadband) return []
  const peaks = richness >= 4 ? harmonicEnvelopePeaks(partials) : broadbandEnvelopePeaks(spectrum)
  peaks.sort((a, b) => (b.prominence - a.prominence) || (a.hz - b.hz))
  const formants = peaks.slice(0, 4).sort((a, b) => a.hz - b.hz)
  return formants.map((peak) => ({
    hz: round(peak.hz, 1),
    bandwidthHz: round(peak.bandwidthHz, 1),
    levelDb: round(peak.levelDb, 2)
  }))
}

/**
 * Envelope through the partials: peaks of the line spectrum's level curve.
 *
 * Only peaks with a real neighbour on both sides count, which is what keeps the
 * lowest partial of a band-limited tone from being reported as a "formant" —
 * the envelope has no rising flank there, so it is not a resonance.
 */
function harmonicEnvelopePeaks (partials) {
  const rows = partials.filter((row) => Number.isFinite(row.levelDb))
  const peaks = []
  for (let index = 1; index < rows.length - 1; index += 1) {
    const left = rows[index - 1]
    const centre = rows[index]
    const right = rows[index + 1]
    // Adjacent partial numbers only: a gap means a partial was not measurable,
    // and interpolating across it would invent an envelope.
    if (left.n !== centre.n - 1 || right.n !== centre.n + 1) continue
    if (!(centre.levelDb > left.levelDb && centre.levelDb >= right.levelDb)) continue
    const prominence = centre.levelDb - Math.max(left.levelDb, right.levelDb)
    if (prominence < 1.5) continue
    const denominator = left.levelDb - 2 * centre.levelDb + right.levelDb
    const delta = Math.abs(denominator) > 1e-9 ? clamp(0.5 * (left.levelDb - right.levelDb) / denominator, -0.5, 0.5) : 0
    const hz = centre.hz + delta * (right.hz - centre.hz)
    const levelDb = centre.levelDb - 0.25 * (left.levelDb - right.levelDb) * delta
    peaks.push({
      hz,
      levelDb,
      prominence,
      bandwidthHz: envelopeWidth(rows, index, levelDb)
    })
  }
  return peaks
}

/** -3 dB width of the partial-level curve around one peak, linear between partials. */
function envelopeWidth (rows, index, peakLevel) {
  const target = peakLevel - 3
  const centre = rows[index]
  let left = centre.hz
  for (let k = index - 1; k >= 0; k -= 1) {
    if (rows[k + 1].n !== rows[k].n + 1) break
    const here = rows[k]
    const next = rows[k + 1]
    left = here.hz
    if (here.levelDb <= target) {
      const fraction = (next.levelDb - target) / Math.max(1e-9, next.levelDb - here.levelDb)
      left = next.hz - clamp(fraction, 0, 1) * (next.hz - here.hz)
      break
    }
  }
  let right = centre.hz
  for (let k = index + 1; k < rows.length; k += 1) {
    if (rows[k].n !== rows[k - 1].n + 1) break
    const here = rows[k]
    const previous = rows[k - 1]
    right = here.hz
    if (here.levelDb <= target) {
      const fraction = (previous.levelDb - target) / Math.max(1e-9, previous.levelDb - here.levelDb)
      right = previous.hz + clamp(fraction, 0, 1) * (here.hz - previous.hz)
      break
    }
  }
  return Math.max(centre.hz * 0.02, right - left)
}

/**
 * Resonances of a broadband sound, read off third-octave band levels.
 *
 * A third-octave filter bank is the standard way to see the *shape* of a
 * spectrum rather than its partials: it averages enough bins that a noise floor
 * looks flat, so a local maximum with a real dip on both sides is a resonance
 * and not a fluctuation. The cost is resolution — a resonance narrower than a
 * third of an octave cannot be located, and `bandwidthHz` cannot go below one
 * third-octave band.
 */
function broadbandEnvelopePeaks (spectrum) {
  const { power, binHz, windowSum } = spectrum
  const nyquist = (power.length - 1) * binHz
  const top = Math.min(4500, nyquist * 0.9)
  if (top < 400) return []
  const ratio = 2 ** (1 / 3)
  const bands = []
  let center = 100
  while (center < top) {
    const lo = center / Math.sqrt(ratio)
    const hi = Math.min(center * Math.sqrt(ratio), nyquist)
    const width = Math.max(binHz, hi - lo)
    const energy = bandEnergy(power, binHz, lo, hi)
    if (energy > 0) bands.push({ hz: center, width, db: 10 * Math.log10(energy / width), energy })
    center *= ratio
  }
  if (bands.length < 5) return []
  // A sinusoid carrying the band's power: same calibration as a partial level,
  // so the two formant branches report `levelDb` on one scale. The 1.5 is the
  // Hann main lobe's energy relative to its peak bin.
  const amplitudeOf = (energy) => (windowSum > 0 ? 2 * Math.sqrt(energy / 1.5) / windowSum : 0)
  const reach = 3
  const peaks = []
  for (let i = 1; i < bands.length - 1; i += 1) {
    const here = bands[i]
    if (!(here.db > bands[i - 1].db && here.db >= bands[i + 1].db)) continue
    let leftValley = here.db
    for (let k = i - 1, limit = Math.max(0, i - reach); k >= limit; k -= 1) leftValley = Math.min(leftValley, bands[k].db)
    let rightValley = here.db
    for (let k = i + 1, limit = Math.min(bands.length - 1, i + reach); k <= limit; k += 1) rightValley = Math.min(rightValley, bands[k].db)
    const prominence = here.db - Math.max(leftValley, rightValley)
    if (prominence < 2.5) continue
    const denominator = bands[i - 1].db - 2 * here.db + bands[i + 1].db
    const delta = Math.abs(denominator) > 1e-9 ? clamp(0.5 * (bands[i - 1].db - bands[i + 1].db) / denominator, -0.5, 0.5) : 0
    const hz = here.hz * ratio ** delta
    const levelDb = here.db - 0.25 * (bands[i - 1].db - bands[i + 1].db) * delta
    let width = here.width
    for (let k = i + 1; k < bands.length; k += 1) {
      if (bands[k].db <= levelDb - 3) break
      width += bands[k].width
    }
    for (let k = i - 1; k >= 0; k -= 1) {
      if (bands[k].db <= levelDb - 3) break
      width += bands[k].width
    }
    peaks.push({ hz, prominence, bandwidthHz: Math.max(here.width, width), levelDb: amplitudeDb(amplitudeOf(here.energy)) })
  }
  return peaks
}

/* -------------------------------------------------------------- envelope -- */

/**
 * RMS envelope plus the onset and decay numbers derived from it.
 *
 * Frames are two 5 ms hops wide, so a 2 ms attack is still visible and an
 * exponential tail is sampled densely enough to fit 60 dB of it.
 */
function envelopeMetrics (signal, sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate * ENVELOPE_HOP_SECONDS))
  const hopCount = Math.max(2, Math.ceil(signal.length / hop))
  const hopEnergy = new Float64Array(hopCount)
  for (let i = 0; i < signal.length; i += 1) hopEnergy[(i / hop) | 0] += signal[i] * signal[i]
  const count = hopCount - 1
  const level = new Float64Array(count)
  for (let i = 0; i < count; i += 1) {
    const meanSquare = (hopEnergy[i] + hopEnergy[i + 1]) / (2 * hop)
    level[i] = 10 * Math.log10(Math.max(meanSquare, 1e-24))
  }
  let peakIndex = 0
  for (let i = 1; i < count; i += 1) if (level[i] > level[peakIndex]) peakIndex = i
  const peakLevel = level[peakIndex]
  const frameTime = (index) => (index * hop + hop) / sampleRate

  // Onset: first sample above 2 % of the peak (-34 dB). Sample accuracy matters
  // here — a hit that starts 3 ms late is a hit that is out of sync.
  let peakAmplitude = 0
  for (let i = 0; i < signal.length; i += 1) {
    const magnitude = Math.abs(signal[i])
    if (magnitude > peakAmplitude) peakAmplitude = magnitude
  }
  const gate = peakAmplitude * 0.02
  let onsetSample = 0
  while (onsetSample < signal.length && Math.abs(signal[onsetSample]) < gate) onsetSample += 1
  const latencyMs = sampleRate > 0 ? onsetSample / sampleRate * 1000 : 0

  // Attack: 10 % → 90 % amplitude rise (-20 dB → -0.92 dB), measured forward
  // from the onset. Searching *backwards* from the loudest frame reports
  // nonsense on a held note: its loudest frame sits in the middle of the
  // sustain and the only rising edge is the very first one, so the "rise" would
  // span most of the file. A frame grid cannot resolve better than a hop, which
  // is why the classification uses a generous 15 ms percussive threshold.
  const onsetFrame = clamp(Math.floor(onsetSample / hop), 0, count - 1)
  const frameStart = (index) => index * hop / sampleRate
  const lowLevel = peakLevel - 20
  const highLevel = peakLevel - 0.92
  let t10 = null
  let t90 = null
  for (let i = onsetFrame; i < count; i += 1) {
    if (level[i] >= lowLevel) {
      t10 = frameStart(i)
      break
    }
  }
  // A sound that already starts above the -20 dB line has no lower crossing at
  // all; the sample-accurate onset is then the 10 % time.
  if (t10 === null) t10 = latencyMs / 1000
  for (let i = onsetFrame; i < count; i += 1) {
    if (level[i] >= highLevel) {
      t90 = frameStart(i)
      break
    }
  }
  const attackMs = t90 !== null && t90 >= t10 ? (t90 - t10) * 1000 : 0

  // Sustain: how much of the sound sits within 6 dB of its peak. A hit is a
  // sliver of the file, a held note is most of it. Counted over the whole sound
  // rather than from the loudest frame, so a note whose level drifts does not
  // read as unsustained.
  let sustainFrames = 0
  for (let i = 0; i < count; i += 1) if (level[i] > peakLevel - 6) sustainFrames += 1
  const sustainSeconds = sustainFrames * hop / sampleRate
  let sustainEnd = peakIndex
  while (sustainEnd + 1 < count && level[sustainEnd + 1] > peakLevel - 6) sustainEnd += 1

  // Decay: straight line through the envelope from the peak down 60 dB. A held
  // note stays flat and then releases, so for a sound that sustains the tail
  // worth measuring starts where the sustain ends; fitting from the peak would
  // average a flat line with a release and report an RT60 that matches neither.
  const fitFrom = sustainSeconds >= 0.25 ? sustainEnd : peakIndex
  const floorLevel = Math.max(-95, peakLevel - 60)
  const points = []
  for (let i = fitFrom; i < count; i += 1) {
    if (i > fitFrom && level[i] < floorLevel) break
    points.push({ t: frameTime(i), db: level[i] })
  }
  const decay = fitDecay(points)

  // Classification, in the order that resolves the overlaps: a long rise is a
  // swell whatever else it does; a plateau is sustained; a fast start with no
  // plateau is a hit (percussive — this is the one an agent should read as "a
  // door slam / a knock / a pluck"); anything left starts at a middling speed.
  let type = 'silent'
  if (peakLevel > -70) {
    if (attackMs >= 120) type = 'swell'
    else if (sustainSeconds >= 0.25) type = 'sustained'
    else if (attackMs <= 15) type = 'percussive'
    else type = 'plucked'
  }

  return {
    latencyMs: round(latencyMs, 1),
    attackMs: round(attackMs, 1),
    type,
    sustainSeconds: round(sustainSeconds, 2),
    decay
  }
}

/**
 * Fit the tail: dB-linear gives the RT60, and an amplitude-linear fit on the
 * same span decides whether the shape is really exponential ('exp'), linear in
 * amplitude ('linear') or neither ('irregular').
 */
function fitDecay (points) {
  const none = { rt60Seconds: 0, curve: 'irregular', fitR2: 0 }
  if (points.length < 5) return none
  const span = points[points.length - 1].t - points[0].t
  if (span < 0.02) return none
  let meanT = 0
  let meanDb = 0
  for (const point of points) {
    meanT += point.t
    meanDb += point.db
  }
  meanT /= points.length
  meanDb /= points.length
  let covariance = 0
  let variance = 0
  for (const point of points) {
    const dt = point.t - meanT
    covariance += dt * (point.db - meanDb)
    variance += dt * dt
  }
  if (!(variance > 0)) return none
  const slope = covariance / variance
  const intercept = meanDb - slope * meanT
  let totalSquares = 0
  let residual = 0
  for (const point of points) {
    const predicted = intercept + slope * point.t
    totalSquares += (point.db - meanDb) ** 2
    residual += (point.db - predicted) ** 2
  }
  const r2Db = totalSquares > 1e-12 ? 1 - residual / totalSquares : 1

  // Amplitude-domain fit: an exponential is curved in amplitude, a linear ramp
  // is straight in amplitude. Whichever explains more of the variance names the
  // curve, and when neither does the tail is irregular (a noise floor, two
  // decays stacked, a gate).
  let meanAmp = 0
  for (const point of points) meanAmp += Math.pow(10, point.db / 20)
  meanAmp /= points.length
  let covAmp = 0
  let residualAmp = 0
  let totalAmp = 0
  for (const point of points) {
    covAmp += (point.t - meanT) * (Math.pow(10, point.db / 20) - meanAmp)
    totalAmp += (Math.pow(10, point.db / 20) - meanAmp) ** 2
  }
  const slopeAmp = covAmp / variance
  const interceptAmp = meanAmp - slopeAmp * meanT
  for (const point of points) {
    residualAmp += (Math.pow(10, point.db / 20) - (interceptAmp + slopeAmp * point.t)) ** 2
  }
  const r2Amp = totalAmp > 1e-12 ? 1 - residualAmp / totalAmp : 1

  if (!(slope < -0.5)) return { rt60Seconds: 0, curve: 'irregular', fitR2: round(r2Db, 4) }
  const rt60 = clamp(-60 / slope, 0, 60)
  let curve = 'irregular'
  if (r2Db >= 0.98 && r2Db >= r2Amp - 0.02) curve = 'exp'
  else if (r2Amp > 0.98 && r2Amp > r2Db + 0.02) curve = 'linear'
  return { rt60Seconds: round(rt60, 3), curve, fitR2: round(r2Db, 4) }
}

/* ------------------------------------------------------------- summary ---- */

/** Energy in [lo, hi) Hz of one power spectrum. */
function bandEnergy (power, binHz, lo, hi) {
  const first = Math.max(1, Math.ceil(lo / binHz))
  const last = Math.min(power.length - 1, Math.floor(hi / binHz))
  let total = 0
  for (let bin = first; bin <= last; bin += 1) total += power[bin]
  return total
}

/** Named-band balance, `relDb` against the loudest band. */
function readBands (spectrum) {
  const { power, binHz } = spectrum
  const nyquist = (power.length - 1) * binHz
  const rows = []
  let loudest = 0
  for (const band of BAND_TABLE) {
    if (band.lo >= nyquist) continue
    const energy = bandEnergy(power, binHz, band.lo, Math.min(band.hi, nyquist))
    rows.push({ name: band.name, lo: band.lo, hi: band.hi, energy })
    if (energy > loudest) loudest = energy
  }
  return rows.map((row) => ({
    name: row.name,
    lo: row.lo,
    hi: row.hi,
    relDb: round(loudest > 0 && row.energy > 0 ? 10 * Math.log10(row.energy / loudest) : SILENT_DB, 1)
  }))
}

/**
 * Spectral slope.
 *
 * Unweighted regression of third-octave band *density* (dB/Hz, so a flat noise
 * floor reads 0 dB/oct instead of the +3 dB/oct a per-octave power sum would
 * give) against log2 of the band centre, from 100 Hz to 8 kHz. Negative is
 * dark, positive is bright; a sawtooth lands near -6 dB/oct, white noise near 0.
 *
 * Only bands within 40 dB of the loudest one enter the fit (60 dB if that
 * leaves fewer than four). The empty bands below the fundamental are the trap
 * here: they contain no energy at all, and if they are included at any floor
 * they pin the bottom of the regression and report a *rising* spectrum for a
 * dark sound. A gate says "this is where the sound is, fit there", and a
 * sparkled sine leaves one band, i.e. no slope at all.
 */
function spectralTilt (spectrum) {
  const { power, binHz } = spectrum
  const nyquist = (power.length - 1) * binHz
  const top = Math.min(8000, nyquist * 0.9)
  if (top <= 130) return 0
  const bands = []
  let low = 100
  while (low < top) {
    const high = Math.min(low * 2 ** (1 / 3), top)
    const width = Math.max(binHz, high - low)
    const energy = bandEnergy(power, binHz, low, high)
    bands.push({ x: Math.log2((low + high) / 2), y: energy > 0 ? 10 * Math.log10(energy / width) : -Infinity })
    low = high
  }
  if (bands.length < 3) return 0
  let maxDensity = -Infinity
  for (const band of bands) if (band.y > maxDensity) maxDensity = band.y
  if (!Number.isFinite(maxDensity)) return 0
  let kept = bands.filter((band) => band.y >= maxDensity - 40)
  if (kept.length < 4) kept = bands.filter((band) => band.y >= maxDensity - 60)
  if (kept.length < 4) return 0
  const span = kept[kept.length - 1].x - kept[0].x
  if (span < 1) return 0
  let meanX = 0
  let meanY = 0
  for (const band of kept) {
    meanX += band.x
    meanY += band.y
  }
  meanX /= kept.length
  meanY /= kept.length
  let covariance = 0
  let variance = 0
  for (const band of kept) {
    covariance += (band.x - meanX) * (band.y - meanY)
    variance += (band.x - meanX) ** 2
  }
  return variance > 1e-12 ? covariance / variance : 0
}

/** Geometric/arithmetic mean ratio over the audible range: 0 tonal, ~1 noise. */
function spectralFlatness (spectrum) {
  const { power, binHz } = spectrum
  const lastBin = power.length - 1
  const nyquist = lastBin * binHz
  let maxPower = 0
  for (let bin = 1; bin < lastBin; bin += 1) if (power[bin] > maxPower) maxPower = power[bin]
  if (!(maxPower > 0)) return 0
  const epsilon = maxPower * 1e-12
  const first = Math.max(1, Math.ceil(50 / binHz))
  const last = Math.min(lastBin - 1, Math.floor(Math.min(16000, nyquist * 0.95) / binHz))
  if (last <= first) return 0
  let logSum = 0
  let linearSum = 0
  let count = 0
  for (let bin = first; bin <= last; bin += 1) {
    const value = power[bin] + epsilon
    logSum += Math.log(value)
    linearSum += value
    count += 1
  }
  if (count === 0 || !(linearSum > 0)) return 0
  return clamp(Math.exp(logSum / count) / (linearSum / count), 0, 1)
}

/**
 * Share of the energy that is *not* in the partials.
 *
 * Flatness alone says "this is broadband"; this says "this is broadband after
 * the harmonics are accounted for", which is what makes a distorted tone read
 * noisy and a clean sawtooth read tonal. The two are averaged because each is
 * blind to a different case: a flute has a high residual but is not noisy, a
 * dense cluster of partials has a high flatness but is not noise.
 */
function noiseShare (spectrum, harmonics) {
  const { power, binHz } = spectrum
  const lastBin = power.length - 1
  const first = Math.max(1, Math.ceil(20 / binHz))
  let total = 0
  for (let bin = first; bin < lastBin; bin += 1) total += power[bin]
  if (!(total > 0)) return 0
  let tonal = 0
  for (const row of harmonics) {
    const at = Math.round(row.hz / binHz)
    for (let bin = Math.max(first, at - 2); bin <= Math.min(lastBin - 1, at + 2); bin += 1) tonal += power[bin]
  }
  return clamp(1 - tonal / total, 0, 1)
}

/** A report for silence: every field present, nothing NaN, nothing invented. */
function silentReport (durationSeconds, sampleRate, peakDbfs, rmsDbfs) {
  return {
    durationSeconds,
    sampleRate,
    peakDbfs,
    rmsDbfs,
    f0: { hz: 0, confidence: 0, method: 'none' },
    harmonics: [],
    inharmonicity: 0,
    spectralTiltDbPerOctave: 0,
    centroidHz: 0,
    flatness: 0,
    noisiness: 0,
    formants: [],
    decay: { rt60Seconds: 0, curve: 'irregular', fitR2: 0 },
    onset: { latencyMs: 0, attackMs: 0, type: 'silent' },
    bands: BAND_TABLE.map((band) => ({ name: band.name, lo: band.lo, hi: band.hi, relDb: SILENT_DB }))
  }
}

/* ------------------------------------------------------------------ api -- */

/**
 * Analyse one sound into a structured report.
 *
 * The report is a pure function of the samples: no clock, no randomness, and
 * every number rounded, so two calls on the same input compare equal.
 *
 * @param {Float32Array|Float64Array|number[]} samples - mono signal.
 * @param {number} sampleRate - Hz.
 * @param {object} [options]
 * @param {[number, number]} [options.f0Range] - pitch search range in Hz
 *   (default [40, 2000]). Narrow it to stop a bright sound reading an octave high.
 * @param {number} [options.maxHarmonics] - partials to list, 1..64, default 8.
 * @returns {{
 *   durationSeconds: number, sampleRate: number,
 *   peakDbfs: number, rmsDbfs: number,
 *   f0: { hz: number, confidence: number, method: string },
 *   harmonics: { n: number, hz: number, levelDb: number, relDb: number }[],
 *   inharmonicity: number, spectralTiltDbPerOctave: number,
 *   centroidHz: number, flatness: number, noisiness: number,
 *   formants: { hz: number, bandwidthHz: number, levelDb: number }[],
 *   decay: { rt60Seconds: number, curve: string, fitR2: number },
 *   onset: { latencyMs: number, attackMs: number, type: string },
 *   bands: { name: string, lo: number, hi: number, relDb: number }[]
 * }} the report.
 */
export function analyzeSound (samples, sampleRate, options = {}) {
  const signal = asSamples(samples)
  const rate = clamp(Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0 ? Number(sampleRate) : 44100, 1000, 384000)
  const durationSeconds = round(signal.length / rate, 3)
  const settings = options !== null && typeof options === 'object' ? options : {}
  const requestedRange = Array.isArray(settings.f0Range) ? settings.f0Range : []
  const requestedMin = Number.isFinite(requestedRange[0]) ? requestedRange[0] : 40
  const requestedMax = Number.isFinite(requestedRange[1]) ? requestedRange[1] : 2000
  const minHz = clamp(requestedMin, 20, 4000)
  const maxHz = clamp(Math.max(requestedMax, minHz + 1), minHz + 1, Math.min(rate * 0.45, 8000))
  const maxHarmonics = clamp(Math.round(Number.isFinite(settings.maxHarmonics) ? settings.maxHarmonics : 8), 1, 64)

  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < signal.length; i += 1) {
    const value = signal[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    sumSquares += value * value
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, signal.length))
  if (signal.length === 0 || !(peak > 0)) {
    return silentReport(durationSeconds, rate, amplitudeDb(peak), amplitudeDb(rms))
  }

  const spectrum = buildSpectrum(signal, rate)
  const loudestStart = spectrum.loudestStart

  // ---- pitch: autocorrelation as the primary estimator, HPS as the check ----
  const autocorrelationResult = autocorrelationPitch(signal, loudestStart, rate, minHz, maxHz)
  const hps = harmonicProductPitch(spectrum, minHz, maxHz)
  const autocorrelationConfidence = clamp((autocorrelationResult.clarity - 0.15) / 0.8, 0, 1)
  const voiced = autocorrelationConfidence >= 0.35 || (hps.confidence >= 0.75 && autocorrelationConfidence >= 0.1)
  let f0 = 0
  let method = 'none'
  if (voiced) {
    if (autocorrelationConfidence >= 0.35 && autocorrelationResult.hz >= minHz && autocorrelationResult.hz <= maxHz) {
      f0 = autocorrelationResult.hz
      method = 'autocorrelation'
    } else if (hps.hz > 0) {
      f0 = hps.hz
      method = 'hps'
    }
  }
  // Two passes: the refined f0 moves the search windows, so the partials that
  // are read for the report are read around the *refined* value, not the coarse.
  // All measurable partials are read, not only the ones the report lists: the
  // formant envelope and the richness test below need the whole stack.
  let partials = f0 > 0 ? readHarmonics(spectrum, f0, 96) : []
  if (f0 > 0) {
    f0 = refineF0(partials, f0)
    partials = readHarmonics(spectrum, f0, 96)
  }
  const harmonics = partials.slice(0, maxHarmonics)
  // A voice with no partials is not a voice: keep confidence honest.
  const confidence = f0 > 0
    ? round(clamp(0.85 * autocorrelationConfidence + 0.15 * hps.confidence, 0, 1), 3)
    : 0

  // ---- spectrum ----
  const { power, binHz } = spectrum
  const lastBin = power.length - 1
  const firstCentroidBin = Math.max(1, Math.ceil(20 / binHz))
  let weighted = 0
  let total = 0
  for (let bin = firstCentroidBin; bin < lastBin; bin += 1) {
    const value = power[bin]
    weighted += value * bin * binHz
    total += value
  }
  const centroidHz = total > 0 ? weighted / total : 0
  const flatness = spectralFlatness(spectrum)
  const residual = noiseShare(spectrum, partials)
  const noisiness = clamp(0.5 * clamp((flatness - 0.05) / 0.45, 0, 1) + 0.5 * residual, 0, 1)
  // A formant is a property of a rich source; counting the partials that carry
  // real level is how the formant analysis below knows which estimator to use.
  const fundamentalLevel = partials.length > 0 ? partials[0].levelDb : SILENT_DB
  let richness = 0
  for (const row of partials) if (row.levelDb >= fundamentalLevel - 30) richness += 1

  const envelope = envelopeMetrics(signal, rate)
  const bands = readBands(spectrum)
  // Broadband means "there is an envelope to read": energy spread over at least
  // three octaves within 40 dB of the loudest band. A single tone is one band,
  // and its own peak must not come back as a formant.
  let broadbandBands = 0
  for (const band of bands) if (band.relDb > -40) broadbandBands += 1

  return {
    durationSeconds,
    sampleRate: rate,
    peakDbfs: round(amplitudeDb(peak), 2),
    rmsDbfs: round(amplitudeDb(rms), 2),
    f0: { hz: round(f0, 2), confidence, method },
    harmonics,
    inharmonicity: round(inharmonicityOf(partials, f0), 2),
    spectralTiltDbPerOctave: round(spectralTilt(spectrum), 1),
    centroidHz: round(centroidHz, 0),
    flatness: round(flatness, 4),
    noisiness: round(noisiness, 3),
    formants: readFormants(spectrum, partials, richness, broadbandBands >= 3),
    decay: envelope.decay,
    onset: { latencyMs: envelope.latencyMs, attackMs: envelope.attackMs, type: envelope.type },
    bands
  }
}

/* --------------------------------------------------------------- compare -- */

/**
 * Default tolerances for `compareSounds`.
 *
 * `relative` values are fractions of the larger of the two numbers (so a 2 %
 * pitch tolerance stays sensible at 55 Hz and at 1760 Hz); `absolute` values
 * are in the metric's own unit (dB for levels, cents for inharmonicity, ms for
 * the attack, 0..1 for flatness and noisiness).
 */
const DEFAULT_TOLERANCES = Object.freeze({
  'f0.hz': { relative: 0.02 },
  inharmonicity: { absolute: 8 },
  centroidHz: { relative: 0.15 },
  spectralTiltDbPerOctave: { absolute: 1.5 },
  flatness: { absolute: 0.08 },
  noisiness: { absolute: 0.15 },
  'decay.rt60Seconds': { relative: 0.3 },
  'onset.attackMs': { absolute: 12 },
  'formants.count': { absolute: 1 },
  'formants.hz': { relative: 0.12 },
  bands: { absolute: 3 }
})

/** Normalise a caller tolerance (number or {relative}/{absolute}) to a spec. */
function normalizeTolerance (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'absolute', value }
  if (value !== null && typeof value === 'object') {
    if (Number.isFinite(value.relative)) return { kind: 'relative', value: value.relative }
    if (Number.isFinite(value.absolute)) return { kind: 'absolute', value: value.absolute }
  }
  return null
}

/** The family a metric id belongs to, so one key can cover a whole group. */
function familyOf (metric) {
  if (metric.startsWith('formants.') && metric.endsWith('.hz')) return 'formants.hz'
  if (metric.startsWith('bands.')) return 'bands'
  return metric
}

/** Resolve the tolerance for a metric id: exact key, family key, then default. */
function toleranceFor (metric, overrides) {
  const source = overrides !== null && typeof overrides === 'object' ? overrides : {}
  const family = familyOf(metric)
  for (const key of [metric, family]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return normalizeTolerance(source[key]) ?? { kind: 'absolute', value: 0 }
    }
  }
  return normalizeTolerance(DEFAULT_TOLERANCES[family]) ?? { kind: 'absolute', value: 0 }
}

/** One comparison row; `tolerance` is already in the metric's own unit. */
function makeRow (metric, a, b, tolerance, unitLabel) {
  const finiteA = Number.isFinite(a)
  const finiteB = Number.isFinite(b)
  if (!finiteA && !finiteB) {
    return { metric, a: null, b: null, delta: null, tolerance: null, status: 'skip', note: 'not measurable in either sound' }
  }
  const left = finiteA ? a : null
  const right = finiteB ? b : null
  if (left === null || right === null) {
    return { metric, a: left, b: right, delta: null, tolerance: null, status: 'fail', note: 'measurable in only one sound' }
  }
  const allowed = tolerance.kind === 'relative'
    ? Math.abs(tolerance.value) * Math.max(Math.abs(left), Math.abs(right))
    : Math.abs(tolerance.value)
  const delta = right - left
  const spec = tolerance.kind === 'relative'
    ? `±${round(tolerance.value * 100, 2)}%`
    : `±${round(tolerance.value, 3)}${unitLabel ?? ''}`
  return {
    metric,
    a: round(left, 2),
    b: round(right, 2),
    delta: round(delta, 2),
    tolerance: round(allowed, 2),
    spec,
    status: Math.abs(delta) <= allowed ? 'pass' : 'fail'
  }
}

/**
 * Compare two reports as *character*, not as level.
 *
 * Levels (peak/rms) are deliberately not rows: a change is allowed to be
 * quieter. What is compared is the identity of the sound — pitch, partial
 * balance, brightness, noisiness, decay, attack — so "did my tweak keep the
 * same character?" has a yes/no answer with the metric that broke it named.
 *
 * @param {object} a - report from `analyzeSound`.
 * @param {object} b - the other report.
 * @param {object} [tolerances] - `{ metric: number | { relative } | { absolute } }`.
 * @returns {{ pass: boolean, rows: object[], failed: string[], skipped: string[] }}
 */
export function compareSounds (a, b, tolerances = {}) {
  const left = a !== null && typeof a === 'object' ? a : {}
  const right = b !== null && typeof b === 'object' ? b : {}
  const rows = []

  // Pitch needs care: an unvoiced sound has hz 0, and "0 vs 440" is a character
  // change, not a 100 % pitch error.
  const pitchA = left.f0 ?? {}
  const pitchB = right.f0 ?? {}
  const voicedA = (pitchA.hz ?? 0) > 0 && (pitchA.confidence ?? 0) >= 0.5
  const voicedB = (pitchB.hz ?? 0) > 0 && (pitchB.confidence ?? 0) >= 0.5
  if (!voicedA && !voicedB) {
    rows.push({
      metric: 'f0.hz',
      a: null,
      b: null,
      delta: null,
      tolerance: null,
      spec: '±2%',
      status: 'skip',
      note: 'neither sound has a confident pitch'
    })
  } else if (voicedA !== voicedB) {
    rows.push({
      metric: 'f0.hz',
      a: voicedA ? round(pitchA.hz, 2) : null,
      b: voicedB ? round(pitchB.hz, 2) : null,
      delta: null,
      tolerance: null,
      spec: '±2%',
      status: 'fail',
      note: 'one sound is pitched, the other is not'
    })
  } else {
    rows.push(makeRow('f0.hz', pitchA.hz, pitchB.hz, toleranceFor('f0.hz', tolerances), '%'))
  }

  rows.push(makeRow('inharmonicity', left.inharmonicity, right.inharmonicity, toleranceFor('inharmonicity', tolerances), ' cents'))
  rows.push(makeRow('centroidHz', left.centroidHz, right.centroidHz, toleranceFor('centroidHz', tolerances), ' Hz'))
  rows.push(makeRow('spectralTiltDbPerOctave', left.spectralTiltDbPerOctave, right.spectralTiltDbPerOctave, toleranceFor('spectralTiltDbPerOctave', tolerances), ' dB/oct'))
  rows.push(makeRow('flatness', left.flatness, right.flatness, toleranceFor('flatness', tolerances), ''))
  rows.push(makeRow('noisiness', left.noisiness, right.noisiness, toleranceFor('noisiness', tolerances), ''))
  rows.push(makeRow('decay.rt60Seconds', (left.decay ?? {}).rt60Seconds, (right.decay ?? {}).rt60Seconds, toleranceFor('decay.rt60Seconds', tolerances), ' s'))
  rows.push(makeRow('onset.attackMs', (left.onset ?? {}).attackMs, (right.onset ?? {}).attackMs, toleranceFor('onset.attackMs', tolerances), ' ms'))

  const formantsA = Array.isArray(left.formants) ? left.formants : []
  const formantsB = Array.isArray(right.formants) ? right.formants : []
  rows.push(makeRow('formants.count', formantsA.length, formantsB.length, toleranceFor('formants.count', tolerances), ''))
  const formantCount = Math.min(formantsA.length, formantsB.length)
  for (let index = 0; index < formantCount; index += 1) {
    rows.push(makeRow(
      `formants.${index}.hz`,
      formantsA[index]?.hz,
      formantsB[index]?.hz,
      toleranceFor(`formants.${index}.hz`, tolerances),
      ' Hz'
    ))
  }

  const bandsA = Array.isArray(left.bands) ? left.bands : []
  const bandsB = Array.isArray(right.bands) ? right.bands : []
  const bandNames = bandsA.map((band) => band.name)
  for (const name of bandNames) {
    const match = bandsB.find((band) => band.name === name)
    rows.push(makeRow(`bands.${name}`, bandsA.find((band) => band.name === name)?.relDb, match?.relDb, toleranceFor(`bands.${name}`, tolerances), ' dB'))
  }

  const failed = rows.filter((row) => row.status === 'fail').map((row) => row.metric)
  const skipped = rows.filter((row) => row.status === 'skip').map((row) => row.metric)
  return { pass: failed.length === 0, rows, failed, skipped }
}

/* ------------------------------------------------------------------ text -- */

/** Fixed-width helper for the text block; never uses locale formatting. */
function fmt (value, digits = 1) {
  if (!Number.isFinite(value)) return '-'
  return Number(value).toFixed(digits)
}

/**
 * The report as one compact line per aspect, for the model to read instead of
 * listening. Bounded by construction: at most `maxHarmonics` partials, four
 * formants and the seven fixed bands.
 * @param {object} report - from `analyzeSound`.
 * @returns {string} newline-separated lines.
 */
export function describeReport (report) {
  const source = report !== null && typeof report === 'object' ? report : {}
  const lines = []
  lines.push(
    `duration ${fmt(source.durationSeconds, 2)} s · peak ${fmt(source.peakDbfs, 1)} dBFS · ` +
    `rms ${fmt(source.rmsDbfs, 1)} dBFS · centroid ${fmt(source.centroidHz, 0)} Hz`
  )

  const f0 = source.f0 ?? {}
  if (f0.hz > 0) {
    lines.push(`f0 ${fmt(f0.hz, 1)} Hz (confidence ${fmt(f0.confidence, 2)}, ${f0.method}) · inharmonicity ${fmt(source.inharmonicity, 1)} cents`)
  } else {
    lines.push(`f0 none (confidence ${fmt(f0.confidence, 2)}): no stable period - read it as noise or an inharmonic hit`)
  }

  const harmonics = Array.isArray(source.harmonics) ? source.harmonics : []
  if (harmonics.length > 0) {
    // Partials 60 dB down are the noise floor, and a pure tone would otherwise
    // spend the line listing its own silence: say how many were left out.
    const strong = harmonics.filter((row) => row.relDb > -60)
    const hidden = harmonics.length - strong.length
    lines.push(
      `harmonics ${strong.map((row) => `${row.n}:${fmt(row.hz, 0)}Hz ${fmt(row.relDb, 1)}dB`).join(' ')}` +
      `${hidden > 0 ? ` (+${hidden} below -60 dB)` : ''}`
    )
  } else {
    lines.push('harmonics none listed (not pitched)')
  }

  lines.push(
    `tilt ${fmt(source.spectralTiltDbPerOctave, 1)} dB/oct · flatness ${fmt(source.flatness, 3)} · ` +
    `noisiness ${fmt(source.noisiness, 2)}${source.noisiness >= 0.6 ? ' (mostly noise)' : source.noisiness <= 0.2 ? ' (tonal)' : ' (mixed)'}`
  )

  const formants = Array.isArray(source.formants) ? source.formants : []
  if (formants.length > 0) {
    lines.push(`formants ${formants.map((row) => `${fmt(row.hz, 0)}Hz/${fmt(row.bandwidthHz, 0)}Hz ${fmt(row.levelDb, 1)}dB`).join(' ')} (envelope peaks, approximate)`)
  } else {
    lines.push('formants none (no envelope peak above the noise)')
  }

  const decay = source.decay ?? {}
  if (decay.rt60Seconds > 0) {
    lines.push(`decay rt60 ${fmt(decay.rt60Seconds, 2)} s (${decay.curve}, fit R2 ${fmt(decay.fitR2, 3)})`)
  } else {
    lines.push(`decay no measurable tail (${decay.curve})`)
  }

  const onset = source.onset ?? {}
  lines.push(`onset latency ${fmt(onset.latencyMs, 1)} ms · attack ${fmt(onset.attackMs, 1)} ms · ${onset.type}`)

  const bands = Array.isArray(source.bands) ? source.bands : []
  if (bands.length > 0) {
    lines.push(`bands ${bands.map((band) => `${band.name} ${fmt(band.relDb, 1)}`).join(' · ')}`)
  }
  return lines.join('\n')
}
