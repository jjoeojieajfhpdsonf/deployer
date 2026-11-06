import { BlockList, isIP } from 'node:net'
import { AppError } from './errors.js'

/**
 * Prüft eine Repo-URL, bevor git sie anfasst. Reine Logik mit einem
 * austauschbaren Resolver, damit sie ohne Netz testbar ist.
 *
 * Ziel: Ein Clone – ab M3 auch von einem Agenten angestossen – darf weder
 * lokale Dateien lesen noch Befehle ausführen noch die Dienste des eigenen
 * Stacks (Postgres, Socket-Proxy, Caddy) abtasten.
 */

export interface RepoUrlPolicy {
  /** Exakte Hostnamen, die nie erlaubt sind (Dienste des Stacks). */
  deniedHosts: string[]
  /** Zusätzliche gesperrte Bereiche, z.B. die Docker-Netze des Stacks. */
  deniedCidrs: string[]
  /** Liefert alle Adressen eines Namens. */
  resolve: (host: string) => Promise<string[]>
}

export interface CheckedRepoUrl {
  url: URL
  host: string
  port: number
  /** Die geprüften Adressen. git bekommt genau diese (curloptResolve). */
  addresses: string[]
}

const rejected = (msg: string) => new AppError('repo_url_rejected', msg, 400)

/** Immer gesperrt, unabhängig von der Konfiguration. */
const ALWAYS_DENIED: [string, number, 'ipv4' | 'ipv6'][] = [
  ['127.0.0.0', 8, 'ipv4'], // Loopback
  ['0.0.0.0', 8, 'ipv4'], // "dieses Netz"
  ['169.254.0.0', 16, 'ipv4'], // Link-local, u.a. Cloud-Metadaten
  ['::1', 128, 'ipv6'],
  ['::', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]

function buildBlockList(extra: string[]): BlockList {
  const bl = new BlockList()
  for (const [addr, prefix, type] of ALWAYS_DENIED) bl.addSubnet(addr, prefix, type)
  for (const cidr of extra) {
    const [addr, prefixRaw] = cidr.split('/')
    const type = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4'
    const prefix = Number(prefixRaw ?? (type === 'ipv6' ? 128 : 32))
    if (addr && isIP(addr)) bl.addSubnet(addr, prefix, type)
  }
  return bl
}

/** IPv4 in IPv6-Schreibweise (::ffff:127.0.0.1) auf IPv4 zurückführen. */
function normalizeIp(ip: string): { ip: string; type: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (m) return { ip: m[1]!, type: 'ipv4' }
  return { ip, type: isIP(ip) === 6 ? 'ipv6' : 'ipv4' }
}

export async function checkRepoUrl(raw: string, policy: RepoUrlPolicy): Promise<CheckedRepoUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw rejected('Die Repo-URL ist keine gültige URL')
  }

  // Nur http(s). file://, ssh://, git:// und Remote-Helfer wie ext:: fallen
  // hier heraus – ext:: führt beliebige Befehle aus.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw rejected(`Schema "${url.protocol}" ist nicht erlaubt, nur https:// und http://`)
  }
  // Zugangsdaten in der URL landen sonst in Logs und in der Datenbank.
  if (url.username || url.password) {
    throw rejected('Zugangsdaten in der Repo-URL sind nicht erlaubt')
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw rejected('Die Repo-URL hat keinen Host')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw rejected('localhost ist als Repo-Host nicht erlaubt')
  }
  if (policy.deniedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw rejected(`"${host}" ist ein Dienst des deployer-Stacks und als Repo-Host gesperrt`)
  }

  const addresses = isIP(host) ? [host] : await policy.resolve(host).catch(() => [])
  if (addresses.length === 0) throw rejected(`"${host}" lässt sich nicht auflösen`)

  const bl = buildBlockList(policy.deniedCidrs)
  for (const a of addresses) {
    const { ip, type } = normalizeIp(a)
    if (bl.check(ip, type)) {
      throw rejected(`"${host}" zeigt auf ${ip}, eine gesperrte Adresse (Loopback oder Netz des Stacks)`)
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { url, host, port, addresses }
}

/** Für Fehlermeldungen und Logs: URL ohne Query und Fragment. */
export function displayUrl(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}`
}
