/**
 * Video-bridge tests: real ffmpeg, real media, every number measured.
 *
 * The module under test shells out to ffmpeg/ffprobe, so nothing here is mocked:
 * the test generates its own source material (colour bars with a 440 Hz sine, a
 * hard-cut sequence, a silent video, a static video), muxes a known 880 Hz cue
 * onto it, and then *measures the result* — the head of a replace-mode mux has
 * to be digital silence, the muxed tone has to be the 880 Hz one and not the
 * 440 Hz original, a mix has to contain both, a looped 0.4 s cue has to be
 * audible in the last 100 ms of a 3 s video.
 *
 * What is checked:
 *  1. discovery: bundled ffmpeg/ffprobe found, a bogus explicit path rejected,
 *     caching, and the install-hint wording;
 *  2. probe: 3 s, video+audio present, fps/codec sane, stream counts;
 *  3. planMux: the filter graph carries adelay/afade, the estimated timeline is
 *     right, loop adds `-stream_loop -1` + `-shortest`;
 *  4. mux replace: duration preserved, one audio track, the audio is the cue
 *     (880 Hz present ~0.5 amplitude, 440 Hz gone), offset leaves 0.4 s of
 *     silence, fade-in rises and fade-out falls;
 *  5. mux mix: original kept (440 Hz) and the cue added (880 Hz), one track;
 *  6. mux loop: a 0.4 s cue over 3 s is still audible at 2.9 s;
 *  7. mux attach: two audio tracks, track 0 is the original, track 1 the cue;
 *     a video without audio degrades attach to replace and says so;
 *  8. detectCuts: three hard cuts found within 0.15 s, scores > 0.3; a static
 *     video falls back to evenly spaced anchors and labels the method;
 *  9. extract: 16-bit PCM wav at the requested rate, duration matches, levels
 *     measured with lib/audio.js `measure`;
 * 10. failures: missing file, missing binary, bad mode/container/offset, and
 *     the `audio_mux` tool reporting each of them readably;
 * 11. the `audio_mux` tool itself: all four actions through a fake ctx, and a
 *     repeated inline render converging on one deterministic wav path;
 * 12. safe writes: an `out` that is an input is refused before ffmpeg runs, a
 *     failed mux/extract leaves an existing deliverable byte-identical with no
 *     temp file left over, and a successful encode renames a same-directory temp
 *     into place (the old output is replaced, the temp disappears).
 *
 * Exit 0 when every check passes; 1 on the first real failure, with the numbers
 * printed above it. Skips with `SKIP:` + exit 0 when ffmpeg is genuinely absent.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { measure, readTrack } from '../lib/audio.js'
import { decodeWav, encodeWav } from '../lib/wav.js'
import { registerVideoTools } from '../lib/tools-video.js'
import {
  MEDIA_LIMITS,
  detectCuts,
  extractAudio,
  ffmpegInstallHint,
  findFfmpeg,
  findFfprobe,
  planMux,
  probeMedia,
  runMux,
  temporaryOutputPath
} from '../lib/video.js'

const execFileAsync = promisify(execFile)

/* ---- skip cleanly when there is no ffmpeg to test ---- */

const ffmpegPath = findFfmpeg()
const ffprobePath = findFfprobe()
if (ffmpegPath === null || ffprobePath === null) {
  console.log('SKIP: ffmpeg/ffprobe are not installed, so the video bridge cannot be tested.')
  console.log(`  ${ffmpegInstallHint(ffmpegPath === null ? 'ffmpeg' : 'ffprobe')}`)
  process.exit(0)
}

const WORK = await mkdtemp(join(tmpdir(), 'dsh-video-test-'))
const TAU = Math.PI * 2
let rawCounter = 0
let failures = 0
let passes = 0

function check (label, condition, detail = '') {
  if (condition) {
    passes += 1
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
}

const fmt = (value, digits = 3) => Number.isFinite(value) ? String(Number(Number(value).toFixed(digits))) : '?'

/** Run ffmpeg for test-media generation only (the module builds its own commands). */
async function ffmpeg (args, timeout = 120000) {
  return execFileAsync(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
}

/** Decode one audio stream to float samples, for content measurements. */
async function decodeMono (path, { map = '0:a:0', sampleRate = 48000, channels = 1 } = {}) {
  const out = join(WORK, `raw-${rawCounter += 1}.f32`)
  await ffmpeg(['-i', path, '-map', map, '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', out])
  const bytes = await readFile(out)
  // slice() copies into a fresh ArrayBuffer whose byteOffset is 0, which the
  // Float32Array view constructor requires.
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
}

/** RMS in dBFS over [from, to) seconds. */
function rmsDb (samples, from, to, sampleRate = 48000) {
  const start = Math.max(0, Math.round(from * sampleRate))
  const end = Math.min(samples.length, Math.round(to * sampleRate))
  if (end <= start) return -120
  let sum = 0
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index]
  return 20 * Math.log10(Math.max(Math.sqrt(sum / (end - start)), 1e-9))
}

/** Peak absolute sample over [from, to) seconds. */
function peakOf (samples, from, to, sampleRate = 48000) {
  const start = Math.max(0, Math.round(from * sampleRate))
  const end = Math.min(samples.length, Math.round(to * sampleRate))
  let peak = 0
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]))
  return peak
}

/**
 * Amplitude of one sine over a window measured by a direct DFT.
 * A window that holds a whole number of cycles makes the projection orthogonal,
 * so the number is the tone's amplitude (0.5 for a half-scale sine), not a
 * leakage-inflated estimate. `channel`/`channels` read an interleaved buffer.
 */
function toneAmplitude (samples, frequency, from, to, sampleRate = 48000, channel = 0, channels = 1) {
  const start = Math.round(from * sampleRate)
  const count = Math.round((to - from) * sampleRate)
  let cosine = 0
  let sine = 0
  for (let index = 0; index < count; index += 1) {
    const phase = TAU * frequency * index / sampleRate
    const value = samples[(start + index) * channels + channel]
    cosine += value * Math.cos(phase)
    sine -= value * Math.sin(phase)
  }
  return 2 * Math.hypot(cosine, sine) / count
}

