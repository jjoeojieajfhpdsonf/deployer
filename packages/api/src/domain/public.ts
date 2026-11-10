import { eq, and, sql } from 'drizzle-orm'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { cf as settings, config } from '../config.js'
import { RESERVED_SLUGS } from '@deployer/shared'
import { Cloudflare, CloudflareError, upsertManagedRecord, MANAGED_COMMENT, type Zone } from '../drivers/cloudflare.js'
import { resolvePublicHostname, reconcileIngress, tunnelCname, PublicHostError } from '../lib/public-hosts.js'
import { cloudflareClient } from './tailnet.js'
import { assertPublishable, latestScan, onProjectScanDone } from '../security/scan.js'
import { getPublicRequest, discardPublicRequest, markRequestFailed, toRequestDto, gateReason } from './public-requests.js'
import { setProjectPause, pausePageTemplate } from './pause-page.js'
import type { PauseOptions } from '@deployer/shared'
import { reconcileCaddy, routeDtosFor } from './routes.js'
import { Progress, withProgress, stepsFor, progressOf } from './public-progress.js'
import { checkFromOutside, type Expect } from '../lib/outside-probe.js'
import type { OutsideCheckDto, PublicStatusDto } from '@deployer/shared'
import { audit } from './audit.js'
import { notify } from '../notify/send.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'
import { log } from '../lib/log.js'

/**
 * M5: öffentlich über Cloudflare Tunnel.
 *
 * Reihenfolge beim Öffentlich-Schalten: Schwelle (M6) -> Name prüfen ->
 * CNAME (proxied, auf den Tunnel) -> optional Access -> Route speichern ->
 * Tunnel-Ingress und Caddy aus der Datenbank abgleichen -> Benachrichtigung.
 * Beim Entfernen umgekehrt. Die Datenbank ist die Wahrheit; der Abgleich
 * räumt nur, was deployer selbst angelegt hat.
 */

const MANAGED_HOSTS_KEY = 'tunnel_managed_hosts'

export function publicEnabled(): boolean {
  return Boolean(settings.accountId() && settings.tunnelId() && cloudflareClient())
}

function client(): Cloudflare {
  const cf = cloudflareClient()
  if (!cf || !settings.accountId() || !settings.tunnelId()) {
    throw new AppError('public_disabled', 'Öffentlich ist nicht eingerichtet: unter System «Cloudflare verbinden» Token und Tunnel einrichten.', 400)
  }
  return cf
}

/** Fehler von Cloudflare als saubere API-Fehler. */
function wrap(err: unknown): never {
  if (err instanceof PublicHostError) throw badRequest(err.message)
  if (err instanceof CloudflareError) throw new AppError('cloudflare', err.message, err.status === 409 ? 409 : err.status >= 400 && err.status < 500 ? 400 : 502)
  throw err
}

/* --- Domains -------------------------------------------------------------------- */

export interface DomainDto { id: string; name: string; zoneId: string; isDefault: boolean }

/** Zonen des Kontos holen und in `domains` spiegeln. Die Standard-Wahl bleibt. */
export async function syncDomains(cf = client()): Promise<DomainDto[]> {
  let zones: Zone[]
  try {
    zones = await cf.listZones()
  } catch (err) {
    wrap(err)
  }
  await db.transaction(async (tx) => {
    for (const z of zones) {
      await tx
        .insert(schema.domains)
        .values({ cfZoneId: z.id, name: z.name.toLowerCase() })
        .onConflictDoUpdate({ target: schema.domains.cfZoneId, set: { name: z.name.toLowerCase() } })
    }
    const ids = zones.map((z) => z.id)
    const existing = await tx.select().from(schema.domains)
    const used = (await tx.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))).map((r) => r.hostname)
    for (const d of existing) {
      if (ids.includes(d.cfZoneId)) continue
      // Noch von einer öffentlichen Route benutzt: behalten, sonst fände das
      // Aufräumen den DNS-Eintrag später nicht mehr (Review M5).
      if (used.some((h) => h === d.name || h.endsWith(`.${d.name}`))) continue
      await tx.delete(schema.domains).where(eq(schema.domains.id, d.id))
    }
  })
  return listDomains()
}

