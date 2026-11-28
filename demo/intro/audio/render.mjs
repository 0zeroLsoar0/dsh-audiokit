#!/usr/bin/env node
// Reproducible soundtrack for demo/intro (16.0 s, 120 BPM).
// Every sound is produced by the dsh-audio-lab engines this intro introduces:
// compose.js (bed), audio.js (impact, ticks), design.js (end).
// Fixed seeds, fixed sample rate, fixed peak targets -> byte-identical rebuilds.
//
// The 0.6.0 intro has no voice scene: the synthetic-singing tool (and its voice
// bank) was removed from the plugin, so this soundtrack stays instrumental.
//
// run: <node.exe> demo/intro/audio/render.mjs   (writes .wav files + manifest.json here)

import { writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = 'file:///F:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-audio-lab/plugin/lib/'

const { composeScore, renderScore } = await import(LIB + 'compose.js')
const { renderPreset, renderPattern, finalize, measure } = await import(LIB + 'audio.js')
const { designSound } = await import(LIB + 'design.js')
const { normalizePeak } = await import(LIB + 'dsp.js')
const { encodeWav, decodeWav } = await import(LIB + 'wav.js')

const SR = 22050
const DURATION = 16
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Normalise a float buffer to an exact peak target (dBFS), verify by measurement. */
function peakTo(samples, dbfs) {
  normalizePeak(samples, dbfs)
  return measure(samples, SR).peakDbfs
}

/** Write mono 16-bit PCM, return what actually landed on disk. */
function write(name, samples, targetDb) {
  const bytes = encodeWav([samples], SR)
  writeFileSync(join(HERE, `${name}.wav`), bytes)
  const decoded = decodeWav(bytes)
  const ch = Array.isArray(decoded.channels) ? decoded.channels[0] : decoded.channelData?.[0] ?? decoded.samples
  const m = measure(ch, decoded.sampleRate ?? SR)
  return {
    name,
    bytes: statSync(join(HERE, `${name}.wav`)).size,
    durationSeconds: +(ch.length / (decoded.sampleRate ?? SR)).toFixed(3),
    peakDbfs: +m.peakDbfs.toFixed(2),
    targetDb,
    sha256: sha256(bytes)
  }
}

/* 1. bed.wav — 8 cinematic bars @120 BPM, trimmed to exactly 16.000 s, -6 dBFS */
const score = composeScore({ genre: 'cinematic', bars: 8, bpm: 120, seed: 7, intensity: 0.45 })
const bedRender = renderScore(score, { sampleRate: SR })
const bedFrames = Math.round(DURATION * SR) // 352800
const bed = Float32Array.from(bedRender.samples.subarray(0, bedFrames))
const fadeFrames = Math.round(0.25 * SR) // compose tail is cut: de-click the cut
for (let i = 0; i < fadeFrames; i += 1) bed[bedFrames - 1 - i] *= i / fadeFrames
const bedPeak = peakTo(bed, -6)

/* 2. impact.wav — the landing hit at 2.5 s, 1.0 s, -1 dBFS */
const impactSrc = renderPreset({ preset: 'impact', duration: 1.0, seed: 3, sampleRate: SR, params: { weight: 0.9, hardness: 0.7 } })
const impact = Float32Array.from(impactSrc.samples)
finalize(impact, SR, -1) // dc-block + normalise + soft limit, as the tool path does
const impactPeak = peakTo(impact, -1)

/* 3. ticks.wav — 4.0 s tick train for the 6.0-10.0 s vocabulary scene, -8 dBFS */
const ticksSrc = renderPattern({ preset: 'tick', kind: 'train', to: 4, every: 0.125, accentEvery: 4, jitter: 0.05, seed: 5, sampleRate: SR })
const ticks = Float32Array.from(ticksSrc.samples)
const ticksPeak = peakTo(ticks, -8)

/* 4. end.wav — end card at 13.5 s, ui-success design at 22050 Hz, -3 dBFS */
const endSrc = designSound({ recipe: 'ui-success', sampleRate: SR })
const end = Float32Array.from(endSrc.samples)
const endPeak = peakTo(end, -3)

const written = [
  write('bed', bed, -6),
  write('impact', impact, -1),
  write('ticks', ticks, -8),
  write('end', end, -3)
]
const actual = { bed: bedPeak, impact: impactPeak, ticks: ticksPeak, end: endPeak }
for (const w of written) {
  const delta = Math.abs(w.peakDbfs - actual[w.name])
  if (delta > 0.05) throw new Error(`${w.name}: encode changed the peak by ${delta.toFixed(2)} dB`)
}

/* 5. manifest.json — cue times in animation seconds, matching spec.json */
const cues = [
  { name: 'bed', file: 'bed.wav', at: 0, gainDb: 0, loop: true },
  { name: 'impact', file: 'impact.wav', at: 2.5, gainDb: 0, loop: false },
  { name: 'ticks', file: 'ticks.wav', at: 6.0, gainDb: 0, loop: false },
  { name: 'end', file: 'end.wav', at: 13.5, gainDb: 0, loop: false }
]
const manifest = {
  sampleRate: SR,
  duration: DURATION,
  cues,
  files: Object.fromEntries(written.map((w) => [w.name, {
    bytes: w.bytes,
    durationSeconds: w.durationSeconds,
    peakDbfs: w.peakDbfs
  }]))
}
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const totalBytes = written.reduce((sum, w) => sum + w.bytes, 0)
console.log('name      bytes   dur(s)  peak dBFS  target  sha256[:16]')
for (const w of written) {
  console.log(`${w.name.padEnd(8)} ${String(w.bytes).padStart(7)}  ${String(w.durationSeconds).padStart(6)}  ${String(w.peakDbfs).padStart(8)}  ${String(w.targetDb).padStart(6)}  ${w.sha256.slice(0, 16)}`)
}
console.log(`total audio bytes: ${totalBytes} (${(totalBytes / 1024).toFixed(0)} KiB, budget ~1229 KiB)`)
console.log(`manifest sha256: ${sha256(Buffer.from(JSON.stringify(manifest)))}`)
