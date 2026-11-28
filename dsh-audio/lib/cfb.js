/**
 * MS-CFB (Compound File Binary) — the container every AAF and OMF file is
 * built on, written and read from scratch with Node built-ins only.
 *
 * Why this module exists: AAF and OMF are not single-blob formats. They are
 * Structured Storage documents ([MS-CFB], the format behind `.doc`, `.xls` and
 * `.msi`) whose tree of storages and streams carries the object model. A plugin
 * that cannot write that container cannot write an AAF at all, and a plugin
 * that cannot read it back cannot prove what it wrote.
 *
 * Scope, stated plainly:
 *
 * - Writer: version 3 (512-byte sectors) with a normal FAT, a mini stream plus
 *   mini FAT for streams under 4096 bytes, and DIFAT sectors when a document
 *   outgrows the 109 FAT pointers the header carries.
 * - Reader: version 3 and version 4 (4096-byte sectors), so a container written
 *   by another tool can be inspected. That is how the AAF writer is checked
 *   against a reference implementation instead of only against itself.
 * - Directory: one red-black tree per storage, built with the textbook insert
 *   (recolour on the way up, rotations that move links but never colours),
 *   ordered by the CFB rule (shorter names first, then case-insensitive).
 *   Names arrive in sorted order, which is the worst case for an unbalanced
 *   tree, so the rebalancing is what keeps a storage with n children at
 *   O(log n) depth instead of a chain of n.
 * - Determinism: no clock, no `Math.random`, no locale. Timestamps are written
 *   as zero — the format's own "no time recorded" value — so the same tree
 *   always produces the same bytes.
 *
 * The reader validates as it goes (signature, sector size, FAT chains, chain
 * loops, mini stream bounds, directory ordering) and throws the one error shape
 * this plugin uses, so a corrupt container is reported rather than misparsed.
 */

/* --------------------------------------------------------------- constants -- */

/** First 8 bytes of every CFB document. */
const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Sector size for version 3 files; the reader also accepts version 4. */
const SECTOR_SIZE_V3 = 512
const SECTOR_SIZE_V4 = 4096

/** Streams below this size live in the mini stream, in 64-byte units. */
const MINI_STREAM_CUTOFF = 4096
const MINI_SECTOR_SIZE = 64

/** FAT values that do not name a sector. */
const FREESECT = 0xffffffff
const ENDOFCHAIN = 0xfffffffe
const FATSECT = 0xfffffffd
const DIFSECT = 0xfffffffc
const MAXREGSECT = 0xfffffffa

/** Directory entry object types. */
const TYPE_STORAGE = 1
const TYPE_STREAM = 2
const TYPE_ROOT = 5

/** Directory entry color flags. */
const COLOR_RED = 0
const COLOR_BLACK = 1

/** Directory entry id meaning "no entry". */
const NO_ENTRY = 0xffffffff

/** Header field offsets, named so reader and writer agree by symbol. */
const HEADER = Object.freeze({
  signature: 0x00,
  clsid: 0x08,
  minorVersion: 0x18,
  majorVersion: 0x1a,
  byteOrder: 0x1c,
  sectorShift: 0x1e,
  miniSectorShift: 0x20,
  dirSectorCount: 0x28,
  fatSectorCount: 0x2c,
  firstDirSector: 0x30,
  transactionSignature: 0x34,
  miniStreamCutoff: 0x38,
  firstMiniFatSector: 0x3c,
  miniFatSectorCount: 0x40,
  firstDifatSector: 0x44,
  difatSectorCount: 0x48,
  difat: 0x4c
})

/** Directory entry field offsets. */
const ENTRY = Object.freeze({
  name: 0x00,
  nameLength: 0x40,
  objectType: 0x42,
  color: 0x43,
  left: 0x44,
  right: 0x48,
  child: 0x4c,
  clsid: 0x50,
  stateBits: 0x60,
  creationTime: 0x64,
  modifiedTime: 0x6c,
  startSector: 0x74,
  streamSize: 0x78,
  size: 128
})

/** FAT sector numbers the header holds before DIFAT sectors are needed. */
const DIFAT_ENTRIES_IN_HEADER = 109

/** A hard ceiling, so a malformed FAT cannot make the reader loop forever. */
const MAX_SECTOR_COUNT = 1 << 22

/* ----------------------------------------------------------------- errors -- */

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

/** Throw the one error shape this module reports: `<caller>: <what is wrong>`. */
function fail (caller, message) {
  throw new Error(`${caller}: ${message}`)
}

/* -------------------------------------------------------------- utilities -- */

/** Round `value` up to a multiple of `unit` (non-negative integers). */
function roundUp (value, unit) {
  return Math.ceil(value / unit) * unit
}

/**
 * Read a 16-byte CLSID from either a Buffer or the canonical GUID text.
 *
 * The layout is the mixed-endian one Microsoft containers and AAF class
 * identifiers share: data1/data2/data3 little-endian, the trailing 8 bytes as
 * written. `null`/`undefined` means "no class" and becomes sixteen zeros.
 *
 * @param {string} caller - error prefix.
 * @param {string} label - field name for the error message.
 * @param {Buffer|string|null|undefined} value
 * @returns {Buffer} 16 bytes in mixed-endian order.
 */
