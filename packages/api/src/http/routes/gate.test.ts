import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Zugang «Airlock-Login» über HTTP: check (nur Caddy) → start (Oberfläche,
 * Sitzung) → callback (nur Caddy, setzt den Cookie für genau diesen Host) →
 * check mit Cookie. Ohne Datenbank: Sitzungen, Uhr und Caddy-Erkennung ersetzt.
 */
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { gateRoutes } = await import('./gate.js')
type GateDeps = import('./gate.js').GateDeps

const KEY = 'test-schluessel'
const sign = (d: string) => createHmac('sha256', KEY).update(d).digest('base64url')
let now = Date.UTC(2026, 10, 12, 20, 0, 0)
const sessions = new Map<string, { id: string; expiresAt: Date }>([['s1', { id: 's1', expiresAt: new Date(now + 7 * 86_400_000) }]])
let uiSession: string | null = null
const audits: string[] = []

let app: FastifyInstance
before(async () => {
  app = Fastify()
  const deps: Partial<GateDeps> = {
    now: () => now,
    sign,
    session: async (id) => sessions.get(id) ?? null,
    uiSession: async () => (uiSession ? sessions.get(uiSession) ?? null : null),
    fromCaddy: (r) => r.headers['x-test-from'] === 'caddy',
    isGated: (h) => h === 'sonarr.int.example.ch' || h === 'nas.int.example.ch',
    uiOrigin: () => 'https://deployer.int.example.ch',
    audit: async (e) => { audits.push(`${e.action} ${String(e.params.host)}`) },
  }
  await app.register(async (api) => {
    await api.register(gateRoutes, { deps })
  }, { prefix: '/api/v1' })
  await app.ready()
})
after(() => app.close())

const fromCaddy = (host: string, extra: Record<string, string> = {}) => ({ 'x-test-from': 'caddy', 'x-forwarded-host': host, 'x-forwarded-proto': 'https', ...extra })

/** Kompletter Weg bis zum Cookie für einen Host */
async function login(host: string): Promise<string> {
  uiSession = 's1'
  const start = await app.inject({ url: `/api/v1/gate/start?host=${host}&rd=%2Fseite%3Fx%3D1&proto=https` })
  const loc = new URL(start.headers.location as string)
  const cb = await app.inject({ url: `/api/v1/gate/callback${loc.search}`, headers: fromCaddy(host) })
  assert.equal(cb.statusCode, 302, cb.body)
  return String(cb.headers['set-cookie']).split(';')[0]!
}

