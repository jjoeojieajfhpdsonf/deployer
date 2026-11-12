import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DISK_BLOCK_PERCENT, diskLevel, diskPercentOf, type StorageDto } from '@airlock/shared'
import type { DfContainer, DfImage, DfVolume } from '../drivers/docker.js'
import {
  findOrphanVolumes, keptDeploymentIds, planCleanup, planToDto,
  type DeploymentRow, type FileListing, type PlanInput,
} from './plan.js'
import { mcpDiskUsage } from './mcp.js'
import { renderMessage } from '../notify/render.js'
import { parseCleanupArgs } from '../cli.js'

/**
 * Nacht 3, Etappe 3: Was das Aufräumen freigeben darf – geprüft an einer
 * Docker-Attrappe (Daten wie aus GET /system/df) und einer Liste von Ordnern.
 * Die Regeln aus dem Auftrag: nur mit Airlock-Label, nie das aktive Image,
 * nie ein benutztes, Volumes nie, Fremdes bleibt.
 */

const NOW = Date.parse('2026-11-12T03:00:00Z')
const H = 3_600_000
const D = 24 * H
const sec = (ms: number) => Math.floor(ms / 1000)

const P1 = '11111111-1111-4111-8111-111111111111'
const dep = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function rows(): DeploymentRow[] {
  // Projekt «shop»: aktiv d1, abgelöst d2..d8 (neueste zuerst), ein fehlgeschlagener d9
  const out: DeploymentRow[] = [
    { id: dep(1), projectId: P1, status: 'active', isActive: true, startedAt: NOW - 1 * D, imageRef: 'airlock/shop:d1', builtImages: [], siteVersion: null },
  ]
  for (let i = 2; i <= 8; i++) {
    out.push({ id: dep(i), projectId: P1, status: 'superseded', isActive: false, startedAt: NOW - i * D, imageRef: `airlock/shop:d${i}`, builtImages: [], siteVersion: null })
  }
  out.push({ id: dep(9), projectId: P1, status: 'failed', isActive: false, startedAt: NOW - 9 * D, imageRef: null, builtImages: [], siteVersion: null })
  return out
}

const managed = (project: string, deployment?: string): Record<string, string> => ({
  'airlock.managed': 'true', 'airlock.project': project, ...(deployment ? { 'airlock.deployment': deployment } : {}),
})

function image(id: string, tags: string[], labels: Record<string, string>, o: Partial<DfImage> = {}): DfImage {
  return { id: `sha256:${id.padEnd(64, '0')}`, tags, labels, size: 100_000_000, sharedSize: 40_000_000, created: sec(NOW - 30 * D), containers: 0, ...o }
}

function container(id: string, labels: Record<string, string>, o: Partial<DfContainer> = {}): DfContainer {
  return { id, names: [id], labels, state: 'exited', created: sec(NOW - 2 * D), sizeRw: 5_000_000, imageId: 'sha256:none', mounts: [], ...o }
}

function input(o: Partial<PlanInput> = {}): PlanInput {
  const images: DfImage[] = []
  for (let i = 1; i <= 8; i++) images.push(image(`d${i}`, [`airlock/shop:d${i}`], managed('shop', dep(i))))
  return {
    now: NOW,
    projects: [{ id: P1, slug: 'shop', uploadId: null }],
    deployments: rows(),
    images,
    containers: [],
    buildCache: [],
    settings: { keepVersions: 5, pruneBuildCache: true },
    ...o,
  }
}

describe('Fassungen: Rollback-Grenze', () => {
  test('aktiv + letzte 5 abgelöste + Fehlschläge bleiben (wie bisher pruneOldDeployments)', () => {
    const k = keptDeploymentIds(rows(), 5)
    assert.deepEqual([...k].sort(), [dep(1), dep(2), dep(3), dep(4), dep(5), dep(6), dep(9)].sort())
  })
  test('Grenze einstellbar: 2', () => {
    const k = keptDeploymentIds(rows(), 2)
    assert.ok(k.has(dep(1)) && k.has(dep(2)) && k.has(dep(3)))
    assert.ok(!k.has(dep(4)))
  })
  test('laufende Versuche bleiben immer', () => {
    const r = [{ id: 'a', status: 'pending', isActive: false }, { id: 'b', status: 'healthchecking', isActive: false }]
    assert.equal(keptDeploymentIds(r, 1).size, 2)
  })
})

