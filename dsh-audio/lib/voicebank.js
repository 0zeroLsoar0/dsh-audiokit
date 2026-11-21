/**
 * Optional "real voice" singing tier: concatenative playback of a recorded
 * syllable voicebank in UTAU `oto.ini` layout.
 *
 * Why this module exists: the always-available singer is formant synthesis
 * (`lib/singer.js`), which needs no assets but sounds synthetic. When the user
 * opts into downloading a voicebank, this module plays *recorded* syllables
 * instead: it picks the take nearest in pitch, shifts it onto the note with a
 * pitch-synchronous resample, loops the recorded sustain when the note is
 * longer than the sample, and crossfades note boundaries.
 *
 * No audio is bundled. The bank is an external directory chosen by the caller,
 * so `loadVoicebank(dir)` never guesses a path and the npm package stays
 * dependency-free. The parser is deliberately tolerant: a voicebank is user
 * data, not something we control.
 *
 * Limitations we do not hide:
 * - Aliases are decoded as UTF-8/UTF-16LE only (no Shift-JIS table in `node:`),
 *   so a Shift-JIS bank yields garbled non-ASCII aliases; romaji aliases work.
 * - Pitch shifting moves formants with the pitch (unavoidable without a full
 *   PSOLA/phase-vocoder formant path); picking the nearest recorded take keeps
 *   the correction within a couple of semitones.
 * - Only the onset region of each syllable is used; CVVC `+` (sustain) and ` R`
 *   (release) regions are parsed and exposed but not yet used for synthesis.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clamp, makeRng } from './dsp.js'
import { decodeWav } from './wav.js'

/* ---- constants ---- */

/** Output rate of the singing engine. Voicebanks are usually already 44.1 kHz. */
export const VOICE_SAMPLE_RATE = 44100

/** Highest/lowest fundamental we are willing to measure or sing, in Hz. */
const F0_MIN_HZ = 60
const F0_MAX_HZ = 1200

/** A note never uses less than this much of a recorded syllable, in ms. */
const MIN_SLICE_MS = 160

/** How far into the recorded vowel the loop may start, in ms (skips the attack). */
const LOOP_ATTACK_MS = 28

/** Longest loop body we will use, in ms. Longer loops hide the seam better but
 *  drift more if the recording has vibrato. */
const LOOP_MAX_MS = 240

const DEFAULT_ATTACK_SECONDS = 0.012
const DEFAULT_RELEASE_SECONDS = 0.07
const DEFAULT_CROSSFADE_SECONDS = 0.022

/* ---- note names ---- */

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * Convert a scientific note name to a MIDI number.
 * @param {string|number} value - e.g. `C4`, `F#3`, `Bb5`, or a MIDI number.
 * @returns {number} MIDI note number (fractional input is clamped to a number).
 */
export function noteToMidi (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(text)
  if (!match) throw new Error(`noteToMidi: cannot read note "${value}"`)
  const [, letter, accidental, octave] = match
  const semitone = NOTE_OFFSETS[letter.toUpperCase()] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0)
  return semitone + (Number(octave) + 1) * 12
}

/**
 * Frequency of a MIDI note in Hz (A4 = 69 = 440 Hz).
 * @param {number} midi - MIDI note number, may be fractional.
 * @returns {number} Hz.
 */
export function midiToHz (midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Parse a compact note script such as `"C4:1 E4:1 G4:2"` (note or note:beats).
 * Used by the CLI and the test so both read the same syntax.
 * @param {string} text - whitespace separated `note[:beats]` tokens.
 * @param {{ beatsPerNote?: number }} [options] - default length when `:beats` is omitted.
 * @returns {{ note: string, midi: number, beats: number }[]}
 */
export function parseNoteScript (text, options = {}) {
  const beatsPerNote = options.beatsPerNote ?? 1
  const notes = []
  for (const token of String(text).trim().split(/\s+/)) {
    if (token === '') continue
    const [note, beats] = token.split(':')
    const length = beats === undefined ? beatsPerNote : Number(beats)
    if (!Number.isFinite(length) || length <= 0) throw new Error(`parseNoteScript: bad length in "${token}"`)
    notes.push({ note, midi: noteToMidi(note), beats: length })
  }
  if (notes.length === 0) throw new Error('parseNoteScript: no notes given')
  return notes
}

/* ---- oto.ini parsing ---- */

/**
 * Decode oto.ini bytes to text. Handles the BOMs Node can decode natively;
 * Shift-JIS is read as latin1, which keeps aliases byte-visible but garbled.
 * @param {Buffer} bytes - raw file bytes.
 * @returns {{ text: string, encoding: string }}
 */
function decodeOtoText (bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.toString('utf16le', 2), encoding: 'utf16le' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.toString('utf8', 3), encoding: 'utf8-bom' }
  }
  return { text: bytes.toString('utf8'), encoding: 'utf8' }
}

/**
 * Split an UTAU alias into its role, syllable name and pitch suffix.
 * `- ka_A3` is the onset of `ka` recorded at A3, `ka+` the sustain, `ka R` the release.
 * @param {string} alias - raw alias text from oto.ini.
 * @returns {{ kind: 'onset'|'sustain'|'release'|'other', name: string, pitch: string|undefined, pitchHz: number }}
 */