/** Sine samples at a known amplitude, as the "rendered soundtrack" under test. */
function sine (seconds, frequency, amplitude, sampleRate = 44100) {
  const frames = Math.round(seconds * sampleRate)
  const out = new Float32Array(frames)
  // 5 ms fades at both ends keep the wav from clicking; they are far shorter
  // than any window measured below.
  const edge = Math.round(0.005 * sampleRate)
  for (let index = 0; index < frames; index += 1) {
    const grip = Math.min(1, index / edge, (frames - 1 - index) / edge)
    out[index] = amplitude * Math.sin(TAU * frequency * index / sampleRate) * grip
  }
  return out
}

/* ---- source media ---- */

console.log(`ffmpeg  ${ffmpegPath}`)
console.log(`ffprobe ${ffprobePath}`)
console.log(`work    ${WORK}\n`)

const baseVideo = join(WORK, 'base.mp4')
const silentVideo = join(WORK, 'silent.mp4')
const cutVideo = join(WORK, 'cuts.mp4')
const staticVideo = join(WORK, 'static.mp4')
const cueLong = join(WORK, 'cue-880-2.5s.wav')
const cueShort = join(WORK, 'cue-880-0.4s.wav')

await mkdir(WORK, { recursive: true })
await ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', baseVideo
])
await ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', silentVideo
])
await ffmpeg([
  '-f', 'lavfi', '-i', 'color=red:size=320x240:rate=25:duration=1',
  '-f', 'lavfi', '-i', 'color=blue:size=320x240:rate=25:duration=1',
  '-f', 'lavfi', '-i', 'color=green:size=320x240:rate=25:duration=1',
  '-f', 'lavfi', '-i', 'color=white:size=320x240:rate=25:duration=1',
  '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]',
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '5', cutVideo
])
await ffmpeg([
  '-f', 'lavfi', '-i', 'color=gray:size=160x120:rate=25:duration=5',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', staticVideo
])
await writeFile(cueLong, encodeWav([sine(2.5, 880, 0.5)], 44100))
await writeFile(cueShort, encodeWav([sine(0.4, 880, 0.5)], 44100))

console.log('-- generated media --')
for (const [label, path] of [['base (3 s, 440 Hz)', baseVideo], ['silent (2 s, no audio)', silentVideo], ['cuts (4 x 1 s)', cutVideo], ['static (5 s)', staticVideo], ['cue 2.5 s @880 Hz', cueLong], ['cue 0.4 s @880 Hz', cueShort]]) {
  const info = await stat(path)
  console.log(`  ${label.padEnd(24)} ${String(Math.round(info.size / 1024)).padStart(5)} KB  ${path.split(/[\\/]/).pop()}`)
}

/* ---- 1. discovery ---- */

console.log('\n-- discovery --')
check('findFfmpeg returns a path', typeof ffmpegPath === 'string' && ffmpegPath.length > 0, String(ffmpegPath))
check('findFfprobe returns a path', typeof ffprobePath === 'string' && ffprobePath.length > 0, String(ffprobePath))
check('findFfmpeg rejects a bogus explicit path', findFfmpeg({ ffmpegPath: 'C:/nope/ffmpeg.exe' }) === null)
check('findFfprobe rejects a bogus explicit path', findFfprobe({ ffprobePath: 'C:/nope/ffprobe.exe' }) === null)
check('findFfmpeg is cached per process', findFfmpeg() === findFfmpeg())
check('findFfprobe is cached per process', findFfprobe() === findFfprobe())
check('install hint names the bundled dir and a fix', /\.dsh|PATH/.test(ffmpegInstallHint()) && /install/i.test(ffmpegInstallHint()))
console.log(`  ffmpeg  ${ffmpegPath}`)
console.log(`  ffprobe ${ffprobePath}`)
console.log(`  bogus explicit path -> ffmpeg ${findFfmpeg({ ffmpegPath: 'C:/nope/ffmpeg.exe' })}, ffprobe ${findFfprobe({ ffprobePath: 'C:/nope/ffprobe.exe' })}`)

/* ---- 2. probe ---- */

console.log('\n-- probe --')
const baseProbe = await probeMedia(baseVideo)
console.log(`  duration ${fmt(baseProbe.durationSeconds)}s  video ${baseProbe.video.codec} ${baseProbe.video.width}x${baseProbe.video.height} @${fmt(baseProbe.video.fps)}fps ${baseProbe.video.frames} frames`)
console.log(`  audio ${baseProbe.audio.codec} ${baseProbe.audio.sampleRate} Hz ${baseProbe.audio.channels} ch ${baseProbe.audio.bitrate} bps  tracks ${baseProbe.videoTracks}v/${baseProbe.audioTracks}a  format ${baseProbe.format}`)
check('probe duration is 3 s', Math.abs(baseProbe.durationSeconds - 3) < 0.01, String(baseProbe.durationSeconds))
check('probe sees video and audio', baseProbe.hasVideo === true && baseProbe.hasAudio === true)
check('probe video codec', baseProbe.video.codec === 'h264', baseProbe.video.codec)
check('probe video size', baseProbe.video.width === 320 && baseProbe.video.height === 240, `${baseProbe.video.width}x${baseProbe.video.height}`)
check('probe fps', Math.abs(baseProbe.video.fps - 25) < 0.01, String(baseProbe.video.fps))
check('probe frame count', baseProbe.video.frames === 75, String(baseProbe.video.frames))
check('probe audio codec/rate', baseProbe.audio.codec === 'aac' && baseProbe.audio.sampleRate === 48000, `${baseProbe.audio.codec}/${baseProbe.audio.sampleRate}`)
check('probe stream counts', baseProbe.videoTracks === 1 && baseProbe.audioTracks === 1)
check('probe container', /mp4/.test(baseProbe.format), String(baseProbe.format))

