import { eq, and, desc, inArray, ne } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { db, schema } from '../db/index.js'
import type { ScanStage, ScanStages } from '../db/schema.js'
import { cf, config, urlForHost } from '../config.js'
import * as docker from '../drivers/docker.js'
import { findProject } from '../domain/projects.js'
import { activeDeployment, effectiveKind } from '../domain/deployments.js'
import { audit } from '../domain/audit.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { siteDir } from '../deploy/sources/static.js'
import { score, grade, fingerprint, dedupe, bySeverity, publishable, type FindingInput, type Severity } from './score.js'
import { trivyImage, trivySource, headerCheck, headerCheckViaCaddy, zap, nuclei, testssl, startStaticTarget, type ScanTarget, type OnLogs, type StageResult } from './stages.js'
import { planStages, waiting, skipped, infoOf, progressOf, tailOf, StageTimeout, type ScanTrigger } from './progress.js'
import { probeTargetFor } from '../domain/routes.js'
import type { HeaderRecheckDto } from '@deployer/shared'
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
/** Der laufende Scan und wer ihn abbrechen liess (null: läuft weiter). */
let current: { id: string; cancelledBy: string | null } | null = null

/**
 * Wer nach einem abgeschlossenen Projekt-Scan etwas tun will (vorgemerkte
 * Öffentlich-Anfragen, domain/public.ts). Ohne Import in diese Richtung:
 * public.ts hängt schon an scan.ts.
 */
const doneListeners: ((projectId: string) => void)[] = []
export function onProjectScanDone(fn: (projectId: string) => void): void {
  doneListeners.push(fn)
}

/** Scans in der Warteschlange inklusive des laufenden (für die Übersicht). */
export function scanQueueLength(): number {
  return queue.length + (busy ? 1 : 0)
}

/** Position in der Warteschlange (1 = als Nächstes) und wie viele Scans davor sind. */
export function scanQueuePosition(runId: string): { position: number; ahead: number } | null {
  const i = queue.indexOf(runId)
  if (i < 0) return null
  return { position: i + 1, ahead: i + (busy ? 1 : 0) }
}

function pump(): void {
  if (busy) return
  const id = queue.shift()
  if (!id) return
  busy = true
  current = { id, cancelledBy: null }
  runScan(id)
    .catch((err) => log.error('Scan fehlgeschlagen', { scan: id, err: String(err) }))
    .finally(() => {
      busy = false
      current = null
      pump()
    })
}

/** Scanner-Container eines Scans beenden (Abbruch, Zeitlimit-Wächter). */
async function killScanners(runId: string): Promise<void> {
  for (const c of await docker.listManagedContainers().catch(() => [])) {
    if (c.labels['deployer.scan'] !== runId) continue
    await docker.stopContainer(c.id, 2).catch(() => {})
  }
}

/**
 * Scan abbrechen: aus der Warteschlange nehmen oder den laufenden stoppen.
 * Der laufende beendet seine aktuelle Stufe (Scanner wird gestoppt), die
 * übrigen Stufen laufen nicht mehr; Befunde werden nicht gewertet.
 */
export async function cancelScan(runId: string, actor: string): Promise<void> {
  const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, runId)).limit(1))[0]
  if (!run) throw notFound('Scan')
  const i = queue.indexOf(runId)
  if (i >= 0) {
    queue.splice(i, 1)
    const stages = Object.fromEntries(Object.entries(run.stages).map(([k, s]) => [k, s.state === 'waiting' ? { ...s, state: 'cancelled' as const, note: 'nicht gelaufen: Scan abgebrochen' } : s]))
    await db.update(schema.scanRuns).set({ status: 'cancelled', error: `Abgebrochen von ${actor} (vor dem Start)`, finishedAt: new Date(), stages }).where(eq(schema.scanRuns.id, runId))
  } else if (current?.id === runId) {
    current.cancelledBy = actor
    await killScanners(runId)
  } else {
    throw new AppError('scan_not_running', 'Dieser Scan läuft nicht mehr', 409)
  }
  log.info('Scan abgebrochen', { scan: runId, actor })
  await audit({ actor, action: 'scan.cancel', targetType: run.projectId ? 'project' : 'external_target', targetId: run.projectId ?? run.externalTargetId, params: { scan: runId }, result: 'ok' })
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

/** Quellordner für trivy-source: aufgehobener Deploy-Ordner oder die ausgelieferte statische Seite. */
function sourceDirFor(deploymentId: string | null, kind: string, slug: string): string | null {
  if (deploymentId && existsSync(scanSourceDir(deploymentId))) return scanSourceDir(deploymentId)
  if (kind === 'static' && existsSync(join(siteDir(slug), 'current'))) return join(siteDir(slug), 'current')
  return null
}

