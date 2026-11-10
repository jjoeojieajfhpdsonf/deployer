import type { FastifyInstance, FastifyRequest } from 'fastify'
import { publishPublicSchema, putInternalRoutesSchema } from '@deployer/shared'
import { findProject, toDto } from '../../domain/projects.js'
import { setRoutes, reconcileCaddy } from '../../domain/routes.js'
import { publicStatus, publishFlow, pauseFlow, resumeFlow, unpublishFlow } from '../../domain/public.js'
import { progressOf } from '../../domain/public-progress.js'
import { audit } from '../../domain/audit.js'
import { actorFor } from '../auth.js'
import { AppError } from '../../lib/errors.js'

interface IdParams { id: string }

/**
 * Karte «Veröffentlichung»: sofort wirksame Übergänge (veröffentlichen,
 * Access an/aus, pausieren, fortsetzen, ganz offline). Die Rückfrage stellt
 * die Oberfläche; mit einem API-Token gehen sie nur über MCP (dort mit
 * Bestätigung), wie schon PUT /routes mit "public".
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const sessionOnly = (request: FastifyRequest) => {
    if (request.tokenId) throw new AppError('forbidden', 'Die Veröffentlichung ändert sich mit einem Token nur über MCP (mit Bestätigung) oder mit einer Anmeldung', 403)
  }

  app.get<{ Params: IdParams }>('/projects/:id/public', async (request) => {
    const project = await findProject(request.params.id)
    return publicStatus(project)
  })

  /** Nur der Fortschritt – die Karte fragt ihn ab, solange ihr Aufruf läuft. */
  app.get<{ Params: IdParams }>('/projects/:id/public/progress', async (request) => {
    const project = await findProject(request.params.id)
    return { progress: progressOf(project.id) }
  })

  app.post<{ Params: IdParams }>('/projects/:id/public', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    const body = publishPublicSchema.parse(request.body ?? {})
    const r = await publishFlow(project, { subdomain: body.publicSubdomain, hostname: body.publicHostname, accessProtected: body.accessProtected }, actorFor(request))
    return { ...r, project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  app.post<{ Params: IdParams }>('/projects/:id/public/pause', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    const r = await pauseFlow(project, actorFor(request))
    return { ...r, project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  app.post<{ Params: IdParams }>('/projects/:id/public/resume', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    const r = await resumeFlow(project, actorFor(request))
    return { ...r, project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  /** Ganz offline: Tunnel-Regel und DNS-Eintrag weg, der Name ist frei. */
  app.delete<{ Params: IdParams }>('/projects/:id/public', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    const r = await unpublishFlow(project, actorFor(request))
    return { ...r, project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  /** Tailnet und LAN speichern, ohne die öffentliche Route anzufassen. */
  app.put<{ Params: IdParams }>('/projects/:id/routes/internal', async (request) => {
    const project = await findProject(request.params.id)
    const body = putInternalRoutesSchema.parse(request.body)
    try {
      await setRoutes(project.id, project.slug, body.targets, body.subdomain)
    } finally {
      await reconcileCaddy()
    }
    await audit({ actor: actorFor(request), action: 'project.routes.set', targetType: 'project', targetId: project.id, params: body, result: 'ok' })
    return { project: await toDto(await findProject(project.id)) }
  })
}
