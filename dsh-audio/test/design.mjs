/**
 * Design-layer tests: every recipe renders, the layer math is additive, seeds
 * and variants behave, intensity is monotone, loop recipes loop, and a 3 s
 * design stays interactive.
 *
 * These are the checks a model cannot do by listening, so they are the ones
 * that decide whether `audio_design` output can be trusted at all.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { finalize, measure, renderPreset, toWavBytes } from '../lib/audio.js'
import { RECIPES, blendLayers, designSound, recipeCatalog } from '../lib/design.js'
import { filter, PRESETS } from '../lib/dsp.js'
import { registerDesignTools } from '../lib/tools-design.js'

const outDir = fileURLToPath(new URL('./out/tool/', import.meta.url))
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

const peakDb = (samples) => {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return peak > 0 ? 20 * Math.log10(peak) : -120
}
const allFinite = (samples) => {
  for (const sample of samples) if (!Number.isFinite(sample)) return false
  return true
}
const ids = Object.keys(RECIPES)
const metrics = new Map()

/* --------------------------------------------------------- every recipe -- */

console.log(`design recipes: ${ids.length}`)
console.log(
  'id'.padEnd(21), 'dur'.padStart(5), 'peak'.padStart(6), 'rms'.padStart(7),
  'crest'.padStart(6), 'centroid'.padStart(8), 'onsets'.padStart(6), 'layers'.padStart(6)
)
for (const id of ids) {
  const design = designSound({ recipe: id, seed: 1 })
  const m = measure(design.samples, design.sampleRate)
  metrics.set(id, m)
  const recipe = RECIPES[id]
  console.log(
    id.padEnd(21),
    m.durationSeconds.toFixed(2).padStart(5),
    m.peakDbfs.toFixed(1).padStart(6),
    m.rmsDbfs.toFixed(1).padStart(7),
    m.crestDb.toFixed(1).padStart(6),
    String(m.centroidHz).padStart(8),
    String(m.onsets).padStart(6),
    String(recipe.layers.length).padStart(6)
  )
  check(`${id} finite`, allFinite(design.samples))
  check(`${id} renders`, design.samples.length > 0 && design.durationSeconds > 0.02)
  check(`${id} matches recipe length`, Math.abs(design.durationSeconds - recipe.master.targetDurationMs / 1000) < 0.002)
  check(`${id} no clipping`, m.clipping === 0, `clipping=${m.clipping}`)
  check(`${id} no DC`, Math.abs(m.dcOffset) <= 0.02, `dc=${m.dcOffset}`)
  check(`${id} normalised`, Math.abs(m.peakDbfs + 1) < 0.15, `peak=${m.peakDbfs}`)
  check(`${id} not silent`, m.rmsDbfs > -45, `rms=${m.rmsDbfs}`)
}

/* ------------------------------------------------------------- catalog -- */

console.log('\n-- recipe catalogue --')
const catalog = recipeCatalog()
check('catalogue covers every recipe', catalog.length === ids.length, `${catalog.length}`)
check('catalogue keeps ids', catalog.every((entry, index) => entry.id === ids[index]))
check('at least 16 recipes', ids.length >= 16, `${ids.length}`)
const REQUIRED = [
  'door-slam-metal', 'door-close-soft', 'glass-break', 'wood-crack',
  'explosion-far', 'explosion-near', 'whoosh-into-impact',
  'sci-fi-charge', 'sci-fi-hum-loop', 'magic-sparkle', 'magic-dark',
  'water-drip', 'water-splash', 'footstep-gravel', 'cloth-rustle',
  'ui-success', 'ui-error', 'ui-hover', 'machinery-loop',
  'creature-scream', 'creature-growl', 'heartbeat', 'alarm-loop',
  // the creature family: its own test (test/creatures.mjs) checks the zoology,
  // this list only guarantees the ids cannot silently leave the vocabulary.
  'bird-chirp', 'bird-flock', 'insect-swarm', 'whale-song', 'wolf-howl',
  'frog-croak', 'hoofbeats', 'wing-flap', 'creature-breath', 'creature-hiss',
  'rodent-squeak', 'bat-echolocation'
]
const missing = REQUIRED.filter((id) => RECIPES[id] === undefined)
check('required vocabulary present', missing.length === 0, `missing ${missing.join(', ')}`)
check('every recipe has >= 2 layers', ids.every((id) => RECIPES[id].layers.length >= 2),
  ids.filter((id) => RECIPES[id].layers.length < 2).join(','))
