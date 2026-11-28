![一段渲染好的音效波形沿节拍网格排列，下方几个 cue 标记正对波形峰值；右侧是说话的口型与逐帧张嘴量柱状图](preview.svg)

## 分层设计（`audio_design`）

38 个配方按"物体/生物"两大类组织：物体类 26 个（门、玻璃、爆炸、机械、UI、水、脚步……），生物类 12 个（`bird-chirp` `bird-flock` `insect-swarm` `whale-song` `wolf-howl` `frog-croak` `hoofbeats` `wing-flap` `creature-breath` `creature-hiss` `rodent-squeak` `bat-echolocation`）。全部纯合成、零素材，同一个 seed 产出同样的字节。

每个配方"像什么、由哪些层构成、怎么调"，以及"哪些动物纯合成做不到、为什么"，见 [CREATURES.zh.md](CREATURES.zh.md)。

## 时间线编辑器

浏览器里打开 `/dsh-audio/editor`：载入 cue 表、按波形拖动起点、改增益与淡入淡出、按 BPM 吸附、试听，然后复制成 `audio_bind` / `audio_daw` 可直接用的片段。只读工作区内的 `.json` / `.wav`，不接受路径逃逸。细节见 [EDITOR.zh.md](EDITOR.zh.md)。

## 剪辑软件互操作

`audio_daw` 除 EDL / Reaper `.rpp` / CSV / Audacity labels 外，还能导出 OpenTimelineIO（`.otio`，Resolve 直接导入）与 FCP7 XML（`.xmeml`，Premiere / Resolve 可导入）；AAF 目前是"容器与对象图真实、类定义表缺失"的结构子集，Pro Tools 还不能打开；OMF 是明确标注的骨架。各格式的字段覆盖、导入路径与限制见 [INTEROP.zh.md](INTEROP.zh.md)。

## 混音声道（`audio_mix`）

`audio_mix` 保留输入的声道，不再一律折成单声道。默认 `channels: 'auto'` 跟随最宽的输入：只要有一条立体声（或多声道）素材，输出就是立体声；全部单声道输入仍输出单声道，且字节与旧实现完全一致（回归测试用固定 sha256 锁定）。4/6/8 声道素材先按 `lib/multichannel.js` 的 WAVE 布局矩阵折叠到 L/R，LFE 不混入左右（`lfeDropped: true`）；单声道素材进立体声时按等功率声像律放在正中（两侧各 −3 dB，与 `audio_convert` 的 `channels: 2` 一致），折叠回单声道可还原电平。限幅与峰值归一化对左右用同一条增益曲线（按每帧最大绝对值驱动、左右统一缩放），因此声像不会漂移。`channels: 1` 强制单声道（旧的平均折叠），`channels: 2` 强制立体声。返回值写明 `channels`（输出声道数）、`foldedFrom`（最宽输入的声道数）与 `inputChannels`（每个输入的实际声道数）。

## 母带（`audio_master`）

`audio_master` 把一条 cue 做到投放响度目标而不削波：LR4 四阶分频多段压缩 → 中侧宽度 + 低音单声道 → 4× 过采样真峰限制器，外层搜索只动增益（一轮 = 1 次限制器应用 + 1 次 LUFS 测量，最多 5 轮）。限制器曲线建在缓存的峰值包络上，迭代不重跑前端压缩/宽度，所以"再试一次"很便宜。目标够不到时写最响的安全电平并报 `shortfallLu`，不写削波文件。

`mode` 只决定搜索怎么花内存，默认 `"memory"`：

| `mode` | 每次迭代保留什么 | 限制器计算次数 | 180 s / 48 kHz 立体声占用 |
| --- | --- | --- | --- |
| `memory`（默认） | 只有标量（增益、LUFS、真峰、trim、GR） | 迭代数 + 1（选中的那次再渲染一遍） | 约 69 MB（一份输出） |
| `fast` | 每次迭代的整段输出样本 | 迭代数（少 1 次重算，约省 10 % 时间） | 约 345 MB = 5 次尝试 × 69 MB |

两种模式的增益、trim 和输出样本逐字节一致（同一输入 SHA-256 相同），`report.mode` / `report.modeNote` 说明跑的是哪一种，工具返回值里也有扁平的 `mode` 字段。`fast` 在保留量超过 256 MB 或母带长于 300 s 时，把这条路径的内存代价写进 `report.warnings`（文本摘要里同样会读出来）——两种模式结果相同，差别只是 RAM。`mode` 传非法值（如 `"turbo"`、大小写不符）直接报错并列出两个合法值，不会静默退回默认。

