/**
 * Host side of the cue editor page.
 *
 * One page and four read-only endpoints on the browser HTTP carrier, all
 * same-origin and GET-only:
 *
 *   GET /dsh-audio/editor            → the self-contained editor page
 *   GET /dsh-audio/editor/info       → workspace root, version, limits
 *   GET /dsh-audio/editor/project    → ?path=<workspace .json> as a cue list
 *   GET /dsh-audio/editor/file       → ?path=<workspace .wav> as wav bytes
 *   GET /dsh-audio/editor/list       → ?dir=<workspace directory> listing
 *
 * Why a separate route from the settings page: the settings page is a React
 * client plugin rendered by the shell; this page has to be reachable as a plain
 * URL the user can bookmark, so it is server-rendered HTML.
 *
 * The security boundary is one directory: `workingDirectory.defaultDirectory`
 * (the deployment workspace root) or `process.cwd()` when that service is not
 * installed. Every request path is rejected unless it is a relative path with
 * no `..` segment, resolves inside that root lexically *and* after `realpath`
 * (so a symlink cannot point out), and carries a whitelisted extension
 * (`.json` for projects, `.wav` for audio). Nothing here writes.
 *
 * The workspace root is a deployment default, not a session directory: the
 * HTTP carrier has no Session, so the route cannot know which conversation is
 * asking. A Session that `cd`-ed outside the workspace is therefore not
 * readable from the editor — documented in docs/EDITOR.zh.md.
 */

import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { read as fsRead } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EDITOR_PAGE_MARKERS, renderEditorPage } from './editor-page.js'

/** Paths this plugin claims on the web carrier. */
export const EDITOR_PATHS = Object.freeze({
  page: '/dsh-audio/editor',
  info: '/dsh-audio/editor/info',
  project: '/dsh-audio/editor/project',
  file: '/dsh-audio/editor/file',
  list: '/dsh-audio/editor/list'
})

/** Read-only limits; the page shows them in its info call. */
export const EDITOR_LIMITS = Object.freeze({
  /** A cue sheet is small; anything above this is not one. */
  jsonBytes: 8 * 1024 * 1024,
  /** A wav is streamed whole; 32 MB is roughly 2.8 minutes of 48 kHz stereo. */
  wavBytes: 32 * 1024 * 1024,
  /** Directory listings are capped so one huge folder cannot stall the page. */
  listEntries: 400,
  /** Cue count per project; far above any real cue sheet. */
  cues: 2000
})

/** Cue fields the editor understands, in the order the inspector shows them. */
export const CUE_FIELDS = Object.freeze(['name', 'at', 'path', 'gainDb', 'fadeIn', 'fadeOut', 'loop'])

