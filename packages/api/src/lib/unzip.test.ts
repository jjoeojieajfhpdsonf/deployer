import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeJoin, entryFileType, extractZipSafely, DEFAULT_LIMITS, type UnzipLimits } from './unzip.js'
import { makeZip, type ZipEntry } from './zip-fixture.js'

/** Enge Grenzen, damit die Limit-Tests ohne 100-MB-Dateien auskommen. */
const tight: UnzipLimits = { maxArchiveBytes: 65536, maxTotalBytes: 8192, maxEntries: 10, maxFileBytes: 8192 }

let work: string

before(() => {
  work = mkdtempSync(join(tmpdir(), 'deployer-unzip-'))
})
after(() => {
  rmSync(work, { recursive: true, force: true })
})

function zipAt(name: string, entries: ZipEntry[]): string {
  const p = join(work, name)
  writeFileSync(p, makeZip(entries))
  return p
}

async function extractExpectingError(
  zipPath: string,
  dest: string,
  limits: UnzipLimits = DEFAULT_LIMITS,
): Promise<string> {
  try {
    await extractZipSafely(zipPath, dest, limits)
  } catch (err) {
    return (err as Error).message
  }
  return ''
}

describe('safeJoin: Pfade werden am aufgelösten Ergebnis geprüft', () => {
  const dest = '/srv/sites/x/v1'

  test('normaler Pfad', () => {
    assert.equal(safeJoin(dest, 'index.html'), '/srv/sites/x/v1/index.html')
    assert.equal(safeJoin(dest, 'a/b/c.css'), '/srv/sites/x/v1/a/b/c.css')
  })

  test('Ausbruch über ..', () => {
    assert.equal(safeJoin(dest, '../evil.html'), null)
    assert.equal(safeJoin(dest, '../../../../etc/passwd'), null)
    assert.equal(safeJoin(dest, 'a/../../evil'), null)
  })

  test('.. in der Mitte ist erlaubt, solange es im Ordner bleibt', () => {
    // Genau hier scheitert eine Textsuche nach "..": der Pfad ist harmlos.
    assert.equal(safeJoin(dest, 'a/b/../c.html'), '/srv/sites/x/v1/a/c.html')
  })

  test('absolute Pfade', () => {
    assert.equal(safeJoin(dest, '/etc/passwd'), null)
    assert.equal(safeJoin(dest, 'C:\\windows\\system32'), null)
  })

  test('Backslashes und Nullbytes', () => {
    assert.equal(safeJoin(dest, 'a\\b.html'), null)
    assert.equal(safeJoin(dest, 'a\0b'), null)
  })

  test('Präfix-Trick: Nachbarordner mit gleichem Anfang', () => {
    // /srv/sites/x/v1-evil faengt mit /srv/sites/x/v1 an, liegt aber draussen.
    assert.equal(safeJoin(dest, '../v1-evil/x.html'), null)
  })

  test('leerer Name', () => {
    assert.equal(safeJoin(dest, ''), null)
  })
})

describe('entryFileType', () => {
  test('erkennt Symlink, Ordner und Datei', () => {
    assert.equal(entryFileType((0o120777 << 16) >>> 0), 'symlink')
    assert.equal(entryFileType((0o040755 << 16) >>> 0), 'dir')
    assert.equal(entryFileType((0o100644 << 16) >>> 0), 'file')
  })
  test('ohne Attribute gilt als Datei (von Windows erzeugte Archive)', () => {
    assert.equal(entryFileType(0), 'file')
  })
  test('nur Rechte ohne Typ-Bits gilt als Datei (Pythons zipfile schreibt 0o600)', () => {
    // Im Ende-zu-Ende-Test aufgefallen: ein harmloses index.html wurde als
    // "weder Datei noch Ordner" abgelehnt.
    assert.equal(entryFileType((0o600 << 16) >>> 0), 'file')
    assert.equal(entryFileType((0o644 << 16) >>> 0), 'file')
  })
  test('Gerätedateien und FIFOs werden abgelehnt', () => {
    assert.equal(entryFileType((0o020644 << 16) >>> 0), 'other') // Zeichengerät
    assert.equal(entryFileType((0o010644 << 16) >>> 0), 'other') // FIFO
  })
})

describe('extractZipSafely', () => {
  test('entpackt ein harmloses Archiv', async () => {
    const zip = zipAt('ok.zip', [
      { name: 'index.html', data: '<h1>hallo</h1>' },
      { name: 'assets', isDir: true },
      { name: 'assets/app.css', data: 'body{}' },
    ])
    const dest = join(work, 'out-ok')
    const res = await extractZipSafely(zip, dest)
    assert.equal(res.bytes, '<h1>hallo</h1>'.length + 'body{}'.length)
    assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), '<h1>hallo</h1>')
    assert.ok(existsSync(join(dest, 'assets', 'app.css')))
  })

  test('ABNAHME: ein ZIP mit ../ schreibt keine Datei ausserhalb des Zielordners', async () => {
    const zip = zipAt('slip.zip', [{ name: '../entwischt.html', data: 'boom' }])
    const dest = join(work, 'out-slip')
    const msg = await extractExpectingError(zip, dest)
    // yauzl weist solche Namen schon selbst ab; safeJoin ist die zweite
    // Verteidigungslinie. Entscheidend ist die Zeile danach.
    assert.match(msg, /Zip Slip|relative path/)
    assert.ok(!existsSync(join(work, 'entwischt.html')), 'Datei darf nicht ausserhalb liegen')
  })

  test('ABNAHME: ein ZIP mit Symlink schreibt keine Datei ausserhalb des Zielordners', async () => {
    const zip = zipAt('link.zip', [
      { name: 'raus', data: '/etc', isSymlink: true },
      { name: 'raus/passwd', data: 'boom' },
    ])
    const dest = join(work, 'out-link')
    const msg = await extractExpectingError(zip, dest)
    assert.match(msg, /Symlink/)
    assert.ok(!existsSync(join(dest, 'raus')))
  })

  test('lehnt einen absoluten Pfad ab', async () => {
    const zip = zipAt('abs.zip', [{ name: '/tmp/boom.html', data: 'x' }])
    const msg = await extractExpectingError(zip, join(work, 'out-abs'))
    assert.match(msg, /Zip Slip|absolute path/)
    assert.ok(!existsSync('/tmp/boom.html'))
  })

  test('lehnt zu viele Einträge ab', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))
    const zip = zipAt('many.zip', entries)
    const msg = await extractExpectingError(zip, join(work, 'out-many'), tight)
    assert.match(msg, /Einträge/)
  })

  test('zählt die Gesamtgrösse beim Entpacken mit, nicht aus dem Kopf', async () => {
    // Die Grenze greift waehrend des Schreibens; eine geloegene Groessenangabe
    // im ZIP-Verzeichnis hilft dem Angreifer deshalb nicht.
    const big = 'A'.repeat(4096)
    const zip = zipAt('bomb.zip', [
      { name: 'a.txt', data: big },
      { name: 'b.txt', data: big },
      { name: 'c.txt', data: big },
    ])
    const msg = await extractExpectingError(zip, join(work, 'out-bomb'), tight)
    assert.match(msg, /Zip-Bombe|überschreitet/)
  })

  test('lehnt eine zu grosse Einzeldatei ab', async () => {
    const zip = zipAt('bigfile.zip', [{ name: 'x.bin', data: 'A'.repeat(9000) }])
    const msg = await extractExpectingError(zip, join(work, 'out-big'), tight)
    assert.match(msg, /grösser als erlaubt|überschreitet/)
  })
})
