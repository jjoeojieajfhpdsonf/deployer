import { posix } from 'node:path'
import { BACKUP_LOCAL_ROOT, type BackupRetention } from '@airlock/shared'

/**
 * Meilenstein Backup: alles, was restic betrifft und ohne Docker auskommt –
 * Repository-Adresse, Umgebung, Argumente, Ausschlüsse, Auswerten der
 * Ausgabe, Schwärzen von Zugangsdaten.
 *
 * Reines Modul (kein config.ts, keine Datenbank), damit es testbar bleibt.
 *
 * Grundsatz: Geheimnisse gehen nur über die Umgebung des exec-Prozesses an
 * restic (RESTIC_PASSWORD, AWS_*), nie über Argumente – die stehen in
 * «docker exec inspect» (ProcessConfig.arguments) und in jeder Prozessliste.
 */

/* --- Pfade im Backup-Container (compose.yaml, Service backup) -------------------- */

/** Staging (Volume backup_staging): Datenbank-Dump und Kopien der Projekt-Volumes */
export const STAGING_DIR = '/staging'
export const STAGING_DB_DIR = `${STAGING_DIR}/db`
export const STAGING_DUMP_FILE = `${STAGING_DB_DIR}/airlock.dump`
export const STAGING_VOLUMES_DIR = `${STAGING_DIR}/volumes`
/** Cache von restic: liegt im Staging, wird aber nie gesichert */
export const RESTIC_CACHE_DIR = `${STAGING_DIR}/cache`

/** Read-only eingehängte Volumes des Stacks */
export const SOURCE_DIRS = {
  caddyData: '/source/caddy_data',
  sites: '/source/sites',
  data: '/source/data',
} as const

/** Was ein Stand enthält, in dieser Reihenfolge */
export const BACKUP_PATHS = [STAGING_DB_DIR, STAGING_VOLUMES_DIR, SOURCE_DIRS.caddyData, SOURCE_DIRS.sites, SOURCE_DIRS.data] as const

/**
 * Ausschlüsse. keys/ (secrets.key) ist PFLICHT: der Schlüssel zu allen
 * gesicherten Secrets darf nie im selben Backup liegen (Etappe 4 sichert ihn
 * getrennt). Dazu Zwischenstände, die nach jedem Deploy/Scan weg sind.
 */
export const KEYS_EXCLUDE = `${SOURCE_DIRS.data}/keys`
export function backupExcludes(): string[] {
  return [
    KEYS_EXCLUDE,
    `${SOURCE_DIRS.data}/work`,
    `${SOURCE_DIRS.data}/scan`,
    `${SOURCE_DIRS.data}/scan-src`,
  ]
}

/** Feste Host-Kennung: der Container-Hostname wechselt sonst mit jedem Neuerstellen, und forget fände die alten Stände nicht mehr */
export const RESTIC_HOST = 'airlock'
export const RESTIC_TAG = 'airlock'

/* --- Ziel ------------------------------------------------------------------------- */

export type ResolvedTarget =
  | { kind: 'local'; path: string }
  | { kind: 's3'; endpoint: string; bucket: string; prefix: string; region: string; accessKeyId: string; secretAccessKey: string }

/**
 * Lokaler Pfad: absolut, unter /target, ohne «..». Gibt den bereinigten Pfad
 * zurück oder wirft mit einer Meldung für das Formular.
 */
export function normalizeLocalPath(input: string): string {
  const raw = input.trim()
  if (!raw.startsWith('/')) throw new Error(`Der Pfad muss mit ${BACKUP_LOCAL_ROOT}/ beginnen, z.B. ${BACKUP_LOCAL_ROOT}/airlock`)
  if (raw.split('/').includes('..')) throw new Error('Der Pfad darf kein «..» enthalten')
  const p = posix.normalize(raw).replace(/\/+$/, '') || '/'
  if (p !== BACKUP_LOCAL_ROOT && !p.startsWith(`${BACKUP_LOCAL_ROOT}/`)) {
    throw new Error(`Der Pfad muss unter ${BACKUP_LOCAL_ROOT} liegen (dort ist BACKUP_LOCAL_DIR eingehängt), z.B. ${BACKUP_LOCAL_ROOT}/airlock`)
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error('Der Pfad: nur Buchstaben, Ziffern, . _ - und /')
  return p
}

/** Repository-Adresse für restic (ohne Zugangsdaten) */
export function repositoryUrl(t: ResolvedTarget): string {
  if (t.kind === 'local') return normalizeLocalPath(t.path)
  const endpoint = t.endpoint.trim().replace(/\/+$/, '')
  const prefix = t.prefix.replace(/^\/+|\/+$/g, '')
  return `s3:${endpoint}/${t.bucket}${prefix ? `/${prefix}` : ''}`
}

/** Umgebung für jeden restic-Aufruf: Repository, Passwort, S3-Zugang, Cache */
export function resticEnv(t: ResolvedTarget, password: string): Record<string, string> {
  if (!password) throw new Error('Repository-Passwort fehlt')
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: repositoryUrl(t),
    RESTIC_PASSWORD: password,
    RESTIC_CACHE_DIR,
    // Kein Fortschrittsbalken mit Steuerzeichen im Log
    RESTIC_PROGRESS_FPS: '0.2',
  }
  if (t.kind === 's3') {
    if (!t.accessKeyId || !t.secretAccessKey) throw new Error('S3: Access-Key und Secret-Key fehlen')
    env.AWS_ACCESS_KEY_ID = t.accessKeyId
    env.AWS_SECRET_ACCESS_KEY = t.secretAccessKey
    if (t.region) env.AWS_DEFAULT_REGION = t.region
  }
  return env
}

