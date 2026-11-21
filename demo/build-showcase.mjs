/**
 * Build `demo/showcase.html`: a 16.8 s single-file animation whose entire
 * soundtrack is rendered at build time by the dsh-audio engines, then verified
 * against the written bytes.
 *
 * Usage (node is not on PATH here):
 *   node demo/build-showcase.mjs
 *
 * The page contains no network references and no external files: every wav is
 * a base64 `data:audio/wav` URI, every sound comes from a seeded render, and
 * the animation clock is `AudioContext.currentTime` — the same clock the cues
 * are scheduled against.
 *
 * The build is deterministic: same seeds, same bytes. It renders the page
 * twice and asserts the two files are byte-identical.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composeScore, renderScore } from '../dsh-audio-lab/plugin/lib/compose.js'
import { designSound } from '../dsh-audio-lab/plugin/lib/design.js'
import { finalize, measure, mixTracks, renderPreset, writeFileAtomic } from '../dsh-audio-lab/plugin/lib/audio.js'
import { singPlan, renderSing } from '../dsh-audio-lab/plugin/lib/sing.js'
import { analyzeVisemes } from '../dsh-audio-lab/plugin/lib/lipsync.js'
import { buildCueSheet } from '../dsh-audio-lab/plugin/lib/bind.js'
import { encodeWavBase64 } from '../dsh-audio-lab/plugin/lib/wav-encode.js'
import { decodeWav } from '../dsh-audio-lab/plugin/lib/wav.js'

/* ------------------------------------------------------------- constants -- */

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'showcase.html')

const SAMPLE_RATE = 22050
const BPM = 120
const BARS = 8
const BEATS_PER_BAR = 4
const GENRE = 'lofi'
const KEY = 'D'
const MODE = 'dorian'
const SCORE_SEED = 7
const INTENSITY = 0.78
const LEAD_SECONDS = 0.12
const WAVE_COLUMNS = 220

/**
 * The cue list. `beat` is an index into the score's `beatMap`; every `at` is
 * read from that map, so no cue time is invented by hand. `bits` is the wav
 * bit depth chosen per cue: the long bed and the sung voice stay 16-bit, the
 * percussive cues go 8-bit (dither noise sits under transients).
 */
const CUE_SPECS = [
  {
    name: 'bed',
    effect: 'bed',
    beat: 0,
    bits: 16,
    gainDb: -3,
    engine: 'composeScore → renderScore',
    detail: 'lofi · 8 bars · D dorian'
  },
  {
    name: 'zap',
    effect: 'zap',
    beat: 2,
    bits: 8,
    gainDb: -8,
    engine: 'renderPreset("zap")',
    detail: 'wake-up arc, 0.5 s'
  },
  {
    name: 'door',
    effect: 'door',
    beat: 8,
    bits: 8,
    gainDb: -4,
    engine: 'designSound("door-slam-metal")',
    detail: '5 layers + hall reverb'
  },
  {
    name: 'voice',
    effect: 'voice',
    beat: 12,
    bits: 16,
    gainDb: -3,
    engine: 'singPlan → renderSing',
    detail: '"wo ai ni" · alto + third'
  },
  {
    name: 'sparkle',
    effect: 'sparkle',
    beat: 16,
    bits: 8,
    gainDb: -7,
    engine: 'designSound("magic-sparkle")',
    detail: '6 layers, trimmed 1.2 s'
  },
  {
    name: 'riser',
    effect: 'riser',
    beat: 21,
    bits: 8,
    gainDb: -10,
    engine: 'renderPreset("riser")',
    detail: '1.5 s charge into the coin'
  },
  {
    name: 'coin',
    effect: 'coin',
    beat: 24,
    bits: 8,
    gainDb: -6,
    engine: 'designSound("coin-pickup")',
    detail: 'chime + tick'
  },
  {
    name: 'badge',
    effect: 'badge',
    beat: 28,
    bits: 8,
    gainDb: -5,
    engine: 'designSound("ui-success")',
    detail: 'stamp on the outro'
  }
]

/* ------------------------------------------------------------- utilities -- */

const bytesKb = (n) => `${(n / 1024).toFixed(1)} KB`
const db = (value) => (value > 0 ? 20 * Math.log10(value) : -120)

/** Small deterministic seed per cue, so each wav's dither differs but repeats. */
function ditherSeed (name, index) {
  let hash = 0x51ED + index * 7919
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return hash >>> 0
}

/** Encode one mono render as a wav data URI at the cue's bit depth. */
function encodeCue (samples, spec, index) {
  return encodeWavBase64(samples, SAMPLE_RATE, {
    bitDepth: spec.bits,
    dither: true,
    ditherSeed: ditherSeed(spec.name, index)
  })
}

/** Peak / rms / duration of one channel buffer, in dBFS. */
function levelOf (channels) {
  let peak = 0
  let squares = 0
  let count = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i]
      const magnitude = value < 0 ? -value : value
      if (magnitude > peak) peak = magnitude
      squares += value * value
      count += 1
    }
  }
  return { peakDbfs: Number(db(peak).toFixed(2)), rmsDbfs: Number(db(Math.sqrt(squares / Math.max(1, count))).toFixed(2)) }
}

/* --------------------------------------------------------- render assets -- */

/**
 * Render every sound the page needs and assemble the cue list.
 * @returns {object} cue metadata (with data URIs), the mix envelope, measurements.
 */
function renderAssets () {
  const score = composeScore({
    genre: GENRE,
    bpm: BPM,
    bars: BARS,
    key: KEY,
    mode: MODE,
    seed: SCORE_SEED,
    intensity: INTENSITY
  })
  const bed = renderScore(score, { sampleRate: SAMPLE_RATE })
  const beatMap = bed.beatMap
  if (beatMap.length !== BARS * BEATS_PER_BAR) throw new Error(`beatMap has ${beatMap.length} entries, expected ${BARS * BEATS_PER_BAR}`)

  const voicePlan = singPlan({ melody: 'D4:1 F4:1 A4:2', lyric: 'wo ai ni', bpm: BPM })
  const voice = renderSing(voicePlan, { sampleRate: SAMPLE_RATE, voice: 'alto', harmony: 'third' })
  finalize(voice.samples, voice.sampleRate)
  const visemes = analyzeVisemes(voice.samples, SAMPLE_RATE, { fps: 30 })
  if (visemes.frames.length === 0) throw new Error('analyzeVisemes returned no frames')

  const renders = {
    bed: { samples: bed.samples, sampleRate: bed.sampleRate },
    voice: { samples: voice.samples, sampleRate: voice.sampleRate },
    zap: wrap(renderPreset({ preset: 'zap', params: { pitch: 0.62, roughness: 0.45, brightness: 0.7 }, duration: 0.5, seed: 12, sampleRate: SAMPLE_RATE })),
    door: wrap(designSound({ recipe: 'door-slam-metal', seed: 4, sampleRate: SAMPLE_RATE })),
    sparkle: wrap(designSound({ recipe: 'magic-sparkle', seed: 6, sampleRate: SAMPLE_RATE, duration: 1.2 })),
    riser: wrap(renderPreset({ preset: 'riser', params: { rise: 0.72, tone: 0.45, tension: 0.6 }, duration: 1.5, seed: 15, sampleRate: SAMPLE_RATE })),
    coin: wrap(designSound({ recipe: 'coin-pickup', seed: 9, sampleRate: SAMPLE_RATE })),
    badge: wrap(designSound({ recipe: 'ui-success', seed: 11, sampleRate: SAMPLE_RATE }))
  }

  const cues = []
  const timeline = []
  CUE_SPECS.forEach((spec, index) => {
    const render = renders[spec.name]
    if (render === undefined) throw new Error(`no render for cue "${spec.name}"`)
    if (spec.name !== 'bed') finalize(render.samples, render.sampleRate)
    const at = spec.beat === 0 ? 0 : beatMap[spec.beat]
    if (at === undefined) throw new Error(`cue "${spec.name}" beat ${spec.beat} is outside the beatMap`)
    const encoded = encodeCue(render.samples, spec, index)
    const dur = Number((render.samples.length / render.sampleRate).toFixed(6))
    cues.push({
      name: spec.name,
      effect: spec.effect,
      at,
      beat: spec.beat,
      gainDb: spec.gainDb,
      bits: spec.bits,
      dur,
      engine: spec.engine,
      detail: spec.detail,
      src: encoded.dataUri
    })
    timeline.push({ name: spec.name, samples: render.samples, sampleRate: render.sampleRate, at, gainDb: spec.gainDb })
  })

  // Mix the same timeline the browser will play, at the same gains, to prove
  // the sum does not clip before it ever reaches the page.
  const mixed = mixTracks(
    timeline.map((track) => ({ samples: track.samples, sampleRate: track.sampleRate })),
    {
      sampleRate: SAMPLE_RATE,
      gains: timeline.map((track) => track.gainDb),
      offsets: timeline.map((track) => track.at),
      durationSeconds: bed.durationSeconds,
      limiter: false
    }
  )
  const mixedMeasure = measure(mixed.samples, SAMPLE_RATE)
  const wave = envelope(mixed.samples, WAVE_COLUMNS)

  const frames = visemes.frames.map((frame) => [
    VISEME_INDEX[frame.viseme],
    Math.round(frame.openness * 100),
    Math.round(frame.energy * 100)
  ])

  return {
    score,
    bed,
    beatMap,
    voicePlan,
    voice,
    visemes,
    visemeFrames: frames,
    cues,
    mixedMeasure,
    wave,
    durationSeconds: bed.durationSeconds
  }
}

/** Normalise a render result to { samples, sampleRate }. */
function wrap (rendered) {
  return { samples: rendered.samples, sampleRate: rendered.sampleRate }
}

/** Peak envelope, one integer 0..100 per column, so the timeline can draw it. */
function envelope (samples, columns) {
  const step = samples.length / columns
  const out = new Array(columns)
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor(column * step)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((column + 1) * step)))
    let peak = 0
    for (let i = from; i < to; i += 1) {
      const magnitude = samples[i] < 0 ? -samples[i] : samples[i]
      if (magnitude > peak) peak = magnitude
    }
    out[column] = Math.round(Math.min(1, peak) * 100)
  }
  return out
}

const VISEME_INDEX = {
  AA: 0, EH: 1, EE: 2, OH: 3, OO: 4, MM: 5, FF: 6, TH: 7, SS: 8, DD: 9, none: 10
}

/* -------------------------------------------------------------- page data -- */

