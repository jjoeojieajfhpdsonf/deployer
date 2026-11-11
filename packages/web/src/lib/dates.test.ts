import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ageMs, dateOf, fmtDate, fmtDateTime, fmtTime, fmtWeekday, isoOf, msOf, sameDay, spanMs } from './dates.js'
import { relativeTime, clockOrDay, inTime } from './format.js'
import { dayLabel } from './activity.js'

// Werte, die schon einmal die Oberfläche zum Absturz gebracht haben oder es könnten
const BAD = [null, undefined, '', 'Unsinn', '+333333-03-03T00:00:00.000Z', '333333-03-03T10:00', 'NaN', '2026-13-45T99:99', 8.64e15 + 1, Number.NaN]

describe('Datumswerte: ungültig ergibt «–», nie eine Ausnahme', () => {
  test('alle Formatierer überstehen kaputte Werte', () => {
    for (const v of BAD) {
      assert.equal(msOf(v as string), null, String(v))
      assert.equal(dateOf(v as string), null)
      assert.equal(isoOf(v as string), null)
      assert.equal(fmtDateTime(v as string), '–')
      assert.equal(fmtDate(v as string), '–')
      assert.equal(fmtTime(v as string), '–')
      assert.equal(fmtWeekday(v as string), '–')
      assert.equal(ageMs(v as string), null)
      assert.equal(sameDay(v as string, new Date()), false)
      assert.equal(relativeTime(v as string), '–')
      assert.equal(inTime(v as string), '–')
      assert.equal(spanMs(v as string, '2026-11-11T10:00:00Z'), null)
    }
    assert.equal(clockOrDay('Unsinn'), '–')
    assert.equal(dayLabel('Unsinn'), 'Ohne Datum')
  })

  test('gültige Werte im Schweizer Format', () => {
    const iso = '2026-03-01T08:05:09Z'
    assert.equal(isoOf(iso), '2026-03-01T08:05:09.000Z')
    assert.match(fmtDate(iso), /^1\.3\.2026$/)
    assert.match(fmtTime(iso), /^\d\d:05$/)
    assert.equal(spanMs('2026-03-01T08:00:00Z', iso), 309_000)
  })
})

describe('Keine ungeprüften Datumsumwandlungen ausserhalb von lib/dates.ts', () => {
  test('Quelltext der Oberfläche', () => {
    const src = fileURLToPath(new URL('..', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts')) files.push(p)
      }
    }
    walk(src)
    // new Date(wert) – nur new Date() ohne Argument (jetzt) ist erlaubt
    const banned = [/new Date\(\s*[^)\s]/, /Date\.parse\(/, /\.toISOString\(/, /\.toLocaleDateString\(/, /\.toLocaleTimeString\(/]
    const hits: string[] = []
    for (const f of files) {
      const rel = relative(src, f)
      if (rel === join('lib', 'dates.ts')) continue
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (banned.some((b) => b.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(hits, [], `Datumswerte bitte über lib/dates.ts umwandeln:\n${hits.join('\n')}`)
  })
})
