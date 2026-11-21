// verify-html.mjs —— 校验交付页：data URI 全部可解码、时长与 cue 对得上。
// 用法: node verify-html.mjs <final.html>
import { readFileSync } from 'node:fs'
import { decodeWav } from '../lib/wav.js'

const path = process.argv[2]
const html = readFileSync(path, 'utf8')

const json = /<script type="application\/json" id="dsh-audio">([\s\S]*?)<\/script>/.exec(html)
if (json === null) throw new Error('no dsh-audio data block')
const data = JSON.parse(json[1])

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures += 1
  console.log(`  FAIL ${label} ${detail}`)
}

console.log(`${path}\n${data.cues.length} cues, declared duration ${data.duration}s\n`)

for (const cue of data.cues) {
  const match = /^data:audio\/wav;base64,(.+)$/s.exec(cue.src)
  check(`${cue.cue} is inline base64`, match !== null)
  if (match === null) continue
  const wav = decodeWav(Buffer.from(match[1], 'base64'))
  const shape = `${cue.at.toFixed(2)}s  +${wav.durationSeconds.toFixed(2)}s  ${wav.sampleRate} Hz  ${(wav.channels[0].length * 2 / 1024).toFixed(0)} KB`
  console.log(`  ${cue.cue.padEnd(8)} ${shape}${cue.loop ? '  (loop)' : ''}`)
  check(`${cue.cue} fits inside the timeline`, cue.at + wav.durationSeconds <= data.duration + 0.6,
    `ends at ${(cue.at + wav.durationSeconds).toFixed(2)}s`)
  check(`${cue.cue} non-silent`, wav.channels[0].some((v) => Math.abs(v) > 0.001))
  if (!cue.loop) check(`${cue.cue} starts before the end`, cue.at < data.duration)
}

const leftovers = (html.match(/__audio:/g) ?? []).length
check('no unresolved placeholders', leftovers === 0, `${leftovers} left`)
const size = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`\nsize ${size} KB`)
console.log(failures === 0 ? 'OK: page is self-contained and every cue decodes' : `FAILED: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
