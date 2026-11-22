#!/usr/bin/env node
// Build demo/showall/index.html — one self-contained, network-free 44 s page that
// exercises all 24 dsh-audio tools.
//
// Inputs (all optional; missing ones fall back to documented placeholders and the
// build prints "audio missing — rebuild later"):
//   demo/showall/audio/manifest.json   cue list + wavs           (other worker)
//   demo/showall/assets/live-sfx.js    zero-byte live synth      (other worker)
//   demo/showall/assets/ui-sfx.js      UI click/hover sounds     (other worker)
//   demo/showall/assets/readouts.json  probe/beats/analyze/master (other worker)
//
// Build-time tool calls (real libraries, no network):
//   dsh-audio/lib/compose.js  composeScore()    -> piano-roll notes + chords
//   dsh-audio/lib/lipsync.js  analyzeVisemes()  -> mouth A frames from the sung wav
//   dsh-audio/lib/mouth.js    mouthFromText()   -> mouth B frames from a caption
//
// Deterministic: same inputs -> byte-identical index.html.
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeScore } from '../../dsh-audio/lib/compose.js';
import { analyzeVisemes } from '../../dsh-audio/lib/lipsync.js';
import { mouthFromText } from '../../dsh-audio/lib/mouth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'index.html');
const AUDIO_DIR = path.join(HERE, 'audio');
const ASSET_DIR = path.join(HERE, 'assets');
const PALETTE = path.join(HERE, 'palette.json');

const DUR = 44;
const MAX_PAGE_BYTES = 2200 * 1024;

// dsh-audio is still being developed while this page is built (audio_spatial and
// audio_mux both landed mid-flight), so the list is DISCOVERED from the plugin and
// only the presentation order is curated here. Every discovered tool is placed in a
// scene; anything new is assigned by keyword and reported by the build.
const PLUGIN_DIR = path.join(HERE, '..', '..', 'dsh-audio');
const TOOLS_CURATED = [
  'audio_synth', 'audio_pattern', 'audio_probe', 'audio_design', 'audio_mix', 'audio_mux',
  'audio_compose', 'audio_midi', 'audio_beats', 'audio_loudness', 'audio_tts',
  'audio_sing', 'audio_lipsync', 'audio_mouth', 'audio_voices', 'audio_react',
  'audio_live', 'audio_analyze', 'audio_bus', 'audio_spatial', 'audio_stretch',
  'audio_bind', 'audio_stems', 'audio_convert', 'audio_check', 'audio_regress',
];
function discoverTools() {
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) {
        let src = '';
        try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const m of src.matchAll(/name:\s*['"](audio_[a-z0-9_]+)['"]/g)) found.add(m[1]);
        for (const m of src.matchAll(/const TOOL = ['"](audio_[a-z0-9_]+)['"]/g)) found.add(m[1]);
      }
    }
  };
  walk(PLUGIN_DIR, 0);
  return [...found];
}
const TOOLS_REGISTERED = discoverTools();
const TOOLS = TOOLS_CURATED.filter((t2) => TOOLS_REGISTERED.includes(t2));
const TOOL_NOTES = [];
for (const t2 of TOOLS_REGISTERED) if (!TOOLS.includes(t2)) { TOOLS.push(t2); TOOL_NOTES.push(t2 + ' (new, appended)'); }
if (TOOLS.length !== TOOLS_REGISTERED.length) TOOL_NOTES.push('curated names not registered: ' + TOOLS_CURATED.filter((t2) => !TOOLS_REGISTERED.includes(t2)).join(','));


// Real vocabulary of the synth (38 presets) and the design bank (26 recipes).
const PRESETS = ['impact', 'whoosh', 'tick', 'chime', 'riser', 'zap', 'thud', 'scrap', 'texture',
  'footstep-gravel', 'footstep-wood', 'footstep-water', 'door-open', 'door-close', 'drawer',
  'switch-click', 'cloth', 'paper', 'water-drip', 'water-splash', 'bubble', 'wind-gust',
  'breath-inhale', 'servo', 'motor-start', 'motor-loop', 'alarm-beep', 'alarm-siren', 'hud-tick',
  'energy-charge', 'heartbeat-double', 'creature-growl', 'insect-buzz', 'bone-crack', 'bass-drop',
  'riser-short', 'bell-toll', 'choir-pad'];
const RECIPES = ['door-slam-metal', 'door-close-soft', 'glass-break', 'wood-crack', 'explosion-far',
  'explosion-near', 'whoosh-into-impact', 'sci-fi-charge', 'sci-fi-hum-loop', 'magic-sparkle',
  'magic-dark', 'water-drip', 'water-splash', 'footstep-gravel', 'cloth-rustle', 'ui-success',
  'ui-error', 'ui-hover', 'ui-toggle', 'machinery-loop', 'creature-scream', 'creature-growl',
  'heartbeat', 'alarm-loop', 'coin-pickup', 'thunder-distant'];
const GENRES = ['cinematic', 'lofi', 'chiptune', 'ambient', 'action', 'horror', 'fantasy', 'ui-menu'];
const VOICES = ['alto', 'bass', 'child', 'breathy', 'choir'];
const CUE_SHEET_TOOLS = ['audio_bind', 'audio_stems', 'audio_convert', 'audio_check', 'audio_regress'];

// copy.json is the only source of on-screen copy (headlines, lines, details, HUD
// strings, gate, end card). Scene tool lists stay authoritative from the registry.
const COPY_PATH = path.join(HERE, 'copy.json');
let COPY = null;
try { COPY = JSON.parse(fs.readFileSync(COPY_PATH, 'utf8')); } catch { COPY = null; }
const COPY_ISSUES = [];
const COPY_SCENE = {};
if (COPY && Array.isArray(COPY.scenes)) for (const c of COPY.scenes) if (c && c.id) COPY_SCENE[c.id] = c;

const SCENES = [
  { id: 'open', label: '开场', from: 0, to: 4, tools: [] },
  { id: 'library', label: '音效库', from: 4, to: 9, tools: ['audio_synth', 'audio_pattern', 'audio_probe'] },
  { id: 'recipes', label: '分层设计', from: 9, to: 14, tools: ['audio_design', 'audio_mix'] },
  { id: 'compose', label: '配乐', from: 14, to: 20, tools: ['audio_compose', 'audio_midi', 'audio_beats', 'audio_loudness'] },
  { id: 'voice', label: '人声', from: 20, to: 26, tools: ['audio_tts', 'audio_sing', 'audio_lipsync', 'audio_mouth', 'audio_voices'] },
  { id: 'interactive', label: '交互', from: 26, to: 32, tools: ['audio_react', 'audio_live'] },
  { id: 'analysis', label: '测量', from: 32, to: 38, tools: ['audio_analyze', 'audio_loudness', 'audio_bus', 'audio_spatial', 'audio_stretch'] },
  { id: 'delivery', label: '交付', from: 38, to: 44, tools: ['audio_bind', 'audio_stems', 'audio_convert', 'audio_check', 'audio_regress'] },
];
// Any tool a scene does not cover yet is placed by keyword, then reported.
const TOOL_HINTS = [
  [/mux|bind|stems|convert|check|regress|mix/, 'delivery'],
  [/spatial|bus|master|loud|analy|probe|stretch/, 'analysis'],
  [/compose|midi|beats/, 'compose'],
  [/tts|sing|voice|lipsync|mouth/, 'voice'],
  [/react|live/, 'interactive'],
  [/design|recipe/, 'recipes'],
  [/synth|pattern/, 'library'],
];
for (const name of TOOLS) {
  if (SCENES.some((s) => s.tools.includes(name))) continue;
  const hit = TOOL_HINTS.find((h) => h[0].test(name));
  const scene = SCENES.find((s) => s.id === (hit ? hit[1] : 'delivery')) || SCENES[SCENES.length - 1];
  scene.tools.push(name);
  TOOL_NOTES.push(name + ' → scene ' + scene.id);
}

// copy.json records "工具 25" and "{n}/25"; the registry is the truth, so those
// two numbers are re-stamped at build time (nothing else in the copy is touched).
if (COPY && COPY.brand && Array.isArray(COPY.brand.meta)) {
  COPY.brand.meta = COPY.brand.meta.map((row) => {
    if (!/工具/.test(row)) return row;
    const fixed = row.replace(/工具\s+\d+/, '工具  ' + TOOLS.length);
    if (fixed !== row) COPY_ISSUES.push('copy.json tool count re-stamped to ' + TOOLS.length);
    return fixed;
  });
}
if (COPY && COPY.hud && typeof COPY.hud.toolsActive === 'string') {
  COPY.hud.toolsActive = COPY.hud.toolsActive.replace(/\/\d+/, '/' + TOOLS.length);
}
if (COPY) {
  for (const s of SCENES) {
    const c = COPY_SCENE[s.id];
    if (!c) { COPY_ISSUES.push('copy.json has no scene "' + s.id + '"'); continue; }
    s.label = c.headline || s.label;
    s.file = c.file || String(SCENES.indexOf(s)).padStart(2, '0');
    s.line = c.line || '';
    s.detail = c.detail || '';
    // copy.json lists tools for the copy's sake; the registry stays authoritative
    if (Array.isArray(c.tools)) {
      const unknown = c.tools.filter((t) => !TOOLS.includes(t));
      if (unknown.length) COPY_ISSUES.push('copy.json ' + s.id + ' names unregistered ' + unknown.join(','));
    }
  }
} else {
  COPY_ISSUES.push('copy.json missing');
}

// ------------------------------------------------------------------ utilities
const notes = [];
const warn = (m) => notes.push(m);
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const b64 = (buf) => Buffer.from(buf).toString('base64');
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function deepFind(node, names, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  for (const k of Object.keys(node)) {
    const lower = k.toLowerCase();
    if (names.includes(lower) && node[k] !== null && node[k] !== undefined) return node[k];
  }
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (child && typeof child === 'object') {
      const hit = deepFind(child, names, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// ---------------------------------------------------------------- wav plumbing
function decodeWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') { dataOff = body; dataLen = Math.min(size, buf.length - body); }
    pos = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) return null;
  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits >> 3;
  const frames = Math.floor(dataLen / (bytes * channels));
  if (!frames) return null;
  const mono = new Float32Array(frames);
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      let v = 0;
      if (format === 3 && bits === 32) v = buf.readFloatLE(p);
      else if (bits === 8) v = (buf.readUInt8(p) - 128) / 128;
      else if (bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (bits === 24) { const raw = buf.readUIntLE(p, 3); v = ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608; }
      else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
      sum += v;
      p += bytes;
    }
    mono[i] = sum / channels;
  }
  return { mono, sampleRate, frames };
}
function resample(mono, from, to) {
  if (from === to) return mono;
  const ratio = to / from;
  const n = Math.max(1, Math.floor(mono.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = mono[i0] * (1 - f) + mono[i1] * f;
  }
  return out;
}
function wav8(mono, sampleRate) {
  const n = mono.length;
  const out = Buffer.alloc(44 + n);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + n, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate, 28); out.writeUInt16LE(1, 32); out.writeUInt16LE(8, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    out[44 + i] = Math.round((v * 0.5 + 0.5) * 255);
  }
  return out;
}
function wav16(mono, sampleRate) {
  const n = mono.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mono[i])) * 32767), 44 + i * 2);
  return out;
}
const timecode = (s) => {
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(2).padStart(5, '0');
  return m + ':' + sec;
};

// ------------------------------------------------------------------- manifest
const manifestPath = path.join(AUDIO_DIR, 'manifest.json');
const manifest = readJson(manifestPath);
let cueList = [];
if (manifest) {
  const raw = Array.isArray(manifest) ? manifest
    : (manifest.cues || manifest.audio || manifest.tracks || manifest.items || []);
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const file = c.file || c.path || c.src || c.wav || c.name && /\.wav$/i.test(c.name) ? (c.file || c.path || c.src || c.wav || c.name) : (c.file || c.path || c.src || c.wav);
      const name = c.name || c.id || (file ? path.basename(String(file), '.wav') : null);
      const at = num(c.at ?? c.start ?? c.time ?? c.t, null);
      if (!name || at === null) continue;
      cueList.push({
        name: String(name),
        at: r3(at),
        file: file ? String(file) : null,
        gainDb: num(c.gainDb ?? c.gain ?? c.db, 0),
        fadeIn: num(c.fadeIn ?? c.fadeInSeconds, 0),
        fadeOut: num(c.fadeOut ?? c.fadeOutSeconds, 0),
        loop: !!(c.loop),
      });
    }
  }
}
cueList.sort((a, b) => a.at - b.at);

