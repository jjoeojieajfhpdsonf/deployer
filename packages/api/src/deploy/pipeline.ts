import { eq, and, ne, desc } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, schema, tryLockProject } from '../db/index.js'
import type { DeploymentArtifact } from '../db/schema.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { composeUp, composePull } from '../drivers/compose-cli.js'
import { findProject, findProjectForServerJob, setStatus, setDesiredState, touchActivity } from '../domain/projects.js'
import { serverJob, type Scope } from '../lib/scope.js'
import { resolveEnv } from '../domain/env.js'
import { reconcileCaddy } from '../domain/routes.js'
import { audit } from '../domain/audit.js'
import { toDeploymentDto, getDeployment, canRollbackTo, effectiveKind } from '../domain/deployments.js'
import { appendLine, emitStatus, emitDone, logPathFor } from './journal.js'
import { waitForHealthy } from './healthcheck.js'
import { withProjectNetwork } from './attach.js'
import { prepareImage, startImageContainer } from './sources/image.js'
import { prepareStatic, prepareStaticFromDir, activateStatic, siteDir } from './sources/static.js'
import { buildFromRepo, buildFromDir } from './sources/dockerfile.js'
import { checkoutFiles, KIND_LABEL, localRepoPath, type FilesConfig } from './sources/files.js'
import { commitSubjectOf } from '../lib/local-repo.js'
import { deriveReason } from '../domain/deploy-reason.js'
import { reasonEvents } from '../domain/deployments.js'
import { prepareCompose, materialize, takeOverLegacyCompose, restoreLegacyCompose } from './sources/compose.js'
import { dropWorkDir, dropArtifactDir, workDir, ensureArtifactDir } from './workdir.js'
import { copyFile, rm, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { enqueueProjectScan, scanSourceDir } from '../security/scan.js'
import { notify } from '../notify/send.js'
import { conflict, badRequest, AppError } from '../lib/errors.js'
import { log } from '../lib/log.js'
import type { DeploymentDto, DeployReason } from '@airlock/shared'
import { isOwnImage } from '../lib/names.js'

/** Wie viele erfolgreiche Fassungen pro Projekt für ein Rollback aufgehoben werden. */
export const KEEP_VERSIONS = 5
/** Wie viele fehlgeschlagene Versuche (wegen ihrer Logs) aufgehoben werden. */
export const KEEP_FAILED = 10

type Project = typeof schema.projects.$inferSelect
type Deployment = typeof schema.deployments.$inferSelect

type Job =
  | { kind: 'deploy'; ref?: string }
  /** recreate: dieselbe Fassung neu anlegen (Übergang deployer → Airlock) */
  | { kind: 'rollback'; target: Deployment; recreate?: boolean }

/**
 * Startet einen Deploy und kehrt sofort zurück. Der Fortschritt läuft über
 * SSE (deploy/journal.ts).
 *
 * Die Sperre gegen parallele Deploys ist ein Postgres Advisory Lock:
 * sitzungsweit (ein Deploy dauert Minuten und umfasst viele Transaktionen),
 * nicht blockierend (der zweite Aufruf bekommt sofort 409) und selbstheilend
 * (stirbt der Prozess, gibt Postgres den Lock frei). Rollbacks benutzen
 * dieselbe Sperre.
 */
/** reason: Grund statt der Ableitung; via 'mcp': Auslöser wird als «mcp:<Token>» gespeichert (Claude-Symbol in der Liste) */
type StartOptions = { reason?: DeployReason; via?: 'mcp' }

export async function startDeploy(scope: Scope, idOrSlug: string, actor: string, ref?: string, o: StartOptions = {}): Promise<DeploymentDto> {
  return startJob(await findProject(scope, idOrSlug), actor, { kind: 'deploy', ref }, o)
}

/** Ohne Angabe: die zuletzt aktive Fassung vor der jetzigen. */
export async function startRollback(scope: Scope, idOrSlug: string, actor: string, deploymentId?: string, o: StartOptions = {}): Promise<DeploymentDto> {
  const project = await findProject(scope, idOrSlug)
  const target = deploymentId ? await getDeployment(deploymentId) : await previousGood(project.id)
  if (!target || target.projectId !== project.id) throw badRequest('Keine frühere Fassung für ein Rollback gefunden')
  if (target.isActive) throw badRequest('Diese Fassung ist bereits aktiv')
  if (!canRollbackTo(target)) {
    throw badRequest('Auf diese Fassung lässt sich nicht zurückrollen (fehlgeschlagen oder Artefakt entfernt)')
  }
  return startJob(project, actor, { kind: 'rollback', target }, o)
}

/**
 * «Neu erstellen» (Übergang, docs/RENAME.md): die aktive Fassung genau so
 * noch einmal anlegen – gleiches Image, gleiche Compose-Datei, aber mit
 * airlock.*-Labels im Netz air_<slug>. Technisch ein Rollback auf die
 * aktive Fassung; die alten Container aus der deployer-Zeit fallen danach weg.
 */
export async function startRecreate(scope: Scope, idOrSlug: string, actor: string): Promise<DeploymentDto> {
  const project = await findProject(scope, idOrSlug)
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, project.id), eq(schema.deployments.isActive, true)))
    .limit(1)
  const target = rows[0]
  if (!target) throw badRequest('Keine aktive Fassung, die neu erstellt werden könnte – bitte neu deployen')
  const a = target.artifact ?? {}
  if (!target.imageRef && !a.composeFile) {
    throw badRequest('Diese Fassung hat kein Image und keine Compose-Datei mehr – bitte neu deployen')
  }
  return startJob(project, actor, { kind: 'rollback', target, recreate: true })
}

