/**
 * AAF and MS-CFB tests: the container bytes, the object graph, and an honest
 * boundary.
 *
 * There is no Pro Tools on this machine and no AAF SDK, so "it opens" cannot be
 * asserted here and is not claimed anywhere. What *is* asserted is everything
 * that can be proven from the bytes:
 *
 * 1. the container is a valid version 3 compound file — signature, header
 *    fields, FAT coverage, mini stream, directory tree ordering, and the exact
 *    stream bytes read back through own parser;
 * 2. the AAF object graph is internally consistent — every object's `properties`
 *    stream decodes, every strong reference names a child storage that exists,
 *    every vector's index stream matches the children it names, and every class
 *    id is one of the registered AAF class ids the writer claims to emit;
 * 3. the timeline says what the cue set said — lane packing, clip positions and
 *    lengths in samples, embedded PCM byte-for-byte, descriptor fields;
 * 4. the export is deterministic — the same request is the same buffer;
 * 5. the boundary is explicit — the result reports `importable: false` and says
 *    the MetaDictionary layer is absent, because an AAF SDK based application
 *    (Pro Tools, Media Composer, Resolve) resolves that dictionary before it
 *    ever looks at the timeline.
 *
 * The tool layer is exercised through a fake Cordis context and a real wav on
 * disk, which proves the PCM embedding and the self-check that runs after every
 * write. The last section checks that the self-check actually rejects a file it
 * should reject, so the "verified" field means something.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AAF_AUIDS,
  AAF_CLASS_IDS,
  auidToText,
  decodePropertyStream,
  exportAaf,
  parseAaf,
  validateAafGraph
} from '../lib/aaf.js'
import {
  clsidToString,
  compareDirectoryNames,
  findStream,
  listStreams,
  readCompoundFile,
  writeCompoundFile
} from '../lib/cfb.js'
import { exportProject } from '../lib/daw.js'
import { packLanes } from '../lib/timeline.js'
import { registerDawTools } from '../lib/tools-daw.js'
import { encodeWav } from '../lib/wav.js'

const outDir = new URL('./out/aaf/', import.meta.url)
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

/** CFB directory entry values, named here so the tree checks read as the format. */
const CFB_NO_ENTRY = 0xffffffff
const CFB_COLOR_RED = 0
const CFB_COLOR_BLACK = 1

/** The root directory entry of a parsed container. */
function rootDirectoryEntry (container) {
  return container.directory.find((entry) => entry.kind === 'root')
}

/**
 * Measure one storage's sibling tree from the raw directory entries.
 *
 * `readCompoundFile` flattens the sibling tree into `children` for callers that
 * only need the names; this walks the raw `left` / `right` / `child` / `color`
 * links instead, which is the only way to prove the tree is a red-black tree and
 * not just a correctly ordered list. A NIL leaf counts as one black level, so
 * equal black heights is the standard invariant.
 *
 * @param {object} container - result of `readCompoundFile`.
 * @param {object} storageEntry - a raw directory entry with a `child` pointer.
 * @returns {{nodes: number, depth: number, blackHeight: number, unbalanced: number,
 *   redRed: number, rootBlack: boolean, cyclic: boolean, names: string[]}}
 */
function directoryTreeShape (container, storageEntry) {
  const byId = new Map(container.directory.map((entry) => [entry.id, entry]))
  const shape = { nodes: 0, depth: 0, blackHeight: 0, unbalanced: 0, redRed: 0, rootBlack: true, cyclic: false, names: [] }
  if (storageEntry === undefined) return shape
  if (storageEntry.child !== CFB_NO_ENTRY && byId.get(storageEntry.child)?.color !== CFB_COLOR_BLACK) {
    shape.rootBlack = false
  }
  const seen = new Set()
  const walk = (id, depth) => {
    if (id === CFB_NO_ENTRY) return 1
    if (seen.has(id)) {
      shape.cyclic = true
      return 1
    }
    seen.add(id)
    const node = byId.get(id)
    if (node === undefined) throw new Error(`directory points at entry ${id}, which does not exist`)
    shape.nodes += 1
    shape.depth = Math.max(shape.depth, depth)
    const left = walk(node.left, depth + 1)
    const right = walk(node.right, depth + 1)
    if (left !== right) shape.unbalanced += 1
    if (node.color === CFB_COLOR_RED) {
      if (byId.get(node.left)?.color === CFB_COLOR_RED) shape.redRed += 1
      if (byId.get(node.right)?.color === CFB_COLOR_RED) shape.redRed += 1
    }
    return (node.color === CFB_COLOR_BLACK ? 1 : 0) + left
  }
  shape.blackHeight = walk(storageEntry.child, 1)
  const inOrder = (id) => {
    if (id === CFB_NO_ENTRY) return
    const node = byId.get(id)
    inOrder(node.left)
    shape.names.push(node.name)
    inOrder(node.right)
  }
  inOrder(storageEntry.child)
  return shape
}

/** Every SourceClip inside a parsed AAF segment, outermost first. */
function sourceClipsIn (segment, found = []) {
  if (segment === null || segment === undefined) return found
  if (segment.kind === 'sourceClip') found.push(segment)
  if (Array.isArray(segment.components)) {
    for (const component of segment.components) sourceClipsIn(component, found)
  }
  return found
}

/* ------------------------------------------------------------------- input -- */

/** Deterministic 16-bit mono PCM: a sine at `frequency`, `seconds` long. */
function pcm (seconds, sampleRate, frequency, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2)
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * index) / sampleRate)), index * 2)
  }
  return { data, sampleRate, channels: 1, bitDepth: 16, frames }
}

const CUES = [
  { name: 'boom', at: 0, duration: 1.5, pcm: pcm(1.5, 48000, 220) },
  { name: 'ding', at: 1.5, duration: 0.75, gainDb: -6, fadeIn: 0.05, fadeOut: 0.1, pcm: pcm(0.75, 48000, 880) },
  { name: 'swell', at: 2.25, duration: 1, pcm: pcm(1, 48000, 440) },
  // Overlaps boom: forces lane packing, which is the thing that makes the AAF
  // timeline expressible at all (one track cannot hold two clips at once).
  { name: 'overlap', at: 0.5, duration: 0.5, pcm: pcm(0.5, 48000, 990) }
]

