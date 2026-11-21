#!/usr/bin/env node
// Build demo/intro/index.html - one self-contained, network-free intro page.
// Reads spec.json, then (if present) audio/manifest.json + the wav files.
// Deterministic: same inputs -> byte-identical output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWavEx } from '../../dsh-audio-lab/plugin/lib/wav-encode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SPEC_PATH = path.join(HERE, 'spec.json');
const AUDIO_DIR = path.join(HERE, 'audio');
const PLUGIN_DIR = path.join(ROOT, 'dsh-audio');
const OUT = path.join(HERE, 'index.html');

const FALLBACK_TOOLS = ['audio_synth', 'audio_pattern', 'audio_design', 'audio_compose', 'audio_tts',
  'audio_voices', 'audio_sing', 'audio_lipsync', 'audio_beats', 'audio_bind', 'audio_mix',
  'audio_convert', 'audio_stretch', 'audio_loudness', 'audio_probe', 'audio_check', 'audio_regress'];

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const duration = Number(spec.meta.duration) || 16;

// ---------------------------------------------------------------- tool names
function readTools() {
  const found = new Set();
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) {
        let src = '';
        try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const re = /name:\s*['"](audio_[a-z_]+)['"]/g;
        let m;
        while ((m = re.exec(src))) found.add(m[1]);
      }
    }
  };
  walk(PLUGIN_DIR);
  const tools = [...found];
  const ok = tools.length >= 12 && FALLBACK_TOOLS.every((t) => found.has(t));
  return { tools: ok ? tools : FALLBACK_TOOLS, source: ok ? 'dsh-audio' : 'fallback' };
}

// --------------------------------------------------------------------- audio
// Decode 16-bit PCM wav -> mono Float32, then re-encode at 8-bit for the inline
// payload (base64 of 16-bit alone busts the 900 KB page budget). `bed` is a low
// pad, so it also drops to 11025 Hz; the rest stay at the source rate.
function decodeWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') { dataOff = body; dataLen = Math.min(size, buf.length - body); break; }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0 || !fmt.ch) return null;
  const bp = fmt.bits / 8, frames = Math.floor(dataLen / (bp * fmt.ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = dataOff + (i * fmt.ch + c) * bp;
      if (fmt.bits === 16) sum += buf.readInt16LE(o) / 32768;
      else if (fmt.bits === 8) sum += (buf.readUInt8(o) - 128) / 128;
      else if (fmt.bits === 24) sum += (buf.readUInt8(o) | (buf.readUInt8(o + 1) << 8) | (buf.readInt8(o + 2) << 16)) / 8388608;
      else if (fmt.bits === 32) sum += buf.readFloatLE(o);
    }
    out[i] = sum / fmt.ch;
  }
  return { samples: out, rate: fmt.rate, bits: fmt.bits, channels: fmt.ch };
}

function halveRate(s) { // 2:1 decimation with a light 3-tap pre-filter
  const n = Math.floor(s.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = s[i * 2], b = s[i * 2 + 1] ?? 0, p = i > 0 ? s[i * 2 - 1] : a;
    out[i] = p * 0.25 + a * 0.5 + b * 0.25;
  }
  return out;
}

function readAudio() {
  const entries = {}; // name -> {bytes, b64, at, gainDb, loop, rate, sourceBytes}
  const notes = [];
  if (!fs.existsSync(AUDIO_DIR)) return { entries, ready: false, notes: ['audio/ not found'] };

  let man = null;
  const manPath = path.join(AUDIO_DIR, 'manifest.json');
  if (fs.existsSync(manPath)) {
    try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); }
    catch (e) { notes.push('manifest.json unreadable: ' + e.message); }
  }
  let wavs = [];
  try { wavs = fs.readdirSync(AUDIO_DIR).filter((f) => /\.wav$/i.test(f)); } catch { /* ignore */ }

  // manifest.cues is the authority when present; otherwise match spec cues to wav basenames
  const cues = Array.isArray(man && man.cues)
    ? man.cues.filter((c) => c && c.name).map((c) => ({
      name: String(c.name), file: String(c.file || c.path || c.name + '.wav'),
      at: Number(c.at) || 0, gainDb: Number(c.gainDb) || 0, loop: !!c.loop,
    }))
    : wavs.map((w) => {
      const base = path.basename(w, path.extname(w));
      return { name: base, file: w, at: cueAt[base] != null ? cueAt[base] : 0, gainDb: 0, loop: false };
    });

  for (const c of cues) {
    const ap = path.isAbsolute(c.file) ? c.file : path.resolve(AUDIO_DIR, c.file);
    let buf;
    try { buf = fs.readFileSync(ap); } catch { notes.push('missing ' + c.file); continue; }
    if (buf.length < 2048) { notes.push('partial/empty ' + c.file); continue; }
    const dec = decodeWav(buf);
    if (!dec) { notes.push('undecodable ' + c.file); continue; }
    const isBed = c.name === 'bed';
    const rate = isBed && dec.rate >= 22050 ? Math.round(dec.rate / 2) : dec.rate;
    const samples = rate !== dec.rate ? halveRate(dec.samples) : dec.samples;
    const bytes = encodeWavEx(samples, rate, { bitDepth: 8, dither: true });
    entries[c.name] = {
      bytes: bytes.length, b64: bytes.toString('base64'), at: c.at,
      gainDb: c.gainDb, loop: c.loop, rate, sourceBytes: buf.length,
      seconds: samples.length / rate,
    };
  }
  return { entries, ready: Object.keys(entries).length > 0, notes };
}

