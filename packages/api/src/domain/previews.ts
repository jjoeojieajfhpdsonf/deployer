import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import {
  PREVIEW_IDLE_DAYS, PREVIEW_MAX, UI_HOST_LABEL, countOpenFindings,
  type PreviewDto, type PreviewScanDto, type PreviewsDto,
} from '@airlock/shared'
import { db, schema, tryLockProject } from '../db/index.js'
import { config, primaryHost, urlForHost } from '../config.js'
import { serverJob } from '../lib/scope.js'
import { badRequest, conflict } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { GithubError } from '../lib/github.js'
import { internalServiceLabel } from '../lib/internal-routes.js'
import {
  previewLabel, previewTargets, assertPreviewTargets, previewAbility, planPreviews, previewStateOf,
  previewComment, previewCheck, fingerprint, serviceLabelClash, removeWith, PreviewBusyError, type RemoveReason, type PreviewReport,
} from '../lib/previews.js'
import { audit } from './audit.js'
import { connectedRepo, previewToken, baseBranch, github } from './github.js'
import { primaryHostIn } from './environments.js'
import { routeDtosFor, setRoutes } from './routes.js'
import { deleteProject, findProjectForServerJob } from './projects.js'
import { activeDeployment } from './deployments.js'
import { parseComposeSpec } from './topology-build.js'
import { startDeploy } from '../deploy/pipeline.js'

/**
 * Etappe 6 «Vorschau-Deploys»: die echten Wege zu lib/previews.ts.
 *
 * Eine Vorschau ist ein eigenes Projekt (projects.preview_of → Projekt) mit
 * Slug = Label <branch-slug>--<projekt>. Damit gilt alles, was Airlock für
 * Projekte schon kann, ohne neuen Weg: Klonen auf den Commit, Bauen,
 * Compose mit eigenem Projektnamen air_<label> (Volumes, Netz und Container
 * getrennt vom Projekt – eine Datenbank aus der compose.yaml startet leer),
 * Healthcheck, Caddy-Route, Security-Scan nach dem Deploy.
 *
 * Nur intern: Ziele sind die internen Wege des Projekts (LAN/Tailnet), nie
 * «öffentlich» – durchgesetzt in setRoutes, planPublic/applyPublic,
 * requestPublic und im Caddy-Abgleich (domain/preview-guard.ts). Die
 * Projekt-Routen der API erreichen eine Vorschau nicht (findProject).
 *
 * DNS und Zertifikat: nichts je Vorschau. Der Name liegt eine Ebene unter
 * der internen Basis; *.int.<basis> (DNS-Eintrag und Wildcard-Zertifikat)
 * deckt ihn ab. Beim Aufräumen gibt es deshalb auch keine Einträge zu löschen.
 */

type Project = typeof schema.projects.$inferSelect
type PreviewRow = typeof schema.previews.$inferSelect
type GhCtx = { token: string; checks: boolean; owner: string; repo: string }

const JOB = serverJob('vorschauen')
export const PREVIEW_ACTOR = 'system:vorschau'
const BUSY = ['pending', 'pulling', 'starting', 'healthchecking'] as const
const CHECK_NAME = 'Airlock-Vorschau'

const airlockUrl = () => urlForHost(primaryHost(UI_HOST_LABEL))
const pageUrl = (parentId: string) => `${airlockUrl()}/projekte/${parentId}?tab=deployments`

/* --- Lesen ----------------------------------------------------------------------- */

export async function previewRows(parentId: string): Promise<PreviewRow[]> {
  return db.select().from(schema.previews).where(eq(schema.previews.parentId, parentId)).orderBy(desc(schema.previews.lastPushAt))
}

/** Labels der Vorschauen eines Projekts (Etappe 4 «+ Dienst» prüft dagegen) */
export async function previewLabelsOf(parentId: string): Promise<string[]> {
  return (await db.select({ label: schema.previews.label }).from(schema.previews).where(eq(schema.previews.parentId, parentId))).map((r) => r.label)
}

/** Dienste der aktiven compose.yaml eines Projekts */
async function composeServicesOf(p: Project): Promise<string[]> {
  const file = (await activeDeployment(p.id))?.artifact?.composeFile
  if (!file) return []
  const spec = await readFile(file, 'utf8').then(parseComposeSpec).catch(() => null)
  return spec ? spec.services.map(([n]) => n) : []
}

