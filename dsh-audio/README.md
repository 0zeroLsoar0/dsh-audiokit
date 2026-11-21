# dsh-audio

给 HTML 动画配音的 DSH 插件。让你的 agent 在做动画时，顺手把声音也做出来。

> 合成音效、分层设计、作曲、旁白与唱声、口型与节拍对齐、混音、响度、交付检查——一整套都在 agent 的工具箱里，且不依赖任何素材库。

## 为什么需要它

浏览器里做出来的动画默认是静音的，而"配声音"对 agent 来说一直是个黑盒：它能写出一段漂亮的动效，
却听不见自己做了什么，也没法判断"这一下撞击配这个画面像不像"。

这个插件把音频变成**可测量、可迭代**的东西：每次渲染都返回峰值、RMS、波峰因数、谱质心、起音数、循环接缝，
还有 BS.1770 响度与真峰值。于是 agent 能像调 CSS 一样调声音——改参数、看数字、再听（或者让你听）。
同一个请求永远产出同样的字节，所以渲染可以缓存、可以回归比对。

## 能做什么

| 能力 | 说明 |
|---|---|
| **音效** | 38 个合成预设：撞击、掠过、点击、铃、上升、放电、闷响、摩擦、环境底噪，加上脚步、门、抽屉、开关、布料、纸、水滴、溅水、气泡、阵风、伺服、电机、警报、HUD、充能、心跳、低吼、虫鸣、骨折、下潜贝斯、钟声、合唱垫 |
| **分层设计** | 26 个配方（金属门砸、玻璃碎、远近爆炸、魔法、UI 一套、机械循环、生物、金币、远雷……）一次调用出成品，不再是"叠四个音" |
| **作曲** | 8 种曲风（cinematic / lofi / chiptune / ambient / action / horror / fantasy / ui-menu），真和声、声部进行、鼓组、段落强度曲线，返回节拍表给小节对齐 |
| **旁白 / 唱声** | 旁白支持 MiniMax、任意 OpenAI 兼容端点，以及**免费免密钥的微软 Edge 朗读**（300+ 音色，带词级时间戳）；唱声是零素材的共振峰合成，拼音歌词直接唱 |
| **对画面** | 口型轨（每帧 viseme + 连续张嘴量，可导出 json/srt/css/ae）+ 节拍检测（从成品音乐里测 bpm 与网格） |
| **交付** | 生成可直接贴进页面的播放器（音频时钟预调度、手势解锁、可见性暂停、单文件内联）；导出 8/16/24/32 位、单双声道、高保真重采样 |
| **后期** | 裁剪、拼接、淡入淡出、反转、批量归一、变速不变调、移调不变时长 |
| **验收** | 单文件度量、LUFS/真峰值、多文件 + 时间轴质量闸、改动的回归比对 |
| **无密钥可用** | 合成、作曲、唱声、对齐、后期、检查的技术部分完全不依赖外部服务 |

## 安装

在 DSH 会话里：

```
plugin_manager  action: install_bundle   target: <插件目录>/dsh-audio
```

或命令行：

```powershell
dsh plugin --profile <profile> add "file:<插件目录>/dsh-audio"
# 再把 "@local/dsh-audio" 加进 profile package.json 的 dsh.profile.bundles
```

安装后：**设置 → 声音**。所有工具会自动出现在 agent 的工具表里，做动画时会自己用。

## 快速开始

最省事的方式是直接说需求：

> 做一个 4 秒的弹跳动画，落地要有声音。

agent 会读 `animation-sound` 技能、排拍点、调工具渲染、检查、再接线。也可以单独用某个工具：

```js
// 单个音效
audio_synth({ preset: 'impact', params: { weight: 0.9, hardness: 0.7 }, duration: 0.6 })

// 一个设计好的"东西"
audio_design({ recipe: 'door-slam-metal' })

// 一段加速的点击声
audio_pattern({ preset: 'tick', kind: 'train', to: 2, every: 0.1, curve: 'accelerando' })

// 16 小节 lofi 配乐（返回节拍表）
audio_compose({ genre: 'lofi', bars: 16, key: 'F', mode: 'dorian' })

// 唱两句
audio_sing({ melody: 'C4:1 E4:1 G4:2 E4:1 D4:2', lyric: 'wo ai ni', voice: 'alto' })

// 旁白 + 时间戳（Edge 免费供应商）
audio_tts({ text: '第一句。第二句。', srt: true })

// 口型轨
audio_lipsync({ path: 'assets/audio/voice.wav', fps: 24, format: 'css' })

// 接进页面
audio_bind({ cues: [{ name: 'slam', at: 0.82, path: 'assets/audio/door-slam-metal.wav' }], out: 'assets/cues' })

// 交付前检查
audio_check({ paths: ['assets/audio/slam.wav'], cues: [{ at: 0.82, src: 'assets/audio/slam.wav' }] })
```

