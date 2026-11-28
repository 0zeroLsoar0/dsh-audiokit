/**
 * Batch project operations: one call over dozens of files.
 *
 * The single-file tools (`audio_check`, `audio_loudness`, `audio_master`) each
 * do one job well and each pay the same per-call cost: an argument round-trip, a
 * decode, a report. A cue project is dozens of files, and finishing them one
 * call at a time is where an agent runs out of steps — so this module runs the
 * same operations over a list and reports one table.
 *
 * Four actions, one result shape:
 *
 *   check      the delivery gate: clipping, near-silence, peak headroom, DC;
 *   loudness   BS.1770-4 integrated loudness and true peak, no writing;
 *   normalize  a true-peak-safe linear gain copy toward a target LUFS — the
 *              same correction path `audio_loudness` writes, applied per file;
 *   master     the full mastering chain from `lib/master.js` per file.
 *
 * Two facts this module is built around, because pretending otherwise is how
 * batch tools lie:
 *
 * 1. **Concurrency is not parallelism.** The work is async (decode, write) but
 *    the DSP between those awaits is synchronous JavaScript, so the CPU renders
 *    one file at a time whatever `concurrency` says. A promise pool still earns
 *    its keep — while one file waits on the disk another can be rendering — and
 *    `pool` reports what actually happened (`limit`, `maxInFlight`) beside the
 *    sentence that keeps it honest. Nothing here claims parallel DSP.
 *
 * 2. **One bad file must not sink the batch.** A missing path, a truncated
 *    WAV, a channel count with no WAVE layout: each is recorded in
 *    `items[i].error` and the run continues, because a 40-file job that aborts
 *    on file 3 is worse than one that returns 37 results and names the 3
 *    problems.
 *
 * Safety rules, because a batch writer is a batch of chances to destroy
 * something:
 *   - every output lives inside `outDir`, and its file name is a sanitised stem
 *     (no separators, no `..`, no drive qualifier), so nothing can escape;
 *   - an output path equal to *any* input path is refused per item
 *     (`out == input`), so a copy can never overwrite a source file;
 *   - `outDir` is created once, up front, and a failure there fails the call
 *     instead of producing N identical per-item errors.
 *
 * Determinism: the same inputs, action and target produce the same items,
 * metrics and bytes (the copies are 16-bit, encoded by the plugin's seeded
 * encoder). The one observational field is `pool.maxInFlight`, which depends on
 * I/O timing and is deliberately kept out of `summary`.
 */

import { mkdir } from 'node:fs/promises'
import { availableParallelism, cpus } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'

import { measureChannels, readChannels, resolvePath, writeFileAtomic } from './audio.js'
import { clamp, dbToGain } from './dsp.js'
import { analyzeLoudness, planGain } from './lufs.js'
import { masterChain } from './master.js'
import { encodeAnyWav, loudnessChannels } from './multichannel.js'
import { decodeWav } from './wav.js'

/* ------------------------------------------------------------------ limits -- */

/** The four operations this module knows, in the order the docs list them. */
export const BATCH_ACTIONS = Object.freeze(['check', 'loudness', 'normalize', 'master'])

/** Actions that write a copy; the other two only measure. */
const WRITING_ACTIONS = new Set(['normalize', 'master'])

/** Target used by `normalize`/`master` when the caller names none: web/streaming. */
export const BATCH_DEFAULT_TARGET_LUFS = -14

/** Lowest target the mastering chain will accept, so the batch refuses it too. */
const MIN_TARGET_LUFS = -45

/**
 * True-peak ceiling for the batch actions. Deliberately a module constant, not
 * a tool argument: the batch schema stays small, and -1 dBTP is the documented
 * delivery ceiling for every web/podcast target the plugin supports.
 */
export const BATCH_CEILING_DBTP = -1

/**
 * Headroom left below the ceiling before encoding, in dB.
 *
 * The ceiling is a promise about the *file on disk*, and 16-bit quantisation
 * can move the loudest sample up by a fraction of a dB. `audio_loudness` uses
 * the same guard for the same reason; both write 16-bit copies.
 */
const WRITE_CEILING_GUARD_DB = 0.02

/** Copies this module writes are 16-bit: the plugin's default delivery format. */
const OUTPUT_BIT_DEPTH = 16

/** Default output directory for `normalize`/`master`, relative to the session. */
export const BATCH_DEFAULT_OUT_DIR = 'out/batch'

/** File-name suffix per writing action (`hit.wav` -> `hit-norm.wav`). */
const ACTION_SUFFIX = Object.freeze({ normalize: 'norm', master: 'master' })

/** `concurrency` is clamped into this range; above it the batch is just memory. */
export const BATCH_MAX_CONCURRENCY = 8

/** The automatic concurrency never goes above this, whatever the CPU count. */
export const BATCH_CONCURRENCY_CAP = 4

/* ------------------------------------------------- quality-gate thresholds -- */

/** Same gate as `audio_check`: below this peak the file is "almost silent". */
const SILENT_PEAK_DB = -40
/** A peak this close to full scale will sum into clipping on a timeline. */
const PEAK_WARN_DB = -0.2
/** DC offset above this shifts the waveform enough to matter. */
const DC_WARN = 0.01
/** A normalised copy this close to its target counts as on target. */
const LOUDNESS_TOLERANCE_LU = 1

/** Absolute gate floor / peak floor, so JSON never carries -Infinity. */
const GATE_FLOOR_LUFS = -70
const PEAK_FLOOR_DB = -120

