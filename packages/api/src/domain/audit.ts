import { desc, asc, lt, and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { maskParams } from '../lib/crypto.js'
import { log } from '../lib/log.js'
import { publish } from '../lib/events.js'
import { redactDeep, redactSecrets } from '../lib/redact.js'
import type { AuditEventDto } from '@airlock/shared'

/**
 * Audit-Log fuer jede Aenderung, egal ob aus UI, API oder (spaeter) MCP.
 * Secrets werden vor dem Schreiben maskiert.
 */

export interface AuditInput {
  actor: string
  action: string
  targetType?: string | null
  targetId?: string | null
  params?: unknown
  result: 'ok' | 'error'
  error?: string | null
}

export async function audit(entry: AuditInput): Promise<void> {
  try {
    await db.insert(schema.auditEvents).values({
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      paramsMasked: redactDeep((maskParams(entry.params ?? {}) ?? {}) as Record<string, unknown>),
      result: entry.result,
      // Fehlertexte von Caddy/Cloudflare/cloudflared können Tokens enthalten
      error: redactSecrets(entry.error) ?? null,
    })
    // UI-Qualität 3: fast jede Änderung schreibt einen Eintrag – die Oberfläche lädt gezielt nach
    publish({ type: 'audit', action: entry.action, targetType: entry.targetType ?? null, targetId: entry.targetId ?? null })
  } catch (err) {
    // Ein kaputtes Audit-Log darf die eigentliche Aktion nicht umwerfen,
    // muss aber laut sein.
    log.error('Audit-Eintrag fehlgeschlagen', { action: entry.action, err: String(err) })
  }
}

/** Fuehrt fn aus und protokolliert Erfolg oder Fehler. */
export async function withAudit<T>(
  base: Omit<AuditInput, 'result' | 'error'>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const out = await fn()
    await audit({ ...base, result: 'ok' })
    return out
  } catch (err) {
    await audit({ ...base, result: 'error', error: (err as Error).message })
    throw err
  }
}

export async function listAudit(opts: { limit?: number; before?: string; action?: string; targetId?: string } = {}): Promise<AuditEventDto[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  const conds: SQL[] = []
  if (opts.before) conds.push(lt(schema.auditEvents.at, new Date(opts.before)))
  if (opts.action) conds.push(eq(schema.auditEvents.action, opts.action))
  if (opts.targetId) conds.push(eq(schema.auditEvents.targetId, opts.targetId))

  const rows = await db
    .select()
    .from(schema.auditEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.auditEvents.at), desc(schema.auditEvents.id))
    .limit(limit)

  return rows.map((r) => ({
    id: String(r.id),
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    paramsMasked: redactDeep(r.paramsMasked),
    result: r.result,
    error: redactSecrets(r.error) ?? null,
  }))
}

/**
 * Wer ein Projekt angelegt hat (erstes «project.create»/«files.init»).
 * Chat-Projekte entstehen über MCP: dann «mcp:<Token>».
 */
export async function createdBy(projectId: string, sourceType: string): Promise<string | null> {
  const rows = await db
    .select({ actor: schema.auditEvents.actor })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.targetId, projectId), inArray(schema.auditEvents.action, ['project.create', 'files.init'])))
    .orderBy(asc(schema.auditEvents.at))
    .limit(1)
  const a = rows[0]?.actor ?? null
  return a && sourceType === 'files' && a.startsWith('token:') ? `mcp:${a.slice(6)}` : a
}

/**
 * Beim Start: Tokens aus bestehenden Einträgen entfernen (vor dem Schwärzen
 * geschrieben, z.B. «API token 'cfut_…' appears invalid»). Nach
 * loadCloudflareSettings aufrufen, damit das bekannte Token registriert ist.
 * Vorfilter in SQL grob, das genaue Schwärzen in redactSecrets.
 */
export async function scrubAuditSecrets(): Promise<number> {
  const candidates = await db
    .select({ id: schema.auditEvents.id, error: schema.auditEvents.error, params: schema.auditEvents.paramsMasked })
    .from(schema.auditEvents)
    .where(sql`${schema.auditEvents.error} ~ '[A-Za-z0-9_-]{16,}' OR ${schema.auditEvents.paramsMasked}::text ~ '[A-Za-z0-9_-]{16,}'`)
  let changed = 0
  for (const r of candidates) {
    const error = redactSecrets(r.error) ?? null
    const params = redactDeep(r.params)
    if (error === r.error && JSON.stringify(params) === JSON.stringify(r.params)) continue
    await db.update(schema.auditEvents).set({ error, paramsMasked: params as Record<string, unknown> }).where(eq(schema.auditEvents.id, r.id))
    changed++
  }
  if (changed) log.warn('Tokens aus Audit-Einträgen entfernt', { einträge: changed })
  return changed
}
