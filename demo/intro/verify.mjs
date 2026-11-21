#!/usr/bin/env node
/**
 * verify.mjs — acceptance checks for demo/intro/index.html (single-file HTML intro).
 *
 * Usage: node demo/intro/verify.mjs [index.html]
 *
 * Prints every measured number. Exits non-zero on any hard failure.
 * Hard failures are printed as "BUG   ..."; soft ones as "WARN  ...".
 *
 * Owned by the verifier only. Never edits the page or the audio.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { decodeWav } from '../../dsh-audio-lab/plugin/lib/wav.js'

const HERE = dirname(fileURLToPath(import.meta.url)) // demo/intro
const PAGE = resolve(process.argv[2] ?? join(HERE, 'index.html'))
const SPEC = join(HERE, 'spec.json')
const MANIFEST = join(HERE, 'audio', 'manifest.json')

const LIMIT_BYTES = 1.2 * 1024 * 1024 // 1.2 MB
const SOFT_BUDGET_BYTES = 900 * 1024 // spec.json requirements.sizeBudgetKB
const EXPECTED_DURATION = 16
const DURATION_TOL = 0.01
const TOOL_NAMES = [
  'audio_synth', 'audio_pattern', 'audio_design', 'audio_compose', 'audio_tts',
  'audio_sing', 'audio_lipsync', 'audio_beats', 'audio_bind', 'audio_convert',
  'audio_stretch', 'audio_probe', 'audio_loudness', 'audio_check', 'audio_regress',
  'audio_mix', 'audio_voices'
]

let hardFailures = 0
let warnings = 0
const bug = (msg) => { hardFailures += 1; console.log(`BUG   ${msg}`) }
const warn = (msg) => { warnings += 1; console.log(`WARN  ${msg}`) }
const ok = (msg) => console.log(`ok    ${msg}`)
const section = (n, title) => console.log(`\n== ${n}. ${title} ==`)

function failExit (msg) {
  bug(msg)
  console.log(`\nRESULT: FAIL (${hardFailures} bug, ${warnings} warn) — no page to check`)
  process.exit(2)
}

// ---------------------------------------------------------------- 1. file
section(1, 'file, UTF-8 and no-network hygiene')
if (!existsSync(PAGE)) failExit(`missing file: ${PAGE}`)
const raw = readFileSync(PAGE)
console.log(`file:       ${PAGE}`)
console.log(`bytes:      ${raw.length} (${(raw.length / 1024).toFixed(1)} KiB)`)
ok('file exists')

let html
try {
  html = new TextDecoder('utf-8', { fatal: true }).decode(raw)
} catch (error) {
  failExit(`page is not valid UTF-8: ${error.message}`)
}
ok('valid UTF-8')

// No network references. The only tolerated http(s) strings are SVG XML namespaces.
const ALLOWED_URLS = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xlink'
]
const allowedHits = []
let httpProbe = html
for (const url of ALLOWED_URLS) {
  const count = httpProbe.split(url).length - 1
  if (count > 0) allowedHits.push(`${url} x${count}`)
  httpProbe = httpProbe.split(url).join(' ')
}
const httpRefs = [...httpProbe.matchAll(/https?:\/\/[^\s"'<>)]*/gi)].map((m) => m[0])
console.log(`http(s) refs outside SVG xmlns: ${httpRefs.length}${allowedHits.length ? ` (allowed xmlns: ${allowedHits.join(', ')})` : ''}`)
if (httpRefs.length > 0) {
  bug(`network URL reference(s): ${[...new Set(httpRefs)].slice(0, 8).join(', ')}`)
} else ok('no http:// or https:// reference outside SVG xmlns')

const placeholders = [
  [...html.matchAll(/__[A-Z][A-Z0-9_]{2,}__/g)].map((m) => m[0]),
  [...html.matchAll(/@[A-Z][A-Z0-9_]{2,}@/g)].map((m) => m[0]),
  [...html.matchAll(/\{\{[A-Z0-9_]{3,}\}\}/g)].map((m) => m[0])
].flat()
console.log(`template leftovers: ${placeholders.length}${placeholders.length ? ` [${[...new Set(placeholders)].slice(0, 6).join(', ')}]` : ''}`)
if (placeholders.length > 0) bug(`unreplaced template token(s): ${[...new Set(placeholders)].join(', ')}`)
else ok('no __PLACEHOLDER__ / @TOKEN@ leftovers')

