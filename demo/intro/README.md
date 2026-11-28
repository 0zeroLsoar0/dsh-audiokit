# demo/intro — dsh-audiokit 16 秒插件开场动画

**重建：** `node demo/intro/build.mjs` — 读 `spec.json` + `audio/manifest.json`（音频缺失时自动降级为静音时钟版），覆盖写出单文件 `index.html`。
**是什么：** 16.0 s、120 BPM、**4 个场景**（静默 → 声音出现 → 声音词汇 → 承诺）的单文件动画；点击门禁之后所有视觉由 `AudioContext.currentTime` 单一时钟驱动。0.6.0 移除了合成唱腔工具与声库，所以**没有唱腔场景**，音轨是纯器乐的四个 cue（bed / impact / ticks / end）；「声音词汇」场景的每个工具 chip 都来自构建时现场加载的注册表（当前 34 个 `audio_*` 工具）。页尾可重播。
**验收：** `node demo/intro/verify.mjs` — 断言 4 个场景连续且覆盖 0..16 s、页面出现真实工具名、音频以 base64 内联、无网络/外链，并核对 cue 时间与 `spec.json` 一致。
