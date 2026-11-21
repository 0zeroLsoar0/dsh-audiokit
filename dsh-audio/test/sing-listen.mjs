/**
 * Listening renders for the formant singing voice.
 *
 * These are ears-only artefacts: four cues written to `test/out/` so a human can
 * judge whether this sounds like a voice singing words or like a buzzer. They
 * are not assertions — the numbers live in `sing.mjs` — but each file is read
 * back from disk and checked for duration, level and finite samples so a broken
 * render cannot pass silently.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, toWavBytes, writeFileAtomic } from '../lib/audio.js'
import { decodeWav } from '../lib/wav.js'
import { renderSing, singPlan } from '../lib/sing.js'

const outDir = fileURLToPath(new URL('./out/', import.meta.url))
await mkdir(outDir, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

/**
 * Render one cue, write it, read it back and report what is actually on disk.
 * @param {string} name - file name inside test/out/.
 * @param {object} request - singPlan request.
 * @param {object} options - renderSing options.
 * @param {string} description - what a listener should be hearing.
 */
async function cue (name, request, options, description) {
  const plan = singPlan(request)
  const result = renderSing(plan, options)
  const target = join(outDir, name)
  const bytes = toWavBytes(result.samples, result.sampleRate)
  await writeFileAtomic(target, bytes)

  const decoded = decodeWav(await readFile(target))
  const samples = decoded.channels[0]
  const metrics = measure(samples, decoded.sampleRate)
  let finite = true
  for (const sample of samples) if (!Number.isFinite(sample)) finite = false

  check(`${name} decodes`, decoded.channels.length === 1 && samples.length > 0)
  check(`${name} finite`, finite)
  check(`${name} audible`, metrics.rmsDbfs > -40, `${metrics.rmsDbfs} dBFS`)
  check(`${name} no clipping`, metrics.clipping === 0, String(metrics.clipping))
  check(`${name} duration`, Math.abs(decoded.durationSeconds - plan.totalSeconds) < 0.01,
    `${decoded.durationSeconds} vs ${plan.totalSeconds}`)

  console.log(`${target}`)
  console.log(`  ${description}`)
  console.log(`  ${decoded.durationSeconds.toFixed(2)} s · ${decoded.sampleRate} Hz · ${(bytes.length / 1024).toFixed(0)} KB · ` +
    `${plan.notes.length} notes · ${plan.notes.map((note) => note.syllable).join(' ')} · ` +
    `peak ${metrics.peakDbfs} dBFS · rms ${metrics.rmsDbfs} dBFS · centroid ${metrics.centroidHz} Hz · onsets ${metrics.onsets}`)
  console.log(`  syllables in seconds: ${result.syllableTimings.map((t) => `${t.text} ${t.start.toFixed(2)}-${t.end.toFixed(2)}`).join(' · ')}`)
  return { target, plan, result, metrics }
}

console.log('Singing-voice listening renders (formant synthesizer, zero assets)\n')

await cue('sing-la-la-la-la.wav', {
  melody: 'A3:1 C4:1 E4:1 A4:2',
  lyric: 'la la la la',
  bpm: 100
}, { voice: 'alto', seed: 1, vibrato: 0.5, breath: 0.16 },
'Four notes "la la la la", rising then landing on A4 — the plainest check that the pitch and the vowel are both there.')

await cue('sing-ma-mi-mu-me-mo.wav', {
  melody: 'C4:1 D4:1 E4:1 F4:1 G4:2',
  lyric: 'ma mi mu me mo',
  bpm: 108
}, { voice: 'alto', seed: 2, vibrato: 0.35, breath: 0.14 },
'"ma mi mu me mo" up a five-note scale — a vowel-and-consonant exercise; if the vowels are distinct this one is readable.')

await cue('sing-phrase-harmony.wav', {
  melody: 'E4:1 G4:1 A4:2',
  lyric: 'wo ai ni',
  bpm: 92
}, { voice: 'alto', seed: 3, vibrato: 0.45, breath: 0.18, harmony: 'third' },
'A three-note phrase ("wo ai ni") with a harmony voice a third above and a slightly slower vibrato — the choral-ish use.')

await cue('sing-48khz.wav', {
  melody: 'A3:1 C#4:1 E4:1 A4:2',
  lyric: 'ma ni xue la',
  bpm: 96
}, { voice: 'child', seed: 4, vibrato: 0.4, breath: 0.2, sampleRate: 48000 },
'Same engine at 48 kHz with the child voice (formants raised 30 %): the video-deliverable case.')

console.log('')
console.log('Honest limitation: the engine is a source-filter (formant) synthesizer. Formants, consonants,')
console.log('jitter and vibrato are real and measured, but there is no spectral detail of a live tract —')
console.log('expect a clearly synthetic, vocoder-like voice that sings recognizable syllables.')
console.log('')
console.log(failures === 0 ? 'OK: all four cues written and verified on disk' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
