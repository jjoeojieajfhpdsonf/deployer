import { and, eq, isNull } from 'drizzle-orm'
import { Agent, request } from 'undici'
import {
  HOST_GATEWAY_NAME, checkExternalAddress, chooseNetwork, detectAdminUi, externalLabel,
  type ExternalContainerDto, type ExternalInfoDto, type ExternalProbeDto, type ExternalResolved, type ExternalSource, type ProjectHealthDto,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { listForeignContainers } from '../drivers/foreign.js'
import { containerUpstream, isAirlockOwn, offerable, refind, type ForeignContainer, type TakenTarget } from '../lib/external.js'
import { withProjectNetwork } from '../deploy/attach.js'
import { badRequest, conflict } from '../lib/errors.js'
import { probeUa } from '../lib/probe-ua.js'
import { publish } from '../lib/events.js'
import { log } from '../lib/log.js'

/**
 * Bestehender Dienst: etwas, das schon läuft und nicht von Airlock deployt
 * wurde, über Airlock erreichbar machen – ohne es zu verwalten. Hier: Liste
 * der Container, Vorbereitung beim Anlegen, Erreichbarkeit, Ziel für Caddy
 * und das Wiederfinden nach Löschen/Neuerstellen. Airlock liest fremde
 * Container nur (drivers/foreign.ts); es setzt dort nichts.
 */

type Row = typeof schema.projects.$inferSelect

export const isExternal = (p: { sourceType: string }): boolean => p.sourceType === 'external'
export const sourceOf = (p: { sourceConfig: unknown }): ExternalSource => p.sourceConfig as ExternalSource
export const resolvedOf = (s: ExternalSource): ExternalResolved => (s.resolved ?? {}) as ExternalResolved

/* --- Liste ------------------------------------------------------------------- */

/** Container, auf die schon ein Projekt zeigt (serverweit – ein Container, eine Route) */
async function takenTargets(exceptProjectId?: string): Promise<TakenTarget[]> {
  const rows = await db.select({ id: schema.projects.id, name: schema.projects.name, sourceConfig: schema.projects.sourceConfig })
    .from(schema.projects).where(and(eq(schema.projects.sourceType, 'external'), isNull(schema.projects.previewOf)))
  return rows
    .filter((r) => r.id !== exceptProjectId)
    .map((r) => ({ r, s: sourceOf(r) }))
    .filter(({ s }) => s.container)
    .map(({ r, s }) => ({ projectName: r.name, container: s.container!, composeProject: resolvedOf(s).composeProject ?? null, composeService: resolvedOf(s).composeService ?? null }))
}

export async function externalContainers(): Promise<ExternalContainerDto[]> {
  return offerable(await listForeignContainers(), await takenTargets())
}

/* --- Anlegen ----------------------------------------------------------------- */

/**
 * Prüft die Quelle gegen den Server und füllt `resolved`. Container: muss
 * laufen, darf nicht Airlocks eigener sein und noch keine Route haben, braucht
 * ein Netz für Caddy. Adresse: nur private Bereiche und Tailnet (shared).
 */
export async function prepareExternalSource(s: ExternalSource, opts: { exceptProjectId?: string } = {}): Promise<ExternalSource> {
  if (s.url) {
    const a = checkExternalAddress(s.url)
    if (!a.ok) throw badRequest(a.reason, { field: 'source.url' })
    return { type: 'external', url: a.url, insecureTls: s.insecureTls, resolved: { adminUi: (resolvedOf(s).adminUi ?? null) } }
  }
  const all = await listForeignContainers()
  const c = all.find((x) => x.name === s.container)
  if (!c) throw badRequest(`Auf diesem Server läuft kein Container «${s.container}»`, { field: 'source.container' })
  if (isAirlockOwn(c)) throw badRequest(`«${c.name}» gehört zu Airlock selbst bzw. wird schon von Airlock verwaltet`, { field: 'source.container' })
  if (!c.running) throw badRequest(`«${c.name}» läuft gerade nicht – erst starten, dann anlegen`, { field: 'source.container' })
  const taken = (await takenTargets(opts.exceptProjectId)).find((t) => t.container === c.name
    || (t.composeProject && t.composeProject === c.composeProject && t.composeService === c.composeService))
  if (taken) throw conflict(`«${c.name}» ist schon über Airlock erreichbar: Projekt «${taken.projectName}»`)
  const choice = chooseNetwork(c)
  if (choice.mode === 'none') throw badRequest(choice.reason, { field: 'source.container' })
  return { type: 'external', container: c.name, port: s.port, insecureTls: false, resolved: resolvedFor(c) }
}

function resolvedFor(c: ForeignContainer): ExternalResolved {
  const choice = chooseNetwork(c)
  return {
    containerId: c.id,
    image: c.image,
    composeProject: c.composeProject,
    composeService: c.composeService,
    network: choice.mode === 'network' ? choice.network : null,
    hostMode: choice.mode === 'host',
    dialHost: choice.mode === 'none' ? null : choice.dialHost,
    adminUi: detectAdminUi({ image: c.image }),
  } as ExternalResolved
}

/* --- Ziel für Caddy -------------------------------------------------------------- */

export interface ExternalUpstream {
  /** «host:port» für reverse_proxy */
  dial: string
  /** HTTPS zum Ziel (Adresse mit https://); insecure: eigenes Zertifikat erlaubt */
  tls: { insecure: boolean } | null
  /** Netz, in das Caddy für dieses Ziel muss; null bei Adressen und network_mode host */
  network: string | null
}

/** null: Ziel fehlt (Container nicht wiedergefunden) – die Route zeigt dann die Pause-Seite */
export function externalUpstream(p: Pick<Row, 'sourceConfig' | 'externalMissingSince'>): ExternalUpstream | null {
  const s = sourceOf(p)
  if (s.url) {
    const a = checkExternalAddress(s.url)
    if (!a.ok) return null
    return { dial: a.dial, tls: a.scheme === 'https' ? { insecure: s.insecureTls } : null, network: null }
  }
  if (p.externalMissingSince || !s.container || !s.port) return null
  const r = resolvedOf(s) as ExternalResolved & { dialHost?: string | null }
  if (r.hostMode) return { dial: `${HOST_GATEWAY_NAME}:${s.port}`, tls: null, network: null }
  const host = r.dialHost ?? s.container
  return { dial: `${host}:${s.port}`, tls: null, network: r.network ?? null }
}

/* --- Erreichbarkeit -------------------------------------------------------------- */

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })
const TITLE_RE = /<title[^>]*>([^<]{1,200})<\/title>/i

