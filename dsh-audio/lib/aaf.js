/**
 * AAF (Advanced Authoring Format) export 鈥?a written subset, and the parser
 * that proves what was written.
 *
 * What this module is, stated without decoration: it writes a **valid MS-CFB
 * container** holding a **generated-subset AAF object graph** 鈥?a header, a
 * dictionary of the data/container definitions it uses, a content storage with
 * one composition mob (a timeline of lanes), one master mob and one source mob
 * per clip, PCM descriptors, and the audio itself embedded as raw PCM frames
 * owned by the source mob that describes them.
 * Every property is encoded in AAF's stored-object form (a `properties` stream
 * of `pid / format / size` records over built-in AAF property ids) and every
 * class is an AAF class identifier taken from the specification's registration.
 *
 * What this module is not: a complete AAF writer. AAF is self-describing 鈥?a
 * conforming file embeds a MetaDictionary with a class definition for every
 * object it contains (around 900 definition objects and 120 KB for a minimal
 * real file, measured from a reference implementation). That dictionary is not
 * emitted here, so an AAF SDK based application (Pro Tools, Media Composer,
 * Resolve) rejects the file while resolving its dictionary, before it ever
 * looks at the timeline. The gap is one layer, it is documented in
 * `docs/INTEROP.zh.md`, and the rest of the file is genuinely there: the
 * container, the object tree, the class ids, the property encodings, the mob
 * and slot structure, and the embedded samples.
 *
 * Determinism: mob ids are SHA-256 digests of a stable seed string, timestamps
 * are a fixed constant, lanes are packed by a deterministic first-fit, and no
 * clock or random source is consulted 鈥?the same request produces the same
 * bytes, which is what lets the tool name the file after a content hash.
 */

import { createHash } from 'node:crypto'
import { readCompoundFile, writeCompoundFile } from './cfb.js'
import { packLanes } from './timeline.js'

/* --------------------------------------------------------------- constants -- */

/** AAF class identifiers, as registered for the format. */
export const AAF_CLASS_IDS = Object.freeze({
  Root: 'b3b398a5-1c90-11d4-8053-080036210804',
  MetaDictionary: '0d010101-0225-0000-060e-2b3402060101',
  Header: '0d010101-0101-2f00-060e-2b3402060101',
  Dictionary: '0d010101-0101-2200-060e-2b3402060101',
  Identification: '0d010101-0101-3000-060e-2b3402060101',
  ContentStorage: '0d010101-0101-1800-060e-2b3402060101',
  DataDefinition: '0d010101-0101-1b00-060e-2b3402060101',
  ContainerDefinition: '0d010101-0101-2000-060e-2b3402060101',
  CodecDefinition: '0d010101-0101-1f00-060e-2b3402060101',
  CompositionMob: '0d010101-0101-3500-060e-2b3402060101',
  MasterMob: '0d010101-0101-3600-060e-2b3402060101',
  SourceMob: '0d010101-0101-3700-060e-2b3402060101',
  TimelineMobSlot: '0d010101-0101-3b00-060e-2b3402060101',
  Sequence: '0d010101-0101-0f00-060e-2b3402060101',
  SourceClip: '0d010101-0101-1100-060e-2b3402060101',
  Filler: '0d010101-0101-0900-060e-2b3402060101',
  PCMDescriptor: '0d010101-0101-4800-060e-2b3402060101',
  EssenceData: '0d010101-0101-2300-060e-2b3402060101'
})

/** Registry identifiers the object graph refers to. */
export const AAF_AUIDS = Object.freeze({
  /** AAF operational pattern 1a: a single essence track group. */
  OperationalPattern1a: '0d011201-0100-0000-060e-2b3404010105',
  DataDefSound: '02020301-0002-0000-060e-2b3404010101',
  DataDefData: '02020301-0003-0000-060e-2b3404010101',
  DataDefTimecode: '01020301-0001-0000-060e-2b3404010101',
  ContainerDefAAF: '71b51343-bad8-d211-809b-006008143e6f',
  ContainerDefRIFFWAVE: '0113010d-0101-0001-060e-2b3404010106',
  UsageTopLevel: '0201010d-0101-0007-060e-2b3404010101'
})

/** Property ids, from the AAF object specification (built-in, dictionary independent). */
const PID = Object.freeze({
  // Root
  rootMetaDictionary: 0x0001,
  rootHeader: 0x0002,
  // Component / Segment / SourceReference
  componentDataDefinition: 0x0201,
  componentLength: 0x0202,
  componentAttributes: 0x0203,
  sequenceComponents: 0x1001,
  sourceClipSourceId: 0x1101,
  sourceClipSourceSlotId: 0x1102,
  sourceClipStart: 0x1201,
  // DefinitionObject
  definitionObjectIdentification: 0x1b01,
  definitionObjectName: 0x1b02,
  definitionObjectDescription: 0x1b03,
  // Dictionary
  dictionaryDataDefinitions: 0x2605,
  dictionaryCodecDefinitions: 0x2607,
  dictionaryContainerDefinitions: 0x2608,
  // ContentStorage
  contentStorageMobs: 0x1901,
  contentStorageEssenceData: 0x1902,
  // EssenceData
  essenceDataMobId: 0x2701,
  essenceDataData: 0x2702,
  // FileDescriptor / SoundDescriptor
  fileDescriptorSampleRate: 0x3001,
  fileDescriptorLength: 0x3002,
  soundDescriptorQuantizationBits: 0x3d01,
  soundDescriptorAudioSamplingRate: 0x3d03,
  soundDescriptorChannels: 0x3d07,
  soundDescriptorAverageBps: 0x3d09,
  soundDescriptorBlockAlign: 0x3d0a,
  // Header
  headerByteOrder: 0x3b01,
  headerLastModified: 0x3b02,
  headerContent: 0x3b03,
  headerDictionary: 0x3b04,
  headerVersion: 0x3b05,
  headerIdentificationList: 0x3b06,
  headerObjectModelVersion: 0x3b07,
  headerOperationalPattern: 0x3b09,
  // Identification
  identificationCompanyName: 0x3c01,
  identificationProductName: 0x3c02,
  identificationProductVersionString: 0x3c04,
  identificationProductId: 0x3c05,
  identificationDate: 0x3c06,
  identificationPlatform: 0x3c08,
  identificationGenerationAuid: 0x3c09,
  // Mob
  mobMobId: 0x4401,
  mobName: 0x4402,
  mobSlots: 0x4403,
  mobCreationTime: 0x4404,
  mobLastModified: 0x4405,
  mobUsageCode: 0x4408,
  sourceMobEssenceDescription: 0x4701,
  // MobSlot / TimelineMobSlot
  mobSlotSlotId: 0x4801,
  mobSlotSlotName: 0x4802,
  mobSlotSegment: 0x4803,
  timelineMobSlotEditRate: 0x4b01,
  timelineMobSlotOrigin: 0x4b02
})

/** Stored property formats: the low byte names the value's shape. */
const FORMAT = Object.freeze({
  weakRef: 0x02,
  strongRef: 0x22,
  strongRefVector: 0x32,
  strongRefSet: 0x3a,
  stream: 0x42,
  data: 0x82
})

/** Property stream version this writer emits. */
const PROPERTY_VERSION = 32

/** Byte order marker inside a `properties` stream: 0x4c means little endian. */
const PROPERTY_BYTE_ORDER = 0x4c

/**
 * Fixed date used for every time stamp in the file.
 *
 * 2025-01-01T00:00:00Z. AAF stores creation/modification times, but this
 * exporter must be deterministic (the tool names the output after a content
 * hash), and a wall clock would change the bytes on every run. The value is
 * visible in only one place 鈥?the file's own header 鈥?so nothing is lost.
 */
const AAF_DATE = Object.freeze({ year: 2025, month: 1, day: 1, hour: 0, minute: 0, second: 0, fraction: 0 })

/** Product identity written into the file's Identification object. */
const PRODUCT_NAME = 'dsh-audiokit'
const PRODUCT_VERSION = '0.6.1'
const COMPANY_NAME = 'dsh-audiokit'

