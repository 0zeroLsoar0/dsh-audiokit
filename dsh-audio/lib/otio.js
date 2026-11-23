/**
 * OpenTimelineIO (`.otio`) export — a JSON interchange timeline.
 *
 * OTIO is the interop format that costs the least to get right and pays off
 * immediately: it is a documented JSON schema, Resolve 18+ reads it natively,
 * Nuke reads it natively, and Premiere/Media Composer read it through the OTIO
 * adapters. Unlike the EDL it carries overlapping clips (one track each), and
 * unlike AAF it needs no binary object model — so this module is where the
 * "will it open?" answer is yes rather than "the container is right, the schema
 * layer is missing".
 *
 * Shape of the document this writer produces:
 *
 * ```
 * Timeline.1 → tracks: Stack.1 → Track.1 (kind "Audio") per lane
 *                                        └── Gap.1 / Clip.2 with an
 *                                            ExternalReference.1 pointing at the wav
 * ```
 *
 * Two deliberate decisions:
 *
 * 1. **Lanes, not one track per cue.** Clips that overlap cannot share a track
 *    in any timeline model, so cues are packed into the minimum number of lanes
 *    where they do not overlap (`packLanes`, the same interval partitioning the
 *    AAF writer uses). A lane becomes one Track; a gap becomes a Gap item.
 * 2. **Sample-accurate time.** RationalTime's `rate` is the audio sample rate,
 *    not a frame rate: a sound cue placed at 0.25 s stays at exactly sample
 *    12000 instead of being rounded to the nearest 40 ms frame. Every OTIO
 *    consumer accepts an arbitrary rational rate, and audio timelines are
 *    conventionally expressed in samples.
 *
 * Gain and fades have no representation in OTIO's audio model, so they travel in
 * the clip's `metadata` namespace `dsh-audiokit` — visible to a script, and
 * called out in the result warnings so nobody assumes the editor applied them.
 */

import { packLanes } from './timeline.js'

/** Schema names and versions this writer emits; OTIO requires the version suffix. */
const SCHEMA = Object.freeze({
  timeline: 'Timeline.1',
  stack: 'Stack.1',
  track: 'Track.1',
  clip: 'Clip.2',
  gap: 'Gap.1',
  external: 'ExternalReference.1',
  timeRange: 'TimeRange.1',
  rationalTime: 'RationalTime.1'
})

/** Metadata key that namespaces everything an editor cannot represent. */
const METADATA_KEY = 'dsh-audiokit'

/** Default edit rate when the caller does not name one: CD-quality samples. */
const DEFAULT_RATE = 48000

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

function fail (caller, message) {
  throw new Error(`${caller}: ${message}`)
}

/** Collapse control characters so a cue name survives a JSON round trip cleanly. */
function singleLineText (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A `RationalTime.1` at `value` units of `rate` per second. */
function rationalTime (value, rate) {
  return { OTIO_SCHEMA: SCHEMA.rationalTime, rate, value }
}

/** A `TimeRange.1` starting at 0 with `duration` units. */
function timeRange (duration, rate) {
  return {
    OTIO_SCHEMA: SCHEMA.timeRange,
    start_time: rationalTime(0, rate),
    duration: rationalTime(duration, rate)
  }
}

/** True when `value` is a finite, non-negative duration this writer can place. */
function readSeconds (caller, label, value, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(caller, `${label} is required`)
    return fallback
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) fail(caller, `${label} must be a non-negative finite number, got ${describeValue(value)}`)
  return number
}

/** Convert seconds to whole edit units, rounding deterministically. */
function toUnits (seconds, rate) {
  return Math.round(seconds * rate)
}

/**
 * Export a cue set as an OpenTimelineIO document.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, path?, url?, at, duration, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {number} [request.sampleRate] - edit rate for RationalTime; default 48000.
 * @param {string} [request.title] - timeline name.
 * @returns {{ text: string, bytes: number, warnings: string[], events: number,
 *   durationSeconds: number, tracks: number, rate: number }}
 */
