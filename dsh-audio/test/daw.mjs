/**
 * Project-export tests: the four formats, written and then parsed back.
 *
 * A project file cannot be opened in an editor here, so the only honest way to
 * test it is to parse the bytes the writer produced and check the same numbers
 * the writer was given: timecode arithmetic for the EDL (including 24 vs 25 fps
 * and drop-frame), POSITION/LENGTH/VOLPAN for the RPP, quoted bytes for the CSV,
 * and tab-separated spans for the labels. The tool layer is exercised through a
 * fake Cordis context with a real wav on disk, which is what proves the duration
 * measurement and the project-relative media path.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPORT_FORMATS,
  exportCsv,
  exportEdl,
  exportLabels,
  exportProject,
  exportReaper,
  frameRateInfo,
  parseEdl,
  parseRpp,
  secondsToTimecode,
  timecodeToSeconds
} from '../lib/daw.js'
import { registerDawTools, verifyEdl } from '../lib/tools-daw.js'
import { encodeWav } from '../lib/wav.js'

const outDir = new URL('./out/daw/', import.meta.url)
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

const saved = []
async function save (name, text) {
  const bytes = Buffer.from(text, 'utf8')
  await writeFile(new URL(name, outDir), bytes)
  saved.push({ name, bytes: bytes.length })
  return bytes.length
}

const ASCII_ONLY = /^[\n\x20-\x7e]*$/

const CUES = [
  { name: 'boom', path: 'assets/audio/impact-0001.wav', at: 0, duration: 1.5 },
  { name: 'ding', path: 'assets/audio/chime-0002.wav', at: 1.5, duration: 0.75, gainDb: -6, fadeIn: 0.05, fadeOut: 0.1 },
  { name: 'swell', path: 'assets/audio/riser-0003.wav', at: 2.25, duration: 1 }
]

const TRACKS = [
  { name: 'bed', path: 'assets/audio/texture-0001.wav', offsetSeconds: 0, duration: 4, gainDb: -12, fadeIn: 0.5, fadeOut: 1 },
  { name: 'hit, "big" one', path: 'assets/audio/impact-0002.wav', offsetSeconds: 1.25, duration: 2.5, gainDb: -3.5 },
  { name: 'tail', path: 'assets/audio/reverb-0003.wav', offsetSeconds: 7.125, duration: 0.875, gainDb: 2.25, fadeIn: 0.025, fadeOut: 0.075 }
]

/* ------------------------------------------------------------------------ edl -- */

console.log('-- edl: structure --')
const edl = exportEdl({ cues: CUES, frameRate: 24 })
await save('cues-24fps.edl', edl.text)
console.log(edl.text.split('\n').map((line) => `  |${line}`).join('\n'))

const EVENT_1 = '001  AX       A     C        00:00:00:00 00:00:01:12 01:00:00:00 01:00:01:12'
const eventLines = edl.text.split('\n').filter((line) => /^\d{3}\s/.test(line))
check('three events', edl.events === 3, String(edl.events))
check('three event lines', eventLines.length === 3, String(eventLines.length))
check('no warnings for a clean cue set', edl.warnings.length === 0, JSON.stringify(edl.warnings))
check('title line', edl.text.startsWith('TITLE:   CUE SHEET\nFCM: NON-DROP FRAME\n'), JSON.stringify(edl.text.slice(0, 40)))
check('canonical 76 column event line', eventLines[0].length === 76, `${eventLines[0].length} chars: ${JSON.stringify(eventLines[0])}`)
check('event 1 bytes are canonical', eventLines[0] === EVENT_1, JSON.stringify(eventLines[0]))
check('three FROM CLIP NAME comments', (edl.text.match(/\* FROM CLIP NAME: /g) ?? []).length === 3)
check('clip name is the media file name', edl.text.includes('* FROM CLIP NAME: impact-0001.wav\n'))
check('source file comment is the cue path', edl.text.includes('* SOURCE FILE: assets/audio/impact-0001.wav\n'))
check('level comment only when there is a level', edl.text.includes('* CUE LEVEL: gain -6 dB, fade in 0.05 s, fade out 0.1 s'))
check('edl is ascii', ASCII_ONLY.test(edl.text), JSON.stringify(edl.text.match(/[^\n\x20-\x7e]/)?.[0]))
check('edl has no carriage return', !edl.text.includes('\r'))
check('edl ends with one newline', edl.text.endsWith('\n') && !edl.text.endsWith('\n\n'))
check('edl bytes match the text', edl.bytes === Buffer.byteLength(edl.text, 'utf8'), `${edl.bytes}`)
check('edl timeline length', edl.durationSeconds === 3.25, String(edl.durationSeconds))
check('record start is 01:00:00:00', edl.recordStart === '01:00:00:00', edl.recordStart)

