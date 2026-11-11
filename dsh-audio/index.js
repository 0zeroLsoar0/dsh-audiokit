/**
 * dsh-audio: sound for HTML animation.
 *
 * The plugin owns exactly one seam: audio in, audio out. It renders files and
 * reports measurements; how the page consumes them is the animation author's
 * business. That is why there is no HTML writer, no bundler and no runtime in
 * this package — only tools, a workflow skill, a settings page and a short
 * standing instruction that makes the capability discoverable.
 *
 * `Config` is the settings schema: the settings page writes through the config
 * editor into the user's profile layer, and the same values reach `apply`
 * resolved (defaults filled in).
 */

import z from '@deepseek-ai/schemastery'
import { registerCheckTool } from './lib/check.js'
import { registerSettingsRoute } from './lib/settings-route.js'
import { registerSkill } from './lib/skill.js'
import { registerTools } from './lib/tools.js'
import { registerTtsTool, registerVoicesTool } from './lib/tts.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-audio'

/** Shown by the settings page; keep in sync with package.json. */
const VERSION = '0.5.2'

/** The tool registry is required; the other seams are used when present. */
export const inject = ['tools']

/** Settings schema projected into the page's form and used to validate writes. */
export const Config = z.object({
  tts: z.object({
    provider: z.string().default('minimax')
      .description('minimax / openai / custom（任何兼容 /v1/audio/speech 的端点）/ none（关闭）'),
    baseUrl: z.string().default('https://api.minimax.chat')
      .description('MiniMax 国内站；海外站换成 https://api.minimaxi.com'),
    model: z.string().default('speech-2.8-hd')
      .description('要手动控制情感时改用 speech-2.6-hd'),
    voice: z.string().default('female-shaonv')
      .description('音色 id；设置页会列出账号可用的实时音色'),
    emotion: z.string().default('auto')
      .description('auto 由模型按文本自选；也可填 happy / sad / angry / fearful / surprised / calm / fluent / whisper'),
    speed: z.number().min(0.5).max(2).default(1).description('语速 0.5–2.0'),
    pitch: z.number().min(-12).max(12).default(0).description('音调偏移，单位半音，−12–12'),
    sampleRate: z.number().min(8000).max(48000).default(32000).description('输出采样率，MiniMax 默认 32000'),
    groupId: z.string().default('').description('旧版 T2A 需要；新接口留空'),
    apiKey: z.string().default('').description('直接填密钥。留空则读下面的环境变量'),
    apiKeyEnv: z.string().default('MINIMAX_API_KEY').description('留空时默认检测 MINIMAX_API_KEY')
  }),
  check: z.object({
    provider: z.string().default('openai').description('音频理解走 OpenAI 兼容端点（MiniMax 没有对应能力）'),
    baseUrl: z.string().default('https://dashscope.aliyuncs.com/compatible-mode').description('Qwen-Omni 等支持 input_audio 的端点'),
    model: z.string().default('qwen3-omni-flash'),
    apiKey: z.string().default('').description('直接填密钥。留空则读下面的环境变量'),
    apiKeyEnv: z.string().default('DASHSCOPE_API_KEY').description('留空时默认检测 DASHSCOPE_API_KEY')
  })
})

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
  registerTools(ctx)
  registerTtsTool(ctx, config)
  registerVoicesTool(ctx, config)
  registerCheckTool(ctx, config)
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