async function fetchOnce(url: string, insecure: boolean): Promise<{ status: number; title: string | null; ms: number }> {
  const started = Date.now()
  const res = await request(url, {
    method: 'GET',
    headers: { 'user-agent': probeUa('bestehender-dienst'), accept: 'text/html,*/*' },
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    ...(insecure ? { dispatcher: insecureAgent } : {}),
  })
  // Höchstens 64 KB lesen – für den Titel reicht der Anfang
  let body = ''
  for await (const chunk of res.body) {
    body += chunk.toString('utf8')
    if (body.length > 65_536) break
  }
  res.body.destroy()
  const t = TITLE_RE.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  return { status: res.statusCode, title: t ? t.slice(0, 120) : null, ms: Date.now() - started }
}

const TLS_ERR = /self[- ]signed|certificate|unable to verify|DEPTH_ZERO|UNABLE_TO_GET_ISSUER|ERR_TLS|CERT_/i

/** Antwortet das Ziel? Zählt jede HTTP-Antwort unter 500 (auch 401/403: der Dienst ist da). */
export function judge(status: number | null): boolean {
  return status !== null && status < 500
}

async function probeUrl(url: string, opts: { insecure: boolean; allowRetryInsecure: boolean }, via: string | null, image: string | null): Promise<ExternalProbeDto> {
  try {
    const r = await fetchOnce(url, opts.insecure)
    const ok = judge(r.status)
    return {
      ok, status: r.status, ms: r.ms, title: r.title, selfSigned: opts.insecure && url.startsWith('https:'),
      detail: ok ? `Antwortet mit HTTP ${r.status}${r.title ? ` («${r.title}»)` : ''}.` : `Antwortet, aber mit HTTP ${r.status} – ein Fehler im Dienst.`,
      adminUi: detectAdminUi({ image, title: r.title }), via,
    }
  } catch (err) {
    const msg = (err as Error & { code?: string }).code ?? (err as Error).message
    if (url.startsWith('https:') && TLS_ERR.test(String(msg)) && opts.allowRetryInsecure) {
      // Eigenes Zertifikat: zur Auskunft ohne Prüfung nachsehen, ob der Dienst da ist
      const again = await probeUrl(url, { insecure: true, allowRetryInsecure: false }, via, image)
      return {
        ...again, ok: false, selfSigned: true,
        detail: again.status !== null
          ? 'Der Dienst antwortet über HTTPS mit einem eigenen (selbstsignierten) Zertifikat. Mit «Eigenes Zertifikat erlauben» nimmt Airlock es an.'
          : again.detail,
      }
    }
    return { ok: false, status: null, ms: null, title: null, selfSigned: false, detail: explainNetError(String(msg)), adminUi: detectAdminUi({ image }), via }
  }
}

