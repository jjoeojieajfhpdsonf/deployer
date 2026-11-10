import { test } from 'node:test'
import assert from 'node:assert/strict'

// Ohne Datenbank: nur die reine Lesefunktion. Die Konfiguration verlangt
// DATABASE_URL und ADMIN_PASSWORD, ohne dass verbunden wird.
process.env.DATABASE_URL ??= 'postgres://test@localhost/test'
process.env.ADMIN_PASSWORD ??= 'x'.repeat(16)
const { parseExpiryDays } = await import('./expiry-settings.js')

test('Frist: gespeicherter Wert gilt, Ungültiges fällt auf den Standard', () => {
  assert.equal(parseExpiryDays('14', 30), 14)
  assert.equal(parseExpiryDays(null, 30), 30)
  assert.equal(parseExpiryDays('3', 30), 30)
  assert.equal(parseExpiryDays('7.5', 30), 30)
  assert.equal(parseExpiryDays('abc', 30), 30)
  assert.equal(parseExpiryDays('3650', 30), 3650)
})
