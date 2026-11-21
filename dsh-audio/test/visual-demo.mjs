/**
 * Build the visual-sync demo artifacts.
 *
 * Writes, into the lab drop folder (default ../../out/, override with argv[2]):
 *   lipsync-vowels.json / .css / .srt / .wav  — a sung vowel phrase analysed at 24 fps
 *   beats-cue-110bpm.json / .wav              — a rendered 4-bar cue and its grid
 *   lipsync-demo.html                         — one self-contained page: inlined wav,
 *                                               mouth moved by the JSON frames, beat pulse
 *
 * The page is the real test of the format: if a browser can drive a mouth from
 * `frames[i].viseme` and `frames[i].openness` with a dozen lines of JS, an
 * animation author can too.
 *
 * Run: <node> test/visual-demo.mjs [outDir]
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { makeRng, normalizePeak } from '../lib/dsp.js'
import { mixTracks, renderPreset, writeFileAtomic } from '../lib/audio.js'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { analyzeVisemes, visemeToSrt, visemeToTimeline } from '../lib/lipsync.js'
import { analyzeBeats } from '../lib/beats.js'

const outDir = process.argv[2] !== undefined
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../../out/', import.meta.url))
await mkdir(outDir, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

/* ------------------------------------------------------------- synthesis -- */

const PHRASE_RATE = 22050
const FPS = 24

/** Harmonic tone: a sawtooth series shaped by 1/n. */
function sawTooth (frames, sampleRate, hz) {
  const out = new Float32Array(frames)
  for (let harmonic = 1; harmonic * hz < Math.min(9000, sampleRate / 2); harmonic += 1) {
    const amplitude = 1 / harmonic
    for (let i = 0; i < frames; i += 1) out[i] += amplitude * Math.sin(2 * Math.PI * hz * harmonic * i / sampleRate)
  }
  return out
}

/** RBJ band-pass biquad: the formant resonator. */
function bandpass (input, sampleRate, frequency, q) {
  const out = new Float32Array(input.length)
  const w0 = 2 * Math.PI * frequency / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const b0 = alpha
  const b2 = -alpha
  const a0 = 1 + alpha
  const a1 = -2 * Math.cos(w0)
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i]
    const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
    out[i] = y0
  }
  return out
}

function fadeEdges (buffer, sampleRate, seconds = 0.018) {
  const edge = Math.min(Math.floor(buffer.length / 2), Math.round(seconds * sampleRate))
  for (let i = 0; i < edge; i += 1) {
    const gain = 0.5 - 0.5 * Math.cos(Math.PI * i / edge)
    buffer[i] *= gain
    buffer[buffer.length - 1 - i] *= gain
  }
  return buffer
}

function scalePeak (buffer, target) {
  let peak = 0
  for (let i = 0; i < buffer.length; i += 1) peak = Math.max(peak, Math.abs(buffer[i]))
  if (peak > 0) {
    const gain = target / peak
    for (let i = 0; i < buffer.length; i += 1) buffer[i] *= gain
  }
  return buffer
}

/** One sung vowel: a 160 Hz glottal saw through two formant resonators. */
function vowelBuffer (seconds, sampleRate, f1, f2) {
  const frames = Math.round(seconds * sampleRate)
  const saw = sawTooth(frames, sampleRate, 160)
  const first = bandpass(saw, sampleRate, f1, 9)
  const second = bandpass(saw, sampleRate, f2, 11)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = first[i] + 0.55 * second[i] + 0.05 * saw[i]
  return fadeEdges(scalePeak(out, 0.9), sampleRate)
}

/** An /s/: seeded noise pushed through a 5.8 kHz resonator. */
function fricativeBuffer (seconds, sampleRate, rand) {
  const frames = Math.round(seconds * sampleRate)
  const raw = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) raw[i] = rand() * 2 - 1
  const out = bandpass(raw, sampleRate, 5800, 1.1)
  return fadeEdges(scalePeak(out, 0.3), sampleRate)
}

/** An /m/: 90 Hz nasal murmur, harmonics only under 600 Hz. */
function humBuffer (seconds, sampleRate) {
  const frames = Math.round(seconds * sampleRate)
  const out = new Float32Array(frames)
  for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
    for (let i = 0; i < frames; i += 1) out[i] += Math.sin(2 * Math.PI * 90 * harmonic * i / sampleRate) / harmonic
  }
  return fadeEdges(scalePeak(out, 0.5), sampleRate)
}

