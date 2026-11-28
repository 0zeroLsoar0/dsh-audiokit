/**
 * `audio_bus`: assemble a cue through a processing bus, not just a sum.
 *
 * `audio_mix` places files on a timeline; this tool is the one an author reaches
 * for when the pieces have to *sit* together: a high-pass for rumble, a low-pass
 * to tuck a bed under dialogue, a shelf to brighten a hit, a compressor to glue
 * or duck a layer, and a pan to place it. The signal work lives in `lib/bus.js`;
 * this module only maps model arguments onto it and turns the result into a
 * bounded summary — path, size, master numbers, and per-track meters.
 *
 * Output follows the plugin's contract: one 8/16/24/32-bit mono or stereo file
 * named from a hash of its request, written atomically, plus the numbers. With
 * `stems: true` the processed layers are also exported through `lib/stems.js`:
 * one `<layer>.wav` per track, a `master.wav` that equals their sum, and a
 * `stems.json` manifest. Stems are the mono layers before pan (stems.js has no
 * pan), so a panned cue's stem set reconstructs the un-panned sum, not the
 * stereo file — the report says so rather than hiding it.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import {
  defaultOutputPath,
  finalize,
  hashSpec,
  measure,
  renderPreset,
  resolvePath,
  writeFileAtomic
} from './audio.js'
import { BUS_LIMITS, renderBusAsync } from './bus.js'
import { CHANNEL_COUNTS, encodeAnyWav, layoutFor } from './multichannel.js'
import { STEM_BIT_DEPTHS, packageStems, renderStems } from './stems.js'
import { decodeWav } from './wav.js'

const TOOL = 'audio_bus'
const DEFAULT_BIT_DEPTH = 16
/** The extensible WAV writer behind multichannel output is integer PCM only. */
const MULTICHANNEL_BIT_DEPTHS = [16, 24]
/**
 * How many per-track summaries the one-line report names before it truncates.
 */
const MAX_NAMED_TRACKS = 6
/** Default sidechain duck when `duckFrom` is given without a `duck` object. */
const DEFAULT_DUCK = { amountDb: 12, attackMs: 10, releaseMs: 250 }

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
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function sizeLabel (bytes) {
  return bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${Math.round(bytes / 1024)} KB`
}

function describeValue (value) {
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Read an optional number, rejecting only values that cannot mean anything.
 * A numeric string is accepted because the host may send one.
 */
function readNumber (field, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${TOOL}: ${field} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${TOOL}: ${field} must be a number, got ${describeValue(value)}`)
  return number
}

function readRange (field, value, minimum, maximum) {
  const number = readNumber(field, value)
  if (number === undefined) return undefined
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${TOOL}: ${field} must be a finite number between ${minimum} and ${maximum}, got ${describeValue(value)}`)
  }
  return number
}

function readObject (field, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${TOOL}: ${field} must be an object, got ${describeValue(value)}`)
  }
  return value
}

/** A nested processor object with only the keys the schema declares. */
function readOptions (field, value, keys) {
  const source = readObject(field, value)
  if (source === undefined) return undefined
  const out = {}
  for (const key of keys) {
    const number = readNumber(`${field}.${key}`, source[key])
    if (number !== undefined) out[key] = number
  }
  return out
}

/**
 * Validate one track's source and options before any file is opened, so a bad
 * offset or a missing preset fails in milliseconds instead of after reading a
 * hundred megabytes of wav.
 */
