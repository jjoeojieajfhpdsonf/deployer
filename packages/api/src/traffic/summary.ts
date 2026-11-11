import {
  TRAFFIC_WAYS, TRAFFIC_WAY_LABEL, TRAFFIC_DEVICE_LABEL, countryName, trafficRange,
  type TrafficRange, type TrafficRowDto, type TrafficSourceDto, type TrafficSummaryDto, type TrafficWay, type TrafficDevice,
} from '@airlock/shared'
import { HOUR, hourOf, type TrafficCount } from './aggregate.js'
import { localDay } from './visitor.js'

/**
 * Rein: Stundenzähler eines Projekts → Auswertung für Oberfläche und MCP.
 * Bekommt die Zeilen des Zeitraums (Datenbank plus noch nicht geschriebene
 * aus dem Speicher) und rechnet Summen, Kurve und Ranglisten.
 *
 * Besucher: jede Zeile zählt Besucher bei ihrer ersten Anfrage des Tages.
 * Summen über Stunden und Tage ergeben so Besucher je Tag, aufaddiert über
 * den Zeitraum (wer an zwei Tagen kommt, zählt zweimal – ohne dauerhafte
 * Kennung geht es nicht anders). Ranglisten ordnen Besucher der Seite, dem
 * Land usw. ihrer ersten Anfrage des Tages zu.
 */

/** Versatz der Zeitzone zu UTC in ms zum Zeitpunkt ms */
export function tzOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** Mitternacht (Ortszeit) des Tages «JJJJ-MM-TT», als ms */
export function localMidnight(day: string, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y!, m! - 1, d!)
  const first = guess - tzOffset(guess, timeZone)
  return guess - tzOffset(first, timeZone)
}

/** Beginn des heutigen Tages (Ortszeit) */
export const startOfToday = (now: number, timeZone: string) => localMidnight(localDay(now, timeZone), timeZone)

/** Erster Zeitpunkt, den ein Zeitraum umfasst: 24 Std. ab der Stunde vor 23 Std., Tage ab Mitternacht */
export function rangeStart(range: TrafficRange, now: number, timeZone: string): number {
  const r = trafficRange(range)
  if (r.bucket === 'hour') return hourOf(now) - (r.hours - 1) * HOUR
  const days = r.hours / 24
  const today = startOfToday(now, timeZone)
  // Tageweise zurück über Mitternacht (Sommerzeit: 23 oder 25 Stunden)
  let start = today
  for (let i = 1; i < days; i++) start = localMidnight(localDay(start - 12 * HOUR, timeZone), timeZone)
  return start
}

type Row = Pick<TrafficCount, 'hour' | 'way' | 'path' | 'country' | 'city' | 'referrer' | 'device' | 'status' | 'bot' | 'views' | 'visitors'>

function top(rows: Row[], key: (r: Row) => string, limit: number): TrafficRowDto[] {
  const m = new Map<string, TrafficRowDto>()
  for (const r of rows) {
    const k = key(r)
    const e = m.get(k) ?? { key: k, views: 0, visitors: 0 }
    e.views += r.views
    e.visitors += r.visitors
    m.set(k, e)
  }
  return [...m.values()].sort((a, b) => b.views - a.views || b.visitors - a.visitors || a.key.localeCompare(b.key)).slice(0, limit)
}

const sum = (rows: Row[], f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0)

