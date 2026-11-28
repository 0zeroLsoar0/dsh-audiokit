/**
 * Standard MIDI File bridge: a zero-dependency SMF writer and reader.
 *
 * Two jobs, one seam:
 *
 * 1. `scoreToMid` + `writeMidiFile` put a `composeScore` result into a `.mid` a
 *    DAW, notation app or game engine can open. A score is richer than MIDI (it
 *    has articulation, per-track gain targets and chord labels), so this
 *    conversion is lossy in one direction only: everything MIDI can express
 *    survives the round trip, and the extras simply have no MIDI equivalent.
 * 2. `parseMidiFile` reads existing music. A parsed file can be summarised and
 *    inspected — tempo, tracks, note counts and ranges — so a `.mid` from the
 *    user becomes structured data the model can talk about and re-compose from.
 *    Turning it into sung audio was dropped with the formant voice: singing now
 *    belongs to a TTS engine or an external plugin.
 *
 * Deliberately supported: format 0/1/2 reading and format 1 writing,
 * ticks-per-quarter timing, running status, variable-length quantities, tempo
 * changes (including several in one file), time and key signature, track names,
 * program changes, and a single MTrk that carries several channels at once.
 *
 * Deliberately NOT supported, because a `.mid` from the wild needs a decoder,
 * not a full sequencer:
 *
 * - SMPTE time division (`division & 0x8000`): rejected with a readable reason,
 *   because its absolute-time grid cannot be expressed as beats without a frame
 *   rate policy this plugin does not make.
 * - 14-bit controllers: a paired MSB/LSB CC (0..31 + 32..63) is reported as two
 *   7-bit `controller` events; nothing is combined into a 14-bit value. Pitch
 *   bend, which is a single 14-bit channel message, is combined and reported.
 * - RPN/NRPN sequencing, MIDI 2.0, RMID (RIFF-wrapped) containers and temporal
 *   order: events are kept in file order, and no attempt is made to re-sort or
 *   "fix" a track whose events are out of time order.
 * - Format 2 semantics: a format 2 file parses (its tracks are independent
 *   sequences) but duration is measured from the longest one, which is a
 *   convenience, not a playback model.
 *
 * Everything here is pure and deterministic: the same request always produces
 * the same bytes, and a parse of those bytes always produces the same object.
 * No `Math.random`, no clock reads, no locale-dependent formatting.
 */

import { clamp } from './dsp.js'

/* --------------------------------------------------------------- constants -- */

/**
 * Ticks per quarter note used when writing. 480 keeps sixteenths (120), triplets
 * (160) and 32nds (60) on whole ticks, which is what makes a quantised score
 * survive a round trip instead of drifting by a tick per bar.
 */
export const MIDI_TICKS_PER_QUARTER = 480

/**
 * The channel/program each compose-score role is exported to.
 *
 * Channel 9 is the General MIDI percussion channel, so the `rhythm` track goes
 * there with no program change (GM ignores one on that channel). Programs are
 * 0-based GM numbers: 33 electric bass (finger), 89 pad 2 (warm), 73 flute,
 * 9 glockenspiel.
 */
export const MIDI_SCORE_VOICES = Object.freeze({
  bass: Object.freeze({ channel: 0, program: 33 }),
  harmony: Object.freeze({ channel: 1, program: 89 }),
  melody: Object.freeze({ channel: 2, program: 73 }),
  color: Object.freeze({ channel: 3, program: 9 }),
  rhythm: Object.freeze({ channel: 9, program: null })
})

/** Largest value a four-byte variable-length quantity can carry. */
const MAX_TICKS = 0x0fffffff
/** Hard bounds: a runaway request becomes a clear error, not a huge allocation. */
const MAX_TRACKS = 64
const MAX_NOTES_PER_FILE = 200000
/** SMF default tempo is 120 BPM; a file without a tempo event is played at it. */
const DEFAULT_BPM = 120
const DEFAULT_US_PER_QUARTER = 500000
/** Channels used when a score role has no table entry, or its channel is taken. */
const SPARE_CHANNELS = [4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]

const round3 = (value) => Math.round(value * 1000) / 1000
const round4 = (value) => Math.round(value * 10000) / 10000
const round6 = (value) => Math.round(value * 1000000) / 1000000

/* ---------------------------------------------------------------- helpers -- */

/** Throw the one error shape this module reports: `midi: <what is wrong>`. */
function fail (message) {
  throw new Error(`midi: ${message}`)
}

