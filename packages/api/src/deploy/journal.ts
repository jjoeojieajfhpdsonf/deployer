import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import type { DeploymentStatus } from '@deployer/shared'

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

export function appendLine(deploymentId: string, line: string): void {
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
}

export function emitDone(deploymentId: string, ok: boolean): void {
  bus.emit(deploymentId, { type: 'done', ok, at: new Date().toISOString() } satisfies JournalEvent)
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

export function subscribe(deploymentId: string, fn: (e: JournalEvent) => void): () => void {
  bus.on(deploymentId, fn)
  return () => bus.off(deploymentId, fn)
}
