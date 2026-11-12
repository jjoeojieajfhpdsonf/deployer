import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { INTERNAL_REFERRER, TRAFFIC_SEP, type TrafficLiveEventDto } from '@airlock/shared'
import { TrafficAggregator, TrafficDimAggregator } from './aggregate.js'
import { TrafficProcessor, type HostInfo } from './ingest.js'
import { VisitorCounter } from './visitor.js'
import { MmdbReader, asnFromRecord, bufferSource, cityFromRecord } from './mmdb.js'
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
    assert.deepEqual(events, [['p1', { at: '2026-11-11T14:30:00.000Z', access: 'lan', host: 'foto.int.example.ch', service: 'web', status: 200, blocked: false, bot: false, page: true, path: '/galerie' }]])
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

  test('404 bleibt mit Pfad (kaputte Links), Status gezählt, aber kein Besucher', () => {
    const { p, aggregator } = setup()
    p.handle(caddyLine({ ts: T, uri: '/alt', status: 404 }))
    assert.deepEqual(aggregator.peek().map((r) => [r.path, r.status, r.visitors]), [['/alt', 404, 0]])
    // Danach eine Seite: jetzt erst zählt der Besucher
    p.handle(caddyLine({ ts: T + 5, uri: '/' }))
    assert.equal(aggregator.peek().find((r) => r.path === '/')!.visitors, 1)
  })
})

