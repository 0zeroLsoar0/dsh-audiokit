# dsh-audio — 给 HTML 动画配音（v0.1.0 · 重建版）

> **这是重建版，不是原件。** 原始 0.1.0 的 U 盘快照被误删且不可恢复，
> 本目录按开发过程中的源码重建，用于留存 0.1.0 的功能形态。详见上级目录的 `README.md`。

一个 DSH bundle：把「合成器」做成 agent 能调用的工具，用来给 HTML 动画、动效、浏览器 demo 配声音。

**边界只有一条：音频进，音频出。** 插件渲染 wav、报告度量；音频怎么进页面是动画作者的事。
所以这个包里没有 HTML 写入器、没有打包器、没有客户端运行时——只有工具、一个工作流 skill、一段常驻提示词。

## 工具

| 工具 | 作用 |
|---|---|
| `audio_synth` | 渲染单个音效（9 个预设，感知参数，可循环） |
| `audio_pattern` | 用一条规则填满一段时间（train / scatter / riser） |
| `audio_mix` | 多条合一，带 offsets（这才是把一堆音效拼成一条 cue 轨的方式） |
| `audio_probe` | 度量：时长/峰值/RMS/波峰因数/削波/谱质心/起始数/循环接缝 |

预设：`impact` `whoosh` `tick` `chime` `riser` `zap` `thud` `scrap` `texture`。

参数是 0..1 的感知量（`weight` `hardness` `metallic` `space` `tone` `density` `roughness` `movement`），
`pitch` 在 impact/whoosh 上是 0.5..2 的倍频。「一直在叮叮叮」不是几十个素材，是
`audio_pattern {every: 0.08, curve: "accelerando"}` 一条规则。

## 为什么这样切

- **在宿主侧算，不在浏览器里算。** 同一份代码只跑一处，评估用的字节和成片里响的字节完全一致。
- **文件名 = 内容 hash。** 相同请求收敛到同一个路径、同一串字节，多开子代理并发渲染也不会互相踩。
  写入永远是「临时文件 + rename」，不会留下半截 wav。
- **工具只返回路径和数字。** 音频字节永远不进上下文——agent 靠 `peak` `centroid` `onsets` `loopSeam`
  这些数字做判断，比读波形靠谱得多。
- **确定性。** 同 preset + params + seed + duration → 同一串字节。所以能缓存、能 diff、能复现。

## 让 agent 真的会调用

三层，缺一不可：

1. **skill `animation-sound`**（注册进技能目录）——描述里带「HTML 动画 / 动效」关键词，
   模型做动画时会先加载它；正文是完整工作流：拍点、预设速查、同步契约、单文件内联配方。
2. **常驻提示词段**（`dsh-audio:animation-sound`，order 2950）——每轮都在，一句话把「默认要有声音」定成规则。
3. **工具描述自带上下文**——描述里直接写「给动画用」。

## 安装与验证

```powershell
plugin_manager  action: install_bundle   target: <路径>\dsh-audio
```

自测（纯 Node，不需要 DSH）：

```powershell
node dsh-audio\test\smoke.mjs
node dsh-audio\test\verify-html.mjs demo\bounce.html
```

## 目录

```
dsh-audio/
  index.js            apply + 常驻提示词段
  lib/dsp.js          合成内核（TptSvf、噪声、包络、混响、9 个预设）
  lib/audio.js        渲染编排、度量（FFT 谱质心）、mix、原子写盘
  lib/wav.js          RIFF 编解码（16bit PCM 写，8/16/24/32 + float 读）
  lib/tools.js        4 个工具
  lib/skill.js        工作流 skill
  test/               smoke.mjs / verify-html.mjs
```

## 已知坑：浏览器里打开没声音

DSH / Electron 默认放宽了自动播放策略，同一份页面在 DSH 里一打开就响；
用 Edge / Chrome 双击打开时，没有用户交互的页面会被浏览器按住（`AudioContext` 停在 suspended）。

所以成品页带一个「点击开始」：点一下才真正解锁。另外内联音频用 `atob` 解码而不是
`fetch(data:)`，避免 `file://` 下被拦。

## 已知限制

- 只有单声道输出（`channels` 未开放）；立体声要改 `toWavBytes` 和 `mixTracks`。
- 只出 wav（16bit）；mp3/opus 需要引入编码器，属可替换环节。
- 没有 TTS，没有多模态听觉评估——它们都是可后挂的可选层，不影响主线。
- `audio_mix` 的对齐是整轨偏移，没有总线/duck/自动化。
- 循环是无缝拼接（overlap-add），适合底噪类；把衰减型 one-shot 强行 `loop:true` 会被
  `loopSeam` 判出来（实测 29.7 dB），这是设计好的信号，不是 bug。
