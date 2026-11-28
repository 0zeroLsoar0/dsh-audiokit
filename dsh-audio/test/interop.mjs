/**
 * Ecosystem layer tests: peer-plugin detection, the `handoffFor` notes, the
 * `audio_handoff` tool and the `ecosystem` field of `GET /dsh-audio/config`.
 *
 * The point of this layer is coordination, so the tests are built around
 * fictional profiles rather than the machine: each case creates a temporary
 * profile directory with a `package.json` and a fake `node_modules`, points
 * `DSH_PROFILE_DIR` at it, and asserts exactly what detection may and may not
 * claim. The cases that matter are the dishonest ones a naive implementation
 * gets wrong — reporting this plugin as its own peer, inventing capabilities for
 * an unknown plugin, failing on a corrupt manifest, leaking a profile path into
 * a "deterministic" result, or reporting a version for something that is
 * declared but not installed.
 *
 * `audio_handoff` is then driven through the real registered tool definition
 * (same fake Cordis context the other tool tests use) and its *file* is read
 * back: fields, Chinese instruction text, determinism (same bytes on a repeat,
 * content-hash default name), `target: null` with no peer, and cheap rejections
 * that must happen before anything is written. A stubbed `fetch` proves the
 * whole path is offline.
 *
 * Finally the real settings handler is mounted and `GET /dsh-audio/config` is
 * asserted to carry `ecosystem` next to the redacted config — and to carry no
 * key from the saved rows, which is the one security rule that field must not
 * break.
 *
 * Run: node test/interop.mjs
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITIES,
  capabilityNames,
  detectEcosystem,
  ecosystemStatus,
  handoffFor,
  pickHandoffTarget,
  profileDirectory,
  summarizeEcosystem
} from '../lib/interop.js'
import { registerSettingsRoute } from '../lib/settings-route.js'
import { registerHandoffTools } from '../lib/tools-handoff.js'

/* ------------------------------------------------------------- harness -- */

let checks = 0
let failures = 0

/** Count and report one assertion; a failure prints immediately next to its case. */
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return true
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

