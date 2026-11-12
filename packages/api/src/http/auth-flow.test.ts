import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

/**
 * Nacht 3, Etappe 1 über HTTP: die echte App (buildApp) mit dem Anmelde-Dienst
 * im Arbeitsspeicher. Prüft Cookies, zweiten Schritt, Sitzungen, die
 * erneute Bestätigung an den echten Routen (serverseitig, nicht nur in der
 * Oberfläche) und die Absenderadresse hinter Caddy.
 */
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
process.env.SESSION_SECRET = 'test-geheimnis-test-geheimnis-123' // allowlist-secret (Testwert)
process.env.NODE_ENV = 'test'

const { buildApp, registeredRoutes } = await import('./app.js')
const { setAuthService, setTrustedPeers, SUDO_ROUTES, OPEN_ROUTES } = await import('./auth.js')
const { AuthService } = await import('../auth/service.js')
const { MemoryAuthStore } = await import('../auth/store.js')
const { totpAt } = await import('../auth/totp.js')

const PW = 'richtig-richtig'
let app: FastifyInstance
let store: InstanceType<typeof MemoryAuthStore>
let svc: InstanceType<typeof AuthService>
let now = Date.UTC(2026, 10, 12, 20, 0, 0)
const audits: { action: string; actor: string; params?: unknown }[] = []

function fresh() {
  store = new MemoryAuthStore(`h:${PW}`)
  const key = randomBytes(32)
  svc = new AuthService({
    store, key: () => key, audit: async (e) => { audits.push(e) },
    verifyPassword: (p, h) => h === `h:${p}`, dummyHash: 'h:\0',
    now: () => now, sleep: async () => {}, lanCidr: () => '192.168.1.0/24',
  })
  setAuthService(svc)
}

before(async () => {
  fresh()
  // Caddy (127.0.0.1 bei inject) ist vertraut: X-Forwarded-For gilt
  setTrustedPeers(['127.0.0.1'])
  app = await buildApp()
  await app.ready()
})
after(async () => {
  await app.close()
  setAuthService(null)
  setTrustedPeers(null)
})

const cookieOf = (r: LightMyRequestResponse, name: string): string | null => {
  const c = r.cookies.find((x) => x.name === name)
  return c ? `${name}=${c.value}` : null
}

async function loginCookie(ip = '192.168.1.20'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: PW }, headers: { 'x-forwarded-for': ip } })
  assert.equal(r.statusCode, 200, r.body)
  return cookieOf(r, 'airlock_session')!
}

const routeUrl = (pattern: string) => pattern.replace(':id', '0b8f3b0e-6c1a-4e5b-9a7d-2f4c1e9d8a77').replace(':env', 'privat')

describe('Anmeldung über HTTP', () => {
  test('ohne Anmeldung 401; /auth/me sagt, was die Anmeldeseite anbieten kann', async () => {
    fresh()
    assert.equal((await app.inject({ url: '/api/v1/auth/security' })).statusCode, 401)
    const me = (await app.inject({ url: '/api/v1/auth/me' })).json()
    assert.equal(me.loggedIn, false)
    assert.equal(me.login.passkeys, false)
    assert.equal(me.login.passkeyHost.available, false)
  })

  test('Passwort → Sitzungs-Cookie (httpOnly, signiert); Abmelden beendet die Sitzung', async () => {
    fresh()
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: PW } })
    assert.deepEqual(r.json(), { ok: true })
    const c = r.cookies.find((x) => x.name === 'airlock_session')!
    assert.equal(c.httpOnly, true)
    assert.equal(c.sameSite, 'Lax')
    const cookie = `airlock_session=${c.value}`
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie } })).statusCode, 401)
  })

  test('altes Cookie (Anmeldezeit, vor dem Update) gilt nicht mehr', async () => {
    fresh()
    const signed = app.signCookie(String(Date.now()))
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: `airlock_session=${signed}` } })).statusCode, 401)
  })

  test('mit TOTP: zweiter Schritt über ein kurzes Cookie; Fehlversuche mit echter Adresse im Audit', async () => {
    fresh()
    const cookie = await loginCookie()
    const other = await loginCookie('192.168.1.30')
    // TOTP direkt über den Dienst einrichten (in der ersten Sitzung)
    const s = (await store.listSessions())[0]!
    await svc.confirmSudo(s, { password: PW }, { ip: 'x', userAgent: null })
    const setup = await svc.totpSetup(s, null)
    const secret = setup.secret.replace(/ /g, '')
    await svc.totpEnable(s, totpAt(secret, now), null)
    now += 30_000

    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: PW }, headers: { 'x-forwarded-for': '100.64.0.9' } })
    const body = first.json()
    assert.equal(body.ok, false)
    assert.deepEqual(body.secondFactor, { totp: true, recovery: true, passkey: false })
    assert.equal(cookieOf(first, 'airlock_session'), null, 'noch keine Sitzung')
    const pending = cookieOf(first, 'airlock_login')!
    assert.ok(pending)

    audits.length = 0
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login/second-factor', payload: { code: '000000' }, headers: { cookie: pending, 'x-forwarded-for': '100.64.0.9' } })
    assert.equal(wrong.statusCode, 401)
    assert.equal(wrong.json().error.code, 'invalid_code')
    assert.deepEqual(audits[0], { actor: 'ip:100.64.0.9', action: 'auth.login', result: 'error', error: 'falscher Code (Authenticator)', params: { reason: 'totp', ip: '100.64.0.9' }, environmentId: null })

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login/second-factor', payload: { code: totpAt(secret, now) }, headers: { cookie: pending, 'x-forwarded-for': '100.64.0.9' } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.ok(cookieOf(ok, 'airlock_session'))
    // Beim Einschalten von TOTP: das andere Gerät abgemeldet, die eigene Sitzung blieb
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: other } })).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie } })).statusCode, 200)
  })

  test('Sperre nach 5 Fehlversuchen: 429 mit Wartezeit, je echter Adresse', async () => {
    fresh()
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'falsch' }, headers: { 'x-forwarded-for': '192.168.1.66' } })
      assert.equal(r.statusCode, 401)
    }
    const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: PW }, headers: { 'x-forwarded-for': '192.168.1.66' } })
    assert.equal(locked.statusCode, 429)
    assert.equal(locked.json().error.details.retryAfterS, 900)
    assert.match(locked.json().error.message, /15 Min/)
  })
})

