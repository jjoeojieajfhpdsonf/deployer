/**
 * «Besucher neu»: Testdaten für Bilder und visuelle Tests. Statt fertiger
 * Summen entstehen stündliche Zähler (wie traffic_hourly und traffic_dims in
 * der Datenbank), ausgewertet mit derselben Rechnung wie die API (summarize
 * aus @airlock/shared) – so stimmen Summen, Listen und Kurve zusammen.
 *
 * Erfundene, aber plausible Zahlen einer kleinen öffentlichen Seite
 * (hallo-welt, haushalt) und interner Projekte (nur Tailnet und Heimnetz).
 * Deterministisch: fester Zufall je Stunde, Zeit aus Date.now() (in den
 * visuellen Tests die feste Uhr).
 */
import {
  INTERNAL_REFERRER, TRAFFIC_SEP, hourStart, summarize,
  type TrafficDimRow, type TrafficGeoSourcesDto, type TrafficHourRow, type TrafficLiveEventDto, type TrafficRange,
  type TrafficSourceDto, type TrafficSummaryDto, type TrafficWay, type TrafficDim,
} from '@airlock/shared'

/**
 * ok: gemessen seit 41 Tagen, ohne Städte- und Provider-Datei.
 * staedte: dazu Städte und Provider (DB-IP geladen).
 * jung: Messbeginn vor 18 Std. (Achse beginnt dort, Stunden statt Tage).
 * leer: gemessen, aber keine Aufrufe. wartet: Log fehlt noch. aus: nicht eingerichtet.
 */
export type TrafficVariant = 'ok' | 'staedte' | 'jung' | 'leer' | 'wartet' | 'aus'

const TZ = 'Europe/Zurich'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Tagesverlauf (Ortszeit-Stunde → Gewicht): nachts wenig, abends am meisten */
const HOUR_SHAPE = [2, 1, 1, 1, 1, 2, 4, 7, 9, 10, 10, 11, 12, 11, 10, 10, 11, 13, 15, 16, 14, 11, 7, 4]
/** Wochentag-Schwankung (So … Sa), fest */
const DAY_SHAPE = [0.71, 0.92, 1.04, 1.1, 0.97, 1.21, 0.78]

type W<T> = [T, number][]

