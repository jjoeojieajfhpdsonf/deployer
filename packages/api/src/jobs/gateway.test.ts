import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldWarn } from './gateway-rule.js'
import type { ClientIpReport } from '../lib/client-ips.js'

const report = (fromGateway: number): ClientIpReport => ({
  total: 10, fromGateway, gatewayIps: fromGateway ? ['172.20.0.1'] : [], gatewayOnly: false, blocked: 0,
  since: new Date(0).toISOString(), ownProbes: 0, groups: [],
} as unknown as ClientIpReport)

const now = Date.parse('2026-11-11T12:00:00Z')

test('Gateway-Warnung: nur mit Gateway-Anfragen, höchstens einmal pro Tag', () => {
  assert.equal(shouldWarn(null, null, now), false)
  assert.equal(shouldWarn(report(0), null, now), false)
  assert.equal(shouldWarn(report(3), null, now), true)
  assert.equal(shouldWarn(report(3), new Date(now - 2 * 60 * 60_000).toISOString(), now), false)
  assert.equal(shouldWarn(report(3), new Date(now - 25 * 60 * 60_000).toISOString(), now), true)
  // Kaputter Zeitstempel zählt wie «nie gemeldet»
  assert.equal(shouldWarn(report(3), 'kaputt', now), true)
})
