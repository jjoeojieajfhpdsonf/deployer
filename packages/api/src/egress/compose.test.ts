import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * Nacht 3, Etappe 4: Der Firewall-Dienst läuft im Netz des Hosts mit
 * NET_ADMIN – deshalb so klein wie möglich: kein Socket, keine Secrets, keine
 * Ports, nur lesend, nur diese eine Capability, nur das Volume «firewall».
 * Geprüft an der Compose-Datei, die Joël startet (scripts/smoke-ausgang.sh
 * startet ihn mit denselben Schaltern).
 */

type Service = {
  image?: string; build?: { context?: string } | string; container_name?: string; network_mode?: string
  networks?: unknown; volumes?: string[]; environment?: unknown; env_file?: unknown; secrets?: unknown; ports?: unknown
  privileged?: boolean; read_only?: boolean; cap_drop?: string[]; cap_add?: string[]; security_opt?: string[]
  devices?: unknown; pid?: string; ipc?: string; restart?: string
}
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const compose = parse(readFileSync(`${root}compose.yaml`, 'utf8')) as { services: Record<string, Service>; volumes: Record<string, { name?: string } | null> }
const fw = compose.services.firewall!

describe('compose.yaml: Firewall-Dienst', () => {
  test('eigener Dienst airlock-firewall aus firewall/, startet immer wieder', () => {
    assert.ok(fw, 'Dienst «firewall» fehlt')
    assert.equal(fw.container_name, 'airlock-firewall')
    assert.equal(typeof fw.build === 'object' ? fw.build.context : fw.build, './firewall')
    assert.equal(fw.restart, 'unless-stopped')
  })

  test('Netz des Hosts, aber nur NET_ADMIN, nur lesend, keine neuen Rechte', () => {
    assert.equal(fw.network_mode, 'host')
    assert.equal(fw.networks, undefined)
    assert.deepEqual(fw.cap_drop, ['ALL'])
    assert.deepEqual(fw.cap_add, ['NET_ADMIN'])
    assert.equal(fw.read_only, true)
    assert.ok(fw.security_opt?.includes('no-new-privileges:true'))
    assert.notEqual(fw.privileged, true)
    for (const k of ['ports', 'devices', 'secrets', 'env_file', 'pid', 'ipc'] as const) assert.equal(fw[k], undefined, k)
  })

  test('nur das Volume firewall – kein Docker-Socket, keine Daten von Airlock', () => {
    assert.deepEqual(fw.volumes, ['firewall:/firewall'])
    assert.equal(compose.volumes.firewall?.name, 'airlock_firewall')
    assert.ok(compose.services.airlock!.volumes?.includes('firewall:/firewall'), 'Airlock schreibt rules.nft dorthin')
    // Ausser Airlock und dem Dienst hängt niemand das Volume ein
    for (const [name, s] of Object.entries(compose.services)) {
      if (name === 'firewall' || name === 'airlock') continue
      assert.ok(!(s.volumes ?? []).some((v) => v.startsWith('firewall:')), name)
    }
  })

  test('Image aus fest gepinntem Alpine', () => {
    const df = readFileSync(`${root}firewall/Dockerfile`, 'utf8')
    assert.match(df, /^FROM alpine:\d+\.\d+\.\d+$/m)
  })
})
