import { eq, and, sql } from 'drizzle-orm'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { config } from '../config.js'
import { RESERVED_SLUGS } from '@deployer/shared'
import { Cloudflare, CloudflareError, upsertManagedRecord, MANAGED_COMMENT, type Zone } from '../drivers/cloudflare.js'
import { resolvePublicHostname, reconcileIngress, tunnelCname, PublicHostError } from '../lib/public-hosts.js'
import { cloudflareClient } from './tailnet.js'
import { assertPublishable } from '../security/scan.js'
import { reconcileCaddy } from './routes.js'
import { audit } from './audit.js'
import { notify } from '../notify/send.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'
import { log } from '../lib/log.js'

/**
 * M5: öffentlich über Cloudflare Tunnel.
 *
 * Reihenfolge beim Öffentlich-Schalten: Schwelle (M6) -> Name prüfen ->
 * CNAME (proxied, auf den Tunnel) -> optional Access -> Route speichern ->
 * Tunnel-Ingress und Caddy aus der Datenbank abgleichen -> Benachrichtigung.
 * Beim Entfernen umgekehrt. Die Datenbank ist die Wahrheit; der Abgleich
 * räumt nur, was deployer selbst angelegt hat.
 */

const MANAGED_HOSTS_KEY = 'tunnel_managed_hosts'

export function publicEnabled(): boolean {
  return Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_TUNNEL_ID && cloudflareClient())
}

function client(): Cloudflare {
  const cf = cloudflareClient()
  if (!cf || !config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_TUNNEL_ID) {
    throw new AppError('public_disabled', 'Öffentlich ist nicht eingerichtet (Meilenstein 5): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TUNNEL_ID und das Cloudflare-Token fehlen (siehe compose.public.yaml)', 400)
  }
  return cf
}

/** Fehler von Cloudflare als saubere API-Fehler. */
function wrap(err: unknown): never {
  if (err instanceof PublicHostError) throw badRequest(err.message)
  if (err instanceof CloudflareError) throw new AppError('cloudflare', err.message, err.status === 409 ? 409 : err.status >= 400 && err.status < 500 ? 400 : 502)
  throw err
}

/* --- Domains -------------------------------------------------------------------- */

export interface DomainDto { id: string; name: string; zoneId: string; isDefault: boolean }

/** Zonen des Kontos holen und in `domains` spiegeln. Die Standard-Wahl bleibt. */
export async function syncDomains(cf = client()): Promise<DomainDto[]> {
  let zones: Zone[]
  try {
    zones = await cf.listZones()
  } catch (err) {
    wrap(err)
  }
  await db.transaction(async (tx) => {
    for (const z of zones) {
      await tx
        .insert(schema.domains)
        .values({ cfZoneId: z.id, name: z.name.toLowerCase() })
        .onConflictDoUpdate({ target: schema.domains.cfZoneId, set: { name: z.name.toLowerCase() } })
    }
    const ids = zones.map((z) => z.id)
    const existing = await tx.select().from(schema.domains)
    const used = (await tx.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))).map((r) => r.hostname)
    for (const d of existing) {
      if (ids.includes(d.cfZoneId)) continue
      // Noch von einer öffentlichen Route benutzt: behalten, sonst fände das
      // Aufräumen den DNS-Eintrag später nicht mehr (Review M5).
      if (used.some((h) => h === d.name || h.endsWith(`.${d.name}`))) continue
      await tx.delete(schema.domains).where(eq(schema.domains.id, d.id))
    }
  })
  return listDomains()
}

export async function listDomains(): Promise<DomainDto[]> {
  const rows = await db.select().from(schema.domains).orderBy(schema.domains.name)
  return rows.map((d) => ({ id: d.id, name: d.name, zoneId: d.cfZoneId, isDefault: d.isDefault }))
}

export async function setDefaultDomain(name: string, actor: string): Promise<DomainDto[]> {
  const n = name.trim().toLowerCase()
  const row = (await db.select().from(schema.domains).where(eq(schema.domains.name, n)))[0]
  if (!row) throw badRequest(`${n} ist keine Zone dieses Cloudflare-Kontos (Liste zuerst abgleichen)`)
  await db.transaction(async (tx) => {
    await tx.update(schema.domains).set({ isDefault: false }).where(eq(schema.domains.isDefault, true))
    await tx.update(schema.domains).set({ isDefault: true }).where(eq(schema.domains.id, row.id))
  })
  await audit({ actor, action: 'domain.default', targetType: 'domain', targetId: row.id, params: { name: n }, result: 'ok' })
  return listDomains()
}

