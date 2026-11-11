import type { AuditEventDto } from '@airlock/shared'
import { addDays, dateOf, fmtTime, fmtWeekday, msOf, sameDay, spanMs } from './dates.js'

/** Zeitpunkt eines Ereignisses in ms; ungültig zählt als 0 (ganz alt), statt die Sortierung zu sprengen */
const at = (e: AuditEventDto): number => msOf(e.at) ?? 0

/**
 * Aktivität und Audit-Log: jedes Ereignis als deutscher Satz statt Code.
 *
 * Eine zentrale Tabelle (EVENTS) ordnet jedem Ereignistyp Titel, Unterzeile
 * und Kategorie zu; die Kategorie bestimmt Symbol und Farbe (nie nur Farbe:
 * jedes Symbol ist eigen, der Titel steht immer dabei). Unbekannte Typen
 * bekommen einen lesbaren Satz aus ihren Wortteilen, nie den rohen Schlüssel.
 *
 * Zusammengehöriges innerhalb kurzer Zeit wird gebündelt (bundle()):
 * Header gesetzt + Nachprüfung, Pausieren + Pause-Seite angepasst,
 * Code geändert + Deploy + Scan, Scan gestartet + Scan fertig; die
 * MCP-Werkzeugaufrufe neben ihrem eigentlichen Ereignis verschwinden.
 */

export type Category = 'deploy' | 'code' | 'header' | 'scan' | 'public' | 'paused' | 'config' | 'access' | 'claude' | 'danger' | 'error'

export interface Chip { text: string; tone: 'ok' | 'bad' | 'warn' | 'info' | 'neutral' }

export interface EventInfo {
  title: string
  /** Ergänzungen hinter dem Auslöser, mit «·» getrennt */
  sub: string[]
  category: Category
  chip?: Chip | null
}

type P = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const HEADER_NAME: Record<string, string> = {
  'strict-transport-security': 'Strict-Transport-Security',
  'content-security-policy': 'CSP',
  'frame-ancestors': 'X-Frame-Options',
  'x-frame-options': 'X-Frame-Options',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
}
export const headerShort = (h: unknown): string => HEADER_NAME[String(h ?? '').toLowerCase()] ?? String(h ?? 'Header')

