/**
 * Picture/sound glue: build the cue sheet that a page actually plays, and the
 * tiny runtime that plays it on the audio clock.
 *
 * This module never plays audio itself. It *generates* a dependency-free IIFE
 * a human can paste into a single-file HTML, keeps the cue times as absolute
 * seconds, and inlines wav bytes as base64 so the deliverable makes zero
 * network requests.
 *
 * Sync contract (the whole point of this file):
 *   - every cue is scheduled with `source.start(t0 + at)` on the AudioContext
 *     clock, so a cue lands on its sample frame no matter how late the timer
 *     that woke the scheduler was;
 *   - `setTimeout` is only a wake-up, and the look-ahead window is wider than
 *     the wake interval, which leaves the scheduler roughly 350 ms of slack;
 *   - the page drives its animation from the same clock through
 *     `dshAudio.currentTime()` instead of `performance.now()`.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { clamp } from './dsp.js'

/** Timing constants baked into the generated player and reported by the drift budget. */
export const PLAYER_TIMING = Object.freeze({
  leadSeconds: 0.08,
  aheadSeconds: 0.45,
  wakeSeconds: 0.1,
  lateSeconds: 0.02
})

/** Default ceiling for inline audio: a page heavier than this is usually a mistake. */
export const DEFAULT_MAX_INLINE_BYTES = 2 * 1024 * 1024

/**
 * The player source. `__DATA__` and the four timing tokens are replaced by
 * `buildCueSheet`; the result is a plain IIFE with no imports and no eval.
 * Kept short on purpose: this text is pasted into the deliverable.
 */