const silentProbe = await probeMedia(silentVideo)
console.log(`  silent.mp4: ${fmt(silentProbe.durationSeconds)}s  hasVideo=${silentProbe.hasVideo} hasAudio=${silentProbe.hasAudio} audio=${silentProbe.audio}`)
check('probe reports a video-only file', silentProbe.hasVideo === true && silentProbe.hasAudio === false && silentProbe.audio === null)

const wavProbe = await probeMedia(cueShort)
console.log(`  cueShort.wav: ${fmt(wavProbe.durationSeconds)}s  video=${wavProbe.hasVideo} audio=${wavProbe.hasAudio} ${wavProbe.audio.codec} ${wavProbe.audio.sampleRate} Hz`)
check('probe works on audio-only media', wavProbe.hasVideo === false && wavProbe.hasAudio === true && Math.abs(wavProbe.durationSeconds - 0.4) < 0.01)

/* ---- 3 + 4. planMux and replace mode ---- */

console.log('\n-- planMux: replace --')
const replacePlan = planMux({
  video: baseVideo,
  audio: cueLong,
  mode: 'replace',
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  videoCodec: baseProbe.video.codec,
  audioDurationSeconds: 2.5,
  offsetSeconds: 0.5,
  fadeInSeconds: 0.3,
  fadeOutSeconds: 0.5,
  out: join(WORK, 'replace.mp4')
})
console.log(`  filter: ${replacePlan.filterGraph}`)
console.log(`  estimated: ${JSON.stringify(replacePlan.estimated)}`)
check('plan is an argv array', Array.isArray(replacePlan.args) && replacePlan.args.every((entry) => typeof entry === 'string'))
check('plan shows a runnable command', /ffmpeg/.test(replacePlan.command) && replacePlan.command.includes('<out>'))
check('plan delays the cue with adelay', replacePlan.filterGraph.includes('adelay=500:all=1'), replacePlan.filterGraph)
check('plan fades in at the offset', replacePlan.filterGraph.includes('afade=t=in:st=0.5:d=0.3'), replacePlan.filterGraph)
check('plan fades out before the end', replacePlan.filterGraph.includes('afade=t=out:st=2.5:d=0.5'), replacePlan.filterGraph)
check('plan copies the picture', replacePlan.args.join(' ').includes('-c:v copy'))
check('plan has no -stream_loop without loop', !replacePlan.args.includes('-stream_loop'))
check('estimated timeline', replacePlan.estimated.timelineSeconds === 3, String(replacePlan.estimated.timelineSeconds))
check('estimated audio span', replacePlan.estimated.audioStartSeconds === 0.5 && replacePlan.estimated.audioEndSeconds === 3, JSON.stringify(replacePlan.estimated))
// 3 s timeline, cue starts at 0.5 s and is 2.5 s long, so it exactly fills the
// room after the offset: no padding and no trimming.
check('estimated pad for a full-length cue', replacePlan.estimated.padSeconds === 0, String(replacePlan.estimated.padSeconds))
check('estimated trim for a full-length cue', replacePlan.estimated.trimSeconds === 0, String(replacePlan.estimated.trimSeconds))
const shortPlan = planMux({
  video: baseVideo,
  audio: cueShort,
  videoDurationSeconds: 3,
  videoHasAudio: true,
  audioDurationSeconds: 0.4,
  offsetSeconds: 0.5
})
console.log(`  short cue estimated: pad ${shortPlan.estimated.padSeconds}s, trim ${shortPlan.estimated.trimSeconds}s, span ${shortPlan.estimated.audioStartSeconds}..${shortPlan.estimated.audioEndSeconds}s`)
check('estimated pad for a short cue', shortPlan.estimated.padSeconds === 2.1, String(shortPlan.estimated.padSeconds))
check('estimated span for a short cue', shortPlan.estimated.audioEndSeconds === 0.9, String(shortPlan.estimated.audioEndSeconds))

const replaced = await runMux(replacePlan)
const replacedProbe = await probeMedia(replaced.outputPath)
console.log(`  wrote ${replaced.outputPath.split(/[\\/]/).pop()} ${Math.round(replaced.bytes / 1024)} KB in ${replaced.elapsedMs} ms`)
console.log(`  result: ${fmt(replaced.durationSeconds)}s  audioTracks ${replaced.media.audioTracks}  audio ${replaced.media.audio.codec} ${replaced.media.audio.sampleRate} Hz ${replaced.media.audio.channels} ch ${fmt(replaced.media.audio.durationSeconds)}s  video ${replaced.media.video.codec} @${fmt(replaced.media.video.fps)}fps`)
console.log(`  command: ${replaced.command}`)
check('replace output exists', replaced.bytes > 1000, String(replaced.bytes))
check('replace duration matches the video', Math.abs(replaced.durationSeconds - 3) < 0.1, String(replaced.durationSeconds))
check('replace audio stream duration matches', Math.abs(replacedProbe.audio.durationSeconds - 3) < 0.1, String(replacedProbe.audio.durationSeconds))
check('replace keeps one audio track', replacedProbe.audioTracks === 1, String(replacedProbe.audioTracks))
check('replace keeps the picture untouched', replacedProbe.video.codec === 'h264' && replacedProbe.video.fps === 25, `${replacedProbe.video.codec}/${replacedProbe.video.fps}`)