check('every layer preset exists', ids.every((id) => RECIPES[id].layers.every((layer) => PRESETS[layer.preset] !== undefined)))
check('descriptions are unique', new Set(ids.map((id) => RECIPES[id].description)).size === ids.length)
check('catalogue is compact', catalog.every((entry) => entry.id.length > 0 && entry.description.length > 0 && entry.layers >= 2))

/* ----------------------------------------------------------- distinct -- */

console.log('\n-- designs are not all the same sound --')
const centroids = new Set(ids.map((id) => metrics.get(id).centroidHz))
const footprints = new Set(ids.map((id) => {
  const m = metrics.get(id)
  return `${m.centroidHz}|${m.crestDb}|${m.onsets}`
}))
const near = metrics.get('explosion-near')
const hover = metrics.get('ui-hover')
const far = metrics.get('explosion-far')
console.log(`distinct centroids: ${centroids.size}/${ids.length}  distinct centroid+crest+onset footprints: ${footprints.size}/${ids.length}`)
console.log(`explosion-near  crest ${near.crestDb.toFixed(1)} dB  centroid ${near.centroidHz} Hz  rms ${near.rmsDbfs} dBFS`)
console.log(`ui-hover        crest ${hover.crestDb.toFixed(1)} dB  centroid ${hover.centroidHz} Hz  rms ${hover.rmsDbfs} dBFS`)
console.log(`explosion-far   centroid ${far.centroidHz} Hz (darker than near: ${far.centroidHz < near.centroidHz})`)
check('centroids are distinct', centroids.size >= 20, `${centroids.size} unique`)
check('no two recipes share a footprint', footprints.size === ids.length, `${footprints.size}/${ids.length}`)
check('explosion-near crest is much lower than ui-hover',
  near.crestDb < hover.crestDb - 3, `${near.crestDb} vs ${hover.crestDb}`)
check('explosion-near centroid is much lower than ui-hover',
  near.centroidHz < hover.centroidHz * 0.5, `${near.centroidHz} vs ${hover.centroidHz}`)
check('distance darkens the explosion', far.centroidHz < near.centroidHz, `${far.centroidHz} vs ${near.centroidHz}`)
check('vocabulary spans the spectrum',
  Math.max(...ids.map((id) => metrics.get(id).centroidHz)) > 3000 &&
  Math.min(...ids.map((id) => metrics.get(id).centroidHz)) < 200,
  `min ${Math.min(...ids.map((id) => metrics.get(id).centroidHz))} max ${Math.max(...ids.map((id) => metrics.get(id).centroidHz))}`)
check('recipes are not copies by layer count only',
  new Set(ids.map((id) => RECIPES[id].layers.map((layer) => layer.preset).join('+'))).size >= ids.length - 2)

/* ---------------------------------------------------------- additive -- */

console.log('\n-- layering is additive --')
const params = { weight: 0.9, metallic: 0.4 }
const direct = renderPreset({ preset: 'impact', params, seed: 7 })
const oneLayer = blendLayers([{ preset: 'impact', params }], {
  seed: 7, peakDbfs: null, limiter: false, reverb: 0, dcBlock: false
})
let maxDiff = 0
const frames = Math.max(direct.samples.length, oneLayer.samples.length)
for (let i = 0; i < frames; i += 1) {
  maxDiff = Math.max(maxDiff, Math.abs((direct.samples[i] ?? 0) - (oneLayer.samples[i] ?? 0)))
}
const directPeak = peakDb(direct.samples)
const blendedPeak = peakDb(oneLayer.samples)
console.log(`1-layer sum vs renderPreset: frames ${direct.samples.length} / ${oneLayer.samples.length}, max |diff| ${maxDiff.toExponential(2)}, ` +
  `peak ${directPeak.toFixed(4)} vs ${blendedPeak.toFixed(4)} dBFS (${Math.abs(blendedPeak - directPeak).toFixed(4)} dB)`)
