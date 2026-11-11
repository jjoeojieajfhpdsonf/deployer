import { eq, and, sql, inArray } from 'drizzle-orm'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { defaultEnvironmentId, defaultEnvironment, environmentById, allEnvironments } from './environments.js'
import { cloudflareFor } from './cloudflare-settings.js'
import { inEnvironment, serverJob, type EnvScope, type ListScope } from '../lib/scope.js'
import { config } from '../config.js'
import { RESERVED_PUBLIC_LABELS, normalizePublicLabel, type PublicNameCheckDto } from '@airlock/shared'
import { Cloudflare, CloudflareError, upsertManagedRecord, isManagedComment, type Zone } from '../drivers/cloudflare.js'
import { resolvePublicHostname, reconcileIngress, tunnelCname, PublicHostError } from '../lib/public-hosts.js'
import { assertPublishable, latestScan, onProjectScanDone } from '../security/scan.js'
import { getPublicRequest, discardPublicRequest, markRequestFailed, toRequestDto, gateReason } from './public-requests.js'
import { setProjectPause, pausePageTemplate } from './pause-page.js'
import type { PauseOptions } from '@airlock/shared'
import { reconcileCaddy, routeDtosFor } from './routes.js'
import { Progress, withProgress, stepsFor, progressOf } from './public-progress.js'
import { checkFromOutside, type Expect } from '../lib/outside-probe.js'
import type { OutsideCheckDto, PublicStatusDto } from '@airlock/shared'
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
 * räumt nur, was Airlock (oder früher deployer) selbst angelegt hat.
 */

const MANAGED_HOSTS_KEY = 'tunnel_managed_hosts'

/**
 * M9: Cloudflare-Zugang einer Umgebung – ihr Token, ihr Konto, der Tunnel
 * des Kontos (einer pro Konto; Umgebungen mit demselben Konto teilen ihn).
 */
interface PubCtx {
  envId: string
  cf: Cloudflare
  accountId: string
  tunnelId: string
  accessEmail: string | null
  baseDomain: string | null
  accountRowId: string | null
}

function ctxFor(envId: string): PubCtx | null {
  const c = cloudflareFor(envId)
  if (!c.token || !c.accountId || !c.tunnelId) return null
  return {
    envId, cf: new Cloudflare({ token: c.token, base: config.CLOUDFLARE_API_BASE }),
    accountId: c.accountId, tunnelId: c.tunnelId, accessEmail: c.accessEmail, baseDomain: c.baseDomain, accountRowId: c.accountRowId,
  }
}

function requireCtx(envId: string): PubCtx {
  const c = ctxFor(envId)
  if (!c) throw new AppError('public_disabled', 'Öffentlich ist in dieser Umgebung nicht eingerichtet: unter Einstellungen → Cloudflare & HTTPS Token und Tunnel einrichten.', 400)
  return c
}

/** Kann diese Umgebung öffentlich schalten (Token, Konto, Tunnel)? Ohne Angabe: Standard-Umgebung. */
export function publicEnabled(envId: string = defaultEnvironmentId()): boolean {
  return ctxFor(envId) !== null
}

/** Client mit dem Token der Umgebung (Standard-Umgebung ohne Angabe). */
function client(envId: string = defaultEnvironmentId()): Cloudflare {
  return requireCtx(envId).cf
}