/**
 * Zentrale Prüfung, ob ein internes Label belegt ist: Kurzname eines Projekts
 * (auch jeder Vorschau), interne Adresse einer Route der Umgebung, eine
 * Dienst-Adresse <dienst>--<projekt> aus Etappe 4 (x-airlock-internal aller
 * aktiven Fassungen und jeder Dienst des Projekts selbst – er könnte später
 * eine Adresse bekommen) oder eine andere Vorschau.
 */
export async function labelTakenCheck(parent: Project): Promise<(label: string) => boolean> {
  const slugs = new Set((await db.select({ slug: schema.projects.slug }).from(schema.projects)).map((r) => r.slug))
  const hosts = new Set((await db.select({ h: schema.routes.hostname }).from(schema.routes)).map((r) => r.h))
  const labels = new Set((await db.select({ l: schema.previews.label }).from(schema.previews)).map((r) => r.l))
  const services = new Set<string>()
  const active = await db.select({ slug: schema.projects.slug, artifact: schema.deployments.artifact })
    .from(schema.deployments).innerJoin(schema.projects, eq(schema.projects.id, schema.deployments.projectId))
    .where(eq(schema.deployments.isActive, true))
  for (const a of active) for (const ir of a.artifact?.internalRoutes ?? []) services.add(internalServiceLabel(ir.service, a.slug))
  for (const s of await composeServicesOf(parent)) services.add(internalServiceLabel(s, parent.slug))
  return (label) => slugs.has(label) || labels.has(label) || services.has(label) || hosts.has(primaryHostIn(parent.environmentId, label))
}

async function abilityOf(p: Project): Promise<{ available: boolean; reason: string | null; repo: string | null }> {
  const cfg = (p.sourceConfig ?? {}) as { repoUrl?: string }
  const r = cfg.repoUrl ? await connectedRepo(p).catch(() => null) : null
  const repo = r ? `${r.owner}/${r.repo}` : null
  return { ...previewAbility({ sourceType: p.sourceType, repoUrl: cfg.repoUrl ?? null, githubRepo: repo, isPreview: Boolean(p.previewOf) }), repo }
}

/** Scan genau dieser Fassung (nicht der vom vorherigen Push) */
async function scanFor(projectId: string, deploymentId: string | null): Promise<PreviewScanDto | null> {
  if (!deploymentId) return null
  const run = (await db.select().from(schema.scanRuns)
    .where(and(eq(schema.scanRuns.projectId, projectId), eq(schema.scanRuns.deploymentId, deploymentId)))
    .orderBy(desc(schema.scanRuns.startedAt)).limit(1))[0]
  if (!run) return null
  const open = run.status === 'done'
    ? countOpenFindings(await db.select({ severity: schema.findings.severity, status: schema.findings.status }).from(schema.findings).where(eq(schema.findings.scanRunId, run.id)))
    : { critical: 0, high: 0, medium: 0, low: 0 }
  return { status: run.status, grade: run.grade ?? null, score: run.score ?? null, open }
}

async function previewDto(row: PreviewRow): Promise<PreviewDto> {
  const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, row.projectId)).limit(1))[0]
  const last = (await db.select().from(schema.deployments).where(eq(schema.deployments.projectId, row.projectId)).orderBy(desc(schema.deployments.startedAt)).limit(1))[0] ?? null
  const active = await activeDeployment(row.projectId)
  const routes = p ? await routeDtosFor(p.id, p.slug) : []
  const state = previewStateOf({ desiredState: p?.desiredState ?? 'stopped', last, hasActive: Boolean(active) })
  const scan = await scanFor(row.projectId, active?.id ?? null)
  return {
    id: row.projectId,
    branch: row.branch,
    label: row.label,
    url: routes[0]?.urls[0] ?? null,
    host: routes[0]?.hostname ?? null,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    headSha: row.headSha,
    lastPushAt: row.lastPushAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: new Date(row.lastPushAt.getTime() + PREVIEW_IDLE_DAYS * 86_400_000).toISOString(),
    state,
    deploymentId: last?.id ?? null,
    failure: state === 'failed' ? (last?.failure?.title ?? last?.errorMessage?.split('\n')[0] ?? null) : null,
    failureSecrets: state === 'failed' && last?.failure?.kind === 'preview_secret',
    // Ohne Scan nach dem Deploy (SCAN_AFTER_DEPLOY=off) gibt es keinen; das sagt der Check dann auch
    scan: scan ?? (config.SCAN_AFTER_DEPLOY ? null : { status: 'cancelled', grade: null, score: null, open: { critical: 0, high: 0, medium: 0, low: 0 } }),
  }
}

