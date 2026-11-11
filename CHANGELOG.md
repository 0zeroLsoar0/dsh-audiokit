# Changelog

本项目的版本记录。每次发版对应一个 git tag（`v0.5.0`），U 盘导出应从 tag 生成。

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