export async function enqueueProjectScan(
  idOrSlug: string,
  o: { level?: 'standard' | 'active'; deploymentId?: string; actor: string; trigger: ScanTrigger },
): Promise<Run> {
  const project = await findProject(idOrSlug)
  const active = await activeDeployment(project.id)
  if (!active) throw badRequest('Das Projekt hat keine laufende Fassung, die sich scannen liesse')
  const level = o.level ?? 'standard'
  const deploymentId = o.deploymentId ?? active.id
  const kind = effectiveKind(project.sourceType, active.artifact)
  // Stufen von Anfang an zeigen, auch solange der Scan wartet
  const stages = planStages({ external: false, level, kind, hasSource: Boolean(sourceDirFor(deploymentId, kind, project.slug)), tls: cf.tls() })
  const rows = await db
    .insert(schema.scanRuns)
    .values({ projectId: project.id, deploymentId, level, trigger: o.trigger, actor: o.actor, stages })
    .returning()
  const run = rows[0]!
  await audit({ actor: o.actor, action: 'scan.start', targetType: 'project', targetId: project.id, params: { scan: run.id, level: run.level }, result: 'ok' })
  queue.push(run.id)
  pump()
  return run
}

export async function enqueueExternalScan(
  targetId: string,
  o: { level?: 'standard' | 'active'; actor: string; trigger: ScanTrigger },
): Promise<Run> {
  const t = (await db.select().from(schema.externalTargets).where(eq(schema.externalTargets.id, targetId)).limit(1))[0]
  if (!t) throw notFound('Externes Ziel')
  if (!t.verifiedAt) throw new AppError('not_verified', `${t.hostname} ist noch nicht per TXT-Eintrag nachgewiesen`, 400)
  const level = o.level ?? 'standard'
  const rows = await db.insert(schema.scanRuns).values({
    externalTargetId: t.id, level, trigger: o.trigger, actor: o.actor, stages: planStages({ external: true, level }),
  }).returning()
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
  const startedAt = new Date()
  await db.update(schema.scanRuns).set({ status: 'running', startedAt }).where(eq(schema.scanRuns.id, runId))
  log.info('Scan gestartet', { scan: runId, project: run.projectId, external: run.externalTargetId, level: run.level, trigger: run.trigger, actor: run.actor })
  // Der Plan aus enqueue*; jede Stufe aktualisiert ihren Eintrag
  const stages: ScanStages = { ...run.stages }
  const all: FindingInput[] = []
  const labels = { 'deployer.scan': runId }
  const cancelledBy = () => (current?.id === runId ? current.cancelledBy : null)

  // Zwischenstand in die Datenbank, gedrosselt: Oberfläche und MCP lesen ihn
  let lastSave = 0
  let saving: Promise<unknown> = Promise.resolve()
  const save = (force = false) => {
    if (!force && Date.now() - lastSave < 1_500) return saving
    lastSave = Date.now()
    const snapshot = structuredClone(stages)
    saving = saving.then(() => db.update(schema.scanRuns).set({ stages: snapshot }).where(eq(schema.scanRuns.id, runId))).catch(() => {})
    return saving
  }

  const stage: StageFn = async (name, fn) => {
    const info = infoOf(name)
    const by = cancelledBy()
    if (by) {
      stages[name] = { ...(stages[name] ?? waiting(name)), ran: false, state: 'cancelled', note: 'nicht gelaufen: Scan abgebrochen' }
      return
    }
    const t0 = Date.now()
    const st: ScanStage = { ...(stages[name] ?? waiting(name)), ran: false, state: 'running', startedAt: new Date(t0).toISOString(), timeoutMs: info.timeoutMs }
    stages[name] = st
    await save(true)
    log.info('Scan-Stufe gestartet', { scan: runId, stage: name })
    const onLogs = (text: string) => {
      st.progress = progressOf(name, text) ?? st.progress
      st.tail = tailOf(text)
      void save()
    }
    // Wächter: hängt eine Stufe ausserhalb eines Scanner-Containers (Image-
    // Export, Netz), endet sie trotzdem – mit klarer Meldung statt endlosem «läuft».
    let guard: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      guard = setTimeout(() => {
        void killScanners(runId)
        reject(new StageTimeout(info.timeoutMs))
      }, info.timeoutMs + 60_000)
    })
    try {
      const res = await Promise.race([fn(onLogs), timeout])
      const f = Array.isArray(res) ? res : res.findings
      const checked = Array.isArray(res) ? undefined : res.checked
      all.push(...f)
      stages[name] = { ...st, ran: true, state: 'done', findings: f.length, ...(checked ? { checked } : {}), finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, progress: undefined }
      log.info('Scan-Stufe fertig', { scan: runId, stage: name, dauerMs: Date.now() - t0, befunde: f.length })
    } catch (err) {
      const state = cancelledBy() ? 'cancelled' : err instanceof StageTimeout ? 'timeout' : 'failed'
      const note = state === 'cancelled' ? `abgebrochen von ${cancelledBy()}` : (err as Error).message.slice(0, 300)
      stages[name] = { ...st, ran: false, failed: state !== 'cancelled', state, note, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, progress: undefined }
      if (state === 'cancelled') log.info('Scan-Stufe abgebrochen', { scan: runId, stage: name, dauerMs: Date.now() - t0 })
      else log.warn(state === 'timeout' ? 'Scan-Stufe: Zeitlimit' : 'Scan-Stufe gescheitert', { scan: runId, stage: name, dauerMs: Date.now() - t0, err: String(err) })
    } finally {
      clearTimeout(guard)
    }
    await save(true)
  }

  try {
    let rewrite: ((loc: string) => string) | null = null
    if (run.projectId) rewrite = await scanProject(run, stage, stages, labels)
    else await scanExternal(run, stage, stages, labels)
    await saving
    const by = cancelledBy()
    if (by) {
      await db.update(schema.scanRuns)
        .set({ status: 'cancelled', error: `Abgebrochen von ${by}`, finishedAt: new Date(), stages })
        .where(eq(schema.scanRuns.id, runId))
    } else {
      const findings = rewrite ? all.map((f) => ({ ...f, location: rewrite!(f.location) })) : all
      await finalize(run, findings, stages)
      if (run.projectId) for (const fn of doneListeners) fn(run.projectId)
    }
    log.info('Scan beendet', { scan: runId, status: by ? 'abgebrochen' : 'fertig', dauerMs: Date.now() - startedAt.getTime(), befunde: all.length })
  } catch (err) {
    await saving
    for (const [k, s] of Object.entries(stages)) if (s.state === 'waiting' || s.state === 'running') stages[k] = { ...s, state: 'cancelled', note: 'nicht gelaufen: Scan gescheitert' }
    await db
      .update(schema.scanRuns)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date(), stages })
      .where(eq(schema.scanRuns.id, runId))
    log.warn('Scan gescheitert', { scan: runId, dauerMs: Date.now() - startedAt.getTime(), err: String(err) })
  } finally {
    // Auf jedem Weg aufräumen: die Kopie des Quellcodes (kann Secrets
    // enthalten) und das Arbeitsverzeichnis des Scans (Review M6).
    if (run.deploymentId) await rm(scanSourceDir(run.deploymentId), { recursive: true, force: true }).catch(() => {})
    await rm(join(config.DATA_DIR, 'scan', run.id), { recursive: true, force: true }).catch(() => {})
  }
}