const parsedEdl = parseEdl(edl.text)
check('parse back: event count', parsedEdl.events.length === 3, String(parsedEdl.events.length))
check('parse back: title', parsedEdl.title === 'CUE SHEET', String(parsedEdl.title))
check('parse back: fcm', parsedEdl.fcm === 'NON-DROP FRAME', String(parsedEdl.fcm))
check('parse back: not drop frame', parsedEdl.dropFrame === false)
check('parse back: no unrecognised lines', parsedEdl.warnings.length === 0, JSON.stringify(parsedEdl.warnings))
check('parse back: clip names', parsedEdl.events.map((event) => event.clipName).join(',') === 'impact-0001.wav,chime-0002.wav,riser-0003.wav',
  JSON.stringify(parsedEdl.events.map((event) => event.clipName)))

console.log('\n-- edl: arithmetic parsed back from my own output --')
for (const fps of [24, 25, 30, 29.97]) {
  const info = frameRateInfo(fps)
  const result = exportEdl({ cues: CUES, frameRate: fps })
  const parsed = parseEdl(result.text)
  // Positions are compared in frames from the record start, not in seconds from
  // zero: at 29.97 the timecode 01:00:00:00 is 107892 frames = 3599.9964 s, so
  // subtracting 3600 s would charge the export for the timecode's own offset.
  const startFrame = Math.round(3600 * info.fps)
  let previousOut = null
  let worstFrames = 0
  let contiguous = true
  let sourcesUntrimmed = true
  let endsQuantised = true
  const shown = []
  for (let index = 0; index < parsed.events.length; index += 1) {
    const event = parsed.events[index]
    const cue = CUES[index]
    const srcIn = timecodeToSeconds(event.srcIn, fps)
    const srcOut = timecodeToSeconds(event.srcOut, fps)
    const recIn = timecodeToSeconds(event.recIn, fps)
    const recOut = timecodeToSeconds(event.recOut, fps)
    const offsetFrames = Math.round(recIn * info.fps) - startFrame
    // Source in is the start of the file and the source length is the record length.
    if (Math.abs(srcIn) > 1e-9) sourcesUntrimmed = false
    if (Math.abs((srcOut - srcIn) - (recOut - recIn)) > 1e-9) sourcesUntrimmed = false
    // The quantised position is within half a frame of the requested one.
    const frameError = Math.abs((offsetFrames / info.fps) - cue.at) * info.fps
    worstFrames = Math.max(worstFrames, frameError)
    // Event boundaries are quantised from absolute times, so the end of the cue
    // is round((at + duration) * fps) frames after the record start.
    const expectedOut = Math.round((cue.at + cue.duration) * info.fps)
    if (Math.round(recOut * info.fps) - startFrame !== expectedOut) endsQuantised = false
    // Record ins are cumulative: each event starts where the previous one ended.
    if (previousOut !== null && Math.abs(recIn - previousOut) > 1e-9) contiguous = false
    previousOut = recOut
    shown.push(`${event.recIn}-${event.recOut}`)
  }
  console.log(`  ${String(fps).padStart(5)} fps  ${shown.join('  ')}  worst ${worstFrames.toFixed(3)} frames, length ${result.durationSeconds}s`)
  check(`${fps}: three events`, parsed.events.length === 3, String(parsed.events.length))
  check(`${fps}: source starts at 0 and lasts as long as the event`, sourcesUntrimmed)
  check(`${fps}: record in within half a frame`, worstFrames <= 0.5 + 1e-6, `${worstFrames} frames`)
  check(`${fps}: record out quantised from the absolute end`, endsQuantised)
  check(`${fps}: record times are cumulative`, contiguous)
  check(`${fps}: no spurious overlap warning`, result.warnings.length === 0, JSON.stringify(result.warnings))
  check(`${fps}: timeline length`, Math.abs(result.durationSeconds - CUES[CUES.length - 1].at - CUES[CUES.length - 1].duration) <= 1 / info.fps,
    `${result.durationSeconds} vs 3.25`)
}

console.log('\n-- edl: event numbers follow the timeline, not the input order --')
// The bug this pins: the writer numbered events with the *input* index, so a
// cue list that arrived out of order produced 002, 001, 003 — a sequence a
// CMX3600 reader rejects (or silently plays out of order). The shuffled list is
// the sorted list permuted, so the two exports must be byte-identical.
const SHUFFLED = [
  { name: 'last', path: 'assets/audio/third.wav', at: 2, duration: 0.5 },
  { name: 'first', path: 'assets/audio/first.wav', at: 0, duration: 0.5 },
  { name: 'middle', path: 'assets/audio/second.wav', at: 1, duration: 0.5 }
]
const SORTED = [SHUFFLED[1], SHUFFLED[2], SHUFFLED[0]]
const shuffledEdl = exportEdl({ cues: SHUFFLED, frameRate: 24 })
const shuffledEvents = parseEdl(shuffledEdl.text).events
const shuffledNumbers = shuffledEvents.map((event) => event.number)
const shuffledLineNumbers = shuffledEdl.text.split('\n').filter((line) => /^\d{3}\s/.test(line)).map((line) => line.slice(0, 3))
console.log(`  ${shuffledEvents.map((event) => `${event.number} ${event.clipName}`).join('  ')}`)
check('shuffled cues: three events', shuffledEvents.length === 3, String(shuffledEvents.length))
check('shuffled cues: parsed event numbers are exactly 1,2,3', shuffledNumbers.join(',') === '1,2,3', JSON.stringify(shuffledNumbers))
check('shuffled cues: the file numbers its lines 001,002,003', shuffledLineNumbers.join(',') === '001,002,003', JSON.stringify(shuffledLineNumbers))
check('shuffled cues: the events are in timeline order', shuffledEvents.map((event) => event.clipName).join(',') === 'first.wav,second.wav,third.wav',
  JSON.stringify(shuffledEvents.map((event) => event.clipName)))
