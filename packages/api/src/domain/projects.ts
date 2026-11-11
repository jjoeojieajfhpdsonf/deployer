import { eq, or, asc, and, desc } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { notFound, conflict, badRequest } from '../lib/errors.js'
import { slugify, sourceTypesSupported, RESERVED_SLUGS, projectState, countOpenFindings, type CreateProjectInput, type ProjectDto, type SourceType, type Source } from '@airlock/shared'
import { containerSnapshot } from '../jobs/monitor.js'
import { isOwnImage } from '../lib/names.js'
import * as docker from '../drivers/docker.js'
import { dropArtifactDir } from '../deploy/workdir.js'
import { activeDeployment, toDeploymentDto, effectiveKind } from './deployments.js'
import { expiresAt } from '../jobs/expiry-rule.js'
import { chatExpiryDays } from './expiry-settings.js'
import { routeDtosFor, setRoutes, reconcileCaddy } from './routes.js'
import { removePublic } from './public.js'
import { replaceEnv } from './env.js'
import { audit } from './audit.js'
import { log } from '../lib/log.js'

type Row = typeof schema.projects.$inferSelect

/* --- Lesen ---------------------------------------------------------------- */

export async function toDto(r: Row): Promise<ProjectDto> {
  const active = await activeDeployment(r.id)
  const routes = await routeDtosFor(r.id, r.slug)
  const activeDto = active ? toDeploymentDto(active) : null
  const last = await lastDeploymentDto(r.id)
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    sourceType: r.sourceType as SourceType,
    source: (r.sourceConfig as Source | null) ?? null,
    port: r.port,
    healthcheckPath: r.healthcheckPath,
    status: r.status,
    desiredState: r.desiredState,
    keep: r.keep,
    cpuLimit: Number(r.cpuLimit),
    memoryLimitMb: r.memoryLimitMb,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    routes,
    activeDeployment: activeDto,
    runsAsRoot: null,
    // M3
    runtimeKind: effectiveKind(r.sourceType, active?.artifact),
    filesKind: active?.artifact?.filesKind ?? null,
    lastChangeAt: r.lastChangeAt.toISOString(),
    expiresAt: expiresAt(r, chatExpiryDays())?.toISOString() ?? null,
    expiryDays: r.sourceType === 'files' ? chatExpiryDays() : null,
    security: await securitySummary(r.id),
    lastDeployment: last,
    // Stand vom letzten Blick auf Docker (Abgleich, Deploy); kein Docker-Aufruf je DTO
    legacyContainers: docker.legacySnapshot().slugs.has(r.slug),
    // Einzige Quelle für den Zustand (UI-Qualität 1); Container aus der Monitor-Runde
    state: projectState({ status: r.status, desiredState: r.desiredState, activeDeployment: activeDto, lastDeployment: last, routes, container: containerSnapshot(r.id) }),
  }
}

async function lastDeploymentDto(projectId: string): Promise<ProjectDto['lastDeployment']> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
    .orderBy(desc(schema.deployments.startedAt))
    .limit(1)
  return rows[0] ? toDeploymentDto(rows[0]) : null
}

/**
 * Letzter Scan in Kurzform (M6). Status vom neuesten Scan, Score und offene
 * Befunde vom letzten abgeschlossenen – ein laufender Scan soll die Note in
 * der Übersicht nicht auf «keine Befunde» springen lassen.
 */
async function securitySummary(projectId: string): Promise<ProjectDto['security']> {
  const latest = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.projectId, projectId)).orderBy(desc(schema.scanRuns.startedAt)).limit(1))[0]
  if (!latest) return null
  const done = latest.status === 'done'
    ? latest
    : (await db.select().from(schema.scanRuns).where(and(eq(schema.scanRuns.projectId, projectId), eq(schema.scanRuns.status, 'done'))).orderBy(desc(schema.scanRuns.startedAt)).limit(1))[0]
  // Dieselbe Zählung wie der Scan-Bericht (countOpenFindings, shared)
  const open = done
    ? countOpenFindings(await db
      .select({ severity: schema.findings.severity, status: schema.findings.status })
      .from(schema.findings)
      .where(eq(schema.findings.scanRunId, done.id)))
    : { critical: 0, high: 0, medium: 0, low: 0 }
  return {
    scanId: latest.id,
    status: latest.status,
    score: done?.score ?? null,
    grade: done?.grade ?? null,
    finishedAt: done?.finishedAt?.toISOString() ?? null,
    open,
  }
}