describe('Erneute Bestätigung an den echten Routen (serverseitig)', () => {
  test('jede Route der Liste gibt es wirklich', () => {
    const known = new Set(registeredRoutes.map((r) => `${r.method} ${r.url}`))
    for (const r of SUDO_ROUTES) assert.ok(known.has(r), `Route fehlt: ${r}`)
    for (const r of OPEN_ROUTES) assert.ok([...known].some((k) => k.endsWith(` ${r}`)), `offene Route fehlt: ${r}`)
  })

  test('ohne Bestätigung 403 sudo_required; danach weiter zum Handler; nach 10 Min. wieder 403', async () => {
    fresh()
    const cookie = await loginCookie()
    // (PUT /projects/:id/routes mit «public» prüft der Handler selbst, nach der Umgebungsprüfung –
    // die braucht die Datenbank und fehlt deshalb hier)
    const urls = SUDO_ROUTES.map((r) => { const [method, url] = r.split(' '); return { method: method!, url: routeUrl(url!) } })
    for (const { method, url } of urls) {
      const r = await app.inject({ method: method as 'POST', url, headers: { cookie }, payload: {} })
      assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`)
      assert.equal(r.json().error.code, 'sudo_required', `${method} ${url}`)
    }
    // Falsches Passwort: keine Bestätigung
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/sudo', headers: { cookie }, payload: { password: 'falsch' } })
    assert.equal(bad.statusCode, 401)
    const sudo = await app.inject({ method: 'POST', url: '/api/v1/auth/sudo', headers: { cookie }, payload: { password: PW } })
    assert.equal(sudo.statusCode, 200, sudo.body)
    assert.equal(new Date(sudo.json().until).getTime() - now, 10 * 60_000)
    for (const { method, url } of urls) {
      const r = await app.inject({ method: method as 'POST', url, headers: { cookie }, payload: {} })
      // Weiter zum Handler (hier ohne Datenbank: Fehler dort, aber nicht mehr die Bestätigung)
      assert.notEqual(r.json().error?.code, 'sudo_required', `${method} ${url}`)
    }
    now += 10 * 60_000
    const again = await app.inject({ method: 'DELETE', url: routeUrl('/api/v1/projects/:id'), headers: { cookie } })
    assert.equal(again.json().error.code, 'sudo_required')
  })

  test('2FA-Änderungen verlangen die Bestätigung', async () => {
    fresh()
    const cookie = await loginCookie()
    for (const [method, url, payload] of [
      ['POST', '/api/v1/auth/totp/setup', {}],
      ['DELETE', '/api/v1/auth/totp', undefined],
      ['PUT', '/api/v1/auth/2fa-required', { required: false }],
      ['DELETE', `/api/v1/auth/passkeys/${randomBytes(4).toString('hex')}`, undefined],
    ] as const) {
      const r = await app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) })
      assert.equal(r.json().error?.code, 'sudo_required', `${method} ${url}: ${r.body}`)
    }
  })
})

describe('Sitzungen über HTTP', () => {
  test('Liste, einzeln abmelden, alle anderen abmelden', async () => {
    fresh()
    const a = await loginCookie('192.168.1.20')
    const b = await loginCookie('100.64.0.4')
    const c = await loginCookie('192.168.1.21')
    const list = (await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: a } })).json().sessions
    assert.equal(list.length, 3)
    assert.equal(list[0].current, true)
    const tail = list.find((s: { access: string }) => s.access === 'tailnet')
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${tail.id}`, headers: { cookie: a } })
    assert.deepEqual(del.json(), { ok: true, self: false })
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: b } })).statusCode, 401)
    const others = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions/revoke-others', headers: { cookie: a } })
    assert.deepEqual(others.json(), { revoked: 1 })
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: c } })).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: a } })).statusCode, 200)
  })

  test('Passkey-Routen ausserhalb der Hauptadresse: klare Meldung statt Fehler', async () => {
    fresh()
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/login/options', headers: { host: 'deployer.100-64-0-1.nip.io' } })
    assert.equal(r.statusCode, 400)
    assert.equal(r.json().error.code, 'passkey_unavailable')
  })
})
