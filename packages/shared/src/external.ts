import { z } from 'zod'

/**
 * Projektart «Bestehender Dienst» (kind=external): etwas, das schon läuft und
 * nicht von Airlock deployt wurde – ein Container auf diesem Server oder eine
 * Adresse im Heimnetz –, über Airlock erreichbar machen (intern, auf Wunsch
 * öffentlich), ohne es zu verwalten. Airlock liest den Container nur; es
 * setzt keine Labels, startet, stoppt und ändert nichts daran.
 */

/* --- Quelle ------------------------------------------------------------------- */

/** Docker-Containername (wie Docker ihn erlaubt) */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/**
 * Was Airlock beim Anlegen und beim Wiederfinden über das Ziel festhält.
 * Kommt nie vom Aufrufer: der Server überschreibt es.
 */
export interface ExternalResolved {
  /** Container: zuletzt gefundene ID (kurz), Image, Compose-Projekt und -Dienst (zum Wiederfinden) */
  containerId?: string | null
  image?: string | null
  composeProject?: string | null
  composeService?: string | null
  /** Container: Netz, in das Caddy gehängt wird; null bei network_mode host */
  network?: string | null
  /** Container im Host-Netz: Caddy erreicht ihn über host-gateway */
  hostMode?: boolean
  /** Name oder (im Standardnetz «bridge») IP, unter der Caddy den Container erreicht */
  dialHost?: string | null
  /** Erkannte Admin-Oberfläche (Image oder Seitentitel) */
  adminUi?: { key: string; name: string } | null
}

export const externalSourceSchema = z.object({
  type: z.literal('external'),
  /** Weg a: Name eines laufenden Containers auf diesem Server ... */
  container: z.string().trim().regex(CONTAINER_NAME_RE, 'So heisst kein Container: Buchstaben, Ziffern, . _ -').optional(),
  /** ... mit dem Port im Container, an dem die Oberfläche lauscht */
  port: z.number({ invalid_type_error: 'Der Port ist eine Zahl, z.B. 8080' }).int().min(1, 'Port 1–65535').max(65535, 'Port 1–65535').optional(),
  /** Weg b: Adresse im Heimnetz, z.B. http://192.168.1.20:8123 */
  url: z.string().trim().max(200, 'Höchstens 200 Zeichen').optional(),
  /** HTTPS-Ziel mit eigenem (selbstsigniertem) Zertifikat zulassen */
  insecureTls: z.boolean().default(false),
  /** Vom Server ermittelt (siehe ExternalResolved); Eingaben werden überschrieben */
  resolved: z.custom<ExternalResolved>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)).optional(),
})
export type ExternalSource = z.infer<typeof externalSourceSchema>

export type ExternalTarget =
  | { mode: 'container'; container: string; port: number }
  | { mode: 'address'; url: string; insecureTls: boolean }

/** Querbezüge der Quelle (genau ein Weg, Port beim Container, erlaubte Adresse) */
export function externalSourceIssues(s: ExternalSource): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = []
  if (!!s.container === !!s.url) {
    issues.push({ path: ['source'], message: 'Wähle entweder einen Container auf diesem Server oder eine Adresse im Heimnetz' })
    return issues
  }
  if (s.container && !s.port) issues.push({ path: ['source', 'port'], message: 'Gib den Port an, an dem der Container lauscht, z.B. 8080' })
  if (s.url) {
    const a = checkExternalAddress(s.url)
    if (!a.ok) issues.push({ path: ['source', 'url'], message: a.reason })
  }
  if (s.container && s.insecureTls) issues.push({ path: ['source', 'insecureTls'], message: 'Eigene Zertifikate gibt es nur bei Adressen im Heimnetz' })
  return issues
}

export function externalTargetOf(s: ExternalSource): ExternalTarget | null {
  if (s.container && s.port) return { mode: 'container', container: s.container, port: s.port }
  if (s.url) return { mode: 'address', url: s.url, insecureTls: s.insecureTls }
  return null
}

/** Was ProjectDto.external zeigt (Übersicht, Aufbau, MCP) */
export interface ExternalInfoDto {
  mode: 'container' | 'address'
  /** Für Menschen: «Container sonarr, Port 8989» bzw. «http://192.168.1.20:8123» */
  label: string
  container: string | null
  port: number | null
  url: string | null
  insecureTls: boolean
  image: string | null
  composeProject: string | null
  composeService: string | null
  /** Netz, in das Caddy gehängt ist; «host» bei network_mode host; null bei Adressen */
  network: string | null
  /**
   * Container gefunden (true), fehlt (false) oder noch nicht nachgesehen (null).
   * Bei Adressen immer null – ob sie antwortet, sagt der Healthcheck.
   */
  found: boolean | null
}

