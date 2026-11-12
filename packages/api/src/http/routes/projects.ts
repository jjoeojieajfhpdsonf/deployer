import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { listScopeFor } from '../scope.js'
import {
  createProjectSchema, updateProjectSchema, putEnvSchema, putRoutesSchema, deploySchema, rollbackSchema, slugify,
  parseDockerLines, rangeMinutes,
} from '@airlock/shared'
import { logSources, readLogLines } from '../../domain/logs.js'
import { trackStream } from '../../lib/events.js'
import { checkSourceEarly } from '../../domain/source-checks.js'
import { bindCredential } from '../../domain/git-access.js'
import { createFilesProject, listProjectFiles } from '../../domain/files.js'
import { writeEnvironment as writeStatusEnvironment } from '../../status/service.js'
import {
  listProjects, findProject, toDto, createProject, updateProject, deleteProject,
  assertSourceSupported, previewName,
} from '../../domain/projects.js'
import { listEnvDto, replaceEnv } from '../../domain/env.js'
import { setRoutes, reconcileCaddy } from '../../domain/routes.js'
import { planPublic, applyPublic, removePublic, checkPublicNameIn, publicEnabled } from '../../domain/public.js'
import { requestPublic, approvePublicRequest } from '../../domain/public-requests.js'
import { blockingProblems } from '../../lib/public-name-check.js'
import type { PublicNameCheckDto } from '@airlock/shared'
import { listDeployments } from '../../domain/deployments.js'
import { withFailure } from '../../deploy/explain.js'
import { activeDeployment } from '../../domain/deployments.js'
import { startProject, stopProject, restartProject } from '../../domain/lifecycle.js'
import { startDeploy, startRollback, startRecreate } from '../../deploy/pipeline.js'
import { audit, createdBy } from '../../domain/audit.js'
import * as docker from '../../drivers/docker.js'
import { actorFor, requireSudo } from '../auth.js'
import { badRequest, notFound, AppError } from '../../lib/errors.js'
import { sinceSeconds } from '../../lib/dates.js'
import { projectHealth } from '../../jobs/monitor.js'
import { projectTopology } from '../../domain/topology.js'
import { probeViaCaddy } from '../../lib/address-probe.js'
import { config } from '../../config.js'
import { publicRoutes } from './public.js'

interface IdParams {
  id: string
}

/**
 * Neues Projekt mit «Öffentlich nach dem ersten Scan»: Name vor dem Anlegen
 * prüfen. Ein fremder DNS-Eintrag lässt sich hier nicht ersetzen (die
 * Anfrage merkt sich das nicht) – das geht danach unter Veröffentlichung.
 * Die Meldung steht am Namensfeld (details mit Pfad).
 */
