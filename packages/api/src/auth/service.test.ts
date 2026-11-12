import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { AuthService, LOGIN_FLOOR_MS, PENDING_MS, type ClientInfo, type LoginOutcome } from './service.js'
import { MemoryAuthStore, type SessionRow } from './store.js'
import { totpAt } from './totp.js'
import { SoftAuthenticator } from './webauthn-fixture.js'
import type { AuditInput } from '../domain/audit.js'
import { AppError } from '../lib/errors.js'

/**
 * Anmeldung, zweiter Faktor, Sitzungen und erneute Bestätigung – mit Speicher
 * im Arbeitsspeicher, fester Uhr und Warten ohne Warten. Passkeys mit einem
 * Authenticator in Software (webauthn-fixture.ts) durch @simplewebauthn/server.
 */

const PW = 'richtig-richtig'
const HOST = 'deployer.int.example.ch'
const RP = { rpID: HOST, origin: `https://${HOST}` }
const MAC: ClientInfo = { ip: '192.168.1.20', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }
const PHONE: ClientInfo = { ip: '100.101.1.2', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }

function setup() {
  let now = Date.UTC(2026, 10, 12, 20, 0, 0)
  const sleeps: number[] = []
  const audits: AuditInput[] = []
  const store = new MemoryAuthStore(`h:${PW}`)
  const key = randomBytes(32)
  const svc = new AuthService({
    store, key: () => key,
    audit: async (e) => { audits.push(e) },
    verifyPassword: (pw, h) => h === `h:${pw}`,
    dummyHash: 'h:\0',
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms) },
    lanCidr: () => '192.168.1.0/24',
    accountName: () => 'Joël',
  })
  return { svc, store, key, audits, sleeps, now: () => now, tick: (ms: number) => { now += ms } }
}
type T = ReturnType<typeof setup>

function sessionOf(o: LoginOutcome): SessionRow & { token: string } {
  assert.equal(o.kind, 'session')
  if (o.kind !== 'session') throw new Error('keine Sitzung')
  return Object.assign(o.session, { token: o.token })
}

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof AppError, String(e))
    assert.equal(e.code, code, e.message)
    if (status) assert.equal(e.status, status)
    return e
  }
  assert.fail(`erwartet: ${code}`)
}

async function login(t: T, client = MAC) {
  return sessionOf(await t.svc.passwordLogin(PW, client, RP))
}

async function enableTotp(t: T, s: SessionRow) {
  await t.svc.confirmSudo(s, { password: PW }, MAC)
  const setup = await t.svc.totpSetup(s, HOST)
  const secret = setup.secret.replace(/ /g, '')
  const r = await t.svc.totpEnable(s, totpAt(secret, t.now()), HOST)
  return { secret, recovery: r.recovery!, setup }
}

