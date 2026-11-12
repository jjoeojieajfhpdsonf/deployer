import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { addServiceSchema, removeServiceSchema } from '@airlock/shared'
import { addService, composeBase, newPassword, readCompose, removeService, varPrefix } from './compose-edit.js'
import { unifiedDiff } from './diff.js'
import { normalizeCompose, withMappedEnv, withServiceEnv } from './compose.js'

/**
 * Etappe 4: Compose-Erzeugung für «Dienst hinzufügen/entfernen» – rein,
 * ohne Datenbank. Geprüft: Vorlagen, Variablen und Verbindungs-Strings,
 * Erhalt der Datei des Nutzers (Kommentare), Diff, Prüfung gegen die
 * Compose-Regeln, Entfernen mit und ohne Volume.
 */

const PW = 'TestPasswort0123456789abcdefghij' // allowlist-secret
const ctx = (env: Record<string, string> = {}) => ({ webService: 'web', env, password: () => PW })
const add = (o: Record<string, unknown>) => addServiceSchema.parse({ action: 'add', ...o })
const rm = (o: Record<string, unknown>) => removeServiceSchema.parse({ action: 'remove', ...o })

const BASE = `# Mein Shop
services:
  web:
    image: ghcr.io/me/shop:1.4 # die App
    environment:
      NODE_ENV: production
  worker:
    image: ghcr.io/me/worker:1.4
    depends_on: [web]
`

