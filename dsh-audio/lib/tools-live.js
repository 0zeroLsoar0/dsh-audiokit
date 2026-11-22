/**
 * The in-page tier's one tool: `audio_live`.
 *
 * It is the counterpart of `audio_synth` for pages that cannot ship audio bytes
 * or must react to input: it writes a generator script instead of a wav, plus an
 * optional click-to-play demo page. The result is a bounded summary (paths,
 * sizes, the preset list) rather than the script text, because the model reasons
 * about file paths and sizes far better than about a page of JavaScript.
 */

import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { hashSpec, resolvePath, writeFileAtomic } from './audio.js'
import { LIVE_PRESETS, LIVE_PRESET_NAMES, buildLiveDemoHtml, buildLiveScript } from './live.js'

const PRESET_NAMES = LIVE_PRESET_NAMES.slice()

function displayPath (cwd, path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.split('\\').join('/') : path
}

function sessionCwd (ctx, exec) {
  try {
    const session = exec?.agent?.session
    if (session !== undefined) {
      // `ctx.workingDirectory` throws unless it is a declared injection, so the
      // optional service is resolved by name instead.
      const workingDirectory = ctx.get('workingDirectory')
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch { /* fall through */ }
  return process.cwd()
}

function fmt (value, digits = 1) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '')
}

function clampNumber (value, min, max) {
  return value < min ? min : value > max ? max : value
}

function sizeText (bytes) {
  return bytes > 1024 * 1024 ? `${fmt(bytes / 1024 / 1024, 2)} MB` : `${fmt(bytes / 1024, 2)} KB`
}

/**
 * Read an optional numeric argument, rejecting only values that have no meaning.
 * Mirrors `readNumber` in lib/tools.js: `undefined`/`null` mean "use the
 * default", a numeric string is accepted because the host may send one, and a
 * literal NaN is a caller error worth reporting.
 */
