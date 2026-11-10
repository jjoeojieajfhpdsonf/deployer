import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { config, cf, net } from '../config.js'
import { primaryHost as primaryHostFor, aliasHosts as aliasHostsFor, urlFor as urlForFn, type HostSettings } from '../lib/hostnames.js'
import { log } from '../lib/log.js'

/**
 * M9: Register der Umgebungen im Speicher (SPEC «Umgebungen»,
 * docs/MILESTONE-9.md, Abschnitt 3).
 *
 * Eine Umgebung = Hauptzone + interne Basis <präfix>.<zone> + Cloudflare-
 * Konto (Token) + Standards. Alles, was Adressen, Caddy oder Cloudflare
 * braucht, liest hier statt in der Datenbank – geladen beim Start und nach
 * jeder Änderung (reloadEnvironments).
 */

export type EnvRow = typeof schema.environments.$inferSelect
export type AccountRow = typeof schema.cloudflareAccounts.$inferSelect
export type TunnelRow = typeof schema.tunnels.$inferSelect

export interface EnvRuntime {
  id: string
  slug: string
  name: string
  short: string
  isDefault: boolean
  /** Hauptzone, z. B. «jherren.com»; null = noch nicht gewählt */
  zoneName: string | null
  internalPrefix: string
  /** Interne Basis <präfix>.<zone>, z. B. «int.jherren.com»; null ohne Zone */
  baseDomain: string | null
  row: EnvRow
  account: AccountRow | null
  /** Tunnel des Kontos (einer pro Konto) */
  tunnel: TunnelRow | null
}

/** Interne Basis aus Zone und Präfix; leeres Präfix: die Zone selbst. */
export function baseDomainOf(zoneName: string | null, prefix: string): string | null {
  if (!zoneName) return null
  const p = prefix.trim().replace(/^\.+|\.+$/g, '')
  return p ? `${p}.${zoneName}` : zoneName
}

/**
 * Basis in Zone und Präfix zerlegen. Bekannte Zonen (Tabelle domains) gehen
 * vor; die längste passende gewinnt. Ohne Treffer gilt das erste Label als
 * Präfix («int.example.ch» → «int» + «example.ch»).
 */
export function splitBaseDomain(base: string, zones: string[]): { zone: string; prefix: string } {
  const b = base.toLowerCase()
  const hit = zones
    .map((z) => z.toLowerCase())
    .filter((z) => b === z || b.endsWith(`.${z}`))
    .sort((x, y) => y.length - x.length)[0]
  if (hit) return { zone: hit, prefix: b === hit ? '' : b.slice(0, -(hit.length + 1)) }
  const dot = b.indexOf('.')
  // Ein einzelnes Label hinter dem Präfix wäre keine Zone (com, ch): dann ist die Basis die Zone
  if (dot < 0 || !b.slice(dot + 1).includes('.')) return { zone: b, prefix: '' }
  return { zone: b.slice(dot + 1), prefix: b.slice(0, dot) }
}

/** Name, Slug und Kürzel aus der Hauptzone: «jherren.com» → «jherren.com», «jherren», «JH». */
export function namesForZone(zone: string): { name: string; slug: string; short: string } {
  const first = zone.split('.')[0] ?? zone
  const slug = first.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'standard'
  const letters = first.replace(/[^A-Za-z0-9]/g, '')
  const short = (letters.slice(0, 2) || 'ST').toUpperCase()
  return { name: zone, slug, short }
}

let registry = new Map<string, EnvRuntime>()
let defaultId: string | null = null

export async function reloadEnvironments(): Promise<void> {
  const [envs, accounts, tunnels] = await Promise.all([
    db.select().from(schema.environments).orderBy(asc(schema.environments.createdAt)),
    db.select().from(schema.cloudflareAccounts),
    db.select().from(schema.tunnels),
  ])
  const next = new Map<string, EnvRuntime>()
  for (const e of envs) {
    const account = accounts.find((a) => a.id === e.cloudflareAccountId) ?? null
    const tunnel = account ? tunnels.find((t) => t.cloudflareAccountId === account.id) ?? null : null
    next.set(e.id, {
      id: e.id, slug: e.slug, name: e.name, short: e.short, isDefault: e.isDefault,
      zoneName: e.zoneName, internalPrefix: e.internalPrefix, baseDomain: baseDomainOf(e.zoneName, e.internalPrefix),
      row: e, account, tunnel,
    })
  }
  registry = next
  defaultId = envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? null
}