check('shuffled cues: input order does not change the bytes', shuffledEdl.text === exportEdl({ cues: SORTED, frameRate: 24 }).text)
check('shuffled cues: no warnings from a clean set', shuffledEdl.warnings.length === 0, JSON.stringify(shuffledEdl.warnings))

console.log('\n-- edl: 24 vs 25 fps --')
const at24 = parseEdl(exportEdl({ cues: CUES, frameRate: 24 }).text)
const at25 = parseEdl(exportEdl({ cues: CUES, frameRate: 25 }).text)
console.log(`  24 fps: ${at24.events[0].srcOut} ${at24.events[1].recIn}`)
console.log(`  25 fps: ${at25.events[0].srcOut} ${at25.events[1].recIn}`)
check('24 fps: 1.5 s is 36 frames', at24.events[0].srcOut === '00:00:01:12', at24.events[0].srcOut)
check('25 fps: 1.5 s is 38 frames', at25.events[0].srcOut === '00:00:01:13', at25.events[0].srcOut)
check('the two frame rates differ', at24.events[0].srcOut !== at25.events[0].srcOut)
check('24 fps timecode separator is a colon', at24.events[0].recOut.includes(':'))
check('24 fps rounds 0.3333 s to 8 frames', secondsToTimecode(0.3333, 24) === '00:00:00:08', secondsToTimecode(0.3333, 24))

console.log('\n-- edl: 29.97 drop-frame --')
const df = exportEdl({ cues: CUES, frameRate: 29.97 })
const dfParsed = parseEdl(df.text)
console.log(`  FCM ${dfParsed.fcm}; events ${dfParsed.events.map((event) => `${event.recIn}-${event.recOut}`).join('  ')}`)
check('drop frame declared', dfParsed.fcm === 'DROP FRAME' && dfParsed.dropFrame === true, String(dfParsed.fcm))
check('drop frame labels use a semicolon', dfParsed.events[0].recOut.includes(';'), dfParsed.events[0].recOut)
check('drop frame skips ;00 and ;01 at the minute', secondsToTimecode(60, 29.97) === '00:00:59;28', secondsToTimecode(60, 29.97))
check('drop frame label ;02 is exactly 60.06 s', Math.abs(timecodeToSeconds('00:01:00;02', 29.97) - 60.06) < 1e-6, String(timecodeToSeconds('00:01:00;02', 29.97)))
for (const seconds of [0, 1, 1.5, 59.5, 60, 600, 3599]) {
  const text = secondsToTimecode(seconds, 29.97)
  const back = timecodeToSeconds(text, 29.97)
  const errorFrames = Math.abs((back - seconds) * (30000 / 1001))
  check(`drop frame round trip ${seconds}s`, errorFrames <= 0.5 + 1e-6, `${text} -> ${back} (${errorFrames.toFixed(3)} frames)`)
}

console.log('\n-- edl: 23.976 is reported, 59.94 is refused --')
const film = exportEdl({ cues: [CUES[0]], frameRate: 23.976 })
check('23.976 mapped to 24', film.frameRate === '24', film.frameRate)
check('23.976 warns', film.warnings.some((warning) => /23\.976/.test(warning)), JSON.stringify(film.warnings))

console.log('\n-- edl: overlapping cues cannot be expressed --')
const overlap = exportEdl({
  cues: [
    { name: 'long', path: 'assets/audio/long.wav', at: 0, duration: 2 },
    { name: 'short', path: 'assets/audio/short.wav', at: 1, duration: 1 }
  ],
  frameRate: 24
})
const overlapParsed = parseEdl(overlap.text)
console.log(`  ${overlapParsed.events.map((event) => `${event.recIn}-${event.recOut}`).join('  ')}`)
console.log(`  warning: ${overlap.warnings[0]}`)
check('overlap keeps both events', overlapParsed.events.length === 2, String(overlapParsed.events.length))
check('overlap warns', overlap.warnings.length === 1 && /overlaps the previous event/.test(overlap.warnings[0]), JSON.stringify(overlap.warnings))
check('warning names the cue', /cue 2 \("short"\)/.test(overlap.warnings[0]), overlap.warnings[0])
check('warning states old and new position', /from 1 s to 2 s/.test(overlap.warnings[0]), overlap.warnings[0])
check('clamped event starts where the previous ended', overlapParsed.events[1].recIn === overlapParsed.events[0].recOut,
  `${overlapParsed.events[1].recIn} vs ${overlapParsed.events[0].recOut}`)
check('clamped event keeps its length', timecodeToSeconds(overlapParsed.events[1].srcOut, 24) === 1, overlapParsed.events[1].srcOut)
check('record times stay monotonic', timecodeToSeconds(overlapParsed.events[1].recIn, 24) >= timecodeToSeconds(overlapParsed.events[0].recOut, 24))