// Two measurement conventions, both reported so neither reads as a level bug:
//  - decodeMono() decodes with `-ac 1` to float, which uses ffmpeg's
//    power-preserving stereo->mono law (0.707*(L+R)); for a mono cue upmixed to
//    stereo that returns the cue's original amplitude (0.5 here);
//  - extractAudio() writes 16-bit PCM, whose integer path downmixes with
//    0.5*(L+R), i.e. exactly the per-channel amplitude (0.354 here).
const replaceMono = await decodeMono(replaced.outputPath)
const replaceStereo = await decodeMono(replaced.outputPath, { sampleRate: 48000, channels: 2 })
const replaceTone = toneAmplitude(replaceMono, 880, 0.85, 1.45)
const replaceLeak = toneAmplitude(replaceMono, 440, 0.85, 1.45)
const replaceLeft = toneAmplitude(replaceStereo, 880, 0.85, 1.45, 48000, 0, 2)
const replaceRight = toneAmplitude(replaceStereo, 880, 0.85, 1.45, 48000, 1, 2)
const replacePower = (replaceLeft * replaceLeft + replaceRight * replaceRight) / 2
const replaceAudio = await extractAudio(replaced.outputPath, join(WORK, 'replace-audio.wav'), { sampleRate: 48000, channels: 1 })
const replaceTrack = await readTrack(replaceAudio.outputPath)
const head = replaceTrack.samples.subarray(0, Math.round(0.4 * replaceTrack.sampleRate))
const headMetrics = measure(head, replaceTrack.sampleRate)
const extractedTone = toneAmplitude(replaceTrack.samples, 880, 0.85, 1.45, replaceTrack.sampleRate)
const fadeInEarly = rmsDb(replaceTrack.samples, 0.52, 0.62, replaceTrack.sampleRate)
const fadeInLate = rmsDb(replaceTrack.samples, 0.85, 0.95, replaceTrack.sampleRate)
const fadeOutEarly = rmsDb(replaceTrack.samples, 2.35, 2.45, replaceTrack.sampleRate)
const fadeOutLate = rmsDb(replaceTrack.samples, 2.9, 2.99, replaceTrack.sampleRate)
console.log(`  muxed stereo 880 Hz: L ${replaceLeft.toFixed(4)} R ${replaceRight.toFixed(4)} (source mono cue 0.5, power ${replacePower.toFixed(4)} vs 0.125)`)
console.log(`  extracted ${fmt(replaceAudio.durationSeconds)}s @${replaceAudio.sampleRate} Hz mono, ${replaceAudio.bytes} B; 880 Hz amplitude ${replaceTone.toFixed(4)}; 440 Hz leakage ${replaceLeak.toFixed(5)}`)
console.log(`  head 0..0.4s: peak ${headMetrics.peakDbfs} dBFS rms ${headMetrics.rmsDbfs} dBFS; extracted-wav 880 Hz amplitude ${extractedTone.toFixed(4)}`)
console.log(`  fade-in 0.52..0.62s vs 0.85..0.95s: ${fadeInEarly.toFixed(1)} vs ${fadeInLate.toFixed(1)} dBFS`)
console.log(`  fade-out 2.35..2.45s vs 2.90..2.99s: ${fadeOutEarly.toFixed(1)} vs ${fadeOutLate.toFixed(1)} dBFS`)
check('replace extracted duration matches', Math.abs(replaceAudio.durationSeconds - 3) < 0.05, String(replaceAudio.durationSeconds))
check('replace leaves the offset silent', headMetrics.peakDbfs < -60, `${headMetrics.peakDbfs} dBFS`)
check('replace muxes the rendered cue', Math.abs(replaceTone - 0.5) < 0.05, replaceTone.toFixed(4))
check('replace keeps the cue power', Math.abs(replacePower - 0.125) < 0.02, replacePower.toFixed(4))
check('replace upmixes mono to both channels', Math.abs(replaceLeft - replaceRight) < 0.01, `${replaceLeft}/${replaceRight}`)
check('replace removes the original audio', replaceLeak < replaceTone * 0.05, `${replaceLeak} vs ${replaceTone}`)
check('extracted wav carries the per-channel level', Math.abs(extractedTone - replaceLeft) < 0.02, `${extractedTone} vs ${replaceLeft}`)
check('fade-in rises', fadeInLate > fadeInEarly + 6, `${fadeInLate} vs ${fadeInEarly}`)
check('fade-out falls', fadeOutEarly > fadeOutLate + 10, `${fadeOutEarly} vs ${fadeOutLate}`)

/* ---- 5. mix mode ---- */

console.log('\n-- mux: mix --')
const mixPlan = planMux({
  video: baseVideo,
  audio: cueShort,
  mode: 'mix',
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  audioDurationSeconds: 0.4,
  out: join(WORK, 'mix.mp4')
})
const mixed = await runMux(mixPlan)
const mixedProbe = await probeMedia(mixed.outputPath)
const mixedAudio = await extractAudio(mixed.outputPath, join(WORK, 'mix-audio.wav'), { sampleRate: 48000 })
const mixedMono = await decodeMono(mixed.outputPath)
const mixedOriginal = toneAmplitude(mixedMono, 440, 1, 1.6)
const mixedCue = toneAmplitude(mixedMono, 880, 0, 0.4)
const mixedTail = rmsDb(mixedMono, 2, 2.9)
console.log(`  filter: ${mixPlan.filterGraph}`)
console.log(`  result: ${fmt(mixed.durationSeconds)}s  audioTracks ${mixedProbe.audioTracks}  mix peak ${mixed.audioPeakDbfs === null ? '?' : mixed.audioPeakDbfs.toFixed(1)} dBFS  warnings ${JSON.stringify(mixed.warnings)}`)
console.log(`  440 Hz (original) amplitude in 1..1.6s: ${mixedOriginal.toFixed(4)}; 880 Hz (cue) in 0..0.4s: ${mixedCue.toFixed(4)}; rms 2..2.9s ${mixedTail.toFixed(1)} dBFS; extracted wav ${fmt(mixedAudio.durationSeconds)}s`)
check('mix uses amix', mixPlan.filterGraph.includes('amix=inputs=2') && mixPlan.filterGraph.includes('normalize=0'), mixPlan.filterGraph)
check('mix output duration preserved', Math.abs(mixed.durationSeconds - 3) < 0.1, String(mixed.durationSeconds))
check('mix keeps exactly one audio track', mixedProbe.audioTracks === 1, String(mixedProbe.audioTracks))
check('mix keeps the original audio', mixedOriginal > 0.1, mixedOriginal.toFixed(4))
check('mix adds the new cue', mixedCue > 0.4, mixedCue.toFixed(4))
check('mix leaves the original playing after the cue', mixedTail > -40, `${mixedTail} dBFS`)
check('mix reports a measured peak', mixed.audioPeakDbfs !== null && mixed.audioPeakDbfs < 0, String(mixed.audioPeakDbfs))

