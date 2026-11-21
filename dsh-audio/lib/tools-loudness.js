/**
 * `audio_loudness`: the question `audio_probe` cannot answer.
 *
 * Peak/rMS tells you a file is technically present; LUFS tells you whether it
 * will sit at the same perceived level as the audio next to it, and dBTP tells
 * you whether that level survives the encoder. This tool measures either a file
 * on disk or an inline render spec (so a sound can be auditioned in numbers
 * before anything is written), and can write a true-peak-safe gain-corrected
 * copy toward a target (-14 web / -16 podcast / -23 broadcast).
 */

import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  finalize,
  measure,
  renderPreset,
  resolvePath,
  toWavBytes,
  writeFileAtomic
} from './audio.js'
import { PRESETS } from './dsp.js'
import { analyzeLoudness, planGain } from './lufs.js'
import { decodeWav } from './wav.js'

const PRESET_NAMES = Object.keys(PRESETS)

/**
 * Written files stay this far below the true-peak ceiling so 16-bit
 * quantisation (and the encoder's dither) cannot measure back above it.
 */
const WRITE_CEILING_GUARD_DB = 0.02

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

function averageChannels (channels) {
  const frames = channels[0].length
  const mixed = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    mixed[i] = sum / channels.length
  }
  return mixed
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

function lraLabel (analysis) {
  if (analysis.loudnessRangeLu > 0) return `LRA ${fmt(analysis.loudnessRangeLu, 1)} LU`
  if (analysis.shortTermBasis === 'short-term') return 'LRA 0 LU (flat)'
  return 'LRA n/a (<3s)'
}

