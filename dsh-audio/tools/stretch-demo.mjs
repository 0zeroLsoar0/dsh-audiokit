/**
 * Audition the time-stretcher: render one cue at 0.75x and 1.5x into out/.
 *
 *   node tools/stretch-demo.mjs
 *
 * The cue is a chime — the kind of one-shot an animation puts on a UI event — and
 * the two factors are the ones that come up constantly: 0.75x to land a 1.2 s
 * swell on a 0.9 s cut, 1.5x to stretch a hit across a slower beat. Both files
 * keep the cue's pitch; only the duration changes.
 *
 * The demo writes through the same wav codec the tools use, so the files are
 * byte-reproducible: running it twice rewrites identical bytes.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalize, renderPreset, toWavBytes } from '../lib/audio.js'
import { timeStretch } from '../lib/stretch.js'
import { decodeWav } from '../lib/wav.js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')
await mkdir(outDir, { recursive: true })

const cue = renderPreset({
  preset: 'chime',
  params: { pitch: 0.42, decay: 0.72, metallic: 0.35 },
  duration: 1.2,
  seed: 21
})
finalize(cue.samples, cue.sampleRate, -1)

const inputSeconds = cue.samples.length / cue.sampleRate
console.log(`input  ${cue.samples.length} samples  ${inputSeconds.toFixed(3)} s  ${cue.sampleRate} Hz chime`)

for (const factor of [0.75, 1.5]) {
  const stretched = timeStretch(cue.samples, cue.sampleRate, factor)
  const bytes = toWavBytes(stretched, cue.sampleRate)
  const target = join(outDir, `stretch-${String(factor).replace('.', '_')}x.wav`)
  await writeFile(target, bytes)
  const decoded = decodeWav(bytes)
  console.log(
    `${factor}x  ${decoded.durationSeconds.toFixed(3)} s  ${String(decoded.channels.length)} ch  ` +
    `${String(Math.round(bytes.length / 1024))} KB  ${target}`
  )
}