async function previousGood(projectId: string): Promise<Deployment | null> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.status, 'superseded')))
    .orderBy(desc(schema.deployments.finishedAt))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Grund beim Start: ausdrücklich übergeben (Auto-Deploy), sonst aus dem, was
 * seit dem vorherigen Deployment im Audit-Log steht (domain/deploy-reason.ts).
 */
async function reasonAtStart(project: Project, actor: string, job: Job, explicit?: DeployReason): Promise<DeployReason> {
  if (explicit) return explicit
  const prev = (await db
    .select({ startedAt: schema.deployments.startedAt })
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, project.id))
    .orderBy(desc(schema.deployments.startedAt))
    .limit(1))[0]
  const events = prev ? await reasonEvents(project.id, prev.startedAt, new Date()) : []
  return deriveReason({ trigger: job.kind, recreate: job.kind === 'rollback' && job.recreate, actor, isFirst: !prev, events })
}

async function startJob(project: Project, actor: string, job: Job, o: StartOptions = {}): Promise<DeploymentDto> {
  const lock = await tryLockProject(project.id)
  if (!lock) throw conflict('Für dieses Projekt läuft bereits ein Deploy')

  try {
    const reason = await reasonAtStart(project, actor, job, o.reason).catch((err) => {
      log.warn('Grund des Deployments nicht bestimmt', { project: project.slug, err: String(err) })
      return { kind: job.kind === 'rollback' ? 'rollback' : 'redeploy', detail: null } as DeployReason
    })
    const inserted = await db
      .insert(schema.deployments)
      .values({
        projectId: project.id,
        sourceRef: job.kind === 'deploy' ? (job.ref ?? null) : (job.target.sourceRef ?? null),
        status: 'pending',
        trigger: job.kind,
        rollbackOf: job.kind === 'rollback' ? job.target.id : null,
        reason,
        actor: o.via === 'mcp' ? actor.replace(/^token:/, 'mcp:') : actor,
        // Rollback: dieselbe Fassung, derselbe Commit-Betreff
        message: job.kind === 'rollback' ? job.target.message : null,
      })
      .returning()
    const row = inserted[0]!
    await setDeployment(row.id, { logRef: logPathFor(row.id) })
    // Deploy und Rollback sind Aktivität (Ablauf von Chat-Projekten).
    await touchActivity(project.id)

    // Bewusst nicht awaiten: die API antwortet sofort. run() gibt den Lock
    // selbst frei, sobald der Endstatus geschrieben ist; das finally ist nur
    // die Absicherung (release ist idempotent).
    void run(project.id, row.id, actor, job, lock).finally(() => void lock.release())
    return toDeploymentDto({ ...row, logRef: logPathFor(row.id) })
  } catch (err) {
    await lock.release()
    throw err
  }
}

async function setDeployment(id: string, values: Partial<typeof schema.deployments.$inferInsert>): Promise<void> {
  await db.update(schema.deployments).set(values).where(eq(schema.deployments.id, id))
}