describe('Anmeldung mit Passwort', () => {
  test('ohne zweiten Faktor: Sitzung, Cookie-Wert steht nicht im Speicher', async () => {
    const t = setup()
    const s = await login(t)
    assert.equal(s.method, 'password')
    const row = [...t.store.sessions.values()][0]!
    assert.notEqual(row.tokenHash, s.token)
    assert.equal(row.tokenHash.length, 64)
    assert.equal((await t.svc.resolveSession(s.token, MAC.ip))?.id, s.id)
    assert.equal(await t.svc.resolveSession('falsch', MAC.ip), null)
    assert.ok(t.audits.some((a) => a.action === 'auth.login' && a.result === 'ok'))
  })

  test('Sitzung läuft nach 7 Tagen ab; abgemeldet ist ungültig', async () => {
    const t = setup()
    const s = await login(t)
    t.tick(7 * 24 * 3600_000 - 1)
    assert.ok(await t.svc.resolveSession(s.token, null))
    t.tick(1)
    assert.equal(await t.svc.resolveSession(s.token, null), null)
    const s2 = await login(t)
    await t.svc.logout(s2)
    assert.equal(await t.svc.resolveSession(s2.token, null), null)
  })

  test('gleiche Antwortzeit: richtig, falsch und gesperrt warten auf dieselbe Mindestdauer', async () => {
    const t = setup()
    await login(t)
    await rejects(t.svc.passwordLogin('falsch', MAC, RP), 'invalid_credentials', 401)
    t.store.passwordHash = null // auch ohne gespeichertes Passwort (gerechnet wird gegen einen Ersatz-Hash)
    await rejects(t.svc.passwordLogin(PW, MAC, RP), 'invalid_credentials', 401)
    assert.deepEqual(t.sleeps, [LOGIN_FLOOR_MS, LOGIN_FLOOR_MS, LOGIN_FLOOR_MS])
  })

  test('5 Fehlversuche je Adresse → 15 Min. Sperre (429), auch mit richtigem Passwort; Audit', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', MAC, RP), 'invalid_credentials')
    const e = await rejects(t.svc.passwordLogin(PW, MAC, RP), 'too_many_attempts', 429)
    assert.deepEqual(e.details, { retryAfterS: 15 * 60 })
    assert.equal(t.audits.filter((a) => a.action === 'auth.login' && a.result === 'error').length, 6)
    const lock = t.audits.filter((a) => a.action === 'auth.lockout')
    assert.deepEqual(lock.map((a) => (a.params as { scope: string }).scope).sort(), ['ip', 'user'])
    assert.equal((t.audits[0]!.params as { reason: string }).reason, 'password')
    t.tick(15 * 60_000)
    await login(t)
  })

  test('pro Konto: Fehlversuche von verschiedenen Adressen sperren das Passwort', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', { ip: `192.168.1.${50 + i}`, userAgent: null }, RP), 'invalid_credentials')
    await rejects(t.svc.passwordLogin(PW, PHONE, RP), 'too_many_attempts', 429)
  })

  test('zweite Sperre dauert doppelt so lang (exponentiell)', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', MAC, RP), 'invalid_credentials')
    t.tick(15 * 60_000)
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', MAC, RP), 'invalid_credentials')
    const e = await rejects(t.svc.passwordLogin(PW, MAC, RP), 'too_many_attempts')
    assert.deepEqual(e.details, { retryAfterS: 30 * 60 })
  })
})

