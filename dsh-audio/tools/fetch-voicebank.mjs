/**
 * Download the optional recorded-voice bank, so a user can actually reach the
 * tier that `lib/voicebank.js` plays.
 *
 *   node tools/fetch-voicebank.mjs                 # into the default user dir
 *   node tools/fetch-voicebank.mjs --dry           # plan and byte count only
 *   node tools/fetch-voicebank.mjs --dir ./bank    # somewhere else
 *   node tools/fetch-voicebank.mjs --force         # re-fetch everything
 *
 * The plugin ships no audio: this fetches 16 files (12 syllables + the oto.ini
 * that indexes them + the upstream licence/readme/prefix map) from the GitHub
 * mirror of Hitsuboku Kumi's Chinese CVVC voicebank, verifies every file against
 * a hard-coded byte size, writes the attribution required by the voicebank's
 * terms next to the samples, and then proves the result loads.
 *
 * `--full` (all 408 syllables) is deliberately not implemented: see FULL_SUPPORT.
 *
 * `DSH_AUDIO_VOICEBANK_API` overrides the API base (default
 * `https://api.github.com`) for a mirror, a proxy, or an offline cache that
 * speaks the same `repos/:owner/:repo/contents/:path` shape.
 *
 * Needs only `node:` builtins and Node's global `fetch` (Node 18+; this repo
 * targets Node 24). No `npm install`, no dependencies.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultVoicebankDir, loadVoicebank } from '../lib/voicebank.js'

/* ---- what to fetch ---- */

const REPO = 'oxygen-dioxide/hitsuboku-kumi-chn-mirror'
const REF = 'main'
const API = (process.env.DSH_AUDIO_VOICEBANK_API ?? 'https://api.github.com').replace(/\/+$/, '')
const BANK_NAME = 'hitsuboku-kumi-chn'
const OFFICIAL_SITE = 'https://cubialpha.wixsite.com/koomstar'
const REPO_URL = `https://github.com/${REPO}`

/**
 * The validated subset: 12 syllables plus the four support files, each with the
 * exact byte count the mirror serves. Sizes are checked after download, so a
 * changed or truncated upstream file fails loudly instead of sounding wrong.
 */
const SUBSET = [
  { path: '_CV/_a_a.wav', bytes: 760700 },
  { path: '_CV/_e_e.wav', bytes: 760700 },
  { path: '_CV/_ha_ha.wav', bytes: 766212 },
  { path: '_CV/_ka_ka.wav', bytes: 766212 },
  { path: '_CV/_la_la.wav', bytes: 766212 },
  { path: '_CV/_ma_ma.wav', bytes: 760700 },
  { path: '_CV/_na_na.wav', bytes: 766212 },
  { path: '_CV/_o_o.wav', bytes: 766212 },
  { path: '_CV/_sa_sa.wav', bytes: 766212 },
  { path: '_CV/_ta_ta.wav', bytes: 771724 },
  { path: '_CV/_wu_wu.wav', bytes: 760700 },
  { path: '_CV/_yi_yi.wav', bytes: 760700 },
  { path: '_CV/oto.ini', bytes: 308235 },
  { path: 'license.md', bytes: 4006 },
  { path: 'prefix.map', bytes: 767 },
  { path: 'readme.txt', bytes: 884 }
]

const FULL_SUPPORT = `--full is not supported. The mirror holds 408 syllable WAVs and just under
2 MB of oto.ini; the contents API returns one file per request, so a full bank is
408+ requests against GitHub's unauthenticated limit of 60 per hour, and the only
single-request form is the ~765 MB repository archive. Neither is something this
helper should do silently. Download the full bank by hand from
${REPO} (or clone it) and point --bank at the folder instead.`

const USAGE = `usage: node tools/fetch-voicebank.mjs [--dir <path>] [--dry] [--force] [--full]

  --dir <path>   where to put the bank (default: ${defaultVoicebankDir()})
  --dry          print the plan and total size, download nothing
  --force        re-download files that already exist
  --full         unsupported, see --help

env: DSH_AUDIO_VOICEBANK_API overrides the API base (mirror/proxy/offline cache).`

/* ---- attribution required by the voicebank's terms ---- */

/**
 * The notice file. The voicebank's terms only allow redistribution, editing and
 * porting while the name, the author credit and the official-site link stay
 * attached, so they are written next to the samples rather than left to a README
 * the user may never see.
 * @returns {string} markdown text.
 */
