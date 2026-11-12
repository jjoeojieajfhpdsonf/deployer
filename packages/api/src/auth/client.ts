import { isIPv4, isIPv6 } from 'node:net'
import type { SessionAccess } from '@airlock/shared'

/**
 * Wer fragt an? Reine Funktionen für Gerät (aus dem User-Agent), Zugang
 * (aus der Adresse) und die echte Absenderadresse hinter Caddy.
 */

/** «Firefox auf macOS» – grob, nur fürs Wiedererkennen in der Sitzungsliste; null, wenn unklar */
export function deviceLabel(ua: string | null | undefined): string | null {
  if (!ua) return null
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /curl\//.test(ua) ? 'curl'
    : null
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null
  if (browser && os) return `${browser} auf ${os}`
  return browser ?? os
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}

export function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (!net || !isIPv4(ip) || !isIPv4(net) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask)
}

/** IPv4-gemappte IPv6-Adresse (::ffff:192.168.1.5) auf IPv4 kürzen */
export function plainIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  return m ? m[1]! : ip
}

/**
 * Zugang aus der Adresse: Tailnet (100.64.0.0/10), LAN (das LAN-Netz des
 * Servers), sonst privates Docker-Netz (Gateway – maskierter Tailnet-Verkehr
 * oder der Server selbst, nicht unterscheidbar), Loopback = Server.
 */
export function accessOf(ipRaw: string | null, lanCidr: string | null): SessionAccess {
  const ip = plainIp(ipRaw)
  if (!ip) return 'unknown'
  if (ip === '127.0.0.1' || ip === '::1') return 'server'
  if (isIPv4(ip)) {
    if (inCidr(ip, '100.64.0.0/10')) return 'tailnet'
    if (lanCidr && inCidr(ip, lanCidr)) return 'lan'
    if (inCidr(ip, '172.16.0.0/12')) return 'gateway'
    if (inCidr(ip, '10.0.0.0/8') || inCidr(ip, '192.168.0.0/16')) return 'lan'
    return 'unknown'
  }
  if (isIPv6(ip) && /^fd7a:115c:a1e0:/i.test(ip)) return 'tailnet'
  return 'unknown'
}

/**
 * Echte Absenderadresse. Airlock steht hinter Caddy und sieht nur Caddys
 * Adresse; Caddy setzt X-Forwarded-For selbst (fremde Werte übernimmt es nur
 * von vertrauten Proxys, und für die Oberfläche gibt es keine). Dem Header
 * glauben wir deshalb nur, wenn die Verbindung wirklich von Caddy kommt –
 * sonst könnte jeder, der Airlock direkt erreicht, eine Adresse vortäuschen
 * und die Sperre nach Fehlversuchen umgehen.
 */
export function clientIp(peer: string | null | undefined, forwardedFor: string | string[] | undefined, trustedPeers: ReadonlySet<string>): string {
  const p = plainIp(peer) ?? 'unbekannt'
  if (!trustedPeers.has(p)) return p
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  if (!raw) return p
  // Der letzte Eintrag ist der, den Caddy selbst angehängt hat
  const last = raw.split(',').map((s) => s.trim()).filter(Boolean).pop()
  const ip = plainIp(last)
  return ip && (isIPv4(ip) || isIPv6(ip)) ? ip : p
}
