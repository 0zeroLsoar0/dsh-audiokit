#!/usr/bin/env node
/**
 * Run every test/*.mjs in its own child process and print one line per file.
 *
 * Why a runner instead of `node --test`: these are standalone scripts, not
 * node:test modules. Each prints its own measured numbers and exits non-zero on
 * its first real failure, which keeps every file runnable by hand while giving
 * CI (and a human) one command for the whole suite.
 *
 *   node tools/test-all.mjs                    all files, serial, deterministic order
 *   node tools/test-all.mjs --only smoke       substring filter on "test/<file>.mjs"
 *   node tools/test-all.mjs --only edge,video  several filters (union)
 *   node tools/test-all.mjs --jobs 4           concurrent files (see the warning)
 *   node tools/test-all.mjs --timeout 600000   per-file timeout in ms (default 300000)
 *   node tools/test-all.mjs --verbose          print captured output of passing files too
 *   node tools/test-all.mjs --list             print the files that would run
 *
 * Concurrency stays off by default on purpose: several tests clear the *same*
 * `test/out/` scratch directory, so the full suite is only correct one file at
 * a time. `--jobs` speeds up filtered subsets that do not share scratch paths.
 *
 * A test that cannot run on this machine (no ffmpeg, no voicebank, an external
 * service down) prints `SKIP:` and exits 0. It is reported as `ok` with an
 * extra `[skip]` marker; no file name is special-cased, and a SKIP is never a
 * failure as long as the process exits 0.
 *
 * A file that exits 0 without printing `OK:` or `SKIP:` is a failure, not a
 * pass: a script that checks nothing would otherwise be counted as a passing
 * test, hiding the checks it was supposed to make. Every executable file under
 * `test/` must state its own verdict; reusable helpers belong in
 * `test/support/`, which discovery does not scan.
 *
 * Output is captured and capped: a passing file prints nothing but its `ok`
 * line, a failing file prints the tail of its stdout/stderr. A full-suite run
 * therefore stays a short list even though single tests are chatty.
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin root: this file lives in `tools/`, tests are resolved from the root. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(ROOT, 'test')

/** Per-stream capture cap. We only ever print the tail, so the head is droppable. */
const CAPTURE_BYTES = 64 * 1024
/** How many captured lines a failure prints, so one noisy test cannot flood CI. */
const TAIL_LINES = 120
/** A hung test must not hang CI forever. Override with --timeout. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const HELP = `usage: node tools/test-all.mjs [options]

  --only <substr>   run only files whose "test/<name>.mjs" contains <substr>;
                    repeatable and comma-separated (filters are OR-ed)
  --jobs <n>        files to run concurrently (default 1; keep 1 for the full
                    suite because several tests share test/out/)
  --timeout <ms>    per-file timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})
  --verbose         print the captured output of every file, not just failures
  --list            print matching files and exit without running them
  -h, --help        this text`

/* ---- argument parsing ---- */

function usageError (message) {
  console.error(`test-all: ${message}`)
  console.error('run with --help for usage')
  process.exit(2)
}

const options = {
  only: [],
  jobs: 1,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  verbose: false,
  list: false
}

const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  const equals = arg.indexOf('=')
  const flag = equals === -1 ? arg : arg.slice(0, equals)
  const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1)
  // Reads the value of a flag that needs one, from "--flag=value" or the next
  // argv entry. Fails loudly instead of silently treating "--only" as a file.
  const value = () => {
    if (inlineValue !== undefined) return inlineValue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) usageError(`${flag} needs a value`)
    index += 1
    return next
  }
  if (flag === '--only') {
    const filters = value().split(',').map((part) => part.trim()).filter((part) => part !== '')
    if (filters.length === 0) usageError('--only needs a non-empty substring')
    options.only.push(...filters)
  } else if (flag === '--jobs') {
    const text = value()
    const jobs = Number(text)
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) usageError(`--jobs expects an integer 1..64, got "${text}"`)
    options.jobs = jobs
  } else if (flag === '--timeout') {
    const text = value()
    const timeoutMs = Number(text)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) usageError(`--timeout expects an integer >= 1000 ms, got "${text}"`)
    options.timeoutMs = timeoutMs
  } else if (flag === '--verbose') {
    options.verbose = true
  } else if (flag === '--list') {
    options.list = true
  } else if (flag === '--help' || flag === '-h') {
    console.log(HELP)
    process.exit(0)
  } else {
    usageError(`unknown option "${arg}"`)
  }
}

/* ---- discovery ---- */

/** Deterministic code-unit ordering: localeCompare depends on the machine locale. */
function compareNames (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

const entries = await readdir(TEST_DIR, { withFileTypes: true })
const allFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => entry.name)
  .sort(compareNames)

const files = options.only.length === 0
  ? allFiles
  : allFiles.filter((name) => options.only.some((filter) => `test/${name}`.includes(filter)))

if (files.length === 0) {
  const filters = options.only.length === 0 ? '(none)' : options.only.map((part) => `"${part}"`).join(', ')
  console.error(`test-all: no test/*.mjs matched ${filters}`)
  process.exit(2)
}

if (options.list) {
  for (const name of files) console.log(`test/${name}`)
  console.log(`\n${files.length} file(s)`)
  process.exit(0)
}

/* ---- one child process per file ---- */

/**
 * Keep only the last `cap` characters of a captured stream.
 * @param {string} text accumulated output so far
 * @param {string} chunk newly arrived text
 * @returns {string} the capped accumulation
 */