/**
 * Product id and generation UUID: stable constants, not random.
 *
 * The format wants a product id (a registered AUID) and a per-write generation
 * id. Both are derived from a fixed string here so the bytes stay stable.
 */
const PRODUCT_ID = '4a2f1c6e-9b3d-4e5a-8c71-0d2b6f1a9e30'
const GENERATION_ID = '9e1d4b7c-2a6f-4c83-9b05-7d3e8a1c6f42'

/** AAF limit: one property's data must fit the 16-bit size field. */
const MAX_PROPERTY_BYTES = 0xffff

/** Default ceiling on embedded PCM, so one call cannot write a gigabyte. */
const MAX_EMBED_BYTES = 64 * 1024 * 1024

/** Reel/name length cap for a CFB directory entry, minus the NUL. */
const MAX_ENTRY_NAME = 31

/* ----------------------------------------------------------------- errors -- */

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
 * Collapse anything that would break a one-line file name into single-line text.
 *
 * A cue name becomes a mob name, which becomes a directory entry name inside the
 * container: a newline or a control character there would either split a string
 * field or be rejected by a strict reader, so it is replaced rather than passed
 * through. Runs of whitespace are squeezed because the entry-name budget is 31
 * characters.
 */
function singleLineText (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------ byte helpers -- */

function u8 (value) {
  const buffer = Buffer.alloc(1)
  buffer.writeUInt8(value & 0xff)
  return buffer
}

function u16 (value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff)
  return buffer
}

