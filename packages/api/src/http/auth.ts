import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes, createHash } from 'node:crypto'
import { getSetting, setSetting } from '../db/index.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { config } from '../config.js'
import { unauthorized, AppError } from '../lib/errors.js'
import { bearerFrom } from '../lib/tokens.js'
import { verifyToken } from '../domain/tokens.js'
import { inEnvironment, sessionScope } from '../lib/scope.js'
import { log } from '../lib/log.js'

export const SESSION_COOKIE = 'airlock_session'
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60

/**
 * Ein Benutzer, ein Passwort, Session-Cookie. Passkey kommt spaeter.
 *
 * Auch wenn der Dienst nur im LAN haengt: ohne Login kann jedes Geraet im
 * Netz Container starten.
 */

/** Fingerabdruck des Passworts aus .env – nur um eine Änderung dort zu erkennen. */
// Bewusst weiter «deployer-env»: der gespeicherte Fingerabdruck stammt aus
// der deployer-Zeit. Ein anderer Text liesse ihn nicht mehr passen, und das
// in der Oberfläche geänderte Passwort würde auf ADMIN_PASSWORD zurückgesetzt.
const envFingerprint = () => createHash('sha256').update(`deployer-env\0${config.ADMIN_PASSWORD}`).digest('hex')

/**
 * Passwort beim Start. ADMIN_PASSWORD aus .env gilt beim ersten Start und
 * immer dann, wenn es sich in .env GEÄNDERT hat (Weg zurück, falls das
 * Passwort vergessen ist). Ein in der Oberfläche geändertes Passwort bleibt
 * sonst über Neustarts erhalten – vorher setzte jeder Start .env wieder durch.
 */
export async function ensureAdminPassword(): Promise<void> {
  const stored = await getSetting('admin_password_hash')
  const fp = await getSetting('admin_password_env_fp')
  validAfter = Number((await getSetting('sessions_valid_after')) ?? 0)
  if (stored && fp === envFingerprint()) return
  if (stored && fp === null && verifyPassword(config.ADMIN_PASSWORD, stored)) {
    await setSetting('admin_password_env_fp', envFingerprint())
    return
  }
  await setSetting('admin_password_hash', hashPassword(config.ADMIN_PASSWORD))
  await setSetting('admin_password_env_fp', envFingerprint())
  await setSetting('admin_password_changed', JSON.stringify({ at: new Date().toISOString(), source: 'env' }))
  log.info(stored ? 'Admin-Passwort aus der Umgebung übernommen (.env geändert)' : 'Admin-Passwort gesetzt')
}

/** Sitzungen, die vor diesem Zeitpunkt begonnen haben, gelten nicht mehr. */
let validAfter = 0

export async function changePassword(current: string, next: string): Promise<void> {
  const stored = await getSetting('admin_password_hash')
  if (!stored || !verifyPassword(current, stored)) throw new AppError('invalid_credentials', 'Das bisherige Passwort stimmt nicht', 400)
  if (next === current) throw new AppError('bad_request', 'Das neue Passwort ist dasselbe wie das bisherige', 400)
  await setSetting('admin_password_hash', hashPassword(next))
  await setSetting('admin_password_changed', JSON.stringify({ at: new Date().toISOString(), source: 'ui' }))
  // Alle anderen Sitzungen abmelden; die eigene bekommt danach ein neues Cookie.
  validAfter = Date.now()
  await setSetting('sessions_valid_after', String(validAfter))
}

export async function passwordInfo(): Promise<{ changedAt: string | null; source: 'env' | 'ui' | null }> {
  const raw = await getSetting('admin_password_changed')
  if (!raw) return { changedAt: null, source: null }
  const v = JSON.parse(raw) as { at: string; source: 'env' | 'ui' }
  return { changedAt: v.at, source: v.source }
}