const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
const externalLinks = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((href) => !href.startsWith('data:') && !href.startsWith('#'))
console.log(`external <script src>: ${externalScripts.length}; external <link href>: ${externalLinks.length}`)
if (externalScripts.length > 0) bug(`external script(s): ${externalScripts.join(', ')}`)
if (externalLinks.length > 0) bug(`external stylesheet/link(s): ${externalLinks.join(', ')}`)
if (externalScripts.length === 0 && externalLinks.length === 0) ok('no external <script src> or <link href>')

// ---------------------------------------------------------------- 2. spec JSON
section(2, 'embedded intro-spec JSON')
let spec = null
let specSource = null
const jsonBlocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
for (const [, attrs, body] of jsonBlocks) {
  const isTypeJson = /type\s*=\s*["']application\/json["']/i.test(attrs)
  const isIdSpec = /\bid\s*=\s*["']intro-spec["']/i.test(attrs)
  if (isTypeJson || isIdSpec) {
    try {
      spec = JSON.parse(body)
      specSource = `block (${isIdSpec ? 'id="intro-spec"' : 'type="application/json"'}${isTypeJson ? ', application/json' : ''}, ${body.length} chars)`
      break
    } catch (error) {
      if (isIdSpec) failExit(`intro-spec JSON does not parse: ${error.message}`)
    }
  }
}
if (!spec) {
  bug('no parseable <script type="application/json" id="intro-spec"> block found')
} else {
  ok(`intro-spec parses from ${specSource}`)
  const duration = Number(spec.duration ?? spec.meta?.duration)
  console.log(`duration:   ${duration} (expected ${EXPECTED_DURATION} ±${DURATION_TOL})`)
  if (!Number.isFinite(duration)) bug('duration is not a number')
  else if (Math.abs(duration - EXPECTED_DURATION) > DURATION_TOL) {
    bug(`duration ${duration} differs from ${EXPECTED_DURATION} by ${Math.abs(duration - EXPECTED_DURATION).toFixed(4)} > ${DURATION_TOL}`)
  } else ok(`duration ${duration} within tolerance`)

  const scenes = Array.isArray(spec.scenes) ? spec.scenes : []
  console.log(`scenes:     ${scenes.length} (expected 5)`)
  if (scenes.length !== 5) bug(`expected 5 scenes, found ${scenes.length}`)
  let contiguous = true
  if (scenes.length === 0) {
    bug('scenes array is empty or missing')
  } else {
    if (Math.abs(Number(scenes[0].from) - 0) > 1e-6) {
      contiguous = false
      bug(`first scene starts at ${scenes[0].from}, expected 0`)
    }
    for (let i = 0; i < scenes.length; i += 1) {
      const s = scenes[i]
      const from = Number(s.from)
      const to = Number(s.to)
      console.log(`  [${i}] ${String(s.id).padEnd(12)} ${from.toFixed(2)} -> ${to.toFixed(2)}  (${(to - from).toFixed(2)}s)`)
      if (!Number.isFinite(from) || !Number.isFinite(to)) { bug(`scene ${i} has non-numeric from/to`); contiguous = false; continue }
      if (from >= to) { bug(`scene ${i} from ${from} >= to ${to}`); contiguous = false }
      if (from < -1e-6 || to > duration + 1e-6) { bug(`scene ${i} [${from}, ${to}] outside duration 0..${duration}`); contiguous = false }
      if (i > 0) {
        const prevTo = Number(scenes[i - 1].to)
        if (Math.abs(from - prevTo) > 1e-3) {
          bug(`scene ${i} starts at ${from}, previous scene ends at ${prevTo} (gap/overlap ${(from - prevTo).toFixed(4)}s)`)
          contiguous = false
        }
      }
      const headline = typeof s.headline === 'string' ? s.headline.trim() : ''
      if (headline === '') warn(`scene ${i} (${s.id}) has an empty headline`)
    }
    if (Math.abs(Number(scenes[scenes.length - 1].to) - duration) > 1e-3) {
      bug(`last scene ends at ${scenes[scenes.length - 1].to}, expected duration ${duration}`)
      contiguous = false
    }
    if (contiguous && scenes.length === 5) ok('5 scenes are contiguous and inside duration')
    else if (!contiguous) console.log('BUG   scene timeline is not contiguous / not covering 0..duration')
  }
}

// ---------------------------------------------------------------- 3. inline audio
section(3, 'inline base64 audio (decoded with dsh-audio-lab decodeWav)')
const audioUriRe = /data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi
let clips = []
let audioMode = 'data-uri'
for (const match of html.matchAll(audioUriRe)) {
  const [whole, mime, b64] = match
  const index = match.index ?? 0
  // Try to recover a human name: nearest data-name/data-cue/data-clip attribute, else manifest by duration.
  const before = html.slice(Math.max(0, index - 600), index)
  const attr = [...before.matchAll(/data-(?:name|cue|clip|sound|id)\s*=\s*["']([^"']+)["']/gi)].pop()
  let name = attr ? attr[1] : null
  clips.push({ index, mime, b64, wholeLength: whole.length, name, bytes: null, duration: null, peak: null, sampleRate: null, error: null })
}
if (clips.length === 0) {
  // Fallback: some builds inline raw base64 in JS and turn it into an ArrayBuffer with atob().
  // Those payloads are still checked, but the missing data: URI is reported below.
  audioMode = 'raw-base64'
  for (const match of html.matchAll(/"([A-Za-z0-9_-]+)"\s*:\s*\{\s*"at"\s*:\s*[\d.]+\s*,\s*"b64"\s*:\s*"([A-Za-z0-9+/=]+)"/g)) {
    clips.push({ index: match.index ?? 0, mime: 'wav(raw-b64)', b64: match[2], wholeLength: match[2].length, name: match[1], bytes: null, duration: null, peak: null, sampleRate: null, error: null })
  }
  if (clips.length === 0) {
    audioMode = 'raw-base64-generic'
    for (const match of html.matchAll(/"([A-Za-z0-9+/=]{2000,})"/g)) {
      const b64 = match[1]
      if (!/^(UklGR|UkxGR)/.test(b64)) continue
      clips.push({ index: match.index ?? 0, mime: 'wav(raw-b64)', b64, wholeLength: b64.length, name: null, bytes: null, duration: null, peak: null, sampleRate: null, error: null })
    }
  }
  console.log(`NOTE  no literal data:audio/...;base64 URI; found ${clips.length} raw base64 WAV payload(s) decoded at runtime via atob()/decodeAudioData()`)
}

let manifest = null
if (existsSync(MANIFEST)) {
  try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { /* optional */ }
}
const manifestByName = new Map()
;(function walk (node, ctxName) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const item of node) walk(item, ctxName); return }
  const name = typeof node.name === 'string' ? node.name
    : typeof node.id === 'string' ? node.id
      : typeof node.file === 'string' ? node.file.replace(/.*[\\/]|\.wav$/g, '') : ctxName
  const dur = [node.durationSeconds, node.duration, node.seconds, node.lengthSeconds]
    .map(Number).find(Number.isFinite)
  if (name && dur !== undefined) manifestByName.set(`${name}|${dur.toFixed(2)}`, name)
  for (const [key, value] of Object.entries(node)) if (value && typeof value === 'object') walk(value, key)
})(manifest, null)

