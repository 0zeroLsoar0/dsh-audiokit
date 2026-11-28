# 生态联动：检测、分工、交接、回收

目标不是"再做一个通用音频插件"，而是让 dsh-audiokit 和同类插件（`dsh-any-audio` 等）在同一台 DSH 上**分工而不是互相覆盖**。原则：不硬依赖、不改对方代码、不自动安装。

## 1. 检测（只读）

新建 `lib/interop.js`：

- 从 `DSH_PROFILE_DIR`（DSH 注入的环境变量）读 `package.json` 的依赖与 `node_modules/<name>/package.json`；
- 解析到的插件按"能力清单"映射：`dsh-any-audio` → `{ instruments: true, soundfonts: true, voicebankSinging: true, ttsProviders: ['edge','mimo','deepseek'], dawUi: true, sfxLibrary: true }`；
- 结果缓存一次（启动时算），暴露 `detectEcosystem()`，失败返回空对象，绝不抛；
- 设置页显示一行只读状态："检测到 AnyAudio v0.5.2：人声/音源建议交给它"。

## 2. 分工（写进工具结果与技能）

检测到对方时，我们的工具返回值里加一条 `handoff`：

```json
{
  "handoff": {
    "plugin": "dsh-any-audio",
    "capability": "voicebank-singing",
    "reason": "真人声库需要 401 MB 素材与声码器，本插件不提供",
    "suggest": "audio_tts 做旁白；演唱请让 AnyAudio 的唱歌工具输出 wav，再回到 audio_check 验收"
  }
}
```

技能与系统提示同样写清边界：旁白走 `audio_tts`；演唱/采样乐器/音效库交给对方；我们负责程序化合成、测量、页面接线与工程交换。

## 3. 交接（文件/JSON，不跨插件调工具）

新工具 `audio_handoff`（可选，小 schema）：

- 输入：`prompt`、`durationSeconds`、`tracks:[{role:'music'|'narration'|'sfx', style?}]`、`target`（默认自动检测到的插件）；
- 输出：一份可粘贴的 JSON 简报（写 `out`），以及给 agent 的一句话；
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

## 6. 落地顺序

1. `lib/interop.js` 检测 + 设置页只读状态（0 依赖，1 天）；
2. 工具结果 `handoff` 字段 + skill 边界文案（半天）；
3. `audio_handoff` 小工具（半天）；
4. 验收闭环文档与演示：AnyAudio 出 wav → `audio_check` 出报告（半天）。