function readNumber (tool, key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${tool}: ${key} must be a number`)
  }
  const number = Number(value)
  if (Number.isNaN(number)) throw new Error(`${tool}: ${key} must be a number`)
  return number
}

/**
 * Validate and canonicalise the requested preset list. Unknown ids are a hard
 * error here (unlike `buildLiveScript`, which drops them): a model that typed
 * "wind" instead of "whoosh" should be told, not handed a silent subset.
 */
function resolvePresets (tool, requested) {
  if (requested === undefined || requested === null) return PRESET_NAMES.slice()
  if (!Array.isArray(requested)) throw new Error(`${tool}: presets must be an array of preset ids`)
  const names = []
  const unknown = []
  for (const entry of requested) {
    const name = String(entry)
    if (LIVE_PRESETS[name] === undefined) unknown.push(name)
    else if (!names.includes(name)) names.push(name)
  }
  if (unknown.length > 0) {
    throw new Error(`${tool}: unknown live preset${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; available: ${PRESET_NAMES.join(', ')}`)
  }
  if (names.length === 0) throw new Error(`${tool}: presets must name at least one preset (available: ${PRESET_NAMES.join(', ')})`)
  return names
}

/**
 * Resolve the file to write. A bare stem ("assets/live/sfx") gets `.js`
 * appended; an explicit name is kept, because the caller may be feeding another
 * tool that expects it.
 */
function outputTarget (cwd, requested, hash) {
  const resolved = resolvePath(cwd, requested)
  if (resolved === undefined) return join(cwd, 'assets', 'audio', `live-${hash}.js`)
  const base = resolved.split(/[\\/]/).pop() ?? ''
  return base.includes('.') ? resolved : `${resolved}.js`
}

/** Register the `audio_live` tool on `ctx.tools`. */
export function registerLiveTools (ctx) {
  ctx.tools.register({
    name: 'audio_live',
    description: 'Generate an in-page WebAudio synth script (no audio bytes) that reproduces the nine core preset families live, so a page can change a sound\'s pitch and character in response to input and re-randomise per play instead of shipping wav files. Writes <out>.js and, with demo:true, a tiny <out>.html that plays every preset with one button. Use it instead of audio_synth when the page must react to the user, run offline as a single file, or stay byte-free; use audio_synth when the sound is fixed and must be measured or mixed.',
    parameters: {
      type: 'object',
      properties: {
        presets: { type: 'array', items: { type: 'string', enum: PRESET_NAMES }, description: 'Preset families to bake into the script; defaults to all nine. Each adds ~0.5-1.6 KB of code; a page needs only the ones it plays.' },
        seed: { type: 'integer', description: 'Seeds the page-side random generator (ring gains, grain placement, tick jitter). Same seed reproduces the same script bytes and the same per-play variation sequence.' },
        maxVoices: { type: 'integer', description: 'Simultaneous voice limit, 1..64, default 12. The oldest voice is stolen with a short fade, and each new voice is scaled by 1/sqrt(1+active) so rapid retriggering does not clip.' },
        volumeDb: { type: 'number', description: 'Initial master volume in dB, -60..12, default 0. The page can change it later with dshLive.setVolume(db).' },
        out: { type: 'string', description: 'Output path for the .js, relative to the working directory. Defaults to assets/audio/live-<hash>.js; a bare stem gets .js appended.' },
        demo: { type: 'boolean', description: 'Also write a tiny demo HTML next to the script with one button per preset, a stop-all and a volume slider. Defaults to false.' }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    presentCall: (args) => ({ card: 'generic', title: `Live synth ${Array.isArray(args.presets) ? args.presets.length : 'all'} preset(s)`, kind: 'other', rawInput: args }),
    async execute (args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const requested = resolvePresets('audio_live', args.presets)
      const seed = readNumber('audio_live', 'seed', args.seed)
      const sampleRate = 44100
      const maxVoices = readNumber('audio_live', 'maxVoices', args.maxVoices)
      const volumeDb = readNumber('audio_live', 'volumeDb', args.volumeDb)
      // Clamp here as well as in the builder so the summary reports the values
      // that were actually baked into the script, not the ones asked for.
      const options = {
        presets: requested,
        seed: Number.isFinite(seed) ? clampNumber(Math.round(seed), 0, 2147483647) : 1,
        sampleRate,
        maxVoices: Number.isFinite(maxVoices) ? clampNumber(Math.round(maxVoices), 1, 64) : 12,
        volumeDb: Number.isFinite(volumeDb) ? clampNumber(volumeDb, -60, 12) : 0
      }
      const built = buildLiveScript(options)
      // The script always plays its presets in canonical order, so report and
      // hash that order: two requests that produce the same bytes get one file.
      const presets = built.exports
      const hash = hashSpec({ kind: 'live', presets, seed: options.seed, sampleRate, maxVoices: options.maxVoices, volumeDb: options.volumeDb })
      const target = outputTarget(cwd, args.out, hash)
      await writeFileAtomic(target, Buffer.from(built.script, 'utf8'))
      const info = await stat(target)

      // Contribution per preset: the byte growth when the preset joins the set,
      // measured cumulatively from the same builder in the script's canonical
      // order, so the numbers add up to the total and cannot drift from reality.
      const presetBytes = {}
      let running = buildLiveScript({ ...options, presets: [] }).bytes
      const canonical = built.exports
      for (let i = 0; i < canonical.length; i += 1) {
        const next = buildLiveScript({ ...options, presets: canonical.slice(0, i + 1) }).bytes
        presetBytes[canonical[i]] = next - running
        running = next
      }

      let demoPath = null
      let demoBytes = 0
      if (args.demo === true) {
        // A caller that names the file .html explicitly must not have the demo
        // land on top of the script, so only a .js target is renamed.
        const htmlPath = /\.js$/i.test(target) ? target.replace(/\.js$/i, '.html') : `${target}.html`
        const scriptName = target.split(/[\\/]/).pop() ?? 'live.js'
        const html = buildLiveDemoHtml({ presets, scriptName, title: `dsh-live - ${presets.length} preset${presets.length === 1 ? '' : 's'}`, volumeDb: options.volumeDb })
        await writeFileAtomic(htmlPath, Buffer.from(html, 'utf8'))
        demoPath = htmlPath
        demoBytes = (await stat(htmlPath)).size
      }

      const where = `${displayPath(cwd, target)} (${sizeText(info.size)}, ${presets.length} preset${presets.length === 1 ? '' : 's'}: ${presets.join(', ')}; maxVoices ${options.maxVoices}, seed ${options.seed})`
      const perPreset = presets.map((name) => `${name} ${presetBytes[name]} B`).join(' · ')
      const demo = demoPath === null ? 'no demo (pass demo:true for a click-to-play page)' : `demo ${displayPath(cwd, demoPath)} (${sizeText(demoBytes)})`
      const text = [
        `Wrote in-page synth ${where} · no audio bytes · ${demo}`,
        `per-preset code: ${perPreset}`
      ].join(' · ')

      return {
        path: target,
        relativePath: displayPath(cwd, target),
        bytes: info.size,
        scriptBytes: built.bytes,
        presetCount: presets.length,
        presets,
        presetBytes,
        seed: options.seed,
        maxVoices: options.maxVoices,
        volumeDb: options.volumeDb,
        demoPath,
        demoRelativePath: demoPath === null ? null : displayPath(cwd, demoPath),
        demoBytes,
        text
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    }
  })
}
