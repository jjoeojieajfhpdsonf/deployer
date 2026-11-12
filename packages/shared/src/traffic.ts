/**
 * Etappe 3 «Besucher und Herkunft», erweitert mit «Besucher neu»: Auswertung
 * der Zugriffe eines Projekts aus Caddys Zugriffs-Log – ohne Cookies, ohne
 * Skript im Projekt, ohne gespeicherte IP. Gespeichert werden nur
 * Stundenzähler:
 *
 * - traffic_hourly: Projekt, Stunde, Zugang, Pfad, Land, Stadt, Referrer,
 *   Gerät, Status, Bot
 * - traffic_dims: je Merkmal eine Zeile (Einstieg, Ausstieg, Sprache,
 *   Browser, System, Netz/ASN, Kampagne) – Randsummen, keine Kreuzung
 *
 * Eindeutige Besucher zählt Airlock über einen Hash aus IP, User-Agent und
 * einem Tagessalz, das nur im Speicher liegt (packages/api/src/traffic/visitor.ts).
 *
 * Zugang heisst wie im Reiter «Aufbau» (TopologyWay): public = Internet
 * (über den Cloudflare-Tunnel), tailnet, lan = Heimnetz.
 */

import type { TopologyWay } from './topology.js'

export type TrafficWay = TopologyWay

export const TRAFFIC_WAYS: readonly TrafficWay[] = ['public', 'tailnet', 'lan'] as const

/** Bezeichnung des Zugangs in der Oberfläche (wie die Spalte «Zugang» im Aufbau) */
export const TRAFFIC_WAY_LABEL: Record<TrafficWay, string> = { public: 'Internet', tailnet: 'Tailnet', lan: 'Heimnetz' }

/** Zugang in der Adresse der Seite (?zugang=internet) */
export const TRAFFIC_WAY_SLUG: Record<TrafficWay, string> = { public: 'internet', tailnet: 'tailnet', lan: 'heimnetz' }

/**
 * Zeiträume. «today» beginnt um Mitternacht (Ortszeit), «24h» ist das
 * gleitende Fenster der Übersicht und des MCP-Werkzeugs (seit Etappe 3),
 * die übrigen beginnen um Mitternacht vor (Tage − 1) Tagen bzw. am Ersten
 * des Monats vor 11 Monaten.
 */
export const TRAFFIC_RANGES = [
  { key: 'today', label: 'Heute', slug: 'heute', days: 1, within: 'heute' },
  { key: '24h', label: '24 Std.', slug: '24h', days: 1, within: 'in den letzten 24 Stunden' },
  { key: '7d', label: '7 Tage', slug: '7-tage', days: 7, within: 'in den letzten 7 Tagen' },
  { key: '30d', label: '30 Tage', slug: '30-tage', days: 30, within: 'in den letzten 30 Tagen' },
  { key: '12m', label: '12 Monate', slug: '12-monate', days: 365, within: 'in den letzten 12 Monaten' },
] as const
export type TrafficRange = (typeof TRAFFIC_RANGES)[number]['key']
export const isTrafficRange = (v: unknown): v is TrafficRange => TRAFFIC_RANGES.some((r) => r.key === v)
export const trafficRange = (v: unknown) => TRAFFIC_RANGES.find((r) => r.key === v) ?? TRAFFIC_RANGES[0]
/** Umschalter im Reiter «Besucher» */
export const TRAFFIC_TAB_RANGES: readonly TrafficRange[] = ['today', '7d', '30d', '12m']
/** Umschalter der Karte in der Übersicht (unverändert seit Etappe 3) */
export const TRAFFIC_CARD_RANGES: readonly TrafficRange[] = ['24h', '7d', '30d']

/** Stundenzähler bleiben so viele Monate, danach löscht ein täglicher Job sie (SPEC: Datenschutz) */
export const TRAFFIC_RETENTION_MONTHS = 13