function attribution () {
  return `# Attribution — Hitsuboku Kumi (筆墨クミ) voicebank

This directory holds a **subset of the Hitsuboku Kumi Chinese CVVC UTAU
voicebank**. It is downloaded user data, **not** part of the plugin package, and
it is not covered by the plugin's own licence.

- Voicebank name (unchanged): **Hitsuboku Kumi (筆墨クミ)**
- Voice / original author: **Cubialpha**
- Official site: ${OFFICIAL_SITE}
- Upstream mirror these files come from: ${REPO_URL}
- The upstream terms verbatim: \`license.md\` in this directory

## The terms that govern this directory (quoted from \`license.md\`)

> ### Commercial Use of Voicebanks
> Allowed without permission.
>
> ### Redistribution of Voicebanks (Public & Private)
> Allowed without permission, so long as the name "Hitsuboku Kumi" is unchanged,
> "Cubialpha" is credited, and a link to [this website](${OFFICIAL_SITE}) is
> included.
>
> ### Editing of oto.ini and Audio Samples
> Allowed without permission, so long as the name "Hitsuboku Kumi" is unchanged,
> and it is clearly stated that you have made edits.
>
> ### Import and Use of Audio Samples in Other Synthesis Software
> Allowed without permission, so long as the name "Hitsuboku Kumi" is unchanged.

## What was done here (the "edits" the terms ask us to state)

1. **This is a subset, not the full bank.** 12 of the 408 syllable WAVs are
   present (\`a e o yi wu ka ma na ta sa la ha\`). \`_CV/oto.ini\` is the unmodified
   upstream file listing all 408; the plugin skips entries whose audio is absent.
2. The WAV files are **byte-identical** to upstream — no trimming, resampling or
   level changes. Every file is size-verified against a hard-coded byte count
   after download.
3. **Rendered audio is a derivative**: the plugin pitch-shifts these samples onto
   notes, cuts a loop from the steady vowel and crossfades it. Say so if you
   publish the result.

## What is NOT covered

Character and artwork rights are separate from the voicebank. Quoting \`license.md\`:

> ### Commercial Use of Character
> Such as doujin/fan made merchandise, promotional material, etc. that feature
> "Hitsuboku Kumi" and are exchanged for money.
> **Allowed with permission from developer (Cubialpha).**
>
> ### Commercial Use of Official "Hitsuboku Kumi" Illustrations
> i.e. Printing and selling merchandise featuring official "Hitsuboku Kumi"
> illustrations.
> **Forbidden**
>
> ### Editing of Official "Hitsuboku Kumi" Illustrations
> **Forbidden**

So: **commercial use of the voicebank audio is allowed; commercial use of the
character, and any use or editing of the official artwork, is not.** Do not market
the character. If you redistribute this directory, keep this file with it.

Generated by \`tools/fetch-voicebank.mjs\`.
`
}

/* ---- args ---- */


/** Read `--name value` / `--name=value` and boolean flags. */
function parseArgs (argv) {
  const args = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const split = token.indexOf('=')
    if (split > 0) {
      args.values[token.slice(2, split)] = token.slice(split + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.values[name] = next
      i += 1
    } else {
      args.flags.add(name)
    }
  }
  return args
}

/* ---- download ---- */

/**
 * Fetch one file through the GitHub contents API and return its bytes.
 * `fetch` is global in Node 24, so this needs no dependency.
 *
 * @param {string} path - repository-relative path.
 * @returns {Promise<{ bytes: Buffer, remaining: string|null }>}
 */
async function fetchFile (path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const url = `${API}/repos/${REPO}/contents/${encoded}?ref=${REF}`
  let response
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'dsh-audio-fetch-voicebank',
        Accept: 'application/vnd.github+json'
      }
    })
  } catch (error) {
    throw new Error(
      `network unavailable (${error.cause?.code ?? error.message}). This helper needs ` +
      `${API}; if the machine is offline or the API is blocked, download ` +
      `the bank manually from ${REPO_URL} and use --dir.`
    )
  }
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub refused the request (HTTP ${response.status}), unauthenticated remaining=${remaining}. ` +
      'The contents API allows 60 requests per hour per IP; wait, or download the bank by hand.'
    )
  }
  if (response.status === 404) {
    throw new Error(`HTTP 404 for ${path}: the upstream repository layout changed; refusing to write a partial bank.`)
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${path}`)
  }
  const json = await response.json()
  if (typeof json.content !== 'string' || json.encoding !== 'base64') {
    throw new Error(`unexpected API response for ${path} (size ${json.size}); refusing to guess`)
  }
  return { bytes: Buffer.from(json.content, 'base64'), remaining }
}

