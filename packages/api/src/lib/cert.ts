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
  /** Namen aus subjectAltName (DNS:…), sonst leer */
  sans?: string[]
  validFrom?: string | null
}

/** Aussteller der Staging-CA von Let's Encrypt: «(STAGING) Let's Encrypt – (STAGING) …» */
export const isStagingIssuer = (issuer: string | null | undefined) => /staging/i.test(issuer ?? '')

/** Deckt `pattern` (Name oder *.wildcard, eine Ebene) den Namen `host`? */
export function nameCovers(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p === h) return true
  if (!p.startsWith('*.')) return false
  const rest = p.slice(1) // ".int.example.ch"
  return h.endsWith(rest) && !h.slice(0, -rest.length).includes('.') && h.length > rest.length
}

export type CertVerdict = { ready: true } | { ready: false; reason: string }

/**
 * Liefert Caddy ein produktives Zertifikat für *.<basis> aus (nicht Staging,
 * nicht Caddys eigenes, jetzt gültig)? Ohne Vertrauensprüfung – dafür
 * checkIssuedCert(phase: 'production'). Dient dem Rate-Limit-Schutz: ein
 * solches Zertifikat liegt in Caddys Speicher und wird nicht neu bestellt.
 */
export function productionIssued(c: CertInfo, base: string, now = new Date()): boolean {
  if (!c.validTo) return false
  if (isStagingIssuer(c.issuer) || /caddy local authority/i.test(c.issuer ?? '')) return false
  const names = c.sans?.length ? c.sans : c.subject ? [c.subject] : []
  if (!names.some((n) => n.toLowerCase() === `*.${base}`.toLowerCase())) return false
  if (c.validFrom && Date.parse(c.validFrom) > now.getTime()) return false
  return Date.parse(c.validTo) > now.getTime()
}

/**
 * Ist das ausgelieferte Zertifikat das erwartete Wildcard-Zertifikat?
 * - staging: OHNE Prüfung der Kette (die Staging-CA ist absichtlich nicht
 *   vertrauenswürdig). Geprüft: Aussteller ist die Staging-CA, der Name
 *   *.<basis> steht im Zertifikat, es ist jetzt gültig.
 * - production: zusätzlich vertrauenswürdige Kette, und nicht mehr Staging.
 */
export function checkIssuedCert(c: CertInfo, o: { base: string; phase: 'staging' | 'production'; now?: Date }): CertVerdict {
  const now = o.now ?? new Date()
  const wildcard = `*.${o.base}`
  if (!c.validTo) return { ready: false, reason: c.error ?? 'kein Zertifikat ausgeliefert' }
  if (/caddy local authority/i.test(c.issuer ?? '')) return { ready: false, reason: `Caddy liefert noch sein eigenes Zertifikat aus (${c.issuer})` }
  const names = c.sans?.length ? c.sans : c.subject ? [c.subject] : []
  if (!names.some((n) => n.toLowerCase() === wildcard.toLowerCase())) {
    return { ready: false, reason: `ausgeliefertes Zertifikat gilt für ${names.join(', ') || 'keinen Namen'}, nicht für ${wildcard} (Aussteller ${c.issuer ?? 'unbekannt'})` }
  }
  if (c.validFrom && Date.parse(c.validFrom) > now.getTime()) return { ready: false, reason: `Zertifikat erst gültig ab ${c.validFrom}` }
  if (Date.parse(c.validTo) <= now.getTime()) return { ready: false, reason: `Zertifikat abgelaufen am ${c.validTo}` }
  const staging = isStagingIssuer(c.issuer)
  if (o.phase === 'staging') {
    if (staging) return { ready: true }
    // Häufig: ein produktives Zertifikat aus einem früheren Lauf – Caddys
    // Zertifikats-Cache überlebt das Neuladen der Konfiguration.
    return {
      ready: false,
      reason: c.ok
        ? `Caddy liefert schon ein produktives Zertifikat aus (${c.issuer ?? 'unbekannt'})`
        : `Aussteller ist nicht die Staging-CA: ${c.issuer ?? 'unbekannt'}; produktiv, aber Kette nicht vertrauenswürdig: ${c.error ?? 'unbekannter Fehler'}`,
    }
  }
  if (staging) return { ready: false, reason: `noch das Staging-Zertifikat (${c.issuer})` }
  if (!c.ok) return { ready: false, reason: `Kette nicht vertrauenswürdig: ${c.error ?? 'unbekannter Fehler'}` }
  return { ready: true }
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
  const sans = (cert.subjectaltname ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4))
  return {
    ok: authorized,
    subject: cn(cert.subject),
    issuer: [issuerO, cn(cert.issuer)].filter(Boolean).join(' – ') || null,
    validTo,
    daysLeft,
    error: authorized ? null : authError,
    sans,
    validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
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