check('1-layer length equals the preset render', oneLayer.samples.length === direct.samples.length)
check('1-layer sum is sample-identical', maxDiff < 1e-6, `maxDiff=${maxDiff}`)
check('1-layer peak equals the preset render within 0.1 dB', Math.abs(blendedPeak - directPeak) <= 0.1,
  `${Math.abs(blendedPeak - directPeak).toFixed(4)} dB`)

const normalizedLone = blendLayers([{ preset: 'impact', params }], { seed: 7 })
finalize(direct.samples, direct.sampleRate, -1)
console.log(`normalised 1-layer design peak ${peakDb(normalizedLone.samples).toFixed(3)} dBFS vs finalised preset ` +
  `${peakDb(direct.samples).toFixed(3)} dBFS`)
check('normalised peaks agree within 0.1 dB',
  Math.abs(peakDb(normalizedLone.samples) - peakDb(direct.samples)) <= 0.1)

const twoSeed = 11
const twoLayers = blendLayers([
  { preset: 'impact', params: { weight: 0.8 }, gainDb: -3 },
  { preset: 'scrap', params: { density: 0.6 }, offsetMs: 20, gainDb: -9 }
], { seed: twoSeed, peakDbfs: null, limiter: false, reverb: 0, dcBlock: false })
const soloA = blendLayers([{ preset: 'impact', params: { weight: 0.8 } }], {
  seed: twoSeed, peakDbfs: null, limiter: false, reverb: 0, dcBlock: false
})
// The layer index is part of the seed derivation on purpose (two scrap layers
// must not land their grains on the same samples), so the sibling of layer 1 is
// rendered with the index-1 seed.
const soloB = blendLayers([{ preset: 'scrap', params: { density: 0.6 } }], {
  seed: twoSeed + 104729, peakDbfs: null, limiter: false, reverb: 0, dcBlock: false
})
const offsetFrames = Math.round(0.02 * twoLayers.sampleRate)
const expected = new Float32Array(twoLayers.samples.length)
for (let i = 0; i < expected.length; i += 1) {
  expected[i] = (soloA.samples[i] ?? 0) * Math.pow(10, -3 / 20) +
    (soloB.samples[i - offsetFrames] ?? 0) * Math.pow(10, -9 / 20)
}
let mixDiff = 0
for (let i = 0; i < expected.length; i += 1) mixDiff = Math.max(mixDiff, Math.abs(expected[i] - twoLayers.samples[i]))
console.log(`2-layer sum rebuilt by hand: ${twoLayers.layers.length} layers, max |diff| ${mixDiff.toExponential(2)}, duration ${twoLayers.durationSeconds.toFixed(3)}s`)
check('offsets and gains are a plain sum', mixDiff < 1e-6, `maxDiff=${mixDiff}`)
check('layer summary carries the arrangement',
  twoLayers.layers[1].offsetSeconds === 0.02 && twoLayers.layers[1].gainDb === -9,
  JSON.stringify(twoLayers.layers[1]))

const placed = blendLayers([
  { preset: 'tick' },
  { preset: 'chime', offsetMs: 300 }
], { seed: 1, peakDbfs: null, limiter: false, reverb: 0 })
console.log(`tick + chime 300 ms later: ${placed.durationSeconds.toFixed(3)}s (chime alone is ${PRESETS.chime.defaultDuration}s)`)
const windowRms = (samples, sampleRate, from, to) => {
  let sum = 0
  const start = Math.round(from * sampleRate)
  const end = Math.min(samples.length, Math.round(to * sampleRate))
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, end - start))
}
check('offsets extend the timeline', Math.abs(placed.durationSeconds - 1.4) < 0.01, `${placed.durationSeconds}`)
check('the late layer is actually placed late',
  windowRms(placed.samples, placed.sampleRate, 0.36, 0.46) > windowRms(placed.samples, placed.sampleRate, 0.2, 0.26) * 4,
  `late=${windowRms(placed.samples, placed.sampleRate, 0.36, 0.46).toFixed(4)} gap=${windowRms(placed.samples, placed.sampleRate, 0.2, 0.26).toFixed(4)}`)

