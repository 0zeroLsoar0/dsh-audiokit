/**
 * The `animation-sound` skill: the workflow document the model loads before it
 * scores an animation. Discoverability lives here rather than in the tool
 * descriptions, because the catalog is read before the tools are, and because
 * "how to sequence six renders and then wire them up" is prose, not a schema.
 *
 * The long-form half of the tool documentation lives here too: the synthesis
 * graph DSL, one line per preset and per design recipe, the DAW format fidelity
 * table. A tool description carries what the tool does and when to use it; the
 * detail that only matters once a call is being composed is loaded on demand
 * through the skill, so it is not paid for on every request.
 */

import { PRESETS } from './dsp.js'
import { recipeCatalog } from './design.js'
import { GRAPH_SCHEMA, graphCatalog } from './graph.js'

export const SKILL_NAME = 'animation-sound'

/* ---- generated reference tables ---------------------------------------- */

/** One field of a graph node, in the compact table form the skill uses. */
function fieldText (field) {
  const star = field.required === true ? '*' : ''
  const fallback = field.default === undefined ? '' : ` (${field.default})`
  if (field.type === 'number') return `${field.range[0]}..${field.range[1]}${star}${fallback}`
  if (field.type === 'string') return `${field.values.join('/')}${star}${fallback}`
  if (field.type === 'ref') return `ref${star}`
  if (field.type === 'refs') return `refs${star}`
  if (field.type === 'numbers') return 'dB 数组'
  return 'object'
}

function nodeFieldText (field) {
  if (field.type !== 'object') return fieldText(field)
  const nested = Object.entries(field.fields).map(([key, inner]) => `${key} ${fieldText(inner)}`).join(', ')
  return `{ ${nested} }`
}

/** Tables generated from the kernel tables, so the prose cannot drift from the code. */
function generatedTables () {
  const nodeRows = Object.entries(GRAPH_SCHEMA.nodes)
    .map(([type, schema]) => {
      const fields = Object.entries(schema.fields).map(([name, field]) => `${name} ${nodeFieldText(field)}`).join(', ')
      return `| ${type} | ${schema.description} | ${fields} |`
    })
    .join('\n')
  const catalogRows = graphCatalog().map((entry) => `| ${entry.id} | ${entry.duration} s | ${entry.description} |`).join('\n')
  const presetRows = Object.entries(PRESETS).map(([id, spec]) => `| ${id} | ${spec.defaultDuration} s | ${spec.description} |`).join('\n')
  const recipeRows = recipeCatalog()
    .map((entry) => `| ${entry.id}${entry.loop ? '（循环）' : ''} | ${entry.layers} | ${entry.description} |`)
    .join('\n')
  return { nodeRows, catalogRows, presetRows, recipeRows }
}

/**
 * The skill text. Built on demand rather than at import time: the preset and
 * recipe tables must see `registerExtraPresets()` even if this module is
 * imported before the plugin's `apply()`.
 */
