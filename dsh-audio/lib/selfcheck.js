/**
 * `audio_check`'s local acoustic self-check: does this render look like the kind
 * of sound it was asked to be?
 *
 * Why this exists: the only "does it sound right?" check the plugin had was a
 * call to an external audio-understanding model, which needs a configured key
 * and a network round trip. That is fine as an optional opinion, but it cannot
 * be the thing that runs on every delivery: a machine without the key got an
 * error instead of a verdict, and a model's prose cannot be regression-tested.
 *
 * Everything here is deterministic and needs no model, no network and no
 * training data. The idea is cheap and old: every sound family has a *shape* in
 * a handful of numbers — a percussive hit is peaky (high crest factor) and
 * mid-bright, a noise bed is flat (low crest) and dark, a riser is bright and
 * has no discrete onset. So the family's expected ranges are measured once from
 * the synthesiser's own renders (the tables below are calibrated numbers, not
 * taste), and a render that falls outside them is worth a second look.
 *
 * The check never claims to know what a sound *is*. It catches the failures
 * that actually reach a page: the wrong preset rendered, a silent or clipped
 * file, a bed that is really a one-shot (its crest factor gives it away), a
 * "seamless" loop with a 20 dB seam, a sound three times too long. A range miss
 * is a warning; the technical checks (non-finite samples, no signal, clipping)
 * are errors.
 *
 * Unknown `preset`/`recipe` ids fall back to the generic checks only, with every
 * check tagged `scope: 'generic'`, so a caller that has no idea what the file
 * was supposed to be still gets a useful report instead of a guess.
 */

import { measureChannels, readChannels } from './audio.js'

/** Peak below this is "no signal" everywhere else in the plugin, so it is here too. */
const SILENT_PEAK_DB = -40
/** A sample magnitude at or above this is a clipped sample (matches `measure`). */
const CLIP_MAGNITUDE = 0.999
/** DC offset above this is a warning (matches `audio_check`'s own threshold). */
const DC_WARN = 0.02
/** A loop with a bigger head/tail level jump will thump once per repeat. */
const LOOP_SEAM_MAX_DB = 6
/** Measured durations are compared with this tolerance; renders are frame-quantised. */
const DURATION_TOLERANCE_SECONDS = 0.06

/* ------------------------------------------------------------------ tables -- */

/**
 * Expected shape of the nine core presets.
 *
 * Ranges are calibrated from renders of the current engine (seed 1..4, 22050 /
 * 44100 / 48000 Hz, default and extreme parameter sets, then normalised to -1
 * dBFS and 16-bit encoded exactly like `audio_synth` writes them), then widened
 * by roughly one range step so a legitimate extreme parameter (a very dark
 * whoosh, a very bright tick) is not flagged. They are sanity bounds, not
 * targets: a value outside the range means "check whether this is the preset you
 * meant", not "this render is wrong".
 *
 * Fields:
 *   crestDb        [min, max] peak-to-RMS ratio in dB (a hit is peaky, a bed is not)
 *   centroidHz     [min, max] spectral centroid in Hz (brightness)
 *   onsets         [min, max] detected attacks (0 is normal for a sweep/bed)
 *   durationSeconds the preset's default render length, used when the caller did
 *                   not state the duration it asked for
 *
 * @type {Readonly<Record<string, { crestDb: number[], centroidHz: number[], onsets: number[], durationSeconds: number }>>}
 */