/* ------------------------------------------------------- cfb: round trip --- */

console.log('-- cfb: container round trip --')
const tree = {
  clsid: 'b3b398a5-1c90-11d4-8053-080036210804',
  children: [
    { name: 'properties', data: Buffer.from('root properties payload') },
    { name: 'referenced properties', data: Buffer.from('a'.repeat(27)) },
    {
      name: 'Header-2',
      clsid: '0d010101-0101-2f00-060e-2b3402060101',
      children: [
        { name: 'properties', data: Buffer.alloc(186, 0x07) },
        { name: 'big.bin', data: Buffer.alloc(9000, 0x03) }
      ]
    },
    { name: 'MetaDictionary-1', children: [{ name: 'properties', data: Buffer.alloc(40, 0x01) }] },
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'aaa', data: Buffer.from('short') },
    { name: 'zzz-longer-name', data: Buffer.from('short2') }
  ]
}
const cfb = writeCompoundFile(tree)
const cfbBack = readCompoundFile(cfb)
console.log(`  ${cfb.length} bytes, ${cfbBack.sectors} sectors, ${cfbBack.list.filter((node) => node.kind === 'storage').length} storages`)

check('cfb: signature is D0 CF 11 E0 A1 B1 1A E1', cfb.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1', cfb.subarray(0, 8).toString('hex'))
check('cfb: major version 3', cfb.readUInt16LE(0x1a) === 3, String(cfb.readUInt16LE(0x1a)))
check('cfb: 512 byte sectors', cfb.readUInt16LE(0x1e) === 9, String(cfb.readUInt16LE(0x1e)))
check('cfb: 64 byte mini sectors', cfb.readUInt16LE(0x20) === 6, String(cfb.readUInt16LE(0x20)))
check('cfb: little endian marker', cfb.readUInt16LE(0x1c) === 0xfffe, String(cfb.readUInt16LE(0x1c)))
check('cfb: mini stream cutoff is 4096', cfb.readUInt32LE(0x38) === 4096, String(cfb.readUInt32LE(0x38)))
check('cfb: parsed version', cfbBack.version === 3, String(cfbBack.version))
check('cfb: parsed sector size', cfbBack.sectorSize === 512, String(cfbBack.sectorSize))
check('cfb: root clsid', cfbBack.clsid === 'b3b398a5-1c90-11d4-8053-080036210804', cfbBack.clsid)
check('cfb: no reader warnings', cfbBack.warnings.length === 0, JSON.stringify(cfbBack.warnings))
check('cfb: storage clsid read back', cfbBack.children.find((node) => node.name === 'Header-2').clsid === '0d010101-0101-2f00-060e-2b3402060101')
check('cfb: root stream bytes', findStream(cfbBack, '/properties').toString() === 'root properties payload')
check('cfb: nested storage stream bytes', findStream(cfbBack, '/Header-2/properties').length === 186)
check('cfb: regular (non-mini) stream bytes', findStream(cfbBack, '/Header-2/big.bin').length === 9000 && findStream(cfbBack, '/Header-2/big.bin')[9000 - 1] === 3)
check('cfb: empty stream reads back empty', findStream(cfbBack, '/empty').length === 0)
check('cfb: path lookup by name', findStream(cfbBack, '/MetaDictionary-1/properties').length === 40)
check('cfb: stream list', listStreams(cfbBack).includes('/Header-2/big.bin'), JSON.stringify(listStreams(cfbBack)))
const cfb2 = writeCompoundFile(tree)
check('cfb: identical bytes across runs', Buffer.compare(cfb, cfb2) === 0)
check('cfb: directory order is shorter-name-first', compareDirectoryNames('aaa', 'zzz-longer-name') < 0)
check('cfb: directory order is case insensitive', compareDirectoryNames('ABC', 'abd') < 0)
check('cfb: clsid text round trip', clsidToString(Buffer.from([0xa5, 0x98, 0xb3, 0xb3, 0x90, 0x1c, 0xd4, 0x11, 0x80, 0x53, 0x08, 0x00, 0x36, 0x21, 0x08, 0x04])) === 'b3b398a5-1c90-11d4-8053-080036210804')
await writeFile(new URL('container.cfb', outDir), cfb)

console.log('\n-- cfb: the directory is a red-black tree, not a chain --')
// Siblings are inserted in sorted order, the worst case for a binary search
// tree. A tree that is only "ordered" (but not rebalanced) degrades to a chain
// of depth n: correct bytes that every reader then searches linearly. These
// checks are the invariants, not the ordering, which the round-trip section
// already covers.
for (const count of [1, 2, 3, 7, 15]) {
  const names = Array.from({ length: count }, (_item, index) => `s${String(index).padStart(2, '0')}`)
  const buffer = writeCompoundFile({ children: names.map((name) => ({ name, data: Buffer.from(name) })) })
  const back = readCompoundFile(buffer)
  const shape = directoryTreeShape(back, rootDirectoryEntry(back))
  const bound = 2 * Math.log2(count) + 2
  console.log(`  ${count} siblings: nodes ${shape.nodes}, depth ${shape.depth} (bound ${bound.toFixed(2)}), black height ${shape.blackHeight}`)
  check(`cfb tree: ${count} sibling(s) read back`,
    shape.nodes === count && !shape.cyclic && names.every((name) => findStream(back, `/${name}`)?.toString() === name),
    `${shape.nodes} node(s), cyclic ${shape.cyclic}`)
  check(`cfb tree: ${count} sibling(s) keep depth <= 2*log2(n)+2`, shape.depth <= bound, `${shape.depth} > ${bound.toFixed(2)}`)
  check(`cfb tree: ${count} sibling(s) have equal black height`, shape.unbalanced === 0, `${shape.unbalanced} node(s) unbalanced`)
  check(`cfb tree: ${count} sibling(s) have no red-red edge`, shape.redRed === 0, `${shape.redRed} red-red edge(s)`)
  check(`cfb tree: ${count} sibling(s) keep a black root`, shape.rootBlack)
  check(`cfb tree: ${count} sibling(s) stay in CFB order`,
    shape.names.length === count && shape.names.every((name, index) => index === 0 || compareDirectoryNames(shape.names[index - 1], name) < 0),
    JSON.stringify(shape.names))
}

console.log('\n-- cfb: errors are reported, not misparsed --')
expectError('cfb: duplicate child names', /two children named/, () => writeCompoundFile({ children: [{ name: 'x', data: Buffer.from('a') }, { name: 'X', data: Buffer.from('b') }] }))
expectError('cfb: stream that is also a storage', /both a stream and a storage/, () => writeCompoundFile({ children: [{ name: 'x', data: Buffer.from('a'), children: [{ name: 'y', data: Buffer.from('b') }] }] }))
expectError('cfb: node that is neither', /neither a stream/, () => writeCompoundFile({ children: [{ name: 'x' }] }))
expectError('cfb: empty name', /no name/, () => writeCompoundFile({ children: [{ name: '', data: Buffer.from('a') }] }))
expectError('cfb: bad clsid text', /must be a GUID/, () => writeCompoundFile({ clsid: 'not-a-guid', children: [] }))
expectError('cfb: not a compound file', /does not match/, () => readCompoundFile(Buffer.alloc(1024, 0x41)))
expectError('cfb: truncated file', /at least 512 bytes/, () => readCompoundFile(Buffer.alloc(100)))
const truncated = Buffer.from(cfb.subarray(0, Math.floor(cfb.length / 2)))
expectError('cfb: half a file is refused', /past the end of the file|ends first|does not/, () => readCompoundFile(truncated))

/* -------------------------------------------------------- aaf: structure -- */

console.log('\n-- aaf: object graph --')
const first = exportAaf({ cues: CUES })
const second = exportAaf({ cues: CUES })
await writeFile(new URL('cues.aaf', outDir), first.buffer)
console.log(`  ${first.bytes} bytes, ${first.events} clips, ${first.lanes} lanes, ${first.embeddedBytes} bytes PCM`)
check('aaf: buffer is returned (not text)', Buffer.isBuffer(first.buffer))
check('aaf: byte count matches the buffer', first.bytes === first.buffer.length, `${first.bytes} vs ${first.buffer.length}`)
check('aaf: deterministic across runs', Buffer.compare(first.buffer, second.buffer) === 0)
check('aaf: one event per cue', first.events === CUES.length, String(first.events))
check('aaf: overlapping cues are packed into two lanes', first.lanes === 2, String(first.lanes))
check('aaf: project edit rate follows the media', first.sampleRate === 48000, String(first.sampleRate))
check('aaf: embedded PCM byte total', first.embeddedBytes === CUES.reduce((total, cue) => total + cue.pcm.data.length, 0), String(first.embeddedBytes))
check('aaf: reports itself as not importable', first.importable === false)
check('aaf: structure says the MetaDictionary is absent', first.structure.metaDictionary === 'absent', JSON.stringify(first.structure))
check('aaf: summary text names the boundary', /MetaDictionary/.test(first.text) && /refuse/.test(first.text), first.text)

const aaf = parseAaf(first.buffer)
console.log(`  container v${aaf.container.version}, ${aaf.container.storages} storages, ${aaf.container.streams} streams`)
check('aaf: container is version 3 CFB', aaf.container.version === 3 && aaf.container.sectorSize === 512)
check('aaf: container has no reader warnings', aaf.container.warnings.length === 0, JSON.stringify(aaf.container.warnings))
check('aaf: root storage class', aaf.rootClassId === AAF_CLASS_IDS.Root, aaf.rootClassId)
check('aaf: header byte order marker', aaf.header.byteOrder === 0x4949, String(aaf.header.byteOrder))
check('aaf: header object model version', aaf.header.objectModelVersion === 1, String(aaf.header.objectModelVersion))
check('aaf: header version 1.2', aaf.header.version.major === 1 && aaf.header.version.minor === 2, JSON.stringify(aaf.header.version))
check('aaf: operational pattern is AAF OP1a', aaf.header.operationalPattern === AAF_AUIDS.OperationalPattern1a, String(aaf.header.operationalPattern))
check('aaf: identification product name', aaf.header.identification[0].productName === 'dsh-audiokit', String(aaf.header.identification[0].productName))
check('aaf: dictionary data definitions', aaf.dictionary.dataDefinitions.map((def) => def.name).join(',') === 'DataDef_Sound,DataDef_Data,DataDef_Timecode',
  JSON.stringify(aaf.dictionary.dataDefinitions.map((def) => def.name)))
check('aaf: dictionary container definitions', aaf.dictionary.containerDefinitions.map((def) => def.name).join(',') === 'ContainerDef_AAF,ContainerDef_RIFFWAVE',
  JSON.stringify(aaf.dictionary.containerDefinitions.map((def) => def.name)))
check('aaf: every data definition carries its AUID', aaf.dictionary.dataDefinitions.every((def) => /^[0-9a-f]{8}-/.test(def.id)))

const composition = aaf.content.mobs.find((mob) => mob.name === 'dsh-audiokit timeline')
const masters = aaf.content.mobs.filter((mob) => mob.name !== 'dsh-audiokit timeline' && !mob.name.endsWith('.PHYS'))
const sources = aaf.content.mobs.filter((mob) => mob.name.endsWith('.PHYS'))
check('aaf: one composition mob', aaf.content.mobs.filter((mob) => mob.name === 'dsh-audiokit timeline').length === 1)
check('aaf: one master mob per cue', masters.length === CUES.length, String(masters.length))
check('aaf: one source mob per cue', sources.length === CUES.length, String(sources.length))
check('aaf: composition mob is top level', composition.usageCode === AAF_AUIDS.UsageTopLevel, String(composition.usageCode))
check('aaf: source mobs carry a PCM descriptor', sources.every((mob) => mob.descriptor !== null))
check('aaf: descriptor quantization is 16 bit', sources.every((mob) => mob.descriptor.quantizationBits === 16))
check('aaf: descriptor channel count', sources.every((mob) => mob.descriptor.channels === 1))
check('aaf: descriptor sample rate', sources.every((mob) => mob.descriptor.sampleRate === 48000))
check('aaf: descriptor block align', sources.every((mob) => mob.descriptor.blockAlign === 2))
check('aaf: descriptor average bytes per second', sources.every((mob) => mob.descriptor.averageBps === 96000))
check('aaf: descriptor frame length matches the PCM', sources.map((mob) => mob.descriptor.length).join(',') === CUES.map((cue) => cue.pcm.frames).join(','),
  JSON.stringify(sources.map((mob) => mob.descriptor.length)))

// Embedded samples have to be the samples that were handed in, byte for byte:
// that is the difference between a real essence embed and a placeholder. The
// essence belongs to the SourceMob — the mob that carries the PCMDescriptor — so
// each blob is keyed by the source mob its MobID names, not by the master mob
// the timeline references.
const mobsById = new Map(aaf.content.mobs.map((mob) => [mob.mobId, mob]))
const essenceByName = new Map()
let essenceOwnedBySource = 0
for (const item of aaf.content.essenceData) {
  const owner = mobsById.get(item.mobId)
  if (owner === undefined) continue
  if (owner.classId === AAF_CLASS_IDS.SourceMob && owner.descriptor !== null) essenceOwnedBySource += 1
  essenceByName.set(owner.name.replace(/\.PHYS$/, ''), item)
}
check('aaf: one essence blob per cue', aaf.content.essenceData.length === CUES.length, String(aaf.content.essenceData.length))
check('aaf: every essence blob is owned by a descriptor-bearing source mob', essenceOwnedBySource === CUES.length, `${essenceOwnedBySource} of ${CUES.length}`)
let pcmMatches = 0
for (const cue of CUES) {
  const blob = essenceByName.get(cue.name)
  if (blob !== undefined && Buffer.compare(blob.data, cue.pcm.data) === 0) pcmMatches += 1
}
check('aaf: embedded PCM is byte-identical to the input', pcmMatches === CUES.length, `${pcmMatches} of ${CUES.length}`)
check('aaf: essence stream is named Data-2702', aaf.content.essenceData.every((item) => item.dataStream === 'Data-2702'))
check('aaf: essence sizes', aaf.content.essenceData.map((item) => item.bytes).join(',') === CUES.map((cue) => cue.pcm.data.length).join(','))

/* ------------------------------------------ aaf: the ownership chain closes -- */

console.log('\n-- aaf: the essence ownership chain closes --')
// The chain the importer resolves: composition slot → MasterMob → slot → SourceMob
// → its own slot (full media length) and → PCMDescriptor; EssenceData.MobID → the
// same SourceMob. Both ends of the file meet on the mob that owns the descriptor,
// and no reference is the all-zero "no mob" UMID.
const NULL_UMID = '0'.repeat(64)
const clipsOf = (mob) => mob.slots.flatMap((slot) => sourceClipsIn(slot.segment))
const sourceSlotClips = sources.flatMap((mob) => clipsOf(mob).map((clip) => ({ mob, clip })))
const masterSlotClips = masters.flatMap((mob) => clipsOf(mob).map((clip) => ({ mob, clip })))
const timelineClips = aaf.timeline.tracks.flatMap((track) => track.clips)
const everyClip = aaf.content.mobs.flatMap((mob) => clipsOf(mob))
const references = {
  sourceSlot: sourceSlotClips.length,
  masterSlot: masterSlotClips.length,
  timeline: timelineClips.length,
  essence: aaf.content.essenceData.length
}
console.log(`  ${references.sourceSlot} source-slot, ${references.masterSlot} master-slot, ${references.timeline} timeline and ${references.essence} essence references resolved`)

check('aaf chain: a source mob slot clip spans the whole media',
  sourceSlotClips.length === sources.length && sourceSlotClips.every(({ mob, clip }) => clip.length === mob.descriptor.length),
  JSON.stringify(sourceSlotClips.map(({ mob, clip }) => `${clip.length}/${mob.descriptor.length}`)))
check('aaf chain: a source mob slot clip names the source mob itself',
  sourceSlotClips.every(({ mob, clip }) => clip.sourceMobId === mob.mobId))
check('aaf chain: a source mob keeps its descriptor on the same mob as the clip',
  sources.every((mob) => mob.descriptor !== null && clipsOf(mob).length > 0))
check('aaf chain: every master mob references a descriptor-bearing source mob',
  masterSlotClips.length === masters.length && masterSlotClips.every(({ clip }) => {
    const owner = mobsById.get(clip.sourceMobId)
    return owner !== undefined && owner.classId === AAF_CLASS_IDS.SourceMob && owner.descriptor !== null
  }),
  `${masterSlotClips.length} master clip(s) for ${masters.length} master mob(s)`)
const essenceMobIds = new Set(aaf.content.essenceData.map((item) => item.mobId))
check('aaf chain: the master and the essence name the same source mobs',
  masterSlotClips.length === masters.length && new Set(masterSlotClips.map(({ clip }) => clip.sourceMobId)).size === essenceMobIds.size &&
    [...new Set(masterSlotClips.map(({ clip }) => clip.sourceMobId))].every((id) => essenceMobIds.has(id)))
check('aaf chain: every timeline clip resolves to a master mob',
  timelineClips.every((clip) => mobsById.get(clip.sourceMobId)?.classId === AAF_CLASS_IDS.MasterMob))
check('aaf chain: no mob id is the null UMID',
  aaf.content.mobs.every((mob) => mob.mobId !== null && mob.mobId !== NULL_UMID))
check('aaf chain: no source clip carries the null UMID',
  everyClip.every((clip) => clip.sourceMobId !== null && clip.sourceMobId !== NULL_UMID))
check('aaf chain: every source clip reference resolves to a mob',
  everyClip.every((clip) => mobsById.has(clip.sourceMobId)))
check('aaf chain: descriptor length * block align equals the essence bytes',
  aaf.content.essenceData.every((item) => {
    const owner = mobsById.get(item.mobId)
    return owner !== undefined && owner.descriptor !== null && item.bytes === owner.descriptor.length * owner.descriptor.blockAlign
  }))
check('aaf chain: validateAafGraph accepts the file as written', validateAafGraph(aaf) === aaf)

// The parser has to reject a graph whose two ends disagree instead of returning
// it: the mutations below are the exact defects the writer used to produce.
const brokenEssence = structuredClone(aaf)
brokenEssence.content.essenceData[0].mobId = masters[0].mobId
expectError('aaf chain: essence owned by a master mob is refused', /not a source mob|has no descriptor/, () => validateAafGraph(brokenEssence))

const brokenLength = structuredClone(aaf)
brokenLength.content.mobs.find((mob) => mob.classId === AAF_CLASS_IDS.SourceMob).slots[0].segment.length += 1
expectError('aaf chain: a source slot length that disagrees with the descriptor is refused', /disagrees with descriptor length/, () => validateAafGraph(brokenLength))

const brokenUmid = structuredClone(aaf)
brokenUmid.content.mobs[0].mobId = NULL_UMID
expectError('aaf chain: a null UMID is refused', /null UMID/, () => validateAafGraph(brokenUmid))

const brokenSource = structuredClone(aaf)
brokenSource.content.mobs.find((mob) => mob.classId === AAF_CLASS_IDS.SourceMob).slots[0].segment.sourceMobId = 'ff'.repeat(32)
expectError('aaf chain: a dangling source clip reference is refused', /not in the file/, () => validateAafGraph(brokenSource))

/* --------------------------------------------------------- aaf: timeline -- */

console.log('\n-- aaf: the timeline says what the cue set said --')
check('aaf: edit rate', aaf.timeline.editRate === 48000, String(aaf.timeline.editRate))
check('aaf: two tracks from lane packing', aaf.timeline.tracks.length === 2, String(aaf.timeline.tracks.length))
const placed = aaf.timeline.tracks.flatMap((track) => track.clips)
check('aaf: one clip per cue on the timeline', placed.length === CUES.length, String(placed.length))
let worstPosition = 0
let worstDuration = 0
let named = 0
for (const cue of CUES) {
  const clip = placed.find((candidate) => candidate.name === cue.name)
  if (clip === undefined) continue
  named += 1
  worstPosition = Math.max(worstPosition, Math.abs(clip.at - cue.at))
  worstDuration = Math.max(worstDuration, Math.abs(clip.duration - cue.duration))
}
console.log(`  worst position ${(worstPosition * 1e6).toFixed(3)} µs, worst duration ${(worstDuration * 1e6).toFixed(3)} µs`)
check('aaf: every cue resolves to a named clip', named === CUES.length, `${named} of ${CUES.length}`)
check('aaf: positions are sample exact', worstPosition <= 0.5 / 48000 + 1e-12, `${worstPosition} s`)
check('aaf: durations are sample exact', worstDuration <= 0.5 / 48000 + 1e-12, `${worstDuration} s`)
check('aaf: no clip lies before 0', placed.every((clip) => clip.at >= 0))
const laneOne = aaf.timeline.tracks[0].clips
check('aaf: lane one holds the three sequential cues', laneOne.map((clip) => clip.name).join(',') === 'boom,ding,swell', JSON.stringify(laneOne.map((clip) => clip.name)))
check('aaf: lane two holds the overlap', aaf.timeline.tracks[1].clips.map((clip) => clip.name).join(',') === 'overlap')
check('aaf: lane packing keeps overlaps out of one track', laneOne.every((clip, index) => index === 0 || clip.at + 1e-9 >= laneOne[index - 1].at + laneOne[index - 1].duration))

/* ------------------------------------- aaf: internal consistency of bytes -- */

console.log('\n-- aaf: every byte the file claims is really there --')
const container = readCompoundFile(first.buffer)
const storageNodes = container.list.filter((node) => node.kind === 'storage')
const knownClassIds = new Set(Object.values(AAF_CLASS_IDS))
let unknownClasses = 0
for (const node of storageNodes) {
  if (node.name === '') continue // the root is checked separately
  if (!knownClassIds.has(node.clsid)) unknownClasses += 1
}
check('aaf: every storage has a registered AAF class id', unknownClasses === 0, `${unknownClasses} unknown`)
check('aaf: the root uses the AAF root class', container.clsid === AAF_CLASS_IDS.Root)

// The container is not a flat list: every storage's siblings are a red-black
// tree. ContentStorage is the widest one in an AAF file (one entry per mob plus
// the vector index streams), so it is where a directory that is only ordered —
// not rebalanced — turns into the O(n) lookup a reader pays on every open.
const contentEntry = container.directory.find((entry) => entry.name === 'Content-3b03' && entry.kind === 'storage')
const contentShape = directoryTreeShape(container, contentEntry)
const contentChildren = container.list.filter((node) => node.path.slice(0, node.path.lastIndexOf('/')) === '/Header-2/Content-3b03').length
const contentBound = 2 * Math.log2(Math.max(1, contentShape.nodes)) + 2
console.log(`  ContentStorage directory: ${contentShape.nodes} entries, depth ${contentShape.depth} (bound ${contentBound.toFixed(2)}), black height ${contentShape.blackHeight}`)
check('aaf tree: ContentStorage directory holds every child exactly once',
  contentShape.nodes === contentChildren && !contentShape.cyclic, `${contentShape.nodes} in tree, ${contentChildren} in list, cyclic ${contentShape.cyclic}`)
check('aaf tree: ContentStorage directory is a balanced red-black tree',
  contentShape.unbalanced === 0 && contentShape.redRed === 0 && contentShape.depth <= contentBound,
  `unbalanced ${contentShape.unbalanced}, red-red ${contentShape.redRed}, depth ${contentShape.depth} > ${contentBound.toFixed(2)}`)

// The same check at the size where the old writer degenerated hardest: 15 cues
// put 49 entries (31 mobs, 15 essence blobs, the vector indexes and the
// properties stream) under ContentStorage, and a chain of 49 is what a directory
// lookup used to walk.
const manyCues = Array.from({ length: 15 }, (_item, index) => ({ name: `mob${index}`, at: index * 0.25, duration: 0.08, pcm: pcm(0.08, 48000, 200 + index * 20) }))
const manyContainer = readCompoundFile(exportAaf({ cues: manyCues }).buffer)
const manyShape = directoryTreeShape(manyContainer, manyContainer.directory.find((entry) => entry.name === 'Content-3b03' && entry.kind === 'storage'))
const manyBound = 2 * Math.log2(Math.max(1, manyShape.nodes)) + 2
console.log(`  15 cues: ContentStorage ${manyShape.nodes} entries, depth ${manyShape.depth} (bound ${manyBound.toFixed(2)}), black height ${manyShape.blackHeight}`)
check('aaf tree: ContentStorage with 15 cues keeps depth <= 2*log2(n)+2', manyShape.nodes > 40 && manyShape.depth <= manyBound,
  `${manyShape.nodes} entries, depth ${manyShape.depth} > ${manyBound.toFixed(2)}`)
check('aaf tree: ContentStorage with 15 cues has no red-red edge and equal black height',
  manyShape.unbalanced === 0 && manyShape.redRed === 0, `unbalanced ${manyShape.unbalanced}, red-red ${manyShape.redRed}`)

/** Find a node by path in the container tree. */
function nodeAt (path) {
  return container.list.find((node) => node.path === path)
}

// Every `properties` stream has to decode with the documented header: byte order
// 0x4c, version 32, and a size table whose lengths fit the stream.
let propertyStreams = 0
let badPropertyStreams = 0
for (const node of storageNodes) {
  const propertiesNode = container.list.find((candidate) => candidate.path === `${node.path}/properties`)
  if (propertiesNode === undefined) continue
  propertyStreams += 1
  try {
    const decoded = decodePropertyStream(propertiesNode.data)
    if (decoded.version !== 32) badPropertyStreams += 1
    for (const entry of decoded.properties.values()) {
      if (!Buffer.isBuffer(entry.data)) badPropertyStreams += 1
    }
  } catch {
    badPropertyStreams += 1
  }
}
console.log(`  ${propertyStreams} properties streams decoded`)
check('aaf: every properties stream decodes', badPropertyStreams === 0, `${badPropertyStreams} bad`)
check('aaf: the file holds a properties stream per object', propertyStreams > 20, String(propertyStreams))

// Referential integrity: a strong reference is a storage *name*, so the name in
// the property data has to exist as a child of the object that holds it, and a
// vector's index stream has to name exactly the children present.
const FORMAT_STRONG = 0x22
const FORMAT_VECTOR = 0x32
const FORMAT_SET = 0x3a
const FORMAT_AMBIGUOUS = new Set([0x82, 0x42, 0x02])
let strongRefs = 0
let danglingStrongRefs = 0
let vectorRefs = 0
let danglingVectorRefs = 0
for (const node of storageNodes) {
  const propertiesNode = container.list.find((candidate) => candidate.path === `${node.path}/properties`)
  if (propertiesNode === undefined) continue
  const decoded = decodePropertyStream(propertiesNode.data)
  const children = node.children ?? []
  for (const entry of decoded.properties.values()) {
    if (entry.format === FORMAT_STRONG) {
      strongRefs += 1
      const name = entry.data.toString('utf16le', 0, entry.data.length - 2)
      if (!children.some((child) => child.name === name && child.kind === 'storage')) danglingStrongRefs += 1
      continue
    }
    if (entry.format === FORMAT_VECTOR || entry.format === FORMAT_SET) {
      vectorRefs += 1
      const name = entry.data.toString('utf16le', 0, entry.data.length - 2)
      const indexNode = container.list.find((candidate) => candidate.path === `${node.path}/${name} index`)
      if (indexNode === undefined) {
        danglingVectorRefs += 1
        continue
      }
      const count = indexNode.data.readUInt32LE(0)
      for (let index = 0; index < count; index += 1) {
        const key = indexNode.data.readUInt32LE(12 + index * 4)
        if (!children.some((child) => child.name === `${name}{${key.toString(16)}}`)) danglingVectorRefs += 1
      }
      continue
    }
    if (!FORMAT_AMBIGUOUS.has(entry.format) && entry.format !== 0x12 && entry.format !== 0x1a) {
      check(`aaf: property format 0x${entry.format.toString(16)} is one this writer emits`, false, node.path)
    }
  }
}
console.log(`  ${strongRefs} strong refs, ${vectorRefs} vectors`)
check('aaf: every strong reference resolves to a child storage', danglingStrongRefs === 0, `${danglingStrongRefs} dangling`)
check('aaf: every vector index entry resolves to a child storage', danglingVectorRefs === 0, `${danglingVectorRefs} dangling`)
check('aaf: the graph really uses strong references', strongRefs >= 10, String(strongRefs))
check('aaf: the graph really uses vectors', vectorRefs >= 5, String(vectorRefs))

// The one property that makes AAF legacy-shaped: Header.ByteOrder is the ASCII
// marker II (0x4949), and the version is two bytes major/minor.
const headerNode = nodeAt('/Header-2')
const headerProps = decodePropertyStream(container.list.find((node) => node.path === '/Header-2/properties').data).properties
check('aaf: header property 0x3b01 is the byte order marker', headerProps.get(0x3b01).data.toString('hex') === '4949', headerProps.get(0x3b01).data.toString('hex'))
check('aaf: header property 0x3b07 is the object model version', headerProps.get(0x3b07).data.readUInt32LE(0) === 1)
check('aaf: header property 0x3b05 is version 1.2', headerProps.get(0x3b05).data.toString('hex') === '0102')
check('aaf: header dictionary reference names the child', headerProps.get(0x3b04).data.toString('utf16le', 0, headerProps.get(0x3b04).data.length - 2) === 'Dictionary-3b04')
check('aaf: header storage class is the AAF header class', headerNode.clsid === AAF_CLASS_IDS.Header, headerNode.clsid)
check('aaf: an AUID property is 16 bytes of mixed-endian label', headerProps.get(0x3b09).data.length === 16 && auidToText(headerProps.get(0x3b09).data) === AAF_AUIDS.OperationalPattern1a)
const mobIdProperty = decodePropertyStream(container.list.find((node) => node.path === '/Header-2/Content-3b03/Mobs-1901{0}/properties').data).properties.get(0x4401)
check('aaf: a mob id is a 32 byte UMID', mobIdProperty.data.length === 32, String(mobIdProperty.data.length))
check('aaf: the UMID carries the SMPTE label header', mobIdProperty.data.subarray(0, 12).toString('hex') === '060a2b340101010501010f20', mobIdProperty.data.subarray(0, 12).toString('hex'))
check('aaf: the UMID instance field is 13h (basic UMID)', mobIdProperty.data[12] === 0x13, String(mobIdProperty.data[12]))
const editRateProperty = decodePropertyStream(container.list.find((node) => node.path === '/Header-2/Content-3b03/Mobs-1901{0}/Slots-4403{0}/properties').data).properties.get(0x4b01)
check('aaf: an edit rate is a rational', editRateProperty.data.length === 8 && editRateProperty.data.readUInt32LE(0) === 48000 && editRateProperty.data.readUInt32LE(4) === 1,
  editRateProperty.data.toString('hex'))

/* ------------------------------------------------- aaf: options and modes -- */

console.log('\n-- aaf: offline mode and limits --')
const offline = exportAaf({ cues: CUES.map(({ pcm: _pcm, ...rest }) => rest), embed: false })
const offlineParsed = parseAaf(offline.buffer)
check('aaf offline: no essence data', offlineParsed.content.essenceData.length === 0, String(offlineParsed.content.essenceData.length))
check('aaf offline: the timeline is still complete', offlineParsed.timeline.tracks.flatMap((track) => track.clips).length === CUES.length)
check('aaf offline: warns that no PCM was embedded', offline.warnings.some((warning) => /no PCM was embedded/.test(warning)), JSON.stringify(offline.warnings))
check('aaf offline: no embedded bytes reported', offline.embeddedBytes === 0, String(offline.embeddedBytes))
const offlineAgain = exportAaf({ cues: CUES.map(({ pcm: _pcm, ...rest }) => rest), embed: false })
check('aaf offline: deterministic', Buffer.compare(offline.buffer, offlineAgain.buffer) === 0)

const stereo = pcm(0.25, 44100, 330)
const interlaced = Buffer.alloc(stereo.frames * 4)
for (let frame = 0; frame < stereo.frames; frame += 1) {
  interlaced.writeInt16LE(stereo.data.readInt16LE(frame * 2), frame * 4)
  interlaced.writeInt16LE(-stereo.data.readInt16LE(frame * 2), frame * 4 + 2)
}
const stereoExport = exportAaf({ cues: [{ name: 'stereo', at: 0, duration: 0.25, pcm: { data: interlaced, sampleRate: 44100, channels: 2, bitDepth: 16 } }] })
const stereoParsed = parseAaf(stereoExport.buffer)
const stereoSource = stereoParsed.content.mobs.find((mob) => mob.name.endsWith('.PHYS'))
check('aaf: stereo descriptor channel count', stereoSource.descriptor.channels === 2, String(stereoSource.descriptor.channels))
check('aaf: stereo descriptor block align', stereoSource.descriptor.blockAlign === 4, String(stereoSource.descriptor.blockAlign))
check('aaf: stereo project rate follows the media', stereoExport.sampleRate === 44100, String(stereoExport.sampleRate))
check('aaf: stereo essence is the interleaved frames', Buffer.compare(stereoParsed.content.essenceData[0].data, interlaced) === 0)

const eightBit = exportAaf({ cues: [{ name: 'eight', at: 0, duration: 0.1, pcm: { data: Buffer.alloc(800, 128), sampleRate: 8000, channels: 1, bitDepth: 8 } }] })
check('aaf: 8 bit PCM is accepted', parseAaf(eightBit.buffer).content.mobs.find((mob) => mob.name.endsWith('.PHYS')).descriptor.quantizationBits === 8)

console.log('\n-- aaf: errors --')
expectError('aaf: empty cue list', /non-empty array/, () => exportAaf({ cues: [] }))
expectError('aaf: zero duration', /duration must be greater than 0/, () => exportAaf({ cues: [{ name: 'x', at: 0, duration: 0 }] }))
expectError('aaf: negative position', /at must be a non-negative/, () => exportAaf({ cues: [{ name: 'x', at: -1, duration: 1 }] }))
expectError('aaf: odd bit depth', /bitDepth must be 8, 16, 24 or 32/, () => exportAaf({ cues: [{ name: 'x', at: 0, duration: 1, pcm: { data: Buffer.alloc(100), sampleRate: 8000, channels: 1, bitDepth: 12 } }] }))
expectError('aaf: data that is not whole frames', /not a whole number of/, () => exportAaf({ cues: [{ name: 'x', at: 0, duration: 1, pcm: { data: Buffer.alloc(101), sampleRate: 8000, channels: 2, bitDepth: 16 } }] }))
expectError('aaf: embed limit', /over the .* byte limit/, () => exportAaf({ cues: CUES, maxEmbedBytes: 1000 }))
expectError('aaf: pcm without data', /pcm\.data must be a Buffer/, () => exportAaf({ cues: [{ name: 'x', at: 0, duration: 1, pcm: { sampleRate: 8000 } }] }))
expectError('aaf: parse garbage', /the 8 byte signature does not match/, () => parseAaf(Buffer.alloc(2048, 0x2a)))

/* ------------------------------------------------------------ lane helper -- */

console.log('\n-- lane packing --')
const lanes = packLanes([
  { at: 0, duration: 2 },
  { at: 1, duration: 1 },
  { at: 2, duration: 1 },
  { at: 3.5, duration: 0.5 }
])
check('packLanes: two lanes for one overlap', lanes.length === 2, String(lanes.length))
check('packLanes: back-to-back clips share a lane', lanes[0].length === 3, String(lanes[0].length))
check('packLanes: lanes are ordered by start', lanes[1][0].at === 1, String(lanes[1][0].at))
check('packLanes: empty input', packLanes([]).length === 0)

/* ---------------------------------------------------------- tool layer -- */

console.log('\n-- tool: audio_daw aaf end to end --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-aaf-'))
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
}
const exec = { agent: { session: { id: 'test' } } }
registerDawTools(ctx)
const tool = registered.get('audio_daw')
const call = (args) => tool.execute(args, exec)

