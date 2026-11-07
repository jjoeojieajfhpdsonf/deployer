import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createProjectSchema, sourceSchema, envEntryInputSchema, fileInputSchema, routeTargets } from '@deployer/shared'
import { listProjects, findProject, toDto, createProject, deleteProject, updateProject, assertSourceSupported } from '../domain/projects.js'
import { listDeployments, getDeployment, activeDeployment } from '../domain/deployments.js'
import { listEnvDto } from '../domain/env.js'
import { setRoutes, reconcileCaddy } from '../domain/routes.js'
import { startProject, stopProject } from '../domain/lifecycle.js'
import { checkSourceEarly } from '../domain/source-checks.js'
import {
  createFilesProject, updateProjectFiles, readProjectFiles, exportProjectZip, pushProjectRepo, listProjectFiles,
} from '../domain/files.js'
import { audit } from '../domain/audit.js'
import { startDeploy, startRollback } from '../deploy/pipeline.js'
import { readLog } from '../deploy/journal.js'
import * as docker from '../drivers/docker.js'
import { maskParams } from '../lib/crypto.js'
import { AppError, badRequest } from '../lib/errors.js'
import { slugify } from '@deployer/shared'
import { issueConfirmation, consumeConfirmation } from './confirm.js'
import type { TokenIdentity } from '../domain/tokens.js'
import type { DeploymentDto, ProjectDto } from '@deployer/shared'

/**
 * MCP-Server von deployer. Pro Sitzung eine Instanz mit der Identität des
 * API-Tokens fest eingebunden: kein Werkzeug kann unter einer anderen
 * Identität laufen. Alle Werkzeuge rufen dieselbe Service-Schicht wie REST
 * und UI auf (SPEC).
 */

const project = z.string().min(1).max(64).describe('Slug oder ID des Projekts')
const wait = z.boolean().default(true).describe('Auf das Ende des Deploys warten (Standard) und das Ergebnis liefern')

/** Werkzeuge, die vor M5/M6 noch nicht verfügbar sind. */
const PUBLIC_LATER = 'Das Ziel "public" kommt mit Meilenstein 5 (Cloudflare Tunnel). Bis dahin nur "lan".'

type Content = { type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
type ToolResult = { content: Content[]; isError?: boolean }

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true })

/** Für das Audit-Log: Dateien nur mit Pfad und Grösse, Tokens maskiert. */
function auditParams(args: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = { ...args }
  if (Array.isArray(copy.files)) {
    copy.files = (copy.files as { path: string; content?: string }[]).map((f) => ({ path: f.path, size: f.content?.length ?? 0 }))
  }
  if (copy.push_token) copy.push_token = '***'
  return maskParams(copy)
}

function summarize(p: ProjectDto) {
  return {
    project: p.slug,
    name: p.name,
    status: p.status,
    source: p.sourceType,
    url: p.routes[0]?.urls[0] ?? null,
    urls: p.routes.flatMap((r) => r.urls),
    version: p.activeDeployment?.version ?? null,
  }
}

/** Wartet auf das Ende eines Deploys; gibt Status, Fehler und Log-Ende zurück. */
async function waitFor(dep: DeploymentDto, timeoutMs = 10 * 60_000) {
  const until = Date.now() + timeoutMs
  let d = dep
  while (['pending', 'pulling', 'starting', 'healthchecking'].includes(d.status) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000))
    const row = await getDeployment(dep.id)
    d = { ...d, status: row.status, errorMessage: row.errorMessage, version: row.version }
  }
  const tail = readLog(dep.id).trim().split('\n').slice(-20).join('\n')
  return {
    deployment: dep.id,
    status: d.status,
    version: d.version,
    error: d.errorMessage,
    ...(d.status === 'failed' ? { log_tail: tail } : {}),
    ...(['pending', 'pulling', 'starting', 'healthchecking'].includes(d.status) ? { note: 'Läuft noch; get_project zeigt den Stand' } : {}),
  }
}

