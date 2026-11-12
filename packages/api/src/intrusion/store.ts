import { and, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  INCIDENT_SEVERITY_LABEL, INCIDENT_STATUS_LABEL, INTRUSION_LEARN_MINUTES, NORMALIZABLE_KINDS, incidentSeverities,
  intrusionIncidentUpdateSchema, intrusionSettingsSchema,
  type IncidentCountsDto, type IntrusionIncidentDetailDto as IncidentDetailDto, type IntrusionIncidentDto as IncidentDto, type IncidentEventKind, type IncidentListDto, type IncidentListQuery,
  type IncidentSeverity, type ProjectIntrusionDto,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import type { IsolationRecord } from '../db/schema.js'
import * as docker from '../drivers/docker.js'
import { audit } from '../domain/audit.js'
import { activeDeployment, effectiveKind } from '../domain/deployments.js'
import { stopProject } from '../domain/lifecycle.js'
import { pausePublic, publicRoute } from '../domain/public.js'
import { setEgressSettings } from '../egress/service.js'
import { publish } from '../lib/events.js'
import { badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { serverJob, type ListScope, type Scope } from '../lib/scope.js'
import { notify } from '../notify/send.js'
import { bundleSignals, mergeSignals, shouldAutoStop, shouldNotify, type OpenIncident } from './bundle.js'
import { egressTargetsOf, normalFileEntries, type Signal } from './rules.js'

/**
 * Nacht 3, Etappe 5: Vorfälle speichern (bündeln, Verlauf, melden, reagieren)
 * und für Oberfläche, API und MCP lesen. Die Bewertung selbst ist rein
 * (rules.ts, bundle.ts); hier passiert nur, was Datenbank, Benachrichtigung
 * und Docker braucht.
 */

type IncidentRow = typeof schema.incidents.$inferSelect
type Project = typeof schema.projects.$inferSelect

const SYSTEM_ACTOR = 'system:einbruchserkennung'

let chain: Promise<unknown> = Promise.resolve()
/** Nacheinander: zwei Runden dürfen denselben Vorfall nicht zweimal anlegen */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

async function addEvent(incidentId: string, kind: IncidentEventKind, text: string, actor: string | null = null, at = new Date()): Promise<void> {
  await db.insert(schema.incidentEvents).values({ incidentId, kind, text: text.slice(0, 1000), actor, at })
}

/* --- Hinweise → Vorfälle ------------------------------------------------------------------ */

export interface RecordResult { created: number; updated: number; notified: number }

/**
 * Hinweise einer Runde speichern: bündeln (bundle.ts), Verlauf schreiben,
 * hoch/kritisch melden (gedrosselt) und – wenn eingeschaltet – bei einem
 * kritischen Vorfall Container stoppen und die öffentliche Seite pausieren.
 */
export function recordSignals(signals: readonly Signal[], o: { notify?: boolean } = {}): Promise<RecordResult> {
  if (!signals.length) return Promise.resolve({ created: 0, updated: 0, notified: 0 })
  return serial(async () => {
    // Projekte, die es (noch) gibt; Hinweise zu gelöschten fallen weg
    const ids = [...new Set(signals.map((s) => s.projectId).filter((x): x is string => x !== null))]
    const known = new Set(ids.length ? (await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.id, ids))).map((r) => r.id) : [])
    const usable = signals.filter((s) => s.projectId === null || known.has(s.projectId))
    const fps = [...mergeSignals(usable).keys()]
    if (!fps.length) return { created: 0, updated: 0, notified: 0 }
    const open = await db.select().from(schema.incidents).where(and(inArray(schema.incidents.fingerprint, fps), ne(schema.incidents.status, 'erledigt')))
    const plan = bundleSignals(open.map(toOpen), usable)
    const touched: IncidentRow[] = []
    const escalated = new Set<string>()
    for (const c of plan.create) {
      const s = c.signal
      const [row] = await db.insert(schema.incidents).values({
        projectId: s.projectId, fingerprint: c.fingerprint, source: s.source, kind: s.kind, severity: s.severity,
        title: s.title.slice(0, 300), subject: s.subject?.slice(0, 300) ?? null, service: s.service, samples: c.samples,
        count: c.count, firstSeen: s.at, lastSeen: s.at, repeatLoggedAt: s.at,
      }).onConflictDoNothing().returning()
      if (!row) continue
      await addEvent(row.id, 'erkannt', `Erkannt (${INCIDENT_SEVERITY_LABEL[s.severity]})${c.count > 1 ? `, ${c.count}×` : ''}${s.samples[0] ? `: ${s.samples[0]}` : ''}`, null, s.at)
      touched.push(row)
    }
    for (const u of plan.update) {
      const [row] = await db.update(schema.incidents).set({
        count: u.count, severity: u.severity, status: u.status, samples: u.samples, lastSeen: u.lastSeen,
        ...(u.logRepeat ? { repeatLoggedAt: u.lastSeen } : {}),
      }).where(eq(schema.incidents.id, u.id)).returning()
      if (!row) continue
      if (u.escalatedFrom) {
        escalated.add(row.id)
        await addEvent(row.id, 'hochgestuft', `Schweregrad ${INCIDENT_SEVERITY_LABEL[u.escalatedFrom]} → ${INCIDENT_SEVERITY_LABEL[u.severity]}${u.samples[0] ? `: ${u.samples[0]}` : ''}`, null, u.lastSeen)
      } else if (u.logRepeat) {
        await addEvent(row.id, 'erneut', `Erneut gesehen (+${u.added}, insgesamt ${u.count}×)`, null, u.lastSeen)
      }
      touched.push(row)
    }
    let notified = 0
    if (o.notify !== false) {
      for (const row of touched) notified += (await afterRecord(row, escalated.has(row.id))) ? 1 : 0
    }
    for (const pid of new Set(touched.map((r) => r.projectId))) publish({ type: 'incident', projectId: pid })
    return { created: plan.create.length, updated: plan.update.length, notified }
  })
}

