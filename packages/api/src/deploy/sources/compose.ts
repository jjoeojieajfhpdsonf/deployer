import { eq } from 'drizzle-orm'
import { join, posix } from 'node:path'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { db, schema } from '../../db/index.js'
import { config } from '../../config.js'
import { normalizeCompose, withServiceEnv, withMappedEnv, retargetCompose, type NormalizedCompose } from '../../lib/compose.js'
import { readRepoFile, resolveInRepo } from '../../lib/repo-files.js'
import { resolveEnv } from '../../domain/env.js'
import { projectMainUrl } from '../../domain/homebento.js'
import { badRequest } from '../../lib/errors.js'
import * as docker from '../../drivers/docker.js'
import { appendLine } from '../journal.js'
import { ensureArtifactDir } from '../workdir.js'
import { cloneForDeployment } from './repo.js'

type Project = typeof schema.projects.$inferSelect

export const COMPOSE_MAX_BYTES = 256 * 1024

export const composeUploadPath = (uploadId: string) => join(config.DATA_DIR, 'uploads', `${uploadId}.yaml`)

interface ComposeConfig {
  repoUrl?: string
  ref?: string
  composePath?: string
  uploadId?: string
  webService: string
}

/**
 * Holt die compose.yaml (Repo oder Upload), prüft und normalisiert sie und
 * legt die normalisierte Datei als Artefakt dieser Fassung ab. Die CLI sieht
 * nur diese Datei.
 */
export async function prepareCompose(
  project: Project,
  deploymentId: string,
  ref?: string,
  /** M3: bereits vorliegender Ordner (lokales Repo eines Chat-Projekts). */
  local?: { dir: string; commit: string; composePath: string; webService: string },
): Promise<{ file: string; normalized: NormalizedCompose; version: string }> {
  const cfg = (local
    ? { webService: local.webService, composePath: local.composePath }
    : project.sourceConfig) as ComposeConfig
  let text: string
  let version: string
  let repo: Parameters<typeof normalizeCompose>[1]['repo'] = null

  if (local || cfg.repoUrl) {
    const { dir, commit } = local ?? (await cloneForDeployment(project, deploymentId, ref ?? cfg.ref))
    const composePath = cfg.composePath ?? 'compose.yaml'
    text = await readRepoFile(dir, composePath, COMPOSE_MAX_BYTES)
    version = commit
    // Compose löst build und env_file relativ zum Ordner der Datei auf.
    const base = posix.dirname(composePath)
    const rel = (p: string) => posix.normalize(base === '.' ? p : `${base}/${p}`)
    repo = {
      resolvePath: (p) => resolveInRepo(dir, rel(p)),
      readFile: (p) => readRepoFile(dir, rel(p), 64 * 1024),
    }
  } else if (cfg.uploadId) {
    const rows = await db.select().from(schema.uploads).where(eq(schema.uploads.id, cfg.uploadId)).limit(1)
    const upload = rows[0]
    if (!upload || upload.kind !== 'compose') throw badRequest('Die hochgeladene compose.yaml wurde nicht gefunden')
    const path = composeUploadPath(upload.id)
    const st = await stat(path).catch(() => null)
    if (!st) throw badRequest('Die hochgeladene compose.yaml liegt nicht mehr auf der Platte')
    if (st.size > COMPOSE_MAX_BYTES) throw badRequest('compose.yaml ist zu gross')
    text = await readFile(path, 'utf8')
    version = upload.sha256.slice(0, 16)
  } else {
    throw badRequest('Compose braucht ein Repo oder eine hochgeladene compose.yaml')
  }

  appendLine(deploymentId, 'compose.yaml wird geprüft')
  const normalized = await normalizeCompose(text, {
    slug: project.slug,
    deploymentId,
    deploymentShort: deploymentId.replace(/-/g, '').slice(0, 12),
    webService: cfg.webService,
    network: docker.projectNetworkName(project.slug),
    memoryLimitMb: project.memoryLimitMb,
    cpuLimit: Number(project.cpuLimit),
    // Bewusst leer: das Artefakt bleibt ohne Secrets. Siehe materialize().
    projectEnv: {},
    repo,
    homebento: { projectName: project.name, href: await projectMainUrl(project) },
  })
  appendLine(deploymentId, `Geprüft: ${normalized.services.length} Dienste (${normalized.services.join(', ')})`)

  const dir = await ensureArtifactDir(deploymentId)
  const file = join(dir, 'compose.yaml')
  await writeFile(file, normalized.yaml, { mode: 0o600 })
  return { file, normalized, version }
}

/**
 * Datei für genau einen `compose up`: Artefakt plus aktuelle Projekt-Env im
 * Web-Dienst. Liegt im Arbeitsordner (0600) und wird danach gelöscht.
 */