export async function previewsDto(parent: Project): Promise<PreviewsDto> {
  const ab = await abilityOf(parent)
  const rows = await previewRows(parent.id)
  const pattern = primaryHostIn(parent.environmentId, `branch--${parent.slug}`).replace(/^branch--/, '<branch>--')
  return {
    enabled: parent.previewsEnabled,
    available: ab.available,
    reason: ab.reason,
    repo: ab.repo,
    checkedAt: parent.previewsCheckedAt?.toISOString() ?? null,
    pattern,
    max: PREVIEW_MAX,
    idleDays: PREVIEW_IDLE_DAYS,
    previews: await Promise.all(rows.map(previewDto)),
  }
}

/* --- Schalter -------------------------------------------------------------------- */

export async function setPreviewsEnabled(parent: Project, enabled: boolean, actor: string): Promise<PreviewsDto> {
  if (parent.previewOf) throw badRequest('Eine Vorschau hat selbst keine Vorschauen.')
  if (enabled) {
    const ab = await abilityOf(parent)
    if (!ab.available) throw badRequest(ab.reason ?? 'Vorschauen gehen bei diesem Projekt nicht')
  }
  // Beim Einschalten neu beginnen: die erste Abfrage nimmt Branches mit offenem PR
  await db.update(schema.projects).set({ previewsEnabled: enabled, previewSeen: null, updatedAt: new Date() }).where(eq(schema.projects.id, parent.id))
  await audit({ actor, action: 'project.previews_setting', targetType: 'project', targetId: parent.id, params: { enabled }, result: 'ok' })
  if (!enabled) await removeAllPreviews(parent, 'disabled', actor)
  else void checkParent(parent.id).catch((err) => log.warn('Vorschauen: erste Abfrage gescheitert', { project: parent.slug, err: String(err) }))
  return previewsDto(await findProjectForServerJob(parent.id))
}

/* --- Anlegen und neu deployen ------------------------------------------------------- */

/** Einstellungen des Projekts für die Vorschau (Quelle auf den Branch, Container wie das Projekt) */
const settingsFrom = (parent: Project, branch: string) => ({
  sourceType: parent.sourceType,
  sourceConfig: { ...((parent.sourceConfig ?? {}) as Record<string, unknown>), ref: branch },
  port: parent.port,
  healthcheckPath: parent.healthcheckPath,
  cpuLimit: parent.cpuLimit,
  memoryLimitMb: parent.memoryLimitMb,
})

async function internalTargetsOf(parentId: string): Promise<('lan' | 'tailnet')[]> {
  const rows = await db.select({ t: schema.routes.target }).from(schema.routes).where(eq(schema.routes.projectId, parentId))
  return previewTargets(rows.map((r) => r.t))
}

async function deploy(previewId: string, branch: string, sha: string): Promise<void> {
  await startDeploy(JOB, previewId, PREVIEW_ACTOR, sha, { reason: { kind: 'code', detail: `Vorschau: Push auf ${branch}` } })
}

