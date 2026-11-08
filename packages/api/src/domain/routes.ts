import { eq, and, ne, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { cf, config, primaryHost, aliasHosts, urlForHost } from '../config.js'
import { caddyTlsOptions } from './cloudflare-settings.js'
import * as caddy from '../drivers/caddy.js'
import * as docker from '../drivers/docker.js'
import { log } from '../lib/log.js'
import { conflict } from '../lib/errors.js'
import { labelOf } from '../lib/hostnames.js'
import { effectiveKind } from './deployments.js'
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
  // M4: https:// für Namen unter der Basisdomain, sobald TLS an ist.
  return [hostname, ...aliases].map((h) => urlForHost(h))
}

export async function routeDtosFor(projectId: string, _slug: string): Promise<RouteDto[]> {
  const rows = await db.select().from(schema.routes).where(eq(schema.routes.projectId, projectId))
  // LAN und Tailnet teilen sich einen Namen (M4): eine Adresse, mehrere Ziele.
  const byHost = new Map<string, RouteDto>()
  for (const r of rows.sort((a, b) => targetOrder(a.target) - targetOrder(b.target))) {
    const have = byHost.get(r.hostname)
    if (have) {
      have.targets = [...(have.targets ?? [have.target]), r.target]
      continue
    }
    if (r.target === 'public') {
      // M5: TLS macht Cloudflare; kein nip.io-Alias für öffentliche Namen.
      byHost.set(r.hostname, { target: r.target, targets: [r.target], hostname: r.hostname, aliases: [], urls: [`https://${r.hostname}`], accessProtected: r.accessProtected })
      continue
    }
    const aliases = aliasesForHost(r.hostname)
    byHost.set(r.hostname, { target: r.target, targets: [r.target], hostname: r.hostname, aliases, urls: urlsFor(r.hostname, aliases) })
  }
  return [...byHost.values()]
}

const targetOrder = (t: string) => ['public', 'lan', 'tailnet'].indexOf(t)

/** Quell-Bereiche je nach Ziel: nur LAN, nur Tailnet oder beides (Review M4). */
export function cidrsForTargets(targets: string[], lanCidr: string, tailnetCidr: string): string[] {
  const out: string[] = []
  if (targets.includes('lan')) out.push(lanCidr)
  if (targets.includes('tailnet')) out.push(tailnetCidr)
  // Healthchecks und Werkzeuge auf dem Server selbst
  out.push('127.0.0.0/8', '::1/128')
  return out
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

  await db.transaction(async (tx) => {
    // Seit Migration 0005 verhindert die Datenbank nicht mehr, dass zwei
    // Projekte denselben Namen unter verschiedenen Zielen tragen. Deshalb
    // Prüfung und Einfügen unter einer Sperre, in einer Transaktion (Review M4).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deployer.routes'))`)
    const clash = await tx.select().from(schema.routes).where(eq(schema.routes.hostname, host))
    if (clash.some((r) => r.projectId !== projectId)) {
      throw conflict(`Der Hostname ${host} ist schon von einem anderen Projekt belegt`)
    }
    // Nur die internen Ziele; die öffentliche Route (M5) verwaltet domain/public.ts.
    await tx.delete(schema.routes).where(and(eq(schema.routes.projectId, projectId), ne(schema.routes.target, 'public')))
    if (targets.length === 0) return
    // LAN und Tailnet zeigen auf denselben Namen (SPEC); seit Migration 0005
    // ist (target, hostname) eindeutig, nicht mehr hostname allein.
    const unique = [...new Set(targets)].filter((t) => t !== 'public')
    if (unique.length === 0) return
    await tx.insert(schema.routes).values(unique.map((t) => ({ projectId, target: t, hostname: host })))
  })
}

/* --- Caddy-Abgleich ------------------------------------------------------- */

interface RouteRow {
  slug: string
  hostname: string
  target: string
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
      target: schema.routes.target,
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
      target: r.target as string,
      // Chat-Projekte (files) laufen als das, als was sie erkannt wurden.
      sourceType: effectiveKind(r.sourceType, r.artifact),
      port: r.port,
      deploymentId: r.deploymentId,
      webContainer: r.artifact?.webContainer ?? null,
    }))
}

/** Container, an den Caddy den Verkehr eines Projekts gibt. */
export function upstreamHost(r: { sourceType: string; slug: string; deploymentId: string; webContainer: string | null }): string {
  if (r.webContainer) return r.webContainer
  return docker.containerName(r.slug, r.deploymentId)
}

export function siteRootFor(slug: string): string {
  return `${config.SITES_DIR}/${slug}/current`
}

/**
 * Woher öffentlicher Verkehr kommen darf: genau die Adresse von cloudflared
 * im Netz «tunnel» (nur cloudflared und Caddy). Nicht das ganze Subnetz – darin liegt auch das Gateway,
 * über das Docker veröffentlichte Ports weiterreicht; ein LAN-Client könnte
 * sonst CF-Connecting-IP vortäuschen (Review M5). Leer, wenn cloudflared
 * nicht läuft – dann gibt es keine öffentlichen Routen.
 */