/**
 * Reihenfolge am Ende, bewusst so:
 *   umschalten (DB) -> Caddy neu laden -> alte Container weg -> aufräumen
 *   -> Endstatus schreiben -> Lock frei -> Ereignis, Audit.
 * Wer auf "active" wartet und sofort neu deployt, bekommt damit kein 409
 * mehr, weil der Lock unmittelbar nach dem Endstatus frei wird.
 */
async function run(
  projectId: string,
  deploymentId: string,
  actor: string,
  job: Job,
  lock: { release(): Promise<void> },
): Promise<void> {
  const started = Date.now()
  const action = job.kind === 'rollback' ? (job.recreate ? 'project.recreate' : 'project.rollback') : 'project.deploy'
  const params = job.kind === 'rollback'
    ? { deployment: deploymentId, rollbackOf: job.target.id }
    : { deployment: deploymentId, ref: job.ref }
  // Für den Fall, dass nach dem Umschalten in der DB Caddy nicht nachzieht.
  const previousActive = (await db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.isActive, true)))
    .limit(1))[0]?.id ?? null
  try {
    await setStatus(projectId, 'deploying')
    const project = await findProjectForServerJob(projectId)
    appendLine(
      deploymentId,
      job.kind === 'rollback'
        ? job.recreate
          ? `"${project.name}" wird neu erstellt (Fassung ${job.target.version ?? job.target.id}, Namen von Airlock)`
          : `Rollback von "${project.name}" auf Fassung ${job.target.version ?? job.target.id} gestartet`
        : `Deploy von "${project.name}" (${project.sourceType}) gestartet`,
    )

    switch (project.sourceType) {
      case 'image':
        await runImage(deploymentId, project, job)
        break
      case 'dockerfile':
        await runDockerfile(deploymentId, project, job)
        break
      case 'static':
        await runStatic(deploymentId, project, job)
        break
      case 'compose':
        await runCompose(deploymentId, project, job)
        break
      case 'files':
        await runFiles(deploymentId, project, job)
        break
      default:
        throw badRequest(`Quelle "${project.sourceType}" kommt erst in einem späteren Meilenstein`)
    }

    await setDesiredState(projectId, 'running')

    // Erst jetzt den Verkehr umschalten. Bis hierher lief die alte Fassung.
    try {
      await reconcileCaddy()
      appendLine(deploymentId, 'Route aktiv')
    } catch (err) {
      const kind = effectiveKind(project.sourceType, (await getDeployment(deploymentId)).artifact)
      if (kind === 'image' || kind === 'dockerfile') {
        // Neuer Container, neuer Upstream: Caddy hat die alte Konfiguration
        // behalten, der alte Container läuft noch. In der DB die vorherige
        // Fassung wieder aktiv setzen und den Deploy scheitern lassen.
        if (previousActive) {
          await markActiveExclusively(projectId, previousActive)
          await setDeployment(previousActive, { status: 'active' })
        }
        throw err
      }
      // Statisch und Compose: die neue Fassung ist bereits ausgeliefert
      // (Symlink umgehängt bzw. Dienste an Ort und Stelle ersetzt), und der
      // Upstream heisst gleich wie vorher. Zurückdrehen in der DB wäre
      // falsch. Der nächste Abgleich lädt Caddy erneut.
      appendLine(deploymentId, `Warnung: Caddy konnte nicht neu geladen werden (${(err as Error).message}); die neue Fassung ist trotzdem aktiv`)
      log.warn('Caddy-Abgleich nach Deploy gescheitert', { projectId, deploymentId, err: String(err) })
    }

    // Läuft die neue Fassung nicht (mehr) als Compose – etwa ein Chat-Projekt,
    // das jetzt ein Dockerfile hat –, müssen auch die Compose-Dienste weg.
    const newKind = effectiveKind(project.sourceType, (await getDeployment(deploymentId)).artifact)
    await removeSupersededContainers(project.slug, deploymentId, { includeCompose: newKind !== 'compose' })
    await pruneOldDeployments(projectId)

    // M6: Quellordner für den Scan aufheben (der Scan räumt ihn danach weg).
    const repoDir = join(workDir(deploymentId), 'repo')

    // Betreff des Commits für die Deployments-Liste (Chat-Projekt: lokales Repo, sonst der Klon)
    if (job.kind === 'deploy') {
      const version = (await getDeployment(deploymentId)).version
      const dir = project.sourceType === 'files' ? (project.localRepoPath ?? localRepoPath(project.slug)) : repoDir
      const subject = version ? await commitSubjectOf(dir, version) : null
      if (subject) await setDeployment(deploymentId, { message: subject })
    }
    if (config.SCAN_AFTER_DEPLOY && existsSync(repoDir)) {
      await mkdir(dirname(scanSourceDir(deploymentId)), { recursive: true })
      await rename(repoDir, scanSourceDir(deploymentId)).catch(() => {})
    }

    appendLine(deploymentId, `Fertig in ${Math.round((Date.now() - started) / 1000)} s`)
    await setStatus(projectId, 'running')
    await setDeployment(deploymentId, { status: 'active', isActive: true, finishedAt: new Date() })
    await lock.release()
    emitDone(deploymentId, true)
    await audit({ actor, action, targetType: 'project', targetId: projectId, params, result: 'ok' })

    // M6: automatischer Scan nach jedem erfolgreichen Deploy, im Hintergrund.
    if (config.SCAN_AFTER_DEPLOY) {
      await enqueueProjectScan(serverJob('scan-nach-deploy'), projectId, { deploymentId, actor, trigger: 'deploy' }).catch(async (e) => {
        log.warn('Scan nach Deploy nicht gestartet', { projectId, err: String(e) })
        await rm(scanSourceDir(deploymentId), { recursive: true, force: true }).catch(() => {})
      })
    }
  } catch (err) {
    const message = (err as Error).message
    appendLine(deploymentId, `FEHLGESCHLAGEN: ${message}`)
    await cleanupFailed(projectId, deploymentId)
    await setDeployment(deploymentId, { status: 'failed', errorMessage: message, finishedAt: new Date(), isActive: false })

    // Die vorherige Fassung läuft weiter; das Projekt ist nur dann "failed",
    // wenn es überhaupt keine aktive Fassung mehr gibt.
    const stillActive = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.isActive, true)))
      .limit(1)
    await setStatus(projectId, stillActive.length ? 'running' : 'failed')

    await lock.release()
    emitDone(deploymentId, false)
    log.error('Deploy fehlgeschlagen', { projectId, deploymentId, err: message })
    await audit({ actor, action, targetType: 'project', targetId: projectId, params, result: 'error', error: message })
    // M6: Push laut Standard der SPEC. Die Meldung enthält nur Projekt und Fehlertext.
    const p = await findProjectForServerJob(projectId).catch(() => null)
    await notify('deploy_failed', { project: p?.name ?? projectId, error: message.slice(0, 300) })
  } finally {
    await dropWorkDir(deploymentId)
  }
}

