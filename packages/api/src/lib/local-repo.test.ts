import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateFilePath, decodeFiles, commitFiles, readFiles, listFiles, headCommit,
  archiveTar, archiveZip, detectKind, FILES_LIMITS,
} from './local-repo.js'
import { extractTarSafely } from './untar.js'

let work: string
before(() => {
  work = mkdtempSync(join(tmpdir(), 'airlock-localrepo-'))
})
after(() => rmSync(work, { recursive: true, force: true }))

const enc = (files: Record<string, string>) => decodeFiles(Object.entries(files).map(([path, content]) => ({ path, content })))

describe('Dateipfade', () => {
  test('gültige Pfade werden normalisiert', () => {
    assert.equal(validateFilePath('index.html'), 'index.html')
    assert.equal(validateFilePath('./src/app.js'), 'src/app.js')
    assert.equal(validateFilePath('a//b.txt'), 'a/b.txt')
  })
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '.git/config', 'sub/.GIT/hooks/x', 'a\\b', 'x\0y', 'ordner/', '']) {
    test(`abgelehnt: ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateFilePath(bad))
    })
  }
  test('zu lange Pfade', () => {
    assert.throws(() => validateFilePath('a'.repeat(FILES_LIMITS.maxPathLength + 1)), /länger/)
  })
})

describe('Grenzen pro Aufruf', () => {
  test('doppelte Pfade', () => {
    assert.throws(() => decodeFiles([{ path: 'a', content: '1' }, { path: './a', content: '2' }]), /doppelt/)
  })
  test('mehr als 20 MB', () => {
    const big = 'A'.repeat(11 * 1024 * 1024)
    assert.throws(() => decodeFiles([{ path: 'a', content: big }, { path: 'b', content: big }]), /MB pro Aufruf/)
  })
  test('Base64 wird dekodiert', () => {
    const [f] = decodeFiles([{ path: 'bild.bin', content: Buffer.from([0, 1, 2]).toString('base64'), encoding: 'base64' }])
    assert.deepEqual([...f!.data], [0, 1, 2])
  })
})

describe('Repo: schreiben, lesen, Archiv', () => {
  const dir = () => join(work, 'repo')

  test('erster Commit', async () => {
    const r = await commitFiles(dir(), { write: enc({ 'index.html': '<h1>eins</h1>', 'css/a.css': 'body{}' }), message: 'start' })
    assert.equal(r.changed, true)
    assert.match(r.commit, /^[0-9a-f]{40}$/)
    assert.deepEqual((await listFiles(dir())).map((f) => f.path).sort(), ['css/a.css', 'index.html'])
  })

  test('ohne Änderung kein neuer Commit', async () => {
    const head = await headCommit(dir())
    const r = await commitFiles(dir(), { write: enc({ 'index.html': '<h1>eins</h1>' }), message: 'nichts' })
    assert.equal(r.changed, false)
    assert.equal(r.commit, head)
  })

  test('ändern und löschen', async () => {
    const r = await commitFiles(dir(), { write: enc({ 'index.html': '<h1>zwei</h1>' }), remove: ['css/a.css'], message: 'update' })
    assert.equal(r.changed, true)
    const files = await readFiles(dir(), undefined)
    assert.deepEqual(files.map((f) => [f.path, f.content]), [['index.html', '<h1>zwei</h1>']])
  })

  test('read_files mit Pfaden und unbekanntem Pfad', async () => {
    assert.equal((await readFiles(dir(), ['index.html']))[0]!.content, '<h1>zwei</h1>')
    await assert.rejects(readFiles(dir(), ['gibts-nicht.txt']), /gibt es im Projekt nicht/)
  })

  test('Binärdateien kommen als Base64 zurück', async () => {
    await commitFiles(dir(), { write: decodeFiles([{ path: 'b.bin', content: Buffer.from([0, 255, 1]).toString('base64'), encoding: 'base64' }]), message: 'bin' })
    const [b] = await readFiles(dir(), ['b.bin'])
    assert.equal(b!.encoding, 'base64')
    assert.deepEqual([...Buffer.from(b!.content, 'base64')], [0, 255, 1])
  })

  test('Archiv entpackt sich sicher und vollständig', async () => {
    const out = join(work, 'out')
    const head = (await headCommit(dir()))!
    await extractTarSafely(archiveTar(dir(), head), out)
    assert.ok(existsSync(join(out, 'index.html')))
    assert.ok(!existsSync(join(out, '.git')))
  })

  test('ZIP-Export', async () => {
    const zip = await archiveZip(dir())
    assert.equal(zip.subarray(0, 2).toString(), 'PK')
  })

  test('REVIEW: Umlaute im Pfad bleiben lesbar', async () => {
    await commitFiles(dir(), { write: enc({ 'über uns.html': '<h1>ü</h1>' }), message: 'umlaut' })
    assert.ok((await listFiles(dir())).some((f) => f.path === 'über uns.html'))
    assert.equal((await readFiles(dir(), ['über uns.html']))[0]!.content, '<h1>ü</h1>')
  })

  test('REVIEW: gescheiterter Aufruf hinterlässt nichts für den nächsten Commit', async () => {
    const before = await headCommit(dir())
    // "index.html" ist eine Datei; "index.html/x" kann nicht entstehen.
    await assert.rejects(commitFiles(dir(), { write: enc({ 'neu.html': 'n', 'index.html/x': 'x' }), message: 'kaputt' }), /keine Ordner|Datei, kein Ordner|schreiben/)
    assert.equal(await headCommit(dir()), before)
    const r = await commitFiles(dir(), { write: enc({ 'anders.html': 'a' }), message: 'sauber' })
    const files = (await listFiles(dir(), r.commit)).map((f) => f.path)
    assert.ok(!files.includes('neu.html'), 'neu.html aus dem gescheiterten Aufruf darf nicht mitkommen')
  })

  test('REVIEW: gleichzeitige Aufrufe vermischen sich nicht', async () => {
    const [a, b] = await Promise.all([
      commitFiles(dir(), { write: enc({ 'a.txt': 'A' }), message: 'A' }),
      commitFiles(dir(), { write: enc({ 'b.txt': 'B' }), message: 'B' }),
    ])
    assert.notEqual(a.commit, b.commit)
    const aFiles = (await listFiles(dir(), a.commit)).map((f) => f.path)
    const bFiles = (await listFiles(dir(), b.commit)).map((f) => f.path)
    // Der erste Commit enthält nur seine Datei, der zweite beide.
    assert.ok(aFiles.includes('a.txt') !== bFiles.includes('a.txt') || !aFiles.includes('b.txt'))
    assert.ok(!(aFiles.includes('b.txt') && !bFiles.includes('a.txt')))
  })

  test('ein Symlink im Arbeitsordner wird nicht als Weg benutzt', async () => {
    mkdirSync(join(work, 'draussen'), { recursive: true })
    symlinkSync(join(work, 'draussen'), join(dir(), 'link'))
    await assert.rejects(commitFiles(dir(), { write: enc({ 'link/x.txt': 'boom' }), message: 'x' }), /Symlink/)
    assert.equal(existsSync(join(work, 'draussen', 'x.txt')), false)
    // Das Zurücksetzen nach dem Fehler hat den fremden Symlink schon entfernt.
    assert.equal(existsSync(join(dir(), 'link')), false)
  })
})

describe('Typ-Erkennung (Reihenfolge laut SPEC)', () => {
  test('compose.yaml schlägt alles', () => {
    assert.deepEqual(detectKind(['compose.yaml', 'Dockerfile', 'package.json'], '{"scripts":{"build":"x"}}'), { kind: 'compose', composePath: 'compose.yaml' })
    assert.equal(detectKind(['docker-compose.yml'], null).composePath, 'docker-compose.yml')
  })
  test('Dockerfile vor package.json', () => {
    assert.equal(detectKind(['Dockerfile', 'package.json'], '{"scripts":{"build":"x"}}').kind, 'dockerfile')
  })
  test('package.json mit build-Skript', () => {
    assert.equal(detectKind(['package.json', 'src/main.js'], '{"scripts":{"build":"vite build"}}').kind, 'static-build')
  })
  test('package.json ohne build-Skript bleibt statisch', () => {
    assert.equal(detectKind(['package.json', 'index.html'], '{"scripts":{"start":"x"}}').kind, 'static')
  })
  test('nur HTML', () => {
    assert.equal(detectKind(['index.html'], null).kind, 'static')
  })
  test('Dockerfile nur im Unterordner zählt nicht', () => {
    assert.equal(detectKind(['app/Dockerfile', 'index.html'], null).kind, 'static')
  })
})
