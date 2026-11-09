import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planTlsStart, mayOrderProduction, prodCertUsable, nextProdAttemptAt, PROD_RETRY_MS, type ProdState } from './tls-plan.js'

const now = new Date('2026-11-09T21:30:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString()
const cert = (validTo: string): ProdState['prodCert'] => ({ validTo, issuer: "Let's Encrypt – YE2", seenAt: ago(20), source: 'probe', trusted: false })

describe('Rate-Limit-Schutz: «Nochmals versuchen»', () => {
  test('nichts bisher: normaler Probelauf', () => {
    assert.deepEqual(planTlsStart({}, now), { kind: 'staging' })
    assert.deepEqual(mayOrderProduction({}, now), { ok: true, reuse: false })
  })

  test('gültiges produktives Zertifikat im Speicher: wiederverwenden, nicht neu bestellen – auch kurz nach einem Versuch', () => {
    const s: ProdState = { prodAttemptAt: ago(5), prodCert: cert(inDays(89)) }
    assert.equal(prodCertUsable(s, now), true)
    assert.deepEqual(planTlsStart(s, now), { kind: 'reuse' })
    assert.deepEqual(mayOrderProduction(s, now), { ok: true, reuse: true })
    assert.equal(nextProdAttemptAt(s, now), null)
  })

  test('produktiver Versuch vor 20 Minuten, kein Zertifikat: warten bis eine Stunde nach dem Versuch', () => {
    const s: ProdState = { prodAttemptAt: ago(20) }
    const plan = planTlsStart(s, now)
    assert.equal(plan.kind, 'wait')
    assert.equal((plan as { until: Date }).until.toISOString(), new Date(Date.parse(ago(20)) + PROD_RETRY_MS).toISOString())
    assert.equal(mayOrderProduction(s, now).ok, false)
  })

  test('nach einer Stunde wieder erlaubt', () => {
    const s: ProdState = { prodAttemptAt: ago(61) }
    assert.deepEqual(planTlsStart(s, now), { kind: 'staging' })
    assert.deepEqual(mayOrderProduction(s, now), { ok: true, reuse: false })
  })

  test('Zertifikat fast abgelaufen (< 7 Tage) zählt nicht als vorhanden', () => {
    const s: ProdState = { prodAttemptAt: ago(10), prodCert: cert(inDays(3)) }
    assert.equal(prodCertUsable(s, now), false)
    assert.equal(planTlsStart(s, now).kind, 'wait')
  })
})
