import { createHmac, randomInt } from 'node:crypto'
import { RECOVERY_CODE_COUNT } from '@airlock/shared'

/**
 * Wiederherstellungscodes: 12 Zeichen aus Crockford-Base32 (ohne i, l, o, u
 * – keine Verwechslung beim Abtippen), also 60 Bit Zufall je Code.
 *
 * Gespeichert wird nur ein HMAC-SHA256 mit einem Schlüssel aus der
 * Schlüsseldatei (nicht aus der Datenbank): ein Datenbank-Abzug allein lässt
 * sich so nicht offline durchprobieren.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>()
  while (out.size < n) {
    let raw = ''
    for (let i = 0; i < 12; i++) raw += ALPHABET[randomInt(ALPHABET.length)]
    out.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`)
  }
  return [...out]
}

/** Eingabe vereinheitlichen: klein, ohne Trennzeichen; i/l → 1, o → 0, u → v (Crockford) */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0').replace(/u/g, 'v')
}

export function hashRecoveryCode(code: string, key: Buffer): string {
  return createHmac('sha256', key).update('airlock-recovery\0').update(normalizeRecoveryCode(code)).digest('hex')
}

/** Inhalt der .txt-Datei zum Herunterladen */
export function recoveryCodesText(codes: string[], o: { product: string; host: string | null; createdAt: Date }): string {
  const lines = [
    `${o.product} – Wiederherstellungscodes`,
    o.host ? `Adresse: ${o.host}` : null,
    `Erstellt: ${o.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    'Jeder Code gilt genau einmal – anstelle des Codes aus der Authenticator-App.',
    'Sicher aufbewahren (Passwort-Manager oder ausgedruckt). Neue Codes machen diese ungültig.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
    '',
  ]
  return lines.filter((l) => l !== null).join('\n')
}
