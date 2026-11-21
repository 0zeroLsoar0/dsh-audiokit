# demo/intro — dsh-audio 16 秒插件开场动画
**重建：** `node demo/intro/build.mjs` — 读取 `spec.json` + `audio/manifest.json`（缺失则生成静音时钟回退版），覆盖写出 `index.html`
**是什么：** 单文件、零网络、零外部字体的 5 场景开场动画；点击门禁后所有视觉由 `AudioContext.currentTime` 单一时钟驱动，17 个真实工具名，音频（8-bit，床声 11025 Hz）以 base64 `data:audio/wav` 内联，页尾可重播
