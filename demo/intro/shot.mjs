/**
 * Capture a few frames of the intro page in headless Chrome via CDP.
 *
 * The animation is gated behind a click (browser autoplay policy), so a plain
 * --screenshot only ever shows the gate. This drives a real mouse click, waits
 * for the AudioContext clock to advance, and captures the interesting scenes.
 *
 * Usage: node demo/intro/shot.mjs [seconds ...]   (default: 1.5 4.5 8 11.5 15)
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'frames')
mkdirSync(outDir, { recursive: true })

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PAGE = `file:///${resolve(here, 'index.html').replace(/\\/g, '/')}`
const shots = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n))
if (shots.length === 0) shots.push(1.5, 4.5, 8, 11.5, 15)

const port = 9333
const profile = join(here, '.chrome-profile')
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,720',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function targets () {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const page = list.find((entry) => entry.type === 'page')
      if (page !== undefined) return page
    } catch { /* chrome not up yet */ }
    await sleep(150)
  }
  throw new Error('chrome did not expose a page target')
}

function connect (url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('open', () => resolveSocket({
      send (method, params = {}) {
        const id = nextId++
        socket.send(JSON.stringify({ id, method, params }))
        return new Promise((done, fail) => pending.set(id, { done, fail }))
      },
      close () { socket.close() }
    }))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.fail(new Error(`${message.error.code}: ${message.error.message}`))
      else waiter.done(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('websocket error')))
  })
}

try {
  const page = await targets()
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(900)

  // Find the start control and click its real centre: the viewport is smaller
  // than the window size, so hard-coded coordinates miss.
  const rect = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const start = buttons.find((b) => /开始|start/i.test(b.textContent || '')) || buttons[0];
      if (!start) return null;
      const r = start.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (start.textContent || '').trim().slice(0, 20) });
    })()`,
    returnByValue: true
  })
  if (rect.result.value === null) throw new Error('no start control found in the page')
  const spot = JSON.parse(rect.result.value)
  console.log(`clicking "${spot.text}" at ${spot.x},${spot.y}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  }
  await sleep(200)
  const started = Date.now()
  for (const at of shots) {
    const waitMs = Math.max(0, at * 1000 - (Date.now() - started))
    await sleep(waitMs)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = join(outDir, `t${String(at).replace('.', '_')}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`t=${at}s -> ${file}`)
  }

  // Report what the page thinks it is doing at the end.
  const state = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({status: document.body.dataset.status ?? null, hud: (document.querySelector("#hud")?.textContent ?? "").slice(0,120)})',
    returnByValue: true
  })
  console.log(`page state: ${state.result.value}`)
  cdp.close()
} finally {
  chrome.kill()
}
