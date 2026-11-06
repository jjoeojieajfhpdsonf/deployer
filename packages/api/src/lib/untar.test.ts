import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import tarStream from 'tar-stream'
import { extractTarSafely } from './untar.js'

type E = { name: string; type?: 'file' | 'directory' | 'symlink' | 'link' | 'fifo'; data?: string; linkname?: string }

async function makeTar(entries: E[]): Promise<Readable> {
  const pack = tarStream.pack()
  for (const e of entries) {
    const type = e.type ?? 'file'
    if (type === 'file') pack.entry({ name: e.name }, e.data ?? '')
    else pack.entry({ name: e.name, type, linkname: e.linkname })
  }
  pack.finalize()
  const chunks: Buffer[] = []
  for await (const c of pack) chunks.push(c as Buffer)
  return Readable.from([Buffer.concat(chunks)])
}

let work: string
before(() => {
  work = mkdtempSync(join(tmpdir(), 'deployer-untar-'))
})
after(() => rmSync(work, { recursive: true, force: true }))

const tight = { maxArchiveBytes: 1e9, maxTotalBytes: 8192, maxEntries: 10, maxFileBytes: 8192 }

describe('extractTarSafely', () => {
  test('entpackt die Build-Ausgabe und schneidet den obersten Ordner ab', async () => {
    const dest = join(work, 'ok')
    const tar = await makeTar([
      { name: 'dist/', type: 'directory' },
      { name: 'dist/index.html', data: '<h1>ok</h1>' },
      { name: 'dist/assets/app.js', data: 'x' },
    ])
    const r = await extractTarSafely(tar, dest, { stripFirst: true })
    assert.equal(r.files, 2)
    assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), '<h1>ok</h1>')
    assert.ok(existsSync(join(dest, 'assets/app.js')))
  })

  test('../ wird abgelehnt, nichts landet ausserhalb', async () => {
    const dest = join(work, 'slip')
    const tar = await makeTar([{ name: 'dist/../../entwischt.html', data: 'boom' }])
    await assert.rejects(extractTarSafely(tar, dest, { stripFirst: true }), /heraus/)
    assert.equal(existsSync(join(work, 'entwischt.html')), false)
  })

  test('Symlink wird abgelehnt', async () => {
    const tar = await makeTar([{ name: 'dist/raus', type: 'symlink', linkname: '/etc' }])
    await assert.rejects(extractTarSafely(tar, join(work, 'sym'), { stripFirst: true }), /Link/)
  })

  test('Hardlink wird abgelehnt', async () => {
    const tar = await makeTar([{ name: 'dist/hart', type: 'link', linkname: '/etc/passwd' }])
    await assert.rejects(extractTarSafely(tar, join(work, 'hard'), { stripFirst: true }), /Link/)
  })

  test('FIFO wird abgelehnt', async () => {
    const tar = await makeTar([{ name: 'dist/rohr', type: 'fifo' }])
    await assert.rejects(extractTarSafely(tar, join(work, 'fifo'), { stripFirst: true }), /weder Datei noch Ordner/)
  })

  test('Gesamtgrösse wird beim Entpacken mitgezählt', async () => {
    const big = 'A'.repeat(4000)
    const tar = await makeTar([
      { name: 'dist/a', data: big }, { name: 'dist/b', data: big }, { name: 'dist/c', data: big },
    ])
    await assert.rejects(extractTarSafely(tar, join(work, 'big'), { stripFirst: true, limits: tight }), /überschreitet/)
  })

  test('zu viele Einträge', async () => {
    const tar = await makeTar(Array.from({ length: 12 }, (_, i) => ({ name: `dist/f${i}`, data: 'x' })))
    await assert.rejects(extractTarSafely(tar, join(work, 'many'), { stripFirst: true, limits: tight }), /Einträge/)
  })
})