/* ---- 6. loop mode ---- */

console.log('\n-- mux: loop --')
const loopPlan = planMux({
  video: baseVideo,
  audio: cueShort,
  mode: 'replace',
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  audioDurationSeconds: 0.4,
  loop: true,
  out: join(WORK, 'loop.mp4')
})
check('loop plan uses -stream_loop -1', loopPlan.args.includes('-stream_loop') && loopPlan.args[loopPlan.args.indexOf('-stream_loop') + 1] === '-1', loopPlan.args.join(' '))
check('loop plan uses -shortest', loopPlan.args.includes('-shortest'), loopPlan.args.join(' '))
check('loop plan estimates repeats', loopPlan.estimated.repeats !== null && loopPlan.estimated.repeats >= 7, String(loopPlan.estimated.repeats))
const looped = await runMux(loopPlan)
const loopedProbe = await probeMedia(looped.outputPath)
const loopedMono = await decodeMono(looped.outputPath)
const loopEndTone = toneAmplitude(loopedMono, 880, 2.4, 3.0)
const loopStartTone = toneAmplitude(loopedMono, 880, 0, 0.4)
const loopMidRms = rmsDb(loopedMono, 1.4, 1.6)
console.log(`  repeats ${loopPlan.estimated.repeats}; result ${fmt(looped.durationSeconds)}s audio stream ${fmt(loopedProbe.audio.durationSeconds)}s`)
console.log(`  880 Hz amplitude 0..0.4s ${loopStartTone.toFixed(4)}, 2.4..3.0s ${loopEndTone.toFixed(4)}; rms 1.4..1.6s ${loopMidRms.toFixed(1)} dBFS`)
check('loop output is at least the video length', looped.durationSeconds >= 3 - 0.1, String(looped.durationSeconds))
check('loop audio stream is the full timeline', Math.abs(loopedProbe.audio.durationSeconds - 3) < 0.1, String(loopedProbe.audio.durationSeconds))
check('loop cue still sounds at the end', loopEndTone > 0.4, loopEndTone.toFixed(4))
check('loop cue starts at 0 without a gap', loopStartTone > 0.4, loopStartTone.toFixed(4))
check('loop cue sounds in the middle too', loopMidRms > -20, `${loopMidRms} dBFS`)

/* ---- 7. attach mode ---- */

console.log('\n-- mux: attach --')
const attachPlan = planMux({
  video: baseVideo,
  audio: cueShort,
  mode: 'attach',
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  audioDurationSeconds: 0.4,
  out: join(WORK, 'attach.mp4')
})
const attached = await runMux(attachPlan)
const attachedProbe = await probeMedia(attached.outputPath)
const track0 = await decodeMono(attached.outputPath, { map: '0:a:0' })
const track1 = await decodeMono(attached.outputPath, { map: '0:a:1' })
const attachedOriginal = toneAmplitude(track0, 440, 1, 1.6)
const attachedOriginalCue = toneAmplitude(track0, 880, 0, 0.4)
const attachedCue = toneAmplitude(track1, 880, 0, 0.4)
const attachedCueOriginal = toneAmplitude(track1, 440, 1, 1.6)
console.log(`  result: ${fmt(attached.durationSeconds)}s  audioTracks ${attachedProbe.audioTracks}  first stream ${fmt(attached.media.audio.durationSeconds)}s  picture ${attached.media.video.codec}`)
console.log(`  track 0: 440 Hz ${attachedOriginal.toFixed(4)}, 880 Hz ${attachedOriginalCue.toFixed(4)}`)
console.log(`  track 1: 880 Hz ${attachedCue.toFixed(4)}, 440 Hz ${attachedCueOriginal.toFixed(4)}`)
check('attach writes two audio tracks', attachedProbe.audioTracks === 2, String(attachedProbe.audioTracks))
check('attach keeps the original track untouched', attachedOriginal > 0.1 && attachedOriginalCue < 0.05, `${attachedOriginal}/${attachedOriginalCue}`)
check('attach adds the cue as the second track', attachedCue > 0.4 && attachedCueOriginal < 0.05, `${attachedCue}/${attachedCueOriginal}`)
check('attach keeps the video', attachedProbe.hasVideo === true && attachedProbe.video.codec === 'h264')

const degradePlan = planMux({
  video: silentVideo,
  audio: cueShort,
  mode: 'attach',
  videoDurationSeconds: silentProbe.durationSeconds,
  videoHasAudio: false,
  audioDurationSeconds: 0.4,
  out: join(WORK, 'attach-degraded.mp4')
})
console.log(`  attach onto a silent video degrades to "${degradePlan.estimated.mode}" — notes ${JSON.stringify(degradePlan.estimated.notes)}`)
check('attach degrades to replace without original audio', degradePlan.estimated.mode === 'replace' && degradePlan.estimated.notes.length > 0)
const degraded = await runMux(degradePlan)
check('degraded mux still writes one track', degraded.media.audioTracks === 1, String(degraded.media.audioTracks))

/* ---- 8. cuts ---- */