const PLAYER_SOURCE = `/* dsh-audio cue player: paste in <script>; call dshAudio.resume() from a click. */
(() => {
  const D = __DATA__, C = D.cues, END = D.duration
  const LEAD = __LEAD__, AHEAD = __AHEAD__, WAKE = __WAKE__, LATE = __LATE__
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const bus = ctx.createGain(), comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -6, comp.ratio.value = 12, comp.attack.value = 0.003
  bus.connect(comp), comp.connect(ctx.destination)
  const bufs = new Map(), live = [], loops = new Map()
  let t0 = 0, next = 0, wake = 0, run = false, booting = null, auto = false

  // Inline audio is decoded locally: fetch(data:) is blocked on file:// in some browsers.
  const b64 = (s) => Uint8Array.from(atob(s.slice(s.indexOf(',') + 1)), (ch) => ch.charCodeAt(0)).buffer
  const read = (c) => c.data ? Promise.resolve(b64(c.data))
    : c.src.startsWith('data:') ? Promise.resolve(b64(c.src))
      : fetch(c.src).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(Error('dshAudio ' + r.status + ' ' + c.src)))
  const load = (c) => bufs.get(c.name) ?? bufs.set(c.name, read(c).then((b) => ctx.decodeAudioData(b))).get(c.name)

  const unhook = (v) => { const i = live.indexOf(v); if (i >= 0) live.splice(i, 1); if (loops.get(v.name) === v) loops.delete(v.name) }
  const halt = (v) => (unhook(v), v.gain.gain.cancelScheduledValues(ctx.currentTime), v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01), v.src.stop(ctx.currentTime + 0.04))

  function fire (c, buf, when, tied) {
    if (c.loop && loops.has(c.name)) return false
    const src = ctx.createBufferSource(), gain = ctx.createGain(), g = gain.gain
    const t = Math.max(when, ctx.currentTime), lv = Math.pow(10, (c.gainDb || 0) / 20)
    const fi = c.fadeIn || 0, fo = c.fadeOut || 0
    const end = c.loop ? (tied && END - c.at > 0.02 ? t + END - c.at : 0) : t + buf.duration
    src.buffer = buf, src.loop = c.loop === true
    g.setValueAtTime(fi ? 0 : lv, t)
    if (fi) g.linearRampToValueAtTime(lv, t + fi)
    if (fo && end > t + fi + fo) g.setValueAtTime(lv, end - fo), g.linearRampToValueAtTime(0, end)
    const v = { name: c.name, src, gain }
    src.onended = () => unhook(v)
    src.connect(gain), gain.connect(bus), src.start(t)
    if (c.loop && end) src.stop(end)
    live.push(v)
    if (c.loop) loops.set(c.name, v)
    return true
  }

  const stop = (name) => live.slice().forEach((v) => { if (v.name === name) halt(v) })
  const stopAll = () => { run = false; next = 0; t0 = 0; clearTimeout(wake); wake = 0; live.slice().forEach(halt); loops.clear() }

  // Cues land on the audio clock as src.start(t0 + at); this timer only wakes
  // the scheduler, and a 0.45 s window over a 0.1 s wake cannot move a sound.
  function pump () {
    wake = 0
    if (!run || ctx.state !== 'running') return
    const now = ctx.currentTime - t0
    while (next < C.length && C[next].at <= now + AHEAD) {
      const c = C[next++]
      load(c).then((buf) => { if (run) fire(c, buf, t0 + c.at, true) }).catch(() => {})
    }
    if (next < C.length) wake = setTimeout(pump, WAKE * 1000)
  }

  const unlock = () => ctx.state === 'running' ? Promise.resolve(true) : ctx.resume().then(() => ctx.state === 'running')

  async function startup () {
    const unlocked = unlock()
    try { await Promise.all(C.map(load)) } catch (e) { return false }
    if (!(await unlocked)) return false
    run = true, next = 0, t0 = ctx.currentTime + LEAD
    pump()
    window.dispatchEvent(new Event('dshaudio:start'))
    return true
  }

  async function play (name) {
    const c = C.find((x) => x.name === name)
    if (!c || (c.loop && loops.has(name))) return false
    if (ctx.state !== 'running') await unlock()
    try {
      const buf = await load(c)
      return ctx.state === 'running' ? fire(c, buf, ctx.currentTime + LATE, false) : false
    } catch (e) { return false }
  }

  async function resume () {
    auto = false
    if (run) {
      if (ctx.state !== 'running') await unlock()
      if (!wake) pump()
      return ctx.state === 'running'
    }
    if (ctx.state !== 'running') await unlock()
    if (!booting) booting = startup().finally(() => { booting = null })
    return booting
  }

  const pause = () => run && ctx.state === 'running' ? (clearTimeout(wake), wake = 0, ctx.suspend().then(() => true)) : Promise.resolve(false)
  const setMuted = (v) => (bus.gain.value = v ? 0 : 1) === 0
  const currentTime = () => (run ? ctx.currentTime - t0 : 0)

  // A hidden tab suspends the clock; a manual pause() is not undone by it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && run && ctx.state === 'running') auto = true, clearTimeout(wake), wake = 0, ctx.suspend()
    else if (!document.hidden && auto) auto = false, ctx.resume().then(() => { if (run && !wake) pump() })
  })

  window.dshAudio = { play, stop, stopAll, pause, resume, setMuted, currentTime }
})()
`

/* ---- cue sheet ---- */

const round = (value, digits) => Number(Number(value).toFixed(digits))
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/** Resolve a cue source against a base path without touching absolute URLs or data URIs. */
function joinSrc (basePath, src) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) return src
  const base = String(basePath ?? '')
  if (base === '') return src.replace(/^\.\//, '')
  return `${base.replace(/\/+$/, '')}/${src.replace(/^\.?\//, '')}`
}

/**
 * Serialize the cue sheet for direct embedding in the player. Escaping `<`
 * keeps a cue name or path from closing the host `<script>` element, and
 * escaping the two line separators keeps the JSON valid JavaScript.
 */
