# Changelog

本项目的版本记录。每次发版对应一个 git tag（`v0.5.0`），U 盘导出应从 tag 生成。

## 版本管理约定

- 仓库根 = 本工作区，`.gitignore` 用白名单只跟踪 `dsh-audio/`、`demo/`、`CHANGELOG.md`；
  工作区里其他会话的产物不进仓库。
- 发版流程：改版本号（`package.json` + `index.js` 的 `VERSION`）→ 更新本文件 →
  `git commit` → `git tag -a vX.Y.Z` → 从该 tag 导出 U 盘目录。
- **U 盘上的版本目录只增不删。** 需要更新同一版本时覆盖同名文件，不要删目录。
- 旧版本的唯一权威来源是 git tag；U 盘只是副本。

## 0.6.1 — 2026-11-28

`package.json` 已 bump 到 0.6.1。0.6.0 之后这一轮把「做得出声音」补成「做完能验收、能交接」：工具 30 → **34**，
交付验收接上平台响度规格，长渲染不再堵事件循环，工具 schema 的上下文税再降约四分之一。

### 新增工具（30 → 34）

- **`audio_cues`**：音频反推 cue。从现成 `.wav` 检测冲击点与段落边界，返回 `{ at, strength, kind }`，
  可直接喂 `audio_bind`；`sensitivity` / `minGapSeconds` / `maxCues` 控制密度、合并与上限，结果可复现。
- **`audio_audit`**：旁白 / 字幕 / 口型三方只读对账。给旁白 wav、字幕 srt、口型轨（`audio_lipsync` 的
  json/srt）里任意几项，报字幕漂移与漏句、口型覆盖与单帧抖动；不改任何输入文件。
- **`audio_batch`**：一组 wav 一次跑完 `check` / `loudness` / `normalize` / `master`，逐条报错不中断。
  `normalize` / `master` 只写副本（`outDir`，默认 `out/batch`），不改原文件；工作进程数按 CPU 自动定（上限 4）。
- **`audio_handoff`**：交接简报。`lib/interop.js` 只读检测同类插件（`dsh-any-audio`），把不属于本插件的活
  写成「目标插件 / 能力 / 逐条请求」的简报；不调用对方、不联网。

### 验收层：`audio_check` 接平台规格

- `target` 平台交付规格：`youtube` / `tiktok`（−14 LUFS）、`podcast`（−16）、`broadcast`（−23）、
  `cinema`（−27 LUFS，真峰值 −2 dBTP）；也可用 `loudnessTarget` 自定义。只判定并报告差距，不改音频。
- 验证层补齐：真峰值、相位 / 单声道兼容性，以及 `cues[].expectAt` / `targets[]` 报出的 cue 同步偏差。
- 没有可判定文件时给 `issues` 而不是报绿——把「没测到」和「不合规」分开。

### 修复

- **mono LUFS 口径**：单声道按 BS.1770-4 单声道计权（一个声道只计一次），与 ffmpeg `ebur128`、Youlean 对齐；
  旧的 dual-mono（mono 按两个声道 ×2，+3.01 LU）保留为显式 `dualMono: true`。
- **`audio_loudness` 校正副本**：1/2/4/6/8 声道都能写，保持原声道布局与 16/24 位深。
- **`audio_generate` 错误脱敏**：上游错误文本里的 Bearer / `sk-` / `key=…` 以及配置的密钥本身，返回前抹成
  `[已隐去]`，错误信息不再把 key 带进对话或日志。
- **`audio_probe` / `audio_loudness`**：非有限采样（NaN / Infinity）明确报告，不再静默算成 0 或 NaN 读数。
- **编辑器目录排序**：`/dsh-audio/editor` 的目录/文件列表改用 code-unit 排序（与插件其余部分一致），
  不再受机器 collation 影响（`localeCompare` 会把 `_` 排在 `Z` 前面）。
- **`wav-encode` 注释**：旧注释称 `wav.js` 的 dither 用 `Math.random`、不能保证两次同字节；实际是固定种子
  dither 与削波（回归哈希依赖它），已改正并写明「改写入器是格式变更，不是修 bug」。
