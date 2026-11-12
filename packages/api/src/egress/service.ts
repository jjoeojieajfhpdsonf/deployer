import { createHash } from 'node:crypto'
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm'
import {
  EGRESS_MAX_EXCEPTIONS, egressExceptionInputSchema, egressSettingsSchema, egressTargetKind,
  type EgressAttemptDto, type EgressExceptionDto, type EgressMode, type EgressServerDto, type EgressVerdict, type ProjectEgressDto,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config, net } from '../config.js'
import * as docker from '../drivers/docker.js'
import { audit } from '../domain/audit.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { BRIDGE_RE, EGRESS_RENDER_DEFAULTS, normalizeCidr, renderEgressRules, type EgressAllowRule, type EgressNetworkRules } from './rules.js'
import { aggregateEgressEvents, inCidr4, parseEgressLine, type EgressAttemptRow } from './events.js'
import { applyStateOf, parseStatusFile, serviceOf, type FirewallStatusFile } from './status.js'

/**
 * Nacht 3, Etappe 4: Ausgang der Projekt-Container.
 *
 * Airlock entscheidet, was gelten soll (Modus, Durchsetzen, Ausnahmen je
 * Projekt), erzeugt daraus die Regeln (rules.ts, rein) und legt sie als
 * rules.nft in den Ordner, den es mit dem Firewall-Dienst teilt
 * (FIREWALL_DIR, Volume airlock_firewall). Der Dienst (firewall/airlock-fw)
 * prüft und setzt sie; er meldet seinen Zustand in status.json und schreibt
 * protokollierte Pakete nach events.log. Airlock holt die ab, ordnet sie über
 * die Quelladresse einem Projekt zu und zählt sie je Stunde (egress_attempts).
 *
 * Schnittstelle für Etappe 5 (Einbruchserkennung): listEgressAttempts() und
 * onEgressAttempts() – die gesperrten Versuche, gebündelt.
 */

const RENDER = EGRESS_RENDER_DEFAULTS
const RULES_FILE = 'rules.nft'
const STATUS_FILE = 'status.json'
const EVENTS_FILE = 'events.log'
/** Versuche so lange aufbewahren */
const KEEP_DAYS = 30
/** Hostnamen der Ausnahmen so lange gemerkt */
const DNS_TTL_MS = 5 * 60_000

const dir = () => config.FIREWALL_DIR
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const slugOfNetwork = (name: string) => name.replace(/^(air|dep)_/, '')

async function dirReady(): Promise<boolean> {
  return stat(dir()).then((s) => s.isDirectory(), () => false)
}

/* --- Projekte, Netze, Ausnahmen → Regeln ------------------------------------------------ */

type ProjectRow = { id: string; slug: string; name: string; egressMode: EgressMode; egressEnforce: boolean; previewOf: string | null }
type ExceptionRow = typeof schema.egressExceptions.$inferSelect

const dnsCache = new Map<string, { at: number; addrs: string[] | null }>()

/** Hostname einer Ausnahme auflösen (3 s Zeitlimit, 5 Min. gemerkt); null = nicht auflösbar */
async function resolveHost(host: string): Promise<string[] | null> {
  const hit = dnsCache.get(host)
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.addrs
  const addrs = await Promise.race([
    lookup(host, { all: true, verbatim: true }).then((r) => r.map((a) => a.address)),
    new Promise<null>((r) => setTimeout(() => r(null), 3000).unref()),
  ]).catch(() => null)
  const clean = addrs ? [...new Set(addrs.filter((a) => egressTargetKind(a)?.kind === 'ip'))].slice(0, 16) : null
  dnsCache.set(host, { at: Date.now(), addrs: clean && clean.length ? clean : null })
  return clean && clean.length ? clean : null
}

async function allowRules(rows: ExceptionRow[]): Promise<EgressAllowRule[]> {
  const out: EgressAllowRule[] = []
  for (const r of rows) {
    const k = egressTargetKind(r.target)
    if (!k) continue
    const addrs = k.kind === 'host' ? (await resolveHost(r.target.toLowerCase())) ?? [] : [r.target]
    for (const a of addrs) {
      const fam = (egressTargetKind(a)?.family ?? null) as 4 | 6 | null
      if (!fam) continue
      out.push({ address: normalizeCidr(a, fam), family: fam, port: r.port, protocol: r.protocol })
    }
  }
  return out
}

