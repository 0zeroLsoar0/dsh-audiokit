/**
 * Acceptance tests for lib/midi.js, lib/tools-midi.js and the score <-> MIDI
 * bridge.
 *
 * The claims this file is evidence for:
 *
 * 1. The bytes are correct. A hand-built file with a known byte layout parses to
 *    exactly the notes it encodes, and `writeMidiFile` reproduces that same byte
 *    layout from a request — so the writer is not merely "self-consistent".
 * 2. A compose score survives the round trip: same tracks, same note count, same
 *    (midi, startTicks, durTicks) within a tick, same tempo.
 * 3. Running status, a malformed file and an unknown chunk are handled: the first
 *    parses, the others fail with a readable `midi: ...` reason, never a
 *    RangeError.
 * 4. Exports are byte-deterministic.
 * 5. An imported file reports what is in it: note count, tempo, track name.
 * 6. Exporting 1000 notes stays far below the 50 ms budget.
 *
 * Run with the workspace node (node is not on PATH):
 *
 *   <node> test/midi.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeScore } from '../lib/compose.js'
import { MIDI_TICKS_PER_QUARTER, parseMidiFile, scoreToMid, writeMidiFile } from '../lib/midi.js'
import { registerMidiTools } from '../lib/tools-midi.js'

let failures = 0

function check (label, condition, detail = '') {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : `  (${detail})`}`)
}

const num = (value, digits = 2) => Number(value).toFixed(digits)
const hex = (bytes) => Buffer.from(bytes).toString('hex')

/* ------------------------------------------------------------------ bytes -- */

/**
 * Wrap chunk bodies in a header, the way the SMF spec lays a file out:
 * MThd(6) + n x (MTrk + 32-bit length + body).
 */
function midiFile (format, division, bodies) {
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, (format >> 8) & 0xff, format & 0xff, (bodies.length >> 8) & 0xff, bodies.length & 0xff, (division >> 8) & 0xff, division & 0xff]
  for (const body of bodies) {
    out.push(0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body)
  }
  return Buffer.from(out)
}

/* --------------------------------------------------- 1. known byte layout -- */

// One note, one quarter long, at 120 BPM, in a track named "Solo" with program 0.
// Every byte here is written by hand so the test does not trust the writer:
//   tempo 0x07a120 = 500000 us/quarter = 120 BPM
//   time signature 4/4, 24 clocks/click, 8 32nds/quarter
//   delta 480 = 0x83 0x60 (variable-length quantity)
const HAND_BODY = [
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo meta
  0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4 time signature
  0x00, 0xff, 0x03, 0x04, 0x53, 0x6f, 0x6c, 0x6f, // track name "Solo"
  0x00, 0xc0, 0x00, // program 0 on channel 1
  0x00, 0x90, 0x3c, 0x64, // note-on C4 (60), velocity 100
  0x83, 0x60, 0x80, 0x3c, 0x00, // +480 ticks, note-off
  0x00, 0xff, 0x2f, 0x00 // end of track
]
const HAND_BYTES = midiFile(1, 480, [HAND_BODY])

console.log('-- known byte layout --')
console.log(`hand-built file: ${HAND_BYTES.length} bytes, ${hex(HAND_BYTES)}`)
const hand = parseMidiFile(HAND_BYTES)
const handTrack = hand.tracks[0]
const handNote = handTrack.notes[0]
console.log(`parsed: format ${hand.format}, ${hand.ticksPerQuarter} tpq, ${num(hand.tempoBpm, 3)} BPM, ${hand.tracks.length} track(s), name "${handTrack.name}", channel ${handTrack.channel}, program ${handTrack.program}`)
console.log(`note: midi ${handNote.midi}, start ${handNote.startTicks}, dur ${handNote.durTicks}, velocity ${handNote.velocity}, file duration ${num(hand.durationSeconds, 3)}s`)
check('format 1', hand.format === 1)
check('480 ticks per quarter', hand.ticksPerQuarter === 480)
check('tempo 120 BPM', Math.abs(hand.tempoBpm - 120) < 0.001, `${hand.tempoBpm}`)
check('one track', hand.tracks.length === 1, `${hand.tracks.length}`)
check('track name', handTrack.name === 'Solo', String(handTrack.name))
check('channel 0', handTrack.channel === 0, String(handTrack.channel))
check('program 0', handTrack.program === 0, String(handTrack.program))
check('exactly one note', handTrack.notes.length === 1, `${handTrack.notes.length}`)
check('note midi 60', handNote.midi === 60, String(handNote.midi))
check('note starts at tick 0', handNote.startTicks === 0, String(handNote.startTicks))
check('note lasts 480 ticks', handNote.durTicks === 480, String(handNote.durTicks))
check('note velocity 100', handNote.velocity === 100, String(handNote.velocity))
check('duration 0.5 s', Math.abs(hand.durationSeconds - 0.5) < 1e-6, String(hand.durationSeconds))
check('4/4 time signature', hand.timeSignature !== null && hand.timeSignature.numerator === 4 && hand.timeSignature.denominator === 4)

