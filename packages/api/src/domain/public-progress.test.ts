import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Progress, stepsFor, withProgress, progressOf, isRunning } from './public-progress.js'

describe('Schritte je Übergang', () => {
  test('veröffentlichen: Access nur, wenn gewählt', () => {
    assert.deepEqual(stepsFor('publish'), ['check', 'dns', 'tunnel', 'caddy', 'outside'])
    assert.deepEqual(stepsFor('publish', { access: true }), ['check', 'dns', 'access', 'tunnel', 'caddy', 'outside'])
  })
  test('pausieren fasst DNS und Tunnel nicht an', () => {
    assert.ok(!stepsFor('pause').includes('dns'))
    assert.ok(!stepsFor('pause').includes('tunnel'))
  })
  test('ganz offline entfernt Tunnel-Regel und DNS', () => {
    const p = new Progress('unpublish', 'a.example.ch', stepsFor('unpublish'))
    assert.deepEqual(p.dto.steps.map((s) => s.label).slice(0, 3), ['DNS-Eintrag entfernen', 'Access-App entfernen', 'Tunnel-Regel entfernen'])
  })
})

describe('Fortschritt', () => {
  test('start schliesst den vorigen Schritt ab, finish den Rest', () => {
    const p = new Progress('publish', null, stepsFor('publish'))
    p.start('check')
    p.start('dns')
    assert.deepEqual(p.dto.steps.slice(0, 2).map((s) => s.state), ['done', 'current'])
    p.finish(false, 'Cloudflare: 403')
    assert.equal(p.dto.steps[1]!.state, 'failed')
    assert.equal(p.dto.steps[1]!.detail, 'Cloudflare: 403')
    assert.equal(p.dto.steps.at(-1)!.state, 'skipped')
    assert.equal(p.dto.ok, false)
  })
  test('eine Warnung bleibt beim Abschluss stehen', () => {
    const p = new Progress('pause', 'a.example.ch', stepsFor('pause'))
    p.start('caddy')
    p.start('outside')
    p.set('outside', 'warn', 'noch nicht')
    p.finish(true)
    assert.deepEqual(p.dto.steps.map((s) => s.state), ['done', 'warn'])
  })
  test('ein zweiter Übergang für dasselbe Projekt scheitert sofort', async () => {
    let release!: () => void
    const first = withProgress('p1', 'pause', 'a', stepsFor('pause'), () => new Promise<void>((r) => (release = r)), () => new Error('busy'))
    assert.equal(isRunning('p1'), true)
    await assert.rejects(withProgress('p1', 'resume', 'a', stepsFor('resume'), async () => {}, () => new Error('busy')), /busy/)
    release()
    await first
    assert.equal(isRunning('p1'), false)
    assert.equal(progressOf('p1')?.ok, true)
  })
})