const ROUND = (value, digits) => {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function clamp (value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * A refused read, carrying the HTTP status and machine code the route answers
 * with. Never a stack: the page renders `error` in one line.
 */
export class ReadRefusedError extends Error {
  /**
   * @param {string} message - one displayable Chinese sentence.
   * @param {number} [status] - HTTP status to answer with.
   * @param {string} [code] - stable machine code for the page and tests.
   */
  constructor (message, status = 400, code = 'refused') {
    super(message)
    this.name = 'ReadRefusedError'
    this.status = status
    this.code = code
  }
}

/* ---- workspace boundary ---- */

/** Split a request path into segments, rejecting traversal up front. */
function requestSegments (requested) {
  if (typeof requested !== 'string') throw new ReadRefusedError('缺少 path 参数', 400, 'missing-path')
  const raw = requested.trim()
  if (raw === '') throw new ReadRefusedError('path 不能为空', 400, 'empty-path')
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ReadRefusedError('path 含控制字符', 400, 'bad-path')
  if (isAbsolute(raw) || raw.startsWith('~')) {
    throw new ReadRefusedError('只接受工作区内的相对路径', 400, 'absolute-path')
  }
  const segments = raw.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (segments.length === 0) throw new ReadRefusedError('path 不能是工作区本身', 400, 'bad-path')
  for (const part of segments) {
    if (part === '..') throw new ReadRefusedError('path 不能含 ..', 400, 'escape')
  }
  return segments
}

/**
 * Resolve a request path against the workspace root, lexically.
 *
 * This is the first of two checks; the caller still `realpath`s the result and
 * re-tests containment, because `foo/../../etc/passwd` is already rejected here
 * but a symlink inside the workspace is not.
 * @param {string} root - absolute workspace root.
 * @param {string} requested - workspace-relative path from the query string.
 * @returns {string} absolute candidate path.
 */
export function resolveWorkspacePath (root, requested) {
  const segments = requestSegments(requested)
  const target = resolve(root, ...segments)
  const rel = relative(root, target)
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ReadRefusedError('路径越出工作区', 400, 'escape')
  }
  return target
}

/** Resolve a directory request (no extension check). */
function resolveWorkspaceDir (root, requested) {
  if (requested === '' || requested === undefined || requested === null) return root
  return resolveWorkspacePath(root, requested)
}

/** Whether `target` is inside `root` after normalisation. */
function insideRoot (root, target) {
  if (target === root) return true
  const rel = relative(root, target)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** A display path relative to the workspace, forward-slashed. */
function workspaceDisplay (root, target) {
  const rel = relative(root, target)
  return rel.split(sep).join('/')
}

/** Convert a filesystem error into a refusal that names the fact, not a stack. */
function fsRefusal (error, fallback) {
  if (error instanceof ReadRefusedError) return error
  if (error?.code === 'ENOENT') return new ReadRefusedError('文件不存在', 404, 'not-found')
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new ReadRefusedError('没有权限读取这个文件', 403, 'denied')
  if (error?.code === 'EISDIR') return new ReadRefusedError('这是一个目录，不是文件', 400, 'not-a-file')
  return new ReadRefusedError(fallback ?? '读取失败', 400, 'read-failed')
}

/**
 * Resolve one workspace-relative file: lexical check, extension whitelist,
 * `realpath` containment, and "is it a regular file".
 * @param {string} root - real workspace root.
 * @param {string} requested - query-string path.
 * @param {string[]} extensions - allowed lowercase extensions (`.json`).
 * @returns {Promise<string>} real absolute file path.
 */
async function resolveExistingFile (root, requested, extensions) {
  const candidate = resolveWorkspacePath(root, requested)
  const extension = extname(candidate).toLowerCase()
  if (!extensions.includes(extension)) {
    throw new ReadRefusedError(`只允许 ${extensions.join(' / ')} 文件`, 400, 'bad-extension')
  }
  let real
  try {
    real = await realpath(candidate)
  } catch (error) {
    throw fsRefusal(error, '文件不存在或打不开')
  }
  if (!insideRoot(root, real)) throw new ReadRefusedError('路径越出工作区', 400, 'escape')
  let info
  try {
    info = await stat(real)
  } catch (error) {
    throw fsRefusal(error, '文件读不到')
  }
  if (!info.isFile()) throw new ReadRefusedError('不是普通文件', 400, 'not-a-file')
  return real
}

/** Resolve one workspace-relative directory through `realpath`. */
async function resolveExistingDir (root, requested) {
  const candidate = resolveWorkspaceDir(root, requested)
  let real
  try {
    real = await realpath(candidate)
  } catch (error) {
    throw fsRefusal(error, '目录不存在')
  }
  if (!insideRoot(root, real) && real !== root) throw new ReadRefusedError('路径越出工作区', 400, 'escape')
  let info
  try {
    info = await stat(real)
  } catch (error) {
    throw fsRefusal(error, '目录读不到')
  }
  if (!info.isDirectory()) throw new ReadRefusedError('不是目录', 400, 'not-a-directory')
  return real
}

/* ---- wav header ---- */

/**
 * Read one slice of an open file.
 *
 * Deliberately goes through the plain `fs.read` callback on `handle.fd` instead
 * of `FileHandle.read`: on the Node build this plugin ships for, the callback
 * form of `FileHandle.read` never invokes its callback (the promise form works,
 * but it reads from the current position and cannot seek).
 * @param {import('node:fs/promises').FileHandle} handle - open handle.
 * @param {number} offset - byte offset.
 * @param {number} length - byte count.
 * @returns {Promise<Buffer>} the bytes actually read.
 */
function readAt (handle, offset, length) {
  return new Promise((done, fail) => {
    const buffer = Buffer.alloc(Math.max(0, length))
    if (buffer.length === 0) {
      done(buffer)
      return
    }
    fsRead(handle.fd, buffer, 0, buffer.length, offset, (error, bytesRead) => {
      if (error) fail(error)
      else done(buffer.subarray(0, bytesRead))
    })
  })
}

/**
 * Scan RIFF/WAVE chunk headers without decoding samples.
 *
 * Duration only needs `fmt ` and `data`, so the editor can put a lane on the
 * timeline before (or without) the browser decoding the audio.
 * @param {number} size - total file bytes.
 * @param {(offset: number, length: number) => Promise<Buffer>} read - reader.
 * @returns {Promise<{ bytes: number, sampleRate: number, channels: number,
 *   bitDepth: number, dataBytes: number, durationSeconds: number }>}
 */
async function scanWav (size, read) {
  if (size < 12) throw new ReadRefusedError('不是 RIFF/WAVE 文件（太短）', 400, 'not-wav')
  const head = await read(0, 12)
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ReadRefusedError('不是 RIFF/WAVE 文件', 400, 'not-wav')
  }
  let cursor = 12
  let format = null
  let data = null
  let guard = 0
  while (cursor + 8 <= size && guard < 4096) {
    guard += 1
    const chunk = await read(cursor, 8)
    if (chunk.length < 8) break
    const id = chunk.toString('ascii', 0, 4)
    const chunkSize = chunk.readUInt32LE(4)
    const body = cursor + 8
    if (id === 'fmt ' && chunkSize >= 16) {
      const fmt = await read(body, Math.min(chunkSize, 40))
      if (fmt.length >= 16) {
        format = {
          audioFormat: fmt.readUInt16LE(0),
          channels: fmt.readUInt16LE(2),
          sampleRate: fmt.readUInt32LE(4),
          blockAlign: fmt.readUInt16LE(12),
          bitDepth: fmt.readUInt16LE(14)
        }
      }
    } else if (id === 'data') {
      data = { size: Math.min(chunkSize, Math.max(0, size - body)) }
      break
    }
    if (chunkSize <= 0) break
    cursor = body + chunkSize + (chunkSize % 2)
  }
  if (format === null) throw new ReadRefusedError('WAVE 缺少 fmt 块', 400, 'not-wav')
  if (data === null) throw new ReadRefusedError('WAVE 缺少 data 块', 400, 'not-wav')
  const bytesPerSample = Math.max(1, Math.floor(format.bitDepth / 8))
  const blockAlign = format.blockAlign > 0 ? format.blockAlign : Math.max(1, format.channels * bytesPerSample)
  const frames = blockAlign > 0 ? Math.floor(data.size / blockAlign) : 0
  return {
    bytes: size,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitDepth: format.bitDepth,
    dataBytes: data.size,
    durationSeconds: format.sampleRate > 0 ? ROUND(frames / format.sampleRate, 6) : 0
  }
}

/**
 * Probe a wav file's header.
 * @param {string} filePath - absolute path.
 * @returns {Promise<object>} the facts `scanWav` reports.
 */
export async function probeWavFile (filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch (error) {
    throw fsRefusal(error, '打不开 wav')
  }
  try {
    const info = await handle.stat()
    return await scanWav(info.size, (offset, length) => readAt(handle, offset, length))
  } finally {
    await handle.close()
  }
}

/* ---- cue document ---- */

/** `.wav` / `.json` style remote detection, without accepting `C:\…`. */
function isRemoteLike (value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true
  if (/^(?:https?|file):/i.test(value)) return true
  return value.startsWith('//')
}

/** Whether a cue source is an inline base64 / data URI. */
function isInlineSource (value) {
  return value.length > 0 && value.slice(0, 5).toLowerCase() === 'data:'
}

/** Estimate the raw byte count behind a base64 data URI. */
function inlineBytesOf (value) {
  const comma = value.indexOf(',')
  if (comma < 0) return 0
  const body = value.slice(comma + 1).replace(/\s+/g, '')
  return Math.floor((body.length * 3) / 4)
}

/**
 * Normalize one cue and, when it names a workspace wav, probe that file.
 *
 * The returned cue is what the page renders: `path` / `src` as written in the
 * input (inline base64 is replaced by `inlineBytes`, never echoed), `readable`
 * as the workspace-relative wav the page may fetch, and `readError` when no
 * waveform can be drawn. `wavDuration` comes from the file header, so a lane is
 * the right width before the browser decodes anything.
 * @param {any} raw - one entry of the input cue array.
 * @param {number} index - position, used to default the name.
 * @param {string} root - real workspace root.
 * @returns {Promise<object>} normalized cue.
 */
async function describeCue (raw, index, root) {
  const cue = raw !== null && typeof raw === 'object' ? raw : {}
  const name = typeof cue.name === 'string' && cue.name.trim() !== ''
    ? cue.name.trim().slice(0, 200)
    : `cue-${index + 1}`
  const atNumber = Number(cue.at)
  const at = Number.isFinite(atNumber) ? ROUND(clamp(atNumber, 0, 3600), 3) : 0
  const gainDb = Number.isFinite(Number(cue.gainDb)) ? ROUND(clamp(Number(cue.gainDb), -60, 12), 1) : 0
  const fadeIn = Number.isFinite(Number(cue.fadeIn)) ? ROUND(clamp(Number(cue.fadeIn), 0, 60), 3) : 0
  const fadeOut = Number.isFinite(Number(cue.fadeOut)) ? ROUND(clamp(Number(cue.fadeOut), 0, 60), 3) : 0
  const pathValue = typeof cue.path === 'string' ? cue.path.trim() : ''
  const srcValue = typeof cue.src === 'string' ? cue.src.trim() : ''
  const dataValue = typeof cue.data === 'string' ? cue.data : ''

  const described = {
    name,
    at,
    path: pathValue,
    src: isInlineSource(srcValue) ? '' : srcValue,
    readable: null,
    gainDb,
    fadeIn,
    fadeOut,
    loop: cue.loop === true,
    inline: dataValue.length > 0 || isInlineSource(srcValue),
    inlineBytes: dataValue.length > 0 ? inlineBytesOf(dataValue) : isInlineSource(srcValue) ? inlineBytesOf(srcValue) : 0,
    wavDuration: 0,
    sampleRate: 0,
    channels: 0,
    readError: ''
  }

  const origin = pathValue !== '' ? pathValue : described.src
  let readable = null
  if (described.inline) {
    described.readError = '内联音频（data URI）：编辑器不解码，时间线只能编辑不能试听'
  } else if (origin === '') {
    described.readError = '没有 wav 路径'
  } else if (isRemoteLike(origin) || /^[a-z][a-z0-9+.-]*:/i.test(origin) && !isAbsolute(origin)) {
    described.readError = '远程地址：编辑器只读工作区内的 wav'
  } else if (isAbsolute(origin)) {
    if (!insideRoot(root, origin)) {
      described.readError = '绝对路径在工作区外'
    } else {
      readable = workspaceDisplay(root, origin)
    }
  } else {
    const segments = origin.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
    if (segments.includes('..')) {
      described.readError = '路径含 ..'
    } else if (!origin.toLowerCase().endsWith('.wav')) {
      described.readError = '不是 .wav 文件'
    } else {
      readable = segments.join('/')
    }
  }

  if (readable !== null) {
    try {
      const resolved = await resolveExistingFile(root, readable, ['.wav'])
      const probe = await probeWavFile(resolved)
      described.readable = readable
      described.wavDuration = probe.durationSeconds
      described.sampleRate = probe.sampleRate
      described.channels = probe.channels
    } catch (error) {
      described.readError = error?.message ?? '读不到 wav'
    }
  }
  return described
}

/**
 * Normalize a whole cue document.
 *
 * Accepted shapes: a bare cue array, an `audio_bind` sheet
 * (`{ cues, duration }`), or the same under `request` (a saved tool request).
 * Unknown extra keys are dropped, which keeps the page from rendering a cue
 * with a field it will silently lose on export.
 * @param {any} document - parsed JSON.
 * @param {string} root - real workspace root.
 * @returns {Promise<{ duration: number, cues: object[], ignored: string[] }>}
 */
export async function normalizeCueDocument (document, root) {
  let list = null
  let duration = 0
  const ignored = []
  if (Array.isArray(document)) {
    list = document
  } else if (document !== null && typeof document === 'object' && Array.isArray(document.cues)) {
    list = document.cues
    if (Number.isFinite(Number(document.duration))) duration = Number(document.duration)
    ignored.push(...Object.keys(document).filter((key) => key !== 'cues' && key !== 'duration'))
  } else if (document !== null && typeof document === 'object' && document.request !== null && typeof document.request === 'object' && Array.isArray(document.request.cues)) {
    list = document.request.cues
    if (Number.isFinite(Number(document.request.duration))) duration = Number(document.request.duration)
    ignored.push('request')
  }
  if (list === null) {
    throw new ReadRefusedError('不是 cue 数组，也不是 {cues:[…]} 形式的 cue 表', 400, 'bad-cues')
  }
  if (list.length > EDITOR_LIMITS.cues) {
    throw new ReadRefusedError(`cue 数量超过 ${EDITOR_LIMITS.cues} 条`, 413, 'too-many-cues')
  }
  const cues = []
  for (let index = 0; index < list.length; index += 1) {
    cues.push(await describeCue(list[index], index, root))
  }
  return {
    duration: duration > 0 && duration <= 3600 ? ROUND(duration, 3) : 0,
    cues,
    ignored
  }
}

/* ---- http plumbing ---- */

/** Write one JSON payload. */
function sendJson (response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  })
  response.end(body)
}

