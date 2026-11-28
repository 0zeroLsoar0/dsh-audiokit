/**
 * `lib/selfcheck.js`: the local, model-free acoustic self-check.
 *
 * The claim being tested is narrow and specific: a real render of every core
 * preset and of a representative set of design recipes passes its own family's
 * shape check, a deliberately broken file fails with the failing check named,
 * and the result is deterministic (no timestamps, no randomness, so two runs on
 * the same input are byte-identical JSON).
 *
 * Run with the node from WORKERS.md:
 *   node test/selfcheck.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalize, measure, renderPreset } from '../lib/audio.js'
import { designSound } from '../lib/design.js'
import { selfCheck } from '../lib/selfcheck.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const RATE = 44100

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

const allConclusions = (report) => report.checks.length > 0 && report.checks.every((entry) =>
  typeof entry.name === 'string' && entry.name.length > 0 &&
  typeof entry.ok === 'boolean' &&
  typeof entry.detail === 'string' && entry.detail.length > 0 &&
  (entry.scope === 'generic' || entry.scope === 'family') &&
  (entry.level === 'error' || entry.level === 'warn'))

/** A render exactly as `audio_synth` writes it: DC-blocked, normalised, limited. */
function renderLikeTool (preset, options = {}) {
  const rendered = renderPreset({ preset, seed: options.seed ?? 1, sampleRate: RATE, ...options })
  finalize(rendered.samples, rendered.sampleRate, -1, { loop: options.loop === true })
  return rendered
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-selfcheck-'))

console.log('selfcheck: family shape, broken files, determinism')
console.log(`sample rate ${RATE} Hz\n`)

/* ------------------------------------------------------------- presets -- */

const CORE_PRESETS = ['impact', 'whoosh', 'tick', 'chime', 'riser', 'zap', 'thud', 'scrap', 'texture']

console.log('-- nine core presets: every one passes its own family check --')
for (const preset of CORE_PRESETS) {
  const rendered = renderLikeTool(preset)
  const report = await selfCheck({
    samples: rendered.samples,
    sampleRate: rendered.sampleRate,
    spec: { preset, duration: rendered.durationSeconds, sampleRate: RATE, loop: false }
  })
  const failing = report.checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`)
  console.log(`  ${preset.padEnd(8)} ok=${String(report.ok).padEnd(5)} ${report.checks.length} checks  crest ${report.metrics.crestDb} dB  centroid ${report.metrics.centroidHz} Hz  onsets ${report.metrics.onsets}${failing.length > 0 ? `  FAILING ${failing.join(' | ')}` : ''}`)
  check(`${preset} self-check passes`, report.ok, failing.join(' | '))
  check(`${preset} every check has a conclusion`, allConclusions(report))
  check(`${preset} family is reported`, report.family !== null && report.family.kind === 'preset' && report.family.id === preset, JSON.stringify(report.family))
  check(`${preset} family checks include crest/centroid/onsets`,
    ['crestFactor', 'spectralCentroid', 'onsetCount'].every((name) => report.checks.some((entry) => entry.name === name && entry.scope === 'family')))
  check(`${preset} summary is Chinese prose`, /本地自检通过/.test(report.summary), report.summary)
}

/* ------------------------------------------------------------- recipes -- */

const RECIPES_TO_CHECK = [
  'door-slam-metal',
  'glass-break',
  'explosion-far',
  'magic-sparkle',
  'water-drip',
  'ui-success',
  'machinery-loop',
  'creature-growl',
  'bird-chirp',
  'bat-echolocation'
]

console.log('\n-- design recipes: family shape holds for tuned arrangements --')
for (const recipe of RECIPES_TO_CHECK) {
  const rendered = designSound({ recipe, seed: 1, sampleRate: RATE })
  const report = await selfCheck({
    samples: rendered.samples,
    sampleRate: rendered.sampleRate,
    spec: { recipe, duration: rendered.durationSeconds, sampleRate: RATE, loop: rendered.loop }
  })
  const failing = report.checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`)
  console.log(`  ${recipe.padEnd(18)} ok=${String(report.ok).padEnd(5)} ${report.checks.length} checks  crest ${report.metrics.crestDb} dB  centroid ${report.metrics.centroidHz} Hz  onsets ${report.metrics.onsets}${rendered.loop ? `  loop seam ${report.metrics.loopSeam} dB` : ''}${failing.length > 0 ? `  FAILING ${failing.join(' | ')}` : ''}`)
  check(`${recipe} self-check passes`, report.ok, failing.join(' | '))
  check(`${recipe} every check has a conclusion`, allConclusions(report))
  check(`${recipe} is recognised as a recipe`, report.family !== null && report.family.kind === 'recipe', JSON.stringify(report.family))
  if (rendered.loop) {
    check(`${recipe} loop seam is checked and clean`,
      report.checks.some((entry) => entry.name === 'loopSeam' && entry.ok) && report.metrics.loopSeam < 6,
      String(report.metrics.loopSeam))
  }
}

