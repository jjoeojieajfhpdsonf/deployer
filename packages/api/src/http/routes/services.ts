import type { FastifyInstance, FastifyRequest } from 'fastify'
import { applyServiceChangeSchema, serviceChangeSchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import { applyServiceChange, planServiceChange, type ServiceDeps } from '../../domain/services.js'
import { dismissChange, serviceDeps } from '../../domain/services-real.js'
import { AppError } from '../../lib/errors.js'
import { actorFor } from '../auth.js'

interface IdParams {
  id: string
}

type Project = Awaited<ReturnType<typeof findProject>>

/** Austauschbar für Tests (ohne Datenbank, Docker, GitHub) */
export interface ServiceRouteDeps {
  findProject: (request: FastifyRequest, id: string) => Promise<Project>
  deps: (p: Project, actor: string) => ServiceDeps
  dismiss: (p: Project, id: string, actor: string) => Promise<void>
  actor: (request: FastifyRequest) => string
}

const realDeps: ServiceRouteDeps = {
  findProject: (request, id) => findProject(request.scope, id),
  deps: serviceDeps,
  dismiss: dismissChange,
  actor: actorFor,
}

/**
 * Etappe 4 «Dienst hinzufügen/entfernen» (Reiter «Aufbau»).
 *
 * POST   /projects/:id/services/plan       Vorschau: Diff, Variablen (Namen), Hinweise; ändert nichts
 * POST   /projects/:id/services            Übernehmen { change, base }: Variablen anlegen, dann
 *                                          Deploy bzw. Pull Request (Git-Projekte)
 * DELETE /projects/:id/service-changes/:c  Gescheiterte/geschlossene Änderung ausblenden
 *
 * Volume löschen (Entfernen mit dropVolume) nur mit Anmeldung, nie mit einem
 * API-Token – es gäbe keine Rückfrage, und die Daten sind danach weg.
 */
export async function serviceRoutes(app: FastifyInstance, opts: { deps?: Partial<ServiceRouteDeps> } = {}): Promise<void> {
  const d: ServiceRouteDeps = { ...realDeps, ...opts.deps }

  app.post<{ Params: IdParams }>('/projects/:id/services/plan', async (request) => {
    const project = await d.findProject(request, request.params.id)
    const change = serviceChangeSchema.parse(request.body)
    return { plan: await planServiceChange(change, d.deps(project, d.actor(request))) }
  })

  app.post<{ Params: IdParams }>('/projects/:id/services', async (request) => {
    const project = await d.findProject(request, request.params.id)
    const { change, base } = applyServiceChangeSchema.parse(request.body)
    if (change.action === 'remove' && change.dropVolume && request.tokenId) {
      throw new AppError('forbidden', 'Ein Volume löschen geht nur mit einer Anmeldung, nicht mit einem Token', 403)
    }
    const actor = d.actor(request)
    return { change: await applyServiceChange(change, base, actor, d.deps(project, actor)) }
  })

  app.delete<{ Params: IdParams & { change: string } }>('/projects/:id/service-changes/:change', async (request, reply) => {
    const project = await d.findProject(request, request.params.id)
    await d.dismiss(project, request.params.change, d.actor(request))
    reply.code(204)
  })
}
