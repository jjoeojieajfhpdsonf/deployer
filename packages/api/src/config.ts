import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { registerSecret } from './lib/redact.js'
import { isIPv4 } from 'node:net'
import {
  parseBaseDomain, nipHost, primaryHost as primaryHostFor, aliasHosts as aliasHostsFor, urlFor as urlForFn,
  type HostSettings,
} from './lib/hostnames.js'

/** IPv4 im Tailscale-Bereich 100.64.0.0/10 (zweites Oktett 64-127). */
export function isTailnetIp(v: string): boolean {
  if (!isIPv4(v)) return false
  const [a, b] = v.split('.').map(Number)
  return a === 100 && b! >= 64 && b! <= 127
}

const onOff = z
  .enum(['on', 'off'])
  .transform((v) => v === 'on')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.string().min(1),

  DOCKER_HOST: z.string().default('tcp://socket-proxy:2375'),
  CADDY_ADMIN_SOCKET: z.string().default('/run/caddy/admin.sock'),
  // M8: Probe-Server von Caddy (gleiches Volume wie der Admin-Socket). Der
  // Header-Check fragt darüber, wie Besucher die Seite sehen, ohne dass der
  // IP-Filter für Airlock geöffnet werden muss. Leer = aus.
  CADDY_PROBE_SOCKET: z.string().default('/run/caddy/probe.sock'),

  DATA_DIR: z.string().default('/data'),
  SITES_DIR: z.string().default('/srv/sites'),
  WEB_DIST: z.string().optional(),

  AIRLOCK_CONTAINER: z.string().default('airlock-app'),
  CADDY_CONTAINER: z.string().default('airlock-caddy'),
  AIRLOCK_UPSTREAM: z.string().default('airlock-app:3000'),

  // Leer = noch nicht festgelegt. Bewusst kein Platzhalter wie
  // "int.example.ch": der sieht wie eine echte Adresse aus und fuehrt ins Leere.
  INTERNAL_BASE_DOMAIN: z.string().optional().transform(parseBaseDomain),
  SERVER_LAN_IP: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || /^(\d{1,3}\.){3}\d{1,3}$/.test(v), 'SERVER_LAN_IP muss eine IPv4-Adresse sein')
    .transform((v) => (v === '' ? null : v)),
  NIPIO_FALLBACK: onOff.default('on'),

  CADDY_IP_FILTER: onOff.default('on'),
  LAN_CIDR: z.string().default('192.168.1.0/24'),

  ADMIN_PASSWORD: z.string().min(1),
  // Anzeigename im Profil-Menü (Initiale als Avatar), z.B. "Joël".
  ADMIN_NAME: z.string().trim().max(60).default(''),
  SESSION_SECRET: z.string().trim().default(''),

  DEFAULT_CPU_LIMIT: z.coerce.number().min(0.1).max(16).default(1),
  DEFAULT_MEMORY_LIMIT_MB: z.coerce.number().int().min(64).default(512),

  // M3: Chat-Deploys (Quelle files) nach so vielen Tagen ohne Änderung stoppen.
  CHAT_EXPIRY_DAYS: z.coerce.number().int().min(4).max(3650).default(30),

  // M6: Name des Docker-Volumes mit den statischen Seiten (Compose-Projekt "airlock").
  SITES_VOLUME: z.string().default('airlock_sites'),
  // M6: nach einem erfolgreichen Deploy automatisch scannen.
  SCAN_AFTER_DEPLOY: onOff.default('on'),

  // M4: HTTPS mit Wildcard-Zertifikat per DNS-01 bei Cloudflare. Ohne
  // compose.tls.yaml bleibt es aus, und alles läuft wie in M1-M6 über HTTP.
  TLS_MODE: z.enum(['off', 'cloudflare']).default('off'),
  ACME_CA: z.enum(['production', 'staging']).default('production'),
  ACME_EMAIL: z.string().trim().default('').transform((v) => (v === '' ? null : v)),
  TAILSCALE_IP: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || isTailnetIp(v), 'TAILSCALE_IP muss eine IPv4-Adresse im Bereich 100.64.0.0/10 sein')
    .transform((v) => (v === '' ? null : v)),
  CLOUDFLARE_API_TOKEN_FILE: z.string().default('/run/secrets/cloudflare_token'),
  CLOUDFLARE_API_BASE: z.string().url().default('https://api.cloudflare.com/client/v4'),

  // M5: öffentlich über Cloudflare Tunnel. Ohne Konto- und Tunnel-ID bleibt
  // "public" abgeschaltet. ACCESS_EMAIL: wer sich bei Cloudflare Access anmelden darf.
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().default('').transform((v) => (v === '' ? null : v)),
  CLOUDFLARE_TUNNEL_ID: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || /^[0-9a-f-]{36}$/i.test(v), 'CLOUDFLARE_TUNNEL_ID muss die UUID des Tunnels sein')
    .transform((v) => (v === '' ? null : v.toLowerCase())),
  ACCESS_EMAIL: z.string().trim().default('').transform((v) => (v === '' ? null : v)),
  EDGE_NETWORK: z.string().default('airlock_edge'),
  // Eigenes Netz nur für cloudflared und Caddy: der Tunnel erreicht ausschliesslich Caddy, nie Airlock.
  TUNNEL_NETWORK: z.string().default('airlock_tunnel'),
  CLOUDFLARED_CONTAINER: z.string().default('airlock-cloudflared'),
  CLOUDFLARED_IMAGE: z.string().default('cloudflare/cloudflared:2025.8.1'),
  // Für die Prüfung auf neuere cloudflared-Versionen (in Tests austauschbar)
  DOCKER_HUB_API: z.string().url().default('https://hub.docker.com/v2'),
  // Gemeinsames Volume mit Caddy: dort liegt das Token für die DNS-Challenge
  // als Datei. Caddys Konfiguration (und autosave.json) enthält nur den Pfad.
  CADDY_SECRETS_DIR: z.string().default('/run/caddy-secrets'),
  // Caddys Speicher (Volume caddy_data): Airlock liest daraus, ob schon ein
  // gültiges produktives Wildcard-Zertifikat vorliegt, und räumt Staging-
  // Wildcards früherer Probeläufe weg. Fehlt das Volume, entfällt beides.
  CADDY_DATA_DIR: z.string().default('/caddy-data'),

  // M8: GitHub (in Tests durch eine Attrappe ersetzbar)
  GITHUB_API: z.string().url().default('https://api.github.com'),
  GITHUB_WEB: z.string().url().default('https://github.com'),
  // Alle so viele Sekunden: Auto-Deploy nach Merge und Status offener Pull Requests (SPEC: 5 Minuten)
  AUTO_DEPLOY_INTERVAL_S: z.coerce.number().int().min(30).default(300),

  // Anzeigename des Servers in der Oberfläche (Brotkrumen), z.B. "thinkpad".
  SERVER_NAME: z.string().trim().max(40).default(''),
})