console.log('\n-- edl: non-ASCII is reported, not silently mangled --')
const unicodeEdl = exportEdl({ cues: [{ name: '\u7206\u70b8', path: '\u97f3\u6548/boom.wav', at: 0, duration: 1 }] })
console.log(`  ${unicodeEdl.warnings.join('\n  ')}`)
check('edl stays ascii for a unicode cue name', ASCII_ONLY.test(unicodeEdl.text), JSON.stringify(unicodeEdl.text.match(/[^\n\x20-\x7e]/)?.[0]))
check('edl warns about the ascii loss', unicodeEdl.warnings.some((warning) => /non-ASCII/.test(warning)), JSON.stringify(unicodeEdl.warnings))
check('edl replaced the characters', /\* SOURCE FILE: \?\?\/boom\.wav/.test(unicodeEdl.text), JSON.stringify(unicodeEdl.text.match(/\* SOURCE FILE: [^\n]*/)?.[0]))

console.log('\n-- edl: errors --')
function expectError (label, pattern, run) {
  try {
    run()
    check(label, false, 'no error thrown')
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
    console.log(`  ${label}: ${error.message}`)
  }
}
expectError('cue without path', /has no path/, () => exportEdl({ cues: [{ name: 'n', at: 0, duration: 1 }] }))
expectError('empty cue set', /non-empty array/, () => exportEdl({ cues: [] }))
expectError('unsupported frame rate', /unsupported frameRate "60"; use 24, 25, 30 or 29\.97/, () => exportEdl({ cues: CUES, frameRate: 60 }))
expectError('negative position', /at must be between 0 and 86400/, () => exportEdl({ cues: [{ name: 'n', path: 'p.wav', at: -1, duration: 1 }] }))
expectError('zero duration', /duration must be greater than 0/, () => exportEdl({ cues: [{ name: 'n', path: 'p.wav', at: 0, duration: 0 }] }))
expectError('missing duration', /has no duration/, () => exportEdl({ cues: [{ name: 'n', path: 'p.wav', at: 0 }] }))
expectError('gain out of range', /gainDb must be between -120 and 24/, () => exportEdl({ cues: [{ name: 'n', path: 'p.wav', at: 0, duration: 1, gainDb: 99 }] }))
expectError('bad record start', /is not valid at/, () => exportEdl({ cues: CUES, recordStart: '99:99:99;99' }))
expectError('record start past 24 hours', /recordStart must be less than 24 hours/, () => exportEdl({ cues: CUES, recordStart: 86400 }))
expectError('timecode past 24 hours', /cannot express 24 hours/, () => secondsToTimecode(86400, 25))
expectError('timeline ending exactly at 24 hours', /beyond the 24 hour limit/, () => exportEdl({ cues: [{ name: 'day', path: 'x.wav', at: 0, duration: 86400 }], recordStart: 0 }))
expectError('unknown format', /format must be one of edl, rpp, csv, labels, aaf, omf, otio, xmeml/, () => exportProject({ format: 'mxf', cues: CUES }))

/* ------------------------------------------------------------------------ rpp -- */

console.log('\n-- rpp: project structure --')
const rpp = exportReaper({ tracks: TRACKS, sampleRate: 48000, bpm: 96 })
await save('stems.rpp', rpp.text)
console.log(rpp.text)

check('three tracks', rpp.tracks === 3 && rpp.events === 3, `${rpp.tracks}/${rpp.events}`)
check('project header', rpp.text.startsWith('<REAPER_PROJECT 0.1 "7.0" '), rpp.text.slice(0, 32))
check('project sample rate', rpp.text.includes('\n  SAMPLERATE 48000 0 0\n'))
check('project tempo', rpp.text.includes('\n  TEMPO 96 4 4\n'))
check('one TRACK block per stem', (rpp.text.match(/^  <TRACK$/gm) ?? []).length === 3, String((rpp.text.match(/^ {2}<TRACK$/gm) ?? []).length))
check('one ITEM block per stem', (rpp.text.match(/^ {4}<ITEM$/gm) ?? []).length === 3, String((rpp.text.match(/^ {4}<ITEM$/gm) ?? []).length))
check('one SOURCE WAVE per item', (rpp.text.match(/<SOURCE WAVE$/gm) ?? []).length === 3, String((rpp.text.match(/<SOURCE WAVE$/gm) ?? []).length))
check('simple names stay unquoted', rpp.text.includes('\n    NAME bed\n'), JSON.stringify(rpp.text.match(/\n {4}NAME [^\n]*/)?.[0]))
check('names with spaces are quoted', rpp.text.includes('\n    NAME "hit, \'big\' one"\n'), JSON.stringify(rpp.text.match(/\n {4}NAME [^\n]*/g)))
check('rpp is ascii', ASCII_ONLY.test(rpp.text))
check('rpp has no carriage return', !rpp.text.includes('\r'))
check('rpp ends with the project close', rpp.text.endsWith('  >\n>\n'), JSON.stringify(rpp.text.slice(-12)))
check('rpp timeline length', rpp.durationSeconds === 8, String(rpp.durationSeconds))

