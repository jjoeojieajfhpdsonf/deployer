import { z } from 'zod'

/**
 * Etappe 6 «Vorschau-Deploys»: pro Branch bzw. Pull Request eine eigene
 * Fassung unter <branch-slug>--<projekt>.int.<basis>. Immer nur intern
 * (LAN/Tailnet), nie öffentlich – auch nicht per Schalter.
 */

/** Höchstens so viele Vorschauen pro Projekt; die mit dem ältesten Push fällt raus */
export const PREVIEW_MAX = 3
/** Nach so vielen Tagen ohne Push wird eine Vorschau entfernt */
export const PREVIEW_IDLE_DAYS = 7

/** Zustand einer Vorschau (immer mit Wort angezeigt, nie nur Farbe) */
export type PreviewState = 'deploying' | 'ready' | 'failed' | 'stopped'

export interface PreviewScanDto {
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  grade: 'A' | 'B' | 'C' | 'D' | null
  score: number | null
  open: { critical: number; high: number; medium: number; low: number }
}

export interface PreviewDto {
  /** ID des Vorschau-Projekts */
  id: string
  branch: string
  /** DNS-Label <branch-slug>--<projekt> */
  label: string
  /** Interne Adresse (nur LAN/Tailnet), null solange keine Route besteht */
  url: string | null
  host: string | null
  prNumber: number | null
  prUrl: string | null
  /** Commit der Vorschau (zuletzt erkannter Push) */
  headSha: string | null
  lastPushAt: string
  createdAt: string
  /** Fällt ohne weiteren Push an diesem Zeitpunkt weg */
  expiresAt: string
  state: PreviewState
  /** Letztes Deployment der Vorschau (für das Log) */
  deploymentId: string | null
  /** Kurz, warum der letzte Deploy scheiterte */
  failure: string | null
  /** Gescheitert, weil geheime Variablen für Vorschauen fehlen (Oberfläche: Link zur Ebene «Vorschau») */
  failureSecrets: boolean
  scan: PreviewScanDto | null
}

export interface PreviewsDto {
  /** Schalter «Vorschauen» am Projekt */
  enabled: boolean
  /** Geht es bei diesem Projekt überhaupt (Git-Repo mit GitHub-App)? */
  available: boolean
  /** Warum nicht (Text für den deaktivierten Schalter) */
  reason: string | null
  /** owner/repo, wenn verbunden */
  repo: string | null
  /** Zuletzt bei GitHub nachgesehen */
  checkedAt: string | null
  /** Interne Adresse einer Vorschau, als Muster (z. B. <branch>--fotoalbum.int.example.ch) */
  pattern: string | null
  max: number
  idleDays: number
  /** Nur Pull Requests aus demselben Repo, keine Forks */
  previews: PreviewDto[]
}

export const previewSettingSchema = z.object({ enabled: z.boolean() })
export type PreviewSettingInput = z.infer<typeof previewSettingSchema>

/**
 * Korrektur nach Nacht 2: Vorschauen erben nur die normalen Variablen des
 * Projekts, keine geheimen (Branch-Code soll nicht mit echten Schlüsseln
 * laufen). Fehlt ein Geheimnis auf der Ebene «Vorschau», scheitert der
 * Vorschau-Deploy mit diesem Satz (Fehlercode der Pipeline).
 */
export const PREVIEW_SECRET_MISSING = 'preview_secret_missing'

/** Weg zur Ebene «Vorschau» (in der Meldung; die Oberfläche macht daraus einen Link) */
export const PREVIEW_ENV_PATH = 'Einstellungen › Vorschauen › Variablen'

export function previewSecretsMissingMessage(keys: string[]): string {
  const names = keys.join(', ')
  return keys.length === 1
    ? `Geheime Variable ${names} fehlt – in ${PREVIEW_ENV_PATH} setzen`
    : `Geheime Variablen ${names} fehlen – in ${PREVIEW_ENV_PATH} setzen`
}

/** Text zum Zustand (Pille in der Liste, Kommentar am PR) */
export function previewStateLabel(s: PreviewState): string {
  switch (s) {
    case 'deploying': return 'wird deployt'
    case 'ready': return 'bereit'
    case 'failed': return 'fehlgeschlagen'
    case 'stopped': return 'gestoppt'
  }
}
