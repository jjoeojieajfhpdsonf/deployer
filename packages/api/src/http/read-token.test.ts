import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import type { ProjectDto, SummaryDto } from '@airlock/shared'

/**
 * Abgrenzung HomeBento: ein Token mit Umfang «lesen» (für Dashboards) kommt
 * nur an GET /api/v1/summary. Geprüft an der echten App über JEDE registrierte
 * Route und jede Methode: alles andere antwortet 403, bevor ein Handler läuft –
 * also kann das Token nichts ändern und nichts Geheimes lesen (Env, Logs,
 * Backup, Tokens, Befund-Texte …). MCP lehnt es ebenfalls ab.
 */
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
process.env.SESSION_SECRET = 'test-geheimnis-test-geheimnis-123' // allowlist-secret (Testwert)
process.env.NODE_ENV = 'test'

const { buildApp, registeredRoutes } = await import('./app.js')
const { readTokenAllows, OPEN_ROUTES } = await import('./auth.js')
const { setTokenVerifier } = await import('../domain/tokens.js')
const { summaryRoutes } = await import('./routes/summary.js')

const READ = 'dpl_' + 'r'.repeat(43)
const FULL = 'dpl_' + 'f'.repeat(43)
const ENV = '00000000-0000-4000-8000-000000000001'

let app: FastifyInstance
before(async () => {
  setTokenVerifier(async (raw) =>
    raw === READ ? { id: 't-lesen', name: 'HomeBento', environmentId: ENV, scope: 'lesen' }
      : raw === FULL ? { id: 't-voll', name: 'Skript', environmentId: ENV, scope: 'voll' }
        : null)
  app = await buildApp()
  await app.ready()
})
after(async () => {
  await app.close()
  setTokenVerifier(null)
})

const routeUrl = (pattern: string) => pattern
  .replace(/:id\b/g, '0b8f3b0e-6c1a-4e5b-9a7d-2f4c1e9d8a77')
  .replace(/:env\b/g, 'privat')
  .replace(/:[A-Za-z]+/g, 'x')
  .replace(/\*$/, 'x')

describe('Token «lesen»: Erlaubnisliste', () => {
  test('nur GET auf /summary', () => {
    assert.equal(readTokenAllows('GET', '/api/v1/summary'), true)
    assert.equal(readTokenAllows('GET', '/api/v1/environments/:env/summary'), true)
    assert.equal(readTokenAllows('POST', '/api/v1/summary'), false)
    assert.equal(readTokenAllows('GET', '/api/v1/projects'), false)
    assert.equal(readTokenAllows('GET', '/api/v1/summary/'), false)
  })

  test('jede andere Route der App (alle Methoden) → 403, bevor ein Handler läuft', async () => {
    const api = registeredRoutes.filter((r) => r.url.startsWith('/api/') && !OPEN_ROUTES.has(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS')
    assert.ok(api.length > 100, `zu wenige Routen gefunden: ${api.length}`)
    let checked = 0
    for (const r of api) {
      if (readTokenAllows(r.method, r.url)) continue
      const res = await app.inject({ method: r.method as 'GET', url: routeUrl(r.url), headers: { authorization: `Bearer ${READ}` }, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} })
      assert.equal(res.statusCode, 403, `${r.method} ${r.url} → ${res.statusCode}: ${res.body.slice(0, 200)}`)
      assert.match(res.body, /nur lesen/, `${r.method} ${r.url}`)
      checked++
    }
    assert.ok(checked > 100)
  })

  test('die Summary-Routen sind registriert und kommen am Wächter vorbei', async () => {
    const known = new Set(registeredRoutes.map((r) => `${r.method} ${r.url}`))
    assert.ok(known.has('GET /api/v1/summary'))
    assert.ok(known.has('GET /api/v1/environments/:env/summary'))
    // Ohne Datenbank scheitert erst der Handler (500) – entscheidend: kein 401/403 vom Wächter
    const res = await app.inject({ url: '/api/v1/summary', headers: { authorization: `Bearer ${READ}` } })
    assert.notEqual(res.statusCode, 401)
    assert.notEqual(res.statusCode, 403, res.body)
  })

  test('MCP lehnt das Token ab', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${READ}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } },
    })
    assert.equal(res.statusCode, 403, res.body)
    assert.match(res.body, /nur lesen/)
  })

  test('ein volles Token bleibt wie bisher (kein 403 «nur lesen»)', async () => {
    const res = await app.inject({ url: '/api/v1/projects', headers: { authorization: `Bearer ${FULL}` } })
    assert.doesNotMatch(res.body, /nur lesen/)
  })

  test('ein Token «lesen» kann kein Token anlegen (auch nicht «voll»)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tokens', headers: { authorization: `Bearer ${READ}` }, payload: { name: 'mehr', scope: 'voll' } })
    assert.equal(res.statusCode, 403)
  })
})

