/**
 * dsh-audio: sound for HTML animation.
 *
 * The plugin owns exactly one seam: audio in, audio out. It renders files and
 * reports measurements; how the page consumes them is the animation author's
 * business. That is why there is no HTML writer, no bundler and no runtime in
 * this package — only tools, a workflow skill, a settings page and a short
 * standing instruction that makes the capability discoverable.
 *
 * The plugin is dependency-free on purpose: every seam it touches (`tools`,
 * `webServer`, `configEditor`) comes from the host, so a profile install needs
 * no package resolution of its own and survives moving the workspace between
 * machines and package stores.
 */

// The extra preset table must be registered before the tool modules load: each
// one snapshots `Object.keys(PRESETS)` when it builds its JSON schema, so a late
// import would leave the enum at the original nine ids. Keep this import first.
import { registerExtraPresets } from './lib/presets-extra.js'

import { registerCheckTool } from './lib/check.js'
import { registerBindTools } from './lib/tools-bind.js'
import { registerConvertTools } from './lib/tools-convert.js'
import { registerSettingsRoute } from './lib/settings-route.js'
import { registerSingTools } from './lib/tools-sing.js'
import { registerSkill } from './lib/skill.js'
import { registerTools } from './lib/tools.js'
import { registerTtsTool, registerVoicesTool } from './lib/tts.js'
import { registerVisualTools } from './lib/tools-visual.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-audio'

/** Shown by the settings page; keep in sync with package.json. */
const VERSION = '0.5.6'

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
  '- `audio_tts` renders narration or dialogue and returns timestamps for subtitles and lip-sync; `audio_voices` lists voice ids.',
  '- `audio_mix` combines rendered files; `audio_probe` measures one; `audio_check` is the quality gate before delivery.',
  '',
  'Call the `animation-sound` skill before the first render: it carries the timing contract that keeps picture and',
  'sound in sync, the preset cheat sheet, and the recipe for inlining audio into a single-file HTML.'
].join('\n')

/**
 * Wire the tools, the workflow skill, the settings endpoints and the standing
 * instruction.
 * @param {object} ctx - registrant context.
 * @param {object} [config] - resolved Config: `tts` and `check` provider settings.
 */
export function apply (ctx, config = {}) {
  registerExtraPresets()
  registerTools(ctx)
  registerTtsTool(ctx, config)
  registerVoicesTool(ctx, config)
  registerCheckTool(ctx, config)
  registerConvertTools(ctx)
  registerVisualTools(ctx)
  registerBindTools(ctx)
  registerSingTools(ctx)
  registerSettingsRoute(ctx, config, VERSION)

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