function readClsid (caller, label, value) {
  if (value === undefined || value === null) return Buffer.alloc(16)
  if (Buffer.isBuffer(value)) {
    if (value.length !== 16) fail(caller, `${label} must be a 16 byte CLSID, got ${value.length} bytes`)
    return Buffer.from(value)
  }
  if (typeof value !== 'string') fail(caller, `${label} must be a CLSID string or a 16 byte Buffer, got ${describeValue(value)}`)
  const hex = value.trim().toLowerCase().replace(/[{}-]/g, '')
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    fail(caller, `${label} must be a GUID such as 0d010101-0101-2f00-060e-2b3402060101, got ${describeValue(value)}`)
  }
  const be = Buffer.from(hex, 'hex')
  return Buffer.from([
    be[3], be[2], be[1], be[0],
    be[5], be[4],
    be[7], be[6],
    be[8], be[9], be[10], be[11], be[12], be[13], be[14], be[15]
  ])
}

/** Inverse of `readClsid`: canonical GUID text of 16 mixed-endian bytes. */
export function clsidToString (bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) fail('cfb', 'clsidToString needs a 16 byte Buffer')
  const be = Buffer.from([
    bytes[3], bytes[2], bytes[1], bytes[0],
    bytes[5], bytes[4],
    bytes[7], bytes[6],
    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
  ])
  const hex = be.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** UTF-16LE name bytes, including the trailing NUL the length field counts. */
function utf16NameBytes (name) {
  return Buffer.from(`${name}\u0000`, 'utf16le')
}

/**
 * The CFB sort order for directory names: shorter first, then case-insensitive.
 *
 * This is deliberately not the byte order of the names: a container whose
 * siblings are sorted bytewise is invalid, and readers that walk the tree
 * assume the order holds.
 */
export function compareDirectoryNames (left, right) {
  const a = String(left)
  const b = String(right)
  if (a.length !== b.length) return a.length - b.length
  const upA = a.toUpperCase()
  const upB = b.toUpperCase()
  if (upA === upB) return 0
  return upA < upB ? -1 : 1
}

/* ------------------------------------------------------------ tree input -- */

/**
 * Normalise the caller's tree into a flat entry list.
 *
 * Accepted node shapes, deliberately minimal so an invalid container cannot be
 * described:
 *
 * - `{ name, children: [...] }` — a storage (directory), optional `clsid`;
 * - `{ name, data: Buffer }` — a stream.
 *
 * The root node is `{ clsid?, children: [...] }`. Input order is irrelevant:
 * siblings are sorted into CFB order by the writer, so a caller listing streams
 * alphabetically and one listing them by importance get the same file.
 *
 * @param {object} root
 * @returns {object[]} entries, root first.
 */
function flattenTree (root) {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    fail('cfb', 'the root node must be an object with a children array')
  }
  if (!Array.isArray(root.children)) fail('cfb', 'the root node must be a storage (it needs a children array)')
  const entries = [{
    id: 0,
    kind: 'root',
    name: '',
    clsid: readClsid('cfb', 'root clsid', root.clsid),
    children: [],
    data: null,
    left: NO_ENTRY,
    right: NO_ENTRY,
    child: NO_ENTRY,
    color: COLOR_BLACK,
    startSector: ENDOFCHAIN,
    streamSize: 0
  }]
  const seen = new Set()

  const visit = (node, parentId, path) => {
    const siblings = new Set()
    for (const child of node.children) {
      if (child === null || typeof child !== 'object' || Array.isArray(child)) {
        fail('cfb', `${path} has a child that is not an object`)
      }
      const name = typeof child.name === 'string' ? child.name : ''
      if (name === '') fail('cfb', `${path} has a child with no name`)
      // A name is how a reader resolves an entry, so duplicates would make the
      // tree ambiguous. Refuse them here instead of writing a file two readers
      // would open differently.
      if (siblings.has(name.toUpperCase())) fail('cfb', `${path} has two children named ${JSON.stringify(name)}`)
      siblings.add(name.toUpperCase())
      const childPath = `${path}/${name}`
      if (seen.has(childPath.toUpperCase())) fail('cfb', `duplicate path ${childPath}`)
      seen.add(childPath.toUpperCase())
      const isStream = Buffer.isBuffer(child.data)
      if (isStream && Array.isArray(child.children) && child.children.length > 0) {
        fail('cfb', `${childPath} is both a stream and a storage`)
      }
      if (!isStream && !Array.isArray(child.children)) {
        fail('cfb', `${childPath} is neither a stream (data: Buffer) nor a storage (children: [])`)
      }
      const entry = {
        id: entries.length,
        kind: isStream ? 'stream' : 'storage',
        name,
        clsid: isStream ? Buffer.alloc(16) : readClsid('cfb', `${childPath} clsid`, child.clsid),
        children: [],
        data: isStream ? child.data : null,
        left: NO_ENTRY,
        right: NO_ENTRY,
        child: NO_ENTRY,
        color: COLOR_BLACK,
        startSector: ENDOFCHAIN,
        streamSize: 0
      }
      entries.push(entry)
      entries[parentId].children.push(entry.id)
      if (!isStream) visit(child, entry.id, childPath)
    }
  }

  visit(root, 0, '')
  return entries
}

