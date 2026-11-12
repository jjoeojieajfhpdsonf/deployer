import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, ACCESS_LOGGER, BLOCK_HEADER, VISITS_LOGGER, VISITS_LOG_FILE, type RouteSpec } from './caddy-config.js'

/**
 * Etappe 3: Besucher-Log. Jede Projekt-Route schreibt über den Logger
 * «visits» in eine eigene JSON-Datei mit Rotation – nie die Oberfläche von
 * Airlock, nie ins Container-Log. Die Sperrseite des IP-Filters trägt eine
 * Kennung, damit der Live-Strom «geblockt» erkennt.
 */

type Srv = { routes: { match?: { host: string[] }[]; handle: { handler: string; status_code?: number; headers?: Record<string, string[]> }[] }[]; logs?: { logger_names: Record<string, string[]> } }
type Cfg = { apps: { http: { servers: Record<string, Srv> } }; logging: { logs: Record<string, { writer?: Record<string, unknown>; include?: string[]; exclude?: string[]; encoder?: unknown; level?: string }> } }

const ui: RouteSpec = { hosts: ['airlock.int.example.ch'], kind: 'proxy', upstream: 'airlock-app:3000' }
const foto: RouteSpec = { hosts: ['foto.int.example.ch', 'foto.192-168-1-5.nip.io'], kind: 'proxy', upstream: 'foto:80', visits: true }
const site: RouteSpec = { hosts: ['blog.int.example.ch'], kind: 'files', root: '/srv/sites/blog', visits: true }
const moved: RouteSpec = { hosts: ['alt.int.example.ch'], kind: 'redirect', redirectTo: 'https://foto.int.example.ch' }
const base = { ipFilter: true, cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock', accessLogHosts: ui.hosts }

describe('Caddy: Besucher-Log', () => {
  test('Projekt-Routen → Logger visits; Oberfläche und Weiterleitung nicht', () => {
    const c = buildCaddyConfig([ui, foto, site, moved], { ...base, visitsLogDir: '/var/log/airlock-access' }) as unknown as Cfg
    const names = c.apps.http.servers.srv0!.logs!.logger_names
    assert.deepEqual(names['foto.int.example.ch'], [VISITS_LOGGER])
    assert.deepEqual(names['foto.192-168-1-5.nip.io'], [VISITS_LOGGER])
    // statische Seite: Reiter «Zugriffe» (site) bleibt, Besucher kommt dazu
    assert.deepEqual(names['blog.int.example.ch'], ['site', VISITS_LOGGER])
    assert.deepEqual(names['airlock.int.example.ch'], [ACCESS_LOGGER])
    assert.equal(names['alt.int.example.ch'], undefined)
  })

  test('eigene Datei mit Rotation, JSON; Container-Log ohne Besucher-Zeilen', () => {
    const c = buildCaddyConfig([ui, foto], { ...base, visitsLogDir: '/var/log/airlock-access/' }) as unknown as Cfg
    const v = c.logging.logs[VISITS_LOGGER]!
    assert.equal(v.writer!.output, 'file')
    assert.equal(v.writer!.filename, `/var/log/airlock-access/${VISITS_LOG_FILE}`)
    assert.equal(v.writer!.roll_size_mb, 20)
    assert.equal(v.writer!.roll_keep, 2)
    assert.equal(v.writer!.roll_keep_days, 2)
    assert.equal(v.writer!.mode, '0640')
    assert.deepEqual(v.encoder, { format: 'json' })
    assert.deepEqual(v.include, ['http.log.access.visits'])
    assert.deepEqual(c.logging.logs.default, { level: 'INFO', exclude: ['http.log.access.visits'] })
  })

  test('ohne Ordner (ACCESS_LOG_DIR leer) oder ohne Projekt-Routen: kein Besucher-Log', () => {
    for (const c of [
      buildCaddyConfig([ui, foto], base) as unknown as Cfg,
      buildCaddyConfig([ui], { ...base, visitsLogDir: '/var/log/airlock-access' }) as unknown as Cfg,
    ]) {
      assert.deepEqual(c.logging.logs, { default: { level: 'INFO' } })
      assert.ok(!JSON.stringify(c.apps).includes(VISITS_LOGGER))
    }
  })

  test('Sperrseite des IP-Filters trägt X-Airlock-Block', () => {
    const c = buildCaddyConfig([ui, foto], { ...base, visitsLogDir: '/var/log/airlock-access' }) as unknown as Cfg
    const forbidden = c.apps.http.servers.srv0!.routes.find((r) => r.handle[0]?.status_code === 403)!
    assert.deepEqual(forbidden.handle[0]!.headers, { [BLOCK_HEADER]: ['ip-filter'] })
  })
})
