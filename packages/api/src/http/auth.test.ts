import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'

// auth.ts zieht config.ts nach; für den Import genügt eine Dummy-Umgebung.
// Die Datenbank wird nur bei Bearer-Tokens angefasst, die hier nicht vorkommen.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { registerAuthGuard } = await import('./auth.js')

let app: FastifyInstance

before(async () => {
  app = Fastify()
  await app.register(cookie, { secret: 'test-geheimnis-test-geheimnis-123' })
  registerAuthGuard(app)
  app.get('/api/v1/projects', async () => ({ geheim: true }))
  app.post('/api/v1/projects', async () => ({ angelegt: true }))
  app.get('/api/v1/tokens', async () => ({ tokens: [] }))
  app.post('/api/v1/auth/login', async () => ({ ok: true }))
  app.post('/api/v1/auth/unlocks', async () => ({ theme: 'system', unlocks: ['win95'] }))
  app.get('/health', async () => ({ ok: true }))
  await app.ready()
})
after(() => app.close())

describe('Auth-Wächter (REVIEW M3: Prozentkodierung)', () => {
  test('ohne Anmeldung 401', async () => {
    assert.equal((await app.inject({ url: '/api/v1/projects' })).statusCode, 401)
  })

  for (const url of ['/%61pi/v1/projects', '/api/%76%31/projects', '/api/v1/%70rojects', '/API/v1/projects'.toLowerCase(), '/%61%70%69/v1/projects']) {
    test(`kodierter Pfad ${url} kommt nicht ohne Anmeldung durch`, async () => {
      const r = await app.inject({ url })
      assert.ok(r.statusCode === 401 || r.statusCode === 404, `${url} -> ${r.statusCode}: ${r.body}`)
      assert.ok(!r.body.includes('geheim'))
    })
  }

  test('auch POST nicht', async () => {
    const r = await app.inject({ method: 'POST', url: '/%61pi/v1/projects', payload: {} })
    assert.ok(r.statusCode === 401 || r.statusCode === 404, String(r.statusCode))
  })

  test('Freischalten (POST /auth/unlocks) nur mit Anmeldung', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/unlocks', payload: { id: 'win95' } })).statusCode, 401)
  })

  test('offene Pfade bleiben offen', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode, 200)
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200)
  })
})