/** Umgebung eines Projekts (für Aufrufer, die nur id/slug haben). */
async function envOfProject(projectId: string): Promise<string> {
  return (await db.select({ env: schema.projects.environmentId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]?.env ?? defaultEnvironmentId()
}

/** Fehler von Cloudflare als saubere API-Fehler. */
function wrap(err: unknown): never {
  if (err instanceof PublicHostError) throw badRequest(err.message)
  if (err instanceof CloudflareError) throw new AppError('cloudflare', err.message, err.status === 409 ? 409 : err.status >= 400 && err.status < 500 ? 400 : 502)
  throw err
}

/* --- Domains -------------------------------------------------------------------- */

export interface DomainDto { id: string; name: string; zoneId: string; isDefault: boolean }

/**
 * Zonen des Kontos holen und in `domains` spiegeln. Die Standard-Wahl bleibt.
 * M9: Neue Zonen landen in der Umgebung envId (vorerst die Standard-Umgebung;
 * Etappe 3: die Umgebung, deren Token abgeglichen wird); die Antwort ist die
 * Liste dieser Umgebung.
 */
export async function syncDomains(cf?: Cloudflare, envId: string = defaultEnvironmentId()): Promise<DomainDto[]> {
  const c = cf ?? client(envId)
  let zones: Zone[]
  try {
    zones = await c.listZones()
  } catch (err) {
    wrap(err)
  }
  // M9: Aufräumen nur unter den Zonen der Umgebungen mit demselben Konto –
  // Zonen anderer Konten sieht dieses Token gar nicht.
  const account = environmentById(envId)?.account?.id ?? null
  const sameAccount = allEnvironments().filter((e) => e.id === envId || (account && e.account?.id === account)).map((e) => e.id)
  await db.transaction(async (tx) => {
    for (const z of zones) {
      await tx
        .insert(schema.domains)
        .values({ cfZoneId: z.id, name: z.name.toLowerCase(), environmentId: envId })
        .onConflictDoUpdate({ target: schema.domains.cfZoneId, set: { name: z.name.toLowerCase() } })
    }
    const ids = zones.map((z) => z.id)
    const existing = await tx.select().from(schema.domains).where(inArray(schema.domains.environmentId, sameAccount))
    const used = (await tx.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))).map((r) => r.hostname)
    for (const d of existing) {
      if (ids.includes(d.cfZoneId)) continue
      // Noch von einer öffentlichen Route benutzt: behalten, sonst fände das
      // Aufräumen den DNS-Eintrag später nicht mehr (Review M5).
      if (used.some((h) => h === d.name || h.endsWith(`.${d.name}`))) continue
      await tx.delete(schema.domains).where(eq(schema.domains.id, d.id))
    }
  })
  return listDomains(inEnvironment(envId))
}

/** M9: Zonen einer Umgebung (oder aller, für Server-Jobs). */
export async function listDomains(scope: ListScope): Promise<DomainDto[]> {
  const rows = await db.select().from(schema.domains)
    .where(scope.kind === 'env' ? eq(schema.domains.environmentId, scope.envId) : undefined)
    .orderBy(schema.domains.name)
  return rows.map((d) => ({ id: d.id, name: d.name, zoneId: d.cfZoneId, isDefault: d.isDefault }))
}

export async function setDefaultDomain(scope: EnvScope, name: string, actor: string): Promise<DomainDto[]> {
  const n = name.trim().toLowerCase()
  const row = (await db.select().from(schema.domains).where(and(eq(schema.domains.name, n), eq(schema.domains.environmentId, scope.envId))))[0]
  if (!row) throw badRequest(`${n} ist keine Zone dieser Umgebung (Liste zuerst abgleichen)`)
  await db.transaction(async (tx) => {
    await tx.update(schema.domains).set({ isDefault: false }).where(and(eq(schema.domains.isDefault, true), eq(schema.domains.environmentId, scope.envId)))
    await tx.update(schema.domains).set({ isDefault: true }).where(eq(schema.domains.id, row.id))
  })
  await audit({ actor, action: 'domain.default', targetType: 'domain', targetId: row.id, params: { name: n }, result: 'ok' })
  return listDomains(scope)
}

/* --- Öffentlich schalten --------------------------------------------------------- */

export interface PublicInput {
  subdomain?: string
  hostname?: string
  /** Zone der Umgebung zum Namen (statt der Hauptzone); zusammen mit subdomain */
  zone?: string
  /** Direkt unter der Zone (nur ausdrücklich, Schalter «Direkt unter <zone>») */
  apex?: boolean
  /** Fremden DNS-Eintrag ersetzen – nur nach ausdrücklicher Bestätigung */
  takeOver?: boolean
  /** undefined = wie bisher (Review M5: sonst fiel Access beim nächsten Aufruf still weg) */
  accessProtected?: boolean
}

