import { z } from 'zod'

/**
 * Nacht 3, Etappe 3: Server › Speicher. Belegung wie `docker system df`
 * plus die Ablagen von Airlock, was davon freigegeben werden darf, das
 * Aufräumen (wöchentlich und «Jetzt aufräumen») und verwaiste Volumes.
 */

/** Ab hier zeigt die Oberfläche einen Hinweis */
export const DISK_HINT_PERCENT = 80
/** Ab hier eine Benachrichtigung (ntfy/E-Mail), höchstens einmal pro Tag */
export const DISK_NOTIFY_PERCENT = 90
/** Ab hier lehnt Airlock Deploys ab (Rollback und Start gehen weiter) */
export const DISK_BLOCK_PERCENT = 95

/** Build-Cache, der so lange nicht benutzt wurde, darf weg */
export const BUILD_CACHE_MAX_AGE_DAYS = 7
/** Wie oft automatisch aufgeräumt wird */
export const STORAGE_CLEANUP_INTERVAL_DAYS = 7

export const STORAGE_DEFAULT_KEEP_VERSIONS = 5
export const STORAGE_KEEP_VERSIONS_MAX = 20

export type DiskLevel = 'ok' | 'hinweis' | 'warnung' | 'gesperrt'

/** Rein: Stufe zur Belegung in Prozent */
export function diskLevel(percent: number | null | undefined): DiskLevel {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'ok'
  if (percent >= DISK_BLOCK_PERCENT) return 'gesperrt'
  if (percent >= DISK_NOTIFY_PERCENT) return 'warnung'
  if (percent >= DISK_HINT_PERCENT) return 'hinweis'
  return 'ok'
}

/**
 * Rein: belegt in Prozent wie `df` (Use%): belegt / (belegt + für Benutzer frei).
 * Die für root reservierten Blöcke zählen weder als belegt noch als frei.
 */
export function diskPercentOf(s: { blocks: number; bfree: number; bavail: number }): number | null {
  const used = s.blocks - s.bfree
  const base = used + s.bavail
  if (!(base > 0) || used < 0) return null
  return Math.min(100, Math.ceil((used / base) * 100))
}

export interface DiskDto {
  usedBytes: number
  totalBytes: number
  /** Belegt in Prozent wie `df` */
  percent: number
  level: DiskLevel
}

export const storageCategoryKeys = ['images', 'build-cache', 'containers', 'volumes', 'sites', 'uploads', 'artifacts', 'logs', 'backup-staging'] as const
export type StorageCategoryKey = (typeof storageCategoryKeys)[number]

export interface StorageCategoryDto {
  key: StorageCategoryKey
  label: string
  /** Grösse in Bytes */
  bytes: number
  /** Davon gibt das nächste Aufräumen frei (Schätzung bei Images: geteilte Schichten zählen nicht) */
  reclaimableBytes: number
  /** Anzahl Objekte, wo sinnvoll (Images, Container, Volumes) */
  count: number | null
  /** Kurze Erklärung, was zählt und was nie automatisch wegkommt */
  note: string | null
}

export const cleanupItemKinds = ['deployment', 'image', 'container', 'site-version', 'upload', 'artifact', 'log'] as const
export type CleanupItemKind = (typeof cleanupItemKinds)[number]

export interface CleanupItemDto {
  kind: CleanupItemKind
  /** Name, Tag oder Pfad (ohne Geheimnisse) */
  name: string
  /** Slug des Projekts, falls bekannt */
  project: string | null
  /** Warum es weg darf, als Satz */
  reason: string
  bytes: number | null
}

export interface CleanupPlanDto {
  /** Einzelne Posten (höchstens 200; total zählt alle) */
  items: CleanupItemDto[]
  total: number
  /** Je Art: Anzahl und Bytes */
  byKind: { kind: CleanupItemKind; count: number; bytes: number }[]
  /** Build-Cache, der älter ist als BUILD_CACHE_MAX_AGE_DAYS und nicht benutzt wird; null = ausgeschaltet */
  buildCache: { count: number; bytes: number } | null
  /** Würde etwa so viel freigeben */
  bytes: number
}

export interface OrphanVolumeDto {
  name: string
  /** Slug des gelöschten Projekts (aus dem Label) */
  project: string | null
  bytes: number | null
  createdAt: string | null
  /** In Benutzung (Container hängt es ein): dann nicht löschbar */
  inUse: boolean
}

export interface StorageSettingsDto {
  /** Frühere Fassungen pro Projekt, die für ein Rollback bleiben (zusätzlich zur aktiven) */
  keepVersions: number
  /** Build-Cache älter als 7 Tage mit aufräumen */
  pruneBuildCache: boolean
}

export const storageSettingsSchema = z.object({
  keepVersions: z
    .number({ invalid_type_error: 'Eine ganze Zahl' })
    .int('Eine ganze Zahl')
    .min(1, 'Mindestens 1 – sonst gäbe es kein Rollback')
    .max(STORAGE_KEEP_VERSIONS_MAX, `Höchstens ${STORAGE_KEEP_VERSIONS_MAX}`),
  pruneBuildCache: z.boolean(),
})

export interface CleanupRunDto {
  at: string
  actor: string
  trigger: 'manual' | 'schedule' | 'cli'
  ok: boolean
  freedBytes: number
  removed: number
  failed: number
}

export interface StorageDto {
  /** null: Platte nicht lesbar */
  disk: DiskDto | null
  categories: StorageCategoryDto[]
  plan: CleanupPlanDto
  orphanVolumes: OrphanVolumeDto[]
  settings: StorageSettingsDto
  lastRun: CleanupRunDto | null
  nextRunAt: string | null
  /** Deploys gesperrt (Platte ≥ DISK_BLOCK_PERCENT) */
  deploysBlocked: boolean
  /** Wann die Grössen gemessen wurden (zwischengespeichert, «Neu messen» frisch) */
  measuredAt: string
  /** Läuft gerade ein Aufräumen? */
  running: boolean
  /** Was nicht gemessen werden konnte (z. B. Docker-Belegung ohne Recht im Socket-Proxy) */
  problems: string[]
}

export interface CleanupResultDto {
  run: CleanupRunDto
  /** Was nicht ging, als Sätze */
  errors: string[]
}

/** Löschen eines verwaisten Volumes: der Name muss eingetippt werden */
export const deleteVolumeSchema = z.object({ confirm: z.string().min(1).max(255) })