export function externalLabel(s: Pick<ExternalSource, 'container' | 'port' | 'url'>): string {
  if (s.container) return `Container ${s.container}${s.port ? `, Port ${s.port}` : ''}`
  if (s.url) {
    const a = checkExternalAddress(s.url)
    return a.ok ? a.url : s.url
  }
  return 'unbekannt'
}

/* --- Adressen im Heimnetz -------------------------------------------------------- */

/** Erlaubte Bereiche für Weg b: private Netze nach RFC 1918 und das Tailnet (CGNAT, RFC 6598) */
export const EXTERNAL_ADDRESS_RANGES = [
  { cidr: '10.0.0.0/8', label: '10.x (privat)' },
  { cidr: '172.16.0.0/12', label: '172.16–31.x (privat)' },
  { cidr: '192.168.0.0/16', label: '192.168.x (privat)' },
  { cidr: '100.64.0.0/10', label: '100.64–127.x (Tailnet)' },
] as const

const ipv4ToInt = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p, i) => p > 255 || (m[i + 1]!.length > 1 && m[i + 1]!.startsWith('0')))) return null
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!
}

/** Liegt die IPv4-Adresse im Bereich (CIDR)? */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string]
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(base)
  if (a === null || b === null) return false
  const n = Number(bits)
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}

export type AddressCheck =
  | { ok: true; url: string; scheme: 'http' | 'https'; host: string; port: number; dial: string; range: string }
  | { ok: false; reason: string }

/**
 * Weg b: http(s)://IP:Port – nur eine IPv4-Adresse aus EXTERNAL_ADDRESS_RANGES,
 * kein Name (DNS könnte später woanders hinzeigen), keine Zugangsdaten, kein
 * Pfad. So kann ein Projekt nie auf Airlock selbst, den Server (127.x), die
 * Cloud-Metadaten (169.254.x) oder das Internet zeigen.
 */
export function checkExternalAddress(input: string): AddressCheck {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'Gib eine Adresse an, z.B. http://192.168.1.20:8123' }
  const m = /^(https?):\/\/([^/?#\s]*)(.*)$/i.exec(raw)
  if (!m) return { ok: false, reason: 'Die Adresse beginnt mit http:// oder https://, z.B. http://192.168.1.20:8123' }
  const scheme = m[1]!.toLowerCase() === 'https' ? 'https' : 'http'
  const authority = m[2]!
  const rest = m[3]!
  if (authority.includes('@')) return { ok: false, reason: 'Ohne Benutzer und Passwort in der Adresse – den Schutz setzt du unter Einstellungen › Zugang' }
  if (rest !== '' && rest !== '/') return { ok: false, reason: 'Nur Adresse und Port, ohne Pfad, z.B. http://192.168.1.20:8123' }
  if (authority.startsWith('[')) return { ok: false, reason: 'IPv6 geht noch nicht – gib die IPv4-Adresse an, z.B. 192.168.1.20' }
  const hp = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority)
  if (!hp) return { ok: false, reason: 'Das ist keine gültige Adresse, z.B. http://192.168.1.20:8123' }
  const host = hp[1]!
  if (ipv4ToInt(host) === null) return { ok: false, reason: 'Gib eine IP-Adresse an, keinen Namen, z.B. 192.168.1.20 – ein Name könnte später woanders hinzeigen' }
  const range = EXTERNAL_ADDRESS_RANGES.find((r) => ipv4InCidr(host, r.cidr))
  if (!range) {
    return { ok: false, reason: `${host} liegt nicht im Heimnetz. Erlaubt sind ${EXTERNAL_ADDRESS_RANGES.map((r) => r.label).join(', ')}.` }
  }
  const port = hp[2] ? Number(hp[2]) : scheme === 'https' ? 443 : 80
  if (port < 1 || port > 65535) return { ok: false, reason: 'Der Port liegt zwischen 1 und 65535' }
  return { ok: true, url: `${scheme}://${host}:${port}`, scheme, host, port, dial: `${host}:${port}`, range: range.label }
}

/* --- Container auf diesem Server ------------------------------------------------ */

