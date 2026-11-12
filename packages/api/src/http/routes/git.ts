import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { confirmHostKeySchema, createGitCredentialSchema, gitRefSchema, repoUrlSchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import {
  checkRepo, confirmHostKey, createCredential, credentialOfProject, forgetHostKey, projectGitAccess,
  removeProjectCredential, setProjectCredential,
} from '../../domain/git-access.js'
import { actorFor, requireSudo } from '../auth.js'
import { badRequest } from '../../lib/errors.js'

/**
 * Nacht 3, Etappe 2: private Git-Repos. Nur mit Anmeldung (der Wächter
 * sperrt API-Tokens für /git und /projects/:id/git-access).
 *
 * Neues Projekt: Zugang erzeugen (Deploy-Key oder Token) → «Repo prüfen»
 * (beim ersten SSH-Kontakt: Server-Schlüssel bestätigen) → anlegen mit
 * gitCredentialId. Danach unter Einstellungen › Repo-Zugang.
 */

const checkSchema = z.object({
  repoUrl: repoUrlSchema,
  ref: gitRefSchema.optional(),
  credentialId: z.string().uuid().optional(),
})

interface IdParams { id: string }

export async function gitRoutes(app: FastifyInstance): Promise<void> {
  /** «Repo erreichbar?» vor dem Anlegen */
  app.post('/git/check', async (request) => {
    const b = checkSchema.parse(request.body ?? {})
    return { check: await checkRepo({ repoUrl: b.repoUrl, ref: b.ref, credentialId: b.credentialId }) }
  })

  /** Deploy-Key erzeugen oder Token speichern (noch ohne Projekt, 24 Stunden gültig) */
  app.post('/git/credentials', async (request, reply) => {
    const input = createGitCredentialSchema.parse(request.body ?? {})
    reply.code(201)
    return { credential: await createCredential(input, actorFor(request)) }
  })

  /** Server-Schlüssel eines eben erzeugten Deploy-Keys bestätigen (TOFU) */
  app.post<{ Params: IdParams }>('/git/credentials/:id/host-key', async (request) => {
    const b = confirmHostKeySchema.parse(request.body ?? {})
    if (!z.string().uuid().safeParse(request.params.id).success) throw badRequest('Ungültige ID')
    return { credential: await confirmHostKey({ credentialId: request.params.id, host: b.host, fingerprints: b.fingerprints }, actorFor(request)) }
  })

  /* --- Pro Projekt (Einstellungen › Repo-Zugang) ------------------------------------- */

  app.get<{ Params: IdParams }>('/projects/:id/git-access', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { access: await projectGitAccess(p) }
  })

  /** Prüfen mit dem Zugang des Projekts (Branch wie eingestellt) */
  app.post<{ Params: IdParams }>('/projects/:id/git-access/check', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    const src = (p.sourceConfig ?? {}) as { repoUrl?: string; ref?: string }
    if (!src.repoUrl) throw badRequest('Das Projekt hat kein Git-Repo')
    return { check: await checkRepo({ repoUrl: src.repoUrl, ref: src.ref, project: p }) }
  })

  /**
   * Zugang setzen. Ersetzen eines bestehenden ist heikel (der alte gilt sofort
   * nicht mehr, ein Token könnte auf ein fremdes Konto zeigen): erneute Bestätigung.
   */
  app.put<{ Params: IdParams }>('/projects/:id/git-access', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    if (!(p.sourceConfig as { repoUrl?: string } | null)?.repoUrl) throw badRequest('Das Projekt hat kein Git-Repo')
    const input = createGitCredentialSchema.parse(request.body ?? {})
    if (await credentialOfProject(p.id)) requireSudo(request)
    return { credential: await setProjectCredential(p, input, actorFor(request)) }
  })

  /** Zugang entfernen (danach ohne Zugang bzw. über die GitHub-App) – erneute Bestätigung (SUDO_ROUTES) */
  app.delete<{ Params: IdParams }>('/projects/:id/git-access', async (request, reply) => {
    const p = await findProject(request.scope, request.params.id)
    await removeProjectCredential(p, actorFor(request))
    reply.code(204)
  })

  /** Server-Schlüssel bestätigen (TOFU), nach «Prüfen» */
  app.post<{ Params: IdParams }>('/projects/:id/git-access/host-key', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    const b = confirmHostKeySchema.parse(request.body ?? {})
    return { credential: await confirmHostKey({ project: p, host: b.host, fingerprints: b.fingerprints }, actorFor(request)) }
  })

  /** Bestätigten Server-Schlüssel vergessen (Anbieter hat gewechselt) – erneute Bestätigung (SUDO_ROUTES) */
  app.delete<{ Params: IdParams }>('/projects/:id/git-access/host-key', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { credential: await forgetHostKey(p, actorFor(request)) }
  })
}