export async function createPreview(parent: Project, c: { branch: string; sha: string; pr: { number: number; url: string } | null }): Promise<string> {
  const label = previewLabel(c.branch, parent.slug, await labelTakenCheck(parent))
  const targets = await internalTargetsOf(parent.id)
  assertPreviewTargets(targets)
  const created = await db.transaction(async (tx) => {
    const p = (await tx.insert(schema.projects).values({
      ...settingsFrom(parent, c.branch),
      name: `${parent.name} · ${c.branch}`.slice(0, 200),
      slug: label,
      keep: true,
      status: 'created',
      desiredState: 'stopped',
      environmentId: parent.environmentId,
      previewOf: parent.id,
      showOnStatus: false,
    }).returning())[0]!
    await tx.insert(schema.previews).values({
      projectId: p.id, parentId: parent.id, branch: c.branch, label,
      prNumber: c.pr?.number ?? null, prUrl: c.pr?.url ?? null, headSha: c.sha, lastPushAt: new Date(),
    })
    return p
  })
  await setRoutes(created.id, label, targets)
  await audit({ actor: PREVIEW_ACTOR, action: 'preview.create', targetType: 'project', targetId: parent.id, params: { branch: c.branch, label, pr: c.pr?.number ?? null, commit: c.sha, targets }, result: 'ok' })
  log.info('Vorschau angelegt', { project: parent.slug, branch: c.branch, label })
  try {
    await deploy(created.id, c.branch, c.sha)
  } catch (err) {
    // Nächste Abfrage versucht es erneut (Kopf ≠ gespeicherter Stand)
    await db.update(schema.previews).set({ headSha: null }).where(eq(schema.previews.projectId, created.id))
    throw err
  }
  return created.id
}

export async function redeployPreview(parent: Project, u: { id: string; branch: string; sha: string; pr: { number: number; url: string } | null }): Promise<void> {
  // Port, Healthcheck, Grenzen und Quelle wie das Projekt jetzt (könnten sich geändert haben)
  await db.update(schema.projects).set({ ...settingsFrom(parent, u.branch), updatedAt: new Date() }).where(eq(schema.projects.id, u.id))
  await deploy(u.id, u.branch, u.sha)
  await db.update(schema.previews).set({ headSha: u.sha, lastPushAt: new Date(), prNumber: u.pr?.number ?? null, prUrl: u.pr?.url ?? null }).where(eq(schema.previews.projectId, u.id))
}

/* --- Entfernen ----------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Vorschau ganz entfernen: Container, gebaute Images, Netz, Volumes der
 * Vorschau (nur air_<label>, nie die des Projekts), Seitenordner, Routen
 * (Caddy wird abgeglichen), eigene Variablen-Overrides, Deployments und
 * Scans – über deleteProject mit purgeVolumes. Vorher der Kommentar am PR.
 * Läuft gerade ein Deploy: wait=false → «später noch einmal» (Abfrage),
 * wait=true → bis zu einer Minute warten, dann trotzdem.
 */
export async function removePreview(previewId: string, reason: RemoveReason, actor: string, o: { ctx?: GhCtx | null; wait?: boolean } = {}): Promise<void> {
  const row = (await db.select().from(schema.previews).where(eq(schema.previews.projectId, previewId)).limit(1))[0]
  if (!row) return
  try {
    await removeWith({
      lock: () => tryLockProject(previewId),
      sleep,
      report: () => reportRemoved(row, reason, o.ctx ?? null),
      deleteProject: (purge) => deleteProject(JOB, previewId, actor, purge),
      audit: () => audit({ actor, action: 'preview.remove', targetType: 'project', targetId: row.parentId, params: { branch: row.branch, label: row.label, reason }, result: 'ok' }),
      warn: (msg) => log.warn(msg, { label: row.label }),
    }, { wait: Boolean(o.wait) })
  } catch (err) {
    if (err instanceof PreviewBusyError) throw conflict(err.message)
    throw err
  }
  log.info('Vorschau entfernt', { label: row.label, reason })
}

/** Alle Vorschauen eines Projekts (Schalter aus, Projekt gelöscht oder verschoben) */
export async function removeAllPreviews(parent: { id: string }, reason: RemoveReason, actor: string): Promise<void> {
  for (const row of await previewRows(parent.id)) {
    await removePreview(row.projectId, reason, actor, { wait: true }).catch((err) => log.warn('Vorschau nicht entfernt', { label: row.label, err: String(err) }))
  }
}

/** Von Hand löschen (Oberfläche, mit Bestätigung) */
export async function removePreviewByHand(parent: Project, previewId: string, actor: string): Promise<void> {
  const row = (await db.select().from(schema.previews).where(and(eq(schema.previews.projectId, previewId), eq(schema.previews.parentId, parent.id))).limit(1))[0]
  if (!row) throw badRequest('Diese Vorschau gibt es nicht (mehr)')
  await removePreview(previewId, 'manual', actor)
}

/* --- Kommentar und Check am Pull Request --------------------------------------------- */

