import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  backupSettingsInputSchema, backupKeyFileInputSchema, backupKeyPaperInputSchema, backupKeyConfirmSchema, backupKeyVerifySchema,
  backupRestorePreviewSchema, backupRestoreInputSchema,
} from '@airlock/shared'
import { previewRestore, startRestore } from '../../backup/restore.js'
import { confirmKeySaved, exportKeyFile, exportKeyPaper, verifyKeyFile } from '../../backup/key-service.js'
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

  /*
   * Etappe 4: secrets.key getrennt sichern. Beide Exporte verlangen das
   * Anmelde-Passwort noch einmal (frische Anmeldung) und werden nie
   * zwischengespeichert (no-store). Die Antworten enthalten den Schlüssel nur
   * verschlüsselt (Datei) bzw. für die Druckansicht (Papier).
   */
  app.post('/system/backup/key/file', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exportKeyFile(backupKeyFileInputSchema.parse(request.body ?? {}), request.ip, actorFor(request))
  })
  app.post('/system/backup/key/paper', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exportKeyPaper(backupKeyPaperInputSchema.parse(request.body ?? {}), request.ip, actorFor(request))
  })
  /** «Getrennt abgelegt» – setzt den Merker «Schlüssel gesichert am …» */
  app.post('/system/backup/key/confirm', async (request) => ({ key: await confirmKeySaved(backupKeyConfirmSchema.parse(request.body ?? {}).method, actorFor(request)) }))
  /*
   * Etappe 5: ein Projekt aus einem Stand zurückholen. Vorschau (was der Stand
   * vom Projekt enthält, welche Container angehalten werden) und Start; der
   * Start verlangt den eingetippten Slug (zerstörerisch). Kein MCP, kein Token.
   */
  app.get('/system/backup/restore/preview', async (request) => {
    const q = backupRestorePreviewSchema.parse(request.query ?? {})
    return previewRestore(q.snapshot, q.project)
  })
  app.post('/system/backup/restore', async (request, reply) => {
    const { restore } = await startRestore(backupRestoreInputSchema.parse(request.body ?? {}), actorFor(request))
    reply.code(202)
    return { restore }
  })

  /** Exportierte Datei prüfen: passt sie zum Schlüssel dieses Servers? (gibt den Schlüssel nie zurück) */
  app.post('/system/backup/key/verify', async (request) => verifyKeyFile(backupKeyVerifySchema.parse(request.body ?? {}), actorFor(request)))
}
