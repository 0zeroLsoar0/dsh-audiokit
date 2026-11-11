/**
 * Settings page for dsh-audio.
 *
 * Styled with the host theme tokens (`--dsw-alias-*`) so it reads as part of
 * DSH's own settings rather than a foreign panel: plain rows separated by
 * borders, label + description on the left, control on the right.
 *
 * Extras beyond the form:
 *   - "测试连接" really calls the provider and plays back what it produced, so a
 *     key can be judged without leaving Settings;
 *   - the voice list asks MiniMax for the account's real voices when a key is
 *     configured, and falls back to a shortlist explicitly marked as unverified.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-audio',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    const TOKEN = {
      bg: 'var(--dsw-alias-bg-layer-1, transparent)',
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
      primary: {
        padding: '8px 18px', fontSize: 12.5, color: '#fff', background: TOKEN.brand,
        border: `1px solid ${TOKEN.brand}`, borderRadius: 8, cursor: 'pointer', font: 'inherit', fontWeight: 600
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
          current === undefined ? (value || '请选择') : current.label),
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

    const PROVIDERS = [
      { value: 'minimax', label: 'MiniMax' },
      { value: 'openai', label: 'OpenAI 兼容' },
      { value: 'custom', label: '自定义端点（OpenAI 兼容）' },
      { value: 'none', label: '关闭' }
    ]

    const EMOTIONS = [
      { value: 'auto', label: '自动（按文本决定）' },
      { value: 'happy', label: '开心' },
      { value: 'sad', label: '悲伤' },
      { value: 'angry', label: '生气' },
      { value: 'fearful', label: '恐惧' },
      { value: 'surprised', label: '惊讶' },
      { value: 'calm', label: '平静' },
      { value: 'fluent', label: '流畅' },
      { value: 'whisper', label: '耳语' }
    ]

    const TTS_KEYS = ['provider', 'baseUrl', 'model', 'voice', 'emotion', 'speed', 'pitch']
    const CHECK_KEYS = ['provider', 'baseUrl', 'model']

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
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [saving, setSaving] = useState(false)
      const [keys, setKeys] = useState({ tts: '', check: '' })
      const [dirty, setDirty] = useState({ tts: false, check: false })
      const [voices, setVoices] = useState({ items: [], source: 'static', note: null })
      const [testing, setTesting] = useState(null)
      const [testResult, setTestResult] = useState({ tts: null, check: null })

      const load = useCallback((attempt) => {
        const tries = attempt ?? 0
        setError(null)
        fetch('/dsh-audio/config', { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const text = await response.text()
            if (text.length === 0) throw new Error(`接口还没就绪（HTTP ${response.status}）`)
            let body
            try { body = JSON.parse(text) } catch { throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`) }
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

      const save = () => {
        setSaving(true)
        setStatus(null)
        setError(null)
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
            if (text.length === 0) throw new Error(`接口还没就绪（HTTP ${response.status}）`)
            let body
            try { body = JSON.parse(text) } catch { throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`) }
            if (!response.ok || body.ok !== true) throw new Error(body.error ?? '保存失败')
            setStatus('已保存，插件正在重启以应用新配置（几秒后生效）')
            setDirty({ tts: false, check: false })
            setKeys({ tts: '', check: '' })
            if (body.config !== undefined && body.config !== null) setConfig(body.config)
            setTimeout(() => load(0), 3200)
          })
          .catch((cause) => setError(cause.message))
          .finally(() => setSaving(false))
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
            if (body?.ok !== true) throw new Error(body?.error ?? '测试失败')
            if (body.wavBase64) {
              try { await playWav(body.wavBase64) } catch { /* playback is best-effort */ }
            }
            if (target === 'tts') {
              const effective = body.effective ?? {}
              setTestResult((current) => ({
                ...current,
                tts: `成功：${body.durationSeconds}s · ${effective.model} · ${effective.voice}` +
                  (body.timestamps === null ? ' · 无时间戳' : ` · 时间戳 ${body.timestamps} 条`)
              }))
            } else {
              setTestResult((current) => ({ ...current, check: `成功：${body.answer}` }))
            }
          })
          .catch((cause) => setTestResult((current) => ({ ...current, [target]: `失败：${cause.message}` })))
          .finally(() => setTesting(null))
      }

      if (config === null) {
        return h('div', { style: S.page },
          error === null
            ? h('div', { style: S.hint }, '读取中…')
            : h('div', { style: S.bad }, `读取失败：${error}`),
          error === null ? null : h('div', { style: S.footer },
            h('button', { style: S.secondary, onClick: () => load(0) }, '重试')))
      }

      const tts = config.tts ?? {}
      const check = config.check ?? {}

      const keyDesc = (section) => {
        if (section.keySet === true) return '已保存密钥；留空保持不变'
        const envName = section.envName ?? ''
        return section.envPresent === true
          ? `留空则读环境变量 ${envName}（已检测到）`
          : `留空则读环境变量 ${envName}（未检测到）`
      }

      const voiceOptions = (() => {
        const list = voices.items.map((item) => ({ value: item.id, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id }))
        if (tts.voice && !list.some((option) => option.value === tts.voice)) {
          list.unshift({ value: tts.voice, label: tts.voice })
        }
        return list.length > 0 ? list : [{ value: tts.voice ?? '', label: tts.voice ?? '（无可用音色）' }]
      })()

      const voiceDesc = voices.source === 'live'
        ? `实时列表：${voices.items.length} 个音色，来自当前账号`
        : (voices.note === null
          ? '静态名单，未联网校验；配置密钥后自动换成账号的实时列表'
          : voices.note)

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('div', { style: S.title }, '声音'),
          h('div', { style: S.subtitle },
            '合成、混音、音频检查的技术部分不需要密钥；这里配置旁白（TTS）和语义检查所用的服务。')),

        h(Section, { title: '旁白 · TTS' },
          h(Row, { label: '供应商' },
            h(Dropdown, {
              value: tts.provider ?? 'minimax',
              options: PROVIDERS,
              onChange: (value) => patch('tts', 'provider', value)
            })),
          h(Row, { label: '接口地址' },
            h(Text, { value: tts.baseUrl, placeholder: 'https://api.minimax.chat', onChange: (value) => patch('tts', 'baseUrl', value) })),
          h(Row, { label: '模型', desc: 'speech-2.8-hd 自动情感；speech-2.6-hd 支持手动情感' },
            h(Text, { value: tts.model, placeholder: 'speech-2.8-hd', onChange: (value) => patch('tts', 'model', value) })),
          h(Row, { label: '音色', desc: voiceDesc },
            h(Dropdown, {
              value: tts.voice ?? '',
              options: voiceOptions,
              onChange: (value) => patch('tts', 'voice', value)
            }),
            h(Text, { value: tts.voice, placeholder: '也可以直接填音色 id', onChange: (value) => patch('tts', 'voice', value) })),
          h(Row, { label: '情感' },
            h(Dropdown, {
              value: tts.emotion ?? 'auto',
              options: EMOTIONS,
              onChange: (value) => patch('tts', 'emotion', value)
            })),
          h(Row, { label: '语速', desc: '0.5 – 2.0' },
            h(NumberField, { value: tts.speed, min: 0.5, max: 2, step: 0.05, onChange: (value) => patch('tts', 'speed', value) })),
          h(Row, { label: '音调', desc: '半音，−12 – 12' },
            h(NumberField, { value: tts.pitch, min: -12, max: 12, onChange: (value) => patch('tts', 'pitch', value) })),
          h(Row, { label: 'API 密钥', desc: keyDesc(tts) },
            h(Text, { value: keys.tts, type: 'password', placeholder: '留空则不修改', onChange: (value) => editKey('tts', value) })),
          h(Row, { label: '测试连接', desc: testResult.tts ?? '合成一句话并试听，用来确认密钥、模型、音色都对' },
            h('button', {
              type: 'button',
              style: S.small,
              disabled: testing === 'tts',
              onClick: () => runTest('tts')
            }, testing === 'tts' ? '测试中…' : '合成并试听'))),

        h(Section, {
          title: '音频检查 · 语义层（可选）',
          desc: 'MiniMax 没有音频理解接口，这里使用 OpenAI 兼容的 input_audio 端点（Qwen-Omni 等）。不填则只跑技术检查。'
        },
          h(Row, { label: '接口地址' },
            h(Text, { value: check.baseUrl, onChange: (value) => patch('check', 'baseUrl', value) })),
          h(Row, { label: '模型' },
            h(Text, { value: check.model, onChange: (value) => patch('check', 'model', value) })),
          h(Row, { label: 'API 密钥', desc: keyDesc(check) },
            h(Text, { value: keys.check, type: 'password', placeholder: '留空则不修改', onChange: (value) => editKey('check', value) })),
          h(Row, { label: '测试识别', desc: testResult.check ?? '送一段铃声给模型，看它能不能描述出来' },
            h('button', {
              type: 'button',
              style: S.small,
              disabled: testing === 'check',
              onClick: () => runTest('check')
            }, testing === 'check' ? '测试中…' : '试听并识别'))),

        h('div', { style: S.footer },
          h('button', { style: saving ? { ...S.primary, opacity: 0.6 } : S.primary, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', { style: S.secondary, onClick: () => load(0), disabled: saving }, '重新读取'),
          status !== null ? h('span', { style: S.ok }, status) : null,
          error !== null ? h('span', { style: S.bad }, error) : null)
      )
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-audio',
          order: 50,
          label: '声音'
        }, SettingsPage))
      }
    }
  }
})