function splitAlias (alias) {
  let text = alias.trim()
  let kind = 'other'
  if (text.startsWith('- ')) {
    kind = 'onset'
    text = text.slice(2)
  } else if (text.endsWith('+')) {
    kind = 'sustain'
    text = text.slice(0, -1)
  } else if (text.endsWith(' R')) {
    kind = 'release'
    text = text.slice(0, -2)
  }
  const suffix = /_([A-Ga-g][#b]?-?\d)$/.exec(text)
  let pitch
  let pitchHz = 0
  if (suffix) {
    pitch = suffix[1]
    text = text.slice(0, -suffix[0].length)
    try {
      pitchHz = midiToHz(noteToMidi(pitch))
    } catch {
      pitchHz = 0
    }
  }
  return { kind, name: text.trim(), pitch, pitchHz }
}

/**
 * Parse one oto.ini file.
 *
 * A sample line is `file.wav=alias,offset,consonant,cutoff,preutterance,overlap`;
 * we treat any line whose left side ends in `.wav` as a syllable entry, so
 * `#SETTING` / `#VOICE` / `#OFFSET` sections and their `key=value` lines are
 * collected separately instead of being mistaken for samples.
 *
 * @param {string} text - decoded oto.ini text.
 * @returns {{ entries: object[], sections: Record<string, Record<string, string>> }}
 */
export function parseOtoIni (text) {
  const entries = []
  const sections = {}
  let section = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      section = line.slice(1).trim().toUpperCase()
      sections[section] = sections[section] ?? {}
      continue
    }
    const split = line.indexOf('=')
    if (split <= 0) continue
    const left = line.slice(0, split)
    const right = line.slice(split + 1)
    if (!/\.wav$/i.test(left)) {
      if (section) sections[section][left.trim()] = right.trim()
      continue
    }
    const parts = right.split(',')
    if (parts.length < 6) continue
    const numbers = parts.slice(1, 6).map((value) => Number(value))
    if (numbers.some((value) => !Number.isFinite(value))) continue
    const [offsetMs, consonantMs, cutoffMs, preutteranceMs, overlapMs] = numbers
    entries.push({
      file: left.trim(),
      alias: parts[0].trim(),
      offsetMs,
      consonantMs,
      cutoffMs,
      preutteranceMs,
      overlapMs
    })
  }
  return { entries, sections }
}

/**
 * Find every oto.ini inside a voicebank directory tree.
 * @param {string} dir - bank root.
 * @param {number} [maxDepth] - directory recursion limit.
 * @returns {string[]} oto.ini paths, sorted for determinism.
 */
function findOtoFiles (dir, maxDepth = 3) {
  const found = []
  const walk = (current, depth) => {
    let names
    try {
      names = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of names) {
      if (entry.isFile() && entry.name.toLowerCase() === 'oto.ini') found.push(join(current, entry.name))
    }
    if (depth >= maxDepth) return
    for (const entry of names) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(join(current, entry.name), depth + 1)
    }
  }
  walk(dir, 0)
  return found
}

/* ---- pitch analysis ---- */

/**
 * Normalised autocorrelation pitch measurement over one window.
 * Exported because the test needs to verify the rendered pitch independently
 * of what the renderer *thinks* it did.
 *
 * @param {Float32Array} samples - mono signal.
 * @param {number} sampleRate - samples per second.
 * @param {number} [startFrame] - first frame of the analysis window.
 * @param {number} [windowFrames] - window length; 0 picks a short default.
 * @param {{ minHz?: number, maxHz?: number, threshold?: number, minConfidence?: number }} [options]
 *   `threshold` is relative to the window's own best peak; `minConfidence` is an
 *   absolute floor so room tone and unvoiced consonants are reported as 0 Hz.
 * @returns {{ f0Hz: number, confidence: number }} `f0Hz` is 0 when unvoiced.
 */
