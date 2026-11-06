import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
// Bewusst aus caddy-config.js, nicht aus caddy.js: der Treiber selbst zieht
// config.ts nach, das ohne gesetzte Umgebung den Prozess beendet.
import { buildCaddyConfig, adminAddress, type RouteSpec } from './caddy-config.js'

const SOCKET = '/run/caddy/admin.sock'
const opts = { ipFilter: true, cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: SOCKET }

const proxyRoute: RouteSpec = {
  hosts: ['solar.int.example.ch', 'solar.192-168-1-10.nip.io'],
  kind: 'proxy',
  upstream: 'dep_solar_abc:3000',
}

type Cfg = {
  admin: { listen: string }
  apps: { http: { servers: { srv0: { routes: { match?: { host: string[]; remote_ip?: { ranges: string[] } }[]; handle: { handler: string }[] }[] } } } }
}

const build = (routes: RouteSpec[], o = opts) => buildCaddyConfig(routes, o) as unknown as Cfg

describe('Caddy-Konfiguration', () => {
  test('der admin-Block zeigt immer auf den Unix-Socket', () => {
    // Fehlte er, fiele Caddy beim naechsten /load auf TCP :2019 zurueck und
    // waere aus jedem Projekt-Netz erreichbar.
    assert.equal(build([proxyRoute]).admin.listen, 'unix//run/caddy/admin.sock')
    assert.equal(build([]).admin.listen, adminAddress(SOCKET))
  })

  test('niemals ein TCP-Port fuer die Admin-API', () => {
    const json = JSON.stringify(build([proxyRoute]))
    assert.ok(!json.includes('2019'), 'Konfiguration darf :2019 nirgends enthalten')
    assert.ok(build([proxyRoute]).admin.listen.startsWith('unix/'))
  })

  test('Proxy-Route traegt kanonischen Namen und Alias', () => {
    const route = build([proxyRoute]).apps.http.servers.srv0.routes[0]!
    assert.deepEqual(route.match![0]!.host, ['solar.int.example.ch', 'solar.192-168-1-10.nip.io'])
    assert.equal(route.handle[0]!.handler, 'reverse_proxy')
  })

  test('IP-Filter setzt remote_ip auf allen Projekt-Routen', () => {
    const route = build([proxyRoute]).apps.http.servers.srv0.routes[0]!
    assert.deepEqual(route.match![0]!.remote_ip?.ranges, opts.cidrs)
  })

  test('abgeschalteter IP-Filter laesst remote_ip weg', () => {
    const route = build([proxyRoute], { ...opts, ipFilter: false }).apps.http.servers.srv0.routes[0]!
    assert.equal(route.match![0]!.remote_ip, undefined)
  })

  test('statische Seite wird ueber file_server mit root ausgeliefert', () => {
    const cfg = build([
      { hosts: ['seite.int.example.ch'], kind: 'files', root: '/srv/sites/seite/current' },
    ])
    const handle = cfg.apps.http.servers.srv0.routes[0]!.handle
    assert.equal(handle[0]!.handler, 'vars')
    assert.equal((handle[0] as unknown as { root: string }).root, '/srv/sites/seite/current')
    assert.equal(handle[1]!.handler, 'file_server')
  })

  test('am Ende steht eine Auffangroute ohne Matcher', () => {
    // Ohne Matcher, weil ein host-Matcher "*" in Caddy nicht auf alles trifft:
    // eine unbekannte Adresse fiele sonst auf eine leere 200 durch.
    const routes = build([proxyRoute]).apps.http.servers.srv0.routes
    const last = routes[routes.length - 1]!
    assert.equal(last.match, undefined)
    assert.equal(last.handle[0]!.handler, 'static_response')
  })

  test('ohne Projekte bleibt nur die Auffangroute', () => {
    assert.equal(build([]).apps.http.servers.srv0.routes.length, 1)
  })
})