/* --- Öffentlich schalten --------------------------------------------------------- */

export interface PublicInput {
  subdomain?: string
  hostname?: string
  /** undefined = wie bisher (Review M5: sonst fiel Access beim nächsten Aufruf still weg) */
  accessProtected?: boolean
}

export async function publicRoute(projectId: string) {
  return (await db.select().from(schema.routes).where(and(eq(schema.routes.projectId, projectId), eq(schema.routes.target, 'public'))))[0] ?? null
}

type Project = { id: string; slug: string; name: string }
type PublicRouteRow = NonNullable<Awaited<ReturnType<typeof publicRoute>>>

export interface PublicPlan {
  project: Project
  hostname: string
  zone: Zone
  access: boolean
  before: PublicRouteRow | null
}

/**
 * Alles prüfen, was "public" verhindern würde – ohne etwas zu ändern:
 * Konfiguration, Schwelle (M6), Name, Belegung, ACCESS_EMAIL. Aufrufer
 * machen das, BEVOR sie interne Ziele umstellen; danach können nur noch
 * Fehler von Cloudflare selbst auftreten (Review M5).
 *
 * Fehlen Name oder Access in der Eingabe, gilt der bisherige Stand.
 */
export async function planPublic(project: Project, input: PublicInput): Promise<PublicPlan> {
  const cf = client()
  await assertPublishable(project.id)
  try {
    const before = await publicRoute(project.id)
    const domains = await listDomains().then((d) => (d.length ? d : syncDomains(cf)))
    const nameGiven = Boolean(input.subdomain || input.hostname)
    const { hostname, zone } = resolvePublicHostname(
      nameGiven ? { subdomain: input.subdomain, hostname: input.hostname } : before ? { hostname: before.hostname } : { subdomain: project.slug },
      {
        zones: domains.map((d) => ({ id: d.zoneId, name: d.name })),
        defaultZone: domains.find((d) => d.isDefault)?.name ?? null,
        internalBaseDomain: config.INTERNAL_BASE_DOMAIN,
        reservedLabels: RESERVED_SLUGS,
      },
    )
    const clash = await db.select().from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, hostname)))
    if (clash.some((r) => r.projectId !== project.id)) throw conflict(`${hostname} ist schon von einem anderen Projekt belegt`)
    const access = input.accessProtected ?? Boolean(before?.accessProtected)
    if (access && !config.ACCESS_EMAIL) throw badRequest('Für Cloudflare Access braucht es ACCESS_EMAIL in der Konfiguration')
    return { project, hostname, zone, access, before }
  } catch (err) {
    wrap(err)
  }
}

/**
 * Macht ein Projekt öffentlich oder ändert Name/Access nach einem Plan aus
 * planPublic. Die Bestätigung (MCP) und die Rückfrage (UI) liegen beim
 * Aufrufer. Scheitert ein Schritt, wird zurückgenommen, was dieser Aufruf
 * bei Cloudflare neu angelegt hat.
 */