console.log('\n-- rpp: parsed back, POSITION / LENGTH / VOLPAN --')
const parsedRpp = parseRpp(rpp.text)
check('parse back: balanced chunks', parsedRpp.balanced === true)
check('parse back: sample rate', parsedRpp.sampleRate === 48000, String(parsedRpp.sampleRate))
check('parse back: tempo', parsedRpp.bpm === 96, String(parsedRpp.bpm))
check('parse back: three tracks', parsedRpp.tracks.length === 3, String(parsedRpp.tracks.length))
let worstPositionMs = 0
let worstLengthMs = 0
let worstGainDb = 0
for (let index = 0; index < TRACKS.length; index += 1) {
  const track = TRACKS[index]
  const parsedTrack = parsedRpp.tracks[index]
  const item = parsedTrack.items[0]
  if (item === undefined) {
    check(`track ${index + 1} has an item`, false)
    continue
  }
  const positionMs = Math.abs(item.position - track.offsetSeconds) * 1000
  const lengthMs = Math.abs(item.length - track.duration) * 1000
  const gainDb = 20 * Math.log10(item.volume)
  const gainError = Math.abs(gainDb - track.gainDb)
  worstPositionMs = Math.max(worstPositionMs, positionMs)
  worstLengthMs = Math.max(worstLengthMs, lengthMs)
  worstGainDb = Math.max(worstGainDb, gainError)
  console.log(
    `  ${String(track.name).padEnd(16)} POSITION ${item.position}s (+/-${positionMs.toFixed(4)} ms)  ` +
    `LENGTH ${item.length}s (+/-${lengthMs.toFixed(4)} ms)  VOLPAN ${item.volume} = ${gainDb.toFixed(4)} dB (+/-${gainError.toFixed(4)} dB)  ` +
    `FADE ${item.fadeIn}/${item.fadeOut}s  FILE ${item.file}`
  )
  check(`track ${index + 1}: position within 0.5 ms`, positionMs <= 0.5, `${positionMs} ms`)
  check(`track ${index + 1}: length within 0.5 ms`, lengthMs <= 0.5, `${lengthMs} ms`)
  check(`track ${index + 1}: gain within 0.1 dB`, gainError <= 0.1, `${gainError} dB`)
  check(`track ${index + 1}: fade in`, Math.abs(item.fadeIn - (track.fadeIn ?? 0)) < 1e-6, String(item.fadeIn))
  check(`track ${index + 1}: fade out`, Math.abs(item.fadeOut - (track.fadeOut ?? 0)) < 1e-6, String(item.fadeOut))
  check(`track ${index + 1}: media file`, item.file === track.path, String(item.file))
  check(`track ${index + 1}: source offset 0`, item.soffs === 0, String(item.soffs))
  check(`track ${index + 1}: pan centred`, item.pan === 0, String(item.pan))
}
console.log(`  worst: ${worstPositionMs.toFixed(4)} ms position, ${worstLengthMs.toFixed(4)} ms length, ${worstGainDb.toFixed(4)} dB gain`)
check('position tolerance is stated as 0.5 ms', worstPositionMs <= 0.5, `${worstPositionMs}`)
check('length tolerance is stated as 0.5 ms', worstLengthMs <= 0.5, `${worstLengthMs}`)
check('gain tolerance is stated as 0.1 dB', worstGainDb <= 0.1, `${worstGainDb}`)
check('fades longer than the item warn', exportReaper({
  tracks: [{ name: 'x', path: 'x.wav', offsetSeconds: 0, duration: 1, fadeIn: 0.8, fadeOut: 0.8 }]
}).warnings.some((warning) => /fades longer than the item/.test(warning)))

console.log('\n-- rpp: errors --')
expectError('track without duration', /has no duration; RPP stores an item length/, () => exportReaper({ tracks: [{ name: 't', path: 'p.wav' }] }))
expectError('track without path', /has no path/, () => exportReaper({ tracks: [{ name: 't', offsetSeconds: 0, duration: 1 }] }))
expectError('empty track list', /non-empty array/, () => exportReaper({ tracks: [] }))
expectError('tempo out of range', /bpm must be between 20 and 300/, () => exportReaper({ tracks: TRACKS, bpm: 400 }))

/* ------------------------------------------------------------------------ csv -- */

console.log('\n-- csv: exact bytes around a quote and a comma --')
const CSV_NAME = 'hit, "big" one'
const csv = exportCsv({ cues: [{ name: CSV_NAME, path: 'assets/audio/impact-0001.wav', at: 0, duration: 1.5, gainDb: -0.5 }] })
await save('cues.csv', exportCsv({ cues: CUES }).text)
const expectedCsv = 'name,path,at,duration,gainDb,fadeIn,fadeOut\n"hit, ""big"" one",assets/audio/impact-0001.wav,0,1.5,-0.5,0,0\n'
console.log(`  ${JSON.stringify(csv.text)}`)
check('csv header', csv.text.startsWith('name,path,at,duration,gainDb,fadeIn,fadeOut\n'))
check('csv escaped bytes are exact', csv.text === expectedCsv, JSON.stringify(csv.text))
check('csv byte count', csv.bytes === expectedCsv.length, `${csv.bytes} vs ${expectedCsv.length}`)
check('csv is ascii', ASCII_ONLY.test(csv.text))
check('plain name is not quoted', exportCsv({ cues: [CUES[0]] }).text.split('\n')[1].startsWith('boom,'), JSON.stringify(exportCsv({ cues: [CUES[0]] }).text.split('\n')[1]))

