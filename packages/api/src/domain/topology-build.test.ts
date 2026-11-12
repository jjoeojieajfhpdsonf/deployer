import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { databaseKindOf, imageTag, type RouteDto } from '@airlock/shared'
import { buildTopology, parseComposeSpec, type ContainerInfo, type TopologyInput } from './topology-build.js'

/** Reiter «Aufbau»: Zusammenfassung aus Compose-Datei, Containern und Routen (ohne Datenbank, ohne Docker). */

const COMPOSE = `
name: air_fotoalbum
services:
  web:
    image: airlock/fotoalbum-web:3f9c21d0be4e
    depends_on: [worker]
    volumes:
      - fotos:/srv/fotos
    restart: unless-stopped
  worker:
    image: ghcr.io/example/fotoalbum-worker:1.4
    depends_on:
      db: { condition: service_healthy }
    volumes:
      - type: volume
        source: fotos
        target: /data
        read_only: true
    restart: unless-stopped
  migrate:
    image: ghcr.io/example/fotoalbum-migrate:1.4
    restart: "no"
  db:
    image: postgres:16-alpine
    expose: ["5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
volumes:
  fotos: {}
  pgdata: {}
  leer: {}
networks:
  default: { name: air_fotoalbum, external: true }
`

const c = (over: Partial<ContainerInfo> & { id: string }): ContainerInfo => ({
  service: null, image: 'x', state: 'running', status: 'Up 2 hours', mounts: [], ports: [], ...over,
})

const internal: RouteDto = {
  target: 'tailnet', targets: ['tailnet', 'lan'], hostname: 'fotoalbum.int.example.ch',
  aliases: ['fotoalbum.192-168-0-31.nip.io'], urls: ['https://fotoalbum.int.example.ch', 'http://fotoalbum.192-168-0-31.nip.io'],
}

const base = (over: Partial<TopologyInput> = {}): TopologyInput => ({
  kind: 'compose',
  slug: 'fotoalbum',
  port: 3000,
  webService: 'web',
  version: '3f9c21d0be4e',
  hasActive: true,
  activeContainerId: null,
  desiredRunning: true,
  compose: parseComposeSpec(COMPOSE),
  containers: [
    c({ id: 'c-web', service: 'web', image: 'airlock/fotoalbum-web:3f9c21d0be4e', status: 'Up 2 hours (healthy)', mounts: [{ name: 'air_fotoalbum_fotos', destination: '/srv/fotos' }], ports: [3000] }),
    c({ id: 'c-worker', service: 'worker', image: 'ghcr.io/example/fotoalbum-worker:1.4' }),
    c({ id: 'c-migrate', service: 'migrate', state: 'exited', status: 'Exited (0) 2 hours ago' }),
    c({ id: 'c-db', service: 'db', image: 'postgres:16-alpine', mounts: [{ name: 'air_fotoalbum_pgdata', destination: '/var/lib/postgresql/data' }], ports: [5432] }),
  ],
  composeVolumes: [{ name: 'air_fotoalbum_fotos', volume: 'fotos' }, { name: 'air_fotoalbum_pgdata', volume: 'pgdata' }],
  routes: [internal],
  headers: 5,
  ways: { public: true, tailnet: { cidr: '100.64.0.0/10', ip: '100.101.102.103' }, lan: { cidr: '192.168.0.0/24', ip: '192.168.0.31' } },
  tlsProblem: null,
  usage: { 'c-web': { cpu: 0.04, memMb: 160 }, 'c-db': { cpu: 0.01, memMb: 220 } },
  limits: { cpu: 1, memoryMb: 512 },
  ...over,
})

const edge = (t: ReturnType<typeof buildTopology>, from: string, to: string) => t.edges.find((e) => e.from === from && e.to === to)

describe('parseComposeSpec', () => {
  test('liest Image, depends_on (Liste und Zuordnung), Volumes (Text und Zuordnung), expose, Einmal-Dienste', () => {
    const s = parseComposeSpec(COMPOSE)!
    assert.deepEqual(s.services.map(([n]) => n), ['web', 'worker', 'migrate', 'db'])
    const by = new Map(s.services)
    assert.deepEqual(by.get('web')!.dependsOn, ['worker'])
    assert.deepEqual(by.get('worker')!.dependsOn, ['db'])
    assert.deepEqual(by.get('worker')!.volumes, [{ source: 'fotos', target: '/data' }])
    assert.deepEqual(by.get('db')!.expose, [5432])
    assert.equal(by.get('migrate')!.oneShot, true)
    assert.equal(by.get('web')!.oneShot, false)
    assert.deepEqual(s.volumes, ['fotos', 'pgdata', 'leer'])
  })

  test('kaputtes YAML oder ohne services: null', () => {
    assert.equal(parseComposeSpec('services: [unclosed'), null)
    assert.equal(parseComposeSpec('volumes: {}'), null)
  })
})

