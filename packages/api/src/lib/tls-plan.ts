/**
 * Schutz vor dem Rate-Limit von Let's Encrypt (Produktion): Wann darf
 * deployer ein produktives Zertifikat bestellen lassen? Rein, ohne Zugriff
 * auf Datenbank oder Caddy (lib/tls-plan.test.ts).
 *
 * - Liegt ein gültiges produktives Zertifikat vor (gesehen per TLS-Prüfung
 *   oder laut Caddy-Log bezogen), wird keins neu bestellt: Caddy lädt es mit
 *   der Produktions-Konfiguration aus seinem Speicher.
 * - Sonst höchstens ein produktiver Versuch pro Stunde.
 */

export const PROD_RETRY_MS = 60 * 60_000
/** Restlaufzeit, ab der ein vorhandenes Zertifikat nicht mehr als «gültig» zählt */
export const PROD_MIN_REMAINING_MS = 7 * 86_400_000
/** Laut Log bezogen, Ablauf unbekannt: so lange gilt es als vorhanden (LE-Zertifikate laufen länger) */
export const PROD_LOG_ASSUMED_MS = 30 * 86_400_000

export interface ProdCert {
  /** Ablauf; bei Quelle «log» geschätzt */
  validTo: string
  issuer: string | null
  seenAt: string
  source: 'probe' | 'log'
  /** Kette in Node vertrauenswürdig (nur bei Quelle «probe» bekannt) */
  trusted: boolean | null
}

export interface ProdState {
  prodAttemptAt?: string
  prodCert?: ProdCert
}

export function prodCertUsable(s: ProdState, now = new Date()): boolean {
  if (!s.prodCert) return false
  return Date.parse(s.prodCert.validTo) - now.getTime() > PROD_MIN_REMAINING_MS
}

/** Frühester Zeitpunkt für den nächsten produktiven Versuch; null = jetzt erlaubt oder nicht nötig. */
export function nextProdAttemptAt(s: ProdState, now = new Date()): Date | null {
  if (prodCertUsable(s, now)) return null
  if (!s.prodAttemptAt) return null
  const next = Date.parse(s.prodAttemptAt) + PROD_RETRY_MS
  return next > now.getTime() ? new Date(next) : null
}

export type TlsStartPlan =
  /** Gültiges produktives Zertifikat vorhanden: direkt Produktions-Konfiguration, kein neuer Bezug */
  | { kind: 'reuse' }
  /** Normal: Probelauf bei Staging, danach Produktion */
  | { kind: 'staging' }
  /** Produktiver Versuch innerhalb der letzten Stunde: warten */
  | { kind: 'wait'; until: Date }

export function planTlsStart(s: ProdState, now = new Date()): TlsStartPlan {
  if (prodCertUsable(s, now)) return { kind: 'reuse' }
  const until = nextProdAttemptAt(s, now)
  return until ? { kind: 'wait', until } : { kind: 'staging' }
}

/** Darf jetzt (Beginn der Produktionsphase) produktiv bestellt werden? */
export function mayOrderProduction(s: ProdState, now = new Date()): { ok: true; reuse: boolean } | { ok: false; until: Date } {
  if (prodCertUsable(s, now)) return { ok: true, reuse: true }
  const until = nextProdAttemptAt(s, now)
  return until ? { ok: false, until } : { ok: true, reuse: false }
}

/** Uhrzeit für Meldungen (Schweiz) */
export const clock = (d: Date) => d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })
