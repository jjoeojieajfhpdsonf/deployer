import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { INTERNAL_REFERRER, TRAFFIC_SEP, trafficResolution, type TrafficSourceDto } from '@airlock/shared'
import { HOUR, MAX_PATHS_PER_HOUR, OTHER_PATHS, OTHER_VALUES, MAX_VALUES_PER_HOUR, TrafficAggregator, TrafficDimAggregator, hourOf, type TrafficKey } from './aggregate.js'
import { bucketStart, localMidnight, mcpTraffic, nextBucket, rangeStart, startOfToday, summarize, tzOffset, type TrafficDimRow } from './summary.js'

const TZ = 'Europe/Zurich'
// Mittwoch, 11.11.2026, 15:30 Ortszeit
const NOW = Date.parse('2026-11-11T14:30:00Z')
const DAY = 24 * HOUR
const source = (since: string | null = '2026-10-01T00:00:00.000Z'): TrafficSourceDto => ({ ingest: 'ok', since, cityDb: null, asnDb: null, cfLocation: false })

const key = (o: Partial<TrafficKey> = {}): TrafficKey => ({
  projectId: 'p1', hour: hourOf(NOW), way: 'public', path: '/', country: 'CH', city: '', referrer: '', device: 'desktop', status: 200, bot: false, ...o,
})
const dim = (o: Partial<TrafficDimRow> & Pick<TrafficDimRow, 'dim' | 'value'>): TrafficDimRow => ({ hour: hourOf(NOW), way: 'public', bot: false, views: 1, visitors: 0, ...o })

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

  test('Merkmale: je Wert addiert, leere Werte nie, höchstens 200 Werte je Merkmal und Stunde', () => {
    const d = new TrafficDimAggregator()
    const k = { projectId: 'p1', hour: hourOf(NOW), way: 'public' as const, dim: 'lang' as const, bot: false }
    d.add({ ...k, value: 'de-CH' }, { visitors: 1 })
    d.add({ ...k, value: 'de-CH' })
    d.add({ ...k, value: '' })
    assert.deepEqual(d.peek().map((r) => [r.value, r.views, r.visitors]), [['de-CH', 2, 1]])
    for (let i = 0; i < MAX_VALUES_PER_HOUR + 5; i++) d.add({ ...k, dim: 'utm', value: `kampagne-${i}` })
    assert.equal(d.peek().find((r) => r.value === OTHER_VALUES)!.views, 5)
    const rows = d.drain()
    d.restore(rows)
    assert.equal(d.size, rows.length)
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
  test('Heute ab Mitternacht; 24 Std.; 7 und 30 Tage über die Zeitumstellung; 12 Monate ab dem Ersten', () => {
    assert.equal(new Date(rangeStart('today', NOW, TZ)).toISOString(), '2026-11-10T23:00:00.000Z')
    assert.equal(new Date(rangeStart('24h', NOW, TZ)).toISOString(), '2026-11-10T15:00:00.000Z')
    assert.equal(new Date(rangeStart('7d', NOW, TZ)).toISOString(), '2026-11-04T23:00:00.000Z')
    // 30 Tage über das Ende der Sommerzeit (25.10.2026)
    assert.equal(new Date(rangeStart('30d', NOW, TZ)).toISOString(), '2026-10-12T22:00:00.000Z')
    // 1.12.2025 Ortszeit
    assert.equal(new Date(rangeStart('12m', NOW, TZ)).toISOString(), '2025-11-30T23:00:00.000Z')
  })
  test('Abschnitte: Woche ab Montag, Monat ab dem Ersten, nächster Abschnitt über die Zeitumstellung', () => {
    assert.equal(new Date(bucketStart(NOW, 'week', TZ)).toISOString(), '2026-11-08T23:00:00.000Z')
    assert.equal(new Date(bucketStart(NOW, 'month', TZ)).toISOString(), '2026-10-31T23:00:00.000Z')
    // Sonntag 25.10.2026: Ende der Sommerzeit, der Tag hat 25 Stunden
    const sun = localMidnight('2026-10-25', TZ)
    assert.equal(nextBucket(sun, 'day', TZ) - sun, 25 * HOUR)
    assert.equal(new Date(nextBucket(localMidnight('2026-10-01', TZ), 'month', TZ)).toISOString(), '2026-10-31T23:00:00.000Z')
  })
})