- **`audio_daw` AAF 产品标识**：写进 Identification 的 product version 随包版本更新为 0.6.1。

### 性能

- **协作式让出事件循环**：`renderScore` / `masterChain` / `renderBus` 的循环改写成生成器，工具层改用
  `renderScoreAsync` / `masterChainAsync` / `renderBusAsync`，每 N 帧 `await` 一次把事件循环还给宿主。
  同步 API 不变（`composeScore`/`renderScore` 仍是同步函数），两条驱动路径输出逐字节一致
  （`test/yield.mjs` 用 SHA-256 断言），异步路径开销测试上限 15%。
- 三个工具的描述补一句：yield 只保证事件循环活着，渲染期间**仍占 CPU**，不要把它当并行。

### 上下文税

- 工具描述压缩：模型可见 schema **98,442 B → 74,884 B（−24%）**，覆盖 34 个工具；
  长 DSL、id 目录、逐格式保真表、逐参数理由移进 `animation-sound` skill（按需加载）。
  `test/schema-budget.mjs` 以 77,000 B 为上限（约 3% 余量）守住，防止描述再长回手册。

### 测试

- 57 → **63 个测试文件全绿**（`node tools/test-all.mjs`，0 failed）：新增 `cues` / `audit` / `batch` /
  `interop` / `verify` / `yield` 六个。
- CI 六条腿：`ubuntu-latest` / `windows-latest` × node 20 / 22 / 24。
- **只放宽计时断言，不动正确性断言**（CI 2-vCPU 并行时宿主负载抖动会误报，红队报过同类）：
  `test/master.mjs` 60 s 立体声母带 2000 → 4000 ms；`test/compose.mjs` 16 小节单次渲染（ambient 最差）
  700 → 900 ms；`test/perf.mjs` 稳态门 600 → 900 ms；`test/creatures.mjs` 3 s 生物渲染 400 → 600 ms。

### 文档

- 仓库根 README 工具表更新为 34 个；插件 README 工具表同步 34，FAQ 补 mono LUFS 口径与校正副本声道说明。
- `docs/RELEASE.md` 数字刷新（63 个测试文件、node 24 实测），版本 / tarball / tag 引用改 0.6.1。
- `docs/SCHEMA_DIET.zh.md` 标注当前口径（34 工具 / 74,884 B / 77,000 B 上限），历史 0.5.10 基线保留并注明。

## 0.6.0 — 2026-11-28

`package.json` 已 bump 到 0.6.0；以下改动已在仓库，等发版指令再打 tag。

### 移除

- **`audio_sing` / voicebank 采样声库**：合成唱腔不可辨识（共振峰合成出来的人声听不出字），
  演唱交给 TTS（`audio_tts`）或 AnyAudio。随之删除 `lib/sing.js`、`lib/tools-sing.js`、
  `lib/voicebank.js`、`tools/fetch-voicebank.mjs`、`tools/sing-bank.mjs` 与 4 个相关测试；
  拼音表迁到 `lib/pinyin.js`，`audio_mouth` 与 `audio_sampler` 继续复用。工具 31 → **30**。
- **`audio_midi` 的"导入即演唱"**：import 动作（`midiToPlan` → `singPlan` → `renderSing`）随合成唱腔一起移除，
  只保留 `export`（作曲导出 .mid）与 `parse`（读 .mid 报告速度/轨道/音符，不渲染音频）。

### 新增

- **`audio_generate`**：接入外部纯音频生成模型。支持 OpenAI 兼容端点与自定义 HTTP 端点，
  prompt → wav；未配置时不可用，结果不保证确定性（内容哈希命名，同一 prompt 重跑生成新 take）。
- **时间线编辑器** `/dsh-audio/editor`：载入 cue 表、按波形拖动起点、改增益/淡入淡出/循环、BPM 吸附、试听，
  导出 cue JSON / `audio_bind` / `audio_daw` 片段；只读工作区内的 `.json`/`.wav`，拒绝路径逃逸。
- **本地音频自检**：`audio_check` 内置确定性声学自检（时长、峰值、削波、DC、起音、音色族 crest/centroid 区间、
  循环接缝），没有外部多模态模型也能给结论；`test/selfcheck.mjs` 用 9 个预设 + 10 个配方钉住区间。
