/**
 * Sing a note script with a recorded UTAU-style voicebank, from a terminal.
 *
 *   node tools/sing-bank.mjs --bank <dir> --notes "C4:1 E4:1 G4:2" --out out.wav
 *
 * Options:
 *   --bank <dir>          voicebank directory containing oto.ini (required)
 *   --notes "<script>"    notes as `note[:beats]`, whitespace separated (required)
 *   --out <file.wav>      output path (default: sing-<hash>.wav in the cwd)
 *   --syllables "a,ka"    syllables cycled across the notes (default: a)
 *   --bpm <n>             tempo for beat lengths (default 120)
 *   --seed <n>            deterministic micro-drift seed (default 1)
 *   --drift-cents <n>     per-note pitch drift, 0 = dead straight (default 4)
 *   --sample-rate <n>     output rate (default 44100)
 *
 * The voicebank is a separate download and is never part of the plugin package;
 * `assets/voicebank/README.md` explains where it comes from and under what terms.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseNoteScript, renderVoicebank, loadVoicebank } from '../lib/voicebank.js'
import { encodeWav } from '../lib/wav.js'

const USAGE = 'usage: node tools/sing-bank.mjs --bank <dir> --notes "C4:1 E4:1 G4:2" --out <wav>'

/** Read `--name value` / `--name=value` pairs. */
function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const split = token.indexOf('=')
    if (split > 0) {
      args[token.slice(2, split)] = token.slice(split + 1)
      continue
    }
    const value = argv[i + 1]
    if (value !== undefined && !value.startsWith('--')) {
      args[token.slice(2)] = value
      i += 1
    } else {
      args[token.slice(2)] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help || args.h) {
  console.log(USAGE)
  process.exit(0)
}
if (typeof args.bank !== 'string' || typeof args.notes !== 'string') {
  console.error(USAGE)
  console.error('  --bank and --notes are required')
  process.exit(2)
}

const sampleRate = Number(args['sample-rate'] ?? 44100)
const bpm = Number(args.bpm ?? 120)
const seed = Number(args.seed ?? 1)
const driftCents = Number(args['drift-cents'] ?? 4)
const syllables = typeof args.syllables === 'string'
  ? args.syllables.split(',').map((name) => name.trim()).filter((name) => name !== '')
  : ['a']

let bank
try {
  bank = loadVoicebank(resolve(args.bank))
} catch (error) {
  console.error(`cannot load voicebank: ${error.message}`)
  process.exit(1)
}

const script = parseNoteScript(args.notes)
const started = Date.now()
const rendered = renderVoicebank(
  { notes: script.map((note) => ({ midi: note.midi, duration: note.beats })), syllables, bpm },
  { bank, seed, driftCents, sampleRate }
)
const bytes = encodeWav([rendered.samples], rendered.sampleRate, { dither: false })
const hash = String(seed) + '-' + String(script.length)
const outPath = args.out === undefined || args.out === true
  ? resolve(process.cwd(), `sing-${hash}.wav`)
  : resolve(String(args.out))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, bytes)

let peak = 0
for (const sample of rendered.samples) peak = Math.max(peak, Math.abs(sample))
const durationSeconds = rendered.samples.length / rendered.sampleRate
const missing = rendered.syllableTimings.filter((timing) => timing.alias === null).map((timing) => timing.syllable)
const shifted = rendered.syllableTimings.filter((timing) => !timing.fallback)
const drift = shifted.length > 0
  ? shifted.reduce((sum, timing) => sum + Math.abs(timing.shiftCents), 0) / shifted.length
  : 0

console.log(
  `${outPath}  ${durationSeconds.toFixed(2)}s  ${script.length} notes  ` +
  `bank ${bank.meta.syllables} takes (${bank.meta.names.filter((n) => !n.endsWith('+') && !n.endsWith(' R')).length} syllables)  ` +
  `mean shift ${drift.toFixed(0)} cents  peak ${(20 * Math.log10(peak || 1)).toFixed(1)} dBFS  ${Date.now() - started} ms` +
  (missing.length > 0 ? `  MISSING syllables: ${missing.join(',')}` : '')
)