/* --- Image und Dockerfile: neuer Container, Healthcheck, Umschalten ---------- */

async function runImage(deploymentId: string, project: Project, job: Job): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  let imageRef: string
  let version: string | null
  if (job.kind === 'rollback') {
    imageRef = job.target.imageRef!
    version = job.target.version
    if (!(await docker.imageExists(imageRef))) {
      appendLine(deploymentId, `Image ${imageRef} wird erneut geholt`)
      await docker.pullImage(imageRef)
    }
  } else {
    const prepared = await prepareImage(project, deploymentId, job.ref)
    // Der Container läuft auf dem Digest, nicht auf dem Tag: genau diese
    // Fassung, und ein Rollback findet sie wieder.
    imageRef = prepared.version
    version = prepared.version
  }
  await setDeployment(deploymentId, { status: 'pulling', version, imageRef })
  await startAndCheck(deploymentId, project, imageRef)
}

/**
 * Die Runner für dockerfile, static und compose nehmen optional eine eigene
 * Vorbereitung und Zusatzangaben fürs Artefakt. So läuft ein Chat-Projekt
 * (Quelle files, M3) durch genau dieselben Wege wie ein Repo-Projekt.
 */
type Extra = Partial<DeploymentArtifact>

async function runDockerfile(
  deploymentId: string,
  project: Project,
  job: Job,
  build: () => Promise<{ imageTag: string; commit: string }> = () => buildFromRepo(project, deploymentId, job.kind === 'deploy' ? job.ref : undefined),
  extra: Extra = {},
): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  let imageRef: string
  let version: string | null
  let builtImages: string[] = []
  if (job.kind === 'rollback') {
    imageRef = job.target.imageRef!
    version = job.target.version
    if (!(await docker.imageExists(imageRef))) {
      throw new AppError('rollback_unavailable', `Das Image der Fassung (${imageRef}) gibt es nicht mehr`, 400)
    }
  } else {
    const built = await build()
    imageRef = built.imageTag
    version = built.commit
    builtImages = [built.imageTag]
  }
  await setDeployment(deploymentId, { status: 'pulling', version, imageRef, artifact: { builtImages, ...extra } })
  await startAndCheck(deploymentId, project, imageRef)
}

