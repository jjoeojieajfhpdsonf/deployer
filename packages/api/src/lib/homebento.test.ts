import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { mainUrlOf, type RouteDto } from '@airlock/shared'
import { HOMEBENTO, composeHomebentoLabels, homebentoIconForImage, homebentoLabels, withHomebentoDefault } from './names.js'
import { normalizeCompose, type ComposeContext } from './compose.js'

// docker.ts zieht config.ts nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { buildCreateOptions } = await import('../drivers/docker.js')

/**
 * Abgrenzung HomeBento: Projekt-Container tragen homebento.name/href/icon,
 * alles andere (Airlock selbst, Scan, Build, Kopien, Smoke) homebento.ignore.
 */

const route = (o: Partial<RouteDto> & Pick<RouteDto, 'target' | 'urls'>): RouteDto => ({ hostname: 'x', aliases: [], ...o })

describe('HomeBento: Hauptadresse', () => {
  test('öffentlich live vor Tailnet vor LAN', () => {
    const tail = route({ target: 'lan', targets: ['lan', 'tailnet'], urls: ['https://foto.int.example.ch'] })
    const pub = route({ target: 'public', urls: ['https://foto.example.ch'] })
    assert.equal(mainUrlOf([tail, pub]), 'https://foto.example.ch')
    assert.equal(mainUrlOf([tail]), 'https://foto.int.example.ch')
  })
  test('pausiert zählt nicht als Hauptadresse; ohne Adresse null', () => {
    const pub = route({ target: 'public', urls: ['https://foto.example.ch'], pausedAt: '2026-11-01T00:00:00Z' })
    const lan = route({ target: 'lan', urls: ['http://foto.192-168-1-20.nip.io'] })
    assert.equal(mainUrlOf([pub, lan]), 'http://foto.192-168-1-20.nip.io')
    assert.equal(mainUrlOf([pub]), null)
    assert.equal(mainUrlOf([]), null)
  })
})

describe('HomeBento: Labels', () => {
  test('Projekt: Name, Adresse, Icon – fehlende Werte ohne Schlüssel', () => {
    assert.deepEqual(homebentoLabels({ name: 'Fotoalbum', href: 'https://foto.example.ch', icon: null }), {
      'homebento.name': 'Fotoalbum',
      'homebento.href': 'https://foto.example.ch',
    })
    assert.deepEqual(homebentoLabels({ name: 'Wetter' }), { 'homebento.name': 'Wetter' })
  })

  test('Compose: Web-Dienst mit Adresse, übrige «Projekt · Dienst», Icon aus bekanntem Image', () => {
    assert.deepEqual(composeHomebentoLabels({ projectName: 'Shop', service: 'web', webService: 'web', href: 'https://shop.example.ch', image: 'ghcr.io/me/shop:1' }), {
      'homebento.name': 'Shop · web',
      'homebento.href': 'https://shop.example.ch',
    })
    assert.deepEqual(composeHomebentoLabels({ projectName: 'Shop', service: 'db', webService: 'web', href: 'https://shop.example.ch', image: 'postgres:17-alpine' }), {
      'homebento.name': 'Shop · db',
      'homebento.icon': 'postgres',
    })
  })

  test('Icon nur für bekannte Images, nie für selbst gebaute', () => {
    assert.equal(homebentoIconForImage('docker.io/library/redis:7@sha256:abc'), 'redis')
    assert.equal(homebentoIconForImage('bitnami/postgresql:16'), 'postgres')
    assert.equal(homebentoIconForImage('adminer'), 'adminer')
    assert.equal(homebentoIconForImage('airlock/redis:abc123'), null)
    assert.equal(homebentoIconForImage('ghcr.io/me/eigene-app:1'), null)
    assert.equal(homebentoIconForImage(null), null)
  })

  test('ohne homebento.name ausgeblendet; vorhandene Angaben bleiben', () => {
    assert.deepEqual(withHomebentoDefault({ 'airlock.role': 'scanner' }), { 'airlock.role': 'scanner', [HOMEBENTO.ignore]: 'true' })
    assert.deepEqual(withHomebentoDefault({ [HOMEBENTO.name]: 'Foto' }), { [HOMEBENTO.name]: 'Foto' })
    assert.deepEqual(withHomebentoDefault({ [HOMEBENTO.ignore]: 'false' }), { [HOMEBENTO.ignore]: 'false' })
  })
})