/** Everything the runtime needs, minus the base64 payload already in the cues. */
function buildPageData (assets) {
  const inlineBytes = assets.cues.reduce((sum, cue) => sum + cue.src.length, 0)
  return {
    title: 'dsh-audio · one take',
    generator: 'dsh-audio-lab/plugin/lib',
    sampleRate: SAMPLE_RATE,
    bpm: BPM,
    bars: BARS,
    beatsPerBar: BEATS_PER_BAR,
    genre: GENRE,
    key: KEY,
    mode: MODE,
    seed: SCORE_SEED,
    lead: LEAD_SECONDS,
    duration: assets.durationSeconds,
    beatMap: assets.beatMap,
    sections: assets.score.sections.map((section) => ({ name: section.name, fromBar: section.fromBar, toBar: section.toBar })),
    wave: assets.wave,
    voice: {
      at: assets.cues.find((cue) => cue.name === 'voice').at,
      fps: assets.visemes.fps,
      visemes: ['AA', 'EH', 'EE', 'OH', 'OO', 'MM', 'FF', 'TH', 'SS', 'DD', 'none'],
      frames: assets.visemeFrames,
      syllables: assets.voice.syllableTimings.map((entry) => ({ text: entry.text, start: Number(entry.start.toFixed(3)), end: Number(entry.end.toFixed(3)) }))
    },
    cues: assets.cues.map((cue) => ({
      name: cue.name,
      effect: cue.effect,
      at: cue.at,
      beat: cue.beat,
      gainDb: cue.gainDb,
      bits: cue.bits,
      dur: cue.dur,
      engine: cue.engine,
      detail: cue.detail,
      src: cue.src
    })),
    stats: {
      inlineBytes,
      mixPeakDbfs: assets.mixedMeasure.peakDbfs,
      mixRmsDbfs: assets.mixedMeasure.rmsDbfs,
      beats: assets.beatMap.length,
      cues: assets.cues.length
    }
  }
}

/* ---------------------------------------------------------------- runtime -- */

/**
 * The page runtime. Runs as a classic script (no modules, no imports), exposes
 * `window.dshStage`, and takes every timestamp from the AudioContext clock.
 * Index signature is the build-time JSON: cue times, beat map, viseme frames.
 */