export async function listDomains(): Promise<DomainDto[]> {
  const rows = await db.select().from(schema.domains).orderBy(schema.domains.name)
  return rows.map((d) => ({ id: d.id, name: d.name, zoneId: d.cfZoneId, isDefault: d.isDefault }))
}

export async function setDefaultDomain(name: string, actor: string): Promise<DomainDto[]> {
  const n = name.trim().toLowerCase()
  const row = (await db.select().from(schema.domains).where(eq(schema.domains.name, n)))[0]
  if (!row) throw badRequest(`${n} ist keine Zone dieses Cloudflare-Kontos (Liste zuerst abgleichen)`)
  await db.transaction(async (tx) => {
    await tx.update(schema.domains).set({ isDefault: false }).where(eq(schema.domains.isDefault, true))
    await tx.update(schema.domains).set({ isDefault: true }).where(eq(schema.domains.id, row.id))
  })
  await audit({ actor, action: 'domain.default', targetType: 'domain', targetId: row.id, params: { name: n }, result: 'ok' })
  return listDomains()
}

/* --- Öffentlich schalten --------------------------------------------------------- */

export interface PublicInput {
  subdomain?: string
  hostname?: string
  /** undefined = wie bisher (Review M5: sonst fiel Access beim nächsten Aufruf still weg) */
  accessProtected?: boolean
}

export async function publicRoute(projectId: string) {
  return (await db.select().from(schema.routes).where(and(eq(schema.routes.projectId, projectId), eq(schema.routes.target, 'public'))))[0] ?? null
}

type Project = { id: string; slug: string; name: string }
type PublicRouteRow = NonNullable<Awaited<ReturnType<typeof publicRoute>>>

export interface PublicPlan {
  project: Project
  hostname: string
  zone: Zone
  access: boolean
  before: PublicRouteRow | null
}

/**
 * Alles prüfen, was "public" verhindern würde – ohne etwas zu ändern:
 * Konfiguration, Schwelle (M6), Name, Belegung, ACCESS_EMAIL. Aufrufer
 * machen das, BEVOR sie interne Ziele umstellen; danach können nur noch
 * Fehler von Cloudflare selbst auftreten (Review M5).
 *
 * Fehlen Name oder Access in der Eingabe, gilt der bisherige Stand.
 */
export async function planPublic(project: Project, input: PublicInput): Promise<PublicPlan> {
  const cf = client()
  await assertPublishable(project.id)
  try {
    const before = await publicRoute(project.id)
    const domains = await listDomains().then((d) => (d.length ? d : syncDomains(cf)))
    const nameGiven = Boolean(input.subdomain || input.hostname)
    const { hostname, zone } = resolvePublicHostname(
      nameGiven ? { subdomain: input.subdomain, hostname: input.hostname } : before ? { hostname: before.hostname } : { subdomain: project.slug },
      {
        zones: domains.map((d) => ({ id: d.zoneId, name: d.name })),
        defaultZone: domains.find((d) => d.isDefault)?.name ?? null,
        internalBaseDomain: settings.baseDomain(),
        reservedLabels: RESERVED_SLUGS,
      },
    )
    const clash = await db.select().from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, hostname)))
    if (clash.some((r) => r.projectId !== project.id)) throw conflict(`${hostname} ist schon von einem anderen Projekt belegt`)
    const access = input.accessProtected ?? Boolean(before?.accessProtected)
    if (access && !settings.accessEmail()) throw badRequest('Für Cloudflare Access braucht es eine E-Mail-Adresse (System → Cloudflare → Domains).')
    return { project, hostname, zone, access, before }
  } catch (err) {
    wrap(err)
  }
}

