import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { chatExpiryDays } from '../domain/expiry-settings.js'
import { stopProject } from '../domain/lifecycle.js'
import { serverJob } from '../lib/scope.js'
import { audit } from '../domain/audit.js'
import { log } from '../lib/log.js'
import { expiryDecision, expiresAt } from './expiry-rule.js'
import { notify } from '../notify/send.js'

/**
 * Stündlicher Ablauf-Job für Chat-Deploys (Quelle files). Stoppt über
 * stopProject, also mit Audit-Eintrag; gelöscht wird nichts.
 * Die Warnung 3 Tage vorher geht in M3 ins Audit-Log; Push und E-Mail
 * kommen mit den Benachrichtigungen in M6.
 */

const EVERY_MS = 60 * 60_000
/** Erster Lauf kurz nach dem Start – sonst liefe er bei häufigen Neustarts nie. */
const FIRST_RUN_MS = 60_000

export async function runExpiry(now = new Date()): Promise<{ warned: string[]; stopped: string[] }> {
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.sourceType, 'files'))
  const warned: string[] = []
  const stopped: string[] = []

  for (const p of projects) {
    const decision = expiryDecision(p, now, chatExpiryDays())
    if (decision === 'warn') {
      await db.update(schema.projects).set({ expiryWarnedAt: now }).where(eq(schema.projects.id, p.id))
      await audit({
        actor: 'system', action: 'project.expiry_warning', targetType: 'project', targetId: p.id,
        params: { slug: p.slug, expiresAt: expiresAt(p, chatExpiryDays())?.toISOString() }, result: 'ok',
      })
      await notify('expiry', { project: p.name, date: expiresAt(p, chatExpiryDays())?.toLocaleDateString('de-CH') ?? '' })
      warned.push(p.slug)
    } else if (decision === 'stop') {
      await stopProject(serverJob('ablauf'), p.id, 'system')
      await audit({
        actor: 'system', action: 'project.expired', targetType: 'project', targetId: p.id,
        params: { slug: p.slug, days: chatExpiryDays() }, result: 'ok',
      })
      await notify('expiry', { project: p.name, stopped: true, days: chatExpiryDays() })
      stopped.push(p.slug)
    }
  }
  if (warned.length || stopped.length) log.info('Ablauf-Job', { warned, stopped })
  return { warned, stopped }
}

export function startExpiryJob(): NodeJS.Timeout {
  const tick = () => {
    runExpiry().catch((err) => log.error('Ablauf-Job fehlgeschlagen', { err: String(err) }))
  }
  setTimeout(tick, FIRST_RUN_MS).unref()
  const timer = setInterval(tick, EVERY_MS)
  timer.unref()
  return timer
}
