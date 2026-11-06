import { z } from 'zod'
import {
  parseBaseDomain, nipHost, primaryHost as primaryHostFor, aliasHosts as aliasHostsFor,
  type HostSettings,
} from './lib/hostnames.js'

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
  return { ...parsed.data, tailnetCidr: '100.64.0.0/10', version: '0.1.0' }
}

export const config = build()

export const hostSettings: HostSettings = {
  baseDomain: config.INTERNAL_BASE_DOMAIN,
  lanIp: config.SERVER_LAN_IP,
  nipio: config.NIPIO_FALLBACK,
}

/** nip.io ist nur nutzbar, wenn die LAN-IP bekannt ist. */
export const nipioEnabled = nipHost('x', hostSettings) !== null

export const nipioHost = (label: string) => nipHost(label, hostSettings)

/** Die Adresse, die tatsaechlich erreichbar ist (siehe lib/hostnames.ts). */
export const primaryHost = (label: string) => primaryHostFor(label, hostSettings)

export const aliasHosts = (label: string) => aliasHostsFor(label, hostSettings)
