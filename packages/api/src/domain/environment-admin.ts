import { and, eq, isNull, ne, inArray } from 'drizzle-orm'
import { Resolver } from 'node:dns/promises'
import {
  templateHeaderKeys, headerValueProblem, RESERVED_SLUGS,
  type EnvironmentDto, type CreateEnvironmentInput, type UpdateEnvironmentInput, type HeaderTemplateDto,
  type HeaderKeyName, type LanDnsCheckDto, type MovePreviewDto, type CfTlsPhase,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config, net } from '../config.js'
import {
  allEnvironments, environmentById, environmentBySlug, defaultEnvironment, createEnvironment, reloadEnvironments,
  hostSettingsFor, primaryHostIn, type EnvRuntime,
} from './environments.js'
import { listProjects, findProject } from './projects.js'
import { audit } from './audit.js'
import { inEnvironment, sessionScope, type Scope } from '../lib/scope.js'
import { labelOf } from '../lib/hostnames.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'

/**
 * M9: Umgebungen verwalten (SPEC «Umgebungen»): Liste mit Kennzahlen,
 * anlegen, ändern, löschen; Header-Vorlagen; Projekt verschieben;
 * Prüfung des lokalen DNS. Nur mit Anmeldung (REST-Wächter), nie per MCP.
 */

/* --- Liste ------------------------------------------------------------------------- */

const tlsPhaseOf = (env: EnvRuntime): CfTlsPhase =>
  env.row.tlsState?.phase ?? (env.isDefault && config.TLS_MODE === 'cloudflare' ? 'done' : 'off')

export async function environmentDto(env: EnvRuntime): Promise<EnvironmentDto> {
  const projects = await listProjects(inEnvironment(env.id))
  const targets = await db.select({ id: schema.externalTargets.id }).from(schema.externalTargets).where(eq(schema.externalTargets.environmentId, env.id))
  const sharedWith = env.account ? allEnvironments().filter((e) => e.id !== env.id && e.account?.id === env.account!.id).map((e) => e.name) : []
  return {
    id: env.id,
    slug: env.slug,
    name: env.name,
    short: env.short,
    isDefault: env.isDefault,
    zone: env.zoneName,
    baseDomain: hostSettingsFor(env.id).baseDomain,
    projects: projects.length,
    critical: projects.reduce((n, p) => n + (p.security?.open.critical ?? 0), 0),
    internalPrefix: env.internalPrefix,
    account: env.account ? { name: env.account.name, sharedWith } : null,
    tlsPhase: tlsPhaseOf(env),
    accessDefault: env.row.accessDefault,
    accessEmails: env.row.accessEmails,
    notifyMuted: env.row.notifyMuted,
    externalTargets: targets.length,
  }
}

export async function listEnvironmentDtos(): Promise<EnvironmentDto[]> {
  return Promise.all(allEnvironments().map(environmentDto))
}

/** Umgebung aus Slug oder ID; unbekannt = «nicht gefunden». */
export function resolveEnv(key: string): EnvRuntime {
  const e = environmentBySlug(key) ?? environmentById(key)
  if (!e) throw notFound('Umgebung')
  return e
}

/** Cloudflare-Stand aller Umgebungen neu einlesen (Token-Dateien, Laufzeit der Standard-Umgebung). */
async function reloadCloudflare(): Promise<void> {
  const { loadCloudflareSettings } = await import('./cloudflare-settings.js')
  await loadCloudflareSettings()
}

async function reconcile(): Promise<void> {
  const { reconcileCaddy } = await import('./routes.js')
  await reconcileCaddy({ force: true }).catch((err) => log.warn('Caddy-Abgleich fehlgeschlagen', { err: String(err) }))
}

/* --- Anlegen, ändern, löschen ---------------------------------------------------------- */

/** Pfadteile, die keine Umgebung heissen dürfen (Adressen /u/<slug>/…) */
const RESERVED_ENV_SLUGS = new Set(['neu', 'new', 'u', 'server', 'umgebungen', 'konto', 'api'])

