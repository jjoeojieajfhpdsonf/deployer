import type { ClientIpReport } from '../lib/client-ips.js'

const DAY = 24 * 60 * 60_000

/**
 * Rein (Antwort 11): soll die Gateway-Warnung gemeldet werden? Nur mit
 * Gateway-Anfragen, und höchstens einmal pro Tag. Ein unlesbarer
 * Zeitstempel zählt wie «nie gemeldet».
 */
export function shouldWarn(r: ClientIpReport | null, lastIso: string | null, now: number): boolean {
  if (!r || r.fromGateway === 0) return false
  const last = lastIso ? Date.parse(lastIso) : NaN
  return !Number.isFinite(last) || now - last >= DAY
}
