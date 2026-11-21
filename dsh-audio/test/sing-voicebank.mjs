/**
 * Tool-layer verification for the optional recorded-voice tier of `audio_sing`.
 *
 * `test/voicebank.mjs` proves the engine (`lib/voicebank.js`) sings in tune; this
 * file proves the seam the model actually calls. Four questions, each answered
 * with a measurement from the written wav rather than from the tool's own report:
 *
 *   1. Is the formant default unchanged, and does `voicebank: true` with no bank
 *      fall back instead of failing?
 *   2. When a bank IS installed, does the tool use it, and is the first note in
 *      tune (autocorrelation, cents printed)?
 *   3. What happens to a syllable the 12-file subset does not contain?
 *   4. Do both engines stay deterministic, and does switching engines keep the
 *      file-path shape and the metrics keys the other tools promise?
 *
 * No download: the bank is skipped cleanly when absent (see
 * `assets/voicebank/README.md`), so this test passes on a machine that only has
 * the zero-asset tier.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerSingTools } from '../lib/tools-sing.js'
import { defaultVoicebankDir, estimateF0, loadVoicebank, midiToHz } from '../lib/voicebank.js'
import { decodeWav } from '../lib/wav.js'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-sing-bank-'))

/** A fake Cordis context, the same shape `test/tools-test.mjs` uses. */
function makeContext () {
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  return { ctx, registered }
}
const exec = { agent: { session: { id: 'sing-voicebank-test' } } }
const { ctx, registered } = makeContext()
registerSingTools(ctx)
const tool = registered.get('audio_sing')

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}
const fmt = (value, digits = 2) => Number(value).toFixed(digits)
const sign = (value) => (value >= 0 ? '+' : '')
/** Interval in cents between two frequencies; Infinity when unmeasurable. */
const centsOf = (measured, target) => (measured > 0 && target > 0 ? 1200 * Math.log2(measured / target) : Infinity)
const call = (args) => tool.execute(args, exec)

async function readAudio (path) {
  const decoded = decodeWav(await readFile(path))
  return {
    samples: decoded.channels[0],
    sampleRate: decoded.sampleRate,
    durationSeconds: decoded.durationSeconds
  }
}

/** Peak/rms of a decoded wav, for "is there actually a voice in this file". */
function level (audio) {
  let peak = 0
  let energy = 0
  for (const sample of audio.samples) {
    peak = Math.max(peak, Math.abs(sample))
    energy += sample * sample
  }
  return { peak, rms: Math.sqrt(energy / Math.max(1, audio.samples.length)) }
}

/**
 * Pitch of one note, measured from the written file over its sustained part
 * (35 %..92 % of the note — the window the bank renderer itself validates its
 * takes with). Independent of `result.pitchAccuracy`, which comes from the tool.
 */
function measureNote (audio, timing) {
  const length = timing.end - timing.start
  const from = Math.round((timing.start + length * 0.35) * audio.sampleRate)
  const to = Math.min(audio.samples.length, Math.round((timing.start + length * 0.92) * audio.sampleRate))
  return estimateF0(audio.samples, audio.sampleRate, from, to)
}

const PATH_SHAPE = /^assets\/audio\/sing-[0-9a-f]{12}\.wav$/

/* --------------------------------------------------- tool / parameter surface -- */

console.log('-- tool contract --')
check('audio_sing is registered', tool !== undefined)
check('still concurrency safe', tool.isConcurrencySafe === true)
check('description mentions the recorded tier', /voicebank/i.test(tool.description), tool.description.slice(0, 80))
check('has a voicebank parameter', tool.parameters.properties.voicebank !== undefined)
check('voicebank is boolean or string', tool.parameters.properties.voicebank.anyOf !== undefined)
check('has a voicebankDir parameter', tool.parameters.properties.voicebankDir !== undefined)
check('schema still rejects unknown keys', tool.parameters.additionalProperties === false)
console.log(`  parameters: ${Object.keys(tool.parameters.properties).join(', ')}`)

/* ------------------------------------- 1. no bank: graceful formant fallback -- */

