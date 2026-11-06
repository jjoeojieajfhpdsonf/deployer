import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import { getSetting, setSetting } from '../db/index.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { config } from '../config.js'
import { unauthorized, AppError } from '../lib/errors.js'
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

export function setSessionCookie(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, String(Date.now()), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Kein secure-Flag: M1 laeuft bewusst ohne TLS (Zertifikate ab M4).
    // Mit M4 gehoert hier secure: true hin.
    secure: false,
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

/** Schuetzt alles unter /api/v1 ausser den ausdruecklich offenen Pfaden. */
export function registerAuthGuard(app: FastifyInstance): void {
  const open = new Set(['/api/v1/auth/login', '/api/v1/auth/me', '/health'])
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? ''
    if (!path.startsWith('/api/')) return
    if (open.has(path)) return
    if (!isLoggedIn(request)) throw unauthorized()
  })
}

export const actorFor = (_request: FastifyRequest): string => 'ui:joel'
