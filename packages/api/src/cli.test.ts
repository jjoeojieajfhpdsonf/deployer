import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, accountNames } from './cli.js'
import { AuthService } from './auth/service.js'
import { MemoryAuthStore } from './auth/store.js'
import type { AuditInput } from './domain/audit.js'

/**
 * Notausgang: `docker exec airlock-app node dist/cli.js reset-2fa admin`.
 * Geprüft: die Befehle, das Ergebnis im Speicher und im Audit, und dass
 * dist/cli.js im Image an der dokumentierten Stelle liegt.
 */

const here = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(here, '..')
const repo = resolve(apiRoot, '../..')

function setup() {
  const store = new MemoryAuthStore('h:pw')
  const audits: AuditInput[] = []
  const service = new AuthService({
    store, key: () => randomBytes(32), audit: async (e) => { audits.push(e) },
    verifyPassword: (p, h) => h === `h:${p}`, dummyHash: 'h:\0', sleep: async () => {},
  })
  const out: string[] = []
  const err: string[] = []
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  return { store, audits, service, out, err, io, deps: { service: async () => service, adminName: 'Joël' } }
}

describe('Notausgang-CLI', () => {
  test('reset-2fa entfernt Passkeys, TOTP und Codes, meldet alle ab, Audit', async () => {
    const t = setup()
    await t.store.addPasskey({ credentialId: 'abc', publicKey: new Uint8Array([1]), counter: 0, transports: [], deviceType: null, backedUp: null, name: 'MacBook', rpId: 'x', createdAt: new Date(), lastUsedAt: null })
    await t.store.activateTotp(Buffer.from('x'), new Date(), 1)
    await t.store.replaceRecoveryCodes(['a', 'b'], new Date())
    await t.store.setRequired(true)
    await t.store.createSession({ tokenHash: 'h', createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 1e6), ip: null, userAgent: null, method: 'passkey', sudoUntil: null, revokedAt: null })

    assert.equal(await runCli(['reset-2fa', 'admin'], t.io, t.deps), 0)
    assert.equal((await t.store.listPasskeys()).length, 0)
    assert.equal((await t.store.getTotp()).enabledAt, null)
    assert.equal((await t.store.recoveryStatus()).total, 0)
    assert.equal(await t.store.getRequired(), null)
    assert.equal((await t.store.listSessions()).length, 0)
    assert.match(t.out.join('\n'), /Passkeys entfernt:\s+1/)
    assert.match(t.out.join('\n'), /Sitzungen abgemeldet:\s+1/)
    assert.deepEqual(t.audits.map((a) => [a.actor, a.action]), [['cli:admin', 'auth.2fa.reset']])
  })

  test('Anzeigename mit Akzent geht auch ohne («Joël» = joel); Fremde nicht', async () => {
    assert.deepEqual(accountNames('Joël'), ['admin', 'joel'])
    assert.ok(accountNames('Maria Muster').includes('maria muster'))
    const t = setup()
    assert.equal(await runCli(['reset-2fa', 'JOEL'], t.io, t.deps), 0)
    assert.equal(await runCli(['reset-2fa', 'mallory'], t.io, t.deps), 2)
    assert.match(t.err.join('\n'), /Unbekannter Benutzer «mallory»/)
  })

  test('ohne Befehl, unbekannter Befehl, fehlender Benutzer: Hilfe und Code 2', async () => {
    const t = setup()
    assert.equal(await runCli([], t.io, t.deps), 2)
    assert.equal(await runCli(['help'], t.io, t.deps), 0)
    assert.equal(await runCli(['loeschen'], t.io, t.deps), 2)
    assert.equal(await runCli(['reset-2fa'], t.io, t.deps), 2)
    assert.equal(t.audits.length, 0, 'ohne gültigen Aufruf passiert nichts')
  })

  test('direkt aufgerufen, auch über einen Verweis dist → … (wie im Image): Hilfe ohne Datenbank', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'airlock-cli-'))
    try {
      symlinkSync(here, join(tmp, 'dist'))
      const env = { ...process.env, DATABASE_URL: '', ADMIN_PASSWORD: '' }
      const text = execFileSync(process.execPath, ['--import', 'tsx', join(tmp, 'dist', 'cli.ts'), 'help'], { cwd: apiRoot, env, encoding: 'utf8' })
      assert.match(text, /reset-2fa <benutzer>/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('Image: API-Build liegt unter packages/api/dist, /app/dist zeigt darauf', () => {
    const df = readFileSync(join(repo, 'Dockerfile'), 'utf8')
    assert.match(df, /^WORKDIR \/app$/m)
    assert.match(df, /COPY --from=build \/app\/packages\/api\/dist \.\/packages\/api\/dist/)
    assert.match(df, /ln -s packages\/api\/dist \/app\/dist && test -f \/app\/dist\/cli\.js/)
    const ts = JSON.parse(readFileSync(join(apiRoot, 'tsconfig.json'), 'utf8')) as { compilerOptions: { rootDir: string; outDir: string } }
    assert.equal(ts.compilerOptions.rootDir, 'src')
    assert.equal(ts.compilerOptions.outDir, 'dist')
    // Container-Name aus compose.yaml (dokumentierter Befehl)
    assert.match(readFileSync(join(repo, 'compose.yaml'), 'utf8'), /container_name: airlock-app/)
  })
})