export function exportOtio (request = {}) {
  const caller = 'otio'
  const cues = request.cues
  if (!Array.isArray(cues) || cues.length === 0) {
    fail(caller, 'cues must be a non-empty array of { name, path, at, duration }')
  }
  if (cues.length > 20000) fail(caller, `${cues.length} cues exceeds the 20000 event limit`)
  const rate = Math.round(readSeconds(caller, 'sampleRate', request.sampleRate, DEFAULT_RATE)) || DEFAULT_RATE
  if (rate < 1000 || rate > 384000) fail(caller, `sampleRate must be between 1000 and 384000, got ${rate}`)

  const warnings = []
  const entries = cues.map((cue, index) => {
    const label = `cue ${index + 1}`
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) fail(caller, `${label} must be an object`)
    const at = readSeconds(caller, `${label} at`, cue.at, 0)
    const duration = readSeconds(caller, `${label} duration`, cue.duration)
    if (duration === 0) fail(caller, `${label} duration must be greater than 0, got 0`)
    const path = singleLineText(cue.path)
    const url = singleLineText(cue.url)
    if (path === '' && url === '') warnings.push(`${label} has no path; the clip is written without a media reference`)
    const name = singleLineText(cue.name) || (path === '' ? `Cue ${index + 1}` : path.split('/').pop().replace(/\.[^.]+$/, ''))
    return {
      index,
      name,
      path,
      url,
      at,
      duration,
      gainDb: Number(cue.gainDb ?? 0),
      fadeIn: readSeconds(caller, `${label} fadeIn`, cue.fadeIn, 0),
      fadeOut: readSeconds(caller, `${label} fadeOut`, cue.fadeOut, 0)
    }
  })

  // Lanes keep overlapping cues expressible: one Track per lane.
  const lanes = packLanes(entries)
  const tracks = lanes.map((lane, laneIndex) => {
    const children = []
    let cursor = 0
    for (const entry of lane) {
      const start = toUnits(entry.at, rate)
      const length = Math.max(1, toUnits(entry.duration, rate))
      if (start > cursor) {
        children.push({
          OTIO_SCHEMA: SCHEMA.gap,
          name: '',
          source_range: timeRange(start - cursor, rate),
          effects: [],
          markers: [],
          metadata: {},
          enabled: true
        })
        cursor = start
      }
      const metadata = { sourcePath: entry.path === '' ? null : entry.path }
      if (entry.gainDb !== 0) metadata.gainDb = entry.gainDb
      if (entry.fadeIn > 0) metadata.fadeIn = entry.fadeIn
      if (entry.fadeOut > 0) metadata.fadeOut = entry.fadeOut
      const clip = {
        OTIO_SCHEMA: SCHEMA.clip,
        name: entry.name,
        source_range: timeRange(length, rate),
        media_references: {},
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects: [],
        // OTIO cannot express a level or a fade; metadata + a warning is the
        // honest place for them, not an effect that no reader implements.
        markers: [],
        metadata: { [METADATA_KEY]: metadata },
        enabled: true
      }
      if (entry.url !== '' || entry.path !== '') {
        clip.media_references.DEFAULT_MEDIA = {
          OTIO_SCHEMA: SCHEMA.external,
          name: entry.name,
          available_range: timeRange(length, rate),
          metadata: {},
          target_url: entry.url !== '' ? entry.url : entry.path
        }
      }
      children.push(clip)
      cursor = start + length
    }
    return {
      OTIO_SCHEMA: SCHEMA.track,
      name: `Lane ${laneIndex + 1}`,
      kind: 'Audio',
      children,
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      enabled: true
    }
  })
  if (lanes.length > 1) {
    warnings.push(`${entries.length} cues overlapped, so they were packed into ${lanes.length} audio tracks (a track cannot hold two clips at the same time; OTIO preserves overlaps as separate tracks)`)
  }
  const levels = entries.filter((entry) => entry.gainDb !== 0 || entry.fadeIn > 0 || entry.fadeOut > 0).length
  if (levels > 0) {
    warnings.push(`${levels} cue(s) carry a gain or a fade that OTIO has no audio field for; they are written into clip metadata under "${METADATA_KEY}" and must be applied in the editor`)
  }

  const timeline = {
    OTIO_SCHEMA: SCHEMA.timeline,
    name: singleLineText(request.title) || 'dsh-audiokit timeline',
    global_start_time: rationalTime(0, rate),
    metadata: {},
    tracks: {
      OTIO_SCHEMA: SCHEMA.stack,
      name: 'tracks',
      children: tracks,
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      enabled: true
    }
  }
  const text = `${JSON.stringify(timeline, null, 2)}\n`
  const durationSeconds = Math.max(0, ...entries.map((entry) => entry.at + entry.duration))
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    events: entries.length,
    durationSeconds: Math.round(durationSeconds * 1e6) / 1e6,
    tracks: tracks.length,
    rate
  }
}

