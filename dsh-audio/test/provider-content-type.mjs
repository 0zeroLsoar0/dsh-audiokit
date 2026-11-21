/**
 * Regression for a silent-corruption bug found by the HTTP integration test:
 * a 200 response whose body is an HTML/JSON error page was accepted as raw PCM
 * and played as noise, making an endpoint problem look like a synthesis bug.
 */

import http from 'node:http'
import { speak } from '../lib/providers.js'

const failures = []
function check (ok, message) {
  if (!ok) failures.push(message)
}

const server = http.createServer((request, response) => {
  if (request.url === '/v1/audio/speech') {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>502 Bad Gateway</body></html>')
    })
    return
  }
  response.writeHead(404).end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const config = { provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', model: 'tts-1', voice: 'alloy' }

try {
  let error = null
  try {
    await speak(config, 'hello')
  } catch (cause) {
    error = cause
  }
  console.log(`-- html 200 body --\n  ${error === null ? 'NO ERROR (bug)' : error.message.slice(0, 120)}`)
  check(error !== null, 'an HTML 200 body must not be decoded as PCM')
  check(error !== null && /不是音频/.test(error.message), 'the error must say the body is not audio')
  check(error !== null && /text\/html/.test(error.message), 'the error must name the content-type')
  check(error !== null && /Bad Gateway/.test(error.message), 'the error must include a body snippet')
} finally {
  await new Promise((resolve) => server.close(resolve))
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nOK: non-audio 200 responses are rejected with a readable error')
