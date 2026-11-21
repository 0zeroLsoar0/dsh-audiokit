/**
 * The plugin promises byte-level determinism: the same request must produce the
 * same file, because agents cache renders by path and `audio_regress` compares
 * hashes across processes.
 *
 * This test exists because 16-bit encoding once dithered with Math.random(), so
 * identical samples produced different bytes on every run while every other
 * layer looked deterministic. Anything that reintroduces randomness shows up
 * here as a hash mismatch.
 */

import { createHash } from 'node:crypto'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { measure } from '../lib/audio.js'
import { renderPreset } from '../lib/audio.js'

const failures = []
function check (condition, message, detail) {
  if (!condition) failures.push(detail === undefined ? message : `${message} (${detail})`)
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

console.log('-- same samples, three encodes --')
const rendered = renderPreset({ preset: 'chime', duration: 0.5, seed: 3 })
const hashes = []
for (let i = 0; i < 3; i += 1) hashes.push(sha256(encodeWav([rendered.samples], rendered.sampleRate)))
const unique = new Set(hashes)
console.log(`  hashes: ${[...unique].map((hash) => hash.slice(0, 16)).join(' ')}`)
check(unique.size === 1, 'encodeWav is not deterministic across calls', `${unique.size} distinct hashes`)

console.log('-- encoded file still decodes to the same signal --')
const bytes = encodeWav([rendered.samples], rendered.sampleRate)
const decoded = decodeWav(bytes)
let maxError = 0
for (let i = 0; i < rendered.samples.length; i += 1) {
  maxError = Math.max(maxError, Math.abs(decoded.channels[0][i] - rendered.samples[i]))
}
const errorDb = 20 * Math.log10(Math.max(maxError, 1e-12))
console.log(`  frames=${decoded.channels[0].length} maxError=${maxError.toExponential(3)} (${errorDb.toFixed(1)} dB)`)
check(decoded.channels[0].length === rendered.samples.length, 'decoded length changed')
check(maxError < 2 / 32768, '16-bit quantisation error exceeds two LSB', errorDb.toFixed(1))

console.log('-- dither can be turned off, and stays deterministic without it --')
const bareA = sha256(encodeWav([rendered.samples], rendered.sampleRate, { dither: false }))
const bareB = sha256(encodeWav([rendered.samples], rendered.sampleRate, { dither: false }))
console.log(`  dither off: ${bareA.slice(0, 16)} ${bareA === bareB ? 'stable' : 'UNSTABLE'}`)
check(bareA === bareB, 'dither:false is not deterministic')
check(bareA !== hashes[0], 'dither:false produced the dithered bytes')

console.log('-- decoded metrics match the source metrics --')
const source = measure(rendered.samples, rendered.sampleRate)
const roundTrip = measure(decoded.channels[0], rendered.sampleRate)
console.log(`  peak ${source.peakDbfs} -> ${roundTrip.peakDbfs} dB   rms ${source.rmsDbfs} -> ${roundTrip.rmsDbfs} dB`)
check(Math.abs(source.peakDbfs - roundTrip.peakDbfs) < 0.1, 'peak drifted through 16-bit encode')
check(Math.abs(source.rmsDbfs - roundTrip.rmsDbfs) < 0.1, 'rms drifted through 16-bit encode')

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nOK: wav encoding is deterministic')