export function createMcpServer(identity: TokenIdentity): McpServer {
  const actor = `token:${identity.name}`
  const server = new McpServer(
    { name: 'deployer', version: '0.3.0' },
    {
      instructions:
        'deployer bringt Projekte auf den Homeserver. Für eine Seite aus dem Chat: create_project mit ' +
        'source {type: "files"} und den Dateien; spätere Änderungen mit update_files. Löschen und Rollback ' +
        'verlangen eine Bestätigung.',
    },
  )

  /** Registriert ein Werkzeug mit Audit und einheitlicher Fehlerbehandlung. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
  ) {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        const r = await handler(args)
        await audit({ actor, action: `mcp.${name}`, params: auditParams(args as Record<string, unknown>), result: r.isError ? 'error' : 'ok' })
        return r
      } catch (err) {
        const msg = err instanceof AppError || err instanceof z.ZodError ? (err as Error).message : 'Interner Fehler'
        await audit({ actor, action: `mcp.${name}`, params: auditParams(args as Record<string, unknown>), result: 'error', error: (err as Error).message })
        return fail(msg)
      }
    }) as never)
  }

  /**
   * Bestätigung: per Elicitation, wenn der Client sie kann; sonst über ein
   * confirmation_token und einen zweiten Aufruf.
   */
  async function confirm(
    toolName: string,
    params: Record<string, unknown>,
    summary: string,
  ): Promise<{ go: true } | { go: false; result: ToolResult }> {
    const token = params.confirmation_token
    if (typeof token === 'string' && token) {
      const r = consumeConfirmation(token, identity.id, toolName, params)
      if (r === 'ok') return { go: true }
      const why = r === 'expired' ? 'ist abgelaufen (5 Minuten)' : r === 'mismatch' ? 'passt nicht zu diesem Aufruf' : 'ist unbekannt oder schon benutzt'
      return { go: false, result: fail(`Das Bestätigungs-Token ${why}. Ohne Token erneut aufrufen, um ein neues zu bekommen.`) }
    }
    if (server.server.getClientCapabilities()?.elicitation) {
      const res = await server.server.elicitInput({
        mode: 'form',
        message: summary,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Ja, ausführen' } },
          required: ['confirm'],
        },
      })
      if (res.action === 'accept' && res.content?.confirm === true) return { go: true }
      return { go: false, result: ok({ cancelled: true, message: 'Nicht bestätigt, nichts geändert.' }) }
    }
    const t = issueConfirmation(identity.id, toolName, params)
    return {
      go: false,
      result: ok({
        needs_confirmation: true,
        summary,
        confirmation_token: t,
        expires_in_seconds: 300,
        how: `Dasselbe Werkzeug mit denselben Parametern und confirmation_token="${t}" erneut aufrufen.`,
      }),
    }
  }

  /* --- Lesen ----------------------------------------------------------------- */

  tool('list_projects', 'Alle Projekte mit Status und Adresse', {}, async () => {
    return ok((await listProjects()).map(summarize))
  })

  tool('get_project', 'Ein Projekt mit Adressen, letzten Deployments und Umgebungsvariablen (Secrets ohne Wert)', { project }, async (a) => {
    const p = await findProject(a.project)
    const dto = await toDto(p)
    const deployments = (await listDeployments(p.id, 5)).map((d) => ({
      id: d.id, status: d.status, version: d.version, started: d.startedAt, trigger: d.trigger, error: d.errorMessage, can_rollback: d.canRollback,
    }))
    const files = p.sourceType === 'files' ? await listProjectFiles(p.id).catch(() => null) : null
    return ok({
      ...summarize(dto),
      port: dto.port,
      keep: dto.keep,
      deployments,
      env: (await listEnvDto(p.id)).map((e) => ({ key: e.key, secret: e.isSecret, value: e.value })),
      ...(files ? { files: files.files.length, commit: files.commit } : {}),
    })
  })

  tool('get_logs', 'Container-Logs eines Projekts (höchstens 500 Zeilen)', {
    project,
    lines: z.number().int().min(1).max(500).default(100),
    since: z.string().optional().describe('ISO-Zeitpunkt, ab dem Logs kommen sollen'),
  }, async (a) => {
    const p = await findProject(a.project)
    const row = await activeDeployment(p.id)
    const container = row?.containerId ?? row?.artifact?.webContainer
    if (!container) return ok({ logs: '', note: 'Kein laufender Container (statische Seite oder noch nicht deployt)' })
    const since = a.since ? Math.floor(new Date(a.since).getTime() / 1000) : undefined
    return ok({ logs: await docker.getLogs(container, { tail: a.lines, ...(since ? { since } : {}) }) })
  })

  tool('list_domains', 'Verwaltete Domains (kommt mit Meilenstein 5)', {}, async () => {
    return ok({ domains: [], note: 'Domains und DNS kommen mit Meilenstein 5. Bis dahin sind Projekte intern erreichbar.' })
  })

  /* --- Anlegen und Dateien --------------------------------------------------- */

  tool('create_project', 'Projekt anlegen und deployen. Für Chat-Projekte source {type:"files"} und files [{path, content}].', {
    name: z.string().min(1).max(120),
    source: z.record(z.unknown()).describe('z.B. {type:"files"}, {type:"image", image:"nginx:alpine"}, {type:"dockerfile", repoUrl}'),
    files: z.array(fileInputSchema).max(2000).optional(),
    port: z.number().int().min(1).max(65535).optional().describe('Port im Container; nötig bei Image, Dockerfile, Compose'),
    env: z.array(envEntryInputSchema).max(200).optional(),
    targets: z.array(z.enum(routeTargets)).default(['lan']),
    subdomain: z.string().optional(),
    wait,
  }, async (a) => {
    if (a.targets.includes('public')) return fail(PUBLIC_LATER)
    const input = createProjectSchema.parse({
      name: a.name, source: sourceSchema.parse(a.source), files: a.files, port: a.port,
      env: a.env ?? [], targets: a.targets.filter((t) => t !== 'public'), subdomain: a.subdomain,
    })
    assertSourceSupported(input.source.type)
    await checkSourceEarly(input.source, input.slug ?? slugify(input.name))
    const p = input.source.type === 'files' ? await createFilesProject(input, actor) : await createProject(input, actor)
    const dep = await startDeploy(p.id, actor)
    const result = a.wait ? await waitFor(dep) : { deployment: dep.id, status: dep.status }
    return ok({ ...summarize(await toDto(await findProject(p.id))), deploy: result })
  })

  tool('update_files', 'Geänderte oder gelöschte Dateien eines Chat-Projekts committen und neu deployen', {
    project,
    files: z.array(fileInputSchema).max(2000).optional(),
    delete: z.array(z.string()).max(2000).optional(),
    message: z.string().min(1).max(500),
    port: z.number().int().min(1).max(65535).optional().describe('Port setzen, falls das Projekt jetzt ein Dockerfile oder Compose hat'),
    deploy: z.boolean().default(true),
    wait,
  }, async (a) => {
    const r = await updateProjectFiles(a.project, { files: a.files, delete: a.delete, message: a.message }, actor)
    if (a.port) await updateProject(r.project.id, { port: a.port })
    if (!a.deploy) return ok({ commit: r.commit, changed: r.changed })
    if (!r.changed && !a.port) return ok({ commit: r.commit, changed: false, note: 'Keine Änderung, kein Deploy' })
    const dep = await startDeploy(r.project.id, actor)
    const result = a.wait ? await waitFor(dep) : { deployment: dep.id, status: dep.status }
    return ok({ commit: r.commit, changed: r.changed, ...summarize(await toDto(await findProject(r.project.id))), deploy: result })
  })

  tool('read_files', 'Aktueller Stand der Dateien eines Chat-Projekts (optional nur bestimmte Pfade; höchstens 2 MB)', {
    project,
    paths: z.array(z.string()).max(500).optional(),
  }, async (a) => ok(await readProjectFiles(a.project, a.paths)))

  tool('export_repo', 'Chat-Projekt als ZIP holen oder auf ein Git-Repo schieben', {
    project,
    format: z.enum(['zip', 'push']),
    push_url: z.string().optional().describe('Bei push: https://-URL des Ziel-Repos'),
    push_branch: z.string().default('main'),
    push_token: z.string().optional().describe('Bei push: Zugangs-Token; wird nie gespeichert oder geloggt'),
  }, async (a) => {
    if (a.format === 'zip') {
      const { zip, commit } = await exportProjectZip(a.project, actor)
      if (zip.length > 20 * 1024 * 1024) return fail('ZIP grösser als 20 MB')
      const p = await findProject(a.project)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ commit, bytes: zip.length }) },
          { type: 'resource', resource: { uri: `deployer://export/${p.slug}.zip`, mimeType: 'application/zip', blob: zip.toString('base64') } },
        ],
      }
    }
    if (!a.push_url) throw badRequest('push_url fehlt')
    return ok(await pushProjectRepo(a.project, { url: a.push_url, branch: a.push_branch, token: a.push_token }, actor))
  })

  /* --- Betrieb ---------------------------------------------------------------- */

  tool('deploy', 'Neu deployen (optional mit Branch, Tag oder Commit)', {
    project, ref: z.string().max(255).optional(), wait,
  }, async (a) => {
    const dep = await startDeploy(a.project, actor, a.ref)
    const result = a.wait ? await waitFor(dep) : { deployment: dep.id, status: dep.status }
    return ok({ ...summarize(await toDto(await findProject(a.project))), deploy: result })
  })

  tool('start', 'Projekt starten', { project }, async (a) => {
    const r = await startProject(a.project, actor)
    const result = r.deployment ? await waitFor(r.deployment) : null
    return ok({ ...summarize(await toDto(await findProject(a.project))), ...(result ? { deploy: result } : {}) })
  })

  tool('stop', 'Projekt stoppen (nicht löschen)', { project }, async (a) => {
    await stopProject(a.project, actor)
    return ok(summarize(await toDto(await findProject(a.project))))
  })

  tool('rollback', 'Auf eine frühere Fassung zurückrollen (verlangt Bestätigung)', {
    project,
    version: z.string().uuid().optional().describe('Deployment-ID; ohne Angabe die vorherige erfolgreiche Fassung'),
    confirmation_token: z.string().optional(),
    wait,
  }, async (a) => {
    const p = await findProject(a.project)
    const c = await confirm('rollback', { project: p.id, version: a.version ?? null, confirmation_token: a.confirmation_token }, `Projekt "${p.name}" auf ${a.version ? `Fassung ${a.version}` : 'die vorherige Fassung'} zurückrollen?`)
    if (!c.go) return c.result
    const dep = await startRollback(p.id, actor, a.version)
    const result = a.wait ? await waitFor(dep) : { deployment: dep.id, status: dep.status }
    return ok({ ...summarize(await toDto(await findProject(p.id))), deploy: result })
  })

  tool('delete_project', 'Projekt löschen mit Containern, Netz, Route und Dateien (verlangt Bestätigung)', {
    project,
    purge_volumes: z.boolean().default(false).describe('Auch benannte Volumes (Daten) löschen'),
    confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    const c = await confirm('delete_project', { project: p.id, purge_volumes: a.purge_volumes, confirmation_token: a.confirmation_token }, `Projekt "${p.name}" (${p.slug}) endgültig löschen${a.purge_volumes ? ', samt Daten-Volumes' : ''}?`)
    if (!c.go) return c.result
    await deleteProject(p.id, actor, a.purge_volumes)
    return ok({ deleted: p.slug })
  })

  tool('set_targets', 'Erreichbarkeit setzen (in M3 nur "lan")', {
    project,
    targets: z.array(z.enum(routeTargets)),
    subdomain: z.string().optional(),
  }, async (a) => {
    if (a.targets.includes('public')) return fail(PUBLIC_LATER)
    const p = await findProject(a.project)
    await setRoutes(p.id, p.slug, a.targets, a.subdomain)
    await reconcileCaddy()
    return ok(summarize(await toDto(await findProject(p.id))))
  })

  return server
}
