/**
 * M9, Etappe 2: Durchsetzung der Umgebungen über REST und MCP, gegen ein
 * Wegwerf-Postgres.
 *
 *   pnpm --filter @airlock/api exec tsx scripts/m9-scope-e2e.ts
 *
 * Zwei Umgebungen A und B, je ein Projekt und ein Token. Abnahme laut
 * docs/MILESTONE-9.md: Ein Objekt aus A ist über das Token aus B weder
 * lesbar noch änderbar – für JEDEN REST-Pfad mit Objekt (aus der Liste
 * aller registrierten Routen) und JEDES MCP-Werkzeug (aus tools/list). Die
 * Antwort ist byte-gleich zu der für ein unbekanntes Objekt.
 */
import { randomUUID } from 'node:crypto'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const pgc = await startThrowawayPostgres('airlock-m9-scope-e2e')
const { check, done } = checker()

try {
  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const { importLegacySettings, reloadEnvironments } = await import('../src/domain/environments.js')
  const { loadCloudflareSettings } = await import('../src/domain/cloudflare-settings.js')
  const { createToken, verifyToken } = await import('../src/domain/tokens.js')
  const { inEnvironment } = await import('../src/lib/scope.js')
  const { buildApp, registeredRoutes } = await import('../src/http/app.js')
  const { GUARDED_PREFIXES } = await import('../src/http/scope.js')
  const { createMcpServer } = await import('../src/mcp/server.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

  await runMigrations(() => {})
  await importLegacySettings()
  await pool.query("UPDATE environments SET name = 'Privat', slug = 'privat', short = 'PR', zone_name = 'example.ch'")
  await pool.query("INSERT INTO environments (slug, name, short, zone_name) VALUES ('verein', 'Verein', 'VB', 'verein-beispiel.ch')")
  await reloadEnvironments()
  await loadCloudflareSettings()
  const envA = (await pool.query("SELECT id FROM environments WHERE slug = 'privat'")).rows[0].id as string
  const envB = (await pool.query("SELECT id FROM environments WHERE slug = 'verein'")).rows[0].id as string

  /* --- Daten in A und B --------------------------------------------------------- */
  const ins = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].id as string
  const pA = await ins("INSERT INTO projects (name, slug, source_type, environment_id) VALUES ('Alpha', 'alpha', 'files', $1) RETURNING id", [envA])
  const pB = await ins("INSERT INTO projects (name, slug, source_type, environment_id) VALUES ('Beta', 'beta', 'image', $1) RETURNING id", [envB])
  await pool.query("INSERT INTO routes (project_id, target, hostname) VALUES ($1, 'tailnet', 'alpha.int.example.ch'), ($2, 'tailnet', 'beta.int.verein-beispiel.ch')", [pA, pB])
  const depA = await ins("INSERT INTO deployments (project_id, status) VALUES ($1, 'failed') RETURNING id", [pA])
  const scanA = await ins("INSERT INTO scan_runs (project_id, deployment_id, status) VALUES ($1, $2, 'done') RETURNING id", [pA, depA])
  const findA = await ins("INSERT INTO findings (scan_run_id, tool, severity, title, location, fingerprint) VALUES ($1, 'trivy', 'high', 'CVE', 'x', 'fp-a') RETURNING id", [scanA])
  const fixA = await ins("INSERT INTO fix_requests (project_id, fingerprint, finding_title, tool, actor, finding_id) VALUES ($1, 'fp-a', 'CVE', 'trivy', 'ui:joel', $2) RETURNING id", [pA, findA])
  const tgtA = await ins("INSERT INTO external_targets (hostname, txt_token, environment_id) VALUES ('shop.example.ch', 'x', $1) RETURNING id", [envA])
  await pool.query("INSERT INTO external_targets (hostname, txt_token, environment_id) VALUES ('kasse.verein-beispiel.ch', 'y', $1)", [envB])
  await pool.query("INSERT INTO domains (cf_zone_id, name, environment_id) VALUES ('za', 'example.ch', $1), ('zb', 'verein-beispiel.ch', $2)", [envA, envB])
  await pool.query("INSERT INTO audit_events (actor, action, target_type, target_id, result, environment_id) VALUES ('ui:joel', 'project.deploy', 'project', $1, 'ok', $2)", [pA, envA])
  await pool.query("INSERT INTO audit_events (actor, action, result) VALUES ('ui:joel', 'auth.login', 'ok')")
  const tokA = await createToken(inEnvironment(envA), 'Token A', 'ui:joel')
  const tokB = await createToken(inEnvironment(envB), 'Token B', 'ui:joel')

  const state = async () => JSON.stringify((await pool.query(`SELECT
      (SELECT count(*) FROM projects) p, (SELECT count(*) FROM api_tokens WHERE revoked_at IS NULL) t,
      (SELECT count(*) FROM external_targets) e, (SELECT status FROM fix_requests WHERE id = $1) f,
      (SELECT status FROM findings WHERE id = $2) fi, (SELECT desired_state FROM projects WHERE id = $3) d,
      (SELECT count(*) FROM header_rules) h, (SELECT count(*) FROM routes) r, (SELECT count(*) FROM deployments) dep,
      (SELECT count(*) FROM scan_runs) s`, [fixA, findA, pA])).rows[0])
  const before = await state()

  /* --- REST: jeder Pfad mit Objekt -------------------------------------------------- */
  const app = await buildApp()
  await app.ready()
  const authB = { authorization: `Bearer ${tokB.token}` }
  const authA = { authorization: `Bearer ${tokA.token}` }

  const own = (url: string) => url
    .replace(':env', 'privat').replace(':finding', findA).replace(':fix', fixA).replace(':header', 'referrer-policy').replace(':key', 'x')
  const fill = (url: string, foreign: boolean): string => {
    const objectId = url.startsWith('/api/v1/projects/:id') ? pA
      : url.startsWith('/api/v1/deployments/:id') ? depA
      : url.startsWith('/api/v1/scans/:id') ? scanA
      : url.startsWith('/api/v1/findings/:id') ? findA
      : url.startsWith('/api/v1/external-targets/:id') ? tgtA
      : url.startsWith('/api/v1/tokens/:id') ? tokA.dto.id
      : randomUUID()
    const unknown = randomUUID()
    const u = own(url).replace(':id', foreign ? objectId : unknown)
    return foreign ? u : u.replace('/environments/privat', '/environments/gibt-es-nicht')
  }

  const withParams = registeredRoutes.filter((r) => r.url.startsWith('/api/v1/') && r.url.includes(':') && r.method !== 'HEAD' && r.url !== '/api/v1/csp-reports/:key')
  check(withParams.length > 40, `REST: ${withParams.length} Pfade mit Objekt gefunden`)
  const unguarded = withParams.filter((r) => !GUARDED_PREFIXES.some((p) => r.url.startsWith(p)))
  check(unguarded.length === 0, 'REST: jeder Pfad mit Objekt fällt unter die zentrale Prüfung', unguarded)

  let restSame = 0
  const restDiff: unknown[] = []
  for (const r of withParams) {
    const method = r.method as 'GET'
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined
    const foreign = await app.inject({ method, url: fill(r.url, true), headers: authB, ...(body ? { payload: body } : {}) })
    const unknown = await app.inject({ method, url: fill(r.url, false), headers: authB, ...(body ? { payload: body } : {}) })
    const okStatus = foreign.statusCode === 404 || foreign.statusCode === 403
    if (okStatus && foreign.statusCode === unknown.statusCode && foreign.body === unknown.body) restSame++
    else restDiff.push({ route: `${r.method} ${r.url}`, foreign: [foreign.statusCode, foreign.body.slice(0, 160)], unknown: [unknown.statusCode, unknown.body.slice(0, 160)] })
  }
  check(restDiff.length === 0, `REST: alle ${withParams.length} Pfade mit Objekt aus A antworten dem Token aus B wie für ein unbekanntes Objekt (404/403, gleicher Text)`, restDiff)

  // Slug statt ID
  const bySlug = await app.inject({ method: 'GET', url: '/api/v1/projects/alpha', headers: authB })
  const bySlugUnknown = await app.inject({ method: 'GET', url: '/api/v1/projects/gibt-es-nicht', headers: authB })
  check(bySlug.statusCode === 404 && bySlug.body === bySlugUnknown.body, 'REST: Slug aus A über Token B → wie unbekannt', bySlug.body)

  // Gegenprobe: Token A sieht sein Projekt, Token B seins
  const okA = await app.inject({ method: 'GET', url: `/api/v1/projects/${pA}`, headers: authA })
  const okB = await app.inject({ method: 'GET', url: '/api/v1/projects/beta', headers: authB })
  check(okA.statusCode === 200 && okB.statusCode === 200, 'REST: Gegenprobe – eigene Projekte lesbar', [okA.statusCode, okB.statusCode])

  // Listen
  const listOf = async (url: string, key: string) => (await app.inject({ method: 'GET', url, headers: authB })).json()[key] as { slug?: string; hostname?: string; name?: string; targetId?: string | null }[]
  const projectsB = await listOf('/api/v1/projects', 'projects')
  check(projectsB.length === 1 && projectsB[0]!.slug === 'beta', 'REST: /projects zeigt Token B nur Beta', projectsB.map((p) => p.slug))
  const viaEnvA = await app.inject({ method: 'GET', url: '/api/v1/projects?environment=privat', headers: authB })
  const viaEnvX = await app.inject({ method: 'GET', url: '/api/v1/projects?environment=gibt-es-nicht', headers: authB })
  check(viaEnvA.statusCode === 404 && viaEnvA.body === viaEnvX.body, 'REST: ?environment=privat mit Token B → wie unbekannte Umgebung')
  const targetsB = await listOf('/api/v1/external-targets', 'targets')
  check(targetsB.length === 1 && targetsB[0]!.hostname === 'kasse.verein-beispiel.ch', 'REST: externe Ziele nur aus B', targetsB.map((t) => t.hostname))
  const domainsB = await listOf('/api/v1/domains', 'domains')
  check(domainsB.length === 1 && domainsB[0]!.name === 'verein-beispiel.ch', 'REST: Domains nur aus B', domainsB.map((d) => d.name))
  const auditB = await listOf('/api/v1/audit', 'events')
  check(!auditB.some((e) => e.targetId === pA) && auditB.some((e) => (e as { action?: string }).action === 'auth.login'), 'REST: Audit ohne Einträge aus A, mit Server-Ereignissen', auditB)
  const tokensViaToken = await app.inject({ method: 'GET', url: '/api/v1/tokens', headers: authB })
  check(tokensViaToken.statusCode === 403, 'REST: Tokens verwalten weiter nur mit Anmeldung')

  /* --- MCP: jedes Werkzeug --------------------------------------------------------- */
  const identityB = (await verifyToken(tokB.token))!
  check(identityB.environmentId === envB, 'MCP: Identität trägt die Umgebung des Tokens')
  const server = createMcpServer(identityB)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'm9-test', version: '1' })
  await client.connect(ct)
  const { tools } = await client.listTools()
  check(tools.length >= 25, `MCP: ${tools.length} Werkzeuge`)

  const value = (key: string, foreign: boolean): unknown => ({
    project: foreign ? 'alpha' : 'gibt-es-nicht',
    hostname: foreign ? 'shop.example.ch' : 'unbekannt.example.org',
    finding: findA, fix: fixA, header: 'referrer-policy', reason: 'Begründung für den Test',
    message: 'Test', targets: ['tailnet'], format: 'zip', explanation: 'Test', files: [{ path: 'a.txt', content: 'x' }],
    scan: scanA, confirmation_token: 'x', wait: false,
  } as Record<string, unknown>)[key]

  let mcpChecked = 0
  const mcpDiff: unknown[] = []
  const scopeFree: string[] = []
  for (const t of tools) {
    const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
    const required = ((t.inputSchema as { required?: string[] }).required ?? [])
    // add_external_target legt an (kein Nachschlagen): eigener Fall unten
    const target = t.name === 'add_external_target' ? null : props.includes('project') ? 'project' : props.includes('hostname') ? 'hostname' : null
    if (!target) {
      scopeFree.push(t.name)
      continue
    }
    const build = (foreign: boolean) => {
      const a: Record<string, unknown> = {}
      for (const k of props) {
        if (k === 'hostname' && target === 'project') continue
        if (k === 'project' && target === 'hostname') continue
        if (k === 'confirmation_token' || k === 'scan') continue
        const v = value(k, foreign)
        if (v !== undefined && (required.includes(k) || k === target)) a[k] = v
      }
      return a
    }
    const missing = required.filter((k) => build(true)[k] === undefined)
    if (missing.length) {
      mcpDiff.push({ tool: t.name, fehlende_testwerte: missing })
      continue
    }
    const foreign = await client.callTool({ name: t.name, arguments: build(true) })
    const unknown = await client.callTool({ name: t.name, arguments: build(false) })
    mcpChecked++
    const f = JSON.stringify(foreign.content)
    const u = JSON.stringify(unknown.content)
    const same = foreign.isError === true && unknown.isError === true && f === u
    if (!same) mcpDiff.push({ tool: t.name, foreign: f.slice(0, 200), unknown: u.slice(0, 200) })
  }
  check(mcpDiff.length === 0, `MCP: alle ${mcpChecked} Werkzeuge mit Projekt oder Hostname antworten für A wie für ein unbekanntes Ziel`, mcpDiff)
  // Hostname-Variante für Werkzeuge, die beides kennen
  for (const name of ['run_scan', 'get_scan_report']) {
    const f = await client.callTool({ name, arguments: { hostname: 'shop.example.ch', wait: false } })
    const u = await client.callTool({ name, arguments: { hostname: 'unbekannt.example.org', wait: false } })
    check(f.isError === true && JSON.stringify(f.content) === JSON.stringify(u.content), `MCP: ${name} mit externem Ziel aus A → wie unbekannt`, [f.content, u.content])
  }
  check(scopeFree.sort().join(',') === 'add_external_target,create_project,list_domains,list_projects', 'MCP: ohne Projekt/Hostname nur Listen und Anlegen', scopeFree)
  const lp = JSON.parse(((await client.callTool({ name: 'list_projects', arguments: {} })).content as { text: string }[])[0]!.text) as { project: string }[]
  check(lp.length === 1 && lp[0]!.project === 'beta', 'MCP: list_projects zeigt nur Beta', lp)
  const add = await client.callTool({ name: 'add_external_target', arguments: { hostname: 'shop.example.ch' } })
  check(add.isError === true, 'MCP: externes Ziel aus A nicht über B neu anlegbar (Hostname serverweit eindeutig)')

  const after = await state()
  check(after === before, 'Nichts in A verändert (Projekte, Tokens, Ziele, Vorschlag, Befund, Zustand, Header, Routen, Deployments, Scans)', { before, after })
  const mcpAudit = (await pool.query("SELECT DISTINCT environment_id FROM audit_events WHERE action LIKE 'mcp.%'")).rows
  check(mcpAudit.length === 1 && mcpAudit[0].environment_id === envB, 'MCP-Aufrufe stehen im Audit der Umgebung des Tokens (B)', mcpAudit)

  await client.close()
  await app.close()
  await pool.end()
} catch (err) {
  console.error(err)
  check(false, 'Ablauf ohne Ausnahme', String(err))
} finally {
  pgc.stop()
}
done()
