import { randomBytes, createHash } from 'node:crypto'

/**
 * Bestätigungen für MCP-Clients ohne Elicitation (SPEC): Das Tool antwortet
 * mit einem confirmation_token; erst ein zweiter Aufruf mit denselben
 * Parametern und diesem Token innerhalb von 5 Minuten führt die Aktion aus.
 *
 * Gebunden an: das API-Token des Aufrufers, das Werkzeug, einen Hash der
 * Parameter. Einmal gültig. So lässt sich weder ein Token für "Projekt A
 * löschen" für Projekt B benutzen noch eines eines anderen Clients.
 */

export const CONFIRM_TTL_MS = 5 * 60_000

interface Pending {
  tokenId: string
  tool: string
  paramsHash: string
  expiresAt: number
}

const pending = new Map<string, Pending>()

/** Kanonisches JSON (sortierte Schlüssel), ohne das Bestätigungsfeld selbst. */
export function paramsHash(params: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .filter((k) => k !== 'confirmation_token')
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(canon(params))).digest('hex')
}

export function issueConfirmation(tokenId: string, tool: string, params: Record<string, unknown>, now = Date.now()): string {
  for (const [k, p] of pending) if (p.expiresAt < now) pending.delete(k)
  const token = `cfm_${randomBytes(18).toString('base64url')}`
  pending.set(token, { tokenId, tool, paramsHash: paramsHash(params), expiresAt: now + CONFIRM_TTL_MS })
  return token
}

export type ConfirmResult = 'ok' | 'unknown' | 'expired' | 'mismatch'

export function consumeConfirmation(
  token: string,
  tokenId: string,
  tool: string,
  params: Record<string, unknown>,
  now = Date.now(),
): ConfirmResult {
  const p = pending.get(token)
  if (!p) return 'unknown'
  if (p.expiresAt < now) {
    pending.delete(token)
    return 'expired'
  }
  // Ein Fehlversuch verbraucht das Token nicht: sonst könnte ein
  // fehlerhafter Aufruf eine berechtigte Bestätigung zunichtemachen.
  if (p.tokenId !== tokenId || p.tool !== tool || p.paramsHash !== paramsHash(params)) return 'mismatch'
  pending.delete(token)
  return 'ok'
}

export const __testing = { pending }
