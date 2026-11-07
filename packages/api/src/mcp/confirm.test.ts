import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { issueConfirmation, consumeConfirmation, paramsHash, CONFIRM_TTL_MS } from './confirm.js'

describe('Bestätigungs-Tokens', () => {
  const p = { project: 'shop' }

  test('mit denselben Parametern einmal gültig', () => {
    const t = issueConfirmation('tok1', 'delete_project', p)
    assert.match(t, /^cfm_/)
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', { ...p, confirmation_token: t }), 'ok')
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', p), 'unknown', 'nur einmal')
  })

  test('nicht für ein anderes Projekt', () => {
    const t = issueConfirmation('tok1', 'delete_project', p)
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', { project: 'blog' }), 'mismatch')
    // Der Fehlversuch verbraucht es nicht.
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', p), 'ok')
  })

  test('nicht für ein anderes Werkzeug', () => {
    const t = issueConfirmation('tok1', 'rollback', p)
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', p), 'mismatch')
  })

  test('nicht für ein anderes API-Token', () => {
    const t = issueConfirmation('tok1', 'delete_project', p)
    assert.equal(consumeConfirmation(t, 'tok2', 'delete_project', p), 'mismatch')
  })

  test('nach 5 Minuten abgelaufen', () => {
    const now = 1_000_000
    const t = issueConfirmation('tok1', 'delete_project', p, now)
    assert.equal(consumeConfirmation(t, 'tok1', 'delete_project', p, now + CONFIRM_TTL_MS + 1), 'expired')
  })

  test('unbekanntes Token', () => {
    assert.equal(consumeConfirmation('cfm_gibtsnicht', 'tok1', 'delete_project', p), 'unknown')
  })

  test('Parameter-Hash ist unabhängig von Reihenfolge und vom Bestätigungsfeld', () => {
    assert.equal(paramsHash({ a: 1, b: { y: 2, x: 1 } }), paramsHash({ b: { x: 1, y: 2 }, a: 1, confirmation_token: 'x' }))
    assert.notEqual(paramsHash({ a: 1 }), paramsHash({ a: 2 }))
  })
})
