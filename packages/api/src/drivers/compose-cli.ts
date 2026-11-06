import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'

/**
 * Die Compose-CLI. Sie geht an drivers/policy.ts vorbei; ihre Schranke ist
 * lib/compose.ts. Diese Datei sorgt nur dafür, dass die CLI ausschliesslich
 * die normalisierte Datei sieht und nichts aus der Umgebung des deployers:
 *
 * - leere Umgebung bis auf PATH, HOME und DOCKER_HOST. Ohne das könnte
 *   Compose `${DATABASE_URL}` & Co. aus dem deployer-Prozess einsetzen
 *   (zusätzlich zur Maskierung von "$" beim Normalisieren);
 * - --env-file auf /dev/null und --project-directory auf den Ordner der
 *   normalisierten Datei: keine .env von irgendwoher.
 */

function composeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: '/tmp',
    DOCKER_HOST: config.DOCKER_HOST,
    // Klassischer Builder wie bei dockerode: BuildKit bräuchte die Endpunkte
    // /session und /grpc, die der Socket-Proxy sperrt (SESSION=0).
    DOCKER_BUILDKIT: '0',
    COMPOSE_DOCKER_CLI_BUILD: '0',
  }
}

export function runCompose(
  projectName: string,
  file: string,
  args: string[],
  opts: { timeoutMs?: number; onLine?: (l: string) => void } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const full = [
    'compose',
    '--project-name', projectName,
    '--file', file,
    '--project-directory', dirname(file),
    '--env-file', '/dev/null',
    '--progress', 'plain',
    ...args,
  ]
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      full,
      { env: composeEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed
          reject(
            new AppError(
              killed ? 'compose_timeout' : 'compose_failed',
              killed
                ? `docker compose nach ${Math.round(timeoutMs / 60000)} Minuten abgebrochen`
                : `docker compose ist fehlgeschlagen: ${(stderr || err.message).trim().split('\n').slice(-4).join(' | ')}`,
              400,
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
    const forward = (d: Buffer) => {
      for (const l of d.toString().split(/\r?\n/)) if (l.trim()) opts.onLine?.(l.trim())
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
  })
}

export const composeUp = (projectName: string, file: string, onLine?: (l: string) => void) =>
  runCompose(projectName, file, ['up', '--detach', '--remove-orphans', '--quiet-pull'], { onLine })

/**
 * Images vor dem `up` frisch holen – sonst bliebe bei einem Redeploy mit
 * veränderlichem Tag (:latest) das alte Image stehen. Dienste mit build:
 * werden ausgelassen, sie haben ein eigenes Tag pro Fassung. Nicht bei
 * Rollbacks: die sollen genau das Image von damals bekommen.
 */
export const composePull = (projectName: string, file: string, onLine?: (l: string) => void) =>
  runCompose(projectName, file, ['pull', '--ignore-buildable', '--quiet'], { onLine })
