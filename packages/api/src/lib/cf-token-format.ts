/**
 * Format eines Cloudflare-API-Tokens, wie es caddy-dns/cloudflare beim Laden
 * prüft (cloudflare.go, validCloudflareToken): altes Format 35–50 Zeichen
 * aus A–Z a–z 0–9 _ -, neues Format «cfut_»/«cfat_» mit 32–256 Zeichen.
 *
 * M9: Lehnt das Modul ein Token ab, scheitert das Laden der GANZEN
 * Caddy-Konfiguration – auch die Zertifikate aller anderen Umgebungen
 * (gefunden mit scripts/m9-caddy-two-bases-e2e.ts). Airlock prüft deshalb
 * beim Speichern genau so und lässt eine Basis mit unbrauchbarem Token beim
 * Abgleich weg, statt alle mitzureissen.
 */
const LEGACY = /^[A-Za-z0-9_-]{35,50}$/
const CURRENT = /^cf(ut|at)_[A-Za-z0-9_-]{32,256}$/

export function caddyAcceptsCloudflareToken(token: string | null | undefined): boolean {
  if (!token) return false
  return CURRENT.test(token) || LEGACY.test(token)
}
