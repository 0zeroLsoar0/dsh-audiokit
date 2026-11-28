# 生态联动：检测、分工、交接、回收

目标不是"再做一个通用音频插件"，而是让 dsh-audiokit 和同类插件（`dsh-any-audio` 等）在同一台 DSH 上**分工而不是互相覆盖**。原则：不硬依赖、不改对方代码、不自动安装。

## 1. 检测（只读）

新建 `lib/interop.js`：

- 从 `DSH_PROFILE_DIR`（DSH 注入的环境变量）读 `package.json` 的依赖与 `node_modules/<name>/package.json`；
- 解析到的插件按"能力清单"映射：`dsh-any-audio` → `{ instruments: true, soundfonts: true, voicebankSinging: true, ttsProviders: ['edge','mimo','deepseek'], dawUi: true, sfxLibrary: true }`；
- 结果缓存一次（启动时算），暴露 `detectEcosystem()`，失败返回空对象，绝不抛；
- 设置页显示一行只读状态："检测到 AnyAudio v0.5.2：人声/音源建议交给它"。

## 2. 分工（写进技能、提示与交接简报）

边界只在需要的地方写一次：每个渲染工具的返回值**不再**各带一条 `handoff`（每个结果都附一段生态信息是纯上下文税），分工落在两处——`audio_handoff` 的简报（逐轨 `capability` / `owner` / `boundary`，见 §3）和技能 / `PROMPT_SECTION` 的一句话边界：

> 旁白走 `audio_tts`；采样乐器、声库与音效素材库交给检测到的同类插件（当前能力表只认 `dsh-any-audio`）；本插件负责程序化合成、测量、页面接线与工程交换。

真正需要一份可交付的分工时调 `audio_handoff`，它按能力表给出 `plugin` / `capability` / `reason` 与可粘贴的 `suggest`/`ask`，而不是让每个工具都背这段文字。

## 3. 交接（文件/JSON，不跨插件调工具）——已落地

工具 `audio_handoff`（`lib/tools-handoff.js`，探测与能力表在 `lib/interop.js`）：

- 输入：`prompt`（必填，≤2000 字符）、`durationSeconds`（1..3600，默认 30）、`tracks:[{role:'music'|'narration'|'sfx', style?}]`、`out`；目标插件由只读探测决定，**没有 `target` 参数**——不猜、也不允许调用方覆盖探测结果；
- 输出：`{ schema:'dsh-audiokit/handoff@1', prompt, durationSeconds, target, tracks:[{role,style,capability,owner,ask,boundary,acceptance}], instruction, acceptance, ecosystem }`，默认写 `assets/audio/handoff-<内容哈希>.json`（同样的输入与探测结果重跑写回同一字节）；`target: null` 表示没检测到同类插件，简报仍可当分工清单；
- 不调用对方、不联网，只生成交接合同；对方完成后产物回到我们的工具链。

## 4. 回收（我们的差异化）

对方产出的 `wav` / `midi` 直接进入我们的验收闭环：

- `audio_probe` / `audio_loudness`（BS.1770 + 真峰值）；
- `audio_check`（质量闸 + 本地声学自检）；
- `audio_regress`（版本对比，证明没改坏）；
- `audio_daw`（EDL / Reaper / OTIO / FCP7 / AAF 子集）——对方只导 MIDI；
- 平台响度合规（后续：YouTube −14 / 播客 −16 / 广播 −23 一键）。

## 5. 非目标

- 不自动安装对方、不写对方配置、不读对方凭据；
- 不跨插件直接调用工具（DSH 的工具作用域不允许，也不该允许）；
- 不复制对方的音源/声库/音效素材（许可各自独立）。

## 6. 落地状态

1. ✅ `lib/interop.js` 只读检测 + 设置页一行只读状态（`test/interop.mjs` 锁住探测与能力表）；
2. ✅ 分工文案进了 skill / `PROMPT_SECTION`；"每个工具结果带 `handoff` 字段"改由 `audio_handoff` 统一产出（见 §2，避免每个结果都背一段生态文字）；
3. ✅ `audio_handoff` 已注册（`test/interop.mjs` 覆盖简报内容、确定性与参数校验）；
4. ✅ 验收闭环：`audio_probe` / `audio_loudness` / `audio_check` / `audio_regress` / `audio_daw` 都在，平台响度合规（YouTube −14 / 播客 −16 / 广播 −23）也已在 `audio_check` 的 `target` 里落地；演示见 `demo/dossier`（用 `audio_cues` 回读成品自检）。
