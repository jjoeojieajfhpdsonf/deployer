import { and, desc, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import {
  HEADER_DEFAULT, HEADER_LABEL, headerValueProblem, needsConfirmation,
  type HeaderKey, type HeaderMode, type HeaderRulesDto, type HeaderRecheckDto, type HeaderRuleDto,
  type CspAnalysisDto, type CspCheckDto, type CspEnforceReadinessDto,
} from '@airlock/shared'
import { analyzeProjectPages, browserCheck, viewsSince } from './csp-check.js'
import { conflictsFor, conflictSummary, suggestWithAnalysis, readinessFrom, VIEWS_NEEDED } from './csp-analysis.js'
import { db, schema } from '../db/index.js'
import { findProject } from '../domain/projects.js'
import { probeTargetFor, reconcileCaddy } from '../domain/routes.js'
import { caddyTlsOptions, tlsPhase } from '../domain/cloudflare-settings.js'
import { audit } from '../domain/audit.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { parseCspReports, suggestCsp } from './header-rules.js'
import { recheckHeaders, latestScan } from './scan.js'

/**
 * M8, Etappe 1: Header-Regeln pro Projekt. Dieselbe Service-Schicht für
 * Oberfläche, REST und MCP (SPEC). Jede Änderung: Regel speichern, Caddy
 * abgleichen, Stufe «headers» nachscannen.
 */

type Row = typeof schema.headerRules.$inferSelect

/** Höchstens so viele verschiedene CSP-Verstösse pro Projekt */
export const MAX_VIOLATIONS = 300

const toDto = (r: Row): HeaderRuleDto => ({
  header: r.header, value: r.value, mode: r.mode, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  ...(r.header === 'content-security-policy' ? { reportOnlySince: r.reportOnlySince?.toISOString() ?? null, check: r.checkResult ?? null } : {}),
})

/* --- CSP-Fix: Analyse, Freigabe zum Scharfschalten ------------------------------- */

type Violation = typeof schema.cspViolations.$inferSelect

/** Ab wann eine Regel im Report-Only «gilt»: Beginn von Report-Only oder letzte Änderung des Werts. */
const reportOnlyWindowStart = (r: Row) => new Date(Math.max(r.reportOnlySince?.getTime() ?? r.updatedAt.getTime(), r.updatedAt.getTime()))

/**
 * Darf diese CSP scharf werden? Ja, wenn die Analyse der ausgelieferten
 * Seiten keinen Konflikt findet – oder wenn Report-Only mit genau diesem Wert
 * mindestens VIEWS_NEEDED Aufrufe ohne Verstoss gesehen hat.
 */
export async function cspReadiness(r: Row, analysis: Omit<CspAnalysisDto, 'conflicts'>, conflicts: string[], violations: Violation[]): Promise<CspEnforceReadinessDto> {
  if (r.mode === 'enforce') return { ...readinessFrom({ enforced: true, analysisError: null, conflicts: [], views: null, violationsSince: 0 }), views: null, viewsNeeded: VIEWS_NEEDED, violationsSince: 0 }
  const since = reportOnlyWindowStart(r)
  const violationsSince = violations.filter((v) => v.lastSeen >= since).length
  const views = await viewsSince(r.projectId, since)
  return { ...readinessFrom({ enforced: false, analysisError: analysis.error, conflicts, views, violationsSince }), views, viewsNeeded: VIEWS_NEEDED, violationsSince }
}

/** ID des Befunds «Content-Security-Policy fehlt» im letzten abgeschlossenen Scan */
async function cspFindingId(projectId: string): Promise<string | null> {
  const last = await latestScan(projectId, true)
  if (!last) return null
  const f = (await db.select({ id: schema.findings.id, title: schema.findings.title, tool: schema.findings.tool }).from(schema.findings).where(eq(schema.findings.scanRunId, last.id)))
    .find((x) => x.tool === 'header-check' && x.title.startsWith('Content-Security-Policy fehlt'))
  return f?.id ?? null
}

/** Auftrag an Claude: Inline-Code auslagern, damit die CSP ohne 'unsafe-inline' geht. */
function inlinePrompt(p: { name: string; slug: string }, findingId: string, summary: string): string {
  return [
    `Lagere im Airlock-Projekt «${p.name}» (${p.slug}) den Inline-Code in eigene Dateien aus, damit eine Content-Security-Policy ohne 'unsafe-inline' funktioniert. ${summary}`,
    `Hole Befund und Dateien mit dem Airlock-MCP: get_fix_context mit project "${p.slug}" und finding "${findingId}".`,
    'Verschiebe <script>-Inhalte in .js-Dateien und <style>-Inhalte in .css-Dateien, ersetze style="…" durch Klassen und onclick=… durch addEventListener. Schlage die Änderung mit propose_fix vor; ich prüfe den Diff in Airlock.',
  ].join('\n')
}

/**
 * HSTS nur bei HTTPS und erst, wenn TLS stabil läuft: Wildcard-Zertifikat
 * der Produktions-CA, Einrichtung abgeschlossen («HTTPS aktiv»), und das
 * Projekt ist unter einem Namen der Basisdomain erreichbar.
 */
export async function hstsReadiness(projectId: string): Promise<{ ok: boolean; reason: string | null }> {
  const tls = caddyTlsOptions()
  if (!tls) return { ok: false, reason: 'HTTPS ist nicht eingerichtet (System → Cloudflare → Zertifikat).' }
  if (tls.acmeCa !== 'production' || (tls.mode ?? 'wildcard') !== 'wildcard') {
    return { ok: false, reason: 'Das Zertifikat ist noch im Probelauf. HSTS erst, wenn unter System → Cloudflare «HTTPS aktiv» steht.' }
  }
  const phase = tlsPhase()
  if (phase && phase !== 'done') return { ok: false, reason: `Die Zertifikats-Einrichtung ist noch nicht abgeschlossen (Phase «${phase}»).` }
  const probe = await probeTargetFor(projectId)
  if (!probe) return { ok: false, reason: 'Caddy bedient das Projekt gerade nicht (gestoppt oder ohne Adresse).' }
  if (!probe.secure) return { ok: false, reason: `${probe.host} liegt nicht unter der Basisdomain und ist nur über HTTP erreichbar.` }
  return { ok: true, reason: null }
}

export async function listHeaderRules(idOrSlug: string): Promise<HeaderRulesDto> {
  const p = await findProject(idOrSlug)
  const rules = await db.select().from(schema.headerRules).where(eq(schema.headerRules.projectId, p.id))
  const violations = await db
    .select()
    .from(schema.cspViolations)
    .where(eq(schema.cspViolations.projectId, p.id))
    .orderBy(desc(schema.cspViolations.count))
  const csp = rules.find((r) => r.header === 'content-security-policy')
  const viaCaddy = Boolean(await probeTargetFor(p.id))
  const s = violations.length ? suggestCsp(csp?.value ?? HEADER_DEFAULT['content-security-policy'], violations) : null
  // CSP-Fix: die ausgelieferten Seiten kennen, bevor vorgeschlagen oder scharf geschaltet wird
  let analysis: CspAnalysisDto | null = null
  let readiness: CspEnforceReadinessDto | null = null
  let suggestion = s?.policy ?? null
  const notes = [...(s?.notes ?? [])]
  let prompt: string | null = null
  // Projektseite: auch ohne CSP-Regel analysieren (gecacht, 60 s) – die
  // Security-Karte zeigt schon vor dem Setzen, ob Inline-Code im Weg ist.
  const target = csp?.value ?? HEADER_DEFAULT['content-security-policy']
  if (csp || viaCaddy) {
    const pages = await analyzeProjectPages(p.id)
    const { pageUrls: _u, ...a } = pages
    const conflicts = a.error ? [] : conflictsFor(target, a)
    analysis = { ...a, conflicts }
    if (!a.error && csp) {
      // Externe Quellen der Seiten in den Vorschlag; Inline-Code nur als Warnung
      suggestion = suggestWithAnalysis(suggestion ?? csp.value, a)
      const summary = conflictSummary(a, suggestion)
      if (summary) {
        notes.unshift(summary)
        const fid = (p.sourceType === 'files' || p.sourceType === 'dockerfile' || p.sourceType === 'compose') ? await cspFindingId(p.id) : null
        if (fid) prompt = inlinePrompt(p, fid, summary)
      }
    }
    if (csp) readiness = await cspReadiness(csp, a, conflicts, violations)
  }
  return {
    rules: rules.map(toDto).sort((a, b) => a.header.localeCompare(b.header)),
    hsts: await hstsReadiness(p.id),
    viaCaddy,
    csp: {
      violations: violations.slice(0, 100).map((v) => ({
        directive: v.directive, blocked: v.blocked, samplePath: v.samplePath, count: v.count, lastSeen: v.lastSeen.toISOString(),
      })),
      total: violations.reduce((n, v) => n + v.count, 0),
      // Nur zeigen, wenn er sich von der aktuellen Regel unterscheidet
      suggestion: suggestion && suggestion !== csp?.value ? suggestion : null,
      notes: [...new Set(notes)],
      analysis,
      readiness,
      inlinePrompt: prompt,
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
  idOrSlug: string,
  header: HeaderKey,
  input: SetHeaderInput,
  actor: string,
): Promise<{ rule: HeaderRuleDto; recheck: HeaderRecheckDto }> {
  const p = await findProject(idOrSlug)
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
  const cspEnforce = header === 'content-security-policy' && mode === 'enforce' && existing?.mode !== 'enforce'
  if (cspEnforce) {
    // CSP-Fix: nur scharf, wenn Analyse oder Report-Only es belegen
    if (!existing) throw new AppError('csp_not_ready', 'Eine CSP startet immer als Report-Only.', 409)
    const draft: Row = { ...existing, value: existing.value === value ? existing.value : value, updatedAt: existing.value === value ? existing.updatedAt : new Date() }
    const pages = await analyzeProjectPages(p.id, { fresh: true })
    const conflicts = pages.error ? [] : conflictsFor(value, pages)
    const violations = await db.select().from(schema.cspViolations).where(eq(schema.cspViolations.projectId, p.id))
    const ready = await cspReadiness(draft, pages, conflicts, violations)
    if (!ready.ok) throw new AppError('csp_not_ready', `Noch nicht scharf schaltbar: ${ready.reason}`, 409)
  }

  const now = new Date()
  const reportKey = header === 'content-security-policy' ? existing?.reportKey ?? randomBytes(18).toString('base64url') : null
  // Report-Only-Beginn merken (Aufrufe zählen ab hier); scharf: Prüfung läuft
  const cspFields = header !== 'content-security-policy' ? {}
    : mode === 'report-only'
      ? { reportOnlySince: existing?.mode === 'report-only' ? existing.reportOnlySince ?? now : now, checkResult: null }
      : cspEnforce
        ? { checkResult: { state: 'running', at: now.toISOString(), pages: [], violations: [], message: 'Funktionsprüfung im Browser läuft …' } satisfies CspCheckDto }
        : {}
  const saved = existing
    ? (await db.update(schema.headerRules).set({ value, mode, reportKey, updatedAt: now, ...cspFields }).where(eq(schema.headerRules.id, existing.id)).returning())[0]!
    : (await db.insert(schema.headerRules).values({ projectId: p.id, header, value, mode, reportKey, ...cspFields }).returning())[0]!

  await audit({
    actor, action: 'header.set', targetType: 'project', targetId: p.id,
    params: { header, value, mode, before: existing ? { value: existing.value, mode: existing.mode } : null }, result: 'ok',
  })
  await reconcileCaddy()
  if (cspEnforce) {
    // «Behoben» erst nach der Funktionsprüfung; die läuft im Hintergrund
    void runEnforceCheck(p.id, actor)
    return {
      rule: toDto(saved),
      recheck: { ok: true, error: null, fixed: [], opened: [], score: null, grade: null, pending: 'Funktionsprüfung im Browser läuft; «behoben» erst danach. Findet sie Verstösse, geht die CSP automatisch auf Report-Only zurück.' },
    }
  }
  const recheck = await recheckHeaders(p.id, actor).catch((err) => {
    log.warn('Nachscan der Header gescheitert', { project: p.slug, err: String(err) })
    return { ok: false, error: 'Nachscan gescheitert', fixed: [], opened: [], score: null, grade: null } satisfies HeaderRecheckDto
  })
  return { rule: toDto(saved), recheck }
}

/** Laufende Prüfungen (eine pro Projekt) – für Tests und die Oberfläche */
const checks = new Map<string, Promise<CspCheckDto>>()
export const pendingCheck = (projectId: string) => checks.get(projectId) ?? null

/**
 * Nach dem Scharfschalten: Seiten im Headless-Browser laden. Ohne Verstoss:
 * Header nachscannen (Befund «behoben»). Mit Verstoss oder ohne Prüfung:
 * zurück auf Report-Only, Meldung an der Regel und im Audit-Log.
 */
export function runEnforceCheck(projectId: string, actor: string): Promise<CspCheckDto> {
  const run = (async (): Promise<CspCheckDto> => {
    const p = await findProject(projectId)
    const pages = await analyzeProjectPages(p.id, { fresh: true })
    const r = await browserCheck(p.id, p.slug, pages.pageUrls)
    const at = new Date()
    const rule = (await db.select().from(schema.headerRules).where(and(eq(schema.headerRules.projectId, p.id), eq(schema.headerRules.header, 'content-security-policy'))))[0]
    if (!rule || rule.mode !== 'enforce') return { ...r, at: at.toISOString() } // inzwischen geändert
    if (r.state === 'ok') {
      const check: CspCheckDto = { ...r, at: at.toISOString() }
      await db.update(schema.headerRules).set({ checkResult: check }).where(eq(schema.headerRules.id, rule.id))
      await audit({ actor, action: 'header.csp_check', targetType: 'project', targetId: p.id, params: { state: r.state, pages: r.pages }, result: 'ok' })
      await recheckHeaders(p.id, actor).catch((err) => log.warn('Nachscan der Header gescheitert', { project: p.slug, err: String(err) }))
      return check
    }
    const check: CspCheckDto = {
      ...r, at: at.toISOString(),
      message: `Zurück auf Report-Only. ${r.message}`,
    }
    await db.update(schema.headerRules).set({ mode: 'report-only', reportOnlySince: at, updatedAt: at, checkResult: check }).where(eq(schema.headerRules.id, rule.id))
    await audit({ actor: 'system', action: 'header.csp_reverted', targetType: 'project', targetId: p.id, params: { state: r.state, violations: r.violations, pages: r.pages }, result: 'error', error: r.message })
    log.warn('CSP zurück auf Report-Only', { project: p.slug, state: r.state, violations: r.violations })
    await reconcileCaddy()
    await recheckHeaders(p.id, actor).catch(() => {})
    return check
  })().finally(() => checks.delete(projectId))
  checks.set(projectId, run)
  return run
}

/**
 * Einfacher Rückweg: CSP scharf -> Report-Only; jede andere Regel (auch eine
 * CSP im Report-Only) wird entfernt.
 */
export async function resetHeaderRule(idOrSlug: string, header: HeaderKey, actor: string): Promise<{ recheck: HeaderRecheckDto; result: 'report-only' | 'removed' }> {
  const p = await findProject(idOrSlug)
  const rule = (await db.select().from(schema.headerRules).where(and(eq(schema.headerRules.projectId, p.id), eq(schema.headerRules.header, header))))[0]
  if (!rule) throw notFound('Header-Regel')
  if (header === 'content-security-policy' && rule.mode === 'enforce') {
    const r = await setHeaderRule(p.id, header, { mode: 'report-only' }, actor)
    return { recheck: r.recheck, result: 'report-only' }
  }
  return { ...(await removeHeaderRule(p.id, header, actor)), result: 'removed' }
}

export async function removeHeaderRule(idOrSlug: string, header: HeaderKey, actor: string): Promise<{ recheck: HeaderRecheckDto }> {
  const p = await findProject(idOrSlug)
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