describe('Images', () => {
  test('Images über der Grenze gehen, aktive und aufbewahrte bleiben', () => {
    const p = planCleanup(input())
    assert.deepEqual(p.images.map((i) => i.tags[0]).sort(), ['airlock/shop:d7', 'airlock/shop:d8'])
    assert.deepEqual(p.deployments.map((d) => d.id).sort(), [dep(7), dep(8)])
    assert.equal(p.images[0]!.reason, 'Ältere Fassung über der Rollback-Grenze')
    // Geschätzt ohne geteilte Schichten
    assert.equal(p.images[0]!.bytes, 60_000_000)
  })

  test('nie das aktive Image – auch nicht bei Grenze 1 und ohne Container', () => {
    const p = planCleanup(input({ settings: { keepVersions: 1, pruneBuildCache: false } }))
    assert.ok(!p.images.some((i) => i.tags.includes('airlock/shop:d1')))
    assert.ok(!p.images.some((i) => i.tags.includes('airlock/shop:d2')))
  })

  test('nie ein Image, das ein Container benutzt (auch ein gestoppter)', () => {
    const base = input()
    const used = base.images.find((i) => i.tags[0] === 'airlock/shop:d8')!
    const p = planCleanup({ ...base, containers: [container('c1', {}, { imageId: used.id, state: 'exited' })] })
    assert.ok(!p.images.some((i) => i.id === used.id))
    const q = planCleanup({ ...base, images: base.images.map((i) => (i.id === used.id ? { ...i, containers: 1 } : i)) })
    assert.ok(!q.images.some((i) => i.id === used.id))
  })

  test('fremde Images ohne Airlock-Label bleiben (Portainer, Datenbank, eigene Builds)', () => {
    const base = input()
    const p = planCleanup({
      ...base,
      images: [
        ...base.images,
        image('portainer', ['portainer/portainer-ce:2.21'], {}),
        image('postgres', ['postgres:17-alpine'], { 'org.opencontainers.image.title': 'postgres' }),
        image('dangling-fremd', [], {}),
        // Airlock-Stack selbst: Präfix airlock/, aber ohne Label
        image('caddy', ['airlock/caddy-cloudflare:local'], {}),
      ],
    })
    for (const name of ['portainer/portainer-ce:2.21', 'postgres:17-alpine', 'airlock/caddy-cloudflare:local']) {
      assert.ok(!p.images.some((i) => i.tags.includes(name)), name)
    }
    assert.ok(!p.images.some((i) => i.id.startsWith('sha256:dangling-fremd')))
  })

  test('Airlock-Label, aber ein fremder Tag: bleibt (niemand verliert einen eigenen Tag)', () => {
    const base = input()
    const p = planCleanup({ ...base, images: [image('x', ['airlock/shop:d8', 'meins:prod'], managed('shop', dep(8)))] })
    assert.equal(p.images.length, 0)
  })

  test('dangling mit Airlock-Label geht; gelöschtes Projekt geht', () => {
    const base = input()
    const p = planCleanup({
      ...base,
      images: [image('dang', [], managed('shop')), image('weg', ['airlock/alt:abc'], managed('alt', dep(77)))],
    })
    const why = Object.fromEntries(p.images.map((i) => [i.id.slice(7, 11), i.reason]))
    assert.equal(why.dang, 'Ohne Tag (dangling)')
    assert.equal(why['weg0'], 'Projekt oder Vorschau gelöscht')
  })

  test('Labels aus der deployer-Zeit zählen auch', () => {
    const p = planCleanup({ ...input(), images: [image('old', ['deployer/alt:abc'], { 'deployer.managed': 'true', 'deployer.project': 'alt' })] })
    assert.equal(p.images.length, 1)
  })

  test('frische Images bleiben (ein Deploy könnte gerade bauen)', () => {
    const p = planCleanup({ ...input(), images: [image('neu', [], managed('shop'), { created: sec(NOW - 10 * 60_000) })] })
    assert.equal(p.images.length, 0)
  })

  test('Image einer laufenden Fassung (pending) bleibt', () => {
    const base = input()
    const pending: DeploymentRow = { id: dep(50), projectId: P1, status: 'pending', isActive: false, startedAt: NOW, imageRef: null, builtImages: ['airlock/shop-web:x'], siteVersion: null }
    const p = planCleanup({ ...base, deployments: [...base.deployments, pending], images: [image('pend', ['airlock/shop-web:x'], managed('shop'))] })
    assert.equal(p.images.length, 0)
  })

  test('nur im Bereich (Smoke-Test): ohne Label alles andere unberührt, kein Build-Cache', () => {
    const base = input({ buildCache: [{ id: 'b', size: 9, inUse: false, shared: false, lastUsedAt: new Date(NOW - 30 * D).toISOString(), createdAt: null }] })
    const p = planCleanup({ ...base, scope: { key: 'airlock.smoke', value: 'x1' } })
    assert.equal(p.images.length, 0)
    assert.equal(p.buildCache, null)
    const q = planCleanup({ ...base, scope: { key: 'airlock.smoke', value: 'x1' }, images: [image('s', [], { ...managed('weg'), 'airlock.smoke': 'x1' })] })
    assert.equal(q.images.length, 1)
  })
})