/** Per-file lines the human text repeats before it summarises the rest. */
const REPORT_LINE_LIMIT = 12

/* ----------------------------------------------------------------- helpers -- */

function describeValue (value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function finiteOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function round2 (value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

/** One comparison key per path; case-insensitive on Windows, where `a.WAV` == `a.wav`. */
function pathKey (path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Format a number for the human text without a trailing `.0` or a `-0`. */
function fmt (value, digits = 1) {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  const text = Number(value).toFixed(digits)
  return Number(text) === 0 ? '0' : text.replace(/\.0+$/, '')
}

function signed (value, digits = 1) {
  return `${value >= 0 ? '+' : ''}${fmt(value, digits)}`
}

/* ---------------------------------------------------------------- CPU pool -- */

/**
 * How many CPUs this machine reports, defensively.
 *
 * `os.availableParallelism` respects the scheduler's affinity mask (containers
 * and CI runners report nonsense through `os.cpus()`), so it is preferred; the
 * fallback keeps Node 18, which `engines.node` allows, working.
 *
 * @returns {number} at least 1.
 */
export function cpuCount () {
  try {
    const parallelism = availableParallelism()
    if (Number.isInteger(parallelism) && parallelism > 0) return parallelism
  } catch { /* not available on this Node */ }
  const list = cpus()
  return Array.isArray(list) && list.length > 0 ? list.length : 1
}

/**
 * The default concurrency: half the CPUs, never more than four, never less
 * than one. More than four files in flight does not buy throughput — the CPU is
 * still serial — it only buys peak memory, and a master holds a whole decoded
 * file per in-flight item.
 *
 * @param {number} [cpusDetected] - CPU count; defaults to this machine's.
 * @returns {number} 1..4.
 */
export function defaultConcurrency (cpusDetected = cpuCount()) {
  const total = Math.floor(Number.isFinite(cpusDetected) ? cpusDetected : 1)
  return clamp(Math.floor(Math.max(1, total) / 2), 1, BATCH_CONCURRENCY_CAP)
}

/**
 * Validate the `concurrency` argument.
 *
 * `undefined`/`null` mean "use the default"; a numeric string is accepted
 * because the host may send one. A fractional or out-of-range value is an error
 * with both limits in the message rather than a silent clamp, because a caller
 * that asked for 16 files in flight is making a memory decision this module has
 * to decline out loud.
 *
 * @param {unknown} requested - caller value.
 * @param {number} [cpusDetected] - CPU count, only used for the default.
 * @returns {number} 1..8.
 */
export function resolveConcurrency (requested, cpusDetected = cpuCount()) {
  if (requested === undefined || requested === null) return defaultConcurrency(cpusDetected)
  if (typeof requested !== 'number' && typeof requested !== 'string') {
    throw new Error(`audio_batch: concurrency 必须是 1..${BATCH_MAX_CONCURRENCY} 的整数，收到 ${describeValue(requested)}`)
  }
  const number = Number(requested)
  if (!Number.isInteger(number) || number < 1 || number > BATCH_MAX_CONCURRENCY) {
    throw new Error(`audio_batch: concurrency 必须是 1..${BATCH_MAX_CONCURRENCY} 的整数，收到 ${describeValue(requested)}`)
  }
  return number
}

/**
 * Run `worker` over `items` with at most `limit` items unfinished at a time.
 *
 * This is a promise pool, not a thread pool: `lane` is started `lanes` times and
 * every lane pulls the next index until the list is empty. Whether two items
 * actually overlap depends on the worker returning a promise: a fully
 * synchronous worker is claimed, finished and released in one synchronous block,
 * so `maxInFlight` stays 1 — which is the truthful answer for synchronous work,
 * and the reason this metric is worth reporting at all. An async worker (the
 * real one awaits `readFile`/`writeFile`) leaves its item counted while it
 * waits, so overlapping I/O is visible.
 *
 * Results keep the input order (each lane writes its own index), so a batch
 * report does not reorder itself with I/O timing. A worker that throws rejects
 * the whole call; `runBatch` wraps its per-file worker so this never happens
 * for a bad file.
 *
 * @template T, R
 * @param {T[]} items - work list.
 * @param {number} limit - maximum items in flight.
 * @param {(item: T, index: number) => Promise<R>|R} worker - per-item function.
 * @returns {Promise<{ results: R[], maxInFlight: number, lanes: number }>}
 */
export async function runPool (items, limit, worker) {
  if (!Array.isArray(items)) throw new Error('runPool needs an array of items')
  if (typeof worker !== 'function') throw new Error('runPool needs a worker function')
  const total = items.length
  for (let index = 0; index < total; index += 1) {
    if (items[index] === undefined) throw new Error(`runPool: items[${index}] is undefined (a sparse list cannot be ordered)`)
  }
  const results = new Array(total)
  const requested = Math.floor(Number(limit))
  const lanes = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, total === 0 ? 1 : total))
  let cursor = 0
  let active = 0
  let maxInFlight = 0

  /** One lane: claim the next index, work it, repeat until the list is spent. */
  const lane = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total) return
      active += 1
      if (active > maxInFlight) maxInFlight = active
      try {
        let value = worker(items[index], index)
        // Only a promise can leave this item in flight across a turn of the
        // event loop; a plain value was produced inside one synchronous block,
        // so it must not be counted as overlap.
        if (value !== null && typeof value === 'object' && typeof value.then === 'function') value = await value
        results[index] = value
      } finally {
        active -= 1
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, lane))
  return { results, maxInFlight, lanes }
}

