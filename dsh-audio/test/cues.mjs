/**
 * Tests for lib/cues.js and lib/tools-cues.js.
 *
 * The signals are synthesized here on purpose: a click track has a known truth,
 * so "detected 4 onsets at 0.250 0.750 1.250 1.750 s" is a measurement rather
 * than a screenshot. The suite pins the contract the tool promises:
 *
 *   - hits are found within 15 ms (the analysis hop is 5 ms, so this is loose);
 *   - a noise burst produces a cue at its start and nothing inside the silence;
 *   - sensitivity is monotone (equal counts are allowed, drops are not);
 *   - minGapSeconds merges a flam and keeps two hits spaced further apart;
 *   - maxCues truncates with a warning, and two identical runs agree byte for
 *     byte;
 *   - an empty or silent file is a clean empty result with a readable warning,
 *     not a crash;
 *   - a section boundary (a lasting level change) is labelled `section`.
 *
 * The tool layer is exercised through a fake Cordis context: no network, no
 * profile, a private scratch directory under test/out/cues/.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectCues, CUE_DEFAULTS } from '../lib/cues.js'
import { registerCueTools } from '../lib/tools-cues.js'
import { encodeWav } from '../lib/wav.js'

const SR = 48000
const outDir = new URL('./out/cues/', import.meta.url)
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return true
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
  return false
}

function fmt (value, digits = 3) {
  return Number(value).toFixed(digits)
}

/** Small deterministic xorshift so the noise bed is the same every run. */
function makeRng (seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 4294967296
  }
}

/** A 5 ms decaying 1800 Hz click: a clean, known impact time. */
function addClick (samples, at, amplitude = 0.8) {
  const start = Math.round(at * SR)
  const length = Math.round(0.005 * SR)
  for (let i = 0; i < length; i += 1) {
    samples[start + i] += amplitude * Math.sin(2 * Math.PI * 1800 * i / SR) * Math.exp(-i / (0.0015 * SR))
  }
}

/** A rectangular noise burst: sharp start, stationary body, sharp end. */
function addNoiseBurst (samples, at, duration, amplitude, rand) {
  const start = Math.round(at * SR)
  const length = Math.round(duration * SR)
  for (let i = 0; i < length; i += 1) samples[start + i] += amplitude * (rand() * 2 - 1)
}

function wavBytes (samples, sampleRate = SR) {
  return encodeWav([samples], sampleRate, { dither: false })
}

/** Largest distance from each cue to its nearest known truth time. */
function nearestError (truth, cues) {
  return cues.reduce((worst, cue) => Math.max(worst, Math.min(...truth.map((at) => Math.abs(cue.at - at)))), 0)
}

/* --------------------------------------------------------- 4 even clicks -- */

console.log('-- 4 evenly spaced clicks --')
const clicks = new Float32Array(SR * 2)
const clickTruth = [0.25, 0.75, 1.25, 1.75]
for (const at of clickTruth) addClick(clicks, at, 0.8)
const clickResult = detectCues(clicks, SR)
const clickError = nearestError(clickTruth, clickResult.cues)
console.log(`cues=${clickResult.cues.map((cue) => `${fmt(cue.at)}s/${cue.kind}`).join(' ')} maxErr=${(clickError * 1000).toFixed(2)}ms`)
check('4 clicks -> exactly 4 cues', clickResult.cues.length === 4, String(clickResult.cues.length))
check('every click cue is kind onset', clickResult.cues.every((cue) => cue.kind === 'onset'), JSON.stringify(clickResult.cues))
check('click times land within 15 ms', clickError <= 0.015, `${(clickError * 1000).toFixed(2)}ms`)
check('click cues are in time order', clickResult.cues.every((cue, index) => index === 0 || cue.at > clickResult.cues[index - 1].at))
check('every cue has the documented shape', clickResult.cues.every((cue) => Object.keys(cue).join(',') === 'at,strength,kind'), JSON.stringify(clickResult.cues[0]))
check('strengths are in 0..1', clickResult.cues.every((cue) => cue.strength > 0 && cue.strength <= 1), JSON.stringify(clickResult.cues.map((cue) => cue.strength)))
check('a clean click track has no warnings', clickResult.warnings.length === 0, JSON.stringify(clickResult.warnings))

