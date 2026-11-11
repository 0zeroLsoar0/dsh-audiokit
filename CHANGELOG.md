# Changelog

本项目的版本记录。每次发版对应一个 git tag（`v0.5.0`），U 盘导出应从 tag 生成。

## 版本管理约定

- 仓库根 = 本工作区，`.gitignore` 用白名单只跟踪 `dsh-audio/`、`demo/`、`CHANGELOG.md`；
  工作区里其他会话的产物不进仓库。
- 发版流程：改版本号（`package.json` + `index.js` 的 `VERSION`）→ 更新本文件 →
  `git commit` → `git tag -a vX.Y.Z` → 从该 tag 导出 U 盘目录。
- **U 盘上的版本目录只增不删。** 需要更新同一版本时覆盖同名文件，不要删目录。
- 旧版本的唯一权威来源是 git tag；U 盘只是副本。

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