console.log('\n-- detectCuts --')
const cuts = await detectCuts(cutVideo)
console.log(`  cuts.mp4 (4 x 1 s): ${JSON.stringify(cuts.cuts)}`)
console.log(`  method ${cuts.method}, detected ${cuts.detected}, threshold ${cuts.threshold}, duration ${fmt(cuts.durationSeconds)}s`)
console.log(`  command: ${cuts.command}`)
check('detectCuts finds three cuts', cuts.count === 3, String(cuts.count))
check('detectCuts labels scene detection', cuts.method === 'scene', cuts.method)
check('detectCuts times are 1/2/3 s', cuts.cuts.map((cut) => cut.at).every((at, index) => Math.abs(at - (index + 1)) < 0.15), JSON.stringify(cuts.cuts.map((cut) => cut.at)))
check('detectCuts scores clear the threshold', cuts.cuts.every((cut) => cut.score >= cuts.threshold), JSON.stringify(cuts.cuts.map((cut) => cut.score)))
check('detectCuts reads the duration', Math.abs(cuts.durationSeconds - 4) < 0.01, String(cuts.durationSeconds))

const staticCuts = await detectCuts(staticVideo)
console.log(`  static.mp4 (5 s, no change): method ${staticCuts.method}, ${JSON.stringify(staticCuts.cuts)}`)
check('static video falls back to even anchors', staticCuts.method === 'even' && staticCuts.count > 0, staticCuts.method)
check('even anchors are labelled with score 0', staticCuts.cuts.every((cut) => cut.score === 0))
check('even anchors sit inside the video', staticCuts.cuts.every((cut) => cut.at > 0 && cut.at < staticCuts.durationSeconds))

/* ---- 9. extract ---- */

console.log('\n-- extractAudio --')
const extracted = await extractAudio(baseVideo, join(WORK, 'extract-44100.wav'), { sampleRate: 44100, channels: 1 })
const extractedBytes = await readFile(extracted.outputPath)
const extractedWav = decodeWav(extractedBytes)
const extractedTrack = await readTrack(extracted.outputPath)
const extractedMetrics = measure(extractedTrack.samples, extractedTrack.sampleRate)
console.log(`  wrote ${extracted.outputPath.split(/[\\/]/).pop()} ${extracted.bytes} B: ${fmt(extracted.durationSeconds)}s, ${extractedWav.sampleRate} Hz, ${extractedWav.channels.length} ch, ${extractedWav.bitDepth}-bit`)
console.log(`  levels: peak ${extractedMetrics.peakDbfs} dBFS, rms ${extractedMetrics.rmsDbfs} dBFS, onsets ${extractedMetrics.onsets}`)
check('extract writes a decodable wav', extractedWav.channels.length === 1 && extractedWav.bitDepth === 16)
check('extract honours the requested rate', extractedWav.sampleRate === 44100, String(extractedWav.sampleRate))
check('extract duration matches the video', Math.abs(extracted.durationSeconds - 3) < 0.05, String(extracted.durationSeconds))
check('extract wav has audio in it', extractedMetrics.rmsDbfs > -40, `${extractedMetrics.rmsDbfs} dBFS`)

/* ---- 10. failures ---- */

console.log('\n-- failures --')
async function expectThrows (label, run, pattern) {
  try {
    await run()
    check(label, false, 'did not throw')
  } catch (error) {
    const message = String(error?.message ?? error)
    const ok = pattern.test(message)
    check(label, ok, message.slice(0, 220))
    console.log(`  ${label}: ${message.split('\n')[0].slice(0, 200)}`)
  }
}

await expectThrows('missing file names the path', () => probeMedia(join(WORK, 'nope.mp4')), /not found/i)
await expectThrows('missing ffprobe explains the install', () => probeMedia(baseVideo, { ffprobePath: 'C:/nope/ffprobe.exe' }), /not found/i)
await expectThrows('missing ffmpeg explains the install', () => runMux(replacePlan, { ffmpegPath: 'C:/nope/ffmpeg.exe' }), /not found/i)
await expectThrows('bad mode is named', () => planMux({ video: baseVideo, audio: cueShort, mode: 'duck', videoDurationSeconds: 3 }), /mode must be one of/i)
await expectThrows('offset outside the timeline is rejected', () => planMux({ video: baseVideo, audio: cueShort, videoDurationSeconds: 3, offsetSeconds: 5 }), /never be heard/i)
await expectThrows('unsupported container is rejected', () => planMux({ video: baseVideo, audio: cueShort, videoDurationSeconds: 3, out: join(WORK, 'out.avi') }), /unsupported output container/i)
await expectThrows('h264 into webm is rejected', () => planMux({ video: baseVideo, audio: cueShort, videoDurationSeconds: 3, videoCodec: 'h264', out: join(WORK, 'out.webm') }), /cannot be stream-copied into WebM/i)
await expectThrows('missing plan output is rejected', () => runMux({ args: ['-f', 'null', '-'] }), /no output path/i)
await expectThrows('mismatched output container is rejected', () => runMux(replacePlan, { out: join(WORK, 'wrong-container.webm') }), /plan was built for/i)
await expectThrows('extract from a silent video is explained', () => extractAudio(silentVideo, join(WORK, 'silent.wav')), /no audio track/i)
await expectThrows('cuts on a missing file explains itself', () => detectCuts(join(WORK, 'nope.mp4')), /not found|No such file/i)
check('limits are documented as numbers', MEDIA_LIMITS.maxTimelineSeconds === 3600 && MEDIA_LIMITS.defaultTimeoutMs === 120000)

/* ---- 11. the audio_mux tool ---- */

console.log('\n-- audio_mux tool --')
const registered = new Map()
const toolCwd = join(WORK, 'session')
await mkdir(toolCwd, { recursive: true })
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: (name) => (name === 'workingDirectory' ? { get: () => toolCwd } : undefined)
}
const exec = { agent: { session: { id: 'video-test' } } }
registerVideoTools(ctx)
const tool = registered.get('audio_mux')
check('audio_mux registered', tool !== undefined)
check('audio_mux is concurrency safe', tool !== undefined && tool.isConcurrencySafe === true)
check('audio_mux requires an action', tool !== undefined && JSON.stringify(tool.parameters.required) === JSON.stringify(['action']))
check('audio_mux schema is closed', tool !== undefined && tool.parameters.additionalProperties === false)
check('audio_mux renders text', tool !== undefined && Array.isArray(tool.output.render({}, { text: 'hi' })) && tool.output.render({}, { text: 'hi' })[0].text === 'hi')
const call = (args) => tool.execute(args, exec)

