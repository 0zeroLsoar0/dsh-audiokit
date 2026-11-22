/**
 * Tests for lib/react.js and lib/tools-react.js.
 *
 * Two kinds of evidence matter here, and the second is the interesting one:
 *
 *   1. the audio: every interaction renders, is not silent, has the duration
 *      its cue asked for, and the five palettes are measurably different
 *      families rather than the same clips at different gains;
 *   2. the generated binding script: it is executed inside a mocked browser
 *      (document + AudioContext) so the promise of the deliverable is checked by
 *      observation — nothing exists before a gesture, a click plays the clip
 *      exactly once, a triple click cannot stack above +3 dB, and `data-sound`
 *      works with no page JavaScript at all.
 *
 * The DOM stub is deliberately small: querySelectorAll understands only the
 * simple selectors the generated script uses (tag, #id, .class, [attr]) and the
 * clock is frozen unless a test advances it.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAX_INLINE_BYTES } from '../lib/bind.js'
import {
  AUTO_INTERACTIONS,
  INTERACTION_IDS,
  INTERACTION_PRESETS,
  PALETTES,
  PALETTE_NAMES,
  buildBindingScript,
  buildInteractionSet,
  renderInteractionSet
} from '../lib/react.js'
import { decodeWav } from '../lib/wav.js'
import { registerReactTools } from '../lib/tools-react.js'

let checks = 0
let failures = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

function fmt (value, digits = 2) {
  return Number(value).toFixed(digits)
}

function parses (source) {
  try {
    new Function(source)
    return true
  } catch {
    return false
  }
}

function sha (bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/* ------------------------------------------------------------- the table -- */

console.log(`-- interaction table (${INTERACTION_IDS.length} interactions) --`)
{
  const required = [
    'hover', 'press', 'release', 'toggle-on', 'toggle-off', 'success', 'error', 'warning',
    'typing-key', 'scroll-tick', 'open', 'close', 'drop', 'count-up', 'focus', 'notify'
  ]
  check('at least 12 interactions', INTERACTION_IDS.length >= 12, String(INTERACTION_IDS.length))
  check('the documented vocabulary exists', required.every((id) => INTERACTION_PRESETS[id] !== undefined),
    required.filter((id) => INTERACTION_PRESETS[id] === undefined).join(','))
  check('every interaction names an engine and a gain', INTERACTION_IDS.every((id) => {
    const entry = INTERACTION_PRESETS[id]
    return (entry.engine.kind === 'design' ? typeof entry.engine.recipe === 'string' : typeof entry.engine.preset === 'string') &&
      Number.isFinite(entry.gainDb) && Number.isFinite(entry.duration) && entry.duration > 0
  }))
  check('auto set is a subset of the table', AUTO_INTERACTIONS.every((id) => INTERACTION_PRESETS[id] !== undefined))
  check('"auto" expands to the documented set', buildInteractionSet({ interactions: ['auto'] }).cues.map((cue) => cue.name).join(',') === AUTO_INTERACTIONS.join(','))
  check('a bare "auto" string is accepted too', buildInteractionSet({ interactions: 'auto' }).cues.length === AUTO_INTERACTIONS.length)
  check('duplicate ids are de-duplicated', buildInteractionSet({ interactions: ['press', 'press', 'hover'] }).cues.length === 2)
  check('five palettes with distinct ids', PALETTE_NAMES.length === 5 && PALETTES.soft.id === 'soft')

  for (const id of INTERACTION_IDS) {
    const entry = INTERACTION_PRESETS[id]
    const engine = entry.engine.kind === 'design' ? `design:${entry.engine.recipe}` : `preset:${entry.engine.preset}`
    console.log(`  ${id.padEnd(12)} ${engine.padEnd(28)} ${fmt(entry.gainDb, 1).padStart(6)} dB  ${fmt(entry.duration, 3)} s  ${entry.events.join(',')}`)
  }
}