/** Write the page. One inline script and one inline stylesheet, nothing else. */
function sendPage (response, version, headOnly = false) {
  const body = Buffer.from(renderEditorPage({ version }), 'utf8')
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The page is deliberately self-contained: no external origin may be
    // reached, and the only connect target is this same server.
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'"
  })
  response.end(headOnly ? undefined : body)
}

/** Write wav bytes with the probed facts as headers. */
function sendWav (response, bytes, probe) {
  response.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Dsh-Audio-Duration': String(probe.durationSeconds),
    'X-Dsh-Audio-Sample-Rate': String(probe.sampleRate),
    'X-Dsh-Audio-Channels': String(probe.channels)
  })
  response.end(bytes)
}

/**
 * Reject cross-site callers, mirroring the settings route. Duplicated instead
 * of imported so the editor route has no dependency on a module another change
 * may be editing at the same time; the check is four lines and the two copies
 * say the same thing.
 */
function sameOriginOnly (request, response) {
  const site = request.headers['sec-fetch-site']
  if (site === undefined || site === 'none' || site === 'same-origin' || site === 'same-site') return true
  sendJson(response, 403, { ok: false, error: '只接受同源请求', code: 'cross-site' })
  return false
}

/** GET-only guard: the editor never changes anything. */
function readOnlyMethod (request, response) {
  if (request.method === 'GET') return true
  sendJson(response, 405, { ok: false, error: `只支持 GET，不支持 ${request.method}`, code: 'method' }, { Allow: 'GET' })
  return false
}

