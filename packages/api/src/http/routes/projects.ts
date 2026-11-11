import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import {
  createProjectSchema, updateProjectSchema, putEnvSchema, putRoutesSchema, deploySchema, rollbackSchema, slugify,
  parseDockerLines, rangeMinutes,
} from '@airlock/shared'
import { logSources, readLogLines } from '../../domain/logs.js'
import { trackStream } from '../../lib/events.js'
import { checkSourceEarly } from '../../domain/source-checks.js'
import { createFilesProject, listProjectFiles } from '../../domain/files.js'
import {
  listProjects, findProject, toDto, createProject, updateProject, deleteProject,
  assertSourceSupported,
} from '../../domain/projects.js'
import { listEnvDto, replaceEnv } from '../../domain/env.js'
import { setRoutes, reconcileCaddy, routeDtosFor } from '../../domain/routes.js'
import { parseSiteAccess } from '../../lib/site-access.js'
import { planPublic, applyPublic, removePublic } from '../../domain/public.js'
import { listDeployments } from '../../domain/deployments.js'
import { withFailure } from '../../deploy/explain.js'
import { activeDeployment } from '../../domain/deployments.js'
import { startProject, stopProject, restartProject } from '../../domain/lifecycle.js'
import { startDeploy, startRollback, startRecreate } from '../../deploy/pipeline.js'
import { audit, createdBy } from '../../domain/audit.js'
import * as docker from '../../drivers/docker.js'
import { actorFor } from '../auth.js'
import { badRequest, notFound, AppError } from '../../lib/errors.js'
import { sinceSeconds } from '../../lib/dates.js'
import { projectHealth } from '../../jobs/monitor.js'
import { probeViaCaddy } from '../../lib/address-probe.js'
import { config } from '../../config.js'
import { publicRoutes } from './public.js'

interface IdParams {
  id: string
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // Karte «Veröffentlichung» und interne Ziele allein
  await publicRoutes(app)

  app.get('/projects', async () => ({ projects: await listProjects() }))

