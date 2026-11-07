import type { FastifyInstance } from 'fastify'
import {
  createProjectSchema, updateProjectSchema, putEnvSchema, putRoutesSchema, deploySchema, rollbackSchema, slugify,
} from '@deployer/shared'
import { checkSourceEarly } from '../../domain/source-checks.js'
import { createFilesProject, listProjectFiles } from '../../domain/files.js'
import {
  listProjects, findProject, toDto, createProject, updateProject, deleteProject,
  assertSourceSupported,
} from '../../domain/projects.js'
import { listEnvDto, replaceEnv } from '../../domain/env.js'
import { setRoutes, reconcileCaddy } from '../../domain/routes.js'
import { listDeployments } from '../../domain/deployments.js'
import { activeDeployment } from '../../domain/deployments.js'
import { startProject, stopProject } from '../../domain/lifecycle.js'
import { startDeploy, startRollback } from '../../deploy/pipeline.js'
import { audit } from '../../domain/audit.js'
import * as docker from '../../drivers/docker.js'
import { actorFor } from '../auth.js'
import { badRequest, notFound } from '../../lib/errors.js'

interface IdParams {
  id: string
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
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
    for (const t of body.targets) {
      if (t !== 'lan') throw badRequest(`Ziel "${t}" kommt erst in einem späteren Meilenstein`)
    }
    await setRoutes(project.id, project.slug, body.targets, body.subdomain)
    await reconcileCaddy()
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

  app.post<{ Params: IdParams }>('/projects/:id/start', async (request) => {
    return startProject(request.params.id, actorFor(request))
  })

  app.post<{ Params: IdParams }>('/projects/:id/stop', async (request, reply) => {
    await stopProject(request.params.id, actorFor(request))
    reply.code(204)
  })

  app.get<{ Params: IdParams }>('/projects/:id/deployments', async (request) => {
    const project = await findProject(request.params.id)
    return { deployments: await listDeployments(project.id) }
  })

  /* --- Logs ---------------------------------------------------------------- */

  app.get<{ Params: IdParams; Querystring: { lines?: string; since?: string } }>(
    '/projects/:id/logs',
    async (request) => {
      const project = await findProject(request.params.id)
      const active = await activeDeployment(project.id)
      if (!active?.containerId) {
        return { logs: '', hint: 'Kein laufender Container – es gibt noch keine Ausgabe.' }
      }
      const lines = Math.min(Number(request.query.lines ?? 200) || 200, 500)
      const since = request.query.since ? Math.floor(new Date(request.query.since).getTime() / 1000) : undefined
      return { logs: await docker.getLogs(active.containerId, { tail: lines, ...(since ? { since } : {}) }) }
    },
  )

  app.get<{ Params: IdParams }>('/projects/:id/logs/stream', async (request, reply) => {
    const project = await findProject(request.params.id)
    const active = await activeDeployment(project.id)
    if (!active?.containerId) throw notFound('Laufender Container')

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const stream = await docker.followLogs(active.containerId)
    const send = (chunk: Buffer) => {
      const text = docker.demuxDockerLog(chunk)
      for (const line of text.split('\n')) {
        if (line.length) reply.raw.write(`data: ${JSON.stringify(line)}\n\n`)
      }
    }
    stream.on('data', send)

    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 20_000)
    const close = () => {
      clearInterval(keepalive)
      stream.removeListener('data', send)
      ;(stream as unknown as { destroy?: () => void }).destroy?.()
      reply.raw.end()
    }
    request.raw.on('close', close)
    stream.on('end', close)
    stream.on('error', close)

    return reply
  })
}
