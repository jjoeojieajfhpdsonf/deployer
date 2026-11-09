import type { CfTlsPhase } from '@deployer/shared'
import type { TlsOptions } from '../drivers/caddy-config.js'

/**
 * TLS-Optionen für den Bau der Caddy-Konfiguration – aus dem gespeicherten
 * Stand der Zertifikats-Einrichtung. Rein, damit jeder Phasenwechsel testbar
 * ist (lib/tls-options.test.ts).
 *
 * Regel: Sobald eine Einrichtung begonnen hat, enthält JEDER Neubau :443 und
 * die Wildcard-Policy – in staging, production, done UND failed. Nur «off»
 * (nie begonnen, zurückgesetzt oder getrennt) baut ohne TLS.
 *
 * Früher fiel TLS bei «failed» weg: Nach einer Zeitüberschreitung lud
 * deployer die Konfiguration ohne :443 neu, und ein längst bezogenes
 * Zertifikat lag ungenutzt im Speicher (autosave.json nur noch srv0 :80).
 * Mit TLS in «failed» liefert Caddy ein vorhandenes Zertifikat weiter aus
 * und versucht es selbst weiter (mit eigenem Backoff).
 */
export interface StoredTls {
  phase: CfTlsPhase
  ca: 'production' | 'staging'
}

export function tlsOptionsFor(
  tls: StoredTls | undefined,
  o: {
    baseDomain: string | null
    hasToken: boolean
    tokenFile: string
    email: string | null
    /** Alte Einrichtung über .env (compose.tls.yaml), nur ohne gespeicherten Stand */
    legacy?: { enabled: boolean; acmeCa: 'production' | 'staging'; email: string | null }
  },
): (TlsOptions & { redirect: boolean }) | null {
  if (tls) {
    if (!o.baseDomain || !o.hasToken || tls.phase === 'off') return null
    return {
      baseDomain: o.baseDomain,
      acmeCa: tls.ca,
      email: o.email,
      tokenFile: o.tokenFile,
      // http → https erst mit dem echten Zertifikat
      redirect: tls.phase === 'done',
    }
  }
  if (o.legacy?.enabled && o.baseDomain) {
    return { baseDomain: o.baseDomain, acmeCa: o.legacy.acmeCa, email: o.legacy.email, tokenFile: null, redirect: true }
  }
  return null
}
