import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import type { AuthStore, PasskeyRow, SessionRow, TotpRow } from './store.js'

/** Speicher in PostgreSQL (migrations/0024_auth_2fa.sql) – Verhalten wie MemoryAuthStore */

const s = schema.authSessions
const p = schema.authPasskeys
const t = schema.authTotp
const r = schema.authRecoveryCodes

const toSession = (x: typeof s.$inferSelect): SessionRow => ({ ...x })
const toPasskey = (x: typeof p.$inferSelect): PasskeyRow => ({ ...x, publicKey: new Uint8Array(x.publicKey) })

export class PgAuthStore implements AuthStore {
  async createSession(row: Omit<SessionRow, 'id'>) {
    const [x] = await db.insert(s).values(row).returning()
    return toSession(x!)
  }
  async sessionByHash(h: string) {
    const [x] = await db.select().from(s).where(eq(s.tokenHash, h)).limit(1)
    return x ? toSession(x) : null
  }
  async touchSession(id: string, at: Date, ip: string | null) {
    await db.update(s).set({ lastSeenAt: at, ...(ip ? { ip } : {}) }).where(eq(s.id, id))
  }
  async setSudo(id: string, until: Date | null) {
    await db.update(s).set({ sudoUntil: until }).where(eq(s.id, id))
  }
  async listSessions() {
    return (await db.select().from(s).where(isNull(s.revokedAt)).orderBy(asc(s.createdAt))).map(toSession)
  }
  async revokeSession(id: string, at: Date) {
    const rows = await db.update(s).set({ revokedAt: at }).where(and(eq(s.id, id), isNull(s.revokedAt))).returning({ id: s.id })
    return rows.length > 0
  }
  async revokeAllExcept(exceptId: string | null, at: Date) {
    const cond = exceptId ? and(isNull(s.revokedAt), ne(s.id, exceptId)) : isNull(s.revokedAt)
    const rows = await db.update(s).set({ revokedAt: at }).where(cond).returning({ id: s.id })
    return rows.length
  }

  async listPasskeys() {
    return (await db.select().from(p).orderBy(asc(p.createdAt))).map(toPasskey)
  }
  async passkeyByCredentialId(c: string) {
    const [x] = await db.select().from(p).where(eq(p.credentialId, c)).limit(1)
    return x ? toPasskey(x) : null
  }
  async addPasskey(row: Omit<PasskeyRow, 'id'>) {
    const [x] = await db.insert(p).values({ ...row, publicKey: Buffer.from(row.publicKey) }).returning()
    return toPasskey(x!)
  }
  async usePasskey(id: string, counter: number, at: Date) {
    await db.update(p).set({ counter, lastUsedAt: at }).where(eq(p.id, id))
  }
  async deletePasskey(id: string) {
    const [x] = await db.delete(p).where(eq(p.id, id)).returning()
    return x ? toPasskey(x) : null
  }
  async deleteAllPasskeys() {
    return (await db.delete(p).returning({ id: p.id })).length
  }

  async getTotp(): Promise<TotpRow> {
    const [x] = await db.select().from(t).where(eq(t.id, 1)).limit(1)
    return x
      ? { secretEnc: x.secretEnc, enabledAt: x.enabledAt, lastStep: x.lastStep, pendingEnc: x.pendingEnc, pendingAt: x.pendingAt }
      : { secretEnc: null, enabledAt: null, lastStep: -1, pendingEnc: null, pendingAt: null }
  }
  async setTotpPending(enc: Buffer | null, at: Date | null) {
    await db.insert(t).values({ id: 1, pendingEnc: enc, pendingAt: at })
      .onConflictDoUpdate({ target: t.id, set: { pendingEnc: enc, pendingAt: at } })
  }
  async activateTotp(enc: Buffer, at: Date, step: number) {
    const v = { secretEnc: enc, enabledAt: at, lastStep: step, pendingEnc: null, pendingAt: null }
    await db.insert(t).values({ id: 1, ...v }).onConflictDoUpdate({ target: t.id, set: v })
  }
  async useTotpStep(step: number) {
    // Atomar in einer Anweisung: zwei gleichzeitige Anmeldungen mit demselben Code – nur eine gewinnt
    const rows = await db.update(t).set({ lastStep: step }).where(and(eq(t.id, 1), sql`${t.lastStep} < ${step}`)).returning({ id: t.id })
    return rows.length > 0
  }
  async clearTotp() {
    await db.delete(t).where(eq(t.id, 1))
  }

  async replaceRecoveryCodes(hashes: string[], at: Date) {
    await db.transaction(async (tx) => {
      await tx.delete(r)
      if (hashes.length) await tx.insert(r).values(hashes.map((codeHash) => ({ codeHash, createdAt: at })))
    })
  }
  async useRecoveryCode(hash: string, at: Date) {
    const rows = await db.update(r).set({ usedAt: at }).where(and(eq(r.codeHash, hash), isNull(r.usedAt))).returning({ id: r.id })
    return rows.length > 0
  }
  async recoveryStatus() {
    const [x] = await db.select({
      total: sql<number>`count(*)::int`,
      remaining: sql<number>`count(*) filter (where ${r.usedAt} is null)::int`,
      createdAt: sql<Date | null>`min(${r.createdAt})`,
    }).from(r)
    const createdAt = x?.createdAt ? new Date(x.createdAt) : null
    return { total: x?.total ?? 0, remaining: x?.remaining ?? 0, createdAt }
  }
  async clearRecoveryCodes() {
    return (await db.delete(r).returning({ id: r.id })).length
  }

  async getRequired() {
    const v = await getSetting('auth_2fa_required')
    return v === 'true' ? true : v === 'false' ? false : null
  }
  async setRequired(v: boolean | null) {
    await setSetting('auth_2fa_required', v === null ? '' : String(v))
  }
  async getPasswordHash() {
    return getSetting('admin_password_hash')
  }
}

/** Abgelaufene und widerrufene Sitzungen nach 30 Tagen löschen (Liste bleibt klein) */
export async function pruneSessions(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000)
  const rows = await db.delete(s)
    .where(sql`(${s.revokedAt} is not null and ${s.revokedAt} < ${cutoff}) or ${s.expiresAt} < ${cutoff}`)
    .returning({ id: s.id })
  return rows.length
}
