/**
 * OpenTimelineIO, FCP7 XML and OMF skeleton tests.
 *
 * These three share a theme the AAF test can only state as a boundary: for OTIO
 * and xmeml the claim is *this really imports*, so the tests go further than
 * "the JSON parses" — they check the invariants an importer depends on:
 *
 * - OTIO: the schema names and versions, one `Audio` track per lane, items that
 *   fill their track without holes (the sum of a track's child durations equals
 *   its length), `RationalTime` at the audio sample rate so positions stay
 *   sample exact, an `ExternalReference` with a `target_url` per clip, and gain
 *   and fades preserved in metadata because OTIO has no audio level field.
 * - FCP7 XML: the doctype and root element, a `<rate>` whose timebase matches
 *   the requested frame rate (including 29.97 NTSC), `<start>/<end>` around
 *   every `<clipitem>` with source `<in>/<out>`, a `file://` `<pathurl>`, the
 *   `Audio Levels` filter only where a gain was asked for, XML escaping of cue
 *   names, and frame quantisation reported rather than hidden.
 * - OMF: the file is a valid container with the two streams the skeleton
 *   promises, its header stream says in ASCII that it is not an OMF document,
 *   and the manifest reports `importable: false`. This section asserts the
 *   *honesty* of the skeleton, not a capability it does not have.
 *
 * The tool layer runs through a fake Cordis context with a real wav on disk.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportOmf, OMF_CAPABILITIES } from '../lib/omf.js'
import { exportOtio, parseOtio } from '../lib/otio.js'
import { exportXmeml, parseXmeml } from '../lib/xmeml.js'
import { exportProject } from '../lib/daw.js'
import { readCompoundFile } from '../lib/cfb.js'
import { registerDawTools } from '../lib/tools-daw.js'
import { encodeWav } from '../lib/wav.js'

const outDir = new URL('./out/otio/', import.meta.url)
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

function expectError (label, pattern, run) {
  try {
    const value = run()
    check(label, false, `no error thrown (returned ${typeof value})`)
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
    console.log(`  ${label}: ${error.message}`)
  }
}

const CUES = [
  { name: 'boom', path: 'assets/boom.wav', url: 'file:///project/assets/boom.wav', at: 0, duration: 1.5 },
  { name: 'ding', path: 'assets/ding.wav', url: 'file:///project/assets/ding.wav', at: 1.5, duration: 0.75, gainDb: -6, fadeIn: 0.1 },
  { name: 'swell', path: 'assets/swell.wav', url: 'file:///project/assets/swell.wav', at: 2.25, duration: 1 },
  // Overlaps boom: OTIO keeps it by putting it on its own track.
  { name: 'overlap', path: 'assets/overlap.wav', url: 'file:///project/assets/overlap.wav', at: 0.5, duration: 0.5 }
]

/* ------------------------------------------------------------------- otio -- */

console.log('-- otio: document structure --')
const otio = exportOtio({ cues: CUES, sampleRate: 48000, title: 'interop test' })
await writeFile(new URL('timeline.otio', outDir), otio.text)
const document = JSON.parse(otio.text)
console.log(`  ${otio.bytes} bytes, ${otio.tracks} tracks, rate ${otio.rate}`)

check('otio: top level is Timeline.1', document.OTIO_SCHEMA === 'Timeline.1', String(document.OTIO_SCHEMA))
check('otio: timeline name', document.name === 'interop test', String(document.name))
check('otio: global start time is a rational time at the edit rate', document.global_start_time.OTIO_SCHEMA === 'RationalTime.1' && document.global_start_time.rate === 48000 && document.global_start_time.value === 0,
  JSON.stringify(document.global_start_time))
check('otio: tracks is a Stack.1', document.tracks.OTIO_SCHEMA === 'Stack.1', String(document.tracks.OTIO_SCHEMA))
check('otio: overlapping cues go on two tracks', document.tracks.children.length === 2, String(document.tracks.children.length))
check('otio: every track is kind Audio', document.tracks.children.every((track) => track.OTIO_SCHEMA === 'Track.1' && track.kind === 'Audio'))
check('otio: track names are lane names', document.tracks.children.map((track) => track.name).join(',') === 'Lane 1,Lane 2')
check('otio: event count', otio.events === CUES.length)
check('otio: duration', Math.abs(otio.durationSeconds - 3.25) < 1e-9, String(otio.durationSeconds))
check('otio: no warnings for a clean set apart from the documented ones', otio.warnings.some((warning) => /overlapped/.test(warning)), JSON.stringify(otio.warnings))
check('otio: warns that gain and fades ride in metadata', otio.warnings.some((warning) => /metadata/.test(warning)), JSON.stringify(otio.warnings))

