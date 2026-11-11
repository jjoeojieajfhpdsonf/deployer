import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { backupSettingsInputSchema } from '@airlock/shared'
import { actorFor } from '../auth.js'
import { getBackupSettings, putBackupSettings } from '../../backup/settings.js'
import { listRuns, listSnapshots, testConnection } from '../../backup/service.js'
import { backupStatus, startBackup } from '../../backup/run.js'

/**
 * Meilenstein Backup: serverweite Sicherung. Nur mit Anmeldung, nie mit
 * einem API-Token (http/auth.ts) – ein Token könnte sonst das Ziel auf einen
 * fremden Speicher umstellen. Keine Antwort enthält Passwort oder
 * Zugangsdaten, nur ob sie gesetzt sind.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  /** Status: Einstellungen, letzte Läufe, «48 h ohne Erfolg», nächster Termin */
  app.get('/system/backup', async () => backupStatus())

  app.get('/system/backup/settings', async () => getBackupSettings())
  app.put('/system/backup/settings', async (request) => putBackupSettings(backupSettingsInputSchema.parse(request.body ?? {}), actorFor(request)))

  /** «Verbindung testen»: restic cat config, beim ersten Mal init */
  app.post('/system/backup/test', async (request) => testConnection(actorFor(request)))

  /** «Jetzt sichern»: startet im Hintergrund, 202 mit dem angelegten Lauf (409, wenn schon einer läuft) */
  app.post('/system/backup/run', async (request, reply) => {
    const { run } = await startBackup('manual', actorFor(request))
    reply.code(202)
    return { run }
  })

  app.get('/system/backup/runs', async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(request.query ?? {})
    return { runs: await listRuns(limit) }
  })

  /** Stände im Repository (fragt das Ziel live ab) */
  app.get('/system/backup/snapshots', async () => ({ snapshots: await listSnapshots() }))
}
