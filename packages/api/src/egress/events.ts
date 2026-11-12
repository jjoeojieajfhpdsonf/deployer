import type { EgressAttemptDto, EgressVerdict } from '@airlock/shared'

/**
 * Nacht 3, Etappe 4: protokollierte Pakete des Firewall-Dienstes lesen und
 * bündeln – reine Funktionen (events.test.ts).
 *
 * Zeilen in events.log (firewall/airlock-fw, reader): «<gruppe> <tcpdump -tt -n -q>»
 *   7801 1794482145.285395 IP 192.168.16.3.37619 > 192.168.16.1.23835: tcp 0
 *   7802 1794482146.373525 IP 172.20.0.3.40000 > 192.168.0.1.53: UDP, length 30
 *   7802 1794482146.373525 IP 172.20.0.3 > 192.168.0.1: ICMP echo request, id 3, seq 0, length 64
 *   7801 1794482146.373525 IP6 fd00::2.40000 > fd00::1.80: tcp 0
 * Die Gruppe sagt das Urteil (beobachtet/gesperrt), die Quelle das Projekt-Netz.
 */

export interface EgressEvent {
  at: Date
  verdict: EgressVerdict
  protocol: EgressAttemptDto['protocol']
  source: string
  destination: string
  port: number | null
}

/** «addr.port» bzw. «addr» (ICMP) trennen; IPv4 hat ohne Port genau 4 Teile */
function splitAddr(raw: string, v6: boolean): { addr: string; port: number | null } {
  const dot = raw.lastIndexOf('.')
  if (v6) {
    if (dot < 0) return { addr: raw, port: null }
    return { addr: raw.slice(0, dot), port: Number(raw.slice(dot + 1)) }
  }
  const parts = raw.split('.')
  if (parts.length === 5) return { addr: parts.slice(0, 4).join('.'), port: Number(parts[4]) }
  return { addr: raw, port: null }
}

const LINE_RE = /^(\d{1,5}) (\d{9,11})(?:\.\d+)? (IP6?) (\S+) > (\S+?): (.*)$/

export function parseEgressLine(line: string, groups: { observe: number; block: number }): EgressEvent | null {
  const m = LINE_RE.exec(line.trim())
  if (!m) return null
  const group = Number(m[1])
  const verdict: EgressVerdict | null = group === groups.observe ? 'beobachtet' : group === groups.block ? 'gesperrt' : null
  if (!verdict) return null
  const v6 = m[3] === 'IP6'
  const src = splitAddr(m[4]!, v6)
  const dst = splitAddr(m[5]!, v6)
  const rest = m[6]!
  const protocol: EgressEvent['protocol'] = /^tcp\b/.test(rest) ? 'tcp' : /^UDP\b/.test(rest) ? 'udp' : /^ICMP/.test(rest) ? 'icmp' : 'andere'
  const port = protocol === 'tcp' || protocol === 'udp' ? dst.port : null
  if (port !== null && !(Number.isInteger(port) && port >= 0 && port <= 65535)) return null
  const okAddr = v6 ? /^[0-9a-f:]+$/i.test(dst.addr) && /^[0-9a-f:]+$/i.test(src.addr) : /^[0-9.]+$/.test(dst.addr) && /^[0-9.]+$/.test(src.addr)
  if (!okAddr) return null
  return { at: new Date(Number(m[2]) * 1000), verdict, protocol, source: src.addr, destination: dst.addr.toLowerCase(), port }
}

/* --- Bündeln ------------------------------------------------------------------- */

export interface EgressAttemptRow {
  projectId: string
  verdict: EgressVerdict
  protocol: string
  destination: string
  /** 0 = ohne Port */
  port: number
  /** Beginn der Stunde */
  bucket: Date
  count: number
  toServer: boolean
  firstSeen: Date
  lastSeen: Date
}

const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000)

/**
 * Ereignisse je Projekt, Urteil, Protokoll, Ziel, Port und Stunde zählen.
 * projectOf ordnet die Quelladresse einem Projekt zu (Subnetz des Netzes);
 * unbekannte Quellen (Netz inzwischen weg) fallen weg. isServer erkennt
 * Adressen des Servers selbst (Gateway, LAN-, Tailscale-IP).
 */
export function aggregateEgressEvents(
  events: EgressEvent[],
  projectOf: (source: string) => string | null,
  isServer: (destination: string, projectId: string) => boolean,
): EgressAttemptRow[] {
  const rows = new Map<string, EgressAttemptRow>()
  for (const e of events) {
    const projectId = projectOf(e.source)
    if (!projectId) continue
    const bucket = hourOf(e.at)
    const port = e.port ?? 0
    const key = [projectId, e.verdict, e.protocol, e.destination, port, bucket.getTime()].join('|')
    const r = rows.get(key)
    if (r) {
      r.count++
      if (e.at < r.firstSeen) r.firstSeen = e.at
      if (e.at > r.lastSeen) r.lastSeen = e.at
    } else {
      rows.set(key, {
        projectId, verdict: e.verdict, protocol: e.protocol, destination: e.destination, port, bucket, count: 1,
        toServer: isServer(e.destination, projectId), firstSeen: e.at, lastSeen: e.at,
      })
    }
  }
  return [...rows.values()]
}

/* --- Adressen einem Netz zuordnen --------------------------------------------------- */

function v4Int(ip: string): number | null {
  const p = ip.split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const x of p) {
    const v = Number(x)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** Liegt die IPv4-Adresse im Netz (CIDR)? IPv6-Netze: nur Präfix-Vergleich der Gruppen nicht nötig (Docker-Netze sind IPv4) */
export function inCidr4(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/')
  const a = v4Int(ip)
  const b = v4Int(net ?? '')
  const bits = Number(bitsRaw ?? 32)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const size = 2 ** (32 - bits)
  return Math.floor(a / size) === Math.floor(b / size)
}