/* --------------------------------------------- noise bursts vs silence --- */

console.log('-- noise bursts separated by silence --')
const bursts = new Float32Array(SR * 2.4)
const burstTruth = [0.15, 0.65, 1.15, 1.65]
const burstRand = makeRng(7)
for (const at of burstTruth) addNoiseBurst(bursts, at, 0.12, 0.5, burstRand)
const burstResult = detectCues(bursts, SR)
const burstError = nearestError(burstTruth, burstResult.cues)
const inSilence = burstResult.cues.filter((cue) => Math.min(...burstTruth.map((at) => Math.abs(cue.at - at))) > 0.02)
console.log(`cues=${burstResult.cues.map((cue) => fmt(cue.at)).join(' ')} maxErr=${(burstError * 1000).toFixed(2)}ms inSilence=${inSilence.length}`)
check('4 bursts -> 4 cues', burstResult.cues.length === 4, String(burstResult.cues.length))
check('burst cues sit on burst starts', burstError <= 0.02, `${(burstError * 1000).toFixed(2)}ms`)
check('no cue in the silent gaps', inSilence.length === 0, inSilence.map((cue) => cue.at).join(','))
check('bursts are kind onset', burstResult.cues.every((cue) => cue.kind === 'onset'), JSON.stringify(burstResult.cues))

/* ------------------------------------------------------- sensitivity ---- */

console.log('-- sensitivity is monotone --')
// Hits over a steady 100 Hz bed: their dB rise differs, so the threshold
// actually decides whether the quiet ones are kept.
const bed = new Float32Array(SR * 2)
for (let i = 0; i < bed.length; i += 1) bed[i] = 0.05 * Math.sin(2 * Math.PI * 100 * i / SR)
addClick(bed, 0.3, 0.6)
addClick(bed, 0.9, 0.18)
addClick(bed, 1.5, 0.08)
const sensitivityLevels = [0, 0.25, 0.5, 0.75, 1]
const sensitivityCounts = sensitivityLevels.map((sensitivity) => detectCues(bed, SR, { sensitivity }).cues.length)
console.log(`sensitivity ${sensitivityLevels.join('/')} -> counts ${sensitivityCounts.join('/')}`)
check('counts never drop as sensitivity rises',
  sensitivityCounts.every((count, index) => index === 0 || count >= sensitivityCounts[index - 1]),
  JSON.stringify(sensitivityCounts))
check('a higher sensitivity finds at least one more cue', sensitivityCounts[sensitivityCounts.length - 1] > sensitivityCounts[0], JSON.stringify(sensitivityCounts))

/* ---------------------------------------------------------- minGap ------ */

console.log('-- minGapSeconds merges a flam --')
const flam = new Float32Array(SR * 1.5)
addClick(flam, 0.5, 0.7)
addClick(flam, 0.52, 0.65)
const merged = detectCues(flam, SR, { minGapSeconds: 0.08 })
const separate = detectCues(flam, SR, { minGapSeconds: 0.02 })
console.log(`0.08 -> ${merged.cues.length} cue(s) at ${merged.cues.map((cue) => fmt(cue.at)).join(',')}; 0.02 -> ${separate.cues.length} at ${separate.cues.map((cue) => fmt(cue.at)).join(',')}`)
check('two hits 20 ms apart merge under the default 80 ms gap', merged.cues.length === 1, String(merged.cues.length))
check('the merged cue is the earlier hit', merged.cues.length === 1 && Math.abs(merged.cues[0].at - 0.5) <= 0.015, JSON.stringify(merged.cues))
check('a 20 ms gap keeps both hits', separate.cues.length === 2, String(separate.cues.length))
check('the separated hits are the two clicks', separate.cues.length === 2 && nearestError([0.5, 0.52], separate.cues) <= 0.015, JSON.stringify(separate.cues))

/* ---------------------------------------------------------- maxCues ----- */

