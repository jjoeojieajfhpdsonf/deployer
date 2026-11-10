import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createProjectSchema, sourceSchema, envEntryInputSchema, fileInputSchema, routeTargets } from '@deployer/shared'
import { listProjects, findProject, toDto, createProject, deleteProject, updateProject, assertSourceSupported } from '../domain/projects.js'
import { listDeployments, getDeployment, activeDeployment } from '../domain/deployments.js'
import { listEnvDto } from '../domain/env.js'
import { setRoutes, reconcileCaddy } from '../domain/routes.js'
import {
  planPublic, applyPublic, removePublic, publicEnabled, listDomains, syncDomains,
  publicRoute, publicStatus, publishability, pauseFlow, resumeFlow, unpublishFlow,
} from '../domain/public.js'
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
import { enqueueProjectScan, enqueueExternalScan, scanReport, latestScan, latestExternalScan, scanBelongsTo, acceptFinding, findingProject } from '../security/scan.js'
import { addExternalTarget, verifyExternalTarget, findExternalTarget } from '../security/external-targets.js'
import { describeScan, describeStages } from '../security/progress.js'
import { requestPublic, mcpRequestInfo } from '../domain/public-requests.js'
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
        'verlangen eine Bestätigung, ebenso öffentlich pausieren (pause_public), fortsetzen (resume_public) ' +
        'und ganz offline nehmen (unpublish).',
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

  tool('list_domains', 'Domains (Zonen bei Cloudflare) für öffentliche Projekte und welche Standard ist', {}, async () => {
    if (!publicEnabled()) return ok({ domains: [], note: 'Öffentlich ist nicht eingerichtet (Cloudflare-Konto, Tunnel und Token fehlen). Projekte sind intern erreichbar.' })
    const domains = await listDomains().then((d) => (d.length ? d : syncDomains()))
    return ok({ domains: domains.map((d) => ({ name: d.name, default: d.isDefault })) })
  })

  /* --- Anlegen und Dateien --------------------------------------------------- */

  tool('create_project', 'Projekt anlegen und deployen. Für Chat-Projekte source {type:"files"} und files [{path, content}]. Standard-Erreichbarkeit: nur Tailnet (Tailscale ist die Hauptadresse); "lan" auf Wunsch dazu.', {
    name: z.string().min(1).max(120),
    source: z.record(z.unknown()).describe('z.B. {type:"files"}, {type:"image", image:"nginx:alpine"}, {type:"dockerfile", repoUrl}'),
    files: z.array(fileInputSchema).max(2000).optional(),
    port: z.number().int().min(1).max(65535).optional().describe('Port im Container; nötig bei Image, Dockerfile, Compose'),
    env: z.array(envEntryInputSchema).max(200).optional(),
    targets: z.array(z.enum(routeTargets)).default(['tailnet']).describe('"public" wird vorgemerkt: öffentlich erst nach bestandenem Scan und Bestätigung in der Oberfläche'),
    subdomain: z.string().optional(),
    public_subdomain: z.string().optional().describe('Für die vorgemerkte Öffentlich-Anfrage: Subdomain der Standard-Domain'),
    public_hostname: z.string().optional().describe('Für die vorgemerkte Öffentlich-Anfrage: voller Hostname'),
    access: z.boolean().optional().describe('Für die vorgemerkte Öffentlich-Anfrage: Cloudflare Access davorschalten'),
    wait,
  }, async (a) => {
    const wantsPublic = a.targets.includes('public')
    if (wantsPublic && !publicEnabled()) return fail('Öffentlich ist nicht eingerichtet: Cloudflare-Konto, Tunnel und Token fehlen. Projekt ohne "public" anlegen.')
    const internal = a.targets.filter((t) => t !== 'public')
    const input = createProjectSchema.parse({
      name: a.name, source: sourceSchema.parse(a.source), files: a.files, port: a.port,
      // Nur "public" gewünscht: intern trotzdem über das Tailnet erreichbar
      env: a.env ?? [], targets: internal.length ? internal : ['tailnet'], subdomain: a.subdomain,
    })
    assertSourceSupported(input.source.type)
    await checkSourceEarly(input.source, input.slug ?? slugify(input.name))
    const p = input.source.type === 'files' ? await createFilesProject(input, actor) : await createProject(input, actor)
    // Öffentlich geht erst nach dem Scan (M6): vormerken statt still verwerfen
    const req = wantsPublic
      ? await requestPublic(p.id, { subdomain: a.public_subdomain, hostname: a.public_hostname, accessProtected: a.access }, actor, 'beim Anlegen: noch kein Scan')
      : null
    const dep = await startDeploy(p.id, actor)
    const result = a.wait ? await waitFor(dep) : { deployment: dep.id, status: dep.status }
    return ok({
      ...summarize(await toDto(await findProject(p.id))),
      deploy: result,
      ...(req ? { public: mcpRequestInfo(req, await publishability(p.id)) } : {}),
    })
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

  /* --- Security (M6) ---------------------------------------------------------- */

  tool('run_scan', 'Security-Scan starten: Projekt oder nachgewiesene externe Domain. "active" (XSS, SQL-Injection) verlangt Bestätigung und geht nur gegen Projekte.', {
    project: z.string().min(1).max(64).optional(),
    hostname: z.string().min(1).max(253).optional().describe('Externe Domain; nur nach TXT-Nachweis'),
    level: z.enum(['standard', 'active']).default('standard'),
    confirmation_token: z.string().optional(),
  }, async (a) => {
    if (!!a.project === !!a.hostname) return fail('Entweder project oder hostname angeben')
    if (a.hostname) {
      const t = await findExternalTarget(a.hostname)
      if (a.level === 'active') {
        const c = await confirm('run_scan', { hostname: t.id, level: a.level, confirmation_token: a.confirmation_token }, `Aktiven Scan (Angriffstests) gegen die externe Domain ${t.hostname} starten? Vorher die Bedingungen des Hosters prüfen.`)
        if (!c.go) return c.result
      }
      const run = await enqueueExternalScan(t.id, { level: a.level, actor, trigger: 'mcp' })
      return ok({ scan: run.id, status: run.status, note: 'Läuft im Hintergrund; get_scan_report mit dem Hostnamen zeigt das Ergebnis' })
    }
    const p = await findProject(a.project!)
    if (a.level === 'active') {
      const c = await confirm('run_scan', { project: p.id, level: a.level, confirmation_token: a.confirmation_token }, `Aktiven Scan (XSS, SQL-Injection) gegen "${p.name}" starten? Er läuft nur gegen den internen Container und kann Daten verändern.`)
      if (!c.go) return c.result
    }
    const run = await enqueueProjectScan(p.id, { level: a.level, actor, trigger: 'mcp' })
    return ok({ scan: run.id, status: run.status, note: 'Läuft im Hintergrund; get_scan_report zeigt das Ergebnis' })
  })

  tool('get_scan_report', 'Ergebnis des letzten (oder eines bestimmten) Scans eines Projekts oder einer externen Domain: Adresse, Status, Score, Note und die drei wichtigsten Befunde', {
    project: z.string().min(1).max(64).optional(),
    hostname: z.string().min(1).max(253).optional().describe('Externe Domain statt Projekt'),
    scan: z.string().uuid().optional(),
    wait: z.boolean().default(true).describe('Auf einen laufenden Scan kurz warten (höchstens 50 Sekunden, dann Zwischenstand; erneut aufrufen)'),
    all: z.boolean().default(false).describe('Alle Befunde statt nur der wichtigsten'),
  }, async (a) => {
    if (!!a.project === !!a.hostname) return fail('Entweder project oder hostname angeben')
    let head: Record<string, unknown>
    let id: string | undefined
    let owner: { projectId?: string; externalTargetId?: string }
    if (a.hostname) {
      const t = await findExternalTarget(a.hostname)
      head = { hostname: t.hostname, url: `https://${t.hostname}`, verified: t.verifiedAt !== null }
      owner = { externalTargetId: t.id }
      id = a.scan ?? (await latestExternalScan(t.id))?.id
    } else {
      const p = await findProject(a.project!)
      const dto = await toDto(p)
      head = { project: p.slug, url: dto.routes[0]?.urls[0] ?? null, status: dto.status }
      owner = { projectId: p.id }
      id = a.scan ?? (await latestScan(p.id))?.id
    }
    if (!id) return ok({ ...head, report: null, note: 'Noch kein Scan. run_scan startet einen.' })
    if (!(await scanBelongsTo(id, owner))) return fail('Dieser Scan gehört zu einem anderen Ziel')
    // Unter der üblichen Zeitgrenze von MCP-Clients (60 s) bleiben; ein
    // abgebrochener Aufruf hinterliesse sonst eine Schleife auf dem Server.
    const until = Date.now() + 50_000
    let r = await scanReport(id)
    while (a.wait && ['queued', 'running'].includes(r.scan.status) && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 3000))
      r = await scanReport(id)
    }
    return ok({
      ...head,
      scan: describeScan(r.scan),
      score: r.scan.score,
      grade: r.scan.grade,
      open: r.counts,
      top: r.top,
      ...(a.all ? { findings: r.findings.map((f) => ({ id: f.id, severity: f.severity, status: f.status, title: f.title, location: f.location, fix: f.fix })) } : {}),
      stages: describeStages(r.scan.stages),
      ...(['queued', 'running'].includes(r.scan.status) ? { note: 'Scan läuft noch; get_scan_report in einer Minute erneut aufrufen' } : {}),
    })
  })

  tool('accept_finding', 'Befund mit Begründung akzeptieren (zählt dann nicht mehr; verlangt Bestätigung, steht im Audit-Log)', {
    project: z.string().min(1).max(64),
    finding: z.string().uuid(),
    reason: z.string().min(3).max(1000),
    confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    // Vor der Rückfrage prüfen: der Befund muss zu diesem Projekt gehören,
    // sonst nennte die Rückfrage das falsche Projekt (Review M6).
    const own = await findingProject(a.finding)
    if (own !== p.id) return fail(`Befund ${a.finding} gehört nicht zu "${p.name}"`)
    const c = await confirm('accept_finding', { project: p.id, finding: a.finding, reason: a.reason, confirmation_token: a.confirmation_token }, `Befund ${a.finding} in "${p.name}" akzeptieren? Begründung: ${a.reason}`)
    if (!c.go) return c.result
    await acceptFinding(a.finding, a.reason, actor, { projectId: p.id })
    const last = await latestScan(p.id)
    return ok({ accepted: a.finding, score: last ? (await scanReport(last.id)).scan.score : null })
  })

  tool('add_external_target', 'Eigene Domain ausserhalb von deployer zum Scannen eintragen; liefert den nötigen TXT-Eintrag', {
    hostname: z.string().min(1).max(253),
  }, async (a) => {
    const t = await addExternalTarget(a.hostname, actor)
    return ok({ ...t, next: `TXT-Eintrag ${t.txt.name} mit dem Wert "${t.txt.value}" setzen, dann verify_external_target aufrufen.` })
  })

  tool('verify_external_target', 'TXT-Nachweis einer externen Domain über öffentliche DNS-Resolver prüfen', {
    hostname: z.string().min(1).max(253),
  }, async (a) => ok(await verifyExternalTarget(a.hostname, actor)))

  tool('set_targets', 'Erreichbarkeit setzen: "lan" und "tailnet" (dieselbe interne Adresse), "public" über Cloudflare Tunnel (Bestätigung nötig; nur mit abgeschlossenem Scan ohne offenen kritischen Befund)', {
    project,
    targets: z.array(z.enum(routeTargets)),
    subdomain: z.string().optional().describe('Interne Subdomain'),
    public_subdomain: z.string().optional().describe('Öffentlich: Subdomain der Standard-Domain (Standard: Slug)'),
    public_hostname: z.string().optional().describe('Öffentlich: voller Hostname in einer Zone des Kontos'),
    access: z.boolean().optional().describe('Öffentlich: Cloudflare Access davorschalten (Login per E-Mail-Code)'),
    confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    const wantsPublic = a.targets.includes('public')
    let plan: Awaited<ReturnType<typeof planPublic>> | null = null
    // Ohne "public", aber gerade öffentlich: das ist «ganz offline nehmen» – mit Rückfrage
    const current = wantsPublic ? null : await publicRoute(p.id)
    if (current) {
      const c = await confirm('set_targets', { project: p.id, targets: [...a.targets].sort(), confirmation_token: a.confirmation_token },
        `"${p.name}" GANZ OFFLINE nehmen: Tunnel-Regel und DNS-Eintrag für ${current.hostname} werden entfernt, der Name ist danach frei. Zum vorübergehenden Abschalten gibt es pause_public.`)
      if (!c.go) return c.result
    }
    if (wantsPublic) {
      if (!publicEnabled()) return fail('Öffentlich ist nicht eingerichtet: Cloudflare-Konto, Tunnel und Token fehlen (Meilenstein 5, siehe compose.public.yaml)')
      // Alles prüfen, bevor gefragt wird: sonst bestätigt man etwas, das dann
      // scheitert – oder ein Teil (interne Ziele) wäre schon umgestellt.
      try {
        plan = await planPublic(p, { subdomain: a.public_subdomain, hostname: a.public_hostname, accessProtected: a.access })
      } catch (err) {
        // Schwelle nicht erfüllt (Scan läuft, fehlt, kritischer Befund): interne
        // Ziele setzen und «öffentlich» vormerken statt still verwerfen.
        if (!(err instanceof AppError) || err.code !== 'not_publishable') throw err
        const internal = a.targets.filter((t) => t !== 'public')
        if (internal.length) {
          try {
            await setRoutes(p.id, p.slug, internal, a.subdomain)
          } finally {
            await reconcileCaddy()
          }
        }
        const gate = await publishability(p.id)
        const req = await requestPublic(p.id, { subdomain: a.public_subdomain, hostname: a.public_hostname, accessProtected: a.access }, actor, gate.ok ? 'Schwelle' : gate.why)
        return ok({ ...summarize(await toDto(await findProject(p.id))), public: mcpRequestInfo(req, gate) })
      }
      const before = plan.before
      const changes = !before || before.hostname !== plan.hostname || before.accessProtected !== plan.access
      if (changes) {
        const c = await confirm('set_targets', {
          project: p.id, targets: [...a.targets].sort(), public_subdomain: a.public_subdomain, public_hostname: a.public_hostname, access: a.access, confirmation_token: a.confirmation_token,
        }, `"${p.name}" ÖFFENTLICH im Internet erreichbar machen unter ${plan.hostname}${plan.access ? ' (hinter Cloudflare Access)' : ' (ohne Login)'}?`)
        if (!c.go) return c.result
      }
    }
    try {
      await setRoutes(p.id, p.slug, a.targets.filter((t) => t !== 'public'), a.subdomain)
      if (plan) await applyPublic(plan, actor)
      else await removePublic(p, actor, { skipCaddy: true })
    } finally {
      await reconcileCaddy()
    }
    return ok(summarize(await toDto(await findProject(p.id))))
  })

  /* --- Veröffentlichung: pausieren, fortsetzen, ganz offline ----------------------- */

  const internalNote = async (id: string) => {
    const s = await publicStatus(await findProject(id))
    return s.internalUrl ? `Intern bleibt es unter ${s.internalUrl} erreichbar.` : 'Eine interne Adresse hat das Projekt nicht.'
  }
  const publicResult = async (id: string, r: { hostname: string | null; check: unknown; changed: boolean }) => {
    const s = await publicStatus(await findProject(id))
    return ok({ project: (await findProject(id)).slug, public: s.state, hostname: s.hostname, access: s.accessProtected, changed: r.changed, check_from_outside: r.check, internal_url: s.internalUrl })
  }

  tool('pause_public', 'Öffentliches Projekt pausieren: Besucher sehen eine neutrale Wartungsseite (HTTP 503); Name, DNS-Eintrag und Tunnel-Regel bleiben. Verlangt Bestätigung.', {
    project, confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    const route = await publicRoute(p.id)
    if (!route) return fail(`"${p.name}" ist nicht öffentlich`)
    if (route.pausedAt) return publicResult(p.id, { hostname: route.hostname, check: null, changed: false })
    const c = await confirm('pause_public', { project: p.id, confirmation_token: a.confirmation_token },
      `"${p.name}" pausieren? Unter ${route.hostname} erscheint eine Wartungsseite (503), DNS und Name bleiben. ${await internalNote(p.id)}`)
    if (!c.go) return c.result
    return publicResult(p.id, await pauseFlow(p, actor))
  })

  tool('resume_public', 'Pausiertes öffentliches Projekt wieder online schalten (nur mit abgeschlossenem Scan ohne offenen kritischen Befund). Verlangt Bestätigung.', {
    project, confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    const route = await publicRoute(p.id)
    if (!route) return fail(`"${p.name}" ist nicht öffentlich`)
    if (!route.pausedAt) return publicResult(p.id, { hostname: route.hostname, check: null, changed: false })
    // Erst prüfen, dann fragen – bestätigt wird nur, was auch gehen kann.
    const pub = await publishability(p.id)
    if (!pub.ok) return fail(`Nicht fortsetzbar: ${pub.reason}`)
    const c = await confirm('resume_public', { project: p.id, confirmation_token: a.confirmation_token },
      `"${p.name}" wieder ÖFFENTLICH unter ${route.hostname}${route.accessProtected ? ' (hinter Cloudflare Access)' : ' (ohne Login)'}?`)
    if (!c.go) return c.result
    return publicResult(p.id, await resumeFlow(p, actor))
  })

  tool('unpublish', 'Öffentliches Projekt ganz offline nehmen: Tunnel-Regel, DNS-Eintrag und Access-App werden entfernt, der Name ist frei. Interne Ziele bleiben. Verlangt Bestätigung.', {
    project, confirmation_token: z.string().optional(),
  }, async (a) => {
    const p = await findProject(a.project)
    const route = await publicRoute(p.id)
    if (!route) return fail(`"${p.name}" ist nicht öffentlich`)
    const c = await confirm('unpublish', { project: p.id, confirmation_token: a.confirmation_token },
      `"${p.name}" GANZ OFFLINE nehmen? Tunnel-Regel und DNS-Eintrag für ${route.hostname} werden entfernt, der Name ist danach frei. ${await internalNote(p.id)}`)
    if (!c.go) return c.result
    return publicResult(p.id, await unpublishFlow(p, actor))
  })

  return server
}
