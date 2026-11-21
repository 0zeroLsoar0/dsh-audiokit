# dsh-audio

给 HTML 动画配音的 DSH 插件。让你的 agent 在做动画时，顺手把声音也做出来。

> 合成音效、铺事件序列、混轨、旁白 TTS、交付前音频检查——一整套都在 agent 的工具箱里。

## 为什么需要它

浏览器里做出来的动画默认是静音的，而"配声音"这件事对 agent 来说一直是个黑盒：它可以写出一段漂亮的动效，
却听不见自己做了什么，也没法判断"这一下撞击配这个画面像不像"。

这个插件把音频变成**可测量、可迭代**的东西：每一次渲染都返回峰值、响度、明亮度、起始点、循环接缝，
于是 agent 能像调 CSS 一样调声音——改参数、看数字、再听（或者让你听）。

## 能做什么

- **9 个合成音效**：撞击、掠过、点击、铃声、上升音、放电、闷响、摩擦、环境底噪。全部现场合成，不含采样素材。
- **一条规则铺满一段时间**：`every: 0.08, curve: accelerando` 就是一段加速的"叮叮叮"，不用写一百个 cue。
- **多轨混音**：带时间偏移，把零散音效拼成一条 cue 轨。
- **旁白 / 台词**：MiniMax 默认，可换任意 OpenAI 兼容的 TTS 端点；返回音频 + 句/词时间戳 + 生效参数，可选直接出 SRT。
- **交付前检查**：削波、近乎无声、迟到的攻击、直流偏移、cue 指向静音或缺失文件、多条叠加后会不会破音。
- **无密钥也完整可用**：合成、混音、检查的技术部分不依赖任何外部服务。

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

agent 会读 `animation-sound` 技能、排拍点、调工具渲染、检查、再接线。你也可以单独用某个工具：

```js
// 单个音效
audio_synth({ preset: 'impact', params: { weight: 0.9, hardness: 0.7 }, duration: 0.6 })

// 一段加速的点击声
audio_pattern({ preset: 'tick', kind: 'train', to: 2, every: 0.1, curve: 'accelerando' })

// 旁白 + 时间戳
audio_tts({ text: '第一句。第二句。', voice: 'female-shaonv', srt: true })

// 交付前检查
audio_check({ paths: ['assets/audio/slam.wav'], cues: [{ at: 0.6, src: 'assets/audio/slam.wav' }] })
```

## 工具

| 工具 | 作用 |
|---|---|
| `audio_synth` | 渲染单个音效（9 个预设，感知参数 0..1，可循环） |
| `audio_pattern` | 用一条规则填满一段时间（train / scatter / riser） |
| `audio_mix` | 多条合一，支持逐条增益与时间偏移 |
| `audio_probe` | 度量单文件：时长、峰值、RMS、波峰因数、谱质心、起始数、循环接缝 |
| `audio_tts` | 文本转语音，返回音频 + 时间戳 + 生效参数，可选输出 SRT |
| `audio_voices` | 音色列表（有密钥时是账号实时列表） |
| `audio_check` | 交付前质量闸，含 cue 时间轴校验与叠加峰值 |

预设：`impact` `whoosh` `tick` `chime` `riser` `zap` `thud` `scrap` `texture`。

参数是 0..1 的感知量（`weight` `hardness` `metallic` `space` `tone` `density` `roughness` `movement`），
`pitch` 在 impact / whoosh 上是 0.5..2 的倍频。

## 设置

**设置 → 声音**：

- 供应商 / 接口地址 / 模型 / 音色 / 语速 / 音调
- **API 密钥**：留空则读默认环境变量（`MINIMAX_API_KEY`、`DASHSCOPE_API_KEY`），填写则直接当作密钥使用
- **测试连接**：TTS 侧会真的合成一句话并回放；语义检查侧会送一段铃声给模型并显示回答
- 音色：配置密钥后自动拉取账号的真实音色列表

设置保存到你的 profile 配置层，升级插件不会丢。

## 配置参考

也可以直接编辑 `cordis.patch.yml`：

```yaml
tts:
  provider: minimax                  # minimax | openai | custom | none
  baseUrl: https://api.minimax.chat  # 海外站改成 https://api.minimaxi.com
  model: speech-2.8-hd
  voice: female-shaonv
  apiKeyEnv: MINIMAX_API_KEY
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

另外：浏览器不允许页面在没有用户交互时出声，所以成品页通常需要一个「点击开始」。在 DSH 里打开则不受这条限制。

## 常见问题

**没有 MiniMax / DashScope 的密钥，还能用吗？**
能。合成、混音、检查的技术部分完全不依赖密钥；只有 TTS 和语义检查需要。

**在浏览器里打开成品页没声音？**
点一下页面（浏览器的自动播放策略），并确认音频是内联在 HTML 里、而不是引用了外部文件。

**音色 id 从哪来？**
配好密钥后设置页和 `audio_voices` 会返回账号的真实列表；没配密钥时显示的是未联网校验的短名单。

**能换成别的 TTS 供应商吗？**
可以，任何兼容 OpenAI `/v1/audio/speech` 的服务都行；不兼容的可以按 `lib/providers.js` 里的适配器形状加一个。

**为什么 `audio_tts` 没返回时间戳、也没生成 SRT？**
实测（2026-11，MiniMax `speech-2.8-hd`，T2A v2 同步接口）：开了 `subtitle_enable`，句级和词级都没有返回
可解析的时间戳。所以工具会如实返回 `timestamps: null` 并说明"该端点没返回"，不会编造。
需要精确时间戳时，可改用服务商的异步长文本或 WebSocket 流式接口，再按 `lib/providers.js` 的
`normalizeTimestamps` 支持的形状接进来。

## 许可

MIT © 2026 Soar_L