/* ------------------------------------------------------ render every sound -- */

const crispSet = buildInteractionSet({ palette: 'crisp', interactions: INTERACTION_IDS, seed: 7, sampleRate: 22050 })
const crispRender = renderInteractionSet(crispSet)

console.log('\n-- every interaction renders (crisp palette, 22050 Hz) --')
{
  console.log('  ' + 'name'.padEnd(12) + 'dur s   peak dB  rms dB  centroid  onsets  bytes')
  crispRender.clips.forEach((clip, index) => {
    const cue = crispSet.cues[index]
    let finite = true
    let peak = 0
    for (const sample of clip.samples) {
      if (!Number.isFinite(sample)) finite = false
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
    }
    console.log('  ' + clip.name.padEnd(12) +
      fmt(clip.durationSeconds, 3).padStart(6) + '  ' +
      fmt(clip.peakDbfs, 1).padStart(7) + '  ' +
      fmt(clip.rmsDbfs, 1).padStart(6) + '  ' +
      String(clip.centroidHz).padStart(7) + '  ' +
      String(clip.onsets).padStart(6) + '  ' +
      String(clip.bytes.length).padStart(6))
    check(`${clip.name} finite samples`, finite)
    check(`${clip.name} not silent`, clip.rmsDbfs > -60, `rms=${clip.rmsDbfs}`)
    check(`${clip.name} peak normalised`, clip.peakDbfs > -1.5 && clip.peakDbfs <= -0.5, `peak=${clip.peakDbfs}`)
    check(`${clip.name} no clipping`, peak <= 1.0001, `peak=${peak}`)
    check(`${clip.name} duration matches its cue`, Math.abs(clip.durationSeconds - cue.durationSeconds) < 0.003,
      `${clip.durationSeconds} vs ${cue.durationSeconds}`)
    check(`${clip.name} duration is plausible`, clip.durationSeconds >= 0.02 && clip.durationSeconds <= 3,
      String(clip.durationSeconds))
    const decoded = decodeWav(clip.bytes)
    check(`${clip.name} wav decodes to the same length`, Math.abs(decoded.durationSeconds - clip.durationSeconds) < 0.001)
  })
  check('clips are named like their interactions', crispRender.clips.map((clip) => clip.name).join(',') === INTERACTION_IDS.join(','))
  check('totalBytes is the sum of the wavs', crispRender.totalBytes === crispRender.clips.reduce((sum, clip) => sum + clip.bytes.length, 0))
  console.log(`  ${crispRender.clips.length} clips, ${crispRender.totalBytes} raw wav bytes, sha256 ${sha(Buffer.concat(crispRender.clips.map((clip) => clip.bytes)))}`)
}

/* -------------------------------------------------------------- palettes -- */