const toolProbe = await call({ action: 'probe', path: baseVideo })
console.log(`  probe: ${toolProbe.text}`)
check('tool probe reports the streams', toolProbe.hasVideo === true && toolProbe.hasAudio === true && Math.abs(toolProbe.durationSeconds - 3) < 0.01)

const toolMux = await call({ action: 'mux', video: baseVideo, audio: { preset: 'tick', duration: 0.5, seed: 4 }, out: 'assets/video/tool-mux.mp4', offsetSeconds: 0.25 })
console.log(`  mux: ${toolMux.text}`)
check('tool mux writes the video', toolMux.bytes > 1000 && toolMux.audioTracks === 1, JSON.stringify({ bytes: toolMux.bytes, tracks: toolMux.audioTracks }))
check('tool mux reports its output path', await stat(toolMux.path).then(() => true).catch(() => false))

const toolMuxAgain = await call({ action: 'mux', video: baseVideo, audio: { preset: 'tick', duration: 0.5, seed: 4 }, out: 'assets/video/tool-mux-2.mp4', offsetSeconds: 0.25 })
check('identical inline render converges on one wav path', toolMux.relativeAudioPath === toolMuxAgain.relativeAudioPath, `${toolMux.relativeAudioPath} vs ${toolMuxAgain.relativeAudioPath}`)
check('curated cue names the generated wav', /mux-audio-tick-/.test(toolMux.relativeAudioPath), toolMux.relativeAudioPath)

const toolMix = await call({ action: 'mux', video: baseVideo, audio: { preset: 'texture', duration: 1, params: { kind: 'rain' } }, mode: 'mix', loop: true, mixGainDb: -6, out: 'assets/video/tool-mix.mp4' })
console.log(`  mix: ${toolMix.text}`)
check('tool mix keeps one track and reports a peak', toolMix.audioTracks === 1 && toolMix.audioPeakDbfs !== null, JSON.stringify({ tracks: toolMix.audioTracks, peak: toolMix.audioPeakDbfs }))
check('tool mix reports the mode used', toolMix.mode === 'mix', toolMix.mode)

const toolCuts = await call({ action: 'cuts', path: cutVideo })
console.log(`  cuts: ${toolCuts.text}`)
check('tool cuts returns a cue plan', Array.isArray(toolCuts.cuePlan?.cues) && toolCuts.cuePlan.cues.length === 3, JSON.stringify(toolCuts.cuePlan))
check('tool cue plan is audio_bind shaped', toolCuts.cuePlan.cues.every((cue) => typeof cue.name === 'string' && Number.isFinite(cue.at)))
check('tool cue times match the cuts', toolCuts.cuePlan.cues.every((cue, index) => cue.at === toolCuts.cuts[index].at))

const toolExtract = await call({ action: 'extract', path: baseVideo, sampleRate: 48000, out: 'assets/audio/tool-extract.wav' })
console.log(`  extract: ${toolExtract.text}`)
check('tool extract measures the wav', toolExtract.durationSeconds > 2.9 && toolExtract.metrics.rmsDbfs > -40, `${toolExtract.durationSeconds}s rms ${toolExtract.metrics.rmsDbfs}`)

await expectThrows('tool rejects a bad action', () => call({ action: 'render' }), /action must be one of/i)
await expectThrows('tool explains a missing file', () => call({ action: 'probe', path: 'nope.mp4' }), /not found/i)
await expectThrows('tool explains a missing ffmpeg', () => call({ action: 'mux', video: baseVideo, audio: cueShort, ffmpegPath: 'C:/nope/ffmpeg.exe' }), /not found/i)
await expectThrows('tool rejects a bad mode', () => call({ action: 'mux', video: baseVideo, audio: cueShort, mode: 'duck' }), /mode must be one of/i)
await expectThrows('tool refuses a video without audio to extract', () => call({ action: 'extract', path: silentVideo }), /no audio track/i)
await expectThrows('tool explains a probe on an audio-only file for mux', () => call({ action: 'mux', video: cueShort, audio: cueShort }), /no video stream/i)

/* ---- 12. safe writes ---- */

console.log('\n-- safe writes --')

// The temp file must be beside its target (rename is only atomic inside one
// directory/volume) and identifiable as this process's (pid) and this call's
// (random suffix). Both properties are checked on the exported path helper.
const tempBeside = temporaryOutputPath(join(WORK, 'rename-target.mp4'))
check('temp path sits in the target directory', dirname(tempBeside) === WORK, tempBeside)
check('temp path carries the pid', basename(tempBeside).includes(`.${process.pid}-`), basename(tempBeside))
check('temp path is dot-prefixed, tagged and ends .tmp', /^\.[^\\/]+\.\d+-[0-9a-f]{16}\.tmp$/.test(basename(tempBeside)), basename(tempBeside))
check('two calls make two temp paths', temporaryOutputPath(join(WORK, 'rename-target.mp4')) !== tempBeside)

/** Temp files left behind for one target, if any (they live in its directory). */
async function tempLeftovers (target) {
  const prefix = `.${basename(target)}.`
  return (await readdir(WORK)).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}