async function ghCtx(parent: Project): Promise<GhCtx | null> {
  const r = await connectedRepo(parent).catch(() => null)
  if (!r) return null
  const t = await previewToken(r.repo)
  return { ...t, owner: r.owner, repo: r.repo }
}

const reportOf = (row: PreviewRow, dto: PreviewDto): PreviewReport => ({
  label: row.label, branch: row.branch, sha: row.headSha, url: dto.url, state: dto.state, failure: dto.failure, scan: dto.scan,
  airlockUrl: pageUrl(row.parentId),
})

async function reportRemoved(row: PreviewRow, reason: RemoveReason, given: GhCtx | null): Promise<void> {
  if (!row.prNumber || (!row.commentId && !row.checkRunId)) return
  const ctx = given ?? await ghCtx(await findProjectForServerJob(row.parentId))
  if (!ctx) return
  const gh = github()
  const body = previewComment({ label: row.label, branch: row.branch, sha: row.headSha, url: null, state: 'stopped', failure: null, scan: null, airlockUrl: pageUrl(row.parentId), removed: reason })
  if (row.commentId) await gh.updateComment(ctx.token, ctx.owner, ctx.repo, row.commentId, body)
  if (ctx.checks && row.checkRunId) {
    await gh.updateCheckRun(ctx.token, ctx.owner, ctx.repo, row.checkRunId, { name: CHECK_NAME, status: 'completed', conclusion: 'neutral', title: 'Vorschau entfernt', summary: body.split('\n').slice(2).join('\n') })
  }
}

/**
 * Kommentar (mit Link) und – wenn die App «Checks: write» hat – Check am
 * Commit. Nur bei Änderung an GitHub: Fingerabdruck des Texts gespeichert.
 * Bei einem Push wird derselbe Kommentar ersetzt; der Check gehört zum
 * Commit, also gibt es für einen neuen Kopf einen neuen.
 */
export async function syncPreviewReports(parent: Project, given: GhCtx | null = null): Promise<void> {
  const rows = (await previewRows(parent.id)).filter((r) => r.prNumber !== null)
  if (!rows.length) return
  let ctx: GhCtx | null | undefined = given ?? undefined
  const need = async () => (ctx === undefined ? (ctx = await ghCtx(parent)) : ctx)
  const gh = github()
  for (const row of rows) {
    const report = reportOf(row, await previewDto(row))
    const body = previewComment(report)
    const hash = fingerprint(body)
    if (!row.commentId || hash !== row.commentHash) {
      const c = await need()
      if (!c) return
      let commentId = row.commentId
      try {
        if (commentId) await gh.updateComment(c.token, c.owner, c.repo, commentId, body)
      } catch (err) {
        // Kommentar von Hand gelöscht: neu anlegen
        if (!(err instanceof GithubError && err.status === 404)) throw err
        commentId = null
      }
      if (!commentId) commentId = (await gh.createComment(c.token, c.owner, c.repo, row.prNumber!, body)).id
      await db.update(schema.previews).set({ commentId, commentHash: hash }).where(eq(schema.previews.projectId, row.projectId))
    }
    if (!row.headSha) continue
    const check = previewCheck(report)
    const checkHash = fingerprint(JSON.stringify(check))
    if (row.checkSha === row.headSha && row.checkHash === checkHash) continue
    const c = await need()
    if (!c) return
    let checkRunId: number | null = null
    if (c.checks) {
      const input = { name: CHECK_NAME, ...check, detailsUrl: pageUrl(row.parentId) }
      if (row.checkRunId && row.checkSha === row.headSha) {
        await gh.updateCheckRun(c.token, c.owner, c.repo, row.checkRunId, input)
        checkRunId = row.checkRunId
      } else {
        checkRunId = (await gh.createCheckRun(c.token, c.owner, c.repo, { ...input, headSha: row.headSha })).id
      }
    }
    // Ohne Recht «Checks: write» trotzdem merken – sonst holte jede Runde ein neues Token
    await db.update(schema.previews).set({ checkRunId, checkSha: row.headSha, checkHash }).where(eq(schema.previews.projectId, row.projectId))
  }
}

/* --- Abfrage (statt Webhook) ------------------------------------------------------------ */