export function measureF0 (samples, sampleRate, startFrame = 0, windowFrames = 0, options = {}) {
  const minHz = options.minHz ?? F0_MIN_HZ
  const maxHz = options.maxHz ?? F0_MAX_HZ
  const threshold = options.threshold ?? 0.55
  const minConfidence = options.minConfidence ?? 0.4
  const start = clamp(Math.round(startFrame), 0, Math.max(0, samples.length - 2))
  const wanted = windowFrames > 0 ? Math.round(windowFrames) : 2048
  const frames = Math.min(wanted, samples.length - start)
  if (frames < 96) return { f0Hz: 0, confidence: 0 }

  let mean = 0
  for (let i = 0; i < frames; i += 1) mean += samples[start + i]
  mean /= frames

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz))
  const maxLag = Math.min(frames - 2, Math.ceil(sampleRate / minHz))
  if (maxLag <= minLag + 1) return { f0Hz: 0, confidence: 0 }

  const correlation = new Float32Array(maxLag + 1)
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0
    let energyA = 0
    let energyB = 0
    const count = frames - lag
    for (let i = 0; i < count; i += 1) {
      const a = samples[start + i] - mean
      const b = samples[start + lag + i] - mean
      dot += a * b
      energyA += a * a
      energyB += b * b
    }
    const value = energyA > 1e-12 && energyB > 1e-12 ? dot / Math.sqrt(energyA * energyB) : 0
    correlation[lag] = value
    if (value > best) best = value
  }
  if (best < threshold) return { f0Hz: 0, confidence: best }
  if (best < minConfidence) return { f0Hz: 0, confidence: best }

  // First local maximum close to the global peak: the smallest lag that explains
  // the waveform, so we do not report an octave below the true pitch.
  let lag = minLag
  const floor = best * 0.85
  for (; lag <= maxLag; lag += 1) {
    const value = correlation[lag]
    if (value < floor) continue
    const previous = correlation[lag - 1] ?? 0
    const next = correlation[lag + 1] ?? 0
    if (value >= previous && value >= next) break
  }
  if (lag > maxLag) return { f0Hz: 0, confidence: best }

  // Parabolic interpolation around the peak for sub-sample accuracy.
  const y0 = correlation[lag - 1] ?? 0
  const y1 = correlation[lag]
  const y2 = correlation[lag + 1] ?? 0
  const denominator = y0 - 2 * y1 + y2
  const shift = Math.abs(denominator) > 1e-9 ? clamp((0.5 * (y0 - y2)) / denominator, -0.5, 0.5) : 0
  return { f0Hz: sampleRate / (lag + shift), confidence: y1 }
}

/**
 * Median fundamental of a whole region, used to learn a sample's recorded pitch.
 * @param {Float32Array} samples - mono signal.
 * @param {number} sampleRate - samples per second.
 * @param {number} [startFrame] - first frame of the region.
 * @param {number} [endFrame] - exclusive end frame of the region.
 * @param {{ minHz?: number, maxHz?: number, threshold?: number, frameFrames?: number }} [options]
 * @returns {{ f0Hz: number, confidence: number, frames: number }}
 */
export function estimateF0 (samples, sampleRate, startFrame = 0, endFrame = samples.length, options = {}) {
  const frameFrames = options.frameFrames ?? 2048
  const hop = Math.max(1, Math.round(frameFrames / 2))
  const start = clamp(Math.round(startFrame), 0, samples.length)
  const end = clamp(Math.round(endFrame), start, samples.length)
  const values = []
  let confidence = 0
  for (let at = start; at + frameFrames <= end; at += hop) {
    const measured = measureF0(samples, sampleRate, at, frameFrames, options)
    if (measured.f0Hz > 0) {
      values.push(measured.f0Hz)
      confidence = Math.max(confidence, measured.confidence)
    }
  }
  if (values.length === 0) return { f0Hz: 0, confidence, frames: 0 }
  values.sort((a, b) => a - b)
  return { f0Hz: values[values.length >> 1], confidence, frames: values.length }
}

/* ---- bank loading ---- */

/** Directory name a downloaded bank is installed under, next to the plugin's data. */
const DEFAULT_BANK_NAME = 'hitsuboku-kumi-chn'

/**
 * Where `tools/fetch-voicebank.mjs` installs the optional bank.
 *
 * Exported so the plugin and the fetch tool agree on one path: a caller that has
 * no bank configured can probe this directory instead of asking the user.
 * @returns {string} platform-appropriate absolute path.
 */
export function defaultVoicebankDir () {
  const home = process.env.USERPROFILE ?? process.env.HOME
  const base = home ?? '.'
  return join(base, '.dsh', 'dsh-audio', 'voicebank', DEFAULT_BANK_NAME)
}

/**
 * Load a voicebank directory into memory.
 *
 * Each file is decoded once and shared by every alias that points at it, so a
 * 12-syllable subset costs about 18 MB while a full 400-file bank costs several
 * hundred MB — callers that only need a few syllables should ship/load a subset.
 *
 * @param {string} dir - directory containing one or more `oto.ini` files.
 * @param {{ maxDepth?: number }} [options]
 * @returns {{
 *   syllables: Map<string, object>,
 *   meta: {
 *     dir: string, otoFiles: string[], entries: number, syllables: number,
 *     files: number, missingFiles: number, missingEntries: number,
 *     sampleRate: number, durationSeconds: number,
 *     sections: Record<string, Record<string, string>>,
 *     names: string[], parts: Map<string, { onset: object[], sustain: object[], release: object[], other: object[] }>
 *   }
 * }}
 */