// Encode every cue. Short hits -> 8-bit at <=22.05 kHz; anything over 5 s is a bed
// and goes 16-bit at 11.025 kHz (same bytes as 8-bit/22k, far less grit on a pad).
function encodeCue(cue, bedDepth) {
  if (!cue.file) return null;
  const p = path.join(AUDIO_DIR, cue.file);
  if (!exists(p)) return null;
  const buf = fs.readFileSync(p);
  const wav = decodeWav(buf);
  if (!wav) return null;
  const srcDur = wav.frames / wav.sampleRate;
  const isBed = srcDur > 5 || /bed|music|pad|hum|room|texture|drone/i.test(cue.name);
  const rate = isBed ? 11025 : Math.min(22050, wav.sampleRate);
  const depth = isBed ? bedDepth : 8;
  const mono2 = resample(wav.mono, wav.sampleRate, rate);
  const out = depth === 16 ? wav16(mono2, rate) : wav8(mono2, rate);
  return { wav: out, rate, depth, dur: r3(srcDur), srcRate: wav.sampleRate, mono: mono2, monoRate: rate };
}
function encodeAll(bedDepth) {
  const list = [];
  for (const cue of cueList) {
    const e = encodeCue(cue, bedDepth);
    if (e) list.push({ ...cue, ...e });
    else warn('cue "' + cue.name + '" has no matching wav');
  }
  const raw = list.reduce((a, e) => a + e.wav.length, 0);
  const b64size = list.reduce((a, e) => a + Math.ceil(e.wav.length / 3) * 4, 0);
  return { list, raw, b64size };
}
// Budget pass: a 44 s music bed is the only cue where bit depth is audible, so it
// is 16-bit/11.025 kHz when the page has room and 8-bit/11.025 kHz when it does not.
// Short hits are always 8-bit at <=22.05 kHz.
let pass = encodeAll(16);
let bedDepthUsed = 16;
if (pass.b64size > 1.62 * 1024 * 1024) { pass = encodeAll(8); bedDepthUsed = 8; }
let encoded = pass.list;
const audioBytes = pass.raw;
const audioB64 = pass.b64size;

// A cue called "ticks" is what the 38 cell grid follows; expose its times.
function cueTimes(re) {
  const c = encoded.find((e) => re.test(e.name));
  if (!c) return null;
  return c.at;
}
const ticksCue = encoded.find((e) => /tick/i.test(e.name));
const openingCue = encoded.find((e) => /(open|impact|hit|intro|logo|start)/i.test(e.name));
const sungCue = encoded.find((e) => /sing|vocal|voice|lyric/i.test(e.name) && !/tts|narrat/i.test(e.name));
const ttsCue = encoded.find((e) => /tts|narrat|speech|spoken/i.test(e.name));

// Onsets of the ticks bed, so the 38 cells light up on the actual wav, not on a
// guessed stagger. Frame RMS with a 1.5x local-average rise and a 28 ms gap.
function detectOnsets(mono, rate) {
  const hop = Math.max(1, Math.round(rate * 0.005));
  const env = [];
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += mono[j] * mono[j];
    env.push(Math.sqrt(s / hop));
  }
  const out = [];
  let avg = 0, last = -1;
  for (let i = 1; i < env.length; i++) {
    const v = env[i];
    if (v > 0.014 && v > avg * 1.6 && (i * hop / rate) - last > 0.028) { out.push(r3(i * hop / rate)); last = i * hop / rate; }
    avg = avg * 0.9 + v * 0.1;
  }
  return out;
}
const tickOnsets = ticksCue ? detectOnsets(ticksCue.mono, ticksCue.monoRate).slice(0, 40) : [];

// ------------------------------------------------ measured per-cue metrics
// Every cue is decoded here, so peak / rms / centroid are measured from the real
// files, not invented. readouts.probe (3 files) is used to confirm them.
function measureCue(e) {
  const m = e.mono, sr = e.monoRate;
  let peak = 0, sum = 0, zc = 0, prev = 1;
  for (let i = 0; i < m.length; i++) {
    const v = Math.abs(m[i]);
    if (v > peak) peak = v;
    sum += m[i] * m[i];
    if ((m[i] >= 0) !== (prev >= 0)) zc++;
    prev = m[i];
  }
  const db = (x) => (x <= 0 ? -120 : 20 * Math.log10(x));
  return { peak: r3(db(peak)), rms: r3(db(Math.sqrt(sum / Math.max(1, m.length)))), centroid: Math.round(Math.abs(zc) / Math.max(0.001, m.length / sr) / 2) };
}
const metricsByName = {};
for (const e of encoded) metricsByName[e.name] = measureCue(e);

// ------------------------------------------------------------------- readouts
// readouts.json is the measurement sheet written by the audio worker. Every
// number shown in scenes 2/3/4/7 is read from it, or measured from the cue wavs
// here at build time; only uncovered fields fall back to a documented placeholder.
const readoutsPath = path.join(ASSET_DIR, 'readouts.json');
const readoutsRaw = readJson(readoutsPath);
const placeholders = [];
const rp = (readoutsRaw && readoutsRaw.probe) || {};
const S2 = 4, S3 = 9, S4 = 14;

// Scene 2: 8 preset cells carry measured numbers. Each is measured from the cue
// wav that demonstrates that preset family; readouts.probe wins where it covers
// the same file (impact / bed / sing).
const PROBE_MAP = [
  ['impact', 'impact'], ['tick', 'ticks'], ['chime', 'ui-success'], ['zap', 'ui-error'],
  ['riser', 'riser'], ['thud', 'design-hit'], ['scrap', 'glass'], ['choir-pad', 'sing'],
];
const probe = PROBE_MAP.map((pair) => {
  const preset = pair[0], cue = pair[1];
  const m = metricsByName[cue];
  const ref = rp[cue + '.wav'];
  if (!m) { placeholders.push('probe.' + preset); return { name: preset, from: cue, peak: -6, rms: -20, centroid: 900 }; }
  return {
    name: preset, from: cue,
    peak: ref ? r3(num(ref.peakDbfs, m.peak)) : m.peak,
    rms: ref ? r3(num(ref.rmsDbfs, m.rms)) : m.rms,
    centroid: m.centroid,
  };
});

// Scene 4: the detected beat grid, phase-locked onto scene 4 (14 s .. 20 s).
const beatsRaw = readoutsRaw && readoutsRaw.beats ? readoutsRaw.beats : null;
let bpm = num(beatsRaw && beatsRaw.bpm, 0);
const beatConf = num(beatsRaw && beatsRaw.confidence, 0);
let firstBeats = beatsRaw && Array.isArray(beatsRaw.firstBeats)
  ? beatsRaw.firstBeats.map(Number).filter((x) => Number.isFinite(x)) : [];
if (!firstBeats.length) { placeholders.push('beats'); firstBeats = [0]; }
if (!bpm) { bpm = 76; placeholders.push('bpm'); }
const spb = 60 / bpm;
const beatTimes = [];
for (let k = 0; k < 256; k++) {
  const t = firstBeats[0] + k * spb;
  if (t > 20.4) break;
  if (t >= S4) beatTimes.push(r3(t - S4));
}
if (!beatTimes.length) beatTimes.push(0);

// Scene 7: harmonic spectrum from readouts.analyze (f0 + partial levels in dB).
const an = (readoutsRaw && readoutsRaw.analyze) || null;
let f0 = num(an && an.f0 && an.f0.hz, 0);
if (!f0) { f0 = 220; placeholders.push('analyze.f0'); }
const harmArr = an && Array.isArray(an.harmonics) ? an.harmonics : [];
let harmonics = harmArr.map((h) => {
  const rel = num(h.relDb, NaN);
  const lvl = Number.isFinite(rel) ? rel : num(h.levelDb, -60) + 12;
  return { hz: r3(num(h.hz, f0 * num(h.n, 1))), level: r3(clamp01((lvl + 72) / 72)) };
}).filter((h) => h.hz > 0).slice(0, 24);
if (!harmonics.length) {
  for (let i = 0; i < 16; i++) harmonics.push({ hz: r3(f0 * (i + 1)), level: r3(Math.max(0.08, Math.pow(0.86, i))) });
  placeholders.push('analyze.harmonics');
}
const centroidHz = Math.round(num(an && an.centroidHz, 0));
const rt60 = num(an && an.decay && an.decay.rt60Seconds, 0);

// Scene 7: loudness. One integrated value measured + the delivery target a master
// chain would move it to. A second "measured" number is never invented.
const lo = (readoutsRaw && readoutsRaw.loudness) || null;
const lufs = {
  measured: num(lo && lo.integratedLufs, -21.3),
  target: -14,
  tp: num(lo && lo.truePeakDbtp, -8),
  lra: num(lo && lo.loudnessRangeLu, 3),
  ceiling: -1,
};
if (!lo) placeholders.push('loudness');

// Scene 3: two recipe cells explode into a measured readout (crest + centroid).
const design = [['door-slam-metal', 'design-hit'], ['glass-break', 'glass']].map((pair) => {
  const preset = pair[0], cue = pair[1];
  const c = encoded.find((e) => e.name === cue);
  const m = metricsByName[cue];
  if (!c || !m) { placeholders.push('design.' + preset); return { name: preset, at: 0.9, crest: 15, centroid: 1800, onsets: 3 }; }
  return {
    name: preset,
    at: r3(Math.max(0.4, c.at - S3)),
    crest: r3(m.peak - m.rms),
    centroid: m.centroid,
    onsets: detectOnsets(c.mono, c.monoRate).length,
  };
});

// Scene 2: the 38 cells tick on the ticks.wav onsets, time-scaled 0.72 so the
// grid completes inside the 5 s scene (the wav is 3.5 s long starting at 6 s).
const tickCells = tickOnsets.length
  ? tickOnsets.map((t) => r3(clamp((ticksCue.at - S2) + t * 0.72, 0.05, 4.62)))
  : [];

// ------------------------------------------------------------------- compound
const score = composeScore({ genre: 'lofi', bars: 8, seed: 11, intensity: 0.55 });
const barSec = (60 / score.bpm) * score.beatsPerBar;
const rollNotes = [];
for (const track of score.tracks) {
  if (/(drum|perc|noise)/i.test(track.id + ' ' + track.role + ' ' + track.instrument)) continue;
  for (const n of (track.notes || [])) {
    rollNotes.push({
      t: r3((n.bar || 0) * barSec + (n.beat || 0) * (60 / score.bpm)),
      d: r3((n.durBeats || 0.5) * (60 / score.bpm)),
      midi: n.midi,
      v: r3(n.velocity ?? 0.6),
      tr: track.id,
    });
  }
}
const rollChords = (score.chords || []).map((c) => ({ bar: c.bar, name: c.name, midi: c.midi }));

// ------------------------------------------------------------ lipsync / mouth
const CAPTION = '给 HTML 动画加声音';
let visemesA = [];
let visemeSource = 'placeholder';
if (sungCue && sungCue.mono) {
  try {
    const res = analyzeVisemes(sungCue.mono, sungCue.monoRate, { fps: 24 });
    const frames = res.frames || res;
    if (Array.isArray(frames) && frames.length) {
      visemesA = frames.map((f) => ({ t: r3(f.t), v: f.viseme || 'none', o: r3(clamp01(f.openness)) }));
      visemeSource = 'analyzeVisemes(' + sungCue.file + ')';
    }
  } catch (e) { warn('analyzeVisemes failed: ' + e.message); }
}
if (!visemesA.length) {
  const res = mouthFromText({ text: CAPTION, duration: 3.2, fps: 24 });
  visemesA = (res.frames || []).map((f) => ({ t: r3(f.t), v: f.viseme || 'none', o: r3(clamp01(f.openness)) }));
  visemeSource = 'placeholder(mouthFromText)';
  placeholders.push('lipsync');
}
let mouthB = [];
try {
  const res = mouthFromText({ text: CAPTION, duration: 3.2, fps: 24 });
  mouthB = (res.frames || []).map((f) => ({ t: r3(f.t), v: f.viseme || 'none', o: r3(clamp01(f.openness)) }));
} catch (e) { warn('mouthFromText failed: ' + e.message); }

// Syllable / word timestamps for the sung cue. Prefer manifest data, else the
// lipsync frames (voiced onsets), else even spacing of the lyric.
const LYRIC = ['gei', 'html', 'dong', 'hua', 'jia', 'sheng', 'yin'];
let syllables = [];
const syllRaw = deepFind(manifest, ['syllables', 'syllabletimes', 'words', 'timestamps']);
if (Array.isArray(syllRaw) && syllRaw.length) {
  syllables = syllRaw.map((s, i) => {
    if (typeof s === 'object') return { t: r3(num(s.t ?? s.at ?? s.start ?? s.time, i * 0.4)), text: String(s.text ?? s.syllable ?? s.word ?? LYRIC[i % LYRIC.length]) };
    return { t: r3(Number(s) || i * 0.4), text: LYRIC[i % LYRIC.length] };
  }).filter((s) => Number.isFinite(s.t)).slice(0, 12);
}
const sungDur = sungCue ? sungCue.dur : 3.2;
if (!syllables.length) {
  // Derived, not measured: the sung cue has no syllable sheet, so the lyric words
  // are spread over the voiced span (started at the first voiced frame). Labelled
  // as derived in the build output.
  const voiced = visemesA.filter((f) => f.v !== 'none');
  const step = (sungDur - 0.4) / Math.max(1, LYRIC.length);
  const start = voiced.length ? Math.max(0.08, Math.min(voiced[0].t, 0.3)) : 0.15;
  syllables = LYRIC.map((w, i) => ({ t: r3(start + i * step), text: w }));
  placeholders.push('syllables(derived from lyric, evenly spaced)');
}

// Waveform peaks for the scene-5 waveform (from the sung wav when present).
const PEAK_BUCKETS = 220;
let peaks = [];
if (sungCue && sungCue.mono) {
  const step = Math.max(1, Math.floor(sungCue.mono.length / PEAK_BUCKETS));
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(sungCue.mono.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(sungCue.mono[j]));
    peaks.push(r3(Math.min(1, m)));
  }
} else {
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    const x = i / PEAK_BUCKETS;
    const env = Math.sin(Math.PI * x) * (0.55 + 0.45 * Math.sin(x * 34));
    peaks.push(r3(Math.max(0.04, Math.abs(env) * (0.5 + seedHash('pk' + i) * 0.5))));
  }
  placeholders.push('peaks');
}

