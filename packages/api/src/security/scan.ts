import { eq, and, desc, inArray, ne } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { db, schema } from '../db/index.js'
import type { ScanStages } from '../db/schema.js'
import { config, urlForHost } from '../config.js'
import * as docker from '../drivers/docker.js'
import { findProject } from '../domain/projects.js'
import { activeDeployment, effectiveKind } from '../domain/deployments.js'
import { audit } from '../domain/audit.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { siteDir } from '../deploy/sources/static.js'
import { score, grade, fingerprint, dedupe, bySeverity, publishable, type FindingInput, type Severity } from './score.js'
import { trivyImage, trivySource, headerCheck, zap, nuclei, testssl, startStaticTarget, type ScanTarget } from './stages.js'
import { recheckExternalTarget, assertTargetIsPublic } from './external-targets.js'
import { notify } from '../notify/send.js'

/**
 * Scan-Ablauf (M6). Scans laufen nacheinander in einer Warteschlange;
 * Fehler einer Stufe werden festgehalten, die nächste läuft trotzdem.
 */

type Run = typeof schema.scanRuns.$inferSelect

export const EXT_SCAN_NETWORK = 'dep_ext-scan'
/** Quellordner eines Deploys, den die Pipeline für den Scan aufhebt. */
export const scanSourceDir = (deploymentId: string) => join(config.DATA_DIR, 'scan-src', deploymentId)

/* --- Warteschlange ------------------------------------------------------------ */

const queue: string[] = []
let busy = false

function pump(): void {
  if (busy) return
  const id = queue.shift()
  if (!id) return
  busy = true
  runScan(id)
    .catch((err) => log.error('Scan fehlgeschlagen', { scan: id, err: String(err) }))
    .finally(() => {
      busy = false
      pump()
    })
}

/** Nach einem Neustart: angefangene Scans als abgebrochen markieren. */
/**
 * Beim Start: Scans, die ein Neustart unterbrochen hat, als gescheitert
 * markieren und ihre Reste entfernen – Scanner-Container, Arbeits- und
 * Quellordner. Beim Start läuft noch kein Scan; alles davon ist verwaist.
 */
export async function abandonUnfinishedScans(): Promise<void> {
  await db
    .update(schema.scanRuns)
    .set({ status: 'failed', error: 'Abgebrochen durch Neustart des deployers', finishedAt: new Date() })
    .where(inArray(schema.scanRuns.status, ['queued', 'running']))
  for (const c of await docker.listManagedContainers().catch(() => [])) {
    if (c.labels['deployer.role'] !== 'scanner') continue
    await docker.stopContainer(c.id).catch(() => {})
    await docker.removeContainer(c.id).catch(() => {})
    log.info('Verwaisten Scanner entfernt', { id: c.id.slice(0, 12) })
  }
  await rm(join(config.DATA_DIR, 'scan'), { recursive: true, force: true }).catch(() => {})
  await rm(join(config.DATA_DIR, 'scan-src'), { recursive: true, force: true }).catch(() => {})
}

export async function enqueueProjectScan(
  idOrSlug: string,
  o: { level?: 'standard' | 'active'; deploymentId?: string; actor: string },
): Promise<Run> {
  const project = await findProject(idOrSlug)
  const active = await activeDeployment(project.id)
  if (!active) throw badRequest('Das Projekt hat keine laufende Fassung, die sich scannen liesse')
  const rows = await db
    .insert(schema.scanRuns)
    .values({ projectId: project.id, deploymentId: o.deploymentId ?? active.id, level: o.level ?? 'standard' })
    .returning()
  const run = rows[0]!
  await audit({ actor: o.actor, action: 'scan.start', targetType: 'project', targetId: project.id, params: { scan: run.id, level: run.level }, result: 'ok' })
  queue.push(run.id)
  pump()
  return run
}

