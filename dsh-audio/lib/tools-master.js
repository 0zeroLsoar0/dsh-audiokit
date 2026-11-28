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
import { analyzeLoudness, truePeak } from './lufs.js'
import { MASTER_MODES, masterChain, masterPresets } from './master.js'
import { CHANNEL_COUNTS, encodeAnyWav, fitChannels, layoutFor, loudnessChannels } from './multichannel.js'
import { decodeWav } from './wav.js'

const PRESET_NAMES = Object.keys(PRESETS)
const MASTER_PRESET_NAMES = Object.keys(masterPresets())
const BIT_DEPTHS = [8, 16, 24, 32]
/** The extensible WAV writer behind multichannel output is integer PCM only. */
const MULTICHANNEL_BIT_DEPTHS = [16, 24]

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

/** Fold a channel list to mono for the legacy `measure` shaping metrics. */
function foldToMono (channels) {
  if (channels.length === 1) return channels[0]
  return fitChannels(channels, 1)[0]
}

/**
 * Analyse a channel list the way the master chain does: LFE excluded from the
 * loudness sum, BS.1770-4 surround weights applied, the worst channel supplying
 * the true peak (the meter already reports the maximum over the channels it is
 * given). The channel decision comes from `multichannel.loudnessChannels`, the
 * same helper `lib/master.js` and `audio_loudness` use.
 */
function analyseChannels (channels, sampleRate) {
  const { measured, weights } = loudnessChannels(channels)
  return analyzeLoudness(measured[0], sampleRate, { channels: measured, weights })
}

