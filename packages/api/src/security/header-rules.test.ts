import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { headerFixFor, headerValueProblem, needsConfirmation, HEADER_DEFAULT } from '@deployer/shared'
import { headerHandlers, xfoFor, parseCspReports, normalizeBlocked, baseDirective, suggestCsp, parsePolicy, type HeaderRuleSpec } from './header-rules.js'
import { buildCaddyConfig, PROBE_SERVER, type RouteSpec } from '../drivers/caddy-config.js'
import { checkHeaders } from './headers.js'

type H = { handler: string; response?: { set?: Record<string, string[]>; require?: { headers: Record<string, null> }; deferred?: boolean } }
const names = (hs: H[]) => hs.map((h) => Object.keys(h.response?.set ?? {})[0])
const valueOf = (hs: H[], name: string) => hs.find((h) => h.response?.set?.[name])?.response?.set?.[name]?.[0]

const rule = (header: HeaderRuleSpec['header'], mode: HeaderRuleSpec['mode'] = 'enforce', value = HEADER_DEFAULT[header]): HeaderRuleSpec => ({ header, value, mode })
const ctx = { secure: false, hstsAllowed: false, reportUri: 'https://deployer.int.example.ch/api/v1/csp-reports/k' }

describe('Header-Handler für Caddy (nur ergänzen)', () => {
  test('jeder Header nur, wenn die Antwort ihn nicht hat (require + deferred)', () => {
    const hs = headerHandlers([rule('x-content-type-options'), rule('referrer-policy')], ctx) as H[]
    assert.deepEqual(names(hs), ['X-Content-Type-Options', 'Referrer-Policy'])
    for (const h of hs) {
      const n = Object.keys(h.response!.set!)[0]!
      assert.deepEqual(h.response!.require, { headers: { [n]: null } }, 'App gewinnt: require verlangt, dass der Header fehlt')
      assert.equal(h.response!.deferred, true)
    }
    assert.equal(valueOf(hs, 'X-Content-Type-Options'), 'nosniff')
  })

  test("frame-ancestors: kleine CSP und X-Frame-Options; 'none' -> DENY, fremde Herkunft ohne XFO", () => {
    const hs = headerHandlers([rule('frame-ancestors')], ctx) as H[]
    assert.equal(valueOf(hs, 'Content-Security-Policy'), "frame-ancestors 'self'")
    assert.equal(valueOf(hs, 'X-Frame-Options'), 'SAMEORIGIN')
    assert.equal(xfoFor("'none'"), 'DENY')
    assert.equal(xfoFor("'self' https://a.example"), null)
  })

  test('CSP Report-Only mit report-uri; frame-ancestors bleibt eigene CSP', () => {
    const hs = headerHandlers([rule('content-security-policy', 'report-only'), rule('frame-ancestors')], ctx) as H[]
    assert.equal(valueOf(hs, 'Content-Security-Policy-Report-Only'), `${HEADER_DEFAULT['content-security-policy']}; report-uri ${ctx.reportUri}`)
    assert.equal(valueOf(hs, 'Content-Security-Policy'), "frame-ancestors 'self'")
  })

  test('scharfe CSP nimmt frame-ancestors auf – nur ein CSP-Header', () => {
    const hs = headerHandlers([rule('content-security-policy', 'enforce', "default-src 'self'"), rule('frame-ancestors')], ctx) as H[]
    assert.equal(names(hs).filter((n) => n === 'Content-Security-Policy').length, 1)
    assert.equal(valueOf(hs, 'Content-Security-Policy'), `default-src 'self'; frame-ancestors 'self'; report-uri ${ctx.reportUri}`)
    const own = headerHandlers([rule('content-security-policy', 'enforce', "default-src 'self'; frame-ancestors 'none'"), rule('frame-ancestors')], { ...ctx, reportUri: null }) as H[]
    assert.equal(valueOf(own, 'Content-Security-Policy'), "default-src 'self'; frame-ancestors 'none'", 'eigene Direktive bleibt')
  })

  test('HSTS nur auf HTTPS-Routen und nur mit stabilem TLS', () => {
    const r = [rule('strict-transport-security')]
    assert.deepEqual(headerHandlers(r, { secure: false, hstsAllowed: true }), [])
    assert.deepEqual(headerHandlers(r, { secure: true, hstsAllowed: false }), [])
    assert.equal(valueOf(headerHandlers(r, { secure: true, hstsAllowed: true }) as H[], 'Strict-Transport-Security'), 'max-age=300')
  })
})

