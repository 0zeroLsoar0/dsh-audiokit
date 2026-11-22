# dsh-audiokit

> ⚠️ **还没做好，可能会炸。** 这是开发中的版本（`0.5.10`），接口、工具名、文件格式都可能变；装之前先备份好你的 profile。

给 **HTML 动画加声音**的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：把合成器、分层设计、作曲、旁白、口型、混音、母带、验收，变成 agent 能直接调的工具。

- **30 个工具**、**零运行时依赖**、**不配任何密钥也能做绝大部分工作**
- **确定性**：同一个请求永远产出同样的字节；文件名由内容哈希决定，可缓存、可回归比对
- **可测量**：每次渲染回报峰值 / RMS / 波峰因数 / 谱质心 / 起音数 / 循环接缝，响度与真峰值另有专门工具
- 浏览器里的动画默认是静音的；这个插件让 agent 在做画面的同时，把声音一起做出来

## 为什么不是又一个音效库

音效库给你一堆 wav：挑一个、听着猜、手动对齐。这个插件给 agent 的是**可计算的接口**——每个声音都是现场参数化合成出来的，所以在拿到 wav 之前就已经知道它由什么构成。同一个 seed 产出同样的字节、文件名由内容哈希决定，两次请求同名同内容，可以缓存，也可以当作回归基线。每次渲染还会回报峰值、RMS、波峰因数、谱质心、起音数和循环接缝，响度与真峰值有专门工具测——"这一下对不对"不再只能靠耳朵赌。覆盖不到的声音也不用回头找素材：38 个合成预设、26 个分层配方之外，还有一张合成图可以现场搭。

## 安装

在 DSH 会话里（推荐）：

```
plugin_manager  action: install_bundle  target: <本仓库路径>/dsh-audio
```

或者命令行：

```powershell
dsh plugin --profile <profile> add "file:<本仓库路径>/dsh-audio"
# 再把 "dsh-audiokit" 加进 profile package.json 的 dsh.profile.bundles
```

装好后打开 **设置 → 声音 / Sound** 配置旁白供应商（不配也能用）。npm 包名是 `dsh-audiokit`，完整文档见 [dsh-audio/README.md](dsh-audio/README.md)，发布流程见 [docs/RELEASE.md](dsh-audio/docs/RELEASE.md)。

## 30 个工具

**造声音（9）**

| 工具 | 作用 |
|---|---|
| `audio_synth` | 38 个合成预设，参数是 0..1 的感知量，可循环 |
| `audio_synth_graph` | 运行时合成图：用 osc / noise / filter / env / LFO / FM / 折叠 / 混响自己搭音色 |
| `audio_pattern` | 用一条规则铺满一段时间（train / scatter / riser） |
| `audio_design` | 26 个分层设计配方（金属门砸、玻璃碎、远近爆炸、魔法、UI、机械、生物…） |
| `audio_compose` | 8 种曲风、真和声与声部进行，返回节拍表 |
| `audio_midi` | 标准 MIDI 读写：乐谱导出给 DAW，外部旋律导回来唱 / 渲 |
| `audio_sampler` | 用你自己的 wav 做键位 / 力度分区、变调、循环、包络（不内置素材） |
| `audio_live` | 页面内实时合成：生成约 16 KB 的 WebAudio 模块，可带自动化车道，零音频字节 |
| `audio_react` | 交互音效：16 种界面事件 + 5 个音色家族，产出零胶水绑定脚本 |

**人声（5）**

| 工具 | 作用 |
|---|---|
| `audio_tts` | 旁白：MiniMax / 任意 OpenAI 兼容端点 / **免费免密钥的 Edge**（318 个音色、词级时间戳） |
| `audio_voices` | 音色列表 |
| `audio_lipsync` | 从音频出每帧口型（json / srt / css / ae） |
| `audio_mouth` | 没有音频也能出口型：文本 / 字幕直接驱动嘴形 |
| `audio_sing` | 风格化唱腔（提示音 / 机器人声），**不用于真人歌曲、翻唱或模仿歌手** |

**对画面（4）**

| 工具 | 作用 |
|---|---|
| `audio_beats` | 从成品音乐测 bpm、起音、节拍网格、重拍 |
| `audio_bind` | 生成 cue 表 + 页面播放器（音频时钟预调度，可内联成单文件） |
| `audio_mux` | 视频探测 / 混流（replace · mix · attach）/ 镜头切点 / 抽音轨（走本机 ffmpeg） |
| `audio_daw` | 工程导出：CMX3600 EDL / Reaper `.rpp` / CSV cue 表 / Audacity labels |

