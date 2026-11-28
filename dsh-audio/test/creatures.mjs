/**
 * Creature / animal design tests.
 *
 * `audio_design` grew a zoological wing: twelve recipes that have to be
 * recognisable as something alive and, just as importantly, distinguishable from
 * each other. A synthesised animal is the easiest thing in this plugin to fake:
 * stack a growl on a hiss, normalise to -1 dBFS and every one of them measures
 * "loud, dark, no clipping". So the checks here are the ones that separate a
 * bird from a rodent without listening:
 *
 *   - the recipe is wired into the real table (`RECIPES`) and therefore into the
 *     `audio_design` recipe enum and its help text;
 *   - it renders finite, peak-normalised audio with no clipping and no DC;
 *   - the same seed reproduces the same bytes, a different seed does not;
 *   - intensity keeps working (louder + darker) and `variant` is a sibling take;
 *   - the twelve do *not* collapse into one sound: octave-band fingerprints are
 *     pairwise apart (or, for the two bird recipes that deliberately share a
 *     palette, the event rate and length are), and the register puts the big
 *     animals low and the small ones high;
 *   - the event rate matches the animal: four hoofbeats, three wingbeats, a
 *     frog pulse train, a continuous buzz, not "some noise with a reverb".
 *
 * Usage: node test/creatures.mjs
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { measure, renderPreset, toWavBytes } from '../lib/audio.js'
import { RECIPES, designSound, recipeCatalog } from '../lib/design.js'
import { filter, PRESETS } from '../lib/dsp.js'
import { registerDesignTools } from '../lib/tools-design.js'

const outDir = fileURLToPath(new URL('./out/creatures/', import.meta.url))
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

/* ------------------------------------------------------------- the family -- */

/**
 * The twelve recipes, ordered from "can fool an ear in a mix" to "evokes the
 * animal" — the same order the documentation uses.
 *
 * Per entry:
 *   centroid  brightness band the whole file has to fall in (Hz)
 *   peakHz    band the loudest partial has to fall in (Hz): it is what tells a
 *             squeak from a moan even when both are normalised
 *   f0        plausible fundamental (Hz); only asserted where the call really is
 *             periodic — a swarm or a hiss has no f0 and claiming one would be
 *             measuring the reverb
 *   events    { minGapMs, threshold, min, max } for the RMS-envelope counter
 */
const CREATURES = [
  { id: 'insect-swarm', centroid: [400, 1200], peakHz: [100, 900], f0: null, events: { minGapMs: 20, threshold: 0.2, min: 0, max: 1 } },
  { id: 'hoofbeats', centroid: [120, 500], peakHz: [100, 600], f0: [40, 200], events: { minGapMs: 70, threshold: 0.3, min: 4, max: 4 } },
  { id: 'wing-flap', centroid: [400, 2500], peakHz: [200, 3000], f0: null, events: { minGapMs: 500, threshold: 0.3, min: 3, max: 3 } },
  { id: 'creature-breath', centroid: [400, 2500], peakHz: [200, 3000], f0: null, events: { minGapMs: 900, threshold: 0.25, min: 2, max: 3 } },
  { id: 'creature-hiss', centroid: [2500, 9000], peakHz: [2000, 8000], f0: null, events: { minGapMs: 20, threshold: 0.2, min: 0, max: 2 } },
  { id: 'bird-chirp', centroid: [2500, 9000], peakHz: [2500, 8000], f0: null, events: { minGapMs: 70, threshold: 0.3, min: 2, max: 3 } },
  { id: 'bird-flock', centroid: [2500, 9000], peakHz: [2500, 8000], f0: null, events: { minGapMs: 70, threshold: 0.3, min: 4, max: 6 } },
  { id: 'whale-song', centroid: [80, 500], peakHz: [120, 400], f0: [100, 500], f0Search: [120, 600], events: { minGapMs: 1500, threshold: 0.25, min: 2, max: 3 } },
  { id: 'wolf-howl', centroid: [200, 1200], peakHz: [200, 1500], f0: [60, 400], events: null },
  { id: 'frog-croak', centroid: [60, 400], peakHz: [60, 500], f0: [40, 250], events: { minGapMs: 30, threshold: 0.3, min: 4, max: 9 } },
  { id: 'rodent-squeak', centroid: [4000, 12000], peakHz: [3000, 9000], f0: null, events: { minGapMs: 70, threshold: 0.3, min: 2, max: 3 } },
  { id: 'bat-echolocation', centroid: [4000, 12000], peakHz: [3000, 9000], f0: null, events: null }
]
const IDS = CREATURES.map((entry) => entry.id)