/** Ein laufender Container zur Auswahl (GET /external/containers) */
export interface ExternalContainerDto {
  id: string
  name: string
  image: string
  /** «läuft seit …» (Docker-Text) */
  status: string
  composeProject: string | null
  composeService: string | null
  /** network_mode: host */
  hostMode: boolean
  /** Netze des Containers (ohne host/none) */
  networks: string[]
  /** Ports aus EXPOSE und veröffentlichte Ports (Container-Seite), aufsteigend */
  ports: { port: number; published: number | null }[]
  /** Erkannte Admin-Oberfläche (nach Image) */
  adminUi: { key: string; name: string } | null
  /** Schon über Airlock erreichbar: Name des Projekts – wird nicht noch einmal angeboten */
  takenBy: string | null
}

export type NetworkChoice =
  | { mode: 'network'; network: string; dialHost: string }
  | { mode: 'host'; dialHost: string }
  | { mode: 'none'; reason: string }

/** Name, unter dem Caddy den Docker-Host erreicht (extra_hosts: host-gateway) */
export const HOST_GATEWAY_NAME = 'host.docker.internal'

/**
 * In welches Netz Caddy für einen fremden Container gehängt wird.
 * - network_mode host: kein Netz; Caddy erreicht ihn über host-gateway:Port.
 * - sonst ein eigenes (benutzerdefiniertes) Netz, alphabetisch das erste; dort
 *   löst Docker den Containernamen auf.
 * - nur das Standardnetz «bridge»: dort gibt es keine Namensauflösung – Caddy
 *   wählt die IP des Containers (wird beim Wiederfinden nachgeführt).
 * Nie Netze von Airlock selbst (airlock_*) und keine Projekt-Netze (air_*, dep_*).
 */
export function chooseNetwork(c: { name: string; hostMode: boolean; networks: { name: string; ip: string | null }[] }): NetworkChoice {
  if (c.hostMode) return { mode: 'host', dialHost: HOST_GATEWAY_NAME }
  const usable = c.networks.filter((n) => !['host', 'none'].includes(n.name) && !/^(airlock_|deployer_|air_|dep_)/.test(n.name))
  const own = usable.filter((n) => n.name !== 'bridge').sort((a, b) => a.name.localeCompare(b.name))
  if (own[0]) return { mode: 'network', network: own[0].name, dialHost: c.name }
  const bridge = usable.find((n) => n.name === 'bridge')
  if (bridge?.ip) return { mode: 'network', network: 'bridge', dialHost: bridge.ip }
  if (c.networks.some((n) => /^(airlock_|deployer_)/.test(n.name))) return { mode: 'none', reason: 'Der Container hängt nur in Netzen von Airlock selbst' }
  return { mode: 'none', reason: 'Der Container hat kein Netz, über das Caddy ihn erreichen kann (network_mode none?)' }
}

/* --- Erreichbarkeit vor dem Anlegen --------------------------------------------- */

export interface ExternalProbeDto {
  ok: boolean
  /** HTTP-Status der Antwort; null ohne Antwort */
  status: number | null
  ms: number | null
  /** Titel der Seite (aus <title>), gekürzt */
  title: string | null
  /** Ein Satz: was geklappt hat oder was nicht */
  detail: string
  /** HTTPS mit eigenem Zertifikat erkannt (nur bei Adressen) */
  selfSigned: boolean
  adminUi: { key: string; name: string } | null
  /** Container: gewähltes Netz bzw. Weg */
  via: string | null
}

/* --- Zugang (Schutz vorschalten) -------------------------------------------------- */

/** Für alle Projekte: offen, Airlock-Login (forward_auth) oder Cloudflare Access (nur öffentlich) */
export const ACCESS_GUARDS = ['offen', 'login', 'cloudflare'] as const
export type AccessGuard = (typeof ACCESS_GUARDS)[number]

export const ACCESS_GUARD_LABEL: Record<AccessGuard, string> = {
  offen: 'Offen',
  login: 'Airlock-Login',
  cloudflare: 'Cloudflare Access',
}

/** Cookie der Anmeldung an Projekt-Adressen (nur auf dem Host der Route, nie für die App) */
export const GATE_COOKIE = 'airlock_gate'
/** Pfad auf dem Host des Projekts, über den Airlock nach der Anmeldung den Cookie setzt */
export const GATE_CALLBACK_PATH = '/.airlock/gate'

/* --- Bekannte Admin-Oberflächen ----------------------------------------------- */

export interface AdminUi {
  key: string
  name: string
  /** Erkennung über das Image (Name ohne Registry und Tag) */
  image?: RegExp
  /** Erkennung über den Seitentitel */
  title?: RegExp
}

