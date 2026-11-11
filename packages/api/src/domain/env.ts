import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import type { EnvEntryDto, EnvEntryInput } from '@airlock/shared'
import { conflict } from '../lib/errors.js'

/**
 * Umgebungsvariablen eines Projekts. Als geheim markierte Werte liegen
 * AES-256-GCM-verschluesselt in der Datenbank; der Schluessel liegt in einer
 * eigenen Datei mit Rechten 600, nicht in der Datenbank (so verlangt es die
 * SPEC). Geheime Werte verlassen den Server nie im Klartext.
 */

function key(): Buffer {
  return loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
}

/** Fuer die UI: geheime Werte sind null, nicht maskierter Text. */
export async function listEnvDto(projectId: string): Promise<EnvEntryDto[]> {
  const rows = await db
    .select()
    .from(schema.projectEnv)
    .where(eq(schema.projectEnv.projectId, projectId))
  return rows
    .map((r) => ({ key: r.key, isSecret: r.isSecret, value: r.isSecret ? null : (r.value ?? '') }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Nur fuer die Pipeline: entschluesselte Werte fuer den Container. */
export async function resolveEnv(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(schema.projectEnv)
    .where(eq(schema.projectEnv.projectId, projectId))
  const out: Record<string, string> = {}
  const k = key()
  for (const r of rows) {
    out[r.key] = r.isSecret && r.valueEncrypted ? decrypt(r.valueEncrypted, k) : (r.value ?? '')
  }
  return out
}

/**
 * Nur die nicht-geheimen Werte. Für statische Builds: was dort hineingeht,
 * kann in der ausgelieferten Seite landen.
 */
export async function resolvePublicEnv(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(schema.projectEnv)
    .where(eq(schema.projectEnv.projectId, projectId))
  const out: Record<string, string> = {}
  for (const r of rows) if (!r.isSecret) out[r.key] = r.value ?? ''
  return out
}

/**
 * Etappe 4 «Dienst hinzufügen»: neue Variablen anlegen (erzeugte Passwörter,
 * Verbindungs-Strings). Überschreibt nie eine bestehende Variable – gibt es
 * den Namen inzwischen, scheitert alles (Konflikt), nichts wird halb angelegt.
 */
export async function addEnvEntries(projectId: string, entries: { key: string; value: string; secret: boolean }[]): Promise<void> {
  if (!entries.length) return
  const k = key()
  await db.transaction(async (tx) => {
    const existing = new Set((await tx.select({ key: schema.projectEnv.key }).from(schema.projectEnv).where(eq(schema.projectEnv.projectId, projectId))).map((r) => r.key))
    const clash = entries.find((e) => existing.has(e.key))
    if (clash) throw conflict(`Die Umgebungsvariable ${clash.key} gibt es inzwischen schon. Bitte die Vorschau neu laden.`)
    await tx.insert(schema.projectEnv).values(entries.map((e) => (e.secret
      ? { projectId, key: e.key, isSecret: true, value: null, valueEncrypted: encrypt(e.value, k) }
      : { projectId, key: e.key, isSecret: false, value: e.value, valueEncrypted: null })))
  })
}

/**
 * Ersetzt die gesamte Liste atomar.
 *
 * Ein Eintrag mit leerem Wert und isSecret bleibt erhalten, wenn es ihn schon
 * gibt: die UI kann geheime Werte nicht zurueckgelesen haben und wuerde sie
 * sonst beim Speichern eines anderen Feldes loeschen.
 */
export async function replaceEnv(projectId: string, entries: EnvEntryInput[]): Promise<void> {
  const k = key()
  const existing = await db
    .select()
    .from(schema.projectEnv)
    .where(eq(schema.projectEnv.projectId, projectId))
  const existingByKey = new Map(existing.map((e) => [e.key, e]))

  await db.transaction(async (tx) => {
    await tx.delete(schema.projectEnv).where(eq(schema.projectEnv.projectId, projectId))
    if (entries.length === 0) return

    const rows = entries.map((e) => {
      if (e.isSecret) {
        const keepOld = e.value === '' && existingByKey.get(e.key)?.isSecret
        const blob = keepOld
          ? existingByKey.get(e.key)!.valueEncrypted!
          : encrypt(e.value, k)
        return { projectId, key: e.key, isSecret: true, value: null, valueEncrypted: blob }
      }
      return { projectId, key: e.key, isSecret: false, value: e.value, valueEncrypted: null }
    })
    await tx.insert(schema.projectEnv).values(rows)
  })
}