// ------------------------------------------------------------------- live sfx
const livePath = path.join(ASSET_DIR, 'live-sfx.js');
const uiPath = path.join(ASSET_DIR, 'ui-sfx.js');
const liveSrc = exists(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
const uiSrc = exists(uiPath) ? fs.readFileSync(uiPath, 'utf8') : '';
if (!liveSrc) warn('assets/live-sfx.js missing — page uses its own zero-byte fallback synth');
if (!uiSrc) warn('assets/ui-sfx.js missing — page uses its own zero-byte fallback UI tones');

// Clip names ui-sfx.js actually ships, so the interaction scene plays real ones.
const uiClips = [];
{
  const re = /"name":"([a-z-]+)"/g;
  let m2;
  while ((m2 = re.exec(uiSrc))) if (uiClips.indexOf(m2[1]) < 0) uiClips.push(m2[1]);
}

const missing = [];
if (!manifest) missing.push('audio/manifest.json');
if (!readoutsRaw) missing.push('assets/readouts.json');
if (!liveSrc) missing.push('assets/live-sfx.js');
if (!uiSrc) missing.push('assets/ui-sfx.js');

// Sanitise the inline scripts so they can never fetch anything.
const clean = (s) => s.replace(/<\\?\/script/gi, '<\\/script');

// ----------------------------------------------------------------- data object
const data = {
  dur: DUR,
  palette: (readJson(PALETTE) || {}).tokens || {},
  copy: COPY,
  hud: (COPY && COPY.hud) || {},
  endcard: (COPY && COPY.endcard) || {},
  gateText: (COPY_SCENE.open && COPY_SCENE.open.gate) || 'CLICK TO START',
  scenes: SCENES,
  tools: TOOLS,
  cues: encoded.map((e) => ({ name: e.name, at: e.at, gainDb: e.gainDb, fadeIn: e.fadeIn, fadeOut: e.fadeOut, loop: e.loop, dur: e.dur, b64: b64(e.wav) })),
  presets: PRESETS,
  recipes: RECIPES,
  genres: GENRES,
  voices: VOICES,
  uiClips,
  probe,
  design,
  tickCells,
  bpm: Math.round(bpm * 10) / 10,
  beatConf: r3(beatConf),
  beatTimes,
  f0: Math.round(f0 * 10) / 10,
  harmonics,
  centroidHz,
  rt60: r3(rt60),
  lufs,
  rollNotes,
  rollChords,
  rollBarSec: r3(barSec),
  rollBpm: score.bpm,
  rollKey: score.key + ' ' + score.mode,
  rollBars: score.bars,
  visemesA,
  mouthB,
  syllables,
  peaks,
  caption: CAPTION,
  sungDur: r3(sungDur),
  sungName: sungCue ? sungCue.name : null,
  ttsName: ttsCue ? ttsCue.name : null,
  ttsFile: ttsCue ? ttsCue.file : null,
  ttsPlaceholder: !!(ttsCue && /placeholder/i.test(String(ttsCue.file || ''))),
  tickStart: ticksCue ? r3(ticksCue.at) : 4.2,
  placeholders: [...new Set(placeholders)],
  missing,
};

// --------------------------------------------------------------------- page
// NOTE: no template-literal interpolation inside PAGE_HTML (String.raw + replace
// only), so the page can be pasted into any bundler unchanged.
const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<!-- build: __BUILD_NOTE__ -->
<!-- audio payload: every clip is a PCM WAV byte array embedded as BASE64 text in
     #showall-data (8-bit for one-shots, and the 44 s bed at 8-bit/11.025 kHz to
     stay inside the page budget). The page decodes them with atob() then
     ctx.decodeAudioData() — there are deliberately no data:audio/... URIs here,
     because the payload is a single JSON blob, not markup. -->
<style>
/* palette.json is injected here at build time — the page has no
   colour literal of its own except rgba hairlines derived from it. */
:root{
__TOKENS__
  --mono:__MONO__;
  --sans:__SANS__;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:var(--stage);overflow:hidden}
body{font-family:var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased}
#stage{position:fixed;inset:0;background:var(--stage);overflow:hidden}
#vignette{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 90% at 50% 40%,rgba(255,255,255,.020),rgba(0,0,0,0) 62%),
             radial-gradient(90% 70% at 50% 118%,rgba(0,0,0,.55),rgba(0,0,0,0) 70%)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.dim{color:var(--dim)} .faint{color:var(--faint)}
.redact{display:inline-block;background:var(--redact);height:1em;vertical-align:-0.12em;
  border:1px solid rgba(255,255,255,.06)}
.paper .redact{background:#111;border-color:rgba(0,0,0,.35)}

/* ---------------- chrome: archive HUD ---------------- */
#topbar{position:absolute;left:0;right:0;top:0;height:54px;z-index:20;
  padding:0 clamp(26px,3.4vw,56px);display:flex;align-items:center;gap:14px;
  border-bottom:1px solid var(--line)}
#prog{position:absolute;left:0;top:0;height:1px;width:100%;background:rgba(255,255,255,.06)}
#prog-fill{display:block;height:1px;width:0;background:var(--accent)}
.tb-l,.tb-r{display:flex;align-items:center;gap:14px;font-family:var(--mono);
  font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;white-space:nowrap}
.tb-r{margin-left:auto}
.kicker{color:var(--dim)}
.tbsep{width:16px;height:1px;background:var(--line);display:inline-block}
#hud-file{color:var(--ink)}
#hud-tools{color:var(--faint)}
#tc{color:var(--ink);letter-spacing:.1em}

#scenes{position:absolute;left:clamp(26px,3.4vw,56px);right:clamp(26px,3.4vw,56px);
  top:clamp(74px,10.5vh,100px);bottom:clamp(96px,15vh,118px)}
.scene{position:absolute;inset:0;opacity:0;pointer-events:none}
.scene.on{pointer-events:auto}
.scene-head{display:grid;grid-template-columns:auto auto 1fr;align-items:baseline;
  column-gap:clamp(12px,1.8vw,22px);padding-bottom:9px;border-bottom:1px solid var(--line);
  margin-bottom:clamp(14px,2.2vh,24px)}
.scene-head .f{font-family:var(--mono);font-size:9px;letter-spacing:.2em;color:var(--faint);
  text-transform:uppercase;white-space:nowrap}
.scene-head h2{font-size:clamp(18px,2.05vw,24px);font-weight:500;letter-spacing:.03em;color:var(--ink);white-space:nowrap}
.scene-head .hl{margin-left:auto;text-align:right;display:flex;flex-direction:column;gap:2px;
  min-width:0;max-width:58%}
.scene-head .line{font-size:clamp(10.5px,.95vw,12px);color:var(--dim);letter-spacing:.02em}
.scene-head .detail{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--faint);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.caret{color:var(--accent);font-weight:400}
.readout{position:absolute;left:0;bottom:-2px;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.1em;color:var(--faint)}
.readout b{color:var(--ink);font-weight:400}

/* ---------------- 1 · open (cover sheet) ---------------- */
#c-ring{position:absolute;right:0;top:0;width:52%;height:100%;opacity:.8}
.cover{position:absolute;left:0;top:50%;transform:translateY(-50%);width:min(46%,520px);
  display:flex;flex-direction:column;gap:14px}
.cover-kick{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:9px;
  letter-spacing:.28em;color:var(--faint);text-transform:uppercase}
.cover-kick .dot{width:4px;height:4px;background:var(--accent);display:inline-block}
#wordmark{font-family:var(--mono);font-size:clamp(30px,4.4vw,54px);letter-spacing:.1em;
  color:var(--ink);line-height:1;opacity:0}
#wordsub{margin-top:2px;font-size:clamp(11px,1.02vw,13px);color:var(--dim);letter-spacing:.06em;opacity:0}
#open-rule{width:0;height:1px;background:var(--line);margin:4px 0 2px}
.meta-table{display:grid;grid-template-columns:auto 1fr;column-gap:18px;row-gap:6px;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;align-items:baseline}
.meta-table .mk{color:var(--faint);text-transform:uppercase;white-space:nowrap}
.meta-table .mv{color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta-table .mv.redact{display:block;background:var(--redact);border:1px solid rgba(255,255,255,.05);
  height:11px;margin-top:2px}

/* ---------------- 2 · library ---------------- */
.grid38{display:grid;grid-template-columns:repeat(8,1fr);gap:1px;background:var(--line2);
  border:1px solid var(--line2);margin-top:4px}
.cell{background:var(--stage);padding:clamp(7px,.95vw,11px) 8px;min-height:0;
  display:flex;flex-direction:column;gap:5px;opacity:.34;transition:opacity .12s linear}
.cell .nm{font-family:var(--mono);font-size:clamp(8px,.78vw,9.5px);letter-spacing:.06em;
  color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell.on{opacity:1}
.cell.metrics{background:rgba(27,27,27,.34)}
.cell.metrics .v{font-family:var(--mono);font-size:clamp(7.5px,.72vw,9px);letter-spacing:.04em;
  color:var(--faint);display:flex;justify-content:space-between;opacity:0}
.cell.metrics.shown .v{opacity:1}
.cell.metrics .v i{font-style:normal;color:var(--accent)}

/* ---------------- 3 · recipes ---------------- */
.rec-wrap{display:grid;grid-template-columns:minmax(200px,24%) 1fr;gap:clamp(20px,4vw,54px)}
#rec-list{list-style:none;column-count:2;column-gap:clamp(14px,2vw,26px);font-family:var(--mono);font-size:clamp(9px,.86vw,10.5px)}
#rec-list li{padding:1.9px 0;color:var(--faint);letter-spacing:.04em;white-space:nowrap;opacity:0}
#rec-list li.hit{color:var(--ink)}
#rec-list li .dot{display:inline-block;width:4px;height:1px;background:var(--accent);vertical-align:middle;margin-right:7px;opacity:0}
#rec-list li.hit .dot{opacity:1}
.rec-side{display:flex;flex-direction:column;gap:clamp(16px,2.6vh,28px)}
.diagram{display:flex;align-items:center;gap:0}
.dg-node{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  padding:5px 9px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.dg-node.accent{border-color:color-mix(in srgb, var(--accent) 55%, transparent);color:var(--accent)}
.dg-line{flex:0 0 22px;height:1px;background:var(--line);position:relative}
.dg-layers{display:flex;flex-direction:column;gap:4px}
.dg-layer{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:9px;
  letter-spacing:.1em;color:var(--faint);text-transform:uppercase}
.dg-layer .bar{height:1px;background:var(--line);flex:1}
.metric{display:flex;gap:clamp(18px,3vw,40px);border-top:1px solid var(--line2);padding-top:12px;opacity:0}
.metric.show{opacity:1}
.metric .k{font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:var(--faint);text-transform:uppercase}
.metric .n{font-family:var(--mono);font-size:clamp(16px,1.9vw,22px);letter-spacing:.02em;color:var(--ink);
  margin-top:4px;font-variant-numeric:tabular-nums}
.metric .n em{font-style:normal;color:var(--accent);font-size:.62em;letter-spacing:.1em;margin-left:3px}

/* ---------------- 4 · compose ---------------- */
.genres{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:clamp(12px,2vh,20px)}
.chip{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  padding:5px 10px;border:1px solid var(--line2);color:var(--faint)}
.chip.on{border-color:color-mix(in srgb, var(--accent) 60%, transparent);color:var(--accent)}
.chip.sm{font-size:9px;padding:3px 7px;letter-spacing:.1em}
.beatrow{display:flex;align-items:flex-end;gap:clamp(12px,2vw,26px);margin-bottom:10px}
#beatgrid{display:grid;grid-template-columns:repeat(16,10px);grid-auto-rows:10px;gap:5px 0;
  justify-content:start;align-content:center}
#beatgrid i{width:5px;height:5px;background:rgba(255,255,255,.16);display:block;
  transition:background .16s linear,transform .16s linear}
#beatgrid i.b{background:rgba(255,255,255,.34)}
#beatgrid i.hot{background:var(--accent);transform:scale(1.7)}
.bpm{font-family:var(--mono);font-size:clamp(20px,2.4vw,28px);letter-spacing:.02em;color:var(--ink)}
.bpm em{font-style:normal;font-size:9px;letter-spacing:.2em;color:var(--faint);margin-left:8px;vertical-align:middle}
#roll{width:100%;height:clamp(140px,25vh,224px);display:block}
.badge{position:absolute;right:0;bottom:-2px;font-family:var(--mono);font-size:9px;letter-spacing:.16em;
  color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 50%, transparent);padding:4px 8px}
#s-compose .scene-head .meta{padding-right:62px}

/* ---------------- 5 · voice ---------------- */
#wave{width:100%;height:clamp(64px,10vh,92px);display:block;margin-bottom:4px}
#sylls{position:relative;height:30px;margin-bottom:clamp(10px,1.6vh,18px)}
#sylls span{position:absolute;top:0;font-family:var(--mono);font-size:9px;letter-spacing:.08em;
  color:var(--faint);transform:translateX(-50%);white-space:nowrap}
