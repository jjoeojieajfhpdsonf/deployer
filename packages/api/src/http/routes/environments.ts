import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createEnvironmentSchema, updateEnvironmentSchema, moveProjectSchema } from '@airlock/shared'
import {
  listEnvironmentDtos, environmentDto, resolveEnv, createEnvironmentFull, updateEnvironment, deleteEnvironment,
  listHeaderTemplates, setHeaderTemplate, removeHeaderTemplate, setTemplateOff, previewMove, moveProject, checkLanDns, copyStandards,
} from '../../domain/environment-admin.js'
import { actorFor } from '../auth.js'
import { AppError } from '../../lib/errors.js'

/**
 * M9: Umgebungen (SPEC «Umgebungen», REST). Ein API-Token sieht nur seine
 * eigene Umgebung (Liste mit einem Eintrag); anlegen, ändern, löschen,
 * Vorlagen, Verschieben und Cloudflare nur mit Anmeldung (auth.ts).
 */

const sessionOnly = (request: FastifyRequest) => {
  if (request.scope.kind === 'env') throw new AppError('forbidden', 'Umgebungen lassen sich nur mit einer Anmeldung verwalten', 403)
}
type EnvParams = { env: string }

export async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/environments', async (request) => {
    const all = await listEnvironmentDtos()
    const scope = request.scope
    return { environments: scope.kind === 'env' ? all.filter((e) => e.id === scope.envId) : all }
  })

  app.post('/environments', async (request, reply) => {
    sessionOnly(request)
    const input = createEnvironmentSchema.parse(request.body)
    reply.code(201)
    return { environment: await createEnvironmentFull(input, actorFor(request)) }
  })

  app.get<{ Params: EnvParams }>('/environments/:env', async (request) => ({ environment: await environmentDto(resolveEnv(request.params.env)) }))

  app.patch<{ Params: EnvParams }>('/environments/:env', async (request) => {
    sessionOnly(request)
    return { environment: await updateEnvironment(request.params.env, updateEnvironmentSchema.parse(request.body), actorFor(request)) }
  })

  app.delete<{ Params: EnvParams }>('/environments/:env', async (request, reply) => {
    sessionOnly(request)
    await deleteEnvironment(request.params.env, actorFor(request))
    reply.code(204)
  })

  app.post<{ Params: EnvParams }>('/environments/:env/standards/copy', async (request) => {
    sessionOnly(request)
    const { from } = z.object({ from: z.string().min(1) }).parse(request.body)
    return { environment: await copyStandards(request.params.env, from, actorFor(request)) }
  })

  /* Header-Vorlagen */
  app.get<{ Params: EnvParams }>('/environments/:env/header-templates', async (request) => ({ templates: await listHeaderTemplates(request.params.env) }))
  app.put<{ Params: EnvParams & { header: string } }>('/environments/:env/header-templates/:header', async (request) => {
    sessionOnly(request)
    const body = z.object({ value: z.string().min(1).max(500), mode: z.enum(['enforce', 'report-only']).optional() }).parse(request.body)
    return { templates: await setHeaderTemplate(request.params.env, request.params.header, body, actorFor(request)) }
  })
  app.delete<{ Params: EnvParams & { header: string } }>('/environments/:env/header-templates/:header', async (request) => {
    sessionOnly(request)
    return { templates: await removeHeaderTemplate(request.params.env, request.params.header, actorFor(request)) }
  })

  /* Lokaler DNS */
  app.get<{ Params: EnvParams }>('/environments/:env/lan-dns', async (request) => checkLanDns(request.params.env))

  /* Projekt: Vorlage abschalten, verschieben */
  app.put<{ Params: { id: string; header: string } }>('/projects/:id/header-templates/:header/off', async (request, reply) => {
    await setTemplateOff(request.scope, request.params.id, request.params.header, true, actorFor(request))
    reply.code(204)
  })
  app.delete<{ Params: { id: string; header: string } }>('/projects/:id/header-templates/:header/off', async (request, reply) => {
    await setTemplateOff(request.scope, request.params.id, request.params.header, false, actorFor(request))
    reply.code(204)
  })

  app.get<{ Params: { id: string }; Querystring: { to?: string } }>('/projects/:id/move', async (request) => {
    sessionOnly(request)
    return { preview: await previewMove(request.scope, request.params.id, z.string().min(1).parse(request.query.to)) }
  })
  app.post<{ Params: { id: string } }>('/projects/:id/move', async (request) => {
    sessionOnly(request)
    const { to } = moveProjectSchema.parse(request.body)
    return { moved: await moveProject(request.params.id, to, actorFor(request)) }
  })
}