// The writer has to produce that exact byte sequence from the same information.
const written = writeMidiFile({
  bpm: 120,
  beatsPerBar: 4,
  tracks: [{ name: 'Solo', channel: 0, program: 0, notes: [{ midi: 60, startBeats: 0, durBeats: 1, velocity: 100 / 127, artic: 'normal' }] }]
})
console.log(`written from a request: ${written.length} bytes, ${hex(written)}`)
check('writer reproduces the hand-built bytes', written.equals(HAND_BYTES), `${written.length} vs ${HAND_BYTES.length} bytes`)

/* ------------------------------------------------------- 2. compose round -- */

console.log('\n-- compose roundtrip (4 bars, cinematic) --')
const score = composeScore({ genre: 'cinematic', bars: 4, seed: 7 })
const request = scoreToMid(score)
const exported = writeMidiFile(request)
const round = parseMidiFile(exported)

/** Independent reimplementation of the documented conversion, for comparison. */
function expectedTicks (score) {
  const ticksPerQuarter = MIDI_TICKS_PER_QUARTER
  const notes = []
  for (const track of score.tracks) {
    for (const note of track.notes) {
      if (note.midi < 1) continue
      const startTicks = Math.round((note.bar * score.beatsPerBar + note.beat) * ticksPerQuarter)
      const scale = note.artic === 'staccato' ? 0.5 : 1
      const durTicks = Math.max(1, Math.round(note.durBeats * scale * ticksPerQuarter))
      notes.push({ midi: note.midi, startTicks, durTicks })
    }
  }
  return notes.sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi || a.durTicks - b.durTicks)
}

const scoreTicks = expectedTicks(score)
const parsedTicks = []
for (const track of round.tracks) for (const note of track.notes) parsedTicks.push({ midi: note.midi, startTicks: note.startTicks, durTicks: note.durTicks })
parsedTicks.sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi || a.durTicks - b.durTicks)

const tempoError = Math.abs(round.tempoBpm - score.bpm)
const scoreSeconds = score.bars * score.beatsPerBar * 60 / score.bpm
const durationError = Math.abs(round.durationSeconds - scoreSeconds)
console.log(`score: ${score.tracks.length} tracks, ${scoreTicks.length} pitched notes, ${score.bars} bars @ ${score.bpm} BPM`)
console.log(`midi:  ${exported.length} bytes, ${round.tracks.length} tracks, ${round.noteCount} notes, ${num(round.durationSeconds, 4)}s, ${num(round.tempoBpm, 4)} BPM, ${round.ticksPerQuarter} tpq`)
console.log(`ticks: ${scoreTicks.length} expected vs ${parsedTicks.length} parsed, tempo error ${num(tempoError, 5)} BPM, duration error ${num(durationError, 6)}s`)
check('track count preserved', round.tracks.length === score.tracks.length, `${round.tracks.length} vs ${score.tracks.length}`)
check('note count preserved', round.noteCount === scoreTicks.length, `${round.noteCount} vs ${scoreTicks.length}`)
check('tempo preserved within 0.01 BPM', tempoError < 0.01, `${tempoError}`)
check('duration equals the score length', durationError < 0.002, `${durationError}`)

