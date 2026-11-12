import type { FastifyInstance } from 'fastify'
import { deleteVolumeSchema } from '@airlock/shared'
import { actorFor } from '../auth.js'
import {
  deleteOrphanVolume, getStorageSettings, putStorageSettings, runStorageCleanup, storageOverview,
} from '../../storage/service.js'

/**
 * Nacht 3, Etappe 3: Server › Speicher. Nur mit Anmeldung (http/auth.ts):
 * die Liste nennt Volumes und Projekte aller Umgebungen. MCP liest über
 * get_disk_usage nur Summen. Ein verwaistes Volume löschen verlangt die
 * erneute Bestätigung (SUDO_ROUTES) und den eingetippten Namen.
 */
export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system/storage', async (request) => {
    const q = request.query as { refresh?: string }
    return { storage: await storageOverview({ refresh: q.refresh === '1' }) }
  })

  app.post('/system/storage/cleanup', async (request) => {
    const r = await runStorageCleanup(actorFor(request), 'manual')
    return { result: { run: r.run, errors: r.errors }, storage: await storageOverview({ refresh: true }) }
  })

  app.get('/system/storage/settings', async () => ({ settings: await getStorageSettings() }))
  app.put('/system/storage/settings', async (request) => {
    const settings = await putStorageSettings(request.body, actorFor(request))
    return { settings, storage: await storageOverview({ refresh: true }) }
  })

  app.delete('/system/storage/volumes/:name', async (request) => {
    const { name } = request.params as { name: string }
    const { confirm } = deleteVolumeSchema.parse(request.body ?? {})
    await deleteOrphanVolume(name, confirm, actorFor(request))
    return { storage: await storageOverview({ refresh: true }) }
  })
}