/* ---------------------------------------------------------------- helpers -- */

const peakDb = (samples) => {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return peak > 0 ? 20 * Math.log10(peak) : -120
}
const allFinite = (samples) => {
  for (const sample of samples) if (!Number.isFinite(sample)) return false
  return true
}

/**
 * Octave-band energy profile over the whole file, not one window: the loudest
 * 46 ms of a reverb tail is a coin toss, and a fingerprint that moves is not a
 * fingerprint. Bands are 63 Hz .. 8 kHz, normalised to unit length so the shape
 * is compared, not the level.
 */
const BAND_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
function bandProfile (design) {
  const energies = BAND_CENTERS.map((center) => {
    const band = filter(design.samples, design.sampleRate, () => center, () => 1.1, 'bp')
    let energy = 0
    for (let i = 0; i < band.length; i += 1) energy += band[i] * band[i]
    return Math.sqrt(energy / Math.max(1, band.length))
  })
  const norm = Math.hypot(...energies) || 1
  return energies.map((value) => value / norm)
}
function bandDistance (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return 1 - dot
}
/** Index of the octave band carrying the most energy. */
const registerOf = (profile) => profile.indexOf(Math.max(...profile))

/**
 * Fundamental estimate on the low-passed signal by normalised autocorrelation.
 * Returns 0 when no lag is periodic enough to believe: a hiss has no f0, and
 * reporting the reverb's favourite resonance as a pitch would be a lie.
 */
function estimateF0 (design, loHz = 40, hiHz = 700) {
  const low = filter(design.samples, design.sampleRate, () => hiHz, () => 0.7, 'lp')
  const size = Math.min(low.length, Math.round(design.sampleRate * 0.12))
  let bestStart = 0
  let bestEnergy = -1
  const hop = Math.max(1, Math.round(design.sampleRate * 0.02))
  for (let start = 0; start + size <= low.length; start += hop) {
    let energy = 0
    for (let i = 0; i < size; i += 1) energy += low[start + i] * low[start + i]
    if (energy > bestEnergy) { bestEnergy = energy; bestStart = start }
  }
  if (!(bestEnergy > 0)) return 0
  const minLag = Math.max(2, Math.floor(design.sampleRate / hiHz))
  const maxLag = Math.min(size - 2, Math.ceil(design.sampleRate / loHz))
  let zeroEnergy = 0
  for (let i = 0; i < size; i += 1) zeroEnergy += low[bestStart + i] * low[bestStart + i]
  if (zeroEnergy <= 0) return 0
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    let energy = 0
    for (let i = 0; i + lag < size; i += 1) {
      sum += low[bestStart + i] * low[bestStart + i + lag]
      energy += low[bestStart + i + lag] * low[bestStart + i + lag]
    }
    if (energy <= 0) continue
    const score = sum / Math.sqrt(zeroEnergy * energy)
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  if (bestScore < 0.45 || bestLag === 0) return 0
  return Math.round(design.sampleRate / bestLag)
}

/**
 * Frequency of the loudest partial in the loudest 46 ms window, on a
 * twelfth-octave grid. This is the register number that actually survives
 * normalisation: a squeak keeps its 6.8 kHz peak at any level.
 */
function peakPartial (design, minHz = 100, maxHz = 9000) {
  const size = 2048
  const frames = Math.max(1, Math.floor(design.samples.length / size))
  let bestStart = 0
  let bestEnergy = -1
  for (let f = 0; f < frames; f += 1) {
    let energy = 0
    for (let i = 0; i < size; i += 1) { const value = design.samples[f * size + i]; energy += value * value }
    if (energy > bestEnergy) { bestEnergy = energy; bestStart = f * size }
  }
  let best = { hz: 0, magnitude: 0 }
  const steps = Math.round(Math.log2(maxHz / minHz) * 12)
  for (let step = 0; step <= steps; step += 1) {
    const hz = minHz * Math.pow(2, step / 12)
    let real = 0
    let imag = 0
    for (let i = 0; i < size; i += 1) {
      const sample = (design.samples[bestStart + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)))
      const phase = 2 * Math.PI * hz * i / design.sampleRate
      real += sample * Math.cos(phase)
      imag += sample * Math.sin(phase)
    }
    const magnitude = Math.hypot(real, imag)
    if (magnitude > best.magnitude) best = { hz: Math.round(hz), magnitude }
  }
  return best.hz
}