const RUNTIME = String.raw`(function () {
  'use strict'

  var DATA = JSON.parse(document.getElementById('audio-data').textContent)
  var SR = DATA.sampleRate
  var DUR = DATA.duration
  var BEATS = DATA.beatMap
  var CUES = DATA.cues
  var VIS = DATA.voice.visemes
  var MOUTH = {
    AA: [34, 24], EH: [30, 19], EE: [31, 10], OH: [23, 22], OO: [15, 18],
    MM: [22, 4], FF: [26, 7], TH: [24, 8], SS: [25, 5], DD: [26, 9], none: [21, 3]
  }
  var BLINKS = [6.32, 9.84, 13.24]
  var EV = {}
  var DUR_BY = {}
  for (var ci = 0; ci < CUES.length; ci += 1) {
    EV[CUES[ci].effect] = CUES[ci].at
    DUR_BY[CUES[ci].name] = CUES[ci].dur
  }

  var state = {
    playing: false,
    done: false,
    t0: 0,
    audio: null,
    buffers: [],
    sources: [],
    next: 0,
    raf: 0,
    timer: 0,
    comp: null,
    analyser: null,
    freq: null,
    lit: -1,
    tickOn: [],
    rowFired: [],
    rowActive: [],
    markOn: [],
    sparkOn: [],
    lyricOn: [],
    lastCue: null,
    logged: {},
    beatLit: -1,
    started: 0
  }

  var $ = function (id) { return document.getElementById(id) }
  var el = {
    gate: $('gate'), gateTitle: $('gate-title'), gateSub: $('gate-sub'), gateNote: $('gate-note'), start: $('start'),
    status: $('status'), bpm: $('hud-bpm'), beat: $('hud-beat'), time: $('hud-time'), section: $('hud-section'),
    rig: $('rig'), head: $('head'), mouth: $('mouth'), eyeL: $('eye-l'), eyeR: $('eye-r'), aura: $('aura'),
    door: $('door'), coin: $('coin'), coinCount: $('coin-count'), badge: $('badge'), sparks: $('sparks'),
    notes: $('notes'), charge: $('charge'), chargeFill: $('charge-fill'), flash: $('flash'), stage: $('stage'),
    ring: $('ring'), spectrum: $('spectrum'), wave: $('wave'), markers: $('markers'), playhead: $('playhead'),
    clock: $('clock'), clockTotal: $('clock-total'), beatrow: $('beatrow'), cueList: $('cue-list'),
    cueCount: $('cue-count'), cueFootText: $('cue-foot-text'), lyrics: $('lyrics'), now: $('now'),
    shadow: $('shadow'), buildScore: $('build-score'), buildRate: $('build-rate'), buildWavs: $('build-wavs'),
    buildMix: $('build-mix'), buildVis: $('build-vis'), log: $('log'), gateList: $('gate-list')
  }

  var ticks = []
  var sparks = []
  var notes = []
  var rows = []
  var marks = []
  var beatTicks = []
  var lyricSpans = []
  var palettes = null

  /* ---- build the static pieces once ---- */

  function node (tag, className) {
    var created = document.createElement(tag)
    if (className) created.className = className
    return created
  }

  function buildRing () {
    var total = BEATS.length
    for (var i = 0; i < total; i += 1) {
      var tick = node('i', 'tick')
      var angle = (i * 360) / total
      tick.style.transform = 'rotate(' + angle.toFixed(3) + 'deg) translateY(-172px)'
      tick.style.height = (i % 4 === 0 ? 14 : 9) + 'px'
      el.ring.appendChild(tick)
      ticks.push(tick)
      state.tickOn.push(true)
    }
  }

  function buildSparks () {
    for (var i = 0; i < 16; i += 1) {
      var spark = node('i', 'spark')
      spark.style.opacity = '0'
      el.sparks.appendChild(spark)
      sparks.push(spark)
    }
  }

  function buildNotes () {
    for (var i = 0; i < 4; i += 1) {
      var note = node('i', 'note')
      note.textContent = i % 2 === 0 ? '\u266a' : '\u266b'
      note.style.opacity = '0'
      el.notes.appendChild(note)
      notes.push(note)
    }
  }

  function buildCueList () {
    el.cueCount.textContent = CUES.length + ' cues · ' + CUES.length + ' inline wavs'
    for (var ci = 0; ci < CUES.length; ci += 1) {
      var cue = CUES[ci]
      var li = node('li', 'row')
      var dot = node('i', 'dot')
      var name = node('span', 'nm')
      var engine = node('span', 'eng')
      var beat = node('span', 'bt')
      var at = node('span', 'at')
      name.textContent = cue.name
      engine.textContent = cue.engine
      beat.textContent = cue.beat === null ? '—' : 'b' + cue.beat
      at.textContent = cue.at.toFixed(2) + 's'
      li.appendChild(dot)
      li.appendChild(name)
      li.appendChild(engine)
      li.appendChild(beat)
      li.appendChild(at)
      el.cueList.appendChild(li)
      rows.push(li)
      state.rowFired.push(false)
      state.rowActive.push(false)
      var marker = node('i', 'mark')
      marker.style.left = ((cue.at / DUR) * 100).toFixed(3) + '%'
      el.markers.appendChild(marker)
      marks.push(marker)
      state.markOn.push(false)
    }
    el.cueCount.textContent = CUES.length + ' cues · ' + CUES.length + ' inline wavs'
    el.cueFootText.textContent = 'beatMap ' + BEATS.length + ' entries · ' + SR + ' Hz · ' + (DATA.stats.inlineBytes / 1048576).toFixed(2) + ' MB inline audio · build mix peak ' + DATA.stats.mixPeakDbfs.toFixed(1) + ' dBFS'
    el.buildScore.textContent = DATA.genre + ' · ' + DATA.key + ' ' + DATA.mode + ' · seed ' + DATA.seed
    el.buildRate.textContent = SR + ' Hz mono'
    el.buildWavs.textContent = CUES.length + ' wavs · ' + (DATA.stats.inlineBytes / 1048576).toFixed(2) + ' MB'
    el.buildMix.textContent = 'peak ' + DATA.stats.mixPeakDbfs.toFixed(1) + ' · rms ' + DATA.stats.mixRmsDbfs.toFixed(1) + ' dBFS'
    el.buildVis.textContent = DATA.voice.frames.length + ' frames @ ' + DATA.voice.fps + ' fps'
    el.clockTotal.textContent = DUR.toFixed(2) + ' s'
    for (var b = 0; b < BEATS.length; b += 1) {
      var bt2 = node('i', b % 4 === 0 ? 'bar' : '')
      el.beatrow.appendChild(bt2)
      beatTicks.push(bt2)
    }
  }

  function buildLyrics () {
    var syllables = DATA.voice.syllables || []
    for (var i = 0; i < syllables.length; i += 1) {
      var span = node('span', 'syl')
      span.textContent = syllables[i].text
      el.lyrics.appendChild(span)
      state.lyricOn.push(false)
      lyricSpans.push(span)
    }
  }

  function clearLog () {
    el.log.innerHTML = ''
    state.logged = {}
    state.lastCue = null
    // The first render after a reset must see every cue as not-yet-fired, or
    // the rows would keep a stale transition and never reach the log.
    for (var i = 0; i < state.rowFired.length; i += 1) {
      state.rowFired[i] = false
      state.rowActive[i] = false
      rows[i].classList.remove('fired')
      rows[i].classList.remove('active')
      marks[i].classList.remove('on')
    }
  }

  function logCue (cue) {
    if (state.logged[cue.name] === true) return
    state.logged[cue.name] = true
    var line = node('div', 'log-line')
    var when = node('span', 'lt')
    var name = node('span', 'ln')
    var engine = node('span', 'le')
    when.textContent = cue.at.toFixed(2) + 's'
    name.textContent = cue.name
    engine.textContent = cue.engine
    line.appendChild(when)
    line.appendChild(name)
    line.appendChild(engine)
    el.log.appendChild(line)
  }

  function buildGateList () {
    // Built from the cue data, not typed by hand: if the cue sheet changes, the
    // card on the gate changes with it.
    var picked = 0
    for (var i = 0; i < CUES.length && picked < 4; i += 1) {
      var cue = CUES[i]
      if (cue.effect === 'bed') continue
      var li = node('li')
      var beat = node('b')
      var text = node('span')
      beat.textContent = 'b' + cue.beat
      text.textContent = cue.name + ' · ' + cue.detail
      li.appendChild(beat)
      li.appendChild(text)
      el.gateList.appendChild(li)
      picked += 1
    }
  }

  function buildPalettes () {    var live = []
    var cold = []
    for (var i = 0; i < 64; i += 1) {
      var p = i / 63
      var r = Math.round(94 + p * 161)
      var g = Math.round(231 - p * 109)
      var b = Math.round(255 - p * 31)
      live.push('rgba(' + r + ',' + g + ',' + b + ',0.92)')
      cold.push('rgba(' + Math.round(r * 0.45) + ',' + Math.round(g * 0.45) + ',' + Math.round(b * 0.45) + ',0.5)')
    }
    palettes = { live: live, cold: cold }
  }

  /* ---- clock helpers ---- */

  function beatAt (t) {
    if (t <= 0) return 0
    var last = BEATS.length - 1
    if (t >= BEATS[last]) {
      var tail = DUR - BEATS[last]
      var overflow = tail > 0 ? (t - BEATS[last]) / (tail > 0 ? DUR - BEATS[last] : 1) : 0
      return last + Math.min(0.999, overflow)
    }
    var lo = 0
    var hi = last
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1
      if (BEATS[mid] <= t) lo = mid
      else hi = mid
    }
    var span = BEATS[lo + 1] - BEATS[lo]
    return lo + (t - BEATS[lo]) / span
  }

  function sectionName (beat) {
    var bar = beat / DATA.beatsPerBar
    var sections = DATA.sections
    for (var i = 0; i < sections.length; i += 1) {
      if (bar >= sections[i].fromBar && bar < sections[i].toBar) return sections[i].name
    }
    return sections.length > 0 ? sections[sections.length - 1].name : '—'
  }

  function clamp01 (value) { return value < 0 ? 0 : value > 1 ? 1 : value }

  /* ---- mouth ---- */

  function mouthFrame (t) {
    var voice = DATA.voice
    var local = t - voice.at
    var total = voice.frames.length / voice.fps
    if (local < 0 || local >= total) return null
    var index = Math.floor(local * voice.fps)
    if (index < 0) index = 0
    if (index >= voice.frames.length) index = voice.frames.length - 1
    return voice.frames[index]
  }

  function setMouth (viseme, openness) {
    var shape = MOUTH[viseme] || MOUTH.none
    var height = 3 + shape[1] * openness
    el.mouth.style.width = shape[0] + 'px'
    el.mouth.style.height = height.toFixed(1) + 'px'
    el.mouth.style.borderRadius = viseme === 'OO' || viseme === 'OH' ? '50%' : '8px'
    el.mouth.style.boxShadow = 'inset 0 1px 6px rgba(0,0,0,0.9), 0 0 ' + (9 + openness * 20).toFixed(0) + 'px rgba(94,231,255,' + (0.24 + openness * 0.5).toFixed(2) + ')'
    el.mouth.dataset.viseme = viseme
  }

  /* ---- canvases ---- */

  function fit (canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    var width = canvas.clientWidth || 640
    var height = canvas.clientHeight || 64
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    var context = canvas.getContext('2d')
    if (!context || typeof context.setTransform !== 'function') return null
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    return { g: context, w: width, h: height }
  }

  function drawSpectrum (t) {
    var view = fit(el.spectrum)
    if (!view) return
    var g = view.g
    if (typeof g.clearRect !== 'function' || typeof g.fillRect !== 'function') return
    g.clearRect(0, 0, view.w, view.h)
    var bins = 64
    var gap = 1.5
    var barWidth = (view.w - gap * (bins - 1)) / bins
    var data = state.freq
    if (state.analyser) {
      if (!data || data.length !== state.analyser.frequencyBinCount) {
        data = new Uint8Array(state.analyser.frequencyBinCount)
        state.freq = data
      }
      state.analyser.getByteFrequencyData(data)
    }
    for (var i = 0; i < bins; i += 1) {
      var value = 0
      if (data && data.length > 0) {
        var from = Math.floor(Math.pow(i / bins, 1.7) * data.length)
        var to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bins, 1.7) * data.length))
        var sum = 0
        var count = 0
        for (var k = from; k < to && k < data.length; k += 1) {
          sum += data[k]
          count += 1
        }
        value = count > 0 ? sum / count / 255 : 0
      }
      var height = Math.max(1.5, Math.pow(value, 1.3) * (view.h - 3))
      g.fillStyle = value > 0.04 ? palettes.live[Math.min(63, i)] : palettes.cold[Math.min(63, i)]
      g.fillRect(i * (barWidth + gap), view.h - height, barWidth, height)
    }
  }

  function drawWave (t) {
    var view = fit(el.wave)
    if (!view) return
    var g = view.g
    if (typeof g.clearRect !== 'function' || typeof g.fillRect !== 'function') return
    g.clearRect(0, 0, view.w, view.h)
    var columns = Math.max(48, Math.floor(view.w / 3))
    var step = view.w / columns
    var played = clamp01(t / DUR)
    var wave = DATA.wave
    for (var i = 0; i < columns; i += 1) {
      var value = wave[Math.min(wave.length - 1, Math.floor((i / columns) * wave.length))] / 100
      var height = Math.max(1.5, value * (view.h - 3))
      var lit = (i + 0.5) / columns <= played
      g.fillStyle = lit ? 'rgba(110,242,192,0.92)' : 'rgba(110,150,190,0.26)'
      g.fillRect(i * step, (view.h - height) / 2, Math.max(1, step - 1.1), height)
    }
    g.fillStyle = 'rgba(126,231,255,0.16)'
    g.fillRect(0, view.h / 2 - 0.5, view.w, 1)
  }

  /* ---- one frame ---- */

  function render (t) {
    var beat = beatAt(t)
    var phase = beat - Math.floor(beat)

    el.beat.textContent = beat.toFixed(2) + ' / ' + BEATS.length
    el.time.textContent = t.toFixed(2) + ' s'
    el.section.textContent = sectionName(beat)
    el.clock.textContent = t.toFixed(2)
    el.playhead.style.left = (clamp01(t / DUR) * 100).toFixed(3) + '%'

    // mouth: exactly the analysed viseme for this frame of the sung phrase
    var frame = mouthFrame(t)
    if (frame === null) setMouth('none', 0)
    else setMouth(VIS[frame[0]] || 'none', frame[1] / 100)

    // lyrics: the syllable being sung lights up from the render's own timings
    var voiceLocal = t - DATA.voice.at
    for (var ls = 0; ls < lyricSpans.length; ls += 1) {
      var syl = DATA.voice.syllables[ls]
      var sylOn = voiceLocal >= syl.start && voiceLocal < syl.end
      if (sylOn !== state.lyricOn[ls]) {
        state.lyricOn[ls] = sylOn
        if (sylOn) lyricSpans[ls].classList.add('on')
        else lyricSpans[ls].classList.remove('on')
      }
    }

    // caption: the most recent cue, with the engine and design that made it
    var latest = null
    for (var nc = 0; nc < CUES.length; nc += 1) {
      if (t >= CUES[nc].at) latest = CUES[nc]
    }
    if (latest !== null && latest !== state.lastCue) {
      state.lastCue = latest
      el.now.textContent = latest.name + ' · ' + latest.engine + ' · ' + latest.detail
    }

    // voice notes drift up from the mouth while the phrase lasts
    for (var n = 0; n < notes.length; n += 1) {
      var noteAge = t - DATA.voice.at - n * 0.34
      if (noteAge < 0 || noteAge > 0.95) {
        notes[n].style.opacity = '0'
      } else {
        var noteP = noteAge / 0.95
        notes[n].style.opacity = String(Math.max(0, 1 - noteP))
        notes[n].style.transform = 'translate(' + (Math.sin(noteAge * 6.5 + n) * 16).toFixed(1) + 'px,' + (-28 - noteAge * 62).toFixed(1) + 'px)'
      }
    }

    // eyes: asleep until the zap, then open, with three blinks
    var open = t < EV.zap ? 0.12 : 1
    for (var b = 0; b < BLINKS.length; b += 1) {
      if (Math.abs(t - BLINKS[b]) < 0.07) open = 0.12
    }
    el.eyeL.style.transform = 'translateX(-50%) scaleY(' + open.toFixed(2) + ')'
    el.eyeR.style.transform = 'translateX(-50%) scaleY(' + open.toFixed(2) + ')'

    // ring: every passed beat lights one tick, the ring breathes on the grid
    var lit = Math.floor(beat)
    if (lit !== state.lit) {
      for (var i = 0; i < ticks.length; i += 1) {
        var on = i <= lit
        if (on !== state.tickOn[i]) {
          state.tickOn[i] = on
          ticks[i].style.background = on ? 'rgba(94,231,255,0.9)' : 'rgba(120,190,230,0.3)'
          ticks[i].style.boxShadow = on ? '0 0 9px rgba(94,231,255,0.85)' : 'none'
        }
      }
      state.lit = lit
    }
    el.aura.style.opacity = (0.38 + 0.5 * (1 - phase)).toFixed(2)
    el.aura.style.transform = 'scale(' + (1 + 0.07 * (1 - phase)).toFixed(3) + ')'

    // body: bob on the beat, camera shake after the door slams
    var bob = 4.5 * (1 - phase)
    var slam = t - EV.door
    var shakeX = 0
    var shakeY = 0
    if (slam >= 0 && slam < 1.4) {
      var decay = Math.exp(-slam * 7.5)
      shakeX = 16 * decay * Math.sin(slam * 61)
      shakeY = 10 * decay * Math.sin(slam * 47 + 1.1)
    }
    el.rig.style.transform = 'translate(' + shakeX.toFixed(2) + 'px,' + (bob + shakeY).toFixed(2) + 'px)'
    el.ring.style.transform = 'translate(' + (shakeX * 0.45).toFixed(2) + 'px,' + (shakeY * 0.45).toFixed(2) + 'px)'
    el.head.style.transform = 'rotate(' + ((shakeX * 0.25) + Math.sin(beat * Math.PI) * 1.2).toFixed(2) + 'deg)'
    el.shadow.style.transform = 'translateX(-50%) scale(' + (1 - bob * 0.012).toFixed(3) + ',' + (1 - bob * 0.02).toFixed(3) + ')'

    // door: waits above the stage, falls, lands on the beat, stays
    var doorAge = t - EV.door
    var doorY = -420
    if (doorAge >= 0) {
      var fall = Math.min(1, doorAge / 0.17)
      doorY = -420 * (1 - fall * fall)
    }
    el.door.style.opacity = doorAge >= 0 ? '1' : '0'
    el.door.style.transform = 'translate(0,' + doorY.toFixed(1) + 'px)'

    // zap flash and sparkle burst share the flash overlay
    var flash = 0
    var zapAge = t - EV.zap
    if (zapAge >= 0) flash = Math.max(flash, 0.8 * Math.exp(-zapAge * 7))
    var burstAge = t - EV.sparkle
    if (burstAge >= 0) flash = Math.max(flash, 0.32 * Math.exp(-burstAge * 9))
    var stampAge = t - EV.badge
    if (stampAge >= 0) flash = Math.max(flash, 0.3 * Math.exp(-stampAge * 11))
    el.flash.style.opacity = flash.toFixed(3)

    // sparkle burst: deterministic golden-angle scatter
    var sparkAge = t - EV.sparkle
    for (var s = 0; s < sparks.length; s += 1) {
      if (sparkAge < 0 || sparkAge > 1) {
        if (state.sparkOn[s] !== false) {
          state.sparkOn[s] = false
          sparks[s].style.opacity = '0'
        }
        continue
      }
      state.sparkOn[s] = true
      var sparkP = sparkAge
      var angle = s * 2.39996
      var radius = (44 + 214 * Math.sqrt(sparkP)) * (0.62 + (s % 5) * 0.12)
      sparks[s].style.opacity = String(Math.max(0, 1 - sparkP * 1.06))
      sparks[s].style.transform = 'translate(' + (Math.cos(angle) * radius).toFixed(1) + 'px,' + (Math.sin(angle) * radius * 0.78).toFixed(1) + 'px) scale(' + (1 - sparkP * 0.55).toFixed(2) + ') rotate(' + (s * 37 + sparkP * 220).toFixed(0) + 'deg)'
    }

    // riser: the charge bar fills from the riser cue to the coin
    var riserAge = t - EV.riser
    var riserDur = DUR_BY.riser
    var charge = riserAge <= 0 ? 0 : clamp01(riserAge / riserDur)
    el.chargeFill.style.width = (charge * 100).toFixed(1) + '%'
    el.charge.style.opacity = riserAge >= -0.2 && riserAge <= riserDur + 0.25 ? '1' : '0'

    // coin: arcs into the head, then the counter ticks over
    var coinAge = t - EV.coin
    if (coinAge < 0 || coinAge > 0.8) {
      el.coin.style.opacity = '0'
    } else {
      var coinP = coinAge / 0.8
      var x = -300 * (1 - coinP)
      var y = 160 * (1 - coinP) - Math.sin(Math.PI * coinP) * 130
      el.coin.style.opacity = String(Math.min(1, coinP * 7))
      el.coin.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotate(' + (coinP * 720).toFixed(0) + 'deg)'
    }
    el.coinCount.textContent = t >= EV.coin + 0.66 ? '1' : '0'

    // badge: stamps in on the outro
    var badgeAge = t - EV.badge
    if (badgeAge < 0) {
      el.badge.style.opacity = '0'
      el.badge.style.transform = 'scale(0.55) rotate(-7deg)'
    } else {
      var badgeP = Math.min(1, badgeAge / 0.3)
      var ease = 1 - Math.pow(1 - badgeP, 3)
      var scale = badgeP < 1 ? 1.9 - ease * 0.9 : 1
      el.badge.style.opacity = String(Math.min(1, badgeAge * 14))
      el.badge.style.transform = 'scale(' + scale.toFixed(3) + ') rotate(' + (-7 + ease * 7).toFixed(1) + 'deg)'
    }

    // cue list + timeline markers + beat row
    for (var c = 0; c < rows.length; c += 1) {
      var cue = CUES[c]
      var fired = t >= cue.at
      var active = fired && t < cue.at + cue.dur
      if (fired !== state.rowFired[c] || active !== state.rowActive[c]) {
        state.rowFired[c] = fired
        state.rowActive[c] = active
        if (fired) {
          rows[c].classList.add('fired')
          logCue(cue)
        } else {
          rows[c].classList.remove('fired')
        }
        if (active) rows[c].classList.add('active')
        else rows[c].classList.remove('active')
        if (fired) marks[c].classList.add('on')
        else marks[c].classList.remove('on')
      }
    }
    var beatLit = Math.floor(beat)
    if (beatLit !== state.beatLit) {
      for (var bt = 0; bt < beatTicks.length; bt += 1) {
        if (bt <= beatLit) beatTicks[bt].classList.add('on')
        else beatTicks[bt].classList.remove('on')
      }
      state.beatLit = beatLit
    }

    drawWave(t)
    drawSpectrum(t)
  }

  /* ---- audio ---- */

  function base64ToBytes (uri) {
    var comma = uri.indexOf(',')
    var text = comma >= 0 ? uri.slice(comma + 1) : uri
    var binary = atob(text)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function decodeAll (audio) {
    var jobs = []
    for (var i = 0; i < CUES.length; i += 1) jobs.push(decodeOne(audio, CUES[i]))
    return Promise.all(jobs).then(function (buffers) { state.buffers = buffers })
  }

  function decodeOne (audio, cue) {
    return audio.decodeAudioData(base64ToBytes(cue.src).buffer)
  }

  function buildGraph (audio) {
    if (state.comp) return
    var comp = audio.createDynamicsCompressor()
    comp.threshold.value = -8
    comp.knee.value = 8
    comp.ratio.value = 6
    comp.attack.value = 0.004
    comp.release.value = 0.24
    var master = audio.createGain()
    master.gain.value = 0.92
    var analyser = audio.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.72
    comp.connect(master)
    master.connect(analyser)
    analyser.connect(audio.destination)
    state.comp = comp
    state.analyser = analyser
  }

  function schedule () {
    if (!state.playing || !state.audio) return
    var audio = state.audio
    var now = audio.currentTime - state.t0
    var horizon = now + 0.4
    while (state.next < CUES.length && CUES[state.next].at <= horizon) {
      var index = state.next
      var cue = CUES[index]
      var source = audio.createBufferSource()
      var gain = audio.createGain()
      source.buffer = state.buffers[index]
      gain.gain.value = Math.pow(10, cue.gainDb / 20)
      source.connect(gain)
      gain.connect(state.comp)
      source.start(state.t0 + cue.at)
      state.sources.push(source)
      state.next += 1
    }
    state.timer = state.next < CUES.length ? setTimeout(schedule, 40) : 0
  }

  function loop () {
    if (!state.playing) return
    var audio = state.audio
    var t = audio.currentTime - state.t0
    if (t >= DUR) {
      render(DUR)
      finish()
      return
    }
    render(t < 0 ? 0 : t)
    state.raf = requestAnimationFrame(loop)
  }

  function stopSources () {
    for (var i = 0; i < state.sources.length; i += 1) {
      try { state.sources[i].stop() } catch (error) {}
      try { state.sources[i].disconnect() } catch (error) {}
    }
    state.sources.length = 0
  }

  function stopAll () {
    state.playing = false
    if (state.timer) { clearTimeout(state.timer); state.timer = 0 }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0 }
    stopSources()
    state.next = 0
  }

  function fail (error) {
    state.playing = false
    if (state.timer) { clearTimeout(state.timer); state.timer = 0 }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0 }
    el.status.textContent = 'audio blocked'
    el.gateTitle.textContent = 'audio could not start'
    el.gateSub.textContent = String(error && error.message ? error.message : error)
    el.start.textContent = 'try again'
    el.gate.classList.add('show')
    el.gateNote.textContent = 'The animation only runs on the AudioContext clock, so it does not pretend to play without audio.'
  }

  function finish () {
    stopAll()
    state.done = true
    render(DUR)
    el.status.textContent = 'complete'
    el.gateTitle.textContent = 'take complete · ' + DUR.toFixed(2) + ' s'
    el.gateSub.textContent = CUES.length + ' cues rendered from ' + BEAT_ENGINE()
    el.start.textContent = '\u21ba replay the take'
    el.gateNote.textContent = 'Same seeds, same bytes: node demo/build-showcase.mjs regenerates this page and re-runs every check.'
    el.gate.classList.add('show')
  }

  function BEAT_ENGINE () {
    return 'the score, the singer and four designed impacts — 0 network requests'
  }

  function start () {
    if (state.playing) return Promise.resolve(false)
    stopAll()
    clearLog()
    state.playing = true
    state.done = false
    el.status.textContent = 'decoding\u2026'
    el.gateNote.textContent = 'Decoding ' + CUES.length + ' inline wavs\u2026'
    var audio = state.audio
    if (!audio) {
      var Ctor = typeof AudioContext !== 'undefined' ? AudioContext : (window.AudioContext || window.webkitAudioContext)
      if (typeof Ctor !== 'function') {
        fail(new Error('this browser has no AudioContext'))
        return Promise.resolve(false)
      }
      try {
        audio = new Ctor()
      } catch (error) {
        fail(error)
        return Promise.resolve(false)
      }
      state.audio = audio
    }
    // Must be called synchronously inside the click: this is the gesture that
    // unlocks audio. Everything else waits on the promise chain below.
    var resuming = audio.resume()
    el.gate.classList.remove('show')
    var ready = state.buffers.length === CUES.length ? Promise.resolve() : decodeAll(audio)
    return ready.then(function () {
      return resuming
    }).then(function () {
      if (audio.state !== 'running') throw new Error('AudioContext is "' + audio.state + '" — the browser blocked autoplay')
      buildGraph(audio)
      state.t0 = audio.currentTime + DATA.lead
      state.next = 0
      state.started = audio.currentTime
      el.status.textContent = 'playing'
      schedule()
      loop()
      return true
    }).catch(function (error) {
      fail(error)
      return false
    })
  }

  /* ---- boot ---- */

  buildRing()
  buildSparks()
  buildNotes()
  buildLyrics()
  buildCueList()
  buildGateList()
  buildPalettes()
  el.bpm.textContent = String(DATA.bpm)
  el.gateSub.textContent = DUR.toFixed(1) + ' s · ' + DATA.bpm + ' bpm · ' + DATA.bars + ' bars · ' + CUES.length + ' inline wavs · ' + DATA.genre + ' score'
  el.status.textContent = 'idle'
  el.start.addEventListener('click', function () { start() })
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.playing) {
      stopAll()
      el.status.textContent = 'stopped (tab hidden)'
      el.gateTitle.textContent = 'stopped while hidden'
      el.start.textContent = '\u21ba replay the take'
      el.gate.classList.add('show')
    }
  })
  if (window.addEventListener) window.addEventListener('resize', function () { render(clockTime()) })
  render(0)

  function clockTime () {
    if (!state.playing || !state.audio) return state.done ? DUR : 0
    var t = state.audio.currentTime - state.t0
    return t < 0 ? 0 : t > DUR ? DUR : t
  }

  window.dshStage = {
    start: start,
    stop: stopAll,
    // Pure timeline snapshot: rebuilds the cue log for time t, so a reviewer
    // (or a screenshot pass) sees exactly what the page would show at t.
    renderAt: function (t) { clearLog(); render(t) },
    data: DATA,
    state: state
  }
}())`

