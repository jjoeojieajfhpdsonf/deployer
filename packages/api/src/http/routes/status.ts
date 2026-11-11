import type { FastifyInstance, FastifyRequest } from 'fastify'
import { incidentCreateSchema, incidentUpdateSchema, statusSettingsSchema } from '@airlock/shared'
import { addIncidentUpdate, createIncident, deleteIncident, listIncidents, setStatusSettings, statusPageDto } from '../../status/service.js'
import { actorFor } from '../auth.js'
import { listScopeFor } from '../scope.js'

/**
 * Etappe 5 «Statusseite» (je Umgebung).
 *
 * GET    /environments/:env/status-page          Einstellungen, Adresse, Projekte
 * PUT    /environments/:env/status-page          { enabled?, title? } – ein/aus, Titel
 * GET    /environments/:env/incidents            Störungen (neueste zuerst, mit Verlauf)
 * POST   /environments/:env/incidents            Störung melden { title, body, state, projectIds }
 * POST   /environments/:env/incidents/:incident/updates   Update { state, body }
 * DELETE /environments/:env/incidents/:incident  Störung löschen (Fehleintrag)
 *
 * Ändern nur mit Anmeldung: Schreibende Pfade unter /environments/:env sind
 * für API-Tokens gesperrt (http/auth.ts). Die Umgebung prüft der Scope-Guard,
 * die Störung muss zusätzlich zu ihr gehören (sonst 404).
 */

export interface StatusRouteDeps {
  envOf: (request: FastifyRequest) => string
  page: typeof statusPageDto
  setSettings: typeof setStatusSettings
  incidents: typeof listIncidents
  create: typeof createIncident
  update: typeof addIncidentUpdate
  remove: typeof deleteIncident
}

const realDeps: StatusRouteDeps = {
  envOf: (request) => listScopeFor(request).envId,
  page: statusPageDto,
  setSettings: setStatusSettings,
  incidents: listIncidents,
  create: createIncident,
  update: addIncidentUpdate,
  remove: deleteIncident,
}

type EnvParams = { env: string }
type IncidentParams = EnvParams & { incident: string }

export async function statusRoutes(app: FastifyInstance, opts: { deps?: Partial<StatusRouteDeps> } = {}): Promise<void> {
  const d: StatusRouteDeps = { ...realDeps, ...opts.deps }

  app.get<{ Params: EnvParams }>('/environments/:env/status-page', async (request) => ({ statusPage: await d.page(d.envOf(request)) }))
  app.put<{ Params: EnvParams }>('/environments/:env/status-page', async (request) => {
    const input = statusSettingsSchema.parse(request.body ?? {})
    return { statusPage: await d.setSettings(d.envOf(request), input, actorFor(request)) }
  })

  app.get<{ Params: EnvParams }>('/environments/:env/incidents', async (request) => ({ incidents: await d.incidents(d.envOf(request)) }))
  app.post<{ Params: EnvParams }>('/environments/:env/incidents', async (request, reply) => {
    const input = incidentCreateSchema.parse(request.body ?? {})
    reply.code(201)
    return { incidents: await d.create(d.envOf(request), input, actorFor(request)) }
  })
  app.post<{ Params: IncidentParams }>('/environments/:env/incidents/:incident/updates', async (request) => {
    const input = incidentUpdateSchema.parse(request.body ?? {})
    return { incidents: await d.update(d.envOf(request), request.params.incident, input, actorFor(request)) }
  })
  app.delete<{ Params: IncidentParams }>('/environments/:env/incidents/:incident', async (request) => ({
    incidents: await d.remove(d.envOf(request), request.params.incident, actorFor(request)),
  }))
}