/**
 * Count audible events from the RMS envelope: a pulse counts when the envelope
 * has decayed below half of a threshold and then rises back through it, with a
 * refractory gap so a reverb tail or a beating partial cannot count twice.
 * A continuous bed returns 0 or 1 — which is itself the answer for a swarm.
 */
function pulseCount (design, minGapMs = 70, threshold = 0.3) {
  const hop = Math.max(16, Math.round(design.sampleRate * 0.004))
  const envelope = []
  for (let start = 0; start + hop <= design.samples.length; start += hop) {
    let energy = 0
    for (let i = 0; i < hop; i += 1) energy += design.samples[start + i] * design.samples[start + i]
    envelope.push(Math.sqrt(energy / hop))
  }
  const peak = Math.max(...envelope, 1e-9)
  const minGap = Math.max(1, Math.round(minGapMs / 4))
  let count = 0
  let armed = true
  let last = -Infinity
  for (let i = 0; i < envelope.length; i += 1) {
    const level = envelope[i] / peak
    if (level < threshold * 0.5) { armed = true; continue }
    if (armed && level >= threshold && i - last >= minGap) {
      count += 1
      last = i
      armed = false
    }
  }
  return count
}

/** Energy above 6 kHz relative to the total, used to prove intensity darkens. */
function airRatio (design) {
  const high = filter(design.samples, design.sampleRate, () => 6000, () => 0.7, 'hp')
  let highEnergy = 0
  let totalEnergy = 0
  for (let i = 0; i < design.samples.length; i += 1) {
    highEnergy += high[i] * high[i]
    totalEnergy += design.samples[i] * design.samples[i]
  }
  return Math.sqrt(highEnergy / Math.max(1, totalEnergy))
}

/** Energy in one octave band relative to the whole file. */
function relativeBandEnergy (design, lowHz, highHz) {
  const band = filter(design.samples, design.sampleRate, () => Math.sqrt(lowHz * highHz), () => 0.7, 'bp')
  let bandEnergy = 0
  let totalEnergy = 0
  for (let i = 0; i < design.samples.length; i += 1) {
    bandEnergy += band[i] * band[i]
    totalEnergy += design.samples[i] * design.samples[i]
  }
  return Math.sqrt(bandEnergy / Math.max(1, totalEnergy))
}

/* --------------------------------------------------------- table wiring -- */

console.log('-- the twelve are part of the vocabulary --')
const catalogIds = new Set(recipeCatalog().map((entry) => entry.id))
for (const entry of CREATURES) {
  const recipe = RECIPES[entry.id]
  check(`${entry.id} exists in RECIPES`, recipe !== undefined)
  check(`${entry.id} is in the catalogue`, catalogIds.has(entry.id))
  if (recipe === undefined) continue
  check(`${entry.id} has >= 2 layers`, recipe.layers.length >= 2, `${recipe.layers.length}`)
  check(`${entry.id} is a one-shot`, recipe.master?.loop !== true)
  check(`${entry.id} every layer preset exists`,
    recipe.layers.every((layer) => PRESETS[layer.preset] !== undefined),
    recipe.layers.filter((layer) => PRESETS[layer.preset] === undefined).map((layer) => layer.preset).join(','))
  check(`${entry.id} has a target length`, Number.isFinite(recipe.master?.targetDurationMs))
}
check('every layer is inside the blend layer cap', Object.values(RECIPES)
  .every((recipe) => recipe.layers.length <= 32))
check('the twelve have unique descriptions',
  new Set(IDS.map((id) => RECIPES[id]?.description)).size === IDS.length)
check('the twelve are not all the same layer plan',
  new Set(IDS.map((id) => (RECIPES[id]?.layers ?? []).map((layer) => layer.preset).join('+'))).size === IDS.length)

/* --------------------------------------------------------------- renders -- */

