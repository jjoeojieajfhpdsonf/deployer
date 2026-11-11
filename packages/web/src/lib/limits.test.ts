import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumber, serverFreeMb, suggestCpuLimit, suggestMemoryLimit, usageOf } from './limits.js'

describe('«Grenze erhöhen»: RAM', () => {
  test('verdoppelt, wenn genug frei ist', () => {
    assert.deepEqual(suggestMemoryLimit({ currentMb: 512, serverFreeMb: 21_000 }), { value: 1024, capped: null, raised: true })
    assert.deepEqual(suggestMemoryLimit({ currentMb: 64, serverFreeMb: null }), { value: 128, capped: null, raised: true })
  })

  test('auf 64-MB-Stufen gerundet (nach oben beim Wunsch)', () => {
    assert.equal(suggestMemoryLimit({ currentMb: 100 }).value, 256)
    assert.equal(suggestMemoryLimit({ currentMb: 300 }).value, 640)
  })

  test('gedeckelt durch freien RAM plus den Verbrauch des Containers, auf 64 MB abgerundet', () => {
    // 300 MB frei, der Container belegt selbst 450 MB: höchstens 750 → 704
    assert.deepEqual(suggestMemoryLimit({ currentMb: 512, serverFreeMb: 300, containerUsedMb: 450 }), { value: 704, capped: 'server', raised: true })
    // Container läuft nicht (kein Verbrauch): nur der freie RAM zählt
    assert.deepEqual(suggestMemoryLimit({ currentMb: 512, serverFreeMb: 800 }), { value: 768, capped: 'server', raised: true })
  })

  test('nie unter dem aktuellen Wert: ohne freien RAM bleibt es dabei', () => {
    assert.deepEqual(suggestMemoryLimit({ currentMb: 512, serverFreeMb: 100 }), { value: 512, capped: 'server', raised: false })
    assert.deepEqual(suggestMemoryLimit({ currentMb: 512, serverFreeMb: 0, containerUsedMb: 0 }), { value: 512, capped: 'server', raised: false })
  })

  test('höchstens 32 768 MB (Grenze der API)', () => {
    assert.deepEqual(suggestMemoryLimit({ currentMb: 20_000, serverFreeMb: 100_000 }), { value: 32_768, capped: 'max', raised: true })
    assert.deepEqual(suggestMemoryLimit({ currentMb: 32_768 }), { value: 32_768, capped: 'max', raised: false })
  })
})

describe('«Grenze erhöhen»: CPU', () => {
  test('verdoppelt, ohne Kernzahl höchstens 16', () => {
    assert.deepEqual(suggestCpuLimit({ current: 1 }), { value: 2, capped: null, raised: true })
    assert.deepEqual(suggestCpuLimit({ current: 0.25 }), { value: 0.5, capped: null, raised: true })
    assert.deepEqual(suggestCpuLimit({ current: 12 }), { value: 16, capped: 'max', raised: true })
    assert.deepEqual(suggestCpuLimit({ current: 16 }), { value: 16, capped: 'max', raised: false })
  })

  test('gedeckelt durch die Kerne des Servers', () => {
    assert.deepEqual(suggestCpuLimit({ current: 3, serverCores: 4 }), { value: 4, capped: 'server', raised: true })
    assert.deepEqual(suggestCpuLimit({ current: 4, serverCores: 4 }), { value: 4, capped: 'server', raised: false })
    assert.deepEqual(suggestCpuLimit({ current: 1, serverCores: 8 }), { value: 2, capped: null, raised: true })
  })
})

describe('Hilfen', () => {
  test('freier RAM aus dem Systemstatus', () => {
    assert.equal(serverFreeMb({ memUsedBytes: 1024 ** 3, memTotalBytes: 3 * 1024 ** 3 }), 2048)
    assert.equal(serverFreeMb({ memUsedBytes: null, memTotalBytes: 3 * 1024 ** 3 }), null)
    assert.equal(serverFreeMb(null), null)
  })

  test('Verbrauch: letzter Wert und Spitze', () => {
    assert.deepEqual(usageOf([{ m: 300 }, { m: 480 }, { m: 410 }], (s) => s.m), { now: 410, peak: 480 })
    assert.equal(usageOf([], (s: { m: number }) => s.m), null)
  })

  test('Zahlen wie getippt', () => {
    assert.equal(parseNumber('1024'), 1024)
    assert.equal(parseNumber('1’024'), 1024)
    assert.equal(parseNumber(' 0,5 '), 0.5)
    assert.equal(parseNumber('1.5'), 1.5)
    assert.ok(Number.isNaN(parseNumber('')))
    assert.ok(Number.isNaN(parseNumber('viel')))
    assert.ok(Number.isNaN(parseNumber('1,2,3')))
  })
})