function toOpen(r: IncidentRow): OpenIncident {
  return { id: r.id, fingerprint: r.fingerprint, severity: r.severity, status: r.status, count: r.count, samples: r.samples ?? [], lastSeen: r.lastSeen, repeatLoggedAt: r.repeatLoggedAt }
}

async function projectRow(id: string | null): Promise<Project | null> {
  if (!id) return null
  return (await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1))[0] ?? null
}

/** Melden und reagieren; true = gemeldet */
async function afterRecord(row: IncidentRow, escalated: boolean): Promise<boolean> {
  const now = new Date()
  const project = await projectRow(row.projectId)
  let reaction: string | null = null
  if (project && shouldAutoStop({ severity: row.severity, autoStop: project.incidentAutoStop, reactedAt: row.reactedAt, projectId: row.projectId })) {
    reaction = await autoStop(row, project).catch((err) => {
      log.error('Reaktion auf kritischen Vorfall gescheitert', { project: project.slug, err: String(err) })
      return `Stoppen gescheitert: ${(err as Error).message}`
    })
  }
  const sent = await db.select({ n: sql<number>`count(*)::int` }).from(schema.incidentEvents)
    .where(and(eq(schema.incidentEvents.kind, 'gemeldet'), gte(schema.incidentEvents.at, new Date(now.getTime() - 3_600_000))))
  if (!shouldNotify({ severity: row.severity, notifiedAt: row.notifiedAt, notifiedSeverity: row.notifiedSeverity, sentLastHour: Number(sent[0]?.n ?? 0), now })) return false
  const r = await notify('incident', {
    title: row.title, project: project?.name ?? null, severity: row.severity, count: row.count,
    since: row.firstSeen.toISOString().replace('T', ' ').slice(0, 16) + ' UTC', samples: row.samples, escalated, reaction,
  }, row.projectId ?? undefined)
  await db.update(schema.incidents).set({ notifiedAt: now, notifiedSeverity: row.severity }).where(eq(schema.incidents.id, row.id))
  const via = [r.push && 'Push', r.email && 'E-Mail'].filter(Boolean).join(' und ')
  await addEvent(row.id, 'gemeldet', via ? `Per ${via} gemeldet` : 'Gemeldet (Glocke; kein Kanal eingerichtet oder ausgeschaltet)', null, now)
  return true
}