let worstStart = 0
let worstDuration = 0
let tickMismatches = 0
for (let index = 0; index < Math.min(scoreTicks.length, parsedTicks.length); index += 1) {
  const want = scoreTicks[index]
  const got = parsedTicks[index]
  if (got.midi !== want.midi) tickMismatches += 1
  worstStart = Math.max(worstStart, Math.abs(got.startTicks - want.startTicks))
  worstDuration = Math.max(worstDuration, Math.abs(got.durTicks - want.durTicks))
  if (Math.abs(got.startTicks - want.startTicks) > 1 || Math.abs(got.durTicks - want.durTicks) > 1) tickMismatches += 1
}
console.log(`roundtrip note-set check: worst start delta ${worstStart} tick, worst duration delta ${worstDuration} tick, ${tickMismatches} mismatched note(s)`)
check('every (midi, startTicks, durTicks) within 1 tick', tickMismatches === 0, `${tickMismatches} mismatched`)

// Channel/program mapping: a DAW has to open the file with the right instruments.
const byRole = (prefix) => round.tracks.find((track) => String(track.name ?? '').startsWith(prefix))
const melodyCfg = byRole('melody')
const rhythmCfg = byRole('rhythm')
const bassCfg = byRole('bass')
console.log(`mapping: melody -> ch ${melodyCfg?.channel} program ${melodyCfg?.program}, bass -> ch ${bassCfg?.channel} program ${bassCfg?.program}, rhythm -> ch ${rhythmCfg?.channel} program ${rhythmCfg?.program}`)
check('melody on channel 2 program 73', melodyCfg !== undefined && melodyCfg.channel === 2 && melodyCfg.program === 73)
check('rhythm on the GM drum channel with no program', rhythmCfg !== undefined && rhythmCfg.channel === 9 && rhythmCfg.program === null)
check('bass on channel 0 program 33', bassCfg !== undefined && bassCfg.channel === 0 && bassCfg.program === 33)

// Unpitched bed notes (compose uses MIDI 0 for a noise bed) are skipped, but the
// track stays so the file still has one track per score track.
const ambient = composeScore({ genre: 'ambient', bars: 2, seed: 3 })
const ambientRequest = scoreToMid(ambient)
const ambientParsed = parseMidiFile(writeMidiFile(ambientRequest))
const ambientColor = ambientParsed.tracks.find((track) => String(track.name ?? '').startsWith('color'))
console.log(`ambient bed: ${ambientRequest.skippedNotes} unpitched note(s) skipped, ${ambientParsed.tracks.length} tracks kept, color track ${ambientColor?.notes.length} notes`)
check('bed notes skipped', ambientRequest.skippedNotes === 1, `${ambientRequest.skippedNotes}`)
check('bed track kept empty', ambientColor !== undefined && ambientColor.notes.length === 0)
check('ambient track count preserved', ambientParsed.tracks.length === ambient.tracks.length)

/* --------------------------------------------------------- 3. running status -- */

console.log('\n-- running status --')
// After the 0x90 status byte, every event that follows may omit its status byte.
const RUNNING_BODY = [
  0x00, 0x90, 0x3c, 0x64, // note-on C4, velocity 100
  0x60, 0x3c, 0x00, // delta 96, running status: note-on velocity 0 = note-off
  0x00, 0x90, 0x3e, 0x50, // note-on D4, velocity 80
  0x60, 0x3e, 0x00, // delta 96, running status note-off
  0x00, 0xff, 0x2f, 0x00
]
const running = parseMidiFile(midiFile(1, 96, [RUNNING_BODY]))
console.log(`running status: ${running.noteCount} note(s) at ${running.ticksPerQuarter} tpq -> ${running.tracks[0].notes.map((note) => `${note.midi}@${note.startTicks}+${note.durTicks}/v${note.velocity}`).join(', ')}`)
check('running status yields 2 notes', running.noteCount === 2, `${running.noteCount}`)
check('running status note 1', running.tracks[0].notes[0]?.midi === 60 && running.tracks[0].notes[0]?.startTicks === 0 && running.tracks[0].notes[0]?.durTicks === 96 && running.tracks[0].notes[0]?.velocity === 100)
check('running status note 2', running.tracks[0].notes[1]?.midi === 62 && running.tracks[0].notes[1]?.startTicks === 96 && running.tracks[0].notes[1]?.durTicks === 96 && running.tracks[0].notes[1]?.velocity === 80)

