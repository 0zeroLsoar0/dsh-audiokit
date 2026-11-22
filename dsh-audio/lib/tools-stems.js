/**
 * `audio_stems`: export a cue set as stems plus a reconstructing master.
 *
 * This is the tool a video, game or DAW pipeline reaches for instead of
 * `audio_mix`: `audio_mix` collapses N tracks into one file, while this writes
 * one `<layer>.wav` per track, a `master.wav` that equals their sum, and a
 * `stems.json` manifest hashing and measuring every file. The heavy lifting is
 * in `lib/stems.js`; this module only maps tool arguments to that API and turns
 * the result into a bounded summary — the model reads numbers, never audio.
 */

import { basename, extname, join, relative } from 'node:path'
import {
  finalize,
  hashSpec,
  readTrack,
  renderPreset,
  resolvePath,
  validateMixOptions
} from './audio.js'
import { STEM_BIT_DEPTHS, packageStems, planStems, renderStems } from './stems.js'

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
 * Read an optional numeric argument, rejecting only values that cannot mean
 * anything. A numeric string is accepted because the host may send one.
 */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number, got ${describeValue(value)}`)
  return number
}

/**
 * Load one track entry: a `.wav` on disk, or an inline render spec so a stem set
 * can be assembled without a render round trip per layer.
 *
 * Render entries are finalised exactly like `audio_synth` writes them (DC block,
 * -1 dBFS peak, soft limit), so a stem rendered inline matches the same file
 * rendered to disk and mixed by `audio_mix`.
 */
async function loadTracks (cwd, specs, defaultSampleRate) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('audio_stems: tracks must be a non-empty array of { path | render, gainDb, offsetSeconds, name }')
  }
  const tracks = []
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]
    if (spec === null || typeof spec !== 'object') {
      throw new Error(`audio_stems: tracks[${index}] must be an object, got ${describeValue(spec)}`)
    }
    const hasPath = typeof spec.path === 'string' && spec.path.trim() !== ''
    const hasRender = spec.render !== undefined && spec.render !== null
    if (hasPath === hasRender) {
      throw new Error(`audio_stems: tracks[${index}] must have exactly one of "path" or "render"`)
    }
    const name = typeof spec.name === 'string' && spec.name.trim() !== '' ? spec.name.trim() : undefined

    if (hasPath) {
      const path = resolvePath(cwd, spec.path)
      if (path === undefined) throw new Error(`audio_stems: tracks[${index}] path is empty`)
      let track
      try {
        track = await readTrack(path)
      } catch (error) {
        // Keep the file the caller named in the message: "cannot read
        // /work/assets/kick.wav" is actionable, "cannot read track" is not.
        throw new Error(`audio_stems: tracks[${index}]${name === undefined ? '' : ` "${name}"`} — ${error.message}`)
      }
      const id = name ?? basename(path, extname(path)) ?? `stem-${index + 1}`
      tracks.push({
        id,
        name: id,
        samples: track.samples,
        sampleRate: track.sampleRate,
        gainDb: spec.gainDb,
        offsetSeconds: spec.offsetSeconds
      })
      continue
    }

    const request = typeof spec.render === 'string' ? { preset: spec.render } : spec.render
    if (request === null || typeof request !== 'object' || typeof request.preset !== 'string' || request.preset.trim() === '') {
      throw new Error(`audio_stems: tracks[${index}] render needs a preset name`)
    }
    const rendered = renderPreset({
      preset: request.preset,
      params: request.params ?? {},
      duration: request.duration,
      seed: request.seed ?? 1,
      loop: request.loop === true,
      sampleRate: request.sampleRate ?? defaultSampleRate
    })
    finalize(rendered.samples, rendered.sampleRate, -1, { loop: rendered.spec.loop === true })
    const id = name ?? request.preset
    tracks.push({
      id,
      name: id,
      samples: rendered.samples,
      sampleRate: rendered.sampleRate,
      gainDb: spec.gainDb,
      offsetSeconds: spec.offsetSeconds
    })
  }
  return tracks
}

/** One bounded human line naming the files, the master and the invariant. */
function summaryLine (cwd, packaged, reconstruction, includeManifest) {
  const files = packaged.stems.map((stem) => stem.file)
  const shown = files.slice(0, 8)
  const more = files.length > shown.length ? ` (+${files.length - shown.length} more)` : ''
  const parts = [
    `Wrote ${packaged.stems.length} stem(s) + master to ${displayPath(cwd, packaged.outDir)}`,
    `${packaged.bitDepth}-bit ${packaged.channels === 2 ? 'stereo' : 'mono'} ${packaged.sampleRate} Hz`,
    `${fmt(packaged.durationSeconds, 3)}s`,
    sizeLabel(packaged.totalBytes),
    `files ${shown.join(', ')}${more}, master.wav${includeManifest ? ', stems.json' : ''}`,
    `master peak ${fmt(packaged.master.peakDbfs)} dBFS`,
    `rms ${fmt(packaged.master.rmsDbfs)} dBFS`,
    `sum(stems)-master max error ${reconstruction.maxAbsError.toExponential(2)}`,
    `sum peak ${fmt(reconstruction.sumPeakDbfs)} dBFS`
  ]
  return parts.join(' · ')
}

/** Register the `audio_stems` tool. */
export function registerStemsTools (ctx) {
  ctx.tools.register({
    name: 'audio_stems',
    description: 'Export a cue set as stems: one .wav per layer, a master.wav that equals their sum, and a stems.json manifest with per-file duration, peak, RMS and sha256. Use it instead of audio_mix when a video, game or DAW pipeline needs the layers separate (mute, rebalance or process one at a time) while still being able to reconstruct the mixed cue.',
    parameters: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          description: 'Layers in mix order, each { path | render, gainDb, offsetSeconds, name }. Offsets place each layer on the shared timeline; the master is the sum of the placed stems.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '.wav file, relative to the working directory or absolute. Give this or render, not both.' },
              render: {
                type: 'object',
                additionalProperties: true,
                description: 'Inline render instead of a file: { preset, params, duration, seed, loop, sampleRate } exactly as audio_synth accepts. Give this or path, not both.'
              },
              gainDb: { type: 'number', description: 'Per-layer gain in dB (finite, -120..24; e.g. -6 quiets a layer by 6 dB). Defaults to 0.' },
              offsetSeconds: { type: 'number', description: 'Where the layer starts on the shared timeline, in seconds (finite, 0..180). Defaults to 0.' },
              name: { type: 'string', description: 'Stem id used for the file name (<name>.wav) and the manifest. Defaults to the file name or preset name.' }
            },
            additionalProperties: false
          }
        },
        outDir: { type: 'string', description: 'Directory to write <stem>.wav, master.wav and stems.json into, relative to the working directory. Created if missing; defaults to assets/audio/stems-<hash>.' },
        bitDepth: { type: 'integer', enum: STEM_BIT_DEPTHS, description: '8=smallest (inline HTML), 16=CD, 24=video master (default), 32=IEEE float intermediate.' },
        channels: { type: 'integer', enum: [1, 2], description: '1=mono (default), 2=stereo dual-mono.' },
        sampleRate: { type: 'integer', description: 'Output rate; defaults to the highest input rate. All stems are resampled to it so they stay frame-aligned.' },
        masterPeakDbfs: { type: 'number', description: 'Peak-normalisation target for the master, in dBFS (-120..0; default -1). The same gain is applied to every stem so they still sum to the master.' },
        manifest: { type: 'boolean', description: 'Write stems.json with per-file duration, peak, RMS and sha256. Defaults to true.' }
      },
      required: ['tracks'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Export ${Array.isArray(args.tracks) ? args.tracks.length : 0} stems`,
      kind: 'other',
      rawInput: { tracks: Array.isArray(args.tracks) ? args.tracks.length : 0, outDir: args.outDir, bitDepth: args.bitDepth, channels: args.channels }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const rawTracks = Array.isArray(args.tracks) ? args.tracks : []
      // Reject a bad gain/offset before any file is opened: the same checks run
      // inside planStems, but by then every input has already been read.
      validateMixOptions({
        gains: rawTracks.map((track) => (track !== null && typeof track === 'object' ? track.gainDb ?? 0 : 0)),
        offsets: rawTracks.map((track) => (track !== null && typeof track === 'object' ? track.offsetSeconds ?? 0 : 0))
      })
      const bitDepth = readNumber('audio_stems', 'bitDepth', args.bitDepth) ?? 24
      if (!STEM_BIT_DEPTHS.includes(bitDepth)) {
        throw new Error(`audio_stems: bitDepth must be one of ${STEM_BIT_DEPTHS.join(', ')}, got ${describeValue(args.bitDepth)}`)
      }
      const channels = readNumber('audio_stems', 'channels', args.channels) ?? 1
      if (channels !== 1 && channels !== 2) {
        throw new Error(`audio_stems: channels must be 1 or 2, got ${describeValue(args.channels)}`)
      }
      const sampleRate = readNumber('audio_stems', 'sampleRate', args.sampleRate)
      const requestedPeak = readNumber('audio_stems', 'masterPeakDbfs', args.masterPeakDbfs)
      const masterPeakDbfs = requestedPeak === undefined ? -1 : requestedPeak
      const includeManifest = args.manifest !== false

      const tracks = await loadTracks(cwd, rawTracks, sampleRate ?? 44100)
      const master = { peakDbfs: masterPeakDbfs, limiter: true }
      const plan = planStems({ tracks, sampleRate, master })
      const rendered = renderStems(tracks, { sampleRate: plan.sampleRate, master })
      const hash = hashSpec({
        kind: 'stems',
        tracks: tracks.map((track) => ({
          id: track.id,
          sampleRate: track.sampleRate,
          frames: track.samples.length,
          gainDb: track.gainDb ?? 0,
          offsetSeconds: track.offsetSeconds ?? 0
        })),
        bitDepth,
        channels,
        sampleRate: plan.sampleRate,
        masterPeakDbfs: plan.master.peakDbfs,
        manifest: includeManifest
      })
      const outDir = resolvePath(cwd, args.outDir) ?? join(cwd, 'assets', 'audio', `stems-${hash}`)
      const packaged = await packageStems(rendered, {
        outDir,
        bitDepth,
        channels,
        sampleRate: plan.sampleRate,
        manifest: includeManifest
      })

      return {
        path: outDir,
        relativePath: displayPath(cwd, outDir),
        bytes: packaged.totalBytes,
        durationSeconds: packaged.durationSeconds,
        sampleRate: packaged.sampleRate,
        bitDepth: packaged.bitDepth,
        channels: packaged.channels,
        stems: packaged.stems.map((stem) => ({
          id: stem.id,
          file: stem.file,
          relativePath: displayPath(cwd, stem.path),
          bytes: stem.bytes,
          durationSeconds: stem.durationSeconds,
          peakDbfs: stem.peakDbfs,
          rmsDbfs: stem.rmsDbfs,
          crestDb: stem.crestDb,
          clipping: stem.clipping,
          gainDb: stem.gainDb,
          offsetSeconds: stem.offsetSeconds
        })),
        master: {
          file: 'master.wav',
          relativePath: displayPath(cwd, packaged.master.path),
          bytes: packaged.master.bytes,
          durationSeconds: packaged.master.durationSeconds,
          peakDbfs: packaged.master.peakDbfs,
          rmsDbfs: packaged.master.rmsDbfs,
          gainDb: packaged.master.gainDb,
          limiterEngaged: packaged.master.limiterEngaged
        },
        reconstruction: {
          maxAbsError: rendered.reconstruction.maxAbsError,
          sumPeakDbfs: rendered.reconstruction.sumPeakDbfs,
          preMasterPeakDbfs: rendered.reconstruction.preMasterPeakDbfs,
          masterGainDb: rendered.reconstruction.masterGainDb,
          limiterEngaged: rendered.reconstruction.limiterEngaged,
          tolerance: rendered.reconstruction.tolerance
        },
        budget: plan.budget,
        manifestPath: packaged.manifestPath,
        relativeManifestPath: packaged.manifestPath === null ? undefined : displayPath(cwd, packaged.manifestPath),
        text: summaryLine(cwd, packaged, rendered.reconstruction, includeManifest)
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
