import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TrafficSourceDto } from '@airlock/shared'
import { HOUR, MAX_PATHS_PER_HOUR, OTHER_PATHS, TrafficAggregator, hourOf, type TrafficKey } from './aggregate.js'
import { localMidnight, mcpTraffic, rangeStart, startOfToday, summarize, tzOffset } from './summary.js'

const TZ = 'Europe/Zurich'
const NOW = Date.parse('2026-11-11T14:30:00Z')
const source: TrafficSourceDto = { ingest: 'ok', since: '2026-10-01T00:00:00.000Z', cityDb: null }

const key = (o: Partial<TrafficKey> = {}): TrafficKey => ({
  projectId: 'p1', hour: hourOf(NOW), way: 'public', path: '/', country: 'CH', city: '', referrer: '', device: 'desktop', status: 200, bot: false, ...o,
})

describe('Besucher: Aggregation im Speicher', () => {
  test('gleiche Merkmale addieren, verschiedene getrennt', () => {
    const a = new TrafficAggregator()
    a.add(key(), { views: 1, visitors: 1 })
    a.add(key(), { views: 1, visitors: 0 })
    a.add(key({ path: '/b' }))
    const rows = a.drain()
    assert.equal(rows.length, 2)
    const root = rows.find((r) => r.path === '/')!
    assert.equal(root.views, 2)
    assert.equal(root.visitors, 1)
    assert.equal(a.size, 0)
  })

  test('Flush gescheitert: restore legt alles zurück', () => {
    const a = new TrafficAggregator()
    a.add(key(), { views: 3, visitors: 2 })
    const rows = a.drain()
    a.restore(rows)
    a.add(key(), { views: 1, visitors: 0 })
    assert.deepEqual(a.peek().map((r) => [r.views, r.visitors]), [[4, 2]])
  })

  test('Pfad-Scanner: höchstens 300 Pfade je Projekt und Stunde, der Rest gesammelt', () => {
    const a = new TrafficAggregator()
    for (let i = 0; i < MAX_PATHS_PER_HOUR + 50; i++) a.add(key({ path: `/scan/${i}` }))
    const rows = a.peek()
    assert.equal(rows.length, MAX_PATHS_PER_HOUR + 1)
    assert.equal(rows.find((r) => r.path === OTHER_PATHS)!.views, 50)
    // anderes Projekt hat eigene Grenze
    a.add(key({ projectId: 'p2', path: '/neu' }))
    assert.ok(a.peek('p2').some((r) => r.path === '/neu'))
  })
})

describe('Besucher: Zeiträume in Ortszeit', () => {
  test('Versatz Zürich: Winter +1 h, Sommer +2 h', () => {
    assert.equal(tzOffset(NOW, TZ), HOUR)
    assert.equal(tzOffset(Date.parse('2026-07-01T12:00:00Z'), TZ), 2 * HOUR)
  })
  test('Mitternacht Ortszeit', () => {
    assert.equal(new Date(localMidnight('2026-11-11', TZ)).toISOString(), '2026-11-10T23:00:00.000Z')
    assert.equal(new Date(localMidnight('2026-07-01', TZ)).toISOString(), '2026-06-30T22:00:00.000Z')
    assert.equal(new Date(startOfToday(NOW, TZ)).toISOString(), '2026-11-10T23:00:00.000Z')
  })
  test('24 Std.: 24 volle Stunden bis zur laufenden; 7 Tage ab Mitternacht vor 6 Tagen (über die Zeitumstellung)', () => {
    assert.equal(new Date(rangeStart('24h', NOW, TZ)).toISOString(), '2026-11-10T15:00:00.000Z')
    assert.equal(new Date(rangeStart('7d', NOW, TZ)).toISOString(), '2026-11-04T23:00:00.000Z')
    // 30 Tage über das Ende der Sommerzeit (25.10.2026)
    assert.equal(new Date(rangeStart('30d', NOW, TZ)).toISOString(), '2026-10-12T22:00:00.000Z')
  })
})