async function busyPreviews(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = await db.select({ p: schema.deployments.projectId }).from(schema.deployments)
    .where(and(inArray(schema.deployments.projectId, ids), inArray(schema.deployments.status, [...BUSY])))
  return new Set(rows.map((r) => r.p))
}

/**
 * Ein Projekt: Branches und offene Pull Requests holen, planen (rein),
 * ausführen, Kommentare nachziehen. Ohne GitHub-Verbindung zählt nur noch
 * das Alter (7 Tage ohne Push).
 */
export async function checkParent(parentId: string): Promise<void> {
  const parent = await findProjectForServerJob(parentId)
  if (parent.previewOf) return
  const rows = await previewRows(parent.id)
  if (!parent.previewsEnabled) {
    for (const row of rows) await removePreview(row.projectId, 'disabled', PREVIEW_ACTOR).catch((err) => log.warn('Vorschau nicht entfernt', { label: row.label, err: String(err) }))
    return
  }
  const now = new Date()
  const ctx = await ghCtx(parent)
  if (!ctx) {
    for (const row of rows) {
      if (now.getTime() - row.lastPushAt.getTime() > PREVIEW_IDLE_DAYS * 86_400_000) {
        await removePreview(row.projectId, 'idle', PREVIEW_ACTOR).catch((err) => log.warn('Vorschau nicht entfernt', { label: row.label, err: String(err) }))
      }
    }
    return
  }
  const gh = github()
  const r = (await connectedRepo(parent))!
  const base = await baseBranch(ctx.token, r)
  const [branches, pulls] = await Promise.all([gh.branches(ctx.token, ctx.owner, ctx.repo), gh.openPulls(ctx.token, ctx.owner, ctx.repo)])
  const busy = await busyPreviews(rows.map((x) => x.projectId))
  const plan = planPreviews({
    now, defaultBranch: base, branches, pulls, seen: parent.previewSeen ?? null,
    previews: rows.map((x) => ({ id: x.projectId, branch: x.branch, headSha: x.headSha, lastPushAt: x.lastPushAt, prNumber: x.prNumber, busy: busy.has(x.projectId) })),
  })
  const warn = (what: string) => (err: unknown) => log.warn(`Vorschau: ${what}`, { project: parent.slug, err: String(err) })
  for (const rm of plan.remove) await removePreview(rm.id, rm.reason, PREVIEW_ACTOR, { ctx }).catch(warn(`nicht entfernt (${rm.branch})`))
  for (const l of plan.link) {
    // Anderer PR: neuer Kommentar dort
    await db.update(schema.previews).set({ prNumber: l.pr?.number ?? null, prUrl: l.pr?.url ?? null, commentId: null, commentHash: null }).where(eq(schema.previews.projectId, l.id))
  }
  for (const u of plan.update) await redeployPreview(parent, u).catch(warn(`nicht neu deployt (${u.branch})`))
  for (const c of plan.create) await createPreview(parent, c).catch(warn(`nicht angelegt (${c.branch})`))
  await db.update(schema.projects).set({ previewSeen: plan.seen, previewsCheckedAt: now }).where(eq(schema.projects.id, parent.id))
  await syncPreviewReports(await findProjectForServerJob(parent.id), ctx).catch(warn('Kommentar/Check nicht aktualisiert'))
}

/** Projekte mit eingeschalteten Vorschauen – und solche, die noch Vorschauen haben */
export async function parentsToCheck(): Promise<string[]> {
  const on = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.previewsEnabled, true), isNull(schema.projects.previewOf)))
  const withRows = await db.selectDistinct({ id: schema.previews.parentId }).from(schema.previews)
  return [...new Set([...on.map((r) => r.id), ...withRows.map((r) => r.id)])]
}

/** Projekte, deren Vorschauen einen Pull Request haben (Kommentare nachziehen) */
export async function parentsWithPullRequests(): Promise<string[]> {
  const rows = await db.selectDistinct({ id: schema.previews.parentId }).from(schema.previews)
  return rows.map((r) => r.id)
}

/** Etappe 4 «+ Dienst»: Name, dessen Dienst-Adresse eine Vorschau überdecken würde */
export async function serviceNameClash(parent: { id: string; slug: string }, service: string): Promise<string | null> {
  return serviceLabelClash(service, parent.slug, await previewLabelsOf(parent.id))
}
