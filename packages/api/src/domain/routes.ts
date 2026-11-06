import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { config, primaryHost, aliasHosts } from '../config.js'
import * as caddy from '../drivers/caddy.js'
import * as docker from '../drivers/docker.js'
import { log } from '../lib/log.js'
import { conflict } from '../lib/errors.js'
import { labelOf } from '../lib/hostnames.js'
import type { RouteTarget, RouteDto } from '@deployer/shared'

/**
 * Hostnamen und Caddy-Abgleich.
 *
 * In routes.hostname steht die PRIMAERE Adresse, also die, die tatsaechlich
 * erreichbar ist: mit Basisdomain <label>.<basisdomain>, ohne Basisdomain der
 * nip.io-Name. Weitere Namen (nip.io als Rueckfall neben der Basisdomain)
 * werden aus dem Label berechnet und nicht gespeichert - sonst kollidieren
 * sie mit dem Unique-Index auf hostname und spaeter mit der Cloudflare-
 * Zuordnung in M5.
 *
 * Aendert sich die Basisdomain, leitet rehostRoutes() die gespeicherten
 * Namen beim Start neu ab.
 */

/** Weitere Namen einer Route, aus ihrem gespeicherten Hostnamen abgeleitet. */
export function aliasesForHost(hostname: string): string[] {
  return aliasHosts(labelOf(hostname))
}

export function urlsFor(hostname: string, aliases: string[]): string[] {
  return [hostname, ...aliases].map((h) => `http://${h}`)
}

export async function routeDtosFor(projectId: string, _slug: string): Promise<RouteDto[]> {
  const rows = await db.select().from(schema.routes).where(eq(schema.routes.projectId, projectId))
  return rows.map((r) => {
    const aliases = aliasesForHost(r.hostname)
    return { target: r.target, hostname: r.hostname, aliases, urls: urlsFor(r.hostname, aliases) }
  })
}

/**
 * Leitet die gespeicherten LAN-/Tailnet-Namen aus der aktuellen Konfiguration
 * neu ab. Ohne das behielten bestehende Projekte nach dem Setzen oder Aendern
 * der Basisdomain ihre alte Adresse. Laeuft beim Start vor dem Caddy-Abgleich.
 */
export async function rehostRoutes(): Promise<number> {
  const rows = await db.select().from(schema.routes)
  let changed = 0
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (r.target === 'public') continue // M5: frei gewaehlte oeffentliche Namen
      const want = primaryHost(labelOf(r.hostname))
      if (want === r.hostname) continue
      await tx.update(schema.routes).set({ hostname: want }).where(eq(schema.routes.id, r.id))
      changed++
    }
  })
  if (changed) log.info('Adressen an die aktuelle Konfiguration angepasst', { routen: changed })
  return changed
}

export async function setRoutes(
  projectId: string,
  slug: string,
  targets: RouteTarget[],
  subdomain?: string,
): Promise<void> {
  const host = primaryHost(subdomain ?? slug)

  const clash = await db.select().from(schema.routes).where(eq(schema.routes.hostname, host))
  if (clash.some((r) => r.projectId !== projectId)) {
    throw conflict(`Der Hostname ${host} ist schon von einem anderen Projekt belegt`)
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.routes).where(eq(schema.routes.projectId, projectId))
    if (targets.length === 0) return
    // LAN und Tailnet zeigen auf denselben Namen; ein Eintrag pro Ziel, der
    // Unique-Index auf hostname erlaubt aber nur einen. In M1 gibt es nur lan.
    const unique = [...new Set(targets)]
    await tx.insert(schema.routes).values(
      unique.map((t, i) => ({
        projectId,
        target: t,
        hostname: i === 0 ? host : `${t}-${host}`,
      })),
    )
  })
}

/* --- Caddy-Abgleich ------------------------------------------------------- */

interface RouteRow {
  slug: string
  hostname: string
  sourceType: string
  port: number | null
  deploymentId: string | null
  /** compose: Name des Web-Containers aus dem Artefakt */
  webContainer: string | null
}