console.log('\n-- palettes are measurable families, not gain presets --')
const paletteRenders = {}
{
  console.log('  ' + 'palette'.padEnd(10) + 'mean centroid  mean duration  raw bytes')
  for (const palette of PALETTE_NAMES) {
    const set = buildInteractionSet({ palette, interactions: INTERACTION_IDS, seed: 7, sampleRate: 22050 })
    const rendered = renderInteractionSet(set)
    paletteRenders[palette] = rendered
    const meanCentroid = rendered.clips.reduce((sum, clip) => sum + clip.centroidHz, 0) / rendered.clips.length
    const meanDuration = rendered.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0) / rendered.clips.length
    console.log('  ' + palette.padEnd(10) + String(Math.round(meanCentroid)).padStart(13) + '  ' +
      fmt(meanDuration, 3).padStart(13) + '  ' + String(rendered.totalBytes).padStart(9))
  }

  const meanCentroid = (palette) => paletteRenders[palette].clips.reduce((sum, clip) => sum + clip.centroidHz, 0) / paletteRenders[palette].clips.length
  const centroids = Object.fromEntries(PALETTE_NAMES.map((palette) => [palette, meanCentroid(palette)]))
  const spread = Math.max(...Object.values(centroids)) / Math.min(...Object.values(centroids))
  console.log(`  centroid spread ${fmt(spread, 2)}x: cinematic ${Math.round(centroids.cinematic)} < soft ${Math.round(centroids.soft)} < organic ${Math.round(centroids.organic)} < crisp ${Math.round(centroids.crisp)} < digital ${Math.round(centroids.digital)} Hz`)
  check('palette families differ by more than 1.4x in centroid', spread >= 1.4, `${fmt(spread, 2)}x`)
  check('dark to bright order holds', centroids.cinematic < centroids.soft && centroids.soft < centroids.organic &&
    centroids.organic < centroids.crisp && centroids.crisp < centroids.digital,
  Object.entries(centroids).map(([id, value]) => `${id}:${Math.round(value)}`).join(' '))
  check('digital is the shortest family', paletteRenders.digital.clips.every((clip) => clip.durationSeconds <= paletteRenders.soft.clips.find((other) => other.name === clip.name).durationSeconds))
  check('cinematic is the longest family', paletteRenders.cinematic.clips.every((clip) => clip.durationSeconds >= paletteRenders.crisp.clips.find((other) => other.name === clip.name).durationSeconds))
  check('every palette changes the bytes', new Set(PALETTE_NAMES.map((palette) => sha(Buffer.concat(paletteRenders[palette].clips.map((clip) => clip.bytes))))).size === PALETTE_NAMES.length)
}

/* ----------------------------------------------------------- determinism -- */

console.log('\n-- determinism --')
{
  const again = renderInteractionSet(buildInteractionSet({ palette: 'crisp', interactions: INTERACTION_IDS, seed: 7, sampleRate: 22050 }))
  check('same seed reproduces every clip byte-for-byte',
    again.clips.every((clip, index) => clip.bytes.equals(crispRender.clips[index].bytes)))
  check('same totalBytes', again.totalBytes === crispRender.totalBytes)

  const otherSeed = renderInteractionSet(buildInteractionSet({ palette: 'crisp', interactions: INTERACTION_IDS, seed: 8, sampleRate: 22050 }))
  const changed = otherSeed.clips.filter((clip, index) => !clip.bytes.equals(crispRender.clips[index].bytes)).map((clip) => clip.name)
  console.log(`  seed 7 -> 8 changes ${changed.length}/${INTERACTION_IDS.length} clips: ${changed.join(', ')}`)
  check('a different seed changes the set', changed.length > 0)
  const otherSeedAgain = renderInteractionSet(buildInteractionSet({ palette: 'crisp', interactions: INTERACTION_IDS, seed: 8, sampleRate: 22050 }))
  check('a second seed is equally reproducible', otherSeedAgain.clips.every((clip, index) => clip.bytes.equals(otherSeed.clips[index].bytes)))
}

/* ---------------------------------------------------- the generated script -- */

