import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let createNetworkAttacher: typeof import('./attach.js').createNetworkAttacher

before(async () => {
  // attach.ts zieht config.ts nach; das braucht diese beiden Variablen.
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
  process.env.ADMIN_PASSWORD ??= 'x'
  ;({ createNetworkAttacher } = await import('./attach.js'))
})

function fakeOps(opts: { failConnect?: number } = {}) {
  const log: string[] = []
  let connected = false
  let fails = opts.failConnect ?? 0
  return {
    log,
    get connected() { return connected },
    ops: {
      async connect(n: string) {
        await new Promise((r) => setTimeout(r, 5))
        if (fails > 0) { fails--; log.push(`connect-fail ${n}`); throw new Error('docker hiccup') }
        connected = true
        log.push(`connect ${n}`)
      },
      async disconnect(n: string) {
        await new Promise((r) => setTimeout(r, 5))
        connected = false
        log.push(`disconnect ${n}`)
      },
    },
  }
}

describe('withProjectNetwork (gezählt, nacheinander)', () => {
  test('zwei gleichzeitige Nutzer: einmal verbinden, einmal trennen, beide verbunden', async () => {
    const f = fakeOps()
    const a = createNetworkAttacher(f.ops)
    const seen: boolean[] = []
    await Promise.all([
      a.with('dep_x', async () => { await new Promise((r) => setTimeout(r, 20)); seen.push(f.connected) }),
      a.with('dep_x', async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(f.connected) }),
    ])
    assert.deepEqual(seen, [true, true])
    assert.deepEqual(f.log, ['connect dep_x', 'disconnect dep_x'])
    assert.equal(a.users('dep_x'), 0)
  })

  test('scheitert das Verbinden, bleibt der Zähler bei 0 und der nächste Aufruf verbindet neu', async () => {
    const f = fakeOps({ failConnect: 1 })
    const a = createNetworkAttacher(f.ops)
    await assert.rejects(a.with('dep_y', async () => 'nie'), /hiccup/)
    assert.equal(a.users('dep_y'), 0)
    let during = false
    await a.with('dep_y', async () => { during = f.connected })
    assert.equal(during, true)
    assert.deepEqual(f.log, ['connect-fail dep_y', 'connect dep_y', 'disconnect dep_y'])
  })

  test('ein Nutzer kommt während des Trennens: er wartet und verbindet neu', async () => {
    const f = fakeOps()
    const a = createNetworkAttacher(f.ops)
    await a.with('dep_z', async () => {})
    const p = a.with('dep_z', async () => f.connected)
    assert.equal(await p, true)
    assert.deepEqual(f.log, ['connect dep_z', 'disconnect dep_z', 'connect dep_z', 'disconnect dep_z'])
  })

  test('Fehler in fn trennt trotzdem', async () => {
    const f = fakeOps()
    const a = createNetworkAttacher(f.ops)
    await assert.rejects(a.with('dep_e', async () => { throw new Error('fn kaputt') }), /fn kaputt/)
    assert.equal(f.connected, false)
    assert.equal(a.users('dep_e'), 0)
  })
})
