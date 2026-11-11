/**
 * M9, Etappe 1: Migration 0015 und Übernahme der Einstellungen gegen eine
 * Datenbank im Zustand von heute (vor M9), in einem Wegwerf-Postgres.
 *
 *   pnpm --filter @airlock/api exec tsx scripts/m9-migration-e2e.ts
 *
 * Abnahme laut docs/MILESTONE-9.md: danach eine Umgebung «jherren.com» /
 * jherren / JH, gleiche Adressen, gleiches Zertifikat (keine neue
 * Bestellung), gleicher Tunnel samt Container-Name, MCP-Tokens gültig; ein
 * zweiter Start ändert nichts.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const pgc = await startThrowawayPostgres('airlock-m9-migration-e2e')
const { check, done } = checker()
const here = fileURLToPath(new URL('.', import.meta.url))
const migrations = resolve(here, '../migrations')

try {
  const { pool } = await import('../src/db/index.js')
  const { loadOrCreateKey, encrypt } = await import('../src/lib/crypto.js')
  const { hashToken } = await import('../src/lib/tokens.js')
  const { config } = await import('../src/config.js')

  /* --- Zustand von heute: Migrationen bis vor 0015, Daten wie auf dem Server ------ */
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql') && f < '0015').sort()) {
    await pool.query(readFileSync(join(migrations, f), 'utf8'))
    await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [f])
  }

  const key = loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
  const enc = (s: string) => encrypt(s, key).toString('base64')
  const CF_TOKEN = 'cf_test_token_abcdefghijklmnopqrstuvwxyz0123'
  const TUNNEL_TOKEN = 'tunnel-token-geheim-1234567890'
  const validTo = new Date(Date.now() + 60 * 86_400_000).toISOString()
  const legacy = {
    tokenEnc: enc(CF_TOKEN),
    tokenSavedAt: '2026-10-01T10:00:00.000Z',
    accountId: 'acc-0001',
    accountName: 'Joël',
    baseDomain: 'int.jherren.com',
    tailscaleIp: '100.88.41.12',
    accessEmail: 'mail@example.ch',
    acmeEmail: 'acme@example.ch',
    tunnel: { id: '6f1c2d3e-0000-4000-8000-000000000001', name: 'airlock-heimserver', tokenEnc: enc(TUNNEL_TOKEN) },
    cloudflaredImage: 'cloudflare/cloudflared:2025.9.0',
    tls: {
      phase: 'done', ca: 'production', startedAt: '2026-10-01T10:05:00.000Z',
      steps: [{ at: '2026-10-01T10:09:00.000Z', text: 'Zertifikat aktiv', tone: 'ok' }],
      prodAttemptAt: '2026-10-01T10:07:00.000Z',
      prodCert: { validTo, issuer: "Let's Encrypt R11", seenAt: '2026-10-01T10:09:00.000Z', source: 'probe', trusted: true },
    },
  }
  const { DEFAULT_PAUSE_PAGE } = await import('@airlock/shared')
  const pausePage = { ...DEFAULT_PAUSE_PAGE, title: 'Gleich zurück', message: 'Wartung.' }
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2), ($3, $4)', ['cloudflare', JSON.stringify(legacy), 'pause_page', JSON.stringify(pausePage)])
  await pool.query("INSERT INTO domains (cf_zone_id, name, is_default) VALUES ('z1', 'jherren.com', true), ('z2', 'example.ch', false)")
  const p1 = (await pool.query("INSERT INTO projects (name, slug, source_type) VALUES ('Haushaltsbuch', 'haushalt', 'image') RETURNING id")).rows[0].id as string
  const p2 = (await pool.query("INSERT INTO projects (name, slug, source_type) VALUES ('Fotoalbum', 'foto', 'compose') RETURNING id")).rows[0].id as string
  await pool.query(
    `INSERT INTO routes (project_id, target, hostname, cf_dns_record_id) VALUES
      ($1, 'lan', 'haushalt.int.jherren.com', NULL), ($1, 'tailnet', 'haushalt.int.jherren.com', NULL),
      ($1, 'public', 'haushalt.jherren.com', 'rec-1'), ($2, 'tailnet', 'foto.int.jherren.com', NULL)`,
    [p1, p2],
  )
  const { generateToken } = await import('../src/lib/tokens.js')
  const MCP_TOKEN = generateToken()
  const tok = (await pool.query("INSERT INTO api_tokens (name, token_hash) VALUES ('Claude Code Mac', $1) RETURNING id", [hashToken(MCP_TOKEN)])).rows[0].id as string
  await pool.query("INSERT INTO external_targets (hostname, txt_token) VALUES ('shop.example.ch', 'x')")
  await pool.query(
    `INSERT INTO audit_events (actor, action, target_type, target_id, result) VALUES
      ('ui:joel', 'project.deploy', 'project', $1, 'ok'), ('ui:joel', 'auth.login', 'system', NULL, 'ok'),
      ('token:x', 'token.create', 'token', $2, 'ok')`,
    [p1, tok],
  )
  const routesBefore = (await pool.query('SELECT project_id, target, hostname FROM routes ORDER BY hostname, target')).rows

  /* --- Start wie im echten Boot: Migration, Übernahme, Einstellungen laden ------- */
  const { runMigrations } = await import('../src/db/migrate.js')
  const { importLegacySettings, reloadEnvironments, allEnvironments, defaultEnvironment } = await import('../src/domain/environments.js')
  const cs = await import('../src/domain/cloudflare-settings.js')
  const { cf } = await import('../src/config.js')
  const { rehostRoutes } = await import('../src/domain/routes.js')
  const { verifyToken } = await import('../src/domain/tokens.js')
  const { pausePageTemplate } = await import('../src/domain/pause-page.js')

  const tlsBefore = { baseDomain: 'int.jherren.com', acmeCa: 'production', mode: 'wildcard', email: 'acme@example.ch', tokenFile: cs.caddyTokenPath(), redirect: true }

  await runMigrations(() => {})
  const imp = await importLegacySettings()
  await cs.loadCloudflareSettings()

  check(imp.imported, 'Übernahme lief beim ersten Start', imp)
  const envs = allEnvironments()
  check(envs.length === 1, 'genau eine Umgebung', envs.length)
  const env = defaultEnvironment()
  check(env.name === 'jherren.com' && env.slug === 'jherren' && env.short === 'JH', 'Name «jherren.com», Slug jherren, Kürzel JH', { name: env.name, slug: env.slug, short: env.short })
  check(env.zoneName === 'jherren.com' && env.internalPrefix === 'int' && env.baseDomain === 'int.jherren.com', 'Hauptzone jherren.com, interne Basis int.jherren.com', { zone: env.zoneName, prefix: env.internalPrefix })

  const moved = await rehostRoutes()
  const routesAfter = (await pool.query('SELECT project_id, target, hostname FROM routes ORDER BY hostname, target')).rows
  check(moved === 0 && JSON.stringify(routesAfter) === JSON.stringify(routesBefore), 'gleiche Adressen aller Routen (kein Umzug)', { moved, routesAfter })
  check(cf.baseDomain() === 'int.jherren.com' && cf.tls() === true, 'Laufzeit: Basis und https wie vorher', { base: cf.baseDomain(), tls: cf.tls() })

  const tls = cs.caddyTlsOptions()
  check(JSON.stringify(tls) === JSON.stringify(tlsBefore), 'gleiche TLS-Optionen für Caddy: *.int.jherren.com, Produktion, Wildcard (keine Probe, kein Staging)', tls)
  check(env.row.tlsState?.phase === 'done' && env.row.tlsState?.prodCert?.validTo === validTo, 'TLS-Phase «done» mit bekanntem Zertifikat: keine neue Bestellung beim Start', env.row.tlsState)
  const tokenFile = cs.caddyTokenPath()
  check(existsSync(tokenFile) && readFileSync(tokenFile, 'utf8') === CF_TOKEN, 'Token-Datei für Caddy wie vorher (gleicher Pfad, gleicher Inhalt)')
  check(cf.token() === CF_TOKEN && cf.accountId() === 'acc-0001', 'Cloudflare-Token und Konto lesbar')

  check(cf.tunnelId() === legacy.tunnel.id, 'gleicher Tunnel', cf.tunnelId())
  check(env.tunnel?.containerName === config.CLOUDFLARED_CONTAINER && config.CLOUDFLARED_CONTAINER === 'airlock-cloudflared', 'gleicher cloudflared-Container (airlock-cloudflared)', env.tunnel?.containerName)
  check(env.tunnel?.cloudflaredImage === 'cloudflare/cloudflared:2025.9.0', 'festgelegtes cloudflared-Image bleibt')
  check(cf.tailscaleIp() === '100.88.41.12' && cf.accessEmail() === 'mail@example.ch' && cf.acmeEmail() === 'acme@example.ch', 'Tailscale-IP, Access- und ACME-E-Mail wie vorher')

  const id = await verifyToken(MCP_TOKEN)
  check(id?.name === 'Claude Code Mac', 'MCP-Token weiter gültig', id)
  const tokEnv = (await pool.query('SELECT environment_id FROM api_tokens')).rows[0].environment_id
  check(tokEnv === env.id, 'Token gehört zur Standard-Umgebung')

  const counts = (await pool.query(`SELECT
      (SELECT count(*) FROM projects WHERE environment_id = $1) AS projects,
      (SELECT count(*) FROM domains WHERE environment_id = $1) AS domains,
      (SELECT count(*) FROM external_targets WHERE environment_id = $1) AS targets`, [env.id])).rows[0]
  check(Number(counts.projects) === 2 && Number(counts.domains) === 2 && Number(counts.targets) === 1, 'Projekte, Domains, externe Ziele in der Standard-Umgebung', counts)
  const audit = (await pool.query('SELECT action, environment_id FROM audit_events ORDER BY id')).rows
  check(audit[0].environment_id === env.id && audit[1].environment_id === null && audit[2].environment_id === env.id, 'Audit: Projekt und Token in der Umgebung, Anmeldung bleibt Server-Ereignis', audit)

  const page = await pausePageTemplate()
  check(page.title === 'Gleich zurück', 'Pause-Seiten-Vorlage übernommen', page)
  const stillThere = (await pool.query("SELECT count(*) FROM app_settings WHERE key IN ('cloudflare', 'pause_page')")).rows[0].count
  check(Number(stillThere) === 2, 'app_settings.cloudflare und pause_page bleiben als Rückfall stehen')

  /* --- Zweiter Start: nichts ändert sich ------------------------------------------ */
  const rowBefore = (await pool.query('SELECT * FROM environments')).rows
  const accBefore = (await pool.query('SELECT * FROM cloudflare_accounts')).rows
  const tunBefore = (await pool.query('SELECT * FROM tunnels')).rows
  await runMigrations(() => {})
  const imp2 = await importLegacySettings()
  await cs.loadCloudflareSettings()
  await reloadEnvironments()
  check(!imp2.imported, 'zweiter Start: keine erneute Übernahme')
  check(
    JSON.stringify((await pool.query('SELECT * FROM environments')).rows) === JSON.stringify(rowBefore)
      && JSON.stringify((await pool.query('SELECT * FROM cloudflare_accounts')).rows) === JSON.stringify(accBefore)
      && JSON.stringify((await pool.query('SELECT * FROM tunnels')).rows) === JSON.stringify(tunBefore),
    'zweiter Start: Umgebung, Konto und Tunnel unverändert',
  )
  check(JSON.stringify(cs.caddyTlsOptions()) === JSON.stringify(tlsBefore), 'zweiter Start: TLS-Optionen unverändert')

  /* --- Abbruch mitten in der Übernahme: wiederholbar ------------------------------ */
  await pool.query('UPDATE environments SET legacy_imported_at = NULL')
  const imp3 = await importLegacySettings()
  const accs = Number((await pool.query('SELECT count(*) FROM cloudflare_accounts')).rows[0].count)
  const tuns = Number((await pool.query('SELECT count(*) FROM tunnels')).rows[0].count)
  check(imp3.imported && imp3.parts.length === 0 && accs === 1 && tuns === 1, 'wiederholte Übernahme legt nichts doppelt an', { parts: imp3.parts, accs, tuns })

  /* --- Speichern über die Einstellungen: Rundweg ohne Verlust ---------------------- */
  // «Domains wählen» mit denselben Werten: schreibt den ganzen Stand über save()
  await cs.saveDomains({ baseZone: 'jherren.com', baseLabel: 'int', defaultZone: null }, 'ui:joel')
  await cs.loadCloudflareSettings()
  check(JSON.stringify(cs.caddyTlsOptions()) === JSON.stringify(tlsBefore) && cf.tunnelId() === legacy.tunnel.id && cf.token() === CF_TOKEN, 'Laden → Speichern → Laden: Token, Tunnel und TLS unverändert')

  await pool.end()
} catch (err) {
  console.error(err)
  check(false, 'Ablauf ohne Ausnahme', String(err))
} finally {
  pgc.stop()
}
done()