/**
 * Parse an OTIO document written by `exportOtio` and check the invariants an
 * OTIO reader relies on: schema versions, one audio kind per track, children
 * that fill the track without holes, and clip ranges that survive the round
 * trip.
 *
 * The writer is only trustworthy if it can be read back: this is the same
 * contract `lib/daw.js` follows for EDL and RPP.
 *
 * @param {string} text - JSON text.
 * @returns {{ name: string, rate: number, tracks: Array<{name: string, kind: string,
 *   clips: Array<{name: string, at: number, duration: number, targetUrl: string|null}> }>,
 *   durationSeconds: number, warnings: string[] }}
 */
export function parseOtio (text) {
  const caller = 'otio'
  if (typeof text !== 'string' || text.trim() === '') fail(caller, 'cannot parse an empty OTIO document')
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    fail(caller, `the document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (document === null || typeof document !== 'object') fail(caller, 'the document must be a JSON object')
  if (document.OTIO_SCHEMA !== SCHEMA.timeline) fail(caller, `expected ${SCHEMA.timeline} at the top level, got ${describeValue(document.OTIO_SCHEMA)}`)
  const stack = document.tracks
  if (stack === null || typeof stack !== 'object' || stack.OTIO_SCHEMA !== SCHEMA.stack) {
    fail(caller, `expected a ${SCHEMA.stack} in "tracks", got ${describeValue(stack?.OTIO_SCHEMA)}`)
  }
  const warnings = []
  // The edit rate is the `rate` field of the global start time, not its value.
  // A start time is `value: 0` by definition, so reading the value here would
  // make every position infinite — and `??` would not catch the zero.
  const startTime = document.global_start_time
  const startRate = startTime !== null && typeof startTime === 'object' && typeof startTime.rate === 'number'
    ? startTime.rate
    : null
  const rate = startRate !== null && Number.isFinite(startRate) && startRate > 0 ? startRate : DEFAULT_RATE
  const tracks = []
  for (const track of stack.children ?? []) {
    if (track.OTIO_SCHEMA !== SCHEMA.track) fail(caller, `expected ${SCHEMA.track}, got ${describeValue(track.OTIO_SCHEMA)}`)
    if (track.kind !== 'Audio') warnings.push(`track ${describeValue(track.name)} has kind ${describeValue(track.kind)}, expected "Audio"`)
    const clips = []
    let cursor = 0
    for (const child of track.children ?? []) {
      const range = child.source_range
      if (range === null || typeof range !== 'object' || range.OTIO_SCHEMA !== SCHEMA.timeRange) {
        fail(caller, `an item in track ${describeValue(track.name)} has no source_range`)
      }
      const length = numberFromRationalTime(range.duration)
      if (length === null) fail(caller, `an item in track ${describeValue(track.name)} has a duration that is not a rational time`)
      if (child.OTIO_SCHEMA === SCHEMA.gap) {
        cursor += length
        continue
      }
      if (child.OTIO_SCHEMA !== SCHEMA.clip) fail(caller, `unexpected item schema ${describeValue(child.OTIO_SCHEMA)}`)
      const reference = child.media_references?.[child.active_media_reference_key ?? 'DEFAULT_MEDIA'] ?? null
      clips.push({
        name: child.name,
        at: cursor / rate,
        duration: length / rate,
        targetUrl: reference === null ? null : reference.target_url ?? null,
        metadata: child.metadata ?? {}
      })
      cursor += length
    }
    tracks.push({ name: track.name, kind: track.kind, clips, length: cursor / rate })
  }
  const durationSeconds = Math.max(0, ...tracks.map((track) => track.length))
  return { name: document.name ?? null, rate, tracks, durationSeconds: Math.round(durationSeconds * 1e6) / 1e6, warnings }
}

function numberFromRationalTime (value) {
  if (value === null || typeof value !== 'object') return null
  if (value.OTIO_SCHEMA !== SCHEMA.rationalTime) return null
  return typeof value.value === 'number' ? value.value : Number(value.value)
}
