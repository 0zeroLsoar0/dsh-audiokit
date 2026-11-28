# dsh-audiokit

> **还没做好，可能会炸。** 项目处于开发阶段（当前 0.6.1），接口、工具名和文件格式都可能变；安装前请备份好 profile。

dsh-audiokit 是 DeepSeek Harness（DSH）的音频处理插件，给 HTML 动画、动效和视频做声音：把合成、设计、作曲、旁白、混音、母带和验收变成 Agent 可以直接调用的工具。

## 安装

```bash
plugin_manager action: install_bundle target: <仓库>/dsh-audio
# 或
dsh plugin add "file:<仓库>/dsh-audio"
```

装好后在「DSH → 插件 → 声音」里配置旁白供应商；不配也能用大部分功能。

## 工具列表

34 个工具，按用途分组。每个工具渲染完都会回报测量值（峰值、RMS、质心、起音、循环接缝等），不用回头再测。

### 造声（10）

- `audio_synth`：38 个合成预设，参数是 0..1 的感知量，支持循环
- `audio_synth_graph`：运行时合成图（振荡器 / 噪声 / 滤波 / 包络 / LFO / FM / 折叠 / 混响）
- `audio_pattern`：按一条规则铺满一段时间（train / scatter / riser）
- `audio_design`：38 个分层配方（门、玻璃、爆炸、机械、UI、水、脚步、生物等）
- `audio_compose`：8 种曲风，真和声与声部进行，返回节拍表
- `audio_midi`：MIDI 读写（导出乐谱给 DAW；读入 .mid 做分析）
- `audio_sampler`：用你自己的 wav 做键位/力度分区、变调、循环、包络（不内置素材）
- `audio_generate`：调用配置好的外部 HTTP 音频生成模型（prompt → wav；不配置不可用）
- `audio_live`：页面内实时合成，生成约 16 KB 的 WebAudio 模块，零音频字节
- `audio_react`：16 种界面事件的交互音，5 个音色家族，产出绑定脚本

### 人声（4）

- `audio_tts`：旁白合成（MiniMax / 任意 OpenAI 兼容端点 / 免费免密钥的 Edge）
- `audio_voices`：音色列表
- `audio_lipsync`：从音频生成逐帧口型（json / srt / css / ae）
- `audio_mouth`：没有音频也能出口型（文本/字幕直接驱动嘴形）

### 对画面（6）

- `audio_beats`：从成品音乐测 bpm、起音、节拍网格和重拍
- `audio_cues`：反向：从现成音频里检出冲击点与段落边界，输出动画 cue 时间表
- `audio_bind`：生成 cue 表与页面播放器，可内联成单文件
- `audio_mux`：视频探测、混流、镜头切点、抽音轨（依赖本机 ffmpeg）
- `audio_daw`：工程导出（EDL / Reaper `.rpp` / CSV / Audacity labels / OpenTimelineIO / FCP7 XML）
- `audio_handoff`：把属于别的音频插件的活写成交接简报（目标插件 / 能力 / 逐轨请求；不调用对方、不联网）

### 混音、母带、交付（9）

- `audio_mix`：多轨合一，保留立体声（多声道按布局折叠）
- `audio_bus`：混音总线（EQ / 压缩 / 侧链闪避 / 声像 / 宽度，支持 4/6/8 声道）
- `audio_master`：母带链（多段压缩 + 真峰值限制，迭代到目标 LUFS；含省内存/快速模式）
- `audio_stems`：分轨导出，每层一个 wav + master，可重建
- `audio_convert`：格式转换、裁剪拼接、批量归一
- `audio_stretch`：变速不变调、移调不变时长
- `audio_spatial`：立体声 / 双耳 / quad / 5.1 / 7.1 / 一阶 Ambisonics
- `audio_loudness`：BS.1770 LUFS、真峰值、响度范围
- `audio_batch`：一组 wav 一次跑完 check / loudness / normalize / master，逐条报错不中断，只写副本

### 验收（5）

- `audio_probe`：单文件度量（时长、峰值、RMS、波峰因数、谱质心、起音、循环接缝、削波、直流）
- `audio_check`：交付前质量闸（削波 / 静音 / 时间轴 / 叠加峰值）+ 本地声学自检
- `audio_audit`：旁白 ↔ 字幕 ↔ 口型轨三方只读对账（字幕漂移 / 漏句、口型覆盖与单帧抖动），不改输入
- `audio_analyze`：频谱分析（基频、谐波、共振峰、噪声度、衰减时间）
- `audio_regress`：快照与容差比对，证明改动没有带歪别的指标

## 时间线编辑器

浏览器打开 `/dsh-audio/editor`：看波形、拖 cue、改增益/淡入淡出、按 BPM 吸附、试听，导出 cue 表给 `audio_bind` / `audio_daw` 用。只读工作区内的 `.json` / `.wav`。

## 快速开始

```js
// 一个撞击（params 是 0..1 的感知量）
audio_synth({ preset: 'impact', params: { weight: 0.9, hardness: 0.6 }, duration: 0.6, seed: 123 })

// 8 小节 Lo-Fi 配乐（返回值含节拍表）
audio_compose({ genre: 'lofi', bars: 8, bpm: 80, key: 'A', mode: 'dorian' })

// 旁白（不配密钥时走免费 Edge）
audio_tts({ text: '开始动画。', voice: 'zh-CN-XiaoxiaoNeural', srt: true })

// 接进页面
audio_bind({ cues: [{ name: 'slam', at: 0.82, path: 'assets/audio/slam.wav' }], out: 'assets/cues' })

// 交付前质检
audio_check({ paths: ['out/mix.wav'], cues: [{ at: 0.82, src: 'assets/audio/slam.wav' }] })
```

## 技术特性

- **零运行时依赖**：只用 Node 内置模块，装进 profile 不需要 npm 安装。
- **确定性**：同一请求 + 同一 seed 产出相同的字节；文件名由内容哈希决定，可缓存、可回归比对。
- **可测量**：峰值、RMS、波峰因数、谱质心、起音数、循环接缝、LUFS 与真峰值都有对应工具。
- **离线可用**：合成、设计、作曲、混音、母带、验收全部离线；只有 TTS、语义检查和外部生成需要网络。
- **测试**：63 个测试文件，`node dsh-audio/tools/test-all.mjs` 一条命令跑全量（一个文件一个子进程，全绿才算过）。

## 限制与说明

- 不提供人声演唱合成；需要真人声请用 TTS 或外部工具。
- 不内置音效或乐器素材，采样器需要你自己的 wav。
- AAF 和 OMF 只做结构导出，Pro Tools 打不开；要进剪辑软件用 OTIO 或 FCP7 XML。
- 多声道输出仅支持 16/24 位；8/32 位仅限单/双声道。
- `audio_generate` 不配置 HTTP 端点就不可用，且结果不保证确定性。
- `audio_batch` 的 `normalize` / `master` 产出的是副本（写进 `outDir`，默认 `out/batch`），不会改写或删除原文件；输出路径若与任一输入相同会被拒绝而不是覆盖。
- 开发版，接口和数据格式可能变；装前备份 profile。

## 许可

MIT © 2026 Soar_L
