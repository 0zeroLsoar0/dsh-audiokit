/**
 * `audio_loudness`: the question `audio_probe` cannot answer.
 *
 * Peak/RMS tells you a file is technically present; LUFS tells you whether it
 * will sit at the same perceived level as the audio next to it, and dBTP tells
 * you whether that level survives the encoder. This tool measures either a file
 * on disk or an inline render spec (so a sound can be auditioned in numbers
 * before anything is written), and can write a true-peak-safe gain-corrected
 * copy toward a target (-14 web / -16 podcast / -23 broadcast).
 *
 * Two things this tool owns, because the measurement layer alone cannot:
 *
 * - **A correctable copy keeps the file's shape.** Mono, stereo, quad, 5.1 and
 *   7.1 all get one linked gain computed from the same BS.1770-4 channel
 *   decision the meter uses (`multichannel.loudnessChannels`: LFE excluded from
 *   the loudness sum, surrounds at +1.5 dB), so the copy lands on the target
 *   without moving the image, and the channel layout and 16/24-bit depth of the
 *   source are preserved. The true-peak ceiling is checked against every
 *   channel of the written bytes (LFE included), because that is the promise an
 *   encoder makes.
 * - **Non-finite samples are reported, not measured.** A file carrying NaN or
 *   ±Infinity makes peak/RMS/loudness computations produce numbers that look
 *   like readings (`Infinity dBFS`, a fake "silent", crest `NaN`). Such a file
 *   is described as broken instead, and it cannot be normalised into a
 *   plausible-looking deliverable.
 *
 * Mono weighting note: the meter measures a mono file at the standard BS.1770-4
 * single-channel weight by default, which is what ffmpeg's `ebur128` reports.
 * `dualMono: true` is available for callers comparing against this plugin's
 * historical mono numbers (+3.01 LU).
 */

import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  finalize,
  measureChannels,
  renderPreset,
  resolvePath,
  writeFileAtomic
} from './audio.js'
import { PRESETS, dbToGain } from './dsp.js'
import { analyzeLoudness, planGain, truePeak } from './lufs.js'
import { CHANNEL_COUNTS, encodeAnyWav, layoutFor, loudnessChannels } from './multichannel.js'
import { countNonFiniteSamples } from './tools.js'
import { decodeWav } from './wav.js'

const PRESET_NAMES = Object.keys(PRESETS)

/**
 * Wav bit depths a corrected copy can keep. 16 and 24 are what both the plain
 * and the extensible writer support, so a source at either one keeps its depth;
 * 8/32-bit sources are written at 16-bit and say so.
 */
const WRITABLE_BIT_DEPTHS = [16, 24]
const DEFAULT_WRITE_BIT_DEPTH = 16

/**
 * Written files stay this far below the true-peak ceiling so 16-bit
 * quantisation (and the encoder's dither) cannot measure back above it.
 */
const WRITE_CEILING_GUARD_DB = 0.02

/** A trim never lands exactly on the ceiling: a hundredth of a dB of margin. */
const WRITE_TRIM_MARGIN_DB = 0.01

/** One linear trim after encoding is enough; only a pathological file needs more. */
const WRITE_TRIM_ATTEMPTS = 2

/** "On target" for the copy that actually landed on disk, in LU. */
const WRITTEN_TARGET_TOLERANCE_LU = 0.5

/**
 * Absolute gate floor used when a measurement is impossible (silence). The
 * pure module reports -Infinity, which JSON turns into null; the tool reports
 * the gate floor and `gatedBlocks: 0` instead, so every metric stays a number.
 */
const GATE_FLOOR_LUFS = -70
/** Peak floor used by the rest of the plugin for "no signal". */
const PEAK_FLOOR_DB = -120

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

function fmt (value, digits = 1) {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  const text = Number(value).toFixed(digits)
  // Avoid "-0" in user-facing text.
  return Number(text) === 0 ? '0' : text.replace(/\.0+$/, '')
}

function signed (value, digits = 1) {
  return `${value >= 0 ? '+' : ''}${fmt(value, digits)}`
}