export async function enqueueExternalScan(
  targetId: string,
  o: { level?: 'standard' | 'active'; actor: string },
): Promise<Run> {
  const t = (await db.select().from(schema.externalTargets).where(eq(schema.externalTargets.id, targetId)).limit(1))[0]
  if (!t) throw notFound('Externes Ziel')
  if (!t.verifiedAt) throw new AppError('not_verified', `${t.hostname} ist noch nicht per TXT-Eintrag nachgewiesen`, 400)
  const rows = await db.insert(schema.scanRuns).values({ externalTargetId: t.id, level: o.level ?? 'standard' }).returning()
  const run = rows[0]!
  await audit({ actor: o.actor, action: 'scan.start', targetType: 'external_target', targetId: t.id, params: { scan: run.id, level: run.level, hostname: t.hostname }, result: 'ok' })
  queue.push(run.id)
  pump()
  return run
}

/* --- Ein Scan -------------------------------------------------------------------- */

async function runScan(runId: string): Promise<void> {
  const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, runId)).limit(1))[0]
  if (!run) return
  await db.update(schema.scanRuns).set({ status: 'running', startedAt: new Date() }).where(eq(schema.scanRuns.id, runId))
  const stages: ScanStages = {}
  const all: FindingInput[] = []
  const labels = { 'deployer.scan': runId, ...(run.projectId ? {} : {}) }

  const stage = async (name: string, fn: () => Promise<FindingInput[]>) => {
    try {
      const f = await fn()
      all.push(...f)
      stages[name] = { ran: true, findings: f.length }
    } catch (err) {
      stages[name] = { ran: false, failed: true, note: (err as Error).message.slice(0, 300) }
      log.warn('Scan-Stufe gescheitert', { scan: runId, stage: name, err: String(err) })
    }
  }

  try {
    let rewrite: ((loc: string) => string) | null = null
    if (run.projectId) rewrite = await scanProject(run, stage, stages, labels)
    else await scanExternal(run, stage, stages, labels)
    const findings = rewrite ? all.map((f) => ({ ...f, location: rewrite!(f.location) })) : all
    await finalize(run, findings, stages)
  } catch (err) {
    await db
      .update(schema.scanRuns)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date(), stages })
      .where(eq(schema.scanRuns.id, runId))
  } finally {
    // Auf jedem Weg aufräumen: die Kopie des Quellcodes (kann Secrets
    // enthalten) und das Arbeitsverzeichnis des Scans (Review M6).
    if (run.deploymentId) await rm(scanSourceDir(run.deploymentId), { recursive: true, force: true }).catch(() => {})
    await rm(join(config.DATA_DIR, 'scan', run.id), { recursive: true, force: true }).catch(() => {})
  }
}

type StageFn = (name: string, fn: () => Promise<FindingInput[]>) => Promise<void>

/**
 * Scannt ein Projekt. Gibt eine Funktion zurück, die in Fundstellen die
 * interne Adresse (Containername, wechselt mit jedem Deploy; bei statischen
 * Seiten mit jedem Scan) durch die Adresse des Projekts ersetzt. Ohne das
 * hätte derselbe Befund nach jedem Deploy einen neuen Fingerabdruck, und
 * eine Akzeptanz ginge verloren.
 */
