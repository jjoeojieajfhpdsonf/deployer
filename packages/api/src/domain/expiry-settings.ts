import { getSetting, setSetting } from '../db/index.js'
import { config } from '../config.js'
import { badRequest } from '../lib/errors.js'
import { audit } from './audit.js'

/**
 * Frist für Chat-Projekte (Tage ohne Änderung bis zum Stopp). Standard aus
 * CHAT_EXPIRY_DAYS (.env), in den System-Einstellungen änderbar; der Wert
 * aus der Datenbank gilt dann vor der Umgebungsvariable. Im Speicher
 * gehalten, damit toDto und der Ablauf-Job ihn ohne Abfrage kennen.
 */
const KEY = 'chat_expiry_days'
export const EXPIRY_MIN_DAYS = 4
export const EXPIRY_MAX_DAYS = 3650

let current: number | null = null

/** Rein: gespeicherten Text lesen; Ungültiges fällt auf den Standard zurück. */
export function parseExpiryDays(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isInteger(n) && n >= EXPIRY_MIN_DAYS && n <= EXPIRY_MAX_DAYS ? n : fallback
}

export async function loadExpirySetting(): Promise<void> {
  current = parseExpiryDays(await getSetting(KEY), config.CHAT_EXPIRY_DAYS)
}

export function chatExpiryDays(): number {
  return current ?? config.CHAT_EXPIRY_DAYS
}

export function expiryInfo(): { days: number; fromEnv: number; changed: boolean } {
  return { days: chatExpiryDays(), fromEnv: config.CHAT_EXPIRY_DAYS, changed: chatExpiryDays() !== config.CHAT_EXPIRY_DAYS }
}

export async function setChatExpiryDays(days: unknown, actor: string): Promise<{ days: number; fromEnv: number; changed: boolean }> {
  const n = Number(days)
  if (!Number.isInteger(n) || n < EXPIRY_MIN_DAYS || n > EXPIRY_MAX_DAYS) {
    throw badRequest(`Die Frist muss eine ganze Zahl zwischen ${EXPIRY_MIN_DAYS} und ${EXPIRY_MAX_DAYS} Tagen sein`)
  }
  const before = chatExpiryDays()
  await setSetting(KEY, String(n))
  current = n
  await audit({ actor, action: 'settings.chat_expiry', targetType: 'system', targetId: 'expiry', params: { days: n, before }, result: 'ok' })
  return expiryInfo()
}
