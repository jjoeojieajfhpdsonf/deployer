import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'

// app.ts zieht config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { acceptEmptyJson } = await import('./app.js')

let app: FastifyInstance

before(async () => {
  app = Fastify()
  acceptEmptyJson(app)
  app.post('/echo', async (request) => ({ body: request.body ?? null }))
  await app.ready()
})
after(() => app.close())

const post = (payload: string | undefined, json = true) =>
  app.inject({ method: 'POST', url: '/echo', headers: json ? { 'content-type': 'application/json' } : {}, ...(payload !== undefined ? { payload } : {}) })

describe('JSON-Body: leer erlaubt (Tunnel-Schritt: POST ohne Body)', () => {
  test('Content-Type JSON ohne Body → {}', async () => {
    const r = await post(undefined)
    assert.equal(r.statusCode, 200)
    assert.deepEqual(r.json(), { body: {} })
  })

  test('nur Leerzeichen → {}', async () => {
    assert.deepEqual((await post('  \n')).json(), { body: {} })
  })

  test('normaler Body wird geparst', async () => {
    assert.deepEqual((await post('{"a":1}')).json(), { body: { a: 1 } })
  })

  test('kaputtes JSON → 400', async () => {
    assert.equal((await post('{nein')).statusCode, 400)
  })

  test('__proto__ wird abgewiesen', async () => {
    assert.equal((await post('{"__proto__":{"x":1}}')).statusCode, 400)
  })

  test('ohne Content-Type und ohne Body geht weiter', async () => {
    assert.equal((await post(undefined, false)).statusCode, 200)
  })
})
