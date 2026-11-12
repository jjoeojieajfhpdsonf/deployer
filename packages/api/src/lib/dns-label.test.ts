import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compositeLabel, isSafeLabel, labelPart } from './dns-label.js'
import { internalServiceLabel, internalServiceRoutes } from './internal-routes.js'
import { previewLabel, serviceLabelClash } from './previews.js'

/** Korrektur nach Nacht 2: eine Regel für <teil>--<projekt> – Vorschauen und Dienst-Adressen. */

describe('gemeinsame Label-Regel', () => {
  test('IDN: «--» an Stelle 3 und 4 ist nie ein gültiges Label', () => {
    assert.equal(isSafeLabel('db--shop'), false)
    assert.equal(isSafeLabel('xn--shop'), false)
    assert.equal(isSafeLabel('web--shop'), true)
    assert.equal(isSafeLabel('a'.repeat(64)), false)
  })

  test('Teil: wie bei Branches (klein, Umlaute, Sonderzeichen → ein Bindestrich)', () => {
    assert.equal(labelPart('Mein_Dienst.2'), 'mein-dienst-2')
    assert.equal(labelPart('Grösse'), 'groesse')
  })

  test('zu kurz für die Regel: Hash-Suffix aus dem vollen Namen, gleich bei jedem Aufruf', () => {
    const a = compositeLabel('db', 'shop', { fallback: 'dienst' })
    assert.match(a!, /^db-[0-9a-f]{6}--shop$/)
    assert.equal(compositeLabel('db', 'shop', { fallback: 'dienst' }), a)
    assert.ok(isSafeLabel(a!))
  })

  test('Projekt-Kurzname zu lang: null', () => {
    assert.equal(compositeLabel('web', 'p'.repeat(56), { fallback: 'dienst' }), null)
  })
})

describe('Dienst-Adressen nach derselben Regel wie Vorschauen', () => {
  test('zweibuchstabige Dienste («db», «s3») bekommen ein Hash-Suffix statt eines IDN-Labels', () => {
    assert.match(internalServiceLabel('db', 'shop')!, /^db-[0-9a-f]{6}--shop$/)
    assert.match(internalServiceLabel('s3', 'shop')!, /^s3-[0-9a-f]{6}--shop$/)
    assert.equal(internalServiceLabel('adminer', 'shop'), 'adminer--shop')
  })

  test('Vorschau und Dienst mit gleichem Namen ergeben dasselbe Label (gleiche Funktion)', () => {
    assert.equal(previewLabel('db', 'shop'), internalServiceLabel('db', 'shop'))
    assert.equal(previewLabel('adminer', 'shop'), internalServiceLabel('adminer', 'shop'))
  })

  test('Kollision Vorschau ↔ Dienst wird in beide Richtungen erkannt, auch mit Hash', () => {
    const svc = internalServiceLabel('db', 'shop')!
    // Vorschau weicht aus, wenn der Dienst die Adresse hat
    const pv = previewLabel('db', 'shop', (l) => l === svc)
    assert.notEqual(pv, svc)
    assert.ok(isSafeLabel(pv))
    // Neuer Dienst «db» würde eine Vorschau «db» überdecken
    assert.equal(serviceLabelClash('db', 'shop', [previewLabel('db', 'shop')]), svc)
  })

  test('Routen: Dienstname mit Unterstrich bekommt jetzt eine Adresse (bereinigt), «db» ein sicheres Label', () => {
    const routes = internalServiceRoutes([{
      projectId: 'p1', slug: 'shop', target: 'lan', paused: false, sourceType: 'compose', deploymentId: 'd1',
      internalRoutes: [{ service: 'db', port: 8080 }, { service: 'mail_pit', port: 8025 }],
    }], { hostFor: (_p, l) => `${l}.int.example.ch`, containerFor: (s, n) => `air_${s}-${n}-1`, taken: new Set() })
    assert.deepEqual(routes.map((r) => r.hostname.replace(/[0-9a-f]{6}/, 'HASH')), ['db-HASH--shop.int.example.ch', 'mail-pit--shop.int.example.ch'])
    assert.equal(routes[1]!.upstream, 'air_shop-mail_pit-1:8025')
  })
})