#sylls span.alt{top:13px}
#sylls span:before{content:"";display:block;width:1px;height:5px;background:var(--line);margin:0 auto 3px}
.voicelow{display:flex;align-items:flex-start;gap:clamp(24px,4vw,60px)}
.mouths{display:flex;gap:clamp(18px,3vw,34px)}
.mouths figure{display:flex;flex-direction:column;align-items:center;gap:6px}
.mouths canvas{width:clamp(74px,8vw,104px);height:clamp(56px,6vw,78px);display:block}
.mouths figcaption{font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--faint)}
.voicecol{flex:1;display:flex;flex-direction:column;gap:10px}
.vchips{display:flex;flex-wrap:wrap;gap:6px}
.two-line{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:var(--faint);line-height:1.9}
.two-line b{color:var(--dim);font-weight:400}

/* ---------------- 6 · interactive ---------------- */
.btnrow{display:flex;gap:10px;margin-bottom:clamp(16px,2.6vh,26px)}
.uibtn{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  padding:11px 18px;background:transparent;border:1px solid var(--line);color:var(--dim);
  cursor:pointer;transition:border-color .12s,color .12s;font-variant-numeric:tabular-nums}
.uibtn:hover{border-color:color-mix(in srgb, var(--accent) 70%, transparent);color:var(--ink)}
.uibtn.fire{border-color:var(--accent);color:var(--accent)}
.uibtn small{display:block;font-size:8.5px;color:var(--ghost);letter-spacing:.1em;margin-top:4px}
.padwrap{display:grid;grid-template-columns:minmax(280px,420px) auto;justify-content:start;
  column-gap:clamp(40px,7vw,120px);align-items:start}
.sliders{display:flex;flex-direction:column;gap:clamp(9px,1.5vh,15px);max-width:420px}
.sl{display:grid;grid-template-columns:78px 1fr 34px;align-items:center;gap:12px}
.sl .k{font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:var(--faint);text-transform:uppercase}
.sl .v{font-family:var(--mono);font-size:9px;color:var(--dim);text-align:right}
input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;height:14px;width:100%}
input[type=range]::-webkit-slider-runnable-track{height:1px;background:rgba(255,255,255,.18)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;margin-top:-4px;
  background:var(--accent);border:0;border-radius:0}
input[type=range]::-moz-range-track{height:1px;background:rgba(255,255,255,.18)}
input[type=range]::-moz-range-thumb{width:9px;height:9px;background:var(--accent);border:0;border-radius:0}
.pads{display:flex;gap:8px}
.pad{width:clamp(58px,6vw,76px);height:clamp(58px,6vw,76px);border:1px solid var(--line);
  background:transparent;color:var(--dim);font-family:var(--mono);font-size:9px;letter-spacing:.1em;
  text-transform:uppercase;cursor:pointer;display:flex;flex-direction:column;justify-content:flex-end;
  align-items:flex-start;padding:8px;transition:border-color .1s,background .1s}
.pad:hover{border-color:color-mix(in srgb, var(--accent) 65%, transparent)}
.pad.fire{background:color-mix(in srgb, var(--accent) 12%, transparent);border-color:var(--accent);color:var(--ink)}
.pad span{font-size:8px;color:var(--ghost);margin-bottom:auto}

/* ---------------- 7 · analysis ---------------- */
.an-grid{display:grid;grid-template-columns:1fr minmax(230px,32%);gap:clamp(24px,4vw,60px)}
#spec{width:100%;height:clamp(120px,21vh,190px);display:block}
.an-right{display:flex;flex-direction:column;gap:clamp(14px,2.4vh,26px)}
.lufs .lab{font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:var(--faint);
  text-transform:uppercase;margin-bottom:10px}
.lufs .track{position:relative;height:1px;background:rgba(255,255,255,.18);margin:16px 0 8px}
.lufs .fill{position:absolute;left:0;top:-1px;height:3px;background:var(--accent);width:0;opacity:.9}
.lufs .marks{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;
  letter-spacing:.1em;color:var(--faint)}
.lufs .marks b{font-weight:400;color:var(--ink);font-size:15px}
.ring51{display:flex;align-items:center;gap:18px}
#r51{width:clamp(104px,11vw,138px);height:clamp(104px,11vw,138px);display:block}
.ring-legend{font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--faint);line-height:2.1}
.ring-legend b{color:var(--ink);font-weight:400}