  app.post('/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body)
    assertSourceSupported(input.source.type)
    // Früh prüfen: gesperrte Repo-URL oder unzulässige compose.yaml kommen als
    // 400 mit Feldnamen zurück, statt erst als gescheiterter Deploy.
    await checkSourceEarly(input.source, input.slug ?? slugify(input.name))
    const project = input.source.type === 'files'
      ? await createFilesProject(input, actorFor(request))
      : await createProject(input, actorFor(request))

    if (input.deploy) {
      const deployment = await startDeploy(project.id, actorFor(request))
      reply.code(201)
      return { project: await toDto(project), deployment }
    }
    await reconcileCaddy()
    reply.code(201)
    return { project: await toDto(project), deployment: null }
  })

  app.get<{ Params: IdParams }>('/projects/:id', async (request) => {
    const project = await findProject(request.params.id)
    const dto = await toDto(project)
    // Projektseite, Eckdaten «Quelle: Chat über <Token>»
    dto.createdBy = await createdBy(project.id, project.sourceType)

    // Hinweis, ob der Container als root laeuft. Kein Fehler, nur sichtbar.
    const active = await activeDeployment(project.id)
    if (active?.containerId && project.sourceType === 'image') {
      const cfg = project.sourceConfig as { image?: string }
      if (cfg.image) {
        dto.runsAsRoot = await docker
          .inspectImage(cfg.image)
          .then((i) => docker.runsAsRoot(i.user))
          .catch(() => null)
      }
    }
    return { project: dto, env: await listEnvDto(project.id) }
  })

  /** Zustand: Container, letzter Healthcheck, CPU/RAM der letzten Stunde. */
  app.get<{ Params: IdParams; Querystring: { fresh?: string } }>('/projects/:id/health', async (request) => {
    const project = await findProject(request.params.id)
    return projectHealth(project.id, { fresh: request.query.fresh === '1' })
  })

  /**
   * Eine Adresse des Projekts vom Server aus prüfen (über Caddy, Host-Header).
   * Für http-Adressen, die der Browser auf einer https-Seite nicht abfragen
   * darf. Nur Adressen dieses Projekts – kein offener Proxy.
   */
  app.get<{ Params: IdParams; Querystring: { url?: string } }>('/projects/:id/address-check', async (request) => {
    const project = await findProject(request.params.id)
    const url = request.query.url ?? ''
    const dto = await toDto(project)
    if (!dto.routes.some((r) => r.urls.includes(url))) throw badRequest('Diese Adresse gehört nicht zum Projekt.')
    return probeViaCaddy(`${config.CADDY_CONTAINER}:80`, url)
  })

  app.patch<{ Params: IdParams }>('/projects/:id', async (request) => {
    const project = await findProject(request.params.id)
    const patch = updateProjectSchema.parse(request.body)
    if (patch.source) {
      assertSourceSupported(patch.source.type)
      // Ein Wechsel der Quellenart liesse Container der alten Art zurück
      // (Compose-Dienste werden anders verwaltet als einzelne Container).
      if (patch.source.type !== project.sourceType) {
        throw badRequest('Die Art der Quelle lässt sich nicht wechseln – dafür ein neues Projekt anlegen')
      }
      await checkSourceEarly(patch.source, project.slug)
    }
    const updated = await updateProject(project.id, patch)
    await audit({
      actor: actorFor(request), action: 'project.update', targetType: 'project',
      targetId: project.id, params: patch, result: 'ok',
    })
    return { project: await toDto(updated) }
  })

  app.delete<{ Params: IdParams; Querystring: { purge?: string } }>(
    '/projects/:id',
    async (request, reply) => {
      const project = await findProject(request.params.id)
      await deleteProject(project.id, actorFor(request), request.query.purge === 'true')
      reply.code(204)
    },
  )

  /** M3: Dateien eines Chat-Projekts (nur Liste; Inhalte über MCP read_files). */
  app.get<{ Params: IdParams }>('/projects/:id/files', async (request) => listProjectFiles(request.params.id))

  /* --- Umgebungsvariablen ------------------------------------------------ */

  app.get<{ Params: IdParams }>('/projects/:id/env', async (request) => {
    const project = await findProject(request.params.id)
    return { env: await listEnvDto(project.id) }
  })

  app.put<{ Params: IdParams }>('/projects/:id/env', async (request) => {
    const project = await findProject(request.params.id)
    const { entries } = putEnvSchema.parse(request.body)
    const seen = new Set<string>()
    for (const e of entries) {
      if (seen.has(e.key)) throw badRequest(`Die Variable "${e.key}" kommt doppelt vor`)
      seen.add(e.key)
    }
    await replaceEnv(project.id, entries)
    await audit({
      actor: actorFor(request), action: 'project.env.replace', targetType: 'project',
      targetId: project.id, params: { keys: entries.map((e) => e.key) }, result: 'ok',
    })
    return { env: await listEnvDto(project.id) }
  })

  /* --- Routen ------------------------------------------------------------- */

  app.put<{ Params: IdParams }>('/projects/:id/routes', async (request) => {
    const project = await findProject(request.params.id)
    const body = putRoutesSchema.parse(request.body)
    const wantsPublic = body.targets.includes('public')
    // Öffentlich schalten nur mit Anmeldung oder über MCP mit Bestätigung –
    // nicht mit einem blossen API-Token über REST (es gäbe keine Rückfrage).
    if (wantsPublic && request.tokenId) {
      throw new AppError('forbidden', 'Öffentlich schalten geht mit einem Token nur über MCP (mit Bestätigung) oder mit einer Anmeldung', 403)
    }
    // Erst alles prüfen, dann ändern: scheitert "public", bleiben die internen Ziele.
    const plan = wantsPublic
      ? await planPublic(project, { subdomain: body.publicSubdomain, hostname: body.publicHostname, accessProtected: body.accessProtected })
      : null
    try {
      await setRoutes(project.id, project.slug, body.targets.filter((t) => t !== 'public'), body.subdomain)
      if (plan) await applyPublic(plan, actorFor(request))
      else await removePublic(project, actorFor(request), { skipCaddy: true })
    } finally {
      await reconcileCaddy()
    }
    await audit({
      actor: actorFor(request), action: 'project.routes.set', targetType: 'project',
      targetId: project.id, params: body, result: 'ok',
    })
    return { project: await toDto(await findProject(project.id)) }
  })

  /* --- Betrieb ------------------------------------------------------------ */

  app.post<{ Params: IdParams }>('/projects/:id/deploy', async (request) => {
    const project = await findProject(request.params.id)
    const { ref } = deploySchema.parse(request.body ?? {})
    // Wirft 409, wenn für dieses Projekt schon ein Deploy läuft.
    const deployment = await startDeploy(project.id, actorFor(request), ref)
    return { deployment }
  })

  /** M2: ohne deploymentId die zuletzt aktive Fassung vor der jetzigen. 409 bei laufendem Deploy. */
  app.post<{ Params: IdParams }>('/projects/:id/rollback', async (request) => {
    const project = await findProject(request.params.id)
    const { deploymentId } = rollbackSchema.parse(request.body ?? {})
    const deployment = await startRollback(project.id, actorFor(request), deploymentId)
    return { deployment }
  })

  /** Übergang: aktive Fassung mit den Namen von Airlock neu anlegen (docs/RENAME.md). 409 bei laufendem Deploy. */
  app.post<{ Params: IdParams }>('/projects/:id/recreate', async (request) => {
    const project = await findProject(request.params.id)
    const deployment = await startRecreate(project.id, actorFor(request))
    return { deployment }
  })

  app.post<{ Params: IdParams }>('/projects/:id/start', async (request) => {
    return startProject(request.params.id, actorFor(request))
  })

  /** Neu starten: dieselbe Fassung, Container stoppen und starten (kein Deploy). */
  app.post<{ Params: IdParams }>('/projects/:id/restart', async (request) => restartProject(request.params.id, actorFor(request)))

  app.post<{ Params: IdParams }>('/projects/:id/stop', async (request, reply) => {
    await stopProject(request.params.id, actorFor(request))
    reply.code(204)
  })

  app.get<{ Params: IdParams }>('/projects/:id/deployments', async (request) => {
    const project = await findProject(request.params.id)
    return { deployments: await withFailure(project, await listDeployments(project.id)) }
  })

  /* --- Logs ---------------------------------------------------------------- */

  /**
   * UI-Qualität 4: Zeilen mit Zeit, Dienst und Stufe für den Reiter «Logs».
   * range: 15m | 1h | 24h; service: ein Compose-Dienst (sonst alle, nach Zeit gemischt).
   */
  app.get<{ Params: IdParams; Querystring: { range?: string; service?: string } }>('/projects/:id/log-lines', async (request) => {
    const project = await findProject(request.params.id)
    return readLogLines(project, { minutes: rangeMinutes(request.query.range), service: request.query.service || null })
  })

  app.get<{ Params: IdParams; Querystring: { lines?: string; since?: string } }>(
    '/projects/:id/logs',
    async (request) => {
      const project = await findProject(request.params.id)
      const active = await activeDeployment(project.id)
      if (!active?.containerId) {
        return { logs: '', hint: 'Kein laufender Container – es gibt noch keine Ausgabe.' }
      }
      const lines = Math.min(Number(request.query.lines ?? 200) || 200, 500)
      const since = sinceSeconds(request.query.since)
      return { logs: await docker.getLogs(active.containerId, { tail: lines, ...(since ? { since } : {}) }) }
    },
  )

  /**
   * Projektseite, Reiter «Zugriffe»: Aufrufe einer statischen Seite aus
   * Caddys Zugriffs-Log (letzte 24 Stunden, höchstens 500, IP gekürzt).
   */
  // UI-Qualität 4: Zeitraum wählbar (15m, 1h, 24h; Standard wie bisher 24 Stunden)
  app.get<{ Params: IdParams; Querystring: { range?: string } }>('/projects/:id/access', async (request) => {
    const project = await findProject(request.params.id)
    const hosts = await siteHosts(project)
    const sinceMs = Date.now() - (request.query.range ? rangeMinutes(request.query.range) : 24 * 60) * 60_000
    try {
      const logs = await docker.getLogs(config.CADDY_CONTAINER, { tail: 20_000, since: Math.floor(sinceMs / 1000) })
      return { entries: parseSiteAccess(logs, { hosts, sinceMs }), since: new Date(sinceMs).toISOString(), error: null }
    } catch (err) {
      return { entries: [], since: new Date(sinceMs).toISOString(), error: `Zugriffs-Log nicht lesbar: ${(err as Error).message.slice(0, 160)}` }
    }
  })

  /** UI-Qualität 4: neue Zugriffe live (wie der Reiter «Logs»), aus Caddys Log gefiltert auf die Adressen des Projekts */
  app.get<{ Params: IdParams }>('/projects/:id/access/stream', async (request, reply) => {
    const project = await findProject(request.params.id)
    const hosts = await siteHosts(project)
    const stream = await docker.followLogs(config.CADDY_CONTAINER, undefined, { tail: 0 })
    openSse(reply)
    let rest = ''
    const send = (chunk: Buffer) => {
      // Caddy schreibt JSON-Zeilen; ein Stück kann mitten in einer Zeile enden
      const text = rest + docker.demuxDockerLog(chunk)
      const cut = text.lastIndexOf('\n')
      rest = cut < 0 ? text : text.slice(cut + 1)
      if (cut < 0) return
      for (const e of parseSiteAccess(text.slice(0, cut), { hosts, sinceMs: 0 })) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    followUntilClosed(request, reply, [stream], send)
    return reply
  })

  /**
   * Neue Zeilen live, als LogLineDto (Zeit, Dienst, Stufe). Nur neue Zeilen
   * (tail 0) – den Stand davor holt die Oberfläche über /log-lines, sonst
   * stünden Zeilen doppelt. Compose: alle Dienste oder ?service=.
   */
  app.get<{ Params: IdParams; Querystring: { service?: string } }>('/projects/:id/logs/stream', async (request, reply) => {
    const project = await findProject(request.params.id)
    const sources = (await logSources(project)).filter((s) => !request.query.service || s.service === request.query.service)
    if (!sources.length) throw notFound('Laufender Container')
    const streams = await Promise.all(sources.map((s) => docker.followLogs(s.containerId, undefined, { tail: 0, timestamps: true })))
    openSse(reply)
    followUntilClosed(request, reply, streams, (chunk, i) => {
      for (const l of parseDockerLines(docker.demuxDockerLog(chunk), sources[i]!.service)) reply.raw.write(`data: ${JSON.stringify(l)}\n\n`)
    })
    return reply
  })
}