describe('Dienst hinzufügen: Vorlagen', () => {
  test('PostgreSQL mit Volume, Verbindung für web und worker', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db', volume: true, connect: ['web', 'worker'] }), ctx())
    const doc = parse(r.text)
    assert.equal(doc.services.db.image, 'postgres:17')
    assert.deepEqual(doc.services.db['x-airlock-env'], { POSTGRES_PASSWORD: 'DB_PASSWORD' })
    assert.deepEqual(doc.services.db.volumes, ['db-data:/var/lib/postgresql/data'])
    assert.deepEqual(doc.volumes, { 'db-data': {} })
    // Startreihenfolge und Variable: web bekommt alle Projekt-Variablen, worker über x-airlock-env
    assert.deepEqual(doc.services.web.depends_on, ['db'])
    assert.deepEqual(doc.services.worker.depends_on, ['web', 'db'])
    assert.deepEqual(doc.services.worker['x-airlock-env'], { DATABASE_URL: 'DATABASE_URL' })
    assert.equal(doc.services.web['x-airlock-env'], undefined)
    assert.deepEqual(r.variables.map((v) => [v.key, v.secret, v.state]), [['DB_PASSWORD', true, 'new'], ['DATABASE_URL', true, 'new']])
    assert.equal(r.variables[1]!.value, `postgres://app:${PW}@db:5432/app`)
    assert.equal(r.volume, 'db-data')
    // Kein Passwort in der Datei
    assert.ok(!r.text.includes(PW))
  })

  test('Kommentare und Schreibweise des Nutzers bleiben, der Diff zeigt nur Neues', async () => {
    const r = await addService(BASE, add({ template: 'redis', name: 'cache', connect: ['web'] }), ctx())
    assert.ok(r.text.startsWith('# Mein Shop\n'))
    assert.ok(r.text.includes('image: ghcr.io/me/shop:1.4 # die App'))
    const d = unifiedDiff('compose.yaml', BASE, r.text)
    const removed = d.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    assert.deepEqual(removed, [])
    assert.match(d, /\+ {2}cache:/)
    assert.equal(r.variables.find((v) => v.key === 'REDIS_URL')?.value, `redis://:${PW}@cache:6379/0`)
    // Ohne Volume (Standard bei Redis)
    assert.equal(parse(r.text).volumes, undefined)
  })

  test('PostgreSQL 18: Daten unter /var/lib/postgresql', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db', version: '18', volume: true }), ctx())
    assert.deepEqual(parse(r.text).services.db.volumes, ['db-data:/var/lib/postgresql'])
  })

  test('MariaDB: zwei Passwörter, mysql-URL', async () => {
    const r = await addService(BASE, add({ template: 'mariadb', name: 'db', volume: true, connect: ['web'] }), ctx())
    assert.deepEqual(r.variables.map((v) => v.key), ['DB_PASSWORD', 'DB_ROOT_PASSWORD', 'DATABASE_URL'])
    assert.equal(r.variables[2]!.value, `mysql://app:${PW}@db:3306/app`)
  })

  test('MongoDB mit eigenem Namen der Verbindungs-Variable', async () => {
    const r = await addService(BASE, add({ template: 'mongo', name: 'docs', volume: true, connect: ['worker'], connectionVar: 'DOCS_URI' }), ctx())
    assert.equal(r.variables.find((v) => v.key === 'DOCS_URI')?.value, `mongodb://app:${PW}@docs:27017/?authSource=admin`)
    assert.deepEqual(parse(r.text).services.worker['x-airlock-env'], { DOCS_URI: 'DOCS_URI' })
  })

  test('Garage: Schlüssel im Format von Garage, S3-Variablen, Admin-API intern, Einmal-Dienst schreibt die Konfiguration', async () => {
    const r = await addService(BASE, add({ template: 'garage', name: 'files', volume: false, connect: ['web'] }), ctx())
    const v = Object.fromEntries(r.variables.map((x) => [x.key, x]))
    assert.deepEqual(r.variables.map((x) => [x.key, x.secret]), [
      ['FILES_ACCESS_KEY', true], ['FILES_SECRET_KEY', true], ['FILES_RPC_SECRET', true], ['FILES_ADMIN_TOKEN', true],
      ['S3_ENDPOINT', false], ['S3_ACCESS_KEY', false], ['S3_SECRET_KEY', true], ['S3_REGION', false], ['S3_BUCKET', false],
    ])
    // Garage prüft die Formate beim Anlegen: GK + 24 Hex, 64 Hex
    assert.match(v.FILES_ACCESS_KEY!.value, /^GK[0-9a-f]{24}$/)
    assert.match(v.FILES_SECRET_KEY!.value, /^[0-9a-f]{64}$/)
    assert.match(v.FILES_RPC_SECRET!.value, /^[0-9a-f]{64}$/)
    assert.equal(v.S3_ACCESS_KEY!.value, v.FILES_ACCESS_KEY!.value)
    assert.equal(v.S3_SECRET_KEY!.value, v.FILES_SECRET_KEY!.value)
    assert.equal(v.S3_ENDPOINT!.value, 'http://files:3900')
    assert.equal(v.S3_REGION!.value, 'garage')
    assert.equal(v.S3_BUCKET!.value, 'app')
    const doc = parse(r.text)
    const svc = doc.services.files
    assert.equal(svc.image, 'dxflrs/garage:v2.5.0')
    assert.deepEqual(svc.command, ['/garage', 'server', '--single-node', '--default-bucket'])
    assert.equal(svc['x-airlock-internal'], 3903)
    // Geheimnisse nie in der Datei, nur Namen der Variablen
    assert.deepEqual(svc['x-airlock-env'], { GARAGE_RPC_SECRET: 'FILES_RPC_SECRET', GARAGE_ADMIN_TOKEN: 'FILES_ADMIN_TOKEN', GARAGE_DEFAULT_ACCESS_KEY: 'FILES_ACCESS_KEY', GARAGE_DEFAULT_SECRET_KEY: 'FILES_SECRET_KEY' })
    assert.ok(!r.text.includes(v.FILES_SECRET_KEY!.value) && !r.text.includes(v.FILES_ACCESS_KEY!.value))
    assert.deepEqual(svc.depends_on, { 'files-init': { condition: 'service_completed_successfully' } })
    // Volume ist Pflicht (dort liegt auch die garage.toml), auch ohne Häkchen
    assert.equal(r.volume, 'files-data')
    assert.deepEqual(svc.volumes, ['files-data:/var/lib/garage'])
    const init = doc.services['files-init']
    assert.equal(init.image, 'busybox:1.37')
    assert.equal(init.restart, 'no')
    assert.deepEqual(init.volumes, ['files-data:/var/lib/garage'])
    assert.match(init.environment.GARAGE_TOML, /replication_factor = 1/)
    assert.match(init.environment.GARAGE_TOML, /s3_region = "garage"/)
    assert.ok(!/secret|token/i.test(init.environment.GARAGE_TOML))
    assert.ok(r.internal)
  })

  test('Garage entfernen: der Einmal-Dienst geht mit, allein lässt er sich nicht entfernen', async () => {
    const withGarage = (await addService(BASE, add({ template: 'garage', name: 'files', connect: ['web'] }), ctx())).text
    await assert.rejects(removeService(withGarage, { action: 'remove', name: 'files-init', dropVolume: false }, { webService: 'web' }), /gehört zu «files»/)
    const r = await removeService(withGarage, { action: 'remove', name: 'files', dropVolume: true }, { webService: 'web' })
    const doc = parse(r.text)
    assert.equal(doc.services.files, undefined)
    assert.equal(doc.services['files-init'], undefined)
    assert.deepEqual(r.dropped, ['files-data'])
    assert.ok(r.notes.some((n) => n.includes('files-init')))
  })

  test('MinIO gibt es als Vorlage nicht mehr; eine bestehende compose.yaml mit MinIO bleibt gültig', async () => {
    assert.equal(addServiceSchema.safeParse({ action: 'add', template: 'minio', name: 'files' }).success, false)
    const minio = `${BASE}  files:\n    image: minio/minio:latest\n    command: ["server", "/data"]\n`
    assert.deepEqual(readCompose(minio).services.includes('files'), true)
    const r = await removeService(minio, { action: 'remove', name: 'files', dropVolume: false }, { webService: 'web' })
    assert.equal(parse(r.text).services.files, undefined)
  })

  test('Mailpit: SMTP-URL ohne Passwort, Oberfläche intern', async () => {
    const r = await addService(BASE, add({ template: 'mailpit', name: 'mail', connect: ['web'] }), ctx())
    assert.deepEqual(r.variables.map((v) => [v.key, v.secret, v.value]), [['SMTP_URL', false, 'smtp://mail:1025']])
    assert.equal(parse(r.text).services.mail['x-airlock-internal'], 8025)
  })

  test('Adminer: nur interne Adresse, zeigt auf die erste Datenbank', async () => {
    const withDb = (await addService(BASE, add({ template: 'postgres', name: 'db', volume: true }), ctx())).text
    const r = await addService(withDb, add({ template: 'adminer', name: 'adminer' }), ctx())
    const svc = parse(r.text).services.adminer
    assert.equal(svc['x-airlock-internal'], 8080)
    assert.deepEqual(svc.environment, { ADMINER_DEFAULT_SERVER: 'db' })
    assert.equal(svc.ports, undefined)
    assert.deepEqual(r.variables, [])
  })

  test('Eigener Container: Image, Port, Volume mit Pfad', async () => {
    const r = await addService(BASE, add({ template: 'custom', name: 'search', image: 'getmeili/meilisearch:v1.10', port: 7700, volume: true, volumePath: '/meili_data' }), ctx())
    const svc = parse(r.text).services.search
    assert.equal(svc.image, 'getmeili/meilisearch:v1.10')
    assert.deepEqual(svc.expose, ['7700'])
    assert.deepEqual(svc.volumes, ['search-data:/meili_data'])
  })

  test('Liste depends_on in Zuordnungs-Form wird als Zuordnung ergänzt', async () => {
    const text = 'services:\n  web:\n    image: a\n    depends_on:\n      queue:\n        condition: service_started\n  queue:\n    image: b\n'
    const r = await addService(text, add({ template: 'postgres', name: 'db', connect: ['web'] }), ctx())
    assert.deepEqual(parse(r.text).services.web.depends_on, { queue: { condition: 'service_started' }, db: { condition: 'service_started' } })
  })
})