/**
 * Macht ein Projekt öffentlich oder ändert Name/Access nach einem Plan aus
 * planPublic. Die Bestätigung (MCP) und die Rückfrage (UI) liegen beim
 * Aufrufer. Scheitert ein Schritt, wird zurückgenommen, was dieser Aufruf
 * bei Cloudflare neu angelegt hat.
 */
export async function applyPublic(plan: PublicPlan, actor: string, progress?: Progress): Promise<{ hostname: string }> {
  const cf = client()
  const { project, hostname, zone, before } = plan
  const created: { recordId?: string; accessId?: string } = {}
  const sameName = before?.hostname === hostname
  try {
    // 1. DNS: CNAME proxied auf den Tunnel; fremde Einträge bleiben unangetastet.
    progress?.start('dns')
    const rec = await upsertManagedRecord(cf, zone.id, { type: 'CNAME', name: hostname, content: tunnelCname(settings.tunnelId()!), proxied: true })
    if (rec.action === 'created') created.recordId = rec.record.id
    progress?.set('dns', 'done', rec.action === 'created' ? `CNAME ${hostname} auf den Tunnel angelegt` : `CNAME ${hostname} zeigt auf den Tunnel`)

    // 2. Access
    progress?.start('access')
    let accessAppId = sameName ? before.cfAccessAppId : null
    if (plan.access && !accessAppId) {
      accessAppId = (await cf.createAccessApp(settings.accountId()!, { name: `deployer: ${project.name}`, domain: hostname, email: settings.accessEmail()! })).id
      created.accessId = accessAppId
    }

    // 3. Route speichern (eine öffentliche Route pro Projekt), Belegung unter Sperre erneut prüfen
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deployer.routes'))`)
      const clash = await tx.select().from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, hostname)))
      if (clash.some((r) => r.projectId !== project.id)) throw conflict(`${hostname} ist schon von einem anderen Projekt belegt`)
      await tx.delete(schema.routes).where(and(eq(schema.routes.projectId, project.id), eq(schema.routes.target, 'public')))
      await tx.insert(schema.routes).values({
        projectId: project.id, target: 'public', hostname, cfDnsRecordId: rec.record.id,
        accessProtected: Boolean(accessAppId) && plan.access, cfAccessAppId: plan.access ? accessAppId : null,
        // Gleicher Name: «seit» und eine Pause bleiben (nur Access geändert)
        ...(sameName ? { createdAt: before.createdAt, pausedAt: before.pausedAt } : {}),
      })
    })
    created.recordId = undefined
    created.accessId = undefined

    // 4. Access abgeschaltet: App weg (erst nach dem Speichern, dann ist der Stand konsistent)
    if (!plan.access && accessAppId) await cf.deleteAccessApp(settings.accountId()!, accessAppId).catch((e) => log.warn('Access-App nicht entfernt', { err: String(e) }))
    progress?.set('access', 'done', plan.access ? 'Login per E-Mail-Code vorgeschaltet' : 'ohne Login')

    // 5. Alter Name (bei Umbenennung) aus DNS und Access entfernen
    if (before && before.hostname !== hostname) await dropCloudflareObjects(cf, before).catch((e) => log.warn('Alter öffentlicher Name nicht vollständig entfernt', { err: String(e) }))

    // 6. Tunnel aus der Datenbank (Caddy gleicht der Aufrufer ab)
    progress?.start('tunnel')
    await reconcileTunnel(cf)
    progress?.set('tunnel', 'done', `${hostname} → Caddy`)

    // Welcher Übergang: neu, umbenannt oder nur Access an/aus (Audit-Log)
    const action = !before ? 'project.public' : !sameName ? 'project.public.rename' : before.accessProtected !== plan.access ? 'project.public.access' : 'project.public.change'
    await audit({ actor, action, targetType: 'project', targetId: project.id, params: { hostname, accessProtected: plan.access, ...(before && !sameName ? { before: before.hostname } : {}) }, result: 'ok' })
    if (!before) await notify('project_public', { project: project.name, url: `https://${hostname}` }, project.id)
    return { hostname }
  } catch (err) {
    // Zurücknehmen, was dieser Aufruf neu angelegt hat (Review M5: sonst verwaist bei Cloudflare)
    if (created.accessId) await cf.deleteAccessApp(settings.accountId()!, created.accessId).catch(() => {})
    if (created.recordId) await cf.deleteRecord(zone.id, created.recordId).catch(() => {})
    wrap(err)
  }
}