function u32 (value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

function i64 (value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(BigInt(Math.round(value)))
  return buffer
}

/** AAF rational: numerator and denominator as two little-endian 32-bit words. */
function rational (numerator, denominator) {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(Math.round(numerator) >>> 0, 0)
  buffer.writeUInt32LE(Math.round(denominator) >>> 0, 4)
  return buffer
}

/** AAF date struct: year(u16), month, day, hour, minute, second, fraction. */
function dateStruct (date = AAF_DATE) {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt16LE(date.year, 0)
  buffer.writeUInt8(date.month, 2)
  buffer.writeUInt8(date.day, 3)
  buffer.writeUInt8(date.hour, 4)
  buffer.writeUInt8(date.minute, 5)
  buffer.writeUInt8(date.second, 6)
  buffer.writeUInt8(date.fraction, 7)
  return buffer
}

/**
 * Sixteen bytes of an AUID, in the mixed-endian layout AAF stores.
 *
 * AAF exchange identifiers are SMPTE labels whose first three words are stored
 * little-endian, exactly like a Windows class id; the trailing eight bytes are
 * literal. Writing them big-endian produces a file whose classes are all
 * unknown, which is why this conversion lives in one place.
 */
function auidBytes (text) {
  const hex = String(text).toLowerCase().replace(/[{}-]/g, '')
  if (!/^[0-9a-f]{32}$/.test(hex)) fail('aaf', `not an AUID: ${describeValue(text)}`)
  const be = Buffer.from(hex, 'hex')
  return Buffer.from([
    be[3], be[2], be[1], be[0],
    be[5], be[4],
    be[7], be[6],
    be[8], be[9], be[10], be[11], be[12], be[13], be[14], be[15]
  ])
}

/** Inverse of `auidBytes`, for the parser and for diagnostics. */
export function auidToText (bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) fail('aaf', 'an AUID is 16 bytes')
  const be = Buffer.from([
    bytes[3], bytes[2], bytes[1], bytes[0],
    bytes[5], bytes[4],
    bytes[7], bytes[6],
    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
  ])
  const hex = be.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A UTF-16LE string with the terminating NUL the format's string type carries. */
function aafString (text) {
  return Buffer.concat([Buffer.from(String(text), 'utf16le'), Buffer.alloc(2)])
}

/** Read an AAF string (UTF-16LE, NUL terminated) from a property blob. */
function readAafString (data) {
  let end = data.length
  while (end >= 2 && data[end - 1] === 0 && data[end - 2] === 0) end -= 2
  return data.toString('utf16le', 0, end)
}

/**
 * A 32-byte UMID: the SMPTE key-length-value header plus a 16-byte material
 * number derived from `seed`.
 *
 * The material number is a SHA-256 slice rather than a random UUID so the same
 * request always names the same mob 鈥?determinism is a hard requirement here,
 * and a UMID's only job is to be unique within the file.
 */
function umid (seed) {
  const header = Buffer.from('060a2b340101010501010f2013000000', 'hex')
  const material = createHash('sha256').update(`dsh-audiokit/aaf/1:${seed}`).digest().subarray(0, 16)
  return Buffer.concat([header, material])
}

/** A 16-byte id derived from `seed`, for the fields that want a bare UUID. */
function derivedUuid (seed) {
  const bytes = createHash('sha256').update(`dsh-audiokit/aaf/uuid/1:${seed}`).digest().subarray(0, 16)
  // Set the version/variant bits so the value is a well-formed UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes
}

/**
 * Name a child storage after the property that references it.
 *
 * AAF resolves a strong reference by storage *name*, so the name has to encode
 * the property: `<property name>-<pid in hex>`, truncated to the 31 characters
 * a CFB directory entry allows. This mirrors the convention every AAF writer
 * uses, which is what makes a hex dump of the file readable.
 */
function mangleName (name, pid, maxLength = MAX_ENTRY_NAME) {
  const suffix = `-${pid.toString(16)}`
  const room = Math.max(1, maxLength - suffix.length)
  return `${String(name).slice(0, room)}${suffix}`
}

/** Name of a vector's index stream: `<name> index`. */
function indexName (name, pid) {
  return mangleName(name, pid, MAX_ENTRY_NAME - 6)
}

/* ------------------------------------------------------- property streams -- */

/**
 * Serialise one object's `properties` stream.
 *
 * Layout (little endian, the only order AAF defines for this structure):
 *
 * ```
 * u8   byte order marker, 0x4c for little endian
 * u8   property stream version, 32
 * u16  entry count
 * then, entry count times: u16 pid, u16 stored format, u16 data length
 * then the data blobs in the same order
 * ```
 *
 * The size field is 16 bits, so a single property cannot exceed 65535 bytes;
 * everything this writer emits is far smaller, but the check is here so a caller
 * cannot silently truncate.
 *
 * @param {Array<{pid: number, format: number, data: Buffer}>} properties
 * @returns {Buffer}
 */
export function encodePropertyStream (properties) {
  const header = Buffer.alloc(4 + properties.length * 6)
  header.writeUInt8(PROPERTY_BYTE_ORDER, 0)
  header.writeUInt8(PROPERTY_VERSION, 1)
  header.writeUInt16LE(properties.length, 2)
  let offset = 4
  const blobs = []
  for (const property of properties) {
    if (!Buffer.isBuffer(property.data)) fail('aaf', `property 0x${property.pid.toString(16)} has no data`)
    if (property.data.length > MAX_PROPERTY_BYTES) {
      fail('aaf', `property 0x${property.pid.toString(16)} is ${property.data.length} bytes; the format's size field allows ${MAX_PROPERTY_BYTES}`)
    }
    header.writeUInt16LE(property.pid, offset)
    header.writeUInt16LE(property.format, offset + 2)
    header.writeUInt16LE(property.data.length, offset + 4)
    offset += 6
    blobs.push(property.data)
  }
  return Buffer.concat([header, ...blobs])
}

/**
 * Decode a `properties` stream into pid 鈫?{ format, data }.
 *
 * @param {Buffer} buffer
 * @returns {{ version: number, properties: Map<number, {format: number, data: Buffer}> }}
 */
export function decodePropertyStream (buffer) {
  if (!Buffer.isBuffer(buffer)) fail('aaf', 'a properties stream must be a Buffer')
  if (buffer.length < 4) fail('aaf', `a properties stream is at least 4 bytes, got ${buffer.length}`)
  const byteOrder = buffer.readUInt8(0)
  if (byteOrder !== PROPERTY_BYTE_ORDER) fail('aaf', `unsupported property byte order 0x${byteOrder.toString(16)}`)
  const version = buffer.readUInt8(1)
  const count = buffer.readUInt16LE(2)
  const needed = 4 + count * 6
  if (buffer.length < needed) fail('aaf', `a properties stream claims ${count} entries but holds ${buffer.length} bytes`)
  const entries = []
  let offset = 4
  for (let index = 0; index < count; index += 1) {
    entries.push({
      pid: buffer.readUInt16LE(offset),
      format: buffer.readUInt16LE(offset + 2),
      size: buffer.readUInt16LE(offset + 4)
    })
    offset += 6
  }
  const properties = new Map()
  let dataOffset = needed
  for (const entry of entries) {
    if (dataOffset + entry.size > buffer.length) {
      fail('aaf', `property 0x${entry.pid.toString(16)} claims ${entry.size} bytes but the stream ends first`)
    }
    properties.set(entry.pid, { format: entry.format, data: Buffer.from(buffer.subarray(dataOffset, dataOffset + entry.size)) })
    dataOffset += entry.size
  }
  return { version, properties }
}

/* ----------------------------------------------------------- object model -- */

/** A raw value property: pid, stored format, bytes. */
function dataProperty (pid, data) {
  return { kind: 'data', pid, format: FORMAT.data, data }
}

/** A strong reference: the target is written as a child storage of this object. */
function strongRef (pid, propertyName, target) {
  return { kind: 'strong', pid, propertyName, target }
}

/** A vector of strong references: index stream plus one child storage per item. */
function strongRefVector (pid, propertyName, items, set = false) {
  return { kind: 'vector', pid, propertyName, items, format: set ? FORMAT.strongRefSet : FORMAT.strongRefVector }
}

/**
 * A weak reference: an index into the file's referenced-properties table plus
 * the target's unique key.
 *
 * A weak reference does not own its target; it identifies it by the key the
 * target's class declares (the AUID of a definition, the UMID of a mob). The
 * table entry names the property path from the root, which is how a reader
 * finds the set the key belongs to.
 */
function weakRef (pid, tableIndex, keyPid, keyBytes) {
  const data = Buffer.concat([u16(tableIndex), u16(keyPid), u8(keyBytes.length), keyBytes])
  return { kind: 'data', pid, format: FORMAT.weakRef, data }
}

/** A property pointing at a named stream inside the object's storage. */
function streamProperty (pid, streamName, data) {
  return { kind: 'stream', pid, streamName, data }
}

/** An object: a class id, an ordered property list, and (later) children. */
function createObject (classId, properties = []) {
  return { classId, properties }
}

/**
 * The referenced-properties table: one path per weak-reference target class.
 *
 * Each entry is the chain of property ids leading from the root to the set that
 * owns the keys being referenced. The only weak references this writer emits
 * point at data definitions, which live in `Header.Dictionary.DataDefinitions`,
 * so the table has exactly one entry.
 */
const REFERENCED_PROPERTIES = Object.freeze([
  Object.freeze([PID.rootHeader, PID.headerDictionary, PID.dictionaryDataDefinitions])
])

/** Index of the data-definition path in `REFERENCED_PROPERTIES`. */
const DATA_DEFINITION_WEAKREF = 0

/**
 * Serialise the referenced-properties table.
 *
 * `u8 0x4c`, `u16 path count`, `u32 pid count`, then each path as pid values
 * terminated by a zero 鈥?the count including the terminators.
 */
function encodeReferencedProperties () {
  const pids = []
  for (const path of REFERENCED_PROPERTIES) {
    for (const pid of path) pids.push(pid)
    pids.push(0)
  }
  const header = Buffer.alloc(7)
  header.writeUInt8(PROPERTY_BYTE_ORDER, 0)
  header.writeUInt16LE(REFERENCED_PROPERTIES.length, 1)
  header.writeUInt32LE(pids.length, 3)
  const body = Buffer.alloc(pids.length * 2)
  pids.forEach((pid, index) => body.writeUInt16LE(pid, index * 2))
  return Buffer.concat([header, body])
}

/**
 * Serialise a vector index stream: count, next free key, last free key, keys.
 *
 * The keys are the local identifiers that name the child storages
 * (`<index name>{<key>}`), so the order in this stream is the order a reader
 * sees the items in.
 */
function encodeIndexStream (keys) {
  const buffer = Buffer.alloc(12 + keys.length * 4)
  buffer.writeUInt32LE(keys.length, 0)
  buffer.writeUInt32LE(keys.length, 4)
  buffer.writeUInt32LE(0xffffffff, 8)
  keys.forEach((key, index) => buffer.writeUInt32LE(key, 12 + index * 4))
  return buffer
}

/**
 * Turn one object into a CFB storage node.
 *
 * Strong references become child storages named after their property, vectors
 * become an index stream plus one child per item, stream properties add a named
 * stream next to the `properties` stream. This is the whole AAF file layout:
 * everything else in the format is a choice of which object to attach where.
 *
 * @param {object} object - `{ classId, properties }`.
 * @param {string} name - the storage name inside its parent.
 * @returns {{ name: string, clsid: string, children: object[] }}
 */
function serializeObject (object, name) {
  const children = []
  const properties = []
  for (const property of object.properties) {
    if (property.kind === 'data') {
      properties.push({ pid: property.pid, format: property.format, data: property.data })
      continue
    }
    if (property.kind === 'strong') {
      const childName = mangleName(property.propertyName, property.pid)
      properties.push({ pid: property.pid, format: FORMAT.strongRef, data: aafString(childName) })
      children.push(serializeObject(property.target, childName))
      continue
    }
    if (property.kind === 'vector') {
      const vectorName = indexName(property.propertyName, property.pid)
      properties.push({ pid: property.pid, format: property.format, data: aafString(vectorName) })
      const keys = property.items.map((_item, index) => index)
      children.push({ name: `${vectorName} index`, data: encodeIndexStream(keys) })
      property.items.forEach((item, index) => {
        children.push(serializeObject(item, `${vectorName}{${keys[index].toString(16)}}`))
      })
      continue
    }
    if (property.kind === 'stream') {
      // The stream property's data is the marker byte 0x55 followed by the
      // stream name; the payload itself is a stream next to `properties`.
      properties.push({
        pid: property.pid,
        format: FORMAT.stream,
        data: Buffer.concat([u8(0x55), aafString(property.streamName)])
      })
      children.push({ name: property.streamName, data: property.data })
      continue
    }
    fail('aaf', `unknown property kind ${describeValue(property.kind)}`)
  }
  children.push({ name: 'properties', data: encodePropertyStream(properties) })
  return { name, clsid: object.classId, children }
}

/* --------------------------------------------------------------- builders -- */

/** A data-definition / container-definition object (a named AUID in the dictionary). */
function definitionObject (classId, auid, name, description) {
  return createObject(classId, [
    dataProperty(PID.definitionObjectName, aafString(name)),
    dataProperty(PID.definitionObjectDescription, aafString(description)),
    dataProperty(PID.definitionObjectIdentification, auidBytes(auid))
  ])
}

/** A data definition weak reference (components declare their kind this way). */
function dataDefinitionRef (auid) {
  return weakRef(PID.componentDataDefinition, DATA_DEFINITION_WEAKREF, PID.definitionObjectIdentification, auidBytes(auid))
}

/** One source clip, optionally pointing at a mob slot. */
function sourceClip ({ length, sourceMobId, sourceSlotId, start }) {
  return createObject(AAF_CLASS_IDS.SourceClip, [
    dataDefinitionRef(AAF_AUIDS.DataDefSound),
    dataProperty(PID.componentLength, i64(length)),
    dataProperty(PID.sourceClipSourceId, sourceMobId),
    dataProperty(PID.sourceClipSourceSlotId, u32(sourceSlotId)),
    dataProperty(PID.sourceClipStart, i64(start))
  ])
}

/** A timeline mob slot holding a segment, positioned at `origin` edit units. */
function timelineSlot ({ slotId, name, editRate, origin, segment }) {
  return createObject(AAF_CLASS_IDS.TimelineMobSlot, [
    dataProperty(PID.mobSlotSlotId, u32(slotId)),
    dataProperty(PID.mobSlotSlotName, aafString(name)),
    strongRef(PID.mobSlotSegment, 'Segment', segment),
    dataProperty(PID.timelineMobSlotEditRate, rational(editRate, 1)),
    dataProperty(PID.timelineMobSlotOrigin, i64(origin))
  ])
}

/** Common mob properties: id, name, creation/modification times, slots. */
function mobProperties ({ mobId, name, slots }) {
  return [
    dataProperty(PID.mobMobId, mobId),
    dataProperty(PID.mobName, aafString(name)),
    dataProperty(PID.mobLastModified, dateStruct()),
    dataProperty(PID.mobCreationTime, dateStruct()),
    strongRefVector(PID.mobSlots, 'Slots', slots)
  ]
}

/**
 * Pack entries into lanes so that no two clips in one lane overlap.
 *
 * AAF (like every timeline format with one sequence per track) cannot express
 * two clips at the same time inside one track, and neither can a Sequence. The
 * shared implementation lives in `lib/timeline.js` so every interop writer uses
 * the same lane definition.
 */
export { packLanes } from './timeline.js'

/* ---------------------------------------------------------------- timeline -- */

/** A PcmClip: the shape the AAF builder needs for one cue. */
function readClip (caller, entry, index, projectRate) {
  const label = `cue ${index + 1}`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(caller, `${label} must be an object`)
  const at = Number(entry.at ?? 0)
  const duration = Number(entry.duration)
  if (!Number.isFinite(at) || at < 0) fail(caller, `${label} at must be a non-negative number`)
  if (!Number.isFinite(duration) || duration <= 0) fail(caller, `${label} duration must be greater than 0`)
  const name = String(entry.name ?? '').trim() || `Cue ${index + 1}`
  const pcm = entry.pcm
  let rate = projectRate
  let channels = 1
  let bitDepth = 16
  let frames = 0
  if (pcm !== undefined && pcm !== null) {
    if (!Buffer.isBuffer(pcm.data)) fail(caller, `${label} pcm.data must be a Buffer`)
    rate = Number(pcm.sampleRate)
    channels = Number(pcm.channels ?? 1)
    bitDepth = Number(pcm.bitDepth ?? 16)
    if (!Number.isFinite(rate) || rate <= 0) fail(caller, `${label} pcm.sampleRate must be a positive number`)
    if (!Number.isInteger(channels) || channels < 1 || channels > 64) fail(caller, `${label} pcm.channels must be 1..64`)
    if (![8, 16, 24, 32].includes(bitDepth)) fail(caller, `${label} pcm.bitDepth must be 8, 16, 24 or 32`)
    const blockAlign = channels * (bitDepth / 8)
    if (pcm.data.length % blockAlign !== 0) {
      fail(caller, `${label} pcm.data is ${pcm.data.length} bytes, which is not a whole number of ${blockAlign} byte frames`)
    }
    frames = pcm.data.length / blockAlign
  }
  return { index, name, at, duration, gainDb: Number(entry.gainDb ?? 0), fadeIn: Number(entry.fadeIn ?? 0), fadeOut: Number(entry.fadeOut ?? 0), pcm, rate, channels, bitDepth, frames }
}

/* ----------------------------------------------------------------- export -- */

/**
 * Export a cue set as an AAF file.
 *
 * The object graph written:
 *
 * ```
 * /                     Root           (class b3b398a5鈥?
 *   MetaDictionary-1                    (empty: see the module comment)
 *   Header-2
 *     Dictionary-3b04                   (data / container definitions)
 *     Content-3b03
 *       Mobs-1901{0}                    CompositionMob  = the timeline
 *       Mobs-1901{1..n}                 MasterMob       = one per clip
 *       Mobs-1901{鈥                    SourceMob       = one per clip, with a PCMDescriptor
 *       EssenceData-1902{i}             embedded PCM frames, MobID 鈫?the SourceMob
 *   properties, referenced properties
 * ```
 *
 * The reference chain is one line, with both ends owned by the same SourceMob:
 * the composition names a MasterMob, the master names the SourceMob, the source
 * mob's own slot names itself at the full media length, and the EssenceData
 * names the SourceMob that carries the descriptor. `parseAaf` asserts exactly
 * that chain (see `validateAafGraph`), so a write whose mob ids disagree with
 * its samples fails its own read-back.
 *
 * @param {object} request
 * @param {Array<object>} request.cues - `[{ name, at, duration, path?, pcm?, gainDb?, fadeIn?, fadeOut? }]`.
 * @param {number} [request.sampleRate] - project edit rate; defaults to the first
 *   embedded clip's rate, else 48000.
 * @param {string} [request.title] - composition name; defaults to `dsh-audiokit timeline`.
 * @param {boolean} [request.embed] - embed PCM (default true when a clip has pcm).
 * @returns {object} `{ buffer, bytes, text, warnings, events, durationSeconds, ... }`
 */
export function exportAaf (request = {}) {
  const caller = 'aaf'
  if (!Array.isArray(request.cues) || request.cues.length === 0) {
    fail(caller, 'cues must be a non-empty array of { name, at, duration, path?, pcm? }')
  }
  if (request.cues.length > 20000) fail(caller, `${request.cues.length} cues exceeds the 20000 event limit`)
  const warnings = []

  // The project edit rate decides how timeline positions are counted. Audio
  // timelines are measured in samples, so the sample rate is the natural edit
  // rate; a caller can force one, and the first embedded clip supplies a
  // sensible default.
  let projectRate = Number(request.sampleRate ?? 0)
  if (!Number.isFinite(projectRate) || projectRate <= 0) {
    const firstPcm = request.cues.find((cue) => cue?.pcm !== undefined && cue?.pcm !== null)
    projectRate = firstPcm !== undefined && Number.isFinite(Number(firstPcm.pcm.sampleRate)) ? Number(firstPcm.pcm.sampleRate) : 48000
  }
  if (projectRate < 1000 || projectRate > 384000) fail(caller, `sampleRate must be between 1000 and 384000, got ${projectRate}`)

  const embed = request.embed !== false
  const embedLimit = Number.isFinite(Number(request.maxEmbedBytes)) ? Number(request.maxEmbedBytes) : MAX_EMBED_BYTES
  const clips = request.cues.map((entry, index) => readClip(caller, entry, index, projectRate))

  let embedBytes = 0
  for (const clip of clips) {
    if (clip.pcm === undefined) {
      warnings.push(`cue ${clip.index + 1} ("${clip.name}") has no pcm; it is written as an offline clip (length only, no essence)`)
      continue
    }
    if (!embed) {
      warnings.push(`cue ${clip.index + 1} ("${clip.name}") was written as an offline clip because embed is false`)
      continue
    }
    if (clip.rate !== projectRate) {
      warnings.push(`cue ${clip.index + 1} ("${clip.name}") is ${clip.rate} Hz while the project edit rate is ${projectRate} Hz; AAF would resample it on import, and the source mob keeps its own rate`)
    }
    embedBytes += clip.pcm.data.length
  }
  if (embedBytes > embedLimit) {
    fail(caller, `the embedded PCM is ${embedBytes} bytes, over the ${embedLimit} byte limit; raise maxEmbedBytes or pass embed: false to write an offline timeline`)
  }

  // ---- dictionary ---------------------------------------------------------
  const soundDefinition = definitionObject(AAF_CLASS_IDS.DataDefinition, AAF_AUIDS.DataDefSound, 'DataDef_Sound', 'Sound data')
  const dataDefinition = definitionObject(AAF_CLASS_IDS.DataDefinition, AAF_AUIDS.DataDefData, 'DataDef_Data', 'Data')
  const timecodeDefinition = definitionObject(AAF_CLASS_IDS.DataDefinition, AAF_AUIDS.DataDefTimecode, 'DataDef_Timecode', 'Timecode data')
  const containerAaf = definitionObject(AAF_CLASS_IDS.ContainerDefinition, AAF_AUIDS.ContainerDefAAF, 'ContainerDef_AAF', '')
  const containerWave = definitionObject(AAF_CLASS_IDS.ContainerDefinition, AAF_AUIDS.ContainerDefRIFFWAVE, 'ContainerDef_RIFFWAVE', '')
  const dictionary = createObject(AAF_CLASS_IDS.Dictionary, [
    strongRefVector(PID.dictionaryDataDefinitions, 'DataDefinitions', [soundDefinition, dataDefinition, timecodeDefinition], true),
    strongRefVector(PID.dictionaryContainerDefinitions, 'ContainerDefinitions', [containerAaf, containerWave], true),
    strongRefVector(PID.dictionaryCodecDefinitions, 'CodecDefinitions', [], true)
  ])

  // ---- one master mob, source mob and essence blob per clip ---------------
  const mobs = []
  const essenceItems = []
  const title = singleLineText(request.title) || 'dsh-audiokit timeline'
  const compositionMobId = umid('composition')
  for (const clip of clips) {
    const sourceRate = clip.pcm === undefined ? projectRate : clip.rate
    const sourceFrames = clip.pcm === undefined ? Math.round(clip.duration * sourceRate) : clip.frames
    const sourceMobId = umid(`source:${clip.index}:${clip.name}`)
    const masterMobId = umid(`master:${clip.index}:${clip.name}`)

    // The source mob owns the essence: a PCM descriptor plus the samples.
    const descriptor = createObject(AAF_CLASS_IDS.PCMDescriptor, [
      dataProperty(PID.fileDescriptorSampleRate, rational(sourceRate, 1)),
      dataProperty(PID.fileDescriptorLength, i64(sourceFrames)),
      dataProperty(PID.soundDescriptorQuantizationBits, u32(clip.bitDepth)),
      dataProperty(PID.soundDescriptorAudioSamplingRate, rational(sourceRate, 1)),
      dataProperty(PID.soundDescriptorChannels, u32(clip.channels)),
      dataProperty(PID.soundDescriptorAverageBps, u32(sourceRate * clip.channels * (clip.bitDepth / 8))),
      dataProperty(PID.soundDescriptorBlockAlign, u16(clip.channels * (clip.bitDepth / 8)))
    ])
    const sourceSlot = timelineSlot({
      slotId: 1,
      name: 'Source',
      editRate: sourceRate,
      origin: 0,
      // The source mob's own slot describes the media it owns: a clip of the
      // full media length that names this same mob, so both ends of the chain
      // (descriptor 鈫?essence and timeline 鈫?master 鈫?source) meet at one mob
      // instead of at an all-zero UMID.
      segment: sourceClip({ length: sourceFrames, sourceMobId, sourceSlotId: 1, start: 0 })
    })
    const sourceMob = createObject(AAF_CLASS_IDS.SourceMob, [
      ...mobProperties({ mobId: sourceMobId, name: `${clip.name}.PHYS`, slots: [sourceSlot] }),
      strongRef(PID.sourceMobEssenceDescription, 'EssenceDescription', descriptor)
    ])
    mobs.push(sourceMob)

    // The master mob is what the timeline references: one slot, one clip that
    // resolves down to the source mob.
    const masterSlot = timelineSlot({
      slotId: 1,
      name: clip.name,
      editRate: sourceRate,
      origin: 0,
      segment: sourceClip({ length: sourceFrames, sourceMobId, sourceSlotId: 1, start: 0 })
    })
    const masterMob = createObject(AAF_CLASS_IDS.MasterMob, mobProperties({ mobId: masterMobId, name: clip.name, slots: [masterSlot] }))
    mobs.push(masterMob)

    clip.masterMobId = masterMobId
    clip.masterRate = sourceRate
    clip.sourceFrames = sourceFrames

    if (clip.pcm !== undefined && embed) {
      essenceItems.push(createObject(AAF_CLASS_IDS.EssenceData, [
        // EssenceData names the mob that owns it: the SourceMob carrying the
        // PCMDescriptor, not the MasterMob the timeline references. A reader
        // resolves descriptor 鈫?essence through this property, so pointing it at
        // the master would leave the descriptor without its bytes.
        dataProperty(PID.essenceDataMobId, sourceMobId),
        streamProperty(PID.essenceDataData, 'Data-2702', clip.pcm.data)
      ]))
    }
  }

  // ---- the composition: lanes of Sequence(Filler, SourceClip, 鈥? ----------
  const lanes = packLanes(clips)
  const compositionSlots = lanes.map((lane, laneIndex) => {
    const components = []
    let cursor = 0
    for (const clip of lane) {
      const position = Math.round(clip.at * projectRate)
      const length = Math.max(1, Math.round(clip.duration * projectRate))
      if (position > cursor) {
        components.push(createObject(AAF_CLASS_IDS.Filler, [
          dataDefinitionRef(AAF_AUIDS.DataDefSound),
          dataProperty(PID.componentLength, i64(position - cursor))
        ]))
        cursor = position
      }
      components.push(sourceClip({ length, sourceMobId: clip.masterMobId, sourceSlotId: 1, start: 0 }))
      cursor = position + length
    }
    const sequence = createObject(AAF_CLASS_IDS.Sequence, [
      dataDefinitionRef(AAF_AUIDS.DataDefSound),
      dataProperty(PID.componentLength, i64(cursor)),
      strongRefVector(PID.sequenceComponents, 'Components', components)
    ])
    return timelineSlot({ slotId: laneIndex + 1, name: `Track ${laneIndex + 1}`, editRate: projectRate, origin: 0, segment: sequence })
  })

  const compositionMob = createObject(AAF_CLASS_IDS.CompositionMob, [
    ...mobProperties({ mobId: compositionMobId, name: title, slots: compositionSlots }),
    dataProperty(PID.mobUsageCode, auidBytes(AAF_AUIDS.UsageTopLevel))
  ])
  mobs.unshift(compositionMob)

  // ---- header, identification, content storage ----------------------------
  const identification = createObject(AAF_CLASS_IDS.Identification, [
    dataProperty(PID.identificationCompanyName, aafString(COMPANY_NAME)),
    dataProperty(PID.identificationProductName, aafString(PRODUCT_NAME)),
    dataProperty(PID.identificationProductVersionString, aafString(PRODUCT_VERSION)),
    dataProperty(PID.identificationProductId, auidBytes(PRODUCT_ID)),
    dataProperty(PID.identificationDate, dateStruct()),
    dataProperty(PID.identificationPlatform, aafString(process.platform)),
    dataProperty(PID.identificationGenerationAuid, derivedUuid(compositionMobId.toString('hex')))
  ])
  const contentStorage = createObject(AAF_CLASS_IDS.ContentStorage, [
    strongRefVector(PID.contentStorageMobs, 'Mobs', mobs, true),
    strongRefVector(PID.contentStorageEssenceData, 'EssenceData', essenceItems, true)
  ])

  const header = createObject(AAF_CLASS_IDS.Header, [
    dataProperty(PID.headerByteOrder, u16(0x4949)),
    dataProperty(PID.headerLastModified, dateStruct()),
    dataProperty(PID.headerVersion, Buffer.from([0x01, 0x02])),
    strongRefVector(PID.headerIdentificationList, 'IdentificationList', [identification]),
    dataProperty(PID.headerObjectModelVersion, u32(1)),
    dataProperty(PID.headerOperationalPattern, auidBytes(AAF_AUIDS.OperationalPattern1a)),
    strongRef(PID.headerContent, 'Content', contentStorage),
    strongRef(PID.headerDictionary, 'Dictionary', dictionary)
  ])
  const metaDictionary = createObject(AAF_CLASS_IDS.MetaDictionary, [])
  const root = createObject(AAF_CLASS_IDS.Root, [
    strongRef(PID.rootMetaDictionary, 'MetaDictionary', metaDictionary),
    strongRef(PID.rootHeader, 'Header', header)
  ])

  // ---- serialise to the container -----------------------------------------
  const tree = serializeObject(root, '')
  tree.children.push({ name: 'referenced properties', data: encodeReferencedProperties() })
  const buffer = writeCompoundFile({ clsid: AAF_CLASS_IDS.Root, children: tree.children })

  const durationSeconds = Math.max(0, ...clips.map((clip) => clip.at + clip.duration))
  const warningsOut = warnings.slice()
  if (!embed || embedBytes === 0) {
    warningsOut.push('no PCM was embedded: the file describes an offline timeline (media stays external)')
  }
  return {
    buffer,
    bytes: buffer.length,
    text: aafSummaryText({ clips, lanes, projectRate, embedBytes, buffer }),
    warnings: warningsOut,
    events: clips.length,
    durationSeconds: Math.round(durationSeconds * 1e6) / 1e6,
    sampleRate: projectRate,
    frames: Math.round(durationSeconds * projectRate),
    lanes: lanes.length,
    objects: mobs.length,
    embeddedBytes: embedBytes,
    importable: false,
    structure: {
      container: 'MS-CFB version 3',
      streamRoot: '/',
      classIds: { root: AAF_CLASS_IDS.Root, compositionMob: AAF_CLASS_IDS.CompositionMob },
      objectModel: 'AAF stored-object subset',
      metaDictionary: 'absent'
    }
  }
}

/** The one paragraph the tool result shows for an AAF export. */
function aafSummaryText ({ clips, lanes, projectRate, embedBytes, buffer }) {
  const size = `${(buffer.length / 1024).toFixed(1)} KB`
  return `AAF container: ${size}, ${clips.length} clip(s) in ${lanes.length} lane(s) at ${projectRate} Hz, ` +
    `${embedBytes} bytes of PCM embedded. ` +
    'This is a structural subset: Pro Tools, Media Composer and Resolve will refuse it while resolving the ' +
    'file\'s MetaDictionary (class definitions), which this writer does not emit. The container, class ids, ' +
    'property encodings, mob/slot graph and samples are real; use otio or xmeml for an importable timeline.'
}

/* ------------------------------------------------------------------ parse -- */

/** Read a strong-reference property: the storage name it points at. */
function readStrongRefName (data) {
  return readAafString(data)
}

/** Guard for the parser: a decoded property map entry, or undefined. */
function prop (object, pid) {
  return object.properties.get(pid)
}

/**
 * Parse an AAF file written by this module (and, structurally, any AAF whose
 * objects use the same built-in property ids).
 *
 * The parser is deliberately generic: it walks the container, decodes every
 * `properties` stream it finds, and then interprets the object graph it expects
 * (root 鈫?header 鈫?content storage 鈫?mobs 鈫?slots 鈫?sequences 鈫?clips). Object
 * classes are resolved from the CLSID of the storage, which is what makes the
 * round trip meaningful: the writer and the reader agree only if the class ids,
 * the property ids and the reference naming scheme are all correct.
 *
 * After decoding it asserts the essence-ownership chain (`validateAafGraph`):
 * every reference resolves to a mob in the file, every SourceMob's slot length
 * matches its descriptor, and the embedded bytes belong to the SourceMob that
 * describes them. A file whose graph disagrees with itself is thrown out instead
 * of returned as a parsed structure. That strictness makes this a validator of
 * the writer's contract rather than a general AAF reader: a file that uses AAF's
 * null-UMID convention for a source mob slot is refused, which is the point 鈥? * this module only ever claims to parse what it wrote.
 *
 * @param {Buffer} buffer - the AAF file bytes.
 * @returns {object} the parsed structure.
 */
export function parseAaf (buffer) {
  const caller = 'aaf'
  const container = readCompoundFile(buffer)

  /** Parse one storage into `{ name, path, classId, properties, children, streams }`. */
  const parseStorage = (node) => {
    const propertiesBuffer = node.children.find((child) => child.kind === 'stream' && child.name === 'properties')
    const streams = new Map()
    for (const child of node.children) {
      if (child.kind === 'stream' && child.name !== 'properties') streams.set(child.name, child.data)
    }
    let decoded = new Map()
    if (propertiesBuffer !== undefined) decoded = decodePropertyStream(propertiesBuffer.data).properties
    return {
      name: node.name,
      path: node.path,
      classId: node.clsid,
      properties: decoded,
      children: node.children.filter((child) => child.kind === 'storage').map(parseStorage),
      streams
    }
  }

  const rootNode = container.children
  const rootProperties = rootNode.find((child) => child.kind === 'stream' && child.name === 'properties')
  if (rootProperties === undefined) fail(caller, 'the root storage has no properties stream; this is not an AAF file')
  const root = {
    name: '',
    path: '/',
    classId: container.clsid,
    properties: decodePropertyStream(rootProperties.data).properties,
    children: rootNode.filter((child) => child.kind === 'storage').map(parseStorage),
    streams: new Map()
  }
  if (root.classId !== AAF_CLASS_IDS.Root) {
    fail(caller, `the root storage class is ${root.classId}, not the AAF root class ${AAF_CLASS_IDS.Root}`)
  }

  /** Find a child storage whose strong-reference property `pid` names it. */
  const strongChild = (object, pid) => {
    const property = prop(object, pid)
    if (property === undefined) return undefined
    const name = readStrongRefName(property.data)
    return object.children.find((child) => child.name === name)
  }

  /** Read a vector property into its child storages, in index order. */
  const vectorChildren = (object, pid) => {
    const property = prop(object, pid)
    if (property === undefined) return []
    const name = readAafString(property.data)
    const indexStream = object.streams.get(`${name} index`)
    if (indexStream === undefined) return []
    const keys = []
    for (let offset = 12; offset + 4 <= indexStream.length; offset += 4) keys.push(indexStream.readUInt32LE(offset))
    return keys
      .map((key) => object.children.find((child) => child.name === `${name}{${key.toString(16)}}`))
      .filter((child) => child !== undefined)
  }

  // ---- header -------------------------------------------------------------
  const headerObject = strongChild(root, PID.rootHeader)
  if (headerObject === undefined) fail(caller, 'the root object has no Header reference')
  const header = {
    classId: headerObject.classId,
    byteOrder: prop(headerObject, PID.headerByteOrder)?.data.readUInt16LE(0),
    version: prop(headerObject, PID.headerVersion) === undefined ? null : {
      major: prop(headerObject, PID.headerVersion).data.readUInt8(0),
      minor: prop(headerObject, PID.headerVersion).data.readUInt8(1)
    },
    objectModelVersion: prop(headerObject, PID.headerObjectModelVersion)?.data.readUInt32LE(0),
    operationalPattern: prop(headerObject, PID.headerOperationalPattern) === undefined
      ? null
      : auidToText(prop(headerObject, PID.headerOperationalPattern).data),
    lastModified: prop(headerObject, PID.headerLastModified) === undefined
      ? null
      : decodeDate(prop(headerObject, PID.headerLastModified).data),
    identification: [],
    content: null,
    dictionary: null
  }
  for (const identificationObject of vectorChildren(headerObject, PID.headerIdentificationList)) {
    header.identification.push({
      companyName: readOptionalString(identificationObject, PID.identificationCompanyName),
      productName: readOptionalString(identificationObject, PID.identificationProductName),
      productVersion: readOptionalString(identificationObject, PID.identificationProductVersionString),
      platform: readOptionalString(identificationObject, PID.identificationPlatform),
      productId: readOptionalAuid(identificationObject, PID.identificationProductId),
      generationId: prop(identificationObject, PID.identificationGenerationAuid) === undefined
        ? null
        : auidToText(prop(identificationObject, PID.identificationGenerationAuid).data)
    })
  }

  // ---- dictionary ---------------------------------------------------------
  const dictionaryObject = strongChild(headerObject, PID.headerDictionary)
  const dictionary = { dataDefinitions: [], containerDefinitions: [], codecDefinitions: [] }
  const readDefinitions = (pid, target) => {
    if (dictionaryObject === undefined) return
    for (const def of vectorChildren(dictionaryObject, pid)) {
      target.push({
        classId: def.classId,
        id: readOptionalAuid(def, PID.definitionObjectIdentification),
        name: readOptionalString(def, PID.definitionObjectName),
        description: readOptionalString(def, PID.definitionObjectDescription)
      })
    }
  }
  readDefinitions(PID.dictionaryDataDefinitions, dictionary.dataDefinitions)
  readDefinitions(PID.dictionaryContainerDefinitions, dictionary.containerDefinitions)
  readDefinitions(PID.dictionaryCodecDefinitions, dictionary.codecDefinitions)
  header.dictionary = dictionary

  // ---- content storage ----------------------------------------------------
  const contentObject = strongChild(headerObject, PID.headerContent)
  if (contentObject === undefined) fail(caller, 'the header has no ContentStorage reference')
  const mobs = []
  for (const mobObject of vectorChildren(contentObject, 0x1901)) {
    const mob = {
      classId: mobObject.classId,
      mobId: prop(mobObject, PID.mobMobId) === undefined ? null : umidToHex(prop(mobObject, PID.mobMobId).data),
      name: readOptionalString(mobObject, PID.mobName),
      usageCode: readOptionalAuid(mobObject, PID.mobUsageCode),
      slots: [],
      descriptor: null
    }
    const descriptorObject = strongChild(mobObject, PID.sourceMobEssenceDescription)
    if (descriptorObject !== undefined) {
      mob.descriptor = {
        classId: descriptorObject.classId,
        sampleRate: readOptionalRational(descriptorObject, PID.fileDescriptorSampleRate),
        length: readOptionalI64(descriptorObject, PID.fileDescriptorLength),
        channels: prop(descriptorObject, PID.soundDescriptorChannels)?.data.readUInt32LE(0) ?? null,
        quantizationBits: prop(descriptorObject, PID.soundDescriptorQuantizationBits)?.data.readUInt32LE(0) ?? null,
        blockAlign: prop(descriptorObject, PID.soundDescriptorBlockAlign)?.data.readUInt16LE(0) ?? null,
        averageBps: prop(descriptorObject, PID.soundDescriptorAverageBps)?.data.readUInt32LE(0) ?? null
      }
    }
    for (const slotObject of vectorChildren(mobObject, PID.mobSlots)) {
      const slot = {
        classId: slotObject.classId,
        slotId: prop(slotObject, PID.mobSlotSlotId)?.data.readUInt32LE(0) ?? null,
        name: readOptionalString(slotObject, PID.mobSlotSlotName),
        editRate: readOptionalRational(slotObject, PID.timelineMobSlotEditRate),
        origin: readOptionalI64(slotObject, PID.timelineMobSlotOrigin),
        segment: null
      }
      const segmentObject = strongChild(slotObject, PID.mobSlotSegment)
      if (segmentObject !== undefined) slot.segment = parseSegment(segmentObject)
      mob.slots.push(slot)
    }
    mobs.push(mob)
  }
  const essenceData = []
  for (const essenceObject of vectorChildren(contentObject, 0x1902)) {
    const streamName = prop(essenceObject, PID.essenceDataData) === undefined
      ? null
      : readAafString(prop(essenceObject, PID.essenceDataData).data.subarray(1))
    const stream = streamName === null ? undefined : essenceObject.streams.get(streamName)
    essenceData.push({
      classId: essenceObject.classId,
      mobId: prop(essenceObject, PID.essenceDataMobId) === undefined ? null : umidToHex(prop(essenceObject, PID.essenceDataMobId).data),
      dataStream: streamName,
      bytes: stream === undefined ? 0 : stream.length,
      data: stream === undefined ? Buffer.alloc(0) : stream
    })
  }

  /** Parse a segment object: a Sequence of components or a single SourceClip. */
  function parseSegment (segmentObject) {
    const base = {
      classId: segmentObject.classId,
      length: readOptionalI64(segmentObject, PID.componentLength)
    }
    if (segmentObject.classId === AAF_CLASS_IDS.SourceClip) {
      return {
        ...base,
        kind: 'sourceClip',
        sourceMobId: prop(segmentObject, PID.sourceClipSourceId) === undefined
          ? null
          : umidToHex(prop(segmentObject, PID.sourceClipSourceId).data),
        sourceSlotId: prop(segmentObject, PID.sourceClipSourceSlotId)?.data.readUInt32LE(0) ?? null,
        start: readOptionalI64(segmentObject, PID.sourceClipStart)
      }
    }
    if (segmentObject.classId === AAF_CLASS_IDS.Filler) return { ...base, kind: 'filler' }
    const components = vectorChildren(segmentObject, PID.sequenceComponents).map(parseSegment)
    return { ...base, kind: 'sequence', components }
  }

  // ---- the timeline, reconstructed from the composition mob ---------------
  const composition = mobs.find((mob) => mob.classId === AAF_CLASS_IDS.CompositionMob)
  const timeline = { editRate: projectRateOf(composition), tracks: [] }
  if (composition !== undefined) {
    composition.slots.forEach((slot, slotIndex) => {
      const track = { name: slot.name ?? `Track ${slotIndex + 1}`, slotId: slot.slotId, clips: [] }
      if (slot.segment !== null && slot.segment.kind === 'sequence') {
        let cursor = slot.origin ?? 0
        for (const component of slot.segment.components) {
          if (component.kind === 'filler') {
            cursor += component.length ?? 0
            continue
          }
          if (component.kind === 'sourceClip') {
            track.clips.push({
              at: cursor / timeline.editRate,
              duration: (component.length ?? 0) / timeline.editRate,
              sourceMobId: component.sourceMobId,
              sourceStart: component.start ?? 0
            })
            cursor += component.length ?? 0
          }
        }
      } else if (slot.segment !== null && slot.segment.kind === 'sourceClip') {
        track.clips.push({
          at: (slot.origin ?? 0) / timeline.editRate,
          duration: (slot.segment.length ?? 0) / timeline.editRate,
          sourceMobId: slot.segment.sourceMobId,
          sourceStart: slot.segment.start ?? 0
        })
      }
      timeline.tracks.push(track)
    })
  }

  // Resolve each timeline clip's track back to a master mob name, which is the
  // cue name the writer was given.
  const mobById = new Map(mobs.filter((mob) => mob.mobId !== null).map((mob) => [mob.mobId, mob]))
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const master = mobById.get(clip.sourceMobId)
      clip.name = master === undefined ? null : master.name
    }
  }

  const parsed = {
    container: {
      version: container.version,
      sectorSize: container.sectorSize,
      bytes: container.size,
      sectors: container.sectors,
      storages: container.list.filter((node) => node.kind === 'storage').length,
      streams: container.list.filter((node) => node.kind === 'stream').length,
      warnings: container.warnings
    },
    rootClassId: root.classId,
    header,
    dictionary,
    content: { mobs, essenceData },
    timeline
  }
  // A file whose mob ids and descriptors do not form one chain is not "parsed":
  // it is a graph a reader would fail to resolve. Refuse it here so the writer's
  // self-check cannot report a broken export as verified.
  return validateAafGraph(parsed)
}

