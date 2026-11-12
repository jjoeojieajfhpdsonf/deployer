import {
  ACCESS_BLOCK_LABEL, ACCESS_KIND_WORD, TRAFFIC_DEVICE_LABEL, TRAFFIC_SEP, TRAFFIC_WAY_LABEL, UNKNOWN_VALUE, accessKind, accessOrigin, countryName,
  isAccessStatusFilter, languageName, matchesStatus, providerShort,
  type AccessEntryDto, type AccessGroup, type AccessRange, type AccessStatusFilter, type TrafficDevice, type TrafficRange, type TrafficWay,
} from '@airlock/shared'
import { dateOf, fmtDayMonth, fmtStamp, fmtTime, msOf, sameDay } from './dates.js'
import { rangeFromSlug, rangeSlug, wayFromSlug, waySlug } from './traffic-view.js'

/**
 * Reiter «Besucher» (seit «Besucher zusammen» mit den früheren Zugriffen):
 * gemeinsamer Zustand in der Adresse (Ansicht, Zeitraum, Zugang), Filter
 * der Einzelaufrufe (Status, Suche, Merkmale aus der Auswertung, Anzeige),
 * Suche, Zähler, Tagestrenner, Zeitspanne zusammengefasster Zeilen, CSV und
 * die Weiterleitung alter Adressen – rein, ohne React (access-view.test.ts).
 * Die Regeln selbst (Status, Herkunft, Zusammenfassen, Erklärungen) liegen
 * in @airlock/shared.
 */

/* --- Ansicht, Zeitraum, Zugang (beide Ansichten) ------------------------------ */

export type VisitorsView = 'auswertung' | 'einzeln'

/** ?ansicht=einzeln; ohne Angabe die Auswertung */
export const viewFromParams = (p: URLSearchParams): VisitorsView => (p.get('ansicht') === 'einzeln' ? 'einzeln' : 'auswertung')

/** Einzelaufrufe: Heute ab Mitternacht, sonst alles, was das Zugriffs-Log hat (2 Tage) */
export const accessRangeOf = (r: TrafficRange): AccessRange => (r === 'today' ? 'today' : '2d')

/* --- Merkmale aus der Auswertung --------------------------------------------- */

/**
 * Merkmale, nach denen eine Zeile der Auswertung die Einzelaufrufe filtert.
 * Name in der Adresse = Schlüssel (?land=CH&sprache=de-CH …). Unbekannt
 * (leere Sprache, unbekannter Browser, Land ohne Angabe) steht als «?»,
 * «Direkt / Lesezeichen» als «(direkt)», eine Kampagne als
 * Quelle␟Medium␟Name (wie in der Auswertung).
 */
export const FACETS = ['land', 'stadt', 'netz', 'sprache', 'pfad', 'quelle', 'kampagne', 'geraet', 'browser', 'system'] as const
export type Facet = (typeof FACETS)[number]
export type Facets = Partial<Record<Facet, string>>

export const FACET_LABEL: Record<Facet, string> = {
  land: 'Land', stadt: 'Stadt', netz: 'Netz', sprache: 'Sprache', pfad: 'Seite', quelle: 'Woher', kampagne: 'Kampagne', geraet: 'Gerät', browser: 'Browser', system: 'System',
}

/** «Direkt / Lesezeichen» in der Adresse (kein Host und keine utm_source kann so heissen) */
export const DIRECT = '(direkt)'

/** Browser und System ohne Version: «Chrome 131» → «Chrome» (wie die Auswertung zusammenfasst) */
export const familyOf = (v: string): string => (v === UNKNOWN_VALUE ? v : v.replace(/ \d+$/, ''))

const orUnknown = (v: string) => v || UNKNOWN_VALUE

