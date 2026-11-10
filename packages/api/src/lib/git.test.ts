import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, lstatSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cloneRepo } from './git.js'
import { startGitHttpServer, nonLoopbackIPv4, makeRepo, type GitHttpServer } from './git-http-fixture.js'
import type { RepoUrlPolicy } from './repo-url.js'

// Loopback ist für Clones fest gesperrt; der Test braucht deshalb eine
// echte Schnittstelle dieses Rechners.
const ip = nonLoopbackIPv4()

let work: string
let srv: GitHttpServer
let commit: string
const allowAll: RepoUrlPolicy = { deniedHosts: [], deniedCidrs: [], resolve: async () => [] }

before(async () => {
  if (!ip) return
  work = mkdtempSync(join(tmpdir(), 'airlock-git-'))
  const src = join(work, 'src')
  commit = makeRepo(
    src,
    { 'Dockerfile': 'FROM alpine\n', 'app/index.html': '<h1>hallo</h1>', '.env.prod': 'A=1\n' },
    { 'geheim.env': '/proc/self/environ' },
  )
  const served = join(work, 'served')
  execFileSync('mkdir', ['-p', served])
  execFileSync('git', ['clone', '-q', '--bare', src, join(served, 'app.git')])
  srv = await startGitHttpServer(served, '0.0.0.0')
})

after(async () => {
  if (!ip) return
  await srv.close()
  rmSync(work, { recursive: true, force: true })
})

describe('cloneRepo', { skip: ip ? false : 'keine Netzschnittstelle ausser Loopback' }, () => {
  test('klont einen Branch und liefert den Commit-Hash', async () => {
    const dest = join(work, 'c1')
    const r = await cloneRepo({ url: `http://${ip}:${srv.port}/app.git`, ref: 'main', dest, policy: allowAll })
    assert.equal(r.commit, commit)
    assert.equal(readFileSync(join(dest, 'app/index.html'), 'utf8'), '<h1>hallo</h1>')
  })

  test('klont einen vollen Commit-Hash', async () => {
    const dest = join(work, 'c2')
    const r = await cloneRepo({ url: `http://${ip}:${srv.port}/app.git`, ref: commit, dest, policy: allowAll })
    assert.equal(r.commit, commit)
  })

  test('Symlinks im Repo kommen als einfache Textdatei an', async () => {
    const dest = join(work, 'c3')
    await cloneRepo({ url: `http://${ip}:${srv.port}/app.git`, dest, policy: allowAll })
    const st = lstatSync(join(dest, 'geheim.env'))
    assert.equal(st.isSymbolicLink(), false, 'darf kein Symlink sein')
    assert.equal(readFileSync(join(dest, 'geheim.env'), 'utf8'), '/proc/self/environ')
  })

  test('unbekannter Branch scheitert mit verständlicher Meldung', async () => {
    await assert.rejects(
      cloneRepo({ url: `http://${ip}:${srv.port}/app.git`, ref: 'gibts-nicht', dest: join(work, 'c4'), policy: allowAll }),
      /git ist fehlgeschlagen/,
    )
  })

  test('die URL-Prüfung greift vor dem Clone', async () => {
    const dest = join(work, 'c5')
    await assert.rejects(
      cloneRepo({ url: `file://${work}/served/app.git`, dest, policy: allowAll }),
      /Schema/,
    )
    assert.equal(existsSync(join(dest, 'Dockerfile')), false)
  })

  test('Zeitlimit bricht ab', async () => {
    // Ein Port, an dem nichts antwortet, ausser einem nie antwortenden Server.
    const { createServer } = await import('node:net')
    const hang = createServer(() => {}).listen(0, '0.0.0.0')
    await new Promise((r) => hang.once('listening', r))
    const port = (hang.address() as { port: number }).port
    await assert.rejects(
      cloneRepo({ url: `http://${ip}:${port}/x.git`, dest: join(work, 'c6'), policy: allowAll, timeoutMs: 1500 }),
      /abgebrochen/,
    )
    hang.close()
  })
})