describe('Dienst hinzufügen: Variablen', () => {
  test('bestehendes Passwort wird weiterverwendet, URL passt dazu', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db', connect: ['web'] }), ctx({ DB_PASSWORD: 'alt' })) // allowlist-secret
    assert.deepEqual(r.variables.map((v) => [v.key, v.state]), [['DB_PASSWORD', 'reuse'], ['DATABASE_URL', 'new']])
    assert.equal(r.variables[1]!.value, 'postgres://app:alt@db:5432/app')
    assert.ok(r.notes.some((n) => n.includes('weiterverwendet')))
  })

  test('bestehende Verbindungs-Variable mit anderem Wert: Fehler am Feld', async () => {
    await assert.rejects(
      addService(BASE, add({ template: 'postgres', name: 'db', connect: ['web'] }), ctx({ DATABASE_URL: 'postgres://extern/x' })),
      (e: { details?: { path: string }[] }) => e.details?.[0]?.path === 'connectionVar',
    )
  })

  test('gleiche Verbindungs-Variable mit gleichem Wert: bleibt', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db', connect: ['web'] }), ctx({ DB_PASSWORD: 'alt', DATABASE_URL: 'postgres://app:alt@db:5432/app' })) // allowlist-secret
    assert.deepEqual(r.variables.map((v) => v.state), ['reuse', 'reuse'])
  })

  test('ohne verbundene Dienste: nur das Passwort', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db' }), ctx())
    assert.deepEqual(r.variables.map((v) => v.key), ['DB_PASSWORD'])
  })

  test('erzeugte Passwörter: 32 Zeichen, URL-sicher, jedes Mal anders', () => {
    const a = newPassword()
    assert.match(a, /^[A-Za-z0-9_-]{32}$/)
    assert.notEqual(a, newPassword())
  })

  test('Variablen-Präfix aus dem Dienstnamen', () => {
    assert.equal(varPrefix('cache-2'), 'CACHE_2')
  })

  test('Ende-zu-Ende: normalisiert und mit Werten gestartet bekommt jeder Dienst sein Passwort', async () => {
    const r = await addService(BASE, add({ template: 'postgres', name: 'db', volume: true, connect: ['web', 'worker'] }), ctx())
    const env = Object.fromEntries(r.variables.map((v) => [v.key, v.value]))
    const n = await normalizeCompose(r.text, { slug: 'shop', deploymentShort: 'x', deploymentId: 'x', webService: 'web', network: 'air_shop', memoryLimitMb: 256, cpuLimit: 1, projectEnv: {}, repo: null })
    const run = parse(withMappedEnv(withServiceEnv(n.yaml, 'web', env), env))
    assert.equal(run.services.db.environment.POSTGRES_PASSWORD, PW)
    assert.equal(run.services.worker.environment.DATABASE_URL, `postgres://app:${PW}@db:5432/app`)
    assert.equal(run.services.web.environment.DATABASE_URL, `postgres://app:${PW}@db:5432/app`)
    // Artefakt (normalisiert, ohne Werte) bleibt frei von Passwörtern
    assert.ok(!n.yaml.includes(PW))
  })
})

