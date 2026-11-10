import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { config, primaryHost, urlForHost } from '../config.js'
import { activeDeployment } from '../domain/deployments.js'
import { findProject } from '../domain/projects.js'
import { repoUrlPolicy } from '../domain/git-policy.js'
import { connectedRepo, repoToken, github } from '../domain/github.js'
import { audit } from '../domain/audit.js'
import { startDeploy } from '../deploy/pipeline.js'
import { lsRemoteHead } from '../lib/git.js'
import { log } from '../lib/log.js'

/**
 * M8, Etappe 3: Auto-Deploy nach Merge, ohne Webhook (deployer ist nie
 * öffentlich). Alle 5 Minuten:
 * 1. Projekte mit auto_deploy: Kopf des Deploy-Branches mit der aktiven
 *    Fassung vergleichen; bei neuem Commit deployen (der Scan folgt).
 * 2. Offene Pull Requests von deployer: gemergt -> «merged», ohne Merge
 *    geschlossen -> «verworfen».
 * 3. Bestätigte Fixes mit Pull Request: Ergebnis als Kommentar am PR.
 */

/** Rein: soll jetzt deployt werden? */
export function autoDeployDecision(o: { head: string; activeVersion: string | null | undefined; busy: boolean; pinnedCommit: boolean }): { deploy: boolean; reason: string } {
  if (o.pinnedCommit) return { deploy: false, reason: 'auf einen Commit festgelegt' }
  if (o.busy) return { deploy: false, reason: 'Deploy läuft schon' }
  if (!o.activeVersion) return { deploy: false, reason: 'keine aktive Fassung (erst von Hand deployen)' }
  if (o.activeVersion === o.head) return { deploy: false, reason: 'aktuell' }
  return { deploy: true, reason: `neuer Commit ${o.head.slice(0, 12)}` }
}

/** Kommentar am Pull Request nach dem Nachscan */
export function prComment(o: { title: string; verified: boolean; score: number | null; grade: string | null; scanUrl: string }): string {
  return [
    o.verified
      ? `✅ deployer: Nach dem Merge deployt und nachgescannt – der Befund «${o.title}» ist behoben.`
      : `⚠️ deployer: Nach dem Merge deployt und nachgescannt – der Befund «${o.title}» besteht weiter.`,
    o.grade ? `Note jetzt ${o.grade} (${o.score} / 100).` : '',
    `Bericht: ${o.scanUrl}`,
  ].filter(Boolean).join('\n\n')
}

const BUSY = ['pending', 'pulling', 'starting', 'healthchecking'] as const

async function checkProjects(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.autoDeploy, true), inArray(schema.projects.sourceType, ['dockerfile', 'compose']), eq(schema.projects.desiredState, 'running')))
  for (const p of rows) {
    try {
      const src = p.sourceConfig as { repoUrl?: string; ref?: string }
      if (!src.repoUrl) continue
      const pinned = Boolean(src.ref && /^[0-9a-f]{40}$/.test(src.ref))
      const gh = await connectedRepo(p).catch(() => null)
      let head: string
      if (gh) {
        const token = await repoToken(gh.repo)
        const branch = src.ref && !pinned ? src.ref : await github().defaultBranch(token, gh.owner, gh.repo)
        head = await github().branchHead(token, gh.owner, gh.repo, branch)
      } else {
        // Öffentliches Repo ohne App: anonym über git ls-remote
        head = await lsRemoteHead({ url: src.repoUrl, ref: pinned ? null : src.ref ?? null, policy: await repoUrlPolicy() })
      }
      const active = await activeDeployment(p.id)
      const busy = (await db.select({ s: schema.deployments.status }).from(schema.deployments).where(and(eq(schema.deployments.projectId, p.id), inArray(schema.deployments.status, [...BUSY])))).length > 0
      const d = autoDeployDecision({ head, activeVersion: active?.version, busy, pinnedCommit: pinned })
      if (d.deploy) {
        const dep = await startDeploy(p.id, 'system:auto-deploy')
        await audit({ actor: 'system:auto-deploy', action: 'project.auto_deploy', targetType: 'project', targetId: p.id, params: { head, deployment: dep.id }, result: 'ok' })
        log.info('Auto-Deploy nach neuem Commit', { project: p.slug, head: head.slice(0, 12) })
      }
    } catch (err) {
      log.warn('Auto-Deploy: Prüfung gescheitert', { project: p.slug, err: String(err) })
    } finally {
      await db.update(schema.projects).set({ autoDeployCheckedAt: new Date() }).where(eq(schema.projects.id, p.id))
    }
  }
}

async function checkPullRequests(): Promise<void> {
  const open = await db.select().from(schema.fixRequests).where(and(eq(schema.fixRequests.status, 'pr_open'), isNotNull(schema.fixRequests.prNumber)))
  for (const fx of open) {
    try {
      const p = await findProject(fx.projectId)
      const r = await connectedRepo(p)
      if (!r) continue
      const pr = await github().pull(await repoToken(r.repo), r.owner, r.repo, fx.prNumber!)
      if (pr.merged) {
        await db.update(schema.fixRequests).set({
          status: 'merged', updatedAt: new Date(),
          note: p.autoDeploy ? 'Gemergt; Auto-Deploy holt den neuen Stand, der Scan danach bestätigt die Behebung.' : 'Gemergt. Auto-Deploy ist aus: neu deployen, dann scannt deployer nach.',
        }).where(eq(schema.fixRequests.id, fx.id))
      } else if (pr.state === 'closed') {
        await db.update(schema.fixRequests).set({ status: 'rejected', note: 'Pull Request ohne Merge geschlossen.', updatedAt: new Date() }).where(eq(schema.fixRequests.id, fx.id))
      }
    } catch (err) {
      log.warn('Pull Request: Status nicht abgefragt', { fix: fx.id, err: String(err) })
    }
  }

  // Ergebnis des Nachscans am Pull Request hinterlassen
  const done = await db.select().from(schema.fixRequests).where(and(eq(schema.fixRequests.status, 'verified'), isNotNull(schema.fixRequests.prNumber), isNull(schema.fixRequests.prCommentedAt)))
  for (const fx of done) {
    try {
      const p = await findProject(fx.projectId)
      const r = await connectedRepo(p)
      if (!r) continue
      const last = (await db.select().from(schema.scanRuns).where(and(eq(schema.scanRuns.projectId, p.id), eq(schema.scanRuns.status, 'done'))).orderBy(schema.scanRuns.startedAt)).pop()
      const body = prComment({ title: fx.findingTitle, verified: true, score: last?.score ?? null, grade: last?.grade ?? null, scanUrl: `${urlForHost(primaryHost('deployer'))}/projekte/${p.id}?tab=security` })
      await github().comment(await repoToken(r.repo), r.owner, r.repo, fx.prNumber!, body)
      await db.update(schema.fixRequests).set({ prCommentedAt: new Date() }).where(eq(schema.fixRequests.id, fx.id))
    } catch (err) {
      log.warn('Pull Request: Kommentar nicht geschrieben', { fix: fx.id, err: String(err) })
    }
  }
}

let running = false

export async function autoDeployTick(): Promise<void> {
  if (running) return
  running = true
  try {
    await checkPullRequests()
    await checkProjects()
  } finally {
    running = false
  }
}

export function startAutoDeployJob(): NodeJS.Timeout {
  const t = setInterval(() => void autoDeployTick().catch((err) => log.warn('Auto-Deploy-Lauf gescheitert', { err: String(err) })), config.AUTO_DEPLOY_INTERVAL_S * 1000)
  t.unref()
  return t
}