export async function createEnvironmentFull(input: CreateEnvironmentInput, actor: string): Promise<EnvironmentDto> {
  if (RESERVED_ENV_SLUGS.has(input.slug) || (RESERVED_SLUGS as readonly string[]).includes(input.slug)) {
    throw badRequest(`«${input.slug}» ist reserviert`, [{ path: 'slug', message: 'Bitte einen anderen Kurznamen wählen.' }])
  }
  if (environmentBySlug(input.slug)) throw badRequest(`Eine Umgebung «${input.slug}» gibt es schon`, [{ path: 'slug', message: 'Kurzname schon vergeben.' }])
  if (input.shareAccountOf && !environmentById(input.shareAccountOf)?.account) {
    throw badRequest('Diese Umgebung hat noch kein Cloudflare-Token zum Mitbenutzen', [{ path: 'shareAccountOf', message: 'Eine Umgebung mit Token wählen.' }])
  }
  const env = await createEnvironment({ name: input.name, slug: input.slug, short: input.short, shareAccountOf: input.shareAccountOf ?? null, internalPrefix: input.internalPrefix })
  const from = input.copyStandardsFrom ? environmentById(input.copyStandardsFrom) : null
  if (from) {
    const templates = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, from.id))
    if (templates.length) {
      await db.insert(schema.headerRuleTemplates).values(templates.map((t) => ({ environmentId: env.id, header: t.header, value: t.value, mode: t.mode })))
    }
    await db.update(schema.environments).set({
      pausePage: from.row.pausePage, accessDefault: from.row.accessDefault, accessEmails: from.row.accessEmails, updatedAt: new Date(),
    }).where(eq(schema.environments.id, env.id))
  }
  await reloadEnvironments()
  await reloadCloudflare()
  await audit({
    actor, action: 'environment.create', targetType: 'environment', targetId: env.id, environmentId: env.id,
    params: { name: env.name, slug: env.slug, shareAccountOf: input.shareAccountOf ?? null, copyStandardsFrom: from?.slug ?? null }, result: 'ok',
  })
  return environmentDto(environmentById(env.id)!)
}

export async function updateEnvironment(key: string, patch: UpdateEnvironmentInput, actor: string): Promise<EnvironmentDto> {
  const env = resolveEnv(key)
  const values: Partial<typeof schema.environments.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) values.name = patch.name
  if (patch.short !== undefined) values.short = patch.short.toUpperCase()
  if (patch.accessDefault !== undefined) values.accessDefault = patch.accessDefault
  if (patch.accessEmails !== undefined) values.accessEmails = patch.accessEmails
  if (patch.notifyMuted !== undefined) values.notifyMuted = patch.notifyMuted
  if (patch.shareAccountOf !== undefined) {
    const from = environmentById(patch.shareAccountOf)
    if (!from?.account) throw badRequest('Diese Umgebung hat kein Cloudflare-Token zum Mitbenutzen', [{ path: 'shareAccountOf', message: 'Eine Umgebung mit Token wählen.' }])
    if (env.account && env.account.id !== from.account.id) throw conflict('Diese Umgebung hat schon ein eigenes Cloudflare-Token. Zuerst trennen.')
    values.cloudflareAccountId = from.account.id
  }
  await db.transaction(async (tx) => {
    if (patch.makeDefault && !env.isDefault) {
      // Teilindex «genau eine Standard-Umgebung»: zuerst die alte lösen
      await tx.update(schema.environments).set({ isDefault: false }).where(eq(schema.environments.isDefault, true))
      values.isDefault = true
    }
    await tx.update(schema.environments).set(values).where(eq(schema.environments.id, env.id))
  })
  await reloadEnvironments()
  await reloadCloudflare()
  if (patch.makeDefault && !env.isDefault) await reconcile() // Adresse der Oberfläche wandert mit
  await audit({ actor, action: 'environment.update', targetType: 'environment', targetId: env.id, environmentId: env.id, params: patch, result: 'ok' })
  return environmentDto(environmentById(env.id)!)
}

/**
 * Löschen nur, wenn die Umgebung leer ist (keine Projekte, keine externen
 * Ziele) und nicht die Standard-Umgebung. Entfernt Tailnet-Eintrag, trennt
 * Cloudflare (Tunnel nur, wenn ihn keine andere Umgebung nutzt), widerruft
 * und löscht die Tokens der Umgebung.
 */