/** Short human description of a JS value, for error messages. */
function describe (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

/** Lower-case hex for a byte, used in error messages and event dumps. */
function hexByte (value) {
  return `0x${Number(value).toString(16).padStart(2, '0')}`
}

/** Printable ASCII only: file names in a MIDI meta event must not carry junk. */
function asciiName (value) {
  const text = String(value ?? '')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .trim()
  return text === '' ? 'track' : text.slice(0, 96)
}

/**
 * Decode a meta text payload. Latin-1 keeps every byte distinct (a UTF-8 name
 * becomes mojibake, but a name is still a name), control bytes become spaces and
 * trailing NUL padding is dropped.
 */
function decodeText (payload) {
  return payload
    .toString('latin1')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim()
}

/**
 * Accept the three shapes MIDI bytes realistically arrive in.
 * @returns {Buffer} a view over the same bytes (no copy for Buffer input).
 */
function toBuffer (bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (Array.isArray(bytes)) {
    for (const value of bytes) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        fail(`byte array contains ${describe(value)} instead of an integer 0..255`)
      }
    }
    return Buffer.from(bytes)
  }
  fail(`expected MIDI bytes (Buffer, Uint8Array or byte array), got ${describe(bytes)}`)
}

/** Encode a non-negative integer as an SMF variable-length quantity. */
function encodeVlq (value) {
  let remaining = Math.floor(value)
  if (!(remaining >= 0)) fail(`cannot encode negative delta ${value} as a variable-length quantity`)
  if (remaining > MAX_TICKS) fail(`delta ${remaining} is too large for a variable-length quantity (max ${MAX_TICKS})`)
  const bytes = [remaining & 0x7f]
  remaining = Math.floor(remaining / 128)
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  return bytes
}

/** Read one variable-length quantity, never past `end`. */
function readVlq (data, offset, end) {
  let value = 0
  let cursor = offset
  let count = 0
  while (cursor < end) {
    const byte = data[cursor]
    cursor += 1
    count += 1
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, offset: cursor }
    if (count >= 4) fail(`variable-length quantity longer than 4 bytes at byte ${offset}`)
  }
  fail(`truncated variable-length quantity at byte ${offset}`)
}

/**
 * The articulation contract, expressed in the only two things a MIDI note can
 * carry — how long it lasts and how hard it starts:
 *
 *   staccato -> half length (the note leaves space before the next one)
 *   accent   -> velocity x 1.25 (capped at 1)
 *   ghost    -> velocity x 0.6
 *   anything else (normal, legato, sustain) -> unchanged
 *
 * MIDI has no articulation concept, so this mapping is lossy by nature. It lives
 * in one function because both ends of the bridge use it: `scoreToMid` bakes it
 * into its output (and marks the note `normal`, so the writer does not apply it
 * twice), and `writeMidiFile` applies it to hand-built requests that still carry
 * an `artic` label.
 *
 * @returns {{ durBeats:number, velocity:number }}
 */
function articulationShape (artic, durBeats, velocity) {
  if (artic === 'staccato') return { durBeats: durBeats * 0.5, velocity }
  if (artic === 'accent') return { durBeats, velocity: clamp(velocity * 1.25, 0.01, 1) }
  if (artic === 'ghost') return { durBeats, velocity: clamp(velocity * 0.6, 0.01, 1) }
  return { durBeats, velocity }
}

/* ------------------------------------------------------------------ writer -- */

/**
 * Normalise one writer note into ticks and a 7-bit velocity.
 *
 * Notes with `midi < 1` are skipped: the compose score uses MIDI 0 as the "no
 * pitch" marker for a noise bed, and a bed has no notes to export.
 *
 * @returns {{ midi:number, startTicks:number, durTicks:number, velocity:number }[]}
 */
function normaliseWriterNotes (track, ticksPerQuarter) {
  const source = Array.isArray(track.notes) ? track.notes : []
  const notes = []
  for (const note of source) {
    if (note === null || typeof note !== 'object') continue
    const midi = Math.round(Number(note.midi))
    if (!Number.isFinite(midi) || midi < 1 || midi > 127) continue
    const startBeats = Math.max(0, Number(note.startBeats))
    if (!Number.isFinite(startBeats)) continue
    const rawDuration = Number(note.durBeats)
    const durBeats = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0.25
    const artic = typeof note.artic === 'string' ? note.artic : 'normal'
    const velocity = clamp(Number.isFinite(Number(note.velocity)) ? Number(note.velocity) : 0.8, 0.01, 1)
    const shaped = articulationShape(artic, durBeats, velocity)
    notes.push({
      midi,
      startTicks: Math.min(MAX_TICKS, Math.round(startBeats * ticksPerQuarter)),
      durTicks: Math.min(MAX_TICKS, Math.max(1, Math.round(shaped.durBeats * ticksPerQuarter))),
      // 7-bit quantisation happens here and nowhere else.
      velocity: clamp(Math.round(shaped.velocity * 127), 1, 127)
    })
  }
  return notes
}

/** Meta event bytes for a track name (0x03). */
function nameEventBytes (name) {
  const payload = Buffer.from(name, 'latin1')
  return [0xff, 0x03, ...encodeVlq(payload.length), ...payload]
}

/** Meta event bytes for a time signature (0x58), derived from the bar length. */
function timeSignatureBytes (beatsPerBar) {
  // The denominator is a power of two: 2 means a quarter note. A 4/4 bar at 24
  // MIDI clocks per click and 8 32nds per quarter is what every DAW expects.
  return [0xff, 0x58, 0x04, beatsPerBar & 0x7f, 2, 24, 8]
}

