import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { NORMAL, nextWin, type Win, type WinAction } from './win95-windows.js'

const run = (...acts: WinAction[]): Win => acts.reduce(nextWin, NORMAL)

describe('Windows 95: Fensterzustände', () => {
  test('_ minimiert, Taskleiste holt zurück', () => {
    assert.equal(run('min').state, 'min')
    assert.equal(run('min', 'taskbar').state, 'normal')
  })

  test('□ maximiert, im maximierten Fenster stellt derselbe Knopf wieder her', () => {
    assert.equal(run('max').state, 'max')
    assert.equal(run('max', 'max').state, 'normal')
  })

  test('maximiert minimieren und zurückholen: wieder maximiert', () => {
    assert.equal(run('max', 'min', 'taskbar').state, 'max')
    // Zweimal minimieren vergisst «maximiert» nicht
    assert.equal(run('max', 'min', 'min', 'taskbar').state, 'max')
  })

  test('Taskleisten-Knopf eines offenen Fensters minimiert es', () => {
    assert.equal(run('taskbar').state, 'min')
    assert.deepEqual(run('max', 'taskbar'), { state: 'min', wasMax: true })
  })

  test('Doppelklick auf die Titelleiste wechselt maximiert ↔ normal', () => {
    assert.equal(run('titlebar').state, 'max')
    assert.equal(run('titlebar', 'titlebar').state, 'normal')
  })

  test('✕ schliesst; nur «wieder öffnen» bringt es zurück', () => {
    assert.equal(run('close').state, 'closed')
    assert.equal(run('close', 'taskbar').state, 'closed')
    assert.equal(run('close', 'max').state, 'closed')
    assert.equal(run('close', 'min').state, 'closed')
    assert.deepEqual(run('max', 'close', 'restore'), NORMAL)
  })

  test('minimiert lässt sich nicht maximieren (Knöpfe sind nicht sichtbar)', () => {
    assert.equal(run('min', 'max').state, 'min')
    assert.equal(run('min', 'titlebar').state, 'min')
  })
})
