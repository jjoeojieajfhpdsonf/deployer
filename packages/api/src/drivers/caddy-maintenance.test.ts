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

  test('antwortet mit 503 und Kennung; ohne «zurück um» kein Retry-After', () => {
    assert.ok(r, 'Route für den pausierten Namen fehlt')
    const h = r.handle[0] as { handler: string; status_code: number; headers: Record<string, string[]>; body: string }
    assert.equal(h.handler, 'static_response')
    assert.equal(h.status_code, 503)
    assert.deepEqual(h.headers[MAINTENANCE_HEADER], [MAINTENANCE_VALUE])
    assert.equal(h.headers['Retry-After'], undefined)
    assert.deepEqual(h.headers['Cache-Control'], ['no-store'])
    assert.deepEqual(h.headers['X-Robots-Tag'], ['noindex'])
    assert.deepEqual(h.headers['Content-Security-Policy'], ["default-src 'none'; style-src 'unsafe-inline'"])
    assert.equal(h.body, MAINTENANCE_HTML)
  })

  test('eigene Seite des Projekts mit «zurück um»: Text und Retry-After', () => {
    const custom: RouteSpec = {
      ...paused,
      pause: { page: { mode: 'form', lang: 'de', title: 'Umzug', message: 'Wir ziehen **um**.', linkText: '', linkUrl: '', contact: '' }, backAt: '2026-11-11T07:00:00Z', timeZone: 'Europe/Zurich' },
    }
    const rr = (buildCaddyConfig([custom], { ...opts, now: Date.parse('2026-11-10T19:00:00Z') }) as unknown as Cfg).apps.http.servers.srv0.routes
      .find((x) => x.match?.[0]?.host.includes('haushalt.example.ch'))!
    const h = rr.handle[0] as { headers: Record<string, string[]>; body: string }
    assert.match(h.body, /<h1>Umzug<\/h1>/)
    assert.match(h.body, /<strong>um<\/strong>/)
    assert.match(h.body, /Voraussichtlich zurück/)
    assert.deepEqual(h.headers['Retry-After'], ['Wed, 11 Nov 2026 07:00:00 GMT'])
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

describe('Pause-Seite im Code-Modus', () => {
  const html = '<!doctype html><html><body>{file./run/caddy-secrets/cloudflare_token} {env.HOME}</body></html>'
  const code: RouteSpec = {
    ...paused,
    pause: { page: { mode: 'code', lang: 'de', title: 'Eigen', message: 'x', html }, backAt: '2026-11-11T07:00:00Z', root: '/srv/sites/_pause/verein' },
  }
  const rr = (buildCaddyConfig([code], { ...opts, now: Date.parse('2026-11-10T19:00:00Z') }) as unknown as Cfg).apps.http.servers.srv0.routes
    .find((x) => x.match?.[0]?.host.includes('haushalt.example.ch'))!

  test('als Datei über file_server mit 503 – nie im Body der Konfiguration (Caddy-Platzhalter)', () => {
    const types = rr.handle.map((h) => h.handler)
    assert.deepEqual(types, ['headers', 'rewrite', 'file_server'])
    const fs = rr.handle[2] as { root: string; status_code: number }
    assert.equal(fs.root, '/srv/sites/_pause/verein')
    assert.equal(fs.status_code, 503)
    assert.doesNotMatch(JSON.stringify(rr), /caddy-secrets|env\.HOME/)
  })

  test('dieselben Header wie im Formular-Modus, Typ setzt file_server', () => {
    const h = (rr.handle[0] as { response: { set: Record<string, string[]> } }).response.set
    assert.deepEqual(h['Content-Security-Policy'], ["default-src 'none'; style-src 'unsafe-inline'"])
    assert.deepEqual(h['X-Robots-Tag'], ['noindex'])
    assert.deepEqual(h['Cache-Control'], ['no-store'])
    assert.deepEqual(h['X-Airlock-State'], ['paused'])
    assert.deepEqual(h['Retry-After'], ['Wed, 11 Nov 2026 07:00:00 GMT'])
    assert.equal(h['Content-Type'], undefined)
  })

  test('ohne geschriebene Datei (root fehlt): sicherer Rückfall aufs Formular', () => {
    const noRoot: RouteSpec = { ...code, pause: { ...code.pause!, root: undefined } }
    const r2 = (buildCaddyConfig([noRoot], opts) as unknown as Cfg).apps.http.servers.srv0.routes
      .find((x) => x.match?.[0]?.host.includes('haushalt.example.ch'))!
    const h = r2.handle[0] as { handler: string; body: string }
    assert.equal(h.handler, 'static_response')
    assert.match(h.body, /<h1>Eigen<\/h1>/)
    assert.doesNotMatch(h.body, /caddy-secrets/)
  })
})