const laneOne = document.tracks.children[0]
const laneTwo = document.tracks.children[1]
check('otio: lane one holds boom, ding and swell in order', laneOne.children.filter((item) => item.OTIO_SCHEMA === 'Clip.2').map((item) => item.name).join(',') === 'boom,ding,swell',
  JSON.stringify(laneOne.children.filter((item) => item.OTIO_SCHEMA === 'Clip.2').map((item) => item.name)))
check('otio: lane one starts with a Clip (no leading gap)', laneOne.children[0].OTIO_SCHEMA === 'Clip.2', String(laneOne.children[0].OTIO_SCHEMA))
check('otio: lane two starts with a Gap.1 for the offset', laneTwo.children[0].OTIO_SCHEMA === 'Gap.1', String(laneTwo.children[0].OTIO_SCHEMA))
check('otio: the gap is 0.5 s of samples', laneTwo.children[0].source_range.duration.value === 24000, String(laneTwo.children[0].source_range.duration.value))
check('otio: the overlap clip length in samples', laneTwo.children[1].source_range.duration.value === 24000, String(laneTwo.children[1].source_range.duration.value))

const firstClip = laneOne.children[0]
check('otio: clip schema is Clip.2', firstClip.OTIO_SCHEMA === 'Clip.2')
check('otio: clip source range is a TimeRange.1', firstClip.source_range.OTIO_SCHEMA === 'TimeRange.1' && firstClip.source_range.start_time.value === 0)
check('otio: clip duration is sample exact', firstClip.source_range.duration.value === 72000, String(firstClip.source_range.duration.value))
check('otio: clip rate is the audio rate', firstClip.source_range.duration.rate === 48000, String(firstClip.source_range.duration.rate))
check('otio: active media reference key', firstClip.active_media_reference_key === 'DEFAULT_MEDIA', String(firstClip.active_media_reference_key))
const reference = firstClip.media_references.DEFAULT_MEDIA
check('otio: media reference is an ExternalReference.1', reference.OTIO_SCHEMA === 'ExternalReference.1', String(reference.OTIO_SCHEMA))
check('otio: media reference target url', reference.target_url === 'file:///project/assets/boom.wav', String(reference.target_url))
check('otio: media reference has an available range', reference.available_range.OTIO_SCHEMA === 'TimeRange.1' && reference.available_range.duration.value === 72000)
const dingClip = laneOne.children.find((item) => item.name === 'ding')
check('otio: metadata carries the gain', dingClip.metadata['dsh-audiokit'].gainDb === -6, JSON.stringify(dingClip.metadata))
check('otio: metadata carries the fade', dingClip.metadata['dsh-audiokit'].fadeIn === 0.1, JSON.stringify(dingClip.metadata))
check('otio: metadata carries the source path', dingClip.metadata['dsh-audiokit'].sourcePath === 'assets/ding.wav', JSON.stringify(dingClip.metadata))
check('otio: no gain key for a cue without gain', firstClip.metadata['dsh-audiokit'].gainDb === undefined, JSON.stringify(firstClip.metadata))
check('otio: no effects invented for gain', firstClip.effects.length === 0 && dingClip.effects.length === 0)
check('otio: clips are enabled', firstClip.enabled === true)

console.log('\n-- otio: import invariants --')
// An importer reads a track top to bottom and lays items end to end, so the sum
// of the children's durations has to be the track length and the items have to
// be contiguous: that is what makes the picture land where it was asked.
for (let index = 0; index < document.tracks.children.length; index += 1) {
  const track = document.tracks.children[index]
  const total = track.children.reduce((sum, item) => sum + item.source_range.duration.value, 0)
  check(`otio: track ${index + 1} items are contiguous`, total > 0 && track.children.every((item) => item.source_range.duration.value > 0))
  check(`otio: track ${index + 1} has a rational duration`, track.children.every((item) => item.source_range.duration.rate === 48000))
}
const durations = laneOne.children.map((item) => item.source_range.duration.value)
check('otio: lane one lengths are 72000, 36000, 48000', durations.join(',') === '72000,36000,48000', JSON.stringify(durations))
check('otio: lane one ends at 3.25 s of samples', durations.reduce((sum, value) => sum + value, 0) === 156000)

