/**
 * Listen test: one 16-bar cue per genre, written to `dsh-audio-lab/out/` so the
 * lead can audition the engine instead of trusting metrics.
 *
 * Every file is a complete cue (intro/build/drop/outro), 44.1 kHz, normalised
 * to -1 dBFS. The printed table is the same measure() report the engine and the
 * tool produce, so a suspect file can be matched to its numbers immediately.
 */

import { mkdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, writeFileAtomic } from '../lib/audio.js'
import { GENRES, composeScore, renderScore, toComposeWavBytes } from '../lib/compose.js'

const OUTPUT_DIR = fileURLToPath(new URL('../../out/', import.meta.url))
const BARS = 16
const SEED = 7
const INTENSITY = 0.65

await mkdir(OUTPUT_DIR, { recursive: true })

const rows = []
let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

for (const genre of Object.keys(GENRES)) {
  const started = process.hrtime.bigint()
  const score = composeScore({ genre, bars: BARS, seed: SEED, intensity: INTENSITY })
  const rendered = renderScore(score)
  const bytes = toComposeWavBytes(rendered.samples, rendered.sampleRate, score.seed)
  const target = join(OUTPUT_DIR, `compose-${genre}-16bar.wav`)
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  const metrics = measure(rendered.samples, rendered.sampleRate)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6

  rows.push({
    genre,
    path: target,
    relativePath: relative(process.cwd(), target).split('\\').join('/'),
    bytes: info.size,
    midi: score.progression.join(' '),
    key: `${score.key} ${score.mode}`,
    bpm: score.bpm,
    duration: metrics.durationSeconds,
    peak: metrics.peakDbfs,
    rms: metrics.rmsDbfs,
    crest: metrics.crestDb,
    centroid: metrics.centroidHz,
    onsets: metrics.onsets,
    notes: score.tracks.reduce((sum, track) => sum + track.notes.length, 0),
    clipping: metrics.clipping,
    elapsed
  })

  check(`${genre} wrote a file`, info.size > 1000, String(info.size))
  check(`${genre} no clipping`, metrics.clipping === 0, String(metrics.clipping))
  check(`${genre} no NaN`, rendered.samples.every((value) => Number.isFinite(value)))
}

const pad = (value, width) => String(value).padStart(width)
// `notes` is the score's note count (objective density). `onsets` is measure()'s
// transient counter: it under-counts dense mixes because it needs a jump against
// the global peak. test/compose.mjs carries the robust onset detector.
console.log(`\n${rows.length} cues @ ${BARS} bars, ${SEED} seed, intensity ${INTENSITY}\n`)
console.log('genre      bpm  key / mode               progression        duration   peak   rms  crest  centroid  notes  onsets   file')
for (const row of rows) {
  console.log(
    `${row.genre.padEnd(10)} ${pad(row.bpm, 3)}  ${row.key.padEnd(22)}  ${row.midi.padEnd(17)} ` +
    `${pad(row.duration.toFixed(2) + 's', 8)}  ${pad(row.peak, 5)}  ${pad(row.rms, 5)}  ${pad(row.crest, 5)}  ` +
    `${pad(row.centroid, 7)}Hz  ${pad(row.notes, 5)}  ${pad(row.onsets, 6)}  ${row.relativePath}`
  )
}

const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
console.log(`\nfiles (${(totalBytes / 1024 / 1024).toFixed(1)} MB total):`)
for (const row of rows) console.log(`  ${row.path}  (${(row.bytes / 1024).toFixed(0)} KB, ${row.elapsed.toFixed(0)} ms to compose+render+write)`)

console.log(failures === 0 ? '\nOK: cues written' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