describe('Dienst hinzufügen: Ablehnungen', () => {
  test('Name schon vergeben', async () => {
    await assert.rejects(addService(BASE, add({ template: 'redis', name: 'worker' }), ctx()), /gibt es schon/)
  })
  test('unbekannter Dienst bei den Verbindungen', async () => {
    await assert.rejects(addService(BASE, add({ template: 'redis', name: 'cache', connect: ['api'] }), ctx()), /gibt es nicht/)
  })
  test('Adminer bietet keine Verbindung', async () => {
    await assert.rejects(addService(BASE, add({ template: 'adminer', name: 'adminer', connect: ['web'] }), ctx()), /keine Verbindung/)
  })
  test('eigener Container ohne Image', async () => {
    await assert.rejects(addService(BASE, add({ template: 'custom', name: 'x' }), ctx()), /Image/)
  })
  test('Name: nur klein, mit Buchstabe am Anfang (steht in der internen Adresse)', () => {
    assert.throws(() => add({ template: 'redis', name: 'Cache' }))
    assert.throws(() => add({ template: 'redis', name: '1cache' }))
  })
  test('eigenes Image mit Pfad als Volume-Ziel: relativer Pfad abgelehnt', () => {
    assert.throws(() => add({ template: 'custom', name: 'x', image: 'a:1', volume: true, volumePath: 'data' }))
  })
  test('Datei, die schon heute gegen die Regeln verstösst, bekommt keine Vorschau', async () => {
    const bad = 'services:\n  web:\n    image: a\n    ports: ["80:80"]\n'
    await assert.rejects(addService(bad, add({ template: 'redis', name: 'cache' }), ctx()), /ports/)
  })
})