/** Bequemer Weg für Aufrufer ohne interne Ziele dazwischen. */
export async function setPublic(project: Project, input: PublicInput, actor: string): Promise<{ hostname: string }> {
  return applyPublic(await planPublic(project, input), actor)
}

/** Öffentliche Route entfernen: CNAME, Access, Ingress, Caddy. */
export async function removePublic(project: { id: string; slug: string }, actor: string, opts: { strict?: boolean; skipCaddy?: boolean; progress?: Progress } = {}): Promise<boolean> {
  const route = await publicRoute(project.id)
  if (!route) return false
  const cf = cloudflareClient()
  const pr = opts.progress
  const problems: string[] = []
  if (cf && settings.accountId()) {
    pr?.start('dns')
    await dropCloudflareObjects(cf, route, pr).catch((e) => {
      problems.push(String((e as Error).message))
      pr?.set(pr.dto.steps.find((s) => s.state === 'current')?.key ?? 'dns', 'warn', (e as Error).message)
    })
  } else {
    problems.push('kein Cloudflare-Token: DNS-Eintrag und Access-App bleiben bei Cloudflare stehen')
    pr?.set('dns', 'warn', 'Kein Cloudflare-Token: der DNS-Eintrag bleibt stehen')
  }
  await db.delete(schema.routes).where(eq(schema.routes.id, route.id))
  if (cf && settings.accountId() && settings.tunnelId()) {
    pr?.start('tunnel')
    await reconcileTunnel(cf).then(
      () => pr?.set('tunnel', 'done', `Regel für ${route.hostname} entfernt`),
      (e) => {
        problems.push(`Tunnel: ${(e as Error).message}`)
        pr?.set('tunnel', 'warn', (e as Error).message)
      },
    )
  }
  // Ein Fehler hier (etwa ein schon entferntes Projekt-Netz beim Löschen)
  // darf Audit und Meldung nicht verhindern (Review M5).
  if (!opts.skipCaddy) {
    pr?.start('caddy')
    await reconcileCaddy().then(() => pr?.set('caddy', 'done'), (e) => {
      log.warn('Caddy-Abgleich nach Entfernen fehlgeschlagen', { err: String(e) })
      pr?.set('caddy', 'warn', String((e as Error).message))
    })
  }
  await audit({ actor, action: 'project.public.remove', targetType: 'project', targetId: project.id, params: { hostname: route.hostname, wasPaused: route.pausedAt !== null }, result: problems.length ? 'error' : 'ok', error: problems.join('; ') || undefined })
  if (problems.length) {
    // Löschen soll nicht an Cloudflare scheitern; Reste melden (SPEC M5).
    await notify('infra_problem', { what: 'Cloudflare-Aufräumen', detail: `${route.hostname}: ${problems.join('; ')}` })
    if (opts.strict) throw new AppError('cloudflare', problems.join('; '), 502)
  }
  return true
}

