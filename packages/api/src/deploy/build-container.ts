import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import * as docker from '../drivers/docker.js'
import { extractTarSafely } from '../lib/untar.js'
import { resolveInRepo } from '../lib/repo-files.js'
import { AppError } from '../lib/errors.js'
import { appendLine } from './journal.js'
import { packDir } from './workdir.js'
import { BUILD_MEMORY_MB, BUILD_TIMEOUT_MS } from './sources/dockerfile.js'

/**
 * Statischer Build in einem Wegwerf-Container, ohne Bind-Mount:
 * Repo per PUT /archive hinein, Ausgabe per GET /archive heraus, und die
 * Ausgabe wird mit denselben Regeln wie ein ZIP entpackt – sie stammt aus
 * einem fremden Build-Skript.
 */

export const BUILD_IMAGE = 'node:22-alpine'

/** Installation passend zum Lockfile. */
export function installCommand(repoDir: string): string {
  if (existsSync(join(repoDir, 'pnpm-lock.yaml'))) return 'corepack enable && pnpm install --frozen-lockfile'
  if (existsSync(join(repoDir, 'yarn.lock'))) return 'corepack enable && yarn install --frozen-lockfile'
  if (existsSync(join(repoDir, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(repoDir, 'package.json'))) return 'npm install'
  return 'true'
}

/**
 * Pfad des Ausgabeordners im Build-Container. Entfernt nur ein führendes
 * "./" – nicht den Punkt versteckter Ordner wie ".output" (Nuxt) oder
 * ".vitepress/dist".
 */
export function outputPathInContainer(outputDir: string): string {
  const rel = posix.normalize(outputDir).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return rel === '' || rel === '.' ? '/work' : `/work/${rel}`
}

export async function runStaticBuild(o: {
  slug: string
  deploymentId: string
  repoDir: string
  buildCommand: string
  outputDir: string
  /** Nur nicht-geheime Projekt-Env: alles hier landet potenziell in der Ausgabe. */
  env: Record<string, string>
  destDir: string
}): Promise<void> {
  // Der Ausgabeordner muss im Repo liegen. Er existiert vor dem Build meist
  // noch nicht; resolveInRepo prüft dann lexikalisch.
  await resolveInRepo(o.repoDir, o.outputDir)

  appendLine(o.deploymentId, `Build-Image wird geholt: ${BUILD_IMAGE}`)
  await docker.pullImage(BUILD_IMAGE)

  const network = docker.projectNetworkName(o.slug)
  await docker.ensureNetwork(network)

  const script = `${installCommand(o.repoDir)} && ${o.buildCommand}`
  const id = await docker.createOnly({
    name: `${network}_build_${o.deploymentId.replace(/-/g, '').slice(0, 10)}`,
    image: BUILD_IMAGE,
    network,
    // Kein NODE_ENV=production: sonst überspringen npm ci, pnpm und yarn die
    // devDependencies, und Vite, TypeScript & Co. fehlen beim Build. Wer
    // NODE_ENV braucht, setzt es in der Projekt-Env – die gewinnt hier.
    env: { CI: 'true', ...o.env },
    labels: {
      [docker.LABEL_MANAGED]: 'true',
      [docker.LABEL_PROJECT]: o.slug,
      [docker.LABEL_DEPLOYMENT]: o.deploymentId,
      [docker.LABEL.role]: 'build',
    },
    memoryLimitMb: BUILD_MEMORY_MB,
    cpuLimit: 2,
    oneShot: true,
    cmd: ['sh', '-c', script],
    workingDir: '/work',
  })

  try {
    // /work gibt es vor dem Start noch nicht: Einträge mit Präfix nach "/".
    await docker.putArchive(id, await packDir(o.repoDir, { prefix: 'work', exclude: ['node_modules'] }), '/')
    appendLine(o.deploymentId, `Build läuft: ${o.buildCommand}`)
    await docker.startById(id)

    const logs = await docker.followLogs(id)
    logs.on('data', (chunk: Buffer) => {
      for (const l of docker.demuxDockerLog(chunk).split('\n')) if (l.trim()) appendLine(o.deploymentId, l)
    })

    const r = await docker.waitForExit(id, BUILD_TIMEOUT_MS)
    ;(logs as unknown as { destroy?: () => void }).destroy?.()
    if (r.timedOut) throw new AppError('build_timeout', 'Build nach 10 Minuten abgebrochen', 400)
    if (r.exitCode !== 0) throw new AppError('build_failed', `Build-Befehl endete mit Code ${r.exitCode}`, 400)

    const out = outputPathInContainer(o.outputDir)
    appendLine(o.deploymentId, `Ausgabe wird geholt: ${o.outputDir}`)
    const tar = await docker.getArchive(id, out).catch(() => {
      throw new AppError('build_output_missing', `Ausgabeordner "${o.outputDir}" fehlt nach dem Build`, 400)
    })
    const res = await extractTarSafely(tar, o.destDir, { stripFirst: true })
    appendLine(o.deploymentId, `${res.files} Dateien, ${Math.round(res.bytes / 1024)} KiB`)
  } finally {
    await docker.removeContainer(id)
  }
}
