import { randomUUID } from 'node:crypto'
import type { SessionMethod } from '@airlock/shared'

/**
 * Speicher für Anmeldung und zweiten Faktor. Zwei Umsetzungen mit gleichem
 * Verhalten: PostgreSQL (store-pg.ts, im Betrieb) und im Speicher (hier,
 * für Tests). Die Logik steckt in service.ts und kennt nur diese Schnittstelle.
 */

export interface SessionRow {
  id: string
  /** SHA-256 des Cookie-Werts; der Wert selbst steht nirgends */
  tokenHash: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  ip: string | null
  userAgent: string | null
  method: SessionMethod
  sudoUntil: Date | null
  revokedAt: Date | null
}

export interface PasskeyRow {
  id: string
  /** Base64URL */
  credentialId: string
  publicKey: Uint8Array
  counter: number
  transports: string[]
  deviceType: string | null
  backedUp: boolean | null
  name: string
  rpId: string
  createdAt: Date
  lastUsedAt: Date | null
}

export interface TotpRow {
  secretEnc: Buffer | null
  enabledAt: Date | null
  /** Zuletzt angenommenes Zeitfenster (jeder Code nur einmal) */
  lastStep: number
  pendingEnc: Buffer | null
  pendingAt: Date | null
}

export interface RecoveryStatus {
  total: number
  remaining: number
  createdAt: Date | null
}

export interface AuthStore {
  createSession(row: Omit<SessionRow, 'id'>): Promise<SessionRow>
  sessionByHash(tokenHash: string): Promise<SessionRow | null>
  touchSession(id: string, at: Date, ip: string | null): Promise<void>
  setSudo(id: string, until: Date | null): Promise<void>
  /** Nicht widerrufene Sitzungen (abgelaufene filtert der Aufrufer) */
  listSessions(): Promise<SessionRow[]>
  revokeSession(id: string, at: Date): Promise<boolean>
  /** Alle ausser exceptId widerrufen; Anzahl */
  revokeAllExcept(exceptId: string | null, at: Date): Promise<number>

  listPasskeys(): Promise<PasskeyRow[]>
  passkeyByCredentialId(credentialId: string): Promise<PasskeyRow | null>
  addPasskey(row: Omit<PasskeyRow, 'id'>): Promise<PasskeyRow>
  usePasskey(id: string, counter: number, at: Date): Promise<void>
  deletePasskey(id: string): Promise<PasskeyRow | null>
  deleteAllPasskeys(): Promise<number>

  getTotp(): Promise<TotpRow>
  setTotpPending(enc: Buffer | null, at: Date | null): Promise<void>
  activateTotp(enc: Buffer, at: Date, step: number): Promise<void>
  /** Atomar: nur annehmen, wenn step grösser als das zuletzt benutzte Fenster */
  useTotpStep(step: number): Promise<boolean>
  clearTotp(): Promise<void>

  replaceRecoveryCodes(hashes: string[], at: Date): Promise<void>
  /** Atomar: Code einmal verbrauchen */
  useRecoveryCode(hash: string, at: Date): Promise<boolean>
  recoveryStatus(): Promise<RecoveryStatus>
  clearRecoveryCodes(): Promise<number>

  /** «Zweiter Faktor erforderlich»: null = Standard */
  getRequired(): Promise<boolean | null>
  setRequired(v: boolean | null): Promise<void>
  getPasswordHash(): Promise<string | null>
}

const emptyTotp = (): TotpRow => ({ secretEnc: null, enabledAt: null, lastStep: -1, pendingEnc: null, pendingAt: null })

/** Im Speicher – für Tests (gleiches Verhalten wie store-pg.ts) */
export class MemoryAuthStore implements AuthStore {
  sessions = new Map<string, SessionRow>()
  passkeys = new Map<string, PasskeyRow>()
  totp: TotpRow = emptyTotp()
  recovery: { hash: string; createdAt: Date; usedAt: Date | null }[] = []
  required: boolean | null = null

  constructor(public passwordHash: string | null = null) {}

  async createSession(row: Omit<SessionRow, 'id'>) {
    const s = { ...row, id: randomUUID() }
    this.sessions.set(s.id, s)
    return { ...s }
  }
  async sessionByHash(h: string) {
    for (const s of this.sessions.values()) if (s.tokenHash === h) return { ...s }
    return null
  }
  async touchSession(id: string, at: Date, ip: string | null) {
    const s = this.sessions.get(id)
    if (s) { s.lastSeenAt = at; if (ip) s.ip = ip }
  }
  async setSudo(id: string, until: Date | null) {
    const s = this.sessions.get(id)
    if (s) s.sudoUntil = until
  }
  async listSessions() {
    return [...this.sessions.values()].filter((s) => !s.revokedAt).map((s) => ({ ...s }))
  }
  async revokeSession(id: string, at: Date) {
    const s = this.sessions.get(id)
    if (!s || s.revokedAt) return false
    s.revokedAt = at
    return true
  }
  async revokeAllExcept(exceptId: string | null, at: Date) {
    let n = 0
    for (const s of this.sessions.values()) {
      if (s.id !== exceptId && !s.revokedAt) { s.revokedAt = at; n++ }
    }
    return n
  }

  async listPasskeys() {
    return [...this.passkeys.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((p) => ({ ...p }))
  }
  async passkeyByCredentialId(c: string) {
    for (const p of this.passkeys.values()) if (p.credentialId === c) return { ...p }
    return null
  }
  async addPasskey(row: Omit<PasskeyRow, 'id'>) {
    if ([...this.passkeys.values()].some((p) => p.credentialId === row.credentialId)) throw new Error('Passkey schon vorhanden')
    const p = { ...row, id: randomUUID() }
    this.passkeys.set(p.id, p)
    return { ...p }
  }
  async usePasskey(id: string, counter: number, at: Date) {
    const p = this.passkeys.get(id)
    if (p) { p.counter = counter; p.lastUsedAt = at }
  }
  async deletePasskey(id: string) {
    const p = this.passkeys.get(id)
    if (!p) return null
    this.passkeys.delete(id)
    return p
  }
  async deleteAllPasskeys() {
    const n = this.passkeys.size
    this.passkeys.clear()
    return n
  }

  async getTotp() { return { ...this.totp } }
  async setTotpPending(enc: Buffer | null, at: Date | null) { this.totp.pendingEnc = enc; this.totp.pendingAt = at }
  async activateTotp(enc: Buffer, at: Date, step: number) {
    this.totp = { secretEnc: enc, enabledAt: at, lastStep: step, pendingEnc: null, pendingAt: null }
  }
  async useTotpStep(step: number) {
    if (step <= this.totp.lastStep) return false
    this.totp.lastStep = step
    return true
  }
  async clearTotp() { this.totp = emptyTotp() }

  async replaceRecoveryCodes(hashes: string[], at: Date) {
    this.recovery = hashes.map((hash) => ({ hash, createdAt: at, usedAt: null }))
  }
  async useRecoveryCode(hash: string, at: Date) {
    const r = this.recovery.find((x) => x.hash === hash && !x.usedAt)
    if (!r) return false
    r.usedAt = at
    return true
  }
  async recoveryStatus() {
    return {
      total: this.recovery.length,
      remaining: this.recovery.filter((r) => !r.usedAt).length,
      createdAt: this.recovery[0]?.createdAt ?? null,
    }
  }
  async clearRecoveryCodes() {
    const n = this.recovery.length
    this.recovery = []
    return n
  }

  async getRequired() { return this.required }
  async setRequired(v: boolean | null) { this.required = v }
  async getPasswordHash() { return this.passwordHash }
}
