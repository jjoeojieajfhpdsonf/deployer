import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { isDockerNet, isScannerPath, type AccessBlock, type AccessEntryDto } from '@airlock/shared'
import { CSP_REPORT_PREFIX, VISITS_LOG_FILE } from '../drivers/caddy-config.js'
import { isOwnProbe } from '../lib/probe-ua.js'
import { browserOf, campaignOf, languageOf, systemOf } from './agent.js'
import { botReason, countryOf, deviceOf, referrerOf, wayOf } from './classify.js'
import { header, parseAccessLine, type AccessLine } from './parse.js'

/**
 * Einzelaufrufe (Reiter «Besucher», bis «Besucher zusammen» «Zugriffe»):
 * einzelne Anfragen aus Caddys Zugriffs-Log
 * (visits.log und die rotierten Dateien, höchstens 2 Tage). Die Zeile wird
 * hier zum AccessEntryDto – die Adresse nur gekürzt, Header nur ausgewählt,
 * aus der Query nur utm_source/medium/campaign (wie in der Auswertung).
 * Rein bis auf readAccessLog (liest Dateien, nie schreibend).
 */

/** Adresse kürzen (Datenschutz): IPv4 ohne letztes Oktett, IPv6 nur die ersten drei Gruppen */
export function shortenIp(ip: string | undefined | null): string {
  if (!ip) return '–'
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean)
    return `${groups.slice(0, 3).join(':')}:…`
  }
  return ip
}

const TLS_NAMES: Record<number, string> = { 769: 'TLS 1.0', 770: 'TLS 1.1', 771: 'TLS 1.2', 772: 'TLS 1.3' }

/** «HTTP/2.0» → «HTTP/2», «HTTP/1.1» bleibt */
export const protoName = (p: string): string => p.replace(/^HTTP\/([23])\.0$/i, 'HTTP/$1')

/** Referrer ohne Query und Fragment (können Personendaten enthalten), höchstens 200 Zeichen */
export function cleanReferrer(referer: string): string {
  if (!referer) return ''
  try {
    const u = new URL(referer)
    return `${u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin}${u.pathname}`.slice(0, 200)
  } catch {
    return ''
  }
}

/** Sperre von Airlock: X-Airlock-Block, sonst Pause-Seite, sonst 429 am CSP-Endpunkt (Rate-Limit) */
export function blockOf(a: Pick<AccessLine, 'blockValue' | 'paused' | 'status' | 'path'>): AccessBlock | null {
  if (a.blockValue) return a.blockValue === 'ip-filter' || a.blockValue === 'pause' || a.blockValue === 'rate-limit' ? a.blockValue : 'other'
  if (a.paused) return 'pause'
  if (a.status === 429 && a.path.startsWith(CSP_REPORT_PREFIX)) return 'rate-limit'
  return null
}

/** Ausgewählte Kopfzeilen, gekürzt. Nie Cookie, Authorization oder Cloudflare-Ortsangaben. */
export const SHOWN_HEADERS = ['User-Agent', 'Accept-Language', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest', 'Sec-Fetch-User'] as const
const HEADER_MAX = 60

export function pickHeaders(a: Pick<AccessLine, 'headers' | 'blockValue'>): [string, string][] {
  const cut = (v: string) => (v.length > HEADER_MAX ? `${v.slice(0, HEADER_MAX).trimEnd()} …` : v)
  // eslint-disable-next-line no-control-regex
  const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, '')
  const out: [string, string][] = []
  for (const name of SHOWN_HEADERS) {
    const v = clean(header(a.headers, name))
    if (v) out.push([name.toLowerCase(), cut(v)])
  }
  if (a.blockValue) out.push(['x-airlock-block', cut(clean(a.blockValue))])
  return out
}

