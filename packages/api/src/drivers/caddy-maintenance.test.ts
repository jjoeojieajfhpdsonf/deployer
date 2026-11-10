import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, MAINTENANCE_HEADER, MAINTENANCE_HTML, MAINTENANCE_VALUE, type RouteSpec } from './caddy-config.js'

const opts = { ipFilter: true, cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock' }

type R = { match?: { host: string[]; remote_ip?: { ranges: string[] } }[]; handle: Record<string, unknown>[] }
type Cfg = { apps: { http: { servers: { srv0: { routes: R[] } } } } }

const paused: RouteSpec = { hosts: ['haushalt.example.ch'], kind: 'maintenance', cidrs: ['172.30.0.5/32'] }

describe('Wartungsseite (öffentlich pausiert)', () => {
  const routes = (buildCaddyConfig([paused], opts) as unknown as Cfg).apps.http.servers.srv0.routes
  const r = routes.find((x) => x.match?.[0]?.host.includes('haushalt.example.ch'))!

  test('antwortet mit 503, Retry-After und Kennung', () => {
    assert.ok(r, 'Route für den pausierten Namen fehlt')
    const h = r.handle[0] as { handler: string; status_code: number; headers: Record<string, string[]>; body: string }
    assert.equal(h.handler, 'static_response')
    assert.equal(h.status_code, 503)
    assert.deepEqual(h.headers[MAINTENANCE_HEADER], [MAINTENANCE_VALUE])
    assert.deepEqual(h.headers['Retry-After'], ['3600'])
    assert.deepEqual(h.headers['Cache-Control'], ['no-store'])
    assert.equal(h.body, MAINTENANCE_HTML)
  })

  test('nur aus dem Netz von cloudflared, wie die Live-Route', () => {
    assert.deepEqual(r.match?.[0]?.remote_ip?.ranges, ['172.30.0.5/32'])
  })

  test('die Seite ist neutral: kein Projektname, kein deployer, kein Platzhalter', () => {
    assert.doesNotMatch(MAINTENANCE_HTML, /deployer|haushalt/i)
    // Caddy ersetzt bekannte Platzhalter im Body; keiner darf vorkommen
    assert.doesNotMatch(MAINTENANCE_HTML, /\{(http|env|file|system|time)\./)
    assert.match(MAINTENANCE_HTML, /<html lang="de">/)
  })

  test('kein Upstream, kein Dateiserver', () => {
    assert.equal(r.handle.length, 1)
    assert.ok(!JSON.stringify(r.handle).includes('reverse_proxy'))
  })
})