/** Meta event bytes for the tempo (0x51), in microseconds per quarter note. */
function tempoEventBytes (bpm) {
  const microseconds = clamp(Math.round(60000000 / bpm), 1, 0xffffff)
  return [0xff, 0x51, 0x03, (microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff]
}

/**
 * Write a MIDI file (format 1 unless `options.format` is 0).
 *
 * One MTrk per track, in the order given. Track 0 carries the tempo, the time
 * signature and the first track's events; every track carries its name, an
 * optional program change (omitted on the GM percussion channel 9) and its
 * note-on/note-off pairs with delta times measured from the previous event.
 *
 * Determinism: events are ordered by `(tick, kind, midi)`, where note-offs sort
 * before note-ons at the same tick so a re-trigger cannot leave a stuck note.
 * That means the input note order does not leak into the bytes for distinct
 * pitches, and two calls with the same request are byte-identical.
 *
 * @param {object} request
 * @param {number} [request.bpm] - tempo, 20..400 (default 120).
 * @param {number} [request.beatsPerBar] - time signature numerator (default 4).
 * @param {number} [request.endBeats] - minimum length in beats; the end-of-track
 *   marker is placed here when it is later than the last event, so a DAW shows
 *   the full bars of the score instead of stopping at the last note-off.
 * @param {Array<{name?:string, channel?:number, program?:number|null, notes?:object[]}>} request.tracks
 *   each note is `{ midi, startBeats, durBeats, velocity, artic }` with velocity
 *   in 0..1 and `artic` one of staccato|accent|ghost|normal|legato|sustain.
 * @param {object} [options]
 * @param {number} [options.ticksPerQuarter] - 24..9600, default 480.
 * @param {number} [options.format] - 1 (default) or 0 for a single-track file.
 * @returns {Buffer} the encoded file.
 */
export function writeMidiFile (request, options = {}) {
  const input = request !== null && typeof request === 'object' ? request : {}
  const opts = options !== null && typeof options === 'object' ? options : {}
  const bpm = clamp(Number.isFinite(Number(input.bpm)) ? Number(input.bpm) : DEFAULT_BPM, 20, 400)
  const beatsPerBar = clamp(Math.round(Number.isFinite(Number(input.beatsPerBar)) ? Number(input.beatsPerBar) : 4), 1, 32)
  const ticksPerQuarter = clamp(Math.round(Number.isFinite(Number(opts.ticksPerQuarter)) ? Number(opts.ticksPerQuarter) : MIDI_TICKS_PER_QUARTER), 24, 9600)
  const format = opts.format === 0 ? 0 : 1
  const sourceTracks = Array.isArray(input.tracks) ? input.tracks : []
  if (sourceTracks.length === 0) fail('writeMidiFile needs at least one track')
  if (sourceTracks.length > MAX_TRACKS) fail(`${sourceTracks.length} tracks exceeds the ${MAX_TRACKS} track limit`)
  if (format === 0 && sourceTracks.length > 1) fail(`format 0 holds one track, got ${sourceTracks.length}; use format 1`)

  let totalNotes = 0
  const chunks = []
  for (let index = 0; index < sourceTracks.length; index += 1) {
    const track = sourceTracks[index] !== null && typeof sourceTracks[index] === 'object' ? sourceTracks[index] : {}
    const channel = clamp(Math.round(Number(track.channel ?? 0)) || 0, 0, 15)
    const rawProgram = track.program
    const program = rawProgram === null || rawProgram === undefined
      ? null
      : clamp(Math.round(Number(rawProgram)) || 0, 0, 127)
    const notes = normaliseWriterNotes(track, ticksPerQuarter)
    totalNotes += notes.length

    /** @type {{tick:number, kind:number, midi:number, seq:number, bytes:number[]}[]} */
    const events = []
    const push = (tick, kind, midi, bytes) => {
      events.push({ tick, kind, midi, seq: events.length, bytes })
    }

    if (index === 0) push(0, 0, 0, tempoEventBytes(bpm))
    push(0, 0, 0, timeSignatureBytes(beatsPerBar))
    push(0, 0, 0, nameEventBytes(asciiName(track.name ?? `track ${index + 1}`)))
    // GM percussion ignores program changes, so writing one would only mislead.
    if (program !== null && channel !== 9) push(0, 0, 0, [0xc0 | channel, program])

    for (const note of notes) {
      // 2 = note-on, 1 = note-off: offs first at equal ticks (see the JSDoc).
      push(note.startTicks, 2, note.midi, [0x90 | channel, note.midi, note.velocity])
      push(note.startTicks + note.durTicks, 1, note.midi, [0x80 | channel, note.midi, 0])
    }

    events.sort((a, b) => a.tick - b.tick || a.kind - b.kind || a.midi - b.midi || a.seq - b.seq)

    const body = []
    let lastTick = 0
    for (const event of events) {
      body.push(...encodeVlq(event.tick - lastTick), ...event.bytes)
      lastTick = event.tick
    }
    const requestedEnd = Number.isFinite(Number(input.endBeats))
      ? Math.round(Number(input.endBeats) * ticksPerQuarter)
      : 0
    const endTick = Math.min(MAX_TICKS, Math.max(lastTick, requestedEnd))
    body.push(...encodeVlq(endTick - lastTick), 0xff, 0x2f, 0x00)

    chunks.push(body)
  }
  if (totalNotes > MAX_NOTES_PER_FILE) {
    fail(`${totalNotes} notes exceeds the ${MAX_NOTES_PER_FILE} note limit`)
  }

  /* Assemble: header, then one MTrk per track. */
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, (sourceTracks.length >> 8) & 0xff, sourceTracks.length & 0xff, (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff]
  for (const body of chunks) {
    out.push(0x4d, 0x54, 0x72, 0x6b, (body.length >> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff)
    for (const byte of body) out.push(byte)
  }
  return Buffer.from(out)
}

/* ------------------------------------------------------------------ reader -- */

/**
 * Parse one MTrk chunk body into events and paired notes.
 *
 * The hard parts, all handled here:
 * - running status (a data byte where a status byte would be, meaning "same
 *   status as last time"); any status byte at or above 0xF0 cancels it, which
 *   per the SMF spec includes sysex and meta events (0xFF), not only the system
 *   common/real-time messages of live MIDI;
 * - variable-length delta times;
 * - note pairing by FIFO per (channel, note), so a repeated pitch does not pair
 *   its first off with its second on;
 * - a track that carries several channels at once (the caller splits it later).
 *
 * @returns {object} a physical track record (see `parseMidiFile`).
 */
function parseTrack (data, start, end, index) {
  const events = []
  const notes = []
  const open = new Map()
  const programByChannel = new Map()
  const channelSet = new Set()
  let name = null
  let timeSignature = null
  let keySignature = null
  let cursor = start
  let tick = 0
  let running = null
  let orphanNoteOffs = 0
  let unclosedNotes = 0

  const need = (count, label) => {
    if (cursor + count > end) {
      fail(`truncated ${label} at byte ${cursor}: ${count} data byte(s) needed, ${Math.max(0, end - cursor)} remain`)
    }
  }

  const closeNote = (channel, midi, endTick) => {
    const key = channel * 128 + midi
    const list = open.get(key)
    if (list === undefined || list.length === 0) {
      orphanNoteOffs += 1
      return
    }
    const started = list.shift()
    notes.push({
      midi,
      channel,
      startTicks: started.startTicks,
      durTicks: Math.max(1, endTick - started.startTicks),
      velocity: started.velocity
    })
  }

  while (cursor < end) {
    const delta = readVlq(data, cursor, end)
    cursor = delta.offset
    tick += delta.value
    if (cursor >= end) fail(`truncated event at byte ${cursor}: expected a status byte, reached the end of the track`)

    const eventOffset = cursor
    let status = data[cursor]
    if (status < 0x80) {
      if (running === null) fail(`running status used before any status byte at byte ${eventOffset}`)
      status = running // the byte is data, leave the cursor on it
    } else {
      cursor += 1
      // Any status byte at or above 0xF0 cancels running status: per the SMF
      // spec that covers sysex and meta events (0xFF) as well as the system
      // common/real-time messages, and running status may not span them.
      running = status < 0xf0 ? status : null
    }

    if (status === 0xff) {
      need(1, 'meta event type')
      const metaType = data[cursor]
      cursor += 1
      const lengthInfo = readVlq(data, cursor, end)
      cursor = lengthInfo.offset
      const length = lengthInfo.value
      if (cursor + length > end) {
        fail(`truncated meta event ${hexByte(metaType)} at byte ${cursor}: declares ${length} byte(s), ${end - cursor} remain`)
      }
      const payload = data.subarray(cursor, cursor + length)
      cursor += length
      if (metaType === 0x51) {
        if (length < 3) fail(`tempo event at tick ${tick} carries ${length} byte(s), expected 3`)
        const microseconds = (payload[0] << 16) | (payload[1] << 8) | payload[2]
        if (microseconds <= 0) fail(`tempo event at tick ${tick} has 0 microseconds per quarter`)
        events.push({ tick, type: 'tempo', microsecondsPerQuarter: microseconds, bpm: round3(60000000 / microseconds) })
      } else if (metaType === 0x03) {
        const text = decodeText(payload)
        if (name === null && text !== '') name = text
        events.push({ tick, type: 'name', name: text })
      } else if (metaType === 0x58) {
        if (length < 4) fail(`time-signature event at tick ${tick} carries ${length} byte(s), expected 4`)
        const signature = {
          numerator: payload[0],
          denominator: Math.pow(2, payload[1]),
          denominatorPower: payload[1],
          clocksPerClick: payload[2],
          thirtySeconds: payload[3]
        }
        if (timeSignature === null) timeSignature = signature
        events.push({ tick, type: 'timeSignature', ...signature })
      } else if (metaType === 0x59) {
        if (length < 2) fail(`key-signature event at tick ${tick} carries ${length} byte(s), expected 2`)
        const signature = { sharpsFlats: payload[0] > 127 ? payload[0] - 256 : payload[0], minor: payload[1] === 1 }
        if (keySignature === null) keySignature = signature
        events.push({ tick, type: 'keySignature', ...signature })
      } else if (metaType === 0x2f) {
        events.push({ tick, type: 'endOfTrack' })
        // The spec says end-of-track is last; some writers pad after it, so stop
        // reading rather than blame the padding for being malformed.
        cursor = end
        break
      } else {
        events.push({ tick, type: 'meta', metaType, length })
      }
      continue
    }

    if (status === 0xf0 || status === 0xf7) {
      const lengthInfo = readVlq(data, cursor, end)
      cursor = lengthInfo.offset
      const length = lengthInfo.value
      if (cursor + length > end) fail(`truncated sysex event at byte ${cursor}: declares ${length} byte(s), ${end - cursor} remain`)
      cursor += length
      events.push({ tick, type: 'sysex', length })
      continue
    }
    if (status >= 0xf0) fail(`unsupported system message ${hexByte(status)} at byte ${eventOffset}`)

    const kind = status & 0xf0
    const channel = status & 0x0f
    channelSet.add(channel)

    if (kind === 0x80 || kind === 0x90) {
      need(2, 'note event')
      const midi = data[cursor]
      const velocity = data[cursor + 1]
      cursor += 2
      if (midi > 0x7f || velocity > 0x7f) {
        fail(`invalid data byte in note event at byte ${eventOffset}: note ${midi}, velocity ${velocity} (data bytes must be 0..127)`)
      }
      if (kind === 0x90 && velocity > 0) {
        events.push({ tick, type: 'noteOn', channel, midi, velocity })
        const key = channel * 128 + midi
        let list = open.get(key)
        if (list === undefined) {
          list = []
          open.set(key, list)
        }
        list.push({ startTicks: tick, velocity })
      } else {
        // note-on with velocity 0 is the traditional note-off spelling.
        events.push({ tick, type: 'noteOff', channel, midi, velocity })
        closeNote(channel, midi, tick)
      }
      continue
    }

    if (kind === 0xa0) {
      need(2, 'poly aftertouch event')
      const midi = data[cursor]
      const value = data[cursor + 1]
      cursor += 2
      events.push({ tick, type: 'polyPressure', channel, midi, value })
      continue
    }
    if (kind === 0xb0) {
      need(2, 'controller event')
      const controller = data[cursor]
      const value = data[cursor + 1]
      cursor += 2
      // 14-bit pairs are deliberately not combined (see the module JSDoc).
      events.push({ tick, type: 'controller', channel, controller, value })
      continue
    }
    if (kind === 0xc0) {
      need(1, 'program change event')
      const program = data[cursor]
      cursor += 1
      if (!programByChannel.has(channel)) programByChannel.set(channel, program)
      events.push({ tick, type: 'program', channel, program })
      continue
    }
    if (kind === 0xd0) {
      need(1, 'channel pressure event')
      const value = data[cursor]
      cursor += 1
      events.push({ tick, type: 'channelPressure', channel, value })
      continue
    }
    // kind === 0xe0: pitch bend, a genuine 14-bit channel message.
    need(2, 'pitch bend event')
    const value = data[cursor] | (data[cursor + 1] << 7)
    cursor += 2
    events.push({ tick, type: 'pitchBend', channel, value })
  }

  // A note whose note-off never arrived is closed at the end of its track: the
  // alternative is dropping audible music because the file is sloppy.
  for (const [key, list] of open) {
    const midi = key % 128
    const channel = Math.floor(key / 128)
    for (const started of list) {
      notes.push({
        midi,
        channel,
        startTicks: started.startTicks,
        durTicks: Math.max(1, tick - started.startTicks),
        velocity: started.velocity
      })
      unclosedNotes += 1
    }
  }

  notes.sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi || a.durTicks - b.durTicks)
  const channels = [...channelSet].sort((a, b) => a - b)
  let program = null
  if (channels.length === 1 && programByChannel.has(channels[0])) program = programByChannel.get(channels[0])

  return {
    index,
    name,
    channel: channels.length === 1 ? channels[0] : null,
    channels,
    program,
    programByChannel,
    notes,
    events,
    endTick: tick,
    orphanNoteOffs,
    unclosedNotes,
    timeSignature,
    keySignature
  }
}

/** Last tick touched by a track's notes or events. */
function trackEndTick (notes, events) {
  let end = 0
  for (const note of notes) end = Math.max(end, note.startTicks + note.durTicks)
  for (const event of events) end = Math.max(end, event.tick)
  return end
}

/**
 * Seconds elapsed at `tick`, integrating across tempo changes.
 * Tempo is a global format-1 property, so the map is built from every track.
 */
function tickToSeconds (tick, tempoMap, ticksPerQuarter) {
  let seconds = 0
  let lastTick = 0
  let microseconds = DEFAULT_US_PER_QUARTER
  for (const entry of tempoMap) {
    if (entry.tick >= tick) break
    seconds += (entry.tick - lastTick) * microseconds / 1e6 / ticksPerQuarter
    lastTick = entry.tick
    microseconds = entry.microsecondsPerQuarter
  }
  seconds += (tick - lastTick) * microseconds / 1e6 / ticksPerQuarter
  return seconds
}

/**
 * Parse a Standard MIDI File.
 *
 * Returns one logical track per channel stream: a format 1 file keeps its
 * physical MTrk chunks, while a format 0 (or a multi-channel MTrk) file is split
 * per channel so the result is usable as tracks instead of one merged blob. The
 * physical chunk each logical track came from is reported as `sourceTrack`.
 *
 * Every malformed input throws an `Error` whose message starts `midi: ` and names
 * the problem and the byte offset (never a raw RangeError from a buffer read).
 *
 * @param {Buffer|Uint8Array|number[]} bytes - the file contents.
 * @param {object} [options]
 * @param {boolean} [options.lenient] - skip unknown chunk types instead of
 *   rejecting the file (the SMF spec tells readers to skip them; this plugin
 *   rejects by default so a typo in a header is a message, not silent silence).
 * @param {boolean} [options.splitChannels] - split a multi-channel MTrk into one
 *   logical track per channel. Defaults to true for format 0 files and false
 *   otherwise.
 * @returns {{
 *   format: number,
 *   ticksPerQuarter: number,
 *   tempoBpm: number,
 *   timeSignature: {numerator:number, denominator:number, denominatorPower:number, clocksPerClick:number, thirtySeconds:number}|null,
 *   keySignature: {sharpsFlats:number, minor:boolean}|null,
 *   tracks: object[],
 *   durationSeconds: number,
 *   durationTicks: number,
 *   noteCount: number,
 *   trackCount: number,
 *   physicalTrackCount: number,
 *   tempoEvents: {tick:number, microsecondsPerQuarter:number, bpm:number}[],
 *   warnings: string[]
 * }} the parsed file. Each track carries `name`, `channel`, `program`, `notes`
 *   (`{midi, channel, startTicks, durTicks, velocity}`), `events` and `endTick`.
 */
export function parseMidiFile (bytes, options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const data = toBuffer(bytes)
  if (data.length < 8) fail(`truncated header: expected at least 8 bytes, got ${data.length}`)
  const magic = data.toString('latin1', 0, 4)
  if (magic !== 'MThd') fail(`not a Standard MIDI File: expected "MThd" at byte 0, found "${magic.replace(/[^\x20-\x7e]/g, '.')}"`)

  const headerLength = data.readUInt32BE(4)
  if (headerLength < 6) fail(`invalid MThd length ${headerLength} (must be at least 6)`)
  if (data.length < 8 + headerLength) fail(`truncated header: MThd declares ${headerLength} byte(s), only ${data.length - 8} remain`)
  const format = data.readUInt16BE(8)
  const trackCount = data.readUInt16BE(10)
  const division = data.readUInt16BE(12)
  if (format > 2) fail(`unsupported MIDI format ${format} (expected 0, 1 or 2)`)
  if ((division & 0x8000) !== 0) {
    fail(`SMPTE time division (raw division ${division}) is not supported; only ticks-per-quarter files can be parsed`)
  }
  const ticksPerQuarter = division & 0x7fff
  if (ticksPerQuarter === 0) fail('invalid time division 0: ticks per quarter note must be positive')
  if (trackCount === 0) fail('file declares 0 tracks')
  if (format === 0 && trackCount > 1) fail(`format 0 file declares ${trackCount} tracks (format 0 must hold exactly 1)`)
  if (trackCount > MAX_TRACKS * 4) fail(`file declares ${trackCount} tracks, which exceeds the supported ${MAX_TRACKS * 4}`)

  const warnings = []
  const physical = []
  let offset = 8 + headerLength
  while (physical.length < trackCount) {
    if (offset + 8 > data.length) {
      fail(`truncated: expected ${trackCount} MTrk chunk(s), found ${physical.length} before the end of the data at byte ${offset}`)
    }
    const type = data.toString('latin1', offset, offset + 4)
    const length = data.readUInt32BE(offset + 4)
    const bodyStart = offset + 8
    if (bodyStart + length > data.length) {
      fail(`truncated ${type.replace(/[^\x20-\x7e]/g, '?')} chunk at byte ${offset}: declares ${length} byte(s), only ${data.length - bodyStart} remain`)
    }
    if (type !== 'MTrk') {
      if (opts.lenient !== true) {
        fail(`unknown chunk "${type.replace(/[^\x20-\x7e]/g, '?')}" at byte ${offset} (expected "MTrk"); parse with lenient: true to skip unknown chunks`)
      }
      warnings.push(`skipped unknown ${length}-byte chunk "${type.replace(/[^\x20-\x7e]/g, '?')}" at byte ${offset}`)
      offset = bodyStart + length
      continue
    }
    physical.push(parseTrack(data, bodyStart, bodyStart + length, physical.length))
    offset = bodyStart + length
  }
  if (physical.length === 0) fail('no MTrk chunk found')
  if (offset < data.length) warnings.push(`${data.length - offset} trailing byte(s) after the last declared track were ignored`)
  if (format === 2) warnings.push('format 2 file: tracks are independent sequences; duration is measured from the longest one')

  for (const track of physical) {
    if (track.unclosedNotes > 0) warnings.push(`${track.unclosedNotes} note(s) in track ${track.index + 1} had no note-off and were closed at the end of the track`)
    if (track.orphanNoteOffs > 0) warnings.push(`${track.orphanNoteOffs} note-off(s) in track ${track.index + 1} had no matching note-on`)
  }

  /* Tempo map: global in format 1, so collected from every track, sorted by tick. */
  const tempoMap = []
  for (const track of physical) {
    for (const event of track.events) {
      if (event.type === 'tempo') tempoMap.push({ tick: event.tick, microsecondsPerQuarter: event.microsecondsPerQuarter })
    }
  }
  tempoMap.sort((a, b) => a.tick - b.tick)
  const opening = tempoMap.find((entry) => entry.tick === 0) ?? null
  const tempoBpm = opening === null ? DEFAULT_BPM : round3(60000000 / opening.microsecondsPerQuarter)

  /* Logical tracks: split a merged channel stream so the result is usable. */
  const splitChannels = opts.splitChannels === true || (opts.splitChannels !== false && format === 0)
  const tracks = []
  for (const track of physical) {
    const noteChannels = [...new Set(track.notes.map((note) => note.channel))].sort((a, b) => a - b)
    if (splitChannels && noteChannels.length > 1) {
      const metaEvents = track.events.filter((event) => event.channel === undefined)
      for (const channel of noteChannels) {
        const notes = track.notes.filter((note) => note.channel === channel)
        const channelEvents = track.events.filter((event) => event.channel === channel)
        const events = metaEvents.concat(channelEvents).sort((a, b) => a.tick - b.tick)
        tracks.push({
          index: tracks.length,
          sourceTrack: track.index,
          name: track.name === null ? null : `${track.name} ch${channel + 1}`,
          channel,
          channels: [channel],
          program: track.programByChannel.has(channel) ? track.programByChannel.get(channel) : null,
          notes,
          events,
          endTick: trackEndTick(notes, events)
        })
      }
      continue
    }
    tracks.push({
      index: tracks.length,
      sourceTrack: track.index,
      name: track.name,
      channel: track.channel,
      channels: track.channels,
      program: track.program,
      notes: track.notes,
      events: track.events,
      endTick: trackEndTick(track.notes, track.events)
    })
  }

  const durationTicks = physical.reduce((end, track) => Math.max(end, track.endTick), 0)
  let noteCount = 0
  for (const track of tracks) noteCount += track.notes.length

  const timeSignature = physical.reduce((found, track) => found ?? track.timeSignature, null)
  const keySignature = physical.reduce((found, track) => found ?? track.keySignature, null)

  return {
    format,
    ticksPerQuarter,
    tempoBpm,
    timeSignature,
    keySignature,
    tracks,
    durationSeconds: round6(tickToSeconds(durationTicks, tempoMap, ticksPerQuarter)),
    durationTicks,
    noteCount,
    trackCount: tracks.length,
    physicalTrackCount: physical.length,
    tempoEvents: tempoMap.map((entry) => ({
      tick: entry.tick,
      microsecondsPerQuarter: entry.microsecondsPerQuarter,
      bpm: round3(60000000 / entry.microsecondsPerQuarter)
    })),
    warnings
  }
}

/* ------------------------------------------------------------- score -> mid -- */

/**
 * Convert a `composeScore` result into a `writeMidiFile` request.
 *
 * The score speaks bars and beats; MIDI speaks absolute beats. This is the one
 * place that arithmetic lives. It also decides the channel and General MIDI
 * program per track, so the file opens in a DAW with the right instruments
 * instead of five copies of the piano:
 *
 *   bass -> ch 1 program 33 (electric bass), harmony -> ch 2 program 89 (warm
 *   pad), melody -> ch 3 program 73 (flute), color -> ch 4 program 9
 *   (glockenspiel), rhythm -> ch 10 (GM percussion, no program change).
 *
 * Articulation is baked into the request here, because the score's `artic` is
 * richer than MIDI: `staccato` halves the note length, `accent` scales velocity
 * by 1.25 and `ghost` by 0.6 (see `articulationShape`). The output notes are
 * marked `normal` so a write of this request does not apply the mapping twice.
 * Velocity is passed on its 0..1 scale and quantised to 7 bits exactly once, in
 * the writer.
 *
 * Notes with `midi < 1` are dropped: the compose engine uses MIDI 0 for a noise
 * bed, and a bed is not a note. The track itself is kept (as an empty MTrk) so
 * the exported track count still matches the score.
 *
 * @param {object} score - a `composeScore` result, or anything with the same
 *   `bpm`, `beatsPerBar`, `bars` and `tracks[].notes[{bar, beat, durBeats, midi,
 *   velocity, artic}]` shape.
 * @param {object} [options]
 * @param {Record<string, number>} [options.channels] - role -> channel override.
 * @param {Record<string, number>} [options.programs] - role -> program override.
 * @returns {{ bpm:number, beatsPerBar:number, endBeats:number,
 *   tracks:object[], skippedNotes:number }} a request for
 *   {@link writeMidiFile}; `skippedNotes` counts unpitched notes left behind.
 */
export function scoreToMid (score, options = {}) {
  if (score === null || typeof score !== 'object' || !Array.isArray(score.tracks)) {
    throw new Error('scoreToMid: expected a compose score (an object with bpm and a tracks array); use composeScore() to build one')
  }
  const opts = options !== null && typeof options === 'object' ? options : {}
  const bpm = Number.isFinite(Number(score.bpm)) && Number(score.bpm) > 0 ? Number(score.bpm) : DEFAULT_BPM
  const beatsPerBar = clamp(Math.round(Number.isFinite(Number(score.beatsPerBar)) ? Number(score.beatsPerBar) : 4), 1, 32)
  const bars = Number.isFinite(Number(score.bars)) ? Math.max(0, Math.round(Number(score.bars))) : 0
  const channelOverrides = opts.channels !== null && typeof opts.channels === 'object' ? opts.channels : {}
  const programOverrides = opts.programs !== null && typeof opts.programs === 'object' ? opts.programs : {}
  const usedChannels = new Set()
  const tracks = []
  let endBeats = bars * beatsPerBar
  let skippedNotes = 0

  for (let index = 0; index < score.tracks.length; index += 1) {
    const track = score.tracks[index] !== null && typeof score.tracks[index] === 'object' ? score.tracks[index] : {}
    const role = typeof track.role === 'string' && track.role !== ''
      ? track.role
      : (typeof track.id === 'string' ? track.id : '')
    const sourceNotes = Array.isArray(track.notes) ? track.notes : []
    const first = sourceNotes[0]
    if (sourceNotes.length > 0 && first !== null && typeof first === 'object' &&
      first.bar === undefined && first.beat === undefined && first.startBeats !== undefined) {
      throw new Error(`scoreToMid: track "${role || index}" is already in beats, not bars; pass that track to writeMidiFile directly`)
    }

    const table = MIDI_SCORE_VOICES[role] ?? null
    let channel = null
    if (Number.isFinite(Number(channelOverrides[role]))) channel = clamp(Math.round(Number(channelOverrides[role])), 0, 15)
    else if (table !== null) channel = table.channel
    if (channel === null || usedChannels.has(channel)) {
      channel = SPARE_CHANNELS.find((candidate) => !usedChannels.has(candidate))
    }
    if (channel === undefined) channel = index % 16
    usedChannels.add(channel)

    let program = table === null ? 0 : table.program
    if (Object.prototype.hasOwnProperty.call(programOverrides, role)) {
      const override = programOverrides[role]
      program = override === null ? null : clamp(Math.round(Number(override)) || 0, 0, 127)
    }
    // GM ignores program changes on the percussion channel.
    if (channel === 9) program = null

    const notes = []
    for (const note of sourceNotes) {
      if (note === null || typeof note !== 'object') continue
      const midi = Math.round(Number(note.midi))
      const bar = Number(note.bar)
      const beat = Number(note.beat)
      if (!Number.isFinite(midi) || midi < 1 || midi > 127 || !Number.isFinite(bar) || !Number.isFinite(beat)) {
        skippedNotes += 1
        continue
      }
      const startBeats = Math.max(0, bar * beatsPerBar + beat)
      const rawDuration = Number(note.durBeats)
      const durBeats = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0.25
      const velocity = clamp(Number.isFinite(Number(note.velocity)) ? Number(note.velocity) : 0.8, 0.01, 1)
      const artic = typeof note.artic === 'string' ? note.artic : 'normal'
      const shaped = articulationShape(artic, durBeats, velocity)
      endBeats = Math.max(endBeats, startBeats + durBeats)
      notes.push({
        midi,
        startBeats,
        durBeats: Math.max(0.01, round4(shaped.durBeats)),
        // Rounded for a readable request; the writer quantises to 7 bits.
        velocity: round4(shaped.velocity),
        // Already baked into durBeats/velocity: the writer must not reapply it.
        artic: 'normal'
      })
    }

    const label = role === '' ? `track ${index + 1}` : role
    const instrument = typeof track.instrument === 'string' && track.instrument !== '' ? ` (${track.instrument})` : ''
    tracks.push({ name: `${label}${instrument}`, channel, program, notes })
  }

  return { bpm, beatsPerBar: clamp(beatsPerBar, 1, 32), endBeats, tracks, skippedNotes }
}
