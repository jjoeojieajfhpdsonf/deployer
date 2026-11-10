import type { CfTlsPhase } from '@deployer/shared'
import type { TlsOptions } from '../drivers/caddy-config.js'

/**
 * TLS-Optionen für den Bau der Caddy-Konfiguration – aus dem gespeicherten
 * Stand der Zertifikats-Einrichtung. Rein, damit jeder Phasenwechsel testbar
 * ist (lib/tls-options.test.ts).
 *
 * Regeln:
 * - Sobald eine Einrichtung begonnen hat, enthält jeder Neubau :443. Nur
 *   «off» baut ohne TLS.
 * - Liegt ein gültiges produktives Wildcard-Zertifikat vor (gesehen, laut Log
 *   bezogen oder im Caddy-Speicher), verwaltet JEDE Phase *.<basis> mit der
 *   Produktions-CA – auch «failed» und «staging». Caddy lädt es dann aus dem
 *   Speicher und bestellt nichts.
 * - Der Staging-Probelauf verwaltet nie *.<basis>, sondern nur
 *   acme-probe.<basis>: So liegt nie ein Staging-Wildcard in Caddys Cache,
 *   den ein Neuladen überleben würde.
 * - «failed» ohne produktives Zertifikat: nur der Probe-Name bei Staging –
 *   Caddy bestellt im Hintergrund nichts produktiv (Rate-Limit).
 * - Wechselt die CA für *.<basis>, leert der Abgleich vorher Caddys Cache
 *   (domain/routes.ts, needsCacheEvict).
 */
export interface StoredTls {
  phase: CfTlsPhase
  ca: 'production' | 'staging'
}

export type TlsPlanForPhase = { mode: NonNullable<TlsOptions['mode']>; ca: 'staging' | 'production' }

export function planForPhase(phase: CfTlsPhase, prodUsable: boolean): TlsPlanForPhase {
  if (prodUsable) return { mode: 'wildcard', ca: 'production' }
  if (phase === 'production' || phase === 'done') return { mode: 'wildcard', ca: 'production' }
  return { mode: 'probe', ca: 'staging' }
}

export function tlsOptionsFor(
  tls: StoredTls | undefined,
  o: {
    baseDomain: string | null
    hasToken: boolean
    tokenFile: string
    email: string | null
    /** Gültiges produktives Zertifikat bekannt (lib/tls-plan.ts, Caddy-Speicher) */
    prodUsable?: boolean
    /** Alte Einrichtung über .env (compose.tls.yaml), nur ohne gespeicherten Stand */
    legacy?: { enabled: boolean; acmeCa: 'production' | 'staging'; email: string | null }
  },
): (TlsOptions & { redirect: boolean }) | null {
  if (tls) {
    if (!o.baseDomain || !o.hasToken || tls.phase === 'off') return null
    const plan = planForPhase(tls.phase, Boolean(o.prodUsable))
    return {
      baseDomain: o.baseDomain,
      acmeCa: plan.ca,
      mode: plan.mode,
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