function buildContent () {
  const { nodeRows, catalogRows, presetRows, recipeRows } = generatedTables()
  return `# 给 HTML 动画配音

页面默认是静音的。你产出的动画、动效、演示页，除非用户明确说"不要声音"，都应当配音。
本技能说明：选哪个工具、怎么排拍点、怎么渲染、怎么接进页面、怎么自检。

## 什么时候用

- 会动的画面：loading、开场片头、角色/物体运动、数据可视化动效、交互 demo、转场、短视频。
- 不适用：纯静态页面、纯工具界面、API 文档页。

## 工作流（顺序不要跳）

1. **先定拍子。** 从动画自己的时间轴读出"声音事件"：第几秒、发生了什么、有多重。
2. **查表选工具**（见下一节）。密集段不要写五十行，用一条 \`audio_pattern\`。
3. **渲染。** 每个声音一个文件；复杂声音不要自己叠，用 \`audio_design\` 配方。
4. **自检。** 用工具返回的度量判断，不要凭想象（见"验收"）。
5. **接进页面。** 用 \`audio_bind\` 生成播放器，或按"单文件内联"配方手写。
6. **报告。** 告诉用户每个 cue 用了什么、总时长、响度，方便他改。

## 决策：这个声音该用哪个工具

| 你要的是 | 用这个 | 为什么 |
|---|---|---|
| 一个音效、一层底噪 | \`audio_synth\` | 38 个预设，参数是 0..1 的感知量 |
| 预设里没有的声音，要自己搭 | \`audio_synth_graph\` | 振荡器/噪声/滤波/包络/LFO/FM/折叠/混响的声明式图 |
| 一条规则铺满一段时间 | \`audio_pattern\` | train/scatter/riser，一次调用几百个事件 |
| 一个"东西"（门、玻璃、爆炸、魔法） | \`audio_design\` | 38 个配方，多层共享包络与混响 |
| 手上有真实录音要用 | \`audio_sampler\` | 键位/力度分区、变调、循环、包络（插件不内置素材） |
| 已接了外部音频生成模型 | \`audio_generate\` | prompt → wav 走配置好的 HTTP 端点；不配置不可用，结果不确定 |
| 一段音乐 | \`audio_compose\` | 真和声 + 声部进行 + 鼓，返回节拍表 |
| 旁白/台词 | \`audio_tts\` | MiniMax / OpenAI 兼容 / 免费 Edge |
| 选音色 | \`audio_voices\` | 列出当前供应商可用的音色（不产出音频） |
| 角色口型 | \`audio_lipsync\` | 每帧 viseme + 连续张嘴量 |
| 画面卡在音乐上 | \`audio_beats\` | 从成品音乐里测出 bpm 与节拍网格 |
| 手上只有音频、要反推画面事件 | \`audio_cues\` | 检测冲击点/段落边界，输出 cue 时间表（音频反推 cue 用这个） |
| 把声音接到事件上 | \`audio_bind\` | 生成 cue 表 + 播放器代码 |
| 成片是视频，要把声音合进去 | \`audio_mux\` | probe/mux/cuts/extract，走本机 ffmpeg（不做分镜分析） |
| 界面自己的声音（hover/click/成功/失败） | \`audio_react\` | 16 种交互 + 5 个音色家族，一次生成绑定脚本 |
| 页面要实时反应、而且不想传音频 | \`audio_live\` | 生成 WebAudio 模块，参数连续可变、可带自动化车道，零音频字节 |
| 想知道一个声音"里面是什么" | \`audio_analyze\` | 基频、谐波、共振峰、噪声度、衰减时间 |
| 给视频/游戏交分轨 | \`audio_stems\` | 每层一个 wav + master，且能重建 |
| 要把工程交给 DAW/剪辑软件 | \`audio_daw\` | CMX3600 EDL / Reaper .rpp / CSV / Audacity labels / OTIO / FCP7 xmeml（Resolve、Premiere 可直接导入）/ AAF 子集 / OMF 骨架 |
| 要 EQ / 压缩 / 侧链闪避 | \`audio_bus\` | 每轨处理器链 + 总线限幅 |
| 声音要有方向、要出 5.1/双耳 | \`audio_spatial\` | 立体声/双耳/quad/5.1/7.1/一阶 Ambisonics |
| 和 DAW 交换乐谱 | \`audio_midi\` | 导出 .mid 给 DAW；读入外部 .mid 报告速度/轨道/音符 |
| 没有音频也要口型 | \`audio_mouth\` | 文本/字幕直接出口型轨（与音频口型同一套格式） |
| 把几条声音混成一条 | \`audio_mix\` | 多轨叠加，逐条给增益与时间偏移 |
| 改已有文件 | \`audio_convert\` / \`audio_stretch\` | 裁剪、拼接、淡入、转码 / 变速不变调 |
| 交付前把关 | \`audio_probe\` / \`audio_loudness\` / \`audio_check\` / \`audio_regress\` | 度量、响度、质量闸、回归 |
| 旁白、字幕、口型对不对得上 | \`audio_audit\` | 三方只读对账：字幕漂移/漏句、口型覆盖与一格闪烁；不改输入 |
| 一整组 cue 要同样处理 | \`audio_batch\` | check/loudness/normalize/master 一次跑完，逐条报错不中断，只写副本 |
| 这活属于另一个音频插件 | \`audio_handoff\` | 写出交接合同（目标插件/能力/逐轨请求），不调用对方、不联网 |
| 要跟商业素材一样响、又不削波 | \`audio_master\` | 多段压缩 + 真峰值限制，迭代到目标 LUFS |

## 同步契约（决定成片是"配过声"还是"贴上去的"）

1. **一个时钟。** 用 \`AudioContext.currentTime\` 驱动 \`requestAnimationFrame\`，不要一边 \`performance.now()\`
   一边 \`audio.currentTime\`——两个时间源一定漂移。\`audio_bind\` 生成的播放器已经这么做，并暴露
   \`window.dshAudio.currentTime()\`（启动前 80 ms 预滚是负值，正好给页面留出同步窗口）。
2. **打击音对齐峰值，不是对齐起点。** 画面 0.82 秒破碎，"铛"要落在 0.82 秒；wav 第一个采样是瞬态开始，
   所以 cue 一般提前 30–50 ms。
3. **先解码再启动。** \`decodeAudioData\` await 完再起时钟，否则开头会被吞掉。
4. **预调度。** 用 \`source.start(t0 + at)\` 排在音频时钟上，不要用 \`setTimeout\` 当计时器——
   \`audio_bind\` 的 lookahead 调度就是为这个写的。
5. **浏览器自动播放策略**：没有用户手势就不给声音。成品页要有一个「点击开始」，并在手势里
   \`await ctx.resume()\`。在 DSH 里打开不受此限制。

## 音效：audio_synth / audio_pattern / audio_design

\`audio_synth({ preset, params, duration, seed, loop, sampleRate, out })\`
\`audio_pattern({ preset, kind, from, to, every|count, curve, jitter, accentEvery, pitchFrom, pitchTo, params, seed })\`
\`audio_design({ recipe | layers, seed, variant, intensity, duration, loop })\`

- **参数是感知量，不是物理量。** 0..1 的 \`weight/hardness/metallic/space/tone/speed/rise/decay/density/roughness/movement\` 等，
  每个预设还有自己的专有旋钮；\`pitch\` 是倍频——多数带音高的预设是 0.5..2，\`tick\`/\`chime\`/\`zap\` 是 0..1，
  没有 \`pitch\` 的预设会忽略它。
- **同一个 seed 出同样的字节。** 想要"另一版"改 \`seed\`；\`audio_design\` 的 \`variant\` 是同一设计的不同演奏。
- **循环**用 \`loop: true\`，\`audio_probe\` 的 \`loopSeam\` 要 < 6 dB；已经渲成一次性音效的不要硬循环。

### 38 个预设速查

| 组 | 预设 | 用途 |
|---|---|---|
| 核心 | \`impact\` \`whoosh\` \`tick\` \`chime\` \`riser\` \`zap\` \`thud\` \`scrap\` \`texture\` | 撞击/掠过/点击/铃/上升/放电/闷响/摩擦/环境 |
| 拟音 | \`footstep-gravel\` \`footstep-wood\` \`footstep-water\` \`door-open\` \`door-close\` \`drawer\` \`switch-click\` \`cloth\` \`paper\` | 脚步、门、抽屉、开关、布料、纸 |
| 水气 | \`water-drip\` \`water-splash\` \`bubble\` \`wind-gust\` \`breath-inhale\` | 水滴、溅水、气泡、阵风、吸气 |
| 机械 | \`servo\` \`motor-start\` \`motor-loop\` \`alarm-beep\` \`alarm-siren\` \`hud-tick\` \`energy-charge\` | 伺服、电机、警报、HUD、充能 |
| 生物 | \`heartbeat-double\` \`creature-growl\` \`insect-buzz\` \`bone-crack\` | 心跳、低吼、虫鸣、骨折 |
| 音乐性 | \`bass-drop\` \`riser-short\` \`bell-toll\` \`choir-pad\` | 下潜贝斯、短上升、钟声、合唱垫 |

可循环的：\`texture\`(\`kind: wind|rain|fire|room|hum\`)、\`motor-loop\`、\`alarm-siren\`、\`insect-buzz\`、\`choir-pad\`。

### 38 个设计配方

\`door-slam-metal\` \`door-close-soft\` \`glass-break\` \`wood-crack\` \`explosion-far\` \`explosion-near\`
\`whoosh-into-impact\` \`sci-fi-charge\` \`sci-fi-hum-loop\` \`magic-sparkle\` \`magic-dark\` \`water-drip\`
\`water-splash\` \`footstep-gravel\` \`cloth-rustle\` \`ui-success\` \`ui-error\` \`ui-hover\` \`ui-toggle\`
\`machinery-loop\` \`creature-scream\` \`creature-growl\` \`heartbeat\` \`alarm-loop\` \`coin-pickup\` \`thunder-distant\`
\`bird-chirp\` \`bird-flock\` \`insect-swarm\` \`whale-song\` \`wolf-howl\` \`frog-croak\` \`hoofbeats\` \`wing-flap\`
\`creature-breath\` \`creature-hiss\` \`rodent-squeak\` \`bat-echolocation\`

配方自带分层、包络、混响与长度，用 \`intensity\`（0..1）微调轻重、\`variant\` 换一版演奏；
只有在配方不够用时才自己写 \`layers\`（每层 \`{ preset, params, offsetMs, gainDb, duration, pitchScale, detuneCents, filter }\`）。

## 音乐：audio_compose

\`audio_compose({ genre, bpm, bars, key, mode, seed, intensity, loop, sections, sampleRate, out })\`

- 曲风：\`cinematic\` \`lofi\` \`chiptune\` \`ambient\` \`action\` \`horror\` \`fantasy\` \`ui-menu\`。
- 返回 \`beatMap\`（秒）、\`chords\`（每小节和弦）、\`sections\`（每段起止小节与强度）、每轨统计：**动画的鼓点照这个排**。
- 16 小节是一个完整 cue（intro/build/drop/outro）；循环用 \`loop: true\`（收尾转向 + 尾巴折回，无爆音）。
- 想改情绪：先改 \`genre\` 和 \`mode\`，再改 \`bpm\`、\`intensity\`，最后才动 \`sections\`。
- 一个项目里多个 cue 要用同一个 \`key\`/\`mode\`，否则转场会"跳调"。

## 人声：audio_tts

- \`audio_tts({ text, voice, speed, pitch, subtitle, subtitleType, srt, out })\`：旁白与台词。
  供应商在「设置 → 声音」里选（不是工具参数）：MiniMax 默认，换成 Edge 就是免费免密钥的微软朗读
  （300+ 音色，**只给压缩音频**，本机有 ffmpeg 时自动解码成 wav，没有则写出可直接播放的 .mp3）。
  音色列表用 \`audio_voices\` 查。返回时间戳时可直接喂给 \`audio_lipsync\`；端点不返回时工具会如实说明。
- **演唱不在这里。** 插件不做合成唱腔（共振峰合成的人声不可辨识，已移除）：要唱就用 \`audio_tts\`
  朗读 + 音乐性处理，或交给专门的人声 TTS / AnyAudio 插件；真人歌曲请用有授权的录音素材。
- 时间戳缺失时不要编（MiniMax T2A v2 同步接口实测不返回时间戳）；用 \`audio_beats\`/\`audio_lipsync\` 自己测。

## 画面对齐：audio_lipsync / audio_beats

- \`audio_lipsync({ path|render, fps, format, sensitivity, leadMs, out })\` → 每帧 \`{ t, viseme, openness, energy, voiced }\`。
  \`format\` 可选 \`json\`/\`srt\`/\`css\`/\`ae\`：\`css\` 直接给 CSS keyframes（嘴型分层 + 连续下颌缩放），
  \`leadMs\` 用来补偿显示延迟。口型跟的是**人声**，音乐段落不要用。
- \`audio_beats({ path|render, beatsPerBar, maxGrid, out })\` → \`bpm\`、置信度、节拍/小节网格、重拍推测。
  置信度低（< 0.5）时不要硬用，说明该素材不适合卡点。

## 交付：audio_bind 与单文件内联

- \`audio_bind({ cues, out, inline, maxBytes, duration, basePath })\` 写出 \`<out>.json\` + \`<out>.js\`。
  生成的播放器暴露 \`window.dshAudio = { play, stop, stopAll, pause, resume, setMuted, currentTime }\`，
  自带手势解锁、音频时钟预调度、可见性暂停、循环防重入。**优先用它，不要自己写调度。**
- 单文件交付：\`inline: true\` 把 wav 内嵌成 base64（有体积上限）。先用 \`audio_convert\` 转成
  \`bitDepth: 8\` 或 \`sampleRate: 22050\` 再内联，通常能小一半以上。

## 混音与后期：audio_mix / audio_convert / audio_stretch / audio_loudness

- \`audio_mix({ inputs, offsets, gains, durationSeconds, fadeInSeconds, fadeOutSeconds, limiter, peakDbfs, sampleRate, out })\`：
  多条 wav 叠成一条，逐条给增益与时间偏移，默认限幅并把峰值归一；旁白 + 底噪这种固定组合一次混好，别在页面里叠。
- \`audio_convert\`：\`trim\`/\`gain\`/\`fade\`/\`reverse\`/\`concat\`/\`gain-scan\`/\`convert\`。
  交付前用 \`gain-scan\` 把一组 cue 拉到同一峰值，否则切换时会忽大忽小。
- \`audio_stretch\`：\`factor\` 或 \`targetSeconds\` 变速不变调；\`semitones\` 移调不变时长。
  音画时长对不上时用它，不要用播放速率硬凑。
- \`audio_loudness\`：BS.1770 的 LUFS 与真峰值。网页/短视频目标 −14 LUFS，播客 −16，广播 −23；
  写文件时真峰值默认压到 −1 dBTP。单声道按标准单声道计权（与 ffmpeg 一致），要旧口径给 \`dualMono: true\`；
  1/2/4/6/8 声道都能写校正副本，保持声道布局与 16/24 位深。

## 验收（不要跳过）

1. \`audio_probe\`：峰值 ≤ −1、\`clipping\` = 0、\`dcOffset\` < 0.02、\`onsets\` 与意图一致、循环 \`loopSeam\` < 6。
2. \`audio_loudness\`：整条 cue 的 LUFS 与目标差 ≤ 1；真峰值 ≤ −1。
3. \`audio_check\`：多文件 + \`cues\` 时间轴，能抓"cue 指向静音/缺失文件"和"叠加后破音"；
   给 \`target\`（\`youtube\`/\`tiktok\`/\`podcast\`/\`broadcast\`/\`cinema\` 或 \`loudnessTarget\`）时按平台响度
   （LUFS + 真峰值）判定并报差距，不改文件；\`cues[].expectAt\`/\`targets\` 报每条 cue 的偏差与最大偏差；
   立体声/环绕还会报相位与单声道兼容（反相、折叠损失）。
   有语义模型时用 \`question\` 问一句"这听起来像不像金属门在空房间关上"。
4. \`audio_regress\`：改了一个音之后 \`snapshot\` + \`compare\`，证明没有把别的指标带歪。
5. 最后核对：声音总长 = 画面时长（或明确更短）；第一帧不是静音起步（1–5 ms 淡入除外）。

## 常见坑

- **循环底噪越叠越响**：底噪用 \`loop: true\` 渲染，播放时只起一份；重复叠加同一文件会 +6 dB 每次。
- **一次性音效硬循环**：会"咚"一下，因为头尾电平差太大（\`loopSeam\` 会告诉你）。
- **削波来自叠加**：多个 cue 同时响要留 6–10 dB 余量，用 \`audio_check\` 的 summed peak 看总和。
- **8-bit 只适合短促音效**：长垫音转 8-bit 会有明显底噪。
- **不同 cue 响度不一致**：用 \`gain-scan\` 或 \`audio_loudness\` 统一，而不是逐个手调。
- **改了一个音导致整条 cue 变差**：用 \`audio_regress\` 比对，不要凭感觉。

## 合成图 DSL（audio_synth_graph 的完整语法）

工具描述只说"能搭什么"，完整语法在这里。一次调用传一个 graph 对象：

\`\`\`
{ "nodes": [ { "type": "osc", "hz": 220 }, { "type": "env" } ], "output": "n1" }
\`\`\`

- 源（osc、noise）起一条链；处理器（filter、env、gain、drive、ring、pan、reverb）各取一个 input；sum 取多个 inputs。
- 引用写节点 id（默认 n0、n1…）或 0 基下标；output 缺省是最后一个音频节点。字段可选，标 * 的必填，括号里是默认值。
- 限制：最多 64 个节点、0.008–30 s、8000–96000 Hz、sum 最多 16 路、噪声缓冲 ≤ 96 MB。
- 节点上也可以直接写 \`lfo\`（\`hz\` / \`depth\` / \`target\`），不必单独写 lfo 节点；\`depth\` 是比例：pitch 上 0.02 ≈ 34 音分颤音，filter 上 0.3 让截止频率 ±30 %。
- 渲染是单声道，结尾有 8 ms 保护淡出；seed 只影响用噪声的节点。
- 验证先于渲染：非法图只返回按文档路径命名的前 5 个问题（如 nodes[2].hz），不渲染、不写文件。

| 节点 | 作用 | 字段（* 必填，括号是默认值） |
|---|---|---|
${nodeRows}

示例图（catalog）可以直接渲染，也可以 copy 出来改：

| id | 长度 | 是什么 |
|---|---|---|
${catalogRows}

## 预设逐条与旋钮（audio_synth / audio_pattern / audio_lipsync.render）

快查表按组给了名字，逐条是什么：

| 预设 | 默认秒 | 是什么 |
|---|---|---|
${presetRows}

- **参数是感知量，不是物理量。** \`weight\`/\`hardness\`/\`metallic\`/\`space\`/\`tone\`/\`speed\`/\`rise\`/\`decay\`/\`density\`/\`roughness\`/\`movement\`/\`pitchJitter\` 都是 0..1，每个预设只认自己有的那几个。
- \`pitch\` 在多数带音高的预设上是倍频（0.5..2），在 \`tick\`/\`chime\`/\`zap\` 上是 0..1 的音色旋钮；没有 \`pitch\` 的预设会忽略它。
- \`texture\` 额外认 \`kind\`：wind / rain / fire / room / hum。
- 密集事件用 \`audio_pattern\`，不要手写几十个 \`audio_synth\` 调用；它的 \`pitchFrom\`/\`pitchTo\` 用的是同一个 \`pitch\` 域。

## 配方逐条（audio_design，38 个）

配方自带分层、包络、混响与长度；用 \`intensity\`（0..1）微调轻重、\`variant\` 换一版演奏。
配方不够用时才自己写 \`layers\`：每层 \`{ preset, params, offsetMs, gainDb, duration, pitchScale, detuneCents, filter }\`。

| 配方 | 层数 | 是什么 |
|---|---|---|
${recipeRows}

## 总线处理器（audio_bus）

每轨的固定处理顺序：highpass → lowpass → peaking → shelf → compressor → duck，之后才是总线的 drive / limiter / 峰值归一。

- 每轨给 path 或 render（二选一），加上 \`gainDb\`、\`offsetSeconds\`、\`pan\`、\`width\`、\`highpassHz\`、\`lowpassHz\`，以及四个可选处理器块。
- peaking：\`hz\` / \`q\` / \`gainDb\`；shelf：\`kind\`（low 或 high）/ \`hz\` / \`gainDb\` / \`slope\`；compressor：thresholdDb / ratio / attackMs / releaseMs / makeupDb / kneeDb；duck：amountDb / attackMs / releaseMs。
- \`duckFrom\` 是侧链源：轨道下标（0 基）或 .wav 路径，闪避深度跟随它的电平——旁白压底噪就是这条。
- 声道：输入可以是 mono / stereo / 4 / 6 / 8 声道；输出跟随最宽输入（或 \`channels\`）；降混时丢掉 LFE。\`pan\`/\`width\` 只对单声道源生效。
- \`stems: true\` 时把处理后的每一层单独导出（只支持单声道），写 master.wav 与 stems.json。

## 母带（audio_master）

- 预设：\`streaming-safe\`（-14 LUFS / -1 dBTP，默认）、\`streaming-loud\`（-9 LUFS）、\`broadcast-23\`（EBU R128）、\`podcast\`（-16 LUFS）、\`gentle\`（-16 LUFS / -2 dBTP）。
- \`bands\` 替换预设的多段压缩：每段 splitHz / ratio / thresholdDb / attackMs / releaseMs / makeupDb，最后一段的 splitHz 忽略。
- \`width\` 与 \`bassMonoHz\` 是立体声控制：单声道输入忽略，4/6/8 声道绕过并在报告里说明。
- 目标在限制预算内达不到时报告缺口而不是削波；\`mode: fast\` 免去重渲染，代价是约 350 MB 内存。

## 编辑与转码（audio_convert）

- \`op\` 决定用哪些字段：\`trim\`（\`start\`/\`end\`/\`snapToZeroCrossing\`）、\`gain\`（\`gainDb\`）、\`fade\`（\`fadeInSeconds\`/\`fadeOutSeconds\`/\`curve\`）、\`reverse\`、\`concat\`（\`gapSeconds\` 或 \`crossfadeSeconds\`）、\`gain-scan\`（\`peakDbfs\`，多个输入时 \`out\` 是目录）、\`convert\`（只换格式）。
- 输出默认保持输入的声道布局；显式 \`channels\` 会走布局矩阵（降混丢 LFE）。位深 8/16/24/32-bit float，4/6/8 声道只支持 16/24-bit。
- \`inline: true\` 时另外返回 base64 data URI，超过 \`maxInlineBytes\` 就跳过。

## DAW 交付格式（audio_daw）

| format | 输入 | 保留什么 |
|---|---|---|
| \`edl\` | cue | 只有位置（单轨 cuts，没有增益与淡入淡出） |
| \`rpp\` | cue 或 stem | 位置、长度、增益、淡入淡出（保真最高） |
| \`csv\` | cue | 每个字段，含增益与淡入淡出 |
| \`labels\` | cue | Audacity 标签轨 |
| \`otio\` | cue | 采样精确，每条 lane 一条音轨；增益写在 clip 元数据 |
| \`xmeml\` | cue | 帧精度，Premiere / Resolve 直接导入 |
| \`aaf\` | cue | CFB 容器 + 内嵌 PCM，但没有 MetaDictionary（Pro Tools 仍会拒绝） |
| \`omf\` | cue | 只有骨架，不可导入 |

## 页面内合成与交互音效（audio_live / audio_react / audio_bind）

- \`audio_live\` 的自动化车道：每条车道改一个参数，单位是 pitch 音分、filter Hz、gain dB、pan -1..1、send 0..1。
  曲线：\`linear\`（默认）、\`exp\`（两端为正才是指数）、\`sine\`（半余弦缓动）、\`step\`（保持后跳变）；\`from\` 大于 \`to\` 就是下滑/闪避。
  每条车道还能叠一个 \`lfo\`（\`hz\` / \`depth\`），\`depth\` 用目标单位。生成的是 .js（不含音频字节），\`demo: true\` 另给一个按钮页。
- \`audio_react\` 的 16 个交互 id：\`hover\`、\`press\`、\`release\`、\`toggle-on\`、\`toggle-off\`、\`success\`、\`error\`、\`warning\`、\`typing-key\`、\`scroll-tick\`、\`open\`、\`close\`、\`drop\`、\`count-up\`、\`focus\`、\`notify\`；默认九件套是 \`hover\`、\`press\`、\`release\`、\`toggle-on\`、\`toggle-off\`、\`success\`、\`error\`、\`typing-key\`、\`notify\`。
  音色家族：\`soft\`（暗、圆）、\`crisp\`（亮、紧，默认）、\`organic\`（暖、轻微失谐）、\`digital\`（薄、高通 blip）、\`cinematic\`（低、空间大）。
- \`audio_bind\` 的循环：页面加载时就起播的 loop 会一直循环到时间轴结束；用 dshAudio.play() 现场启动的 loop 没有时间轴终点，只放一句就停，不要指望它无限循环。

## 空间布局（audio_spatial）

- 布局与声道：\`mono\` 1、\`stereo\` 2（L/R ±30°）、\`binaural\` 2（耳机）、\`quad\` 4、\`5.1\` 6、\`7.1\` 8、\`ambisonic-first-order\` 4（FuMa，交给外部空间工具）。
- 方位：\`azimuth\` 0 正前、+90 右、-90 左、±180 后；\`elevation\` 用于 binaural（±90）。
- 距离：1 m 为 0 dB，每翻倍 -6 dB，远场还会丢高频。
- \`room\` 是四条离散早期反射，不是混响：\`wet\` 0 就是干声近场。
- 输出是整数 PCM 多声道 WAV（16 或 24-bit），插件自己的解码器能读。

## 采样器（audio_sampler）

- \`samples\` 三种写法：单个 .wav 路径；同音高的多个 take 数组（round-robin）；zone 对象数组（力度分层 / 多采样）。
  zone 字段：path、rootMidi、lowMidi、highMidi、loopStart、loopEnd、tuneCents、gainDb、velocityLo、velocityHi、name。
- \`notes\` 是对象数组（midi 可为数字或音名，null 是休止，可带 startBeat/durBeats/velocity）；也可以用 \`melody\` 简谱："C4:1 E4:1 G4:2"（音名:拍数，r 是休止）。
- \`envelope\` 是 ADSR（attack/decay/release 秒 + sustain 0..1）；\`loop: true\` 自动找 25%..95% 的持续段并交叉淡化，{ start, end } 指定区间。
- 播放是重采样：音高与速度联动；要不改时长就用 \`audio_stretch\`。

## 视频联动（audio_mux）

- \`probe\` 报告流与时长；\`mux\` 把音频贴上去；\`cuts\` 给出镜头切点 + 可直接用的 audio_bind cue 计划；\`extract\` 把视频音轨导成 wav。
- \`mux\` 的 \`mode\`：\`replace\`（默认，换掉原音轨）、\`mix\`（保留原声并把新声音叠在下面）、\`attach\`（加第二条音轨）。
- 画面永远不重编码（stream copy）；\`loop\` 让短 cue 铺满时间轴；\`durationSeconds\` 默认视频时长，且不会把画面剪短。
- 依赖本机 ffmpeg/ffprobe（DSH 自带一份）；它不做画面内容分析，分镜/转写属于 dsh-video-storyboard 插件。

## 指标与响度（audio_analyze / audio_loudness）

- \`audio_analyze\` 的 \`tolerances\` 用指标名做键（f0.hz、centroidHz、flatness、noisiness、decay.rt60Seconds、onset.attackMs、bands、formants.hz、formants.count、inharmonicity、spectralTiltDbPerOctave）；值是绝对容差，或 { relative } / { absolute }。
- \`f0Range\` 默认 [40, 2000]，窄一点能挡住"亮声音被读高一个八度"；\`maxHarmonics\` 只决定报告列几个分音。
- \`audio_loudness\` 按 BS.1770-4：单声道文件按单声道计权（一个声道计 1.0，与 ffmpeg \`ebur128\` 一致；\`dualMono: true\` 退回旧的双声道口径 +3.01 LU），4/6/8 声道排除 LFE、环绕 +1.5 dB。\`targetLufs\` 用 -14（网页/短视频）、-16（播客）、-23（广播）；写文件时真峰值默认压到 -1 dBTP（\`ceilingDbtp\`）。
- 校正副本：给 \`targetLufs\` + \`out\` 时 mono/stereo/quad/5.1/7.1 都能写，一次统一增益（不改声像），真峰值按写盘后的字节复测并 trim 到 ceiling，保持原声道布局与 16/24 位深；\`out\` 不能是输入文件；回报 \`written.appliedGainDb\` / \`targetHit\` / \`truePeakDbtp\`。
- 含 NaN/±Infinity 的文件不算测量：报 \`nonFiniteSamples\` 与说明，峰值/响度字段为 \`null\`，也不写校正副本。

## 质量闸细节（audio_check）

- \`target\` 是平台交付规格：\`youtube\` / \`tiktok\` / \`podcast\` / \`broadcast\` / \`cinema\`（后两个的 ceiling 更严）。只判定 LUFS 与真峰值并报告差距，不改音频。
- \`loudnessTarget\` 是自定义规格：\`{ targetLufs, ceilingDbtp, toleranceLu, label }\`；与 \`target\` 二选一。
- \`cues[].expectAt\` 或 \`targets\` 判定 cue 偏差：\`toleranceSeconds\` 默认 0.05 s（20 fps 一帧），超过 4 倍且 ≥ 0.2 s 记 error。
- 立体声/环绕文件额外给相位与单声道兼容报告（反相、折叠损失）。
- \`question\` 需要「设置 → 语义检查」打开并配好模型；没配就只跑本地自检。

## 旁白与音色（audio_tts / audio_voices）

- 供应商在「设置 → 声音」里选：MiniMax（默认，时间戳最可依赖）、OpenAI 兼容端点、Edge（免费免密钥，300+ 音色，只给压缩音频，本机有 ffmpeg 时自动转 wav）。
- MiniMax 常用音色：female-shaonv、male-qn-qingse、male-qn-jingying、female-yujie、male-qn-badao、female-chengshu、presenter_male、presenter_female、audiobook_male_1、audiobook_female_1，以及中文/英文的 Warm_Bestie、Gentleman、English_expressive_narrator 等。
- Edge 用 \`audio_voices\` 查真实 id（如 zh-CN-XiaoxiaoNeural、en-US-AriaNeural）。
- 文本里可用 "<#1.5#>" 插 1.5 s 停顿（MiniMax）；超过 8000 字符会在句末切开拼接。
`
}

/**
 * Register the skill provider.
 * @param {object} skills - the resolved `skills` service (pass `ctx.get('skills')`;
 *   `ctx.skills` throws unless `skills` is a declared injection).
 */
export function registerSkill (skills) {
  const summary = {
    name: SKILL_NAME,
    description: '给 HTML 动画配音：选型、拍点、音效/作曲/旁白、口型与节拍对齐、交付与验收。Whenever you build an HTML animation, motion graphic, or browser demo that should make sound, load this first.',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-audiokit',
    source: 'bundled',
    rank: 600,
    locator: 'dsh-audiokit/animation-sound'
  }
  skills.registerProvider(() => ({
    name: 'dsh-audiokit',
    list: async () => [summary],
    async get () {
      return { ...summary, content: buildContent() }
    }
  }))
}
