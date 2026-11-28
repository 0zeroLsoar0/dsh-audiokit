/**
 * Ecosystem detection: which peer audio plugins share this DSH profile, and what
 * belongs to them rather than to this plugin.
 *
 * This plugin is dependency-free and never calls another plugin's tools (DSH's
 * tool scope does not allow it, and it should not). What is left of "working
 * together" is the coordination problem: two audio plugins installed on one
 * machine must divide the work instead of overwriting each other's claims. This
 * module answers the only two questions that division needs — "who else is
 * installed?" and "what should be handed over?" — from read-only facts:
 *
 *   - the profile's `package.json` dependencies (what the profile declares), and
 *   - `node_modules/<name>/package.json` (the version that is really installed).
 *
 * Detection is deliberately shallow and honest. It reads two JSON files, never
 * runs a process, never opens a socket and never imports the other plugin; what
 * it knows about a peer comes from a static capability table below, not from
 * calling it. A plugin the table does not know is still recorded (name and
 * version) with empty capabilities, because the alternative — guessing — would
 * put a false promise into a handoff brief.
 *
 * Nothing here throws. A missing profile, an unreadable manifest or a corrupt
 * JSON file yields an empty detection instead of an exception: the callers are
 * the settings route (`GET /config`) and `audio_handoff`, and both have to keep
 * working on a machine with no peers at all.
 *
 * Determinism is part of the contract — no timestamps, no locale-dependent
 * ordering, no absolute profile path in the result — so the same machine always
 * produces the same bytes. That is what lets `audio_handoff` name its output
 * file after a content hash, and what keeps a brief written today comparable
 * with one written tomorrow. The scan is cached per resolved profile directory;
 * the file system cannot change under a running process in a way that matters
 * here, and caching keeps the settings route off the disk.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's own name: a dependency that resolves to us is not a peer. */
const SELF_NAME = 'dsh-audiokit'

/** Absolute path of this package, used to recognise a linked copy of ourselves. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The capability vocabulary a peer audio plugin can own.
 *
 * The order is the order handoff text and capability lists present to the
 * reader, so it is stable on purpose rather than `Object.keys()` order. A value
 * is `true`, or a non-empty array when the capability is a list (a provider id
 * set); `capabilitiesOf`-style consumers can treat both uniformly with `owns`.
 */
export const CAPABILITIES = Object.freeze([
  'instruments',
  'soundfonts',
  'voicebankSinging',
  'ttsProviders',
  'dawUi',
  'sfxLibrary'
])

/**
 * What each known peer owns, and the one sentence a status line says about it.
 *
 * A static table is the honest ceiling here: reading another plugin's manifest
 * for a capability declaration would mean trusting a format nobody agreed on,
 * and asking its tools would mean a cross-plugin call. Adding a peer is one
 * entry, which is also a review point — the capabilities are a promise that has
 * to stay true.
 */
const KNOWN_AUDIO_PLUGINS = Object.freeze({
  'dsh-any-audio': Object.freeze({
    label: 'AnyAudio',
    summary: '人声/音源建议交给它',
    capabilities: Object.freeze({
      instruments: true,
      soundfonts: true,
      voicebankSinging: true,
      ttsProviders: Object.freeze(['edge', 'mimo', 'deepseek']),
      dawUi: true,
      sfxLibrary: true
    })
  })
})

/**
 * Dependency fields worth scanning. A peer installed as a dev dependency is
 * still installed, and an optional one still occupies the capability's seat, so
 * the three fields are read together; duplicates collapse into one entry.
 */
const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'devDependencies'])

/**
 * Name filter for "this could be a sibling audio plugin".
 *
 * Intentionally broad: it only decides which *declared* dependencies are worth
 * asking about, and the precise work is done by the known table and by the
 * self-exclusion below. Unrelated plugins (`dsh-video-storyboard`, `@scope/ui`)
 * simply do not match.
 */
const AUDIO_NAME = /audio|soundfont|sfx|sound|music/i

/**
 * What this plugin hands over, per capability, and why.
 *
 * `reason` explains the constraint (why we cannot just do it), `suggest` is the
 * sentence a tool result or a report can paste: it names the peer and this
 * plugin's side of the boundary in one line. The example is the one the design
 * note fixes: `voicebankSinging` → singing belongs to the peer, this plugin
 * does not synthesize voices.
 */