// A data-only event after an explicit 0x80 status also uses running status; both
// note-offs here are orphans, which the parser reports instead of failing.
const RUNNING_80_BODY = [
  0x00, 0x80, 0x45, 0x40, // explicit note-off with no note-on
  0x00, 0x45, 0x00, // data-only under the running 0x80 status
  0x00, 0xff, 0x2f, 0x00
]
const running80 = parseMidiFile(midiFile(1, 96, [RUNNING_80_BODY]))
console.log(`running 0x80: ${running80.noteCount} note(s), warnings: ${running80.warnings.join(' / ')}`)
check('running 0x80 parses', running80.noteCount === 0)
check('orphan note-offs reported', running80.warnings.some((line) => line.includes('had no matching note-on')))

// A format 0 file is one MTrk carrying every channel; the parser splits it so
// the result is usable as tracks instead of one merged blob.
const MERGED_BODY = [
  0x00, 0xff, 0x03, 0x05, 0x50, 0x69, 0x61, 0x6e, 0x6f, // track name "Piano"
  0x00, 0x90, 0x3c, 0x64, // channel 1: note-on C4
  0x00, 0x91, 0x43, 0x50, // channel 2: note-on G4, same tick
  0x60, 0x80, 0x3c, 0x00, // +96 ticks: channel 1 note-off
  0x00, 0x81, 0x43, 0x00, // channel 2 note-off
  0x00, 0xff, 0x2f, 0x00
]
const merged = parseMidiFile(midiFile(0, 96, [MERGED_BODY]))
const unsplit = parseMidiFile(midiFile(0, 96, [MERGED_BODY]), { splitChannels: false })
console.log(`merged format 0: ${merged.tracks.length} split tracks -> ${merged.tracks.map((track) => `${track.name}/ch${track.channel}/${track.notes.length}n`).join(', ')}; unsplit: ${unsplit.tracks.length} track, ${unsplit.tracks[0].notes.length} notes, channel ${unsplit.tracks[0].channel}`)
check('format 0 is parsed as format 0', merged.format === 0)
check('merged channels split into tracks', merged.tracks.length === 2, `${merged.tracks.length}`)
check('split track 1', merged.tracks[0]?.channel === 0 && merged.tracks[0]?.notes[0]?.midi === 60 && merged.tracks[0]?.notes[0]?.startTicks === 0 && merged.tracks[0]?.notes[0]?.durTicks === 96)
check('split track 2', merged.tracks[1]?.channel === 1 && merged.tracks[1]?.notes[0]?.midi === 67 && merged.tracks[1]?.notes[0]?.startTicks === 0 && merged.tracks[1]?.notes[0]?.durTicks === 96)
check('split tracks keep the name', merged.tracks[0]?.name === 'Piano ch1' && merged.tracks[1]?.name === 'Piano ch2')
check('split can be disabled', unsplit.tracks.length === 1 && unsplit.tracks[0].notes.length === 2 && unsplit.tracks[0].channel === null)

/* ------------------------------------------------------------ 4. malformed -- */

console.log('\n-- malformed input --')

function expectMidiError (label, bytes, needle, options) {
  try {
    parseMidiFile(bytes, options)
  } catch (error) {
    const readable = error instanceof Error && !(error instanceof RangeError) &&
      error.message.startsWith('midi: ') && error.message.includes(needle)
    console.log(`  ${label}: ${error.message}`)
    check(`${label} error`, readable, `got ${error?.constructor?.name}: ${String(error?.message)}`)
    return
  }
  check(`${label} error`, false, 'did not throw')
}