/* --------------------------------------------------------- wav-file input -- */

console.log('\n-- a file on disk is checked through its real channels --')
{
  const rendered = renderLikeTool('impact', { seed: 7 })
  const path = join(cwd, 'impact.wav')
  await writeFile(path, encodeWav([rendered.samples], rendered.sampleRate))
  const report = await selfCheck({ wavPath: path, spec: { preset: 'impact', duration: rendered.durationSeconds } })
  const decoded = decodeWav(encodeWav([rendered.samples], rendered.sampleRate))
  console.log(`  ${path.split(/[\\/]/).pop()} -> ok=${report.ok}, ${report.metrics.channels} ch, ${report.metrics.bitDepth}-bit, peak ${report.metrics.peakDbfs} dBFS`)
  check('wavPath input is decoded and passes', report.ok)
  check('wavPath input reports its bit depth', report.metrics.bitDepth === 16, String(report.metrics.bitDepth))
  check('wavPath input measures the decoded file', Math.abs(report.metrics.peakDbfs - measure(decoded.channels[0], decoded.sampleRate).peakDbfs) < 0.02)

  const stereo = await selfCheck({
    samples: [rendered.samples, rendered.samples.map((value) => value * 0.5)],
    sampleRate: rendered.sampleRate,
    spec: { preset: 'impact' }
  })
  check('in-memory stereo channels are measured as a file', stereo.metrics.channels === 2)
  check('stereo file peak is the worst channel', Math.abs(stereo.metrics.peakDbfs - report.metrics.peakDbfs) < 0.01, String(stereo.metrics.peakDbfs))
}

/* --------------------------------------------------------- broken files -- */