describe('databaseKindOf / imageTag', () => {
  test('Datenbank am Image erkannt, sonst null', () => {
    assert.equal(databaseKindOf('postgres:16-alpine'), 'postgres')
    assert.equal(databaseKindOf('bitnami/postgresql:16'), 'postgres')
    assert.equal(databaseKindOf('docker.io/library/mariadb:11'), 'mariadb')
    assert.equal(databaseKindOf('redis'), 'redis')
    assert.equal(databaseKindOf('mongo:7@sha256:' + 'a'.repeat(64)), 'mongo')
    assert.equal(databaseKindOf('mysql:8'), 'mysql')
    assert.equal(databaseKindOf('mongodb/mongodb-community-server:7.0'), 'mongo')
    // Werkzeug mit ähnlichem Namen ist keine Datenbank
    assert.equal(databaseKindOf('ghcr.io/example/postgres-backup:1'), null)
    assert.equal(databaseKindOf('node:22'), null)
    assert.equal(databaseKindOf(null), null)
  })
  test('Tag des Images', () => {
    assert.equal(imageTag('postgres:16-alpine'), '16-alpine')
    assert.equal(imageTag('registry:5000/app'), 'latest')
    assert.equal(imageTag('app@sha256:abc'), null)
  })
})

describe('buildTopology: Compose', () => {
  const t = buildTopology(base())

  test('Dienste: Web-Dienst zuerst, Datenbank erkannt, Port, Version, Zustand', () => {
    assert.deepEqual(t.services.map((s) => s.name), ['web', 'worker', 'migrate', 'db'])
    const [web, worker, migrate, db] = t.services
    assert.equal(t.main, 'svc:web')
    assert.equal(web!.web, true)
    assert.equal(web!.port, 3000)
    // selbst gebaut: die Fassung; sonst der Tag
    assert.equal(web!.version, '3f9c21d0be4e')
    assert.equal(worker!.version, '1.4')
    assert.equal(web!.health, 'healthy')
    assert.deepEqual(web!.usage, { cpu: 0.04, memMb: 160 })
    assert.equal(worker!.usage, null)
    assert.equal(migrate!.state, 'exited')
    assert.equal(migrate!.exitCode, 0)
    assert.equal(migrate!.oneShot, true)
    assert.equal(db!.database, 'postgres')
    assert.equal(db!.port, 5432)
    assert.equal(worker!.database, null)
  })

  test('Volumes: Name aus compose.yaml, Pfad, Nutzer; Grösse unbekannt statt erfunden; deklarierte ohne Nutzer bleiben', () => {
    const fotos = t.volumes.find((v) => v.name === 'fotos')!
    assert.deepEqual(fotos.usedBy, ['svc:web', 'svc:worker'])
    assert.equal(fotos.mountPath, '/srv/fotos')
    assert.deepEqual(fotos.paths, { 'svc:web': '/srv/fotos', 'svc:worker': '/data' })
    assert.equal(fotos.sizeBytes, null)
    assert.deepEqual(t.volumes.find((v) => v.name === 'pgdata')!.usedBy, ['svc:db'])
    assert.deepEqual(t.volumes.find((v) => v.name === 'leer')!.usedBy, [])
    assert.equal(t.volumes.length, 3)
  })

  test('Zugang: nur Wege der Umgebung; Internet aus zeigt gestrichelt auf den Hauptnamen', () => {
    assert.deepEqual(t.access.map((a) => [a.way, a.on, a.detail]), [['public', false, null], ['tailnet', true, '100.64.0.0/10'], ['lan', true, '192.168.0.0/24']])
    assert.deepEqual(edge(t, 'way:public', 'host:fotoalbum.int.example.ch'), { from: 'way:public', to: 'host:fotoalbum.int.example.ch', on: false, via: 'route' })
    assert.equal(edge(t, 'way:tailnet', 'host:fotoalbum.int.example.ch')!.on, true)
  })

  test('Eingang: Hauptname mit TLS und Headern, nip.io als Ausweich nur über das Heimnetz', () => {
    const [main, nip] = t.hosts
    assert.equal(main!.tls, 'https')
    assert.equal(main!.headers, 5)
    assert.deepEqual(main!.ways, ['tailnet', 'lan'])
    assert.equal(nip!.fallback, true)
    assert.equal(nip!.tls, 'http')
    assert.deepEqual(nip!.ways, ['lan'])
    assert.ok(edge(t, 'way:lan', nip!.id)?.on)
    assert.equal(edge(t, 'way:tailnet', nip!.id), undefined)
    assert.ok(edge(t, nip!.id, 'svc:web')?.on)
  })

  test('Dienst → Datenbank gemäss depends_on (worker), nicht jeder Dienst', () => {
    assert.deepEqual(edge(t, 'svc:worker', 'svc:db'), { from: 'svc:worker', to: 'svc:db', on: true, via: 'depends_on' })
    assert.equal(edge(t, 'svc:web', 'svc:db'), undefined)
  })

  test('Dienst → Volume gemäss Mounts', () => {
    assert.ok(edge(t, 'svc:web', 'vol:fotos')?.on)
    assert.ok(edge(t, 'svc:worker', 'vol:fotos')?.on)
    assert.equal(edge(t, 'svc:db', 'vol:pgdata')?.via, 'mount')
  })

  test('ohne depends_on: alle Dienste im Projekt-Netz zur Datenbank; gestoppter Dienst gestrichelt', () => {
    const spec = parseComposeSpec(COMPOSE.replace(/depends_on:\n\s+db: \{ condition: service_healthy \}\n/, ''))!
    const u = buildTopology(base({ compose: spec, containers: base().containers.map((x) => (x.id === 'c-worker' ? { ...x, state: 'exited', status: 'Exited (137) 1 minute ago' } : x)) }))
    for (const s of ['svc:web', 'svc:worker', 'svc:migrate']) assert.equal(edge(u, s, 'svc:db')?.via, 'network', s)
    assert.equal(edge(u, 'svc:worker', 'svc:db')!.on, false)
    assert.equal(u.services.find((s) => s.name === 'worker')!.exitCode, 137)
  })

  test('Dienst ohne Container: fehlt (Projekt soll laufen) bzw. gestoppt', () => {
    const u = buildTopology(base({ containers: [] }))
    assert.ok(u.services.every((s) => s.state === 'missing'))
    assert.equal(edge(u, 'host:fotoalbum.int.example.ch', 'svc:web')!.on, false)
    const v = buildTopology(base({ containers: [], desiredRunning: false }))
    assert.ok(v.services.every((s) => s.state === 'stopped'))
  })
})