export const PRESET_RANGES = Object.freeze({
  // Weighty hit: body thump + click. Peak dominates RMS -> ~14 dB crest.
  impact: { crestDb: [8, 24], centroidHz: [70, 800], onsets: [1, 3], durationSeconds: 0.9 },
  // Filtered-noise sweep: no transient, so no onset; brightness rides `tone`/`pitch`.
  whoosh: { crestDb: [10, 24], centroidHz: [600, 8000], onsets: [0, 2], durationSeconds: 0.8 },
  // 50 ms click: the shortest member, and the widest centroid span (900..5200 Hz).
  tick: { crestDb: [6, 20], centroidHz: [800, 6500], onsets: [1, 2], durationSeconds: 0.05 },
  // Tonal bell with inharmonic partials: lower crest, pitch sets the centroid.
  chime: { crestDb: [8, 22], centroidHz: [250, 3000], onsets: [1, 2], durationSeconds: 1.1 },
  // Tension sweep: energy keeps growing, so it is peaky and has no isolated onset.
  riser: { crestDb: [12, 26], centroidHz: [2500, 9000], onsets: [0, 2], durationSeconds: 1.6 },
  // Fast downward chirp + crackle: short and bright.
  zap: { crestDb: [7, 20], centroidHz: [1200, 7000], onsets: [1, 2], durationSeconds: 0.3 },
  // Soft low body with almost no transient: the darkest member.
  thud: { crestDb: [7, 20], centroidHz: [50, 350], onsets: [1, 2], durationSeconds: 0.35 },
  // Sparse grains: the most peaky member of the table, and mid-to-bright.
  scrap: { crestDb: [14, 30], centroidHz: [1200, 9000], onsets: [1, 6], durationSeconds: 0.6 },
  // Sustained bed: the least peaky member. `hum` sits at 6.7 dB, wind at ~11 dB;
  // the onset count is high because the detector sees the noise texture ripple.
  texture: { crestDb: [3, 18], centroidHz: [50, 900], onsets: [0, 40], durationSeconds: 3 }
})

/**
 * Expected shape of the design recipes the self-check knows.
 *
 * These are the named, tuned arrangements from `lib/design.js`, so their ranges
 * are narrower than a single preset's (a recipe fixes the layering). Only the
 * recipes listed here are checked by family; every other recipe id falls back to
 * the generic checks, which is the documented behaviour for an unknown id.
 * `loop` marks the recipes authored as seamless beds: a caller that asks for
 * `loop: true` on one of those should get a seam under 6 dB.
 *
 * @type {Readonly<Record<string, { crestDb: number[], centroidHz: number[], onsets: number[], durationSeconds: number, loop?: boolean }>>}
 */
export const RECIPE_RANGES = Object.freeze({
  'door-slam-metal': { crestDb: [12, 28], centroidHz: [90, 500], onsets: [1, 3], durationSeconds: 1.6 },
  'door-close-soft': { crestDb: [12, 26], centroidHz: [100, 400], onsets: [1, 3], durationSeconds: 1.0 },
  'glass-break': { crestDb: [14, 28], centroidHz: [900, 3000], onsets: [1, 3], durationSeconds: 1.4 },
  'wood-crack': { crestDb: [10, 24], centroidHz: [120, 600], onsets: [1, 3], durationSeconds: 0.8 },
  'explosion-far': { crestDb: [12, 28], centroidHz: [40, 300], onsets: [1, 5], durationSeconds: 2.8 },
  'explosion-near': { crestDb: [9, 24], centroidHz: [80, 400], onsets: [2, 8], durationSeconds: 1.8 },
  'whoosh-into-impact': { crestDb: [12, 26], centroidHz: [80, 800], onsets: [1, 3], durationSeconds: 2.0 },
  'sci-fi-charge': { crestDb: [14, 28], centroidHz: [2500, 8000], onsets: [0, 3], durationSeconds: 1.9 },
  'sci-fi-hum-loop': { crestDb: [6, 18], centroidHz: [40, 250], onsets: [5, 60], durationSeconds: 3.0, loop: true },
  'magic-sparkle': { crestDb: [12, 26], centroidHz: [900, 3500], onsets: [1, 3], durationSeconds: 1.7 },
  'magic-dark': { crestDb: [9, 24], centroidHz: [300, 1600], onsets: [1, 3], durationSeconds: 2.4 },
  'water-drip': { crestDb: [12, 28], centroidHz: [2500, 8000], onsets: [1, 3], durationSeconds: 0.8 },
  'water-splash': { crestDb: [12, 28], centroidHz: [800, 4000], onsets: [0, 4], durationSeconds: 1.2 },
  'footstep-gravel': { crestDb: [11, 26], centroidHz: [80, 500], onsets: [1, 3], durationSeconds: 0.65 },
  'cloth-rustle': { crestDb: [12, 28], centroidHz: [1500, 6000], onsets: [0, 3], durationSeconds: 0.65 },
  'ui-success': { crestDb: [9, 22], centroidHz: [500, 2200], onsets: [1, 3], durationSeconds: 0.8 },
  'ui-error': { crestDb: [9, 22], centroidHz: [1500, 5000], onsets: [1, 4], durationSeconds: 0.6 },
  'ui-hover': { crestDb: [10, 24], centroidHz: [1200, 4500], onsets: [1, 2], durationSeconds: 0.18 },
  'ui-toggle': { crestDb: [10, 24], centroidHz: [1200, 4500], onsets: [1, 2], durationSeconds: 0.3 },
  'coin-pickup': { crestDb: [10, 24], centroidHz: [700, 2500], onsets: [1, 3], durationSeconds: 0.7 },
  'machinery-loop': { crestDb: [7, 20], centroidHz: [50, 400], onsets: [4, 30], durationSeconds: 3.0, loop: true },
  'alarm-loop': { crestDb: [10, 24], centroidHz: [500, 1600], onsets: [1, 10], durationSeconds: 2.4, loop: true },
  'creature-scream': { crestDb: [14, 28], centroidHz: [2000, 7000], onsets: [0, 3], durationSeconds: 1.4 },
  'creature-growl': { crestDb: [10, 24], centroidHz: [50, 300], onsets: [1, 4], durationSeconds: 1.5 },
  heartbeat: { crestDb: [10, 24], centroidHz: [40, 200], onsets: [2, 4], durationSeconds: 0.9 },
  'thunder-distant': { crestDb: [12, 26], centroidHz: [40, 250], onsets: [1, 6], durationSeconds: 3.0 },
  'whale-song': { crestDb: [9, 22], centroidHz: [100, 500], onsets: [2, 14], durationSeconds: 5.0 },
  'wolf-howl': { crestDb: [8, 20], centroidHz: [200, 600], onsets: [0, 3], durationSeconds: 3.2 },
  'hoofbeats': { crestDb: [14, 28], centroidHz: [100, 400], onsets: [2, 6], durationSeconds: 1.8 },
  'bird-chirp': { crestDb: [14, 28], centroidHz: [3000, 8000], onsets: [1, 4], durationSeconds: 0.9 },
  'bird-flock': { crestDb: [14, 28], centroidHz: [3000, 8000], onsets: [2, 8], durationSeconds: 2.2 },
  'wing-flap': { crestDb: [12, 26], centroidHz: [600, 1800], onsets: [0, 4], durationSeconds: 1.6 },
  'creature-hiss': { crestDb: [14, 30], centroidHz: [2500, 7000], onsets: [0, 3], durationSeconds: 1.8 },
  'rodent-squeak': { crestDb: [15, 30], centroidHz: [4000, 8500], onsets: [1, 4], durationSeconds: 0.9 },
  'bat-echolocation': { crestDb: [16, 30], centroidHz: [4000, 9000], onsets: [1, 6], durationSeconds: 1.6 }
})