const inputBefore = await readFile(baseVideo)
const inputPlan = planMux({
  video: baseVideo,
  audio: cueShort,
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  out: baseVideo
})
// A bogus ffmpegPath proves the refusal runs before ffmpeg is even located: had
// the guard run after discovery, the error would be "was not found".
await expectThrows(
  'mux refuses an out that is its input video',
  () => runMux(inputPlan, { ffmpegPath: 'C:/nope/ffmpeg.exe' }),
  /must differ from the input video/i
)
check('the input video survives a refused in-place mux', (await readFile(baseVideo)).equals(inputBefore))
await expectThrows(
  'mux sees through a dotted path to the same input',
  () => runMux(replacePlan, { out: join(WORK, 'nested', '..', 'base.mp4') }),
  /must differ from the input video/i
)
await expectThrows(
  'mux refuses an out that is its input audio',
  () => runMux(shortPlan, { out: cueShort }),
  /must differ from the input audio/i
)
await expectThrows(
  'extract refuses an outPath that is its source',
  () => extractAudio(baseVideo, baseVideo, { ffmpegPath: 'C:/nope/ffmpeg.exe' }),
  /must differ from the input source/i
)
check('the source survives a refused in-place extract', (await readFile(baseVideo)).equals(inputBefore))

// The same guard through the model-facing tool, i.e. the call shape that used to
// lose a file: `audio_mux({ action: 'mux', video: 'clip.mp4', out: 'clip.mp4' })`.
await expectThrows(
  'tool refuses an out that is its input video',
  () => call({ action: 'mux', video: baseVideo, audio: cueShort, out: baseVideo }),
  /must differ from the input video/i
)
await expectThrows(
  'tool refuses an extract outPath that is its source',
  () => call({ action: 'extract', path: baseVideo, out: baseVideo }),
  /must differ from the input source/i
)
check('the input video still survives the tool calls', (await readFile(baseVideo)).equals(inputBefore))

// A real ffmpeg failure with a pre-existing deliverable at `out`: the old file
// has to be byte-identical afterwards and no temp file may be left behind. The
// audio input is deliberately not media, so ffmpeg fails before writing anything.
const guardedOut = join(WORK, 'guarded.mp4')
await writeFile(guardedOut, Buffer.from('this is the previous deliverable, not media'))
const guardedBefore = await readFile(guardedOut)
const corruptAudio = join(WORK, 'corrupt.wav')
await writeFile(corruptAudio, Buffer.from('not a wav at all'))
const corruptPlan = planMux({
  video: baseVideo,
  audio: corruptAudio,
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  out: guardedOut
})
await expectThrows('a mux that ffmpeg cannot decode fails', () => runMux(corruptPlan), /runMux failed/i)
check('a failed mux leaves the old output byte-identical', (await readFile(guardedOut)).equals(guardedBefore))
check('a failed mux leaves no temp file', (await tempLeftovers(guardedOut)).length === 0, JSON.stringify(await tempLeftovers(guardedOut)))

// The same failure shape for extract: old wav untouched, no temp left.
const guardedWav = join(WORK, 'guarded.wav')
await writeFile(guardedWav, Buffer.from('keep this wav'))
const guardedWavBefore = await readFile(guardedWav)
const corruptVideo = join(WORK, 'corrupt.mp4')
await writeFile(corruptVideo, Buffer.from('not media either'))
await expectThrows('an extract ffmpeg cannot decode fails', () => extractAudio(corruptVideo, guardedWav), /extractAudio .* failed/i)
check('a failed extract leaves the old wav byte-identical', (await readFile(guardedWav)).equals(guardedWavBefore))
check('a failed extract leaves no temp file', (await tempLeftovers(guardedWav)).length === 0, JSON.stringify(await tempLeftovers(guardedWav)))

// Success path: the temp is renamed onto an existing target, which rename is
// allowed to replace; afterwards the target is the new media and no temp remains.
const overwriteOut = join(WORK, 'overwrite.mp4')
await writeFile(overwriteOut, Buffer.from('stale deliverable'))
const overwritePlan = planMux({
  video: baseVideo,
  audio: cueShort,
  videoDurationSeconds: baseProbe.durationSeconds,
  videoHasAudio: true,
  audioDurationSeconds: 0.4,
  out: overwriteOut
})
const overwritten = await runMux(overwritePlan)
const overwrittenProbe = await probeMedia(overwriteOut)
console.log(`  overwrite: ${overwritten.bytes} B, ${fmt(overwrittenProbe.durationSeconds)}s, audioTracks ${overwrittenProbe.audioTracks}, temp leftovers ${JSON.stringify(await tempLeftovers(overwriteOut))}`)
check('a successful mux replaces the old output', overwritten.bytes > 1000 && Math.abs(overwrittenProbe.durationSeconds - 3) < 0.1, `${overwritten.bytes} B / ${overwrittenProbe.durationSeconds}s`)
check('a successful mux reports the target path', overwritten.outputPath === overwriteOut, overwritten.outputPath)
check('a successful mux leaves no temp file', (await tempLeftovers(overwriteOut)).length === 0, JSON.stringify(await tempLeftovers(overwriteOut)))

const overwriteWav = join(WORK, 'overwrite.wav')
await writeFile(overwriteWav, Buffer.from('stale wav'))
const reExtracted = await extractAudio(baseVideo, overwriteWav, { sampleRate: 48000 })
const reExtractedWav = decodeWav(await readFile(overwriteWav))
console.log(`  extract overwrite: ${reExtracted.bytes} B, ${reExtractedWav.sampleRate} Hz, temp leftovers ${JSON.stringify(await tempLeftovers(overwriteWav))}`)
check('a successful extract replaces the old wav', reExtracted.bytes > 1000 && reExtractedWav.sampleRate === 48000, `${reExtracted.bytes} B / ${reExtractedWav.sampleRate} Hz`)
check('a successful extract leaves no temp file', (await tempLeftovers(overwriteWav)).length === 0, JSON.stringify(await tempLeftovers(overwriteWav)))

/* ---- result ---- */

if (failures === 0) {
  await rm(WORK, { recursive: true, force: true }).catch(() => {})
  console.log(`\nOK: video bridge behaves (ffmpeg mux/probe/cuts/extract measured on generated media; ${passes} checks passed)`)
} else {
  console.log(`\nwork directory kept for inspection: ${WORK}`)
  console.log(`FAILED: ${failures} check(s)`)
}
process.exit(failures === 0 ? 0 : 1)
