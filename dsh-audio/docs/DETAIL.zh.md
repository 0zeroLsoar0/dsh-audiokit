![一段渲染好的音效波形沿节拍网格排列，下方几个 cue 标记正对波形峰值；右侧是说话的口型与逐帧张嘴量柱状图](preview.svg)

## 分层设计（`audio_design`）

38 个配方按"物体/生物"两大类组织：物体类 26 个（门、玻璃、爆炸、机械、UI、水、脚步……），生物类 12 个（`bird-chirp` `bird-flock` `insect-swarm` `whale-song` `wolf-howl` `frog-croak` `hoofbeats` `wing-flap` `creature-breath` `creature-hiss` `rodent-squeak` `bat-echolocation`）。全部纯合成、零素材，同一个 seed 产出同样的字节。

每个配方"像什么、由哪些层构成、怎么调"，以及"哪些动物纯合成做不到、为什么"，见 [CREATURES.zh.md](CREATURES.zh.md)。

## 时间线编辑器

浏览器里打开 `/dsh-audio/editor`：载入 cue 表、按波形拖动起点、改增益与淡入淡出、按 BPM 吸附、试听，然后复制成 `audio_bind` / `audio_daw` 可直接用的片段。只读工作区内的 `.json` / `.wav`，不接受路径逃逸。细节见 [EDITOR.zh.md](EDITOR.zh.md)。

## 剪辑软件互操作

`audio_daw` 除 EDL / Reaper `.rpp` / CSV / Audacity labels 外，还能导出 OpenTimelineIO（`.otio`，Resolve 直接导入）与 FCP7 XML（`.xmeml`，Premiere / Resolve 可导入）；AAF 目前是"容器与对象图真实、类定义表缺失"的结构子集，Pro Tools 还不能打开；OMF 是明确标注的骨架。各格式的字段覆盖、导入路径与限制见 [INTEROP.zh.md](INTEROP.zh.md)。
