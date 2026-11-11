import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'

/**
 * Meilenstein Backup, Etappe 4: den Schlüssel der Secrets (secrets.key)
 * getrennt vom Backup sichern. Reines Modul ohne Datenbank und Dateisystem.
 *
 * Datei-Export im Format von age (https://age-encryption.org/v1) mit einem
 * scrypt-Empfänger, also mit einer Passphrase verschlüsselt. Damit lässt sich
 * die Datei auf einem frischen Server ohne Airlock entschlüsseln:
 *
 *   age -d -o secrets.key airlock-secrets-key.age
 *
 * Aufbau (age v1, nur der scrypt-Fall):
 *   age-encryption.org/v1
 *   -> scrypt <salt, 16 Byte, Base64 ohne => <log2 N>
 *   <Dateischlüssel, mit ChaCha20-Poly1305 unter scrypt(Passphrase) verpackt>
 *   --- <HMAC-SHA256 über den Kopf>
 *   <16 Byte Nonce><Nutzlast in 64-KiB-Stücken, ChaCha20-Poly1305 (STREAM)>
 *
 * Interoperabilität mit dem echten age prüft scripts/restore-e2e.ts (in
 * beide Richtungen), die Einzelheiten key.test.ts.
 */

const INTRO = 'age-encryption.org/v1'
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt'
const CHUNK = 64 * 1024
const TAG = 16
/** Vorgabe von age; scrypt braucht damit 256 MiB (128 · N · r) */
export const AGE_LOG_N = 18
/** Beim Entschlüsseln höchstens so viel Arbeit (gegen eine Datei, die den Server lahmlegt) */
const MAX_LOG_N = 18
const SCRYPT_MAXMEM = 512 * 1024 * 1024

/** Base64 ohne «=», wie age es schreibt */
const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '')

function unb64(s: string, what: string): Buffer {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new Error(`${what}: kein Base64`)
  const b = Buffer.from(s, 'base64')
  // Nur die kanonische Schreibweise (wie age): sonst gäbe es zwei Köpfe für dieselbe Datei
  if (b64(b) !== s) throw new Error(`${what}: Base64 nicht kanonisch`)
  return b
}

function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG })
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new Error('zu kurz')
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG })
  d.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()])
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32))

function wrapKey(passphrase: string, salt: Buffer, logN: number): Buffer {
  return scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.concat([Buffer.from(SCRYPT_LABEL), salt]), 32, { N: 2 ** logN, r: 8, p: 1, maxmem: SCRYPT_MAXMEM })
}

/** 11 Byte Zähler (Big Endian) und 1 Byte «letztes Stück» */
function chunkNonce(counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12)
  n.writeUIntBE(counter, 5, 6)
  n[11] = last ? 1 : 0
  return n
}

/** Stanza-Körper: Base64 in Zeilen zu 64 Zeichen, die letzte immer kürzer (notfalls leer) */
function bodyLines(body: Buffer): string {
  const s = b64(body)
  const lines: string[] = []
  for (let i = 0; i < s.length; i += 64) lines.push(s.slice(i, i + 64))
  if (lines.length === 0 || lines[lines.length - 1]!.length === 64) lines.push('')
  return lines.join('\n')
}

export function ageEncrypt(plain: Buffer, passphrase: string, logN = AGE_LOG_N): Buffer {
  if (!passphrase) throw new Error('Passphrase fehlt')
  const fileKey = randomBytes(16)
  const salt = randomBytes(16)
  const body = seal(wrapKey(passphrase, salt, logN), Buffer.alloc(12), fileKey)
  const head = `${INTRO}\n-> scrypt ${b64(salt)} ${logN}\n${bodyLines(body)}\n---`
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(head).digest()
  const nonce = randomBytes(16)
  const payloadKey = hkdf(fileKey, nonce, 'payload')
  const parts: Buffer[] = [Buffer.from(`${head} ${b64(mac)}\n`), nonce]
  const count = Math.max(1, Math.ceil(plain.length / CHUNK))
  for (let i = 0; i < count; i++) {
    parts.push(seal(payloadKey, chunkNonce(i, i === count - 1), plain.subarray(i * CHUNK, (i + 1) * CHUNK)))
  }
  return Buffer.concat(parts)
}

export class AgeError extends Error {}

/**
 * age-Datei mit Passphrase entschlüsseln. Wirft AgeError mit einer Meldung
 * für Menschen («Passphrase falsch», «keine age-Datei» …).
 */
