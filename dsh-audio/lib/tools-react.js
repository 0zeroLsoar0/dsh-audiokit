/**
 * `audio_react`: interaction audio for a page.
 *
 * One call produces the whole UI sound set: the clips, the manifest and the
 * drop-in binding script. The interesting product decision is that the tool
 * never asks the model for selector maps — the generated script binds
 * `data-sound` attributes, so the model's job is "a crisp set with hover and
 * error", and the page author's job is adding an attribute.
 *
 * The output is deliberately two files:
 *   - `<out>.js`   the pasteable script (inline clips by default),
 *   - `<out>.json` the manifest, with no base64, so a later tool or a human can
 *                  see exactly what was bound and how loud each sound is.
 */

import { basename, join, relative } from 'node:path'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import { DEFAULT_MAX_INLINE_BYTES } from './bind.js'
import {
  AUTO_INTERACTIONS,
  INTERACTION_IDS,
  PALETTE_NAMES,
  buildBindingScript,
  buildInteractionSet,
  renderInteractionSet
} from './react.js'

const INTERACTION_CHOICES = [...INTERACTION_IDS, 'auto']

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

function formatBytes (bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * Read an optional numeric argument, rejecting only values that have no
 * meaning. `undefined`/`null` mean "use the default".
 */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${tool}: ${key} must be a number, got ${JSON.stringify(value)}`)
  return number
}

/** The inline budget: a positive byte count, or the documented default. */
function resolveInlineBudget (value) {
  if (value === undefined || value === null) return DEFAULT_MAX_INLINE_BYTES
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 1) {
    throw new Error(`audio_react: maxBytes must be a positive integer (default ${DEFAULT_MAX_INLINE_BYTES})`)
  }
  return Math.floor(bytes)
}

/** Strip a `.json` / `.js` extension from a requested output stem. */
function outputStem (requested) {
  return requested.replace(/\.(?:json|js)$/i, '')
}

/** Register `audio_react` on `ctx.tools`. */
export function registerReactTools (ctx) {
  ctx.tools.register({
    name: 'audio_react',
    description: 'Render the sounds a UI makes (hover, press, success, error, typing, ...) as one palette-consistent set, and write a drop-in <out>.js that binds them to DOM events through data-sound attributes. Use this instead of audio_synth when the deliverable is interactive: the script never autoplays, decodes on the first gesture, and caps how loud a rapid repeat can stack.',
    parameters: {
      type: 'object',
      properties: {
        interactions: {
          type: 'array',
          items: { type: 'string', enum: INTERACTION_CHOICES },
          description: `Interaction ids to render. Omit or pass ["auto"] for the default set (${AUTO_INTERACTIONS.join(', ')}). Available: ${INTERACTION_IDS.join(', ')}.`
        },
        palette: {
          type: 'string',
          enum: PALETTE_NAMES,
          description: 'Style family shared by the whole set, so a page sounds like one product. soft=dark and rounded, crisp=bright and tight (default), organic=warm and slightly detuned, digital=thin high-passed blips, cinematic=low and spacious.'
        },
        seed: { type: 'integer', description: 'Variation seed for the random surface (noise, partial levels). Same seed reproduces identical clip bytes; defaults to 1.' },
        sampleRate: { type: 'integer', description: 'Render rate in Hz; defaults to 22050 because these are short blips and the script carries the clips (use 44100 or 48000 for video-grade audio).' },
        out: { type: 'string', description: 'Output stem relative to the working directory; writes <out>.js and <out>.json. Defaults to assets/audio/react-<hash>.' },
        inline: { type: 'boolean', description: 'Embed the clips as base64 inside the .js so the page needs no other files (defaults to true when the script fits maxBytes; otherwise the clips are written next to the script and the script fetches them).' },
        maxBytes: { type: 'integer', description: `Inline script budget in bytes (positive); defaults to ${DEFAULT_MAX_INLINE_BYTES} (2 MB).` }
      },
      required: [],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Interaction sounds${Array.isArray(args.interactions) ? ` (${args.interactions.length})` : ''}`,
      kind: 'other',
      rawInput: args
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const requestedRate = readNumber('audio_react', 'sampleRate', args.sampleRate)
      const requestedSeed = readNumber('audio_react', 'seed', args.seed)
      const maxBytes = resolveInlineBudget(args.maxBytes)

      const set = buildInteractionSet({
        palette: args.palette,
        interactions: args.interactions,
        seed: requestedSeed ?? 1,
        sampleRate: requestedRate ?? 22050
      })
      const rendered = renderInteractionSet(set, { sampleRate: set.sampleRate })

      const hash = hashSpec({
        kind: 'react',
        palette: set.palette.id,
        seed: set.seed,
        sampleRate: set.sampleRate,
        // Inline and external are different deliverables; giving them different
        // hashes keeps the default paths from overwriting each other.
        inline: args.inline !== false,
        cues: set.cues.map((cue) => [cue.name, cue.seed, cue.durationSeconds, cue.gainDb, cue.source])
      })
      const requested = resolvePath(cwd, args.out) ?? resolvePath(cwd, `assets/audio/react-${hash}`)
      const stem = outputStem(requested)
      const jsPath = `${stem}.js`
      const jsonPath = `${stem}.json`

      const wantInline = args.inline !== false
      let inline = false
      let fallback = false
      let inlineBytes = 0
      let clipDir = null
      let clipBytes = rendered.totalBytes
      let built

      if (wantInline) {
        built = buildBindingScript({
          clips: rendered.clips.map((clip) => ({ name: clip.name, gainDb: clip.gainDb, bytes: clip.bytes }))
        })
        inlineBytes = built.bytes
        inline = inlineBytes <= maxBytes
        fallback = !inline
      }
      if (!inline) {
        // The clips are short; writing them beside the script keeps the page
        // working without a base64 copy, and the manifest still says where.
        clipDir = `${stem}-clips`
        for (const clip of rendered.clips) {
          await writeFileAtomic(join(clipDir, `${clip.name}.wav`), clip.bytes)
        }
        const relativeDir = `${basename(stem)}-clips`
        built = buildBindingScript({
          clips: rendered.clips.map((clip) => ({ name: clip.name, gainDb: clip.gainDb, src: `${relativeDir}/${clip.name}.wav` }))
        })
      }

      const jsBytes = Buffer.byteLength(built.script, 'utf8')
      const jsonBytes = Buffer.byteLength(built.json, 'utf8')
      await writeFileAtomic(jsPath, Buffer.from(built.script, 'utf8'))
      await writeFileAtomic(jsonPath, Buffer.from(built.json, 'utf8'))

      const totalDurationSeconds = rendered.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0)
      const pageWeightBytes = inline ? jsBytes : jsBytes + clipBytes
      const preview = rendered.clips.slice(0, 8).map((clip) => {
        const cue = set.cues.find((candidate) => candidate.name === clip.name)
        return `${clip.name} ${fmt(clip.durationSeconds, 2)}s ${fmt(cue.gainDb, 0)}dB ${fmt(clip.peakDbfs, 1)}dBFS`
      }).join(' · ')
      const more = rendered.clips.length > 8 ? ` · … +${rendered.clips.length - 8} more` : ''
      const lines = [
        `Wrote interaction set ${displayPath(cwd, jsPath)} + ${displayPath(cwd, jsonPath)} ` +
        `(${rendered.clips.length} sound(s), ${set.palette.id} palette, ${fmt(totalDurationSeconds, 2)}s of audio, ` +
        `script ${formatBytes(jsBytes)}, clips ${formatBytes(clipBytes)})`,
        inline
          ? `  inline: ${rendered.clips.length} clip(s) as base64 inside the script — page weight ${formatBytes(pageWeightBytes)} of ${formatBytes(maxBytes)} budget, zero network requests`
          : `  external: ${rendered.clips.length} clip(s) written to ${displayPath(cwd, clipDir)} (${formatBytes(clipBytes)}) and fetched by the script; keep the script and that folder together` +
            (fallback ? ` (inline refused: ${formatBytes(inlineBytes)} > ${formatBytes(maxBytes)} budget)` : ''),
        '  bound without JS: <button data-sound="press" data-sound-enter="hover"> — data-sound plays on click, data-sound-enter on mouseenter, data-sound-leave on mouseleave',
        `  programmatic: dshUI.unlock() from any gesture · dshUI.play('success') afterwards · dshUI.bind('.card', { enter: 'hover', leave: 'close', press: 'press' }) · dshUI.setEnabled(false) mutes`,
        `  sounds: ${preview}${more}`
      ]

      return {
        ok: true,
        jsPath,
        jsonPath,
        relativeJsPath: displayPath(cwd, jsPath),
        relativeJsonPath: displayPath(cwd, jsonPath),
        jsBytes,
        jsonBytes,
        pageWeightBytes,
        inline,
        fallback,
        maxBytes,
        clipDir: clipDir === null ? null : displayPath(cwd, clipDir),
        clipBytes,
        clipCount: rendered.clips.length,
        totalDurationSeconds,
        palette: set.palette.id,
        seed: set.seed,
        sampleRate: set.sampleRate,
        interactions: set.cues.map((cue) => cue.name),
        // Bounded summary: never echo samples or base64 back to the model.
        clips: rendered.clips.slice(0, 24).map((clip, index) => ({
          name: clip.name,
          gainDb: clip.gainDb,
          durationSeconds: Number(clip.durationSeconds.toFixed(3)),
          peakDbfs: clip.peakDbfs,
          rmsDbfs: clip.rmsDbfs,
          centroidHz: clip.centroidHz,
          bytes: clip.bytes.length,
          source: set.cues[index].source.kind === 'design'
            ? `design:${set.cues[index].source.recipe}`
            : `preset:${set.cues[index].source.preset}`
        })),
        text: lines.join('\n')
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