console.log('\n-- voicebank requested but not installed --')
const defaultDir = defaultVoicebankDir()
const defaultPresent = existsSync(defaultDir)
if (defaultPresent) {
  console.log(`  SKIP: a bank is installed at ${defaultDir}, so the "not installed" path cannot be exercised here`)
} else {
  const fallback = await call({ melody: 'C4:1 E4:1', lyric: 'ma la', bpm: 96, voicebank: true })
  check('falls back to the formant engine', fallback.engine === 'formant', String(fallback.engine))
  check('returns a warning instead of throwing', typeof fallback.warning === 'string' && fallback.warning.length > 0, String(fallback.warning))
  check('text says the recorded bank was unavailable', /voicebank/i.test(fallback.text), fallback.text.split('\n')[0])
  check('text names the formant fallback', /formant/i.test(fallback.text), fallback.text.split('\n')[0])
  check('falls back with a result, not a failure', PATH_SHAPE.test(fallback.relativePath), fallback.relativePath)
  console.log(`  engine ${fallback.engine}; ${fallback.warning}`)
}

// The same rule through the config path, independent of whether a default bank
// is installed: `voicebank: true` against a configured-but-missing directory is
// still a fallback, not a failure.
{
  const configured = makeContext()
  registerSingTools(configured.ctx, { voicebankDir: join(cwd, 'config-bank-that-is-missing') })
  const fallback = await configured.registered.get('audio_sing').execute({ melody: 'C4:1', lyric: 'ma', voicebank: true }, exec)
  check('voicebank:true with a missing configured bank falls back', fallback.engine === 'formant', String(fallback.engine))
  check('the configured path is named in the warning', typeof fallback.warning === 'string' && fallback.warning.includes('config-bank-that-is-missing'), String(fallback.warning))
  console.log(`  voicebank:true + missing config.voicebankDir -> engine ${fallback.engine}, warning present`)
}

// Environment-independent version of the same rule: naming a directory that does
// not exist is still a "missing bank", never a failure.
const missingDir = join(cwd, 'no-such-bank')
{
  const fallback = await call({ melody: 'C4:1', lyric: 'ma', bpm: 96, voicebank: missingDir })
  check('missing explicit bank falls back', fallback.engine === 'formant', String(fallback.engine))
  check('warning names the missing directory', typeof fallback.warning === 'string' && fallback.warning.includes('no-such-bank'), String(fallback.warning))
  console.log(`  voicebank "<tmp>/no-such-bank" -> engine ${fallback.engine}, warning present`)
}

// The one case that must throw: an explicit directory that exists but is not a bank.
{
  const emptyDir = join(cwd, 'empty-bank')
  await mkdir(emptyDir, { recursive: true })
  let thrown = null
  try {
    await call({ melody: 'C4:1', lyric: 'ma', bpm: 96, voicebankDir: emptyDir })
  } catch (error) {
    thrown = error
  }
  check('an explicit non-bank directory throws', thrown !== null, thrown === null ? 'no error thrown' : '')
  check('the error mentions the bank', thrown !== null && /voicebank/i.test(thrown.message), thrown === null ? '' : thrown.message)
  console.log(`  explicit empty directory -> ${thrown === null ? 'NO ERROR (bad)' : thrown.message}`)
}

/* ------------------------------------------------- 2./3. with a real bank -- */

console.log('\n-- recorded bank --')
const envBank = typeof process.env.DSH_AUDIO_VOICEBANK === 'string' && process.env.DSH_AUDIO_VOICEBANK.trim() !== ''
  ? resolve(process.env.DSH_AUDIO_VOICEBANK)
  : ''
const labBank = resolve(here, '../../assets/voicebank/hitsuboku-kumi-chn')
const bankDir = envBank !== '' ? envBank : (defaultPresent ? defaultDir : labBank)
let bankUsable = false
if (!existsSync(bankDir)) {
  console.log(`SKIP: no voicebank at ${bankDir} (download nothing here; see assets/voicebank/README.md)`)
} else {
  try {
    const bank = loadVoicebank(bankDir)
    bankUsable = true
    console.log(`  bank: ${bankDir}`)
    console.log(`  takes ${bank.meta.syllables}, usable syllable names ${bank.meta.names.filter((name) => !name.endsWith('+') && !name.endsWith(' R')).join(' ')}`)
  } catch (error) {
    console.log(`SKIP: ${bankDir} is not a usable voicebank (${error.message})`)
  }
}

