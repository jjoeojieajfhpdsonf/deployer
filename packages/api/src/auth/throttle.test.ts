import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LoginThrottle, DEFAULT_THROTTLE, minutesOf } from './throttle.js'

const MIN = 60_000

describe('Sperre nach Fehlversuchen', () => {
  test('5 Fehlversuche → 15 Min. gesperrt, danach wieder frei', () => {
    let now = 0
    const t = new LoginThrottle(() => now)
    for (let i = 1; i <= 4; i++) {
      assert.equal(t.fail('ip:1').lockedMs, null)
      assert.equal(t.check('ip:1').locked, false)
    }
    assert.equal(t.fail('ip:1').lockedMs, 15 * MIN)
    const c = t.check('ip:1')
    assert.ok(c.locked && c.retryAfterMs === 15 * MIN)
    now += 15 * MIN - 1
    assert.equal(t.check('ip:1').locked, true)
    now += 1
    assert.equal(t.check('ip:1').locked, false)
  })

  test('exponentiell: 15, 30, 60 Min. … höchstens 24 h', () => {
    let now = 0
    const t = new LoginThrottle(() => now)
    const locks: number[] = []
    for (let round = 0; round < 9; round++) {
      let r = { lockedMs: null as number | null }
      for (let i = 0; i < 5; i++) r = t.fail('user:admin')
      locks.push(r.lockedMs!)
      now += r.lockedMs!
    }
    assert.deepEqual(locks.slice(0, 4), [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN])
    assert.equal(Math.max(...locks), DEFAULT_THROTTLE.maxLockMs)
  })

  test('Erfolg setzt zurück; Schlüssel sind unabhängig', () => {
    let now = 0
    const t = new LoginThrottle(() => now)
    for (let i = 0; i < 4; i++) t.fail('ip:a')
    t.succeed('ip:a')
    assert.equal(t.fail('ip:a').failures, 1)
    for (let i = 0; i < 5; i++) t.fail('ip:b')
    assert.equal(t.check('ip:b').locked, true)
    assert.equal(t.check('ip:a').locked, false)
    const all = t.checkAll(['ip:a', 'ip:b'])
    assert.equal(all.locked, true)
  })

  test('nach 24 h ohne Fehlversuch beginnt die Stufe von vorn', () => {
    let now = 0
    const t = new LoginThrottle(() => now)
    for (let i = 0; i < 5; i++) t.fail('ip:x')
    now += 15 * MIN + DEFAULT_THROTTLE.resetAfterMs + 1
    let r = { lockedMs: null as number | null }
    for (let i = 0; i < 5; i++) r = t.fail('ip:x')
    assert.equal(r.lockedMs, 15 * MIN)
  })

  test('begrenzter Speicher: alte Einträge ohne Sperre fallen weg', () => {
    const t = new LoginThrottle(() => 0, { ...DEFAULT_THROTTLE, maxKeys: 3 })
    for (let i = 0; i < 10; i++) t.fail(`ip:${i}`)
    // Kein Absturz, neue Schlüssel werden weiter gezählt
    assert.equal(t.fail('ip:neu').failures, 1)
  })

  test('Minuten für Meldungen: aufgerundet, mindestens 1', () => {
    assert.equal(minutesOf(1), 1)
    assert.equal(minutesOf(15 * MIN), 15)
    assert.equal(minutesOf(15 * MIN + 1), 16)
  })
})
