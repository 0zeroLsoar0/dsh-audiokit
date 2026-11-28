/**
 * `audio_cues`: read an existing wav and turn it back into a cue sheet.
 *
 * Every other tool in this package goes sound → file; this one goes file →
 * timing. It is the reverse direction of `audio_bind`, and it exists because the
 * common authoring case is "the sound is already there, the animation is not":
 * a supplied track, a rendered mix or a video's extracted audio can drive the
 * picture if the model can be told where the hits are.
 *
 * The analysis itself is pure (`lib/cues.js`); this file only resolves the path,
 * decodes the file, writes the optional JSON and shapes the one-line report.
 * Mono folding matches `audio_beats`: the detector reasons about one envelope,
 * and a hard-panned hit is still present (only a true out-of-phase pair cancels,
 * which the docs call out).
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { readTrack, resolvePath, writeFileAtomic } from './audio.js'
import { CUE_DEFAULTS, detectCues } from './cues.js'

const TOOL_NAME = 'audio_cues'

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

function fmt (value, digits = 2) {
  return Number(value).toFixed(digits)
}

/**
 * Resolve the JSON target. A bare stem gets `.json` appended, an explicit file
 * name is kept because it may be consumed by another tool.
 */
function outputTarget (cwd, requested) {
  const resolved = resolvePath(cwd, requested)
  if (resolved === undefined) return undefined
  const base = resolved.split(/[\\/]/).pop() ?? ''
  return base.includes('.') ? resolved : `${resolved}.json`
}

/** Register the `audio_cues` tool on `ctx.tools`. */
export function registerCueTools (ctx) {
  ctx.tools.register({
    name: TOOL_NAME,
    description: 'Detect impact points and section boundaries in an existing .wav so an animation can follow the sound (the reverse of audio_bind). Returns `cues` as [{ at, strength, kind }] with kind onset (a sharp hit) or section (a lasting level change), plus durationSeconds, sampleRate and warnings; `out` writes the same object as JSON. `sensitivity` keeps progressively weaker hits (the count is monotonically non-decreasing), `minGapSeconds` merges a flam into one cue, and `maxCues` keeps the strongest. Built for percussive material: sustained pads and reverb tails are approximate.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing mono/stereo .wav to analyse, relative to the working directory or absolute. Stereo is folded to mono before detection.' },
        sensitivity: { type: 'number', description: '0..1, default 0.5. Higher keeps weaker hits; the number of cues is monotonically non-decreasing as this rises.' },
        minGapSeconds: { type: 'number', description: 'Minimum spacing between cues in seconds, default 0.08 (80 ms); a later hit closer than this to an earlier one is dropped, so a flam counts once.' },
        maxCues: { type: 'integer', description: 'Cap on returned cues, default 200; the strongest are kept and a warning names how many were dropped.' },
        out: { type: 'string', description: 'Write the cue sheet JSON here. Defaults to no file; the cues are always returned.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: 'Detect audio cues', kind: 'other', rawInput: { source: args.path, sensitivity: args.sensitivity ?? CUE_DEFAULTS.sensitivity } }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const path = resolvePath(cwd, args.path)
      if (path === undefined) throw new Error('audio_cues needs a .wav path')
      const track = await readTrack(path)
      const analysis = detectCues(track.samples, track.sampleRate, {
        sensitivity: args.sensitivity,
        minGapSeconds: args.minGapSeconds,
        maxCues: args.maxCues
      })

      let target = null
      let bytes = 0
      if (typeof args.out === 'string' && args.out.trim() !== '') {
        target = outputTarget(cwd, args.out)
        if (target !== undefined) {
          const content = JSON.stringify(analysis, null, 2)
          await writeFileAtomic(target, Buffer.from(content, 'utf8'))
          const info = await stat(target)
          bytes = info.size
        }
      }

      const onsets = analysis.cues.filter((cue) => cue.kind === 'onset').length
      const sections = analysis.cues.length - onsets
      const first = analysis.cues.slice(0, 8).map((cue) => `${fmt(cue.at, 3)}s ${cue.kind}`)
      const where = target === null
        ? 'no file written (pass out to save)'
        : `wrote ${displayPath(cwd, target)} (${fmt(bytes / 1024, 1)} KB)`
      const notes = analysis.warnings.length > 0 ? ` · notes: ${analysis.warnings.join('; ')}` : ''
      const text = analysis.cues.length === 0
        ? `No cues detected in ${displayPath(cwd, path)} (${fmt(analysis.durationSeconds)}s): the material has no sharp impacts or lasting level changes at this sensitivity. — ${where}`
        : `Detected ${analysis.cues.length} cue(s) in ${displayPath(cwd, path)} (${fmt(analysis.durationSeconds)}s, ${analysis.sampleRate} Hz): ${onsets} onset · ${sections} section · first ${first.join(', ')} — ${where}${notes}`

      return {
        path: target,
        relativePath: target === null ? null : displayPath(cwd, target),
        bytes,
        cueCount: analysis.cues.length,
        onsetCount: onsets,
        sectionCount: sections,
        cues: analysis.cues,
        durationSeconds: analysis.durationSeconds,
        sampleRate: analysis.sampleRate,
        warnings: analysis.warnings,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
