/**
 * `audio_sing`: the model-facing seam over the singing voices.
 *
 * One tool, because a singer is one decision: what words, on what notes, in what
 * voice. Two engines sit behind it: the always-available formant synthesizer
 * (`lib/sing.js`) and, when the user has downloaded one, a recorded voicebank
 * (`lib/voicebank.js`). The return value follows the same contract as the rest of
 * the plugin — a bounded summary, never audio bytes — plus the two things a
 * caller cannot re-derive by listening: the syllable timings in seconds (for
 * subtitles) and a measured pitch accuracy (so "it sang it" is a number, not a
 * hope).
 */

import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, relative } from 'node:path'
import {
  defaultOutputPath,
  hashSpec,
  measure,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { clamp } from './dsp.js'
import { measurePitch, midiToHz, parseSyllable, renderSing, singPlan, VOICE_PRESETS } from './sing.js'
import { defaultVoicebankDir, loadVoicebank, renderVoicebank } from './voicebank.js'

/** Hard bounds: a runaway request becomes a clear error, not a 10-minute render. */
const MAX_SECONDS = 120
const MAX_NOTES = 256
const MAX_TIMINGS = 64
const MAX_PITCH_NOTES = 16

/** How many syllable substitutions are spelled out in the one-line report. */
const MAX_APPROXIMATIONS = 6

const VOICE_NAMES = Object.keys(VOICE_PRESETS)

/** Engine ids reported to the caller; they also keep the two render hashes apart. */
const ENGINE_FORMANT = 'formant'
const ENGINE_VOICEBANK = 'voicebank'

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function round (value, digits = 2) {
  return Number(Number(value).toFixed(digits))
}

/** Peak/rms/crest/centroid line, shared with the other tools' vocabulary. */
function summaryLine (cwd, path, bytes, metrics, extra = []) {
  const size = bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
  return [
    `Wrote ${displayPath(cwd, path)} (${fmt(metrics.durationSeconds, 2)}s, ${metrics.sampleRate} Hz, ${size})`,
    `peak ${fmt(metrics.peakDbfs)} dBFS`,
    `rms ${fmt(metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(metrics.crestDb)} dB`,
    `centroid ${metrics.centroidHz} Hz`,
    `onsets ${metrics.onsets}`,
    metrics.clipping > 0 ? `CLIPPING ${metrics.clipping} samples` : 'no clipping',
    ...extra
  ].join(' · ')
}

/* ------------------------------------------------------------- measurement -- */

/** Mean/worst cents from a list of per-note measurements, with bounded items. */
function summariseAccuracy (items) {
  if (items.length === 0) return { checked: 0, meanCents: 0, maxCents: 0, meanPercent: 0, items }
  const cents = items.map((item) => Math.abs(item.cents))
  const meanCents = cents.reduce((sum, value) => sum + value, 0) / cents.length
  return {
    checked: items.length,
    meanCents: round(meanCents, 1),
    maxCents: round(Math.max(...cents), 1),
    meanPercent: round((Math.pow(2, meanCents / 1200) - 1) * 100, 2),
    items
  }
}

/**
 * Measure how close the sung pitch actually is to the planned pitch, per note.
 *
 * Measured on the sustain of each note by autocorrelation and reported in cents,
 * because "in tune" has to be a number: 1 % is about 17 cents. The formant
 * engine holds the planned pitch from the vowel onset, so the window starts
 * right after the consonant.
 */
function pitchAccuracy (result, plan) {
  const items = []
  const limit = Math.min(plan.notes.length, result.syllableTimings.length, MAX_PITCH_NOTES)
  for (let index = 0; index < limit; index += 1) {
    const note = plan.notes[index]
    const timing = result.syllableTimings[index]
    const length = timing.end - timing.start
    const entering = timing.vowelStart - timing.start
    const from = Math.min(timing.start + entering + 0.04, timing.start + length * 0.5)
    const to = Math.max(from + 0.04, timing.end - Math.max(0.04, length * 0.15))
    if (to - from < 0.03) continue
    const measured = measurePitch(result.samples, result.sampleRate, { from, to, minHz: 50, maxHz: 2000 })
    if (!(measured.hz > 0) || measured.clarity < 0.5) continue
    const target = midiToHz(note.midi)
    items.push({
      syllable: timing.text,
      midi: note.midi,
      targetHz: round(target, 2),
      measuredHz: round(measured.hz, 2),
      cents: round(1200 * Math.log2(measured.hz / target), 1)
    })
  }
  return summariseAccuracy(items)
}

/**
 * Pitch accuracy for the recorded tier.
 *
 * The window is deliberately different from the formant one: a human take scoops
 * into the note and only settles afterwards (the voicebank renderer measures its
 * takes the same way), so measuring from the note onset would report the
 * recording's attack rather than the transposition. The sustain is read from 35 %
 * to 92 % of the note, which is the window `test/voicebank.mjs` validates.
 */
function voicebankPitchAccuracy (result, plan) {
  const items = []
  const limit = Math.min(plan.notes.length, result.syllableTimings.length, MAX_PITCH_NOTES)
  for (let index = 0; index < limit; index += 1) {
    const note = plan.notes[index]
    const timing = result.syllableTimings[index]
    const length = timing.end - timing.start
    const from = timing.start + length * 0.35
    const to = timing.start + length * 0.92
    if (to - from < 0.03) continue
    const measured = measurePitch(result.samples, result.sampleRate, { from, to, minHz: 50, maxHz: 2000 })
    if (!(measured.hz > 0) || measured.clarity < 0.5) continue
    const target = midiToHz(note.midi)
    items.push({
      syllable: timing.text,
      midi: note.midi,
      targetHz: round(target, 2),
      measuredHz: round(measured.hz, 2),
      cents: round(1200 * Math.log2(measured.hz / target), 1)
    })
  }
  return summariseAccuracy(items)
}

/** One human line about pitch, in the units a musician reads. */
function pitchLine (accuracy, multiVoice) {
  if (accuracy.checked === 0) return 'pitch: not measurable (notes too short to analyse)'
  const worst = accuracy.items.reduce((a, b) => (Math.abs(a.cents) >= Math.abs(b.cents) ? a : b))
  const scope = multiVoice ? ' (melody voice only; the harmony layer is a mix)' : ''
  return `pitch ${accuracy.checked} note(s)${scope}: first ${accuracy.items[0].measuredHz} Hz on ${accuracy.items[0].syllable} (target ${accuracy.items[0].targetHz} Hz, ${fmt(accuracy.items[0].cents)} cents) · mean |error| ${fmt(accuracy.meanCents)} cents (${fmt(accuracy.meanPercent, 2)} %) · worst ${fmt(worst.cents)} cents`
}

/** Syllable timings as a short two-dot list, in seconds. */
function timingsLine (timings, total) {
  const shown = timings.slice(0, 12).map((item) => `${item.text} ${item.start.toFixed(2)}-${item.end.toFixed(2)}`)
  const more = total > shown.length ? ` … +${total - shown.length} more` : ''
  return `syllables (seconds, for subtitles): ${shown.join(' · ')}${more}`
}

/* --------------------------------------------------------------- voicebank -- */

/**
 * Normalise a pinyin syllable the same way `parseSyllable` does before it looks
 * at it: lowercase, ü written as v, tone digits and punctuation dropped. Bank
 * aliases are plain ASCII, so this is what makes "lü4" and "lv" one lookup.
 * @param {string} text - arbitrary syllable text.
 * @returns {string} ASCII lookup key.
 */
function syllableKey (text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')
    .replace(/[^a-z]/g, '')
}

/**
 * Alias names to try for one engine vowel id, best first.
 *
 * The engine's own ids are the keys, so this is keyed off what `sing.js` can
 * sing, not off any one bank: a nasal final is approximated by its oral base
 * (an -> a), the apical vowel by [i] (shi -> yi), ü by a rounded vowel, and a
 * bank that recorded `yi`/`wu` instead of `i`/`u` still gets the right vowel.
 */
const VOWEL_ALIASES = {
  a: ['a'],
  e: ['e'],
  i: ['i', 'yi'],
  i0: ['i', 'yi'],
  o: ['o'],
  u: ['u', 'wu'],
  v: ['v', 'u', 'wu', 'yi'],
  an: ['an', 'a'],
  en: ['en', 'e'],
  in: ['in', 'i', 'yi'],
  un: ['un', 'u', 'wu'],
  vn: ['vn', 'v', 'u', 'wu'],
  ang: ['ang', 'a'],
  eng: ['eng', 'e'],
  ing: ['ing', 'i', 'yi'],
  ong: ['ong', 'o'],
  er: ['er', 'e']
}

/**
 * The base alias names a bank can actually sing.
 *
 * `meta.names` also carries the CVVC transition names the parser derived (`a+`,
 * `a R`), which select a sustain or release take without the consonant; only the
 * base name picks an onset take, so the transition names are filtered out.
 * @param {object} bank - result of `loadVoicebank`.
 * @returns {Set<string>} alias names usable as a syllable.
 */
function singableBankNames (bank) {
  const names = new Set()
  for (const name of bank.meta.names) {
    if (name === '' || name.endsWith('+') || name.endsWith(' R')) continue
    names.add(name)
  }
  return names
}

/**
 * True when a bank alias is the syllable the plan asked for, judged through the
 * same parser that built the plan. That is stricter and more honest than a
 * string match: `xve` counts as `xue`, `yi` does not count as `ni`.
 * @param {string} alias - bank alias name.
 * @param {object} note - one note from `singPlan`.
 * @returns {boolean}
 */
function sameSyllable (alias, note) {
  const parsed = parseSyllable(alias)
  if (parsed.consonant !== (note.consonant ?? null)) return false
  const wanted = Array.isArray(note.vowels) && note.vowels.length > 0 ? note.vowels : [note.vowel ?? 'a']
  return parsed.vowels.length === wanted.length && parsed.vowels.every((vowel, index) => vowel === wanted[index])
}

/**
 * Pick the recorded alias that will sing one planned syllable.
 *
 * The lyric already went through `singPlan`/`parseSyllable`, so the consonant and
 * vowel sequence are known; this turns them into candidate alias names the bank
 * may carry, in falling order of fidelity:
 *
 *   1. the syllable as written (`ma`),
 *   2. the syllable rebuilt from the parsed segments (`x` + `ü` + `e` -> `xve`),
 *   3. consonant + each vowel id (`xue` -> `xu`),
 *   4. consonant + the bank-friendly spelling of each vowel (`xue` -> `xvi`),
 *   5. the bare vowel, primary vowel first (`xue` -> `e`); dropping the consonant
 *      is the bigger loss, which is why it comes last.
 *
 * A miss at every level returns `null` instead of singing a random take.
 *
 * @param {Set<string>} available - names from {@link singableBankNames}.
 * @param {object} note - one note from `singPlan`.
 * @returns {{ name: string|null, exact: boolean, requested: string }}
 */
function chooseBankAlias (available, note) {
  const requested = note.syllable === undefined ? 'la' : String(note.syllable)
  const key = syllableKey(requested)
  const vowels = Array.isArray(note.vowels) && note.vowels.length > 0 ? note.vowels : [note.vowel ?? 'a']
  const consonant = note.consonant ?? ''
  const candidates = []
  const add = (name) => {
    if (name !== '' && !candidates.includes(name)) candidates.push(name)
  }

  add(key)
  add(consonant + vowels.join(''))
  for (const vowel of vowels) {
    add(consonant + vowel)
    for (const alias of VOWEL_ALIASES[vowel] ?? [vowel]) add(consonant + alias)
  }
  // The primary vowel is the last one (the nucleus); try its bare spellings
  // before the other vowels' so `xue` lands on /e/, not on /ü/.
  for (const vowel of vowels.slice().reverse()) {
    for (const alias of VOWEL_ALIASES[vowel] ?? [vowel]) add(alias)
  }
  add('a')

  for (const name of candidates) {
    if (available.has(name)) return { name, exact: sameSyllable(name, note), requested }
  }
  return { name: null, exact: false, requested }
}

/**
 * Translate a formant plan into a voicebank plan and count how faithful the
 * mapping is, so the report can say what degraded.
 *
 * @param {Set<string>} available - names from {@link singableBankNames}.
 * @param {object} plan - result of `singPlan`.
 * @returns {{
 *   notes: Array<{ midi:number, start:number, durationSeconds:number, syllable:string }>,
 *   mappings: Array<{ name:string|null, exact:boolean, requested:string }>,
 *   coverage: { requested:number, exact:number, approximated:number, silent:number, approximatedSamples:string[] }
 * }}
 */
function mapPlanToBank (available, plan) {
  const secondsPerBeat = 60 / plan.bpm
  const notes = []
  const mappings = []
  const coverage = { requested: plan.notes.length, exact: 0, approximated: 0, silent: 0, approximatedSamples: [] }
  for (const note of plan.notes) {
    const chosen = chooseBankAlias(available, note)
    if (chosen.name === null) {
      coverage.silent += 1
    } else if (chosen.exact) {
      coverage.exact += 1
    } else {
      coverage.approximated += 1
      if (coverage.approximatedSamples.length < MAX_APPROXIMATIONS) {
        coverage.approximatedSamples.push(`${chosen.requested}→${chosen.name}`)
      }
    }
    mappings.push(chosen)
    notes.push({
      midi: note.midi,
      start: note.startBeat * secondsPerBeat,
      durationSeconds: note.durBeats * secondsPerBeat,
      syllable: chosen.name ?? note.syllable
    })
  }
  return { notes, mappings, coverage }
}

/**
 * Reshape the voicebank engine's timings into the tool's timing contract, so a
 * caller that reads `text/start/end` does not have to care which engine ran.
 * @param {object} rendered - result of `renderVoicebank`.
 * @param {object} plan - result of `singPlan`.
 * @param {object} mapped - result of {@link mapPlanToBank}.
 * @returns {object[]} syllable timings.
 */
function voicebankTimings (rendered, plan, mapped) {
  return rendered.syllableTimings.map((timing, index) => {
    const note = plan.notes[index]
    const mapping = mapped.mappings[index]
    const start = timing.startSeconds
    return {
      text: note.syllable,
      start: round(start, 3),
      end: round(start + timing.durationSeconds, 3),
      vowel: note.vowel,
      consonant: note.consonant,
      // The renderer aligns preutterance to the note onset: the recorded
      // consonant starts a little before `start`, the vowel lands on it.
      vowelStart: round(start, 3),
      alias: timing.alias,
      bankSyllable: mapping === undefined ? null : mapping.name,
      exact: mapping !== undefined && mapping.exact,
      shiftCents: timing.shiftCents,
      sourceF0Hz: timing.sourceF0Hz,
      looped: timing.looped,
      voiced: timing.voiced
    }
  })
}

/**
 * Where a `voicebank` request points.
 *
 * Precedence: an explicit tool argument wins over plugin config, which wins over
 * the directory `tools/fetch-voicebank.mjs` installs into. `explicit` decides the
 * failure mode later: a directory the caller named should throw when it exists
 * but is not a bank, while the default/config path falls back to the formant
 * voice with a warning — the usual cause is simply "the user never downloaded".
 *
 * @param {object} args - tool arguments.
 * @param {object} config - resolved plugin config (may carry `voicebankDir`).
 * @param {string} cwd - session directory for relative paths.
 * @returns {{ dir: string, explicit: boolean, source: string }|null} null = formant engine.
 */
function requestedVoicebank (args, config, cwd) {
  const fromArgument = typeof args.voicebank === 'string' && args.voicebank.trim() !== ''
  const fromDir = typeof args.voicebankDir === 'string' && args.voicebankDir.trim() !== ''
  // `voicebank: false` is an explicit request for the formant engine; naming a
  // directory otherwise is itself a request to use the recorded tier.
  const enabled = args.voicebank === true || fromArgument || (args.voicebank !== false && fromDir)
  if (!enabled) return null
  if (fromArgument) return { dir: resolvePath(cwd, args.voicebank), explicit: true, source: 'voicebank' }
  if (fromDir) return { dir: resolvePath(cwd, args.voicebankDir), explicit: true, source: 'voicebankDir' }
  const configured = typeof config?.voicebankDir === 'string' ? config.voicebankDir.trim() : ''
  if (configured !== '') return { dir: resolvePath(cwd, configured), explicit: false, source: 'config.voicebankDir' }
  return { dir: defaultVoicebankDir(), explicit: false, source: 'default' }
}

/* ------------------------------------------------------------------ writing -- */

/** Encode and write one rendered take, returning the measured report pieces. */
async function writeRender (cwd, args, samples, sampleRate, hash) {
  const metrics = { ...measure(samples, sampleRate), sampleRate }
  const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'sing', hash)
  const bytes = toWavBytes(samples, sampleRate)
  await writeFileAtomic(target, bytes)
  const info = await stat(target)
  return { target, bytes: info.size, metrics }
}

