import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ACCESS_GUARDS, externalSourceSchema, type AccessGuard, type ExternalProbeDto } from '@airlock/shared'
import { db, schema } from '../../db/index.js'
import { findProject, toDto } from '../../domain/projects.js'
import { externalContainers, probeExternal } from '../../domain/external.js'
import { accessGuardOf, assertPublicGuarded } from '../../domain/guard.js'
import { publishFlow, publicRoute } from '../../domain/public.js'
import { reconcileCaddy, routeDtosFor } from '../../domain/routes.js'
import { audit } from '../../domain/audit.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { CloudflareError } from '../../drivers/cloudflare.js'
import { actorFor, auth } from '../auth.js'

type IdParams = { id: string }

/** Schwäche des Schutzes: offen < Airlock-Login = Cloudflare Access (beide schützen) */
const strength = (g: AccessGuard) => (g === 'offen' ? 0 : 1)

/**
 * Bestehender Dienst und Zugang.
 *
 * GET  /external/containers         laufende fremde Container zur Auswahl (nur lesen)
 * POST /external/probe              Erreichbarkeit vor dem Anlegen (Container oder Adresse)
 * PUT  /projects/:id/access         Zugang: offen | login | cloudflare – schwächer machen nur mit
 *                                   Anmeldung und erneuter Bestätigung (sudo)
 * POST /projects/:id/admin-override Admin-Oberfläche trotzdem ohne Schutz öffentlich (SUDO_ROUTES)
 */
export async function externalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/external/containers', async () => ({ containers: await externalContainers() }))

  app.post('/external/probe', async (request): Promise<{ probe: ExternalProbeDto }> => {
    const body = externalSourceSchema.omit({ resolved: true }).parse({ type: 'external', ...(request.body as object ?? {}) })
    return { probe: await probeExternal({ ...body, resolved: undefined }) }
  })

  app.put<{ Params: IdParams }>('/projects/:id/access', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const { guard } = z.object({ guard: z.enum(ACCESS_GUARDS) }).parse(request.body)
    const routes = await routeDtosFor(project.id, project.slug)
    const before = accessGuardOf(project.loginGuard, routes)
    if (guard === before) return { project: await toDto(project) }
    // Schwächer machen: nie mit einem Token, mit Anmeldung nur nach erneuter Bestätigung
    if (strength(guard) < strength(before)) {
      if (request.tokenId || !request.authSession) throw new AppError('forbidden', 'Den Schutz abschalten geht nur mit einer Anmeldung', 403)
      auth().requireSudo(request.authSession)
    }
    const pub = await publicRoute(project.id)
    if (guard === 'cloudflare' && !pub) throw badRequest('Cloudflare Access gibt es nur für öffentliche Adressen. Intern schützt «Airlock-Login».')
    // Öffentliche Admin-Oberfläche ohne Schutz: dieselbe Pflicht wie beim Veröffentlichen
    if (pub && !pub.pausedAt) assertPublicGuarded(project, { accessProtected: guard === 'cloudflare', loginGuard: guard === 'login' })

    // Cloudflare Access an der öffentlichen Route an bzw. aus (Airlock legt die Access-Anwendung an)
    const wantAccess = guard === 'cloudflare'
    if (pub && pub.accessProtected !== wantAccess) {
      try {
        await publishFlow(project, { accessProtected: wantAccess }, actorFor(request))
      } catch (err) {
        if (err instanceof AppError && err.code === 'cloudflare' && /access|permission|forbidden|authentication/i.test(err.message)) {
          throw new AppError('access_missing', ACCESS_HELP, 400)
        }
        if (err instanceof CloudflareError) throw new AppError('access_missing', ACCESS_HELP, 400)
        throw err
      }
    }
    await db.update(schema.projects).set({ loginGuard: guard === 'login', updatedAt: new Date() }).where(eq(schema.projects.id, project.id))
    await audit({ actor: actorFor(request), action: 'project.access', targetType: 'project', targetId: project.id, params: { from: before, to: guard }, result: 'ok' })
    await reconcileCaddy()
    return { project: await toDto(await findProject(request.scope, project.id)) }
  })

  app.post<{ Params: IdParams }>('/projects/:id/admin-override', async (request) => {
    if (request.tokenId) throw new AppError('forbidden', 'Übersteuern geht nur mit einer Anmeldung', 403)
    const project = await findProject(request.scope, request.params.id)
    const { on } = z.object({ on: z.boolean() }).parse(request.body)
    await db.update(schema.projects)
      .set(on ? { adminOverrideAt: new Date(), adminOverrideBy: actorFor(request) } : { adminOverrideAt: null, adminOverrideBy: null })
      .where(eq(schema.projects.id, project.id))
    await audit({ actor: actorFor(request), action: on ? 'project.admin_override' : 'project.admin_override.remove', targetType: 'project', targetId: project.id, params: {}, result: 'ok' })
    return { project: await toDto(await findProject(request.scope, project.id)) }
  })
}

/** Wenn das Cloudflare-Token keine Access-Rechte hat */
export const ACCESS_HELP =
  'Airlock darf bei Cloudflare keine Access-Anwendung anlegen: dem Token fehlt das Recht «Konto → Access: Apps und Richtlinien → Bearbeiten». ' +
  'Entweder das Recht unter dash.cloudflare.com › Profil › API-Tokens ergänzen und in Einstellungen › Cloudflare & HTTPS neu prüfen – ' +
  'oder die Anwendung selbst anlegen: Zero Trust › Access › Applications › Add › Self-hosted, Domain = öffentliche Adresse, Policy «Allow» mit deiner E-Mail.'