/**
 * Oberflächen, mit denen man Server, Netz oder Daten verwalten kann. Sie dürfen
 * nur mit Schutz (Airlock-Login oder Cloudflare Access) öffentlich werden; wer
 * das übersteuern will, bestätigt es erneut (sudo).
 */
export const ADMIN_UIS: readonly AdminUi[] = [
  { key: 'arr', name: 'Sonarr, Radarr & Co. (*arr)', image: /(^|[/-])(sonarr|radarr|lidarr|readarr|prowlarr|bazarr|whisparr)$/, title: /^(Sonarr|Radarr|Lidarr|Readarr|Prowlarr|Bazarr|Whisparr)\b/ },
  { key: 'portainer', name: 'Portainer', image: /(^|\/)portainer(-ce|-ee)?$/, title: /Portainer/ },
  { key: 'proxmox', name: 'Proxmox', image: /proxmox/, title: /Proxmox (Virtual Environment|Backup Server)|pve\b/i },
  { key: 'router', name: 'Router-Oberfläche', image: /(^|\/)(openwrt|opnsense|pfsense|unifi(-network-application|-controller)?)$/, title: /OpenWrt|LuCI|OPNsense|pfSense|FRITZ!Box|UniFi|MikroTik|RouterOS|EdgeOS/i },
  { key: 'nas', name: 'NAS-Oberfläche', image: /(^|\/)(openmediavault|truenas)$/, title: /Synology|DiskStation|TrueNAS|FreeNAS|openmediavault|QNAP|QTS|Unraid/i },
  { key: 'homeassistant', name: 'Home Assistant', image: /(^|\/)(home-assistant|homeassistant)$/, title: /^Home Assistant/ },
  { key: 'torrent', name: 'Torrent-Client', image: /(^|\/)(qbittorrent|qbittorrent-nox|transmission|deluge)$/, title: /qBittorrent|Transmission Web|Deluge/i },
  { key: 'dns', name: 'Pi-hole / AdGuard Home', image: /(^|\/)(pihole|pi-hole|adguardhome)$/, title: /Pi-hole|AdGuard Home/i },
  { key: 'db', name: 'Datenbank-Oberfläche (Adminer, phpMyAdmin, pgAdmin)', image: /(^|\/)(adminer|phpmyadmin|pgadmin4)$/, title: /Adminer|phpMyAdmin|pgAdmin/ },
  { key: 'proxy', name: 'Nginx Proxy Manager', image: /(^|\/)nginx-proxy-manager$/, title: /Nginx Proxy Manager/ },
  { key: 'docker', name: 'Docker-Verwaltung (Dockge, Yacht)', image: /(^|\/)(dockge|yacht)$/, title: /Dockge|Yacht/ },
  { key: 'cockpit', name: 'Cockpit / Webmin', image: /(^|\/)(cockpit|webmin)$/, title: /Cockpit|Webmin/ },
] as const

/** Image ohne Registry-Host, Tag und Digest, klein: «ghcr.io/linuxserver/sonarr:4» → «linuxserver/sonarr» */
export function imageBase(image: string): string {
  let s = image.trim().toLowerCase().split('@')[0]!
  const lastColon = s.lastIndexOf(':')
  if (lastColon > s.lastIndexOf('/')) s = s.slice(0, lastColon)
  const parts = s.split('/')
  // Erster Teil mit Punkt oder Port ist ein Registry-Host
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) parts.shift()
  return parts.join('/')
}

/** Erkennt eine bekannte Admin-Oberfläche am Image oder am Seitentitel; sonst null. */
export function detectAdminUi(o: { image?: string | null; title?: string | null }): { key: string; name: string } | null {
  const base = o.image ? imageBase(o.image) : null
  for (const a of ADMIN_UIS) {
    if (base && a.image?.test(base)) return { key: a.key, name: a.name }
    if (o.title && a.title?.test(o.title)) return { key: a.key, name: a.name }
  }
  return null
}

/** Meldung, wenn eine Admin-Oberfläche ohne Schutz öffentlich werden soll */
export const adminUiPublicMessage = (name: string): string =>
  `${name} ist eine Verwaltungsoberfläche: Wer sie erreicht, kann Server, Netz oder Daten ändern, und solche Oberflächen werden im Internet gezielt gesucht. ` +
  'Öffentlich nur mit Schutz – unter Einstellungen › Zugang «Airlock-Login» oder «Cloudflare Access» wählen. Übersteuern geht nur mit erneuter Bestätigung.'