type StageFn = (name: string, fn: (onLogs: OnLogs) => Promise<StageResult>) => Promise<void>

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
  if (images.size === 0) stages['trivy-image'] = skipped('trivy-image', kind === 'compose' ? 'keine laufenden Compose-Dienste gefunden' : 'kein Image, statische Seite')
  if (images.size > 1) {
    // Compose mit mehreren Diensten: eine Stufe je Image, in Plan-Reihenfolge vorne
    const rest = { ...stages }
    for (const k of Object.keys(stages)) delete stages[k]
    for (const img of images) stages[`trivy-image ${img}`] = waiting('trivy-image')
    for (const [k, v] of Object.entries(rest)) if (k !== 'trivy-image') stages[k] = v
  }
  for (const img of images) await stage(images.size > 1 ? `trivy-image ${img}` : 'trivy-image', (onLogs) => trivyImage(run.id, img, network, scanLabels, onLogs))

  const src = sourceDirFor(run.deploymentId, kind, project.slug)
  if (src) await stage('trivy-source', (onLogs) => trivySource(run.id, src, network, scanLabels, onLogs))
  else stages['trivy-source'] = skipped('trivy-source', 'kein Quellordner: fertiges Image ohne Quellcode')

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
    // M8: Header über Caddy prüfen, wie Besucher sie sehen (mit ergänzten
    // Headern). Ohne Caddy-Route direkt am Container wie bisher.
    const probe = await probeTargetFor(project.id).catch(() => null)
    if (probe) {
      await stage('headers', () => headerCheckViaCaddy(probe.url, probe.secure))
      if (stages.headers?.ran) stages.headers.checked = 'über Caddy, wie Besucher die Seite sehen'
    } else {
      await stage('headers', () => headerCheck(target))
      if (stages.headers?.ran) stages.headers.checked = 'direkt am Container: Caddy bedient das Projekt nicht'
    }
    await stage(run.level === 'active' ? 'zap-full' : 'zap-baseline', (onLogs) => zap(run.id, target, scanLabels, run.level === 'active', onLogs))
    await stage('nuclei', (onLogs) => nuclei(run.id, target, scanLabels, onLogs))
    // TLS endet bei Caddy, nicht im Projekt-Container: geprüft würde für jedes
    // Projekt dieselbe Caddy-Konfiguration. Zertifikatsstatus: Systemseite (M4).
    stages.testssl = skipped('testssl', cf.tls() ? 'TLS endet zentral bei Caddy, siehe Systemseite' : 'nicht anwendbar: intern kein TLS')
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
  // Stufe 1 entfällt (SPEC): es gibt kein Image – steht schon im Plan.
  await stage('headers', () => headerCheck(target))
  await stage(run.level === 'active' ? 'zap-full' : 'zap-baseline', (onLogs) => zap(run.id, target, labels, run.level === 'active', onLogs))
  await stage('nuclei', (onLogs) => nuclei(run.id, target, labels, onLogs))
  await stage('testssl', (onLogs) => testssl(run.id, target, labels, onLogs))
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

  // M8: übernommene Vorschläge (Mit Claude lösen) bestätigen. Dynamisch
  // geladen: fix-service zieht die Deploy-Pipeline nach, die diese Datei lädt.
  if (run.projectId) {
    const { verifyFixesAfterScan } = await import('./fix-service.js')
    await verifyFixesAfterScan({
      projectId: run.projectId, deploymentId: run.deploymentId,
      // Alles, was der Scan noch findet (auch akzeptiert): nur Verschwundenes ist behoben
      openFingerprints: new Set(rows.map((r) => r.fingerprint)), checkedTools: toolsChecked(stages),
    }).catch((err) => log.warn('Vorschläge nach dem Scan nicht geprüft', { scan: run.id, err: String(err) }))
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

/* --- M8: Nachscan der Stufe «headers» ------------------------------------------------- */

type Status = 'open' | 'accepted' | 'fixed'

/**
 * Was ein Nachscan der Header im letzten Scan ändert. Rein: bekommt die
 * bisherigen Header-Befunde des Scans, die neu gefundenen (mit
 * Fingerabdruck) und die Akzeptanzen.
 * - nicht mehr gefunden und offen: behoben
 * - wieder gefunden, aber als behoben markiert (Regel entfernt): wieder offen
 *   bzw. akzeptiert
 * - neu: einfügen
 */
export function planHeaderRecheck(
  existing: { id: string; fingerprint: string; status: Status }[],
  found: (FindingInput & { fingerprint: string })[],
  accepted: Map<string, string>,
): { fix: string[]; reopen: { id: string; status: Status; acceptReason: string | null }[]; insert: (FindingInput & { fingerprint: string; status: Status; acceptReason: string | null })[] } {
  const now = new Set(found.map((f) => f.fingerprint))
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]))
  const fix = existing.filter((e) => e.status === 'open' && !now.has(e.fingerprint)).map((e) => e.id)
  const reopen: { id: string; status: Status; acceptReason: string | null }[] = []
  const insert: (FindingInput & { fingerprint: string; status: Status; acceptReason: string | null })[] = []
  for (const f of found) {
    const reason = accepted.get(f.fingerprint) ?? null
    const e = byFp.get(f.fingerprint)
    if (!e) insert.push({ ...f, status: reason ? 'accepted' : 'open', acceptReason: reason })
    else if (e.status === 'fixed') reopen.push({ id: e.id, status: reason ? 'accepted' : 'open', acceptReason: reason })
  }
  return { fix, reopen, insert }
}

