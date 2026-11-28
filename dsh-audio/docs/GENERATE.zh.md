# 接入外部纯音频生成模型（audio_generate）

`dsh-audiokit` 提供一个**可选**后端：把一句 prompt 发给用户自己配置的纯音频生成
服务（Stable Audio、AudioGen、自建服务、或任何兼容 OpenAI 音频生成形状的端点），拿回
wav 字节、落盘、返回度量。

设计前提有两条，先写在最前面：

1. **默认关闭、默认不联网。** 不配置 `config.generate` 就没有任何请求发生；插件仍然只有
   `node:` 内置依赖。
2. **不保证确定性。** 远程模型的同一条 prompt 两次可能给出完全不同的音频。返回里固定带
   `effective.deterministic: false`，默认文件名是**收到字节的内容哈希**而不是 prompt 的
   哈希——所以重跑不会覆盖上一版，两版会并存。

本文档只讲这个可选后端；合成、混音、测量等离线能力不受影响。

---

## 1. 配置

插件配置里新增 `generate` 段（与 `tts`、`check` 同级）。写进 `cordis.patch.yml` 的插件
`config`，或用你 profile 里对应的插件配置：

```yaml
- insert:
    - id: dsh-audio
      name: dsh-audiokit
      config:
        generate:
          provider: openai-audio        # openai-audio | custom | none
          baseUrl: https://api.example.com
          model: stable-audio-open-1.0  # 可选；留空则请求里不带 model
          apiKeyEnv: AUDIO_GENERATE_API_KEY
          # apiKey: ''                  # 不建议：优先用环境变量
          # timeoutMs: 120000           # 可选，默认 120000（100..600000）
          # maxBytes: 33554432          # 可选，默认 32 MB（1024..536870912）
```

字段说明：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `openai-audio` | `openai-audio`：把 `baseUrl` 当服务根地址，自动拼 `/v1/audio/generations`；`custom`：`baseUrl` 就是完整 endpoint，原样 POST；`none`：显式关闭 |
| `baseUrl` | 空 | 必填（除非 `provider: none`），结尾的 `/` 会被去掉 |
| `apiKey` | 空 | 明文密钥；写入插件配置，谨慎使用 |
| `apiKeyEnv` | `AUDIO_GENERATE_API_KEY` | 从哪个环境变量读密钥；显式写成空字符串 `''` 表示**禁用环境变量回退**，只用 `apiKey` |
| `model` | 空 | 请求体里的 `model`；留空时 JSON 里不出现该字段 |
| `timeoutMs` | `120000` | 单次请求的总超时（连接 + 响应头 + 读完 body），范围 100–600000 |
| `maxBytes` | `33554432`（32 MB） | 响应字节上限，范围 1 KB–512 MB；先看 `Content-Length`，再在流式读取时累加 |

环境变量（配置优先，环境变量兜底）：

| 变量 | 作用 |
| --- | --- |
| `AUDIO_GENERATE_API_KEY` | 密钥；`apiKeyEnv` 默认就是它 |
| `AUDIO_GENERATE_BASE_URL` | 端点 URL；`config.generate.baseUrl` 为空时使用 |

最小可用配置（只设环境变量，不动 YAML）：

```bash
# Linux / macOS
export AUDIO_GENERATE_BASE_URL="https://api.example.com"
export AUDIO_GENERATE_API_KEY="sk-..."

# Windows PowerShell
$env:AUDIO_GENERATE_BASE_URL = "https://api.example.com"
$env:AUDIO_GENERATE_API_KEY  = "sk-..."
```

自建服务不需要鉴权时，也得给一个任意非空密钥（`apiKey: "local"` 或环境变量里随便填）：
本后端把「没有密钥」当作配置不完整，直接拒绝，不会静默发匿名请求。

---

## 2. 两种 provider 的请求 / 响应约定

共同部分：

- 方法：`POST`
- 请求头：`Content-Type: application/json`、`Accept: audio/wav, application/json`、
  `Authorization: Bearer <key>`
- 请求体：

  ```json
  { "model": "stable-audio-open-1.0", "prompt": "rain on a tin roof", "duration": 5, "response_format": "wav" }
  ```

  `model` 只在配置或工具参数给了值的时候出现；`duration` 单位秒；`response_format` 固定 `wav`。

### 2.1 `openai-audio`

```text
POST {baseUrl 去掉结尾斜杠}/v1/audio/generations
```

例：`baseUrl: https://api.example.com` → `https://api.example.com/v1/audio/generations`。

如果你的服务挂在带路径的前缀下（例如 `https://host/api`），`openai-audio` 会拼成
`https://host/api/v1/audio/generations`；若服务路径形状不同，用 `custom` 直接给完整地址。

### 2.2 `custom`

```text
POST {baseUrl 原样}
```

例：`baseUrl: https://api.example.com/generate/audio` → 直接 POST 到该地址。适合自建服务、
反向代理、带自定义路径的网关。

