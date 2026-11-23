# 专业剪辑软件互操作（audio_daw 扩展）

本文记录 `audio_daw` 新增的四个交换格式：**AAF**、**OMF**、**OpenTimelineIO (.otio)**、**FCP7 xmeml XML**，
每个格式的真实能力边界、导入步骤、字段映射、已知限制与后续工作量。

一句话结论（避免误判）：

| 格式 | 现在能做什么 | Pro Tools | DaVinci Resolve | Premiere Pro |
|---|---|---|---|---|
| **otio** | 完整可用：样例已用 opentimelineio 0.18.1 独立读回，时间轴逐样本准确 | 不能导入 | **能**（18+，File > Import > Timeline） | 需装 OTIO adapter 插件；装了就能 |
| **xmeml** | 完整可用：样例已用 Python ElementTree 独立解析，帧级准确、带增益 | 不能导入（Pro Tools 不认 FCP7 XML） | **能**（File > Import Timeline，FCP7 XML） | **能**（File > Import，Final Cut Pro XML） |
| **aaf** | **结构子集**：容器、对象图、属性编码、时间轴、嵌入 PCM 都是真的；**缺 MetaDictionary，AAF SDK 系软件会在解析字典这一步拒绝** | 拒绝（见第 1.4 节的实测证据） | 拒绝 | 不支持 AAF |
| **omf** | **骨架**：CFB 容器 + `OMFI:HEADER` 说明流 + JSON 清单；**不是 OMF 文档，Avid 必拒绝** | 拒绝 | 拒绝 | 不支持 OMF |

> 重要：**不要**把 `aaf` 描述成"Pro Tools 可用的 AAF"。它是一份真实容器里的真实 AAF 对象图加上一处
> 明确缺失的字典层，用于后续接续开发，不可交付。真正能交到剪辑软件手里的，是 `otio` 和 `xmeml`。

---

## 1. AAF（`lib/aaf.js` + `lib/cfb.js`）

### 1.1 已实现的结构（都是写出来的真实字节）

AAF 文件是 MS-CFB（结构化存储）复合文档，`lib/cfb.js` 从零实现了该容器（零依赖）：

- CFB v3（512 字节扇区）、FAT、迷你流（<4096 字节的流）+ MiniFAT、超过 109 个 FAT 扇区时的 DIFAT；
- 每个存储（storage）的子项是一棵红黑树，按 CFB 规定的顺序（**先短后长，同长忽略大小写**）排序，
  用标准红黑插入构造（黑高一致、无红红边、根为黑）；
- 读取端支持 v3/v4，逐项校验签名、字节序、扇区位移、FAT 链（无环、不越界）、迷你流边界、目录树有序性；
- 确定性：不读时钟、不用随机数，时间戳写 0，同一棵树永远同字节。

在容器之上，`lib/aaf.js` 写的对象图（类 ID 取自 AAF 注册表，属性 ID 为规范内置 PID）：

```
/                                   Root
  properties                        Root 的属性流（0x0001→MetaDictionary，0x0002→Header）
  referenced properties             弱引用表（u8 0x4c, u16 路径数, u32 pid 数, pid 路径以 0 结尾）
  MetaDictionary-1                  元字典对象 —— 只有对象外壳，没有类定义（见 1.4）
  Header-2/                         Header（字节序 II、版本 1.2、对象模型版本 1、操作模式 OP1a）
    IdentificationList-3b06{0}      产品标识（dsh-audiokit / 0.5.10 / 平台 / 生成 UUID）
    Dictionary-3b04/                字典：DataDef_Sound/Data/Timecode、ContainerDef_AAF/RIFFWAVE
    Content-3b03/                   ContentStorage
      Mobs-1901{0}                  CompositionMob = 时间轴（每条 lane 一个 TimelineMobSlot）
      Mobs-1901{1..n}               MasterMob（每个 cue 一个）+ SourceMob（每个 cue 一个，带 PCMDescriptor）
      EssenceData-1902{i}           嵌入的 PCM（原始帧，无 RIFF 头），属性 0x2702 指向流 Data-2702
```

属性流格式（与 AAF 存储对象规范一致）：

```
u8  0x4c            小端标记
u8  32              属性流版本
u16 条目数
条目 × u16 pid, u16 存储格式, u16 数据长度
数据（按条目顺序紧排）
```