/** One thrown value as the route's error response. */
function sendFailure (response, error) {
  if (response.headersSent) {
    response.end()
    return
  }
  if (error instanceof ReadRefusedError) {
    sendJson(response, error.status, { ok: false, error: error.message, code: error.code })
    return
  }
  sendJson(response, 500, { ok: false, error: '内部错误：' + (error?.message ?? String(error)), code: 'internal' })
}

/** Parse the request URL without trusting it. */
function requestUrl (request) {
  try {
    return new URL(typeof request.url === 'string' && request.url !== '' ? request.url : '/', 'http://editor.local')
  } catch {
    return new URL('/', 'http://editor.local')
  }
}

/* ---- workspace root ---- */

/**
 * The directory every read is confined to.
 *
 * `workingDirectory.defaultDirectory` is the deployment workspace root the
 * sessions are started in; the service is optional (a composition may not mount
 * it), so the lookup never throws. A route has no Session, which is why the
 * default is used rather than a per-conversation directory.
 * @param {object} ctx - plugin context.
 * @returns {{ root: string, source: string }} absolute root and where it came from.
 */
export function editorWorkspaceRoot (ctx) {
  try {
    const service = ctx.get('workingDirectory')
    const directory = service?.defaultDirectory
    if (typeof directory === 'string' && directory !== '' && isAbsolute(directory)) {
      return { root: directory, source: 'workingDirectory.defaultDirectory' }
    }
  } catch { /* service absent or throwing: fall back to the launch directory */ }
  return { root: process.cwd(), source: 'process.cwd()' }
}