describe('Befund -> Header und Werte', () => {
  test('Header-Befunde des eigenen Checks bekommen den passenden Header', () => {
    const f = checkHeaders({ url: 'https://a.example/', status: 200, headers: {}, body: '', isHttps: true })
    const map = Object.fromEntries(f.map((x) => [x.title, headerFixFor(x)]))
    assert.equal(map['Content-Security-Policy fehlt'], 'content-security-policy')
    assert.equal(map['Schutz gegen Einbetten fehlt (frame-ancestors / X-Frame-Options)'], 'frame-ancestors')
    assert.equal(map['X-Content-Type-Options: nosniff fehlt'], 'x-content-type-options')
    assert.equal(map['Referrer-Policy fehlt'], 'referrer-policy')
    assert.equal(map['Strict-Transport-Security fehlt'], 'strict-transport-security')
    assert.equal(headerFixFor({ tool: 'zap', title: 'Referrer-Policy fehlt' }), null, 'nur eigener Header-Check')
  })

  test('mit allen Regeln (über Caddy) meldet der Check keinen Header-Befund mehr', () => {
    const rules = (['x-content-type-options', 'referrer-policy', 'frame-ancestors', 'strict-transport-security'] as const).map((h) => rule(h))
    rules.push(rule('content-security-policy', 'enforce', "default-src 'self'"))
    const headers: Record<string, string> = {}
    for (const h of headerHandlers(rules, { secure: true, hstsAllowed: true }) as H[]) {
      const [n, v] = Object.entries(h.response!.set!)[0]!
      headers[n.toLowerCase()] = v[0]!
    }
    assert.deepEqual(checkHeaders({ url: 'https://a.example/', status: 200, headers, body: '', isHttps: true }), [])
  })

  test('eine CSP nur mit frame-ancestors gilt nicht als CSP (gefunden gegen echtes Caddy)', () => {
    const only = checkHeaders({ url: 'http://a.example/', status: 200, headers: { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' }, body: '', isHttps: false })
    assert.ok(only.some((f) => f.title === 'Content-Security-Policy fehlt'))
    assert.ok(!only.some((f) => f.title.startsWith('Schutz gegen Einbetten')))
    const real = checkHeaders({ url: 'http://a.example/', status: 200, headers: { 'content-security-policy': "script-src 'self'; frame-ancestors 'self'" }, body: '', isHttps: false })
    assert.ok(!real.some((f) => f.title === 'Content-Security-Policy fehlt'))
  })

  test('Werte: keine Zeilenumbrüche, kein preload, report-uri setzt deployer', () => {
    assert.equal(headerValueProblem('x-content-type-options', 'nosniff', 'enforce'), null)
    assert.ok(headerValueProblem('x-content-type-options', 'sniff', 'enforce'))
    assert.equal(headerValueProblem('referrer-policy', 'no-referrer', 'enforce'), null)
    assert.ok(headerValueProblem('strict-transport-security', 'max-age=300; preload', 'enforce'))
    assert.equal(headerValueProblem('strict-transport-security', 'max-age=86400; includeSubDomains', 'enforce'), null)
    assert.ok(headerValueProblem('strict-transport-security', 'max-age=300', 'report-only'))
    assert.ok(headerValueProblem('content-security-policy', "default-src 'self'; report-uri https://evil", 'enforce'))
    assert.equal(headerValueProblem('content-security-policy', HEADER_DEFAULT['content-security-policy'], 'report-only'), null)
    assert.equal(needsConfirmation('content-security-policy', 'report-only'), false)
    assert.equal(needsConfirmation('content-security-policy', 'enforce'), true)
    assert.equal(needsConfirmation('strict-transport-security', 'enforce'), true)
    assert.equal(needsConfirmation('referrer-policy', 'enforce'), false)
  })
})

describe('CSP-Meldungen', () => {
  test('report-uri-Format (application/csp-report)', () => {
    const v = parseCspReports({
      'csp-report': {
        'document-uri': 'https://solar.int.example.ch/stats?user=joel',
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://cdn.jsdelivr.net/npm/chart.js',
      },
    })
    assert.deepEqual(v, [{ directive: 'script-src', blocked: 'https://cdn.jsdelivr.net', path: '/stats' }], 'Herkunft statt URL, Pfad ohne Query')
  })

  test('Reporting-API (application/reports+json), fremde Typen ignoriert', () => {
    const v = parseCspReports([
      { type: 'csp-violation', url: 'https://a.example/', body: { documentURL: 'https://a.example/', effectiveDirective: 'style-src-attr', blockedURL: 'inline' } },
      { type: 'csp-violation', body: { documentURL: 'https://a.example/x', effectiveDirective: 'img-src', blockedURL: 'https://a.example/logo.png' } },
      { type: 'deprecation', body: {} },
    ])
    assert.deepEqual(v.map((x) => [x.directive, x.blocked]), [['style-src', 'inline'], ['img-src', 'self']])
  })

  test('Quellen normalisieren; Unbrauchbares fällt weg', () => {
    assert.equal(normalizeBlocked('eval', undefined), 'eval')
    assert.equal(normalizeBlocked('data', undefined), 'data:')
    assert.equal(normalizeBlocked('data:image/png;base64,AAA', undefined), 'data:')
    assert.equal(normalizeBlocked('', undefined), 'inline')
    assert.equal(normalizeBlocked('javascript:alert(1)', undefined), null)
    assert.equal(normalizeBlocked('wss://live.example:8443/x', undefined), 'wss://live.example:8443')
    assert.equal(baseDirective('script-src-elem'), 'script-src')
    assert.deepEqual(parseCspReports('kaputt'), [])
    assert.deepEqual(parseCspReports({ 'csp-report': { 'effective-directive': '<script>', 'blocked-uri': 'https://x.example' } }), [])
  })

  test('Vorschlag: Quellen je Direktive, nie unsafe-inline/unsafe-eval', () => {
    const s = suggestCsp(HEADER_DEFAULT['content-security-policy'], [
      { directive: 'script-src', blocked: 'https://cdn.jsdelivr.net' },
      { directive: 'img-src', blocked: 'https://tile.osm.org' },
      { directive: 'img-src', blocked: 'data:' },
      { directive: 'style-src', blocked: 'inline' },
      { directive: 'script-src', blocked: 'eval' },
      { directive: 'object-src', blocked: 'https://x.example' },
    ])
    const m = parsePolicy(s.policy)
    assert.deepEqual(m.get('script-src'), ["'self'", 'https://cdn.jsdelivr.net'], 'neue Direktive startet mit default-src')
    assert.deepEqual(m.get('img-src'), ["'self'", 'data:', 'https://tile.osm.org'])
    assert.deepEqual(m.get('object-src'), ['https://x.example'], "'none' wird ersetzt")
    assert.ok(!s.policy.includes('unsafe-'), 'kein unsafe-inline/eval')
    assert.equal(s.notes.length, 2)
    assert.ok(s.policy.startsWith("default-src 'self'; script-src"), 'feste Reihenfolge')
  })
})

describe('Caddy: Header in Routen und Probe-Server', () => {
  type Srv = { listen: string[]; routes: { match?: { host: string[]; remote_ip?: unknown }[]; handle: H[] & { headers?: unknown }[] }[] }
  type Cfg = { apps: { http: { servers: Record<string, Srv> } } }
  const route: RouteSpec = {
    hosts: ['solar.int.example.ch', 'solar.192-168-1-10.nip.io'],
    kind: 'proxy',
    upstream: 'dep_solar_abc:3000',
    cidrs: ['192.168.1.0/24'],
    headers: [rule('x-content-type-options'), rule('strict-transport-security')],
    cspReportKey: null,
  }
  const tls = { baseDomain: 'int.example.ch', acmeCa: 'production' as const }
  const base = { ipFilter: true, cidrs: ['192.168.1.0/24'], adminSocket: '/run/caddy/admin.sock', probeSocket: '/run/caddy/probe.sock' }
  const build = (o: Partial<typeof base> & { tls?: typeof tls | null } = {}) => buildCaddyConfig([route], { ...base, ...o }) as unknown as Cfg

  test('Probe-Server auf dem Unix-Socket, ohne IP-Filter; Besucher-Server mit Filter', () => {
    const s = build({ tls }).apps.http.servers
    const probe = s[PROBE_SERVER]!
    assert.deepEqual(probe.listen, ['unix//run/caddy/probe.sock'])
    assert.ok(probe.routes.every((r) => r.match?.every((m) => !('remote_ip' in m)) ?? true), 'kein remote_ip im Probe-Server')
    assert.ok(s.srv0!.routes[0]!.match![0]!.remote_ip, 'Besucher-Server behält den Filter')
    assert.ok(!(s.srv0!.listen.some((l) => l.startsWith('unix'))), 'kein Socket auf dem Besucher-Server')
  })

  test('HSTS nur auf :443 und im HTTPS-Abbild des Probe-Servers, nur mit Produktions-CA', () => {
    const s = build({ tls }).apps.http.servers
    const hsts = (r: Srv['routes'][number]) => r.handle.some((h) => h.response?.set?.['Strict-Transport-Security'])
    assert.equal(hsts(s.srv1!.routes[0]!), true)
    assert.equal(hsts(s.srv0!.routes[0]!), false, 'nip.io über HTTP: kein HSTS')
    const probe = s[PROBE_SERVER]!.routes.filter((r) => r.match) // ohne die Auffangroute
    assert.deepEqual(probe.map((r) => [r.match![0]!.host[0], hsts(r)]), [['solar.int.example.ch', true], ['solar.192-168-1-10.nip.io', false]])
    const staging = build({ tls: { ...tls, acmeCa: 'staging' as never } }).apps.http.servers
    assert.equal(hsts(staging.srv1!.routes[0]!), false, 'Rückfall auf Staging nimmt HSTS heraus')
  })

  test('Probe-Server gibt der App X-Forwarded-Proto wie ein Besucher', () => {
    const probe = build({ tls }).apps.http.servers[PROBE_SERVER]!.routes.filter((r) => r.match)
    const xfp = (r: (typeof probe)[number]) => (r.handle.find((h) => h.handler === 'reverse_proxy') as { headers?: { request: { set: Record<string, string[]> } } }).headers?.request.set['X-Forwarded-Proto']
    assert.deepEqual(probe.map(xfp), [['https'], ['http']])
    const visitor = build({ tls }).apps.http.servers.srv1!.routes[0]!.handle.find((h) => h.handler === 'reverse_proxy') as { headers?: unknown }
    assert.equal(visitor.headers, undefined, 'Besucher-Route setzt nichts: Caddy füllt X-Forwarded-Proto selbst')
  })

  test('ohne probeSocket kein Probe-Server', () => {
    assert.equal(build({ probeSocket: undefined as never }).apps.http.servers[PROBE_SERVER], undefined)
  })
})

describe('Caddy: CSP-Meldungen am Host des Projekts', () => {
  type R = { match?: { host: string[]; path?: string[]; method?: string[]; remote_ip?: { ranges: string[] } }[]; handle: Record<string, unknown>[] }
  type Cfg = { apps: { http: { servers: Record<string, { routes: R[] }> } } }
  const KEY = 'abcdefghijklmnopqrstuvwx'
  const csp: RouteSpec = {
    hosts: ['solar.int.example.ch'],
    kind: 'proxy',
    upstream: 'dep_solar_abc:3000',
    cidrs: ['100.64.0.0/10'],
    headers: [rule('content-security-policy', 'report-only')],
    cspReportKey: KEY,
  }
  const opts = { ipFilter: true, cidrs: ['100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock', cspReportUpstream: 'deployer-app:3000' }
  const routesOf = (spec: RouteSpec, o: Partial<typeof opts> = {}) => (buildCaddyConfig([spec], { ...opts, ...o }) as unknown as Cfg).apps.http.servers.srv0!.routes

  test('report-uri relativ auf den eigenen Host, nicht auf deployer', () => {
    const main = routesOf(csp).find((r) => r.match?.[0]?.host[0] === 'solar.int.example.ch' && !r.match[0].path)!
    const h = main.handle.find((x) => (x.response as { set?: Record<string, string[]> })?.set?.['Content-Security-Policy-Report-Only'])!
    const v = (h.response as { set: Record<string, string[]> }).set['Content-Security-Policy-Report-Only']![0]!
    assert.ok(v.endsWith(`report-uri /.well-known/deployer/csp-report/${KEY}`), v)
    assert.ok(!v.includes('deployer.int'))
  })

  test('eigene Route vor der App: nur POST auf genau diesen Pfad, 64 KB, Ratenlimit, fester Zielpfad, gleicher IP-Filter', () => {
    const rs = routesOf(csp)
    const i = rs.findIndex((r) => r.match?.[0]?.path)
    const app = rs.findIndex((r) => r.match?.[0]?.host[0] === 'solar.int.example.ch' && !r.match[0].path)
    assert.ok(i >= 0 && i < app, 'vor der Route der App')
    const m = rs[i]!.match![0]!
    assert.deepEqual(m.path, [`/.well-known/deployer/csp-report/${KEY}`])
    assert.deepEqual(m.method, ['POST'])
    assert.deepEqual(m.remote_ip, { ranges: ['100.64.0.0/10'] })
    const kinds = rs[i]!.handle.map((x) => x.handler)
    assert.deepEqual(kinds, ['request_body', 'rate_limit', 'rewrite', 'reverse_proxy'])
    assert.equal(rs[i]!.handle[0]!.max_size, 64 * 1024)
    assert.equal(rs[i]!.handle[2]!.uri, `/api/v1/csp-reports/${KEY}`)
    assert.deepEqual((rs[i]!.handle[3]!.upstreams as { dial: string }[])[0], { dial: 'deployer-app:3000' })
  })

  test('ohne CSP-Regel, ohne Ziel oder pausiert: keine Meldungs-Route und keine report-uri', () => {
    assert.ok(!routesOf({ ...csp, headers: [rule('referrer-policy')] }).some((r) => r.match?.[0]?.path))
    const noUp = routesOf(csp, { cspReportUpstream: null as never })
    assert.ok(!noUp.some((r) => r.match?.[0]?.path))
    assert.ok(!JSON.stringify(noUp).includes('report-uri'))
    assert.ok(!routesOf({ ...csp, kind: 'maintenance' }).some((r) => r.match?.[0]?.path))
  })
})
