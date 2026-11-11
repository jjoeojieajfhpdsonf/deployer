import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { AgeError, ageDecrypt, ageEncrypt, exportFileName, keyFingerprint, keyHexGroups, keySha256, qrRows } from './key.js'

// Kleiner Arbeitsfaktor: die Tests prüfen das Format, nicht die Härte von scrypt
const LOGN = 10
const PASS = 'eine lange Passphrase 2026' // allowlist-secret: Testwert

test('age: Export und Wiedereinlesen ergeben denselben Schlüssel (Prüfsumme)', () => {
  const key = randomBytes(32)
  const file = ageEncrypt(key, PASS, LOGN)
  const back = ageDecrypt(file, PASS)
  assert.ok(back.equals(key))
  assert.equal(keyFingerprint(back), keyFingerprint(key))
})

test('age: Kopf wie age v1 mit scrypt-Empfänger, Schlüssel nicht im Klartext', () => {
  const key = randomBytes(32)
  const file = ageEncrypt(key, PASS, 18 - 8)
  const text = file.toString('latin1')
  const lines = text.split('\n')
  assert.equal(lines[0], 'age-encryption.org/v1')
  assert.match(lines[1]!, /^-> scrypt [A-Za-z0-9+/]{22} 10$/)
  assert.match(lines[2]!, /^[A-Za-z0-9+/]{43}$/)
  assert.match(lines[3]!, /^--- [A-Za-z0-9+/]{43}$/)
  assert.ok(!file.includes(key))
  assert.ok(!text.includes(key.toString('base64')) && !text.includes(key.toString('hex')))
  // Nutzlast: 16 Byte Nonce + 32 Byte + 16 Byte Tag
  const headLen = lines.slice(0, 4).join('\n').length + 1
  assert.equal(file.length - headLen, 16 + 32 + 16)
})

test('age: zwei Exporte desselben Schlüssels sind verschieden (Salz, Nonce)', () => {
  const key = randomBytes(32)
  assert.ok(!ageEncrypt(key, PASS, LOGN).equals(ageEncrypt(key, PASS, LOGN)))
})

test('age: falsche Passphrase, veränderter Kopf, abgeschnittene Datei', () => {
  const key = randomBytes(32)
  const file = ageEncrypt(key, PASS, LOGN)
  assert.throws(() => ageDecrypt(file, 'falsch'), (e: unknown) => e instanceof AgeError && /Passphrase passt nicht/.test(e.message))
  const changed = Buffer.from(file.toString('latin1').replace(' 10\n', ' 9\n'), 'latin1')
  assert.throws(() => ageDecrypt(changed, PASS), AgeError)
  assert.throws(() => ageDecrypt(file.subarray(0, file.length - 5), PASS), (e: unknown) => e instanceof AgeError && /beschädigt/.test(e.message))
  assert.throws(() => ageDecrypt(Buffer.from('hallo\n'), PASS), (e: unknown) => e instanceof AgeError && /Keine age-Datei/.test(e.message))
})

test('age: nur scrypt, nur ein Empfänger, Arbeitsfaktor begrenzt', () => {
  const x25519 = Buffer.from('age-encryption.org/v1\n-> X25519 abc\nAAAA\n--- AAAA\n')
  assert.throws(() => ageDecrypt(x25519, PASS), /nicht mit einer Passphrase/)
  const big = Buffer.from(`age-encryption.org/v1\n-> scrypt ${'A'.repeat(21)}w 30\n${'A'.repeat(43)}\n--- ${'A'.repeat(43)}\n`)
  assert.throws(() => ageDecrypt(big, PASS), /Arbeitsfaktor/)
})

test('age: grössere Nutzlast über mehrere Stücke (64 KiB)', () => {
  for (const n of [0, 1, 65_536, 65_537, 200_000]) {
    const data = randomBytes(n)
    assert.ok(ageDecrypt(ageEncrypt(data, PASS, LOGN), PASS).equals(data), String(n))
  }
})

test('QR-Code des Schlüssels: quadratisch, drei Suchmuster in den Ecken', () => {
  const rows = qrRows(randomBytes(32).toString('base64'))
  const n = rows.length
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `Grösse ${n}`)
  assert.ok(rows.every((r) => r.length === n && /^[01]+$/.test(r)))
  // Suchmuster 7×7: oben links, oben rechts, unten links
  for (const [y, x] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    assert.equal(rows[y]!.slice(x, x + 7), '1111111')
    assert.equal(rows[y + 2]!.slice(x, x + 7), '1011101')
  }
})

test('Prüfsumme, Hex-Gruppen, Dateiname', () => {
  const key = Buffer.alloc(32, 0)
  // SHA-256 von 32 Nullbytes: 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
  assert.equal(keyFingerprint(key), '6668 7aad f862 bd77')
  assert.equal(keySha256(key).length, 64)
  assert.equal(keyHexGroups(key).length, 16)
  assert.equal(exportFileName('Heim Server!', new Date('2026-11-11T10:00:00Z')), 'airlock-secrets-key-heim-server-2026-11-11.age')
})