/* ------------------------------------------------------- determinism -- */

console.log('\n-- determinism and variants --')
let bytePairs = 0
let variantPairs = 0
let worstVariant = { id: '', drift: 0 }
for (const id of ids) {
  const a = designSound({ recipe: id, seed: 3 })
  const b = designSound({ recipe: id, seed: 3 })
  const bytesA = toWavBytes(a.samples, a.sampleRate)
  const bytesB = toWavBytes(b.samples, b.sampleRate)
  if (bytesA.equals(bytesB) && a.samples.length === b.samples.length && a.samples.every((value, index) => value === b.samples[index])) bytePairs += 1
  else check(`${id} deterministic`, false)

  const variant = designSound({ recipe: id, seed: 3, variant: 2 })
  const bytesV = toWavBytes(variant.samples, variant.sampleRate)
  const baseMetrics = measure(a.samples, a.sampleRate)
  const variantMetrics = measure(variant.samples, variant.sampleRate)
  const drift = Math.abs(variantMetrics.centroidHz - baseMetrics.centroidHz) / Math.max(1, baseMetrics.centroidHz)
  if (drift > worstVariant.drift) worstVariant = { id, drift }
  if (!bytesA.equals(bytesV) && variant.recipe === a.recipe && variant.recipeSpec?.id === a.recipeSpec?.id && drift <= 0.25) variantPairs += 1
  else check(`${id} variant 2 is a sibling take`, false,
    `bytesDiffer=${!bytesA.equals(bytesV)} recipe=${variant.recipe} drift=${(drift * 100).toFixed(1)}%`)
}
console.log(`identical bytes: ${bytePairs}/${ids.length} recipes`)
console.log(`variant 2: ${variantPairs}/${ids.length} recipes differ in bytes, keep the recipe, centroid within +-25% ` +
  `(worst drift ${(worstVariant.drift * 100).toFixed(1)}% on ${worstVariant.id})`)
check('deterministic bytes for every recipe', bytePairs === ids.length, `${bytePairs}/${ids.length}`)
check('variant 2 changes the take, not the sound', variantPairs === ids.length, `${variantPairs}/${ids.length}`)
check('unknown recipe fails loudly', (() => {
  try { designSound({ recipe: 'no-such-sound' }); return false } catch { return true }
})())

/* ---------------------------------------------------------- intensity -- */

console.log('\n-- intensity is monotone --')
let monotoneCount = 0
for (const id of ids) {
  const soft = measure(designSound({ recipe: id, seed: 5, intensity: 0.2 }).samples, 44100)
  const hot = measure(designSound({ recipe: id, seed: 5, intensity: 1 }).samples, 44100)
  const delta = hot.rmsDbfs - soft.rmsDbfs
  if (delta >= 4) monotoneCount += 1
  else check(`${id} intensity raises RMS`, false, `soft=${soft.rmsDbfs} hot=${hot.rmsDbfs} delta=${delta.toFixed(2)}`)
}
console.log(`intensity 0.2 -> 1.0 raises RMS by >= 4 dB in ${monotoneCount}/${ids.length} recipes ` +
  `(spot: ${['door-slam-metal', 'ui-hover', 'explosion-far'].map((id) => {
    const soft = measure(designSound({ recipe: id, seed: 5, intensity: 0.2 }).samples, 44100)
    const hot = measure(designSound({ recipe: id, seed: 5, intensity: 1 }).samples, 44100)
    return `${id} ${(hot.rmsDbfs - soft.rmsDbfs).toFixed(1)} dB`
  }).join(', ')})`)
