import {
  INTERNAL_REFERRER, TRAFFIC_WAYS, TRAFFIC_RETENTION_MONTHS, isDatacenterAsn, isScannerPath, splitCampaign, splitNetwork, trafficRange, trafficResolution,
  type TrafficBucket, type TrafficCampaignDto, type TrafficCountsDto, type TrafficDim, type TrafficNetworkDto, type TrafficPointDto, type TrafficRange,
  type TrafficRowDto, type TrafficSourceDto, type TrafficSummaryDto, type TrafficWay,
} from './traffic.js'
import { addDays } from './status.js'

/**
 * Rein: Stundenzähler eines Projekts → Auswertung für Oberfläche und MCP.
 * Bekommt die Zeilen des Zeitraums (Datenbank plus noch nicht geschriebene
 * aus dem Speicher) und rechnet Summen, Kurve und Ranglisten. Liegt in
 * shared, damit die Bilder der Oberfläche (design-shots) mit derselben
 * Rechnung entstehen wie die echte Antwort.
 *
 * Begriffe:
 * - Aufrufe: Seitenaufrufe von Menschen mit Status 2xx/3xx. 404 und andere
 *   Fehler stehen getrennt («Nicht gefunden», 5xx), Bots ebenso.
 * - Besucher: je Zeile die Besucher, deren erster erfolgreicher Aufruf des
 *   Tages darauf fiel. Summen über Stunden und Tage ergeben Besucher je Tag,
 *   aufaddiert über den Zeitraum (wer an zwei Tagen kommt, zählt zweimal –
 *   ohne dauerhafte Kennung geht es nicht anders).
 * - Messbeginn: vorher gibt es keine Zahlen. Die Kurve beginnt dort statt
 *   mit Nullen, ein Vergleich mit dem Vorzeitraum erscheint nur, wenn dieser
 *   ganz gemessen ist.
 */

export const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
export const hourStart = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS

/** Tag in der Zeitzone der Anzeige als «JJJJ-MM-TT» */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

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

/** Erster des Monats von «JJJJ-MM-TT» plus n Monate (ohne Zeitzone, reine Datumsrechnung) */
export function addMonths(day: string, n: number): string {
  const [y, m] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1 + n, 1)).toISOString().slice(0, 10)
}

/** Beginn des heutigen Tages (Ortszeit) */
export const startOfToday = (now: number, timeZone: string) => localMidnight(localDay(now, timeZone), timeZone)

/**
 * Erster Zeitpunkt eines Zeitraums: Heute ab Mitternacht, 24 Std. ab der
 * Stunde vor 23 Std., 7/30 Tage ab Mitternacht vor 6/29 Tagen, 12 Monate
 * ab dem Ersten des Monats vor 11 Monaten (alles Ortszeit).
 */
export function rangeStart(range: TrafficRange, now: number, timeZone: string): number {
  const today = localDay(now, timeZone)
  switch (range) {
    case 'today': return localMidnight(today, timeZone)
    case '24h': return hourStart(now) - 23 * HOUR_MS
    case '12m': return localMidnight(addMonths(today, -11), timeZone)
    default: return localMidnight(addDays(today, -(trafficRange(range).days - 1)), timeZone)
  }
}

/** Beginn der Stunde, des Tages, der Woche (Montag) bzw. des Monats, in dem ms liegt */
export function bucketStart(ms: number, bucket: TrafficBucket, timeZone: string): number {
  if (bucket === 'hour') return hourStart(ms)
  const day = localDay(ms, timeZone)
  if (bucket === 'day') return localMidnight(day, timeZone)
  if (bucket === 'month') return localMidnight(`${day.slice(0, 8)}01`, timeZone)
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
  return localMidnight(addDays(day, -weekday), timeZone)
}

/** Beginn des nächsten Abschnitts nach start (start ist selbst ein Abschnittsbeginn) */
export function nextBucket(start: number, bucket: TrafficBucket, timeZone: string): number {
  if (bucket === 'hour') return start + HOUR_MS
  const day = localDay(start, timeZone)
  if (bucket === 'day') return localMidnight(addDays(day, 1), timeZone)
  if (bucket === 'week') return localMidnight(addDays(day, 7), timeZone)
  return localMidnight(addMonths(day, 1), timeZone)
}

/** Derselbe Zeitpunkt (Uhrzeit, Ortszeit) n Tage früher */
export function daysBefore(ms: number, n: number, timeZone: string): number {
  const back = ms - n * DAY_MS
  return back + (tzOffset(ms, timeZone) - tzOffset(back, timeZone))
}

/** Zeile von traffic_hourly (hour in ms, Beginn der Stunde UTC) */
export interface TrafficHourRow {
  hour: number
  way: TrafficWay
  path: string
  country: string
  city: string
  referrer: string
  device: string
  status: number
  bot: boolean
  views: number
  visitors: number
}