- **`audio_daw` 交换格式**：新增 OpenTimelineIO（`.otio`，Resolve 可导入）与 FCP7 XML（`.xmeml`，Premiere/Resolve）；
  AAF 是结构子集、OMF 是骨架，均在文件内与返回值里明确标注"不可导入"。
- **`audio_design` 生物配方 ×12**：鸟鸣/群鸟、虫群、鲸歌、狼嚎、蛙鸣、马蹄、翅膀、呼吸、嘶声、鼠叫、蝙蝠回声。
  猫叫/狗吠等"人耳模板极强"的叫声刻意不做（合成会掉进恐怖谷），请走采样器。
- **`test/schema-budget.mjs`**：把工具 schema 的模型侧字节纳入测试预算（当前 98,442 B / 30 工具）。

### 修复（只读审计驱动）

- **安全**：`/dsh-audio/voices` 不再合并请求体（已保存 key 可被发往任意主机）；写接口只接受同源 + `application/json`；
  `apiKeyEnv`/`baseUrl`/`ffmpegPath` 白名单化；自检探测改用正确的默认环境变量；保存设置不再丢字段；
  413/415/408 语义修正；`ffmpegPath` 不再执行任意路径。
- **数据安全**：`audio_mux`/extract 写入改为同目录临时文件 + rename，执行前拒绝 `out` 等于输入，失败不再删用户文件。
- **测量**：`audio_probe`/`audio_check` 按全部声道度量（单边削波不再被平均放行、反相立体声不再误报静音）；
  多声道 LUFS 排除 LFE 并按 BS.1770-4 环绕加权，与 `audio_master` 同口径。
- **人声/口型**：歌声辅音受 velocity 控制；`audio_mouth` 在 120 bpm 处连续单调；声库坏文件逐条降级；
  preutterance 用源采样率；oto.ini 非 UTF-8 回落 latin1；lipsync 最短时长 ceil + viseme 白名单。
- **采样器/作曲**：力度带未命中给出带 midi/velocity 的明确 warning；`bars`/`bpm` 非数值回落默认值。
- **运行时**：bind 的 loop cue 不再无限循环、drift 报告如实；master 迭代不再保留整段输出
  （180 s 立体声约省 276 MB）；resampleTo 窗函数修复（升调镜像低 38 dB）；bus 跨采样率改用 HiFi（混叠低 85 dB）；
  analyze 清洗 NaN；decodeWav 校验 format/subformat/坏头。
- **导出**：EDL 事件号按排序后 1..N；xmeml `pathurl` 为 `file://` 且增益校验；AAF essence 引用链自洽；
  CFB 目录树为合法红黑树（15 子项深度 14 → 6）；`lib/omf.js` 恢复合法 UTF-8。
- **测试可信度**：`tools/test-all.mjs` 要求每个文件打印 `OK:`/`SKIP:`（空跑不算通过）；helper 移入 `test/support/`；
  `design-listen` 补上真实断言。

### 上下文税

- 移除常驻 system prompt 注入（约 1.2 KB/会话，所有会话都付）；`animation-sound` 技能仍在需要时按需加载。
- 30 个工具的模型侧 schema 实测 **98,442 B（约 31k token）**，削减方案（短描述 + skill、按需启用、合并入口）
  见 `dsh-audio/docs/SCHEMA_DIET.zh.md`。`test/schema-budget.mjs` 会阻止它继续变大。

### 测试

- `node tools/test-all.mjs` → **57 file(s) · 57 ok · 0 failed**（本机实测；CI 上 `test/video.mjs` 会自跳为
  唯一的 `[skip]`）。移除 `sing` / `sing-listen` / `sing-voicebank` / `voicebank` 四个测试文件；
  新增：`check` / `selfcheck` / `loudness` / `pattern` / `lipsync` / `generate` / `security-settings` /
  `wav-decode` / `schema-budget` / `daw-aaf` 扩充。

## 0.5.10 — 2026-11-22

