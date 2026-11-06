import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tarStream from 'tar-stream'

process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { packDir } = await import('./workdir.js')

let root: string

async function names(dir: string, o: Parameters<typeof packDir>[1]): Promise<string[]> {
  const extract = tarStream.extract()
  const out: string[] = []
  extract.on('entry', (h, s, next) => {
    if (h.type === 'file') out.push(h.name)
    s.resume()
    s.on('end', next)
  })
  const done = new Promise<void>((r) => extract.on('finish', () => r()))
  ;(await packDir(dir, o)).pipe(extract)
  await done
  return out.sort()
}

function tree(name: string, files: Record<string, string>): string {
  const d = join(root, name)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), c)
  }
  return d
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'deployer-pack-'))
})
after(() => rmSync(root, { recursive: true, force: true }))

describe('packDir mit .dockerignore (REVIEW)', () => {
  test('.git kommt nie mit', async () => {
    const d = tree('a', { 'index.js': 'x', '.git/HEAD': 'ref' })
    assert.deepEqual(await names(d, {}), ['index.js'])
  })

  test('eigener Dockerfile-Pfad kommt mit, auch wenn sein Ordner ausgeschlossen ist', async () => {
    const d = tree('b', { 'docker/prod.Dockerfile': 'FROM x', 'docker/notes.md': 'n', '.dockerignore': 'docker/\n', 'app.js': 'a' })
    const n = await names(d, { dockerignore: true, alwaysInclude: ['docker/prod.Dockerfile'] })
    assert.ok(n.includes('docker/prod.Dockerfile'), n.join(','))
    assert.ok(!n.includes('docker/notes.md'), 'der Rest des Ordners bleibt draussen')
  })

  test('Erlaubnis-Muster: "*" und "!src" schickt src mit', async () => {
    const d = tree('c', { 'src/a.js': 'a', 'src/sub/b.js': 'b', 'secrets/key': 'k', 'Dockerfile': 'FROM x', '.dockerignore': '*\n!src\n!Dockerfile\n' })
    const n = await names(d, { dockerignore: true, alwaysInclude: ['Dockerfile'] })
    assert.ok(n.includes('src/a.js') && n.includes('src/sub/b.js'), n.join(','))
    assert.ok(!n.includes('secrets/key'))
    assert.ok(n.includes('Dockerfile'))
  })

  test('ohne Ausnahmen wird ein ausgeschlossener Ordner ganz übersprungen', async () => {
    const d = tree('d', { 'node_modules/x/index.js': 'x', 'app.js': 'a', '.dockerignore': 'node_modules\n' })
    assert.deepEqual(await names(d, { dockerignore: true }), ['.dockerignore', 'app.js'])
  })

  test('Präfix für den Build-Container', async () => {
    const d = tree('e', { 'package.json': '{}' })
    assert.deepEqual(await names(d, { prefix: 'work' }), ['work/package.json'])
  })
})