/** Alle Werte, die nie in einer Meldung stehen dürfen */
export function targetSecrets(t: ResolvedTarget | null, password: string | null): string[] {
  const out = [password ?? '']
  if (t?.kind === 's3') out.push(t.accessKeyId, t.secretAccessKey)
  return out.filter((s) => s.length > 0)
}

/* --- Argumente -------------------------------------------------------------------- */

/** Tag für restic: kein Komma (Trenner), nur einfache Zeichen */
export const safeTag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export interface BackupArgsInput {
  version: string
  /** Slugs der Umgebungen (Tags env-<slug>) */
  environments: string[]
}

export function backupArgs(o: BackupArgsInput): string[] {
  const tags = [RESTIC_TAG, `${RESTIC_TAG}-${safeTag(o.version)}`, ...o.environments.map((e) => `env-${safeTag(e)}`)]
  const args = ['backup', '--json', '--host', RESTIC_HOST]
  for (const t of [...new Set(tags)].filter((t) => t && !t.endsWith('-'))) args.push('--tag', t)
  for (const e of backupExcludes()) args.push('--exclude', e)
  args.push(...BACKUP_PATHS)
  return args
}

/**
 * Aufbewahrung. Gruppiert nur nach Host: die Pfade ändern sich mit jedem
 * neuen Projekt-Volume, die Tags mit jeder Version – beides soll keine neue
 * Gruppe aufmachen, die die alten Stände für immer behält.
 */
export function forgetArgs(r: BackupRetention): string[] {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error(`Aufbewahrung ${k}: ${v} ist keine Zahl von 0 bis 1000`)
  }
  if (r.daily + r.weekly + r.monthly === 0) throw new Error('Aufbewahrung: mindestens ein Stand muss bleiben')
  const args = ['forget', '--json', '--host', RESTIC_HOST, '--tag', RESTIC_TAG, '--group-by', 'host']
  if (r.daily) args.push('--keep-daily', String(r.daily))
  if (r.weekly) args.push('--keep-weekly', String(r.weekly))
  if (r.monthly) args.push('--keep-monthly', String(r.monthly))
  args.push('--prune')
  return args
}

export const snapshotsArgs = (): string[] => ['snapshots', '--json', '--host', RESTIC_HOST, '--tag', RESTIC_TAG]
export const catConfigArgs = (): string[] => ['cat', 'config']
export const initArgs = (): string[] => ['init']
export const checkArgs = (): string[] => ['check']

/** pg_dump im Backup-Container: Verbindung über PGHOST/PGUSER/PGPASSWORD aus compose.yaml */
export const pgDumpArgs = (): string[] => ['pg_dump', '--format=custom', '--no-owner', `--file=${STAGING_DUMP_FILE}`]

/** Staging leeren und neu anlegen (Cache bleibt) */
export const prepareStagingCmd = (): string[] => [
  'sh', '-c', `rm -rf ${STAGING_DB_DIR} ${STAGING_VOLUMES_DIR} && mkdir -p ${STAGING_DB_DIR} ${STAGING_VOLUMES_DIR} ${RESTIC_CACHE_DIR}`,
]
export const cleanStagingCmd = (): string[] => ['sh', '-c', `rm -rf ${STAGING_DB_DIR} ${STAGING_VOLUMES_DIR}`]

/** Name eines Projekt-Volumes im Staging: nur einfache Zeichen (landet in einem Shell-Befehl) */
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'volume'

/** Ziel eines Projekt-Volumes im Staging: /staging/volumes/<slug>/<volume> */
export function stagingVolumeDir(slug: string, volume: string): string {
  return `${STAGING_VOLUMES_DIR}/${safeName(slug)}/${safeName(volume)}`
}

/**
 * Befehl im Wegwerf-Container, der ein Projekt-Volume (read-only unter
 * /from) ins Staging (/staging) kopiert. cp -a erhält Rechte und Besitzer.
 */