async function assertPublicOnCreate(envId: string, pub: { subdomain?: string; zone?: string; apex?: boolean }, slug: string): Promise<PublicNameCheckDto> {
  if (!publicEnabled(envId)) throw badRequest('Öffentlich ist in dieser Umgebung nicht eingerichtet: unter Einstellungen → Cloudflare & HTTPS Token und Tunnel einrichten.')
  const check = await checkPublicNameIn(envId, { label: pub.subdomain ?? slug, zone: pub.zone, apex: pub.apex })
  const blocking = blockingProblems(check, false)
  if (blocking.length) {
    const msg = `${blocking.map((x) => x.message).join('; ')}${check.existing && !check.existing.worker ? '. Ersetzen geht nach dem Anlegen unter Einstellungen → Veröffentlichung.' : ''}`
    throw badRequest(msg, [{ path: 'public.subdomain', message: msg }])
  }
  return check
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // Karte «Veröffentlichung» und interne Ziele allein
  await publicRoutes(app)

  // M9: Liste und Anlegen in einer Umgebung (Pfad /environments/:env/projects
  // oder ?environment=; ohne Angabe die Standard-Umgebung, beim Token seine).
  const list = async (request: FastifyRequest) => ({ projects: await listProjects(listScopeFor(request)) })
  app.get('/projects', list)
  app.get('/environments/:env/projects', list)

  // UI-Qualität 5: Kurzname und Adresse vor dem Anlegen, mit Kollisionsprüfung (M9: in der Umgebung)
  const namePreview = async (request: FastifyRequest<{ Querystring: { name?: string } }>) => ({
    preview: await previewName(listScopeFor(request), String(request.query.name ?? '').slice(0, 120)),
  })
  app.get('/projects/name-preview', namePreview)
  app.get('/environments/:env/projects/name-preview', namePreview)

  const create = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = listScopeFor(request)
    const input = createProjectSchema.parse(request.body)
    assertSourceSupported(input.source.type)
    // Nacht 3, Etappe 2: Zugänge (Deploy-Key, Token) legt nur eine Anmeldung an und ordnet sie zu
    if (input.gitCredentialId && request.tokenId) throw new AppError('forbidden', 'Einen Repo-Zugang gibt es nur mit einer Anmeldung, nicht mit einem API-Token', 403)
    // Früh prüfen: gesperrte Repo-URL, nicht erreichbares Repo oder unzulässige
    // compose.yaml kommen als 400 mit Feldnamen zurück, statt erst als gescheiterter Deploy.
    await checkSourceEarly(input.source, input.slug ?? slugify(input.name), { credentialId: input.gitCredentialId })
    // Öffentlich nach dem ersten Scan: Name vorher prüfen (gleiche Prüfung wie beim Tippen)
    const pubCheck = input.public ? await assertPublicOnCreate(scope.envId, input.public, input.slug ?? slugify(input.name)) : null
    const project = input.source.type === 'files'
      ? await createFilesProject(scope, input, actorFor(request))
      : await createProject(scope, input, actorFor(request))
    if (input.gitCredentialId) await bindCredential(input.gitCredentialId, project.id, actorFor(request))
    if (input.public && pubCheck) {
      // Beim Anlegen in der Oberfläche ausdrücklich gewählt: vorgemerkt und gleich bestätigt;
      // wirksam nach dem ersten Scan ohne kritischen Befund (nie still)
      await requestPublic(project.id, {
        subdomain: pubCheck.apex ? undefined : pubCheck.label, zone: pubCheck.zone ?? undefined, apex: pubCheck.apex, accessProtected: input.public.accessProtected,
      }, actorFor(request), 'beim Anlegen: nach dem ersten Scan')
      await approvePublicRequest(project.id, actorFor(request))
    }

    if (input.deploy) {
      const deployment = await startDeploy(scope, project.id, actorFor(request))
      reply.code(201)
      return { project: await toDto(project), deployment }
    }
    await reconcileCaddy()
    reply.code(201)
    return { project: await toDto(project), deployment: null }
  }
  app.post('/projects', create)
  app.post('/environments/:env/projects', create)

  app.get<{ Params: IdParams }>('/projects/:id', async (request) => {
    const project = await findProject(request.scope, request.params.id)
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
    const project = await findProject(request.scope, request.params.id)
    return projectHealth(project.id, { fresh: request.query.fresh === '1' })
  })

  /**
   * Reiter «Aufbau»: Zugang, Eingang (Hosts der Routen), Dienste, Daten
   * (Datenbanken, Volumes) und die Linien dazwischen, mit Zuständen.
   */
  app.get<{ Params: IdParams }>('/projects/:id/topology', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    return { topology: await projectTopology(project) }
  })

  /**
   * Eine Adresse des Projekts vom Server aus prüfen (über Caddy, Host-Header).
   * Für http-Adressen, die der Browser auf einer https-Seite nicht abfragen
   * darf. Nur Adressen dieses Projekts – kein offener Proxy.
   */
  app.get<{ Params: IdParams; Querystring: { url?: string } }>('/projects/:id/address-check', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const url = request.query.url ?? ''
    const dto = await toDto(project)
    if (!dto.routes.some((r) => r.urls.includes(url))) throw badRequest('Diese Adresse gehört nicht zum Projekt.')
    return probeViaCaddy(`${config.CADDY_CONTAINER}:80`, url)
  })

  app.patch<{ Params: IdParams }>('/projects/:id', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const patch = updateProjectSchema.parse(request.body)
    if (patch.source) {
      assertSourceSupported(patch.source.type)
      // Ein Wechsel der Quellenart liesse Container der alten Art zurück
      // (Compose-Dienste werden anders verwaltet als einzelne Container).
      if (patch.source.type !== project.sourceType) {
        throw badRequest('Die Art der Quelle lässt sich nicht wechseln – dafür ein neues Projekt anlegen')
      }
      await checkSourceEarly(patch.source, project.slug, { project })
    }
    const updated = await updateProject(project.id, patch)
    await audit({
      actor: actorFor(request), action: 'project.update', targetType: 'project',
      targetId: project.id, params: patch, result: 'ok',
    })
    // Etappe 5: «Auf Statusseite zeigen» geändert – die Seite der Umgebung gleich neu schreiben
    if (patch.showOnStatus !== undefined) void writeStatusEnvironment(project.environmentId).catch(() => {})
    return { project: await toDto(updated) }
  })

  app.delete<{ Params: IdParams; Querystring: { purge?: string } }>(
    '/projects/:id',
    async (request, reply) => {
      const project = await findProject(request.scope, request.params.id)
      await deleteProject(request.scope, project.id, actorFor(request), request.query.purge === 'true')
      reply.code(204)
    },
  )

  /** M3: Dateien eines Chat-Projekts (nur Liste; Inhalte über MCP read_files). */
  app.get<{ Params: IdParams }>('/projects/:id/files', async (request) => listProjectFiles(request.scope, request.params.id))

  /* --- Umgebungsvariablen ------------------------------------------------ */

  app.get<{ Params: IdParams }>('/projects/:id/env', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    return { env: await listEnvDto(project.id) }
  })

  app.put<{ Params: IdParams }>('/projects/:id/env', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const { entries } = putEnvSchema.parse(request.body)
    const seen = new Set<string>()
    for (const e of entries) {
      if (seen.has(e.key)) throw badRequest(`Die Umgebungsvariable "${e.key}" kommt doppelt vor`)
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
    const project = await findProject(request.scope, request.params.id)
    const body = putRoutesSchema.parse(request.body)
    const wantsPublic = body.targets.includes('public')
    // Öffentlich schalten nur mit Anmeldung oder über MCP mit Bestätigung –
    // nicht mit einem blossen API-Token über REST (es gäbe keine Rückfrage).
    if (wantsPublic && request.tokenId) {
      throw new AppError('forbidden', 'Öffentlich schalten geht mit einem Token nur über MCP (mit Bestätigung) oder mit einer Anmeldung', 403)
    }
    // Nacht 3, Etappe 1: öffentlich (auch über diesen Weg) nur nach erneuter Bestätigung
    if (wantsPublic) requireSudo(request)
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
    return { project: await toDto(await findProject(request.scope, project.id)) }
  })

  /* --- Betrieb ------------------------------------------------------------ */

  app.post<{ Params: IdParams }>('/projects/:id/deploy', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const { ref } = deploySchema.parse(request.body ?? {})
    // Wirft 409, wenn für dieses Projekt schon ein Deploy läuft.
    const deployment = await startDeploy(request.scope, project.id, actorFor(request), ref)
    return { deployment }
  })

  /** M2: ohne deploymentId die zuletzt aktive Fassung vor der jetzigen. 409 bei laufendem Deploy. */
  app.post<{ Params: IdParams }>('/projects/:id/rollback', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const { deploymentId } = rollbackSchema.parse(request.body ?? {})
    const deployment = await startRollback(request.scope, project.id, actorFor(request), deploymentId)
    return { deployment }
  })

  /** Übergang: aktive Fassung mit den Namen von Airlock neu anlegen (docs/RENAME.md). 409 bei laufendem Deploy. */
  app.post<{ Params: IdParams }>('/projects/:id/recreate', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    const deployment = await startRecreate(request.scope, project.id, actorFor(request))
    return { deployment }
  })

  app.post<{ Params: IdParams }>('/projects/:id/start', async (request) => {
    return startProject(request.scope, request.params.id, actorFor(request))
  })

  /** Neu starten: dieselbe Fassung, Container stoppen und starten (kein Deploy). */
  app.post<{ Params: IdParams }>('/projects/:id/restart', async (request) => restartProject(request.scope, request.params.id, actorFor(request)))

  app.post<{ Params: IdParams }>('/projects/:id/stop', async (request, reply) => {
    await stopProject(request.scope, request.params.id, actorFor(request))
    reply.code(204)
  })

  app.get<{ Params: IdParams }>('/projects/:id/deployments', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    return { deployments: await withFailure(project, await listDeployments(project.id)) }
  })

  /* --- Logs ---------------------------------------------------------------- */

  /**
   * UI-Qualität 4: Zeilen mit Zeit, Dienst und Stufe für den Reiter «Logs».
   * range: 15m | 1h | 24h; service: ein Compose-Dienst (sonst alle, nach Zeit gemischt).
   */
  app.get<{ Params: IdParams; Querystring: { range?: string; service?: string } }>('/projects/:id/log-lines', async (request) => {
    const project = await findProject(request.scope, request.params.id)
    return readLogLines(project, { minutes: rangeMinutes(request.query.range), service: request.query.service || null })
  })

  app.get<{ Params: IdParams; Querystring: { lines?: string; since?: string } }>(
    '/projects/:id/logs',
    async (request) => {
      const project = await findProject(request.scope, request.params.id)
      const active = await activeDeployment(project.id)
      if (!active?.containerId) {
        return { logs: '', hint: 'Kein laufender Container – es gibt noch keine Ausgabe.' }
      }
      const lines = Math.min(Number(request.query.lines ?? 200) || 200, 500)
      const since = sinceSeconds(request.query.since)
      return { logs: await docker.getLogs(active.containerId, { tail: lines, ...(since ? { since } : {}) }) }
    },
  )

  // Reiter «Zugriffe»: seit «Zugriffe neu» aus visits.log (http/routes/traffic.ts)

  /**
   * Neue Zeilen live, als LogLineDto (Zeit, Dienst, Stufe). Anschluss an den
   * Stand von /log-lines über ?since= (Zeit der letzten Zeile): nichts doppelt,
   * nichts verloren. Compose: alle Dienste oder ?service=.
   */
  app.get<{ Params: IdParams; Querystring: { service?: string; since?: string } }>('/projects/:id/logs/stream', async (request, reply) => {
    const project = await findProject(request.scope, request.params.id)
    const sources = (await logSources(project)).filter((s) => !request.query.service || s.service === request.query.service)
    if (!sources.length) throw notFound('Laufender Container')
    const since = sinceOf(request.query.since)
    // Alle öffnen; scheitert einer, die schon offenen wieder schliessen
    const opened = await Promise.allSettled(sources.map((s) => docker.followLogs(s.containerId, since?.sec, { tail: since ? undefined : 0, timestamps: true })))
    const streams = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    if (streams.length < sources.length) {
      for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.()
      throw new AppError('logs_unavailable', 'Die Ausgabe eines Dienstes ist gerade nicht lesbar', 503)
    }
    openSse(reply)
    const decoders = sources.map(() => new docker.DockerLogDecoder())
    const emit = (lines: string[], i: number) => {
      for (const l of parseDockerLines(lines.join('\n'), sources[i]!.service)) {
        if (since && l.at && l.at <= since.iso) continue
        reply.raw.write(`data: ${JSON.stringify(l)}\n\n`)
      }
    }
    followUntilClosed(request, reply, streams, (chunk, i) => emit(decoders[i]!.push(chunk), i), (i) => emit(decoders[i]!.flush(), i))
    return reply
  })
}

/** ?since= (ISO-Zeitpunkt der letzten bekannten Zeile) für Docker (Sekunden mit Bruchteil) und zum Vergleichen */
function sinceOf(v: string | undefined): { sec: number; iso: string } | null {
  if (!v) return null
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return null
  return { sec: ms / 1000, iso: new Date(ms).toISOString() }
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
function followUntilClosed(
  request: FastifyRequest, reply: FastifyReply, streams: Readable[],
  send: (chunk: Buffer, i: number) => void,
  /** Ein Strom ist zu Ende: Rest ausgeben */
  ended?: (i: number) => void,
): void {
  let closed = false
  let open = streams.length
  const handlers = streams.map((s, i) => {
    const h = (chunk: Buffer) => { if (!closed) send(chunk, i) }
    s.on('data', h)
    return h
  })
  // Endet ein Dienst (Compose), laufen die anderen weiter; erst wenn alle zu sind, endet die Antwort
  const one = (i: number) => {
    if (closed) return
    ended?.(i)
    if (--open <= 0) close()
  }
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
  streams.forEach((s, i) => {
    let done = false
    const fin = () => { if (!done) { done = true; one(i) } }
    s.on('end', fin)
    s.on('error', fin)
  })
}