/* --------------------------------------------------- red-black directory -- */

/**
 * Build one storage's child directory as a valid red-black tree.
 *
 * The directory is not a flat list: each storage's children form a red-black
 * tree hanging off the storage's `child` pointer. A reader that walks it
 * compares names with the CFB ordering rule, so the tree must be a correct
 * binary search tree *and* satisfy the red-black invariants (equal black
 * height, no red-red edge, black root).
 *
 * The insert is the textbook one (CLRS): the new node is red, and the fix-up
 * recolours the parent black and the grandparent red while climbing when the
 * uncle is red, or rotates once or twice for the black-uncle case. A rotation
 * only moves links and never changes a colour; the recolouring is what restores
 * the black height.
 *
 * Why this matters: siblings are inserted in CFB order (ascending), which is the
 * worst case for a plain binary search tree. An earlier version rotated and
 * recoloured in the same step and never linked the promoted node back into its
 * grandparent, so a storage with n children came out as a chain of depth n —
 * a linear name lookup in every directory. The invariants asserted by the tests
 * (black height, no red-red edge, bounded depth) are exactly what that broke.
 *
 * Nodes are inserted in CFB order, so the result depends only on the set of
 * names: that is part of what makes the written bytes stable.
 *
 * @param {object[]} entries - the full entry list.
 * @param {number} parentId - the storage whose `child` pointer this sets.
 * @returns {number} the tree's root entry id (`NO_ENTRY` when empty).
 */
function buildDirectoryTree (entries, parentId) {
  const siblings = entries[parentId].children
    .map((id) => entries[id])
    .sort((left, right) => compareDirectoryNames(left.name, right.name))
  if (siblings.length === 0) {
    entries[parentId].child = NO_ENTRY
    return NO_ENTRY
  }

  const before = (left, right) => compareDirectoryNames(left.entry.name, right.entry.name) < 0
  const isRed = (node) => node !== null && node.red === true

  let root = null

  /**
   * Point the link that used to hold `previous` at `next`.
   *
   * A rotation happens below an arbitrary parent, so the promoted node has to be
   * written back into that parent's left/right pointer — or into `root` when the
   * rotated node was the root. Forgetting this is what detached subtrees.
   */
  const replaceChild = (parent, previous, next) => {
    if (parent === null) root = next
    else if (parent.left === previous) parent.left = next
    else if (parent.right === previous) parent.right = next
    else fail('cfb', 'a directory rotation lost its parent link')
  }

  /** Rotate `node`'s right child up; returns the new subtree root. Colour is kept. */
  const rotateLeft = (node) => {
    const next = node.right
    node.right = next.left
    if (next.left !== null) next.left.parent = node
    next.parent = node.parent
    replaceChild(next.parent, node, next)
    next.left = node
    node.parent = next
    return next
  }

  /** Rotate `node`'s left child up; returns the new subtree root. Colour is kept. */
  const rotateRight = (node) => {
    const next = node.left
    node.left = next.right
    if (next.right !== null) next.right.parent = node
    next.parent = node.parent
    replaceChild(next.parent, node, next)
    next.right = node
    node.parent = next
    return next
  }

  /** CLRS RB-INSERT-FIXUP: restore the red-black invariants after an insert. */
  const insertFixup = (node) => {
    while (node.parent !== null && node.parent.red === true) {
      const parent = node.parent
      const grand = parent.parent
      // A red parent cannot be the root (the root is black between inserts), so
      // the grandparent exists. The guard keeps the invariant explicit.
      if (grand === null) break
      if (parent === grand.left) {
        const uncle = grand.right
        if (isRed(uncle)) {
          // Red uncle: recolour and climb; the rotation case cannot apply here.
          parent.red = false
          uncle.red = false
          grand.red = true
          node = grand
          continue
        }
        if (node === parent.right) {
          node = parent
          rotateLeft(node)
        }
        node.parent.red = false
        node.parent.parent.red = true
        rotateRight(node.parent.parent)
      } else {
        const uncle = grand.left
        if (isRed(uncle)) {
          parent.red = false
          uncle.red = false
          grand.red = true
          node = grand
          continue
        }
        if (node === parent.left) {
          node = parent
          rotateRight(node)
        }
        node.parent.red = false
        node.parent.parent.red = true
        rotateLeft(node.parent.parent)
      }
    }
    root.red = false
  }

  for (const entry of siblings) {
    const leaf = { entry, left: null, right: null, parent: null, red: true }
    if (root === null) {
      root = leaf
      root.red = false
      continue
    }
    // Plain BST descend, then rebalance from the new leaf.
    let parent = null
    let current = root
    while (current !== null) {
      parent = current
      current = before(leaf, current) ? current.left : current.right
    }
    leaf.parent = parent
    if (before(leaf, parent)) parent.left = leaf
    else parent.right = leaf
    insertFixup(leaf)
  }

  // Serialise the links back onto the entries: left/right ids and colors, with
  // the tree root becoming the storage's `child` pointer.
  const write = (node) => {
    const entry = node.entry
    entry.left = node.left === null ? NO_ENTRY : node.left.entry.id
    entry.right = node.right === null ? NO_ENTRY : node.right.entry.id
    entry.color = node.red === true ? COLOR_RED : COLOR_BLACK
    if (node.left !== null) write(node.left)
    if (node.right !== null) write(node.right)
  }
  write(root)
  entries[parentId].child = root.entry.id
  return root.entry.id
}