/**
 * The phrase the demo animates: rest, a e i o u, /s/, /m/, rest. Each segment
 * has a known intended viseme, so the printed counts can be checked by eye.
 */
function buildPhrase () {
  const segments = [
    { kind: 'rest', seconds: 0.32, label: 'none' },
    { kind: 'vowel', seconds: 0.72, f1: 730, f2: 1180, label: 'a (AA)' },
    { kind: 'vowel', seconds: 0.62, f1: 560, f2: 1720, label: 'e (EH)' },
    { kind: 'vowel', seconds: 0.55, f1: 340, f2: 2300, label: 'i (EE)' },
    { kind: 'vowel', seconds: 0.55, f1: 500, f2: 850, label: 'o (OH)' },
    { kind: 'vowel', seconds: 0.55, f1: 320, f2: 780, label: 'u (OO)' },
    { kind: 'fricative', seconds: 0.34, label: 's (SS)' },
    { kind: 'hum', seconds: 0.52, label: 'm (MM)' },
    { kind: 'rest', seconds: 0.3, label: 'none' }
  ]
  const totalFrames = segments.reduce((sum, segment) => sum + Math.round(segment.seconds * PHRASE_RATE), 0)
  const master = new Float32Array(totalFrames)
  const rand = makeRng(4242)
  let cursor = 0
  const marks = []
  for (const segment of segments) {
    const frames = Math.round(segment.seconds * PHRASE_RATE)
    let buffer = null
    if (segment.kind === 'vowel') buffer = vowelBuffer(segment.seconds, PHRASE_RATE, segment.f1, segment.f2)
    else if (segment.kind === 'fricative') buffer = fricativeBuffer(segment.seconds, PHRASE_RATE, rand)
    else if (segment.kind === 'hum') buffer = humBuffer(segment.seconds, PHRASE_RATE)
    if (buffer !== null) master.set(buffer.subarray(0, Math.min(frames, buffer.length)), cursor)
    marks.push({ label: segment.label, start: cursor / PHRASE_RATE, end: (cursor + frames) / PHRASE_RATE })
    cursor += frames
  }
  normalizePeak(master, -3)
  return { samples: master, sampleRate: PHRASE_RATE, marks, duration: master.length / PHRASE_RATE }
}

/**
 * A 4-bar cue at 110 bpm assembled from rendered presets (the audio_compose
 * shape): bell + kick on the downbeat, kick on beat 3, hats on the rest — the
 * common pop pattern, so the downbeat guess has something real to find.
 */
function buildBeatCue (bpm = 110) {
  const period = 60 / bpm
  const beats = 16
  const duration = beats * period + 1.1
  const kick = renderPreset({ preset: 'impact', params: { weight: 0.82, hardness: 0.55 }, duration: 0.4, seed: 21 })
  const hat = renderPreset({ preset: 'tick', params: { pitch: 0.55, hardness: 0.5 }, duration: 0.12, seed: 22 })
  const bell = renderPreset({ preset: 'chime', params: { pitch: 0.32, decay: 0.35 }, duration: 0.7, seed: 23 })
  const inputs = []
  const offsets = []
  const gains = []
  const place = (track, gain, at) => {
    inputs.push(track)
    gains.push(gain)
    offsets.push(at)
  }
  for (let beat = 0; beat < beats; beat += 1) {
    const at = beat * period
    const inBar = beat % 4
    if (inBar === 0) { place(bell, -3, at); place(kick, -4, at) }
    else if (inBar === 2) place(kick, -4, at)
    else place(hat, -7, at)
  }
  const mixed = mixTracks(inputs, {
    sampleRate: 44100,
    gains,
    offsets,
    durationSeconds: duration,
    limiter: true,
    peakDbfs: -1
  })
  return { samples: mixed.samples, sampleRate: mixed.sampleRate, duration: mixed.durationSeconds, bpm, period }
}

/* ------------------------------------------------------------ lipsync -- */

