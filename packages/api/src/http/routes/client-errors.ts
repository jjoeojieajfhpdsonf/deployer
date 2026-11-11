import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { redactSecrets } from '../../lib/redact.js'

/**
 * Fehler aus der Oberfläche (Error Boundary) ins Log von Airlock. Nur mit
 * Anmeldung (Auth-Wächter), Felder begrenzt, Secrets geschwärzt,
 * höchstens 30 Meldungen pro Minute – eine Renderschleife flutet sonst das Log.
 */

export const clientErrorSchema = z.object({
  message: z.string().max(500),
  name: z.string().max(100).default('Error'),
  stack: z.string().max(2000).default(''),
  componentStack: z.string().max(1500).default(''),
  path: z.string().max(200).regex(/^\/[^?#]*$/, 'Nur der Pfad, ohne Query').default('/'),
  // part: Zusatz in der Shell (Befehlspalette, Aktivitätsanzeige), fällt still weg
  scope: z.enum(['app', 'page', 'part']).default('page'),
})

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30
let windowStart = 0
let count = 0

/** Rein (testbar): darf diese Meldung noch ins Log? */
export function allowReport(now: number): boolean {
  if (now - windowStart > WINDOW_MS) {
    windowStart = now
    count = 0
  }
  count++
  return count <= MAX_PER_WINDOW
}

export async function clientErrorRoutes(app: FastifyInstance): Promise<void> {
  app.post('/client-errors', async (request, reply) => {
    const body = clientErrorSchema.parse(request.body ?? {})
    if (allowReport(Date.now())) {
      request.log.error({
        clientError: {
          name: redactSecrets(body.name),
          message: redactSecrets(body.message),
          path: body.path,
          scope: body.scope,
          stack: redactSecrets(body.stack),
          componentStack: redactSecrets(body.componentStack),
        },
      }, 'Fehler in der Oberfläche')
    }
    reply.code(204)
  })
}