describe('buildTopology: Einzelcontainer, statische Seite, öffentlich', () => {
  test('Einzelcontainer: ein Dienst; beendet mit Exit-Code; Volumes aus den Mounts (anonyme nicht)', () => {
    const t = buildTopology(base({
      kind: 'image', webService: null, compose: null, composeVolumes: [], activeContainerId: 'c1', port: 8080,
      containers: [c({ id: 'c1', image: 'ghcr.io/example/app:1.4.2', state: 'exited', status: 'Exited (1) 3 minutes ago', mounts: [{ name: 'app-data', destination: '/data' }, { name: 'f'.repeat(64), destination: '/tmp' }] })],
    }))
    assert.equal(t.services.length, 1)
    const s = t.services[0]!
    assert.deepEqual([s.name, s.version, s.state, s.exitCode, s.port], ['fotoalbum', '1.4.2', 'exited', 1, 8080])
    assert.deepEqual(t.volumes.map((v) => v.name), ['app-data'])
    assert.equal(edge(t, 'host:fotoalbum.int.example.ch', s.id)!.on, false)
  })

  test('statische Seite: Caddy liefert aus, kein Container; Tailnet fehlt in der Umgebung', () => {
    const route: RouteDto = { target: 'lan', targets: ['lan'], hostname: 'verein.192-168-0-31.nip.io', aliases: [], urls: ['http://verein.192-168-0-31.nip.io'] }
    const t = buildTopology(base({ kind: 'static', slug: 'verein', compose: null, containers: [], routes: [route], ways: { public: false, tailnet: null, lan: { cidr: '192.168.0.0/24', ip: '192.168.0.31' } } }))
    assert.deepEqual(t.services.map((s) => [s.name, s.state, s.image]), [['verein', 'static', null]])
    assert.deepEqual(t.access.map((a) => a.way), ['lan'])
    assert.equal(t.hosts[0]!.tls, 'http')
    assert.ok(edge(t, 'host:verein.192-168-0-31.nip.io', 'svc:verein')!.on)
  })

  test('öffentlich pausiert: Internet pausiert, Host und Linien gestrichelt; TLS über Cloudflare', () => {
    const pub: RouteDto = { target: 'public', targets: ['public'], hostname: 'fotos.example.ch', aliases: [], urls: ['https://fotos.example.ch'], accessProtected: true, pausedAt: '2026-11-11T10:00:00Z' }
    const t = buildTopology(base({ routes: [pub, internal] }))
    const a = t.access.find((x) => x.way === 'public')!
    assert.deepEqual([a.on, a.paused, a.detail], [false, true, 'Cloudflare Access'])
    const h = t.hosts.find((x) => x.hostname === 'fotos.example.ch')!
    assert.deepEqual([h.tls, h.paused, h.accessProtected], ['cloudflare', true, true])
    assert.equal(edge(t, 'way:public', h.id)!.on, false)
    assert.equal(edge(t, h.id, 'svc:web')!.on, false)
    // der interne Name bekommt keine Linie vom Internet
    assert.equal(edge(t, 'way:public', 'host:fotoalbum.int.example.ch'), undefined)
  })

  test('Zertifikatsproblem nur am https-Namen', () => {
    const t = buildTopology(base({ tlsProblem: 'Zertifikat läuft in 3 Tagen ab' }))
    assert.equal(t.hosts[0]!.tlsProblem, 'Zertifikat läuft in 3 Tagen ab')
    assert.equal(t.hosts[1]!.tlsProblem, null)
  })
})