async function dropCloudflareObjects(cf: Cloudflare, route: { hostname: string; cfDnsRecordId: string | null; cfAccessAppId: string | null }, pr?: Progress): Promise<void> {
  const domains = await listDomains()
  const zone = domains.find((d) => route.hostname === d.name || route.hostname.endsWith(`.${d.name}`))
  if (route.cfDnsRecordId && !zone) throw new Error(`Zone von ${route.hostname} unbekannt; DNS-Eintrag bitte in Cloudflare von Hand entfernen`)
  if (route.cfDnsRecordId && zone) {
    // Nur löschen, was wirklich von deployer stammt.
    const recs = await cf.listRecords(zone.zoneId, route.hostname)
    const mine = recs.find((r) => r.id === route.cfDnsRecordId && r.comment === MANAGED_COMMENT)
    if (mine) await cf.deleteRecord(zone.zoneId, mine.id)
    pr?.set('dns', 'done', mine ? `CNAME ${route.hostname} entfernt` : 'kein eigener Eintrag mehr vorhanden')
  } else {
    pr?.set('dns', 'done', 'kein eigener Eintrag')
  }
  pr?.start('access')
  if (route.cfAccessAppId) await cf.deleteAccessApp(settings.accountId()!, route.cfAccessAppId)
  pr?.set('access', route.cfAccessAppId ? 'done' : 'skipped', route.cfAccessAppId ? 'Login-Schutz entfernt' : 'war nicht eingeschaltet')
}

/* --- Pausieren und Fortsetzen ----------------------------------------------------- */

/**
 * Pausieren: Name, DNS-Eintrag, Tunnel-Regel und Access bleiben; Caddy
 * liefert für den öffentlichen Namen eine neutrale Wartungsseite (503).
 * Die interne Adresse läuft weiter.
 */
export async function pausePublic(project: Project, actor: string, progress?: Progress, opts?: PauseOptions): Promise<{ hostname: string; changed: boolean }> {
  const route = await publicRoute(project.id)
  if (!route) throw badRequest(`«${project.name}» ist nicht öffentlich`)
  // Eigene Seite und «Voraussichtlich zurück» vor dem Umschalten speichern
  if (opts) await setProjectPause(project.id, opts, actor)
  if (route.pausedAt) {
    // Schon pausiert: nur die Seite aktualisieren
    if (opts) await reconcileCaddy()
    return { hostname: route.hostname, changed: false }
  }
  progress?.start('caddy')
  await db.update(schema.routes).set({ pausedAt: new Date() }).where(eq(schema.routes.id, route.id))
  try {
    await reconcileCaddy()
  } catch (err) {
    // Caddy hat die Wartungsseite nicht: der Stand in der Datenbank muss
    // stimmen, sonst zeigte die Karte «pausiert», Besucher sähen das Projekt.
    await db.update(schema.routes).set({ pausedAt: null }).where(eq(schema.routes.id, route.id))
    await audit({ actor, action: 'project.public.pause', targetType: 'project', targetId: project.id, params: { hostname: route.hostname }, result: 'error', error: (err as Error).message })
    throw err
  }
  progress?.set('caddy', 'done', 'Besucher bekommen HTTP 503 mit Wartungsseite')
  await audit({ actor, action: 'project.public.pause', targetType: 'project', targetId: project.id, params: { hostname: route.hostname }, result: 'ok' })
  return { hostname: route.hostname, changed: true }
}

/** Fortsetzen: wie Veröffentlichen an die Schwelle gebunden (Scan ohne kritischen Befund). */
export async function resumePublic(project: Project, actor: string, progress?: Progress): Promise<{ hostname: string; changed: boolean }> {
  const route = await publicRoute(project.id)
  if (!route) throw badRequest(`«${project.name}» ist nicht öffentlich`)
  if (!route.pausedAt) return { hostname: route.hostname, changed: false }
  progress?.start('check')
  await assertPublishable(project.id)
  progress?.set('check', 'done', 'Scan ohne offenen kritischen Befund')
  progress?.start('caddy')
  // «Voraussichtlich zurück» gilt nur für diese Pause; die eigene Seite bleibt fürs nächste Mal
  await db.update(schema.routes).set({ pausedAt: null, pauseBackAt: null }).where(eq(schema.routes.id, route.id))
  try {
    await reconcileCaddy()
  } catch (err) {
    await db.update(schema.routes).set({ pausedAt: route.pausedAt, pauseBackAt: route.pauseBackAt }).where(eq(schema.routes.id, route.id))
    await audit({ actor, action: 'project.public.resume', targetType: 'project', targetId: project.id, params: { hostname: route.hostname }, result: 'error', error: (err as Error).message })
    throw err
  }
  progress?.set('caddy', 'done', 'Caddy gibt den Verkehr wieder ans Projekt')
  await audit({ actor, action: 'project.public.resume', targetType: 'project', targetId: project.id, params: { hostname: route.hostname, pausedSince: route.pausedAt.toISOString() }, result: 'ok' })
  return { hostname: route.hostname, changed: true }
}