// Two real wavs, so the tool has to read the header, the PCM, and then prove the
// file it wrote parses back.
const sampleRate = 48000
const frames = Math.round(1.25 * sampleRate)
const samples = new Float32Array(frames)
for (let index = 0; index < frames; index += 1) samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5
await mkdir(join(cwd, 'sfx'), { recursive: true })
await writeFile(join(cwd, 'sfx', 'hit.wav'), encodeWav([samples], sampleRate))
await writeFile(join(cwd, 'sfx', 'tail.wav'), encodeWav([samples.subarray(0, Math.round(0.5 * sampleRate))], sampleRate))

const toolAaf = await call({
  format: 'aaf',
  cues: [
    { name: 'hit', path: 'sfx/hit.wav', at: 0.5, duration: 1.25, gainDb: -3 },
    { name: 'tail', path: 'sfx/tail.wav', at: 1.0, duration: 0.5 }
  ]
})
console.log(`  ${toolAaf.text.split('\n').join('\n  ')}`)
check('tool aaf: default output path', /^assets\/audio\/aaf-[0-9a-f]+\.aaf$/.test(toolAaf.relativePath), toolAaf.relativePath)
check('tool aaf: binary result', toolAaf.binary === true)
check('tool aaf: verified mobs and clips', toolAaf.verified.clips === 2 && toolAaf.verified.mobs === 5, JSON.stringify(toolAaf.verified))
check('tool aaf: verified embedded bytes', toolAaf.verified.embeddedBytes === Math.round(1.25 * sampleRate) * 2 + Math.round(0.5 * sampleRate) * 2, String(toolAaf.verified.embeddedBytes))
check('tool aaf: reports not importable', toolAaf.importable === false)
check('tool aaf: structure reported', toolAaf.structure?.metaDictionary === 'absent', JSON.stringify(toolAaf.structure))
check('tool aaf: notes the PCM embed', /embedded as raw PCM/.test(toolAaf.text), toolAaf.text)
const bytesOnDisk = await readFile(toolAaf.path)
check('tool aaf: bytes on disk match the returned size', bytesOnDisk.length === toolAaf.bytes, `${bytesOnDisk.length} vs ${toolAaf.bytes}`)
const parsedOnDisk = parseAaf(bytesOnDisk)
check('tool aaf: file on disk parses back', parsedOnDisk.timeline.tracks.flatMap((track) => track.clips).length === 2)
check('tool aaf: embedded PCM on disk', parsedOnDisk.content.essenceData.reduce((total, item) => total + item.bytes, 0) === toolAaf.verified.embeddedBytes)
check('tool aaf: timeline positions survive the round trip', Math.abs(parsedOnDisk.timeline.tracks[0].clips[0].at - 0.5) < 1e-9, String(parsedOnDisk.timeline.tracks[0].clips[0].at))
const toolAafAgain = await call({ format: 'aaf', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0.5, duration: 1.25, gainDb: -3 }, { name: 'tail', path: 'sfx/tail.wav', at: 1.0, duration: 0.5 }] })
check('tool aaf: same request, same path', toolAafAgain.path === toolAaf.path, toolAafAgain.relativePath)
check('tool aaf: same request, same bytes', Buffer.compare(await readFile(toolAafAgain.path), bytesOnDisk) === 0)
const toolAafOffline = await call({ format: 'aaf', embed: false, cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 }] })
check('tool aaf: embed false verified with no essence', toolAafOffline.verified.embeddedBytes === 0, JSON.stringify(toolAafOffline.verified))
check('tool aaf: embed false warns', toolAafOffline.warnings.some((warning) => /no PCM was embedded/.test(warning)), JSON.stringify(toolAafOffline.warnings))

