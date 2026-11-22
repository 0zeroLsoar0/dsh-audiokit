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
import { registerAnalyzeTools } from './lib/tools-analyze.js'
import { registerBindTools } from './lib/tools-bind.js'
import { registerComposeTools } from './lib/tools-compose.js'
import { registerConvertTools } from './lib/tools-convert.js'
import { registerDesignTools } from './lib/tools-design.js'
import { registerLoudnessTools } from './lib/tools-loudness.js'
import { registerReactTools } from './lib/tools-react.js'
import { registerSettingsRoute } from './lib/settings-route.js'
import { registerSingTools } from './lib/tools-sing.js'
import { registerSkill } from './lib/skill.js'
import { registerStemsTools } from './lib/tools-stems.js'
import { registerStretchTools } from './lib/tools-stretch.js'
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
  'A page you author is silent by default. When the deliverable is an animation, motion graphic, transition, video or',
  'browser demo with visible movement, give it sound unless the user asked for silence. Pick the tool by what the',
  'sound *is*, not by what it is made of:',
  '',
  '- one hit, texture or foley sound → `audio_synth` (38 presets; deterministic, same seed = same bytes)',
  '- many events from one rule (typing, rain, accelerating ticks) → `audio_pattern`',
  '- a designed object ("metal door slam", "magic sparkle") → `audio_design` (26 layered recipes)',
  '- combining rendered files into one cue → `audio_mix` (per-track gain and time offsets)',
  '- music: a cue with harmony and a groove → `audio_compose` (8 genres, returns beat times for sync)',
  '- narration or dialogue → `audio_tts`; singing → `audio_sing` (zero assets); `audio_voices` lists voice ids',
  '- character mouth / lip-sync → `audio_lipsync` (per-frame viseme + jaw openness)',
  '- motion that should land on the music → `audio_beats`',
  '- assembling cues + the page player → `audio_bind` (generates the scheduling code, inline or external)',
  '- the UI making its own sounds (hover, click, success, error) → `audio_react` (16 interactions, 5 palettes,',
  '  drop-in binding script); per-layer deliverables for video/games → `audio_stems` (stems + master)',
  '- what a sound is made of: f0, harmonics, formants, noise, decay → `audio_analyze`',
  '- fixing an existing file: trim/join/fade/re-encode → `audio_convert`; retime or transpose → `audio_stretch`',
  '- before delivery: `audio_probe` (measure), `audio_loudness` (LUFS/true peak), `audio_check` (quality gate),',
  '  `audio_regress` (prove a change did not break a sound)',
  '',
  'Call the `animation-sound` skill before the first render: it carries the timing contract that keeps picture and',
  'sound in sync, the preset and recipe cheat sheets, and the recipe for inlining audio into a single-file HTML.'
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
  registerAnalyzeTools(ctx)
  registerConvertTools(ctx)
  registerLoudnessTools(ctx)
  registerDesignTools(ctx)
  registerVisualTools(ctx)
  registerBindTools(ctx)
  registerReactTools(ctx)
  registerComposeTools(ctx)
  registerSingTools(ctx, config)
  registerStemsTools(ctx)
  registerStretchTools(ctx)
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