describe('Authenticator-App (TOTP)', () => {
  test('Einrichten verlangt die erneute Bestätigung', async () => {
    const t = setup()
    const s = await login(t)
    await rejects(t.svc.totpSetup(s, HOST), 'sudo_required', 403)
  })

  test('aktiv erst nach einem richtigen Code; QR-Code und Geheimnis', async () => {
    const t = setup()
    const s = await login(t)
    await t.svc.confirmSudo(s, { password: PW }, MAC)
    const setup1 = await t.svc.totpSetup(s, HOST)
    assert.match(setup1.uri, /^otpauth:\/\/totp\/Airlock%3AJo%C3%ABl%20\(deployer\.int\.example\.ch\)\?secret=/)
    assert.ok(setup1.qr.length >= 21 && setup1.qr.every((r) => /^[01]+$/.test(r)))
    assert.equal((await t.store.getTotp()).enabledAt, null, 'noch nicht aktiv')
    await rejects(t.svc.totpEnable(s, '000000', HOST), 'invalid_code')
    assert.equal((await t.store.getTotp()).enabledAt, null)
    // Geheimnis nur verschlüsselt gespeichert
    assert.ok(!(await t.store.getTotp()).pendingEnc!.toString('latin1').includes(setup1.secret.replace(/ /g, '')))
  })

  test('nach dem Einrichten: Passwort allein reicht nicht; Code ±1 Fenster; jeder Code nur einmal', async () => {
    const t = setup()
    const s = await login(t)
    const { secret, recovery } = await enableTotp(t, s)
    assert.equal(recovery.codes.length, 10, 'beim ersten Faktor 10 Wiederherstellungscodes')

    const first = await t.svc.passwordLogin(PW, PHONE, RP)
    assert.equal(first.kind, 'second')
    if (first.kind !== 'second') return
    assert.deepEqual(first.factors, { totp: true, recovery: true, passkey: false })

    // Derselbe Code wie beim Einrichten (gleiches Zeitfenster): schon benutzt
    await rejects(t.svc.secondFactor(first.pendingId, { code: totpAt(secret, t.now()) }, PHONE), 'invalid_code', 401)
    // 60 s alt: ausserhalb des Fensters
    t.tick(30_000)
    await rejects(t.svc.secondFactor(first.pendingId, { code: totpAt(secret, t.now() - 60_000) }, PHONE), 'invalid_code')
    // 30 s nachgehende Uhr des Telefons: gilt
    t.tick(30_000)
    const code = totpAt(secret, t.now() - 30_000)
    const ok = sessionOf(await t.svc.secondFactor(first.pendingId, { code }, PHONE))
    assert.equal(ok.method, 'password_totp')

    // Derselbe Code ein zweites Mal: abgelehnt
    const again = await t.svc.passwordLogin(PW, PHONE, RP)
    if (again.kind !== 'second') return assert.fail()
    await rejects(t.svc.secondFactor(again.pendingId, { code }, PHONE), 'invalid_code')
  })

  test('der zweite Schritt läuft nach 5 Min. ab und nach 5 falschen Codes', async () => {
    const t = setup()
    const s = await login(t)
    await enableTotp(t, s)
    const a = await t.svc.passwordLogin(PW, PHONE, RP)
    if (a.kind !== 'second') return assert.fail()
    t.tick(PENDING_MS + 1)
    await rejects(t.svc.secondFactor(a.pendingId, { code: '123456' }, PHONE), 'second_factor_expired', 401)
    await rejects(t.svc.secondFactor(null, { code: '123456' }, PHONE), 'second_factor_expired', 401)

    const b = await t.svc.passwordLogin(PW, { ip: '192.168.1.77', userAgent: null }, RP)
    if (b.kind !== 'second') return assert.fail()
    for (let i = 0; i < 4; i++) await rejects(t.svc.secondFactor(b.pendingId, { code: '000000' }, { ip: '192.168.1.77', userAgent: null }), 'invalid_code')
    // 5. falscher Code: Sperre für die Adresse und angefangene Anmeldung verworfen
    await rejects(t.svc.secondFactor(b.pendingId, { code: '000000' }, { ip: '192.168.1.77', userAgent: null }), 'invalid_code')
    await rejects(t.svc.secondFactor(b.pendingId, { code: '000000' }, { ip: '192.168.1.77', userAgent: null }), 'second_factor_expired')
  })

  test('ausschalten: wieder nur Passwort, andere Sitzungen abgemeldet, Codes weg', async () => {
    const t = setup()
    const s = await login(t)
    const other = await login(t, PHONE)
    await enableTotp(t, s)
    assert.equal(await t.svc.resolveSession(other.token, null), null, 'Einschalten beendet andere Sitzungen')
    await t.svc.totpDisable(s)
    assert.equal((await t.store.recoveryStatus()).total, 0)
    assert.equal((await t.svc.passwordLogin(PW, PHONE, RP)).kind, 'session')
    assert.ok(await t.svc.resolveSession(s.token, null), 'die eigene Sitzung bleibt')
  })
})

describe('Wiederherstellungscodes', () => {
  test('10 Codes, nur gehasht gespeichert, jeder genau einmal', async () => {
    const t = setup()
    const s = await login(t)
    const { recovery } = await enableTotp(t, s)
    assert.equal(new Set(recovery.codes).size, 10)
    for (const c of recovery.codes) assert.match(c, /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/)
    const stored = JSON.stringify(t.store.recovery)
    for (const c of recovery.codes) {
      assert.ok(!stored.includes(c) && !stored.includes(c.replace(/-/g, '')), 'Klartext im Speicher')
    }
    assert.match(recovery.text, /Wiederherstellungscodes/)
    assert.match(recovery.text, new RegExp(recovery.codes[0]!))

    const a = await t.svc.passwordLogin(PW, PHONE, RP)
    if (a.kind !== 'second') return assert.fail()
    // Gross geschrieben, ohne Bindestriche: gilt trotzdem
    const used = recovery.codes[3]!
    const r = await t.svc.secondFactor(a.pendingId, { recoveryCode: used.replace(/-/g, '').toUpperCase() }, PHONE)
    assert.equal(sessionOf(r).method, 'password_recovery')
    assert.equal(r.kind === 'session' && r.recoveryRemaining, 9)

    const b = await t.svc.passwordLogin(PW, PHONE, RP)
    if (b.kind !== 'second') return assert.fail()
    await rejects(t.svc.secondFactor(b.pendingId, { recoveryCode: used }, PHONE), 'invalid_code')
  })

  test('neu erzeugen macht die alten ungültig (mit Bestätigung)', async () => {
    const t = setup()
    const s = await login(t)
    const { recovery } = await enableTotp(t, s)
    const fresh = await t.svc.regenerateRecovery(s, HOST)
    assert.equal(fresh.recovery.codes.length, 10)
    const a = await t.svc.passwordLogin(PW, PHONE, RP)
    if (a.kind !== 'second') return assert.fail()
    await rejects(t.svc.secondFactor(a.pendingId, { recoveryCode: recovery.codes[0]! }, PHONE), 'invalid_code')
    assert.equal(sessionOf(await t.svc.secondFactor(a.pendingId, { recoveryCode: fresh.recovery.codes[0]! }, PHONE)).method, 'password_recovery')
  })
})