function measureLine (verb, cwd, info, analysis, metrics) {
  const where = info.path === null ? 'inline render' : displayPath(cwd, info.path)
  const meta = [`${fmt(analysis.durationSeconds, 2)}s`, `${info.sampleRate} Hz`]
  if (info.bytes !== null) meta.push(sizeLabel(info.bytes))
  const parts = [`${verb} ${where} (${meta.join(', ')})`]
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
    description: 'Measure broadcast loudness (ITU-R BS.1770-4 LUFS), short-term and momentary maxima, loudness range (EBU Tech 3342) and 4x-oversampled true peak (dBTP) of a .wav file or an inline render spec, and optionally write a true-peak-safe, gain-corrected copy toward a target loudness (-14 LUFS web/streaming, -16 podcast, -23 broadcast). Use it instead of audio_probe when the question is "will this sound as loud as the other audio?", not "is it clipping?".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Wav file to measure, relative to the working directory or absolute. Give either path or render.' },
        render: {
          type: 'object',
          additionalProperties: true,
          description: 'Inline render spec to measure without writing: measured exactly as audio_synth would write it (the same finalisation is applied). Give either path or render.',
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
        targetLufs: { type: 'number', description: 'Optional target integrated loudness: -14 for web/streaming, -16 for podcast, -23 for broadcast (EBU R128). With `out` it writes the corrected copy.' },
        ceilingDbtp: { type: 'number', description: 'Maximum allowed true peak for the correction; defaults to -1 dBTP and is clamped to [-20, 0] because a positive ceiling means clipping.' },
        out: { type: 'string', description: 'Output path for the gain-corrected copy, relative to the working directory or absolute. Only used together with targetLufs.' }
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

      // --- get samples ------------------------------------------------------
      let channels
      let sampleRate
      let mono
      let sourcePath = null
      let sourceBytes = null
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
        // describe the file the caller would actually get.
        mono = finalize(rendered.samples, rendered.sampleRate)
        channels = [mono]
        sampleRate = rendered.sampleRate
      } else {
        const bytes = await readFile(requestedPath)
        const decoded = decodeWav(bytes)
        channels = decoded.channels
        sampleRate = decoded.sampleRate
        mono = channels.length === 1 ? channels[0] : averageChannels(channels)
        sourcePath = requestedPath
        sourceBytes = bytes.length
      }

      const analysis = channels.length === 1
        ? analyzeLoudness(channels[0], sampleRate)
        : analyzeLoudness(channels[0], sampleRate, { channels })
      const sourceMetrics = {
        ...measure(mono, sampleRate),
        sampleRate,
        channelCount: channels.length,
        ...loudnessMetrics(analysis)
      }

      // --- optional gain plan and corrected copy ----------------------------
      const targetLufs = Number.isFinite(args.targetLufs) ? Number(args.targetLufs) : undefined
      const ceilingDbtp = Number.isFinite(args.ceilingDbtp) ? Number(args.ceilingDbtp) : -1
      const plan = targetLufs === undefined ? null : planGain(analysis, targetLufs, ceilingDbtp)
      const outPath = resolvePath(cwd, args.out)

      let written = null
      let after = null
      let resultMetrics = sourceMetrics
      if (plan !== null && outPath !== undefined) {
        if (!Number.isFinite(analysis.integratedLufs)) {
          throw new Error('audio_loudness cannot normalise a silent file: no 400 ms block clears the -70 LUFS gate')
        }
        if (channels.length > 1) {
          throw new Error(`audio_loudness normalises mono files only (this file has ${channels.length} channels); mix it to mono first or just measure it`)
        }
        // Re-plan against a slightly lower ceiling: the ceiling is a promise
        // about the *encoded* file, and 16-bit quantisation can add a fraction
        // of a dB at the peak.
        const writePlan = planGain(analysis, targetLufs, ceilingDbtp - WRITE_CEILING_GUARD_DB)
        const gain = Math.pow(10, writePlan.gainDb / 20)
        const corrected = new Float32Array(mono.length)
        for (let i = 0; i < mono.length; i += 1) corrected[i] = mono[i] * gain
        const bytes = toWavBytes(corrected, sampleRate)
        await writeFileAtomic(outPath, bytes)
        const info = await stat(outPath)
        // Measure what landed on disk, not what we hoped to write: that is the
        // number the user will ship.
        const decoded = decodeWav(bytes)
        const afterSamples = decoded.channels[0]
        const afterAnalysis = analyzeLoudness(afterSamples, decoded.sampleRate)
        after = snapshot(afterAnalysis)
        resultMetrics = {
          ...measure(afterSamples, decoded.sampleRate),
          sampleRate: decoded.sampleRate,
          channelCount: 1,
          ...loudnessMetrics(afterAnalysis)
        }
        written = {
          path: outPath,
          relativePath: displayPath(cwd, outPath),
          bytes: info.size,
          durationSeconds: afterAnalysis.durationSeconds,
          gainDb: writePlan.gainDb,
          limitedBy: writePlan.limitedBy,
          targetHit: writePlan.achievable
        }
      }

      // --- bounded human summary -------------------------------------------
      const lines = []
      lines.push(measureLine('Measured', cwd, { path: sourcePath, bytes: sourceBytes, sampleRate }, analysis, sourceMetrics))
      if (plan !== null) {
        lines.push(targetLine(plan))
        if (outPath === undefined) lines.push('Pass `out` to write the gain-corrected copy.')
      } else if (outPath !== undefined) {
        lines.push('`out` is ignored without `targetLufs`.')
      }
      if (written !== null && after !== null) {
        lines.push(`Wrote ${written.relativePath} (${fmt(written.durationSeconds, 2)}s, ${resultMetrics.sampleRate} Hz, ${sizeLabel(written.bytes)}): ${fmt(after.lufs, 1)} LUFS integrated, true peak ${fmt(after.truePeakDbtp, 1)} dBTP, gain ${signed(written.gainDb)} dB${written.targetHit ? '' : ` (target capped by true peak: ${fmt(plan.targetLufs - after.lufs, 1)} LU short)`}`)
      }

      const reportedPath = written !== null ? written.path : sourcePath
      return {
        path: reportedPath,
        relativePath: reportedPath === null ? null : displayPath(cwd, reportedPath),
        bytes: written !== null ? written.bytes : (sourceBytes ?? 0),
        durationSeconds: analysis.durationSeconds,
        sampleRate,
        metrics: resultMetrics,
        before: snapshot(analysis),
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
