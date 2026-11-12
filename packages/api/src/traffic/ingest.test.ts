import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TrafficLiveEventDto } from '@airlock/shared'
import { TrafficAggregator } from './aggregate.js'
import { TrafficProcessor, type HostInfo } from './ingest.js'
import { VisitorCounter } from './visitor.js'
import { MmdbReader, bufferSource, cityFromRecord } from './mmdb.js'
import { buildMmdb, cityRecord } from './mmdb-fixture.js'
import { caddyLine } from './test-lines.js'

const T = Date.parse('2026-11-11T14:30:00Z') / 1000
const own = new Set(['foto.int.example.ch', 'foto.192-168-1-5.nip.io', 'foto.example.ch'])
const hosts = new Map<string, HostInfo>([
  ['foto.int.example.ch', { projectId: 'p1', public: false, service: 'web', healthPath: '/health', ownHosts: own }],
  ['foto.192-168-1-5.nip.io', { projectId: 'p1', public: false, service: 'web', healthPath: '/health', ownHosts: own }],
  ['foto.example.ch', { projectId: 'p1', public: true, service: 'web', healthPath: '/health', ownHosts: own }],
])

function setup(o: { city?: boolean } = {}) {
  const aggregator = new TrafficAggregator()
  const events: [string, TrafficLiveEventDto][] = []
  const geo = o.city ? new MmdbReader(bufferSource(buildMmdb([['203.0.113.0/24', cityRecord('Zürich', 'CH')]]))) : null
  const p = new TrafficProcessor({
    aggregator,
    visitors: new VisitorCounter('Europe/Zurich', T * 1000),
    hosts: () => hosts,
    city: (ip) => (geo ? cityFromRecord(geo.get(ip)) : null),
    hasPages: new Set(),
    emit: (id, e) => events.push([id, e]),
  })
  return { p, aggregator, events }
}

