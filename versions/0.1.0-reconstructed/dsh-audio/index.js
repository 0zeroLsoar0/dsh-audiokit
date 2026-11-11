/**
 * dsh-audio: sound for HTML animation. (v0.1.0 — reconstructed)
 *
 * The plugin owns exactly one seam: audio in, audio out. It renders files and
 * reports measurements; how the page consumes them is the animation author's
 * business. That is why there is no HTML writer, no bundler and no runtime in
 * this package — only tools, a workflow skill, and a short standing instruction
 * that makes the capability discoverable.
 */

import { registerSkill } from './lib/skill.js'
import { registerTools } from './lib/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-audio'

/** The tool registry is required; the other seams are used when present. */
export const inject = ['tools']

const PROMPT_SECTION = [
  '## Sound for HTML animation',
  '',
  'A page you author is silent by default. When the deliverable is an animation, motion graphic, transition, or any',
  'browser demo with visible movement, give it sound unless the user asked for silence:',
  '',
  '- `audio_synth` renders one synthesized sound (impact, whoosh, tick, chime, riser, zap, thud, scrap, texture).',
  '- `audio_pattern` fills a span with an event train or riser — use it for dense or repeated events instead of many renders.',
  '- `audio_mix` combines rendered files; `audio_probe` measures one (levels, clipping, brightness, loop seam).',
  '',
  'Call the `animation-sound` skill before the first render: it carries the timing contract that keeps picture and',
  'sound in sync, the preset cheat sheet, and the recipe for inlining audio into a single-file HTML.'
].join('\n')

/**
 * Wire the tools, the workflow skill and the standing instruction.
 * @param {object} ctx - registrant context.
 */
export function apply (ctx) {
  registerTools(ctx)

  // Optional seams: resolved through `ctx.get` so the plugin still activates in
  // a composition that does not mount them. `ctx.skills` would throw without a
  // matching `inject` declaration.
  const skills = ctx.get('skills')
  if (skills !== undefined) registerSkill(skills)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'dsh-audio:animation-sound',
      order: 2950,
      text: PROMPT_SECTION
    })
  }
}
