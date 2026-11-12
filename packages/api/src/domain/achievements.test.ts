import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { achievementIds } from '@airlock/shared'

// achievements.ts zieht die Datenbank nach; für den Import genügt eine Dummy-Umgebung.
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { evaluateAchievements, newAchievements, achievementList, isNightShift, uptimeStreakEnd, zurichDay } = await import('./achievements.js')
type Facts = Parameters<typeof evaluateAchievements>[0]

const NOW = new Date('2026-11-12T10:00:00Z')
const none: Facts = {
  successfulDeploys: [], manualDeployStarts: [], publicSince: [], gradeAScans: [], uptimeDays: [],
  latestScans: [], everHadFindings: false, unlocks: [], lastUnlockAt: null,
}
const d = (iso: string) => new Date(iso)
/** n Tage ab start (YYYY-MM-DD) mit denselben Minuten */
function days(projectId: string, start: string, n: number, m: { up?: number; down?: number; paused?: number } = {}) {
  const t0 = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    projectId, day: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), up: m.up ?? 1440, down: m.down ?? 0, paused: m.paused ?? 0,
  }))
}

describe('Achievements: ohne Daten nichts', () => {
  test('leere Fakten: kein einziges Achievement', () => {
    const r = evaluateAchievements(none, NOW)
    for (const id of achievementIds) assert.equal(r[id], null, id)
  })
})

describe('Erster Deploy, erstes öffentliches Projekt, Note A', () => {
  test('jeweils der früheste Zeitpunkt aus den Daten', () => {
    const r = evaluateAchievements({
      ...none,
      successfulDeploys: [d('2026-05-02T10:00:00Z'), d('2026-04-01T09:00:00Z')],
      publicSince: [d('2026-06-10T08:00:00Z'), d('2026-06-01T08:00:00Z')],
      gradeAScans: [d('2026-07-01T12:00:00Z')],
    }, NOW)
    assert.equal(r.first_deploy?.toISOString(), '2026-04-01T09:00:00.000Z')
    assert.equal(r.first_public?.toISOString(), '2026-06-01T08:00:00.000Z')
    assert.equal(r.grade_a?.toISOString(), '2026-07-01T12:00:00.000Z')
  })
})

describe('Nachtschicht: Deploy zwischen 0 und 4 Uhr Zürcher Zeit', () => {
  test('Grenzen in Winter- und Sommerzeit', () => {
    // Winter (UTC+1): 23:30 UTC = 00:30 in Zürich
    assert.equal(isNightShift(d('2026-01-14T23:30:00Z')), true)
    assert.equal(isNightShift(d('2026-01-15T02:59:59Z')), true, '03:59:59')
    assert.equal(isNightShift(d('2026-01-15T03:00:00Z')), false, '04:00 zählt nicht mehr')
    assert.equal(isNightShift(d('2026-01-14T22:59:00Z')), false, '23:59')
    // Sommer (UTC+2): 22:15 UTC = 00:15 in Zürich
    assert.equal(isNightShift(d('2026-07-14T22:15:00Z')), true)
    assert.equal(isNightShift(d('2026-07-15T02:00:00Z')), false, '04:00 Sommerzeit')
  })

  test('nur von Hand gestartete Deploys zählen (die Fakten enthalten nur solche); der früheste in der Nacht', () => {
    const r = evaluateAchievements({ ...none, manualDeployStarts: [d('2026-03-03T12:00:00Z'), d('2026-03-05T01:00:00Z'), d('2026-03-04T00:30:00Z')] }, NOW)
    assert.equal(r.night_shift?.toISOString(), '2026-03-04T00:30:00.000Z')
    assert.equal(evaluateAchievements({ ...none, manualDeployStarts: [d('2026-03-03T12:00:00Z')] }, NOW).night_shift, null)
  })
})

describe('100 Tage ohne Ausfall (Verfügbarkeit gibt es erst seit Etappe 5)', () => {
  const today = '2026-11-12'
  test('100 gemessene Tage am Stück ohne gestörte Minute: erreicht am 100. Tag', () => {
    assert.equal(uptimeStreakEnd(days('a', '2026-08-01', 100), today), '2026-11-08')
    assert.equal(uptimeStreakEnd(days('a', '2026-08-01', 99), today), null)
  })

  test('eine gestörte Minute oder ein Tag ohne Messung beginnt von vorn', () => {
    const withDown = [...days('a', '2026-07-01', 50), ...days('a', '2026-08-20', 1, { up: 1439, down: 1 }), ...days('a', '2026-08-21', 80)]
    assert.equal(uptimeStreakEnd(withDown, today), null)
    const gap = [...days('a', '2026-06-01', 60), ...days('a', '2026-08-01', 60)] // Juli fehlt
    assert.equal(uptimeStreakEnd(gap, today), null)
  })

  test('Wartung ist keine Störung; der laufende Tag zählt erst, wenn er vorbei ist', () => {
    const paused = [...days('a', '2026-07-01', 40), ...days('a', '2026-08-10', 5, { up: 0, paused: 1440 }), ...days('a', '2026-08-15', 55)]
    assert.equal(uptimeStreakEnd(paused, today), '2026-10-08')
    const toToday = days('a', '2026-08-05', 100) // letzter Tag = heute
    assert.equal(toToday.at(-1)!.day, today)
    assert.equal(uptimeStreakEnd(toToday, today), null)
  })

  test('Strecken zählen je Projekt, nicht über Projekte hinweg; die früheste gewinnt', () => {
    const mixed = [...days('a', '2026-07-01', 60), ...days('b', '2026-08-30', 60)]
    assert.equal(uptimeStreakEnd(mixed, today), null)
    const two = [...days('a', '2026-07-01', 100), ...days('b', '2026-06-01', 100)]
    assert.equal(uptimeStreakEnd(two, today), '2026-09-08')
    assert.equal(evaluateAchievements({ ...none, uptimeDays: two }, NOW).uptime_100?.toISOString(), '2026-09-08T12:00:00.000Z')
  })

  test('Zürcher Tag', () => {
    assert.equal(zurichDay(d('2026-11-12T23:30:00Z')), '2026-11-13')
  })
})