export function loadVoicebank (dir, options = {}) {
  const root = resolve(dir)
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    throw new Error(`loadVoicebank: cannot read voicebank directory "${root}"`)
  }
  if (!rootStat.isDirectory()) throw new Error(`loadVoicebank: "${root}" is not a directory`)

  const otoFiles = findOtoFiles(root, options.maxDepth ?? 3)
  if (otoFiles.length === 0) throw new Error(`loadVoicebank: no oto.ini found under "${root}"`)

  const decoded = new Map()
  const syllables = new Map()
  const parts = new Map()
  const sections = {}
  let entries = 0
  let missingEntries = 0
  let durationFrames = 0
  let rateTotal = 0
  let rateWeight = 0

  const readSample = (absolutePath) => {
    let sample = decoded.get(absolutePath)
    if (sample !== undefined) return sample
    let bytes
    try {
      bytes = readFileSync(absolutePath)
    } catch {
      decoded.set(absolutePath, null)
      return null
    }
    const wav = decodeWav(bytes)
    const frames = wav.channels[0].length
    let mono = wav.channels[0]
    if (wav.channels.length > 1) {
      mono = new Float32Array(frames)
      for (let channel = 0; channel < wav.channels.length; channel += 1) {
        const source = wav.channels[channel]
        for (let i = 0; i < frames; i += 1) mono[i] += source[i] / wav.channels.length
      }
    }
    sample = { samples: mono, sampleRate: wav.sampleRate }
    decoded.set(absolutePath, sample)
    rateTotal += wav.sampleRate
    rateWeight += 1
    if (frames > durationFrames) durationFrames = frames
    return sample
  }

  for (const otoPath of otoFiles) {
    const parsed = parseOtoIni(decodeOtoText(readFileSync(otoPath)).text)
    for (const [key, values] of Object.entries(parsed.sections)) sections[key] = { ...(sections[key] ?? {}), ...values }
    const otoDir = resolve(otoPath, '..')
    for (const entry of parsed.entries) {
      entries += 1
      const absolute = resolve(otoDir, entry.file.replace(/\\/g, '/'))
      const sample = readSample(absolute)
      if (sample === null) {
        missingEntries += 1
        continue
      }
      const aliasInfo = splitAlias(entry.alias)
      const fileMs = (sample.samples.length / sample.sampleRate) * 1000
      const cutoffMs = entry.cutoffMs
      const playEndMs = cutoffMs < 0 ? entry.offsetMs + -cutoffMs : fileMs - cutoffMs
      const record = {
        file: absolute,
        samples: sample.samples,
        sampleRate: sample.sampleRate,
        offsetMs: entry.offsetMs,
        cutoffMs,
        preutteranceMs: entry.preutteranceMs,
        overlapMs: entry.overlapMs,
        consonantMs: entry.consonantMs,
        alias: entry.alias,
        otoFile: otoPath,
        kind: aliasInfo.kind,
        name: aliasInfo.name,
        pitch: aliasInfo.pitch,
        pitchHz: aliasInfo.pitchHz,
        playEndMs,
        f0Hz: 0
      }
      if (!syllables.has(entry.alias)) syllables.set(entry.alias, record)
      if (aliasInfo.name !== '') {
        if (!parts.has(aliasInfo.name)) parts.set(aliasInfo.name, { onset: [], sustain: [], release: [], other: [] })
        const bucket = parts.get(aliasInfo.name)
        const list = bucket[aliasInfo.kind] ?? bucket.other
        list.push(record)
      }
    }
  }

  if (syllables.size === 0) {
    throw new Error(
      `loadVoicebank: parsed ${entries} oto.ini entries but found no audio next to them (looked under "${root}")`
    )
  }

  const sampleRate = rateWeight > 0 ? Math.round(rateTotal / rateWeight) : VOICE_SAMPLE_RATE
  const names = [...new Set([...syllables.values()].map((record) => record.name))].filter((name) => name !== '').sort()
  // `decoded` also remembers the paths it failed to open, so count what actually
  // produced audio instead of reporting the number of references.
  let files = 0
  for (const sample of decoded.values()) if (sample !== null) files += 1
  return {
    syllables,
    meta: {
      dir: root,
      otoFiles,
      entries,
      syllables: syllables.size,
      files,
      missingFiles: decoded.size - files,
      missingEntries,
      sampleRate,
      durationSeconds: durationFrames / sampleRate,
      sections,
      names,
      parts
    }
  }
}

/* ---- sample preparation ---- */

/**
 * Extract the playable region of one oto entry as a frame range.
 * @param {object} record - syllable record from {@link loadVoicebank}.
 * @returns {{ start: number, end: number }} frame range in the file's buffer.
 */
function sliceRange (record) {
  const rate = record.sampleRate
  const total = record.samples.length
  const start = clamp(Math.round((record.offsetMs / 1000) * rate), 0, total)
  const minimum = Math.round((MIN_SLICE_MS / 1000) * rate)
  const otoEnd = record.cutoffMs < 0
    ? start + Math.round((-record.cutoffMs / 1000) * rate)
    : Math.round((record.playEndMs / 1000) * rate)
  const end = clamp(Math.max(otoEnd, Math.min(total, start + minimum)), start + 1, total)
  return { start, end }
}

/**
 * Median of a numeric array (sorts a copy, so callers keep their order).
 * @param {number[]} values - numbers.
 * @returns {number} median, or 0 for an empty array.
 */
function median (values) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/** Interval in cents between two frequencies. */
function centsBetween (a, b) {
  if (!(a > 0) || !(b > 0)) return Infinity
  return Math.abs(1200 * Math.log2(a / b))
}

