/**
 * M9, Abnahme: zwei Umgebungen von Anfang bis Ende über die Schnittstellen,
 * die Oberfläche, Skripte und Claude benutzen – REST (Anmeldung und Token)
 * und MCP (Token). Wegwerf-Postgres, zwei Cloudflare-Attrappen (zwei
 * Konten), kein Docker und kein Caddy (Deploys scheitern erwartungsgemäss,
 * Abgleiche nur im Log).
 *
 *   pnpm --filter @airlock/api exec tsx scripts/m9-acceptance-e2e.ts
 *
 * Ablauf: Standard-Umgebung verbinden (example.ch) → zweite Umgebung
 * «Verein» anlegen und verbinden (verein-beispiel.ch, eigenes Konto) →
 * Standards und Tokens je Umgebung → Claude legt per MCP ein Projekt in
 * «Verein» an → Trennung prüfen → Projekt nach example.ch verschieben →
 * «Verein» löschen.
 */
import { createServer } from 'node:http'
import { startFakeCloudflare } from '../src/lib/cf-fixture.js'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const TOKEN_1 = `cfut_${'A'.repeat(40)}`
const TOKEN_2 = `cfut_${'B'.repeat(40)}`
const f1 = await startFakeCloudflare(['example.ch'])
const f2 = await startFakeCloudflare(['verein-beispiel.ch'])
f1.token = TOKEN_1
f2.token = TOKEN_2
const proxy = createServer((req, res) => {
  const target = req.headers.authorization === `Bearer ${TOKEN_2}` ? f2 : f1
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const r = await fetch(`${target.url}${req.url!.replace(/^\/client\/v4/, '')}`, {
      method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body: body || undefined,
    })
    let text = await r.text()
    if (target === f2) text = text.replaceAll('acc-e2e-test', 'acc-zwei')
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(text)
  })
})
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
process.env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`

const pgc = await startThrowawayPostgres('airlock-m9-acceptance-e2e')
const { check, done } = checker()

try {
  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const envs = await import('../src/domain/environments.js')
  const { loadCloudflareSettings } = await import('../src/domain/cloudflare-settings.js')
  const { ensureAdminPassword } = await import('../src/http/auth.js')
  const { buildApp } = await import('../src/http/app.js')
  const { verifyToken } = await import('../src/domain/tokens.js')
  const { createMcpServer } = await import('../src/mcp/server.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

  await runMigrations(() => {})
  await envs.importLegacySettings()
  await loadCloudflareSettings()
  await ensureAdminPassword()
  const app = await buildApp()
  await app.ready()

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: process.env.ADMIN_PASSWORD } })
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  check(login.statusCode === 200 && Boolean(cookie), 'Anmeldung')
  const ui = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const bearer = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  /* --- 1: Standard-Umgebung verbinden --------------------------------------------- */
  const A = envs.defaultEnvironmentId()
  const t1 = await ui('PUT', `/environments/${A}/cloudflare/token`, { token: TOKEN_1 })
  const d1 = await ui('PUT', `/environments/${A}/cloudflare/domains`, { baseZone: 'example.ch', baseLabel: 'int', defaultZone: null, tailscaleIp: '100.88.41.12' })
  check(t1.statusCode === 200 && d1.statusCode === 200, 'Standard-Umgebung: Token und Hauptzone gespeichert', [t1.statusCode, t1.body.slice(0, 200), d1.statusCode])
  const list1 = (await ui('GET', '/environments')).json().environments as { slug: string; name: string; baseDomain: string | null; isDefault: boolean }[]
  check(list1.length === 1 && list1[0]!.slug === 'example' && list1[0]!.name === 'example.ch' && list1[0]!.baseDomain === 'int.example.ch', 'Standard-Umgebung heisst nach der Hauptzone: example.ch, /u/example, int.example.ch', list1)

  /* --- 2: zweite Umgebung mit eigenem Konto ---------------------------------------- */
  const created = await ui('POST', '/environments', { name: 'Verein', slug: 'verein', short: 'VB' })
  check(created.statusCode === 201, 'Umgebung «Verein» angelegt', created.body.slice(0, 200))
  const t2 = await ui('PUT', '/environments/verein/cloudflare/token', { token: TOKEN_2 })
  const d2 = await ui('PUT', '/environments/verein/cloudflare/domains', { baseZone: 'verein-beispiel.ch', baseLabel: 'int', defaultZone: null })
  check(t2.statusCode === 200 && d2.statusCode === 200, '«Verein»: eigenes Token und Hauptzone verein-beispiel.ch', [t2.statusCode, d2.statusCode, d2.body.slice(0, 200)])
  const tailnet2 = [...f2.records.values()].find((r) => r.type === 'A')
  check(tailnet2?.name === '*.int.verein-beispiel.ch' && tailnet2.content === '100.88.41.12', 'Tailnet-Eintrag in der Zone von «Verein» mit ihrem Token', tailnet2)
  const dupSlug = await ui('POST', '/environments', { name: 'Doppelt', slug: 'verein', short: 'DO' })
  check(dupSlug.statusCode === 400, 'zweite Umgebung mit demselben Kurznamen abgelehnt')

  /* --- 3: Standards und Tokens je Umgebung ----------------------------------------- */
  await ui('PUT', '/environments/example/header-templates/referrer-policy', { value: 'no-referrer' })
  await ui('PUT', '/environments/verein/header-templates/x-content-type-options', { value: 'nosniff' })
  const settingsB = (await ui('GET', '/environments/verein/settings')).json()
  check(settingsB.headerTemplates.length === 1 && settingsB.headerTemplates[0].header === 'x-content-type-options', 'Header-Vorlagen je Umgebung getrennt', settingsB.headerTemplates)
  const tokA = (await ui('POST', '/environments/example/tokens', { name: 'Claude Privat' })).json().token as string
  const tokB = (await ui('POST', '/environments/verein/tokens', { name: 'Claude Verein' })).json().token as string
  check(Boolean(tokA && tokB), 'Tokens je Umgebung angelegt')

  /* --- 4: Claude legt per MCP ein Projekt in «Verein» an ------------------------------ */
  const mcp = async (token: string) => {
    const server = createMcpServer((await verifyToken(token))!)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'm9-abnahme', version: '1' })
    await client.connect(ct)
    return client
  }
  const mcpB = await mcp(tokB)
  const mcpA = await mcp(tokA)
  check(/Umgebung «Verein»/.test(mcpB.getInstructions() ?? '') && /\*\.int\.verein-beispiel\.ch/.test(mcpB.getInstructions() ?? ''), 'MCP-Anweisungen nennen die Umgebung des Tokens', mcpB.getInstructions()?.slice(0, 160))
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '')
  const createdP = await mcpB.callTool({ name: 'create_project', arguments: { name: 'Kasse', source: { type: 'files' }, files: [{ path: 'index.html', content: '<h1>Kasse</h1>' }], wait: false } })
  const cp = JSON.parse(text(createdP)) as { project: string; urls: string[] }
  check(cp.project === 'kasse' && cp.urls.some((u) => u.includes('kasse.int.verein-beispiel.ch')), 'MCP: Projekt in «Verein» angelegt, interne Adresse unter int.verein-beispiel.ch', cp)
  const listB = JSON.parse(text(await mcpB.callTool({ name: 'list_projects', arguments: {} }))) as { project: string }[]
  const listA = JSON.parse(text(await mcpA.callTool({ name: 'list_projects', arguments: {} }))) as { project: string }[]
  check(listB.map((p) => p.project).join() === 'kasse' && listA.length === 0, 'list_projects: «Verein» sieht Kasse, example.ch sieht nichts', { listA, listB })
  const fromA = await mcpA.callTool({ name: 'get_project', arguments: { project: 'kasse' } })
  check(fromA.isError === true && text(fromA) === 'Projekt nicht gefunden', 'Token von example.ch: «Projekt nicht gefunden» für Kasse', text(fromA))

  /* --- 5: REST mit Token ------------------------------------------------------------- */
  const envsB = (await bearer(tokB, 'GET', '/environments')).json().environments as { slug: string }[]
  check(envsB.length === 1 && envsB[0]!.slug === 'verein', 'REST: Token sieht in der Liste nur seine Umgebung', envsB)
  const foreignList = await bearer(tokB, 'GET', '/environments/example/projects')
  const unknownList = await bearer(tokB, 'GET', '/environments/gibt-es-nicht/projects')
  check(foreignList.statusCode === 404 && foreignList.body === unknownList.body, 'REST: Liste einer fremden Umgebung = unbekannte Umgebung')
  const cfByToken = await bearer(tokB, 'GET', '/environments/verein/cloudflare')
  const createEnvByToken = await bearer(tokB, 'POST', '/environments', { name: 'X', slug: 'xx', short: 'XX' })
  check(cfByToken.statusCode === 403 && createEnvByToken.statusCode === 403, 'REST: Cloudflare und Umgebungen verwalten nur mit Anmeldung')

  /* --- 6: Projekt nach example.ch verschieben ------------------------------------------ */
  const pid = (await pool.query("SELECT id FROM projects WHERE slug = 'kasse'")).rows[0].id as string
  const preview = (await ui('GET', `/projects/${pid}/move?to=example`)).json().preview
  check(preview.internal.from === 'kasse.int.verein-beispiel.ch' && preview.internal.to === 'kasse.int.example.ch' && preview.tokensLosingAccess.join() === 'Claude Verein',
    'Vorschau: neue interne Adresse, Token von «Verein» verliert den Zugriff', preview)
  check(preview.headers.some((h: { header: string; to: string | null }) => h.header === 'referrer-policy' && h.to === 'no-referrer') && preview.headers.some((h: { header: string; to: string | null }) => h.header === 'x-content-type-options' && h.to === null),
    'Vorschau: geerbte Header wechseln auf die Vorlagen der Zielumgebung', preview.headers)
  const moveNoConfirm = await ui('POST', `/projects/${pid}/move`, { to: 'example' })
  check(moveNoConfirm.statusCode === 400, 'Verschieben ohne Bestätigung abgelehnt')
  const busyStates = ['pending', 'pulling', 'starting', 'healthchecking']
  const deploying = async () => (await pool.query('SELECT 1 FROM deployments WHERE project_id = $1 AND status = ANY($2)', [pid, busyStates])).rowCount! > 0
  if (await deploying()) {
    const whileBusy = await ui('POST', `/projects/${pid}/move`, { to: 'example', confirm: true })
    check(whileBusy.statusCode === 409 && whileBusy.json().error.code === 'move_blocked', 'Verschieben während eines Deploys abgelehnt', whileBusy.body.slice(0, 200))
    for (let i = 0; i < 120 && (await deploying()); i++) await new Promise((r) => setTimeout(r, 500))
  }
  check(!(await deploying()), 'Deploy ohne Docker beendet (erwartungsgemäss gescheitert)')
  const moved = await ui('POST', `/projects/${pid}/move`, { to: 'example', confirm: true })
  check(moved.statusCode === 200, 'Verschoben', moved.body.slice(0, 200))
  const route = (await pool.query("SELECT hostname FROM routes WHERE project_id = $1 AND target <> 'public'", [pid])).rows
  const redirect = (await pool.query('SELECT from_host, to_host, until FROM route_redirects WHERE project_id = $1', [pid])).rows[0]
  const days = redirect ? Math.round((new Date(redirect.until).getTime() - Date.now()) / 86_400_000) : 0
  check(route.every((r) => r.hostname === 'kasse.int.example.ch') && redirect?.from_host === 'kasse.int.verein-beispiel.ch' && days === 30, 'Interne Adresse umgezogen, alte leitet 30 Tage weiter', { route, redirect })
  const moveAudit = (await pool.query("SELECT e.slug FROM audit_events a JOIN environments e ON e.id = a.environment_id WHERE a.action = 'project.move' ORDER BY e.slug")).rows.map((r) => r.slug)
  check(moveAudit.join() === 'example,verein', 'Audit: project.move in beiden Umgebungen', moveAudit)
  const afterB = await mcpB.callTool({ name: 'get_project', arguments: { project: 'kasse' } })
  const afterA = await mcpA.callTool({ name: 'get_project', arguments: { project: 'kasse' } })
  check(afterB.isError === true && !afterA.isError, 'nach dem Verschieben: Token von «Verein» sieht Kasse nicht mehr, Token von example.ch schon')
  const rules = (await ui('GET', `/projects/${pid}/header-rules`)).json()
  check(rules.inherited?.some((r: { header: string; value: string }) => r.header === 'referrer-policy' && r.value === 'no-referrer') && !rules.inherited?.some((r: { header: string }) => r.header === 'x-content-type-options'),
    'geerbte Header jetzt die von example.ch', rules.inherited)

  /* --- 7: «Verein» löschen ------------------------------------------------------------ */
  const delDefault = await ui('DELETE', '/environments/example')
  check(delDefault.statusCode === 409, 'Standard-Umgebung lässt sich nicht löschen')
  const del = await ui('DELETE', '/environments/verein')
  check(del.statusCode === 204, '«Verein» gelöscht (leer)', del.body.slice(0, 200))
  check(![...f2.records.values()].some((r) => r.type === 'A' && r.name === '*.int.verein-beispiel.ch'), 'Tailnet-Eintrag von «Verein» entfernt')
  const deadToken = await bearer(tokB, 'GET', '/projects')
  check(deadToken.statusCode === 401, 'Token von «Verein» gilt nicht mehr')
  const list2 = (await ui('GET', '/environments')).json().environments as { slug: string }[]
  check(list2.map((e) => e.slug).join() === 'example', 'übrig: example.ch', list2)

  /* --- 8: alte Pfade ohne Umgebung ----------------------------------------------------- */
  const old = await ui('GET', '/projects')
  check(old.statusCode === 200 && (old.json().projects as { slug: string }[]).some((p) => p.slug === 'kasse'), '/api/v1/projects ohne Umgebung = Standard-Umgebung (Kasse ist da)')

  await mcpA.close()
  await mcpB.close()
  await app.close()
  await pool.end()
} catch (err) {
  console.error(err)
  check(false, 'Ablauf ohne Ausnahme', String(err))
} finally {
  pgc.stop()
  proxy.close()
  await f1.close()
  await f2.close()
}
done()