/** «Bei kritischem Vorfall Container stoppen und Seite in Pause schalten» */
async function autoStop(row: IncidentRow, project: Project): Promise<string> {
  const done: string[] = []
  const route = await publicRoute(project.id)
  if (route && !route.pausedAt) {
    await pausePublic(project, SYSTEM_ACTOR)
    done.push('öffentliche Seite pausiert')
  }
  if (project.desiredState === 'running') {
    await stopProject(serverJob('einbruchserkennung'), project.id, SYSTEM_ACTOR)
    done.push('Container gestoppt')
  }
  const text = done.length ? `Automatisch: ${done.join(', ')}` : 'Automatisch: nichts zu tun (schon gestoppt und nicht öffentlich)'
  await db.update(schema.incidents).set({ reactedAt: new Date() }).where(eq(schema.incidents.id, row.id))
  await addEvent(row.id, 'reaktion', text, SYSTEM_ACTOR)
  await audit({ actor: SYSTEM_ACTOR, action: 'incident.auto_stop', targetType: 'project', targetId: project.id, params: { incident: row.id, title: row.title, done }, result: 'ok' })
  return text
}

/* --- Lesen ---------------------------------------------------------------------------------- */

function toDto(r: IncidentRow, project: { id: string; name: string } | null): IncidentDto {
  return {
    id: r.id,
    project,
    source: r.source,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    title: r.title,
    subject: r.subject,
    service: r.service,
    count: r.count,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    note: r.note,
    samples: r.samples ?? [],
    notifiedAt: r.notifiedAt?.toISOString() ?? null,
    reactedAt: r.reactedAt?.toISOString() ?? null,
    canMarkNormal: r.projectId !== null && NORMALIZABLE_KINDS.includes(r.kind),
  }
}

/** Sichtbar in einer Umgebung: ihre Projekte und die Server-Vorfälle (wie im Audit-Log) */
function scopeCond(scope: ListScope): SQL | undefined {
  if (scope.kind !== 'env') return undefined
  return or(isNull(schema.incidents.projectId), inArray(schema.incidents.projectId, db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.environmentId, scope.envId))))
}

async function projectNames(rows: IncidentRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => x !== null))]
  if (!ids.length) return new Map()
  return new Map((await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, ids))).map((p) => [p.id, p.name]))
}

const SEVERITY_ORDER = sql`CASE ${schema.incidents.severity} WHEN 'kritisch' THEN 3 WHEN 'hoch' THEN 2 WHEN 'mittel' THEN 1 ELSE 0 END`

export async function incidentCounts(scope: ListScope, projectId?: string): Promise<IncidentCountsDto> {
  const conds = [ne(schema.incidents.status, 'erledigt'), scopeCond(scope), projectId ? eq(schema.incidents.projectId, projectId) : undefined].filter((c): c is SQL => c !== undefined)
  const rows = await db.select({ severity: schema.incidents.severity, status: schema.incidents.status, n: sql<number>`count(*)::int` })
    .from(schema.incidents).where(and(...conds)).groupBy(schema.incidents.severity, schema.incidents.status)
  const active = Object.fromEntries(incidentSeverities.map((s) => [s, 0])) as Record<IncidentSeverity, number>
  let unseen = 0
  for (const r of rows) {
    active[r.severity] += Number(r.n)
    if (r.status === 'offen') unseen += Number(r.n)
  }
  return { active, unseen }
}

