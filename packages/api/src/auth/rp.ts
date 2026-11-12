import type { PasskeyHostDto } from '@airlock/shared'
import type { RpContext } from './service.js'

/**
 * Wo Passkeys gelten (RP-ID). Rein, ohne config.ts.
 *
 * Ein Passkey gehört zu genau einem Namen. Genommen wird die Hauptadresse
 * der Oberfläche, `<UI_HOST_LABEL>.<interne Basis>` – heute
 * `deployer.int.<basis>` (UI_HOST_LABEL in packages/shared). Bewusst nicht
 * die Basis selbst (`int.<basis>`): sonst könnte jede Projektseite unter
 * `*.int.<basis>` eine Passkey-Anmeldung für Airlock anstossen.
 *
 * WebAuthn verlangt HTTPS (ausser localhost). Auf nip.io-Adressen, ohne
 * internen Namen oder ohne Zertifikat gibt es keine Passkeys; die Anmeldung
 * sagt das und bietet Passwort + Authenticator-Code an.
 */
export function passkeyHostFor(o: {
  /** Host-Header der Anfrage (ohne Port) */
  host: string | null
  https: boolean
  /** HTTPS für die interne Basis eingerichtet (Wildcard-Zertifikat) */
  tls: boolean
  baseDomain: string | null
  label: string
  /** Entwicklung: localhost über HTTP erlaubt (nie im Betrieb) */
  dev: boolean
  /** Origin-Header (nur für localhost in der Entwicklung) */
  origin: string | null
}): { dto: PasskeyHostDto; rp: RpContext | null } {
  const host = (o.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (o.dev && host === 'localhost' && o.origin && /^http:\/\/localhost(:\d+)?$/.test(o.origin)) {
    return { dto: { available: true, rpId: 'localhost', mainUrl: null, reason: null }, rp: { rpID: 'localhost', origin: o.origin } }
  }
  const rpId = o.baseDomain ? `${o.label}.${o.baseDomain}` : null
  if (!rpId) return { dto: { available: false, rpId: null, mainUrl: null, reason: 'no_base_domain' }, rp: null }
  // Ohne Zertifikat (TLS_MODE=off) gibt es nirgends HTTPS – auch nicht unter der Hauptadresse
  if (!o.tls) return { dto: { available: false, rpId, mainUrl: null, reason: 'no_https' }, rp: null }
  const mainUrl = `https://${rpId}`
  if (host !== rpId) return { dto: { available: false, rpId, mainUrl, reason: 'other_host' }, rp: null }
  if (!o.https) return { dto: { available: false, rpId, mainUrl: null, reason: 'no_https' }, rp: null }
  return { dto: { available: true, rpId, mainUrl: null, reason: null }, rp: { rpID: rpId, origin: mainUrl } }
}

/** Host-Header als einzelner Wert */
export function hostHeader(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null
}