async function scanProject(run: Run, stage: StageFn, stages: ScanStages, labels: Record<string, string>): Promise<(loc: string) => string> {
  const project = await findProject(run.projectId!)
  const active = await activeDeployment(project.id)
  if (!active) throw new Error('Keine laufende Fassung mehr')
  const kind = effectiveKind(project.sourceType, active.artifact)
  const network = docker.projectNetworkName(project.slug)
  const scanLabels = { ...labels, [docker.LABEL_PROJECT]: project.slug }

  // Stufe 1: Images (Image, Dockerfile, alle Compose-Dienste) und Quellen.
  const images = new Set<string>()
  if ((kind === 'image' || kind === 'dockerfile') && active.imageRef) images.add(active.imageRef)
  if (kind === 'compose') {
    for (const c of await docker.listManagedContainers()) {
      if (c.labels[docker.LABEL_PROJECT] !== project.slug || !c.labels['deployer.compose-service']) continue
      const info = await docker.docker.getContainer(c.id).inspect().catch(() => null) as { Config?: { Image?: string } } | null
      if (info?.Config?.Image) images.add(info.Config.Image)
    }
  }
  await docker.ensureNetwork(network)
  if (images.size === 0) stages['trivy-image'] = { ran: false, note: 'kein Image (statische Seite)' }
  for (const img of images) await stage(images.size > 1 ? `trivy-image ${img}` : 'trivy-image', () => trivyImage(run.id, img, network, scanLabels))

  const src = run.deploymentId && existsSync(scanSourceDir(run.deploymentId))
    ? scanSourceDir(run.deploymentId)
    : kind === 'static' && existsSync(join(siteDir(project.slug), 'current'))
      ? join(siteDir(project.slug), 'current')
      : null
  if (src) await stage('trivy-source', () => trivySource(run.id, src, network, scanLabels))
  else stages['trivy-source'] = { ran: false, note: 'kein Quellordner (fertiges Image)' }

  // Stufen 2 und 3 gegen den Container im Projekt-Netz.
  let target: ScanTarget
  let stopStatic: (() => Promise<void>) | null = null
  if (kind === 'static') {
    const s = await startStaticTarget(project.slug, run.id)
    stopStatic = s.stop
    target = { url: s.url, network: s.network, host: new URL(s.url).hostname, isHttps: false, external: false }
  } else {
    const host = active.artifact?.webContainer ?? docker.containerName(project.slug, active.id)
    if (!project.port) throw new Error('Projekt ohne Port')
    target = { url: `http://${host}:${project.port}/`, network, host, isHttps: false, external: false }
  }

  try {
    await stage('headers', () => headerCheck(target))
    await stage(run.level === 'active' ? 'zap-full' : 'zap-baseline', () => zap(run.id, target, scanLabels, run.level === 'active'))
    await stage('nuclei', () => nuclei(run.id, target, scanLabels))
    // TLS endet bei Caddy, nicht im Projekt-Container: geprüft würde für jedes
    // Projekt dieselbe Caddy-Konfiguration. Zertifikatsstatus: Systemseite (M4).
    stages.testssl = { ran: false, note: config.TLS_MODE === 'cloudflare' ? 'zentral über Caddy, siehe Systemseite' : 'nicht anwendbar: intern kein TLS' }
  } finally {
    if (stopStatic) await stopStatic().catch(() => {})
  }

  const internal = new URL(target.url).origin
  const route = (await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.projectId, project.id)).limit(1))[0]
  const publicOrigin = route ? urlForHost(route.hostname) : `projekt:${project.slug}`
  return (loc) => loc.split(internal).join(publicOrigin)
}

async function scanExternal(run: Run, stage: StageFn, stages: ScanStages, labels: Record<string, string>): Promise<void> {
  const t = (await db.select().from(schema.externalTargets).where(eq(schema.externalTargets.id, run.externalTargetId!)).limit(1))[0]
  if (!t) throw new Error('Externes Ziel nicht mehr vorhanden')
  // Vor jedem Scan erneut prüfen (SPEC). Fehlt der Eintrag: Freigabe weg.
  const still = await recheckExternalTarget(t.id)
  if (!still) throw new Error(`Besitznachweis für ${t.hostname} fehlt; Scan abgebrochen`)
  // Zeigt der Name (inzwischen) ins LAN oder auf den Server selbst: kein Scan.
  await assertTargetIsPublic(t.hostname)

  await docker.ensureNetwork(EXT_SCAN_NETWORK)
  const target: ScanTarget = { url: `https://${t.hostname}/`, network: EXT_SCAN_NETWORK, host: t.hostname, isHttps: true, external: true }
  // Stufe 1 entfällt (SPEC): es gibt kein Image.
  stages['trivy-image'] = { ran: false, note: 'entfällt bei externen Zielen' }
  await stage('headers', () => headerCheck(target))
  await stage(run.level === 'active' ? 'zap-full' : 'zap-baseline', () => zap(run.id, target, labels, run.level === 'active'))
  await stage('nuclei', () => nuclei(run.id, target, labels))
  await stage('testssl', () => testssl(run.id, target, labels))
}