/** «7 Min.», «40 s» */
function took(ms: number | null): string | null {
  if (ms === null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(1, s)} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`
}

const WAY: Record<string, string> = { lan: 'LAN', tailnet: 'Tailnet', public: 'Öffentlich' }

export function gradeChip(grade: unknown, score: unknown): Chip | null {
  const g = str(grade)
  const s = num(score)
  if (!g || s === null) return null
  return { text: `${g} · ${s}`, tone: g === 'A' ? 'ok' : g === 'B' ? 'info' : g === 'C' ? 'warn' : 'bad' }
}

export function deltaChip(before: unknown, after: unknown): Chip | null {
  const a = num(before)
  const b = num(after)
  if (a === null || b === null) return null
  return { text: `Note ${a} → ${b}`, tone: b > a ? 'ok' : b < a ? 'bad' : 'neutral' }
}

type Describe = (p: P, e: AuditEventDto) => Omit<EventInfo, 'sub'> & { sub?: (string | null | undefined)[] }

/** Die zentrale Tabelle: Ereignis → Titel, Unterzeile, Kategorie. */
const EVENTS: Record<string, Describe> = {
  // Projekt und Betrieb
  'project.create': (p) => ({ title: 'Projekt angelegt', category: 'deploy', sub: [str(p.name)] }),
  'project.delete': (p) => ({ title: 'Projekt gelöscht', category: 'danger', sub: [str(p.slug) ?? str(p.name)] }),
  'project.deploy': (p) => ({ title: 'Neu deployt', category: 'deploy', sub: [str(p.ref) ? `Ref ${p.ref}` : null] }),
  'project.rollback': () => ({ title: 'Zurückgerollt', category: 'deploy' }),
  'project.recreate': () => ({ title: 'Neu erstellt', category: 'deploy', sub: ['Namen von Airlock'] }),
  'project.auto_deploy': (p) => ({ title: 'Auto-Deploy nach Merge', category: 'deploy', sub: [str(p.head) ? `Commit ${String(p.head).slice(0, 7)}` : null] }),
  'project.auto_deploy_setting': (p) => ({ title: p.enabled === false ? 'Auto-Deploy ausgeschaltet' : 'Auto-Deploy eingeschaltet', category: 'config' }),
  'project.start': () => ({ title: 'Gestartet', category: 'deploy' }),
  'project.stop': () => ({ title: 'Gestoppt', category: 'paused' }),
  'project.restart': () => ({ title: 'Neu gestartet', category: 'deploy' }),
  'project.update': (p) => {
    if (p.keep === true) return { title: 'Ablauf ausgeschaltet', category: 'config', sub: ['«Behalten»'] }
    if (p.keep === false) return { title: 'Ablauf wieder aktiviert', category: 'config' }
    const keys = Object.keys(p).filter((k) => k !== 'keep')
    const LABEL: Record<string, string> = { name: 'Name', port: 'Port', healthcheckPath: 'Healthcheck', cpuLimit: 'CPU-Grenze', memoryLimitMb: 'RAM-Grenze' }
    return { title: 'Einstellungen geändert', category: 'config', sub: [keys.map((k) => LABEL[k] ?? k).join(', ') || null] }
  },
  'project.env.replace': (p) => {
    const k = list(p.keys)
    return { title: 'Umgebungsvariablen geändert', category: 'config', sub: [k.length ? `${k.length} ${k.length === 1 ? 'Variable' : 'Variablen'}` : 'keine Variablen'] }
  },
  'project.routes.set': (p) => ({ title: 'Erreichbarkeit geändert', category: 'config', sub: [list(p.targets).map((t) => WAY[t] ?? t).join(', ') || null] }),
  'project.routes.internal': (p) => ({ title: 'Erreichbarkeit intern geändert', category: 'config', sub: [list(p.targets).map((t) => WAY[t] ?? t).join(', ') || null] }),
  'project.expiry_warning': () => ({ title: 'Läuft bald ab', category: 'paused' }),
  'project.expired': () => ({ title: 'Wegen Ablauf gestoppt', category: 'paused' }),
  'reconcile.container_missing': () => ({ title: 'Container fehlte, neu gestartet', category: 'error' }),

  // Veröffentlichung
  'project.public': (p) => ({ title: 'Öffentlich gemacht', category: 'public', sub: [str(p.hostname), p.accessProtected ? 'mit Cloudflare Access' : null] }),
  'project.public.rename': (p) => ({ title: 'Öffentliche Adresse geändert', category: 'public', sub: [str(p.before) && str(p.hostname) ? `${p.before} → ${p.hostname}` : str(p.hostname)] }),
  'project.public.access': (p) => ({ title: p.accessProtected ? 'Cloudflare Access eingeschaltet' : 'Cloudflare Access ausgeschaltet', category: 'public', sub: [str(p.hostname)] }),
  'project.public.change': (p) => ({ title: 'Veröffentlichung geändert', category: 'public', sub: [str(p.hostname)] }),
  'project.public.remove': (p) => ({ title: 'Offline genommen', category: 'paused', sub: [str(p.hostname)] }),
  'project.public.pause': (p) => ({ title: 'Öffentlich pausiert', category: 'paused', sub: [str(p.hostname)] }),
  'project.public.resume': (p, e) => {
    const since = str(p.pausedSince)
    const span = spanMs(since, e.at)
    const paused = span !== null ? took(span) : null
    return { title: 'Wieder öffentlich', category: 'public', sub: [str(p.hostname), paused ? `${paused} pausiert` : null] }
  },
  'project.public.pause_page': (p) => ({ title: 'Pause-Seite angepasst', category: 'config', sub: [pausePageText(p)] }),
  'public.request': (p) => ({ title: 'Öffentlich angefragt', category: 'public', sub: [str(p.hostname), 'nach dem Scan'] }),
  'public.request.approve': () => ({ title: 'Öffentlich-Anfrage bestätigt', category: 'public' }),
  'public.request.apply': () => ({ title: 'Nach dem Scan öffentlich geschaltet', category: 'public' }),
  'public.request.discard': () => ({ title: 'Öffentlich-Anfrage verworfen', category: 'config' }),

  // Security
  'header.set': (p) => ({ title: `Header gesetzt: ${headerShort(p.header)}`, category: 'header', sub: [p.mode === 'report-only' ? 'als Report-Only' : null] }),
  'header.remove': (p) => ({ title: `Header entfernt: ${headerShort(p.header)}`, category: 'header' }),
  'header.csp_reverted': () => ({ title: 'CSP zurück auf Report-Only', category: 'error', sub: ['Funktionsprüfung im Browser gescheitert'] }),
  'header.csp_check': (p) => ({ title: 'CSP im Browser geprüft', category: 'header', sub: [str(p.state) === 'ok' ? 'ohne Verstoss' : str(p.message)] }),
  'scan.start': (p) => ({ title: 'Scan gestartet', category: 'scan', sub: [p.level === 'active' ? 'Aktiv' : 'Standard'] }),
  'scan.done': (p) => ({ title: 'Scan fertig', category: 'scan', sub: [took(num(p.durationMs)) ? `nach ${took(num(p.durationMs))}` : null], chip: gradeChip(p.grade, p.score) }),
  'scan.cancel': () => ({ title: 'Scan abgebrochen', category: 'scan' }),
  'scan.recheck_headers': (p) => ({ title: 'Nachprüfung der Header', category: 'scan', sub: [recheckText(p)], chip: deltaChip(p.before, p.after) }),
  'finding.accept': (p) => ({ title: 'Befund akzeptiert', category: 'scan', sub: [str(p.title), str(p.reason) ? `«${p.reason}»` : null] }),
  'fix.propose': (p) => ({ title: 'Vorschlag von Claude', category: 'claude', sub: [str(p.title)] }),
  'fix.apply': (p) => ({ title: 'Vorschlag übernommen', category: 'claude', sub: [str(p.title)] }),
  'fix.reject': (p) => ({ title: 'Vorschlag verworfen', category: 'claude', sub: [str(p.title)] }),
  'fix.pull_request': (p) => ({ title: 'Pull Request eröffnet', category: 'claude', sub: [str(p.title), num(p.number) ? `#${p.number}` : null] }),

  // Dateien (Chat-Projekte)
  'files.init': (p) => ({ title: 'Dateien angelegt', category: 'code', sub: [list(p.files).length ? `${list(p.files).length} Dateien` : null] }),
  'files.update': (p) => ({ title: str(p.message) ? firstLine(String(p.message)) : 'Dateien geändert', category: 'code', sub: [changedFiles(p)] }),
  'files.export': (p) => ({ title: 'Dateien exportiert', category: 'code', sub: [str(p.format) === 'push' ? 'auf ein Git-Repo' : null] }),
  'upload.create': (p) => ({ title: 'Datei hochgeladen', category: 'code', sub: [str(p.name)] }),

  // Zugang und System (globales Audit-Log)
  'auth.login': (_p, e) => ({ title: e.result === 'error' ? 'Anmeldung fehlgeschlagen' : 'Angemeldet', category: e.result === 'error' ? 'error' : 'access' }),
  'auth.password': () => ({ title: 'Passwort geändert', category: 'access' }),
  'token.create': (p) => ({ title: 'Token angelegt', category: 'access', sub: [str(p.name) ? `«${p.name}»` : null] }),
  'token.revoke': (p) => ({ title: 'Token widerrufen', category: 'access', sub: [str(p.name) ? `«${p.name}»` : null] }),
  'ui.prefs': () => ({ title: 'Darstellung geändert', category: 'config' }),
  'notifications.update': () => ({ title: 'Benachrichtigungen geändert', category: 'config' }),
  'notifications.test': () => ({ title: 'Test-Benachrichtigung gesendet', category: 'config' }),
  'settings.pause_page': (p) => ({ title: 'Vorlage der Pause-Seite geändert', category: 'config', sub: [p.reset ? 'auf Standard zurückgesetzt' : str(p.title) ? `«${p.title}»` : null] }),
  'external_target.add': (p) => ({ title: 'Externes Ziel eingetragen', category: 'scan', sub: [str(p.hostname)] }),
  'external_target.verify': (p) => ({ title: 'Externes Ziel bestätigt', category: 'scan', sub: [str(p.hostname)] }),
  'external_target.verification_lost': (p) => ({ title: 'Besitznachweis verloren', category: 'error', sub: [str(p.hostname)] }),
  'external_target.update': (p) => ({ title: 'Externes Ziel geändert', category: 'config', sub: [str(p.hostname)] }),
  'external_target.delete': (p) => ({ title: 'Externes Ziel entfernt', category: 'danger', sub: [str(p.hostname)] }),
  'domain.default': (p) => ({ title: 'Standard-Domain gesetzt', category: 'config', sub: [str(p.name)] }),
  'dns.tailnet': (p) => ({ title: 'Tailnet-DNS gesetzt', category: 'config', sub: [str(p.name)] }),
  'network.change': () => ({ title: 'Netz des Servers geändert', category: 'config' }),
  'cloudflare.tls': () => ({ title: 'Zertifikat eingerichtet', category: 'config' }),
  'cloudflare.domains': () => ({ title: 'Cloudflare-Domains abgeglichen', category: 'config' }),
  'cloudflare.disconnect': () => ({ title: 'Cloudflare getrennt', category: 'danger' }),
  'cloudflare.tunnel': () => ({ title: 'Cloudflare Tunnel eingerichtet', category: 'config' }),
  'cloudflare.tunnel.skip': () => ({ title: 'Cloudflare Tunnel übersprungen', category: 'config' }),
  'cloudflare.tunnel.restart': () => ({ title: 'Cloudflare Tunnel neu gestartet', category: 'config' }),
  'cloudflare.cloudflared.update': () => ({ title: 'cloudflared aktualisiert', category: 'config' }),
  'github.app_created': () => ({ title: 'GitHub App angelegt', category: 'config' }),
  'github.installed': () => ({ title: 'GitHub App installiert', category: 'config' }),
  'github.manifest': () => ({ title: 'GitHub App vorbereitet', category: 'config' }),
  'github.repos': () => ({ title: 'GitHub-Repos abgeglichen', category: 'config' }),
  'github.disconnect': () => ({ title: 'GitHub getrennt', category: 'danger' }),
}

