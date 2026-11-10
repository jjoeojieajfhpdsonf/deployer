/**
 * M9, Etappe 3: DNS, Tunnel und Zertifikats-Optionen pro Umgebung gegen die
 * Cloudflare-Attrappe (zwei Konten) und ein Wegwerf-Postgres.
 *
 *   pnpm --filter @airlock/api exec tsx scripts/m9-cloudflare-e2e.ts
 *
 * Umgebungen: A «jherren» (Konto 1, jherren.com), B «verein» (Konto 2,
 * verein-beispiel.ch), C «labor» (teilt das Token von A, labor-beispiel.dev).
 * Geprüft:
 * - Tailnet-Eintrag *.int.<hauptzone> in jeder Zone, mit dem Token ihres
 *   Kontos; nach einem IP-Wechsel in allen nachgezogen
 * - ein Tunnel pro Konto: A und C teilen ihn, B hat einen eigenen (eigener
 *   cloudflared-Container); Ingress je Tunnel nur mit den Namen seines Kontos
 * - öffentlich schalten in B: CNAME in der Zone von B auf den Tunnel von B
 * - Token-Dateien für Caddy je Konto, TLS-Optionen je Basis
 * Kein Docker: cloudflared startet nicht (erwartet), Caddy-Abgleich nur im Log.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeCloudflare } from '../src/lib/cf-fixture.js'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const TOKEN_1 = `cfut_${'A'.repeat(40)}`
const TOKEN_2 = `cfut_${'B'.repeat(40)}`
const f1 = await startFakeCloudflare(['jherren.com', 'labor-beispiel.dev'])
const f2 = await startFakeCloudflare(['verein-beispiel.ch'])
f1.token = TOKEN_1
f2.token = TOKEN_2

// Verteiler: je nach Token zur Attrappe des Kontos; Konto 2 bekommt eine eigene Konto-ID
const proxy = createServer((req, res) => {
  const target = req.headers.authorization === `Bearer ${TOKEN_2}` ? f2 : f1
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const r = await fetch(`${target.url}${req.url!.replace(/^\/client\/v4/, '')}`, {
      method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body: body || undefined,
    })
    let text = await r.text()
    if (target === f2) text = text.replaceAll('acc-e2e-test', 'acc-zwei').replaceAll('Joëls Konto', 'Vereinskonto')
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(text)
  })
})
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
process.env.CLOUDFLARE_API_BASE = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`

const pgc = await startThrowawayPostgres('airlock-m9-cloudflare-e2e')
const { check, done } = checker()

try {
  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const envs = await import('../src/domain/environments.js')
  const cs = await import('../src/domain/cloudflare-settings.js')
  const { ensureTailnetDnsOnBoot } = await import('../src/domain/tailnet.js')
  const pub = await import('../src/domain/public.js')
  const { config } = await import('../src/config.js')

  await runMigrations(() => {})
  await envs.importLegacySettings()
  await cs.loadCloudflareSettings()
  const A = envs.defaultEnvironmentId()
  const quiet = async (p: Promise<unknown>) => p.catch((e) => (e as Error).message)

  // --- A: Token, Basis, Tunnel ------------------------------------------------------
  await cs.withCloudflareEnv(A, () => cs.saveToken(TOKEN_1, 'ui:joel'))
  await cs.withCloudflareEnv(A, () => cs.saveDomains({ baseZone: 'jherren.com', baseLabel: 'int', defaultZone: null, tailscaleIp: '100.88.41.12' }, 'ui:joel'))
  const tA = await quiet(cs.withCloudflareEnv(A, () => cs.setupTunnel('ui:joel')))
  // --- B: eigenes Konto ------------------------------------------------------------
  const B = (await envs.createEnvironment({ name: 'Verein', slug: 'verein', short: 'VB' })).id
  await cs.loadCloudflareSettings()
  await cs.withCloudflareEnv(B, () => cs.saveToken(TOKEN_2, 'ui:joel'))
  await cs.withCloudflareEnv(B, () => cs.saveDomains({ baseZone: 'verein-beispiel.ch', baseLabel: 'int', defaultZone: null }, 'ui:joel'))
  const tB = await quiet(cs.withCloudflareEnv(B, () => cs.setupTunnel('ui:joel')))
  // --- C: teilt das Token von A ------------------------------------------------------
  const C = (await envs.createEnvironment({ name: 'Labor', slug: 'labor', short: 'LA', shareAccountOf: A })).id
  await cs.loadCloudflareSettings()
  await cs.withCloudflareEnv(C, () => cs.saveDomains({ baseZone: 'labor-beispiel.dev', baseLabel: 'int', defaultZone: null }, 'ui:joel'))

  check(typeof tA === 'string' && typeof tB === 'string', 'ohne Docker startet cloudflared nicht (erwartet) – Tunnel trotzdem bei Cloudflare angelegt und gespeichert', { tA, tB })
  const zones = (await pool.query('SELECT d.name, e.slug FROM domains d JOIN environments e ON e.id = d.environment_id ORDER BY d.name')).rows
  check(JSON.stringify(zones) === JSON.stringify([{ name: 'jherren.com', slug: 'jherren' }, { name: 'labor-beispiel.dev', slug: 'labor' }, { name: 'verein-beispiel.ch', slug: 'verein' }]), 'Zonen je Umgebung (labor-beispiel.dev von A nach C geholt)', zones)

  // --- Tailnet ------------------------------------------------------------------------
  const tailnet = () => [...f1.records.values(), ...f2.records.values()].filter((r) => r.type === 'A').map((r) => `${r.name}=${r.content}`).sort()
  check(JSON.stringify(tailnet()) === JSON.stringify(['*.int.jherren.com=100.88.41.12', '*.int.labor-beispiel.dev=100.88.41.12', '*.int.verein-beispiel.ch=100.88.41.12']), 'Tailnet-Eintrag in jeder Hauptzone (mit dem Token ihres Kontos)', tailnet())
  check([...f2.records.values()].every((r) => r.name.endsWith('verein-beispiel.ch')) && [...f1.records.values()].every((r) => !r.name.endsWith('verein-beispiel.ch')), 'kein Eintrag im falschen Konto')
  await cs.withCloudflareEnv(A, () => cs.saveDomains({ baseZone: 'jherren.com', baseLabel: 'int', defaultZone: null, tailscaleIp: '100.99.1.1' }, 'ui:joel'))
  await ensureTailnetDnsOnBoot()
  check(tailnet().every((x) => x.endsWith('=100.99.1.1')) && tailnet().length === 3, 'IP-Wechsel: alle drei Einträge nachgezogen', tailnet())

  // --- Tunnel ------------------------------------------------------------------------
  const cA = cs.cloudflareFor(A), cB = cs.cloudflareFor(B), cC = cs.cloudflareFor(C)
  check(f1.tunnels.length === 1 && f2.tunnels.length === 1, 'ein Tunnel je Konto bei Cloudflare', { k1: f1.tunnels.length, k2: f2.tunnels.length })
  check(cA.tunnelId === cC.tunnelId && cA.tunnelId !== cB.tunnelId && Boolean(cB.tunnelId), 'A und C teilen den Tunnel, B hat einen eigenen', { a: cA.tunnelId, b: cB.tunnelId, c: cC.tunnelId })
  check(cA.containerName === config.CLOUDFLARED_CONTAINER && cC.containerName === cA.containerName && cB.containerName.startsWith(`${config.CLOUDFLARED_CONTAINER}-`), 'Container: airlock-cloudflared für Konto 1 (A, C), eigener Name für Konto 2', [cA.containerName, cB.containerName, cC.containerName])
  check(cA.accountId === 'acc-e2e-test' && cB.accountId === 'acc-zwei' && cC.accountId === cA.accountId, 'Konten richtig zugeordnet')

  // Öffentliche Namen in allen drei Umgebungen → Ingress je Tunnel
  const mk = async (env: string, slug: string) => {
    const p = (await pool.query("INSERT INTO projects (name, slug, source_type, environment_id) VALUES ($1, $1, 'image', $2) RETURNING id", [slug, env])).rows[0].id as string
    const d = (await pool.query("INSERT INTO deployments (project_id, status, is_active) VALUES ($1, 'active', true) RETURNING id", [p])).rows[0].id as string
    await pool.query("INSERT INTO scan_runs (project_id, deployment_id, status) VALUES ($1, $2, 'done')", [p, d])
    return p
  }
  const pA = await mk(A, 'haushalt'), pB = await mk(B, 'kasse'), pC = await mk(C, 'versuch')
  const proj = async (id: string) => (await pool.query('SELECT id, slug, name, environment_id AS "environmentId" FROM projects WHERE id = $1', [id])).rows[0]
  for (const id of [pA, pB, pC]) {
    const p = await proj(id)
    await pub.applyPublic(await pub.planPublic(p, {}), 'ui:joel')
  }
  const hosts = (f: typeof f1) => f.ingress.filter((r) => r.hostname).map((r) => r.hostname).sort()
  check(JSON.stringify(hosts(f1)) === JSON.stringify(['haushalt.jherren.com', 'versuch.labor-beispiel.dev']), 'Tunnel von Konto 1: Namen von A und C', hosts(f1))
  check(JSON.stringify(hosts(f2)) === JSON.stringify(['kasse.verein-beispiel.ch']), 'Tunnel von Konto 2: nur der Name von B', hosts(f2))
  const cname = [...f2.records.values()].find((r) => r.type === 'CNAME')
  check(cname?.name === 'kasse.verein-beispiel.ch' && cname.content === `${cB.tunnelId}.cfargotunnel.com`, 'B öffentlich: CNAME in der Zone von B auf den Tunnel von B', cname)
  const cnameC = [...f1.records.values()].find((r) => r.type === 'CNAME' && r.name.startsWith('versuch.'))
  check(cnameC?.content === `${cA.tunnelId}.cfargotunnel.com`, 'C öffentlich: CNAME auf den geteilten Tunnel von Konto 1', cnameC)

  // Entfernen in B lässt Konto 1 unberührt
  await pub.removePublic(await proj(pB), 'ui:joel', { skipCaddy: true })
  check(hosts(f2).length === 0 && hosts(f1).length === 2 && ![...f2.records.values()].some((r) => r.type === 'CNAME'), 'B offline: Regel und CNAME in Konto 2 weg, Konto 1 unverändert')

  // Trennen von C (geteiltes Konto) lässt Tunnel und Token von A stehen
  await pub.removePublic(await proj(pC), 'ui:joel', { skipCaddy: true })
  await cs.withCloudflareEnv(C, () => cs.disconnect('ui:joel'))
  check(f1.tunnels.length === 1 && cs.cloudflareFor(A).tunnelId === cA.tunnelId && cs.cloudflareFor(A).token === TOKEN_1 && !cs.cloudflareFor(C).token, 'C trennen (geteiltes Konto): Tunnel und Token von A bleiben, C ohne Token')

  // --- Token-Dateien und TLS-Optionen ------------------------------------------------
  const files = readdirSync(config.CADDY_SECRETS_DIR).sort()
  const fileB = `cloudflare_token_${cB.accountRowId}`
  check(JSON.stringify(files) === JSON.stringify(['cloudflare_token', fileB].sort()), 'Token-Dateien: cloudflare_token (Konto 1), eine eigene für Konto 2', files)
  check(readFileSync(join(config.CADDY_SECRETS_DIR, 'cloudflare_token'), 'utf8') === TOKEN_1 && readFileSync(join(config.CADDY_SECRETS_DIR, fileB), 'utf8') === TOKEN_2, 'Inhalt der Token-Dateien je Konto')
  await pool.query(`UPDATE environments SET tls_state = '{"phase":"done","ca":"production","startedAt":"2026-11-10T00:00:00Z","steps":[]}'`)
  await cs.loadCloudflareSettings()
  const tls = cs.caddyTlsOptionsAll().map((t) => ({ base: t.baseDomain, file: t.tokenFile?.split('/').pop(), ca: t.acmeCa, mode: t.mode }))
  check(JSON.stringify(tls) === JSON.stringify([
    { base: 'int.jherren.com', file: 'cloudflare_token', ca: 'production', mode: 'wildcard' },
    { base: 'int.verein-beispiel.ch', file: fileB, ca: 'production', mode: 'wildcard' },
  ]), 'TLS-Optionen je Basis mit ihrer Token-Datei (C ohne Token: ohne TLS)', tls)
  check(existsSync(join(config.CADDY_SECRETS_DIR, 'cloudflare_token')), 'Datei der Standard-Umgebung bleibt am alten Ort')

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