function explainNetError(m: string): string {
  if (/ECONNREFUSED/.test(m)) return 'Verbindung abgelehnt – an dieser Adresse lauscht nichts auf dem Port.'
  if (/ETIMEDOUT|Timeout|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(m)) return 'Keine Antwort innerhalb von 5 Sekunden – Adresse, Port oder Firewall prüfen.'
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'Die Adresse ist vom Server aus nicht erreichbar (kein Weg ins Netz).'
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Der Name lässt sich nicht auflösen.'
  if (/ECONNRESET|socket hang up|UND_ERR_SOCKET/.test(m)) return 'Die Verbindung wurde abgebrochen – spricht der Dienst auf diesem Port HTTP? Sonst https:// versuchen.'
  if (TLS_ERR.test(m)) return 'HTTPS-Zertifikat nicht gültig.'
  return `Keine Antwort: ${m}`
}

/**
 * Vor dem Anlegen und als Healthcheck: einmal GET auf das Ziel. Container:
 * Airlock hängt sich dafür kurz in das Netz (wie beim Healthcheck von
 * Projekten); im Host-Netz über host-gateway.
 */
export async function probeExternal(s: ExternalSource, path = '/'): Promise<ExternalProbeDto> {
  if (s.url) {
    const a = checkExternalAddress(s.url)
    if (!a.ok) return { ok: false, status: null, ms: null, title: null, detail: a.reason, selfSigned: false, adminUi: null, via: null }
    return probeUrl(`${a.url}${path}`, { insecure: s.insecureTls, allowRetryInsecure: !s.insecureTls }, a.range, null)
  }
  if (!s.container || !s.port) return { ok: false, status: null, ms: null, title: null, detail: 'Container und Port fehlen.', selfSigned: false, adminUi: null, via: null }
  const c = refind(await listForeignContainers(), { container: s.container, composeProject: resolvedOf(s).composeProject, composeService: resolvedOf(s).composeService })
  if (!c) return { ok: false, status: null, ms: null, title: null, detail: `Kein Container «${s.container}» auf diesem Server.`, selfSigned: false, adminUi: null, via: null }
  if (!c.running) return { ok: false, status: null, ms: null, title: null, detail: `«${c.name}» läuft nicht.`, selfSigned: false, adminUi: detectAdminUi({ image: c.image }), via: null }
  const { dial, choice } = containerUpstream(c, s.port)
  if (choice.mode === 'none') return { ok: false, status: null, ms: null, title: null, detail: choice.reason, selfSigned: false, adminUi: detectAdminUi({ image: c.image }), via: null }
  const url = `http://${dial}${path}`
  if (choice.mode === 'host') return probeUrl(url, { insecure: false, allowRetryInsecure: false }, 'Host-Netz (host-gateway)', c.image)
  return withProjectNetwork(choice.network, () => probeUrl(url, { insecure: false, allowRetryInsecure: false }, `Netz ${choice.network}`, c.image))
    .catch((err: Error) => ({ ok: false, status: null, ms: null, title: null, detail: `Netz ${choice.network} nicht erreichbar: ${err.message}`, selfSigned: false, adminUi: detectAdminUi({ image: c.image }), via: choice.network }))
}

/* --- Healthcheck ------------------------------------------------------------------- */

const health = new Map<string, { at: number; probe: ExternalProbeDto }>()
const HEALTH_FRESH_MS = 30_000

/**
 * Healthcheck eines bestehenden Dienstes = HTTP auf das Ziel (Pfad aus den
 * Einstellungen). null, wenn das Projekt kein bestehender Dienst ist.
 */
