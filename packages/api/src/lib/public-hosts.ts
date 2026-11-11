import type { IngressRule, Zone } from '../drivers/cloudflare.js'
import { zoneFor } from '../drivers/cloudflare.js'

/**
 * M5: Öffentliche Namen und Tunnel-Ingress – reine Funktionen ohne config,
 * damit sie ohne Umgebung testbar sind.
 */

export class PublicHostError extends Error {}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * Prüft einen gewünschten öffentlichen Namen und liefert ihn mit Zone.
 *
 * Abgelehnt: Namen unter der internen Basisdomain (die sind intern), die
 * Zone selbst (Apex), mehr als eine Ebene unter der Zone (Universal-SSL von
 * Cloudflare deckt nur eine), Namen ausserhalb der Zonen des Kontos, und
 * reservierte Labels (deployer/airlock: die Oberfläche wird nie öffentlich).
 */
export function resolvePublicHostname(
  input: { subdomain?: string; hostname?: string },
  o: { zones: Zone[]; defaultZone: string | null; internalBaseDomain: string | null; reservedLabels: readonly string[]; allowApex?: boolean },
): { hostname: string; zone: Zone } {
  let host: string
  if (input.hostname) host = input.hostname.trim().toLowerCase().replace(/\.$/, '')
  else if (input.subdomain) {
    if (!o.defaultZone) throw new PublicHostError('Keine Standard-Domain gesetzt; bitte einen vollen Hostnamen angeben oder unter System › Cloudflare & HTTPS eine Standard-Domain wählen')
    host = `${input.subdomain.trim().toLowerCase()}.${o.defaultZone}`
  } else throw new PublicHostError('Für "public" braucht es eine Subdomain oder einen Hostnamen')

  const labels = host.split('.')
  if (!labels.every((l) => LABEL.test(l))) throw new PublicHostError(`"${host}" ist kein gültiger Hostname`)
  const b = o.internalBaseDomain
  if (b && (host === b || host.endsWith(`.${b}`))) throw new PublicHostError(`"${host}" liegt unter der internen Basisdomain und kann nicht öffentlich sein`)
  const zone = zoneFor(host, o.zones)
  if (!zone) throw new PublicHostError(`"${host}" gehört zu keiner Zone dieses Cloudflare-Kontos`)
  // Direkt unter der Zone (apex) nur ausdrücklich (Schalter «Direkt unter <zone>»)
  if (host === zone.name.toLowerCase()) {
    if (o.allowApex) return { hostname: host, zone }
    throw new PublicHostError(`Die Zone selbst (${host}) ist kein Projektname; bitte eine Subdomain wählen oder ausdrücklich «direkt unter ${host}»`)
  }
  const sub = host.slice(0, -(zone.name.length + 1))
  if (sub.includes('.')) throw new PublicHostError(`"${host}" liegt mehr als eine Ebene unter ${zone.name}; das Zertifikat von Cloudflare deckt nur eine`)
  if (o.reservedLabels.includes(sub)) throw new PublicHostError(`"${sub}" ist reserviert`)
  return { hostname: host, zone }
}

/** Ziel jeder öffentlichen Regel: Caddy im Docker-Netz. */
export const TUNNEL_SERVICE = 'http://caddy:80'
export const CATCH_ALL: IngressRule = { service: 'http_status:404' }

/**
 * Neue Ingress-Liste. cloudflared nimmt die erste passende Regel; deshalb:
 *
 *   1. die eigenen Namen (genau, kein Platzhalter) zuerst – eine fremde
 *      Wildcard wie *.example.ch würde sie sonst verdecken,
 *   2. alle fremden Regeln in ihrer bisherigen Reihenfolge, auch solche nur
 *      mit Pfad,
 *   3. die bisherige Auffangregel (letzte Regel ohne Hostnamen), sonst
 *      http_status:404.
 *
 * managedBefore: Namen, die Airlock früher gesetzt hat. Was darin steht,
 * aber nicht mehr gewünscht ist, fliegt raus (Review M5).
 */
export function reconcileIngress(current: IngressRule[], wanted: string[], managedBefore: string[], forbidden: string[] = []): { ingress: IngressRule[]; managed: string[] } {
  const want = [...new Set(wanted.map((h) => h.toLowerCase()))].filter((h) => !forbidden.includes(h)).sort()
  const mine = new Set([...managedBefore.map((h) => h.toLowerCase()), ...want])
  const last = current.at(-1)
  const catchAll = last && !last.hostname && !last.path ? last : CATCH_ALL
  const body = last === catchAll ? current.slice(0, -1) : current
  const foreign = body.filter((r) => !(r.hostname && mine.has(r.hostname.toLowerCase())))
  const ingress: IngressRule[] = [
    ...want.map((hostname) => ({ hostname, service: TUNNEL_SERVICE })),
    ...foreign,
    catchAll,
  ]
  return { ingress, managed: want }
}

export const tunnelCname = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`