export function volumeCopyCmd(slug: string, volume: string): string[] {
  const dir = stagingVolumeDir(slug, volume)
  return ['sh', '-c', `rm -rf '${dir}' && mkdir -p '${dir}' && cp -a /from/. '${dir}/'`]
}

/** Laufende restic/pg_dump im Backup-Container beenden (Zeitlimit) */
export const killCmd = (): string[] => ['sh', '-c', 'pkill -TERM restic; pkill -TERM pg_dump; true']

/* --- Auswerten -------------------------------------------------------------------- */

export interface BackupSummary {
  snapshotId: string | null
  bytesNew: number | null
  bytesTotal: number | null
  filesNew: number | null
  durationMs: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Letzte «summary»-Zeile aus «restic backup --json»; null, wenn keine da ist */
export function parseBackupSummary(lines: string[]): BackupSummary | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim()
    if (!l.startsWith('{')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(l) as Record<string, unknown>
    } catch {
      continue
    }
    if (o.message_type !== 'summary') continue
    const dur = num(o.total_duration)
    return {
      snapshotId: typeof o.snapshot_id === 'string' ? o.snapshot_id : null,
      bytesNew: num(o.data_added),
      bytesTotal: num(o.total_bytes_processed),
      filesNew: num(o.files_new),
      durationMs: dur === null ? null : Math.round(dur * 1000),
    }
  }
  return null
}

export interface SnapshotInfo {
  id: string
  shortId: string
  time: string
  tags: string[]
  paths: string[]
  bytesTotal: number | null
}

/** «restic snapshots --json»; neueste zuerst. Unlesbares wirft. */
export function parseSnapshots(json: string): SnapshotInfo[] {
  const data = JSON.parse(json.trim() || '[]') as unknown
  if (!Array.isArray(data)) throw new Error('restic snapshots: keine Liste')
  const out: SnapshotInfo[] = []
  for (const s of data as Record<string, unknown>[]) {
    if (!s || typeof s.id !== 'string' || typeof s.time !== 'string') continue
    const summary = (s.summary ?? null) as Record<string, unknown> | null
    out.push({
      id: s.id,
      shortId: typeof s.short_id === 'string' ? s.short_id : s.id.slice(0, 8),
      time: new Date(s.time).toISOString(),
      tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
      paths: Array.isArray(s.paths) ? s.paths.filter((t): t is string => typeof t === 'string') : [],
      bytesTotal: num(summary?.total_bytes_processed),
    })
  }
  return out.sort((a, b) => b.time.localeCompare(a.time))
}

export type RepoProbe = 'ok' | 'missing' | 'wrong_password' | 'locked' | 'error'

/**
 * Ergebnis von «restic cat config». Ab restic 0.17: Exit 10 = kein
 * Repository, 11 = gesperrt, 12 = falsches Passwort. Der Text dient als
 * Rückfall (ältere Versionen, Backends mit eigenem Wortlaut).
 */
export function classifyRepoProbe(exitCode: number, stderr: string): RepoProbe {
  if (exitCode === 0) return 'ok'
  if (exitCode === 12 || /wrong password|no key found/i.test(stderr)) return 'wrong_password'
  if (exitCode === 10 || /repository does not exist|unable to open config file|Is there a repository at the following location|config file does not exist/i.test(stderr)) return 'missing'
  if (exitCode === 11 || /unable to create lock|repository is already locked/i.test(stderr)) return 'locked'
  return 'error'
}

/** Exit 3 von «restic backup»: Stand angelegt, aber einige Dateien unlesbar */
export const BACKUP_PARTIAL_EXIT = 3

/* --- Schwärzen -------------------------------------------------------------------- */

const MASK = '***'

/**
 * Zugangsdaten aus einer Meldung von restic oder dem S3-Backend entfernen:
 * die bekannten Werte selbst, Benutzer:Passwort in URLs und Zuweisungen der
 * üblichen Variablen. Reine Funktion; zusätzlich gilt überall redactSecrets.
 */
export function maskCredentials(text: string, secrets: string[]): string {
  let out = text
  for (const s of [...new Set(secrets)].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(MASK)
  }
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`)
  out = out.replace(/\b(RESTIC_PASSWORD|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|PGPASSWORD)=\S+/g, `$1=${MASK}`)
  out = out.replace(/(X-Amz-Credential=)[^&\s]+/gi, `$1${MASK}`).replace(/(X-Amz-Signature=)[^&\s]+/gi, `$1${MASK}`)
  return out
}

/** Kurze Fehlermeldung aus der Ausgabe von restic: die letzten sinnvollen Zeilen, geschwärzt */
export function errorTail(stderr: string[], secrets: string[], max = 6): string {
  const lines = stderr.map((l) => l.trim()).filter((l) => l && !l.startsWith('{"message_type":"status"'))
  return maskCredentials(lines.slice(-max).join('\n'), secrets).slice(0, 2000)
}