export type Config = z.infer<typeof envSchema> & {
  /** Tailnet-Bereich, fest: siehe SPEC. */
  tailnetCidr: string
  version: string
}

function build(): Config {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    // Bewusst harter Abbruch: lieber gar nicht starten als halb konfiguriert.
    console.error('Konfiguration unvollständig:\n' + lines.join('\n'))
    process.exit(1)
  }
  const d = parsed.data
  const problems = tlsProblems(d)
  if (problems.length) {
    console.error('Konfiguration unvollständig:\n' + problems.map((p) => `  - ${p}`).join('\n'))
    process.exit(1)
  }
  return { ...d, tailnetCidr: '100.64.0.0/10', version: '0.1.0' }
}

/** M4: TLS verlangt eine Basisdomain und ein lesbares Token. */
export function tlsProblems(d: { TLS_MODE: string; INTERNAL_BASE_DOMAIN: string | null; CLOUDFLARE_API_TOKEN_FILE: string }): string[] {
  if (d.TLS_MODE !== 'cloudflare') return []
  const out: string[] = []
  if (!d.INTERNAL_BASE_DOMAIN) out.push('TLS_MODE=cloudflare braucht INTERNAL_BASE_DOMAIN (z.B. int.deinedomain.ch)')
  try {
    if (!readFileSync(d.CLOUDFLARE_API_TOKEN_FILE, 'utf8').trim()) out.push(`${d.CLOUDFLARE_API_TOKEN_FILE} ist leer`)
  } catch {
    out.push(`TLS_MODE=cloudflare braucht das Cloudflare-Token in ${d.CLOUDFLARE_API_TOKEN_FILE} (siehe compose.tls.yaml)`)
  }
  return out
}

let tokenCache: { at: number; v: string | null } | null = null

/** Das Cloudflare-Token aus der alten Secret-Datei (compose.tls.yaml), 30 s zwischengespeichert. */
function fileToken(): string | null {
  if (tokenCache && Date.now() - tokenCache.at < 30_000) return tokenCache.v
  let v: string | null
  try {
    v = readFileSync(config.CLOUDFLARE_API_TOKEN_FILE, 'utf8').trim() || null
  } catch {
    v = null
  }
  tokenCache = { at: Date.now(), v }
  registerSecret(v)
  return v
}

export const config = build()

