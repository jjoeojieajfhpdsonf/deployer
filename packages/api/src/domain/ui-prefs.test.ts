import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { uiPrefsSchema } from '@airlock/shared'

// ui-prefs.ts zieht die Datenbank nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { parseUiPrefs, mergeUiPrefs, clampBellSeen, DEFAULT_UI_PREFS } = await import('./ui-prefs.js')

describe('Glocke: «gelesen bis» (UI-Qualität 8)', () => {
  test('wird beim Lesen mitgegeben, sonst ist nach dem Neuladen alles wieder ungelesen', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"dark","bellSeenAt":"2026-11-10T22:00:00.000Z"}'), { theme: 'dark', bellSeenAt: '2026-11-10T22:00:00.000Z' })
    // Kaputter Wert fällt weg, der Rest bleibt
    assert.deepEqual(parseUiPrefs('{"theme":"dark","bellSeenAt":"gestern"}'), { theme: 'dark' })
  })

  test('Theme-Wechsel lässt «gelesen bis» stehen', () => {
    assert.deepEqual(mergeUiPrefs({ theme: 'dark', bellSeenAt: '2026-11-10T22:00:00.000Z' }, { theme: 'light' }), { theme: 'light', bellSeenAt: '2026-11-10T22:00:00.000Z' })
  })

  test('nie in der Zukunft: ein Datum wie 9999 würde die Glocke für immer stumm schalten', () => {
    const now = new Date('2026-11-11T01:00:00.000Z')
    assert.deepEqual(clampBellSeen({ bellSeenAt: '9999-01-01T00:00:00.000Z' }, now), { bellSeenAt: '2026-11-11T01:00:00.000Z' })
    assert.deepEqual(clampBellSeen({ bellSeenAt: '2026-11-10T22:00:00.000Z' }, now), { bellSeenAt: '2026-11-10T22:00:00.000Z' })
    assert.deepEqual(clampBellSeen({ theme: 'dark' }, now), { theme: 'dark' })
  })
})

describe('Einrichtung (erster Start) neben der Darstellung', () => {
  test('Theme-Wechsel lässt den Stand der Einrichtung stehen und umgekehrt', () => {
    const before = { theme: 'dark' as const, setup: { dismissed: true, skipped: ['cloudflare' as const] } }
    assert.deepEqual(mergeUiPrefs(before, { theme: 'light' }), { theme: 'light', setup: { dismissed: true, skipped: ['cloudflare'] } })
    assert.deepEqual(mergeUiPrefs(before, { setup: { dismissed: false, skipped: [] } }), { theme: 'dark', setup: { dismissed: false, skipped: [] } })
  })

  test('gespeicherter Stand wird gelesen; unbekannte Schritte sind ungültig', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"system","setup":{"dismissed":false,"skipped":["adressen"]}}'), { theme: 'system', setup: { dismissed: false, skipped: ['adressen'] } })
    // Kaputte Einrichtung: wird verworfen, die Darstellung bleibt
    assert.deepEqual(parseUiPrefs('{"theme":"dark","setup":{"dismissed":false,"skipped":["fliegen"]}}'), { theme: 'dark' })
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

describe('Windows 95 (verstecktes Theme)', () => {
  test('Freischaltung und Theme werden gespeichert und gelesen', () => {
    const unlocked = mergeUiPrefs({ theme: 'dark' }, { win95Unlocked: true })
    assert.deepEqual(unlocked, { theme: 'dark', win95Unlocked: true })
    const chosen = mergeUiPrefs(unlocked, { theme: 'win95' })
    assert.deepEqual(chosen, { theme: 'win95', win95Unlocked: true })
    assert.deepEqual(parseUiPrefs(JSON.stringify(chosen)), { theme: 'win95', win95Unlocked: true })
  })

  test('ohne Freischaltung lehnt der Server «win95» ab', () => {
    assert.throws(() => mergeUiPrefs({ theme: 'light' }, { theme: 'win95' }), /nicht freigeschaltet/)
    // Freischalten und wählen in einem Schritt geht
    assert.deepEqual(mergeUiPrefs({ theme: 'light' }, { theme: 'win95', win95Unlocked: true }), { theme: 'win95', win95Unlocked: true })
  })

  test('gespeichertes «win95» ohne Freischaltung fällt beim Lesen auf den Standard', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"win95"}'), DEFAULT_UI_PREFS)
    assert.deepEqual(parseUiPrefs('{"theme":"win95","win95Unlocked":"ja"}'), DEFAULT_UI_PREFS)
  })

  test('die Freischaltung bleibt; «false» nimmt sie nicht zurück', () => {
    assert.deepEqual(mergeUiPrefs({ theme: 'win95', win95Unlocked: true }, { win95Unlocked: false }), { theme: 'win95', win95Unlocked: true })
    // Noch nicht freigeschaltet: «false» landet nicht im Stand
    assert.deepEqual(mergeUiPrefs({ theme: 'light' }, { win95Unlocked: false }), { theme: 'light' })
  })

  test('andere Wechsel lassen die Freischaltung stehen', () => {
    assert.deepEqual(mergeUiPrefs({ theme: 'win95', win95Unlocked: true }, { theme: 'light' }), { theme: 'light', win95Unlocked: true })
    assert.deepEqual(mergeUiPrefs({ theme: 'light', win95Unlocked: true }, { bellSeenAt: '2026-11-10T22:00:00.000Z' }), { theme: 'light', win95Unlocked: true, bellSeenAt: '2026-11-10T22:00:00.000Z' })
  })

  test('Schema kennt «win95», die Meldung nennt alle vier', () => {
    assert.equal(uiPrefsSchema.safeParse({ theme: 'win95' }).success, true)
    const r = uiPrefsSchema.safeParse({ theme: 'amiga' })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0]!.message, /Windows 95/)
  })
})
