/**
 * Build `test/out/cue-demo.html`: one self-contained page, two inline sounds,
 * a moving box, and cues that fire exactly where the CSS keyframes hit.
 *
 * The demo exists to prove the generated player works in a real page shape:
 * audio is embedded (zero network requests), the start button supplies the
 * user gesture the autoplay policy requires, and the CSS animation is delayed
 * by the player's pre-roll so keyframe time and AudioContext time share zero.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { finalize, renderPreset } from '../lib/audio.js'
import { buildCueSheet, inlineAudio } from '../lib/bind.js'
import { decodeWav, encodeWav } from '../lib/wav.js'

const DURATION = 4
// Cue times and keyframe percentages are derived from each other; the test
// asserts they still line up after the page is assembled.
const SLAM_AT = 0.35
const DING_AT = 2.9
const SLAM_PCT = Number((SLAM_AT / DURATION * 100).toFixed(4))
const DING_PCT = Number((DING_AT / DURATION * 100).toFixed(4))
const FLIP_PCT = 40

function wavBytes (preset, { params = {}, duration, seed, sampleRate = 22050 }) {
  const rendered = renderPreset({ preset, params, duration, seed, sampleRate })
  finalize(rendered.samples, rendered.sampleRate)
  return encodeWav([rendered.samples], rendered.sampleRate, { dither: false })
}

const slam = wavBytes('impact', { params: { weight: 0.9, hardness: 0.7, space: 0.15 }, duration: 0.55, seed: 11 })
const ding = wavBytes('chime', { params: { pitch: 0.66, decay: 0.4, metallic: 0.4 }, duration: 0.7, seed: 12 })
const inlined = await inlineAudio({
  entries: [
    { name: 'slam', bytes: slam },
    { name: 'ding', bytes: ding }
  ]
})
const src = new Map(inlined.entries.map((entry) => [entry.name, entry.src]))

const sheet = buildCueSheet({
  cues: [
    { name: 'slam', at: SLAM_AT, src: src.get('slam'), fadeOut: 0.05 },
    { name: 'ding', at: DING_AT, src: src.get('ding'), gainDb: -2 }
  ],
  duration: DURATION
})

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-audio cue demo</title>
<style>
  :root {
    color-scheme: dark;
    --ink: #e8eefc;
    --dim: #8b97b5;
    --accent: #67e8f9;
    --travel: min(62vw, 560px);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 30% 15%, #17233c, #080b13 68%);
    color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { width: min(92vw, 760px); padding: 28px 0 40px; }
  h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: .04em; }
  .lead { margin: 0 0 18px; color: var(--dim); font-size: 13px; }
  .stage {
    position: relative;
    height: 130px;
    border-radius: 16px;
    border: 1px solid #23304d;
    background: linear-gradient(180deg, #101a30, #0b1222);
    overflow: hidden;
  }
  /* Guide rails: a vertical line lands exactly on each cue's keyframe percent. */
  .stage .rail { position: absolute; top: 0; bottom: 0; width: 1px; background: #2f3f63; }
  .stage .rail::after {
    content: attr(data-at);
    position: absolute;
    top: 6px;
    left: 5px;
    font: 10px/1 ui-monospace, monospace;
    color: #64748b;
    white-space: nowrap;
  }
  #box {
    position: absolute;
    top: 50%;
    left: 22px;
    width: 66px;
    height: 66px;
    margin-top: -33px;
    border-radius: 17px;
    background: linear-gradient(135deg, #67e8f9, #6366f1 55%, #a855f7);
    box-shadow: 0 14px 34px rgba(103, 232, 249, .3), inset 0 1px 0 rgba(255, 255, 255, .35);
    animation: travel ${DURATION}s cubic-bezier(.45, 0, .55, 1) 1 both paused;
  }
  #box.run { animation-play-state: running; }
  #box.paused { animation-play-state: paused; }
  /* Keyframe times: ${SLAM_PCT}% = ${SLAM_AT}s (slam), ${FLIP_PCT}% = ${(DURATION * FLIP_PCT / 100).toFixed(1)}s (flip), ${DING_PCT}% = ${DING_AT}s (ding). */
  @keyframes travel {
    0%     { transform: translateX(0) rotate(0deg) scale(1); }
    ${SLAM_PCT}% { transform: translateX(var(--travel)) rotate(180deg) scale(.9); }
    ${FLIP_PCT}%    { transform: translateX(calc(var(--travel) * .5)) rotate(360deg) scale(1.18); }
    ${DING_PCT}% { transform: translateX(0) rotate(540deg) scale(1.06); }
    100%   { transform: translateX(0) rotate(540deg) scale(1); }
  }
  .bar { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  button {
    appearance: none;
    border: 1px solid #2b3a5c;
    border-radius: 10px;
    background: linear-gradient(180deg, #1b2742, #121a2c);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    padding: 9px 16px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: default; }
  .hud { margin-left: auto; color: var(--dim); font: 13px/1 ui-monospace, monospace; }
  .hud b { color: var(--accent); font-weight: 600; }
  .notes { margin-top: 18px; color: #6b7899; font-size: 12px; }
  .notes code { color: #9fb0d0; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>dsh-audio · cue demo</h1>
  <p class="lead">Two inlined sounds, one moving box, one AudioContext clock. Click <b>Start</b> once: the browser needs a gesture before audio may play.</p>
  <div class="stage">
    <div class="rail" style="left: calc(22px + var(--travel))" data-at="slam @ ${SLAM_AT}s"></div>
    <div class="rail" style="left: 22px" data-at="ding @ ${DING_AT}s"></div>
    <div id="box"></div>
  </div>
  <div class="bar">
    <button id="go" type="button">▶ Start</button>
    <button id="again" type="button" hidden>↻ Replay</button>
    <button id="mute" type="button" aria-pressed="false" hidden>Mute</button>
    <span class="hud">timeline <b id="clock">0.000</b> s</span>
  </div>
  <p class="notes">
    Cues: <code>${SLAM_AT.toFixed(2)}s slam</code> · <code>${DING_AT.toFixed(2)}s ding</code>.
    The page never reads a wall clock; the box animation is delayed by
    <code>-dshAudio.currentTime()</code> at start, so the CSS keyframes and the scheduled
    cues ride the same clock. Hidden tabs pause both.
  </p>
</main>
<script id="dsh-player">${sheet.script}</script>
<script>
(() => {
  const audio = window.dshAudio
  const box = document.getElementById('box')
  const clock = document.getElementById('clock')
  const go = document.getElementById('go')
  const again = document.getElementById('again')
  const mute = document.getElementById('mute')
  let raf = 0

  const tick = () => {
    clock.textContent = Math.max(0, audio.currentTime()).toFixed(3)
    raf = requestAnimationFrame(tick)
  }

  // The timeline starts after the player's pre-roll; currentTime() is negative
  // during it. Delay the CSS animation by exactly that much.
  window.addEventListener('dshaudio:start', () => {
    box.classList.remove('run')
    box.style.animationDelay = Math.max(0, -audio.currentTime()) + 's'
    void box.offsetWidth
    box.classList.add('run')
    if (!raf) tick()
    go.hidden = true
    mute.hidden = false
  })

  go.addEventListener('click', async () => {
    go.disabled = true
    let ok = false
    try { ok = await audio.resume() } catch (error) { ok = false }
    go.disabled = false
    if (!ok) go.textContent = 'Audio blocked — click again'
  })

  box.addEventListener('animationend', () => { again.hidden = false })

  again.addEventListener('click', async () => {
    again.hidden = true
    audio.stopAll()
    box.classList.remove('run')
    box.style.animationDelay = ''
    void box.offsetWidth
    try { await audio.resume() } catch (error) { /* the start button is still there */ }
  })

  mute.addEventListener('click', () => {
    const muted = audio.setMuted(mute.getAttribute('aria-pressed') !== 'true')
    mute.setAttribute('aria-pressed', String(muted))
    mute.textContent = muted ? 'Unmute' : 'Mute'
  })

  // The player suspends the clock on hidden; mirror it for the visuals.
  document.addEventListener('visibilitychange', () => box.classList.toggle('paused', document.hidden))
})()
</script>
</body>
</html>
`

const outDir = new URL('./out/', import.meta.url)
await mkdir(outDir, { recursive: true })
const outFile = new URL('./out/cue-demo.html', import.meta.url)
await writeFile(outFile, html, 'utf8')
const info = await stat(outFile)

/* ---------------------------------------------------------------- verify -- */

let failures = 0
let checks = 0
const check = (label, condition, detail = '') => {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

console.log(`-- cue-demo.html --`)
console.log(`  path: ${outFile.pathname.replace(/^\//, '')}`)
console.log(`  player script: ${sheet.script.length} B`)
console.log(`  inlined audio: ${inlined.entries.length} sound(s), ${inlined.totalBytes} B base64 (${inlined.rawBytes} B raw)`)
console.log(`  page: ${html.length} chars, ${info.size} B on disk (${(info.size / 1024).toFixed(1)} KB)`)
console.log(`  cues: ${sheet.cues.map((cue) => `${cue.at}s ${cue.name}`).join(', ')}`)
console.log(`  keyframes: ${SLAM_PCT}% = ${SLAM_AT}s, ${FLIP_PCT}% = ${(DURATION * FLIP_PCT / 100).toFixed(1)}s, ${DING_PCT}% = ${DING_AT}s`)

check('page written', info.size > 0)
check('exactly two inline sounds', (html.match(/data:audio\/wav;base64,/g) ?? []).length === 2,
  String((html.match(/data:audio\/wav;base64,/g) ?? []).length))
check('no external resource requests', !/(?:src|href)=["'](?:https?:|\/\/)/.test(html))
check('no leftover placeholders', !/__[A-Z]+__/.test(html))

// The inline audio must decode back to real, audible wav data, not just look
// like a data URI in the markup.
const dataUris = [...html.matchAll(/data:audio\/wav;base64,([A-Za-z0-9+/=]+)/g)]
for (const match of dataUris) {
  const wav = decodeWav(Buffer.from(match[1], 'base64'))
  console.log(`  inline sound: ${wav.durationSeconds.toFixed(2)}s, ${wav.sampleRate} Hz, ${wav.channels.length} ch`)
  check('inline sound decodes with audible samples', wav.channels[0].some((value) => Math.abs(value) > 0.01))
}

const playerMatch = /<script id="dsh-player">([\s\S]*?)<\/script>/.exec(html)
check('player script embedded with its own id', playerMatch !== null)
if (playerMatch !== null) {
  const player = playerMatch[1]
  check('embedded player parses', (() => { try { new Function(player); return true } catch { return false } })())
  check('embedded player exposes dshAudio', /window\.dshAudio\s*=/.test(player))
  check('embedded player schedules cue at 0.35 s', player.includes('"at":0.35'))
  check('embedded player schedules cue at 2.9 s', player.includes('"at":2.9'))
  check('embedded player carries both data URIs', (player.match(/data:audio\/wav;base64,/g) ?? []).length === 2)
}

check('start button supplies the gesture', /id="go"/.test(html) && /go\.addEventListener\('click'/.test(html) && /audio\.resume\(\)/.test(html))
check('page starts the box on the player start event', /dshaudio:start/.test(html) && /box\.style\.animationDelay/.test(html))
check('page has a moving box', /@keyframes travel/.test(html) && /id="box"/.test(html))
check('page uses the audio clock, not performance.now', !/performance\.now\s*\(/.test(html))
check('slam keyframe percent matches cue time', Math.abs(SLAM_PCT - SLAM_AT / DURATION * 100) < 1e-9)
check('ding keyframe percent matches cue time', Math.abs(DING_PCT - DING_AT / DURATION * 100) < 1e-9)
check('both keyframe percents appear in the page', html.includes(`${SLAM_PCT}%`) && html.includes(`${DING_PCT}%`))
check('page has a replay path', /id="again"/.test(html) && /audio\.stopAll\(\)/.test(html))
check('page pauses visuals when the tab hides', /visibilitychange/.test(html) && /animation-play-state: paused/.test(html))
check('page size stays reasonable for a one-file deliverable', info.size < 512 * 1024, `${Math.round(info.size / 1024)} KB`)

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0
  ? `OK: demo page is self-contained and cue-aligned -> ${outFile.pathname.replace(/^\//, '')}`
  : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