function scriptData (sheet) {
  return JSON.stringify(sheet)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Fill the player template. String replacements are callbacks so `$` in data is literal. */
function renderPlayer (sheet) {
  return PLAYER_SOURCE
    .replace('__DATA__', () => scriptData(sheet))
    .replace('__LEAD__', () => String(PLAYER_TIMING.leadSeconds))
    .replace('__AHEAD__', () => String(PLAYER_TIMING.aheadSeconds))
    .replace('__WAKE__', () => String(PLAYER_TIMING.wakeSeconds))
    .replace('__LATE__', () => String(PLAYER_TIMING.lateSeconds))
}

/**
 * Build a cue sheet and the player source that plays it.
 *
 * Cue fields: `{ name, at, src|data, gainDb, fadeIn, fadeOut, loop }`.
 * `at` is seconds from the start of the timeline; `src` is a URL resolved
 * against `basePath`; `data` is raw base64 (or a full data URI) for inline
 * audio; `gainDb` is applied at mix time; fades are seconds; `loop: true`
 * plays until `duration`.
 *
 * @param {{ cues: object[], duration?: number, basePath?: string }} request
 * @returns {{ cues: object[], json: string, script: string }}
 */
export function buildCueSheet (request = {}) {
  const rawCues = request.cues
  if (!Array.isArray(rawCues) || rawCues.length === 0) {
    throw new Error('buildCueSheet needs at least one cue')
  }
  const names = new Set()
  const cues = rawCues.map((raw, index) => {
    const cue = raw ?? {}
    const name = String(cue.name ?? `cue-${index + 1}`).trim()
    if (name === '') throw new Error(`cue ${index + 1} has an empty name`)
    if (names.has(name)) throw new Error(`duplicate cue name "${name}"`)
    names.add(name)
    const at = Number(cue.at)
    if (!Number.isFinite(at) || at < 0 || at > 3600) {
      throw new Error(`cue "${name}" needs at in seconds between 0 and 3600`)
    }
    const inline = typeof cue.data === 'string' && cue.data.length > 0
    const source = typeof cue.src === 'string' ? cue.src.trim() : ''
    if (!inline && source === '') throw new Error(`cue "${name}" needs src or data`)
    const entry = {
      name,
      at: round(at, 6),
      gainDb: round(clamp(num(cue.gainDb, 0), -60, 12), 2),
      fadeIn: round(clamp(num(cue.fadeIn, 0), 0, 60), 3),
      fadeOut: round(clamp(num(cue.fadeOut, 0), 0, 60), 3),
      loop: cue.loop === true
    }
    if (inline) entry.data = cue.data
    else entry.src = joinSrc(request.basePath, source)
    return entry
  }).sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const lastAt = cues[cues.length - 1].at
  const duration = request.duration === undefined || request.duration === null
    ? round(lastAt + 1, 6)
    : round(num(request.duration, NaN), 6)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
    throw new Error(`duration must be seconds between 0 and 3600, got ${request.duration}`)
  }
  if (duration < lastAt) {
    throw new Error(`duration ${duration}s ends before the last cue at ${lastAt}s`)
  }

  const sheet = { duration, cues }
  return { cues, json: JSON.stringify(sheet, null, 2), script: renderPlayer(sheet) }
}

/* ---- inline audio ---- */

/**
 * Embed wav files as base64 `data:` URIs so the deliverable is one file.
 *
 * Entries are `{ name, path }` (read from disk, relative to `cwd` or absolute)
 * or `{ name, bytes }` / `{ name, data }` for in-memory audio. Returns the
 * exact page weight in `totalBytes` (data-URI length, i.e. what actually lands
 * in the HTML) and refuses — with a polite, actionable error — above
 * `maxBytes` instead of silently producing a 40 MB page.
 *
 * @param {{ entries: object[], maxBytes?: number, cwd?: string }} request
 * @returns {Promise<{ entries: object[], rawBytes: number, totalBytes: number, maxBytes: number }>}
 */