describe('Alle Befunde behoben', () => {
  const scan = (projectId: string, iso: string, open: number) => ({ projectId, finishedAt: d(iso), open })
  test('jedes gescannte Projekt ohne offenen Befund, und es gab je Befunde: Zeit des letzten Scans', () => {
    const r = evaluateAchievements({ ...none, everHadFindings: true, latestScans: [scan('a', '2026-10-01T10:00:00Z', 0), scan('b', '2026-10-03T10:00:00Z', 0)] }, NOW)
    assert.equal(r.all_fixed?.toISOString(), '2026-10-03T10:00:00.000Z')
  })
  test('ein offener Befund irgendwo: nicht erreicht', () => {
    assert.equal(evaluateAchievements({ ...none, everHadFindings: true, latestScans: [scan('a', '2026-10-01T10:00:00Z', 0), scan('b', '2026-10-03T10:00:00Z', 2)] }, NOW).all_fixed, null)
  })
  test('nie einen Befund gehabt oder nie gescannt: nichts behoben', () => {
    assert.equal(evaluateAchievements({ ...none, everHadFindings: false, latestScans: [scan('a', '2026-10-01T10:00:00Z', 0)] }, NOW).all_fixed, null)
    assert.equal(evaluateAchievements({ ...none, everHadFindings: true, latestScans: [] }, NOW).all_fixed, null)
  })
})

describe('Geheimnisse gefunden: alle Freischaltungen', () => {
  test('beide (Windows 95 und Terminal); Zeit der letzten Freischaltung aus dem Audit', () => {
    assert.equal(evaluateAchievements({ ...none, unlocks: ['win95'] }, NOW).secrets, null)
    const r = evaluateAchievements({ ...none, unlocks: ['win95', 'terminal'], lastUnlockAt: d('2026-11-11T23:00:00Z') }, NOW)
    assert.equal(r.secrets?.toISOString(), '2026-11-11T23:00:00.000Z')
    // Altes Format ohne Audit-Eintrag: jetzt
    assert.equal(evaluateAchievements({ ...none, unlocks: ['terminal', 'win95'] }, NOW).secrets?.toISOString(), NOW.toISOString())
  })
})

describe('Speichern und «gesehen» (Konfetti nur einmal)', () => {
  const evaluated = { ...evaluateAchievements(none, NOW), first_deploy: d('2026-04-01T09:00:00Z'), grade_a: d('2026-07-01T12:00:00Z') }

  test('neu Erreichtes kommt ungesehen in die Tabelle; schon Gespeichertes bleibt, wie es ist', () => {
    const stored = [{ id: 'first_deploy', achievedAt: d('2026-04-01T09:00:00Z'), seenAt: d('2026-04-01T09:01:00Z') }]
    assert.deepEqual(newAchievements(evaluated, stored, NOW, false), [{ id: 'grade_a', achievedAt: d('2026-07-01T12:00:00Z'), seenAt: null }])
  })

  test('erster Abgleich nach dem Update: alles schon Erfüllte gilt als gesehen (kein Konfetti für Altes)', () => {
    assert.deepEqual(newAchievements(evaluated, [], NOW, true).map((a) => [a.id, a.seenAt?.toISOString()]), [['first_deploy', NOW.toISOString()], ['grade_a', NOW.toISOString()]])
  })

  test('einmal erreicht, bleibt es – auch wenn die Regel nicht mehr gilt (Note später schlechter)', () => {
    const stored = [{ id: 'grade_a', achievedAt: d('2026-07-01T12:00:00Z'), seenAt: null }]
    assert.deepEqual(newAchievements(evaluateAchievements(none, NOW), stored, NOW, false), [])
    const list = achievementList(stored)
    assert.equal(list.length, achievementIds.length)
    assert.deepEqual(list.find((a) => a.id === 'grade_a'), { id: 'grade_a', title: 'Note A', description: 'Ein Security-Scan hat die Note A ergeben.', achievedAt: '2026-07-01T12:00:00.000Z', seen: false })
    assert.equal(list.find((a) => a.id === 'first_deploy')!.achievedAt, null)
  })
})