function readTrackSpec (raw, index) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`${TOOL}: tracks[${index}] must be an object, got ${describeValue(raw)}`)
  }
  const hasPath = typeof raw.path === 'string' && raw.path.trim() !== ''
  const hasRender = raw.render !== undefined && raw.render !== null
  if (hasPath === hasRender) {
    throw new Error(`${TOOL}: tracks[${index}] must have exactly one of "path" or "render"`)
  }
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined
  const gainDb = readRange(`tracks[${index}].gainDb`, raw.gainDb, BUS_LIMITS.minGainDb, BUS_LIMITS.maxGainDb) ?? 0
  const offsetSeconds = readRange(`tracks[${index}].offsetSeconds`, raw.offsetSeconds, 0, BUS_LIMITS.maxSeconds) ?? 0
  const pan = readRange(`tracks[${index}].pan`, raw.pan, -1, 1) ?? 0
  const width = readRange(`tracks[${index}].width`, raw.width, 0, BUS_LIMITS.maxWidth) ?? 1
  const highpassHz = readRange(`tracks[${index}].highpassHz`, raw.highpassHz, BUS_LIMITS.minHz, BUS_LIMITS.maxSampleRate / 2)
  const lowpassHz = readRange(`tracks[${index}].lowpassHz`, raw.lowpassHz, BUS_LIMITS.minHz, BUS_LIMITS.maxSampleRate / 2)
  const peaking = readOptions(`tracks[${index}].peaking`, raw.peaking, ['hz', 'q', 'gainDb'])
  const shelf = readOptions(`tracks[${index}].shelf`, raw.shelf, ['hz', 'gainDb', 'slope'])
  if (raw.shelf !== undefined && raw.shelf !== null && raw.shelf.kind !== undefined) {
    if (raw.shelf.kind !== 'low' && raw.shelf.kind !== 'high') {
      throw new Error(`${TOOL}: tracks[${index}].shelf.kind must be "low" or "high", got ${describeValue(raw.shelf.kind)}`)
    }
    shelf.kind = raw.shelf.kind
  }
  const compressor = readOptions(`tracks[${index}].compressor`, raw.compressor, ['thresholdDb', 'ratio', 'attackMs', 'releaseMs', 'makeupDb', 'kneeDb'])
  const duck = readOptions(`tracks[${index}].duck`, raw.duck, ['amountDb', 'attackMs', 'releaseMs'])
  const reference = raw.duckFrom
  if (reference !== undefined && reference !== null && typeof reference !== 'number' && typeof reference !== 'string') {
    throw new Error(`${TOOL}: tracks[${index}].duckFrom must be a track index or a .wav path, got ${describeValue(reference)}`)
  }
  return {
    index,
    name,
    path: hasPath ? raw.path : undefined,
    // Resolve the inline render now: a bad preset or duration fails before any
    // file is read, and the resolved request is what the hash names.
    render: hasRender ? readRenderRequest(raw.render, index) : undefined,
    gainDb,
    offsetSeconds,
    pan,
    width,
    highpassHz,
    lowpassHz,
    peaking,
    shelf,
    compressor,
    duck,
    duckFrom: reference
  }
}

