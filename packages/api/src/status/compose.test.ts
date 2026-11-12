import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * Etappe 5: Der Container der Statusseite ist öffentlich erreichbar (über
 * cloudflared → Caddy). Er darf deshalb nichts erreichen ausser seinen
 * Dateien: kein gemeinsames Netz mit Airlock, Datenbank oder Socket-Proxy,
 * kein Docker-Socket, keine Secrets, das Volume nur lesend. Geprüft direkt an
 * der Compose-Datei, die Joël startet.
 */

type Service = {
  image?: string; build?: unknown; container_name?: string; command?: string[]; user?: string
  networks?: string[] | Record<string, unknown>; volumes?: string[]; environment?: unknown; env_file?: unknown
  secrets?: unknown; ports?: unknown; privileged?: boolean; read_only?: boolean; cap_drop?: string[]
  cap_add?: unknown; depends_on?: unknown; network_mode?: string; security_opt?: string[]; devices?: unknown
  pid?: string; ipc?: string; volumes_from?: unknown; extra_hosts?: unknown
}
type ComposeFile = { services: Record<string, Service>; networks: Record<string, { name?: string; internal?: boolean }>; volumes: Record<string, unknown> }

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const compose = parse(readFileSync(`${root}compose.yaml`, 'utf8')) as ComposeFile
const status = compose.services.status!
const networksOf = (s: Service): string[] => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}))

describe('compose.yaml: airlock-status ist abgeschottet', () => {
  test('es gibt den Dienst airlock-status mit festem Image (kein latest, kein Build)', () => {
    assert.ok(status, 'Dienst «status» fehlt')
    assert.equal(status.container_name, 'airlock-status')
    assert.equal(status.build, undefined)
    assert.match(status.image ?? '', /^caddy:\d+\.\d+\.\d+-alpine$/)
    // Nur ausliefern: file-server ohne Verzeichnislisten, ohne Admin-API
    assert.deepEqual(status.command?.slice(0, 2), ['caddy', 'file-server'])
    assert.ok(!status.command?.includes('--browse'))
  })

  test('nur im Netz «status»; darin ausser ihm nur Caddy; das Netz ist internal', () => {
    assert.deepEqual(networksOf(status), ['status'])
    assert.equal(status.network_mode, undefined)
    assert.equal(compose.networks.status?.internal, true)
    const members = Object.entries(compose.services).filter(([, s]) => networksOf(s).includes('status')).map(([n]) => n).sort()
    assert.deepEqual(members, ['caddy', 'status'])
  })

  test('kein gemeinsames Netz mit Airlock, Datenbank, Socket-Proxy oder Backup', () => {
    for (const other of ['airlock', 'postgres', 'socket-proxy', 'backup']) {
      const shared = networksOf(compose.services[other]!).filter((n) => networksOf(status).includes(n))
      assert.deepEqual(shared, [], `${other} teilt ein Netz mit airlock-status`)
    }
  })

  test('kein Docker-Socket, keine Secrets, keine Umgebung, keine Ports, keine Abhängigkeiten', () => {
    const vols = status.volumes ?? []
    assert.ok(!vols.some((v) => v.includes('docker.sock')), 'Docker-Socket eingehängt')
    assert.deepEqual(vols, ['status_site:/srv/status:ro'])
    for (const key of ['environment', 'env_file', 'secrets', 'ports', 'depends_on', 'cap_add', 'devices', 'volumes_from', 'extra_hosts', 'pid', 'ipc'] as const) {
      assert.equal(status[key], undefined, `${key} gesetzt`)
    }
    assert.notEqual(status.privileged, true)
  })

  test('gehärtet: nur lesendes Dateisystem, ohne Capabilities, nicht als root', () => {
    assert.equal(status.read_only, true)
    assert.deepEqual(status.cap_drop, ['ALL'])
    assert.ok(status.security_opt?.includes('no-new-privileges:true'))
    assert.ok(status.user && !/^0(:|$)/.test(status.user) && status.user !== 'root')
  })

  test('nur Airlock schreibt in das Volume, sonst hängt es niemand ein', () => {
    const users = Object.entries(compose.services)
      .flatMap(([name, s]) => (s.volumes ?? []).filter((v) => v.split(':')[0] === 'status_site').map((v) => `${name} ${v}`))
      .sort()
    assert.deepEqual(users, ['airlock status_site:/srv/status', 'status status_site:/srv/status:ro'])
    assert.ok('status_site' in compose.volumes)
  })

  test('Airlock selbst hängt nicht im Netz «status» (der Weg von aussen endet bei Caddy)', () => {
    assert.ok(!networksOf(compose.services.airlock!).includes('status'))
    assert.ok(!networksOf(compose.services.airlock!).includes('tunnel'))
  })
})
