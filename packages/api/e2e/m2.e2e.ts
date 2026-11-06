import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { startGitHttpServer, makeRepo, type GitHttpServer } from '../src/lib/git-http-fixture.js'
import {
  login, api, upload, createProject, deleteByPrefix, waitDeployment, get, host, docker, sleep,
} from './lib.js'

/**
 * Abnahme Meilenstein 2: Dockerfile, Compose, statisch aus Repo, Rollback,
 * Umschalten ohne Ausfall. Ein kleiner Git-Server läuft auf dem Host; der
 * deployer-Container erreicht ihn unter host.docker.internal (Docker Desktop).
 */

const P = 'e2e-m2-'
const work = mkdtempSync(join(process.cwd(), '..', '..', '.tmp', 'e2e-m2-'))
let git: GitHttpServer
let repoBase = ''

const gitc = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim()

/** Legt ein Repo an, veröffentlicht es als bare und gibt URL und Commit zurück. */
function publish(name: string, files: Record<string, string>): { url: string; commit: string; src: string } {
  const src = join(work, `${name}-src`)
  const commit = makeRepo(src, files)
  execFileSync('git', ['clone', '-q', '--bare', src, join(work, 'served', `${name}.git`)])
  return { url: `${repoBase}/${name}.git`, commit, src }
}

/** Neuer Commit im Quell-Repo, dann in das veröffentlichte Repo schieben. */
function commitAndPush(name: string, src: string, files: Record<string, string>): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(src, p, '..'), { recursive: true })
    writeFileSync(join(src, p), c)
  }
  gitc(src, 'add', '-A')
  gitc(src, 'commit', '-q', '-m', 'update')
  gitc(src, 'push', '-q', join(work, 'served', `${name}.git`), 'main')
  return gitc(src, 'rev-parse', 'HEAD')
}

const dockerfileFor = (text: string) => ({
  Dockerfile: 'FROM busybox:1.36\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd","-f","-p","8080","-h","/www"]\n',
  'index.html': `<h1>${text}</h1>`,
})

before(async () => {
  mkdirSync(join(work, 'served'), { recursive: true })
  git = await startGitHttpServer(join(work, 'served'), '0.0.0.0')
  repoBase = `http://host.docker.internal:${git.port}`
  await login()
  await deleteByPrefix(P)
})

after(async () => {
  await deleteByPrefix(P)
  await git.close()
  rmSync(work, { recursive: true, force: true })
})

describe('M2: Dockerfile aus einem Repo', () => {
  let repo: ReturnType<typeof publish>
  let id = ''
  let slug = ''
  let firstDeployment = ''

  test('wird geklont, gebaut und ausgeliefert; Version ist der Commit', async () => {
    repo = publish('app', dockerfileFor('version eins'))
    const p = await createProject({ name: `${P}docker`, source: { type: 'dockerfile', repoUrl: repo.url }, port: 8080 })
    id = p.id
    slug = p.slug
    firstDeployment = p.deploymentId
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.match((await get(host(slug))).body, /version eins/)
    const d = await api('GET', `/deployments/${p.deploymentId}`)
    assert.equal(d.data.deployment.version, repo.commit)
  })

  test('neuer Commit wird deployt', async () => {
    commitAndPush('app', repo.src, { 'index.html': '<h1>version zwei</h1>' })
    const d = await api('POST', `/projects/${id}/deploy`, {})
    assert.equal((await waitDeployment(d.data.deployment.id)).status, 'active')
    assert.match((await get(host(slug))).body, /version zwei/)
  })

  test('kaputter Build lässt die laufende Fassung unberührt', async () => {
    commitAndPush('app', repo.src, { Dockerfile: 'FROM busybox:1.36\nRUN false\n' })
    const d = await api('POST', `/projects/${id}/deploy`, {})
    const r = await waitDeployment(d.data.deployment.id)
    assert.equal(r.status, 'failed')
    assert.match((await get(host(slug))).body, /version zwei/)
  })

  test('Rollback bringt die erste Fassung zurück, als eigener Eintrag', async () => {
    const r = await api('POST', `/projects/${id}/rollback`, { deploymentId: firstDeployment })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const done = await waitDeployment(r.data.deployment.id)
    assert.equal(done.status, 'active', done.log)
    assert.match((await get(host(slug))).body, /version eins/)
    const list = await api('GET', `/projects/${id}/deployments`)
    const rb = list.data.deployments.find((x: any) => x.id === r.data.deployment.id)
    assert.equal(rb.trigger, 'rollback')
    assert.equal(rb.rollbackOf, firstDeployment)
  })
})