const HANDOFF_NOTES = Object.freeze({
  instruments: Object.freeze({
    reason: '采样乐器要成体系的音色素材、映射与采样引擎，本插件不带任何音色库',
    suggest: '采样乐器交给 dsh-any-audio；本插件只做程序化合成（audio_sampler 只播放你自己的录音）'
  }),
  soundfonts: Object.freeze({
    reason: 'SoundFont 播放依赖音色库文件，本插件不打包也不解析 .sf2',
    suggest: 'SoundFont / 音色库播放交给 dsh-any-audio；本插件不做音色库'
  }),
  voicebankSinging: Object.freeze({
    reason: '真人声库需要数百 MB 素材与声码器，本插件不提供',
    suggest: '演唱交给 dsh-any-audio；本插件不做合成唱腔'
  }),
  ttsProviders: Object.freeze({
    reason: 'mimo/deepseek 等供应商音色不在本插件的 TTS 适配表里（只覆盖 minimax / openai 兼容 / edge）',
    suggest: '旁白仍走本插件的 audio_tts；需要 mimo/deepseek 音色时交给 dsh-any-audio 输出 wav，再回到 audio_check 验收'
  }),
  dawUi: Object.freeze({
    reason: '可视化 DAW 编辑界面由对方提供，本插件只导出工程文件',
    suggest: '可视化编曲/剪辑交给 dsh-any-audio；本插件只导出工程文件，进 DAW 用 audio_daw'
  }),
  sfxLibrary: Object.freeze({
    reason: '成套音效素材库及其许可由对方管理，本插件只程序化合成',
    suggest: '现成音效素材交给 dsh-any-audio；本插件只程序化合成（audio_synth / audio_design）'
  })
})

/** Per-profile-directory scan cache: an empty key means "no profile resolved". */
const CACHE = new Map()

/**
 * A known peer's table entry, by *own* property only.
 *
 * A package name is caller-controlled data, so `KNOWN_AUDIO_PLUGINS[name]` is
 * not enough: `name = "constructor"` would read `Object.prototype.constructor`
 * and hand a non-peer object to the capability code. No real name reaches that
 * branch today (the audio filter runs first), but the lookup should not depend
 * on that ordering.
 */
function knownPlugin (name) {
  return Object.prototype.hasOwnProperty.call(KNOWN_AUDIO_PLUGINS, name)
    ? KNOWN_AUDIO_PLUGINS[name]
    : undefined
}

