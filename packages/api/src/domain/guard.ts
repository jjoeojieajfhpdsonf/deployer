import { adminUiPublicMessage, detectAdminUi, type AccessGuard, type ExternalSource } from '@airlock/shared'
import type { schema } from '../db/index.js'
import { AppError } from '../lib/errors.js'

type Row = typeof schema.projects.$inferSelect

/**
 * Zugang (Schutz vorschalten) und Schutz-Pflicht für Admin-Oberflächen.
 * Rein bis auf den Fehler – ohne Datenbank testbar.
 */

/**
 * Bestehender Dienst: Airlock verwaltet ihn nicht – kein Deploy, kein Start,
 * Stopp oder Neustart, kein Rollback, keine Dateien. Ein Fehler mit klarem Text
 * statt eines halben Vorgangs.
 */
export function assertManaged(p: { sourceType: string }, what = 'Das'): void {
  if (p.sourceType === 'external') {
    throw new AppError('not_managed', `${what} geht bei einem bestehenden Dienst nicht: Er wird nicht von Airlock verwaltet – Airlock macht ihn nur erreichbar.`, 409)
  }
}

/** Zugang aus Login-Schalter und Cloudflare Access der öffentlichen Route (Login hat Vorrang) */
export function accessGuardOf(loginGuard: boolean, routes: { target: string; accessProtected?: boolean }[]): AccessGuard {
  if (loginGuard) return 'login'
  return routes.some((x) => x.target === 'public' && x.accessProtected) ? 'cloudflare' : 'offen'
}

/** Bekannte Admin-Oberfläche: bei «external» beim Anlegen erkannt (Image oder Titel), sonst am Image der Quelle */
export function adminUiOf(r: Pick<Row, 'sourceType' | 'sourceConfig'>): { key: string; name: string } | null {
  if (r.sourceType === 'external') return (r.sourceConfig as ExternalSource).resolved?.adminUi ?? null
  if (r.sourceType === 'image') return detectAdminUi({ image: (r.sourceConfig as { image?: string }).image ?? null })
  return null
}

/**
 * Bekannte Admin-Oberflächen (shared ADMIN_UIS) dürfen nur mit Schutz
 * öffentlich werden: Airlock-Login oder Cloudflare Access. Übersteuern geht nur
 * nach erneuter Bestätigung (sudo, POST /projects/:id/admin-override). Gilt für
 * jeden Weg nach «öffentlich» – Oberfläche, MCP, nach dem ersten Scan – und für
 * das Abschalten des Schutzes an einer öffentlichen Route.
 */
export function publicGuardProblem(
  p: Pick<Row, 'sourceType' | 'sourceConfig' | 'loginGuard' | 'adminOverrideAt'>,
  will: { accessProtected: boolean; loginGuard?: boolean },
): { name: string; message: string } | null {
  const admin = adminUiOf(p)
  if (!admin) return null
  const protectedNow = will.accessProtected || (will.loginGuard ?? p.loginGuard)
  if (protectedNow || p.adminOverrideAt) return null
  return { name: admin.name, message: adminUiPublicMessage(admin.name) }
}

export function assertPublicGuarded(p: Pick<Row, 'sourceType' | 'sourceConfig' | 'loginGuard' | 'adminOverrideAt'>, will: { accessProtected: boolean; loginGuard?: boolean }): void {
  const problem = publicGuardProblem(p, will)
  if (problem) throw new AppError('guard_required', problem.message, 409, { adminUi: problem.name })
}
