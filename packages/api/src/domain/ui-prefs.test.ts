import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { themeUnlocked, uiPrefsPatchSchema, uiPrefsSchema, unlockRequestSchema } from '@airlock/shared'

// ui-prefs.ts zieht die Datenbank nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { parseUiPrefs, mergeUiPrefs, clampBellSeen, addUnlock, normalizeUnlocks, DEFAULT_UI_PREFS } = await import('./ui-prefs.js')

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

describe('Freischaltungen (unlocks)', () => {
  test('Freischalten fügt die Kennung hinzu; zweimal ist wie einmal', () => {
    const once = addUnlock({ theme: 'dark' }, 'win95')
    assert.deepEqual(once, { theme: 'dark', unlocks: ['win95'] })
    assert.deepEqual(addUnlock(once, 'win95'), once)
  })

  test('Schema: nur bekannte Kennungen', () => {
    assert.equal(unlockRequestSchema.safeParse({ id: 'win95' }).success, true)
    const r = unlockRequestSchema.safeParse({ id: 'amiga' })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0]!.message, /Unbekannte Freischaltung/)
    assert.equal(unlockRequestSchema.safeParse({}).success, false)
    assert.equal(uiPrefsSchema.safeParse({ theme: 'dark', unlocks: ['win95'] }).success, true)
    assert.equal(uiPrefsSchema.safeParse({ theme: 'dark', unlocks: ['amiga'] }).success, false)
  })

  test('PUT /auth/preferences kann Freischaltungen weder setzen noch löschen', () => {
    // Das Patch-Schema kennt «unlocks» nicht (fällt beim Parsen weg) …
    assert.deepEqual(uiPrefsPatchSchema.parse({ theme: 'dark', unlocks: ['win95'] }), { theme: 'dark' })
    // … und der Bestand bleibt bei jedem Wechsel stehen
    assert.deepEqual(mergeUiPrefs({ theme: 'win95', unlocks: ['win95'] }, { theme: 'light' }), { theme: 'light', unlocks: ['win95'] })
    assert.deepEqual(mergeUiPrefs({ theme: 'light', unlocks: ['win95'] }, { bellSeenAt: '2026-11-10T22:00:00.000Z' }), { theme: 'light', unlocks: ['win95'], bellSeenAt: '2026-11-10T22:00:00.000Z' })
    assert.deepEqual(mergeUiPrefs({ theme: 'light' }, { theme: 'dark' }), { theme: 'dark' })
  })

  test('gespeicherte Liste wird gelesen; Unbekanntes und Doppeltes fällt weg', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"dark","unlocks":["win95"]}'), { theme: 'dark', unlocks: ['win95'] })
    assert.deepEqual(parseUiPrefs('{"theme":"dark","unlocks":["win95","amiga","win95"]}'), { theme: 'dark', unlocks: ['win95'] })
    assert.deepEqual(parseUiPrefs('{"theme":"dark","unlocks":["amiga"]}'), { theme: 'dark' })
    assert.deepEqual(parseUiPrefs('{"theme":"dark","unlocks":"win95"}'), { theme: 'dark' })
    assert.deepEqual(normalizeUnlocks(['win95', 'win95', 7, null]), ['win95'])
  })

  test('Altes Format: win95Unlocked: true wird zu unlocks: [\'win95\']', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"win95","win95Unlocked":true}'), { theme: 'win95', unlocks: ['win95'] })
    assert.deepEqual(parseUiPrefs('{"theme":"light","win95Unlocked":true,"unlocks":["win95"]}'), { theme: 'light', unlocks: ['win95'] })
    // Nur «true» zählt
    assert.deepEqual(parseUiPrefs('{"theme":"light","win95Unlocked":false}'), { theme: 'light' })
    // Beim nächsten Speichern steht nur noch das neue Feld im Stand
    const saved = mergeUiPrefs(parseUiPrefs('{"theme":"win95","win95Unlocked":true}'), { theme: 'dark' })
    assert.deepEqual(saved, { theme: 'dark', unlocks: ['win95'] })
    assert.equal('win95Unlocked' in saved, false)
  })
})

describe('Windows 95 (verstecktes Theme)', () => {
  test('Freischaltung und Theme werden gespeichert und gelesen', () => {
    const unlocked = addUnlock({ theme: 'dark' }, 'win95')
    const chosen = mergeUiPrefs(unlocked, { theme: 'win95' })
    assert.deepEqual(chosen, { theme: 'win95', unlocks: ['win95'] })
    assert.deepEqual(parseUiPrefs(JSON.stringify(chosen)), { theme: 'win95', unlocks: ['win95'] })
  })

  test('ohne Freischaltung lehnt der Server «win95» ab', () => {
    assert.throws(() => mergeUiPrefs({ theme: 'light' }, { theme: 'win95' }), /«Windows 95» ist noch nicht freigeschaltet/)
    assert.equal(themeUnlocked('win95', []), false)
    assert.equal(themeUnlocked('win95', ['win95']), true)
    assert.equal(themeUnlocked('dark', undefined), true)
  })

  test('gespeichertes «win95» ohne Freischaltung fällt beim Lesen auf den Standard', () => {
    assert.deepEqual(parseUiPrefs('{"theme":"win95"}'), DEFAULT_UI_PREFS)
    assert.deepEqual(parseUiPrefs('{"theme":"win95","win95Unlocked":"ja"}'), DEFAULT_UI_PREFS)
    assert.deepEqual(parseUiPrefs('{"theme":"win95","unlocks":[]}'), DEFAULT_UI_PREFS)
  })

  test('Schema kennt «win95», die Meldung nennt alle vier', () => {
    assert.equal(uiPrefsSchema.safeParse({ theme: 'win95' }).success, true)
    const r = uiPrefsSchema.safeParse({ theme: 'amiga' })
    assert.equal(r.success, false)
    assert.match(r.error!.issues[0]!.message, /Windows 95/)
  })
})