function sizeLabel (bytes) {
  return bytes >= 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function round2 (value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

function round3 (value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value
}

/** Loudness fields every result carries; finite numbers only (see GATE_FLOOR_LUFS). */
function loudnessMetrics (analysis) {
  const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback)
  return {
    lufs: finiteOr(analysis.integratedLufs, GATE_FLOOR_LUFS),
    shortTermMaxLufs: finiteOr(analysis.shortTermMaxLufs, GATE_FLOOR_LUFS),
    momentaryMaxLufs: finiteOr(analysis.momentaryMaxLufs, GATE_FLOOR_LUFS),
    truePeakDbtp: finiteOr(analysis.truePeakDbtp, PEAK_FLOOR_DB),
    loudnessRangeLu: analysis.loudnessRangeLu,
    gatedBlocks: analysis.gatedBlocks,
    silent: !Number.isFinite(analysis.integratedLufs)
  }
}

/** The before/after numbers a caller compares: loudness, peaks and gating. */
function snapshot (analysis) {
  const metrics = loudnessMetrics(analysis)
  return {
    lufs: metrics.lufs,
    shortTermMaxLufs: metrics.shortTermMaxLufs,
    momentaryMaxLufs: metrics.momentaryMaxLufs,
    truePeakDbtp: metrics.truePeakDbtp,
    samplePeakDbfs: analysis.samplePeakDbfs,
    loudnessRangeLu: analysis.loudnessRangeLu,
    gatedBlocks: analysis.gatedBlocks
  }
}

/**
 * Replace every non-finite number in a metric tree with `null`.
 *
 * A measurement computed over NaN/±Infinity samples is not a measurement, and
 * JSON turns those values into `null` anyway; doing it here means the in-memory
 * result a caller sees and the serialised one agree, and nothing prints
 * `Infinity dBFS` or a crest of `NaN`.
 */
function sanitiseNonFinite (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(sanitiseNonFinite)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = sanitiseNonFinite(item)
    return out
  }
  return value
}

/** Worst 4x true peak across every channel: the ceiling is a property of the file. */
function fileTruePeak (channels, sampleRate) {
  let worst = Number.NEGATIVE_INFINITY
  for (const channel of channels) {
    const peak = truePeak(channel, sampleRate)
    if (peak > worst) worst = peak
  }
  return worst
}

/** Measure a channel list exactly the way `audio_master` and `audio_check` do. */
function measureLoudness (channels, sampleRate, dualMono) {
  const { measured, weights, lfeExcluded } = loudnessChannels(channels)
  const analysis = analyzeLoudness(measured[0], sampleRate, { channels: measured, weights, dualMono })
  return { analysis, loudnessChannels: measured.length, weights, lfeExcluded }
}

/** Scale every channel by one gain into fresh buffers (the caller's stay untouched). */
function scaleChannels (channels, gain) {
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let index = 0; index < channel.length; index += 1) out[index] = channel[index] * gain
    return out
  })
}

/** The bit depth a corrected copy is written at, given the source's. */
function writeBitDepthOf (sourceBitDepth) {
  return WRITABLE_BIT_DEPTHS.includes(sourceBitDepth) ? sourceBitDepth : DEFAULT_WRITE_BIT_DEPTH
}

/**
 * Refuse an `out` that is the input file.
 *
 * A measurement tool that overwrites the file it was asked to measure has
 * destroyed the source of the number it reports, and batch/editing callers rely
 * on "measure + write a copy" never touching the original. The path comparison
 * covers a relative/absolute spelling of the same name (and Windows case);
 * `dev`/`ino` covers a link, a hard link or a differently spelled path to the
 * same file. Both are cheap and both are wrong to skip.
 */
async function assertNotInput (outPath, sourcePath) {
  if (sourcePath === null) return
  const out = resolve(outPath)
  const source = resolve(sourcePath)
  const samePath = process.platform === 'win32' ? out.toLowerCase() === source.toLowerCase() : out === source
  if (samePath) {
    throw new Error(`audio_loudness refuses to overwrite its input (${sourcePath}); choose another \`out\` path`)
  }
  let outInfo
  try {
    outInfo = await stat(out)
  } catch {
    return
  }
  const sourceInfo = await stat(source)
  if (outInfo.dev === sourceInfo.dev && outInfo.ino === sourceInfo.ino && sourceInfo.ino !== 0) {
    throw new Error(`audio_loudness refuses to overwrite its input (${sourcePath}); \`out\` resolves to the same file`)
  }
}