存储格式值：`0x82` 数据、`0x22` 强引用、`0x32`/`0x3a` 强引用向量/集合、`0x42` 流属性、`0x02`（以及弱引用）
弱引用。强引用存的是**目标存储的名字**（UTF-16LE，含结尾 NUL）；向量在属性流里存索引流名，真正的引用在
`<名字> index` 流里（`u32 数量, u32 下一个空键, u32 最后一个空键, u32 键[]`），子对象命名为 `<名字>{<键 hex>}`。
弱引用存 `u16 表下标, u16 键 pid, u8 键长, 键`。

Mob / Slot / Component / Descriptor 的 PID 与编码（来自 AAF 对象规范的内置属性，非自造）：

| 对象 | PID | 编码 |
|---|---|---|
| MobID | 0x4401 | 32 字节 SMPTE 330 基本 UMID（12 字节 UL + 0x13 + 3 字节实例号 + 16 字节素材号） |
| Mob.Name / CreationTime / LastModified | 0x4402 / 0x4404 / 0x4405 | UTF-16LE+NUL / 8 字节日期结构 |
| Mob.Slots / UsageCode | 0x4403 / 0x4408 | 强引用向量 / 16 字节 AUID |
| SourceMob.EssenceDescription | 0x4701 | 强引用 → PCMDescriptor |
| MobSlot.SlotID / SlotName / Segment | 0x4801 / 0x4802 / 0x4803 | u32 / UTF-16LE / 强引用 |
| TimelineMobSlot.EditRate / Origin | 0x4b01 / 0x4b02 | 有理数（u32 分子, u32 分母）/ i64 |
| Component.DataDefinition / Length | 0x0201 / 0x0202 | 弱引用 / i64 |
| Sequence.Components | 0x1001 | 强引用向量 |
| SourceClip.SourceID / SlotID / Start | 0x1101 / 0x1102 / 0x1201 | UMID / u32 / i64 |
| PCMDescriptor | 0x3001, 0x3002, 0x3d01, 0x3d03, 0x3d07, 0x3d09, 0x3d0a | 采样率(有理数)、帧数(i64)、量化位深、音频采样率、声道数、平均字节率、块对齐 |
| EssenceData.MobID / Data | 0x2701 / 0x2702 | UMID / 流属性 |

时间轴映射：cue 先按重叠关系**打包成最少 lane**（`lib/timeline.js` 的区间分割贪心），每条 lane 一个
`TimelineMobSlot`，段为该 lane 的 `Sequence`，组件序列是 `Filler(间隙) + SourceClip(片段)`，编辑率 = 采样率
（默认取第一条被嵌入媒体的采样率），因此 `at`/`duration` 换算成采样点后**逐样本精确**（测试实测误差 0 µs）。
每个 cue 还有 MasterMob → SourceMob → PCMDescriptor 的引用链，EssenceData 里是**原始交错 PCM 帧**
（不是 RIFF 文件）。

确定性：UMID 的素材号 = `SHA-256("dsh-audiokit/aaf/1:<seed>")` 前 16 字节；日期固定 2025-01-01T00:00:00；
所有名字由 `属性名-PID` 派生。同一请求两次调用字节完全相同（测试断言）。

### 1.2 已支持 / 未支持字段

| 输入字段 | AAF 输出 | 说明 |
|---|---|---|
| name | ✅ Mob.Name、SlotName | 完整保留 |
| path | ⚠️ 仅作为离线标记的语义来源 | 嵌入 PCM 后 AAF 不需要外部路径；未嵌入的 cue 是"离线片段"（有长度无语料） |
| at / duration | ✅ 采样点精确 | 编辑率 = 采样率 |
| gainDb | ❌ | 需要 `OperationGroup` + 电平参数对象，本子集未实现（OTIO/xmeml/rpp 有） |
| fadeIn / fadeOut | ❌ | AAF 的淡入淡出是 `OperationGroup`/转场，未实现 |

### 1.3 嵌入 PCM 的约束

- 只嵌入**整数 PCM**（8/16/24/32 bit）；浮点或压缩 wav 会被降级为离线片段并在结果里说明原因，
  而不是用错误的描述符硬塞（`PCMDescriptor` 描述的是整型样本）。
- 总嵌入量默认上限 64 MiB（`maxEmbedBytes` 可调）；`embed: false` 写只含时间轴的离线 AAF。
- 媒体采样率与工程编辑率不同时会在 warnings 里说明（AAF 语义上由读取端重采样）。

### 1.4 与真正 AAF 的差距（实测证据，别误判）

AAF 是**自描述**格式：合规文件必须在 `/MetaDictionary-1` 里嵌入它用到的每个类的定义
（ClassDefinition / PropertyDefinition / TypeDefinition），读取端（AAF SDK）先解析字典，再理解对象。