/* -------------------------------------------------------------- the writer -- */

/**
 * Serialise a tree of storages and streams as an MS-CFB document.
 *
 * Sector layout, in allocation order:
 *
 * 1. regular stream sectors (streams of 4096 bytes or more),
 * 2. the mini stream — one stream holding every small stream, 64-byte aligned,
 * 3. the mini FAT (chain map for the mini stream, one entry per 64-byte unit),
 * 4. the directory sectors,
 * 5. the FAT sectors,
 * 6. DIFAT sectors, only when the FAT itself needs more than 109 sectors.
 *
 * @param {object} tree - root `{ clsid?, children: [...] }`.
 * @returns {Buffer} document bytes.
 */
export function writeCompoundFile (tree) {
  const entries = flattenTree(tree)
  const sectorSize = SECTOR_SIZE_V3

  // ---- split streams into mini and regular, and lay out the mini stream ----
  const miniChunks = []
  let miniOffset = 0
  const regularStreams = []
  for (const entry of entries) {
    if (entry.kind !== 'stream') continue
    entry.streamSize = entry.data.length
    if (entry.data.length === 0) {
      entry.startSector = ENDOFCHAIN
      continue
    }
    if (entry.data.length < MINI_STREAM_CUTOFF) {
      const offset = roundUp(miniOffset, MINI_SECTOR_SIZE)
      entry.miniStart = offset / MINI_SECTOR_SIZE
      miniChunks.push({ entry, offset })
      miniOffset = offset + roundUp(entry.data.length, MINI_SECTOR_SIZE)
    } else {
      regularStreams.push(entry)
    }
  }

  // ---- mini FAT: one 4-byte entry per 64-byte mini sector ------------------
  const miniFat = []
  for (const chunk of miniChunks) {
    const count = Math.ceil(chunk.entry.data.length / MINI_SECTOR_SIZE)
    const start = chunk.entry.miniStart
    for (let index = 0; index < count; index += 1) miniFat.push(index === count - 1 ? ENDOFCHAIN : start + index + 1)
    chunk.entry.startSector = start
  }
  const miniFatSectors = Math.ceil((miniFat.length * 4) / sectorSize)
  // The mini stream is declared at the size its mini FAT sectors advertise, not
  // at the bytes actually used. A reader that sizes the mini stream from the
  // mini FAT (the reference implementation warns when the two disagree) then
  // computes the same number, and the unused tail is zeros.
  const miniStreamSize = miniFatSectors === 0
    ? 0
    : Math.max(miniOffset, miniFatSectors * (sectorSize / 4) * MINI_SECTOR_SIZE)

  // ---- allocate sectors; `fat` grows one entry per allocated sector --------
  const fat = []
  const allocate = (count) => {
    const start = fat.length
    for (let index = 0; index < count; index += 1) fat.push(index === count - 1 ? ENDOFCHAIN : start + index + 1)
    return start
  }
  for (const entry of regularStreams) {
    entry.startSector = allocate(Math.ceil(entry.data.length / sectorSize))
  }
  let miniStreamStart = ENDOFCHAIN
  if (miniStreamSize > 0) {
    miniStreamStart = allocate(Math.ceil(miniStreamSize / sectorSize))
  }
  const firstMiniFatSector = miniFatSectors > 0 ? allocate(miniFatSectors) : ENDOFCHAIN

  // ---- directory sectors ---------------------------------------------------
  const dirSectors = Math.ceil((entries.length * ENTRY.size) / sectorSize)
  const firstDirSector = allocate(dirSectors)
  const dataSectorCount = fat.length

  // ---- FAT size, solved with the DIFAT sectors it implies ------------------
  let fatSectors = 0
  let difatSectors = 0
  for (let guard = 0; guard < 16; guard += 1) {
    const total = dataSectorCount + fatSectors + difatSectors
    const neededFat = Math.ceil(total / (sectorSize / 4))
    const neededDifat = neededFat > DIFAT_ENTRIES_IN_HEADER
      ? Math.ceil((neededFat - DIFAT_ENTRIES_IN_HEADER) / (sectorSize / 4 - 1))
      : 0
    if (neededFat === fatSectors && neededDifat === difatSectors) break
    fatSectors = neededFat
    difatSectors = neededDifat
  }
  const fatSectorStart = dataSectorCount + difatSectors
  const totalSectors = dataSectorCount + difatSectors + fatSectors
  if (fatSectors * (sectorSize / 4) < totalSectors) fail('cfb', 'the FAT size did not converge')

  const fatTable = new Array(totalSectors).fill(FREESECT)
  for (let index = 0; index < fat.length; index += 1) fatTable[index] = fat[index]
  for (let index = 0; index < difatSectors; index += 1) fatTable[dataSectorCount + index] = DIFSECT
  for (let index = 0; index < fatSectors; index += 1) fatTable[fatSectorStart + index] = FATSECT

  const buffer = Buffer.alloc(sectorSize + totalSectors * sectorSize)
  const sectorOffset = (index) => sectorSize + index * sectorSize

  // ---- header --------------------------------------------------------------
  SIGNATURE.copy(buffer, HEADER.signature)
  buffer.writeUInt16LE(0x003e, HEADER.minorVersion)
  buffer.writeUInt16LE(0x0003, HEADER.majorVersion)
  buffer.writeUInt16LE(0xfffe, HEADER.byteOrder)
  buffer.writeUInt16LE(9, HEADER.sectorShift)
  buffer.writeUInt16LE(6, HEADER.miniSectorShift)
  buffer.writeUInt32LE(0, HEADER.dirSectorCount)
  buffer.writeUInt32LE(fatSectors, HEADER.fatSectorCount)
  buffer.writeUInt32LE(firstDirSector, HEADER.firstDirSector)
  buffer.writeUInt32LE(0, HEADER.transactionSignature)
  buffer.writeUInt32LE(MINI_STREAM_CUTOFF, HEADER.miniStreamCutoff)
  buffer.writeUInt32LE(firstMiniFatSector, HEADER.firstMiniFatSector)
  buffer.writeUInt32LE(miniFatSectors, HEADER.miniFatSectorCount)
  buffer.writeUInt32LE(difatSectors > 0 ? dataSectorCount : ENDOFCHAIN, HEADER.firstDifatSector)
  buffer.writeUInt32LE(difatSectors, HEADER.difatSectorCount)

  // ---- DIFAT: 109 FAT sector numbers in the header, then chained sectors ---
  const fatSectorList = []
  for (let index = 0; index < fatSectors; index += 1) fatSectorList.push(fatSectorStart + index)
  for (let index = 0; index < DIFAT_ENTRIES_IN_HEADER; index += 1) {
    buffer.writeUInt32LE(index < fatSectorList.length ? fatSectorList[index] : FREESECT, HEADER.difat + index * 4)
  }
  const perDifatSector = sectorSize / 4 - 1
  for (let index = 0; index < difatSectors; index += 1) {
    const base = sectorOffset(dataSectorCount + index)
    for (let slot = 0; slot < perDifatSector; slot += 1) {
      const fatIndex = DIFAT_ENTRIES_IN_HEADER + index * perDifatSector + slot
      buffer.writeUInt32LE(fatIndex < fatSectorList.length ? fatSectorList[fatIndex] : FREESECT, base + slot * 4)
    }
    buffer.writeUInt32LE(index + 1 < difatSectors ? dataSectorCount + index + 1 : ENDOFCHAIN, base + perDifatSector * 4)
  }

  // ---- payload -------------------------------------------------------------
  for (const entry of regularStreams) entry.data.copy(buffer, sectorOffset(entry.startSector))
  for (const chunk of miniChunks) chunk.entry.data.copy(buffer, sectorOffset(miniStreamStart) + chunk.offset)
  for (let index = 0; index < miniFat.length; index += 1) {
    buffer.writeUInt32LE(miniFat[index], sectorOffset(firstMiniFatSector) + index * 4)
  }
  for (let index = 0; index < fatTable.length; index += 1) {
    buffer.writeUInt32LE(fatTable[index] >>> 0, sectorOffset(fatSectorStart) + index * 4)
  }

  // ---- directory tree and entries -----------------------------------------
  for (const entry of entries) {
    if (entry.kind === 'root' || entry.kind === 'storage') buildDirectoryTree(entries, entry.id)
  }
  const dirOffset = sectorOffset(firstDirSector)
  for (const entry of entries) {
    const base = dirOffset + entry.id * ENTRY.size
    if (entry.kind === 'root') {
      // The root entry carries the mini stream and the document's own CLSID;
      // an empty name is legal and keeps the bytes deterministic.
      entry.clsid.copy(buffer, base + ENTRY.clsid)
      buffer.writeUInt8(TYPE_ROOT, base + ENTRY.objectType)
      buffer.writeUInt8(COLOR_BLACK, base + ENTRY.color)
      buffer.writeUInt32LE(NO_ENTRY, base + ENTRY.left)
      buffer.writeUInt32LE(NO_ENTRY, base + ENTRY.right)
      buffer.writeUInt32LE(entries[0].child, base + ENTRY.child)
      buffer.writeUInt32LE(miniStreamStart, base + ENTRY.startSector)
      buffer.writeUInt32LE(miniStreamSize >>> 0, base + ENTRY.streamSize)
      buffer.writeUInt32LE(0, base + ENTRY.streamSize + 4)
      continue
    }
    const nameBytes = utf16NameBytes(entry.name)
    if (nameBytes.length > 64) fail('cfb', `directory entry name ${JSON.stringify(entry.name)} is longer than 31 characters`)
    nameBytes.copy(buffer, base + ENTRY.name)
    buffer.writeUInt16LE(nameBytes.length, base + ENTRY.nameLength)
    buffer.writeUInt8(entry.kind === 'stream' ? TYPE_STREAM : TYPE_STORAGE, base + ENTRY.objectType)
    buffer.writeUInt8(entry.color, base + ENTRY.color)
    buffer.writeUInt32LE(entry.left, base + ENTRY.left)
    buffer.writeUInt32LE(entry.right, base + ENTRY.right)
    buffer.writeUInt32LE(entry.child, base + ENTRY.child)
    entry.clsid.copy(buffer, base + ENTRY.clsid)
    buffer.writeUInt32LE(entry.startSector, base + ENTRY.startSector)
    if (entry.kind === 'stream') {
      buffer.writeUInt32LE(entry.streamSize >>> 0, base + ENTRY.streamSize)
      buffer.writeUInt32LE(0, base + ENTRY.streamSize + 4)
    }
  }

  return buffer
}