/** Auflösung der Kurve */
export type TrafficBucket = 'hour' | 'day' | 'week' | 'month'

const DAY_MS = 24 * 60 * 60_000

/**
 * Auflösung automatisch (rein, getestet):
 * - Heute und 24 Std.: Stunden.
 * - 7 und 30 Tage: Tage; liegt der Messbeginn im Zeitraum und sind noch
 *   keine 7 Tage gemessen, Stunden (sonst stünden da ein, zwei Säulen).
 * - 12 Monate: Monate; mit Messbeginn im Zeitraum je nach gemessener Zeit
 *   Stunden (< 7 Tage), Tage (< 60 Tage) oder Wochen (< ~6 Monate).
 */
export function trafficResolution(range: TrafficRange, o: { from: number; now: number; since: number | null }): TrafficBucket {
  if (range === 'today' || range === '24h') return 'hour'
  const full = o.since !== null && o.since <= o.from
  const measured = o.since === null ? 0 : o.now - Math.max(o.since, o.from)
  if (range === '7d' || range === '30d') return full || measured >= 7 * DAY_MS ? 'day' : 'hour'
  if (full) return 'month'
  if (measured < 7 * DAY_MS) return 'hour'
  if (measured < 60 * DAY_MS) return 'day'
  if (measured < 183 * DAY_MS) return 'week'
  return 'month'
}

export type TrafficDevice = 'desktop' | 'mobile' | 'tablet'
export const TRAFFIC_DEVICE_LABEL: Record<TrafficDevice, string> = { desktop: 'Computer', mobile: 'Handy', tablet: 'Tablet' }

/**
 * Referrer «intern»: Klick innerhalb der Seite (Referer ist ein Name des
 * Projekts). Seit «Besucher neu» getrennt von «direkt» (gar kein Referer);
 * ältere Zeilen haben beides als ''.
 */
export const INTERNAL_REFERRER = '(intern)'

/** Merkmale in traffic_dims */
export const TRAFFIC_DIMS = ['entry', 'exit', 'lang', 'browser', 'os', 'asn', 'utm'] as const
export type TrafficDim = (typeof TRAFFIC_DIMS)[number]

/** Wert eines Merkmals, wenn die Kopfzeile fehlt oder nichts Bekanntes sagt (Sprache, Browser, System) */
export const UNKNOWN_VALUE = '?'

/** Trennzeichen in zusammengesetzten Werten (Kampagne: Quelle, Medium, Name) */
export const TRAFFIC_SEP = '\u001f'

/**
 * Bekannte Pfade von Scannern (WordPress, Git, phpMyAdmin, Konfigurationsdateien
 * …). Ein 404 auf einen dieser Pfade ist fast immer ein Bot, der Lücken sucht –
 * die Liste «Nicht gefunden» markiert ihn mit «bot?». Teilstücke, klein
 * geschrieben; ein Pfad passt, wenn er eines enthält.
 */
export const SCANNER_PATHS: readonly string[] = [
  '/wp-login', '/wp-admin', '/wp-content', '/wp-includes', '/wp-json', '/wp-config', '/xmlrpc.php', '/wlwmanifest.xml',
  '/.git', '/.env', '/.svn', '/.hg', '/.aws', '/.ssh', '/.ds_store', '/.vscode', '/.idea', '/.htaccess', '/.htpasswd',
  '/phpmyadmin', '/pma/', '/myadmin', '/phpinfo', '/info.php', '/eval-stdin.php', '/vendor/phpunit', '/_ignition', '/telescope',
  '/cgi-bin', '/boaform', '/hnap1', '/actuator', '/server-status', '/solr/', '/owa/', '/autodiscover', '/ecp/',
  '/manager/html', '/jenkins', '/druid', '/console/', '/geoserver', '/remote/login', '/global-protect', '/mifs',
  '/setup.php', '/install.php', '/config.php', '/config.json', '/db.sql', '/dump.sql', '/backup.zip', '/sftp-config.json',
]