check('intensity 0.2 -> 1.0 raises RMS by >= 4 dB', monotoneCount === ids.length, `${monotoneCount}/${ids.length}`)
const softPeak = measure(designSound({ recipe: 'door-slam-metal', intensity: 0.2 }).samples, 44100)
const hotPeak = measure(designSound({ recipe: 'door-slam-metal', intensity: 1 }).samples, 44100)
check('intensity also lowers the peak target', softPeak.peakDbfs < hotPeak.peakDbfs - 6,
  `${softPeak.peakDbfs} vs ${hotPeak.peakDbfs}`)

// "Scales brightness" is checkable without ears: the share of energy above
// 6 kHz must drop when intensity comes down. Measuring a band is stabler than
// comparing centroid, which jumps between windows on sparse designs.
const airBand = (design) => {
  const high = filter(design.samples, design.sampleRate, () => 6000, () => 0.7, 'hp')
  let highEnergy = 0
  let totalEnergy = 0
  for (let i = 0; i < design.samples.length; i += 1) {
    highEnergy += high[i] * high[i]
    totalEnergy += design.samples[i] * design.samples[i]
  }
  return Math.sqrt(highEnergy / Math.max(1, totalEnergy))
}
let darker = 0
let darkestDb = 0
let brightestDb = 0
for (const id of ids) {
  const soft = airBand(designSound({ recipe: id, seed: 5, intensity: 0.2 }))
  const hot = airBand(designSound({ recipe: id, seed: 5, intensity: 1 }))
  const dB = 20 * Math.log10(soft / hot)
  darkestDb = Math.min(darkestDb, dB)
  brightestDb = Math.max(brightestDb, dB)
  if (soft < hot) darker += 1
}
console.log(`intensity 0.2 is darker than 1.0 in ${darker}/${ids.length} recipes ` +
  `(air-band change from ${darkestDb.toFixed(1)} dB to ${brightestDb.toFixed(1)} dB)`)
check('lower intensity rolls off the top end', darker >= ids.length - 2, `${darker}/${ids.length}`)

/* ----------------------------------------------------------------- loop -- */

console.log('\n-- loop recipes --')
const loopIds = ids.filter((id) => RECIPES[id].master?.loop === true)
console.log(`loop recipes: ${loopIds.join(', ')}`)
check('loop ids are named -loop', loopIds.every((id) => id.endsWith('-loop')), loopIds.join(','))
check('at least three loop recipes', loopIds.length >= 3, `${loopIds.length}`)
for (const id of loopIds) {
  const implicit = measure(designSound({ recipe: id }).samples, 44100)
  const explicit = measure(designSound({ recipe: id, loop: true }).samples, 44100)
  console.log(`${id.padEnd(20)} seam ${implicit.loopSeam.toFixed(1)} dB (implicit) / ${explicit.loopSeam.toFixed(1)} dB (loop: true) ` +
    `step ${implicit.loopStep} duration ${implicit.durationSeconds}s`)
  check(`${id} implicit loop seam`, implicit.loopSeam < 6, `seam=${implicit.loopSeam}`)
  check(`${id} explicit loop seam`, explicit.loopSeam < 6, `seam=${explicit.loopSeam}`)
}
const stretched = measure(designSound({ recipe: 'sci-fi-hum-loop', duration: 2 }).samples, 44100)
console.log(`sci-fi-hum-loop stretched to 2s: duration ${stretched.durationSeconds}s seam ${stretched.loopSeam} dB`)
check('loop bed stretches to the requested duration', Math.abs(stretched.durationSeconds - 2) < 0.002, `${stretched.durationSeconds}`)
check('stretched loop still loops', stretched.loopSeam < 6, `seam=${stretched.loopSeam}`)
const trimmed = designSound({ recipe: 'door-slam-metal', duration: 0.5 })
console.log(`door-slam-metal trimmed to 0.5s: duration ${(trimmed.samples.length / trimmed.sampleRate).toFixed(3)}s`)
check('duration override trims', Math.abs(trimmed.samples.length / trimmed.sampleRate - 0.5) < 0.002)

