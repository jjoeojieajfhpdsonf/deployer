import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE, login, api, deleteByPrefix, get, host, docker } from './lib.js'

/**
 * Abnahme Meilenstein 3 mit einem echten MCP-Client (offizielles SDK,
 * Streamable HTTP) gegen den laufenden Stack.
 */

const P = 'e2e-m3-'
let token = ''
let tokenId = ''

async function connect(t = token): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${t}` } },
  })
  await client.connect(transport)
  return client
}

/** Ruft ein Werkzeug auf und gibt das JSON aus dem Text-Inhalt zurück. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
  const text = r.content.find((c) => c.type === 'text')?.text ?? ''
  let data: any = text
  try { data = JSON.parse(text) } catch { /* Fehlertext */ }
  return { isError: Boolean(r.isError), data, raw: r }
}

before(async () => {
  await login()
  await deleteByPrefix(P)
  const r = await api('POST', '/tokens', { name: 'e2e-claude' })
  assert.equal(r.status, 201)
  token = r.data.token
  tokenId = r.data.apiToken.id
})

after(async () => {
  await deleteByPrefix(P)
  if (tokenId) await api('DELETE', `/tokens/${tokenId}`)
})

describe('M3: Zugang', () => {
  test('ohne Token 401, mit erfundenem Token 401', async () => {
    const r1 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r1.status, 401)
    const r2 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer dpl_${'x'.repeat(43)}` }, body: '{}' })
    assert.equal(r2.status, 401)
  })

  test('mit gültigem Token: Werkzeuge und Projekte', async () => {
    const c = await connect()
    const tools = (await c.listTools()).tools.map((t) => t.name)
    for (const t of ['list_projects', 'create_project', 'update_files', 'read_files', 'export_repo', 'deploy', 'start', 'stop', 'rollback', 'delete_project', 'get_logs', 'set_targets', 'list_domains', 'get_project']) {
      assert.ok(tools.includes(t), `fehlt: ${t}`)
    }
    const r = await call(c, 'list_projects')
    assert.equal(r.isError, false)
    assert.ok(Array.isArray(r.data))
    await c.close()
  })

  test('REST mit Bearer-Token für Skripte; Tokens verwalten damit nicht', async () => {
    const r = await fetch(`${BASE}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(r.status, 200)
    const t = await fetch(`${BASE}/api/v1/tokens`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(t.status, 403)
  })

  test('eine Sitzung lässt sich mit einem anderen Token nicht weiterbenutzen', async () => {
    const other = await api('POST', '/tokens', { name: 'e2e-anderes' })
    const c = await connect()
    const sid = (c as unknown as { _transport: { sessionId?: string } })._transport.sessionId
    assert.ok(sid)
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${other.data.token}`, 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    })
    assert.equal(r.status, 403)
    await c.close()
    await api('DELETE', `/tokens/${other.data.apiToken.id}`)
  })
})