对外名称统一为 dsh-audiokit（包名/客户端身份/文档；Cordis 入口 id、HTTP 路由与工具名保持不变）。

工具 27 → **30**，并补上多声道、自动化与发布工程。

### 新增工具

- **`audio_synth_graph`**：运行时合成图。模型自己用 `osc / noise / filter / env / lfo / gain / drive / ring / pan / reverb / sum`
  搭音色——真正意义的"AI 自己合成预设"。校验无分配（10 000 节点 0.034 ms），3 s/16 节点渲染 22.4 ms（134× 实时），
  带 5 个示例图（metal-clang / glassy-pluck / hollow-wind / fm-bell / folded-drone）。
- **`audio_sampler`**：采样器。指向用户自己的 wav，做键位与力度分区、变调（+12 半音实测 440.34 Hz）、
  无咔哒循环（接缝台阶 0.00107 vs 内部 0.00787）、包络、轮换取样。**不内置任何素材**。
- **`audio_daw`**：工程导出。CMX3600 EDL（24/25/30/29.97 逐帧量化 ≤ 半帧）、Reaper `.rpp`、CSV cue 表、
  Audacity labels；写出的 EDL/RPP 会再解析回来核对（219 项断言）。

### 增强

- **多声道总线/母带**（`lib/multichannel.js`）：`audio_bus` / `audio_master` / `audio_convert` 支持 4/6/8 声道，
  压缩器跨声道联动检测，真峰值上限在最响声道上验证；mono↔5.1 上/下混有明确增益约定。
- **`audio_live` 自动化车道**：pitch/filter/gain/pan/send 的斜坡（linear/exp/sine/step）与 LFO，
  可上行也可下行（关门扫频、duck 都能写）；不带动画时生成结果与 0.5.9 **逐字节相同**。
- **设置页错误本地化**：`/validate` 与 `/test` 新增 `reasonCode`（9 种）+ `detail`，
  中英界面都能显示母语原因（英文界面不再出现中文报错）。

### 工程

- `tools/test-all.mjs`：一条命令跑全部测试（40 个文件，串行，失败即非零；`--only` 过滤）。
- `.github/workflows/test.yml`：GitHub Actions，node 20/22 矩阵。
- `docs/RELEASE.md` + `dsh-audio-lab/tools/publish-pack.mjs`：打包/发布流程（在临时副本里改成公开包名
  `dsh-audio-plugin` 再打包，仓库自身的 `@local/dsh-audio` 名字保持不变，避免破坏已安装的 profile）。

## 0.5.9 — 2026-11-22

按用户要求分两步走：功能持续合并，版本号到这一步才从 0.5.6 升到 0.5.9（不直接跳 0.6.0）。
下面把这一轮的全部能力、修复与实测记录一次，作为 0.5.9 的内容。

### 工具：7 → 27

原有：`audio_synth`、`audio_pattern`、`audio_mix`、`audio_probe`、`audio_tts`、`audio_voices`、`audio_check`。

0.5.9 新增：`audio_convert`、`audio_design`、`audio_compose`、`audio_sing`、`audio_lipsync`、`audio_beats`、
`audio_bind`、`audio_regress`、`audio_stretch`、`audio_loudness`、`audio_react`、`audio_analyze`、`audio_stems`、
`audio_mouth`、`audio_midi`、`audio_bus`、`audio_spatial`、`audio_master`、`audio_mux`。

### 新增能力

- **音效预设 9 → 38**：补了拟音（脚步/门/抽屉/开关/布料/纸）、水气（水滴/溅水/气泡/阵风/吸气）、
  机械（伺服/电机/警报/HUD/充能）、生物（心跳/低吼/虫鸣/骨折）、音乐性（下潜贝斯/钟声/合唱垫）。
  可循环的额外 4 个，循环接缝实测 ≤ 1.4 dB。
- **分层设计 26 个配方**（`audio_design`）：多层共享种子、包络、混响与长度，一次调用出成品；
  实测单层叠加与单预设渲染逐样本差 0，两次渲染字节一致。
