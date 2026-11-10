import type { FastifyInstance } from 'fastify'
import { loginSchema } from '@deployer/shared'
import { passwordChangeSchema } from '@deployer/shared'
import { login, setSessionCookie, clearSessionCookie, isLoggedIn, changePassword, passwordInfo, sessionStart, viaHttps } from '../auth.js'
import { config } from '../../config.js'
import { audit } from '../../domain/audit.js'
import { AppError } from '../../lib/errors.js'
import { getUiPrefs, setUiPrefs } from '../../domain/ui-prefs.js'

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

  app.post('/auth/logout', async (_request, reply) => {
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/auth/me', async (request) => {
    if (!isLoggedIn(request)) return { loggedIn: false }
    const pw = await passwordInfo()
    const start = sessionStart(request)
    return {
      loggedIn: true,
      name: config.ADMIN_NAME || 'Admin',
      sessionSince: start ? new Date(start).toISOString() : null,
      viaHttps: viaHttps(request),
      passwordChangedAt: pw.changedAt,
      passwordSource: pw.source,
      theme: (await getUiPrefs()).theme,
    }
  })

  // Darstellung (Hell/Dunkel/System) – nur mit Anmeldung (Wächter: /auth/* nie mit Token)
  app.put('/auth/preferences', async (request) => setUiPrefs(request.body, request.actor))

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
