/**
 * Welche Absenderadressen sieht Caddy bei Anfragen auf Airlock selbst?
 * Quelle: Caddys Zugriffs-Log für die Namen der Oberfläche (Logger
 * http.log.access.airlock, drivers/caddy-config.ts). Rein: bekommt Log-Text
 * und die Gateways der Docker-Netze, liest nichts selbst.
 *
 * Hintergrund: Läuft Tailscale als Subnet-Router, maskiert es Verkehr aus dem
 * Tailnet in Docker-Netze (ts-postrouting MASQUERADE). Caddy sieht dann die
 * Gateway-Adresse des Docker-Netzes (172.x.0.1) statt der Tailnet-Adresse
 * (100.x) – und der IP-Filter sperrt. Abhilfe: docs/INSTALL.md, Abschnitt
 * «Tailscale als Subnet-Router».
 *
 * Dieselbe Gateway-Adresse haben Anfragen vom Server selbst (curl auf dem
 * Host, ein Container, der den Namen über die Host-Ports anfragt). Eigene
 * Prüfungen von Airlock tragen den User-Agent «airlock-probe (…)»
 * (lib/probe-ua.ts) und zählen nie als fremde Zugriffe.
 */

import { isOwnProbe } from './probe-ua.js'

export interface AccessEntry {
  at: number
  ip: string
  status: number | null
  host: string | null
  method?: string | null
  /** Pfad ohne Query (die kann Tokens enthalten) */
  path?: string | null
  userAgent?: string | null
}

/** Woher fremde Anfragen vom Gateway vermutlich kommen. */
export type GatewaySource = 'tailnet' | 'server'

export interface GatewayGroup {
  source: GatewaySource
  count: number
  blocked: number
  hosts: string[]
  /** Beispiel-Pfade (höchstens 5, häufigste zuerst) */
  paths: string[]
  /** Gekürzte User-Agents (höchstens 3) */
  userAgents: string[]
  last: string
}

export interface ClientIpReport {
  /** Fremde Anfragen auf Airlock im Zeitraum (ohne eigene Prüfungen) */
  total: number
  /** davon von einer Docker-Gateway-Adresse */
  fromGateway: number
  /** gesehene Gateway-Adressen (fremde Anfragen) */
  gatewayIps: string[]
  /** Alle fremden Anfragen im Zeitraum kamen von Gateway-Adressen */
  gatewayOnly: boolean
  /** Davon gesperrt (403) */
  blocked: number
  since: string
  /** Eigene Prüfungen im Zeitraum (herausgefiltert) */
  ownProbes: number
  /** Fremde Gateway-Anfragen nach vermuteter Herkunft */
  groups: GatewayGroup[]
}

export function parseAccessLog(text: string, sinceMs: number, logger = 'http.log.access.airlock'): AccessEntry[] {
  const out: AccessEntry[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{') || !l.includes(logger)) continue
    try {
      const j = JSON.parse(l) as {
        ts?: number; logger?: string; status?: number
        request?: { remote_ip?: string; client_ip?: string; host?: string; method?: string; uri?: string; headers?: Record<string, string[] | string | undefined> }
      }
      if (j.logger !== logger) continue
      const at = typeof j.ts === 'number' ? (j.ts > 1e12 ? j.ts : j.ts * 1000) : Date.now()
      if (at < sinceMs) continue
      // remote_ip: die Verbindung, wie Caddy sie sieht (darauf prüft der IP-Filter)
      const ip = j.request?.remote_ip ?? j.request?.client_ip
      if (!ip) continue
      const headers = j.request?.headers ?? {}
      const uaRaw = headers['User-Agent'] ?? headers['user-agent']
      const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null
      out.push({
        at, ip,
        status: typeof j.status === 'number' ? j.status : null,
        host: j.request?.host ?? null,
        method: j.request?.method ?? null,
        path: j.request?.uri ? j.request.uri.split('?')[0]!.slice(0, 120) : null,
        userAgent: userAgent ? userAgent.slice(0, 200) : null,
      })
    } catch {
      /* keine JSON-Zeile */
    }
  }
  return out
}

/** Ein Browser (über das Tailnet maskiert) oder ein Werkzeug auf dem Server? */
export function gatewaySourceOf(userAgent: string | null | undefined): GatewaySource {
  return /Mozilla\/|Safari\/|Chrome\/|Firefox\//.test(userAgent ?? '') ? 'tailnet' : 'server'
}

/** Kurzform eines User-Agents für die Anzeige: «Chrome 131», «curl/8.5.0», «(leer)». */
export function shortUserAgent(ua: string | null | undefined): string {
  const s = (ua ?? '').trim()
  if (!s) return '(ohne User-Agent)'
  const browser = /(Edg|Firefox|Chrome|Version)\/(\d+)/.exec(s)
  if (browser && /Mozilla\//.test(s)) {
    const name = browser[1] === 'Version' ? 'Safari' : browser[1] === 'Edg' ? 'Edge' : browser[1]
    return `${name} ${browser[2]}`
  }
  return s.split(/\s+/)[0]!.slice(0, 40)
}

const top = (values: string[], n: number) => {
  const count = new Map<string, number>()
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v)
}

export function assessClientIps(all: AccessEntry[], gateways: string[], sinceMs: number): ClientIpReport {
  const gw = new Set(gateways)
  // Eigene Prüfungen (User-Agent «airlock-probe …») nie mitzählen
  const own = all.filter((e) => isOwnProbe(e.userAgent))
  const entries = all.filter((e) => !isOwnProbe(e.userAgent))
  const fromGw = entries.filter((e) => gw.has(e.ip))
  const groups: GatewayGroup[] = []
  for (const source of ['server', 'tailnet'] as const) {
    const list = fromGw.filter((e) => gatewaySourceOf(e.userAgent) === source)
    if (!list.length) continue
    groups.push({
      source,
      count: list.length,
      blocked: list.filter((e) => e.status === 403).length,
      hosts: top(list.map((e) => e.host ?? '?'), 4),
      paths: top(list.map((e) => `${e.method ?? 'GET'} ${e.path ?? '/'}`), 5),
      userAgents: top(list.map((e) => shortUserAgent(e.userAgent)), 3),
      last: new Date(Math.max(...list.map((e) => e.at))).toISOString(),
    })
  }
  return {
    total: entries.length,
    fromGateway: fromGw.length,
    gatewayIps: [...new Set(fromGw.map((e) => e.ip))],
    gatewayOnly: entries.length > 0 && fromGw.length === entries.length,
    blocked: fromGw.filter((e) => e.status === 403).length,
    since: new Date(sinceMs).toISOString(),
    ownProbes: own.length,
    groups,
  }
}