- **作曲引擎**（`audio_compose`）：8 曲风、12 调式、11 种和弦质量、按段落的强度曲线、可循环 turnaround；
  带声部进行搜索与动机变奏。实测 16 小节/5 轨最慢 1121 ms，和声 0 个非调内音，强拍和弦音命中 100%，
  8 曲风 28/28 两两可区分。
- **唱声**（`audio_sing`）：零素材共振峰合成，17 元音（含 ü 与鼻化韵）+ 24 辅音 + 颤音/气声/和声/5 种嗓音；
  实测 A3 音准 −0.01%，8 s 音频 16.4 ms。这是合成嗓音，不是真人。
- **免费 TTS**（Edge 朗读）：无需密钥，318 个音色，词级时间戳。服务只给压缩音频，因此按
  `decodeAudio` → 原始 PCM → 本机 ffmpeg → 直接写 `.mp3` 的顺序降级；实测中文 2.232 s、
  960 字长文 2 段拼接 255.2 s / 480 个时间戳。
- **口型与节拍**（`audio_lipsync` / `audio_beats`）：每帧 viseme + 连续张嘴量，可导出 json/srt/css/ae；
  节拍检测输出 bpm/置信度/网格/重拍推测。实测 100/140 BPM 误差 0/2.3 ms，30 s 分析 25.7 ms。
- **交付层**（`audio_bind`）：生成播放器（音频时钟预调度、手势解锁、可见性暂停、循环防重入），
  可内联成单文件。实测 1.234 s 提示点调度误差 0 采样。
- **编码/转换**（`audio_convert`）：8/16/24/32 位、单双声道、Kaiser 多相重采样、裁剪/拼接/淡入淡出/
  反转/补静音/批量归一/inline base64。实测 8 位往返误差半 LSB，24 位 −144.5 dB，
  44.1k→22.05k→44.1k THD+N −98.9 dB。
- **变速不变调**（`audio_stretch`）：WSOLA + 起音锚定，0.25–4x 时长精确到 1 采样、起音误差 0.00 ms，
  1 kHz 倍频程内 THD+N −66 dB；另可移调不变时长。不保留共振峰（已在模块里写明）。
- **响度**（`audio_loudness`）：BS.1770-4 / EBU R128，K 加权由模拟原型双线性变换导出（复现规范系数表），
  400 ms 块 + 75% 重叠 + −70/−10 LU 门限、EBU 3342 LRA、4x 过采样真峰值。实测 997 Hz/−23 dBFS
  在 22.05/32/44.1/48/96 kHz 全部读 −23.0 LUFS；与 ffmpeg `ebur128` 交叉比对 9 个文件最大偏差 0.05 LU。
- **回归门**（`audio_regress`）：快照 + 容差比对（峰值 0.5 dB、RMS 1 dB、质心 8%、时长 10 ms、哈希）。
- **交互音效**（`audio_react`）：16 种界面交互 + 5 个音色家族（实测平均质心 1582–2574 Hz，1.63 倍差），
  生成零胶水绑定脚本（`data-sound` 属性、手势解锁、限声部且增益补偿——三次同步连点叠加 0.00 dB）。
- **频谱分析**（`audio_analyze`）：基频（自相关 + 谐波乘积谱）、谐波电平与非谐性、共振峰、噪声度、
  衰减时间与曲线、起音类型、频段平衡，并支持容差比对。实测 440 Hz 基频误差 0.077%、1.6 s 指数衰减测得
  1.60 s（R²=1）、白噪声置信度 0、合成 /a/ 的 F1 632 Hz / F2 1287 Hz。
- **分轨导出**（`audio_stems`）：每层一个 wav + master，且 `sum(stems) == master`（实测误差 4.8e-8，
  限幅介入时 9.3e-8）；8/16/24/32 位，附哈希清单。
- **文本口型**（`audio_mouth`）：没有音频也能按拼音/字幕出口型，与音频口型共用同一套 viseme 与四种输出格式。
- **MIDI 读写**（`audio_midi`）：零依赖 SMF 编解码。compose 乐谱往返 5 轨 49 音符、时长误差 5e-6 s、
  起音偏差 0 tick；6514 个模糊输入 0 崩溃；导入后唱出的音高误差最差 0.2 音分。