/* ----------------------------------------------------------------- tools -- */

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-audio · one take · @DURATION@ s</title>
<style>
:root{
  --bg:#05070d;--panel:rgba(12,19,32,0.74);--line:rgba(126,231,255,0.16);
  --cyan:#5ee7ff;--mint:#6ef2c0;--amber:#ffc757;--pink:#ff7ae0;--green:#5df2a3;
  --ink:#e2edf9;--dim:#6d829c;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:radial-gradient(1100px 640px at 46% 10%,#0e1b33 0%,#070c15 55%,#04060b 100%);color:var(--ink);font:12px/1.45 var(--mono);overflow:hidden;-webkit-font-smoothing:antialiased}
#grid{position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(120,200,255,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(120,200,255,0.05) 1px,transparent 1px);background-size:52px 52px;-webkit-mask-image:radial-gradient(circle at 46% 42%,#000 32%,transparent 80%);mask-image:radial-gradient(circle at 46% 42%,#000 32%,transparent 80%)}
#app{position:relative;height:100%;display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-rows:auto minmax(0,1fr) auto;gap:12px 16px;padding:14px 18px}

/* ---- hud ---- */
#hud{grid-column:1;grid-row:1;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
h1{margin:0;font-size:13px;letter-spacing:0.2em;text-transform:uppercase}
h1 span{color:var(--dim);font-weight:400}
#sub{margin:5px 0 0;font-size:10px;color:var(--dim);letter-spacing:0.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stats{display:flex;gap:8px;flex:0 0 auto}
.stat{min-width:84px;padding:6px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.stat b{display:block;font-size:15px;font-weight:600;color:#eff9ff;letter-spacing:0.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:8.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--dim)}

/* ---- stage ---- */
#stage{grid-column:1;grid-row:2;position:relative;display:grid;place-items:center;min-height:0;overflow:hidden;will-change:transform}
#spectrum{position:absolute;left:0;right:0;bottom:0;width:100%;height:62px;opacity:0.62;z-index:0;pointer-events:none}
#now{position:absolute;left:0;right:0;top:8px;z-index:5;text-align:center;font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:#7f96ae;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 12px}
#shadow{position:absolute;left:50%;top:50%;width:220px;height:44px;margin:86px 0 0 -110px;border-radius:50%;background:radial-gradient(ellipse at 50% 50%,rgba(94,231,255,0.16),transparent 68%);filter:blur(8px);z-index:1;pointer-events:none;will-change:transform}
#ring:before{content:"";position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(126,231,255,0.09)}
#lyrics{position:absolute;left:0;right:0;top:50%;margin-top:138px;z-index:3;text-align:center;pointer-events:none;letter-spacing:0.34em;font-size:12px;color:#506480}
#lyrics .syl{display:inline-block;padding:0 6px;transition:color 0.08s linear,text-shadow 0.08s linear}
#lyrics .syl.on{color:var(--mint);text-shadow:0 0 14px rgba(110,242,192,0.85)}
#ring{position:absolute;left:50%;top:50%;width:344px;height:344px;margin:-172px 0 0 -172px;z-index:1;pointer-events:none;will-change:transform}
#ring .tick{position:absolute;left:50%;top:50%;width:2px;margin-left:-1px;border-radius:1px;background:rgba(120,190,230,0.2);transition:background 0.12s linear}
#rig{position:absolute;left:50%;top:50%;width:176px;height:176px;margin:-96px 0 0 -88px;z-index:2;will-change:transform}
#head{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 36% 28%,#263a5c 0%,#101a2c 48%,#070b14 78%);border:1px solid rgba(126,231,255,0.3);box-shadow:0 24px 60px rgba(0,0,0,0.7),0 0 46px rgba(94,231,255,0.16),inset 0 -22px 44px rgba(0,0,0,0.55);will-change:transform}
#aura{position:absolute;inset:-52px;border-radius:50%;background:radial-gradient(circle,rgba(94,231,255,0.24),transparent 66%);filter:blur(6px);pointer-events:none}
.eye{position:absolute;top:57px;width:11px;height:26px;border-radius:6px;background:linear-gradient(#e8fbff,#5ee7ff);box-shadow:0 0 14px rgba(94,231,255,0.85);transform:translateX(-50%);will-change:transform}
#eye-l{left:37%}
#eye-r{left:63%}
#mouth{position:absolute;left:50%;top:118px;width:22px;height:3px;border-radius:8px;background:radial-gradient(circle at 50% 74%,rgba(94,231,255,0.92),rgba(18,78,104,0.9) 56%,rgba(4,14,22,0.98) 100%);border:1px solid rgba(126,231,255,0.5);box-shadow:inset 0 -2px 6px rgba(0,0,0,0.45),0 0 12px rgba(94,231,255,0.35);will-change:width,height}
#mouth[data-viseme="AA"],#mouth[data-viseme="OH"]{border-color:rgba(110,242,192,0.8)}
#mouth[data-viseme="EE"],#mouth[data-viseme="EH"]{border-color:rgba(126,231,255,0.85)}
#mouth[data-viseme="MM"],#mouth[data-viseme="SS"]{border-color:rgba(126,231,255,0.35)}
#antenna{position:absolute;left:50%;top:-26px;width:2px;height:26px;margin-left:-1px;background:linear-gradient(rgba(94,231,255,0.05),rgba(94,231,255,0.5))}
#antenna i{position:absolute;left:50%;top:-5px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#eaffff,#5ee7ff 55%,#1a7f9c);box-shadow:0 0 14px rgba(94,231,255,0.9)}
#notes{position:absolute;left:50%;top:50%;margin:-26px 0 0 6px;z-index:3;pointer-events:none}
#notes .note{position:absolute;left:0;top:0;font-size:14px;color:var(--mint);opacity:0;text-shadow:0 0 12px rgba(110,242,192,0.8);will-change:transform,opacity}
#door{position:absolute;left:5%;top:50%;width:126px;height:238px;margin-top:-119px;border-radius:7px;z-index:2;opacity:0;
  background:repeating-linear-gradient(0deg,rgba(255,255,255,0.05) 0 1px,transparent 1px 27px),
  linear-gradient(100deg,#2f3f5c 0%,#16212f 44%,#202c3e 62%,#0b1220 100%);
  border:1px solid rgba(150,190,220,0.26);box-shadow:0 34px 64px rgba(0,0,0,0.66),inset 0 0 0 1px rgba(255,255,255,0.03),inset 0 -34px 54px rgba(0,0,0,0.5);
  display:flex;align-items:flex-end;justify-content:center;padding-bottom:13px;transform:translate(0,-420px);will-change:transform}
#door i{position:absolute;left:13px;right:13px;top:47%;height:4px;border-radius:2px;background:linear-gradient(90deg,rgba(190,225,255,0.06),rgba(200,232,255,0.42),rgba(190,225,255,0.06));box-shadow:0 0 10px rgba(126,231,255,0.18)}
#door span{font-size:8.5px;letter-spacing:0.34em;color:rgba(170,205,235,0.55)}
#badge{position:absolute;right:8%;top:25%;z-index:3;padding:8px 15px;border:1px solid rgba(93,242,163,0.72);border-radius:8px;background:rgba(9,40,29,0.72);color:#7dffbe;font-size:13px;letter-spacing:0.24em;box-shadow:0 0 28px rgba(93,242,163,0.4),inset 0 0 18px rgba(93,242,163,0.12);opacity:0;transform:scale(0.55) rotate(-7deg);will-change:transform,opacity}
#coin{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;z-index:4;display:grid;place-items:center;
  background:radial-gradient(circle at 34% 28%,#fff6cf,#ffc757 46%,#a86b00 100%);border:1px solid rgba(255,232,155,0.92);color:#5a3400;font-size:14px;
  box-shadow:0 0 24px rgba(255,199,87,0.6);opacity:0;transform:translate(-300px,160px);will-change:transform,opacity}
#counter{position:absolute;left:7%;bottom:20%;z-index:3;font-size:10px;color:var(--dim);letter-spacing:0.1em}
#counter b{color:var(--amber)}
#charge{position:absolute;left:50%;top:50%;width:224px;height:6px;margin:112px 0 0 -112px;border-radius:3px;z-index:3;background:rgba(120,170,210,0.14);overflow:hidden;opacity:0;box-shadow:inset 0 0 6px rgba(0,0,0,0.7),0 0 0 1px rgba(126,231,255,0.12)}
#charge i{display:block;height:100%;width:0;background:linear-gradient(90deg,rgba(94,231,255,0.45),var(--mint));box-shadow:0 0 16px rgba(110,242,192,0.95)}
#sparks{position:absolute;left:50%;top:50%;width:0;height:0;z-index:3;pointer-events:none}
#sparks .spark{position:absolute;left:-3px;top:-3px;width:7px;height:7px;border-radius:2px;background:linear-gradient(#fff,#ff7ae0);box-shadow:0 0 14px rgba(255,122,224,0.9);opacity:0;will-change:transform,opacity}
#flash{position:absolute;inset:-40px;z-index:6;pointer-events:none;opacity:0;mix-blend-mode:screen;background:radial-gradient(circle at 50% 52%,rgba(200,248,255,0.6),rgba(94,231,255,0.14) 42%,transparent 72%);will-change:opacity}

/* ---- timeline ---- */
#timeline{grid-column:1;grid-row:3;position:relative;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:9px 12px 7px;display:flex;flex-direction:column;gap:6px}
#track{position:relative;height:46px}
#wave{position:absolute;inset:0;width:100%;height:46px;display:block}
#markers{position:absolute;inset:0;pointer-events:none}
#markers .mark{position:absolute;top:-2px;width:7px;height:7px;margin-left:-3.5px;background:#0a1320;border:1px solid rgba(126,231,255,0.55);transform:rotate(45deg)}
#markers .mark.on{background:var(--mint);border-color:var(--mint);box-shadow:0 0 9px rgba(110,242,192,0.9)}
#playhead{position:absolute;top:-3px;bottom:-3px;width:1px;background:linear-gradient(var(--mint),rgba(110,242,192,0));box-shadow:0 0 9px rgba(110,242,192,0.85)}
#beatrow{display:flex;justify-content:space-between;height:8px;align-items:flex-end}
#beatrow i{width:2px;height:5px;border-radius:1px;background:rgba(120,170,210,0.18)}
#beatrow i.bar{height:8px;background:rgba(120,170,210,0.34)}
#beatrow i.on{background:var(--cyan);box-shadow:0 0 7px rgba(94,231,255,0.9)}
#caption{display:flex;justify-content:space-between;font-size:9.5px;color:var(--dim);letter-spacing:0.08em;font-variant-numeric:tabular-nums}

/* ---- cue panel ---- */
#cues{grid-column:2;grid-row:1 / span 3;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:12px 14px;display:flex;flex-direction:column;gap:9px;min-height:0}
#cues header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
#cues h2{margin:0;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:var(--dim)}
#cue-count{font-size:9px;color:#5b708a;letter-spacing:0.06em}
#cue-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px;overflow:auto;flex:0 0 auto}
#cue-list li{display:grid;grid-template-columns:9px 58px minmax(0,1fr) 26px 44px;gap:7px;align-items:center;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,0.05);font-size:10.5px;color:#93a9c0;font-variant-numeric:tabular-nums}
#cue-list li .dot{width:6px;height:6px;border-radius:50%;background:rgba(120,170,210,0.35)}
#cue-list li .nm{color:#dceaf7;letter-spacing:0.04em}
#cue-list li .eng{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#63788f;font-size:9.5px}
#cue-list li .bt{text-align:right;color:#8fb4d6;font-size:9.5px}
#cue-list li .at{text-align:right;color:#8fb4d6;font-size:9.5px}
#cue-list li.fired .dot{background:var(--mint);box-shadow:0 0 10px rgba(110,242,192,0.9)}
#cue-list li.fired{color:#cfe3f4}
#cue-list li.active .nm{color:var(--cyan)}
#cue-list li.active{border-bottom-color:rgba(94,231,255,0.28)}
#cue-foot{border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;font-size:9px;line-height:1.7;color:#5b708a}
#build-block{border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;display:flex;flex-direction:column;gap:3px;flex:0 0 auto}
#build-block .kv{display:flex;justify-content:space-between;gap:8px;font-size:9px;color:#5b708a;letter-spacing:0.04em}
#build-block .kv b{color:#93b6d4;font-weight:400;text-align:right;font-variant-numeric:tabular-nums}
#log-box{border-top:1px solid rgba(255,255,255,0.06);padding-top:9px;display:flex;flex-direction:column;gap:5px;flex:1 1 auto;min-height:0}
#log-box h2{margin:0;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:var(--dim)}
#log{display:flex;flex-direction:column;gap:2px;overflow:hidden;font-size:9px;line-height:1.5}
#log .log-line{display:grid;grid-template-columns:42px 54px minmax(0,1fr);gap:8px;white-space:nowrap}
#log .lt{color:#4f6478;font-variant-numeric:tabular-nums;text-align:right}
#log .ln{color:var(--mint)}
#log .le{color:#5b708a;overflow:hidden;text-overflow:ellipsis}
#status{color:var(--mint)}

/* ---- gate ---- */
#gate{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:rgba(4,7,12,0.82);backdrop-filter:blur(7px);opacity:0;pointer-events:none;transition:opacity 0.3s ease}
#gate.show{opacity:1;pointer-events:auto}
#gate .card{width:min(560px,88vw);padding:26px 28px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(17,26,44,0.97),rgba(9,14,24,0.97));box-shadow:0 34px 90px rgba(0,0,0,0.66)}
#gate h2{margin:0 0 8px;font-size:15px;letter-spacing:0.1em}
#gate p{margin:0 0 16px;font-size:11px;line-height:1.7;color:#9fb3c8}
#gate button{appearance:none;border:1px solid rgba(94,231,255,0.55);border-radius:10px;background:linear-gradient(180deg,rgba(94,231,255,0.2),rgba(94,231,255,0.08));color:#e8fbff;font:600 13px var(--mono);letter-spacing:0.08em;padding:12px 20px;cursor:pointer;box-shadow:0 0 26px rgba(94,231,255,0.22)}
#gate button:hover{background:linear-gradient(180deg,rgba(94,231,255,0.3),rgba(94,231,255,0.12))}
#gate button:active{transform:translateY(1px)}
#gate-list{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:5px;font-size:10px;color:#8aa2b8}
#gate-list li{display:flex;gap:10px;align-items:baseline}
#gate-list b{min-width:26px;color:var(--cyan);font-weight:600;letter-spacing:0.08em}
#gate-note{font-size:9.5px;color:#5b708a;margin:14px 0 0}

@media (max-width:1150px){
  #sub{display:none}
  .stat{min-width:70px;padding:5px 8px}
  .stat b{font-size:13px}
  #stats{gap:6px}
}
@media (max-width:960px){
  #app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}
  #cues{display:none}
}
@media (max-height:640px){
  #spectrum{height:42px}
}
</style>
</head>
<body>
<div id="grid"></div>
<div id="app">
  <section id="hud">
    <div>
      <h1>dsh-audio <span>· one take</span></h1>
      <p id="sub">every sound synthesized at build time · 0 requests · 0 external assets</p>
    </div>
    <div id="stats">
      <div class="stat"><b id="hud-bpm">120</b><span>bpm</span></div>
      <div class="stat"><b id="hud-beat">0.00</b><span>beat / @BEATS@</span></div>
      <div class="stat"><b id="hud-time">0.00 s</b><span>clock</span></div>
      <div class="stat"><b id="hud-section">intro</b><span>section</span></div>
    </div>
  </section>

  <section id="stage">
    <canvas id="spectrum"></canvas>
    <div id="now"></div>
    <div id="ring"></div>
    <div id="shadow"></div>
    <div id="rig">
      <div id="head">
        <div id="aura"></div>
        <div id="antenna"><i></i></div>
        <i class="eye" id="eye-l"></i>
        <i class="eye" id="eye-r"></i>
        <div id="mouth"></div>
      </div>
    </div>
    <div id="notes"></div>
    <div id="lyrics"></div>
    <div id="door"><i></i><span>SEAL</span></div>
    <div id="badge">PASS</div>
    <div id="coin">¥</div>
    <div id="counter">coins <b id="coin-count">0</b></div>
    <div id="charge"><i id="charge-fill"></i></div>
    <div id="sparks"></div>
    <div id="flash"></div>
  </section>

  <footer id="timeline">
    <div id="track">
      <canvas id="wave"></canvas>
      <div id="markers"></div>
      <div id="playhead"></div>
    </div>
    <div id="beatrow"></div>
    <div id="caption"><span id="clock">0.00</span><span id="clock-total">16.80 s</span></div>
  </footer>

  <aside id="cues">
    <header><h2>cue sheet</h2><span id="cue-count"></span></header>
    <ol id="cue-list"></ol>
    <div id="build-block">
      <div class="kv"><span>score</span><b id="build-score"></b></div>
      <div class="kv"><span>render</span><b id="build-rate"></b></div>
      <div class="kv"><span>inline</span><b id="build-wavs"></b></div>
      <div class="kv"><span>build mix</span><b id="build-mix"></b></div>
      <div class="kv"><span>lipsync</span><b id="build-vis"></b></div>
      <div class="kv"><span>network</span><b>0 requests</b></div>
    </div>
    <div id="log-box">
      <h2>fired</h2>
      <div id="log"></div>
    </div>
    <footer id="cue-foot"><span id="cue-foot-text"></span><br>status <span id="status">idle</span></footer>
  </aside>
</div>

<div id="gate" class="show">
  <div class="card">
    <h2 id="gate-title">dsh-audio · one take</h2>
    <p id="gate-sub">16.8 s · a lofi score, a sung phrase, four designed impacts — all inline.</p>
    <ul id="gate-list"></ul>
    <button id="start">▶ start the take</button>
    <p id="gate-note">Browsers keep audio suspended until a click. Nothing is fetched: every wav is a base64 data URI in this file.</p>
  </div>
</div>

<script type="application/json" id="audio-data">@DATA@</script>
<script id="stage-runtime">@RUNTIME@</script>
</body>
</html>
`

/* -------------------------------------------------------------- assembly -- */

/** Assemble the page. Deterministic: no clock, no random, no locale. */
function buildPage (assets) {
  const page = buildPageData(assets)
  const dataJson = JSON.stringify(page).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const html = HTML_TEMPLATE
    .replace('@DURATION@', () => page.duration.toFixed(2))
    .replace('@BEATS@', () => String(page.beatMap.length))
    .replace('@DATA@', () => dataJson)
    .replace('@RUNTIME@', () => RUNTIME)
  return { html, page, dataJson }
}

/* ---------------------------------------------------------- verification -- */

let checks = 0
let failures = 0

function check (label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok    ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return true
  }
  failures += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

const DATA_URI = /data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g

/** Read the embedded page data back out of the HTML. */
function readPageData (html) {
  const match = /<script type="application\/json" id="audio-data">([\s\S]*?)<\/script>/.exec(html)
  if (match === null) throw new Error('audio-data block missing from the page')
  return JSON.parse(match[1])
}

/* --- 1. every inline wav decodes, is audible, and has the expected length --- */

function verifyInlineAudio (html, page, expected) {
  const found = [...html.matchAll(DATA_URI)]
  console.log(`\n[1] inline wavs — ${found.length} data URI(s) found in the written page`)
  check('one data URI per cue', found.length === page.cues.length, `${found.length} uris, ${page.cues.length} cues`)
  let totalUriBytes = 0
  let totalPcmBytes = 0
  found.forEach((match, index) => {
    const cue = page.cues[index]
    const mime = match[1]
    const uri = match[0]
    const bytes = Buffer.from(match[2], 'base64')
    totalUriBytes += uri.length
    totalPcmBytes += bytes.length
    const decoded = decodeWav(bytes)
    const levels = levelOf(decoded.channels)
    const durations = expected.get(cue.name)
    const durationError = Math.abs(decoded.durationSeconds - durations.duration) * decoded.sampleRate
    const frames = decoded.channels[0].length
    check(
      `"${cue.name}" decodes (wav.js) and is the cue's own payload`,
      mime === 'wav' && uri === cue.src && decoded.sampleRate === SAMPLE_RATE && decoded.bitDepth === cue.bits && decoded.channels.length === 1,
      `${mime} ${decoded.bitDepth}-bit ${decoded.sampleRate} Hz ${frames} frames`
    )
    check(
      `"${cue.name}" is audible`,
      levels.peakDbfs > -12 && levels.rmsDbfs > -45,
      `peak ${levels.peakDbfs} dBFS · rms ${levels.rmsDbfs} dBFS`
    )
    check(
      `"${cue.name}" duration ${decoded.durationSeconds.toFixed(3)} s matches the render`,
      durationError < 1,
      `${durationError.toFixed(4)} samples of error (expected ${durations.duration.toFixed(3)} s)`
    )
  })
  const payloadBytes = page.cues.reduce((sum, cue) => sum + cue.src.length, 0)
  check('reported inline size equals the payload in the page', page.stats.inlineBytes === payloadBytes && totalUriBytes === payloadBytes,
    `${payloadBytes.toLocaleString('en-US')} B of data URIs`)
  console.log(`      raw wav bytes ${bytesKb(totalPcmBytes)} · base64 payload ${bytesKb(totalUriBytes)}`)
  return { totalUriBytes, totalPcmBytes }
}

/* --- 2. cue entries === inline sounds --- */

function verifyCueCounts (html, page) {
  console.log('\n[2] cue sheet vs inline sounds')
  check('cue entries equal inline sounds', page.cues.length === (html.match(/data:audio\/[a-z0-9.+-]+;base64,/g) || []).length,
    `${page.cues.length} cue entries, ${(html.match(/data:audio\/[a-z0-9.+-]+;base64,/g) || []).length} inline sounds`)
  const names = new Set(page.cues.map((cue) => cue.name))
  check('cue names are unique', names.size === page.cues.length, [...names].join(', '))
  const sorted = page.cues.every((cue, index) => index === 0 || page.cues[index - 1].at < cue.at || (page.cues[index - 1].at === cue.at && page.cues[index - 1].name < cue.name))
  check('cue sheet is sorted by time', sorted, page.cues.map((cue) => `${cue.name}@${cue.at}`).join(' '))
  const inDuration = page.cues.every((cue) => cue.at >= 0 && cue.at + cue.dur <= page.duration)
  check('every cue starts and ends inside the timeline', inDuration, `duration ${page.duration} s`)
  const gainOk = page.cues.every((cue) => cue.gainDb <= 0 && cue.gainDb >= -60)
  check('cue gains are headroom-only (<= 0 dB)', gainOk, page.cues.map((cue) => `${cue.name} ${cue.gainDb}dB`).join(' '))
}

/* --- 3. beatMap monotonic and inside the timeline --- */

function verifyBeatMap (html, page) {
  console.log('\n[3] beatMap + timeline')
  const map = page.beatMap
  check('beatMap length is bars * beatsPerBar', map.length === page.bars * page.beatsPerBar, `${map.length} entries`)
  check('beat 0 starts at 0', map[0] === 0, String(map[0]))
  let monotonic = true
  let worst = Infinity
  for (let i = 1; i < map.length; i += 1) {
    const delta = map[i] - map[i - 1]
    if (!(delta > 0)) monotonic = false
    if (delta < worst) worst = delta
  }
  check('beatMap is strictly increasing', monotonic, `smallest gap ${worst.toFixed(4)} s`)
  check('every beat lies inside the duration', map.every((time) => time >= 0 && time < page.duration),
    `first ${map[0]} s · last ${map[map.length - 1]} s · duration ${page.duration} s`)
  const spacing = 60 / page.bpm
  const uniform = map.every((time, index) => Math.abs(time - index * spacing) < 1e-9)
  check('every beat is exactly 60/bpm after the previous', uniform, `${spacing.toFixed(6)} s per beat`)
  const eventCues = page.cues.filter((cue) => cue.effect !== 'bed')
  const onGrid = eventCues.every((cue) => cue.at === map[cue.beat])
  check('every event cue sits on its beatMap time', onGrid,
    eventCues.map((cue) => `${cue.name} b${cue.beat}=${cue.at}`).join(' '))
  check('at least four visible events land on beats', eventCues.length >= 4, `${eventCues.length} event cues`)
  check('the take is 15-20 s long', page.duration >= 15 && page.duration <= 20, `${page.duration.toFixed(2)} s`)
  check('the animation starts on a gate, not on load', /id="gate" class="show"/.test(html), 'gate is visible until the click')
  const syllables = page.voice.syllables
  check('the sung phrase is syllable-timed', syllables.length === 3 && syllables.every((s) => s.end > s.start),
    syllables.map((s) => `${s.text}[${s.start.toFixed(2)}-${s.end.toFixed(2)}]`).join(' '))
  const visemeIds = new Set(page.voice.frames.map((frame) => frame[0]))
  const openness = page.voice.frames.map((frame) => frame[1])
  check('the lipsync frames really move the mouth', visemeIds.size >= 3 && Math.max(...openness) - Math.min(...openness) >= 15,
    `${page.voice.frames.length} frames · ${visemeIds.size} distinct visemes · openness ${Math.min(...openness)}%..${Math.max(...openness)}%`)
}

/* --- 4. run the page's orchestration against a DOM stub --- */

function runOrchestration (html, page) {
  const scriptMatch = /<script id="stage-runtime">([\s\S]*?)<\/script>/.exec(html)
  if (scriptMatch === null) throw new Error('stage-runtime script missing from the page')
  const script = scriptMatch[1]

  const clock = { t: 0 }
  const timers = new Map()
  let timerId = 0
  const pendingRaf = new Map()
  let rafId = 0

  const setTimeoutMock = (fn, ms) => {
    const id = (timerId += 1)
    timers.set(id, { fn, due: clock.t + Math.max(0, Number(ms) || 0) / 1000 })
    return id
  }
  const clearTimeoutMock = (id) => { timers.delete(id) }
  const requestAnimationFrameMock = (fn) => {
    const id = (rafId += 1)
    pendingRaf.set(id, fn)
    return id
  }
  const cancelAnimationFrameMock = (id) => { pendingRaf.delete(id) }

  async function flush () {
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
  }

  async function advance (seconds) {
    const target = clock.t + seconds
    for (;;) {
      let dueId = null
      let dueTimer = null
      for (const [id, timer] of timers) {
        if (timer.due <= target && (dueTimer === null || timer.due < dueTimer.due)) {
          dueId = id
          dueTimer = timer
        }
      }
      if (dueTimer === null) break
      timers.delete(dueId)
      clock.t = Math.max(clock.t, dueTimer.due)
      dueTimer.fn()
      await flush()
    }
    clock.t = target
    await flush()
  }

  function frame () {
    const pending = [...pendingRaf.values()]
    pendingRaf.clear()
    for (const callback of pending) callback(clock.t)
  }

  function make2d () {
    const gradient = { addColorStop () {} }
    return {
      fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '',
      clearRect () {}, fillRect () {}, beginPath () {}, closePath () {}, arc () {}, fill () {}, stroke () {},
      moveTo () {}, lineTo () {}, quadraticCurveTo () {}, save () {}, restore () {}, translate () {},
      rotate () {}, scale () {}, setTransform () {}, fillText () {}, measureText: () => ({ width: 8 }),
      createLinearGradient: () => gradient, createRadialGradient: () => gradient
    }
  }

  function makeElement (tag, id) {
    const classes = new Set()
    const element = {
      tagName: tag, id: id || '', className: '', children: [], textContent: '', width: 0, height: 0,
      clientWidth: id === 'spectrum' ? 720 : 640,
      clientHeight: id === 'spectrum' ? 62 : id === 'wave' ? 46 : 24,
      style: {}, dataset: {}, listeners: {}, classes,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name) },
        contains: (name) => classes.has(name)
      },
      appendChild (child) { this.children.push(child); return child },
      append (...kids) { kids.forEach((kid) => this.children.push(kid)) },
      removeChild (child) { this.children = this.children.filter((kid) => kid !== child) },
      addEventListener (type, handler) { this.listeners[type] = handler },
      getContext (kind) { return kind === '2d' ? make2d() : null },
      remove () {},
      getBoundingClientRect () { return { left: 0, top: 0, width: 640, height: 46 } }
    }
    // `innerHTML = ''` is the runtime's only HTML write (clearing the cue log);
    // model it as dropping the children so the stub sees what a browser sees.
    Object.defineProperty(element, 'innerHTML', {
      get () { return '' },
      set () { this.children = [] }
    })
    return element
  }

  const nodes = new Map()
  const documentMock = {
    hidden: false,
    listeners: {},
    getElementById (id) {
      if (!nodes.has(id)) nodes.set(id, makeElement('div', id))
      return nodes.get(id)
    },
    createElement (tag) { return makeElement(tag) },
    addEventListener (type, handler) { this.listeners[type] = handler }
  }
  documentMock.getElementById('audio-data').textContent = JSON.stringify(page)

  const sources = []
  const analyserData = new Uint8Array(1024)
  for (let i = 0; i < analyserData.length; i += 1) analyserData[i] = Math.round(120 + 90 * Math.sin(i * 0.55) + 40 * Math.sin(i * 0.13))

  class MockGain {
    constructor () {
      this.gain = { value: 1, setValueAtTime () {}, linearRampToValueAtTime () {}, setTargetAtTime () {}, cancelScheduledValues () {} }
    }

    connect (target) { return target }

    disconnect () {}
  }
  class MockCompressor {
    constructor () {
      this.threshold = { value: 0 }
      this.knee = { value: 0 }
      this.ratio = { value: 1 }
      this.attack = { value: 0 }
      this.release = { value: 0 }
    }

    connect (target) { return target }
  }
  class MockAnalyser {
    constructor () {
      this.fftSize = 2048
      this.frequencyBinCount = 1024
      this.smoothingTimeConstant = 0.7
    }

    connect (target) { return target }

    getByteFrequencyData (array) { array.set(analyserData.subarray(0, array.length)) }
  }
  class MockSource {
    constructor () {
      this.buffer = null
      this.startedAt = null
      this.stoppedAt = null
    }

    connect (target) { return target }

    disconnect () {}

    start (when) {
      if (this.startedAt !== null) throw new Error('mock source started twice')
      this.startedAt = when
      sources.push(this)
    }

    stop (when) { this.stoppedAt = when ?? clock.t }
  }
  class MockAudioContext {
    constructor () {
      this.state = 'running'
      this.sampleRate = page.sampleRate
      this.destination = {}
    }

    get currentTime () { return clock.t }

    createGain () { return new MockGain() }

    createDynamicsCompressor () { return new MockCompressor() }

    createAnalyser () { return new MockAnalyser() }

    createBufferSource () { return new MockSource() }

    resume () { this.state = 'running'; return Promise.resolve() }

    async decodeAudioData (buffer) {
      const decoded = decodeWav(Buffer.from(new Uint8Array(buffer)))
      return { duration: decoded.durationSeconds, sampleRate: decoded.sampleRate, length: decoded.channels[0].length, numberOfChannels: 1 }
    }
  }

  const windowMock = {
    AudioContext: MockAudioContext,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener () {}
  }
  const factory = new Function('window', 'document', 'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'atob', 'console', script)
  factory(windowMock, documentMock, MockAudioContext, requestAnimationFrameMock, cancelAnimationFrameMock, setTimeoutMock, clearTimeoutMock, atob, { warn () {}, error () {} })

  return { api: windowMock.dshStage, nodes, documentMock, sources, clock, advance, frame }
}