export async function applyPublic(plan: PublicPlan, actor: string): Promise<{ hostname: string }> {
  const cf = client()
  const { project, hostname, zone, before } = plan
  const created: { recordId?: string; accessId?: string } = {}
  try {
    // 1. DNS: CNAME proxied auf den Tunnel; fremde Einträge bleiben unangetastet.
    const rec = await upsertManagedRecord(cf, zone.id, { type: 'CNAME', name: hostname, content: tunnelCname(config.CLOUDFLARE_TUNNEL_ID!), proxied: true })
    if (rec.action === 'created') created.recordId = rec.record.id

    // 2. Access
    let accessAppId = before?.hostname === hostname ? before.cfAccessAppId : null
    if (plan.access && !accessAppId) {
      accessAppId = (await cf.createAccessApp(config.CLOUDFLARE_ACCOUNT_ID!, { name: `deployer: ${project.name}`, domain: hostname, email: config.ACCESS_EMAIL! })).id
      created.accessId = accessAppId
    }

    // 3. Route speichern (eine öffentliche Route pro Projekt), Belegung unter Sperre erneut prüfen
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deployer.routes'))`)
      const clash = await tx.select().from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, hostname)))
      if (clash.some((r) => r.projectId !== project.id)) throw conflict(`${hostname} ist schon von einem anderen Projekt belegt`)
      await tx.delete(schema.routes).where(and(eq(schema.routes.projectId, project.id), eq(schema.routes.target, 'public')))
      await tx.insert(schema.routes).values({
        projectId: project.id, target: 'public', hostname, cfDnsRecordId: rec.record.id,
        accessProtected: Boolean(accessAppId) && plan.access, cfAccessAppId: plan.access ? accessAppId : null,
      })
    })
    created.recordId = undefined
    created.accessId = undefined

    // 4. Access abgeschaltet: App weg (erst nach dem Speichern, dann ist der Stand konsistent)
    if (!plan.access && accessAppId) await cf.deleteAccessApp(config.CLOUDFLARE_ACCOUNT_ID!, accessAppId).catch((e) => log.warn('Access-App nicht entfernt', { err: String(e) }))

    // 5. Alter Name (bei Umbenennung) aus DNS und Access entfernen
    if (before && before.hostname !== hostname) await dropCloudflareObjects(cf, before).catch((e) => log.warn('Alter öffentlicher Name nicht vollständig entfernt', { err: String(e) }))

    // 6. Tunnel aus der Datenbank (Caddy gleicht der Aufrufer ab)
    await reconcileTunnel(cf)

    await audit({ actor, action: 'project.public', targetType: 'project', targetId: project.id, params: { hostname, accessProtected: plan.access }, result: 'ok' })
    if (!before) await notify('project_public', { project: project.name, url: `https://${hostname}` }, project.id)
    return { hostname }
  } catch (err) {
    // Zurücknehmen, was dieser Aufruf neu angelegt hat (Review M5: sonst verwaist bei Cloudflare)
    if (created.accessId) await cf.deleteAccessApp(config.CLOUDFLARE_ACCOUNT_ID!, created.accessId).catch(() => {})
    if (created.recordId) await cf.deleteRecord(zone.id, created.recordId).catch(() => {})
    wrap(err)
  }
}

/** Bequemer Weg für Aufrufer ohne interne Ziele dazwischen. */
export async function setPublic(project: Project, input: PublicInput, actor: string): Promise<{ hostname: string }> {
  return applyPublic(await planPublic(project, input), actor)
}

/** Öffentliche Route entfernen: CNAME, Access, Ingress, Caddy. */
export async function removePublic(project: { id: string; slug: string }, actor: string, opts: { strict?: boolean; skipCaddy?: boolean } = {}): Promise<boolean> {
  const route = await publicRoute(project.id)
  if (!route) return false
  const cf = cloudflareClient()
  const problems: string[] = []
  if (cf && config.CLOUDFLARE_ACCOUNT_ID) {
    await dropCloudflareObjects(cf, route).catch((e) => problems.push(String((e as Error).message)))
  } else {
    problems.push('kein Cloudflare-Token: DNS-Eintrag und Access-App bleiben bei Cloudflare stehen')
  }
  await db.delete(schema.routes).where(eq(schema.routes.id, route.id))
  if (cf && config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_TUNNEL_ID) {
    await reconcileTunnel(cf).catch((e) => problems.push(`Tunnel: ${(e as Error).message}`))
  }
  // Ein Fehler hier (etwa ein schon entferntes Projekt-Netz beim Löschen)
  // darf Audit und Meldung nicht verhindern (Review M5).
  if (!opts.skipCaddy) await reconcileCaddy().catch((e) => log.warn('Caddy-Abgleich nach Entfernen fehlgeschlagen', { err: String(e) }))
  await audit({ actor, action: 'project.public.remove', targetType: 'project', targetId: project.id, params: { hostname: route.hostname }, result: problems.length ? 'error' : 'ok', error: problems.join('; ') || undefined })
  if (problems.length) {
    // Löschen soll nicht an Cloudflare scheitern; Reste melden (SPEC M5).
    await notify('infra_problem', { what: 'Cloudflare-Aufräumen', detail: `${route.hostname}: ${problems.join('; ')}` })
    if (opts.strict) throw new AppError('cloudflare', problems.join('; '), 502)
  }
  return true
}

