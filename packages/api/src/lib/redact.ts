/**
 * Geheimnisse aus Fehlertexten entfernen, bevor sie angezeigt, geloggt oder
 * ins Audit-Log geschrieben werden. Caddy, Cloudflare und cloudflared geben
 * Tokens teils im Klartext aus (z.B. caddy-dns/cloudflare: «API token '…'
 * appears invalid»).
 *
 * Zwei Stufen:
 * 1. Bekannte Werte (registerSecret): das gespeicherte Cloudflare-Token, das
 *    Tunnel-Token – egal, wie sie aussehen.
 * 2. Muster für alles, was wie ein Cloudflare-Token aussieht:
 *    - neues Format mit Präfix: cfut_…, cfat_… (allgemein cf<buchstaben>_…)
 *    - altes Format: genau 40 Zeichen [A-Za-z0-9_-] mit Ziffer, Gross- und
 *      Kleinbuchstabe. Git-Commits (Hex), Slugs und Namen bleiben stehen.
 *    - cloudflared-Tunnel-Token: base64 von {"a":"…  → beginnt mit eyJhIjoi
 */

export const REDACTED = '***'

const known = new Set<string>()

/** Wert merken, der nie in einer Meldung auftauchen darf (ab 8 Zeichen). */
export function registerSecret(value: string | null | undefined): void {
  const v = value?.trim()
  if (v && v.length >= 8) known.add(v)
}

/** Nur für Tests. */
export function clearSecrets(): void {
  known.clear()
}

// Ausgenommen: cfm_ – Airlocks eigene MCP-Bestätigungscodes (mcp/confirm.ts),
// kurzlebig und im Audit-Log gewollt.
const PREFIXED = /\bcf(?!m_)[a-z]{1,4}_[A-Za-z0-9_-]{16,}/g
const TUNNEL = /\beyJhIjoi[A-Za-z0-9+/_=-]{20,}/g
// 40 Zeichen, nicht Teil eines längeren Worts aus denselben Zeichen
const LEGACY = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/g
// Zufallstoken mischen Ziffern, Gross- und Kleinbuchstaben; Hex-Hashes,
// Slugs und Namen tun das nicht.
const looksRandom = (m: string) => /[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m)

export function redactSecrets(text: string): string
export function redactSecrets(text: string | null | undefined): string | null | undefined
export function redactSecrets(text: string | null | undefined): string | null | undefined {
  if (!text) return text
  let out = text
  // Längste zuerst, damit ein enthaltener kürzerer Wert nicht Reste übriglässt
  for (const s of [...known].sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join(REDACTED)
  }
  out = out.replace(PREFIXED, REDACTED).replace(TUNNEL, REDACTED)
  out = out.replace(LEGACY, (m) => (looksRandom(m) ? REDACTED : m))
  return out
}

/** Alle Strings in einem JSON-tauglichen Wert schwärzen (für Audit-Parameter). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}