console.log(`inline audio payloads: ${clips.length} (mode: ${audioMode})`)
let totalEncoded = 0
let totalDecoded = 0
let audioFailures = 0
for (let i = 0; i < clips.length; i += 1) {
  const clip = clips[i]
  const label = clip.name ?? `clip-${i + 1}`
  try {
    if (clip.b64.length === 0) throw new Error('empty base64 payload')
    const bytes = Buffer.from(clip.b64, 'base64')
    if (bytes.length === 0) throw new Error('base64 decoded to 0 bytes')
    const reencoded = bytes.toString('base64').replace(/=+$/, '')
    const clean = clip.b64.replace(/\s+/g, '').replace(/=+$/, '')
    if (reencoded !== clean) throw new Error(`base64 round-trip mismatch (decoded ${bytes.length} B)`)
    clip.bytes = bytes
    totalEncoded += clip.wholeLength
    totalDecoded += bytes.length
    const wav = decodeWav(bytes)
    clip.sampleRate = wav.sampleRate
    clip.channels = wav.channels.length
    clip.duration = wav.durationSeconds
    let peak = 0
    for (const channel of wav.channels) for (const sample of channel) { const abs = Math.abs(sample); if (abs > peak) peak = abs }
    clip.peak = peak
    if (manifest) {
      for (const [key, name] of manifestByName) {
        const [, durText] = key.split('|')
        if (!clip.name && Math.abs(Number(durText) - clip.duration) < 0.05) { clip.name = name }
      }
    }
    console.log(`  ${label.padEnd(20)} mime=${clip.mime.padEnd(10)} dur=${clip.duration.toFixed(3)}s peak=${clip.peak.toFixed(4)} sr=${clip.sampleRate} ch=${clip.channels} bytes=${bytes.length}`)
    if (!(clip.peak > 0.01)) throw new Error(`silent clip: peak ${clip.peak.toFixed(5)} <= 0.01`)
    if (!(clip.duration > 0)) throw new Error(`zero-length clip`)
    if (clip.duration > EXPECTED_DURATION + 1e-6) throw new Error(`clip lasts ${clip.duration.toFixed(2)}s > ${EXPECTED_DURATION}s`)
    if (!(clip.sampleRate >= 8000 && clip.sampleRate <= 192000)) throw new Error(`implausible sampleRate ${clip.sampleRate}`)
  } catch (error) {
    audioFailures += 1
    console.log(`  ${label.padEnd(20)} INVALID: ${error.message}`)
    bug(`audio clip ${label}: ${error.message}`)
  }
}
if (audioMode !== 'data-uri' && clips.length > 0) {
  bug(`inline audio is raw base64 decoded via atob()/decodeAudioData(), not a data:audio/...;base64,... URI (documented format is a base64 data URI); ${clips.length} payload(s) still validated`)
}
if (clips.length === 0) bug('no data:audio/...;base64,... URI and no decodable base64 WAV payload found on the page')
if (audioFailures === 0 && clips.length > 0) {
  const peaks = clips.map((c) => c.peak)
  console.log(`audio summary: ${clips.length} clip(s), ${totalDecoded} decoded bytes, ${(totalDecoded / 1024).toFixed(1)} KiB, peak range ${Math.min(...peaks).toFixed(4)}..${Math.max(...peaks).toFixed(4)}, max clip ${Math.max(...clips.map((c) => c.duration)).toFixed(3)}s`)
  ok('every inline audio clip decodes, is non-silent and fits the 16 s timeline')
}