interface Snapshot {
  /** Projekt (bei Vorschauen das Projekt, aus dem sie stammen) → seine Netze */
  networksOf: Map<string, docker.BridgeNetwork[]>
  /** Projekte, deren Netz übersprungen wurde (eigener Bridge-Name) */
  skipped: Map<string, string>
  /** Subnetz → Projekt, für die Zuordnung der Protokollzeilen */
  owners: { cidr: string; projectId: string }[]
}
let snapshot: Snapshot | null = null
/** SHA-256 der zuletzt geschriebenen (bzw. vorgefundenen) rules.nft */
let desiredSha: string | null = null

export async function buildEgressPlan(): Promise<Snapshot & { networks: EgressNetworkRules[] }> {
  const projects: ProjectRow[] = await db.select({
    id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name,
    egressMode: schema.projects.egressMode, egressEnforce: schema.projects.egressEnforce, previewOf: schema.projects.previewOf,
  }).from(schema.projects)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const bySlug = new Map(projects.map((p) => [p.slug, p]))
  const exceptions = await db.select().from(schema.egressExceptions).orderBy(asc(schema.egressExceptions.createdAt))
  const nets = await docker.listBridgeNetworks(['air_', 'dep_'])

  const networks: EgressNetworkRules[] = []
  const networksOf = new Map<string, docker.BridgeNetwork[]>()
  const skipped = new Map<string, string>()
  const owners: Snapshot['owners'] = []
  const allowCache = new Map<string, EgressAllowRule[]>()
  for (const n of nets) {
    const p = bySlug.get(slugOfNetwork(n.name))
    if (!p) continue // z. B. air_ext-scan (Scans externer Ziele) – kein Projekt
    // Vorschauen folgen ihrem Projekt (Einstellungen, Zuordnung der Versuche)
    const owner = (p.previewOf && byId.get(p.previewOf)) || p
    networksOf.set(owner.id, [...(networksOf.get(owner.id) ?? []), n])
    for (const cidr of n.subnets) owners.push({ cidr, projectId: owner.id })
    if (owner.egressMode === 'frei') continue
    if (!BRIDGE_RE.test(n.bridge)) {
      skipped.set(owner.id, `Netz ${n.name} hat einen eigenen Bridge-Namen (${n.bridge}) – dafür setzt Airlock keine Regeln.`)
      continue
    }
    let allow = allowCache.get(owner.id)
    if (!allow) {
      allow = await allowRules(exceptions.filter((e) => e.projectId === owner.id))
      allowCache.set(owner.id, allow)
    }
    networks.push({ network: n.name, bridge: n.bridge, mode: owner.egressMode, enforce: owner.egressEnforce, allow })
  }
  return { networks, networksOf, skipped, owners }
}

/* --- Schreiben und Abgleich ------------------------------------------------------------- */

let chain: Promise<unknown> = Promise.resolve()
/** Nacheinander, nie zwei Schreibvorgänge zugleich */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

/**
 * Gewünschten Stand neu erzeugen und schreiben, wenn er sich geändert hat
 * (tmp + rename: der Dienst sieht nie eine halbe Datei). Ohne Ordner
 * (Dienst nicht installiert) wird nichts geschrieben.
 */
export function syncEgress(reason: string): Promise<{ sha: string | null; written: boolean }> {
  return serial(async () => {
    const plan = await buildEgressPlan()
    snapshot = { networksOf: plan.networksOf, skipped: plan.skipped, owners: plan.owners }
    if (!(await dirReady())) return { sha: null, written: false }
    const text = renderEgressRules(plan.networks, RENDER)
    const sha = sha256(text)
    const file = join(dir(), RULES_FILE)
    const current = await readFile(file, 'utf8').catch(() => null)
    desiredSha = sha
    if (current === text) return { sha, written: false }
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, text, { mode: 0o644 })
    await rename(tmp, file)
    log.info('Ausgangsregeln geschrieben', { grund: reason, netze: plan.networks.length, stand: sha.slice(0, 12) })
    return { sha, written: true }
  })
}

