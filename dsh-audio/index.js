/**
 * dsh-audiokit: sound for HTML animation.
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

import { createRequire } from 'node:module'

// The extra preset table must be registered before the tool modules load: each
// one snapshots `Object.keys(PRESETS)` when it builds its JSON schema, so a late
// import would leave the enum at the original nine ids. Keep this import ahead
// of every `tools-*` import.
import { registerExtraPresets } from './lib/presets-extra.js'

import { registerCheckTool } from './lib/check.js'
import { registerAnalyzeTools } from './lib/tools-analyze.js'
import { registerAuditTool } from './lib/tools-audit.js'
import { registerBatchTools } from './lib/tools-batch.js'
import { registerBindTools } from './lib/tools-bind.js'
import { registerBusTools } from './lib/tools-bus.js'
import { registerComposeTools } from './lib/tools-compose.js'
import { registerConvertTools } from './lib/tools-convert.js'
import { registerCueTools } from './lib/tools-cues.js'
import { registerDesignTools } from './lib/tools-design.js'
import { registerEditorRoute } from './lib/editor-route.js'
import { registerGraphTools } from './lib/tools-graph.js'
import { registerHandoffTools } from './lib/tools-handoff.js'
import { registerDawTools } from './lib/tools-daw.js'
import { registerLoudnessTools } from './lib/tools-loudness.js'
import { registerMouthTools } from './lib/tools-mouth.js'
import { registerMidiTools } from './lib/tools-midi.js'
import { registerMasterTools } from './lib/tools-master.js'
import { registerLiveTools } from './lib/tools-live.js'
import { registerReactTools } from './lib/tools-react.js'
import { registerSettingsRoute } from './lib/settings-route.js'
import { registerSamplerTools } from './lib/tools-sampler.js'
import { registerSkill } from './lib/skill.js'
import { registerSpatialTools } from './lib/tools-spatial.js'
import { registerStemsTools } from './lib/tools-stems.js'
import { registerStretchTools } from './lib/tools-stretch.js'
import { registerTools } from './lib/tools.js'
import { registerTtsTool, registerVoicesTool } from './lib/tts.js'
import { registerGenerateTools } from './lib/tools-generate.js'
import { registerVisualTools } from './lib/tools-visual.js'
import { registerVideoTools } from './lib/tools-video.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-audiokit'

/*
 * The plugin version comes from `package.json`, which is the only place a
 * release bumps: the settings page and the editor page header receive this
 * string through the host, and `test/version-single-source.mjs` pins it to the
 * manifest, so a second literal must never appear in this file.
 *
 * `createRequire` rather than `import pkg from './package.json' with { type:
 * 'json' }`: import attributes need Node >= 20.10 while `engines.node` allows
 * `>=20`, and JSON modules still print an experimental warning on older 20.x.
 * A `require` of the manifest is a plain synchronous parse every supported
 * Node accepts, and npm always packs `package.json` (even though `files` does
 * not list it), so an installed copy can never be missing it.
 */
const requireFromPlugin = createRequire(import.meta.url)

/** Shown by the settings page and the editor header; equals `package.json.version`. */
export const VERSION = requireFromPlugin('./package.json').version

/** The tool registry is required; the other seams are used when present. */
export const inject = ['tools']

