import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import type { TrafficLiveEventDto, TrafficSummaryDto } from '@airlock/shared'
import type { TrafficRouteDeps } from './traffic.js'

// traffic.ts zieht über die Service-Schicht config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { trafficRoutes } = await import('./traffic.js')
const { closeAllStreams } = await import('../../lib/events.js')
const { AppError } = await import('../../lib/errors.js')

/**
 * Etappe 3: Routen der Besucher-Auswertung ohne Datenbank (Abhängigkeiten
 * ersetzt). Geprüft: Parameter, Live-Strom (Format, Abmelden), Aufrufe heute
 * nur für sichtbare Projekte.
 */

const listeners = new Map<string, Set<(e: TrafficLiveEventDto) => void>>()
const emit = (id: string, e: TrafficLiveEventDto) => { for (const f of listeners.get(id) ?? []) f(e) }
const asked: unknown[][] = []

const apps: FastifyInstance[] = []
after(async () => { for (const a of apps) await a.close() })

async function start(): Promise<string> {
  const app = Fastify()
  app.decorateRequest('actor', '')
  app.addHook('preClose', async () => closeAllStreams())
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500
    void reply.status(status).send({ error: (err as Error).message })
  })
  const deps: Partial<TrafficRouteDeps> = {
      findProject: async (_r, id) => {
        if (id !== 'p1' && id !== 'foto') throw new AppError('not_found', 'Projekt nicht gefunden', 404)
        return { id: 'p1' }
      },
      summary: async (...args) => {
        asked.push(args)
        return { range: args[1], way: args[2] } as unknown as TrafficSummaryDto
      },
      onLive: (id, fn) => {
        const set = listeners.get(id) ?? new Set()
        set.add(fn)
        listeners.set(id, set)
        return () => set.delete(fn)
      },
      visibleProjects: async () => new Set(['p1', 'p2']),
      today: async () => ({ p1: 214, p2: 0, fremd: 99 }),
  }
  await app.register(trafficRoutes, { prefix: '/api/v1', heartbeatMs: 60_000, deps })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  const addr = app.server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
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

describe('Routen /projects/:id/traffic', () => {
  test('Standard 24h über alle Wege; Zeitraum und Zugang wählbar; Unsinn → 400', async () => {
    const base = await start()
    assert.deepEqual(await (await fetch(`${base}/api/v1/projects/foto/traffic`)).json(), { range: '24h', way: 'all' })
    assert.deepEqual(await (await fetch(`${base}/api/v1/projects/foto/traffic?range=30d&way=public`)).json(), { range: '30d', way: 'public' })
    assert.deepEqual(asked.at(-1), ['p1', '30d', 'public'])
    assert.equal((await fetch(`${base}/api/v1/projects/foto/traffic?range=1y`)).status, 400)
    assert.equal((await fetch(`${base}/api/v1/projects/foto/traffic?way=vpn`)).status, 400)
    assert.equal((await fetch(`${base}/api/v1/projects/gibtsnicht/traffic`)).status, 404)
  })

  test('Live-Strom: SSE, je Anfrage eine data-Zeile mit {at, access, host, service, status, blocked, bot}; Abmelden beim Schliessen', async () => {
    const base = await start()
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v1/projects/foto/traffic/live`, { signal: ctrl.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    await readUntil(res.body!, (t) => t.includes(': verbunden'))
    const e: TrafficLiveEventDto = { at: '2026-11-11T14:30:00.000Z', access: 'public', host: 'foto.example.ch', service: 'web', status: 200, blocked: false, bot: false }
    emit('p1', e)
    emit('p2', { ...e, host: 'anderes.example.ch' })
    emit('p1', { ...e, status: 403, blocked: true, service: null, access: 'lan' })
    const text = await readUntil(res.body!, (t) => (t.match(/^data: /gm) ?? []).length >= 2)
    const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as TrafficLiveEventDto)
    assert.deepEqual(events[0], e)
    assert.equal(events[1]!.blocked, true)
    assert.ok(events.every((x) => x.host !== 'anderes.example.ch'))
    assert.deepEqual(Object.keys(events[0]!).sort(), ['access', 'at', 'blocked', 'bot', 'host', 'service', 'status'])
    ctrl.abort()
    for (let i = 0; i < 50 && (listeners.get('p1')?.size ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(listeners.get('p1')?.size ?? 0, 0)
  })

  test('Aufrufe heute: nur Projekte, die die Anfrage sehen darf', async () => {
    const base = await start()
    assert.deepEqual(await (await fetch(`${base}/api/v1/traffic/today`)).json(), { views: { p1: 214, p2: 0 } })
  })
})