/* --- Übergänge mit Fortschritt (Karte «Veröffentlichung») --------------------------- */

const busy = () => conflict('Für dieses Projekt läuft schon eine Änderung der Veröffentlichung')

/** Prüfung von aussen als letzter Schritt; ein Fehlschlag ist eine Warnung, kein Abbruch. */
async function outside(pr: Progress, hostname: string, expect: Expect, access = false): Promise<OutsideCheckDto | null> {
  pr.start('outside')
  if (process.env.PUBLIC_OUTSIDE_CHECK === 'off') {
    pr.set('outside', 'skipped', 'abgeschaltet (PUBLIC_OUTSIDE_CHECK=off)')
    return null
  }
  const r = await checkFromOutside(hostname, expect, { access })
  pr.set('outside', r.ok ? 'done' : 'warn', r.message)
  return r
}

export type FlowResult = { hostname: string | null; check: OutsideCheckDto | null; changed: boolean }

/** Veröffentlichen oder nur Access an/aus. Die Rückfrage liegt beim Aufrufer. */
export function publishFlow(project: Project, input: PublicInput, actor: string): Promise<FlowResult> {
  return (async () => {
    const before = await publicRoute(project.id)
    const op = before ? 'access' : 'publish'
    const access = input.accessProtected ?? Boolean(before?.accessProtected)
    return withProgress(project.id, op, before?.hostname ?? null, stepsFor(op, { access }), async (pr) => {
      pr.start('check')
      const plan = await planPublic(project, input)
      pr.hostname(plan.hostname)
      pr.set('check', 'done', `Scan bestanden · ${plan.hostname}`)
      await applyPublic(plan, actor, pr)
      if (op === 'publish') {
        pr.start('caddy')
        await reconcileCaddy()
        pr.set('caddy', 'done', 'nur aus dem Netz von cloudflared')
      } else {
        await reconcileCaddy()
      }
      const paused = Boolean(before?.pausedAt)
      // Eine vorgemerkte Anfrage ist damit erledigt
      if (op === 'publish') await discardPublicRequest(project.id, actor, 'veröffentlicht').catch(() => false)
      const check = await outside(pr, plan.hostname, paused ? 'paused' : 'live', plan.access)
      return { hostname: plan.hostname, check, changed: true }
    }, busy)
  })()
}

export function pauseFlow(project: Project, actor: string, opts?: PauseOptions): Promise<FlowResult> {
  return (async () => {
    const route = await publicRoute(project.id)
    return withProgress(project.id, 'pause', route?.hostname ?? null, stepsFor('pause'), async (pr) => {
      const r = await pausePublic(project, actor, pr, opts)
      const check = await outside(pr, r.hostname, 'paused')
      return { hostname: r.hostname, check, changed: r.changed }
    }, busy)
  })()
}

export function resumeFlow(project: Project, actor: string): Promise<FlowResult> {
  return (async () => {
    const route = await publicRoute(project.id)
    return withProgress(project.id, 'resume', route?.hostname ?? null, stepsFor('resume'), async (pr) => {
      const r = await resumePublic(project, actor, pr)
      const check = await outside(pr, r.hostname, 'live', Boolean(route?.accessProtected))
      return { hostname: r.hostname, check, changed: r.changed }
    }, busy)
  })()
}