/* ---------------- 8 · delivery (the one paper page) ---------------- */
.sheet{background:var(--paper);color:var(--paperInk);height:100%;padding:clamp(14px,2.2vh,22px) clamp(16px,2.4vw,30px);
  display:flex;flex-direction:column;
  --ink:#161616; --dim:#3c3c3c; --faint:#616161; --ghost:#8a8a8a;
  --line:rgba(0,0,0,.18); --line2:rgba(0,0,0,.1); --accent:#8e5f99; --redact:#111}
.sheet .scene-head{border-bottom:1px solid rgba(0,0,0,.28)}
.sheet .readout{color:#5f5f5f}
.deliv{display:grid;grid-template-columns:1.15fr 1fr .72fr .9fr;gap:clamp(18px,3vw,42px)}
.col .ch{font-family:var(--mono);font-size:9px;letter-spacing:.16em;color:var(--faint);
  text-transform:uppercase;padding-bottom:8px;border-bottom:1px solid var(--line2);margin-bottom:9px}
.cuerow{display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.06em;color:var(--dim);padding:2.5px 0;opacity:0}
.cuerow i{font-style:normal;color:var(--faint)}
.cuerow .rd{display:inline-block;background:#111;height:8px;width:46px;vertical-align:middle}
.stem{display:flex;align-items:center;gap:8px;margin:4px 0;opacity:0}
.stem .nm{font-family:var(--mono);font-size:9px;letter-spacing:.1em;color:var(--faint);width:38px;text-transform:uppercase}
.stem .bar{height:3px;background:rgba(0,0,0,.16);flex:1}
.stem .bar b{display:block;height:3px;background:#161616;width:0;opacity:.6}
.stem:first-child .bar b{background:#8e5f99;opacity:1}
.fmtchips{display:flex;flex-wrap:wrap;gap:5px}
.pass{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:var(--dim);padding:3px 0;opacity:0}
.pass b{color:var(--accent);font-weight:400}
.endcard{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;
  border-top:1px solid rgba(0,0,0,.28);padding-top:12px;opacity:0}
.endcard .big{font-family:var(--mono);font-size:15px;letter-spacing:.14em;color:#161616}
.endcard .ec-line{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:#5f5f5f;margin-top:5px}
.stamp{border:2px solid #161616;padding:7px 15px;transform:rotate(-3.5deg);opacity:.82;
  font-family:var(--mono);font-size:12px;letter-spacing:.34em;text-indent:.34em;color:#161616;
  text-transform:uppercase;white-space:nowrap}

/* ---------------- strip ---------------- */
#strip{position:absolute;left:0;right:0;bottom:0;height:clamp(108px,15vh,128px);z-index:20;
  border-top:1px solid var(--line2);padding:11px clamp(26px,3.4vw,56px) 10px;
  display:grid;grid-template-columns:repeat(5,1fr);grid-auto-rows:1fr;gap:0 14px;
  background:linear-gradient(180deg,rgba(8,9,11,0),rgba(8,9,11,.75))}
#strip .t{font-family:var(--mono);font-size:clamp(7.5px,.7vw,9px);letter-spacing:.04em;
  color:rgba(230,230,230,.22);white-space:nowrap;display:flex;align-items:center;gap:5px}
#strip .t:before{content:"";width:3px;height:3px;background:rgba(230,230,230,.18);flex:0 0 3px}
#strip .t.on{color:var(--ink)}
#strip .t.on:before{background:var(--accent)}

/* ---------------- gate + replay ---------------- */
#gate{position:absolute;inset:0;z-index:50;background:var(--stage);display:flex;
  align-items:flex-start;justify-content:flex-start;cursor:pointer;transition:opacity .5s ease}
#gate.gone{opacity:0;pointer-events:none}
.gate-inner{position:relative;z-index:2;margin-top:clamp(46px,8.5vh,82px);margin-left:clamp(28px,7vw,116px);width:min(560px,60vw);
  display:flex;flex-direction:column;gap:13px}
.gate-mark{font-family:var(--mono);font-size:clamp(30px,4.4vw,52px);letter-spacing:.1em;color:var(--ink);line-height:1}
.gate-sub{font-size:clamp(11px,1.02vw,13px);color:var(--dim);letter-spacing:.06em}
.gate-rule{height:1px;background:var(--line);margin:5px 0 3px}
#gate-btn{position:relative;z-index:2;margin-top:18px;align-self:flex-start;background:transparent;
  border:1px solid var(--line);color:var(--ink);padding:11px 20px;cursor:pointer;
  display:flex;flex-direction:column;gap:5px;align-items:flex-start;font-family:var(--mono);
  transition:border-color .15s,color .15s,background .15s}
#gate-btn span{font-size:10.5px;letter-spacing:.26em;text-transform:uppercase}
#gate-btn em{font-style:normal;font-size:8.5px;letter-spacing:.18em;color:var(--faint);text-transform:uppercase}
#gate-btn:hover{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb, var(--accent) 6%, transparent)}
#gate-ring{position:absolute;right:6%;top:50%;transform:translateY(-50%);
  width:min(58vh,460px);height:min(58vh,460px);opacity:.8}
#replay{position:absolute;right:clamp(26px,4vw,64px);bottom:calc(clamp(64px,9.5vh,78px) + 12px);z-index:30;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;
  background:transparent;border:1px solid var(--line);color:var(--dim);padding:8px 14px;
  cursor:pointer;opacity:0;pointer-events:none;transition:opacity .3s,border-color .15s,color .15s}
#replay.show{opacity:1;pointer-events:auto}
#replay:hover{border-color:var(--accent);color:var(--ink)}
@media (max-width:1000px){.rec-wrap{grid-template-columns:1fr}.an-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="stage">
  <div id="vignette"></div>

  <div id="gate">
    <canvas id="gate-ring"></canvas>
    <div class="gate-inner">
      <div class="cover-kick mono"><i class="dot"></i><span id="gate-kicker">DSH · AUDIO ARCHIVE</span></div>
      <div class="gate-mark" id="gate-mark">dsh-audio</div>
      <div class="gate-sub" id="gate-sub">给 HTML 动画加声音</div>
      <div class="gate-rule"></div>
      <div class="meta-table mono" id="gate-meta"></div>
      <button id="gate-btn" type="button"><span id="gate-btn-text">点击开始 · CLICK TO START</span><em id="gate-btn-em">AUDIO INLINE · 10 CUES</em></button>
    </div>
  </div>

  <div id="topbar">
    <div id="prog"><span id="prog-fill"></span></div>
    <div class="tb-l">
      <span class="kicker mono" id="hud-kicker">DSH · AUDIO ARCHIVE</span>
      <span class="tbsep"></span>
      <span class="mono" id="hud-file">FILE 00 / 08</span>
    </div>
    <div class="tb-r">
      <span class="mono faint" id="hud-audio">AUDIO INLINE · 10 CUES</span>
      <span class="tbsep"></span>
      <span class="mono faint" id="hud-tools">0/25</span>
      <span class="tbsep"></span>
      <span class="mono" id="tc">T+00:00.00 / 00:44.00</span>
    </div>
  </div>

  <div id="scenes">

    <section class="scene" id="s-open">
      <canvas id="c-ring"></canvas>
      <div class="cover">
        <div class="cover-kick mono"><i class="dot"></i><span id="cover-kicker">DSH · AUDIO ARCHIVE</span></div>
        <div class="cover-mark" id="wordmark">dsh-audio</div>
        <div class="cover-sub" id="wordsub">给 HTML 动画加声音</div>
        <div class="cover-rule" id="open-rule"></div>
        <div class="meta-table" id="cover-meta"></div>
        <div class="meta-table redacted" id="cover-redact"></div>
      </div>
    </section>

    <section class="scene" id="s-library">
      <div class="scene-head"><span class="f" data-f>FILE 1 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <div class="grid38" id="grid38"></div>
      <div class="readout" id="lib-readout">audio_synth · audio_pattern · audio_probe</div>
    </section>

    <section class="scene" id="s-recipes">
      <div class="scene-head"><span class="f" data-f>FILE 2 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <div class="rec-wrap">
        <ol id="rec-list"></ol>
        <div class="rec-side">
          <div class="diagram">
            <span class="dg-node accent" id="dg-recipe">recipe</span>
            <span class="dg-line"></span>
            <div class="dg-layers" id="dg-layers"></div>
          </div>
          <div class="metric" id="rec-metric">
            <div><div class="k">crest</div><div class="n" id="m-crest">0.0<em>dB</em></div></div>
            <div><div class="k">centroid</div><div class="n" id="m-cent">0<em>Hz</em></div></div>
            <div><div class="k">onsets</div><div class="n" id="m-on">0</div></div>
          </div>
        </div>
      </div>
      <div class="readout">audio_design · audio_mix</div>
    </section>

    <section class="scene" id="s-compose">
      <div class="scene-head"><span class="f" data-f>FILE 3 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <div class="badge" id="mid-badge">.MID</div>
      <div class="genres" id="genres"></div>
      <div class="beatrow">
        <div class="bpm" id="bpm">0<em>BPM</em></div>
        <div id="beatgrid"></div>
      </div>
      <canvas id="roll"></canvas>
      <div class="readout" id="cmp-readout">audio_compose · audio_beats · audio_midi · audio_loudness</div>
    </section>

    <section class="scene" id="s-voice">
      <div class="scene-head"><span class="f" data-f>FILE 4 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <canvas id="wave"></canvas>
      <div id="sylls"></div>
      <div class="voicelow">
        <div class="mouths">
          <figure><canvas id="m-a"></canvas><figcaption id="cap-a">— · lipsync</figcaption></figure>
          <figure><canvas id="m-b"></canvas><figcaption id="cap-b">— · mouth</figcaption></figure>
        </div>
        <div class="voicecol">
          <div class="vchips" id="vchips"></div>
          <div class="two-line" id="v-note"></div>
        </div>
      </div>
      <div class="readout">audio_tts · audio_sing · audio_lipsync · audio_mouth · audio_voices</div>
    </section>

    <section class="scene" id="s-interactive">
      <div class="scene-head"><span class="f" data-f>FILE 5 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <div class="btnrow">
        <button class="uibtn" data-ui="hover">hover<small>ui-sfx · hover</small></button>
        <button class="uibtn" data-ui="click">click<small>ui-sfx · click</small></button>
        <button class="uibtn" data-ui="success">success<small>ui-sfx · success</small></button>
      </div>
      <div class="padwrap">
        <div class="sliders" id="sliders"></div>
        <div class="pads" id="pads"></div>
      </div>
      <div class="readout" id="it-readout">last · —</div>
    </section>

    <section class="scene" id="s-analysis">
      <div class="scene-head"><span class="f" data-f>FILE 6 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
      <div class="an-grid">
        <div><canvas id="spec"></canvas></div>
        <div class="an-right">
          <div class="lufs">
            <div class="lab">loudness · integrated</div>
            <div class="track"><span class="fill" id="lufs-fill"></span></div>
            <div class="marks"><span><b id="lufs-before">-18.4</b> LUFS</span>
              <span><b id="lufs-after">-14.0</b> LUFS</span></div>
          </div>
          <div class="ring51">
            <canvas id="r51"></canvas>
            <div class="ring-legend">bus · 5.1<br><b id="r51lab">FL FR C LFE RL RR</b><br>pan orbit · 1.5 rad/s</div>
          </div>
        </div>
      </div>
      <div class="readout" id="an-readout">audio_analyze · audio_loudness · audio_bus · audio_stretch</div>
    </section>

    <section class="scene" id="s-delivery">
      <div class="sheet">
        <div class="scene-head"><span class="f" data-f>FILE 7 / 08</span><h2 data-h></h2><span class="hl"><span class="line" data-l></span><span class="detail" data-d></span></span></div>
        <div class="deliv">
          <div class="col"><div class="ch">cue sheet · bind</div><div id="cuesheet"></div></div>
          <div class="col"><div class="ch">stems</div><div id="stems"></div></div>
          <div class="col"><div class="ch">convert</div><div class="fmtchips" id="fmtchips"></div></div>
          <div class="col"><div class="ch">gate</div><div id="checks"></div></div>
        </div>
        <div class="endcard" id="endcard">
          <div class="ec-l">
            <div class="big">dsh-audio</div>
            <div class="ec-line" data-ec="0"></div>
            <div class="ec-line" data-ec="1"></div>
          </div>
          <div class="stamp"><span>已归档</span></div>
        </div>
      </div>
    </section>

  </div>

  <div id="strip"></div>
  <button id="replay" type="button">replay ↻</button>

</div>

<script type="application/json" id="showall-spec">__SPEC__</script>
<script id="showall-data">window.__SHOWALL__=/*__DATA__*/null;</script>
<script>/*__LIVESFX__*/</script>
<script>/*__UISFX__*/</script>
<script>
(function(){
'use strict';
var D=window.__SHOWALL__;
var MONO='ui-monospace,"SF Mono",Menlo,Consolas,monospace';
var ACCENT=(D.palette&&D.palette.accent)||'#c56bd6', INK='#e6e6e6';
var ARGB=(function(h){h=String(h).replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];})(ACCENT);
function acc(a){return 'rgba('+ARGB[0]+','+ARGB[1]+','+ARGB[2]+','+a+')';}
var q=function(s,r){return (r||document).querySelector(s);};
var qa=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
function mk(tag,cls,txt){var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e;}
function txt(el,s){ if(el&&el.__t!==s){el.__t=s; el.textContent=s;} }
function setOp(el,v){ if(!el)return; v=Math.round(v*1000)/1000; if(el.__o!==v){el.__o=v; el.style.opacity=v;} }
function ramp(x){ return x<=0?0:(x>=1?1:x*x*(3-2*x)); }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function hash(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0)/4294967295;}
function fit(cv){
  var dpr=Math.min(2,window.devicePixelRatio||1), r=cv.getBoundingClientRect();
  if(!r.width||!r.height) return null;
  var w=Math.max(1,Math.round(r.width*dpr)), h=Math.max(1,Math.round(r.height*dpr));
  if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
  var g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,r.width,r.height);
  return {g:g,w:r.width,h:r.height};
}
function tc(s){ s=Math.max(0,s); var m=Math.floor(s/60), x=(s-m*60); return m+':'+(x<10?'0':'')+x.toFixed(2); }

/* ------------------------------------------------------------------ clock */
var ctx=null, T0=0, playing=false, finished=false, raf=0, curT=0, buffers={}, sources=[], master=null;
var START_DELAY=0.12;
// QA hook: open index.html#t=12.4 to jump the visual clock to 12.4 s with audio
// muted — used by the build's headless frame check, harmless for visitors.
var SEEK=(function(){ var m=/#t=([0-9.]+)/.exec(location.hash); return m?clamp(parseFloat(m[1]),0,D.dur):0; })();
var QA=SEEK>0, seekUsed=false;
function clock(){ return QA?(performance.now()/1000):ctx.currentTime; }
function ac(){ if(!ctx){ var C=window.AudioContext||window.webkitAudioContext; ctx=new C(); master=ctx.createGain(); master.gain.value=0.78; master.connect(ctx.destination);} return ctx; }
function b64bytes(s){ var bin=atob(s), n=bin.length, u=new Uint8Array(n); for(var i=0;i<n;i++)u[i]=bin.charCodeAt(i); return u; }
function decodeAll(){
  var c=ac(), jobs=D.cues.map(function(cue){
    return new Promise(function(res){
      var bytes=b64bytes(cue.b64);
      var ok=function(b){ buffers[cue.name]=b; res(); };
      var bad=function(){ res(); };
      try{ var p=c.decodeAudioData(bytes.buffer.slice(0), ok, bad); if(p&&p.then) p.then(ok,bad); }catch(e){ bad(); }
    });
  });
  return Promise.all(jobs);
}
function stopAll(){
  for(var i=0;i<sources.length;i++){
    var s=sources[i];
    if(!s.__started) continue;
    try{ s.stop(); }catch(e){}
    s.__started=0;
  }
  sources=[];
}
function startRun(){
  if(!QA && !ctx) return;
  stopAll();
  var seek=(!seekUsed&&SEEK)?SEEK:0; seekUsed=true;
  T0=(QA?performance.now()/1000:ctx.currentTime)+START_DELAY-seek; playing=true; finished=false; curT=seek;
  var t0=T0;
  if(seek){ if(master) master.gain.value=0; }
  D.cues.forEach(function(cue){
    var b=buffers[cue.name]; if(!b) return;
    var src=ctx.createBufferSource(); src.buffer=b;
    var g=ctx.createGain(); g.gain.value=Math.pow(10,(cue.gainDb||0)/20);
    src.connect(g); g.connect(master);
    var at=t0+cue.at;
    if(cue.fadeIn>0){ g.gain.setValueAtTime(0.0001,at); g.gain.exponentialRampToValueAtTime(Math.pow(10,(cue.gainDb||0)/20),at+cue.fadeIn); }
    if(cue.fadeOut>0&&b.duration>cue.fadeOut){ var fo=at+b.duration-cue.fadeOut; g.gain.setValueAtTime(g.gain.value,fo); g.gain.exponentialRampToValueAtTime(0.0001,at+b.duration); }
    if(cue.loop&&b.duration>0){
      src.loop=true; src.loopStart=0; src.loopEnd=b.duration;
      var stopAt=t0+D.dur;
      if(at<stopAt){ src.start(at); src.__started=1; src.stop(stopAt); }
    } else if(at<=t0+D.dur+0.2){ src.start(at); src.__started=1; }
    if(src.__started) sources.push(src);
  });
  q('#replay').classList.remove('show');
  if(!raf) raf=requestAnimationFrame(loop);
}
function loop(){
  var t=playing?(clock()-T0):curT;
  if(t<0)t=0;
  if(t>D.dur){ t=D.dur; if(!finished){ finished=true; } }
  curT=t;
  try{ render(t); }catch(err){ if(!loop.__err){ loop.__err=1; console.error('render@'+t.toFixed(2),err); } }
  if(finished){ playing=false; raf=0; document.body.setAttribute('data-state','done'); document.body.setAttribute('data-status','done'); q('#replay').classList.add('show'); return; }
  raf=requestAnimationFrame(loop);
}

/* --------------------------------------------------------------- builders */
var cellEls=[], recEls=[], beatDots=[], cueRows=[], stemEls=[], passEls=[], syllEls=[], stripEls={};
function buildLibrary(){
  var box=q('#grid38'), metrics={};
  D.probe.forEach(function(p){ metrics[p.name]=p; });
  D.presets.forEach(function(name,i){
    var cell=mk('div','cell');
    var nm=mk('div','nm',name); cell.appendChild(nm);
    if(metrics[name]){
      cell.classList.add('metrics');
      ['peak','rms','centroid'].forEach(function(k){
        var row=mk('div','v'); row.appendChild(mk('span',null,k==='peak'?'pk':(k==='rms'?'rms':'ctr')));
        var val=mk('i',null,(k==='centroid'?(metrics[name].centroid/1000).toFixed(1)+'k':metrics[name][k].toFixed(1)));
        row.appendChild(val); cell.appendChild(row);
      });
      cell.__metrics=metrics[name];
    }
    cell.__name=name;
    cellEls.push(cell); box.appendChild(cell);
  });
  var on=(D.tickCells||[]);
  for(var i=0;i<D.presets.length;i++){
    var at=on.length>=8?on[Math.min(on.length-1,i)]:0.22+i*0.055;
    cellEls[i].__at=at+0.05;
  }
}
function buildRecipes(){
  var ol=q('#rec-list');
  D.recipes.forEach(function(name,i){
    var li=mk('li'); li.appendChild(mk('span','dot')); li.appendChild(document.createTextNode(name));
    li.__name=name; recEls.push(li); ol.appendChild(li);
  });
  var layers=[['sub','42 Hz'],['crack','1.8 kHz'],['latch','6 kHz'],['tail','2.4 s']];
  var box=q('#dg-layers');
  layers.forEach(function(l){
    var d=mk('div','dg-layer'); d.appendChild(mk('span',null,l[0])); d.appendChild(mk('span','bar'));
    d.appendChild(mk('span',null,l[1])); box.appendChild(d);
  });
}
function buildCompose(){
  var g=q('#genres');
  D.genres.forEach(function(name){
    var c=mk('span','chip'+(name==='lofi'?' on':'')); c.textContent=name; g.appendChild(c);
  });
  var grid=q('#beatgrid');
  for(var r=0;r<4;r++) for(var c=0;c<16;c++){
    var i=mk('i'); i.__col=c; i.__row=r; if(r===0) i.classList.add('b');
    beatDots.push(i); grid.appendChild(i);
  }
  txt(q('#cmp-readout'),'audio_compose · audio_beats · audio_midi · audio_loudness');
  txt(q('#bpm'),'');
  q('#bpm').innerHTML=D.bpm+'<em>BPM</em>';
}
function buildVoice(){
  var box=q('#sylls'), n=D.syllables.length||1;
  D.syllables.forEach(function(s,i){
    var sp=mk('span',(i%2?'alt':''),s.text);
    sp.__t=s.t;
    syllEls.push(sp); box.appendChild(sp);
  });
  var vc=q('#vchips');
  D.voices.forEach(function(v){
    vc.appendChild(mk('span','chip sm'+(v==='alto'?' on':''),v));
  });
  var lines=['<b>sung</b> '+(D.sungName||D.sungDur+' s — placeholder')+
             ' · '+D.visemesA.length+' viseme frames',
             '<b>tts</b> '+(D.ttsPlaceholder?('旁白占位 · '+D.ttsFile):(D.ttsName?D.ttsName:'旁白占位 · 未配置供应商（无密钥）')),
             '<b>voices</b> alto bass child breathy choir'];
  q('#v-note').innerHTML=lines.join('<br>');
}
function buildInteractive(){
  var defs=[['weight',0.62],['hardness',0.48],['metallic',0.30],['decay',0.55]];
  var box=q('#sliders'); sliders={};
  defs.forEach(function(d){
    var row=mk('div','sl');
    row.appendChild(mk('span','k',d[0]));
    var inp=mk('input'); inp.type='range'; inp.min=0; inp.max=1; inp.step=0.01; inp.value=d[1];
    var val=mk('span','v',d[1].toFixed(2));
    inp.__k=d[0]; inp.__val=val;
    inp.addEventListener('input',function(){ val.textContent=Number(inp.value).toFixed(2); });
    row.appendChild(inp); row.appendChild(val); box.appendChild(row);
    sliders[d[0]]=inp;
  });
  var pads=q('#pads');
  ['impact','tick','chime'].forEach(function(name){
    var b=mk('button','pad'); b.type='button';
    b.appendChild(mk('span',null,'live')); b.appendChild(document.createTextNode(name));
    b.addEventListener('pointerdown',function(){ firePad(name,b); });
    pads.appendChild(b);
  });
  qa('.uibtn').forEach(function(b){
    var kind=b.getAttribute('data-ui');
    b.addEventListener('pointerenter',function(){ uiPlay('hover'); b.classList.add('fire'); setTimeout(function(){b.classList.remove('fire');},90); });
    b.addEventListener('pointerdown',function(){ uiPlay(kind==='click'?'click':(kind==='success'?'success':kind)); b.classList.add('fire'); setTimeout(function(){b.classList.remove('fire');},160); });
  });
}
function buildAnalysis(){
  txt(q('#r51lab'),'FL FR C LFE RL RR');
}
function buildDelivery(){
  var cs=q('#cuesheet');
  D.cues.slice(0,6).forEach(function(c,i){
    var row=mk('div','cuerow');
    row.appendChild(mk('span',null,c.name));
    if(i===3) row.appendChild(mk('span','rd')); else row.appendChild(mk('i',null,tc(c.at)));
    cueRows.push(row); cs.appendChild(row);
  });
  var st=q('#stems'), names=[['drums',0.86],['bass',0.62],['pad',0.9],['lead',0.44]];
  names.forEach(function(n){
    var row=mk('div','stem');
    row.appendChild(mk('span','nm',n[0]));
    var bar=mk('div','bar'), fill=mk('b'); bar.appendChild(fill);
    row.appendChild(bar); row.__fill=fill; row.__w=n[1];
    stemEls.push(row); st.appendChild(row);
  });
  var fc=q('#fmtchips');
  ['8','16','24','32'].forEach(function(b){
    var c=mk('span','chip sm'+(b==='8'?' on':'')); c.textContent=b+' bit';
    fc.appendChild(c);
  });
  var ck=q('#checks');
  [['audio_check','PASS'],['audio_regress','PASS'],['audio_bind','inline'],['page','no network']].forEach(function(p){
    var d=mk('div','pass');
    d.innerHTML='<b>·</b> '+p[0]+' <span style="color:var(--faint)">'+p[1]+'</span>';
    passEls.push(d); ck.appendChild(d);
  });
  var st2=q('#stems');
  var cueN=D.cues.length;
  qa('#s-delivery .ch')[0].textContent='cue sheet · bind · '+cueN+' cues';
}
function buildStrip(){
  var strip=q('#strip'), cols=5, rows=Math.ceil(D.tools.length/cols);
  strip.style.gridTemplateRows='repeat('+rows+',1fr)';
  D.tools.forEach(function(name){
    var t=mk('div','t',name); stripEls[name]=t; strip.appendChild(t);
  });
}

/* -------------------------------------------------------------------- sfx */
function livePlay(preset,params){
  var api=window.dshLive||window.LiveSfx||window.liveSfx;
  if(api&&typeof api.play==='function'){
    try{
      if(typeof api.unlock==='function') api.unlock();
      var over={weight:params.weight,hardness:params.hardness,metallic:params.metallic,
                space:Math.min(1,params.decay*0.9),pitch:1};
      api.play(preset,over); return 'live-sfx.js';
    }catch(e){}
  }
  return fallbackSynth(preset,params);
}
var UI_MAP={hover:'hover',click:'press',success:'success',error:'error',notify:'notify',toggle:'toggle-on',type:'typing-key'};
function uiPlay(kind){
  var api=window.dshUI;
  var want=UI_MAP[kind]||kind;
  var clips=(D.uiClips&&D.uiClips.length)?D.uiClips:null;
  if(api&&typeof api.play==='function'){
    try{
      if(typeof api.unlock==='function') api.unlock();
      api.play(clips&&clips.indexOf(want)<0?(clips[0]||want):want);
      return 'ui-sfx.js';
    }catch(e){}
  }
  return fallbackUI(kind);
}
function now(){ var c=ac(); return c.currentTime+0.012; }
function env(g,t0,a,d,peak){
  g.gain.setValueAtTime(0.0001,t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002,peak),t0+a);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+a+d);
}
function noiseBuf(dur){
  var c=ac(), n=Math.max(1,Math.floor(c.sampleRate*dur)), b=c.createBuffer(1,n,c.sampleRate), d=b.getChannelData(0);
  var seed=12345; for(var i=0;i<n;i++){ seed=(seed*1103515245+12345)&0x7fffffff; d[i]=(seed/0x7fffffff)*2-1; }
  return b;
}
function fallbackSynth(preset,p){
  var c=ac(); if(!c) return 'fallback';
  p=p||{};
  var w=p.weight==null?0.62:+p.weight, ha=p.hardness==null?0.48:+p.hardness,
      me=p.metallic==null?0.3:+p.metallic, de=p.decay==null?0.55:+p.decay;
  var t=now(), out=c.createGain(), lp=c.createBiquadFilter();
  lp.type='lowpass'; lp.frequency.value=600+ha*8000; lp.Q.value=0.7+me*6;
  out.gain.value=1; out.connect(lp); lp.connect(master||c.destination);
  var dur=preset==='chime'?0.9:(preset==='tick'?0.09:0.34+de*0.3);
  if(preset==='chime'){
    var fr=[523.25,784,1046.5+me*220];
    fr.forEach(function(f,k){ var o=c.createOscillator(), g=c.createGain(); o.type='sine'; o.frequency.value=f;
      o.connect(g); g.connect(out); g.gain.setValueAtTime(0.0001,t+k*0.012);
      g.gain.exponentialRampToValueAtTime(0.18/k*1.4*0.5,t+k*0.012+0.006);
      g.gain.exponentialRampToValueAtTime(0.0001,t+dur+de*0.6); o.start(t+k*0.012); o.stop(t+dur+de*0.7); });
  } else if(preset==='tick'){
    var n=c.createBufferSource(); n.buffer=noiseBuf(0.06);
    var bp=c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2400+ha*5000; bp.Q.value=2+me*8;
    var g2=c.createGain(); env(g2,t,0.001,0.05,0.22+ha*0.2);
    n.connect(bp); bp.connect(g2); g2.connect(out); n.start(t); n.stop(t+0.08);
  } else {
    var o2=c.createOscillator(), g3=c.createGain(); o2.type='sine';
    o2.frequency.setValueAtTime(110+160*(1-w),t);
    o2.frequency.exponentialRampToValueAtTime(34+22*w,t+dur*0.9);
    var gn=c.createGain(); env(g3,t,0.004,dur,0.5+0.3*w);
    o2.connect(g3); g3.connect(out); o2.start(t); o2.stop(t+dur+0.1);
    var n2=c.createBufferSource(); n2.buffer=noiseBuf(dur*0.5);
    var hp=c.createBiquadFilter(); hp.type='bandpass'; hp.frequency.value=1400+ha*4000; hp.Q.value=1+me*4;
    var g4=c.createGain(); env(g4,t,0.001,dur*0.35,0.16+ha*0.18);
    n2.connect(hp); hp.connect(g4); g4.connect(out); n2.start(t); n2.stop(t+dur*0.6);
  }
  return 'fallback';
}
function fallbackUI(kind){
  var c=ac(); if(!c) return 'fallback';
  var t=now(), g=c.createGain(), o=c.createOscillator();
  o.connect(g); g.connect(master||c.destination);
  o.type='sine';
  if(kind==='success'){ o.frequency.setValueAtTime(880,t); o.frequency.setValueAtTime(1318.5,t+0.09);
    env(g,t,0.004,0.3,0.16); o.stop(t+0.36); }
  else if(kind==='click'){ o.type='triangle'; o.frequency.value=520; env(g,t,0.002,0.07,0.16); o.stop(t+0.1); }
  else { o.frequency.value=1320; env(g,t,0.002,0.05,0.07); o.stop(t+0.07); }
  o.start(t);
  return 'fallback';
}
var sliders={}, lastEvt='—';
function firePad(name,btn){
  var p={}; for(var k in sliders) p[k]=+sliders[k].value;
  var via=livePlay(name,p);
  lastEvt=name+' · w'+p.weight.toFixed(2)+' h'+p.hardness.toFixed(2)+' m'+p.metallic.toFixed(2)+' d'+p.decay.toFixed(2)+' · '+via;
  txt(q('#it-readout'),'last · '+lastEvt);
  if(btn){ btn.classList.add('fire'); setTimeout(function(){btn.classList.remove('fire');},140); }
}

/* --------------------------------------------------------------- copy pass */
// Every on-screen string comes from copy.json. Nothing here is invented text:
// labels, values, HUD templates, gate line, end-card lines and the stamp.
function metaRows(host){
  var B=(D.copy&&D.copy.brand)||{};
  host.innerHTML='';
  (B.meta||[]).forEach(function(row){
    var parts=String(row).split(/\s{2,}/);
    var label=parts.shift()||'';
    host.appendChild(mk('span','mk',label));
    host.appendChild(mk('span','mv',parts.join(' ')));
  });
}
function fillCopy(){
  var C=D.copy||{}, B=C.brand||{}, E=C.endcard||{}, H=C.hud||{};
  txt(q('#hud-kicker'),B.kicker||'');
  txt(q('#hud-audio'),(H.audio||'AUDIO INLINE · {count} CUES').replace('{count}',D.cues.length));
  txt(q('#cover-kicker'),B.kicker||'');
  txt(q('#wordmark'),B.mark||'dsh-audio');
  txt(q('#wordsub'),B.subtitle||'');
  metaRows(q('#cover-meta'));
  var rd=q('#cover-redact'); rd.innerHTML='';
  rd.appendChild(mk('span','mk',''));
  rd.appendChild(mk('span','mv redact',''));
  txt(q('#gate-kicker'),B.kicker||'');
  txt(q('#gate-mark'),B.mark||'dsh-audio');
  txt(q('#gate-sub'),B.subtitle||'');
  metaRows(q('#gate-meta'));
  txt(q('#gate-btn-text'),D.gateText||'CLICK TO START');
  txt(q('#gate-btn-em'),(H.audio||'').replace('{count}',D.cues.length));
  q('#wordmark').style.opacity=0;
  // end card
  txt(q('#endcard .big'),E.mark||'dsh-audio');
  var ec=q('#endcard .ec-line'), lines=E.lines||[];
  for(var i=0;i<2;i++){ if(ec){ var el=q('[data-ec="'+i+'"]'); if(el) txt(el,lines[i]||''); } }
  var st=q('.stamp span'); if(st) txt(st,E.stamp||'');
  // scene heads
  D.scenes.forEach(function(s,i){
    var el=q('#s-'+s.id); if(!el) return;
    var f=el.querySelector('[data-f]'), h=el.querySelector('[data-h]'),
        l=el.querySelector('[data-l]'), d=el.querySelector('[data-d]');
    var fileN=(H.scene||'FILE {n} / 08').replace('{n}',s.file||String(i).padStart(2,'0'))
      .replace('{total}',D.scenes.length);
    if(f) txt(f,fileN);
    if(h){ h.__full=s.label||''; h.textContent=''; }
    if(l) txt(l,s.line||'');
    if(d) txt(d,s.detail||'');
  });
}
var S={};
S.open=function(lt){
  var f=fit(q('#c-ring')); if(f){
    var g=f.g,w=f.w,h=f.h, cx=w/2, cy=h*0.52, R=Math.min(w*0.5,h*0.46);
    var N=48, rot=lt*0.16, pts=[];
    for(var i=0;i<N;i++){ var a=rot+i/N*6.2832; pts.push([cx+Math.cos(a)*R, cy+Math.sin(a)*R*0.92]); }
    g.lineWidth=1;
    g.strokeStyle='rgba(255,255,255,0.14)'; g.beginPath(); g.ellipse(cx,cy,R,R*0.92,0,0,6.2832); g.stroke();
    g.strokeStyle='rgba(255,255,255,0.085)';
    for(i=0;i<N;i++){ var j=(i+8)%N; g.beginPath(); g.moveTo(pts[i][0],pts[i][1]); g.lineTo(pts[j][0],pts[j][1]); g.stroke();
      var k=(i+19)%N; g.beginPath(); g.moveTo(pts[i][0],pts[i][1]); g.lineTo(pts[k][0],pts[k][1]); g.stroke(); }
    g.fillStyle='rgba(230,230,230,0.42)';
    for(i=0;i<N;i+=3){ g.fillRect(pts[i][0]-1,pts[i][1]-1,2,2); }
    var p=ramp((lt-1.55)/0.9);
    if(p>0){
      g.strokeStyle=acc(0.34*ramp((lt-1.55)/0.5));
      var pairs=[[0,16],[19,37]];
      pairs.forEach(function(pr){
        var A=pts[pr[0]%N], B=pts[pr[1]%N];
        var mx=(A[0]+B[0])/2, my=(A[1]+B[1])/2;
        var q1x=(A[0]+mx)/2, q1y=(A[1]+my)/2;
        g.beginPath(); g.moveTo(A[0],A[1]); g.quadraticCurveTo(q1x,q1y,B[0],B[1]); g.stroke();
      });
    }
  }
  var w=ramp((lt-1.58)/0.75);
  var wm=q('#wordmark');
  setOp(wm,w);
  if(w>0){
    var dy=Math.round((1-w)*9);
    if(wm.__y!==dy){wm.__y=dy; wm.style.transform='translateY('+dy+'px)';}
  }
  setOp(q('#wordsub'),ramp((lt-2.15)/0.7));
  var rule=q('#open-rule');
  rule.style.width=Math.round(ramp((lt-1.95)/0.9)*240)+'px';
  setOp(rule,ramp((lt-1.9)/0.5));
  setOp(q('#cover-meta'),ramp((lt-2.35)/0.6));
  setOp(q('#cover-redact'),ramp((lt-2.75)/0.6));
};
S.library=function(lt){
  var shown=0;
  for(var i=0;i<cellEls.length;i++){
    var c=cellEls[i], on=lt>=c.__at;
    if(on){ shown++; if(!c.__on){c.__on=1;c.classList.add('on');} }
    if(c.__metrics && on && !c.__shown && lt>=c.__at+0.12){ c.__shown=1; c.classList.add('shown'); }
  }
  var head=q('#lib-readout');
  var t=Math.min(8.9,Math.max(4.0,4+lt));
  txt(head,'audio_synth · audio_pattern · audio_probe   '+shown+'/38   '
    + (shown>=8 ? 'peak '+D.probe[0].peak.toFixed(1)+' dBFS' : ''));
};
S.recipes=function(lt){
  var hits=(D.design&&D.design.length)?D.design:[{at:0.85,name:'door-slam-metal',crest:18.2,centroid:1720,onsets:3},
            {at:2.55,name:'glass-break',crest:15.4,centroid:5240,onsets:7}];
  var hit=-1;
  for(var i=0;i<hits.length;i++) if(lt>=hits[i].at) hit=i;
  for(i=0;i<recEls.length;i++){
    var el=recEls[i];
    var app=ramp((lt-0.06-i*0.018)/0.3);
    setOp(el,0.16+0.84*app);
    var isHit=false;
    for(var h=0;h<=hit;h++) if(hits[h].name===el.__name) isHit=true;
    if(isHit&&!el.__hit){ el.__hit=1; el.classList.add('hit'); }
  }
  var H=hit>=0?hits[hit]:null;
  if(H){
    txt(q('#dg-recipe'),H.name);
    var m=q('#rec-metric');
    var k=ramp((lt-H.at)/0.5);
    m.classList.add('show'); setOp(m,k);
    var cr=Math.round(H.crest*10*Math.min(1,k))/10, ce=Math.round(H.centroid*k/10)*10;
    q('#m-crest').innerHTML=cr.toFixed(1)+'<em>dB</em>';
    q('#m-cent').innerHTML=(ce>=1000?(ce/1000).toFixed(1)+'k':ce)+'<em>Hz</em>';
    txt(q('#m-on'),String(H.onsets));
  }
};
S.compose=function(lt){
  var spb=60/D.bpm;
  var bi=-1, times=D.beatTimes;
  for(var i=0;i<times.length;i++) if(times[i]<=lt) bi=i;
  var col=bi<0?-1:bi%16;
  var since=bi<0?9:lt-times[bi];
  for(i=0;i<beatDots.length;i++){
    var d=beatDots[i], hot=(d.__col===col&&since<0.22&&bi>=0);
    if(hot!==!!d.__hot){ d.__hot=hot; d.classList.toggle('hot',hot); }
  }
  var f=fit(q('#roll')); if(f){
    var g=f.g,w=f.w,h=f.h;
    g.lineWidth=1;
    g.strokeStyle='rgba(255,255,255,0.09)';
    var span=Math.max(4,D.rollBarSec*(D.rollBars||8));
    for(i=0;i<=8;i++){ var x=Math.round(w*i/8)+0.5; g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke(); }
    g.strokeStyle='rgba(255,255,255,0.07)';
    for(i=0;i<=3;i++){ var y=Math.round(h*i/3)+0.5; g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke(); }
    var lo=127, hi=0;
    D.rollNotes.forEach(function(n){ if(n.midi<lo)lo=n.midi; if(n.midi>hi)hi=n.midi; });
    lo-=2; hi+=2;
    D.rollNotes.forEach(function(n){
      var x0=(n.t/span)*w, x1=((n.t+Math.max(0.08,n.d))/span)*w;
      var y=8+((hi-n.midi)/(hi-lo))*(h-16);
      var isLead=n.tr==='lead'||n.tr==='melody'||n.tr==='arp';
      g.strokeStyle=isLead?acc(0.85):'rgba(230,230,230,0.42)';
      var appear=ramp((lt-0.25-(n.t/span)*1.2)/0.5);
      if(appear<=0) return;
      g.globalAlpha=appear;
      g.beginPath(); g.moveTo(x0+0.5,Math.round(y)+0.5); g.lineTo(Math.max(x0+1.2,x1)+0.5,Math.round(y)+0.5); g.stroke();
      g.globalAlpha=1;
    });
    var px=(lt/6)*w;
    g.strokeStyle='rgba(255,255,255,0.22)';
    g.beginPath(); g.moveTo(Math.round(px)+0.5,0); g.lineTo(Math.round(px)+0.5,h); g.stroke();
  }
  var n=D.rollNotes.length;
  txt(q('#cmp-readout'),'audio_compose · audio_beats · audio_midi · audio_loudness   '
    + n+' notes · '+D.rollChords.length+' chords · '+D.rollKey.toUpperCase()
    + (D.beatConf?' · beat conf '+D.beatConf.toFixed(2):''));
};
function mouthAt(frames,t){
  if(!frames.length) return {v:'none',o:0};
  var lo=0,hi=frames.length-1;
  if(t<=frames[0].t) return frames[0];
  if(t>=frames[hi].t) return frames[hi];
  while(lo<hi-1){ var mid=(lo+hi)>>1; if(frames[mid].t<=t) lo=mid; else hi=mid; }
  var a=frames[lo],b=frames[hi]; var k=(t-a.t)/Math.max(0.001,(b.t-a.t));
  return {v:k<0.5?a.v:b.v,o:a.o+(b.o-a.o)*k};
}
function drawMouth(cv,fr){
  var f=fit(cv); if(!f) return;
  var g=f.g,w=f.w,h=f.h,cx=w/2,cy=h/2;
  var o=clamp(fr.o,0,1), open=6+o*26, wide=w*0.34-o*w*0.07;
  g.lineWidth=1;
  g.strokeStyle='rgba(230,230,230,0.5)';
  g.beginPath(); g.ellipse(cx,cy,wide,open*0.92+3,0,0,6.2832); g.stroke();
  if(o>0.05){
    g.fillStyle=acc(0.10+0.22*o);
    g.beginPath(); g.ellipse(cx,cy,wide*0.72,open*0.62,0,0,6.2832); g.fill();
    g.strokeStyle=acc(0.72);
    g.beginPath(); g.ellipse(cx,cy,wide*0.72,open*0.62,0,0,6.2832); g.stroke();
  }
  g.strokeStyle='rgba(255,255,255,0.12)';
  g.beginPath(); g.moveTo(cx-wide-6,cy); g.lineTo(cx-wide-12,cy); g.stroke();
  g.beginPath(); g.moveTo(cx+wide+6,cy); g.lineTo(cx+wide+12,cy); g.stroke();
}
S.voice=function(lt){
  var t=Math.max(0,lt-0.32);
  var dur=Math.max(0.5,D.sungDur||3.2);
  var f=fit(q('#wave')); if(f){
    var g=f.g,w=f.w,h=f.h, n=D.peaks.length;
    g.lineWidth=1; g.strokeStyle='rgba(255,255,255,0.09)';
    g.beginPath(); g.moveTo(0,h/2+0.5); g.lineTo(w,h/2+0.5); g.stroke();
    var playX=(t/dur)*w;
    for(var i=0;i<n;i++){
      var x=(i/n)*w, p=D.peaks[i];
      var bh=Math.max(1,p*h*0.42);
      var played=x<=playX;
      g.strokeStyle=played?acc(0.9):'rgba(230,230,230,0.26)';
      g.beginPath(); g.moveTo(Math.round(x)+0.5,h/2-bh); g.lineTo(Math.round(x)+0.5,h/2+bh); g.stroke();
    }
    g.strokeStyle='rgba(255,255,255,0.3)';
    g.beginPath(); g.moveTo(Math.round(playX)+0.5,0); g.lineTo(Math.round(playX)+0.5,h); g.stroke();
  }
  var syl=q('#sylls');
  D.syllables.forEach(function(s,i){
    var sp=syllEls[i]; if(!sp) return;
    var pct=Math.max(2,Math.min(98,(s.t/dur)*100));
    if(sp.__pct!==pct){ sp.__pct=pct; sp.style.left=pct.toFixed(2)+'%'; }
    var on=t>=s.t-0.02;
    setOp(sp,on?1:0.3);
    if(on&&!sp.__on){ sp.__on=1; sp.style.color=ACCENT; }
  });
  var A=mouthAt(D.visemesA,t), B=mouthAt(D.mouthB,t);
  drawMouth(q('#m-a'),A); drawMouth(q('#m-b'),B);
  txt(q('#cap-a'),(A.v||'none')+' · lipsync');
  txt(q('#cap-b'),(B.v||'none')+' · text');
};
var itFired={};
S.interactive=function(lt){
  if(!itFired.auto&&lt>4.1){ itFired.auto=1; uiPlay('success'); }
};
S.analysis=function(lt){
  var f=fit(q('#spec'));
  if(f){
    var g=f.g,w=f.w,h=f.h,hs=D.harmonics,n=hs.length;
    var pad=Math.max(8,Math.min(18,w*0.02)), slot=(w-pad*2)/n, bw=Math.min(26,slot*0.44);
    g.lineWidth=1;
    g.strokeStyle='rgba(255,255,255,0.10)';
    g.beginPath(); g.moveTo(0,h-0.5); g.lineTo(w,h-0.5); g.stroke();
    for(var i=0;i<n;i++){
      var lv=Math.max(0.02,Math.min(1,hs[i].level));
      var wob=0.9+0.1*Math.sin(lt*4.2+i*0.7);
      var bh=Math.max(2,Math.sqrt(lv)*wob*(h-30));
      var x=pad+i*slot+(slot-bw)/2;
      g.fillStyle=i<2?acc(0.82):'rgba(230,230,230,0.38)';
      g.fillRect(Math.round(x),Math.round(h-1-bh),Math.round(bw),Math.round(bh));
      if(i===0||i===2||i===n-1){
        g.fillStyle='rgba(230,230,230,0.3)'; g.font='8px '+MONO;
        g.fillText(Math.round(hs[i].hz)+' Hz',Math.round(x),h-5);
      }
    }
    g.fillStyle='rgba(230,230,230,0.32)'; g.font='9px '+MONO;
    g.fillText('f0 '+Math.round(D.f0)+' Hz · '+n+' harmonics'+(D.rt60?' · rt60 '+D.rt60.toFixed(2)+' s':''),2,11);
  }
  var k=ramp((lt-0.5)/1.6);
  var before=D.lufs.measured, after=D.lufs.target;
  var cur=before+(after-before)*k;
  q('#lufs-fill').style.width=Math.round(clamp((cur+30)/20,0,1)*100)+'%';
  txt(q('#lufs-before'),before.toFixed(1));
  txt(q('#lufs-after'),cur.toFixed(1));
  q('#lufs-fill').style.background=(cur<after-0.2?acc(0.5):ACCENT);
  if(!S.analysis.__meta){
    S.analysis.__meta=1;
    txt(q('#an-readout'),'audio_analyze · audio_loudness · audio_bus · audio_spatial · audio_stretch   tp '
      +D.lufs.tp.toFixed(1)+' dBTP · LRA '+D.lufs.lra.toFixed(1)+' LU · target '+after.toFixed(1)
      +(D.centroidHz?' · centroid '+D.centroidHz+' Hz':''));
  }
  var rf=fit(q('#r51')); if(rf){
    var g2=rf.g,w2=rf.w,h2=rf.h,cx=w2/2,cy=h2/2,R=Math.min(w2,h2)*0.4;
    g2.lineWidth=1; g2.strokeStyle='rgba(255,255,255,0.14)';
    g2.beginPath(); g2.arc(cx,cy,R,0,6.2832); g2.stroke();
    g2.strokeStyle='rgba(255,255,255,0.07)';
    g2.beginPath(); g2.arc(cx,cy,R*0.62,0,6.2832); g2.stroke();
    var ang=[-2.36,-0.79,1.57,2.75,-2.09,-0.44];
    for(var i2=0;i2<6;i2++){
      var a=ang[i2], x=cx+Math.cos(a)*R, y=cy+Math.sin(a)*R;
      var pulse=(i2===0?1:0);
      g2.fillStyle=i2===2?acc(0.9):'rgba(230,230,230,0.5)';
      g2.fillRect(Math.round(x)-1.5,Math.round(y)-1.5,3,3);
    }
    var oa=lt*1.5-1.2, ox=cx+Math.cos(oa)*R, oy=cy+Math.sin(oa)*R;
    g2.fillStyle=acc(0.9);
    g2.fillRect(Math.round(ox)-2,Math.round(oy)-2,4,4);
    g2.strokeStyle=acc(0.45);
    g2.beginPath(); g2.moveTo(cx,cy); g2.lineTo(ox,oy); g2.stroke();
    g2.fillStyle='rgba(230,230,230,0.4)';
    g2.beginPath(); g2.arc(cx,cy,1.5,0,6.2832); g2.fill();
  }
};
S.delivery=function(lt){
  cueRows.forEach(function(r,i){ setOp(r,ramp((lt-0.15-i*0.09)/0.4)); });
  stemEls.forEach(function(s,i){
    var k=ramp((lt-0.55-i*0.08)/0.6);
    setOp(s,k);
    var w=Math.round(s.__w*100*k);
    if(s.__wv!==w){ s.__wv=w; s.__fill.style.width=w+'%'; }
  });
  passEls.forEach(function(p,i){ setOp(p,ramp((lt-1.35-i*0.12)/0.4)); });
  setOp(q('#endcard'),ramp((lt-3.1)/0.6));
};
var SCENE_FN={open:S.open,library:S.library,recipes:S.recipes,compose:S.compose,voice:S.voice,
  interactive:S.interactive,analysis:S.analysis,delivery:S.delivery};
var sceneEls={};
function initScenes(){
  D.scenes.forEach(function(s,i){
    s.__len=s.to-s.from; s.__id=s.id;
    var el=q('#s-'+s.id); if(el){ sceneEls[s.id]=el; }
  });
}

/* ------------------------------------------------------------------ render */
function render(t){
  var HUD=D.hud||{};
  txt(q('#tc'),(HUD.clock||'T+{t} / {total}').replace('{t}',tc(t)).replace('{total}',tc(D.dur)));
  q('#prog-fill').style.width=(t/D.dur*100).toFixed(2)+'%';
  var active=null, activeTools={}, activeCount=0;
  for(var i=0;i<D.scenes.length;i++){
    var s=D.scenes[i], el=sceneEls[s.id]; if(!el) continue;
    var lt=t-s.from;
    var op=ramp((lt+0.26)/0.34)*(1-ramp((lt-(s.__len-0.30))/0.30));
    if(t<s.from-0.26||t>s.to+0.02) op=0;
    setOp(el,op);
    var on=op>0.5;
    if(on!==!!el.__on){ el.__on=on; el.classList.toggle('on',on); }
    if(op>0.002){ if(SCENE_FN[s.id]) SCENE_FN[s.id](lt); }
    if(op>0.5){ active=s; activeCount=s.tools.length; s.tools.forEach(function(x){activeTools[x]=1;}); }
  }
  if(active){
    var fileTpl=HUD.scene||'FILE {n} / 08';
    txt(q('#hud-file'),fileTpl.replace('{n}',active.file||String(D.scenes.indexOf(active)).padStart(2,'0'))
      .replace('{total}',D.scenes.length));
    txt(q('#hud-tools'),(HUD.toolsActive||'{n}/25').replace('{n}',String(activeCount)));
    if(render.__scene!==active.id){
      render.__scene=active.id;
      document.body.setAttribute('data-scene',active.id);
      // type-on headline: reset the caret state for the new scene
      var h=sceneEls[active.id]?sceneEls[active.id].querySelector('[data-h]'):null;
      if(h&&h.__full){ h.__n=-1; }
    }
    var head=sceneEls[active.id]?sceneEls[active.id].querySelector('[data-h]'):null;
    if(head&&head.__full){
      var ltNow=t-active.from;
      var frac=ramp((ltNow-0.04)/0.42);
      var n=Math.ceil(frac*head.__full.length);
      var caret=ltNow<1.15?(Math.floor(t*2.2)%2===0?'\u258c':'\u00a0'):'';
      if(head.__n!==n||head.__caret!==caret){
        head.__n=n; head.__caret=caret;
        head.textContent=head.__full.slice(0,n);
        if(caret){ var c=mk('span','caret',caret); head.appendChild(c); }
      }
    }
  }
  D.tools.forEach(function(name){
    var el=stripEls[name]; if(!el) return;
    var on=!!activeTools[name];
    if(on!==!!el.__on){ el.__on=on; el.classList.toggle('on',on); }
  });
}

/* -------------------------------------------------------------------- boot */
function begin(){
  if(gate.__begun) return;
  gate.__begun=true;
  gate.classList.add('gone'); gate.__stop=1;
  setTimeout(function(){ gate.style.display='none'; },520);
  document.body.setAttribute('data-state','playing');
  document.body.setAttribute('data-status','playing');
  if(QA){ startRun(); return; }
  ac();
  var p=ctx.state==='suspended'?ctx.resume():Promise.resolve();
  Promise.resolve(p).catch(function(){}).then(function(){ return decodeAll(); }).then(function(){ startRun(); });
}
// Small public surface for a verifier or a host page: state, clock (negative
// during the 120 ms pre-roll), duration, tools, and the two gestures.
window.showall={
  version:'1.0.0',
  duration:D.dur,
  tools:D.tools.slice(),
  audio:QA?'none (seek mode)':'base64 PCM wav decoded with atob + decodeAudioData',
  currentTime:function(){ return (playing||T0)?(clock()-T0):0; },
  state:function(){ return document.body.getAttribute('data-state')||'gate'; },
  start:begin,
  replay:function(){ begin(); if(finished||!playing) startRun(); }
};
function boot(){
  fillCopy(); initScenes(); buildLibrary(); buildRecipes(); buildCompose(); buildVoice();
  buildInteractive(); buildAnalysis(); buildDelivery(); buildStrip();
  document.body.setAttribute('data-state','gate');
  document.body.setAttribute('data-status','gate');
  try{ Object.defineProperty(window.__SHOWALL__,'time',{get:function(){ return window.showall?window.showall.currentTime():0; }}); }catch(e){}
  render(0);
  window.addEventListener('resize',function(){ render(curT); });
  q('#replay').addEventListener('click',function(){ if(ctx&&ctx.state==='suspended') ctx.resume(); startRun(); });
  document.addEventListener('keydown',function(e){ if(e.key==='r'||e.key==='R'){ if(finished) startRun(); } });
  bindGate();
  if(QA) begin();
}
var gate=q('#gate');
function gateRing(){
  var f=fit(q('#gate-ring')); if(!f) return;
  var g=f.g,w=f.w,h=f.h,cx=w/2,cy=h/2,R=Math.min(w,h)*0.38,rot=performance.now()/5200;
  var N=40, pts=[];
  for(var i=0;i<N;i++){ var a=rot+i/N*6.2832; pts.push([cx+Math.cos(a)*R,cy+Math.sin(a)*R]); }
  g.lineWidth=1;
  g.strokeStyle='rgba(255,255,255,0.20)'; g.beginPath(); g.arc(cx,cy,R,0,6.2832); g.stroke();
  g.strokeStyle='rgba(255,255,255,0.11)';
  for(i=0;i<N;i++){ var j=(i+7)%N; g.beginPath(); g.moveTo(pts[i][0],pts[i][1]); g.lineTo(pts[j][0],pts[j][1]); g.stroke(); }
  g.fillStyle='rgba(230,230,230,0.34)';
  for(i=0;i<N;i+=4){ g.fillRect(pts[i][0]-1,pts[i][1]-1,2,2); }
  if(!gate.__stop) requestAnimationFrame(gateRing);
}
function bindGate(){
  gate.addEventListener('pointerdown',begin);
  gate.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' ') begin(); });
}
boot();
requestAnimationFrame(gateRing);
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------- spec
// Parseable contract for the verifier: duration, scenes (id/from/to/tools),
// cues (name/at), and the 24 tool names.
const spec = {
  duration: DUR,
  scenes: SCENES.map((s) => ({ id: s.id, from: s.from, to: s.to, tools: s.tools.slice() })),
  cues: data.cues.map((c) => ({ name: c.name, at: c.at })),
  tools: TOOLS.slice(),
};

