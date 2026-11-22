/**
 * Sample the live MotionHarness page for its actual palette, then screenshot it.
 *
 * The page is a JS app, so the served HTML says nothing about colour. Loading it
 * in headless Chrome and reading computed styles is the only honest way to copy
 * the scheme instead of guessing it.
 *
 * Usage: node demo/showall/probe-motionharness.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'reference')
mkdirSync(outDir, { recursive: true })

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'https://motionharness.top/'
const port = 9444
const profile = join(outDir, '.chrome-profile')
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target () {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((e) => e.type === 'page')
      if (page) return page
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error('chrome did not expose a page')
}

function connect (url) {
  return new Promise((ok, bad) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let id = 1
    socket.addEventListener('open', () => ok({
      send (method, params = {}) {
        const messageId = id++
        socket.send(JSON.stringify({ id: messageId, method, params }))
        return new Promise((done, fail) => pending.set(messageId, { done, fail }))
      },
      close () { socket.close() }
    }))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.fail(new Error(JSON.stringify(message.error)))
      else waiter.done(message.result)
    })
    socket.addEventListener('error', () => bad(new Error('ws error')))
  })
}

const SAMPLE = `(() => {
  const colors = new Map()
  const add = (value, where) => {
    if (!value) return
    const key = String(value).trim()
    if (!key || key === 'rgba(0, 0, 0, 0)' || key === 'transparent') return
    if (!colors.has(key)) colors.set(key, { value: key, count: 0, where: new Set() })
    const row = colors.get(key)
    row.count += 1
    if (where) row.where.add(where)
  }
  const nodes = [...document.querySelectorAll('body, header, main, section, footer, nav, h1, h2, h3, p, button, a, div, span')]
  for (const node of nodes.slice(0, 4000)) {
    const style = getComputedStyle(node)
    const tag = node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
    add(style.backgroundColor, tag)
    add(style.color, tag)
    add(style.borderTopColor, tag)
    if (style.backgroundImage && style.backgroundImage !== 'none') add(style.backgroundImage.slice(0, 120), tag)
  }
  const rows = [...colors.values()].sort((a, b) => b.count - a.count).slice(0, 40)
    .map((row) => ({ value: row.value, count: row.count, where: [...row.where].slice(0, 4) }))
  const cssVars = []
  const rootStyle = getComputedStyle(document.documentElement)
  for (const sheet of document.styleSheets) {
    let rules = []
    try { rules = sheet.cssRules || [] } catch { continue }
    for (const rule of rules) {
      if (rule.style !== undefined && rule.selectorText && /:root|html/.test(rule.selectorText)) {
        for (const name of rule.style) if (name.startsWith('--')) cssVars.push([name, rule.style.getPropertyValue(name).trim()])
      }
    }
  }
  return JSON.stringify({
    title: document.title,
    bodyFont: getComputedStyle(document.body).fontFamily,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    rows,
    cssVars: cssVars.slice(0, 120),
    textSample: (document.body.innerText || '').slice(0, 600)
  }, null, 2)
})()`

try {
  const page = await target()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: URL })
  await sleep(6000)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, 'motionharness.png'), Buffer.from(shot.data, 'base64'))
  const result = await cdp.send('Runtime.evaluate', { expression: SAMPLE, returnByValue: true })
  writeFileSync(join(outDir, 'motionharness-palette.json'), result.result.value)
  console.log(`screenshot + palette written to ${outDir}`)
  console.log(String(result.result.value).slice(0, 1200))
  cdp.close()
} finally {
  chrome.kill()
}
