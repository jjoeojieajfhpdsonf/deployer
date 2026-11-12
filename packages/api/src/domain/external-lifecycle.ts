import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { serverJob } from '../lib/scope.js'
import { log } from '../lib/log.js'
import { audit } from './audit.js'
import { reconcileCaddy } from './routes.js'
import { refreshExternalTargets } from './external.js'
import { enqueueProjectScan } from '../security/scan.js'

type Row = typeof schema.projects.$inferSelect

/**
 * Bestehender Dienst nach dem Anlegen: kein Deploy – Zugang setzen, Ziel
 * nachsehen, Caddy abgleichen (Route sofort da) und den ersten Scan
 * einreihen. Erst ein bestandener Scan erlaubt «öffentlich» (wie bei jedem Projekt).
 */
export async function afterExternalCreate(p: Row, guard: 'offen' | 'login' | undefined, actor: string): Promise<void> {
  if (guard === 'login') {
    await db.update(schema.projects).set({ loginGuard: true }).where(eq(schema.projects.id, p.id))
    await audit({ actor, action: 'project.access', targetType: 'project', targetId: p.id, params: { from: 'offen', to: 'login' }, result: 'ok' })
  }
  await refreshExternalTargets().catch((err) => log.warn('Ziel nicht nachgesehen', { err: String(err) }))
  await reconcileCaddy()
  await enqueueProjectScan(serverJob('bestehender-dienst'), p.id, { actor, trigger: 'deploy' })
    .catch((err) => log.warn('Erster Scan des bestehenden Dienstes nicht eingereiht', { slug: p.slug, err: String(err) }))
}

/**
 * Minütlich (Monitor-Runde): Container-Ziele wiederfinden; hat sich etwas
 * geändert (fehlt, wieder da, neues Netz oder neue IP), Caddy neu abgleichen.
 */
export async function externalTick(): Promise<void> {
  if (await refreshExternalTargets()) await reconcileCaddy()
}