- **混音总线**（`audio_bus`）：高通/低通/搁架/钟形、压缩、侧链闪避、声像与宽度。实测 200 Hz 高通对 60 Hz
  衰减 −20.95 dB（理论值一致）、4:1 压缩 6.85 dB（理论 6.74）、闪避 11.98 dB（请求 12）。
- **空间音频**（`audio_spatial`）：立体声/双耳/quad/5.1/7.1/一阶 Ambisonics，自带 WAVE_FORMAT_EXTENSIBLE
  多声道写出。实测双耳 90° ITD 660.5 µs（Woodworth 655.8）、5.1 的 0° 全进中置、距离加倍 −6.020 dB。
- **母带链**（`audio_master`）：LR4 三段压缩 + 宽度与低频单声道 + 前瞻真峰值限制，迭代到目标响度。
  实测 −24 LUFS → −14.03 LUFS / −1.24 dBTP；不可达时如实报 shortfall 而不硬削。
- **视频联动**（`audio_mux`）：probe / mux（replace·mix·attach）/ cuts / extract，走本机 ffmpeg。
  实测 3.000 s 视频混流、循环铺满、四种容器均可；不做分镜/转写分析（那是视频插件的职责）。
- **页面内实时合成**（`audio_live`）：生成 15.8 KB 的 WebAudio 模块，9 个音色实时合成、零音频字节；
  伪造的严格 WebAudio 环境里验证解锁前不出声、连点限声部、结束后总线回收。
- **作曲渲染提速**：16 小节最慢 1212 ms → 507 ms（2.0–3.3 倍），5 个曲风逐字节不变。
- **循环接缝修复**：直流阻断与滤波器改为周期预热，循环回绕从"冷启动"变成延续；`texture` 的五种底噪
  改成真正不同的五条链；循环审计 40 BUG → 0 BUG，单次音效输出逐字节不变。
- **设置页**：全部文案走 DSH 的 locale 服务（中英双语，缺失时静默降级中文）；新增实验性的「模型自检」
  （默认关闭，只校验已保存的配置）。
- **文档与素材**：README/技能文档按 27 个工具重写并加了对账门（文档漂移即失败）；插件详情页素材
  （`docs/preview.svg` + 中英详情图 + 市场文案）；演示动画与介绍页的生成脚本。

### 修复

- **16 位编码抖动用了 `Math.random()`**：同样的样本每次写出不同字节，与"同一请求同一文件"的承诺矛盾。
  改为固定种子 xorshift 三角抖动，并新增 `test/wav-determinism.mjs` 断言三次编码 SHA-256 一致。
- **`tick` / `zap` / `thud` 的噪声层被整层丢弃**：`addInto(dst, src, offset, gain)` 被写成
  `addInto(filter(...), 0, gain)`，`src` 传了数字导致循环不执行。修正后点击有了起音噪声、
  放电有了爆裂声、闷响有了气声尾巴。
- **工具摘要里的分隔符乱码**：`·` 与 `—` 被编码往返写坏成 `路` 与 `鈥?`，会直接出现在模型看到的文本里。

### 已知限制

- Edge 朗读只提供压缩音频：没有 ffmpeg 时写出 `.mp3`（可播放，但不能参与混音/口型分析）。
- MiniMax T2A v2 同步接口实测不返回时间戳（句级与词级都没有），需精确时间戳请用 Edge 或自行分析。
- 唱声是共振峰合成的合成嗓音；真人声库是独立可选资产（体积大、有授权条款），不随包分发。
- `audio_stretch` 不保留共振峰：移调会把整个频谱包络一起移动。
- 响度计量的单声道按 dual-mono（+3.01 LU）处理，便于与 EBU 参考信号对齐；`dualMono: false` 可取严格单声道值。

## 0.5.6 — 2026-11-21

### 变更

- **插件改为零依赖**：移除了 `@deepseek-ai/schemastery` 与 `Config` 导出。设置页自己读写配置，
  本来就不需要 schema 投影，保留它反而把插件绑在了宿主的包解析上——
  工作区搬到新机器后旧 pnpm store 的符号链接全部失效，导致插件无法导入。现在没有任何运行时依赖。

