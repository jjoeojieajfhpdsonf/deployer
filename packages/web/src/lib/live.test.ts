import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { affected, poll, FALLBACK_MS } from './live.js'
import { faviconSvg, titleFor } from './title.js'

describe('UI-Qualität 3: Tab-Titel und Favicon', () => {
  test('«<Seite> · Airlock», ohne Seite nur «Airlock»', () => {
    assert.equal(titleFor('Wetterstation', []), 'Wetterstation · Airlock')
    assert.equal(titleFor(null, []), 'Airlock')
  })

  test('laufender Vorgang als Präfix, mehrere als Anzahl', () => {
    assert.equal(titleFor('Wetterstation', [{ kind: 'deploy', projectName: 'Wetterstation' }]), 'Deploy läuft · Wetterstation · Airlock')
    // Vorgang eines anderen Projekts: mit Namen
    assert.equal(titleFor('Fotoalbum', [{ kind: 'deploy', projectName: 'Rezepte-API' }]), 'Deploy Rezepte-API läuft · Fotoalbum · Airlock')
    assert.equal(titleFor('System', [{ kind: 'cert' }]), 'Zertifikat wird geholt · System · Airlock')
    assert.equal(titleFor('Projekte', [{ kind: 'scan' }, { kind: 'deploy' }]), '2 Vorgänge laufen · Projekte · Airlock')
  })

  test('Favicon: Punkt nur bei Alarm, beide als SVG-Daten-URL', () => {
    assert.ok(faviconSvg(true).startsWith('data:image/svg+xml,'))
    assert.ok(decodeURIComponent(faviconSvg(true)).includes('<circle'))
    assert.ok(!decodeURIComponent(faviconSvg(false)).includes('<circle'))
  })
})

describe('UI-Qualität 3: Ereignisse → was neu geladen wird', () => {
  test('ohne Strom 60 s Polling (Start: getrennt)', () => {
    assert.equal(poll(), FALLBACK_MS)
  })

  const has = (ks: unknown[][], k: unknown[]) => ks.some((x) => JSON.stringify(x) === JSON.stringify(k))

  test('Deploy lädt Liste und genau dieses Projekt (nicht alle Projekte)', () => {
    const ks = affected({ type: 'deploy', deploymentId: 'd1', status: 'healthchecking', projectId: 'p1' })
    for (const k of [['projects'], ['project', 'p1'], ['deployments', 'p1'], ['deployment', 'd1'], ['health', 'p1']]) assert.ok(has(ks, k), JSON.stringify(k))
    assert.ok(!has(ks, ['project']) && !has(ks, ['health']), 'nicht alle Projekte')
    assert.ok(!has(ks, ['audit']), 'Aktivität erst am Ende')
    assert.ok(has(affected({ type: 'deploy', deploymentId: 'd1', status: 'failed', projectId: 'p1' }), ['audit']))
  })

  test('Scan-Stufe nur die Scan-Ansicht; Start und Ende auch Liste und Warteschlange', () => {
    assert.deepEqual(affected({ type: 'scan', phase: 'stage', projectId: 'p1' }), [['scan', 'p1']])
    const end = affected({ type: 'scan', phase: 'end', projectId: 'p1' })
    for (const k of [['scan', 'p1'], ['projects'], ['system'], ['project', 'p1']]) assert.ok(has(end, k), JSON.stringify(k))
  })

  test('Audit gezielt nach Ziel, nie «alles»; Zertifikat, Öffentlich, Container-Wechsel', () => {
    const p = affected({ type: 'audit', action: 'header.set', targetType: 'project', targetId: 'p1' })
    assert.ok(has(p, ['header-rules', 'p1']) && has(p, ['audit']) && !has(p, ['cloudflare']))
    assert.ok(has(affected({ type: 'audit', action: 'token.create', targetType: 'token', targetId: 't1' }), ['tokens']))
    assert.deepEqual(affected({ type: 'cert' })[0], ['cloudflare'])
    assert.ok(has(affected({ type: 'public', projectId: 'p1' }), ['public-progress', 'p1']))
    assert.ok(has(affected({ type: 'project', projectId: 'p1' }), ['project', 'p1']))
  })
})
