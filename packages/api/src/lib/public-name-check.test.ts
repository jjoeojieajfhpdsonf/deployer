import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shapePublicName, markTaken, markForeignRecord, blockingProblems } from './public-name-check.js'

const facts = { zones: ['example.ch', 'example.dev'], mainZone: 'example.ch', baseDomain: 'int.example.ch' }
const kinds = (c: { problems: { kind: string }[] }) => c.problems.map((p) => p.kind)

describe('Prüfung öffentlicher Namen (Veröffentlichung, Neues Projekt, MCP)', () => {
  test('frei: Hauptzone als Standard, Name normalisiert', () => {
    const c = shapePublicName({ label: 'Mein Shop' }, facts)
    assert.equal(c.host, 'mein-shop.example.ch')
    assert.equal(c.zone, 'example.ch')
    assert.deepEqual(c.problems, [])
  })

  test('andere Zone der Umgebung; fremde Zone wird abgelehnt', () => {
    assert.equal(shapePublicName({ label: 'solar', zone: 'example.dev' }, facts).host, 'solar.example.dev')
    const c = shapePublicName({ label: 'solar', zone: 'andere.ch' }, facts)
    assert.equal(c.host, null)
    assert.deepEqual(kinds(c), ['zone'])
  })

  test('reserviert: int, deployer, airlock, acme-probe', () => {
    for (const l of ['int', 'deployer', 'airlock', 'acme-probe']) assert.equal(kinds(shapePublicName({ label: l }, facts))[0], 'reserved', l)
    // int.example.ch ist zugleich die interne Basis
    assert.deepEqual(kinds(shapePublicName({ label: 'int' }, facts)), ['reserved', 'internal'])
  })

  test('leer und unter der internen Basis', () => {
    assert.deepEqual(kinds(shapePublicName({ label: '  ' }, facts)), ['format'])
    const internal = shapePublicName({ label: 'x' }, { ...facts, mainZone: 'int.example.ch', zones: ['int.example.ch'] })
    assert.deepEqual(kinds(internal), ['internal'])
  })

  test('apex nur ausdrücklich; der Name zählt dann nicht', () => {
    const c = shapePublicName({ label: 'egal', apex: true, zone: 'example.dev' }, facts)
    assert.equal(c.host, 'example.dev')
    assert.equal(c.label, '')
    assert.equal(c.apex, true)
  })

  test('vergeben in Airlock', () => {
    const c = shapePublicName({ label: 'solar' }, facts)
    markTaken(c, true)
    assert.deepEqual(kinds(c), ['taken'])
    assert.match(c.problems[0]!.message, /solar\.example\.ch ist in Airlock schon vergeben/)
  })

  test('fremder DNS-Eintrag mit Typ und Ziel; ersetzbar nur mit Bestätigung', () => {
    const c = shapePublicName({ label: 'solar' }, facts)
    markForeignRecord(c, [{ type: 'TXT', content: 'x', managed: false }, { type: 'CNAME', content: 'alt.example.net', managed: false }])
    assert.deepEqual(c.existing, { type: 'CNAME', content: 'alt.example.net', worker: false })
    assert.match(c.problems[0]!.message, /CNAME → alt\.example\.net/)
    assert.equal(blockingProblems(c, false).length, 1)
    assert.equal(blockingProblems(c, true).length, 0)
  })

  test('eigener Eintrag von Airlock ist kein Problem', () => {
    const c = shapePublicName({ label: 'solar' }, facts)
    markForeignRecord(c, [{ type: 'CNAME', content: 'tunnel.cfargotunnel.com', managed: true }])
    assert.equal(c.existing, null)
    assert.deepEqual(c.problems, [])
  })

  test('Worker bzw. Custom Domain (auch apex): nie ersetzbar', () => {
    const c = shapePublicName({ label: '', apex: true }, facts)
    markForeignRecord(c, [{ type: 'AAAA', content: '100::', managed: false }])
    assert.equal(c.existing?.worker, true)
    assert.match(c.problems[0]!.message, /Worker bzw\. eine Custom Domain/)
    assert.equal(blockingProblems(c, true).length, 1)
  })
})
