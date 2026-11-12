import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Zugang «Airlock-Login» an Projekt-Adressen (Caddy forward_auth) – reine
 * Logik ohne Datenbank und Fastify.
 *
 * Ablauf:
 *  1. Besucher → https://app.int.example.ch/x. Caddy fragt Airlock
 *     (GET /api/v1/gate/check). Ohne gültigen Cookie: 302 auf
 *     https://<Oberfläche>/api/v1/gate/start?host=app.int.example.ch&rd=/x
 *  2. Auf der Oberfläche (eigener Host, Sitzungs-Cookie von Airlock): ohne
 *     Anmeldung erst zur Anmeldung (Passwort, Passkey, zweiter Faktor wie
 *     immer), dann ein einmaliger Code (60 s, an Host und Sitzung gebunden) →
 *     302 auf https://app.int.example.ch/.airlock/gate?code=…&rd=/x
 *  3. Caddy gibt diesen Pfad an Airlock (/api/v1/gate/callback). Airlock löst
 *     den Code ein und setzt den Cookie `airlock_gate` NUR für diesen Host
 *     (kein Domain-Attribut, HttpOnly, Secure, SameSite=Lax) → 302 auf /x.
 *  4. Jede weitere Anfrage: Caddy fragt Airlock; das Token ist mit dem
 *     Schlüssel von Airlock signiert, an Host und Sitzung gebunden und gilt nur,
 *     solange die Sitzung gilt (abmelden = überall abgemeldet). Caddy entfernt
 *     den Cookie, bevor die Anfrage an die App geht.
 *
 * Der Sitzungs-Cookie der Oberfläche verlässt ihren Host nie; eine App unter
 * einer anderen Adresse kann ihn weder lesen noch weiterreichen.
 */

export interface GateClaims { sid: string; host: string; exp: number }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

/** Token «<payload>.<signatur>»; sign = HMAC mit dem Schlüssel von Airlock (auth/service.ts) */
export function makeGateToken(c: GateClaims, sign: (data: string) => string): string {
  const payload = b64(JSON.stringify({ s: c.sid, h: c.host.toLowerCase(), e: c.exp }))
  return `${payload}.${sign(`gate:${payload}`)}`
}

/** Gültiges Token für genau diesen Host und noch nicht abgelaufen → Sitzungs-ID; sonst null */
export function readGateToken(token: string | null | undefined, host: string, now: number, sign: (data: string) => string): string | null {
  if (!token || token.length > 1024) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1))
  const want = Buffer.from(sign(`gate:${payload}`))
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null
  try {
    const c = JSON.parse(unb64(payload)) as { s?: unknown; h?: unknown; e?: unknown }
    if (typeof c.s !== 'string' || typeof c.h !== 'string' || typeof c.e !== 'number') return null
    if (c.h !== host.toLowerCase() || c.e <= now) return null
    return c.s
  } catch {
    return null
  }
}

/** Nur ein Pfad auf demselben Host – nie «//fremd.example» oder eine volle Adresse (offene Weiterleitung) */
export function safeReturnPath(rd: string | null | undefined): string {
  if (!rd || typeof rd !== 'string' || rd.length > 2048) return '/'
  if (!rd.startsWith('/') || rd.startsWith('//') || rd.startsWith('/\\') || /[\r\n]/.test(rd)) return '/'
  return rd
}

/** Host aus X-Forwarded-Host (ohne Port, klein); null, wenn er nicht wie ein Name aussieht */
export function cleanHost(h: string | string[] | undefined): string | null {
  const v = (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '') ?? ''
  return /^[a-z0-9.-]{1,253}$/.test(v) ? v : null
}

/** Einmalige Codes (60 s) zwischen Oberfläche und Projekt-Host; nur im Speicher */
export class GateCodes {
  private codes = new Map<string, { sid: string; host: string; exp: number }>()
  constructor(private ttlMs = 60_000) {}

  issue(sid: string, host: string, now: number): string {
    this.sweep(now)
    const code = randomBytes(24).toString('base64url')
    this.codes.set(code, { sid, host: host.toLowerCase(), exp: now + this.ttlMs })
    return code
  }

  /** Genau einmal, nur für den Host, für den er ausgestellt wurde */
  consume(code: string | null | undefined, host: string, now: number): string | null {
    if (!code) return null
    const c = this.codes.get(code)
    this.codes.delete(code)
    if (!c || c.exp <= now || c.host !== host.toLowerCase()) return null
    return c.sid
  }

  private sweep(now: number) {
    for (const [k, v] of this.codes) if (v.exp <= now) this.codes.delete(k)
  }
}