/** Normalise an inline `render` entry into the request `renderPreset` accepts. */
function readRenderRequest (raw, index) {
  const request = typeof raw === 'string' ? { preset: raw } : raw
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`${TOOL}: tracks[${index}].render must be a preset name or an object like { preset, params, duration, seed }`)
  }
  if (typeof request.preset !== 'string' || request.preset.trim() === '') {
    throw new Error(`${TOOL}: tracks[${index}].render needs a preset name`)
  }
  const sampleRate = readRange(`tracks[${index}].render.sampleRate`, request.sampleRate, BUS_LIMITS.minSampleRate, BUS_LIMITS.maxSampleRate)
  const duration = readNumber(`tracks[${index}].render.duration`, request.duration)
  const seed = readNumber(`tracks[${index}].render.seed`, request.seed)
  const params = request.params === undefined || request.params === null ? {} : request.params
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${TOOL}: tracks[${index}].render.params must be an object, got ${describeValue(request.params)}`)
  }
  return {
    preset: request.preset,
    params,
    duration,
    seed: seed === undefined ? 1 : Math.round(seed),
    loop: request.loop === true,
    sampleRate: sampleRate === undefined ? 44100 : Math.round(sampleRate)
  }
}

/**
 * Read a wav file as its real channels.
 *
 * `audio.js`'s `readTrack` folds to mono, which would silently turn a 5.1 input
 * into a mono layer. A multichannel bus needs the channels themselves, so the
 * decode happens here with the same `decodeWav` the master tool uses.
 */
async function readChannelsFile (path) {
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

/**
 * Load every source once. A path shared by two tracks (a bed that also drives a
 * duck, say) is read once; an inline render spec is rendered once. The cache key
 * is the request itself, so two identical renders never drift apart.
 */
async function loadSources (cwd, specs) {
  const cache = new Map()

  const loadPath = async (path) => {
    const key = `path:${path}`
    if (!cache.has(key)) {
      try {
        cache.set(key, await readChannelsFile(path))
      } catch (error) {
        // `readChannelsFile` already says "cannot read <path>: ENOENT"; prefixing
        // the tool name is enough, repeating the sentence reads like a bug.
        throw new Error(`${TOOL}: ${error.message}`)
      }
    }
    return cache.get(key)
  }

  const loadRender = async (request) => {
    const key = `render:${JSON.stringify(request)}`
    if (!cache.has(key)) {
      const rendered = renderPreset({
        preset: request.preset,
        params: request.params,
        duration: request.duration,
        seed: request.seed,
        loop: request.loop,
        sampleRate: request.sampleRate
      })
      // Same finalise as `audio_synth`: a track rendered inline has to equal the
      // file that tool would have written, or the bus changes the sound.
      finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
      cache.set(key, { channels: [rendered.samples], sampleRate: rendered.sampleRate })
    }
    return cache.get(key)
  }

  const sources = []
  for (const spec of specs) {
    if (spec.path !== undefined) {
      const path = resolvePath(cwd, spec.path)
      if (path === undefined) throw new Error(`${TOOL}: tracks[${spec.index}] path is empty`)
      const track = await loadPath(path)
      sources.push({ channels: track.channels, sampleRate: track.sampleRate, id: spec.name ?? basename(path, extname(path)) })
      continue
    }
    const request = spec.render
    const rendered = await loadRender(request)
    sources.push({ channels: rendered.channels, sampleRate: rendered.sampleRate, id: spec.name ?? request.preset })
  }

  return { sources, loadPath }
}

/** Resolve a track's `duckFrom` into channels renderBus can use. */
async function resolveSidechain (cwd, specs, sources, index, loadPath) {
  const reference = specs[index].duckFrom
  if (reference === undefined || reference === null) return undefined
  if (typeof reference === 'number') {
    if (!Number.isInteger(reference) || reference < 0 || reference >= specs.length) {
      throw new Error(`${TOOL}: tracks[${index}].duckFrom is a track index and must be a whole number between 0 and ${specs.length - 1}, got ${describeValue(reference)}`)
    }
    if (reference === index) throw new Error(`${TOOL}: tracks[${index}] cannot duck from itself`)
    return { channels: sources[reference].channels, sampleRate: sources[reference].sampleRate, label: `track ${reference}` }
  }
  if (typeof reference === 'string') {
    if (reference.trim() === '') throw new Error(`${TOOL}: tracks[${index}].duckFrom path is empty`)
    const path = resolvePath(cwd, reference)
    if (path === undefined) throw new Error(`${TOOL}: tracks[${index}].duckFrom path is empty`)
    const track = await loadPath(path)
    return { channels: track.channels, sampleRate: track.sampleRate, label: basename(path, extname(path)) }
  }
  throw new Error(`${TOOL}: tracks[${index}].duckFrom must be a track index or a .wav path, got ${describeValue(reference)}`)
}

/**
 * Map a track's convenience fields onto an ordered processor chain.
 *
 * The order is fixed and documented (highpass, lowpass, peaking, shelf,
 * compressor, duck) because order is audible: a high-pass before a compressor
 * changes what the compressor hears. A caller who wants a different order can
 * call `audio_synth`/`audio_mix` and process the file in two passes.
 */
function buildChain (spec, sidechain) {
  const chain = []
  if (spec.highpassHz !== undefined) chain.push({ type: 'highpass', hz: spec.highpassHz })
  if (spec.lowpassHz !== undefined) chain.push({ type: 'lowpass', hz: spec.lowpassHz })
  if (spec.peaking !== undefined) chain.push({ type: 'peaking', ...spec.peaking })
  if (spec.shelf !== undefined) {
    chain.push({ type: 'shelf', ...spec.shelf, kind: spec.shelf.kind ?? 'high' })
  }
  if (spec.compressor !== undefined) chain.push({ type: 'compressor', ...spec.compressor })
  if (sidechain !== undefined) {
    chain.push({ type: 'duck', sidechain: { channels: sidechain.channels, sampleRate: sidechain.sampleRate }, ...DEFAULT_DUCK, ...(spec.duck ?? {}) })
  }
  return chain
}

/** `mono`, `stereo`, or `6-ch 5.1` — the label a model needs to read a bus report. */
function channelLabel (channels) {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels}-ch ${layoutFor(channels).id}`
}