/** MCP-Werkzeuge, falls ihr Aufruf allein steht */
const MCP_TOOL: Record<string, string> = {
  create_project: 'Projekt angelegt', update_files: 'Dateien geändert', read_files: 'Dateien gelesen', export_repo: 'Exportiert',
  deploy: 'Deploy angestossen', start: 'Gestartet', stop: 'Gestoppt', rollback: 'Rollback angestossen', delete_project: 'Projekt gelöscht',
  get_project: 'Projekt abgefragt', list_projects: 'Projekte abgefragt', get_logs: 'Logs gelesen', run_scan: 'Scan angestossen',
  get_scan_report: 'Scan-Bericht gelesen', accept_finding: 'Befund akzeptiert', set_targets: 'Erreichbarkeit geändert',
  pause_public: 'Öffentlich pausiert', resume_public: 'Wieder öffentlich', unpublish: 'Offline genommen', set_security_header: 'Header gesetzt',
  propose_fix: 'Vorschlag gemacht', apply_fix: 'Vorschlag übernommen', get_fix_context: 'Befund gelesen', list_domains: 'Domains abgefragt',
  add_external_target: 'Externes Ziel eingetragen', verify_external_target: 'Externes Ziel geprüft',
}

const WORD: Record<string, string> = {
  deploy: 'Deploy', failed: 'fehlgeschlagen', done: 'fertig', start: 'gestartet', started: 'gestartet', stop: 'gestoppt', update: 'geändert',
  updated: 'geändert', create: 'angelegt', created: 'angelegt', delete: 'gelöscht', remove: 'entfernt', set: 'gesetzt', check: 'geprüft',
  scan: 'Scan', project: 'Projekt', env: 'Variablen', settings: 'Einstellungen', public: 'öffentlich', error: 'Fehler', unchanged: 'unverändert',
}

