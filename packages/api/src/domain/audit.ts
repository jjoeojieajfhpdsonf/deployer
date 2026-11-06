import { desc, lt, and, eq, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { maskParams } from '../lib/crypto.js'
import { log } from '../lib/log.js'
import type { AuditEventDto } from '@deployer/shared'

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
      paramsMasked: (maskParams(entry.params ?? {}) ?? {}) as Record<string, unknown>,
      result: entry.result,
      error: entry.error ?? null,
    })
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

export async function listAudit(opts: { limit?: number; before?: string; action?: string } = {}): Promise<AuditEventDto[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  const conds: SQL[] = []
  if (opts.before) conds.push(lt(schema.auditEvents.at, new Date(opts.before)))
  if (opts.action) conds.push(eq(schema.auditEvents.action, opts.action))

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
    paramsMasked: r.paramsMasked,
    result: r.result,
    error: r.error,
  }))
}