export async function cloudflaredCidrs(): Promise<string[]> {
  if (!cf.tunnelId()) return []
  const ip = await docker.containerIp(config.CLOUDFLARED_CONTAINER, config.TUNNEL_NETWORK)
  return ip ? [`${ip}/32`] : []
}

export async function buildRouteSpecs(edgeCidrs: string[] = []): Promise<caddy.RouteSpec[]> {
  const rows = await currentRouteRows()
  const specs: caddy.RouteSpec[] = []

  // Die deployer-UI selbst, immer vorhanden.
  specs.push({
    hosts: [primaryHost('deployer'), ...aliasHosts('deployer')],
    kind: 'proxy',
    upstream: config.DEPLOYER_UPSTREAM,
    // Siehe RouteSpec.noKeepAlive: MCP-Aufrufe nach einem Deploy.
    noKeepAlive: true,
  })

  // LAN und Tailnet: zwei Zeilen, ein Name – eine Caddy-Route, deren
  // Quell-Bereiche den gewählten Zielen folgen.
  const targetsByHost = new Map<string, string[]>()
  for (const r of rows) targetsByHost.set(r.hostname, [...(targetsByHost.get(r.hostname) ?? []), r.target])
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.hostname)) continue
    seen.add(r.hostname)
    // M5: öffentliche Namen nur über cloudflared (edge-Netz), ohne nip.io-Alias.
    const isPublic = r.target === 'public'
    if (isPublic && edgeCidrs.length === 0) continue
    const hosts = isPublic ? [r.hostname] : [r.hostname, ...aliasesForHost(r.hostname)]
    const cidrs = isPublic ? edgeCidrs : cidrsForTargets(targetsByHost.get(r.hostname)!, config.LAN_CIDR, config.tailnetCidr)
    if (r.sourceType === 'static') {
      specs.push({ hosts, kind: 'files', root: siteRootFor(r.slug), cidrs })
    } else if (r.port && r.deploymentId) {
      specs.push({
        hosts,
        kind: 'proxy',
        upstream: `${upstreamHost({ ...r, deploymentId: r.deploymentId })}:${r.port}`,
        cidrs,
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
let reconcileChain: Promise<unknown> = Promise.resolve()
let lastCloudflaredCidrs = ''

/**
 * M5: cloudflared bekommt bei jedem Neustart eine neue Adresse. Alle 30 s
 * nachsehen und Caddy neu abgleichen, wenn sie sich geändert hat.
 */
export function startCloudflaredWatch(): NodeJS.Timeout | null {
  // Läuft immer: der Tunnel kann jederzeit über die Oberfläche dazukommen
  const t = setInterval(() => {
    if (!cf.tunnelId() && !lastCloudflaredCidrs) return
    void cloudflaredCidrs().then((c) => {
      if (c.join(',') !== lastCloudflaredCidrs) {
        log.info('cloudflared hat eine neue Adresse; Caddy wird abgeglichen', { cidrs: c })
        return reconcileCaddy()
      }
    }).catch((err) => log.warn('cloudflared-Prüfung fehlgeschlagen', { err: String(err) }))
  }, 30_000)
  t.unref()
  return t
}

/**
 * Nacheinander, nie gleichzeitig: Zwei überlappende Abgleiche lesen die
 * Datenbank zu verschiedenen Zeiten; lädt der ältere Stand zuletzt, fehlt
 * eine eben angelegte Route bis zum nächsten Abgleich (sporadische 404 in
 * der Gesamtsuite, sichtbar geworden mit den Hintergrund-Scans aus M6).
 * Jeder Lauf liest die Datenbank erst, wenn er dran ist – der letzte Stand
 * gewinnt.
 */
export function reconcileCaddy(o: { force?: boolean } = {}): Promise<void> {
  const run = () => reconcileCaddyNow(Boolean(o.force))
  const next = reconcileChain.then(run, run)
  reconcileChain = next.catch(() => {})
  return next
}

async function reconcileCaddyNow(force: boolean): Promise<void> {
  await syncCaddyNetworks()
  const edge = await cloudflaredCidrs()
  lastCloudflaredCidrs = edge.join(',')
  const specs = await buildRouteSpecs(edge)
  // Nur neu laden, wenn sich etwas ändert: jedes Neuladen schliesst ruhende
  // Keep-Alive-Verbindungen, und ein Client (etwa ein MCP-Client) kann genau
  // dann eine Anfrage verlieren.
  const build = caddy.buildCaddyConfig(specs, {
      ipFilter: config.CADDY_IP_FILTER,
      cidrs: [config.LAN_CIDR, config.tailnetCidr, '127.0.0.0/8', '::1/128'],
      adminSocket: config.CADDY_ADMIN_SOCKET,
      // Datenbank (Cloudflare verbinden) oder alte Einrichtung über .env
      tls: caddyTlsOptions(),
      // M5: nur wenn es öffentliche Routen geben kann
      trustedProxies: edge,
    })
  // force: das Token in der Datei hat sich geändert – Caddy liest es nur beim Laden
  const changed = force ? (await caddy.loadConfig(build), true) : await caddy.loadConfigIfChanged(build)
  await caddy.assertAdminOnUnixSocket()
  if (changed) log.info('Caddy abgeglichen', { routen: specs.length, ipFilter: config.CADDY_IP_FILTER })
}