/* -------------------------------------------------------------- arguments -- */

function resolveAction (requested) {
  if (requested === undefined || requested === null) return 'check'
  const action = String(requested)
  if (!BATCH_ACTIONS.includes(action)) {
    throw new Error(`audio_batch: action 必须是 ${BATCH_ACTIONS.join(' / ')} 之一，收到 ${describeValue(requested)}`)
  }
  return action
}

/**
 * Validate `targetLufs` for the requested action.
 *
 * `normalize`/`master` need a number and default to -14 LUFS (web/streaming).
 * `loudness` only uses it when the caller passed one — then it adds an
 * off-target judgement instead of a compliance target. `check` has no loudness
 * opinion at all, so a target there is a mistake worth naming rather than
 * ignoring (a silently ignored argument looks like it worked).
 *
 * @returns {number|null} the target, or null when the action does not use one.
 */
function resolveTargetLufs (action, requested) {
  const writing = WRITING_ACTIONS.has(action)
  if (requested === undefined || requested === null) return writing ? BATCH_DEFAULT_TARGET_LUFS : null
  if (typeof requested !== 'number' && typeof requested !== 'string') {
    throw new Error(`audio_batch: targetLufs 必须是数字，收到 ${describeValue(requested)}`)
  }
  const number = Number(requested)
  if (!Number.isFinite(number)) throw new Error(`audio_batch: targetLufs 必须是数字，收到 ${describeValue(requested)}`)
  if (number > 0 || number < MIN_TARGET_LUFS) {
    throw new Error(`audio_batch: targetLufs 必须在 ${MIN_TARGET_LUFS}..0 LUFS 之间，收到 ${number}`)
  }
  if (!writing && action === 'check') {
    throw new Error('audio_batch: check 不判响度，也不需要 targetLufs；要按目标判定请用 action "loudness"')
  }
  return number
}

function resolveOutDir (cwd, requested) {
  if (requested === undefined || requested === null) return join(cwd, BATCH_DEFAULT_OUT_DIR)
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error(`audio_batch: outDir 必须是非空路径字符串，收到 ${describeValue(requested)}`)
  }
  const path = resolvePath(cwd, requested)
  if (path === undefined) throw new Error(`audio_batch: outDir 不是可用的路径（${describeValue(requested)}）`)
  return path
}

/**
 * Normalise `files`/`cues` into one ordered list of resolved inputs.
 *
 * Every entry is validated before anything is read: a blank path used to be
 * skipped silently (which made a 0-file success possible), and a cue that is
 * not an object crashed with a raw TypeError. Duplicates are dropped and
 * counted, because the same WAV listed twice would otherwise be decoded twice
 * and (for the writing actions) produce two copies of the same work.
 *
 * `at` is carried through untouched: a cue's planned second is part of the
 * thing being audited, and the check/loudness reports name the file by both.
 *
 * @param {string} cwd - session directory, for relative paths.
 * @param {unknown} files - `files` argument.
 * @param {unknown} cues - `cues` argument.
 * @returns {{ items: { path: string, label: string, at: number|null }[], duplicates: number }}
 */
export function resolveBatchItems (cwd, files, cues) {
  const fileList = Array.isArray(files) ? files : []
  const cueList = Array.isArray(cues) ? cues : []
  if (fileList.length > 0 && cueList.length > 0) {
    throw new Error('audio_batch: files 和 cues 只能给一个：给 files 是路径列表，给 cues 是 [{ path, at }]')
  }
  if (fileList.length === 0 && cueList.length === 0) {
    throw new Error('audio_batch: 需要 files（wav 路径数组）或 cues（[{ path, at }]）：至少一个音频文件')
  }

  const items = []
  const seen = new Set()
  let duplicates = 0

  const add = (requested, at, source, index) => {
    if (typeof requested !== 'string' || requested.trim() === '') {
      throw new Error(`audio_batch: ${source}[${index}] 不是可用的文件路径（${describeValue(requested)}）`)
    }
    const path = resolvePath(cwd, requested)
    if (path === undefined) throw new Error(`audio_batch: ${source}[${index}] 不是可用的文件路径（${describeValue(requested)}）`)
    const key = `${pathKey(path)}\u0000${at === null ? '' : at}`
    if (seen.has(key)) {
      duplicates += 1
      return
    }
    seen.add(key)
    items.push({ path, label: displayPath(cwd, path), at })
  }

  for (let index = 0; index < fileList.length; index += 1) add(fileList[index], null, 'files', index)
  for (let index = 0; index < cueList.length; index += 1) {
    const cue = cueList[index]
    if (cue === null || typeof cue !== 'object' || Array.isArray(cue)) {
      throw new Error(`audio_batch: cues[${index}] 必须是 { path, at? } 对象，收到 ${describeValue(cue)}`)
    }
    let at = null
    if (cue.at !== undefined && cue.at !== null) {
      const number = Number(cue.at)
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`audio_batch: cues[${index}].at 不是合法的秒数（${describeValue(cue.at)}）`)
      }
      at = number
    }
    add(cue.path, at, 'cues', index)
  }

  return { items, duplicates }
}

/* ------------------------------------------------------------- output plan -- */

