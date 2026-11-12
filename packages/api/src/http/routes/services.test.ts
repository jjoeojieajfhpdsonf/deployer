import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { ServiceRouteDeps } from './services.js'
import type { ChangeRow, ServiceDeps } from '../../domain/services.js'

// services.ts zieht über die Domäne config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { serviceRoutes } = await import('./services.js')
const { AppError } = await import('../../lib/errors.js')
const { composeBase } = await import('../../lib/compose-edit.js')

/**
 * Etappe 4: Routen «Dienst hinzufügen/entfernen» ohne Datenbank (Abhängigkeiten
 * ersetzt). Geprüft: Vorschau, Übernehmen, Eingaben, Volume löschen nur mit
 * Anmeldung, Ausblenden, fremdes Projekt.
 */

const COMPOSE = 'services:\n  web:\n    image: a\n  db:\n    image: postgres:17\n    volumes: ["db-data:/var/lib/postgresql/data"]\nvolumes:\n  db-data: {}\n'
const apps: FastifyInstance[] = []
after(async () => { for (const a of apps) await a.close() })
const dismissed: string[] = []
const writes: string[] = []

function fakeDeps(): ServiceDeps {
  return {
    source: async () => ({
      way: 'deploy', path: 'compose.yaml', text: COMPOSE, branch: null,
      write: async (o) => { writes.push(o.text); return { deploymentId: 'dep-1' } },
    }),
    webService: 'web',
    env: async () => ({}),
    addEnv: async () => {},
    newId: () => 'c1',
    insert: async (row) => ({ ...row, projectId: 'p1', createdAt: new Date(), updatedAt: new Date(), dismissedAt: null }) as ChangeRow,
    watch: () => {},
    audit: async () => {},
    password: () => 'x'.repeat(32),
  }
}

async function start(token = false): Promise<string> {
  const app = Fastify()
  app.decorateRequest('tokenId', null)
  if (token) app.addHook('onRequest', async (req) => { (req as { tokenId: string | null }).tokenId = 't1' })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return void reply.status(400).send({ error: err.issues[0]?.message })
    const status = err instanceof AppError ? err.status : 500
    void reply.status(status).send({ error: (err as Error).message })
  })
  const deps: Partial<ServiceRouteDeps> = {
    findProject: async (_r, id) => {
      if (id !== 'p1') throw new AppError('not_found', 'Projekt nicht gefunden', 404)
      return { id: 'p1' } as never
    },
    deps: fakeDeps,
    dismiss: async (_p, id) => { dismissed.push(id) },
    actor: () => 'ui:joel',
  }
  await app.register(serviceRoutes, { prefix: '/api/v1', deps })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  const addr = app.server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('Routen «Dienst hinzufügen/entfernen»', () => {
  test('Vorschau liefert den Plan', async () => {
    const base = await start()
    const res = await post(`${base}/api/v1/projects/p1/services/plan`, { action: 'add', template: 'redis', name: 'cache', connect: ['web'] })
    assert.equal(res.status, 200)
    const { plan } = (await res.json()) as { plan: { diff: string; variables: { key: string }[] } }
    assert.match(plan.diff, /\+ {2}cache:/)
    assert.deepEqual(plan.variables.map((v) => v.key), ['CACHE_PASSWORD', 'REDIS_URL'])
  })

  test('ungültige Eingabe: 400', async () => {
    const base = await start()
    assert.equal((await post(`${base}/api/v1/projects/p1/services/plan`, { action: 'add', template: 'oracle', name: 'db' })).status, 400)
    assert.equal((await post(`${base}/api/v1/projects/p1/services/plan`, { action: 'add', template: 'redis', name: 'Cache!' })).status, 400)
    assert.equal((await post(`${base}/api/v1/projects/p1/services`, { change: { action: 'remove', name: 'db' } })).status, 400)
  })

  test('fremdes Projekt: 404', async () => {
    const base = await start()
    assert.equal((await post(`${base}/api/v1/projects/p2/services/plan`, { action: 'remove', name: 'db' })).status, 404)
  })

  test('Übernehmen: Änderung mit Deploy', async () => {
    const base = await start()
    const res = await post(`${base}/api/v1/projects/p1/services`, { change: { action: 'remove', name: 'db' }, base: composeBase(COMPOSE) })
    assert.equal(res.status, 200)
    const { change } = (await res.json()) as { change: { status: string; deploymentId: string } }
    assert.deepEqual([change.status, change.deploymentId], ['deploying', 'dep-1'])
  })

  test('Volume löschen mit Token: 403, nichts geschrieben', async () => {
    const base = await start(true)
    const before = writes.length
    const res = await post(`${base}/api/v1/projects/p1/services`, { change: { action: 'remove', name: 'db', dropVolume: true }, base: composeBase(COMPOSE) })
    assert.equal(res.status, 403)
    assert.equal(writes.length, before)
  })

  test('Ausblenden: 204', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/v1/projects/p1/service-changes/c9`, { method: 'DELETE' })
    assert.equal(res.status, 204)
    assert.deepEqual(dismissed, ['c9'])
  })
})
