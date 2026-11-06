import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/* --- Secret-Verschluesselung (AES-256-GCM) --------------------------------
 * Der Schluessel liegt in einer eigenen Datei mit Rechten 600, nicht in der
 * Datenbank. So verlangt es die SPEC.
 * -------------------------------------------------------------------------- */

let cachedKey: Buffer | null = null

export function loadOrCreateKey(path: string): Buffer {
  if (cachedKey) return cachedKey
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    writeFileSync(path, key, { mode: 0o600 })
    chmodSync(path, 0o600)
    cachedKey = key
    return key
  }
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error(`Schlüsseldatei ${path} hat ${key.length} statt 32 Bytes`)
  cachedKey = key
  return key
}

/** Format: [12 Byte IV][16 Byte Tag][Ciphertext] */
export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < 28) throw new Error('Verschlüsselter Wert zu kurz')
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ct = blob.subarray(28)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/* --- Passwort -------------------------------------------------------------
 * scrypt aus der Node-Standardbibliothek. Bewusst keine native Abhaengigkeit
 * (argon2) fuer genau ein Passwort eines Einzelbenutzers.
 * -------------------------------------------------------------------------- */

/** OWASP-Minimum fuer scrypt: N=2^17, r=8, p=1. */
const SCRYPT_N = 131072
const SCRYPT_R = 8
const SCRYPT_P = 1

/**
 * scrypt braucht rund 128 * N * r Bytes, hier also 128 MiB. Nodes Vorgabe fuer
 * maxmem sind 32 MiB; ohne Anhebung wirft scryptSync sofort einen Fehler.
 * Die Spitze ist kurzlebig und faellt nur beim Login an, nicht im Leerlauf.
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const dk = scryptSync(password, salt, 64, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${dk.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3])
  // Obergrenze gegen einen manipulierten Hash-String, der sonst beliebig viel
  // Speicher und Rechenzeit anfordern koennte.
  if (!Number.isInteger(N) || N < 2 || N > SCRYPT_N || (N & (N - 1)) !== 0) return false
  if (!Number.isInteger(r) || r < 1 || r > 32) return false
  if (!Number.isInteger(p) || p < 1 || p > 16) return false
  const salt = Buffer.from(parts[4] ?? '', 'base64')
  const expected = Buffer.from(parts[5] ?? '', 'base64')
  if (expected.length === 0) return false
  const dk = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}

/** Maskiert Secret-Werte fuer das Audit-Log. */
export function maskParams(value: unknown): unknown {
  const SECRET_KEYS = /^(password|secret|token|value|value_encrypted|env)$/i
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEYS.test(k)) out[k] = '***'
        else out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(value)
}