describe('Airlock-Login an Projekt-Adressen', () => {
  test('ohne Cookie: 302 zur Anmeldung auf der Oberfläche, mit Host, Pfad und Schema', async () => {
    const r = await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('sonarr.int.example.ch', { 'x-forwarded-uri': '/calendar?d=1' }) })
    assert.equal(r.statusCode, 302)
    const loc = new URL(r.headers.location as string)
    assert.equal(loc.origin, 'https://deployer.int.example.ch')
    assert.equal(loc.pathname, '/api/v1/gate/start')
    assert.equal(loc.searchParams.get('host'), 'sonarr.int.example.ch')
    assert.equal(loc.searchParams.get('rd'), '/calendar?d=1')
  })

  test('start ohne Sitzung: erst zur Anmeldung der Oberfläche, danach weiter', async () => {
    uiSession = null
    const r = await app.inject({ url: '/api/v1/gate/start?host=sonarr.int.example.ch&rd=/x&proto=https' })
    assert.equal(r.statusCode, 302)
    assert.match(r.headers.location as string, /^\/zugang\?weiter=%2Fapi%2Fv1%2Fgate%2Fstart%3F/)
  })

  test('angemeldet: einmaliger Code → Cookie nur für diesen Host, HttpOnly, Secure, SameSite=Lax → zurück zum Pfad', async () => {
    uiSession = 's1'
    const start = await app.inject({ url: '/api/v1/gate/start?host=sonarr.int.example.ch&rd=%2Fcalendar&proto=https' })
    const loc = new URL(start.headers.location as string)
    assert.equal(loc.origin, 'https://sonarr.int.example.ch')
    assert.equal(loc.pathname, '/.airlock/gate')
    const cb = await app.inject({ url: `/api/v1/gate/callback${loc.search}`, headers: fromCaddy('sonarr.int.example.ch') })
    assert.equal(cb.statusCode, 302)
    assert.equal(cb.headers.location, '/calendar')
    const cookie = String(cb.headers['set-cookie'])
    assert.match(cookie, /^airlock_gate=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/)
    assert.doesNotMatch(cookie, /Domain=/i, 'kein Domain-Attribut: nur dieser Host')
    assert.ok(audits.includes('gate.login sonarr.int.example.ch'))
    // Der Code gilt genau einmal
    const again = await app.inject({ url: `/api/v1/gate/callback${loc.search}`, headers: fromCaddy('sonarr.int.example.ch') })
    assert.equal(again.statusCode, 400)
  })

  test('mit Cookie: 204 – aber nur für den eigenen Host', async () => {
    const cookie = await login('sonarr.int.example.ch')
    const ok = await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('sonarr.int.example.ch', { cookie: `andere=1; ${cookie}` }) })
    assert.equal(ok.statusCode, 204)
    const other = await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('nas.int.example.ch', { cookie }) })
    assert.equal(other.statusCode, 302, 'Cookie eines anderen Projekts zählt nicht')
  })

  test('verändertes Token, abgemeldete Sitzung, abgelaufen: wieder zur Anmeldung', async () => {
    const cookie = await login('sonarr.int.example.ch')
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    assert.equal((await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('sonarr.int.example.ch', { cookie: tampered }) })).statusCode, 302)
    // Abgemeldet (Cache von 30 s läuft ab)
    sessions.delete('s1')
    now += 31_000
    assert.equal((await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('sonarr.int.example.ch', { cookie }) })).statusCode, 302)
    sessions.set('s1', { id: 's1', expiresAt: new Date(now + 7 * 86_400_000) })
  })

  test('Code an den Host gebunden: auf einem anderen Host eingelöst → abgelehnt', async () => {
    uiSession = 's1'
    const start = await app.inject({ url: '/api/v1/gate/start?host=sonarr.int.example.ch&rd=/&proto=https' })
    const loc = new URL(start.headers.location as string)
    const cb = await app.inject({ url: `/api/v1/gate/callback${loc.search}`, headers: fromCaddy('nas.int.example.ch') })
    assert.equal(cb.statusCode, 400)
  })

  test('nur Caddy darf check und callback fragen; start nur für geschützte Namen (keine offene Weiterleitung)', async () => {
    assert.equal((await app.inject({ url: '/api/v1/gate/check', headers: { 'x-forwarded-host': 'sonarr.int.example.ch' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/v1/gate/callback?code=x', headers: { 'x-forwarded-host': 'sonarr.int.example.ch' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/v1/gate/check', headers: fromCaddy('fremd.example.com') })).statusCode, 403)
    uiSession = 's1'
    assert.equal((await app.inject({ url: '/api/v1/gate/start?host=boese.example.com&rd=/' })).statusCode, 400)
  })

  test('Rücksprung nur auf einen Pfad desselben Hosts', async () => {
    uiSession = 's1'
    for (const rd of ['//boese.example.com/x', 'https://boese.example.com', '/\\boese.example.com', 'javascript:alert(1)']) {
      const start = await app.inject({ url: `/api/v1/gate/start?host=sonarr.int.example.ch&rd=${encodeURIComponent(rd)}&proto=https` })
      const loc = new URL(start.headers.location as string)
      assert.equal(loc.searchParams.get('rd'), '/', rd)
      const cb = await app.inject({ url: `/api/v1/gate/callback?code=${loc.searchParams.get('code')}&rd=${encodeURIComponent(rd)}`, headers: fromCaddy('sonarr.int.example.ch') })
      assert.equal(cb.headers.location, '/', rd)
    }
  })

  test('http-Adressen (ohne TLS): Cookie ohne Secure', async () => {
    uiSession = 's1'
    const start = await app.inject({ url: '/api/v1/gate/start?host=nas.int.example.ch&rd=/&proto=http' })
    const loc = new URL(start.headers.location as string)
    assert.equal(loc.protocol, 'http:')
    const cb = await app.inject({ url: `/api/v1/gate/callback${loc.search}`, headers: fromCaddy('nas.int.example.ch', { 'x-forwarded-proto': 'http' }) })
    assert.doesNotMatch(String(cb.headers['set-cookie']), /Secure/)
  })
})