/** Lesbarer Satz für unbekannte Typen: «deploy.failed» → «Deploy fehlgeschlagen» */
export function fallbackTitle(action: string): string {
  const words = action.split(/[._:-]+/).filter(Boolean).filter((w, i, a) => !(w === 'project' && a.length > 1 && i === 0))
  const t = words.map((w) => WORD[w] ?? w).join(' ')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Ereignis'
}

function firstLine(s: string): string {
  const l = s.split('\n')[0]!.trim()
  return l.length > 90 ? `${l.slice(0, 89)}…` : l
}
function changedFiles(p: P): string | null {
  const w = Array.isArray(p.write) ? p.write.length : 0
  const d = list(p.delete).length
  const parts = [w ? `${w} ${w === 1 ? 'Datei' : 'Dateien'} geändert` : null, d ? `${d} gelöscht` : null].filter(Boolean)
  return parts.join(', ') || null
}
function recheckText(p: P): string | null {
  const f = list(p.fixed).length
  const o = list(p.opened).length
  if (!f && !o) return null
  return [f ? `${f} behoben` : null, o ? `${o} neu offen` : null].filter(Boolean).join(', ')
}
function pausePageText(p: P): string | null {
  const c = str(p.custom)
  if (!c || c === 'unverändert') return null
  return c === 'wie Vorlage' ? 'wie Vorlage' : `eigene Pause-Seite «${c}»`
}