export async function listIncidents(scope: ListScope, q: IncidentListQuery): Promise<IncidentListDto> {
  const conds: SQL[] = []
  const sc = scopeCond(scope)
  if (sc) conds.push(sc)
  if (q.status === 'aktiv') conds.push(ne(schema.incidents.status, 'erledigt'))
  else if (q.status !== 'alle') conds.push(eq(schema.incidents.status, q.status))
  if (q.projectId) conds.push(eq(schema.incidents.projectId, q.projectId))
  const rows = await db.select().from(schema.incidents).where(conds.length ? and(...conds) : undefined)
    // Offene vor gesehenen, dann nach Schwere, dann neueste
    .orderBy(sql`CASE ${schema.incidents.status} WHEN 'offen' THEN 0 WHEN 'gesehen' THEN 1 ELSE 2 END`, desc(SEVERITY_ORDER), desc(schema.incidents.lastSeen))
    .limit(q.limit)
  const names = await projectNames(rows)
  return {
    incidents: rows.map((r) => toDto(r, r.projectId ? { id: r.projectId, name: names.get(r.projectId) ?? '?' } : null)),
    counts: await incidentCounts(scope, q.projectId),
  }
}

async function findIncident(scope: Scope, id: string): Promise<IncidentRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Vorfall')
  const row = (await db.select().from(schema.incidents).where(eq(schema.incidents.id, id)).limit(1))[0]
  if (!row) throw notFound('Vorfall')
  if (scope.kind === 'env' && row.projectId) {
    const p = await projectRow(row.projectId)
    if (!p || p.environmentId !== scope.envId) throw notFound('Vorfall')
  }
  return row
}

export async function getIncident(scope: Scope, id: string): Promise<IncidentDetailDto> {
  const row = await findIncident(scope, id)
  const names = await projectNames([row])
  const events = await db.select().from(schema.incidentEvents).where(eq(schema.incidentEvents.incidentId, id)).orderBy(desc(schema.incidentEvents.at), desc(schema.incidentEvents.id)).limit(200)
  return {
    ...toDto(row, row.projectId ? { id: row.projectId, name: names.get(row.projectId) ?? '?' } : null),
    events: events.map((e) => ({ at: e.at.toISOString(), kind: e.kind, text: e.text, actor: e.actor })),
  }
}

/* --- Ändern --------------------------------------------------------------------------------- */

export async function updateIncident(scope: Scope, id: string, body: unknown, actor: string): Promise<IncidentDetailDto> {
  const input = intrusionIncidentUpdateSchema.parse(body ?? {})
  const row = await findIncident(scope, id)
  const set: Partial<IncidentRow> = {}
  if (input.status && input.status !== row.status) {
    // Ein erledigter Vorfall kommt nicht zurück, wenn derselbe Hinweis inzwischen einen neuen geöffnet hat
    if (row.status === 'erledigt') {
      const other = await db.select({ id: schema.incidents.id }).from(schema.incidents)
        .where(and(eq(schema.incidents.fingerprint, row.fingerprint), ne(schema.incidents.status, 'erledigt'))).limit(1)
      if (other.length) throw badRequest('Zu diesem Hinweis gibt es schon einen neueren offenen Vorfall')
    }
    set.status = input.status
    set.resolvedAt = input.status === 'erledigt' ? new Date() : null
  }
  if (input.note !== undefined) set.note = input.note ? input.note : null
  if (!Object.keys(set).length) return getIncident(scope, id)
  await db.update(schema.incidents).set(set).where(eq(schema.incidents.id, id))
  if (set.status) await addEvent(id, 'status', `Status: ${INCIDENT_STATUS_LABEL[row.status]} → ${INCIDENT_STATUS_LABEL[set.status]}`, actor)
  if (input.note !== undefined && (input.note || null) !== row.note) await addEvent(id, 'notiz', input.note ? `Notiz: ${input.note}` : 'Notiz entfernt', actor)
  await audit({
    actor, action: 'incident.update', targetType: row.projectId ? 'project' : null, targetId: row.projectId ?? null,
    ...(row.projectId ? {} : { environmentId: null }),
    params: { incident: id, title: row.title, ...(set.status ? { status: set.status } : {}), ...(input.note !== undefined ? { note: Boolean(input.note) } : {}) }, result: 'ok',
  })
  publish({ type: 'incident', projectId: row.projectId })
  return getIncident(scope, id)
}

