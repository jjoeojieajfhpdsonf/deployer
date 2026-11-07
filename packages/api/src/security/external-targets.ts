import { eq, desc } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { audit } from '../domain/audit.js'
import { notFound, conflict } from '../lib/errors.js'
import { validateExternalHostname, txtRecordName, txtExpectedValue, verifyTxt, assertPublicTarget, PUBLIC_RESOLVERS, type TxtResolver, type AddressResolver } from './external.js'
import { notify } from '../notify/send.js'

/**
 * Externe Ziele (SPEC): eigene Seiten ausserhalb von deployer, die sich erst
 * nach einem DNS-Besitznachweis scannen lassen.
 */

type Row = typeof schema.externalTargets.$inferSelect

export interface ExternalTargetDto {
  id: string
  hostname: string
  verified: boolean
  verifiedAt: string | null
  lastCheckAt: string | null
  scanInterval: 'off' | 'daily' | 'weekly' | 'monthly'
  txt: { name: string; value: string }
}

export const toDto = (r: Row): ExternalTargetDto => ({
  id: r.id,
  hostname: r.hostname,
  verified: r.verifiedAt !== null,
  verifiedAt: r.verifiedAt?.toISOString() ?? null,
  lastCheckAt: r.lastCheckAt?.toISOString() ?? null,
  scanInterval: r.scanInterval,
  txt: { name: txtRecordName(r.hostname), value: txtExpectedValue(r.txtToken) },
})

/** Öffentliche Resolver, nicht der lokale. Austauschbar für Tests. */
let resolveTxt: TxtResolver = async (server, name) => {
  const r = new Resolver({ timeout: 4000, tries: 2 })
  r.setServers([server])
  return r.resolveTxt(name)
}
export function setTxtResolverForTests(fn: TxtResolver): void {
  resolveTxt = fn
}

/** A und AAAA über einen öffentlichen Resolver. */
let resolveAddresses: AddressResolver = async (name) => {
  const r = new Resolver({ timeout: 4000, tries: 2 })
  r.setServers([PUBLIC_RESOLVERS[0]!])
  const [v4, v6] = await Promise.all([r.resolve4(name).catch(() => []), r.resolve6(name).catch(() => [])])
  return [...v4, ...v6]
}
export function setAddressResolverForTests(fn: AddressResolver): void {
  resolveAddresses = fn
}

/** Vor Nachweis und vor jedem Scan: das Ziel muss auf öffentliche Adressen zeigen. */
export function assertTargetIsPublic(hostname: string): Promise<string[]> {
  return assertPublicTarget(hostname, resolveAddresses)
}

export async function listExternalTargets(): Promise<ExternalTargetDto[]> {
  return (await db.select().from(schema.externalTargets).orderBy(desc(schema.externalTargets.createdAt))).map(toDto)
}

export async function findExternalTarget(idOrHost: string): Promise<Row> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrHost)
  const rows = await db
    .select()
    .from(schema.externalTargets)
    .where(isUuid ? eq(schema.externalTargets.id, idOrHost) : eq(schema.externalTargets.hostname, idOrHost.toLowerCase()))
    .limit(1)
  if (!rows[0]) throw notFound('Externes Ziel')
  return rows[0]
}

export async function addExternalTarget(hostname: string, actor: string): Promise<ExternalTargetDto> {
  const h = validateExternalHostname(hostname, config.INTERNAL_BASE_DOMAIN)
  const existing = await db.select().from(schema.externalTargets).where(eq(schema.externalTargets.hostname, h))
  if (existing[0]) throw conflict(`${h} ist schon eingetragen`)
  const rows = await db.insert(schema.externalTargets).values({ hostname: h, txtToken: randomBytes(18).toString('base64url') }).returning()
  await audit({ actor, action: 'external_target.add', targetType: 'external_target', targetId: rows[0]!.id, params: { hostname: h }, result: 'ok' })
  return toDto(rows[0]!)
}

export async function verifyExternalTarget(idOrHost: string, actor: string): Promise<ExternalTargetDto & { confirmedBy: string[]; errors: string[] }> {
  const t = await findExternalTarget(idOrHost)
  const r = await verifyTxt(t.hostname, t.txtToken, resolveTxt)
  if (r.verified) {
    try {
      await assertTargetIsPublic(t.hostname)
    } catch (err) {
      r.verified = false
      r.errors.push((err as Error).message)
    }
  }
  const rows = await db
    .update(schema.externalTargets)
    .set({ verifiedAt: r.verified ? (t.verifiedAt ?? new Date()) : null, lastCheckAt: new Date() })
    .where(eq(schema.externalTargets.id, t.id))
    .returning()
  await audit({
    actor, action: 'external_target.verify', targetType: 'external_target', targetId: t.id,
    params: { hostname: t.hostname, verified: r.verified, confirmedBy: r.confirmedBy }, result: r.verified ? 'ok' : 'error',
    error: r.verified ? null : 'TXT-Eintrag nicht gefunden',
  })
  return { ...toDto(rows[0]!), confirmedBy: r.confirmedBy, errors: r.errors }
}

/**
 * Vor jedem Scan erneut prüfen (SPEC). Fehlt der Eintrag, ist die Freigabe
 * aufgehoben und es gibt eine Benachrichtigung.
 */
export async function recheckExternalTarget(id: string): Promise<boolean> {
  const t = await findExternalTarget(id)
  const r = await verifyTxt(t.hostname, t.txtToken, resolveTxt)
  await db
    .update(schema.externalTargets)
    .set({ verifiedAt: r.verified ? (t.verifiedAt ?? new Date()) : null, lastCheckAt: new Date() })
    .where(eq(schema.externalTargets.id, t.id))
  if (!r.verified && t.verifiedAt) {
    await audit({ actor: 'system', action: 'external_target.verification_lost', targetType: 'external_target', targetId: t.id, params: { hostname: t.hostname }, result: 'error', error: 'TXT-Eintrag fehlt' })
    await notify('external_verification_lost', { hostname: t.hostname })
  }
  return r.verified
}

export async function updateExternalTarget(idOrHost: string, scanInterval: Row['scanInterval'], actor: string): Promise<ExternalTargetDto> {
  const t = await findExternalTarget(idOrHost)
  const rows = await db.update(schema.externalTargets).set({ scanInterval }).where(eq(schema.externalTargets.id, t.id)).returning()
  await audit({ actor, action: 'external_target.update', targetType: 'external_target', targetId: t.id, params: { scanInterval }, result: 'ok' })
  return toDto(rows[0]!)
}

export async function deleteExternalTarget(idOrHost: string, actor: string): Promise<void> {
  const t = await findExternalTarget(idOrHost)
  await db.delete(schema.externalTargets).where(eq(schema.externalTargets.id, t.id))
  await audit({ actor, action: 'external_target.delete', targetType: 'external_target', targetId: t.id, params: { hostname: t.hostname }, result: 'ok' })
}