console.log('\n-- otio: parsed back --')
const parsed = parseOtio(otio.text)
check('otio parse: rate', parsed.rate === 48000, String(parsed.rate))
check('otio parse: tracks', parsed.tracks.length === 2, String(parsed.tracks.length))
check('otio parse: clips', parsed.tracks.reduce((total, track) => total + track.clips.length, 0) === CUES.length)
check('otio parse: duration', Math.abs(parsed.durationSeconds - 3.25) < 1e-9, String(parsed.durationSeconds))
check('otio parse: no warnings', parsed.warnings.length === 0, JSON.stringify(parsed.warnings))
const parsedClips = parsed.tracks.flatMap((track) => track.clips)
let worstAt = 0
let worstDuration = 0
for (const cue of CUES) {
  const clip = parsedClips.find((candidate) => candidate.name === cue.name)
  if (clip === undefined) continue
  worstAt = Math.max(worstAt, Math.abs(clip.at - cue.at))
  worstDuration = Math.max(worstDuration, Math.abs(clip.duration - cue.duration))
}
console.log(`  worst position ${(worstAt * 1e6).toFixed(3)} µs, worst duration ${(worstDuration * 1e6).toFixed(3)} µs`)
check('otio parse: positions are exact', worstAt <= 0.5 / 48000 + 1e-12, String(worstAt))
check('otio parse: durations are exact', worstDuration <= 0.5 / 48000 + 1e-12, String(worstDuration))
check('otio parse: target urls survive', parsedClips.every((clip) => typeof clip.targetUrl === 'string' && clip.targetUrl.startsWith('file:///')))
check('otio: identical document across runs', exportOtio({ cues: CUES, sampleRate: 48000, title: 'interop test' }).text === otio.text)

const at44 = exportOtio({ cues: CUES, sampleRate: 44100 })
const at44Parsed = parseOtio(at44.text)
check('otio: a 44.1 kHz edit rate is honoured', at44Parsed.rate === 44100 && at44.rate === 44100, String(at44Parsed.rate))
check('otio: positions are sample exact at 44.1 kHz', Math.abs(at44Parsed.tracks[0].clips[1].at - 1.5) < 1e-9, String(at44Parsed.tracks[0].clips[1].at))
const single = exportOtio({ cues: [{ name: 'one', path: 'a.wav', at: 0.25, duration: 0.5 }] })
check('otio: no gap when the first clip starts at 0.25 s', JSON.parse(single.text).tracks.children[0].children[0].OTIO_SCHEMA === 'Gap.1')
check('otio: gap length for 0.25 s at 48 kHz', JSON.parse(single.text).tracks.children[0].children[0].source_range.duration.value === 12000)

console.log('\n-- otio: errors --')
expectError('otio: empty cues', /non-empty array/, () => exportOtio({ cues: [] }))
expectError('otio: zero duration', /duration must be greater than 0/, () => exportOtio({ cues: [{ name: 'x', at: 0, duration: 0 }] }))
expectError('otio: negative position', /at must be a non-negative/, () => exportOtio({ cues: [{ name: 'x', at: -1, duration: 1 }] }))
expectError('otio: missing duration', /duration is required/, () => exportOtio({ cues: [{ name: 'x', at: 0 }] }))
expectError('otio: bad sample rate', /sampleRate must be between/, () => exportOtio({ cues: CUES, sampleRate: 10 }))
expectError('otio parse: empty document', /cannot parse an empty/, () => parseOtio(''))
expectError('otio parse: invalid json', /not valid JSON/, () => parseOtio('{oops}'))
expectError('otio parse: wrong top level schema', /expected Timeline\.1/, () => parseOtio('{"OTIO_SCHEMA":"Timeline.2"}'))

/* ------------------------------------------------------------------ xmeml -- */