/* --- Abschluss: Befunde, Score, Akzeptanzen, Benachrichtigung ------------------------ */

/** Werkzeug eines Befunds -> Stufen, die es liefern. */
const STAGE_TOOL: [RegExp, string][] = [
  [/^trivy-/, 'trivy'],
  [/^headers$/, 'header-check'],
  [/^zap-/, 'zap'],
  [/^nuclei$/, 'nuclei'],
  [/^testssl$/, 'testssl'],
]

/** Werkzeuge, deren angelaufene Stufen alle durchliefen (nicht anwendbare zählen nicht). */
export function toolsChecked(stages: ScanStages): Set<string> {
  const ok = new Map<string, boolean>()
  for (const [name, st] of Object.entries(stages)) {
    const tool = STAGE_TOOL.find(([re]) => re.test(name))?.[1]
    if (!tool) continue
    if (st.ran) ok.set(tool, ok.get(tool) ?? true)
    if (st.failed) ok.set(tool, false)
  }
  return new Set([...ok].filter(([, v]) => v).map(([k]) => k))
}

async function finalize(run: Run, raw: FindingInput[], stages: ScanStages): Promise<void> {
  const found = dedupe(raw)
  const scope = run.projectId
    ? eq(schema.findingAcceptances.projectId, run.projectId)
    : eq(schema.findingAcceptances.externalTargetId, run.externalTargetId!)
  const accepted = new Map(
    (await db.select().from(schema.findingAcceptances).where(scope)).map((a) => [a.fingerprint, a.reason]),
  )

  const rows = found.map(({ key: _key, ...f }) => {
    const fp = fingerprint({ ...f, key: _key })
    const reason = accepted.get(fp)
    return { scanRunId: run.id, ...f, fingerprint: fp, status: (reason ? 'accepted' : 'open') as 'accepted' | 'open', acceptReason: reason ?? null }
  })
  if (rows.length) await db.insert(schema.findings).values(rows)

  const open = rows.filter((r) => r.status === 'open')
  const s = score(open)
  const g = grade(s)
  const ranAny = Object.values(stages).some((x) => x.ran)
  await db
    .update(schema.scanRuns)
    .set({
      status: ranAny ? 'done' : 'failed',
      score: ranAny ? s : null,
      grade: ranAny ? g : null,
      finishedAt: new Date(),
      stages,
      error: ranAny ? null : 'Keine Stufe lief durch',
    })
    .where(eq(schema.scanRuns.id, run.id))
  if (!ranAny) return

  // Frühere offene Befunde, die nicht mehr auftauchen: behoben.
  const prevRuns = await db
    .select({ id: schema.scanRuns.id })
    .from(schema.scanRuns)
    .where(and(
      run.projectId ? eq(schema.scanRuns.projectId, run.projectId) : eq(schema.scanRuns.externalTargetId, run.externalTargetId!),
      ne(schema.scanRuns.id, run.id),
    ))
  const prevIds = prevRuns.map((r) => r.id)
  const nowFps = new Set(rows.map((r) => r.fingerprint))
  let previousFps = new Set<string>()
  if (prevIds.length) {
    const prevOpen = await db.select().from(schema.findings).where(and(inArray(schema.findings.scanRunId, prevIds), eq(schema.findings.status, 'open')))
    previousFps = new Set(prevOpen.map((f) => f.fingerprint))
    // Nur Befunde von Werkzeugen, deren Stufen diesmal alle durchliefen. Fiel
    // ZAP aus, ist ein ZAP-Befund nicht behoben, nur ungeprüft (Review M6).
    const checked = toolsChecked(stages)
    const gone = prevOpen.filter((f) => checked.has(f.tool) && !nowFps.has(f.fingerprint)).map((f) => f.id)
    if (gone.length) await db.update(schema.findings).set({ status: 'fixed' }).where(inArray(schema.findings.id, gone))
  }

  // Neu hinzugekommene kritische und hohe Befunde melden.
  const name = run.projectId
    ? (await findProject(run.projectId)).name
    : (await db.select().from(schema.externalTargets).where(eq(schema.externalTargets.id, run.externalTargetId!)))[0]?.hostname ?? '?'
  for (const sev of ['critical', 'high'] as Severity[]) {
    const fresh = open.filter((f) => f.severity === sev && !previousFps.has(f.fingerprint))
    if (fresh.length) {
      await notify(sev === 'critical' ? 'finding_critical' : 'finding_high', {
        target: name, score: s, grade: g, findings: fresh.map((f) => ({ title: f.title, location: f.location })),
      }, run.projectId ?? undefined)
    }
  }
}