/**
 * Sanitised file stem: a batch output name must be a *name*, not a path.
 *
 * Everything that is not `[A-Za-z0-9._-]` becomes `-`, so a Windows drive
 * qualifier, a separator or a `..` in the source name cannot move the output
 * out of `outDir`. A stem that collapses to nothing usable becomes `audio`.
 */
function outputStem (path) {
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return stem === '' ? 'audio' : stem
}

/**
 * One output path per input, unique within the batch.
 *
 * Names are readable (`hit-norm.wav`) rather than content-hashed, because a
 * human opens this folder afterwards. Two sources with the same stem (from
 * different directories, or the same cue listed at two times) would collide, so
 * the second one gets `-2`, `-3`, … in input order — deterministic, and it
 * never depends on completion order.
 *
 * @param {{ path: string }[]} items - resolved inputs, in order.
 * @param {string} outDir - absolute output directory.
 * @param {string} action - 'normalize' or 'master'.
 * @returns {string[]} absolute output paths, parallel to `items`.
 */
function planOutputs (items, outDir, action) {
  const suffix = ACTION_SUFFIX[action]
  if (suffix === undefined) throw new Error(`audio_batch: ${action} 不写盘，没有输出计划`)
  const used = new Set()
  const outputs = []
  for (const item of items) {
    const stem = outputStem(item.path)
    let name = `${stem}-${suffix}.wav`
    let counter = 2
    while (used.has(name.toLowerCase())) {
      name = `${stem}-${suffix}-${counter}.wav`
      counter += 1
    }
    used.add(name.toLowerCase())
    // `basename(name) === name` is the traversal guard: the output is joined to
    // `outDir`, so a name that carried a separator or a `..` segment would be
    // the one way out of the directory. Asserted after the sanitiser so a future
    // edit to the character class cannot silently reopen it.
    if (basename(name) !== name || name === '.' || name === '..') {
      throw new Error(`audio_batch: 输出文件名未通过安全校验（${name}）`)
    }
    outputs.push(join(outDir, name))
  }
  return outputs
}

/* ---------------------------------------------------------------- metering -- */

/** Power-averaged RMS of a channel list, in dBFS (one pass, no FFT). */
function rmsDbfsOf (channels) {
  let squares = 0
  let count = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) squares += channel[index] * channel[index]
    count += channel.length
  }
  if (count === 0 || !(squares > 0)) return PEAK_FLOOR_DB
  return round2(10 * Math.log10(squares / count))
}

/**
 * Analyse a decoded file the way the rest of the plugin does: LFE excluded from
 * the loudness sum, BS.1770-4 surround weights applied. `multichannel
 * .loudnessChannels` is the one place that decision is taken, so the batch
 * numbers agree with `audio_loudness` and `audio_master` for the same file.
 *
 * @param {{ channels: Float32Array[], sampleRate: number }} decoded
 * @returns {{ loudnessInput: object, analysis: object }}
 */
function analyseDecoded (decoded) {
  const loudnessInput = loudnessChannels(decoded.channels)
  const analysis = analyzeLoudness(loudnessInput.measured[0], decoded.sampleRate, {
    channels: loudnessInput.measured,
    weights: loudnessInput.weights
  })
  return { loudnessInput, analysis }
}

/** The metric block every item carries; action-specific keys are added on top. */
function baseMetrics (decoded, durationSeconds, peakDbfs) {
  return {
    durationSeconds,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels.length,
    peakDbfs,
    rmsDbfs: rmsDbfsOf(decoded.channels)
  }
}

function scaleChannel (channel, gain) {
  const out = new Float32Array(channel.length)
  for (let index = 0; index < channel.length; index += 1) out[index] = channel[index] * gain
  return out
}

/**
 * Encode a corrected channel list, write it atomically and decode the bytes
 * that were written.
 *
 * Measuring the bytes rather than the in-memory samples is what makes the
 * reported LUFS the number the user will ship: bit depth, the write guard and
 * quantisation are all part of the promise.
 *
 * @returns {Promise<{ byteLength: number, decoded: object }>}
 */
async function writeCopy (outPath, channels, sampleRate) {
  const bytes = encodeAnyWav(channels, sampleRate, { bitDepth: OUTPUT_BIT_DEPTH })
  await writeFileAtomic(outPath, bytes)
  return { byteLength: bytes.length, decoded: decodeWav(bytes) }
}

/* ---------------------------------------------------------- item actions -- */

/**
 * `check`: clipping first, then silence, then peak headroom and DC.
 *
 * The thresholds are the ones `audio_check` uses for the same findings, kept
 * here as constants because a batch gate has to be cheap: no self-check, no
 * FFT, no optional model — just the three things that make a file unusable in a
 * mix, plus the DC warning that costs one pass over samples we already read.
 *
 * @returns {object} item entry (`ok` is false when any finding is an error).
 */