/** Code-unit ordering, because `localeCompare` depends on the machine locale. */
function compare (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A trimmed string, or '' for anything that is not one. */
function text (value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** `realpathSync`-comparable form: Windows paths are case-insensitive. */
function comparablePath (path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Read a JSON file without ever throwing.
 *
 * The BOM is stripped because a manifest edited on Windows may carry one and
 * `JSON.parse` refuses it; everything else (missing file, a directory, invalid
 * JSON) is a `null` — the caller treats all of them the same way.
 */
function readJson (path) {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
  } catch {
    return null
  }
}

/**
 * The profile directory peer plugins are installed into.
 *
 * DSH sets `DSH_PROFILE_DIR`, which is the authority when present. The
 * documented fallback composes it from `DSH_HOME` (or `~/.dsh`) and
 * `DSH_PROFILE`, so a session started without the derived variable still
 * detects the same plugins. With neither, there is no profile to read and the
 * result is `null` rather than a guess at somebody's home directory.
 * @param {object} [env] - environment to read; defaults to `process.env`.
 * @returns {string|null} absolute profile directory, or null when unknown.
 */
export function profileDirectory (env = process.env) {
  const explicit = text(env?.DSH_PROFILE_DIR)
  if (explicit !== '') return resolve(explicit)
  const home = text(env?.DSH_HOME) || join(homedir(), '.dsh')
  const profile = text(env?.DSH_PROFILE)
  if (profile === '') return null
  return resolve(join(home, 'profiles', profile))
}

/** Every dependency name the manifest declares, deduplicated and sorted. */
function dependencyNames (manifest) {
  const names = new Set()
  for (const field of DEPENDENCY_FIELDS) {
    const table = manifest?.[field]
    if (table === null || typeof table !== 'object' || Array.isArray(table)) continue
    for (const name of Object.keys(table)) names.add(name)
  }
  return [...names].sort(compare)
}

/** The version a peer is installed at, or `null` when it is not resolvable. */
function versionOf (manifest) {
  const version = text(manifest?.version)
  return version === '' ? null : version
}

/**
 * A fresh copy of a known peer's capability map.
 *
 * Copies matter because the scan result is cached and handed to callers: a
 * caller mutating the array in `ttsProviders` must not change what the next
 * caller is told.
 */
function capabilitiesFor (name) {
  const known = knownPlugin(name)
  if (known === undefined) return {}
  const capabilities = {}
  for (const [key, value] of Object.entries(known.capabilities)) {
    capabilities[key] = Array.isArray(value) ? [...value] : value
  }
  return capabilities
}

/**
 * Whether a declared dependency is this very plugin under another name.
 *
 * A profile install usually links the plugin (`@local/dsh-audio` → this
 * directory) or copies it; both would otherwise look like a peer and be handed
 * work this plugin should do itself. The installed manifest's `name` settles
 * the copied case, the resolved link target the symlinked one.
 */
function isSelf (profileDir, name, installed) {
  if (name === SELF_NAME || installed?.name === SELF_NAME) return true
  try {
    const linked = realpathSync(join(profileDir, 'node_modules', ...name.split('/')))
    return comparablePath(linked) === comparablePath(realpathSync(PLUGIN_ROOT))
  } catch {
    return false
  }
}

/** One profile scan: declared audio plugins, with the versions really installed. */
function scanProfile (profileDir) {
  if (profileDir === null) return []
  const manifest = readJson(join(profileDir, 'package.json'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return []

  const plugins = []
  for (const name of dependencyNames(manifest)) {
    const known = knownPlugin(name) !== undefined
    if (!known && !AUDIO_NAME.test(name)) continue
    const installed = readJson(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
    if (isSelf(profileDir, name, installed)) continue
    plugins.push({ name, version: versionOf(installed), capabilities: capabilitiesFor(name) })
  }
  return plugins
}

/**
 * Detect the peer audio plugins of the current DSH profile. Read-only, offline
 * and non-throwing.
 *
 * @param {{ env?: object, refresh?: boolean }} [options] - `env` overrides the
 *   process environment (tests, a nested profile); `refresh: true` bypasses the
 *   per-directory cache.
 * @returns {{ plugins: { name: string, version: string|null, capabilities: object }[] }}
 *   sorted by name, deterministic for one machine: no timestamp, no path.
 */
export function detectEcosystem (options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const env = settings.env ?? process.env
  const profileDir = profileDirectory(env)
  const key = profileDir ?? ''
  const cached = CACHE.get(key)
  if (cached !== undefined && settings.refresh !== true) return structuredClone(cached)
  const detected = { plugins: scanProfile(profileDir) }
  CACHE.set(key, detected)
  return structuredClone(detected)
}

/** The plugin rows of a detection result, tolerating a malformed one. */
function pluginList (ecosystem) {
  const plugins = ecosystem?.plugins
  if (!Array.isArray(plugins)) return []
  return plugins.filter((plugin) => plugin !== null && typeof plugin === 'object' && text(plugin.name) !== '')
}

/** Whether a capability map owns `capability` (a `true` flag or a non-empty list). */
function owns (capabilities, capability) {
  if (capabilities === null || typeof capabilities !== 'object') return false
  const value = capabilities[capability]
  if (Array.isArray(value)) return value.length > 0
  return value === true
}

/**
 * The capabilities a map really declares, in `CAPABILITIES` order.
 * @param {object} [capabilities] - a plugin row's capability map.
 * @returns {string[]} named capabilities, possibly empty.
 */
export function capabilityNames (capabilities) {
  return CAPABILITIES.filter((capability) => owns(capabilities, capability))
}

/** `AnyAudio v0.5.2`, or `AnyAudio（版本未知）` when the install is unreadable. */
function pluginLabel (plugin) {
  const known = knownPlugin(plugin.name)
  const label = known === undefined ? plugin.name : known.label
  return plugin.version === null ? `${label}（版本未知）` : `${label} v${plugin.version}`
}

/**
 * One-line status for a detection result: the line the settings page shows and
 * the line a tool result carries.
 *
 * Known peer → "检测到 AnyAudio v0.5.2：人声/音源建议交给它"; unknown peer → the
 * name plus "能力未知"; nothing → "未检测到同类音频插件".
 * @param {{ plugins?: object[] }} ecosystem - a `detectEcosystem()` result.
 * @returns {string} a single Chinese sentence, never empty.
 */
export function summarizeEcosystem (ecosystem) {
  const plugins = pluginList(ecosystem)
  if (plugins.length === 0) return '未检测到同类音频插件'
  const parts = plugins.map((plugin) => {
    const known = knownPlugin(plugin.name)
    if (known === undefined) return `${pluginLabel(plugin)}（能力未知，只记录名称与版本）`
    return `${pluginLabel(plugin)}：${known.summary}`
  })
  return `检测到 ${parts.join('；')}`
}

/**
 * The read-only ecosystem view for the settings route.
 *
 * Detection cannot throw by design, but the route must survive even a bug in
 * this module: a failure is reported as "no peers" (empty plugin list) with a
 * reason line instead of a 500 that would take the whole settings page with it.
 * @param {{ env?: object, refresh?: boolean }} [options] - see `detectEcosystem`.
 * @returns {{ plugins: object[], summary: string }} never contains a secret.
 */
export function ecosystemStatus (options = {}) {
  try {
    const ecosystem = detectEcosystem(options)
    return { plugins: pluginList(ecosystem), summary: summarizeEcosystem(ecosystem) }
  } catch {
    return { plugins: [], summary: '生态检测不可用（读取 profile 失败）' }
  }
}

/** Normalise `voicebank-singing` / `voicebankSinging` to a known capability id. */
function normalizeCapability (value) {
  const raw = text(value)
  if (raw === '') return ''
  if (Object.prototype.hasOwnProperty.call(HANDOFF_NOTES, raw)) return raw
  const camel = raw.replace(/[-_\s]+([a-z0-9])/gi, (_, character) => character.toUpperCase())
  return Object.prototype.hasOwnProperty.call(HANDOFF_NOTES, camel) ? camel : ''
}

/**
 * What to hand over for one capability, and to whom.
 *
 * The note is static (the division of labour does not depend on what happens to
 * be installed); `plugin` / `available` say whether a peer that owns it was
 * detected *now*, so a caller can tell "hand it to X" from "X is not installed,
 * do it differently or install it". Unknown capability ids return `null`
 * instead of invented advice.
 *
 * @param {string} capability - e.g. `voicebankSinging` or `voicebank-singing`.
 * @param {{ ecosystem?: object, env?: object, refresh?: boolean }} [options] -
 *   pass a detection result to avoid re-scanning the profile.
 * @returns {{ plugin: string|null, capability: string, available: boolean,
 *   reason: string, suggest: string }|null} the handoff note, or null.
 */
export function handoffFor (capability, options = {}) {
  const key = normalizeCapability(capability)
  if (key === '') return null
  const settings = options !== null && typeof options === 'object' ? options : {}
  const ecosystem = settings.ecosystem ?? detectEcosystem(settings)
  const peer = pluginList(ecosystem).find((plugin) => owns(plugin.capabilities, key)) ?? null
  const note = HANDOFF_NOTES[key]
  return {
    plugin: peer === null ? null : peer.name,
    capability: key,
    available: peer !== null,
    reason: note.reason,
    suggest: note.suggest
  }
}

/**
 * The peer a brief should be addressed to.
 *
 * A known plugin whose capabilities we understand wins over an unknown one,
 * because the brief can then promise something concrete; otherwise the first
 * detected peer is still a legitimate recipient. `null` means "no peer
 * installed", which is a normal state, not a failure.
 * @param {{ plugins?: object[] }} ecosystem - a `detectEcosystem()` result.
 * @returns {{ name: string, version: string|null, capabilities: object }|null}
 */
export function pickHandoffTarget (ecosystem) {
  const plugins = pluginList(ecosystem)
  const known = plugins.find((plugin) =>
    knownPlugin(plugin.name) !== undefined &&
    capabilityNames(plugin.capabilities).length > 0
  )
  return structuredClone(known ?? plugins[0] ?? null)
}
