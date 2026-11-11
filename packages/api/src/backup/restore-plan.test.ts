import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lsArgs, parseLs, projectPaths, restoredPath, volumeRestoreCmd } from './restore-plan.js'

const node = (path: string, type: 'file' | 'dir', size = 0) =>
  JSON.stringify({ name: path.split('/').pop(), type, path, size, struct_type: 'node', message_type: 'node' })
const snapshotLine = JSON.stringify({ time: '2026-11-11T02:30:00Z', id: 'abc', short_id: 'abc', struct_type: 'snapshot', message_type: 'snapshot' })

test('Pfade eines Projekts im Stand', () => {
  assert.deepEqual(projectPaths('fotoalbum'), { volumes: '/staging/volumes/fotoalbum', site: '/source/sites/fotoalbum', repo: '/source/data/repos/fotoalbum' })
  assert.throws(() => projectPaths('../etc'))
  assert.throws(() => projectPaths('a b'))
})

test('restic ls: feste Argumente, nur gültige Kennung', () => {
  assert.deepEqual(lsArgs('3f9c2a7b', 'foto'), ['ls', '--json', '--recursive', '3f9c2a7b', '/staging/volumes/foto', '/source/sites/foto', '/source/data/repos/foto'])
  assert.throws(() => lsArgs('latest', 'foto'))
  assert.throws(() => lsArgs('3f9c2a7b; rm -rf /', 'foto'))
  assert.throws(() => lsArgs('3f9c2a7b', '--repo'))
})

test('Vorschau: Teile je Volume, Seite und Repository mit Dateien und Bytes', () => {
  const lines = [
    snapshotLine,
    node('/staging/volumes/foto', 'dir'),
    node('/staging/volumes/foto/db', 'dir'),
    node('/staging/volumes/foto/db/base.dat', 'file', 1000),
    node('/staging/volumes/foto/db/wal.dat', 'file', 500),
    node('/staging/volumes/foto/uploads', 'dir'),
    node('/source/sites/foto', 'dir'),
    node('/source/sites/foto/v1/index.html', 'file', 42),
    node('/source/data/repos/foto/README.md', 'file', 7),
    // gehört nicht dazu (anderes Projekt mit gleichem Anfang)
    node('/source/sites/fotoalbum/index.html', 'file', 99),
    'kein json',
  ]
  const r = parseLs(lines, 'foto')
  assert.equal(r.truncated, false)
  assert.deepEqual(r.parts, [
    { kind: 'volume', name: 'db', files: 2, bytes: 1500 },
    { kind: 'volume', name: 'uploads', files: 0, bytes: 0 },
    { kind: 'site', name: 'foto', files: 1, bytes: 42 },
    { kind: 'repo', name: 'foto', files: 1, bytes: 7 },
  ])
})

test('Vorschau: abgeschnittene Ausgabe wird gemeldet, leerer Stand ergibt keine Teile', () => {
  assert.equal(parseLs([node('/source/sites/foto/a', 'file', 1)], 'foto').truncated, true)
  assert.deepEqual(parseLs([snapshotLine], 'foto'), { parts: [], truncated: false })
})

test('Volume zurückkopieren: Ziel leeren, aus dem Staging füllen, nur einfache Namen', () => {
  const cmd = volumeRestoreCmd('foto', 'db')
  assert.equal(cmd[0], 'sh')
  assert.match(cmd[2]!, /test -d '\/staging\/restore\/staging\/volumes\/foto\/db' && find \/to -mindepth 1 -delete && cp -a '\/staging\/restore\/staging\/volumes\/foto\/db\/\.' \/to\//)
  assert.throws(() => volumeRestoreCmd('foto', "x'; rm -rf /; '"))
  assert.throws(() => volumeRestoreCmd('foto', '..'))
  assert.equal(restoredPath('/source/sites/foto'), '/staging/restore/source/sites/foto')
})
