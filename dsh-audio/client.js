/**
 * Settings page for dsh-audiokit.
 *
 * Styled with the host theme tokens (`--dsw-alias-*`) so it reads as part of
 * DSH's own settings rather than a foreign panel: plain rows separated by
 * borders, label + description on the left, control on the right.
 *
 * Localized through the Client locale service (`ctx.get('locale')`): the
 * Chinese and English dictionaries are registered in `apply`, the page follows
 * a language switch live, and a composition without that service simply keeps
 * rendering the Chinese copy — i18n is never a render dependency.
 *
 * Extras beyond the form:
 *   - "测试连接" really calls the provider and plays back what it produced, so a
 *     key can be judged without leaving Settings;
 *   - the voice list asks MiniMax for the account's real voices when a key is
 *     configured, and falls back to a shortlist explicitly marked as unverified.
 */
window.__ModuleLoader__.load({
  id: 'dsh-audiokit',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    const TOKEN = {
      bg: 'var(--dsw-alias-bg-layer-1, transparent)',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16))',
      overlay: 'var(--dsw-alias-bg-overlay, #1b2740)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.8))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #e5484d)',
      success: 'var(--dsw-alias-state-success-primary, #30a46c)'
    }

    const S = {
      page: { padding: '2px 2px 40px', maxWidth: 780, color: TOKEN.text, fontSize: 13, lineHeight: 1.65 },
      header: { margin: '0 0 20px' },
      title: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
      subtitle: { fontSize: 12, color: TOKEN.muted },
      section: { margin: '0 0 26px' },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 2px' },
      sectionDesc: { fontSize: 12, color: TOKEN.muted, margin: '0 0 8px' },
      row: {
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 20,
        alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${TOKEN.border}`
      },
      rowText: { minWidth: 0 },
      label: { fontSize: 13 },
      desc: { fontSize: 11.5, color: TOKEN.muted, marginTop: 2 },
      control: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12.5,
        color: TOKEN.text, background: TOKEN.bg, border: `1px solid ${TOKEN.border}`,
        borderRadius: 8, outline: 'none', font: 'inherit'
      },
      trigger: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12.5,
        color: TOKEN.text, background: TOKEN.bg, border: `1px solid ${TOKEN.border}`,
        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, cursor: 'pointer', font: 'inherit', textAlign: 'left'
      },
      panel: {
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80,
        background: TOKEN.overlay, border: `1px solid ${TOKEN.borderStrong}`,
        borderRadius: 10, padding: 4, boxShadow: '0 12px 32px rgba(0,0,0,.3)',
        maxHeight: 280, overflowY: 'auto'
      },
      option: { padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5 },
      chevron: { opacity: 0.55, fontSize: 10 },
      footer: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 18 },
      // Neutral filled button: never hard-code white text or use the brand color
      // as a background — a light-theme brand tint plus white text renders as a
      // blank white pill.
      primary: {
        padding: '8px 18px', fontSize: 12.5, color: TOKEN.text, background: TOKEN.layer2,
        border: `1px solid ${TOKEN.borderStrong}`, borderRadius: 8, cursor: 'pointer',
        font: 'inherit', fontWeight: 600
      },
      secondary: {
        padding: '8px 18px', fontSize: 12.5, color: TOKEN.text, background: TOKEN.bg,
        border: `1px solid ${TOKEN.border}`, borderRadius: 8, cursor: 'pointer', font: 'inherit'
      },
      small: {
        padding: '5px 12px', fontSize: 12, color: TOKEN.text, background: TOKEN.bg,
        border: `1px solid ${TOKEN.border}`, borderRadius: 7, cursor: 'pointer', font: 'inherit'
      },
      hint: { fontSize: 12, color: TOKEN.muted },
      ok: { fontSize: 12, color: TOKEN.success },
      bad: { fontSize: 12, color: TOKEN.error }
    }

    /* ---- locale ---- */

    // Client locale namespace owned by this plugin (mirrors `NS` in
    // lib/locale-dict.js, where all page copy lives).
    const NS = 'dsh.audio'

    // Absolute ASCII-only copy of lib/locale-dict.js. The page is served as one
    // classic browser script, so it cannot import that ES module at runtime; the
    // dictionary therefore travels with the bundle as a generated literal, and
    // `test/client-locale.mjs` fails when the two disagree. Regenerate with
    // `node test/client-locale.mjs --write` after editing a string.
    /* ---- generated dictionary ---- */
    const DICT_JSON = '{"zh":{"page.title":"\u58f0\u97f3","page.subtitle":"\u5408\u6210\u3001\u6df7\u97f3\u3001\u97f3\u9891\u68c0\u67e5\u7684\u6280\u672f\u90e8\u5206\u4e0d\u9700\u8981\u5bc6\u94a5\uff1b\u8fd9\u91cc\u914d\u7f6e\u65c1\u767d\uff08TTS\uff09\u548c\u8bed\u4e49\u68c0\u67e5\u6240\u7528\u7684\u670d\u52a1\u3002","field.provider":"\u4f9b\u5e94\u5546","field.baseUrl":"\u63a5\u53e3\u5730\u5740","field.model":"\u6a21\u578b","field.voice":"\u97f3\u8272","field.speed":"\u8bed\u901f","field.pitch":"\u97f3\u8c03","field.ffmpeg":"ffmpeg","field.apiKey":"API \u5bc6\u94a5","provider.minimax":"MiniMax","provider.edge":"Edge \u6717\u8bfb\uff08\u514d\u8d39\uff0c\u65e0\u9700\u5bc6\u94a5\uff09","provider.openai":"OpenAI \u517c\u5bb9","provider.custom":"\u81ea\u5b9a\u4e49\u7aef\u70b9\uff08OpenAI \u517c\u5bb9\uff09","provider.none":"\u5173\u95ed","tts.sectionTitle":"\u65c1\u767d \u00b7 TTS","tts.baseUrlPlaceholder":"https://api.minimax.chat","tts.modelDesc":"speech-2.8-hd \u81ea\u52a8\u60c5\u611f\uff1bspeech-2.6-hd \u652f\u6301\u624b\u52a8\u60c5\u611f","tts.modelPlaceholder":"speech-2.8-hd","tts.voiceDescLive":"\u5b9e\u65f6\u5217\u8868\uff1a{count} \u4e2a\u97f3\u8272\uff0c\u6765\u81ea\u5f53\u524d\u8d26\u53f7","tts.voiceDescStatic":"\u9759\u6001\u540d\u5355\uff0c\u672a\u8054\u7f51\u6821\u9a8c\uff1b\u914d\u7f6e\u5bc6\u94a5\u540e\u81ea\u52a8\u6362\u6210\u8d26\u53f7\u7684\u5b9e\u65f6\u5217\u8868","tts.voicePlaceholder":"\u4e5f\u53ef\u4ee5\u76f4\u63a5\u586b\u97f3\u8272 id","tts.voiceNone":"\uff08\u65e0\u53ef\u7528\u97f3\u8272\uff09","tts.speedDesc":"0.5 \u2013 2.0","tts.pitchDesc":"\u534a\u97f3\uff0c\u221212 \u2013 12","tts.ffmpegDesc":"\u4ec5 Edge \u9700\u8981\uff1a\u5b83\u53ea\u63d0\u4f9b\u538b\u7f29\u97f3\u9891\uff0c\u7528\u672c\u673a ffmpeg \u89e3\u7801\u6210\u6ce2\u5f62\u3002\u7559\u7a7a\u81ea\u52a8\u63a2\u6d4b ~/.dsh/tools/ffmpeg","tts.ffmpegPlaceholder":"\u7559\u7a7a = \u81ea\u52a8\u63a2\u6d4b","tts.keyStored":"\u5df2\u4fdd\u5b58\u5bc6\u94a5\uff1b\u7559\u7a7a\u4fdd\u6301\u4e0d\u53d8","tts.keyEnvDetected":"\u7559\u7a7a\u5219\u8bfb\u73af\u5883\u53d8\u91cf {env}\uff08\u5df2\u68c0\u6d4b\u5230\uff09","tts.keyEnvMissing":"\u7559\u7a7a\u5219\u8bfb\u73af\u5883\u53d8\u91cf {env}\uff08\u672a\u68c0\u6d4b\u5230\uff09","tts.keyPlaceholder":"\u7559\u7a7a\u5219\u4e0d\u4fee\u6539","tts.testRow":"\u6d4b\u8bd5\u8fde\u63a5","tts.testDesc":"\u5408\u6210\u4e00\u53e5\u8bdd\u5e76\u8bd5\u542c\uff0c\u7528\u6765\u786e\u8ba4\u5bc6\u94a5\u3001\u6a21\u578b\u3001\u97f3\u8272\u90fd\u5bf9","tts.testAction":"\u5408\u6210\u5e76\u8bd5\u542c","tts.testOk":"\u6210\u529f\uff1a{seconds}s \u00b7 {model} \u00b7 {voice}","tts.testNoTimestamps":"\u65e0\u65f6\u95f4\u6233","tts.testTimestamps":"\u65f6\u95f4\u6233 {count} \u6761","check.sectionTitle":"\u97f3\u9891\u68c0\u67e5 \u00b7 \u8bed\u4e49\u5c42\uff08\u53ef\u9009\uff09","check.sectionDesc":"MiniMax \u6ca1\u6709\u97f3\u9891\u7406\u89e3\u63a5\u53e3\uff0c\u8fd9\u91cc\u4f7f\u7528 OpenAI \u517c\u5bb9\u7684 input_audio \u7aef\u70b9\uff08Qwen-Omni \u7b49\uff09\u3002\u4e0d\u586b\u5219\u53ea\u8dd1\u6280\u672f\u68c0\u67e5\u3002","check.testRow":"\u6d4b\u8bd5\u8bc6\u522b","check.testDesc":"\u9001\u4e00\u6bb5\u94c3\u58f0\u7ed9\u6a21\u578b\uff0c\u770b\u5b83\u80fd\u4e0d\u80fd\u63cf\u8ff0\u51fa\u6765","check.testAction":"\u8bd5\u542c\u5e76\u8bc6\u522b","check.testOk":"\u6210\u529f\uff1a{answer}","check.selfCheckRow":"\u6a21\u578b\u81ea\u68c0\uff08\u5b9e\u9a8c\u6027\uff09","check.selfCheckDesc":"\u9ed8\u8ba4\u5173\u95ed\u3002\u5f00\u542f\u540e\u6bcf\u6b21\u4fdd\u5b58\u90fd\u4f1a\u7528\u771f\u5b9e\u97f3\u9891\u95ee\u6a21\u578b\u4e00\u6b21\uff0c\u5e76\u663e\u793a\u7aef\u70b9\u72b6\u6001\u3001HTTP \u72b6\u6001\u4e0e\u8017\u65f6\uff1b\u4e5f\u53ef\u4ee5\u70b9\u53f3\u8fb9\u6309\u94ae\u7acb\u5373\u6821\u9a8c\u3002\u53ea\u6821\u9a8c\u5df2\u4fdd\u5b58\u7684\u914d\u7f6e\u3002","check.selfCheckOff":"\u5173\u95ed\uff08\u9ed8\u8ba4\uff09","check.selfCheckOn":"\u4fdd\u5b58\u540e\u81ea\u52a8\u6821\u9a8c","check.validateAction":"\u7acb\u5373\u6821\u9a8c","status.loading":"\u8bfb\u53d6\u4e2d\u2026","status.savedWaiting":"\u5df2\u4fdd\u5b58\uff0c\u7b49\u5f85\u63d2\u4ef6\u91cd\u542f\u2026","status.applied":"\u5df2\u751f\u6548","status.restartTimeout":"\u5df2\u4fdd\u5b58\uff0c\u4f46\u9875\u9762\u6ca1\u7b49\u5230\u63d2\u4ef6\u91cd\u542f\uff1b\u5237\u65b0\u4e00\u4e0b\u786e\u8ba4","status.endpointReachable":"\u7aef\u70b9\u53ef\u8fbe\uff08HTTP {status}\uff09","status.endpointUnreachable":"\u7aef\u70b9\u4e0d\u53ef\u8fbe\uff1a{error}","status.endpointNotApplicable":"\u7aef\u70b9\u63a2\u6d4b\u4e0d\u9002\u7528\uff1a{reason}","status.audioAccepted":"\u6a21\u578b\u63a5\u53d7\u97f3\u9891\u8f93\u5165\uff08{ms} ms\uff09","status.audioRejected":"\u6a21\u578b\u672a\u901a\u8fc7\uff1a{error}","status.answer":"\u56de\u7b54\uff1a{answer}","status.noModel":"\u672a\u586b\u6a21\u578b","error.loadFailed":"\u8bfb\u53d6\u5931\u8d25\uff1a{error}","error.httpNotReady":"\u63a5\u53e3\u8fd8\u6ca1\u5c31\u7eea\uff08HTTP {status}\uff09","error.httpNotJson":"\u63a5\u53e3\u8fd4\u56de\u7684\u4e0d\u662f JSON\uff08HTTP {status}\uff09","error.saveFailed":"\u4fdd\u5b58\u5931\u8d25","error.testFailed":"\u6d4b\u8bd5\u5931\u8d25","error.testFail":"\u5931\u8d25\uff1a{error}","error.unknownReason":"\u672a\u77e5\u539f\u56e0","error.validateFailed":"\u6821\u9a8c\u5931\u8d25\uff1a{error}","reason.missing-key":"\u7f3a\u5c11 API \u5bc6\u94a5\uff08{env}\uff09","reason.endpoint-unreachable":"\u8fde\u63a5\u5931\u8d25","reason.http-4xx":"\u4f9b\u5e94\u5546\u62d2\u7edd\u4e86\u8bf7\u6c42\uff08HTTP {status}\uff09","reason.http-5xx":"\u4f9b\u5e94\u5546\u670d\u52a1\u51fa\u9519\uff08HTTP {status}\uff09","reason.not-audio":"\u4f9b\u5e94\u5546\u8fd4\u56de\u7684\u5185\u5bb9\u4e0d\u53ef\u7528","reason.no-base-url":"\u6ca1\u6709\u53ef\u7528\u7684\u63a5\u53e3\u5730\u5740","reason.provider-none":"\u65c1\u767d\u5df2\u5173\u95ed\uff08provider = none\uff09","reason.decoder-missing":"\u7f3a\u5c11\u89e3\u7801\u5668\uff08Edge \u9700\u8981 ffmpeg\uff09","reason.unsupported-target":"\u4e0d\u652f\u6301\u7684\u76ee\u6807\uff08{target}\uff09","buttons.save":"\u4fdd\u5b58","buttons.saving":"\u4fdd\u5b58\u4e2d\u2026","buttons.reload":"\u91cd\u65b0\u8bfb\u53d6","buttons.retry":"\u91cd\u8bd5","buttons.testing":"\u6d4b\u8bd5\u4e2d\u2026","buttons.validating":"\u6821\u9a8c\u4e2d\u2026","note.select":"\u8bf7\u9009\u62e9"},"en":{"page.title":"Sound","page.subtitle":"The technical side \u2014 synthesis, mixing and audio checks \u2014 needs no key; configure the services used for narration (TTS) and semantic checks here.","field.provider":"Provider","field.baseUrl":"Endpoint","field.model":"Model","field.voice":"Voice","field.speed":"Speed","field.pitch":"Pitch","field.ffmpeg":"ffmpeg","field.apiKey":"API key","provider.minimax":"MiniMax","provider.edge":"Edge Speech (free, no key)","provider.openai":"OpenAI-compatible","provider.custom":"Custom endpoint (OpenAI-compatible)","provider.none":"Off","tts.sectionTitle":"Narration \u00b7 TTS","tts.baseUrlPlaceholder":"https://api.minimax.chat","tts.modelDesc":"speech-2.8-hd picks the emotion itself; speech-2.6-hd accepts a manual emotion","tts.modelPlaceholder":"speech-2.8-hd","tts.voiceDescLive":"Live list: {count} voices from this account","tts.voiceDescStatic":"Static list, not verified online; add a key to load the account voice list","tts.voicePlaceholder":"Or type a voice id","tts.voiceNone":"(no voices available)","tts.speedDesc":"0.5 \u2013 2.0","tts.pitchDesc":"Semitones, \u221212 \u2013 12","tts.ffmpegDesc":"Edge only: it returns compressed audio, decoded to a waveform by a local ffmpeg. Empty auto-detects ~/.dsh/tools/ffmpeg","tts.ffmpegPlaceholder":"Empty = auto-detect","tts.keyStored":"A key is stored; leave empty to keep it","tts.keyEnvDetected":"Leave empty to read the {env} environment variable (detected)","tts.keyEnvMissing":"Leave empty to read the {env} environment variable (not detected)","tts.keyPlaceholder":"Leave empty to keep the stored key","tts.testRow":"Test connection","tts.testDesc":"Synthesize one sentence and play it back to confirm the key, model and voice","tts.testAction":"Synthesize & listen","tts.testOk":"OK: {seconds}s \u00b7 {model} \u00b7 {voice}","tts.testNoTimestamps":"no timestamps","tts.testTimestamps":"{count} timestamps","check.sectionTitle":"Audio check \u00b7 semantic layer (optional)","check.sectionDesc":"MiniMax has no audio-understanding endpoint, so this uses an OpenAI-compatible input_audio endpoint (Qwen-Omni and similar). Leave empty to run technical checks only.","check.testRow":"Test recognition","check.testDesc":"Send a chime to the model and see whether it can describe it","check.testAction":"Listen & identify","check.testOk":"OK: {answer}","check.selfCheckRow":"Model self-check (experimental)","check.selfCheckDesc":"Off by default. When on, every save asks the model one real-audio question and reports endpoint status, HTTP status and latency; the button on the right validates immediately. Only the saved config is checked.","check.selfCheckOff":"Off (default)","check.selfCheckOn":"Validate on save","check.validateAction":"Validate now","status.loading":"Loading\u2026","status.savedWaiting":"Saved, waiting for the plugin to restart\u2026","status.applied":"Applied","status.restartTimeout":"Saved, but the page never saw the plugin restart; refresh to confirm","status.endpointReachable":"Endpoint reachable (HTTP {status})","status.endpointUnreachable":"Endpoint unreachable: {error}","status.endpointNotApplicable":"Endpoint probe not applicable: {reason}","status.audioAccepted":"Model accepted the audio input ({ms} ms)","status.audioRejected":"Model failed: {error}","status.answer":"Answer: {answer}","status.noModel":"no model set","error.loadFailed":"Failed to load: {error}","error.httpNotReady":"Endpoint not ready yet (HTTP {status})","error.httpNotJson":"The endpoint returned no JSON (HTTP {status})","error.saveFailed":"Save failed","error.testFailed":"Test failed","error.testFail":"Failed: {error}","error.unknownReason":"unknown reason","error.validateFailed":"Validation failed: {error}","reason.missing-key":"missing API key ({env})","reason.endpoint-unreachable":"connection failed","reason.http-4xx":"provider rejected the request (HTTP {status})","reason.http-5xx":"provider service error (HTTP {status})","reason.not-audio":"provider returned no usable content","reason.no-base-url":"no usable endpoint URL","reason.provider-none":"narration is off (provider = none)","reason.decoder-missing":"decoder missing (Edge needs ffmpeg)","reason.unsupported-target":"unsupported target ({target})","buttons.save":"Save","buttons.saving":"Saving\u2026","buttons.reload":"Reload","buttons.retry":"Retry","buttons.testing":"Testing\u2026","buttons.validating":"Validating\u2026","note.select":"Select"}}'
    /* ---- end generated dictionary ---- */
    const DICT = JSON.parse(DICT_JSON)

    // The locale service, when the composition installs one. `null` means every
    // t() below returns the Chinese wording, which is exactly how the page
    // behaved before it was localized.
    let localeService = null
    // Components that must re-render on a language switch; notified directly
    // when the service attaches after they mounted.
    const localeWatchers = new Set()
    let unsubscribeLocale = null

    /** Read the service's immutable snapshot, or null when it cannot answer. */
    function localeSnapshot () {
      if (localeService === null) return null
      try {
        if (typeof localeService.getLocale === 'function') return localeService.getLocale()
        if (typeof localeService.getSnapshot === 'function') return localeService.getSnapshot()
      } catch { /* a broken locale service must never blank the page */ }
      return null
    }

    /** Pick this plugin's dictionary for a snapshot, following the declared fallback chain. */
    function dictionaryFor (snapshot) {
      const seen = new Set()
      const locales = Array.isArray(snapshot?.locales) ? snapshot.locales : []
      let id = typeof snapshot?.active === 'string' ? snapshot.active : 'zh'
      while (typeof id === 'string' && !seen.has(id)) {
        if (DICT[id] !== undefined) return DICT[id]
        seen.add(id)
        const definition = locales.find((entry) => entry !== null && typeof entry === 'object' && entry.id === id)
        id = definition?.fallback
      }
      return DICT.zh
    }

    /**
     * Translate one page key: active dictionary, then Chinese, then the key.
     * `{name}` placeholders are filled from `vars`.
     */
    function t (key, vars) {
      const template = dictionaryFor(localeSnapshot())[key] ?? DICT.zh[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
    }

    /* ---- server failure reasons ---- */

    // The host routes (/dsh-audio/test, /dsh-audio/validate) report a failure as
    // data: the untouched server text in `error`/`reason` + `detail`, plus a
    // machine-readable `reasonCode`. The code picks one localized sentence, so
    // an English page never shows a Chinese reason in the middle of an English
    // line; the server text is data and only surfaces when it carries something
    // the sentence cannot say (a provider body, a transport cause). Keys mirror
    // `REASON_CODES` in lib/settings-route.js, and test/client-locale.mjs fails
    // when the two lists drift.
    const REASON_KEYS = {
      'missing-key': 'reason.missing-key',
      'endpoint-unreachable': 'reason.endpoint-unreachable',
      'http-4xx': 'reason.http-4xx',
      'http-5xx': 'reason.http-5xx',
      'not-audio': 'reason.not-audio',
      'no-base-url': 'reason.no-base-url',
      'provider-none': 'reason.provider-none',
      'decoder-missing': 'reason.decoder-missing',
      'unsupported-target': 'reason.unsupported-target'
    }

    // Where a server detail hides provider data behind our own prose: the body
    // of an HTTP error, the text after a full-width colon, and a transport cause
    // inside full-width parentheses. Written as escapes so this file stays
    // pure ASCII apart from the symbols the page already draws.
    const DETAIL_PAYLOADS = [
      /HTTP \d{3}:\s*([\s\S]+)$/,
      /\uff1a([\s\S]+)$/,
      /\uff08([^\uff08\uff09]*)\uff09\s*$/
    ]
    // Any CJK left in a server message means it is our own Chinese explanation,
    // which must not be pasted into a non-Chinese page.
    const SERVER_CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

    /**
     * A server field as displayable text: strings and finite numbers only.
     * An object, null, undefined or NaN becomes '', so a malformed response can
     * never render as `[object Object]` or `undefined`.
     */
    function textOf (value) {
      if (typeof value === 'string') return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return ''
    }

    /**
     * The part of a server detail worth showing next to a translated reason:
     * provider payload or a transport cause, never our own Chinese sentence.
     * Returns '' when the detail adds nothing the translation does not say.
     */
    function detailExtra (detail) {
      const text = textOf(detail)
      if (text === '') return ''
      for (const pattern of DETAIL_PAYLOADS) {
        const match = pattern.exec(text)
        if (match === null) continue
        const payload = match[1].trim()
        if (payload !== '' && !SERVER_CJK.test(payload)) return payload
      }
      // Nothing separable: only a message that is already language-neutral is
      // safe to show verbatim (a provider that answered in English, an OS error).
      return SERVER_CJK.test(text) ? '' : text
    }

    /**
     * The displayable reason for a failed step: a known `reasonCode` becomes the
     * reader's language, and an unknown one falls back to the server detail as
     * written, because an untranslatable code would hide the only explanation.
     */
    function reasonText (row, fallbackKey) {
      const source = row ?? {}
      const code = typeof source.reasonCode === 'string' ? source.reasonCode : ''
      const detail = textOf(source.detail ?? source.error ?? source.reason)
      const key = REASON_KEYS[code]
      if (key === undefined) return detail !== '' ? detail : t(fallbackKey ?? 'error.unknownReason')
      const sentence = t(key, {
        // The route fills these in; '?' keeps a malformed response readable
        // instead of printing a bare `{env}` placeholder.
        env: textOf(source.envName) || '?',
        status: textOf(source.status) || '?',
        target: textOf(source.target) || '?'
      })
      const extra = detailExtra(detail)
      return extra === '' ? sentence : `${sentence} · ${extra}`
    }

    /** Re-render `onChange` whenever the language moves; returns the unsubscribe. */
    function watchLocale (onChange) {
      localeWatchers.add(onChange)
      return () => { localeWatchers.delete(onChange) }
    }

    function notifyLocale () {
      for (const watcher of [...localeWatchers]) {
        try { watcher() } catch { /* one crashing watcher must not strand the rest */ }
      }
    }

    /** Adopt the locale service and start following it. */
    function attachLocale (service) {
      detachLocale()
      localeService = service
      if (typeof service.subscribe === 'function') {
        try { unsubscribeLocale = service.subscribe(notifyLocale) } catch { unsubscribeLocale = null }
      }
      notifyLocale()
    }

    /** Stop following the locale service (plugin unload). */
    function detachLocale () {
      if (typeof unsubscribeLocale === 'function') {
        try { unsubscribeLocale() } catch { /* already disposed */ }
      }
      unsubscribeLocale = null
      localeService = null
    }

    /** Re-render on a language switch; harmless when no locale service is installed. */
    function useLocale () {
      const [, setRevision] = useState(0)
      useEffect(() => watchLocale(() => { setRevision((was) => was + 1) }), [])
    }

    /* ---- components ---- */

    function Row ({ label, desc, children }) {
      return h('div', { style: S.row },
        h('div', { style: S.rowText },
          h('div', { style: S.label }, label),
          desc ? h('div', { style: S.desc }, desc) : null),
        h('div', { style: S.control }, children))
    }

    function Section ({ title, desc, children }) {
      return h('section', { style: S.section },
        h('div', { style: S.sectionTitle }, title),
        desc ? h('div', { style: S.sectionDesc }, desc) : null,
        children)
    }

    function Dropdown ({ value, options, onChange }) {
      const [open, setOpen] = useState(false)
      const box = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const close = (event) => { if (box.current !== null && !box.current.contains(event.target)) setOpen(false) }
        const escape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', escape)
        }
      }, [open])

      const current = options.find((option) => option.value === value)

      return h('div', { ref: box, style: { position: 'relative' } },
        h('button', {
          type: 'button',
          style: S.trigger,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen((was) => !was)
        },
        h('span', { style: current === undefined ? { opacity: 0.55 } : null },
          current === undefined ? (value || t('note.select')) : current.label),
        h('span', { style: S.chevron }, open ? '▴' : '▾')),
        open
          ? h('div', { style: S.panel, role: 'listbox' },
            options.map((option) => h('div', {
              key: option.value,
              role: 'option',
              'aria-selected': option.value === value,
              style: {
                ...S.option,
                background: option.value === value ? 'rgba(127,127,127,0.18)' : 'transparent'
              },
              onMouseEnter: (event) => { event.currentTarget.style.background = 'rgba(127,127,127,0.14)' },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = option.value === value ? 'rgba(127,127,127,0.18)' : 'transparent'
              },
              onClick: () => { onChange(option.value); setOpen(false) }
            }, option.label)))
          : null)
    }

    function Text ({ value, onChange, placeholder, type }) {
      return h('input', {
        type: type ?? 'text',
        style: S.input,
        value: value ?? '',
        placeholder,
        autoComplete: 'off',
        spellCheck: false,
        onChange: (event) => onChange(event.target.value)
      })
    }

    function NumberField ({ value, onChange, min, max, step }) {
      return h('input', {
        type: 'number',
        style: S.input,
        value: value ?? '',
        min,
        max,
        step: step ?? 1,
        onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value))
      })
    }

    // Dropdown options carry dictionary keys; the label is resolved at render so
    // a language switch re-translates in place.
    const PROVIDERS = [
      { value: 'minimax', key: 'provider.minimax' },
      { value: 'edge', key: 'provider.edge' },
      { value: 'openai', key: 'provider.openai' },
      { value: 'custom', key: 'provider.custom' },
      { value: 'none', key: 'provider.none' }
    ]

    const TTS_KEYS = ['provider', 'baseUrl', 'model', 'voice', 'speed', 'pitch', 'ffmpegPath']
    const CHECK_KEYS = ['provider', 'baseUrl', 'model', 'autoValidate']

    function pick (source, keys) {
      const out = {}
      for (const key of keys) if (key in source) out[key] = source[key]
      return out
    }

    /** Decode a base64 wav and play it; must be called from a user gesture. */
    async function playWav (base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      const audio = new AudioCtor()
      const buffer = await audio.decodeAudioData(bytes.buffer)
      const source = audio.createBufferSource()
      source.buffer = buffer
      source.connect(audio.destination)
      source.start()
    }

    function SettingsPage () {
      useLocale()
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [saving, setSaving] = useState(false)
      const [keys, setKeys] = useState({ tts: '', check: '' })
      const [dirty, setDirty] = useState({ tts: false, check: false })
      const [voices, setVoices] = useState({ items: [], source: 'static', note: null })
      const [testing, setTesting] = useState(null)
      const [testResult, setTestResult] = useState({ tts: null, check: null })
      const [validating, setValidating] = useState(false)
      const [validateText, setValidateText] = useState(null)

      const load = useCallback((attempt) => {
        const tries = attempt ?? 0
        setError(null)
        fetch('/dsh-audio/config', { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const text = await response.text()
            if (text.length === 0) throw new Error(t('error.httpNotReady', { status: response.status }))
            let body
            try { body = JSON.parse(text) } catch { throw new Error(t('error.httpNotJson', { status: response.status })) }
            if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
            setConfig(body.config)
            setKeys({ tts: '', check: '' })
            setDirty({ tts: false, check: false })
            return body.config
          })
          .then((loaded) => {
            if (loaded === undefined) return
            fetch('/dsh-audio/voices', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({})
            })
              .then((response) => response.json())
              .then((body) => { if (body?.ok === true) setVoices({ items: body.items ?? [], source: body.source, note: body.note }) })
              .catch(() => {})
          })
          .catch((cause) => {
            if (tries < 3) { setTimeout(() => load(tries + 1), 700); return }
            setError(cause.message)
          })
      }, [])

      useEffect(() => { load(0) }, [load])

      const patch = (section, field, value) => {
        setConfig((current) => {
          const next = { ...current }
          next[section] = { ...current[section], [field]: value }
          return next
        })
        setStatus(null)
      }

      const editKey = (section, value) => {
        setKeys((current) => ({ ...current, [section]: value }))
        setDirty((current) => ({ ...current, [section]: true }))
        setStatus(null)
      }

      // The config editor restarts the plugin to apply a write, so the endpoint
      // goes away for a moment. Poll it instead of guessing a delay, and keep the
      // button out of a "did nothing" state by always writing a status line.
      const waitForRestart = (attempt) => {
        const tries = attempt ?? 0
        fetch('/dsh-audio/config', { headers: { accept: 'application/json' } })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = JSON.parse(await response.text())
            if (body.ok !== true) throw new Error(body.error ?? 'not ready')
            setConfig(body.config)
            setSaving(false)
            setStatus(t('status.applied'))
            if (body.config?.check?.autoValidate === true) setTimeout(() => runValidate(), 400)
          })
          .catch(() => {
            if (tries >= 20) {
              setSaving(false)
              setStatus(t('status.restartTimeout'))
              return
            }
            setTimeout(() => waitForRestart(tries + 1), 700)
          })
      }

      const save = () => {
        setSaving(true)
        setStatus(t('buttons.saving'))
        setError(null)
        try {
          const payload = {
            tts: pick(config.tts ?? {}, TTS_KEYS),
            check: pick(config.check ?? {}, CHECK_KEYS)
          }
          // Only send a key the user actually touched, so an untouched field does
          // not overwrite a stored key with an empty string.
          if (dirty.tts) payload.tts.apiKey = keys.tts.trim()
          if (dirty.check) payload.check.apiKey = keys.check.trim()

          fetch('/dsh-audio/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
            .then(async (response) => {
              const text = await response.text()
              if (text.length === 0) throw new Error(t('error.httpNotReady', { status: response.status }))
              let body
              try { body = JSON.parse(text) } catch { throw new Error(t('error.httpNotJson', { status: response.status })) }
              if (!response.ok || body.ok !== true) throw new Error(body.error ?? t('error.saveFailed'))
              setDirty({ tts: false, check: false })
              setKeys({ tts: '', check: '' })
              setStatus(t('status.savedWaiting'))
              waitForRestart(0)
            })
            .catch((cause) => {
              setSaving(false)
              setError(cause.message)
              setStatus(null)
            })
        } catch (cause) {
          setSaving(false)
          setError(cause.message)
          setStatus(null)
        }
      }

      const runTest = (target) => {
        setTesting(target)
        setTestResult((current) => ({ ...current, [target]: null }))
        fetch('/dsh-audio/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target })
        })
          .then((response) => response.json())
          .then(async (body) => {
            if (body?.ok !== true) {
              // A refusal is data, not an exception: translate the reason code and
              // fall back to the server text when this page has no string for it.
              const failure = { ...(body ?? {}), target: body?.target ?? target }
              setTestResult((current) => ({ ...current, [target]: t('error.testFail', { error: reasonText(failure, 'error.testFailed') }) }))
              return
            }
            if (body.wavBase64) {
              try { await playWav(body.wavBase64) } catch { /* playback is best-effort */ }
            }
            if (target === 'tts') {
              const effective = body.effective ?? {}
              const timestamps = body.timestamps === null
                ? t('tts.testNoTimestamps')
                : t('tts.testTimestamps', { count: body.timestamps })
              setTestResult((current) => ({
                ...current,
                tts: `${t('tts.testOk', { seconds: body.durationSeconds, model: effective.model, voice: effective.voice })} · ${timestamps}`
              }))
            } else {
              setTestResult((current) => ({ ...current, check: t('check.testOk', { answer: body.answer }) }))
            }
          })
          .catch((cause) => setTestResult((current) => ({
            ...current,
            [target]: t('error.testFail', { error: reasonText({ error: cause?.message }, 'error.testFailed') })
          })))
          .finally(() => setTesting(null))
      }

      // Model self-check: an experimental, off-by-default probe that asks the
      // *saved* audio-understanding endpoint one real question with a real sound,
      // and reports what actually came back (reachability, HTTP status, latency)
      // instead of guessing. The page cannot aim it at another URL on purpose.
      // Every failing part names its cause through `reasonCode`, so the report
      // reads as one language even though the server writes Chinese.
      const runValidate = () => {
        setValidating(true)
        setValidateText(null)
        fetch('/dsh-audio/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'check' })
        })
          .then(async (response) => {
            const text = await response.text()
            let body
            try { body = JSON.parse(text) } catch { throw new Error(t('error.httpNotJson', { status: response.status })) }
            if (response.ok !== true || body?.ok !== true) {
              // Only a malformed self-check request lands here; it still carries a
              // reason code (`unsupported-target`), so translate it the same way.
              const failure = body ?? {}
              setValidateText(t('error.validateFailed', { error: reasonText({ ...failure, target: failure.target ?? 'check' }) }))
              return
            }
            const endpoint = body.endpoint ?? {}
            const endpointText = endpoint.reachable === true
              ? t('status.endpointReachable', { status: textOf(endpoint.status) })
              : endpoint.reachable === null
                ? t('status.endpointNotApplicable', { reason: reasonText(endpoint) })
                : t('status.endpointUnreachable', { error: reasonText(endpoint) })
            const parts = [
              endpointText,
              body.audioAccepted === true
                ? t('status.audioAccepted', { ms: textOf(body.latencyMs) })
                : t('status.audioRejected', { error: reasonText({ ...body, target: body.target ?? 'check' }) })
            ]
            if (textOf(body.answer) !== '') parts.push(t('status.answer', { answer: textOf(body.answer) }))
            parts.push(textOf(body.model) !== '' ? textOf(body.model) : t('status.noModel'))
            setValidateText(parts.join(' · '))
          })
          .catch((cause) => setValidateText(t('error.validateFailed', { error: reasonText({ error: cause?.message }) })))
          .finally(() => setValidating(false))
      }

      if (config === null) {
        return h('div', { style: S.page },
          error === null
            ? h('div', { style: S.hint }, t('status.loading'))
            : h('div', { style: S.bad }, t('error.loadFailed', { error })),
          error === null ? null : h('div', { style: S.footer },
            h('button', { style: S.secondary, onClick: () => load(0) }, t('buttons.retry'))))
      }

      const tts = config.tts ?? {}
      const check = config.check ?? {}

      const keyDesc = (section) => {
        if (section.keySet === true) return t('tts.keyStored')
        const envName = section.envName ?? ''
        return section.envPresent === true
          ? t('tts.keyEnvDetected', { env: envName })
          : t('tts.keyEnvMissing', { env: envName })
      }

      const voiceOptions = (() => {
        const list = voices.items.map((item) => ({ value: item.id, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id }))
        if (tts.voice && !list.some((option) => option.value === tts.voice)) {
          list.unshift({ value: tts.voice, label: tts.voice })
        }
        return list.length > 0 ? list : [{ value: tts.voice ?? '', label: tts.voice ?? t('tts.voiceNone') }]
      })()

      const voiceDesc = voices.source === 'live'
        ? t('tts.voiceDescLive', { count: voices.items.length })
        : (voices.note === null
          ? t('tts.voiceDescStatic')
          : voices.note)

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.title }, t('page.title')),
          h('div', { style: S.subtitle }, t('page.subtitle'))),

        h(Section, { title: t('tts.sectionTitle') },
          h(Row, { label: t('field.provider') },
            h(Dropdown, {
              value: tts.provider ?? 'minimax',
              options: PROVIDERS.map((option) => ({ value: option.value, label: t(option.key) })),
              onChange: (value) => patch('tts', 'provider', value)
            })),
          h(Row, { label: t('field.baseUrl') },
            h(Text, { value: tts.baseUrl, placeholder: t('tts.baseUrlPlaceholder'), onChange: (value) => patch('tts', 'baseUrl', value) })),
          h(Row, { label: t('field.model'), desc: t('tts.modelDesc') },
            h(Text, { value: tts.model, placeholder: t('tts.modelPlaceholder'), onChange: (value) => patch('tts', 'model', value) })),
          h(Row, { label: t('field.voice'), desc: voiceDesc },
            h(Dropdown, {
              value: tts.voice ?? '',
              options: voiceOptions,
              onChange: (value) => patch('tts', 'voice', value)
            }),
            h(Text, { value: tts.voice, placeholder: t('tts.voicePlaceholder'), onChange: (value) => patch('tts', 'voice', value) })),
          h(Row, { label: t('field.speed'), desc: t('tts.speedDesc') },
            h(NumberField, { value: tts.speed, min: 0.5, max: 2, step: 0.05, onChange: (value) => patch('tts', 'speed', value) })),
          h(Row, { label: t('field.pitch'), desc: t('tts.pitchDesc') },
            h(NumberField, { value: tts.pitch, min: -12, max: 12, onChange: (value) => patch('tts', 'pitch', value) })),
          h(Row, { label: t('field.ffmpeg'), desc: t('tts.ffmpegDesc') },
            h(Text, {
              value: tts.ffmpegPath,
              placeholder: t('tts.ffmpegPlaceholder'),
              onChange: (value) => patch('tts', 'ffmpegPath', value)
            })),
          h(Row, { label: t('field.apiKey'), desc: keyDesc(tts) },
            h(Text, { value: keys.tts, type: 'password', placeholder: t('tts.keyPlaceholder'), onChange: (value) => editKey('tts', value) })),
          h(Row, { label: t('tts.testRow'), desc: testResult.tts ?? t('tts.testDesc') },
            h('button', {
              type: 'button',
              style: S.small,
              disabled: testing === 'tts',
              onClick: () => runTest('tts')
            }, testing === 'tts' ? t('buttons.testing') : t('tts.testAction')))),

        h(Section, {
          title: t('check.sectionTitle'),
          desc: t('check.sectionDesc')
        },
          h(Row, { label: t('field.baseUrl') },
            h(Text, { value: check.baseUrl, onChange: (value) => patch('check', 'baseUrl', value) })),
          h(Row, { label: t('field.model') },
            h(Text, { value: check.model, onChange: (value) => patch('check', 'model', value) })),
          h(Row, { label: t('field.apiKey'), desc: keyDesc(check) },
            h(Text, { value: keys.check, type: 'password', placeholder: t('tts.keyPlaceholder'), onChange: (value) => editKey('check', value) })),
          h(Row, { label: t('check.testRow'), desc: testResult.check ?? t('check.testDesc') },
            h('button', {
              type: 'button',
              style: S.small,
              disabled: testing === 'check',
              onClick: () => runTest('check')
            }, testing === 'check' ? t('buttons.testing') : t('check.testAction'))),
          h(Row, {
            label: t('check.selfCheckRow'),
            desc: validateText ?? t('check.selfCheckDesc')
          },
            h(Dropdown, {
              value: check.autoValidate === true ? 'on' : 'off',
              options: [
                { value: 'off', label: t('check.selfCheckOff') },
                { value: 'on', label: t('check.selfCheckOn') }
              ],
              onChange: (value) => patch('check', 'autoValidate', value === 'on')
            }),
            h('button', {
              type: 'button',
              style: S.small,
              disabled: validating,
              onClick: runValidate
            }, validating ? t('buttons.validating') : t('check.validateAction')))),

        h('div', { style: S.footer },
          h('button', {
            style: saving ? { ...S.primary, opacity: 0.6 } : S.primary,
            disabled: saving,
            onClick: save,
            onMouseEnter: (event) => { if (!saving) event.currentTarget.style.background = 'rgba(127,127,127,0.28)' },
            onMouseLeave: (event) => { event.currentTarget.style.background = TOKEN.layer2 }
          }, saving ? t('buttons.saving') : t('buttons.save')),
          h('button', { style: S.secondary, onClick: () => load(0), disabled: saving }, t('buttons.reload')),
          status !== null ? h('span', { style: S.ok }, status) : null,
          error !== null ? h('span', { style: S.bad }, error) : null)
      )
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        // The locale service is optional. It is read through a nested injection
        // so the dictionary registers whenever the service turns active, and a
        // composition without it leaves every t() on the Chinese copy — the page
        // stays fully usable instead of failing on missing i18n.
        try {
          ctx.inject(['locale'], (scope) => {
            const locale = scope.locale
            if (locale === undefined || locale === null || typeof locale.register !== 'function') return
            attachLocale(locale)
            scope.effect(() => {
              try {
                return locale.register(NS, { zh: DICT.zh, en: DICT.en })
              } catch (cause) {
                console.warn('dsh-audiokit: locale dictionary registration failed; keeping the Chinese copy', cause)
                return () => {}
              }
            }, 'dsh-audiokit: locale dictionaries')
            scope.effect(() => () => { detachLocale() }, 'dsh-audiokit: locale subscription')
          })
        } catch (cause) {
          // A composition that cannot start nested plugins still gets the page,
          // in Chinese, rather than no settings section at all.
          console.warn('dsh-audiokit: locale injection unavailable; keeping the Chinese copy', cause)
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-audiokit',
          order: 50,
          // A thunk, not a string: the settings shell resolves it per render and
          // re-resolves it when the locale revision moves, so the navigation
          // label follows a language switch without re-registering the section.
          label: () => t('page.title')
        }, SettingsPage))
      }
    }
  }
})