function tailText (text, chunk, cap) {
  const combined = text + chunk
  return combined.length <= cap ? combined : combined.slice(combined.length - cap)
}

/**
 * Run one test file with the current node binary and capture its output.
 * @param {string} name file name inside `test/`
 * @returns {Promise<{name: string, code: number|null, signal: string|null, stdout: string, stderr: string, elapsedMs: number, timedOut: boolean, spawnError: Error|null}>}
 */
function runFile (name) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = null
    let settled = false
    let timer = null

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve({
        name,
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        timedOut,
        spawnError
      })
    }

    let child
    try {
      child = spawn(process.execPath, [join('test', name)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      spawnError = error
      resolve({ name, code: null, signal: null, stdout, stderr, elapsedMs: 0, timedOut: false, spawnError })
      return
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = tailText(stdout, chunk, CAPTURE_BYTES) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = tailText(stderr, chunk, CAPTURE_BYTES) })

    child.on('error', (error) => {
      spawnError = error
      // Do not wait for a 'close' that may never arrive after a spawn error.
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    timer = setTimeout(() => {
      timedOut = true
      // SIGTERM is honoured on POSIX and terminates the process on Windows;
      // the close event still carries the exit information.
      child.kill()
    }, options.timeoutMs)
  })
}

/* ---- reporting ---- */

const MS_PER_SECOND = 1000

/** `1.2 s` below a minute, `3m 07s` above it; stable and locale-free. */
function durationText (ms) {
  if (ms < 60 * MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)} s`
  const minutes = Math.floor(ms / (60 * MS_PER_SECOND))
  const seconds = Math.round((ms % (60 * MS_PER_SECOND)) / MS_PER_SECOND)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Decide what a finished child means.
 * A SKIP is a normal exit that printed a `SKIP:` line; it stays `ok` and only
 * gets an extra marker, because whether a machine has ffmpeg/network is not a
 * code defect. An exit 0 with neither marker is not a pass: the file may be a
 * helper module or a script that asserts nothing, and counting it as `ok`
 * would silently shorten the suite.
 */
function classify (result) {
  if (result.timedOut) return { status: 'FAIL', kind: `timeout after ${options.timeoutMs} ms`, skip: false }
  if (result.spawnError !== null) return { status: 'FAIL', kind: `could not start node: ${result.spawnError.message}`, skip: false }
  if (result.code !== 0) {
    const detail = result.signal === null ? `exit code ${result.code}` : `killed by signal ${result.signal}`
    return { status: 'FAIL', kind: detail, skip: false }
  }
  const output = result.stdout + result.stderr
  const skip = /(^|\n)\s*SKIP:/.test(output)
  if (!skip && !/(^|\n)\s*OK:/.test(output)) {
    return {
      status: 'FAIL',
      kind: 'exited 0 but printed neither "OK:" nor "SKIP:" (a file that checks nothing is not a passing test)',
      skip: false
    }
  }
  return { status: 'ok', kind: '', skip }
}

/**
 * Print the captured tail of one file. The caps are applied in `tailText`, so
 * this prints at most TAIL_LINES lines even for a very noisy test.
 */
function printCaptured (result, heading) {
  const text = `${result.stdout}${result.stderr}`.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  // Drop the artificial empty last element from a trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) {
    console.log(`  ${heading}: (no output)`)
    return
  }
  console.log(`  ${heading} (last ${Math.min(lines.length, TAIL_LINES)} of ${lines.length} line(s)):`)
  const shown = lines.slice(Math.max(0, lines.length - TAIL_LINES))
  if (lines.length > shown.length) console.log(`  ... ${lines.length - shown.length} earlier line(s) omitted ...`)
  for (const line of shown) console.log(`  | ${line}`)
}

/** Run every selected file (serially by default) and print one line per file. */
async function main () {
  const nameWidth = files.reduce((width, name) => Math.max(width, name.length), 0)
  const startedAt = process.hrtime.bigint()
  let ok = 0
  let skipped = 0
  let failed = 0

  console.log(`dsh-audiokit plugin tests · node ${process.version} · ${files.length} file(s) · jobs ${options.jobs}`)
  if (options.only.length > 0) console.log(`filter: ${options.only.join(', ')}`)
  console.log('')

  // A fixed worker count over a shared cursor keeps the file order stable for
  // serial runs and avoids queue allocation for parallel ones.
  let cursor = 0
  async function worker () {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= files.length) return
      const result = await runFile(files[index])
      const verdict = classify(result)
      const line = `${verdict.status.padEnd(4)}  ${result.name.padEnd(nameWidth)}  ` +
        `${String(result.elapsedMs).padStart(6)} ms${verdict.skip ? '  [skip]' : ''}`
      console.log(line)
      if (verdict.status === 'ok') ok += 1
      else failed += 1
      if (verdict.skip) skipped += 1
      if (verdict.status === 'FAIL' || options.verbose) {
        if (verdict.status === 'FAIL') console.log(`  ${verdict.kind}`)
        printCaptured(result, verdict.status === 'FAIL' ? `${result.name} output` : `${result.name} output (verbose)`)
        console.log('')
      }
    }
  }

  const workers = Array.from({ length: Math.min(options.jobs, files.length) }, () => worker())
  await Promise.all(workers)

  const elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)
  const summary = `${files.length} file(s) · ${ok} ok · ${failed} failed`
  console.log('')
  console.log(`${summary}${skipped > 0 ? ` · ${skipped} skipped` : ''} · ${durationText(elapsedMs)}`)
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
