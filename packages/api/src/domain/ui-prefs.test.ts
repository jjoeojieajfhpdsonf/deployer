import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { uiPrefsSchema } from '@airlock/shared'

// ui-prefs.ts zieht die Datenbank nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { parseUiPrefs, mergeUiPrefs, DEFAULT_UI_PREFS } = await import('./ui-prefs.js')

describe('Einrichtung (erster Start) neben der Darstellung', () => {
  test('Theme-Wechsel lässt den Stand der Einrichtung stehen und umgekehrt', () => {
    const before = { theme: 'dark' as const, setup: { dismissed: true, skipped: ['cloudflare' as const] } }
    assert.deepEqual(mergeUiPrefs(before, { theme: 'light' }), { theme: 'light', setup: { dismissed: true, skipped: ['cloudflare'] } })
    assert.deepEqual(mergeUiPrefs(before, { setup: { dismissed: false, skipped: [] } }), { theme: 'dark', setup: { dismissed: false, skipped: [] } })
  })

  test('gespeicherter Stand wird gelesen; unbekannte Schritte sind ungültig', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"system","setup":{"dismissed":false,"skipped":["adressen"]}}'), { theme: 'system', setup: { dismissed: false, skipped: ['adressen'] } })
    assert.deepEqual(parseUiPrefs('{"theme":"dark","setup":{"dismissed":false,"skipped":["fliegen"]}}'), { theme: 'system' })
    assert.throws(() => mergeUiPrefs(DEFAULT_UI_PREFS, { setup: { dismissed: false, skipped: ['fliegen' as 'projekt'] } }))
  })
})

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
