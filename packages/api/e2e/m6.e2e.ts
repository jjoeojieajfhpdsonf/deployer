import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE, login, api, deleteByPrefix, createProject, waitDeployment, upload, docker, sleep } from './lib.js'
import { makeZip } from '../src/lib/zip-fixture.js'

/**
 * Abnahme Meilenstein 6 gegen den laufenden Stack: echte Scanner (Trivy,
 * ZAP, Nuclei) in Wegwerf-Containern, Score, Akzeptieren, Freigabe-Sperre,
 * externe Ziele, Benachrichtigungen an Attrappen auf dem Host.
 *
 * Braucht beim ersten Lauf Netz (Images, Trivy-Datenbank) und dauert
 * einige Minuten, weil die Scans nacheinander laufen.
 */

const P = 'e2e-m6-'
let token = ''
let tokenId = ''

/** Erfunden, nur im GitHub-Format, damit Trivys Regel anschlägt. */
const FAKE_PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

async function connect(): Promise<Client> {
  const client = new Client({ name: 'e2e-m6', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }))
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
  const text = r.content.find((c) => c.type === 'text')?.text ?? ''
  let data: any = text
  try { data = JSON.parse(text) } catch { /* Fehlertext */ }
  return { isError: Boolean(r.isError), data }
}

/** Wartet auf den letzten Scan, der nach `since` begonnen hat. */
async function waitScan(projectId: string, since: number, timeoutMs = 600_000): Promise<any> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const r = await api('GET', `/projects/${projectId}/scans/latest`)
    const rep = r.data.report
    if (rep && Date.parse(rep.scan.startedAt) >= since - 2000 && ['done', 'failed'].includes(rep.scan.status)) return rep
    await sleep(3000)
  }
  throw new Error(`Kein fertiger Scan für ${projectId} nach ${timeoutMs} ms`)
}

const psql = (sql: string) => docker('exec', 'airlock-postgres', 'psql', '-U', 'airlock', '-d', 'airlock', '-tAc', sql)

const expectedScore = (c: Record<string, number>) => Math.max(0, 100 - 25 * c.critical! - 10 * c.high! - 4 * c.medium! - c.low!)

before(async () => {
  await login()
  await deleteByPrefix(P)
  const r = await api('POST', '/tokens', { name: 'e2e-m6' })
  token = r.data.token
  tokenId = r.data.apiToken.id
})

after(async () => {
  await deleteByPrefix(P)
  if (tokenId) await api('DELETE', `/tokens/${tokenId}`)
  const t = await api('GET', '/external-targets')
  for (const x of t.data.targets ?? []) if (x.hostname.startsWith('e2e-m6')) await api('DELETE', `/external-targets/${x.id}`)
})

describe('M6: reservierte Namen', () => {
  test('Slug "deployer", "airlock" und "ext-scan" sind nicht wählbar', async () => {
    for (const slug of ['deployer', 'airlock', 'ext-scan']) {
      const r = await api('POST', '/projects', { name: 'x', slug, source: { type: 'image', image: 'nginx:alpine' }, port: 80, targets: ['lan'] })
      assert.equal(r.status, 400, `${slug}: ${JSON.stringify(r.data)}`)
    }
  })
})