export function describeEvent(e: AuditEventDto): EventInfo {
  const p = (e.paramsMasked ?? {}) as P
  let action = e.action
  if (action.startsWith('mcp.')) {
    const tool = action.slice(4)
    // Der Auslöser «Claude (<Token>)» sagt schon, dass es über MCP kam
    return { title: MCP_TOOL[tool] ?? fallbackTitle(tool), sub: e.result === 'error' && e.error ? [firstLine(e.error)] : [], category: e.result === 'error' ? 'error' : 'claude', chip: null }
  }
  const d = EVENTS[action]
  const base = d ? d(p, e) : { title: fallbackTitle(action), category: 'config' as Category, sub: [] }
  const info: EventInfo = { title: base.title, sub: (base.sub ?? []).filter((x): x is string => Boolean(x)), category: base.category, chip: base.chip ?? null }
  if (e.result === 'error') {
    action = action.replace(/^project\./, '')
    if (/deploy|rollback|recreate/.test(action)) info.title = action.includes('rollback') ? 'Rollback fehlgeschlagen' : 'Deploy fehlgeschlagen'
    else if (!/fehl/.test(info.title)) info.title = `${info.title} – fehlgeschlagen`
    info.category = 'error'
    if (e.error) info.sub = [firstLine(e.error), ...info.sub]
  }
  return info
}

/* --- Bündeln ------------------------------------------------------------------ */