export async function deleteEnvironment(key: string, actor: string): Promise<void> {
  const env = resolveEnv(key)
  if (env.isDefault) throw conflict('Die Standard-Umgebung lässt sich nicht löschen. Zuerst eine andere zur Standard-Umgebung machen.')
  // Etappe 6: Vorschauen zählen nicht (sie verschwinden mit ihrem Projekt)
  const projects = await db.select({ slug: schema.projects.slug }).from(schema.projects).where(and(eq(schema.projects.environmentId, env.id), isNull(schema.projects.previewOf)))
  if (projects.length) throw conflict(`Die Umgebung hat noch ${projects.length === 1 ? 'ein Projekt' : `${projects.length} Projekte`} (${projects.map((p) => p.slug).join(', ')}). Zuerst löschen oder verschieben.`)
  const targets = await db.select({ hostname: schema.externalTargets.hostname }).from(schema.externalTargets).where(eq(schema.externalTargets.environmentId, env.id))
  if (targets.length) throw conflict(`Die Umgebung hat noch externe Ziele (${targets.map((t) => t.hostname).join(', ')}).`)

  // Etappe 5: Statusseite ausschalten (CNAME, Tunnel-Regel, Dateien), solange das Token noch da ist
  const statusOn = await db.select({ on: schema.statusPages.enabled }).from(schema.statusPages).where(eq(schema.statusPages.environmentId, env.id))
  if (statusOn[0]?.on) {
    const { setStatusSettings } = await import('../status/service.js')
    await setStatusSettings(env.id, { enabled: false }, actor).catch((err) => log.warn('Statusseite nicht ausgeschaltet', { umgebung: env.slug, err: String(err) }))
  }

  const cs = await import('./cloudflare-settings.js')
  const c = cs.cloudflareFor(env.id)
  if (c.token && c.baseDomain) {
    const { removeTailnetDnsFor } = await import('./tailnet.js')
    await removeTailnetDnsFor(c.baseDomain, c.token, actor).catch((err) => log.warn('Tailnet-Eintrag nicht entfernt', { umgebung: env.slug, err: String(err) }))
  }
  if (env.account) await cs.withCloudflareEnv(env.id, () => cs.disconnect(actor)).catch((err) => log.warn('Cloudflare nicht getrennt', { umgebung: env.slug, err: String(err) }))

  const tokens = await db.select({ id: schema.apiTokens.id, name: schema.apiTokens.name }).from(schema.apiTokens).where(eq(schema.apiTokens.environmentId, env.id))
  await db.transaction(async (tx) => {
    await tx.delete(schema.apiTokens).where(eq(schema.apiTokens.environmentId, env.id))
    await tx.delete(schema.domains).where(eq(schema.domains.environmentId, env.id))
    await tx.delete(schema.environments).where(eq(schema.environments.id, env.id))
  })
  await reloadEnvironments()
  await reloadCloudflare()
  await reconcile()
  await audit({ actor, action: 'environment.delete', targetType: 'environment', targetId: env.id, environmentId: null, params: { name: env.name, slug: env.slug, tokens: tokens.map((t) => t.name) }, result: 'ok' })
}

/** Assistent, Schritt 7: Standards (Header-Vorlagen, Pause-Seite, Access) einer anderen Umgebung übernehmen. */
export async function copyStandards(key: string, fromKey: string, actor: string): Promise<EnvironmentDto> {
  const env = resolveEnv(key)
  const from = resolveEnv(fromKey)
  if (from.id === env.id) throw badRequest('Quelle und Ziel sind dieselbe Umgebung')
  const templates = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, from.id))
  await db.transaction(async (tx) => {
    await tx.delete(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, env.id))
    if (templates.length) await tx.insert(schema.headerRuleTemplates).values(templates.map((t) => ({ environmentId: env.id, header: t.header, value: t.value, mode: t.mode })))
    await tx.update(schema.environments).set({ pausePage: from.row.pausePage, accessDefault: from.row.accessDefault, accessEmails: from.row.accessEmails, updatedAt: new Date() }).where(eq(schema.environments.id, env.id))
  })
  await reloadEnvironments()
  await reloadCloudflare()
  await audit({ actor, action: 'environment.copy_standards', targetType: 'environment', targetId: env.id, environmentId: env.id, params: { from: from.slug, headers: templates.map((t) => t.header) }, result: 'ok' })
  await reconcile()
  return environmentDto(environmentById(env.id)!)
}