console.log('\n-- generated binding script --')
const inline = buildBindingScript({ clips: crispRender.clips, selectorMap: { '.link': { press: 'release' } } })
{
  const manifest = JSON.parse(inline.json)
  console.log(`  inline script ${inline.bytes} B for ${crispRender.clips.length} clips (${fmt(inline.bytes / 1024, 1)} KB), manifest ${inline.json.length} B`)
  check('script parses', parses(inline.script))
  check('script is an IIFE with a leading comment', /^\s*\/\*[\s\S]*?\*\/\s*\(\(\) =>/.test(inline.script))
  check('script exposes the documented API', ['play', 'bind', 'setEnabled', 'unlock'].every((name) => inline.script.includes(`${name}:`)))
  check('script binds data-sound attributes', inline.script.includes('[data-sound]') && inline.script.includes('data-sound-enter'))
  check('inline script carries the bytes', (inline.script.match(/data":/g) ?? []).length === crispRender.clips.length)
  check('inline script has no network code', !/\bfetch\s*\(/.test(inline.script) && !/https?:/.test(inline.script) &&
    !/XMLHttpRequest/.test(inline.script) && !/\bimport\s*\(/.test(inline.script) && !/\.wav/.test(inline.script))
  check('inline script does not eval', !/\beval\s*\(/.test(inline.script) && !/new\s+Function/.test(inline.script))
  check('inline script fits the 2 MB page budget', inline.bytes < DEFAULT_MAX_INLINE_BYTES, String(inline.bytes))
  check('bytes is the script UTF-8 length', inline.bytes === Buffer.byteLength(inline.script, 'utf8'))
  check('manifest is inline and carries no base64', manifest.inline === true && manifest.clips.every((clip) => clip.data === undefined && Number.isFinite(clip.dataBytes)))
  check('manifest keeps the selector map', manifest.bindings.length === 1 && manifest.bindings[0].selector === '.link' && manifest.bindings[0].press === 'release')
  check('manifest json is small', inline.json.length < 2000, String(inline.json.length))

  let duplicate = false
  try { buildBindingScript({ clips: [{ name: 'a', bytes: crispRender.clips[0].bytes }, { name: 'a', bytes: crispRender.clips[1].bytes }] }) } catch { duplicate = true }
  check('duplicate clip names refused', duplicate)
  let unknownBinding = false
  try { buildBindingScript({ clips: crispRender.clips, selectorMap: { 'button': 'nope' } }) } catch (error) { unknownBinding = /unknown clip "nope"/.test(error.message) }
  check('a selector bound to an unknown clip is refused', unknownBinding)
  let empty = false
  try { buildBindingScript({ clips: [] }) } catch { empty = true }
  check('an empty clip list is refused', empty)

  const external = buildBindingScript({
    clips: crispRender.clips.map((clip) => ({ name: clip.name, gainDb: clip.gainDb, src: `ui/${clip.name}.wav` }))
  })
  check('external script parses', parses(external.script))
  check('external script fetches beside itself', external.script.includes('fetch(') && external.script.includes('ui/press.wav'))
  check('external manifest is not inline', JSON.parse(external.json).inline === false)
  const mixed = buildBindingScript({ clips: [{ name: 'a', bytes: crispRender.clips[0].bytes }, { name: 'b', src: 'ui/b.wav' }] })
  check('a mixed set is external, not half-inline', mixed.script.includes('fetch(') && JSON.parse(mixed.json).inline === false)
}

/* ------------------------------------------------------- mocked DOM player -- */

function createDocument () {
  const listeners = new Map()
  const elements = []
  return {
    elements,
    addEventListener (type, fn) {
      const list = listeners.get(type)
      if (list === undefined) listeners.set(type, [fn])
      else list.push(fn)
    },
    querySelectorAll (selector) {
      return elements.filter((element) => matches(element, selector))
    },
    gesture (type) {
      for (const fn of listeners.get(type) ?? []) fn({ type, target: null })
    },
    listenerCount (type) {
      return (listeners.get(type) ?? []).length
    }
  }
}

function matches (element, selector) {
  return selector.split(',').map((part) => part.trim()).filter(Boolean).some((part) => {
    const attribute = /^\[([a-z0-9-]+)\]$/i.exec(part)
    if (attribute !== null) return Object.prototype.hasOwnProperty.call(element.attrs, attribute[1])
    if (part.startsWith('.')) return element.classes.includes(part.slice(1))
    if (part.startsWith('#')) return element.id === part.slice(1)
    return element.tag === part
  })
}

function createElement (spec = {}) {
  const handlers = new Map()
  const element = {
    tag: spec.tag ?? 'div',
    id: spec.id ?? '',
    classes: spec.classes ?? [],
    attrs: { ...(spec.attrs ?? {}) },
    addEventListener (type, fn) {
      const list = handlers.get(type)
      if (list === undefined) handlers.set(type, [fn])
      else list.push(fn)
    },
    getAttribute (name) {
      return Object.prototype.hasOwnProperty.call(element.attrs, name) ? element.attrs[name] : null
    },
    dispatch (type) {
      const list = handlers.get(type) ?? []
      for (const fn of list) fn({ type, target: element })
      return list.length
    },
    listenerCount (type) {
      return (handlers.get(type) ?? []).length
    }
  }
  return element
}

/** Execute a generated script against a fresh mock window/document. */
function runScript (script, elements = []) {
  const state = { clock: { t: 5 }, sources: [], contexts: [], decodeCalls: 0 }

  class MockGain {
    constructor () {
      this.disconnected = false
      this.gain = {
        value: 1,
        setValueAtTime: (value) => { this.gain.value = value }
      }
    }

    connect (node) { return node }

    disconnect () { this.disconnected = true }
  }

  class MockSource {
    constructor () {
      this.buffer = null
      this.startedAt = null
      this.stoppedAt = null
      this.onended = null
    }

    connect (node) { return node }

    start (when) {
      if (this.startedAt !== null) throw new Error('mock source started twice')
      this.startedAt = when === undefined ? state.clock.t : when
      state.sources.push(this)
    }

    stop () {
      this.stoppedAt = state.clock.t
      const ended = this.onended
      this.onended = null
      if (typeof ended === 'function') ended()
    }
  }

  class MockAudioContext {
    constructor () {
      this.state = 'suspended'
      this.destination = { kind: 'destination' }
      state.contexts.push(this)
    }

    get currentTime () { return state.clock.t }

    async resume () { this.state = 'running' }

    async decodeAudioData (arrayBuffer) {
      state.decodeCalls += 1
      const bytes = Buffer.from(arrayBuffer)
      const decoded = decodeWav(bytes)
      // Two clips can legitimately have the same length (hover and focus are
      // both 0.14 s here), so the source identifies itself by its exact bytes.
      return { duration: decoded.durationSeconds, sampleRate: decoded.sampleRate, identity: bytes.toString('base64') }
    }

    createGain () { return new MockGain() }

    createBufferSource () { return new MockSource() }
  }

  const doc = createDocument()
  for (const element of elements) doc.elements.push(element)
  const win = { AudioContext: MockAudioContext }
  const factory = new Function('window', 'document', 'atob', script)
  factory(win, doc, atob)
  return { state, win, doc, MockAudioContext }
}

console.log('\n-- generated script in a mock browser --')
const byteName = new Map(crispRender.clips.map((clip) => [clip.bytes.toString('base64'), clip.name]))
const startedNames = (state, from) => state.sources.slice(from).map((source) => byteName.get(source.buffer.identity))

{
  check('every clip has a distinct wav payload', byteName.size === crispRender.clips.length, `${byteName.size}/${crispRender.clips.length}`)
  const button = createElement({ tag: 'button', classes: ['primary'], attrs: { 'data-sound': 'press', 'data-sound-enter': 'hover' } })
  const link = createElement({ tag: 'a', classes: ['link'] })
  const spare = createElement({ tag: 'div', id: 'spare' })
  const page = runScript(inline.script, [button, link, spare])
  const api = page.win.dshUI
  check('script installs window.dshUI', api !== undefined)
  check('API is complete', ['play', 'bind', 'setEnabled', 'unlock', 'voices'].every((name) => typeof api[name] === 'function'))
  check('no AudioContext at load', page.state.contexts.length === 0)
  check('data-sound was bound at load, with no page JS',
    button.listenerCount('click') === 1 && button.listenerCount('mouseenter') === 1)
  check('selectorMap was bound at load', link.listenerCount('pointerdown') === 1)
  check('document-level gesture listeners are installed', page.doc.listenerCount('pointerdown') === 1 && page.doc.listenerCount('keydown') === 1)

  const early = await api.play('press')
  await settle()
  check('play() before unlock does not autoplay',
    early === false && page.state.contexts.length === 0 && page.state.sources.length === 0 && page.state.decodeCalls === 0,
    JSON.stringify({ early, contexts: page.state.contexts.length, sources: page.state.sources.length, decodes: page.state.decodeCalls }))

  const unlocked = await api.unlock()
  await settle()
  check('unlock() opens a running context', unlocked === true && page.state.contexts.length === 1 && page.state.contexts[0].state === 'running')
  check('unlock() alone decodes nothing (lazy)', page.state.decodeCalls === 0, String(page.state.decodeCalls))

  let before = page.state.sources.length
  button.dispatch('click')
  await settle()
  check('one click starts exactly one source', page.state.sources.length === before + 1, String(page.state.sources.length - before))
  check('the click played "press"', startedNames(page.state, before).join(',') === 'press', startedNames(page.state, before).join(','))
  const afterPress = page.state.decodeCalls
  check('a clip decodes once on first use', afterPress === 1, String(afterPress))

  before = page.state.sources.length
  button.dispatch('mouseenter')
  await settle()
  check('mouseenter on data-sound-enter plays once', page.state.sources.length === before + 1 && startedNames(page.state, before).join(',') === 'hover',
    startedNames(page.state, before).join(','))
  check('the second clip decodes lazily, only when used', page.state.decodeCalls === afterPress + 1, String(page.state.decodeCalls))

  before = page.state.sources.length
  spare.dispatch('click')
  await settle()
  check('an element without data-sound is silent', page.state.sources.length === before)

  before = page.state.sources.length
  link.dispatch('pointerdown')
  await settle()
  check('selectorMap { press } plays on pointerdown', page.state.sources.length === before + 1 && startedNames(page.state, before).join(',') === 'release',
    startedNames(page.state, before).join(','))

  const spare2 = createElement({ tag: 'div', id: 'spare2' })
  page.doc.elements.push(spare2)
  const bound = api.bind('#spare2', 'press')
  before = page.state.sources.length
  spare2.dispatch('click')
  await settle()
  check('bind(selector, name) binds a click', bound === 1 && page.state.sources.length === before + 1 && startedNames(page.state, before).join(',') === 'press')
  check('unknown clip is a silent no-op', (await api.play('nope')) === false)

  before = page.state.sources.length
  check('setEnabled(false) reports disabled', api.setEnabled(false) === false)
  button.dispatch('click')
  await settle()
  check('setEnabled(false) silences bound events', page.state.sources.length === before)
  check('play() while disabled is false', (await api.play('press')) === false)
  api.setEnabled(true)
  before = page.state.sources.length
  button.dispatch('click')
  await settle()
  check('setEnabled(true) restores sound', page.state.sources.length === before + 1)
}

console.log('-- gesture, voice limit and preload --')
{
  // A gesture anywhere (not on a sound element) must open the context so a
  // later programmatic play() — a success after an async save — is heard.
  const page = runScript(inline.script)
  check('fresh page has no context', page.state.contexts.length === 0)
  page.doc.gesture('pointerdown')
  await settle()
  check('a document gesture unlocks audio', page.state.contexts.length === 1 && page.state.contexts[0].state === 'running')
  const played = await page.win.dshUI.play('hover')
  await settle()
  check('play() after a gesture sounds', played === true && page.state.sources.length === 1)

  // Synchronous triple click: each click is younger than STEAL_SECONDS, so the
  // voice is replaced instead of layered.
  const button = createElement({ tag: 'button', attrs: { 'data-sound': 'press' } })
  const burst = runScript(inline.script, [button])
  await burst.win.dshUI.unlock()
  await settle()
  const startedAt = burst.state.sources.length
  button.dispatch('click')
  button.dispatch('click')
  button.dispatch('click')
  await settle()
  const burstState = burst.win.dshUI.voices().press
  const burstDb = 20 * Math.log10(burstState.sumGain)
  console.log(`  rapid triple click: ${burst.state.sources.length - startedAt} source(s) started, ` +
    `state ${JSON.stringify(burstState)}, worst-case coherent sum ${fmt(burstDb, 2)} dB`)
  check('three clicks start three short voices', burst.state.sources.length - startedAt === 3, String(burst.state.sources.length - startedAt))
  check('young voices are stolen, not stacked', burstState.count === 1, JSON.stringify(burstState))
  check('rapid repeat never exceeds +3 dB', burstDb <= 3, `${fmt(burstDb, 2)} dB`)

  // Spaced clicks exercise the cap: two live voices, each at half level.
  burst.state.clock.t += 0.1
  button.dispatch('click')
  await settle()
  burst.state.clock.t += 0.1
  button.dispatch('click')
  await settle()
  const capped = burst.win.dshUI.voices().press
  const cappedDb = 20 * Math.log10(capped.sumGain)
  console.log(`  spaced overlap: state ${JSON.stringify(capped)}, worst-case coherent sum ${fmt(cappedDb, 2)} dB`)
  check('voice cap holds at two', capped.count === 2, JSON.stringify(capped))
  check('each live voice is compensated to 1/N', capped.gainScale === 0.5 && Math.abs(capped.sumGain - 1) < 1e-9,
    `${capped.gainScale} / ${capped.sumGain}`)
  check('overlap stays under +3 dB', cappedDb <= 3, `${fmt(cappedDb, 2)} dB`)

  const live = burst.state.sources.filter((source) => source.stoppedAt === null)
  for (const source of live) {
    const ended = source.onended
    source.onended = null
    if (typeof ended === 'function') ended()
  }
  await settle()
  check('voices release themselves when they end', burst.win.dshUI.voices().press === undefined,
    JSON.stringify(burst.win.dshUI.voices()))

  const preload = buildBindingScript({ clips: crispRender.clips, preload: true })
  const preloaded = runScript(preload.script)
  check('preload still creates no context at load', preloaded.state.contexts.length === 0 && preloaded.state.decodeCalls === 0)
  preloaded.doc.gesture('keydown')
  await settle()
  console.log(`  preload: ${preloaded.state.decodeCalls} clip(s) decoded on the first gesture`)
  check('preload decodes the whole set on unlock', preloaded.state.decodeCalls === crispRender.clips.length,
    `${preloaded.state.decodeCalls}/${crispRender.clips.length}`)
  check('preload script carries no network code', !/\bfetch\s*\(/.test(preload.script))
}

/* ------------------------------------------------------------ audio_react -- */

console.log('\n-- audio_react tool --')
const cwd = await mkdtemp(join(tmpdir(), 'dsh-audio-react-'))
{
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined)
  }
  const exec = { agent: { session: { id: 'test' } } }
  registerReactTools(ctx)
  const call = (args) => registered.get('audio_react').execute(args, exec)
  check('audio_react registered', registered.has('audio_react'))

  const auto = await call({ palette: 'soft', seed: 3, out: 'ui/soft' })
  console.log(auto.text.split('\n').map((line) => `  ${line}`).join('\n'))
  check('default set is the auto list', auto.clipCount === AUTO_INTERACTIONS.length, String(auto.clipCount))
  const autoAlias = await call({ interactions: ['auto'], out: 'ui/auto' })
  check('["auto"] renders the default set', autoAlias.clipCount === AUTO_INTERACTIONS.length &&
    autoAlias.interactions.join(',') === AUTO_INTERACTIONS.join(','), String(autoAlias.clipCount))
  check('writes <out>.js and <out>.json', auto.relativeJsPath === 'ui/soft.js' && auto.relativeJsonPath === 'ui/soft.json')
  const jsBytesOnDisk = await readFile(join(cwd, 'ui/soft.js'))
  const manifest = JSON.parse(await readFile(join(cwd, 'ui/soft.json'), 'utf8'))
  check('script on disk parses', parses(jsBytesOnDisk.toString('utf8')))
  check('manifest lists every clip', manifest.clips.length === AUTO_INTERACTIONS.length, String(manifest.clips.length))
  check('inline by default', auto.inline === true && auto.fallback === false)
  check('inline page weight is the script', auto.pageWeightBytes === auto.jsBytes && auto.jsBytes < DEFAULT_MAX_INLINE_BYTES)
  check('clip report is bounded and numeric', auto.clips.length === AUTO_INTERACTIONS.length &&
    auto.clips.every((clip) => Number.isFinite(clip.peakDbfs) && Number.isFinite(clip.gainDb) && clip.samples === undefined))
  check('text names the data-sound binding contract', /data-sound/.test(auto.text) && /hover/.test(auto.text) && /press/.test(auto.text))
  check('text reports the palette and page weight', /soft palette/.test(auto.text) && /page weight/.test(auto.text))

  const repeatA = await call({ palette: 'soft', seed: 3, out: 'ui/repeat-a' })
  const repeatB = await call({ palette: 'soft', seed: 3, out: 'ui/repeat-b' })
  check('the same request writes identical scripts', repeatA.jsBytes === repeatB.jsBytes &&
    (await readFile(join(cwd, 'ui/repeat-a.js'))).equals(await readFile(join(cwd, 'ui/repeat-b.js'))))

  const external = await call({ interactions: ['hover', 'press', 'error'], palette: 'digital', seed: 2, out: 'ui/ext', inline: false })
  const externalScript = await readFile(join(cwd, 'ui/ext.js'), 'utf8')
  const clipSize = (await stat(join(cwd, 'ui/ext-clips/press.wav'))).size
  console.log(`  external: script ${external.jsBytes} B + clips ${external.clipBytes} B (press.wav ${clipSize} B), dir ${external.clipDir}`)
  check('external mode writes the clips beside the script', external.inline === false && clipSize > 44)
  check('external mode lists a clip folder', external.clipDir === 'ui/ext-clips')
  check('external script references the clip files', externalScript.includes('fetch(') && externalScript.includes('ext-clips/press.wav'))
  check('external page weight counts script plus clips', external.pageWeightBytes === external.jsBytes + external.clipBytes)

  const tight = await call({ interactions: ['hover', 'press'], out: 'ui/tight', inline: true, maxBytes: 512 })
  console.log(`  tight budget: ${tight.text.split('\n')[1]}`)
  check('over-budget inline falls back to external files', tight.ok === true && tight.inline === false && tight.fallback === true && tight.clipDir === 'ui/tight-clips')

  const defaultOut = await call({ interactions: ['hover'] })
  check('default output path is a hash under assets/audio', /^assets\/audio\/react-[0-9a-f]+\.js$/.test(defaultOut.relativeJsPath), defaultOut.relativeJsPath)

  const rejects = async (label, args, pattern) => {
    try {
      await call(args)
      check(label, false, 'did not throw')
    } catch (error) {
      check(label, pattern.test(error.message), error.message)
    }
  }
  await rejects('unknown palette rejected', { palette: 'nope' }, /unknown palette/)
  await rejects('unknown interaction rejected', { interactions: ['nope'] }, /unknown interaction/)
  await rejects('bad maxBytes rejected', { maxBytes: 0 }, /maxBytes/)
  await rejects('non-numeric sampleRate rejected', { sampleRate: 'abc' }, /sampleRate/)
  await rejects('auto may not be mixed with an unknown id', { interactions: ['auto', 'nope'] }, /unknown interaction/)

  await rm(cwd, { recursive: true, force: true })
}

/* ----------------------------------------------------------------- done -- */

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'OK: interaction audio behaves' : `FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
