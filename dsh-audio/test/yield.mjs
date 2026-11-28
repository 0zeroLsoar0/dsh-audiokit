/**
 * Cooperative-yield tests: the long render paths must stay byte-identical while
 * they stop holding the event loop.
 *
 * What this proves:
 *
 * - the asynchronous render variants hand the host back between blocks: a 10 ms
 *   interval and a self-rescheduling `setImmediate` both run many times during a
 *   render that used to be one uninterruptible call (`renderScore`), while the
 *   synchronous call on the same cue fires them at most once;
 * - `renderScoreAsync` / `masterChainAsync` / `renderBusAsync` produce exactly the
 *   bytes their synchronous twins produce (SHA-256 of every sample buffer, plus a
 *   digest of the reports, which are part of the contract);
 * - determinism survives: the same seed gives the same score and the same audio
 *   on every call, a different seed still gives different audio, and calling the
 *   async variant twice is byte-stable;
 * - the yielding machinery is not a slowdown: the async variant costs no more
 *   than 15 % over the synchronous one on the same fixture (compose, master,
 *   bus), which is the budget this change was allowed. The synchronous path is
 *   unaffected in structure (same blocks, cooperation points ignored), and
 *   `test/perf.mjs` still holds it to its own absolute budget.
 *
 * Run with the node from WORKERS.md:
 *   node test/yield.mjs
 */

import { createHash } from 'node:crypto'
import { composeScore, renderScore, renderScoreAsync } from '../lib/compose.js'
import { masterChain, masterChainAsync } from '../lib/master.js'
import { renderBus, renderBusAsync } from '../lib/bus.js'

