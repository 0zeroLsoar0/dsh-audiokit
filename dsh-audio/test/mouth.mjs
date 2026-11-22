/**
 * Text-driven mouth tests: visemes from written words, with no audio at all.
 *
 * Every case is derived from the text itself (known syllables, known punctua-
 * tion, known frame rate), so the assertions compare the module against the
 * thing it was asked to mouth, not against its own previous output. Numbers are
 * printed so a regression is visible as a changed value, not only as a failed
 * check. Same style as test/visual.mjs.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { VISEMES } from '../lib/lipsync.js'
import {
  MOUTH_ALIGNMENTS,
  MOUTH_FORMATS,
  MOUTH_STYLES,
  formatMouth,
  mouthFromText,
  mouthFromTimeline
} from '../lib/mouth.js'
import { registerMouthTools } from '../lib/tools-mouth.js'

const scratch = fileURLToPath(new URL('./out/mouth/', import.meta.url))
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

let failures = 0
function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

/** Runs of equal visemes, with frame counts and start times. */
function runsOf (frames) {
  const runs = []
  let current = null
  for (const frame of frames) {
    if (current !== null && current.viseme === frame.viseme) {
      current.frames += 1
      continue
    }
    current = { viseme: frame.viseme, frames: 1, at: frame.t }
    runs.push(current)
  }
  return runs
}

function countsSum (counts) {
  return VISEMES.reduce((sum, viseme) => sum + (counts[viseme] ?? 0), 0)
}

function shapeLine (counts) {
  return VISEMES.filter((viseme) => counts[viseme] > 0)
    .map((viseme) => `${viseme} ${counts[viseme]}`)
    .join(' · ')
}

/* ------------------------------------------- text: "ma mi mu" at 96 bpm -- */

console.log('-- text: "ma mi mu" at 96 bpm --')
const spoken = mouthFromText({ text: 'ma mi mu', bpm: 96, fps: 24 })
const spokenRuns = runsOf(spoken.frames)
const spokenSequence = spokenRuns.map((run) => run.viseme)
console.log(`frames=${spoken.frames.length} duration=${spoken.durationSeconds}s syllables=${spoken.syllableCount} ` +
  `shapes ${shapeLine(spoken.counts)}`)
console.log(`runs ${spokenRuns.map((run) => `${run.viseme}x${run.frames}@${run.at.toFixed(3)}s`).join(' ')}`)

check('three syllables', spoken.syllableCount === 3, String(spoken.syllableCount))
check('M closes before every vowel', spokenRuns.filter((run) => run.viseme === 'MM').length === 3,
  `${spokenRuns.filter((run) => run.viseme === 'MM').length} MM runs`)
check('sequence is MM AA MM EE MM OO none',
  spokenSequence.join(' ') === 'MM AA MM EE MM OO none', spokenSequence.join(' '))
check('counts sum to frame count', countsSum(spoken.counts) === spoken.frames.length,
  `${countsSum(spoken.counts)} != ${spoken.frames.length}`)
check('openness in 0..1', spoken.frames.every((frame) => frame.openness >= 0 && frame.openness <= 1))
check('energy in 0..1', spoken.frames.every((frame) => frame.energy >= 0 && frame.energy <= 1))
check('frames finite', spoken.frames.every((frame) =>
  Number.isFinite(frame.t) && Number.isFinite(frame.openness) && Number.isFinite(frame.energy)))
check('viseme is known', spoken.frames.every((frame) => VISEMES.includes(frame.viseme)))
check('source is text', spoken.source === 'text')

/* ------------------------------------------------- text: frame geometry -- */

console.log('-- text: frame geometry --')
for (const fps of [12, 24, 30, 60]) {
  const track = mouthFromText({ text: 'ma mi mu', bpm: 96, fps })
  const expected = Math.round(track.durationSeconds * fps)
  let worstSpacing = 0
  let monotonic = true
  for (let index = 1; index < track.frames.length; index += 1) {
    const delta = track.frames[index].t - track.frames[index - 1].t
    if (delta <= 0) monotonic = false
    worstSpacing = Math.max(worstSpacing, Math.abs(delta - 1 / fps))
  }
  console.log(`fps=${String(fps).padStart(3)} frames=${String(track.frames.length).padStart(3)} ` +
    `round(duration*fps)=${String(expected).padStart(3)} worstSpacingErr=${(worstSpacing * 1e6).toFixed(2)}us`)
  check(`fps ${fps} frame count`, track.frames.length === expected, `${track.frames.length} != ${expected}`)
  check(`fps ${fps} spacing is 1/fps`, worstSpacing < 1e-5, `${(worstSpacing * 1e6).toFixed(2)}us`)
  check(`fps ${fps} times monotonic`, monotonic)
}

