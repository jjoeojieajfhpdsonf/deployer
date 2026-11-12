import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkExternalAddress, chooseNetwork, detectAdminUi, externalSourceIssues, externalSourceSchema, imageBase, projectState,
  createProjectSchema, HOST_GATEWAY_NAME,
} from '@airlock/shared'
import { isAirlockOwn, offerable, refind, toForeign, containerUpstream, type RawContainer } from './external.js'
import { publicGuardProblem, assertManaged, accessGuardOf } from '../domain/guard.js'

/** Bestehender Dienst: Adress-Prüfung, Netzwahl, Liste, Wiederfinden, Schutz-Pflicht, Zustand */

describe('Adresse im Heimnetz', () => {
  test('erlaubt: private Bereiche und Tailnet, mit und ohne Port', () => {
    for (const [input, url] of [
      ['http://192.168.1.20:8123', 'http://192.168.1.20:8123'],
      ['https://10.0.0.5', 'https://10.0.0.5:443'],
      ['http://172.16.0.1', 'http://172.16.0.1:80'],
      ['http://172.31.255.254:9000/', 'http://172.31.255.254:9000'],
      ['http://100.64.0.1:3000', 'http://100.64.0.1:3000'],
      ['HTTP://100.127.255.254:3000', 'http://100.127.255.254:3000'],
    ] as const) {
      const a = checkExternalAddress(input)
      assert.ok(a.ok, `${input}: ${!a.ok ? a.reason : ''}`)
      assert.equal(a.ok && a.url, url)
    }
  })

  test('abgelehnt: öffentlich, Server, Metadaten, Grenzen der Bereiche', () => {
    for (const input of [
      'http://8.8.8.8', 'http://127.0.0.1:3000', 'http://169.254.169.254', 'http://0.0.0.0:80',
      'http://172.15.255.255', 'http://172.32.0.1', 'http://100.63.255.255', 'http://100.128.0.0',
      'http://192.169.0.1', 'http://11.0.0.1', 'http://224.0.0.1',
    ]) {
      const a = checkExternalAddress(input)
      assert.equal(a.ok, false, input)
    }
  })

  test('abgelehnt: Namen, Zugangsdaten, Pfade, IPv6, andere Schemata, kaputte Zahlen', () => {
    const reasons: Record<string, RegExp> = {
      'http://nas.local:5000': /keinen Namen/,
      'http://admin:pw@192.168.1.2': /Benutzer und Passwort/,
      'http://192.168.1.2/admin': /ohne Pfad/,
      'http://192.168.1.2/?x=1': /ohne Pfad/,
      'http://[fd00::1]:80': /IPv6/,
      'ftp://192.168.1.2': /http:\/\/ oder https:\/\//,
      '192.168.1.2:8080': /http:\/\/ oder https:\/\//,
      'http://192.168.1.256': /keinen Namen/,
      'http://192.168.01.2': /keinen Namen/,
      'http://192.168.1.2:70000': /keinen Namen|Port/,
      '': /Gib eine Adresse an/,
    }
    for (const [input, re] of Object.entries(reasons)) {
      const a = checkExternalAddress(input)
      assert.equal(a.ok, false, input)
      assert.match(!a.ok ? a.reason : '', re, input)
    }
  })

  test('Quelle: genau ein Weg, Port beim Container, eigenes Zertifikat nur bei Adressen', () => {
    const parse = (v: unknown) => externalSourceIssues(externalSourceSchema.parse(v)).map((i) => i.message).join(' | ')
    assert.equal(parse({ type: 'external', container: 'sonarr', port: 8989 }), '')
    assert.equal(parse({ type: 'external', url: 'http://192.168.1.20:8123' }), '')
    assert.match(parse({ type: 'external' }), /entweder einen Container/)
    assert.match(parse({ type: 'external', container: 'a', url: 'http://192.168.1.2' }), /entweder einen Container/)
    assert.match(parse({ type: 'external', container: 'sonarr' }), /Port/)
    assert.match(parse({ type: 'external', url: 'http://8.8.8.8' }), /nicht im Heimnetz/)
    assert.match(parse({ type: 'external', container: 'a', port: 80, insecureTls: true }), /nur bei Adressen/)
    // Im Formular-Schema: dieselben Meldungen am Feld
    const r = createProjectSchema.safeParse({ name: 'NAS', source: { type: 'external', url: 'http://1.1.1.1' } })
    assert.equal(r.success, false)
  })
})