### 2.3 响应（两种 provider 相同）

接受两类响应：

**A. 二进制 wav**

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Content-Length: 1234567

<RIFF....WAVE....>
```

**B. JSON + base64**（`application/json`，或 body 第一个非空白字节是 `{`）

```json
{ "data": [ { "b64_json": "UklGRi..." } ] }
```

```json
{ "audio_base64": "UklGRi..." }
```

也接受带 data URI 前缀的 base64（`data:audio/wav;base64,...`）。

判定顺序（服务端返回不合规时会看到对应错误码）：

1. HTTP 非 2xx → 读一小段响应体作为说明，报 `http-4xx` / `http-5xx`。
2. `Content-Type` 是 `text/html`（或其它 `text/*` 且不是 JSON）→ `bad-response`，防止把
   HTTP 200 的登录页 / 网关错误页当成音频落盘。
3. 按 `Content-Length` 预检、再流式累加，超过 `maxBytes` → `too-large`。
4. JSON 或二进制二选一解析；空 body → `bad-response`；JSON 里找不到音频 →
   `bad-response`（会带上服务端 `error.message`）。
5. 最终字节必须能解析出合法的 RIFF/WAVE 头和 `data` 块（8/16/24/32 bit PCM 或 32-bit
   float），否则 → `not-wav`。**本后端只接受 wav，不做 mp3/flac 转码**（保持零依赖）。

成功的字节会**原样落盘**，不重新编码、不改采样率/位深/声道数——写出的文件就是服务返回的
那个文件。度量（时长/峰值/RMS 等）从落盘后的文件解码得出。

---

## 3. `audio_generate` 工具

参数（schema 只有 5 个字段，且只要求 `prompt`）：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 生成描述，≤ 1000 字符 |
| `duration` | 否 | 秒，1–60，默认 5 |
| `model` | 否 | 覆盖配置里的 `model` |
| `out` | 否 | 输出路径；默认 `assets/audio/generate-<内容哈希前12位>.wav` |
| `provider` | 否 | 覆盖配置里的 `openai-audio` / `custom` |

示例：

```json
{ "prompt": "heavy metal door slamming in a large hall, tail 2s", "duration": 3 }
```

返回（节选）：

```json
{
  "path": "<cwd>/assets/audio/generate-f2b83bc44e21.wav",
  "relativePath": "assets/audio/generate-f2b83bc44e21.wav",
  "bytes": 17684,
  "durationSeconds": 3.0,
  "sampleRate": 48000,
  "metrics": { "peakDbfs": -1, "rmsDbfs": -14.2, "centroidHz": 1800 },
  "effective": {
    "provider": "openai-audio",
    "host": "api.example.com",
    "model": "stable-audio-open-1.0",
    "responseFormat": "wav",
    "remote": true,
    "deterministic": false
  }
}
```

`out` 的扩展名会被规整为 `.wav`：给 `.mp3` 会替换成 `.wav`，完全不给扩展名会补 `.wav`。
工具失败时抛出的错误消息里带 `(reasonCode)`，同时错误对象上保留 `reasonCode`（部分还带
`status`、`envName`），便于上层区分「没配置」和「服务端拒绝」。

拿到文件后可以继续用现有工具：`audio_probe`（测量）、`audio_analyze`（分析音色）、
`audio_convert`（剪裁/转格式）、`audio_bind`（放进动画）、`audio_mix`（混音）等。

---

## 4. 错误码

| `reasonCode` | 含义 | 常见修法 |
| --- | --- | --- |
| `missing-key` | 没有密钥：配置里没有，环境变量也为空 | 设 `AUDIO_GENERATE_API_KEY` 或 `config.generate.apiKey` |
| `no-base-url` | 没配端点，或 URL 不是合法 http(s) | 设 `baseUrl` / `AUDIO_GENERATE_BASE_URL`，检查协议与拼写 |
| `provider-none` | 显式关闭（`provider: none`） | 想用就改回 `openai-audio` / `custom` |
| `unsupported-target` | `provider` 名字不认识 | 只能是 `openai-audio` / `custom`（或 `none`） |
| `endpoint-unreachable` | DNS/TLS/连接被拒/网络错误 | 检查域名、网络、代理；`curl` 同一地址先验证 |
| `http-4xx` | 服务端拒绝：密钥错、模型名错、参数不合规 | 看消息里 HTTP 状态与响应体片段 |
| `http-5xx` | 服务端自己失败 | 稍后重试或联系服务方；本后端不自动重试 |
| `timeout` | `timeoutMs` 内没拿到完整响应 | 慢模型调大 `timeoutMs`（上限 600000 ms） |
| `too-large` | 响应超过 `maxBytes` | 缩短 `duration`，或按需调大 `maxBytes`（注意内存） |
| `bad-response` | 2xx 但不是音频/JSON 约定：如 HTML、空 body、JSON 无音频字段 | 检查是否被代理/登录页拦截；核对响应格式 |
| `not-wav` | 返回了音频但不是可解析的 wav（例如 mp3） | 让服务返回 wav，或先用别的链路转成 wav |

错误消息是中文，会写出具体要改的字段名；错误码适合程序判断，消息适合人读。

---

## 5. 诚实的限制

- **必须联网。** 这是唯一需要网络的工具路径；没有配置、断网、服务失败时不会回退到本地
  合成，工具直接报错。
- **不保证确定性。** 相同 prompt 两次可能不同；`effective.deterministic` 恒为 `false`。
  默认按内容哈希命名，因此重复生成会产生新文件，不会静默覆盖旧文件。想在动画里固定某个
  版本，请把生成好的 wav 当普通素材引用。
- **只接受 wav。** 不内置转码器（零依赖），服务返回 mp3/flac 会被 `not-wav` 拒绝。
- **32 MB 默认上限。** 超限在读完前中止（先看 `Content-Length`，chunked 响应边读边算）。
  调大 `maxBytes` 时注意：落盘后的度量需要把整段音频解码进内存，峰值约为文件大小的数倍。
- **超时只覆盖单次 HTTP 请求。** 模型排队时间也算在 `timeoutMs` 里，慢服务请显式调大。
- **没有重试、没有幂等键、没有并发去重。** 每次调用就是一次独立请求；`isConcurrencySafe`
  只表示工具之间可并发，服务端是否排队由服务决定。
- **密钥安全。** 推荐用环境变量或 `apiKeyEnv`，不要把密钥写进提交到仓库的 YAML；错误与
  日志只打印 host 和状态，不打印密钥，但 `config.generate.apiKey` 本身是明文配置。
- **不代理、不注入自定义 header。** 需要网关签名、代理认证或特殊请求头时，用 `custom`
  指向你自己的本地网关，由网关去对接上游。
- **内容责任在服务端与使用者。** prompt 原样发送，本插件不做内容审查、不做版权检查、
  不保证生成结果可用。
- **没有设置页。** 与 `tts` / `check` 不同，这一项只通过插件配置（YAML）与环境变量配置，
  设置页不暴露该段（避免把密钥写进浏览器存储）。

---

## 6. 示例 curl

验证配置的最快方式——两个请求应该返回可播放的 wav（或约定 JSON）：

```bash
# openai-audio 形状
curl -sS -X POST "https://api.example.com/v1/audio/generations" \
  -H "Authorization: Bearer $AUDIO_GENERATE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: audio/wav, application/json" \
  -d '{"model":"stable-audio-open-1.0","prompt":"rain on a tin roof","duration":5,"response_format":"wav"}' \
  -o out.wav

# custom 形状（完整 endpoint）
curl -sS -X POST "https://api.example.com/generate/audio" \
  -H "Authorization: Bearer $AUDIO_GENERATE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"rain on a tin roof","duration":5,"response_format":"wav"}' \
  -o out.wav

# 确认拿到的是 wav 而不是网页
head -c 4 out.wav   # 期望输出 RIFF
```

如果 curl 拿到的是 HTML（登录页、网关错误页），工具会明确报 `bad-response`；这时应修
端点/网关，而不是调插件参数。

---

## 7. 排查清单

1. **报 `missing-key`**：检查 `config.generate.apiKey` 或 `AUDIO_GENERATE_API_KEY` 是否在
   **启动 DSH 的环境**里（改完环境变量要重启进程）。`apiKeyEnv: ''` 会禁用回退。
2. **报 `no-base-url`**：`baseUrl` 是否为空；`openai-audio` 是否误把完整 endpoint 填进了
   `baseUrl`；`custom` 是否漏了路径。
3. **报 `http-4xx`**：先看消息里的响应体；常见是模型名、密钥、`duration` 不被服务接受。
4. **报 `not-wav`**：服务返回了 mp3/ogg，或返回 200 但内容不是音频；先按第 6 节 curl 验证。
5. **报 `timeout`**：模型冷启动/排队慢；调大 `timeoutMs`，并确认本机出网没有被代理拖慢。
6. **报 `too-large`**：缩短 `duration` 或换采样率更低的输出；确认服务没有返回巨大的错误页。

## 8. 测试

新增逻辑自带一套本地回环测试，不需要网络、不需要密钥：

```bash
node test/generate.mjs
```

它用 `node:http` 起一个假端点，覆盖二进制 wav、base64 JSON、`text/html` 200、超限
（`Content-Length` 与 chunked 两种）、404/500、超时、未配置密钥、工具层参数校验，并用
`decodeWav` 验证落盘文件能读回。现有 `node test/provider-http.mjs` 不受影响。

局限：这些测试证明的是「插件按文档约定的形状收发」，不能证明某个真实厂商端点的字段名与
路径完全一致——那需要一次带真实密钥的真调用。