export async function inlineAudio (request = {}) {
  const rawEntries = request.entries
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error('inlineAudio needs at least one entry')
  }
  const maxBytes = Number.isFinite(Number(request.maxBytes)) && Number(request.maxBytes) > 0
    ? Math.floor(Number(request.maxBytes))
    : DEFAULT_MAX_INLINE_BYTES
  const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : process.cwd()

  const entries = []
  let rawBytes = 0
  for (const raw of rawEntries) {
    const name = String(raw?.name ?? '').trim()
    if (name === '') throw new Error('inlineAudio: every entry needs a name')
    let bytes
    if (typeof raw?.path === 'string' && raw.path !== '') {
      const target = isAbsolute(raw.path) ? resolve(raw.path) : resolve(cwd, raw.path)
      bytes = await readFile(target)
    } else if (raw?.bytes !== undefined) {
      bytes = Buffer.from(raw.bytes)
    } else if (raw?.data !== undefined) {
      bytes = Buffer.from(String(raw.data), 'base64')
    } else {
      throw new Error(`inlineAudio: entry "${name}" needs path, bytes or data`)
    }
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`inlineAudio: entry "${name}" is not a RIFF/WAVE file`)
    }
    rawBytes += bytes.length
    const src = `data:audio/wav;base64,${bytes.toString('base64')}`
    entries.push({ name, src, bytes: bytes.length, dataUriBytes: src.length })
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.dataUriBytes, 0)
  if (totalBytes > maxBytes) {
    const error = new Error(
      `inline audio would add ${formatBytes(totalBytes)} to the page ` +
      `(${entries.length} cue${entries.length === 1 ? '' : 's'}, ${formatBytes(rawBytes)} of wav), ` +
      `above the ${formatBytes(maxBytes)} budget. Shorten or drop some cues, re-render at ` +
      'sampleRate 22050, or raise maxBytes if the page is allowed to be that heavy.'
    )
    error.code = 'AUDIO_TOO_LARGE'
    error.totalBytes = totalBytes
    error.rawBytes = rawBytes
    error.maxBytes = maxBytes
    throw error
  }

  return { entries, rawBytes, totalBytes, maxBytes }
}

/* ---- schedule drift ---- */

/**
 * Worst-case scheduling error budget, in samples, for a cue list at a device
 * sample rate. The player asks for absolute seconds; the audio clock resolves
 * a start to the nearest sample frame, so half a frame is the rounding bound,
 * and the whole budget is one sample. Timer jitter contributes zero because
 * the look-ahead window is wider than the wake interval, so a wake-up can be
 * late by up to `marginSeconds` without moving a cue.
 *
 * @param {{ name?: string, at: number }[]} cues
 * @param {number} [sampleRate] - device rate in Hz (48000 is the common case).
 * @returns {object} per-cue maths plus the budget the model can quote.
 */
export function cueScheduleDrift (cues, sampleRate = 48000) {
  const rate = clamp(Math.round(Number(sampleRate) || 48000), 8000, 192000)
  if (!Array.isArray(cues) || cues.length === 0) {
    throw new Error('cueScheduleDrift needs at least one cue')
  }
  let worst = null
  const rows = cues.map((cue, index) => {
    const at = Number(cue?.at)
    if (!Number.isFinite(at) || at < 0) throw new Error(`cue ${index + 1} has no valid at time`)
    const exactFrames = at * rate
    const frame = Math.round(exactFrames)
    const errorSamples = Math.abs(exactFrames - frame)
    const row = {
      name: String(cue?.name ?? `cue-${index + 1}`),
      at,
      exactFrames: round(exactFrames, 6),
      frame,
      errorSamples: round(errorSamples, 9),
      errorMs: round(errorSamples / rate * 1000, 9)
    }
    if (worst === null || errorSamples > worst.errorSamples) worst = { ...row, errorSamples }
    return row
  })
  const budgetSamples = Math.max(1, Math.ceil(worst.errorSamples + 0.5))
  return {
    sampleRate: rate,
    sampleMs: round(1000 / rate, 6),
    cues: rows,
    worstCue: worst,
    roundingSamples: 0.5,
    worstCaseSamples: budgetSamples,
    worstCaseMs: round(budgetSamples / rate * 1000, 6),
    lookahead: {
      aheadSeconds: PLAYER_TIMING.aheadSeconds,
      wakeSeconds: PLAYER_TIMING.wakeSeconds,
      marginSeconds: round(PLAYER_TIMING.aheadSeconds - PLAYER_TIMING.wakeSeconds, 3),
      timerCanShiftCue: false
    },
    math: `${budgetSamples} sample(s) = ceil(${round(worst.errorSamples, 6)} observed + 0.5 frame rounding) ` +
      `at ${rate} Hz = ${round(budgetSamples / rate * 1000, 4)} ms`
  }
}

function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