/** Minimal RFC4180 reader, so the test proves the quoting rather than trusting it. */
function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const csvRows = parseCsv(exportCsv({ cues: [{ name: CSV_NAME, path: 'assets/audio/impact-0001.wav', at: 0.25, duration: 1.5, gainDb: -3.25, fadeIn: 0.1 }] }).text)
check('csv parse back: quoted name', csvRows[1][0] === CSV_NAME, JSON.stringify(csvRows[1][0]))
check('csv parse back: every row has 7 fields', csvRows.every((row) => row.length === 7), JSON.stringify(csvRows.map((row) => row.length)))
check('csv parse back: number fields', csvRows[1].slice(2).join(',') === '0.25,1.5,-3.25,0.1,0', JSON.stringify(csvRows[1].slice(2)))
check('csv sorts by position', parseCsv(exportCsv({ cues: CUES }).text).slice(1).map((row) => Number(row[2])).join(',') === '0,1.5,2.25')
check('csv keeps a cue without a path', parseCsv(exportCsv({ cues: [{ name: 'planned', at: 1, duration: 0.5 }] }).text)[1][1] === '')
// Unlike the EDL, CSV/RPP/labels are UTF-8 formats: the name is preserved.
const unicodeCsv = exportCsv({ cues: [{ name: '\u7206\u70b8', path: '\u97f3\u6548/boom.wav', at: 0, duration: 1 }] })
check('csv keeps non-ASCII text', unicodeCsv.text.includes('\u7206\u70b8'), JSON.stringify(unicodeCsv.text))
check('csv byte count counts utf-8 bytes', unicodeCsv.bytes === Buffer.byteLength(unicodeCsv.text, 'utf8'), `${unicodeCsv.bytes}`)

/* --------------------------------------------------------------------- labels -- */

console.log('\n-- labels: tab separated spans --')
const labels = exportLabels({ cues: CUES })
await save('cues-labels.txt', labels.text)
console.log(`  ${JSON.stringify(labels.text)}`)
const labelLines = labels.text.trimEnd().split('\n')
check('one label per cue', labelLines.length === CUES.length, String(labelLines.length))
check('three fields per line', labelLines.every((line) => line.split('\t').length === 3), JSON.stringify(labelLines.map((line) => line.split('\t').length)))
const labelSpans = labelLines.map((line) => line.split('\t'))
check('exact first label', labels.text.split('\n')[0] === '0\t1.5\tboom', JSON.stringify(labels.text.split('\n')[0]))
check('start < end for every label', labelSpans.every(([start, end]) => Number(start) < Number(end)), JSON.stringify(labelSpans))
check('labels are sorted by start', labelSpans.every((span, index) => index === 0 || Number(span[0]) >= Number(labelSpans[index - 1][0])), JSON.stringify(labelSpans.map((span) => span[0])))
check('label end equals start + duration', labelSpans[1][1] === '2.25' && labelSpans[1][2] === 'ding', JSON.stringify(labelSpans[1]))
check('labels end with one newline', labels.text.endsWith('\n') && !labels.text.endsWith('\n\n'))
check('label bytes', labels.bytes === Buffer.byteLength(labels.text, 'utf8'), String(labels.bytes))
const point = exportLabels({ cues: [{ name: 'planned', at: 2, duration: undefined }] })
check('a cue without duration still spans something', Number(point.text.split('\t')[0]) < Number(point.text.split('\t')[1]), JSON.stringify(point.text))
check('a cue without duration warns', point.warnings.some((warning) => /no duration/.test(warning)), JSON.stringify(point.warnings))

/* -------------------------------------------------------------- determinism -- */

