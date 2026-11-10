import { eq, and } from 'drizzle-orm'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PAUSE_FILE } from '../drivers/caddy-config.js'
import { DEFAULT_PAUSE_PAGE, pausePageSchema, type PausePage, type PauseOptions } from '@airlock/shared'
import { db, schema, getSetting } from '../db/index.js'
import { defaultEnvironmentId } from './environments.js'
import { audit } from './audit.js'
import { badRequest } from '../lib/errors.js'

/**
 * Pause-Seite: globale Vorlage (Einstellung «pause_page») und Überschreibung
 * pro Projekt an der öffentlichen Route (Migration 0013). Den Caddy-Abgleich
 * nach einer Änderung macht der Aufrufer – kein Import von routes.ts hier
 * (routes.ts liest die Vorlage).
 */

const KEY = 'pause_page'

/** Anzeige von «Voraussichtlich zurück»: Zeitzone des Servers, sonst Zürich. */
export const displayTimeZone = () => process.env.TZ || 'Europe/Zurich'

/**
 * M9: Die Vorlage gehört zur Umgebung (environments.pause_page); ohne Angabe
 * die Standard-Umgebung. app_settings.pause_page ist nur noch Rückfall aus
 * der Zeit vor M9 (importLegacySettings übernimmt ihn einmal).
 */
export async function pausePageTemplate(envId: string = defaultEnvironmentId()): Promise<PausePage> {
  const row = (await db.select({ page: schema.environments.pausePage }).from(schema.environments).where(eq(schema.environments.id, envId)))[0]
  const raw: unknown = row?.page ?? (await legacyTemplate())
  if (!raw) return DEFAULT_PAUSE_PAGE
  const r = pausePageSchema.safeParse(raw)
  return r.success ? r.data : DEFAULT_PAUSE_PAGE
}

async function legacyTemplate(): Promise<unknown> {
  const raw = await getSetting(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** null setzt die Vorlage auf den Standard zurück. */
export async function setPausePageTemplate(page: PausePage | null, actor: string, envId: string = defaultEnvironmentId()): Promise<PausePage> {
  const value = page ? pausePageSchema.parse(page) : DEFAULT_PAUSE_PAGE
  await db.update(schema.environments).set({ pausePage: value, updatedAt: new Date() }).where(eq(schema.environments.id, envId))
  await audit({ actor, action: 'settings.pause_page', targetType: 'environment', targetId: envId, environmentId: envId, params: { title: value.title, lang: value.lang, reset: page === null }, result: 'ok' })
  return value
}

/**
 * Seite und «Voraussichtlich zurück» eines Projekts setzen (beim Pausieren
 * oder während der Pause). page undefined: unverändert; null: wie Vorlage.
 */
export async function setProjectPause(projectId: string, o: PauseOptions, actor: string): Promise<boolean> {
  if (o.backAt && new Date(o.backAt).getTime() <= Date.now()) throw badRequest('«Voraussichtlich zurück» liegt in der Vergangenheit')
  const set: Partial<typeof schema.routes.$inferInsert> = {}
  if (o.page !== undefined) set.pausePage = o.page ? pausePageSchema.parse(o.page) : null
  if (o.backAt !== undefined) set.pauseBackAt = o.backAt ? new Date(o.backAt) : null
  if (Object.keys(set).length === 0) return false
  const rows = await db.update(schema.routes).set(set)
    .where(and(eq(schema.routes.projectId, projectId), eq(schema.routes.target, 'public')))
    .returning({ id: schema.routes.id })
  if (!rows.length) throw badRequest('Das Projekt ist nicht öffentlich')
  await audit({
    actor, action: 'project.public.pause_page', targetType: 'project', targetId: projectId,
    params: { custom: o.page === undefined ? 'unverändert' : o.page ? o.page.title : 'wie Vorlage', backAt: o.backAt ?? null }, result: 'ok',
  })
  return true
}

/**
 * Code-Modus: das eigene HTML (Platzhalter eingesetzt) als Datei unter
 * <sites>/_pause/<slug>/index.html. Slugs beginnen nie mit «_», der Ordner
 * kollidiert also mit keinem Projekt. Atomar (tmp + rename) und nur bei
 * Änderung geschrieben. Gibt den Ordner zurück, den Caddy ausliefert.
 */
export async function writePauseFile(sitesDir: string, slug: string, html: string): Promise<string> {
  const dir = join(sitesDir, '_pause', slug)
  const file = join(dir, PAUSE_FILE)
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current !== html) {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, html, { mode: 0o644 })
    await rename(tmp, file)
  }
  return dir
}

export async function projectPause(projectId: string): Promise<{ page: PausePage | null; backAt: string | null }> {
  const r = (await db.select({ page: schema.routes.pausePage, backAt: schema.routes.pauseBackAt }).from(schema.routes)
    .where(and(eq(schema.routes.projectId, projectId), eq(schema.routes.target, 'public'))).limit(1))[0]
  return { page: r?.page ?? null, backAt: r?.backAt?.toISOString() ?? null }
}
