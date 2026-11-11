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
    assert.equal(titleFor('Wetterstation', [{ kind: 'deploy' }]), 'Deploy läuft · Wetterstation · Airlock')
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

  test('Deploy lädt Projekte, Deployments und die Deploy-Abfrage', () => {
    const ks = affected({ type: 'deploy', deploymentId: 'd1', status: 'healthchecking' })
    assert.ok(ks !== 'all')
    const flat = (ks as unknown[][]).map((k) => JSON.stringify(k))
    for (const k of [['projects'], ['project'], ['deployments'], ['deployment', 'd1']]) assert.ok(flat.includes(JSON.stringify(k)), JSON.stringify(k))
  })

  test('Scan, Zertifikat, Container-Wechsel gezielt; Audit lädt alles Sichtbare', () => {
    assert.ok((affected({ type: 'scan', projectId: 'p1' }) as unknown[][]).some((k) => k[0] === 'scan'))
    assert.deepEqual((affected({ type: 'cert' }) as unknown[][])[0], ['cloudflare'])
    assert.ok((affected({ type: 'project', projectId: 'p1' }) as unknown[][]).some((k) => k[0] === 'project' && k[1] === 'p1'))
    assert.equal(affected({ type: 'audit', action: 'project.deploy', targetType: 'project', targetId: 'p1' }), 'all')
  })
})