describe('M3: Chat-Deploy', () => {
  let c: Client
  let slug = ''

  before(async () => { c = await connect() })
  after(async () => { await c.close() })

  test('create_project mit files ergibt eine erreichbare Seite; Antwort mit URL und Status', async () => {
    const r = await call(c, 'create_project', {
      name: `${P}solar`,
      source: { type: 'files' },
      files: [{ path: 'index.html', content: '<h1>Solarertrag heute: 14.2 kWh</h1>' }],
    })
    assert.equal(r.isError, false, JSON.stringify(r.data))
    slug = r.data.project
    assert.equal(r.data.status, 'running')
    assert.equal(r.data.deploy.status, 'active')
    assert.match(r.data.url, /^http:\/\//)
    assert.match((await get(host(slug))).body, /14\.2 kWh/)
  })

  test('update_files ändert, committet und deployt; read_files liefert den Stand', async () => {
    const r = await call(c, 'update_files', {
      project: slug, message: 'Titel grösser',
      files: [{ path: 'index.html', content: '<h1 style="font-size:4em">Solarertrag heute: 15.0 kWh</h1>' }],
    })
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.changed, true)
    assert.equal(r.data.deploy.status, 'active')
    assert.match((await get(host(slug))).body, /15\.0 kWh/)
    const read = await call(c, 'read_files', { project: slug })
    assert.match(read.data.files.find((f: any) => f.path === 'index.html').content, /15\.0 kWh/)
  })

  test('unzulässige Pfade und zu grosse Aufrufe werden abgelehnt', async () => {
    for (const path of ['../raus.html', '/etc/x', '.git/config']) {
      const r = await call(c, 'update_files', { project: slug, message: 'x', files: [{ path, content: 'x' }] })
      assert.equal(r.isError, true, path)
    }
    const big = 'A'.repeat(11 * 1024 * 1024)
    const r = await call(c, 'update_files', { project: slug, message: 'x', files: [{ path: 'a.txt', content: big }, { path: 'b.txt', content: big }] })
    assert.equal(r.isError, true)
    assert.match(String(r.data), /MB pro Aufruf/)
  })

  test('export_repo als ZIP', async () => {
    const r = (await c.callTool({ name: 'export_repo', arguments: { project: slug, format: 'zip' } })) as any
    const res = r.content.find((x: any) => x.type === 'resource')
    assert.ok(res)
    assert.equal(Buffer.from(res.resource.blob, 'base64').subarray(0, 2).toString(), 'PK')
  })

  test('Chat-Projekt mit package.json + build wird statisch gebaut', async () => {
    const r = await call(c, 'create_project', {
      name: `${P}build`, source: { type: 'files' },
      files: [
        { path: 'package.json', content: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'node b.js' } }) },
        { path: 'b.js', content: "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<h1>aus dem Chat gebaut</h1>')" },
      ],
    })
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.deploy.status, 'active', JSON.stringify(r.data.deploy))
    assert.match((await get(host(r.data.project))).body, /aus dem Chat gebaut/)
  })

  test('Chat-Projekt mit Dockerfile wird gebaut', async () => {
    const r = await call(c, 'create_project', {
      name: `${P}docker`, source: { type: 'files' }, port: 8080,
      files: [
        { path: 'Dockerfile', content: 'FROM busybox:1.36\nCOPY index.html /www/index.html\nCMD ["httpd","-f","-p","8080","-h","/www"]\n' },
        { path: 'index.html', content: '<h1>aus dem Chat mit Dockerfile</h1>' },
      ],
    })
    assert.equal(r.data.deploy.status, 'active', JSON.stringify(r.data.deploy))
    assert.match((await get(host(r.data.project))).body, /mit Dockerfile/)
  })

  test('Chat-Projekt mit compose.yaml läuft als Compose', async () => {
    const r = await call(c, 'create_project', {
      name: `${P}compose`, source: { type: 'files' }, port: 80,
      files: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: traefik/whoami:v1.10.1\n' }],
    })
    assert.equal(r.data.deploy.status, 'active', JSON.stringify(r.data.deploy))
    assert.equal((await get(host(r.data.project))).status, 200)
    assert.equal(docker('inspect', `dep_${r.data.project}-web-1`, '--format', '{{.State.Running}}'), 'true')
  })

  test('public ist vor M5 nicht möglich', async () => {
    const r = await call(c, 'set_targets', { project: slug, targets: ['public'] })
    assert.equal(r.isError, true)
    assert.match(String(r.data), /Meilenstein 5/)
  })
})

