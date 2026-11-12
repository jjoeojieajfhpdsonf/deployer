import { createHash, createHmac, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  SUDO_MINUTES, PRODUCT_NAME,
  type PasskeyDto, type RecoveryCodesDto, type SecondFactorDto, type SecurityDto, type SessionDto, type SessionMethod, type PasskeyHostDto,
  type SudoStatusDto, type TotpSetupDto,
} from '@airlock/shared'
import { AppError, notFound } from '../lib/errors.js'
import { decrypt, encrypt } from '../lib/crypto.js'
import type { AuditInput } from '../domain/audit.js'
import type { AuthStore, PasskeyRow, SessionRow } from './store.js'
import { DEFAULT_THROTTLE, LoginThrottle, minutesOf, type ThrottleOptions } from './throttle.js'
import { formatSecret, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js'
import { generateRecoveryCodes, hashRecoveryCode, recoveryCodesText } from './recovery.js'
import { accessOf, deviceLabel } from './client.js'

/**
 * Anmeldung, zweiter Faktor, Sitzungen und erneute Bestätigung (sudo).
 *
 * Airlock kennt eine Person (SPEC); «pro Benutzer» heisst hier: für dieses
 * eine Konto. Alles, was Zeit braucht (Uhr, Warten), Speicher und Audit
 * kommt von aussen – so sind Sperren, Zeitfenster und Ablauf testbar.
 */

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** Zweiter Schritt der Anmeldung: so lange gilt das richtige Passwort */
export const PENDING_MS = 5 * 60_000
/** Höchstens so viele falsche Codes je angefangener Anmeldung */
export const PENDING_MAX_TRIES = 5
export const CHALLENGE_MS = 5 * 60_000
/** TOTP einrichten: so lange gilt das angezeigte Geheimnis */
export const TOTP_SETUP_MS = 15 * 60_000
/** «zuletzt aktiv» höchstens einmal pro Minute schreiben */
const TOUCH_EVERY_MS = 60_000
/** Alle Antworten der Passwort-Prüfung dauern mindestens so lange (gleich bei richtig und falsch) */
export const LOGIN_FLOOR_MS = 800
const MAX_PENDING = 1000

/** Schlüssel der Sperre für das (einzige) Konto */
export const USER_KEY = 'user:admin'
const ipKey = (ip: string) => `ip:${ip}`

export interface RpContext {
  rpID: string
  origin: string
}

export interface ClientInfo {
  ip: string
  userAgent: string | null
}

export interface AuthDeps {
  store: AuthStore
  /** Schlüssel aus der Schlüsseldatei (TOTP-Geheimnis, HMAC der Wiederherstellungscodes) */
  key: () => Buffer
  audit: (e: AuditInput) => Promise<void>
  verifyPassword: (password: string, stored: string) => boolean
  /** Ein gültiger Hash, gegen den bei fehlendem Passwort gerechnet wird (gleiche Zeit) */
  dummyHash: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  loginFloorMs?: number
  throttle?: Partial<ThrottleOptions>
  /** LAN-Netz des Servers (Zugang in der Sitzungsliste) */
  lanCidr?: () => string | null
  /** Anzeigename (TOTP-Konto, Passkey-Benutzer) */
  accountName?: () => string
}

export type LoginOutcome =
  | { kind: 'session'; token: string; session: SessionRow; recoveryRemaining?: number }
  | { kind: 'second'; pendingId: string; factors: SecondFactorDto }

type ChallengePurpose = 'login' | 'sudo' | 'register'
interface Challenge { at: number; challenge: string; purpose: ChallengePurpose; sessionId: string | null; rpID: string }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const randomId = () => randomBytes(24).toString('base64url')

export const tooManyAttempts = (ms: number) =>
  new AppError('too_many_attempts', `Zu viele Fehlversuche. Wieder möglich in ${minutesOf(ms)} Min. – mit einem Passkey geht es sofort.`, 429, { retryAfterS: Math.ceil(ms / 1000) })
export const sudoRequired = () =>
  new AppError('sudo_required', `Bitte bestätige zuerst, dass du es bist (gilt ${SUDO_MINUTES} Minuten)`, 403)
const passkeyFailed = () => new AppError('passkey_failed', 'Der Passkey wurde nicht erkannt. Versuche es erneut oder melde dich mit dem Passwort an.', 401)

/** QR-Code als Zeilen «0101…» (Fehlerkorrektur M), gezeichnet im Browser wie beim Backup-Schlüssel */
function qrRows(text: string): string[] {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const rows: string[] = []
  for (let y = 0; y < n; y++) {
    let row = ''
    for (let x = 0; x < n; x++) row += qr.modules.get(y, x) ? '1' : '0'
    rows.push(row)
  }
  return rows
}

export class AuthService {
  readonly throttle: LoginThrottle
  private readonly pending = new Map<string, { at: number; ip: string; tries: number }>()
  private readonly challenges = new Map<string, Challenge>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly floor: number

  constructor(private readonly d: AuthDeps) {
    this.now = d.now ?? Date.now
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.floor = d.loginFloorMs ?? LOGIN_FLOOR_MS
    this.throttle = new LoginThrottle(this.now, { ...DEFAULT_THROTTLE, ...d.throttle })
  }

  private date = () => new Date(this.now())
  private account = () => this.d.accountName?.() ?? 'Admin'

  /** Mindestdauer für alles, was ein Passwort prüft: richtig und falsch dauern gleich lang */
  private async atLeast<T>(fn: () => Promise<T>): Promise<T> {
    const start = this.now()
    try {
      return await fn()
    } finally {
      const rest = this.floor - (this.now() - start)
      if (rest > 0) await this.sleep(rest)
    }
  }

  /* --- Zustand ------------------------------------------------------------ */

  async hasFactor(): Promise<boolean> {
    const [pk, totp] = await Promise.all([this.d.store.listPasskeys(), this.d.store.getTotp()])
    return pk.length > 0 || totp.enabledAt !== null
  }

  /** «Zweiter Faktor erforderlich»: Standard an, aber nur mit eingerichtetem Faktor (nie aussperren) */
  async isRequired(): Promise<boolean> {
    const setting = await this.d.store.getRequired()
    return setting !== false && (await this.hasFactor())
  }

  private async passkeysFor(rp: RpContext | null): Promise<PasskeyRow[]> {
    if (!rp) return []
    return (await this.d.store.listPasskeys()).filter((p) => p.rpId === rp.rpID)
  }

  /** Welche zweiten Faktoren gehen (Anmeldung, erneute Bestätigung) */
  async factors(rp: RpContext | null): Promise<SecondFactorDto> {
    const [totp, rec, pk] = await Promise.all([this.d.store.getTotp(), this.d.store.recoveryStatus(), this.passkeysFor(rp)])
    return { totp: totp.enabledAt !== null, recovery: rec.remaining > 0, passkey: pk.length > 0 }
  }

  /**
   * Ohne Anmeldung: gibt es Passkeys für die Hauptadresse? (Auch auf nip.io
   * gefragt – dann sagt die Anmeldeseite, wo der Passkey gilt.)
   */
  async hasPasskeysFor(rpId: string | null): Promise<boolean> {
    if (!rpId) return false
    return (await this.d.store.listPasskeys()).some((p) => p.rpId === rpId)
  }

  private async failure(ip: string, reason: 'password' | 'totp' | 'recovery' | 'passkey', error: string, opts: { count?: boolean } = {}): Promise<void> {
    await this.d.audit({ actor: `ip:${ip}`, action: 'auth.login', result: 'error', error, params: { reason, ip }, environmentId: null })
    if (opts.count === false) return
    for (const [key, kind] of [[ipKey(ip), 'ip'], [USER_KEY, 'user']] as const) {
      const r = this.throttle.fail(key)
      if (r.lockedMs !== null) {
        await this.d.audit({
          actor: `ip:${ip}`, action: 'auth.lockout', result: 'error', environmentId: null,
          error: kind === 'ip' ? `Adresse ${ip} gesperrt für ${minutesOf(r.lockedMs)} Min.` : `Anmeldung mit Passwort gesperrt für ${minutesOf(r.lockedMs)} Min.`,
          params: { scope: kind, ip, minutes: minutesOf(r.lockedMs) },
        })
      }
    }
  }

  private checkLock(ip: string): void {
    const lock = this.throttle.checkAll([ipKey(ip), USER_KEY])
    if (lock.locked) throw tooManyAttempts(lock.retryAfterMs)
  }

  private succeed(ip: string): void {
    this.throttle.succeed(ipKey(ip))
    this.throttle.succeed(USER_KEY)
  }

  private async checkPassword(password: string): Promise<boolean> {
    const stored = await this.d.store.getPasswordHash()
    // Auch ohne gespeichertes Passwort rechnen – gleiche Zeit
    const ok = this.d.verifyPassword(password, stored ?? this.d.dummyHash)
    return ok && stored !== null
  }

  private async checkTotp(code: string): Promise<boolean> {
    const t = await this.d.store.getTotp()
    if (!t.secretEnc || !t.enabledAt) return false
    const step = verifyTotp(decrypt(t.secretEnc, this.d.key()), code, this.now())
    if (step === null) return false
    return this.d.store.useTotpStep(step)
  }

  private async useRecovery(code: string): Promise<boolean> {
    return this.d.store.useRecoveryCode(hashRecoveryCode(code, this.d.key()), this.date())
  }

  /* --- Sitzungen ----------------------------------------------------------- */

  private async startSession(method: SessionMethod, client: ClientInfo, params: Record<string, unknown> = {}): Promise<{ kind: 'session'; token: string; session: SessionRow }> {
    const token = randomBytes(32).toString('base64url')
    const at = this.date()
    const session = await this.d.store.createSession({
      tokenHash: sha256(token), createdAt: at, lastSeenAt: at, expiresAt: new Date(at.getTime() + SESSION_MAX_AGE_MS),
      ip: client.ip, userAgent: client.userAgent?.slice(0, 400) ?? null, method, sudoUntil: null, revokedAt: null,
    })
    await this.d.audit({ actor: 'ui:joel', action: 'auth.login', result: 'ok', params: { method, ip: client.ip, ...params }, environmentId: null })
    return { kind: 'session', token, session }
  }

  /** Zugang «Airlock-Login»: Signatur der Gate-Tokens mit dem Schlüssel von Airlock (lib/gate.ts) */
  gateSign(data: string): string {
    return createHmac('sha256', this.d.key()).update(data).digest('base64url')
  }

  /** Zugang «Airlock-Login»: gilt die Sitzung noch (nicht abgemeldet, nicht abgelaufen)? Mit Ablauf */
  async sessionById(id: string): Promise<SessionRow | null> {
    const now = this.now()
    const row = (await this.d.store.listSessions()).find((s) => s.id === id) ?? null
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now) return null
    return row
  }

  /** Sitzung zum Cookie-Wert; null = ungültig, abgemeldet oder abgelaufen */
  async resolveSession(token: string | null, ip: string | null): Promise<SessionRow | null> {
    if (!token) return null
    const row = await this.d.store.sessionByHash(sha256(token))
    const now = this.now()
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now) return null
    if (now - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await this.d.store.touchSession(row.id, new Date(now), ip)
      row.lastSeenAt = new Date(now)
    }
    return row
  }

  async logout(session: SessionRow): Promise<void> {
    await this.d.store.revokeSession(session.id, this.date())
  }

  async listSessions(current: SessionRow): Promise<SessionDto[]> {
    const now = this.now()
    const lan = this.d.lanCidr?.() ?? null
    return (await this.d.store.listSessions())
      .filter((s) => s.expiresAt.getTime() > now)
      .sort((a, b) => (a.id === current.id ? -1 : b.id === current.id ? 1 : b.lastSeenAt.getTime() - a.lastSeenAt.getTime()))
      .map((s) => ({
        id: s.id,
        current: s.id === current.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        device: deviceLabel(s.userAgent),
        ip: s.ip,
        access: accessOf(s.ip, lan),
        method: s.method,
      }))
  }

  /** Eine Sitzung abmelden; die eigene = abmelden */
  async revokeSession(current: SessionRow, id: string): Promise<{ self: boolean }> {
    const ok = await this.d.store.revokeSession(id, this.date())
    if (!ok) throw notFound('Sitzung')
    await this.d.audit({ actor: 'ui:joel', action: 'auth.session.revoke', result: 'ok', targetType: 'session', targetId: id, environmentId: null })
    return { self: id === current.id }
  }

  async revokeOthers(current: SessionRow | null, why: string): Promise<number> {
    const n = await this.d.store.revokeAllExcept(current?.id ?? null, this.date())
    await this.d.audit({ actor: 'ui:joel', action: 'auth.sessions.revoke_others', result: 'ok', params: { count: n, why }, environmentId: null })
    return n
  }

  /* --- Anmeldung mit Passwort ---------------------------------------------- */

  async passwordLogin(password: string, client: ClientInfo, rp: RpContext | null): Promise<LoginOutcome> {
    return this.atLeast(async () => {
      try {
        this.checkLock(client.ip)
      } catch (e) {
        await this.d.audit({ actor: `ip:${client.ip}`, action: 'auth.login', result: 'error', error: 'gesperrt nach Fehlversuchen', params: { reason: 'locked', ip: client.ip }, environmentId: null })
        throw e
      }
      if (!(await this.checkPassword(password))) {
        await this.failure(client.ip, 'password', 'falsches Passwort')
        throw new AppError('invalid_credentials', 'Passwort stimmt nicht', 401)
      }
      if (await this.isRequired()) {
        this.prune(this.pending, PENDING_MS)
        const pendingId = randomId()
        this.pending.set(pendingId, { at: this.now(), ip: client.ip, tries: 0 })
        return { kind: 'second', pendingId, factors: await this.factors(rp) }
      }
      this.succeed(client.ip)
      return this.startSession('password', client)
    })
  }

  /**
   * Nur das Passwort noch einmal (Export des Backup-Schlüssels) – mit
   * derselben Sperre nach Fehlversuchen und derselben Mindestdauer.
   */
  async recheckPassword(password: string, ip: string): Promise<boolean> {
    return this.atLeast(async () => {
      this.checkLock(ip)
      if (!(await this.checkPassword(password))) {
        await this.failure(ip, 'password', 'falsches Passwort (erneute Eingabe)')
        return false
      }
      this.succeed(ip)
      return true
    })
  }

  /** Zweiter Schritt: Code aus der App oder Wiederherstellungscode */
  async secondFactor(pendingId: string | null, input: { code?: string; recoveryCode?: string }, client: ClientInfo): Promise<LoginOutcome> {
    return this.atLeast(async () => {
      const p = pendingId ? this.pending.get(pendingId) : undefined
      if (!pendingId || !p || this.now() - p.at > PENDING_MS) {
        if (pendingId) this.pending.delete(pendingId)
        throw new AppError('second_factor_expired', 'Die Anmeldung ist abgelaufen – bitte noch einmal mit dem Passwort beginnen.', 401)
      }
      this.checkLock(client.ip)
      const viaCode = input.code !== undefined
      const ok = viaCode ? await this.checkTotp(input.code!) : input.recoveryCode !== undefined && (await this.useRecovery(input.recoveryCode))
      if (!ok) {
        p.tries++
        if (p.tries >= PENDING_MAX_TRIES) this.pending.delete(pendingId)
        await this.failure(client.ip, viaCode ? 'totp' : 'recovery', viaCode ? 'falscher Code (Authenticator)' : 'falscher Wiederherstellungscode')
        throw new AppError('invalid_code', viaCode
          ? 'Der Code stimmt nicht oder wurde schon verwendet. Warte auf den nächsten Code der App.'
          : 'Der Wiederherstellungscode stimmt nicht oder wurde schon verwendet.', 401)
      }
      this.pending.delete(pendingId)
      this.succeed(client.ip)
      const out = await this.startSession(viaCode ? 'password_totp' : 'password_recovery', client)
      if (viaCode) return out
      return { ...out, recoveryRemaining: (await this.d.store.recoveryStatus()).remaining }
    })
  }

  /* --- Passkeys: Anmeldung ------------------------------------------------- */

  private prune<V extends { at: number }>(m: Map<string, V>, ttl: number): void {
    const now = this.now()
    for (const [k, v] of m) if (now - v.at > ttl) m.delete(k)
    while (m.size >= MAX_PENDING) m.delete(m.keys().next().value!)
  }

  private putChallenge(c: Omit<Challenge, 'at'>): string {
    this.prune(this.challenges, CHALLENGE_MS)
    const id = randomId()
    this.challenges.set(id, { ...c, at: this.now() })
    return id
  }

  /** Einmalig: holt und löscht die Herausforderung */
  private takeChallenge(id: string | null, purpose: ChallengePurpose, sessionId: string | null, rp: RpContext): Challenge | null {
    if (!id) return null
    const c = this.challenges.get(id)
    this.challenges.delete(id)
    if (!c || c.purpose !== purpose || c.sessionId !== sessionId || c.rpID !== rp.rpID) return null
    if (this.now() - c.at > CHALLENGE_MS) return null
    return c
  }

  async passkeyLoginOptions(rp: RpContext): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    // Leere allowCredentials: der Browser bietet die Passkeys dieser Adresse an (auffindbare Schlüssel)
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: 120_000 })
    return { challengeId: this.putChallenge({ challenge: options.challenge, purpose: 'login', sessionId: null, rpID: rp.rpID }), options }
  }

  private async verifyPasskey(c: Challenge, response: AuthenticationResponseJSON, rp: RpContext): Promise<PasskeyRow | null> {
    const pk = typeof response?.id === 'string' ? await this.d.store.passkeyByCredentialId(response.id) : null
    if (!pk || pk.rpId !== rp.rpID) return null
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: pk.transports },
        requireUserVerification: true,
      })
      if (!v.verified) return null
      await this.d.store.usePasskey(pk.id, v.authenticationInfo.newCounter, this.date())
      return pk
    } catch {
      return null
    }
  }

  async passkeyLogin(challengeId: string | null, response: AuthenticationResponseJSON, client: ClientInfo, rp: RpContext): Promise<LoginOutcome> {
    const c = this.takeChallenge(challengeId, 'login', null, rp)
    const pk = c ? await this.verifyPasskey(c, response, rp) : null
    if (!pk) {
      // Nicht gezählt: ein Passkey lässt sich nicht erraten, und so sperrt niemand die Anmeldung per Passkey
      await this.failure(client.ip, 'passkey', 'Passkey nicht erkannt', { count: false })
      throw passkeyFailed()
    }
    // Der Passkey beweist die Person: Sperren nach Fehlversuchen aufheben
    this.succeed(client.ip)
    return this.startSession('passkey', client, { passkey: pk.name })
  }

  /* --- Erneute Bestätigung (sudo) ------------------------------------------ */

  sudoActive(session: SessionRow): boolean {
    return session.sudoUntil !== null && session.sudoUntil.getTime() > this.now()
  }

  requireSudo(session: SessionRow): void {
    if (!this.sudoActive(session)) throw sudoRequired()
  }

  async sudoStatus(session: SessionRow, rp: RpContext | null): Promise<SudoStatusDto> {
    const required = await this.isRequired()
    const f = await this.factors(rp)
    return {
      until: this.sudoActive(session) ? session.sudoUntil!.toISOString() : null,
      needs: { password: true, passkey: f.passkey, totp: required && f.totp, recovery: required && f.recovery },
    }
  }

  private async grantSudo(session: SessionRow, method: string): Promise<string> {
    const until = new Date(this.now() + SUDO_MINUTES * 60_000)
    await this.d.store.setSudo(session.id, until)
    session.sudoUntil = until
    await this.d.audit({ actor: 'ui:joel', action: 'auth.sudo', result: 'ok', params: { method }, environmentId: null })
    return until.toISOString()
  }

  /** Mit Passwort (und, wenn der zweite Faktor erforderlich ist, Code oder Wiederherstellungscode) */
  async confirmSudo(session: SessionRow, input: { password: string; code?: string; recoveryCode?: string }, client: ClientInfo): Promise<string> {
    return this.atLeast(async () => {
      this.checkLock(client.ip)
      if (!(await this.checkPassword(input.password))) {
        await this.failure(client.ip, 'password', 'falsches Passwort (Bestätigung)')
        throw new AppError('invalid_credentials', 'Das Passwort stimmt nicht', 401)
      }
      let method = 'password'
      if (await this.isRequired()) {
        if (input.code === undefined && input.recoveryCode === undefined) {
          throw new AppError('second_factor_required', 'Gib zusätzlich den Code aus der Authenticator-App oder einen Wiederherstellungscode ein', 400)
        }
        const viaCode = input.code !== undefined
        const ok = viaCode ? await this.checkTotp(input.code!) : await this.useRecovery(input.recoveryCode!)
        if (!ok) {
          await this.failure(client.ip, viaCode ? 'totp' : 'recovery', 'falscher Code (Bestätigung)')
          throw new AppError('invalid_code', viaCode ? 'Der Code stimmt nicht oder wurde schon verwendet' : 'Der Wiederherstellungscode stimmt nicht oder wurde schon verwendet', 401)
        }
        method = viaCode ? 'password_totp' : 'password_recovery'
      }
      this.succeed(client.ip)
      return this.grantSudo(session, method)
    })
  }

  async sudoPasskeyOptions(session: SessionRow, rp: RpContext): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const pks = await this.passkeysFor(rp)
    if (!pks.length) throw new AppError('no_passkey', 'Für diese Adresse ist kein Passkey eingerichtet', 400)
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID, userVerification: 'required', timeout: 120_000,
      allowCredentials: pks.map((p) => ({ id: p.credentialId, transports: p.transports })),
    })
    return { challengeId: this.putChallenge({ challenge: options.challenge, purpose: 'sudo', sessionId: session.id, rpID: rp.rpID }), options }
  }

  async confirmSudoPasskey(session: SessionRow, challengeId: string | null, response: AuthenticationResponseJSON, client: ClientInfo, rp: RpContext): Promise<string> {
    const c = this.takeChallenge(challengeId, 'sudo', session.id, rp)
    const pk = c ? await this.verifyPasskey(c, response, rp) : null
    if (!pk) {
      await this.failure(client.ip, 'passkey', 'Passkey nicht erkannt (Bestätigung)', { count: false })
      throw passkeyFailed()
    }
    return this.grantSudo(session, 'passkey')
  }

  /* --- Konto › Sicherheit -------------------------------------------------- */

  async security(session: SessionRow, passkeyHost: PasskeyHostDto): Promise<SecurityDto> {
    const [pks, totp, rec, setting] = await Promise.all([
      this.d.store.listPasskeys(), this.d.store.getTotp(), this.d.store.recoveryStatus(), this.d.store.getRequired(),
    ])
    const hasFactor = pks.length > 0 || totp.enabledAt !== null
    return {
      passkeys: pks.map(passkeyDto),
      totp: { enabled: totp.enabledAt !== null, enabledAt: totp.enabledAt?.toISOString() ?? null },
      recovery: { total: rec.total, remaining: rec.remaining, createdAt: rec.createdAt?.toISOString() ?? null },
      required: setting !== false && hasFactor,
      requiredSetting: setting,
      hasFactor,
      sudoUntil: this.sudoActive(session) ? session.sudoUntil!.toISOString() : null,
      passkeyHost,
    }
  }

  /** Neue Codes, wenn noch keine da sind (erster Faktor) – sonst null */
  private async ensureRecovery(host: string | null): Promise<RecoveryCodesDto | null> {
    if ((await this.d.store.recoveryStatus()).total > 0) return null
    return this.newRecovery(host)
  }

  private async newRecovery(host: string | null): Promise<RecoveryCodesDto> {
    const codes = generateRecoveryCodes()
    const at = this.date()
    await this.d.store.replaceRecoveryCodes(codes.map((c) => hashRecoveryCode(c, this.d.key())), at)
    return { codes, createdAt: at.toISOString(), text: recoveryCodesText(codes, { product: PRODUCT_NAME, host, createdAt: at }) }
  }

  /** Letzter Faktor entfernt: Codes ohne Faktor sind wertlos – weg damit (neue beim nächsten Einrichten) */
  private async afterFactorRemoved(): Promise<void> {
    if (!(await this.hasFactor())) await this.d.store.clearRecoveryCodes()
  }

  async totpSetup(session: SessionRow, host: string | null): Promise<TotpSetupDto> {
    this.requireSudo(session)
    const secret = generateTotpSecret()
    await this.d.store.setTotpPending(encrypt(secret, this.d.key()), this.date())
    const account = host ? `${this.account()} (${host})` : this.account()
    const uri = otpauthUri({ secret, issuer: PRODUCT_NAME, account })
    return { secret: formatSecret(secret), uri, qr: qrRows(uri) }
  }

  async totpEnable(session: SessionRow, code: string, host: string | null): Promise<{ recovery: RecoveryCodesDto | null; revoked: number }> {
    this.requireSudo(session)
    const t = await this.d.store.getTotp()
    if (!t.pendingEnc || !t.pendingAt || this.now() - t.pendingAt.getTime() > TOTP_SETUP_MS) {
      throw new AppError('totp_setup_expired', 'Die Einrichtung ist abgelaufen – bitte neu beginnen (neuer QR-Code).', 400)
    }
    const step = verifyTotp(decrypt(t.pendingEnc, this.d.key()), code, this.now())
    if (step === null) {
      await this.d.audit({ actor: 'ui:joel', action: 'auth.totp.enable', result: 'error', error: 'Code passt nicht', environmentId: null })
      throw new AppError('invalid_code', 'Der Code passt nicht. Prüfe, ob die Uhr des Telefons stimmt, und gib den aktuellen Code ein.', 400)
    }
    // Das bestätigte Fenster gilt als benutzt: derselbe Code geht danach nicht zur Anmeldung
    await this.d.store.activateTotp(t.pendingEnc, this.date(), step)
    const recovery = await this.ensureRecovery(host)
    await this.d.audit({ actor: 'ui:joel', action: 'auth.totp.enable', result: 'ok', environmentId: null })
    const revoked = await this.revokeOthers(session, 'totp.enable')
    return { recovery, revoked }
  }

  async totpDisable(session: SessionRow): Promise<{ revoked: number }> {
    this.requireSudo(session)
    await this.d.store.clearTotp()
    await this.afterFactorRemoved()
    await this.d.audit({ actor: 'ui:joel', action: 'auth.totp.disable', result: 'ok', environmentId: null })
    return { revoked: await this.revokeOthers(session, 'totp.disable') }
  }

  async regenerateRecovery(session: SessionRow, host: string | null): Promise<{ recovery: RecoveryCodesDto; revoked: number }> {
    this.requireSudo(session)
    if (!(await this.hasFactor())) throw new AppError('no_factor', 'Wiederherstellungscodes gibt es erst mit einem Passkey oder der Authenticator-App', 400)
    const recovery = await this.newRecovery(host)
    await this.d.audit({ actor: 'ui:joel', action: 'auth.recovery.regenerate', result: 'ok', environmentId: null })
    return { recovery, revoked: await this.revokeOthers(session, 'recovery.regenerate') }
  }

  async setRequired(session: SessionRow, required: boolean): Promise<{ revoked: number }> {
    this.requireSudo(session)
    if (required && !(await this.hasFactor())) {
      throw new AppError('no_factor', 'Richte zuerst einen Passkey oder die Authenticator-App ein', 400)
    }
    await this.d.store.setRequired(required)
    await this.d.audit({ actor: 'ui:joel', action: 'auth.2fa.required', result: 'ok', params: { required }, environmentId: null })
    return { revoked: await this.revokeOthers(session, 'required') }
  }

  async passkeyRegisterOptions(session: SessionRow, rp: RpContext): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    this.requireSudo(session)
    const existing = await this.passkeysFor(rp)
    const options = await generateRegistrationOptions({
      rpName: PRODUCT_NAME,
      rpID: rp.rpID,
      userName: this.account(),
      userDisplayName: this.account(),
      // Fest: ein Konto – ein neuer Passkey auf demselben Gerät ersetzt den alten dort
      userID: new Uint8Array(createHash('sha256').update('airlock-user\0admin').digest().subarray(0, 16)),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 120_000,
    })
    return { challengeId: this.putChallenge({ challenge: options.challenge, purpose: 'register', sessionId: session.id, rpID: rp.rpID }), options }
  }

  async passkeyRegister(session: SessionRow, challengeId: string | null, name: string, response: RegistrationResponseJSON, rp: RpContext, host: string | null): Promise<{ passkey: PasskeyDto; recovery: RecoveryCodesDto | null; revoked: number }> {
    this.requireSudo(session)
    const c = this.takeChallenge(challengeId, 'register', session.id, rp)
    if (!c) throw new AppError('passkey_failed', 'Die Einrichtung ist abgelaufen – bitte noch einmal beginnen.', 400)
    let info
    try {
      const v = await verifyRegistrationResponse({
        response, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      })
      if (!v.verified) throw new Error('nicht bestätigt')
      info = v.registrationInfo
    } catch (e) {
      await this.d.audit({ actor: 'ui:joel', action: 'auth.passkey.add', result: 'error', error: (e as Error).message, params: { name }, environmentId: null })
      throw new AppError('passkey_failed', 'Der Passkey liess sich nicht einrichten. Versuche es erneut.', 400)
    }
    if (await this.d.store.passkeyByCredentialId(info.credential.id)) throw new AppError('conflict', 'Dieser Passkey ist schon eingerichtet', 409)
    const row = await this.d.store.addPasskey({
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: response.response?.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      name,
      rpId: rp.rpID,
      createdAt: this.date(),
      lastUsedAt: null,
    })
    const recovery = await this.ensureRecovery(host)
    await this.d.audit({ actor: 'ui:joel', action: 'auth.passkey.add', result: 'ok', targetType: 'passkey', targetId: row.id, params: { name }, environmentId: null })
    const revoked = await this.revokeOthers(session, 'passkey.add')
    return { passkey: passkeyDto(row), recovery, revoked }
  }

  async deletePasskey(session: SessionRow, id: string): Promise<{ revoked: number }> {
    this.requireSudo(session)
    const row = await this.d.store.deletePasskey(id)
    if (!row) throw notFound('Passkey')
    await this.afterFactorRemoved()
    await this.d.audit({ actor: 'ui:joel', action: 'auth.passkey.delete', result: 'ok', targetType: 'passkey', targetId: id, params: { name: row.name }, environmentId: null })
    return { revoked: await this.revokeOthers(session, 'passkey.delete') }
  }

  /* --- Notausgang (CLI) ----------------------------------------------------- */

  /** Alle Faktoren entfernen, Pflicht zurück auf Standard, alle Sitzungen beenden */
  async resetTwoFactor(actor: string): Promise<{ passkeys: number; totp: boolean; recoveryCodes: number; sessions: number }> {
    const totp = (await this.d.store.getTotp()).enabledAt !== null
    const passkeys = await this.d.store.deleteAllPasskeys()
    await this.d.store.clearTotp()
    const recoveryCodes = await this.d.store.clearRecoveryCodes()
    await this.d.store.setRequired(null)
    const sessions = await this.d.store.revokeAllExcept(null, this.date())
    this.throttle.clear()
    const result = { passkeys, totp, recoveryCodes, sessions }
    await this.d.audit({ actor, action: 'auth.2fa.reset', result: 'ok', params: result, environmentId: null })
    return result
  }
}

export function passkeyDto(p: PasskeyRow): PasskeyDto {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    synced: p.backedUp,
    rpId: p.rpId,
  }
}

export const hashSessionToken = sha256
