# dsh-audiokit 工具 Schema 上下文税：实测与削减方案

> 只读研究。本文是唯一新增文件，未改动任何代码、其他文档或 profile，未 commit。
> 实测基线：`dsh-audiokit 0.5.10`（`@local/dsh-audio`，Desktop/ASAR 安装，Node v24.22.2 / Electron runtime v24.21.0）。
> 测量快照：2026-11-28 12:39（本地时间）。测量期间该工作树正被并行编辑；12:47 复测为 104,558 B（+0.2%），
> 故下文所有绝对值取快照，比例与结论不受影响。测量方式见 [§1.7](#17-复现方法)。

---

## 0. TL;DR

| 项目 | 数字 |
|---|---|
| 注册工具数 | **31** 个 `audio_*` |
| 定义 JSON 合计（`JSON.stringify(definition)`） | **104,352 B = 101.91 KB** |
| 其中真正会上线给模型的部分 | **98.85 KB ≈ 2.5–2.9 万 token** |
| 描述文本占比 | **64.7%**（工具描述 18,876 B + 参数描述 48,599 B） |
| 全部 `parameters` 占比 | 80.00 KB，占定义 78.5% |
| Top 15 工具占比 | **67.4%**；50% 的税由 10 个工具产生，80% 由 20 个产生 |
| 枚举列表合计 | 7,010 B，其中 **4,775 B 是重复**（同一个 38 预设枚举出现 11 次） |

**结论**：这笔税**几乎全是文字**，不是结构。削 `description` 是主战场；合并工具（A）单独做的收益约 35–39%，和"把描述写短"（B）相当，但迁移代价高一个数量级。**推荐顺序 B → C →（可选）A**；B+C 在非动画会话上可拿到约 60–80% 的综合减免。

---

## 1. 实测现状

### 1.1 总量

用 `test/hardening.mjs` 的 fake ctx 写法加载 `index.js` 的 `apply()`（补一个 no-op `ctx.inject` 让 web route 注册静默跳过；`ctx.get('skills')` 返回 `undefined`，skill 注册被跳过），抓全部 `register()` 到的定义。

| 指标 | 字节 | KB |
|---|---:|---:|
| `JSON.stringify(definition)` 合计 | 104,352 | 101.91 |
| `JSON.stringify(parameters)` 合计 | 81,923 | 80.00 |
| 工具 `description` 合计 | 18,876 | 18.43 |
| 参数 `description` 合计（440 条） | 48,599 | 47.46 |
| `enum` 列表合计（58 个数组 / 659 个值） | 7,010 | 6.85 |
| 模型侧实际载荷（name+description+parameters） | 101,221 | 98.85 |

`apply()` 加载耗时 **3 ms**，不是性能问题，纯粹是 prompt 常驻成本。

**token 换算**：98.85 KB ÷ 4 ≈ **25,300 token**；÷ 3.5 ≈ **29,000 token**。与审计给出的"约 97 KB / 2.5–3 万 token"一致（差值是"整份定义"与"上线部分"的口径差）。

**量级参照**：lead 之前移除的 `PROMPT_SECTION` 是 ~1.2 KB。保留的工具 schema 是那段的 **约 82 倍**——砍掉 prompt 段落是对的，但真正的税在工具定义里。

### 1.2 成本构成：描述文字占 64.7%

- 纯描述文本 = 18,876 + 48,599 = **67,475 B = 64.7%**
- 结构部分（类型、属性名、enum、required 等）= 104,352 − 67,475 = **36,877 B = 35.3%**
- 如果把 `"description":` 这个键名本身也算进去，模型侧口径下描述类开销达 **72.7%**

单独看 `parameters` 内部：描述文本约占 **66.8%**，schema 结构只占 33.2%。**所以"压 schema 结构"是错的方向，"压文字"才有量。**

### 1.3 Top 15（按定义字节）

| # | 工具 | 定义 B | parameters B | 工具 desc B | 参数 desc B | enum B | 属性数 | required |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `audio_design` | 8,072 | 7,310 | 647 | 5,045 | 1,039 | 9 | 0 |
| 2 | `audio_bus` | 6,693 | 5,690 | 891 | 3,470 | 34 | 10 | 1 |
| 3 | `audio_synth_graph` | 5,759 | 1,965 | **3,674** | 1,523 | 68 | 6 | 0 |
| 4 | `audio_master` | 5,221 | 4,160 | 946 | 2,281 | 534 | 12 | 0 |
| 5 | `audio_analyze` | 4,784 | 4,179 | 489 | 1,913 | 910 | 7 | 0 |
| 6 | `audio_convert` | 4,774 | 3,784 | 874 | 2,530 | 105 | 20 | 2 |
| 7 | `audio_daw` | 4,752 | 4,033 | 607 | 2,697 | 54 | 9 | 1 |
| 8 | `audio_live` | 4,446 | 3,626 | 707 | 2,359 | 175 | 8 | 0 |
| 9 | `audio_sing` | 4,288 | 3,363 | 812 | 2,295 | 65 | 13 | 0 |
| 10 | `audio_midi` | 4,255 | 3,698 | 444 | 1,852 | 399 | 23 | 1 |
| 11 | `audio_mux` | 3,721 | 2,999 | 610 | 1,975 | 60 | 17 | 1 |
| 12 | `audio_spatial` | 3,649 | 3,106 | 427 | 2,027 | 76 | 7 | 1 |
| 13 | `audio_sampler` | 3,510 | 2,871 | 523 | 1,855 | 0 | 14 | 1 |
| 14 | `audio_compose` | 3,348 | 2,888 | 344 | 1,697 | 308 | 11 | 1 |
| 15 | `audio_pattern` | 3,070 | 2,642 | 312 | 1,319 | 524 | 15 | 1 |
| | **Top 15 合计** | **70,342** | | | | | | (67.4%) |

两个极端值得单独点出：

- **`audio_synth_graph` 是性价比最差的写法**：单条工具描述 3,648 字符 / 3,674 B，占它整个定义的 64%。它在描述里讲了完整合成图 DSL（节点类型表），这本来就是 skill 的内容。
- **`audio_voices` 只要 386 B**，是全表最便宜的，说明"短描述 + 小参数集"确实能压到百字节级。

### 1.4 全部 31 个工具（升序）

| 工具 | 定义 B | params B | desc B | 参数desc B | enum B |
|---|---:|---:|---:|---:|---:|
| `audio_voices` | 386 | 62 | 209 | 0 | 0 |
| `audio_probe` | 926 | 324 | 488 | 149 | 0 |
| `audio_generate` | 932 | 551 | 264 | 215 | 24 |
| `audio_stretch` | 1,686 | 1,177 | 393 | 770 | 0 |
| `audio_mix` | 1,861 | 1,304 | 445 | 676 | 0 |
| `audio_bind` | 2,282 | 1,864 | 305 | 1,071 | 0 |
| `audio_react` | 2,309 | 1,829 | 366 | 1,179 | 210 |
| `audio_beats` | 2,345 | 1,791 | 440 | 680 | 455 |
| `audio_synth` | 2,454 | 2,011 | 329 | 1,124 | 455 |
| `audio_stems` | 2,510 | 2,055 | 341 | 1,289 | 15 |
| `audio_mouth` | 2,548 | 2,028 | 406 | 1,248 | 72 |
| `audio_tts` | 2,699 | 2,048 | 539 | 1,449 | 18 |
| `audio_loudness` | 2,710 | 1,974 | 619 | 863 | 455 |
| `audio_check` | 2,745 | 1,973 | 658 | 1,173 | 0 |
| `audio_regress` | 2,749 | 2,347 | 286 | 831 | 476 |
| `audio_lipsync` | 2,868 | 2,271 | 481 | 1,044 | 479 |
| `audio_pattern` | 3,070 | 2,642 | 312 | 1,319 | 524 |
| `audio_compose` | 3,348 | 2,888 | 344 | 1,697 | 308 |
| `audio_sampler` | 3,510 | 2,871 | 523 | 1,855 | 0 |
| `audio_spatial` | 3,649 | 3,106 | 427 | 2,027 | 76 |
| `audio_mux` | 3,721 | 2,999 | 610 | 1,975 | 60 |
| `audio_midi` | 4,255 | 3,698 | 444 | 1,852 | 399 |
| `audio_sing` | 4,288 | 3,363 | 812 | 2,295 | 65 |
| `audio_live` | 4,446 | 3,626 | 707 | 2,359 | 175 |
| `audio_daw` | 4,752 | 4,033 | 607 | 2,697 | 54 |
| `audio_convert` | 4,774 | 3,784 | 874 | 2,530 | 105 |
| `audio_analyze` | 4,784 | 4,179 | 489 | 1,913 | 910 |
| `audio_master` | 5,221 | 4,160 | 946 | 2,281 | 534 |
| `audio_synth_graph` | 5,759 | 1,965 | 3,674 | 1,523 | 68 |
| `audio_bus` | 6,693 | 5,690 | 891 | 3,470 | 34 |
| `audio_design` | 8,072 | 7,310 | 647 | 5,045 | 1,039 |

### 1.5 枚举重复（白送的 4.7 KB）

58 个 enum 数组、659 个值、合计 7,010 B。其中 **4,775 B 是同一个列表被反复声明**：38 个预设 id 的枚举在 11 个工具里各出现一次（约 456 B × 11），另外 `audio_design` 还有一份 38 个配方的 recipe 枚举（570 B）。

去重后只需 **2,235 B**。也就是说，**仅靠"预设枚举只声明一次"就能白拿 4.7 KB（约 1.2k token）**，且不损失任何模型可见信息（skill 的预设表已经是权威清单）。这是投入产出比最高的一刀。

### 1.6 哪些字段根本不上线

实测每个定义除 `name/description/parameters` 外还带：

| 字段 | 出现 | `JSON.stringify` 后 | 是否上线 |
|---|---|---|---|
| `execute` | 31/31 | 丢弃（函数） | 否 |
| `presentCall` | 31/31 | 丢弃（函数） | 否 |
| `output.schema` | 31/31 | 保留，合计 **558 B** | **否**（见 §2.1） |
| `isConcurrencySafe` | 31/31 | 保留，合计 **155 B** | **否**（见 §2.1） |

**含义**：审计的"97 KB"如果包含 `output`/`isConcurrencySafe`，会比真实模型成本高约 0.7 KB；这部分**不需要削**，削了纯属白干。反之，`output.schema` 该留着，它是 Host 侧渲染契约。

### 1.7 复现方法

脚本是一次性的，已按要求放在临时目录、**未入库**（`%TEMP%\schema-diet\measure.mjs`）。需要复测时，在插件目录下建同构小脚本即可，核心只有三句：

```js
import { apply } from './index.js'
const tools = new Map()
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  get: (n) => (n === 'workingDirectory' ? { get: () => process.cwd() } : undefined),
  inject: () => {}                     // webServer/skills 缺席时 Cordis 本就不会回调
}
apply(ctx, {})
const B = (s) => Buffer.byteLength(s, 'utf8')
let defTotal = 0, descTotal = 0, argTotal = 0
for (const d of tools.values()) {
  defTotal += B(JSON.stringify(d))
  descTotal += B(d.description ?? '')
  const walk = (n) => { if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    for (const [k, v] of Object.entries(n)) k === 'description' && typeof v === 'string' ? argTotal += B(v) : walk(v) }
  walk(d.parameters)
}
console.log(defTotal, descTotal, argTotal)
```

---

## 2. DSH 机制结论

以下均引自本机安装（`DSH_INSTALL_DIR` 指向 `...\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh`），行号为实读行号。

### 2.1 模型到底看到什么：只有 name + description + parameters

- `dsh-tools/src/contracts.ts:66-67`（`timeoutMs` 的文档注释）：*"it is NEVER sent to the model — `schemas()` whitelists only name/description/parameters."*
- `dsh-tools/src/contracts.ts:72-74`（`isConcurrencySafe`）：*"This metadata is never model-visible."*
- `dsh-tools/README.md:112`：注册表把定义投影到 model-facing `ToolSchema`，*"`output`, `execute`, `finalizeContent`, `timeoutMs`, and presentation callbacks never leak onto the wire."*
- `dsh-tools/README.md:165`：*"In normal mode the model sees each visible definition's exact name, description, and JSON Schema"*

**结论**：`isConcurrencySafe` 对上下文**零成本**，31 个工具全量标 `true` 是对的，不要为省字节去动它。真正要削的只有 `description` 与 `parameters`（而 parameters 里 66.8% 也是描述）。

### 2.2 能不能只注册子集：能，但有三条不同的路

| 途径 | 粒度 | 插件能否自用 | 证据 |
|---|---|---|---|
| 条件注册 `register(def, { when })` | 每个模型步、每个 agent | ✅ 可以 | `dsh-tools/README.md:69`；`src/contracts.ts:106-124` |
| `ctx.tools.restrict({ allow/deny })` | 单个 agent 的继承掩码 | ❌ **不行** | `dsh-tools/README.md:88`；`src/index.ts:162-165` |
| 拆 bundle / 放进 preset | profile 级 / 会话级 | ✅ 打包层 | `README.md:77`；`compositions.md:9,73` |

**关键限制**：`restrict()` 只能从 **scoped context（`agent.ctx`）** 调用——`src/index.ts:165` 明确抛错：*"tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent"*。所以**插件无法在自己的 `apply()` 里给全局做白名单**。想"只注册子集"，插件能自己做的就是**少注册**（条件注册或按 config 门控）。

反过来，`src/index.ts:182` 还会校验 deny 名单里的名字必须是已知全局工具，写错名字直接抛错——这对 C 方案是个可用性细节。

### 2.3 惰性 schema：不存在

`schemas()` / executor `describe()` 是**在每次请求组装时**投影的（`dsh-tools/README.md:112`；投影入口 `dsh-tools/lib/index.js:418` 的 `ctx.systemPrompt.tools(...)`），并且 `README.md:169` 明确：*"Fixed per-request cost proportional to the visible definitions."*

没有"工具先只给一句简介、调用时才展开完整 schema"的机制。`when` 能做到的是**整个工具从那一步的声明里消失**（省全额），而不是"延迟展开"。

> 这一点对方案设计很重要：**"渐进披露"只能在工具之外做**（skill、文档），不能在工具 schema 内部做。

### 2.4 工具分组：注册表没有，打包层有

工具注册表本身**没有 group 概念**——没有 `group:`、没有 `tags:`、没有按组开关。分组只存在于：
- Cordis 插件层（`cordis-plugin-group`、preset 的 `plugins` 列表）
- profile 的 patch 层（每个 entry 一个 `disabled:`，见 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`）

### 2.5 按会话 / 按工作区

- **按会话**：没有一个"会话级工具开关"的 API，但**有等价物——agent preset**。`compositions.md:9` 规定预设声明带 `plugins`（必填的 Cordis entry 列表）；`compositions.md:73` 说 *"Preset plugins contribute scoped tools… Preset revisions are eagerly activated once and shared by their selecting Agents."* 会话选哪个预设，就决定它看到哪些工具。这是**唯一**真正的按会话开关。
- **按工作区**：没有证据支持工作区粒度的注册开关。`when` 的回调只拿到 `{ agent, modelSelection, signal }`（`contracts.ts:106-113`），拿不到工作区；理论上能从 `agent` 反查 session 的 cwd 再按目录判断，但那是启发式，且状态一翻转就砸 KV cache（见 §2.6），不建议。

### 2.6 一个必须先想清楚的代价：KV cache

`dsh-tools/README.md:173`（KV Cache effect）：

> *"Prefix-stable while visible definitions and their order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the first changed schema token."*

**含义**：任何让工具集在会话中途变化的方案（动态 `when`、运行时 restrict、按需启用/停用）都会**打断从第一个变动 token 开始的前缀缓存**。一次命中的损失可能吃掉省下的 schema 税。

所以：**静态裁剪优于动态裁剪**。方案 A/B 改一次、之后恒定；C 在"会话开始前就定好"时也是恒定；而"根据上下文中途开关"是净亏。

### 2.7 当前挂载方式：Host 级，所以每个会话都付

`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml:97-113`：

```yaml
- id: dsh-audio
  name: "@local/dsh-audio"
  config: { tts: {...}, check: {...} }
  disabled: false
```

这是 **Host 层**的 `insert`，不是 preset 内声明。Host 插件对所有会话生效，因此"每个会话都要付"成立。`disabled: false` 是现成的、一行就能改的开关（代价见 §3.C）。

---

## 3. 三个方案

估算口径统一为**模型侧载荷**（name + description + parameters），基线 **98.85 KB**。

### A：合并成 8 个 `action` 入口

`audio_daw`（`format`）、`audio_convert`（`op`）已经是这个模式，把同类工具并到一个带判别字段的入口，公共参数（`out`/`seed`/`sampleRate`/`duration`）只声明一次。

#### A-1 合并映射表

| 新入口 | action 取值（原工具） | 原工具数 | 原合计 B | 合并后 B（保留长描述..短描述） |
|---|---|---:|---:|---:|
| `audio_render` | `synth`, `pattern`, `synth_graph`, `design`, `sampler`, `generate` | 6 | 23,191 | 13.07–14.04 KB |
| `audio_music` | `compose`, `midi`, `beats` | 3 | 9,645 | 4.05–5.02 KB |
| `audio_voice` | `tts`, `voices`, `sing`, `lipsync`, `mouth` | 5 | 12,284 | 7.74–8.08 KB |
| `audio_mix` | `mix`, `bus`, `stems`, `spatial` | 4 | 14,309 | 8.78–9.30 KB |
| `audio_master` | `master`, `loudness` | 2 | 7,729 | 4.27–4.37 KB |
| `audio_measure` | `probe`, `analyze`, `check`, `regress` | 4 | 10,800 | 7.53–7.81 KB |
| `audio_edit` | `convert`, `stretch` | 2 | 6,258 | 4.62–4.73 KB |
| `audio_deliver` | `bind`, `react`, `live`, `mux`, `daw` | 5 | 17,005 | 10.52–11.09 KB |
| **合计** | | **31** | **101,221** | **60.58–64.44 KB** |

估算方法：合并后的 `properties` = 各成员参数名的并集（同名只留一条，代表性描述取最短/最长两种极端）；`action` 用成员去掉前缀后的 id 做枚举。范围下界=取最短描述，上界=取最长描述。

**收益：省 34.4–38.3 KB = 35%–39%**。

#### A-2 代价

- **调用方全改**：`test/hardening.mjs` 里有 512 处 `audio_*` 引用（68 处直接 `invoke()`），`test/edge.mjs` 4 处、`test/provider-http.mjs` 1 处。
- **schema 校验变松**：合并后 `additionalProperties: false` 只能拒绝"不属于这个家族"的参数，无法再拒绝"属于别的 action 的参数"。`hardening.mjs` 里大量 `expectError('audio_synth unknown preset', ...)` 这类断言要从"schema 层"降级成"函数内运行时检查"，模型得到的即时反馈也变弱。
- **探索信号变弱**：31 个自解释名字变成 8 个`action` 枚举，模型得先读枚举再回忆每个 action 的参数子集；`audio_synth_graph` 的 DSL 说明也会被挤进同一个入口。
- **文档全改**：README 的 `## 工具` 表、`lib/skill.js` 的 `## 决策` 表都要重写（见 §6）。
- **`presentCall` 标题**：31 个工具各自写好的卡片标题要合并成一个按 `action` 分支的版本。

> 提醒：A 的 60.58 KB 下界**已经假设了每个新入口只写一句短描述**。也就是说 A 本身包含了一部分 B 的工作。A 与 B 是包含关系，不是并列关系。

### B：短描述 + 长说明移到 `animation-sound` skill

思路：schema 留**结构约束**（类型、enum、范围、必填、互斥关系），把**理由、示例、感知解释、坑**搬进 skill（按需加载，不加载不付费）。这正是 DSH 自己的 `tool-design.md` 原则：*"Put parameter rules on the parameter"*（参数规则留在参数上）、*"Start with minimal context"*。

#### B-1 三档压缩的实测收益

| 档位 | 工具描述上限 | 参数描述上限 | 压缩后 | 节省 |
|---|---:|---:|---:|---:|
| 激进 | 120 字符 | 60 字符 | 60.21 KB | **39%**（+折叠预设枚举 → 55.68 KB，**44%**） |
| 中档 | 160 字符 | 90 字符 | 68.88 KB | **30%**（+折叠枚举 → 64.35 KB，**35%**） |
| 轻量 | 200 字符 | 120 字符 | 75.34 KB | **24%**（+折叠枚举 → 70.81 KB，**28%**） |

**"工具描述 ≤120 字符 + 参数描述 ≤60 字符 + 38 预设枚举折叠成一句"** 这一组合实测 **54.93 KB，省 43.92 KB = 44%**。

#### B-2 每个工具的压缩配额（实测，按可省字节降序）

| 工具 | 现在 B | 目标 B | 工具描述字符 | 可省 B |
|---|---:|---:|---:|---:|
| `audio_design` | 7,971 | 3,003 | 645 → 120 | 4,968 |
| `audio_synth_graph` | 5,658 | 936 | **3,648 → 120** | 4,722 |
| `audio_master` | 5,120 | 2,684 | 944 → 120 | 2,436 |
| `audio_analyze` | 4,683 | 2,450 | 487 → 120 | 2,233 |
| `audio_bus` | 6,592 | 4,409 | 889 → 120 | 2,183 |
| `audio_convert` | 4,673 | 2,549 | 872 → 120 | 2,124 |
| `audio_sing` | 4,187 | 2,218 | 806 → 120 | 1,969 |
| `audio_live` | 4,345 | 2,417 | 705 → 120 | 1,928 |
| `audio_daw` | 4,651 | 2,756 | 603 → 120 | 1,895 |
| `audio_mux` | 3,620 | 2,129 | 606 → 120 | 1,491 |
| `audio_sampler` | 3,409 | 1,978 | 519 → 120 | 1,431 |
| `audio_synth` | 2,353 | 970 | 327 → 120 | 1,383 |
| `audio_spatial` | 3,548 | 2,222 | 421 → 120 | 1,326 |
| `audio_loudness` | 2,609 | 1,290 | 612 → 120 | 1,319 |
| `audio_tts` | 2,598 | 1,348 | 533 → 120 | 1,250 |
| `audio_pattern` | 2,969 | 1,725 | 308 → 120 | 1,244 |
| `audio_lipsync` | 2,767 | 1,542 | 479 → 120 | 1,225 |
| `audio_compose` | 3,247 | 2,152 | 342 → 120 | 1,095 |
| `audio_react` | 2,208 | 1,190 | 364 → 120 | 1,018 |
| `audio_check` | 2,644 | 1,645 | 580 → 120 | 999 |
| `audio_beats` | 2,244 | 1,306 | 438 → 120 | 938 |
| `audio_mouth` | 2,447 | 1,509 | 404 → 120 | 938 |
| `audio_midi` | 4,154 | 3,223 | 442 → 120 | 931 |
| `audio_regress` | 2,648 | 1,805 | 282 → 120 | 843 |
| `audio_stems` | 2,409 | 1,569 | 339 → 120 | 840 |
| `audio_stretch` | 1,585 | 953 | 391 → 120 | 632 |
| `audio_mix` | 1,760 | 1,257 | 443 → 120 | 503 |
| `audio_bind` | 2,181 | 1,700 | 303 → 120 | 481 |
| `audio_probe` | 825 | 431 | 486 → 120 | 394 |
| `audio_generate` | 831 | 681 | 260 → 120 | 150 |
| `audio_voices` | 285 | 200 | 207 → 120 | 85 |

> 注：表中"目标 B"是按字符数硬截断的**机械下界估算**，用来定预算。真正落地要人来重写，数字会稍高（不能把 `impact=weighty hit, whoosh=moving air, …` 这种 enum 语义说明截断，那属于结构约束，应当保留或改成 enum 的 `description` 摘要）。

#### B-3 `arguments` 描述怎么处理（这是最贵的一块，48,599 B / 440 条）

按"删掉会怎样"分四类处理，不要一刀切：

| 类别 | 例子 | 处理 |
|---|---|---|
| **结构约束**（必须留，且留在参数上） | `enum`、数值范围 `0..1`、`finite, -120..24`、必填/配对规则 | 留。压到一句话，如 `"0..1 感知旋钮"` |
| **默认值/单位** | `默认 44100`、`单位：秒` | 留一句极短的，如 `"秒；默认 44100"` |
| **跨字段规则** | `offsets`/`gains` 与 `inputs` 同序等长 | 留一行在**被约束的参数**上，或提升到工具描述一句话 |
| **动机/示例/感知解释** | `"This is what turns a set of one-shots into a cue track"`、`"keeps a train from sounding mechanical"`、38 个 preset 的逐条语义 | **搬 skill**。schema 只留 `"预设 id，语义见 animation-sound skill"` |

#### B-4 代价

- 模型必须先 `skill` 一次才能可靠填参数，**首次调用多一轮**；`tool-design.md` 的 "Evaluate total work" 提醒：省 context 若导致更多往返就不划算。
- `audio_synth_graph` 这类"参数本身就是 DSL 文档"的工具，压缩会明显伤可用性——建议它单独不压，或改为 `graph` 参数描述里放图示 + skill 放完整节点表。
- skill 要扩写（现在 14.7 KB 源码，`## 决策` 表已覆盖 31 个工具），属于纯文档工作，无测试风险。

### C：按需启用（拆 bundle / 进 preset）

#### C-1 可行性：两条路，粒度不同

**C-1a 拆成 2–3 个 bundle，各自可 `disabled`**
profile patch 里每个 entry 独立 `disabled:`。拆成 `dsh-audio-core` / `dsh-audio-animation` 后，可以只留 core。
**仍然是 profile 级**——一关就全关，不是按会话。

**C-1b 放进一个 "animation" agent preset（真正的按会话）**
`compositions.md:9` 规定 preset 声明的 `plugins`（必填 Cordis entry 列表）决定这个预设装载什么；`compositions.md:73` 说明 preset 插件贡献 *scoped tools*，且"由选择它的 Agent 共享"。会话选择 `animation` 预设时才装载 audio 插件 → 其他会话**零成本**。

#### C-2 实测收益（按 17/14 二分 bundle）

| 场景 | 装载 | 付费 | 相对基线 |
|---|---|---:|---:|
| 非动画会话 | core（17 工具） | 57.36 KB | **省 42%** |
| 动画会话 | core + animation（31 工具） | 98.85 KB | 0% |
| 非动画会话（12 工具精简 core） | slim core | 40.00 KB | **省 60%** |

**C 的关键性质：它不为动画会话省一个字节。** 它把成本从"所有会话"挪到"真正用音频的会话"。

#### C-3 代价与风险

- **preset 覆盖是整体的**：`compositions.md:51` —— 覆盖 preset 是**替换完整 `config`**，必须把 `id`、`plugins` 及所有字段原样重述。所以自建 `animation` 预设要复刻 shipped `standard` 预设的全部插件清单（bash/fs/pwsh/agent-loop/…），漏一项就是一个残缺会话。**这是 C 最大的坑。**
- **会话不回溯**：`compositions.md:69` —— *"Existing sessions and their children keep the plugin revision they started with."* 已开会话不受影响，必须开新会话验证。
- **用户流程变化**：用户在"做动画"时必须主动选对预设；选错会表现为"工具不见了"，而不是"多花了钱"——错误方向更难自查。
- **打包加权限**：装 bundle 会在 Host 进程跑插件代码，需要 Full access 或审批（`compositions.md:69`）。
- **C-1a 的拆包**不改任何插件代码（只是把 `apply()` 的注册按 config 分组），风险低，但收益仅限 profile 级开关；**最快的零代码版本是直接 `disabled: true`**，省 100%，代价是彻底没有音频能力（连设置页、skill 一起消失）。

---

## 4. 三方案对比表

| 维度 | A 合并 8 入口 | B 短描述 + skill | C 按需启用 |
|---|---|---|---|
| **节省量（实测估算）** | 34.4–38.3 KB（35–39%） | 23.5–43.9 KB（24–44%）<br>典型（中档+折叠枚举）35% | 非动画会话 41.5–58.9 KB（42–60%）<br>动画会话 **0%** |
| **A+B 叠加** | **40.99 KB，省 57.85 KB = 59%**（8 个入口 + 短描述 + 折叠枚举） | | |
| 改动面 | 31 个工具 → 8 个；`lib/tools-*.js` 全面重构 | 只改描述字符串 + skill | 打包/profile/preset，**改 0 行插件代码**（C-1a）；或 1 份 patch（C-1b） |
| 调用方迁移 | 73 处测试调用 + 全部文档 | **0 处** | 0 处 |
| schema 校验严格度 | **变松**（跨 action 参数无法在 schema 层拒绝） | 不变 | 不变 |
| 模型探索成本 | `action` 枚举要先读 | 需先加载 skill（多一轮） | 不变 |
| KV cache 影响 | 一次切换后稳定 | 一次切换后稳定 | 会话开始前定好则稳定；中途开关会砸 |
| 可自动化验证 | 需要新测试 | 需要新预算测试 | 靠 §1.7 脚本量两个 bundle |
| 主要风险 | 行为漂移 + 校验降级 | 首次调用多一轮 + `synth_graph` 可用性 | preset 覆盖不全 → 残缺会话 |
| 工作量（粗估） | 大（重构 + 73 处调用 + 3 份文档） | 中（重写 31 条 + 440 条描述 + skill 扩写） | 小（C-1a ~1 小时；C-1b 半天含验证） |

---

## 5. 推荐路径

### 5.1 结论：**B → C →（按需）A**

理由：

1. **B 的收益与 A 同级，但风险低一个数量级**。B 动 35%（中档）/44%（激进），A 动 35–39%，而 A 要迁 73 处调用、降级校验、重写三份文档。**先做便宜的 35%。**
2. **B 和 C 的文件不重叠，可以并行**。B 改 `lib/tools-*.js` 的描述 + `lib/skill.js`；C 改 profile patch / 新建 preset bundle。两者互不阻塞。
3. **C 解决的正是"最容易被浪费的那部分"**。如果这个 profile 的多数会话不是在配动画（从 lead 的研究任务本身看，很可能如此），C 让这些会话省 42–60%，且插件代码零改动。
4. **A 放到最后，而且要先确认它值得**。A 的额外价值不在字节（B 已经拿了大部分），而在"31 → 8"降低选择歧义。如果实测发现模型经常选错 `audio_mix`/`audio_bus`/`audio_stems`，A 才有独立理由；否则不要为 A 付迁移代价。

### 5.2 建议的执行顺序（含验收点）

| 步 | 动作 | 预计落地 | 验收 |
|---|---|---|---|
| 0 | 先加**预算测试**（§6.4），把当前 98.85 KB 记成基线 | 半天 | 测试跑绿，数字可复现 |
| 1 | **B-1 只折叠预设枚举**（4,775 B，零语义损失） | 1 小时 | 98.85 → 94.1 KB |
| 2 | **B-2 中档压描述**（工具 ≤160 / 参数 ≤90） | 1–2 天 | → 64.35 KB（省 35%） |
| 3 | **B-3 `audio_synth_graph` 单独处理**（3,674 B 的工具描述搬 skill） | 半天 | → 约 60 KB |
| 4 | **C-1a 拆 core/animation 两 entry**（或先直接 `disabled:true` 试水） | 1 小时 | 非动画会话 57.36 KB |
| 5 | **C-1b 建 `animation` preset**（可选，看会话构成） | 半天 + 新会话验证 | 非动画会话 40 KB |
| 6 | 复盘：若仍嫌大或有选错工具的证据，再做 A | — | A+B 目标 41 KB |

**任意一步之后的稳定态目标**：B 完成 ≈ 60 KB（约 1.5 万 token）；B+C ≈ 非动画 40 KB / 动画 60 KB；A+B ≈ 41 KB（约 1 万 token）。

### 5.3 明确不推荐

- **不要为省字节删 `isConcurrencySafe` / `output.schema`**：它们不上线（§2.1），删了只损失功能。
- **不要用动态 `when` 或运行时 `restrict` 做"按需"**：`restrict` 从 `apply()` 调不动（会抛错，§2.2），且动态改变工具集砸 KV cache（§2.6）。
- **不要只压 schema 结构**（改类型、拆 properties）：结构只占 35.3%，能压的空间极小，还会削掉 `additionalProperties:false` 的保护。

---

## 6. 需要改的测试

### 6.1 `test/docs-consistency.mjs`（**硬失败**，最容易被方案打断）

现状：跑绿（19 个文档调用点、64 个参数键、0 硬失配、0 建议缺口）。它把 `README.md`、`lib/skill.js`、`index.js` 的 `PROMPT_SECTION` 当真相源核对：

- `:338` 文档提到未注册的 `audio_*` → **fail**
- `:344-354` README 必须有 `## 工具` 表，且**每个工具都要在表里**（漏一个 → fail，`:382`）
- `:356-366` `lib/skill.js` 必须有 `## 决策` 表，且**每个工具都要在表里** → fail
- `:369-379` `PROMPT_SECTION` 缺工具只是 **advisory gap**，不 fail

| 方案 | 要改什么 |
|---|---|
| **B** | **不用改**。描述变了不影响它——它校验参数**键**，不校验描述文本。（前提：保留每个工具的必填参数名。） |
| **A** | 必须成组改：README `## 工具` 表、`lib/skill.js` `## 决策` 表改成 8 个新入口 + 每个入口的 action 子表；`index.js` `PROMPT_SECTION` 33 处工具名（advisory 但会污染报告）；文档里的 `audio_x({...})` 调用点要加上 `action:`。 |
| **C** | 若两个 bundle 的注册是同一份 `apply()` 按 config 分叉，测试的 fake ctx 需要传不同的 config 来覆盖两种模式，否则只测到一种。 |

### 6.2 `test/hardening.mjs`（工具集断言 + 调用矩阵）

- `:341-351` **硬编码 `EXPECTED` 18 个工具名**（`primary` 注册的那批），多一个/少一个都 `bug()`。**A 必须改这张表。**
- `:355-362` 逐工具校验形状：`execute` 是函数、`parameters.type === 'object'`、`additionalProperties === false`、`output.render` 是函数、`isConcurrencySafe === true`、`presentCall` 建议有。**合并后的工具必须继续满足这些**（注意 `additionalProperties:false` 在合并后语义变松，测试仍会绿，但保护已降级——建议加一条"每个 action 的合法参数子集"测试补回来）。
- `:370+` 起是 68 处 `invoke('audio_x', …)` 与大量 `expectError('…', 'audio_x', …)` 的坏参数矩阵。**A 要逐个改成带 `action` 的形状。**
- **B 不需要改**（描述文本不被断言）。

### 6.3 `test/tools-test.mjs`

- `:66` **`check('seven tools', registered.size === 7)`** —— 这里只注册 `registerTools` + voices + tts + check。**A 会把 `registerTools` 从 4 个合成 1–2 个，这个 `7` 必须改。**
- `:70,77,86,93,94,105,119,141` 等处按名字调用 `audio_synth`/`audio_check`/`audio_tts`/`audio_voices`。**A 要改。B 不用改。**

### 6.4 `tools/test-all.mjs`（套件入口）

- **不需要改**：它按固定规则发现 `test/*.mjs`，新增文件自动纳入套件。
- 但它有一条重要约束：*"每个可执行文件都必须自己打印 `OK:` 或 `SKIP:`，否则算失败"*。新增预算测试必须遵守。
- **建议新增 `test/schema-budget.mjs`**（这是最该补的测试，也是 `tool-design.md` 说的 *"Measure the change"*）：
  - 用 §1.7 的 fake ctx 载入 `apply()`；
  - 断言**模型侧载荷**（只算 name + description + parameters，**排除** `output`/`isConcurrencySafe`）不超过预算；
  - 断言单个工具不超过单工具预算（例如 6 KB）；
  - 断言 38 预设枚举只出现在 ≤1 处；
  - 打印 Top 5 以便 review。建议预算：起始 100 KB，B 完成后收紧到 65 KB，B+C 后 45 KB。
  - 这样后续任何人加一个"描述写很长"的工具都会被 CI 拦住。

### 6.5 其他

- `test/edge.mjs`（4 处）、`test/provider-http.mjs`（1 处）、`tools/probe-minimax.mjs`（1 处）：**仅 A 需要改**。
- `test/generate.mjs:664` 断言 `tool.description.split('\n').length <= 2`：**B 安全**（短描述仍是单行）；A 若合并后写多行会触发。
- `client.js`（46 KB）和 `locale/*.json` 对 `audio_*` 工具名**零引用**，A/B/C 都不影响 UI 本地化。`docs/DETAIL.zh.md` 有 4 处工具名，A 要同步。

---

## 7. 风险汇总

| 风险 | 方案 | 严重度 | 缓解 |
|---|---|---|---|
| 合并后 schema 无法拒绝"跨 action 的错参数"，错误延后到运行时 | A | 中 | 保留 `additionalProperties:false`；对每个 action 加参数子集测试；错误信息里点名 action |
| 31→8 后模型选错 action（`mix`/`bus`/`stems` 尤其近） | A | 中 | 先做 A 前后各跑一轮真实动画会话对比；或只合最安全的组（`edit`/`master`/`measure`），保留 `mix` 系三个名字 |
| 描述压太狠，模型填错参数 → 多轮往返，反而更贵 | B | 中 | 分档落地（中档先上）；结构约束（enum/范围/必填）一律留在 schema；用 §6.4 预算测试 + 实跑一轮对照 |
| `audio_synth_graph` 的 DSL 文档搬走后该工具变难用 | B | 中 | 该工具单独不压，或把节点表做成 skill 里可快速检索的一节 |
| 自建 `animation` preset 漏装插件 → 残缺会话 | C-1b | **高** | 必须原样复刻 shipped `standard` 的 `plugins` 全表（`compositions.md:51`），装完 `plugin_manager list_plugins` 核对，且**开新会话**验证 |
| 用户忘了选预设，表现为"工具不见了"而非"多花了钱" | C | 中 | 在 preset 的 `description` 里写明用途；保留 core 工具在默认预设里 |
| 动态开关砸 KV cache，省下的税被缓存失效吃掉 | 任意"按需"变体 | **高** | 只在会话/请求开始前决定工具集，**不要**中途 `when` 翻转 |
| 文档与代码不同步，`docs-consistency` 变红 | A、C | 中 | 每步改完立刻 `node test/docs-consistency.mjs`（当前 0 硬失配，任何红都是新引入的） |
| 只读 → 改动的边界：本次研究未改任何代码 | — | — | 本文是唯一新增文件 |

---

## 附：一句话给决策者

工具 schema 的 98.85 KB 里 **64.7% 是叙述性文字**，其中 4.7 KB 还是同一个预设枚举抄了 11 遍。**先花 1 小时把枚举折叠、再花两天把描述压到中档**，就能拿 35%，且不碰任何调用方；**再花 1 小时把 profile 里的 audio 拆成可开关的 entry**，非动画会话即可再省到 60% 以下。把"合并成 8 个 action 入口"留到有证据表明 31 个名字导致了选错工具时再做——它的字节收益和"写短一点"差不多，但迁移代价高一个数量级。
