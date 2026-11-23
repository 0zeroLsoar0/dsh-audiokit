# dsh-audiokit

dsh-audiokit 是一个为 HTML 动画设计的声音处理插件，提供可供 Agent 调用的工具集，涵盖音频合成、作曲、人声、混音、母带及验收环节。

当前版本为 0.5.10。该项目处于开发阶段，接口可能发生变动。

## 安装

可以通过以下两种方式安装：

1. `plugin_manager action: install_bundle target: <仓库>/dsh-audio`
2. `dsh plugin add "file:<仓库>/dsh-audio"`

安装完成后，在“设置-声音”中配置旁白供应商。若不配置，仍可使用大部分功能。

## 工具分组

本插件提供 30 个工具，分类如下：

*   **造声 (9)**：包含 38 个预设的 `audio_synth`、自定义图谱 `audio_synth_graph`、规则铺设 `audio_pattern`、26 种分层配方 `audio_design`、8 种风格和声 `audio_compose`、MIDI 读写 `audio_midi`、采样器 `audio_sampler`、实时合成 `audio_live`、16 种交互音效 `audio_react`。
*   **人声 (5)**：提供 `audio_tts`（支持 MiniMax、OpenAI 接口、Edge）、`audio_voices`、逐帧口型 `audio_lipsync`、无音频口型 `audio_mouth`、风格化唱腔 `audio_sing`。
*   **对画面 (4)**：包括 BPM 与节拍网格测量 `audio_beats`、生成 Cue 表与播放器 `audio_bind`、视频混流及切点处理 `audio_mux`、导出 EDL/Reaper/CSV/labels 的 `audio_daw`。
*   **混音母带交付 (8)**：包括多轨合一 `audio_mix`、含压缩与侧链的总线 `audio_bus`、多段压缩与限制 `audio_master`、分轨处理 `audio_stems`、音频转换 `audio_convert`、变速变调 `audio_stretch`、多声道处理 `audio_spatial`、响度度量 `audio_loudness`。
*   **验收 (4)**：度量工具 `audio_probe`、交付质检 `audio_check`、频谱分析 `audio_analyze`、快照回归 `audio_regress`。

## 快速开始

以下为调用示例：

```js
// 1. 合成冲击音效（params 是 0..1 的感知量）
audio_synth({ preset: 'impact', params: { weight: 0.9, hardness: 0.6 }, duration: 0.6, seed: 123 })

// 2. 生成 8 小节 Lo-Fi 配乐（返回值含节拍表，可给画面卡点用）
audio_compose({ genre: 'lofi', bars: 8, bpm: 80, key: 'A', mode: 'dorian' })

// 3. 旁白（不配密钥时走免费 Edge）
audio_tts({ text: '开始动画。', voice: 'zh-CN-XiaoxiaoNeural', srt: true })

// 4. 绑定到页面（cue 表 + 播放器脚本）
audio_bind({ cues: [{ name: 'slam', at: 0.82, path: 'assets/audio/slam.wav' }], out: 'assets/cues' })

// 5. 交付前质检
audio_check({ paths: ['out/mix.wav'], cues: [{ at: 0.82, src: 'assets/audio/slam.wav' }] })
```

## 特性与保证

*   **确定性**：同一请求产出相同的字节，文件名基于内容哈希。
*   **无外部依赖**：仅使用 Node.js 内置模块。
*   **离线使用**：除 TTS 服务与语义检查外，工具均可离线运行。
*   **测试覆盖**：提供 45 个测试文件，可通过单条命令运行全量测试。

## 限制说明

*   唱腔功能仅提供合成音色，非真人录音。
*   MiniMax 同步接口无法返回时间戳。
*   多声道处理仅支持 16 位与 24 位位深。
*   演示动画与截图未包含在仓库中。
*   当前为开发版本，接口可能存在不稳定情况。

## 许可

MIT © 2026 Soar_L