/* --- Chat-Projekte (Quelle files, M3) ------------------------------------------ */

async function runFiles(deploymentId: string, project: Project, job: Job): Promise<void> {
  const cfg = project.sourceConfig as FilesConfig
  const webService = cfg.webService ?? 'web'

  if (job.kind === 'rollback') {
    const kind = job.target.artifact?.filesKind
    if (!kind) throw new AppError('rollback_unavailable', 'Unbekannt, als was diese Fassung lief', 400)
    const extra = { filesKind: kind }
    if (kind === 'dockerfile') return runDockerfile(deploymentId, project, job, undefined, extra)
    if (kind === 'compose') return runCompose(deploymentId, project, job, undefined, extra, webService)
    return runStatic(deploymentId, project, job, undefined, extra)
  }

  emitStatus(deploymentId, 'pulling')
  const co = await checkoutFiles(project, deploymentId, job.ref)
  const extra = { filesKind: co.kind }
  if ((co.kind === 'dockerfile' || co.kind === 'compose') && !project.port) {
    throw badRequest(`Als ${KIND_LABEL[co.kind]} braucht das Projekt einen Port im Container (port setzen)`)
  }
  switch (co.kind) {
    case 'dockerfile':
      return runDockerfile(deploymentId, project, job, async () => ({
        imageTag: await buildFromDir(project, deploymentId, co.dir, {}),
        commit: co.commit,
      }), extra)
    case 'compose':
      return runCompose(deploymentId, project, job, () => prepareCompose(project, deploymentId, undefined, {
        dir: co.dir, commit: co.commit, composePath: co.composePath!, webService,
      }), extra, webService)
    case 'static-build':
      return runStatic(deploymentId, project, job, () => prepareStaticFromDir(project, deploymentId, co.dir, co.commit, {
        buildCommand: cfg.buildCommand ?? 'npm run build',
        outputDir: cfg.outputDir,
      }), extra)
    case 'static':
      return runStatic(deploymentId, project, job, () => prepareStaticFromDir(project, deploymentId, co.dir, co.commit, {
        outputDir: cfg.outputDir,
      }), extra)
  }
}

async function startAndCheck(deploymentId: string, project: Project, imageRef: string): Promise<void> {
  emitStatus(deploymentId, 'starting')
  const env = await resolveEnv(project.id)
  const { containerId, containerName, network } = await startImageContainer({ project, deploymentId, image: imageRef, env })
  await setDeployment(deploymentId, { status: 'starting', containerId })

  const ok = await healthcheck(deploymentId, network, containerName, project)
  if (!ok) {
    const tail = await docker.getLogs(containerId, { tail: 30 }).catch(() => '')
    if (tail) appendLine(deploymentId, `Letzte Container-Ausgabe:\n${tail}`)
    await docker.stopContainer(containerId)
    await docker.removeContainer(containerId)
    throw new Error('Healthcheck nicht bestanden')
  }
  await markActiveExclusively(project.id, deploymentId)
}

/**
 * Airlock hängt sich NUR für den Healthcheck ins Projekt-Netz und löst
 * sich danach wieder. Das disconnect steht im finally, damit ein
 * fehlgeschlagener Healthcheck die Verbindung nicht stehen lässt.
 */
