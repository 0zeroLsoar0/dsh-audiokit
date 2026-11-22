/**
 * User-visible copy of the dsh-audiokit settings page, in Chinese and English.
 *
 * This file is the editable source of truth. It cannot be imported by the page
 * at runtime: DSH serves a hand-written client bundle as one classic browser
 * script, and the client module table only resolves platform seeds and
 * registered package factories — no relative ES-module imports (see
 * `dsh-client-modules/src/client/system.ts`: the synchronous `require` checks
 * the seed table, materialized records and registered factories; relative
 * requests exist only as `require.async` chunks, which need a package-root
 * `client.<name>.js` and a package.json `files` entry). `client.js` therefore
 * carries the same two dictionaries as one generated, ASCII-escaped literal.
 * `test/client-locale.mjs` fails when that copy and this file disagree; after
 * editing a string here, run `node test/client-locale.mjs --write` to refresh
 * the copy inside `client.js`.
 *
 * Keys are grouped by surface (`page.*`, `field.*`, `provider.*`, `tts.*`,
 * `check.*`, `status.*`, `error.*`, `reason.*`, `buttons.*`, `note.*`). The
 * Chinese values are the page's original wording, character for character.
 * `reason.*` is special: one key per value of `REASON_CODES` in
 * `lib/settings-route.js`, the machine-readable failure code the host route
 * sends, so the page can show a provider/environment failure in the reader's
 * language instead of pasting the server's Chinese sentence into it.
 * Placeholders use the host's `{name}` form, so one template syntax serves both
 * this helper and the Client locale service.
 *
 * Values must stay free of apostrophes, backslashes and newlines: the copy
 * embedded in `client.js` is a single-quoted JavaScript literal, and the test
 * rejects anything that would need another escaping rule.
 */

/** Namespace this plugin registers with the Client locale service. */
export const NS = 'dsh.audio'

/** Chinese copy — the language the settings page shipped in. */
export const zh = {
  /* ---- page chrome ---- */
  'page.title': '声音',
  'page.subtitle': '合成、混音、音频检查的技术部分不需要密钥；这里配置旁白（TTS）和语义检查所用的服务。',

  /* ---- repeated field labels ---- */
  'field.provider': '供应商',
  'field.baseUrl': '接口地址',
  'field.model': '模型',
  'field.voice': '音色',
  'field.speed': '语速',
  'field.pitch': '音调',
  'field.ffmpeg': 'ffmpeg',
  'field.apiKey': 'API 密钥',

  /* ---- provider dropdown options ---- */
  'provider.minimax': 'MiniMax',
  'provider.edge': 'Edge 朗读（免费，无需密钥）',
  'provider.openai': 'OpenAI 兼容',
  'provider.custom': '自定义端点（OpenAI 兼容）',
  'provider.none': '关闭',

  /* ---- narration (TTS) section ---- */
  'tts.sectionTitle': '旁白 · TTS',
  'tts.baseUrlPlaceholder': 'https://api.minimax.chat',
  'tts.modelDesc': 'speech-2.8-hd 自动情感；speech-2.6-hd 支持手动情感',
  'tts.modelPlaceholder': 'speech-2.8-hd',
  'tts.voiceDescLive': '实时列表：{count} 个音色，来自当前账号',
  'tts.voiceDescStatic': '静态名单，未联网校验；配置密钥后自动换成账号的实时列表',
  'tts.voicePlaceholder': '也可以直接填音色 id',
  'tts.voiceNone': '（无可用音色）',
  'tts.speedDesc': '0.5 – 2.0',
  'tts.pitchDesc': '半音，−12 – 12',
  'tts.ffmpegDesc': '仅 Edge 需要：它只提供压缩音频，用本机 ffmpeg 解码成波形。留空自动探测 ~/.dsh/tools/ffmpeg',
  'tts.ffmpegPlaceholder': '留空 = 自动探测',
  'tts.keyStored': '已保存密钥；留空保持不变',
  'tts.keyEnvDetected': '留空则读环境变量 {env}（已检测到）',
  'tts.keyEnvMissing': '留空则读环境变量 {env}（未检测到）',
  'tts.keyPlaceholder': '留空则不修改',
  'tts.testRow': '测试连接',
  'tts.testDesc': '合成一句话并试听，用来确认密钥、模型、音色都对',
  'tts.testAction': '合成并试听',
  'tts.testOk': '成功：{seconds}s · {model} · {voice}',
  'tts.testNoTimestamps': '无时间戳',
  'tts.testTimestamps': '时间戳 {count} 条',

  /* ---- audio check (semantic layer) section ---- */
  'check.sectionTitle': '音频检查 · 语义层（可选）',
  'check.sectionDesc': 'MiniMax 没有音频理解接口，这里使用 OpenAI 兼容的 input_audio 端点（Qwen-Omni 等）。不填则只跑技术检查。',
  'check.testRow': '测试识别',
  'check.testDesc': '送一段铃声给模型，看它能不能描述出来',
  'check.testAction': '试听并识别',
  'check.testOk': '成功：{answer}',
  'check.selfCheckRow': '模型自检（实验性）',
  'check.selfCheckDesc': '默认关闭。开启后每次保存都会用真实音频问模型一次，并显示端点状态、HTTP 状态与耗时；也可以点右边按钮立即校验。只校验已保存的配置。',
  'check.selfCheckOff': '关闭（默认）',
  'check.selfCheckOn': '保存后自动校验',
  'check.validateAction': '立即校验',

  /* ---- status lines and check results ---- */
  'status.loading': '读取中…',
  'status.savedWaiting': '已保存，等待插件重启…',
  'status.applied': '已生效',
  'status.restartTimeout': '已保存，但页面没等到插件重启；刷新一下确认',
  'status.endpointReachable': '端点可达（HTTP {status}）',
  'status.endpointUnreachable': '端点不可达：{error}',
  'status.endpointNotApplicable': '端点探测不适用：{reason}',
  'status.audioAccepted': '模型接受音频输入（{ms} ms）',
  'status.audioRejected': '模型未通过：{error}',
  'status.answer': '回答：{answer}',
  'status.noModel': '未填模型',

  /* ---- errors ---- */
  'error.loadFailed': '读取失败：{error}',
  'error.httpNotReady': '接口还没就绪（HTTP {status}）',
  'error.httpNotJson': '接口返回的不是 JSON（HTTP {status}）',
  'error.saveFailed': '保存失败',
  'error.testFailed': '测试失败',
  'error.testFail': '失败：{error}',
  'error.unknownReason': '未知原因',
  'error.validateFailed': '校验失败：{error}',

  /* ---- server failure reasons, one per REASON_CODES entry ---- */
  'reason.missing-key': '缺少 API 密钥（{env}）',
  'reason.endpoint-unreachable': '连接失败',
  'reason.http-4xx': '供应商拒绝了请求（HTTP {status}）',
  'reason.http-5xx': '供应商服务出错（HTTP {status}）',
  'reason.not-audio': '供应商返回的内容不可用',
  'reason.no-base-url': '没有可用的接口地址',
  'reason.provider-none': '旁白已关闭（provider = none）',
  'reason.decoder-missing': '缺少解码器（Edge 需要 ffmpeg）',
  'reason.unsupported-target': '不支持的目标（{target}）',


  /* ---- buttons ---- */
  'buttons.save': '保存',
  'buttons.saving': '保存中…',
  'buttons.reload': '重新读取',
  'buttons.retry': '重试',
  'buttons.testing': '测试中…',
  'buttons.validating': '校验中…',

  /* ---- misc ---- */
  'note.select': '请选择'
}