/** The real (symlink-resolved) workspace root, or a 503 refusal. */
async function realWorkspaceRoot (ctx) {
  const found = editorWorkspaceRoot(ctx)
  let real
  try {
    real = await realpath(found.root)
  } catch (error) {
    throw new ReadRefusedError(`工作区目录不可用：${found.root}`, 503, 'no-root')
  }
  let info
  try {
    info = await stat(real)
  } catch {
    throw new ReadRefusedError(`工作区目录不可用：${found.root}`, 503, 'no-root')
  }
  if (!info.isDirectory()) throw new ReadRefusedError('工作区不是目录', 503, 'no-root')
  return { path: real, source: found.source }
}

/* ---- directory listing ---- */

/** Human byte count for the browse panel. */
function sizeText (bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * List one workspace directory: subdirectories, `.json` and `.wav` files.
 * Hidden entries (`.git`, `.env`) are skipped, as is `node_modules`, because
 * the point of the panel is finding cue sheets and wavs, not browsing a checkout.
 * @param {string} root - real workspace root.
 * @param {string} requested - workspace-relative directory ('' = root).
 * @returns {Promise<object>} listing payload.
 */
async function listDirectory (root, requested) {
  const target = await resolveExistingDir(root, requested)
  const dir = workspaceDisplay(root, target)
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    throw fsRefusal(error, '列不出目录内容')
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const child = join(target, entry.name)
    const childPath = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: childPath })
      continue
    }
    if (!entry.isFile()) continue
    const extension = extname(entry.name).toLowerCase()
    if (extension !== '.json' && extension !== '.wav') continue
    let bytes = 0
    try {
      bytes = (await stat(child)).size
    } catch { /* a file that vanished mid-listing is simply skipped */ }
    files.push({ name: entry.name, path: childPath, kind: extension === '.json' ? 'json' : 'wav', size: bytes, sizeText: sizeText(bytes) })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  const limit = EDITOR_LIMITS.listEntries
  const truncated = dirs.length + files.length > limit
  const keepDirs = dirs.slice(0, limit)
  const keepFiles = files.slice(0, Math.max(0, limit - keepDirs.length))
  const parent = dir === '' ? null : dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
  return { dir, parent, dirs: keepDirs, files: keepFiles, truncated, limit }
}

