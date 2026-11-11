import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inEnvironment, sessionScope, serverJob, allows, assertAllowed, scopeEnvId } from './scope.js'
import { AppError } from './errors.js'

test('allows: ein Token sieht nur seine Umgebung', () => {
  assert.equal(allows(inEnvironment('a'), 'a'), true)
  assert.equal(allows(inEnvironment('a'), 'b'), false)
  assert.equal(allows(inEnvironment('a'), null), false)
  assert.equal(allows(inEnvironment('a'), undefined), false)
})

test('allows: Anmeldung und Server-Jobs sehen alle Umgebungen', () => {
  assert.equal(allows(sessionScope(), 'b'), true)
  assert.equal(allows(serverJob('auto-deploy'), 'b'), true)
})

test('assertAllowed: fremde Umgebung ergibt dieselbe 404 wie ein unbekanntes Objekt', () => {
  assert.doesNotThrow(() => assertAllowed(inEnvironment('a'), 'a', 'Projekt'))
  assert.throws(() => assertAllowed(inEnvironment('a'), 'b', 'Projekt'), (e: unknown) =>
    e instanceof AppError && e.status === 404 && e.message === 'Projekt nicht gefunden')
})

test('scopeEnvId: nur ein Umgebungs-Scope hat eine Umgebung', () => {
  assert.equal(scopeEnvId(inEnvironment('a')), 'a')
  assert.equal(scopeEnvId(sessionScope()), null)
  assert.equal(scopeEnvId(serverJob('x')), null)
})