/* ------------------------------------------------------------------- tools -- */

/**
 * Render with the built-in formant engine (the zero-asset default).
 * @returns {Promise<object>} the tool result.
 */
async function singWithFormant (cwd, args, plan, warning) {
  // The engine falls back to alto for an unknown id; report the voice that
  // actually sang instead of echoing the unknown id back as if it had applied.
  const requestedVoice = args.voice === undefined || args.voice === null ? 'alto' : String(args.voice)
  const voice = VOICE_PRESETS[requestedVoice] !== undefined ? requestedVoice : 'alto'
  const options = {
    voice,
    vibrato: args.vibrato,
    breath: args.breath,
    harmony: args.harmony,
    seed: Number.isFinite(args.seed) ? args.seed : 1,
    sampleRate: args.sampleRate
  }
  const rendered = renderSing(plan, options)
  const sampleRate = rendered.sampleRate
  // Kept byte-compatible with the pre-voicebank tool: the same request hashes to
  // the same file name, so existing renders are still reused instead of redone.
  const hash = hashSpec({
    engine: 'sing/1',
    notes: plan.notes.map((note) => [note.midi, note.startBeat, note.durBeats, note.syllable]),
    bpm: plan.bpm,
    voice,
    vibrato: options.vibrato ?? null,
    breath: options.breath ?? null,
    harmony: options.harmony ?? null,
    seed: options.seed,
    sampleRate
  })
  const written = await writeRender(cwd, args, rendered.samples, sampleRate, hash)

  const multiVoice = Boolean(args.harmony) || VOICE_PRESETS[voice].voices > 1
  // Autocorrelation on a two-voice mix locks onto the common period of the
  // harmony, not the melody (C4 + E4 reads as C3). When the render is a mix,
  // measure a melody-only copy so the reported accuracy describes the line.
  const accuracy = pitchAccuracy(
    multiVoice ? renderSing(plan, { ...options, harmony: undefined, voice: 'alto' }) : rendered,
    plan
  )
  const timings = rendered.syllableTimings
  const cappedTimings = timings.slice(0, MAX_TIMINGS)
  const warnings = rendered.warnings.slice()
  if (requestedVoice !== voice) warnings.push(`unknown voice "${requestedVoice}"; sang with "${voice}"`)
  if (warning !== null) warnings.push(warning)
  const text = [
    summaryLine(cwd, written.target, written.bytes, written.metrics, [
      `engine ${ENGINE_FORMANT} · voice ${voice} · bpm ${fmt(plan.bpm, 0)} · ${plan.notes.length} note(s) · ${timings.length} syllable(s)${args.harmony ? ` · harmony ${args.harmony}` : ''}`
    ]),
    pitchLine(accuracy, multiVoice),
    timingsLine(cappedTimings, timings.length),
    ...warnings.map((line) => `warning: ${line}`)
  ].join('\n')

  return {
    path: written.target,
    relativePath: displayPath(cwd, written.target),
    bytes: written.bytes,
    durationSeconds: written.metrics.durationSeconds,
    sampleRate,
    bpm: plan.bpm,
    notes: plan.notes.length,
    voice,
    engine: ENGINE_FORMANT,
    voicebank: null,
    warning,
    metrics: written.metrics,
    syllableTimings: cappedTimings,
    syllableCount: timings.length,
    pitchAccuracy: { ...accuracy, items: accuracy.items.slice(0, MAX_PITCH_NOTES) },
    pitchTrack: { frameRate: rendered.pitchTrack.frameRate, samples: rendered.pitchTrack.hz.length },
    warnings,
    text
  }
}

