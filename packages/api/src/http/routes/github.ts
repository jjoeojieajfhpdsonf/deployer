import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { githubManifestRequestSchema } from '@airlock/shared'
import { githubStatus, startManifest, finishManifest, finishInstall, refreshRepos, disconnect, connectedRepo } from '../../domain/github.js'
import { findProject } from '../../domain/projects.js'
import { audit } from '../../domain/audit.js'
import { db, schema } from '../../db/index.js'
import { actorFor } from '../auth.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { log } from '../../lib/log.js'
import { GithubError } from '../../lib/github.js'

/**
 * M8, Etappe 3: GitHub App. Die Rückleitungen sind gewöhnliche GET-Aufrufe
 * des Browsers (mit der Anmeldung bei Airlock); Airlock muss dafür nicht
 * öffentlich erreichbar sein. Danach geht es zurück auf die Systemseite.
 */

/**
 * Zurück auf die Systemseite – nur mit festen Codes, nie mit Freitext: ein
 * präparierter Link könnte sonst beliebige Meldungen anzeigen. Die Seite
 * bildet die Codes auf Texte ab; Einzelheiten stehen im Log.
 */
type BackCode = 'angelegt' | 'installiert' | 'aktualisiert' | 'state' | 'vorhanden' | 'github' | 'unbekannt'
const back = (ok: boolean, code: BackCode) => `/system/github?${ok ? 'ok' : 'fehler'}=${code}`
const errorCode = (err: unknown): BackCode => {
  if (err instanceof GithubError) return 'github'
  if (err instanceof AppError && err.code === 'conflict') return 'vorhanden'
  if (err instanceof AppError && /state/.test(err.message)) return 'state'
  return 'unbekannt'
}

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  app.get('/github', async () => githubStatus())

  /** Manifest und Formularziel; das Formular schickt der Browser an GitHub. */
  app.post('/github/manifest', async (request) => {
    const body = githubManifestRequestSchema.parse(request.body ?? {})
    return startManifest({ name: body.name, org: body.org || null }, actorFor(request))
  })

  app.get<{ Querystring: { code?: string; state?: string } }>('/github/manifest/callback', async (request, reply) => {
    try {
      if (!request.query.code) throw badRequest('GitHub hat keinen Code zurückgegeben')
      await finishManifest(request.query.code, request.query.state, actorFor(request))
      return reply.redirect(back(true, 'angelegt'))
    } catch (err) {
      log.warn('GitHub-Manifest nicht abgeschlossen', { err: String(err) })
      return reply.redirect(back(false, errorCode(err)))
    }
  })

  app.get<{ Querystring: { installation_id?: string; setup_action?: string } }>('/github/setup/callback', async (request, reply) => {
    try {
      if (!request.query.installation_id) throw badRequest('GitHub hat keine installation_id zurückgegeben')
      await finishInstall(request.query.installation_id, actorFor(request))
      return reply.redirect(back(true, request.query.setup_action === 'update' ? 'aktualisiert' : 'installiert'))
    } catch (err) {
      log.warn('GitHub-Installation nicht übernommen', { err: String(err) })
      return reply.redirect(back(false, errorCode(err)))
    }
  })

  app.post('/github/refresh', async (request) => ({ repos: await refreshRepos(actorFor(request)) }))

  app.delete('/github', async (request, reply) => {
    await disconnect(actorFor(request))
    reply.code(204)
  })

  /** Auto-Deploy nach Merge pro Projekt (nur Git-Quellen). */
  app.put<{ Params: { id: string } }>('/projects/:id/auto-deploy', async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body ?? {})
    const p = await findProject(request.scope, request.params.id)
    if (enabled && p.sourceType !== 'dockerfile' && p.sourceType !== 'compose') throw badRequest('Auto-Deploy gibt es nur für Projekte aus einem Git-Repo')
    if (enabled && !(p.sourceConfig as { repoUrl?: string }).repoUrl) throw badRequest('Das Projekt hat kein Git-Repo (Upload)')
    await db.update(schema.projects).set({ autoDeploy: enabled, updatedAt: new Date() }).where(eq(schema.projects.id, p.id))
    await audit({ actor: actorFor(request), action: 'project.auto_deploy_setting', targetType: 'project', targetId: p.id, params: { enabled }, result: 'ok' })
    return { autoDeploy: enabled, viaGithubApp: Boolean(await connectedRepo(p).catch(() => null)) }
  })

  app.get<{ Params: { id: string } }>('/projects/:id/auto-deploy', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return {
      autoDeploy: p.autoDeploy,
      checkedAt: p.autoDeployCheckedAt?.toISOString() ?? null,
      available: (p.sourceType === 'dockerfile' || p.sourceType === 'compose') && Boolean((p.sourceConfig as { repoUrl?: string }).repoUrl),
      viaGithubApp: Boolean(await connectedRepo(p).catch(() => null)),
    }
  })
}
