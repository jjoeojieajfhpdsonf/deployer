import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { GATE_CALLBACK_PATH, GATE_COOKIE, UI_HOST_LABEL } from '@airlock/shared'
import { primaryHost, urlForHost } from '../../config.js'
import { isGatedHost } from '../../domain/routes.js'
import { audit } from '../../domain/audit.js'
import { GateCodes, cleanHost, makeGateToken, readGateToken, safeReturnPath } from '../../lib/gate.js'
import { auth, currentSession, fromCaddy } from '../auth.js'

/**
 * Zugang «Airlock-Login» (forward_auth), Ablauf siehe lib/gate.ts.
 *
 * GET /gate/check     – nur von Caddy: 204 mit gültigem Cookie, sonst 302 zur Anmeldung
 * GET /gate/start     – auf der Oberfläche: angemeldet → Code und zurück zum Projekt-Host
 * GET /gate/callback  – nur von Caddy (Pfad /.airlock/gate am Projekt-Host): Cookie setzen
 *
 * Alle drei stehen in OPEN_ROUTES (auth.ts) und prüfen selbst.
 */
export interface GateDeps {
  now: () => number
  sign: (data: string) => string
  /** Sitzung per ID, null = abgemeldet/abgelaufen */
  session: (id: string) => Promise<{ id: string; expiresAt: Date } | null>
  /** Sitzung der Oberfläche aus dem Cookie (nur auf ihrem Host gesetzt) */
  uiSession: (request: FastifyRequest) => Promise<{ id: string; expiresAt: Date } | null>
  fromCaddy: (request: FastifyRequest) => boolean
  isGated: (host: string) => boolean
  /** z. B. https://deployer.int.example.ch */
  uiOrigin: () => string
  audit: (e: { actor: string; action: string; params: Record<string, unknown> }) => Promise<void>
}

const realDeps: GateDeps = {
  now: () => Date.now(),
  sign: (d) => auth().gateSign(d),
  session: (id) => auth().sessionById(id),
  uiSession: (r) => currentSession(r),
  fromCaddy,
  isGated: isGatedHost,
  uiOrigin: () => urlForHost(primaryHost(UI_HOST_LABEL)),
  audit: (e) => audit({ ...e, targetType: 'system', targetId: null, result: 'ok' }),
}

/** Sitzungen kurz merken: forward_auth fragt bei jeder Anfrage (Bilder, Skripte …) */
const SESSION_CACHE_MS = 30_000

function cookieOf(request: FastifyRequest, name: string): string | null {
  const raw = request.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

export async function gateRoutes(app: FastifyInstance, opts: { deps?: Partial<GateDeps> } = {}): Promise<void> {
  const d: GateDeps = { ...realDeps, ...opts.deps }
  const codes = new GateCodes()
  const cache = new Map<string, { ok: boolean; at: number }>()

  const sessionOk = async (sid: string): Promise<boolean> => {
    const hit = cache.get(sid)
    if (hit && d.now() - hit.at < SESSION_CACHE_MS) return hit.ok
    const ok = Boolean(await d.session(sid))
    cache.set(sid, { ok, at: d.now() })
    return ok
  }

  const notFromCaddy = (reply: FastifyReply) => reply.code(403).send({ error: { code: 'forbidden', message: 'Nur Caddy fragt hier an' } })

  app.get('/gate/check', async (request, reply) => {
    if (!d.fromCaddy(request)) return notFromCaddy(reply)
    const host = cleanHost(request.headers['x-forwarded-host'])
    if (!host || !d.isGated(host)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Unbekannter Name' } })
    const sid = readGateToken(cookieOf(request, GATE_COOKIE), host, d.now(), d.sign)
    if (sid && (await sessionOk(sid))) return reply.code(204).header('cache-control', 'no-store').send()
    const proto = String(request.headers['x-forwarded-proto'] ?? 'https') === 'http' ? 'http' : 'https'
    const rd = safeReturnPath(String(request.headers['x-forwarded-uri'] ?? '/'))
    const q = new URLSearchParams({ host, rd, proto })
    return reply.code(302).header('cache-control', 'no-store').header('location', `${d.uiOrigin()}/api/v1/gate/start?${q}`).send()
  })

  app.get<{ Querystring: { host?: string; rd?: string; proto?: string } }>('/gate/start', async (request, reply) => {
    const host = cleanHost(request.query.host)
    // Nur Namen mit Zugang «Airlock-Login» – sonst wäre das eine offene Weiterleitung
    if (!host || !d.isGated(host)) return reply.code(400).send({ error: { code: 'bad_request', message: 'Für diese Adresse gibt es keine Anmeldung über Airlock' } })
    const rd = safeReturnPath(request.query.rd)
    const proto = request.query.proto === 'http' ? 'http' : 'https'
    const session = await d.uiSession(request)
    if (!session) {
      // Erst anmelden (Oberfläche: Passwort, Passkey, zweiter Faktor), danach geht es hier weiter
      const back = `/api/v1/gate/start?${new URLSearchParams({ host, rd, proto })}`
      return reply.code(302).header('location', `/zugang?weiter=${encodeURIComponent(back)}`).send()
    }
    const code = codes.issue(session.id, host, d.now())
    return reply.code(302).header('cache-control', 'no-store')
      .header('location', `${proto}://${host}${GATE_CALLBACK_PATH}?${new URLSearchParams({ code, rd })}`).send()
  })

  app.get<{ Querystring: { code?: string; rd?: string } }>('/gate/callback', async (request, reply) => {
    if (!d.fromCaddy(request)) return notFromCaddy(reply)
    const host = cleanHost(request.headers['x-forwarded-host'])
    if (!host || !d.isGated(host)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Unbekannter Name' } })
    const sid = codes.consume(request.query.code, host, d.now())
    const session = sid ? await d.session(sid) : null
    if (!session) {
      return reply.code(400).type('text/plain; charset=utf-8').send('Die Anmeldung ist abgelaufen oder wurde schon benutzt. Bitte die Adresse noch einmal öffnen.')
    }
    const exp = session.expiresAt.getTime()
    const token = makeGateToken({ sid: session.id, host, exp }, d.sign)
    const secure = String(request.headers['x-forwarded-proto'] ?? 'https') !== 'http'
    const maxAge = Math.max(60, Math.floor((exp - d.now()) / 1000))
    // Nur dieser Host (kein Domain-Attribut), nie für Skripte lesbar
    const cookie = `${GATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
    await d.audit({ actor: 'ui:joel', action: 'gate.login', params: { host } }).catch(() => {})
    return reply.code(302).header('set-cookie', cookie).header('cache-control', 'no-store').header('location', safeReturnPath(request.query.rd)).send()
  })
}