/**
 * Download one entry, writing `.part` first so an interrupted run never leaves a
 * plausible-looking but truncated WAV behind.
 * @param {{ path: string, bytes: number }} entry - planned file.
 * @param {string} target - destination root.
 * @returns {Promise<{ bytes: number, remaining: string|null }>}
 */
async function download (entry, target) {
  const destination = join(target, entry.path)
  const temporary = `${destination}.part`
  const { bytes, remaining } = await fetchFile(entry.path)
  if (bytes.length !== entry.bytes) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw new Error(
      `${entry.path}: expected ${entry.bytes} bytes but the mirror served ${bytes.length}. ` +
      'Refusing to continue: the upstream file changed or the download was truncated.'
    )
  }
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(temporary, bytes)
  renameSync(temporary, destination)
  return { bytes: bytes.length, remaining }
}

/* ---- main ---- */

const parsed = parseArgs(process.argv.slice(2))
if (parsed.flags.has('help') || parsed.flags.has('h')) {
  console.log(USAGE)
  process.exit(0)
}
if (parsed.flags.has('full')) {
  console.error(FULL_SUPPORT)
  process.exit(2)
}

const target = resolve(typeof parsed.values.dir === 'string' ? parsed.values.dir : defaultVoicebankDir())
const dry = parsed.flags.has('dry')
const force = parsed.flags.has('force')
const plannedBytes = SUBSET.reduce((sum, entry) => sum + entry.bytes, 0)

console.log(`voicebank: ${BANK_NAME} (subset of ${REPO})`)
console.log(`target:    ${target}`)
console.log(`plan:      ${SUBSET.length} files, ${plannedBytes} bytes (${(plannedBytes / 1024 / 1024).toFixed(2)} MiB)`)
console.log(`contents:  ${SUBSET.filter((entry) => entry.path.endsWith('.wav')).length} syllable WAVs + oto.ini, licence, readme, prefix.map`)

if (dry) {
  for (const entry of SUBSET) {
    const state = existsSync(join(target, entry.path)) ? (force ? 're-download' : 'present, skip') : 'download'
    console.log(`  ${entry.path.padEnd(18)} ${String(entry.bytes).padStart(8)} B  ${state}`)
  }
  console.log(`dry run: nothing downloaded, nothing written (ATTRIBUTION.md would be written too)`)
  process.exit(0)
}

mkdirSync(target, { recursive: true })
let downloaded = 0
let skipped = 0
let fetchedBytes = 0
let remaining = null
try {
  for (const entry of SUBSET) {
    const destination = join(target, entry.path)
    if (!force && existsSync(destination) && statSync(destination).size === entry.bytes) {
      skipped += 1
      console.log(`  skip     ${entry.path} (${entry.bytes} B, already present)`)
      continue
    }
    const result = await download(entry, target)
    downloaded += 1
    fetchedBytes += result.bytes
    remaining = result.remaining
    console.log(`  fetched  ${entry.path} (${result.bytes} B)`)
  }
} catch (error) {
  console.error(`\nERROR: ${error.message}`)
  console.error('nothing broken was left behind; re-run when the network is back (partial files end in .part).')
  process.exit(1)
}

const notice = attribution()
writeFileSync(join(target, 'ATTRIBUTION.md'), notice)
console.log(`  wrote    ATTRIBUTION.md (${Buffer.byteLength(notice)} bytes, terms of use + what was edited)`)

/* ---- prove the result loads ---- */

let bank
try {
  bank = loadVoicebank(target)
} catch (error) {
  console.error(`\nERROR: downloaded ${downloaded} file(s) but they do not load: ${error.message}`)
  process.exit(1)
}
if (bank.syllables.size === 0) {
  console.error('\nERROR: the downloaded bank contains no usable syllables')
  process.exit(1)
}

let totalBytes = 0
for (const entry of readdirSync(join(target, '_CV'))) totalBytes += statSync(join(target, '_CV', entry)).size
for (const name of ['ATTRIBUTION.md', 'license.md', 'prefix.map', 'readme.txt']) {
  const at = join(target, name)
  if (existsSync(at)) totalBytes += statSync(at).size
}

console.log(
  `\nOK: ${bank.syllables.size} takes across ${bank.meta.names.filter((name) => !name.endsWith('+') && !name.endsWith(' R')).length} syllables, ` +
  `${totalBytes} bytes on disk, ${bank.meta.sampleRate} Hz, ` +
  `${downloaded} downloaded (${fetchedBytes} B) / ${skipped} skipped` +
  (remaining === null ? '' : `, GitHub rate limit left ${remaining}`)
)
console.log('next: node tools/sing-bank.mjs --bank "' + target + '" --notes "C4:1 E4:1 G4:2" --out out.wav')