本实现**没有写这层字典**。用独立实现验证的结果（`pyaaf2 1.7.1`，Python，作为参照实现）：

1. **容器层通过**：pyaaf2 的 `CompoundFileBinary` 能完整遍历我们的文件——
   52 个 storage / 75 个 stream，类 ID 与流内容全部读出，`validate_directory_structure()` 通过，
   根存储类 ID 为 AAF Root `b3b398a5-1c90-11d4-8053-080036210804`。
2. **高层读取在字典处失败**：`aaf2.open(file, 'r')` 抛出
   `AAFFileError: cannot find index stream: ClassDefinitions-3 index`。
   也就是说：CFB → 根对象 → Header 引用 → 弱引用表都被读过了，**恰好卡在 MetaDictionary 的
   ClassDefinitions 向量**上。Pro Tools / Media Composer / Resolve 依赖同一套 AAF SDK 逻辑，会在同一步拒绝。

参照量级（用 pyaaf2 写一个"0.5 s 单声道 + 1 个 clip"的最小真实 AAF 实测）：

- 文件 507,904 字节，其中 **MetaDictionary 的属性流 123,078 字节**、**1960 个可达目录项**；
- 目录项里约 **907 个是字典定义对象**（477 个 TypeDefinition、118 个 PropertyDefinition、约 100 个
  ClassDefinition/DataDefinition/ContainerDefinition/CodecDefinition 等），其余才是内容对象；
- 内容对象只有 10 来个（Root/Header/Identification/Dictionary/ContentStorage/3 Mob/Slot/Sequence/Clip/
  PCMDescriptor/EssenceData），我们的写入器已经全部覆盖。

所以要变成"Pro Tools 真能打开"，缺口就是**一个从 AAF 规范生成完整类定义表并把它们写成
DefinitionObject 的模块**（含 ParentClass、PropertyDefinition 的局部键/类型/可选标志，以及
`ClassDefinitions`/`PropertyDefinitions`/`TypeDefinitions` 三个向量）。

### 1.5 后续路线与工作量（按依赖排序）

1. **类定义表**（`lib/aaf-schema.js`，由规范/参照实现导出的静态数据）：约 15 个对象类 + 它们的属性定义 +
   类型定义 + 数据定义（~40–120 个定义对象）。工作量 **1–1.5 天**，风险点是 907 个定义里到底哪些是
   "必须"的——建议先用 pyaaf2 生成最小文件，逐类删减到"能被 pyaaf2 打开"。
2. **MetaDictionary 写入器**：把表写成 `ClassDefinitions`/`PropertyDefinitions`/`TypeDefinitions` 三个
   强引用集合（现有 `serializeObject` 已支持向量），并把对象的动态 PID 与定义对齐。**0.5–1 天**。
3. **端到端验证**：本机无 AAF SDK / Pro Tools，只能用 pyaaf2 作为代理验证；真正"能在 Pro Tools 打开"
   必须在装有 Pro Tools 的机器上验收。**1 天（含往返修复）**。
4. 可选：`OperationGroup` 电平/淡入淡出、外链媒体（NetworkLocator）、多声道交织校验。

合计 **3–4 天**（其中 1 天必须在有 AAF SDK/Pro Tools 的环境里）。在此之前 `audio_daw` 的 `aaf`
只能作为结构与容器能力的证明，**不可当交付物**。

### 1.6 各软件导入步骤与预期结果（现状）

- **Avid Pro Tools**：`File > Import > Session Data…` 选择 `.aaf` → 读取到字典阶段报文件损坏/无法解析
  （对应 1.4 的失败点）。当前结果是**拒绝**，不要承诺可用。
- **DaVinci Resolve**：`File > Import > Timeline…` 选 `.aaf` → 同样在字典阶段失败。
- **Adobe Premiere Pro**：不支持 AAF 导入（原生只支持 FCP7 XML / FCPXML / EDL / OMF 旧版）。
- 任何只做容器解析的工具（7-Zip 类、`olefile`、pyaaf2 的 CFB 层）都能看到完整目录树与 PCM 流。

---

## 2. OMF（`lib/omf.js`）

**状态：骨架，不是导出器。** 写出的文件是：

- 一个合法 MS-CFB v3 容器；
- `/OMFI:HEADER` 流：ASCII 说明，首行 `DSH-AUDIOKIT-OMF-SKELETON-V1`，明确写"这不是 OMF 文档"；
- `/DSH:MANIFEST` 流：UTF-8 JSON 清单，包含时间轴、cue 列表、`importable: false`、以及真实 OMFI 写入器
  还需要产出的 7 类对象（CMOB、CMOBGroup、CTrack、CClip、MMOB、MMedia、MSource）与缺失项列表。