/**
 * Header-Check erneut über Caddy und das Ergebnis in den letzten
 * abgeschlossenen Scan übernehmen (Score und Note neu). Ein eigener
 * Scan-Lauf nur mit Headern würde im «letzten Scan» die Befunde aller
 * anderen Werkzeuge verstecken.
 */
export async function recheckHeaders(projectId: string, actor: string): Promise<HeaderRecheckDto> {
  const none = (error: string): HeaderRecheckDto => ({ ok: false, error, fixed: [], opened: [], score: null, grade: null })
  const last = await latestScan(projectId, true)
  if (!last) return none('Noch kein abgeschlossener Scan; der nächste Scan prüft die Header')
  const probe = await probeTargetFor(projectId)
  if (!probe) return none('Caddy bedient das Projekt gerade nicht (gestoppt oder ohne Adresse)')
  let raw: FindingInput[]
  try {
    raw = await headerCheckViaCaddy(probe.url, probe.secure)
  } catch (err) {
    return none(`Header-Check über Caddy gescheitert: ${(err as Error).message.slice(0, 200)}`)
  }
  const found = dedupe(raw).map((f) => ({ ...f, fingerprint: fingerprint(f) }))
  const accepted = new Map(
    (await db.select().from(schema.findingAcceptances).where(eq(schema.findingAcceptances.projectId, projectId))).map((a) => [a.fingerprint, a.reason]),
  )
  const existing = await db.select().from(schema.findings).where(and(eq(schema.findings.scanRunId, last.id), eq(schema.findings.tool, 'header-check')))
  const plan = planHeaderRecheck(existing, found, accepted)
  // CSP-Fix: «Content-Security-Policy fehlt» gilt erst als behoben, wenn die
  // Funktionsprüfung im Browser die scharfe CSP bestanden hat
  const csp = (await db.select().from(schema.headerRules).where(and(eq(schema.headerRules.projectId, projectId), eq(schema.headerRules.header, 'content-security-policy'))))[0]
  if (csp?.mode === 'enforce' && csp.checkResult?.state !== 'ok') {
    const cspIds = new Set(existing.filter((e) => e.title.startsWith('Content-Security-Policy fehlt')).map((e) => e.id))
    plan.fix = plan.fix.filter((id) => !cspIds.has(id))
  }

  await db.transaction(async (tx) => {
    if (plan.fix.length) await tx.update(schema.findings).set({ status: 'fixed' }).where(inArray(schema.findings.id, plan.fix))
    for (const r of plan.reopen) await tx.update(schema.findings).set({ status: r.status, acceptReason: r.acceptReason }).where(eq(schema.findings.id, r.id))
    if (plan.insert.length) {
      await tx.insert(schema.findings).values(plan.insert.map(({ key: _k, ...f }) => ({ scanRunId: last.id, ...f })))
    }
    const open = await tx.select().from(schema.findings).where(and(eq(schema.findings.scanRunId, last.id), eq(schema.findings.status, 'open')))
    const s = score(open)
    const stages: ScanStages = {
      ...last.stages,
      // Bisherige Angaben der Stufe (was sie prüft) behalten, Ergebnis ersetzen
      headers: {
        ...(last.stages.headers ?? {}),
        ran: true, state: 'done', failed: undefined, findings: found.length, finishedAt: new Date().toISOString(),
        checked: 'über Caddy, wie Besucher die Seite sehen',
        note: `Nachscan über Caddy, ${new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        progress: undefined, tail: undefined,
      },
    }
    await tx.update(schema.scanRuns).set({ score: s, grade: grade(s), stages }).where(eq(schema.scanRuns.id, last.id))
  })

  const after = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, last.id)).limit(1))[0]!
  const fixedTitles = existing.filter((e) => plan.fix.includes(e.id)).map((e) => e.title)
  const openedTitles = [
    ...plan.insert.filter((f) => f.status === 'open').map((f) => f.title),
    ...existing.filter((e) => plan.reopen.some((r) => r.id === e.id && r.status === 'open')).map((e) => e.title),
  ]
  await audit({
    actor, action: 'scan.recheck_headers', targetType: 'project', targetId: projectId,
    params: { scan: last.id, fixed: fixedTitles, opened: openedTitles }, result: 'ok',
  })
  return { ok: true, error: null, fixed: fixedTitles, opened: openedTitles, score: after.score, grade: after.grade }
}

/* --- Lesen, Akzeptieren, Schwelle ----------------------------------------------------- */

export interface ScanReport {
  scan: {
    id: string; status: string; level: string; startedAt: string; finishedAt: string | null; score: number | null; grade: string | null; error: string | null; stages: ScanStages
    trigger: ScanTrigger | null; actor: string | null
    /** Nur solange der Scan wartet */
    queue: { position: number; ahead: number } | null
  }
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
      trigger: run.trigger ?? null, actor: run.actor ?? null,
      queue: run.status === 'queued' ? scanQueuePosition(run.id) : null,
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
