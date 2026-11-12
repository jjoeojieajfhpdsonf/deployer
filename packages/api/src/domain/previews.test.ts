import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'

// routes.ts zieht config.ts nach; für den Import genügt eine Dummy-Umgebung
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { normalizeCompose } = await import('../lib/compose.js')
const { projectNetworkName } = await import('../drivers/docker.js')
const { cidrsForTargets } = await import('./routes.js')
const { coveredByWildcard, urlFor } = await import('../lib/hostnames.js')
const { previewLabel, previewTargets, removeWith, PreviewBusyError } = await import('../lib/previews.js')

/**
 * Etappe 6: Vorschauen im Zusammenspiel mit Compose, Routen und Aufräumen –
 * ohne Datenbank und Docker (Wege ersetzt).
 */

const COMPOSE = [
  'services:',
  '  web:',
  '    image: ghcr.io/me/shop:1.4',
  '    depends_on: [db]',
  '  db:',
  '    image: postgres:17',
  '    volumes: ["db-data:/var/lib/postgresql/data"]',
  'volumes:',
  '  db-data: {}',
  '',
].join('\n')

const ctx = (slug: string) => ({
  slug, deploymentShort: 'abc123', deploymentId: '11111111-2222-3333-4444-555555555555', webService: 'web',
  network: projectNetworkName(slug), memoryLimitMb: 512, cpuLimit: 1, projectEnv: {}, repo: null,
})

describe('Volumes je Vorschau getrennt', () => {
  test('eigener Compose-Projektname air_<label>: Volumes, Netz und Container getrennt vom Projekt', async () => {
    const label = previewLabel('feature/login', 'shop')
    const prod = await normalizeCompose(COMPOSE, ctx('shop'))
    const prev = await normalizeCompose(COMPOSE, ctx(label))
    assert.equal(prod.projectName, 'air_shop')
    assert.equal(prev.projectName, `air_${label}`)
    assert.notEqual(prev.webContainer, prod.webContainer)
    const doc = parse(prev.yaml) as { volumes: Record<string, Record<string, unknown>>; networks: { default: { name: string } } }
    // Compose benennt das Volume <projekt>_db-data: air_feature-login--shop_db-data ≠ air_shop_db-data
    assert.deepEqual(doc.volumes, { 'db-data': {} })
    assert.equal(doc.networks.default.name, `air_${label}`)
    assert.notEqual(`${prev.projectName}_db-data`, `${prod.projectName}_db-data`)
  })

  test('eine compose.yaml kann nie auf ein fremdes (Produktions-)Volume zeigen', async () => {
    const label = previewLabel('feature/login', 'shop')
    const named = COMPOSE.replace('  db-data: {}', '  db-data:\n    name: air_shop_db-data')
    const external = COMPOSE.replace('  db-data: {}', '  db-data:\n    external: true')
    const bind = COMPOSE.replace('"db-data:/var/lib/postgresql/data"', '"/var/lib/docker/volumes/air_shop_db-data/_data:/var/lib/postgresql/data"')
    for (const y of [named, external, bind]) await assert.rejects(normalizeCompose(y, ctx(label)))
  })
})

describe('Routen der Vorschau', () => {
  test('nur LAN/Tailnet-Bereiche (plus localhost), nie der Tunnel – auch wenn das Projekt öffentlich ist', () => {
    const cidrs = cidrsForTargets(previewTargets(['public', 'tailnet']), '192.168.1.0/24', '100.64.0.0/10')
    assert.deepEqual(cidrs, ['100.64.0.0/10', '127.0.0.0/8', '::1/128'])
    assert.deepEqual(cidrsForTargets(previewTargets(['public', 'lan', 'tailnet']), '192.168.1.0/24', '100.64.0.0/10'), ['192.168.1.0/24', '100.64.0.0/10', '127.0.0.0/8', '::1/128'])
  })

  test('Adresse eine Ebene unter der internen Basis: Wildcard-Zertifikat deckt sie, https', () => {
    const host = `${previewLabel('feature/login', 'fotoalbum')}.int.example.ch`
    assert.equal(coveredByWildcard(host, 'int.example.ch'), true)
    assert.equal(urlFor(host, { baseDomain: 'int.example.ch', lanIp: null, nipio: false, tls: true }), `https://${host}`)
  })
})

describe('Aufräumen: Ablauf', () => {
  const world = (o: { locked?: number; reportFails?: boolean } = {}) => {
    const calls: string[] = []
    let locked = o.locked ?? 0
    return {
      calls,
      deps: {
        lock: async () => {
          if (locked > 0) { locked--; calls.push('lock:busy'); return null }
          calls.push('lock')
          return { release: async () => { calls.push('release') } }
        },
        sleep: async () => { calls.push('sleep') },
        report: async () => { calls.push('report'); if (o.reportFails) throw new Error('GitHub 502') },
        deleteProject: async (purge: true) => { calls.push(`delete:volumes=${purge}`) },
        audit: async () => { calls.push('audit') },
        warn: (m: string) => { calls.push(`warn:${m.slice(0, 20)}`) },
      },
    }
  }

  test('Kommentar, dann alles samt Volumes löschen, Sperre frei, Audit', async () => {
    const w = world()
    await removeWith(w.deps, { wait: false })
    assert.deepEqual(w.calls, ['lock', 'report', 'delete:volumes=true', 'release', 'audit'])
  })

  test('Kommentar scheitert: trotzdem gelöscht', async () => {
    const w = world({ reportFails: true })
    await removeWith(w.deps, { wait: false })
    assert.ok(w.calls.includes('delete:volumes=true'))
  })

  test('Deploy läuft: Abfrage bricht ab (nächstes Mal), Schalter aus wartet', async () => {
    const busy = world({ locked: 1 })
    await assert.rejects(removeWith(busy.deps, { wait: false }), PreviewBusyError)
    assert.ok(!busy.calls.some((c) => c.startsWith('delete')))
    const waiting = world({ locked: 2 })
    await removeWith(waiting.deps, { wait: true })
    assert.deepEqual(waiting.calls.filter((c) => !c.startsWith('lock')), ['sleep', 'sleep', 'report', 'delete:volumes=true', 'release', 'audit'])
  })
})