async function verifyOrchestration (html, page) {
  console.log('\n[4] page orchestration against a DOM stub')
  const env = runOrchestration(html, page)
  check('runtime exposes window.dshStage', env.api !== null && typeof env.api === 'object', 'start/stop/renderAt/data')
  check('runtime exposes the API surface', ['start', 'stop', 'renderAt', 'data', 'state'].every((key) => env.api[key] !== undefined), 'start, stop, renderAt, data, state')
  check('page parses the embedded cue data', env.api.data.cues.length === page.cues.length, `${env.api.data.cues.length} cues`)

  const started = await env.api.start()
  await env.advance(0.001)
  check('start() resolves true and begins playback', started === true, 'audio graph unlocked from the click')
  const lead = env.api.state.t0
  console.log(`      t0 = ${lead.toFixed(6)} s (${page.lead} s lead-in), cues scheduled so far: ${env.sources.length}`)
  check('first window schedules only the bed', env.sources.length === 1 && env.sources[0].startedAt === lead, `startedAt ${env.sources[0].startedAt}`)
  check('bed is scheduled exactly at t0', Math.abs(env.sources[0].startedAt - (lead + page.cues[0].at)) < 1e-12)

  await env.advance(page.duration + 0.5)
  const scheduled = env.sources.slice().sort((a, b) => a.startedAt - b.startedAt)
  check('the look-ahead scheduler eventually places every cue', scheduled.length === page.cues.length, `${scheduled.length} of ${page.cues.length}`)
  let worst = -1
  let worstName = ''
  let subSample = 0
  page.cues.forEach((cue, index) => {
    const source = scheduled[index]
    const expectedAt = lead + cue.at
    const errorSamples = source === undefined ? Infinity : Math.abs(source.startedAt - expectedAt) * page.sampleRate
    if (errorSamples > worst) { worst = errorSamples; worstName = cue.name }
    if (Number.isFinite(errorSamples) && errorSamples > 0.5) subSample += 1
    check(`cue "${cue.name}" fires on its scheduled time`, errorSamples < 1,
      `start(${source === undefined ? 'missing' : source.startedAt.toFixed(6)}) vs ${expectedAt.toFixed(6)} = ${Number.isFinite(errorSamples) ? errorSamples.toExponential(2) : 'n/a'} samples`)
  })
  console.log(`      worst cue "${worstName}": ${worst.toExponential(3)} samples at ${page.sampleRate} Hz = ${(worst / page.sampleRate * 1000).toExponential(3)} ms (budget 1 sample)`)
  const onGrid = page.cues.every((cue) => {
    const frames = (lead + cue.at) * page.sampleRate
    return Math.abs(frames - Math.round(frames)) < 1e-6
  })
  check('every scheduled start is exactly on a sample frame', onGrid,
    `t0 ${lead.toFixed(4)} s + cue times are whole frames at ${page.sampleRate} Hz`)
  check('no cue needed sub-sample rounding', subSample === 0, `${subSample} cue(s) off the frame grid`)

  // Silence before the phrase, open mouth inside it: the mouth follows lipsync frames.
  env.api.renderAt(2)
  check('mouth is closed outside the sung phrase', env.nodes.get('mouth').dataset.viseme === 'none', `viseme ${env.nodes.get('mouth').dataset.viseme}, height ${env.nodes.get('mouth').style.height}`)
  env.api.renderAt(page.voice.at + 1.0)
  const mouth = env.nodes.get('mouth')
  const viseme = mouth.dataset.viseme
  check('mouth takes its viseme from the lipsync frame at that instant', page.voice.visemes.indexOf(viseme) >= 0 && viseme !== 'none',
    `t=${(page.voice.at + 1).toFixed(2)} s -> viseme ${viseme}, width ${mouth.style.width}, height ${mouth.style.height}`)
  const beatText = env.nodes.get('hud-beat').textContent
  const beatIndex = page.beatMap.indexOf(page.voice.at + 1)
  const expectedBeatText = `${beatIndex.toFixed(2)} / ${page.beatMap.length}`
  check('HUD beat is the beatMap interpolation at that time', beatText === expectedBeatText,
    `hud shows "${beatText}", expected "${expectedBeatText}" at t=${(page.voice.at + 1).toFixed(2)} s`)
  const fired = page.cues.filter((cue) => env.api.state.rowFired[page.cues.indexOf(cue)] === true).length
  check('cue rows flip to fired once the clock passes them', fired >= 3 && fired < page.cues.length, `${fired} of ${page.cues.length} rows fired at t=${(page.voice.at + 1).toFixed(2)} s`)
  const logLines = env.nodes.get('log').children.length
  check('the live cue log records each fired cue exactly once', logLines === fired, `${logLines} log line(s) for ${fired} fired row(s)`)
  env.api.renderAt(2)
  const doorBefore = env.nodes.get('door')
  check('the door is hidden and above the stage before the slam', doorBefore.style.opacity === '0' && doorBefore.style.transform.includes('-420'), `${doorBefore.style.opacity} / ${doorBefore.style.transform}`)
  env.api.renderAt(4.3)
  const doorAfter = env.nodes.get('door')
  check('the door is on stage after the slam beat', doorAfter.style.opacity === '1' && doorAfter.style.transform === 'translate(0,0.0px)', `${doorAfter.style.opacity} / ${doorAfter.style.transform}`)
  env.api.renderAt(page.duration)
  check('every cue reaches the live log by the end', env.nodes.get('log').children.length === page.cues.length, `${env.nodes.get('log').children.length} lines for ${page.cues.length} cues`)
  env.api.renderAt(0)
  check('renderAt() is a pure timeline render (idle head is asleep)', env.nodes.get('eye-l').style.transform.includes('scaleY(0.12)'), env.nodes.get('eye-l').style.transform)
  return { worst }
}