/**
 * Eine bewusste Handlung an einem Chat-Projekt (Deploy, Rollback, Start)
 * zählt als Aktivität: Frist neu, Warnung zurückgesetzt. Ohne das stoppte
 * der Ablauf-Job ein gerade von Hand gestartetes Projekt in der nächsten
 * Stunde wieder (Review M3).
 */
export async function touchActivity(id: string): Promise<void> {
  await db
    .update(schema.projects)
    .set({ lastChangeAt: new Date(), expiryWarnedAt: null })
    .where(and(eq(schema.projects.id, id), eq(schema.projects.sourceType, 'files')))
}

export async function listProjects(): Promise<ProjectDto[]> {
  const rows = await db.select().from(schema.projects).orderBy(asc(schema.projects.name))
  return Promise.all(rows.map(toDto))
}

/** Nimmt UUID oder Slug – die UI arbeitet mit IDs, Skripte lieber mit Slugs. */
export async function findProject(idOrSlug: string): Promise<Row> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)
  const rows = await db
    .select()
    .from(schema.projects)
    .where(isUuid ? or(eq(schema.projects.id, idOrSlug), eq(schema.projects.slug, idOrSlug)) : eq(schema.projects.slug, idOrSlug))
    .limit(1)
  const row = rows[0]
  if (!row) throw notFound('Projekt')
  return row
}

/* --- Schreiben ------------------------------------------------------------ */