/* ---- routes ---- */

/**
 * Register the editor page and its read endpoints.
 *
 * Registered through `ctx.inject(['webServer'], …)` like the settings route:
 * on a cold boot this plugin may activate before the HTTP carrier is mounted,
 * and in a composition without one the page simply does not exist. Nothing else
 * in the plugin depends on it.
 * @param {object} ctx - plugin context.
 * @param {string} version - plugin version shown in the page header.
 * @returns {boolean} whether the injection was registered.
 */
export function registerEditorRoute (ctx, version) {
  try {
    ctx.inject(['webServer'], (child) => {
      const webServer = child.webServer
      const register = (path, handler) => child.effect(() => webServer.register({ kind: 'exact', path, handler }))

      register(EDITOR_PATHS.page, async (request, response) => {
        try {
          if (!sameOriginOnly(request, response)) return
          if (!readOnlyMethod(request, response)) return
          sendPage(response, version)
        } catch (error) {
          sendFailure(response, error)
        }
      })

      register(EDITOR_PATHS.info, async (request, response) => {
        try {
          if (!sameOriginOnly(request, response)) return
          if (!readOnlyMethod(request, response)) return
          const root = await realWorkspaceRoot(ctx)
          sendJson(response, 200, {
            ok: true,
            version,
            root: root.path,
            rootSource: root.source,
            readOnly: true,
            limits: EDITOR_LIMITS,
            fields: CUE_FIELDS,
            marker: EDITOR_PAGE_MARKERS[0],
            routes: EDITOR_PATHS
          })
        } catch (error) {
          sendFailure(response, error)
        }
      })

      register(EDITOR_PATHS.project, async (request, response) => {
        try {
          if (!sameOriginOnly(request, response)) return
          if (!readOnlyMethod(request, response)) return
          const root = await realWorkspaceRoot(ctx)
          const requested = requestUrl(request).searchParams.get('path')
          if (requested === null || requested === '') throw new ReadRefusedError('缺少 path 参数', 400, 'missing-path')
          const target = await resolveExistingFile(root.path, requested, ['.json'])
          const info = await stat(target)
          if (info.size > EDITOR_LIMITS.jsonBytes) {
            throw new ReadRefusedError(`JSON 超过 ${sizeText(EDITOR_LIMITS.jsonBytes)} 上限`, 413, 'too-large')
          }
          const text = await readFile(target, 'utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (error) {
            throw new ReadRefusedError('不是合法 JSON：' + (error?.message ?? ''), 400, 'bad-json')
          }
          const document = await normalizeCueDocument(parsed, root.path)
          sendJson(response, 200, {
            ok: true,
            root: root.path,
            path: workspaceDisplay(root.path, target),
            duration: document.duration,
            cueCount: document.cues.length,
            cues: document.cues,
            ignored: document.ignored
          })
        } catch (error) {
          sendFailure(response, error)
        }
      })

      register(EDITOR_PATHS.file, async (request, response) => {
        try {
          if (!sameOriginOnly(request, response)) return
          if (!readOnlyMethod(request, response)) return
          const root = await realWorkspaceRoot(ctx)
          const requested = requestUrl(request).searchParams.get('path')
          if (requested === null || requested === '') throw new ReadRefusedError('缺少 path 参数', 400, 'missing-path')
          const target = await resolveExistingFile(root.path, requested, ['.wav'])
          const info = await stat(target)
          if (info.size > EDITOR_LIMITS.wavBytes) {
            throw new ReadRefusedError(`wav 超过 ${sizeText(EDITOR_LIMITS.wavBytes)} 上限`, 413, 'too-large')
          }
          const bytes = await readFile(target)
          const probe = await scanWav(bytes.length, async (offset, length) => bytes.subarray(offset, offset + length))
          sendWav(response, bytes, probe)
        } catch (error) {
          sendFailure(response, error)
        }
      })

      register(EDITOR_PATHS.list, async (request, response) => {
        try {
          if (!sameOriginOnly(request, response)) return
          if (!readOnlyMethod(request, response)) return
          const root = await realWorkspaceRoot(ctx)
          const requested = requestUrl(request).searchParams.get('dir')
          const listing = await listDirectory(root.path, requested === null ? '' : requested)
          sendJson(response, 200, { ok: true, root: root.path, ...listing })
        } catch (error) {
          sendFailure(response, error)
        }
      })
    })
  } catch {
    return false
  }
  return true
}
