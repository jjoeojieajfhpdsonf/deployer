import type { FastifyInstance } from 'fastify'
import { tokenNameSchema } from '@airlock/shared'
import { createToken, listTokens, revokeToken } from '../../domain/tokens.js'
import { actorFor } from '../auth.js'

/** Nur mit Anmeldung erreichbar; der Auth-Guard weist Bearer-Tokens hier ab. */
export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tokens', async () => ({ tokens: await listTokens() }))

  app.post('/tokens', async (request, reply) => {
    const { name } = tokenNameSchema.parse(request.body)
    const { token, dto } = await createToken(name, actorFor(request))
    reply.code(201)
    // Der Klartext steht nur in dieser einen Antwort.
    return { token, apiToken: dto }
  })

  app.delete<{ Params: { id: string } }>('/tokens/:id', async (request, reply) => {
    await revokeToken(request.params.id, actorFor(request))
    reply.code(204)
  })
}
