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
 */

export interface AccessEntry {
  at: number
  ip: string
  status: number | null
  host: string | null
}

export interface ClientIpReport {
  /** Anfragen auf Airlock im Zeitraum */
  total: number
  /** davon von einer Docker-Gateway-Adresse */
  fromGateway: number
  /** gesehene Gateway-Adressen */
  gatewayIps: string[]
  /** Alle Anfragen im Zeitraum kamen von Gateway-Adressen */
  gatewayOnly: boolean
  /** Davon gesperrt (403) */
  blocked: number
  since: string
}

export function parseAccessLog(text: string, sinceMs: number, logger = 'http.log.access.airlock'): AccessEntry[] {
  const out: AccessEntry[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{') || !l.includes(logger)) continue
    try {
      const j = JSON.parse(l) as { ts?: number; logger?: string; status?: number; request?: { remote_ip?: string; client_ip?: string; host?: string } }
      if (j.logger !== logger) continue
      const at = typeof j.ts === 'number' ? (j.ts > 1e12 ? j.ts : j.ts * 1000) : Date.now()
      if (at < sinceMs) continue
      // remote_ip: die Verbindung, wie Caddy sie sieht (darauf prüft der IP-Filter)
      const ip = j.request?.remote_ip ?? j.request?.client_ip
      if (!ip) continue
      out.push({ at, ip, status: typeof j.status === 'number' ? j.status : null, host: j.request?.host ?? null })
    } catch {
      /* keine JSON-Zeile */
    }
  }
  return out
}

export function assessClientIps(entries: AccessEntry[], gateways: string[], sinceMs: number): ClientIpReport {
  const gw = new Set(gateways)
  const fromGw = entries.filter((e) => gw.has(e.ip))
  return {
    total: entries.length,
    fromGateway: fromGw.length,
    gatewayIps: [...new Set(fromGw.map((e) => e.ip))],
    gatewayOnly: entries.length > 0 && fromGw.length === entries.length,
    blocked: fromGw.filter((e) => e.status === 403).length,
    since: new Date(sinceMs).toISOString(),
  }
}