function lraLabel (analysis) {
  if (analysis.loudnessRangeLu > 0) return `LRA ${fmt(analysis.loudnessRangeLu, 1)} LU`
  if (analysis.shortTermBasis === 'short-term') return 'LRA 0 LU (flat)'
  return 'LRA n/a (<3s)'
}

function measureLine (verb, cwd, info, analysis, metrics, notes = []) {
  const where = info.path === null ? 'inline render' : displayPath(cwd, info.path)
  const meta = [`${fmt(analysis.durationSeconds, 2)}s`, `${info.sampleRate} Hz`]
  if (info.channelCount !== undefined) meta.push(info.channelCount === 1 ? 'mono' : `${info.channelCount} ch`)
  if (info.bytes !== null) meta.push(sizeLabel(info.bytes))
  const parts = [`${verb} ${where} (${meta.join(', ')})`]
  // A poisoned file has no level to report: say why instead of printing a
  // fake "silent", a floor value or "inf dBFS" as if it were a reading.
  if (notes.length > 0) {
    parts.push(...notes)
    return parts.join(' \u00b7 ')
  }
  parts.push(Number.isFinite(analysis.integratedLufs)
    ? `${fmt(analysis.integratedLufs, 1)} LUFS integrated`
    : `silent (nothing above the ${GATE_FLOOR_LUFS} LUFS gate)`)
  if (Number.isFinite(analysis.momentaryMaxLufs)) parts.push(`momentary max ${fmt(analysis.momentaryMaxLufs, 1)} LUFS`)
  parts.push(`true peak ${Number.isFinite(analysis.truePeakDbtp) ? `${fmt(analysis.truePeakDbtp, 1)} dBTP` : 'none'}`)
  parts.push(`sample peak ${fmt(analysis.samplePeakDbfs, 1)} dBFS`)
  parts.push(lraLabel(analysis))
  parts.push(analysis.blocksMeasured > 0
    ? `gated ${analysis.gatedBlocks}/${analysis.blocksMeasured} blocks`
    : 'shorter than one 400 ms block (whole file as one)')
  if (metrics.clipping > 0) parts.push(`CLIPPING ${metrics.clipping} samples`)
  else parts.push('no clipping')
  return parts.join(' \u00b7 ')
}

function targetLine (plan) {
  const head = `Target ${fmt(plan.targetLufs, 1)} LUFS at <= ${fmt(plan.ceilingDbtp, 1)} dBTP`
  if (!Number.isFinite(plan.predictedLufs)) return `${head}: file is silent, nothing to normalise`
  if (plan.achievable) {
    return `${head}: gain ${signed(plan.gainDb)} dB -> ${fmt(plan.predictedLufs, 1)} LUFS / ${fmt(plan.predictedDbtp, 1)} dBTP`
  }
  return `${head}: true peak allows only ${signed(plan.gainDb)} dB -> ${fmt(plan.predictedLufs, 1)} LUFS (${fmt(plan.targetLufs - plan.predictedLufs, 1)} LU short of target)`
}

/**
 * Register the `audio_loudness` tool.
 * @param {object} ctx - Cordis context with the tools service.
 */
