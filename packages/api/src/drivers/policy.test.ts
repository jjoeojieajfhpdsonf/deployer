import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { assertCreatePolicy, assertHostConfigPolicy } from './policy.js'
import { PolicyError } from '../lib/errors.js'

const NET = 'air_solar'

function goodHostConfig(): Record<string, unknown> {
  return {
    NetworkMode: NET,
    Memory: 512 * 1024 * 1024,
    NanoCpus: 1_000_000_000,
    RestartPolicy: { Name: 'unless-stopped' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '5' } },
    SecurityOpt: ['no-new-privileges:true'],
  }
}

function goodCreate(): Record<string, unknown> {
  return {
    name: 'air_solar_abc123',
    Image: 'traefik/whoami:latest',
    Env: ['PORT=80'],
    Labels: { 'airlock.project': 'solar' },
    HostConfig: goodHostConfig(),
  }
}

function rejects(fn: () => void, rulePrefix: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof PolicyError, `erwartet PolicyError, war ${String(err)}`)
    assert.ok(
      err.rule.startsWith(rulePrefix),
      `erwartete Regel ~ "${rulePrefix}", war "${err.rule}"`,
    )
    return true
  })
}

describe('Richtlinienprüfung: gültige Nutzlast', () => {
  test('lässt eine korrekt gebaute Nutzlast durch', () => {
    assert.doesNotThrow(() => assertCreatePolicy(goodCreate(), NET))
  })

  test('erlaubt Cmd, WorkingDir und User für Wegwerf-Container (M2)', () => {
    const o = goodCreate()
    o.Cmd = ['sh', '-c', 'npm ci && npm run build']
    o.WorkingDir = '/work'
    o.User = 'node'
    assert.doesNotThrow(() => assertCreatePolicy(o, NET))
  })

  test('Cmd muss ein String-Array sein', () => {
    const o = goodCreate()
    o.Cmd = 'npm run build'
    rejects(() => assertCreatePolicy(o, NET), 'create.cmd')
  })

  test('WorkingDir muss absolut sein', () => {
    const o = goodCreate()
    o.WorkingDir = 'work'
    rejects(() => assertCreatePolicy(o, NET), 'create.workingdir')
  })

  test('erlaubt ein benanntes Volume des Projekts', () => {
    const o = goodCreate()
    ;(o.HostConfig as Record<string, unknown>).Mounts = [
      { Type: 'volume', Source: 'air_solar_data', Target: '/data' },
    ]
    assert.doesNotThrow(() => assertCreatePolicy(o, NET))
  })
})