describe('M3: Bestätigungen', () => {
  let c: Client
  before(async () => { c = await connect() })
  after(async () => { await c.close() })

  test('delete_project ohne Bestätigung löscht nichts; Token für anderes Projekt passt nicht; mit Token löscht es', async () => {
    const a = await call(c, 'create_project', { name: `${P}weg`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'a' }] })
    const b = await call(c, 'create_project', { name: `${P}bleibt`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'b' }] })
    const first = await call(c, 'delete_project', { project: a.data.project })
    assert.equal(first.data.needs_confirmation, true)
    assert.match(first.data.confirmation_token, /^cfm_/)
    assert.equal((await get(host(a.data.project))).status, 200, 'noch da')

    const wrong = await call(c, 'delete_project', { project: b.data.project, confirmation_token: first.data.confirmation_token })
    assert.equal(wrong.isError, true)
    assert.equal((await get(host(b.data.project))).status, 200, 'anderes Projekt unberührt')

    const done = await call(c, 'delete_project', { project: a.data.project, confirmation_token: first.data.confirmation_token })
    assert.equal(done.data.deleted, a.data.project)
    assert.equal((await get(host(a.data.project))).status, 404)

    const again = await call(c, 'delete_project', { project: a.data.project, confirmation_token: first.data.confirmation_token })
    assert.equal(again.isError, true, 'nur einmal gültig')
  })

  test('rollback verlangt ebenfalls eine Bestätigung', async () => {
    const p = await call(c, 'create_project', { name: `${P}rb`, source: { type: 'files' }, files: [{ path: 'index.html', content: '<h1>eins</h1>' }] })
    await call(c, 'update_files', { project: p.data.project, message: 'zwei', files: [{ path: 'index.html', content: '<h1>zwei</h1>' }] })
    const ask = await call(c, 'rollback', { project: p.data.project })
    assert.equal(ask.data.needs_confirmation, true)
    assert.match((await get(host(p.data.project))).body, /zwei/)
    const go = await call(c, 'rollback', { project: p.data.project, confirmation_token: ask.data.confirmation_token })
    assert.equal(go.data.deploy.status, 'active', JSON.stringify(go.data))
    assert.match((await get(host(p.data.project))).body, /eins/)
  })
})

describe('M3: Elicitation', () => {
  async function elicitClient(answer: 'accept' | 'decline'): Promise<Client> {
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
    const client = new Client({ name: 'e2e-elicit', version: '1.0.0' }, { capabilities: { elicitation: {} } })
    client.setRequestHandler(ElicitRequestSchema, async () =>
      answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    return client
  }

  test('Client mit Elicitation: Ablehnen löscht nichts, Zustimmen löscht ohne Token', async () => {
    const c0 = await connect()
    const p = await call(c0, 'create_project', { name: `${P}elicit`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'e' }] })
    await c0.close()

    const no = await elicitClient('decline')
    const r1 = await call(no, 'delete_project', { project: p.data.project })
    assert.equal(r1.data.cancelled, true)
    assert.equal((await get(host(p.data.project))).status, 200)
    await no.close()

    const yes = await elicitClient('accept')
    const r2 = await call(yes, 'delete_project', { project: p.data.project })
    assert.equal(r2.data.deleted, p.data.project, JSON.stringify(r2.data))
    await yes.close()
  })
})

describe('M3: Review-Fälle', () => {
  test('Artwechsel Compose → statisch: die Compose-Dienste sind danach weg', async () => {
    const c = await connect()
    const p = await call(c, 'create_project', {
      name: `${P}wechsel`, source: { type: 'files' }, port: 80,
      files: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: traefik/whoami:v1.10.1\n' }],
    })
    assert.equal(p.data.deploy.status, 'active')
    const u = await call(c, 'update_files', {
      project: p.data.project, message: 'jetzt statisch',
      delete: ['compose.yaml'], files: [{ path: 'index.html', content: '<h1>statisch jetzt</h1>' }],
    })
    assert.equal(u.data.deploy.status, 'active', JSON.stringify(u.data))
    assert.match((await get(host(p.data.project))).body, /statisch jetzt/)
    const svc = docker('ps', '-a', '--filter', `label=airlock.project=${p.data.project}`, '--format', '{{.Names}} {{.Label "airlock.role"}}')
      .split('\n').filter((l) => l && !l.endsWith(' scanner'))
    assert.deepEqual(svc, [], 'Compose-Dienste laufen noch')
    await c.close()
  })

  test('Start eines abgelaufenen Projekts setzt die Frist neu', async () => {
    const c = await connect()
    const p = await call(c, 'create_project', { name: `${P}neustart`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'n' }] })
    docker('exec', 'airlock-postgres', 'psql', '-U', 'airlock', '-d', 'airlock', '-qc',
      `UPDATE projects SET last_change_at = now() - interval '40 days' WHERE slug = '${p.data.project}'`)
    const runJob = () => JSON.parse(docker('exec', 'airlock-app', 'node', '--input-type=module', '-e',
      "const m = await import('/app/packages/api/dist/jobs/expiry.js'); console.log(JSON.stringify(await m.runExpiry())); process.exit(0)")
      .split('\n').filter((l) => l.startsWith('{')).pop()!)
    assert.ok(runJob().stopped.includes(p.data.project))
    await call(c, 'start', { project: p.data.project })
    assert.ok(!runJob().stopped.includes(p.data.project), 'gleich wieder gestoppt')
    assert.equal((await get(host(p.data.project))).status, 200)
    await c.close()
  })
})