function checkItem (item, decoded) {
  const measured = measureChannels(decoded.channels, decoded.sampleRate)
  const issues = []
  const worstChannel = measured.perChannel === undefined
    ? -1
    : measured.perChannel.findIndex((channel) => channel.clipping === measured.clipping)
  const channelNote = measured.channelCount > 1 && worstChannel >= 0
    ? `（最差声道 ${worstChannel + 1}/${measured.channelCount}）`
    : ''

  if (measured.clipping > 0) {
    issues.push({ level: 'error', message: `${measured.clipping} 个采样被削波${channelNote}` })
  }
  if (measured.peakDbfs <= SILENT_PEAK_DB) {
    issues.push({ level: 'error', message: `几乎无声（峰值 ${fmt(measured.peakDbfs)} dBFS）` })
  } else if (measured.peakDbfs > PEAK_WARN_DB) {
    issues.push({ level: 'warn', message: `峰值 ${fmt(measured.peakDbfs)} dBFS 贴顶，叠进时间线会破` })
  }
  if (Math.abs(measured.dcOffset) > DC_WARN) {
    issues.push({ level: 'warn', message: `直流偏移 ${measured.dcOffset}，需要去直流` })
  }

  return {
    ...item,
    ok: !issues.some((issue) => issue.level === 'error'),
    error: null,
    issues,
    metrics: {
      ...baseMetrics(decoded, measured.durationSeconds, measured.peakDbfs),
      crestDb: measured.crestDb,
      clipping: measured.clipping,
      dcOffset: measured.dcOffset
    },
    out: null
  }
}

/**
 * `loudness`: measure and judge, never write.
 *
 * Compliance is judged against the true-peak ceiling always, and against
 * `targetLufs` only when the caller named one (the batch does not default a
 * loudness target for a measurement that is not going to be corrected).
 */
function loudnessItem (item, decoded, targetLufs) {
  const { analysis } = analyseDecoded(decoded)
  const lufs = finiteOr(analysis.integratedLufs, GATE_FLOOR_LUFS)
  const truePeakDbtp = finiteOr(analysis.truePeakDbtp, PEAK_FLOOR_DB)
  const silent = !Number.isFinite(analysis.integratedLufs)
  const issues = []
  if (silent) {
    issues.push({ level: 'error', message: `静音：没有任何 400 ms 块过 ${GATE_FLOOR_LUFS} LUFS 门限` })
  }
  if (!silent && truePeakDbtp > BATCH_CEILING_DBTP) {
    issues.push({ level: 'error', message: `真峰 ${fmt(truePeakDbtp)} dBTP 超过 ${fmt(BATCH_CEILING_DBTP)} dBTP 上限` })
  }
  if (!silent && targetLufs !== null && Math.abs(lufs - targetLufs) > LOUDNESS_TOLERANCE_LU) {
    issues.push({ level: 'warn', message: `实测 ${fmt(lufs)} LUFS，偏离目标 ${fmt(targetLufs)} LUFS ${signed(lufs - targetLufs)} LU` })
  }

  return {
    ...item,
    ok: !issues.some((issue) => issue.level === 'error'),
    error: null,
    issues,
    metrics: {
      ...baseMetrics(decoded, analysis.durationSeconds, analysis.samplePeakDbfs),
      lufs,
      truePeakDbtp,
      loudnessRangeLu: analysis.loudnessRangeLu,
      silent
    },
    out: null
  }
}

/**
 * `normalize`: a true-peak-safe linear gain, written as a copy.
 *
 * This is `audio_loudness`'s correction path (`planGain` toward the target under
 * the ceiling, minus the write guard) extended to every channel: one gain for
 * all of them, so the stereo/surround image cannot drift. A silent file has no
 * loudness to move and no gain `planGain` can derive, so it is an item error
 * instead of a copy of silence.
 */
async function normalizeItem (item, decoded, context) {
  const { analysis } = analyseDecoded(decoded)
  if (!Number.isFinite(analysis.integratedLufs)) {
    throw new Error(`静音文件没有可对齐的响度（没有块过 ${GATE_FLOOR_LUFS} LUFS 门限），未写副本`)
  }
  const plan = planGain(analysis, context.targetLufs, context.ceilingDbtp - WRITE_CEILING_GUARD_DB)
  const gain = dbToGain(plan.gainDb)
  const channels = decoded.channels.map((channel) => scaleChannel(channel, gain))
  const written = await writeCopy(context.outPath, channels, decoded.sampleRate)
  const after = analyseDecoded(written.decoded)
  const afterLufs = finiteOr(after.analysis.integratedLufs, GATE_FLOOR_LUFS)
  const afterTruePeak = finiteOr(after.analysis.truePeakDbtp, PEAK_FLOOR_DB)
  const targetHit = Math.abs(afterLufs - context.targetLufs) <= LOUDNESS_TOLERANCE_LU
  const issues = []
  if (!targetHit) {
    issues.push({
      level: 'warn',
      message: `目标 ${fmt(context.targetLufs)} LUFS，实际写到 ${fmt(afterLufs)} LUFS（${plan.limitedBy === 'true-peak' ? '被真峰上限卡住' : '未命中'}，差 ${fmt(context.targetLufs - afterLufs)} LU）`
    })
  }

  return {
    ...item,
    ok: true,
    error: null,
    issues,
    gainDb: round2(plan.gainDb),
    targetHit,
    limitedBy: plan.limitedBy,
    metrics: {
      ...baseMetrics(decoded, analysis.durationSeconds, analysis.samplePeakDbfs),
      lufs: finiteOr(analysis.integratedLufs, GATE_FLOOR_LUFS),
      truePeakDbtp: finiteOr(analysis.truePeakDbtp, PEAK_FLOOR_DB)
    },
    out: {
      path: context.outPath,
      label: displayPath(context.cwd, context.outPath),
      bytes: written.byteLength,
      metrics: {
        durationSeconds: after.analysis.durationSeconds,
        sampleRate: written.decoded.sampleRate,
        channels: written.decoded.channels.length,
        bitDepth: OUTPUT_BIT_DEPTH,
        lufs: afterLufs,
        truePeakDbtp: afterTruePeak
      }
    }
  }
}

