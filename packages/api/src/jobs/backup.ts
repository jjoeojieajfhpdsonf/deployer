import { log } from '../lib/log.js'
import { audit } from '../domain/audit.js'
import { notify } from '../notify/send.js'
import { isDue, shouldNotifyStale } from '../backup/rules.js'
import { resolveSettings, loadState, patchState } from '../backup/settings.js'
import { lastBackupSuccess } from '../backup/service.js'
import { startBackup, backupRunning, staleContext } from '../backup/run.js'

/**
 * Meilenstein Backup, Etappe 2: nächtlicher Lauf (Standard 03:30 Ortszeit,
 * einstellbar) und Meldung «über 48 h ohne Erfolg» (höchstens einmal pro
 * Tag). Ein Takt pro Minute prüft, was fällig ist; die Regeln stehen rein in
 * backup/rules.ts.
 */

const TICK_MS = 60_000
/** Erster Takt kurz nach dem Start: ein verpasster Termin wird nachgeholt, aber nicht mitten im Hochfahren */
const FIRST_TICK_MS = 2 * 60_000

export async function runBackupJob(now = new Date()): Promise<{ started: boolean; staleNotified: boolean }> {
  const s = await resolveSettings()
  const st = await loadState()
  let started = false

  if (!backupRunning() && isDue({
    now, enabled: s.enabled, configured: s.configured, time: s.time, timeZone: s.timeZone,
    lastScheduledAt: st.lastScheduledAt ? new Date(st.lastScheduledAt) : null, configuredAt: s.activeSince,
  })) {
    // Vor dem Start vermerken: ein scheiternder Lauf versucht es nicht jede Minute neu
    await patchState({ lastScheduledAt: now.toISOString() })
    try {
      const { done } = await startBackup('schedule', 'system')
      started = true
      await done.catch(() => {})
    } catch (err) {
      // z.B. ein von Hand gestarteter Lauf hält gerade die Sperre
      log.warn('Geplantes Backup nicht gestartet', { err: String(err) })
    }
  }

  let staleNotified = false
  const lastSuccessAt = await lastBackupSuccess()
  const st2 = await loadState()
  if (!backupRunning() && shouldNotifyStale({
    now, enabled: s.enabled, configured: s.configured, lastSuccessAt, configuredAt: s.activeSince,
    lastStaleNotifiedAt: st2.lastStaleNotifiedAt ? new Date(st2.lastStaleNotifiedAt) : null,
  })) {
    const c = await staleContext()
    await patchState({ lastStaleNotifiedAt: now.toISOString() })
    // In der Glocke als gescheitertes Server-Ereignis (Akteur «system»)
    await audit({
      actor: 'system', action: 'backup.stale', environmentId: null, params: { lastSuccess: c.lastSuccess }, result: 'error',
      error: c.lastSuccess ? `Seit über 48 Stunden kein erfolgreiches Backup (letztes: ${c.lastSuccess})` : 'Seit über 48 Stunden kein erfolgreiches Backup',
    })
    await notify('backup_stale', { lastSuccess: c.lastSuccess, lastError: c.lastError })
    staleNotified = true
  }
  return { started, staleNotified }
}

export function startBackupJob(): NodeJS.Timeout {
  let busy = false
  const tick = () => {
    // Ein Lauf dauert länger als ein Takt: nicht stapeln
    if (busy) return
    busy = true
    runBackupJob()
      .catch((err) => log.error('Backup-Job fehlgeschlagen', { err: String(err) }))
      .finally(() => (busy = false))
  }
  setTimeout(tick, FIRST_TICK_MS).unref()
  const timer = setInterval(tick, TICK_MS)
  timer.unref()
  return timer
}