/* --- Inhalt der Antwort: nichts Geheimes ---------------------------------------------- */

const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: 'p1', name: 'Fotoalbum', slug: 'foto', sourceType: 'git',
  source: { type: 'git', repoUrl: 'https://user:ghp_GEHEIM@github.com/me/foto.git' } as unknown as ProjectDto['source'],
  port: 8080, healthcheckPath: '/', status: 'running', desiredState: 'running', keep: false, showOnStatus: 'auto',
  egress: { mode: 'beobachten', enforce: false } as unknown as ProjectDto['egress'],
  cpuLimit: 1, memoryLimitMb: 512, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  routes: [
    { target: 'lan', targets: ['lan', 'tailnet'], hostname: 'foto.int.example.ch', aliases: [], urls: ['https://foto.int.example.ch'] },
    { target: 'public', hostname: 'foto.example.ch', aliases: [], urls: ['https://foto.example.ch'] },
  ],
  activeDeployment: null, runsAsRoot: null, runtimeKind: 'container', filesKind: null,
  lastChangeAt: '2026-11-01T00:00:00Z', expiresAt: null, expiryDays: null,
  security: { scanId: 's1', status: 'done', score: 82, grade: 'B', finishedAt: '2026-11-10T00:00:00Z', open: { critical: 0, high: 2, medium: 1, low: 4 } } as ProjectDto['security'],
  lastDeployment: { id: 'd1', status: 'failed', startedAt: '2026-11-12T19:00:00Z', errorMessage: 'DATABASE_URL=postgres://geheim' } as unknown as ProjectDto['lastDeployment'],
  legacyContainers: false,
  state: { key: 'running', label: 'läuft', tone: 'ok', detail: 'seit 3 Tagen' },
  ...over,
} as ProjectDto)

describe('GET /summary: Inhalt', () => {
  let small: FastifyInstance
  before(async () => {
    small = Fastify()
    small.decorateRequest('scope', null as never)
    await small.register(async (api) => {
      await api.register(summaryRoutes, {
        deps: {
          projects: async () => ({
            environment: 'Privat',
            projects: [
              project(),
              project({ id: 'p2', name: 'Wetter', slug: 'wetter', sourceType: 'external', routes: [], security: null, state: { key: 'deploying', label: 'deployt gerade', tone: 'info', detail: null } }),
            ],
          }),
          visitors: async () => ({ p1: 42, fremd: 7 }),
          ingest: () => 'ok',
          uptime: async () => new Map([['p1', { h24: 100, d30: 99.5 }]]),
          certificate: async () => ({ expiresAt: '2027-01-20T00:00:00Z', daysLeft: 69 }),
          now: () => new Date('2026-11-12T20:00:00Z'),
        },
      })
    }, { prefix: '/api/v1' })
    await small.ready()
  })
  after(() => small.close())

  test('Felder je Projekt und Summen', async () => {
    const s = (await small.inject({ url: '/api/v1/summary' })).json() as SummaryDto
    assert.equal(s.environment, 'Privat')
    const foto = s.projects.find((p) => p.id === 'p1')!
    assert.deepEqual(foto, {
      id: 'p1', slug: 'foto', name: 'Fotoalbum', kind: 'managed',
      state: { key: 'running', label: 'läuft', tone: 'ok' },
      url: 'https://foto.example.ch', public: true, grade: 'B',
      findings: { critical: 0, high: 2, medium: 1, low: 4 },
      attention: true, attentionReason: '2 hohe Befunde', attentionTone: 'bad',
      visitorsToday: 42, uptime24h: 100, uptime30d: 99.5,
      certificateExpiresAt: '2027-01-20T00:00:00Z', deploying: false,
    })
    const wetter = s.projects.find((p) => p.id === 'p2')!
    // Bestehender Dienst: für HomeBento als external gekennzeichnet
    assert.equal(wetter.kind, 'external')
    assert.equal(wetter.url, null)
    assert.equal(wetter.visitorsToday, null, 'ohne Adresse keine Besucherzahl')
    assert.equal(wetter.certificateExpiresAt, null)
    assert.equal(wetter.deploying, true)
    assert.deepEqual(s.deploying.map((d) => d.projectId), ['p2'])
    assert.deepEqual(s.totals, { projects: 2, running: 1, attention: 1, public: 1, findings: { critical: 0, high: 2, medium: 1, low: 4 }, visitorsToday: 42 })
  })

  test('nichts Geheimes: keine Quelle, keine Fehlermeldung, kein Detail, nichts aus fremden Projekten', async () => {
    const body = (await small.inject({ url: '/api/v1/summary' })).body
    for (const secret of ['ghp_GEHEIM', 'repoUrl', 'postgres://', 'errorMessage', 'seit 3 Tagen', 'fremd', 'memoryLimitMb', 'healthcheckPath']) {
      assert.ok(!body.includes(secret), `enthält ${secret}`)
    }
  })
})
