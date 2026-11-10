import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { headerKeys, headerRuleInputSchema } from '@airlock/shared'
import { listHeaderRules, setHeaderRule, removeHeaderRule, recordCspReports } from '../../security/header-service.js'
import { recheckHeaders } from '../../security/scan.js'
import { findProject } from '../../domain/projects.js'
import { actorFor } from '../auth.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { fixHint, listFixRequests, applyFix, rejectFix } from '../../security/fix-service.js'

/**
 * M8: Fix-Assistent. Eigene Datei statt security.ts, damit parallele
 * Änderungen dort (live sichtbare Scan-Stufen) nicht kollidieren.
 */

const headerParam = z.enum(headerKeys, { message: `Unbekannter Header; erlaubt: ${headerKeys.join(', ')}` })

/** Meldungen pro Schlüssel und Minute (ein Browser meldet jeden Verstoss einzeln) */
const REPORTS_PER_MINUTE = 120
const buckets = new Map<string, { n: number; until: number }>()
function allowReport(key: string): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now > b.until) {
    if (buckets.size > 1000) buckets.clear()
    buckets.set(key, { n: 1, until: now + 60_000 })
    return true
  }
  b.n++
  return b.n <= REPORTS_PER_MINUTE
}

export async function fixRoutes(app: FastifyInstance): Promise<void> {
  /* --- Header über Caddy ------------------------------------------------------- */

  app.get<{ Params: { id: string } }>('/projects/:id/header-rules', async (request) => listHeaderRules(request.scope, request.params.id))

  app.put<{ Params: { id: string; header: string } }>('/projects/:id/header-rules/:header', async (request) => {
    const header = headerParam.parse(request.params.header)
    const body = headerRuleInputSchema.parse(request.body ?? {})
    return setHeaderRule(request.scope, request.params.id, header, body, actorFor(request))
  })

  app.delete<{ Params: { id: string; header: string } }>('/projects/:id/header-rules/:header', async (request) => {
    const header = headerParam.parse(request.params.header)
    return removeHeaderRule(request.scope, request.params.id, header, actorFor(request))
  })

  /** Nachscan nur der Stufe «headers», etwa nachdem die App selbst Header setzt */
  app.post<{ Params: { id: string } }>('/projects/:id/header-recheck', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return recheckHeaders(p.id, actorFor(request))
  })

  /* --- Mit Claude lösen (Etappe 2) --------------------------------------------- */

  /** Weg, fertiger Auftrag und bei Images die Kandidaten */
  app.get<{ Params: { id: string; finding: string } }>('/projects/:id/findings/:finding/fix-hint', async (request) =>
    fixHint(request.scope, request.params.id, z.string().uuid().parse(request.params.finding)))

  app.get<{ Params: { id: string } }>('/projects/:id/fix-requests', async (request) => ({ fixes: await listFixRequests(request.scope, request.params.id) }))

  /** Übernehmen: neue Version, Deploy, Nachscan. Nur mit ausdrücklicher Bestätigung. */
  app.post<{ Params: { id: string; fix: string } }>('/projects/:id/fix-requests/:fix/apply', async (request) => {
    const { confirm } = z.object({ confirm: z.boolean().optional() }).parse(request.body ?? {})
    if (confirm !== true) throw badRequest('Übernehmen verlangt eine ausdrückliche Bestätigung')
    const p = await findProject(request.scope, request.params.id)
    return { fix: await applyFix(request.scope, z.string().uuid().parse(request.params.fix), actorFor(request), { projectId: p.id }) }
  })

  app.post<{ Params: { id: string; fix: string } }>('/projects/:id/fix-requests/:fix/reject', async (request) => {
    const p = await findProject(request.scope, request.params.id)
    return { fix: await rejectFix(request.scope, z.string().uuid().parse(request.params.fix), actorFor(request), { projectId: p.id }) }
  })
}

/**
 * CSP-Meldungen von Browsern, ohne Anmeldung (Browser schicken keine
 * Zugangsdaten mit). Geschützt durch den zufälligen Schlüssel der Regel und
 * dadurch, dass Caddy den Namen von Airlock nur aus LAN und Tailnet
 * durchlässt; dazu Grössen- und Mengengrenzen.
 */
export async function cspReportRoutes(app: FastifyInstance): Promise<void> {
  const parseJson = (_req: unknown, body: string, done: (err: Error | null, v?: unknown) => void) => {
    try {
      done(null, body.trim() ? JSON.parse(body) : {})
    } catch {
      done(new AppError('bad_request', 'Meldung ist kein JSON', 400))
    }
  }
  for (const t of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(t, { parseAs: 'string', bodyLimit: 64 * 1024 }, parseJson)
  }

  app.post<{ Params: { key: string } }>('/csp-reports/:key', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!allowReport(request.params.key)) {
      reply.code(429)
      return { error: { code: 'too_many', message: 'Zu viele Meldungen' } }
    }
    await recordCspReports(request.params.key, request.body)
    reply.code(204)
  })
}