/* --- Header-Vorlagen ------------------------------------------------------------------- */

const isTemplateHeader = (h: string): h is HeaderKeyName => (templateHeaderKeys as readonly string[]).includes(h)

export async function listHeaderTemplates(key: string): Promise<HeaderTemplateDto[]> {
  const env = resolveEnv(key)
  const templates = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, env.id))
  const projects = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(and(eq(schema.projects.environmentId, env.id), isNull(schema.projects.previewOf)))
  const own = projects.length
    ? await db.select().from(schema.headerRules).where(inArray(schema.headerRules.projectId, projects.map((p) => p.id)))
    : []
  const order = (h: string) => templateHeaderKeys.indexOf(h as HeaderKeyName)
  return templates.sort((a, b) => order(a.header) - order(b.header)).map((t) => {
    const overrides = own.filter((r) => r.header === t.header)
    return {
      header: t.header as HeaderKeyName,
      value: t.value,
      mode: t.mode,
      appliesTo: projects.length - overrides.length,
      projects: projects.length,
      overriddenBy: overrides.map((r) => ({ project: projects.find((p) => p.id === r.projectId)?.name ?? '?', mode: r.mode === 'off' ? 'off' as const : 'own' as const })),
    }
  })
}

export async function setHeaderTemplate(key: string, header: string, input: { value: string; mode?: 'enforce' | 'report-only' }, actor: string): Promise<HeaderTemplateDto[]> {
  const env = resolveEnv(key)
  if (!isTemplateHeader(header)) throw badRequest('Diesen Header gibt es nicht als Vorlage (die Content-Security-Policy bleibt pro Projekt)')
  const mode = input.mode ?? 'enforce'
  const value = input.value.trim()
  const problem = headerValueProblem(header, value, mode)
  if (problem) throw badRequest(problem, [{ path: 'value', message: problem }])
  await db.insert(schema.headerRuleTemplates).values({ environmentId: env.id, header, value, mode })
    .onConflictDoUpdate({ target: [schema.headerRuleTemplates.environmentId, schema.headerRuleTemplates.header], set: { value, mode, updatedAt: new Date() } })
  await audit({ actor, action: 'environment.header_template.set', targetType: 'environment', targetId: env.id, environmentId: env.id, params: { header, value, mode }, result: 'ok' })
  await reconcile()
  return listHeaderTemplates(env.id)
}

export async function removeHeaderTemplate(key: string, header: string, actor: string): Promise<HeaderTemplateDto[]> {
  const env = resolveEnv(key)
  await db.delete(schema.headerRuleTemplates).where(and(eq(schema.headerRuleTemplates.environmentId, env.id), eq(schema.headerRuleTemplates.header, header as HeaderKeyName)))
  await audit({ actor, action: 'environment.header_template.remove', targetType: 'environment', targetId: env.id, environmentId: env.id, params: { header }, result: 'ok' })
  await reconcile()
  return listHeaderTemplates(env.id)
}

/** Vorlagen-Header für ein Projekt ab- (off) oder wieder einschalten. */
export async function setTemplateOff(scope: Scope, projectKey: string, header: string, off: boolean, actor: string): Promise<void> {
  const p = await findProject(scope, projectKey)
  if (!isTemplateHeader(header)) throw badRequest('Diesen Header gibt es nicht als Vorlage')
  const existing = (await db.select().from(schema.headerRules).where(and(eq(schema.headerRules.projectId, p.id), eq(schema.headerRules.header, header))))[0]
  if (off) {
    if (existing && existing.mode !== 'off') throw conflict('Das Projekt hat für diesen Header eine eigene Regel; die zuerst entfernen')
    if (!existing) await db.insert(schema.headerRules).values({ projectId: p.id, header, value: '', mode: 'off' })
  } else if (existing?.mode === 'off') {
    await db.delete(schema.headerRules).where(eq(schema.headerRules.id, existing.id))
  }
  await audit({ actor, action: off ? 'project.header_template.off' : 'project.header_template.on', targetType: 'project', targetId: p.id, params: { header }, result: 'ok' })
  await reconcile()
}