async function dropCloudflareObjects(cf: Cloudflare, route: { hostname: string; cfDnsRecordId: string | null; cfAccessAppId: string | null }): Promise<void> {
  const domains = await listDomains()
  const zone = domains.find((d) => route.hostname === d.name || route.hostname.endsWith(`.${d.name}`))
  if (route.cfDnsRecordId && !zone) throw new Error(`Zone von ${route.hostname} unbekannt; DNS-Eintrag bitte in Cloudflare von Hand entfernen`)
  if (route.cfDnsRecordId && zone) {
    // Nur löschen, was wirklich von deployer stammt.
    const recs = await cf.listRecords(zone.zoneId, route.hostname)
    const mine = recs.find((r) => r.id === route.cfDnsRecordId && r.comment === MANAGED_COMMENT)
    if (mine) await cf.deleteRecord(zone.zoneId, mine.id)
  }
  if (route.cfAccessAppId) await cf.deleteAccessApp(config.CLOUDFLARE_ACCOUNT_ID!, route.cfAccessAppId)
}

/* --- Tunnel ------------------------------------------------------------------------ */

let tunnelChain: Promise<unknown> = Promise.resolve()

/**
 * Ingress-Regeln aus allen öffentlichen Routen; fremde Regeln bleiben.
 * Nacheinander wie der Caddy-Abgleich: zwei überlappende Läufe könnten sonst
 * einen eben gesetzten Namen mit einem älteren Stand überschreiben (Review M5).
 */
export function reconcileTunnel(cf = client()): Promise<{ hosts: string[] }> {
  const run = () => reconcileTunnelNow(cf)
  const next = tunnelChain.then(run, run)
  tunnelChain = next.catch(() => {})
  return next
}

async function reconcileTunnelNow(cf: Cloudflare): Promise<{ hosts: string[] }> {
  const rows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))
  const managedBefore: string[] = JSON.parse((await getSetting(MANAGED_HOSTS_KEY)) ?? '[]')
  const current = await cf.getTunnelIngress(config.CLOUDFLARE_ACCOUNT_ID!, config.CLOUDFLARE_TUNNEL_ID!)
  const forbidden = config.INTERNAL_BASE_DOMAIN ? rows.map((r) => r.hostname).filter((h) => h.endsWith(`.${config.INTERNAL_BASE_DOMAIN}`)) : []
  const { ingress, managed } = reconcileIngress(current, rows.map((r) => r.hostname), managedBefore, forbidden)
  if (JSON.stringify(ingress) !== JSON.stringify(current)) {
    await cf.putTunnelIngress(config.CLOUDFLARE_ACCOUNT_ID!, config.CLOUDFLARE_TUNNEL_ID!, ingress)
    log.info('Tunnel-Ingress abgeglichen', { hosts: managed })
  }
  await setSetting(MANAGED_HOSTS_KEY, JSON.stringify(managed))
  return { hosts: managed }
}

let tunnelCache: { at: number; v: { status: string; connections: number } } | null = null

/** Zustand des Tunnels, höchstens eine Minute alt (die Systemseite fragt alle 15 s). */
export async function tunnelStatus(): Promise<{ status: string; connections: number } | null> {
  if (!publicEnabled()) return null
  // Veraltet: im Hintergrund neu holen und sofort den letzten Stand liefern –
  // die Systemseite soll nie auf Cloudflare warten (Review M5).
  if (!tunnelCache || Date.now() - tunnelCache.at >= 60_000) {
    const refresh = refreshTunnelStatus()
    if (!tunnelCache) return refresh
  }
  return tunnelCache!.v
}

let refreshing: Promise<{ status: string; connections: number }> | null = null
function refreshTunnelStatus(): Promise<{ status: string; connections: number }> {
  refreshing ??= (async () => {
    let v: { status: string; connections: number }
    try {
      v = await client().tunnelStatus(config.CLOUDFLARE_ACCOUNT_ID!, config.CLOUDFLARE_TUNNEL_ID!)
    } catch (err) {
      v = { status: `Fehler: ${(err as Error).message}`, connections: 0 }
    }
    tunnelCache = { at: Date.now(), v }
    refreshing = null
    return v
  })()
  return refreshing
}

/** Beim Start: Tunnel aus der Datenbank, im Hintergrund. */
export async function reconcilePublicOnBoot(): Promise<void> {
  if (!publicEnabled()) return
  try {
    await syncDomains()
    await reconcileTunnel()
  } catch (err) {
    log.warn('Abgleich mit Cloudflare beim Start fehlgeschlagen', { err: (err as Error).message })
  }
}