/** Fester Zufall (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(r: () => number, list: W<T>): T {
  const total = list.reduce((a, [, w]) => a + w, 0)
  let x = r() * total
  for (const [v, w] of list) {
    x -= w
    if (x <= 0) return v
  }
  return list.at(-1)![0]
}

const localParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const PUBLIC_PAGES: W<string> = [['/', 0.41], ['/blog/homeserver-mit-airlock', 0.2], ['/blog/caddy-und-tailscale', 0.12], ['/projekte', 0.09], ['/kontakt', 0.06], ['/impressum', 0.04], ['/feed.xml', 0.03], ['/blog', 0.03], ['/ueber-mich', 0.02]]
const INTERNAL_PAGES: W<string> = [['/', 0.38], ['/alben/sommer-2026', 0.21], ['/alben/hochzeit', 0.14], ['/suche', 0.11], ['/alben/neu', 0.08], ['/einstellungen', 0.05], ['/alt/galerie', 0.03]]
const NOT_FOUND: W<string> = [['/wp-login.php', 0.3], ['/.env', 0.16], ['/blog/homeserver-mit-airlok', 0.14], ['/projekt', 0.12], ['/.git/config', 0.1], ['/xmlrpc.php', 0.08], ['/favicon.png', 0.06], ['/phpmyadmin/', 0.04]]
const PUBLIC_REFS: W<string> = [
  [INTERNAL_REFERRER, 0.42], ['', 0.22], ['google.com', 0.13], ['news.ycombinator.com', 0.06], ['duckduckgo.com', 0.04], ['github.com', 0.03],
  ['linkedin.com', 0.02], ['newsletter', 0.02], ['airlock.int.example.ch', 0.03], ['status.example.ch', 0.01],
]
const INTERNAL_REFS: W<string> = [[INTERNAL_REFERRER, 0.55], ['', 0.4], ['nas.int.example.ch', 0.03], ['airlock.int.example.ch', 0.02]]
const COUNTRIES: W<string> = [['CH', 0.5], ['DE', 0.19], ['US', 0.09], ['AT', 0.06], ['FR', 0.04], ['NL', 0.03], ['GB', 0.03], ['IT', 0.02], ['SE', 0.015], ['CA', 0.01], ['JP', 0.008], ['BR', 0.006], ['IN', 0.005], ['AU', 0.004], ['', 0.003]]
const CITIES: Record<string, W<string>> = {
  CH: [['Zürich', 0.36], ['Bern', 0.17], ['Basel', 0.13], ['Luzern', 0.09], ['Winterthur', 0.08], ['St. Gallen', 0.07], ['Genf', 0.05], ['Lausanne', 0.05]],
  DE: [['Berlin', 0.38], ['München', 0.26], ['Hamburg', 0.2], ['Köln', 0.16]],
  AT: [['Wien', 0.7], ['Graz', 0.3]],
  US: [['New York', 0.4], ['San Francisco', 0.35], ['Seattle', 0.25]],
}
const DEVICES: W<string> = [['desktop', 0.58], ['mobile', 0.37], ['tablet', 0.05]]
const LANGS: W<string> = [['de-CH', 0.48], ['de-DE', 0.19], ['en-US', 0.12], ['fr-CH', 0.06], ['en-GB', 0.05], ['de', 0.03], ['it-CH', 0.03], ['?', 0.04]]
const BROWSERS: W<string> = [['Safari 18', 0.3], ['Chrome 131', 0.27], ['Chrome 130', 0.07], ['Firefox 132', 0.1], ['Edge 131', 0.09], ['Safari 17', 0.06], ['Samsung Internet 26', 0.04], ['Brave 131', 0.03], ['?', 0.04]]
const SYSTEMS: W<string> = [['iOS 18', 0.29], ['macOS', 0.22], ['Windows', 0.13], ['Windows 11', 0.08], ['Android 14', 0.13], ['iOS 17', 0.05], ['Linux', 0.05], ['Android', 0.02], ['?', 0.03]]
const NETS: W<string> = [
  ['3303 Swisscom (Schweiz) AG', 0.34], ['13030 Init7 (Switzerland) Ltd.', 0.14], ['6730 Sunrise GmbH', 0.13], ['3320 Deutsche Telekom AG', 0.1],
  ['15600 Quickline AG', 0.06], ['8881 1&1 Versatel Deutschland GmbH', 0.05], ['7922 Comcast Cable Communications, LLC', 0.05], ['1136 KPN B.V.', 0.03],
  ['8447 A1 Telekom Austria AG', 0.04], ['5410 Bouygues Telecom SA', 0.03], ['13335 Cloudflare, Inc.', 0.03],
]
const BOT_NETS: W<string> = [['24940 Hetzner Online GmbH', 0.32], ['16509 Amazon.com, Inc.', 0.24], ['14061 DigitalOcean, LLC', 0.16], ['15169 Google LLC', 0.18], ['16276 OVH SAS', 0.1]]
const CAMPAIGNS: W<string> = [
  [['newsletter', 'email', 'herbst-2026'].join(TRAFFIC_SEP), 0.5], [['mastodon', 'social', 'launch'].join(TRAFFIC_SEP), 0.3], [['linkedin', 'social', 'launch'].join(TRAFFIC_SEP), 0.2],
]
const ENTRIES: W<string> = [['/', 0.52], ['/blog/homeserver-mit-airlock', 0.26], ['/blog/caddy-und-tailscale', 0.12], ['/projekte', 0.06], ['/kontakt', 0.04]]
const EXITS: W<string> = [['/kontakt', 0.24], ['/', 0.2], ['/blog/homeserver-mit-airlock', 0.22], ['/impressum', 0.14], ['/blog/caddy-und-tailscale', 0.12], ['/projekte', 0.08]]

const isPublicProject = (id: string) => id === 'p-hallo' || id === 'p-haushalt'

function sinceOf(v: TrafficVariant, now: number): number {
  // Jung: Messbeginn gestern 19:40 Ortszeit (bei fester Uhr 10.11., 14:00 → 09.11., 19:40)
  if (v === 'jung') return hourStart(now) - 18 * HOUR - 20 * MIN
  return hourStart(now - 41 * DAY) + 40 * MIN
}

interface Data { rows: TrafficHourRow[]; dims: TrafficDimRow[]; since: number }
const cache = new Map<string, Data>()

function generate(id: string, v: TrafficVariant, now: number): Data {
  const key = `${id}|${v}|${hourStart(now)}`
  const hit = cache.get(key)
  if (hit) return hit
  const pub = isPublicProject(id)
  const since = sinceOf(v, now)
  const rows = new Map<string, TrafficHourRow>()
  const dims = new Map<string, TrafficDimRow>()
  const addRow = (r: Omit<TrafficHourRow, 'views' | 'visitors'>, visitors: number) => {
    const k = [r.hour, r.way, r.path, r.country, r.city, r.referrer, r.device, r.status, r.bot].join('|')
    const e = rows.get(k) ?? { ...r, views: 0, visitors: 0 }
    e.views += 1
    e.visitors += visitors
    rows.set(k, e)
  }
  const addDim = (hour: number, way: TrafficWay, dim: TrafficDim, value: string, visitors: number, bot = false) => {
    const k = [hour, way, dim, value, bot].join('|')
    const e = dims.get(k) ?? { hour, way, dim, value, bot, views: 0, visitors: 0 }
    e.views += 1
    e.visitors += visitors
    dims.set(k, e)
  }
  if (v === 'leer') {
    const data = { rows: [], dims: [], since }
    cache.set(key, data)
    return data
  }
  const perDay = pub ? (id === 'p-haushalt' ? 190 : 280) : 46
  const ways: W<TrafficWay> = pub ? [['public', 0.93], ['tailnet', 0.05], ['lan', 0.02]] : [['tailnet', 0.7], ['lan', 0.3]]
  const span = Math.max(1, (now - since) / DAY)
  for (let h = hourStart(since); h <= now; h += HOUR) {
    const r = rng(Math.floor(h / HOUR) * 31 + (pub ? 7 : 3))
    const parts = localParts.formatToParts(new Date(h))
    const lh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const wd = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon')
    const growth = 0.75 + 0.25 * Math.min(1, (h - since) / (span * DAY))
    // Erste und laufende Stunde nur anteilig
    const share = Math.max(0, Math.min(1, (Math.min(now, h + HOUR) - Math.max(since, h)) / HOUR))
    const n = Math.round(((perDay * HOUR_SHAPE[lh]!) / 206) * DAY_SHAPE[wd]! * growth * (0.75 + r() * 0.5) * share)
    for (let j = 0; j < n; j++) {
      const way = pick(r, ways)
      const x = r()
      const status = x < 0.045 ? 404 : x < 0.049 ? 500 : x < 0.14 ? 304 : 200
      const path = status === 404 ? pick(r, NOT_FOUND) : status === 500 ? '/kontakt' : pick(r, pub ? PUBLIC_PAGES : INTERNAL_PAGES)
      const country = way === 'public' ? pick(r, COUNTRIES) : ''
      const city = v === 'staedte' && CITIES[country] ? pick(r, CITIES[country]!) : ''
      const ok = status < 400
      const visitor = ok && r() < 0.38 ? 1 : 0
      addRow({ hour: h, way, path, country, city, referrer: way === 'public' ? pick(r, PUBLIC_REFS) : pick(r, INTERNAL_REFS), device: pick(r, DEVICES), status, bot: false }, visitor)
      if (!ok) continue
      addDim(h, way, 'lang', pick(r, LANGS), visitor)
      addDim(h, way, 'browser', pick(r, BROWSERS), visitor)
      addDim(h, way, 'os', pick(r, SYSTEMS), visitor)
      if (v === 'staedte' && way === 'public') addDim(h, way, 'asn', pick(r, NETS), visitor)
      if (pub && r() < 0.04) addDim(h, way, 'utm', pick(r, CAMPAIGNS), visitor)
      if (visitor) {
        addDim(h, way, 'entry', pick(r, pub ? ENTRIES : INTERNAL_PAGES), 1)
        if (h + HOUR < now) addDim(h, way, 'exit', pick(r, pub ? EXITS : INTERNAL_PAGES), 0)
      }
    }
    // Bots: auf öffentlichen Seiten viele (Crawler, Scanner, Rechenzentren)
    const bots = Math.round(n * (pub ? 0.55 : 0.1))
    for (let j = 0; j < bots; j++) {
      const way = pub ? 'public' : 'lan'
      addRow({ hour: h, way, path: '', country: '', city: '', referrer: '', device: '', status: 200, bot: true }, 0)
      if (v === 'staedte' && pub) addDim(h, way, 'asn', pick(r, BOT_NETS), 0, true)
    }
  }
  const data = { rows: [...rows.values()], dims: [...dims.values()], since }
  cache.set(key, data)
  return data
}

function source(v: TrafficVariant, since: number): TrafficSourceDto {
  return {
    ingest: v === 'wartet' ? 'waiting' : v === 'aus' ? 'off' : 'ok',
    since: new Date(since).toISOString(),
    cityDb: v === 'staedte' ? '2026-11' : null,
    asnDb: v === 'staedte' ? '2026-11' : null,
    cfLocation: false,
  }
}

export function trafficSummaryFixture(id: string, range: TrafficRange, way: TrafficWay | 'all', v: TrafficVariant = 'ok'): TrafficSummaryDto {
  const now = Date.now()
  const d = generate(id, v, now)
  return summarize(d.rows, d.dims, {
    range, way, now, timeZone: TZ, source: source(v, d.since),
    hiddenReferrers: new Set(['airlock.int.example.ch', 'status.example.ch']),
  })
}

/** «Gerade eben»: feste letzte Aufrufe (ohne IP, ohne Kennung) */
export function trafficRecent(id: string, v: TrafficVariant = 'ok'): { events: TrafficLiveEventDto[] } {
  if (v === 'leer' || v === 'aus') return { events: [] }
  const now = Date.now()
  const pub = isPublicProject(id)
  const host = pub ? (id === 'p-hallo' ? 'hallo.example.ch' : 'haushalt.example.ch') : 'fotoalbum.int.example.ch'
  const e = (secAgo: number, access: TrafficWay, path: string, status: number, country?: string, city?: string): TrafficLiveEventDto => ({
    at: new Date(now - secAgo * 1000).toISOString(), access, host, service: 'web', status, blocked: false, bot: false, page: true, path,
    ...(country ? { country } : {}), ...(city && v === 'staedte' ? { city } : {}),
  })
  const events = pub
    ? [
        e(12, 'public', '/', 200, 'CH', 'Zürich'),
        e(25, 'public', '/impressum', 200, 'CH', 'Bern'),
        e(146, 'tailnet', '/blog/caddy-und-tailscale', 200),
        e(221, 'public', '/wp-login.php', 404, 'NL'),
        e(560, 'public', '/', 200, 'DE', 'Berlin'),
        e(688, 'public', '/kontakt', 200, 'CH', 'Zürich'),
        e(1270, 'public', '/blog/homeserver-mit-airlock', 304, 'AT', 'Wien'),
        e(1990, 'lan', '/projekte', 200),
      ]
    : [
        e(40, 'tailnet', '/alben/sommer-2026', 200),
        e(95, 'tailnet', '/', 200),
        e(410, 'lan', '/suche', 200),
        e(1300, 'tailnet', '/alt/galerie', 404),
        e(2600, 'lan', '/', 200),
      ]
  return { events }
}

/** Server › Besucher */
export function trafficSources(v: TrafficVariant = 'ok'): TrafficGeoSourcesDto {
  const loaded = { month: '2026-11', downloadedAt: '2026-11-03T04:12:00.000Z' }
  const none = { month: null, downloadedAt: null }
  return { city: v === 'staedte' ? loaded : none, asn: v === 'staedte' ? loaded : none, cfLocation: v === 'staedte' }
}
