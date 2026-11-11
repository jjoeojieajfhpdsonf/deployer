/**
 * Die einzige Stelle der Oberfläche, die Datumswerte aus der API in Date
 * umwandelt und formatiert. Alles darf ungültig sein (null, leer, «Jahr
 * 333333», Unsinn): dann gibt es null bzw. «–», nie eine Ausnahme und nie
 * «Invalid Date». Ein Test (dates.test.ts) prüft, dass sonst niemand
 * `new Date(wert)`, `Date.parse`, `toISOString` oder `toLocale…String` auf
 * Datumswerten benutzt.
 *
 * Schweizer Format: 11.11.2026, 14:05.
 */

const LOCALE = 'de-CH'

/** Gültiger Zeitpunkt in Millisekunden oder null. */
export function msOf(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)
  // ±8.64e15 ist die Grenze von Date; alles darüber wirft bei toISOString()
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : null
}

/** Gültiges Date oder null. */
export function dateOf(v: string | number | Date | null | undefined): Date | null {
  const t = msOf(v)
  return t === null ? null : new Date(t)
}

/** ISO-Zeichenkette oder null (für `<time dateTime>` und die API). */
export function isoOf(v: string | number | Date | null | undefined): string | null {
  const d = dateOf(v)
  return d ? d.toISOString() : null
}

/** Jetzt als ISO-Zeichenkette. */
export const nowIso = (): string => new Date().toISOString()

/** Millisekunden seit dem Zeitpunkt (negativ: liegt in der Zukunft) oder null. */
export function ageMs(v: string | number | Date | null | undefined, now = Date.now()): number | null {
  const t = msOf(v)
  return t === null ? null : now - t
}

/** Millisekunden zwischen zwei Zeitpunkten (b − a) oder null. */
export function spanMs(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = msOf(a)
  const y = msOf(b)
  return x === null || y === null ? null : y - x
}

function fmt(v: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions, fallback = '–'): string {
  const d = dateOf(v)
  if (!d) return fallback
  try { return d.toLocaleString(LOCALE, opts) } catch { return fallback }
}

/** «1.3.2026, 14:05:09» – voller Zeitpunkt, z. B. für Tooltips. */
export const fmtDateTime = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }, fallback)

/** «1.3.2026, 14:05» */
export const fmtDateTimeShort = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }, fallback)

/** «01.03.2026, 14:05» (mittlere Datumsform) */
export const fmtDateTimeMedium = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { dateStyle: 'medium', timeStyle: 'short' }, fallback)

/** «11.11., 14:05» – ohne Jahr. */
export const fmtDayTime = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }, fallback)

/** «1.3.2026» */
export const fmtDate = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { day: 'numeric', month: 'numeric', year: 'numeric' }, fallback)

/** «11.11.» */
export const fmtDayMonth = (v: string | number | Date | null | undefined, fallback = '–') =>
  fmt(v, { day: '2-digit', month: '2-digit' }, fallback)

/** «14:05» bzw. mit Sekunden «14:05:09» */
export const fmtTime = (v: string | number | Date | null | undefined, seconds = false, fallback = '–') =>
  fmt(v, seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }, fallback)

/** «10.11.2026, 13:46:01 UTC» – derselbe Zeitpunkt in UTC (Tooltip neben der Ortszeit, UI-Qualität 4) */
export const fmtUtc = (v: string | number | Date | null | undefined, fallback = '–') => {
  const s = fmt(v, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }, fallback)
  return s === fallback ? s : `${s} UTC`
}

/** Zeitstempel für Dateinamen und Downloads: «2026-11-10 14:46:01» in Ortszeit */
export const fmtStamp = (v: string | number | Date | null | undefined, fallback = '') => {
  const d = dateOf(v)
  if (!d) return fallback
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** «Mittwoch, 11. November» – für Tagesüberschriften. */
export const fmtWeekday = (v: string | number | Date | null | undefined, withYear = false, fallback = '–') =>
  fmt(v, withYear ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' }, fallback)

/** Gleicher Kalendertag (Ortszeit)? Ungültige Werte: false. */
export function sameDay(a: string | number | Date | null | undefined, b: string | number | Date | null | undefined): boolean {
  const x = dateOf(a)
  const y = dateOf(b)
  return Boolean(x && y && x.toDateString() === y.toDateString())
}

/** Derselbe Zeitpunkt um `days` Tage verschoben (Ortszeit). */
export function addDays(v: Date, days: number): Date {
  const d = new Date(v.getTime())
  d.setDate(d.getDate() + days)
  return d
}