async function healthcheck(deploymentId: string, network: string, host: string, project: Project): Promise<boolean> {
  emitStatus(deploymentId, 'healthchecking')
  const url = `http://${host}:${project.port}${project.healthcheckPath}`
  appendLine(deploymentId, `Healthcheck gegen ${url}`)
  // withProjectNetwork zählt mit: ein gleichzeitiger Scan (M6) behält seine
  // Verbindung, wenn dieser Healthcheck endet.
  const ok = await withProjectNetwork(network, async () => {
    const result = await waitForHealthy({
      url,
      timeoutMs: 60_000,
      onAttempt: (n, detail) => {
        if (n === 1 || n % 5 === 0 || detail.includes('bereit')) appendLine(deploymentId, `Healthcheck ${n}: ${detail}`)
      },
    })
    if (!result.ok) {
      appendLine(deploymentId, `Healthcheck nach ${result.attempts} Versuchen nicht bestanden (${result.lastError ?? 'keine Antwort'})`)
    }
    return result.ok
  })
  appendLine(deploymentId, 'Healthcheck beendet, Netzverbindung von Airlock freigegeben')
  return ok
}

/* --- Statisch ------------------------------------------------------------------- */

async function runStatic(
  deploymentId: string,
  project: Project,
  job: Job,
  prepare: () => Promise<{ version: string }> = () => prepareStatic(project, deploymentId, job.kind === 'deploy' ? job.ref : undefined),
  extra: Extra = {},
): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  let version: string
  if (job.kind === 'rollback') {
    version = job.target.artifact?.siteVersion ?? job.target.version ?? ''
    if (!version || !existsSync(join(siteDir(project.slug), version))) {
      throw new AppError('rollback_unavailable', 'Der Versionsordner dieser Fassung ist nicht mehr vorhanden', 400)
    }
  } else {
    version = (await prepare()).version
  }
  await setDeployment(deploymentId, { status: 'pulling', version, artifact: { siteVersion: version, ...extra } })

  emitStatus(deploymentId, 'starting')
  await activateStatic(project, version, deploymentId)
  await markActiveExclusively(project.id, deploymentId)
}

/* --- Compose: an Ort und Stelle, mit Rückfall auf die vorherige Datei ------------ */

/**
 * Kein Umschalten ohne Ausfall: ein zweites Compose-Projekt würde die
 * benannten Volumes gleichzeitig benutzen. `up -d` an Ort und Stelle
 * startet nur geänderte Dienste neu. Scheitert der Healthcheck, wird die
 * vorherige Datei wieder hochgefahren.
 */
async function runCompose(
  deploymentId: string,
  project: Project,
  job: Job,
  prepare: () => ReturnType<typeof prepareCompose> = () => prepareCompose(project, deploymentId, job.kind === 'deploy' ? job.ref : undefined),
  extra: Extra = {},
  webServiceOverride?: string,
): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  const cfg = { webService: webServiceOverride ?? (project.sourceConfig as { webService: string }).webService }
  let artifactFile: string
  let webContainer: string
  let builtImages: string[] = []
  let version: string | null

  if (job.kind === 'rollback') {
    const from = job.target.artifact?.composeFile
    if (!from || !existsSync(from)) {
      throw new AppError('rollback_unavailable', 'Die Compose-Datei dieser Fassung ist nicht mehr vorhanden', 400)
    }
    // Kopie ins eigene Artefakt: das Original verschwindet, wenn die alte
    // Fassung aus der Aufbewahrung fällt.
    artifactFile = join(await ensureArtifactDir(deploymentId), 'compose.yaml')
    await copyFile(from, artifactFile)
    // Fassungen aus der deployer-Zeit hiessen dep_<slug>-…; materialize()
    // startet sie jetzt unter air_<slug> (Übergang, docs/RENAME.md).
    webContainer = job.target.artifact!.webContainer!.replace(/^dep_/, 'air_')
    builtImages = job.target.artifact?.builtImages ?? []
    version = job.target.version
  } else {
    const prepared = await prepare()
    artifactFile = prepared.file
    webContainer = prepared.normalized.webContainer
    builtImages = prepared.normalized.builtImages
    version = prepared.version
  }
  await setDeployment(deploymentId, {
    status: 'starting',
    version,
    artifact: { composeFile: artifactFile, webContainer, builtImages, ...extra },
  })

  emitStatus(deploymentId, 'starting')
  const network = docker.projectNetworkName(project.slug)
  await docker.ensureNetwork(network)
  const previous = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, project.id), eq(schema.deployments.isActive, true)))
    .limit(1)

  // Übergang: läuft das Projekt noch als dep_<slug>, Daten zuerst übernehmen.
  const legacyIds = await takeOverLegacyCompose(project, deploymentId).catch(async (err) => {
    // Kopie gescheitert: alte Dienste laufen wieder, nichts ist umgestellt.
    const stopped = (await docker.listManagedContainers()).filter((c) => c.legacy && c.labels[docker.LABEL_PROJECT] === project.slug && !c.running)
    await restoreLegacyCompose(project, deploymentId, stopped.map((c) => c.id))
    throw err
  })

  try {
    await upWithEnv(deploymentId, project, artifactFile, cfg.webService, { pull: job.kind === 'deploy' })
  } catch (err) {
    if (legacyIds.length) await restoreLegacyCompose(project, deploymentId, legacyIds)
    throw err
  }

  const ok = await healthcheck(deploymentId, network, webContainer, project)
  if (!ok) {
    const tail = await docker.getLogs(webContainer, { tail: 30 }).catch(() => '')
    if (tail) appendLine(deploymentId, `Letzte Ausgabe von ${cfg.webService}:\n${tail}`)
    const prevFile = previous[0]?.artifact?.composeFile
    if (legacyIds.length) {
      await restoreLegacyCompose(project, deploymentId, legacyIds)
    } else if (prevFile && existsSync(prevFile)) {
      appendLine(deploymentId, 'Vorherige Fassung wird wieder hochgefahren')
      await upWithEnv(deploymentId, project, prevFile, cfg.webService).catch((e) =>
        appendLine(deploymentId, `Rückfall gescheitert: ${(e as Error).message}`),
      )
    }
    throw new Error('Healthcheck nicht bestanden')
  }
  await markActiveExclusively(project.id, deploymentId)
}