**为什么不做完**：OMFI v2 与 AAF 共用容器但对象模型是 Avid 私有的（大端、类 A/B 流、OMFI 头记录），
没有开源参照实现可以对照字节；即使写完，也只能在装有 Avid 的机器上验收。用 AAF 的经验估算：
对象写入器 **400–600 行 + 测试 ≈ 1–2 天**，验收另需 Avid 环境。

导入步骤：Avid Pro Tools `File > Import > Session Data…`、Media Composer 的 OMF 导入——当前都会被拒绝。
不要把它当可用格式。

---

## 3. OpenTimelineIO（`lib/otio.js`）——**当前最推荐的交付格式之一**

### 3.1 写出的结构

`Timeline.1` → `Stack.1`（tracks）→ 每条 lane 一个 `Track.1`（`kind: "Audio"`）→
`Gap.1`（间隙）/ `Clip.2`（片段，带 `ExternalReference.1` 媒体引用）。

- `RationalTime.1` 的 `rate` = **音频采样率**（默认 48000，可由 `sampleRate` 指定），位置换算成采样点，
  因此 `at=0.5 s` 就是第 24000 个采样点，**逐样本精确**（不是帧对齐）。
- 重叠 cue 打包到不同 `Track`（轨道内不能同时两个 clip）；空隙写成 `Gap.1`，保证轨道内首尾相接。
- 增益/淡入淡出：**OTIO 音频模型没有电平字段**，写进 clip 的 `metadata["dsh-audiokit"]`
  （`gainDb`/`fadeIn`/`fadeOut`/`sourcePath`），并在结果 warnings 里说明"必须在剪辑软件里再套用"。
  不伪造不存在效果。

### 3.2 独立验证

用 **opentimelineio 0.18.1（官方 Python 库）** 读回测试产物：

```
name: interop test          duration: RationalTime(156000, 48000)   tracks: 2
track 0 Audio Lane 1  clip boom@0+72000  clip ding@72000+36000  clip swell@108000+48000
track 1 Audio Lane 2  gap 24000  clip overlap@24000+24000
media: file:///project/assets/boom.wav …（全部解析成功）
```

### 3.3 导入步骤

- **DaVinci Resolve 18+**：`File > Import > Timeline…` → 选 `.otio`；音频时间轴按 lane 变成音轨。
- **Nuke / 其他 OTIO 工具**：`opentimelineio.adapters.read_from_file` 直接读。
- **Premiere Pro**：需安装 OpenTimelineIO 适配器（`otio` 的 Premiere/FCP XML 桥接），否则不认 `.otio`。
- **Pro Tools**：不支持 OTIO。

### 3.4 已知限制

- 无电平/淡入淡出字段（见上，metadata 里保留）。
- `target_url` 写的是**相对工作目录的路径**（换机器需重链）；xmeml 里写的是绝对 `file://` URL。
- 不支持转场、变速、标记（markers）、嵌套 stack；本插件的时间轴模型用不到。

---

## 4. FCP7 XML / xmeml（`lib/xmeml.js`）——**另一个可直接交付的格式**

### 4.1 写出的结构

`<xmeml version="4">` → `<sequence>` → `<media><video><format>`（仅画面参数）`<audio>` →
每条 lane 一个 `<track>` → 每个 cue 一个 `<clipitem>`：

- `<start>/<end>`（轨道位置，帧）、`<in>/<out>`（源内范围，帧）、`<file>`（`<name>`、`<pathurl>`
  **绝对 file:// URL**、`<rate>`、`<duration>`、`<timecode>`、`<media><audio>` 采样参数）、
  `<sourcetrack><mediatype>audio</mediatype>`；
- 增益 → 标准 **`Audio Levels` 滤镜**（`effectid: audiolevels`，`<value>` 是线性幅度，1.0 = 0 dB），
  Premiere 与 Resolve 都会映射成片段音量；测试实测 -6 dB → 0.501187 并能读回 -6.00 dB。
- 帧率：默认 25，可选 24/25/30/50/60/23.976/29.97；29.97 写成 `<timebase>30</timebase><ntsc>TRUE</ntsc>`
  并使用丢帧时间码（分号）。

### 4.2 独立验证

用 Python 标准库 `ElementTree`（独立解析器）解析测试产物：

```
root: xmeml version=4  sequence name="interop test" duration=81  rate 25 / FALSE
audio tracks: 2, clipitems: 4
  track0 boom start=0 end=38 in=0 out=38 url=file:///project/assets/boom.wav
  track0 ding start=38 end=56  filter: Audio Levels level 0.501187
  track1 overlap start=13 end=25 in=0 out=12
```