/** Zeile von traffic_dims */
export interface TrafficDimRow {
  hour: number
  way: TrafficWay
  dim: TrafficDim
  value: string
  bot: boolean
  views: number
  visitors: number
}

export interface SummarizeOptions {
  range: TrafficRange
  way: TrafficWay | 'all'
  now: number
  timeZone: string
  source: TrafficSourceDto
  /** Namen von Airlock selbst (Oberfläche, Statusseite): als Referrer ausgeblendet */
  hiddenReferrers?: ReadonlySet<string>
  /** Länge der Ranglisten (Seiten, Referrer, …) */
  limit?: number
}

/** Erfolgreicher Aufruf (2xx/3xx) */
export const isOkStatus = (status: number) => status > 0 && status < 400

function top<T extends { views: number; visitors: number }>(rows: T[], key: (r: T) => string, limit: number): TrafficRowDto[] {
  const m = new Map<string, TrafficRowDto>()
  for (const r of rows) {
    const k = key(r)
    const e = m.get(k) ?? { key: k, views: 0, visitors: 0 }
    e.views += r.views
    e.visitors += r.visitors
    m.set(k, e)
  }
  return [...m.values()].filter((e) => e.views > 0).sort((a, b) => b.views - a.views || b.visitors - a.visitors || a.key.localeCompare(b.key)).slice(0, limit)
}

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0)
const zero = (): TrafficCountsDto => ({ views: 0, visitors: 0, notFound: 0, bots: 0 })

/** Zähler einer Menge von Stundenzeilen */
function counts(rows: TrafficHourRow[]): TrafficCountsDto & { requests: number; serverErrors: number; pagesPerVisit: number | null } {
  const people = rows.filter((x) => !x.bot)
  const views = sum(people.filter((x) => isOkStatus(x.status)), (x) => x.views)
  const visitors = sum(people, (x) => x.visitors)
  return {
    views,
    visitors,
    notFound: sum(people.filter((x) => x.status === 404), (x) => x.views),
    bots: sum(rows.filter((x) => x.bot), (x) => x.views),
    requests: sum(people, (x) => x.views),
    serverErrors: sum(people.filter((x) => x.status >= 500), (x) => x.views),
    pagesPerVisit: visitors > 0 ? views / visitors : null,
  }
}

function addTo(c: TrafficCountsDto, x: TrafficHourRow): void {
  if (x.bot) {
    c.bots += x.views
    return
  }
  if (isOkStatus(x.status)) c.views += x.views
  if (x.status === 404) c.notFound += x.views
  c.visitors += x.visitors
}

