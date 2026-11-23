/**
 * The cue editor page: one self-contained HTML document, served by
 * `lib/editor-route.js` at `/dsh-audio/editor`.
 *
 * Everything lives in this one string on purpose. The page has to work when it
 * is opened from the plugin's own HTTP carrier, so it may not load a font, a
 * stylesheet, a script or an image from anywhere: no CDN, no bundler, no build
 * step. The route test asserts that the rendered page contains no `http://` or
 * `https://` URL at all, which is a cheap proof that it makes no external
 * request.
 *
 * The page speaks to three read-only endpoints (see `lib/editor-route.js`):
 * `/dsh-audio/editor/info`, `/project?path=…`, `/file?path=…` and
 * `/list?dir=…`. It never writes: the deliverable of an edit is the exported
 * cue sheet / tool-call snippets in the third panel, not a changed file.
 *
 * Visual language: black and white with one cold blue (`#5b8dd6`), monospaced
 * numbers, restrained dark panels. No orange, no purple.
 */

/**
 * Strings every rendered page must carry. The route test imports this list, so
 * a marker can never be removed from the page and from the test separately.
 */
export const EDITOR_PAGE_MARKERS = Object.freeze([
  'data-dsh-editor="1"',
  'id="lanes"',
  'id="ruler"',
  'id="export-text"',
  'id="play"'
])

const STYLE = `*{box-sizing:border-box}
:root{--bg:#0d1014;--panel:#131821;--panel2:#0f141b;--sunk:#0b0f14;
--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);
--text:#e8ecf1;--muted:#8b95a3;--dim:#66707d;
--accent:#5b8dd6;--accent2:rgba(91,141,214,.16);--accent3:rgba(91,141,214,.42);
--ok:#4fa87a;--bad:#d56a72;--warn:#c9a227;
--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Liberation Mono",monospace}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:5px}
::-webkit-scrollbar-track{background:transparent}
header.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 20px;background:rgba(13,16,20,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(6px)}
.brand{display:flex;align-items:center;gap:9px}
.brand .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent3)}
h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.2px}
.ver{font:11px/1 var(--mono);color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:3px 5px}
.root{margin-left:auto;font:11.5px/1.4 var(--mono);color:var(--muted);max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.root code{color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:2px 6px}
.status{font:11.5px/1 var(--mono);color:var(--muted);padding:5px 10px;border:1px solid var(--line);border-radius:999px;white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis}
.status.ok{color:var(--ok);border-color:rgba(79,168,122,.35)}
.status.bad{color:var(--bad);border-color:rgba(213,106,114,.4)}
main{max-width:1500px;margin:0 auto;padding:16px 20px 60px;display:flex;flex-direction:column;gap:14px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px 14px}
.panel-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
h2{font-size:12.5px;font-weight:600;margin:0;color:var(--text)}
h2 .idx{color:var(--accent);font:11px/1 var(--mono);margin-right:4px}
.muted{color:var(--muted);font-size:12px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.row label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}
.grow{flex:1;min-width:220px}
.grow input{flex:1;min-width:0;width:auto}
input[type=text],input[type=number],textarea{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:12.5px/1.4 var(--mono);outline:none;min-width:0}
input[type=text]:focus,input[type=number]:focus,textarea:focus{border-color:var(--accent3);box-shadow:0 0 0 3px var(--accent2)}
input[type=number]{width:96px}
input[type=range]{accent-color:var(--accent);width:120px}
button{background:var(--panel2);color:var(--text);border:1px solid var(--line2);border-radius:7px;padding:6px 12px;font:12.5px/1.2 inherit;cursor:pointer;transition:border-color .12s,background .12s}
button:hover{border-color:var(--accent3);background:#141b25}
button:active{transform:translateY(1px)}
button:disabled{opacity:.4;cursor:default;transform:none}
button.primary{border-color:var(--accent3);color:#dbe7f8;background:var(--accent2)}
button.tiny{padding:3px 8px;font-size:11.5px}
button.danger:hover{border-color:rgba(213,106,114,.6);color:#f0b4b8}
button.ok{border-color:rgba(79,168,122,.5);color:#bfe4cd}
.tl{display:grid;grid-template-columns:290px minmax(0,1fr);border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel2);height:100%;min-height:280px}
.tl-heads{border-right:1px solid var(--line);background:var(--panel);min-width:0}
.ruler-corner{height:22px;display:flex;align-items:center;padding:0 10px;font:10.5px/1 var(--mono);color:var(--dim);border-bottom:1px solid var(--line);letter-spacing:.4px}
.head{height:60px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;flex-direction:column;gap:5px;overflow:hidden}
.head:hover{background:#151c26}
.head.selected{background:var(--accent2);box-shadow:inset 2px 0 0 var(--accent)}
.hrow{display:flex;align-items:center;gap:6px;min-width:0}
.hname{font:12.5px/1.25 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}
.chip{flex:none;font:9.5px/1.2 var(--mono);color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:2px 4px}
.chip.accent{color:#9dbde8;border-color:rgba(91,141,214,.45)}
.chip.warn{color:var(--warn);border-color:rgba(201,162,39,.4)}
.hmeta{font:10.5px/1.3 var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hmeta b{color:var(--text);font-weight:500}
.tl-scroll{overflow-x:auto;overflow-y:hidden;min-width:0;height:100%}
.tl-inner{position:relative;min-height:100%;background-color:var(--panel2);background-image:linear-gradient(to right,rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(to right,rgba(255,255,255,.1) 1px,transparent 1px);background-size:var(--beatpx,40px) 100%,var(--barpx,160px) 100%}
.ruler{height:22px;display:block;border-bottom:1px solid var(--line);background:var(--sunk)}
.lanes{position:relative}
.lane{position:relative;height:60px;border-bottom:1px solid rgba(255,255,255,.04)}
.clip{position:absolute;top:8px;bottom:8px;border:1px solid rgba(91,141,214,.5);border-radius:5px;background:rgba(91,141,214,.1);overflow:hidden;cursor:grab;min-width:6px}
.clip:hover{border-color:rgba(91,141,214,.8)}
.clip.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent2),0 0 14px rgba(91,141,214,.18)}
.clip canvas{display:block}
.grip{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:2}
.grip.gl{left:0}
.grip.gr{right:0}
.grip:hover{background:rgba(91,141,214,.35)}
.playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--accent);box-shadow:0 0 8px rgba(91,141,214,.8);pointer-events:none;z-index:5;left:0}
.hidden{display:none!important}
.empty{padding:34px 16px;color:var(--muted);font-size:12.5px;text-align:center}
body.dragging,body.dragging *{cursor:ew-resize!important;-webkit-user-select:none;user-select:none}
.editor-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:stretch;margin-top:10px}
.inspector{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:12px;min-height:220px}
.inspector h3{font-size:11.5px;margin:0 0 10px;color:var(--muted);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:9px}
.field>span{font-size:11.5px;color:var(--muted)}
.field input{width:100%}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.chk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin:2px 0 10px;cursor:pointer}
.chk input{accent-color:var(--accent)}
.readout{font:11px/1.7 var(--mono);color:var(--muted);border-top:1px solid var(--line);padding-top:9px;margin-bottom:10px;word-break:break-all}
.readout b{color:var(--text);font-weight:500}
.readout .bad{color:var(--bad)}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.tabs{display:flex;align-items:center;gap:6px;margin:10px 0 8px;flex-wrap:wrap}
.tab{border-color:transparent;background:transparent;color:var(--muted);padding:5px 10px;border-radius:6px;font:12px/1.2 var(--mono)}
.tab:hover{color:var(--text);background:#151c26}
.tab.active{color:var(--text);background:var(--accent2);border-color:var(--accent3)}
.spacer{flex:1}
pre.export{margin:0;background:var(--sunk);border:1px solid var(--line);border-radius:8px;padding:11px 12px;font:11.5px/1.65 var(--mono);color:#cdd8e6;max-height:340px;overflow:auto;white-space:pre;tab-size:2}
.note{font-size:11.5px;color:var(--muted);margin:8px 0 0;min-height:17px}
.browse{margin-top:9px;border:1px solid var(--line);border-radius:8px;background:var(--sunk);max-height:230px;overflow:auto}
.browse-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font:11.5px/1.4 var(--mono);color:var(--muted);word-break:break-all}
.browse-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.04);border-radius:0;padding:6px 10px;font:11.5px/1.4 var(--mono);color:var(--text);cursor:pointer}
.browse-row:hover{background:#151c26}
.browse-row .sz{margin-left:auto;color:var(--dim)}
.browse-row.dim{color:var(--muted);cursor:default}
details.paste{margin-top:10px}
details.paste summary{cursor:pointer;color:var(--muted);font-size:12px;padding:4px 0}
textarea#paste{width:100%;min-height:98px;margin:8px 0;resize:vertical;font-size:11.5px}
@media (max-width:1100px){.editor-grid{grid-template-columns:minmax(0,1fr)}.inspector{min-height:0}.tl{grid-template-columns:220px minmax(0,1fr)}.root{display:none}}`