describe('M6: Scans nach dem Deploy', () => {
  let oldNginx = ''
  let oldNginxReport: any

  test('altes Image: Trivy findet CVEs, Header-Check meldet fehlende Header, Score folgt der Formel', async () => {
    const since = Date.now()
    const p = await createProject({ name: `${P}alt`, slug: `${P}alt`, source: { type: 'image', image: 'nginx:1.21-alpine' }, port: 80 })
    oldNginx = p.id
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const rep = await waitScan(p.id, since)
    oldNginxReport = rep
    assert.equal(rep.scan.status, 'done', rep.scan.error ?? '')
    const tools = new Set(rep.findings.map((f: any) => f.tool))
    assert.ok(tools.has('trivy'), `Trivy fehlt: ${[...tools]}`)
    assert.ok(rep.findings.some((f: any) => f.tool === 'trivy' && ['critical', 'high'].includes(f.severity)), 'keine hohe/kritische CVE')
    assert.ok(rep.findings.some((f: any) => f.tool === 'header-check' && /Content-Security-Policy/.test(f.title)))
    assert.ok(rep.findings.some((f: any) => f.tool === 'header-check' && /Versionsangabe/.test(f.title)), 'nginx/1.21 im Server-Header')
    for (const st of ['trivy-image', 'headers', 'zap-baseline', 'nuclei']) {
      assert.equal(rep.scan.stages[st]?.ran, true, `Stufe ${st}: ${JSON.stringify(rep.scan.stages[st])}`)
    }
    assert.equal(rep.scan.score, expectedScore(rep.counts))
    assert.equal(rep.scan.grade, rep.scan.score >= 90 ? 'A' : rep.scan.score >= 75 ? 'B' : rep.scan.score >= 50 ? 'C' : 'D')
    // Interne Containernamen tauchen in den Orten nicht auf
    assert.ok(!rep.findings.some((f: any) => /dep-e2e-m6|:\/\/[a-z0-9-]+:\d+/.test(f.location)), 'interne Adresse im Ort')
  })

  test('Projektliste zeigt Note und Score', async () => {
    const r = await api('GET', `/projects/${oldNginx}`)
    assert.equal(r.data.project.security.grade, oldNginxReport.scan.grade)
    assert.equal(r.data.project.security.score, oldNginxReport.scan.score)
  })

  test('Freigabe-Sperre: offene kritische Befunde verhindern öffentlich, Akzeptieren gibt frei', async () => {
    const critical = oldNginxReport.findings.filter((f: any) => f.status === 'open' && f.severity === 'critical')
    assert.ok(critical.length > 0, 'nginx:1.21-alpine sollte eine kritische CVE mit Fix haben')
    const r = await api('GET', `/projects/${oldNginx}/publishable`)
    assert.equal(r.data.ok, false)
    assert.match(r.data.reason, /kritisch/i)
    for (const f of critical) {
      assert.equal((await api('PATCH', `/findings/${f.id}`, { status: 'accepted', reason: 'Test: nur intern, Update geplant' })).status, 200)
    }
    const r2 = await api('GET', `/projects/${oldNginx}/publishable`)
    assert.equal(r2.data.ok, true, JSON.stringify(r2.data))
  })

  test('Akzeptieren: zählt nicht mehr, übersteht den nächsten Scan, steht im Audit-Log', async () => {
    const f = oldNginxReport.findings.find((x: any) => x.status === 'open' && x.tool === 'header-check')
    assert.ok(f)
    const short = await api('PATCH', `/findings/${f.id}`, { status: 'accepted', reason: 'x' })
    assert.equal(short.status, 400, 'Begründung zu kurz')
    const r = await api('PATCH', `/findings/${f.id}`, { status: 'accepted', reason: 'Test: bewusst in Kauf genommen' })
    assert.equal(r.status, 200)

    const since = Date.now()
    const s = await api('POST', `/projects/${oldNginx}/scans`, { level: 'standard' })
    assert.equal(s.status, 202)
    const rep = await waitScan(oldNginx, since)
    const again = rep.findings.find((x: any) => x.tool === f.tool && x.title === f.title && x.location === f.location)
    assert.ok(again, 'Befund im neuen Scan nicht wieder gefunden')
    assert.equal(again.status, 'accepted')
    assert.equal(again.acceptReason, 'Test: bewusst in Kauf genommen')
    assert.equal(rep.scan.score, expectedScore(rep.counts))

    const audit = await api('GET', '/audit?limit=200')
    assert.ok(audit.data.events.some((e: any) => e.action === 'finding.accept'))
  })

  test('aktiver Scan nur mit Bestätigung (REST und MCP)', async () => {
    const r = await api('POST', `/projects/${oldNginx}/scans`, { level: 'active' })
    assert.equal(r.status, 400)
    const c = await connect()
    const m = await call(c, 'run_scan', { project: `${P}alt`, level: 'active' })
    // Der Test-Client kann keine Elicitation: es kommt ein Bestätigungs-Token zurück, kein Scan.
    assert.ok(m.data.confirmation_token || /Bestätig/i.test(JSON.stringify(m.data)), JSON.stringify(m.data))
    assert.ok(!m.data.scan)
    await c.close()
  })

  test('alle Header gesetzt: Header-Check ohne Befund', async () => {
    const conf = [
      'server {',
      '  listen 80;',
      '  server_tokens off;',
      '  add_header Content-Security-Policy "default-src \'self\'; frame-ancestors \'none\'" always;',
      '  add_header X-Frame-Options DENY always;',
      '  add_header X-Content-Type-Options nosniff always;',
      '  add_header Referrer-Policy no-referrer always;',
      '  add_header Permissions-Policy "camera=(), microphone=()" always;',
      '  location / { root /usr/share/nginx/html; }',
      '}',
    ].join('\n')
    const c = await connect()
    const since = Date.now()
    const r = await call(c, 'create_project', {
      name: `${P}header`,
      source: { type: 'files' },
      port: 80,
      files: [
        { path: 'Dockerfile', content: 'FROM nginx:alpine\nCOPY default.conf /etc/nginx/conf.d/default.conf\nCOPY index.html /usr/share/nginx/html/index.html\n' },
        { path: 'default.conf', content: conf },
        { path: 'index.html', content: '<!doctype html><title>sicher</title><h1>sicher</h1>' },
      ],
    })
    await c.close()
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.deploy.status, 'active', JSON.stringify(r.data.deploy))
    const rep = await waitScan(r.data.project, since)
    assert.equal(rep.scan.stages.headers?.ran, true)
    const hdr = rep.findings.filter((f: any) => f.tool === 'header-check')
    assert.deepEqual(hdr.map((f: any) => f.title), [])
  })

  test('statische Seite mit .env: Nuclei findet sie', async () => {
    const since = Date.now()
    const id = await upload('env.zip', makeZip([
      { name: 'index.html', data: '<!doctype html><h1>statisch</h1>' },
      { name: '.env', data: 'DB_HOST=localhost\nDB_USER=app\nDB_PASSWORD=nur-ein-test\nAPP_KEY=base64:dGVzdA==\n' },
    ]))
    const p = await createProject({ name: `${P}env`, slug: `${P}env`, source: { type: 'static', uploadId: id } })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const rep = await waitScan(p.id, since)
    assert.equal(rep.scan.status, 'done', rep.scan.error ?? '')
    assert.equal(rep.scan.stages.nuclei?.ran, true)
    assert.ok(
      rep.findings.some((f: any) => f.tool === 'nuclei' && /\.env/.test(f.location)),
      `kein .env-Befund: ${JSON.stringify(rep.findings.map((f: any) => [f.tool, f.title, f.location]))}`,
    )
  })

  test('Chat-Projekt mit Token im Code: Trivy meldet es, der Wert wird nirgends gespeichert', async () => {
    const c = await connect()
    const since = Date.now()
    const r = await call(c, 'create_project', {
      name: `${P}secret`,
      source: { type: 'files' },
      files: [
        { path: 'index.html', content: '<!doctype html><script src="app.js"></script><h1>Chat</h1>' },
        { path: 'app.js', content: `const GITHUB_TOKEN = "${FAKE_PAT}"\nconsole.log('hallo')\n` },
      ],
    })
    assert.equal(r.isError, false, JSON.stringify(r.data))
    const rep = await waitScan(r.data.project, since)
    assert.equal(rep.scan.stages['trivy-source']?.ran, true, JSON.stringify(rep.scan.stages))
    const sec = rep.findings.find((f: any) => f.tool === 'trivy' && /app\.js/.test(f.location))
    assert.ok(sec, `kein Secret-Befund: ${JSON.stringify(rep.findings.map((f: any) => [f.title, f.location]))}`)
    assert.ok(!JSON.stringify(rep).includes(FAKE_PAT), 'Token im Bericht')
    assert.equal(psql(`select count(*) from findings where (title || description || location || fix) like '%${FAKE_PAT.slice(4, 20)}%'`), '0')
    assert.equal(psql(`select count(*) from audit_events where params_masked::text like '%${FAKE_PAT.slice(4, 20)}%' and action like 'scan%'`), '0')

    const g = await call(c, 'get_scan_report', { project: `${P}secret`, wait: false })
    assert.equal(g.isError, false)
    assert.ok(typeof g.data.score === 'number')
    assert.ok(Array.isArray(g.data.top))
    await c.close()
  })

  test('Scanner-Container sind weg', async () => {
    // Nur die eigenen: In der Gesamtsuite laufen noch Scans für Projekte aus M1–M3.
    const left = docker('ps', '-a', '--filter', 'label=airlock.role=scanner', '--format', '{{.Label "airlock.project"}} {{.Names}}')
      .split('\n').filter((l) => l.startsWith(P))
    assert.deepEqual(left, [])
  })
})