/* ------------------------------------------------------------------ helpers -- */

/** `true` when a value is a real number inside `[min, max]`. */
function inRange (value, range) {
  return Number.isFinite(value) && value >= range[0] && value <= range[1]
}

/** Round for reporting, keeping the sign of a DC offset readable. */
function round (value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value
}

function rangeText (range, unit) {
  return `${range[0]}..${range[1]}${unit}`
}

/**
 * Resolve the family a `spec` names.
 *
 * A recipe id wins over a preset id because a recipe is the more specific
 * request. An id that is not in a table returns `null` ("generic"): guessing the
 * nearest family would make a typo look like a shape failure.
 *
 * @param {object|undefined} spec - `{ preset?, recipe? }`.
 * @returns {{ kind: 'preset'|'recipe', id: string, ranges: object }|null}
 */
function resolveFamily (spec) {
  if (spec === null || typeof spec !== 'object') return null
  const recipe = typeof spec.recipe === 'string' ? spec.recipe.trim().toLowerCase() : ''
  if (recipe !== '' && RECIPE_RANGES[recipe] !== undefined) return { kind: 'recipe', id: recipe, ranges: RECIPE_RANGES[recipe] }
  const preset = typeof spec.preset === 'string' ? spec.preset.trim().toLowerCase() : ''
  if (preset !== '' && PRESET_RANGES[preset] !== undefined) return { kind: 'preset', id: preset, ranges: PRESET_RANGES[preset] }
  return null
}

/**
 * Turn the input into `{ channels, sampleRate, bitDepth }`.
 *
 * A `wavPath` is read with the channel-preserving reader. In-memory input may be
 * one buffer (mono) or one buffer per channel, so a caller that already decoded
 * a file does not have to write it back to disk to be checked.
 *
 * @param {object} input - `{ wavPath }` or `{ samples, sampleRate, channels? }`.
 * @returns {Promise<{ channels: Float32Array[], sampleRate: number, bitDepth: number|null }>}
 */
