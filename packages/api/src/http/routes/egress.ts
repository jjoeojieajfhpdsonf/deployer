import type { FastifyInstance } from 'fastify'
import { egressEnforceAllSchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import {
  addEgressException, egressServerDto, enforceAll, projectEgressDto, removeEgressException, setEgressSettings,
} from '../../egress/service.js'
import { actorFor, requireSudo } from '../auth.js'

/**
 * Nacht 3, Etappe 4: Projekt › Einstellungen › «Ausgehende Verbindungen» und
 * die Übersicht unter Server. Ändern nur mit Anmeldung (http/auth.ts: für
 * API-Tokens gesperrt – ein gestohlenes Token könnte sonst ein Projekt ins
 * Heimnetz öffnen); Lesen auch mit Token (nur das eigene Projekt).
 * «Frei» verlangt die erneute Bestätigung (sudo).
 */
export async function egressRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/projects/:id/egress', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { egress: await projectEgressDto(p) }
  })

  app.put<{ Params: { id: string } }>('/projects/:id/egress', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { egress: await setEgressSettings(p, request.body, actorFor(request), () => requireSudo(request)) }
  })

  app.post<{ Params: { id: string } }>('/projects/:id/egress/exceptions', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { egress: await addEgressException(p, request.body, actorFor(request)) }
  })

  app.delete<{ Params: { id: string; exceptionId: string } }>('/projects/:id/egress/exceptions/:exceptionId', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { egress: await removeEgressException(p, request.params.exceptionId, actorFor(request)) }
  })

  app.get('/system/egress', async () => ({ egress: await egressServerDto() }))

  app.post('/system/egress/enforce-all', async (request) => {
    egressEnforceAllSchema.parse(request.body ?? {})
    const changed = await enforceAll(actorFor(request))
    return { changed, egress: await egressServerDto() }
  })
}
