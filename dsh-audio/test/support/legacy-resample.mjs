/**
 * The *previous* `resampleTo` from `lib/stretch.js`, kept as a measurement
 * reference for the alias test — not a test file.
 *
 * `tools/test-all.mjs` only scans `test/*.mjs`, so nothing here is run as a
 * suite; `test/stretch.mjs` imports it to prove that the fixed window really
 * suppresses the mirror the old kernel left behind. Keeping the old kernel
 * verbatim is the only way ">= 20 dB better than before" stays a measurement
 * instead of an assertion against a number someone typed.
 *
 * Do not use this for real resampling.
 */

const SINC_RESOLUTION = 256
const RESAMPLE_HALF = 8

function sincTable (half) {
  const length = half * SINC_RESOLUTION + 1
  const table = new Float64Array(length)
  for (let i = 0; i < length; i += 1) {
    const x = i / SINC_RESOLUTION
    const window = x >= half
      ? 0
      : 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half)
    table[i] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window
  }
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
 * The old implementation, quoted from the commit before the fix: it built the
 * window at `half` (the tap count) instead of at the fixed `RESAMPLE_HALF`
 * support, so the taper was still at ~0.34 where the taps stopped.
 *
 * @param {Float32Array} input
 * @param {number} outFrames
 * @returns {Float32Array}
 */
export function legacyResampleTo (input, outFrames) {
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
  const half = Math.max(RESAMPLE_HALF, Math.ceil(RESAMPLE_HALF / cutoff))
  const table = sincTable(half)
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
      if (distance <= -half || distance >= half) continue
      const weight = kernelValue(table, distance < 0 ? -distance : distance)
      sum += weight * input[index]
      norm += weight
    }
    out[i] = norm === 0 ? 0 : sum / norm
  }
  return out
}