/** 404 auf einen typischen Scanner-Pfad? */
export function isScannerPath(path: string): boolean {
  const p = path.toLowerCase()
  return SCANNER_PATHS.some((s) => p.includes(s))
}

/**
 * Netze bekannter Hoster und Rechenzentren (ASN → Name). Anfragen von dort
 * kommen fast nie von Menschen am Browser, sondern von Crawlern, Scannern
 * und Monitoring – Airlock zählt sie als «vermutlich Bot». Bewusst ohne
 * Cloudflare (WARP-Nutzer sind Menschen) und ohne Zugangsanbieter.
 */
export const DATACENTER_ASNS: Readonly<Record<number, string>> = {
  16509: 'Amazon AWS', 14618: 'Amazon AWS', 15169: 'Google', 396982: 'Google Cloud', 8075: 'Microsoft Azure',
  14061: 'DigitalOcean', 24940: 'Hetzner', 213230: 'Hetzner Cloud', 16276: 'OVH', 63949: 'Akamai (Linode)',
  20473: 'Vultr', 51167: 'Contabo', 31898: 'Oracle Cloud', 45102: 'Alibaba Cloud', 132203: 'Tencent Cloud',
  12876: 'Scaleway', 60781: 'Leaseweb', 16265: 'Leaseweb', 9009: 'M247', 8560: 'IONOS', 47583: 'Hostinger',
  197540: 'netcup', 40676: 'Psychz', 398324: 'Censys', 36352: 'ColoCrossing', 53667: 'FranTech', 49505: 'Selectel',
  136907: 'Huawei Cloud', 26496: 'GoDaddy', 36351: 'IBM Cloud', 211298: 'Driftnet', 202425: 'IP Volume',
}

export const isDatacenterAsn = (asn: number): boolean => Object.hasOwn(DATACENTER_ASNS, asn)

/** Ein Zeitpunkt der Kurve: Beginn (at) und Ende (end) der Stunde, des Tages, der Woche bzw. des Monats (Ortszeit) */
export interface TrafficCountsDto {
  /** Seitenaufrufe mit Status 2xx/3xx (ohne Bots) */
  views: number
  /** Eindeutige Besucher je Tag (bei ihrem ersten erfolgreichen Aufruf gezählt) */
  visitors: number
  /** Aufrufe mit Status 404 */
  notFound: number
  /** Anfragen von Bots (User-Agent oder Rechenzentrum), nicht in views */
  bots: number
}

export interface TrafficPointDto extends TrafficCountsDto {
  at: string
  end: string
  /** Aufteilung nach Zugang (für Säulen und Tooltip) */
  ways: Record<TrafficWay, TrafficCountsDto>
}

/** Eine Zeile einer Rangliste (Seite, Referrer, Land, Gerät, Sprache …) */
export interface TrafficRowDto {
  /** Pfad, Host des Referrers ('' = direkt), Ländercode ISO 3166-1 alpha-2 ('' = unbekannt, 'T1' = Tor), Gerät … */
  key: string
  views: number
  visitors: number
}

export interface TrafficCityDto extends TrafficRowDto {
  /** Land der Stadt (alpha-2) */
  country: string
}

export interface TrafficNotFoundDto extends TrafficRowDto {
  /** Bekannter Scanner-Pfad (SCANNER_PATHS) */
  scanner: boolean
}

export interface TrafficNetworkDto {
  asn: number
  /** Name laut DB-IP («Init7 (Switzerland) Ltd.») */
  name: string
  /** Aufrufe von Menschen */
  views: number
  /** Als Bot gezählte Anfragen aus diesem Netz */
  bots: number
  /** Rechenzentrum (DATACENTER_ASNS): Anfragen gelten als «vermutlich Bot» */
  datacenter: boolean
}

export interface TrafficCampaignDto {
  source: string
  medium: string
  campaign: string
  views: number
  visitors: number
}

