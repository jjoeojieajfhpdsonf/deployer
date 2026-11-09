import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { certProblem, probeCert, daysLeftOf, checkIssuedCert, nameCovers, WARN_DAYS, type CertInfo } from './cert.js'

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

/* --- Staging ohne Trust-Prüfung, Produktion voll ---------------------------- */

const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version']); return true } catch { return false }
})()

/** Selbst signiertes Zertifikat, Aussteller «(STAGING) Let's Encrypt» wie bei der Staging-CA. */
async function serveSelfSigned(subj: string, san: string, days: number, fn: (port: number) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', subj,
      '-addext', `subjectAltName=${san}`, '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
    const srv = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (s) => s.end())
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      await fn((srv.address() as AddressInfo).port)
    } finally {
      srv.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('checkIssuedCert mit echtem TLS-Server (selbst signiertes «Staging»-Zertifikat)', () => {
  const BASE = 'int.jherren.com'

  test('Staging: erkannt ohne Trust-Prüfung (Aussteller, SAN, Gültigkeit); Produktion: nicht', async (t) => {
    if (!hasOpenssl) return t.skip('openssl fehlt')
    await serveSelfSigned(`/O=(STAGING) Let's Encrypt/CN=*.${BASE}`, `DNS:*.${BASE}`, 80, async (port) => {
      const c = await probeCert('127.0.0.1', port, `deployer.${BASE}`)
      assert.equal(c.ok, false, 'Kette ist nicht vertrauenswürdig')
      assert.deepEqual(c.sans, [`*.${BASE}`])
      assert.ok(c.validFrom && c.validTo)
      assert.deepEqual(checkIssuedCert(c, { base: BASE, phase: 'staging' }), { ready: true })
      const prod = checkIssuedCert(c, { base: BASE, phase: 'production' })
      assert.equal(prod.ready, false)
      assert.match((prod as { reason: string }).reason, /Staging/)
    })
  })

  test('Staging: falscher Name wird nicht akzeptiert', async (t) => {
    if (!hasOpenssl) return t.skip('openssl fehlt')
    await serveSelfSigned("/O=(STAGING) Let's Encrypt/CN=*.anders.ch", 'DNS:*.anders.ch', 80, async (port) => {
      const v = checkIssuedCert(await probeCert('127.0.0.1', port, `deployer.${BASE}`), { base: BASE, phase: 'staging' })
      assert.equal(v.ready, false)
      assert.match((v as { reason: string }).reason, /nicht für \*\.int\.jherren\.com/)
    })
  })

  test('Staging: beliebiges selbst signiertes Zertifikat (nicht Staging-CA) zählt nicht', async (t) => {
    if (!hasOpenssl) return t.skip('openssl fehlt')
    await serveSelfSigned(`/O=Irgendwer/CN=*.${BASE}`, `DNS:*.${BASE}`, 80, async (port) => {
      const v = checkIssuedCert(await probeCert('127.0.0.1', port, `deployer.${BASE}`), { base: BASE, phase: 'staging' })
      assert.equal(v.ready, false)
      assert.match((v as { reason: string }).reason, /nicht die Staging-CA/)
    })
  })

  test('kein Server: Grund statt Absturz', async () => {
    const v = checkIssuedCert(await probeCert('127.0.0.1', 1, `deployer.${BASE}`, 1000), { base: BASE, phase: 'staging' })
    assert.equal(v.ready, false)
  })

  test('Produktion: vertrauenswürdig, richtiger Name, gültig → bereit', () => {
    const now = new Date('2026-11-09T00:00:00Z')
    const c: CertInfo = { ok: true, subject: `*.${BASE}`, issuer: "Let's Encrypt – R12", validTo: '2027-02-07T00:00:00Z', validFrom: '2026-11-09T00:00:00Z', daysLeft: 90, error: null, sans: [`*.${BASE}`] }
    assert.deepEqual(checkIssuedCert(c, { base: BASE, phase: 'production', now }), { ready: true })
    const untrusted = checkIssuedCert({ ...c, ok: false, error: 'unable to get local issuer certificate' }, { base: BASE, phase: 'production', now })
    assert.match((untrusted as { reason: string }).reason, /nicht vertrauenswürdig/)
    const expired = checkIssuedCert(c, { base: BASE, phase: 'production', now: new Date('2027-03-01T00:00:00Z') })
    assert.match((expired as { reason: string }).reason, /abgelaufen/)
    const caddyOwn = checkIssuedCert({ ...c, issuer: 'Caddy Local Authority - ECC Intermediate' }, { base: BASE, phase: 'staging', now })
    assert.match((caddyOwn as { reason: string }).reason, /eigenes Zertifikat/)
  })

  test('nameCovers: eine Ebene unter der Wildcard', () => {
    assert.equal(nameCovers(`*.${BASE}`, `deployer.${BASE}`), true)
    assert.equal(nameCovers(`*.${BASE}`, `a.b.${BASE}`), false)
    assert.equal(nameCovers(`*.${BASE}`, BASE), false)
    assert.equal(nameCovers('deployer.x.ch', 'DEPLOYER.x.ch'), true)
  })
})