describe('Besucher: Auflösung (trafficResolution)', () => {
  const from = (r: Parameters<typeof rangeStart>[0]) => rangeStart(r, NOW, TZ)
  const at = (r: Parameters<typeof rangeStart>[0], since: number | null) => trafficResolution(r, { from: from(r), now: NOW, since })
  test('Heute und 24 Std.: immer Stunden', () => {
    assert.equal(at('today', NOW - 300 * DAY), 'hour')
    assert.equal(at('24h', null), 'hour')
  })
  test('7/30 Tage: Stunden, solange weniger als 7 Tage gemessen sind, sonst Tage', () => {
    assert.equal(at('7d', NOW - 27 * HOUR), 'hour')
    assert.equal(at('30d', NOW - 6 * DAY), 'hour')
    assert.equal(at('30d', NOW - 8 * DAY), 'day')
    // Ganzer Zeitraum gemessen
    assert.equal(at('7d', from('7d') - DAY), 'day')
    assert.equal(at('7d', from('7d')), 'day')
  })
  test('12 Monate: Monate; jung gemessen Stunden, Tage, Wochen', () => {
    assert.equal(at('12m', NOW - 2 * DAY), 'hour')
    assert.equal(at('12m', NOW - 20 * DAY), 'day')
    assert.equal(at('12m', NOW - 100 * DAY), 'week')
    assert.equal(at('12m', NOW - 250 * DAY), 'month')
    assert.equal(at('12m', from('12m') - DAY), 'month')
  })
})

