import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'

// events.ts zieht über auth.ts config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { eventRoutes } = await import('./events.js')
const { publish, subscriberCount, closeAllStreams } = await import('../../lib/events.js')

/**
 * UI-Qualität 3: GET /api/v1/events. Die Anmeldung prüft der Auth-Wächter
 * (auth.test.ts); hier: Token abgelehnt, Ereignisse kommen an, Abmelden
 * betrifft nur dieselbe Sitzung, der Herzschlag prüft die Sitzung, und
 * Herunterfahren schliesst offene Ströme.
 */
const apps: FastifyInstance[] = []
after(async () => { for (const a of apps) await a.close() })

async function start(heartbeatMs: number): Promise<{ app: FastifyInstance; base: string }> {
  const app = Fastify()
  await app.register(cookie, { secret: 'test-geheimnis-test-geheimnis-123' })
  app.decorateRequest('actor', '')
  app.decorateRequest('tokenId', null)
  // Stellvertretend für den Auth-Wächter: «x-token» spielt einen API-Token
  app.addHook('onRequest', async (request) => {
    request.tokenId = request.headers['x-token'] ? 't1' : null
  })
  await app.register(eventRoutes, { prefix: '/api/v1', heartbeatMs })
  app.addHook('preClose', async () => closeAllStreams())
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  const addr = app.server.address()
  return { app, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }
}

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
    const { base } = await start(60_000)
    const res = await fetch(`${base}/api/v1/events`, { headers: { 'x-token': '1' } })
    assert.equal(res.status, 403)
  })

  test('Ereignisse kommen an; Abmelden einer anderen Sitzung lässt den Strom offen, der eigenen schliesst ihn', async () => {
    const { base } = await start(60_000)
    const res = await fetch(`${base}/api/v1/events`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const hello = await readUntil(res.body!, (t) => t.includes('"hello"'))
    assert.match(hello, /retry: 5000/)
    assert.equal(subscriberCount(), 1)

    publish({ type: 'deploy', deploymentId: 'd1', status: 'pulling', projectId: 'p1' })
    assert.match(await readUntil(res.body!, (t) => t.includes('"deploy"')), /"projectId":"p1"/)

    // Andere Sitzung (anderes Gerät) meldet sich ab: dieser Strom (hier ohne Sitzung) bleibt
    publish({ type: 'session_ended', session: 'andere-sitzung' })
    publish({ type: 'cert' })
    assert.match(await readUntil(res.body!, (t) => t.includes('"cert"')), /"cert"/)
    assert.equal(subscriberCount(), 1)

    publish({ type: 'session_ended', session: null })
    assert.match(await readUntil(res.body!, () => false), /session_ended/)
    assert.equal(subscriberCount(), 0, 'Abonnent nach dem Ende entfernt')
  })

  test('Herzschlag prüft die Sitzung: ohne gültige Anmeldung endet der Strom', async () => {
    const { base } = await start(50)
    const res = await fetch(`${base}/api/v1/events`)
    assert.match(await readUntil(res.body!, () => false), /session_ended/)
    assert.equal(subscriberCount(), 0)
  })

  test('Herunterfahren schliesst offene Ströme (app.close wartet nicht ewig)', async () => {
    const { app, base } = await start(60_000)
    const res = await fetch(`${base}/api/v1/events`)
    await readUntil(res.body!, (t) => t.includes('"hello"'))
    const t0 = Date.now()
    await app.close()
    assert.ok(Date.now() - t0 < 2_000, 'app.close() hing')
    assert.equal(subscriberCount(), 0)
  })
})