async function currentRouteRows(): Promise<RouteRow[]> {
  const rows = await db
    .select({
      slug: schema.projects.slug,
      hostname: schema.routes.hostname,
      sourceType: schema.projects.sourceType,
      port: schema.projects.port,
      status: schema.projects.status,
      desiredState: schema.projects.desiredState,
      deploymentId: schema.deployments.id,
      artifact: schema.deployments.artifact,
    })
    .from(schema.routes)
    .innerJoin(schema.projects, eq(schema.routes.projectId, schema.projects.id))
    .leftJoin(
      schema.deployments,
      and(eq(schema.deployments.projectId, schema.projects.id), eq(schema.deployments.isActive, true)),
    )

  // Nur Projekte mit aktivem Deployment bekommen eine Route. Ein gestopptes
  // Projekt verschwindet damit aus Caddy, statt in einen toten Upstream zu
  // zeigen.
  return rows
    .filter((r) => r.deploymentId !== null && r.desiredState === 'running')
    .map((r) => ({
      slug: r.slug,
      hostname: r.hostname,
      sourceType: r.sourceType,
      port: r.port,
      deploymentId: r.deploymentId,
      webContainer: r.artifact?.webContainer ?? null,
    }))
}

/** Container, an den Caddy den Verkehr eines Projekts gibt. */
export function upstreamHost(r: { sourceType: string; slug: string; deploymentId: string; webContainer: string | null }): string {
  if (r.sourceType === 'compose' && r.webContainer) return r.webContainer
  return docker.containerName(r.slug, r.deploymentId)
}

export function siteRootFor(slug: string): string {
  return `${config.SITES_DIR}/${slug}/current`
}

export async function buildRouteSpecs(): Promise<caddy.RouteSpec[]> {
  const rows = await currentRouteRows()
  const specs: caddy.RouteSpec[] = []

  // Die deployer-UI selbst, immer vorhanden.
  specs.push({
    hosts: [primaryHost('deployer'), ...aliasHosts('deployer')],
    kind: 'proxy',
    upstream: config.DEPLOYER_UPSTREAM,
  })

  for (const r of rows) {
    const hosts = [r.hostname, ...aliasesForHost(r.hostname)]
    if (r.sourceType === 'static') {
      specs.push({ hosts, kind: 'files', root: siteRootFor(r.slug) })
    } else if (r.port && r.deploymentId) {
      specs.push({
        hosts,
        kind: 'proxy',
        upstream: `${upstreamHost({ ...r, deploymentId: r.deploymentId })}:${r.port}`,
      })
    }
  }
  return specs
}

/**
 * Haengt Caddy in genau die Projekt-Netze, die es gerade bedient, und loest
 * alle anderen. Entspricht der SPEC-Regel "nur ins Netzwerk des Projekts,
 * das es gerade bedient".
 */
export async function syncCaddyNetworks(): Promise<void> {
  const rows = await currentRouteRows()
  const needed = new Set(
    rows.filter((r) => r.sourceType !== 'static').map((r) => docker.projectNetworkName(r.slug)),
  )
  const current = await docker.networksOfContainer(config.CADDY_CONTAINER)

  for (const net of current) {
    if (net.startsWith('dep_') && !needed.has(net)) {
      await docker.disconnectFromNetwork(net, config.CADDY_CONTAINER)
      log.info('Caddy aus Projekt-Netz getrennt', { net })
    }
  }
  for (const net of needed) {
    if (!current.includes(net)) {
      await docker.connectToNetwork(net, config.CADDY_CONTAINER)
      log.info('Caddy in Projekt-Netz gehängt', { net })
    }
  }
}

/**
 * Vollstaendiger Abgleich: Netze, dann Konfiguration. Wird nach jeder
 * Aenderung und beim Start aufgerufen. Caddys Zustand ist abgeleitet, die
 * Datenbank ist die Wahrheit.
 */
export async function reconcileCaddy(): Promise<void> {
  await syncCaddyNetworks()
  const specs = await buildRouteSpecs()
  await caddy.loadConfig(
    caddy.buildCaddyConfig(specs, {
      ipFilter: config.CADDY_IP_FILTER,
      cidrs: [config.LAN_CIDR, config.tailnetCidr, '127.0.0.0/8', '::1/128'],
      adminSocket: config.CADDY_ADMIN_SOCKET,
    }),
  )
  await caddy.assertAdminOnUnixSocket()
  log.info('Caddy abgeglichen', { routen: specs.length, ipFilter: config.CADDY_IP_FILTER })
}