const RATE = 44100
const RATE_48 = 48000

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` - ${detail}`}`)
  return undefined
}

/* ------------------------------------------------------------------ utils -- */

const sha = (data) => createHash('sha256').update(data).digest('hex')
const shaSamples = (samples) => sha(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
const shaChannels = (channels) => channels.map((channel) => shaSamples(channel)).join(',')

/**
 * Digest of a render result that includes the samples and the reported numbers.
 *
 * The report is hashed as a sorted-key string, so a report field that changed
 * value (a delta, a rounding, a channel peak) fails the same way a changed
 * sample would: the numbers are what the agent acts on.
 */
function resultDigest (result) {
  const channels = Array.isArray(result.samples) ? result.samples : [result.samples]
  const meta = {}
  for (const [key, value] of Object.entries(result)) {
    if (key === 'samples') continue
    meta[key] = value
  }
  return `${shaChannels(channels)}|${sha(JSON.stringify(meta, Object.keys(meta).sort()))}`
}

/** A deterministic test signal: two partials plus a small seeded noise floor. */
function probe (frames, rate, hz, seed) {
  const samples = new Float32Array(frames)
  let phase = 0
  let state = seed >>> 0
  for (let index = 0; index < frames; index += 1) {
    phase += (2 * Math.PI * hz) / rate
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    samples[index] = 0.3 * Math.sin(phase) + 0.11 * Math.sin(phase * 2.7) + ((state / 4294967296) - 0.5) * 0.04
  }
  return samples
}

/**
 * Run `body` while a 10 ms interval and a self-rescheduling immediate count how
 * often they get the CPU back.
 *
 * The immediate chain is rescheduled from inside its own callback, so it counts
 * real event-loop turns, not just one delivery at the start.
 */
async function measureEventLoop (body) {
  let ticks = 0
  let immediates = 0
  let live = true
  const timer = setInterval(() => {
    ticks += 1
  }, 10)
  const pump = () => {
    if (!live) return
    immediates += 1
    setImmediate(pump)
  }
  setImmediate(pump)
  const started = process.hrtime.bigint()
  try {
    const value = await body()
    return { value, ticks, immediates, ms: Number(process.hrtime.bigint() - started) / 1e6 }
  } finally {
    live = false
    clearInterval(timer)
  }
}

/**
 * Overhead of the async driver measured as a paired comparison.
 *
 * Both variants are timed back to back in the same round, and the reported
 * result is the smallest of those *paired* ratios. On a machine that is shared
 * with other work a single slow round can make either side look 20 % worse than
 * it is; pairing (same CPU conditions) and taking the best pair measures the
 * cost this change added rather than the load somebody else put on the box. The
 * absolute times printed are the pair that won, so the number can be read as
 * "these two renders, measured together".
 */
async function pairedOverhead (repeats, syncBody, asyncBody) {
  let best = { ratio: Number.POSITIVE_INFINITY, syncMs: 0, asyncMs: 0 }
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const syncStart = process.hrtime.bigint()
    syncBody()
    const syncMs = Number(process.hrtime.bigint() - syncStart) / 1e6
    const asyncStart = process.hrtime.bigint()
    await asyncBody()
    const asyncMs = Number(process.hrtime.bigint() - asyncStart) / 1e6
    const ratio = asyncMs / syncMs
    if (ratio < best.ratio) best = { ratio, syncMs, asyncMs }
  }
  return { overhead: best.ratio - 1, syncMs: best.syncMs, asyncMs: best.asyncMs }
}

/* --------------------------------------------------- the long render path -- */

// 16 ambient bars are ~76 s of audio: the "renders for a second" case this
// change exists for, and longer than the 60 s the requirement names.
const longScore = composeScore({ genre: 'ambient', bars: 16, seed: 7, intensity: 0.65 })

console.log('cooperative yielding: long renders stay interruptible and identical')
console.log(`  node ${process.version} · ${RATE} Hz · ${longScore.bars} ambient bars (~${(longScore.bars * longScore.beatsPerBar * 60 / longScore.bpm).toFixed(0)} s of audio)`)

console.log('\n-- the event loop during a long render --')
const syncRun = await measureEventLoop(() => renderScore(longScore))
const asyncRun = await measureEventLoop(() => renderScoreAsync(longScore))
console.log(`  sync  renderScore:      ${syncRun.ms.toFixed(0)} ms -> ${syncRun.ticks} interval tick(s), ${syncRun.immediates} immediate(s)`)
console.log(`  async renderScoreAsync: ${asyncRun.ms.toFixed(0)} ms -> ${asyncRun.ticks} interval tick(s), ${asyncRun.immediates} immediate(s)`)
// The synchronous call owns the thread: anything the event loop delivered was
// delivered before the render started or after it finished.
check('the synchronous render blocks the loop', syncRun.ticks <= 2, `${syncRun.ticks} tick(s)`)
// One tick per ~10 ms of wall time is the ceiling; the blocks are a few
// milliseconds, so a real yield schedule lands well above this floor.
check('a 10 ms interval runs during the async render', asyncRun.ticks >= 20, `${asyncRun.ticks} tick(s)`)
check('setImmediate gets the loop back during the async render', asyncRun.immediates >= 20, `${asyncRun.immediates} immediate(s)`)
check('the async render is the same length',
  asyncRun.value.durationSeconds === syncRun.value.durationSeconds,
  `${asyncRun.value.durationSeconds} s vs ${syncRun.value.durationSeconds} s`)

console.log('\n-- byte-identical output: compose --')
const syncLong = renderScore(longScore)
const asyncLong = asyncRun.value
check('60 s+ render: samples are identical', shaSamples(asyncLong.samples) === shaSamples(syncLong.samples))
check('60 s+ render: reports are identical', resultDigest(asyncLong) === resultDigest(syncLong))

const composeFixtures = [
  { name: 'cinematic 8 bars', score: composeScore({ genre: 'cinematic', bars: 8, seed: 7, intensity: 0.65 }), options: {} },
  { name: 'lofi loop 4 bars', score: composeScore({ genre: 'lofi', bars: 4, seed: 11, intensity: 0.5, loop: true }), options: {} },
  { name: 'chiptune 8 bars @ 22.05 kHz', score: composeScore({ genre: 'chiptune', bars: 8, seed: 3, intensity: 0.8 }), options: { sampleRate: 22050 } }
]
for (const fixture of composeFixtures) {
  const sync = renderScore(fixture.score, fixture.options)
  const async = await renderScoreAsync(fixture.score, fixture.options)
  check(`compose ${fixture.name}: samples identical`, shaSamples(async.samples) === shaSamples(sync.samples))
  check(`compose ${fixture.name}: reports identical`, resultDigest(async) === resultDigest(sync))
}

console.log('\n-- byte-identical output: master --')
const masterFixtures = [
  {
    name: 'mono 3 s streaming-safe',
    samples: probe(3 * RATE, RATE, 220, 1),
    rate: RATE,
    options: { preset: 'streaming-safe' }
  },
  {
    name: 'stereo 4 s streaming-loud',
    samples: [probe(4 * RATE, RATE, 110, 2), probe(4 * RATE, RATE, 137, 3)],
    rate: RATE,
    options: { preset: 'streaming-loud' }
  },
  {
    name: 'stereo 4 s fast mode',
    samples: [probe(4 * RATE, RATE, 110, 4), probe(4 * RATE, RATE, 137, 5)],
    rate: RATE,
    options: { preset: 'broadcast-23', mode: 'fast' }
  },
  {
    name: '5.1 2 s gentle',
    samples: [0, 1, 2, 3, 4, 5].map((voice) => probe(2 * RATE_48, RATE_48, 90 + voice * 50, 8 + voice)),
    rate: RATE_48,
    options: { preset: 'gentle' }
  }
]
for (const fixture of masterFixtures) {
  const sync = masterChain(fixture.samples, fixture.rate, fixture.options)
  const async = await masterChainAsync(fixture.samples, fixture.rate, fixture.options)
  check(`master ${fixture.name}: samples and report identical`, resultDigest(async) === resultDigest(sync))
  check(`master ${fixture.name}: iterations match`,
    async.report.iterations === sync.report.iterations,
    `${async.report.iterations} vs ${sync.report.iterations}`)
}

console.log('\n-- byte-identical output: bus --')
const busFixtures = [
  {
    name: 'stereo pan + compressor',
    tracks: [
      { id: 'a', samples: probe(2 * RATE_48, RATE_48, 220, 16), pan: -0.6, gainDb: -3, highpassHz: 90 },
      { id: 'b', samples: probe(2 * RATE_48, RATE_48, 440, 17), pan: 0.7, width: 1.4, lowpassHz: 9000, compressor: { thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120 } }
    ],
    options: { sampleRate: RATE_48, driveDb: 2 }
  },
  {
    name: 'sidechain duck',
    tracks: [
      { id: 'bed', samples: probe(2 * RATE_48, RATE_48, 180, 18), gainDb: -8, duckFrom: 1, duck: { amountDb: 14, attackMs: 12, releaseMs: 200 } },
      { id: 'voice', samples: probe(2 * RATE_48, RATE_48, 700, 19), gainDb: -10 }
    ],
    options: { sampleRate: RATE_48 }
  },
  {
    name: '6-channel bus',
    tracks: [
      { id: 'a', samples: probe(RATE_48, RATE_48, 220, 20) },
      { id: 'b', channels: [0, 1, 2, 3, 4, 5].map((voice) => probe(RATE_48, RATE_48, 150 + voice * 100, 21 + voice)) }
    ],
    options: { sampleRate: RATE_48, channels: 6, masterPeakDbfs: -2 }
  }
]
for (const fixture of busFixtures) {
  const sync = renderBus(fixture.tracks, fixture.options)
  const async = await renderBusAsync(fixture.tracks, fixture.options)
  const syncDigest = `${shaChannels(sync.master.channelSamples)}|${shaSamples(sync.master.samples)}|${sha(JSON.stringify(sync.meter))}`
  const asyncDigest = `${shaChannels(async.master.channelSamples)}|${shaSamples(async.master.samples)}|${sha(JSON.stringify(async.meter))}`
  check(`bus ${fixture.name}: channels and meters identical`, asyncDigest === syncDigest)
  check(`bus ${fixture.name}: frames match`, async.frames === sync.frames, `${async.frames} vs ${sync.frames}`)
}

console.log('\n-- determinism and the random sequence --')
const scoreA = composeScore({ genre: 'fantasy', bars: 4, seed: 42, intensity: 0.7 })
const scoreB = composeScore({ genre: 'fantasy', bars: 4, seed: 42, intensity: 0.7 })
const scoreC = composeScore({ genre: 'fantasy', bars: 4, seed: 43, intensity: 0.7 })
check('the same seed plans the same score', JSON.stringify(scoreA) === JSON.stringify(scoreB))
check('a different seed still plans a different score', JSON.stringify(scoreA) !== JSON.stringify(scoreC))
const rngSync = renderScore(scoreA)
const rngAsyncA = await renderScoreAsync(scoreA)
const rngAsyncB = await renderScoreAsync(scoreA)
check('the random sequence is untouched by the async driver',
  shaSamples(rngSync.samples) === shaSamples(rngAsyncA.samples))
check('the async render is byte-stable across calls',
  shaSamples(rngAsyncA.samples) === shaSamples(rngAsyncB.samples))
check('a different seed still renders different audio',
  shaSamples(rngSync.samples) !== shaSamples(renderScore(scoreC).samples))

/* -------------------------------------------------------------- the cost -- */

console.log('\n-- cost of cooperating --')

// Warm the JIT on both paths before the measurement: the first render of a
// process would otherwise be measured against code the engine has not compiled.
renderScore(longScore)
await renderScoreAsync(longScore)

const costScore = composeScore({ genre: 'cinematic', bars: 8, seed: 7, intensity: 0.65 })
const composeCost = await pairedOverhead(5,
  () => renderScore(costScore),
  () => renderScoreAsync(costScore))
console.log(`  cinematic 8 bars:   sync ${composeCost.syncMs.toFixed(0)} ms · async ${composeCost.asyncMs.toFixed(0)} ms · overhead ${(composeCost.overhead * 100).toFixed(1)}% (budget 15%)`)
check('compose: cooperative yielding costs no more than 15 %', composeCost.overhead <= 0.15, `${(composeCost.overhead * 100).toFixed(1)}%`)
check('the sync render still runs at a usable speed', composeCost.syncMs / costScore.bars <= 100,
  `${(composeCost.syncMs / costScore.bars).toFixed(1)} ms per bar`)

const masterFixture = [probe(4 * RATE, RATE, 110, 30), probe(4 * RATE, RATE, 137, 31)]
const masterOptions = { preset: 'streaming-safe' }
masterChain(masterFixture, RATE, masterOptions)
await masterChainAsync(masterFixture, RATE, masterOptions)
const masterCost = await pairedOverhead(4,
  () => masterChain(masterFixture, RATE, masterOptions),
  () => masterChainAsync(masterFixture, RATE, masterOptions))
console.log(`  master 4 s stereo:  sync ${masterCost.syncMs.toFixed(0)} ms · async ${masterCost.asyncMs.toFixed(0)} ms · overhead ${(masterCost.overhead * 100).toFixed(1)}% (budget 15%)`)
check('master: cooperative yielding costs no more than 15 %', masterCost.overhead <= 0.15, `${(masterCost.overhead * 100).toFixed(1)}%`)

const busFixture = [
  { id: 'a', samples: probe(20 * RATE_48, RATE_48, 220, 40), pan: -0.4, highpassHz: 80, compressor: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 } },
  { id: 'b', samples: probe(20 * RATE_48, RATE_48, 330, 41), gainDb: -6, offsetSeconds: 0.25, lowpassHz: 8000 },
  { id: 'c', samples: probe(20 * RATE_48, RATE_48, 550, 42), gainDb: -12, pan: 0.5, width: 1.2 }
]
const busOptions = { sampleRate: RATE_48, driveDb: 1.5 }
renderBus(busFixture, busOptions)
await renderBusAsync(busFixture, busOptions)
// A 20 s, three-track bus is tens of milliseconds of work: long enough that the
// cooperation points are a measurable share of the render, short enough to keep
// the test quick. The paired comparison cancels a slow scheduler round.
const busCost = await pairedOverhead(5,
  () => renderBus(busFixture, busOptions),
  () => renderBusAsync(busFixture, busOptions))
console.log(`  bus 20 s x 3 tracks: sync ${busCost.syncMs.toFixed(0)} ms · async ${busCost.asyncMs.toFixed(0)} ms · overhead ${(busCost.overhead * 100).toFixed(1)}% (budget 15%)`)
check('bus: cooperative yielding costs no more than 15 %', busCost.overhead <= 0.15, `${(busCost.overhead * 100).toFixed(1)}%`)

console.log(failures === 0
  ? `\nOK: ${checks} cooperative-yield checks passed — long renders yield, stay byte-identical and cost ≤ 15 %`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