/**
 * Learn a syllable's recorded pitch and its steadiest stretch.
 *
 * Voicebanks are sung by people: a normal `a` take scoops into the note and only
 * settles afterwards. Taking a plain median over the whole take therefore both
 * mis-reads the pitch and, worse, loops the scoop. This walks the take in short
 * frames, finds the longest run that stays within ±40 cents of the robust median,
 * and reports that run as the note's pitch and as the only region worth looping.
 *
 * Results are memoised on the record, so repeated notes reuse one measurement.
 * @param {object} record - syllable record from {@link loadVoicebank}.
 * @returns {object} the same record, with f0Hz/steadyStartFrame/steadyEndFrame set.
 */
function analyseRecord (record) {
  if (record.analysed) return record
  record.analysed = true
  const range = sliceRange(record)
  const rate = record.sampleRate
  const vowelStart = Math.min(range.end - 1, range.start + Math.round((record.preutteranceMs / 1000) * rate))
  const frameFrames = 2048
  const hop = 1024
  const frames = []
  for (let at = vowelStart; at + frameFrames <= range.end; at += hop) {
    const measured = measureF0(record.samples, rate, at, frameFrames)
    if (measured.f0Hz > 0 && measured.confidence >= 0.55) frames.push({ at, f0Hz: measured.f0Hz })
  }
  record.f0Confidence = 0
  record.steadyStartFrame = vowelStart
  record.steadyEndFrame = range.end
  record.f0Hz = record.pitchHz
  if (frames.length === 0) return record

  const coarse = median(frames.map((frame) => frame.f0Hz))
  const close = frames.filter((frame) => centsBetween(frame.f0Hz, coarse) <= 70)
  const settled = median((close.length > 0 ? close : frames).map((frame) => frame.f0Hz))

  // Longest consecutive run inside ±40 cents of the settled pitch.
  let runStart = -1
  let bestRun = null
  for (let i = 0; i < frames.length; i += 1) {
    const inside = centsBetween(frames[i].f0Hz, settled) <= 40
    if (inside && runStart < 0) runStart = i
    const isLast = i === frames.length - 1
    if (runStart >= 0 && (!inside || isLast)) {
      const end = inside && isLast ? i : i - 1
      if (end >= runStart && (bestRun === null || end - runStart > bestRun.end - bestRun.start)) {
        bestRun = { start: runStart, end }
      }
      runStart = -1
    }
  }

  if (bestRun !== null && bestRun.end > bestRun.start) {
    const runFrames = frames.slice(bestRun.start, bestRun.end + 1)
    record.f0Hz = median(runFrames.map((frame) => frame.f0Hz))
    record.steadyStartFrame = runFrames[0].at
    record.steadyEndFrame = Math.min(range.end, runFrames[runFrames.length - 1].at + frameFrames)
    record.f0Confidence = 1
  } else {
    record.f0Hz = settled
  }
  if (!(record.f0Hz > 0)) record.f0Hz = record.pitchHz
  return record
}

/**
 * Recorded pitch of a syllable in Hz (0 when unvoiced), memoised per record.
 * @param {object} record - syllable record.
 * @returns {number} Hz.
 */
function recordF0 (record) {
  return analyseRecord(record).f0Hz
}

/**
 * Linear-interpolating resample of a frame range.
 * `step` > 1 reads faster: shorter and higher — that is the pitch shift, and it
 * also converts the bank's rate to the output rate in the same pass.
 * @param {Float32Array} samples - source buffer.
 * @param {number} start - first source frame.
 * @param {number} end - exclusive source frame.
 * @param {number} step - source frames per output frame.
 * @returns {Float32Array} resampled frames.
 */
function resampleRange (samples, start, end, step) {
  const span = Math.max(1, end - start)
  const length = Math.max(1, Math.floor(span / step))
  const out = new Float32Array(length)
  if (Math.abs(step - 1) < 1e-9) {
    out.set(samples.subarray(start, start + length))
    return out
  }
  for (let i = 0; i < length; i += 1) {
    const at = start + i * step
    const index = Math.floor(at)
    const fraction = at - index
    const a = samples[clamp(index, 0, samples.length - 1)]
    const b = samples[clamp(index + 1, 0, samples.length - 1)]
    out[i] = a + (b - a) * fraction
  }
  return out
}

/**
 * Write one note's samples: the recorded region once, then a crossfade loop.
 *
 * The loop body holds an exact whole number of pitch periods and its last `fade`
 * frames are a linear crossfade onto the material just *before* the loop start,
 * so the wrap lands on the loop head with matching phase. Only the wrap needs
 * that treatment: the join between the natural copy and the loop is continuous
 * by construction because the loop starts exactly where the copy stopped.
 *
 * @param {number} frameCount - how many frames the note needs.
 * @param {Float32Array} slice - pitch-shifted region (consonant + vowel).
 * @param {{ start: number, length: number, fade?: number }|undefined} loop - loop body.
 * @returns {{ buffer: Float32Array, looped: boolean }}
 */