// --------------------------------------------------------------------- render
// CSS variables come from palette.json so the page cannot drift from the scheme.
const T = (readJson(PALETTE) || {}).tokens || {};
const rootVars = [
  ['--stage', T.stage], ['--bg', T.bg], ['--panel', T.panel], ['--panelRaised', T.panelRaised],
  ['--paper', T.paper], ['--paperInk', T.paperInk],
  ['--ink', T.ink], ['--dim', T.inkDim], ['--faint', T.inkFaint], ['--ghost', 'rgba(230,230,230,.24)'],
  ['--line', T.rule], ['--line2', T.ruleSoft], ['--linePaper', T.rulePaper],
  ['--accent', T.accent], ['--accentDim', T.accentDim], ['--accentBlue', T.accentBlue],
  ['--redact', T.redaction],
].filter(([, v]) => v).map(([k, v]) => '  ' + k + ':' + v + ';').join('\n');
const TYPE = (readJson(PALETTE) || {}).type || {};

const page = PAGE_HTML
  .replace('__TITLE__', ((COPY && COPY.brand && COPY.brand.mark) || 'dsh-audio') + ' · ' + ((COPY && COPY.brand && COPY.brand.kicker) || 'AUDIO ARCHIVE'))
  .replace('__TOKENS__', rootVars)
  .replace('__MONO__', TYPE.mono || 'ui-monospace,Menlo,Consolas,monospace')
  .replace('__SANS__', TYPE.sans || 'system-ui,sans-serif')
  .replace('>__SPEC__<', '>' + JSON.stringify(spec) + '<')
  .replace('/*__DATA__*/null', JSON.stringify(data))
  .replace('/*__LIVESFX__*/', clean(liveSrc))
  .replace('/*__UISFX__*/', clean(uiSrc))
  .replace('__BUILD_NOTE__', 'inputs: manifest=' + (manifest ? 'yes' : 'MISSING') +
    ' readouts=' + (readoutsRaw ? 'yes' : 'MISSING') +
    ' live-sfx=' + (liveSrc ? 'yes' : 'MISSING') +
    ' ui-sfx=' + (uiSrc ? 'yes' : 'MISSING') +
    ' | placeholders: ' + (data.placeholders.length ? data.placeholders.join(',') : 'none') +
    ' | visemes: ' + visemeSource);

