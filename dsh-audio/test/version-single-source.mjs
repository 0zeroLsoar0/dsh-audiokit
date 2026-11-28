/**
 * Version single-source gate.
 *
 * `package.json` is the only place a release number is written. `index.js`
 * reads it into `VERSION` (the settings page and the editor page header echo
 * that string), and the release runbook quotes it in the tarball name, the
 * install specifier and the git tag. A hand-edited copy of any of those drifts
 * silently — the version the user sees in the settings page, the version in
 * the tarball they downloaded and the version in the runbook then disagree —
 * so this test pins every quotation to the manifest:
 *
 *  hard (exit 1):
 *    - package.json parses and its version is a strict `x.y.z` semver;
 *    - `index.js` exports `VERSION` and it equals `package.json.version`;
 *    - `index.js` reads the manifest through `createRequire` and declares no
 *      version literal of its own (the regression this test exists for);
 *    - `docs/RELEASE.md` heading, tarball name, registry specifier, git tag and
 *      `dsh-audiokit X.Y.Z` prose all name the manifest version;
 *    - `README.md` says nothing that contradicts it;
 *    - a `CHANGELOG.md` next to the manifest (none ships today) has no newer
 *      release heading than the manifest version.
 *
 *  advisory (printed, exit 0): a quoted `0.x.y` literal in a runtime source
 *  that is not the manifest version. Pre-1.0 is this package's own series, so
 *  such a literal is a probe for a second hand-maintained copy; it is reported
 *  rather than failed because a file can legitimately freeze a product string
 *  (an on-disk identification block, a measured baseline) and the owner of that
 *  file decides, not this test.
 *
 * Usage: node test/version-single-source.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../index.js'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Strict semver, the shape npm and a tarball name both accept. */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Newlines are normalised so a Windows checkout and a Linux one read alike. */
const readText = async (relative) => (await readFile(resolve(pluginDir, relative), 'utf8')).replace(/\r\n?/g, '\n')

let failures = 0
const advisories = []

/** Print and count one assertion. */
function check (label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}${detail === '' ? '' : ` (${detail})`}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  return false
}

/* ---- 1. the manifest is the source ---- */

console.log('version single-source gate\n')
console.log('-- 1. manifest --')

let pkg = null
try {
  pkg = JSON.parse(await readText('package.json'))
} catch (error) {
  check('package.json parses', false, error.message)
  console.error(`\nFAILED: ${failures} version mismatch(es)`)
  process.exit(1)
}

const version = pkg.version
console.log(`  manifest: ${pkg.name} ${version}`)
check('package.json version is strict semver x.y.z', typeof version === 'string' && SEMVER.test(version), String(version))

/* ---- 2. the plugin exposes that version, not a copy ---- */

console.log('\n-- 2. plugin surface --')
check('index.js exports VERSION', typeof VERSION === 'string' && VERSION.length > 0, String(VERSION))
check('VERSION equals package.json.version', VERSION === version, `index ${VERSION} vs manifest ${version}`)