// ---------------------------------------------------------------- 4. copy & vocabulary
section(4, 'title, headlines/captions and tool vocabulary')
const entityDecode = (text) => text
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
const unescapeUnicode = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
const visibleText = entityDecode(
  html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
)
const jsonText = spec ? JSON.stringify(spec) : ''
const corpus = [html, visibleText, jsonText, unescapeUnicode(html), unescapeUnicode(visibleText), unescapeUnicode(jsonText)]
  .join('\n')
const compact = (text) => text.replace(/\s+/g, '')
const corpusCompact = compact(corpus)

const expectedTitle = 'dsh-audio'
console.log(`title "${expectedTitle}": ${html.includes(expectedTitle) ? 'present' : 'MISSING'}`)
if (!html.includes(expectedTitle)) bug(`page never mentions the title "${expectedTitle}"`)
else ok(`title "${expectedTitle}" present`)

let specData = null
try { specData = JSON.parse(readFileSync(SPEC, 'utf8')) } catch { warn(`cannot read ${SPEC}; using embedded spec for copy checks`) }
const scenesForCopy = specData?.scenes ?? spec?.scenes ?? []
const headlines = scenesForCopy.map((s) => (s.headline ?? '').trim()).filter(Boolean)
const captions = scenesForCopy.map((s) => (s.caption ?? '').trim()).filter(Boolean)
let copyMissing = 0
for (const [kind, values] of [['headline', headlines], ['caption', captions]]) {
  for (const value of values) {
    const found = corpusCompact.includes(compact(value))
    console.log(`  ${kind.padEnd(8)} "${value}" -> ${found ? 'present' : 'MISSING'}`)
    if (!found) { copyMissing += 1; bug(`${kind} not found on page: "${value}"`) }
  }
}
console.log(`headlines: ${headlines.length}/${headlines.length}; captions: ${captions.length}/${captions.length}; missing: ${copyMissing}`)
if (copyMissing === 0 && headlines.length > 0 && captions.length > 0) ok('all non-empty headlines and captions appear on the page')

const htmlLower = html.toLowerCase()
const foundTools = TOOL_NAMES.filter((name) => htmlLower.includes(name))
const missingTools = TOOL_NAMES.filter((name) => !foundTools.includes(name))
console.log(`real tool names on page: ${foundTools.length}/17 (need >= 15)`)
console.log(`  found:   ${foundTools.join(', ')}`)
if (missingTools.length > 0) console.log(`  missing: ${missingTools.join(', ')}`)
if (foundTools.length < 15) bug(`only ${foundTools.length}/17 tool names on the page (need at least 15)`)
else if (foundTools.length < 17) warn(`${foundTools.length}/17 tool names; requirement is >= 15, missing: ${missingTools.join(', ')}`)
else ok('all 17 real tool names present')