console.log('-- lipsync demo: sung vowels + fricative + hum --')
const phrase = buildPhrase()
const analysis = analyzeVisemes(phrase.samples, phrase.sampleRate, { fps: FPS })
const trackJson = visemeToTimeline(analysis.frames, 'json', {
  fps: analysis.fps,
  duration: analysis.durationSeconds,
  leadMs: analysis.leadMs
})
const trackCss = visemeToTimeline(analysis.frames, 'css', {
  fps: analysis.fps,
  duration: analysis.durationSeconds,
  leadMs: analysis.leadMs
})
const trackSrt = visemeToSrt(analysis.frames, { fps: analysis.fps })
// Dither off: the demo artifacts must be byte-identical across runs, just like
// the analysis they contain.
const wav = encodeWav([phrase.samples], phrase.sampleRate, { dither: false })
const lipsyncFiles = [
  ['lipsync-vowels.json', Buffer.from(trackJson, 'utf8')],
  ['lipsync-vowels.css', Buffer.from(trackCss, 'utf8')],
  ['lipsync-vowels.srt', Buffer.from(trackSrt, 'utf8')],
  ['lipsync-vowels.wav', wav]
]
for (const [name, bytes] of lipsyncFiles) await writeFileAtomic(join(outDir, name), bytes)

const byModulo = (from, to) => analysis.frames.filter((frame) => frame.t >= from && frame.t < to)
for (const mark of phrase.marks) {
  if (mark.label === 'none') continue
  const frames = byModulo(mark.start, mark.end)
  const tally = {}
  for (const frame of frames) tally[frame.viseme] = (tally[frame.viseme] || 0) + 1
  const best = Object.keys(tally).reduce((winner, key) => (tally[key] > (tally[winner] || 0) ? key : winner), 'none')
  console.log(`  ${mark.label.padEnd(9)} ${mark.start.toFixed(2)}-${mark.end.toFixed(2)}s -> ${best}  (${frames.length} frames)`)
}
console.log(`frames=${analysis.frames.length} voiced=${analysis.voicedFrames} duration=${analysis.durationSeconds.toFixed(3)}s counts ` +
  Object.entries(analysis.counts).filter(([, count]) => count > 0).map(([key, count]) => `${key}:${count}`).join(' '))

const dataUri = `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`
console.log(`wrote ${lipsyncFiles.map(([name]) => name).join(', ')} · wav ${(wav.length / 1024).toFixed(0)} KB · inline ${(dataUri.length / 1024).toFixed(0)} KB`)

/* --------------------------------------------------------------- beats -- */

console.log('-- beats demo: a rendered 110 bpm cue --')
const cue = buildBeatCue(110)
const beatAnalysis = analyzeBeats(cue.samples, cue.sampleRate)
const cueTruth = []
for (let beat = 0; beat < 16; beat += 1) cueTruth.push(beat * cue.period)
let worstBeatError = 0
for (const truth of cueTruth) {
  let nearest = Infinity
  for (const beat of beatAnalysis.beatTimes) nearest = Math.min(nearest, Math.abs(beat - truth))
  worstBeatError = Math.max(worstBeatError, nearest)
}
const beatsJson = JSON.stringify({
  format: 'dsh-audio-beats',
  version: 1,
  source: { name: 'beats-cue-110bpm.wav', durationSeconds: beatAnalysis.durationSeconds, sampleRate: beatAnalysis.sampleRate },
  bpm: beatAnalysis.bpm,
  confidence: beatAnalysis.confidence,
  beatsPerBar: beatAnalysis.beatsPerBar,
  secondsPerBeat: beatAnalysis.secondsPerBeat,
  secondsPerBar: beatAnalysis.secondsPerBar,
  downbeatGuess: beatAnalysis.downbeatGuess,
  bars: beatAnalysis.durationToBar(beatAnalysis.durationSeconds).bars,
  beatTimes: beatAnalysis.beatTimes,
  grid: beatAnalysis.grid,
  onsets: beatAnalysis.onsets
}, null, 2)
await writeFileAtomic(join(outDir, 'beats-cue-110bpm.json'), Buffer.from(beatsJson, 'utf8'))
await writeFileAtomic(join(outDir, 'beats-cue-110bpm.wav'), encodeWav([cue.samples], cue.sampleRate, { dither: false }))
console.log(`bpm=${beatAnalysis.bpm} conf=${beatAnalysis.confidence} beats=${beatAnalysis.beatTimes.length} onsets=${beatAnalysis.onsets.length} ` +
  `grid=${beatAnalysis.grid.length} worstBeatErr=${(worstBeatError * 1000).toFixed(1)}ms downbeat=${beatAnalysis.downbeatGuess} bar=${beatAnalysis.secondsPerBar}s`)
