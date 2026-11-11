import { mkdir, rm } from 'node:fs/promises'
import { PRESETS, presetCatalog } from '../lib/dsp.js'
import {
  ENGINE_VERSION,
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  mixTracks,
  renderPattern,
  renderPreset,
  toWavBytes,
  writeFileAtomic
} from '../lib/audio.js'
import { decodeWav } from '../lib/wav.js'

const out = new URL('./out/', import.meta.url)
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

console.log(`engine v${ENGINE_VERSION}`)
console.log(`presets: ${presetCatalog().map((p) => p.name).join(', ')}\n`)

for (const name of Object.keys(PRESETS)) {
  const result = renderPreset({ preset: name, seed: 7, sampleRate: 44100 })
  finalize(result.samples, result.sampleRate).length
  const m = measure(result.samples, result.sampleRate)
  let finite = true
  let peak = 0
  for (const sample of result.samples) {
    if (!Number.isFinite(sample)) finite = false
    peak = Math.max(peak, Math.abs(sample))
  }
  console.log(
    `${name.padEnd(8)} ${String(m.durationSeconds).padStart(5)}s  peak ${String(m.peakDbfs).padStart(7)} dB  ` +
    `crest ${String(m.crestDb).padStart(5)}  centroid ${String(m.centroidHz).padStart(5)} Hz  onsets ${String(m.onsets).padStart(2)}`
  )
  check(`${name} finite`, finite)
  check(`${name} peak<=1`, peak <= 1.0001, `peak=${peak}`)
  check(`${name} not silent`, m.rmsDbfs > -60, `rms=${m.rmsDbfs}`)
  check(`${name} duration`, Math.abs(m.durationSeconds - PRESETS[name].defaultDuration) < 0.05)
}

console.log('\n-- determinism --')
const a = renderPreset({ preset: 'impact', seed: 3, params: { weight: 0.8 } })
const b = renderPreset({ preset: 'impact', seed: 3, params: { weight: 0.8 } })
const c = renderPreset({ preset: 'impact', seed: 4, params: { weight: 0.8 } })
check('same spec identical', a.samples.every((v, i) => v === b.samples[i]))
check('different seed differs', a.samples.some((v, i) => v !== c.samples[i]))

console.log('-- loop seam --')
const loop = renderPreset({ preset: 'texture', seed: 5, duration: 2, loop: true, params: { kind: 'rain' } })
const loopMetrics = measure(loop.samples, loop.sampleRate)
console.log(`texture loop seam=${loopMetrics.loopSeam} step=${loopMetrics.loopStep} duration=${loopMetrics.durationSeconds}s rms=${loopMetrics.rmsDbfs}dB`)
check('bed loop keeps level', loopMetrics.loopSeam < 6, `seam=${loopMetrics.loopSeam} dB`)
check('loop length exact', Math.abs(loopMetrics.durationSeconds - 2) < 0.01)

// A one-shot forced into a loop must be *detected* as a bad loop; otherwise
// the metric is telling the agent nothing.
const badLoop = measure(renderPreset({ preset: 'impact', seed: 5, duration: 1, loop: true }).samples, 44100)
console.log(`impact loop seam=${badLoop.loopSeam} (expected large)`)
check('decaying hit flagged as bad loop', badLoop.loopSeam > 20, `seam=${badLoop.loopSeam} dB`)

console.log('-- pattern --')
const train = renderPattern({ preset: 'tick', kind: 'train', from: 0, to: 2, every: 0.1, curve: 'accelerando', seed: 2 })
console.log(`train events=${train.events} duration=${train.durationSeconds.toFixed(2)}s onsets=${measure(train.samples, train.sampleRate).onsets}`)
check('train events', train.events === 20, `events=${train.events}`)
check('train onsets', measure(train.samples, train.sampleRate).onsets >= 15)

const scatter = renderPattern({ preset: 'scrap', kind: 'scatter', from: 0, to: 1.5, count: 6, jitter: 0.5, seed: 9 })
check('scatter count', scatter.events === 6)

console.log('-- mix --')
const impact = renderPreset({ preset: 'impact', seed: 11, duration: 1 })
const riser = renderPreset({ preset: 'riser', seed: 12, duration: 1.4 })
finalize(impact.samples, impact.sampleRate, -3)
finalize(riser.samples, riser.sampleRate, -9)
const mixed = mixTracks([impact, riser], { sampleRate: 44100, gains: [0, -6], limiter: true, peakDbfs: -1 })
const mixedMetrics = measure(mixed.samples, mixed.sampleRate)
console.log(`mix peak=${mixedMetrics.peakDbfs}dB duration=${mixedMetrics.durationSeconds}s clipping=${mixedMetrics.clipping}`)
check('mix no clipping', mixedMetrics.clipping === 0)
check('mix duration', Math.abs(mixedMetrics.durationSeconds - 1.4) < 0.01)

console.log('-- mix offsets (cue assembly) --')
const tickA = renderPreset({ preset: 'tick', seed: 1, sampleRate: 22050 }); finalize(tickA.samples, tickA.sampleRate)
const tickB = renderPreset({ preset: 'tick', seed: 2, sampleRate: 22050 }); finalize(tickB.samples, tickB.sampleRate)
const placed = mixTracks([tickA, tickB], { sampleRate: 22050, offsets: [0, 0.5] })
console.log(`placed duration=${placed.durationSeconds.toFixed(2)}s`)
check('offsets extend the timeline', Math.abs(placed.durationSeconds - 0.55) < 0.02, `got ${placed.durationSeconds}`)
check('second cue lands late', Math.abs(placed.samples[0]) > 0 && Math.abs(placed.samples[Math.round(0.5 * 22050)]) > 0.1)

console.log('-- wav roundtrip --')
const bytes = toWavBytes(mixed.samples, mixed.sampleRate)
const spec = { preset: 'impact', params: { weight: 0.5 }, seed: 1, duration: 1 }
const hash = hashSpec(spec)
const target = defaultOutputPath(process.cwd(), 'impact', hash)
await writeFileAtomic(target, bytes)
const decoded = decodeWav(bytes)
check('wav channels', decoded.channels.length === 1)
check('wav rate', decoded.sampleRate === 44100)
check('wav frames', Math.abs(decoded.durationSeconds - mixed.durationSeconds) < 0.01)
console.log(`wrote ${target} (${bytes.length} bytes)`)

const big = new Float32Array(44100).fill(1.5)
const clippedBytes = toWavBytes(big, 44100)
check('clip guard', decodeWav(clippedBytes).channels[0].every((v) => Math.abs(v) <= 1))

console.log(failures === 0 ? '\nOK: all checks passed' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