async function resolveInput (input) {
  if (input === null || typeof input !== 'object') throw new Error('selfCheck needs { wavPath } or { samples, sampleRate }')
  if (typeof input.wavPath === 'string' && input.wavPath.trim() !== '') {
    const decoded = await readChannels(input.wavPath)
    return { channels: decoded.channels, sampleRate: decoded.sampleRate, bitDepth: decoded.bitDepth }
  }
  const sampleRate = Number(input.sampleRate)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`selfCheck needs a positive sampleRate with in-memory samples, got ${input.sampleRate}`)
  }
  const requested = Array.isArray(input.channels) && input.channels.length > 0 ? input.channels : input.samples
  if (requested === null || requested === undefined) throw new Error('selfCheck needs wavPath or samples')
  const channels = Array.isArray(requested) ? requested : [requested]
  for (const channel of channels) {
    if (channel === null || typeof channel !== 'object' || typeof channel.length !== 'number') {
      throw new Error('selfCheck samples must be a Float32Array (or one per channel)')
    }
  }
  return { channels, sampleRate, bitDepth: null }
}

/* -------------------------------------------------------------------- main -- */

/**
 * Run the deterministic local self-check on one sound.
 *
 * @param {object} input - one of:
 *   - `{ wavPath, spec? }` — read the file and check it;
 *   - `{ samples, sampleRate, channels?, spec? }` — check samples in memory
 *     (`samples` is one buffer for mono, or one buffer per channel).
 *   `spec` may carry `{ preset?, recipe?, duration?, sampleRate?, loop? }`: the
 *   values the caller asked for. Only what `spec` states is checked — with no
 *   spec, only the generic checks run.
 * @returns {Promise<{ ok: boolean, family: { kind: string, id: string }|null,
 *   checks: { name: string, ok: boolean, detail: string, level: 'error'|'warn',
 *   scope: 'generic'|'family' }[], summary: string, metrics: object }>}
 */
