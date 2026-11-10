import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

/** Auto-Deploy nach Merge (M8, Etappe 3): Entscheidung und Kommentar. */
describe('Auto-Deploy', () => {
  const load = async () => {
    process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
    process.env.ADMIN_PASSWORD ??= 'x'
    return import('./auto-deploy.js')
  }
  const head = 'a'.repeat(40)

  test('neuer Commit: deployen; gleich, läuft schon, festgelegt oder ohne Fassung: nicht', async () => {
    const { autoDeployDecision: d } = await load()
    assert.equal(d({ head, activeVersion: 'b'.repeat(40), busy: false, pinnedCommit: false }).deploy, true)
    assert.equal(d({ head, activeVersion: head, busy: false, pinnedCommit: false }).deploy, false)
    assert.equal(d({ head, activeVersion: 'b'.repeat(40), busy: true, pinnedCommit: false }).deploy, false)
    assert.equal(d({ head, activeVersion: 'b'.repeat(40), busy: false, pinnedCommit: true }).deploy, false)
    assert.equal(d({ head, activeVersion: null, busy: false, pinnedCommit: false }).deploy, false)
  })

  test('Kommentar am Pull Request nennt Befund, Note und Bericht', async () => {
    const { prComment } = await load()
    const c = prComment({ title: 'Container läuft als root', verified: true, score: 92, grade: 'A', scanUrl: 'https://deployer.int.example.ch/projekte/x?tab=security' })
    assert.match(c, /behoben/)
    assert.match(c, /Note jetzt A \(92 \/ 100\)/)
    assert.match(c, /tab=security/)
  })
})