## 工具

| 工具 | 作用 |
|---|---|
| `audio_synth` | 渲染单个音效（38 个预设，感知参数 0..1，可循环） |
| `audio_pattern` | 用一条规则填满一段时间（train / scatter / riser） |
| `audio_design` | 分层设计引擎，26 个配方，或自定义层叠 |
| `audio_compose` | 作曲并渲染配乐，返回节拍表与和弦 |
| `audio_tts` | 文本转语音（MiniMax / OpenAI 兼容 / 免费 Edge），返回音频 + 时间戳 |
| `audio_voices` | 音色列表（配置后可拉到账号真实音色） |
| `audio_sing` | 零素材唱声：音高 + 拼音歌词 |
| `audio_lipsync` | 每帧口型轨（json / srt / css / ae） |
| `audio_beats` | 测 bpm、起音、节拍网格、重拍推测 |
| `audio_bind` | 生成 cue 表与页面播放器（可内联成单文件） |
| `audio_mix` | 多轨合一，逐条增益与时间偏移 |
| `audio_convert` | 裁剪/增益/淡入淡出/反转/拼接/批量归一/转码（8/16/24/32 位，单双声道） |
| `audio_stretch` | 变速不变调、移调不变时长、精确贴合目标时长 |
| `audio_loudness` | BS.1770 LUFS、真峰值、响度范围，按目标响度写校正副本 |
| `audio_probe` | 度量单文件：峰值、RMS、波峰因数、质心、起音数、循环接缝、直流 |
| `audio_check` | 交付前质量闸，含 cue 时间轴校验与叠加峰值 |
| `audio_regress` | 快照 + 容差比对，证明改动没把别的指标带歪 |

### 预设

`impact` `whoosh` `tick` `chime` `riser` `zap` `thud` `scrap` `texture`
`footstep-gravel` `footstep-wood` `footstep-water` `door-open` `door-close` `drawer` `switch-click` `cloth` `paper`
`water-drip` `water-splash` `bubble` `wind-gust` `breath-inhale`
`servo` `motor-start` `motor-loop` `alarm-beep` `alarm-siren` `hud-tick` `energy-charge`
`heartbeat-double` `creature-growl` `insect-buzz` `bone-crack`
`bass-drop` `riser-short` `bell-toll` `choir-pad`

参数是 0..1 的感知量（`weight` `hardness` `metallic` `space` `tone` `brightness` `speed` `rise` `decay`
`density` `roughness` `movement`）。`pitch` 在 `impact`/`whoosh` 上是 0.5..2 的倍频，其余预设是 0..1。
`texture` 额外支持 `kind: wind|rain|fire|room|hum`。

### 设计配方

`door-slam-metal` `door-close-soft` `glass-break` `wood-crack` `explosion-far` `explosion-near`
`whoosh-into-impact` `sci-fi-charge` `sci-fi-hum-loop` `magic-sparkle` `magic-dark` `water-drip`
`water-splash` `footstep-gravel` `cloth-rustle` `ui-success` `ui-error` `ui-hover` `ui-toggle`
`machinery-loop` `creature-scream` `creature-growl` `heartbeat` `alarm-loop` `coin-pickup` `thunder-distant`

## 可选：真人声库唱声

想要真人质感而不是合成嗓音，可以下载一个公开授权的声库（不随插件分发：体积与授权原因）：

```
node tools/fetch-voicebank.mjs --dry      # 先看清单和体积
node tools/fetch-voicebank.mjs            # 下载 9.05 MiB 子集到 ~/.dsh/dsh-audio/voicebank/
node tools/sing-bank.mjs --notes "C4:1 E4:1 G4:2" --out out.wav
```

下载脚本会逐文件校验字节数，并在样本旁边生成 `ATTRIBUTION.md`（作者、官方链接、可再分发/可编辑条款、
以及"角色与官方插画不在此授权内"的说明）。引擎按**实测音高**选最近的录音而不是按标签——
这个库的 A3/A4/D5 标签实测偏差 7–141 音分，按标签选会跑调。

## 设置

**设置 → 声音**：

