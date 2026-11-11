import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { redactSecrets } from '../lib/redact.js'
import { publish, projectOfDeploy, forgetDeploy } from '../lib/events.js'
import type { DeploymentStatus } from '@airlock/shared'

/**
 * Fortschritt und Log eines Deployments.
 *
 * Zwei Abnehmer: die Datei auf der Platte (log_ref, bleibt nach dem Deploy
 * lesbar) und die offenen SSE-Verbindungen der UI. Ein spaet dazukommender
 * Abonnent bekommt zuerst den bisherigen Inhalt aus der Datei, damit er den
 * Anfang nicht verpasst.
 */

export interface JournalEvent {
  type: 'line' | 'status' | 'done'
  line?: string
  status?: DeploymentStatus
  ok?: boolean
  at: string
}

const bus = new EventEmitter()
bus.setMaxListeners(0)

function logDir(): string {
  const dir = join(config.DATA_DIR, 'logs', 'deployments')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logPathFor(deploymentId: string): string {
  return join(logDir(), `${deploymentId}.log`)
}

export function appendLine(deploymentId: string, rawLine: string): void {
  // z.B. Caddy-Fehler nach dem Deploy: können ein Cloudflare-Token enthalten
  const line = redactSecrets(rawLine)
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  try {
    appendFileSync(logPathFor(deploymentId), stamped)
  } catch {
    // Ein nicht schreibbares Log darf den Deploy nicht abbrechen.
  }
  bus.emit(deploymentId, { type: 'line', line, at: new Date().toISOString() } satisfies JournalEvent)
}

export function emitStatus(deploymentId: string, status: DeploymentStatus): void {
  appendLine(deploymentId, `--- ${status} ---`)
  bus.emit(deploymentId, { type: 'status', status, at: new Date().toISOString() } satisfies JournalEvent)
  // UI-Qualität 3: Projektliste, Kopf und Vorgänge ohne Polling
  publish({ type: 'deploy', deploymentId, status, projectId: projectOfDeploy(deploymentId) })
}

export function emitDone(deploymentId: string, ok: boolean): void {
  bus.emit(deploymentId, { type: 'done', ok, at: new Date().toISOString() } satisfies JournalEvent)
  publish({ type: 'deploy', deploymentId, status: ok ? 'active' : 'failed', projectId: projectOfDeploy(deploymentId) })
  forgetDeploy(deploymentId)
}

export function readLog(deploymentId: string): string {
  const p = logPathFor(deploymentId)
  if (!existsSync(p)) return ''
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Beim Start: Tokens aus bestehenden Deploy-Logs entfernen (vor dem Schwärzen
 * geschrieben). Nur Dateien, die sich ändern, werden neu geschrieben.
 */
export async function scrubDeploymentLogs(): Promise<number> {
  const dir = logDir()
  let changed = 0
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.log')) continue
    const p = join(dir, name)
    const text = await readFile(p, 'utf8').catch(() => null)
    if (text === null) continue
    const clean = redactSecrets(text)
    if (clean !== text) {
      await writeFile(p, clean)
      changed++
    }
  }
  return changed
}

export function subscribe(deploymentId: string, fn: (e: JournalEvent) => void): () => void {
  bus.on(deploymentId, fn)
  return () => bus.off(deploymentId, fn)
}