async function readStatus(): Promise<FirewallStatusFile | null> {
  return parseStatusFile(await readFile(join(dir(), STATUS_FILE), 'utf8').catch(() => null))
}

/** Warten, bis der Dienst den Stand bestätigt (höchstens timeoutMs); false bei Zeitablauf */
async function waitApplied(sha: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const s = await readStatus()
    if (s?.applied?.sha256 === sha) return true
    if (s && s.lastSha256 === sha && s.state === 'error') return false
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * Neues Projekt-Netz: Regeln schreiben und kurz warten, bis sie im Kernel
 * stehen – bevor der erste Container (Build, Dienst) darin startet. Läuft
 * der Dienst nicht, wird nicht gewartet (nichts hält den Deploy auf).
 */
async function onNetworkCreated(name: string): Promise<void> {
  if (!/^(air|dep)_/.test(name)) return
  const r = await syncEgress(`Netz ${name} angelegt`)
  if (!r.sha) return
  const service = serviceOf(await readStatus(), new Date())
  if (service.state !== 'laeuft') return
  const ok = await waitApplied(r.sha, 5000)
  if (!ok) log.warn('Ausgangsregeln für neues Netz nicht rechtzeitig bestätigt', { netz: name })
}

/* --- Protokoll abholen ------------------------------------------------------------------ */

type AttemptListener = (rows: EgressAttemptRow[]) => void
const listeners = new Set<AttemptListener>()

/**
 * Etappe 5: neu gezählte Versuche (gebündelt je Projekt, Ziel, Port, Stunde),
 * nach jedem Abholen. Gibt die Abmeldung zurück.
 */
export function onEgressAttempts(fn: AttemptListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function serverAddresses(): Set<string> {
  const s = new Set<string>()
  for (const ip of [net.lanIp(), net.tailscaleIp()]) if (ip) s.add(ip)
  for (const nets of snapshot?.networksOf.values() ?? []) for (const n of nets) for (const g of n.gateways) s.add(g)
  return s
}

/** events.log abholen (umbenennen, lesen, löschen), zählen, speichern. Gibt die Zahl der Zeilen zurück. */
export async function ingestEgressEvents(): Promise<number> {
  if (!(await dirReady())) return 0
  const names = await readdir(dir()).catch(() => [] as string[])
  const files: string[] = names.filter((n) => /^events\.\d+\.airlock$/.test(n)).map((n) => join(dir(), n))
  if (names.includes(EVENTS_FILE)) {
    const moved = join(dir(), `events.${Date.now()}.airlock`)
    if (await rename(join(dir(), EVENTS_FILE), moved).then(() => true, () => false)) {
      // Eine Zeile, die gerade noch angehängt wird, landet in der umbenannten Datei
      await new Promise((r) => setTimeout(r, 200))
      files.push(moved)
    }
  }
  if (!files.length) return 0
  let lines: string[] = []
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => '')
    await unlink(f).catch(() => {})
    lines = lines.concat(text.split('\n'))
  }
  const events = lines.map((l) => parseEgressLine(l, { observe: RENDER.observeGroup, block: RENDER.blockGroup })).filter((e) => e !== null)
  if (!events.length) return 0
  if (!snapshot) await syncEgress('Protokoll')
  const owners = snapshot?.owners ?? []
  const server = serverAddresses()
  const rows = aggregateEgressEvents(
    events,
    (src) => owners.find((o) => inCidr4(src, o.cidr))?.projectId ?? null,
    (dst) => server.has(dst),
  )
  await storeAttempts(rows)
  for (const fn of listeners) {
    try { fn(rows) } catch (err) { log.warn('Empfänger der Ausgangs-Versuche gescheitert', { err: String(err) }) }
  }
  return events.length
}