export interface ActivityItem {
  id: string
  /** Zeit des ersten Schritts (so liest man die Zeitleiste) */
  at: string
  actor: string
  targetType: string | null
  targetId: string | null
  info: EventInfo
  events: AuditEventDto[]
}

const MIN = 60_000
type Kind = 'headers' | 'pause' | 'deploy' | 'scan' | 'single'

function kindOf(e: AuditEventDto): Kind {
  if (e.result === 'error') return 'single'
  if (e.action === 'header.set' || e.action === 'header.remove') return 'headers'
  if (e.action === 'project.public.pause') return 'pause'
  if (/^project\.(deploy|rollback|recreate|auto_deploy)$/.test(e.action) || /^(files\.update|files\.init|fix\.apply)$/.test(e.action)) return 'deploy'
  if (e.action === 'scan.start') return 'scan'
  return 'single'
}

interface Cluster { kind: Kind; events: AuditEventDto[]; last: number }

/** Darf das Ereignis in den Bündel? (älteste zuerst durchlaufen) */
function accepts(c: Cluster, e: AuditEventDto): boolean {
  if (e.result === 'error' || c.events[0]!.targetId !== e.targetId) return false
  const t = at(e)
  const near = (ms: number) => t - c.last <= ms
  const a = e.action
  switch (c.kind) {
    case 'headers':
      return ((a === 'header.set' || a === 'header.remove') && near(3 * MIN)) || (a === 'scan.recheck_headers' && near(3 * MIN) && !c.events.some((x) => x.action === a))
    case 'pause':
      return a === 'project.public.pause_page' && near(15 * MIN)
    case 'deploy': {
      const hasDeploy = c.events.some((x) => /^project\.(deploy|rollback|recreate)$/.test(x.action))
      if (/^project\.(deploy|rollback|recreate)$/.test(a)) return !hasDeploy && near(10 * MIN)
      if (a === 'project.auto_deploy') return near(2 * MIN) && !c.events.some((x) => x.action === a)
      if (a === 'scan.start') return hasDeploy && near(2 * MIN) && !c.events.some((x) => x.action === a)
      if (a === 'scan.done') return sameScan(c, e)
      return false
    }
    case 'scan':
      return a === 'scan.done' && sameScan(c, e)
    default:
      return false
  }
}
function sameScan(c: Cluster, e: AuditEventDto): boolean {
  const id = (e.paramsMasked as P | null)?.scan
  return c.events.some((x) => x.action === 'scan.start' && (x.paramsMasked as P | null)?.scan === id)
}

/** Nur gelesen (get_project, read_files …): in der Aktivität eines Projekts ohne Aussage */
export const isReadOnly = (e: AuditEventDto) => /^mcp\.(get_|list_|read_files)/.test(e.action) && e.result !== 'error'

/** Wie weit ein MCP-Aufruf von seinem Ereignis entfernt sein darf (mit wait läuft der Deploy mit) */
const TWIN = 10 * MIN

/** MCP-Aufruf neben einem eigenen Ereignis desselben Tokens: geht im Bündel auf */
function isTwin(e: AuditEventDto, all: AuditEventDto[]): boolean {
  if (!e.action.startsWith('mcp.') || e.result === 'error') return false
  const t = at(e)
  return all.some((x) => x !== e && !x.action.startsWith('mcp.') && x.actor === e.actor && Math.abs(at(x) - t) <= TWIN)
}