console.log('\n-- determinism and byte counts --')
// Every format goes through `exportProject`, so this loop proves the dispatch,
// the extension table and the byte count together. The two container formats
// (aaf, omf) return a Buffer instead of text, so the comparison switches on
// `binary` rather than assuming a string; aaf runs offline here (embed: false)
// to keep the old test file from writing megabytes of PCM.
const builders = {
  edl: () => exportProject({ format: 'edl', cues: CUES, frameRate: 25 }),
  rpp: () => exportProject({ format: 'rpp', tracks: TRACKS, sampleRate: 44100, bpm: 120 }),
  csv: () => exportProject({ format: 'csv', cues: CUES }),
  labels: () => exportProject({ format: 'labels', cues: CUES }),
  aaf: () => exportProject({ format: 'aaf', cues: CUES, embed: false }),
  omf: () => exportProject({ format: 'omf', cues: CUES }),
  otio: () => exportProject({ format: 'otio', cues: CUES }),
  xmeml: () => exportProject({ format: 'xmeml', cues: CUES, frameRate: 25 })
}
const EXTENSIONS = { labels: 'txt', xmeml: 'xml' }
for (const format of EXPORT_FORMATS) {
  const first = builders[format]()
  const second = builders[format]()
  check(`${format}: format name`, first.format === format, first.format)
  check(`${format}: extension`, first.extension === (EXTENSIONS[format] ?? format), first.extension)
  check(`${format}: binary flag`, first.binary === (format === 'aaf' || format === 'omf'), String(first.binary))
  if (first.binary) {
    check(`${format}: identical bytes across runs`, Buffer.compare(first.buffer, second.buffer) === 0)
    check(`${format}: buffer byte count`, first.bytes === first.buffer.length, `${first.bytes} vs ${first.buffer.length}`)
    console.log(`  ${format.padEnd(6)} ${String(first.buffer.length).padStart(5)} bytes (binary)  ${String(first.events).padStart(2)} events  ${first.durationSeconds}s`)
  } else {
    check(`${format}: identical text across runs`, first.text === second.text)
    check(`${format}: identical bytes across runs`, first.bytes === second.bytes)
    check(`${format}: byte count equals the utf-8 length`, first.bytes === Buffer.byteLength(first.text, 'utf8'), `${first.bytes}`)
    console.log(`  ${format.padEnd(6)} ${String(first.text.length).padStart(5)} chars  ${String(first.bytes).padStart(5)} bytes  ${String(first.events).padStart(2)} events  ${first.durationSeconds}s`)
  }
}

console.log('\n-- files written to test/out/daw --')
for (const file of saved) console.log(`  ${file.name.padEnd(18)} ${String(file.bytes).padStart(6)} bytes`)
const edlOnDisk = await readFile(new URL('cues-24fps.edl', outDir), 'utf8')
check('saved edl matches the returned text', edlOnDisk === edl.text)

/* ----------------------------------------------------------------- tool layer -- */

console.log('\n-- tool: audio_daw registered and writing real files --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-daw-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }
registerDawTools(ctx)
const tool = registered.get('audio_daw')
const call = (args) => tool.execute(args, exec)
check('audio_daw is registered', tool !== undefined && tool.name === 'audio_daw', String(tool?.name))
check('tool is concurrency safe', tool.isConcurrencySafe === true)
check('tool requires a format', (tool.parameters.required ?? []).includes('format'))
check('format enum matches EXPORT_FORMATS', JSON.stringify(tool.parameters.properties.format.enum) === JSON.stringify(EXPORT_FORMATS))
check('cues schema names every field', ['name', 'path', 'at', 'duration', 'gainDb', 'fadeIn', 'fadeOut'].every((key) => tool.parameters.properties.cues.items.properties[key] !== undefined))
check('tracks schema names every field', ['name', 'path', 'offsetSeconds', 'duration', 'gainDb', 'fadeIn', 'fadeOut'].every((key) => tool.parameters.properties.tracks.items.properties[key] !== undefined))

// A real wav, so the tool has to measure a duration and write a relative path.
const sampleRate = 48000
const frames = Math.round(1.25 * sampleRate)
const samples = new Float32Array(frames)
for (let index = 0; index < frames; index += 1) samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5
await mkdir(join(cwd, 'sfx'), { recursive: true })
await writeFile(join(cwd, 'sfx', 'hit.wav'), encodeWav([samples], sampleRate))

const toolRpp = await call({ format: 'rpp', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0.5, gainDb: -3, fadeIn: 0.1 }] })
console.log(`  ${toolRpp.text.split('\n').join('\n  ')}`)
check('tool rpp: default output path', /^assets\/audio\/rpp-[0-9a-f]+\.rpp$/.test(toolRpp.relativePath), toolRpp.relativePath)
check('tool rpp: one item verified', toolRpp.verified.items === 1, JSON.stringify(toolRpp.verified))
check('tool rpp: media measured from the header', /measured from the wav header/.test(toolRpp.text), toolRpp.text)
check('tool rpp: no warnings', toolRpp.warnings.length === 0, JSON.stringify(toolRpp.warnings))
const toolRppText = await readFile(toolRpp.path, 'utf8')
const toolRppParsed = parseRpp(toolRppText)
const toolItem = toolRppParsed.tracks[0].items[0]
check('tool rpp: item length is the measured duration', Math.abs(toolItem.length - 1.25) < 1e-6, String(toolItem.length))
check('tool rpp: item position', Math.abs(toolItem.position - 0.5) < 1e-6, String(toolItem.position))
check('tool rpp: gain kept', Math.abs(20 * Math.log10(toolItem.volume) + 3) < 0.1, String(20 * Math.log10(toolItem.volume)))
check('tool rpp: media path relative to the project', toolItem.file === '../../sfx/hit.wav', String(toolItem.file))
const toolRppInfo = await stat(toolRpp.path)
check('tool rpp: bytes on disk', toolRppInfo.size === toolRpp.bytes, `${toolRppInfo.size} vs ${toolRpp.bytes}`)
check('tool rpp: bytes equal the utf-8 text', toolRpp.bytes === Buffer.byteLength(toolRppText, 'utf8'))