/* --- Cloudflare zur Laufzeit ---------------------------------------------------
 * Seit «Cloudflare verbinden» (Systemseite) stehen Token, Konto, Tunnel,
 * Basisdomain und TLS in der Datenbank (domain/cloudflare-settings.ts). Was
 * dort gesetzt ist, gilt; sonst die alten Variablen aus .env. Hier liegt nur
 * der Zwischenspeicher, damit config.ts ohne Datenbank auskommt.
 * --------------------------------------------------------------------------- */

export interface CfRuntime {
  token: string
  accountId: string
  tunnelId: string
  baseDomain: string | null
  tls: boolean
  acmeCa: 'production' | 'staging'
  acmeEmail: string | null
  tailscaleIp: string | null
  accessEmail: string | null
}

let rt: Partial<CfRuntime> = {}

/** Nur domain/cloudflare-settings.ts ruft das auf: Werte aus der Datenbank (fehlende Schlüssel = .env). */
export function setCfRuntime(r: Partial<CfRuntime>): void {
  rt = r
}

const pick = <K extends keyof CfRuntime>(k: K, fallback: CfRuntime[K] | null): CfRuntime[K] | null => (k in rt ? (rt[k] as CfRuntime[K]) : fallback)

/** Wirksame Werte: Datenbank vor .env. */
export const cf = {
  token: (): string | null => pick('token', null) ?? fileToken(),
  tokenSource: (): 'ui' | 'env' | null => ('token' in rt ? 'ui' : fileToken() ? 'env' : null),
  accountId: (): string | null => pick('accountId', config.CLOUDFLARE_ACCOUNT_ID),
  tunnelId: (): string | null => pick('tunnelId', config.CLOUDFLARE_TUNNEL_ID),
  baseDomain: (): string | null => pick('baseDomain', config.INTERNAL_BASE_DOMAIN),
  tls: (): boolean => pick('tls', config.TLS_MODE === 'cloudflare') ?? false,
  acmeCa: (): 'production' | 'staging' => pick('acmeCa', config.ACME_CA) ?? 'production',
  acmeEmail: (): string | null => pick('acmeEmail', config.ACME_EMAIL),
  tailscaleIp: (): string | null => pick('tailscaleIp', config.TAILSCALE_IP),
  accessEmail: (): string | null => pick('accessEmail', config.ACCESS_EMAIL),
}

/** Das Cloudflare-Token (nie in der Umgebung oder in Logs). */
export const cloudflareToken = (): string | null => cf.token()

/* --- Netz des Servers zur Laufzeit ------------------------------------------------
 * LAN-IP und LAN-Netz ändern sich (DHCP, anderer Router); Airlock liest
 * sie beim Start und stündlich vom Host (domain/network.ts). Erkanntes gilt
 * vor .env. Die Tailscale-IP kommt aus der Cloudflare-Einrichtung oder .env,
 * sonst aus der Erkennung.
 * --------------------------------------------------------------------------- */

export interface NetRuntime { lanIp: string | null; lanCidr: string | null; tailscaleIp: string | null }
let netRt: NetRuntime = { lanIp: null, lanCidr: null, tailscaleIp: null }

/** Nur domain/network.ts ruft das auf. */
export function setNetRuntime(r: NetRuntime): void {
  netRt = r
}

export const net = {
  /** LAN-IP: erkannt, sonst SERVER_LAN_IP */
  lanIp: (): string | null => netRt.lanIp ?? config.SERVER_LAN_IP,
  /** LAN-Netz für den IP-Filter: erkannt, sonst LAN_CIDR */
  lanCidr: (): string => netRt.lanCidr ?? config.LAN_CIDR,
  /** Tailscale-IP: eingetragen (Oberfläche/.env), sonst erkannt */
  tailscaleIp: (): string | null => cf.tailscaleIp() ?? netRt.tailscaleIp,
  detected: (): NetRuntime => netRt,
}

export function hostSettings(): HostSettings {
  return { baseDomain: cf.baseDomain(), lanIp: net.lanIp(), tailscaleIp: net.tailscaleIp(), nipio: config.NIPIO_FALLBACK, tls: cf.tls() }
}

/** nip.io ist nur nutzbar, wenn Tailscale- oder LAN-IP bekannt ist. */
export const nipioEnabled = (): boolean => nipHost('x', hostSettings()) !== null

export const nipioHost = (label: string) => nipHost(label, hostSettings())

/** Die Adresse, die tatsaechlich erreichbar ist (siehe lib/hostnames.ts). */
export const primaryHost = (label: string) => primaryHostFor(label, hostSettings())

export const aliasHosts = (label: string) => aliasHostsFor(label, hostSettings())

/** URL eines Namens: https:// unter der Basisdomain bei TLS, sonst http:// (M4). */
export const urlForHost = (host: string) => urlForFn(host, hostSettings())
