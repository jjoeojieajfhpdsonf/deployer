import { BlockList, isIP } from 'node:net'
import { SCP_REPO_RE } from '@airlock/shared'
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
  /** http(s) bzw. ssh – bei SSH nur noch mit Deploy-Key (Nacht 3, Etappe 2) */
  kind: 'http' | 'ssh'
  /** Bei SSH eine ssh://-Form nur für Anzeige und Prüfung; git bekommt gitUrl */
  url: URL
  /** Genau diese Zeichenkette geht an git (scp-Form bleibt scp-Form) */
  gitUrl: string
  host: string
  port: number
  /** Nur SSH: Benutzer beim Git-Server (meist git) */
  user: string | null
  /** Die geprüften Adressen. git bekommt genau diese (curloptResolve bzw. ssh HostName). */
  addresses: string[]
}

/**
 * SSH-Adresse in Teile zerlegen: ssh://user@host[:port]/pfad oder die
 * scp-Form user@host:pfad. Benutzer ist Pflicht (sonst nähme ssh «root»),
 * nichts darf mit «-» beginnen (sonst eine ssh-Option), kein Passwort.
 */
function parseSsh(raw: string): { user: string; host: string; port: number; url: URL } {
  const scp = SCP_REPO_RE.exec(raw)
  if (scp) {
    const host = scp[2]!.replace(/^\[|\]$/g, '')
    const path = scp[3]!
    return { user: scp[1]!, host, port: 22, url: new URL(`ssh://${scp[1]}@${scp[2]}/${path.replace(/^\/+/, '')}`) }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw rejected('Die SSH-Adresse ist ungültig, z.B. git@gitlab.com:user/app.git')
  }
  if (url.password) throw rejected('Zugangsdaten in der Repo-URL sind nicht erlaubt')
  if (!url.username) throw rejected('Die SSH-Adresse braucht einen Benutzer, z.B. ssh://git@gitlab.com/user/app.git')
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(decodeURIComponent(url.username))) throw rejected('Ungültiger Benutzer in der SSH-Adresse')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host.startsWith('-')) throw rejected('Die SSH-Adresse hat keinen gültigen Host')
  if (!url.pathname || url.pathname === '/' || url.pathname.startsWith('/-')) throw rejected('Die SSH-Adresse hat keinen Pfad zum Repo')
  if (url.search || url.hash) throw rejected('Die SSH-Adresse darf weder ? noch # enthalten')
  return { user: decodeURIComponent(url.username), host, port: url.port ? Number(url.port) : 22, url }
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

export async function checkRepoUrl(raw: string, policy: RepoUrlPolicy, o: { allowSsh?: boolean } = {}): Promise<CheckedRepoUrl> {
  // SSH (Nacht 3, Etappe 2): nur, wo der Aufrufer einen Deploy-Key mitgibt
  if (/^ssh:\/\//i.test(raw) || SCP_REPO_RE.test(raw)) {
    if (!o.allowSsh) throw rejected('Eine SSH-Adresse geht nur mit einem Deploy-Key')
    const s = parseSsh(raw)
    const addresses = await checkTarget(s.host, policy)
    return { kind: 'ssh', url: s.url, gitUrl: raw, host: s.host, port: s.port, user: s.user, addresses }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw rejected('Die Repo-URL ist keine gültige URL')
  }

  // Nur http(s) (und SSH oben). file://, git:// und Remote-Helfer wie ext::
  // fallen hier heraus – ext:: führt beliebige Befehle aus.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw rejected(`Schema "${url.protocol}" ist nicht erlaubt, nur https://, http:// und SSH mit Deploy-Key`)
  }
  // Zugangsdaten in der URL landen sonst in Logs und in der Datenbank.
  if (url.username || url.password) {
    throw rejected('Zugangsdaten in der Repo-URL sind nicht erlaubt')
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const addresses = await checkTarget(host, policy)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { kind: 'http', url, gitUrl: url.toString(), host, port, user: null, addresses }
}

/** Host gegen Sperrliste und DNS prüfen; liefert die geprüften Adressen. */
async function checkTarget(rawHost: string, policy: RepoUrlPolicy): Promise<string[]> {
  const host = rawHost.toLowerCase()
  if (!host) throw rejected('Die Repo-URL hat keinen Host')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw rejected('localhost ist als Repo-Host nicht erlaubt')
  }
  if (policy.deniedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw rejected(`"${host}" ist ein Dienst des Airlock-Stacks und als Repo-Host gesperrt`)
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
  return addresses
}

/** Für Fehlermeldungen und Logs: URL ohne Query und Fragment (bei SSH mit Benutzer). */
export function displayUrl(u: URL): string {
  if (u.protocol === 'ssh:') return `ssh://${u.username ? `${u.username}@` : ''}${u.host}${u.pathname}`
  return `${u.protocol}//${u.host}${u.pathname}`
}