describe('Netzwahl für Caddy', () => {
  test('eigenes Netz vor «bridge», alphabetisch, Name als Ziel', () => {
    assert.deepEqual(chooseNetwork({ name: 'sonarr', hostMode: false, networks: [{ name: 'bridge', ip: '172.17.0.5' }, { name: 'media', ip: '172.20.0.3' }, { name: 'arr', ip: '172.21.0.3' }] }),
      { mode: 'network', network: 'arr', dialHost: 'sonarr' })
  })
  test('nur «bridge»: die IP (dort löst Docker keine Namen auf)', () => {
    assert.deepEqual(chooseNetwork({ name: 'old', hostMode: false, networks: [{ name: 'bridge', ip: '172.17.0.9' }] }),
      { mode: 'network', network: 'bridge', dialHost: '172.17.0.9' })
  })
  test('network_mode host: über host-gateway, kein Netz', () => {
    assert.deepEqual(chooseNetwork({ name: 'ha', hostMode: true, networks: [] }), { mode: 'host', dialHost: HOST_GATEWAY_NAME })
    assert.equal(containerUpstream({ name: 'ha', hostMode: true, networks: [] }, 8123).dial, 'host.docker.internal:8123')
  })
  test('nie Netze von Airlock oder Projekt-Netze; ohne Netz kein Ziel', () => {
    assert.equal(chooseNetwork({ name: 'x', hostMode: false, networks: [{ name: 'airlock_edge', ip: '1' }, { name: 'air_foto', ip: '2' }] }).mode, 'none')
    assert.equal(chooseNetwork({ name: 'x', hostMode: false, networks: [{ name: 'none', ip: null }] }).mode, 'none')
    assert.deepEqual(chooseNetwork({ name: 'x', hostMode: false, networks: [{ name: 'air_foto', ip: '2' }, { name: 'web', ip: '3' }] }), { mode: 'network', network: 'web', dialHost: 'x' })
  })
})

const raw = (o: Partial<RawContainer> & { Names: string[] }): RawContainer => ({
  Id: `${o.Names[0]!.replace('/', '')}000000000000000`, Image: 'nginx', State: 'running', Status: 'Up 2 hours', Labels: {},
  Ports: [], HostConfig: { NetworkMode: 'web' }, NetworkSettings: { Networks: { web: { IPAddress: '172.20.0.2' } } }, ...o,
})