async function upWithEnv(
  deploymentId: string,
  project: Project,
  artifactFile: string,
  webService: string,
  o: { pull?: boolean } = {},
): Promise<void> {
  const runFile = await materialize(project, artifactFile, webService, workDir(deploymentId))
  try {
    if (o.pull) {
      // Neuer Deploy: veränderliche Tags (:latest) frisch holen. Rollback und
      // Rückfall nicht – die sollen genau das Image von damals bekommen.
      appendLine(deploymentId, 'docker compose pull')
      await composePull(docker.projectNetworkName(project.slug), runFile, (l) => appendLine(deploymentId, l))
    }
    appendLine(deploymentId, 'docker compose up')
    await composeUp(docker.projectNetworkName(project.slug), runFile, (l) => appendLine(deploymentId, l))
  } finally {
    // Die Datei enthält Secrets im Klartext; sie lebt nur für diesen Aufruf.
    await rm(runFile, { force: true })
  }
}

/* --- Gemeinsames ------------------------------------------------------------------ */

/**
 * Setzt dieses Deployment aktiv und alle anderen auf superseded – in einer
 * Transaktion, weil der partielle Unique-Index sonst zuschlägt.
 */
async function markActiveExclusively(projectId: string, deploymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.deployments)
      .set({ isActive: false, status: 'superseded' })
      .where(and(
        eq(schema.deployments.projectId, projectId),
        eq(schema.deployments.isActive, true),
        ne(schema.deployments.id, deploymentId),
      ))
    await tx.update(schema.deployments).set({ isActive: true }).where(eq(schema.deployments.id, deploymentId))
  })
}

/**
 * Container alter Fassungen entfernen; die Images bleiben für ein Rollback.
 * Compose-Dienste nur, wenn die neue Fassung nicht mehr als Compose läuft –
 * sonst verwaltet Compose sie an Ort und Stelle. Benannte Volumes bleiben
 * in jedem Fall (darin liegen Daten).
 */
async function removeSupersededContainers(
  slug: string,
  keepDeploymentId: string,
  o: { includeCompose?: boolean } = {},
): Promise<void> {
  const managed = await docker.listManagedContainers()
  let legacy = false
  for (const c of managed) {
    if (c.labels[docker.LABEL_PROJECT] !== slug) continue
    // Laufende Scanner (M6) gehören keiner Fassung; sie räumen sich selbst weg.
    if (c.labels[docker.LABEL.role] === 'scanner') continue
    // Übergang: nach einem erfolgreichen Deploy ist alles aus der
    // deployer-Zeit abgelöst, auch Compose-Dienste (ihre Daten sind kopiert).
    if (c.legacy) {
      legacy = true
    } else {
      if (c.labels[docker.LABEL.composeService] && !o.includeCompose) continue
      if (c.labels[docker.LABEL_DEPLOYMENT] === keepDeploymentId) continue
    }
    await docker.stopContainer(c.id)
    await docker.removeContainer(c.id)
  }
  if (legacy) {
    await dropLegacyNetwork(slug)
    await docker.legacyState().catch(() => {}) // Anzeige «Neu erstellen» sofort aktuell
  }
}

