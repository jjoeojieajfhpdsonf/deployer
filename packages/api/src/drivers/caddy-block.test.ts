import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, ACCESS_LOGGER, type RouteSpec } from './caddy-config.js'
import { parseAccessLog, assessClientIps } from '../lib/client-ips.js'

type Route = { match?: { host: string[]; remote_ip?: unknown }[]; handle: { handler: string; status_code?: number; body?: string }[] }
type Srv = { routes: Route[]; logs?: { logger_names: Record<string, string[]>; skip_unmapped_hosts: boolean } }
const servers = (cfg: unknown) => (cfg as { apps: { http: { servers: Record<string, Srv> } } }).apps.http.servers

const deployer: RouteSpec = { hosts: ['deployer.int.example.ch', 'deployer.100-88-41-12.nip.io'], kind: 'proxy', upstream: 'deployer-app:3000' }
const app: RouteSpec = { hosts: ['app.int.example.ch'], kind: 'proxy', upstream: 'app:80' }
const base = { cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock', trustedProxies: [] as string[] }

describe('Sperrseite: zwei Meldungen', () => {
  test('bekannter Name von fremder Adresse → 403 mit gesehener Adresse; unbekannter Name → 404', () => {
    const s = servers(buildCaddyConfig([deployer, app], { ...base, ipFilter: true })).srv0!
    const forbidden = s.routes.at(-2)!
    const unknown = s.routes.at(-1)!
    assert.equal(forbidden.handle[0]!.status_code, 403)
    assert.deepEqual(new Set(forbidden.match![0]!.host), new Set([...deployer.hosts, ...app.hosts]))
    assert.equal(forbidden.match![0]!.remote_ip, undefined, 'ohne Quell-Filter: trifft genau, wenn die Route davor nicht durfte')
    assert.match(forbidden.handle[0]!.body!, /\{http\.request\.remote\.host\}/)
    assert.match(forbidden.handle[0]!.body!, /freigegebenen Netzen/)
    assert.equal(unknown.match, undefined)
    assert.equal(unknown.handle[0]!.status_code, 404)
    assert.equal(unknown.handle[0]!.body, 'Kein Projekt unter diesem Namen.')
  })

  test('ohne IP-Filter gibt es nichts zu sperren: nur 404 für unbekannte Namen', () => {
    const s = servers(buildCaddyConfig([deployer, app], { ...base, ipFilter: false })).srv0!
    assert.equal(s.routes.filter((r) => r.handle[0]!.status_code === 403).length, 0)
    assert.equal(s.routes.at(-1)!.handle[0]!.status_code, 404)
  })

  test('mit HTTPS: 403 auch auf :443 und für *.<basis> auf :80 (Weiterleitung)', () => {
    const cfg = buildCaddyConfig([deployer, app], { ...base, ipFilter: true, tls: { baseDomain: 'int.example.ch', acmeCa: 'production', tokenFile: '/t', redirect: true } })
    const { srv0, srv1 } = servers(cfg)
    const f1 = srv1!.routes.find((r) => r.handle[0]!.status_code === 403)!
    assert.ok(f1.match![0]!.host.includes('deployer.int.example.ch'))
    const f0 = srv0!.routes.find((r) => r.handle[0]!.status_code === 403)!
    assert.ok(f0.match![0]!.host.includes('*.int.example.ch'))
    assert.ok(f0.match![0]!.host.includes('deployer.100-88-41-12.nip.io'))
  })
})

describe('Zugriffs-Log nur für deployer', () => {
  test('logger_names für die deployer-Namen, andere Namen werden nicht geloggt', () => {
    const cfg = buildCaddyConfig([deployer, app], { ...base, ipFilter: true, accessLogHosts: deployer.hosts, tls: { baseDomain: 'int.example.ch', acmeCa: 'production', tokenFile: '/t' } })
    for (const s of Object.values(servers(cfg))) {
      assert.deepEqual(s.logs, { logger_names: { 'deployer.int.example.ch': [ACCESS_LOGGER], 'deployer.100-88-41-12.nip.io': [ACCESS_LOGGER] }, skip_unmapped_hosts: true })
    }
  })
  test('ohne accessLogHosts kein Log', () => {
    assert.equal(servers(buildCaddyConfig([deployer], { ...base, ipFilter: true })).srv0!.logs, undefined)
  })
})

describe('Absender aus dem Zugriffs-Log', () => {
  const T = Date.parse('2026-11-10T08:00:00Z')
  const line = (sec: number, ip: string, status: number, logger = 'http.log.access.deployer') =>
    JSON.stringify({ level: 'info', ts: (T + sec * 1000) / 1000, logger, msg: 'handled request', request: { remote_ip: ip, client_ip: ip, host: 'deployer.int.example.ch' }, status })
  const log = [
    line(-4000, '172.20.0.1', 403), // zu alt
    line(10, '172.20.0.1', 403), // Tailnet, maskiert
    line(20, '172.20.0.1', 403),
    line(30, '192.168.1.40', 200), // LAN, korrekt
    line(40, '100.88.41.12', 200, 'http.log.access.other'), // anderer Logger
    'kein JSON',
  ].join('\n')

  test('liest nur deployer-Einträge im Zeitraum', () => {
    const e = parseAccessLog(log, T)
    assert.equal(e.length, 3)
    assert.deepEqual(e.map((x) => x.ip), ['172.20.0.1', '172.20.0.1', '192.168.1.40'])
  })

  test('erkennt Anfragen von Docker-Gateways (maskiert), mit Sperren', () => {
    const r = assessClientIps(parseAccessLog(log, T), ['172.17.0.1', '172.20.0.1'], T)
    assert.deepEqual({ total: r.total, fromGateway: r.fromGateway, gatewayIps: r.gatewayIps, gatewayOnly: r.gatewayOnly, blocked: r.blocked }, { total: 3, fromGateway: 2, gatewayIps: ['172.20.0.1'], gatewayOnly: false, blocked: 2 })
  })

  test('nur Gateways → gatewayOnly; keine Anfragen → keine Warnung', () => {
    assert.equal(assessClientIps(parseAccessLog(log, T + 25_000), ['172.20.0.1'], T).gatewayOnly, false)
    const onlyGw = parseAccessLog([line(10, '172.20.0.1', 403)].join('\n'), T)
    assert.equal(assessClientIps(onlyGw, ['172.20.0.1'], T).gatewayOnly, true)
    const none = assessClientIps([], ['172.20.0.1'], T)
    assert.equal(none.fromGateway, 0)
    assert.equal(none.gatewayOnly, false)
  })
})