/** Beginn der Sitzung (Zeitpunkt der Anmeldung) oder null. */
export function sessionStart(request: FastifyRequest): number | null {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return null
  const result = request.unsignCookie(raw)
  if (!result.valid || !result.value) return null
  const issued = Number(result.value)
  return Number.isFinite(issued) ? issued : null
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
  const issued = sessionStart(request)
  if (issued === null) return false
  if (issued < validAfter) return false
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
  // M8: CSP-Meldungen kommen von Browsern ohne Anmeldung (Schlüssel im Pfad)
  const open = new Set(['/api/v1/auth/login', '/api/v1/auth/me', '/health', '/api/v1/csp-reports/:key'])
  app.decorateRequest('actor', '')
  app.decorateRequest('tokenId', null)
  app.decorateRequest('scope', null as never)
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
      if (route.startsWith('/api/v1/tokens') || route.startsWith('/api/v1/environments/:env/tokens') || route.startsWith('/api/v1/auth/')) {
        throw new AppError('forbidden', 'Tokens lassen sich nur mit einer Anmeldung verwalten, nicht mit einem Token', 403)
      }
      // M6: ebenso die Benachrichtigungen – ein gestohlenes Token könnte sie
      // sonst auf ein fremdes ntfy oder Postfach umleiten.
      if (route.startsWith('/api/v1/notifications')) {
        throw new AppError('forbidden', 'Benachrichtigungen lassen sich nur mit einer Anmeldung einstellen', 403)
      }
      // M8: ebenso die GitHub App – ein Token könnte sie sonst auf eine fremde App umstellen
      if (route.startsWith('/api/v1/github')) {
        throw new AppError('forbidden', 'Die GitHub-Verbindung lässt sich nur mit einer Anmeldung einrichten', 403)
      }
      // M9: hosts-Block nennt die Namen aller Umgebungen – nur mit Anmeldung
      if (route.startsWith('/api/v1/system/hosts')) {
        throw new AppError('forbidden', 'Die hosts-Datei gibt es nur mit einer Anmeldung, nicht mit einem Token', 403)
      }
      // M9: Umgebungen verwalten (anlegen, ändern, Vorlagen, Cloudflare je Umgebung) nur mit
      // Anmeldung. Ein Token liest seine Umgebung und legt darin Projekte und externe Ziele an.
      if (route.startsWith('/api/v1/environments/:env/cloudflare')) {
        throw new AppError('forbidden', 'Cloudflare lässt sich nur mit einer Anmeldung einrichten, nicht mit einem API-Token', 403)
      }
      const envWriteAllowed = route === '/api/v1/environments/:env/projects' || route === '/api/v1/environments/:env/external-targets'
      if (route.startsWith('/api/v1/environments') && request.method !== 'GET' && !envWriteAllowed) {
        throw new AppError('forbidden', 'Umgebungen lassen sich nur mit einer Anmeldung verwalten', 403)
      }
      // Cloudflare verbinden: Token, Tunnel, Zertifikat – auch lesen nur mit Anmeldung.
      if (route.startsWith('/api/v1/system/cloudflare')) {
        throw new AppError('forbidden', 'Cloudflare lässt sich nur mit einer Anmeldung einrichten, nicht mit einem API-Token', 403)
      }
      // M4/M5: DNS bei Cloudflare ändern nur mit Anmeldung.
      if (route.startsWith('/api/v1/system/tailnet-dns') || ((route.startsWith('/api/v1/domains') || route.startsWith('/api/v1/environments/:env/domains')) && request.method !== 'GET')) {
        throw new AppError('forbidden', 'DNS bei Cloudflare lässt sich nur mit einer Anmeldung ändern', 403)
      }
      request.actor = `token:${identity.name}`
      request.tokenId = identity.id
      // M9: ein Token sieht nur seine Umgebung
      request.scope = inEnvironment(identity.environmentId)
      return
    }
    if (!isLoggedIn(request)) throw unauthorized()
    request.actor = 'ui:joel'
    request.scope = sessionScope()
  })
}

export const actorFor = (request: FastifyRequest): string => request.actor || 'ui:joel'
