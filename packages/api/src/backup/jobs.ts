/**
 * Meilenstein Backup: Aufträge an den Backup-Container – reine Logik, ohne
 * Dateisystem (das steht in backup/dispatch.ts), damit sie testbar bleibt.
 *
 * Airlock hat kein docker exec (Socket-Proxy EXEC=0). Es legt Aufträge in
 * das gemeinsame Auftrags-Volume (compose.yaml: backup_jobs, tmpfs); der
 * Ausführer im Backup-Container (backup/runner.sh) holt sie ab, führt sie aus
 * und schreibt Ausgabe und Ergebnis zurück. Das Format ist zeilenweise, damit
 * es ein POSIX-sh ohne jq lesen kann.
 *
 * Geheimnisse (Repository-Passwort, S3-Schlüssel) stehen nie im Auftrag,
 * sondern in einer eigenen Datei <id>.env mit Rechten 0600, die der Ausführer
 * beim Abholen liest und sofort löscht. Das Volume ist ein tmpfs: die Datei
 * erreicht keine Platte und lebt höchstens bis zum Abholen (≤ 1 s).
 */

/** Feste Vorgänge; der Ausführer kennt keine anderen (kein beliebiger Befehl) */
export type JobOp = 'restic' | 'pg-dump' | 'staging-prepare' | 'staging-clean'

export interface JobSpec {
  op: JobOp
  args?: string[]
  /** Nur Variablen aus JOB_ENV_KEYS; alles Geheime gehört hierher */
  env?: Record<string, string>
  timeoutMs: number
}

/** Ergebnis eines Auftrags: wie früher bei exec die letzten Zeilen getrennt nach Strom */
export interface JobResult {
  exitCode: number
  timedOut: boolean
  stdout: string[]
  stderr: string[]
}

/** Variablen, die ein Auftrag setzen darf (dieselbe Liste steht in backup/runner.sh) */
export const JOB_ENV_KEYS = [
  'RESTIC_REPOSITORY', 'RESTIC_PASSWORD', 'RESTIC_CACHE_DIR', 'RESTIC_PROGRESS_FPS',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION',
] as const

/** Bis der Ausführer einen Auftrag abgeholt haben muss (er schaut jede Sekunde) */
export const PICKUP_MS = 30_000
/** Ohne Lebenszeichen (mtime von <id>.run) so lange: Ausführer gilt als weg */
export const STALL_MS = 90_000
/** Nach dem Zeitlimit: so lange auf das Ergebnis des Ausführers warten (er bricht selbst ab) */
export const GRACE_MS = 60_000

const ID_RE = /^[a-z0-9-]{8,64}$/

/** Kennung eines Auftrags: zeitlich sortierbar, nur a-z, 0-9 und - */
export function newJobId(now: number, randomHex: string): string {
  const id = `${Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')}-${randomHex.toLowerCase().replace(/[^0-9a-f]/g, '')}`
  if (!ID_RE.test(id)) throw new Error(`Ungültige Auftrags-Kennung: ${id}`)
  return id
}

export const isJobId = (s: string): boolean => ID_RE.test(s)

/** Dateinamen eines Auftrags im Auftrags-Verzeichnis */
export function jobFiles(id: string) {
  if (!isJobId(id)) throw new Error(`Ungültige Auftrags-Kennung: ${id}`)
  return {
    env: `${id}.env`,
    job: `${id}.job`,
    jobTmp: `${id}.job.tmp`,
    run: `${id}.run`,
    out: `${id}.out`,
    err: `${id}.err`,
    cancel: `${id}.cancel`,
    result: `${id}.result`,
  }
}

/** Eine Zeile darf keinen Zeilenumbruch und kein NUL enthalten – sonst wäre sie zwei Angaben */
const oneLine = (s: string): boolean => !/[\r\n\0]/.test(s)

/** Inhalt von <id>.job */
export function formatJob(spec: JobSpec): string {
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error('Auftrag: Zeitlimit fehlt')
  const lines = ['v 1', `op ${spec.op}`, `timeout ${Math.ceil(spec.timeoutMs / 1000)}`]
  for (const a of spec.args ?? []) {
    if (!oneLine(a)) throw new Error('Auftrag: ein Argument enthält einen Zeilenumbruch')
    lines.push(`arg ${a}`)
  }
  return `${lines.join('\n')}\n`
}

/** Inhalt von <id>.env (Rechte 0600); leer, wenn es nichts zu setzen gibt */
export function formatEnvFile(env: Record<string, string>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!(JOB_ENV_KEYS as readonly string[]).includes(k)) throw new Error(`Auftrag: Variable ${k} ist nicht erlaubt`)
    if (!oneLine(v)) throw new Error(`Auftrag: ${k} enthält einen Zeilenumbruch`)
    lines.push(`${k}=${v}`)
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

export interface ParsedResult {
  exitCode: number
  timedOut: boolean
  cancelled: boolean
}

/** <id>.result lesen; null, wenn unvollständig oder unlesbar */
export function parseResult(text: string): ParsedResult | null {
  const v: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^(exit|timedout|cancelled) (-?\d+)$/.exec(line.trim())
    if (m) v[m[1]!] = m[2]!
  }
  if (v.exit === undefined) return null
  return { exitCode: Number(v.exit), timedOut: v.timedout === '1', cancelled: v.cancelled === '1' }
}

/** Die letzten max Zeilen einer Ausgabe (ohne die leere nach dem letzten Umbruch) */
export function lastLines(text: string, max = 400): string[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-max)
}

export type WaitVerdict =
  /** Ergebnis liegt vor */
  | 'done'
  /** weiter warten */
  | 'wait'
  /** nach PICKUP_MS noch nicht abgeholt: Ausführer läuft nicht */
  | 'not_picked_up'
  /** abgeholt, aber seit STALL_MS kein Lebenszeichen: Container neu gestartet o. ä. */
  | 'stalled'
  /** Zeitlimit plus Nachfrist vorbei, ohne Ergebnis */
  | 'overdue'

export interface WaitState {
  /** seit dem Anlegen des Auftrags */
  elapsedMs: number
  timeoutMs: number
  hasResult: boolean
  /** <id>.job liegt noch da (nicht abgeholt) */
  pending: boolean
  /** seit der letzten Änderung des Lebenszeichens, gemessen mit Airlocks Uhr; null = noch keins gesehen */
  sinceHeartbeatMs: number | null
}

/**
 * Was beim Warten auf einen Auftrag zu tun ist. Das Lebenszeichen wird nicht
 * gegen die Uhr des Containers verglichen, sondern nur, ob es sich ändert –
 * so stört keine Abweichung zwischen den Uhren.
 */
export function waitVerdict(s: WaitState, l: WaitLimits = WAIT_LIMITS): WaitVerdict {
  if (s.hasResult) return 'done'
  if (s.pending) return s.elapsedMs >= l.pickupMs ? 'not_picked_up' : 'wait'
  if (s.elapsedMs >= s.timeoutMs + l.graceMs) return 'overdue'
  if (s.sinceHeartbeatMs !== null && s.sinceHeartbeatMs >= l.stallMs) return 'stalled'
  return 'wait'
}

export interface WaitLimits {
  pickupMs: number
  stallMs: number
  graceMs: number
}

export const WAIT_LIMITS: WaitLimits = { pickupMs: PICKUP_MS, stallMs: STALL_MS, graceMs: GRACE_MS }
