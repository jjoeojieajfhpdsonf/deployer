import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { uiPrefsSchema } from '@deployer/shared'

// ui-prefs.ts zieht die Datenbank nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { parseUiPrefs, DEFAULT_UI_PREFS } = await import('./ui-prefs.js')

describe('Darstellung (Hell/Dunkel/System)', () => {
  test('Standard folgt dem Gerät', () => {
    assert.deepEqual(parseUiPrefs(null), { theme: 'system' })
    assert.deepEqual(DEFAULT_UI_PREFS, { theme: 'system' })
  })

  test('gespeicherte Wahl wird gelesen', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"dark"}'), { theme: 'dark' })
    assert.deepEqual(parseUiPrefs('{"theme":"light"}'), { theme: 'light' })
  })

  test('Kaputtes oder Unbekanntes fällt auf den Standard zurück', () => {
    assert.deepEqual(parseUiPrefs('{kaputt'), { theme: 'system' })
    assert.deepEqual(parseUiPrefs('{"theme":"midnight"}'), { theme: 'system' })
  })

  test('Schema der API nimmt nur light, dark, system', () => {
    assert.equal(uiPrefsSchema.safeParse({ theme: 'dark' }).success, true)
    assert.equal(uiPrefsSchema.safeParse({ theme: 'midnight' }).success, false)
    assert.equal(uiPrefsSchema.safeParse({}).success, false)
  })
})
