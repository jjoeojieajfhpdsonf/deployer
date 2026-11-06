import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Nur die reinen Hilfsfunktionen; build-container.ts zieht config.ts nach,
// deshalb Umgebung für den Import setzen.
process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { outputPathInContainer } = await import('./build-container.js')
const { staticVersionHash } = await import('./sources/static.js')

describe('outputPathInContainer (REVIEW: versteckte Ordner)', () => {
  test('übliche Fälle', () => {
    assert.equal(outputPathInContainer('dist'), '/work/dist')
    assert.equal(outputPathInContainer('./dist'), '/work/dist')
    assert.equal(outputPathInContainer('dist/'), '/work/dist')
    assert.equal(outputPathInContainer('.'), '/work')
    assert.equal(outputPathInContainer('./'), '/work')
  })
  test('der Punkt versteckter Ordner bleibt', () => {
    assert.equal(outputPathInContainer('.output/public'), '/work/.output/public')
    assert.equal(outputPathInContainer('.vitepress/dist'), '/work/.vitepress/dist')
    assert.equal(outputPathInContainer('./.output/public'), '/work/.output/public')
  })
})

describe('staticVersionHash (REVIEW: Env gehört zur Fassung)', () => {
  const base = { commit: 'a'.repeat(40), buildCommand: 'npm run build', outputDir: 'dist' }
  test('gleiche Eingaben ergeben dieselbe Fassung', () => {
    assert.equal(staticVersionHash({ ...base, env: { A: '1' } }), staticVersionHash({ ...base, env: { A: '1' } }))
  })
  test('geänderte Env ergibt eine neue Fassung (sonst bliebe der alte Build)', () => {
    assert.notEqual(
      staticVersionHash({ ...base, env: { VITE_API_URL: 'https://alt' } }),
      staticVersionHash({ ...base, env: { VITE_API_URL: 'https://neu' } }),
    )
  })
  test('Reihenfolge der Env spielt keine Rolle', () => {
    assert.equal(staticVersionHash({ ...base, env: { A: '1', B: '2' } }), staticVersionHash({ ...base, env: { B: '2', A: '1' } }))
  })
  test('ohne Build zählt die Env nicht', () => {
    const nb = { ...base, buildCommand: undefined, outputDir: '.' }
    assert.equal(staticVersionHash({ ...nb, env: { A: '1' } }), staticVersionHash({ ...nb, env: { A: '2' } }))
  })
})
