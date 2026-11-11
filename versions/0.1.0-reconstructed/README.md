# 0.1.0 快照（重建版）

> **这是重建版，不是原件。**
>
> 原始 0.1.0 的 U 盘快照（`F:\dsh-audio-0.1.0`）在导出 0.5.0 时被我误删，
> `Remove-Item -Recurse -Force` 不进回收站，F: 也没有回收站目录，全盘搜索无残留，
> 当时没有 git 或任何归档机制，所以**原件的字节已经不可恢复**。
>
> 本目录是按开发过程重建的功能等价快照，只用于留档和对照，不应被当作历史版本发布物。

## 目录

```
dsh-audio/      0.1.0 形态的包（4 个工具，无 TTS / 音频检查 / 设置页）
demo/           与 0.1.0 导出时一致的演示（文件自 2026-11-08 起未再改动）
dist/           从本目录重新 pack 出的 local-dsh-audio-0.1.0.tgz（重建产物）
open-demo.bat   双击看演示
```

## 与原件的关系

**原样保留**（这些文件在 0.1.0 之后未再修改，与原件一致）：

- `dsh-audio/lib/audio.js`、`lib/dsp.js`、`lib/wav.js`、`lib/tools.js`
- `dsh-audio/LICENSE`、`locale/en.json`、`locale/zh.json`、`icon.svg`
- `dsh-audio/test/smoke.mjs`、`test/verify-html.mjs`
- `demo/` 全部文件

**按当时形态重建**（原件已丢失，内容依据开发记录复原，语义一致但字节未必相同）：

- `dsh-audio/index.js`（4 工具版本，无 Config、无设置接口）
- `dsh-audio/package.json`（0.1.0 清单：无 schemastery 依赖、无 `dsh.client`、无 `./client` 导出）
- `dsh-audio/cordis.patch.yml`（`config: {}`）
- `dsh-audio/README.md`
- `dsh-audio/lib/skill.js`（已移除 0.5.0 才有的「旁白与口型」「交付前检查」两节）

**间接证据**：本目录重新打包得到 28.0 KB，与原 0.1.0 的 27.9 KB 基本一致；
`test/smoke.mjs` 与 `test/verify-html.mjs` 在本目录内均可通过。

## 验证

```powershell
node dsh-audio\test\smoke.mjs
node dsh-audio\test\verify-html.mjs demo\bounce.html
```

两者在 2026-11-11 重跑通过。