/** Netz dep_<slug> nach dem Übergang lösen und entfernen (Volumes bleiben). */
export async function dropLegacyNetwork(slug: string): Promise<void> {
  const net = docker.legacyNetworkName(slug)
  await docker.disconnectFromNetwork(net, config.CADDY_CONTAINER).catch(() => {})
  await docker.disconnectFromNetwork(net, config.AIRLOCK_CONTAINER).catch(() => {})
  await docker.removeNetwork(net).catch((err) => log.warn('Altes Projekt-Netz nicht entfernt', { net, err: String(err) }))
}

/** Nach einem Fehlschlag: alles entfernen, was dieser Versuch angelegt hat. */
async function cleanupFailed(projectId: string, deploymentId: string): Promise<void> {
  try {
    const managed = await docker.listManagedContainers()
    for (const c of managed) {
      if (!c.legacy && c.labels[docker.LABEL_DEPLOYMENT] === deploymentId && !c.labels[docker.LABEL.composeService]) {
        await docker.stopContainer(c.id)
        await docker.removeContainer(c.id)
      }
    }
    const project = await findProjectForServerJob(projectId)
    await docker.disconnectFromNetwork(docker.projectNetworkName(project.slug), config.AIRLOCK_CONTAINER)
    // Gebaute Images eines gescheiterten Versuchs braucht niemand – aber nur,
    // wenn er sie selbst gebaut hat. Ein Rollback trägt die Images seines
    // Ziels im Artefakt; die gehören einer aufbewahrten Fassung und bleiben.
    const d = await getDeployment(deploymentId).catch(() => null)
    if (d?.trigger === 'deploy') {
      for (const img of d.artifact?.builtImages ?? []) await docker.removeImageIfUnused(img)
      if (effectiveKind(project.sourceType, d.artifact) === 'compose') await dropArtifactDir(deploymentId)
    }
  } catch (err) {
    log.warn('Aufräumen nach Fehlschlag unvollständig', { deploymentId, err: String(err) })
  }
}

/**
 * Aufbewahrung: die aktive Fassung, die letzten KEEP_VERSIONS erfolgreichen
 * und die letzten KEEP_FAILED übrigen (wegen ihrer Logs). Was herausfällt,
 * verliert Zeile, Artefakt-Ordner und gebaute Images – ausser ein
 * aufbewahrter Eintrag verweist noch auf dasselbe Image (Rollbacks teilen es).
 */
export async function pruneOldDeployments(projectId: string): Promise<void> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
    .orderBy(desc(schema.deployments.startedAt))

  const keep = new Set<string>()
  let good = 0
  let other = 0
  for (const r of rows) {
    if (r.isActive) keep.add(r.id)
    else if (r.status === 'superseded') { if (good++ < KEEP_VERSIONS) keep.add(r.id) }
    else if (r.status === 'pending' || r.status === 'pulling' || r.status === 'starting' || r.status === 'healthchecking') keep.add(r.id)
    else if (other++ < KEEP_FAILED) keep.add(r.id)
  }

  const imagesInUse = new Set<string>()
  for (const r of rows) {
    if (!keep.has(r.id)) continue
    if (r.imageRef) imagesInUse.add(r.imageRef)
    for (const i of (r.artifact as DeploymentArtifact)?.builtImages ?? []) imagesInUse.add(i)
  }

  for (const r of rows) {
    if (keep.has(r.id)) continue
    const a = (r.artifact ?? {}) as DeploymentArtifact
    for (const img of [...(a.builtImages ?? []), ...(r.imageRef && isOwnImage(r.imageRef) ? [r.imageRef] : [])]) {
      if (!imagesInUse.has(img)) await docker.removeImageIfUnused(img).catch(() => {})
    }
    await dropArtifactDir(r.id)
    await rm(scanSourceDir(r.id), { recursive: true, force: true }).catch(() => {})
    await db.delete(schema.deployments).where(eq(schema.deployments.id, r.id))
  }
}
