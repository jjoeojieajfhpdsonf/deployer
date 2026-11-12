import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  loginSchema, passwordChangeSchema, secondFactorSchema, sudoSchema, passkeyNameSchema, totpEnableSchema, requiredSchema,
  type LoginResultDto,
} from '@airlock/shared'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import {
  auth, setSessionCookie, clearSessionCookie, changePassword, passwordInfo, viaHttps, clientInfo, passkeyHost,
  requirePasskeyHost, setShortCookie, clearShortCookie, signedCookie, currentSession, sessionOf,
  PENDING_COOKIE, CHALLENGE_COOKIE,
} from '../auth.js'
import { config } from '../../config.js'
import { audit } from '../../domain/audit.js'
import { AppError } from '../../lib/errors.js'
import { publish } from '../../lib/events.js'
import { getUiPrefs, setUiPrefs, unlockUi } from '../../domain/ui-prefs.js'
import { markAchievementsSeen, syncAchievements } from '../../domain/achievements.js'

/** Antwort des Browsers (WebAuthn) – geprüft wird sie in @simplewebauthn/server */
const credentialSchema = z.object({ id: z.string().min(1).max(2048), rawId: z.string(), type: z.literal('public-key'), response: z.record(z.unknown()) }).passthrough()
const passkeyLoginSchema = z.object({ response: credentialSchema })
const passkeyRegisterSchema = passkeyNameSchema.extend({ response: credentialSchema })