/** `mono`, `stereo`, or `6-ch 5.1`. */
function channelLabel (channels) {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels}-ch ${layoutFor(channels).id}`
}

/** One channel's 4x true peak in dBTP, floored so JSON never carries -Infinity. */
function truePeakDbtpOf (samples, sampleRate) {
  return finiteOr(truePeak(samples, sampleRate), PEAK_FLOOR_DB)
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

  // The memory/time switch is not part of the sound, so it is kept out of
  // `request` (which also names the default output file): the same input must
  // land on the same path in either mode, because the bytes are identical.
  const mode = resolveMode(tool, args.mode)

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
  return { presetName, mode, request: { ...request, ...overrides } }
}

/**
 * Read `mode`, rejecting anything that is not one of the chain's two names.
 *
 * The chain validates it too (a caller of `masterChain` gets the same error),
 * but doing it here names the tool and happens before any file is read or
 * rendered — a typo must not cost a decode, a render or a write.
 */
function resolveMode (tool, value) {
  if (value === undefined || value === null) return MASTER_MODES[0]
  const mode = String(value)
  if (MASTER_MODES.includes(mode)) return mode
  throw new Error(`${tool}: mode must be "${MASTER_MODES[0]}" (default: re-render the chosen attempt once, lowest memory) or "${MASTER_MODES[1]}" (keep every attempt's samples, one limiter pass less), got ${JSON.stringify(mode)}`)
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
  const format = `${bitDepth}-bit ${channelLabel(channels)} ${info.sampleRate} Hz`
  const parts = [`Wrote ${destination} (${fmt(info.durationSeconds, 2)}s, ${format}, ${sizeLabel(info.bytes)})`]
  const chain = presetName === null ? 'custom chain' : `via ${presetName}`
  if (Number.isFinite(before.lufs) && Number.isFinite(after.lufs)) {
    parts.push(`${chain}: ${fmt(before.lufs, 1)} -> ${fmt(after.lufs, 1)} LUFS (${signed(after.lufs - before.lufs)} LU)`)
  } else {
    parts.push(`${chain}: ${fmt(after.lufs, 1)} LUFS`)
  }
  parts.push(`true peak ${fmt(before.truePeak, 1)} -> ${fmt(after.truePeak, 1)} dBTP`)
  if (channels > 2) {
    // For a surround master the ceiling is a per-channel promise, so name the
    // worst channel and the whole set instead of one folded number.
    const names = layoutFor(channels).names
    const byChannel = Array.isArray(after.truePeakByChannelDbtp) ? after.truePeakByChannelDbtp : []
    const worst = Number.isInteger(after.truePeakChannel) ? names[after.truePeakChannel] : null
    if (worst !== null && byChannel.length === names.length) {
      parts.push(`true peak by channel ${names.map((name, index) => `${name} ${fmt(byChannel[index], 1)}`).join(' / ')} dBTP (worst ${worst})`)
    }
    parts.push(report.lfeExcluded === true
      ? `loudness on ${report.loudnessChannels} channels (LFE excluded)`
      : `loudness on ${report.loudnessChannels} channels`)
  }
  parts.push(`limiter GR ${fmt(report.gainReductionDb, 1)} dB`)
  parts.push(`bands ${bandsText(report.bands)}`)
  if (report.widthApplied === true && (report.width !== 1 || report.bassMonoHz > 0)) {
    parts.push(`width ${fmt(report.width, 2)}, bass mono <= ${fmt(report.bassMonoHz, 0)} Hz`)
  } else if (report.widthApplied === false && report.widthNote !== undefined && report.widthNote !== null && channels > 2) {
    parts.push('width stage bypassed (surround input)')
  }
  parts.push(`${report.iterations} iteration(s)`)
  if (report.mode === 'fast') {
    // Only worth a clause when it is not the default: the bytes are identical,
    // so naming the mode is a note about how it was computed, not about what.
    parts.push('fast mode (every attempt kept in memory)')
  }
  if (report.achievable) {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS hit`)
  } else if (report.limitedBy === 'true-peak') {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reachable at <= ${fmt(target.ceilingDbtp, 1)} dBTP without more than ${fmt(maxGainReductionDb, 1)} dB of limiting: ${fmt(report.shortfallLu, 1)} LU short`)
  } else if (report.shortfallLu > 0) {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reached after ${report.iterations} iteration(s): ${fmt(report.shortfallLu, 1)} LU short`)
  } else {
    parts.push(`target ${fmt(target.lufs, 1)} LUFS not reached after ${report.iterations} iteration(s): landed ${fmt(report.lufsErrorLu, 1)} LU off target`)
  }
  // A warning about the mode's memory cost is part of the answer: the model
  // reads this line, not the structured fields, so it must not stay silent.
  if (Array.isArray(report.warnings)) for (const warning of report.warnings) parts.push(warning)
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
    description: 'Master a .wav file or an inline render to a delivery loudness target without clipping: 3-band Linkwitz-Riley compression, mid/side width with bass mono, and a lookahead true-peak limiter, with an outer search that lands on the target (-14 LUFS streaming, -16 podcast, -23 broadcast) at or below a dBTP ceiling. Writes 8/16/24-bit or 32-bit float at 1/2/4/6/8 channels, and reports before/after LUFS and true peak, per-band gain reduction and the iteration count. Multichannel input keeps its layout: the compressor detector and the limiter curve are linked across every channel, the ceiling is verified on the loudest channel with lib/lufs.js, loudness is measured on the non-LFE channels, and the stereo width stage is bypassed with a note. Use it instead of audio_loudness when a single linear gain would clip or fall short. If the target cannot be reached inside the limiting budget it says so and reports the shortfall rather than clipping.',
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
        width: { type: 'number', description: 'Mid/side stereo width: 0 = mono, 1 = unchanged, 1.5 = wider (max 2). Mono input ignores it; a 4/6/8-channel input bypasses the stage and says so in the report (mid/side is defined on one stereo pair). Overrides the preset.' },
        bassMonoHz: { type: 'number', description: 'Fold side content below this frequency to the centre (mono bass), 0 disables. A stereo control: ignored for mono, bypassed for a surround input. Overrides the preset.' },
        driveDb: { type: 'number', description: 'Gain into the multiband compressor in dB, -24..24; raise it to make the compressor work on quiet material. Overrides the preset.' },
        maxGainReductionDb: { type: 'number', description: 'Limiting budget in dB: if the target would need more reduction than this, the chain stops and reports the shortfall; defaults to the preset value (6..14).' },
        mode: { type: 'string', enum: MASTER_MODES, description: 'Memory/time tradeoff: memory (default) keeps only attempt measurements and re-renders the chosen attempt once; fast keeps every attempt\'s samples and skips that re-render. Output is byte-identical either way; fast costs ~350 MB for a 180 s stereo master.' },
        bitDepth: { type: 'integer', enum: BIT_DEPTHS, description: '8=smallest (inline HTML), 16=default, 24=video master, 32=32-bit IEEE float. A 4/6/8-channel master supports 16 or 24 bits (the extensible WAV writer); 8/32-bit is refused for surround. Defaults to 16.' },
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

      const { presetName, request, mode } = resolveRequest('audio_master', args)
      const bitDepth = resolveBitDepth('audio_master', args.bitDepth)

      // --- get the channels (1/2/4/6/8; the layout is preserved) ------------
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
      if (!CHANNEL_COUNTS.includes(channels.length)) {
        throw new Error(`audio_master handles ${CHANNEL_COUNTS.join(', ')} channels (mono, stereo, quad, 5.1, 7.1); this file has ${channels.length}`)
      }
      if (channels.length > 2 && !MULTICHANNEL_BIT_DEPTHS.includes(bitDepth)) {
        throw new Error(`audio_master: a ${channels.length}-channel master must be written at ${MULTICHANNEL_BIT_DEPTHS.join(' or ')} bits (the extensible WAV writer), got ${bitDepth}-bit`)
      }
      // Width and bass-mono are a mid/side matrix on one stereo pair; there is no
      // defined "which pair" for a surround layout, so an explicit request is
      // refused rather than silently ignored.
      if (channels.length > 2 && args.width !== undefined && Number(args.width) !== 1) {
        throw new Error(`audio_master: width is a stereo mid/side control and this input has ${channels.length} channels; master the stereo pair before a surround upmix, or drop width`)
      }
      if (channels.length > 2 && args.bassMonoHz !== undefined && Number(args.bassMonoHz) !== 0) {
        throw new Error(`audio_master: bassMonoHz folds side content of a stereo pair and this input has ${channels.length} channels; drop bassMonoHz for a surround master`)
      }

      const sourceAnalysis = analyseChannels(channels, sampleRate)
      if (!Number.isFinite(sourceAnalysis.integratedLufs)) {
        throw new Error('audio_master cannot master a silent file: no 400 ms block clears the -70 LUFS gate')
      }

      // --- master ------------------------------------------------------------
      // The write guard is part of the requested ceiling, not an extra knob: an
      // integer file must still measure at or below the ceiling after encoding.
      const guardDb = WRITE_CEILING_GUARD_DB[bitDepth] ?? 0
      // `mode` never changes the mastered samples, so it is passed to the chain
      // but not to `hashSpec` below: the same input must resolve to the same
      // default output path whichever mode produced it.
      const chainOptions = { ...request, mode }
      if (Number.isFinite(request.ceilingDbtp)) chainOptions.ceilingDbtp = request.ceilingDbtp - guardDb
      else if (guardDb > 0) chainOptions.ceilingDbtp = -1 - guardDb
      const chain = masterChain(channels.length === 1 ? channels[0] : channels, sampleRate, chainOptions)
      const report = chain.report

      // --- encode, write, and measure what actually landed on disk ----------
      const outputChannels = channels.length === 1 ? [chain.samples] : chain.samples
      let bytes
      try {
        bytes = encodeAnyWav(outputChannels, sampleRate, { bitDepth })
      } catch (error) {
        throw new Error(`audio_master: ${error.message}`)
      }
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
      const writtenAnalysis = analyseChannels(written.channels, written.sampleRate)
      const writtenMetrics = measure(foldToMono(written.channels), written.sampleRate)
      // The true peak of the file is the worst channel, measured with the same
      // meter the rest of the plugin reports; naming the channel is what makes a
      // surround ceiling claim checkable.
      const writtenTruePeakByChannel = written.channels.map((channel) => truePeakDbtpOf(channel, written.sampleRate))
      let writtenTruePeakChannel = 0
      let writtenTruePeak = Number.NEGATIVE_INFINITY
      for (let index = 0; index < writtenTruePeakByChannel.length; index += 1) {
        if (writtenTruePeakByChannel[index] > writtenTruePeak) {
          writtenTruePeak = writtenTruePeakByChannel[index]
          writtenTruePeakChannel = index
        }
      }

      const before = {
        lufs: finiteOr(sourceAnalysis.integratedLufs, GATE_FLOOR_LUFS),
        truePeak: finiteOr(sourceAnalysis.truePeakDbtp, PEAK_FLOOR_DB),
        truePeakChannel: report.truePeakChannelBefore ?? null
      }
      const after = {
        lufs: finiteOr(writtenAnalysis.integratedLufs, GATE_FLOOR_LUFS),
        truePeak: finiteOr(writtenTruePeak, PEAK_FLOOR_DB),
        truePeakChannel: written.channels.length > 1 ? writtenTruePeakChannel : 0,
        truePeakByChannelDbtp: writtenTruePeakByChannel.map((value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : PEAK_FLOOR_DB)),
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
        channelLayout: layoutFor(written.channels.length).id,
        channelNames: [...layoutFor(written.channels.length).names],
        channelPeaksDbfs: written.channels.map((channel) => {
          let peak = 0
          for (let index = 0; index < channel.length; index += 1) peak = Math.max(peak, Math.abs(channel[index]))
          return peak > 0 ? Math.round(20 * Math.log10(peak) * 100) / 100 : PEAK_FLOOR_DB
        }),
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
        // The memory/time trade the chain ran, and any warning that cost earned.
        mode: report.mode,
        warnings: report.warnings,
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
