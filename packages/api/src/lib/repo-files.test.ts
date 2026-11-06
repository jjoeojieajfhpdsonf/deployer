import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInRepo, readRepoFile } from './repo-files.js'

let root: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'deployer-repofiles-'))
  mkdirSync(join(root, 'conf'))
  writeFileSync(join(root, 'compose.yaml'), 'services: {}\n')
  writeFileSync(join(root, 'conf', 'app.env'), 'A=1\n')
  writeFileSync(join(root, 'gross.bin'), 'x'.repeat(2000))
  // Fallen, die ein bösartiges Repo legen könnte (wenn git sie doch als
  // Symlink auscheckte):
  symlinkSync('/proc/self/environ', join(root, 'environ.env'))
  symlinkSync('/etc', join(root, 'etc-link'))
})

after(() => rmSync(root, { recursive: true, force: true }))

describe('Dateien im Repo', () => {
  test('normaler Pfad', async () => {
    assert.equal(await readRepoFile(root, 'conf/app.env', 1000), 'A=1\n')
  })

  test('"." ist das Repo selbst', async () => {
    assert.ok((await resolveInRepo(root, '.')).endsWith(root.split('/').pop()!))
  })

  test('Ausbruch über ..', async () => {
    await assert.rejects(resolveInRepo(root, '../x'), /nicht im Repo/)
  })

  test('Symlink als Datei wird abgelehnt', async () => {
    await assert.rejects(readRepoFile(root, 'environ.env', 1000), /Symlink/)
  })

  test('Symlink als Zwischenordner wird abgelehnt', async () => {
    await assert.rejects(readRepoFile(root, 'etc-link/passwd', 100_000), /Symlink/)
  })

  test('zu grosse Datei', async () => {
    await assert.rejects(readRepoFile(root, 'gross.bin', 1000), /grösser/)
  })

  test('fehlende Datei', async () => {
    await assert.rejects(readRepoFile(root, 'gibts-nicht.yaml', 1000), /gibt es im Repo nicht/)
  })

  test('Ordner statt Datei', async () => {
    await assert.rejects(readRepoFile(root, 'conf', 1000), /keine Datei/)
  })
})