const indexSource = await readText('index.js')
check(
  'index.js reads the manifest through createRequire',
  /createRequire\(import\.meta\.url\)/.test(indexSource) && /['"]\.\/package\.json['"]/.test(indexSource),
  'createRequire(import.meta.url) + ./package.json'
)
check(
  'index.js declares no version literal of its own',
  !/(?:const|let|var)\s+VERSION\s*=\s*['"`]\d+\.\d+\.\d+/.test(indexSource),
  'VERSION must come from the manifest'
)

/* ---- 3. the release runbook quotes the same identity ---- */

console.log('\n-- 3. docs/RELEASE.md --')
const release = await readText('docs/RELEASE.md')

const heading = /^#\s+Release runbook\b[^\n]*?(\d+\.\d+\.\d+)/m.exec(release)
check(
  'the runbook heading names the manifest version',
  heading !== null && heading[1] === version,
  heading === null ? 'no version in the heading' : `heading says ${heading[1]}, manifest says ${version}`
)

// One entry per place the runbook turns the version into an identity a user can
// download or type. A stale value there is a copy-paste bug that costs a
// publish, so each shape is checked separately instead of one grep.
const IDENTITIES = [
  { label: 'tarball name', re: /dsh-audiokit-(\d+\.\d+\.\d+)\.tgz/g },
  { label: 'registry specifier', re: /dsh-audiokit@(\d+\.\d+\.\d+)/g },
  { label: 'git tag', re: /\bv(\d+\.\d+\.\d+)\b/g },
  { label: 'release prose', re: /\bdsh-audiokit\s+(\d+\.\d+\.\d+)\b/g }
]

/** Every distinct captured version in `text` that is not the manifest version. */
function staleVersions (text, pattern) {
  const found = [...text.matchAll(pattern)].map((match) => match[1])
  return { found, stale: [...new Set(found.filter((value) => value !== version))] }
}

for (const { label, re } of IDENTITIES) {
  const { found, stale } = staleVersions(release, re)
  check(
    `the runbook ${label} matches the manifest`,
    stale.length === 0,
    stale.length === 0 ? `${found.length} reference(s)` : `stale [${stale.join(', ')}], expected ${version}`
  )
}

const tarballName = `${pkg.name}-${version}.tgz`
check('the runbook quotes the tarball the manifest produces', release.includes(tarballName), tarballName)

/* ---- 4. README.md, and a CHANGELOG.md when one ships ---- */

console.log('\n-- 4. README.md and CHANGELOG --')
const readme = await readText('README.md')
for (const { label, re } of IDENTITIES.filter((entry) => entry.label !== 'git tag')) {
  const { stale } = staleVersions(readme, re)
  check(`README.md ${label} matches the manifest`, stale.length === 0, stale.length === 0 ? '' : `stale [${stale.join(', ')}], expected ${version}`)
}

// The plugin tarball carries no changelog today (the project changelog lives in
// the workspace repository, outside the package). Keep the check dormant but
// live, so a changelog that is added later cannot drift unnoticed.
const changelogs = (await readdir(pluginDir)).filter((entry) => /^changelog(\.md)?$/i.test(entry)).sort()
if (changelogs.length === 0) {
  console.log('  note no CHANGELOG.md ships next to the manifest; nothing to cross-check')
} else {
  const compare = (a, b) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index]
    }
    return 0
  }
  for (const file of changelogs) {
    const text = await readText(file)
    const headings = [...text.matchAll(/^#{2,3}\s+(\d+\.\d+\.\d+)\b/gm)].map((match) => match[1])
    const newest = headings.sort(compare).at(-1)
    check(`${file} newest release heading is the manifest version`, newest === version, newest === undefined ? 'no x.y.z heading' : `newest ${newest}, manifest ${version}`)
  }
}

/* ---- 5. advisory: a second copy in the runtime sources ---- */

// Pre-1.0 versions are this package's own series. A quoted `0.x.y` in shipped
// runtime code that is not the manifest version is therefore either a frozen
// on-disk contract (legitimate) or a hand-maintained copy (drift); print it and
// let the owner judge — a hard failure would need a file this test does not own.
const runtimeSources = ['index.js', 'client.js']
for (const entry of (await readdir(resolve(pluginDir, 'lib'))).filter((name) => name.endsWith('.js')).sort()) {
  runtimeSources.push(`lib/${entry}`)
}

const quotedTriple = /(['"`])(\d+\.\d+\.\d+)\1/g
for (const file of runtimeSources) {
  const lines = (await readText(file)).split('\n')
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return // comment, not a value
    for (const match of line.matchAll(quotedTriple)) {
      const value = match[2]
      // 0.0.0 is the conventional "unknown/placeholder" sentinel, not a copy.
      if (value === version || value === '0.0.0' || !value.startsWith('0.')) continue
      advisories.push({ file, line: index + 1, value })
    }
  })
}

/* ---- report ---- */

if (advisories.length > 0) {
  console.log('\nadvisory (a second version literal; review, not a failure)')
  for (const entry of advisories) console.log(`  ${entry.file}:${entry.line}  "${entry.value}" — looks like a hand-maintained copy of the product version`)
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} version mismatch(es); the manifest is ${pkg.name}@${version}`)
  process.exit(1)
}
console.log(`OK: one version source — ${pkg.name} ${version} in package.json, index.js VERSION, README.md and docs/RELEASE.md (${advisories.length} advisory literal(s))`)
