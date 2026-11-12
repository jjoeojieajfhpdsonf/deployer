import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * Nacht 3, Etappe 3: Rechte des Socket-Proxys. Für Server › Speicher kam
 * genau SYSTEM dazu (GET /system/df, nur lesend). Jede weitere Erweiterung
 * fällt hier auf – geprüft an der Compose-Datei, die Joël startet.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const compose = parse(readFileSync(`${root}compose.yaml`, 'utf8')) as { services: Record<string, { environment?: Record<string, unknown>; volumes?: string[] }> }
const env = compose.services['socket-proxy']!.environment ?? {}
const on = Object.entries(env).filter(([, v]) => String(v) === '1').map(([k]) => k).sort()

describe('Socket-Proxy: Rechte', () => {
  test('erlaubt sind genau diese Bereiche (SYSTEM neu für die Belegung)', () => {
    assert.deepEqual(on, ['BUILD', 'CONTAINERS', 'IMAGES', 'INFO', 'NETWORKS', 'POST', 'SYSTEM', 'VERSION', 'VOLUMES'])
  })
  test('exec, Swarm, Secrets, Auth und Plugins bleiben aus', () => {
    for (const k of ['EXEC', 'SWARM', 'SECRETS', 'AUTH', 'PLUGINS', 'SESSION', 'DISTRIBUTION']) {
      assert.notEqual(String(env[k] ?? '0'), '1', `${k} muss aus bleiben`)
    }
  })
  test('Socket nur lesend eingehängt', () => {
    assert.ok(compose.services['socket-proxy']!.volumes?.includes('/var/run/docker.sock:/var/run/docker.sock:ro'))
  })
})
