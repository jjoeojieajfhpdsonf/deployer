/**
 * Welche Adresse ein Projekt hat. Reine Funktionen ohne Import von
 * config.ts, damit sie ohne gesetzte Umgebung testbar bleiben.
 *
 * Die primaere Adresse ist immer die, die tatsaechlich erreichbar ist:
 *
 *   Basisdomain gesetzt        -> <label>.<basisdomain>, nip.io als Alias
 *   keine Basisdomain          -> <label>.<ip-mit-bindestrichen>.nip.io, mit
 *                                 der Tailscale-IP, sonst der LAN-IP. Gibt es
 *                                 beide, ist der LAN-Name ein Alias (der
 *                                 IP-Filter entscheidet, wer durchkommt).
 *   weder noch                 -> <label>.int.invalid (reserviert, loest nie
 *                                 auf; der Start warnt laut)
 *
 * Ein Platzhalter wie "int.example.ch" darf nie als Adresse erscheinen: er
 * sieht echt aus und fuehrt ins Leere.
 */

export interface HostSettings {
  /** z.B. "int.meinedomain.ch"; null = noch nicht festgelegt */
  baseDomain: string | null
  lanIp: string | null
  /** Tailscale ist die Hauptadresse des Servers: nip.io zuerst darauf. */
  tailscaleIp?: string | null
  nipio: boolean
  /** M4: HTTPS mit Wildcard-Zertifikat für Namen unter der Basisdomain. */
  tls?: boolean
}

const nipFor = (label: string, ip: string) => `${label}.${ip.replace(/\./g, '-')}.nip.io`

/** Der nip.io-Name: auf der Tailscale-IP, wenn bekannt, sonst auf der LAN-IP. */
export function nipHost(label: string, s: HostSettings): string | null {
  const ip = s.tailscaleIp || s.lanIp
  if (!s.nipio || !ip) return null
  return nipFor(label, ip)
}

/** nip.io-Name mit der LAN-IP, wenn die Hauptadresse die Tailscale-IP ist. */
export function lanNipHost(label: string, s: HostSettings): string | null {
  if (!s.nipio || !s.lanIp || !s.tailscaleIp || s.lanIp === s.tailscaleIp) return null
  return nipFor(label, s.lanIp)
}

export function primaryHost(label: string, s: HostSettings): string {
  if (s.baseDomain) return `${label}.${s.baseDomain}`
  return nipHost(label, s) ?? `${label}.int.invalid`
}

/**
 * Weitere Namen derselben Route: mit Basisdomain der nip.io-Name; dazu der
 * nip.io-Name mit der LAN-IP, wenn Tailscale die Hauptadresse ist – so geht
 * «LAN» auch ohne lokalen DNS.
 */
export function aliasHosts(label: string, s: HostSettings): string[] {
  const out: string[] = []
  if (s.baseDomain) {
    const nip = nipHost(label, s)
    if (nip) out.push(nip)
  }
  const lan = lanNipHost(label, s)
  if (lan) out.push(lan)
  return out
}

/** Das Projekt-Label eines gespeicherten Hostnamens: alles vor dem ersten Punkt. */
export function labelOf(hostname: string): string {
  return hostname.split('.')[0] ?? hostname
}

/** Ob irgendeine Adresse erreichbar sein kann. */
export function anyReachable(s: HostSettings): boolean {
  return s.baseDomain !== null || nipHost('x', s) !== null
}

/** Normalisiert die Eingabe aus der Umgebung: leer heisst "nicht gesetzt". */
export function parseBaseDomain(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^\.+|\.+$/g, '').toLowerCase()
  return v === '' ? null : v
}

/**
 * URL eines Namens: https:// für Namen unter der Basisdomain, sobald TLS an
 * ist (Wildcard-Zertifikat, genau eine Ebene); sonst http:// (nip.io hat
 * kein Zertifikat).
 */
export function urlFor(host: string, s: HostSettings): string {
  const secure = Boolean(s.tls && s.baseDomain && coveredByWildcard(host, s.baseDomain))
  return `${secure ? 'https' : 'http'}://${host}`
}

/**
 * Liegt der Name im Wildcard-Zertifikat *.<baseDomain>? Genau eine Ebene,
 * ohne Gross-/Kleinschreibung. Die eine Regel für Caddy (welcher Server)
 * und für die URLs (welches Schema).
 */
export function coveredByWildcard(host: string, baseDomain: string): boolean {
  const h = host.toLowerCase()
  const b = baseDomain.toLowerCase()
  if (!h.endsWith(`.${b}`)) return false
  const label = h.slice(0, -(b.length + 1))
  return label.length > 0 && !label.includes('.')
}