describe('Liste der Container', () => {
  const list = [
    raw({ Names: ['/sonarr'], Image: 'lscr.io/linuxserver/sonarr:4', Ports: [{ PrivatePort: 8989, PublicPort: 8989, Type: 'tcp' }, { PrivatePort: 8989, Type: 'tcp' }] }),
    raw({ Names: ['/whoami'], Image: 'traefik/whoami', Ports: [{ PrivatePort: 80, Type: 'tcp' }, { PrivatePort: 53, Type: 'udp' }] }),
    raw({ Names: ['/airlock-app'], Labels: { 'com.docker.compose.project': 'airlock' } }),
    raw({ Names: ['/air_foto_abc'], Labels: { 'airlock.managed': 'true', 'airlock.project': 'foto' } }),
    raw({ Names: ['/dep_alt_1'], Labels: { 'deployer.managed': 'true' } }),
    raw({ Names: ['/scanner'], Labels: { 'airlock.role': 'scanner' } }),
    raw({ Names: ['/cloudflared-x'], Labels: { 'airlock.system': 'cloudflared' } }),
    raw({ Names: ['/gestoppt'], State: 'exited' }),
    raw({ Names: ['/media-db-1'], Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'db' } }),
  ].map(toForeign)

  test('ohne Airlocks eigene, ohne verwaltete, ohne gestoppte; Ports nur TCP, sortiert', () => {
    const out = offerable(list, [])
    assert.deepEqual(out.map((c) => c.name), ['media-db-1', 'sonarr', 'whoami'])
    assert.deepEqual(out.find((c) => c.name === 'sonarr')!.ports, [{ port: 8989, published: 8989 }])
    assert.deepEqual(out.find((c) => c.name === 'whoami')!.ports, [{ port: 80, published: null }])
    assert.equal(out.find((c) => c.name === 'sonarr')!.adminUi?.key, 'arr')
  })

  test('schon über Airlock erreichbar: markiert (nicht doppelt anbieten) – per Name oder Compose-Dienst', () => {
    const out = offerable(list, [
      { projectName: 'Sonarr', container: 'sonarr' },
      { projectName: 'Medien-DB', container: 'media-db-alt', composeProject: 'media', composeService: 'db' },
    ])
    assert.equal(out.find((c) => c.name === 'sonarr')!.takenBy, 'Sonarr')
    assert.equal(out.find((c) => c.name === 'media-db-1')!.takenBy, 'Medien-DB')
    assert.equal(out.find((c) => c.name === 'whoami')!.takenBy, null)
  })

  test('Airlock-eigen erkannt an Labels, Compose-Projekt und Namen', () => {
    for (const c of list.filter((x) => ['airlock-app', 'air_foto_abc', 'dep_alt_1', 'scanner', 'cloudflared-x'].includes(x.name))) assert.ok(isAirlockOwn(c), c.name)
    assert.equal(isAirlockOwn(list.find((x) => x.name === 'whoami')!), false)
  })

  test('Wiederfinden: Name, sonst Compose-Projekt und -Dienst, laufende zuerst; sonst null', () => {
    assert.equal(refind(list, { container: 'whoami' })?.name, 'whoami')
    // Compose hat den Container neu benannt (z. B. media-db-2): über die Labels
    const renamed = [...list.filter((c) => c.name !== 'media-db-1'), toForeign(raw({ Names: ['/media-db-2'], Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'db' } }))]
    assert.equal(refind(renamed, { container: 'media-db-1', composeProject: 'media', composeService: 'db' })?.name, 'media-db-2')
    assert.equal(refind(list, { container: 'weg' }), null)
  })
})

