import { connect, type PeerCertificate } from 'node:tls'

/**
 * Zertifikatsstatus (M4): deployer verbindet sich per TLS mit Caddy und
 * liest das ausgelieferte Zertifikat. Kein Import von config.ts.
 */

export interface CertInfo {
  ok: boolean
  subject: string | null
  issuer: string | null
  validTo: string | null
  daysLeft: number | null
  error: string | null
}

export const WARN_DAYS = 14

/**
 * Reine Regel: wann ist das Zertifikat ein Problem? Verändert nichts.
 * Mit staging=true zählt eine nicht vertrauenswürdige Kette nicht: Die
 * Staging-CA von Let's Encrypt kennt kein Browser und kein Node; geprüft
 * werden dann nur Vorhandensein und Ablauf (Review M4).
 */
export function certProblem(c: CertInfo, now = new Date(), o: { staging?: boolean } = {}): string | null {
  // Nur die Staging-CA selbst (Aussteller «(STAGING) Let's Encrypt»), kein
  // beliebiges selbst signiertes Zertifikat.
  const untrustedOnly = Boolean(o.staging && c.validTo && /staging/i.test(c.issuer ?? ''))
  if (!c.ok && !untrustedOnly) return `Kein gültiges Zertifikat: ${c.error ?? 'unbekannter Fehler'}`
  const days = daysLeftOf(c, now)
  if (days !== null && days < WARN_DAYS) return `Zertifikat läuft in ${days} Tagen ab (${c.validTo})`
  return null
}

export function daysLeftOf(c: CertInfo, now = new Date()): number | null {
  if (c.daysLeft !== null) return c.daysLeft
  return c.validTo ? Math.floor((Date.parse(c.validTo) - now.getTime()) / 86_400_000) : null
}

export function describeCert(cert: PeerCertificate, authorized: boolean, authError: string | null, now = new Date()): CertInfo {
  const validTo = cert.valid_to ? new Date(cert.valid_to).toISOString() : null
  const daysLeft = validTo ? Math.floor((Date.parse(validTo) - now.getTime()) / 86_400_000) : null
  const cn = (o: unknown) => {
    const v = (o as Record<string, string | string[]> | undefined)?.CN
    return Array.isArray(v) ? v[0] ?? null : v ?? null
  }
  const issuerO = (cert.issuer as unknown as Record<string, string> | undefined)?.O
  return {
    ok: authorized,
    subject: cn(cert.subject),
    issuer: [issuerO, cn(cert.issuer)].filter(Boolean).join(' – ') || null,
    validTo,
    daysLeft,
    error: authorized ? null : authError,
  }
}

/** Fragt das Zertifikat ab, das Caddy für `servername` ausliefert. */
export function probeCert(host: string, port: number, servername: string, timeoutMs = 5000): Promise<CertInfo> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate()
      const info = cert && Object.keys(cert).length
        ? describeCert(cert, sock.authorized, sock.authorizationError ? String(sock.authorizationError) : null)
        : { ok: false, subject: null, issuer: null, validTo: null, daysLeft: null, error: 'kein Zertifikat ausgeliefert' }
      sock.end()
      resolve(info)
    })
    const fail = (msg: string) => {
      sock.destroy()
      resolve({ ok: false, subject: null, issuer: null, validTo: null, daysLeft: null, error: msg })
    }
    sock.on('timeout', () => fail('Zeitüberschreitung'))
    sock.on('error', (e) => fail(e.message))
  })
}