/** Alle Umgebungen, Standard zuerst. */
export function allEnvironments(): EnvRuntime[] {
  return [...registry.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

export function defaultEnvironment(): EnvRuntime {
  const e = defaultId ? registry.get(defaultId) : undefined
  if (!e) throw new Error('Keine Standard-Umgebung geladen (Migration 0015 und reloadEnvironments beim Start)')
  return e
}

export const defaultEnvironmentId = (): string => defaultEnvironment().id

export function environmentById(id: string): EnvRuntime | null {
  return registry.get(id) ?? null
}

export function environmentBySlug(slug: string): EnvRuntime | null {
  return [...registry.values()].find((e) => e.slug === slug) ?? null
}

/* --- Anlegen -------------------------------------------------------------------- */

export interface CreateEnvironmentInput {
  name: string
  slug: string
  short: string
  /** Cloudflare-Token einer bestehenden Umgebung mitbenutzen (ihr Konto, ihr Tunnel) */
  shareAccountOf?: string | null
  /** Präfix der internen Basis (Standard «int») */
  internalPrefix?: string
}

/**
 * Neue Umgebung, noch ohne Hauptzone. Zone, Token, Zertifikat und Tunnel
 * folgen über die Cloudflare-Schritte (withCloudflareEnv).
 */
export async function createEnvironment(input: CreateEnvironmentInput): Promise<EnvRuntime> {
  const shareFrom = input.shareAccountOf ? environmentById(input.shareAccountOf) : null
  if (input.shareAccountOf && !shareFrom?.account) throw new Error('Diese Umgebung hat kein Cloudflare-Token zum Mitbenutzen')
  const [row] = await db.insert(schema.environments).values({
    name: input.name.trim(),
    slug: input.slug,
    short: input.short.toUpperCase(),
    internalPrefix: input.internalPrefix ?? 'int',
    cloudflareAccountId: shareFrom?.account?.id ?? null,
    legacyImportedAt: new Date(),
  }).returning()
  await reloadEnvironments()
  return environmentById(row!.id)!
}

/* --- Adressen pro Umgebung ------------------------------------------------------ */

/**
 * Einstellungen für die Adressen einer Umgebung (lib/hostnames.ts). Die
 * Standard-Umgebung wie bisher über config.ts (mit Rückfall auf .env);
 * weitere Umgebungen aus ihrer eigenen Basis und ihrem eigenen Zertifikat.
 * LAN-/Tailscale-IP und nip.io sind serverweit.
 */
export function hostSettingsFor(envId: string): HostSettings {
  const env = environmentById(envId) ?? defaultEnvironment()
  return {
    baseDomain: env.isDefault ? cf.baseDomain() : env.baseDomain,
    lanIp: net.lanIp(),
    tailscaleIp: net.tailscaleIp(),
    nipio: config.NIPIO_FALLBACK,
    tls: env.isDefault ? cf.tls() : env.row.tlsState?.phase === 'done',
  }
}

/** Erreichbare Adresse eines Namens in einer Umgebung. */
export const primaryHostIn = (envId: string, label: string) => primaryHostFor(label, hostSettingsFor(envId))
export const aliasHostsIn = (envId: string, label: string) => aliasHostsFor(label, hostSettingsFor(envId))
export const urlForHostIn = (envId: string, host: string) => urlForFn(host, hostSettingsFor(envId))

/** Umgebung, deren interne Basis einen Namen abdeckt (Standard-Umgebung, wenn keine). */
export function environmentForHost(host: string): EnvRuntime {
  const h = host.toLowerCase()
  return allEnvironments().find((e) => {
    const base = hostSettingsFor(e.id).baseDomain
    return base && (h === base || h.endsWith(`.${base}`))
  }) ?? defaultEnvironment()
}

/** Nur für Tests: Register ohne Datenbank setzen. */
export function setEnvironmentsForTests(envs: EnvRuntime[]): void {
  registry = new Map(envs.map((e) => [e.id, e]))
  defaultId = envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? null
}

/* --- Übernahme der Einstellungen von vor M9 ------------------------------------ */

/** Form von app_settings.cloudflare vor M9 (domain/cloudflare-settings.ts). */
export interface LegacyCloudflare {
  tokenEnc?: string
  tokenSavedAt?: string
  lastCheck?: AccountRow['lastCheck']
  accountId?: string
  accountName?: string
  baseDomain?: string
  tailscaleIp?: string | null
  accessEmail?: string | null
  acmeEmail?: string | null
  tunnel?: { id: string; name: string; tokenEnc: string }
  tunnelSkipped?: boolean
  cloudflaredImage?: string
  tls?: schema.StoredTlsState
}

/** Container-Name des Tunnels der Standard-Umgebung – wie vor M9. */
export const DEFAULT_CLOUDFLARED_NAME = () => config.CLOUDFLARED_CONTAINER

const readSetting = async (key: string): Promise<string | null> =>
  (await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1))[0]?.value ?? null

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Einmalig und wiederholbar beim Start: app_settings.cloudflare und
 * pause_page in die Standard-Umgebung übernehmen. Jeder Teil prüft, ob sein
 * Ziel schon gefüllt ist; erst am Ende wird legacy_imported_at gesetzt. Die
 * alten Einträge bleiben als Rückfall stehen. Verschlüsselte Werte werden nur
 * umkopiert (gleicher Schlüssel).
 */
export async function importLegacySettings(): Promise<{ imported: boolean; parts: string[] }> {
  const env = (await db.select().from(schema.environments).where(eq(schema.environments.isDefault, true)))[0]
  if (!env) throw new Error('Keine Standard-Umgebung – Migration 0015 fehlt')
  if (env.legacyImportedAt) return { imported: false, parts: [] }

  const cf = parse<LegacyCloudflare>(await readSetting('cloudflare')) ?? {}
  const pause = parse<NonNullable<EnvRow['pausePage']>>(await readSetting('pause_page'))
  const parts: string[] = []

  await db.transaction(async (tx) => {
    const zones = (await tx.select({ name: schema.domains.name, isDefault: schema.domains.isDefault }).from(schema.domains))
    const patch: Partial<typeof schema.environments.$inferInsert> = {}

    // Konto und Token
    let accountId = env.cloudflareAccountId
    if (!accountId && cf.tokenEnc) {
      const [acc] = await tx.insert(schema.cloudflareAccounts).values({
        cfAccountId: cf.accountId ?? null,
        name: cf.accountName ?? null,
        tokenEnc: cf.tokenEnc,
        tokenSavedAt: cf.tokenSavedAt ? new Date(cf.tokenSavedAt) : null,
        lastCheck: cf.lastCheck ?? null,
      }).returning()
      accountId = acc!.id
      patch.cloudflareAccountId = accountId
      parts.push('token')
    }

    // Tunnel (gehört zum Konto)
    if (accountId && cf.tunnel) {
      const have = await tx.select().from(schema.tunnels).where(eq(schema.tunnels.cloudflareAccountId, accountId))
      if (!have.length) {
        await tx.insert(schema.tunnels).values({
          cloudflareAccountId: accountId,
          cfTunnelId: cf.tunnel.id,
          name: cf.tunnel.name,
          tokenEnc: cf.tunnel.tokenEnc,
          cloudflaredImage: cf.cloudflaredImage ?? null,
          containerName: DEFAULT_CLOUDFLARED_NAME(),
        })
        parts.push('tunnel')
      }
    }

    // Hauptzone und interne Basis
    if (!env.zoneName) {
      const base = cf.baseDomain ?? process.env.INTERNAL_BASE_DOMAIN?.trim().toLowerCase() ?? null
      if (base) {
        const { zone, prefix } = splitBaseDomain(base, zones.map((z) => z.name))
        patch.zoneName = zone
        patch.internalPrefix = prefix
        parts.push('basis')
      } else {
        const def = zones.find((z) => z.isDefault)
        if (def) {
          patch.zoneName = def.name
          parts.push('zone')
        }
      }
      if (patch.zoneName && env.slug === 'standard') {
        const n = namesForZone(patch.zoneName)
        patch.name = n.name
        patch.slug = n.slug
        patch.short = n.short
      }
    }

    if (!env.tlsState && cf.tls) {
      patch.tlsState = cf.tls
      parts.push('zertifikat')
    }
    if (cf.tunnelSkipped) patch.tunnelSkipped = true
    if (cf.accessEmail && env.accessEmails.length === 0) patch.accessEmails = [cf.accessEmail]
    if (cf.acmeEmail && !env.acmeEmail) patch.acmeEmail = cf.acmeEmail
    if (pause && !env.pausePage) {
      patch.pausePage = pause
      parts.push('pause-seite')
    }

    // Tailscale-IP ist serverweit
    if (cf.tailscaleIp !== undefined) {
      const have = await tx.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'server_network'))
      if (!have.length) {
        await tx.insert(schema.appSettings).values({ key: 'server_network', value: JSON.stringify({ tailscaleIp: cf.tailscaleIp }) })
        parts.push('tailscale')
      }
    }

    patch.legacyImportedAt = new Date()
    patch.updatedAt = new Date()
    await tx.update(schema.environments).set(patch).where(eq(schema.environments.id, env.id))
  })

  if (parts.length) {
    log.info('Einstellungen in die Standard-Umgebung übernommen', { teile: parts.join(', '), rueckfall: 'app_settings.cloudflare und pause_page bleiben eine Version stehen' })
  }
  return { imported: true, parts }
}