describe('M6: externe Ziele', () => {
  test('ohne TXT-Nachweis kein Scan; Prüfung schlägt fehl', async () => {
    const add = await api('POST', '/external-targets', { hostname: 'e2e-m6-nicht-vorhanden.example.com' })
    assert.equal(add.status, 201, JSON.stringify(add.data))
    const t = add.data.target
    assert.equal(t.verified, false)
    assert.equal(t.txt.name, '_airlock-verify.e2e-m6-nicht-vorhanden.example.com')
    assert.match(t.txt.value, /^airlock-verify=/)

    const scan = await api('POST', `/external-targets/${t.id}/scans`, {})
    assert.equal(scan.status, 400)
    assert.equal(scan.data.error.code, 'not_verified')

    const v = await api('POST', `/external-targets/${t.id}/verify`)
    assert.equal(v.status, 200)
    assert.equal(v.data.target.verified, false)

    const c = await connect()
    const m = await call(c, 'run_scan', { hostname: 'e2e-m6-nicht-vorhanden.example.com' })
    assert.equal(m.isError, true)
    await c.close()
  })

  test('interne und private Namen werden nicht angenommen', async () => {
    for (const h of ['localhost', '192.168.1.10', 'deployer.internal', 'foo.local']) {
      const r = await api('POST', '/external-targets', { hostname: h })
      assert.equal(r.status, 400, `${h}: ${JSON.stringify(r.data)}`)
    }
  })
})

