/**
 * Extra-preset tests.
 *
 * `smoke.mjs` proves the nine core presets; this file proves the second
 * vocabulary: every extra preset renders, is deterministic, stays inside the
 * level rules, loops when it claims to, and survives a pattern and a fresh
 * process. The measurements are printed because the numbers are how a sound is
 * judged without listening to it.
 */

import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Imported before the rest on purpose: registration must be a side effect of
// importing the module, not of the test remembering to call a function.
import { EXTRA_PRESETS, LOOPABLE_PRESETS, registerExtraPresets } from '../lib/presets-extra.js'
import { PRESETS, makeRng, presetCatalog, resolveParams } from '../lib/dsp.js'
import { finalize, measure, renderPattern, renderPreset } from '../lib/audio.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SAMPLE_RATE = 44100
/** The first vocabulary, from `lib/dsp.js`. An id collision would silently replace a core preset. */
const CORE_PRESETS = ['impact', 'whoosh', 'tick', 'chime', 'riser', 'zap', 'thud', 'scrap', 'texture']

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return true
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : `  ${detail}`}`)
  return false
}

/** Stable integer hash of a sample stream; used to compare two processes. */
function sampleHash (samples) {
  let hash = 0x811C9DC5
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    hash = Math.imul(hash ^ (Math.round(value * 32767) >>> 0), 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}:${samples.length}`
}

function finite (samples) {
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) return false
  }
  return true
}