/** Ereignisse (neueste zuerst) zu Einträgen bündeln; Ergebnis neueste zuerst. */
export function bundle(events: AuditEventDto[]): ActivityItem[] {
  const oldestFirst = [...events].sort((a, b) => at(a) - at(b) || Number(a.id) - Number(b.id))
  const clusters: Cluster[] = []
  for (const e of oldestFirst) {
    if (isTwin(e, oldestFirst)) continue
    const open = [...clusters].reverse().find((c) => accepts(c, e))
    if (open) { open.events.push(e); open.last = at(e); continue }
    clusters.push({ kind: kindOf(e), events: [e], last: at(e) })
  }
  const viaMcp = (e: AuditEventDto) => e.actor.startsWith('token:') && (e.action.startsWith('mcp.') || oldestFirst.some((x) => x.action.startsWith('mcp.') && x.actor === e.actor && Math.abs(at(x) - at(e)) <= TWIN))
  return clusters.map((c) => {
    const lead = c.events[0]!
    const actor = viaMcp(lead) ? `mcp:${lead.actor.slice(6)}` : lead.actor
    return { id: lead.id, at: lead.at, actor, targetType: lead.targetType, targetId: lead.targetId, info: summarize(c), events: c.events }
  }).reverse()
}

function summarize(c: Cluster): EventInfo {
  const lead = c.events[0]!
  const info = describeEvent(lead)
  const find = (a: string) => c.events.find((x) => x.action === a)
  if (c.kind === 'headers') {
    const sets = c.events.filter((x) => x.action === 'header.set')
    const names = sets.map((x) => headerShort((x.paramsMasked as P).header))
    const recheck = find('scan.recheck_headers')
    if (sets.length > 1) {
      info.title = `${sets.length} Header gesetzt`
      info.sub = [names.join(', ')]
    }
    if (recheck) {
      info.sub.push('Nachprüfung')
      const r = recheck.paramsMasked as P
      info.chip = deltaChip(r.before, r.after)
    }
  }
  if (c.kind === 'pause') {
    const page = find('project.public.pause_page')
    if (page) {
      const t = pausePageText(page.paramsMasked as P) ?? 'Pause-Seite'
      const clock = fmtTime(page.at)
      info.sub = [`${t} (${clock} angepasst)`]
    }
  }
  if (c.kind === 'deploy') {
    const deploy = c.events.find((x) => /^project\.(deploy|rollback|recreate)$/.test(x.action))
    if (lead.action === 'files.init') {
      // Chat-Projekt angelegt: Dateien, erstes Deployment, erster Scan in einem Eintrag
      info.title = 'Projekt angelegt'
      info.category = 'deploy'
      if (deploy) info.sub = [...info.sub, 'erstes Deployment']
    } else if (lead.action === 'files.update' || lead.action === 'fix.apply') {
      // Code-Änderung: die Commit-Nachricht ist der Titel, «deployt» die Unterzeile
      if (deploy) info.sub = [...info.sub, 'deployt']
      info.category = 'code'
    } else if (lead.action === 'project.auto_deploy') {
      info.category = 'deploy'
    }
    const done = find('scan.done')
    if (done) {
      const d = done.paramsMasked as P
      info.sub.push('Scan danach')
      info.chip = gradeChip(d.grade, d.score)
    } else if (find('scan.start')) {
      info.sub.push('Scan läuft')
    }
  }
  if (c.kind === 'scan') {
    const done = find('scan.done')
    if (done) {
      const d = done.paramsMasked as P
      const t = took(num(d.durationMs))
      if (t) info.sub.push(`fertig nach ${t}`)
      info.chip = gradeChip(d.grade, d.score)
    }
  }
  return info
}

/* --- Tage ---------------------------------------------------------------------- */

/** «Heute», «Gestern», sonst «Montag, 9. November» */
export function dayLabel(iso: string, now = new Date()): string {
  const d = dateOf(iso)
  if (!d) return 'Ohne Datum'
  if (sameDay(d, now)) return 'Heute'
  if (sameDay(d, addDays(now, -1))) return 'Gestern'
  return fmtWeekday(d, d.getFullYear() !== now.getFullYear())
}

export function byDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const out: { day: string; items: ActivityItem[] }[] = []
  for (const it of items) {
    const day = dayLabel(it.at)
    const last = out.at(-1)
    if (last && last.day === day) last.items.push(it)
    else out.push({ day, items: [it] })
  }
  return out
}
