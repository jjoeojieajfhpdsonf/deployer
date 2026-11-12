import type { FastifyInstance } from 'fastify'
import { subscribe, trackStream, type ServerEvent } from '../../lib/events.js'
import { auth, signedCookie, SESSION_COOKIE } from '../auth.js'
import { AppError } from '../../lib/errors.js'

/** Herzschlag: hält Proxys offen und prüft dabei, ob die Sitzung noch gilt */
export const HEARTBEAT_MS = 25_000

/**
 * UI-Qualität 3: ein Strom für die Oberfläche (Server-Sent Events).
 *
 * An die Sitzung gebunden: nur mit Anmeldung (nicht mit API-Token), und bei
 * jedem Herzschlag wird die Sitzung erneut geprüft – abgelaufen oder Passwort
 * geändert beendet den Strom mit «session_ended»; ebenso Abmelden, aber nur
 * für Ströme derselben Sitzung. Ereignisse enthalten nur, *was* sich geändert
 * hat; Daten holt die Oberfläche über die normalen, geprüften Endpunkte.
 */
export async function eventRoutes(app: FastifyInstance, opts: { heartbeatMs?: number } = {}): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  app.get('/events', async (request, reply) => {
    if (request.tokenId) throw new AppError('forbidden', 'Der Ereignisstrom gehört zur Anmeldung in der Oberfläche, nicht zu API-Tokens', 403)
    const mine = request.authSession?.id ?? null
    const token = signedCookie(request, SESSION_COOKIE)

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    const write = (s: string) => { if (!closed && !reply.raw.destroyed) reply.raw.write(s) }
    const send = (e: ServerEvent) => write(`data: ${JSON.stringify(e)}\n\n`)
    // Wiederverbinden nach 5 s, falls die Verbindung abreisst
    write('retry: 5000\n\n')
    send({ type: 'hello' })

    const end = () => {
      if (closed) return
      closed = true
      clearInterval(beat)
      off()
      untrack()
      reply.raw.end()
    }
    const off = subscribe((e) => {
      if (e.type === 'session_ended') {
        // Abmelden betrifft nur diese Sitzung; «andere abmelden» alle ausser der auslösenden
        const hit = e.session ? e.session === mine : e.except ? e.except !== mine : true
        if (hit) { send({ type: 'session_ended' }); end() }
        return
      }
      send(e)
    })
    const beat = setInterval(() => {
      void auth().resolveSession(token, null).then((s) => {
        if (closed) return
        if (!s) {
          send({ type: 'session_ended' })
          end()
          return
        }
        write(': ping\n\n')
      }, () => write(': ping\n\n'))
    }, heartbeatMs)
    const untrack = trackStream(end)
    reply.raw.on('close', end)
  })
}
