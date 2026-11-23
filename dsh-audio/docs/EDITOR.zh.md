# cue 时间线编辑器

浏览器里的一个只读-编辑页：载入 cue 表、对着波形拖动起点、改增益与淡入淡出、试听，然后导出一段可直接交给 `audio_bind` / `audio_daw` 的片段。

## 打开

插件在 DSH 的 Web 服务上注册了页面路由（和设置页同一套注入方式，没有 web 载体的组合不会提供这个页面）：

```
http://<DSH Web GUI 的地址>/dsh-audio/editor
```

端口每次启动可能不同，以当前会话的 GUI 地址为准。

## 能做什么

1. **载入**：粘贴 `audio_bind` 的 `cues` 数组（或 `{ cues, duration }` 形式），或填一个工作区内的 JSON 路径载入；只读，不会改原文件。
2. **波形**：按 cue 的 `path` 读取 wav，在浏览器里解码后画出每条轨道的波形与峰值。
3. **编辑**：拖动改起点（可勾选 BPM 吸附），改 `gainDb`、`fadeIn`、`fadeOut`、`loop`，删除/复制；时间线可缩放。
4. **试听**：WebAudio 预调度播放/暂停/停止，听到的就是拖动后的结果。
5. **导出**：底部三个标签页——更新后的 cue JSON、`audio_bind({ cues, out })`、`audio_daw({ format: 'rpp', cues, out })`，一键复制。

## 读取边界

- 只允许读工作区根目录内的 `.json` / `.wav`，路径经过规范化，`..`、绝对路径、符号链接逃逸一律拒绝。
- 只读 GET：页面不改任何文件，也不写磁盘。
- 拒绝跨站请求（和设置页同一套同源检查）。

## 端点

| 路径 | 作用 |
|---|---|
| `/dsh-audio/editor` | 页面本体（自包含 HTML + 内联脚本，无外部请求） |
| `/dsh-audio/editor/info` | 版本、允许的 cue 字段、限制 |
| `/dsh-audio/editor/project?path=` | 读一个 cue 表 JSON |
| `/dsh-audio/editor/file?path=` | 读一个 wav 的字节 |
| `/dsh-audio/editor/list?dir=` | 列工作区目录，给“浏览…”用 |

## 已知限制

- 只能编辑 cue 的起点/增益/淡入淡出/循环，不能画音量包络、不能切波形。
- 只认 wav；mp3 等其他格式请先 `audio_convert`。
- 单时间线；没有多轨分组与总线处理，混音仍交给 `audio_bus` / `audio_master`。
