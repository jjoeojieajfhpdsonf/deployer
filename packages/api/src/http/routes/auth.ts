import type { FastifyInstance } from 'fastify'
import { loginSchema } from '@airlock/shared'
import { passwordChangeSchema } from '@airlock/shared'
import { login, setSessionCookie, clearSessionCookie, isLoggedIn, changePassword, passwordInfo, sessionStart, viaHttps } from '../auth.js'
import { config } from '../../config.js'
import { isoOrNull } from '../../lib/dates.js'
import { audit } from '../../domain/audit.js'
import { AppError } from '../../lib/errors.js'
import { publish } from '../../lib/events.js'
import { getUiPrefs, setUiPrefs, unlockUi } from '../../domain/ui-prefs.js'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const { password } = loginSchema.parse(request.body)
    const ip = request.ip
    const ok = await login(ip, password)
    if (!ok) {
      await audit({ actor: `ip:${ip}`, action: 'auth.login', result: 'error', error: 'falsches Passwort' })
      throw new AppError('invalid_credentials', 'Passwort stimmt nicht', 401)
    }
    setSessionCookie(reply, request)
    await audit({ actor: 'ui:joel', action: 'auth.login', result: 'ok' })
    return { ok: true }
  })

  app.post('/auth/logout', async (request, reply) => {
    clearSessionCookie(reply)
    // UI-Qualität 3: Ereignisströme *dieser* Sitzung schliessen (andere Geräte bleiben angemeldet)
    publish({ type: 'session_ended', issued: sessionStart(request) })
    return { ok: true }
  })

  app.get('/auth/me', async (request) => {
    if (!isLoggedIn(request)) return { loggedIn: false }
    const pw = await passwordInfo()
    const start = sessionStart(request)
    const prefs = await getUiPrefs()
    return {
      loggedIn: true,
      name: config.ADMIN_NAME || 'Admin',
      sessionSince: isoOrNull(start),
      viaHttps: viaHttps(request),
      passwordChangedAt: pw.changedAt,
      passwordSource: pw.source,
      theme: prefs.theme,
      unlocks: prefs.unlocks ?? [],
      setup: prefs.setup ?? null,
      bellSeenAt: prefs.bellSeenAt ?? null,
      lastEnvironment: prefs.lastEnvironment ?? null,
    }
  })

  // Darstellung (Hell/Dunkel/System) – nur mit Anmeldung (Wächter: /auth/* nie mit Token)
  app.put('/auth/preferences', async (request) => setUiPrefs(request.body, request.actor))

  // Freischaltung (Easter Egg, z. B. «Windows 95»): { id } hinzufügen, idempotent; nur mit Anmeldung
  app.post('/auth/unlocks', async (request) => unlockUi(request.body, request.actor))

  // Nur mit Anmeldung (Wächter), nie mit API-Token.
  app.post('/auth/password', async (request, reply) => {
    const { current, next } = passwordChangeSchema.parse(request.body)
    try {
      await changePassword(current, next)
    } catch (err) {
      await audit({ actor: request.actor, action: 'auth.password', result: 'error', error: (err as Error).message })
      throw err
    }
    // Alle Sitzungen sind jetzt ungültig – diese bekommt ein neues Cookie.
    setSessionCookie(reply, request)
    await audit({ actor: request.actor, action: 'auth.password', result: 'ok' })
    return { ok: true }
  })
}
