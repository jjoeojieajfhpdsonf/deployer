import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { tokenNameSchema } from '@airlock/shared'
import { createToken, listTokens, revokeToken } from '../../domain/tokens.js'
import { actorFor } from '../auth.js'
import { listScopeFor } from '../scope.js'

/**
 * Nur mit Anmeldung erreichbar; der Auth-Guard weist Bearer-Tokens hier ab.
 * M9: Tokens gehören zu einer Umgebung – Liste und Anlegen in der Umgebung
 * aus dem Pfad bzw. ?environment= (ohne Angabe die Standard-Umgebung).
 */
export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  const list = async (request: FastifyRequest) => ({ tokens: await listTokens(listScopeFor(request)) })
  app.get('/tokens', list)
  app.get('/environments/:env/tokens', list)

  const create = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = listScopeFor(request)
    const { name } = tokenNameSchema.parse(request.body)
    const { token, dto } = await createToken(scope, name, actorFor(request))
    reply.code(201)
    // Der Klartext steht nur in dieser einen Antwort.
    return { token, apiToken: dto }
  }
  app.post('/tokens', create)
  app.post('/environments/:env/tokens', create)

  app.delete<{ Params: { id: string } }>('/tokens/:id', async (request, reply) => {
    await revokeToken(request.scope, request.params.id, actorFor(request))
    reply.code(204)
  })
}