/**
 * `master`: the full chain, one file at a time, `mode: 'memory'`.
 *
 * `memory` is the default and the right choice for a batch: each in-flight item
 * already holds one decoded file plus one output, and the fast mode would hold
 * one output buffer per search iteration on top of that. The two modes produce
 * identical bytes, so the batch pays no quality for the memory.
 *
 * `await` on a synchronous `masterChain` is a no-op microtask, but it keeps this
 * call correct if the chain gains a cooperative-yield variant (a generator
 * driven into an async function): the public result shape is the same either
 * way, so the batch does not need to know which one it got.
 */
async function masterItem (item, decoded, context) {
  const { analysis } = analyseDecoded(decoded)
  if (!Number.isFinite(analysis.integratedLufs)) {
    throw new Error(`静音文件没有可对齐的响度（没有块过 ${GATE_FLOOR_LUFS} LUFS 门限），未写副本`)
  }
  const chain = await masterChain(
    decoded.channels.length === 1 ? decoded.channels[0] : decoded.channels,
    decoded.sampleRate,
    {
      targetLufs: context.targetLufs,
      // The write guard is part of the ceiling promise: the encoded file must
      // still measure at or below the requested ceiling.
      ceilingDbtp: context.ceilingDbtp - WRITE_CEILING_GUARD_DB,
      mode: 'memory'
    }
  )
  const report = chain.report
  const outputChannels = decoded.channels.length === 1 ? [chain.samples] : chain.samples
  const written = await writeCopy(context.outPath, outputChannels, decoded.sampleRate)
  const after = analyseDecoded(written.decoded)
  const afterLufs = finiteOr(after.analysis.integratedLufs, GATE_FLOOR_LUFS)
  const afterTruePeak = finiteOr(after.analysis.truePeakDbtp, PEAK_FLOOR_DB)
  const targetHit = Math.abs(afterLufs - context.targetLufs) <= LOUDNESS_TOLERANCE_LU
  const issues = []
  if (!targetHit) {
    issues.push({
      level: 'warn',
      message: `目标 ${fmt(context.targetLufs)} LUFS，实际写到 ${fmt(afterLufs)} LUFS（${report.limitedBy === 'true-peak' ? '被真峰上限卡住' : report.limitedBy === 'iterations' ? '迭代用尽' : '未命中'}，差 ${fmt(report.shortfallLu)} LU）`
    })
  }

  return {
    ...item,
    ok: true,
    error: null,
    issues,
    gainDb: round2(report.appliedGainDb),
    targetHit,
    limitedBy: report.limitedBy,
    metrics: {
      ...baseMetrics(decoded, analysis.durationSeconds, analysis.samplePeakDbfs),
      lufs: finiteOr(analysis.integratedLufs, GATE_FLOOR_LUFS),
      truePeakDbtp: finiteOr(analysis.truePeakDbtp, PEAK_FLOOR_DB),
      limiterGainReductionDb: report.gainReductionDb,
      iterations: report.iterations
    },
    out: {
      path: context.outPath,
      label: displayPath(context.cwd, context.outPath),
      bytes: written.byteLength,
      metrics: {
        durationSeconds: after.analysis.durationSeconds,
        sampleRate: written.decoded.sampleRate,
        channels: written.decoded.channels.length,
        bitDepth: OUTPUT_BIT_DEPTH,
        lufs: afterLufs,
        truePeakDbtp: afterTruePeak
      }
    }
  }
}

/* ---------------------------------------------------------------- summary -- */

/**
 * Fold the item list into the numbers a caller decides from.
 *
 * `failures` and `warnings` are the two shared lists (every action); the
 * action-specific aggregates are added on top:
 *
 *   loudness   LUFS range, worst true peak, silence count, off-target list and
 *              the explicit non-compliant list;
 *   writing    copies written, LUFS range and worst peak of the *written* files,
 *              how many copies landed on target, and the worst shortfall.
 *
 * Everything here is a pure function of the items, so two identical runs
 * produce an identical summary.
 */
