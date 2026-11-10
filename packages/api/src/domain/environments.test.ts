import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgres://test@127.0.0.1:1/test'
process.env.ADMIN_PASSWORD ??= 'test'
const { baseDomainOf, splitBaseDomain, namesForZone } = await import('./environments.js')

test('baseDomainOf: Präfix + Zone, leeres Präfix ist die Zone selbst', () => {
  assert.equal(baseDomainOf('jherren.com', 'int'), 'int.jherren.com')
  assert.equal(baseDomainOf('jherren.com', ''), 'jherren.com')
  assert.equal(baseDomainOf('jherren.com', '.int.'), 'int.jherren.com')
  assert.equal(baseDomainOf(null, 'int'), null)
})

test('splitBaseDomain: bekannte Zone gewinnt, längste zuerst', () => {
  assert.deepEqual(splitBaseDomain('int.jherren.com', ['jherren.com', 'example.ch']), { zone: 'jherren.com', prefix: 'int' })
  assert.deepEqual(splitBaseDomain('int.home.example.ch', ['example.ch', 'home.example.ch']), { zone: 'home.example.ch', prefix: 'int' })
  assert.deepEqual(splitBaseDomain('a.b.example.ch', ['example.ch']), { zone: 'example.ch', prefix: 'a.b' })
  assert.deepEqual(splitBaseDomain('example.ch', ['example.ch']), { zone: 'example.ch', prefix: '' })
  assert.deepEqual(splitBaseDomain('INT.Jherren.COM', ['jherren.com']), { zone: 'jherren.com', prefix: 'int' })
})

test('splitBaseDomain: ohne bekannte Zone ist das erste Label das Präfix', () => {
  assert.deepEqual(splitBaseDomain('int.jherren.com', []), { zone: 'jherren.com', prefix: 'int' })
  // «example.ch» allein: keine Zone «ch» annehmen
  assert.deepEqual(splitBaseDomain('example.ch', []), { zone: 'example.ch', prefix: '' })
})

test('namesForZone: Name, Slug und Kürzel aus der Hauptzone', () => {
  assert.deepEqual(namesForZone('jherren.com'), { name: 'jherren.com', slug: 'jherren', short: 'JH' })
  assert.deepEqual(namesForZone('verein-beispiel.ch'), { name: 'verein-beispiel.ch', slug: 'verein-beispiel', short: 'VE' })
  assert.deepEqual(namesForZone('x.dev'), { name: 'x.dev', slug: 'x', short: 'X' })
})
