import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { IncidentDto, StatusPageDto } from '@airlock/shared'
import type { StatusRouteDeps } from './status.js'

// status.ts zieht über die Service-Schicht config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { statusRoutes } = await import('./status.js')
const { AppError } = await import('../../lib/errors.js')

/**
 * Etappe 5: Routen der Statusseite ohne Datenbank (Abhängigkeiten ersetzt).
 * Geprüft: Umgebung aus dem Pfad, Eingaben (Zod → 400), Statuscodes, die
 * Störung im Pfad geht unverändert an die Service-Schicht (die prüft, dass
 * sie zur Umgebung gehört – sonst 404).
 */

const calls: unknown[][] = []
const page: StatusPageDto = { enabled: true, title: 'Status', hostname: 'status.example.ch', publicReady: true, problem: null, writtenAt: null, storage: true, projects: [] }
const incidents: IncidentDto[] = []

const apps: FastifyInstance[] = []
after(async () => { for (const a of apps) await a.close() })

async function start(): Promise<string> {
  const app = Fastify()
  app.decorateRequest('actor', '')
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof AppError ? err.status : err instanceof ZodError ? 400 : 500
    void reply.status(status).send({ error: (err as Error).message })
  })
  const deps: Partial<StatusRouteDeps> = {
    envOf: (request) => {
      const env = (request.params as { env: string }).env
      if (env !== 'example') throw new AppError('not_found', 'Umgebung nicht gefunden', 404)
      return 'env-1'
    },
    page: async (envId) => { calls.push(['page', envId]); return page },
    setSettings: async (envId, input, actor) => { calls.push(['set', envId, input, actor]); return { ...page, ...input } },
    incidents: async (envId) => { calls.push(['list', envId]); return incidents },
    create: async (envId, input, actor) => { calls.push(['create', envId, input, actor]); return incidents },
    update: async (envId, id, input) => {
      calls.push(['update', envId, id, input])
      if (id !== 'i-1') throw new AppError('not_found', 'Störung nicht gefunden', 404)
      return incidents
    },
    remove: async (envId, id) => { calls.push(['remove', envId, id]); return incidents },
  }
  await app.register(statusRoutes, { prefix: '/api/v1', deps })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  const addr = app.server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('Routen /environments/:env/status-page und /incidents', () => {
  test('Einstellungen lesen und ändern; unbekannte Umgebung 404; Unsinn 400', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/v1/environments/example/status-page`)
    assert.equal(r.status, 200)
    assert.equal(((await r.json()) as { statusPage: StatusPageDto }).statusPage.hostname, 'status.example.ch')
    assert.equal((await fetch(`${base}/api/v1/environments/fremd/status-page`)).status, 404)
    const put = await send(`${base}/api/v1/environments/example/status-page`, 'PUT', { enabled: false, title: '  Mein Status ' })
    assert.equal(put.status, 200)
    assert.deepEqual(calls.at(-1), ['set', 'env-1', { enabled: false, title: 'Mein Status' }, 'ui:joel'])
    assert.equal((await send(`${base}/api/v1/environments/example/status-page`, 'PUT', { title: '' })).status, 400)
    assert.equal((await send(`${base}/api/v1/environments/example/status-page`, 'PUT', { enabled: 'ja' })).status, 400)
  })

  test('Störung melden: 201, Zustand Standard «untersucht»; ohne Titel oder mit falschem Zustand 400', async () => {
    const base = await start()
    const ok = await send(`${base}/api/v1/environments/example/incidents`, 'POST', { title: 'Mail langsam', body: 'Wir prüfen es.' })
    assert.equal(ok.status, 201)
    assert.deepEqual(calls.at(-1), ['create', 'env-1', { title: 'Mail langsam', body: 'Wir prüfen es.', state: 'untersucht', projectIds: [] }, 'ui:joel'])
    assert.equal((await send(`${base}/api/v1/environments/example/incidents`, 'POST', { body: 'x' })).status, 400)
    assert.equal((await send(`${base}/api/v1/environments/example/incidents`, 'POST', { title: 'x', body: 'y', state: 'kaputt' })).status, 400)
    assert.equal((await send(`${base}/api/v1/environments/example/incidents`, 'POST', { title: 'x', body: 'y', projectIds: ['keine-uuid'] })).status, 400)
  })

  test('Update und Löschen mit der Störung aus dem Pfad; fremde Störung 404', async () => {
    const base = await start()
    const up = await send(`${base}/api/v1/environments/example/incidents/i-1/updates`, 'POST', { state: 'behoben', body: 'Läuft wieder.' })
    assert.equal(up.status, 200)
    assert.deepEqual(calls.at(-1), ['update', 'env-1', 'i-1', { state: 'behoben', body: 'Läuft wieder.' }])
    assert.equal((await send(`${base}/api/v1/environments/example/incidents/i-2/updates`, 'POST', { state: 'behoben', body: 'x' })).status, 404)
    assert.equal((await send(`${base}/api/v1/environments/example/incidents/i-1/updates`, 'POST', { state: 'behoben', body: '' })).status, 400)
    const del = await send(`${base}/api/v1/environments/example/incidents/i-1`, 'DELETE')
    assert.equal(del.status, 200)
    assert.deepEqual(calls.at(-1), ['remove', 'env-1', 'i-1'])
    assert.equal((await fetch(`${base}/api/v1/environments/example/incidents`)).status, 200)
  })
})
