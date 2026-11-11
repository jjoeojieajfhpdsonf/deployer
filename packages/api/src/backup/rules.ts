/**
 * Meilenstein Backup: Zeitregeln – wann der nächtliche Lauf fällig ist,
 * wann «48 h ohne Erfolg» gemeldet wird, wann «restic check» dran ist.
 *
 * Reines Modul (kein config.ts, keine Datenbank), damit es testbar bleibt.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const STALE_AFTER_MS = 48 * HOUR
/** «48 h ohne Erfolg» höchstens einmal pro Tag melden */
export const STALE_REPEAT_MS = DAY
export const CHECK_EVERY_MS = 7 * DAY

/* --- Ortszeit ohne Bibliothek ------------------------------------------------------- */

interface Parts { y: number; m: number; d: number; h: number; min: number }

function partsIn(date: Date, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const get = (t: string) => Number(f.formatToParts(date).find((p) => p.type === t)?.value)
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') }
}

/** Abstand der Zeitzone zu UTC in ms zu einem Zeitpunkt (Zürich im Sommer: +2 h) */
function offsetAt(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
  return asUtc - Math.floor(date.getTime() / MIN) * MIN
}

/** Zeitpunkt zu einer Ortszeit (Kalendertag + HH:MM) in einer Zeitzone */
function zonedTime(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min)
  // Zweimal: der Abstand kann sich zwischen Vermutung und Ergebnis ändern (Umstellung)
  let t = guess - offsetAt(new Date(guess), timeZone)
  t = guess - offsetAt(new Date(t), timeZone)
  return new Date(t)
}

function parseTime(time: string): { h: number; min: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!m) throw new Error(`Uhrzeit «${time}» nicht als HH:MM lesbar`)
  return { h: Number(m[1]), min: Number(m[2]) }
}

/** Letzter Termin (heute oder gestern um time, Ortszeit) bis einschliesslich now */
export function lastSlot(now: Date, time: string, timeZone: string): Date {
  const { h, min } = parseTime(time)
  const p = partsIn(now, timeZone)
  let slot = zonedTime(p.y, p.m, p.d, h, min, timeZone)
  if (slot.getTime() > now.getTime()) {
    const y = partsIn(new Date(Date.UTC(p.y, p.m - 1, p.d) - DAY / 2), 'UTC')
    slot = zonedTime(y.y, y.m, y.d, h, min, timeZone)
  }
  return slot
}

/** Nächster Termin nach now */
export function nextSlot(now: Date, time: string, timeZone: string): Date {
  const last = lastSlot(now, time, timeZone)
  // Einen guten Tag später neu ausrechnen (23 oder 25 Stunden bei Umstellung)
  return lastSlot(new Date(last.getTime() + DAY + 2 * HOUR), time, timeZone)
}

export interface DueInput {
  now: Date
  enabled: boolean
  configured: boolean
  time: string
  timeZone: string
  /** Letzter geplanter Lauf (auch gescheiterte zählen: kein Dauerversuch) */
  lastScheduledAt: Date | null
  /** Seit wann eingerichtet: ein Termin davor holt nichts nach */
  configuredAt: Date | null
}

/**
 * Ist der nächtliche Lauf fällig? Ja, wenn der letzte Termin nach dem
 * letzten geplanten Lauf und nach der Einrichtung liegt. Ein verpasster
 * Termin (Server aus) wird so beim nächsten Takt nachgeholt – einmal.
 */
export function isDue(o: DueInput): boolean {
  if (!o.enabled || !o.configured) return false
  const slot = lastSlot(o.now, o.time, o.timeZone).getTime()
  if (o.configuredAt && slot < o.configuredAt.getTime()) return false
  if (o.lastScheduledAt && o.lastScheduledAt.getTime() >= slot) return false
  return true
}

export interface StaleInput {
  now: Date
  enabled: boolean
  configured: boolean
  lastSuccessAt: Date | null
  /** Ohne je einen Erfolg zählt die Frist ab der Einrichtung */
  configuredAt: Date | null
  lastStaleNotifiedAt: Date | null
}

/** Über 48 h ohne Erfolg? */
export function isStale(o: Omit<StaleInput, 'lastStaleNotifiedAt'>): boolean {
  if (!o.enabled || !o.configured) return false
  const since = o.lastSuccessAt ?? o.configuredAt
  if (!since) return false
  return o.now.getTime() - since.getTime() > STALE_AFTER_MS
}

/** Jetzt «48 h ohne Erfolg» melden? Höchstens einmal pro Tag. */
export function shouldNotifyStale(o: StaleInput): boolean {
  if (!isStale(o)) return false
  if (!o.lastStaleNotifiedAt) return true
  // Eine Meldung aus der Zeit vor dem letzten Erfolg zählt nicht mehr
  if (o.lastSuccessAt && o.lastStaleNotifiedAt.getTime() < o.lastSuccessAt.getTime()) return true
  return o.now.getTime() - o.lastStaleNotifiedAt.getTime() >= STALE_REPEAT_MS
}

/** «restic check» einmal pro Woche */
export function checkDue(lastCheckAt: Date | null, now: Date): boolean {
  return !lastCheckAt || now.getTime() - lastCheckAt.getTime() >= CHECK_EVERY_MS
}
