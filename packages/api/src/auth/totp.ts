import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP nach RFC 6238 (HOTP nach RFC 4226) mit node:crypto – bewusst ohne
 * Bibliothek: die Rechnung ist kurz, und so gibt es keine Abhängigkeit, die
 * mit dem Geheimnis in Berührung kommt. SHA-1, 6 Ziffern, 30 s – das, was
 * jede Authenticator-App ohne Rückfrage versteht.
 */

export const TOTP_PERIOD_S = 30
export const TOTP_DIGITS = 6
/** Erlaubte Abweichung in Zeitfenstern (±1 = 30 s vor oder nach) */
export const TOTP_WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Ungültiges Zeichen im Base32-Geheimnis')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Neues Geheimnis: 20 Byte (160 Bit, wie RFC 4226 empfiehlt) als Base32 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** Zeitfenster (Zähler) für einen Zeitpunkt in Millisekunden */
export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_S)

export function totpAt(secretB32: string, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs), digits)
}

/**
 * Prüft einen Code im Fenster ±window. Gibt das passende Zeitfenster zurück
 * (für «jeder Code nur einmal»: der Aufrufer nimmt nur Fenster nach dem
 * zuletzt benutzten an) oder null. Vergleicht alle Kandidaten in konstanter
 * Zeit und bricht nicht beim ersten Treffer ab.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, window = TOTP_WINDOW): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const secret = base32Decode(secretB32)
  const step = totpStep(nowMs)
  const given = Buffer.from(code)
  let match: number | null = null
  for (let d = -window; d <= window; d++) {
    const s = step + d
    if (s < 0) continue
    const expected = Buffer.from(hotp(secret, s))
    if (timingSafeEqual(expected, given) && match === null) match = s
  }
  return match
}

/** otpauth://-Adresse für den QR-Code (Google-Authenticator-Format, von allen Apps verstanden) */
export function otpauthUri(o: { secret: string; issuer: string; account: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`)
  const q = new URLSearchParams({ secret: o.secret, issuer: o.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_S) })
  return `otpauth://totp/${label}?${q.toString()}`
}

/** Geheimnis in Vierergruppen zum Abtippen */
export const formatSecret = (s: string): string => s.replace(/(.{4})(?=.)/g, '$1 ')
