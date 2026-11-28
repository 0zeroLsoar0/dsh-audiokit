/**
 * Editor route tests: the page, the four read-only endpoints, the workspace
 * sandbox, and the "no web carrier" degradation.
 *
 * The route is driven exactly the way the web carrier drives it — a mock
 * `req`/`res` pair through the handler registered with `ctx.inject(['webServer'])`
 * — against a throwaway workspace under `test/out/`. Every traversal attempt
 * (`../../`, `C:\`, `/etc/passwd`, URL-encoded dots, a symlink pointing out)
 * asserts both the status *and* that the refused file's content never appears in
 * the response, because "it returned 400" is not the same as "it leaked nothing".
 *
 * What this cannot prove: that a real browser decodes these wavs and draws the
 * waveform. `test/out/editor-browser-check.mjs` is the headless-Chrome companion
 * for that; this file proves the server half and the page's self-containment.
 *
 * Run: node test/editor-route.mjs
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EDITOR_LIMITS,
  EDITOR_PATHS,
  ReadRefusedError,
  editorWorkspaceRoot,
  normalizeCueDocument,
  probeWavFile,
  registerEditorRoute,
  resolveWorkspacePath
} from '../lib/editor-route.js'
import { EDITOR_PAGE_MARKERS, renderEditorPage } from '../lib/editor-page.js'
import { encodeWav } from '../lib/wav.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, 'out')
const workspace = join(scratch, 'editor-workspace')
const outsideDir = join(scratch, 'editor-outside')
const SECRET = 'TOP-SECRET-TOKEN-DO-NOT-LEAK'
const SECRET_FILE = join(outsideDir, 'secret.json')

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

function bytesOf (seconds, sampleRate = 24000, hz = 220) {
  const frames = Math.round(seconds * sampleRate)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) samples[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.4
  return encodeWav([samples], sampleRate, { dither: false })
}

/* --------------------------------------------------------------- fixture -- */

await rm(workspace, { recursive: true, force: true })
await rm(outsideDir, { recursive: true, force: true })
await mkdir(join(workspace, 'assets', 'audio'), { recursive: true })
await mkdir(join(workspace, 'cues'), { recursive: true })
await mkdir(outsideDir, { recursive: true })

const hitWav = bytesOf(0.5, 24000, 220)
const bedWav = bytesOf(1.2, 22050, 110)
await writeFile(join(workspace, 'assets', 'audio', 'hit.wav'), hitWav)
await writeFile(join(workspace, 'assets', 'audio', 'bed.wav'), bedWav)
// A `.wav` that is not a wav: the file endpoint must refuse it, not stream it.
await writeFile(join(workspace, 'assets', 'audio', 'broken.wav'), Buffer.from('not a riff file at all'))
// A regular file the editor has no business reading through /file.
await mkdir(join(workspace, '.hidden'), { recursive: true })
await writeFile(join(workspace, '.hidden', 'note.txt'), 'hidden')
await writeFile(join(workspace, 'notes.txt'), 'not offered by the listing')
// Names that expose a locale-dependent listing order. Code-unit order is
// Z2 < _5 < a1, while `localeCompare` puts `_5` first and `a1` before `Z2` in a
// typical locale, so a regression to localeCompare reorders these three.
for (const name of ['Z2', '_5', 'a1']) {
  await mkdir(join(workspace, name), { recursive: true })
  await writeFile(join(workspace, `${name}.json`), JSON.stringify({ cues: [] }))
}

