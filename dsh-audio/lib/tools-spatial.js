/**
 * `audio_spatial`: put mono sources on a speaker layout, in a pair of ears, or
 * in B-format, and write it as one multichannel file.
 *
 * This is the tool for the jobs a stereo file cannot do: a 5.1 deliverable for a
 * video player, a binaural cue for headphones, a sound that has to come from
 * behind the listener, or a B-format export another package will decode. Every
 * other tool in this plugin ends in `encodeWav`/`encodeWavEx`, which cap at two
 * channels — `lib/spatial.js` carries its own extensible-header writer for
 * exactly that reason, and this tool is its only caller.
 *
 * The summary is deliberately narrow: layout, channel count, per-channel peaks
 * and which source occupies the most of the space. A model cannot listen to a
 * 5.1 file, so the numbers are what it reasons about ("the door is 0.7 dB in BR
 * and 8.3 dB in FR: it is on the right, mostly behind").
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  readTrack,
  renderPreset,
  resolvePath,
  writeFileAtomic
} from './audio.js'
import { LAYOUT_IDS, SPATIAL_LIMITS, encodeMultichannelWav, renderSpatial } from './spatial.js'

const TOOL = 'audio_spatial'
const BIT_DEPTHS = [16, 24]

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

/**
 * Read an optional numeric argument, rejecting only values that have no meaning.
 * `undefined`/`null` mean "use the default"; a numeric string is accepted because
 * the host may send one, and a literal NaN is a caller bug worth naming.
 */