async function storeAttempts(rows: EgressAttemptRow[]): Promise<void> {
  if (!rows.length) return
  const t = schema.egressAttempts
  const known = new Set((await db.select({ id: schema.projects.id }).from(schema.projects)).map((r) => r.id))
  const keep = rows.filter((r) => known.has(r.projectId))
  for (let i = 0; i < keep.length; i += 200) {
    await db.insert(t).values(keep.slice(i, i + 200)).onConflictDoUpdate({
      target: [t.projectId, t.verdict, t.protocol, t.destination, t.port, t.bucket],
      set: {
        count: sql`${t.count} + excluded.count`,
        lastSeen: sql`greatest(${t.lastSeen}, excluded.last_seen)`,
        firstSeen: sql`least(${t.firstSeen}, excluded.first_seen)`,
        toServer: sql`${t.toServer} or excluded.to_server`,
      },
    })
  }
}

/**
 * Etappe 5: Versuche seit einem Zeitpunkt, je Stunde gebündelt (neueste
 * zuerst). verdict «gesperrt» = im Durchsetzen abgewiesen; «beobachtet» =
 * wäre gesperrt worden.
 */
export async function listEgressAttempts(o: { since: Date; verdict?: EgressVerdict; projectId?: string; limit?: number }): Promise<EgressAttemptRow[]> {
  const t = schema.egressAttempts
  const conds = [gte(t.lastSeen, o.since)]
  if (o.verdict) conds.push(eq(t.verdict, o.verdict))
  if (o.projectId) conds.push(eq(t.projectId, o.projectId))
  const rows = await db.select().from(t).where(and(...conds)).orderBy(desc(t.lastSeen)).limit(o.limit ?? 1000)
  return rows.map((r) => ({ ...r, verdict: r.verdict }))
}

async function pruneAttempts(): Promise<void> {
  await db.delete(schema.egressAttempts).where(lt(schema.egressAttempts.lastSeen, new Date(Date.now() - KEEP_DAYS * 86_400_000)))
}

/* --- Lesen für Oberfläche ---------------------------------------------------------------- */

async function exceptionDtos(projectId: string): Promise<EgressExceptionDto[]> {
  const rows = await db.select().from(schema.egressExceptions).where(eq(schema.egressExceptions.projectId, projectId)).orderBy(asc(schema.egressExceptions.createdAt))
  const out: EgressExceptionDto[] = []
  for (const r of rows) {
    const k = egressTargetKind(r.target)
    out.push({
      id: r.id, target: r.target, port: r.port, protocol: r.protocol, note: r.note,
      resolved: k?.kind === 'host' ? await resolveHost(r.target.toLowerCase()) : [],
      createdAt: r.createdAt.toISOString(),
    })
  }
  return out
}

async function attemptDtos(projectId: string): Promise<EgressAttemptDto[]> {
  const t = schema.egressAttempts
  const since = new Date(Date.now() - 7 * 86_400_000)
  const rows = await db.select({
    verdict: t.verdict, protocol: t.protocol, destination: t.destination, port: t.port,
    count: sql<number>`sum(${t.count})::int`,
    firstSeen: sql<Date>`min(${t.firstSeen})`,
    lastSeen: sql<Date>`max(${t.lastSeen})`,
    toServer: sql<boolean>`bool_or(${t.toServer})`,
  }).from(t)
    .where(and(eq(t.projectId, projectId), gte(t.lastSeen, since)))
    .groupBy(t.verdict, t.protocol, t.destination, t.port)
    .orderBy(desc(sql`max(${t.lastSeen})`))
    .limit(20)
  return rows.map((r) => ({
    verdict: r.verdict,
    protocol: (['tcp', 'udp', 'icmp'].includes(r.protocol) ? r.protocol : 'andere') as EgressAttemptDto['protocol'],
    destination: r.destination,
    port: r.port === 0 ? null : r.port,
    toServer: Boolean(r.toServer),
    count: Number(r.count),
    firstSeen: new Date(r.firstSeen).toISOString(),
    lastSeen: new Date(r.lastSeen).toISOString(),
  }))
}

type Project = typeof schema.projects.$inferSelect

async function ownerOf(p: Project): Promise<Project> {
  if (!p.previewOf) return p
  return (await db.select().from(schema.projects).where(eq(schema.projects.id, p.previewOf)).limit(1))[0] ?? p
}