const FACET_MATCH: Record<Facet, (e: AccessEntryDto, v: string) => boolean> = {
  // Länder zählt die Auswertung nur für das Internet
  land: (e, v) => e.way === 'public' && orUnknown(e.country) === v,
  stadt: (e, v) => e.city === v,
  netz: (e, v) => String(e.network?.asn ?? '') === v,
  sprache: (e, v) => orUnknown(e.language) === v,
  // Die Auswertung kürzt Pfade auf 200 Zeichen
  pfad: (e, v) => e.path === v || e.path.slice(0, 200) === v,
  quelle: (e, v) => (e.source || DIRECT) === v,
  kampagne: (e, v) => e.campaign !== null && [e.campaign.source, e.campaign.medium, e.campaign.campaign].join(TRAFFIC_SEP) === v,
  geraet: (e, v) => e.device === v,
  browser: (e, v) => orUnknown(familyOf(e.browser)) === v,
  system: (e, v) => orUnknown(familyOf(e.system)) === v,
}

export const matchesFacets = (e: AccessEntryDto, f: Facets): boolean =>
  FACETS.every((k) => f[k] === undefined || FACET_MATCH[k](e, f[k]!))

/** Wert eines Merkmals lesbar (Chip «Land: Schweiz ✕»); Netz mit Namen aus den Einträgen, sonst AS-Nummer */
export function facetText(k: Facet, v: string, entries: readonly AccessEntryDto[] = []): string {
  if (v === UNKNOWN_VALUE) return 'Unbekannt'
  switch (k) {
    case 'land': return countryName(v)
    case 'sprache': return languageName(v)
    case 'geraet': return TRAFFIC_DEVICE_LABEL[v as TrafficDevice] ?? v
    case 'quelle': return v === DIRECT ? 'Direkt / Lesezeichen' : v
    case 'kampagne': {
      const [source = '', medium = '', campaign = ''] = v.split(TRAFFIC_SEP)
      return [campaign || source, campaign ? source : '', medium].filter(Boolean).join(' · ')
    }
    case 'netz': {
      const n = entries.find((e) => String(e.network?.asn ?? '') === v)?.network
      return n ? providerShort(n) : `AS${v}`
    }
    default: return v
  }
}

/* --- Filter der Einzelaufrufe --------------------------------------------------- */

export interface AccessFilters {
  status: AccessStatusFilter
  /** Zeitraum (gemeinsam mit der Auswertung) */
  range: TrafficRange
  /** Zugang (gemeinsam mit der Auswertung) */
  way: TrafficWay | 'all'
  search: string
  /** Merkmale aus der Auswertung (Chips) */
  facets: Facets
  /** Gleiche Aufrufe zusammenfassen (Standard an) */
  group: boolean
  /** Airlock-Prüfungen ausblenden (Standard an) */
  hideProbes: boolean
  /** Bots zeigen (Standard aus) */
  bots: boolean
  /** Gewählte Zeile (Kennung des neuesten Eintrags der Gruppe) */
  row: string | null
}

export const DEFAULT_FILTERS: AccessFilters = { status: 'alle', range: '7d', way: 'all', search: '', facets: {}, group: true, hideProbes: true, bots: false, row: null }

/** Schalter im Menü «Anzeige», die von der Voreinstellung abweichen (Zahl am Knopf) */
export const displayChanges = (f: Pick<AccessFilters, 'group' | 'hideProbes' | 'bots'>): number =>
  (f.group ? 0 : 1) + (f.hideProbes ? 0 : 1) + (f.bots ? 1 : 0)

/** Namen in der Adresse: ?status=abgewiesen&zeitraum=heute&zugang=tailnet&suche=…&einzeln=1&pruefungen=1&bots=1&zeile=…&land=CH … */
const P = { status: 'status', range: 'zeitraum', way: 'zugang', search: 'suche', single: 'einzeln', probes: 'pruefungen', bots: 'bots', row: 'zeile' } as const

export function readFilters(p: URLSearchParams): AccessFilters {
  const status = p.get(P.status)
  const facets: Facets = {}
  for (const k of FACETS) {
    const v = p.get(k)
    if (v) facets[k] = v.slice(0, 300)
  }
  return {
    status: isAccessStatusFilter(status) ? status : 'alle',
    range: rangeFromSlug(p.get(P.range)),
    way: wayFromSlug(p.get(P.way)),
    search: (p.get(P.search) ?? '').slice(0, 200),
    facets,
    group: p.get(P.single) !== '1',
    hideProbes: p.get(P.probes) !== '1',
    bots: p.get(P.bots) === '1',
    row: p.get(P.row) || null,
  }
}