const fitted = mouthFromText({ text: 'ma mi mu', bpm: 96, fps: 24, durationSeconds: 2.5 })
console.log(`durationSeconds=2.5 -> frames=${fitted.frames.length} reported=${fitted.durationSeconds}s`)
check('forced duration yields the frame grid', fitted.frames.length === 60 &&
  fitted.frames.length === Math.round(fitted.durationSeconds * 24), String(fitted.frames.length))

const squeezed = mouthFromText({ text: 'ma mi mu', bpm: 96, fps: 24, durationSeconds: 0.5 })
console.log(`durationSeconds=0.5 -> frames=${squeezed.frames.length} reported=${squeezed.durationSeconds}s ` +
  `syllables=${squeezed.syllableCount}`)
check('a short duration compresses the text instead of cutting it',
  squeezed.frames.length === 12 && squeezed.durationSeconds === 0.5 && squeezed.syllableCount === 3,
  `${squeezed.frames.length}/${squeezed.durationSeconds}`)

const even = mouthFromText({ text: 'ma mi mu', alignment: 'even', fps: 24, durationSeconds: 3 })
console.log(`even alignment -> frames=${even.frames.length} alignment=${even.alignment}`)
check('even alignment fills the requested duration', even.frames.length === 72 && even.alignment === 'even',
  `${even.frames.length}/${even.alignment}`)

/* -------------------------------------------------- text: coarticulation -- */

console.log('-- text: coarticulation --')
const continuous = mouthFromText({ text: 'ma mi mu ma mi mu ma mi mu', bpm: 96, fps: 24 })
let changes = 0
for (let index = 1; index < continuous.frames.length; index += 1) {
  if (continuous.frames[index].viseme !== continuous.frames[index - 1].viseme) changes += 1
}
const changesPerSecond = changes / continuous.durationSeconds
const continuousRuns = runsOf(continuous.frames)
let flicker = 0
for (let index = 1; index < continuousRuns.length - 1; index += 1) {
  if (continuousRuns[index].frames === 1 &&
    continuousRuns[index - 1].viseme === continuousRuns[index + 1].viseme) flicker += 1
}
console.log(`frames=${continuous.frames.length} duration=${continuous.durationSeconds}s changes=${changes} ` +
  `perSecond=${changesPerSecond.toFixed(2)} singleFrameFlicker=${flicker}`)
check('fewer than 8 viseme changes per second', changesPerSecond < 8, `${changesPerSecond.toFixed(2)}/s`)
check('no single-frame flicker', flicker === 0, String(flicker))
check('every run lasts at least one frame', continuousRuns.every((run) => run.frames >= 1))

/* ------------------------------ text: punctuation, closing rest, ranges -- */

console.log('-- text: punctuation, closing rest, ranges --')
const punctuated = mouthFromText({ text: 'ma, mi! mu', bpm: 96, fps: 24 })
const punctuatedRuns = runsOf(punctuated.frames)
const rests = punctuatedRuns.filter((run) => run.viseme === 'none')
const lastFrame = punctuated.frames[punctuated.frames.length - 1]
console.log(`frames=${punctuated.frames.length} rests=${rests.length} ` +
  `restFrames=[${rests.map((run) => run.frames).join(',')}] last=${lastFrame.viseme} open=${lastFrame.openness}`)
check('punctuation closes the mouth', rests.length >= 2, String(rests.length))
check('punctuation rests last longer than one frame', rests.every((run) => run.frames >= 2),
  JSON.stringify(rests.map((run) => run.frames)))
check('track ends closed', lastFrame.viseme === 'none', lastFrame.viseme)
check('last jaw is nearly closed', lastFrame.openness < 0.08, String(lastFrame.openness))
check('rest frames are not voiced', punctuated.frames
  .filter((frame) => frame.viseme === 'none')
  .every((frame) => frame.voiced === false))
check('openness and energy in range', punctuated.frames.every((frame) =>
  frame.openness >= 0 && frame.openness <= 1 && frame.energy >= 0 && frame.energy <= 1))

/* ---------------------------------------------------- text: output formats -- */

