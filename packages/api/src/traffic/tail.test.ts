import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogTail } from './tail.js'

const dirs: string[] = []
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'airlock-tail-'))
  dirs.push(dir)
  return { dir, file: join(dir, 'visits.log') }
}

describe('Besucher: Log fortlaufend lesen', () => {
  test('ohne Datei nichts; danach nur ganze Zeilen, halbe später', async () => {
    const { file } = await setup()
    const t = new LogTail(file)
    assert.equal(await t.exists(), false)
    assert.deepEqual(await t.poll(), [])
    await writeFile(file, 'a\nb\nhal')
    assert.deepEqual(await t.poll(), ['a', 'b'])
    await appendFile(file, 'b\n')
    assert.deepEqual(await t.poll(), ['halb'])
    assert.deepEqual(await t.poll(), [])
  })

  test('Rotation: Rest der alten Datei, dann die neue von vorn', async () => {
    const { dir, file } = await setup()
    await writeFile(file, 'eins\n')
    const t = new LogTail(file)
    assert.deepEqual(await t.poll(), ['eins'])
    await appendFile(file, 'zwei\n')
    // lumberjack: umbenennen, neue Datei
    await rename(file, join(dir, 'visits-2026-11-11T14-30-00.000.log'))
    await writeFile(file, 'drei\n')
    assert.deepEqual(await t.poll(), ['zwei', 'drei'])
  })

  test('Neustart: gespeicherte Position, nichts doppelt', async () => {
    const { file } = await setup()
    await writeFile(file, 'eins\nzwei\n')
    const a = new LogTail(file)
    await a.poll()
    await appendFile(file, 'drei\n')
    const b = new LogTail(file, a.position)
    assert.deepEqual(await b.poll(), ['drei'])
  })

  test('gekürzte Datei: von vorn', async () => {
    const { file } = await setup()
    await writeFile(file, 'eins\nzwei\n')
    const t = new LogTail(file)
    await t.poll()
    await truncate(file, 0)
    await appendFile(file, 'neu\n')
    assert.deepEqual(await t.poll(), ['neu'])
  })
})
