# demo/intro/audio — 16 秒开场动画的配乐

四个文件由 `render.mjs` 一条路径渲染（`bed` / `impact` / `ticks` / `end`），全部 22050 Hz 单声道 16-bit PCM，固定种子与峰值目标，两次运行逐字节一致。`manifest.json` 记录每个文件的字节数、时长、峰值与 cue 时间（bed 0.0 循环、impact 2.5、ticks 6.0、end 13.5），与 `../spec.json` 对齐。0.6.0 **没有唱腔场景**：合成唱腔工具与声库已从插件移除，所以这里也没有 `voice.wav`，整条音轨纯器乐。

- `bed.wav` — cinematic 8 小节 @120 BPM，裁到正好 16.000 s 并做 0.25 s 去咔哒淡出，−6 dBFS
- `impact.wav` — `impact` 预设 1.0 s，−1 dBFS（2.5 s 落地那一击）
- `ticks.wav` — `tick` train 4.0 s（每 0.125 s，每 4 个重音），−8 dBFS（6.0–10.0 s 词汇场景）
- `end.wav` — `ui-success` 配方 0.8 s，−3 dBFS（13.5 s 尾卡）

总计约 939 KiB（961,556 B）。重建：`node demo/intro/audio/render.mjs`；验收：`node demo/intro/audio/verify.mjs`（用插件自己的 `wav.js` 解码，核对时长、峰值、削波与 manifest 自述一致）。注意 `render.mjs` / `verify.mjs` 目前从 `dsh-audio-lab/plugin/lib` 这份 staging 副本 import 引擎——重建或发布演示前先把它指回 `dsh-audio/lib`，并重新生成 `manifest.json` 与 `index.html`。