export async function externalHealth(projectId: string, opts: { fresh?: boolean } = {}): Promise<ProjectHealthDto | null> {
  const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]
  if (!p || !isExternal(p)) return null
  const s = sourceOf(p)
  let h = health.get(projectId)
  if (!h || (opts.fresh && Date.now() - h.at > HEALTH_FRESH_MS) || Date.now() - h.at > 5 * 60_000) {
    const probe = p.externalMissingSince
      ? { ok: false, status: null, ms: null, title: null, detail: `${externalLabel(s)} wurde nicht gefunden.`, selfSigned: false, adminUi: null, via: null }
      : await probeExternal(s, p.healthcheckPath || '/')
    h = { at: Date.now(), probe }
    health.set(projectId, h)
  }
  const snap = seen.get(projectId)
  return {
    kind: 'external',
    container: s.container
      ? (p.externalMissingSince ? { running: false, missing: true, startedAt: null, exitCode: null } : snap ? { running: snap.running, startedAt: null, exitCode: null } : null)
      : null,
    health: {
      at: new Date(h.at).toISOString(), ok: h.probe.ok, status: h.probe.status,
      error: h.probe.ok ? null : h.probe.detail, ms: h.probe.ms ?? 0, url: p.healthcheckPath || '/', port: s.port ?? null,
    },
    samples: [],
  }
}

/* --- Zustand und Wiederfinden ----------------------------------------------------- */

/** Letzter Blick auf die Container-Ziele (Monitor-Runde); toDto liest ihn ohne Docker-Aufruf */
const seen = new Map<string, { found: boolean; running: boolean }>()
export function externalSnapshot(projectId: string): { found: boolean; running: boolean } | null {
  return seen.get(projectId) ?? null
}

export function externalInfo(p: Pick<Row, 'id' | 'sourceType' | 'sourceConfig' | 'externalMissingSince'>): ExternalInfoDto | null {
  if (!isExternal(p)) return null
  const s = sourceOf(p)
  const r = resolvedOf(s)
  const snap = seen.get(p.id)
  return {
    mode: s.container ? 'container' : 'address',
    label: externalLabel(s),
    container: s.container ?? null,
    port: s.port ?? null,
    url: s.url ?? null,
    insecureTls: Boolean(s.insecureTls),
    image: r.image ?? null,
    composeProject: r.composeProject ?? null,
    composeService: r.composeService ?? null,
    network: s.container ? (r.hostMode ? 'host' : r.network ?? null) : null,
    found: s.container ? (p.externalMissingSince ? false : snap ? snap.found : null) : null,
  }
}

/**
 * Eine Runde: alle Container-Ziele wiederfinden (Name, sonst Compose-Projekt
 * und -Dienst). Ändert sich Name, ID, Netz oder IP, wird `resolved`
 * nachgeführt; fehlt das Ziel, bekommt das Projekt «Ziel fehlt» (Route bleibt,
 * Pause-Seite). Liefert true, wenn Caddy neu geladen werden muss.
 */
export async function refreshExternalTargets(now = new Date()): Promise<boolean> {
  const rows = (await db.select().from(schema.projects).where(eq(schema.projects.sourceType, 'external')))
    .filter((p) => sourceOf(p).container)
  if (!rows.length) return false
  const list = await listForeignContainers()
  let changed = false
  for (const p of rows) {
    const s = sourceOf(p)
    const r = resolvedOf(s)
    const c = refind(list.filter((x) => !isAirlockOwn(x)), { container: s.container!, composeProject: r.composeProject, composeService: r.composeService })
    const prev = seen.get(p.id)
    seen.set(p.id, { found: Boolean(c), running: Boolean(c?.running) })
    if (!prev || prev.found !== Boolean(c) || prev.running !== Boolean(c?.running)) publish({ type: 'project', projectId: p.id })
    if (!c) {
      if (!p.externalMissingSince) {
        await db.update(schema.projects).set({ externalMissingSince: now }).where(eq(schema.projects.id, p.id))
        log.warn('Bestehender Dienst: Ziel fehlt', { slug: p.slug, container: s.container })
        changed = true
      }
      continue
    }
    const next = resolvedFor(c) as ExternalResolved & { dialHost?: string | null }
    const before = r as ExternalResolved & { dialHost?: string | null }
    const moved = c.name !== s.container || next.network !== before.network || next.dialHost !== before.dialHost || next.hostMode !== before.hostMode || next.containerId !== before.containerId
    if (moved || p.externalMissingSince) {
      // adminUi bleibt, wenn sie über den Seitentitel erkannt wurde
      const merged = { ...next, adminUi: next.adminUi ?? before.adminUi ?? null }
      await db.update(schema.projects)
        .set({ sourceConfig: { ...s, container: c.name, resolved: merged }, externalMissingSince: null })
        .where(eq(schema.projects.id, p.id))
      if (p.externalMissingSince) log.info('Bestehender Dienst: Ziel wieder da', { slug: p.slug, container: c.name })
      else log.info('Bestehender Dienst: Ziel nachgeführt', { slug: p.slug, container: c.name, network: next.network })
      changed = true
    }
  }
  return changed
}
