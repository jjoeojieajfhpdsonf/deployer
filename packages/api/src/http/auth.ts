import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import { getSetting, setSetting } from '../db/index.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { config } from '../config.js'
import { unauthorized, AppError } from '../lib/errors.js'
import { bearerFrom } from '../lib/tokens.js'
import { verifyToken } from '../domain/tokens.js'
import { log } from '../lib/log.js'

export const SESSION_COOKIE = 'deployer_session'
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60

/**
 * Ein Benutzer, ein Passwort, Session-Cookie. Passkey kommt spaeter.
 *
 * Auch wenn der Dienst nur im LAN haengt: ohne Login kann jedes Geraet im
 * Netz Container starten.
 */

export async function ensureAdminPassword(): Promise<void> {
  const stored = await getSetting('admin_password_hash')
  if (stored && verifyPassword(config.ADMIN_PASSWORD, stored)) return
  await setSetting('admin_password_hash', hashPassword(config.ADMIN_PASSWORD))
  log.info(stored ? 'Admin-Passwort aus der Umgebung übernommen' : 'Admin-Passwort gesetzt')
}

export async function sessionSecret(): Promise<string> {
  if (config.SESSION_SECRET) return config.SESSION_SECRET
  const stored = await getSetting('session_secret')
  if (stored) return stored
  const fresh = randomBytes(32).toString('hex')
  await setSetting('session_secret', fresh)
  return fresh
}

/* --- Anmeldeversuche begrenzen -------------------------------------------- */

const attempts = new Map<string, { count: number; until: number }>()
const MAX_ATTEMPTS = 10
const WINDOW_MS = 5 * 60 * 1000

function tooManyAttempts(ip: string): boolean {
  const e = attempts.get(ip)
  if (!e) return false
  if (Date.now() > e.until) {
    attempts.delete(ip)
    return false
  }
  return e.count >= MAX_ATTEMPTS
}

function noteFailure(ip: string): void {
  const e = attempts.get(ip)
  if (!e || Date.now() > e.until) {
    attempts.set(ip, { count: 1, until: Date.now() + WINDOW_MS })
    return
  }
  e.count++
}

export async function login(ip: string, password: string): Promise<boolean> {
  if (tooManyAttempts(ip)) {
    throw new AppError('too_many_attempts', 'Zu viele Fehlversuche, bitte später erneut', 429)
  }
  const stored = await getSetting('admin_password_hash')
  if (!stored || !verifyPassword(password, stored)) {
    noteFailure(ip)
    return false
  }
  attempts.delete(ip)
  return true
}

/**
 * Kam die Anfrage über HTTPS bei Caddy an? Caddy setzt X-Forwarded-Proto
 * selbst und überschreibt, was ein Client mitschickt. Bewusst nur dieser
 * Header und kein trustProxy: X-Forwarded-For bleibt unbeachtet, damit im
 * Projekt-Netz niemand eine Absenderadresse vortäuschen kann. Ein
 * vorgetäuschtes "https" schadet nicht – es macht nur das eigene Cookie
 * strenger.
 */
export function viaHttps(request: FastifyRequest): boolean {
  const v = request.headers['x-forwarded-proto']
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() === 'https'
}

export function setSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
  reply.setCookie(SESSION_COOKIE, String(Date.now()), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // M4: Secure, sobald über HTTPS angemeldet. Über nip.io (HTTP, kein
    // Zertifikat) bleibt der Login möglich – sonst wäre der Rückfall zu.
    secure: viaHttps(request),
    signed: true,
    maxAge: SESSION_MAX_AGE_S,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function isLoggedIn(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return false
  const result = request.unsignCookie(raw)
  if (!result.valid || !result.value) return false
  const issued = Number(result.value)
  if (!Number.isFinite(issued)) return false
  return Date.now() - issued < SESSION_MAX_AGE_S * 1000
}

declare module 'fastify' {
  interface FastifyRequest {
    /** "ui:joel" bei Anmeldung, "token:<name>" bei API-Token (M3). */
    actor: string
    tokenId: string | null
  }
}

/**
 * Schuetzt alles unter /api/v1 ausser den ausdruecklich offenen Pfaden.
 *
 * Zwei Wege hinein: Session-Cookie (UI) oder `Authorization: Bearer dpl_…`
 * (Skripte, M3). Tokens verwalten geht nur mit Anmeldung: ein gestohlenes
 * Token könnte sich sonst ein zweites anlegen und den Widerruf überdauern.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  const open = new Set(['/api/v1/auth/login', '/api/v1/auth/me', '/health'])
  app.decorateRequest('actor', '')
  app.decorateRequest('tokenId', null)
  app.addHook('onRequest', async (request) => {
    // Entschieden wird am ROUTENMUSTER, das der Router gewählt hat – nie am
    // rohen Pfad. Der Router dekodiert Prozentkodierung: "/%61pi/v1/projects"
    // landet auf "/api/v1/projects", hätte aber eine Prüfung des rohen Pfads
    // ("beginnt mit /api/") umgangen. Genau das war seit M1 möglich
    // (gefunden im Review von M3).
    const route = request.routeOptions.url
    if (!route) return // keine Route: 404 ohne Daten
    if (!route.startsWith('/api/')) return
    if (open.has(route)) return

    const bearer = bearerFrom(request.headers.authorization)
    if (bearer) {
      const identity = await verifyToken(bearer)
      if (!identity) throw unauthorized()
      if (route.startsWith('/api/v1/tokens')) {
        throw new AppError('forbidden', 'Tokens lassen sich nur mit einer Anmeldung verwalten, nicht mit einem Token', 403)
      }
      // M6: ebenso die Benachrichtigungen – ein gestohlenes Token könnte sie
      // sonst auf ein fremdes ntfy oder Postfach umleiten.
      if (route.startsWith('/api/v1/notifications')) {
        throw new AppError('forbidden', 'Benachrichtigungen lassen sich nur mit einer Anmeldung einstellen', 403)
      }
      // M4/M5: DNS bei Cloudflare ändern nur mit Anmeldung.
      if (route.startsWith('/api/v1/system/tailnet-dns') || route.startsWith('/api/v1/system/cloudflare') || (route.startsWith('/api/v1/domains') && request.method !== 'GET')) {
        throw new AppError('forbidden', 'DNS bei Cloudflare lässt sich nur mit einer Anmeldung ändern', 403)
      }
      request.actor = `token:${identity.name}`
      request.tokenId = identity.id
      return
    }
    if (!isLoggedIn(request)) throw unauthorized()
    request.actor = 'ui:joel'
  })
}

export const actorFor = (request: FastifyRequest): string => request.actor || 'ui:joel'