describe('Erlaubnisliste: unbekannte Felder', () => {
  // Das ist der eigentliche Punkt der Erlaubnisliste. Ein Feld, das es heute
  // noch nicht gibt, muss abgelehnt werden, ohne dass jemand eine Regel dafür
  // geschrieben hat.
  test('lehnt ein erfundenes, heute unbekanntes HostConfig-Feld ab', () => {
    const hc = goodHostConfig()
    hc.FutureEscapeHatch2029 = { mountEverything: true }
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('lehnt ein unbekanntes Feld auf oberster Ebene ab', () => {
    const o = goodCreate()
    o.Privileged = true // falsche Ebene, trotzdem abgelehnt
    rejects(() => assertCreatePolicy(o, NET), 'create.unknown_field')
  })
})

describe('Die klassischen Ausbrüche', () => {
  test('privileged', () => {
    const hc = goodHostConfig()
    hc.Privileged = true
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('Bind-Mount auf / über Binds', () => {
    const hc = goodHostConfig()
    hc.Binds = ['/:/host']
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('Bind-Mount auf den Docker-Socket über Mounts', () => {
    const hc = goodHostConfig()
    hc.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' }]
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.mounts.type')
  })

  test('M6: ausdrücklich erlaubtes Scanner-Volume, nur mit genauem Namen', () => {
    const hc = goodHostConfig()
    hc.Mounts = [{ Type: 'volume', Source: 'airlock_scan-trivy', Target: '/root/.cache' }]
    assert.doesNotThrow(() => assertHostConfigPolicy(hc, NET, { extraVolumes: [{ name: 'airlock_scan-trivy' }] }))
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.mounts.source')
    rejects(() => assertHostConfigPolicy(hc, NET, { extraVolumes: [{ name: 'airlock_scan' }] }), 'hostconfig.mounts.source')
  })

  test('M6: nur-lesend-Volume darf nicht schreibbar eingehängt werden', () => {
    const hc = goodHostConfig()
    hc.Mounts = [{ Type: 'volume', Source: 'airlock_sites', Target: '/srv/sites' }]
    const opts = { extraVolumes: [{ name: 'airlock_sites', readOnly: true }] }
    rejects(() => assertHostConfigPolicy(hc, NET, opts), 'hostconfig.mounts.readonly')
    hc.Mounts = [{ Type: 'volume', Source: 'airlock_sites', Target: '/srv/sites', ReadOnly: true }]
    assert.doesNotThrow(() => assertHostConfigPolicy(hc, NET, opts))
  })

  test('fremdes Volume', () => {
    const hc = goodHostConfig()
    hc.Mounts = [{ Type: 'volume', Source: 'air_andereapp_data', Target: '/data' }]
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.mounts.source')
  })

  test('Übergang: Volume aus der deployer-Zeit nur ausdrücklich und nur lesend', () => {
    const hc = goodHostConfig()
    hc.Mounts = [{ Type: 'volume', Source: 'dep_solar_data', Target: '/from', ReadOnly: true }]
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.mounts.source')
    assert.doesNotThrow(() => assertHostConfigPolicy(hc, NET, { extraVolumes: [{ name: 'dep_solar_data', readOnly: true }] }))
  })

  test('Übergang: keine neuen Container in Netzen aus der deployer-Zeit', () => {
    const o = goodCreate()
    ;(o.HostConfig as Record<string, unknown>).NetworkMode = 'dep_solar'
    rejects(() => assertCreatePolicy(o, 'dep_solar'), 'network.name')
  })

  test('network_mode: host', () => {
    const hc = goodHostConfig()
    hc.NetworkMode = 'host'
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.networkmode')
  })

  test('Netz eines anderen Projekts', () => {
    const hc = goodHostConfig()
    hc.NetworkMode = 'air_andereapp'
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.networkmode')
  })

  test('zusätzliche Capabilities', () => {
    const hc = goodHostConfig()
    hc.CapAdd = ['SYS_ADMIN']
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('Geräte durchreichen', () => {
    const hc = goodHostConfig()
    hc.Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }]
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('Host-Port', () => {
    const hc = goodHostConfig()
    hc.PortBindings = { '80/tcp': [{ HostPort: '8080' }] }
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('PidMode host', () => {
    const hc = goodHostConfig()
    hc.PidMode = 'host'
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.unknown_field')
  })

  test('seccomp abschalten', () => {
    const hc = goodHostConfig()
    hc.SecurityOpt = ['no-new-privileges:true', 'seccomp=unconfined']
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.securityopt')
  })

  test('no-new-privileges weglassen', () => {
    const hc = goodHostConfig()
    hc.SecurityOpt = []
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.securityopt')
  })
})

describe('Pflichtwerte', () => {
  test('Log-Rotation darf nicht aufgeweicht werden', () => {
    const hc = goodHostConfig()
    hc.LogConfig = { Type: 'json-file', Config: { 'max-size': '0', 'max-file': '1' } }
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.logconfig')
  })

  test('kein unbegrenzter Speicher', () => {
    const hc = goodHostConfig()
    hc.Memory = 0
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.memory')
  })

  test('RestartPolicy "no" ist für Wegwerf-Container zulässig (M2)', () => {
    const hc = goodHostConfig()
    hc.RestartPolicy = { Name: 'no' }
    assert.doesNotThrow(() => assertHostConfigPolicy(hc, NET))
  })

  test('RestartPolicy always ist nicht zulässig', () => {
    const hc = goodHostConfig()
    hc.RestartPolicy = { Name: 'always' }
    rejects(() => assertHostConfigPolicy(hc, NET), 'hostconfig.restartpolicy')
  })

  test('NetworkingConfig darf kein fremdes Netz verbinden', () => {
    const o = goodCreate()
    o.NetworkingConfig = { EndpointsConfig: { airlock_internal: {} } }
    rejects(() => assertCreatePolicy(o, NET), 'networkingconfig')
  })

  test('ungültiger Netzname wird abgelehnt', () => {
    rejects(() => assertCreatePolicy(goodCreate(), 'bridge'), 'network.name')
  })
})