console.log('\n-- broken WAV files on disk fail, and the failing check is named --')
{
  // Silent file.
  const silentFrames = Math.round(0.5 * RATE)
  const silentPath = join(cwd, 'silent.wav')
  await writeFile(silentPath, encodeWav([new Float32Array(silentFrames)], RATE))
  const silentFile = await selfCheck({ wavPath: silentPath })
  console.log(`  silent.wav   ok=${silentFile.ok} failed ${silentFile.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('a silent wav fails', silentFile.ok === false)
  check('a silent wav names the peak check', silentFile.checks.some((entry) => entry.name === 'peak' && !entry.ok))

  // Clipped file: the writer hard-clips, so the samples come back at full scale.
  const clippedPath = join(cwd, 'clipped.wav')
  const loud = new Float32Array(silentFrames)
  for (let i = 0; i < silentFrames; i += 1) loud[i] = 1.8 * Math.sin(2 * Math.PI * 220 * i / RATE)
  await writeFile(clippedPath, encodeWav([loud], RATE))
  const clippedFile = await selfCheck({ wavPath: clippedPath })
  console.log(`  clipped.wav  ok=${clippedFile.ok} peak ${clippedFile.metrics.peakDbfs} dBFS, ${clippedFile.metrics.clipping} clipped, failed ${clippedFile.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('a clipped wav fails', clippedFile.ok === false)
  check('a clipped wav names the clipping check', clippedFile.checks.some((entry) => entry.name === 'clipping' && !entry.ok))
  check('a clipped wav counts clipped samples', clippedFile.metrics.clipping > 0, String(clippedFile.metrics.clipping))
}

console.log('\n-- broken in-memory input fails, and the failing check is named --')
{
  const frames = Math.round(0.5 * RATE)
  const silent = new Float32Array(frames)
  const silentReport = await selfCheck({ samples: silent, sampleRate: RATE })
  console.log(`  silent      ok=${silentReport.ok} failed ${silentReport.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('silent file fails', silentReport.ok === false)
  check('silent file names the peak check', silentReport.checks.some((entry) => entry.name === 'peak' && !entry.ok))
  check('silent file summary says it failed', /本地自检未通过/.test(silentReport.summary), silentReport.summary)

  const nan = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) nan[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / RATE)
  nan[Math.round(0.1 * RATE)] = Number.NaN
  nan[Math.round(0.2 * RATE)] = Number.POSITIVE_INFINITY
  const nanReport = await selfCheck({ samples: nan, sampleRate: RATE })
  console.log(`  NaN/Inf     ok=${nanReport.ok} failed ${nanReport.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('NaN/Infinity file fails', nanReport.ok === false)
  check('NaN/Infinity is counted', nanReport.metrics.nanSamples === 1 && nanReport.metrics.infiniteSamples === 1,
    `${nanReport.metrics.nanSamples}/${nanReport.metrics.infiniteSamples}`)
  check('NaN/Infinity names the finite check', nanReport.checks.some((entry) => entry.name === 'finiteSamples' && !entry.ok))

  const clipped = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) clipped[i] = i < frames * 0.05 ? 1.2 : 0.2 * Math.sin(2 * Math.PI * 220 * i / RATE)
  const clippedReport = await selfCheck({ samples: clipped, sampleRate: RATE })
  console.log(`  clipped     ok=${clippedReport.ok} peak ${clippedReport.metrics.peakDbfs} dBFS, ${clippedReport.metrics.clipping} clipped samples, failed ${clippedReport.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('clipped file fails', clippedReport.ok === false)
  check('clipped file counts the clipped samples', clippedReport.metrics.clipping > 0, String(clippedReport.metrics.clipping))
  check('clipped file names the clipping check', clippedReport.checks.some((entry) => entry.name === 'clipping' && !entry.ok))

  // A one-shot forced into a loop: the seam check must catch it.
  const badLoop = renderLikeTool('impact', { seed: 5, duration: 1, loop: true })
  const loopReport = await selfCheck({
    samples: badLoop.samples,
    sampleRate: badLoop.sampleRate,
    spec: { preset: 'impact', duration: 1, loop: true }
  })
  console.log(`  one-shot loop ok=${loopReport.ok} seam ${loopReport.metrics.loopSeam} dB, failed ${loopReport.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('a one-shot looped fails the seam check', loopReport.ok === false && loopReport.checks.some((entry) => entry.name === 'loopSeam' && !entry.ok))

  // The wrong preset must be caught by the family shape, not by silence.
  const texture = renderLikeTool('texture')
  const mislabelled = await selfCheck({
    samples: texture.samples,
    sampleRate: texture.sampleRate,
    spec: { preset: 'impact', duration: 3 }
  })
  console.log(`  texture as impact ok=${mislabelled.ok} failed ${mislabelled.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(', ')}`)
  check('a texture labelled impact fails the onset count', mislabelled.ok === false && mislabelled.checks.some((entry) => entry.name === 'onsetCount' && !entry.ok))
}

/* ------------------------------------------------------------ generic -- */

console.log('\n-- an unknown preset or recipe falls back to generic checks --')
{
  const rendered = renderLikeTool('impact', { seed: 2 })
  const report = await selfCheck({ samples: rendered.samples, sampleRate: RATE, spec: { preset: 'not-a-real-preset' } })
  console.log(`  unknown preset -> ok=${report.ok}, family ${JSON.stringify(report.family)}, scopes ${[...new Set(report.checks.map((entry) => entry.scope))].join(',')}`)
  check('unknown preset still passes a good file', report.ok)
  check('unknown preset reports no family', report.family === null)
  check('unknown preset marks every check generic', report.checks.every((entry) => entry.scope === 'generic'))
  check('unknown preset skips the family checks', !report.checks.some((entry) => entry.name === 'crestFactor' || entry.name === 'spectralCentroid'))
  check('unknown preset metrics say generic', report.metrics.family === 'generic', report.metrics.family)

  const noSpec = await selfCheck({ samples: rendered.samples, sampleRate: RATE })
  check('no spec at all is the generic path', noSpec.family === null && noSpec.checks.every((entry) => entry.scope === 'generic'))

  const unknownRecipe = await selfCheck({ samples: rendered.samples, sampleRate: RATE, spec: { recipe: 'nope' } })
  check('unknown recipe is the generic path', unknownRecipe.family === null)
}

/* --------------------------------------------------------- determinism -- */

console.log('\n-- the same input gives the same report twice --')
{
  const rendered = renderLikeTool('chime', { seed: 9 })
  const input = { samples: rendered.samples, sampleRate: rendered.sampleRate, spec: { preset: 'chime', duration: rendered.durationSeconds, loop: false } }
  const first = await selfCheck(input)
  const second = await selfCheck(input)
  check('reports are byte-identical JSON', JSON.stringify(first) === JSON.stringify(second))
  check('checks are byte-identical', JSON.stringify(first.checks) === JSON.stringify(second.checks))
}

/* ------------------------------------------------------------- guards -- */

console.log('\n-- input guards --')
{
  let threw = false
  try { await selfCheck({}) } catch { threw = true }
  check('needs a wavPath or samples', threw)
  threw = false
  try { await selfCheck({ samples: new Float32Array(10) }) } catch { threw = true }
  check('in-memory samples need a sampleRate', threw)
  threw = false
  try { await selfCheck({ wavPath: join(cwd, 'missing.wav') }) } catch (error) { threw = /cannot read/.test(error.message) }
  check('a missing file is a readable error', threw)
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0 ? `\nOK: all ${checks} self-check assertions passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