/**
 * The page's client script.
 *
 * Written without template literals and without regular expressions that need
 * backslashes: this text is itself inside a template literal here, and a regex
 * like /\\/g would have to be escaped twice, which is the kind of thing that
 * silently rots. Windows separators are handled with `String.fromCharCode(92)`.
 */
const PAGE_SCRIPT = `(function () {
  'use strict'
  var API = {
    info: '/dsh-audio/editor/info',
    project: '/dsh-audio/editor/project',
    file: '/dsh-audio/editor/file',
    list: '/dsh-audio/editor/list'
  }
  var BSLASH = String.fromCharCode(92)
  var LANE_HEIGHT = 60
  var PAD_RIGHT = 56
  var state = {
    cues: [],
    selected: -1,
    pps: 80,
    bpm: 120,
    snap: true,
    declaredDuration: 0,
    tab: 'json',
    buffers: Object.create(null),
    decoding: Object.create(null),
    readErrors: Object.create(null),
    ctx: null,
    master: null,
    srcs: [],
    active: false,
    paused: false,
    startTime: 0,
    endAt: 0,
    raf: 0,
    uiTimer: 0,
    browsing: '',
    busy: 0
  }
  var el = {}

  function byId (id) { return document.getElementById(id) }
  function make (tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  function clamp (value, lo, hi) { return value < lo ? lo : value > hi ? hi : value }
  function round (value, digits) {
    var factor = Math.pow(10, digits)
    var n = Number(value)
    if (!Number.isFinite(n)) return 0
    return Math.round(n * factor) / factor
  }
  function fmt (value, digits) {
    var n = Number(value)
    return Number.isFinite(n) ? n.toFixed(digits) : '-'
  }
  function setStatus (text, kind) {
    el.status.textContent = text
    el.status.className = 'status' + (kind ? ' ' + kind : '')
  }
  function setText (node, text) { node.textContent = text === undefined || text === null ? '' : String(text) }

  /* ---- path helpers (no regex, so Windows separators stay readable) ---- */

  function isAbsolutePath (p) {
    if (p.charAt(0) === '/') return true
    if (p.charAt(0) === BSLASH && p.charAt(1) === BSLASH) return true
    return p.length > 2 && p.charAt(1) === ':' && (p.charAt(2) === '/' || p.charAt(2) === BSLASH)
  }
  function isDataUri (p) { return p.slice(0, 5).toLowerCase() === 'data:' }
  // Written without the literal scheme strings so the page never contains an
  // http(s) URL at all: the route test greps the served page for one.
  function isRemote (p) {
    var at = p.indexOf('://')
    if (at > 0) {
      var scheme = p.slice(0, at).toLowerCase()
      return scheme === 'http' || scheme === 'https' || scheme === 'file'
    }
    return p.slice(0, 2) === '//'
  }
  function toSlashes (p) { return p.split(BSLASH).join('/') }
  function normalizeRelative (p) {
    var parts = toSlashes(p).split('/')
    var out = []
    var i
    for (i = 0; i < parts.length; i += 1) {
      var part = parts[i]
      if (part === '' || part === '.') continue
      if (part === '..') return null
      out.push(part)
    }
    return out.join('/')
  }

  /* ---- cue model ---- */

  function cueDuration (cue) {
    var path = readableOf(cue)
    var buffer = path ? state.buffers[path] : null
    if (buffer) return buffer.duration
    if (cue.wavDuration > 0) return cue.wavDuration
    return 0.4
  }
  function readableOf (cue) { return cue.readable && cue.readable !== '' ? cue.readable : null }

  function toModel (raw, index) {
    var cue = raw !== null && typeof raw === 'object' ? raw : {}
    var name = typeof cue.name === 'string' && cue.name.trim() !== '' ? cue.name.trim() : 'cue-' + (index + 1)
    var at = Number(cue.at)
    if (!Number.isFinite(at) || at < 0) at = 0
    var gainDb = Number(cue.gainDb)
    if (!Number.isFinite(gainDb)) gainDb = 0
    var fadeIn = Number(cue.fadeIn)
    if (!Number.isFinite(fadeIn) || fadeIn < 0) fadeIn = 0
    var fadeOut = Number(cue.fadeOut)
    if (!Number.isFinite(fadeOut) || fadeOut < 0) fadeOut = 0
    var path = typeof cue.path === 'string' && cue.path.trim() !== '' ? cue.path.trim() : ''
    var src = typeof cue.src === 'string' && cue.src.trim() !== '' ? cue.src.trim() : ''
    var origin = path !== '' ? path : src
    var readable = typeof cue.readable === 'string' && cue.readable !== '' ? cue.readable : ''
    if (readable === '' && origin !== '' && !isAbsolutePath(origin) && !isDataUri(origin) && !isRemote(origin)) {
      readable = normalizeRelative(origin) || ''
    }
    var wavDuration = Number(cue.wavDuration)
    if (!Number.isFinite(wavDuration) || wavDuration < 0) wavDuration = 0
    return {
      name: name,
      at: round(at, 3),
      path: path,
      src: src,
      readable: readable,
      gainDb: round(clamp(gainDb, -60, 12), 1),
      fadeIn: round(clamp(fadeIn, 0, 60), 3),
      fadeOut: round(clamp(fadeOut, 0, 60), 3),
      loop: cue.loop === true,
      wavDuration: wavDuration,
      readError: typeof cue.readError === 'string' && cue.readError !== '' ? cue.readError : ''
    }
  }

  function normalizeDoc (raw) {
    var list = []
    var duration = 0
    if (Array.isArray(raw)) {
      list = raw
    } else if (raw !== null && typeof raw === 'object' && Array.isArray(raw.cues)) {
      list = raw.cues
      if (Number.isFinite(Number(raw.duration))) duration = Number(raw.duration)
    } else if (raw !== null && typeof raw === 'object' && raw.request !== null && typeof raw.request === 'object' && Array.isArray(raw.request.cues)) {
      list = raw.request.cues
      if (Number.isFinite(Number(raw.request.duration))) duration = Number(raw.request.duration)
    } else {
      throw new Error('不是 cue 数组，也不是 {cues:[…]} 形式的 cue 表')
    }
    return { cues: list.map(toModel), duration: duration }
  }

  /* ---- timeline geometry ---- */

  function timelineEnd () {
    var end = state.declaredDuration > 0 ? state.declaredDuration : 0
    var i
    for (i = 0; i < state.cues.length; i += 1) {
      var cue = state.cues[i]
      var cueEnd = cue.at + cueDuration(cue)
      if (cueEnd > end) end = cueEnd
    }
    return Math.max(1, end)
  }
  function timelineWidth () {
    return Math.max(360, timelineEnd() * state.pps + PAD_RIGHT)
  }
  function snapValue (value) {
    if (!state.snap) return value
    var beat = 60 / state.bpm
    return Math.round(value / beat) * beat
  }
  function beatPx () { return (60 / state.bpm) * state.pps }

  function layoutWidth () {
    var width = timelineWidth()
    el.inner.style.width = width + 'px'
    var bpx = beatPx()
    el.inner.style.setProperty('--beatpx', fmt(bpx, 2) + 'px')
    el.inner.style.setProperty('--barpx', fmt(bpx * 4, 2) + 'px')
    drawRuler(width)
    return width
  }

  function drawRuler (width) {
    var canvas = el.ruler
    var dpr = window.devicePixelRatio || 1
    var height = 22
    var w = Math.max(2, Math.round(width))
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = height + 'px'
    var g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, height)
    var bpx = beatPx()
    var beat = 60 / state.bpm
    var bar = beat * 4
    var showBeats = bpx >= 7
    var step = showBeats ? beat : bar
    // Label spacing: never let two labels collide.
    var labelEvery = 1
    if (step * state.pps > 0) {
      while (step * state.pps * labelEvery < 62) labelEvery *= showBeats ? 4 : 2
    }
    g.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
    g.textBaseline = 'middle'
    var count = Math.ceil((w / state.pps) / step)
    var i
    for (i = 0; i <= count; i += 1) {
      var t = i * step
      var x = Math.round(t * state.pps) + 0.5
      if (x > w) break
      g.strokeStyle = 'rgba(255,255,255,.16)'
      g.beginPath()
      g.moveTo(x, height - 6)
      g.lineTo(x, height)
      g.stroke()
      if (i % labelEvery === 0) {
        g.fillStyle = 'rgba(139,149,163,.9)'
        g.fillText(fmt(t, t < 10 ? 2 : t < 60 ? 1 : 0) + 's', x + 4, height / 2 - 1)
      }
    }
  }

  // The persistent facts (counts, timeline length, how many waveforms decoded,
  // grid, zoom) live on their own line. The status pill is reserved for what
  // just happened — loaded / playing / paused / an error — so a debounced
  // re-render cannot overwrite "播放中" half a second after playback starts.
  function timelineSummary () {
    var grid = '网格 ' + fmt(60 / state.bpm, 3) + 's · ' + state.pps + 'px/s'
    if (state.cues.length === 0) return grid
    var readableCount = 0
    var decoded = 0
    var i
    for (i = 0; i < state.cues.length; i += 1) {
      var p = readableOf(state.cues[i])
      if (p) {
        readableCount += 1
        if (state.buffers[p]) decoded += 1
      }
    }
    var text = 'cue ' + state.cues.length + ' · 时间线 ' + fmt(timelineEnd(), 2) + 's · 波形 ' + decoded + '/' + readableCount
    if (readableCount < state.cues.length) text += ' · ' + (state.cues.length - readableCount) + ' 个无法读取'
    return text + ' · ' + grid
  }

  function refreshStatus () {
    setText(el.timelineInfo, timelineSummary())
  }

  /* ---- rendering ---- */

  function renderAll () {
    renderHeads()
    renderLanes()
    layoutWidth()
    renderInspector()
    updateExports()
    refreshStatus()
  }

  function headMetaText (cue) {
    return 'at ' + fmt(cue.at, 3) + 's · ' + fmt(cue.gainDb, 1) + ' dB · ' + fmt(cueDuration(cue), 2) + 's'
  }

  function renderHeads () {
    el.heads.textContent = ''
    var corner = make('div', 'ruler-corner', 'cue · 工作区路径')
    el.heads.appendChild(corner)
    var i
    for (i = 0; i < state.cues.length; i += 1) {
      var cue = state.cues[i]
      var head = make('div', 'head' + (i === state.selected ? ' selected' : ''))
      head.setAttribute('data-index', String(i))
      var row = make('div', 'hrow')
      var name = make('div', 'hname', cue.name)
      row.appendChild(name)
      if (cue.loop) row.appendChild(make('span', 'chip accent', 'loop'))
      var path = readableOf(cue)
      if (path === null) {
        var reason = cue.readError || '无 wav 路径'
        var chip = make('span', 'chip warn', reason.length > 6 ? '无 wav' : reason)
        chip.title = reason
        row.appendChild(chip)
      } else if (state.readErrors[path]) {
        var warn = make('span', 'chip warn', '读不到')
        warn.title = state.readErrors[path]
        row.appendChild(warn)
      }
      var meta = make('div', 'hmeta')
      var atText = make('b', null, fmt(cue.at, 3))
      meta.appendChild(atText)
      meta.appendChild(document.createTextNode('s · ' + fmt(cue.gainDb, 1) + ' dB · ' + fmt(cueDuration(cue), 2) + 's'))
      meta.title = '起点 ' + fmt(cue.at, 3) + 's · 增益 ' + fmt(cue.gainDb, 1) + ' dB · 时长 ' + fmt(cueDuration(cue), 2) + 's'
      head.appendChild(row)
      head.appendChild(meta)
      head.addEventListener('pointerdown', onHeadPointerDown)
      el.heads.appendChild(head)
    }
  }

  function renderLanes () {
    el.lanes.textContent = ''
    if (state.cues.length === 0) {
      el.lanes.appendChild(make('div', 'empty', '还没有 cue。先在上方载入 audio_bind 的 cues JSON，或输入工作区里的 .json 路径。'))
      return
    }
    var i
    for (i = 0; i < state.cues.length; i += 1) el.lanes.appendChild(createLane(i))
  }

  function createLane (index) {
    var cue = state.cues[index]
    var lane = make('div', 'lane')
    lane.setAttribute('data-index', String(index))
    var clip = make('div', 'clip' + (index === state.selected ? ' selected' : ''))
    clip.setAttribute('data-index', String(index))
    clip.title = cue.name
    var canvas = make('canvas')
    clip.appendChild(canvas)
    var gl = make('div', 'grip gl')
    gl.title = '拖动改淡入'
    var gr = make('div', 'grip gr')
    gr.title = '拖动改淡出'
    clip.appendChild(gl)
    clip.appendChild(gr)
    lane.appendChild(clip)
    clip.addEventListener('pointerdown', function (event) { startDrag(event, index, 'move') })
    gl.addEventListener('pointerdown', function (event) { event.stopPropagation(); startDrag(event, index, 'fadeIn') })
    gr.addEventListener('pointerdown', function (event) { event.stopPropagation(); startDrag(event, index, 'fadeOut') })
    updateCueVisual(index, lane)
    return lane
  }

  function laneNode (index) {
    return el.lanes.querySelector('.lane[data-index="' + index + '"]')
  }

  function updateCueVisual (index, laneArg) {
    var cue = state.cues[index]
    if (!cue) return
    var lane = laneArg || laneNode(index)
    if (!lane) return
    var clip = lane.querySelector('.clip')
    if (!clip) return
    var width = Math.max(6, cueDuration(cue) * state.pps)
    var left = cue.at * state.pps
    clip.style.left = fmt(left, 2) + 'px'
    clip.style.width = fmt(width, 2) + 'px'
    clip.className = 'clip' + (index === state.selected ? ' selected' : '')
    var canvas = clip.querySelector('canvas')
    if (canvas) drawClip(canvas, cue, width)
    var head = el.heads.children[index + 1]
    if (head) {
      var name = head.querySelector('.hname')
      if (name) setText(name, cue.name)
      var meta = head.querySelector('.hmeta')
      if (meta) {
        meta.textContent = ''
        var atText = make('b', null, fmt(cue.at, 3))
        meta.appendChild(atText)
        meta.appendChild(document.createTextNode('s · ' + fmt(cue.gainDb, 1) + ' dB · ' + fmt(cueDuration(cue), 2) + 's'))
      }
    }
  }

  function drawClip (canvas, cue, widthPx) {
    var dpr = window.devicePixelRatio || 1
    var height = LANE_HEIGHT - 16
    var width = Math.max(2, Math.round(widthPx))
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    var g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    var mid = height / 2
    var path = readableOf(cue)
    var buffer = path ? state.buffers[path] : null
    if (buffer) {
      var data = buffer.getChannelData(0)
      var frames = data.length
      var step = Math.max(1, Math.floor(frames / (width * 500)))
      g.strokeStyle = 'rgba(91,141,214,.92)'
      g.lineWidth = 1
      g.beginPath()
      var x
      for (x = 0; x < width; x += 1) {
        var a = Math.floor((x / width) * frames)
        var b = Math.floor(((x + 1) / width) * frames)
        if (b <= a) b = a + 1
        if (b > frames) b = frames
        var lo = 1
        var hi = -1
        var s
        for (s = a; s < b; s += step) {
          var v = data[s]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (lo > hi) { lo = 0; hi = 0 }
        var y0 = mid - hi * (mid - 2)
        var y1 = mid - lo * (mid - 2)
        if (y1 - y0 < 1) { y0 = mid - 0.5; y1 = mid + 0.5 }
        g.moveTo(x + 0.5, y0)
        g.lineTo(x + 0.5, y1)
      }
      g.stroke()
    } else {
      g.strokeStyle = 'rgba(255,255,255,.2)'
      g.setLineDash([3, 4])
      g.beginPath()
      g.moveTo(0, mid)
      g.lineTo(width, mid)
      g.stroke()
      g.setLineDash([])
      if (cue.wavDuration > 0) {
        g.fillStyle = 'rgba(139,149,163,.65)'
        g.font = '10px monospace'
        g.fillText('载入波形…', 5, 12)
      }
    }
    var inPx = Math.min(width, (cue.fadeIn || 0) * state.pps)
    if (inPx > 0.5) {
      g.fillStyle = 'rgba(91,141,214,.16)'
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(inPx, 0)
      g.lineTo(0, height)
      g.closePath()
      g.fill()
    }
    var outPx = Math.min(width, (cue.fadeOut || 0) * state.pps)
    if (outPx > 0.5) {
      g.fillStyle = 'rgba(91,141,214,.16)'
      g.beginPath()
      g.moveTo(width - outPx, 0)
      g.lineTo(width, 0)
      g.lineTo(width, height)
      g.closePath()
      g.fill()
    }
    g.strokeStyle = 'rgba(255,255,255,.1)'
    g.beginPath()
    g.moveTo(0, mid + 0.5)
    g.lineTo(width, mid + 0.5)
    g.stroke()
  }

  /* ---- selection / inspector ---- */

  function selectCue (index) {
    state.selected = index
    var i
    for (i = 0; i < state.cues.length; i += 1) {
      var lane = laneNode(i)
      if (lane) {
        var clip = lane.querySelector('.clip')
        if (clip) clip.className = 'clip' + (i === index ? ' selected' : '')
      }
      var head = el.heads.children[i + 1]
      if (head) head.className = 'head' + (i === index ? ' selected' : '')
    }
    renderInspector()
  }

  function setInput (node, value) {
    if (document.activeElement === node) return
    node.value = value
  }

  function renderInspector () {
    var cue = state.cues[state.selected]
    if (!cue) {
      el.inspectorEmpty.classList.remove('hidden')
      el.inspectorBody.classList.add('hidden')
      return
    }
    el.inspectorEmpty.classList.add('hidden')
    el.inspectorBody.classList.remove('hidden')
    setInput(el.fName, cue.name)
    setInput(el.fAt, fmt(cue.at, 3))
    setInput(el.fGain, fmt(cue.gainDb, 1))
    setInput(el.fIn, fmt(cue.fadeIn, 3))
    setInput(el.fOut, fmt(cue.fadeOut, 3))
    if (document.activeElement !== el.fLoop) el.fLoop.checked = cue.loop === true
    var path = readableOf(cue)
    var buffer = path ? state.buffers[path] : null
    el.readout.textContent = ''
    var rows = [
      ['时长', buffer ? fmt(buffer.duration, 3) + ' s' : cue.wavDuration > 0 ? fmt(cue.wavDuration, 3) + ' s（头信息）' : '未知'],
      ['采样率', buffer ? buffer.sampleRate + ' Hz · ' + buffer.numberOfChannels + ' ch' : '-'],
      ['工作区路径', path || (cue.path || cue.src || '（无）')],
      ['状态', path ? (state.readErrors[path] ? state.readErrors[path] : buffer ? '已载入波形' : '等待解码') : '不能读取 wav（内联/远程/绝对路径）']
    ]
    var i
    for (i = 0; i < rows.length; i += 1) {
      var line = make('div')
      line.appendChild(make('b', null, rows[i][0] + '：'))
      line.appendChild(document.createTextNode(rows[i][1]))
      el.readout.appendChild(line)
    }
  }

  function syncInspectorNumbers () {
    var cue = state.cues[state.selected]
    if (!cue) return
    setInput(el.fAt, fmt(cue.at, 3))
    setInput(el.fIn, fmt(cue.fadeIn, 3))
    setInput(el.fOut, fmt(cue.fadeOut, 3))
    setInput(el.fGain, fmt(cue.gainDb, 1))
  }

  function scheduleUi () {
    if (state.uiTimer) return
    state.uiTimer = window.setTimeout(function () {
      state.uiTimer = 0
      updateExports()
      refreshStatus()
      renderInspector()
    }, 120)
  }

  /* ---- drag ---- */

  function onHeadPointerDown (event) {
    var head = event.currentTarget
    var index = Number(head.getAttribute('data-index'))
    if (Number.isFinite(index)) selectCue(index)
  }

  function startDrag (event, index, mode) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    selectCue(index)
    var cue = state.cues[index]
    var startX = event.clientX
    var startValue = mode === 'move' ? cue.at : mode === 'fadeIn' ? cue.fadeIn : cue.fadeOut
    document.body.classList.add('dragging')
    function onMove (moveEvent) {
      var dx = (moveEvent.clientX - startX) / state.pps
      if (mode === 'move') {
        var at = Math.max(0, startValue + dx)
        if (state.snap && !moveEvent.altKey) at = snapValue(at)
        cue.at = round(Math.max(0, at), 3)
      } else {
        var max = Math.max(0, cueDuration(cue))
        var value = clamp(startValue + dx, 0, max)
        if (mode === 'fadeIn') cue.fadeIn = round(value, 3)
        else cue.fadeOut = round(value, 3)
      }
      updateCueVisual(index)
      syncInspectorNumbers()
      scheduleUi()
    }
    function onUp () {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging')
      scheduleUi()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  /* ---- audio ---- */

  function ensureCtx () {
    if (state.ctx) return state.ctx
    var Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) throw new Error('这个浏览器不支持 WebAudio')
    state.ctx = new Ctor()
    state.master = state.ctx.createGain()
    state.master.gain.value = 1
    state.master.connect(state.ctx.destination)
    return state.ctx
  }

  function decodeBytes (ctx, bytes) {
    return new Promise(function (resolve, reject) {
      var settled = false
      function done (buffer) { if (!settled) { settled = true; resolve(buffer) } }
      function fail (error) { if (!settled) { settled = true; reject(error || new Error('decodeAudioData 失败')) } }
      try {
        var maybe = ctx.decodeAudioData(bytes, done, fail)
        if (maybe && typeof maybe.then === 'function') maybe.then(done, fail)
      } catch (error) {
        fail(error)
      }
    })
  }

  function ensureDecoded (path) {
    if (state.buffers[path]) return Promise.resolve(state.buffers[path])
    if (state.decoding[path]) return state.decoding[path]
    var promise = fetch(API.file + '?path=' + encodeURIComponent(path))
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (body) {
            throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          }, function () { throw new Error('HTTP ' + response.status) })
        }
        return response.arrayBuffer()
      })
      .then(function (bytes) { return decodeBytes(ensureCtx(), bytes) })
      .then(function (buffer) {
        state.buffers[path] = buffer
        onDecoded(path)
        return buffer
      })
    state.decoding[path] = promise
    promise.then(function () { delete state.decoding[path] }, function (error) {
      delete state.decoding[path]
      state.readErrors[path] = error && error.message ? error.message : '读取失败'
      onDecoded(path)
    })
    return promise
  }

  function decodeAll () {
    var seen = Object.create(null)
    var i
    var jobs = []
    for (i = 0; i < state.cues.length; i += 1) {
      var path = readableOf(state.cues[i])
      if (!path || seen[path] || state.buffers[path]) continue
      seen[path] = true
      jobs.push(ensureDecoded(path).catch(function () {}))
    }
    return Promise.all(jobs)
  }

  function onDecoded (path) {
    var i
    var touched = false
    for (i = 0; i < state.cues.length; i += 1) {
      if (readableOf(state.cues[i]) === path) {
        updateCueVisual(i)
        touched = true
      }
    }
    if (touched) {
      layoutWidth()
      renderInspector()
      scheduleUi()
    }
  }

  function scheduleCue (ctx, bus, cue, t0, end, atOverride) {
    var path = readableOf(cue)
    var buffer = path ? state.buffers[path] : null
    if (!buffer) return false
    var offset = atOverride === undefined ? Math.max(0, cue.at) : Math.max(0, atOverride)
    var start = t0 + offset
    var source = ctx.createBufferSource()
    source.buffer = buffer
    var gain = ctx.createGain()
    var level = Math.pow(10, (cue.gainDb || 0) / 20)
    var cueEnd = cue.loop ? t0 + end : start + buffer.duration
    var fi = Math.max(0, cue.fadeIn || 0)
    var fo = Math.max(0, cue.fadeOut || 0)
    var param = gain.gain
    param.setValueAtTime(fi > 0 ? 0 : level, start)
    if (fi > 0) param.linearRampToValueAtTime(level, Math.min(start + fi, cueEnd))
    if (fo > 0 && cueEnd - fo > start + fi) {
      param.setValueAtTime(level, cueEnd - fo)
      param.linearRampToValueAtTime(0, cueEnd)
    }
    source.loop = cue.loop === true
    source.connect(gain)
    gain.connect(bus)
    source.start(start)
    if (cue.loop) source.stop(cueEnd)
    state.srcs.push(source)
    return true
  }

  function stopSound () {
    var list = state.srcs
    state.srcs = []
    var i
    for (i = 0; i < list.length; i += 1) {
      try { list[i].stop(0) } catch (error) { /* already stopped */ }
    }
  }

  function stopPlayback () {
    var wasActive = state.active
    state.active = false
    state.paused = false
    if (state.raf) {
      window.cancelAnimationFrame(state.raf)
      state.raf = 0
    }
    stopSound()
    el.playhead.classList.add('hidden')
    el.playhead.style.transform = 'translateX(0px)'
    el.play.textContent = '播放'
    el.pause.disabled = true
    el.stop.disabled = true
    if (wasActive) setStatus('已停止', 'ok')
    refreshStatus()
  }

  function tick () {
    if (!state.active) return
    var ctx = state.ctx
    if (ctx && ctx.state === 'running') {
      var pos = ctx.currentTime - state.startTime
      if (pos >= 0) {
        el.playhead.classList.remove('hidden')
        el.playhead.style.transform = 'translateX(' + fmt(pos * state.pps, 2) + 'px)'
        var visibleRight = el.scroll.scrollLeft + el.scroll.clientWidth - 40
        if (pos * state.pps > visibleRight) el.scroll.scrollLeft = pos * state.pps - el.scroll.clientWidth * 0.4
      }
      if (pos > state.endAt + 0.25) {
        stopPlayback()
        setStatus('播放结束 · 时间线 ' + fmt(state.endAt, 2) + 's', 'ok')
        return
      }
    }
    state.raf = window.requestAnimationFrame(tick)
  }

  function startPlayback () {
    try {
      var ctx = ensureCtx()
    } catch (error) {
      setStatus(error.message, 'bad')
      return
    }
    setStatus('准备波形…')
    decodeAll().then(function () {
      var inner = ensureCtx()
      var ready = inner.state === 'running' ? Promise.resolve(true) : inner.resume().then(function () { return inner.state === 'running' }, function () { return false })
      return ready.then(function (running) {
        if (!running) {
          setStatus('浏览器拦截了音频：请再点一次「播放」', 'bad')
          return
        }
        stopSound()
        var end = timelineEnd()
        var t0 = inner.currentTime + 0.08
        state.startTime = t0
        state.endAt = end
        var started = 0
        var i
        for (i = 0; i < state.cues.length; i += 1) {
          if (scheduleCue(inner, state.master, state.cues[i], t0, end)) started += 1
        }
        if (started === 0) {
          setStatus('没有可播放的 wav：检查 cue 的 path 是否能在这个工作区读到', 'bad')
          return
        }
        state.active = true
        state.paused = false
        el.play.textContent = '重播'
        el.pause.disabled = false
        el.stop.disabled = false
        setStatus('播放中 · ' + started + ' 个 cue · 时间线 ' + fmt(end, 2) + 's', 'ok')
        state.raf = window.requestAnimationFrame(tick)
      })
    })
  }

  function play () {
    if (state.active) {
      if (state.paused) {
        state.ctx.resume().then(function () {
          state.paused = false
          setStatus('播放中 · 继续', 'ok')
        }, function () {})
      }
      return
    }
    startPlayback()
  }

  function pause () {
    if (!state.active || state.paused) return
    state.ctx.suspend().then(function () {
      state.paused = true
      setStatus('已暂停 · 点「播放」继续', 'ok')
    }, function () {})
  }

  function auditionSelected () {
    var cue = state.cues[state.selected]
    if (!cue) return
    var path = readableOf(cue)
    if (!path) { setStatus('这个 cue 没有可读的 wav 路径', 'bad'); return }
    ensureDecoded(path).then(function () {
      var ctx = ensureCtx()
      var run = ctx.state === 'running' ? Promise.resolve(true) : ctx.resume().then(function () { return true }, function () { return false })
      return run.then(function (ok) {
        if (!ok) { setStatus('浏览器拦截了音频：请再点一次「试听」', 'bad'); return }
        stopSound()
        var end = Math.max(cueDuration(cue) + 0.1, 0.2)
        scheduleCue(ctx, state.master, cue, ctx.currentTime + 0.03, end, 0)
        setStatus('试听 · ' + cue.name, 'ok')
      })
    }, function (error) {
      setStatus('试听失败：' + (error && error.message ? error.message : error), 'bad')
    })
  }

  /* ---- export ---- */

  function cueSource (cue) {
    if (cue.path !== '' && !isDataUri(cue.path) && !isRemote(cue.path)) return cue.path
    if (cue.src !== '' && !isDataUri(cue.src) && !isRemote(cue.src)) return cue.src
    return ''
  }

  function uniqueName (base, used) {
    var name = base === '' ? 'cue' : base
    if (!used[name]) { used[name] = 1; return name }
    var i = 2
    while (used[name + '-' + i]) i += 1
    used[name + '-' + i] = 1
    return name + '-' + i
  }

  function numberedString (value) { return JSON.stringify(String(value || '')) }

  function buildEntries () {
    var used = Object.create(null)
    var entries = []
    var skipped = []
    var renamed = 0
    var i
    for (i = 0; i < state.cues.length; i += 1) {
      var cue = state.cues[i]
      var source = cueSource(cue)
      if (source === '') { skipped.push(cue.name); continue }
      if (used[cue.name]) renamed += 1
      entries.push({
        name: uniqueName(cue.name, used),
        at: round(cue.at, 3),
        path: source,
        gainDb: round(cue.gainDb, 1),
        fadeIn: round(cue.fadeIn, 3),
        fadeOut: round(cue.fadeOut, 3),
        loop: cue.loop === true,
        duration: cueDuration(cue)
      })
    }
    return { entries: entries, skipped: skipped, renamed: renamed }
  }

  function buildExports () {
    var plan = buildEntries()
    var end = round(timelineEnd(), 3)
    var jsonCues = []
    var bindLines = []
    var dawLines = []
    var bindPath = el.outBind.value.trim() || 'assets/audio/cues-edited'
    var dawPath = el.outRpp.value.trim() || 'assets/audio/editor.rpp'
    var loops = 0
    var i
    for (i = 0; i < plan.entries.length; i += 1) {
      var entry = plan.entries[i]
      jsonCues.push({
        name: entry.name,
        at: entry.at,
        path: entry.path,
        gainDb: entry.gainDb,
        fadeIn: entry.fadeIn,
        fadeOut: entry.fadeOut,
        loop: entry.loop
      })
      var bits = ['name: ' + numberedString(entry.name), 'at: ' + entry.at, 'path: ' + numberedString(entry.path)]
      if (entry.gainDb !== 0) bits.push('gainDb: ' + entry.gainDb)
      if (entry.fadeIn > 0) bits.push('fadeIn: ' + entry.fadeIn)
      if (entry.fadeOut > 0) bits.push('fadeOut: ' + entry.fadeOut)
      if (entry.loop) bits.push('loop: true')
      bindLines.push('    { ' + bits.join(', ') + ' }')

      var dawBits = ['name: ' + numberedString(entry.name), 'path: ' + numberedString(entry.path), 'at: ' + entry.at]
      if (entry.duration > 0) dawBits.push('duration: ' + round(entry.duration, 3))
      if (entry.gainDb !== 0) dawBits.push('gainDb: ' + entry.gainDb)
      if (entry.fadeIn > 0) dawBits.push('fadeIn: ' + entry.fadeIn)
      if (entry.fadeOut > 0) dawBits.push('fadeOut: ' + entry.fadeOut)
      dawLines.push('    { ' + dawBits.join(', ') + ' }')
      if (entry.loop) loops += 1
    }
    var json = JSON.stringify({ duration: end, cues: jsonCues }, null, 2)
    var bind = 'audio_bind({\\n  cues: [\\n' + bindLines.join(',\\n') + '\\n  ],\\n  out: ' + numberedString(bindPath) + ',\\n  duration: ' + end + '\\n})'
    var daw = 'audio_daw({\\n  format: "rpp",\\n  out: ' + numberedString(dawPath) + ',\\n  bpm: ' + state.bpm + ',\\n  cues: [\\n' + dawLines.join(',\\n') + '\\n  ]\\n})'
    var notes = []
    notes.push('共 ' + state.cues.length + ' 个 cue：' + plan.entries.length + ' 个进入导出')
    if (plan.skipped.length > 0) notes.push('跳过 ' + plan.skipped.length + ' 个（内联音频/远程/无路径）：' + plan.skipped.join('、'))
    if (plan.renamed > 0) notes.push('重名自动改号 ' + plan.renamed + ' 个')
    if (loops > 0) notes.push('audio_daw 的 rpp 不保存 loop，' + loops + ' 个 loop cue 会按单次放置')
    if (state.declaredDuration > 0 && state.declaredDuration < end - 0.001) notes.push('时间线 ' + fmt(end, 2) + 's 超过声明时长 ' + fmt(state.declaredDuration, 2) + 's')
    return { json: json, bind: bind, daw: daw, note: notes.join(' · '), entries: plan.entries.length }
  }

  function updateExports () {
    var pack = buildExports()
    state.pack = pack
    var texts = { json: pack.json, bind: pack.bind, daw: pack.daw }
    el.exportText.textContent = texts[state.tab] || ''
    setText(el.exportNote, pack.note)
  }

  function setTab (tab) {
    state.tab = tab
    var buttons = el.tabs.querySelectorAll('.tab')
    var i
    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].className = 'tab' + (buttons[i].getAttribute('data-tab') === tab ? ' active' : '')
    }
    var pack = state.pack || buildExports()
    state.pack = pack
    el.exportText.textContent = pack[tab] || ''
  }

  function copyExport () {
    var text = el.exportText.textContent || ''
    function fallback () {
      var range = document.createRange()
      range.selectNodeContents(el.exportText)
      var selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      try {
        document.execCommand('copy')
        setStatus('已复制（选区）', 'ok')
      } catch (error) {
        setStatus('复制失败：请手动选择文本', 'bad')
      }
      selection.removeAllRanges()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        var old = el.copy.textContent
        el.copy.textContent = '已复制'
        el.copy.className = 'ok'
        window.setTimeout(function () { el.copy.textContent = old; el.copy.className = '' }, 1200)
        setStatus('已复制到剪贴板', 'ok')
      }, fallback)
    } else {
      fallback()
    }
  }

  /* ---- load ---- */

  function applyProject (doc, label) {
    state.cues = doc.cues.map(toModel)
    state.declaredDuration = Number.isFinite(doc.duration) && doc.duration > 0 ? doc.duration : 0
    state.selected = state.cues.length > 0 ? 0 : -1
    state.readErrors = Object.create(null)
    state.buffers = Object.create(null)
    state.decoding = Object.create(null)
    stopPlayback()
    renderAll()
    if (state.cues.length === 0) {
      setStatus('载入的 cue 表是空的', 'bad')
      return
    }
    setStatus('已载入 ' + state.cues.length + ' 个 cue（' + label + '）', 'ok')
    decodeAll().then(function () { refreshStatus() })
  }

  function loadProjectPath (path) {
    if (!path) { setStatus('先填一个 .json 路径', 'bad'); return }
    setStatus('读取 ' + path + ' …')
    fetch(API.project + '?path=' + encodeURIComponent(path)).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body || body.ok !== true) {
          setStatus((body && body.error ? body.error : 'HTTP ' + response.status), 'bad')
          return null
        }
        return body
      }, function () {
        setStatus('HTTP ' + response.status + '：返回不是 JSON', 'bad')
        return null
      })
    }).then(function (body) {
      if (!body) return
      applyProject(normalizeDoc(body), path)
      el.projectPath.value = path
    }, function (error) {
      setStatus('读取失败：' + (error && error.message ? error.message : error), 'bad')
    })
  }

  function loadPaste () {
    var text = el.paste.value.trim()
    if (text === '') { setStatus('粘贴框是空的', 'bad'); return }
    var raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      setStatus('不是合法 JSON：' + error.message, 'bad')
      return
    }
    var doc
    try {
      doc = normalizeDoc(raw)
    } catch (error) {
      setStatus(error.message, 'bad')
      return
    }
    applyProject(doc, '粘贴内容')
  }

  /* ---- browse ---- */

  function browseRow (label, sizeText, onClick, dim) {
    var row = make('button', 'browse-row' + (dim ? ' dim' : ''))
    row.type = 'button'
    row.appendChild(make('span', null, label))
    if (sizeText) row.appendChild(make('span', 'sz', sizeText))
    if (onClick) row.addEventListener('click', onClick)
    return row
  }

  function renderBrowse (data) {
    el.browseBox.classList.remove('hidden')
    setText(el.browseDir, data.dir === '' ? '/' : data.dir)
    el.browseList.textContent = ''
    if (data.parent !== null && data.parent !== undefined) {
      el.browseList.appendChild(browseRow('.. 上级', '', function () { browse(data.parent) }))
    }
    var i
    for (i = 0; i < data.dirs.length; i += 1) {
      var dir = data.dirs[i]
      el.browseList.appendChild(browseRow(dir.path + '/', '', function (event) {
        browse(event.currentTarget.getAttribute('data-dir'))
      }, false))
      el.browseList.lastChild.setAttribute('data-dir', dir.path)
    }
    for (i = 0; i < data.files.length; i += 1) {
      var file = data.files[i]
      if (file.kind === 'json') {
        el.browseList.appendChild(browseRow(file.path, file.sizeText, function (event) {
          loadProjectPath(event.currentTarget.getAttribute('data-file'))
        }))
        el.browseList.lastChild.setAttribute('data-file', file.path)
      } else {
        el.browseList.appendChild(browseRow(file.path, file.sizeText, null, true))
      }
    }
    if (data.truncated) el.browseList.appendChild(browseRow('…… 条目过多，只显示前 ' + data.limit + ' 条', '', null, true))
  }

  function browse (dir) {
    var url = API.list + (dir ? '?dir=' + encodeURIComponent(dir) : '')
    fetch(url).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body || body.ok !== true) {
          setStatus(body && body.error ? body.error : 'HTTP ' + response.status, 'bad')
          return
        }
        state.browsing = body.dir
        renderBrowse(body)
      })
    }, function (error) {
      setStatus('浏览失败：' + (error && error.message ? error.message : error), 'bad')
    })
  }

  /* ---- events ---- */

  function bindEvents () {
    el.loadPath.addEventListener('click', function () { loadProjectPath(el.projectPath.value.trim()) })
    el.projectPath.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') loadProjectPath(el.projectPath.value.trim())
    })
    el.browse.addEventListener('click', function () {
      if (!el.browseBox.classList.contains('hidden')) { el.browseBox.classList.add('hidden'); return }
      browse(state.browsing || '')
    })
    el.browseUp.addEventListener('click', function () {
      var current = state.browsing || ''
      var parts = current.split('/')
      parts.pop()
      browse(parts.join('/'))
    })
    el.loadPaste.addEventListener('click', loadPaste)
    el.play.addEventListener('click', play)
    el.pause.addEventListener('click', pause)
    el.stop.addEventListener('click', stopPlayback)
    el.snap.addEventListener('change', function () {
      state.snap = el.snap.checked
      setStatus(state.snap ? '拖动吸附到 ' + state.bpm + ' BPM 网格' : '吸附已关闭', 'ok')
    })
    el.bpm.addEventListener('change', function () {
      var value = Number(el.bpm.value)
      if (Number.isFinite(value) && value >= 20 && value <= 300) {
        state.bpm = value
        layoutWidth()
        refreshStatus()
        updateExports()
      } else {
        el.bpm.value = String(state.bpm)
      }
    })
    el.zoom.addEventListener('input', function () {
      state.pps = Number(el.zoom.value)
      renderLanes()
      layoutWidth()
      refreshStatus()
    })
    el.fName.addEventListener('input', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      cue.name = el.fName.value
      updateCueVisual(state.selected)
      scheduleUi()
    })
    el.fAt.addEventListener('input', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      var value = Number(el.fAt.value)
      if (!Number.isFinite(value)) return
      cue.at = round(Math.max(0, value), 3)
      updateCueVisual(state.selected)
      scheduleUi()
    })
    el.fGain.addEventListener('input', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      var value = Number(el.fGain.value)
      if (!Number.isFinite(value)) return
      cue.gainDb = round(clamp(value, -60, 12), 1)
      updateCueVisual(state.selected)
      scheduleUi()
    })
    el.fIn.addEventListener('input', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      var value = Number(el.fIn.value)
      if (!Number.isFinite(value)) return
      cue.fadeIn = round(clamp(value, 0, Math.max(0, cueDuration(cue))), 3)
      updateCueVisual(state.selected)
      scheduleUi()
    })
    el.fOut.addEventListener('input', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      var value = Number(el.fOut.value)
      if (!Number.isFinite(value)) return
      cue.fadeOut = round(clamp(value, 0, Math.max(0, cueDuration(cue))), 3)
      updateCueVisual(state.selected)
      scheduleUi()
    })
    el.fLoop.addEventListener('change', function () {
      var cue = state.cues[state.selected]
      if (!cue) return
      cue.loop = el.fLoop.checked
      renderHeads()
      selectCue(state.selected)
      updateExports()
    })
    el.fAudition.addEventListener('click', auditionSelected)
    el.fDup.addEventListener('click', duplicateSelected)
    el.fDel.addEventListener('click', deleteSelected)
    el.outBind.addEventListener('input', updateExports)
    el.outRpp.addEventListener('input', updateExports)
    el.tabs.addEventListener('click', function (event) {
      var tab = event.target.getAttribute('data-tab')
      if (tab) setTab(tab)
    })
    el.copy.addEventListener('click', copyExport)
    document.addEventListener('keydown', function (event) {
      var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (state.selected < 0) return
      event.preventDefault()
      deleteSelected()
    })
    window.addEventListener('beforeunload', function () {
      if (state.active) stopSound()
    })
  }

  function duplicateSelected () {
    var cue = state.cues[state.selected]
    if (!cue) return
    var used = Object.create(null)
    var i
    for (i = 0; i < state.cues.length; i += 1) used[state.cues[i].name] = 1
    var copy = toModel(JSON.parse(JSON.stringify(cue)), state.cues.length)
    copy.name = uniqueName(cue.name + '-copy', used)
    state.cues.splice(state.selected + 1, 0, copy)
    state.selected += 1
    renderAll()
    decodeAll().then(function () { refreshStatus() })
    setStatus('已复制 ' + cue.name + ' → ' + copy.name, 'ok')
  }

  function deleteSelected () {
    var cue = state.cues[state.selected]
    if (!cue) return
    state.cues.splice(state.selected, 1)
    if (state.selected >= state.cues.length) state.selected = state.cues.length - 1
    renderAll()
    setStatus('已删除 ' + cue.name, 'ok')
  }

  /* ---- init ---- */

  function loadInfo () {
    fetch(API.info).then(function (response) {
      return response.json()
    }).then(function (body) {
      if (!body || body.ok !== true) throw new Error('info 返回异常')
      state.info = body
      setText(el.rootLabel, body.root)
      el.rootLabel.title = body.root + (body.rootSource ? '（来源：' + body.rootSource + '）' : '')
      setText(el.versionLabel, 'v' + body.version)
      refreshStatus()
    }).catch(function (error) {
      setStatus('无法读取编辑器信息：' + (error && error.message ? error.message : error), 'bad')
    })
  }

  function init () {
    el.status = byId('status')
    el.rootLabel = byId('root-label')
    el.versionLabel = byId('version-label')
    el.projectPath = byId('project-path')
    el.loadPath = byId('load-path')
    el.browse = byId('browse')
    el.browseBox = byId('browse-box')
    el.browseList = byId('browse-list')
    el.browseDir = byId('browse-dir')
    el.browseUp = byId('browse-up')
    el.paste = byId('paste')
    el.loadPaste = byId('load-paste')
    el.play = byId('play')
    el.pause = byId('pause')
    el.stop = byId('stop')
    el.snap = byId('snap')
    el.bpm = byId('bpm')
    el.zoom = byId('zoom')
    el.timelineInfo = byId('timeline-info')
    el.heads = byId('heads')
    el.lanes = byId('lanes')
    el.ruler = byId('ruler')
    el.inner = byId('inner')
    el.scroll = byId('scroll')
    el.playhead = byId('playhead')
    el.inspectorEmpty = byId('inspector-empty')
    el.inspectorBody = byId('inspector-body')
    el.fName = byId('f-name')
    el.fAt = byId('f-at')
    el.fGain = byId('f-gain')
    el.fIn = byId('f-in')
    el.fOut = byId('f-out')
    el.fLoop = byId('f-loop')
    el.fAudition = byId('f-audition')
    el.fDup = byId('f-dup')
    el.fDel = byId('f-del')
    el.readout = byId('f-readout')
    el.outBind = byId('out-bind')
    el.outRpp = byId('out-rpp')
    el.tabs = byId('tabs')
    el.copy = byId('copy')
    el.exportText = byId('export-text')
    el.exportNote = byId('export-note')
    bindEvents()
    renderAll()
    loadInfo()
    setStatus('就绪 · 等待载入 cue')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
`