console.log('-- maxCues truncates with a warning --')
const train = new Float32Array(SR * 2.2)
const trainTruth = [0.2, 0.5, 0.8, 1.1, 1.4, 1.7]
trainTruth.forEach((at, index) => addClick(train, at, 0.9 - index * 0.1))
const capped = detectCues(train, SR, { maxCues: 3 })
console.log(`6 clicks capped at 3 -> ${capped.cues.map((cue) => fmt(cue.at)).join(' ')} warnings=${JSON.stringify(capped.warnings)}`)
check('maxCues caps the result', capped.cues.length === 3, String(capped.cues.length))
check('truncation is reported', capped.warnings.some((warning) => /maxCues=3/.test(warning) && /3 weaker/.test(warning)), JSON.stringify(capped.warnings))
check('the strongest cues survive the cap',
  capped.cues.map((cue) => cue.at).join(',') === [0.2, 0.5, 0.8].map((at) => Number(at.toFixed(4))).join(','),
  JSON.stringify(capped.cues.map((cue) => cue.at)))
const uncapped = detectCues(train, SR, { maxCues: 10 })
check('a cap above the count adds no warning', uncapped.cues.length === 6 && uncapped.warnings.length === 0, `${uncapped.cues.length}/${JSON.stringify(uncapped.warnings)}`)

/* ------------------------------------------------------- determinism ---- */

console.log('-- determinism --')
const repeat = detectCues(train, SR, { maxCues: 3 })
check('two runs on the same samples agree', JSON.stringify(capped) === JSON.stringify(repeat))
check('defaults are the documented values', CUE_DEFAULTS.sensitivity === 0.5 && CUE_DEFAULTS.minGapSeconds === 0.08 && CUE_DEFAULTS.maxCues === 200, JSON.stringify(CUE_DEFAULTS))

/* --------------------------------------------------- sections / decays -- */

console.log('-- section boundary on a lasting level change --')
// Quiet bed -> smooth 500 ms ramp -> loud bed: not an impact (the ramp is not
// sharp) but definitely a lasting level change.
const sectioned = new Float32Array(SR * 7)
const sectionRand = makeRng(11)
for (let i = 0; i < sectioned.length; i += 1) {
  const t = i / SR
  let amplitude
  if (t < 2.5) amplitude = 0.01
  else if (t < 3) {
    const progress = (t - 2.5) / 0.5
    amplitude = 0.01 + (0.35 - 0.01) * (progress * progress * (3 - 2 * progress))
  } else amplitude = 0.35
  sectioned[i] = amplitude * (sectionRand() * 2 - 1)
}
const sectionResult = detectCues(sectioned, SR, { sensitivity: 0.8 })
const sections = sectionResult.cues.filter((cue) => cue.kind === 'section')
console.log(`cues=${sectionResult.cues.map((cue) => `${fmt(cue.at)}s/${cue.kind}`).join(' ')}`)
check('a lasting level change produces a section cue', sections.length >= 1, JSON.stringify(sectionResult.cues))
check('the section cue is placed at the transition', sections.length >= 1 && sections[0].at >= 2.3 && sections[0].at <= 3.2, JSON.stringify(sections))
check('every cue kind is one of onset/section', sectionResult.cues.every((cue) => cue.kind === 'onset' || cue.kind === 'section'), JSON.stringify(sectionResult.cues))

// A long exponential decay is one hit plus a tail, not a chain of sections.
const decaying = new Float32Array(SR * 3)
const decayRand = makeRng(9)
for (let i = 0; i < decaying.length; i += 1) decaying[i] = 0.6 * (decayRand() * 2 - 1) * Math.exp(-i / (0.35 * SR))
const decayResult = detectCues(decaying, SR)
console.log(`decaying noise -> ${decayResult.cues.map((cue) => `${fmt(cue.at)}s/${cue.kind}`).join(' ')}`)
check('a decaying tail is not a section', decayResult.cues.filter((cue) => cue.kind === 'section').length === 0, JSON.stringify(decayResult.cues))

/* --------------------------------------------------- empty / silent ----- */