/** A short per-track fragment for the one-line report. */
function trackBrief (statistics, sidechainLabel) {
  const parts = [statistics.id]
  if (statistics.channels > 2) parts.push(`${statistics.channels}ch`)
  if (statistics.fit !== undefined && statistics.fit.kind !== 'identity') parts.push(`mix ${statistics.fit.from}->${statistics.fit.to}`)
  if (statistics.chain.length > 0) parts.push(statistics.chain.join('+'))
  if (statistics.gainReductionDb > 0.05) parts.push(`GR ${fmt(statistics.gainReductionDb)} dB`)
  if (statistics.maxDuckDb > 0.05) parts.push(`duck ${fmt(statistics.maxDuckDb)} dB${sidechainLabel === undefined ? '' : ` from ${sidechainLabel}`}`)
  if (Math.abs(statistics.pan) > 0.001) parts.push(`pan ${fmt(statistics.pan, 2)}`)
  if (Math.abs(statistics.offsetSeconds) > 0.001) parts.push(`@ ${fmt(statistics.offsetSeconds, 3)} s`)
  return parts.length === 1 ? `${statistics.id} (dry)` : `${statistics.id} (${parts.slice(1).join(', ')})`
}

function summaryLine (cwd, summary) {
  const tracks = summary.tracks.slice(0, MAX_NAMED_TRACKS).map((statistics) => trackBrief(statistics))
  const more = summary.tracks.length > tracks.length ? ` (+${summary.tracks.length - tracks.length} more)` : ''
  const parts = [
    `Wrote bus ${displayPath(cwd, summary.path)}`,
    `${summary.tracks.length} track(s), ${fmt(summary.durationSeconds, 3)}s, ${summary.sampleRate} Hz, ${summary.bitDepth}-bit ${channelLabel(summary.channels)}`,
    sizeLabel(summary.bytes),
    `peak ${fmt(summary.metrics.peakDbfs)} dBFS`,
    `rms ${fmt(summary.metrics.rmsDbfs)} dBFS`,
    `crest ${fmt(summary.metrics.crestDb)} dB`,
    summary.meter.master.limiterEngaged ? `limiter engaged ${fmt(summary.meter.master.limiterReductionDb)} dB` : 'no limiting',
    summary.meter.gainReductionDb > 0.05 ? `max track GR ${fmt(summary.meter.gainReductionDb)} dB` : null,
    `tracks ${tracks.join(', ')}${more}`
  ]
  if (summary.channels > 2) {
    // Per-channel peaks and the one master gain are the two numbers that say a
    // surround file is balanced and unclipped without opening it.
    const names = summary.channelNames.join('/')
    parts.push(`channels ${names} peaks ${summary.metrics.channelPeaksDbfs.map((peak) => fmt(peak)).join('/')} dBFS`)
    parts.push(`mix gain ${fmt(summary.meter.master.mixGainDb)} dB`)
    if (summary.metrics.monoFoldPeakDbfs !== undefined) parts.push(`mono fold peak ${fmt(summary.metrics.monoFoldPeakDbfs)} dBFS`)
  }
  if (summary.stems !== undefined && summary.stems !== null) {
    parts.push(`stems ${displayPath(cwd, summary.stems.outDir)}: ${summary.stems.files.length} mono layer(s) + ${summary.stems.manifestFile}, max sum error ${summary.stems.maxAbsError.toExponential(2)}${summary.channels === 2 ? ' (stems are pre-pan, so they sum to the un-panned mix)' : ''}`)
  }
  if (summary.metrics.clipping > 0) parts.push(`CLIPPING ${summary.metrics.clipping} samples`)
  return parts.filter((part) => part !== null).join(' · ')
}