const toolOmf = await call({ format: 'omf', cues: [{ name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 }] })
console.log(`  ${toolOmf.text.split('\n').join('\n  ')}`)
check('tool omf: extension', toolOmf.relativePath.endsWith('.omf'), toolOmf.relativePath)
check('tool omf: binary result', toolOmf.binary === true)
check('tool omf: verified streams', toolOmf.verified.streams === 2, JSON.stringify(toolOmf.verified))
check('tool omf: reports skeleton and not importable', toolOmf.skeleton === true && toolOmf.importable === false)
check('tool omf: loud warning about Avid', /Avid/.test(toolOmf.text), toolOmf.text)
const omfContainer = readCompoundFile(await readFile(toolOmf.path))
check('tool omf: container is valid CFB', omfContainer.version === 3)
check('tool omf: header stream says skeleton', omfContainer.list.find((node) => node.name === 'OMFI:HEADER').data.toString('utf8').startsWith('DSH-AUDIOKIT-OMF-SKELETON-V1'))
const omfManifest = JSON.parse(omfContainer.list.find((node) => node.name === 'DSH:MANIFEST').data.toString('utf8'))
check('tool omf: manifest is not importable', omfManifest.importable === false)
check('tool omf: manifest lists the missing object model', Array.isArray(omfManifest.capabilities.missing) && omfManifest.capabilities.missing.length >= 5)

