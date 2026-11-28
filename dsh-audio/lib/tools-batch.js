/**
 * `audio_batch`: one call over a whole cue project.
 *
 * The single-file tools are the right shape for one sound and the wrong shape
 * for forty: each call costs a round-trip, a decode and a report, and an agent
 * that has to finish a cue set runs out of steps before it runs out of files.
 * This tool runs one of four delivery operations over a list and returns one
 * table (`lib/batch.js` is the implementation).
 *
 * The schema stays small on purpose — six arguments, four actions — because the
 * value of a batch tool is the decision it *saves*, not the knobs it adds. The
 * true-peak ceiling and the output format are module constants (see
 * `lib/batch.js`), and the per-file detail lives in `items` rather than in the
 * argument list.
 */

import { runBatch } from './batch.js'

/**
 * Resolve the session working directory.
 *
 * `ctx.workingDirectory` throws unless it is a declared injection, so the
 * optional service is resolved by name instead — the same helper every other
 * tool file uses.
 */
function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

/**
 * Register the `audio_batch` tool.
 * @param {object} ctx - Cordis context with the tools service.
 */
export function registerBatchTools (ctx) {
  ctx.tools.register({
    name: 'audio_batch',
    description: 'Run one delivery operation across many .wav files in a single call: check (quality gate), loudness (LUFS/true peak only), normalize (a true-peak-safe copy toward a target LUFS) or master (the full mastering chain). A file that fails is reported in items[].error and does not abort the batch; inputs are never overwritten (copies land in outDir). Concurrency only overlaps decode/write I/O — the DSP is synchronous, so the CPU still renders one file at a time.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Wav paths, relative to the working directory or absolute. Give files or cues, not both.'
        },
        cues: {
          type: 'array',
          description: 'Cue entries instead of files: each { path, at? }. `at` is carried into the report (which cue the file belongs to); it does not change the operation.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Audio file path.' },
              at: { type: 'number', description: 'Planned cue start in seconds, repeated in the report for identification.' }
            },
            required: ['path']
          }
        },
        action: {
          type: 'string',
          enum: ['check', 'loudness', 'normalize', 'master'],
          description: 'check (default, no writing): clipping/silence/peak/DC gate. loudness: measure LUFS and true peak and flag silent or over-ceiling files. normalize: write a gain-corrected copy per file toward targetLufs. master: write a mastered copy per file.'
        },
        targetLufs: {
          type: 'number',
          description: 'Target integrated loudness for normalize/master: -14 web (default), -16 podcast, -23 broadcast. For loudness it only turns on an off-target judgement.'
        },
        outDir: {
          type: 'string',
          description: 'Directory for normalize/master copies, relative to the working directory or absolute; default out/batch. An output path that equals an input path is refused, never written over.'
        },
        concurrency: {
          type: 'integer',
          description: 'Files in flight at once, 1..8; default half the CPUs capped at 4. Only I/O waits overlap — the DSP stays serial.'
        }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Batch ${args.action ?? 'check'} · ${(args.files ?? args.cues ?? []).length} file(s)`,
      kind: 'other',
      rawInput: { action: args.action ?? 'check', outDir: args.outDir }
    }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      // Validation and execution live in `runBatch` so a direct caller of the
      // module gets the same errors; this tool only routes the arguments.
      return await runBatch({
        cwd,
        files: args.files,
        cues: args.cues,
        action: args.action,
        targetLufs: args.targetLufs,
        outDir: args.outDir,
        concurrency: args.concurrency
      })
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