/* ------------------------------------------------------ graph validation -- */

/** Hex form of the null UMID: 32 zero bytes, AAF's "no mob" value. */
const ZERO_UMID_HEX = '0'.repeat(64)

/** Human label for a mob in a validation error. */
function describeMob (mob) {
  const kind = mob.classId === AAF_CLASS_IDS.SourceMob
    ? 'source mob'
    : mob.classId === AAF_CLASS_IDS.MasterMob
      ? 'master mob'
      : mob.classId === AAF_CLASS_IDS.CompositionMob ? 'composition mob' : 'mob'
  return `${kind} ${JSON.stringify(mob.name)}`
}

/** Every SourceClip inside a segment, outermost first, including sequences. */
function collectSourceClips (segment, found = []) {
  if (segment === null || segment === undefined) return found
  if (segment.kind === 'sourceClip') found.push(segment)
  if (Array.isArray(segment.components)) {
    for (const component of segment.components) collectSourceClips(component, found)
  }
  return found
}

/**
 * Assert the essence-ownership chain an exported AAF has to carry.
 *
 * The writer's contract 鈥?and what a reader resolves on import 鈥?is one chain
 * with both ends on the same mob:
 *
 * ```
 * CompositionMob slot 鈹€鈹€SourceClip鈹€鈹€鈻?MasterMob    (one per cue)
 * MasterMob slot      鈹€鈹€SourceClip鈹€鈹€鈻?SourceMob    (the media)
 * SourceMob slot      鈹€鈹€SourceClip鈹€鈹€鈻?itself       (length = media frames)
 * SourceMob.EssenceDescription 鈹€鈹€鈹€鈹€鈹€鈻?PCMDescriptor (length = media frames)
 * EssenceData.MobID   鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈻?that SourceMob (the one with the descriptor)
 * ```
 *
 * Two failures are possible in a hand-written subset and both are checked here:
 * the EssenceData names a mob whose descriptor is elsewhere (essence with no
 * owner), or a SourceMob slot is a placeholder of length 0 with an all-zero UMID
 * (a chain that dead-ends). A null UMID is never legal in this file: it means
 * "no mob", and every reference here is supposed to resolve.
 *
 * @param {object} parsed - the structure `parseAaf` produced.
 * @returns {object} the same structure, so this can be used inline.
 */
