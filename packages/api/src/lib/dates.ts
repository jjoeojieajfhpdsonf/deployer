import { badRequest } from './errors.js'

/**
 * Datumswerte aus Anfragen: nie ungeprüft an toISOString() oder Docker.
 * new Date('333333-…') ist Invalid Date; toISOString() würfe einen
 * RangeError (500), getTime() ergäbe NaN.
 */

/** «since» (ISO oder Zahl in ms) → Unix-Sekunden; Unlesbares ist ein 400 mit Feld. */
export function sinceSeconds(v: string | number | undefined | null, field = 'since'): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const d = typeof v === 'number' ? new Date(v) : new Date(v)
  const t = d.getTime()
  if (!Number.isFinite(t) || t < 0) throw badRequest(`${field}: Ungültiges Datum`, [{ path: field, message: 'Ungültiges Datum' }])
  return Math.floor(t / 1000)
}

/** ms oder ISO → ISO, ungültig → null (für Anzeigen, nie werfen). */
export function isoOrNull(v: string | number | Date | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
