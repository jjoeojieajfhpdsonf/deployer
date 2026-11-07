import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateToken, hashToken, looksLikeToken, hashesEqual, bearerFrom } from './tokens.js'

describe('API-Tokens', () => {
  test('Format: Präfix und 32 Zufallsbytes', () => {
    const t = generateToken()
    assert.match(t, /^dpl_[A-Za-z0-9_-]{43}$/)
    assert.ok(looksLikeToken(t))
    assert.notEqual(generateToken(), t, 'zufällig')
  })

  test('Hash ist SHA-256 hex und stabil', () => {
    const t = generateToken()
    assert.match(hashToken(t), /^[0-9a-f]{64}$/)
    assert.equal(hashToken(t), hashToken(t))
    assert.notEqual(hashToken(t), hashToken(generateToken()))
  })

  test('hashesEqual', () => {
    const h = hashToken('dpl_x')
    assert.ok(hashesEqual(h, h))
    assert.ok(!hashesEqual(h, hashToken('dpl_y')))
    assert.ok(!hashesEqual(h, ''))
    assert.ok(!hashesEqual('', ''))
  })

  test('falsche Formen werden nicht als Token erkannt', () => {
    assert.ok(!looksLikeToken('dpl_kurz'))
    assert.ok(!looksLikeToken('xyz_' + 'a'.repeat(43)))
    assert.ok(!looksLikeToken(''))
  })

  test('Bearer-Header', () => {
    assert.equal(bearerFrom('Bearer dpl_abc'), 'dpl_abc')
    assert.equal(bearerFrom('bearer   dpl_abc'), 'dpl_abc')
    assert.equal(bearerFrom('Basic dXNlcjpwdw=='), null)
    assert.equal(bearerFrom('Bearer'), null)
    assert.equal(bearerFrom(undefined), null)
  })
})