export async function projectEgressDto(p: Project): Promise<ProjectEgressDto> {
  const owner = await ownerOf(p)
  const status = await readStatus()
  const service = serviceOf(status, new Date())
  // Netze frisch nachsehen (ein Aufruf), Stand der Regeln aus der Datei
  const nets = await docker.listBridgeNetworks(['air_', 'dep_']).catch(() => [] as docker.BridgeNetwork[])
  const hasNetwork = nets.some((n) => slugOfNetwork(n.name) === p.slug)
  if (desiredSha === null && (await dirReady())) {
    const text = await readFile(join(dir(), RULES_FILE), 'utf8').catch(() => null)
    if (text !== null) desiredSha = sha256(text)
  }
  return {
    mode: owner.egressMode,
    enforce: owner.egressEnforce,
    exceptions: await exceptionDtos(owner.id),
    attempts: await attemptDtos(owner.id),
    apply: applyStateOf({ mode: owner.egressMode, hasNetwork, skipped: snapshot?.skipped.get(owner.id) ?? null, service, status, desiredSha }),
    inheritedFrom: owner.id !== p.id ? { id: owner.id, name: owner.name } : null,
  }
}

export async function egressServerDto(): Promise<EgressServerDto> {
  const service = serviceOf(await readStatus(), new Date())
  const rows = await db.select({ mode: schema.projects.egressMode, enforce: schema.projects.egressEnforce })
    .from(schema.projects).where(isNull(schema.projects.previewOf))
  const t = schema.egressAttempts
  const since = new Date(Date.now() - 86_400_000)
  const sums = await db.select({ verdict: t.verdict, n: sql<number>`coalesce(sum(${t.count}), 0)::int` }).from(t).where(gte(t.lastSeen, since)).groupBy(t.verdict)
  const limited = rows.filter((r) => r.mode !== 'frei')
  return {
    service,
    projects: {
      total: rows.length,
      observe: limited.filter((r) => !r.enforce).length,
      enforce: limited.filter((r) => r.enforce).length,
      frei: rows.filter((r) => r.mode === 'frei').length,
      abgeschottet: rows.filter((r) => r.mode === 'abgeschottet').length,
    },
    last24h: {
      beobachtet: Number(sums.find((s) => s.verdict === 'beobachtet')?.n ?? 0),
      gesperrt: Number(sums.find((s) => s.verdict === 'gesperrt')?.n ?? 0),
    },
  }
}

/* --- Ändern ------------------------------------------------------------------------------ */

function assertNotPreview(p: Project): void {
  if (p.previewOf) throw badRequest('Eine Vorschau folgt den Ausgangsregeln ihres Projekts')
}

/**
 * Modus bzw. Durchsetzen ändern. «frei» verlangt die erneute Bestätigung:
 * requireSudo prüft sie (für Anmeldungen; Tokens kommen hier gar nicht hin).
 */
export async function setEgressSettings(p: Project, body: unknown, actor: string, requireSudo: () => void): Promise<ProjectEgressDto> {
  assertNotPreview(p)
  const input = egressSettingsSchema.parse(body ?? {})
  if (input.mode === 'frei' && p.egressMode !== 'frei') requireSudo()
  const next = { egressMode: input.mode ?? p.egressMode, egressEnforce: input.enforce ?? p.egressEnforce }
  const [updated] = await db.update(schema.projects).set(next).where(eq(schema.projects.id, p.id)).returning()
  await audit({
    actor, action: 'project.egress.update', targetType: 'project', targetId: p.id,
    params: { mode: next.egressMode, enforce: next.egressEnforce, before: { mode: p.egressMode, enforce: p.egressEnforce } }, result: 'ok',
  })
  await syncEgress('Einstellung').catch((err) => log.warn('Ausgangsregeln nicht geschrieben', { err: String(err) }))
  return projectEgressDto(updated!)
}