export function ageDecrypt(file: Buffer, passphrase: string): Buffer {
  const lineAt = (from: number): [string, number] => {
    const end = file.indexOf(0x0a, from)
    if (end === -1) throw new AgeError('Keine gültige age-Datei (Kopf unvollständig)')
    return [file.subarray(from, end).toString('latin1'), end + 1]
  }
  let pos = 0
  let line: string
  ;[line, pos] = lineAt(pos)
  if (line !== INTRO) throw new AgeError('Keine age-Datei (erste Zeile passt nicht)')
  const headStart = 0
  ;[line, pos] = lineAt(pos)
  const m = /^-> scrypt ([A-Za-z0-9+/]+) (\d{1,2})$/.exec(line)
  if (!m) throw new AgeError('Diese age-Datei ist nicht mit einer Passphrase verschlüsselt')
  let salt: Buffer
  try {
    salt = unb64(m[1]!, 'Salz')
  } catch (err) {
    throw new AgeError(`Keine gültige age-Datei (${(err as Error).message})`)
  }
  const logN = Number(m[2])
  if (salt.length !== 16 || !Number.isInteger(logN) || logN < 1) throw new AgeError('Keine gültige age-Datei (scrypt-Angaben)')
  if (logN > MAX_LOG_N) throw new AgeError(`Arbeitsfaktor 2^${logN} ist grösser als erlaubt (höchstens 2^${MAX_LOG_N})`)
  let bodyText = ''
  for (;;) {
    ;[line, pos] = lineAt(pos)
    if (line.length > 64) throw new AgeError('Keine gültige age-Datei (Zeile zu lang)')
    bodyText += line
    if (line.length < 64) break
  }
  ;[line, pos] = lineAt(pos)
  if (!line.startsWith('--- ')) {
    throw new AgeError(line.startsWith('-> ') ? 'Die Datei hat mehr als einen Empfänger – das ist kein Export von Airlock' : 'Keine gültige age-Datei (Kopf-Ende fehlt)')
  }
  let body: Buffer
  let mac: Buffer
  try {
    body = unb64(bodyText, 'Stanza')
    mac = unb64(line.slice(4), 'MAC')
  } catch (err) {
    throw new AgeError(`Keine gültige age-Datei (${(err as Error).message})`)
  }
  if (body.length !== 32 || mac.length !== 32) throw new AgeError('Keine gültige age-Datei (Längen)')
  let fileKey: Buffer
  try {
    fileKey = open(wrapKey(passphrase, salt, logN), Buffer.alloc(12), body)
  } catch {
    throw new AgeError('Die Passphrase passt nicht zu dieser Datei')
  }
  // MAC über den Kopf bis einschliesslich «---» (ohne Leerzeichen und MAC)
  const head = file.subarray(headStart, pos - line.length - 1 + 3)
  const expected = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(head).digest()
  if (!timingSafeEqual(expected, mac)) throw new AgeError('Der Kopf der Datei ist verändert (MAC passt nicht)')
  if (file.length < pos + 16) throw new AgeError('Keine gültige age-Datei (Nutzlast fehlt)')
  const nonce = file.subarray(pos, pos + 16)
  const payloadKey = hkdf(fileKey, nonce, 'payload')
  const data = file.subarray(pos + 16)
  const out: Buffer[] = []
  const sealedChunk = CHUNK + TAG
  const count = Math.max(1, Math.ceil(data.length / sealedChunk))
  for (let i = 0; i < count; i++) {
    const part = data.subarray(i * sealedChunk, (i + 1) * sealedChunk)
    const last = i === count - 1
    try {
      const plain = open(payloadKey, chunkNonce(i, last), part)
      // Ein leeres letztes Stück gibt es nur bei einer ganz leeren Datei
      if (last && plain.length === 0 && i > 0) throw new Error('leeres letztes Stück')
      out.push(plain)
    } catch {
      throw new AgeError('Die Datei ist beschädigt oder abgeschnitten')
    }
  }
  return Buffer.concat(out)
}

/* --- Schlüssel ----------------------------------------------------------------------- */

export const KEY_BYTES = 32

/** Prüfsumme: SHA-256 des Schlüssels, die ersten 16 Hex-Zeichen in Vierergruppen («a1b2 c3d4 …») */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16).match(/.{4}/g)!.join(' ')
}

/** Ganze SHA-256 (zum Vergleich mit «sha256sum secrets.key» auf dem Server) */
export const keySha256 = (key: Buffer): string => createHash('sha256').update(key).digest('hex')

/** Schlüssel als Hex in Vierergruppen, für die Papier-Anleitung (zum Abtippen) */
export function keyHexGroups(key: Buffer): string[] {
  return key.toString('hex').match(/.{4}/g)!
}

export function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`Der Schlüssel hat ${key.length} statt ${KEY_BYTES} Bytes`)
}

/** QR-Code als Zeilen aus 0/1 (Fehlerkorrektur M; der Browser zeichnet ihn als SVG) */
export function qrRows(text: string): string[] {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const rows: string[] = []
  for (let y = 0; y < n; y++) {
    let row = ''
    // BitMatrix.get(Zeile, Spalte)
    for (let x = 0; x < n; x++) row += qr.modules.get(y, x) ? '1' : '0'
    rows.push(row)
  }
  return rows
}

/** Dateiname des Exports: airlock-secrets-key-<server>-<JJJJ-MM-TT>.age */
export function exportFileName(server: string, now = new Date()): string {
  const name = server.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'airlock'
  return `airlock-secrets-key-${name}-${now.toISOString().slice(0, 10)}.age`
}
