/**
 * Timeline lane packing, shared by every interop writer that has tracks.
 *
 * A timeline with tracks cannot express two clips at the same time inside one
 * track, and neither can the formats that map one track to one sequence: AAF's
 * timeline mob slots, OTIO's Track children, FCP7's `<track>` elements. Writing
 * a file that simply drops the second of two overlapping cues would be a silent
 * loss — the caller asked for both.
 *
 * So the writers pack: cues are sorted by start time and dropped into the first
 * lane whose last clip has already ended, which is the classic greedy for
 * interval partitioning and yields the minimum possible number of lanes. Two
 * cues that merely touch (one ends at 1.5 s, the next starts at 1.5 s) share a
 * lane, because a gap of zero is not an overlap.
 *
 * This module exists on its own so the AAF, OTIO and FCP7 writers share one
 * definition of "lane" instead of three subtly different ones.
 */

/**
 * Pack clips into the minimum number of non-overlapping lanes.
 *
 * @param {Array<{at: number, duration: number}>} entries - timeline clips.
 * @returns {Array<Array<object>>} lanes, each in timeline order; empty for no input.
 */
export function packLanes (entries) {
  if (!Array.isArray(entries)) throw new Error('timeline: packLanes needs an array of clips')
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (left.entry.at === right.entry.at ? left.index - right.index : left.entry.at - right.entry.at))
  const lanes = []
  const laneEnds = []
  for (const item of ordered) {
    const at = Number(item.entry.at ?? 0)
    const duration = Number(item.entry.duration ?? 0)
    let lane = laneEnds.findIndex((end) => end <= at + 1e-9)
    if (lane === -1) {
      lane = lanes.length
      lanes.push([])
      laneEnds.push(0)
    }
    lanes[lane].push(item.entry)
    laneEnds[lane] = at + duration
  }
  return lanes
}
