/**
 * Automatischer Ablauf von Chat-Deploys (SPEC): nach N Tagen ohne Änderung
 * stoppen, nicht löschen; 3 Tage vorher melden. `keep` nimmt ein Projekt aus.
 *
 * "Aktivität" ist genau ein Feld: last_change_at. Jede bewusste Handlung
 * (Dateien ändern, Deploy, Rollback, Start) setzt es und löscht die Warnung –
 * siehe touchActivity(). Job und Oberfläche lesen dasselbe Feld und zeigen
 * damit dasselbe Datum (Review M3).
 *
 * Reine Funktion ohne Import von config.ts, damit sie testbar bleibt.
 */

export const WARN_BEFORE_DAYS = 3
const DAY = 24 * 60 * 60 * 1000

export interface ExpiryInput {
  sourceType: string
  keep: boolean
  desiredState: string
  lastChangeAt: Date
  expiryWarnedAt: Date | null
}

export type ExpiryDecision = 'none' | 'warn' | 'stop'

export function expiresAt(p: Pick<ExpiryInput, 'sourceType' | 'keep' | 'lastChangeAt'>, days: number): Date | null {
  if (p.sourceType !== 'files' || p.keep) return null
  return new Date(p.lastChangeAt.getTime() + days * DAY)
}

export function expiryDecision(p: ExpiryInput, now: Date, days: number): ExpiryDecision {
  if (p.sourceType !== 'files' || p.keep || p.desiredState !== 'running') return 'none'
  const idle = now.getTime() - p.lastChangeAt.getTime()
  if (idle >= days * DAY) return 'stop'
  // Nur einmal pro Frist warnen; jede Aktivität setzt expiryWarnedAt zurück.
  if (idle >= (days - WARN_BEFORE_DAYS) * DAY && !p.expiryWarnedAt) return 'warn'
  return 'none'
}