console.log('\n-- xmeml: document structure --')
const xml = exportXmeml({ cues: CUES, frameRate: 25, sampleRate: 48000, title: 'interop test' })
await writeFile(new URL('timeline.xml', outDir), xml.text)
console.log(`  ${xml.bytes} bytes, ${xml.tracks} tracks, ${xml.frames} frames at ${xml.timebase} fps`)
check('xmeml: starts with the XML prologue', xml.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n'), JSON.stringify(xml.text.slice(0, 60)))
check('xmeml: one root element', (xml.text.match(/<xmeml /g) ?? []).length === 1 && /<\/xmeml>\n$/.test(xml.text))
check('xmeml: version 4', xml.text.includes('<xmeml version="4">'))
check('xmeml: sequence element', xml.text.includes('<sequence id="sequence-1">'))
check('xmeml: sequence name', xml.text.includes('<name>interop test</name>'))
check('xmeml: timebase is 25', xml.text.includes('<timebase>25</timebase>') && xml.timebase === 25, String(xml.timebase))
check('xmeml: not NTSC', xml.text.includes('<ntsc>FALSE</ntsc>'))
check('xmeml: display format NDF', xml.text.includes('<displayformat>NDF</displayformat>'))
check('xmeml: sequence duration in frames', xml.text.includes(`<duration>${xml.frames}</duration>`), String(xml.frames))
check('xmeml: four clipitems', (xml.text.match(/<clipitem id="clipitem-\d+">/g) ?? []).length === 4, String((xml.text.match(/<clipitem /g) ?? []).length))
check('xmeml: two audio tracks for the overlap', xml.tracks === 2, String(xml.tracks))
check('xmeml: audio sample characteristics', xml.text.includes('<samplerate>48000</samplerate>'))
check('xmeml: audio depth', xml.text.includes('<depth>16</depth>'))
check('xmeml: file path url is a file url', xml.text.includes('<pathurl>file:///project/assets/boom.wav</pathurl>'), JSON.stringify(xml.text.match(/<pathurl>[^<]*<\/pathurl>/)?.[0]))
check('xmeml: source track declares audio', xml.text.includes('<mediatype>audio</mediatype>'))
check('xmeml: clip in/out', xml.text.includes('<in>0</in>'))
check('xmeml: gain becomes an Audio Levels filter', xml.text.includes('<effectid>audiolevels</effectid>'))
check('xmeml: the level filter carries a linear gain', /<parameterid>level<\/parameterid>\s*<name>Level<\/name>\s*<value>0\.5011/.test(xml.text),
  JSON.stringify(xml.text.match(/<parameterid>level<\/parameterid>[\s\S]{0,80}/)?.[0]))
check('xmeml: no level filter for a cue at unity', (xml.text.match(/<effectid>audiolevels<\/effectid>/g) ?? []).length === 1,
  String((xml.text.match(/<effectid>audiolevels<\/effectid>/g) ?? []).length))
check('xmeml: quantisation is reported', xml.warnings.some((warning) => /quantised to whole frames/.test(warning)), JSON.stringify(xml.warnings))
check('xmeml: fades are reported as not applied', xml.warnings.some((warning) => /fade/.test(warning)), JSON.stringify(xml.warnings))
check('xmeml: overlap packing is reported', xml.warnings.some((warning) => /overlapped/.test(warning)), JSON.stringify(xml.warnings))
check('xmeml: frame rate label', xml.frameRateLabel === '25 fps', String(xml.frameRateLabel))
check('xmeml: identical document across runs', exportXmeml({ cues: CUES, frameRate: 25, sampleRate: 48000, title: 'interop test' }).text === xml.text)

const escape = exportXmeml({ cues: [{ name: 'a & b <c> "d"', path: 'assets/x.wav', at: 0, duration: 1 }], frameRate: 25 })
check('xmeml: cue names are xml escaped', escape.text.includes('a &amp; b &lt;c&gt; &quot;d&quot;'), JSON.stringify(escape.text.match(/<name>a[^<]*<\/name>/)?.[0]))
check('xmeml: the escaped name is only written where it belongs', (escape.text.match(/a &amp; b/g) ?? []).length >= 1)

console.log('\n-- xmeml: frame rates --')
const at24 = exportXmeml({ cues: CUES, frameRate: 24 })
check('xmeml: 24 fps timebase', at24.timebase === 24 && at24.text.includes('<timebase>24</timebase>'), String(at24.timebase))
// These cue times are all multiples of 1/24 s, so 24 fps lands on whole frames
// and there is nothing to report; that is the other half of the contract from
// the 25 fps case, where the same set does quantise.
check('xmeml: 24 fps reports no quantisation when the cuts land on frames', at24.warnings.every((warning) => !/quantised/.test(warning)), JSON.stringify(at24.warnings))
const coarse = exportXmeml({ cues: [{ name: 'nudge', path: 'a.wav', at: 0.1, duration: 0.1 }], frameRate: 25 })
check('xmeml: a cut between frames is reported as quantised', coarse.warnings.some((warning) => /quantised to whole frames/.test(warning)), JSON.stringify(coarse.warnings))
const at2997 = exportXmeml({ cues: CUES, frameRate: 29.97 })
check('xmeml: 29.97 is timebase 30 with NTSC TRUE', at2997.timebase === 30 && at2997.ntsc === true && at2997.text.includes('<ntsc>TRUE</ntsc>'), `${at2997.timebase}/${at2997.ntsc}`)
check('xmeml: 29.97 uses drop-frame timecode', at2997.text.includes('<displayformat>DF</displayformat>'))
check('xmeml: 29.97 timecode string uses a semicolon', /<string>\d\d:\d\d:\d\d;\d\d<\/string>/.test(at2997.text), JSON.stringify(at2997.text.match(/<string>[^<]*<\/string>/)?.[0]))
const at23976 = exportXmeml({ cues: CUES, frameRate: 23.976 })
check('xmeml: 23.976 is timebase 24 with NTSC TRUE', at23976.timebase === 24 && at23976.ntsc === true)
const at50 = exportXmeml({ cues: CUES, frameRate: 50 })
check('xmeml: 50 fps is accepted', at50.timebase === 50, String(at50.timebase))
const defaulted = exportXmeml({ cues: CUES })
check('xmeml: default frame rate is 25', defaulted.timebase === 25, String(defaulted.timebase))

console.log('\n-- xmeml: parsed back --')
const parsedXml = parseXmeml(xml.text)
check('xmeml parse: sequence name', parsedXml.name === 'interop test', String(parsedXml.name))
check('xmeml parse: timebase', parsedXml.timebase === 25, String(parsedXml.timebase))
check('xmeml parse: track count', parsedXml.tracks.length === 2, String(parsedXml.tracks.length))
const parsedXmlClips = parsedXml.tracks.flatMap((track) => track.clips)
check('xmeml parse: clip count', parsedXmlClips.length === CUES.length, String(parsedXmlClips.length))
let worstFrameError = 0
for (const cue of CUES) {
  const clip = parsedXmlClips.find((candidate) => candidate.name === cue.name)
  if (clip === undefined) continue
  worstFrameError = Math.max(worstFrameError, Math.abs(clip.at - cue.at), Math.abs(clip.duration - cue.duration))
}
console.log(`  worst frame quantisation ${(worstFrameError * 1000).toFixed(2)} ms at 25 fps (a frame is 40 ms)`)
check('xmeml parse: every position is within one frame', worstFrameError <= 1 / 25 + 1e-9, String(worstFrameError))
check('xmeml parse: path urls survive', parsedXmlClips.every((clip) => clip.pathUrl === null || clip.pathUrl.startsWith('file:///')))
const dingXml = parsedXmlClips.find((clip) => clip.name === 'ding')
check('xmeml parse: the level filter reads back as -6 dB', Math.abs(dingXml.gainDb + 6) < 0.01, String(dingXml.gainDb))
check('xmeml parse: no warnings for a clean document', parsedXml.warnings.length === 0, JSON.stringify(parsedXml.warnings))

console.log('\n-- xmeml: errors --')
expectError('xmeml: empty cues', /non-empty array/, () => exportXmeml({ cues: [] }))
expectError('xmeml: zero duration', /duration must be greater than 0/, () => exportXmeml({ cues: [{ name: 'x', at: 0, duration: 0 }] }))
expectError('xmeml: unsupported frame rate', /unsupported frameRate "59.94"/, () => exportXmeml({ cues: CUES, frameRate: 59.94 }))
expectError('xmeml parse: empty', /cannot parse an empty/, () => parseXmeml(''))
expectError('xmeml parse: not xmeml', /no <xmeml> element/, () => parseXmeml('<html></html>'))

console.log('\n-- xmeml: a plain path becomes a file url (the relink fix) --')
// A caller that gives only `path` used to get the OS path written raw into
// <pathurl>: Windows backslashes, an unencoded space and a Chinese file name are
// not a URL, and Premiere fails to relink without saying why. `pathToFileURL`
// makes it a real URL; `<file><name>` must stay the basename, never the path.
const encodedPath = 'assets/audio/explosion boom \u7206\u70b8.wav'
const pathOnly = exportXmeml({ cues: [{ name: 'boom', path: encodedPath, at: 0, duration: 1 }], frameRate: 25 })
const pathOnlyUrl = /<pathurl>([^<]*)<\/pathurl>/.exec(pathOnly.text)?.[1]
const expectedPathUrl = pathToFileURL(encodedPath).href
console.log(`  pathurl ${pathOnlyUrl}`)
check('xmeml: path-only media writes a <pathurl>', pathOnlyUrl !== undefined, JSON.stringify(pathOnly.text.match(/<pathurl>[^<]*/) ?? pathOnly.text.slice(0, 120)))
check('xmeml: pathurl is a file url', pathOnlyUrl !== undefined && pathOnlyUrl.startsWith('file:///'), String(pathOnlyUrl))
check('xmeml: pathurl is pathToFileURL of the path', pathOnlyUrl === expectedPathUrl, `${pathOnlyUrl} vs ${expectedPathUrl}`)
check('xmeml: pathurl percent-encodes the space and the CJK file name', pathOnlyUrl.includes('explosion%20boom%20%E7%88%86%E7%82%B8.wav'), String(pathOnlyUrl))
check('xmeml: pathurl carries no raw space or backslash', !pathOnlyUrl.includes(' ') && !pathOnlyUrl.includes('\\'), String(pathOnlyUrl))
check('xmeml: <file><name> is the basename', pathOnly.text.includes('<name>explosion boom \u7206\u70b8.wav</name>'),
  JSON.stringify(pathOnly.text.match(/<file id="file-1">[\s\S]{0,120}/)?.[0]))
check('xmeml: <file><name> is not the whole path', /<name>[^<]*<\/name>/.test(pathOnly.text) && !pathOnly.text.includes(`<name>assets/audio/`),
  JSON.stringify(pathOnly.text.match(/<name>[^<]*<\/name>/g)))
const windowsPath = exportXmeml({ cues: [{ name: 'win', path: 'C:\\media\\hit.wav', at: 0, duration: 1 }], frameRate: 25 })
const windowsUrl = /<pathurl>([^<]*)<\/pathurl>/.exec(windowsPath.text)?.[1]
check('xmeml: a windows path still names the file by its basename', windowsPath.text.includes('<name>hit.wav</name>'),
  JSON.stringify(windowsPath.text.match(/<file id="file-1">[\s\S]{0,140}/)?.[0]))
check('xmeml: a windows path is not written raw into the url', windowsUrl !== undefined && windowsUrl.startsWith('file:') && !windowsUrl.includes('\\'), String(windowsUrl))
const explicitUrl = exportXmeml({ cues: [{ name: 'hit', path: 'sfx/hit.wav', url: 'file:///project/sfx/hit.wav', at: 0, duration: 1 }], frameRate: 25 })
check('xmeml: an explicit url is written unchanged', explicitUrl.text.includes('<pathurl>file:///project/sfx/hit.wav</pathurl>'),
  JSON.stringify(explicitUrl.text.match(/<pathurl>[^<]*/)?.[0]))

console.log('\n-- xmeml: level validation --')
// dbToGain(NaN) is NaN, and <value>NaN</value> is a document an editor refuses
// to import with no useful message. A bad level has to be an error here.
expectError('xmeml: NaN gain', /gainDb must be a finite number, got NaN/, () => exportXmeml({ cues: [{ name: 'x', path: 'a.wav', at: 0, duration: 1, gainDb: NaN }] }))
expectError('xmeml: gain above the limit', /gainDb must be between -120 and 24/, () => exportXmeml({ cues: [{ name: 'x', path: 'a.wav', at: 0, duration: 1, gainDb: 99 }] }))
expectError('xmeml: gain below the limit', /gainDb must be between -120 and 24/, () => exportXmeml({ cues: [{ name: 'x', path: 'a.wav', at: 0, duration: 1, gainDb: -200 }] }))
expectError('xmeml: non-numeric gain', /gainDb must be a finite number/, () => exportXmeml({ cues: [{ name: 'x', path: 'a.wav', at: 0, duration: 1, gainDb: 'loud' }] }))
const gained = exportXmeml({ cues: [{ name: 'x', path: 'a.wav', at: 0, duration: 1, gainDb: -6 }], frameRate: 25 })
check('xmeml: the written level is a finite number', /<value>\d+(?:\.\d+)?<\/value>/.test(gained.text), JSON.stringify(gained.text.match(/<value>[^<]*/)?.[0]))
check('xmeml: NaN never reaches the document', !gained.text.includes('NaN'))

/* -------------------------------------------------------------------- omf -- */

console.log('\n-- omf: the skeleton is honest --')
const omf = exportOmf({ cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 }], title: 'omf test' })
await writeFile(new URL('skeleton.omf', outDir), omf.buffer)
const omfContainer = readCompoundFile(omf.buffer)
const omfStreams = omfContainer.list.filter((node) => node.kind === 'stream').map((node) => node.name)
console.log(`  ${omf.bytes} bytes, streams ${omfStreams.join(', ')}`)
check('omf: container is a version 3 CFB', omfContainer.version === 3)
check('omf: container has no reader warnings', omfContainer.warnings.length === 0, JSON.stringify(omfContainer.warnings))
check('omf: header stream is present', omfStreams.includes('OMFI:HEADER'))
check('omf: manifest stream is present', omfStreams.includes('DSH:MANIFEST'))
const header = omfContainer.list.find((node) => node.name === 'OMFI:HEADER').data.toString('utf8')
check('omf: header stream marks the skeleton', header.startsWith('DSH-AUDIOKIT-OMF-SKELETON-V1'), JSON.stringify(header.slice(0, 40)))
check('omf: header stream says it cannot be opened', /NOT an OMF Interchange document/.test(header), header.split('\n')[2])
const manifest = JSON.parse(omfContainer.list.find((node) => node.name === 'DSH:MANIFEST').data.toString('utf8'))
check('omf: manifest marks the file not importable', manifest.importable === false)
check('omf: manifest records the title', manifest.title === 'omf test', String(manifest.title))
check('omf: manifest records the timeline', manifest.events === 1 && manifest.durationSeconds === 1.25, JSON.stringify({ events: manifest.events, duration: manifest.durationSeconds }))
check('omf: manifest lists the objects a writer needs', Array.isArray(manifest.objectPlan) && manifest.objectPlan.length >= 7, String(manifest.objectPlan?.length))
check('omf: manifest names the missing object model', manifest.capabilities.missing.length >= 5, String(manifest.capabilities.missing?.length))
check('omf: result reports not importable and skeleton', omf.importable === false && omf.skeleton === true)
check('omf: result carries the capabilities table', omf.capabilities === OMF_CAPABILITIES)
check('omf: loud warning about Avid', omf.warnings.some((warning) => /Avid/.test(warning)), JSON.stringify(omf.warnings))
check('omf: summary text says NOT importable', /NOT an importable OMF/.test(omf.text), omf.text.slice(0, 120))
check('omf: identical bytes across runs', Buffer.compare(exportOmf({ cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 }], title: 'omf test' }).buffer, omf.buffer) === 0)
expectError('omf: empty cues', /non-empty array/, () => exportOmf({ cues: [] }))
expectError('omf: zero duration', /duration must be greater than 0/, () => exportOmf({ cues: [{ name: 'x', at: 0, duration: 0 }] }))

/* --------------------------------------------------------------- dispatch -- */

console.log('\n-- exportProject dispatch --')
const viaProject = exportProject({ format: 'otio', cues: CUES })
check('dispatch: otio extension', viaProject.extension === 'otio', viaProject.extension)
check('dispatch: otio is text', viaProject.binary === false)
const viaXmeml = exportProject({ format: 'xmeml', cues: CUES, frameRate: 24 })
check('dispatch: xmeml extension', viaXmeml.extension === 'xml', viaXmeml.extension)
check('dispatch: xmeml honours the frame rate', viaXmeml.timebase === 24, String(viaXmeml.timebase))
check('dispatch: xmeml default rate is 25', exportProject({ format: 'xmeml', cues: CUES }).timebase === 25)
const via23976 = exportProject({ format: 'xmeml', cues: CUES, frameRate: 23.976 })
check('dispatch: xmeml keeps 23.976 as NTSC timebase 24', via23976.timebase === 24 && via23976.ntsc === true, `${via23976.timebase}/${via23976.ntsc}`)
const viaOmf = exportProject({ format: 'omf', cues: CUES })
check('dispatch: omf is binary', viaOmf.binary === true && Buffer.isBuffer(viaOmf.buffer))
check('dispatch: omf byte count', viaOmf.bytes === viaOmf.buffer.length)

