import {
  TRAFFIC_RANGES, TRAFFIC_TAB_RANGES, TRAFFIC_WAYS, TRAFFIC_WAY_SLUG,
  type TrafficBucket, type TrafficPointDto, type TrafficRange, type TrafficSummaryDto, type TrafficWay,
} from '@airlock/shared'
import { dateOf, fmtDayMonth, fmtMonthShort, fmtMonthYear, fmtTime, fmtWeekdayShort, msOf, sameDay } from './dates.js'

/**
 * «Besucher neu»: reine Hilfen für den Reiter (ohne DOM) – Kennzahlen,
 * Achsen, Stufen der Karte, Adresse der Seite. Getestet in traffic-view.test.ts.
 */

export const nf = (v: number) => v.toLocaleString('de-CH')
export const plural = (v: number, one: string, many: string) => `${nf(v)} ${v === 1 ? one : many}`

/** Kennzahlen, die die Kurve steuern */
export type TrafficMetric = 'views' | 'visitors' | 'pagesPerVisit' | 'notFound' | 'bots'
export const METRICS: readonly TrafficMetric[] = ['views', 'visitors', 'pagesPerVisit', 'notFound', 'bots']
export const METRIC_LABEL: Record<TrafficMetric, string> = {
  views: 'Aufrufe', visitors: 'Besucher', pagesPerVisit: 'Seiten pro Besuch', notFound: 'Nicht gefunden', bots: 'Bots',
}
/** Einzahl/Mehrzahl für Tooltip und Beschreibung */
export const METRIC_UNIT: Record<TrafficMetric, [string, string]> = {
  views: ['Aufruf', 'Aufrufe'], visitors: ['Besucher', 'Besucher'], pagesPerVisit: ['Seite pro Besuch', 'Seiten pro Besuch'],
  notFound: ['Mal nicht gefunden', 'Mal nicht gefunden'], bots: ['Bot-Anfrage', 'Bot-Anfragen'],
}

/** Wert einer Kennzahl an einem Punkt der Kurve (Seiten pro Besuch: null ohne Besucher) */
export function metricValue(p: Pick<TrafficPointDto, 'views' | 'visitors' | 'notFound' | 'bots'>, m: TrafficMetric): number | null {
  if (m === 'pagesPerVisit') return p.visitors > 0 ? p.views / p.visitors : null
  return p[m]
}

/** Dezimalzahl mit Komma wie in der Vorlage («7,9»): der Punkt von de-CH steht in Cal Sans wie eine Lücke */
export const fmtDecimal = (v: number, digits = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/**
 * Werte der Kurve für eine Kennzahl. Besonderheit «Seiten pro Besuch» in
 * Stunden: Besucher zählen nur in der Stunde ihres ersten Aufrufs, eine
 * einzelne Stunde hat also meist Aufrufe ohne Besucher (kein Wert) oder
 * einen Besucher mit nur einem Aufruf. Darum dort der laufende Schnitt des
 * Tages: Aufrufe ÷ Besucher seit Mitternacht bis zum Ende der Stunde. Tage,
 * Wochen, Monate rechnen je Abschnitt.
 */
export function metricSeries(series: Pick<TrafficPointDto, 'at' | 'views' | 'visitors' | 'notFound' | 'bots'>[], m: TrafficMetric, bucket: TrafficBucket): (number | null)[] {
  if (m !== 'pagesPerVisit' || bucket !== 'hour') return series.map((p) => metricValue(p, m))
  let day = ''
  let views = 0
  let visitors = 0
  return series.map((p) => {
    const d = dateOf(p.at)
    const key = d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : ''
    if (key !== day) {
      day = key
      views = 0
      visitors = 0
    }
    views += p.views
    visitors += p.visitors
    return visitors > 0 ? views / visitors : null
  })
}

/** Zahl einer Kennzahl für die Anzeige (Seiten pro Besuch mit einer Nachkommastelle) */
export const fmtMetric = (v: number | null, m: TrafficMetric) => (v === null ? '–' : m === 'pagesPerVisit' ? fmtDecimal(v) : nf(Math.round(v)))

/** Obergrenze der y-Achse: 1, 2, 2.5, 5 × 10^n (runde Werte; die Mitte ist dann auch rund) */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const e = 10 ** Math.floor(Math.log10(v))
  const f = v / e
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  const max = step * e
  // Ganze Zahlen ab 1: die Mitte soll auch ganz sein
  return max >= 1 && max < 2 && v > 1 ? 2 : max
}