export async function addEgressException(p: Project, body: unknown, actor: string): Promise<ProjectEgressDto> {
  assertNotPreview(p)
  const input = egressExceptionInputSchema.parse(body ?? {})
  const target = input.target.trim().toLowerCase()
  const count = await db.select({ n: sql<number>`count(*)::int` }).from(schema.egressExceptions).where(eq(schema.egressExceptions.projectId, p.id))
  if (Number(count[0]?.n ?? 0) >= EGRESS_MAX_EXCEPTIONS) throw new AppError('conflict', `Höchstens ${EGRESS_MAX_EXCEPTIONS} Ausnahmen je Projekt`, 409)
  const dup = await db.select({ id: schema.egressExceptions.id }).from(schema.egressExceptions).where(and(
    eq(schema.egressExceptions.projectId, p.id), eq(schema.egressExceptions.target, target),
    input.port === null ? isNull(schema.egressExceptions.port) : eq(schema.egressExceptions.port, input.port),
    eq(schema.egressExceptions.protocol, input.protocol),
  )).limit(1)
  if (dup.length) throw new AppError('conflict', 'Diese Ausnahme gibt es schon', 409)
  const [row] = await db.insert(schema.egressExceptions).values({ projectId: p.id, target, port: input.port, protocol: input.protocol, note: input.note || null }).returning()
  await audit({ actor, action: 'project.egress.exception.add', targetType: 'project', targetId: p.id, params: { target, port: input.port, protocol: input.protocol }, result: 'ok' })
  if (egressTargetKind(target)?.kind === 'host' && (await resolveHost(target)) === null) {
    log.warn('Ausnahme: Hostname nicht auflösbar', { project: p.slug, target, id: row!.id })
  }
  await syncEgress('Ausnahme').catch((err) => log.warn('Ausgangsregeln nicht geschrieben', { err: String(err) }))
  return projectEgressDto(p)
}

export async function removeEgressException(p: Project, exceptionId: string, actor: string): Promise<ProjectEgressDto> {
  assertNotPreview(p)
  const [row] = await db.delete(schema.egressExceptions)
    .where(and(eq(schema.egressExceptions.id, exceptionId), eq(schema.egressExceptions.projectId, p.id))).returning()
  if (!row) throw notFound('Ausnahme')
  await audit({ actor, action: 'project.egress.exception.remove', targetType: 'project', targetId: p.id, params: { target: row.target, port: row.port, protocol: row.protocol }, result: 'ok' })
  await syncEgress('Ausnahme').catch((err) => log.warn('Ausgangsregeln nicht geschrieben', { err: String(err) }))
  return projectEgressDto(p)
}

/** Alle beobachteten Projekte (nicht «frei») auf Durchsetzen; gibt die Zahl zurück */
export async function enforceAll(actor: string): Promise<number> {
  const rows = await db.update(schema.projects).set({ egressEnforce: true })
    .where(and(isNull(schema.projects.previewOf), ne(schema.projects.egressMode, 'frei'), eq(schema.projects.egressEnforce, false)))
    .returning({ id: schema.projects.id, slug: schema.projects.slug })
  await audit({ actor, action: 'egress.enforce_all', targetType: null, targetId: null, environmentId: null, params: { projects: rows.map((r) => r.slug) }, result: 'ok' })
  await syncEgress('Alle durchsetzen').catch((err) => log.warn('Ausgangsregeln nicht geschrieben', { err: String(err) }))
  return rows.length
}

/* --- Jobs -------------------------------------------------------------------------------- */

export function startEgressJobs(): NodeJS.Timeout[] {
  docker.onNetworkCreated(onNetworkCreated)
  const sync = () => syncEgress('Abgleich').catch((err) => log.warn('Ausgangsregeln nicht abgeglichen', { err: String(err) }))
  const ingest = () => ingestEgressEvents().catch((err) => log.warn('Protokoll des Firewall-Dienstes nicht gelesen', { err: String(err) }))
  void sync()
  // Jede Minute: Netze kommen und gehen (Deploy, Löschen, Vorschauen), Hostnamen ändern ihre IP
  const a = setInterval(sync, 60_000)
  const b = setInterval(ingest, 15_000)
  const c = setInterval(() => void pruneAttempts().catch(() => {}), 60 * 60_000)
  for (const t of [a, b, c]) t.unref()
  return [a, b, c]
}