## 0.5.5 — 2026-11-11

### 文档与署名

- README 改写为面向使用者的版本：安装、快速开始、七个工具、设置、同步契约、常见问题。
  不包含开发过程记录、待办或内部事故说明。
- 署名与版权人统一为 **Soar_L**（LICENSE、`package.json` 的 `author`）。
- 插件在设置面板里的条目名统一为「声音」（zh）/「Sound」（en）。

## 0.5.4 — 2026-11-11

### 修复

- **保存按钮渲染成纯白**：主按钮原来用 `color:#fff` + 品牌色背景，浅色主题下品牌色是浅色系，
  结果就是白字白底的一片。改为主题令牌：背景 `--dsw-alias-bg-layer-2`、文字
  `--dsw-alias-label-primary`、边框 `--dsw-alias-border-l2`，并补了 hover 反馈。
  现在不再有任何硬编码的前景色/背景色，明暗主题都能读。

## 0.5.3 — 2026-11-11

### 移除

- **删掉「情感」配置**。枚举值（happy/sad/…）无法核实，按「不准确的信息不如没有」处理：
  schema、工具参数、设置页、skill、README 全部删除；不传 `emotion` 时由服务端按文本自行判断。

### 修复

- **保存按钮**：保存后改为**轮询接口**直到插件重启完成（此前固定等 3.2 秒，重启慢时页面会停在旧值或被误判为失败）；
  按钮状态全程可见：保存中 → 等待重启 → 已生效 / 失败原因。
- **同源校验去掉 `Origin` 字符串比较**：反向代理或 `localhost` ↔ `127.0.0.1` 的差异会误判 403，
  这正是保存可能失败的来源之一；现在只按 `Sec-Fetch-Site` 判断。
- 保存时只保留 schema 认识的字段，已删除的配置项不会再从旧覆盖行里"复活"。

### 变更

- 音频检查默认模型改为 **qwen2.5-omni-7b**（小模型）；设置页可填任何账号可用的 omni 型号，
  配好密钥后点「测试识别」即可验证型号是否可用。

### 运维记录

- 重载插件的标准动作是 `remove_bundle` + `install_bundle` 成对执行；
  单独 `remove_bundle` 会让工具从会话中消失，这一步不能落单。

## 0.5.2 — 2026-11-11

### 设置页与 DSH 统一

- 全部改用宿主主题令牌（`--dsw-alias-bg-layer-1` / `border-l1` / `label-primary` /
  `label-secondary` / `brand-primary` / `state-*`），行式布局（左标签+说明、右控件、分隔线），
  与 DSH 自带设置页同构，明暗主题自动跟随。
- 下拉仍为自绘控件（原生 select 在 Windows 上不可控风格）。

### 新功能

- **测试连接**：TTS 侧真的合成一句话并**在页面里直接回放**，同时显示时长/模型/音色/时间戳条数；
  语义检查侧把一段铃声送给模型并显示它的回答。填完密钥当场就知道对不对。
- **音色实时列表**：`/dsh-audio/voices` 调 MiniMax `get_voice`，有 key 时用账号真实音色；
  失败/无 key 时退回静态名单并**明确标注"未联网校验"**。`audio_voices` 工具同样优先实时。
- **SRT**：`audio_tts` 新增 `srt: true`，有时间戳时顺带写出 `.srt` 字幕。

### 修复

- **PowerShell 写文件引入 UTF-8 BOM**，导致 `package.json` 无法被 `JSON.parse` 读取，
  bundle 整块从组合里消失、插件在会话中"凭空消失"。已清理 4 个文件的 BOM，
  并改为非 ASCII 文件一律用编辑器工具写入。
- `cordis.patch.yml` 被同一次 BOM/编码事故写坏（中文注释乱码、`provider: openai` 被吞进注释行），已重写为纯 ASCII。

## 0.5.1 — 2026-11-11

### 设置页

- 设置项改名：**动画配音 → 声音**。
- **下拉菜单改为自绘控件。** 原生 `<select>` 在 Windows 上渲染成一行文字、没有下拉箭头，
  看起来像只读文本框，所以「供应商」只有一个选项的观感；现在点开是完整列表（MiniMax / OpenAI 兼容 /
  自定义端点 / 关闭），情感同理。
