import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cloneRepo, lsRemote, lsRemoteHead, scrub, sshCommand, type GitAuth } from './git.js'
import { startGitHttpServer, nonLoopbackIPv4, makeRepo, type GitHttpServer } from './git-http-fixture.js'
import type { RepoUrlPolicy } from './repo-url.js'

// workdir.ts liest die Konfiguration; ohne Datenbank genügen Platzhalter (wie workdir.test.ts)
process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { packDir } = await import('../deploy/workdir.js')

/**
 * Nacht 3, Etappe 2 – Pflichttest aus dem Auftrag: privates Repo über einen
 * lokalen Git-Server mit Basic-Auth (wie GitHub mit Installations-Token bzw.
 * GitLab mit Zugangstoken). Danach wird ALLES durchsucht, was nach aussen
 * gehen könnte – Log-Zeilen, Fehlermeldungen, der geklonte Ordner samt
 * .git (Artefakt, .git/config) und der Build-Kontext (Tar) – nach dem Token
 * und nach der Basic-Kopfzeile, in der es steckt.
 *
 * Das Token wird zur Laufzeit erzeugt (kein Geheimnis im Repo).
 */

const ip = nonLoopbackIPv4()
const allowAll: RepoUrlPolicy = { deniedHosts: [], deniedCidrs: [], resolve: async () => [] }
const token = `ghs_${randomBytes(27).toString('base64url')}`
const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
const auth: GitAuth = { kind: 'https', username: 'x-access-token', token }

let work: string
let srv: GitHttpServer
let commit: string
const seenAuth: string[] = []

/** Alle Dateien unter dir (auch .git), als Buffer */
function allFiles(dir: string): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...allFiles(p))
    else out.push({ path: p, data: readFileSync(p) })
  }
  return out
}

function assertClean(what: string, text: string | Buffer) {
  const s = Buffer.isBuffer(text) ? text : Buffer.from(text)
  assert.equal(s.includes(token), false, `${what} enthält das Token`)
  assert.equal(s.includes(basic), false, `${what} enthält die Basic-Kopfzeile`)
}

before(async () => {
  if (!ip) return
  work = mkdtempSync(join(tmpdir(), 'airlock-git-privat-'))
  const src = join(work, 'src')
  commit = makeRepo(src, { 'Dockerfile': 'FROM alpine\n', 'index.html': '<h1>privat</h1>' })
  const served = join(work, 'served')
  execFileSync('mkdir', ['-p', served])
  execFileSync('git', ['clone', '-q', '--bare', src, join(served, 'privat.git')])
  srv = await startGitHttpServer(served, '0.0.0.0', 0, { auth: { token }, seenAuth })
})

after(async () => {
  if (!ip) return
  await srv.close()
  rmSync(work, { recursive: true, force: true })
})