/**
 * Render the whole page.
 * @param {{ version?: string }} [options] - plugin version shown in the header.
 * @returns {string} one complete HTML document, no external requests.
 */
export function renderEditorPage (options = {}) {
  const version = typeof options?.version === 'string' && options.version.trim() !== ''
    ? options.version.trim()
    : '0.0.0'
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="referrer" content="no-referrer">',
    '<title>cue 编辑器 · dsh-audiokit</title>',
    '<style>' + STYLE + '</style>',
    '</head>',
    '<body data-dsh-editor="1">',
    '<header class="top">',
    '<div class="brand"><span class="dot"></span><h1>cue 编辑器</h1><span class="ver" id="version-label">v' + escapeHtml(version) + '</span></div>',
    '<div class="root">工作区 <code id="root-label">…</code></div>',
    '<div class="status" id="status">就绪 · 等待载入 cue</div>',
    '</header>',
    '<main>',
    '<section class="panel">',
    '<div class="panel-head"><h2><span class="idx">01</span>载入</h2>',
    '<span class="muted">接受 audio_bind 的 cues 数组，或 {cues, duration} 形式的 cue 表；只读，不会改文件</span></div>',
    '<div class="row">',
    '<label class="grow">JSON 路径 <input type="text" id="project-path" placeholder="assets/audio/cues.json" spellcheck="false"></label>',
    '<button type="button" class="primary" id="load-path">载入</button>',
    '<button type="button" id="browse">浏览…</button>',
    '</div>',
    '<div class="browse hidden" id="browse-box">',
    '<div class="browse-head"><span id="browse-dir">/</span><span class="spacer"></span><button type="button" class="tiny" id="browse-up">上一级</button></div>',
    '<div id="browse-list"></div>',
    '</div>',
    '<details class="paste">',
    '<summary>或粘贴 cue JSON（只在浏览器里解析）</summary>',
    '<textarea id="paste" spellcheck="false" placeholder=\'[{"name":"hit","at":0.5,"path":"assets/audio/hit.wav","gainDb":-2}]\'></textarea>',
    '<div class="row"><button type="button" id="load-paste">解析粘贴内容</button><span class="muted">粘贴内容与读取的 wav 都留在本机。</span></div>',
    '</details>',
    '</section>',
    '<section class="panel">',
    '<div class="panel-head"><h2><span class="idx">02</span>时间线</h2><span class="muted">拖动 clip 改起点（Alt 临时关吸附），拖两侧把手改淡入/淡出</span></div>',
    '<div class="row" style="margin-bottom:10px">',
    '<button type="button" class="primary" id="play">播放</button>',
    '<button type="button" id="pause" disabled>暂停</button>',
    '<button type="button" id="stop" disabled>停止</button>',
    '<span class="muted">|</span>',
    '<label><input type="checkbox" id="snap" checked> 吸附</label>',
    '<label>BPM <input type="number" id="bpm" min="20" max="300" step="1" value="120" style="width:74px"></label>',
    '<label>缩放 <input type="range" id="zoom" min="8" max="400" step="1" value="80"></label>',
    '<span class="muted" id="timeline-info"></span>',
    '</div>',
    '<div class="editor-grid">',
    '<div class="tl">',
    '<div class="tl-heads" id="heads"></div>',
    '<div class="tl-scroll" id="scroll"><div class="tl-inner" id="inner">',
    '<canvas class="ruler" id="ruler" width="600" height="22"></canvas>',
    '<div class="lanes" id="lanes"></div>',
    '<div class="playhead hidden" id="playhead"></div>',
    '</div></div>',
    '</div>',
    '<aside class="inspector">',
    '<h3>选中 cue</h3>',
    '<div class="muted" id="inspector-empty">点一条轨道或 clip 来选中。</div>',
    '<div class="hidden" id="inspector-body">',
    '<div class="field"><span>名称</span><input type="text" id="f-name" spellcheck="false"></div>',
    '<div class="grid2">',
    '<div class="field"><span>起点 s</span><input type="number" id="f-at" step="0.001" min="0"></div>',
    '<div class="field"><span>增益 dB</span><input type="number" id="f-gain" step="0.5" min="-60" max="12"></div>',
    '<div class="field"><span>淡入 s</span><input type="number" id="f-in" step="0.01" min="0"></div>',
    '<div class="field"><span>淡出 s</span><input type="number" id="f-out" step="0.01" min="0"></div>',
    '</div>',
    '<label class="chk"><input type="checkbox" id="f-loop"> 循环到时间线末尾</label>',
    '<div class="readout" id="f-readout"></div>',
    '<div class="actions"><button type="button" id="f-audition">试听</button><button type="button" id="f-dup">复制</button><button type="button" class="danger" id="f-del">删除</button></div>',
    '</div>',
    '</aside>',
    '</div>',
    '</section>',
    '<section class="panel">',
    '<div class="panel-head"><h2><span class="idx">03</span>导出</h2><span class="muted">复制后交给 audio_bind / audio_daw，或下次再粘回这里继续编辑</span></div>',
    '<div class="row">',
    '<label>bind 输出 <input type="text" id="out-bind" value="assets/audio/cues-edited" spellcheck="false"></label>',
    '<label>rpp 输出 <input type="text" id="out-rpp" value="assets/audio/editor.rpp" spellcheck="false"></label>',
    '</div>',
    '<div class="tabs" id="tabs">',
    '<button type="button" class="tab active" data-tab="json">cue JSON</button>',
    '<button type="button" class="tab" data-tab="bind">audio_bind</button>',
    '<button type="button" class="tab" data-tab="daw">audio_daw</button>',
    '<span class="spacer"></span>',
    '<button type="button" id="copy">复制</button>',
    '</div>',
    '<pre class="export" id="export-text"></pre>',
    '<p class="note" id="export-note"></p>',
    '</section>',
    '</main>',
    '<script>' + PAGE_SCRIPT + '</' + 'script>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

/** Minimal HTML text escape for the few values interpolated into the markup. */
function escapeHtml (value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