describe('Besucher-Ingest «Besucher neu»: Merkmale, Besuche, Herkunft', () => {
  const ASN_DB = new MmdbReader(bufferSource(buildMmdb([
    ['203.0.113.0/24', { autonomous_system_number: 13030, autonomous_system_organization: 'Init7 (Switzerland) Ltd.' }],
    ['198.51.100.0/24', { autonomous_system_number: 24940, autonomous_system_organization: 'Hetzner Online GmbH' }],
  ], { databaseType: 'DBIP-ASN-Lite (compat=GeoLite2-ASN)' })))

  function full(o: { city?: boolean } = {}) {
    const aggregator = new TrafficAggregator()
    const dims = new TrafficDimAggregator()
    const events: [string, TrafficLiveEventDto][] = []
    const measured: [string, number][] = []
    let cf = false
    const geo = o.city ? new MmdbReader(bufferSource(buildMmdb([['203.0.113.0/24', cityRecord('Winterthur', 'CH')]]))) : null
    const p = new TrafficProcessor({
      aggregator, dims,
      visitors: new VisitorCounter('Europe/Zurich', T * 1000),
      hosts: () => hosts,
      city: (ip) => (geo ? cityFromRecord(geo.get(ip)) : null),
      asn: (ip) => asnFromRecord(ASN_DB.get(ip)),
      hasPages: new Set(),
      emit: (id, e) => events.push([id, e]),
      measured: (id, at) => measured.push([id, at]),
      cfLocation: () => { cf = true },
    })
    return { p, aggregator, dims, events, measured, cf: () => cf }
  }
  const dimsOf = (d: TrafficDimAggregator, dim: string) => d.peek().filter((r) => r.dim === dim).map((r) => [r.value, r.views, r.visitors])

  test('Sprache, Browser, System, Netz und Kampagne je Aufruf; Query sonst nirgends', () => {
    const { p, dims, aggregator } = full()
    p.handle(caddyLine({
      ts: T, ip: '203.0.113.42', host: 'foto.example.ch', country: 'CH', uri: '/?utm_source=Newsletter&utm_medium=email&utm_campaign=herbst&email=geheim%40example.ch',
      headers: { 'Accept-Language': 'de-CH,de;q=0.9', 'Sec-Ch-Ua': '"Brave";v="131", "Chromium";v="131"', 'Sec-Ch-Ua-Platform': '"macOS"' },
    }))
    assert.deepEqual(dimsOf(dims, 'lang'), [['de-CH', 1, 1]])
    assert.deepEqual(dimsOf(dims, 'browser'), [['Brave 131', 1, 1]])
    assert.deepEqual(dimsOf(dims, 'os'), [['macOS', 1, 1]])
    assert.deepEqual(dimsOf(dims, 'asn'), [['13030 Init7 (Switzerland) Ltd.', 1, 1]])
    assert.deepEqual(dimsOf(dims, 'utm'), [[['newsletter', 'email', 'herbst'].join(TRAFFIC_SEP), 1, 1]])
    assert.deepEqual(dimsOf(dims, 'entry'), [['/', 1, 1]])
    assert.ok(!JSON.stringify([dims.peek(), aggregator.peek()]).includes('geheim'))
  })

  test('Browser aus Rechenzentrum: Bot (mit Netz), kein Aufruf, kein Besucher', () => {
    const { p, aggregator, dims, events } = full()
    assert.equal(p.handle(caddyLine({ ts: T, ip: '198.51.100.7', host: 'foto.example.ch', country: 'DE' })), 'bot')
    assert.equal(events[0]![1].bot, true)
    assert.deepEqual(aggregator.peek().map((r) => [r.bot, r.views, r.visitors]), [[true, 1, 0]])
    assert.deepEqual(dims.peek().map((r) => [r.dim, r.value, r.bot]), [['asn', '24940 Hetzner Online GmbH', true]])
  })

  test('Klick innerhalb der Seite: Referrer «intern», kein neuer Einstieg', () => {
    const { p, aggregator, dims } = full()
    p.handle(caddyLine({ ts: T, ip: '100.88.1.2', referer: 'https://www.google.com/' }))
    p.handle(caddyLine({ ts: T + 30, ip: '100.88.1.2', uri: '/galerie', referer: 'https://foto.int.example.ch/' }))
    assert.deepEqual(aggregator.peek().map((r) => [r.path, r.referrer, r.visitors]), [['/', 'google.com', 1], ['/galerie', INTERNAL_REFERRER, 0]])
    assert.deepEqual(dimsOf(dims, 'entry'), [['/', 1, 1]])
  })

  test('Ausstieg: nach 30 Min. ohne Aufruf zählt der letzte Pfad, in seiner Stunde', () => {
    const { p, dims } = full()
    p.handle(caddyLine({ ts: T, ip: '100.88.1.2' }))
    p.handle(caddyLine({ ts: T + 120, ip: '100.88.1.2', uri: '/kontakt' }))
    p.sweep(T * 1000 + 10 * 60_000)
    assert.deepEqual(dimsOf(dims, 'exit'), [])
    p.sweep(T * 1000 + 40 * 60_000)
    assert.deepEqual(dimsOf(dims, 'exit'), [['/kontakt', 1, 0]])
    assert.equal(dims.peek().find((r) => r.dim === 'exit')!.hour, Date.parse('2026-11-11T14:00:00Z'))
  })

  test('DNT oder Sec-GPC: gezählt wie alle (Aufruf, Besucher, Merkmale), aber ohne Einstieg/Ausstieg', () => {
    const { p, aggregator, dims } = full()
    p.handle(caddyLine({ ts: T, ip: '100.88.1.2', headers: { Dnt: '1' } }))
    p.handle(caddyLine({ ts: T, ip: '100.88.1.3', headers: { 'Sec-Gpc': '1' } }))
    p.closeAll()
    assert.equal(aggregator.peek()[0]!.views, 2)
    assert.equal(aggregator.peek()[0]!.visitors, 2)
    assert.equal(dimsOf(dims, 'browser')[0]![1], 2)
    assert.deepEqual(dimsOf(dims, 'entry'), [])
    assert.deepEqual(dimsOf(dims, 'exit'), [])
  })

  test('Cloudflare-Kopfzeilen: Stadt daraus statt aus DB-IP; Koordinaten und PLZ nirgends', () => {
    const { p, aggregator, events, cf } = full({ city: true })
    p.handle(caddyLine({
      ts: T, ip: '203.0.113.42', host: 'foto.example.ch', country: 'CH',
      headers: { 'Cf-Ipcity': 'Z%C3%BCrich', 'Cf-Region': 'Zurich', 'Cf-Iplatitude': '47.37', 'Cf-Iplongitude': '8.54', 'Cf-Postal-Code': '8001' },
    }))
    assert.equal(aggregator.peek()[0]!.city, 'Zürich')
    assert.equal(events[0]![1].city, 'Zürich')
    assert.equal(events[0]![1].country, 'CH')
    assert.equal(cf(), true)
    const dump = JSON.stringify([aggregator.peek(), events])
    for (const s of ['47.37', '8.54', '8001']) assert.ok(!dump.includes(s), s)
    // Ohne Cloudflare-Stadt: DB-IP
    p.handle(caddyLine({ ts: T, ip: '203.0.113.43', host: 'foto.example.ch', country: 'CH', uri: '/b' }))
    assert.equal(aggregator.peek().find((r) => r.path === '/b')!.city, 'Winterthur')
  })

  test('Messbeginn: jede gezählte oder live gemeldete Zeile meldet sich, eigene Prüfungen nicht', () => {
    const { p, measured } = full()
    p.handle(caddyLine({ ts: T, ua: 'airlock-probe (header)' }))
    p.handle(caddyLine({ ts: T + 1, uri: '/app.css', contentType: 'text/css' }))
    assert.deepEqual(measured, [['p1', (T + 1) * 1000]])
  })
})
