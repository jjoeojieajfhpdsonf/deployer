import { join } from 'node:path'
import type { BackupKeyFileDto, BackupKeyMethod, BackupKeyPaperDto, BackupKeyStatusDto, BackupKeyVerifyDto } from '@airlock/shared'
import { PRODUCT_NAME } from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey } from '../lib/crypto.js'
import { registerSecret } from '../lib/redact.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'
import { audit } from '../domain/audit.js'
import { login } from '../http/auth.js'
import { AgeError, ageDecrypt, ageEncrypt, assertKey, exportFileName, keyFingerprint, keyHexGroups, keySha256, qrRows } from './key.js'

/**
 * Meilenstein Backup, Etappe 4: secrets.key getrennt vom Backup sichern.
 *
 * - Der Schlüssel liegt nur in DATA_DIR/keys/secrets.key (ausgeschlossen aus
 *   jedem restic-Stand, backup/restic.ts) und verlässt Airlock nur über die
 *   beiden Exporte hier – jedes Mal erst nach frischer Anmeldung (das
 *   Anmelde-Passwort noch einmal, mit derselben Sperre nach Fehlversuchen wie
 *   beim Login) und nie über ein API-Token (http/auth.ts).
 * - Datei: age mit Passphrase (backup/key.ts). Papier: Base64, Hex und QR für
 *   die Druckansicht im Browser.
 * - Nie im Log, nie im Audit: ins Audit gehen nur Art und Prüfsumme. Base64
 *   und Hex des Schlüssels sind als Geheimnis registriert (lib/redact.ts) und
 *   in jeder Meldung geschwärzt.
 * - Merker «gesichert am»: erst, wenn bestätigt ist, dass der Export getrennt
 *   abgelegt ist – und nur für genau diesen Schlüssel (Prüfsumme).
 */

const MARK_KEY = 'secrets_key_backup'
/** So lange nach einem Export darf er als «abgelegt» bestätigt werden */
const CONFIRM_WINDOW_MS = 60 * 60_000

interface Mark {
  at: string
  method: BackupKeyMethod
  fingerprint: string
}

const keyPath = () => join(config.DATA_DIR, 'keys', 'secrets.key')

function currentKey(): Buffer {
  const key = loadOrCreateKey(keyPath())
  assertKey(key)
  // Ab jetzt in jeder Meldung geschwärzt, falls der Schlüssel je in einen Text geriete
  registerSecret(key.toString('base64'))
  registerSecret(key.toString('hex'))
  return key
}

async function loadMark(): Promise<Mark | null> {
  const raw = await getSetting(MARK_KEY)
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as Mark
    return m.at && m.method && m.fingerprint ? m : null
  } catch {
    return null
  }
}

export async function keyStatus(): Promise<BackupKeyStatusDto> {
  const fingerprint = keyFingerprint(currentKey())
  const m = await loadMark()
  // Ein Merker für einen früheren Schlüssel zählt nicht
  const valid = m && m.fingerprint === fingerprint ? m : null
  return { fingerprint, savedAt: valid?.at ?? null, method: valid?.method ?? null }
}

/** Frische Anmeldung: Passwort prüfen, mit der Sperre nach Fehlversuchen des Logins */
async function reauth(ip: string, password: string): Promise<void> {
  if (!(await login(ip, password))) {
    throw new AppError('invalid_credentials', 'Das Anmelde-Passwort stimmt nicht', 400, [{ path: 'password', message: 'Das Anmelde-Passwort stimmt nicht' }])
  }
}

/** Zuletzt exportiert (im Speicher; nach einem Neustart erst wieder exportieren) */
const exported = new Map<BackupKeyMethod, { at: number; fingerprint: string }>()

async function noteExport(method: BackupKeyMethod, fingerprint: string, actor: string): Promise<void> {
  exported.set(method, { at: Date.now(), fingerprint })
  await audit({ actor, action: 'backup.key_export', environmentId: null, params: { method, fingerprint }, result: 'ok' })
}

export async function exportKeyFile(input: { password: string; passphrase: string }, ip: string, actor: string): Promise<BackupKeyFileDto> {
  await reauth(ip, input.password)
  const key = currentKey()
  const fingerprint = keyFingerprint(key)
  const file = ageEncrypt(key, input.passphrase)
  await noteExport('file', fingerprint, actor)
  return { filename: exportFileName(config.SERVER_NAME || PRODUCT_NAME), file: file.toString('base64'), fingerprint }
}

export async function exportKeyPaper(input: { password: string }, ip: string, actor: string): Promise<BackupKeyPaperDto> {
  await reauth(ip, input.password)
  const key = currentKey()
  const b64 = key.toString('base64')
  const fingerprint = keyFingerprint(key)
  await noteExport('paper', fingerprint, actor)
  return {
    key: b64,
    hex: keyHexGroups(key),
    fingerprint,
    sha256: keySha256(key),
    qr: qrRows(b64),
    server: config.SERVER_NAME || PRODUCT_NAME,
    createdAt: new Date().toISOString(),
  }
}

/** «Getrennt abgelegt»: setzt den Merker, wenn kurz vorher genau dieser Schlüssel exportiert wurde */
export async function confirmKeySaved(method: BackupKeyMethod, actor: string): Promise<BackupKeyStatusDto> {
  const e = exported.get(method)
  const fingerprint = keyFingerprint(currentKey())
  if (!e || Date.now() - e.at > CONFIRM_WINDOW_MS || e.fingerprint !== fingerprint) {
    throw badRequest(method === 'file' ? 'Erst die Datei exportieren, dann bestätigen' : 'Erst die Papier-Anleitung öffnen, dann bestätigen')
  }
  const mark: Mark = { at: new Date().toISOString(), method, fingerprint }
  await setSetting(MARK_KEY, JSON.stringify(mark))
  exported.delete(method)
  await audit({ actor, action: 'backup.key_saved', environmentId: null, params: { method, fingerprint }, result: 'ok' })
  return keyStatus()
}

let verifying = false

/**
 * Exportierte Datei prüfen: entschlüsseln und mit dem aktuellen Schlüssel
 * vergleichen. Gibt nur «passt» und die Prüfsumme zurück, nie den Schlüssel.
 * Höchstens eine Prüfung gleichzeitig (scrypt braucht 256 MiB).
 */
export async function verifyKeyFile(input: { file: string; passphrase: string }, actor: string): Promise<BackupKeyVerifyDto> {
  if (verifying) throw conflict('Es läuft schon eine Prüfung')
  verifying = true
  try {
    let plain: Buffer
    try {
      plain = ageDecrypt(Buffer.from(input.file, 'base64'), input.passphrase)
    } catch (err) {
      if (err instanceof AgeError) {
        const field = /Passphrase/.test(err.message) ? 'passphrase' : 'file'
        throw badRequest(err.message, [{ path: field, message: err.message }])
      }
      throw err
    }
    if (plain.length !== 32) throw badRequest('Die Datei enthält keinen Schlüssel von Airlock', [{ path: 'file', message: 'Die Datei enthält keinen Schlüssel von Airlock' }])
    const fingerprint = keyFingerprint(plain)
    const matches = fingerprint === keyFingerprint(currentKey()) && plain.equals(currentKey())
    await audit({ actor, action: 'backup.key_verify', environmentId: null, params: { fingerprint, matches }, result: matches ? 'ok' : 'error', error: matches ? null : 'Die Datei enthält einen anderen Schlüssel' })
    return { matches, fingerprint }
  } finally {
    verifying = false
  }
}