/* --- 5. no network, no placeholder tokens --- */

function verifyPurity (html) {
  console.log('\n[5] single-file purity')
  check('no http:// reference', !/http:\/\//i.test(html))
  check('no https:// reference', !/https:\/\//i.test(html))
  check('no protocol-relative //cdn style reference', !/(src|href)="\/\//i.test(html))
  check('no fetch( call in the page', !/\bfetch\s*\(/.test(html))
  check('no XMLHttpRequest', !/XMLHttpRequest/.test(html))
  check('no double-underscore placeholder token', !/__/.test(html))
  check('no unreplaced @TOKEN@ placeholder', !/@[A-Z]+@/.test(html))
  check('no leftover template brace token', !/\{\{[A-Z]+\}\}/.test(html))
  check('doctype present', /^<!doctype html>/i.test(html))
  check('audio data block present once', (html.match(/id="audio-data"/g) || []).length === 1)
  check('runtime script present once', (html.match(/id="stage-runtime"/g) || []).length === 1)
  check('page uses an AudioContext clock', /audio\.currentTime - state\.t0/.test(html) && /requestAnimationFrame/.test(html))
  check('animation is requestAnimationFrame driven', /state\.raf = requestAnimationFrame\(loop\)/.test(html))
  check('page starts on a click', /el\.start\.addEventListener\('click'/.test(html) && /audio\.resume\(\)/.test(html))
  check('page visuals are deterministic (no Math.random)', !/Math\.random/.test(html))
  check('page visuals are deterministic (no Date)', !/Date\.now|new Date/.test(html))
  check('HUD carries bpm, beat and the cue list', /id="hud-bpm"/.test(html) && /id="hud-beat"/.test(html) && /id="cue-list"/.test(html))
  check('every sound source is a data URI (no external src)', !/src="(?!data:)/.test(html) && !/href=/.test(html))
}

/* --------------------------------------------------------------- report -- */

function reportSizes (html, page, audio) {
  const total = Buffer.byteLength(html, 'utf8')
  const jsonMatch = /<script type="application\/json" id="audio-data">([\s\S]*?)<\/script>/.exec(html)
  const jsonBytes = Buffer.byteLength(jsonMatch[1], 'utf8')
  const runtimeBytes = Buffer.byteLength(/(<script id="stage-runtime">)([\s\S]*?)(<\/script>)/.exec(html)[2], 'utf8')
  const cssBytes = Buffer.byteLength(/<style>([\s\S]*?)<\/style>/.exec(html)[1], 'utf8')
  const markupBytes = total - jsonBytes - runtimeBytes - cssBytes
  console.log('\n[size] page weight')
  console.log(`  showcase.html            ${total.toLocaleString('en-US').padStart(10)} B  ${bytesKb(total)}`)
  console.log(`  ├─ inline audio JSON     ${jsonBytes.toLocaleString('en-US').padStart(10)} B  ${bytesKb(jsonBytes)}  (${((jsonBytes / total) * 100).toFixed(1)}% of page, ${page.cues.length} wavs)`)
  console.log(`  ├─ runtime script        ${runtimeBytes.toLocaleString('en-US').padStart(10)} B  ${bytesKb(runtimeBytes)}`)
  console.log(`  ├─ css                   ${cssBytes.toLocaleString('en-US').padStart(10)} B  ${bytesKb(cssBytes)}`)
  console.log(`  └─ markup + metadata     ${markupBytes.toLocaleString('en-US').padStart(10)} B  ${bytesKb(markupBytes)}`)
  console.log('  per cue:')
  for (const cue of page.cues) {
    console.log(`    ${cue.name.padEnd(8)} ${String(cue.bits).padStart(2)}-bit ${String(cue.dur.toFixed(3)).padStart(6)} s  ${bytesKb(Buffer.byteLength(cue.src, 'utf8')).padStart(9)}  @${cue.at.toFixed(2)} s · beat ${String(cue.beat).padStart(2)} · ${cue.gainDb} dB · ${cue.engine}`)
  }
  console.log(`  total under the 1.5 MB budget: ${total < 1.5 * 1024 * 1024 ? 'yes' : 'NO'} (${bytesKb(1.5 * 1024 * 1024)} budget)`)
  return { total, jsonBytes, runtimeBytes, cssBytes, markupBytes }
}

/* ------------------------------------------------------------------ main -- */

/** The lib modules this page is rendered from; a visible fingerprint keeps the
 *  build honest when several people edit the engine in parallel. */
const ENGINES = ['compose.js', 'design.js', 'audio.js', 'sing.js', 'lipsync.js', 'bind.js', 'wav-encode.js', 'wav.js', 'dsp.js', 'presets-extra.js']

async function engineFingerprint () {
  const parts = []
  for (const name of ENGINES) {
    const bytes = await readFile(join(HERE, '..', 'dsh-audio-lab', 'plugin', 'lib', name))
    parts.push(`${name.replace('.js', '')}@${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}`)
  }
  return parts.join(' ')
}

async function main () {
  const startedAt = process.hrtime.bigint()
  console.log('dsh-audio showcase build')
  console.log(`  node ${process.version} · target ${TARGET}`)
  console.log(`  engines ${await engineFingerprint()}`)

  const assets = renderAssets()
  const page = buildPageData(assets)

  // The cue sheet is validated by the plugin's own binder before it is embedded.
  const sheet = buildCueSheet({
    cues: assets.cues.map((cue) => ({ name: cue.name, at: cue.at, gainDb: cue.gainDb, src: cue.src })),
    duration: assets.durationSeconds
  })
  console.log(`\n[build] composeScore(${GENRE}, ${BPM} bpm, ${BARS} bars) -> ${assets.durationSeconds.toFixed(3)} s, ${assets.beatMap.length} beats, ${assets.score.sections.map((s) => s.name).join('/')}`)
  console.log(`[build] singPlan("wo ai ni") -> ${assets.voicePlan.totalSeconds.toFixed(3)} s, ${assets.visemes.frames.length} viseme frames @${assets.visemes.fps} fps`)
  console.log(`[build] ${assets.cues.length} cues · ${assets.cues.map((cue) => `${cue.name}@${cue.at}s/${cue.bits}bit`).join(' ')}`)
  console.log(`[build] buildCueSheet -> ${sheet.cues.length} cues, duration ${sheet.json.length > 0 ? JSON.parse(sheet.json).duration : 0} s, player source ${bytesKb(sheet.script.length)} (not embedded)`)
  console.log(`[build] summed timeline: peak ${assets.mixedMeasure.peakDbfs} dBFS, rms ${assets.mixedMeasure.rmsDbfs} dBFS, clipping ${assets.mixedMeasure.clipping}`)

  const expected = new Map()
  for (const cue of assets.cues) expected.set(cue.name, { duration: cue.dur, bits: cue.bits })

  const first = buildPage(assets)
  await mkdir(HERE, { recursive: true })
  // Atomic: a crash mid-write must never leave a half-parsed page behind.
  await writeFileAtomic(TARGET, Buffer.from(first.html, 'utf8'))
  const onDisk = await readFile(TARGET, 'utf8')
  const hashA = createHash('sha256').update(Buffer.from(onDisk, 'utf8')).digest('hex')
  console.log(`\n[write] ${TARGET} (${bytesKb(Buffer.byteLength(onDisk, 'utf8'))}) sha256 ${hashA.slice(0, 16)}…`)

  // Verification runs on the bytes that are actually on disk.
  const diskPage = readPageData(onDisk)
  const audio = verifyInlineAudio(onDisk, diskPage, expected)
  verifyCueCounts(onDisk, diskPage)
  verifyBeatMap(onDisk, diskPage)
  const orchestration = await verifyOrchestration(onDisk, diskPage)
  verifyPurity(onDisk)
  const sizes = reportSizes(onDisk, diskPage, audio)

  console.log('\n[6] determinism')
  const second = buildPage(renderAssets())
  const hashB = createHash('sha256').update(Buffer.from(second.html, 'utf8')).digest('hex')
  check('a second full rebuild is byte-identical', hashA === hashB, `${hashA.slice(0, 16)}… vs ${hashB.slice(0, 16)}…`)
  await writeFileAtomic(TARGET, Buffer.from(second.html, 'utf8'))
  const rewritten = await readFile(TARGET, 'utf8')
  check('rewriting the file keeps it identical', rewritten === onDisk, `${bytesKb(Buffer.byteLength(rewritten, 'utf8'))} both passes`)
  const hashC = createHash('sha256').update(Buffer.from(rewritten, 'utf8')).digest('hex')
  check('sha256 after rewrite is the same', hashC === hashA, hashC)

  const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e9
  console.log(`\n[result] ${checks - failures}/${checks} checks passed in ${elapsed.toFixed(1)} s`)
  console.log(`[result] ${sizes.total.toLocaleString('en-US')} B page · ${diskPage.cues.length} inline wavs · ${diskPage.beatMap.length} beats · worst cue drift ${orchestration.worst.toExponential(2)} samples`)
  if (failures > 0) {
    console.log(`FAILED: ${failures} check(s)`)
    process.exitCode = 1
    return
  }
  console.log('OK: showcase.html is self-contained, audible, on the beat, and byte-reproducible')
}

await main()