/**
 * «Als normal markieren»: erweitert die Grundlinie des Projekts (gilt für
 * alle künftigen Container) und schliesst den Vorfall. Prozesse: das
 * Programm (für diesen Dienst); Dateien: die Ordner der Beispiele (ausführbare
 * Dateien genau); Netz: die Ziele (die Sperre bleibt – nur keine Meldung mehr).
 */
export async function markNormal(scope: Scope, id: string, actor: string): Promise<IncidentDetailDto> {
  const row = await findIncident(scope, id)
  if (!row.projectId || !NORMALIZABLE_KINDS.includes(row.kind)) throw badRequest('Diesen Vorfall kann man nicht als normal markieren')
  const service = row.service ?? ''
  const entries: { kind: 'prozess' | 'datei' | 'netz'; value: string }[] =
    row.source === 'prozess' ? (row.subject ? [{ kind: 'prozess', value: row.subject }] : [])
      : row.source === 'datei' ? normalFileEntries(row.kind, row.samples ?? []).map((value) => ({ kind: 'datei' as const, value }))
        : egressTargetsOf(row.samples ?? []).map((value) => ({ kind: 'netz' as const, value }))
  if (!entries.length) throw badRequest('Nichts gefunden, das sich als normal markieren liesse')
  for (const e of entries) {
    await db.insert(schema.intrusionAllow).values({ projectId: row.projectId, kind: e.kind, service: e.kind === 'netz' ? '' : service, value: e.value.slice(0, 500), createdBy: actor }).onConflictDoNothing()
  }
  await db.update(schema.incidents).set({ status: 'erledigt', resolvedAt: new Date() }).where(eq(schema.incidents.id, id))
  await addEvent(id, 'normal', `Als normal markiert: ${entries.map((e) => e.value).slice(0, 10).join(', ')}${entries.length > 10 ? ' …' : ''}`, actor)
  await audit({ actor, action: 'incident.normal', targetType: 'project', targetId: row.projectId, params: { incident: id, title: row.title, entries: entries.map((e) => `${e.kind}:${e.value}`).slice(0, 20) }, result: 'ok' })
  publish({ type: 'incident', projectId: row.projectId })
  return getIncident(scope, id)
}

/* --- Projekt › Security ----------------------------------------------------------------------- */