- **供应商** / 接口地址 / 模型 / 音色 / 语速 / 音调
- **Edge 朗读**：选它即可用，不需要密钥。它只提供压缩音频，插件会用本机 ffmpeg 解码成波形；
  没有 ffmpeg 时直接写出可播放的 `.mp3`，不会失败。ffmpeg 路径留空则自动探测 `~/.dsh/tools/ffmpeg`
- **API 密钥**：留空则读环境变量（`MINIMAX_API_KEY`、`DASHSCOPE_API_KEY`），填写则直接当作密钥使用
- **测试连接**：TTS 侧会真的合成一句话并回放；语义检查侧会送一段铃声给模型并显示回答
- 音色：配置密钥后自动拉取账号的真实音色列表

设置保存到你的 profile 配置层，升级插件不会丢。

## 配置参考

也可以直接编辑 `cordis.patch.yml`：

```yaml
tts:
  provider: minimax                  # minimax | edge | openai | custom | none
  baseUrl: https://api.minimax.chat  # 海外站改成 https://api.minimaxi.com
  model: speech-2.8-hd
  voice: female-shaonv
  apiKeyEnv: MINIMAX_API_KEY
  # ffmpegPath: ''                  # 仅 edge 需要；留空自动探测
check:
  baseUrl: https://dashscope.aliyuncs.com/compatible-mode
  model: qwen2.5-omni-7b
  apiKeyEnv: DASHSCOPE_API_KEY
```

换成自己的 TTS（任何 OpenAI 兼容的 `/v1/audio/speech`）：把 `provider` 改成 `openai` 或 `custom`，
填上 `baseUrl` / `model` / `voice` 即可。

## 把声音接进页面

三条规则，决定了成片听起来是"配过声"还是"贴上去的"：

1. **一个时钟。** 用 `AudioContext.currentTime` 驱动动画的 `requestAnimationFrame`，不要一边用 `performance.now()`、
   一边用 `audio.currentTime`——两个时间源一定会漂移。
2. **打击音对齐峰值，不是起点。** 画面在 0.82 秒破碎，"铛"的那一下就要落在 0.82 秒，而 wav 的第一个采样是瞬态的开始，
   所以 cue 一般要提前 30–50 毫秒。
3. **先解码再启动。** `decodeAudioData` 要 await 完再起时钟，否则开头会被吞掉。

这三条 `audio_bind` 生成的播放器已经替你做好了：它按音频时钟预调度 cue（`setTimeout` 只做唤醒），
在用户手势里解锁，页面隐藏时暂停，并暴露 `window.dshAudio` 给动画驱动时间。

浏览器不允许页面在没有用户交互时出声，所以成品页通常需要一个「点击开始」。在 DSH 里打开则不受这条限制。

## 常见问题

**没有 MiniMax / DashScope 的密钥，还能用吗？**
能。合成、设计、作曲、唱声、口型/节拍、后期、检查的技术部分完全不依赖密钥。旁白可以用免费的 Edge 朗读。

**Edge 报"只提供压缩音频"？**
它的服务只返回 mp3/opus。装上 ffmpeg（DSH 自带的那份就够）后会自动解码；没有 ffmpeg 时会写出 `.mp3`，
浏览器可直接播放，只是不能再参与混音/口型分析。

**在浏览器里打开成品页没声音？**
点一下页面（浏览器的自动播放策略），并确认音频是内联在 HTML 里、而不是引用了外部文件。

**唱声听起来像人吗？**
不像。它是共振峰合成的嗓音，胜在零素材、零网络、可控、可重复；要真人质感请用 TTS，或把真人录音当作素材。

**响度按什么标准？**
ITU-R BS.1770-4 / EBU R128。网页与短视频一般 −14 LUFS，播客 −16，广播 −23；真峰值留 −1 dBTP。

**8 位音频会不会太差？**
适合短促音效和内联进单文件 HTML（体积能小一半以上）；长垫音会有明显底噪，用 16 位。

**为什么 `audio_tts` 没返回时间戳、也没生成 SRT？**
实测（2026-11，MiniMax `speech-2.8-hd`，T2A v2 同步接口）：开了 `subtitle_enable`，句级和词级都没有返回
可解析的时间戳。所以工具会如实返回 `timestamps: null` 并说明"该端点没返回"，不会编造。
需要精确时间戳时用免费的 Edge 朗读（有词级边界），或用 `audio_beats` / `audio_lipsync` 自己测。

## 许可

MIT © 2026 Soar_L
