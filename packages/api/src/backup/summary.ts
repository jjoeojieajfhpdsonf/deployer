import type { BackupStatusDto } from '@airlock/shared'

/**
 * Meilenstein Backup, Etappe 3: Antwort des MCP-Werkzeugs get_backup_status.
 * Nur lesen, nur das Nötigste: letzter Lauf, Alter des letzten Erfolgs,
 * Art des Ziels. Kein Pfad, kein Endpoint, kein Bucket, keine Zugangsdaten –
 * ein Token einer Umgebung soll über die Sicherung des ganzen Servers nicht
 * mehr erfahren, als dass sie läuft. Reine Funktion (Test in summary.test.ts).
 */
export interface McpBackupStatus {
  configured: boolean
  enabled: boolean
  running: boolean
  target_kind: 'local' | 's3' | null
  last_run: {
    status: string
    trigger: 'schedule' | 'manual'
    started_at: string
    finished_at: string | null
    duration_s: number | null
    error: string | null
    warnings: number
  } | null
  last_success_at: string | null
  /** Stunden seit dem letzten Erfolg, eine Nachkommastelle */
  age_hours: number | null
  /** Über 48 h ohne Erfolg */
  stale: boolean
  next_run_at: string | null
}

export function mcpBackupStatus(s: BackupStatusDto, now = new Date()): McpBackupStatus {
  const r = s.lastRun
  const age = s.lastSuccessAt ? Math.max(0, now.getTime() - Date.parse(s.lastSuccessAt)) : null
  return {
    configured: s.settings.configured,
    enabled: s.settings.enabled,
    running: s.running,
    target_kind: s.settings.target?.kind ?? null,
    last_run: r
      ? {
          status: r.status,
          trigger: r.trigger,
          started_at: r.startedAt,
          finished_at: r.finishedAt,
          duration_s: r.durationMs === null ? null : Math.round(r.durationMs / 1000),
          error: r.error,
          warnings: r.warnings.length,
        }
      : null,
    last_success_at: s.lastSuccessAt,
    age_hours: age === null ? null : Math.round(age / 360_000) / 10,
    stale: s.stale,
    next_run_at: s.nextRunAt,
  }
}