describe('«Zweiter Faktor erforderlich»', () => {
  test('ohne Faktor nicht einschaltbar (nie aussperren); aus = Passwort allein', async () => {
    const t = setup()
    const s = await login(t)
    await t.svc.confirmSudo(s, { password: PW }, MAC)
    await rejects(t.svc.setRequired(s, true), 'no_factor', 400)
    assert.equal(await t.svc.isRequired(), false)
    await enableTotp(t, s)
    assert.equal(await t.svc.isRequired(), true, 'Standard an, sobald ein Faktor da ist')
    await t.svc.setRequired(s, false)
    assert.equal((await t.svc.passwordLogin(PW, PHONE, RP)).kind, 'session')
    await t.svc.setRequired(s, true)
    assert.equal((await t.svc.passwordLogin(PW, PHONE, RP)).kind, 'second')
  })
})

describe('Erneute Bestätigung (sudo)', () => {
  test('10 Minuten gültig, dann wieder nötig', async () => {
    const t = setup()
    const s = await login(t)
    assert.throws(() => t.svc.requireSudo(s), (e: AppError) => e.code === 'sudo_required' && e.status === 403)
    const until = await t.svc.confirmSudo(s, { password: PW }, MAC)
    assert.equal(new Date(until).getTime() - t.now(), 10 * 60_000)
    t.svc.requireSudo(s)
    t.tick(10 * 60_000 - 1)
    t.svc.requireSudo(s)
    t.tick(1)
    assert.throws(() => t.svc.requireSudo(s), /bestätige/)
    assert.ok(t.audits.some((a) => a.action === 'auth.sudo'))
  })

  test('falsches Passwort zählt als Fehlversuch; mit TOTP braucht es den Code', async () => {
    const t = setup()
    const s = await login(t)
    await rejects(t.svc.confirmSudo(s, { password: 'falsch' }, MAC), 'invalid_credentials', 401)
    const { secret } = await enableTotp(t, s)
    t.tick(11 * 60_000)
    await rejects(t.svc.confirmSudo(s, { password: PW }, MAC), 'second_factor_required', 400)
    t.tick(30_000)
    await t.svc.confirmSudo(s, { password: PW, code: totpAt(secret, t.now()) }, MAC)
    t.svc.requireSudo(s)
  })

  test('Status nennt, was nötig ist', async () => {
    const t = setup()
    const s = await login(t)
    assert.deepEqual((await t.svc.sudoStatus(s, RP)).needs, { password: true, passkey: false, totp: false, recovery: false })
    await enableTotp(t, s)
    const st = await t.svc.sudoStatus(s, RP)
    assert.deepEqual(st.needs, { password: true, passkey: false, totp: true, recovery: true })
    assert.ok(st.until)
  })
})