/** Filter in die Adresse schreiben; andere Parameter (tab, ansicht) bleiben, Standardwerte fehlen */
export function writeFilters(p: URLSearchParams, f: AccessFilters): URLSearchParams {
  const next = new URLSearchParams(p)
  const set = (k: string, v: string | null | undefined) => (v ? next.set(k, v) : next.delete(k))
  set(P.status, f.status === 'alle' ? null : f.status)
  set(P.range, f.range === '7d' ? null : rangeSlug(f.range))
  set(P.way, waySlug(f.way))
  set(P.search, f.search.trim() ? f.search : null)
  for (const k of FACETS) set(k, f.facets[k])
  set(P.single, f.group ? null : '1')
  set(P.probes, f.hideProbes ? null : '1')
  set(P.bots, f.bots ? '1' : null)
  set(P.row, f.row)
  return next
}

/**
 * Adresse der Einzelaufrufe zu einer Zeile der Auswertung: Zeitraum und
 * Zugang bleiben, die übrigen Filter der Einzelaufrufe beginnen neu (nur das
 * gewählte Merkmal, bei 404 dazu der Status). Gibt den Suchteil zurück.
 */
export function einzelnSearch(current: URLSearchParams, facets: Facets, status: AccessStatusFilter = 'alle'): string {
  const base = readFilters(current)
  const next = writeFilters(new URLSearchParams({ tab: 'besucher', ansicht: 'einzeln' }), { ...DEFAULT_FILTERS, range: base.range, way: base.way, facets, status })
  return `?${next.toString()}`
}

/**
 * Alte Adressen: Reiter «Zugriffe» (?tab=zugriffe, bei statischen Seiten
 * ?tab=logs) → ?tab=besucher&ansicht=einzeln. Filter, die es weiter gibt
 * (Status, Suche, Zugang, Anzeige, Zeile), kommen mit; der alte Zeitraum
 * (zeit=15m|1h|24h) nicht. null: keine alte Adresse.
 */
export function legacyAccessRedirect(p: URLSearchParams, isStatic: boolean): URLSearchParams | null {
  const tab = p.get('tab')
  if (tab !== 'zugriffe' && !(tab === 'logs' && isStatic)) return null
  const next = new URLSearchParams({ tab: 'besucher', ansicht: 'einzeln' })
  for (const k of [P.status, P.search, P.way, P.single, P.probes, P.bots, P.row]) {
    const v = p.get(k)
    if (v) next.set(k, v)
  }
  return next
}

/** Text, in dem die Suche sucht: Pfad, Methode, Status mit Wort, Land (Code und Name), Provider, Zugang, Absender, Browser, Name */
export function searchText(e: AccessEntryDto): string {
  const o = accessOrigin(e)
  return [
    e.method, e.path, e.host, String(e.status), ACCESS_KIND_WORD[accessKind(e)], e.block ? ACCESS_BLOCK_LABEL[e.block] : '',
    e.country, e.country ? countryName(e.country) : '', e.city, e.network?.name ?? '', e.network ? providerShort(e.network) : '',
    TRAFFIC_WAY_LABEL[e.way], o.place, o.detail, e.ip, e.browser, e.system,
  ].join(' ').toLowerCase()
}

export interface FilteredAccess {
  /** Nach Zeitraum, Zugang, Suche, Merkmalen, Prüfungen und Bots, vor dem Status (Basis der Zähler) */
  base: AccessEntryDto[]
  /** Angezeigt (zusätzlich nach Status) */
  list: AccessEntryDto[]
  counts: Record<AccessStatusFilter, number>
  /** Eigene Prüfungen bzw. Bots im Zeitraum (nach Zugang, Suche und Merkmalen) – Zahlen im Menü «Anzeige» */
  probes: number
  bots: number
}