export function summarize(all: TrafficHourRow[], dims: TrafficDimRow[], o: SummarizeOptions): TrafficSummaryDto {
  const tz = o.timeZone
  const from = rangeStart(o.range, o.now, tz)
  const limit = o.limit ?? 100
  const since = o.source.since ? Date.parse(o.source.since) : null
  const bucket = trafficResolution(o.range, { from, now: o.now, since })
  const sel = (x: { way: TrafficWay }) => o.way === 'all' || x.way === o.way
  const within = (x: { hour: number }) => x.hour >= hourStart(from) && x.hour <= o.now

  const inRange = all.filter(within)
  const rows = inRange.filter(sel)
  const people = rows.filter((x) => !x.bot)
  const ok = people.filter((x) => isOkStatus(x.status))
  const totals = counts(rows)

  // Vorzeitraum: gleich lang, gleiche Uhrzeit; nur wenn ganz gemessen und noch aufbewahrt
  let previous: TrafficSummaryDto['previous'] = null
  if (o.range !== '12m' && since !== null) {
    const days = trafficRange(o.range).days
    const prevFrom = daysBefore(from, days, tz)
    const prevTo = daysBefore(o.now, days, tz)
    const kept = o.now - TRAFFIC_RETENTION_MONTHS * 30 * DAY_MS
    if (since <= prevFrom && prevFrom >= kept) {
      const c = counts(all.filter((x) => sel(x) && x.hour >= hourStart(prevFrom) && x.hour <= prevTo))
      previous = { views: c.views, visitors: c.visitors, notFound: c.notFound, bots: c.bots, pagesPerVisit: c.pagesPerVisit }
    }
  }

  // Kurve: ab Messbeginn (nie Nullen für nicht gemessene Zeit), lückenlos bis jetzt
  const series: TrafficPointDto[] = []
  if (since !== null) {
    const index = new Map<number, number>()
    let b = bucketStart(Math.max(from, since), bucket, tz)
    for (let i = 0; i < 2000 && b <= o.now; i++) {
      const end = nextBucket(b, bucket, tz)
      index.set(b, series.length)
      series.push({
        at: new Date(b).toISOString(), end: new Date(end).toISOString(), ...zero(),
        ways: { public: zero(), tailnet: zero(), lan: zero() },
      })
      b = end
    }
    const startCache = new Map<number, number>()
    for (const x of rows) {
      let s = startCache.get(x.hour)
      if (s === undefined) {
        s = bucketStart(x.hour, bucket, tz)
        startCache.set(x.hour, s)
      }
      // Zeilen vor dem ersten Abschnitt (älter als der gespeicherte Messbeginn) in den ersten
      const p = series[index.get(s) ?? (s < Date.parse(series[0]?.at ?? '0') ? 0 : -1)]
      if (!p) continue
      addTo(p, x)
      addTo(p.ways[x.way], x)
    }
  }

  // Referrer: Klicks innerhalb der Seite und Namen von Airlock selbst ausblenden (und zählen)
  const hidden = o.hiddenReferrers ?? new Set<string>()
  const internal = ok.filter((x) => x.referrer === INTERNAL_REFERRER)
  const airlock = ok.filter((x) => x.referrer !== INTERNAL_REFERRER && hidden.has(x.referrer))
  const outside = ok.filter((x) => x.referrer !== INTERNAL_REFERRER && !hidden.has(x.referrer))

  // Länder und Städte gibt es nur für Anfragen aus dem Internet (CF-IPCountry, DB-IP, Cloudflare)
  const internet = ok.filter((x) => x.way === 'public')
  const cityRows = internet.filter((x) => x.city)
  const cityCountry = new Map<string, string>()
  for (const x of cityRows) cityCountry.set(x.city, cityCountry.get(x.city) ?? x.country)

  const statuses = new Map<number, number>()
  for (const x of people) statuses.set(x.status, (statuses.get(x.status) ?? 0) + x.views)

  // Merkmale aus traffic_dims
  const dimRows = dims.filter((x) => within(x) && sel(x))
  const ofDim = (d: TrafficDim, bot = false) => dimRows.filter((x) => x.dim === d && x.bot === bot)

  const nets = new Map<number, TrafficNetworkDto>()
  for (const x of dimRows.filter((r) => r.dim === 'asn')) {
    const { asn, name } = splitNetwork(x.value)
    if (!asn) continue
    const e = nets.get(asn) ?? { asn, name, views: 0, bots: 0, datacenter: isDatacenterAsn(asn) }
    if (x.bot) e.bots += x.views
    else e.views += x.views
    if (!e.name) e.name = name
    nets.set(asn, e)
  }
  const campaigns: TrafficCampaignDto[] = top(ofDim('utm'), (x) => x.value, limit).map((r) => ({ ...splitCampaign(r.key), views: r.views, visitors: r.visitors }))

  return {
    range: o.range,
    way: o.way,
    from: new Date(from).toISOString(),
    to: new Date(o.now).toISOString(),
    bucket,
    measuredFrom: since !== null && since > from ? new Date(since).toISOString() : null,
    totals,
    previous,
    ways: TRAFFIC_WAYS.map((w) => {
      const of = inRange.filter((x) => !x.bot && x.way === w)
      return { way: w, views: sum(of.filter((x) => isOkStatus(x.status)), (x) => x.views), visitors: sum(of, (x) => x.visitors) }
    }),
    series,
    pages: top(ok, (x) => x.path, limit),
    entries: top(ofDim('entry'), (x) => x.value, limit),
    exits: top(ofDim('exit'), (x) => x.value, limit),
    notFound: top(people.filter((x) => x.status === 404), (x) => x.path, limit).map((r) => ({ ...r, scanner: isScannerPath(r.key) })),
    referrers: top(outside, (x) => x.referrer, limit),
    referrersHidden: { internal: sum(internal, (x) => x.views), airlock: sum(airlock, (x) => x.views) },
    // Alle Länder (für die Karte), sortiert
    countries: top(internet, (x) => x.country, 300),
    cities: top(cityRows, (x) => `${x.city}\u0001${x.country}`, 30).map((c) => {
      const [city, country] = c.key.split('\u0001')
      return { ...c, key: city!, country: country ?? cityCountry.get(city!) ?? '' }
    }),
    devices: top(ok, (x) => x.device, 5),
    browsers: top(ofDim('browser'), (x) => x.value, 30),
    systems: top(ofDim('os'), (x) => x.value, 30),
    languages: top(ofDim('lang'), (x) => x.value, 30),
    networks: [...nets.values()].sort((a, b) => b.views - a.views || b.bots - a.bots || a.asn - b.asn).slice(0, 30),
    campaigns,
    statuses: [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([status, views]) => ({ status, views })),
    source: o.source,
  }
}
