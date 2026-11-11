import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { KONAMI, containsKonami, konamiDone, konamiStep, versionClick, VERSION_CLICKS } from './easter-egg.js'

const U = 'ArrowUp', D = 'ArrowDown', L = 'ArrowLeft', R = 'ArrowRight'

describe('Konami-Code', () => {
  test('die Folge ↑↑↓↓←→←→ B A wird erkannt', () => {
    assert.equal(containsKonami([...KONAMI]), true)
  })

  test('Gross-B und Gross-A zählen (Umschalt, Feststelltaste)', () => {
    assert.equal(containsKonami([U, U, D, D, L, R, L, R, 'B', 'A']), true)
  })

  test('mitten in anderen Tasten', () => {
    assert.equal(containsKonami(['x', 'Enter', U, U, D, D, L, R, L, R, 'b', 'a', 'q']), true)
  })

  test('ein ↑ zu viel am Anfang schadet nicht', () => {
    assert.equal(containsKonami([U, U, U, D, D, L, R, L, R, 'b', 'a']), true)
  })

  test('falsche Taste dazwischen setzt zurück', () => {
    assert.equal(containsKonami([U, U, D, D, L, 'x', R, L, R, 'b', 'a']), false)
    assert.equal(containsKonami([U, U, D, D, L, R, L, R, 'a', 'b']), false)
  })

  test('unvollständig ist nicht erkannt', () => {
    assert.equal(containsKonami(KONAMI.slice(0, -1)), false)
    assert.equal(containsKonami([]), false)
  })

  test('Schritt für Schritt: Stand zählt hoch und fällt bei Fehlern zurück', () => {
    assert.equal(konamiStep(0, U), 1)
    assert.equal(konamiStep(1, U), 2)
    assert.equal(konamiStep(2, U), 2) // ↑↑↑: die letzten zwei sind wieder ein Anfang
    assert.equal(konamiStep(4, 'x'), 0)
    assert.equal(konamiStep(5, U), 1) // ↑ nach Fehler ist ein neuer Anfang
    assert.equal(konamiDone(konamiStep(9, 'a')), true)
  })
})

describe('7 Klicks auf die Version', () => {
  const run = (times: number[]) => times.reduce((s, t) => versionClick(s, t), { count: 0, last: -Infinity }).count

  test('sieben schnelle Klicks erreichen die Schwelle', () => {
    assert.equal(run([0, 300, 600, 900, 1200, 1500, 1800]), VERSION_CLICKS)
  })

  test('eine Pause über 1.5 s beginnt von vorn', () => {
    assert.equal(run([0, 300, 600, 3000, 3300]), 2)
  })
})