let bankResult = null
if (bankUsable) {
  // `voicebank: true` when the default dir holds a bank; otherwise still request
  // the recorded tier by name and point the call at the downloaded subset.
  const args = defaultPresent && envBank === ''
    ? { melody: 'C4:1 E4:1 G4:2 D4:1', lyric: 'ma la ni wo', bpm: 90, voicebank: true }
    : { melody: 'C4:1 E4:1 G4:2 D4:1', lyric: 'ma la ni wo', bpm: 90, voicebank: true, voicebankDir: bankDir }
  const first = await call(args)
  bankResult = first

  check('uses the recorded engine', first.engine === 'voicebank', String(first.engine))
  check('no fallback warning on success', first.warning === null, String(first.warning))
  check('path keeps its shape', PATH_SHAPE.test(first.relativePath), first.relativePath)
  check('syllable timings cover every note', first.syllableTimings.length === first.notes, `${first.syllableTimings.length} vs ${first.notes}`)
  check('timings are usable for subtitles', first.syllableTimings.every((timing) =>
    typeof timing.text === 'string' && Number.isFinite(timing.start) && timing.end > timing.start))
  check('coverage counts add up', first.voicebank.coverage.exact + first.voicebank.coverage.approximated + first.voicebank.coverage.silent === first.notes,
    JSON.stringify(first.voicebank.coverage))
  check('text reports exact vs approximated', /exact/.test(first.text) && /approximated/.test(first.text), first.text.split('\n').slice(-2).join(' | '))
  console.log(`  engine ${first.engine} (${first.voicebank.name})`)
  console.log(`  coverage: ${first.voicebank.coverage.exact}/${first.notes} exact, ${first.voicebank.coverage.approximated} approximated, ${first.voicebank.coverage.silent} silent`)
  console.log(`  substitutions: ${first.voicebank.coverage.approximatedSamples.join(', ')}`)

  const audio = await readAudio(first.path)
  const audioLevel = level(audio)
  check('rendered file is not silent', audioLevel.peak > 0.1 && audioLevel.rms > 0.01,
    `peak ${fmt(audioLevel.peak, 3)}, rms ${fmt(audioLevel.rms, 4)}`)
  check('metrics agree it is audible', first.metrics.rmsDbfs > -40, String(first.metrics.rmsDbfs))

  // Requirement: the first note must be in tune, measured independently.
  const timing = first.syllableTimings[0]
  const targetHz = midiToHz(60) // first note of the melody is C4
  const measured = measureNote(audio, timing)
  const measuredCents = centsOf(measured.f0Hz, targetHz)
  const reported = first.pitchAccuracy.items[0]
  console.log(`  first note "${timing.text}" C4: measured ${fmt(measured.f0Hz)} Hz vs target ${fmt(targetHz)} Hz = ${sign(measuredCents)}${fmt(measuredCents, 1)} cents (${measured.frames} frames); tool reports ${reported === undefined ? 'n/a' : `${sign(reported.cents)}${fmt(reported.cents, 1)} cents`}`)
  check('first note within ±40 cents', Math.abs(measuredCents) <= 40, `${sign(measuredCents)}${fmt(measuredCents, 1)} cents`)

  /* ---- 3. a syllable the subset does not contain must degrade, not disappear -- */

  // The subset has a/e/o/yi/wu + ka/la/ma/na/sa/ta/ha; `ba` and `an` are absent,
  // so both must fall back to a recorded vowel take that is still audible.
  const degraded = await call({ melody: 'C4:1 D4:1', lyric: 'ba an', bpm: 90, voicebank: true, voicebankDir: bankDir })
  check('degraded render still uses the bank', degraded.engine === 'voicebank', String(degraded.engine))
  check('absent syllables are approximated, not exact', degraded.voicebank.coverage.exact === 0 && degraded.voicebank.coverage.approximated === 2,
    JSON.stringify(degraded.voicebank.coverage))
  check('each approximate syllable names the take it borrowed', degraded.syllableTimings.every((item) => item.exact === false && item.bankSyllable !== null),
    JSON.stringify(degraded.syllableTimings.map((item) => [item.text, item.bankSyllable])))
  const degradedAudio = await readAudio(degraded.path)
  const degradedLevel = level(degradedAudio)
  check('degraded render is still audible', degradedLevel.peak > 0.1 && degradedLevel.rms > 0.01,
    `peak ${fmt(degradedLevel.peak, 3)}, rms ${fmt(degradedLevel.rms, 4)}`)
  console.log(`  "ba an" -> ${degraded.syllableTimings.map((item) => `${item.text}->${item.bankSyllable}`).join(', ')} (peak ${fmt(degradedLevel.peak, 2)})`)

  /* ---- determinism: same request, same bytes ---- */

  const firstBytes = await readFile(first.path)
  const second = await call(args)
  const secondBytes = await readFile(second.path)
  check('recorded tier: same path on repeat', second.relativePath === first.relativePath, `${first.relativePath} vs ${second.relativePath}`)
  check('recorded tier: byte-identical on repeat', Buffer.compare(firstBytes, secondBytes) === 0, `${firstBytes.length} vs ${secondBytes.length}`)
  console.log(`  two renders: ${firstBytes.length} bytes, byte-identical = ${Buffer.compare(firstBytes, secondBytes) === 0}`)

  /* ---- config.voicebankDir: `voicebank: true` finds the bank without an argument ---- */

  const configured = makeContext()
  registerSingTools(configured.ctx, { voicebankDir: bankDir })
  const configuredTool = configured.registered.get('audio_sing')
  const fromConfig = await configuredTool.execute({ melody: 'A3:1 C4:1', lyric: 'ma la', bpm: 96, voicebank: true }, exec)
  check('voicebank:true uses config.voicebankDir', fromConfig.engine === 'voicebank', String(fromConfig.engine))
  check('config render has no warning', fromConfig.warning === null, String(fromConfig.warning))
  console.log(`  voicebank:true + config.voicebankDir -> engine ${fromConfig.engine}`)
}