describe('Privates Repo mit Token: nichts davon nach aussen', { skip: ip ? false : 'keine Netzschnittstelle ausser Loopback' }, () => {
  const url = () => `http://${ip}:${srv.port}/privat.git`

  test('ohne Token: 401, der Clone scheitert', async () => {
    await assert.rejects(cloneRepo({ url: url(), dest: join(work, 'ohne'), policy: allowAll }), /git ist fehlgeschlagen/)
  })

  test('mit Token: Clone gelingt; Log, Ordner (.git/config), Build-Kontext ohne Token', async () => {
    const lines: string[] = []
    const dest = join(work, 'mit')
    const r = await cloneRepo({ url: url(), ref: 'main', dest, policy: allowAll, auth, onLine: (l) => lines.push(l) })
    assert.equal(r.commit, commit)
    // Der Server hat das Token wirklich bekommen (sonst prüfte der Test nichts)
    assert.ok(seenAuth.includes(`Basic ${basic}`))

    assertClean('Log-Zeilen', lines.join('\n'))
    assertClean('Anzeige-URL', r.displayUrl)
    for (const f of allFiles(dest)) assertClean(f.path, f.data)
    // origin ist weg: keine Adresse, keine Fetch-Regel im Artefakt
    const cfg = readFileSync(join(dest, '.git', 'config'), 'utf8')
    assert.doesNotMatch(cfg, /\[remote "origin"\]/)
    assert.doesNotMatch(cfg, /extraheader|Authorization/i)

    // Build-Kontext (wie docker build ihn bekommt)
    const chunks: Buffer[] = []
    for await (const c of await packDir(dest, { dockerignore: true })) chunks.push(Buffer.from(c as Buffer))
    assertClean('Build-Kontext', Buffer.concat(chunks))
  })

  test('mit Token auf einen Commit: auch der Weg über fetch hinterlässt nichts', async () => {
    const dest = join(work, 'commit')
    const lines: string[] = []
    await cloneRepo({ url: url(), ref: commit, dest, policy: allowAll, auth, onLine: (l) => lines.push(l) })
    assertClean('Log-Zeilen', lines.join('\n'))
    for (const f of allFiles(dest)) assertClean(f.path, f.data)
    assert.equal(existsSync(join(dest, 'index.html')), true)
  })

  test('falsches Token: Fehlermeldung nennt es nicht', async () => {
    const wrong = `ghs_${randomBytes(27).toString('base64url')}`
    const lines: string[] = []
    await assert.rejects(
      cloneRepo({ url: url(), dest: join(work, 'falsch'), policy: allowAll, auth: { kind: 'https', username: 'x-access-token', token: wrong }, onLine: (l) => lines.push(l) }),
      (err: Error) => {
        assert.equal(err.message.includes(wrong), false)
        assert.equal(err.message.includes(Buffer.from(`x-access-token:${wrong}`).toString('base64')), false)
        return true
      },
    )
    assert.equal(lines.join('\n').includes(wrong), false)
  })

  test('ls-remote mit Token (Auto-Deploy, «Repo erreichbar?»)', async () => {
    const refs = await lsRemote({ url: url(), patterns: ['HEAD', 'refs/heads/main'], policy: allowAll, auth })
    assert.equal(refs.get('refs/heads/main'), commit)
    assert.equal(await lsRemoteHead({ url: url(), ref: 'main', policy: allowAll, auth }), commit)
    await assert.rejects(lsRemoteHead({ url: url(), ref: 'main', policy: allowAll }), /git ist fehlgeschlagen/)
  })

  test('Token nie über SSH, Deploy-Key nie über https', async () => {
    await assert.rejects(
      cloneRepo({ url: url(), dest: join(work, 'x1'), policy: allowAll, auth: { kind: 'ssh', privateKey: 'x', knownHosts: '' } }),
      /SSH-Adresse/,
    )
  })
})

describe('Hilfen', () => {
  test('scrub entfernt bekannte Geheimnisse, längste zuerst', () => {
    assert.equal(scrub(`fatal: Basic ${basic} und ${token}`, [token, basic]), 'fatal: Basic *** und ***')
    assert.equal(scrub('nichts', [token]), 'nichts')
  })

  test('ssh-Aufruf: nur bestätigte Server, keine Agenten, alles in Anführungszeichen', () => {
    const cmd = sshCommand({ keyFile: '/tmp/a b/id', knownHostsFile: '/tmp/a b/known_hosts', alias: '[gitea.lan]:2222', address: '192.168.1.20' })
    assert.match(cmd, /StrictHostKeyChecking='yes'/)
    assert.doesNotMatch(cmd, /StrictHostKeyChecking='?(no|accept-new)/)
    assert.match(cmd, /GlobalKnownHostsFile='\/dev\/null'/)
    assert.match(cmd, /HostKeyAlias='\[gitea\.lan\]:2222'/)
    assert.match(cmd, /HostName='192\.168\.1\.20'/)
    assert.match(cmd, /IdentityAgent='none'/)
    assert.match(cmd, /-i '\/tmp\/a b\/id'/)
    assert.match(cmd, /^ssh -F \/dev\/null /)
  })
})