function buildSummary (action, items, targetLufs) {
  const failures = []
  const warnings = []
  for (const item of items) {
    if (!item.ok) {
      const first = item.issues.find((issue) => issue.level === 'error')
      failures.push({ label: item.label, message: item.error ?? (first === undefined ? '未处理' : first.message) })
      continue
    }
    const messages = item.issues.filter((issue) => issue.level === 'warn').map((issue) => issue.message)
    if (messages.length > 0) warnings.push({ label: item.label, messages })
  }

  const summary = {
    total: items.length,
    ok: items.length - failures.length,
    failed: failures.length,
    failures,
    warnings
  }

  if (action === 'check') return summary

  if (action === 'loudness') {
    const metered = items.filter((item) => item.metrics !== null)
    const measured = metered.filter((item) => item.metrics.silent !== true)
    const lufs = measured.map((item) => item.metrics.lufs)
    const peaks = metered
      .filter((item) => Number.isFinite(item.metrics.truePeakDbtp))
      .map((item) => item.metrics.truePeakDbtp)
    const offTarget = targetLufs === null
      ? []
      : measured
          .filter((item) => Math.abs(item.metrics.lufs - targetLufs) > LOUDNESS_TOLERANCE_LU)
          .map((item) => ({ label: item.label, lufs: item.metrics.lufs, deviationLu: round2(item.metrics.lufs - targetLufs) }))
    // One explicit "does not pass" list, the way a delivery report is read: a
    // clean file is absent, and a file that failed the gate appears with every
    // reason it is there (a corrupt file carries its read error instead).
    const nonCompliant = items
      .map((item) => {
        const reasons = item.issues.map((issue) => issue.message)
        if (!item.ok && item.error !== null) reasons.unshift(item.error)
        return { label: item.label, reasons }
      })
      .filter((entry) => entry.reasons.length > 0)
    return {
      ...summary,
      measured: measured.length,
      silent: items.filter((item) => item.metrics !== null && item.metrics.silent === true).length,
      lufsMin: lufs.length > 0 ? Math.min(...lufs) : null,
      lufsMax: lufs.length > 0 ? Math.max(...lufs) : null,
      truePeakMaxDbtp: peaks.length > 0 ? Math.max(...peaks) : null,
      targetLufs,
      offTarget,
      nonCompliant
    }
  }

  // Writing actions: the numbers that matter are the ones on disk.
  const written = items.filter((item) => item.out !== null)
  const lufs = written.map((item) => item.out.metrics.lufs)
  const peaks = written.map((item) => item.out.metrics.truePeakDbtp)
  const gains = written.filter((item) => Number.isFinite(item.gainDb)).map((item) => item.gainDb)
  const targetHit = written.filter((item) => item.targetHit === true).length
  const missed = written
    .filter((item) => item.targetHit !== true)
    .map((item) => ({
      label: item.label,
      lufs: item.out.metrics.lufs,
      shortfallLu: round2(Math.max(0, targetLufs - item.out.metrics.lufs)),
      limitedBy: item.limitedBy ?? null
    }))
  return {
    ...summary,
    written: written.length,
    lufsMin: lufs.length > 0 ? Math.min(...lufs) : null,
    lufsMax: lufs.length > 0 ? Math.max(...lufs) : null,
    truePeakMaxDbtp: peaks.length > 0 ? Math.max(...peaks) : null,
    gainDbMin: gains.length > 0 ? Math.min(...gains) : null,
    gainDbMax: gains.length > 0 ? Math.max(...gains) : null,
    targetLufs,
    targetHit,
    targetMissed: missed,
    shortfallMaxLu: missed.length > 0 ? Math.max(...missed.map((entry) => entry.shortfallLu)) : 0
  }
}

/* -------------------------------------------------------------------- text -- */

/** One per-file line: the numbers a reader checks without opening the JSON. */
function itemLine (item) {
  const parts = [`  ${item.label}${item.at === null ? '' : ` @${fmt(item.at, 2)}s`}`]
  if (!item.ok) {
    const first = item.issues.find((issue) => issue.level === 'error')
    parts.push(`FAIL ${item.error ?? (first === undefined ? '' : first.message)}`)
    return parts.join('  ')
  }
  const metrics = item.metrics
  if (metrics !== null && typeof metrics.lufs === 'number') {
    parts.push(`${fmt(metrics.lufs)} LUFS · 真峰 ${fmt(metrics.truePeakDbtp)} dBTP`)
  } else if (metrics !== null) {
    parts.push(`${fmt(metrics.durationSeconds, 2)}s · 峰值 ${fmt(metrics.peakDbfs)} dBFS`)
  }
  if (Number.isFinite(item.gainDb)) parts.push(`增益 ${signed(item.gainDb)} dB`)
  if (item.out !== null && item.out.metrics !== undefined) {
    parts.push(`→ ${item.out.label}（${fmt(item.out.metrics.lufs)} LUFS / ${fmt(item.out.metrics.truePeakDbtp)} dBTP）`)
  }
  const warnings = item.issues.filter((issue) => issue.level === 'warn').map((issue) => issue.message)
  if (warnings.length > 0) parts.push(warnings.join('；'))
  return parts.join('  ')
}

/**
 * The human summary the model reads instead of the JSON.
 *
 * Bounded on purpose: for dozens of files the useful shape is a headline, every
 * failure, a sample of the successful work, and the totals — not forty lines of
 * per-file numbers that push the verdict off the screen.
 *
 * @param {object} result - `runBatch` result.
 * @returns {string} multi-line report.
 */