export async function materialize(
  project: Project,
  artifactFile: string,
  webService: string,
  workDirPath: string,
): Promise<string> {
  // Ältere Artefakte (deployer-Zeit) tragen noch dep_<slug> und deployer.*-Labels.
  const text = retargetCompose(await readFile(artifactFile, 'utf8'), docker.projectNetworkName(project.slug))
  const env = await resolveEnv(project.id)
  // Etappe 4: x-airlock-env in allen Diensten (geheime Werte erst jetzt, nie im Artefakt)
  const withEnv = withMappedEnv(withServiceEnv(text, webService, env), env)
  await mkdir(workDirPath, { recursive: true })
  const path = join(workDirPath, 'compose.run.yaml')
  await writeFile(path, withEnv, { mode: 0o600 })
  return path
}

/* --- Übergang aus der deployer-Zeit (docs/RENAME.md) ------------------------------ */

/** Kleines Image für die Volume-Kopie (cp -a erhält Rechte und Besitzer). */
export const VOLUME_COPY_IMAGE = 'alpine:3.20'

/**
 * Läuft ein Compose-Projekt noch als dep_<slug> (deployer-Zeit), übernimmt
 * der erste Deploy unter Airlock seine Daten: alte Dienste stoppen (nicht
 * löschen), jedes benannte Volume dep_<slug>_<name> nach air_<slug>_<name>
 * kopieren. Die alten Volumes bleiben unangetastet (Rückweg). Gibt die IDs
 * der gestoppten Container zurück; leer, wenn nichts zu übernehmen war.
 */
export async function takeOverLegacyCompose(project: Project, deploymentId: string): Promise<string[]> {
  const legacy = (await docker.listManagedContainers()).filter(
    (c) => c.legacy && c.labels[docker.LABEL_PROJECT] === project.slug && c.labels[docker.LABEL.composeService],
  )
  if (!legacy.length) return []
  const from = docker.legacyNetworkName(project.slug)
  const to = docker.projectNetworkName(project.slug)
  appendLine(deploymentId, `Übergang: ${legacy.length} Dienst(e) aus der deployer-Zeit (${from}) werden gestoppt, ihre Volumes nach ${to}_… kopiert`)
  for (const c of legacy) await docker.stopContainer(c.id, 30)

  const volumes = await docker.listComposeVolumes(from)
  if (volumes.length) {
    await docker.ensureNetwork(to)
    await docker.pullImage(VOLUME_COPY_IMAGE)
  }
  for (const v of volumes) {
    const name = v.volume ?? v.name.slice(from.length + 1)
    const target = `${to}_${name}`
    if (!(await docker.volumeExists(target))) await docker.createComposeVolume(target, to, name)
    appendLine(deploymentId, `Volume ${v.name} → ${target}`)
    await copyVolume(project.slug, deploymentId, v.name, target)
  }
  return legacy.map((c) => c.id)
}

async function copyVolume(slug: string, deploymentId: string, source: string, target: string): Promise<void> {
  const network = docker.projectNetworkName(slug)
  const id = await docker.createAndStart({
    name: `${network}_volcopy_${deploymentId.replace(/-/g, '').slice(0, 10)}_${target.slice(network.length + 1).replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
    image: VOLUME_COPY_IMAGE,
    network,
    env: {},
    labels: { [docker.LABEL_MANAGED]: 'true', [docker.LABEL_PROJECT]: slug, [docker.LABEL.role]: 'volume-copy' },
    memoryLimitMb: 256,
    cpuLimit: 1,
    oneShot: true,
    // Ziel vorher leeren: ein abgebrochener früherer Versuch hätte sonst
    // veraltete Dateien hinterlassen. Massgeblich ist das alte Volume.
    cmd: ['sh', '-c', 'find /to -mindepth 1 -delete && cp -a /from/. /to/'],
    volumes: [
      { source, target: '/from', readOnly: true },
      { source: target, target: '/to' },
    ],
    extraVolumes: [{ name: source, readOnly: true }],
  })
  try {
    const r = await docker.waitForExit(id, 30 * 60_000)
    if (r.timedOut || r.exitCode !== 0) {
      const tail = await docker.getLogs(id, { tail: 20 }).catch(() => '')
      throw new Error(`Kopie ${source} → ${target} gescheitert (${r.timedOut ? 'Zeitlimit' : `Exit ${r.exitCode}`})${tail ? `: ${tail.trim()}` : ''}`)
    }
  } finally {
    await docker.removeContainer(id)
  }
}

/** Übergang gescheitert: neue Compose-Dienste weg, alte wieder starten. */
export async function restoreLegacyCompose(project: Project, deploymentId: string, legacyIds: string[]): Promise<void> {
  for (const c of await docker.listManagedContainers()) {
    if (c.legacy || c.labels[docker.LABEL_PROJECT] !== project.slug || !c.labels[docker.LABEL.composeService]) continue
    await docker.stopContainer(c.id).catch(() => {})
    await docker.removeContainer(c.id).catch(() => {})
  }
  for (const id of legacyIds) {
    await docker.startContainer(id).catch((e) => appendLine(deploymentId, `Alter Dienst ${id.slice(0, 12)} startet nicht: ${(e as Error).message}`))
  }
  appendLine(deploymentId, 'Übergang abgebrochen: die Dienste aus der deployer-Zeit laufen wieder')
}