export function registerLoudnessTools (ctx) {
  ctx.tools.register({
    name: 'audio_loudness',
    description: 'Measure ITU-R BS.1770-4 loudness: integrated LUFS, short-term/momentary maxima, loudness range and true peak, for a .wav or an inline render; optionally write a true-peak-safe gain-corrected copy toward a target loudness (mono, stereo, quad, 5.1 and 7.1 keep their layout). Use it instead of audio_probe when the question is \'how loud\', not \'is it clipping\'.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Wav file to measure; give either path or render.' },
        render: {
          type: 'object',
          additionalProperties: true,
          description: 'Inline render spec to measure without writing; give either path or render.',
          properties: {
            preset: { type: 'string', enum: PRESET_NAMES, description: 'Sound family, same names as audio_synth.' },
            params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs, same names as audio_synth.' },
            duration: { type: 'number', description: 'Length in seconds; defaults to the preset length.' },
            seed: { type: 'integer', description: 'Variation seed.' },
            sampleRate: { type: 'integer', description: 'Defaults to 44100.' },
            loop: { type: 'boolean', description: 'Render a seamless loop before measuring.' }
          },
          required: ['preset']
        },
        targetLufs: { type: 'number', description: 'Optional target LUFS (-14 web, -16 podcast, -23 broadcast); writes a copy with `out`.' },
        ceilingDbtp: { type: 'number', description: 'Max true peak for the correction, default -1 dBTP, clamped to [-20, 0].' },
        dualMono: { type: 'boolean', description: 'Mono files use the standard BS.1770-4 single-channel weight by default (the number ffmpeg reports); true switches to the old dual-mono convention (+3.01 LU). Stereo and surround are unaffected.' },
        out: { type: 'string', description: 'Output path for the corrected copy; only used with targetLufs, and it must not be the input file.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args.targetLufs === 'number' ? `Loudness -> ${args.targetLufs} LUFS` : 'Measure loudness',
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const requestedPath = resolvePath(cwd, args.path)
      const wantsRender = args.render !== undefined && args.render !== null
      if (wantsRender && requestedPath !== undefined) throw new Error('audio_loudness takes either `path` or `render`, not both')
      if (!wantsRender && requestedPath === undefined) throw new Error('audio_loudness needs a wav `path` or an inline `render` spec')
      const dualMono = args.dualMono === true

      // --- get samples ------------------------------------------------------
      let channels
      let sampleRate
      let sourcePath = null
      let sourceBytes = null
      let sourceBitDepth = DEFAULT_WRITE_BIT_DEPTH
      if (wantsRender) {
        const spec = args.render
        const rendered = renderPreset({
          preset: spec.preset,
          params: spec.params ?? {},
          duration: spec.duration,
          seed: spec.seed ?? 1,
          sampleRate: spec.sampleRate ?? 44100,
          loop: spec.loop === true
        })
        // Finalise exactly like audio_synth does before writing, so the numbers
        // describe the file the caller would actually get — including the
        // loop-safe DC blocker for a loop render.
        const mono = finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
        channels = [mono]
        sampleRate = rendered.sampleRate
      } else {
        const bytes = await readFile(requestedPath)
        const decoded = decodeWav(bytes)
        channels = decoded.channels
        sampleRate = decoded.sampleRate
        sourceBitDepth = decoded.bitDepth
        sourcePath = requestedPath
        sourceBytes = bytes.length
      }
      // A poisoned file is not a quiet file. Counted before anything is
      // measured so the result can say "broken", not "silent".
      const nonFinite = countNonFiniteSamples(channels)
      const poisoned = nonFinite.total > 0

      // One channel decision for every rate/count: LFE excluded, surround
      // channels weighted as BS.1770-4 specifies. `audio_master` uses the same
      // helper, so the two tools report the same LUFS for the same file.
      const { analysis, loudnessChannels: measuredChannels, weights, lfeExcluded } = measureLoudness(channels, sampleRate, dualMono)
      const sourceMetrics = {
        // Every channel, so a stereo file's `clipping` and `peak` are the file's,
        // not a mono fold's.
        ...measureChannels(channels, sampleRate),
        sampleRate,
        channelCount: channels.length,
        channelLayout: layoutFor(channels.length).id,
        lfeExcluded,
        loudnessChannels: measuredChannels,
        channelWeights: analysis.channelWeights,
        dualMono: analysis.dualMono,
        ...loudnessMetrics(analysis)
      }
      const notes = []
      if (poisoned) {
        // Not a measurement: the numbers computed over NaN/Inf are shapes, not
        // levels, so they are withheld instead of being printed as readings.
        const where = nonFinite.perChannel
          .map((channel, index) => ({ index, ...channel }))
          .filter((channel) => channel.nan + channel.infinite > 0)
          .map((channel) => `ch${channel.index + 1} NaN ${channel.nan}, Inf ${channel.infinite}`)
          .join('; ')
        notes.push(`non-finite samples: ${nonFinite.total} of ${nonFinite.samples} (${where}); loudness and peak readings are not meaningful`)
      }
      const reportedMetrics = poisoned
        ? {
            ...sanitiseNonFinite(sourceMetrics),
            // A metric computed over NaN/±Infinity is not a measurement, so the
            // level numbers are withheld the way `audio_probe` withholds them:
            // `null`, not a floor value and not `Infinity dBFS`.
            peakDbfs: null,
            rmsDbfs: null,
            crestDb: null,
            dcOffset: null,
            onsets: null,
            loopSeam: null,
            loopStep: null,
            lufs: null,
            shortTermMaxLufs: null,
            momentaryMaxLufs: null,
            truePeakDbtp: null,
            loudnessRangeLu: null,
            silent: false
          }
        : sourceMetrics
      const reportedAnalysisSnapshot = poisoned
        ? { lufs: null, shortTermMaxLufs: null, momentaryMaxLufs: null, truePeakDbtp: null, samplePeakDbfs: null, loudnessRangeLu: null, gatedBlocks: analysis.gatedBlocks }
        : snapshot(analysis)

      // --- optional gain plan and corrected copy ----------------------------
      const targetLufs = Number.isFinite(args.targetLufs) ? Number(args.targetLufs) : undefined
      const ceilingDbtp = Number.isFinite(args.ceilingDbtp) ? Number(args.ceilingDbtp) : -1
      const plan = targetLufs === undefined ? null : planGain(analysis, targetLufs, ceilingDbtp)
      const outPath = resolvePath(cwd, args.out)
      if (plan !== null && outPath !== undefined) await assertNotInput(outPath, sourcePath)

      let written = null
      let after = null
      let resultMetrics = reportedMetrics
      if (plan !== null && outPath !== undefined) {
        if (poisoned) {
          throw new Error(`audio_loudness cannot normalise a file with ${nonFinite.total} non-finite sample(s): its level is not a measurement`)
        }
        if (!Number.isFinite(analysis.integratedLufs)) {
          throw new Error('audio_loudness cannot normalise a silent file: no 400 ms block clears the -70 LUFS gate')
        }
        if (!CHANNEL_COUNTS.includes(channels.length)) {
          throw new Error(`audio_loudness can write a corrected copy of a ${CHANNEL_COUNTS.join(', ')}-channel file (WAVE layout); this file has ${channels.length} channels — measure it instead`)
        }
        const bitDepth = writeBitDepthOf(sourceBitDepth)
        if (channels.length > 2 && !WRITABLE_BIT_DEPTHS.includes(bitDepth)) {
          throw new Error(`audio_loudness writes a ${channels.length}-channel copy at ${WRITABLE_BIT_DEPTHS.join(' or ')} bits, got ${bitDepth}-bit`)
        }

        // The ceiling is about the file, LFE included: `planGain` must see the
        // worst channel of the whole layout, not just the loudness channels.
        const filePeak = fileTruePeak(channels, sampleRate)
        const planAnalysis = { ...analysis, truePeakDbtp: Math.max(analysis.truePeakDbtp, filePeak) }
        // Re-plan against a slightly lower ceiling: the ceiling is a promise
        // about the *encoded* file, and integer quantisation can add a fraction
        // of a dB at the peak.
        const writePlan = planGain(planAnalysis, targetLufs, ceilingDbtp - WRITE_CEILING_GUARD_DB)
        if (!Number.isFinite(writePlan.gainDb)) {
          throw new Error('audio_loudness could not derive a gain for this file (its loudness or peak is not a finite number)')
        }
        const planGainDb = writePlan.gainDb
        let gainDb = planGainDb
        let corrected = scaleChannels(channels, dbToGain(gainDb))
        let bytes = encodeAnyWav(corrected, sampleRate, { bitDepth })
        // Measure what landed on disk, not what we hoped to write: that is the
        // number the user will ship. A linear trim lowers the true peak by
        // exactly its dB value, so one correction is enough for quantisation.
        let writtenDecoded = decodeWav(bytes)
        let writtenPeak = fileTruePeak(writtenDecoded.channels, writtenDecoded.sampleRate)
        for (let attempt = 0; attempt < WRITE_TRIM_ATTEMPTS && Number.isFinite(writtenPeak) && writtenPeak > ceilingDbtp; attempt += 1) {
          const trimDb = ceilingDbtp - WRITE_TRIM_MARGIN_DB - writtenPeak
          gainDb += trimDb
          corrected = scaleChannels(corrected, dbToGain(trimDb))
          bytes = encodeAnyWav(corrected, sampleRate, { bitDepth })
          writtenDecoded = decodeWav(bytes)
          writtenPeak = fileTruePeak(writtenDecoded.channels, writtenDecoded.sampleRate)
        }
        await writeFileAtomic(outPath, bytes)
        const info = await stat(outPath)
        const writtenLoudness = measureLoudness(writtenDecoded.channels, writtenDecoded.sampleRate, dualMono)
        const afterAnalysis = writtenLoudness.analysis
        const afterLufs = afterAnalysis.integratedLufs
        after = snapshot(afterAnalysis)
        const truePeakDbtp = Number.isFinite(writtenPeak) ? round3(writtenPeak) : PEAK_FLOOR_DB
        const targetHit = Number.isFinite(afterLufs) && Math.abs(afterLufs - targetLufs) <= WRITTEN_TARGET_TOLERANCE_LU
        resultMetrics = {
          ...measureChannels(writtenDecoded.channels, writtenDecoded.sampleRate),
          sampleRate: writtenDecoded.sampleRate,
          channelCount: writtenDecoded.channels.length,
          channelLayout: layoutFor(writtenDecoded.channels.length).id,
          bitDepth: writtenDecoded.bitDepth,
          lfeExcluded: writtenLoudness.lfeExcluded,
          loudnessChannels: writtenLoudness.loudnessChannels,
          channelWeights: afterAnalysis.channelWeights,
          dualMono: afterAnalysis.dualMono,
          ...loudnessMetrics(afterAnalysis)
        }
        written = {
          path: outPath,
          relativePath: displayPath(cwd, outPath),
          bytes: info.size,
          durationSeconds: afterAnalysis.durationSeconds,
          sampleRate: writtenDecoded.sampleRate,
          channelCount: writtenDecoded.channels.length,
          channelLayout: layoutFor(writtenDecoded.channels.length).id,
          bitDepth: writtenDecoded.bitDepth,
          /** The total gain the file received, including the post-encode trim. */
          gainDb: round2(gainDb),
          appliedGainDb: round2(gainDb),
          plannedGainDb: round2(planGainDb),
          trimDb: round3(gainDb - planGainDb),
          limitedBy: writePlan.limitedBy,
          targetHit,
          shortfallLu: targetHit ? 0 : round2(Math.max(0, targetLufs - (Number.isFinite(afterLufs) ? afterLufs : GATE_FLOOR_LUFS))),
          lufs: Number.isFinite(afterLufs) ? round3(afterLufs) : null,
          truePeakDbtp
        }
      }

      // --- bounded human summary -------------------------------------------
      const lines = []
      lines.push(measureLine('Measured', cwd, { path: sourcePath, bytes: sourceBytes, sampleRate, channelCount: channels.length }, analysis, sourceMetrics, notes))
      if (channels.length > 2) {
        const surroundWeight = Math.max(...weights)
        lines.push(`  ${layoutFor(channels.length).id}：LUFS 在 ${measuredChannels} 个非 LFE 声道上测量，环绕声道权重 ×${fmt(surroundWeight, 2)}（与 audio_master 同一口径）`)
      }
      if (analysis.dualMono) {
        lines.push('  dual-mono：单声道按 ×2 计权（历史口径，比标准 BS.1770 单声道高 3.01 LU）；默认口径与 ffmpeg 一致')
      }
      if (plan !== null) {
        lines.push(targetLine(plan))
        if (outPath === undefined) lines.push('Pass `out` to write the gain-corrected copy.')
      } else if (outPath !== undefined) {
        lines.push('`out` is ignored without `targetLufs`.')
      }
      if (written !== null && after !== null) {
        lines.push(`Wrote ${written.relativePath} (${fmt(written.durationSeconds, 2)}s, ${written.bitDepth}-bit ${written.channelLayout} ${written.sampleRate} Hz, ${sizeLabel(written.bytes)}): ${fmt(written.lufs, 1)} LUFS integrated, true peak ${fmt(written.truePeakDbtp, 1)} dBTP, gain ${signed(written.appliedGainDb)} dB${written.targetHit ? '' : ` (target capped: ${fmt(written.shortfallLu, 1)} LU short, ${written.limitedBy})`}`)
      }

      const reportedPath = written !== null ? written.path : sourcePath
      return {
        path: reportedPath,
        relativePath: reportedPath === null ? null : displayPath(cwd, reportedPath),
        bytes: written !== null ? written.bytes : (sourceBytes ?? 0),
        durationSeconds: written === null ? analysis.durationSeconds : written.durationSeconds,
        sampleRate: written === null ? sampleRate : written.sampleRate,
        channelCount: written === null ? channels.length : written.channelCount,
        nonFiniteSamples: nonFinite.total,
        notes,
        metrics: resultMetrics,
        before: reportedAnalysisSnapshot,
        after,
        target: plan,
        written,
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