/** Achsenwerte (rechts): 0, Mitte, Max – Mitte nur, wenn sie rund ist */
export function yTicks(max: number, decimals = false): number[] {
  const mid = max / 2
  return decimals || Number.isInteger(mid) ? [max, mid, 0] : [max, 0]
}

/** Veränderung zum Vorzeitraum, z. B. «+12 %» – null ohne Vergleich oder ohne Basis */
export function deltaLabel(now: number | null, before: number | null | undefined): string | null {
  if (now === null || before === null || before === undefined || before === 0) return null
  const d = Math.round(((now - before) / before) * 100)
  if (d === 0) return '±0 %'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} %`
}

/** Anteil in ganzen Prozent; unter 1 % aber nicht null: «<1 %» */
export function shareLabel(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0 %'
  const p = (part / total) * 100
  if (p < 1) return '<1 %'
  return `${Math.round(p)} %`
}

/**
 * Stufen der Karte: bis zu vier, als Untergrenzen mit runden Zahlen auf
 * einer logarithmischen Skala bis zum stärksten Land. Wenige Aufrufe →
 * weniger Stufen (nie doppelte). Beispiel max 96 → [1, 3, 10, 30].
 */
export function mapSteps(max: number): number[] {
  if (max <= 0) return []
  const nice = (v: number) => {
    if (v <= 1) return 1
    const e = 10 ** Math.floor(Math.log10(v))
    const f = v / e
    return (f < 1.5 ? 1 : f < 2.5 ? 2 : f < 4 ? 3 : f < 7.5 ? 5 : 10) * e
  }
  const out: number[] = [1]
  for (const k of [1, 2, 3]) {
    const b = nice(max ** (k / 4))
    if (b > out.at(-1)! && b <= max) out.push(b)
  }
  return out
}

/** Stufe 1–4 eines Werts (0 = keine Aufrufe), passend zu mapSteps; bei weniger Stufen die oberen benutzt */
export function mapLevel(v: number, steps: number[]): 0 | 1 | 2 | 3 | 4 {
  if (v <= 0 || steps.length === 0) return 0
  let i = 0
  while (i + 1 < steps.length && v >= steps[i + 1]!) i++
  return (4 - (steps.length - 1 - i)) as 1 | 2 | 3 | 4
}

/** Beschriftung einer Stufe: «1–2», «3–9», «30+» */
export function stepLabel(steps: number[], i: number): string {
  const lo = steps[i]!
  const next = steps[i + 1]
  if (next === undefined) return `${nf(lo)}+`
  return next - 1 === lo ? nf(lo) : `${nf(lo)}–${nf(next - 1)}`
}

/** Flagge als Emoji aus dem Ländercode (Regional Indicator); '' ohne gültigen Code */
export function flagOf(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === 'T1' || code === 'XX') return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** Zeitfenster eines Punkts: «12.11., 15:00–16:00», «Mi, 11.11.», «KW 46 (9.–15.11.)», «November 2026» */
export function windowLabel(p: Pick<TrafficPointDto, 'at' | 'end'>, bucket: TrafficBucket): string {
  if (bucket === 'hour') return `${fmtDayMonth(p.at)}, ${fmtTime(p.at)}–${fmtTime(p.end)}`
  if (bucket === 'day') return fmtWeekdayShort(p.at)
  // Woche: letzter Tag = Ende minus einen halben Tag (Sommerzeit egal)
  if (bucket === 'week') return `Woche ${fmtDayMonth(p.at)}–${fmtDayMonth((msOf(p.end) ?? 0) - 12 * 60 * 60_000)}`
  return fmtMonthYear(p.at)
}

/** Name der Auflösung in der Überschrift: «Aufrufe pro Stunde» */
export const BUCKET_WORD: Record<TrafficBucket, string> = { hour: 'pro Stunde', day: 'pro Tag', week: 'pro Woche', month: 'pro Monat' }

/**
 * Beschriftungen der x-Achse: Index → Text. Stunden: Tageswechsel als
 * Datum, sonst 6:00/12:00/18:00 (bei vielen Tagen nur Tageswechsel). Tage:
 * jeder n-te, die letzten beiden als «gestern»/«heute». Wochen und Monate
 * ebenso ausgedünnt. Höchstens etwa sieben Beschriftungen.
 */
export function axisLabels(series: Pick<TrafficPointDto, 'at'>[], bucket: TrafficBucket, now = Date.now()): Map<number, string> {
  const out = new Map<number, string>()
  const n = series.length
  if (n === 0) return out
  if (bucket === 'hour') {
    const days = n / 24
    const hours = days <= 1.5 ? [0, 6, 12, 18] : days <= 3 ? [0, 12] : [0]
    const dayStep = Math.max(1, Math.ceil(days / 7))
    let dayIndex = 0
    series.forEach((p, i) => {
      const d = dateOf(p.at)
      if (!d) return
      const h = d.getHours()
      if (h === 0) {
        if (dayIndex++ % dayStep === 0) out.set(i, fmtDayMonth(d))
      } else if (hours.includes(h) && d.getMinutes() === 0) {
        out.set(i, `${h}:00`)
      }
    })
    return out
  }
  const step = Math.max(1, Math.ceil(n / 7))
  const yesterday = now - 24 * 60 * 60_000
  for (let i = n - 1; i >= 0; i -= step) {
    const at = series[i]!.at
    if (bucket === 'day') out.set(i, sameDay(at, now) ? 'heute' : sameDay(at, yesterday) ? 'gestern' : fmtDayMonth(at))
    else if (bucket === 'week') out.set(i, fmtDayMonth(at))
    else out.set(i, fmtMonthShort(at))
  }
  return out
}

/** Gemessene Dauer in Worten: «27 Std.», «5 Tagen» (für den Hinweis unter der Kurve) */
export function measuredFor(since: string, now = Date.now()): string {
  const ms = now - (msOf(since) ?? now)
  const h = Math.max(1, Math.round(ms / 3_600_000))
  if (h < 48) return `${h} Std.`
  return `${Math.round(h / 24)} Tagen`
}

/* --- Adresse der Seite: ?zeitraum=7-tage&zugang=internet --------------------------- */

export function rangeFromSlug(slug: string | null): TrafficRange {
  const r = TRAFFIC_RANGES.find((x) => x.slug === slug)
  return r && TRAFFIC_TAB_RANGES.includes(r.key) ? r.key : '7d'
}
export const rangeSlug = (r: TrafficRange) => TRAFFIC_RANGES.find((x) => x.key === r)!.slug

export function wayFromSlug(slug: string | null): TrafficWay | 'all' {
  return TRAFFIC_WAYS.find((w) => TRAFFIC_WAY_SLUG[w] === slug) ?? 'all'
}
export const waySlug = (w: TrafficWay | 'all') => (w === 'all' ? null : TRAFFIC_WAY_SLUG[w])

/** Anteil 404 ab dem die Kennzahl warnt */
export const NOT_FOUND_WARN = 0.1

/** Gibt es überhaupt etwas zu zeigen (sonst leerer Zustand)? */
export const hasAny = (s: TrafficSummaryDto) => s.totals.views + s.totals.notFound + s.totals.bots > 0

/** Aufrufe der letzten 5 Minuten aus dem Live-Strom (ohne Kennung: Aufrufe, nicht Personen) */
export const ACTIVE_MS = 5 * 60_000
export function activeNow(events: { at: string; page?: boolean }[], now = Date.now()): number {
  return events.filter((e) => e.page !== false && now - (msOf(e.at) ?? 0) <= ACTIVE_MS).length
}