console.log('-- empty and silent input --')
const emptyResult = detectCues(new Float32Array(0), SR)
const silentResult = detectCues(new Float32Array(SR), SR)
console.log(`empty -> cues=${emptyResult.cues.length} warnings=${JSON.stringify(emptyResult.warnings)}`)
console.log(`silent -> cues=${silentResult.cues.length} warnings=${JSON.stringify(silentResult.warnings)}`)
check('an empty file returns no cues', emptyResult.cues.length === 0 && emptyResult.durationSeconds === 0)
check('an empty file explains itself', emptyResult.warnings.length === 1 && /no samples/.test(emptyResult.warnings[0]), JSON.stringify(emptyResult.warnings))
check('a silent file returns no cues', silentResult.cues.length === 0)
check('a silent file explains itself', silentResult.warnings.length === 1 && /silent/.test(silentResult.warnings[0]), JSON.stringify(silentResult.warnings))
check('no NaN leaks into an empty result', Number.isFinite(emptyResult.durationSeconds) && Number.isFinite(emptyResult.sampleRate))

/* ------------------------------------------------------------- tool ----- */

console.log('-- audio_cues tool --')
const scratch = fileURLToPath(new URL('./out/cues/tool/', import.meta.url))
await mkdir(scratch, { recursive: true })
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
}
const exec = { agent: { session: { id: 'cues-test' } } }
registerCueTools(ctx)
check('registers exactly one tool', registered.size === 1 && registered.has('audio_cues'), [...registered.keys()].join(','))
const definition = registered.get('audio_cues')
check('tool schema is closed', definition?.parameters?.additionalProperties === false)
check('tool schema requires path', Array.isArray(definition?.parameters?.required) && definition.parameters.required.includes('path'))
check('tool output render is present', typeof definition?.output?.render === 'function')

const call = (name, args) => registered.get(name).execute(args, exec)
await writeFile(join(scratch, 'clicks.wav'), wavBytes(clicks))
await writeFile(join(scratch, 'silent.wav'), wavBytes(new Float32Array(SR)))

const toolResult = await call('audio_cues', { path: 'clicks.wav', out: 'cues.json' })
const written = JSON.parse(await readFile(join(scratch, 'cues.json'), 'utf8'))
console.log(`tool: ${toolResult.text}`)
check('tool finds the 4 clicks', toolResult.cueCount === 4 && toolResult.cues.length === 4, String(toolResult.cueCount))
check('tool reports onset/section split', toolResult.onsetCount === 4 && toolResult.sectionCount === 0, `${toolResult.onsetCount}/${toolResult.sectionCount}`)
check('tool keeps the analysis shape', Array.isArray(toolResult.cues) && Number.isFinite(toolResult.durationSeconds) && Array.isArray(toolResult.warnings), JSON.stringify(Object.keys(toolResult)))
check('tool writes the requested JSON', toolResult.relativePath === 'cues.json', String(toolResult.relativePath))
check('written JSON matches the returned cues', JSON.stringify(written.cues) === JSON.stringify(toolResult.cues) && written.sampleRate === toolResult.sampleRate)
check('written JSON is a drop-in analysis result', Array.isArray(written.warnings) && written.durationSeconds === toolResult.durationSeconds)
check('tool text is one line and names the source', !toolResult.text.includes('\n') && toolResult.text.includes('clicks.wav'))
check('tool text reports the cue count', /Detected 4 cue/.test(toolResult.text), toolResult.text)

const firstBytes = await readFile(join(scratch, 'cues.json'))
const secondRun = await call('audio_cues', { path: 'clicks.wav', out: 'cues.json' })
const secondBytes = await readFile(join(scratch, 'cues.json'))
check('tool result is deterministic', JSON.stringify(secondRun.cues) === JSON.stringify(toolResult.cues))
check('tool bytes are deterministic', firstBytes.equals(secondBytes))

const silentTool = await call('audio_cues', { path: 'silent.wav' })
console.log(`tool silent: ${silentTool.text}`)
check('silent file is an empty result, not an error', silentTool.cueCount === 0 && silentTool.warnings.length > 0)
check('silent tool writes no file when out is absent', silentTool.path === null)

let missing = null
try { await call('audio_cues', { path: 'nope.wav' }) } catch (error) { missing = error }
check('a missing file gives a readable error', missing !== null && /nope\.wav/.test(missing.message), missing?.message)
let guard = null
try { await call('audio_cues', {}) } catch (error) { guard = error }
check('the tool needs a path', guard !== null && /path/.test(guard.message), guard?.message)

/* ------------------------------------------------------------ done ----- */

await rm(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: audio_cues detects impacts and sections' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
