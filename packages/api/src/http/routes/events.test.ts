import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

// events.ts zieht über auth.ts config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { eventRoutes } = await import('./events.js')
const { publish, subscriberCount } = await import('../../lib/events.js')

/**
 * UI-Qualität 3: GET /api/v1/events. Die Anmeldung prüft der Auth-Wächter
 * (auth.test.ts); hier: Token abgelehnt, Ereignisse kommen an, «abgemeldet»
 * beendet den Strom und räumt den Abonnenten weg.
 */
let app: FastifyInstance
let base = ''

before(async () => {
  app = Fastify()
  app.decorateRequest('actor', '')
  app.decorateRequest('tokenId', null)
  // Stellvertretend für den Auth-Wächter: «x-token» spielt einen API-Token
  app.addHook('onRequest', async (request) => {
    request.tokenId = request.headers['x-token'] ? 't1' : null
  })
  await app.register(eventRoutes, { prefix: '/api/v1' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
after(() => app.close())

async function readUntil(body: ReadableStream<Uint8Array>, done: (text: string) => boolean): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let text = ''
  while (!done(text)) {
    const r = await reader.read()
    if (r.done) break
    text += dec.decode(r.value)
  }
  reader.releaseLock()
  return text
}

describe('Ereignisstrom /api/v1/events', () => {
  test('mit API-Token: 403 (gehört zur Anmeldung)', async () => {
    const res = await fetch(`${base}/api/v1/events`, { headers: { 'x-token': '1' } })
    assert.equal(res.status, 403)
  })

  test('Ereignisse kommen an; «abgemeldet» beendet den Strom', async () => {
    const res = await fetch(`${base}/api/v1/events`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const hello = await readUntil(res.body!, (t) => t.includes('"hello"'))
    assert.match(hello, /retry: 5000/)
    assert.equal(subscriberCount(), 1)

    publish({ type: 'deploy', deploymentId: 'd1', status: 'pulling' })
    const deploy = await readUntil(res.body!, (t) => t.includes('"deploy"'))
    assert.match(deploy, /"deploymentId":"d1"/)

    publish({ type: 'session_ended' })
    const rest = await readUntil(res.body!, () => false)
    assert.match(rest, /session_ended/)
    assert.equal(subscriberCount(), 0, 'Abonnent nach dem Ende entfernt')
  })
})