export function validateAafGraph (parsed) {
  const caller = 'aaf'
  const content = parsed === null || typeof parsed !== 'object' ? undefined : parsed.content
  if (content === undefined || !Array.isArray(content.mobs) || !Array.isArray(content.essenceData)) {
    fail(caller, 'the graph has no mob / essence table to validate')
  }
  const mobs = content.mobs
  const byId = new Map()
  for (const mob of mobs) {
    if (mob.mobId === null) fail(caller, `a mob named ${JSON.stringify(mob.name)} has no MobID property`)
    if (mob.mobId === ZERO_UMID_HEX) fail(caller, `a mob named ${JSON.stringify(mob.name)} carries the null UMID (32 zero bytes)`)
    if (byId.has(mob.mobId)) fail(caller, `two mobs share the UMID ${mob.mobId}`)
    byId.set(mob.mobId, mob)
  }

  /** Resolve a clip's source mob id, refusing the null UMID and dangling ids. */
  const requireOwner = (mobId, label) => {
    if (mobId === null) fail(caller, `${label} has no source mob id`)
    if (mobId === ZERO_UMID_HEX) fail(caller, `${label} points at the null UMID (32 zero bytes)`)
    const owner = byId.get(mobId)
    if (owner === undefined) fail(caller, `${label} points at mob ${mobId.slice(0, 16)}鈥?which is not in the file`)
    return owner
  }

  // 1. Every clip in every mob slot names a real, non-null mob.
  for (const mob of mobs) {
    for (const slot of mob.slots) {
      for (const clip of collectSourceClips(slot.segment)) {
        requireOwner(clip.sourceMobId, `${describeMob(mob)} slot ${slot.slotId} source clip`)
      }
    }
  }

  // 2. A SourceMob owns a descriptor, and its slot chain has the media length
  //    and points back at the mob that owns that descriptor (itself).
  const sourceMobs = mobs.filter((mob) => mob.classId === AAF_CLASS_IDS.SourceMob)
  for (const mob of sourceMobs) {
    const label = describeMob(mob)
    if (mob.descriptor === null) fail(caller, `${label} has no PCMDescriptor`)
    const length = mob.descriptor.length
    if (length === null) fail(caller, `${label} descriptor has no length`)
    if (mob.slots.length === 0) fail(caller, `${label} has no slot to describe its media`)
    for (const slot of mob.slots) {
      const clips = collectSourceClips(slot.segment)
      if (clips.length === 0) fail(caller, `${label} slot ${slot.slotId} carries no source clip`)
      for (const clip of clips) {
        if (clip.length !== length) {
          fail(caller, `${label} slot ${slot.slotId} source clip length ${clip.length} disagrees with descriptor length ${length}`)
        }
        const owner = requireOwner(clip.sourceMobId, `${label} slot ${slot.slotId} source clip`)
        if (owner !== mob) {
          fail(caller, `${label} slot ${slot.slotId} source clip points at ${describeMob(owner)} instead of the source mob itself`)
        }
      }
    }
  }

  // 3. A MasterMob references a SourceMob that actually has a descriptor.
  for (const mob of mobs.filter((candidate) => candidate.classId === AAF_CLASS_IDS.MasterMob)) {
    const label = describeMob(mob)
    const clips = mob.slots.flatMap((slot) => collectSourceClips(slot.segment))
    if (clips.length === 0) fail(caller, `${label} has no source clip`)
    for (const clip of clips) {
      const owner = requireOwner(clip.sourceMobId, `${label} source clip`)
      if (owner.descriptor === null) fail(caller, `${label} source clip points at ${describeMob(owner)}, which has no descriptor`)
    }
  }

  // 4. The composition's timeline references the master mobs.
  if (parsed.timeline === undefined) fail(caller, 'the graph has no timeline to validate')
  for (const clip of parsed.timeline.tracks.flatMap((track) => track.clips)) {
    const owner = requireOwner(clip.sourceMobId, `timeline clip ${JSON.stringify(clip.name)}`)
    if (owner.classId !== AAF_CLASS_IDS.MasterMob) {
      fail(caller, `timeline clip ${JSON.stringify(clip.name)} points at ${describeMob(owner)}, which is not a master mob`)
    }
  }

  // 5. Essence belongs to the SourceMob that carries the descriptor, and its
  //    byte count is the descriptor's frame count times its block alignment.
  for (const item of content.essenceData) {
    const owner = requireOwner(item.mobId, 'essence data')
    if (owner.classId !== AAF_CLASS_IDS.SourceMob) {
      fail(caller, `essence data names ${describeMob(owner)}, which is not a source mob (essence belongs to the mob with the descriptor)`)
    }
    if (owner.descriptor === null) fail(caller, `essence data names ${describeMob(owner)}, which has no descriptor`)
    const { length, blockAlign } = owner.descriptor
    if (length !== null && blockAlign !== null && item.bytes !== length * blockAlign) {
      fail(caller, `essence data names ${describeMob(owner)} but holds ${item.bytes} bytes; its descriptor describes ${length} frame(s) of ${blockAlign} byte(s)`)
    }
  }

  return parsed
}

