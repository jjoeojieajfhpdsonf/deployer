import { isIPv4 } from 'node:net'
import { isbot } from 'isbot'
import { INTERNAL_REFERRER, isDatacenterAsn, type TrafficDevice, type TrafficWay } from '@airlock/shared'
import { isOwnProbe } from '../lib/probe-ua.js'
import { CSP_REPORT_PREFIX } from '../drivers/caddy-config.js'
import type { AccessLine } from './parse.js'

/**
 * Reine Regeln der Besucher-Auswertung: Zugang, Bot, Healthcheck, statische
 * Datei, Gerät, Referrer. Alles ohne Zustand und ohne I/O, damit es sich
 * einzeln testen lässt (classify.test.ts).
 */

const ipv4ToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0

/** IPv4 in CIDR (IPv6 nie) */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  const v4 = ip.replace(/^::ffff:/, '')
  if (!base || !isIPv4(v4) || !isIPv4(base)) return false
  const bits = Number(bitsRaw ?? 32)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(v4) & mask) === (ipv4ToInt(base) & mask)
}

/** Tailscale: 100.64.0.0/10 und das IPv6-Präfix fd7a:115c:a1e0::/48 */
export function isTailnetAddress(ip: string): boolean {
  return inCidr(ip, '100.64.0.0/10') || /^fd7a:115c:a1e0:/i.test(ip)
}

/**
 * Zugang einer Anfrage. Öffentliche Namen erreicht man nur über den
 * Cloudflare-Tunnel (Caddy lässt dort nur cloudflared zu) – also «public».
 * Sonst entscheidet die Absenderadresse: Tailnet-Bereich → tailnet, alles
 * andere → lan (Heimnetz; dazu zählen auch Anfragen vom Server selbst bzw.
 * über ein Docker-Gateway, siehe lib/client-ips.ts).
 */
export function wayOf(ip: string, hostIsPublic: boolean): TrafficWay {
  if (hostIsPublic) return 'public'
  return isTailnetAddress(ip) ? 'tailnet' : 'lan'
}

/** Bot nach User-Agent (isbot); ohne User-Agent ist es nie ein Browser */
export function isBotAgent(ua: string): boolean {
  return !ua.trim() || isbot(ua)
}

/**
 * Warum eine Anfrage als Bot zählt (rein, getestet): «ua» – der User-Agent
 * sagt es (isbot, oder er fehlt); «datacenter» – Browser-User-Agent, aber
 * aus dem Netz eines Hosters (DATACENTER_ASNS, «vermutlich Bot»); null –
 * Mensch. Ohne ASN-Datenbank (asn null) entscheidet nur der User-Agent.
 */
export function botReason(ua: string, asn: number | null): 'ua' | 'datacenter' | null {
  if (isBotAgent(ua)) return 'ua'
  if (asn !== null && isDatacenterAsn(asn)) return 'datacenter'
  return null
}

/** Übliche Pfade von Healthchecks und Uptime-Prüfungen */
const HEALTH_PATHS = new Set(['/health', '/healthz', '/healthcheck', '/livez', '/readyz', '/ping', '/_health', '/-/healthy', '/-/ready'])

/** Healthcheck: eigener Pfad des Projekts (Einstellungen › Container) oder ein üblicher */
export function isHealthcheck(path: string, projectPath: string | null | undefined): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  if (projectPath && projectPath !== '/' && p === (projectPath.replace(/\/+$/, '') || '/')) return true
  return HEALTH_PATHS.has(p.toLowerCase())
}

const ASSET_EXT = /\.(?:css|js|mjs|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|pdf|zip|gz|wasm|webmanifest)$/i
const PAGE_EXT = /\.(?:html?|php|aspx?)$/i

/**
 * Statische Datei statt Seite? Entscheidend ist der Content-Type der
 * Antwort (text/html = Seite). Ohne Content-Type (304, leere Antworten)
 * entscheidet die Endung: keine oder .html = Seite.
 */
export function isAsset(path: string, contentType: string): boolean {
  if (contentType) return !contentType.includes('text/html') && !contentType.includes('application/xhtml')
  if (PAGE_EXT.test(path)) return false
  const last = path.split('/').pop() ?? ''
  return ASSET_EXT.test(last) || /\.[a-z0-9]{1,8}$/i.test(last)
}

/** Grobes Gerät aus dem User-Agent */
export function deviceOf(ua: string): TrafficDevice {
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet'
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return 'mobile'
  return 'desktop'
}

/**
 * Referrer: nur der Host (ohne «www.», ohne Pfad und Query – die können
 * Personendaten enthalten). Eigene Namen des Projekts sind ein Klick
 * innerhalb der Seite (INTERNAL_REFERRER) – bis «Besucher neu» landeten sie
 * als '' bei «direkt», das machte «direkt» zur grössten Quelle ohne
 * Besucher. Ohne Referer: utm_source bzw. ref aus der Query, falls gesetzt,
 * sonst '' (direkt oder Lesezeichen).
 */
export function referrerOf(referer: string, query: string, ownHosts: ReadonlySet<string>): string {
  if (referer) {
    try {
      const u = new URL(referer)
      const host = u.hostname.toLowerCase()
      if (!host) return ''
      if (ownHosts.has(host)) return INTERNAL_REFERRER
      if (u.protocol === 'android-app:') return host.slice(0, 100)
      return host.replace(/^www\./, '').slice(0, 100)
    } catch {
      return ''
    }
  }
  if (query) {
    const p = new URLSearchParams(query)
    const s = (p.get('utm_source') ?? p.get('ref') ?? '').trim().toLowerCase()
    if (s && /^[a-z0-9.\-_ ]{1,60}$/.test(s)) return s
  }
  return ''
}

/** Pfad für die Zähler: ohne Query, höchstens 200 Zeichen, ohne Steuerzeichen */
export function normalizePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = path.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
  return clean.startsWith('/') ? clean : `/${clean}`
}

/** CF-IPCountry: zwei Buchstaben, «XX» (unbekannt) leer, «T1» (Tor) bleibt */
export function countryOf(header: string): string {
  const c = header.toUpperCase()
  if (c === 'T1') return 'T1'
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : ''
}

/**
 * Was mit einer Anfrage passiert:
 * ignore – gar nicht (eigene Prüfung von Airlock),
 * live – nur im Live-Strom (gesperrt, kein GET, Healthcheck, CSP-Meldung, statische Datei),
 * bot – als Bot gezählt, page – als Aufruf gezählt.
 */
export type Verdict = 'ignore' | 'live' | 'bot' | 'page'

export function verdictOf(
  a: Pick<AccessLine, 'userAgent' | 'blocked' | 'method' | 'path' | 'contentType'>,
  o: { healthPath?: string | null; hasPages: boolean; asn?: number | null },
): Verdict {
  if (isOwnProbe(a.userAgent)) return 'ignore'
  if (a.blocked) return 'live'
  if (a.method !== 'GET') return 'live'
  if (a.path.startsWith(CSP_REPORT_PREFIX) || a.path.startsWith('/.well-known/airlock/')) return 'live'
  if (isHealthcheck(a.path, o.healthPath)) return 'live'
  if (botReason(a.userAgent, o.asn ?? null)) return 'bot'
  // Statische Dateien nur, solange die Seite HTML hat – besteht sie nur aus Dateien, zählen diese
  if (o.hasPages && isAsset(a.path, a.contentType)) return 'live'
  return 'page'
}