describe('Besucher: Auswertung', () => {
  const rows = [
    { ...key({ path: '/', country: 'CH', city: 'Zürich', referrer: 'google.com' }), views: 10, visitors: 6 },
    { ...key({ path: '/blog', country: 'DE', referrer: '' }), views: 4, visitors: 2 },
    { ...key({ path: '/blog', country: 'DE', referrer: INTERNAL_REFERRER }), views: 7, visitors: 0 },
    { ...key({ path: '/', referrer: 'deployer.int.example.ch' }), views: 3, visitors: 1 },
    { ...key({ path: '/wp-login.php', country: 'DE', status: 404 }), views: 3, visitors: 0 },
    { ...key({ path: '/alt', country: 'DE', status: 404 }), views: 1, visitors: 0 },
    { ...key({ way: 'tailnet', path: '/', country: '', device: 'mobile', hour: hourOf(NOW) - 2 * HOUR }), views: 5, visitors: 1 },
    { ...key({ way: 'lan', path: '/admin', country: '', status: 500, hour: hourOf(NOW) - 30 * HOUR }), views: 2, visitors: 0 },
    { ...key({ path: '', country: '', device: '', bot: true }), views: 50, visitors: 0 },
  ]
  const hidden = new Set(['deployer.int.example.ch'])

  test('Kennzahlen: Aufrufe nur 2xx/3xx, 404 und 5xx getrennt, Bots getrennt, Seiten pro Besucher', () => {
    const s = summarize(rows, [], { range: 'today', way: 'all', now: NOW, timeZone: TZ, source: source() })
    assert.equal(s.totals.views, 29)
    assert.equal(s.totals.visitors, 10)
    assert.equal(s.totals.notFound, 4)
    assert.equal(s.totals.bots, 50)
    assert.equal(s.totals.serverErrors, 0)
    assert.equal(s.totals.requests, 33)
    assert.equal(s.totals.pagesPerVisit, 2.9)
    assert.deepEqual(s.ways.map((w) => [w.way, w.views]), [['public', 24], ['tailnet', 5], ['lan', 0]])
  })

  test('Punkt 9: Summe der Seiten = Aufrufe; Woher ohne Klicks innerhalb der Seite und ohne Airlock selbst', () => {
    const s = summarize(rows, [], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source(), hiddenReferrers: hidden })
    assert.equal(s.pages.reduce((n, p) => n + p.views, 0), s.totals.views)
    assert.deepEqual(s.pages.map((p) => [p.key, p.views]), [['/', 18], ['/blog', 11]])
    assert.deepEqual(s.referrers.map((p) => [p.key, p.views, p.visitors]), [['google.com', 10, 6], ['', 9, 3]])
    assert.deepEqual(s.referrersHidden, { internal: 7, airlock: 3 })
    // Woher + ausgeblendet = Aufrufe
    assert.equal(s.referrers.reduce((n, p) => n + p.views, 0) + s.referrersHidden.internal + s.referrersHidden.airlock, s.totals.views)
  })

  test('Nicht gefunden: 404-Pfade mit Scanner-Hinweis; Statuscodes aller Anfragen von Menschen', () => {
    const s = summarize(rows, [], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source() })
    assert.deepEqual(s.notFound.map((p) => [p.key, p.views, p.scanner]), [['/wp-login.php', 3, true], ['/alt', 1, false]])
    assert.equal(s.totals.serverErrors, 2)
    assert.deepEqual(s.statuses, [{ status: 200, views: 29 }, { status: 404, views: 4 }, { status: 500, views: 2 }])
  })

  test('Länder nur aus dem Internet und nur erfolgreiche Aufrufe; Städte mit Land', () => {
    const s = summarize(rows, [], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source() })
    assert.deepEqual(s.countries.map((c) => [c.key, c.views]), [['CH', 13], ['DE', 11]])
    assert.deepEqual(s.cities, [{ key: 'Zürich', country: 'CH', views: 10, visitors: 6 }])
    assert.deepEqual(s.devices.map((d) => d.key), ['desktop', 'mobile'])
  })

  test('7 Tage, ganz gemessen: Tageswerte in Ortszeit, lückenlos, mit Aufteilung nach Zugang', () => {
    const s = summarize(rows, [], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source() })
    assert.equal(s.bucket, 'day')
    assert.equal(s.measuredFrom, null)
    assert.equal(s.series.length, 7)
    assert.equal(s.series[0]!.at, '2026-11-04T23:00:00.000Z')
    assert.equal(s.series[0]!.end, '2026-11-05T23:00:00.000Z')
    const today = s.series[6]!
    assert.equal(today.views, 29)
    assert.equal(today.notFound, 4)
    assert.equal(today.bots, 50)
    assert.deepEqual([today.ways.public.views, today.ways.tailnet.views, today.ways.lan.views], [24, 5, 0])
  })

  test('Messbeginn im Zeitraum: Kurve beginnt dort (Stunden), nie Nullen davor, kein Vorzeitraum', () => {
    const since = '2026-11-10T18:40:00.000Z'
    const s = summarize(rows, [], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source(since) })
    assert.equal(s.bucket, 'hour')
    assert.equal(s.measuredFrom, since)
    assert.equal(s.series[0]!.at, '2026-11-10T18:00:00.000Z')
    assert.equal(s.series.at(-1)!.at, '2026-11-11T14:00:00.000Z')
    assert.equal(s.series.length, 21)
    assert.equal(s.previous, null)
  })

  test('nie gemessen: keine Kurve', () => {
    const s = summarize([], [], { range: '30d', way: 'all', now: NOW, timeZone: TZ, source: source(null) })
    assert.deepEqual(s.series, [])
    assert.equal(s.previous, null)
  })

  test('Vorzeitraum nur, wenn ganz gemessen: gleiche Uhrzeit am Vortag', () => {
    const yesterday = [
      { ...key({ hour: hourOf(NOW) - DAY }), views: 8, visitors: 4 },
      // nach der gleichen Uhrzeit gestern: zählt nicht
      { ...key({ hour: hourOf(NOW) - DAY + 2 * HOUR }), views: 100, visitors: 50 },
    ]
    const s = summarize([...rows, ...yesterday], [], { range: 'today', way: 'all', now: NOW, timeZone: TZ, source: source() })
    assert.deepEqual(s.previous, { views: 8, visitors: 4, notFound: 0, bots: 0, pagesPerVisit: 2 })
    // Messbeginn gestern Mittag: Vortag nicht ganz gemessen
    const late = summarize([...rows, ...yesterday], [], { range: 'today', way: 'all', now: NOW, timeZone: TZ, source: source('2026-11-10T11:00:00.000Z') })
    assert.equal(late.previous, null)
    // 12 Monate: nie (Aufbewahrung 13 Monate)
    assert.equal(summarize(rows, [], { range: '12m', way: 'all', now: NOW, timeZone: TZ, source: source('2020-01-01T00:00:00.000Z') }).previous, null)
  })

  test('12 Monate, ganz gemessen: Monate', () => {
    const s = summarize(rows, [], { range: '12m', way: 'all', now: NOW, timeZone: TZ, source: source('2025-01-01T00:00:00.000Z') })
    assert.equal(s.bucket, 'month')
    assert.equal(s.series.length, 12)
    assert.equal(s.series.at(-1)!.views, 29 + 0)
  })

  test('nach Zugang trennen: Tailnet ohne Länder, Umschalter zeigen weiter alle Wege', () => {
    const s = summarize(rows, [], { range: '7d', way: 'tailnet', now: NOW, timeZone: TZ, source: source() })
    assert.equal(s.totals.views, 5)
    assert.equal(s.totals.visitors, 1)
    assert.equal(s.totals.bots, 0)
    assert.deepEqual(s.countries, [])
    assert.equal(s.ways.find((w) => w.way === 'public')!.views, 24)
  })

  test('Merkmale: Einstieg, Ausstieg, Sprache, Browser, System, Netz (Rechenzentrum markiert), Kampagnen', () => {
    const dims = [
      dim({ dim: 'entry', value: '/', views: 6 }), dim({ dim: 'entry', value: '/blog', views: 2 }),
      dim({ dim: 'exit', value: '/kontakt', views: 5 }),
      dim({ dim: 'lang', value: 'de-CH', views: 20 }), dim({ dim: 'lang', value: '?', views: 4 }),
      dim({ dim: 'browser', value: 'Safari 18', views: 14 }),
      dim({ dim: 'os', value: 'iOS 18', views: 9 }),
      dim({ dim: 'asn', value: '3303 Swisscom (Schweiz) AG', views: 12 }),
      dim({ dim: 'asn', value: '24940 Hetzner Online GmbH', views: 31, bot: true }),
      dim({ dim: 'utm', value: ['newsletter', 'email', 'herbst'].join(TRAFFIC_SEP), views: 3 }),
      dim({ dim: 'lang', value: 'fr-CH', views: 2, way: 'tailnet' }),
      dim({ dim: 'lang', value: 'en', views: 2, hour: hourOf(NOW) - 40 * DAY }),
    ]
    const s = summarize(rows, dims, { range: '7d', way: 'public', now: NOW, timeZone: TZ, source: source() })
    assert.deepEqual(s.entries.map((r) => [r.key, r.views]), [['/', 6], ['/blog', 2]])
    assert.deepEqual(s.exits.map((r) => r.key), ['/kontakt'])
    assert.deepEqual(s.languages.map((r) => [r.key, r.views]), [['de-CH', 20], ['?', 4]])
    assert.deepEqual(s.browsers.map((r) => r.key), ['Safari 18'])
    assert.deepEqual(s.systems.map((r) => r.key), ['iOS 18'])
    assert.deepEqual(s.networks, [
      { asn: 3303, name: 'Swisscom (Schweiz) AG', views: 12, bots: 0, datacenter: false },
      { asn: 24940, name: 'Hetzner Online GmbH', views: 0, bots: 31, datacenter: true },
    ])
    assert.deepEqual(s.campaigns, [{ source: 'newsletter', medium: 'email', campaign: 'herbst', views: 3, visitors: 0 }])
  })
})

