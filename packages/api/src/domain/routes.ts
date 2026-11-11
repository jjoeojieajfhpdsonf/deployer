import { eq, and, ne, gt, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { config, net, primaryHost, aliasHosts } from '../config.js'
import { caddyTlsOptionsAll, tlsPhases, cloudflareFor } from './cloudflare-settings.js'
import { allEnvironments, defaultEnvironmentId, primaryHostIn, aliasHostsIn, urlForHostIn } from './environments.js'
import * as caddy from '../drivers/caddy.js'
import { needsCacheEvict, withoutCertificates } from '../drivers/caddy-config.js'
import * as docker from '../drivers/docker.js'
import { log } from '../lib/log.js'
import { conflict } from '../lib/errors.js'
import { labelOf } from '../lib/hostnames.js'
import { effectiveKind } from './deployments.js'
import { effectivePausePage, renderPausePage, UI_HOST_LABEL, type RouteTarget, type RouteDto, type PausePage } from '@airlock/shared'
import { isProjectScoped } from '../lib/names.js'
import { pausePageTemplate, displayTimeZone, writePauseFile } from './pause-page.js'
import type { HeaderRuleSpec } from '../security/header-rules.js'
import { internalServiceRoutes, type InternalServiceRoute } from '../lib/internal-routes.js'
import { composeWebContainer } from '../lib/compose.js'

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

/** Weitere Namen einer Route, aus ihrem gespeicherten Hostnamen abgeleitet (M9: in der Umgebung des Projekts). */
export function aliasesForHost(hostname: string, envId: string = defaultEnvironmentId()): string[] {
  return aliasHostsIn(envId, labelOf(hostname))
}

export function urlsFor(hostname: string, aliases: string[], envId: string = defaultEnvironmentId()): string[] {
  // M4: https:// für Namen unter der Basisdomain, sobald TLS an ist (M9: Basis und Zertifikat der Umgebung).
  return [hostname, ...aliases].map((h) => urlForHostIn(envId, h))
}

/** Umgebung eines Projekts (für Adressen). */
async function envOfProject(projectId: string): Promise<string> {
  const row = (await db.select({ env: schema.projects.environmentId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]
  return row?.env ?? defaultEnvironmentId()
}

export async function routeDtosFor(projectId: string, _slug: string): Promise<RouteDto[]> {
  const envId = await envOfProject(projectId)
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
      byHost.set(r.hostname, {
        target: r.target, targets: [r.target], hostname: r.hostname, aliases: [], urls: [`https://${r.hostname}`], accessProtected: r.accessProtected,
        since: r.createdAt.toISOString(), pausedAt: r.pausedAt?.toISOString() ?? null,
      })
      continue
    }
    const aliases = aliasesForHost(r.hostname, envId)
    byHost.set(r.hostname, { target: r.target, targets: [r.target], hostname: r.hostname, aliases, urls: urlsFor(r.hostname, aliases, envId) })
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
export async function rehostRoutes(envId?: string): Promise<number> {
  // M9: jede Route nach der Basis der Umgebung ihres Projekts; mit envId nur diese Umgebung
  const rows = await db.select({ id: schema.routes.id, target: schema.routes.target, hostname: schema.routes.hostname, env: schema.projects.environmentId })
    .from(schema.routes).innerJoin(schema.projects, eq(schema.projects.id, schema.routes.projectId))
    .where(envId ? eq(schema.projects.environmentId, envId) : undefined)
  let changed = 0
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (r.target === 'public') continue // M5: frei gewaehlte oeffentliche Namen
      const want = primaryHostIn(r.env, labelOf(r.hostname))
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
  // M9: interne Adresse unter der Basis der Umgebung des Projekts
  const host = primaryHostIn(await envOfProject(projectId), subdomain ?? slug)

  await db.transaction(async (tx) => {
    // Seit Migration 0005 verhindert die Datenbank nicht mehr, dass zwei
    // Projekte denselben Namen unter verschiedenen Zielen tragen. Deshalb
    // Prüfung und Einfügen unter einer Sperre, in einer Transaktion (Review M4).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('airlock.routes'))`)
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
  projectId: string
  /** M9: Umgebung des Projekts (Aliase, Pause-Vorlage) */
  environmentId: string
  slug: string
  hostname: string
  target: string
  sourceType: string
  port: number | null
  deploymentId: string | null
  /** compose: Name des Web-Containers aus dem Artefakt */
  webContainer: string | null
  /** compose (Etappe 4): Dienste mit eigener interner Adresse */
  internalRoutes: { service: string; port: number }[]
  /** Öffentlich pausiert: Wartungsseite statt Projekt */
  paused: boolean
  /** Pausiert: eigene Seite des Projekts (null = Vorlage) und «Voraussichtlich zurück» */
  pausePage: PausePage | null
  pauseBackAt: string | null
}

async function currentRouteRows(): Promise<RouteRow[]> {
  const rows = await db
    .select({
      projectId: schema.projects.id,
      environmentId: schema.projects.environmentId,
      slug: schema.projects.slug,
      hostname: schema.routes.hostname,
      target: schema.routes.target,
      sourceType: schema.projects.sourceType,
      port: schema.projects.port,
      status: schema.projects.status,
      desiredState: schema.projects.desiredState,
      deploymentId: schema.deployments.id,
      artifact: schema.deployments.artifact,
      pausedAt: schema.routes.pausedAt,
      pausePage: schema.routes.pausePage,
      pauseBackAt: schema.routes.pauseBackAt,
    })
    .from(schema.routes)
    .innerJoin(schema.projects, eq(schema.routes.projectId, schema.projects.id))
    .leftJoin(
      schema.deployments,
      and(eq(schema.deployments.projectId, schema.projects.id), eq(schema.deployments.isActive, true)),
    )

  // Nur Projekte mit aktivem Deployment bekommen eine Route. Ein gestopptes
  // Projekt verschwindet damit aus Caddy, statt in einen toten Upstream zu
  // zeigen. Ausnahme: ein pausierter öffentlicher Name zeigt die
  // Wartungsseite, ob das Projekt läuft oder nicht.
  const paused = (r: (typeof rows)[number]) => r.target === 'public' && r.pausedAt !== null
  return rows
    .filter((r) => paused(r) || (r.deploymentId !== null && r.desiredState === 'running'))
    .map((r) => ({
      paused: paused(r),
      pausePage: r.pausePage ?? null,
      pauseBackAt: r.pauseBackAt?.toISOString() ?? null,
      projectId: r.projectId,
      environmentId: r.environmentId,
      slug: r.slug,
      hostname: r.hostname,
      target: r.target as string,
      // Chat-Projekte (files) laufen als das, als was sie erkannt wurden.
      sourceType: effectiveKind(r.sourceType, r.artifact),
      port: r.port,
      deploymentId: r.deploymentId,
      webContainer: r.artifact?.webContainer ?? null,
      internalRoutes: r.artifact?.internalRoutes ?? [],
    }))
}

/**
 * Etappe 4: interne Adressen der Dienste (Adminer usw.) aus den aktuellen
 * Routen – nur intern, siehe lib/internal-routes.ts.
 */
export async function currentInternalServiceRoutes(taken: Set<string> = new Set()): Promise<InternalServiceRoute[]> {
  const rows = await currentRouteRows()
  const env = new Map(rows.map((r) => [r.projectId, r.environmentId]))
  return internalServiceRoutes(rows, {
    hostFor: (projectId, label) => primaryHostIn(env.get(projectId) ?? defaultEnvironmentId(), label),
    containerFor: (slug, service) => composeWebContainer(docker.projectNetworkName(slug), service),
    taken,
  })
}

/** Container, an den Caddy den Verkehr eines Projekts gibt. */
export function upstreamHost(
  r: { sourceType: string; slug: string; deploymentId: string; webContainer: string | null },
  legacy: docker.LegacyState = docker.legacySnapshot(),
): string {
  return docker.webContainerOf(r.slug, { id: r.deploymentId, webContainer: r.webContainer }, legacy)
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
  // M9: ein cloudflared je Tunnel (einer pro Cloudflare-Konto)
  const names = [...new Set(allEnvironments().map((e) => cloudflareFor(e.id)).filter((c) => c.tunnelId).map((c) => c.containerName))]
  const out: string[] = []
  for (const name of names) {
    const ip = await docker.containerIp(name, config.TUNNEL_NETWORK).catch(() => null)
    if (ip) out.push(`${ip}/32`)
  }
  return out.sort()
}

/** Gibt es irgendeinen Tunnel? */
const anyTunnel = (): boolean => allEnvironments().some((e) => Boolean(cloudflareFor(e.id).tunnelId))

/**
 * M8: Header-Regeln aller Projekte, je Projekt, mit dem Schlüssel der
 * CSP-Meldungen (Browser melden an /.well-known/airlock/csp-report/<key>
 * am Host des Projekts, Caddy leitet an Airlock weiter).
 */
async function headerRulesByProject(): Promise<Map<string, { rules: HeaderRuleSpec[]; cspReportKey: string | null }>> {
  const all = await db.select().from(schema.headerRules)
  const out = new Map<string, { rules: HeaderRuleSpec[]; cspReportKey: string | null }>()
  for (const r of all) {
    const e = out.get(r.projectId) ?? { rules: [], cspReportKey: null }
    // M9: «off» schaltet nur eine Vorlage ab, ist selbst keine Regel
    if (r.mode !== 'off') e.rules.push({ header: r.header, value: r.value, mode: r.mode })
    if (r.reportKey) e.cspReportKey = r.reportKey
    out.set(r.projectId, e)
  }
  // M9: Header-Vorlagen der Umgebung gelten für jedes Projekt ohne eigene Regel (live geerbt)
  const templates = await db.select().from(schema.headerRuleTemplates)
  if (templates.length) {
    const projects = await db.select({ id: schema.projects.id, env: schema.projects.environmentId }).from(schema.projects)
    for (const p of projects) {
      const own = all.filter((r) => r.projectId === p.id)
      const inherit = templates.filter((t) => t.environmentId === p.env && !own.some((r) => r.header === t.header))
      if (!inherit.length) continue
      const e = out.get(p.id) ?? { rules: [], cspReportKey: null }
      e.rules.push(...inherit.map((t) => ({ header: t.header, value: t.value, mode: t.mode })))
      out.set(p.id, e)
    }
  }
  return out
}

/**
 * M8: Unter welchem Namen fragt der Header-Check ein Projekt über Caddys
 * Probe-Server? Der interne Name (LAN/Tailnet), sonst der öffentliche, wenn
 * es dafür eine Caddy-Route gibt. null: Caddy bedient das Projekt nicht.
 */
export async function probeTargetFor(projectId: string): Promise<{ host: string; url: string; secure: boolean } | null> {
  if (!config.CADDY_PROBE_SOCKET) return null
  const rows = (await currentRouteRows()).filter((r) => r.projectId === projectId)
  const internal = rows.find((r) => r.target !== 'public')
  const pub = rows.find((r) => r.target === 'public')
  const row = internal ?? (pub && (await cloudflaredCidrs()).length ? pub : null)
  if (!row) return null
  const url = `${urlForHostIn(row.environmentId, row.hostname)}/`
  return { host: row.hostname, url, secure: url.startsWith('https:') }
}

export async function buildRouteSpecs(edgeCidrs: string[] = []): Promise<caddy.RouteSpec[]> {
  const rows = await currentRouteRows()
  const headers = await headerRulesByProject()
  // Übergang: Fassungen aus der deployer-Zeit heissen noch dep_<slug>_…
  const legacy = await docker.legacyState().catch(() => docker.legacySnapshot())
  const specs: caddy.RouteSpec[] = []

  // Die Oberfläche von Airlock selbst, immer vorhanden (Adresse vorerst deployer.<basis>).
  specs.push({
    hosts: [primaryHost(UI_HOST_LABEL), ...aliasHosts(UI_HOST_LABEL)],
    kind: 'proxy',
    upstream: config.AIRLOCK_UPSTREAM,
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
    const hosts = isPublic ? [r.hostname] : [r.hostname, ...aliasesForHost(r.hostname, r.environmentId)]
    const cidrs = isPublic ? edgeCidrs : cidrsForTargets(targetsByHost.get(r.hostname)!, net.lanCidr(), config.tailnetCidr)
    const h = headers.get(r.projectId)
    const extra = h ? { headers: h.rules, cspReportKey: h.cspReportKey } : {}
    if (r.paused) {
      // M9: Vorlage der Umgebung des Projekts
      const page = effectivePausePage(await pausePageTemplate(r.environmentId), r.pausePage)
      const pause = { page, backAt: r.pauseBackAt, timeZone: displayTimeZone() }
      // Code-Modus: als Datei ausliefern (siehe caddy-config.ts); scheitert das Schreiben, gilt das Formular
      const root = page.mode === 'code' && page.html
        ? await writePauseFile(config.SITES_DIR, r.slug, renderPausePage(page, pause)).catch((err) => {
            log.warn('Pause-Seite nicht geschrieben, Formular-Seite stattdessen', { slug: r.slug, err: String(err) })
            return undefined
          })
        : undefined
      specs.push({ hosts, kind: 'maintenance', cidrs, pause: { ...pause, root }, visits: true })
    } else if (r.sourceType === 'static') {
      specs.push({ hosts, kind: 'files', root: siteRootFor(r.slug), cidrs, ...extra, visits: true })
    } else if (r.port && r.deploymentId) {
      specs.push({
        hosts,
        kind: 'proxy',
        upstream: `${upstreamHost({ ...r, deploymentId: r.deploymentId }, legacy)}:${r.port}`,
        cidrs,
        ...extra,
        // Etappe 3: Besucher-Log (nur Projekte, nie die Oberfläche)
        visits: true,
      })
    }
  }

  // Etappe 4: eigene interne Adressen von Diensten (x-airlock-internal) – nur LAN/Tailnet, nie öffentlich
  for (const ir of await currentInternalServiceRoutes(seen)) {
    const envId = rows.find((r) => r.projectId === ir.projectId)?.environmentId
    const h = headers.get(ir.projectId)
    seen.add(ir.hostname)
    specs.push({
      hosts: [ir.hostname, ...aliasesForHost(ir.hostname, envId)],
      kind: 'proxy',
      upstream: ir.upstream,
      cidrs: cidrsForTargets(ir.targets, net.lanCidr(), config.tailnetCidr),
      ...(h ? { headers: h.rules } : {}),
    })
  }

  // M9: Nach dem Verschieben leitet die alte interne Adresse 30 Tage weiter
  // (308, nur aus LAN und Tailnet – dieselben Netze wie interne Namen).
  const now = new Date()
  const redirects = await db.select().from(schema.routeRedirects).where(gt(schema.routeRedirects.until, now))
  for (const rd of redirects) {
    if (seen.has(rd.fromHost)) continue // der alte Name gehört inzwischen einem Projekt
    const target = rd.projectId ? await envOfProject(rd.projectId) : defaultEnvironmentId()
    specs.push({
      hosts: [rd.fromHost],
      kind: 'redirect',
      redirectTo: urlForHostIn(target, rd.toHost),
      cidrs: cidrsForTargets(['lan', 'tailnet'], net.lanCidr(), config.tailnetCidr),
    })
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
  const legacy = await docker.legacyState()
  const needed = new Set(
    // Die Wartungsseite braucht kein Projekt-Netz. Fassungen aus der
    // deployer-Zeit laufen noch in dep_<slug> (Übergang).
    rows
      .filter((r) => r.sourceType !== 'static' && !r.paused && r.deploymentId)
      .map((r) => docker.networkOf(r.slug, { id: r.deploymentId!, webContainer: r.webContainer }, legacy)),
  )
  const current = await docker.networksOfContainer(config.CADDY_CONTAINER)

  for (const net of current) {
    if (isProjectScoped(net) && !needed.has(net)) {
      await docker.disconnectFromNetwork(net, config.CADDY_CONTAINER)
      log.info('Caddy aus Projekt-Netz getrennt', { net })
    }
  }
  for (const net of needed) {
    if (!current.includes(net)) {
      try {
        await docker.connectToNetwork(net, config.CADDY_CONTAINER)
      } catch (err) {
        // Netz fehlt (Container weg, Projekt noch nicht neu deployt): die
        // übrigen Projekte nicht mit hinunterziehen.
        if ((err as { statusCode?: number }).statusCode === 404) {
          log.warn('Projekt-Netz fehlt, Caddy nicht verbunden', { net })
          continue
        }
        throw err
      }
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
    if (!anyTunnel() && !lastCloudflaredCidrs) return
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

let lastBuildHadTls = false
/** M8: Caddy hat das Ratenlimit-Modul nicht (altes Image) – bis zum Neustart von Airlock */
let cspForwardUnsupported = false

async function reconcileCaddyNow(force: boolean): Promise<void> {
  await syncCaddyNetworks()
  const edge = await cloudflaredCidrs()
  lastCloudflaredCidrs = edge.join(',')
  const specs = await buildRouteSpecs(edge)
  const tlsList = caddyTlsOptionsAll().map(({ envId: _envId, ...t }) => t)
  // Nur neu laden, wenn sich etwas ändert: jedes Neuladen schliesst ruhende
  // Keep-Alive-Verbindungen, und ein Client (etwa ein MCP-Client) kann genau
  // dann eine Anfrage verlieren.
  const buildWith = (cspForward: boolean) => caddy.buildCaddyConfig(specs, {
      ipFilter: config.CADDY_IP_FILTER,
      cidrs: [net.lanCidr(), config.tailnetCidr, '127.0.0.0/8', '::1/128'],
      adminSocket: config.CADDY_ADMIN_SOCKET,
      // M9: eine interne Basis je Umgebung (Datenbank); Standard-Umgebung auch alte Einrichtung über .env
      tls: tlsList,
      // M5: nur wenn es öffentliche Routen geben kann
      trustedProxies: edge,
      // Zugriffs-Log für Airlock selbst (Systemseite: welche Absender sieht Caddy?)
      accessLogHosts: [primaryHost(UI_HOST_LABEL), ...aliasHosts(UI_HOST_LABEL)],
      // M8: Header-Check über Caddy, ohne den IP-Filter zu öffnen
      probeSocket: config.CADDY_PROBE_SOCKET || null,
      // M8: CSP-Meldungen vom Host des Projekts an Airlock (Body-Limit, Ratenlimit in Caddy)
      cspReportUpstream: cspForward ? config.AIRLOCK_UPSTREAM : null,
      // Etappe 3: Besucher-Log als Datei im Volume caddy_access (aus, wenn Airlock es nicht lesen soll)
      visitsLogDir: config.ACCESS_LOG_DIR ? config.CADDY_ACCESS_LOG_DIR || null : null,
    })
  let build = buildWith(!cspForwardUnsupported)
  // Laut werden, wenn :443 aus der Konfiguration fällt – nur «off» darf das
  const withTls = Boolean((build as { apps?: { tls?: unknown } }).apps?.tls)
  if (lastBuildHadTls && !withTls) {
    log.warn('Caddy-Konfiguration ohne TLS (:443 und Wildcard-Policy fallen weg)', { basen: tlsPhases() })
  }
  lastBuildHadTls = withTls
  // Wechselt die CA für *.<basis> (z. B. altes Staging → Produktion), behält
  // Caddy sonst das gecachte Zertifikat der alten CA – auch nach einem
  // Neustart, weil autosave.json die alte CA wieder lädt. Zwischenschritt
  // ohne verwaltete Zertifikate leert den Cache; danach lädt Caddy aus dem
  // Speicher der neuen CA oder bestellt dort. M9: je Basis geprüft.
  const current = await caddy.getConfig().catch(() => null)
  const evict = tlsList.map((t) => t.baseDomain).filter((base) => needsCacheEvict(current, build, base))
  if (evict.length) {
    await caddy.loadConfig(withoutCertificates(build))
    log.info('Caddys Zertifikats-Cache für die Wildcard geleert (CA gewechselt)', { basen: evict })
    force = true
  }
  // force: das Token in der Datei hat sich geändert – Caddy liest es nur beim Laden
  const load = (cfg: Record<string, unknown>) => (force ? caddy.loadConfig(cfg).then(() => true) : caddy.loadConfigIfChanged(cfg))
  let changed: boolean
  try {
    changed = await load(build)
  } catch (err) {
    // Altes Caddy-Image ohne Ratenlimit-Modul (caddy/Dockerfile, M8): lieber
    // ohne CSP-Meldungen laden als gar nicht. Abhilfe: Caddy neu bauen.
    if (cspForwardUnsupported || !/rate_limit/.test(String(err))) throw err
    cspForwardUnsupported = true
    log.warn('Caddy kennt das Modul rate_limit nicht: CSP-Meldungen bleiben aus, bis Caddy neu gebaut ist (docker compose up -d --build caddy)', { err: String(err).slice(0, 300) })
    build = buildWith(false)
    changed = await load(build)
  }
  await caddy.assertAdminOnUnixSocket()
  if (changed) log.info('Caddy abgeglichen', { routen: specs.length, ipFilter: config.CADDY_IP_FILTER })
}
