/**
 * `audio_master`: the loudness tool that can actually get there.
 *
 * `audio_loudness` measures and `audio_convert` re-encodes, but neither can
 * turn a quiet cue into a competitive master: one linear gain either clips or
 * is refused by the true-peak ceiling. This tool runs the mastering chain from
 * `lib/master.js` (multiband compression -> stereo width -> true-peak limiter,
 * driven by a loudness search) over a file or an inline render, writes the
 * result with the requested bit depth, and reports both the numbers it started
 * from and the numbers on disk.
 *
 * It never silently clips. If the loudness target would need more limiting than
 * the chain is willing to apply, the file is written at the loudest safe level
 * and the shortfall is reported, because "it stopped 2 LU short" is a usable
 * answer and "it clipped" is not.
 */

import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  renderPreset,
  resolvePath,
  writeFileAtomic
} from './audio.js'
import { PRESETS } from './dsp.js'
import { analyzeLoudness } from './lufs.js'
import { masterChain, masterPresets } from './master.js'
import { decodeWav } from './wav.js'
import { encodeWavEx } from './wav-encode.js'

const PRESET_NAMES = Object.keys(PRESETS)
const MASTER_PRESET_NAMES = Object.keys(masterPresets())
const BIT_DEPTHS = [8, 16, 24, 32]

/**
 * Headroom left below the requested true-peak ceiling before encoding.
 *
 * The ceiling is a promise about the file on disk, and integer quantisation
 * (plus its dither) can move the last sample up. 8-bit moves by ~1 LSB of a
 * -41 dBFS step, which is audible headroom; 16/24-bit only need a hair.
 */
const WRITE_CEILING_GUARD_DB = { 8: 0.15, 16: 0.01, 24: 0.01, 32: 0 }

/** The gate floor used when a measurement is impossible; JSON has no -Infinity. */
const GATE_FLOOR_LUFS = -70
const PEAK_FLOOR_DB = -120

/* ------------------------------------------------------------------ helpers -- */

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
  if (bytes >= 1024 * 1024) return `${fmt(bytes / 1024 / 1024, 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function foldToMono (channels) {
  if (channels.length === 1) return channels[0]
  const frames = channels[0].length
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = (channels[0][i] + channels[1][i]) * 0.5
  return out
}

function finiteOr (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** Reject NaN/infinity before it becomes a silent or unbounded render. */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${String(value)}`)
  return number
}

/** Resolve the chain options: preset first, then explicit overrides. */
function resolveRequest (tool, args) {
  const overrides = {}
  const provided = {
    targetLufs: readNumber(tool, 'targetLufs', args.targetLufs),
    ceilingDbtp: readNumber(tool, 'ceilingDbtp', args.ceilingDbtp),
    width: readNumber(tool, 'width', args.width),
    bassMonoHz: readNumber(tool, 'bassMonoHz', args.bassMonoHz),
    driveDb: readNumber(tool, 'driveDb', args.driveDb),
    maxGainReductionDb: readNumber(tool, 'maxGainReductionDb', args.maxGainReductionDb)
  }
  for (const [key, value] of Object.entries(provided)) if (value !== undefined) overrides[key] = value
  if (args.bands !== undefined && args.bands !== null) {
    if (!Array.isArray(args.bands) || args.bands.length === 0) {
      throw new Error(`${tool}: bands must be a non-empty array of { splitHz, ratio, thresholdDb, attackMs, releaseMs, makeupDb } objects`)
    }
    overrides.bands = args.bands
  }

  let presetName = null
  let request
  if (args.preset !== undefined && args.preset !== null) {
    presetName = String(args.preset)
    const presets = masterPresets()
    if (presets[presetName] === undefined) {
      throw new Error(`${tool}: unknown preset "${presetName}"; available: ${MASTER_PRESET_NAMES.join(', ')}`)
    }
    const preset = presets[presetName]
    request = {
      targetLufs: preset.targetLufs,
      ceilingDbtp: preset.ceilingDbtp,
      bands: preset.bands,
      width: preset.width,
      bassMonoHz: preset.bassMonoHz,
      driveDb: preset.driveDb,
      maxGainReductionDb: preset.maxGainReductionDb
    }
  } else {
    request = {}
  }
  return { presetName, request: { ...request, ...overrides } }
}