export async function projectIntrusionDto(p: Project): Promise<ProjectIntrusionDto> {
  const now = Date.now()
  const active = await activeDeployment(p.id)
  const kind = active ? effectiveKind(p.sourceType, active.artifact) : null
  const conts = await db.select().from(schema.intrusionContainers).where(eq(schema.intrusionContainers.projectId, p.id))
  const recent = conts.filter((c) => now - c.lastSeen.getTime() < 10 * 60_000)
  const learning = recent.filter((c) => c.learnUntil.getTime() > now)
  const site = kind === 'static' ? (await db.select().from(schema.intrusionSites).where(eq(schema.intrusionSites.projectId, p.id)).orderBy(desc(schema.intrusionSites.createdAt)).limit(1))[0] : undefined
  const lastCheck = kind === 'static'
    ? site?.checkedAt ?? site?.createdAt ?? null
    : recent.reduce<Date | null>((m, c) => (c.lastCheckAt && (!m || c.lastCheckAt > m) ? c.lastCheckAt : m), null)
  const rows = await db.select().from(schema.incidents).where(eq(schema.incidents.projectId, p.id))
    .orderBy(sql`CASE ${schema.incidents.status} WHEN 'offen' THEN 0 WHEN 'gesehen' THEN 1 ELSE 2 END`, desc(SEVERITY_ORDER), desc(schema.incidents.lastSeen))
    .limit(30)
  // Erledigte nur die letzten fünf
  let done = 0
  const shown = rows.filter((r) => r.status !== 'erledigt' || done++ < 5)
  const allow = await db.select().from(schema.intrusionAllow).where(eq(schema.intrusionAllow.projectId, p.id)).orderBy(schema.intrusionAllow.createdAt)
  return {
    watch: {
      state: p.sourceType === 'external' ? 'extern' : kind === 'static' ? 'statisch' : !recent.length ? 'ohne-container' : learning.length ? 'lernt' : 'aktiv',
      learnUntil: learning.length ? new Date(Math.max(...learning.map((c) => c.learnUntil.getTime()))).toISOString() : null,
      containers: recent.length,
      lastCheckAt: lastCheck ? lastCheck.toISOString() : null,
    },
    incidents: shown.map((r) => toDto(r, { id: p.id, name: p.name })),
    autoStop: p.incidentAutoStop,
    isolation: p.isolatedAt ? { at: p.isolatedAt.toISOString(), by: p.isolatedBy ?? '?' } : null,
    normal: allow.map((a) => ({ kind: a.kind, service: a.service || null, value: a.value })),
  }
}

export async function setIntrusionSettings(p: Project, body: unknown, actor: string): Promise<ProjectIntrusionDto> {
  if (p.previewOf) throw badRequest('Eine Vorschau folgt ihrem Projekt')
  const input = intrusionSettingsSchema.parse(body ?? {})
  const [row] = await db.update(schema.projects).set({ incidentAutoStop: input.autoStop }).where(eq(schema.projects.id, p.id)).returning()
  await audit({ actor, action: 'project.intrusion.update', targetType: 'project', targetId: p.id, params: { autoStop: input.autoStop }, result: 'ok' })
  return projectIntrusionDto(row!)
}

/** Grundlinie des Projekts wieder auf das Gelernte zurücksetzen (ein Eintrag) */
export async function removeNormal(p: Project, entry: { kind: string; service: string | null; value: string }, actor: string): Promise<ProjectIntrusionDto> {
  const rows = await db.delete(schema.intrusionAllow).where(and(
    eq(schema.intrusionAllow.projectId, p.id), eq(schema.intrusionAllow.kind, entry.kind as 'prozess'),
    eq(schema.intrusionAllow.service, entry.service ?? ''), eq(schema.intrusionAllow.value, entry.value),
  )).returning()
  if (!rows.length) throw notFound('Eintrag')
  await audit({ actor, action: 'project.intrusion.normal.remove', targetType: 'project', targetId: p.id, params: { kind: entry.kind, value: entry.value }, result: 'ok' })
  return projectIntrusionDto(p)
}

/* --- Isolieren ------------------------------------------------------------------------------- */

/**
 * «Container jetzt isolieren»: Ausgang auf «abgeschottet» und durchsetzen
 * (Etappe 4), Restart-Policy der Container auf «no» (Docker startet sie nach
 * einem Absturz oder Neustart des Servers nicht wieder) und Start, Neustart,
 * Deploy und Rollback verweigert, bis zur Freigabe. Die Container laufen
 * weiter – ihr Zustand bleibt für die Analyse erhalten.
 */