describe('Admin-Oberflächen', () => {
  test('Erkennung über Image (mit Registry, Tag, Digest) und Seitentitel', () => {
    assert.equal(imageBase('ghcr.io/linuxserver/sonarr:4.0@sha256:abc'), 'linuxserver/sonarr')
    assert.equal(imageBase('localhost:5000/portainer/portainer-ce'), 'portainer/portainer-ce')
    assert.equal(detectAdminUi({ image: 'portainer/portainer-ce:2.21' })?.key, 'portainer')
    assert.equal(detectAdminUi({ image: 'lscr.io/linuxserver/qbittorrent' })?.key, 'torrent')
    assert.equal(detectAdminUi({ image: 'pihole/pihole' })?.key, 'dns')
    assert.equal(detectAdminUi({ image: 'adminer' })?.key, 'db')
    assert.equal(detectAdminUi({ image: 'ghcr.io/home-assistant/home-assistant:stable' })?.key, 'homeassistant')
    assert.equal(detectAdminUi({ title: 'Proxmox Virtual Environment' })?.key, 'proxmox')
    assert.equal(detectAdminUi({ title: 'FRITZ!Box' })?.key, 'router')
    assert.equal(detectAdminUi({ title: 'Synology DiskStation' })?.key, 'nas')
    assert.equal(detectAdminUi({ title: 'AdGuard Home' })?.key, 'dns')
  })
  test('keine Admin-Oberfläche: gewöhnliche Apps', () => {
    assert.equal(detectAdminUi({ image: 'traefik/whoami' }), null)
    assert.equal(detectAdminUi({ image: 'nginx:alpine', title: 'Mein Blog' }), null)
    assert.equal(detectAdminUi({ image: 'sonarr-exporter' }), null)
  })

  type GuardRow = Parameters<typeof publicGuardProblem>[0]
  const ext = (over: Partial<GuardRow> = {}): GuardRow => ({
    sourceType: 'external', sourceConfig: { type: 'external', container: 'portainer', port: 9000, resolved: { adminUi: { key: 'portainer', name: 'Portainer' } } },
    loginGuard: false, adminOverrideAt: null, ...over,
  })

  test('Schutz-Pflicht: öffentlich nur mit Airlock-Login oder Cloudflare Access', () => {
    assert.match(publicGuardProblem(ext(), { accessProtected: false })!.message, /Portainer ist eine Verwaltungsoberfläche/)
    assert.equal(publicGuardProblem(ext(), { accessProtected: true }), null)
    assert.equal(publicGuardProblem(ext({ loginGuard: true }), { accessProtected: false }), null)
    // Schutz abschalten an einer öffentlichen Route: ebenso verweigert
    assert.ok(publicGuardProblem(ext({ loginGuard: true }), { accessProtected: false, loginGuard: false }))
  })
  test('übersteuert (sudo bestätigt): erlaubt; gewöhnliche Projekte: nie betroffen', () => {
    assert.equal(publicGuardProblem(ext({ adminOverrideAt: new Date() }), { accessProtected: false }), null)
    assert.equal(publicGuardProblem({ sourceType: 'image', sourceConfig: { image: 'nginx' }, loginGuard: false, adminOverrideAt: null }, { accessProtected: false }), null)
    // Auch ein deploytes Image einer Admin-Oberfläche fällt darunter
    assert.ok(publicGuardProblem({ sourceType: 'image', sourceConfig: { image: 'adminer:4' }, loginGuard: false, adminOverrideAt: null }, { accessProtected: false }))
  })
})

describe('Verhalten', () => {
  test('keine Deploys, kein Start, Stopp, Neustart', () => {
    assert.throws(() => assertManaged({ sourceType: 'external' }, 'Ein Deploy'), /Ein Deploy geht bei einem bestehenden Dienst nicht/)
    assert.doesNotThrow(() => assertManaged({ sourceType: 'image' }))
  })
  test('Zugang aus Login und Cloudflare Access', () => {
    assert.equal(accessGuardOf(false, []), 'offen')
    assert.equal(accessGuardOf(false, [{ target: 'public', accessProtected: true }]), 'cloudflare')
    assert.equal(accessGuardOf(true, [{ target: 'public', accessProtected: true }]), 'login')
  })
  test('Zustand: ohne Fassung «läuft», Ziel fehlt rot mit Hinweis, gestoppter Container, öffentlich pausiert', () => {
    const base = { status: 'running' as const, desiredState: 'running' as const, activeDeployment: null, lastDeployment: null, routes: [] }
    assert.equal(projectState({ ...base, external: { found: true, label: 'Container whoami, Port 80' } }).key, 'running')
    const missing = projectState({ ...base, external: { found: false, label: 'Container whoami, Port 80' } })
    assert.equal(missing.key, 'down')
    assert.equal(missing.label, 'Ziel fehlt')
    assert.match(missing.detail!, /Pause-Seite/)
    assert.match(projectState({ ...base, external: { found: true, running: false, label: 'Container x' } }).detail!, /nicht von Airlock verwaltet/)
    assert.equal(projectState({ ...base, routes: [{ target: 'public', pausedAt: '2026-11-12T00:00:00Z' }], external: { found: true, label: 'x' } }).key, 'paused')
  })
})