function resolveBitDepth (tool, value) {
  if (value === undefined || value === null) return 16
  const bitDepth = Number(value)
  if (!BIT_DEPTHS.includes(bitDepth)) throw new Error(`${tool}: bitDepth must be one of ${BIT_DEPTHS.join(', ')}`)
  return bitDepth
}

/** Read a file as channels: mastering needs the true channel layout, not a mono fold. */
async function readChannels (path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.code ?? error.message}`)
  }
  let decoded
  try {
    decoded = decodeWav(bytes)
  } catch (error) {
    throw new Error(`cannot decode ${path}: ${error.message}`)
  }
  return { channels: decoded.channels, sampleRate: decoded.sampleRate }
}

/** The inline render path: same finalisation audio_synth applies before writing. */
function renderChannels (spec) {
  if (spec === null || typeof spec !== 'object') throw new Error('audio_master: render must be an object')
  if (typeof spec.preset !== 'string' || !PRESET_NAMES.includes(spec.preset)) {
    throw new Error(`audio_master: render.preset must be one of ${PRESET_NAMES.join(', ')}`)
  }
  const rendered = renderPreset({
    preset: spec.preset,
    params: spec.params ?? {},
    duration: spec.duration,
    seed: Number.isFinite(spec.seed) ? Math.round(spec.seed) : 1,
    sampleRate: Number.isFinite(spec.sampleRate) ? Math.round(spec.sampleRate) : 44100,
    loop: spec.loop === true
  })
  finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
  return { channels: [rendered.samples], sampleRate: rendered.sampleRate }
}

function bandsText (bands) {
  if (!Array.isArray(bands) || bands.length === 0) return 'no bands'
  return bands.map((band) => `${band.name} ${fmt(band.gainReductionDb, 1)} dB`).join(' / ')
}

/** One line the model reads instead of listening. */
function summaryText ({ destination, info, before, after, report, presetName, bitDepth, channels, maxGainReductionDb, target }) {
  const format = `${bitDepth}-bit ${channels === 2 ? 'stereo' : 'mono'} ${info.sampleRate} Hz`
  const parts = [`Wrote ${destination} (${fmt(info.durationSeconds, 2)}s, ${format}, ${sizeLabel(info.bytes)})`]
  const chain = presetName === null ? 'custom chain' : `via ${presetName}`
  if (Number.isFinite(before.lufs) && Number.isFinite(after.lufs)) {
    parts.push(`${chain}: ${fmt(before.lufs, 1)} -> ${fmt(after.lufs, 1)} LUFS (${signed(after.lufs - before.lufs)} LU)`)
  } else {
    parts.push(`${chain}: ${fmt(after.lufs, 1)} LUFS`)
  }
  parts.push(`true peak ${fmt(before.truePeak, 1)} -> ${fmt(after.truePeak, 1)} dBTP`)
  parts.push(`limiter GR ${fmt(report.gainReductionDb, 1)} dB`)
  parts.push(`bands ${bandsText(report.bands)}`)
  if (report.widthApplied === true && (report.width !== 1 || report.bassMonoHz > 0)) {
    parts.push(`width ${fmt(report.width, 2)}, bass mono <= ${fmt(report.bassMonoHz, 0)} Hz`)
  }
  parts.push(`${report.iterations} iteration(s)`)
  if (report.achievable) {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS hit`)
  } else if (report.limitedBy === 'true-peak') {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reachable at <= ${fmt(target.ceilingDbtp, 1)} dBTP without more than ${fmt(maxGainReductionDb, 1)} dB of limiting: ${fmt(report.shortfallLu, 1)} LU short`)
  } else if (report.shortfallLu > 0) {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reached after ${report.iterations} iteration(s): ${fmt(report.shortfallLu, 1)} LU short`)
  } else {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reached after ${report.iterations} iteration(s): landed ${fmt(report.lufsErrorLu, 1)} LU off target`)
  }
  return parts.join(' | ')
}

/* -------------------------------------------------------------------- tool -- */

/**
 * Register the `audio_master` tool.
 * @param {object} ctx - Cordis context with the tools service.
 */
export function registerMasterTools (ctx) {
  ctx.tools.register({
    name: 'audio_master',
    description: 'Master a .wav file or an inline render to a delivery loudness target without clipping: 3-band Linkwitz-Riley compression, mid/side width with bass mono, and a lookahead true-peak limiter, with an outer search that lands on the target (-14 LUFS streaming, -16 podcast, -23 broadcast) at or below a dBTP ceiling. Writes 8/16/24-bit or 32-bit float, mono or stereo, and reports before/after LUFS and true peak, per-band gain reduction and the iteration count. Use it instead of audio_loudness when a single linear gain would clip or fall short. If the target cannot be reached inside the limiting budget it says so and reports the shortfall rather than clipping.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Wav file to master, relative to the working directory or absolute. Give either path or render.' },
        render: {
          type: 'object',
          additionalProperties: true,
          description: 'Inline render spec to master without reading a file: rendered exactly as audio_synth renders it, then mastered. Give either path or render.',
          properties: {
            preset: { type: 'string', enum: PRESET_NAMES, description: 'Sound family, same names as audio_synth.' },
            params: { type: 'object', additionalProperties: true, description: 'Perceptual knobs, same names as audio_synth.' },
            duration: { type: 'number', description: 'Length in seconds; defaults to the preset length.' },
            seed: { type: 'integer', description: 'Variation seed.' },
            sampleRate: { type: 'integer', description: 'Defaults to 44100.' },
            loop: { type: 'boolean', description: 'Render a seamless loop before mastering.' }
          },
          required: ['preset']
        },
        preset: { type: 'string', enum: MASTER_PRESET_NAMES, description: 'Mastering preset: streaming-safe=default -14 LUFS at -1 dBTP; streaming-loud=commercial -9 LUFS density; broadcast-23=EBU R128 -23 LUFS; podcast=-16 LUFS dialogue weight; gentle=transparent -16 LUFS at -2 dBTP. Explicit numbers below override the preset.' },
        targetLufs: { type: 'number', description: 'Target integrated loudness in LUFS: -14 web/streaming, -16 podcast, -23 broadcast. Overrides the preset.' },
        ceilingDbtp: { type: 'number', description: 'Maximum allowed true peak in dBTP; defaults to -1 (this is the ceiling the limiter holds). Overrides the preset.' },
        bands: {
          type: 'array',
          description: 'Multiband compressor bands, replacing the preset bands. Band k spans the previous split to its own splitHz; the last band runs to Nyquist and its splitHz is ignored.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              splitHz: { type: 'number', description: 'Crossover at the top of this band (ignored on the last band).' },
              ratio: { type: 'number', description: 'Compression ratio, 1 disables it for this band.' },
              thresholdDb: { type: 'number', description: 'Band level where compression starts, in dBFS.' },
              attackMs: { type: 'number', description: 'Attack time in ms.' },
              releaseMs: { type: 'number', description: 'Release time in ms.' },
              makeupDb: { type: 'number', description: 'Static gain added after compression, in dB.' }
            }
          }
        },
        width: { type: 'number', description: 'Mid/side stereo width: 0 = mono, 1 = unchanged, 1.5 = wider (max 2). Mono input ignores it. Overrides the preset.' },
        bassMonoHz: { type: 'number', description: 'Fold side content below this frequency to the centre (mono bass), 0 disables. Overrides the preset.' },
        driveDb: { type: 'number', description: 'Gain into the multiband compressor in dB, -24..24; raise it to make the compressor work on quiet material. Overrides the preset.' },
        maxGainReductionDb: { type: 'number', description: 'Limiting budget in dB: if the target would need more reduction than this, the chain stops and reports the shortfall; defaults to the preset value (6..14).' },
        bitDepth: { type: 'integer', enum: BIT_DEPTHS, description: '8=smallest (inline HTML), 16=default, 24=video master, 32=32-bit IEEE float. Defaults to 16.' },
        out: { type: 'string', description: 'Output path, relative to the working directory or absolute. Defaults to assets/audio/master-<hash>.wav.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: args.preset !== undefined || Number.isFinite(args.targetLufs)
        ? `Master -> ${args.preset ?? `${args.targetLufs} LUFS`}`
        : 'Master audio',
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const requestedPath = resolvePath(cwd, args.path)
      const wantsRender = args.render !== undefined && args.render !== null
      if (wantsRender && requestedPath !== undefined) throw new Error('audio_master takes either `path` or `render`, not both')
      if (!wantsRender && requestedPath === undefined) throw new Error('audio_master needs a wav `path` or an inline `render` spec')

      const { presetName, request } = resolveRequest('audio_master', args)
      const bitDepth = resolveBitDepth('audio_master', args.bitDepth)

      // --- get the channels (mono or stereo only) ---------------------------
      let channels
      let sampleRate
      if (wantsRender) {
        const rendered = renderChannels(args.render)
        channels = rendered.channels
        sampleRate = rendered.sampleRate
      } else {
        const read = await readChannels(requestedPath)
        channels = read.channels
        sampleRate = read.sampleRate
      }
      if (channels.length > 2) {
        throw new Error(`audio_master handles mono or stereo wav files (this one has ${channels.length} channels); fold it to stereo first`)
      }

      const sourceAnalysis = channels.length === 1
        ? analyzeLoudness(channels[0], sampleRate)
        : analyzeLoudness(channels[0], sampleRate, { channels })
      if (!Number.isFinite(sourceAnalysis.integratedLufs)) {
        throw new Error('audio_master cannot master a silent file: no 400 ms block clears the -70 LUFS gate')
      }

      // --- master ------------------------------------------------------------
      // The write guard is part of the requested ceiling, not an extra knob: an
      // integer file must still measure at or below the ceiling after encoding.
      const guardDb = WRITE_CEILING_GUARD_DB[bitDepth] ?? 0
      const chainOptions = { ...request }
      if (Number.isFinite(request.ceilingDbtp)) chainOptions.ceilingDbtp = request.ceilingDbtp - guardDb
      else if (guardDb > 0) chainOptions.ceilingDbtp = -1 - guardDb
      const chain = masterChain(channels.length === 1 ? channels[0] : channels, sampleRate, chainOptions)
      const report = chain.report

      // --- encode, write, and measure what actually landed on disk ----------
      const outputChannels = channels.length === 1 ? [chain.samples] : chain.samples
      const bytes = encodeWavEx(outputChannels, sampleRate, { bitDepth, channels: outputChannels.length })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'master', hashSpec({
        source: wantsRender ? { render: args.render } : requestedPath,
        preset: presetName,
        options: request,
        bitDepth
      }))
      await writeFileAtomic(target, bytes)
      const info = await stat(target)
      // Measure the decoded file: bit depth, dither and the ceiling promise are
      // all about the bytes on disk, not the in-memory master.
      const written = decodeWav(bytes)
      const writtenAnalysis = written.channels.length === 1
        ? analyzeLoudness(written.channels[0], written.sampleRate)
        : analyzeLoudness(written.channels[0], written.sampleRate, { channels: written.channels })
      const writtenMetrics = measure(foldToMono(written.channels), written.sampleRate)

      const before = {
        lufs: finiteOr(sourceAnalysis.integratedLufs, GATE_FLOOR_LUFS),
        truePeak: finiteOr(sourceAnalysis.truePeakDbtp, PEAK_FLOOR_DB)
      }
      const after = {
        lufs: finiteOr(writtenAnalysis.integratedLufs, GATE_FLOOR_LUFS),
        truePeak: finiteOr(writtenAnalysis.truePeakDbtp, PEAK_FLOOR_DB),
        samplePeakDbfs: writtenAnalysis.samplePeakDbfs
      }
      const requestCeiling = Number.isFinite(request.ceilingDbtp) ? request.ceilingDbtp : -1
      const text = summaryText({
        destination: displayPath(cwd, target),
        info: { bytes: info.size, durationSeconds: writtenAnalysis.durationSeconds, sampleRate: written.sampleRate },
        before,
        after,
        report,
        presetName,
        bitDepth: written.bitDepth,
        channels: written.channels.length,
        maxGainReductionDb: Number.isFinite(report.maxGainReductionDb) ? report.maxGainReductionDb : 12,
        target: { lufs: Number.isFinite(request.targetLufs) ? request.targetLufs : -14, ceilingDbtp: requestCeiling }
      })

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        durationSeconds: writtenAnalysis.durationSeconds,
        sampleRate: written.sampleRate,
        channels: written.channels.length,
        bitDepth: written.bitDepth,
        metrics: {
          ...writtenMetrics,
          sampleRate: written.sampleRate,
          lufs: after.lufs,
          truePeakDbtp: after.truePeak
        },
        before,
        after,
        preset: presetName,
        target: {
          lufs: Number.isFinite(request.targetLufs) ? request.targetLufs : -14,
          ceilingDbtp: requestCeiling,
          achievable: report.achievable,
          limitedBy: report.limitedBy,
          shortfallLu: report.shortfallLu
        },
        iterations: report.iterations,
        appliedGainDb: report.appliedGainDb,
        limiterGainReductionDb: report.gainReductionDb,
        compressorGainReductionDb: report.compressorGainReductionDb,
        trimDb: report.trimDb,
        bands: report.bands,
        chain: report,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
