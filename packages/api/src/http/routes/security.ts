import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { acceptFindingSchema, addExternalTargetSchema, ntfySettingsSchema, emailSettingsSchema } from '@airlock/shared'
import { findProject } from '../../domain/projects.js'
import { enqueueProjectScan, enqueueExternalScan, scanReport, latestScan, listScans, acceptFinding, assertPublishable, latestExternalScan, cancelScan } from '../../security/scan.js'
import {
  listExternalTargets, addExternalTarget, verifyExternalTarget, updateExternalTarget, deleteExternalTarget, findExternalTarget, toDto,
} from '../../security/external-targets.js'
import { getNotifySettings, putNotifySettings, sendTest } from '../../notify/send.js'
import { notifyEvents } from '../../notify/render.js'
import { actorFor } from '../auth.js'
import { badRequest, AppError } from '../../lib/errors.js'

const scanBody = z.object({
  level: z.enum(['standard', 'active']).default('standard'),
  /** Aktiver Scan nur mit ausdrücklicher Bestätigung (SPEC). */
  confirm: z.boolean().optional(),
})

const channelMatrix = z.record(z.enum(notifyEvents), z.object({ push: z.boolean(), email: z.boolean() }).partial())

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  /* --- Scans ------------------------------------------------------------------ */

  app.post<{ Params: { id: string } }>('/projects/:id/scans', async (request, reply) => {
    const { level, confirm } = scanBody.parse(request.body ?? {})
    if (level === 'active' && confirm !== true) {
      throw badRequest('Ein aktiver Scan (ZAP Full Scan: XSS, SQL-Injection) verlangt eine ausdrückliche Bestätigung')
    }
    const run = await enqueueProjectScan(request.params.id, { level, actor: actorFor(request), trigger: 'manual' })
    reply.code(202)
    return { scan: { id: run.id, status: run.status, level: run.level } }
  })

  app.get<{ Params: { id: string } }>('/projects/:id/scans', async (request) => {
    const p = await findProject(request.params.id)
    return { scans: (await listScans(p.id)).map((r) => ({ id: r.id, status: r.status, level: r.level, startedAt: r.startedAt, finishedAt: r.finishedAt, score: r.score, grade: r.grade })) }
  })

  // ?done=1: der letzte abgeschlossene Scan (die Oberfläche zeigt ihn, solange ein neuer läuft)
  app.get<{ Params: { id: string }; Querystring: { done?: string } }>('/projects/:id/scans/latest', async (request) => {
    const p = await findProject(request.params.id)
    const last = await latestScan(p.id, request.query.done === '1')
    return { report: last ? await scanReport(last.id) : null }
  })

  app.get<{ Params: { id: string } }>('/projects/:id/publishable', async (request) => {
    const p = await findProject(request.params.id)
    try {
      await assertPublishable(p.id)
      return { ok: true }
    } catch (err) {
      if (err instanceof AppError) return { ok: false, reason: err.message }
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/scans/:id', async (request) => ({ report: await scanReport(request.params.id) }))

  /** Laufenden oder wartenden Scan abbrechen. */
  app.post<{ Params: { id: string } }>('/scans/:id/cancel', async (request) => {
    await cancelScan(request.params.id, actorFor(request))
    return { report: await scanReport(request.params.id) }
  })

  app.patch<{ Params: { id: string } }>('/findings/:id', async (request) => {
    const body = acceptFindingSchema.parse(request.body)
    await acceptFinding(request.params.id, body.reason, actorFor(request))
    return { ok: true }
  })

  /* --- Externe Ziele -------------------------------------------------------------- */

  app.get('/external-targets', async () => ({ targets: await listExternalTargets() }))

  app.post('/external-targets', async (request, reply) => {
    const { hostname } = addExternalTargetSchema.parse(request.body)
    reply.code(201)
    return { target: await addExternalTarget(hostname, actorFor(request)) }
  })

  app.post<{ Params: { id: string } }>('/external-targets/:id/verify', async (request) => ({
    target: await verifyExternalTarget(request.params.id, actorFor(request)),
  }))

  app.patch<{ Params: { id: string } }>('/external-targets/:id', async (request) => {
    const { scanInterval } = z.object({ scanInterval: z.enum(['off', 'daily', 'weekly', 'monthly']) }).parse(request.body)
    return { target: await updateExternalTarget(request.params.id, scanInterval, actorFor(request)) }
  })

  app.delete<{ Params: { id: string } }>('/external-targets/:id', async (request, reply) => {
    await deleteExternalTarget(request.params.id, actorFor(request))
    reply.code(204)
  })

  app.get<{ Params: { id: string } }>('/external-targets/:id/scans/latest', async (request) => {
    const t = await findExternalTarget(request.params.id)
    const run = await latestExternalScan(t.id)
    return { report: run ? await scanReport(run.id) : null }
  })

  app.post<{ Params: { id: string } }>('/external-targets/:id/scans', async (request, reply) => {
    const { level, confirm } = scanBody.parse(request.body ?? {})
    if (level === 'active' && confirm !== true) throw badRequest('Ein aktiver Scan verlangt eine ausdrückliche Bestätigung')
    const t = await findExternalTarget(request.params.id)
    const run = await enqueueExternalScan(t.id, { level, actor: actorFor(request), trigger: 'manual' })
    reply.code(202)
    return { scan: { id: run.id, status: run.status, level: run.level }, target: toDto(t) }
  })

  /* --- Benachrichtigungen (nur mit Anmeldung, siehe Auth-Wächter) ------------------- */

  app.get('/notifications', async () => getNotifySettings())

  app.put('/notifications', async (request) => {
    const body = z.object({
      ntfy: ntfySettingsSchema.nullable().optional(),
      email: emailSettingsSchema.nullable().optional(),
      matrix: channelMatrix.optional(),
    }).parse(request.body)
    return putNotifySettings(body as Parameters<typeof putNotifySettings>[0], actorFor(request))
  })

  app.post('/notifications/test', async (request) => {
    const { channel } = z.object({ channel: z.enum(['push', 'email']) }).parse(request.body)
    await sendTest(channel, actorFor(request))
    return { ok: true }
  })
}