/** Register the `audio_bus` tool. */
export function registerBusTools (ctx) {
  ctx.tools.register({
    name: 'audio_bus',
    description: 'Assemble a cue through a per-track processing bus (highpass, lowpass, bell, shelf, compressor, sidechain duck, gain, offset, pan, width) and a master drive/limiter/peak stage, optionally exporting the layers as stems. Use audio_mix when the layers only need summing; processor fields are documented in the animation-sound skill. Rendering yields between blocks so the event loop stays live, but it still occupies the CPU while it runs.',
    parameters: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          description: 'Layers in mix order; per-layer fields and chain order are in the skill.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '.wav file, relative to the working directory or absolute. Give this or render, not both.' },
              render: {
                type: 'object',
                additionalProperties: true,
                description: 'Inline render { preset, params, duration, seed, loop, sampleRate }; give this or path.'
              },
              gainDb: { type: 'number', description: 'Track gain in dB, applied before the chain (finite, -120..24; default 0).' },
              offsetSeconds: { type: 'number', description: 'Where the layer starts on the timeline, in seconds (finite, 0..180; default 0).' },
              pan: { type: 'number', description: 'Constant-power pan -1..1, default 0; mono sources only.' },
              width: { type: 'number', description: 'Mid/side width 0..2, default 1; mono sources only.' },
              highpassHz: { type: 'number', description: 'Second-order high-pass corner, Hz (10..48000); removes rumble and DC.' },
              lowpassHz: { type: 'number', description: 'Second-order low-pass corner in Hz. Tucks a bed under dialogue.' },
              peaking: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hz: { type: 'number', description: 'Bell centre, Hz (default 1000).' },
                  q: { type: 'number', description: 'Bell bandwidth, Q 0.1..20 (default 0.707).' },
                  gainDb: { type: 'number', description: 'Boost or cut at the centre, -24..24 dB (default 0).' }
                },
                description: 'One peaking bell: brighten a hit or pull out a boxy resonance.'
              },
              shelf: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['low', 'high'], description: 'high lifts everything above hz, low everything below. Default high.' },
                  hz: { type: 'number', description: 'Shelf corner, Hz (default 1000).' },
                  gainDb: { type: 'number', description: 'Shelf boost or cut, -24..24 dB (default 0).' },
                  slope: { type: 'number', description: 'Shelf slope 0.1..1 (default 1, the steepest without overshoot).' }
                },
                description: 'Shelving band: high shelf brightens, low shelf adds or removes weight.'
              },
              compressor: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  thresholdDb: { type: 'number', description: 'Threshold in dBFS, -80..0 (default -18).' },
                  ratio: { type: 'number', description: 'Ratio 1..40 (default 4; 4 means 4:1).' },
                  attackMs: { type: 'number', description: 'Gain attack settle time in ms (default 10).' },
                  releaseMs: { type: 'number', description: 'Gain release settle time in ms (default 120).' },
                  makeupDb: { type: 'number', description: 'Makeup gain in dB, -24..24 (default 0).' },
                  kneeDb: { type: 'number', description: 'Soft-knee width in dB, 0..24 (default 6; 0 is a hard knee).' }
                },
                description: 'Feed-forward RMS compressor, no lookahead: threshold, ratio, attack/release, makeup, knee.'
              },
              duck: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  amountDb: { type: 'number', description: 'Full dip in dB, 0..60 (default 12).' },
                  attackMs: { type: 'number', description: 'Duck attack settle time in ms (default 10).' },
                  releaseMs: { type: 'number', description: 'Duck release settle time in ms (default 250).' }
                },
                description: 'How hard and how fast to duck when duckFrom is set.'
              },
              duckFrom: {
                type: ['string', 'integer'],
                description: 'Sidechain source: a track index (0-based) or a .wav path; duck depth follows its level.'
              },
              name: { type: 'string', description: 'Track id in the report and stem file name; default the source name.' }
            },
            additionalProperties: false
          }
        },
        masterPeakDbfs: { type: 'number', description: 'Master peak target in dBFS, -120..0, default -1.' },
        driveDb: { type: 'number', description: 'Gain into the master limiter in dB, -24..24, default 0.' },
        limiter: { type: 'boolean', description: 'Soft-limit the master above the knee; defaults to true.' },
        sampleRate: { type: 'integer', description: 'Output rate in Hz (8000..96000); defaults to the highest input rate.' },
        bitDepth: { type: 'integer', enum: STEM_BIT_DEPTHS, description: '8=smallest (inline HTML), 16=CD (default), 24=video master, 32=IEEE float intermediate.' },
        channels: { type: 'integer', enum: [...CHANNEL_COUNTS], description: 'Output channels 1/2/4/6/8; default follows the widest input (2 if any track is panned).' },
        stems: { type: 'boolean', description: 'Also export the processed layers as stems (mono only).' },
        outDir: { type: 'string', description: 'Directory for the stem set; default assets/audio/bus-stems-<hash>.' },
        out: { type: 'string', description: 'Master output path, relative to the working directory. Defaults to assets/audio/bus-<hash>.wav.' }
      },
      required: ['tracks'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Bus ${Array.isArray(args.tracks) ? args.tracks.length : 0} tracks`,
      kind: 'other',
      rawInput: { tracks: Array.isArray(args.tracks) ? args.tracks.length : 0, stems: args.stems === true, out: args.out }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const rawTracks = Array.isArray(args.tracks) ? args.tracks : []
      if (rawTracks.length === 0) {
        throw new Error(`${TOOL}: tracks must be a non-empty array of { path | render, gainDb, offsetSeconds, pan, highpassHz, compressor, duckFrom, ... }`)
      }
      if (rawTracks.length > BUS_LIMITS.maxTracks) {
        throw new Error(`${TOOL}: ${rawTracks.length} tracks exceeds the ${BUS_LIMITS.maxTracks}-track limit; render the cue in parts`)
      }
      // Everything that can be validated without touching the filesystem is
      // validated first: a bad offset must not wait for a 100 MB decode.
      const specs = rawTracks.map((raw, index) => readTrackSpec(raw, index))
      const bitDepth = readRange('bitDepth', args.bitDepth, 8, 32) ?? DEFAULT_BIT_DEPTH
      if (!STEM_BIT_DEPTHS.includes(bitDepth)) {
        throw new Error(`${TOOL}: bitDepth must be one of ${STEM_BIT_DEPTHS.join(', ')}, got ${describeValue(args.bitDepth)}`)
      }
      const channels = readNumber('channels', args.channels)
      if (channels !== undefined && !CHANNEL_COUNTS.includes(channels)) {
        throw new Error(`${TOOL}: channels must be one of ${CHANNEL_COUNTS.join(', ')} (1 mono, 2 stereo, 4 quad, 6 5.1, 8 7.1), got ${describeValue(args.channels)}`)
      }
      const requestedRate = readRange('sampleRate', args.sampleRate, BUS_LIMITS.minSampleRate, BUS_LIMITS.maxSampleRate)
      const masterPeakDbfs = readRange('masterPeakDbfs', args.masterPeakDbfs, BUS_LIMITS.minMasterPeakDbfs, BUS_LIMITS.maxMasterPeakDbfs) ?? -1
      const driveDb = readRange('driveDb', args.driveDb, -BUS_LIMITS.maxDriveDb, BUS_LIMITS.maxDriveDb) ?? 0
      const limiter = args.limiter !== false
      const includeStems = args.stems === true

      const loaded = await loadSources(cwd, specs)
      const sources = loaded.sources
      const sourceRates = sources.map((source) => source.sampleRate).filter((rate) => Number.isFinite(rate) && rate > 0)
      const sampleRate = clampRate(requestedRate ?? Math.max(...sourceRates))

      const busTracks = []
      const sidechainLabels = []
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index]
        const sidechain = await resolveSidechain(cwd, specs, sources, index, loaded.loadPath)
        sidechainLabels[index] = sidechain?.label
        busTracks.push({
          id: sources[index].id,
          channels: sources[index].channels,
          sampleRate: sources[index].sampleRate,
          gainDb: spec.gainDb,
          offsetSeconds: spec.offsetSeconds,
          pan: spec.pan,
          width: spec.width,
          chain: buildChain(spec, sidechain)
        })
      }

      const bus = await renderBusAsync(busTracks, {
        sampleRate,
        channels,
        master: { peakDbfs: masterPeakDbfs, limiter, drive: driveDb }
      })

      // The extensible writer that carries a channel mask is integer PCM only;
      // refusing an 8/32-bit surround file is honest, writing it under a header
      // that lies about the format is not.
      if (bus.channels > 2 && !MULTICHANNEL_BIT_DEPTHS.includes(bitDepth)) {
        throw new Error(`${TOOL}: a ${bus.channels}-channel bus must be written at ${MULTICHANNEL_BIT_DEPTHS.join(' or ')} bits (the extensible WAV writer), got ${bitDepth}-bit`)
      }
      // A stem set is mono layers that sum to a mono master (`lib/stems.js`'s
      // contract). A surround bus has no such set, so say so instead of writing
      // stems that reconstruct something else.
      if (includeStems && (bus.channels > 2 || bus.stems.some((stem) => stem.channelCount > 1))) {
        throw new Error(`${TOOL}: stems are mono pre-pan layers that sum to the master (lib/stems.js); a bus with stereo or surround layers has no mono stem set that reconstructs it, so omit stems`)
      }

      // The encoded file is exactly what renderBus produced: the bus's master
      // stage is the final stage, so no extra normalisation is applied here.
      let bytes
      try {
        bytes = encodeAnyWav(bus.master.channelSamples, bus.sampleRate, { bitDepth })
      } catch (error) {
        throw new Error(`${TOOL}: ${error.message}`)
      }

      const hash = hashSpec({
        kind: 'bus',
        tracks: specs.map((spec) => ({
          path: spec.path === undefined ? undefined : resolvePath(cwd, spec.path),
          render: spec.render,
          gainDb: spec.gainDb,
          offsetSeconds: spec.offsetSeconds,
          pan: spec.pan,
          width: spec.width,
          highpassHz: spec.highpassHz,
          lowpassHz: spec.lowpassHz,
          peaking: spec.peaking,
          shelf: spec.shelf,
          compressor: spec.compressor,
          duck: spec.duck,
          duckFrom: typeof spec.duckFrom === 'string' ? resolvePath(cwd, spec.duckFrom) : spec.duckFrom
        })),
        sampleRate: bus.sampleRate,
        channels: bus.channels,
        masterPeakDbfs,
        driveDb,
        limiter,
        bitDepth,
        stems: includeStems
      })
      const target = resolvePath(cwd, args.out) ?? defaultOutputPath(cwd, 'bus', hash)
      await writeFileAtomic(target, bytes)
      const info = await stat(target)

      const monoMetrics = measure(bus.master.samples, bus.sampleRate)
      const metrics = {
        durationSeconds: bus.durationSeconds,
        peakDbfs: bus.master.peakDbfs,
        rmsDbfs: bus.master.rmsDbfs,
        crestDb: bus.master.crestDb,
        clipping: bus.master.clipping,
        channelPeaksDbfs: bus.master.channelPeaksDbfs,
        channelLayout: bus.master.channelLayout,
        monoFoldPeakDbfs: bus.master.monoFoldPeakDbfs,
        centroidHz: monoMetrics.centroidHz,
        onsets: monoMetrics.onsets,
        dcOffset: monoMetrics.dcOffset
      }

      let stems = null
      if (includeStems) {
        // Stems go through lib/stems.js rather than a second implementation: the
        // layer files, master and manifest are its contract, and its report is
        // the reconstruction proof this tool quotes.
        const layerTracks = bus.stems.map((stem) => ({
          id: stem.id,
          name: stem.id,
          samples: stem.samples,
          sampleRate: stem.sampleRate,
          gainDb: 0,
          offsetSeconds: stem.offsetSeconds
        }))
        const rendered = renderStems(layerTracks, { sampleRate: bus.sampleRate, master: { peakDbfs: masterPeakDbfs, limiter: true } })
        const outDir = resolvePath(cwd, args.outDir) ?? join(cwd, 'assets', 'audio', `bus-stems-${hash}`)
        const packaged = await packageStems(rendered, {
          outDir,
          bitDepth,
          // A stem is one mono layer before pan, so the file is mono even when
          // the master is stereo: dual-mono stems would just double the bytes.
          channels: 1,
          sampleRate: bus.sampleRate,
          manifest: true
        })
        stems = {
          outDir,
          relativeOutDir: displayPath(cwd, outDir),
          files: packaged.stems.map((stem) => ({
            id: stem.id,
            file: stem.file,
            relativePath: displayPath(cwd, stem.path),
            bytes: stem.bytes,
            peakDbfs: stem.peakDbfs,
            rmsDbfs: stem.rmsDbfs
          })),
          masterFile: packaged.master.file,
          manifestFile: 'stems.json',
          totalBytes: packaged.totalBytes,
          maxAbsError: rendered.reconstruction.maxAbsError,
          sumPeakDbfs: rendered.reconstruction.sumPeakDbfs
        }
      }

      const summary = {
        path: target,
        durationSeconds: bus.durationSeconds,
        sampleRate: bus.sampleRate,
        bitDepth,
        channels: bus.channels,
        channelNames: bus.channelNames,
        bytes: info.size ?? bytes.length,
        metrics,
        tracks: bus.meter.trackStats.map((statistics, index) => ({
          id: statistics.id,
          channels: statistics.channels,
          fit: statistics.fit,
          chain: statistics.chain,
          offsetSeconds: statistics.offsetSeconds,
          gainDb: statistics.gainDb,
          pan: statistics.pan,
          width: statistics.width,
          peakInDbfs: statistics.peakInDbfs,
          rmsInDbfs: statistics.rmsInDbfs,
          peakOutDbfs: statistics.peakOutDbfs,
          rmsOutDbfs: statistics.rmsOutDbfs,
          gainReductionDb: statistics.gainReductionDb,
          maxDuckDb: statistics.maxDuckDb,
          duckFrom: sidechainLabels[index] ?? null
        })),
        meter: {
          gainReductionDb: bus.meter.gainReductionDb,
          master: bus.meter.master
        },
        stems
      }

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: summary.bytes,
        durationSeconds: summary.durationSeconds,
        sampleRate: summary.sampleRate,
        bitDepth: summary.bitDepth,
        channels: summary.channels,
        channelLayout: bus.channelLayout,
        channelNames: bus.channelNames,
        channelPeaksDbfs: bus.master.channelPeaksDbfs,
        metrics,
        tracks: summary.tracks,
        gainReductionDb: summary.meter.gainReductionDb,
        master: {
          driveDb: bus.master.driveDb,
          mixGainDb: bus.master.mixGainDb,
          gainDb: bus.master.gainDb,
          limiterEngaged: bus.master.limiterEngaged,
          limiterReductionDb: bus.master.limiterReductionDb
        },
        stems,
        text: summaryLine(cwd, summary)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}

/** Clamp a rate into the engine window; every input must declare a usable one. */
function clampRate (rate) {
  const number = Number(rate)
  if (!Number.isFinite(number) || number <= 0) return 44100
  return Math.min(BUS_LIMITS.maxSampleRate, Math.max(BUS_LIMITS.minSampleRate, Math.round(number)))
}