console.log('-- text: formats --')
const jsonText = formatMouth(spoken, 'json')
const jsonTrack = JSON.parse(jsonText)
console.log(`json frames=${jsonTrack.frames.length} source=${jsonTrack.source} bytes=${Buffer.byteLength(jsonText)}`)
check('json parses', jsonTrack.format === 'dsh-audio-lipsync' && Array.isArray(jsonTrack.frames))
check('json fps', jsonTrack.fps === 24, String(jsonTrack.fps))
check('json frame count', jsonTrack.frames.length === spoken.frames.length,
  `${jsonTrack.frames.length}/${spoken.frames.length}`)
check('json counts match', jsonTrack.counts.AA === spoken.counts.AA)
check('json marks the text source', jsonTrack.source === 'text' && jsonTrack.syllables === 3)
check('json has no NaN', !/NaN|null/.test(jsonText))

const srt = formatMouth(spoken, 'srt')
const srtCues = srt.trim().split(/\n\n/).filter((block) => block.trim() !== '')
const srtTimes = [...srt.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)]
const spokenRunCount = spokenRuns.filter((run) => run.viseme !== 'none').length
console.log(`srt cues=${srtCues.length} timecodes=${srtTimes.length} bytes=${Buffer.byteLength(srt)}`)
check('srt cue count matches spoken runs', srtCues.length === spokenRunCount, `${srtCues.length} != ${spokenRunCount}`)
check('srt timecodes well formed', srtTimes.length === srtCues.length)
check('srt cue body is a viseme', srtCues.every((block) => VISEMES.includes(block.split('\n')[2])))

const css = formatMouth(spoken, 'css')
console.log(`css lines=${css.split('\n').length} bytes=${Buffer.byteLength(css)} ` +
  `hasJaw=${css.includes('@keyframes dsh-jaw')} hasViseme=${/@keyframes dsh-v-AA/.test(css)}`)