// ---------------------------------------------------------------- 5. start gate + replay
section(5, 'start gate and replay control (asserted on what the page exposes)')
const tokens = new Map()
for (const match of html.matchAll(/(?:^|\s)(?:id|class)\s*=\s*(["'])(.*?)\1/gi)) {
  for (const token of match[2].split(/\s+/)) if (token) tokens.set(token, (tokens.get(token) ?? 0) + 1)
}
const tokenList = [...tokens.keys()]
const gateTokens = tokenList.filter((token) => /(^|[-_])(start|gate|enter|curtain|splash|overlay|cover|click-to-start)([-_]|$)/i.test(token))
const replayTokens = tokenList.filter((token) => /replay|restart|again|rerun|rewind|once-more|replay-button/i.test(token))
const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
  .map((m) => entityDecode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const clickHandlers = [...html.matchAll(/addEventListener\s*\(\s*['"]click['"]/g)].length
const onclickAttrs = [...html.matchAll(/\bon(?:click|pointerdown|keydown)\s*=/gi)].length
const gateText = /(点击|轻触|开始播放|开始|click to (start|play)|tap to (start|play)|press (any key|space))/i.test(visibleText)
const replayText = /(重播|再看一遍|重新播放|再播放一次|replay|play again|again)/i.test(visibleText)
const gateTokensText = gateTokens.length ? gateTokens.join(', ') : '(none)'
const replayTokensText = replayTokens.length ? replayTokens.join(', ') : '(none)'
console.log(`id/class tokens: ${tokenList.length}; start-gate tokens: ${gateTokensText}`)
console.log(`replay tokens: ${replayTokensText}`)
console.log(`<button> labels: ${buttons.length ? JSON.stringify(buttons.slice(0, 8)) : '(none)'}`)
console.log(`click listeners: ${clickHandlers}; inline on{click,pointerdown,keydown}: ${onclickAttrs}`)
console.log(`gate-ish text: ${gateText}; replay-ish text: ${replayText}`)
const hasGate = gateTokens.length > 0 || (gateText && (clickHandlers > 0 || onclickAttrs > 0))
const hasReplay = replayTokens.length > 0 || replayText
console.log(`asserted: start gate -> ${hasGate ? 'PRESENT' : 'MISSING'} (tokens or click-to-start affordance); replay -> ${hasReplay ? 'PRESENT' : 'MISSING'} (tokens or replay text)`)
if (!hasGate) bug('no start gate detected (no gate id/class and no click-to-start affordance)')
else ok('start gate present')
if (!hasReplay) bug('no replay control detected (no replay id/class and no replay text)')
else ok('replay control present')

// ---------------------------------------------------------------- 6. size
section(6, 'size and weight split')
const total = raw.length
const inlineEncoded = clips.reduce((sum, clip) => sum + (clip.wholeLength ?? 0), 0)
const decoded = clips.reduce((sum, clip) => sum + (clip.bytes?.length ?? 0), 0)
const rest = total - inlineEncoded
const pct = (part) => `${((part / total) * 100).toFixed(1)}%`
console.log(`total:          ${total} B (${(total / 1024).toFixed(1)} KiB) / limit ${LIMIT_BYTES} B (${(LIMIT_BYTES / 1024).toFixed(0)} KiB)`)
console.log(`inline audio:   ${inlineEncoded} B encoded ${pct(inlineEncoded)} (${(inlineEncoded / 1024).toFixed(1)} KiB); decoded ${decoded} B (${(decoded / 1024).toFixed(1)} KiB)`)
console.log(`everything else:${String(rest).padStart(9)} B ${pct(rest)} (${(rest / 1024).toFixed(1)} KiB)`)
if (total > LIMIT_BYTES) bug(`total size ${total} B exceeds 1.2 MB (${LIMIT_BYTES} B)`)
else ok(`total size ${total} B <= 1.2 MB`)
if (total > SOFT_BUDGET_BYTES) warn(`total size ${total} B exceeds spec budget ${SOFT_BUDGET_BYTES} B (900 KiB), still under the 1.2 MB hard limit`)

// ---------------------------------------------------------------- result
console.log(`\nRESULT: ${hardFailures === 0 ? 'PASS' : 'FAIL'} — ${hardFailures} bug(s), ${warnings} warning(s)`)
if (hardFailures === 0) console.log(`PAGE: ${PAGE}`)
process.exit(hardFailures === 0 ? 0 : 1)
