import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

/**
 * API-Tokens für MCP-Clients und Skripte.
 *
 * Format: "dpl_" + 43 Zeichen base64url (32 Zufallsbytes). Das Präfix macht
 * Tokens in Logs und beim Secret-Scanning erkennbar. Gespeichert wird nur
 * der SHA-256: das Token ist zufällig und lang, ein langsamer Hash bringt
 * nichts gegen Wörterbuchangriffe, die hier nicht greifen.
 */

export const TOKEN_PREFIX = 'dpl_'
const TOKEN_RE = /^dpl_[A-Za-z0-9_-]{43}$/

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function looksLikeToken(value: string): boolean {
  return TOKEN_RE.test(value)
}

/** Vergleich zweier Hashes in konstanter Zeit. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb)
}

/** Liest "Authorization: Bearer <token>". */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return m ? m[1]! : null
}