const inlineData = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
const sheet = {
  duration: 6,
  basePath: 'assets/audio/',
  cues: [
    { name: 'hit', at: 0.5, path: 'assets/audio/hit.wav', gainDb: -2, fadeIn: 0.05, fadeOut: 0.1, loop: false },
    { name: 'bed', at: 1.5, src: 'assets/audio/bed.wav', loop: true },
    { name: 'voice', at: 2.5, src: inlineData, gainDb: 0 }
  ]
}
await writeFile(join(workspace, 'cues', 'cue-sheet.json'), JSON.stringify(sheet, null, 2))
await writeFile(join(workspace, 'cues', 'bare.json'), JSON.stringify([
  { name: 'no-path', at: 0 },
  { at: 1, path: 'assets/audio/hit.wav', fadeIn: 0.2 }
], null, 2))
await writeFile(join(workspace, 'cues', 'bad.json'), '{ this is not json')
await writeFile(join(workspace, 'cues.json'), JSON.stringify({ cues: [{ name: 'root', at: 0, path: 'assets/audio/hit.wav' }] }))
await writeFile(SECRET_FILE, JSON.stringify({ token: SECRET, secret: SECRET }))

let symlinkCreated = false
try {
  await symlink(SECRET_FILE, join(workspace, 'assets', 'audio', 'escape.wav'))
  symlinkCreated = true
} catch {
  // Windows without Developer Mode cannot create symlinks; the realpath check is
  // still exercised by the other traversal cases.
}

const realWorkspace = await realpath(workspace)

/* --------------------------------------------------------- plugin mount -- */

const routes = new Map()
function mountEditor (options = {}) {
  const map = new Map()
  const child = {
    webServer: {
      register ({ kind, path, handler }) {
        if (map.has(path)) throw new Error(`duplicate route ${path}`)
        map.set(path, { kind, path, handler })
        return () => map.delete(path)
      }
    },
    effect: (factory) => factory(),
    get: (name) => (name === 'workingDirectory' ? { defaultDirectory: options.root ?? realWorkspace } : undefined)
  }
  const ctx = options.ctx ?? {
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('webServer')) throw new Error('expected a webServer injection')
      callback(child)
    },
    get: (name) => (name === 'workingDirectory' ? { defaultDirectory: options.root ?? realWorkspace } : undefined)
  }
  const registered = registerEditorRoute(ctx, '0.0.0-test')
  return { map, registered }
}

const mounted = mountEditor()

/* --------------------------------------------------------------- driver -- */

function makeRequest ({ method = 'GET', url = '/', headers = {} } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = { 'sec-fetch-site': 'same-origin', ...headers }
  request.destroy = () => {}
  process.nextTick(() => request.emit('end'))
  return request
}

function makeResponse () {
  return {
    statusCode: null,
    headers: {},
    headersSent: false,
    payload: null,
    writeHead (status, headers) {
      this.statusCode = status
      this.headersSent = true
      this.headers = headers ?? {}
    },
    end (body) {
      if (body !== undefined && body !== null) {
        this.payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      }
    }
  }
}