export async function selfCheck (input) {
  const source = await resolveInput(input)
  const spec = input.spec !== null && typeof input.spec === 'object' ? input.spec : {}
  const family = resolveFamily(spec)
  const scope = family === null ? 'generic' : 'family'
  const sampleRate = source.sampleRate
  const channels = source.channels
  const frames = Math.min(...channels.map((channel) => channel.length))
  const metrics = {
    ...measureChannels(channels, sampleRate),
    sampleRate,
    channels: channels.length,
    ...(source.bitDepth === null ? {} : { bitDepth: source.bitDepth }),
    analysisDurationSeconds: frames / sampleRate
  }

  // Non-finite samples are invisible to every other metric: `peak` comparisons
  // against NaN are false, so a file of NaNs can otherwise read as "quiet".
  let nanCount = 0
  let infiniteCount = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const value = channel[index]
      if (Number.isNaN(value)) nanCount += 1
      else if (!Number.isFinite(value)) infiniteCount += 1
    }
  }

  const checks = []
  const add = (name, ok, detail, level, checkScope = scope) => {
    checks.push({ name, ok, detail, level, scope: checkScope })
  }

  /* ---- generic checks: valid for any file ---- */

  add('finiteSamples',
    nanCount === 0 && infiniteCount === 0,
    nanCount === 0 && infiniteCount === 0 ? '没有 NaN / Infinity 采样' : `非有限采样：NaN ${nanCount} 个、Infinity ${infiniteCount} 个`,
    'error', 'generic')

  const peakOk = metrics.peakDbfs > SILENT_PEAK_DB && metrics.peakDbfs <= 0
  add('peak',
    peakOk,
    `峰值 ${round(metrics.peakDbfs)} dBFS（要求 ${SILENT_PEAK_DB}..0）`,
    'error', 'generic')

  add('clipping',
    metrics.clipping === 0,
    metrics.clipping === 0 ? '没有削波采样' : `${metrics.clipping} 个采样削波（|x| ≥ ${CLIP_MAGNITUDE}）`,
    'error', 'generic')

  add('dcOffset',
    Math.abs(metrics.dcOffset) < DC_WARN,
    `直流偏移 ${round(metrics.dcOffset, 4)}（要求 |DC| < ${DC_WARN}）`,
    'warn', 'generic')

  // Duration: compare against the length the caller asked for, or the family's
  // default when a family is known. No expectation means nothing to check.
  const expectedDuration = Number.isFinite(spec.duration)
    ? Number(spec.duration)
    : family === null ? null : family.ranges.durationSeconds
  const durationDelta = expectedDuration === null ? 0 : Math.abs(metrics.analysisDurationSeconds - expectedDuration)
  add('duration',
    expectedDuration === null ? true : durationDelta <= DURATION_TOLERANCE_SECONDS,
    expectedDuration === null
      ? `时长 ${round(metrics.analysisDurationSeconds, 3)}s（未指定期望时长，跳过）`
      : `时长 ${round(metrics.analysisDurationSeconds, 3)}s（期望 ${round(expectedDuration, 3)}s ± ${DURATION_TOLERANCE_SECONDS}s）`,
    'warn', 'generic')

  const expectedRate = Number.isFinite(spec.sampleRate) ? Math.round(Number(spec.sampleRate)) : null
  add('sampleRate',
    expectedRate === null ? true : sampleRate === expectedRate,
    expectedRate === null ? `采样率 ${sampleRate} Hz（未指定期望采样率，跳过）` : `采样率 ${sampleRate} Hz（期望 ${expectedRate} Hz）`,
    'warn', 'generic')

  // A continuous sweep legitimately has no discrete onset, and a sustained bed
  // can either have none (a smooth pad) or many (noise texture ripple). So the
  // generic check only flags a file that is *both* attack-free and flat: that
  // combination is a static tone or a broken one-shot, not a designed sound. The
  // family ranges below are where the real expectation lives.
  add('onsets',
    metrics.onsets >= 1 || metrics.crestDb >= 10,
    `检测到 ${metrics.onsets} 个起音、波峰因数 ${round(metrics.crestDb)} dB（一次性音效应有起音；持续床可以没有，但要有动态）`,
    'warn', 'generic')

  /* ---- family checks: only when the spec names a known preset or recipe ---- */

  if (family !== null) {
    const ranges = family.ranges
    add('crestFactor',
      inRange(metrics.crestDb, ranges.crestDb),
      `波峰因数 ${round(metrics.crestDb)} dB（${family.id} 期望 ${rangeText(ranges.crestDb, ' dB')}）`,
      'warn')
    add('spectralCentroid',
      inRange(metrics.centroidHz, ranges.centroidHz),
      `谱质心 ${Math.round(metrics.centroidHz)} Hz（${family.id} 期望 ${rangeText(ranges.centroidHz, ' Hz')}）`,
      'warn')
    add('onsetCount',
      inRange(metrics.onsets, ranges.onsets),
      `起音 ${metrics.onsets} 个（${family.id} 期望 ${rangeText(ranges.onsets, ' 个')}）`,
      'warn')
  }

  /* ---- loop seam: only when the caller says it is a loop ---- */

  if (spec.loop === true) {
    add('loopSeam',
      metrics.loopSeam < LOOP_SEAM_MAX_DB,
      `循环接缝 ${round(metrics.loopSeam)} dB（要求 < ${LOOP_SEAM_MAX_DB} dB）`,
      'warn')
  }

  const failed = checks.filter((check) => !check.ok)
  const ok = failed.length === 0
  const label = family === null ? '通用' : `${family.kind === 'recipe' ? '配方' : '预设'} ${family.id}`
  const summary = ok
    ? `本地自检通过（${label}）：${checks.length} 项检查全部通过`
    : `本地自检未通过（${label}）：${failed.length}/${checks.length} 项失败 — ${failed.map((check) => `${check.name}：${check.detail}`).join('；')}`

  return {
    ok,
    family: family === null ? null : { kind: family.kind, id: family.id },
    checks,
    summary,
    metrics: {
      ...metrics,
      // Keep the report free of non-finite JSON: silence is the documented floor.
      peakDbfs: Number.isFinite(metrics.peakDbfs) ? metrics.peakDbfs : -120,
      rmsDbfs: Number.isFinite(metrics.rmsDbfs) ? metrics.rmsDbfs : -120,
      crestDb: Number.isFinite(metrics.crestDb) ? metrics.crestDb : 0,
      centroidHz: Number.isFinite(metrics.centroidHz) ? metrics.centroidHz : 0,
      nonFiniteSamples: nanCount + infiniteCount,
      nanSamples: nanCount,
      infiniteSamples: infiniteCount,
      family: family === null ? 'generic' : `${family.kind}:${family.id}`,
      loop: spec.loop === true
    }
  }
}