describe('Passkeys (simulierter Authenticator)', () => {
  async function addPasskey(t: T, s: SessionRow, name = 'MacBook', auth = new SoftAuthenticator(RP.origin, RP.rpID)) {
    if (!t.svc.sudoActive(s)) await t.svc.confirmSudo(s, { password: PW }, MAC)
    const { challengeId, options } = await t.svc.passkeyRegisterOptions(s, RP)
    assert.equal(options.rp.id, HOST)
    assert.equal(options.authenticatorSelection?.residentKey, 'required')
    const r = await t.svc.passkeyRegister(s, challengeId, name, auth.register(options), RP, HOST)
    return { ...r, auth }
  }

  test('einrichten (mit Namen) und ohne Passwort anmelden; zuletzt benutzt', async () => {
    const t = setup()
    const s = await login(t)
    const { passkey, recovery, auth } = await addPasskey(t, s)
    assert.equal(passkey.name, 'MacBook')
    assert.equal(passkey.lastUsedAt, null)
    assert.equal(recovery?.codes.length, 10, 'erster Faktor: Codes')

    const { challengeId, options } = await t.svc.passkeyLoginOptions(RP)
    assert.deepEqual(options.allowCredentials ?? [], [])
    const out = sessionOf(await t.svc.passkeyLogin(challengeId, auth.authenticate(options), PHONE, RP))
    assert.equal(out.method, 'passkey')
    const [pk] = await t.store.listPasskeys()
    assert.ok(pk!.lastUsedAt)
    assert.equal(pk!.counter, 1)
    assert.ok(t.audits.some((a) => a.action === 'auth.login' && a.result === 'ok' && (a.params as { method: string }).method === 'passkey'))
  })

  test('mehrere Passkeys; zweiter Passkey erzeugt keine neuen Codes', async () => {
    const t = setup()
    const s = await login(t)
    await addPasskey(t, s, 'MacBook')
    const second = await addPasskey(t, s, 'iPhone')
    assert.equal(second.recovery, null)
    assert.deepEqual((await t.store.listPasskeys()).map((p) => p.name), ['MacBook', 'iPhone'])
  })

  test('Herausforderung gilt nur einmal; falscher Origin, falsche Adresse und alter Zähler scheitern', async () => {
    const t = setup()
    const s = await login(t)
    const { auth } = await addPasskey(t, s)

    const o1 = await t.svc.passkeyLoginOptions(RP)
    const resp = auth.authenticate(o1.options)
    sessionOf(await t.svc.passkeyLogin(o1.challengeId, resp, MAC, RP))
    await rejects(t.svc.passkeyLogin(o1.challengeId, resp, MAC, RP), 'passkey_failed', 401)

    const o2 = await t.svc.passkeyLoginOptions(RP)
    await rejects(t.svc.passkeyLogin(o2.challengeId, auth.authenticate(o2.options, { origin: 'https://boese.int.example.ch' }), MAC, RP), 'passkey_failed')

    const o3 = await t.svc.passkeyLoginOptions(RP)
    await rejects(t.svc.passkeyLogin(o3.challengeId, auth.authenticate(o3.options, { counter: 1 }), MAC, RP), 'passkey_failed')

    // Gleiche Herausforderung, aber andere Adresse (nip.io): gilt nicht
    const o4 = await t.svc.passkeyLoginOptions(RP)
    await rejects(t.svc.passkeyLogin(o4.challengeId, auth.authenticate(o4.options), MAC, { rpID: 'deployer.100-64-1-1.nip.io', origin: 'https://deployer.100-64-1-1.nip.io' }), 'passkey_failed')
    // Fehlversuche mit Passkey sperren nicht
    assert.equal(t.svc.throttle.check('user:admin').locked, false)
  })

  test('Passkey-Anmeldung geht trotz Sperre nach falschen Passwörtern und hebt sie auf', async () => {
    const t = setup()
    const s = await login(t)
    const { auth } = await addPasskey(t, s)
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', MAC, RP), 'invalid_credentials')
    await rejects(t.svc.passwordLogin(PW, MAC, RP), 'too_many_attempts', 429)
    const o = await t.svc.passkeyLoginOptions(RP)
    sessionOf(await t.svc.passkeyLogin(o.challengeId, auth.authenticate(o.options), MAC, RP))
    assert.equal(t.svc.throttle.check('user:admin').locked, false)
  })

  test('mit Passkey ist der zweite Faktor Pflicht: Passwort allein → zweiter Schritt (nur Wiederherstellungscode)', async () => {
    const t = setup()
    const s = await login(t)
    await addPasskey(t, s)
    const r = await t.svc.passwordLogin(PW, PHONE, null)
    assert.equal(r.kind, 'second')
    if (r.kind === 'second') assert.deepEqual(r.factors, { totp: false, recovery: true, passkey: false })
  })

  test('erneute Bestätigung mit Passkey', async () => {
    const t = setup()
    const s = await login(t)
    const { auth } = await addPasskey(t, s)
    t.tick(11 * 60_000)
    const { challengeId, options } = await t.svc.sudoPasskeyOptions(s, RP)
    assert.equal(options.allowCredentials?.length, 1)
    await t.svc.confirmSudoPasskey(s, challengeId, auth.authenticate(options), MAC, RP)
    t.svc.requireSudo(s)
  })

  test('löschen nur mit Bestätigung; letzter Faktor weg → Codes weg, Passwort genügt', async () => {
    const t = setup()
    const s = await login(t)
    const { passkey, auth } = await addPasskey(t, s)
    t.tick(11 * 60_000)
    await rejects(t.svc.deletePasskey(s, passkey.id), 'sudo_required', 403)
    // Pflicht ist an (Passkey): das Passwort allein bestätigt nicht
    await rejects(t.svc.confirmSudo(s, { password: PW }, MAC), 'second_factor_required', 400)
    const { challengeId, options } = await t.svc.sudoPasskeyOptions(s, RP)
    await t.svc.confirmSudoPasskey(s, challengeId, auth.authenticate(options), MAC, RP)
    await t.svc.deletePasskey(s, passkey.id)
    assert.equal(t.store.recovery.length, 0)
    assert.equal((await t.svc.passwordLogin(PW, PHONE, RP)).kind, 'session')
    assert.ok(t.audits.some((a) => a.action === 'auth.passkey.delete'))
  })

  test('Registrierung braucht die erneute Bestätigung', async () => {
    const t = setup()
    const s = await login(t)
    await rejects(t.svc.passkeyRegisterOptions(s, RP), 'sudo_required', 403)
  })
})