/** Ganz offline: Tunnel-Regel, DNS-Eintrag und Access-App weg, der Name ist frei. */
export function unpublishFlow(project: Project, actor: string): Promise<FlowResult & { removed: { hostname: string; accessProtected: boolean } | null }> {
  return (async () => {
    const route = await publicRoute(project.id)
    if (!route) throw badRequest(`«${project.name}» ist nicht öffentlich`)
    const removed = { hostname: route.hostname, accessProtected: route.accessProtected }
    return withProgress(project.id, 'unpublish', route.hostname, stepsFor('unpublish'), async (pr) => {
      await removePublic(project, actor, { progress: pr })
      const check = await outside(pr, route.hostname, 'gone')
      return { hostname: route.hostname, check, changed: true, removed }
    }, busy)
  })()
}

/* --- Zustand für die Karte -------------------------------------------------------- */

export async function publishability(projectId: string): Promise<PublicStatusDto['publishable']> {
  if (!publicEnabled()) return { ok: false, why: 'disabled', reason: gateReason({ why: 'disabled' }) }
  try {
    await assertPublishable(projectId)
    return { ok: true }
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'not_publishable') throw err
    // Kurz und konkret: «Scan läuft seit 5 Min.», «1 kritischer Befund offen»
    const last = await latestScan(projectId)
    if (last && (last.status === 'queued' || last.status === 'running')) {
      return { ok: false, why: 'scan_running', reason: gateReason({ why: 'scan_running', runningSince: last.status === 'running' ? last.startedAt : null }) }
    }
    const done = await latestScan(projectId, true)
    if (!done) return { ok: false, why: 'no_scan', reason: gateReason({ why: 'no_scan' }) }
    const critical = await db.select({ title: schema.findings.title }).from(schema.findings)
      .where(and(eq(schema.findings.scanRunId, done.id), eq(schema.findings.status, 'open'), eq(schema.findings.severity, 'critical')))
    return { ok: false, why: 'critical', reason: gateReason({ why: 'critical', critical: critical.map((c) => c.title) }) }
  }
}

/**
 * Nach jedem bestandenen Scan: eine in der Oberfläche bestätigte Anfrage
 * ausführen. Eine unbestätigte bleibt stehen – die Karte zeigt dann «Scan
 * bestanden» mit Knopf; nichts wird still veröffentlicht.
 */
export async function applyApprovedRequest(projectId: string): Promise<void> {
  const req = await getPublicRequest(projectId)
  if (!req?.approvedBy || req.lastError) return
  if (await publicRoute(projectId)) {
    await discardPublicRequest(projectId, 'system', 'schon öffentlich')
    return
  }
  const gate = await publishability(projectId)
  if (!gate.ok) return
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]
  if (!project) return
  const actor = `${req.approvedBy} (vorgemerkt)`
  try {
    log.info('Vorgemerkte Öffentlich-Anfrage wird ausgeführt', { projectId, actor })
    await publishFlow(project, { subdomain: req.subdomain ?? undefined, hostname: req.hostname ?? undefined, accessProtected: req.accessProtected }, actor)
    await discardPublicRequest(projectId, actor, 'nach bestandenem Scan veröffentlicht')
  } catch (err) {
    const msg = (err as Error).message
    await markRequestFailed(projectId, msg)
    await audit({ actor, action: 'public.request.apply', targetType: 'project', targetId: projectId, params: {}, result: 'error', error: msg })
    log.warn('Vorgemerkte Öffentlich-Anfrage gescheitert', { projectId, err: msg })
  }
}

/** Beim Start aufrufen (index.ts): nach jedem bestandenen Scan Vormerkungen prüfen. */
export function watchPublicRequests(): void {
  onProjectScanDone((projectId) => {
    void applyApprovedRequest(projectId).catch((err) => log.warn('Vormerkung nach Scan nicht geprüft', { projectId, err: String(err) }))
  })
}

