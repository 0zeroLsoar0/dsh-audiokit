/**
 * The `animation-sound` skill: the workflow document the model loads before it
 * scores an animation. Discoverability lives here rather than in the tool
 * descriptions, because the catalog is read before the tools are, and because
 * "how to sequence six renders and then wire them up" is prose, not a schema.
 */

export const SKILL_NAME = 'animation-sound'

const CONTENT = `# 给 HTML 动画配音

页面默认是静音的。你产出的动画、动效、演示页，除非用户明确说"不要声音"，都应当配音。
本技能说明：什么时候配、怎么排拍点、怎么渲染、怎么接进页面、怎么自检。

## 什么时候用

- 会动的画面：loading 动画、开场片头、角色/物体运动、数据可视化动效、交互 demo、转场。
- 不适用：纯静态页面、纯工具界面、API 文档页。

## 工作流（顺序不要跳）

1. **先定拍子。** 从动画自己的时间轴读出"声音事件"：在几秒、发生了什么、有多重。
   没有时间轴就先给动画建一个（见下面"同步契约"）。
2. **写 cue 表。** 每行一个事件：\`{ "at": 0.82, "cue": "slam", "preset": "impact", "params": { "weight": 0.9 } }\`。
   密集段不要写五十行，用一条 \`audio_pattern\`（train/scatter）表达。
3. **渲染。** \`audio_synth\` 出单个音；\`audio_pattern\` 出密集段；需要叠层时最后 \`audio_mix\` 合并。
4. **自检。** 用返回的度量判断，不要凭想象：
   - 峰值不低于 -3 dBFS、且 \`clipping\` 为 0
   - 循环底噪 \`loopSeam\` 小于 6 dB（超过就会"咚"一下）
   - 打击类音色的 \`onsets\` 应当是 1；train 的 onsets ≈ 事件数
   - \`centroid\` 太低 = 闷，太高 = 刺。画面越"重"，centroid 应越低。
5. **接进页面。** 单文件交付见下面的内联配方。
6. **报告。** 告诉用户每个 cue 用的预设和关键词，方便他改。

## 预设速查

| preset | 听起来像 | 典型场景 | 关键参数 |
|---|---|---|---|
| \`impact\` | 有重量的撞击 | 碰撞、落地、碎裂、拳击 | weight, hardness, metallic, space |
| \`whoosh\` | 掠过空气 | 划过、转场、镜头甩动、揭幕 | speed, tone, rise |
| \`tick\` | 极短点击 | 打字、时钟、状态切换（密集段的基底） | pitch, hardness |
| \`chime\` | 有音高的铃 | 通知、拾取、确认、魔法 | pitch, decay, metallic |
| \`riser\` | 上扬的紧张感 | 冲击前的蓄力、升级、倒计时 | tone, tension |
| \`zap\` | 放电 | 能量、传送、故障、受击 | pitch, roughness |
| \`thud\` | 闷的低频体 | 脚步、远处震动、心跳、重量 | weight, softness |
| \`scrap\` | 摩擦颗粒 | 刮擦、撕裂、碎屑、生物 | density, tone, roughness |
| \`texture\` | 持续的底 | 环境声、风声、雨、火、电流嗡鸣 | kind, density, movement + \`loop:true\` |

参数都是 0..1 的感知量：\`weight\` 重、\`hardness\` 硬、\`metallic\` 金属感、\`space\` 空间（混响）、\`tone\` 明暗、
\`density\` 密度、\`roughness\` 粗糙度。\`pitch\` 在 impact/whoosh 上是 0.5..2 的倍频。

## 同步契约（音画不同步的头号原因）

**一个时钟。** 音频用 \`AudioContext.currentTime\` 走，动画的 \`requestAnimationFrame\` 也从它取时间。
绝对不要动画用 \`performance.now()\`、音频用 \`audio.currentTime\` —— 两个时间源一定漂移。

**打击音对齐峰值，不是对齐起点。** 画面在 t=0.82 破碎，意思是"铛"的那一下在 0.82，
而 wav 的第一个采样是瞬态的开始。把 cue 的 \`at\` 往前放 30~50ms，或者给 cue 加 \`preroll\`。

**先解码再启动。** \`decodeAudioData\` 必须 \`await\` 完，再启动时钟，否则开头 100ms 会被吞掉。

## 为什么在浏览器里没声音（DSH 里却有）

宿主（Electron）默认放宽了自动播放策略，同一份文件在 DSH 里一打开就响；
用 Edge/Chrome 双击打开时页面没有任何用户交互，\`AudioContext\` 会一直停在 suspended。三件事要同时做对：

1. **在手势里先 \`resume()\`**，再 await 别的。点击回调第一行就调，中间不要隔 await。
2. **页面要有一个明确的「点击开始」**。绝不要把点击做成 \`location.reload()\`——重载不给音频任何手势。
3. **不要用 \`fetch(data:)\` 读内联音频**，自己 \`atob\` 解码。\`file://\` 下 data URL 的 fetch 在部分浏览器版本会被拦。

判断方式：\`ctx.state === 'running'\` 就是已解锁。为 false 时不要静默失败——显示一个开始按钮，
并保留一条静音也能跑的画面路径。

## 页面里的最小运行时

在动画里放一个数据块和一个约 30 行的运行时：

\`\`\`html
<script type="application/json" id="dsh-audio">
{"cues":[
  {"at":0.78,"cue":"slam","src":"__audio:slam__","gain":0.9},
  {"at":2.30,"cue":"swell","src":"__audio:swell__","gain":0.7}
]}
</script>
<script>
const SOUND = (() => {
  const data = JSON.parse(document.getElementById('dsh-audio').textContent)
  const ctx = new AudioContext()
  // 所有 cue 汇到一条总线：每个 wav 都归一到 -1 dBFS，直接相加会削波。
  const master = ctx.createDynamicsCompressor()
  master.threshold.value = -6; master.ratio.value = 12; master.attack.value = 0.003
  master.connect(ctx.destination)
  let buffers = null, t0 = 0
  const active = []
  // 自己解 base64：file:// 下 fetch(data:) 会被某些浏览器拦掉。
  const toBuffer = (uri) => {
    const bin = atob(uri.slice(uri.indexOf(',') + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }
  function stop () {
    for (const node of active) { try { node.stop() } catch {} ; try { node.disconnect() } catch {} }
    active.length = 0
  }
  async function start () {
    stop()                                 // 上一轮的循环底噪必须先掐掉
    const resuming = ctx.resume()          // 必须在用户手势里同步调用
    if (!buffers) buffers = await Promise.all(data.cues.map(c => ctx.decodeAudioData(toBuffer(c.src))))
    await resuming
    if (ctx.state !== 'running') throw new Error('audio blocked by autoplay policy')
    t0 = ctx.currentTime + 0.06
    data.cues.forEach((cue, i) => {
      const src = ctx.createBufferSource()
      const gain = ctx.createGain()
      src.buffer = buffers[i]
      src.loop = cue.loop === true
      gain.gain.value = cue.gain ?? 1
      src.connect(gain).connect(master)
      src.start(Math.max(0, t0 + cue.at))
      active.push(src)
    })
  }
  return { start, stop, unlocked: ctx.state === 'running', time: () => ctx.currentTime - t0 }
})()
// 动画：render(SOUND.time()) 由 requestAnimationFrame 驱动
\`\`\`

启动逻辑写成两段：\`SOUND.unlocked\` 为真（DSH 里）就直接开；为假就先显示一个「点击开始」，
点击回调里 \`await SOUND.start()\` 成功后再启动 \`requestAnimationFrame\`。失败时降级为静音播放，
但把按钮留着让人能重试——不要出现"页面在动但一直没声音、也没有任何提示"的状态。

**播放一次，不要自动无限循环。** 演示页/交付页要能自己停下来：播完 \`SOUND.stop()\`、画面停在终态、
露出一个「重播」按钮；\`document.hidden\` 时也停。加一个 \`setTimeout(play, 时长)\` 让自己反复重播，
等于给用户一个关不掉的门铃——而且重播前没 \`stop()\` 的话，\`loop:true\` 的底噪会一层层叠上去，越放越响。

## 单文件内联（交付给用户的那一份）

渲染出来的是独立 wav。要变成"双击就能响的一个 HTML"，写一个 12 行的构建脚本：

\`\`\`js
// build-sound.mjs —— 用法: node build-sound.mjs scene.html > final.html
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const source = process.argv[2]
const html = readFileSync(source, 'utf8')
const out = html.replace(/__audio:([a-z0-9_-]+)__/gi, (_, name) => {
  const bytes = readFileSync(join(dirname(source), 'assets', 'audio', name + '.wav'))
  return 'data:audio/wav;base64,' + bytes.toString('base64')
})
process.stdout.write(out)
\`\`\`

把要内联的音先复制成稳定名字（\`assets/audio/slam.wav\`），再跑脚本。
体积参考：22.05 kHz 单声道 16bit ≈ 44 KB/秒，base64 后 ×1.33；一个 10 秒动画配 6 个短音通常在 200~400 KB。

## 自检清单（交付前）

- [ ] 每个画面事件都有声音，没有"该响却没响"的地方
- [ ] 峰值 ≤ -1 dBFS，\`clipping\` 为 0
- [ ] 循环底噪 \`loopSeam\` < 6 dB
- [ ] 声音总长 = 动画时长（或明确更短）
- [ ] 首帧不是静音起步（tiny fade-in 除外）
- [ ] 用 \`audio_probe\` 复核过最终文件
`

/**
 * Register the skill provider.
 * @param {object} skills - the resolved `skills` service (pass `ctx.get('skills')`;
 *   `ctx.skills` throws unless `skills` is a declared injection).
 */
export function registerSkill (skills) {
  const summary = {
    name: SKILL_NAME,
    description: '给 HTML 动画配音：拍点、音效预设、同步契约、单文件内联。Whenever you build an HTML animation, motion graphic, or browser demo that should make sound, load this first.',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-audio',
    source: 'bundled',
    rank: 600,
    locator: 'dsh-audio/animation-sound'
  }
  skills.registerProvider(() => ({
    name: 'dsh-audio',
    list: async () => [summary],
    async get () {
      return { ...summary, content: CONTENT }
    }
  }))
}
