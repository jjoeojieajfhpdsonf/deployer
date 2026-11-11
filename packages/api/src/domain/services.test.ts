import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import type { ServiceChangeInput } from '@airlock/shared'
import { composeBase } from '../lib/compose-edit.js'
import {
  applyServiceChange, nextStatus, planServiceChange, resolveChanges, serviceEditAbility, visibleChanges,
  type ChangeRow, type ComposeSource, type ResolveDeps, type ServiceDeps,
} from './services.js'

/**
 * Etappe 4: Ablauf «Dienst hinzufügen/entfernen» ohne Datenbank, Docker
 * und GitHub. Geprüft: Vorschau ändert nichts, Übernehmen nur auf dem Stand
 * der Vorschau, Variablen vor dem Deploy, Pull Request statt Deploy bei
 * Git-Projekten (gemockt), Entfernen mit und ohne Volume, Zustände.
 */

const PW = 'TestPasswort0123456789abcdefghij' // allowlist-secret
const COMPOSE = 'services:\n  web:\n    image: ghcr.io/me/shop:1.4\n  worker:\n    image: ghcr.io/me/worker:1.4\n'
const WITH_DB = 'services:\n  web:\n    image: a\n    depends_on: [db]\n  db:\n    image: postgres:17\n    volumes: ["db-data:/var/lib/postgresql/data"]\nvolumes:\n  db-data: {}\n'

interface World {
  deps: ServiceDeps
  writes: { text: string; kind: string; service: string; title: string; body: string }[]
  env: Record<string, string>
  added: { key: string; value: string; secret: boolean }[]
  rows: ChangeRow[]
  audits: { action: string; params: Record<string, unknown>; result: string }[]
  watched: string[]
}

function world(o: { way?: 'deploy' | 'pull_request'; text?: string; env?: Record<string, string>; writeFails?: boolean } = {}): World {
  const w: World = { deps: undefined as never, writes: [], env: { ...(o.env ?? {}) }, added: [], rows: [], audits: [], watched: [] }
  const source: ComposeSource = {
    way: o.way ?? 'deploy', path: 'compose.yaml', text: o.text ?? COMPOSE, branch: o.way === 'pull_request' ? 'main' : null,
    write: async (x) => {
      if (o.writeFails) throw new Error('GitHub 422: Reference already exists')
      w.writes.push({ text: x.text, kind: x.kind, service: x.service, title: x.title, body: x.body })
      return o.way === 'pull_request'
        ? { pr: { number: 12, url: 'https://github.com/me/shop/pull/12', branch: `airlock/dienst-neu-${x.service}-12345678` } }
        : { deploymentId: 'dep-1' }
    },
  }
  w.deps = {
    source: async () => source,
    webService: 'web',
    env: async () => ({ ...w.env }),
    addEnv: async (vars) => { for (const v of vars) { w.added.push(v); w.env[v.key] = v.value } },
    newId: () => '9f3a1c22-7d40-4e8b-9b1a-0c2d6e8f4a17',
    insert: async (row) => {
      const r: ChangeRow = { ...row, projectId: 'p1', createdAt: new Date('2026-11-10T13:00:00Z'), updatedAt: new Date('2026-11-10T13:00:00Z'), dismissedAt: null }
      w.rows.push(r)
      return r
    },
    watch: (id) => { w.watched.push(id) },
    audit: async (action, params, result) => { w.audits.push({ action, params, result }) },
    password: () => PW,
  }
  return w
}

const addDb: ServiceChangeInput = { action: 'add', template: 'postgres', name: 'db', volume: true, connect: ['web', 'worker'] }

describe('Vorschau', () => {
  test('zeigt Diff, Variablen ohne Werte und Hinweise – und ändert nichts', async () => {
    const w = world()
    const plan = await planServiceChange(addDb, w.deps)
    assert.equal(plan.way, 'deploy')
    assert.match(plan.diff, /^\+ {2}db:$/m)
    assert.match(plan.diff, /^\+ {6}POSTGRES_PASSWORD: DB_PASSWORD$/m)
    assert.deepEqual(plan.variables.map((v) => [v.key, v.secret, v.state]), [['DB_PASSWORD', true, 'new'], ['DATABASE_URL', true, 'new']])
    assert.ok(!JSON.stringify(plan).includes(PW), 'kein Passwort in der Vorschau')
    assert.equal(plan.base, composeBase(COMPOSE))
    assert.deepEqual(plan.volumes, ['db-data'])
    assert.deepEqual([w.writes.length, w.added.length, w.rows.length], [0, 0, 0])
  })
})

