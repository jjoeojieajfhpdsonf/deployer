import type { FastifyInstance } from 'fastify'
import { loginSchema } from '@deployer/shared'
import { login, setSessionCookie, clearSessionCookie, isLoggedIn } from '../auth.js'
import { audit } from '../../domain/audit.js'
import { AppError } from '../../lib/errors.js'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const { password } = loginSchema.parse(request.body)
    const ip = request.ip
    const ok = await login(ip, password)
    if (!ok) {
      await audit({ actor: `ip:${ip}`, action: 'auth.login', result: 'error', error: 'falsches Passwort' })
      throw new AppError('invalid_credentials', 'Passwort stimmt nicht', 401)
    }
    setSessionCookie(reply)
    await audit({ actor: 'ui:joel', action: 'auth.login', result: 'ok' })
    return { ok: true }
  })

  app.post('/auth/logout', async (_request, reply) => {
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/auth/me', async (request) => ({ loggedIn: isLoggedIn(request) }))
}