/** English copy — short labels and plain wording, so the rows keep their shape. */
export const en = {
  /* ---- page chrome ---- */
  'page.title': 'Sound',
  'page.subtitle': 'The technical side — synthesis, mixing and audio checks — needs no key; configure the services used for narration (TTS) and semantic checks here.',

  /* ---- repeated field labels ---- */
  'field.provider': 'Provider',
  'field.baseUrl': 'Endpoint',
  'field.model': 'Model',
  'field.voice': 'Voice',
  'field.speed': 'Speed',
  'field.pitch': 'Pitch',
  'field.ffmpeg': 'ffmpeg',
  'field.apiKey': 'API key',

  /* ---- provider dropdown options ---- */
  'provider.minimax': 'MiniMax',
  'provider.edge': 'Edge Speech (free, no key)',
  'provider.openai': 'OpenAI-compatible',
  'provider.custom': 'Custom endpoint (OpenAI-compatible)',
  'provider.none': 'Off',

  /* ---- narration (TTS) section ---- */
  'tts.sectionTitle': 'Narration · TTS',
  'tts.baseUrlPlaceholder': 'https://api.minimax.chat',
  'tts.modelDesc': 'speech-2.8-hd picks the emotion itself; speech-2.6-hd accepts a manual emotion',
  'tts.modelPlaceholder': 'speech-2.8-hd',
  'tts.voiceDescLive': 'Live list: {count} voices from this account',
  'tts.voiceDescStatic': 'Static list, not verified online; add a key to load the account voice list',
  'tts.voicePlaceholder': 'Or type a voice id',
  'tts.voiceNone': '(no voices available)',
  'tts.speedDesc': '0.5 – 2.0',
  'tts.pitchDesc': 'Semitones, −12 – 12',
  'tts.ffmpegDesc': 'Edge only: it returns compressed audio, decoded to a waveform by a local ffmpeg. Empty auto-detects ~/.dsh/tools/ffmpeg',
  'tts.ffmpegPlaceholder': 'Empty = auto-detect',
  'tts.keyStored': 'A key is stored; leave empty to keep it',
  'tts.keyEnvDetected': 'Leave empty to read the {env} environment variable (detected)',
  'tts.keyEnvMissing': 'Leave empty to read the {env} environment variable (not detected)',
  'tts.keyPlaceholder': 'Leave empty to keep the stored key',
  'tts.testRow': 'Test connection',
  'tts.testDesc': 'Synthesize one sentence and play it back to confirm the key, model and voice',
  'tts.testAction': 'Synthesize & listen',
  'tts.testOk': 'OK: {seconds}s · {model} · {voice}',
  'tts.testNoTimestamps': 'no timestamps',
  'tts.testTimestamps': '{count} timestamps',

  /* ---- audio check (semantic layer) section ---- */
  'check.sectionTitle': 'Audio check · semantic layer (optional)',
  'check.sectionDesc': 'MiniMax has no audio-understanding endpoint, so this uses an OpenAI-compatible input_audio endpoint (Qwen-Omni and similar). Leave empty to run technical checks only.',
  'check.testRow': 'Test recognition',
  'check.testDesc': 'Send a chime to the model and see whether it can describe it',
  'check.testAction': 'Listen & identify',
  'check.testOk': 'OK: {answer}',
  'check.selfCheckRow': 'Model self-check (experimental)',
  'check.selfCheckDesc': 'Off by default. When on, every save asks the model one real-audio question and reports endpoint status, HTTP status and latency; the button on the right validates immediately. Only the saved config is checked.',
  'check.selfCheckOff': 'Off (default)',
  'check.selfCheckOn': 'Validate on save',
  'check.validateAction': 'Validate now',

  /* ---- status lines and check results ---- */
  'status.loading': 'Loading…',
  'status.savedWaiting': 'Saved, waiting for the plugin to restart…',
  'status.applied': 'Applied',
  'status.restartTimeout': 'Saved, but the page never saw the plugin restart; refresh to confirm',
  'status.endpointReachable': 'Endpoint reachable (HTTP {status})',
  'status.endpointUnreachable': 'Endpoint unreachable: {error}',
  'status.endpointNotApplicable': 'Endpoint probe not applicable: {reason}',
  'status.audioAccepted': 'Model accepted the audio input ({ms} ms)',
  'status.audioRejected': 'Model failed: {error}',
  'status.answer': 'Answer: {answer}',
  'status.noModel': 'no model set',

  /* ---- errors ---- */
  'error.loadFailed': 'Failed to load: {error}',
  'error.httpNotReady': 'Endpoint not ready yet (HTTP {status})',
  'error.httpNotJson': 'The endpoint returned no JSON (HTTP {status})',
  'error.saveFailed': 'Save failed',
  'error.testFailed': 'Test failed',
  'error.testFail': 'Failed: {error}',
  'error.unknownReason': 'unknown reason',
  'error.validateFailed': 'Validation failed: {error}',

  /* ---- server failure reasons, one per REASON_CODES entry ---- */
  'reason.missing-key': 'missing API key ({env})',
  'reason.endpoint-unreachable': 'connection failed',
  'reason.http-4xx': 'provider rejected the request (HTTP {status})',
  'reason.http-5xx': 'provider service error (HTTP {status})',
  'reason.not-audio': 'provider returned no usable content',
  'reason.no-base-url': 'no usable endpoint URL',
  'reason.provider-none': 'narration is off (provider = none)',
  'reason.decoder-missing': 'decoder missing (Edge needs ffmpeg)',
  'reason.unsupported-target': 'unsupported target ({target})',

  /* ---- buttons ---- */
  'buttons.save': 'Save',
  'buttons.saving': 'Saving…',
  'buttons.reload': 'Reload',
  'buttons.retry': 'Retry',
  'buttons.testing': 'Testing…',
  'buttons.validating': 'Validating…',

  /* ---- misc ---- */
  'note.select': 'Select'
}

/** Both dictionaries, keyed by locale id (the client service consumes this shape). */
export const DICT = { zh, en }

/**
 * Translate one key, the same way the Client locale service does it: look up
 * the requested locale, fall back to the Chinese wording, then to the key.
 * `{name}` placeholders are filled from `vars`; an unknown or undefined name is
 * left as written, so a missing variable never prints as `undefined`.
 *
 * @param {string} key - dictionary key, e.g. `tts.testOk`.
 * @param {Record<string, unknown>} [vars] - placeholder values.
 * @param {string} [locale] - locale id; anything unknown reads Chinese.
 * @returns {string} the rendered text, never `undefined`.
 */
export function t (key, vars, locale = 'zh') {
  const table = DICT[locale] ?? DICT.zh
  const template = table[key] ?? DICT.zh[key] ?? key
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
}