const toolInfo = readTools();
const audio = readAudio();
const cueAt = {};
for (const c of spec.cues || []) cueAt[c.name] = Number(c.at) || 0;

const audioPayload = {};   // name -> {at, gain, loop, b64}
let audioBytes = 0, audioB64 = 0, sourceBytes = 0;
for (const [name, e] of Object.entries(audio.entries)) {
  audioBytes += e.bytes;
  sourceBytes += e.sourceBytes;
  audioB64 += e.b64.length;
  audioPayload[name] = {
    at: e.at, gain: e.gainDb, loop: e.loop, rate: e.rate,
    uri: 'data:audio/wav;base64,' + e.b64,   // inline payload, nothing is fetched
  };
}

const sceneIds = spec.scenes.map((s) => s.id);
const sceneZh = { silent: '静默', 'first-sound': '声音出现', vocabulary: '声音词汇', voice: '旁白与唱声', promise: '承诺' };
const zhLabels = {};
for (const id of sceneIds) zhLabels[id] = sceneZh[id] || id;

const embeddedSpec = {
  duration,
  // The copy travels with the scene so the canvas draws exactly what the
  // storyboard says; the HUD's short labels stay a separate, shorter layer.
  scenes: spec.scenes.map((s) => ({
    id: s.id,
    from: s.from,
    to: s.to,
    headline: s.headline ?? '',
    caption: s.caption ?? '',
    detail: s.detail ?? '',
  })),
  cues: (spec.cues || []).map((c) => ({ name: c.name, at: c.at })),
  audio: audio.ready ? Object.keys(audioPayload) : [],
};

const J = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------- page
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-audio · 给 HTML 动画加声音</title>
<style>
  :root{
    --bg:__BG__; --card:__CARD__; --text:__TEXT__; --muted:__MUTED__;
    --accent:__ACCENT__; --warn:__WARN__; --line:__LINE__;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%;background:var(--bg);color:var(--text);overflow:hidden}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Hiragino Sans GB",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  #stage{position:fixed;inset:0;display:block}
  #gate{
    position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:22px;background:radial-gradient(60% 60% at 50% 45%,#12202c 0%,#0b1219 70%);z-index:10;
    transition:opacity .45s ease;
  }
  #gate.hide{opacity:0;pointer-events:none}
  #gate h1{margin:0;font-size:clamp(28px,4.4vw,46px);font-weight:700;letter-spacing:.02em}
  #gate p{margin:0;color:var(--muted);font-size:15px;letter-spacing:.08em}
  #start{
    margin-top:6px;border:1px solid var(--line);background:rgba(90,209,200,.10);color:var(--accent);
    font:600 16px/1 inherit;padding:14px 34px;border-radius:999px;cursor:pointer;letter-spacing:.14em;
    transition:background .2s ease,transform .2s ease;
  }
  #start:hover{background:rgba(90,209,200,.2);transform:translateY(-1px)}
  #start:active{transform:translateY(0)}
  #gate .note{color:var(--warn);font-size:12.5px;letter-spacing:.06em;max-width:70ch;text-align:center;line-height:1.7}
  #replay{
    position:fixed;right:26px;bottom:24px;z-index:9;display:none;align-items:center;gap:10px;
    border:1px solid var(--line);background:rgba(22,32,46,.9);color:var(--text);
    font:600 13.5px/1 inherit;padding:12px 20px;border-radius:999px;cursor:pointer;letter-spacing:.1em;
    transition:border-color .2s ease,background .2s ease;
  }
  #replay.show{display:inline-flex}
  #replay:hover{border-color:var(--accent);background:rgba(90,209,200,.14)}
  #replay i{width:9px;height:9px;border-radius:2px;background:var(--accent);display:block}
  #hint{position:fixed;left:26px;bottom:26px;z-index:8;color:#546a80;font-size:11.5px;letter-spacing:.12em}
</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="gate">
  <h1>dsh-audio</h1>
  <p>给 HTML 动画加声音 · 16 秒</p>
  <button id="start" type="button">→ 点击开始</button>
  <div class="note" id="gate-note"></div>
</div>
  <button id="replay" type="button"><i></i>再看一遍</button>
  <div id="hint">AudioContext.currentTime 单一时钟 · 无网络请求</div>