function buildNoteBuffer (frameCount, slice, loop) {
  const buffer = new Float32Array(frameCount)
  if (!loop) {
    buffer.set(slice.subarray(0, Math.min(slice.length, frameCount)), 0)
    return { buffer, looped: false }
  }
  const anchor = clamp(Math.round(loop.start), 0, Math.max(0, slice.length - 1))
  const body = Math.max(2, Math.round(loop.length))
  const fade = clamp(Math.round(loop.fade ?? 1), 1, Math.max(1, Math.floor(body / 3)))
  buffer.set(slice.subarray(0, Math.min(anchor, slice.length, frameCount)), 0)
  for (let at = anchor; at < frameCount; at += 1) {
    const j = (at - anchor) % body
    let value = slice[anchor + j] ?? 0
    if (j >= body - fade) {
      const t = (j - (body - fade)) / fade
      const head = slice[anchor - fade + (j - (body - fade))] ?? value
      value = value * (1 - t) + head * t
    }
    buffer[at] = value
  }
  return { buffer, looped: true }
}

/* ---- synthesis ---- */

/**
 * Pick the recorded take whose pitch is nearest the target note.
 * @param {object} bank - result of {@link loadVoicebank}.
 * @param {string} name - syllable name, e.g. `a`, `ka`.
 * @param {number} midi - target note.
 * @returns {object|null} syllable record.
 */
function selectTake (bank, name, midi) {
  const key = String(name).trim()
  const direct = bank.syllables.get(key)
  const candidates = []
  if (direct) candidates.push(direct)
  const known = bank.meta.parts.get(key)
  if (known) candidates.push(...known.onset, ...known.other, ...known.sustain)
  if (candidates.length === 0) {
    // Last resort: prefix match, so `a` falls back to `a+`/`a R` of a bank that
    // only ships transition aliases.
    for (const [alias, record] of bank.syllables) {
      if (record.name === key) candidates.push(record)
      else if (record.name.startsWith(key)) candidates.push(record)
      if (candidates.length > 8) break
      void alias
    }
  }
  if (candidates.length === 0) return null

  const targetHz = midiToHz(midi)
  // Pre-filter by the alias pitch label so we analyse a handful of takes rather
  // than every alias of the syllable. The labels of real banks are often tens of
  // cents off, so this only orders the work: the choice still uses measured pitch.
  const ordered = candidates
    .map((record, order) => ({ record, order }))
    .sort((a, b) => {
      const distance = (entry) => (entry.record.pitchHz > 0 ? Math.abs(Math.log2(entry.record.pitchHz / targetHz)) : 0.5)
      return distance(a) - distance(b) || a.order - b.order
    })
    .slice(0, 4)
    .map((entry) => entry.record)

  let best = null
  let bestScore = Infinity
  for (const record of ordered) {
    const f0 = recordF0(record)
    const score = f0 > 0 ? Math.abs(Math.log2(f0 / targetHz)) : 4
    // Prefer onset takes: only they carry the consonant. 36 cents of bias is
    // enough to win a near-tie without overriding a clearly better take.
    const bias = record.kind === 'onset' ? 0 : 0.03
    if (score + bias < bestScore) {
      best = record
      bestScore = score + bias
    }
  }
  return best
}

/**
 * Render notes with a recorded voicebank.
 *
 * Each note uses the nearest recorded take, so the pitch correction stays within
 * a couple of semitones. Preutterance is aligned to the note onset (a consonant
 * therefore starts slightly *before* the beat), notes longer than the recording
 * continue with a phase-aligned loop of the recorded sustain, consecutive notes
 * crossfade, and the result is DC-blocked and normalised to -1 dBFS.
 *
 * @param {{
 *   notes: Array<{ syllable?: string, note?: string, midi?: number, start?: number,
 *                  duration?: number, durationSeconds?: number, velocity?: number }>,
 *   syllables?: string[]|string, bpm?: number, driftCents?: number
 * }} plan - `duration` is in beats unless `durationSeconds` is given; `start`
 *   (seconds) is optional and defaults to "right after the previous note".
 * @param {{
 *   bank: object, seed?: number, sampleRate?: number,
 *   attackSeconds?: number, releaseSeconds?: number, crossfadeSeconds?: number,
 *   driftCents?: number, peakDbfs?: number
 * }} options - `bank` is required; `seed` drives deterministic micro-drift.
 * @returns {{
 *   samples: Float32Array, sampleRate: number,
 *   syllableTimings: Array<{ index: number, syllable: string, alias: string|null,
 *     noteName: string, midi: number, startSeconds: number, durationSeconds: number,
 *     sourceF0Hz: number, ratio: number, shiftCents: number, voiced: boolean,
 *     looped: boolean, fallback: boolean }>
 * }}
 */
