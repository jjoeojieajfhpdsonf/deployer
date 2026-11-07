import { z } from 'zod'
import { readFileSync } from 'node:fs'
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

  DATA_DIR: z.string().default('/data'),
  SITES_DIR: z.string().default('/srv/sites'),
  WEB_DIST: z.string().optional(),

  DEPLOYER_CONTAINER: z.string().default('deployer-app'),
  CADDY_CONTAINER: z.string().default('deployer-caddy'),
  DEPLOYER_UPSTREAM: z.string().default('deployer-app:3000'),

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
  SESSION_SECRET: z.string().trim().default(''),

  DEFAULT_CPU_LIMIT: z.coerce.number().min(0.1).max(16).default(1),
  DEFAULT_MEMORY_LIMIT_MB: z.coerce.number().int().min(64).default(512),

  // M3: Chat-Deploys (Quelle files) nach so vielen Tagen ohne Änderung stoppen.
  CHAT_EXPIRY_DAYS: z.coerce.number().int().min(4).max(3650).default(30),

  // M6: Name des Docker-Volumes mit den statischen Seiten (Compose-Projekt "deployer").
  SITES_VOLUME: z.string().default('deployer_sites'),
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

/** Das Cloudflare-Token, frisch aus der Datei (nie in der Umgebung oder in Logs). */
export function cloudflareToken(): string | null {
  try {
    return readFileSync(config.CLOUDFLARE_API_TOKEN_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
}

export const config = build()

export const hostSettings: HostSettings = {
  baseDomain: config.INTERNAL_BASE_DOMAIN,
  lanIp: config.SERVER_LAN_IP,
  nipio: config.NIPIO_FALLBACK,
  tls: config.TLS_MODE === 'cloudflare',
}

/** nip.io ist nur nutzbar, wenn die LAN-IP bekannt ist. */
export const nipioEnabled = nipHost('x', hostSettings) !== null

export const nipioHost = (label: string) => nipHost(label, hostSettings)

/** Die Adresse, die tatsaechlich erreichbar ist (siehe lib/hostnames.ts). */
export const primaryHost = (label: string) => primaryHostFor(label, hostSettings)

export const aliasHosts = (label: string) => aliasHostsFor(label, hostSettings)

/** URL eines Namens: https:// unter der Basisdomain bei TLS, sonst http:// (M4). */
export const urlForHost = (host: string) => urlForFn(host, hostSettings)