export function summarize(
  all: Row[],
  o: { range: TrafficRange; way: TrafficWay | 'all'; now: number; timeZone: string; source: TrafficSourceDto; limit?: number },
): TrafficSummaryDto {
  const r = trafficRange(o.range)
  const from = rangeStart(r.key, o.now, o.timeZone)
  const limit = o.limit ?? 10
  const inRange = all.filter((x) => x.hour >= from && x.hour <= o.now)
  const people = inRange.filter((x) => !x.bot)
  const rows = o.way === 'all' ? people : people.filter((x) => x.way === o.way)
  const bots = inRange.filter((x) => x.bot && (o.way === 'all' || x.way === o.way))

  // Kurve: lückenlos, auch Stunden bzw. Tage ohne Aufruf
  const series: TrafficSummaryDto['series'] = []
  if (r.bucket === 'hour') {
    const byHour = new Map<number, { views: number; visitors: number }>()
    for (const x of rows) {
      const e = byHour.get(x.hour) ?? { views: 0, visitors: 0 }
      e.views += x.views
      e.visitors += x.visitors
      byHour.set(x.hour, e)
    }
    for (let h = from; h <= hourOf(o.now); h += HOUR) series.push({ at: new Date(h).toISOString(), ...(byHour.get(h) ?? { views: 0, visitors: 0 }) })
  } else {
    const byDay = new Map<string, { views: number; visitors: number }>()
    for (const x of rows) {
      const d = localDay(x.hour, o.timeZone)
      const e = byDay.get(d) ?? { views: 0, visitors: 0 }
      e.views += x.views
      e.visitors += x.visitors
      byDay.set(d, e)
    }
    let day = localDay(from, o.timeZone)
    const last = localDay(o.now, o.timeZone)
    for (let i = 0; i < 400 && day <= last; i++) {
      const at = localMidnight(day, o.timeZone)
      series.push({ at: new Date(at).toISOString(), ...(byDay.get(day) ?? { views: 0, visitors: 0 }) })
      day = localDay(at + 36 * HOUR, o.timeZone)
    }
  }

  // Länder und Städte gibt es nur für Anfragen aus dem Internet (CF-IPCountry, DB-IP)
  const internet = rows.filter((x) => x.way === 'public')
  const cityRows = internet.filter((x) => x.city)
  const cityCountry = new Map<string, string>()
  for (const x of cityRows) cityCountry.set(x.city, cityCountry.get(x.city) ?? x.country)

  const statuses = new Map<number, number>()
  for (const x of rows) statuses.set(x.status, (statuses.get(x.status) ?? 0) + x.views)

  return {
    range: r.key,
    way: o.way,
    from: new Date(from).toISOString(),
    to: new Date(o.now).toISOString(),
    bucket: r.bucket,
    totals: { views: sum(rows, (x) => x.views), visitors: sum(rows, (x) => x.visitors), bots: sum(bots, (x) => x.views) },
    ways: TRAFFIC_WAYS.map((w) => {
      const of = people.filter((x) => x.way === w)
      return { way: w, views: sum(of, (x) => x.views), visitors: sum(of, (x) => x.visitors) }
    }),
    series,
    pages: top(rows, (x) => x.path, limit),
    referrers: top(rows, (x) => x.referrer, limit),
    // Alle Länder (für die Karte), sortiert
    countries: top(internet, (x) => x.country, 300),
    cities: top(cityRows, (x) => `${x.city}\u0001${x.country}`, limit).map((c) => {
      const [city, country] = c.key.split('\u0001')
      return { ...c, key: city!, country: country ?? cityCountry.get(city!) ?? '' }
    }),
    devices: top(rows, (x) => x.device, 5),
    statuses: [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([status, views]) => ({ status, views })),
    source: o.source,
  }
}

/**
 * Antwort des MCP-Werkzeugs get_traffic: dieselben Zahlen, als Wörter
 * statt Codes (Zugang, Länder), ohne Kurve über einzelne Stunden hinaus.
 */
export function mcpTraffic(project: string, s: TrafficSummaryDto) {
  const errors = s.statuses.filter((x) => x.status >= 400)
  return {
    project,
    range: s.range,
    from: s.from,
    to: s.to,
    views: s.totals.views,
    visitors: s.totals.visitors,
    bots_not_counted: s.totals.bots,
    by_access: Object.fromEntries(s.ways.map((w) => [TRAFFIC_WAY_LABEL[w.way], { views: w.views, visitors: w.visitors }])),
    series: s.series.map((p) => ({ at: p.at, views: p.views, visitors: p.visitors })),
    top_pages: s.pages.map((p) => ({ path: p.key, views: p.views, visitors: p.visitors })),
    referrers: s.referrers.map((p) => ({ source: p.key || 'direkt', views: p.views })),
    countries: s.countries.slice(0, 10).map((c) => ({ code: c.key || null, name: countryName(c.key), views: c.views, visitors: c.visitors })),
    ...(s.source.cityDb ? { cities: s.cities.map((c) => ({ city: c.key, country: c.country, views: c.views })) } : {}),
    devices: s.devices.map((d) => ({ device: TRAFFIC_DEVICE_LABEL[d.key as TrafficDevice] ?? d.key, views: d.views })),
    status_codes: Object.fromEntries(s.statuses.map((x) => [String(x.status), x.views])),
    errors: { client_4xx: errors.filter((x) => x.status < 500).reduce((n, x) => n + x.views, 0), server_5xx: errors.filter((x) => x.status >= 500).reduce((n, x) => n + x.views, 0) },
    note: s.source.ingest === 'ok'
      ? 'Aufrufe ohne Bots, eigene Prüfungen, Healthchecks und statische Dateien. Besucher: eindeutig je Tag (Hash mit Tagessalz, keine IP gespeichert), über den Zeitraum aufaddiert.'
      : s.source.ingest === 'waiting'
        ? 'Das Zugriffs-Log von Caddy ist eingerichtet, aber noch nicht lesbar (Volume caddy_access). Zahlen fehlen bis dahin.'
        : 'Die Besucher-Auswertung ist nicht eingerichtet (ACCESS_LOG_DIR leer).',
  }
}