describe('Besucher: Auswertung', () => {
  const rows = [
    { ...key({ path: '/', country: 'CH', city: 'Zürich', referrer: 'google.com' }), views: 10, visitors: 6 },
    { ...key({ path: '/blog', country: 'DE', referrer: '' }), views: 4, visitors: 2 },
    { ...key({ path: '/fehlt', country: 'DE', status: 404 }), views: 3, visitors: 0 },
    { ...key({ way: 'tailnet', path: '/', country: '', device: 'mobile', hour: hourOf(NOW) - 2 * HOUR }), views: 5, visitors: 1 },
    { ...key({ way: 'lan', path: '/admin', country: '', status: 500, hour: hourOf(NOW) - 30 * HOUR }), views: 2, visitors: 1 },
    { ...key({ path: '', country: '', device: '', bot: true }), views: 50, visitors: 0 },
  ]

  test('24 Std.: Summen ohne Bots, ohne Zeilen ausserhalb des Zeitraums', () => {
    const s = summarize(rows, { range: '24h', way: 'all', now: NOW, timeZone: TZ, source })
    assert.deepEqual(s.totals, { views: 22, visitors: 9, bots: 50 })
    assert.equal(s.bucket, 'hour')
    assert.equal(s.series.length, 24)
    assert.equal(s.series.at(-1)!.views, 17)
    assert.equal(s.series.at(-3)!.views, 5)
    assert.deepEqual(s.ways.map((w) => [w.way, w.views]), [['public', 17], ['tailnet', 5], ['lan', 0]])
  })

  test('Ranglisten: Seiten, Referrer (leer = direkt), Länder nur aus dem Internet, Statuscodes', () => {
    const s = summarize(rows, { range: '7d', way: 'all', now: NOW, timeZone: TZ, source })
    assert.deepEqual(s.pages.map((p) => [p.key, p.views]), [['/', 15], ['/blog', 4], ['/fehlt', 3], ['/admin', 2]])
    assert.deepEqual(s.referrers.map((p) => [p.key, p.views]), [['', 14], ['google.com', 10]])
    assert.deepEqual(s.countries.map((c) => [c.key, c.views]), [['CH', 10], ['DE', 7]])
    assert.deepEqual(s.cities, [{ key: 'Zürich', country: 'CH', views: 10, visitors: 6 }])
    assert.deepEqual(s.statuses, [{ status: 200, views: 19 }, { status: 404, views: 3 }, { status: 500, views: 2 }])
    assert.deepEqual(s.devices.map((d) => d.key), ['desktop', 'mobile'])
  })

  test('7 Tage: Tageswerte in Ortszeit, lückenlos', () => {
    const s = summarize(rows, { range: '7d', way: 'all', now: NOW, timeZone: TZ, source })
    assert.equal(s.bucket, 'day')
    assert.equal(s.series.length, 7)
    assert.equal(s.series[0]!.at, '2026-11-04T23:00:00.000Z')
    // 30 Std. zurück = 10.11., 09:30 Ortszeit
    assert.equal(s.series[5]!.views, 2)
    assert.equal(s.series[6]!.views, 22)
  })

  test('nach Zugang trennen: Tailnet ohne Länder', () => {
    const s = summarize(rows, { range: '7d', way: 'tailnet', now: NOW, timeZone: TZ, source })
    assert.deepEqual(s.totals, { views: 5, visitors: 1, bots: 0 })
    assert.deepEqual(s.countries, [])
    // Umschalter zeigen weiter alle Wege
    assert.equal(s.ways.find((w) => w.way === 'public')!.views, 17)
  })

  test('MCP get_traffic: Wörter statt Codes, Fehler gezählt, keine Städte ohne Datenbank', () => {
    const m = mcpTraffic('foto', summarize(rows, { range: '7d', way: 'all', now: NOW, timeZone: TZ, source }))
    assert.equal(m.project, 'foto')
    assert.equal(m.views, 24)
    assert.equal(m.bots_not_counted, 50)
    assert.deepEqual(m.by_access.Internet, { views: 17, visitors: 8 })
    assert.deepEqual(m.errors, { client_4xx: 3, server_5xx: 2 })
    assert.equal(m.countries[0]!.name, 'Schweiz')
    assert.equal(m.referrers[0]!.source, 'direkt')
    assert.equal('cities' in m, false)
    assert.equal(m.devices[0]!.device, 'Computer')
    const withCities = mcpTraffic('foto', summarize(rows, { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: { ...source, cityDb: '2026-11' } }))
    assert.deepEqual((withCities as { cities?: unknown[] }).cities, [{ city: 'Zürich', country: 'CH', views: 10 }])
  })
})
