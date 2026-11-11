/**
 * User-Agent aller eigenen Prüfungen von Airlock (Adressen, Header, CSP,
 * Healthchecks, Prüfung von aussen, Browser-Check). Daran erkennt die
 * Auswertung der Absenderadressen (lib/client-ips.ts) eigene Anfragen und
 * zählt sie nicht als fremde Zugriffe vom Docker-Gateway.
 */
export const PROBE_UA = 'airlock-probe'

/** «airlock-probe (adresse)» usw. */
export const probeUa = (what: string) => `${PROBE_UA} (${what})`

/** Eigene Prüfung? Auch die älteren Kennungen vor «airlock-probe». */
export function isOwnProbe(userAgent: string | null | undefined): boolean {
  return /^(airlock-probe|airlock-csp-check|airlock-outside-check|deployer-)/i.test((userAgent ?? '').trim())
}