check('demo cue tempo detected', Math.abs(beatAnalysis.bpm - cue.bpm) / cue.bpm <= 0.03, String(beatAnalysis.bpm))
check('demo cue beats land on the truth', worstBeatError <= 0.05, `${(worstBeatError * 1000).toFixed(1)}ms`)

/* ----------------------------------------------------------------- html -- */

console.log('-- demo page --')
const page = buildPage({
  track: trackJson,
  beats: beatsJson,
  dataUri,
  wavBytes: wav.length,
  duration: analysis.durationSeconds,
  fps: analysis.fps
})
const htmlPath = join(outDir, 'lipsync-demo.html')
await writeFileAtomic(htmlPath, Buffer.from(page, 'utf8'))
const htmlBytes = Buffer.byteLength(page)

const html = await readFile(htmlPath, 'utf8')
const trackBlock = /<script type="application\/json" id="dsh-track">([\s\S]*?)<\/script>/.exec(html)
const beatBlock = /<script type="application\/json" id="dsh-beats">([\s\S]*?)<\/script>/.exec(html)
const appScript = /<script>([\s\S]*?)<\/script>/.exec(html)
const embedded = /data:audio\/wav;base64,([A-Za-z0-9+/=]+)/.exec(html)
console.log(`html ${(htmlBytes / 1024).toFixed(0)} KB · json blocks ${trackBlock !== null && beatBlock !== null} · script ${appScript !== null}`)
check('page has the track json block', trackBlock !== null && JSON.parse(trackBlock[1]).frames.length === analysis.frames.length)
check('page has the beat json block', beatBlock !== null && JSON.parse(beatBlock[1]).bpm > 0)
check('page embeds the wav inline', embedded !== null)
check('page is fully offline', !/https?:\/\//.test(html) && !/<link\b/i.test(html) && !/src="[^"]*\.(js|css|png|wav)"/i.test(html))
let scriptParses = false
try {
  new Script(appScript !== null ? appScript[1] : '')
  scriptParses = appScript !== null && appScript[1].includes('requestAnimationFrame')
} catch (error) {
  console.log(`  script error: ${error.message}`)
}
check('page script parses and drives a frame loop', scriptParses)

// The page is the proof that the format is usable, so run its script against a
// minimal DOM and check that it actually moves the mouth: a page that only
// parses could still read `viseme` off the wrong key.
if (appScript !== null) {
  const harness = createPageHarness(trackJson, beatsJson, analysis.durationSeconds)
  let ran = false
  try {
    new Script(appScript[1]).runInNewContext(harness.sandbox)
    ran = true
  } catch (error) {
    console.log(`  page runtime error: ${error.message}`)
  }
  check('page JS runs against a DOM', ran)
  const mouth = harness.elements.get('mouth')
  check('page JS draws an initial mouth', ran && Number(mouth.attributes.width) > 0 && Number(mouth.attributes.height) >= 4,
    JSON.stringify(mouth.attributes))
  check('page JS labels the first frame', harness.elements.get('viseme').textContent === analysis.frames[0].viseme,
    harness.elements.get('viseme').textContent)
  check('page JS reports the tempo', /BPM/.test(harness.elements.get('tempo').textContent), harness.elements.get('tempo').textContent)
  const countChips = harness.elements.get('counts').children.length
  const filledCounts = Object.values(analysis.counts).filter((count) => count > 0).length
  check('page JS lists every viseme that occurs', countChips === filledCounts, `${countChips}/${filledCounts}`)

  if (ran) {
    harness.elements.get('play').listeners.click()
    await Promise.resolve()
    await Promise.resolve()
    const audio = harness.instances[0]
    audio.paused = false
    audio.currentTime = 1.72
    const tick = harness.frames.pop()
    if (typeof tick === 'function') tick()
    const expectedFrame = analysis.frames[Math.floor(1.72 * analysis.fps)]
    console.log(`page harness: t=1.72s -> "${harness.elements.get('viseme').textContent}" expected "${expectedFrame.viseme}" ` +
      `mouth=${mouth.attributes.width}x${mouth.attributes.height} pulse.opacity=${harness.elements.get('pulse').style.opacity}`)
    check('page JS follows playback time', harness.elements.get('viseme').textContent === expectedFrame.viseme,
      `${harness.elements.get('viseme').textContent} != ${expectedFrame.viseme}`)
    check('mouth opens on a vowel frame', Number(mouth.attributes.height) > 10, mouth.attributes.height)
    check('beat pulse is driven by the grid', Number(harness.elements.get('pulse').style.opacity) >= 0.1)
  }
}

if (embedded !== null) {
  const decoded = decodeWav(Buffer.from(embedded[1], 'base64'))
  console.log(`inline wav decodes ${decoded.durationSeconds.toFixed(3)}s ${decoded.sampleRate} Hz ${decoded.channels.length}ch`)
  check('inline wav duration matches the track', Math.abs(decoded.durationSeconds - analysis.durationSeconds) < 0.01,
    `${decoded.durationSeconds} vs ${analysis.durationSeconds}`)
}
console.log(`\nartifacts in ${outDir}`)
for (const name of ['lipsync-vowels.json', 'lipsync-vowels.css', 'lipsync-vowels.srt', 'lipsync-vowels.wav', 'beats-cue-110bpm.json', 'beats-cue-110bpm.wav', 'lipsync-demo.html']) {
  const bytes = (await readFile(join(outDir, name))).length
  console.log(`  ${name.padEnd(24)} ${(bytes / 1024).toFixed(1)} KB`)
}

console.log(failures === 0 ? '\nOK: demo artifacts written and verified' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

/* ---------------------------------------------------------------- page -- */

/**
 * The demo page. It is deliberately plain DOM + SVG: no canvas, no libraries,
 * no network. Everything it needs is inlined, and the only interesting code is
 * the twenty lines that read `frames[i]` and move the mouth.
 */
function buildPage ({ track, beats, dataUri, wavBytes, duration, fps }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-audio · sound drives the mouth</title>
<style>
  :root { color-scheme: dark; --ink: #e9e6df; --dim: #8f8a80; --hot: #ff5d73; --line: #2c2a27; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #141312; color: var(--ink);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         display: grid; place-items: center; padding: 32px 20px; }
  main { width: min(680px, 100%); }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: .01em; margin: 0 0 4px; }
  .sub { margin: 0 0 20px; color: var(--dim); font-size: 12.5px; }
  .stage { position: relative; border: 1px solid var(--line); border-radius: 16px;
           background: radial-gradient(120% 90% at 50% 20%, #201e1c, #171615 70%); padding: 14px; }
  svg { display: block; width: 100%; height: auto; }
  .face { fill: #221f1d; stroke: #35312d; stroke-width: 1.5; }
  .lips { fill: #2a1a1c; stroke: var(--hot); stroke-width: 2.5; }
  .shine { fill: var(--hot); opacity: .18; }
  #pulse { position: absolute; inset: 18%; border-radius: 50%; border: 2px solid var(--hot);
           opacity: .1; pointer-events: none; transition: none; }
  .hud { display: flex; align-items: center; gap: 14px; margin: 16px 0 12px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 600; color: #171615; background: var(--ink); border: 0;
           border-radius: 9px; padding: 8px 16px; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .time { color: var(--dim); font-variant-numeric: tabular-nums; font-size: 12.5px; }
  .bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
  #progress { height: 100%; width: 0; background: var(--hot); }
  .meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 16px 0 8px; }
  .cell { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
  .cell b { display: block; color: var(--dim); font-size: 10.5px; font-weight: 600;
            text-transform: uppercase; letter-spacing: .07em; }
  .cell span { font-variant-numeric: tabular-nums; font-size: 15px; }
  #counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; padding: 0; list-style: none; }
  #counts span { border: 1px solid var(--line); color: var(--dim); border-radius: 999px;
                 padding: 2px 9px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .note { margin-top: 16px; color: var(--dim); font-size: 11.5px; }
</style>
</head>
<body>
<main>
  <h1>sound drives the mouth</h1>
  <p class="sub">per-frame viseme + jaw openness from lib/lipsync.js · grid from lib/beats.js · wav inlined (${(wavBytes / 1024).toFixed(0)} KB), no network</p>

  <div class="stage" id="stage">
    <div id="pulse"></div>
    <svg viewBox="0 0 240 170" role="img" aria-label="animated mouth">
      <ellipse class="face" cx="120" cy="88" rx="84" ry="62"></ellipse>
      <rect id="mouth" class="lips" x="72" y="92" width="96" height="6" rx="3" ry="3"></rect>
      <ellipse id="shine" class="shine" cx="106" cy="70" rx="30" ry="12"></ellipse>
    </svg>
  </div>

  <div class="hud">
    <button id="play">▶ play</button>
    <span class="time" id="time">0.00 s / ${duration.toFixed(2)} s</span>
  </div>
  <div class="bar"><div id="progress"></div></div>

  <div class="meta">
    <div class="cell"><b>viseme</b><span id="viseme">none</span></div>
    <div class="cell"><b>openness</b><span id="openness">0.00</span></div>
    <div class="cell"><b>tempo</b><span id="tempo">-- BPM</span></div>
    <div class="cell"><b>frames</b><span id="frameCount">0</span></div>
  </div>
  <ul id="counts"></ul>
  <p class="note">frames are ${fps} fps; the jaw follows openness continuously while the viseme switches the lip width and roundness. the ring pulses on the detected beat grid.</p>
</main>

<script type="application/json" id="dsh-track">${track}</script>
<script type="application/json" id="dsh-beats">${beats}</script>
<script>
(function () {
  var track = JSON.parse(document.getElementById('dsh-track').textContent)
  var grid = JSON.parse(document.getElementById('dsh-beats').textContent)
  var WAV = '${dataUri}'

  // Width factor and corner roundness per viseme: enough to read as lips.
  var SHAPE = {
    AA: { w: 1.0, round: 0.5 },
    EH: { w: 0.88, round: 0.56 },
    EE: { w: 1.14, round: 0.3 },
    OH: { w: 0.78, round: 0.74 },
    OO: { w: 0.62, round: 0.9 },
    MM: { w: 0.52, round: 0.2 },
    FF: { w: 0.8, round: 0.26 },
    TH: { w: 0.84, round: 0.34 },
    SS: { w: 1.02, round: 0.18 },
    DD: { w: 0.86, round: 0.42 },
    none: { w: 0.6, round: 0.24 }
  }

  var mouth = document.getElementById('mouth')
  var shine = document.getElementById('shine')
  var pulse = document.getElementById('pulse')
  var button = document.getElementById('play')
  var timeLabel = document.getElementById('time')
  var visemeLabel = document.getElementById('viseme')
  var openLabel = document.getElementById('openness')
  var progress = document.getElementById('progress')
  var audio = new Audio(WAV)
  audio.preload = 'auto'

  document.getElementById('tempo').textContent = grid.bpm > 0 ? grid.bpm + ' BPM' : 'no grid'
  document.getElementById('frameCount').textContent = track.frames.length
  var counts = document.getElementById('counts')
  Object.keys(track.counts).forEach(function (key) {
    if (!track.counts[key]) return
    var cell = document.createElement('span')
    cell.textContent = key + ' ' + track.counts[key]
    counts.appendChild(cell)
  })

  function frameAt (seconds) {
    var exact = seconds * track.fps
    var index = Math.floor(exact)
    if (index < 0) index = 0
    if (index > track.frames.length - 1) index = track.frames.length - 1
    var next = Math.min(index + 1, track.frames.length - 1)
    var local = Math.min(1, Math.max(0, exact - index))
    return { frame: track.frames[index], next: track.frames[next], local: local }
  }

  var beatCursor = 0
  function beatAmount (seconds) {
    var times = grid.beatTimes
    if (!times.length) return 0
    while (beatCursor + 1 < times.length && times[beatCursor + 1] <= seconds) beatCursor += 1
    var nearest = Infinity
    var from = Math.max(0, beatCursor - 1)
    var to = Math.min(times.length - 1, beatCursor + 1)
    for (var i = from; i <= to; i += 1) nearest = Math.min(nearest, Math.abs(seconds - times[i]))
    var window = grid.secondsPerBeat ? grid.secondsPerBeat * 0.42 : 0.22
    return Math.max(0, 1 - nearest / window)
  }

  function draw (seconds) {
    var at = frameAt(seconds)
    var shape = SHAPE[at.frame.viseme] || SHAPE.none
    var nextShape = SHAPE[at.next.viseme] || shape
    var widthFactor = shape.w + (nextShape.w - shape.w) * at.local
    var round = shape.round + (nextShape.round - shape.round) * at.local
    var open = at.frame.openness + (at.next.openness - at.frame.openness) * at.local
    var width = 96 * widthFactor
    var height = 5 + 44 * open
    var radius = Math.min(width, height) * 0.5 * round
    mouth.setAttribute('x', (120 - width / 2).toFixed(2))
    mouth.setAttribute('y', (92 - height / 2).toFixed(2))
    mouth.setAttribute('width', width.toFixed(2))
    mouth.setAttribute('height', Math.max(4, height).toFixed(2))
    mouth.setAttribute('rx', Math.max(2, radius).toFixed(2))
    mouth.setAttribute('ry', Math.max(2, radius).toFixed(2))
    shine.setAttribute('opacity', (0.05 + 0.18 * open).toFixed(3))

    visemeLabel.textContent = at.frame.viseme
    openLabel.textContent = open.toFixed(2)
    timeLabel.textContent = seconds.toFixed(2) + ' s / ' + (audio.duration || ${duration.toFixed(3)}).toFixed(2) + ' s'
    progress.style.width = (100 * Math.min(1, seconds / (audio.duration || ${duration.toFixed(3)}))).toFixed(2) + '%'

    var hit = beatAmount(seconds)
    pulse.style.transform = 'scale(' + (1 + 0.16 * hit).toFixed(3) + ')'
    pulse.style.opacity = (0.1 + 0.55 * hit).toFixed(3)
  }

  function tick () {
    if (audio.paused) return
    draw(audio.currentTime)
    requestAnimationFrame(tick)
  }

  function play () {
    audio.currentTime = 0
    beatCursor = 0
    draw(0)
    audio.play().then(function () {
      button.textContent = '❚❚ stop'
      requestAnimationFrame(tick)
    }, function () {
      timeLabel.textContent = 'autoplay blocked — click play'
    })
  }

  button.addEventListener('click', function () {
    if (audio.paused) play()
    else { audio.pause(); button.textContent = '▶ play' }
  })
  document.getElementById('stage').addEventListener('click', function () {
    if (audio.paused) play()
  })
  document.addEventListener('keydown', function (event) {
    if (event.code === 'Space') { event.preventDefault(); button.click() }
  })
  audio.addEventListener('ended', function () {
    button.textContent = '▶ play'
    statusMessage('done')
    draw(audio.duration || ${duration.toFixed(3)})
  })

  function statusMessage (text) {
    timeLabel.textContent = text === 'done' ? 'done · ' + track.frames.length + ' frames · ' + grid.bpm + ' BPM' : text
  }

  draw(0)
})()
</script>
</body>
</html>
`
}

/**
 * Minimal DOM + Audio stub: just enough to execute the demo page's script and
 * verify it reads the real `frames` array and moves the mouth. Not a browser —
 * the smallest harness that catches a wrong key, a broken time lookup, or a
 * page that parses but does nothing.
 */
function createPageHarness (trackJson, beatsJson, durationSeconds) {
  const elements = new Map()
  const makeElement = (id) => ({
    id,
    textContent: '',
    style: {},
    attributes: {},
    children: [],
    listeners: {},
    setAttribute (name, value) { this.attributes[name] = String(value) },
    appendChild (child) { this.children.push(child) },
    addEventListener (name, handler) { this.listeners[name] = handler }
  })
  for (const id of ['mouth', 'shine', 'pulse', 'play', 'time', 'viseme', 'openness', 'progress', 'tempo', 'frameCount', 'counts', 'stage', 'dsh-track', 'dsh-beats']) {
    elements.set(id, makeElement(id))
  }
  elements.get('dsh-track').textContent = trackJson
  elements.get('dsh-beats').textContent = beatsJson

  const frames = []
  const instances = []
  class FakeAudio {
    constructor (src) {
      this.src = src
      this.paused = true
      this.currentTime = 0
      this.duration = durationSeconds
      this.preload = ''
      this.listeners = {}
      instances.push(this)
    }
    play () { this.paused = false; return Promise.resolve() }
    pause () { this.paused = true }
    addEventListener (name, handler) { this.listeners[name] = handler }
  }
  const document = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => makeElement('created'),
    addEventListener: () => {}
  }
  const requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  return {
    elements,
    instances,
    frames,
    sandbox: { document, Audio: FakeAudio, requestAnimationFrame, console }
  }
}
