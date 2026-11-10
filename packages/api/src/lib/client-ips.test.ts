import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseAccessLog, assessClientIps, gatewaySourceOf, shortUserAgent } from './client-ips.js'
import { isOwnProbe, probeUa } from './probe-ua.js'
import { probeViaCaddy } from './address-probe.js'

// Caddy-Zugriffslog wie auf dem Server (JSON, request.headers mit Listen)
const T = Date.parse('2026-11-10T20:00:00Z')
const GW = '172.25.0.1'
const line = (sec: number, o: { ip?: string; status?: number; ua?: string; uri?: string; host?: string }) => JSON.stringify({
  level: 'info', ts: (T + sec * 1000) / 1000, logger: 'http.log.access.airlock', msg: 'handled request',
  request: {
    remote_ip: o.ip ?? GW, client_ip: o.ip ?? GW, proto: 'HTTP/1.1', method: 'GET',
    host: o.host ?? 'deployer.int.jherren.com', uri: o.uri ?? '/',
    headers: o.ua === undefined ? {} : { 'User-Agent': [o.ua] },
  },
  status: o.status ?? 403,
})

describe('Eigene Prüfungen zählen nie als fremde Gateway-Zugriffe', () => {
  test('Prüf-Job läuft (jede Minute, vom Gateway, gesperrt): keine Warnung', () => {
    const log = Array.from({ length: 30 }, (_, i) => line(i * 60, { ua: probeUa('adresse'), uri: '/' })).join('\n')
    const r = assessClientIps(parseAccessLog(log, T), [GW], T)
    assert.equal(r.fromGateway, 0, 'Warnung bleibt aus')
    assert.equal(r.ownProbes, 30)
    assert.deepEqual(r.groups, [])
  })

  test('ältere Kennungen gelten auch als eigen', () => {
    for (const ua of ['airlock-probe (header)', 'airlock-csp-check', 'airlock-outside-check', 'deployer-check']) assert.equal(isOwnProbe(ua), true, ua)
    for (const ua of ['curl/8.5.0', 'Mozilla/5.0', '', null]) assert.equal(isOwnProbe(ua), false, String(ua))
  })

  test('simulierte fremde Anfrage vom Gateway löst die Warnung aus, mit Details', () => {
    const log = [
      ...Array.from({ length: 5 }, (_, i) => line(i * 60, { ua: probeUa('adresse') })),
      line(400, { ua: 'curl/8.5.0', uri: '/health?token=geheim', status: 403 }),
      line(500, { ua: 'curl/8.5.0', uri: '/health', status: 403 }),
      line(600, { ip: '100.88.41.12', ua: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15', uri: '/projekte', status: 200 }),
    ].join('\n')
    const r = assessClientIps(parseAccessLog(log, T), [GW, '172.17.0.1'], T)
    assert.equal(r.total, 3)
    assert.equal(r.fromGateway, 2)
    assert.equal(r.blocked, 2)
    assert.equal(r.ownProbes, 5)
    assert.equal(r.groups.length, 1)
    const g = r.groups[0]!
    assert.equal(g.source, 'server')
    assert.deepEqual(g.hosts, ['deployer.int.jherren.com'])
    assert.deepEqual(g.paths, ['GET /health'], 'Pfad ohne Query (Tokens)')
    assert.deepEqual(g.userAgents, ['curl/8.5.0'])
    assert.equal(g.last, new Date(T + 500_000).toISOString())
  })

  test('Browser vom Gateway: «vermutlich Tailnet maskiert»', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
    const r = assessClientIps(parseAccessLog(line(10, { ua, uri: '/api/v1/projects' }), T), [GW], T)
    assert.equal(r.groups[0]!.source, 'tailnet')
    assert.deepEqual(r.groups[0]!.userAgents, ['Chrome 131'])
    assert.equal(gatewaySourceOf(ua), 'tailnet')
    assert.equal(gatewaySourceOf('Go-http-client/1.1'), 'server')
    assert.equal(gatewaySourceOf(null), 'server')
  })

  test('Kurzform der User-Agents', () => {
    assert.equal(shortUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Safari 18')
    assert.equal(shortUserAgent('Mozilla/5.0 Firefox/132.0'), 'Firefox 132')
    assert.equal(shortUserAgent(''), '(ohne User-Agent)')
  })
})

describe('Adressen-Prüfung: direkt an Caddy, mit Kennung', () => {
  test('schickt User-Agent «airlock-probe (adresse)» und den Namen im Host-Header', async () => {
    let seen: { host?: string; ua?: string } = {}
    const srv = createServer((req, res) => {
      seen = { host: req.headers.host, ua: req.headers['user-agent'] }
      res.end('ok')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    try {
      await probeViaCaddy(`127.0.0.1:${port}`, 'http://deployer.100-64-0-1.nip.io')
      assert.equal(seen.host, 'deployer.100-64-0-1.nip.io')
      assert.equal(seen.ua, 'airlock-probe (adresse)')
      assert.equal(isOwnProbe(seen.ua), true)
    } finally {
      srv.close()
    }
  })
})