console.log('\n-- every creature renders, and measures --')
const renders = new Map()
const profiles = new Map()
console.log(
  'id'.padEnd(20), 'dur'.padStart(5), 'peak'.padStart(6), 'rms'.padStart(7), 'crest'.padStart(6),
  'centroid'.padStart(8), 'peakHz'.padStart(7), 'f0'.padStart(5), 'band'.padStart(5),
  'events'.padStart(6), 'layers'.padStart(6)
)
for (const entry of CREATURES) {
  const design = designSound({ recipe: entry.id, seed: 1 })
  const metrics = measure(design.samples, design.sampleRate)
  const profile = bandProfile(design)
  const f0Search = entry.f0Search ?? [40, 700]
  const f0 = estimateF0(design, f0Search[0], f0Search[1])
  const peakHz = peakPartial(design)
  const register = registerOf(profile)
  const events = entry.events === null
    ? pulseCount(design)
    : pulseCount(design, entry.events.minGapMs, entry.events.threshold)
  renders.set(entry.id, { design, metrics, f0, peakHz, register, events, profile })
  profiles.set(entry.id, profile)
  const recipe = RECIPES[entry.id]
  console.log(
    entry.id.padEnd(20),
    metrics.durationSeconds.toFixed(2).padStart(5),
    metrics.peakDbfs.toFixed(1).padStart(6),
    metrics.rmsDbfs.toFixed(1).padStart(7),
    metrics.crestDb.toFixed(1).padStart(6),
    String(metrics.centroidHz).padStart(8),
    String(peakHz).padStart(7),
    String(f0 || '-').padStart(5),
    String(register).padStart(5),
    String(events).padStart(6),
    String(recipe.layers.length).padStart(6)
  )

  check(`${entry.id} finite`, allFinite(design.samples))
  check(`${entry.id} renders`, design.samples.length > 0 && design.durationSeconds > 0.02)
  check(`${entry.id} is as long as the recipe says`,
    Math.abs(design.durationSeconds - recipe.master.targetDurationMs / 1000) < 0.002,
    `${design.durationSeconds}`)
  check(`${entry.id} no clipping`, metrics.clipping === 0, `${metrics.clipping}`)
  check(`${entry.id} no DC`, Math.abs(metrics.dcOffset) <= 0.02, `${metrics.dcOffset}`)
  check(`${entry.id} normalised to -1 dBFS`, Math.abs(metrics.peakDbfs + 1) <= 0.15, `${metrics.peakDbfs}`)
  check(`${entry.id} is not silent`, metrics.rmsDbfs > -40, `${metrics.rmsDbfs}`)
  check(`${entry.id} is not a wall of sound`, metrics.crestDb > 8, `${metrics.crestDb}`)
  check(`${entry.id} brightness is in range`,
    metrics.centroidHz >= entry.centroid[0] && metrics.centroidHz <= entry.centroid[1],
    `${metrics.centroidHz} not in ${entry.centroid.join('..')}`)
  check(`${entry.id} loudest partial is in range`,
    peakHz >= entry.peakHz[0] && peakHz <= entry.peakHz[1],
    `${peakHz} not in ${entry.peakHz.join('..')}`)
  if (entry.f0 !== null) {
    check(`${entry.id} has a plausible fundamental`,
      f0 >= entry.f0[0] && f0 <= entry.f0[1], `${f0} not in ${entry.f0.join('..')}`)
  }
  if (entry.events !== null) {
    check(`${entry.id} event rate matches the animal`,
      events >= entry.events.min && events <= entry.events.max,
      `${events} not in ${entry.events.min}..${entry.events.max}`)
  }
}

/* ------------------------------------------- determinism and performance -- */

console.log('\n-- determinism, seeds, variants, intensity --')
let identicalSeeds = 0
let differentSeeds = 0
for (const entry of CREATURES) {
  const first = designSound({ recipe: entry.id, seed: 7 })
  const again = designSound({ recipe: entry.id, seed: 7 })
  const other = designSound({ recipe: entry.id, seed: 8 })
  if (toWavBytes(first.samples, first.sampleRate).equals(toWavBytes(again.samples, again.sampleRate))) identicalSeeds += 1
  else check(`${entry.id} same seed, same bytes`, false)
  if (!toWavBytes(first.samples, first.sampleRate).equals(toWavBytes(other.samples, other.sampleRate))) differentSeeds += 1
  else check(`${entry.id} different seed, different bytes`, false)
}
console.log(`identical bytes for the same seed: ${identicalSeeds}/${IDS.length}`)
console.log(`different bytes for a new seed: ${differentSeeds}/${IDS.length}`)
check('same seed is byte-identical for every creature', identicalSeeds === IDS.length, `${identicalSeeds}/${IDS.length}`)
check('a new seed is a new surface for every creature', differentSeeds === IDS.length, `${differentSeeds}/${IDS.length}`)

