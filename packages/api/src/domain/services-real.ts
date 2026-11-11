import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { and, desc, eq } from 'drizzle-orm'
import type { ServiceChangeDto, ServiceEditWay } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import * as docker from '../drivers/docker.js'
import { startDeploy } from '../deploy/pipeline.js'
import { composeUploadPath } from '../deploy/sources/compose.js'
import { serviceBranchName } from '../lib/github.js'
import { detectKind } from '../lib/local-repo.js'
import { badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { serverJob } from '../lib/scope.js'
import { audit } from './audit.js'
import { activeDeployment, effectiveKind } from './deployments.js'
import { addEnvEntries, resolveEnv } from './env.js'
import { listProjectFiles, readProjectFiles, updateProjectFiles } from './files.js'
import { baseBranch, connectedRepo, github, repoToken } from './github.js'
import type { findProject } from './projects.js'
import { parseComposeSpec } from './topology-build.js'
import {
  resolveChanges, serviceEditAbility, toChangeDto, visibleChanges,
  type ChangeRow, type ComposeSource, type ResolveDeps, type ServiceDeps,
} from './services.js'

/**
 * Etappe 4: die echten Wege zu services.ts – lokales Repo (Chat-Projekte),
 * hochgeladene compose.yaml, GitHub-App (Pull Request), Datenbank, Docker.
 */

type Project = Awaited<ReturnType<typeof findProject>>
const JOB = serverJob('dienste')

interface Cfg { repoUrl?: string; ref?: string; composePath?: string; uploadId?: string; webService?: string }
const cfgOf = (p: Project) => (p.sourceConfig ?? {}) as Cfg

export const webServiceOf = (p: Project): string => cfgOf(p).webService ?? 'web'

/** Wie (und ob) das Projekt Dienste ändern kann */
export async function serviceAbility(p: Project): Promise<{ way: ServiceEditWay | null; reason: string | null }> {
  const active = await activeDeployment(p.id)
  const cfg = cfgOf(p)
  const github = Boolean(cfg.repoUrl && (await connectedRepo(p).catch(() => null)))
  return serviceEditAbility({ runtimeKind: effectiveKind(p.sourceType, active?.artifact), sourceType: p.sourceType, repoUrl: cfg.repoUrl ?? null, uploadId: cfg.uploadId ?? null, github })
}

async function composeSource(p: Project, actor: string): Promise<ComposeSource> {
  const ability = await serviceAbility(p)
  if (!ability.way) throw badRequest(ability.reason ?? 'Hier lassen sich keine Dienste ändern')
  const cfg = cfgOf(p)
  const deploy = async (message: string) => (await startDeploy(JOB, p.id, actor, undefined, { reason: { kind: 'code', detail: message } })).id

  if (p.sourceType === 'files') {
    const listing = await listProjectFiles(JOB, p.id)
    const path = detectKind(listing.files.map((f) => f.path), null).composePath
    if (!path) throw badRequest('Im Projekt liegt keine compose.yaml')
    const file = (await readProjectFiles(JOB, p.id, [path])).files[0]
    if (!file || file.encoding !== 'utf8') throw badRequest(`${path} ist nicht lesbar`)
    return {
      way: 'deploy', path, text: file.content, branch: null,
      write: async (o) => {
        await updateProjectFiles(JOB, p.id, { files: [{ path, content: o.text }], message: o.message }, actor)
        return { deploymentId: await deploy(o.message) }
      },
    }
  }

  if (ability.way === 'pull_request') {
    const r = await connectedRepo(p)
    if (!r) throw badRequest('Das Repo ist nicht (mehr) mit der GitHub App verbunden.')
    const token = await repoToken(r.repo)
    const base = await baseBranch(token, r)
    const path = cfg.composePath ?? 'compose.yaml'
    const text = await github().fileText(token, r.owner, r.repo, path, base)
    if (text === null) throw badRequest(`${path} gibt es auf ${base} nicht`)
    return {
      way: 'pull_request', path, text, branch: base,
      write: async (o) => {
        const pr = await github().createServicePullRequest(token, {
          owner: r.owner, repo: r.repo, base, branch: serviceBranchName(o.kind, o.service, o.changeId),
          title: o.title, body: o.body, message: `${o.message}\n\nVorgeschlagen über Airlock (${actor}).`,
          files: [{ path, content: o.text }], delete: [],
        })
        return { pr: { number: pr.number, url: pr.url, branch: pr.branch } }
      },
    }
  }

  // Hochgeladene compose.yaml: neue Datei als neuer Upload, Projekt zeigt darauf
  const uploadId = cfg.uploadId!
  const text = await readFile(composeUploadPath(uploadId), 'utf8').catch(() => {
    throw badRequest('Die hochgeladene compose.yaml liegt nicht mehr auf der Platte')
  })
  return {
    way: 'deploy', path: 'compose.yaml', text, branch: null,
    write: async (o) => {
      const id = randomUUID()
      await writeFile(composeUploadPath(id), o.text, { mode: 0o600 })
      await db.insert(schema.uploads).values({
        id, filename: 'compose.yaml', sizeBytes: Buffer.byteLength(o.text), sha256: createHash('sha256').update(o.text).digest('hex'), kind: 'compose', consumedAt: new Date(),
      })
      await db.update(schema.projects).set({ sourceConfig: { ...cfg, uploadId: id }, updatedAt: new Date() }).where(eq(schema.projects.id, p.id))
      return { deploymentId: await deploy(o.message) }
    },
  }
}

const auditFor = (p: Project, actor: string) => async (action: string, params: Record<string, unknown>, result: 'ok' | 'error', error?: string) =>
  audit({ actor, action, targetType: 'project', targetId: p.id, params, result, error: error ?? null })

const updateRow = async (id: string, patch: Partial<ChangeRow>): Promise<ChangeRow> =>
  (await db.update(schema.serviceChanges).set({ ...patch, updatedAt: new Date() }).where(eq(schema.serviceChanges.id, id)).returning())[0]! as ChangeRow

export function serviceDeps(p: Project, actor: string): ServiceDeps {
  let source: Promise<ComposeSource> | null = null
  return {
    source: () => (source ??= composeSource(p, actor)),
    webService: webServiceOf(p),
    slug: p.slug,
    env: () => resolveEnv(p.id),
    addEnv: (vars) => addEnvEntries(p.id, vars),
    newId: randomUUID,
    insert: async (row) => (await db.insert(schema.serviceChanges).values({ ...row, projectId: p.id }).returning())[0]! as ChangeRow,
    watch: (deploymentId) => watchDeploy(p, deploymentId),
    audit: auditFor(p, actor),
  }
}

/** Dienste der aktiven Fassung (aus ihrer normalisierten compose.yaml) */
async function activeServices(p: Project): Promise<string[] | null> {
  const file = (await activeDeployment(p.id))?.artifact?.composeFile
  if (!file) return null
  const spec = await readFile(file, 'utf8').then(parseComposeSpec).catch(() => null)
  return spec ? spec.services.map(([n]) => n) : null
}

/** Pull Requests höchstens alle 2 Minuten fragen */
const prChecked = new Map<string, number>()

function resolveDeps(p: Project): ResolveDeps {
  return {
    deploymentStatus: async (id) => (await db.select({ status: schema.deployments.status }).from(schema.deployments).where(eq(schema.deployments.id, id)).limit(1))[0]?.status ?? null,
    activeServices: () => activeServices(p),
    pullState: async (row) => {
      if (!row.prNumber) return null
      const last = prChecked.get(row.id) ?? 0
      if (Date.now() - last < 120_000) return null
      prChecked.set(row.id, Date.now())
      const r = await connectedRepo(p).catch(() => null)
      if (!r) return null
      try {
        const pr = await github().pull(await repoToken(r.repo), r.owner, r.repo, row.prNumber)
        return { state: pr.state, merged: pr.merged }
      } catch (err) {
        log.warn('Pull Request nicht lesbar', { change: row.id, err: String(err) })
        return null
      }
    },
    removeVolumes: (names) => docker.removeComposeVolumes(docker.projectNetworkName(p.slug), names),
    update: updateRow,
    audit: auditFor(p, 'system:dienste'),
  }
}

async function rowsOf(projectId: string): Promise<ChangeRow[]> {
  return (await db.select().from(schema.serviceChanges).where(eq(schema.serviceChanges.projectId, projectId)).orderBy(desc(schema.serviceChanges.createdAt)).limit(20)) as ChangeRow[]
}

/** Für den Aufbau: abgleichen, dann die sichtbaren Änderungen */
export async function changesForTopology(p: Project): Promise<ServiceChangeDto[]> {
  const rows = await resolveChanges(await rowsOf(p.id), resolveDeps(p)).catch((err) => {
    log.warn('Dienst-Änderungen nicht abgeglichen', { project: p.id, err: String(err) })
    return null
  })
  return visibleChanges(rows ?? (await rowsOf(p.id))).map(toChangeDto)
}

/** Nach dem Ende des Deploys abgleichen (alle 3 s, höchstens 45 Minuten) – auch ohne offenen Aufbau */
function watchDeploy(p: Project, deploymentId: string): void {
  const until = Date.now() + 45 * 60_000
  const tick = async () => {
    const status = (await db.select({ status: schema.deployments.status }).from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1).catch(() => []))[0]?.status
    if (status && ['active', 'failed', 'superseded', 'rolled_back'].includes(status)) {
      await resolveChanges(await rowsOf(p.id), resolveDeps(p)).catch((err) => log.warn('Dienst-Änderung nicht abgeschlossen', { project: p.id, err: String(err) }))
      return
    }
    if (Date.now() < until) setTimeout(() => void tick(), 3_000).unref()
  }
  setTimeout(() => void tick(), 3_000).unref()
}

/** Gescheiterte bzw. geschlossene Änderung ausblenden */
export async function dismissChange(p: Project, id: string, actor: string): Promise<void> {
  const row = (await db.select().from(schema.serviceChanges).where(and(eq(schema.serviceChanges.id, id), eq(schema.serviceChanges.projectId, p.id))).limit(1))[0]
  if (!row) throw notFound('Änderung')
  if (row.status !== 'failed' && row.status !== 'closed') throw badRequest('Nur gescheiterte oder geschlossene Änderungen lassen sich ausblenden')
  await db.update(schema.serviceChanges).set({ dismissedAt: new Date(), updatedAt: new Date() }).where(eq(schema.serviceChanges.id, id))
  await audit({ actor, action: 'service.dismiss', targetType: 'project', targetId: p.id, params: { change: id, service: row.service }, result: 'ok' })
}