### 4.3 导入步骤

- **Premiere Pro**：`File > Import…` → 选 `.xml`（Final Cut Pro XML）；会生成一个序列，音轨按 lane 排列，
  媒体按 `<pathurl>` 自动链接（路径不存在时会提示重链）。
- **DaVinci Resolve**：`File > Import Timeline…` → 选 xmeml `.xml`；音频序列正常，画面为空的 1920×1080
  序列参数（本导出是纯音频）。
- **Pro Tools / Avid**：不导入 FCP7 XML。

### 4.4 已知限制

- **帧量化**：`start/end` 是整数帧，`at=0.25 s` 在 25 fps 上落到第 6 帧（0.24 s）。结果里会报"最坏偏移多少 ms"
  （25 fps 一帧 40 ms）。要逐样本精确请用 `otio`。
- **淡入淡出不写**：FCP7 用 `<transitionitem>`/Cross Fade 表示淡变，各种解读不一致，本导出不伪造，
  只在 warnings 里说明需在软件里补（增益已写）。
- 音频为单声道语义（`<channelcount>1</channelcount>`）；立体声素材需要在此基础扩展。
- 音频序列没有视频 clipitem（只有画面参数块），Resolve 会得到一条空视频轨。

---

## 5. 字段映射总表

| 输入 | edl | rpp | csv | labels | **aaf** | **omf** | **otio** | **xmeml** |
|---|---|---|---|---|---|---|---|---|
| name | 注释 | NAME | 列 | 标签 | Mob/Slot 名 | 清单 | clip.name | clipitem name |
| path | 注释 | FILE | 列 | — | 离线标记 | 清单 | target_url | pathurl |
| at | 记录时码 | POSITION | 列 | 起点 | Slot 内片段位置（采样点） | 清单 | RationalTime | start 帧 |
| duration | 记录时码差 | LENGTH | 列 | 终点 | SourceClip.Length | 清单 | source_range | end-in 帧 |
| gainDb | 注释 | VOLPAN | 列 | — | ❌ | 清单 | metadata | Audio Levels |
| fadeIn/Out | 注释 | FADEIN/FADEOUT | 列 | — | ❌ | 清单 | metadata | ❌（警告） |

---

## 6. 确定性

四个新格式都满足"同一请求 = 同一字节"（测试逐字节断言）：

- AAF/OMF：容器时间戳写 0，UMID 由 SHA-256 派生，无时钟/随机数；
- OTIO：`JSON.stringify` 固定键序，时间全部由采样率换算；
- xmeml：手写字符串拼接，数字格式化不依赖 locale，换行恒为 `\n`。

工具层仍按"请求内容 hash"命名默认输出文件（`assets/audio/<format>-<hash>.<ext>`），
因此重复调用会落在同一路径、同一字节。

---

## 7. 测试

新增测试（裸 `node`，零依赖，风格与 `test/daw.mjs` 一致；`tools/test-all.mjs` 自动发现 `test/*.mjs`，无需登记）：

```bash
node test/daw.mjs       # 241 checks：原有四格式 + 新 format 的确定性/扩展名/二进制分支
node test/daw-aaf.mjs   # 143 checks：CFB 容器、AAF 对象图、引用完整性、PCM 逐字节、离线模式、工具层
node test/daw-otio.mjs  # 148 checks：OTIO 结构/不变量/往返、xmeml 结构/帧率/往返、OMF 骨架诚实性、工具层
```

`test/daw-aaf.mjs` 除了往返，还做**全图引用完整性**检查：每个 `properties` 流都能解码；每条强引用在
持有它的对象下都能找到同名子存储；每个向量的索引流条目都能找到对应子存储；每个存储的类 ID 都属于
写入器声称的 AAF 类集合。这是"字节自洽"的机器证据，也是当前能做到的最强证明。

---

## 8. 结论

- **能交付**：`otio`、`xmeml`（分别被 opentimelineio 与 ElementTree 独立读回，Resolve/Premiere 可导入）。
- **能证明不能交付**：`aaf`（容器/对象图/嵌入 PCM 真实，缺 MetaDictionary 字典层，AAF SDK 系软件在字典处拒绝）。
- **明确占位**：`omf`（骨架 + 清单 + 说明，Avid 必拒绝）。
- **不要**在 README/工具描述里把 aaf 说成"Pro Tools 可导入"；`audio_daw` 的 aaf 结果里
  `importable: false`、`structure.metaDictionary: "absent"`，工具文案也写了这一点。