let louder = 0
let darker = 0
let siblingVariants = 0
for (const entry of CREATURES) {
  const soft = designSound({ recipe: entry.id, seed: 5, intensity: 0.2 })
  const hot = designSound({ recipe: entry.id, seed: 5, intensity: 1 })
  const softMetrics = measure(soft.samples, soft.sampleRate)
  const hotMetrics = measure(hot.samples, hot.sampleRate)
  if (hotMetrics.rmsDbfs - softMetrics.rmsDbfs >= 4) louder += 1
  else check(`${entry.id} intensity raises RMS`, false, `${softMetrics.rmsDbfs} -> ${hotMetrics.rmsDbfs}`)
  if (airRatio(soft) < airRatio(hot)) darker += 1
  else check(`${entry.id} lower intensity rolls off the top`, false,
    `${airRatio(soft).toFixed(5)} vs ${airRatio(hot).toFixed(5)}`)

  const base = designSound({ recipe: entry.id, seed: 3 })
  const variant = designSound({ recipe: entry.id, seed: 3, variant: 2 })
  const baseMetrics = measure(base.samples, base.sampleRate)
  const variantMetrics = measure(variant.samples, variant.sampleRate)
  const drift = Math.abs(variantMetrics.centroidHz - baseMetrics.centroidHz) / Math.max(1, baseMetrics.centroidHz)
  if (!toWavBytes(base.samples, base.sampleRate).equals(toWavBytes(variant.samples, variant.sampleRate)) &&
    variant.recipe === base.recipe && drift <= 0.25) siblingVariants += 1
  else check(`${entry.id} variant 2 is a sibling take`, false, `drift ${(drift * 100).toFixed(1)}%`)
}
console.log(`intensity 0.2 -> 1.0 is louder in ${louder}/${IDS.length} and darker in ${darker}/${IDS.length}`)
console.log(`variant 2 differs in bytes, keeps the recipe, centroid within +-25%: ${siblingVariants}/${IDS.length}`)
check('intensity is monotone for every creature', louder === IDS.length, `${louder}/${IDS.length}`)
check('intensity rolls off the air band for every creature', darker === IDS.length, `${darker}/${IDS.length}`)
check('variant is a sibling take for every creature', siblingVariants === IDS.length, `${siblingVariants}/${IDS.length}`)

let slowest = { id: '', ms: 0 }
for (const entry of CREATURES) {
  const started = performance.now()
  designSound({ recipe: entry.id, duration: 3, seed: 4 })
  const ms = performance.now() - started
  if (ms > slowest.ms) slowest = { id: entry.id, ms }
}
// Timing gate only: the 400 ms ceiling was measured on a quiet machine and has
// no room for a 2-vCPU CI runner sharing the box with the other matrix legs.
// 600 ms keeps "a creature is cheap to render" meaningful without turning host
// load into a red line; the audio properties asserted above are unchanged.
console.log(`slowest creature at 3 s: ${slowest.id} ${slowest.ms.toFixed(1)} ms (budget 600 ms)`)
check('every creature renders a 3 s design in under 600 ms', slowest.ms < 600, `${slowest.ms.toFixed(1)} ms`)

/* ------------------------------------------------------------- distinct -- */

console.log('\n-- the twelve are not one sound with twelve names --')
let closestSpectral = { a: '', b: '', distance: 1 }
let weakest = { a: '', b: '', spectral: 1, temporal: 1, crest: 0, margin: Infinity, okay: false }
for (let i = 0; i < CREATURES.length; i += 1) {
  for (let j = i + 1; j < CREATURES.length; j += 1) {
    const a = CREATURES[i].id
    const b = CREATURES[j].id
    const spectral = bandDistance(profiles.get(a), profiles.get(b))
    if (spectral < closestSpectral.distance) closestSpectral = { a, b, distance: spectral }
    const eventsA = pulseCount(renders.get(a).design, 25, 0.15)
    const eventsB = pulseCount(renders.get(b).design, 25, 0.15)
    const temporal = Math.abs(eventsA - eventsB) / Math.max(eventsA, eventsB, 1)
    const crestDelta = Math.abs(renders.get(a).metrics.crestDb - renders.get(b).metrics.crestDb) / 30
    const okay = spectral > 0.02 || temporal > 0.35 || crestDelta > 0.15
    // Margin over the three thresholds: the pair closest to looking like a duplicate.
    const margin = Math.max(spectral / 0.02, temporal / 0.35, crestDelta / 0.15)
    if (margin < weakest.margin) {
      weakest = { a, b, spectral, temporal, crest: crestDelta, margin, okay }
    }
    check(`${a} vs ${b} are different sounds`, okay,
      `spectral ${spectral.toFixed(4)}, event rate ${temporal.toFixed(2)}`)
  }
}
console.log(`closest pair in octave-band space: ${closestSpectral.a} / ${closestSpectral.b} ` +
  `(distance ${closestSpectral.distance.toFixed(3)})`)