**混音、母带、交付（8）**

| 工具 | 作用 |
|---|---|
| `audio_mix` | 多轨合一，逐条增益与时间偏移 |
| `audio_bus` | 混音总线：高通 / 低通 / 搁架 / 钟形、压缩、侧链闪避、声像与宽度（支持 4 / 6 / 8 声道） |
| `audio_master` | 母带链：多段压缩 + 宽度与低频单声道 + 真峰值限制，迭代到目标 LUFS |
| `audio_stems` | 分轨导出：每层一个 wav + master，且能重建 |
| `audio_convert` | 8 / 16 / 24 / 32 位、单双声道 / 多声道、高保真重采样、裁剪拼接淡入、批量归一 |
| `audio_stretch` | 变速不变调、移调不变时长 |
| `audio_spatial` | 立体声 / 双耳 / quad / 5.1 / 7.1 / 一阶 Ambisonics |
| `audio_loudness` | BS.1770 LUFS、真峰值、响度范围，按目标响度写校正副本 |

**验收（4）**

| 工具 | 作用 |
|---|---|
| `audio_probe` | 单文件度量：时长、峰值、RMS、波峰因数、质心、起音、循环接缝、削波、直流 |
| `audio_check` | 交付前质量闸：削波、近静音、迟到的攻击、cue 时间轴、叠加峰值 |
| `audio_analyze` | 频谱分析：基频、谐波、共振峰、噪声度、衰减时间，可做容差比对 |
| `audio_regress` | 快照 + 容差比对，证明改动没把别的指标带歪 |

## 快速开始

```js
// 一个撞击
audio_synth({ preset: 'impact', params: { weight: 0.9, hardness: 0.7 }, duration: 0.6 })

// 预设里没有的声音，自己搭
audio_synth_graph({ graph: { nodes: [
  { type: 'osc', wave: 'saw', hz: 220 },
  { type: 'filter', mode: 'lp', hz: 800, q: 2, sweepTo: 300, sweepTime: 0.4, input: 0 },
  { type: 'env', attack: 0.002, decay: 0.35, sustain: 0 },
  { type: 'reverb', amount: 0.25, size: 0.4, input: 2 }
] } })

// 16 小节 lofi 配乐（返回节拍表给画面卡点）
audio_compose({ genre: 'lofi', bars: 16, key: 'F', mode: 'dorian' })

// 旁白（免费供应商）+ 字幕
audio_tts({ text: '第一句。第二句。', srt: true })

// 接进页面
audio_bind({ cues: [{ name: 'slam', at: 0.82, path: 'assets/audio/door-slam-metal.wav' }], out: 'assets/cues' })

// 交付前把关
audio_check({ paths: ['assets/audio/slam.wav'], cues: [{ at: 0.82, src: 'assets/audio/slam.wav' }] })
audio_master({ path: 'assets/audio/mix.wav', preset: 'streaming-safe' })
```

## 特性

- **零依赖**：只用 Node 内置模块；装进 profile 不需要任何 npm 安装
- **确定性**：同 seed 同字节；`audio_regress` 能精确指出改动坏了哪个指标
- **不联网也能用**：合成、设计、作曲、混音、母带、验收全部离线；只有旁白与语义检查需要供应商
- **有文档、有测试**：`animation-sound` 技能 + 45 个测试文件（一条命令跑全量）

## 开发

```powershell
node dsh-audio/tools/test-all.mjs        # 全量测试
node dsh-audio/tools/preset-report.mjs   # 预设清单
```

CI 在 [dsh-audio/.github/workflows/test.yml](dsh-audio/.github/workflows/test.yml)（node 20 / 22 矩阵）。

## 已知限制

- 唱腔是共振峰合成的**合成音色**，不是真人；要人声用 TTS。
- MiniMax 同步接口实测不返回时间戳；需要精确时间戳用免费的 Edge 或自行分析。
- 演示动画、截图等大体积产物不进仓库，需要用 `demo/` 下的脚本现场生成。
- 多声道输出只支持 16 / 24 位；8 / 32 位仅限单双声道。
- 目前是开发版，**还没做好，可能会炸**。

## 许可

MIT © 2026 Soar_L
