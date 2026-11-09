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

/**
 * CA je Phase – ausdrücklich, nie aus einem gespeicherten Feld geerbt:
 * staging → Staging; production/done → Produktion; failed → Produktion nur
 * mit gültigem produktivem Zertifikat (Caddy liefert es aus und erneuert
 * es), sonst Staging: So bestellt Caddy nach einem Fehlschlag nicht im
 * Hintergrund weiter produktiv (Rate-Limit), und :443 bleibt trotzdem da.
 */
export function caFor(phase: CfTlsPhase, prodUsable: boolean): 'staging' | 'production' {
  if (phase === 'production' || phase === 'done') return 'production'
  if (phase === 'failed') return prodUsable ? 'production' : 'staging'
  return 'staging'
}

export function tlsOptionsFor(
  tls: StoredTls | undefined,
  o: {
    baseDomain: string | null
    hasToken: boolean
    tokenFile: string
    email: string | null
    /** Gültiges produktives Zertifikat bekannt (lib/tls-plan.ts) */
    prodUsable?: boolean
    /** Alte Einrichtung über .env (compose.tls.yaml), nur ohne gespeicherten Stand */
    legacy?: { enabled: boolean; acmeCa: 'production' | 'staging'; email: string | null }
  },
): (TlsOptions & { redirect: boolean }) | null {
  if (tls) {
    if (!o.baseDomain || !o.hasToken || tls.phase === 'off') return null
    return {
      baseDomain: o.baseDomain,
      acmeCa: caFor(tls.phase, Boolean(o.prodUsable)),
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
