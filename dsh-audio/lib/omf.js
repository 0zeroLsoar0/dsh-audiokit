/**
 * OMF (OMFI v2) —a documented skeleton, not an exporter.
 *
 * OMF Interchange is Avid's predecessor to AAF, and it is still the format some
 * Pro Tools workflows ask for. It shares the container with AAF (an MS-CFB
 * document) but not the object model: an OMFI file carries an `OMFI:HEADER`
 * stream whose 1024-byte header describes the byte order, version and object
 * table, and then one stream per object in a class-specific big-endian layout
 * that is Avid's own, documented only in the OMFI 2.1 specification. There is no
 * open reference implementation to check against, unlike AAF where the object
 * model can be read from any AAF SDK based writer.
 *
 * That is why this module writes a **skeleton** and says so in the file, in its
 * result and in `docs/INTEROP.zh.md`: a container with the stream an OMFI file
 * starts with, holding a machine-readable manifest of the objects an OMFI
 * writer would have to produce, plus an explicit marker that this is not an OMF
 * document. Avid will not open it, and the file itself says so in ASCII —the
 * alternative, emitting plausible-looking OMFI objects whose class layouts were
 * guessed, would produce a file that fails later and hides the reason.
 *
 * What a real OMFI v2 writer needs, in the order it would be built:
 *
 * 1. the 1024-byte OMFI header record (magic, version, byte order, object
 *    table entries) —format known, byte layout to be transcribed from the
 *    specification;
 * 2. the Class A/B object streams (`OMFI:C...` / `OMFI:B...`), each with a
 *    length-prefixed big-endian property table;
 * 3. the composition (CMOB / CMOBGroup / CTrack / CClip) and media objects
 *    (MMOB / MMedia / MSource), plus the container/essence references;
 * 4. Avid-specific restrictions: 2-channel interleaved PCM, a fixed set of
 *    sample rates, and a media file alongside the project.
 *
 * Estimated effort from the AAF work in this plugin: the container is done
 * (`lib/cfb.js`), and the object writer is comparable to `lib/aaf.js` —roughly
 * 400—00 lines plus a test —but without a reference implementation to check
 * bytes against, "it opens in Avid" can only be proven on a machine with Avid
 * installed. That is the honest blocker, and it is why this ships as a skeleton.
 */

import { writeCompoundFile } from './cfb.js'

/** A stable identifier for the skeleton layout, written into the file. */
const SKELETON_MARKER = 'DSH-AUDIOKIT-OMF-SKELETON-V1'

/** The stream name an OMFI document begins with. */
const HEADER_STREAM = 'OMFI:HEADER'

/** The stream holding the manifest (not part of OMFI; this writer's addition). */
const MANIFEST_STREAM = 'DSH:MANIFEST'

/** What this exporter can and cannot do, in the shape the tool result reports. */
export const OMF_CAPABILITIES = Object.freeze({
  format: 'OMFI v2',
  container: 'MS-CFB version 3',
  importable: false,
  skeleton: true,
  implemented: Object.freeze(['container', 'provisional header stream', 'object manifest']),
  missing: Object.freeze([
    'OMFI header record byte layout',
    'class A/B object streams',
    'composition objects (CMOB, CMOBGroup, CTrack, CClip)',
    'media objects (MMOB, MMedia, MSource)',
    'interleaved 2-channel PCM essence and edit unit tables',
    'Avid validation'
  ]),
  estimate: '1-2 days with the OMFI 2.1 specification at hand, unverifiable without Avid installed'
})

/** Plain-text explanation of the skeleton, written into the header stream. */
const HEADER_TEXT = [
  SKELETON_MARKER,
  '',
  'This file is NOT an OMF Interchange document and cannot be opened by Avid',
  'Pro Tools, Media Composer or any other OMFI reader. It is the container',
  'skeleton the dsh-audiokit exporter writes so the remaining work has a place',
  'to land: the directory tree, the stream naming and the object manifest are',
  'here, the OMFI object model is not.',
  '',
  'A conforming OMFI v2 file starts with a 1024-byte header record in this',
  'stream, an object table, and one stream per object using Avid\'s big-endian',
  'class layouts. See docs/INTEROP.zh.md in the plugin for the work list.'
].join('\n')

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