describe('Container', () => {
  test('nur gestoppte Wegwerf-Container von Airlock', () => {
    const p = planCleanup({
      ...input(),
      containers: [
        container('build', { ...managed('shop'), 'airlock.role': 'build' }),
        container('scan', { 'airlock.managed': 'true', 'airlock.role': 'scanner' }),
        container('csp', { 'airlock.project': 'shop', 'airlock.check': 'csp' }),
        container('backup', { ...managed('shop'), 'airlock.role': 'backup-copy' }),
        container('laeuft', { ...managed('shop'), 'airlock.role': 'build' }, { state: 'running' }),
        container('dienst', { ...managed('shop'), 'airlock.compose-service': 'db', 'airlock.compose-restart': 'no' }),
        container('gestoppt', managed('shop', dep(1))),
        container('fremd', { 'com.docker.compose.project': 'portainer' }),
        container('frisch', { ...managed('shop'), 'airlock.role': 'build' }, { created: sec(NOW - 5 * 60_000) }),
      ],
    })
    assert.deepEqual(p.containers.map((c) => c.id).sort(), ['backup', 'build', 'csp', 'scan'])
  })
  test('ein Compose-Dienst mit Rolle bleibt trotzdem', () => {
    const p = planCleanup({ ...input(), containers: [container('x', { ...managed('shop'), 'airlock.role': 'build', 'airlock.compose-service': 'web' })] })
    assert.equal(p.containers.length, 0)
  })
})

describe('Build-Cache', () => {
  const cache = [
    { id: 'alt', size: 1_000, inUse: false, shared: false, lastUsedAt: new Date(NOW - 8 * D).toISOString(), createdAt: null },
    { id: 'jung', size: 2_000, inUse: false, shared: false, lastUsedAt: new Date(NOW - 2 * D).toISOString(), createdAt: null },
    { id: 'benutzt', size: 4_000, inUse: true, shared: false, lastUsedAt: new Date(NOW - 30 * D).toISOString(), createdAt: null },
  ]
  test('nur unbenutzt und älter als 7 Tage', () => {
    assert.deepEqual(planCleanup(input({ buildCache: cache })).buildCache, { count: 1, bytes: 1_000 })
  })
  test('ausgeschaltet: nichts', () => {
    assert.equal(planCleanup(input({ buildCache: cache, settings: { keepVersions: 5, pruneBuildCache: false } })).buildCache, null)
  })
})