/* --- Lesen, Akzeptieren, Schwelle ----------------------------------------------------- */

export interface ScanReport {
  scan: { id: string; status: string; level: string; startedAt: string; finishedAt: string | null; score: number | null; grade: string | null; error: string | null; stages: ScanStages }
  counts: Record<Severity, number>
  top: { id: string; severity: Severity; title: string; location: string; fix: string }[]
  findings: (typeof schema.findings.$inferSelect)[]
}

export async function scanReport(runId: string): Promise<ScanReport> {
  const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, runId)).limit(1))[0]
  if (!run) throw notFound('Scan')
  const f = (await db.select().from(schema.findings).where(eq(schema.findings.scanRunId, runId))).sort(bySeverity)
  const open = f.filter((x) => x.status === 'open')
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>
  for (const x of open) counts[x.severity]++
  return {
    scan: {
      id: run.id, status: run.status, level: run.level, startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null, score: run.score, grade: run.grade, error: run.error, stages: run.stages,
    },
    counts,
    top: open.slice(0, 3).map((x) => ({ id: x.id, severity: x.severity, title: x.title, location: x.location, fix: x.fix })),
    findings: f,
  }
}

export async function latestScan(projectId: string, onlyDone = false): Promise<Run | null> {
  const rows = await db
    .select()
    .from(schema.scanRuns)
    .where(and(eq(schema.scanRuns.projectId, projectId), onlyDone ? eq(schema.scanRuns.status, 'done') : undefined))
    .orderBy(desc(schema.scanRuns.startedAt))
    .limit(1)
  return rows[0] ?? null
}

export async function latestExternalScan(targetId: string): Promise<Run | null> {
  const rows = await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.externalTargetId, targetId)).orderBy(desc(schema.scanRuns.startedAt)).limit(1)
  return rows[0] ?? null
}

/** Gehört der Scan zu diesem Projekt bzw. externen Ziel? */
export async function scanBelongsTo(runId: string, owner: { projectId?: string; externalTargetId?: string }): Promise<boolean> {
  const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, runId)).limit(1))[0]
  if (!run) return false
  return owner.projectId ? run.projectId === owner.projectId : run.externalTargetId === owner.externalTargetId
}

/** Projekt eines Befunds (null bei externen Zielen oder unbekanntem Befund). */
export async function findingProject(findingId: string): Promise<string | null> {
  const r = await db
    .select({ projectId: schema.scanRuns.projectId })
    .from(schema.findings)
    .innerJoin(schema.scanRuns, eq(schema.findings.scanRunId, schema.scanRuns.id))
    .where(eq(schema.findings.id, findingId))
    .limit(1)
  return r[0]?.projectId ?? null
}

export async function listScans(projectId: string, limit = 20): Promise<Run[]> {
  return db.select().from(schema.scanRuns).where(eq(schema.scanRuns.projectId, projectId)).orderBy(desc(schema.scanRuns.startedAt)).limit(limit)
}