/** Adressen einer statischen Seite (für das Zugriffs-Log) */
async function siteHosts(project: { id: string; slug: string }): Promise<string[]> {
  const routes = await routeDtosFor(project.id, project.slug)
  return routes.flatMap((r) => [r.hostname, ...r.aliases])
}

function openSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/**
 * Docker-Ströme an eine SSE-Antwort hängen, mit Herzschlag; alles schliesst,
 * sobald der Browser geht oder ein Strom endet. Nach dem Ende wird nichts
 * mehr geschrieben.
 */
function followUntilClosed(request: FastifyRequest, reply: FastifyReply, streams: Readable[], send: (chunk: Buffer, i: number) => void): void {
  let closed = false
  const handlers = streams.map((s, i) => {
    const h = (chunk: Buffer) => { if (!closed) send(chunk, i) }
    s.on('data', h)
    return h
  })
  const keepalive = setInterval(() => { if (!closed) reply.raw.write(': ping\n\n') }, 20_000)
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    untrack()
    streams.forEach((s, i) => {
      s.removeListener('data', handlers[i]!)
      ;(s as unknown as { destroy?: () => void }).destroy?.()
    })
    reply.raw.end()
  }
  // Beim Herunterfahren schliessen (sonst wartet app.close())
  const untrack = trackStream(close)
  request.raw.on('close', close)
  for (const s of streams) { s.on('end', close); s.on('error', close) }
}
