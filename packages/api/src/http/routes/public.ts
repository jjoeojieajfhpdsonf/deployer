import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { publishPublicSchema, putInternalRoutesSchema, pauseOptionsSchema, pausePageSchema, DEFAULT_PAUSE_PAGE } from '@airlock/shared'
import { setProjectPause, pausePageTemplate, setPausePageTemplate } from '../../domain/pause-page.js'
import { findProject, toDto } from '../../domain/projects.js'
import { setRoutes, reconcileCaddy } from '../../domain/routes.js'
import { publicStatus, publishFlow, pauseFlow, resumeFlow, unpublishFlow, applyApprovedRequest } from '../../domain/public.js'
import { approvePublicRequest, discardPublicRequest } from '../../domain/public-requests.js'
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
    // Optional: eigene Pause-Seite (null = Vorlage) und «Voraussichtlich zurück»
    const opts = request.body ? pauseOptionsSchema.parse(request.body) : undefined
    const r = await pauseFlow(project, actorFor(request), opts)
    return { ...r, project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  /** Pause-Seite des Projekts ändern, auch während der Pause (wirkt sofort). */
  app.put<{ Params: IdParams }>('/projects/:id/public/pause-page', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    const opts = pauseOptionsSchema.parse(request.body ?? {})
    if (await setProjectPause(project.id, opts, actorFor(request))) await reconcileCaddy()
    return { status: await publicStatus(project) }
  })

  /** Globale Vorlage der Pause-Seite (System → Veröffentlichung). */
  app.get('/settings/pause-page', async () => ({ page: await pausePageTemplate(), defaults: DEFAULT_PAUSE_PAGE }))

  app.put('/settings/pause-page', async (request) => {
    sessionOnly(request)
    const body = z.object({ page: pausePageSchema.nullable() }).parse(request.body)
    const page = await setPausePageTemplate(body.page, actorFor(request))
    // Pausierte Projekte ohne eigene Seite zeigen die neue Vorlage sofort
    await reconcileCaddy()
    return { page, defaults: DEFAULT_PAUSE_PAGE }
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

  /**
   * Vorgemerkte Anfrage bestätigen: «Nach dem Scan öffentlich schalten».
   * Ist der Scan schon bestanden, geht die Karte direkt über POST /public.
   */
  app.post<{ Params: IdParams }>('/projects/:id/public/request/approve', async (request) => {
    sessionOnly(request)
    const project = await findProject(request.params.id)
    await approvePublicRequest(project.id, actorFor(request))
    // Falls der Scan inzwischen bestanden ist: gleich ausführen
    await applyApprovedRequest(project.id)
    return { project: await toDto(await findProject(project.id)), status: await publicStatus(project) }
  })

  app.delete<{ Params: IdParams }>('/projects/:id/public/request', async (request) => {
    const project = await findProject(request.params.id)
    await discardPublicRequest(project.id, actorFor(request))
    return { status: await publicStatus(project) }
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
