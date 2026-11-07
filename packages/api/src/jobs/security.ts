import { eq, desc } from 'drizzle-orm'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { enqueueProjectScan, enqueueExternalScan } from '../security/scan.js'
import { notify } from '../notify/send.js'
import { log } from '../lib/log.js'

/**
 * Wiederkehrende Security-Aufgaben (SPEC):
 * - wöchentlicher Rescan aller laufenden Projekte (neue CVEs treffen auch
 *   alte Images),
 * - externe Ziele nach ihrem Intervall (aus, täglich, wöchentlich, monatlich),
 * - wöchentliche Zusammenfassung per E-Mail.
 * Ein stündlicher Takt prüft, was fällig ist.
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const INTERVAL_MS = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY } as const

async function lastScanAt(where: ReturnType<typeof eq>): Promise<Date | null> {
  const r = await db.select({ at: schema.scanRuns.startedAt }).from(schema.scanRuns).where(where).orderBy(desc(schema.scanRuns.startedAt)).limit(1)
  return r[0]?.at ?? null
}

export async function runSecurityJobs(now = new Date()): Promise<{ projects: string[]; external: string[]; summary: boolean }> {
  const projects: string[] = []
  const external: string[] = []

  for (const p of await db.select().from(schema.projects).where(eq(schema.projects.desiredState, 'running'))) {
    const last = await lastScanAt(eq(schema.scanRuns.projectId, p.id))
    if (!last || now.getTime() - last.getTime() >= 7 * DAY) {
      await enqueueProjectScan(p.id, { actor: 'system' }).then(() => projects.push(p.slug), () => {})
    }
  }

  for (const t of await db.select().from(schema.externalTargets)) {
    if (t.scanInterval === 'off' || !t.verifiedAt) continue
    const last = await lastScanAt(eq(schema.scanRuns.externalTargetId, t.id))
    if (!last || now.getTime() - last.getTime() >= INTERVAL_MS[t.scanInterval]) {
      await enqueueExternalScan(t.id, { actor: 'system' }).then(() => external.push(t.hostname), () => {})
    }
  }

  const summary = await weeklySummary(now)
  if (projects.length || external.length) log.info('Geplante Scans', { projects, external })
  return { projects, external, summary }
}

async function weeklySummary(now: Date): Promise<boolean> {
  const last = await getSetting('last_weekly_summary')
  if (last && now.getTime() - new Date(last).getTime() < 7 * DAY) return false

  const lines: string[] = []
  for (const p of await db.select().from(schema.projects).orderBy(schema.projects.name)) {
    const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.projectId, p.id)).orderBy(desc(schema.scanRuns.startedAt)).limit(1))[0]
    const open = run
      ? (await db.select().from(schema.findings).where(eq(schema.findings.scanRunId, run.id))).filter((f) => f.status === 'open').length
      : 0
    lines.push(`• ${p.name}: ${p.status}${run?.score != null ? `, Score ${run.score} (${run.grade}), ${open} offene Befunde` : ', noch nicht gescannt'}`)
  }
  for (const t of await db.select().from(schema.externalTargets)) {
    const run = (await db.select().from(schema.scanRuns).where(eq(schema.scanRuns.externalTargetId, t.id)).orderBy(desc(schema.scanRuns.startedAt)).limit(1))[0]
    lines.push(`• ${t.hostname} (extern): ${t.verifiedAt ? 'nachgewiesen' : 'NICHT nachgewiesen'}${run?.score != null ? `, Score ${run.score} (${run.grade})` : ''}`)
  }
  await notify('weekly_summary', { text: lines.length ? lines.join('\n') : 'Keine Projekte.' })
  await setSetting('last_weekly_summary', now.toISOString())
  return true
}

export function startSecurityJobs(): NodeJS.Timeout {
  const tick = () => {
    runSecurityJobs().catch((err) => log.error('Security-Jobs fehlgeschlagen', { err: String(err) }))
  }
  // Erster Lauf nach fünf Minuten: nicht direkt beim Start alles auf einmal.
  setTimeout(tick, 5 * 60_000).unref()
  const timer = setInterval(tick, HOUR)
  timer.unref()
  return timer
}
