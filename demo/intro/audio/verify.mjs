// Independent verification of demo/intro/audio against spec.json cues.
// Decodes every file with the plugin's own wav.js; prints measured numbers.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { decodeWav } = await import('file:///F:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-audio-lab/plugin/lib/wav.js')
const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
const expect = { bed: 16.0, impact: 1.0, ticks: 4.0, end: 0.8 }
const targetPeak = { bed: -6, impact: -1, ticks: -8, end: -3 }

let failures = 0
let totalBytes = 0
for (const cue of manifest.cues) {
  const path = join(HERE, cue.file)
  if (!existsSync(path)) { console.log(`MISSING ${cue.file}`); failures += 1; continue }
  const bytes = statSync(path).size
  totalBytes += bytes
  const dec = decodeWav(readFileSync(path))
  const ch = dec.channels[0]
  const sr = dec.sampleRate
  const dur = ch.length / sr
  let peak = 0
  let clipped = 0
  for (const v of ch) {
    const a = Math.abs(v)
    if (a > peak) peak = a
    if (a >= 1) clipped += 1
  }
  const peakDb = 20 * Math.log10(peak)
  const durOk = Math.abs(dur - expect[cue.name]) <= 0.03
  const peakOk = Math.abs(peakDb - targetPeak[cue.name]) <= 1
  const claim = manifest.files[cue.name]
  const claimOk = claim && claim.bytes === bytes && Math.abs(claim.durationSeconds - dur) < 0.002 && Math.abs(claim.peakDbfs - peakDb) < 0.1
  const ok = durOk && peakOk && clipped === 0 && claimOk && sr === manifest.sampleRate
  if (!ok) failures += 1
  console.log(`${cue.name.padEnd(7)} sr=${sr} dur=${dur.toFixed(4)}(want ${expect[cue.name]}) peak=${peakDb.toFixed(2)}dBFS(want ${targetPeak[cue.name]}) clipped=${clipped} manifestClaim=${claimOk ? 'ok' : 'MISMATCH'} ${ok ? 'PASS' : 'FAIL'}`)
}
const total = 16 * manifest.sampleRate * 2 + 4 * 44
console.log(`sampleRate=${manifest.sampleRate} totalAudioBytes=${totalBytes} (${(totalBytes / 1024).toFixed(0)} KiB; 16 s mono16 = ${(total / 1024).toFixed(0)} KiB; budget 1229 KiB)`)
console.log(`cue times: ${manifest.cues.map((c) => `${c.name}@${c.at}${c.loop ? ' loop' : ''}`).join(', ')}`)
console.log(failures === 0 ? 'VERIFY: ALL PASS' : `VERIFY: ${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