describe('Besucher: MCP get_traffic', () => {
  const rows = [
    { ...key({ path: '/', country: 'CH', city: 'Zürich', referrer: 'google.com' }), views: 10, visitors: 6 },
    { ...key({ path: '/blog', country: 'DE', referrer: '' }), views: 4, visitors: 2 },
    { ...key({ path: '/fehlt', country: 'DE', status: 404 }), views: 3, visitors: 0 },
    { ...key({ way: 'lan', path: '/admin', country: '', status: 500, hour: hourOf(NOW) - 30 * HOUR }), views: 2, visitors: 0 },
    { ...key({ path: '', country: '', device: '', bot: true }), views: 50, visitors: 0 },
  ]
  test('Wörter statt Codes, Fehler gezählt, Messbeginn und Auflösung, keine Städte ohne Zeilen, kein Netz ohne Datei', () => {
    const m = mcpTraffic('foto', summarize(rows, [dim({ dim: 'lang', value: 'de-CH', views: 14 })], { range: '7d', way: 'all', now: NOW, timeZone: TZ, source: source() }))
    assert.equal(m.project, 'foto')
    assert.equal(m.views, 14)
    assert.equal(m.not_found, 3)
    assert.equal(m.bots_not_counted, 50)
    assert.equal(m.resolution, 'day')
    assert.equal(m.measured_since, '2026-10-01T00:00:00.000Z')
    assert.deepEqual(m.by_access.Internet, { views: 14, visitors: 8 })
    assert.deepEqual(m.errors, { client_4xx: 3, server_5xx: 2 })
    assert.equal(m.countries[0]!.name, 'Schweiz')
    assert.equal(m.referrers[1]!.source, 'direkt / Lesezeichen')
    assert.deepEqual(m.languages, [{ language: 'Deutsch (Schweiz)', code: 'de-CH', views: 14 }])
    assert.equal(m.devices[0]!.device, 'Computer')
    assert.equal('networks' in m, false)
    assert.deepEqual((m as { cities?: unknown[] }).cities, [{ city: 'Zürich', country: 'CH', views: 10 }])
    const json = JSON.stringify(m)
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(json), 'keine IP-Adressen')
  })
})