export interface TrafficStatusDto {
  status: number
  views: number
}

/**
 * Woher die Zahlen kommen. Fehlt etwas (Log nicht eingerichtet, keine
 * Städte-Datenbank), lässt die Oberfläche das Element weg statt zu raten.
 */
export interface TrafficSourceDto {
  /**
   * ok: Airlock liest Caddys Zugriffs-Log mit. waiting: eingerichtet, aber
   * die Datei fehlt noch (Caddy hat noch nichts geschrieben oder das Volume
   * ist nicht eingehängt). off: nicht eingerichtet (ACCESS_LOG_DIR leer).
   */
  ingest: 'ok' | 'waiting' | 'off'
  /** Messbeginn des Projekts (erster Ingest, ISO) – davor gibt es keine Zahlen */
  since: string | null
  /** DB-IP «IP to City Lite» (CC BY 4.0): Stand der Datei als «JJJJ-MM»; null = keine Datei, nur Länder */
  cityDb: string | null
  /** DB-IP «IP to ASN Lite» (CC BY 4.0): Stand als «JJJJ-MM»; null = keine Datei, kein «Netz» */
  asnDb: string | null
  /** Cloudflare liefert Städte (Managed Transform «Add visitor location headers», seit Start von Airlock gesehen) */
  cfLocation: boolean
}

export interface TrafficSummaryDto {
  range: TrafficRange
  way: TrafficWay | 'all'
  from: string
  to: string
  bucket: TrafficBucket
  /** Messbeginn im Zeitraum: Kurve und Achse beginnen dort (ISO); null = ganzer Zeitraum gemessen */
  measuredFrom: string | null
  totals: TrafficCountsDto & {
    /** Aufrufe mit Status 5xx */
    serverErrors: number
    /** Alle Anfragen von Menschen (jeder Status), Basis für den Anteil «Nicht gefunden» */
    requests: number
    /** Aufrufe je Besucher (Ø), null ohne Besucher */
    pagesPerVisit: number | null
  }
  /** Gleich langer Zeitraum davor – nur wenn er vollständig gemessen ist */
  previous: (TrafficCountsDto & { pagesPerVisit: number | null }) | null
  /** Nach Zugang, immer über alle Wege (für die Umschalter) */
  ways: { way: TrafficWay; views: number; visitors: number }[]
  series: TrafficPointDto[]
  /** Nur 2xx/3xx */
  pages: TrafficRowDto[]
  entries: TrafficRowDto[]
  exits: TrafficRowDto[]
  notFound: TrafficNotFoundDto[]
  /** Ohne Klicks innerhalb der Seite und ohne Airlock-eigene Namen ('' = direkt/Lesezeichen) */
  referrers: TrafficRowDto[]
  /** Ausgeblendete Aufrufe: innerhalb der Seite bzw. von Airlock selbst (Oberfläche, Statusseite) */
  referrersHidden: { internal: number; airlock: number }
  countries: TrafficRowDto[]
  cities: TrafficCityDto[]
  devices: TrafficRowDto[]
  browsers: TrafficRowDto[]
  systems: TrafficRowDto[]
  languages: TrafficRowDto[]
  networks: TrafficNetworkDto[]
  campaigns: TrafficCampaignDto[]
  statuses: TrafficStatusDto[]
  source: TrafficSourceDto
}

/** Aufrufe heute (seit Mitternacht Ortszeit) je Projekt-ID, für die Projektliste */
export interface TrafficTodayDto {
  /** Nur Projekte mit Aufrufen heute; fehlt eines, waren es 0 (sofern ingest 'ok') */
  views: Record<string, number>
  /** Eindeutige Besucher heute je Projekt-ID (gleiche Regel wie views: fehlt eines, waren es 0) */
  visitors: Record<string, number>
  /** Zählt Airlock überhaupt mit? Sonst zeigt die Liste keine Zahl (statt einer falschen 0) */
  ingest: TrafficSourceDto['ingest']
}

