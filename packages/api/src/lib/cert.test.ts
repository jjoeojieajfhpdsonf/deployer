import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { certProblem, probeCert, daysLeftOf, WARN_DAYS, type CertInfo } from './cert.js'

const base: CertInfo = { ok: true, subject: '*.int.example.ch', issuer: "Let's Encrypt – R11", validTo: null, daysLeft: 60, error: null }

describe('certProblem', () => {
  test('gültig und lange genug: kein Problem', () => {
    assert.equal(certProblem(base), null)
  })
  test(`weniger als ${WARN_DAYS} Tage: Warnung`, () => {
    assert.match(certProblem({ ...base, daysLeft: 13 })!, /13 Tagen/)
    assert.equal(certProblem({ ...base, daysLeft: 14 }), null)
  })
  test('ungültig: Problem mit Grund', () => {
    assert.match(certProblem({ ...base, ok: false, error: 'self-signed certificate' })!, /self-signed/)
  })
  test('Tage aus validTo berechnet', () => {
    const now = new Date('2026-11-07T00:00:00Z')
    assert.match(certProblem({ ...base, daysLeft: null, validTo: '2026-11-10T00:00:00Z' }, now)!, /3 Tagen/)
  })
})

describe('probeCert', () => {
  test('liest ein selbst signiertes Zertifikat als ungültig, mit Ablaufdatum', async (t) => {
    let have = true
    try { execFileSync('openssl', ['version']) } catch { have = false }
    if (!have) return t.skip('openssl fehlt')
    const dir = mkdtempSync(join(tmpdir(), 'cert-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '5', '-subj', '/CN=deployer.int.example.ch',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
      const srv = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (s) => s.end())
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      const info = await probeCert('127.0.0.1', (srv.address() as AddressInfo).port, 'deployer.int.example.ch')
      srv.close()
      assert.equal(info.ok, false)
      assert.equal(info.subject, 'deployer.int.example.ch')
      assert.ok(info.daysLeft !== null && info.daysLeft <= 5)
      assert.ok(certProblem(info))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('nichts lauscht: Fehler statt Absturz', async () => {
    const info = await probeCert('127.0.0.1', 1, 'x', 1000)
    assert.equal(info.ok, false)
    assert.ok(info.error)
  })
})

describe('Review M4', () => {
  const now = new Date('2026-11-07T00:00:00Z')
  test('Staging: nicht vertrauenswürdige Kette der Staging-CA ist kein Problem, Ablauf schon', () => {
    const st: CertInfo = { ok: false, subject: '*.int.example.ch', issuer: "(STAGING) Let's Encrypt – (STAGING) Ersatz R11", validTo: '2027-01-30T00:00:00Z', daysLeft: null, error: 'unable to get local issuer certificate' }
    assert.equal(certProblem(st, now, { staging: true }), null)
    assert.ok(certProblem(st, now), 'ohne staging-Flag ist es ein Problem')
    assert.match(certProblem({ ...st, validTo: '2026-11-10T00:00:00Z' }, now, { staging: true })!, /3 Tagen/)
  })
  test('Staging-Flag entschuldigt kein beliebiges selbst signiertes Zertifikat', () => {
    const self: CertInfo = { ok: false, subject: 'localhost', issuer: 'Caddy Local Authority', validTo: '2027-01-30T00:00:00Z', daysLeft: 80, error: 'self-signed certificate' }
    assert.ok(certProblem(self, now, { staging: true }))
  })
  test('certProblem verändert sein Argument nicht', () => {
    const c: CertInfo = { ...base, daysLeft: null, validTo: '2026-11-10T00:00:00Z' }
    certProblem(c, now)
    assert.equal(c.daysLeft, null)
    assert.equal(daysLeftOf(c, now), 3)
  })
})