/* -------------------------------------------------------------- the reader -- */

/**
 * Parse an MS-CFB document into its directory tree and streams.
 *
 * Every field the header claims is checked against the bytes that follow:
 * signature, byte order and sector shift, the FAT chain reaching every sector
 * (no loops, no out-of-range links), the mini stream and mini FAT for small
 * streams, the directory sibling ordering, and each stream's declared size
 * fitting the sectors it claims.
 *
 * @param {Buffer} buffer - document bytes.
 * @returns {{ version: number, sectorSize: number, clsid: string, children: object[],
 *   list: object[], directory: object[], sectors: number, miniStreamCutoff: number,
 *   warnings: string[] }}
 */
export function readCompoundFile (buffer) {
  if (!Buffer.isBuffer(buffer)) fail('cfb', `cannot read ${describeValue(buffer)}; pass a Buffer`)
  if (buffer.length < SECTOR_SIZE_V3) fail('cfb', `a compound file is at least 512 bytes, got ${buffer.length}`)
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (buffer[index] !== SIGNATURE[index]) {
      fail('cfb', 'this is not a compound file: the 8 byte signature does not match D0 CF 11 E0 A1 B1 1A E1')
    }
  }
  const majorVersion = buffer.readUInt16LE(HEADER.majorVersion)
  if (majorVersion !== 3 && majorVersion !== 4) fail('cfb', `unsupported compound file version ${majorVersion}`)
  const sectorSize = 1 << buffer.readUInt16LE(HEADER.sectorShift)
  if (majorVersion === 3 && sectorSize !== SECTOR_SIZE_V3) fail('cfb', `version 3 needs 512 byte sectors, header says ${sectorSize}`)
  if (majorVersion === 4 && sectorSize !== SECTOR_SIZE_V4) fail('cfb', `version 4 needs 4096 byte sectors, header says ${sectorSize}`)
  if (buffer.readUInt16LE(HEADER.byteOrder) !== 0xfffe) fail('cfb', 'the byte order marker must be 0xFFFE (little endian)')
  if (buffer.readUInt16LE(HEADER.miniSectorShift) !== 6) fail('cfb', 'the mini sector shift must be 6')

  const fatSectorCount = buffer.readUInt32LE(HEADER.fatSectorCount)
  const firstDirSector = buffer.readUInt32LE(HEADER.firstDirSector)
  const miniStreamCutoff = buffer.readUInt32LE(HEADER.miniStreamCutoff)
  const firstMiniFatSector = buffer.readUInt32LE(HEADER.firstMiniFatSector)
  const firstDifatSector = buffer.readUInt32LE(HEADER.firstDifatSector)
  const difatSectorCount = buffer.readUInt32LE(HEADER.difatSectorCount)

  const sectorCount = Math.floor((buffer.length - sectorSize) / sectorSize)
  const offsetOf = (sector) => {
    if (sector > MAXREGSECT) fail('cfb', `sector number 0x${sector.toString(16)} is not a real sector`)
    if (sector >= sectorCount) fail('cfb', `sector ${sector} is past the end of the file (${sectorCount} sectors)`)
    return sectorSize + sector * sectorSize
  }

  // ---- DIFAT: gather every FAT sector number -------------------------------
  const fatSectors = []
  for (let index = 0; index < DIFAT_ENTRIES_IN_HEADER; index += 1) {
    const sector = buffer.readUInt32LE(HEADER.difat + index * 4)
    if (sector !== FREESECT) fatSectors.push(sector)
  }
  const perDifatSector = sectorSize / 4 - 1
  let difatSector = firstDifatSector
  for (let guard = 0; guard < difatSectorCount && guard < MAX_SECTOR_COUNT; guard += 1) {
    if (difatSector === ENDOFCHAIN || difatSector === FREESECT) break
    const base = offsetOf(difatSector)
    for (let slot = 0; slot < perDifatSector; slot += 1) {
      const sector = buffer.readUInt32LE(base + slot * 4)
      if (sector !== FREESECT) fatSectors.push(sector)
    }
    difatSector = buffer.readUInt32LE(base + perDifatSector * 4)
  }
  if (fatSectors.length !== fatSectorCount) {
    fail('cfb', `the header claims ${fatSectorCount} FAT sector(s) but ${fatSectors.length} were found`)
  }

  // ---- FAT -----------------------------------------------------------------
  const fat = []
  for (const sector of fatSectors) {
    const base = offsetOf(sector)
    for (let index = 0; index < sectorSize / 4; index += 1) fat.push(buffer.readUInt32LE(base + index * 4))
  }
  if (fat.length < sectorCount) fail('cfb', `the FAT holds ${fat.length} entries but the file has ${sectorCount} sectors`)

  /** Walk a chain through a FAT-like table, refusing loops and bad links. */
  const chain = (start, table, label) => {
    const sectors = []
    let sector = start
    for (let guard = 0; guard < MAX_SECTOR_COUNT; guard += 1) {
      if (sector === ENDOFCHAIN) return sectors
      if (sector === FREESECT || sector === FATSECT || sector === DIFSECT) {
        fail('cfb', `${label} chain reaches the reserved FAT value 0x${sector.toString(16)}`)
      }
      sectors.push(sector)
      if (sector >= table.length) fail('cfb', `${label} chain points at sector ${sector}, past the table (${table.length} entries)`)
      sector = table[sector]
    }
    fail('cfb', `${label} chain does not terminate; the FAT is cyclic`)
    return sectors
  }

  // ---- directory -----------------------------------------------------------
  const dirSectors = chain(firstDirSector, fat, 'directory')
  const dirBytes = Buffer.alloc(dirSectors.length * sectorSize)
  dirSectors.forEach((sector, index) => buffer.copy(dirBytes, index * sectorSize, offsetOf(sector), offsetOf(sector) + sectorSize))
  const entries = []
  for (let base = 0; base + ENTRY.size <= dirBytes.length; base += ENTRY.size) {
    const objectType = dirBytes.readUInt8(base + ENTRY.objectType)
    if (objectType === 0) continue
    const nameLength = dirBytes.readUInt16LE(base + ENTRY.nameLength)
    let name = ''
    if (nameLength > 2 && nameLength <= 64) name = dirBytes.toString('utf16le', base + ENTRY.name, base + ENTRY.name + nameLength - 2)
    entries.push({
      id: base / ENTRY.size,
      name,
      kind: objectType === TYPE_ROOT ? 'root' : objectType === TYPE_STREAM ? 'stream' : 'storage',
      color: dirBytes.readUInt8(base + ENTRY.color),
      left: dirBytes.readUInt32LE(base + ENTRY.left),
      right: dirBytes.readUInt32LE(base + ENTRY.right),
      child: dirBytes.readUInt32LE(base + ENTRY.child),
      clsid: Buffer.from(dirBytes.subarray(base + ENTRY.clsid, base + ENTRY.clsid + 16)),
      startSector: dirBytes.readUInt32LE(base + ENTRY.startSector),
      streamSize: dirBytes.readUInt32LE(base + ENTRY.streamSize) +
        dirBytes.readUInt32LE(base + ENTRY.streamSize + 4) * 0x100000000
    })
  }
  if (entries.length === 0 || entries[0].kind !== 'root') fail('cfb', 'the first directory entry is not the root')
  const root = entries[0]
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  // ---- mini FAT and mini stream -------------------------------------------
  const miniFat = []
  if (firstMiniFatSector !== ENDOFCHAIN && firstMiniFatSector !== FREESECT) {
    for (const sector of chain(firstMiniFatSector, fat, 'mini FAT')) {
      const base = offsetOf(sector)
      for (let index = 0; index < sectorSize / 4; index += 1) miniFat.push(buffer.readUInt32LE(base + index * 4))
    }
  }
  let miniStream = Buffer.alloc(0)
  if (root.startSector !== ENDOFCHAIN && root.streamSize > 0) {
    const sectors = chain(root.startSector, fat, 'mini stream')
    miniStream = Buffer.alloc(sectors.length * sectorSize)
    sectors.forEach((sector, index) => buffer.copy(miniStream, index * sectorSize, offsetOf(sector), offsetOf(sector) + sectorSize))
  }

  /** Read one stream's bytes, from the mini stream or regular sectors. */
  const readStream = (entry) => {
    if (entry.streamSize === 0) return Buffer.alloc(0)
    if (entry.streamSize < miniStreamCutoff) {
      if (miniStream.length === 0) fail('cfb', `stream ${JSON.stringify(entry.name)} is small but the document has no mini stream`)
      const chunks = []
      let sector = entry.startSector
      for (let guard = 0; guard < MAX_SECTOR_COUNT; guard += 1) {
        if (sector === ENDOFCHAIN) break
        if (sector >= miniFat.length) fail('cfb', `stream ${JSON.stringify(entry.name)} points at mini sector ${sector}, past the mini FAT (${miniFat.length})`)
        const offset = sector * MINI_SECTOR_SIZE
        if (offset + MINI_SECTOR_SIZE > miniStream.length) fail('cfb', `stream ${JSON.stringify(entry.name)} reads past the mini stream`)
        chunks.push(miniStream.subarray(offset, offset + MINI_SECTOR_SIZE))
        sector = miniFat[sector]
      }
      const data = Buffer.concat(chunks)
      if (data.length < entry.streamSize) {
        fail('cfb', `stream ${JSON.stringify(entry.name)} claims ${entry.streamSize} bytes but its chain holds ${data.length}`)
      }
      return data.subarray(0, entry.streamSize)
    }
    const sectors = chain(entry.startSector, fat, `stream ${JSON.stringify(entry.name)}`)
    const data = Buffer.alloc(sectors.length * sectorSize)
    sectors.forEach((sector, index) => buffer.copy(data, index * sectorSize, offsetOf(sector), offsetOf(sector) + sectorSize))
    if (data.length < entry.streamSize) {
      fail('cfb', `stream ${JSON.stringify(entry.name)} claims ${entry.streamSize} bytes but its chain holds ${data.length}`)
    }
    return data.subarray(0, entry.streamSize)
  }

  // ---- rebuild the tree ----------------------------------------------------
  const warnings = []
  const list = []

  /**
   * In-order walk of one sibling tree, with the ordering rule asserted.
   * Returns the entry ids in tree order.
   */
  const siblingIds = (childId, path, seen) => {
    const ids = []
    const walk = (entryId) => {
      if (entryId === NO_ENTRY) return
      if (seen.has(`t${entryId}`)) fail('cfb', `the directory tree is cyclic at entry ${entryId}`)
      seen.add(`t${entryId}`)
      const entry = byId.get(entryId)
      if (entry === undefined) fail('cfb', `the directory tree points at entry ${entryId}, which does not exist`)
      walk(entry.left)
      ids.push(entryId)
      walk(entry.right)
    }
    walk(childId)
    for (let index = 1; index < ids.length; index += 1) {
      const previous = byId.get(ids[index - 1]).name
      const current = byId.get(ids[index]).name
      if (compareDirectoryNames(previous, current) >= 0) {
        warnings.push(`sibling names are not in CFB order at ${path}: ${JSON.stringify(previous)} before ${JSON.stringify(current)}`)
      }
    }
    return ids
  }

  const visit = (entryId, parentPath) => {
    const entry = byId.get(entryId)
    // Paths are `/name` at the top and `/parent/name` below it; the root's own
    // path is `/`. Building them here (instead of in every caller) is what makes
    // `findStream(tree, '/Header-2/properties')` work from outside.
    const base = parentPath === ''
      ? '/'
      : parentPath.endsWith('/') ? parentPath : `${parentPath}/`
    const path = entry.kind === 'root' ? '/' : `${base}${entry.name}`
    const node = { name: entry.name, path, kind: entry.kind, clsid: clsidToString(entry.clsid), children: [] }
    list.push(node)
    if (entry.kind === 'stream') {
      node.data = readStream(entry)
      node.size = node.data.length
      return node
    }
    const seen = new Set()
    node.children = siblingIds(entry.child, node.path, seen).map((id) => visit(id, node.path))
    return node
  }

  const tree = visit(0, '')
  return {
    version: majorVersion,
    sectorSize,
    miniSectorShift: 6,
    miniStreamCutoff,
    sectors: sectorCount,
    size: buffer.length,
    clsid: tree.clsid,
    children: tree.children,
    list,
    // Raw directory entries with their own tree links (`left`, `right`, `child`)
    // and colours. `list` and `children` are the friendly flattened view; this
    // is the view a caller needs to check the red-black shape of the directory
    // (depth, black height, red-red edges) instead of only its ordering.
    directory: entries,
    warnings
  }
}

/* --------------------------------------------------------------- helpers -- */

/** Find a node by path (`/a/b`) in a tree returned by `readCompoundFile`. */
export function findNode (tree, path) {
  if (typeof path !== 'string') fail('cfb', `path must be a string, got ${describeValue(path)}`)
  const parts = path.split('/').filter((part) => part !== '')
  let current = tree
  for (const part of parts) {
    const next = current.children.find((child) => child.name === part)
    if (next === undefined) return undefined
    current = next
  }
  return current
}

/** Read a stream by path, or `undefined` when it is not there. */
export function findStream (tree, path) {
  const node = findNode(tree, path)
  return node !== undefined && node.kind === 'stream' ? node.data : undefined
}

/** Every stream path in a tree, depth first, in tree order. */
export function listStreams (tree) {
  const paths = []
  const walk = (node) => {
    for (const child of node.children) {
      if (child.kind === 'stream') paths.push(child.path)
      else walk(child)
    }
  }
  walk(tree)
  return paths
}