console.log(`thinnest margin between two creatures: ${weakest.a} / ${weakest.b} ` +
  `(spectral ${weakest.spectral.toFixed(3)}, event rate ${weakest.temporal.toFixed(2)}, crest ${weakest.crest.toFixed(2)} -> ${weakest.margin.toFixed(1)}x the nearest threshold)`)

const centroids = IDS.map((id) => renders.get(id).metrics.centroidHz)
const centroidSpread = Math.max(...centroids) / Math.min(...centroids)
console.log(`centroid range: ${Math.min(...centroids)} Hz .. ${Math.max(...centroids)} Hz (x${centroidSpread.toFixed(1)})`)
check('the family spans at least two decades of brightness', centroidSpread >= 20, `x${centroidSpread.toFixed(1)}`)

const registerSet = new Set(IDS.map((id) => renders.get(id).register))
console.log(`distinct dominant octave bands: ${[...registerSet].sort((a, b) => a - b).map((index) => BAND_CENTERS[index]).join(', ')} Hz`)
check('the family uses at least four octaves', registerSet.size >= 4, `${registerSet.size}`)

// The register must follow body size: a whale and a frog sit below 250 Hz, a
// bat and a rodent above 4 kHz. If the table drifts, one of these flips.
const big = ['whale-song', 'frog-croak']
const small = ['rodent-squeak', 'bat-echolocation']
check('big animals are darker than small ones',
  Math.max(...big.map((id) => renders.get(id).metrics.centroidHz)) <
  Math.min(...small.map((id) => renders.get(id).metrics.centroidHz)) / 4,
  big.map((id) => `${id} ${renders.get(id).metrics.centroidHz}`).join(', ') + ' vs ' +
  small.map((id) => `${id} ${renders.get(id).metrics.centroidHz}`).join(', '))
check('the insect swarm is brighter than the whale',
  renders.get('insect-swarm').metrics.centroidHz > renders.get('whale-song').metrics.centroidHz * 2,
  `${renders.get('insect-swarm').metrics.centroidHz} vs ${renders.get('whale-song').metrics.centroidHz}`)

/* ------------------------------------------------------------ semantics -- */

console.log('\n-- the event structure says which animal it is --')
const chirp = renders.get('bird-chirp').metrics
const flock = renders.get('bird-flock').metrics
check('a flock is busier and longer than one bird',
  flock.onsets >= chirp.onsets && flock.durationSeconds > chirp.durationSeconds * 1.5,
  `${chirp.onsets}/${chirp.durationSeconds}s vs ${flock.onsets}/${flock.durationSeconds}s`)

const swarm = renders.get('insect-swarm')
const swarmModulation = (() => {
  // Wing buzz is amplitude modulation in the 20-70 Hz range: the short-window
  // RMS of the high band must wobble far more than a steady hiss would.
  const high = filter(swarm.design.samples, swarm.design.sampleRate, () => 2500, () => 0.7, 'hp')
  const hop = Math.round(swarm.design.sampleRate * 0.004)
  const envelope = []
  for (let start = 0; start + hop < high.length; start += hop) {
    let energy = 0
    for (let i = 0; i < hop; i += 1) energy += high[start + i] * high[start + i]
    envelope.push(Math.sqrt(energy / hop))
  }
  const mean = envelope.reduce((sum, value) => sum + value, 0) / Math.max(1, envelope.length)
  const deviation = Math.sqrt(envelope.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, envelope.length))
  return deviation / Math.max(1e-9, mean)
})()
console.log(`insect swarm high-band AM depth: ${(swarmModulation * 100).toFixed(0)}%`)
check('the swarm buzzes rather than hisses', swarmModulation > 0.15, `${swarmModulation.toFixed(3)}`)

