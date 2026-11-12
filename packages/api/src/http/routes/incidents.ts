import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { incidentListQuerySchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import {
  getIncident, isolateProject, listIncidents, markNormal, projectIntrusionDto, releaseIsolation, removeNormal, setIntrusionSettings, updateIncident,
} from '../../intrusion/store.js'
import { actorFor } from '../auth.js'
import { listScopeFor } from '../scope.js'

/**
 * Nacht 3, Etappe 5: Security › Vorfälle und Projekt › Security.
 * Nur mit Anmeldung (http/auth.ts: für API-Tokens gesperrt – Vorfälle nennen
 * Adressen, Pfade und Befehlszeilen; MCP liest über list_incidents).
 * Isolieren und Freigeben verlangen die erneute Bestätigung (SUDO_ROUTES).
 */
const normalEntrySchema = z.object({ kind: z.enum(['prozess', 'datei', 'netz']), service: z.string().max(200).nullable(), value: z.string().min(1).max(500) })

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  const list = async (request: FastifyRequest) => listIncidents(listScopeFor(request), incidentListQuerySchema.parse(request.query ?? {}))
  // «/incidents» gehört schon der Statusseite (Störungen) – hier darum /intrusion/incidents
  app.get('/intrusion/incidents', list)
  app.get('/environments/:env/intrusion/incidents', list)

  app.get<{ Params: { id: string } }>('/intrusion/incidents/:id', async (request) => ({ incident: await getIncident(request.scope, request.params.id) }))

  app.patch<{ Params: { id: string } }>('/intrusion/incidents/:id', async (request) => ({
    incident: await updateIncident(request.scope, request.params.id, request.body, actorFor(request)),
  }))

  app.post<{ Params: { id: string } }>('/intrusion/incidents/:id/normal', async (request) => ({
    incident: await markNormal(request.scope, request.params.id, actorFor(request)),
  }))

  app.get<{ Params: { id: string } }>('/projects/:id/intrusion', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { intrusion: await projectIntrusionDto(p) }
  })

  app.put<{ Params: { id: string } }>('/projects/:id/intrusion', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { intrusion: await setIntrusionSettings(p, request.body, actorFor(request)) }
  })

  app.post<{ Params: { id: string } }>('/projects/:id/intrusion/normal/remove', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { intrusion: await removeNormal(p, normalEntrySchema.parse(request.body ?? {}), actorFor(request)) }
  })

  app.post<{ Params: { id: string } }>('/projects/:id/isolation', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { intrusion: await isolateProject(p, actorFor(request)) }
  })

  app.delete<{ Params: { id: string } }>('/projects/:id/isolation', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    const r = await releaseIsolation(p, actorFor(request))
    return { ...r, intrusion: await projectIntrusionDto(await findProject(request.scope, p.id)) }
  })
}