/**
 * Write the OMF skeleton for a cue set.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, path?, at, duration, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {string} [request.title] - project name recorded in the manifest.
 * @returns {object} `{ buffer, bytes, warnings, events, durationSeconds, importable: false, skeleton: true, capabilities }`
 */
export function exportOmf (request = {}) {
  const caller = 'omf'
  const cues = request.cues
  if (!Array.isArray(cues) || cues.length === 0) {
    fail(caller, 'cues must be a non-empty array of { name, path, at, duration }')
  }
  if (cues.length > 20000) fail(caller, `${cues.length} cues exceeds the 20000 event limit`)
  const entries = cues.map((cue, index) => {
    const label = `cue ${index + 1}`
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) fail(caller, `${label} must be an object`)
    const at = Number(cue.at ?? 0)
    const duration = Number(cue.duration)
    if (!Number.isFinite(at) || at < 0) fail(caller, `${label} at must be a non-negative finite number, got ${describeValue(cue.at)}`)
    if (!Number.isFinite(duration) || duration <= 0) fail(caller, `${label} duration must be greater than 0, got ${describeValue(cue.duration)}`)
    return {
      name: String(cue.name ?? '').trim() || `Cue ${index + 1}`,
      path: cue.path === undefined || cue.path === null ? null : String(cue.path),
      at,
      duration,
      gainDb: Number(cue.gainDb ?? 0),
      fadeIn: Number(cue.fadeIn ?? 0),
      fadeOut: Number(cue.fadeOut ?? 0)
    }
  })
  const durationSeconds = Math.round(Math.max(0, ...entries.map((entry) => entry.at + entry.duration)) * 1e6) / 1e6

  // The manifest is what a future OMFI writer consumes: the timeline in the same
  // shape the other exporters take, plus the object kinds that still have to be
  // produced. It is JSON so the next step can be scripted instead of re-read.
  const manifest = {
    marker: SKELETON_MARKER,
    format: 'OMFI v2',
    importable: false,
    title: String(request.title ?? '').trim() || 'dsh-audiokit timeline',
    durationSeconds,
    events: entries.length,
    cues: entries,
    objectPlan: [
      { omfiClass: 'CMOB', role: 'composition' },
      { omfiClass: 'CMOBGroup', role: 'one slot per timeline track' },
      { omfiClass: 'CTrack', role: 'one per composition group' },
      { omfiClass: 'CClip', role: 'one per cue, with edit unit start/length' },
      { omfiClass: 'MMOB', role: 'one per source media file' },
      { omfiClass: 'MMedia', role: 'one per essence stream' },
      { omfiClass: 'MSource', role: 'media descriptor' }
    ],
    capabilities: OMF_CAPABILITIES
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const buffer = writeCompoundFile({
    children: [
      { name: HEADER_STREAM, data: Buffer.from(`${HEADER_TEXT}\n`, 'utf8') },
      { name: MANIFEST_STREAM, data: manifestBytes }
    ]
  })

  return {
    buffer,
    bytes: buffer.length,
    text: `OMF skeleton: ${(buffer.length / 1024).toFixed(1)} KB MS-CFB container with an ${HEADER_STREAM} stream ` +
      `and a ${MANIFEST_STREAM} stream (${entries.length} cue(s), ${durationSeconds}s). ` +
      'This is NOT an importable OMF: the OMFI v2 object model is not implemented, and Avid will refuse it. ' +
      'Use otio or xmeml for a timeline an editor opens today.',
    warnings: [
      'this file is an OMF skeleton, not an OMF document: Avid Pro Tools and Media Composer will refuse it (see docs/INTEROP.zh.md)',
      `the OMFI object model is not implemented; the manifest lists the 7 objects a real writer needs`
    ],
    events: entries.length,
    durationSeconds,
    importable: false,
    skeleton: true,
    capabilities: OMF_CAPABILITIES
  }
}