const VALID_HEADER = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0]
expectMidiError('empty file', Buffer.alloc(0), 'truncated header')
expectMidiError('short file', Buffer.from([0x4d, 0x54, 0x68]), 'truncated header')
expectMidiError('bad magic', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(10)]), 'MThd')
expectMidiError('bad MThd length', Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 4, 0, 1, 0, 1]), 'MThd length')
const UNKNOWN_CHUNK = Buffer.concat([Buffer.from(VALID_HEADER), Buffer.from('Xtra'), Buffer.from([0, 0, 0, 0])])
expectMidiError('unknown chunk', UNKNOWN_CHUNK, 'unknown chunk')
expectMidiError('unknown chunk named', UNKNOWN_CHUNK, 'Xtra')
expectMidiError('unknown chunk (lenient skips it, then finds no MTrk)', UNKNOWN_CHUNK, 'expected 1 MTrk chunk', { lenient: true })
expectMidiError('truncated MTrk', Buffer.concat([Buffer.from(VALID_HEADER), Buffer.from('MTrk'), Buffer.from([0, 0, 0, 100]), Buffer.from([0, 0x90, 0x3c, 0x64])]), 'truncated MTrk')
expectMidiError('SMPTE division', Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0xe7, 0x28]), 'SMPTE')
expectMidiError('format 3', Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 3, 0, 1, 0x01, 0xe0]), 'unsupported MIDI format')
expectMidiError('zero tracks', Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0x00, 0x00, 0x01, 0xe0]), '0 tracks')
expectMidiError('running status first', midiFile(1, 96, [[0x00, 0x3c, 0x64, 0x00, 0xff, 0x2f, 0x00]]), 'running status')
expectMidiError('long VLQ', midiFile(1, 96, [[0x80, 0x80, 0x80, 0x80, 0x00, 0x90, 0x3c, 0x64]]), 'variable-length quantity')
expectMidiError('not bytes', 'this is not a midi file', 'expected MIDI bytes')
expectMidiError('invalid data byte', midiFile(1, 96, [[0x00, 0x90, 0x3c, 0x90, 0x00, 0xff, 0x2f, 0x00]]), 'invalid data byte')

/* --------------------------------------------------------- 5. determinism -- */

console.log('\n-- determinism --')
const exportedAgain = writeMidiFile(scoreToMid(composeScore({ genre: 'cinematic', bars: 4, seed: 7 })))
const parseAgain = parseMidiFile(exportedAgain)
console.log(`two exports of the same score: ${exported.equals(exportedAgain) ? 'byte-identical' : 'DIFFERENT'} (${exported.length} vs ${exportedAgain.length} bytes)`)
check('two exports are byte-identical', exported.equals(exportedAgain))
check('two parses are identical', JSON.stringify(round) === JSON.stringify(parseAgain))

const distinctNotes = [
  { midi: 60, startBeats: 0, durBeats: 1, velocity: 0.5 },
  { midi: 64, startBeats: 1, durBeats: 0.5, velocity: 0.9, artic: 'accent' },
  { midi: 67, startBeats: 1.5, durBeats: 2, velocity: 0.4, artic: 'staccato' }
]
const orderedBytes = writeMidiFile({ bpm: 90, tracks: [{ name: 'x', notes: distinctNotes }] })
const reversedBytes = writeMidiFile({ bpm: 90, tracks: [{ name: 'x', notes: distinctNotes.slice().reverse() }] })
console.log(`note-order independence: ${orderedBytes.equals(reversedBytes) ? 'identical' : 'DIFFERENT'} (${orderedBytes.length} bytes)`)
check('note input order does not change the bytes', orderedBytes.equals(reversedBytes))

/* ----------------------------------------- 6. imported melody, reported -- */

console.log('\n-- imported melody, reported --')
const melodyScore = {
  bpm: 120,
  bars: 1,
  beatsPerBar: 4,
  tracks: [{
    id: 'melody',
    role: 'melody',
    instrument: 'test-lead',
    notes: [
      { bar: 0, beat: 0, durBeats: 1, midi: 60, velocity: 0.9, artic: 'legato' },
      { bar: 0, beat: 1, durBeats: 1, midi: 64, velocity: 0.9, artic: 'legato' },
      { bar: 0, beat: 2, durBeats: 1, midi: 67, velocity: 0.9, artic: 'legato' },
      { bar: 0, beat: 3, durBeats: 1, midi: 72, velocity: 0.9, artic: 'legato' }
    ]
  }]
}
const melodyFile = writeMidiFile(scoreToMid(melodyScore))
const melodyParsed = parseMidiFile(melodyFile)
console.log(`imported: ${melodyParsed.noteCount} note(s) at ${num(melodyParsed.tempoBpm, 3)} BPM, ${num(melodyParsed.durationSeconds, 3)}s, track "${melodyParsed.tracks[0]?.name}"`)
check('parse keeps every note', melodyParsed.noteCount === 4, `${melodyParsed.noteCount}`)
check('parse keeps the tempo', Math.abs(melodyParsed.tempoBpm - 120) < 1e-9, String(melodyParsed.tempoBpm))
check('parse names the melody track', String(melodyParsed.tracks[0]?.name ?? '').startsWith('melody'), String(melodyParsed.tracks[0]?.name))