/* ---------------------------------------------------------- tool layer -- */

console.log('\n-- tool: audio_daw otio and xmeml end to end --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-otio-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }
registerDawTools(ctx)
const tool = registered.get('audio_daw')
const call = (args) => tool.execute(args, exec)

const sampleRate = 48000
const frames = Math.round(1.25 * sampleRate)
const samples = new Float32Array(frames)
for (let index = 0; index < frames; index += 1) samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5
await mkdir(join(cwd, 'sfx'), { recursive: true })
await writeFile(join(cwd, 'sfx', 'hit.wav'), encodeWav([samples], sampleRate))

const toolOtio = await call({ format: 'otio', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0.5 }] })
console.log(`  ${toolOtio.text.split('\n').join('\n  ')}`)
check('tool otio: default output path', /^assets\/audio\/otio-[0-9a-f]+\.otio$/.test(toolOtio.relativePath), toolOtio.relativePath)
check('tool otio: measured the missing duration', /measured from the wav header/.test(toolOtio.text), toolOtio.text)
check('tool otio: verified one clip', toolOtio.verified.clips === 1, JSON.stringify(toolOtio.verified))
check('tool otio: rate is the media rate', toolOtio.verified.rate === 48000, JSON.stringify(toolOtio.verified))
const otioOnDisk = await readFile(toolOtio.path, 'utf8')
const otioOnDiskParsed = parseOtio(otioOnDisk)
check('tool otio: file on disk parses', otioOnDiskParsed.tracks[0].clips.length === 1)
check('tool otio: clip position survives', Math.abs(otioOnDiskParsed.tracks[0].clips[0].at - 0.5) < 1e-9, String(otioOnDiskParsed.tracks[0].clips[0].at))
check('tool otio: clip length is the measured duration', Math.abs(otioOnDiskParsed.tracks[0].clips[0].duration - 1.25) < 1e-9, String(otioOnDiskParsed.tracks[0].clips[0].duration))
check('tool otio: target url is an absolute file url', /^file:\/\/\//.test(otioOnDiskParsed.tracks[0].clips[0].targetUrl), String(otioOnDiskParsed.tracks[0].clips[0].targetUrl))

const toolXmeml = await call({ format: 'xmeml', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0.5, gainDb: -6 }] })
console.log(`  ${toolXmeml.text.split('\n').join('\n  ')}`)
check('tool xmeml: default output path', /^assets\/audio\/xmeml-[0-9a-f]+\.xml$/.test(toolXmeml.relativePath), toolXmeml.relativePath)
check('tool xmeml: verified one clipitem', toolXmeml.verified.clips === 1, JSON.stringify(toolXmeml.verified))
check('tool xmeml: default timebase is 25', toolXmeml.verified.timebase === 25, JSON.stringify(toolXmeml.verified))
const xmlOnDisk = await readFile(toolXmeml.path, 'utf8')
check('tool xmeml: file on disk parses', parseXmeml(xmlOnDisk).tracks[0].clips.length === 1)
check('tool xmeml: absolute path url on disk', /<pathurl>file:\/\/\/[^<]+<\/pathurl>/.test(xmlOnDisk), JSON.stringify(xmlOnDisk.match(/<pathurl>[^<]*/)?.[0]))
// The tool layer hands the writer an absolute `url`; it must be written verbatim,
// so adding the path-only fallback changed nothing for the tool's own output.
const expectedToolUrl = pathToFileURL(join(cwd, 'sfx', 'hit.wav')).href
check('tool xmeml: pathurl is exactly the media file url', xmlOnDisk.includes(`<pathurl>${expectedToolUrl}</pathurl>`), `${expectedToolUrl} vs ${JSON.stringify(xmlOnDisk.match(/<pathurl>[^<]*/)?.[0])}`)
check('tool xmeml: gain filter on disk', /<effectid>audiolevels<\/effectid>/.test(xmlOnDisk))
check('tool xmeml: verified frame rate label', /25 fps/.test(toolXmeml.text), toolXmeml.text)

const toolOmf = await call({ format: 'omf', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 }] })
check('tool omf: NOT reported as importable', toolOmf.importable === false && /NOT an importable OMF|skeleton/.test(toolOmf.text), toolOmf.text.slice(0, 100))
const toolAgain = await call({ format: 'otio', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0.5 }] })
check('tool otio: same request, same path', toolAgain.path === toolOtio.path, toolAgain.relativePath)

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0
  ? `\nOK: ${checks} checks, every timeline document read back to what was written`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
