import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Caddys Zertifikatsspeicher lesen und aufräumen (Volume caddy_data, im
 * deployer unter CADDY_DATA_DIR eingebunden). Aufbau wie bei CertMagic:
 *
 *   <dir>/caddy/certificates/<ca-schlüssel>/<name>/<name>.crt
 *
 * <ca-schlüssel> ist Host + Pfad der ACME-URL («acme-v02.api.letsencrypt.org-
 * directory»), <name> der Zertifikatsname mit «*» → «wildcard_».
 */
export const CA_DIR_PRODUCTION = 'acme-v02.api.letsencrypt.org-directory'
export const CA_DIR_STAGING = 'acme-staging-v02.api.letsencrypt.org-directory'

const safeName = (name: string) => name.replace(/^\*\./, 'wildcard_.').toLowerCase()
export const certDir = (dataDir: string, caDir: string, name: string) => join(dataDir, 'caddy', 'certificates', caDir, safeName(name))

export interface StoredCert {
  path: string
  issuer: string | null
  sans: string[]
  validFrom: string
  validTo: string
}

/** Das (erste) Zertifikat einer .crt-Datei lesen; null, wenn es fehlt oder unlesbar ist. */
export function readStoredCert(dataDir: string, caDir: string, name: string): StoredCert | null {
  const dir = certDir(dataDir, caDir, name)
  const path = join(dir, `${safeName(name)}.crt`)
  if (!existsSync(path)) return null
  try {
    const pem = readFileSync(path, 'utf8')
    const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
    if (!first) return null
    const c = new X509Certificate(first)
    const field = (dn: string, key: string) => dn.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null
    const issuer = [field(c.issuer, 'O'), field(c.issuer, 'CN')].filter(Boolean).join(' – ') || null
    const sans = (c.subjectAltName ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4))
    return { path, issuer, sans, validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString() }
  } catch {
    return null
  }
}

/**
 * Gültiges produktives Wildcard-Zertifikat für *.<basis> im Speicher?
 * Geprüft: liegt unter der Produktions-CA, Aussteller nicht Staging, SAN
 * enthält genau *.<basis>, jetzt gültig und noch mindestens `minRemainingMs`.
 */
export function storedProductionWildcard(dataDir: string, base: string, now = new Date(), minRemainingMs = 7 * 86_400_000): StoredCert | null {
  const c = readStoredCert(dataDir, CA_DIR_PRODUCTION, `*.${base}`)
  if (!c) return null
  if (/staging/i.test(c.issuer ?? '')) return null
  if (!c.sans.some((n) => n.toLowerCase() === `*.${base}`.toLowerCase())) return null
  if (Date.parse(c.validFrom) > now.getTime()) return null
  if (Date.parse(c.validTo) - now.getTime() < minRemainingMs) return null
  return c
}

/** Staging-Zertifikat für *.<basis> aus dem Speicher löschen (aus früheren Probeläufen). true = es lag eins dort. */
export function removeStagingWildcard(dataDir: string, base: string): boolean {
  const dir = certDir(dataDir, CA_DIR_STAGING, `*.${base}`)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}