/* ------------------------------------------------------------- 7. performance -- */

console.log('\n-- performance --')
const perfScore = { bpm: 120, beatsPerBar: 4, bars: 63, tracks: [{ id: 'melody', role: 'melody', notes: [] }] }
for (let index = 0; index < 1000; index += 1) {
  perfScore.tracks[0].notes.push({
    bar: Math.floor(index / 16),
    beat: (index % 16) * 0.25,
    durBeats: 0.2,
    midi: 60 + (index % 24),
    velocity: 0.4 + (index % 10) / 20,
    artic: index % 3 === 0 ? 'staccato' : 'normal'
  })
}
const perfStarted = process.hrtime.bigint()
const perfBytes = writeMidiFile(scoreToMid(perfScore))
const perfMilliseconds = Number(process.hrtime.bigint() - perfStarted) / 1e6
const parseStarted = process.hrtime.bigint()
const perfParsed = parseMidiFile(perfBytes)
const parseMilliseconds = Number(process.hrtime.bigint() - parseStarted) / 1e6
console.log(`1000-note export: ${num(perfMilliseconds, 2)} ms, ${perfBytes.length} bytes; parse: ${num(parseMilliseconds, 2)} ms, ${perfParsed.noteCount} notes`)
check('1000-note export under 50 ms', perfMilliseconds < 50, `${perfMilliseconds} ms`)
check('1000-note parse keeps every note', perfParsed.noteCount === 1000, `${perfParsed.noteCount}`)

/* ------------------------------------------------------------------ 8. tool -- */

console.log('\n-- audio_midi tool --')
const registered = []
const fakeCtx = {
  tools: { register: (definition) => registered.push(definition) },
  get: () => undefined
}
registerMidiTools(fakeCtx)
check('registers exactly one tool', registered.length === 1, `${registered.length}`)
const tool = registered[0]
check('tool is named audio_midi', tool !== undefined && tool.name === 'audio_midi', String(tool?.name))