/**
 * Render with a recorded voicebank (the optional human-voice tier).
 * @returns {Promise<object>} the tool result.
 */
async function singWithVoicebank (cwd, args, plan, state) {
  const bank = state.bank
  const coverage = state.mapped.coverage
  // renderVoicebank does not clamp; the formant engine clamps to the same range.
  const sampleRate = clamp(Math.round(Number(args.sampleRate ?? 44100)), 8000, 96000)
  const hash = hashSpec({
    engine: 'sing/voicebank/1',
    notes: plan.notes.map((note) => [note.midi, note.startBeat, note.durBeats, note.syllable]),
    bpm: plan.bpm,
    bank: bank.meta.dir,
    sampleRate
  })
  const rendered = renderVoicebank(
    { notes: state.mapped.notes, bpm: plan.bpm },
    { bank, sampleRate }
  )
  const written = await writeRender(cwd, args, rendered.samples, sampleRate, hash)

  const timings = voicebankTimings(rendered, plan, state.mapped)
  const cappedTimings = timings.slice(0, MAX_TIMINGS)
  const accuracy = voicebankPitchAccuracy(
    { samples: rendered.samples, sampleRate, syllableTimings: timings },
    plan
  )
  const warnings = plan.warnings.slice()
  if (coverage.silent > 0) {
    warnings.push(`${coverage.silent} syllable(s) had no matching recorded take and are silent`)
  }
  // Only warn about options that would actually have changed the formant render:
  // a caller that passes the alto defaults is not asking for anything different.
  const alto = VOICE_PRESETS.alto
  const formantOnly = []
  if (args.voice !== undefined && args.voice !== alto.label) formantOnly.push('voice')
  if (Number.isFinite(args.vibrato) && args.vibrato !== alto.vibrato) formantOnly.push('vibrato')
  if (Number.isFinite(args.breath) && args.breath !== alto.breath) formantOnly.push('breath')
  if (args.harmony !== undefined) formantOnly.push('harmony')
  if (formantOnly.length > 0) {
    warnings.push(`${formantOnly.join('/')} only affect the formant engine and were ignored by the recorded voice`)
  }

  const parts = [`${coverage.exact} of ${coverage.requested} syllable(s) exact from recorded takes`]
  if (coverage.approximated > 0) {
    const shown = coverage.approximatedSamples.join(', ')
    const more = coverage.approximated > coverage.approximatedSamples.length ? ', …' : ''
    parts.push(`${coverage.approximated} approximated to a recorded vowel (${shown}${more}; consonant dropped)`)
  }
  if (coverage.silent > 0) parts.push(`${coverage.silent} silent (no take)`)
  const coverageLine = `recorded bank: ${parts.join(' · ')}`

  const text = [
    summaryLine(cwd, written.target, written.bytes, written.metrics, [
      `engine ${ENGINE_VOICEBANK} (${basename(bank.meta.dir)}) · bpm ${fmt(plan.bpm, 0)} · ${plan.notes.length} note(s) · ${timings.length} syllable(s)`
    ]),
    pitchLine(accuracy, false),
    coverageLine,
    timingsLine(cappedTimings, timings.length),
    ...warnings.map((line) => `warning: ${line}`)
  ].join('\n')

  return {
    path: written.target,
    relativePath: displayPath(cwd, written.target),
    bytes: written.bytes,
    durationSeconds: written.metrics.durationSeconds,
    sampleRate,
    bpm: plan.bpm,
    notes: plan.notes.length,
    voice: null,
    engine: ENGINE_VOICEBANK,
    voicebank: {
      dir: bank.meta.dir,
      name: basename(bank.meta.dir),
      syllables: state.names.size,
      takes: bank.meta.syllables,
      coverage
    },
    warning: null,
    metrics: written.metrics,
    syllableTimings: cappedTimings,
    syllableCount: timings.length,
    pitchAccuracy: { ...accuracy, items: accuracy.items.slice(0, MAX_PITCH_NOTES) },
    // The bank renderer analyses per take instead of building a track; measuring
    // one here would cost more than the field is worth, so it is reported absent.
    pitchTrack: null,
    warnings,
    text
  }
}

