import {
  ACCESS_BLOCK_LABEL, ACCESS_KIND_WORD, LOG_RANGES, TRAFFIC_WAY_LABEL, accessKind, accessOrigin, countryName, isAccessStatusFilter, matchesStatus, providerShort,
  type AccessEntryDto, type AccessGroup, type AccessStatusFilter, type LogRange, type TrafficWay,
} from '@airlock/shared'
import { dateOf, fmtDayMonth, fmtStamp, fmtTime, msOf, sameDay } from './dates.js'
import { wayFromSlug, waySlug } from './traffic-view.js'

/**
 * Reiter «Zugriffe» (neu): Filter aus und in die Adresse, Suche, Zähler,
 * Tagestrenner, Zeitspanne zusammengefasster Zeilen und CSV – rein, ohne
 * React (access-view.test.ts). Die Regeln selbst (Status, Herkunft,
 * Zusammenfassen, Erklärungen) liegen in @airlock/shared.
 */

export interface AccessFilters {
  status: AccessStatusFilter
  range: LogRange
  way: TrafficWay | 'all'
  search: string
  /** Gleiche Aufrufe zusammenfassen (Standard an) */
  group: boolean
  /** Airlock-Prüfungen ausblenden (Standard an) */
  hideProbes: boolean
  /** Bots zeigen (Standard aus) */
  bots: boolean
  /** Gewählte Zeile (Kennung des neuesten Eintrags der Gruppe) */
  row: string | null
}

export const DEFAULT_FILTERS: AccessFilters = { status: 'alle', range: '24h', way: 'all', search: '', group: true, hideProbes: true, bots: false, row: null }

/** Namen in der Adresse: ?status=abgewiesen&zeit=1h&zugang=tailnet&suche=…&einzeln=1&pruefungen=1&bots=1&zeile=… */
const P = { status: 'status', range: 'zeit', way: 'zugang', search: 'suche', single: 'einzeln', probes: 'pruefungen', bots: 'bots', row: 'zeile' } as const

export function readFilters(p: URLSearchParams): AccessFilters {
  const status = p.get(P.status)
  const range = p.get(P.range)
  return {
    status: isAccessStatusFilter(status) ? status : 'alle',
    range: LOG_RANGES.some((r) => r.key === range) ? (range as LogRange) : '24h',
    way: wayFromSlug(p.get(P.way)),
    search: (p.get(P.search) ?? '').slice(0, 200),
    group: p.get(P.single) !== '1',
    hideProbes: p.get(P.probes) !== '1',
    bots: p.get(P.bots) === '1',
    row: p.get(P.row) || null,
  }
}

/** Filter in die Adresse schreiben; andere Parameter (tab) bleiben, Standardwerte fehlen */
export function writeFilters(p: URLSearchParams, f: AccessFilters): URLSearchParams {
  const next = new URLSearchParams(p)
  const set = (k: string, v: string | null) => (v ? next.set(k, v) : next.delete(k))
  set(P.status, f.status === 'alle' ? null : f.status)
  set(P.range, f.range === '24h' ? null : f.range)
  set(P.way, waySlug(f.way))
  set(P.search, f.search.trim() ? f.search : null)
  set(P.single, f.group ? null : '1')
  set(P.probes, f.hideProbes ? null : '1')
  set(P.bots, f.bots ? '1' : null)
  set(P.row, f.row)
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
  /** Nach Zeitraum, Zugang, Suche, Prüfungen und Bots, vor dem Status (Basis der Zähler) */
  base: AccessEntryDto[]
  /** Angezeigt (zusätzlich nach Status) */
  list: AccessEntryDto[]
  counts: Record<AccessStatusFilter, number>
  /** Eigene Prüfungen bzw. Bots im Zeitraum (nach Zugang und Suche) – Zahlen neben den Schaltern */
  probes: number
  bots: number
}

/** Filtern (rein). Bots = sicher am User-Agent erkannt; «Bot?» (Rechenzentrum, Scanner) bleibt sichtbar. */
export function filterAccess(entries: readonly AccessEntryDto[], f: AccessFilters, sinceMs: number): FilteredAccess {
  const needle = f.search.trim().toLowerCase()
  let probes = 0
  let bots = 0
  const base: AccessEntryDto[] = []
  for (const e of entries) {
    if ((msOf(e.at) ?? 0) < sinceMs) continue
    if (f.way !== 'all' && e.way !== f.way) continue
    if (needle && !searchText(e).includes(needle)) continue
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