console.log('\n-- tool: aaf refuses media it cannot embed, and says why --')
await writeFile(join(cwd, 'sfx', 'broken.wav'), Buffer.from('not a wav file at all, definitely not'))
const withBroken = await call({ format: 'aaf', cues: [
  { name: 'hit', path: 'sfx/hit.wav', at: 0, duration: 1.25 },
  { name: 'broken', path: 'sfx/broken.wav', at: 0.25, duration: 0.5 }
] })
check('tool aaf: a non-PCM file becomes an offline clip instead of failing the export', /written offline/.test(withBroken.text), withBroken.text)
check('tool aaf: the offline clip still lands on the timeline', withBroken.verified.clips === 2, JSON.stringify(withBroken.verified))
check('tool aaf: only the readable file is embedded', withBroken.verified.embeddedBytes === Math.round(1.25 * sampleRate) * 2, String(withBroken.verified.embeddedBytes))

// A file the writer does not produce must be rejected by the read-back check
// rather than reported as verified — otherwise the self-check is decoration.
const okBytes = await readFile(toolAaf.path)
const corrupted = Buffer.from(okBytes)
corrupted[0] = 0x00
let corruptionRejected = false
try {
  parseAaf(corrupted)
} catch (error) {
  corruptionRejected = /compound file|signature/i.test(error.message)
}
check('aaf: a corrupted signature is refused by the parser', corruptionRejected)

await rm(cwd, { recursive: true, force: true })

console.log(failures === 0
  ? `\nOK: ${checks} checks, the container and the AAF object graph read back to what was written`
  : `\nFAILED: ${failures} of ${checks} check(s)`)
process.exit(failures === 0 ? 0 : 1)
