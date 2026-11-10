import { and, desc, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import {
  HEADER_DEFAULT, HEADER_LABEL, headerValueProblem, needsConfirmation,
  type HeaderKey, type HeaderMode, type HeaderRulesDto, type HeaderRecheckDto, type HeaderRuleDto,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { findProject } from '../domain/projects.js'
import type { Scope } from '../lib/scope.js'
import { probeTargetFor, reconcileCaddy } from '../domain/routes.js'
import { caddyTlsOptions, tlsPhase, withCloudflareEnv } from '../domain/cloudflare-settings.js'
import { audit } from '../domain/audit.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { parseCspReports, suggestCsp } from './header-rules.js'
import { recheckHeaders } from './scan.js'

/**
 * M8, Etappe 1: Header-Regeln pro Projekt. Dieselbe Service-Schicht für
 * Oberfläche, REST und MCP (SPEC). Jede Änderung: Regel speichern, Caddy
 * abgleichen, Stufe «headers» nachscannen.
 */

type Row = typeof schema.headerRules.$inferSelect

/** Höchstens so viele verschiedene CSP-Verstösse pro Projekt */
export const MAX_VIOLATIONS = 300

const toDto = (r: Row & { mode: 'report-only' | 'enforce' }): HeaderRuleDto => ({
  header: r.header, value: r.value, mode: r.mode, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
})
const isOwnRule = (r: Row): r is Row & { mode: 'report-only' | 'enforce' } => r.mode !== 'off'

/**
 * HSTS nur bei HTTPS und erst, wenn TLS stabil läuft: Wildcard-Zertifikat
 * der Produktions-CA, Einrichtung abgeschlossen («HTTPS aktiv»), und das
 * Projekt ist unter einem Namen der Basisdomain erreichbar.
 */
export async function hstsReadiness(projectId: string): Promise<{ ok: boolean; reason: string | null }> {
  // M9: Zertifikat der Umgebung des Projekts
  const envId = (await db.select({ env: schema.projects.environmentId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]?.env
  const tls = envId ? withCloudflareEnv(envId, caddyTlsOptions) : null
  if (!tls) return { ok: false, reason: 'HTTPS ist in dieser Umgebung nicht eingerichtet (Einstellungen → Cloudflare & HTTPS → Zertifikat).' }
  if (tls.acmeCa !== 'production' || (tls.mode ?? 'wildcard') !== 'wildcard') {
    return { ok: false, reason: 'Das Zertifikat ist noch im Probelauf. HSTS erst, wenn unter Einstellungen → Cloudflare & HTTPS «HTTPS aktiv» steht.' }
  }
  const phase = envId ? withCloudflareEnv(envId, tlsPhase) : null
  if (phase && phase !== 'done') return { ok: false, reason: `Die Zertifikats-Einrichtung ist noch nicht abgeschlossen (Phase «${phase}»).` }
  const probe = await probeTargetFor(projectId)
  if (!probe) return { ok: false, reason: 'Caddy bedient das Projekt gerade nicht (gestoppt oder ohne Adresse).' }
  if (!probe.secure) return { ok: false, reason: `${probe.host} liegt nicht unter der Basisdomain und ist nur über HTTP erreichbar.` }
  return { ok: true, reason: null }
}

export async function listHeaderRules(scope: Scope, idOrSlug: string): Promise<HeaderRulesDto> {
  const p = await findProject(scope, idOrSlug)
  const stored = await db.select().from(schema.headerRules).where(eq(schema.headerRules.projectId, p.id))
  const rules = stored.filter(isOwnRule)
  // M9: geerbte Vorlagen der Umgebung (ohne eigene Regel), abgeschaltete markiert
  const templates = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, p.environmentId))
  const inherited = templates
    .filter((t) => !rules.some((r) => r.header === t.header))
    .map((t) => ({ header: t.header, value: t.value, mode: t.mode, disabled: stored.some((r) => r.header === t.header && r.mode === 'off') }))
  const violations = await db
    .select()
    .from(schema.cspViolations)
    .where(eq(schema.cspViolations.projectId, p.id))
    .orderBy(desc(schema.cspViolations.count))
  const csp = rules.find((r) => r.header === 'content-security-policy')
  const s = violations.length ? suggestCsp(csp?.value ?? HEADER_DEFAULT['content-security-policy'], violations) : null
  return {
    rules: rules.map(toDto).sort((a, b) => a.header.localeCompare(b.header)),
    inherited,
    hsts: await hstsReadiness(p.id),
    viaCaddy: Boolean(await probeTargetFor(p.id)),
    csp: {
      violations: violations.slice(0, 100).map((v) => ({
        directive: v.directive, blocked: v.blocked, samplePath: v.samplePath, count: v.count, lastSeen: v.lastSeen.toISOString(),
      })),
      total: violations.reduce((n, v) => n + v.count, 0),
      // Nur zeigen, wenn er sich von der aktuellen Regel unterscheidet
      suggestion: s && s.policy !== csp?.value ? s.policy : null,
      notes: s?.notes ?? [],
    },
  }
}

export interface SetHeaderInput {
  value?: string
  mode: HeaderMode
  /** Rückfrage bestätigt (CSP scharf, HSTS) */
  confirm?: boolean
}

/**
 * Regel setzen oder ändern, Caddy abgleichen, Header nachscannen. CSP scharf
 * und HSTS nur mit Bestätigung; HSTS nur, wenn TLS stabil läuft.
 */
export async function setHeaderRule(
  scope: Scope,
  idOrSlug: string,
  header: HeaderKey,
  input: SetHeaderInput,
  actor: string,
): Promise<{ rule: HeaderRuleDto; recheck: HeaderRecheckDto }> {
  const p = await findProject(scope, idOrSlug)
  const existing = (await db.select().from(schema.headerRules).where(and(eq(schema.headerRules.projectId, p.id), eq(schema.headerRules.header, header))))[0]
  // HSTS kennt nur «scharf»; die anderen ausser CSP auch
  const mode: HeaderMode = header === 'content-security-policy' ? input.mode : 'enforce'
  const value = (input.value ?? existing?.value ?? HEADER_DEFAULT[header]).trim()
  const problem = headerValueProblem(header, value, mode)
  if (problem) throw badRequest(`${HEADER_LABEL[header]}: ${problem}`, [{ path: 'value', message: problem }])
  if (needsConfirmation(header, mode) && input.confirm !== true) {
    throw new AppError(
      'confirmation_required',
      header === 'strict-transport-security'
        ? 'HSTS verlangt eine ausdrückliche Bestätigung: Browser erzwingen danach HTTPS für diesen Namen.'
        : 'Eine scharfe Content-Security-Policy verlangt eine ausdrückliche Bestätigung: sie kann Teile der Seite blockieren.',
      409,
    )
  }
  if (header === 'strict-transport-security') {
    const ready = await hstsReadiness(p.id)
    if (!ready.ok) throw new AppError('hsts_not_ready', `HSTS noch nicht möglich: ${ready.reason}`, 409)
  }

  const now = new Date()
  const reportKey = header === 'content-security-policy' ? existing?.reportKey ?? randomBytes(18).toString('base64url') : null
  const saved = existing
    ? (await db.update(schema.headerRules).set({ value, mode, reportKey, updatedAt: now }).where(eq(schema.headerRules.id, existing.id)).returning())[0]!
    : (await db.insert(schema.headerRules).values({ projectId: p.id, header, value, mode, reportKey }).returning())[0]!

  await audit({
    actor, action: 'header.set', targetType: 'project', targetId: p.id,
    params: { header, value, mode, before: existing ? { value: existing.value, mode: existing.mode } : null }, result: 'ok',
  })
  await reconcileCaddy()
  const recheck = await recheckHeaders(p.id, actor).catch((err) => {
    log.warn('Nachscan der Header gescheitert', { project: p.slug, err: String(err) })
    return { ok: false, error: 'Nachscan gescheitert', fixed: [], opened: [], score: null, grade: null } satisfies HeaderRecheckDto
  })
  return { rule: toDto({ ...saved, mode }), recheck }
}

export async function removeHeaderRule(scope: Scope, idOrSlug: string, header: HeaderKey, actor: string): Promise<{ recheck: HeaderRecheckDto }> {
  const p = await findProject(scope, idOrSlug)
  const gone = await db
    .delete(schema.headerRules)
    .where(and(eq(schema.headerRules.projectId, p.id), eq(schema.headerRules.header, header)))
    .returning()
  if (!gone.length) throw notFound('Header-Regel')
  // Die gesammelten Verstösse gehören zur Regel; ohne sie wären sie veraltet
  if (header === 'content-security-policy') await db.delete(schema.cspViolations).where(eq(schema.cspViolations.projectId, p.id))
  await audit({ actor, action: 'header.remove', targetType: 'project', targetId: p.id, params: { header, value: gone[0]!.value, mode: gone[0]!.mode }, result: 'ok' })
  await reconcileCaddy()
  const recheck = await recheckHeaders(p.id, actor).catch(() => ({ ok: false, error: 'Nachscan gescheitert', fixed: [], opened: [], score: null, grade: null }))
  return { recheck }
}

/**
 * CSP-Meldungen eines Browsers speichern. Ohne gültigen Schlüssel: 404 (der
 * Endpunkt ist ohne Anmeldung erreichbar, aber nur aus LAN, Tailnet und dem
 * Projekt-Netz – Caddy lässt den Namen von Airlock von nirgends sonst durch).
 */
export async function recordCspReports(reportKey: string, body: unknown): Promise<number> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(reportKey)) throw notFound('Report-Ziel')
  const rule = (await db.select().from(schema.headerRules).where(eq(schema.headerRules.reportKey, reportKey)).limit(1))[0]
  if (!rule) throw notFound('Report-Ziel')
  const reports = parseCspReports(body)
  if (!reports.length) return 0
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.cspViolations).where(eq(schema.cspViolations.projectId, rule.projectId))
  let room = MAX_VIOLATIONS - n
  let stored = 0
  for (const v of reports) {
    const now = new Date()
    // Bestehende Zeile zählen; eine neue nur, solange Platz ist
    const upd = await db
      .update(schema.cspViolations)
      .set({ count: sql`${schema.cspViolations.count} + 1`, lastSeen: now, samplePath: v.path })
      .where(and(eq(schema.cspViolations.projectId, rule.projectId), eq(schema.cspViolations.directive, v.directive), eq(schema.cspViolations.blocked, v.blocked)))
      .returning({ id: schema.cspViolations.id })
    if (upd.length) {
      stored++
      continue
    }
    if (room <= 0) continue
    await db.insert(schema.cspViolations).values({ projectId: rule.projectId, directive: v.directive, blocked: v.blocked, samplePath: v.path }).onConflictDoNothing()
    // Aus der Meldung nur Direktive und blockierte Quelle ins Log – nie Body, Seite oder Skriptauszug
    log.info('Neuer CSP-Verstoss gemeldet', { project: rule.projectId, directive: v.directive, blocked: v.blocked })
    room--
    stored++
  }
  return stored
}

/** Header-Regeln eines Projekts als Text für MCP-Antworten. */
export function describeRule(r: HeaderRuleDto): string {
  return `${HEADER_LABEL[r.header]}${r.mode === 'report-only' ? ' (Report-Only)' : ''}: ${r.value}`
}