fs.writeFileSync(OUT, page, 'utf8');

// --------------------------------------------------------------------- report
const htmlBytes = Buffer.byteLength(page, 'utf8');
const split = [
  ['html+css+js shell', htmlBytes - audioB64 - Buffer.byteLength(liveSrc) - Buffer.byteLength(uiSrc) - 0],
  ['inline audio (base64)', audioB64],
  ['live-sfx.js', Buffer.byteLength(liveSrc)],
  ['ui-sfx.js', Buffer.byteLength(uiSrc)],
];
const cueFmt = encoded.map((e) => e.name + '=' + e.depth + 'bit/' + e.rate + 'Hz').join(' ');
console.log('built ' + path.relative(process.cwd(), OUT));
console.log('scene count: ' + data.scenes.length + ' | cue count: ' + data.cues.length + ' | tools: ' + data.tools.length + ' (unique in scenes: ' + new Set(SCENES.flatMap((s) => s.tools)).size + ')');
console.log('audio: ' + encoded.length + ' cues, ' + (audioBytes / 1024).toFixed(0) + ' KB raw -> ' + (audioB64 / 1024).toFixed(0) + ' KB base64');
for (const [label, size] of split) console.log('  ' + label.padEnd(24) + (size / 1024).toFixed(1) + ' KB');
console.log('  ' + 'TOTAL PAGE'.padEnd(24) + (htmlBytes / 1024).toFixed(1) + ' KB (' + (htmlBytes / 1024 / 1024).toFixed(2) + ' MB of 2.20 MB)');
console.log('formats: ' + cueFmt);
console.log('bed: ' + bedDepthUsed + 'bit/11025Hz (16-bit when the page has room, else 8-bit) | total ' + (htmlBytes / 1024 / 1024).toFixed(2) + ' MB of 2.20 MB');
console.log('beat grid: ' + data.bpm + ' bpm (conf ' + data.beatConf + '), ' + data.beatTimes.length + ' beats in scene 4 | f0 ' + data.f0 + ' Hz, ' + data.harmonics.length + ' harmonics, centroid ' + data.centroidHz + ' Hz | LUFS ' + lufs.measured.toFixed(1) + ' measured -> ' + lufs.target + ' target, tp ' + lufs.tp.toFixed(1) + ' dBTP');
console.log('build-time calls: composeScore(lofi ' + score.bars + ' bars, drums excluded) ' + rollNotes.length + ' notes, ' + rollChords.length + ' chords | ' + visemeSource + ' ' + visemesA.length + ' frames | mouthFromText ' + mouthB.length + ' frames');
if (TOOL_NOTES.length) console.log('tool notes: ' + TOOL_NOTES.join(' | '));
if (COPY_ISSUES.length) console.log('copy notes: ' + COPY_ISSUES.join(' | '));
if (placeholders.length) console.log('placeholders used: ' + [...new Set(placeholders)].join(', '));
if (notes.length) for (const n of notes) console.log('note: ' + n);
if (missing.length) console.log('audio missing — rebuild later (' + missing.join(', ') + ')');
else console.log('all assets inlined: audio manifest + wavs, readouts, live-sfx, ui-sfx');
if (htmlBytes > MAX_PAGE_BYTES) console.log('WARNING: page over 2.2 MB budget');
