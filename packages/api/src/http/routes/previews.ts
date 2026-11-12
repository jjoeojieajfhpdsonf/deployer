import type { FastifyInstance } from 'fastify'
import { previewSettingSchema, putEnvSchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import { previewsDto, setPreviewsEnabled, removePreviewByHand } from '../../domain/previews.js'
import { listEnvDto, listPreviewEnvDto, replacePreviewEnv } from '../../domain/env.js'
import { envInheritance } from '../../lib/previews.js'
import { audit } from '../../domain/audit.js'
import { actorFor } from '../auth.js'
import { badRequest } from '../../lib/errors.js'

/**
 * Etappe 6: Vorschauen eines Projekts (Reiter Deployments) und die
 * Variablen-Ebene «Vorschau» (Einstellungen). Eine Vorschau selbst ist über
 * die Projekt-Routen nicht erreichbar (findProject) – nur hier, unter ihrem
 * Projekt.
 */
export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/projects/:id/previews', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { previews: await previewsDto(p) }
  })

  /** Schalter «Vorschauen» (Standard aus); nur für Git-Projekte mit GitHub-App */
  app.put<{ Params: { id: string } }>('/projects/:id/previews', async (request) => {
    const { enabled } = previewSettingSchema.parse(request.body ?? {})
    const p = await findProject(request.scope, request.params.id)
    return { previews: await setPreviewsEnabled(p, enabled, actorFor(request)) }
  })

  /** Eine Vorschau löschen (die Oberfläche fragt vorher nach) */
  app.delete<{ Params: { id: string; previewId: string } }>('/projects/:id/previews/:previewId', async (request, reply) => {
    const p = await findProject(request.scope, request.params.id)
    await removePreviewByHand(p, request.params.previewId, actorFor(request))
    reply.code(204)
  })

  /** Ebene «Vorschau»: eigene Werte und was vom Projekt geerbt wird (nur Namen) */
  app.get<{ Params: { id: string } }>('/projects/:id/preview-env', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    const own = await listPreviewEnvDto(p.id)
    const project = await listEnvDto(p.id)
    return { env: own, inherited: envInheritance(project, own.map((e) => e.key)) }
  })

  app.put<{ Params: { id: string } }>('/projects/:id/preview-env', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    const { entries } = putEnvSchema.parse(request.body)
    const seen = new Set<string>()
    for (const e of entries) {
      if (seen.has(e.key)) throw badRequest(`Die Umgebungsvariable "${e.key}" kommt doppelt vor`)
      seen.add(e.key)
    }
    await replacePreviewEnv(p.id, entries)
    await audit({ actor: actorFor(request), action: 'project.preview_env.replace', targetType: 'project', targetId: p.id, params: { keys: entries.map((e) => e.key) }, result: 'ok' })
    const own = await listPreviewEnvDto(p.id)
    const project = await listEnvDto(p.id)
    return { env: own, inherited: envInheritance(project, own.map((e) => e.key)) }
  })
}