function header (result, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(result.headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

async function callRoute (path, { query = '', method = 'GET', headers = {} } = {}) {
  const route = mounted.map.get(path)
  if (route === undefined) throw new Error(`route ${path} is not registered`)
  const response = makeResponse()
  await route.handler(makeRequest({ method, url: path + query, headers }), response)
  const buffer = response.payload ?? Buffer.alloc(0)
  const text = buffer.toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { /* not a JSON route */ }
  return { status: response.statusCode, headers: response.headers, buffer, text, json }
}

const project = (query, options) => callRoute(EDITOR_PATHS.project, { query, ...options })
const file = (query, options) => callRoute(EDITOR_PATHS.file, { query, ...options })
const list = (query, options) => callRoute(EDITOR_PATHS.list, { query, ...options })

async function treeSnapshot (dir) {
  const out = {}
  async function walk (current, prefix) {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(full, rel)
      else out[rel] = createHash('sha256').update(await readFile(full)).digest('hex')
    }
  }
  await walk(dir, '')
  return out
}

const before = await treeSnapshot(workspace)

/* --------------------------------------------------------- route surface -- */

section('1. route surface')
{
  const expected = [EDITOR_PATHS.page, EDITOR_PATHS.info, EDITOR_PATHS.project, EDITOR_PATHS.file, EDITOR_PATHS.list]
  console.log(`  routes: ${[...mounted.map.keys()].join(', ')}`)
  check('registerEditorRoute reported a mount', mounted.registered === true)
  check('five routes are registered', mounted.map.size === 5, String(mounted.map.size))
  for (const path of expected) {
    check(`route ${path} exists`, mounted.map.has(path))
    check(`route ${path} is exact`, mounted.map.get(path)?.kind === 'exact', String(mounted.map.get(path)?.kind))
  }
}

/* ----------------------------------------------------------------- page -- */

section('2. page document')
{
  const result = await callRoute(EDITOR_PATHS.page)
  console.log(`  HTTP ${result.status} · ${result.buffer.length} B · ${header(result, 'content-type')}`)
  check('page answers 200', result.status === 200, String(result.status))
  check('page is text/html', /^text\/html/.test(header(result, 'content-type') ?? ''), header(result, 'content-type'))
  check('page declares no-store', header(result, 'cache-control') === 'no-store', header(result, 'cache-control'))
  check('page length header matches the body', Number(header(result, 'content-length')) === result.buffer.length)
  check('page starts with a doctype', result.text.startsWith('<!doctype html>'))
  check('page carries the editor marker', result.text.includes('data-dsh-editor="1"'))
  for (const marker of EDITOR_PAGE_MARKERS) {
    check(`marker ${marker} is present`, result.text.includes(marker))
  }
  check('page is one self-contained document', result.text.length > 20000, `${result.text.length} chars`)
  check('page has a Chinese title', result.text.includes('cue 编辑器'))
  check('page has no external stylesheet', !/\<link\b/i.test(result.text))
  check('page has exactly one script element', (result.text.match(/<script\b/g) ?? []).length === 1)
  check('that script is inline', /<script>/.test(result.text))
  check('page has no http(s) URL at all', !/https?:\/\//.test(result.text))
  check('page has no protocol-relative URL', !/["'(]\/\/[a-z0-9]/i.test(result.text))
  check('page declares a same-origin CSP', /connect-src 'self'/.test(header(result, 'content-security-policy') ?? ''))
  check('page forbids external sources by default', /default-src 'none'/.test(header(result, 'content-security-policy') ?? ''))

  // Every element the script looks up must exist in the markup: a typo here is
  // a null dereference at runtime, which the browser test would only catch as
  // "something did not work".
  const ids = new Set([...result.text.matchAll(/byId\('([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]))
  const htmlIds = new Set([...result.text.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]))
  const missing = [...ids].filter((id) => !htmlIds.has(id))
  console.log(`  script looks up ${ids.size} element id(s); markup defines ${htmlIds.size}`)
  check('every byId target exists in the markup', missing.length === 0, missing.join(', '))
  check('the timeline lane container exists', htmlIds.has('lanes'))
  check('the export pane exists', htmlIds.has('export-text'))
  check('the inspector fields exist', ['f-name', 'f-at', 'f-gain', 'f-in', 'f-out', 'f-loop'].every((id) => htmlIds.has(id)))
}

section('3. info endpoint')
{
  const result = await callRoute(EDITOR_PATHS.info)
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} · root=${body.root} source=${body.rootSource} version=${body.version}`)
  check('info answers 200', result.status === 200)
  check('info is JSON', /^application\/json/.test(header(result, 'content-type') ?? ''))
  check('info reports ok', body.ok === true)
  check('info reports the workspace root', body.root === realWorkspace, String(body.root))
  check('info names where the root came from', body.rootSource === 'workingDirectory.defaultDirectory', String(body.rootSource))
  check('info echoes the version', body.version === '0.0.0-test', String(body.version))
  check('info says the editor is read-only', body.readOnly === true)
  check('info publishes the wav limit', body.limits?.wavBytes === EDITOR_LIMITS.wavBytes)
  check('info publishes the cue fields', Array.isArray(body.fields) && body.fields.includes('loop'))
  check('info publishes the routes', body.routes?.page === EDITOR_PATHS.page)
}

section('4. project: an audio_bind style sheet')
{
  const result = await project(`?path=${encodeURIComponent('cues/cue-sheet.json')}`)
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} · ${body.cueCount} cue(s) · duration=${body.duration} · ${result.buffer.length} B`)
  check('project answers 200', result.status === 200)
  check('project reports ok', body.ok === true)
  check('project keeps the declared duration', body.duration === 6, String(body.duration))
  check('project reports three cues', body.cueCount === 3, String(body.cueCount))
  const [hit, bed, voice] = body.cues ?? []
  check('cue 1 keeps its name', hit?.name === 'hit', String(hit?.name))
  check('cue 1 keeps at', hit?.at === 0.5, String(hit?.at))
  check('cue 1 keeps gainDb', hit?.gainDb === -2, String(hit?.gainDb))
  check('cue 1 keeps fades', hit?.fadeIn === 0.05 && hit?.fadeOut === 0.1, `${hit?.fadeIn}/${hit?.fadeOut}`)
  check('cue 1 is readable from the workspace', hit?.readable === 'assets/audio/hit.wav', String(hit?.readable))
  check('cue 1 has its wav duration from the header', Math.abs((hit?.wavDuration ?? 0) - 0.5) < 0.01, String(hit?.wavDuration))
  check('cue 1 has its sample rate', hit?.sampleRate === 24000, String(hit?.sampleRate))
  check('cue 2 read from src', bed?.readable === 'assets/audio/bed.wav', String(bed?.readable))
  check('cue 2 keeps loop', bed?.loop === true)
  check('cue 2 src is reported', bed?.src === 'assets/audio/bed.wav', String(bed?.src))
  check('cue 2 duration comes from the header', Math.abs((bed?.wavDuration ?? 0) - 1.2) < 0.01, String(bed?.wavDuration))
  check('cue 3 is flagged inline', voice?.inline === true)
  check('cue 3 has no readable wav', voice?.readable === null, String(voice?.readable))
  check('cue 3 explains why', typeof voice?.readError === 'string' && voice.readError.length > 0, String(voice?.readError))
  check('cue 3 inline base64 is counted, not echoed', voice?.inlineBytes > 0 && voice?.src === '', `${voice?.inlineBytes}/${voice?.src}`)
  check('the response carries no inline data URI', !result.text.includes('data:audio') && !result.text.includes('base64'))
  check('unknown sheet keys are reported', Array.isArray(body.ignored) && body.ignored.includes('basePath'), JSON.stringify(body.ignored))
  check('project path is workspace-relative', body.path === 'cues/cue-sheet.json', String(body.path))
}

section('5. project: bare array, defaults')
{
  const result = await project(`?path=${encodeURIComponent('cues/bare.json')}`)
  const body = result.json ?? {}
  console.log(`  HTTP ${result.status} · names=${JSON.stringify((body.cues ?? []).map((cue) => cue.name))}`)
  check('bare array is accepted', result.status === 200 && body.cueCount === 2, String(result.status))
  check('a missing name is defaulted', body.cues?.[1]?.name === 'cue-2', String(body.cues?.[1]?.name))
  check('a cue without a path says so', /路径/.test(body.cues?.[0]?.readError ?? ''), String(body.cues?.[0]?.readError))
  check('a cue with a path is readable', body.cues?.[1]?.readable === 'assets/audio/hit.wav', String(body.cues?.[1]?.readable))
  check('fadeIn survives', body.cues?.[1]?.fadeIn === 0.2, String(body.cues?.[1]?.fadeIn))
  check('a project without a declared duration reports 0', body.duration === 0, String(body.duration))
}

section('6. project: refusals')
{
  const cases = [
    ['missing path', '', 400, 'missing-path'],
    ['empty path', '?path=', 400, 'missing-path'],
    ['dot-dot traversal', `?path=${encodeURIComponent('../editor-outside/secret.json')}`, 400, 'escape'],
    ['deep dot-dot traversal', `?path=${encodeURIComponent('assets/../../editor-outside/secret.json')}`, 400, 'escape'],
    ['backslash traversal', `?path=${encodeURIComponent('..\\editor-outside\\secret.json')}`, 400, 'escape'],
    ['url-encoded dots', '?path=%2e%2e%2feditor-outside%2fsecret.json', 400, 'escape'],
    ['unix absolute path', '?path=%2Fetc%2Fpasswd', 400, 'absolute-path'],
    ['windows absolute path', `?path=${encodeURIComponent('C:\\Windows\\win.ini')}`, 400, 'absolute-path'],
    ['home path', '?path=%7E%2Fsecrets.json', 400, 'absolute-path'],
    ['control character', '?path=a%00b.json', 400, 'bad-path'],
    ['wrong extension', `?path=${encodeURIComponent('assets/audio/hit.wav')}`, 400, 'bad-extension'],
    ['a directory', '?path=assets', 400, 'bad-extension']
  ]
  for (const [label, query, status, code] of cases) {
    const result = await project(query)
    const body = result.json ?? {}
    console.log(`  ${label.padEnd(22)} -> HTTP ${result.status} ${body.code ?? ''} ${JSON.stringify(body.error ?? '')}`)
    check(`${label}: refused`, result.status === status, String(result.status))
    check(`${label}: code is ${code}`, body.code === code, String(body.code))
    check(`${label}: no secret leaks`, !result.text.includes(SECRET) && !result.text.includes('root:x:'))
    check(`${label}: no stack trace`, !/\n\s+at /.test(result.text))
  }
  const missing = await project(`?path=${encodeURIComponent('cues/nope.json')}`)
  console.log(`  missing file           -> HTTP ${missing.status} ${missing.json?.code ?? ''}`)
  check('a missing project is 404', missing.status === 404, String(missing.status))
  check('a missing project says not-found', missing.json?.code === 'not-found', String(missing.json?.code))
  const badJson = await project(`?path=${encodeURIComponent('cues/bad.json')}`)
  console.log(`  malformed JSON         -> HTTP ${badJson.status} ${badJson.json?.code ?? ''}`)
  check('malformed JSON is 400', badJson.status === 400, String(badJson.status))
  check('malformed JSON is coded bad-json', badJson.json?.code === 'bad-json', String(badJson.json?.code))
}

section('7. file endpoint')
{
  const result = await file(`?path=${encodeURIComponent('assets/audio/hit.wav')}`)
  console.log(`  HTTP ${result.status} · ${result.buffer.length} B · ${header(result, 'content-type')} · duration ${header(result, 'x-dsh-audio-duration')}`)
  check('wav answers 200', result.status === 200, String(result.status))
  check('wav is served as audio/wav', header(result, 'content-type') === 'audio/wav', header(result, 'content-type'))
  check('wav bytes are identical to the file', result.buffer.equals(hitWav))
  check('wav content-length matches', Number(header(result, 'content-length')) === hitWav.length)
  check('wav duration header is the real duration', Math.abs(Number(header(result, 'x-dsh-audio-duration')) - 0.5) < 0.01, header(result, 'x-dsh-audio-duration'))
  check('wav sample rate header is real', Number(header(result, 'x-dsh-audio-sample-rate')) === 24000, header(result, 'x-dsh-audio-sample-rate'))
  check('wav channels header is real', Number(header(result, 'x-dsh-audio-channels')) === 1, header(result, 'x-dsh-audio-channels'))

  const notWav = await file(`?path=${encodeURIComponent('assets/audio/broken.wav')}`)
  console.log(`  broken.wav             -> HTTP ${notWav.status} ${notWav.json?.code ?? ''} ${JSON.stringify(notWav.json?.error ?? '')}`)
  check('a non-RIFF .wav is refused', notWav.status === 400, String(notWav.status))
  check('a non-RIFF .wav is coded not-wav', notWav.json?.code === 'not-wav', String(notWav.json?.code))
  check('the refused file body is not echoed', !notWav.text.includes('not a riff file'))

  const jsonThroughFile = await file(`?path=${encodeURIComponent('cues/cue-sheet.json')}`)
  check('a json is not readable through /file', jsonThroughFile.status === 400 && jsonThroughFile.json?.code === 'bad-extension', String(jsonThroughFile.status))

  const traversal = await file('?path=%2e%2e%2feditor-outside%2fsecret.json')
  check('file traversal is refused', traversal.status === 400 || traversal.status === 404, String(traversal.status))
  check('file traversal leaks nothing', !traversal.text.includes(SECRET))

  const missing = await file(`?path=${encodeURIComponent('assets/audio/nope.wav')}`)
  check('a missing wav is 404', missing.status === 404, String(missing.status))

  if (symlinkCreated) {
    const escaped = await file(`?path=${encodeURIComponent('assets/audio/escape.wav')}`)
    console.log(`  symlink out of workspace -> HTTP ${escaped.status} ${escaped.json?.code ?? ''}`)
    check('a symlink pointing outside is refused', escaped.status === 400 && escaped.json?.code === 'escape', `${escaped.status}/${escaped.json?.code}`)
    check('the symlink target is not leaked', !escaped.text.includes(SECRET))
  } else {
    console.log('  SKIP: symlinks unavailable on this machine')
  }
}

section('8. list endpoint')
{
  const root = await list()
  const body = root.json ?? {}
  console.log(`  root -> HTTP ${root.status} dirs=${JSON.stringify((body.dirs ?? []).map((entry) => entry.name))} files=${JSON.stringify((body.files ?? []).map((entry) => entry.name))}`)
  check('list answers 200', root.status === 200, String(root.status))
  check('root lists the assets directory', (body.dirs ?? []).some((entry) => entry.path === 'assets'))
  check('root lists the cues directory', (body.dirs ?? []).some((entry) => entry.path === 'cues'))
  check('root lists the cue sheet at the top', (body.files ?? []).some((entry) => entry.path === 'cues.json' && entry.kind === 'json'))
  check('hidden entries are skipped', !(body.dirs ?? []).some((entry) => entry.name === '.hidden'))
  check('non-audio files are skipped', !(body.files ?? []).some((entry) => entry.name === 'notes.txt'))
  check('root has no parent', body.parent === null, String(body.parent))
  check('root dir is empty string', body.dir === '', JSON.stringify(body.dir))

  // The order must not depend on the machine locale: code-unit sorts Z2 < _5 < a1,
  // while localeCompare in a typical locale sorts _5 < a1 < Z2. A locale-dependent
  // sort also changes which entries survive the truncation cutoff.
  const dirNames = (body.dirs ?? []).map((entry) => entry.name)
  const fileNames = (body.files ?? []).map((entry) => entry.name)
  console.log(`  sort probe: dirs=${JSON.stringify(dirNames)} files=${JSON.stringify(fileNames)}`)
  check('locale-probe directories are all listed',
    ['Z2', '_5', 'a1'].every((name) => dirNames.includes(name)), JSON.stringify(dirNames))
  check('locale-probe files are all listed',
    ['Z2.json', '_5.json', 'a1.json'].every((name) => fileNames.includes(name)), JSON.stringify(fileNames))
  check('directories sort by code unit (Z2, _5, a1)',
    JSON.stringify(dirNames.filter((name) => ['Z2', '_5', 'a1'].includes(name))) === JSON.stringify(['Z2', '_5', 'a1']),
    JSON.stringify(dirNames))
  check('files sort by code unit (Z2, _5, a1)',
    JSON.stringify(fileNames.filter((name) => ['Z2.json', '_5.json', 'a1.json'].includes(name))) === JSON.stringify(['Z2.json', '_5.json', 'a1.json']),
    JSON.stringify(fileNames))

  const audio = await list(`?dir=${encodeURIComponent('assets/audio')}`)
  const audioBody = audio.json ?? {}
  console.log(`  assets/audio -> HTTP ${audio.status} files=${JSON.stringify((audioBody.files ?? []).map((entry) => entry.name))}`)
  check('a subdirectory is listed', audio.status === 200 && audioBody.dir === 'assets/audio', `${audio.status}/${audioBody.dir}`)
  check('wav files are listed', (audioBody.files ?? []).filter((entry) => entry.kind === 'wav').length >= 3)
  check('a listed wav carries a human size', /B|KB|MB/.test(audioBody.files?.[0]?.sizeText ?? ''), String(audioBody.files?.[0]?.sizeText))
  check('a subdirectory knows its parent', audioBody.parent === 'assets', String(audioBody.parent))

  for (const [label, query] of [
    ['dot-dot directory', `?dir=${encodeURIComponent('../editor-outside')}`],
    ['absolute directory', `?dir=${encodeURIComponent('C:\\Windows')}`],
    ['a file as directory', '?dir=notes.txt']
  ]) {
    const refused = await list(query)
    console.log(`  ${label.padEnd(20)} -> HTTP ${refused.status} ${refused.json?.code ?? ''}`)
    check(`${label} is refused`, refused.status === 400, String(refused.status))
    check(`${label} leaks nothing`, !refused.text.includes(SECRET))
  }
}

section('9. method and origin guards')
{
  for (const path of [EDITOR_PATHS.page, EDITOR_PATHS.info, EDITOR_PATHS.project, EDITOR_PATHS.file, EDITOR_PATHS.list]) {
    const posted = await callRoute(path, { method: 'POST' })
    check(`${path}: POST is 405`, posted.status === 405, String(posted.status))
    check(`${path}: POST says GET only`, header(posted, 'allow') === 'GET', String(header(posted, 'allow')))
    check(`${path}: POST notes ok=false`, posted.json?.ok === false)
  }
  const crossSite = await project(`?path=${encodeURIComponent('cues/cue-sheet.json')}`, { headers: { 'sec-fetch-site': 'cross-site' } })
  console.log(`  cross-site -> HTTP ${crossSite.status} ${JSON.stringify(crossSite.json?.error)}`)
  check('cross-site is refused with 403', crossSite.status === 403, String(crossSite.status))
  check('cross-site leaks nothing', !crossSite.text.includes(SECRET))
}

section('10. read-only')
{
  const after = await treeSnapshot(workspace)
  const changed = Object.keys(after).filter((key) => after[key] !== before[key])
  const added = Object.keys(after).filter((key) => !(key in before))
  const removed = Object.keys(before).filter((key) => !(key in after))
  console.log(`  workspace files ${Object.keys(before).length} -> ${Object.keys(after).length}`)
  check('no file content changed', changed.length === 0, changed.join(', '))
  check('no file was created', added.length === 0, added.join(', '))
  check('no file was deleted', removed.length === 0, removed.join(', '))
}

section('11. degradation without a web carrier')
{
  let deferred = null
  const deferredCtx = {
    inject: (deps, callback) => { deferred = callback },
    get: () => undefined
  }
  let threw = false
  let mountedWithoutCarrier = null
  try {
    mountedWithoutCarrier = registerEditorRoute(deferredCtx, '0.0.0-test')
  } catch {
    threw = true
  }
  console.log(`  deferred injection: returned=${mountedWithoutCarrier} callback-stored=${deferred !== null}`)
  check('a missing webServer does not throw', threw === false)
  check('the injection is left to the host', deferred !== null)
  check('the registration reports success for a deferred injection', mountedWithoutCarrier === true)
  // The page itself never depends on the carrier: it must render in any process.
  const page = renderEditorPage({ version: '9.9.9' })
  check('the page renders without the carrier', page.includes('data-dsh-editor="1"') && page.includes('v9.9.9'))
  const brokenCtx = { inject: () => { throw new Error('this composition cannot inject') } }
  let brokenThrew = false
  let brokenResult = null
  try { brokenResult = registerEditorRoute(brokenCtx, '0.0.0-test') } catch { brokenThrew = true }
  check('a ctx without a usable inject is survived', brokenThrew === false)
  check('the failed mount reports false', brokenResult === false, String(brokenResult))
}

section('12. workspace root fallback')
{
  const fallbackRoutes = new Map()
  const child = {
    webServer: {
      register ({ path, handler }) { fallbackRoutes.set(path, handler); return () => {} }
    },
    effect: (factory) => factory(),
    get: () => undefined
  }
  const ctx = {
    inject: (deps, callback) => callback(child),
    get: () => { throw new Error('workingDirectory is not installed') }
  }
  registerEditorRoute(ctx, '0.0.0-test')
  const response = makeResponse()
  await fallbackRoutes.get(EDITOR_PATHS.info)(makeRequest({ url: EDITOR_PATHS.info }), response)
  const body = JSON.parse(response.payload.toString('utf8'))
  const cwd = await realpath(process.cwd())
  console.log(`  fallback root: ${body.root} (${body.rootSource})`)
  check('without the service the launch directory is used', body.root === cwd, `${body.root} vs ${cwd}`)
  check('the fallback source is named', body.rootSource === 'process.cwd()', String(body.rootSource))
  const found = editorWorkspaceRoot({ get: () => ({ defaultDirectory: realWorkspace }) })
  check('editorWorkspaceRoot prefers the workspace service', found.root === realWorkspace && found.source === 'workingDirectory.defaultDirectory')
  const bad = editorWorkspaceRoot({ get: () => ({ defaultDirectory: 'not/absolute' }) })
  check('a relative defaultDirectory is ignored', bad.source === 'process.cwd()', bad.root)
}

section('13. sandbox unit checks')
{
  const ok = resolveWorkspacePath(realWorkspace, 'assets/audio/hit.wav')
  check('a relative path resolves under the root', ok === join(realWorkspace, 'assets', 'audio', 'hit.wav'))
  check('duplicate separators normalise', resolveWorkspacePath(realWorkspace, 'assets//audio/./hit.wav') === ok)
  const refusals = [
    ['..', '..'],
    ['a/../b', 'a/../b'],
    ['..\\x', '..\\x'],
    ['/etc/passwd', '/etc/passwd'],
    ['C:\\x', 'C:\\x'],
    ['~/.ssh', '~/.ssh'],
    ['', ''],
    ['.', '.']
  ]
  for (const [label, value] of refusals) {
    let error = null
    try { resolveWorkspacePath(realWorkspace, value) } catch (caught) { error = caught }
    check(`refuses ${JSON.stringify(label)}`, error instanceof ReadRefusedError, error === null ? 'no error' : error.name)
  }
  const cue = await normalizeCueDocument({ cues: [{ name: '  spaced  ', at: -5, gainDb: 99, fadeIn: -1, fadeOut: 1e9, loop: 1 }] }, realWorkspace)
  check('shared normalization is exported', typeof normalizeCueDocument === 'function')
  check('a negative at is clamped to 0', cue.cues[0].at === 0, String(cue.cues[0].at))
  check('gain is clamped', cue.cues[0].gainDb === 12, String(cue.cues[0].gainDb))
  check('fadeIn is clamped', cue.cues[0].fadeIn === 0, String(cue.cues[0].fadeIn))
  check('fadeOut is clamped', cue.cues[0].fadeOut === 60, String(cue.cues[0].fadeOut))
  check('loop is strictly boolean', cue.cues[0].loop === false, String(cue.cues[0].loop))
  check('a name is trimmed', cue.cues[0].name === 'spaced', JSON.stringify(cue.cues[0].name))
  let tooMany = null
  try {
    await normalizeCueDocument({ cues: Array.from({ length: EDITOR_LIMITS.cues + 1 }, () => ({})) }, realWorkspace)
  } catch (error) { tooMany = error }
  check('an oversized cue list is refused', tooMany instanceof ReadRefusedError && tooMany.status === 413)
  const probe = await probeWavFile(join(realWorkspace, 'assets', 'audio', 'bed.wav'))
  check('probeWavFile reads the header', probe.sampleRate === 22050 && Math.abs(probe.durationSeconds - 1.2) < 0.01, JSON.stringify(probe))
}

/* ------------------------------------------------------------------ tail -- */

console.log(`\n${checks} checks, ${failures} failure(s)`)
if (failures === 0) {
  console.log('OK: editor routes serve the page, the cue data and the wavs, and refuse every escape attempt')
} else {
  console.log(`FAILED: ${failures} check(s)`)
}
process.exit(failures === 0 ? 0 : 1)