describe('Übernehmen & deployen', () => {
  test('legt erst die Variablen an, dann die Datei und den Deploy', async () => {
    const w = world()
    const c = await applyServiceChange(addDb, composeBase(COMPOSE), 'ui:joel', w.deps)
    assert.deepEqual(w.added.map((v) => [v.key, v.secret]), [['DB_PASSWORD', true], ['DATABASE_URL', true]])
    assert.equal(w.added[1]!.value, `postgres://app:${PW}@db:5432/app`)
    assert.equal(parse(w.writes[0]!.text).services.db.image, 'postgres:17')
    assert.ok(!w.writes[0]!.text.includes(PW))
    assert.deepEqual([c.status, c.deploymentId, c.kind, c.service, c.template], ['deploying', 'dep-1', 'add', 'db', 'postgres'])
    assert.deepEqual(w.watched, ['dep-1'])
    assert.equal(w.audits[0]!.action, 'service.add')
    assert.deepEqual(w.audits[0]!.params.variables, ['DB_PASSWORD', 'DATABASE_URL'])
    assert.ok(!JSON.stringify(w.audits).includes(PW), 'kein Passwort im Audit-Log')
  })

  test('nur auf dem Stand der Vorschau', async () => {
    const w = world()
    await assert.rejects(applyServiceChange(addDb, 'veraltet', 'ui:joel', w.deps), (e: { status?: number }) => e.status === 409)
    assert.deepEqual([w.writes.length, w.added.length], [0, 0])
  })

  test('bestehendes Passwort wird nicht neu angelegt', async () => {
    const w = world({ env: { DB_PASSWORD: 'alt' } }) // allowlist-secret
    await applyServiceChange(addDb, composeBase(COMPOSE), 'ui:joel', w.deps)
    assert.deepEqual(w.added.map((v) => v.key), ['DATABASE_URL'])
  })
})

describe('Git-Projekt: Pull Request über die GitHub-App (gemockt)', () => {
  test('kein Deploy, Pull Request mit Variablen-Liste ohne Werte', async () => {
    const w = world({ way: 'pull_request' })
    const plan = await planServiceChange(addDb, w.deps)
    assert.equal(plan.way, 'pull_request')
    assert.equal(plan.branch, 'main')
    const c = await applyServiceChange(addDb, plan.base, 'ui:joel', w.deps)
    assert.deepEqual([c.status, c.prNumber, c.deploymentId], ['pr_open', 12, null])
    assert.deepEqual(w.watched, [])
    assert.match(w.writes[0]!.body, /`DATABASE_URL` \(geheim\)/)
    assert.ok(!w.writes[0]!.body.includes(PW))
    assert.equal(w.audits[0]!.params.pr, 12)
  })

  test('Volume löschen ist bei Pull Requests nicht möglich', async () => {
    const w = world({ way: 'pull_request', text: WITH_DB })
    await assert.rejects(planServiceChange({ action: 'remove', name: 'db', dropVolume: true }, w.deps), /Volume erhalten/)
  })

  test('GitHub scheitert: Fehler im Audit-Log, keine Änderung gespeichert', async () => {
    const w = world({ way: 'pull_request', writeFails: true })
    await assert.rejects(applyServiceChange(addDb, composeBase(COMPOSE), 'ui:joel', w.deps), /422/)
    assert.equal(w.rows.length, 0)
    assert.equal(w.audits[0]!.result, 'error')
  })
})

describe('Entfernen', () => {
  test('ohne Volume: Datei ohne Dienst, Volume bleibt deklariert, nichts zum Löschen', async () => {
    const w = world({ text: WITH_DB })
    const plan = await planServiceChange({ action: 'remove', name: 'db', dropVolume: false }, w.deps)
    assert.deepEqual(plan.volumes, ['db-data'])
    await applyServiceChange({ action: 'remove', name: 'db', dropVolume: false }, plan.base, 'ui:joel', w.deps)
    const doc = parse(w.writes[0]!.text)
    assert.equal(doc.services.db, undefined)
    assert.deepEqual(doc.volumes, { 'db-data': {} })
    assert.deepEqual(w.rows[0]!.dropVolumes, [])
  })

  test('mit Volume: merkt das Volume zum Löschen nach dem Deploy vor', async () => {
    const w = world({ text: WITH_DB })
    const c = await applyServiceChange({ action: 'remove', name: 'db', dropVolume: true }, composeBase(WITH_DB), 'ui:joel', w.deps)
    assert.equal(parse(w.writes[0]!.text).volumes, undefined)
    assert.deepEqual(w.rows[0]!.dropVolumes, ['db-data'])
    assert.equal(c.kind, 'remove')
    assert.deepEqual(w.audits[0]!.params.dropVolumes, ['db-data'])
  })
})