/**
 * Live-Strom (GET /api/v1/projects/:id/traffic/live, Server-Sent Events):
 * pro Anfrage an einen Namen des Projekts ein Ereignis `data: {…}`, ohne
 * IP, ohne User-Agent, ohne Kennung. Eigene Prüfungen von Airlock
 * («airlock-probe») fehlen; alles andere kommt, auch Bots, statische Dateien
 * und vom IP-Filter gesperrte Anfragen (blocked). Gedacht für die Animation
 * im Reiter «Aufbau» (Etappe 4): host und service passen zu den Knoten
 * `host:<host>` und `svc:<service>` von GET /topology, access zu `way:<access>`.
 * Seit «Besucher neu» tragen gezählte Seitenaufrufe (page) dazu Pfad und
 * Herkunft für «Gerade eben».
 */
export interface TrafficLiveEventDto {
  /** Zeitpunkt der Anfrage (ISO, von Caddy) */
  at: string
  /** Zugang: public (über den Tunnel), tailnet, lan */
  access: TrafficWay
  /** Angefragter Name (ohne Port) */
  host: string
  /** Dienst, an den Caddy weiterleitet (Name wie im Aufbau); null bei Pause-Seite oder unbekannt */
  service: string | null
  /** HTTP-Status der Antwort */
  status: number
  /** Vom IP-Filter von Caddy abgewiesen (403 am Eingang, erreichte den Dienst nie) */
  blocked: boolean
  /** User-Agent oder Netz als Bot erkannt */
  bot: boolean
  /** Gezählter Seitenaufruf (kein Bot, keine Datei, kein Healthcheck) */
  page?: boolean
  /** Pfad ohne Query – nur bei page */
  path?: string
  /** Land (alpha-2) – nur bei page aus dem Internet */
  country?: string
  /** Stadt – nur bei page aus dem Internet, mit Städte-Datenbank oder Cloudflare-Kopfzeilen */
  city?: string
}

/** GET /projects/:id/traffic/recent: letzte Seitenaufrufe aus dem Speicher (neueste zuerst) */
export interface TrafficRecentDto {
  events: TrafficLiveEventDto[]
}

/** System › Besucher: optionale Dateien von DB-IP und Cloudflare-Kopfzeilen */
export interface TrafficGeoSourcesDto {
  city: { month: string | null; downloadedAt: string | null }
  asn: { month: string | null; downloadedAt: string | null }
  /** Cloudflare-Kopfzeilen cf-ipcity … seit dem Start von Airlock gesehen */
  cfLocation: boolean
}

/** Ländername auf Deutsch aus dem Code (Intl); '' → «Unbekannt», T1 → «Tor-Netz» */
export function countryName(code: string, locale = 'de-CH'): string {
  if (!code) return 'Unbekannt'
  if (code === 'T1') return 'Tor-Netz'
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Sprache aus dem Code der ersten Accept-Language: de-CH → «Deutsch (Schweiz)» */
export function languageName(code: string, locale = 'de-CH'): string {
  if (!code) return 'Unbekannt'
  try {
    // «standard»: Deutsch (Schweiz) statt «Schweizer Hochdeutsch»
    return new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Kampagne aus dem gespeicherten Wert (Quelle, Medium, Name) */
export function splitCampaign(value: string): { source: string; medium: string; campaign: string } {
  const [source = '', medium = '', campaign = ''] = value.split(TRAFFIC_SEP)
  return { source, medium, campaign }
}

/** Netz aus dem gespeicherten Wert «13030 Init7 (Switzerland) Ltd.» */
export function splitNetwork(value: string): { asn: number; name: string } {
  const i = value.indexOf(' ')
  const asn = Number(i < 0 ? value : value.slice(0, i))
  return { asn: Number.isFinite(asn) ? asn : 0, name: i < 0 ? '' : value.slice(i + 1) }
}