check('css has jaw keyframes', css.includes('@keyframes dsh-jaw'))
check('css has a viseme step track', /@keyframes dsh-v-(AA|EH|EE|OH|OO|MM|FF|TH|SS|DD)/.test(css))
check('css uses no @property', !css.includes('@property'))
check('css declares the duration', css.includes('--dsh-duration:'))
check('css has a scaleY jaw stop', /transform: scaleY\(/.test(css))

const ae = formatMouth(spoken, 'ae')
const aeLines = ae.trim().split('\n').filter((line) => line !== '')
const aeFields = aeLines.map((line) => line.split('\t'))
console.log(`ae keyframes=${aeLines.length} first=${JSON.stringify(aeLines[0])} bytes=${Buffer.byteLength(ae)}`)
check('ae has two tab-separated columns', aeFields.every((fields) => fields.length === 2))
check('ae columns are time + viseme', aeFields.every((fields) =>
  Number.isFinite(Number(fields[0])) && VISEMES.includes(fields[1])))
check('ae time series ascending', aeFields.every((fields, index) =>
  index === 0 || Number(fields[0]) > Number(aeFields[index - 1][0])))

/* ------------------------------------------------------- text: styles ---- */

console.log('-- text: styles --')
const excited = mouthFromText({ text: 'ma mi mu', style: 'excited', fps: 24 })
const tired = mouthFromText({ text: 'ma mi mu', style: 'tired', fps: 24 })
const maxOpen = (track) => Math.max(...track.frames.map((frame) => frame.openness))
const maxEnergy = (track) => Math.max(...track.frames.map((frame) => frame.energy))
console.log(`maxOpenness neutral=${maxOpen(spoken)} excited=${maxOpen(excited)} tired=${maxOpen(tired)} · ` +
  `maxEnergy neutral=${maxEnergy(spoken)} excited=${maxEnergy(excited)} tired=${maxEnergy(tired)}`)
check('excited opens wider than tired', maxOpen(excited) > maxOpen(tired) + 0.1,
  `${maxOpen(excited)} vs ${maxOpen(tired)}`)
check('tired is quieter than neutral', maxEnergy(tired) < maxEnergy(spoken),
  `${maxEnergy(tired)} vs ${maxEnergy(spoken)}`)
check('style names are exported', MOUTH_STYLES.join(',') === 'neutral,excited,tired')

/* ------------------------------------------------- text: Chinese input --- */

console.log('-- text: Chinese (8 characters, no pinyin dictionary) --')
const chineseText = '今天天气真不错啊'
let han = null
let hanError = ''
try {
  han = mouthFromText({ text: chineseText, bpm: 96, fps: 24 })
} catch (error) {
  hanError = String(error?.message ?? error)
}
check('Chinese input does not throw', han !== null, hanError)
if (han !== null) {
  console.log(`frames=${han.frames.length} syllables=${han.syllableCount} warnings=${han.warnings.length} ` +
    `shapes ${shapeLine(han.counts)}`)
  console.log(`warning: ${han.warnings[0] ?? '-'}`)
  check('eight characters map to eight syllables', [...chineseText].length === 8 && han.syllableCount === 8,
    `${han.syllableCount}`)
  check('Chinese counts sum to frame count', countsSum(han.counts) === han.frames.length,
    `${countsSum(han.counts)} != ${han.frames.length}`)
  check('Chinese track has shapes', han.frames.some((frame) => frame.viseme !== 'none'))
  check('Chinese warning explains romanisation', han.warnings.some((line) => /pinyin/.test(line)),
    JSON.stringify(han.warnings))
}

console.log('-- text: pinyin with tone marks --')
const toned = mouthFromText({ text: 'nǐ hǎo', bpm: 96, fps: 24 })
console.log(`syllables=${toned.syllableCount} shapes ${shapeLine(toned.counts)} sequence ` +
  `${runsOf(toned.frames).map((run) => run.viseme).join(' ')}`)
check('tone-marked pinyin keeps its vowels', toned.syllableCount === 2 && toned.counts.EE > 0 &&
  toned.counts.OH > 0, shapeLine(toned.counts))
check('tone-marked pinyin starts with the n closure', runsOf(toned.frames)[0].viseme === 'DD',
  runsOf(toned.frames)[0].viseme)

console.log('-- text: English digraphs --')
const english = mouthFromText({ text: 'the thin path', bpm: 96, fps: 24 })
console.log(`syllables=${english.syllableCount} shapes ${shapeLine(english.counts)}`)
check('English th maps to TH', english.counts.TH > 0, shapeLine(english.counts))

/* ----------------------------------------------- text: timed cue lines -- */

console.log('-- text: timed cues (mouthFromTimeline) --')
const timed = mouthFromTimeline({
  cues: [{ at: 0, text: 'ma', dur: 0.5 }, { at: 1, text: 'mi mu', dur: 1 }],
  fps: 24
})
const gapFrames = timed.frames.slice(Math.round(0.5 * 24), Math.round(1 * 24))
console.log(`frames=${timed.frames.length} duration=${timed.durationSeconds}s cues=${timed.cueCount} ` +
  `syllables=${timed.syllableCount} gapClosed=${gapFrames.every((frame) => frame.viseme === 'none')}`)
check('timeline duration is the last cue end', timed.frames.length === 48 &&
  Math.abs(timed.durationSeconds - 2) < 1e-6, `${timed.frames.length}/${timed.durationSeconds}`)
check('timeline counts the syllables', timed.syllableCount === 3, String(timed.syllableCount))
check('gap between cues is closed', gapFrames.length > 0 &&
  gapFrames.every((frame) => frame.viseme === 'none'))
check('timeline counts sum to frame count', countsSum(timed.counts) === timed.frames.length)
check('timeline starts at t=0', timed.frames[0].t === 0)
check('timeline source is text', timed.source === 'text' && timed.alignment === 'cues')

/* -------------------------------------------------- text: determinism ---- */

console.log('-- text: determinism --')
const runA = mouthFromText({ text: 'ma mi mu', bpm: 96, fps: 24 })
const runB = mouthFromText({ text: 'ma mi mu', bpm: 96, fps: 24 })
const runC = mouthFromText({ text: 'ma mi mu', bpm: 120, fps: 24 })
const cueA = mouthFromTimeline({ cues: [{ at: 0, text: 'ma', dur: 0.5 }], fps: 24 })
const cueB = mouthFromTimeline({ cues: [{ at: 0, text: 'ma', dur: 0.5 }], fps: 24 })
console.log(`sameTextIdentical=${JSON.stringify(runA) === JSON.stringify(runB)} ` +
  `bpmChangesTiming=${runA.durationSeconds !== runC.durationSeconds} ` +
  `sameCuesIdentical=${JSON.stringify(cueA) === JSON.stringify(cueB)}`)
check('text track deterministic', JSON.stringify(runA) === JSON.stringify(runB))
check('cue track deterministic', JSON.stringify(cueA) === JSON.stringify(cueB))
check('bpm changes the timing', runA.durationSeconds !== runC.durationSeconds,
  `${runA.durationSeconds} vs ${runC.durationSeconds}`)

/* ----------------------------------------------- performance: 30 s @30 --- */

console.log('-- performance: 30 s at 30 fps --')
const longText = 'ma mi mu '.repeat(60)
const started = performance.now()
const longTrack = mouthFromText({ text: longText, bpm: 96, fps: 30, durationSeconds: 30 })
const elapsed = performance.now() - started
console.log(`frames=${longTrack.frames.length} syllables=${longTrack.syllableCount} ${elapsed.toFixed(2)}ms (budget 50ms)`)
check('30 s at 30 fps under 50 ms', elapsed < 50, `${elapsed.toFixed(2)}ms`)
check('30 s frame count', longTrack.frames.length === 900, String(longTrack.frames.length))

/* --------------------------------------------------- tools: audio_mouth -- */

console.log('-- tools: audio_mouth --')
const registered = new Map()
const toolCtx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => scratch } : undefined)
}
const toolExec = { agent: { session: { id: 'mouth-test' } } }
registerMouthTools(toolCtx)
check('registers exactly one tool', registered.size === 1 && registered.has('audio_mouth'),
  [...registered.keys()].join(','))
