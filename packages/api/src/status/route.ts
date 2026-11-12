import { HEADER_DEFAULT, STATUS_CSP, templateHeaderKeys, type HeaderKey } from '@airlock/shared'
import type { RouteSpec } from '../drivers/caddy-config.js'
import type { HeaderRuleSpec } from '../security/header-rules.js'

/**
 * Etappe 5: Caddy-Route der Statusseite – rein (ohne Datenbank und config),
 * damit sie sich ohne Umgebung testen lässt.
 *
 * Header wie bei Projekten: die Vorlagen der Umgebung (X-Content-Type-Options,
 * Referrer-Policy, frame-ancestors, HSTS); fehlt eine Vorlage, der
 * Airlock-Standard. Dazu eine feste, scharfe CSP (nur eigene Dateien) und
 * die Permissions-Policy. Öffentlich heisst wie bei Projekten: nur von
 * cloudflared (cidrs = Adresse von cloudflared im Netz «tunnel»).
 */
export function statusHeaderRules(templates: readonly { header: HeaderKey; value: string; mode: string }[]): HeaderRuleSpec[] {
  const out: HeaderRuleSpec[] = []
  for (const key of templateHeaderKeys) {
    const t = templates.find((x) => x.header === key)
    out.push({ header: key, value: t?.value ?? HEADER_DEFAULT[key], mode: 'enforce' })
  }
  out.push({ header: 'content-security-policy', value: STATUS_CSP, mode: 'enforce' })
  out.push({ header: 'permissions-policy', value: HEADER_DEFAULT['permissions-policy'], mode: 'enforce' })
  return out
}

export interface StatusRouteInput {
  hostname: string
  /** Ordner der Umgebung im Volume (Slug der Umgebung) */
  dir: string
  upstream: string
  /** Adressen von cloudflared; leer = kein Tunnel, keine Route */
  edgeCidrs: string[]
  templates: readonly { header: HeaderKey; value: string; mode: string }[]
}

export function statusRouteSpec(i: StatusRouteInput): RouteSpec | null {
  if (!i.edgeCidrs.length) return null
  return {
    hosts: [i.hostname],
    kind: 'status',
    statusDir: i.dir,
    upstream: i.upstream,
    cidrs: i.edgeCidrs,
    headers: statusHeaderRules(i.templates),
    // Kein Besucher-Log: die Statusseite ist kein Projekt
    visits: false,
  }
}