describe('Besucher-Ingest: Zeile → Live-Strom und Zähler', () => {
  test('Seite aus dem Heimnetz: ein Aufruf, ein Besucher, ein Live-Ereignis ohne IP', () => {
    const { p, aggregator, events } = setup()
    assert.equal(p.handle(caddyLine({ ts: T, ip: '192.168.1.20', uri: '/galerie?id=7' })), 'page')
    assert.deepEqual(events, [['p1', { at: '2026-11-11T14:30:00.000Z', access: 'lan', host: 'foto.int.example.ch', service: 'web', status: 200, blocked: false, bot: false }]])
    const [row] = aggregator.peek()
    assert.equal(row!.way, 'lan')
    assert.equal(row!.path, '/galerie')
    assert.equal(row!.views, 1)
    assert.equal(row!.visitors, 1)
    assert.equal(row!.hour, Date.parse('2026-11-11T14:00:00Z'))
  })

  test('nichts von IP oder User-Agent landet in Zählern oder Live-Strom', () => {
    const { p, aggregator, events } = setup()
    p.handle(caddyLine({ ts: T, ip: '203.0.113.42', host: 'foto.example.ch', country: 'CH', ua: 'Mozilla/5.0 GeheimerBrowser/1.0' }))
    const dump = JSON.stringify([aggregator.peek(), events])
    assert.ok(!dump.includes('203.0.113'))
    assert.ok(!dump.includes('Geheimer'))
  })

  test('derselbe Besucher zweimal: zwei Aufrufe, ein Besucher', () => {
    const { p, aggregator } = setup()
    p.handle(caddyLine({ ts: T, ip: '100.88.1.2' }))
    p.handle(caddyLine({ ts: T + 60, ip: '100.88.1.2' }))
    p.handle(caddyLine({ ts: T + 90, ip: '100.88.1.3' }))
    const [row] = aggregator.peek()
    assert.equal(row!.way, 'tailnet')
    assert.equal(row!.views, 3)
    assert.equal(row!.visitors, 2)
  })

  test('Internet: Land aus CF-IPCountry, Stadt aus DB-IP, Referrer nur als Host', () => {
    const { p, aggregator } = setup({ city: true })
    p.handle(caddyLine({ ts: T, ip: '203.0.113.42', remoteIp: '172.30.0.5', host: 'foto.example.ch', country: 'CH', referer: 'https://www.google.com/search?q=privat' }))
    const [row] = aggregator.peek()
    assert.equal(row!.way, 'public')
    assert.equal(row!.country, 'CH')
    assert.equal(row!.city, 'Zürich')
    assert.equal(row!.referrer, 'google.com')
  })

  test('ohne Städte-Datenbank: nur Land; intern nie Land oder Stadt', () => {
    const { p, aggregator } = setup()
    p.handle(caddyLine({ ts: T, ip: '203.0.113.42', host: 'foto.example.ch', country: 'DE' }))
    p.handle(caddyLine({ ts: T, ip: '192.168.1.20', country: 'DE' }))
    const rows = aggregator.peek()
    assert.deepEqual(rows.map((r) => [r.way, r.country, r.city]), [['public', 'DE', ''], ['lan', '', '']])
  })

  test('eigene Prüfung: weder live noch gezählt', () => {
    const { p, aggregator, events } = setup()
    assert.equal(p.handle(caddyLine({ ts: T, ua: 'airlock-probe (header)' })), 'ignore')
    assert.equal(events.length, 0)
    assert.equal(aggregator.size, 0)
  })

  test('vom IP-Filter gesperrt: live mit blocked und ohne Dienst, nicht gezählt', () => {
    const { p, aggregator, events } = setup()
    assert.equal(p.handle(caddyLine({ ts: T, ip: '172.20.0.1', status: 403, blocked: true, contentType: 'text/plain' })), 'live')
    assert.equal(events[0]![1].blocked, true)
    assert.equal(events[0]![1].service, null)
    assert.equal(aggregator.size, 0)
  })

  test('Bot: getrennt gezählt (ohne Pfad), live mit bot', () => {
    const { p, aggregator, events } = setup()
    assert.equal(p.handle(caddyLine({ ts: T, ua: 'Mozilla/5.0 (compatible; bingbot/2.0)', uri: '/geheim/pfad' })), 'bot')
    assert.equal(events[0]![1].bot, true)
    const [row] = aggregator.peek()
    assert.equal(row!.bot, true)
    assert.equal(row!.path, '')
    assert.equal(row!.visitors, 0)
  })

  test('Healthcheck und statische Dateien nur live; Seite nur aus Dateien zählt sie', () => {
    const { p, aggregator } = setup()
    // Noch keine HTML-Seite gesehen: Datei zählt
    assert.equal(p.handle(caddyLine({ ts: T, uri: '/bericht.pdf', contentType: 'application/pdf' })), 'page')
    // Erste Seite → ab jetzt zählen Dateien nicht mehr
    assert.equal(p.handle(caddyLine({ ts: T, uri: '/' })), 'page')
    assert.equal(p.handle(caddyLine({ ts: T, uri: '/app.js', contentType: 'text/javascript' })), 'live')
    assert.equal(p.handle(caddyLine({ ts: T, uri: '/health', contentType: 'application/json' })), 'live')
    assert.equal(aggregator.peek().reduce((n, r) => n + r.views, 0), 2)
  })

  test('unbekannter Name und fremde Logger: nichts', () => {
    const { p, events } = setup()
    assert.equal(p.handle(caddyLine({ host: 'airlock.int.example.ch' })), 'unknown')
    assert.equal(p.handle(caddyLine({ logger: 'http.log.access.airlock' })), 'unknown')
    assert.equal(events.length, 0)
  })

  test('404 bleibt mit Pfad (kaputte Links), Status gezählt', () => {
    const { p, aggregator } = setup()
    p.handle(caddyLine({ ts: T, uri: '/alt', status: 404 }))
    assert.deepEqual(aggregator.peek().map((r) => [r.path, r.status]), [['/alt', 404]])
  })
})