<script type="application/json" id="intro-spec">__EMBED_SPEC__</script>
<script>
(function(){
  'use strict';
  var SPEC = __SPEC_JS__;
  var AUDIO = __AUDIO_JS__;
  var TOOLS = __TOOLS_JS__;
  var ZH = __ZH_JS__;

  var DUR = SPEC.duration;
  var CUE_AT = {};
  for (var ci = 0; ci < SPEC.cues.length; ci++) CUE_AT[SPEC.cues[ci].name] = SPEC.cues[ci].at;
  var AUDIO_NAMES = Object.keys(AUDIO);
  var CUE_LIST = AUDIO_NAMES.filter(function(n){ return (AUDIO[n].at || 0) > 0; });
  var AUDIO_OK = AUDIO_NAMES.length > 0;

  // ------------------------------------------------------------- palette
  var P = __PALETTE__;

  // ------------------------------------------------------------- helpers
  function clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smooth(v){ v = clamp01(v); return v * v * (3 - 2 * v); }
  function easeOut(v){ v = clamp01(v); return 1 - Math.pow(1 - v, 3); }
  function easeInOut(v){ v = clamp01(v); return v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2; }
  function backOut(v){ v = clamp01(v); var c = 1.70158; return 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2); }
  function lerp(a, b, u){ return a + (b - a) * u; }
  function rgba(hex, a){
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function sceneAt(t){
    for (var i = 0; i < SPEC.scenes.length; i++){
      var s = SPEC.scenes[i];
      if (t >= s.from && t < s.to) return s;
    }
    return SPEC.scenes[SPEC.scenes.length - 1];
  }
  function sceneIndex(id){
    for (var i = 0; i < SPEC.scenes.length; i++) if (SPEC.scenes[i].id === id) return i;
    return -1;
  }
  function sceneSpan(id){
    var i = sceneIndex(id); if (i < 0) return null;
    return SPEC.scenes[i];
  }

  // -------------------------------------------------------------- layout
  var W = 1000, H = 580;           // design space inside the card
  var HUD_H = 46;
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d', { alpha: false });
  var dpr = 1, cw = 0, ch = 0, ox = 0, oy = 0, scale = 1;

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth; ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    var pad = Math.max(20, Math.min(48, Math.min(cw, ch) * 0.055));
    scale = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
    ox = (cw - W * scale) / 2;
    oy = (ch - H * scale) / 2;
  }
  window.addEventListener('resize', resize);

  function rr(x, y, w, h, r){
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function txt(s, x, y, size, color, weight, align, alpha){
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.font = (weight || 400) + ' ' + size + 'px -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
    ctx.restore();
  }
  function mono(s, x, y, size, color, weight, align, alpha){
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.font = (weight || 500) + ' ' + size + 'px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
    ctx.restore();
  }

  // ------------------------------------------------------------- ball sim
  var GROUND = 404, BALL_R = 25, BALL_X = 500;
  var BOUNCE = (function(){
    var ys = [], vs = [], dt = 1 / 240, y = 96, v = 0, g = 940, rest = 0.63, t = 0, landings = [];
    var steps = Math.ceil((DUR + 0.5) / dt);
    var prevTouch = false;
    for (var i = 0; i < steps; i++){
      var floor = GROUND - BALL_R;
      v += g * dt;
      y += v * dt;
      var touch = false;
      if (y > floor){ y = floor; if (v > 90) { v = -v * rest; } else { v = 0; } touch = true; }
      if (touch && !prevTouch) landings.push(t);
      prevTouch = touch;
      ys.push(y); vs.push(v); t += dt;
    }
    return { ys: ys, vs: vs, dt: dt, landings: landings };
  })();
  function ballY(t){
    var i = Math.round(t / BOUNCE.dt);
    if (i < 0) i = 0;
    if (i >= BOUNCE.ys.length) i = BOUNCE.ys.length - 1;
    return BOUNCE.ys[i];
  }

  // ------------------------------------------------------------- logo mark
  function logoMark(x, y, r, prog, alpha){
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(P.accent, 0.30 + 0.5 * prog);
    ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke();
    ctx.strokeStyle = rgba(P.accent, 0.16);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2); ctx.stroke();
    var bars = 7, bw = r * 0.10, gap = r * 0.19;
    for (var i = 0; i < bars; i++){
      var u = (i - (bars - 1) / 2);
      var hh = (Math.sin(i * 1.7 + 0.6) * 0.5 + 0.5) * r * 0.55 + r * 0.12;
      var a = prog * (i / bars < prog ? 1 : 0);
      if (a <= 0) continue;
      ctx.globalAlpha = alpha * a;
      ctx.fillStyle = P.accent;
      rr(u * gap - bw / 2, -hh / 2, bw, hh, bw / 2); ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- HUD
  var lastSceneId = '';
  function drawHUD(t, active){
    ctx.save();
    ctx.fillStyle = rgba(P.bg, 0.35);
    ctx.fillRect(0, 0, W, HUD_H);
    ctx.strokeStyle = rgba(P.accent, 0.14);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, HUD_H + 0.5); ctx.lineTo(W, HUD_H + 0.5); ctx.stroke();

    var s = sceneAt(Math.min(t, DUR - 0.001));
    var label = ZH[s.id] || s.id;
    mono('t+ ' + t.toFixed(2).padStart(5, '0') + ' / ' + DUR.toFixed(2), 26, 28, 12.5, rgba(P.accent, 0.95), 600, 'left');
    mono(s.id, 168, 28, 12.5, P.muted, 500, 'left');
    txt(label, 168 + s.id.length * 7.6 + 14, 28, 12.5, rgba(P.muted, 0.8), 400, 'left');

    // scene progress pills
    var px = 420;
    for (var i = 0; i < SPEC.scenes.length; i++){
      var sc = SPEC.scenes[i];
      var on = t >= sc.from && t < sc.to;
      var done = t >= sc.to;
      ctx.globalAlpha = on ? 1 : (done ? 0.5 : 0.22);
      ctx.fillStyle = on ? P.accent : rgba(P.accent, 0.9);
      rr(px + i * 30, 21, 22, 5, 3); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // cue indicators
    var cx = W - 26;
    for (var k = CUE_LIST.length - 1; k >= 0; k--){
      var name = CUE_LIST[k];
      var at = AUDIO[name].at;
      var lit = t >= at - 0.05 && t < at + 0.45;
      var glow = lit ? Math.max(0, 1 - Math.max(0, t - at) / 0.45) : 0;
      var w = name.length * 6.9;
      mono(name, cx, 28, 11.5, lit ? P.accent : rgba(P.muted, 0.55), lit ? 600 : 400, 'right', lit ? 1 : 0.9);
      ctx.fillStyle = lit ? P.accent : rgba(P.muted, 0.35);
      ctx.beginPath(); ctx.arc(cx - w - 9, 24, 2.6 + glow * 1.6, 0, Math.PI * 2); ctx.fill();
      cx -= 96;
    }

    // audio status
    var status = AUDIO_OK ? ('AUDIO INLINE · ' + AUDIO_NAMES.length + ' 段') : '音频缺失 · 静音时钟';
    mono(status, W - 26, 40 + 0, 10.5, AUDIO_OK ? rgba(P.muted, 0.55) : P.warn, 500, 'right', 0.95);
    ctx.restore();
  }

  // ------------------------------------------------------------- scenes
  function sceneSilent(t, s){
    var end = s.to, from = s.from;
    var y = ballY(t);
    var floor = GROUND - BALL_R;
    var squash = 0;
    for (var i = 0; i < BOUNCE.landings.length; i++){
      var d = t - BOUNCE.landings[i];
      if (d >= 0 && d < 0.16) squash = Math.max(squash, (1 - d / 0.16) * 0.34);
    }
    // ground line
    ctx.save();
    ctx.strokeStyle = rgba(P.accent, 0.18);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(300, GROUND + 1); ctx.lineTo(700, GROUND + 1); ctx.stroke();
    ctx.restore();

    // ghost arc
    var g = smooth((t - 0.1) / 1.1);
    ctx.save();
    ctx.strokeStyle = rgba(P.muted, 0.16 * g);
    ctx.setLineDash([4, 7]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(BALL_X, floor, 120, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    ctx.restore();

    // ball
    var ry = y, rx = BALL_R * (1 + squash), rh = BALL_R * (1 - squash * 0.9);
    var bxc = BALL_X, byc = ry + BALL_R - rh;
    ctx.save();
    var grd = ctx.createRadialGradient(bxc - rx * 0.3, byc - rh * 0.3, 2, bxc, byc, rx);
    grd.addColorStop(0, rgba(P.text, 0.96));
    grd.addColorStop(0.55, rgba(P.accent, 0.92));
    grd.addColorStop(1, rgba(P.accent, 0.55));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.ellipse(bxc, byc, rx, rh, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // mute pill next to ball
    var ma = smooth((t - 0.45) / 0.5) * (1 - smooth((t - 2.15) / 0.3));
    if (ma > 0.01){
      ctx.save();
      ctx.globalAlpha = ma;
      var pw = 88, ph = 30, pxp = BALL_X + 78, pyp = byc - ph / 2;
      rr(pxp, pyp, pw, ph, 15);
      ctx.fillStyle = rgba(P.warn, 0.12); ctx.fill();
      ctx.strokeStyle = rgba(P.warn, 0.55); ctx.lineWidth = 1; ctx.stroke();
      // speaker + slash
      ctx.strokeStyle = rgba(P.warn, 0.9); ctx.fillStyle = rgba(P.warn, 0.9); ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(pxp + 16, pyp + 12); ctx.lineTo(pxp + 20, pyp + 12);
      ctx.lineTo(pxp + 25, pyp + 8); ctx.lineTo(pxp + 25, pyp + 22); ctx.lineTo(pxp + 20, pyp + 18);
      ctx.lineTo(pxp + 16, pyp + 18); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(pxp + 30, pyp + 10); ctx.lineTo(pxp + 38, pyp + 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pxp + 38, pyp + 10); ctx.lineTo(pxp + 30, pyp + 20); ctx.stroke();
      mono('静音', pxp + 46, pyp + 20, 12, rgba(P.warn, 0.95), 500, 'left');
      ctx.restore();
    }

    // copy (caption becomes the headline here; headline is empty in spec)
    var a = smooth((t - 1.2) / 0.7);
    txt(s.caption, 72, 508 - (1 - a) * 14, 44, P.text, 700, 'left', a);
    mono('// no audio · 静默', 74, 540, 13.5, rgba(P.muted, 0.85), 500, 'left', a);
  }

  function sceneFirstSound(t, s){
    var lt = t - s.from;                        // local time 0..
    var floor = GROUND - BALL_R;
    // impact flash + ring on the very frame the scene starts
    var ring = clamp01(lt / 0.85);
    if (ring < 1){
      ctx.save();
      ctx.strokeStyle = rgba(P.accent, (1 - ring) * 0.7);
      ctx.lineWidth = 8 * (1 - ring) + 1;
      ctx.beginPath(); ctx.arc(BALL_X, floor, 18 + easeOut(ring) * 210, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(P.text, (1 - ring) * 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(BALL_X, floor, 10 + easeOut(ring) * 120, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    var flash = Math.max(0, 1 - lt / 0.22);
    if (flash > 0){
      ctx.save();
      ctx.globalAlpha = flash * 0.18;
      ctx.fillStyle = P.accent;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // grid lights up
    var gr = smooth((lt - 0.05) / 0.9);
    ctx.save();
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= 10; gx++){
      var x = 72 + gx * (856 / 10);
      var a = gr * (0.10 + 0.16 * (1 - Math.abs(gx - 5) / 5));
      ctx.strokeStyle = rgba(P.accent, a);
      ctx.beginPath(); ctx.moveTo(x, 74); ctx.lineTo(x, 424); ctx.stroke();
    }
    for (var gy = 0; gy <= 7; gy++){
      var yy = 74 + gy * (350 / 7);
      ctx.strokeStyle = rgba(P.accent, gr * 0.07);
      ctx.beginPath(); ctx.moveTo(72, yy); ctx.lineTo(928, yy); ctx.stroke();
    }
    ctx.restore();

    // ripples behind ball
    for (var k = 1; k <= 3; k++){
      var p = clamp01((lt - k * 0.16) / 1.1);
      if (p <= 0 || p >= 1) continue;
      ctx.save();
      ctx.strokeStyle = rgba(P.accent, (1 - p) * 0.22);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(BALL_X, floor, 30 + easeOut(p) * 170, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = rgba(P.accent, 0.30);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(300, GROUND + 1); ctx.lineTo(700, GROUND + 1); ctx.stroke();
    // ball resting, squash pulse
    var sq = Math.max(0, 1 - lt / 0.3) * 0.32;
    var rx = BALL_R * (1 + sq), rh = BALL_R * (1 - sq * 0.9);
    var grd = ctx.createRadialGradient(BALL_X - rx * 0.3, floor - rh * 0.3, 2, BALL_X, floor, rx);
    grd.addColorStop(0, rgba(P.text, 0.96));
    grd.addColorStop(0.55, rgba(P.accent, 0.94));
    grd.addColorStop(1, rgba(P.accent, 0.6));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.ellipse(BALL_X, floor - rh * 0.5, rx, rh, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // headline scales in
    var sc = backOut((lt - 0.02) / 0.7);
    var ha = smooth((lt - 0.02) / 0.45);
    ctx.save();
    ctx.translate(72, 486);
    ctx.scale(0.86 + 0.14 * sc, 0.86 + 0.14 * sc);
    txt(s.headline, 0, 0, 64, P.text, 700, 'left', ha);
    ctx.restore();
    txt(s.caption, 74, 532, 20, P.accent, 500, 'left', smooth((lt - 0.28) / 0.55));
    txt(s.detail, 74, 556, 13.5, rgba(P.muted, 0.95), 400, 'left', smooth((lt - 0.5) / 0.6));
  }

  function sceneVocabulary(t, s){
    var lt = t - s.from;
    var headA = smooth(lt / 0.5);
    txt(s.headline, 72, 112, 34, P.text, 700, 'left', headA);
    txt(s.caption, 74, 144, 15.5, rgba(P.accent, 0.95), 500, 'left', smooth((lt - 0.12) / 0.5));
    txt(s.detail, 74, 168, 13, rgba(P.muted, 0.9), 400, 'left', smooth((lt - 0.24) / 0.5));

    var cols = 6, cw2 = 138, chh = 40, gapx = 12, gapy = 11;
    var totalW = cols * cw2 + (cols - 1) * gapx;
    var x0 = (W - totalW) / 2, y0 = 208;
    for (var i = 0; i < TOOLS.length; i++){
      var col = i % cols, row = Math.floor(i / cols);
      var start = 0.30 + i * 0.075;
      var u = (lt - start) / 0.42;
      if (u <= 0) continue;
      var e = backOut(u);
      var a = smooth(u * 1.6);
      var x = x0 + col * (cw2 + gapx);
      var y = 216 + row * (chh + gapy) + (1 - e) * 26;
      ctx.save();
      ctx.globalAlpha = a;
      var fresh = clamp01(1 - (lt - start) / 0.9);
      rr(x, y, cw2, chh, 9);
      ctx.fillStyle = rgba(P.card, 0.92);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = fresh > 0.02 ? rgba(P.accent, 0.28 + 0.6 * fresh) : rgba(P.accent, 0.16);
      ctx.stroke();
      if (fresh > 0.02){
        ctx.save();
        ctx.globalAlpha = a * fresh * 0.5;
        ctx.fillStyle = rgba(P.accent, 0.35);
        rr(x + 1, y + 1, cw2 - 2, chh - 2, 8); ctx.fill();
        ctx.restore();
      }
      mono(TOOLS[i], x + cw2 / 2, y + chh / 2 + 4.6, 11.6, fresh > 0.05 ? P.accent : rgba(P.text, 0.88), 500, 'center');
      // tick dot
      ctx.globalAlpha = a * (0.35 + 0.65 * fresh);
      ctx.fillStyle = fresh > 0.2 ? P.accent : rgba(P.accent, 0.5);
      ctx.beginPath(); ctx.arc(x + 12, y + chh / 2, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    mono(TOOLS.length + ' tools · 全部真实工具名', W / 2, 402, 11, rgba(P.muted, 0.6), 500, 'center', smooth((lt - 1.15) / 0.6));
  }

  function sceneVoice(t, s){
    var lt = t - s.from;
    var headA = smooth(lt / 0.5);
    txt(s.headline, 72, 112, 34, P.text, 700, 'left', headA);
    txt(s.caption, 74, 142, 14.5, rgba(P.accent, 0.95), 500, 'left', smooth((lt - 0.12) / 0.5));

    // waveform
    var waveA = smooth((lt - 0.1) / 0.5);
    var bars = 56, bw = 5, gap = 718 / bars;
    var cxb = 72 + 718 / 2, cyb = 236;
    ctx.save();
    ctx.globalAlpha = waveA;
    for (var i = 0; i < bars; i++){
      var u = i / (bars - 1);
      var phase = u * 9.2 - lt * 3.1;
      var env = Math.sin(Math.PI * u) * (0.55 + 0.45 * Math.sin(u * 13 + lt * 2));
      var amp = Math.abs(Math.sin(phase) * 0.7 + Math.sin(phase * 2.3 + 1.1) * 0.3) * env;
      var hh = 6 + amp * 74;
      var lit = u < (0.02 + lt * 0.34);
      ctx.fillStyle = lit ? rgba(P.accent, 0.92) : rgba(P.accent, 0.26);
      var x = 72 + i * gap;
      rr(x, cyb - hh / 2, bw, hh, bw / 2); ctx.fill();
    }
    ctx.restore();

    // playhead
    var ph = clamp01(lt / 3.4);
    ctx.save();
    ctx.globalAlpha = waveA * 0.55;
    ctx.strokeStyle = rgba(P.text, 0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(72 + ph * 718, cyb - 62); ctx.lineTo(72 + ph * 718, cyb + 62); ctx.stroke();
    ctx.restore();

    // mouth: viseme-ish morph
    var vis = [
      { w: 1.00, h: 0.34, a: 'AA' }, { w: 0.92, h: 0.16, a: 'EE' },
      { w: 0.74, h: 0.52, a: 'OH' }, { w: 0.86, h: 0.22, a: 'EH' },
      { w: 0.52, h: 0.14, a: 'MM' }, { w: 1.04, h: 0.40, a: 'AA' },
      { w: 0.78, h: 0.30, a: 'OO' }, { w: 0.70, h: 0.10, a: 'FF' }
    ];
    var step = 0.33;
    var k = lt / step;
    var k0 = Math.floor(k) % vis.length, k1 = (k0 + 1) % vis.length;
    var mu = smooth((k - Math.floor(k)) / 0.55);
    var vo = vis[k0], vx = vis[k1];
    var mw = lerp(vo.w, vx.w, mu), mh = lerp(vo.h, vx.h, mu);
    var mcx = 806, mcy = 168, base = 46;
    var mAW = base * mw * (1 + 0.04 * Math.sin(lt * 17));
    var mAH = 10 + base * mh * (0.9 + 0.1 * Math.sin(lt * 11 + 1));
    ctx.save();
    ctx.globalAlpha = smooth((lt - 0.15) / 0.5);
    ctx.strokeStyle = rgba(P.accent, 0.30);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(mcx, mcy, 76, 0, Math.PI * 2); ctx.stroke();
    // lips
    ctx.fillStyle = rgba(P.accent, 0.16);
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(mcx, mcy, mAW, mAH, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // teeth hint
    ctx.save();
    ctx.beginPath(); ctx.ellipse(mcx, mcy, mAW, mAH, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = rgba(P.text, 0.20);
    ctx.fillRect(mcx - mAW, mcy - mAH, mAW * 2, mAH * 0.62);
    ctx.restore();
    ctx.restore();
    mono((vo.a + '→' + vx.a), mcx, mcy + 104, 11, rgba(P.muted, 0.75), 500, 'center', smooth((lt - 0.3) / 0.5));

    // syllables
    var syl = ['给', '动', '画', '加', '声', '音'];
    var per = 0.46, sx0 = 72, sy = 404;
    for (var j = 0; j < syl.length; j++){
      var st = 0.25 + j * per;
      var on = lt >= st && lt < st + per;
      var a = smooth((lt - st) / 0.18);
      if (a <= 0.01) continue;
      var sPos = sx0 + j * 54;
      if (on){
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = P.accent;
        rr(sPos - 6, sy - 34, 44, 46, 10); ctx.fill();
        ctx.restore();
      }
      txt(syl[j], sPos + 16, sy, 30, on ? P.accent : rgba(P.text, 0.72), on ? 700 : 500, 'center', a);
    }
    txt(s.detail, 74, 556, 12.5, rgba(P.muted, 0.9), 400, 'left', smooth((lt - 0.7) / 0.6));
  }

  function scenePromise(t, s){
    var lt = t - s.from;
    // flatline that folds into the mark
    var flat = smooth(lt / 0.7);
    var cxb = W / 2, cyb = 208;
    ctx.save();
    ctx.strokeStyle = rgba(P.accent, 0.55 * (1 - flat * 0.75));
    ctx.lineWidth = 1.6;
    var half = 250 * (1 - flat * 0.55);
    var amp = 26 * (1 - flat);
    ctx.beginPath();
    for (var i = 0; i <= 80; i++){
      var u = i / 80, x = cxb - half + u * half * 2;
      var y = cyb + Math.sin(u * 22 + lt * 4) * amp * Math.sin(Math.PI * u);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    logoMark(cxb, cyb, 62, smooth((lt - 0.45) / 0.8), smooth((lt - 0.4) / 0.6));

    var ha = smooth((lt - 0.55) / 0.6);
    txt(s.headline, W / 2, 366 - (1 - ha) * 12, 40, P.text, 700, 'center', ha);
    txt(s.caption, W / 2, 402, 15, rgba(P.accent, 0.95), 500, 'center', smooth((lt - 0.75) / 0.6));

    // install line types in
    var typeStart = 0.95, cps = 42;
    var full = 'install_bundle  target: dsh-audio';
    var n = Math.min(full.length, Math.floor(Math.max(0, lt - typeStart) * cps));
    var shown = full.slice(0, n);
    var ta = smooth((lt - typeStart + 0.1) / 0.3);
    if (ta > 0.01){
      var boxW = 470, boxH = 46, bx = (W - boxW) / 2, by = 440;
      ctx.save();
      ctx.globalAlpha = ta;
      rr(bx, by, boxW, boxH, 10);
      ctx.fillStyle = rgba(P.card, 1); ctx.fill();
      ctx.strokeStyle = rgba(P.accent, 0.24); ctx.lineWidth = 1; ctx.stroke();
      mono('$', bx + 20, by + 29, 13, rgba(P.muted, 0.9), 500, 'left');
      mono(shown, bx + 38, by + 29, 13.5, P.text, 500, 'left');
      if (Math.floor(lt * 2.4) % 2 === 0 || n < full.length){
        var wShown = ctx.measureText(shown).width;
        ctx.fillStyle = P.accent;
        ctx.fillRect(bx + 40 + (n > 0 ? wShown : 0), by + 16, 8, 18);
      }
      ctx.restore();
    }
    mono('single file · 16.0s · no network', W / 2, 512, 11, rgba(P.muted, 0.6), 500, 'center', smooth((lt - 1.05) / 0.6));
  }

  // ------------------------------------------------------------- frame
  var DRAW = {
    'silent': sceneSilent,
    'first-sound': sceneFirstSound,
    'vocabulary': sceneVocabulary,
    'voice': sceneVoice,
    'promise': scenePromise
  };

  function render(t){
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, cw, ch);
    // ambient wash
    var g0 = ctx.createRadialGradient(cw * 0.5, ch * 0.42, 10, cw * 0.5, ch * 0.42, Math.max(cw, ch) * 0.62);
    g0.addColorStop(0, rgba(P.accent, 0.055));
    g0.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g0;
    ctx.fillRect(0, 0, cw, ch);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    // card
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 46;
    ctx.shadowOffsetY = 16;
    rr(0, 0, W, H, 22);
    ctx.fillStyle = P.card;
    ctx.fill();
    ctx.restore();
    ctx.save();
    rr(0.5, 0.5, W - 1, H - 1, 22);
    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // clip content to card
    ctx.save();
    rr(0, 0, W, H, 22);
    ctx.clip();
    ctx.fillStyle = rgba(P.card, 0.5);
    ctx.fillRect(0, 0, W, H);
    drawHUD(t, true);

    var s = sceneAt(Math.min(t, DUR - 0.001));
    var fn = DRAW[s.id];
    ctx.save();
    if (fn) fn(Math.max(0, t), s);
    ctx.restore();

    // scene cross-fade veil
    var si = sceneIndex(s.id);
    if (si > 0){
      var lt = t - s.from;
      if (lt < 0.18){
        ctx.globalAlpha = (1 - lt / 0.18) * 0.55;
        ctx.fillStyle = P.bg;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    // finished state -> replay affordance handled by DOM button
    if (t >= DUR - 0.02) replayBtn.classList.add('show');
  }

  // ------------------------------------------------------------- clock
  var ac = null, t0 = 0, sources = [], started = false, raf = 0, finished = false;
  var lastT = 0;

  function ensureCtx(){
    if (ac) return ac;
    var AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    // silent keep-alive so currentTime advances even without audio payload
    var g = ac.createGain();
    g.gain.value = 0;
    var osc = ac.createOscillator();
    osc.frequency.value = 30;
    osc.connect(g); g.connect(ac.destination);
    osc.start();
    return ac;
  }

  function scheduleAudio(){
    var when = t0;
    for (var i = 0; i < AUDIO_NAMES.length; i++){
      var name = AUDIO_NAMES[i];
      var item = AUDIO[name];
      var comma = item.uri.indexOf(',');
      var raw = atob(item.uri.slice(comma + 1));
      var buf = new ArrayBuffer(raw.length);
      var view = new Uint8Array(buf);
      for (var j = 0; j < raw.length; j++) view[j] = raw.charCodeAt(j);
      var src = ac.createBufferSource();
      var node = ac.createGain();
      var g = Math.pow(10, (item.gain || 0) / 20);
      node.gain.value = g * (item.loop ? 0.72 : 0.92);
      src.connect(node); node.connect(ac.destination);
      if (item.loop) src.loop = true;
      ac.decodeAudioData(buf, (function(s, it){
        return function(decoded){
          s.buffer = decoded;
          try {
            s.start(t0 + it.at);
            if (it.loop) s.stop(t0 + DUR + 0.02);
          } catch (e) {}
        };
      })(src, item), function(){ /* decode failure: stay silent */ });
      sources.push(src);
    }
  }

  function stopAudio(){
    for (var i = 0; i < sources.length; i++){
      try { sources[i].stop(); } catch (e) {}
      try { sources[i].disconnect(); } catch (e) {}
    }
    sources = [];
  }

  function loop(){
    raf = requestAnimationFrame(loop);
    if (!started) return;
    var t = ac.currentTime - t0;
    if (t < 0) t = 0;
    if (t > DUR) t = DUR;
    lastT = t;
    render(t);
    if (t >= DUR && !finished){ finished = true; }
  }

  function startRun(){
    ensureCtx();
    if (ac.state === 'suspended') ac.resume();
    stopAudio();
    finished = false;
    replayBtn.classList.remove('show');
    t0 = ac.currentTime + 0.10;
    scheduleAudio();
    started = true;
    render(0);
  }

  // ------------------------------------------------------------- wiring
  var gate = document.getElementById('gate');
  var startBtn = document.getElementById('start');
  var replayBtn = document.getElementById('replay');
  var gateNote = document.getElementById('gate-note');

  if (!AUDIO_OK){
    gateNote.textContent = '音频尚未生成 —— 本次为静音时钟回退（视觉完整，无声音）。';
    if (window.console) console.warn('[intro] audio missing: running on silent clock fallback');
  }

  startBtn.addEventListener('click', function(){
    startBtn.disabled = true;
    gate.classList.add('hide');
    setTimeout(function(){ gate.style.display = 'none'; }, 460);
    startRun();
    if (!raf) loop();
  });

  replayBtn.addEventListener('click', function(){
    if (ac.state === 'suspended') ac.resume();
    startRun();
  });

  window.addEventListener('keydown', function(ev){
    if (ev.key === ' ' && started && lastT >= DUR - 0.05){ startRun(); }
  });

  resize();
  render(0);
  if (!raf) loop();

  // diagnostic hook (no network, no timers driving visuals)
  window.__intro = {
    get t(){ return started ? Math.min(DUR, Math.max(0, ac.currentTime - t0)) : 0; },
    duration: DUR, audio: AUDIO_NAMES, scenes: SPEC.scenes
  };
})();
</script>
</body>
</html>
`;

const pal = spec.meta.palette || {};
const html = PAGE
  .replace('__BG__', pal.bg || '#0b1219')
  .replace('__CARD__', pal.card || '#16202e')
  .replace('__TEXT__', pal.text || '#e8eef5')
  .replace('__MUTED__', pal.muted || '#8fa3b8')
  .replace('__ACCENT__', pal.accent || '#5ad1c8')
  .replace('__WARN__', pal.warn || '#f5a623')
  .replace('__LINE__', pal.line || 'rgba(90,209,200,0.28)')
  .replace('__PALETTE__', () => J({
  bg: pal.bg || '#0b1219', card: pal.card || '#16202e', text: pal.text || '#e8eef5',
  muted: pal.muted || '#8fa3b8', accent: pal.accent || '#5ad1c8', warn: pal.warn || '#f5a623',
  line: pal.line || 'rgba(90,209,200,0.28)',
}))
  .replace('__EMBED_SPEC__', () => J(embeddedSpec))
  .replace('__SPEC_JS__', () => J(embeddedSpec))
  .replace('__AUDIO_JS__', () => J(audioPayload))
  .replace('__TOOLS_JS__', () => J(toolInfo.tools))
  .replace('__ZH_JS__', () => J(zhLabels));

fs.writeFileSync(OUT, html, 'utf8');

// ------------------------------------------------------------------- report
const total = Buffer.byteLength(html, 'utf8');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const markupEnd = html.indexOf('<canvas');
const markupEnd2 = html.indexOf('<script type="application/json"');
const cssStart = html.indexOf('<style>');
const cssEnd = html.indexOf('</style>');
const jsonStart = html.indexOf('id="intro-spec">') + 'id="intro-spec">'.length;
const jsonEnd = html.indexOf('</script>', jsonStart);
const lastScript = html.lastIndexOf('<script>');
const jsEnd = html.lastIndexOf('</script>');
const cssBytes = cssEnd - cssStart;
const jsonBytes = jsonEnd - jsonStart;
const jsBytes = jsEnd - lastScript;
const markupBytes = total - cssBytes - jsonBytes - jsBytes;

console.log('built  : ' + path.relative(ROOT, OUT).replace(/\\/g, '/'));
console.log('size   : ' + kb(total) + '  (' + total + ' B)');
console.log('  audio : ' + kb(audioB64) + ' base64 of ' + kb(audioBytes) + ' wav  [' + Object.keys(audioPayload).length + ' payloads]');
console.log('  script: ' + kb(jsBytes));
console.log('  css   : ' + kb(cssBytes));
console.log('  spec  : ' + kb(jsonBytes) + ' json');
console.log('  markup: ' + kb(markupBytes));
console.log('scenes : ' + spec.scenes.length + '  (' + sceneIds.join(', ') + ')');
console.log('cues   : ' + (spec.cues || []).length + '  (' + (spec.cues || []).map((c) => c.name + '@' + c.at).join(', ') + ')');
console.log('tools  : ' + toolInfo.tools.length + ' from ' + toolInfo.source);
console.log('audio  : ' + (audio.ready
  ? 'INLINED 8-bit — ' + Object.keys(audioPayload).map((n) => n + '=' + kb(audio.entries[n].bytes) + '@' + audio.entries[n].rate + 'Hz/' + audio.entries[n].seconds.toFixed(3) + 's').join(', ')
  : 'missing'));
console.log('         source 16-bit wavs ' + kb(sourceBytes) + ' -> inline 8-bit ' + kb(audioBytes) + ' (base64 ' + kb(audioB64) + ')');
if (total > (spec.requirements.sizeBudgetKB || 900) * 1024) {
  console.log('WARN   : over ' + (spec.requirements.sizeBudgetKB || 900) + ' KB budget — trim audio payload');
}
for (const n of audio.notes) console.log('note   : ' + n);
if (!audio.ready) {
  console.log('audio missing — rebuild after the audio worker finishes');
  console.log('rebuild: node demo/intro/build.mjs');
}