describe('M2: statische Seite aus einem Repo', () => {
  test('mit npm-Build im Wegwerf-Container; danach kein Build-Container mehr', async () => {
    const repo = publish('site', {
      'package.json': JSON.stringify({ name: 'site', version: '1.0.0', scripts: { build: 'node build.js' } }),
      'build.js': "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>gebaut '+process.version+'</h1>')",
    })
    const p = await createProject({ name: `${P}site`, source: { type: 'static', repoUrl: repo.url, buildCommand: 'npm run build' } })
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.match((await get(host(p.slug))).body, /gebaut v22/)
    assert.equal(docker('ps', '-a', '--filter', 'label=deployer.role=build', '-q'), '')
  })

  test('Rollback einer statischen Seite hängt current auf die alte Fassung', async () => {
    const { makeZip } = await import('../src/lib/zip-fixture.js')
    const up1 = await upload('v1.zip', makeZip([{ name: 'index.html', data: '<h1>statisch eins</h1>' }]))
    const p = await createProject({ name: `${P}srb`, source: { type: 'static', uploadId: up1 } })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const up2 = await upload('v2.zip', makeZip([{ name: 'index.html', data: '<h1>statisch zwei</h1>' }]))
    await api('PATCH', `/projects/${p.id}`, { source: { type: 'static', uploadId: up2 } })
    const d2 = await api('POST', `/projects/${p.id}/deploy`, {})
    assert.equal((await waitDeployment(d2.data.deployment.id)).status, 'active')
    assert.match((await get(host(p.slug))).body, /statisch zwei/)
    const rb = await api('POST', `/projects/${p.id}/rollback`, {})
    assert.equal((await waitDeployment(rb.data.deployment.id)).status, 'active')
    assert.match((await get(host(p.slug))).body, /statisch eins/)
  })

  test('ohne Build: Ausgabeordner wird direkt übernommen', async () => {
    const repo = publish('plain', { 'public/index.html': '<h1>direkt</h1>', 'README.md': 'x' })
    const p = await createProject({ name: `${P}plain`, source: { type: 'static', repoUrl: repo.url, outputDir: 'public' } })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    assert.match((await get(host(p.slug))).body, /direkt/)
  })
})

