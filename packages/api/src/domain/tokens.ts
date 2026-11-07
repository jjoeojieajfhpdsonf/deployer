import { eq, desc, isNull, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generateToken, hashToken, looksLikeToken } from '../lib/tokens.js'
import { notFound, badRequest } from '../lib/errors.js'
import { audit } from './audit.js'

export interface TokenIdentity {
  id: string
  name: string
}

export interface ApiTokenDto {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

type Row = typeof schema.apiTokens.$inferSelect

const toDto = (r: Row): ApiTokenDto => ({
  id: r.id,
  name: r.name,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
})

/** Der Klartext kommt genau hier einmal heraus und wird nirgends gespeichert. */
export async function createToken(name: string, actor: string): Promise<{ token: string; dto: ApiTokenDto }> {
  const clean = name.trim()
  if (clean.length < 1 || clean.length > 80) throw badRequest('Name muss 1 bis 80 Zeichen haben')
  const token = generateToken()
  const rows = await db.insert(schema.apiTokens).values({ name: clean, tokenHash: hashToken(token) }).returning()
  const row = rows[0]!
  await audit({ actor, action: 'token.create', targetType: 'token', targetId: row.id, params: { name: clean }, result: 'ok' })
  return { token, dto: toDto(row) }
}

export async function listTokens(): Promise<ApiTokenDto[]> {
  const rows = await db.select().from(schema.apiTokens).orderBy(desc(schema.apiTokens.createdAt))
  return rows.map(toDto)
}

export async function revokeToken(id: string, actor: string): Promise<void> {
  const rows = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, id), isNull(schema.apiTokens.revokedAt)))
    .returning()
  if (!rows[0]) {
    const exists = await db.select({ id: schema.apiTokens.id }).from(schema.apiTokens).where(eq(schema.apiTokens.id, id))
    if (!exists[0]) throw notFound('Token')
    return // schon widerrufen
  }
  await audit({ actor, action: 'token.revoke', targetType: 'token', targetId: id, params: { name: rows[0].name }, result: 'ok' })
}

/**
 * Prüft ein Token. Null bei unbekanntem oder widerrufenem Token. Die Suche
 * läuft über den eindeutigen Hash-Index; der Hash selbst verrät nichts.
 * "zuletzt benutzt" wird höchstens einmal pro Minute geschrieben.
 */
export async function verifyToken(raw: string): Promise<TokenIdentity | null> {
  if (!looksLikeToken(raw)) return null
  const rows = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hashToken(raw))).limit(1)
  const row = rows[0]
  if (!row || row.revokedAt) return null
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, row.id))
  }
  return { id: row.id, name: row.name }
}

/** Für offene MCP-Sitzungen: ist das Token noch gültig? */
export async function isTokenActive(id: string): Promise<boolean> {
  const rows = await db.select({ revokedAt: schema.apiTokens.revokedAt }).from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).limit(1)
  return !!rows[0] && rows[0].revokedAt === null
}
