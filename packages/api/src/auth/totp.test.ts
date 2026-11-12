import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, totpStep, verifyTotp, formatSecret } from './totp.js'

/** RFC 6238, Anhang B: Geheimnis "12345678901234567890" (ASCII), SHA-1, 8 Ziffern */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('TOTP (RFC 6238)', () => {
  for (const [t, code] of RFC_VECTORS) {
    test(`Testvektor T=${t}`, () => assert.equal(totpAt(RFC_SECRET, t * 1000, 8), code))
  }

  test('HOTP nach RFC 4226, Anhang D', () => {
    const secret = Buffer.from('12345678901234567890')
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
    expected.forEach((c, i) => assert.equal(hotp(secret, i), c))
  })

  test('Base32 hin und zurück, Kleinbuchstaben und Leerzeichen egal', () => {
    const raw = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7])
    const enc = base32Encode(raw)
    assert.deepEqual(base32Decode(enc), raw)
    assert.deepEqual(base32Decode(formatSecret(enc).toLowerCase()), raw)
    assert.throws(() => base32Decode('abc1'), /Ungültiges Zeichen/)
  })

  test('neues Geheimnis: 160 Bit, 32 Zeichen Base32', () => {
    const s = generateTotpSecret()
    assert.match(s, /^[A-Z2-7]{32}$/)
    assert.equal(base32Decode(s).length, 20)
    assert.notEqual(generateTotpSecret(), s)
  })

  test('±1 Zeitfenster: 30 s davor und danach gelten, 60 s nicht', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    const step = totpStep(now)
    assert.equal(verifyTotp(secret, totpAt(secret, now), now), step)
    assert.equal(verifyTotp(secret, totpAt(secret, now - 30_000), now), step - 1)
    assert.equal(verifyTotp(secret, totpAt(secret, now + 30_000), now), step + 1)
    assert.equal(verifyTotp(secret, totpAt(secret, now - 60_000), now), null)
    assert.equal(verifyTotp(secret, totpAt(secret, now + 60_000), now), null)
  })

  test('falsche Form wird abgelehnt', () => {
    const secret = generateTotpSecret()
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) assert.equal(verifyTotp(secret, bad, Date.now()), null, bad)
  })

  test('otpauth-Adresse für die App', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Airlock', account: 'Joël (deployer.int.example.ch)' }) // allowlist-secret (Testwert)
    assert.match(uri, /^otpauth:\/\/totp\/Airlock%3AJo%C3%ABl%20\(deployer\.int\.example\.ch\)\?/)
    const q = new URL(uri.replace('otpauth://', 'http://x/')).searchParams
    assert.equal(q.get('secret'), 'JBSWY3DPEHPK3PXP') // allowlist-secret (Testwert)
    assert.equal(q.get('issuer'), 'Airlock')
    assert.equal(q.get('digits'), '6')
    assert.equal(q.get('period'), '30')
  })
})