describe('M2: Compose', () => {
  const v1 = `services:
  web:
    image: traefik/whoami:v1.10.1
    depends_on: [cache]
  cache:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["daten:/data"]
volumes:
  daten:
`
  let id = ''
  let slug = ''
  let first = ''

  test('hochgeladene compose.yaml mit Web-Dienst und Datenbank läuft', async () => {
    const up = await upload('compose.yaml', v1)
    const p = await createProject({ name: `${P}compose`, source: { type: 'compose', uploadId: up, webService: 'web' }, port: 80 })
    id = p.id
    slug = p.slug
    first = p.deploymentId
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.equal((await get(host(slug))).status, 200)
  })

  test('die Datenbank behält ihre Daten über einen erneuten Deploy', async () => {
    const redis = `dep_${slug}-cache-1`
    docker('exec', redis, 'redis-cli', 'SET', 'probe', 'bleibt')
    docker('exec', redis, 'redis-cli', 'BGREWRITEAOF')
    await sleep(1500)
    // Neue Datei mit anderer Web-Version: der Web-Dienst startet neu.
    const up2 = await upload('compose.yaml', v1.replace('v1.10.1', 'v1.11.0'))
    assert.equal((await api('PATCH', `/projects/${id}`, { source: { type: 'compose', uploadId: up2, webService: 'web' } })).status, 200)
    const d = await api('POST', `/projects/${id}/deploy`, {})
    assert.equal((await waitDeployment(d.data.deployment.id)).status, 'active')
    docker('restart', redis)
    await sleep(2000)
    assert.equal(docker('exec', redis, 'redis-cli', 'GET', 'probe'), 'bleibt')
    assert.match(docker('inspect', `dep_${slug}-web-1`, '--format', '{{.Config.Image}}'), /v1\.11\.0/)
  })

  test('Rollback fährt die vorherige Datei wieder hoch', async () => {
    const r = await api('POST', `/projects/${id}/rollback`, { deploymentId: first })
    assert.equal((await waitDeployment(r.data.deployment.id)).status, 'active')
    assert.match(docker('inspect', `dep_${slug}-web-1`, '--format', '{{.Config.Image}}'), /v1\.10\.1/)
    assert.equal((await get(host(slug))).status, 200)
  })

  test('das Artefakt enthält keine Secrets im Klartext', async () => {
    await api('PUT', `/projects/${id}/env`, { entries: [{ key: 'GEHEIM', value: 'nicht-auf-platte', isSecret: true }] })
    const d = await api('POST', `/projects/${id}/deploy`, {})
    assert.equal((await waitDeployment(d.data.deployment.id)).status, 'active')
    const found = docker('exec', 'deployer-app', 'sh', '-c', 'grep -rl nicht-auf-platte /data || true')
    assert.equal(found, '', `Secret liegt auf der Platte: ${found}`)
    const envs = docker('inspect', `dep_${slug}-web-1`, '--format', '{{json .Config.Env}}')
    assert.match(envs, /GEHEIM=nicht-auf-platte/, 'der Web-Dienst bekommt das Secret trotzdem')
  })

  const bad: [string, string, RegExp][] = [
    ['privileged', 'privileged: true', /privileged/],
    ['ports', 'ports: ["8080:80"]', /ports/],
    ['Bind-Mount', 'volumes: ["/var/run/docker.sock:/var/run/docker.sock"]', /Bind-Mount/],
    ['network_mode', 'network_mode: host', /network_mode/],
    ['cap_add', 'cap_add: [SYS_ADMIN]', /cap_add/],
  ]
  for (const [title, line, re] of bad) {
    test(`Compose mit ${title} wird schon beim Anlegen abgelehnt, mit Feldnamen`, async () => {
      const up = await upload('compose.yaml', `services:\n  web:\n    image: alpine\n    ${line}\n`)
      const r = await api('POST', '/projects', { name: `${P}bad`, source: { type: 'compose', uploadId: up, webService: 'web' }, port: 80, targets: ['lan'] })
      assert.equal(r.status, 400)
      assert.match(r.data.error.message, re)
    })
  }
})

describe('M2: Compose aus einem Repo (REVIEW)', () => {
  test('build: durch den Socket-Proxy (klassischer Builder), Einmal-Dienst bleibt beim Start beendet', async () => {
    const repo = publish('composebuild', {
      'compose.yaml': `services:
  web:
    build:
      context: .
      dockerfile: docker/web.Dockerfile
  migrate:
    image: busybox:1.36
    command: ["sh", "-c", "echo migriert"]
    restart: "no"
`,
      'docker/web.Dockerfile': 'FROM busybox:1.36\nCOPY index.html /www/index.html\nCMD ["httpd","-f","-p","8080","-h","/www"]\n',
      'index.html': '<h1>compose gebaut</h1>',
    })
    const p = await createProject({ name: `${P}cbuild`, source: { type: 'compose', repoUrl: repo.url, webService: 'web' }, port: 8080 })
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.match((await get(host(p.slug))).body, /compose gebaut/)

    const migrate = `dep_${p.slug}-migrate-1`
    const startedBefore = docker('inspect', migrate, '--format', '{{.State.StartedAt}}')
    assert.equal(docker('inspect', migrate, '--format', '{{.State.Running}}'), 'false')
    await api('POST', `/projects/${p.id}/stop`)
    await api('POST', `/projects/${p.id}/start`)
    await sleep(1500)
    assert.equal(docker('inspect', migrate, '--format', '{{.State.StartedAt}}'), startedBefore, 'Einmal-Dienst wurde erneut gestartet')
    assert.equal((await get(host(p.slug))).status, 200)
  })
})