/**
 * Register the `audio_sing` tool.
 * @param {object} ctx - registrant context with a `tools` service.
 * @param {object} [config] - resolved plugin config; `voicebankDir` (optional)
 *   points `voicebank: true` at a bank without the caller naming a path.
 */
export function registerSingTools (ctx, config = {}) {
  // One bank cached at a time: loading decodes every referenced wav (222 ms for
  // the 12-file subset, seconds and hundreds of MB for a full bank), and a
  // plugin instance normally has one bank. Failures are never cached — the user
  // may run `tools/fetch-voicebank.mjs` between two calls.
  let cachedDir = ''
  let cached = null

  /** Load (or reuse) a bank, reporting why it cannot be used instead of throwing. */
  const loadBank = (dir) => {
    if (cached !== null && cachedDir === dir) return cached
    let info
    try {
      info = statSync(dir)
    } catch {
      return { bank: null, missing: true, error: 'the directory does not exist' }
    }
    if (!info.isDirectory()) return { bank: null, missing: false, error: 'it is a file, not a directory' }
    try {
      const bank = loadVoicebank(dir)
      const names = singableBankNames(bank)
      if (names.size === 0) return { bank: null, missing: false, error: 'its oto.ini has no syllable alias' }
      cached = { bank, names }
      cachedDir = dir
      return cached
    } catch (error) {
      return { bank: null, missing: false, error: error.message }
    }
  }

  ctx.tools.register({
    name: 'audio_sing',
    description: 'Sing words in a formant-synthesized voice, or in a downloaded recorded voicebank when one is installed: give notes (MIDI numbers or a melody string) and a pinyin lyric. Zero-asset and deterministic by default — no download, no network, no key — so it is the always-available tier when audio_tts has no provider or when the cue is *melodic* rather than spoken. Set `voicebank: true` (or pass `voicebankDir`) to use the optional recorded-voice tier installed by tools/fetch-voicebank.mjs: a real human voice, but only a handful of syllables may be recorded, and the missing ones degrade to a recorded vowel. A missing bank never fails the call: it falls back to the formant voice and says so. Returns the file, the engine used, syllable timings in seconds for subtitles, and measured pitch accuracy in cents.',
    parameters: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          description: 'Melody as explicit notes: {midi, dur, syllable?}. midi is a MIDI number (60 = C4, 69 = A4) or a name like "A3"/"C#4"; dur is in beats; syllable is pinyin and may be omitted (the lyric fills it, else "la").',
          items: {
            type: 'object',
            properties: {
              midi: { type: 'number', description: 'MIDI note number (60 = C4, 69 = A4, 57 = A3).' },
              dur: { type: 'number', description: 'Duration in beats (0.25 = a sixteenth at 4/4).' },
              syllable: { type: 'string', description: 'Pinyin syllable for this note, e.g. "ma". Omit to take it from the lyric.' },
              beat: { type: 'number', description: 'Optional absolute start in beats; otherwise notes follow each other.' },
              velocity: { type: 'number', description: 'Optional 0..1 loudness weighting for this note.' }
            },
            additionalProperties: true
          }
        },
        melody: { type: 'string', description: 'Compact melody such as "C4:1 E4:1 G4:2" (pitch:beats; "r" is a rest). Use this instead of notes for a quick line.' },
        lyric: { type: 'string', description: 'Words to sing, space separated, in pinyin ("wo ai ni"). Han characters cannot be romanized without a dictionary, so they fall back to "a" with a warning — pass pinyin.' },
        bpm: { type: 'number', description: 'Tempo; one beat is 60 / bpm seconds. Defaults to 96.' },
        voice: { type: 'string', enum: VOICE_NAMES, description: 'Formant engine only: voice colour alto (default, neutral adult), child (higher formants, brighter), bass (lower formants, darker), breathy (more air), choir (three detuned voices plus room). Ignored by the recorded voice.' },
        vibrato: { type: 'number', description: 'Formant engine only: 0..1 vibrato depth (1 is about ±55 cents) with a delayed onset. Defaults to the voice preset.' },
        breath: { type: 'number', description: 'Formant engine only: 0..1 breathiness, gated noise shaped by the vowel formants. Defaults to the voice preset.' },
        harmony: { type: 'string', enum: ['third', 'fifth', 'octave'], description: 'Formant engine only: add a harmony voice that many semitones above. Fixed intervals, so pick the notes to stay in key.' },
        voicebank: {
          anyOf: [{ type: 'boolean' }, { type: 'string' }],
          description: 'Recorded-voice tier. false/absent = built-in formant engine (default). true = the voicebank installed by tools/fetch-voicebank.mjs (or config.voicebankDir). A string = path to a voicebank directory containing oto.ini, relative to the working directory or absolute. A missing bank falls back to the formant voice with a warning instead of failing; a directory that exists but is not a bank throws.'
        },
        voicebankDir: { type: 'string', description: 'Voicebank directory for this call, so no config is needed; implies the recorded tier unless voicebank is explicitly false. Takes precedence over config.voicebankDir, while a string voicebank argument takes precedence over this.' },
        seed: { type: 'integer', description: 'Variation seed for the formant engine. Same seed and same request reproduce the same bytes; the recorded tier is dead straight and ignores it.' },
        sampleRate: { type: 'integer', description: 'Defaults to 44100. Use 48000 when the deliverable is video.' },
        out: { type: 'string', description: 'Output path, relative to the working directory. Defaults to assets/audio/sing-<hash>.wav.' }
      },
      required: [],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Sing ${String(args.lyric ?? args.melody ?? (Array.isArray(args.notes) ? `${args.notes.length} notes` : 'a voice')).slice(0, 40)}`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const plan = singPlan({
        notes: args.notes,
        melody: args.melody,
        lyric: args.lyric,
        bpm: args.bpm
      })
      if (plan.notes.length > MAX_NOTES) {
        throw new Error(`audio_sing: ${plan.notes.length} notes exceeds the ${MAX_NOTES} note limit; split the phrase`)
      }
      if (plan.totalSeconds > MAX_SECONDS) {
        throw new Error(`audio_sing: ${fmt(plan.totalSeconds)} s exceeds the ${MAX_SECONDS} s limit; split the phrase or raise bpm`)
      }

      // Resolve the recorded tier before rendering: a bank that cannot be used
      // must still produce the formant voice, with the reason in `warning`.
      const request = requestedVoicebank(args, config, cwd)
      let warning = null
      let bankState = null
      if (request !== null) {
        const loaded = loadBank(request.dir)
        if (loaded.bank === null) {
          if (loaded.missing) {
            // The usual case: the optional bank was never downloaded.
            warning = `recorded voicebank not found at ${request.dir}; sang with the formant voice instead (run tools/fetch-voicebank.mjs to download it, or pass voicebankDir)`
          } else if (request.explicit) {
            throw new Error(`audio_sing: ${request.source} "${request.dir}" is not a usable voicebank (${loaded.error})`)
          } else {
            warning = `recorded voicebank at ${request.dir} could not be loaded (${loaded.error}); sang with the formant voice instead`
          }
        } else {
          const mapped = mapPlanToBank(loaded.names, plan)
          if (mapped.coverage.exact + mapped.coverage.approximated === 0) {
            warning = `voicebank at ${request.dir} has ${loaded.bank.meta.syllables} take(s) but no alias matches this lyric; sang with the formant voice instead`
          } else {
            bankState = { bank: loaded.bank, names: loaded.names, mapped }
          }
        }
      }

      if (bankState !== null) return singWithVoicebank(cwd, args, plan, bankState)
      return singWithFormant(cwd, args, plan, warning)
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
