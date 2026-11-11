import type { FastifyInstance } from 'fastify'
import { subscribe, type ServerEvent } from '../../lib/events.js'
import { isLoggedIn } from '../auth.js'
import { AppError } from '../../lib/errors.js'

/** Herzschlag: hält Proxys offen und prüft dabei, ob die Sitzung noch gilt */
export const HEARTBEAT_MS = 25_000

/**
 * UI-Qualität 3: ein Strom für die Oberfläche (Server-Sent Events).
 *
 * An die Sitzung gebunden: nur mit Anmeldung (nicht mit API-Token), und bei
 * jedem Herzschlag wird die Sitzung erneut geprüft – abgelaufen, Passwort
 * geändert oder abgemeldet beendet den Strom mit «session_ended». Ereignisse
 * enthalten nur, *was* sich geändert hat; Daten holt die Oberfläche über die
 * normalen, geprüften Endpunkte.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (request, reply) => {
    if (request.tokenId) throw new AppError('forbidden', 'Der Ereignisstrom gehört zur Anmeldung in der Oberfläche, nicht zu API-Tokens', 403)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Wiederverbinden nach 5 s, falls die Verbindung abreisst
    reply.raw.write('retry: 5000\n\n')
    const send = (e: ServerEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    send({ type: 'hello' })

    let closed = false
    const end = () => {
      if (closed) return
      closed = true
      clearInterval(beat)
      off()
      reply.raw.end()
    }
    const off = subscribe((e) => {
      if (e.type === 'session_ended') {
        send(e)
        end()
        return
      }
      send(e)
    })
    const beat = setInterval(() => {
      if (!isLoggedIn(request)) {
        send({ type: 'session_ended' })
        end()
        return
      }
      reply.raw.write(': ping\n\n')
    }, HEARTBEAT_MS)
    request.raw.on('close', end)
    return reply
  })
}
