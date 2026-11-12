import { TRAFFIC_RETENTION_MONTHS } from '@airlock/shared'
import { log } from '../lib/log.js'
import { hourOf } from './aggregate.js'
import type { TrafficStore } from './store.js'

/**
 * Löschfrist der Besucher-Zähler: 13 Monate (ein Jahr Vergleich plus ein
 * Monat Rand). Ein täglicher Job löscht alles, was davor liegt.
 */

/** Erster Zeitpunkt, der bleiben darf: Beginn der Stunde, 13 Kalendermonate vor jetzt (UTC) */
export function retentionCutoff(now: number, months = TRAFFIC_RETENTION_MONTHS): number {
  const d = new Date(now)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1, d.getUTCHours()))
  // Gleicher Tag im Zielmonat, am Monatsende abgeschnitten (31. März − 1 Monat = 28./29. Februar)
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay))
  return hourOf(target.getTime())
}

export async function pruneTraffic(store: TrafficStore, now = Date.now()): Promise<number> {
  const cutoff = retentionCutoff(now)
  const n = await store.deleteBefore(cutoff)
  if (n) log.info('Besucher-Zähler nach Ablauf der Frist gelöscht', { zeilen: n, vor: new Date(cutoff).toISOString() })
  return n
}

const DAY = 24 * 60 * 60_000

export function startTrafficRetentionJob(store: TrafficStore): NodeJS.Timeout {
  const tick = () => void pruneTraffic(store).catch((err) => log.warn('Besucher-Zähler nicht gelöscht', { err: String(err) }))
  setTimeout(tick, 2 * 60_000).unref()
  const t = setInterval(tick, DAY)
  t.unref()
  return t
}
