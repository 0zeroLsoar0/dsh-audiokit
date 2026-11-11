/**
 * Settings page for dsh-audio.
 *
 * Registers a real page under Settings → `settings.section`, reads the values
 * the running plugin actually uses, and writes back through the Host route
 * (which persists into the user's profile patch).
 *
 * Plain React over the module loader; no imports beyond react, and no theme
 * tokens by name — neutral translucent borders inherit whichever theme is on,
 * so a renamed token cannot break this page.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-audio',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const BORDER = '1px solid rgba(127,127,127,0.28)'
    const PANEL = 'rgba(127,127,127,0.08)'
    const ENDPOINT = '/dsh-audio/config'

    const styles = {
      root: { padding: '4px 2px 32px', maxWidth: 720, fontSize: 13, lineHeight: 1.6, color: 'inherit' },
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      hint: { opacity: 0.65, margin: '0 0 18px', fontSize: 12 },
      group: { border: BORDER, borderRadius: 10, padding: '14px 16px', margin: '0 0 14px', background: PANEL },
      groupTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' },
      row: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'center', margin: '0 0 9px' },
      label: { fontSize: 12, opacity: 0.8 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12,
        color: 'inherit', background: 'transparent', border: BORDER, borderRadius: 6, outline: 'none'
      },
      actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 },
      button: {
        padding: '7px 16px', fontSize: 12, color: 'inherit', background: PANEL,
        border: BORDER, borderRadius: 7, cursor: 'pointer'
      },
      buttonPrimary: {
        padding: '7px 16px', fontSize: 12, color: '#0b1119', background: '#5ad1c8',
        border: '1px solid #5ad1c8', borderRadius: 7, cursor: 'pointer', fontWeight: 600
      },
      status: { fontSize: 12, opacity: 0.8 },
      error: { fontSize: 12, color: '#e5484d' },
      code: { fontSize: 11, opacity: 0.7, fontFamily: 'ui-monospace, monospace' }
    }

    function Row ({ label, hint, children }) {
      return h('div', { style: styles.row },
        h('div', null,
          h('div', { style: styles.label }, label),
          hint ? h('div', { style: styles.code }, hint) : null),
        children)
    }

    function Select ({ value, onChange, options }) {
      return h('select', {
        style: styles.input,
        value: value ?? '',
        onChange: (event) => onChange(event.target.value)
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function Text ({ value, onChange, placeholder }) {
      return h('input', {
        type: 'text',
        style: styles.input,
        value: value ?? '',
        placeholder,
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

    function SettingsPage () {
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [saving, setSaving] = useState(false)

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
          })
          .catch((cause) => {
            // 插件刚启动时路由可能还没挂上：先自动重试几次，再让用户手动重试。
            if (tries < 3) {
              setTimeout(() => load(tries + 1), 700)
              return
            }
            setError(cause.message)
          })
      }, [])

      useEffect(() => { load() }, [load])

      const patch = (section, field, value) => {
        setConfig((current) => {
          const next = { ...current }
          next[section] = { ...current[section], [field]: value }
          return next
        })
        setStatus(null)
      }

      const save = () => {
        setSaving(true)
        setStatus(null)
        setError(null)
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tts: config.tts, check: config.check })
        })
          .then(async (response) => {
            const text = await response.text()
            if (text.length === 0) throw new Error(`接口还没就绪（HTTP ${response.status}）`)
            let body
            try { body = JSON.parse(text) } catch { throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`) }
            if (!response.ok || body.ok !== true) throw new Error(body.error ?? '保存失败')
            setStatus(body.restarting === true ? '已保存，插件正在重启以应用新配置（几秒后生效）' : '已保存')
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
            h('button', { style: styles.button, onClick: load }, '重试')))
      }

      const tts = config.tts ?? {}
      const check = config.check ?? {}

      return h('div', { style: styles.root },
        h('h2', { style: styles.title }, '动画配音'),
        h('p', { style: styles.hint },
          '合成、混音、音频检查的技术部分不需要任何密钥。这里配的是旁白（TTS）和语义检查用的端点。'),

        h('section', { style: styles.group },
          h('div', { style: styles.groupTitle }, '旁白 · TTS'),
          h(Row, { label: '供应商', hint: 'minimax / openai / custom' },
            h(Select, {
              value: tts.provider,
              onChange: (value) => patch('tts', 'provider', value),
              options: [
                { value: 'minimax', label: 'MiniMax（默认）' },
                { value: 'openai', label: 'OpenAI 兼容' },
                { value: 'custom', label: '自定义端点' },
                { value: 'none', label: '关闭' }
              ]
            })),
          h(Row, { label: '接口地址', hint: '海外 MiniMax 用 api.minimaxi.com' },
            h(Text, { value: tts.baseUrl, onChange: (value) => patch('tts', 'baseUrl', value) })),
          h(Row, { label: '模型', hint: 'speech-2.8-hd / speech-2.6-hd' },
            h(Text, { value: tts.model, onChange: (value) => patch('tts', 'model', value) })),
          h(Row, { label: '音色 id', hint: 'agent 里用 audio_voices 查短名单' },
            h(Text, { value: tts.voice, onChange: (value) => patch('tts', 'voice', value) })),
          h(Row, { label: '情感', hint: 'auto 由模型按文本决定' },
            h(Select, {
              value: tts.emotion,
              onChange: (value) => patch('tts', 'emotion', value),
              options: [
                { value: 'auto', label: 'auto（自动）' },
                { value: 'happy', label: 'happy 开心' },
                { value: 'sad', label: 'sad 悲伤' },
                { value: 'angry', label: 'angry 生气' },
                { value: 'fearful', label: 'fearful 恐惧' },
                { value: 'surprised', label: 'surprised 惊讶' },
                { value: 'calm', label: 'calm 平静' },
                { value: 'fluent', label: 'fluent 流畅' },
                { value: 'whisper', label: 'whisper 耳语' }
              ]
            })),
          h(Row, { label: '语速', hint: '0.5 – 2.0' },
            h(NumberField, { value: tts.speed, min: 0.5, max: 2, step: 0.05, onChange: (value) => patch('tts', 'speed', value) })),
          h(Row, { label: '音调', hint: '半音，−12 – 12' },
            h(NumberField, { value: tts.pitch, min: -12, max: 12, onChange: (value) => patch('tts', 'pitch', value) })),
          h(Row, { label: '密钥变量名', hint: '从启动 DSH 的环境变量里读' },
            h(Text, { value: tts.apiKeyEnv, onChange: (value) => patch('tts', 'apiKeyEnv', value) }))),

        h('section', { style: styles.group },
          h('div', { style: styles.groupTitle }, '音频检查 · 语义层（可选）'),
          h('p', { style: { opacity: 0.65, margin: '0 0 10px', fontSize: 12 } },
            'MiniMax 没有音频理解接口，这里走 OpenAI 兼容的 input_audio 端点（Qwen-Omni 等）。不填就只跑技术检查。'),
          h(Row, { label: '接口地址' },
            h(Text, { value: check.baseUrl, onChange: (value) => patch('check', 'baseUrl', value) })),
          h(Row, { label: '模型' },
            h(Text, { value: check.model, onChange: (value) => patch('check', 'model', value) })),
          h(Row, { label: '密钥变量名' },
            h(Text, { value: check.apiKeyEnv, onChange: (value) => patch('check', 'apiKeyEnv', value) }))),

        h('div', { style: styles.actions },
          h('button', {
            style: saving ? { ...styles.buttonPrimary, opacity: 0.6 } : styles.buttonPrimary,
            disabled: saving,
            onClick: save
          }, saving ? '保存中…' : '保存'),
          h('button', { style: styles.button, onClick: load, disabled: saving }, '重新读取'),
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
          label: '动画配音'
        }, SettingsPage))
      }
    }
  }
})