describe('Sitzungen', () => {
  test('Liste mit Gerät, Zugang und aktueller Sitzung; einzeln und «alle anderen» abmelden', async () => {
    const t = setup()
    const s = await login(t, MAC)
    t.tick(1000)
    const phone = await login(t, PHONE)
    const third = await login(t, { ip: '172.18.0.1', userAgent: null })
    const list = await t.svc.listSessions(s)
    assert.equal(list.length, 3)
    assert.equal(list[0]!.current, true)
    assert.equal(list[0]!.device, 'Safari auf macOS')
    assert.equal(list[0]!.access, 'lan')
    const p = list.find((x) => x.id === phone.id)!
    assert.equal(p.device, 'Safari auf iPhone')
    assert.equal(p.access, 'tailnet')
    assert.equal(list.find((x) => x.id === third.id)!.access, 'gateway')

    await t.svc.revokeSession(s, phone.id)
    assert.equal(await t.svc.resolveSession(phone.token, null), null)
    await rejects(t.svc.revokeSession(s, phone.id), 'not_found', 404)

    assert.equal(await t.svc.revokeOthers(s, 'manual'), 1)
    assert.equal(await t.svc.resolveSession(third.token, null), null)
    assert.ok(await t.svc.resolveSession(s.token, null))
    assert.equal((await t.svc.listSessions(s)).length, 1)
  })
})

describe('Notausgang', () => {
  test('resetTwoFactor entfernt alle Faktoren, meldet alle ab, hebt Sperren auf, schreibt Audit', async () => {
    const t = setup()
    const s = await login(t)
    await enableTotp(t, s)
    for (let i = 0; i < 5; i++) await rejects(t.svc.passwordLogin('falsch', PHONE, RP), 'invalid_credentials')
    const r = await t.svc.resetTwoFactor('cli:admin')
    assert.deepEqual(r, { passkeys: 0, totp: true, recoveryCodes: 10, sessions: 1 })
    assert.equal(await t.svc.resolveSession(s.token, null), null)
    assert.equal(await t.svc.hasFactor(), false)
    assert.equal((await t.svc.passwordLogin(PW, PHONE, RP)).kind, 'session')
    const a = t.audits.find((x) => x.action === 'auth.2fa.reset')!
    assert.equal(a.actor, 'cli:admin')
  })
})
