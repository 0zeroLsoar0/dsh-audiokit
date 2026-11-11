// render-demo.mjs —— 重新生成 demo 的 7 个音频（参数与手工调用时一致，可复现）。
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalize, measure, renderPreset, toWavBytes, writeFileAtomic } from '../dsh-audio/lib/audio.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'assets', 'audio')
await mkdir(outDir, { recursive: true })

const specs = [
  { name: 'slam1', preset: 'impact', duration: 0.6, seed: 11, sampleRate: 22050, params: { weight: 0.95, hardness: 0.8, metallic: 0.15, space: 0.25 } },
  { name: 'slam2', preset: 'impact', duration: 0.5, seed: 12, sampleRate: 22050, params: { weight: 0.62, hardness: 0.7, metallic: 0.1, space: 0.2 } },
  { name: 'slam3', preset: 'impact', duration: 0.4, seed: 13, sampleRate: 22050, params: { weight: 0.38, hardness: 0.6, metallic: 0.08, space: 0.18 } },
  { name: 'slam4', preset: 'impact', duration: 0.35, seed: 14, sampleRate: 22050, params: { weight: 0.2, hardness: 0.5, metallic: 0.05, space: 0.15 } },
  { name: 'fall', preset: 'whoosh', duration: 0.55, seed: 21, sampleRate: 22050, params: { speed: 0.85, tone: 0.45, rise: 0.35, space: 0.3 } },
  { name: 'wind', preset: 'texture', duration: 2, seed: 31, sampleRate: 22050, loop: true, params: { kind: 'wind', density: 0.4, tone: 0.35, movement: 0.5 } },
  { name: 'chime', preset: 'chime', duration: 0.7, seed: 41, sampleRate: 22050, params: { decay: 0.2, metallic: 0.4, pitch: 0.62, space: 0.3 } }
]

for (const spec of specs) {
  const rendered = renderPreset(spec)
  finalize(rendered.samples, rendered.sampleRate)
  const metrics = measure(rendered.samples, rendered.sampleRate)
  const target = join(outDir, `${spec.name}.wav`)
  await writeFileAtomic(target, toWavBytes(rendered.samples, rendered.sampleRate))
  console.log(
    `${spec.name.padEnd(6)} ${metrics.durationSeconds.toFixed(2)}s  ` +
    `peak ${metrics.peakDbfs}  dc ${metrics.dcOffset}  seam ${metrics.loopSeam}  ` +
    `centroid ${metrics.centroidHz}Hz  onsets ${metrics.onsets}`
  )
}