describe('M2: statischer Build mit devDependency (REVIEW)', () => {
  test('devDependencies werden installiert (kein NODE_ENV=production beim Installieren)', async () => {
    const repo = publish('devdeps', {
      'package.json': JSON.stringify({
        name: 'devdeps', version: '1.0.0',
        scripts: { build: 'node build.js' },
        devDependencies: { 'is-number': '7.0.0' },
      }),
      'build.js': "const isNumber=require('is-number');const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>devdep '+isNumber(5)+'</h1>')",
    })
    const p = await createProject({ name: `${P}devdeps`, source: { type: 'static', repoUrl: repo.url, buildCommand: 'npm run build' } })
    const r = await waitDeployment(p.deploymentId)
    assert.equal(r.status, 'active', r.log)
    assert.match((await get(host(p.slug))).body, /devdep true/)
  })
})

describe('M2: Repo-URLs', () => {
  const cases: [string, RegExp][] = [
    ['http://socket-proxy:2375/x.git', /deployer-Stacks/],
    ['http://postgres:5432/x.git', /deployer-Stacks/],
    ['http://127.0.0.1/x.git', /gesperrte Adresse/],
    ['http://deployer-caddy/x.git', /deployer-Stacks/],
  ]
  for (const [url, re] of cases) {
    test(`abgelehnt: ${url}`, async () => {
      const r = await api('POST', '/projects', { name: `${P}url`, source: { type: 'dockerfile', repoUrl: url }, port: 80, targets: ['lan'] })
      assert.equal(r.status, 400, JSON.stringify(r.data))
      assert.match(r.data.error.message, re)
    })
  }
  test('file:// scheitert schon an der Form', async () => {
    const r = await api('POST', '/projects', { name: `${P}url`, source: { type: 'dockerfile', repoUrl: 'file:///etc' }, port: 80, targets: ['lan'] })
    assert.equal(r.status, 400)
  })
})

describe('M2: Umschalten ohne Ausfall und Image-Rollback', () => {
  test('während eines Re-Deploys antwortet die Adresse durchgehend mit 200', async () => {
    const p = await createProject({ name: `${P}zero`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80 })
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const first = p.deploymentId

    let ok = 0
    let bad = 0
    let polling = true
    const poller = (async () => {
      while (polling) {
        const r = await get(host(p.slug))
        if (r.status === 200) ok++
        else bad++
        await sleep(100)
      }
    })()
    const d = await api('POST', `/projects/${p.id}/deploy`, { ref: 'v1.11.0' })
    assert.equal((await waitDeployment(d.data.deployment.id)).status, 'active')
    await sleep(1000)
    polling = false
    await poller
    assert.equal(bad, 0, `${bad} von ${ok + bad} Anfragen ohne 200`)
    assert.ok(ok > 10)

    const rb = await api('POST', `/projects/${p.id}/rollback`, {})
    assert.equal(rb.data.deployment.rollbackOf, first)
    assert.equal((await waitDeployment(rb.data.deployment.id)).status, 'active')
    const name = docker('ps', '--filter', `label=deployer.project=${p.slug}`, '--format', '{{.Names}}').split('\n')[0]!
    // .Config.Image ist die Referenz bei der Erzeugung; docker ps zeigte nur die ID.
    const img = docker('inspect', name, '--format', '{{.Config.Image}}')
    assert.match(img, /@sha256:/, 'läuft auf dem Digest')
    const digestFirst = (await api('GET', `/deployments/${first}`)).data.deployment.version
    assert.equal(img, digestFirst)
  })
})
