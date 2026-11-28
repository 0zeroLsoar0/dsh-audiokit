/**
 * Cooperative yielding for the long render loops.
 *
 * Why a generator and not two implementations: `renderScore`, `masterChain` and
 * `renderBus` are synchronous public APIs and must stay that way, but the tool
 * layer calls them from an `async execute` and needs the host event loop to keep
 * turning timers and I/O while a multi-second render runs. Writing the render
 * loop once as a generator and driving it with one of two runners gives both
 * without a second copy of the arithmetic:
 *
 * - `driveSync` calls `next()` until the generator returns. The `yield`s are
 *   cooperation points it simply ignores, so the synchronous API keeps its
 *   synchronous contract and its cost (a generator frame is not where the
 *   samples are computed; see the note below).
 * - `driveAsync` does the same but awaits `yieldToHost()` at every cooperation
 *   point, so the event loop is free between blocks.
 *
 * What a cooperation point may and may not change: the generator yields *between*
 * blocks of work, never inside an expression, and every block is computed by a
 * plain function that does the same arithmetic in the same order as the
 * single-pass version did. So the sample values, the RNG call sequence and the
 * order of floating-point operations are identical whether the caller drives
 * sync or async — the only difference is that the async driver returns control
 * to the host between blocks (`test/yield.mjs` asserts byte equality).
 *
 * Deliberately no clock and no randomness in here: yielding must not influence
 * any deterministic output, and a wall-clock budget would make the async result
 * depend on machine load.
 */

/**
 * Frames of audio processed between two cooperation points.
 *
 * 32768 frames is 0.74 s at 44.1 kHz and ~0.68 s at 48 kHz — far coarser than a
 * render block needs to be for correctness, and small enough that a block costs
 * a few milliseconds, which is the granularity a host event loop wants. It is
 * also a multiple of the compressor control block used by `lib/master.js`, so
 * chunk boundaries there land on control-block boundaries and the arithmetic
 * does not even see the split.
 */
export const YIELD_EVERY_FRAMES = 32768

/**
 * Hand control back to the host event loop.
 *
 * `setImmediate` rather than `setTimeout(0)`: the host's timer phase and I/O are
 * already due by the time the check phase runs, so a callback registered here
 * lets due timers fire before the render resumes. No clock read, so the yield
 * schedule is independent of machine speed.
 * @returns {Promise<void>} resolves on the next check phase.
 */
export const yieldToHost = () => new Promise((resolve) => {
  setImmediate(resolve)
})

/**
 * Frame counter that decides when the next cooperation point is due.
 *
 * Two entry points, so one counter serves both kinds of caller:
 * - `hit(frames)` is the synchronous question a generator asks before it
 *   `yield`s: "have I done a block's worth of work since the last one?"
 * - `step(frames)` is the asynchronous form the task description asks for:
 *   `await`s `yieldToHost()` exactly when `hit` says yes. It is provided so a
 *   plain `async` loop (not a generator) can use the same policy.
 *
 * The counter is a pure counter: no RNG call, no clock read, and an integer-only
 * state, so counting frames can never perturb a render.
 * @param {{ everyFrames?: number }} [options] - cooperation interval in frames.
 * @returns {{ everyFrames: number, hit: (frames?: number) => boolean,
 *   step: (frames?: number) => Promise<void>, reset: () => void }}
 */
export function makeYielder ({ everyFrames = YIELD_EVERY_FRAMES } = {}) {
  const every = Number.isFinite(Number(everyFrames)) && Number(everyFrames) >= 1
    ? Math.floor(Number(everyFrames))
    : YIELD_EVERY_FRAMES
  let pending = 0
  // `hit` resets to zero rather than subtracting the interval: a block longer
  // than the interval then yields once and starts a fresh block instead of
  // firing a burst of back-to-back cooperation points on the next call.
  const hit = (frames = 1) => {
    pending += Math.abs(Number(frames)) || 0
    if (pending < every) return false
    pending = 0
    return true
  }
  const step = async (frames = 1) => {
    if (hit(frames)) await yieldToHost()
  }
  return {
    everyFrames: every,
    hit,
    step,
    reset () {
      pending = 0
    }
  }
}

/**
 * Run a render generator to completion without ever awaiting.
 *
 * This is what the synchronous public APIs use. It ignores the values yielded
 * (they are cooperation points, not data), so the generator's body runs to the
 * end exactly as a plain function would, on the same stack.
 * @template T
 * @param {Generator<unknown, T, unknown>} iterator - render generator.
 * @returns {T} whatever the generator returned.
 */
export function driveSync (iterator) {
  for (;;) {
    const step = iterator.next()
    if (step.done) return step.value
  }
}

/**
 * Run a render generator to completion, yielding to the host between blocks.
 *
 * Each yielded cooperation point costs one `setImmediate` round trip — tens of
 * microseconds, against a block of work worth milliseconds — so a whole cue pays
 * a few milliseconds for staying interruptible.
 * @template T
 * @param {Generator<unknown, T, unknown>} iterator - render generator.
 * @returns {Promise<T>} whatever the generator returned.
 */
export async function driveAsync (iterator) {
  for (;;) {
    const step = iterator.next()
    if (step.done) return step.value
    await yieldToHost()
  }
}
