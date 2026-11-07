import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeZip } from '../src/lib/zip-fixture.js'
import {
  BASE, login, api, upload, createProject, deleteProject, deleteByPrefix, waitDeployment,
  get, host, docker, dockerOk, sleep, dashIp,
} from './lib.js'

/**
 * Abnahme Meilenstein 1 als Regressionstest. Prüft gegen den laufenden Stack.
 */

const P = 'e2e-m1-'

before(async () => {
  await login()
  await deleteByPrefix(P)
})
after(async () => {
  await deleteByPrefix(P)
})

describe('M1: Image deployen', () => {
  let id = ''
  let slug = ''

  test('whoami ist in unter 2 Minuten erreichbar', async () => {
    const t0 = Date.now()
    const p = await createProject({ name: `${P}whoami`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80 })
    id = p.id
    slug = p.slug
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.equal((await get(host(slug))).status, 200)
    assert.ok(Date.now() - t0 < 120_000)
  })

  test('kein Host-Port, kein privileged, no-new-privileges', () => {
    const name = docker('ps', '--filter', `label=deployer.project=${slug}`, '--format', '{{.Names}}').split('\n')[0]!
    const out = docker('inspect', name, '--format', '{{json .HostConfig.PortBindings}}|{{.HostConfig.Privileged}}|{{json .HostConfig.SecurityOpt}}')
    const [ports, priv, sec] = out.split('|')
    assert.ok(ports === '{}' || ports === 'null', `PortBindings: ${ports}`)
    assert.equal(priv, 'false')
    assert.match(sec!, /no-new-privileges:true/)
  })

  test('ein Projekt-Container erreicht die Caddy-Admin-API nicht, wohl aber Caddy auf :80', () => {
    const net = `dep_${slug}`
    const admin = dockerOk('run', '--rm', '--network', net, 'curlimages/curl:latest', '-sf', '-m', '4', 'http://deployer-caddy:2019/config/')
    assert.equal(admin, false, 'Admin-API darf nicht erreichbar sein')
    const web = docker('run', '--rm', '--network', net, 'curlimages/curl:latest', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '4', 'http://deployer-caddy:80/')
    assert.equal(web, '404', 'Caddy selbst muss erreichbar sein (Gegenprobe)')
  })

  test('zweiter gleichzeitiger Deploy bekommt 409', async () => {
    const [a, b] = await Promise.all([api('POST', `/projects/${id}/deploy`, {}), sleep(150).then(() => api('POST', `/projects/${id}/deploy`, {}))])
    assert.equal(a.status, 200)
    assert.equal(b.status, 409)
    await waitDeployment(a.data.deployment.id)
    // "active" kommt, sobald die neue Fassung Verkehr bekommt; der alte
    // Container wird unmittelbar danach entfernt. Darauf warten.
    let n: string[] = []
    for (let i = 0; i < 20; i++) {
      n = docker('ps', '--filter', `label=deployer.project=${slug}`, '--format', '{{.Names}}').split('\n').filter(Boolean)
      if (n.length === 1) break
      await sleep(500)
    }
    assert.equal(n.length, 1, `Container: ${n.join(', ')}`)
  })

  test('fehlgeschlagener Deploy lässt die alte Fassung laufen und löst den deployer aus dem Netz', async () => {
    await api('PATCH', `/projects/${id}`, { port: 9999 })
    const d = await api('POST', `/projects/${id}/deploy`, {})
    const r = await waitDeployment(d.data.deployment.id)
    assert.equal(r.status, 'failed')
    assert.equal((await get(host(slug))).status, 200)
    const nets = docker('inspect', 'deployer-app', '--format', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
    assert.ok(!nets.includes('dep_'), `deployer hängt noch in: ${nets}`)
    await api('PATCH', `/projects/${id}`, { port: 80 })
  })

  test('unbekannter Name landet auf der Auffangroute', async () => {
    const r = await get(`http://gibts-nicht-${Date.now()}.${dashIp}.nip.io/`)
    assert.equal(r.status, 404)
  })

  test('Löschen hinterlässt nichts, und :80 bleibt erreichbar', async () => {
    await deleteProject(id)
    assert.equal(docker('ps', '-a', '--filter', `label=deployer.project=${slug}`, '-q'), '')
    assert.equal(dockerOk('network', 'inspect', `dep_${slug}`), false)
    assert.equal((await get(`${BASE}/health`)).status, 200)
    assert.equal((await get(host(slug))).status, 404)
  })
})

describe('M1: Anmeldung (Lücke gefunden im Review von M3)', () => {
  for (const path of ['/api/v1/projects', '/%61pi/v1/projects', '/%61%70%69/v1/projects', '/api/v1/%70rojects']) {
    test(`ohne Anmeldung kein Zugriff über ${path}`, async () => {
      const r = await fetch(`${BASE}${path}`)
      assert.ok(r.status === 401 || r.status === 404, `${path} -> ${r.status}`)
      assert.ok(!(await r.text()).includes('"projects"'))
    })
  }
  test('auch kein POST über einen kodierten Pfad', async () => {
    const r = await fetch(`${BASE}/%61pi/v1/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boese', source: { type: 'image', image: 'alpine' }, port: 80 }),
    })
    assert.ok(r.status === 401 || r.status === 404, String(r.status))
  })
})

describe('M1: statische Seite und Zip Slip', () => {
  test('ZIP mit ../ wird abgelehnt, nichts landet ausserhalb', async () => {
    const zip = makeZip([{ name: 'index.html', data: '<h1>x</h1>' }, { name: '../../entwischt.html', data: 'boom' }])
    const up = await upload('boese.zip', zip)
    const p = await createProject({ name: `${P}boese`, source: { type: 'static', uploadId: up } })
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'failed')
    const found = docker('exec', 'deployer-app', 'sh', '-c', 'find / -name entwischt.html -not -path "/proc/*" 2>/dev/null || true')
    assert.equal(found, '')
  })

  test('harmloses ZIP wird ausgeliefert', async () => {
    const up = await upload('ok.zip', makeZip([{ name: 'index.html', data: '<h1>statisch</h1>' }]))
    const p = await createProject({ name: `${P}statisch`, source: { type: 'static', uploadId: up } })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    assert.match((await get(host(p.slug))).body, /statisch/)
  })
})