export function renderVoicebank (plan, options = {}) {
  const bank = options.bank
  if (!bank || !(bank.syllables instanceof Map)) {
    throw new Error('renderVoicebank: options.bank must come from loadVoicebank()')
  }
  if (!plan || !Array.isArray(plan.notes) || plan.notes.length === 0) {
    throw new Error('renderVoicebank: plan.notes must be a non-empty array')
  }

  const sampleRate = Math.round(options.sampleRate ?? VOICE_SAMPLE_RATE)
  const bpm = Number.isFinite(plan.bpm) ? plan.bpm : 120
  const beatSeconds = 60 / bpm
  const attack = Math.max(0, Math.round((options.attackSeconds ?? DEFAULT_ATTACK_SECONDS) * sampleRate))
  const release = Math.max(1, Math.round((options.releaseSeconds ?? DEFAULT_RELEASE_SECONDS) * sampleRate))
  const crossfade = Math.max(1, Math.round((options.crossfadeSeconds ?? DEFAULT_CROSSFADE_SECONDS) * sampleRate))
  const driftCents = Number.isFinite(options.driftCents) ? options.driftCents : (Number.isFinite(plan.driftCents) ? plan.driftCents : 0)
  const rand = makeRng(Number.isFinite(options.seed) ? options.seed : 1)

  const syllableList = Array.isArray(plan.syllables)
    ? plan.syllables
    : plan.syllables !== undefined
      ? [plan.syllables]
      : ['a']

  // Normalise the plan into absolute seconds.
  const notes = []
  let cursor = 0
  for (let index = 0; index < plan.notes.length; index += 1) {
    const note = plan.notes[index]
    const midi = Number.isFinite(note.midi) ? note.midi : noteToMidi(note.note ?? 'C4')
    const durationSeconds = Number.isFinite(note.durationSeconds)
      ? note.durationSeconds
      : (Number.isFinite(note.duration) ? note.duration : 1) * beatSeconds
    const startSeconds = Number.isFinite(note.start) ? note.start : cursor
    notes.push({
      midi,
      startSeconds,
      durationSeconds: Math.max(0.02, durationSeconds),
      syllable: String(note.syllable ?? syllableList[index % syllableList.length] ?? 'a'),
      velocity: clamp(Number.isFinite(note.velocity) ? note.velocity : 0.9, 0.05, 1),
      // Kept for the timings report; the caller may also have named the note.
      noteName: note.note === undefined ? '' : String(note.note)
    })
    cursor = startSeconds + durationSeconds
  }

  const framesOf = (seconds) => Math.round(seconds * sampleRate)

  // Pass 1: choose takes, measure, pitch-shift, and fix every absolute position
  // so a neighbour's consonant overlap can be honoured in pass 2.
  const prepared = []
  let earliest = 0
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index]
    const noteStartFrame = framesOf(note.startSeconds)
    const noteFrames = Math.max(32, framesOf(note.durationSeconds))
    const record = selectTake(bank, note.syllable, note.midi)
    if (record === null) {
      prepared.push({ note, index, record: null, noteStartFrame, noteFrames, placeFrame: noteStartFrame })
      earliest = Math.min(earliest, noteStartFrame)
      continue
    }
    const sourceF0 = recordF0(record)
    const drift = driftCents > 0 ? (rand() * 2 - 1) * driftCents : 0
    const targetHz = midiToHz(note.midi + drift / 100)
    const range = sliceRange(record)

    // Choose the loop body in *source* frames, as a whole number of the loop
    // region's own pitch periods. Shifting both by the same ratio keeps the
    // period count intact, so the sustain stays exactly in tune instead of
    // drifting by the fraction of a period that a hard splice would force.
    const marginSrc = Math.round((LOOP_ATTACK_MS / 1000) * record.sampleRate)
    const bodyStartSrc = clamp(record.steadyStartFrame + marginSrc, range.start, Math.max(range.start, record.steadyEndFrame - 1))
    const budgetSrc = Math.min(
      Math.max(0, record.steadyEndFrame - bodyStartSrc),
      Math.round((LOOP_MAX_MS / 1000) * record.sampleRate)
    )
    const coarseF0 = estimateF0(record.samples, record.sampleRate, bodyStartSrc, record.steadyEndFrame).f0Hz || sourceF0
    const coarsePeriod = coarseF0 > 0 ? record.sampleRate / coarseF0 : 0
    const coarseCount = coarsePeriod > 0 ? Math.floor(budgetSrc / coarsePeriod) : 0
    const bodyEndSrc = coarseCount >= 3 ? bodyStartSrc + Math.round(coarseCount * coarsePeriod) : bodyStartSrc
    // Re-measure on exactly the frames we will repeat: tuning to the whole steady
    // stretch would leave the loop a few cents off the sounding pitch.
    const bodyF0 = coarseCount >= 3
      ? estimateF0(record.samples, record.sampleRate, bodyStartSrc, bodyEndSrc).f0Hz || coarseF0
      : coarseF0
    const pitchF0 = bodyF0 > 0 ? bodyF0 : targetHz
    const ratio = clamp(targetHz / pitchF0, 0.25, 4)
    const step = ratio * (record.sampleRate / sampleRate)
    const slice = resampleRange(record.samples, range.start, range.end, step)
    const periodSrc = record.sampleRate / pitchF0
    const periods = Math.floor((bodyEndSrc - bodyStartSrc) / periodSrc)
    const loop = periods >= 3
      ? {
          start: Math.round((bodyStartSrc - range.start) / step),
          length: Math.max(2, Math.round((periods * periodSrc) / step)),
          fade: Math.max(1, Math.round(periodSrc / step / 2))
        }
      : undefined
    const preOut = Math.max(0, Math.round((record.preutteranceMs / 1000) * sampleRate / step))
    const placeFrame = noteStartFrame - preOut
    earliest = Math.min(earliest, placeFrame)
    prepared.push({
      note,
      index,
      record,
      noteStartFrame,
      noteFrames,
      placeFrame,
      preFrames: preOut,
      sourceF0,
      ratio,
      slice,
      loop
    })
  }

  const leadIn = Math.max(0, -earliest)

  // Pass 2: build each note's buffer and gain curve, then mix.
  const rendered = []
  const syllableTimings = []
  let latest = 0
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]
    const note = item.note
    if (item.record === null) {
      // Unknown syllable: keep the timeline honest with a silent placeholder so
      // the caller sees the hole in syllableTimings instead of a shifted phrase.
      syllableTimings.push({
        index,
        syllable: note.syllable,
        alias: null,
        noteName: note.noteName,
        midi: note.midi,
        startSeconds: (item.noteStartFrame + leadIn) / sampleRate,
        durationSeconds: note.durationSeconds,
        sourceF0Hz: 0,
        ratio: 1,
        shiftCents: 0,
        voiced: false,
        looped: false,
        fallback: true
      })
      latest = Math.max(latest, item.noteStartFrame + item.noteFrames + leadIn)
      continue
    }

    const next = prepared[index + 1]
    const noteEndFrame = item.noteStartFrame + item.noteFrames
    // A following note whose consonant starts before this note ends makes the
    // boundary legato: this note fades out across that consonant instead of
    // stopping dead, which is what the preutterance curve is for.
    const nextPlace = next === undefined ? Number.POSITIVE_INFINITY : next.noteStartFrame - (next.preFrames ?? 0)
    const legato = next !== undefined && nextPlace < noteEndFrame + Math.round(0.001 * sampleRate)
    let releaseStart
    let bufferFrames
    if (legato) {
      releaseStart = clamp(nextPlace - item.placeFrame, 0, Math.max(0, noteEndFrame + crossfade - item.placeFrame))
      bufferFrames = Math.max(32, noteEndFrame - item.placeFrame)
      if (releaseStart > bufferFrames - crossfade) releaseStart = Math.max(0, bufferFrames - crossfade)
    } else {
      releaseStart = noteEndFrame - item.placeFrame
      bufferFrames = Math.max(32, releaseStart + release)
    }
    const built = buildNoteBuffer(bufferFrames, item.slice, item.loop)

    const gain = new Float32Array(bufferFrames).fill(1)
    for (let i = 0; i < Math.min(attack, bufferFrames); i += 1) gain[i] = i / attack
    const rampFrames = Math.max(1, bufferFrames - releaseStart)
    for (let i = Math.max(0, releaseStart); i < bufferFrames; i += 1) {
      const t = clamp((i - releaseStart) / rampFrames, 0, 1)
      gain[i] *= Math.cos((t * Math.PI) / 2)
    }
    for (let i = 0; i < bufferFrames; i += 1) gain[i] *= note.velocity

    rendered.push({ buffer: built.buffer, gain, placeFrame: item.placeFrame + leadIn })
    latest = Math.max(latest, item.placeFrame + leadIn + bufferFrames)
    syllableTimings.push({
      index,
      syllable: note.syllable,
      alias: item.record.alias,
      noteName: note.noteName,
      midi: note.midi,
      startSeconds: (item.placeFrame + item.preFrames + leadIn) / sampleRate,
      durationSeconds: note.durationSeconds,
      sourceF0Hz: Number(item.sourceF0.toFixed(3)),
      ratio: Number(item.ratio.toFixed(6)),
      shiftCents: item.sourceF0 > 0 ? Number((1200 * Math.log2(item.ratio)).toFixed(2)) : 0,
      voiced: item.sourceF0 > 0,
      looped: built.looped,
      fallback: false
    })
  }

  const totalFrames = Math.max(1, latest)
  const mix = new Float32Array(totalFrames)
  for (const item of rendered) {
    for (let i = 0; i < item.buffer.length; i += 1) {
      const at = item.placeFrame + i
      if (at >= totalFrames) break
      mix[at] += item.buffer[i] * item.gain[i]
    }
  }

  // Gentle DC removal then peak normalisation; no limiter, so a loud voicebank
  // is allowed to reveal its own dynamics instead of being squashed.
  let mean = 0
  for (let i = 0; i < mix.length; i += 1) mean += mix[i]
  mean /= mix.length
  for (let i = 0; i < mix.length; i += 1) mix[i] -= mean
  let peak = 0
  for (let i = 0; i < mix.length; i += 1) peak = Math.max(peak, Math.abs(mix[i]))
  const ceiling = clamp(Math.pow(10, (options.peakDbfs ?? -1) / 20), 0, 1)
  if (peak > 0) {
    const scale = ceiling / peak
    for (let i = 0; i < mix.length; i += 1) mix[i] *= scale
  }

  return { samples: mix, sampleRate, syllableTimings }
}
