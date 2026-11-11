import { z } from 'zod'

/**
 * Meilenstein Backup (docs/MILESTONE-BACKUP.md): Einstellungen, Läufe und
 * Stände der Sicherung. Geheimnisse (Repository-Passwort, S3-Zugangsdaten)
 * gehen nur hinein, nie heraus: die Antworten sagen nur, ob sie gesetzt sind.
 */

export const backupTargetKinds = ['local', 's3'] as const
export type BackupTargetKind = (typeof backupTargetKinds)[number]

/** Projekt-Volumes: live abziehen, kurz stoppen oder gar nicht sichern */
export const backupProjectModes = ['live', 'stop', 'skip'] as const
export type BackupProjectMode = (typeof backupProjectModes)[number]

/** Wurzel des lokalen Ziels im Backup-Container (compose.yaml: BACKUP_LOCAL_DIR → /target) */
export const BACKUP_LOCAL_ROOT = '/target'

export const BACKUP_DEFAULT_TIME = '03:30'
export const BACKUP_DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 6 } as const
export const BACKUP_PASSWORD_MIN = 12

const keepCount = (what: string) =>
  z.number({ invalid_type_error: `${what}: eine ganze Zahl` }).int(`${what}: eine ganze Zahl`).min(0, `${what}: mindestens 0`).max(1000, `${what}: höchstens 1000`)

export const backupRetentionSchema = z
  .object({ daily: keepCount('Tägliche Stände'), weekly: keepCount('Wöchentliche Stände'), monthly: keepCount('Monatliche Stände') })
  .refine((r) => r.daily + r.weekly + r.monthly > 0, 'Mindestens ein Stand muss aufbewahrt werden')
export type BackupRetention = z.infer<typeof backupRetentionSchema>

export const backupTimeSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit als HH:MM, z.B. 03:30')

/** Geheimnis im Formular: undefined = unverändert, Text = neu (leer gibt es nicht: ein Ziel braucht es) */
const secretInput = (what: string) => z.string().trim().min(1, `${what} fehlt`).max(1024, `${what}: höchstens 1024 Zeichen`).optional()

export const backupLocalTargetSchema = z.object({
  kind: z.literal('local'),
  /** Pfad im Backup-Container unter /target, z.B. /target/airlock */
  path: z.string().trim().min(1, 'Gib einen Pfad an, z.B. /target/airlock').max(255, 'Höchstens 255 Zeichen'),
})