describe('Dateien', () => {
  const files = (): FileListing => ({
    sites: [
      {
        slug: 'shop', bytes: 0, mtimeMs: NOW - 30 * D, current: 'v1',
        versions: [
          { name: 'v1', bytes: 10, mtimeMs: NOW - 1 * D },
          { name: 'v3', bytes: 30, mtimeMs: NOW - 3 * D },
          { name: 'v8', bytes: 80, mtimeMs: NOW - 8 * D },
          { name: 'neu', bytes: 5, mtimeMs: NOW - 5 * 60_000 },
        ],
      },
      { slug: 'geloescht', bytes: 500, mtimeMs: NOW - 3 * D, current: 'x', versions: [] },
      { slug: 'kuerzlich', bytes: 500, mtimeMs: NOW - 2 * H, current: 'x', versions: [] },
      { slug: '_pause', bytes: 7, mtimeMs: NOW - 30 * D, current: null, versions: [] },
    ],
    uploads: [
      { name: '22222222-2222-4222-8222-222222222222.zip', bytes: 1_000, mtimeMs: NOW - 30 * D },
      { name: '33333333-3333-4333-8333-333333333333.zip', bytes: 2_000, mtimeMs: NOW - 30 * D },
      { name: '44444444-4444-4444-8444-444444444444.yaml', bytes: 3_000, mtimeMs: NOW - 1 * D },
      { name: 'notiz.txt', bytes: 1, mtimeMs: NOW - 99 * D },
    ],
    artifacts: [
      { name: dep(1), bytes: 1, mtimeMs: NOW - D },
      { name: dep(8), bytes: 8, mtimeMs: NOW - 8 * D },
      { name: dep(99), bytes: 99, mtimeMs: NOW - 9 * D },
    ],
    logs: [
      { name: `${dep(2)}.log`, bytes: 2, mtimeMs: NOW - 2 * D },
      { name: `${dep(7)}.log`, bytes: 7, mtimeMs: NOW - 7 * D },
      { name: `${dep(98)}.log`, bytes: 98, mtimeMs: NOW - 9 * D },
    ],
  })

  test('statische Fassungen, Uploads, Artefakte, Logs über der Grenze', () => {
    const base = input()
    base.deployments = base.deployments.map((d) => ({ ...d, siteVersion: d.id === dep(1) ? 'v1' : d.id === dep(3) ? 'v3' : d.id === dep(8) ? 'v8' : null }))
    base.projects = [{ id: P1, slug: 'shop', uploadId: '22222222-2222-4222-8222-222222222222' }]
    const p = planCleanup({ ...base, files: files() })
    const names = p.files.map((f) => `${f.kind}:${f.name}`).sort()
    assert.deepEqual(names, [
      `artifact:${dep(8)}`, `artifact:${dep(99)}`,
      `log:${dep(7)}.log`, `log:${dep(98)}.log`,
      'site-version:geloescht/', 'site-version:shop/v8',
      'upload:33333333-3333-4333-8333-333333333333.zip',
    ].sort())
  })
})

describe('Verwaiste Volumes', () => {
  const vol = (name: string, labels: Record<string, string>, o: Partial<DfVolume> = {}): DfVolume => ({ name, labels, size: 1_000, refCount: 0, createdAt: null, ...o })
  test('nur mit Airlock-Bezug und ohne Projekt; nie automatisch', () => {
    const list = findOrphanVolumes([
      vol('air_alt_db', { 'com.docker.compose.project': 'air_alt', 'com.docker.compose.volume': 'db' }),
      vol('dep_uralt_data', { 'com.docker.compose.project': 'dep_uralt' }),
      vol('air_shop_db', { 'com.docker.compose.project': 'air_shop' }),
      vol('airlock_pgdata', { 'com.docker.compose.project': 'airlock' }),
      vol('portainer_data', {}),
      vol('scanner-cache', { 'airlock.managed': 'true', 'airlock.role': 'scanner-cache' }),
      vol('air_weg_x', { 'com.docker.compose.project': 'air_weg' }, { refCount: 1 }),
      vol('air_ext-scan_x', { 'com.docker.compose.project': 'air_ext-scan' }),
    ], new Set(['shop']), [])
    assert.deepEqual(list.map((v) => [v.name, v.project, v.inUse]), [
      ['air_alt_db', 'alt', false], ['air_weg_x', 'weg', true], ['dep_uralt_data', 'uralt', false],
    ])
  })
})