export function batchText (result) {
  const labels = { check: '批量质检', loudness: '批量响度', normalize: '批量响度校正', master: '批量母带' }
  const summary = result.summary
  const lines = []
  const parts = [`${labels[result.action] ?? result.action}：${summary.total} 个文件`, `成功 ${summary.ok}`, `失败 ${summary.failed}`]
  if (summary.written !== undefined) parts.push(`写出副本 ${summary.written}`)
  lines.push(parts.join('，'))

  if (summary.total > 0) {
    const shown = result.items.slice(0, REPORT_LINE_LIMIT)
    for (const item of shown) lines.push(itemLine(item))
    if (result.items.length > shown.length) {
      lines.push(`  …另有 ${result.items.length - shown.length} 个文件，明细见 items`)
    }
  }

  // Aggregate the action's own promise in one line: a range is what a batch is
  // for. check has no aggregate beyond the failure list above.
  if (result.action === 'loudness' && summary.measured > 0) {
    const range = `${fmt(summary.lufsMin)}..${fmt(summary.lufsMax)} LUFS`
    const target = summary.targetLufs === null ? '' : `，偏离目标 ${fmt(summary.targetLufs)} LUFS ${summary.offTarget.length} 个`
    lines.push(`  LUFS 区间 ${range}，最差真峰 ${fmt(summary.truePeakMaxDbtp)} dBTP，静音 ${summary.silent} 个，不合规 ${summary.nonCompliant.length} 个${target}`)
  }
  if (summary.written !== undefined && summary.written > 0) {
    lines.push(`  写出文件 ${fmt(summary.lufsMin)}..${fmt(summary.lufsMax)} LUFS，最差真峰 ${fmt(summary.truePeakMaxDbtp)} dBTP，命中目标 ${summary.targetHit}/${summary.written}${summary.targetMissed.length > 0 ? `，最大差额 ${fmt(summary.shortfallMaxLu)} LU` : ''}`)
    if (result.outDirLabel !== null) lines.push(`  输出目录：${result.outDirLabel}`)
  }

  for (const warning of result.warnings) lines.push(`  注意：${warning}`)
  const pool = result.pool
  lines.push(`  并发：上限 ${pool.limit}（本次 ${pool.lanes} 条泳道，实测同时在飞最多 ${pool.maxInFlight} 个）；${pool.note}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------- batch -- */

/**
 * Run one action over a list of files.
 *
 * @param {object} options
 * @param {string} [options.cwd] - session directory; defaults to `process.cwd()`.
 * @param {string[]} [options.files] - wav paths (mutually exclusive with `cues`).
 * @param {{ path: string, at?: number }[]} [options.cues] - cue entries.
 * @param {'check'|'loudness'|'normalize'|'master'} [options.action] - default 'check'.
 * @param {number} [options.targetLufs] - default -14 for normalize/master.
 * @param {string} [options.outDir] - default `out/batch`.
 * @param {number} [options.concurrency] - 1..8, default half the CPUs (max 4).
 * @returns {Promise<object>} `{ ok, action, targetLufs, outDir, outDirLabel, concurrency, items, summary, warnings, pool, text }`.
 */
export async function runBatch (options = {}) {
  const cwd = options.cwd === undefined || options.cwd === null ? process.cwd() : String(options.cwd)
  const action = resolveAction(options.action)
  const targetLufs = resolveTargetLufs(action, options.targetLufs)
  const limit = resolveConcurrency(options.concurrency)
  const { items: resolved, duplicates } = resolveBatchItems(cwd, options.files, options.cues)
  const writes = WRITING_ACTIONS.has(action)
  const ceilingDbtp = BATCH_CEILING_DBTP

  // Output directory and names are planned before the first byte is read: a
  // name collision or an unwritable directory must fail the call, not 40 items.
  let outDir = null
  let outDirLabel = null
  let outputs = []
  if (writes) {
    outDir = resolveOutDir(cwd, options.outDir)
    try {
      await mkdir(outDir, { recursive: true })
    } catch (error) {
      throw new Error(`audio_batch: 无法创建输出目录 ${displayPath(cwd, outDir)}（${error.code ?? error.message}）`)
    }
    outDirLabel = displayPath(cwd, outDir)
    outputs = planOutputs(resolved, outDir, action)
  }

  // Every input path, so an output can be refused if it would overwrite *any*
  // source file — not just its own. The label makes the error name the file
  // that would have been destroyed.
  const inputLabels = new Map(resolved.map((item) => [pathKey(item.path), item.label]))

  const warnings = []
  if (duplicates > 0) warnings.push(`去重：跳过了 ${duplicates} 条重复条目（同一路径同一个 at）`)

  /** Process one file and never throw: a failed item is data, not an abort. */
  const processItem = async (item, index) => {
    const base = { path: item.path, label: item.label, at: item.at }
    const outPath = writes ? outputs[index] : null
    const clobbered = outPath === null ? undefined : inputLabels.get(pathKey(outPath))
    if (clobbered !== undefined) {
      // Refused per item, not thrown: the other 39 files are still worth doing,
      // and the caller needs to see exactly which pair collided.
      return {
        ...base,
        ok: false,
        error: `拒绝覆盖输入文件：${action} 的副本要写到 ${displayPath(cwd, outPath)}，而它正是输入 ${clobbered}；换一个 outDir 再跑`,
        issues: [],
        metrics: null,
        out: null
      }
    }
    try {
      const decoded = await readChannels(item.path)
      if (action === 'check') return checkItem(base, decoded)
      if (action === 'loudness') return loudnessItem(base, decoded, targetLufs)
      if (action === 'normalize') {
        return await normalizeItem(base, decoded, { cwd, outPath, targetLufs, ceilingDbtp })
      }
      return await masterItem(base, decoded, { cwd, outPath, targetLufs, ceilingDbtp })
    } catch (error) {
      return {
        ...base,
        ok: false,
        error: String(error?.message ?? error),
        issues: [],
        metrics: null,
        out: null
      }
    }
  }

  const { results, maxInFlight, lanes } = await runPool(resolved, limit, processItem)
  const summary = buildSummary(action, results, targetLufs)

  const result = {
    ok: summary.failed === 0 && summary.total > 0,
    action,
    targetLufs,
    outDir,
    outDirLabel,
    concurrency: limit,
    items: results,
    summary,
    warnings,
    pool: {
      limit,
      lanes,
      maxInFlight,
      // The honest sentence: the pool overlaps I/O, it does not parallelise DSP.
      note: `并发只让读盘/解码/写盘的等待重叠；DSP 是同步 JS，CPU 一次只算一个文件，不会真的并行。同时在飞最多 ${lanes} 份样本会一起占内存。`,
      cpuCount: cpuCount(),
      cpuBound: 'serial'
    }
  }
  result.text = batchText(result)
  return result
}