/* ---------------------------------------------------------- performance -- */

console.log('\n-- performance: a 3 s design --')
let worstMs = 0
let worstId = ''
for (const id of ids) {
  const started = performance.now()
  const design = designSound({ recipe: id, duration: 3, seed: 4 })
  const ms = performance.now() - started
  if (ms > worstMs) { worstMs = ms; worstId = id }
  console.log(`${id.padEnd(21)} ${ms.toFixed(1).padStart(6)} ms  ${design.samples.length} frames`)
  check(`${id} 3 s design under 400 ms`, ms < 400, `${ms.toFixed(1)} ms`)
}
console.log(`worst: ${worstId} ${worstMs.toFixed(1)} ms (budget 400 ms)`)

/* ---------------------------------------------------------------- tool -- */

console.log('\n-- audio_design tool --')
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => outDir } : undefined)
}
const exec = { agent: { session: { id: 'design-test' } } }
registerDesignTools(ctx)
check('tool registered', registered.has('audio_design'))
const tool = registered.get('audio_design')
check('tool exposes layer schema', tool.parameters.properties.layers.items.properties.preset.enum.length === Object.keys(PRESETS).length)
check('tool recipe enum matches recipes', tool.parameters.properties.recipe.enum.length === ids.length)

const toolResult = await tool.execute({ recipe: 'glass-break', out: 'glass.wav' }, exec)
const toolBytes = (await readFile(toolResult.path)).length
console.log(`tool wrote ${toolResult.relativePath} (${toolBytes} bytes, ${toolResult.metrics.durationSeconds}s, ` +
  `${toolResult.layers.length} layers, recipe ${toolResult.recipe})`)
console.log(toolResult.text.split('\n').map((line) => `  | ${line}`).join('\n'))
check('tool writes the file', toolBytes > 1000, `${toolBytes}`)
check('tool reports recipe', toolResult.recipe === 'glass-break')
check('tool reports every layer', toolResult.layers.length === RECIPES['glass-break'].layers.length)
check('tool text carries the layer breakdown', /layers \(\d+\):/.test(toolResult.text))
check('tool text carries the metrics', /peak .*dbfs/i.test(toolResult.text) && /centroid \d+ Hz/.test(toolResult.text))

const repeat = await tool.execute({ recipe: 'glass-break', out: 'glass-repeat.wav' }, exec)
const repeatBytes = await readFile(repeat.path)
check('tool output is byte-identical for the same request',
  Buffer.compare(await readFile(toolResult.path), repeatBytes) === 0)

const custom = await tool.execute({
  layers: [
    { preset: 'thud', params: { weight: 0.9, softness: 0.3 } },
    { preset: 'scrap', params: { tone: 0.8, density: 0.6 }, offsetMs: 25, gainDb: -6, filter: { mode: 'hp', cutoffHz: 400 } }
  ],
  seed: 2,
  variant: 1,
  intensity: 0.6,
  out: 'custom.wav'
}, exec)
console.log(`custom stack: ${custom.layers.map((layer) => `${layer.preset}@${Math.round(layer.offsetSeconds * 1000)}ms`).join(' ')} ` +
  `-> ${custom.relativePath} (${custom.durationSeconds}s, peak ${custom.metrics.peakDbfs})`)
check('custom layer stack renders', custom.recipe === 'custom' && custom.layers.length === 2 && custom.bytes > 1000)

const toolLoop = await tool.execute({ recipe: 'alarm-loop', out: 'alarm.wav' }, exec)
console.log(`tool loop: ${toolLoop.relativePath} seam ${toolLoop.metrics.loopSeam} dB, loop=${toolLoop.loop}`)
check('tool marks loop recipes', toolLoop.loop === true && toolLoop.metrics.loopSeam < 6)

const threw = await tool.execute({ recipe: 'not-a-recipe', out: 'nope.wav' }, exec).then(() => false, () => true)
check('tool rejects unknown recipes', threw)

console.log(failures === 0 ? '\nOK: layering engine behaves' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