export const backupS3TargetSchema = z.object({
  kind: z.literal('s3'),
  /** z.B. https://s3.eu-central-003.backblazeb2.com oder http://minio:9000 */
  endpoint: z.string().trim().regex(/^https?:\/\/[^\s/?#]+(:\d+)?\/?$/i, 'Endpoint als https://host (ohne Pfad), z.B. https://s3.eu-central-003.backblazeb2.com'),
  bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Bucket: 3–63 Zeichen aus a-z, 0-9, Punkt und Bindestrich'),
  /** Unterordner im Bucket, leer = Wurzel */
  prefix: z.string().trim().max(200, 'Höchstens 200 Zeichen').regex(/^$|^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'Unterordner: Buchstaben, Ziffern, . _ - und /').default(''),
  /** Leer = Vorgabe des Anbieters (Cloudflare R2: auto) */
  region: z.string().trim().max(64, 'Höchstens 64 Zeichen').regex(/^$|^[a-z0-9-]+$/, 'Region: a-z, 0-9 und -').default(''),
  accessKeyId: secretInput('Access-Key'),
  secretAccessKey: secretInput('Secret-Key'),
})

export const backupTargetInputSchema = z.discriminatedUnion('kind', [backupLocalTargetSchema, backupS3TargetSchema])
export type BackupTargetInput = z.infer<typeof backupTargetInputSchema>

export const backupSettingsInputSchema = z.object({
  target: backupTargetInputSchema.optional(),
  /** Repository-Passwort: undefined = unverändert. Ohne es ist jedes Backup wertlos – getrennt aufbewahren. */
  password: z.string().min(BACKUP_PASSWORD_MIN, `Mindestens ${BACKUP_PASSWORD_MIN} Zeichen`).max(1024, 'Höchstens 1024 Zeichen').optional(),
  enabled: z.boolean().optional(),
  time: backupTimeSchema.optional(),
  retention: backupRetentionSchema.optional(),
  /** Je Projekt (Slug): live, stop oder skip. Fehlende Projekte: live */
  projects: z.record(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/), z.enum(backupProjectModes)).optional(),
})
export type BackupSettingsInput = z.infer<typeof backupSettingsInputSchema>

export type BackupTargetDto =
  | { kind: 'local'; path: string }
  | { kind: 's3'; endpoint: string; bucket: string; prefix: string; region: string; hasAccessKey: boolean; hasSecretKey: boolean }

export interface BackupSettingsDto {
  /** Ziel und Passwort gesetzt */
  configured: boolean
  enabled: boolean
  target: BackupTargetDto | null
  hasPassword: boolean
  /** Nächtlicher Lauf (Ortszeit des Servers, timeZone) */
  time: string
  timeZone: string
  retention: BackupRetention
  projects: Record<string, BackupProjectMode>
  /** Repository zuletzt erreicht bzw. angelegt («Verbindung testen» oder Lauf) */
  repositoryCheckedAt: string | null
  /** Letztes «restic check» (einmal pro Woche) */
  lastCheckAt: string | null
}

export const backupRunStatuses = ['running', 'ok', 'warning', 'failed'] as const
export type BackupRunStatus = (typeof backupRunStatuses)[number]

export interface BackupRunDto {
  id: string
  trigger: 'schedule' | 'manual'
  actor: string
  status: BackupRunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  snapshotId: string | null
  /** Neu ins Repository geschrieben (nach Deduplizierung) */
  bytesNew: number | null
  /** Grösse aller gesicherten Dateien dieses Stands */
  bytesTotal: number | null
  filesNew: number | null
  error: string | null
  /** z.B. Aufbewahrung gescheitert, Projekt live statt gestoppt */
  warnings: string[]
}

export interface BackupSnapshotDto {
  id: string
  shortId: string
  time: string
  tags: string[]
  paths: string[]
  /** Grösse laut restic (ab 0.17), sonst null */
  bytesTotal: number | null
}

/** Projekt aus allen Umgebungen: Compose-Projekte für live/stop/skip, alle für den Restore */
export interface BackupProjectDto {
  slug: string
  name: string
  environment: string
  /** compose, files, static, … – nur Compose-Projekte haben eigene Volumes */
  sourceType: string
}

export interface BackupStatusDto {
  settings: BackupSettingsDto
  /** Projekte aller Umgebungen (Volumes: nur sourceType compose) */
  projects: BackupProjectDto[]
  /** Etappe 4: ist der Schlüssel der Secrets getrennt gesichert? */
  key: BackupKeyStatusDto
  /** Etappe 5: laufender oder letzter Restore eines Projekts (seit dem Start von Airlock) */
  restore: BackupRestoreDto | null
  running: boolean
  lastRun: BackupRunDto | null
  lastSuccessAt: string | null
  /** Über 48 h ohne Erfolg (bei eingerichteter, eingeschalteter Sicherung) */
  stale: boolean
  /** Nächster geplanter Lauf (ISO), null wenn aus */
  nextRunAt: string | null
  runs: BackupRunDto[]
}

/* --- Etappe 4: Schlüssel der Secrets getrennt sichern ---------------------------------- */

export const backupKeyMethods = ['file', 'paper'] as const
export type BackupKeyMethod = (typeof backupKeyMethods)[number]
export const BACKUP_PASSPHRASE_MIN = 12

/** Frische Anmeldung: das Anmelde-Passwort noch einmal, bei jedem Export */
const reauthPassword = z.string().min(1, 'Gib dein Anmelde-Passwort ein').max(1024, 'Höchstens 1024 Zeichen')

export const backupKeyFileInputSchema = z.object({
  password: reauthPassword,
  passphrase: z.string().min(BACKUP_PASSPHRASE_MIN, `Mindestens ${BACKUP_PASSPHRASE_MIN} Zeichen`).max(1024, 'Höchstens 1024 Zeichen'),
})
export const backupKeyPaperInputSchema = z.object({ password: reauthPassword })
export const backupKeyConfirmSchema = z.object({ method: z.enum(backupKeyMethods) })
/** Exportierte Datei prüfen: Base64 der .age-Datei (wenige hundert Bytes) und die Passphrase */
export const backupKeyVerifySchema = z.object({
  file: z.string().min(1, 'Wähle die exportierte Datei').max(100_000, 'Das ist keine Schlüssel-Datei von Airlock (zu gross)'),
  passphrase: z.string().min(1, 'Gib die Passphrase der Datei ein').max(1024, 'Höchstens 1024 Zeichen'),
})

export interface BackupKeyStatusDto {
  /** Prüfsumme des aktuellen Schlüssels (SHA-256, 16 Hex-Zeichen) – nicht der Schlüssel */
  fingerprint: string
  /** Merker «Schlüssel gesichert am …»; null = nie oder für einen anderen Schlüssel */
  savedAt: string | null
  method: BackupKeyMethod | null
}

export interface BackupKeyFileDto {
  filename: string
  /** Die age-Datei als Base64 (mit der Passphrase verschlüsselt) */
  file: string
  fingerprint: string
}

export interface BackupKeyPaperDto {
  /** Der Schlüssel als Base64 – nur nach frischer Anmeldung, nur für die Druckansicht */
  key: string
  /** Derselbe Schlüssel als Hex in Vierergruppen (zum Abtippen) */
  hex: string[]
  fingerprint: string
  /** Ganze SHA-256 zum Vergleich mit «sha256sum secrets.key» */
  sha256: string
  /** QR-Code des Base64-Texts: je Zeile ein String aus «1» (dunkel) und «0» */
  qr: string[]
  server: string
  createdAt: string
}

export interface BackupKeyVerifyDto {
  matches: boolean
  fingerprint: string
}

/* --- Etappe 5: ein Projekt aus einem Stand zurückholen ---------------------------------- */

const snapshotRef = z.string().trim().regex(/^[0-9a-f]{8,64}$/, 'Kennung eines Stands: 8 bis 64 Hex-Zeichen')
const projectRef = z.string().trim().min(1, 'Wähle ein Projekt').max(64, 'Höchstens 64 Zeichen')

export const backupRestorePreviewSchema = z.object({ snapshot: snapshotRef, project: projectRef })
export const backupRestoreInputSchema = z.object({
  snapshot: snapshotRef,
  project: projectRef,
  /** Der Slug des Projekts, im Dialog eingetippt (zerstörerisch) */
  confirm: z.string().max(64, 'Höchstens 64 Zeichen'),
})

export interface BackupRestorePartDto {
  kind: 'volume' | 'site' | 'repo'
  /** Volume-Name bzw. Slug */
  name: string
  files: number
  bytes: number
}

export interface BackupRestorePreviewDto {
  snapshot: { id: string; shortId: string; time: string }
  project: { id: string; slug: string; name: string }
  parts: BackupRestorePartDto[]
  /** Liste von restic war länger als gelesen: Zahlen sind Untergrenzen */
  truncated: boolean
  /** Laufende Container des Projekts, die für den Restore angehalten werden */
  runningContainers: number
}

export interface BackupRestoreDto {
  id: string
  status: 'running' | 'ok' | 'failed'
  actor: string
  project: { id: string; slug: string; name: string }
  snapshot: { id: string; shortId: string; time: string }
  startedAt: string
  finishedAt: string | null
  error: string | null
  /** z.B. «Volume data», «Statische Seite», «Repository» */
  restored: string[]
  warnings: string[]
}

export interface BackupTestResultDto {
  ok: boolean
  /** Repository bei diesem Test neu angelegt */
  initialized: boolean
  message: string
}
