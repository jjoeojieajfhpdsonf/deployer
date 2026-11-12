import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import type { TopologyDto } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { cf, config, net } from '../config.js'
import * as docker from '../drivers/docker.js'
import { readStats } from '../jobs/monitor.js'
import { certProblemNow, currentCert } from '../jobs/cert.js'
import { activeDeployment, effectiveKind } from './deployments.js'
import { externalInfo, externalSnapshot } from './external.js'
import { defaultEnvironmentId } from './environments.js'
import { publicEnabled } from './public.js'
import { currentInternalServiceRoutes, routeDtosFor } from './routes.js'
import { urlForHostIn } from './environments.js'
import { changesForTopology, serviceAbility } from './services-real.js'
import { buildTopology, parseComposeSpec, type ComposeSpec, type ContainerInfo } from './topology-build.js'

type Project = typeof schema.projects.$inferSelect

/** Höchstens so lange auf die Messwerte eines Containers warten (Docker braucht für CPU zwei Proben) */
const STATS_TIMEOUT_MS = 3_000

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())])

/**
 * GET /projects/:id/topology: Dienste, Routen, Netze, Volumes und Zustände
 * eines Projekts – aus Docker (über den Socket-Proxy: Container auflisten,
 * Volumes auflisten, Stats) und der Routen-Datenbank. Die Rechnung selbst
 * steht in topology-build.ts.
 */
export async function projectTopology(project: Project): Promise<TopologyDto> {
  const active = await activeDeployment(project.id)
  const kind = effectiveKind(project.sourceType, active?.artifact)
  const webService = (project.sourceConfig as { webService?: string } | null)?.webService ?? (kind === 'compose' ? 'web' : null)

  const [routes, headers, compose, containers, composeVolumes, tlsProblem] = await Promise.all([
    routeDtosFor(project.id, project.slug),
    headerCount(project),
    kind === 'compose' && active?.artifact?.composeFile ? readCompose(active.artifact.composeFile) : Promise.resolve(null),
    kind === 'static' || kind === 'external' ? Promise.resolve([] as ContainerInfo[]) : docker.listProjectContainers(project.slug).catch(() => [] as ContainerInfo[]),
    kind === 'compose' ? docker.listComposeVolumes(docker.projectNetworkName(project.slug)).catch(() => []) : Promise.resolve([]),
    certProblem(project.environmentId),
  ])

  // Messwerte nur für laufende Container, alle gleichzeitig
  const running = containers.filter((c) => c.state === 'running')
  const stats = await Promise.all(running.map((c) => within(readStats(c.id), STATS_TIMEOUT_MS, null)))
  const usage = Object.fromEntries(running.map((c, n) => [c.id, stats[n] ?? null]))

  const tailnetIp = net.tailscaleIp()
  const lanIp = net.lanIp()
  // Etappe 4: interne Adressen von Diensten (wie Caddy sie bekommt) und Dienst-Änderungen
  const [internal, ability, changes] = await Promise.all([
    kind === 'compose' ? currentInternalServiceRoutes().catch(() => []) : Promise.resolve([]),
    serviceAbility(project).catch(() => ({ way: null, reason: null })),
    kind === 'compose' ? changesForTopology(project).catch(() => []) : Promise.resolve([]),
  ])
  const topology = buildTopology({
    kind,
    slug: project.slug,
    port: project.port,
    webService,
    version: active?.version ?? null,
    hasActive: Boolean(active),
    activeContainerId: active?.containerId ?? null,
    desiredRunning: project.desiredState === 'running',
    compose,
    containers,
    composeVolumes,
    routes,
    headers,
    ways: {
      public: publicEnabled(project.environmentId),
      tailnet: tailnetIp ? { cidr: config.tailnetCidr, ip: tailnetIp } : null,
      lan: lanIp ? { cidr: net.lanCidr(), ip: lanIp } : null,
    },
    tlsProblem,
    usage,
    limits: { cpu: Number(project.cpuLimit), memoryMb: project.memoryLimitMb },
    internalHosts: internal.filter((r) => r.projectId === project.id).map((r) => ({
      service: r.service, hostname: r.hostname, url: urlForHostIn(project.environmentId, r.hostname), ways: r.targets,
    })),
    external: kind === 'external' ? externalTopology(project) : null,
  })
  // Bestehender Dienst: keine Dienste zum Hinzufügen oder Entfernen – Airlock verwaltet ihn nicht
  if (kind === 'external') return { ...topology, edit: { way: null, reason: 'Wird nicht von Airlock verwaltet', changes: [], webService: null } }
  return { ...topology, edit: { way: ability.way, reason: ability.reason, changes, webService: kind === 'compose' ? webService : null } }
}

function externalTopology(project: Project): NonNullable<Parameters<typeof buildTopology>[0]['external']> {
  const info = externalInfo(project)!
  const snap = externalSnapshot(project.id)
  return {
    label: info.label, mode: info.mode,
    name: info.container ?? info.url?.replace(/^https?:\/\//, '') ?? project.slug,
    image: info.image, port: info.port ?? (info.url ? Number(info.url.split(':').at(-1)) || null : null),
    found: info.found, running: info.mode === 'container' ? snap?.running ?? null : null,
  }
}

async function readCompose(file: string): Promise<ComposeSpec | null> {
  return readFile(file, 'utf8').then(parseComposeSpec).catch(() => null)
}

/**
 * Header, die Caddy an den Hosts des Projekts setzt: eigene Regeln (ohne
 * «off») und die Vorlagen der Umgebung ohne eigene Regel – wie
 * headerRulesByProject() in routes.ts.
 */
async function headerCount(project: Project): Promise<number> {
  const [own, templates] = await Promise.all([
    db.select({ header: schema.headerRules.header, mode: schema.headerRules.mode }).from(schema.headerRules).where(eq(schema.headerRules.projectId, project.id)),
    db.select({ header: schema.headerRuleTemplates.header }).from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, project.environmentId)),
  ])
  return own.filter((r) => r.mode !== 'off').length + templates.filter((t) => !own.some((r) => r.header === t.header)).length
}

/** Zertifikat der Standard-Umgebung (zwischengespeichert, höchstens 5 Minuten alt); andere Umgebungen: unbekannt */
async function certProblem(envId: string): Promise<string | null> {
  if (envId !== defaultEnvironmentId() || !cf.tls()) return null
  const c = await currentCert().catch(() => null)
  return c ? certProblemNow(c) : null
}