/* ------------------------- 4. determinism and shape for both engines -- */

console.log('\n-- determinism and response shape --')
{
  const args = { melody: 'A3:1 C4:1', lyric: 'ma la', bpm: 84 }
  const first = await call(args)
  const firstBytes = await readFile(first.path)
  const again = await call(args)
  const againBytes = await readFile(again.path)
  check('formant: same path on repeat', first.relativePath === again.relativePath, `${first.relativePath} vs ${again.relativePath}`)
  check('formant: byte-identical on repeat', Buffer.compare(firstBytes, againBytes) === 0, `${firstBytes.length} vs ${againBytes.length}`)
  check('formant: path shape', PATH_SHAPE.test(first.relativePath), first.relativePath)

  const explicitOff = await call({ ...args, voicebank: false })
  check('voicebank:false is the unchanged default', explicitOff.engine === 'formant' && explicitOff.warning === null && explicitOff.relativePath === first.relativePath,
    `${explicitOff.engine} ${explicitOff.relativePath}`)
  check('voicebank:false produces identical bytes', Buffer.compare(await readFile(explicitOff.path), firstBytes) === 0)

  const formantAudio = await readAudio(first.path)
  const formantMeasured = measureNote(formantAudio, first.syllableTimings[0])
  const formantCents = centsOf(formantMeasured.f0Hz, midiToHz(57))
  console.log(`  formant A3: measured ${fmt(formantMeasured.f0Hz)} Hz vs 220.00 Hz = ${sign(formantCents)}${fmt(formantCents, 1)} cents`)

  if (bankResult !== null) {
    const keys = (result) => Object.keys(result.metrics).sort().join(',')
    check('metrics keys identical across engines', keys(first) === keys(bankResult), `${keys(first)} vs ${keys(bankResult)}`)
    check('both engines keep the path shape', PATH_SHAPE.test(first.relativePath) && PATH_SHAPE.test(bankResult.relativePath),
      `${first.relativePath} / ${bankResult.relativePath}`)
    for (const key of ['path', 'relativePath', 'bytes', 'durationSeconds', 'metrics', 'syllableTimings', 'text', 'engine']) {
      check(`result exposes ${key} in both engines`, first[key] !== undefined && bankResult[key] !== undefined, key)
    }
    console.log(`  metrics keys: ${keys(first)}`)
  }
}

await rm(cwd, { recursive: true, force: true })

console.log(`\nvoicebank ${bankUsable ? `tested from ${bankDir}` : 'not installed (recorded-tier sections skipped)'}`)
console.log(failures === 0 ? 'OK: audio_sing recorded-voice tier behaves' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