- **密钥字段语义改为 DSH 风格**：留空 → 读默认环境变量（`MINIMAX_API_KEY` / `DASHSCOPE_API_KEY`），
  填写 → 直接把输入当密钥用。接口不再回显密钥，只回 `keySet`；保存时未触碰的字段不会覆盖已存密钥。
- 保存成功后 3.2 秒自动重新读取（插件重启完成后页面自动刷新为生效值）。

### 修复（自查发现）

- **`audio_tts` 缓存文件名漏参数**：hash 只含 text/voice/model/emotion/provider，
  漏了 `speed`/`pitch`/`subtitleType`/`sampleRate`——两组只差语速的调用会覆盖同一个文件。
- **`audio_check` 的 `trackCache` 是模块级 Map**：每次调用 `clear()`，多子代理并发时会互相清空缓存。
  改为每次调用独立 Map。
- **`/dsh-audio/config` 可被跨站写入（CSRF）**：任意网页都能向 `127.0.0.1:<port>` 发简单请求改配置。
  现在校验 `Sec-Fetch-Site` 与 `Origin`，跨源一律 403。

## 0.5.0 — 2026-11-11

### 新增

- `audio_tts`：MiniMax T2A 默认，可换任意 OpenAI 兼容 `/v1/audio/speech`。
  返回**音频 + 时间戳 + 生效参数**三样；长文本按句切块，时间戳按拼接偏移校正。
- `audio_voices`：音色短名单（15 个），避免模型编造 voice id。
- `audio_check`：交付前质量闸。技术层零配置（削波 / 近乎无声 / 攻击前静音 / 直流偏移 /
  时长不符 / cue 指向静音或缺失文件 / 多条叠加峰值）；语义层可选，走 OpenAI 兼容音频输入端点。
- 设置页：设置 → 动画配音（客户端 `client.js` 注册 `settings.section`），
  读写走 `/dsh-audio/config`，保存经 configEditor 写入用户 profile patch 层。
- `Config` schema（schemastery 3.19），表单与 patch 校验同源。
- `tools/probe-minimax.mjs`：打印真实响应骨架，用于确认真实时间戳字段名与单位。
- 时间戳解析容错：`subtitle`/`sentences`/`words` 三种位置、`start`/`start_time`/`begin`
  三种拼写、秒与毫秒自动换算；解析不到时返回 `null` 并明说。

### 修复

- 底噪类素材被误报 "DC offset"：加 18 Hz 隔直高通。
- 演示页无限自动循环 + 循环底噪逐轮叠加：改为播完即停、切后台静音、重播前 stop 旧节点。
- 浏览器打开无声：改为手势内 `resume()`、`atob` 解码内联音频、加「点击开始」。
- 设置接口在冷启动后 404：改为 `ctx.inject(['webServer'])` 等 HTTP 载体挂载后再注册。
- 路由未绑定插件生命周期导致重载报 `duplicate exact route`：改用 `ctx.effect`。

### 已知问题 / 事故记录

- **0.1.0 的 U 盘快照被误删且不可恢复。** 导出 `F:\dsh-audio-0.5.0` 时，我用
  `Remove-Item -Recurse -Force` 删了 `F:\dsh-audio-0.1.0`，该命令不进回收站，
  F: 也未启用回收站，全盘搜索与 `$RECYCLE.BIN` 均无残留。
  当时没有任何版本管理机制，0.1.0 的原始字节因此丢失。
  教训：版本目录只增不删；删除前必须确认；发版必须落地为 git tag。
- 0.1.0 可重建（按对话恢复为 4 工具版本），但只能标注为「重建版」，不是原件。

## 0.1.0 — 2026-11-08

- 首个可运行版本：`audio_synth` / `audio_pattern` / `audio_mix` / `audio_probe` 四个工具。
- 9 个合成预设、确定性渲染、无缝循环、带 offsets 的混音。
- `animation-sound` skill + 常驻提示词段；MIT 许可证；可发布 manifest。