function readNumber (key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${TOOL}: ${key} must be a number, got ${JSON.stringify(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${TOOL}: ${key} must be a number, got ${JSON.stringify(value)}`)
  return number
}

function fixed (value, digits = 1) {
  return Number(value).toFixed(digits)
}

function sizeLabel (bytes) {
  return bytes > 1024 * 1024 ? `${fixed(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Load one source: a file on disk or an inline render spec, exactly the two
 * ways `audio_stretch` accepts one, so a cue can be placed without a separate
 * `audio_synth` round trip.
 *
 * A file with more than one channel is folded to mono by `readTrack`: a spatial
 * stage places a *point*, and silently treating a stereo file as a two-point
 * image would be a different feature with the same arguments.
 */
async function loadSource (cwd, entry, index, masterRate) {
  if (entry === null || typeof entry !== 'object') throw new Error(`${TOOL}: sources[${index}] must be an object`)
  const hasPath = typeof entry.path === 'string' && entry.path.trim() !== ''
  const hasRender = entry.render !== undefined && entry.render !== null
  if (hasPath && hasRender) throw new Error(`${TOOL}: sources[${index}] must give either path or render, not both`)

  if (hasPath) {
    const path = resolvePath(cwd, entry.path)
    if (path === undefined) throw new Error(`${TOOL}: sources[${index}].path is empty`)
    const track = await readTrack(path)
    return {
      samples: track.samples,
      sampleRate: track.sampleRate,
      label: displayPath(cwd, path),
      // The file's own bytes are the identity: two sources pointing at one file
      // must hash the same whether or not the caller spelled the path the same way.
      key: `file:${track.channels ?? 1}ch:${track.bitDepth ?? 16}:${track.samples.length}:${track.sampleRate}:${specFingerprint(track.samples)}`
    }
  }

  if (!hasRender) throw new Error(`${TOOL}: sources[${index}] needs a source — pass path or render`)
  const spec = entry.render
  if (typeof spec.preset !== 'string' || spec.preset.trim() === '') {
    throw new Error(`${TOOL}: sources[${index}].render needs a preset name`)
  }
  const sampleRate = Number.isFinite(entry.sampleRate) ? entry.sampleRate : (spec.sampleRate ?? masterRate)
  const rendered = renderPreset({
    preset: spec.preset,
    params: spec.params ?? {},
    duration: spec.duration,
    seed: spec.seed ?? 1,
    loop: spec.loop === true,
    sampleRate
  })
  // Match audio_synth: a rendered source arrives at the same ceiling the other
  // render tools produce, so a spatial mix is comparable with a stereo one.
  finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
  return {
    samples: rendered.samples,
    sampleRate: rendered.sampleRate,
    label: `render ${spec.preset}`,
    key: `render:${JSON.stringify({ preset: spec.preset, params: spec.params ?? {}, duration: spec.duration, seed: spec.seed ?? 1, loop: spec.loop === true, sampleRate })}`
  }
}

/**
 * A cheap content fingerprint for a decoded file, so two paths to the same audio
 * still hash to one output name. Sampled rather than complete: the file's frame
 * count and rate already pin the shape, and this only has to distinguish takes.
 */
function specFingerprint (samples) {
  let hash = 0x811C9DC5
  const step = Math.max(1, Math.floor(samples.length / 512))
  for (let i = 0; i < samples.length; i += step) {
    hash = Math.imul(hash ^ Math.round(samples[i] * 1e6), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The bounded report: what the placement decided, without a per-source channel
 * array per source (64 sources x 8 channels of levels is not a summary).
 */
function boundedReport (report) {
  return {
    layout: report.layout,
    wavOrder: report.wavOrder,
    channelMask: `0x${report.channelMask.toString(16)}`,
    channelCount: report.channelCount,
    sampleRate: report.sampleRate,
    durationSeconds: report.durationSeconds,
    bodySeconds: report.bodySeconds,
    roomTailSeconds: report.roomTailSeconds,
    normalize: report.normalize,
    peakDbfs: report.peakDbfs,
    room: report.room,
    widest: report.widest,
    channels: report.channels,
    sources: report.sources.map((source) => ({
      index: source.index,
      label: source.label ?? null,
      loop: source.loop,
      position: source.position,
      gainDb: source.gainDb,
      level: source.level,
      pan: (source.pan ?? []).slice(0, 8),
      binaural: source.binaural ?? null
    }))
  }
}

/** One human line: layout, order, level, and which source owns the most space. */
function summaryText (cwd, target, bytes, rendered, sourceCount) {
  const report = rendered.report
  const widest = report.widest
  const widestNote = widest === null
    ? 'no sources'
    : `widest source #${widest.index + 1} at az ${fixed(widest.azimuth, 0)}° on ${widest.channelNames.join('+')} ` +
      `(${widest.spreadChannels} ch, ${widest.spreadDegrees}°)`
  return [
    `Wrote ${rendered.channelCount}-ch ${report.layout} (${report.wavOrder}) to ${displayPath(cwd, target)}`,
    `${fixed(report.bodySeconds, 2)}s + ${fixed(report.roomTailSeconds * 1000, 0)}ms room tail @ ${report.sampleRate} Hz`,
    `${sourceCount} source(s)`,
    sizeLabel(bytes),
    `peak ${fixed(report.peakDbfs)} dBFS`,
    widestNote,
    `room size ${fixed(report.room.size, 2)} damping ${fixed(report.room.damping, 2)} wet ${fixed(report.room.wet, 2)} (${report.room.tapCount} taps)`
  ].join(' · ')
}

/** Register the `audio_spatial` tool. */
export function registerSpatialTools (ctx) {
  ctx.tools.register({
    name: TOOL,
    description: 'Place mono sounds on a real spatial layout (mono, stereo, binaural, quad, 5.1, 7.1 or first-order B-format) with constant-power panning, an ITD/ILD head model and four early reflections, and write one multichannel WAV. Use it instead of audio_mix when the deliverable has more than two channels or a sound needs a direction.',
    parameters: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Source .wav; multichannel is folded to mono. Give this or render.' },
              render: { type: 'object', additionalProperties: true, description: 'Inline render spec instead of a file; give this or path.' },
              azimuth: { type: 'number', description: 'Degrees: 0 ahead, +90 right, -90 left, 卤180 behind. Default 0.' },
              distance: { type: 'number', description: 'Metres from the listener, 0.1..1000; 1 m is 0 dB and each doubling is -6 dB. Default 1.' },
              elevation: { type: 'number', description: 'Degrees above ear height (-90..90); used by binaural only. Default 0.' },
              gainDb: { type: 'number', description: 'Level relative to a 1 m reference source, in dB. Defaults to 0.' },
              loop: { type: 'boolean', description: 'Tile this source across durationSeconds (ambience bed).' }
            }
          },
          description: 'Sources to place, each with a direction and distance.'
        },
        layout: { type: 'string', enum: LAYOUT_IDS, description: 'mono, stereo, binaural, quad, 5.1, 7.1 or ambisonic-first-order; default stereo.' },
        room: {
          type: 'object',
          additionalProperties: false,
          properties: {
            size: { type: 'number', description: '0..1: scales the wall delays (0 = small booth, 1 = hall). Defaults to 0.35.' },
            damping: { type: 'number', description: '0..1: darkens and quietens the reflections. Defaults to 0.5.' },
            wet: { type: 'number', description: '0..1: reflection level relative to the direct sound. Defaults to 0.18.' }
          },
          description: 'Four early reflections, no diffuse tail; wet 0 for a dry placement.'
        },
        durationSeconds: { type: 'number', description: 'Timeline length in seconds (at most 180); default the longest source.' },
        bitDepth: { type: 'integer', enum: BIT_DEPTHS, description: '16 (default) or 24; integer PCM only for the multichannel header.' },
        sampleRate: { type: 'integer', description: 'Master rate; defaults to the first source\'s rate. Other sources are resampled linearly.' },
        out: { type: 'string', description: 'Output path; defaults to assets/audio/spatial-<hash>.wav.' }
      },
      required: ['sources'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Spatial ${args.layout ?? 'stereo'} · ${args.sources?.length ?? 0} source(s)`,
      kind: 'other',
      rawInput: {
        layout: args.layout,
        sources: (args.sources ?? []).map((source) => ({
          path: source?.path,
          preset: source?.render?.preset,
          azimuth: source?.azimuth,
          distance: source?.distance
        })),
        durationSeconds: args.durationSeconds,
        out: args.out
      }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      if (!Array.isArray(args.sources) || args.sources.length === 0) {
        throw new Error(`${TOOL}: sources must be a non-empty array of { path | render, azimuth, distance, ... }`)
      }
      if (args.sources.length > SPATIAL_LIMITS.maxSources) {
        throw new Error(`${TOOL}: ${args.sources.length} sources exceeds the ${SPATIAL_LIMITS.maxSources} source limit`)
      }
      const bitDepth = Number(args.bitDepth ?? 16)
      if (!BIT_DEPTHS.includes(bitDepth)) throw new Error(`${TOOL}: bitDepth must be 16 or 24, got ${args.bitDepth}`)
      const durationSeconds = readNumber('durationSeconds', args.durationSeconds)
      if (durationSeconds !== undefined && !(durationSeconds > 0)) {
        throw new Error(`${TOOL}: durationSeconds must be positive, got ${args.durationSeconds}`)
      }
      const sampleRate = readNumber('sampleRate', args.sampleRate)
      const room = args.room ?? {}
      for (const key of ['size', 'damping', 'wet']) readNumber(`room.${key}`, room[key])
      const layout = args.layout ?? 'stereo'

      const masterRate = Number.isFinite(sampleRate) ? sampleRate : 44100
      const loaded = []
      for (let index = 0; index < args.sources.length; index += 1) {
        const entry = args.sources[index] ?? {}
        const source = await loadSource(cwd, entry, index, masterRate)
        const azimuth = readNumber(`sources[${index}].azimuth`, entry.azimuth)
        const distance = readNumber(`sources[${index}].distance`, entry.distance)
        const elevation = readNumber(`sources[${index}].elevation`, entry.elevation)
        const gainDb = readNumber(`sources[${index}].gainDb`, entry.gainDb)
        if (distance !== undefined && distance <= 0) {
          throw new Error(`${TOOL}: sources[${index}].distance must be positive metres, got ${entry.distance}`)
        }
        loaded.push({
          samples: source.samples,
          sampleRate: source.sampleRate,
          position: { azimuth: azimuth ?? 0, distance: distance ?? 1, elevation: elevation ?? 0 },
          gainDb: gainDb ?? 0,
          loop: entry.loop === true,
          label: source.label,
          key: source.key
        })
      }

      const hash = hashSpec({
        layout,
        bitDepth,
        durationSeconds: durationSeconds ?? null,
        room: { size: room.size ?? null, damping: room.damping ?? null, wet: room.wet ?? null },
        sources: loaded.map((source) => ({
          key: source.key,
          position: source.position,
          gainDb: source.gainDb,
          loop: source.loop,
          sampleRate: source.sampleRate
        }))
      })
      const rendered = renderSpatial({
        sources: loaded,
        layout,
        room,
        durationSeconds,
        sampleRate: Number.isFinite(sampleRate) ? sampleRate : (loaded[0]?.sampleRate ?? 44100)
      })
      const bytes = encodeMultichannelWav(rendered.channels, rendered.sampleRate, { bitDepth, layout: rendered.layout })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'spatial', hash)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)

      // The summary numbers come from a mono fold, the same way every other tool
      // reports "the mix"; per-channel numbers come from the report instead.
      const fold = foldChannels(rendered.channels)
      const metrics = { ...measure(fold, rendered.sampleRate), sampleRate: rendered.sampleRate }
      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size ?? bytes.length,
        durationSeconds: rendered.report.durationSeconds,
        sampleRate: rendered.sampleRate,
        layout: rendered.layout,
        channelCount: rendered.channelCount,
        bitDepth,
        channels: rendered.report.channels.map((channel) => ({
          index: channel.index,
          name: channel.name,
          azimuth: channel.azimuth,
          peakDbfs: channel.peakDbfs,
          rmsDbfs: channel.rmsDbfs
        })),
        metrics,
        report: boundedReport(rendered.report),
        text: summaryText(cwd, target, info.size ?? bytes.length, rendered, loaded.length)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

/** Average the channels down to one buffer, for the usual mix metrics. */
function foldChannels (channels) {
  if (channels.length === 1) return channels[0]
  const frames = channels[0].length
  const out = new Float32Array(frames)
  for (const channel of channels) {
    for (let i = 0; i < frames; i += 1) out[i] += channel[i]
  }
  for (let i = 0; i < frames; i += 1) out[i] /= channels.length
  return out
}