describe('Abgleich nach dem Deploy', () => {
  const row = (o: Partial<ChangeRow>): ChangeRow => ({
    id: 'c1', projectId: 'p1', kind: 'remove', service: 'db', template: null, status: 'deploying', way: 'deploy', deploymentId: 'd1',
    prUrl: null, prNumber: null, branch: null, dropVolumes: [], diff: '', note: null, actor: 'ui:joel',
    createdAt: new Date(), updatedAt: new Date(), dismissedAt: null, ...o,
  })
  function rdeps(o: { status?: string; active?: string[] | null; pr?: { state: string; merged: boolean } | null; fail?: string[] } = {}) {
    const removed: string[][] = []
    const updates: Partial<ChangeRow>[] = []
    const d: ResolveDeps = {
      deploymentStatus: async () => o.status ?? 'active',
      activeServices: async () => (o.active === undefined ? ['web'] : o.active),
      pullState: async () => o.pr ?? null,
      removeVolumes: async (names) => { removed.push(names); return { removed: names.map((n) => `air_shop_${n}`), failed: o.fail ?? [] } },
      update: async (id, patch) => { updates.push(patch); return { ...row({}), id, ...patch } },
      audit: async () => {},
    }
    return { d, removed, updates }
  }

  test('Entfernen mit Volume: erst nach erfolgreichem Deploy gelöscht', async () => {
    const r = rdeps()
    const out = await resolveChanges([row({ dropVolumes: ['db-data'] })], r.d)
    assert.deepEqual(r.removed, [['db-data']])
    assert.equal(out[0]!.status, 'done')
    assert.match(out[0]!.note ?? '', /gelöscht/)
  })

  test('Entfernen ohne Volume: nichts gelöscht', async () => {
    const r = rdeps()
    await resolveChanges([row({})], r.d)
    assert.deepEqual(r.removed, [])
  })

  test('Deploy gescheitert: Volume bleibt, Zustand «failed»', async () => {
    const r = rdeps({ status: 'failed' })
    const out = await resolveChanges([row({ dropVolumes: ['db-data'] })], r.d)
    assert.deepEqual(r.removed, [])
    assert.equal(out[0]!.status, 'failed')
  })

  test('Deploy läuft noch: nichts passiert', async () => {
    const r = rdeps({ status: 'starting' })
    await resolveChanges([row({ dropVolumes: ['db-data'] })], r.d)
    assert.deepEqual([r.removed.length, r.updates.length], [0, 0])
  })

  test('Zustände von Pull Requests', () => {
    const pr = { status: 'pr_open' as const, kind: 'add' as const, service: 'db' }
    assert.equal(nextStatus(pr, { activeServices: ['web'], pr: { state: 'open', merged: false } }), 'pr_open')
    assert.equal(nextStatus(pr, { activeServices: ['web'], pr: { state: 'closed', merged: true } }), 'merged')
    assert.equal(nextStatus(pr, { activeServices: ['web'], pr: { state: 'closed', merged: false } }), 'closed')
    assert.equal(nextStatus(pr, { activeServices: ['web', 'db'], pr: null }), 'done')
    assert.equal(nextStatus({ ...pr, kind: 'remove' }, { activeServices: ['web'], pr: null }), 'done')
  })

  test('sichtbar: offene immer, gescheiterte 7 Tage oder bis ausgeblendet', () => {
    const now = Date.parse('2026-11-10T13:00:00Z')
    const old = new Date(now - 8 * 86_400_000)
    const rows = [
      row({ id: 'a', status: 'deploying' }), row({ id: 'b', status: 'failed', updatedAt: new Date(now) }), row({ id: 'c', status: 'failed', updatedAt: old }),
      row({ id: 'd', status: 'done' }), row({ id: 'e', status: 'closed', updatedAt: new Date(now), dismissedAt: new Date(now) }),
    ]
    assert.deepEqual(visibleChanges(rows, now).map((r) => r.id), ['a', 'b'])
  })
})

describe('Welche Projekte Dienste ändern können', () => {
  test('nur Compose; Git nur mit GitHub-App', () => {
    const base = { runtimeKind: 'compose', sourceType: 'compose', repoUrl: null, uploadId: null, github: false }
    assert.equal(serviceEditAbility({ ...base, sourceType: 'files' }).way, 'deploy')
    assert.equal(serviceEditAbility({ ...base, uploadId: 'u1' }).way, 'deploy')
    assert.equal(serviceEditAbility({ ...base, repoUrl: 'https://github.com/me/shop', github: true }).way, 'pull_request')
    const noApp = serviceEditAbility({ ...base, repoUrl: 'https://github.com/me/shop' })
    assert.equal(noApp.way, null)
    assert.match(noApp.reason ?? '', /GitHub-App/)
    assert.equal(serviceEditAbility({ ...base, runtimeKind: 'image', sourceType: 'image' }).way, null)
    assert.equal(serviceEditAbility({ ...base, runtimeKind: 'static', sourceType: 'files' }).way, null)
  })
})