/* --- Projekt verschieben ---------------------------------------------------------------- */

const REDIRECT_DAYS = 30

export async function previewMove(scope: Scope, projectKey: string, toKey: string): Promise<MovePreviewDto> {
  const p = await findProject(scope, projectKey)
  const from = environmentById(p.environmentId)!
  const to = resolveEnv(toKey)
  const routes = await db.select().from(schema.routes).where(eq(schema.routes.projectId, p.id))
  const internal = routes.find((r) => r.target !== 'public')
  const pub = routes.find((r) => r.target === 'public')
  const request = (await db.select({ id: schema.publicRequests.projectId }).from(schema.publicRequests).where(eq(schema.publicRequests.projectId, p.id)).limit(1))[0]
  const newHost = internal ? primaryHostIn(to.id, labelOf(internal.hostname)) : null
  let blocked: string | null = null
  if (to.id === from.id) blocked = 'Das Projekt ist schon in dieser Umgebung'
  if (!blocked && newHost) {
    const clash = await db.select({ projectId: schema.routes.projectId }).from(schema.routes).where(and(eq(schema.routes.hostname, newHost), ne(schema.routes.projectId, p.id)))
    if (clash.length) blocked = `${newHost} ist in der Zielumgebung schon belegt`
  }
  const busy = await db.select({ id: schema.deployments.id }).from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, p.id), inArray(schema.deployments.status, ['pending', 'pulling', 'starting', 'healthchecking'])))
  if (!blocked && busy.length) blocked = 'Gerade läuft ein Deploy; danach verschieben'

  // Header: geerbte Vorlagen wechseln, eigene Regeln bleiben
  const own = await db.select().from(schema.headerRules).where(eq(schema.headerRules.projectId, p.id))
  const tFrom = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, from.id))
  const tTo = await db.select().from(schema.headerRuleTemplates).where(eq(schema.headerRuleTemplates.environmentId, to.id))
  const headers = templateHeaderKeys
    .filter((h) => !own.some((r) => r.header === h))
    .map((h) => ({ header: h, from: tFrom.find((t) => t.header === h)?.value ?? null, to: tTo.find((t) => t.header === h)?.value ?? null }))
    .filter((x) => x.from !== x.to)
  const tokens = await db.select({ name: schema.apiTokens.name }).from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.environmentId, from.id), isNull(schema.apiTokens.revokedAt)))
  return {
    from: { id: from.id, name: from.name, slug: from.slug },
    to: { id: to.id, name: to.name, slug: to.slug },
    internal: internal ? { from: internal.hostname, to: newHost, redirectDays: REDIRECT_DAYS } : null,
    public: pub ? { hostname: pub.hostname, paused: pub.pausedAt !== null, pendingRequest: Boolean(request) } : (request ? { hostname: '', paused: false, pendingRequest: true } : null),
    headers,
    tokensLosingAccess: tokens.map((t) => t.name),
    blocked,
  }
}

/**
 * Verschieben (SPEC, Tabelle «Projekt verschieben»): öffentliche Route samt
 * DNS, Tunnel-Regel und Access entfernen (Pause und Anfrage verworfen),
 * Umgebung wechseln, interne Adresse unter der neuen Basis, alte leitet 30
 * Tage weiter. Container, Versionen, Scans, Secrets bleiben – nur Caddy wird
 * abgeglichen. Nur mit Anmeldung.
 */