describe('Dienst entfernen', () => {
  const WITH_DB = `services:
  web:
    image: a
    depends_on: [db, cache]
  db:
    image: postgres:17
    volumes:
      - db-data:/var/lib/postgresql/data
  cache:
    image: redis:7.4
volumes:
  db-data: {}
  shared: {}
`

  test('Volume standardmässig behalten (bleibt deklariert)', async () => {
    const r = await removeService(WITH_DB, rm({ name: 'db' }), { webService: 'web' })
    const doc = parse(r.text)
    assert.equal(doc.services.db, undefined)
    assert.deepEqual(doc.services.web.depends_on, ['cache'])
    assert.deepEqual(doc.volumes, { 'db-data': {}, shared: {} })
    assert.deepEqual(r.volumes, ['db-data'])
    assert.deepEqual(r.dropped, [])
    assert.deepEqual(r.dependents, ['web'])
    assert.ok(r.notes.some((n) => n.includes('bleibt mit allen Daten')))
  })

  test('mit Volume: Deklaration weg, nur Volumes dieses Dienstes', async () => {
    const r = await removeService(WITH_DB, rm({ name: 'db', dropVolume: true }), { webService: 'web' })
    assert.deepEqual(parse(r.text).volumes, { shared: {} })
    assert.deepEqual(r.dropped, ['db-data'])
  })

  test('Volume, das ein anderer Dienst auch nutzt, bleibt', async () => {
    const text = 'services:\n  web:\n    image: a\n    volumes: ["files:/files"]\n  sync:\n    image: b\n    volumes: ["files:/data"]\nvolumes:\n  files: {}\n'
    const r = await removeService(text, rm({ name: 'sync', dropVolume: true }), { webService: 'web' })
    assert.deepEqual(r.volumes, [])
    assert.deepEqual(parse(r.text).volumes, { files: {} })
  })

  test('leeres depends_on fällt weg', async () => {
    const text = 'services:\n  web:\n    image: a\n    depends_on: [db]\n  db:\n    image: b\n'
    const r = await removeService(text, rm({ name: 'db' }), { webService: 'web' })
    assert.equal(parse(r.text).services.web.depends_on, undefined)
  })

  test('Web-Dienst lässt sich nicht entfernen', async () => {
    await assert.rejects(removeService(WITH_DB, rm({ name: 'web' }), { webService: 'web' }), /Web-Dienst/)
  })

  test('unbekannter Dienst', async () => {
    await assert.rejects(removeService(WITH_DB, rm({ name: 'nope' }), { webService: 'web' }), /nicht/)
  })
})

describe('Hilfen', () => {
  test('readCompose: Dienste, Volumes, wer was einhängt', () => {
    const r = readCompose('services:\n  web:\n    image: a\n  db:\n    image: b\n    volumes:\n      - type: volume\n        source: data\n        target: /d\nvolumes:\n  data:\n')
    assert.deepEqual(r, { services: ['web', 'db'], volumes: ['data'], mounts: { web: [], db: ['data'] } })
  })
  test('composeBase: gleicher Text, gleicher Stand', () => {
    assert.equal(composeBase('a'), composeBase('a'))
    assert.notEqual(composeBase('a'), composeBase('b'))
  })
})
