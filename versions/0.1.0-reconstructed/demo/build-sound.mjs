// build-sound.mjs —— 把 __audio:<name>__ 占位符替换成内联的 base64 WAV。
// 用法: node build-sound.mjs <scene.html> <out.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const source = process.argv[2]
const target = process.argv[3] ?? source.replace(/\.html$/, '.bundle.html')
const html = readFileSync(source, 'utf8')
const dir = dirname(resolve(source))
const missing = new Set()

const out = html.replace(/__audio:([a-z0-9_-]+)__/gi, (_, name) => {
  try {
    const bytes = readFileSync(join(dir, 'assets', 'audio', `${name}.wav`))
    return `data:audio/wav;base64,${bytes.toString('base64')}`
  } catch {
    missing.add(name)
    return ''
  }
})

if (missing.size > 0) {
  console.error(`missing audio: ${[...missing].join(', ')}`)
  process.exit(1)
}
writeFileSync(target, out)
console.log(`${target} (${(Buffer.byteLength(out) / 1024).toFixed(0)} KB)`)
