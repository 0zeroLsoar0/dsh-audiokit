/**
 * Lip-sync timing and formatter tests.
 *
 * Two things are pinned down here, both of which are easy to break silently:
 *
 * 1. `minDurationMs` is a real floor. At 24 fps a 60 ms minimum is 1.44 frames;
 *    `Math.round` turned that into 1 frame — i.e. no floor at all — so a single
 *    noisy frame could flip the mouth. The test builds a signal with a
 *    deliberate one-frame fricative burst inside silence-then-vowel and checks
 *    that the default 60 ms suppresses it, while a 40 ms minimum (0.96 frames,
 *    legitimately 1 frame) keeps it: the control proves the signal really has a
 *    one-frame run and the difference is the rounding.
 *
 * 2. The textual formatters interpolate `viseme` into an SRT cue and into CSS
 *    class/keyframes names. A frame list from outside this module is therefore
 *    untrusted input: an unknown label is replaced with `none` (closed mouth)
 *    and counted in `warnings`, and the CSS selector filter is checked with a
 *    hand-built malicious label.
 *
 * Run it with node (the package is ESM):
 *
 *   node test/lipsync.mjs
 */

import { analyzeVisemes, visemeToSrt, visemeToTimeline, VISEMES } from '../lib/lipsync.js'

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : `  (${detail})`}`)
}

const fmt = (value, digits = 2) => Number(value).toFixed(digits)

/** Runs of equal labels with their frame counts and start times. */
function runsOf (frames) {
  const runs = []
  let current = null
  for (const frame of frames) {
    if (current !== null && frame.viseme === current.viseme) {
      current.frames += 1
      continue
    }
    current = { viseme: frame.viseme, frames: 1, at: frame.t }
    runs.push(current)
  }
  return runs
}

/* -------------------------- minDurationMs at 24 fps -------------------- */

console.log('-- minDurationMs: one frame is below a 60 ms floor at 24 fps --')
{
  const RATE = 44100
  const FPS = 24
  const BLOCK = Math.round(RATE / FPS) // one frame boundary in samples
  const silence = 5 * BLOCK + Math.round(BLOCK / 2)
  const burstFrames = BLOCK
  const toneFrames = Math.round(1.5 * RATE)
  const signal = new Float32Array(silence + burstFrames + toneFrames)

  // Deterministic noise, high-passed so its centroid lands in the SS range: a
  // DD plosive is deliberately exempt from short-run merging, so it could not
  // demonstrate the floor.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }
  let previous = 0
  for (let i = 0; i < burstFrames; i += 1) {
    const value = rand() * 2 - 1
    signal[silence + i] = (value - previous) * 0.7
    previous = value
  }
  // A steady voiced vowel after the burst, so the burst's neighbours are `none`
  // (silence) and a vowel: the two disagree, which is what stops despiking from
  // removing the one-frame run for us.
  for (let i = 0; i < toneFrames; i += 1) {
    const t = i / RATE
    signal[silence + burstFrames + i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.18 * Math.sin(2 * Math.PI * 440 * t) + 0.06 * Math.sin(2 * Math.PI * 660 * t)
  }

  const reported = {}
  for (const minDurationMs of [40, 60]) {
    const track = analyzeVisemes(signal, RATE, { fps: FPS, minDurationMs })
    const runs = runsOf(track.frames)
    reported[minDurationMs] = { track, runs, shortest: Math.min(...runs.map((run) => run.frames)) }
    console.log(`  minDurationMs=${minDurationMs}: ${track.frames.length} frames, shortest run ${reported[minDurationMs].shortest} frame(s), ` +
      `runs ${runs.map((run) => `${run.viseme}x${run.frames}`).join(' ')}`)
  }

  // 60 ms / 24 fps = 1.44 frames. round() -> 1 (no merging), ceil() -> 2.
  const strict = reported[60]
  const loose = reported[40]
  check('60 ms removes every one-frame run at 24 fps', strict.shortest >= 2, `${strict.shortest} frame(s)`)
  check('the one-frame burst is merged away at 60 ms', strict.track.counts.SS === 0, `SS:${strict.track.counts.SS}`)
  check('a 40 ms minimum still allows the one-frame burst (control)', loose.track.counts.SS === 1 && loose.shortest === 1,
    `SS:${loose.track.counts.SS} shortest ${loose.shortest}`)
  check('the merge does not invent or lose frames', strict.track.frames.length === loose.track.frames.length,
    `${strict.track.frames.length} vs ${loose.track.frames.length}`)
  check('the merged track still has a vowel', strict.track.counts.MM > 20, `MM:${strict.track.counts.MM}`)
}

/* ---------------------------- viseme whitelist ------------------------- */

console.log('\n-- unknown visemes are replaced before they reach a formatter --')
{
  const frames = [
    { t: 0.0, viseme: 'AA', openness: 1, energy: 1, voiced: true },
    { t: 0.1, viseme: 'none', openness: 0, energy: 0, voiced: false },
    { t: 0.2, viseme: 'PA<script>alert(1)</script>', openness: 0.5, energy: 0.5, voiced: false },
    { t: 0.3, viseme: undefined, openness: 0.2, energy: 0.2, voiced: false }
  ]

  const srtWarnings = []
  const srt = visemeToSrt(frames, { fps: 10, includeSilence: true, warnings: srtWarnings })
  const cueTexts = srt.split(/\n/).filter((line) => line !== '' && !/^\d+$/.test(line) && !/-->/.test(line))
  console.log(`  warnings: ${JSON.stringify(srtWarnings)}`)
  console.log(`  srt cue texts: ${cueTexts.join(', ')}`)
  check('SRT cue text is always a known viseme', cueTexts.every((text) => VISEMES.includes(text)), cueTexts.join(','))
  check('SRT carries no injected markup', !/PA|script|alert/.test(srt), srt)
  check('the replacement is reported once', srtWarnings.length === 1 && /outside the whitelist/.test(srtWarnings[0]),
    JSON.stringify(srtWarnings))
  check('the replacement warning counts every bad frame', /2 frame\(s\)/.test(srtWarnings[0] ?? ''), srtWarnings[0] ?? '')

  const silentSrt = visemeToSrt(frames, { fps: 10 })
  check('SRT without silence omits the replaced frames instead of leaking them', !/PA|script/.test(silentSrt), silentSrt)

  const cssWarnings = []
  const css = visemeToTimeline(frames, 'css', { fps: 10, duration: 0.4, warnings: cssWarnings })
  const classes = [...css.matchAll(/\.dsh-mouth > \.v-([A-Za-z0-9_-]+) \{/g)].map((match) => match[1])
  const keyframes = [...css.matchAll(/@keyframes dsh-v-([A-Za-z0-9_-]+) \{/g)].map((match) => match[1])
  console.log(`  css classes: ${classes.join(', ') || '(none)'}; keyframes: ${keyframes.join(', ') || '(none)'}`)
  check('CSS class names are whitelisted visemes', classes.length > 0 && classes.every((name) => VISEMES.includes(name)), classes.join(','))
  check('CSS keyframe names are whitelisted visemes', keyframes.length > 0 && keyframes.every((name) => VISEMES.includes(name)), keyframes.join(','))
  check('CSS contains no injected markup', !/<script|<\/script|alert/.test(css), css)
  check('CSS reports the replacement', cssWarnings.length === 1, JSON.stringify(cssWarnings))

  const ae = visemeToTimeline(frames, 'ae')
  const shapes = ae.split('\n').map((line) => line.split('\t')[1]).filter((shape) => shape !== undefined)
  check('AE shapes are whitelisted visemes', shapes.length > 0 && shapes.every((shape) => VISEMES.includes(shape)), shapes.join(','))

  const json = JSON.parse(visemeToTimeline(frames, 'json', { fps: 10 }))
  check('JSON frames are whitelisted', json.frames.every((frame) => VISEMES.includes(frame.viseme)),
    json.frames.map((frame) => frame.viseme).join(','))
  check('JSON counts sum to the frame count',
    VISEMES.reduce((sum, viseme) => sum + (json.counts[viseme] ?? 0), 0) === json.frames.length,
    JSON.stringify(json.counts))

  const validWarnings = []
  const valid = visemeToTimeline([
    { t: 0, viseme: 'AA', openness: 1, energy: 1, voiced: true },
    { t: 0.1, viseme: 'none', openness: 0, energy: 0, voiced: false }
  ], 'json', { fps: 10, warnings: validWarnings })
  check('a valid track produces no warning', validWarnings.length === 0 && valid.includes('"AA"'))
}

/* -------------------------------- summary ------------------------------ */

console.log('')
console.log(failures === 0 ? 'OK: lip-sync timing and formatters behave' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