describe('Etappe 4: interne Adresse eines Dienstes', () => {
  test('eigener Host zum Dienst (nicht zum Web-Dienst), nur interne Wege', () => {
    const t = buildTopology(base({
      internalHosts: [{ service: 'worker', hostname: 'worker--fotoalbum.int.example.ch', url: 'https://worker--fotoalbum.int.example.ch', ways: ['lan', 'tailnet', 'public'] }],
    }))
    const h = t.hosts.find((x) => x.internal)!
    assert.deepEqual([h.id, h.service, h.ways, h.tls], ['host:worker--fotoalbum.int.example.ch', 'svc:worker', ['lan', 'tailnet'], 'https'])
    assert.equal(edge(t, h.id, 'svc:worker')?.on, true)
    assert.equal(edge(t, h.id, 'svc:web'), undefined)
    assert.equal(edge(t, 'way:public', h.id), undefined)
    assert.ok(edge(t, 'way:lan', h.id))
  })

  test('unbekannter Dienst: kein Host', () => {
    const t = buildTopology(base({ internalHosts: [{ service: 'weg', hostname: 'weg--fotoalbum.int.example.ch', url: 'https://x', ways: ['lan'] }] }))
    assert.equal(t.hosts.some((x) => x.internal), false)
  })
})

describe('Bestehender Dienst: nur Zugang → Eingang → Ziel', () => {
  const ext = (e: Partial<NonNullable<TopologyInput['external']>> = {}) => buildTopology(base({
    kind: 'external', slug: 'sonarr', port: null, webService: null, version: null, hasActive: false, compose: null, containers: [], composeVolumes: [], usage: {},
    routes: [{ ...internal, hostname: 'sonarr.int.example.ch', aliases: [], urls: ['https://sonarr.int.example.ch'] }],
    external: { label: 'Container sonarr, Port 8989', mode: 'container', name: 'sonarr', image: 'lscr.io/linuxserver/sonarr:4.0.9', port: 8989, found: true, running: true, ...e },
  }))

  test('ein Ziel, keine Volumes, Linie vom Eingang zum Ziel', () => {
    const t = ext()
    assert.equal(t.kind, 'external')
    assert.deepEqual(t.services.map((s) => [s.name, s.image, s.port, s.state, s.version]), [['sonarr', 'lscr.io/linuxserver/sonarr:4.0.9', 8989, 'running', '4.0.9']])
    assert.equal(t.volumes.length, 0)
    assert.ok(t.edges.some((x) => x.to === t.services[0]!.id && x.via === 'route' && x.on))
    assert.deepEqual(t.external, { label: 'Container sonarr, Port 8989', mode: 'container', found: true })
  })

  test('Ziel fehlt bzw. gestoppt: Knoten «fehlt» bzw. «beendet», Linie gestrichelt', () => {
    assert.equal(ext({ found: false }).services[0]!.state, 'missing')
    assert.equal(ext({ running: false }).services[0]!.state, 'exited')
    assert.ok(ext({ found: false }).edges.filter((x) => x.via === 'route' && x.to.startsWith('svc:')).every((x) => !x.on))
  })
})