export async function isolateProject(p: Project, actor: string): Promise<ProjectIntrusionDto> {
  if (p.previewOf) throw badRequest('Eine Vorschau folgt ihrem Projekt')
  if (p.isolatedAt) return projectIntrusionDto(p)
  const before = { mode: p.egressMode, enforce: p.egressEnforce }
  // requireSudo: die Route verlangt die Bestätigung schon (SUDO_ROUTES); «abgeschottet» fragt sonst nicht
  await setEgressSettings(p, { mode: 'abgeschottet', enforce: true }, actor, () => {})
  const restartPolicies: Record<string, string> = {}
  const failed: string[] = []
  for (const c of (await docker.listManagedContainers()).filter((c) => c.labels[docker.LABEL_PROJECT] === p.slug && docker.isRuntimeContainer(c.labels))) {
    try {
      const i = await docker.inspectForIntrusion(c.id)
      restartPolicies[c.id] = i?.restartPolicy ?? 'unless-stopped'
      await docker.setRestartPolicy(c.id, 'no')
    } catch (err) {
      failed.push(c.names[0] ?? c.id.slice(0, 12))
      log.warn('Restart-Policy beim Isolieren nicht geändert', { container: c.id, err: String(err) })
    }
  }
  const isolation: IsolationRecord = { egress: before, restartPolicies }
  const [row] = await db.update(schema.projects).set({ isolatedAt: new Date(), isolatedBy: actor, isolation }).where(eq(schema.projects.id, p.id)).returning()
  for (const i of await db.select({ id: schema.incidents.id }).from(schema.incidents).where(and(eq(schema.incidents.projectId, p.id), ne(schema.incidents.status, 'erledigt')))) {
    await addEvent(i.id, 'reaktion', 'Container isoliert (Ausgang abgeschottet, Neustart verweigert)', actor)
  }
  await audit({ actor, action: 'project.isolate', targetType: 'project', targetId: p.id, params: { egressBefore: before, containers: Object.keys(restartPolicies).length, failed }, result: failed.length ? 'error' : 'ok', ...(failed.length ? { error: `Restart-Policy nicht geändert: ${failed.join(', ')}` } : {}) })
  publish({ type: 'project', projectId: p.id })
  publish({ type: 'incident', projectId: p.id })
  return projectIntrusionDto(row!)
}

/**
 * Freigabe: Start und Deploy gehen wieder, die Restart-Policies kommen
 * zurück. Der Ausgang bleibt bewusst «abgeschottet» – öffnen geht unter
 * Einstellungen › Ausgehende Verbindungen, wenn die Ursache behoben ist.
 */
export async function releaseIsolation(p: Project, actor: string): Promise<{ released: boolean; restored: number; failed: string[] }> {
  if (!p.isolatedAt) return { released: false, restored: 0, failed: [] }
  const policies = p.isolation?.restartPolicies ?? {}
  let restored = 0
  const failed: string[] = []
  for (const [id, policy] of Object.entries(policies)) {
    try {
      if (!(await docker.inspectForIntrusion(id))) continue
      await docker.setRestartPolicy(id, policy || 'unless-stopped')
      restored++
    } catch (err) {
      failed.push(id.slice(0, 12))
      log.warn('Restart-Policy bei der Freigabe nicht zurückgestellt', { container: id, err: String(err) })
    }
  }
  await db.update(schema.projects).set({ isolatedAt: null, isolatedBy: null, isolation: null }).where(eq(schema.projects.id, p.id))
  for (const i of await db.select({ id: schema.incidents.id }).from(schema.incidents).where(and(eq(schema.incidents.projectId, p.id), ne(schema.incidents.status, 'erledigt')))) {
    await addEvent(i.id, 'reaktion', 'Isolation aufgehoben (Ausgang bleibt abgeschottet)', actor)
  }
  await audit({ actor, action: 'project.isolate.release', targetType: 'project', targetId: p.id, params: { restored, failed, egressBefore: p.isolation?.egress ?? null }, result: 'ok' })
  publish({ type: 'project', projectId: p.id })
  publish({ type: 'incident', projectId: p.id })
  return { released: true, restored, failed }
}

/** Für die Anzeige: wie lange ein Container lernt */
export const LEARN_MS = INTRUSION_LEARN_MINUTES * 60_000
