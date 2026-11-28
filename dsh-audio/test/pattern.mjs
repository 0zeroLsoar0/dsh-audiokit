/**
 * `audio_pattern`: the placement and parameter bugs an event train is easy to
 * get wrong.
 *
 * Three of them were real:
 *   - `pitchFrom`/`pitchTo` were clamped to 0..1 regardless of the preset's own
 *     pitch domain, so a sweep on `impact`/`whoosh` (a 0.5..2 multiplier) was
 *     frozen at 1 and the parameters did nothing;
 *   - a train's last event landed exactly on the last sample of the span, so the
 *     trim removed it: `events` counted one more event than the file played;
 *   - `kind: 'riser'` ignored `params` entirely.
 *
 * `from` is pinned down too: it is the start of the *span*, not an offset into
 * the written file, so the output always starts at 0 s and lasts `to - from`.
 *
 * Run with the node from WORKERS.md:
 *   node test/pattern.mjs
 */

import { measure, renderPattern } from '../lib/audio.js'

const RATE = 44100

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` ${detail}`}`)
}

/** Samples in `[from, to)` seconds. */
function windowOf (samples, from, to) {
  const start = Math.max(0, Math.round(from * RATE))
  const end = Math.min(samples.length, Math.round(to * RATE))
  return samples.subarray(start, end)
}

function peakOf (samples) {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  return peak
}

function rmsOf (samples) {
  let sum = 0
  for (const value of samples) sum += value * value
  return Math.sqrt(sum / Math.max(1, samples.length))
}

const identical = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

console.log('pattern: pitch domain, last event, riser params, from semantics\n')

/* ------------------------------------------------ pitch really sweeps -- */

console.log('-- pitchFrom/pitchTo use the preset\'s own pitch domain --')
{
  // Two impacts over 3 s: the second event starts at span/count = 1.5 s.
  const common = { preset: 'impact', kind: 'train', from: 0, to: 3, count: 2, seed: 1 }
  const flat = renderPattern({ ...common, pitchFrom: 1, pitchTo: 1 })
  const flatNoArgs = renderPattern({ ...common })
  const swept = renderPattern({ ...common, pitchFrom: 1, pitchTo: 2 })

  const flatFirst = windowOf(flat.samples, 0, 0.3)
  const sweptFirst = windowOf(swept.samples, 0, 0.3)
  const flatSecond = windowOf(flat.samples, 1.5, 2.0)
  const sweptSecond = windowOf(swept.samples, 1.5, 2.0)
  const flatCentroid = measure(flatSecond, RATE).centroidHz
  const sweptCentroid = measure(sweptSecond, RATE).centroidHz

  console.log(`  flat event 2 centroid ${flatCentroid} Hz, swept-to-2 event 2 centroid ${sweptCentroid} Hz (ratio ${(sweptCentroid / flatCentroid).toFixed(2)})`)
  check('pitchFrom === pitchTo === 1 is the preset default', identical(flat.samples, flatNoArgs.samples))
  check('the first event is unchanged by the sweep', identical(flatFirst, sweptFirst))
  check('the last event actually changes pitch', !identical(flatSecond, sweptSecond))
  check('a swept-to-2 impact is brighter than the pitch-1 take', sweptCentroid > flatCentroid * 1.25,
    `${sweptCentroid} vs ${flatCentroid}`)

  // A tick's pitch knob is a 0..1 tone control, so the same 1..2 request must
  // clamp inside *that* domain instead of producing a silent or broken event.
  const tickSweep = renderPattern({ preset: 'tick', kind: 'train', from: 0, to: 1, count: 2, pitchFrom: 1, pitchTo: 2, seed: 1 })
  const tickTop = renderPattern({ preset: 'tick', kind: 'train', from: 0, to: 1, count: 2, pitchFrom: 1, pitchTo: 1, seed: 1 })
  console.log(`  tick (0..1 domain) clamps 1..2: events ${tickSweep.events}, peak ${peakOf(tickSweep.samples).toFixed(3)}`)
  check('a 0..1-domain preset still renders both events', tickSweep.events === 2 && peakOf(tickSweep.samples) > 0.1)
  check('the clamped 1..2 tick sweep equals the 1..1 take', identical(tickSweep.samples, tickTop.samples))
}

/* --------------------------------------------------- last event audible -- */

console.log('\n-- a train\'s last event is inside the file --')
{
  const train = renderPattern({ preset: 'impact', kind: 'train', from: 0, to: 2, count: 2, seed: 3 })
  const globalPeak = peakOf(train.samples)
  const lastStart = 2 / 2 // span / count
  const lastPeak = peakOf(windowOf(train.samples, lastStart, lastStart + 0.4))
  const onsets = measure(train.samples, RATE).onsets
  console.log(`  events ${train.events}, duration ${train.durationSeconds}s, global peak ${globalPeak.toFixed(3)}, last-event window ${lastStart}s peak ${lastPeak.toFixed(3)}, onsets ${onsets}`)
  check('two requested events are reported', train.events === 2, String(train.events))
  check('the file is exactly the span', Math.abs(train.durationSeconds - 2) < 0.001, String(train.durationSeconds))
  check('the last event is loud in the file', lastPeak > globalPeak * 0.5, `${lastPeak} vs ${globalPeak}`)
  check('the detector hears both events', onsets >= 2, String(onsets))

  // An `every`-derived train too: 2 events over 2 s with every=1.
  const everyTrain = renderPattern({ preset: 'impact', kind: 'train', from: 0, to: 2, every: 1, seed: 3 })
  const everyLast = peakOf(windowOf(everyTrain.samples, 1, 1.4))
  console.log(`  every=1 train: events ${everyTrain.events}, last window peak ${everyLast.toFixed(3)}`)
  check('an every-derived train plays its last event', everyTrain.events === 2 && everyLast > peakOf(everyTrain.samples) * 0.5)

  // One event has to sit at the start, not at the end of the span.
  const one = renderPattern({ preset: 'tick', kind: 'train', from: 0, to: 1, count: 1, seed: 1 })
  check('a single-event train starts at 0 s', peakOf(windowOf(one.samples, 0, 0.02)) > 0.1, String(peakOf(windowOf(one.samples, 0, 0.02))))
  check('a single-event train still counts one event', one.events === 1)

  // Scatter keeps its exact count and stays inside the span.
  const scatter = renderPattern({ preset: 'tick', kind: 'scatter', from: 0, to: 2, count: 8, seed: 5 })
  const scatterOnsets = measure(scatter.samples, RATE).onsets
  console.log(`  scatter count 8 -> events ${scatter.events}, onsets ${scatterOnsets}`)
  check('scatter renders the requested number of events', scatter.events === 8)
  check('scatter events are audible', scatterOnsets >= 6, String(scatterOnsets))
}

/* ------------------------------------------------------- riser accepts params -- */

console.log('\n-- kind: riser accepts params --')
{
  const plain = renderPattern({ preset: 'riser', kind: 'riser', from: 0, to: 1, seed: 1 })
  const shaped = renderPattern({ preset: 'riser', kind: 'riser', from: 0, to: 1, params: { tone: 1, tension: 0.1 }, seed: 1 })
  const shapedAgain = renderPattern({ preset: 'riser', kind: 'riser', from: 0, to: 1, params: { tone: 1, tension: 0.1 }, seed: 1 })
  const plainCentroid = measure(plain.samples, RATE).centroidHz
  const shapedCentroid = measure(shaped.samples, RATE).centroidHz
  console.log(`  default riser centroid ${plainCentroid} Hz, tone=1 riser centroid ${shapedCentroid} Hz, events ${shaped.events}`)
  check('params change the riser', !identical(plain.samples, shaped.samples))
  check('the riser params are deterministic', identical(shaped.samples, shapedAgain.samples))
  check('params.tone brightens the riser', shapedCentroid > plainCentroid, `${shapedCentroid} vs ${plainCentroid}`)
  check('a riser is one continuous event', plain.events === 1 && shaped.events === 1)
  check('the riser fills the span', Math.abs(shaped.durationSeconds - 1) < 0.001, String(shaped.durationSeconds))
}

/* ---------------------------------------------------------- from semantics -- */

console.log('\n-- from is the span start; the file always starts at 0 s --')
{
  const shifted = renderPattern({ preset: 'tick', kind: 'train', from: 0.5, to: 1.5, every: 0.25, seed: 1 })
  const fromZero = renderPattern({ preset: 'tick', kind: 'train', from: 0, to: 1, every: 0.25, seed: 1 })
  console.log(`  from 0.5..1.5: duration ${shifted.durationSeconds}s, events ${shifted.events}, first 20 ms peak ${peakOf(windowOf(shifted.samples, 0, 0.02)).toFixed(3)}`)
  check('the file lasts to - from, whatever from is', Math.abs(shifted.durationSeconds - 1) < 0.001, String(shifted.durationSeconds))
  check('the first event is at 0 s, not at from', peakOf(windowOf(shifted.samples, 0, 0.02)) > 0.1)
  check('the same span gives the same events', shifted.events === fromZero.events, `${shifted.events} vs ${fromZero.events}`)
  const ratio = rmsOf(shifted.samples) / Math.max(rmsOf(fromZero.samples), 1e-9)
  check('the shifted window sounds the same as the same span from 0', Math.abs(ratio - 1) < 1e-6, String(ratio))
  check('the returned spec records the span', shifted.spec.from === 0.5 && shifted.spec.to === 1.5,
    `${shifted.spec.from}..${shifted.spec.to}`)
}

/* ----------------------------------------------------------- determinism -- */

console.log('\n-- the same request is byte-identical --')
{
  const spec = { preset: 'scrap', kind: 'train', from: 0, to: 1.5, every: 0.12, curve: 'accelerando', jitter: 0.3, accentEvery: 4, pitchFrom: 0.3, pitchTo: 0.9, seed: 11, sampleRate: 22050 }
  const first = renderPattern(spec)
  const second = renderPattern(spec)
  check('identical requests give identical samples', identical(first.samples, second.samples))
  check('identical requests give identical event counts', first.events === second.events)
  check('the sample rate is honoured', first.sampleRate === 22050)
}

console.log(failures === 0 ? `\nOK: all ${checks} pattern checks passed` : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
