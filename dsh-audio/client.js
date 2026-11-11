/**
 * Settings page for dsh-audio.
 *
 * Registers a page under Settings → 声音, reads the values the running plugin
 * actually uses, and writes back through the Host route (which persists into
 * the user's profile patch).
 *
 * The dropdown is a custom control: a native <select> cannot be styled to match
 * the host, and on Windows it collapses to a single line that reads as a text
 * field — which is why the provider list looked like it had one entry.
 *
 * Key field semantics match DSH's own settings: leave it empty to read the
 * default environment variable, type a value to use it as the key directly. A
 * stored key is never echoed back, only reported as "already set".
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-audio',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    const BORDER = '1px solid rgba(127,127,127,0.28)'
    const PANEL = 'rgba(127,127,127,0.08)'
    const HOVER = 'rgba(127,127,127,0.16)'
    const ACCENT = 'rgba(90,209,200,0.16)'
    const ENDPOINT = '/dsh-audio/config'

    const styles = {
      root: { padding: '4px 2px 32px', maxWidth: 720, fontSize: 13, lineHeight: 1.6, color: 'inherit' },
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      hint: { opacity: 0.65, margin: '0 0 18px', fontSize: 12 },
      group: { border: BORDER, borderRadius: 10, padding: '14px 16px', margin: '0 0 14px', background: PANEL },
      groupTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' },
      row: { display: 'grid', gridTemplateColumns: '108px 1fr', gap: 12, alignItems: 'center', margin: '0 0 9px' },
      label: { fontSize: 12, opacity: 0.8 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12,
        color: 'inherit', background: 'transparent', border: BORDER, borderRadius: 6, outline: 'none',
        font: 'inherit'
      },
      trigger: {
        width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12,
        color: 'inherit', background: 'transparent', border: BORDER, borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        cursor: 'pointer', font: 'inherit', textAlign: 'left'
      },
      panel: {
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
        background: 'Canvas', color: 'CanvasText', border: BORDER, borderRadius: 8,
        padding: 4, boxShadow: '0 10px 28px rgba(0,0,0,0.28)'
      },
      option: { padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
      chevron: { opacity: 0.55, fontSize: 10 },
      help: { fontSize: 11, opacity: 0.6, margin: '2px 0 0' },
      actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 },
      button: {
        padding: '7px 16px', fontSize: 12, color: 'inherit', background: PANEL,
        border: BORDER, borderRadius: 7, cursor: 'pointer', font: 'inherit'
      },
      buttonPrimary: {
        padding: '7px 16px', fontSize: 12, color: '#06201d', background: '#5ad1c8',
        border: '1px solid #5ad1c8', borderRadius: 7, cursor: 'pointer', fontWeight: 600, font: 'inherit'
      },
      status: { fontSize: 12, opacity: 0.8 },
      error: { fontSize: 12, color: '#e5484d' }
    }

    function Row ({ label, hint, children }) {
      return h('div', { style: styles.row },
        h('div', null,
          h('div', { style: styles.label }, label),
          hint ? h('div', { style: styles.help }, hint) : null),
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
          style: styles.trigger,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen((was) => !was)
        },
        h('span', { style: { opacity: current === undefined ? 0.5 : 1 } },
          current === undefined ? '请选择' : current.label),
        h('span', { style: styles.chevron }, open ? '▴' : '▾')),
        open
          ? h('div', { style: styles.panel, role: 'listbox' },
            options.map((option) => h('div', {
              key: option.value,
              role: 'option',
              'aria-selected': option.value === value,
              onClick: () => { onChange(option.value); setOpen(false) },
              style: { ...styles.option, background: option.value === value ? ACCENT : 'transparent' },
              onMouseEnter: (event) => { event.currentTarget.style.background = option.value === value ? ACCENT : HOVER },
              onMouseLeave: (event) => { event.currentTarget.style.background = option.value === value ? ACCENT : 'transparent' }
            }, option.label)))
          : null)
    }

    function Text ({ value, onChange, placeholder, type }) {
      return h('input', {
        type: type ?? 'text',
        style: styles.input,
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
        style: styles.input,
        value: value ?? '',
        min,
        max,
        step: step ?? 1,
        onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value))
      })
    }

    const PROVIDERS = [
      { value: 'minimax', label: 'MiniMax（默认）' },
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

    function SettingsPage () {
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [saving, setSaving] = useState(false)
      const [keys, setKeys] = useState({ tts: '', check: '' })
      const [dirty, setDirty] = useState({ tts: false, check: false })

      const load = useCallback((attempt) => {
        const tries = attempt ?? 0
        setError(null)
        fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const text = await response.text()
            if (text.length === 0) throw new Error(`接口还没就绪（HTTP ${response.status}）`)
            let body
            try { body = JSON.parse(text) } catch { throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`) }
            if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
            setConfig(body.config)
            setKeys({ tts: '', check: '' })
            setDirty({ tts: false, check: false })
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
        // Only send the key when the user touched it; an untouched field must
        // not overwrite a stored key with an empty string.
        if (dirty.tts) payload.tts.apiKey = keys.tts.trim()
        if (dirty.check) payload.check.apiKey = keys.check.trim()

        fetch(ENDPOINT, {
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
            // The plugin restarts to apply the write; come back once it is up so
            // the page is not left showing the pre-save values.
            setTimeout(() => load(0), 3200)
          })
          .catch((cause) => setError(cause.message))
          .finally(() => setSaving(false))
      }

      if (config === null) {
        return h('div', { style: styles.root },
          error === null
            ? h('div', { style: styles.status }, '读取中…')
            : h('div', { style: styles.error }, `读取失败：${error}`),
          error === null ? null : h('div', { style: styles.actions },
            h('button', { style: styles.button, onClick: () => load(0) }, '重试')))
      }

      const tts = config.tts ?? {}
      const check = config.check ?? {}

      const keyHint = (section) => {
        const envName = section.envName ?? ''
        const state = section.keySet === true
          ? '已保存密钥，留空保持不变'
          : section.envPresent === true
            ? `留空：读环境变量 ${envName}（已检测到）`
            : `留空：读环境变量 ${envName}（未检测到）`
        return state
      }

      return h('div', { style: styles.root },
        h('h2', { style: styles.title }, '声音'),
        h('p', { style: styles.hint },
          '合成、混音、音频检查的技术部分不需要任何密钥；这里配的是旁白（TTS）和语义检查用的端点。'),

        h('section', { style: styles.group },
          h('div', { style: styles.groupTitle }, '旁白 · TTS'),
          h(Row, { label: '供应商' },
            h(Dropdown, {
              value: tts.provider ?? 'minimax',
              options: PROVIDERS,
              onChange: (value) => patch('tts', 'provider', value)
            })),
          h(Row, { label: '接口地址' },
            h(Text, { value: tts.baseUrl, placeholder: 'https://api.minimax.chat', onChange: (value) => patch('tts', 'baseUrl', value) })),
          h(Row, { label: '模型' },
            h(Text, { value: tts.model, placeholder: 'speech-2.8-hd', onChange: (value) => patch('tts', 'model', value) })),
          h(Row, { label: '音色 id' },
            h(Text, { value: tts.voice, placeholder: 'female-shaonv', onChange: (value) => patch('tts', 'voice', value) })),
          h(Row, { label: '情感' },
            h(Dropdown, {
              value: tts.emotion ?? 'auto',
              options: EMOTIONS,
              onChange: (value) => patch('tts', 'emotion', value)
            })),
          h(Row, { label: '语速' },
            h(NumberField, { value: tts.speed, min: 0.5, max: 2, step: 0.05, onChange: (value) => patch('tts', 'speed', value) })),
          h(Row, { label: '音调', hint: '半音' },
            h(NumberField, { value: tts.pitch, min: -12, max: 12, onChange: (value) => patch('tts', 'pitch', value) })),
          h(Row, { label: 'API 密钥', hint: keyHint(tts) },
            h(Text, { value: keys.tts, type: 'password', placeholder: '留空则不修改', onChange: (value) => editKey('tts', value) }))),

        h('section', { style: styles.group },
          h('div', { style: styles.groupTitle }, '音频检查 · 语义层（可选）'),
          h('p', { style: { opacity: 0.65, margin: '0 0 10px', fontSize: 12 } },
            'MiniMax 没有音频理解接口，这里走 OpenAI 兼容的 input_audio 端点（Qwen-Omni 等）。不填就只跑技术检查。'),
          h(Row, { label: '接口地址' },
            h(Text, { value: check.baseUrl, onChange: (value) => patch('check', 'baseUrl', value) })),
          h(Row, { label: '模型' },
            h(Text, { value: check.model, onChange: (value) => patch('check', 'model', value) })),
          h(Row, { label: 'API 密钥', hint: keyHint(check) },
            h(Text, { value: keys.check, type: 'password', placeholder: '留空则不修改', onChange: (value) => editKey('check', value) }))),

        h('div', { style: styles.actions },
          h('button', {
            style: saving ? { ...styles.buttonPrimary, opacity: 0.6 } : styles.buttonPrimary,
            disabled: saving,
            onClick: save
          }, saving ? '保存中…' : '保存'),
          h('button', { style: styles.button, onClick: () => load(0), disabled: saving }, '重新读取'),
          status !== null ? h('span', { style: styles.status }, status) : null,
          error !== null ? h('span', { style: styles.error }, error) : null)
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
