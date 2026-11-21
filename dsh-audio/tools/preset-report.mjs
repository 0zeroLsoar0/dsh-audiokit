#!/usr/bin/env node
/**
 * Print every registered preset as a table.
 *
 * The docs list presets by hand today, which is how a name and its description
 * drift apart. This script reads the same table the renderer uses, so the
 * pasted table cannot be wrong about what exists.
 *
 *   node tools/preset-report.mjs              aligned table, all presets
 *   node tools/preset-report.mjs --extra      only the second vocabulary
 *   node tools/preset-report.mjs --markdown   markdown table for the README
 *   node tools/preset-report.mjs --knobs      append the knob names
 *
 * Output is deterministic: fixed column widths, no locale formatting.
 */

import { PRESETS } from '../lib/dsp.js'
// Imported for its registration side effect: the report is the second caller
// that proves `PRESETS` is extended by a plain import.
import { EXTRA_PRESETS } from '../lib/presets-extra.js'

const args = new Set(process.argv.slice(2))
if (args.has('--help') || args.has('-h')) {
  console.log('usage: node tools/preset-report.mjs [--extra] [--markdown] [--knobs]')
  process.exit(0)
}
const unknown = [...args].filter((arg) => !['--extra', '--markdown', '--knobs'].includes(arg))
if (unknown.length > 0) {
  console.error(`unknown option: ${unknown.join(', ')}`)
  console.error('usage: node tools/preset-report.mjs [--extra] [--markdown] [--knobs]')
  process.exit(1)
}

const extraOnly = args.has('--extra')
const markdown = args.has('--markdown')
const showKnobs = args.has('--knobs')

const rows = Object.entries(PRESETS)
  .filter(([name]) => !extraOnly || EXTRA_PRESETS[name] !== undefined)
  .map(([name, spec]) => ({
    name,
    seconds: Number(spec.defaultDuration).toFixed(2) + ' s',
    knobs: Object.keys(spec.params ?? {}).join(', '),
    description: spec.description
  }))

if (markdown) {
  const header = showKnobs ? '| preset | default | knobs | description |' : '| preset | default | description |'
  const rule = showKnobs ? '| --- | --- | --- | --- |' : '| --- | --- | --- |'
  console.log(header)
  console.log(rule)
  for (const row of rows) {
    console.log(showKnobs
      ? `| ${row.name} | ${row.seconds} | ${row.knobs} | ${row.description} |`
      : `| ${row.name} | ${row.seconds} | ${row.description} |`)
  }
} else {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 'preset'.length)
  const secondsWidth = Math.max(...rows.map((row) => row.seconds.length), 'default'.length)
  const knobsWidth = Math.max(...rows.map((row) => row.knobs.length), 'knobs'.length)
  const line = ['preset'.padEnd(nameWidth), 'default'.padEnd(secondsWidth)]
  if (showKnobs) line.push('knobs'.padEnd(knobsWidth))
  line.push('description')
  console.log(line.join('  '))
  console.log('-'.repeat(line.join('  ').length))
  for (const row of rows) {
    const cells = [row.name.padEnd(nameWidth), row.seconds.padEnd(secondsWidth)]
    if (showKnobs) cells.push(row.knobs.padEnd(knobsWidth))
    cells.push(row.description)
    console.log(cells.join('  '))
  }
}

const extraCount = rows.filter((row) => EXTRA_PRESETS[row.name] !== undefined).length
console.log('')
console.log(`${rows.length} preset(s)${extraOnly ? '' : ` (${extraCount} in the second vocabulary)`}  renderer: lib/dsp.js + lib/presets-extra.js`)