function oneLine (value, max = 140) {
  const flat = String(value).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Structural comparison through JSON: these are plain data by design. */
function sameJson (a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Run something that must not throw; returns `{ ok, value }` or `{ ok: false, error }`. */
async function attempt (run) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

// The environment is the input of this whole layer, so every case sets it and
// the real values are put back at the end.
const savedEnv = {
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  DSH_PROFILE: process.env.DSH_PROFILE,
  DSH_HOME: process.env.DSH_HOME
}
/** `undefined` removes the variable; a string sets it. */
function setEnv ({ profileDir, profile, home } = {}) {
  if (profileDir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = profileDir
  if (profile === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = profile
  if (home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = home
}

const workspace = await mkdtemp(join(tmpdir(), 'dsh-audio-interop-'))

/**
 * Create a fake DSH profile: `package.json` dependencies plus zero or more
 * installed plugin manifests under `node_modules`.
 * @param {string} name - profile directory name.
 * @param {{ dependencies?: object, install?: object }} [spec] - declared deps
 *   and the manifests that "exist".
 * @returns {Promise<string>} the profile directory.
 */
async function makeProfile (name, spec = {}) {
  const directory = join(workspace, 'profiles', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: spec.dependencies ?? {}
  }, null, 2))
  for (const [pluginName, manifest] of Object.entries(spec.install ?? {})) {
    const pluginDirectory = join(directory, 'node_modules', ...pluginName.split('/'))
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify(manifest, null, 2))
  }
  return directory
}

/** The capabilities `dsh-any-audio` is documented to own (see the design note). */
const ANY_AUDIO_CAPABILITIES = {
  instruments: true,
  soundfonts: true,
  voicebankSinging: true,
  ttsProviders: ['edge', 'mimo', 'deepseek'],
  dawUi: true,
  sfxLibrary: true
}

const peerProfile = await makeProfile('peer', {
  dependencies: {
    'dsh-any-audio': '^0.5.2',
    'dsh-video-storyboard': 'file:../video',
    '@local/dsh-audio': 'link:../../dsh-audio'
  },
  install: {
    'dsh-any-audio': { name: 'dsh-any-audio', version: '0.5.2' },
    'dsh-video-storyboard': { name: 'dsh-video-storyboard', version: '2.1.0' },
    // The linked copy of *this* plugin under the profile's usual alias: its
    // manifest name is what identifies it, exactly like a real `link:` install.
    '@local/dsh-audio': { name: 'dsh-audiokit', version: '0.6.0' }
  }
})

const unknownProfile = await makeProfile('unknown-peer', {
  dependencies: { 'dsh-audio-lab': '^1.2.3' },
  install: { 'dsh-audio-lab': { name: 'dsh-audio-lab', version: '1.2.3' } }
})

const emptyProfile = await makeProfile('empty', {
  dependencies: { 'dsh-video-storyboard': 'file:../video' },
  install: { 'dsh-video-storyboard': { name: 'dsh-video-storyboard', version: '2.1.0' } }
})

// Declared but never installed: the version cannot be resolved, and a brief
// must not pretend otherwise.
const declaredOnlyProfile = await makeProfile('declared-only', {
  dependencies: { 'dsh-any-audio': '^0.5.2' }
})

const brokenProfile = join(workspace, 'profiles', 'broken')
await mkdir(brokenProfile, { recursive: true })
await writeFile(join(brokenProfile, 'package.json'), '{ "name": "dsh-profile-broken", ')

// Dependency names are data: a name that shadows an `Object.prototype` key must
// not be read as a known plugin entry.
const prototypeProfile = await makeProfile('prototype-keys', {
  dependencies: { constructor: '1.0.0', hasOwnProperty: '1.0.0', toString: '1.0.0' }
})

const fileProfile = join(workspace, 'profiles', 'this-is-a-file')
await writeFile(fileProfile, 'not a directory\n')

const missingProfile = join(workspace, 'profiles', 'does-not-exist')

// A second home, used for the documented `DSH_HOME`+`DSH_PROFILE` fallback.
const fallbackHome = join(workspace, 'home')
await mkdir(join(fallbackHome, 'profiles', 'fallback', 'node_modules', 'dsh-any-audio'), { recursive: true })
await writeFile(join(fallbackHome, 'profiles', 'fallback', 'package.json'), JSON.stringify({
  name: 'dsh-profile-fallback',
  dependencies: { 'dsh-any-audio': '0.7.0' }
}, null, 2))
await writeFile(join(fallbackHome, 'profiles', 'fallback', 'node_modules', 'dsh-any-audio', 'package.json'), JSON.stringify({
  name: 'dsh-any-audio',
  version: '0.7.0'
}, null, 2))

/* --------------------------------------------------------- 1. profile -- */

section('1. which profile is read')
{
  const explicit = join(workspace, 'profiles', 'peer')
  check('DSH_PROFILE_DIR is the authority when it is set',
    profileDirectory({ DSH_PROFILE_DIR: explicit, DSH_HOME: 'ignored', DSH_PROFILE: 'ignored' }) === explicit,
    String(profileDirectory({ DSH_PROFILE_DIR: explicit, DSH_HOME: 'ignored', DSH_PROFILE: 'ignored' })))
  const composed = profileDirectory({ DSH_HOME: join(workspace, 'home'), DSH_PROFILE: 'fallback' })
  check('DSH_HOME + DSH_PROFILE composes the documented fallback',
    composed === join(workspace, 'home', 'profiles', 'fallback'), String(composed))
  check('no profile at all resolves to null instead of a guess', profileDirectory({}) === null, String(profileDirectory({})))
  const withoutDir = await attempt(() => detectEcosystem({ env: {} }))
  check('an environment with no profile detects nothing and throws nothing',
    withoutDir.ok && Array.isArray(withoutDir.value.plugins) && withoutDir.value.plugins.length === 0,
    withoutDir.ok ? JSON.stringify(withoutDir.value) : String(withoutDir.error?.message))
}

/* --------------------------------------------------- 2. known peer -- */

section('2. a declared, installed peer audio plugin')
{
  setEnv({ profileDir: peerProfile })
  const ecosystem = detectEcosystem()
  console.log(`  ${JSON.stringify(ecosystem)}`)
  check('exactly one peer is detected', ecosystem.plugins.length === 1, JSON.stringify(ecosystem.plugins.map((plugin) => plugin.name)))
  const peer = ecosystem.plugins[0] ?? {}
  check('the peer is dsh-any-audio', peer.name === 'dsh-any-audio', String(peer.name))
  check('the version comes from node_modules/<name>/package.json', peer.version === '0.5.2', String(peer.version))
  check('the known capability list is attached unchanged', sameJson(peer.capabilities, ANY_AUDIO_CAPABILITIES), JSON.stringify(peer.capabilities))
  check('the capability list covers the whole vocabulary',
    sameJson(capabilityNames(peer.capabilities), CAPABILITIES), JSON.stringify(capabilityNames(peer.capabilities)))
  check('an unrelated dependency is not recorded as an audio peer',
    !ecosystem.plugins.some((plugin) => plugin.name === 'dsh-video-storyboard'),
    JSON.stringify(ecosystem.plugins.map((plugin) => plugin.name)))
  check('this plugin is not reported as its own peer',
    !ecosystem.plugins.some((plugin) => plugin.name === 'dsh-audiokit' || plugin.name === '@local/dsh-audio'),
    JSON.stringify(ecosystem.plugins.map((plugin) => plugin.name)))

  // Determinism: no timestamps, no absolute paths, identical repeats. The
  // handoff brief names its file after a content hash, which only works when
  // this holds.
  const raw = JSON.stringify(ecosystem)
  check('detection repeats byte-identically', JSON.stringify(detectEcosystem()) === raw)
  check('detection carries no timestamp', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw), oneLine(raw))
  check('detection leaks no absolute profile path', !raw.includes(workspace), oneLine(raw))
  check('detection reports only name, version and capabilities',
    ecosystem.plugins.every((plugin) => sameJson(Object.keys(plugin).sort(), ['capabilities', 'name', 'version'])),
    JSON.stringify(Object.keys(ecosystem.plugins[0] ?? {})))
  check('the status line names the plugin, its version and the recommendation',
    summarizeEcosystem(ecosystem) === '检测到 AnyAudio v0.5.2：人声/音源建议交给它',
    summarizeEcosystem(ecosystem))
  check('the route view carries the same facts',
    sameJson(ecosystemStatus().plugins, ecosystem.plugins) && ecosystemStatus().summary === summarizeEcosystem(ecosystem),
    JSON.stringify(ecosystemStatus()))

  // A caller mutating a returned capability array must not change the next read:
  // the scan is cached and the copies are what keep the cache honest.
  peer.capabilities.ttsProviders.push('injected')
  const fresh = detectEcosystem()
  check('a mutated result does not poison the cache',
    sameJson(fresh.plugins[0].capabilities.ttsProviders, ['edge', 'mimo', 'deepseek']),
    JSON.stringify(fresh.plugins[0]?.capabilities?.ttsProviders))

  check('the handoff target is the detected peer',
    pickHandoffTarget(ecosystem)?.name === 'dsh-any-audio' && pickHandoffTarget(ecosystem)?.version === '0.5.2',
    JSON.stringify(pickHandoffTarget(ecosystem)))
}

/* ------------------------------------------------ 3. unknown peer -- */

section('3. an unknown peer is recorded, never invented')
{
  setEnv({ profileDir: unknownProfile })
  const ecosystem = detectEcosystem()
  const peer = ecosystem.plugins[0] ?? {}
  console.log(`  ${JSON.stringify(ecosystem)}`)
  check('a declared audio plugin with no table entry is recorded', peer.name === 'dsh-audio-lab', String(peer.name))
  check('its installed version is reported', peer.version === '1.2.3', String(peer.version))
  check('no capability is invented for it', sameJson(peer.capabilities, {}), JSON.stringify(peer.capabilities))
  check('the status line says the capability is unknown',
    /dsh-audio-lab v1\.2\.3/.test(summarizeEcosystem(ecosystem)) && /能力未知/.test(summarizeEcosystem(ecosystem)),
    summarizeEcosystem(ecosystem))
  check('an unknown peer is still a handoff target', pickHandoffTarget(ecosystem)?.name === 'dsh-audio-lab',
    JSON.stringify(pickHandoffTarget(ecosystem)))
  check('no capability note points at an unknown peer', handoffFor('voicebankSinging').available === false,
    JSON.stringify(handoffFor('voicebankSinging')))
}

/* ---------------------------------------------- 4. empty and broken -- */

section('4. no peer, broken manifests, unreadable profiles')
{
  setEnv({ profileDir: emptyProfile })
  const none = detectEcosystem()
  check('a profile with no audio dependency detects nothing', none.plugins.length === 0, JSON.stringify(none.plugins))
  check('the empty status line is still readable', summarizeEcosystem(none) === '未检测到同类音频插件', summarizeEcosystem(none))
  check('no target when no peer is installed', pickHandoffTarget(none) === null, JSON.stringify(pickHandoffTarget(none)))
  check('an empty profile is not a thrown error', ecosystemStatus().plugins.length === 0)

  setEnv({ profileDir: declaredOnlyProfile })
  const declared = detectEcosystem()
  check('a declared but uninstalled peer is still listed', declared.plugins[0]?.name === 'dsh-any-audio',
    JSON.stringify(declared.plugins))
  check('its version is null rather than invented', declared.plugins[0]?.version === null,
    JSON.stringify(declared.plugins[0]?.version))
  check('the status line marks the missing version',
    /版本未知/.test(summarizeEcosystem(declared)), summarizeEcosystem(declared))

  for (const [label, directory] of [
    ['a corrupt package.json', brokenProfile],
    ['a profile directory that does not exist', missingProfile],
    ['a profile path that is a file', fileProfile]
  ]) {
    setEnv({ profileDir: directory })
    const detected = await attempt(() => detectEcosystem())
    check(`${label} yields an empty detection instead of throwing`,
      detected.ok && selfPluginsEmpty(detected.value), detected.ok ? oneLine(JSON.stringify(detected.value)) : String(detected.error?.message))
  }

  // The documented fallback: DSH_PROFILE_DIR absent, DSH_HOME + DSH_PROFILE set.
  setEnv({ home: fallbackHome, profile: 'fallback' })
  const fallback = detectEcosystem()
  check('the DSH_HOME + DSH_PROFILE fallback reads the same layout',
    fallback.plugins[0]?.name === 'dsh-any-audio' && fallback.plugins[0]?.version === '0.7.0',
    JSON.stringify(fallback.plugins))

  setEnv({ profileDir: prototypeProfile })
  const prototypeKeys = await attempt(() => detectEcosystem())
  check('dependency names that shadow Object.prototype are not read as peers',
    prototypeKeys.ok && prototypeKeys.value.plugins.length === 0,
    prototypeKeys.ok ? JSON.stringify(prototypeKeys.value) : String(prototypeKeys.error?.message))
}

function selfPluginsEmpty (ecosystem) {
  return Array.isArray(ecosystem?.plugins) && ecosystem.plugins.length === 0
}

/* ------------------------------------------------------ 5. handoffFor -- */

section('5. handoffFor: whose capability is it')
{
  setEnv({ profileDir: peerProfile })
  const singing = handoffFor('voicebankSinging') ?? {}
  console.log(`  voicebankSinging -> ${JSON.stringify(singing)}`)
  check('voicebankSinging names the peer that owns it', singing.plugin === 'dsh-any-audio', String(singing.plugin))
  check('voicebankSinging is available when the peer is detected', singing.available === true, String(singing.available))
  check('voicebankSinging says singing belongs to the peer, in one line',
    singing.suggest === '演唱交给 dsh-any-audio；本插件不做合成唱腔', String(singing.suggest))
  check('voicebankSinging explains why this plugin cannot do it', typeof singing.reason === 'string' && singing.reason.length > 10, String(singing.reason))

  const kebab = handoffFor('voicebank-singing') ?? {}
  check('the kebab-case capability id resolves to the same note',
    kebab.capability === 'voicebankSinging' && kebab.suggest === singing.suggest, JSON.stringify(kebab))

  for (const capability of CAPABILITIES) {
    const note = handoffFor(capability)
    check(`handoffFor(${capability}) has a note that names a plugin and this plugin's side`,
      note !== null && note.plugin === 'dsh-any-audio' && note.suggest.includes('dsh-any-audio') && note.suggest.includes('本插件'),
      JSON.stringify(note?.suggest))
  }
  check('provider capability is detected as owned by the peer', handoffFor('ttsProviders')?.available === true,
    JSON.stringify(handoffFor('ttsProviders')))
  check('an unknown capability invents no advice', handoffFor('teleportation') === null && handoffFor('') === null,
    JSON.stringify(handoffFor('teleportation')))

  // Direct callers are public enough to pass junk; the helpers must not throw.
  const nullOptions = await attempt(() => handoffFor('voicebankSinging', null))
  check('handoffFor tolerates a null options object',
    nullOptions.ok && nullOptions.value?.capability === 'voicebankSinging', JSON.stringify(nullOptions.value ?? String(nullOptions.error?.message)))
  const nullDetect = await attempt(() => detectEcosystem(null))
  check('detectEcosystem tolerates a null options object',
    nullDetect.ok && Array.isArray(nullDetect.value.plugins), JSON.stringify(nullDetect.value ?? String(nullDetect.error?.message)))

  // With no peer installed the note still exists: the division of labour does
  // not depend on what happens to be installed, only `available` does.
  setEnv({ profileDir: emptyProfile })
  const unowned = handoffFor('instruments') ?? {}
  check('with no peer the note is kept but marked unavailable',
    unowned.plugin === null && unowned.available === false, JSON.stringify(unowned))
  check('the unavailable note still states the boundary',
    unowned.suggest.includes('dsh-any-audio') && unowned.suggest.length > 10, String(unowned.suggest))
}

/* ------------------------------------------------- 6. audio_handoff -- */

section('6. audio_handoff: the brief')
{
  const toolCwd = await mkdtemp(join(workspace, 'cwd-'))
  const tools = new Map()
  const services = new Map([['workingDirectory', { get: () => toolCwd }]])
  const ctx = {
    tools: {
      register (definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    get: (name) => services.get(name)
  }
  registerHandoffTools(ctx)
  const exec = { agent: { session: { id: 'interop' } } }

  async function invoke (name, args) {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`tool "${name}" was not registered`)
    try {
      return { ok: true, value: await definition.execute(args, exec) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  const definition = tools.get('audio_handoff')
  check('audio_handoff is registered', definition !== undefined)
  check('audio_handoff declares an object schema without extra properties',
    definition?.parameters?.type === 'object' && definition?.parameters?.additionalProperties === false)
  check('audio_handoff requires prompt and documents every argument',
    sameJson(definition?.parameters?.required, ['prompt']) &&
    ['prompt', 'durationSeconds', 'tracks', 'out'].every((name) => typeof definition?.parameters?.properties?.[name]?.description === 'string'))
  check('audio_handoff restricts a track role to the three documented ids',
    sameJson(definition?.parameters?.properties?.tracks?.items?.properties?.role?.enum, ['music', 'narration', 'sfx']),
    JSON.stringify(definition?.parameters?.properties?.tracks?.items?.properties?.role?.enum))
  // The host-schema rules `test/tool-schemas.mjs` enforces on every tool, so this
  // one is already compatible before `index.js` registers it.
  const schema = definition?.parameters ?? {}
  check('every top-level argument is typed and described',
    Object.values(schema.properties ?? {}).every((property) =>
      property.type !== undefined && String(property.description ?? '').trim().length > 10),
    JSON.stringify(Object.entries(schema.properties ?? {}).map(([name, property]) => `${name}:${property.type}`)))
  check('the nested track fields are typed and described',
    ['role', 'style'].every((name) => {
      const property = schema.properties?.tracks?.items?.properties?.[name]
      return property?.type === 'string' && String(property.description ?? '').trim().length > 10
    }), JSON.stringify(schema.properties?.tracks?.items?.properties))
  check('the description is a real tool description, not a placeholder',
    typeof definition?.description === 'string' && definition.description.length > 80 &&
    definition.description.length <= 12_000 && !/\b(TODO|FIXME|TBD)\b/.test(definition.description),
    `(${definition?.description?.length ?? 0} chars)`)
  check('audio_handoff declares the host contract',
    typeof definition?.execute === 'function' && typeof definition?.output?.render === 'function' &&
    definition?.isConcurrencySafe === true && typeof definition?.presentCall === 'function')

  setEnv({ profileDir: peerProfile })
  const prompt = '一段 30 秒的产品演示配乐'
  const args = {
    prompt,
    durationSeconds: 30,
    tracks: [
      { role: 'music', style: 'warm lofi' },
      { role: 'narration' },
      { role: 'sfx' }
    ],
    out: 'briefs/handoff.json'
  }
  const first = await invoke('audio_handoff', args)
  if (!first.ok) {
    check('audio_handoff writes a brief', false, String(first.error?.message ?? first.error))
  } else {
    const value = first.value
    const expectedPath = join(toolCwd, 'briefs', 'handoff.json')
    const raw = await readFile(expectedPath, 'utf8').catch(() => null)
    console.log(`  ${oneLine(value.text, 400).replace(/ \| /g, '\n  ')}`)
    check('the brief is written to the requested path', raw !== null && value.path === expectedPath, String(value.path))
    check('the result reports a display path and a byte count',
      value.relativePath === 'briefs/handoff.json' && value.bytes === Buffer.byteLength(raw ?? '', 'utf8'),
      `${String(value.relativePath)} · ${String(value.bytes)}`)

    const brief = JSON.parse(raw ?? '{}')
    check('the file is valid JSON with the format id', brief.schema === 'dsh-audiokit/handoff@1', String(brief.schema))
    check('the brief carries the prompt and the planned duration',
      brief.prompt === prompt && brief.durationSeconds === 30, JSON.stringify({ prompt: brief.prompt, durationSeconds: brief.durationSeconds }))
    check('the brief names the target plugin and its version',
      brief.target?.name === 'dsh-any-audio' && brief.target?.version === '0.5.2', JSON.stringify(brief.target))
    check('the brief carries the target capabilities',
      sameJson(brief.target?.capabilities, ANY_AUDIO_CAPABILITIES), JSON.stringify(brief.target?.capabilities))
    check('there is one row per requested track in order',
      sameJson(brief.tracks?.map((track) => track.role), ['music', 'narration', 'sfx']), JSON.stringify(brief.tracks?.map((track) => track.role)))
    check('a track keeps its style hint (and null when absent)',
      brief.tracks?.[0]?.style === 'warm lofi' && brief.tracks?.[1]?.style === null, JSON.stringify(brief.tracks?.map((track) => track.style)))
    check('each track names the capability that owns it',
      brief.tracks?.[0]?.capability === 'instruments' && brief.tracks?.[1]?.capability === 'ttsProviders' && brief.tracks?.[2]?.capability === 'sfxLibrary',
      JSON.stringify(brief.tracks?.map((track) => track.capability)))
    check('each track is owned by the detected peer',
      brief.tracks?.every((track) => track.owner === 'dsh-any-audio'), JSON.stringify(brief.tracks?.map((track) => track.owner)))
    check('each track has a request, a boundary and an acceptance step',
      brief.tracks?.every((track) =>
        typeof track.ask === 'string' && track.ask.length > 8 &&
        typeof track.boundary === 'string' && track.boundary.includes('dsh-any-audio') &&
        typeof track.acceptance === 'string' && /audio_(probe|loudness|check)/.test(track.acceptance)),
      JSON.stringify(brief.tracks))
    check('the instruction is addressed to the peer and repeats the goal',
      typeof brief.instruction === 'string' &&
      brief.instruction.includes('dsh-any-audio') && brief.instruction.includes(prompt) &&
      brief.instruction.includes('时长：约 30 秒') && brief.instruction.includes('验收：'),
      oneLine(brief.instruction ?? '', 300))
    check('the instruction states the no-cross-call boundary',
      /不调用你的工具/.test(brief.instruction ?? '') && /交接合同/.test(brief.instruction ?? ''), oneLine(brief.instruction ?? '', 300))
    check('the acceptance list is deduplicated', Array.isArray(brief.acceptance) &&
      brief.acceptance.length === new Set(brief.acceptance).size && brief.acceptance.length >= 2,
      JSON.stringify(brief.acceptance))
    check('the brief has no timestamp', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw ?? ''), oneLine(raw ?? '', 200))
    check('the result carries the ecosystem summary',
      value.ecosystem?.plugins?.some((plugin) => plugin.name === 'dsh-any-audio') &&
      value.ecosystem?.summary === summarizeEcosystem(detectEcosystem()),
      JSON.stringify(value.ecosystem?.summary))
    check('the short text names the file, the target and the tracks',
      value.text.includes('briefs/handoff.json') && value.text.includes('目标：dsh-any-audio v0.5.2') &&
      value.text.includes('music / narration / sfx'), oneLine(value.text))

    // Determinism: same arguments, same bytes in the same file.
    const repeat = await invoke('audio_handoff', args)
    const repeatRaw = await readFile(expectedPath, 'utf8').catch(() => null)
    check('a repeated call rewrites identical bytes', repeat.ok && repeatRaw === raw && repeat.value.bytes === value.bytes)

    // The default name is a content hash, so two calls without `out` land on one
    // file instead of growing a directory of near-identical briefs.
    const defaulted = await invoke('audio_handoff', { prompt, durationSeconds: 30, tracks: [{ role: 'music', style: 'warm lofi' }, { role: 'narration' }, { role: 'sfx' }] })
    const defaultedAgain = await invoke('audio_handoff', { prompt, durationSeconds: 30, tracks: [{ role: 'music', style: 'warm lofi' }, { role: 'narration' }, { role: 'sfx' }] })
    check('the default output name is assets/audio/handoff-<content hash>.json',
      /^assets\/audio\/handoff-[0-9a-f]{10}\.json$/.test(defaulted.value?.relativePath ?? ''), String(defaulted.value?.relativePath))
    check('the default path is stable across identical calls',
      defaultedAgain.ok && defaultedAgain.value.path === defaulted.value.path &&
      defaultedAgain.value.bytes === defaulted.value.bytes,
      `${String(defaulted.value?.relativePath)} vs ${String(defaultedAgain.value?.relativePath)}`)
  }

  // No peer installed: the brief is still written, with target null.
  setEnv({ profileDir: emptyProfile })
  const lonely = await invoke('audio_handoff', {
    prompt: '一段没有人声的环境铺底',
    tracks: [{ role: 'music' }],
    out: 'briefs/no-peer'
  })
  if (!lonely.ok) {
    check('audio_handoff writes a brief with no peer', false, String(lonely.error?.message ?? lonely.error))
  } else {
    const path = join(toolCwd, 'briefs', 'no-peer.json')
    const brief = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'))
    check('the missing extension is supplied for a bare out name', lonely.value.path === path, String(lonely.value.path))
    check('target is null when no peer is detected', lonely.value.target === null && brief.target === null, JSON.stringify(brief.target))
    check('the brief still contains per-track advice',
      brief.tracks?.length === 1 && brief.tracks[0].role === 'music' && brief.tracks[0].ask.length > 8 && brief.tracks[0].owner === null,
      JSON.stringify(brief.tracks))
    check('the instruction says nothing was detected',
      /没有检测到可接手的同类音频插件/.test(brief.instruction ?? '') && /没有检测到/.test(brief.instruction ?? ''),
      oneLine(brief.instruction ?? '', 220))
    check('the short text marks the empty target', lonely.value.text.includes('目标：null'), oneLine(lonely.value.text))
    check('the ecosystem in the result is empty, not missing',
      Array.isArray(lonely.value.ecosystem?.plugins) && lonely.value.ecosystem.plugins.length === 0,
      JSON.stringify(lonely.value.ecosystem))
  }

  // Cheap rejections: before detection, before any write, and always a plain
  // `Error` that names the offending argument.
  const before = (await readdir(toolCwd, { recursive: true }).catch(() => [])).sort()
  const badCalls = [
    ['missing prompt', {}, /prompt/],
    ['blank prompt', { prompt: '   ' }, /prompt/],
    ['prompt over the limit', { prompt: 'x'.repeat(2001) }, /2000/],
    ['duration below the range', { prompt: 'music', durationSeconds: 0.5 }, /durationSeconds/],
    ['duration above the range', { prompt: 'music', durationSeconds: 9999 }, /durationSeconds/],
    ['NaN duration', { prompt: 'music', durationSeconds: NaN }, /durationSeconds/],
    ['tracks not an array', { prompt: 'music', tracks: 'music' }, /tracks/],
    ['unknown role', { prompt: 'music', tracks: [{ role: 'drums' }] }, /tracks\[0\]\.role/],
    ['track not an object', { prompt: 'music', tracks: [null] }, /tracks\[0\]/],
    ['non-string style', { prompt: 'music', tracks: [{ role: 'music', style: 8 }] }, /tracks\[0\]\.style/],
    ['non-string out', { prompt: 'music', out: 42 }, /out/]
  ]
  for (const [label, badArgs, match] of badCalls) {
    const outcome = await invoke('audio_handoff', badArgs)
    const message = String(outcome.error?.message ?? '')
    check(`audio_handoff rejects ${label}`,
      !outcome.ok && outcome.error instanceof Error && outcome.error.constructor === Error && match.test(message),
      outcome.ok ? 'accepted the invalid call' : `${outcome.error?.constructor?.name}: ${message}`)
  }
  const after = (await readdir(toolCwd, { recursive: true }).catch(() => [])).sort()
  check('no rejected call wrote a file', sameJson(before, after), after.filter((entry) => !before.includes(entry)).join(', '))

  // Offline: the whole layer is file-system facts plus string building.
  setEnv({ profileDir: peerProfile })
  const realFetch = globalThis.fetch
  const fetches = []
  globalThis.fetch = async (url) => {
    fetches.push(String(url))
    throw new Error('offline test: fetch must not be called')
  }
  try {
    const offline = await invoke('audio_handoff', { prompt: '离线检查', out: 'briefs/offline.json' })
    check('audio_handoff works with no network access', offline.ok, String(offline.error?.message ?? offline.error))
    check('audio_handoff made no network request', fetches.length === 0, JSON.stringify(fetches))
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ------------------------------------------- 7. GET /config ecosystem -- */

section('7. GET /dsh-audio/config exposes ecosystem and no key')
{
  // The saved rows carry real-looking keys on purpose: the view must never echo
  // them, and the new field is read on every settings-page load.
  const config = {
    tts: {
      provider: 'minimax',
      baseUrl: 'https://api.minimax.chat',
      model: 'speech-2.8-hd',
      apiKey: 'secret-tts-key',
      apiKeyEnv: 'MINIMAX_API_KEY'
    },
    check: { enabled: false, apiKey: 'secret-check-key' }
  }
  const routes = new Map()
  const child = {
    webServer: {
      register ({ kind, path, handler }) {
        routes.set(path, { kind, path, handler })
        return () => {}
      }
    },
    effect: (factory) => factory(),
    get: () => undefined
  }
  registerSettingsRoute({ inject: (_dependencies, callback) => callback(child) }, config, '0.0.0-test')

  function makeResponse () {
    return {
      statusCode: null,
      headers: null,
      payload: null,
      writeHead (status, headers) { this.statusCode = status; this.headers = headers },
      end (body) { this.payload = String(body) }
    }
  }

  async function getConfig () {
    const route = routes.get('/dsh-audio/config')
    if (route === undefined) throw new Error('/dsh-audio/config was not registered')
    const response = makeResponse()
    // GET is not same-origin gated: it only reads the redacted view.
    await route.handler({ method: 'GET', headers: {} }, response)
    return { status: response.statusCode, raw: response.payload, json: JSON.parse(response.payload) }
  }

  setEnv({ profileDir: peerProfile })
  const view = await getConfig()
  console.log(`  HTTP ${view.status} · ecosystem=${oneLine(JSON.stringify(view.json?.ecosystem), 220)}`)
  check('GET /config still answers 200 with ok=true', view.status === 200 && view.json?.ok === true)
  check('GET /config carries an ecosystem object', view.json?.ecosystem !== null && typeof view.json?.ecosystem === 'object',
    JSON.stringify(view.json?.ecosystem))
  check('ecosystem.plugins is an array', Array.isArray(view.json?.ecosystem?.plugins),
    JSON.stringify(view.json?.ecosystem?.plugins))
  check('the detected peer travels with the config view',
    view.json?.ecosystem?.plugins?.[0]?.name === 'dsh-any-audio' && view.json?.ecosystem?.plugins?.[0]?.version === '0.5.2',
    JSON.stringify(view.json?.ecosystem?.plugins))
  check('the ecosystem summary is included',
    view.json?.ecosystem?.summary === '检测到 AnyAudio v0.5.2：人声/音源建议交给它',
    JSON.stringify(view.json?.ecosystem?.summary))
  check('the saved API keys are still not echoed',
    !view.raw.includes('secret-tts-key') && !view.raw.includes('secret-check-key') && view.json?.config?.tts?.keySet === true,
    oneLine(view.raw, 180))
  const ecosystemRaw = JSON.stringify(view.json?.ecosystem)
  check('the ecosystem field carries no key material or key-shaped field',
    !/secret|apiKey|api_key|API_KEY|token|credential/i.test(ecosystemRaw), oneLine(ecosystemRaw))
  check('the rest of the config view is unchanged',
    view.json?.config?.tts?.model === 'speech-2.8-hd' && view.json?.config?.check?.enabled === false,
    JSON.stringify(view.json?.config))

  // Detection failure is data, not a broken settings page: empty list, still 200.
  setEnv({ profileDir: missingProfile })
  const broken = await getConfig()
  check('a failed detection still answers 200', broken.status === 200 && broken.json?.ok === true, String(broken.status))
  check('a failed detection reports an empty plugin array',
    Array.isArray(broken.json?.ecosystem?.plugins) && broken.json.ecosystem.plugins.length === 0,
    JSON.stringify(broken.json?.ecosystem?.plugins))
  check('a failed detection keeps the status line readable',
    typeof broken.json?.ecosystem?.summary === 'string' && broken.json.ecosystem.summary.length > 0,
    JSON.stringify(broken.json?.ecosystem?.summary))
}

/* ---------------------------------------------------------------- done -- */

setEnv({
  profileDir: savedEnv.DSH_PROFILE_DIR,
  profile: savedEnv.DSH_PROFILE,
  home: savedEnv.DSH_HOME
})
await rm(workspace, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0
  ? 'OK: peer plugins are detected from the profile (deterministic, offline), handoff notes are honest about availability, audio_handoff writes a deterministic brief with target null when no peer exists, and GET /config exposes ecosystem without keys'
  : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
