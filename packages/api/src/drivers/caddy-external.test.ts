import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, forwardAuth, GATE_COOKIE_STRIP_RE, GATE_COOKIE_STRIP_REPLACE, PROBE_SERVER, type RouteSpec } from './caddy-config.js'

/**
 * Bestehender Dienst und Zugang «Airlock-Login» in der Caddy-Konfiguration:
 * Ziel fremder Container/Adresse, HTTPS mit eigenem Zertifikat, forward_auth,
 * Rückruf-Pfad, Cookie nie an die App, kein Login im Probe-Server.
 */

const opts = { ipFilter: true, cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock', probeSocket: '/run/caddy/probe.sock' }

type H = Record<string, unknown> & { handler: string }
type R = { match?: { host?: string[]; path?: string[]; method?: string[]; remote_ip?: { ranges: string[] } }[]; handle: H[] }
type Cfg = { apps: { http: { servers: Record<string, { routes: R[] }> } } }

const servers = (specs: RouteSpec[]) => (buildCaddyConfig(specs, opts) as unknown as Cfg).apps.http.servers
const routesFor = (specs: RouteSpec[], host: string, server = 'srv0') =>
  servers(specs)[server]!.routes.filter((r) => r.match?.some((m) => m.host?.includes(host)))

const gate = { upstream: 'airlock-app:3000' }
const sonarr: RouteSpec = { hosts: ['sonarr.int.example.ch'], kind: 'proxy', upstream: 'sonarr:8989', cidrs: ['100.64.0.0/10'], visits: true }

describe('Ziel eines bestehenden Dienstes', () => {
  test('Container: reverse_proxy auf Name:Port im fremden Netz', () => {
    const [main] = routesFor([sonarr], 'sonarr.int.example.ch')
    const proxy = main!.handle.find((h) => h.handler === 'reverse_proxy')!
    assert.deepEqual(proxy.upstreams, [{ dial: 'sonarr:8989' }])
    assert.equal(proxy.transport, undefined)
  })

  test('Adresse mit https und eigenem Zertifikat: TLS zum Ziel, Prüfung nur auf Wunsch aus', () => {
    const nas: RouteSpec = { hosts: ['nas.int.example.ch'], kind: 'proxy', upstream: '192.168.1.20:5001', upstreamTls: { insecure: true }, cidrs: ['100.64.0.0/10'], visits: true }
    const strict: RouteSpec = { ...nas, hosts: ['nas2.int.example.ch'], upstreamTls: { insecure: false } }
    const p1 = routesFor([nas], 'nas.int.example.ch')[0]!.handle.find((h) => h.handler === 'reverse_proxy')!
    const p2 = routesFor([strict], 'nas2.int.example.ch')[0]!.handle.find((h) => h.handler === 'reverse_proxy')!
    assert.deepEqual(p1.transport, { protocol: 'http', tls: { insecure_skip_verify: true } })
    assert.deepEqual(p2.transport, { protocol: 'http', tls: {} })
  })

  test('der Login-Cookie geht nie an die App (auch ohne Login-Schutz)', () => {
    const proxy = routesFor([sonarr], 'sonarr.int.example.ch')[0]!.handle.find((h) => h.handler === 'reverse_proxy')!
    assert.deepEqual((proxy.headers as { request: { replace: unknown } }).request.replace, { Cookie: [{ search_regexp: GATE_COOKIE_STRIP_RE, replace: GATE_COOKIE_STRIP_REPLACE }] })
    // Der reguläre Ausdruck wie Caddy (Go-RE2, ReplaceAllString mit ${1}) – in JS nachgestellt
    const strip = (c: string) => c.replace(new RegExp(GATE_COOKIE_STRIP_RE, 'g'), '$1')
    assert.equal(strip('a=1; airlock_gate=xyz; b=2'), 'a=1; b=2')
    assert.equal(strip('airlock_gate=xyz; a=1'), ' a=1')
    assert.equal(strip('airlock_gate=xyz'), '')
    assert.equal(strip('a=1; not_airlock_gate=keep'), 'a=1; not_airlock_gate=keep')
  })
})

describe('Zugang «Airlock-Login» (forward_auth)', () => {
  const guarded: RouteSpec = { ...sonarr, gate }
  const routes = routesFor([guarded], 'sonarr.int.example.ch')

  test('forward_auth zuerst: GET /api/v1/gate/check an Airlock, Methode und Pfad mit, Authorization nicht', () => {
    const main = routes.find((r) => !r.match?.[0]?.path)!
    const first = main.handle[0]!
    assert.deepEqual(first, forwardAuth('airlock-app:3000'))
    assert.deepEqual(first.rewrite, { method: 'GET', uri: '/api/v1/gate/check' })
    const headers = first.headers as { request: { set: Record<string, string[]>; delete: string[] } }
    assert.deepEqual(headers.request.set['X-Forwarded-Uri'], ['{http.request.uri}'])
    assert.deepEqual(headers.request.delete, ['Authorization'])
    // 2xx: weiter (Antwort-Zweig schreibt nichts); alles andere gibt Caddy weiter (302 zur Anmeldung)
    const hr = first.handle_response as { match: { status_code: number[] }; routes: { handle: H[] }[] }[]
    assert.deepEqual(hr[0]!.match, { status_code: [2] })
    assert.ok(hr[0]!.routes[0]!.handle.every((h) => h.handler !== 'static_response' && h.handler !== 'reverse_proxy'))
    // Danach erst die App
    assert.equal(main.handle.at(-1)!.handler, 'reverse_proxy')
    assert.deepEqual(main.handle.at(-1)!.upstreams, [{ dial: 'sonarr:8989' }])
  })

  test('Rückruf /.airlock/gate vor der Route, nur GET, gleiche Netze, ohne Cookies an Airlock', () => {
    const cb = routes.find((r) => r.match?.[0]?.path)!
    assert.ok(routes.indexOf(cb) < routes.findIndex((r) => !r.match?.[0]?.path), 'Rückruf muss vor der Route stehen')
    assert.deepEqual(cb.match![0]!.path, ['/.airlock/gate'])
    assert.deepEqual(cb.match![0]!.method, ['GET'])
    assert.deepEqual(cb.match![0]!.remote_ip, { ranges: ['100.64.0.0/10'] })
    assert.deepEqual(cb.handle[0], { handler: 'rewrite', uri: '/api/v1/gate/callback?{http.request.uri.query}' })
    assert.deepEqual(cb.handle[1], { handler: 'reverse_proxy', upstreams: [{ dial: 'airlock-app:3000' }], headers: { request: { delete: ['Cookie', 'Authorization'] } } })
  })

  test('Probe-Server (Header-Check, Scan): ohne Login, sieht die App wie bisher', () => {
    const probe = servers([guarded])[PROBE_SERVER]!.routes.find((r) => r.match?.[0]?.host?.includes('sonarr.int.example.ch'))!
    assert.ok(probe.handle.every((h) => !h.rewrite), 'kein forward_auth im Probe-Server')
    assert.ok(!servers([guarded])[PROBE_SERVER]!.routes.some((r) => r.match?.[0]?.path?.includes('/.airlock/gate')))
  })

  test('Pause-Seite (Ziel fehlt) ohne Login; statische Seite mit Login', () => {
    const paused: RouteSpec = { hosts: ['weg.int.example.ch'], kind: 'maintenance', cidrs: ['100.64.0.0/10'], gate }
    assert.ok(routesFor([paused], 'weg.int.example.ch').every((r) => r.handle.every((h) => !h.rewrite)))
    const files: RouteSpec = { hosts: ['seite.int.example.ch'], kind: 'files', root: '/srv/sites/seite/current', cidrs: ['100.64.0.0/10'], gate }
    const fr = routesFor([files], 'seite.int.example.ch')
    assert.ok(fr.find((r) => !r.match?.[0]?.path)!.handle[0]!.rewrite, 'statische Seite: forward_auth vor dem file_server')
  })

  test('ohne Login: kein forward_auth, kein Rückruf', () => {
    const plain = routesFor([sonarr], 'sonarr.int.example.ch')
    assert.ok(!plain.some((r) => r.match?.[0]?.path), 'kein Rückruf-Pfad')
    assert.ok(plain.every((r) => r.handle.every((h) => !h.rewrite)), 'kein forward_auth')
  })
})
