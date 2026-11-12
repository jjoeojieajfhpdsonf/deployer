import { config } from '../config.js'
import { log } from '../lib/log.js'
import { checkParent, parentsToCheck, parentsWithPullRequests, syncPreviewReports } from '../domain/previews.js'
import { findProjectForServerJob } from '../domain/projects.js'

/**
 * Etappe 6: Vorschau-Deploys ohne Webhook. Airlock ist nie öffentlich
 * erreichbar; wie Auto-Deploy fragt es die GitHub-API ab:
 *
 * - im Intervall von Auto-Deploy (AUTO_DEPLOY_INTERVAL_S, Standard 5 Minuten)
 *   je Projekt mit Vorschauen: Branches und offene Pull Requests → anlegen,
 *   neu deployen, aufräumen (domain/previews.ts → lib/previews.ts);
 * - alle 30 Sekunden: Kommentar und Check am PR nachziehen, sobald sich
 *   Zustand oder Scan ändern (nur aus der Datenbank; GitHub nur bei Änderung).
 */

let checking = false
let reporting = false

export async function previewsTick(): Promise<void> {
  if (checking) return
  checking = true
  try {
    for (const id of await parentsToCheck()) {
      await checkParent(id).catch((err) => log.warn('Vorschauen: Abfrage gescheitert', { project: id, err: String(err) }))
    }
  } finally {
    checking = false
  }
}

export async function previewReportsTick(): Promise<void> {
  if (reporting || checking) return
  reporting = true
  try {
    for (const id of await parentsWithPullRequests()) {
      const parent = await findProjectForServerJob(id).catch(() => null)
      if (parent) await syncPreviewReports(parent).catch((err) => log.warn('Vorschauen: Kommentar/Check nicht aktualisiert', { project: parent.slug, err: String(err) }))
    }
  } finally {
    reporting = false
  }
}

export function startPreviewJobs(): NodeJS.Timeout[] {
  const poll = setInterval(() => void previewsTick().catch((err) => log.warn('Vorschauen-Lauf gescheitert', { err: String(err) })), config.AUTO_DEPLOY_INTERVAL_S * 1000)
  const reports = setInterval(() => void previewReportsTick().catch((err) => log.warn('Vorschauen-Berichte gescheitert', { err: String(err) })), 30_000)
  poll.unref()
  reports.unref()
  return [poll, reports]
}