// The standing instruction is **deliberately not registered** as a host system
// prompt section any more: it injected ~1.2 KB into every session (even ones
// that never touch audio) and repeated what the tool descriptions already say.
// The text is kept exported so an opt-in wrapper, the docs-consistency test and
// the hand-written docs can still reuse one source of truth.
export const PROMPT_SECTION = [
  '## Sound for HTML animation',
  '',
  'A page you author is silent by default. When the deliverable is an animation, motion graphic, transition, video or',
  'browser demo with visible movement, give it sound unless the user asked for silence. Pick the tool by what the',
  'sound *is*, not by what it is made of:',
  '',
  '- one hit, texture or foley sound → `audio_synth` (38 presets; deterministic, same seed = same bytes)',
  '- a sound no preset covers → `audio_synth_graph` (write the synthesis graph yourself: osc/noise/filter/env/LFO/FM/drive/reverb)',
  '- many events from one rule (typing, rain, accelerating ticks) → `audio_pattern`',
  '- a designed object ("metal door slam", "magic sparkle") → `audio_design` (38 layered recipes)',
  '- your own recorded wav, pitched and mapped across a keyboard → `audio_sampler` (no bundled assets)',
  '- an external audio generation model (Stable Audio / AudioGen / a self-hosted gateway) → `audio_generate`',
  '  (config-driven, off until an endpoint is set, not deterministic)',
  '- combining rendered files into one cue → `audio_mix` (per-track gain and time offsets)',
  '- music: a cue with harmony and a groove → `audio_compose` (8 genres, returns beat times for sync)',
  '- narration, dialogue or singing → `audio_tts` (singing is a TTS job or an external plugin); `audio_voices` lists voice ids',
  '- character mouth / lip-sync → `audio_lipsync` (per-frame viseme + jaw openness)',
  '- motion that should land on the music → `audio_beats`',
  '- the picture should follow a finished track (impact points, section boundaries) → `audio_cues`',
  '- assembling cues + the page player → `audio_bind` (generates the scheduling code, inline or external)',
  '- the UI making its own sounds (hover, click, success, error) → `audio_react` (16 interactions, 5 palettes,',
  '  drop-in binding script); per-layer deliverables for video/games → `audio_stems` (stems + master)',
  '- the page must react live and ship no audio bytes → `audio_live` (generates a ~16 KB WebAudio module)',
  '- EQ / compression / ducking on a cue set → `audio_bus`; exchange scores with a DAW → `audio_midi`',
  '- a sound that must come from a direction, or a file wider than stereo → `audio_spatial`',
  '- the final deliverable is a video → `audio_mux` (probe, mux, shot-cut times, extract)',
  '- handing the work to a DAW or editor → `audio_daw` (EDL, Reaper project, CSV, labels, OpenTimelineIO, FCP7 xmeml; AAF/OMF are structural exports)',
  '- work that belongs to another audio plugin (instrument libraries, voice banks, sfx licences) → `audio_handoff` (writes the division-of-labour brief; it never calls the peer)',
  '- a mouth track without any voice audio (captions, silent comics) → `audio_mouth`',
  '- what a sound is made of: f0, harmonics, formants, noise, decay → `audio_analyze`',
  '- fixing an existing file: trim/join/fade/re-encode → `audio_convert`; retime or transpose → `audio_stretch`',
  '- before delivery: `audio_probe` (measure), `audio_loudness` (LUFS/true peak), `audio_check` (quality gate),',
  '  `audio_regress` (prove a change did not break a sound), `audio_master` (multiband + true-peak limiting to a target LUFS)',
  '- narration ↔ subtitle ↔ mouth-track sync → `audio_audit` (read-only three-way audit; reports drift, never edits an input)',
  '- one operation over a whole cue set (check / loudness / normalize / master) → `audio_batch` (one table, inputs never overwritten)',
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
  registerGraphTools(ctx)
  registerTtsTool(ctx, config)
  registerGenerateTools(ctx, config)
  registerVoicesTool(ctx, config)
  registerCheckTool(ctx, config)
  registerAnalyzeTools(ctx)
  registerAuditTool(ctx)
  registerBatchTools(ctx)
  registerConvertTools(ctx)
  registerLoudnessTools(ctx)
  registerDesignTools(ctx)
  registerMasterTools(ctx)
  registerVisualTools(ctx)
  registerMouthTools(ctx)
  registerBusTools(ctx)
  registerSpatialTools(ctx)
  registerVideoTools(ctx)
  registerBindTools(ctx)
  registerCueTools(ctx)
  registerReactTools(ctx)
  registerLiveTools(ctx)
  registerComposeTools(ctx)
  registerMidiTools(ctx)
  registerSamplerTools(ctx)
  registerStemsTools(ctx)
  registerDawTools(ctx)
  registerHandoffTools(ctx)
  registerStretchTools(ctx)
  registerSettingsRoute(ctx, config, VERSION)
  // The cue editor is a page, not a tool: a URL the user can open to drag cues
  // on a waveform and export a cue sheet for audio_bind / audio_daw. Registered
  // like the settings endpoints, so a composition without a web carrier simply
  // does not serve it.
  registerEditorRoute(ctx, VERSION)

  // Optional seams: resolved through `ctx.get` so the plugin still activates in
  // a composition that does not mount them. `ctx.skills` would throw without a
  // matching `inject` declaration.
  const skills = ctx.get('skills')
  if (skills !== undefined) registerSkill(skills)

  // NOTE: `ctx.get('systemPrompt')` is intentionally not called. Registering a
  // standing prompt section made every DSH session pay for audio instructions it
  // may never need; activity is now opt-in (see `PROMPT_SECTION` above). The
  // `animation-sound` skill is still available on demand, which is where the
  // workflow contract belongs.
}