const toolEdl = await call({ format: 'edl', frameRate: 25, out: 'sheets/cues.edl', cues: CUES })
console.log(`  ${toolEdl.text.split('\n').join('\n  ')}`)
check('tool edl: explicit output path', toolEdl.relativePath === 'sheets/cues.edl', toolEdl.relativePath)
check('tool edl: verified events', toolEdl.verified.events === 3, JSON.stringify(toolEdl.verified))
check('tool edl: record start', toolEdl.recordStart === '01:00:00:00', String(toolEdl.recordStart))
check('tool edl: frame rate label', toolEdl.frameRateLabel === '25 fps non-drop', String(toolEdl.frameRateLabel))
check('tool edl: text says what an editor sees', /A video editor sees 3 cut\(s\)/.test(toolEdl.text), toolEdl.text)
const toolEdlText = await readFile(toolEdl.path, 'utf8')
check('tool edl: written text is the exported edl', exportEdl({ cues: CUES, frameRate: 25 }).text === toolEdlText)

console.log('\n-- tool: shuffled cues go through the tool and its read-back guard --')
const toolShuffled = await call({ format: 'edl', frameRate: 24, cues: SHUFFLED })
const toolShuffledText = await readFile(toolShuffled.path, 'utf8')
const toolShuffledNumbers = parseEdl(toolShuffledText).events.map((event) => event.number)
check('tool edl: shuffled cues are numbered 1,2,3 on disk', toolShuffledNumbers.join(',') === '1,2,3', JSON.stringify(toolShuffledNumbers))
check('tool edl: shuffled cues verified by the tool', toolShuffled.verified.events === 3, JSON.stringify(toolShuffled.verified))

// verifyEdl is the read-back guard the tool runs on every EDL it writes. Give it
// the exact output the old bug produced — two event numbers swapped — and prove
// it refuses, then prove it still accepts what the fixed writer produces.
const misnumberedLines = toolShuffledText.split('\n')
const eventLineIndexes = misnumberedLines
  .map((line, index) => (/^\d{3}\s/.test(line) ? index : -1))
  .filter((index) => index >= 0)
const firstEventLine = misnumberedLines[eventLineIndexes[0]]
const secondEventLine = misnumberedLines[eventLineIndexes[1]]
misnumberedLines[eventLineIndexes[0]] = secondEventLine.slice(0, 3) + firstEventLine.slice(3)
misnumberedLines[eventLineIndexes[1]] = firstEventLine.slice(0, 3) + secondEventLine.slice(3)
let misnumberedError = null
try {
  verifyEdl(misnumberedLines.join('\n'), SHUFFLED, 24)
} catch (error) {
  misnumberedError = error.message
}
console.log(`  verifyEdl said: ${misnumberedError}`)
check('verifyEdl rejects a 002,001,003 sequence', misnumberedError !== null && /must run 1\.\.3 in file order/.test(misnumberedError), String(misnumberedError))
let writerOutputAccepted = false
try {
  verifyEdl(toolShuffledText, SHUFFLED, 24)
  writerOutputAccepted = true
} catch (error) {
  console.log(`  verifyEdl unexpectedly rejected the writer output: ${error.message}`)
}
check('verifyEdl accepts the fixed writer output', writerOutputAccepted)

const toolCsv = await call({ format: 'csv', cues: [{ name: CSV_NAME, path: 'sfx/hit.wav', at: 0, duration: 1 }] })
check('tool csv: quoted name survives', (await readFile(toolCsv.path, 'utf8')).includes('"hit, ""big"" one"'))
const toolLabels = await call({ format: 'labels', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1 }] })
check('tool labels: tab separated', (await readFile(toolLabels.path, 'utf8')) === '0\t1\thit\n')

// The same request twice must land on the same file with the same bytes.
const again = await call({ format: 'edl', frameRate: 25, out: 'sheets/cues.edl', cues: CUES })
check('tool: same request, same path', again.path === toolEdl.path, again.path)
check('tool: same request, same bytes', again.bytes === toolEdl.bytes, `${again.bytes} vs ${toolEdl.bytes}`)
const defaulted = await call({ format: 'csv', cues: CUES })
const defaultedAgain = await call({ format: 'csv', cues: CUES })
check('tool: default path is content addressed', defaulted.path === defaultedAgain.path, `${defaulted.relativePath} vs ${defaultedAgain.relativePath}`)
check('tool: default path has the format extension', defaulted.relativePath.endsWith('.csv'), defaulted.relativePath)

console.log('\n-- tool: errors --')
for (const [label, pattern, args] of [
  ['bad format', /format must be one of edl, rpp, csv, labels, aaf, omf, otio, xmeml/, { format: 'mxf', cues: CUES }],
  ['cue without path', /has no path/, { format: 'edl', cues: [{ name: 'n', at: 0, duration: 1 }] }],
  ['missing cues', /needs cues/, { format: 'csv' }],
  ['missing media file', /cannot read .*nope\.wav/, { format: 'rpp', tracks: [{ path: 'nope.wav' }] }],
  ['missing track path', /has no path/, { format: 'rpp', tracks: [{ name: 't', duration: 1 }] }]
]) {
  try {
    await call(args)
    check(label, false, 'no error thrown')
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
    console.log(`  ${label}: ${error.message}`)
  }
}

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0
  ? `\nOK: ${checks} checks, every export parsed back to what was asked`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