/**
 * Öffentlichen Namen prüfen, ohne etwas zu ändern (Formular: beim Tippen mit
 * Verzögerung; MCP: vor dem Setzen). Prüft Form, reservierte Namen, Zone der
 * Umgebung, interne Basis, Belegung in Airlock und einen vorhandenen
 * DNS-Eintrag bei Cloudflare, der nicht von Airlock stammt (dann mit Typ und
 * Ziel – übernehmen nur nach ausdrücklicher Bestätigung).
 */
export async function checkPublicName(project: Project, input: { label: string; zone?: string; apex?: boolean }): Promise<PublicNameCheckDto> {
  const ctx = requireCtx(project.environmentId)
  const domains = await listDomains(inEnvironment(project.environmentId)).then((d) => (d.length ? d : syncDomains(ctx.cf, project.environmentId)))
  const zones = domains.map((d) => d.name)
  const mainZone = environmentById(project.environmentId)?.zoneName ?? null
  const zoneName = input.zone ?? (mainZone && zones.includes(mainZone) ? mainZone : zones[0] ?? null)
  const label = input.apex ? '' : normalizePublicLabel(input.label)
  const out: PublicNameCheckDto = { host: null, label, zone: zoneName, apex: Boolean(input.apex), zones, problems: [], existing: null }
  const zone = domains.find((d) => d.name === zoneName)
  if (!zoneName || !zone) {
    out.problems.push({ kind: 'zone', message: zoneName ? `${zoneName} gehört nicht zu dieser Umgebung` : 'Diese Umgebung hat noch keine Zone bei Cloudflare' })
    return out
  }
  if (!input.apex && !label) {
    out.problems.push({ kind: 'format', message: 'Gib einen Namen an, z.B. solar' })
    return out
  }
  const host = input.apex ? zoneName : `${label}.${zoneName}`
  out.host = host
  if (!input.apex && (RESERVED_PUBLIC_LABELS as readonly string[]).includes(label)) out.problems.push({ kind: 'reserved', message: `«${label}» ist reserviert` })
  if (ctx.baseDomain && (host === ctx.baseDomain || host.endsWith(`.${ctx.baseDomain}`))) out.problems.push({ kind: 'internal', message: `${host} liegt unter der internen Basis` })
  const taken = await db.select({ projectId: schema.routes.projectId }).from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, host)))
  if (taken.some((r) => r.projectId !== project.id)) out.problems.push({ kind: 'taken', message: `${host} ist in Airlock schon vergeben` })
  try {
    const recs = (await ctx.cf.listRecords(zone.zoneId, host)).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
    const foreign = recs.find((r) => !isManagedComment(r.comment))
    if (foreign) {
      // Worker-Routen und Custom Domains stehen als Platzhalter (AAAA 100:: bzw. A 192.0.2.1) in der Zone
      const worker = (foreign.type === 'AAAA' && foreign.content === '100::') || (foreign.type === 'A' && foreign.content === '192.0.2.1')
      out.existing = { type: foreign.type, content: foreign.content, worker }
      out.problems.push({ kind: 'dns', message: worker
        ? `Für ${host} gibt es bei Cloudflare schon einen Worker bzw. eine Custom Domain`
        : `Für ${host} gibt es bei Cloudflare schon einen Eintrag (${foreign.type} → ${foreign.content}), der nicht von Airlock stammt` })
    }
  } catch (err) {
    log.warn('DNS-Prüfung für öffentlichen Namen fehlgeschlagen', { host, err: String(err) })
  }
  return out
}

export async function publicRoute(projectId: string) {
  return (await db.select().from(schema.routes).where(and(eq(schema.routes.projectId, projectId), eq(schema.routes.target, 'public'))))[0] ?? null
}

type Project = { id: string; slug: string; name: string; environmentId: string }
type PublicRouteRow = NonNullable<Awaited<ReturnType<typeof publicRoute>>>

