/**
 * Writes one listenable file per design recipe into `test/out/design-*.wav`.
 *
 * The metrics in `design.mjs` say the designs are sane; only ears say they are
 * impressive. This script is the hand-off: render the whole vocabulary once,
 * print what each file is, and leave the files where a human can play them.
 *
 * Usage:
 *   node test/design-listen.mjs               # seed 1, every recipe
 *   node test/design-listen.mjs --variant 2   # sibling take of every recipe
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, toWavBytes } from '../lib/audio.js'
import { RECIPES, designSound } from '../lib/design.js'

const args = process.argv.slice(2)
const variantIndex = args.indexOf('--variant')
const variant = variantIndex >= 0 && Number.isFinite(Number(args[variantIndex + 1])) ? Number(args[variantIndex + 1]) : 0
const seed = 1

const outDir = fileURLToPath(new URL('./out/', import.meta.url))
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const ids = Object.keys(RECIPES)
console.log(`writing ${ids.length} design files to ${outDir} (seed ${seed}, variant ${variant})\n`)
console.log('file'.padEnd(30), 'dur'.padStart(5), 'peak'.padStart(6), 'rms'.padStart(7), 'crest'.padStart(6), 'centroid'.padStart(8), '  what it is')

let totalBytes = 0
let totalSeconds = 0
for (const id of ids) {
  const design = designSound({ recipe: id, seed, variant })
  const bytes = toWavBytes(design.samples, design.sampleRate)
  const name = `design-${id}.wav`
  await writeFile(join(outDir, name), bytes)
  const metrics = measure(design.samples, design.sampleRate)
  totalBytes += bytes.length
  totalSeconds += metrics.durationSeconds
  console.log(
    name.padEnd(30),
    metrics.durationSeconds.toFixed(2).padStart(5),
    metrics.peakDbfs.toFixed(1).padStart(6),
    metrics.rmsDbfs.toFixed(1).padStart(7),
    metrics.crestDb.toFixed(1).padStart(6),
    String(metrics.centroidHz).padStart(8),
    ` ${design.loop ? '[loop] ' : ''}${RECIPES[id].description}`
  )
}

const megabytes = totalBytes / (1024 * 1024)
console.log(`\n${ids.length} files, ${totalSeconds.toFixed(1)}s of audio, ${megabytes.toFixed(1)} MB, written to:`)
console.log(`  ${outDir}`)
console.log('Play them in order: the vocabulary is sorted from doors/blasts to UI ticks, so the level and weight contrast is audible across the set.')
