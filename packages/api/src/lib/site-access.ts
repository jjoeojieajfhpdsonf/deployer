import type { SiteAccessEntryDto } from '@airlock/shared'

/**
 * Zugriffe auf eine statische Seite aus Caddys Zugriffs-Log (Logger
 * http.log.access.site, drivers/caddy-config.ts). Rein: bekommt Log-Text und
 * die Namen des Projekts, liest nichts selbst. Die Adresse der Besucher wird
 * gekürzt (Datenschutz): IPv4 ohne letztes Oktett, IPv6 nur die ersten drei
 * Gruppen.
 */

export const SITE_LOGGER_NAME = 'http.log.access.site'

export function shortenIp(ip: string | undefined | null): string {
  if (!ip) return '–'
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`
  if (ip.includes(':')) {
    const groups = ip.replace(/^::ffff:/, '').split(':').filter(Boolean)
    if (groups.length <= 1 && /\./.test(ip)) return shortenIp(ip.replace(/^::ffff:/, ''))
    return `${groups.slice(0, 3).join(':')}:…`
  }
  return ip
}

export function parseSiteAccess(text: string, o: { hosts: string[]; sinceMs: number; limit?: number }): SiteAccessEntryDto[] {
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()))
  const out: SiteAccessEntryDto[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{') || !l.includes(SITE_LOGGER_NAME)) continue
    try {
      const j = JSON.parse(l) as {
        ts?: number; logger?: string; status?: number; duration?: number; size?: number
        request?: { method?: string; host?: string; uri?: string; client_ip?: string; remote_ip?: string }
      }
      if (j.logger !== SITE_LOGGER_NAME) continue
      const host = (j.request?.host ?? '').toLowerCase().replace(/:\d+$/, '')
      if (!hosts.has(host)) continue
      const at = typeof j.ts === 'number' ? (j.ts > 1e12 ? j.ts : j.ts * 1000) : 0
      if (at < o.sinceMs) continue
      out.push({
        at: new Date(at).toISOString(),
        method: j.request?.method ?? '–',
        path: (j.request?.uri ?? '/').slice(0, 300),
        status: typeof j.status === 'number' ? j.status : 0,
        // Caddy schreibt die Dauer in Sekunden
        durationMs: typeof j.duration === 'number' ? Math.round(j.duration * 1000 * 10) / 10 : null,
        bytes: typeof j.size === 'number' ? j.size : null,
        // client_ip: hinter dem Tunnel die echte Besucher-IP (trusted_proxies)
        ip: shortenIp(j.request?.client_ip ?? j.request?.remote_ip),
        host,
      })
    } catch {
      /* keine JSON-Zeile */
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at))
  return out.slice(0, o.limit ?? 500)
}
