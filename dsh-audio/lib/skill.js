/**
 * The `animation-sound` skill: the workflow document the model loads before it
 * scores an animation. Discoverability lives here rather than in the tool
 * descriptions, because the catalog is read before the tools are, and because
 * "how to sequence six renders and then wire them up" is prose, not a schema.
 */

export const SKILL_NAME = 'animation-sound'

const CONTENT = `# 给 HTML 动画配音

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
  写文件时真峰值默认压到 −1 dBTP。

## 验收（不要跳过）

1. \`audio_probe\`：峰值 ≤ −1、\`clipping\` = 0、\`dcOffset\` < 0.02、\`onsets\` 与意图一致、循环 \`loopSeam\` < 6。
2. \`audio_loudness\`：整条 cue 的 LUFS 与目标差 ≤ 1；真峰值 ≤ −1。
3. \`audio_check\`：多文件 + \`cues\` 时间轴，能抓"cue 指向静音/缺失文件"和"叠加后破音"；
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
`

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
      return { ...summary, content: CONTENT }
    }
  }))
}