/** Andere Sitzungen beenden: ihre Ereignisströme schliessen (die eigene bleibt) */
const endOthers = (request: FastifyRequest) => publish({ type: 'session_ended', except: request.authSession?.id ?? null })

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* --- Anmelden ------------------------------------------------------------- */

  app.post('/auth/login', async (request, reply): Promise<LoginResultDto> => {
    const { password } = loginSchema.parse(request.body)
    const host = passkeyHost(request)
    const out = await auth().passwordLogin(password, clientInfo(request), host.rp)
    if (out.kind === 'second') {
      setShortCookie(reply, request, PENDING_COOKIE, out.pendingId)
      return { ok: false, secondFactor: out.factors, passkeyHost: host.dto }
    }
    setSessionCookie(reply, request, out.token)
    return { ok: true }
  })

  app.post('/auth/login/second-factor', async (request, reply): Promise<LoginResultDto> => {
    const input = secondFactorSchema.parse(request.body)
    const out = await auth().secondFactor(signedCookie(request, PENDING_COOKIE), input, clientInfo(request))
    if (out.kind !== 'session') throw new AppError('second_factor_expired', 'Die Anmeldung ist abgelaufen', 401)
    clearShortCookie(reply, PENDING_COOKIE)
    setSessionCookie(reply, request, out.token)
    return { ok: true, ...(out.recoveryRemaining !== undefined ? { recoveryRemaining: out.recoveryRemaining } : {}) }
  })

  app.post('/auth/passkey/login/options', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { challengeId, options } = await auth().passkeyLoginOptions(rp)
    setShortCookie(reply, request, CHALLENGE_COOKIE, challengeId)
    return { options }
  })

  app.post('/auth/passkey/login', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { response } = passkeyLoginSchema.parse(request.body)
    const challengeId = signedCookie(request, CHALLENGE_COOKIE)
    clearShortCookie(reply, CHALLENGE_COOKIE)
    const out = await auth().passkeyLogin(challengeId, response as unknown as AuthenticationResponseJSON, clientInfo(request), rp)
    if (out.kind !== 'session') throw new AppError('passkey_failed', 'Anmeldung fehlgeschlagen', 401)
    setSessionCookie(reply, request, out.token)
    return { ok: true }
  })

  app.post('/auth/logout', async (request, reply) => {
    const s = request.authSession
    if (s) await auth().logout(s)
    clearSessionCookie(reply)
    // UI-Qualität 3: Ereignisströme *dieser* Sitzung schliessen (andere Geräte bleiben angemeldet)
    publish({ type: 'session_ended', session: s?.id ?? null })
    return { ok: true }
  })

  app.get('/auth/me', async (request) => {
    const session = await currentSession(request)
    if (!session) {
      // Für die Anmeldeseite: Passkey hier möglich? Ist einer eingerichtet?
      const host = passkeyHost(request)
      return { loggedIn: false, login: { passkeyHost: host.dto, passkeys: await auth().hasPasskeysFor(host.dto.rpId) } }
    }
    const pw = await passwordInfo()
    const prefs = await getUiPrefs()
    return {
      loggedIn: true,
      name: config.ADMIN_NAME || 'Admin',
      sessionSince: session.createdAt.toISOString(),
      loginMethod: session.method,
      viaHttps: viaHttps(request),
      passwordChangedAt: pw.changedAt,
      passwordSource: pw.source,
      theme: prefs.theme,
      unlocks: prefs.unlocks ?? [],
      setup: prefs.setup ?? null,
      bellSeenAt: prefs.bellSeenAt ?? null,
      lastEnvironment: prefs.lastEnvironment ?? null,
      // Etappe 7: Spass-Funktionen (Standard an), Matrix-Regen (Standard aus), Disketti (Standard an)
      fun: prefs.fun !== false,
      matrix: prefs.matrix === true,
      disketti: prefs.disketti !== false,
      // Besucher neu: Kurve als Fläche (Standard) oder Säulen
      trafficChart: prefs.trafficChart ?? 'area',
    }
  })

  /* --- Konto › Sicherheit (nur mit Anmeldung; der Wächter weist Tokens ab) ----- */

  app.get('/auth/security', async (request) => ({ security: await auth().security(sessionOf(request), passkeyHost(request).dto) }))

  app.get('/auth/sudo', async (request) => ({ sudo: await auth().sudoStatus(sessionOf(request), passkeyHost(request).rp) }))

  app.post('/auth/sudo', async (request) => {
    const input = sudoSchema.parse(request.body)
    return { until: await auth().confirmSudo(sessionOf(request), input, clientInfo(request)) }
  })

  app.post('/auth/sudo/passkey/options', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { challengeId, options } = await auth().sudoPasskeyOptions(sessionOf(request), rp)
    setShortCookie(reply, request, CHALLENGE_COOKIE, challengeId)
    return { options }
  })

  app.post('/auth/sudo/passkey', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { response } = passkeyLoginSchema.parse(request.body)
    const challengeId = signedCookie(request, CHALLENGE_COOKIE)
    clearShortCookie(reply, CHALLENGE_COOKIE)
    return { until: await auth().confirmSudoPasskey(sessionOf(request), challengeId, response as unknown as AuthenticationResponseJSON, clientInfo(request), rp) }
  })

  app.post('/auth/totp/setup', async (request) => ({ setup: await auth().totpSetup(sessionOf(request), passkeyHost(request).host) }))

  app.post('/auth/totp/enable', async (request) => {
    const { code } = totpEnableSchema.parse(request.body)
    const r = await auth().totpEnable(sessionOf(request), code, passkeyHost(request).host)
    endOthers(request)
    return r
  })

  app.delete('/auth/totp', async (request) => {
    const r = await auth().totpDisable(sessionOf(request))
    endOthers(request)
    return r
  })

  app.post('/auth/recovery-codes', async (request) => {
    const r = await auth().regenerateRecovery(sessionOf(request), passkeyHost(request).host)
    endOthers(request)
    return r
  })

  app.put('/auth/2fa-required', async (request) => {
    const { required } = requiredSchema.parse(request.body)
    const r = await auth().setRequired(sessionOf(request), required)
    endOthers(request)
    return r
  })

  app.post('/auth/passkeys/options', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { challengeId, options } = await auth().passkeyRegisterOptions(sessionOf(request), rp)
    setShortCookie(reply, request, CHALLENGE_COOKIE, challengeId)
    return { options }
  })

  app.post('/auth/passkeys', async (request, reply) => {
    const rp = requirePasskeyHost(request)
    const { name, response } = passkeyRegisterSchema.parse(request.body)
    const challengeId = signedCookie(request, CHALLENGE_COOKIE)
    clearShortCookie(reply, CHALLENGE_COOKIE)
    const r = await auth().passkeyRegister(sessionOf(request), challengeId, name, response as unknown as RegistrationResponseJSON, rp, passkeyHost(request).host)
    endOthers(request)
    reply.code(201)
    return r
  })

  app.delete<{ Params: { id: string } }>('/auth/passkeys/:id', async (request) => {
    const r = await auth().deletePasskey(sessionOf(request), request.params.id)
    endOthers(request)
    return r
  })

  app.get('/auth/sessions', async (request) => ({ sessions: await auth().listSessions(sessionOf(request)) }))

  app.delete<{ Params: { id: string } }>('/auth/sessions/:id', async (request, reply) => {
    const { self } = await auth().revokeSession(sessionOf(request), request.params.id)
    publish({ type: 'session_ended', session: request.params.id })
    if (self) clearSessionCookie(reply)
    return { ok: true, self }
  })

  app.post('/auth/sessions/revoke-others', async (request) => {
    const revoked = await auth().revokeOthers(sessionOf(request), 'manual')
    endOthers(request)
    return { revoked }
  })

  /* --- Übriges Konto ----------------------------------------------------------- */

  // Etappe 7: Achievements (prüft die Regeln über die echten Daten, trägt Neues ein)
  app.get('/auth/achievements', async () => syncAchievements())
  // Gemeldet (Konfetti gezeigt): nicht noch einmal
  app.post('/auth/achievements/seen', async (request) => markAchievementsSeen(request.body))

  // Darstellung (Hell/Dunkel/System) – nur mit Anmeldung (Wächter: /auth/* nie mit Token)
  app.put('/auth/preferences', async (request) => setUiPrefs(request.body, request.actor))

  // Freischaltung (Easter Egg, z. B. «Windows 95»): { id } hinzufügen, idempotent; nur mit Anmeldung
  app.post('/auth/unlocks', async (request) => unlockUi(request.body, request.actor))

  // Nur mit Anmeldung (Wächter), nie mit API-Token. Andere Sitzungen werden abgemeldet, diese bleibt.
  app.post('/auth/password', async (request) => {
    const { current, next } = passwordChangeSchema.parse(request.body)
    try {
      await changePassword(current, next, sessionOf(request))
    } catch (err) {
      await audit({ actor: request.actor, action: 'auth.password', result: 'error', error: (err as Error).message })
      throw err
    }
    endOthers(request)
    await audit({ actor: request.actor, action: 'auth.password', result: 'ok' })
    return { ok: true }
  })
}