describe('M6: Benachrichtigungen', () => {
  const pushes: { body: any }[] = []
  const mails: string[] = []
  let ntfyPort = 0
  let smtpPort = 0
  const http = createServer((req: IncomingMessage, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try { pushes.push({ body: JSON.parse(b) }) } catch { pushes.push({ body: b }) }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, _s, cb) {
      let d = ''
      stream.on('data', (c) => (d += c))
      stream.on('end', () => {
        mails.push(d)
        cb()
      })
    },
  })

  before(async () => {
    await new Promise<void>((r) => http.listen(0, '0.0.0.0', r))
    ntfyPort = (http.address() as AddressInfo).port
    await new Promise<void>((r) => smtp.listen(0, '0.0.0.0', r))
    smtpPort = (smtp.server.address() as AddressInfo).port
  })

  after(async () => {
    await api('PUT', '/notifications', { ntfy: null, email: null })
    http.close()
    smtp.close()
  })

  async function until(cond: () => boolean, ms = 120_000) {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await sleep(500)
    return cond()
  }

  test('Einstellungen speichern; Token kommt nicht zurück; nur mit Anmeldung', async () => {
    const r = await api('PUT', '/notifications', {
      ntfy: { url: `http://host.docker.internal:${ntfyPort}`, topic: 'e2e-m6', token: 'tk_nur_test' },
      email: { host: 'host.docker.internal', port: smtpPort, secure: false, user: null, password: null, from: 'airlock@test.example', to: 'joel@test.example' },
    })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.ntfy.hasToken, true)
    assert.ok(!JSON.stringify(r.data).includes('tk_nur_test'))

    const viaToken = await fetch(`${BASE}/api/v1/notifications`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(viaToken.status, 403)
  })

  test('Test-Push und Test-E-Mail kommen an', async () => {
    const p = await api('POST', '/notifications/test', { channel: 'push' })
    assert.equal(p.status, 200, JSON.stringify(p.data))
    assert.ok(await until(() => pushes.length > 0, 15_000), 'kein Push')
    assert.equal(pushes[0]!.body.topic, 'e2e-m6')

    const e = await api('POST', '/notifications/test', { channel: 'email' })
    assert.equal(e.status, 200, JSON.stringify(e.data))
    assert.ok(await until(() => mails.length > 0, 15_000), 'keine Mail')
    assert.match(mails[0]!, /joel@test\.example/)
  })

  test('fehlgeschlagener Deploy löst einen Push aus, ohne Secret-Werte', async () => {
    pushes.length = 0
    const p = await createProject({
      name: `${P}kaputt`, slug: `${P}kaputt`,
      source: { type: 'image', image: 'busybox:1.36' }, port: 80,
      env: [{ key: 'API_KEY', value: 'geheim-e2e-m6-wert', isSecret: true }],
    })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'failed')
    // Ohne abgeschlossenen Scan nicht öffentlich schaltbar
    const pub = await api('GET', `/projects/${p.id}/publishable`)
    assert.equal(pub.data.ok, false)
    assert.match(pub.data.reason, /kein abgeschlossener Scan/)
    assert.ok(await until(() => pushes.some((x) => /kaputt/.test(JSON.stringify(x.body)))), 'kein Push zum Fehlschlag')
    assert.ok(!JSON.stringify(pushes).includes('geheim-e2e-m6-wert'))
  })
})