/** Filtern (rein). Bots = sicher am User-Agent erkannt; «Bot?» (Rechenzentrum, Scanner) bleibt sichtbar. */
export function filterAccess(entries: readonly AccessEntryDto[], f: Omit<AccessFilters, 'range' | 'row'>, sinceMs: number): FilteredAccess {
  const needle = f.search.trim().toLowerCase()
  let probes = 0
  let bots = 0
  const base: AccessEntryDto[] = []
  for (const e of entries) {
    if ((msOf(e.at) ?? 0) < sinceMs) continue
    if (f.way !== 'all' && e.way !== f.way) continue
    if (needle && !searchText(e).includes(needle)) continue
    if (!matchesFacets(e, f.facets)) continue
    if (e.probe) probes++
    else if (e.bot === 'ua') bots++
    if (e.probe && f.hideProbes) continue
    if (!e.probe && e.bot === 'ua' && !f.bots) continue
    base.push(e)
  }
  const counts = { alle: 0, erfolg: 0, 'nicht-gefunden': 0, abgewiesen: 0, fehler: 0 } satisfies Record<AccessStatusFilter, number>
  for (const e of base) for (const k of Object.keys(counts) as AccessStatusFilter[]) if (matchesStatus(e, k)) counts[k]++
  return { base, list: f.status === 'alle' ? base : base.filter((e) => matchesStatus(e, f.status)), counts, probes, bots }
}

/** Tagestrenner: «Heute, Do 12.11.», «Gestern, Mi 11.11.», sonst «Di 10.11.» */
export function dayLabel(at: string, now: number): string {
  const weekday = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][dateOf(at)?.getDay() ?? 0]
  const day = `${weekday} ${fmtDayMonth(at)}`
  if (sameDay(at, now)) return `Heute, ${day}`
  if (sameDay(at, now - 24 * 60 * 60_000)) return `Gestern, ${day}`
  return day
}

/** Gruppen nach Kalendertag (Ortszeit), neueste zuerst */
export function byDay(groups: readonly AccessGroup[], now: number): { key: string; label: string; groups: AccessGroup[] }[] {
  const out: { key: string; label: string; groups: AccessGroup[] }[] = []
  for (const g of groups) {
    const at = g.entries[0]!.at
    const last = out.at(-1)
    if (last && sameDay(last.groups[0]!.entries[0]!.at, at)) last.groups.push(g)
    else out.push({ key: fmtStamp(at).slice(0, 10), label: dayLabel(at, now), groups: [g] })
  }
  return out
}

/** Zeit einer Zeile: einzeln «09:12:43»; zusammengefasst als Spanne «08:46–08:49» (älteste–neueste), in derselben Minute «09:12:43» */
export function groupTime(g: AccessGroup): string {
  const newest = g.entries[0]!.at
  const oldest = g.entries.at(-1)!.at
  if (g.entries.length === 1 || fmtTime(newest) === fmtTime(oldest)) return fmtTime(newest, true)
  return `${fmtTime(oldest)}–${fmtTime(newest)}`
}

/** Dauer: «< 1 ms», «12 ms», «1.4 s», «–» */
export function fmtDuration(v: number | null): string {
  if (v === null) return '–'
  return v < 1 ? '< 1 ms' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} s`
}

/** CSV-Zelle; Werte, die eine Tabellenkalkulation als Formel läse (= + - @), werden entschärft */
const csvCell = (v: unknown): string => {
  const s = String(v ?? '')
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export const CSV_HEADER = ['Zeit', 'Methode', 'Host', 'Pfad', 'Status', 'Abgewiesen', 'Zugang', 'Land', 'Provider', 'Absender (gekürzt)', 'Browser', 'System', 'Dauer (ms)']

/** CSV der angezeigten Anfragen (einzeln, nicht zusammengefasst); Absender nur gekürzt wie in der Liste */
export function accessCsv(entries: readonly AccessEntryDto[]): string {
  const rows = entries.map((e) => [
    fmtStamp(e.at), e.method, e.host, e.path, e.status, e.block ? ACCESS_BLOCK_LABEL[e.block] : '',
    e.dockerNet ? 'Docker-Netz' : TRAFFIC_WAY_LABEL[e.way], e.country, e.network?.name ?? '', e.ip, e.browser, e.system, e.durationMs ?? '',
  ].map(csvCell).join(','))
  return `${CSV_HEADER.map(csvCell).join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`
}