/** Stabile Kennung einer Zeile (gleich beim Lesen der Datei und im Live-Strom) */
export function accessId(a: Pick<AccessLine, 'at' | 'ip' | 'remoteIp' | 'method' | 'host' | 'path' | 'query' | 'status' | 'userAgent' | 'durationMs'>): string {
  const s = [a.ip, a.remoteIp, a.method, a.host, a.path, a.query, a.status, a.userAgent, a.durationMs ?? ''].join('\u001f')
  // FNV-1a, 32 Bit
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${a.at.toString(36)}-${(h >>> 0).toString(36)}`
}

export interface AccessLookups {
  asn?: (ip: string) => { asn: number; name: string } | null
  city?: (ip: string) => { city: string; country: string } | null
  isDatacenter: (asn: number) => boolean
}

/**
 * Eine gelesene Zeile → Eintrag der Einzelaufrufe (rein bis auf die Lookups).
 * ownHosts: alle Namen des Projekts – ein Referer darauf ist ein Klick
 * innerhalb der Seite (wie in der Auswertung, referrerOf).
 */
export function toAccessEntry(a: AccessLine, hostIsPublic: boolean, l: AccessLookups, ownHosts: ReadonlySet<string> = new Set([a.host])): AccessEntryDto {
  const way = wayOf(a.ip, hostIsPublic)
  // Über den Tunnel ist die Verbindung cloudflared (im Docker-Netz) – dort zählt der Absender laut Cloudflare
  const dockerNet = way !== 'public' && isDockerNet(a.remoteIp)
  const net = way === 'public' ? (l.asn?.(a.ip) ?? null) : null
  let country = way === 'public' ? countryOf(a.country) : ''
  let city = ''
  if (way === 'public') {
    if (a.cfCity) city = a.cfCity
    else {
      const c = l.city?.(a.ip)
      if (c) {
        city = c.city
        if (!country) country = c.country
      }
    }
  }
  return {
    id: accessId(a),
    at: new Date(a.at).toISOString(),
    method: a.method.slice(0, 12),
    host: a.host,
    // eslint-disable-next-line no-control-regex
    path: a.path.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300) || '/',
    status: a.status,
    block: blockOf(a),
    way,
    dockerNet,
    ip: shortenIp(dockerNet ? a.remoteIp : a.ip),
    country,
    city,
    network: net ? { asn: net.asn, name: net.name.slice(0, 100), datacenter: l.isDatacenter(net.asn) } : null,
    browser: browserOf(a.userAgent, a.chUa),
    system: systemOf(a.userAgent, a.chPlatform, a.chPlatformVersion),
    device: deviceOf(a.userAgent),
    language: languageOf(a.acceptLanguage),
    referrer: cleanReferrer(a.referer),
    source: referrerOf(a.referer, a.query, ownHosts),
    campaign: campaignOf(a.query),
    proto: protoName(a.proto),
    tls: TLS_NAMES[a.tlsVersion] ?? '',
    durationMs: a.durationMs,
    bytes: a.bytes,
    bot: botReason(a.userAgent, net?.asn ?? null),
    probe: isOwnProbe(a.userAgent),
    scanner: isScannerPath(a.path),
    headers: pickHeaders(a),
  }
}

/** visits.log und rotierte Dateien («visits-<zeit>.log», auch .gz), deren letzte Änderung nach sinceMs liegt */
export async function accessLogFiles(dir: string, sinceMs: number): Promise<string[]> {
  const stem = basename(VISITS_LOG_FILE, '.log')
  const names = await readdir(dir).catch(() => [] as string[])
  const out: string[] = []
  for (const n of names) {
    if (n !== VISITS_LOG_FILE && !(n.startsWith(`${stem}-`) && /\.log(\.gz)?$/.test(n))) continue
    const s = await stat(join(dir, n)).catch(() => null)
    if (s?.isFile() && s.mtimeMs >= sinceMs) out.push(join(dir, n))
  }
  return out
}

/**
 * Anfragen auf die Namen eines Projekts seit sinceMs aus allen Log-Dateien,
 * neueste zuerst, höchstens limit. capped: es gab mehr.
 */
export async function readAccessLog(
  dir: string,
  o: { hosts: ReadonlyMap<string, { public: boolean }>; sinceMs: number; limit: number; lookups: AccessLookups },
): Promise<{ entries: AccessEntryDto[]; capped: boolean }> {
  const files = await accessLogFiles(dir, o.sinceMs)
  // Schneller Vorfilter ohne JSON: der Name steht als "host":"…" in der Zeile
  const needles = [...o.hosts.keys()].map((h) => `"host":"${h}`)
  const lines: AccessLine[] = []
  for (const file of files) {
    const raw = createReadStream(file)
    const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
    const rl = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const lower = line.length < 64_000 ? line.toLowerCase() : ''
        if (!needles.some((n) => lower.includes(n))) continue
        const a = parseAccessLine(line)
        if (!a || a.at < o.sinceMs || !o.hosts.has(a.host)) continue
        lines.push(a)
      }
    } catch {
      // Datei während des Lesens rotiert oder unvollständig gepackt: was gelesen ist, gilt
    } finally {
      rl.close()
      raw.destroy()
    }
  }
  lines.sort((x, y) => y.at - x.at)
  const capped = lines.length > o.limit
  const own = new Set([...o.hosts.keys()].map((h) => h.toLowerCase()))
  const entries = lines.slice(0, o.limit).map((a) => toAccessEntry(a, o.hosts.get(a.host)!.public, o.lookups, own))
  // Doppelte (gleiche Zeile in alter und neuer Datei) nur einmal
  const seen = new Set<string>()
  return { entries: entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))), capped }
}