describe('HomeBento: Container, die Airlock anlegt', () => {
  const spec = (labels: Record<string, string>) => ({ name: 'air_foto_x', image: 'nginx', network: 'air_foto', env: {}, labels, memoryLimitMb: 128, cpuLimit: 0.5 })

  test('Wegwerf-Container (Scan, Build, Kopie) bekommen homebento.ignore', () => {
    for (const role of ['scanner', 'build', 'backup-copy', 'backup-restore', 'volume-copy']) {
      const o = buildCreateOptions(spec({ 'airlock.managed': 'true', 'airlock.project': 'foto', 'airlock.role': role })) as { Labels: Record<string, string> }
      assert.equal(o.Labels['homebento.ignore'], 'true', role)
      assert.equal(o.Labels['homebento.name'], undefined, role)
    }
    // CSP-Prüfung (Smoke im Browser) ebenso
    const csp = buildCreateOptions(spec({ 'airlock.project': 'foto', 'airlock.check': 'csp' })) as { Labels: Record<string, string> }
    assert.equal(csp.Labels['homebento.ignore'], 'true')
  })

  test('Projekt-Container: Name und Adresse, kein ignore', () => {
    const o = buildCreateOptions(spec({ 'airlock.managed': 'true', 'airlock.project': 'foto', 'airlock.deployment': 'd1', ...homebentoLabels({ name: 'Fotoalbum', href: 'https://foto.example.ch' }) })) as { Labels: Record<string, string> }
    assert.equal(o.Labels['homebento.name'], 'Fotoalbum')
    assert.equal(o.Labels['homebento.href'], 'https://foto.example.ch')
    assert.equal(o.Labels['homebento.ignore'], undefined)
  })

  test('Compose-Projekt: jeder Dienst mit Labels; eigene homebento.*-Labels gewinnen; airlock.* bleibt', async () => {
    const ctx: ComposeContext = {
      slug: 'shop', deploymentShort: 'abc', deploymentId: 'd1', webService: 'web', network: 'air_shop',
      memoryLimitMb: 256, cpuLimit: 1, projectEnv: {}, repo: null,
      homebento: { projectName: 'Shop', href: 'https://shop.example.ch' },
    }
    const yaml = [
      'services:',
      '  web:',
      '    image: traefik/whoami:latest',
      '  db:',
      '    image: postgres:17-alpine',
      '  cache:',
      '    image: redis:7',
      '    labels:',
      '      homebento.ignore: "true"',
      '      homebento.name: Eigener Name',
    ].join('\n')
    const doc = parse((await normalizeCompose(yaml, ctx)).yaml) as { services: Record<string, { labels: Record<string, string> }> }
    assert.equal(doc.services.web!.labels['homebento.name'], 'Shop · web')
    assert.equal(doc.services.web!.labels['homebento.href'], 'https://shop.example.ch')
    assert.equal(doc.services.db!.labels['homebento.name'], 'Shop · db')
    assert.equal(doc.services.db!.labels['homebento.href'], undefined)
    assert.equal(doc.services.db!.labels['homebento.icon'], 'postgres')
    assert.equal(doc.services.cache!.labels['homebento.name'], 'Eigener Name')
    assert.equal(doc.services.cache!.labels['homebento.ignore'], 'true')
    assert.equal(doc.services.cache!.labels['airlock.project'], 'shop')
  })

  test('ohne Angaben (Prüfung beim Bearbeiten) keine homebento.*-Labels', async () => {
    const ctx: ComposeContext = { slug: 'shop', deploymentShort: 'abc', deploymentId: 'd1', webService: 'web', network: 'air_shop', memoryLimitMb: 256, cpuLimit: 1, projectEnv: {}, repo: null }
    const doc = parse((await normalizeCompose('services:\n  web:\n    image: traefik/whoami:latest\n', ctx)).yaml) as { services: Record<string, { labels: Record<string, string> }> }
    assert.deepEqual(Object.keys(doc.services.web!.labels).filter((k) => k.startsWith('homebento.')), [])
  })
})

describe('HomeBento: Airlocks eigene Dienste in den Compose-Dateien', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const servicesOf = (file: string) => (parse(readFileSync(`${root}${file}`, 'utf8'), { merge: true }) as { services: Record<string, { labels?: Record<string, string> }> }).services

  test('compose.yaml: jeder Dienst (airlock, caddy, db, socket-proxy, status, firewall, backup) mit homebento.ignore', () => {
    const services = servicesOf('compose.yaml')
    assert.deepEqual(Object.keys(services).sort(), ['airlock', 'backup', 'caddy', 'firewall', 'postgres', 'socket-proxy', 'status'])
    for (const [name, s] of Object.entries(services)) assert.equal(s.labels?.['homebento.ignore'], 'true', name)
  })

  test('compose.public.yaml: cloudflared mit homebento.ignore', () => {
    assert.equal(servicesOf('compose.public.yaml').cloudflared!.labels?.['homebento.ignore'], 'true')
  })
})
