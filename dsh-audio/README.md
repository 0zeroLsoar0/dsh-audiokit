# dsh-audio — 给 HTML 动画配音

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
| `audio_tts` | 旁白/台词 → wav，**带时间戳**和生效参数（MiniMax 默认，可换任意 OpenAI 兼容端点） |
| `audio_voices` | 音色短名单（防止模型编出不存在的 voice id） |
| `audio_check` | 交付前的质量闸：削波、静音、攻击延迟、cue 指向失效文件、叠加削波；可选语义评估 |

预设：`impact` `whoosh` `tick` `chime` `riser` `zap` `thud` `scrap` `texture`。

参数是 0..1 的感知量（`weight` `hardness` `metallic` `space` `tone` `density` `roughness` `movement`），
`pitch` 在 impact/whoosh 上是 0.5..2 的倍频。「一直在叮叮叮」不是几十个素材，是
`audio_pattern {every: 0.08, curve: "accelerando"}` 一条规则。

## 配置

**在 DSH 里改**：设置 → 动画配音。那个页面由本插件自己注册（客户端半身 `client.js`），
表单读写走 `/dsh-audio/config`，保存写入的是你自己的 profile patch 层，升级插件不会丢。

零配置也能用：合成、混音、`audio_check` 的技术检查都不需要任何密钥。
只有 TTS 和语义检查要密钥，放在环境变量里即可（默认就是这两个名字）：

- `MINIMAX_API_KEY` → 启用 `audio_tts`
- `DASHSCOPE_API_KEY` → 启用 `audio_check` 的 `question`

也可以直接编辑 `cordis.patch.yml` 里 `config` 那一层（与表单等价）：

```yaml
tts:
  provider: minimax          # minimax | openai | custom | none
  baseUrl: https://api.minimax.chat     # 海外换成 https://api.minimaxi.com
  model: speech-2.8-hd
  voice: female-shaonv       # 设置页会列出账号的真实音色
  apiKeyEnv: MINIMAX_API_KEY
check:
  baseUrl: https://dashscope.aliyuncs.com/compatible-mode
  model: qwen2.5-omni-7b     # 小模型；账号若只有别的 omni 型号，在设置页改成那个
  apiKeyEnv: DASHSCOPE_API_KEY
```

换成自己的 TTS（任何 OpenAI 兼容的 `/v1/audio/speech`）：

```yaml
tts:
  provider: custom
  baseUrl: https://your-endpoint
  model: your-model
  voice: your-voice
  apiKeyEnv: YOUR_KEY_ENV
```

## TTS 返回什么，以及为什么要先探测一次

`audio_tts` 返回**音频 + 时间戳 + 生效参数**三样。只有音频的话，字幕、口型、打字机效果都无从下手。

时间戳的字段名和单位**只能靠一次真实响应确认**，文档不保证。所以包里带了一个探测脚本：

```powershell
$env:MINIMAX_API_KEY = "..."
node dsh-audio\tools\probe-minimax.mjs "你好，这是第一句。这是第二句。"
```

它打印响应的**结构**（有哪些键、音频是 hex 还是 base64、时间戳数组长什么样），并把去掉音频的骨架
写到 `minimax-response.json`。解析器已经容错支持 `subtitle`/`sentences`/`words` 三种位置、
`start`/`start_time`/`begin` 三种拼写、秒和毫秒两种单位；如果探测出来还不是这些，把骨架贴给我改。

拿不到时间戳时，返回的 `timestamps` 是 `null`，工具会明说"该端点没返回"——不会编一组假时间。

## 为什么这样切

- **在宿主侧算，不在浏览器里算。** 同一份代码只跑一处，评估用的字节和成片里响的字节完全一致；
  agent 要拿音频去做判断时，不需要再把引擎搬进页面。
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

已装在两个 profile：

- `desktop`（你的日常环境，端口 4019）
- `audio-test`（隔离测试环境，端口 4123）

手动起测试实例：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "D:\Users\GUBAO\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  "D:\Users\GUBAO\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile audio-test --port 4123 --no-open
```

自测（纯 Node，不需要 DSH）：

```powershell
node dsh-audio\test\smoke.mjs          # 预设/确定性/循环/pattern/mix/offset/wav 往返
node dsh-audio\test\verify-html.mjs demo\bounce.html   # 交付页自包含校验
```

## 目录

```
dsh-audio/
  index.js            apply + 常驻提示词段（工具注册与配置）
  lib/dsp.js          合成内核（TptSvf、噪声、包络、混响、9 个预设）
  lib/audio.js        渲染编排、度量（FFT 谱质心）、mix、原子写盘
  lib/wav.js          RIFF 编解码（16bit PCM 写，8/16/24/32 + float 读）
  lib/tools.js        synth / pattern / mix / probe
  lib/providers.js    MiniMax T2A + OpenAI 兼容 speech + 音频理解；时间戳归一化
  lib/tts.js          audio_tts（分块、时间戳拼接、生效参数）+ audio_voices
  lib/check.js        audio_check（技术闸 + 可选语义评估）
  lib/skill.js        工作流 skill
  tools/probe-minimax.mjs  真实响应结构探测
  test/               smoke / tts-mock / tools-test / verify-html
```

## 已知坑：浏览器里打开没声音

DSH / Electron 默认放宽了自动播放策略，同一份页面在 DSH 里一打开就响；
用 Edge / Chrome 双击打开时，没有用户交互的页面会被浏览器按住（`AudioContext` 停在 suspended）。

所以成品页带一个「点击开始」：点一下才真正解锁。另外内联音频用 `atob` 解码而不是
`fetch(data:)`，避免 `file://` 下被拦。这两条都写进了 skill 的「为什么在浏览器里没声音」一节。

想在浏览器里也免点击，只能从浏览器侧放开策略，例如启动参数
`msedge.exe --autoplay-policy=no-user-gesture-required`（仅调试用，别当成交付方案）。

## 已知限制

- 只有单声道输出（`channels` 未开放）；立体声要改 `toWavBytes` 和 `mixTracks`。
- 只出 wav（16bit）；mp3/opus 需要引入编码器，属可替换环节。
- **TTS 时间戳取决于端点**：MiniMax 可能在模型/接口不同时返回句级、词级或什么都没有；
  解析器覆盖已知形状，`null` 表示真的没拿到，不是解析失败被吞掉。
- **音频理解没有 MiniMax 侧的对应能力**，所以 `audio_check` 的语义层走 OpenAI 兼容端点
  （Qwen-Omni 之类），默认关闭、纯可选；技术层零配置。
- `audio_mix` 的对齐是整轨偏移，没有总线/duck/自动化。
- 循环是无缝拼接（overlap-add），适合底噪类；把衰减型 one-shot 强行 `loop:true` 会被
  `loopSeam` 判出来（实测 29.7 dB），这是设计好的信号，不是 bug。

## 版本变更

### 0.5.0

- 新增 `audio_tts`（MiniMax T2A 默认，可换任意 OpenAI 兼容 `/v1/audio/speech`）、`audio_voices`、`audio_check`
- TTS 返回**音频 + 时间戳 + 生效参数**；长文本分块后时间戳按拼接偏移校正；拿不到时明确返回 `null`
- 新增设置页（设置 → 动画配音），读写走 `/dsh-audio/config`，写入你自己的 profile patch 层
- 新增 `Config` schema（schemastery 3.19）与 `tools/probe-minimax.mjs`（先打一次真实响应再定解析）
- 加入 18 Hz 隔直高通，修掉底噪类素材误报 "DC offset"
- 演示页改为：播完即停、切后台静音、重播前先停掉旧节点（原来会无限循环并叠加底噪）