export interface PublicPlan {
  project: Project
  hostname: string
  zone: Zone
  access: boolean
  before: PublicRouteRow | null
  /** Fremden DNS-Eintrag ersetzen (ausdrücklich bestätigt) */
  takeOver?: boolean
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
  // M9: Token, Konto und Tunnel der Umgebung des Projekts
  const ctx = requireCtx(project.environmentId)
  const cf = ctx.cf
  await assertPublishable(project.id)
  try {
    const before = await publicRoute(project.id)
    // M9: nur Zonen der Umgebung des Projekts; Standard-Domain ist ihre Hauptzone
    const own = inEnvironment(project.environmentId)
    const domains = await listDomains(own).then((d) => (d.length ? d : syncDomains(cf, project.environmentId)))
    const mainZone = environmentById(project.environmentId)?.zoneName ?? null
    // Name und Zone getrennt (Antwort Adressen): zu einem Hostnamen zusammensetzen; die Zone muss zur Umgebung gehören
    if (input.zone && !domains.some((d) => d.name === input.zone)) {
      throw badRequest(`Die Zone ${input.zone} gehört nicht zu dieser Umgebung. Möglich: ${domains.map((d) => d.name).join(', ') || 'keine'}`)
    }
    const fromParts = input.zone ? (input.apex ? input.zone : input.subdomain ? `${input.subdomain}.${input.zone}` : undefined) : undefined
    const nameGiven = Boolean(input.subdomain || input.hostname || fromParts)
    const { hostname, zone } = resolvePublicHostname(
      fromParts ? { hostname: fromParts } : nameGiven ? { subdomain: input.subdomain, hostname: input.hostname } : before ? { hostname: before.hostname } : { subdomain: project.slug },
      {
        zones: domains.map((d) => ({ id: d.zoneId, name: d.name })),
        defaultZone: (mainZone && domains.some((d) => d.name === mainZone) ? mainZone : null) ?? domains.find((d) => d.isDefault)?.name ?? null,
        internalBaseDomain: ctx.baseDomain,
        reservedLabels: RESERVED_PUBLIC_LABELS,
        allowApex: Boolean(input.apex) || (!nameGiven && Boolean(before) && before?.hostname === mainZone),
      },
    )
    const clash = await db.select().from(schema.routes).where(and(eq(schema.routes.target, 'public'), eq(schema.routes.hostname, hostname)))
    if (clash.some((r) => r.projectId !== project.id)) throw conflict(`${hostname} ist schon von einem anderen Projekt belegt`)
    // M9: ohne Angabe und ohne frühere Route gilt der Access-Standard der Umgebung
    const access = input.accessProtected ?? (before ? before.accessProtected : Boolean(environmentById(project.environmentId)?.row.accessDefault))
    if (access && !ctx.accessEmail) throw badRequest('Für Cloudflare Access braucht es eine E-Mail-Adresse (Einstellungen → Standards → Cloudflare Access).')
    return { project, hostname, zone, access, before, takeOver: Boolean(input.takeOver) }
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
  const ctx = requireCtx(plan.project.environmentId)
  const cf = ctx.cf
  const { project, hostname, zone, before } = plan
  const created: { recordId?: string; accessId?: string } = {}
  const sameName = before?.hostname === hostname
  try {
    // 1. DNS: CNAME proxied auf den Tunnel; fremde Einträge bleiben unangetastet.
    progress?.start('dns')
    const rec = await upsertManagedRecord(cf, zone.id, { type: 'CNAME', name: hostname, content: tunnelCname(ctx.tunnelId), proxied: true }, { takeOver: plan.takeOver })
    if (rec.action === 'created') created.recordId = rec.record.id
    progress?.set('dns', 'done', rec.action === 'created' ? `CNAME ${hostname} auf den Tunnel angelegt` : `CNAME ${hostname} zeigt auf den Tunnel`)

    // 2. Access
    progress?.start('access')
    let accessAppId = sameName ? before.cfAccessAppId : null
    if (plan.access && !accessAppId) {
      accessAppId = (await cf.createAccessApp(ctx.accountId, { name: `Airlock: ${project.name}`, domain: hostname, email: ctx.accessEmail! })).id
      created.accessId = accessAppId
    }

    // 3. Route speichern (eine öffentliche Route pro Projekt), Belegung unter Sperre erneut prüfen
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('airlock.routes'))`)
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
    if (!plan.access && accessAppId) await cf.deleteAccessApp(ctx.accountId, accessAppId).catch((e) => log.warn('Access-App nicht entfernt', { err: String(e) }))
    progress?.set('access', 'done', plan.access ? 'Login per E-Mail-Code vorgeschaltet' : 'ohne Login')

    // 5. Alter Name (bei Umbenennung) aus DNS und Access entfernen
    if (before && before.hostname !== hostname) await dropCloudflareObjects(cf, ctx.accountId, before).catch((e) => log.warn('Alter öffentlicher Name nicht vollständig entfernt', { err: String(e) }))

    // 6. Tunnel aus der Datenbank (Caddy gleicht der Aufrufer ab)
    progress?.start('tunnel')
    await reconcileTunnelFor(ctx.envId)
    progress?.set('tunnel', 'done', `${hostname} → Caddy`)

    // Welcher Übergang: neu, umbenannt oder nur Access an/aus (Audit-Log)
    const action = !before ? 'project.public' : !sameName ? 'project.public.rename' : before.accessProtected !== plan.access ? 'project.public.access' : 'project.public.change'
    await audit({ actor, action, targetType: 'project', targetId: project.id, params: { hostname, accessProtected: plan.access, ...(before && !sameName ? { before: before.hostname } : {}) }, result: 'ok' })
    if (!before) await notify('project_public', { project: project.name, url: `https://${hostname}` }, project.id)
    return { hostname }
  } catch (err) {
    // Zurücknehmen, was dieser Aufruf neu angelegt hat (Review M5: sonst verwaist bei Cloudflare)
    if (created.accessId) await cf.deleteAccessApp(ctx.accountId, created.accessId).catch(() => {})
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
  // M9: Token und Konto der Umgebung des Projekts
  const envId = await envOfProject(project.id)
  const c = cloudflareFor(envId)
  const cf = c.token ? new Cloudflare({ token: c.token, base: config.CLOUDFLARE_API_BASE }) : null
  const accountId = c.accountId
  const pr = opts.progress
  const problems: string[] = []
  if (cf && accountId) {
    pr?.start('dns')
    await dropCloudflareObjects(cf, accountId, route, pr).catch((e) => {
      problems.push(String((e as Error).message))
      pr?.set(pr.dto.steps.find((s) => s.state === 'current')?.key ?? 'dns', 'warn', (e as Error).message)
    })
  } else {
    problems.push('kein Cloudflare-Token: DNS-Eintrag und Access-App bleiben bei Cloudflare stehen')
    pr?.set('dns', 'warn', 'Kein Cloudflare-Token: der DNS-Eintrag bleibt stehen')
  }
  await db.delete(schema.routes).where(eq(schema.routes.id, route.id))
  if (cf && accountId && c.tunnelId) {
    pr?.start('tunnel')
    await reconcileTunnelFor(envId).then(
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

async function dropCloudflareObjects(cf: Cloudflare, accountId: string, route: { hostname: string; cfDnsRecordId: string | null; cfAccessAppId: string | null }, pr?: Progress): Promise<void> {
  const domains = await listDomains(serverJob('cloudflare-aufräumen'))
  const zone = domains.find((d) => route.hostname === d.name || route.hostname.endsWith(`.${d.name}`))
  if (route.cfDnsRecordId && !zone) throw new Error(`Zone von ${route.hostname} unbekannt; DNS-Eintrag bitte in Cloudflare von Hand entfernen`)
  if (route.cfDnsRecordId && zone) {
    // Nur löschen, was wirklich von Airlock (oder früher deployer) stammt.
    const recs = await cf.listRecords(zone.zoneId, route.hostname)
    const mine = recs.find((r) => r.id === route.cfDnsRecordId && isManagedComment(r.comment))
    if (mine) await cf.deleteRecord(zone.zoneId, mine.id)
    pr?.set('dns', 'done', mine ? `CNAME ${route.hostname} entfernt` : 'kein eigener Eintrag mehr vorhanden')
  } else {
    pr?.set('dns', 'done', 'kein eigener Eintrag')
  }
  pr?.start('access')
  if (route.cfAccessAppId) await cf.deleteAccessApp(accountId, route.cfAccessAppId)
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
    const access = input.accessProtected ?? (before ? before.accessProtected : Boolean(environmentById(project.environmentId)?.row.accessDefault))
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
  if (!publicEnabled(await envOfProject(projectId))) return { ok: false, why: 'disabled', reason: gateReason({ why: 'disabled' }) }
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
    enabled: publicEnabled(await envOfProject(project.id)),
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
/** M9: Alle Tunnel abgleichen (einer pro Konto). Ein Fehler in einem Konto hält die anderen nicht auf. */
export async function reconcileTunnel(): Promise<{ hosts: string[] }> {
  const hosts: string[] = []
  const errors: string[] = []
  for (const envId of tunnelOwners()) {
    await reconcileTunnelFor(envId).then((r) => hosts.push(...r.hosts), (e) => errors.push(String((e as Error).message)))
  }
  if (errors.length) throw new AppError('cloudflare', errors.join('; '), 502)
  return { hosts }
}

/** Je Tunnel (Konto) eine Umgebung, über die er erreicht wird – die Standard-Umgebung zuerst. */
function tunnelOwners(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of allEnvironments()) {
    const c = ctxFor(e.id)
    if (!c || seen.has(c.tunnelId)) continue
    seen.add(c.tunnelId)
    out.push(e.id)
  }
  return out
}

/**
 * Den Tunnel einer Umgebung abgleichen: Ingress-Regeln aus den öffentlichen
 * Routen ALLER Umgebungen, die dasselbe Konto (also denselben Tunnel) nutzen.
 */
export function reconcileTunnelFor(envId: string): Promise<{ hosts: string[] }> {
  const run = () => reconcileTunnelNow(requireCtx(envId))
  const next = tunnelChain.then(run, run)
  tunnelChain = next.catch(() => {})
  return next
}

/** Gespeicherte «eigene» Namen je Tunnel; der Tunnel der Standard-Umgebung behält den alten Schlüssel. */
const managedKeyFor = (ctx: PubCtx) => (ctx.accountRowId && ctx.accountRowId !== defaultEnvironment().account?.id ? `${MANAGED_HOSTS_KEY}:${ctx.tunnelId}` : MANAGED_HOSTS_KEY)

async function reconcileTunnelNow(ctx: PubCtx): Promise<{ hosts: string[] }> {
  const sameTunnel = allEnvironments().filter((e) => ctxFor(e.id)?.tunnelId === ctx.tunnelId).map((e) => e.id)
  const rows = await db.select({ hostname: schema.routes.hostname, env: schema.projects.environmentId }).from(schema.routes)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.routes.projectId))
    .where(and(eq(schema.routes.target, 'public'), inArray(schema.projects.environmentId, sameTunnel)))
  const key = managedKeyFor(ctx)
  const managedBefore: string[] = JSON.parse((await getSetting(key)) ?? '[]')
  const current = await ctx.cf.getTunnelIngress(ctx.accountId, ctx.tunnelId)
  // Kein öffentlicher Name unter einer internen Basis (Wildcard-Zertifikat, nur intern)
  const bases = allEnvironments().map((e) => cloudflareFor(e.id).baseDomain).filter((b): b is string => Boolean(b))
  const forbidden = rows.map((r) => r.hostname).filter((h) => bases.some((b) => h.endsWith(`.${b}`)))
  const { ingress, managed } = reconcileIngress(current, rows.map((r) => r.hostname), managedBefore, forbidden)
  if (JSON.stringify(ingress) !== JSON.stringify(current)) {
    await ctx.cf.putTunnelIngress(ctx.accountId, ctx.tunnelId, ingress)
    log.info('Tunnel-Ingress abgeglichen', { tunnel: ctx.tunnelId, hosts: managed })
  }
  await setSetting(key, JSON.stringify(managed))
  return { hosts: managed }
}

const tunnelCache = new Map<string, { at: number; v: { status: string; connections: number } }>()
const refreshing = new Map<string, Promise<{ status: string; connections: number }>>()

/** Zustand des Tunnels der Standard-Umgebung (Kompatibilität). */
export function tunnelStatus(): Promise<{ status: string; connections: number } | null> {
  return tunnelStatusFor(defaultEnvironmentId())
}

/** Zustand des Tunnels einer Umgebung, höchstens eine Minute alt (die Seite fragt alle 15 s). */
export async function tunnelStatusFor(envId: string): Promise<{ status: string; connections: number } | null> {
  const ctx = ctxFor(envId)
  if (!ctx) return null
  // Veraltet: im Hintergrund neu holen und sofort den letzten Stand liefern –
  // die Seite soll nie auf Cloudflare warten (Review M5).
  const cached = tunnelCache.get(ctx.tunnelId)
  if (!cached || Date.now() - cached.at >= 60_000) {
    const refresh = refreshTunnelStatus(ctx)
    if (!cached) return refresh
  }
  return cached!.v
}

function refreshTunnelStatus(ctx: PubCtx): Promise<{ status: string; connections: number }> {
  const running = refreshing.get(ctx.tunnelId)
  if (running) return running
  const run = (async () => {
    let v: { status: string; connections: number }
    try {
      v = await ctx.cf.tunnelStatus(ctx.accountId, ctx.tunnelId)
    } catch (err) {
      v = { status: `Fehler: ${(err as Error).message}`, connections: 0 }
    }
    tunnelCache.set(ctx.tunnelId, { at: Date.now(), v })
    refreshing.delete(ctx.tunnelId)
    return v
  })()
  refreshing.set(ctx.tunnelId, run)
  return run
}

/** Beim Start: Zonen und Tunnel aus der Datenbank, je Umgebung bzw. Konto, im Hintergrund. */
export async function reconcilePublicOnBoot(): Promise<void> {
  for (const envId of tunnelOwners()) {
    try {
      await syncDomains(client(envId), envId)
      await reconcileTunnelFor(envId)
    } catch (err) {
      log.warn('Abgleich mit Cloudflare beim Start fehlgeschlagen', { umgebung: environmentById(envId)?.slug, err: (err as Error).message })
    }
  }
}

/**
 * M9: Zone desselben Kontos, die noch bei einer anderen Umgebung liegt, in
 * diese Umgebung holen (Hauptzone wählen). Nicht, wenn sie dort Hauptzone ist
 * oder ein öffentliches Projekt dort einen Namen in ihr trägt.
 */
export async function claimZone(envId: string, zoneName: string): Promise<void> {
  const row = (await db.select().from(schema.domains).where(eq(schema.domains.name, zoneName)).limit(1))[0]
  if (!row || row.environmentId === envId) return
  const other = environmentById(row.environmentId)
  const mine = environmentById(envId)
  if (!other || !mine) return
  if (other.account?.id !== mine.account?.id) throw conflict(`${zoneName} gehört zur Umgebung «${other.name}» mit einem anderen Cloudflare-Konto`)
  if (other.zoneName === zoneName) throw conflict(`${zoneName} ist die Hauptzone der Umgebung «${other.name}»`)
  const used = await db.select({ hostname: schema.routes.hostname }).from(schema.routes)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.routes.projectId))
    .where(and(eq(schema.routes.target, 'public'), eq(schema.projects.environmentId, row.environmentId)))
  if (used.some((r) => r.hostname === zoneName || r.hostname.endsWith(`.${zoneName}`))) {
    throw conflict(`In ${zoneName} sind noch öffentliche Projekte der Umgebung «${other.name}»`)
  }
  await db.update(schema.domains).set({ environmentId: envId }).where(eq(schema.domains.id, row.id))
  await audit({ actor: 'system', action: 'domain.move', targetType: 'domain', targetId: row.id, environmentId: envId, params: { name: zoneName, from: other.slug, to: mine.slug }, result: 'ok' })
}