export async function publicStatus(project: { id: string; slug: string }): Promise<PublicStatusDto> {
  const route = await publicRoute(project.id)
  const internal = (await routeDtosFor(project.id, project.slug)).find((r) => r.target !== 'public')
  const [gate, req] = await Promise.all([publishability(project.id), getPublicRequest(project.id)])
  return {
    state: !route ? 'private' : route.pausedAt ? 'paused' : 'live',
    enabled: publicEnabled(),
    hostname: route?.hostname ?? null,
    url: route ? `https://${route.hostname}` : null,
    since: route ? (route.pausedAt ?? route.createdAt).toISOString() : null,
    accessProtected: Boolean(route?.accessProtected),
    internalUrl: internal?.urls[0] ?? null,
    publishable: gate,
    pendingRequest: req && !route ? toRequestDto(req, gate) : null,
    pause: {
      page: route?.pausePage ?? null,
      backAt: route?.pauseBackAt?.toISOString() ?? null,
      template: await pausePageTemplate(),
    },
    progress: progressOf(project.id),
  }
}

/* --- Tunnel ------------------------------------------------------------------------ */

let tunnelChain: Promise<unknown> = Promise.resolve()

/**
 * Ingress-Regeln aus allen öffentlichen Routen; fremde Regeln bleiben.
 * Nacheinander wie der Caddy-Abgleich: zwei überlappende Läufe könnten sonst
 * einen eben gesetzten Namen mit einem älteren Stand überschreiben (Review M5).
 */
export function reconcileTunnel(cf = client()): Promise<{ hosts: string[] }> {
  const run = () => reconcileTunnelNow(cf)
  const next = tunnelChain.then(run, run)
  tunnelChain = next.catch(() => {})
  return next
}

async function reconcileTunnelNow(cf: Cloudflare): Promise<{ hosts: string[] }> {
  const rows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))
  const managedBefore: string[] = JSON.parse((await getSetting(MANAGED_HOSTS_KEY)) ?? '[]')
  const current = await cf.getTunnelIngress(settings.accountId()!, settings.tunnelId()!)
  const forbidden = settings.baseDomain() ? rows.map((r) => r.hostname).filter((h) => h.endsWith(`.${settings.baseDomain()}`)) : []
  const { ingress, managed } = reconcileIngress(current, rows.map((r) => r.hostname), managedBefore, forbidden)
  if (JSON.stringify(ingress) !== JSON.stringify(current)) {
    await cf.putTunnelIngress(settings.accountId()!, settings.tunnelId()!, ingress)
    log.info('Tunnel-Ingress abgeglichen', { hosts: managed })
  }
  await setSetting(MANAGED_HOSTS_KEY, JSON.stringify(managed))
  return { hosts: managed }
}

let tunnelCache: { at: number; v: { status: string; connections: number } } | null = null

/** Zustand des Tunnels, höchstens eine Minute alt (die Systemseite fragt alle 15 s). */
export async function tunnelStatus(): Promise<{ status: string; connections: number } | null> {
  if (!publicEnabled()) return null
  // Veraltet: im Hintergrund neu holen und sofort den letzten Stand liefern –
  // die Systemseite soll nie auf Cloudflare warten (Review M5).
  if (!tunnelCache || Date.now() - tunnelCache.at >= 60_000) {
    const refresh = refreshTunnelStatus()
    if (!tunnelCache) return refresh
  }
  return tunnelCache!.v
}

let refreshing: Promise<{ status: string; connections: number }> | null = null
function refreshTunnelStatus(): Promise<{ status: string; connections: number }> {
  refreshing ??= (async () => {
    let v: { status: string; connections: number }
    try {
      v = await client().tunnelStatus(settings.accountId()!, settings.tunnelId()!)
    } catch (err) {
      v = { status: `Fehler: ${(err as Error).message}`, connections: 0 }
    }
    tunnelCache = { at: Date.now(), v }
    refreshing = null
    return v
  })()
  return refreshing
}

/** Beim Start: Tunnel aus der Datenbank, im Hintergrund. */
export async function reconcilePublicOnBoot(): Promise<void> {
  if (!publicEnabled()) return
  try {
    await syncDomains()
    await reconcileTunnel()
  } catch (err) {
    log.warn('Abgleich mit Cloudflare beim Start fehlgeschlagen', { err: (err as Error).message })
  }
}
