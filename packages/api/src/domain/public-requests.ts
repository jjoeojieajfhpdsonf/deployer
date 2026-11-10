import { eq } from 'drizzle-orm'
import type { PublicRequestDto, PublicStatusDto } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { audit } from './audit.js'
import { notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'

/**
 * Vorgemerkte Öffentlich-Anfragen. Kommt «öffentlich» an, bevor ein Scan
 * bestanden ist (MCP create_project, set_targets während der Scan läuft),
 * wird die Anfrage festgehalten statt still verworfen:
 *
 *   vorgemerkt ──(Oberfläche: «Nach dem Scan öffentlich schalten»)──▶ bestätigt
 *   bestätigt  ──(Scan bestanden)──▶ veröffentlicht, Anfrage gelöscht
 *   vorgemerkt ──(Scan bestanden)──▶ «bereit» – wartet auf Bestätigung, nie still
 *   jederzeit  ──(«Anfrage verwerfen»)──▶ gelöscht
 *
 * Jeder Übergang steht im Audit-Log.
 */

type Row = typeof schema.publicRequests.$inferSelect
type Gate = PublicStatusDto['publishable']

/* --- Texte (rein, testbar) ------------------------------------------------------- */

/** Kurzer Grund, warum gerade nicht veröffentlicht werden kann. */
export function gateReason(g: { why: 'no_scan' | 'scan_running' | 'critical' | 'disabled'; runningSince?: Date | null; critical?: string[]; now?: number }): string {
  const now = g.now ?? Date.now()
  switch (g.why) {
    case 'scan_running': {
      const min = g.runningSince ? Math.max(0, Math.floor((now - g.runningSince.getTime()) / 60_000)) : null
      return `${min === null ? 'Scan läuft' : min < 1 ? 'Scan läuft seit eben' : `Scan läuft seit ${min} Min.`} – veröffentlichen geht, sobald er ohne kritischen Befund fertig ist.`
    }
    case 'critical': {
      const n = g.critical?.length ?? 0
      const list = (g.critical ?? []).slice(0, 2).join('; ')
      return `${n === 1 ? '1 kritischer Befund' : `${n} kritische Befunde`} offen${list ? `: ${list}` : ''}. Beheben oder mit Begründung akzeptieren.`
    }
    case 'no_scan':
      return 'Noch kein abgeschlossener Scan – er startet nach dem ersten erfolgreichen Deploy.'
    case 'disabled':
      return 'Öffentlich ist nicht eingerichtet: unter System → Cloudflare & HTTPS den Tunnel einrichten.'
  }
}

const clock = (d: Date) => d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Zurich' })

/** Zustand und Satz einer Anfrage, aus der Schwelle abgeleitet. */
export function describeRequest(r: Pick<Row, 'requestedAt' | 'actor' | 'approvedBy' | 'lastError'>, gate: Gate): Pick<PublicRequestDto, 'state' | 'text'> {
  const who = `Öffentlich angefragt von ${r.actor} um ${clock(r.requestedAt)}`
  if (r.lastError) return { state: 'failed', text: `${who} – automatisch veröffentlichen ist gescheitert: ${r.lastError}` }
  if (gate.ok) {
    return r.approvedBy
      ? { state: 'ready', text: `${who} – Scan bestanden, wird jetzt veröffentlicht.` }
      : { state: 'ready', text: `${who} – Scan bestanden. Veröffentlichen braucht noch deine Bestätigung.` }
  }
  const after = r.approvedBy ? ` Bestätigt von ${r.approvedBy}: wird danach automatisch veröffentlicht.` : ''
  // Den Grund selbst zeigt die Karte darunter (bzw. MCP in «reason») – hier nicht doppelt
  if (gate.why === 'critical') return { state: 'blocked', text: `${who} – gesperrt, solange ein kritischer Befund offen ist.${after}` }
  if (gate.why === 'disabled') return { state: 'blocked', text: `${who} – ${gate.reason}` }
  return { state: 'waiting', text: `${who} – wartet auf abgeschlossenen Scan ohne kritischen Befund.${after}` }
}

export function toRequestDto(r: Row, gate: Gate): PublicRequestDto {
  return {
    requestedAt: r.requestedAt.toISOString(),
    actor: r.actor,
    hostname: r.hostname ?? (r.subdomain ? `${r.subdomain}.…` : null),
    accessProtected: r.accessProtected,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    lastError: r.lastError,
    ...describeRequest(r, gate),
  }
}

/**
 * Antwort für MCP: Zustand und Grund klar, damit der Chat es richtig
 * weitergibt – vorgemerkt heisst nicht öffentlich.
 */
export function mcpRequestInfo(r: Pick<Row, 'requestedAt' | 'actor' | 'approvedBy' | 'lastError'>, gate: Gate) {
  const d = describeRequest(r, gate)
  return {
    state: 'vorgemerkt, nicht öffentlich',
    waits_for: d.state === 'blocked' && !gate.ok ? gate.reason : 'abgeschlossenen Scan ohne kritischen Befund',
    reason: gate.ok ? 'Scan bestanden; es fehlt nur die Bestätigung in der Oberfläche.' : gate.reason,
    confirmed_in_ui: Boolean(r.approvedBy),
    next: r.approvedBy
      ? 'Bestätigt: wird nach dem nächsten bestandenen Scan automatisch öffentlich.'
      : 'Bis zur Bestätigung in Airlock (Projekt → Einstellungen → Veröffentlichung, «Nach dem Scan öffentlich schalten») bleibt das Projekt nur intern erreichbar. Nichts wird still veröffentlicht. Alternativ nach dem Scan set_targets mit "public" (mit Rückfrage).',
    text: d.text,
  }
}

/* --- Datenbank ----------------------------------------------------------------------- */

export async function getPublicRequest(projectId: string): Promise<Row | null> {
  return (await db.select().from(schema.publicRequests).where(eq(schema.publicRequests.projectId, projectId)).limit(1))[0] ?? null
}

/** Anfrage vormerken (ersetzt eine ältere; eine Bestätigung geht dabei verloren). */
export async function requestPublic(
  projectId: string,
  input: { subdomain?: string; hostname?: string; accessProtected?: boolean },
  actor: string,
  why: string,
): Promise<Row> {
  const values = {
    projectId, actor, requestedAt: new Date(),
    subdomain: input.subdomain ?? null, hostname: input.hostname ?? null, accessProtected: Boolean(input.accessProtected),
    approvedBy: null, approvedAt: null, lastError: null,
  }
  const rows = await db.insert(schema.publicRequests).values(values)
    .onConflictDoUpdate({ target: schema.publicRequests.projectId, set: values })
    .returning()
  await audit({ actor, action: 'public.request', targetType: 'project', targetId: projectId, params: { ...input, why }, result: 'ok' })
  log.info('Öffentlich-Anfrage vorgemerkt', { projectId, actor, why })
  return rows[0]!
}

export async function approvePublicRequest(projectId: string, actor: string): Promise<Row> {
  const rows = await db.update(schema.publicRequests)
    .set({ approvedBy: actor, approvedAt: new Date(), lastError: null })
    .where(eq(schema.publicRequests.projectId, projectId))
    .returning()
  if (!rows[0]) throw notFound('Öffentlich-Anfrage')
  await audit({ actor, action: 'public.request.approve', targetType: 'project', targetId: projectId, params: {}, result: 'ok' })
  return rows[0]
}

export async function discardPublicRequest(projectId: string, actor: string, why = 'verworfen'): Promise<boolean> {
  const rows = await db.delete(schema.publicRequests).where(eq(schema.publicRequests.projectId, projectId)).returning()
  if (rows[0]) await audit({ actor, action: 'public.request.discard', targetType: 'project', targetId: projectId, params: { why }, result: 'ok' })
  return Boolean(rows[0])
}

export async function markRequestFailed(projectId: string, error: string): Promise<void> {
  await db.update(schema.publicRequests).set({ lastError: error.slice(0, 300) }).where(eq(schema.publicRequests.projectId, projectId))
}
