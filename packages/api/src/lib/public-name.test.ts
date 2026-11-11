import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePublicLabel, splitPublicHost } from '@airlock/shared'

test('Name normalisieren: Kleinbuchstaben, Umlaute, Bindestriche, Länge', () => {
  assert.equal(normalizePublicLabel('Mein Shop'), 'mein-shop')
  assert.equal(normalizePublicLabel('Über Grösse'), 'ueber-groesse')
  assert.equal(normalizePublicLabel('Straße  10'), 'strasse-10')
  assert.equal(normalizePublicLabel('--a__b--'), 'a-b')
  assert.equal(normalizePublicLabel('café'), 'cafe')
  assert.equal(normalizePublicLabel('a'.repeat(70)).length, 63)
  // Nach dem Kürzen kein Bindestrich am Ende
  assert.equal(normalizePublicLabel(`${'a'.repeat(62)} b`).endsWith('-'), false)
})

test('Vollen Namen zerlegen: Zone, Name, apex', () => {
  const zones = ['example.ch', 'shop.example.ch', 'verein-beispiel.ch']
  assert.deepEqual(splitPublicHost('solar.example.ch', zones), { label: 'solar', zone: 'example.ch', apex: false })
  assert.deepEqual(splitPublicHost('https://a.shop.example.ch/pfad?x=1', zones), { label: 'a', zone: 'shop.example.ch', apex: false })
  assert.deepEqual(splitPublicHost('verein-beispiel.ch', zones), { label: '', zone: 'verein-beispiel.ch', apex: true })
  assert.equal(splitPublicHost('solar.andere.ch', zones), null)
  assert.equal(splitPublicHost('solar', zones), null)
})
