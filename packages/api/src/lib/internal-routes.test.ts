import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { internalServiceRoutes, type InternalRouteRow } from './internal-routes.js'

/** Etappe 4: interne Adressen für Adminer & Co. – nur intern, nie öffentlich */

const row = (o: Partial<InternalRouteRow>): InternalRouteRow => ({
  projectId: 'p1', slug: 'shop', target: 'lan', paused: false, sourceType: 'compose', deploymentId: 'd1',
  internalRoutes: [{ service: 'adminer', port: 8080 }], ...o,
})
const opts = (taken: string[] = []) => ({
  hostFor: (_p: string, label: string) => `${label}.int.example.ch`,
  containerFor: (slug: string, svc: string) => `air_${slug}-${svc}-1`,
  taken: new Set(taken),
})

describe('Interne Adressen von Diensten', () => {
  test('folgt den internen Wegen des Projekts', () => {
    const r = internalServiceRoutes([row({ target: 'lan' }), row({ target: 'tailnet' })], opts())
    assert.deepEqual(r, [{ projectId: 'p1', service: 'adminer', hostname: 'adminer--shop.int.example.ch', targets: ['lan', 'tailnet'], upstream: 'air_shop-adminer-1:8080' }])
  })

  test('öffentliches Projekt ohne internen Weg: keine Adresse (nie über den Tunnel)', () => {
    assert.deepEqual(internalServiceRoutes([row({ target: 'public' })], opts()), [])
  })

  test('öffentlich und LAN: nur LAN, nie public', () => {
    const r = internalServiceRoutes([row({ target: 'public' }), row({ target: 'lan' })], opts())
    assert.deepEqual(r.map((x) => x.targets), [['lan']])
  })

  test('pausiert, ohne Fassung oder kein Compose: keine Adresse', () => {
    assert.deepEqual(internalServiceRoutes([row({ paused: true })], opts()), [])
    assert.deepEqual(internalServiceRoutes([row({ deploymentId: null })], opts()), [])
    assert.deepEqual(internalServiceRoutes([row({ sourceType: 'image' })], opts()), [])
  })

  test('belegter Name und zu langes Label werden ausgelassen', () => {
    assert.deepEqual(internalServiceRoutes([row({})], opts(['adminer--shop.int.example.ch'])), [])
    assert.deepEqual(internalServiceRoutes([row({ slug: 'x'.repeat(60) })], opts()), [])
  })
})