/* ------------------------------------------------------------- parse utils -- */

function decodeDate (data) {
  return {
    year: data.readUInt16LE(0),
    month: data.readUInt8(2),
    day: data.readUInt8(3),
    hour: data.readUInt8(4),
    minute: data.readUInt8(5),
    second: data.readUInt8(6),
    fraction: data.readUInt8(7)
  }
}

function readOptionalString (object, pid) {
  const property = prop(object, pid)
  return property === undefined ? null : readAafString(property.data)
}

function readOptionalAuid (object, pid) {
  const property = prop(object, pid)
  return property === undefined ? null : auidToText(property.data)
}

function readOptionalI64 (object, pid) {
  const property = prop(object, pid)
  return property === undefined ? null : Number(property.data.readBigInt64LE(0))
}

function readOptionalRational (object, pid) {
  const property = prop(object, pid)
  if (property === undefined) return null
  const numerator = property.data.readUInt32LE(0)
  const denominator = property.data.readUInt32LE(4)
  return denominator === 0 ? null : numerator / denominator
}

/** The edit rate of a composition's first slot, defaulting to 48000. */
function projectRateOf (composition) {
  if (composition === undefined) return 48000
  const slot = composition.slots.find((candidate) => candidate.editRate !== null && candidate.editRate !== undefined)
  return slot === undefined ? 48000 : slot.editRate
}

function umidToHex (buffer) {
  return Buffer.from(buffer).toString('hex')
}
