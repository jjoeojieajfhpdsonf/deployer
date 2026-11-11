import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { backupSettingsInputSchema } from '@airlock/shared'
import { actorFor } from '../auth.js'
import { getBackupSettings, putBackupSettings } from '../../backup/settings.js'
import { listRuns, listSnapshots, testConnection } from '../../backup/service.js'

/**
 * Meilenstein Backup: serverweite Sicherung. Nur mit Anmeldung, nie mit
 * einem API-Token (http/auth.ts) – ein Token könnte sonst das Ziel auf einen
 * fremden Speicher umstellen. Keine Antwort enthält Passwort oder
 * Zugangsdaten, nur ob sie gesetzt sind.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system/backup/settings', async () => getBackupSettings())
  app.put('/system/backup/settings', async (request) => putBackupSettings(backupSettingsInputSchema.parse(request.body ?? {}), actorFor(request)))

  /** «Verbindung testen»: restic cat config, beim ersten Mal init */
  app.post('/system/backup/test', async (request) => testConnection(actorFor(request)))

  app.get('/system/backup/runs', async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(request.query ?? {})
    return { runs: await listRuns(limit) }
  })

  /** Stände im Repository (fragt das Ziel live ab) */
  app.get('/system/backup/snapshots', async () => ({ snapshots: await listSnapshots() }))
}