describe('M3: Ablauf von Chat-Deploys', () => {
  test('nach der Frist gestoppt, mit "behalten" nicht', async () => {
    const c = await connect()
    const alt = await call(c, 'create_project', { name: `${P}alt`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'alt' }] })
    const keep = await call(c, 'create_project', { name: `${P}behalten`, source: { type: 'files' }, files: [{ path: 'index.html', content: 'k' }] })
    await c.close()
    const keepId = (await api('GET', `/projects/${keep.data.project}`)).data.project.id
    await api('PATCH', `/projects/${keepId}`, { keep: true })

    // 40 Tage zurückdatieren: letzte Änderung und letzter Deploy.
    for (const slug of [alt.data.project, keep.data.project]) {
      docker('exec', 'airlock-postgres', 'psql', '-U', 'airlock', '-d', 'airlock', '-qc',
        `UPDATE projects SET last_change_at = now() - interval '40 days' WHERE slug = '${slug}';
         UPDATE deployments SET started_at = now() - interval '40 days' WHERE project_id = (SELECT id FROM projects WHERE slug = '${slug}');`)
    }
    // Den stündlichen Job einmal sofort laufen lassen.
    const out = docker('exec', 'airlock-app', 'node', '--input-type=module', '-e',
      "const m = await import('/app/packages/api/dist/jobs/expiry.js'); console.log(JSON.stringify(await m.runExpiry())); process.exit(0)")
    const r = JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop()!)
    assert.ok(r.stopped.includes(alt.data.project), out)
    assert.ok(!r.stopped.includes(keep.data.project))
    assert.equal((await get(host(alt.data.project))).status, 404, 'gestoppt: keine Route mehr')
    assert.equal((await get(host(keep.data.project))).status, 200)

    const p = (await api('GET', `/projects/${alt.data.project}`)).data.project
    assert.equal(p.desiredState, 'stopped')
  })
})

describe('M3: Audit und Widerruf', () => {
  test('MCP-Aufrufe stehen im Audit-Log mit Token-Name, ohne Dateiinhalte', async () => {
    const r = await api('GET', '/audit?limit=200')
    const mcp = r.data.events.filter((e: any) => e.action.startsWith('mcp.'))
    assert.ok(mcp.every((e: any) => String(e.actor).startsWith('token:')), 'jeder MCP-Aufruf mit Token-Name')
    const mine = mcp.filter((e: any) => e.actor === 'token:e2e-claude')
    assert.ok(mine.length > 5, `nur ${mine.length} Einträge von e2e-claude`)
    assert.ok(mine.some((e: any) => e.action === 'mcp.update_files'))
    const json = JSON.stringify(mcp)
    assert.ok(!json.includes('Solarertrag heute'), 'Dateiinhalt im Audit-Log')
  })

  test('nach dem Widerruf: 401, auch in einer offenen Sitzung', async () => {
    const t = await api('POST', '/tokens', { name: 'e2e-kurz' })
    const c = await connect(t.data.token)
    assert.equal((await call(c, 'list_projects')).isError, false)
    await api('DELETE', `/tokens/${t.data.apiToken.id}`)
    await assert.rejects(call(c, 'list_projects'))
    await c.close().catch(() => {})
  })
})