function identical (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

const names = Object.keys(EXTRA_PRESETS)
const registered = Object.keys(PRESETS)
console.log(`extra presets: ${names.length}  registered total: ${registered.length}  sample rate: ${SAMPLE_RATE} Hz`)
console.log(`loopable: ${LOOPABLE_PRESETS.join(', ')}\n`)

/* ------------------------------------------------------------- registration -- */

console.log('-- registration --')
check('at least 24 presets', names.length >= 24, `got ${names.length}`)
for (const name of names) {
  check(`${name} registered`, PRESETS[name] === EXTRA_PRESETS[name], 'PRESETS entry is not the module definition')
  check(`${name} is a new id`, !CORE_PRESETS.includes(name), 'collides with a core preset')
}
const catalog = presetCatalog()
check('catalog sees the extras', names.every((name) => catalog.some((entry) => entry.name === name)))

for (const [name, spec] of Object.entries(EXTRA_PRESETS)) {
  check(`${name} description`, typeof spec.description === 'string' && spec.description.length > 20)
  check(`${name} duration`, Number.isFinite(spec.defaultDuration) && spec.defaultDuration > 0.05 && spec.defaultDuration <= 10)
  check(`${name} defaults`, spec.defaults !== null && typeof spec.defaults === 'object', String(spec.defaults))
  check(`${name} render`, typeof spec.render === 'function')
  for (const [key, range] of Object.entries(spec.params ?? {})) {
    check(`${name}.${key} range`, Array.isArray(range) && range.length === 2 && range[0] < range[1], JSON.stringify(range))
    const value = spec.defaults[key]
    check(`${name}.${key} default in range`, typeof value === 'number' && value >= range[0] && value <= range[1], `default=${value}`)
  }
}

/* ------------------------------------------------------------------- render -- */

console.log('\n-- render --')
// Note on the onset column: `measure` uses a 5 ms energy hop, which is shorter
// than one period of sub-bass content, so low beds report extra "onsets" that
// are waveform shape rather than events (the kernel's `texture` hum does the
// same). It is a metric artefact, not a sound problem.
const renderStarted = process.hrtime.bigint()
for (const name of names) {
  const spec = EXTRA_PRESETS[name]
  const first = renderPreset({ preset: name, seed: 7, sampleRate: SAMPLE_RATE })
  finalize(first.samples, first.sampleRate)
  const metrics = measure(first.samples, first.sampleRate)

  // A loopable bed is checked twice: the one-shot take and the loop take.
  let seam
  if (LOOPABLE_PRESETS.includes(name)) {
    const looped = renderPreset({ preset: name, seed: 3, duration: spec.defaultDuration, loop: true, sampleRate: SAMPLE_RATE })
    finalize(looped.samples, looped.sampleRate)
    const loopMetrics = measure(looped.samples, looped.sampleRate)
    seam = loopMetrics.loopSeam
    check(`${name} loop length`, Math.abs(loopMetrics.durationSeconds - spec.defaultDuration) < 0.01, `${loopMetrics.durationSeconds}s`)
    check(`${name} loop seam < 6 dB`, loopMetrics.loopSeam < 6, `seam=${loopMetrics.loopSeam} dB`)
    check(`${name} loop not silent`, loopMetrics.rmsDbfs > -60, `rms=${loopMetrics.rmsDbfs} dB`)
    // The seam must not depend on the render length: a bed that loops at 2 s
    // has to loop at 3 s too, otherwise the quantisation is length-specific.
    const longer = renderPreset({ preset: name, seed: 3, duration: 3, loop: true, sampleRate: SAMPLE_RATE })
    finalize(longer.samples, longer.sampleRate)
    const longerMetrics = measure(longer.samples, longer.sampleRate)
    check(`${name} loop seam at 3 s`, longerMetrics.loopSeam < 6, `seam=${longerMetrics.loopSeam} dB`)
  }

  console.log(
    `${name.padEnd(17)} ${String(metrics.durationSeconds).padStart(5)}s  peak ${String(metrics.peakDbfs).padStart(7)} dB  ` +
    `rms ${String(metrics.rmsDbfs).padStart(7)} dB  crest ${String(metrics.crestDb).padStart(5)}  ` +
    `centroid ${String(metrics.centroidHz).padStart(5)} Hz  onsets ${String(metrics.onsets).padStart(2)}` +
    (seam === undefined ? '' : `  loop seam ${seam.toFixed(1)} dB`)
  )

  check(`${name} finite`, finite(first.samples))
  check(`${name} peak <= 0 dBFS`, metrics.peakDbfs <= 0, `peak=${metrics.peakDbfs} dB`)
  check(`${name} no clipping`, metrics.clipping === 0, `${metrics.clipping} samples`)
  check(`${name} not silent`, metrics.peakDbfs > -50, `peak=${metrics.peakDbfs} dB`)
  check(`${name} duration`, Math.abs(metrics.durationSeconds - spec.defaultDuration) < 0.02, `${metrics.durationSeconds}s`)

  const second = renderPreset({ preset: name, seed: 7, sampleRate: SAMPLE_RATE })
  finalize(second.samples, second.sampleRate)
  check(`${name} deterministic samples`, identical(first.samples, second.samples))
  // 16-bit WAV bytes are not compared: `encodeWav` adds random dither by
  // design, so the sample stream is the layer that owns determinism.
}
const renderMs = Number(process.hrtime.bigint() - renderStarted) / 1e6
console.log(`total render time: ${renderMs.toFixed(0)} ms for ${names.length} presets (two takes each + loop takes)`)
console.log(`  first-take only:  ${(renderMs / 2).toFixed(0)} ms`)
check('total render time under 5 s', renderMs < 5000, `${renderMs.toFixed(0)} ms`)

/* ------------------------------------------------------------------- knobs -- */

console.log('\n-- knob extremes --')
for (const [name, spec] of Object.entries(EXTRA_PRESETS)) {
  for (const edge of ['min', 'max']) {
    const params = {}
    for (const [key, range] of Object.entries(spec.params ?? {})) params[key] = edge === 'min' ? range[0] : range[1]
    const result = renderPreset({ preset: name, params, seed: 11, sampleRate: SAMPLE_RATE })
    finalize(result.samples, result.sampleRate)
    const edgeMetrics = measure(result.samples, result.sampleRate)
    check(`${name} ${edge} knobs finite`, finite(result.samples))
    check(`${name} ${edge} knobs no clipping`, edgeMetrics.clipping === 0, `${edgeMetrics.clipping} samples`)
    check(`${name} ${edge} knobs audible`, edgeMetrics.peakDbfs > -50, `peak=${edgeMetrics.peakDbfs} dB`)
  }
}

/* ------------------------------------------------------------- character --- */

// Shape guards. These are deliberately loose: they catch a preset that has
// drifted into the wrong *kind* of sound (a footstep that stopped being
// percussive, an alarm with one beep), not a matter of taste.
console.log('\n-- character --')
const character = {
  'footstep-gravel': (m) => m.crestDb > 10 && m.onsets >= 1,
  'footstep-wood': (m) => m.crestDb > 10 && m.onsets >= 1,
  'footstep-water': (m) => m.crestDb > 10 && m.centroidHz > 300,
  'door-open': (m) => m.crestDb > 8 && m.onsets >= 2,
  'door-close': (m) => m.crestDb > 12,
  drawer: (m) => m.crestDb > 10,
  'switch-click': (m) => m.crestDb > 14 && m.centroidHz > 600,
  cloth: (m) => m.crestDb < 14 && m.centroidHz > 900,
  paper: (m) => m.centroidHz > 4000,
  'water-drip': (m) => m.centroidHz > 300 && m.crestDb > 10,
  'water-splash': (m) => m.centroidHz > 700,
  bubble: (m) => m.crestDb > 10,
  'wind-gust': (m) => m.centroidHz > 900,
  'breath-inhale': (m) => m.centroidHz > 1500,
  servo: (m) => m.crestDb < 12 && m.centroidHz > 400,
  'motor-start': (m) => m.onsets >= 2,
  'motor-loop': (m) => m.crestDb < 14,
  'alarm-beep': (m) => m.onsets >= 3,
  'alarm-siren': (m) => m.crestDb < 12,
  'hud-tick': (m) => m.centroidHz > 1500 && m.crestDb > 10,
  'energy-charge': (m) => m.crestDb < 14,
  'heartbeat-double': (m) => m.onsets >= 2 && m.centroidHz < 200,
  'creature-growl': (m) => m.centroidHz < 400,
  'insect-buzz': (m) => m.crestDb < 12,
  'bone-crack': (m) => m.crestDb > 15,
  'bass-drop': (m) => m.centroidHz < 400,
  'riser-short': (m) => m.crestDb > 10,
  'bell-toll': (m) => m.crestDb > 12,
  'choir-pad': (m) => m.crestDb < 14
}
for (const name of names) {
  const spec = EXTRA_PRESETS[name]
  const result = renderPreset({ preset: name, seed: 7, sampleRate: SAMPLE_RATE })
  finalize(result.samples, result.sampleRate)
  const metrics = measure(result.samples, result.sampleRate)
  const expectation = character[name]
  check(`${name} character`, expectation !== undefined && expectation(metrics), `crest=${metrics.crestDb} centroid=${metrics.centroidHz} onsets=${metrics.onsets}`)
}
check('character table covers every preset', names.every((name) => character[name] !== undefined))

/* ------------------------------------------------------------ integration -- */

console.log('\n-- pattern integration --')
const ticks = renderPattern({ preset: 'hud-tick', kind: 'train', from: 0, to: 1, every: 0.1, seed: 2 })
const tickMetrics = measure(ticks.samples, ticks.sampleRate)
console.log(`hud-tick train events=${ticks.events} onsets=${tickMetrics.onsets} duration=${tickMetrics.durationSeconds}s`)
check('pattern events', ticks.events === 10, `events=${ticks.events}`)
check('pattern onsets', tickMetrics.onsets >= 5, `onsets=${tickMetrics.onsets}`)
check('pattern finite', finite(ticks.samples))

const steps = renderPattern({ preset: 'footstep-gravel', kind: 'train', from: 0, to: 2, count: 4, seed: 3 })
const stepMetrics = measure(steps.samples, steps.sampleRate)
console.log(`footstep-gravel count=4 events=${steps.events} onsets=${stepMetrics.onsets} duration=${stepMetrics.durationSeconds}s`)
check('footstep pattern count', steps.events === 4, `events=${steps.events}`)
check('footstep pattern onsets', stepMetrics.onsets >= 3, `onsets=${stepMetrics.onsets}`)

/* -------------------------------------------------------- explicit registry -- */

console.log('\n-- explicit registration --')
const before = renderPreset({ preset: 'servo', seed: 5, sampleRate: SAMPLE_RATE })
finalize(before.samples, before.sampleRate)
const returned = registerExtraPresets()
check('register returns the definitions', returned === EXTRA_PRESETS)
const after = renderPreset({ preset: 'servo', seed: 5, sampleRate: SAMPLE_RATE })
finalize(after.samples, after.sampleRate)
check('explicit call changes nothing', identical(before.samples, after.samples))
check('still one entry per id', names.every((name) => PRESETS[name] === EXTRA_PRESETS[name]))

/* ------------------------------------------------------------ standalone --- */

// A second process imports only `lib/presets-extra.js` (plus the kernel it
// depends on) and renders every preset straight through `spec.render`: no
// `audio.js`, no tools, no registration helper. The hashes must match this
// process, which proves the module is importable alone and that the explicit
// call is not what produces the sound.
console.log('\n-- standalone import (child process) --')
const dspUrl = pathToFileURL(`${root}/lib/dsp.js`).href
const presetsUrl = pathToFileURL(`${root}/lib/presets-extra.js`).href
const childScript = `
const { makeRng, resolveParams } = await import(${JSON.stringify(dspUrl)})
const { EXTRA_PRESETS, LOOPABLE_PRESETS, registerExtraPresets } = await import(${JSON.stringify(presetsUrl)})
const sampleHash = ${sampleHash.toString()}
const rendered = {}
for (const name of Object.keys(EXTRA_PRESETS)) {
  const frames = Math.max(16, Math.round(EXTRA_PRESETS[name].defaultDuration * 48000))
  const params = resolveParams(name, {})
  const first = sampleHash(EXTRA_PRESETS[name].render(params, frames, 48000, makeRng(101)))
  registerExtraPresets()
  const second = sampleHash(EXTRA_PRESETS[name].render(params, frames, 48000, makeRng(101)))
  rendered[name] = { first, second, registered: EXTRA_PRESETS[name] === (await import(${JSON.stringify(dspUrl)})).PRESETS[name] }
}
console.log(JSON.stringify({ rendered, loopable: LOOPABLE_PRESETS }))
`
const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], { encoding: 'utf8' })
if (child.status !== 0) {
  check('standalone child exited 0', false, String(child.stderr).trim().slice(0, 400))
} else {
  const parsed = JSON.parse(child.stdout.trim())
  check('standalone child sees the extras', Object.keys(parsed.rendered).length === names.length, `${Object.keys(parsed.rendered).length} ids`)
  check('standalone loopable list', parsed.loopable.join(',') === LOOPABLE_PRESETS.join(','))
  let matched = 0
  for (const name of names) {
    const frames = Math.max(16, Math.round(EXTRA_PRESETS[name].defaultDuration * 48000))
    const params = resolveParams(name, {})
    const local = sampleHash(EXTRA_PRESETS[name].render(params, frames, 48000, makeRng(101)))
    if (parsed.rendered[name]?.first === local) matched += 1
    check(`${name} standalone hash`, parsed.rendered[name]?.first === local, `child=${parsed.rendered[name]?.first} local=${local}`)
    check(`${name} standalone registered`, parsed.rendered[name]?.registered === true)
    check(`${name} standalone explicit call identical`, parsed.rendered[name]?.first === parsed.rendered[name]?.second)
  }
  console.log(`standalone child: ${matched}/${names.length} sample hashes match this process`)
}

console.log(failures === 0 ? '\nOK: all checks passed' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