const tool = registered.get('audio_mouth')
const call = (args) => tool.execute(args, toolExec)
console.log(`alignments=${tool.parameters.properties.alignment.enum.join(',')} ` +
  `formats=${tool.parameters.properties.format.enum.join(',')} ` +
  `styles=${tool.parameters.properties.style.enum.join(',')}`)
check('tool alignment enum matches the module', JSON.stringify(tool.parameters.properties.alignment.enum) ===
  JSON.stringify(MOUTH_ALIGNMENTS))
check('tool format enum matches the module', JSON.stringify(tool.parameters.properties.format.enum) ===
  JSON.stringify(MOUTH_FORMATS))

const toolResult = await call({ text: 'ma mi mu', bpm: 96, fps: 24, format: 'json', out: 'tracks/mouth.json' })
const toolFile = JSON.parse(await readFile(join(scratch, 'tracks/mouth.json'), 'utf8'))
console.log(`tool: ${toolResult.text.split(' — ')[0]}`)
console.log(`tool: path=${toolResult.relativePath} bytes=${toolResult.bytes} frames=${toolResult.frameCount} ` +
  `preview=${toolResult.previewFrames.length}`)
check('tool writes the requested path', toolResult.relativePath === 'tracks/mouth.json',
  String(toolResult.relativePath))
check('tool text has the required shape', /^text mouth: \d+ frames @24fps, [A-Z]/.test(toolResult.text),
  toolResult.text)
check('tool text is one line', typeof toolResult.text === 'string' && !toolResult.text.includes('\n'))
check('tool file parses', toolFile.frames.length === toolResult.frameCount && toolFile.source === 'text')
check('tool preview bounded', toolResult.previewFrames.length === Math.min(24, toolResult.frameCount))
check('tool counts sum', countsSum(toolResult.counts) === toolResult.frameCount)

const srtTool = await call({ text: 'ma mi mu', fps: 24, format: 'srt', out: 'tracks/mouth' })
const srtText = await readFile(join(scratch, 'tracks/mouth.srt'), 'utf8')
check('tool appends the format extension', srtTool.relativePath === 'tracks/mouth.srt' && /-->/.test(srtText),
  String(srtTool.relativePath))

const cueTool = await call({
  cues: [{ at: 0, text: 'ma', dur: 0.5 }, { at: 1, text: 'mi mu', dur: 1 }],
  fps: 24,
  out: 'tracks/cues.json'
})
console.log(`tool cues: ${cueTool.text.split(' — ')[0]}`)
check('tool cues mode is duration driven', cueTool.frameCount === 48 && cueTool.cueCount === 2,
  `${cueTool.frameCount}/${cueTool.cueCount}`)

const inlineResult = await call({ text: 'ma', fps: 24 })
console.log(`tool inline: path=${inlineResult.path} frames=${inlineResult.frameCount}`)
check('tool can return without writing', inlineResult.path === null && inlineResult.relativePath === null &&
  inlineResult.frameCount > 0)

let missingThrew = false
try {
  await call({})
} catch (error) {
  missingThrew = /text|cues/.test(String(error?.message ?? error))
}
check('tool needs text or cues', missingThrew)
let bothThrew = false
try {
  await call({ text: 'ma', cues: [{ at: 0, text: 'ma', dur: 1 }] })
} catch (error) {
  bothThrew = /not both/.test(String(error?.message ?? error))
}
check('tool rejects text and cues together', bothThrew)

/* ------------------------------------------------------------ summary --- */

await rm(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nOK: text-driven mouths behave' : `\nFAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