/**
 * Akzeptieren mit Begründung, gilt für den Fingerabdruck – also auch in
 * künftigen Scans. Steht im Audit-Log (SPEC).
 */
export async function acceptFinding(
  findingId: string,
  reason: string,
  actor: string,
  /** MCP: der Befund muss zu diesem Ziel gehören (Review M6). */
  owner?: { projectId?: string; externalTargetId?: string },
): Promise<void> {
  const clean = reason.trim()
  if (clean.length < 3) throw badRequest('Bitte eine Begründung angeben')
  const f = (await db.select().from(schema.findings).where(eq(schema.findings.id, findingId)).limit(1))[0]
  if (!f) throw notFound('Befund')
  const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, f.scanRunId)).limit(1))[0]!
  if (owner && !(await scanBelongsTo(run.id, owner))) throw notFound('Befund')
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.findingAcceptances)
      .where(and(
        eq(schema.findingAcceptances.fingerprint, f.fingerprint),
        run.projectId ? eq(schema.findingAcceptances.projectId, run.projectId) : eq(schema.findingAcceptances.externalTargetId, run.externalTargetId!),
      ))
    if (existing[0]) {
      await tx.update(schema.findingAcceptances).set({ reason: clean, actor, acceptedAt: new Date() }).where(eq(schema.findingAcceptances.id, existing[0].id))
    } else {
      await tx.insert(schema.findingAcceptances).values({
        projectId: run.projectId, externalTargetId: run.externalTargetId, fingerprint: f.fingerprint, reason: clean, actor,
      })
    }
    // Alle offenen Vorkommen mit diesem Fingerabdruck in Scans desselben Ziels.
    const sameTarget = await tx
      .select({ id: schema.scanRuns.id, status: schema.scanRuns.status })
      .from(schema.scanRuns)
      .where(run.projectId ? eq(schema.scanRuns.projectId, run.projectId) : eq(schema.scanRuns.externalTargetId, run.externalTargetId!))
    await tx
      .update(schema.findings)
      .set({ status: 'accepted', acceptReason: clean })
      .where(and(eq(schema.findings.fingerprint, f.fingerprint), inArray(schema.findings.scanRunId, sameTarget.map((r) => r.id)), ne(schema.findings.status, 'fixed')))
    // Score aller betroffenen abgeschlossenen Scans neu rechnen – nicht nur
    // des Scans, aus dem der Befund stammt. Sonst zeigte der neueste Scan
    // (Projektliste, Wochenübersicht) einen Abzug ohne offenen Befund.
    for (const r of sameTarget) {
      if (r.status !== 'done') continue
      const open = await tx.select().from(schema.findings).where(and(eq(schema.findings.scanRunId, r.id), eq(schema.findings.status, 'open')))
      const s = score(open)
      await tx.update(schema.scanRuns).set({ score: s, grade: grade(s) }).where(eq(schema.scanRuns.id, r.id))
    }
  })
  await audit({
    actor, action: 'finding.accept', targetType: run.projectId ? 'project' : 'external_target',
    targetId: run.projectId ?? run.externalTargetId, params: { finding: f.id, title: f.title, severity: f.severity, reason: clean }, result: 'ok',
  })
}

/**
 * Schwelle für «öffentlich» (SPEC): kein offener kritischer Befund im
 * letzten abgeschlossenen Scan. Wird mit M5 an set_targets angeschlossen.
 */
export async function assertPublishable(projectId: string): Promise<void> {
  const last = await latestScan(projectId, true)
  const open = last
    ? await db.select().from(schema.findings).where(and(eq(schema.findings.scanRunId, last.id), eq(schema.findings.status, 'open')))
    : []
  const r = publishable(Boolean(last), open)
  if (!r.ok) throw new AppError('not_publishable', `Nicht öffentlich schaltbar: ${r.reason}`, 409)
}