export async function moveProject(projectKey: string, toKey: string, actor: string): Promise<MovePreviewDto> {
  const scope = sessionScope()
  const plan = await previewMove(scope, projectKey, toKey)
  if (plan.blocked) throw new AppError('move_blocked', plan.blocked, 409)
  const p = await findProject(scope, projectKey)
  // Etappe 6: Vorschauen hängen an Basis und Umgebung – vorher entfernen; die nächste
  // Abfrage legt sie für offene Pull Requests in der neuen Umgebung wieder an
  {
    const { removeAllPreviews } = await import('./previews.js')
    await removeAllPreviews(p, 'moved', actor)
    await db.update(schema.projects).set({ previewSeen: null }).where(eq(schema.projects.id, p.id))
  }
  if (plan.public?.hostname) {
    const { removePublic } = await import('./public.js')
    await removePublic(p, actor, { skipCaddy: true, strict: false })
  }
  if (plan.public?.pendingRequest) {
    const { discardPublicRequest } = await import('./public-requests.js')
    await discardPublicRequest(p.id, actor, `verworfen: Projekt nach «${plan.to.name}» verschoben`).catch(() => {})
  }
  const until = new Date(Date.now() + REDIRECT_DAYS * 86_400_000)
  await db.transaction(async (tx) => {
    await tx.update(schema.projects).set({ environmentId: plan.to.id, updatedAt: new Date() }).where(eq(schema.projects.id, p.id))
    if (plan.internal?.from && plan.internal.to && plan.internal.from !== plan.internal.to) {
      await tx.update(schema.routes).set({ hostname: plan.internal.to }).where(and(eq(schema.routes.projectId, p.id), ne(schema.routes.target, 'public')))
      await tx.insert(schema.routeRedirects).values({ environmentId: plan.from.id, projectId: p.id, fromHost: plan.internal.from, toHost: plan.internal.to, until })
        .onConflictDoUpdate({ target: schema.routeRedirects.fromHost, set: { toHost: plan.internal.to, until, projectId: p.id } })
    }
  })
  const params = { project: p.slug, from: plan.from.slug, to: plan.to.slug, internal: plan.internal, removedPublic: plan.public?.hostname || null }
  await audit({ actor, action: 'project.move', targetType: 'project', targetId: p.id, environmentId: plan.from.id, params, result: 'ok' })
  await audit({ actor, action: 'project.move', targetType: 'project', targetId: p.id, environmentId: plan.to.id, params, result: 'ok' })
  await reconcile()
  return plan
}

/* --- Lokaler DNS ------------------------------------------------------------------------- */

let resolver: (name: string) => Promise<string[]> = (name) => new Resolver().resolve4(name)
/** Nur für Tests */
export function setLanResolverForTests(fn: typeof resolver): void {
  resolver = fn
}

/**
 * Greift die Umschreibung *.<basis> → LAN-IP im lokalen DNS? Gefragt wird
 * der Resolver des Servers (meist der Router oder AdGuard/Pi-hole) mit einem
 * Namen, den es sonst nicht gibt.
 */
export async function checkLanDns(key: string): Promise<LanDnsCheckDto> {
  const env = resolveEnv(key)
  const base = hostSettingsFor(env.id).baseDomain
  const lan = net.lanIp()
  const line = base && lan ? `*.${base} → ${lan}` : null
  if (!base) return { baseDomain: null, line: null, expected: lan, resolved: [], ok: false, detail: 'Noch keine interne Basis gewählt.' }
  if (!lan) return { baseDomain: base, line, expected: null, resolved: [], ok: false, detail: 'Die LAN-IP des Servers ist nicht bekannt.' }
  let resolved: string[] = []
  try {
    resolved = await resolver(`airlock-dns-pruefung.${base}`)
  } catch (err) {
    const code = (err as { code?: string }).code
    return { baseDomain: base, line, expected: lan, resolved: [], ok: false, detail: code === 'ENOTFOUND' || code === 'ENODATA' ? 'Der lokale DNS kennt den Namen nicht – die Umschreibung fehlt.' : `Keine Antwort vom DNS (${code ?? (err as Error).message}).` }
  }
  const ok = resolved.includes(lan)
  const tailscale = net.tailscaleIp()
  const detail = ok
    ? `Umschreibung greift: ${base} → ${lan}`
    : tailscale && resolved.includes(tailscale)
      ? `Der Name löst auf die Tailnet-IP auf (Eintrag bei Cloudflare), nicht auf die LAN-IP – im LAN fehlt die Umschreibung.`
      : `Der Name löst auf ${resolved.join(', ')} auf, erwartet ${lan}.`
  return { baseDomain: base, line, expected: lan, resolved, ok, detail }
}

/** Standard-Umgebung (für Adressen ohne /u/…) */
export const defaultEnvSlug = (): string => defaultEnvironment().slug