const whale = renders.get('whale-song')
const tailFrom = whale.metrics.durationSeconds * 0.6
const tail = (() => {
  const start = Math.round(tailFrom * whale.design.sampleRate)
  let energy = 0
  for (let i = start; i < whale.design.samples.length; i += 1) energy += whale.design.samples[i] * whale.design.samples[i]
  return 20 * Math.log10(Math.sqrt(energy / Math.max(1, whale.design.samples.length - start)) + 1e-12)
})()
console.log(`whale tail (last ${(whale.metrics.durationSeconds - tailFrom).toFixed(1)} s) RMS: ${tail.toFixed(1)} dBFS`)
check('the whale still rings in its last third', tail > -40, `${tail.toFixed(1)} dBFS`)

check('the wolf howl is a held call, not a beat',
  renders.get('wolf-howl').metrics.onsets === 0,
  `${renders.get('wolf-howl').metrics.onsets}`)
check('creature breath has an inhale and an exhale',
  relativeBandEnergy(renders.get('creature-breath').design, 200, 900) > 0.15 &&
  renders.get('creature-breath').metrics.durationSeconds > 2,
  `${relativeBandEnergy(renders.get('creature-breath').design, 200, 900).toFixed(3)}`)
check('bat echolocation clicks in groups',
  renders.get('bat-echolocation').events >= 4, `${renders.get('bat-echolocation').events}`)

/* ----------------------------------------------------------------- tool -- */

console.log('\n-- audio_design exposes the whole family --')
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => outDir } : undefined)
}
const exec = { agent: { session: { id: 'creatures-test' } } }
registerDesignTools(ctx)
const tool = registered.get('audio_design')
check('audio_design is registered', tool !== undefined)
const enumIds = tool?.parameters?.properties?.recipe?.enum ?? []
const missingEnum = IDS.filter((id) => !enumIds.includes(id))
check('the recipe enum lists every creature', missingEnum.length === 0, missingEnum.join(','))
check('the recipe enum still matches RECIPES', enumIds.length === Object.keys(RECIPES).length,
  `${enumIds.length} vs ${Object.keys(RECIPES).length}`)
const help = tool?.parameters?.properties?.recipe?.description ?? ''
const missingHelp = IDS.filter((id) => !help.includes(id))
check('the recipe help text names every creature', missingHelp.length === 0, missingHelp.join(','))

const toolResult = await tool.execute({ recipe: 'wolf-howl', out: 'wolf.wav' }, exec)
const toolBytes = (await readFile(toolResult.path)).length
console.log(`tool wrote ${toolResult.relativePath} (${toolBytes} bytes, ${toolResult.metrics.durationSeconds}s)`)
console.log(toolResult.text.split('\n').map((line) => `  | ${line}`).join('\n'))
check('the tool renders a creature to a file', toolBytes > 2000, `${toolBytes}`)
check('the tool reports the creature recipe', toolResult.recipe === 'wolf-howl')
check('the tool reports its layers', toolResult.layers.length === RECIPES['wolf-howl'].layers.length)

const repeat = await tool.execute({ recipe: 'wolf-howl', out: 'wolf-repeat.wav' }, exec)
check('the tool output is byte-identical for the same request',
  Buffer.compare(await readFile(toolResult.path), await readFile(repeat.path)) === 0)

/* ------------------------------------------------------- whisper check -- */

// The one thing the numeric checks above cannot catch is a creature that is
// just "a sound". These are the simplest objective proxies for the animal: a
// small animal is thin (little energy below 250 Hz) and a large one is heavy.
const whaleLow = relativeBandEnergy(renders.get('whale-song').design, 40, 250)
const squeakLow = relativeBandEnergy(renders.get('rodent-squeak').design, 40, 250)
console.log(`\nlow-end share: whale ${(whaleLow * 100).toFixed(0)}% vs rodent ${(squeakLow * 100).toFixed(0)}%`)
check('the whale is heavy and the rodent is thin', whaleLow > squeakLow * 1.5,
  `${whaleLow.toFixed(3)} vs ${squeakLow.toFixed(3)}`)

// A creature layer is still a plain preset render: the recipes are arrangements,
// not a second synthesis engine.
const growl = renderPreset({ preset: 'creature-growl', params: { pitch: 1, roughness: 0.6, space: 0.4 }, seed: 1 })
check('a creature layer is still a plain preset render', growl.samples.length > 0 && peakDb(growl.samples) > -40)

console.log(failures === 0 ? `\nOK: the creature family behaves and is distinguishable (${checks} checks)` : `\nFAILED: ${failures}/${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