const workDir = await mkdtemp(join(tmpdir(), 'dsh-midi-'))
try {
  const exportedTool = await tool.execute({ action: 'export', genre: 'chiptune', bars: 2, seed: 5, out: join(workDir, 'cue.mid') }, {})
  console.log(`export: ${exportedTool.relativePath}, ${exportedTool.bytes} bytes, ${exportedTool.tracks} tracks, ${exportedTool.notes} notes, ${num(exportedTool.durationSeconds, 3)}s, ${num(exportedTool.tempoBpm, 3)} BPM`)
  console.log(`  text: ${exportedTool.text.split('\n')[0]}`)
  check('export wrote the requested path', exportedTool.path === join(workDir, 'cue.mid'))
  check('export has notes', exportedTool.notes > 0, `${exportedTool.notes}`)
  check('export text names the file', exportedTool.text.includes('cue.mid'))

  const parsedTool = await tool.execute({ action: 'parse', path: join(workDir, 'cue.mid') }, {})
  console.log(`parse: ${parsedTool.tracks} tracks, ${parsedTool.notes} notes, ${num(parsedTool.durationSeconds, 3)}s, tempo ${num(parsedTool.tempoBpm, 3)} BPM, ${parsedTool.trackList.length} listed track(s)`)
  console.log(`  text: ${parsedTool.text.split('\n')[0]}`)
  check('parse note count matches the export', parsedTool.notes === exportedTool.notes, `${parsedTool.notes} vs ${exportedTool.notes}`)
  check('parse track list is bounded', Array.isArray(parsedTool.trackList) && parsedTool.trackList.length <= 12, `${parsedTool.trackList.length}`)

  // The import-to-audio verb is gone with the formant voice: a `.mid` is read as
  // data, never rendered, and the removed action must say what is still legal.
  await writeFile(join(workDir, 'melody.mid'), melodyFile)
  const parsedMelody = await tool.execute({ action: 'parse', path: join(workDir, 'melody.mid') }, {})
  console.log(`parse melody: ${parsedMelody.notes} notes, ${num(parsedMelody.tempoBpm, 3)} BPM, "${parsedMelody.trackList[0]?.name}"`)
  check('parse reports the melody file', parsedMelody.notes === 4, `${parsedMelody.notes}`)

  let removedImport = ''
  try {
    await tool.execute({ action: 'import', path: join(workDir, 'cue.mid') }, {})
  } catch (error) {
    removedImport = error.message
  }
  console.log(`removed import action error: ${removedImport}`)
  check('the removed import action is a readable error', removedImport.includes('must be "export" or "parse"'), removedImport)

  const fromScoreTool = await tool.execute({ action: 'export', score: melodyScore, out: join(workDir, 'melody.mid') }, {})
  console.log(`export from score object: ${fromScoreTool.notes} notes, ${fromScoreTool.tracks} track(s), ${num(fromScoreTool.durationSeconds, 3)}s`)
  check('export from a score object', fromScoreTool.notes === 4 && fromScoreTool.tracks === 1, `${fromScoreTool.notes} notes`)

  // Default output path: resolved against the session directory and named by the
  // content hash, so two exports of one score converge on one file.
  const sessionRegistered = []
  registerMidiTools({
    tools: { register: (definition) => sessionRegistered.push(definition) },
    get: (service) => (service === 'workingDirectory' ? { get: () => workDir } : undefined)
  })
  const sessionExec = { agent: { session: { id: 'midi-test' } } }
  const defaultFirst = await sessionRegistered[0].execute({ action: 'export', genre: 'ui-menu', bars: 1 }, sessionExec)
  const defaultSecond = await sessionRegistered[0].execute({ action: 'export', genre: 'ui-menu', bars: 1 }, sessionExec)
  const defaultPrefix = join(workDir, 'assets', 'audio')
  console.log(`default path: ${defaultFirst.relativePath} (${defaultFirst.bytes} bytes), second export same path: ${defaultFirst.path === defaultSecond.path}`)
  check('default path is assets/audio/<name>.mid', defaultFirst.path.startsWith(defaultPrefix) && defaultFirst.path.endsWith('.mid'), defaultFirst.path)
  check('same score reuses the default file', defaultFirst.path === defaultSecond.path, `${defaultFirst.path} vs ${defaultSecond.path}`)
  check('default export bytes are stable', (await readFile(defaultFirst.path)).equals(await readFile(defaultSecond.path)))

  let toolError = ''
  try {
    await tool.execute({ action: 'parse', path: join(workDir, 'missing.mid') }, {})
  } catch (error) {
    toolError = error.message
  }
  console.log(`missing file error: ${toolError}`)
  check('missing file is a readable error', toolError.includes('cannot read'), toolError)

  await writeFile(join(workDir, 'broken.mid'), Buffer.from('this is definitely not a midi file'))
  toolError = ''
  try {
    await tool.execute({ action: 'parse', path: join(workDir, 'broken.mid') }, {})
  } catch (error) {
    toolError = error.message
  }
  console.log(`broken file error: ${toolError}`)
  check('broken file is a readable error', toolError.includes('cannot parse') && toolError.includes('midi:'), toolError)

  toolError = ''
  try {
    await tool.execute({ action: 'export', out: join(workDir, 'nothing.mid') }, {})
  } catch (error) {
    toolError = error.message
  }
  console.log(`empty export error: ${toolError}`)
  check('export without score or genre is a readable error', toolError.includes('needs either a score object'), toolError)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

/* ---------------------------------------------------------------- summary -- */

console.log('\n-- summary --')
console.log(`known-byte layout: writer == hand-built (${HAND_BYTES.length} bytes)`)
console.log(`compose roundtrip: ${score.tracks.length} tracks / ${scoreTicks.length} notes, worst timing delta ${worstStart}/${worstDuration} tick, tempo error ${num(tempoError, 5)} BPM`)
console.log(`imported: ${melodyParsed.noteCount} notes, ${num(melodyParsed.tempoBpm, 3)} BPM, track "${melodyParsed.tracks[0]?.name}"`)
console.log(`performance: 1000 notes exported in ${num(perfMilliseconds, 2)} ms (budget 50 ms)`)
console.log(failures === 0 ? 'OK: ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
if (failures > 0) process.exitCode = 1