async function freeSlug(wanted: string): Promise<string> {
  const taken = new Set([
    ...RESERVED_SLUGS,
    ...(await db.select({ slug: schema.projects.slug }).from(schema.projects)).map((r) => r.slug),
  ])
  if (!taken.has(wanted)) return wanted
  for (let i = 2; i < 100; i++) {
    const candidate = `${wanted.slice(0, 37)}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  throw conflict(`Kein freier Slug für "${wanted}" gefunden`)
}

export async function createProject(input: CreateProjectInput, actor: string): Promise<Row> {
  const slug = input.slug ? input.slug : await freeSlug(slugify(input.name))
  if (input.slug) {
    const existing = await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)).limit(1)
    if (existing.length) throw conflict(`Der Slug "${slug}" ist schon vergeben`)
  }

  const inserted = await db
    .insert(schema.projects)
    .values({
      name: input.name,
      slug,
      sourceType: input.source.type,
      sourceConfig: input.source,
      port: input.port ?? null,
      healthcheckPath: input.healthcheckPath,
      cpuLimit: String(input.cpuLimit ?? config.DEFAULT_CPU_LIMIT),
      memoryLimitMb: input.memoryLimitMb ?? config.DEFAULT_MEMORY_LIMIT_MB,
      keep: input.keep,
      status: 'created',
      desiredState: 'stopped',
    })
    .returning()

  const project = inserted[0]!
  if (input.env.length) await replaceEnv(project.id, input.env)
  if (input.targets.length) await setRoutes(project.id, project.slug, input.targets, input.subdomain)

  await audit({
    actor,
    action: 'project.create',
    targetType: 'project',
    targetId: project.id,
    params: { name: input.name, slug, source: input.source, targets: input.targets },
    result: 'ok',
  })
  return project
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string
    port: number
    healthcheckPath: string
    cpuLimit: number
    memoryLimitMb: number
    keep: boolean
    source: Source
  }>,
): Promise<Row> {
  const values: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) values.name = patch.name
  if (patch.port !== undefined) values.port = patch.port
  if (patch.healthcheckPath !== undefined) values.healthcheckPath = patch.healthcheckPath
  if (patch.cpuLimit !== undefined) values.cpuLimit = String(patch.cpuLimit)
  if (patch.memoryLimitMb !== undefined) values.memoryLimitMb = patch.memoryLimitMb
  if (patch.keep !== undefined) values.keep = patch.keep
  if (patch.source !== undefined) {
    values.source_config = undefined
    values.sourceConfig = patch.source
    values.sourceType = patch.source.type
  }

  const rows = await db.update(schema.projects).set(values).where(eq(schema.projects.id, id)).returning()
  const row = rows[0]
  if (!row) throw notFound('Projekt')
  return row
}

export async function setStatus(id: string, status: Row['status']): Promise<void> {
  await db.update(schema.projects).set({ status, updatedAt: new Date() }).where(eq(schema.projects.id, id))
}

export async function setDesiredState(id: string, desired: Row['desiredState']): Promise<void> {
  await db.update(schema.projects).set({ desiredState: desired, updatedAt: new Date() }).where(eq(schema.projects.id, id))
}

/**
 * Stoppt und entfernt alles, was zum Projekt gehoert: Container, Netz, Routen,
 * Seitenordner. Abnahmekriterium: hinterlaesst keinen Rest.
 */
export async function deleteProject(id: string, actor: string, purgeVolumes = false): Promise<void> {
  const project = await findProject(id)

  // 0. M5: zuerst die öffentliche Seite schliessen – CNAME, Access-App und
  //    Tunnel-Regel bei Cloudflare. Scheitert das, wird gemeldet, aber
  //    trotzdem gelöscht. Caddy gleicht Schritt 5 ab.
  await removePublic(project, actor, { skipCaddy: true }).catch((err) => log.warn('Öffentliche Route nicht sauber entfernt', { slug: project.slug, err: String(err) }))

  // 1. Container weg
  const managed = await docker.listManagedContainers()
  for (const c of managed) {
    if (c.labels[docker.LABEL_PROJECT] !== project.slug) continue
    await docker.stopContainer(c.id)
    await docker.removeContainer(c.id)
  }

  // 1b. Gebaute Images und aufbewahrte Artefakte (Compose-Dateien) weg
  const deps = await db.select().from(schema.deployments).where(eq(schema.deployments.projectId, project.id))
  for (const d of deps) {
    const imgs = [...(d.artifact?.builtImages ?? []), ...(d.imageRef && isOwnImage(d.imageRef) ? [d.imageRef] : [])]
    for (const img of imgs) await docker.removeImageIfUnused(img).catch(() => {})
    await dropArtifactDir(d.id)
  }

  // 2. Caddy aus dem Netz, dann Netz weg (auch dep_<slug> aus der deployer-Zeit)
  const nets = [docker.projectNetworkName(project.slug), docker.legacyNetworkName(project.slug)]
  for (const net of nets) {
    await docker.disconnectFromNetwork(net, config.CADDY_CONTAINER)
    await docker.disconnectFromNetwork(net, config.AIRLOCK_CONTAINER)
    await docker.removeNetwork(net)
  }

  // 2b. Benannte Volumes (Compose) nur auf ausdrücklichen Wunsch: darin
  // liegen Daten, etwa die einer Datenbank.
  if (purgeVolumes) {
    for (const net of nets) {
      const removed = await docker.removeProjectVolumes(net)
      if (removed.length) log.info('Volumes gelöscht', { slug: project.slug, volumes: removed })
    }
  }

  // 3. Statische Dateien weg (auch bei Chat-Projekten, die als statisch liefen),
  //    und das lokale Repo eines Chat-Projekts.
  await rm(join(config.SITES_DIR, project.slug), { recursive: true, force: true })
  if (project.localRepoPath) await rm(project.localRepoPath, { recursive: true, force: true })

  // 4. Datenbankzeilen (Routen, Env, Deployments haengen per ON DELETE CASCADE)
  await db.delete(schema.projects).where(eq(schema.projects.id, project.id))

  // 5. Caddy neu laden, damit die Route sofort verschwindet
  await reconcileCaddy()

  await audit({
    actor,
    action: 'project.delete',
    targetType: 'project',
    targetId: project.id,
    params: { slug: project.slug, purgeVolumes },
    result: 'ok',
  })
  log.info('Projekt gelöscht', { slug: project.slug })
}

export function assertSourceSupported(type: SourceType): void {
  if (!(sourceTypesSupported as readonly string[]).includes(type)) {
    throw badRequest(`Quelle "${type}" kommt erst in einem späteren Meilenstein`)
  }
}