describe('Antwort und Stufen', () => {
  test('Plan als Antwort: Summe mit Build-Cache, je Art', () => {
    const dto = planToDto(planCleanup(input({ buildCache: [{ id: 'a', size: 1_000, inUse: false, shared: false, lastUsedAt: new Date(NOW - 9 * D).toISOString(), createdAt: null }] })))
    assert.equal(dto.total, 4)
    assert.equal(dto.bytes, 120_001_000)
    assert.deepEqual(dto.byKind.map((k) => [k.kind, k.count]), [['deployment', 2], ['image', 2]])
  })

  test('Stufen 80/90/95 und Prozent wie df', () => {
    assert.equal(diskLevel(79), 'ok')
    assert.equal(diskLevel(80), 'hinweis')
    assert.equal(diskLevel(90), 'warnung')
    assert.equal(diskLevel(DISK_BLOCK_PERCENT), 'gesperrt')
    // df: belegt 80, frei für Benutzer 15, reserviert 5 → 80 / 95 = 84.2 → 85 (aufgerundet wie df)
    assert.equal(diskPercentOf({ blocks: 100, bfree: 20, bavail: 15 }), 85)
    assert.equal(diskPercentOf({ blocks: 0, bfree: 0, bavail: 0 }), null)
  })

  test('MCP: nur Summen, keine Namen von Volumes oder Projekten', () => {
    const s: StorageDto = {
      disk: { usedBytes: 90e9, totalBytes: 100e9, percent: 91, level: 'warnung' },
      categories: [{ key: 'images', label: 'Images', bytes: 5e9, reclaimableBytes: 2e9, count: 12, note: null }],
      plan: planToDto(planCleanup(input())),
      orphanVolumes: [{ name: 'air_geheimprojekt_db', project: 'geheimprojekt', bytes: 3e9, createdAt: null, inUse: false }],
      settings: { keepVersions: 5, pruneBuildCache: true },
      lastRun: null, nextRunAt: null, deploysBlocked: false, measuredAt: new Date(NOW).toISOString(), running: false, problems: [],
    }
    const text = JSON.stringify(mcpDiskUsage(s))
    assert.ok(!text.includes('geheimprojekt'))
    assert.ok(!text.includes('airlock/shop'))
    assert.match(text, /"percent": ?91/)
    assert.match(text, /"count": ?1/)
  })

  test('Benachrichtigung ab 90 %: sagt, ob Deploys gesperrt sind', () => {
    const m = renderMessage('disk_space', { percent: 96, used: '96 GB', total: '100 GB', blocked: true, reclaimable: '4 GB' })
    assert.equal(m.title, 'Platte zu 96 % belegt')
    assert.match(m.body, /keine Deploys mehr/)
    assert.match(m.body, /etwa 4 GB/)
    assert.equal(m.priority, 5)
  })
})

describe('CLI: cleanup', () => {
  const err: string[] = []
  test('Standard ist die Vorschau; --apply nur ausdrücklich', () => {
    assert.deepEqual(parseCleanupArgs([], (l) => err.push(l)), { apply: false, scope: null, minAgeMs: undefined })
    assert.equal(parseCleanupArgs(['--apply'], (l) => err.push(l))?.apply, true)
  })
  test('unter einer Stunde nur mit Label (Test)', () => {
    assert.equal(parseCleanupArgs(['--min-age-minutes', '0'], (l) => err.push(l)), null)
    assert.deepEqual(parseCleanupArgs(['--only-label', 'airlock.smoke=ab12', '--min-age-minutes', '0'], (l) => err.push(l)), {
      apply: false, scope: { key: 'airlock.smoke', value: 'ab12' }, minAgeMs: 0,
    })
  })
  test('Unbekanntes wird abgelehnt', () => {
    assert.equal(parseCleanupArgs(['--force'], (l) => err.push(l)), null)
    assert.equal(parseCleanupArgs(['--only-label', 'kaputt'], (l) => err.push(l)), null)
  })
})
