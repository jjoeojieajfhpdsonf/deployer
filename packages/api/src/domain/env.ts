import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import type { EnvEntryDto, EnvEntryInput } from '@airlock/shared'
import { conflict } from '../lib/errors.js'
import { mergeEnvLevels, inheritableFromProject, missingPreviewSecrets, type EnvLevelEntry } from '../lib/previews.js'

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

type StoredEnv = { key: string; isSecret: boolean; value: string | null; valueEncrypted: Buffer | null }

const decrypted = (rows: StoredEnv[], k: Buffer): EnvLevelEntry[] =>
  rows.map((r) => ({ key: r.key, isSecret: r.isSecret, value: r.isSecret && r.valueEncrypted ? decrypt(r.valueEncrypted, k) : (r.value ?? '') }))

/**
 * Etappe 6: Ebenen der Variablen. Ein normales Projekt hat nur seine eigenen;
 * eine Vorschau erbt die normalen des Projekts (geheime nicht, Korrektur nach
 * Nacht 2), darüber die Ebene «Vorschau» des Projekts, darüber eigene Werte
 * der einzelnen Vorschau (gleichnamige überschreiben, der Rest wird geerbt).
 */
async function previewRows(projectId: string): Promise<{ parent: StoredEnv[]; preview: StoredEnv[]; own: StoredEnv[] } | null> {
  const row = (await db.select({ previewOf: schema.projects.previewOf }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]
  if (!row?.previewOf) return null
  const own = await db.select().from(schema.projectEnv).where(eq(schema.projectEnv.projectId, projectId))
  const parent = await db.select().from(schema.projectEnv).where(eq(schema.projectEnv.projectId, row.previewOf))
  const preview = await db.select().from(schema.projectPreviewEnv).where(eq(schema.projectPreviewEnv.projectId, row.previewOf))
  return { parent, preview, own }
}

async function envLevels(projectId: string): Promise<StoredEnv[][]> {
  const pv = await previewRows(projectId)
  if (!pv) return [await db.select().from(schema.projectEnv).where(eq(schema.projectEnv.projectId, projectId))]
  return [inheritableFromProject(pv.parent), pv.preview, pv.own]
}

/**
 * Vorschau: geheime Variablen des Projekts ohne Wert für Vorschauen. Leer bei
 * normalen Projekten. Die Pipeline bricht damit vor dem Build ab.
 */
export async function missingSecretsForPreview(projectId: string): Promise<string[]> {
  const pv = await previewRows(projectId)
  return pv ? missingPreviewSecrets(pv.parent, pv.preview, pv.own) : []
}

/** Nur fuer die Pipeline: entschluesselte Werte fuer den Container. */
export async function resolveEnv(projectId: string): Promise<Record<string, string>> {
  const k = key()
  const merged = mergeEnvLevels(...(await envLevels(projectId)).map((rows) => decrypted(rows, k)))
  return Object.fromEntries(merged.map((e) => [e.key, e.value]))
}

/**
 * Nur die nicht-geheimen Werte. Für statische Builds: was dort hineingeht,
 * kann in der ausgelieferten Seite landen. (Vorschau: geheim auf der Ebene,
 * die gewinnt, heisst nicht hinein.)
 */
export async function resolvePublicEnv(projectId: string): Promise<Record<string, string>> {
  const levels = (await envLevels(projectId)).map((rows) => rows.map((r) => ({ key: r.key, isSecret: r.isSecret, value: r.isSecret ? '' : (r.value ?? '') })))
  const out: Record<string, string> = {}
  for (const e of mergeEnvLevels(...levels)) if (!e.isSecret) out[e.key] = e.value
  return out
}

/* --- Etappe 6: Ebene «Vorschau» eines Projekts ------------------------------------------ */

/** Für die UI: wie listEnvDto, geheime Werte null */
export async function listPreviewEnvDto(projectId: string): Promise<EnvEntryDto[]> {
  const rows = await db.select().from(schema.projectPreviewEnv).where(eq(schema.projectPreviewEnv.projectId, projectId))
  return rows
    .map((r) => ({ key: r.key, isSecret: r.isSecret, value: r.isSecret ? null : (r.value ?? '') }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Ersetzt die Ebene «Vorschau» atomar; leeres Secret behält den gespeicherten Wert (wie replaceEnv) */
export async function replacePreviewEnv(projectId: string, entries: EnvEntryInput[]): Promise<void> {
  const k = key()
  const existing = await db.select().from(schema.projectPreviewEnv).where(eq(schema.projectPreviewEnv.projectId, projectId))
  const byKey = new Map(existing.map((e) => [e.key, e]))
  await db.transaction(async (tx) => {
    await tx.delete(schema.projectPreviewEnv).where(eq(schema.projectPreviewEnv.projectId, projectId))
    if (entries.length === 0) return
    await tx.insert(schema.projectPreviewEnv).values(entries.map((e) => {
      if (!e.isSecret) return { projectId, key: e.key, isSecret: false, value: e.value, valueEncrypted: null }
      const keepOld = e.value === '' && byKey.get(e.key)?.isSecret
      return { projectId, key: e.key, isSecret: true, value: null, valueEncrypted: keepOld ? byKey.get(e.key)!.valueEncrypted! : encrypt(e.value, k) }
    }))
  })
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
