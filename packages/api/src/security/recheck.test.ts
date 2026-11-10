import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkHeaders } from './headers.js'
import { fingerprint, dedupe } from './score.js'

/** Nachscan der Stufe «headers» (M8): was sich im letzten Scan ändert. */
describe('Nachscan der Header', () => {
  const load = async () => {
    process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
    process.env.ADMIN_PASSWORD ??= 'x'
    return (await import('./scan.js')).planHeaderRecheck
  }
  const find = (headers: Record<string, string>) =>
    dedupe(checkHeaders({ url: 'https://solar.int.example.ch/', status: 200, headers, body: '', isHttps: true })).map((f) => ({ ...f, fingerprint: fingerprint(f) }))

  test('gesetzte Header: Befunde behoben, nichts Neues', async () => {
    const plan = await load()
    const before = find({}).map((f, i) => ({ id: `f${i}`, fingerprint: f.fingerprint, status: 'open' as const, title: f.title }))
    const after = find({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' })
    const p = plan(before, after, new Map())
    const fixed = before.filter((b) => p.fix.includes(b.id)).map((b) => b.title).sort()
    assert.deepEqual(fixed, ['Referrer-Policy fehlt', 'X-Content-Type-Options: nosniff fehlt'])
    assert.deepEqual(p.insert, [])
    assert.deepEqual(p.reopen, [])
  })

  test('Fingerabdruck hängt nicht am Host: Container-Adresse und Caddy-Name ergeben denselben Befund', () => {
    const viaContainer = checkHeaders({ url: 'http://dep_solar_ab12:3000/', status: 200, headers: {}, body: '', isHttps: false })
    const viaCaddy = checkHeaders({ url: 'http://solar.int.example.ch/', status: 200, headers: {}, body: '', isHttps: false })
    assert.deepEqual(viaContainer.map(fingerprint), viaCaddy.map(fingerprint))
  })

  test('Regel entfernt: behobener Befund wird wieder offen bzw. bleibt akzeptiert', async () => {
    const plan = await load()
    const all = find({})
    const xcto = all.find((f) => f.title.startsWith('X-Content'))!
    const ref = all.find((f) => f.title.startsWith('Referrer'))!
    const existing = [
      { id: 'a', fingerprint: xcto.fingerprint, status: 'fixed' as const },
      { id: 'b', fingerprint: ref.fingerprint, status: 'fixed' as const },
    ]
    const p = plan(existing, [xcto, ref], new Map([[ref.fingerprint, 'nur intern']]))
    assert.deepEqual(p.reopen, [
      { id: 'a', status: 'open', acceptReason: null },
      { id: 'b', status: 'accepted', acceptReason: 'nur intern' },
    ])
    assert.deepEqual(p.fix, [])
  })

  test('neuer Befund (App hat einen Header verloren) wird eingefügt', async () => {
    const plan = await load()
    const now = find({ 'referrer-policy': 'no-referrer' })
    const p = plan([], now, new Map())
    assert.equal(p.insert.length, now.length)
    assert.ok(p.insert.every((f) => f.status === 'open'))
  })
})
