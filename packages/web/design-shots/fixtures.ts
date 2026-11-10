/**
 * Daten für die Prototyp-Screenshots (docs/prototype-cal). Typisiert gegen
 * die echten DTOs aus @airlock/shared und api.ts: Der Compiler prüft, dass
 * die Seiten dieselben Formen bekommen wie von der API. Erfundene Projekte
 * und Werte, keine echten Server- oder Zugangsdaten.
 */
import type {
  AuditEventDto, CfStatusDto, DeploymentDto, FindingDto, ProjectDto, ProjectHealthDto, PublicProgressDto, PublicStatusDto, RouteDto, ScanReportDto, SystemStatusDto,
  HeaderRulesDto, FixHintDto, FixRequestDto, GithubStatusDto, PausePage,
} from '@airlock/shared'
import { fixPrompt } from '@airlock/shared'
import type { ApiTokenDto, DomainDto, ExternalTargetDto, MeDto, NotifySettingsDto, PublicFlowResult } from '../src/api.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const BASE = 'int.example.ch'

function route(targets: RouteDto['target'][], host: string): RouteDto {
  return { target: targets[0]!, targets, hostname: host, aliases: [], urls: [`https://${host}`] }
}

function dep(projectId: string, n: number, over: Partial<DeploymentDto> = {}): DeploymentDto {
  const started = ago(over.startedAt ? 0 : (n + 1) * 7 * HOUR)
  return {
    id: `${projectId}-d${n}`,
    projectId,
    version: ['a3f9c21d0be4', '9be20c4d7f11', '51c0aa8e2d93', 'e04d17b6c2fa', '7d2e9f03ab58'][n % 5]!,
    sourceRef: null,
    status: 'superseded',
    errorMessage: null,
    startedAt: started,
    finishedAt: new Date(Date.parse(started) + 41_000).toISOString(),
    isActive: false,
    durationMs: 41_000,
    trigger: 'deploy',
    rollbackOf: null,
    canRollback: true,
    ...over,
  }
}

type P = Partial<ProjectDto> & { id: string; name: string; slug: string }
function project(p: P): ProjectDto {
  const active = dep(p.id, 0, { status: 'active', isActive: true, canRollback: false, startedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR - 38_000), durationMs: 38_000 })
  return {
    sourceType: 'image',
    source: { type: 'image', image: 'ghcr.io/example/app:1.4.2' } as ProjectDto['source'],
    port: 8080,
    healthcheckPath: '/health',
    status: 'running',
    desiredState: 'running',
    keep: true,
    cpuLimit: 1,
    memoryLimitMb: 512,
    createdAt: ago(40 * DAY),
    updatedAt: ago(2 * HOUR),
    routes: [route(['tailnet', 'lan'], `${p.slug}.${BASE}`)],
    activeDeployment: active,
    runsAsRoot: false,
    runtimeKind: 'image',
    filesKind: null,
    lastChangeAt: ago(2 * HOUR),
    expiresAt: null,
    security: { scanId: `${p.id}-s`, status: 'done', score: 97, grade: 'A', finishedAt: ago(90 * MIN), open: { critical: 0, high: 0, medium: 0, low: 1 } },
    lastDeployment: active,
    legacyContainers: false,
    ...p,
  }
}

export const projects: ProjectDto[] = [
  project({
    id: 'p-foto', name: 'Fotoalbum', slug: 'fotoalbum', runtimeKind: 'compose', sourceType: 'compose', source: { type: 'compose', repoUrl: 'https://github.com/example/fotoalbum.git', ref: 'main', composePath: 'compose.yaml', webService: 'web' } as ProjectDto['source'], memoryLimitMb: 1024,
    // Projektseite: der Fall «Ohne offene Befunde»
    security: { scanId: 'p-foto-s', status: 'done', score: 100, grade: 'A', finishedAt: ago(2 * MIN), open: { critical: 0, high: 0, medium: 0, low: 0 } },
  }),
  project({
    id: 'p-haushalt', name: 'Haushaltsbuch', slug: 'haushaltsbuch',
    routes: [route(['tailnet', 'lan'], `haushaltsbuch.${BASE}`), { ...route(['public'], 'haushalt.example.ch'), accessProtected: true, since: ago(12 * DAY), pausedAt: null }],
    security: { scanId: 'p-haushalt-s', status: 'done', score: 84, grade: 'B', finishedAt: ago(5 * HOUR), open: { critical: 0, high: 0, medium: 2, low: 3 } },
  }),
  project({
    id: 'p-wetter', name: 'Wetterstation', slug: 'wetterstation', status: 'failed',
    lastDeployment: dep('p-wetter', 9, { status: 'failed', startedAt: ago(14 * MIN), finishedAt: ago(13 * MIN), durationMs: 52_000, errorMessage: 'Healthcheck /health antwortet nicht (Verbindung abgelehnt auf Port 8080 nach 60 s)', canRollback: false }),
    security: { scanId: 'p-wetter-s', status: 'done', score: 61, grade: 'C', finishedAt: ago(2 * DAY), open: { critical: 0, high: 2, medium: 4, low: 2 } },
  }),
  project({
    id: 'p-rezepte', name: 'Rezepte-API', slug: 'rezepte-api', status: 'deploying', runtimeKind: 'dockerfile', sourceType: 'dockerfile', source: { type: 'dockerfile', repoUrl: 'https://github.com/example/rezepte-api.git', ref: 'main', dockerfile: 'Dockerfile', context: '.' } as ProjectDto['source'],
    lastDeployment: dep('p-rezepte', 3, { status: 'pulling', startedAt: ago(40_000), finishedAt: null, durationMs: null, canRollback: false }),
  }),
  project({ id: 'p-notizen', name: 'Notizen', slug: 'notizen', status: 'stopped', desiredState: 'stopped', security: null }),
  project({
    id: 'p-kontoauszug', name: 'Kontoauszug-Reader', slug: 'kontoauszug-reader', runtimeKind: 'compose', memoryLimitMb: 768,
    security: { scanId: 'p-konto-s', status: 'done', score: 38, grade: 'D', finishedAt: ago(3 * HOUR), open: { critical: 1, high: 1, medium: 3, low: 4 } },
  }),
  project({
    id: 'p-verein', name: 'Vereinsseite', slug: 'vereinsseite', runtimeKind: 'static', sourceType: 'files', source: { type: 'files' } as ProjectDto['source'], keep: true,
    routes: [route(['tailnet'], `vereinsseite.${BASE}`), { ...route(['public'], 'verein.example.ch'), since: ago(60 * DAY), pausedAt: ago(3 * HOUR) }],
    security: { scanId: 'p-verein-s', status: 'done', score: 92, grade: 'A', finishedAt: ago(2 * DAY), open: { critical: 0, high: 0, medium: 1, low: 2 } },
  }),
]

/** Chat-Projekt mit öffentlicher Adresse – der Zustand «1 Projekt» der Referenz */
const halloWelt = project({
  id: 'p-hallo', name: 'hallo-welt', slug: 'hallo-welt', sourceType: 'files', runtimeKind: 'static', filesKind: 'static',
  source: { type: 'files' } as ProjectDto['source'], keep: false, expiresAt: new Date(Date.now() + 30 * DAY - HOUR).toISOString(), port: 80,
  routes: [route(['tailnet', 'lan'], `hallo-welt.${BASE}`), route(['public'], 'hallo-welt.example.ch')],
  security: { scanId: 'p-hallo-s', status: 'done', score: 96, grade: 'A', finishedAt: ago(48 * MIN), open: { critical: 0, high: 0, medium: 1, low: 0 } },
  lastDeployment: dep('p-hallo', 0, { version: '5a19cd4e8b21', status: 'active', isActive: true, canRollback: false, startedAt: ago(25 * MIN), finishedAt: ago(25 * MIN - 9_000), durationMs: 9_000 }),
})

/**
 * Projektliste mit fester Anzahl (0 bis 7) für die Screenshots der Übersicht.
 * Reihenfolge so, dass wenige Projekte einen typischen Anfang zeigen.
 */
export function projectsFor(count: number): ProjectDto[] {
  const byId = (id: string) => projects.find((x) => x.id === id)!
  return [halloWelt, ...['p-foto', 'p-haushalt', 'p-wetter', 'p-rezepte', 'p-notizen', 'p-kontoauszug'].map(byId)].slice(0, count)
}
/** Alle Projekte, die irgendeine Variante zeigt (für Detail-Anfragen) */
export const allProjects: ProjectDto[] = [...projects, halloWelt]

/* --- Veröffentlichung: Privat, Öffentlich, Pausiert ------------------------------------ */

export const liveProjectId = 'p-haushalt'
export const pausedProjectId = 'p-verein'

export function publicStatus(id: string): PublicStatusDto {
  const p = allProjects.find((x) => x.id === id) ?? projects[0]!
  const pub = p.routes.find((r) => r.target === 'public')
  const internal = p.routes.find((r) => r.target !== 'public')
  const critical = (p.security?.open.critical ?? 0) > 0
  return {
    state: !pub ? 'private' : pub.pausedAt ? 'paused' : 'live',
    enabled: true,
    hostname: pub?.hostname ?? null,
    url: pub ? `https://${pub.hostname}` : null,
    since: pub ? pub.pausedAt ?? pub.since ?? null : null,
    accessProtected: Boolean(pub?.accessProtected),
    internalUrl: internal?.urls[0] ?? null,
    publishable: critical
      ? { ok: false, why: 'critical', reason: '1 kritischer Befund offen: SQL-Injection in /api/suche. Beheben oder mit Begründung akzeptieren.' }
      : id === requestWaitingProjectId ? { ok: false, why: 'scan_running', reason: 'Scan läuft seit 5 Min. – veröffentlichen geht, sobald er ohne kritischen Befund fertig ist.' }
      : !p.security ? { ok: false, why: 'no_scan', reason: 'Noch kein abgeschlossener Scan – er startet nach dem ersten erfolgreichen Deploy.' } : { ok: true },
    pendingRequest: pendingRequest(id),
    // Pausiertes Projekt mit eigenem Text und «zurück um»; sonst Vorlage
    pause: id === pausedProjectId
      ? { page: pausePageCustom, backAt: new Date(Date.now() + 14 * HOUR).toISOString(), template: pausePageTemplate }
      : { page: null, backAt: null, template: pausePageTemplate },
    progress: null,
  }
}

/* --- Pause-Seite ------------------------------------------------------------------- */

export const pausePageTemplate: PausePage = {
  mode: 'form',
  lang: 'de',
  title: 'Vorübergehend nicht erreichbar',
  message: 'Diese Seite ist gerade pausiert. Bitte später noch einmal versuchen.',
  linkText: 'Statusseite',
  linkUrl: 'https://status.example.ch',
  contact: '',
  html: '',
}

/** Pausiertes Projekt mit eigenem Code (Vereinsfarben, hell und dunkel) */
export const pausePageCustom: PausePage = {
  mode: 'code',
  lang: 'de',
  title: 'Wir ziehen um',
  message: 'Die Vereinsseite bekommt ein neues Zuhause.',
  linkText: '',
  linkUrl: '',
  contact: 'vorstand@example.ch',
  html: `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{title}}</title>
  <style>
    :root { color-scheme: light dark; --bg: #fff8ef; --fg: #2b1d0e; --accent: #c2410c; }
    @media (prefers-color-scheme: dark) { :root { --bg: #1c140c; --fg: #fbe9d7; --accent: #fb923c; } }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 17px/1.6 Georgia, serif; }
    main { max-width: 30rem; padding: 0 20px; }
    h1 { font-size: 2rem; margin: 0 0 .5rem; color: var(--accent); }
    .back { font-family: system-ui, sans-serif; font-size: .9rem; opacity: .8; }
  </style>
</head>
<body>
  <main>
    <h1>{{title}}</h1>
    <p>Die Vereinsseite bekommt ein neues Zuhause. Anmeldungen für das Sommerfest gehen weiter an vorstand@example.ch.</p>
    <p class="back">Wieder da: <time datetime="{{back_at_iso}}">{{back_at}}</time></p>
  </main>
</body>
</html>
`,
}

/** Vorgemerkte Öffentlich-Anfragen (per MCP): wartet auf den Scan bzw. gesperrt */
export const requestWaitingProjectId = 'p-rezepte'
export const requestBlockedProjectId = 'p-kontoauszug'

function pendingRequest(id: string): PublicStatusDto['pendingRequest'] {
  const at = new Date(Date.now() - 6 * MIN)
  const hhmm = at.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })
  const base = { requestedAt: at.toISOString(), actor: 'token:claude-code-mac', accessProtected: false, approvedBy: null, approvedAt: null, lastError: null }
  if (id === requestWaitingProjectId) {
    return { ...base, hostname: 'rezepte.example.ch', state: 'waiting', text: `Öffentlich angefragt von token:claude-code-mac um ${hhmm} – wartet auf abgeschlossenen Scan ohne kritischen Befund.` }
  }
  if (id === requestBlockedProjectId) {
    return { ...base, hostname: null, state: 'blocked', text: `Öffentlich angefragt von token:claude-code-mac um ${hhmm} – gesperrt, solange ein kritischer Befund offen ist.` }
  }
  return null
}

/** Fortschritt mitten im Veröffentlichen (Tunnel-Regel läuft). */
export function publishProgress(id: string): PublicProgressDto {
  const p = allProjects.find((x) => x.id === id)!
  return {
    op: 'publish', hostname: `${p.slug}.example.ch`, startedAt: ago(4_000), finishedAt: null, ok: null,
    steps: [
      { key: 'check', label: 'Schwelle und Name prüfen', state: 'done', detail: `Scan bestanden · ${p.slug}.example.ch` },
      { key: 'dns', label: 'DNS-Eintrag', state: 'done', detail: `CNAME ${p.slug}.example.ch auf den Tunnel angelegt` },
      { key: 'tunnel', label: 'Tunnel-Regel', state: 'current' },
      { key: 'caddy', label: 'Caddy-Route', state: 'todo' },
      { key: 'outside', label: 'Prüfung von aussen über Cloudflare', state: 'todo' },
    ],
  }
}

/** Antwort auf «Pausieren» (für den Toast mit «Rückgängig»). */
export function pauseResult(id: string): PublicFlowResult {
  const p = allProjects.find((x) => x.id === id)!
  const pub = p.routes.find((r) => r.target === 'public')!
  const after: ProjectDto = { ...p, routes: p.routes.map((r) => (r.target === 'public' ? { ...r, pausedAt: new Date().toISOString() } : r)) }
  return {
    hostname: pub.hostname, changed: true, project: after,
    check: { ok: true, status: 503, viaCloudflare: true, message: 'Besucher sehen die Wartungsseite (HTTP 503).' },
    status: { ...publicStatus(id), state: 'paused', since: new Date().toISOString() },
  }
}

export const detailProjectId = 'p-foto'
export const securityProjectId = 'p-kontoauszug'

export const me: MeDto = { loggedIn: true, name: 'Joël', sessionSince: ago(3 * HOUR), viaHttps: true, passwordChangedAt: ago(20 * DAY), passwordSource: 'ui', theme: 'system' }

/**
 * Deployments mit Grund und Auslöser (Projektseite). Fotoalbum zeigt alle
 * Fälle: aktiv, gescheitert, Rollback möglich, drei ältere mit gleichem Stand
 * (Sammelzeile). hallo-welt ist der Fall der Referenz: dreimal derselbe Stand.
 */
export function deployments(id: string): DeploymentDto[] {
  const p = allProjects.find((x) => x.id === id) ?? projects[0]!
  const at = (h: number, secs: number) => ({ startedAt: ago(h), finishedAt: new Date(Date.now() - h + secs * 1000).toISOString(), durationMs: secs * 1000 })
  if (id === 'p-hallo') {
    const v = '5a19cd4e8b21'
    return [
      { ...p.lastDeployment!, ...at(57 * MIN, 0.4), seq: 3, reason: { kind: 'headers', detail: 'Strict-Transport-Security' }, actor: 'ui:joel', message: 'Erste Version' },
      dep(id, 2, { version: v, ...at(62 * MIN, 0.3), seq: 2, reason: { kind: 'public', detail: 'hallo-welt.example.ch' }, actor: 'mcp:claude-code-mac', message: 'Erste Version' }),
      dep(id, 1, { version: v, ...at(2 * HOUR, 4), seq: 1, reason: { kind: 'first' }, actor: 'mcp:claude-code-mac', message: 'Erste Version' }),
    ]
  }
  const active = p.activeDeployment!
  const same = active.version ?? 'a3f9c21d0be4'
  if (id === 'p-foto') {
    return [
      { ...active, seq: 6, reason: { kind: 'auto_merge', detail: 'Galerie lädt Vorschaubilder träge' }, actor: 'system:auto-deploy', message: 'Galerie lädt Vorschaubilder träge' },
      dep(id, 5, { version: '51c0aa8e2d93', ...at(5 * HOUR, 26), status: 'failed', errorMessage: 'Build fehlgeschlagen: npm ci (exit 1)', canRollback: false, seq: 5, reason: { kind: 'redeploy' }, actor: 'ui:joel', message: 'Bildvorschau mit sharp' }),
      dep(id, 4, { version: 'e04d17b6c2fa', ...at(26 * HOUR, 44), seq: 4, reason: { kind: 'auto_merge', detail: 'Upload-Grenze auf 20 MB' }, actor: 'system:auto-deploy', message: 'Upload-Grenze auf 20 MB' }),
      dep(id, 3, { version: '9be20c4d7f11', ...at(3 * DAY, 39), seq: 3, reason: { kind: 'headers', detail: 'X-Frame-Options' }, actor: 'ui:joel', message: 'Alben teilen per Link' }),
      dep(id, 2, { version: '9be20c4d7f11', ...at(4 * DAY, 41), seq: 2, reason: { kind: 'public', detail: null }, actor: 'ui:joel', message: 'Alben teilen per Link' }),
      dep(id, 1, { version: '9be20c4d7f11', ...at(9 * DAY, 52), seq: 1, reason: { kind: 'first' }, actor: 'mcp:claude-code-mac', message: 'Alben teilen per Link' }),
    ]
  }
  return [
    { ...active, seq: 5, reason: { kind: 'redeploy' }, actor: 'ui:joel' },
    dep(id, 4, { version: same, ...at(9 * HOUR, 37), seq: 4, reason: { kind: 'paused' }, actor: 'token:backup-skript', canRollback: true }),
    dep(id, 3, { version: '9be20c4d7f11', ...at(2 * DAY, 41), status: 'failed', errorMessage: 'Build fehlgeschlagen: npm ci (exit 1)', canRollback: false, seq: 3, reason: { kind: 'code', detail: 'Abhängigkeiten aktualisiert' }, actor: 'mcp:claude-code-mac' }),
    dep(id, 2, { version: 'e04d17b6c2fa', ...at(5 * DAY, 44), seq: 2, reason: { kind: 'rollback' }, actor: 'ui:joel' }),
    dep(id, 1, { version: '7d2e9f03ab58', ...at(12 * DAY, 58), seq: 1, reason: { kind: 'first' }, actor: 'mcp:claude-code-mac', message: 'Erste Version' }),
  ]
}

export const deployLog = [
  '[12:41:03] Quelle holen: github.com/example/fotoalbum (main)',
  '[12:41:05] Commit a3f9c21d0be4 – «Galerie lädt Vorschaubilder träge»',
  '[12:41:06] docker compose build',
  '[12:41:31] Image gebaut: fotoalbum-web (184 MB)',
  '[12:41:33] Container starten, Healthcheck /health',
  '[12:41:41] Healthcheck ok nach 8 s (200, 41 ms)',
  '[12:41:41] Fassung a3f9c21d0be4 ist aktiv',
].join('\n')

export function health(id: string): ProjectHealthDto {
  const failed = id === 'p-wetter'
  const samples = Array.from({ length: 60 }, (_, i) => ({
    at: new Date(Date.now() - (59 - i) * MIN).toISOString(),
    cpu: Math.round((0.12 + 0.08 * Math.sin(i / 5) + (i > 44 && i < 50 ? 0.35 : 0)) * 100) / 100,
    memMb: Math.round(310 + 40 * Math.sin(i / 9) + i * 1.2),
  }))
  return {
    kind: 'compose',
    container: failed ? { running: false, startedAt: ago(14 * MIN), exitCode: 1 } : { running: true, startedAt: ago(2 * HOUR), exitCode: null },
    health: failed
      ? { at: ago(13 * MIN), ok: false, status: null, error: 'connect ECONNREFUSED 172.20.0.4:8080', ms: 60_000, url: 'http://wetterstation:8080/health', port: 8080 }
      : { at: ago(40_000), ok: true, status: 200, error: null, ms: 41, url: 'http://fotoalbum:8080/health', port: 8080 },
    samples: failed ? [] : samples,
  }
}

export const appLogs = [
  '2026-11-09T12:58:01Z GET /api/albums 200 12ms',
  '2026-11-09T12:58:04Z GET /api/albums/41/photos?page=2 200 38ms',
  '2026-11-09T12:58:09Z POST /api/upload 201 412ms (3 Dateien, 11.4 MB)',
  '2026-11-09T12:58:10Z Vorschaubilder: 3 in Warteschlange',
  '2026-11-09T12:58:14Z WARN Vorschau IMG_4412.HEIC: Format ohne Farbprofil, sRGB angenommen',
  '2026-11-09T12:58:15Z Vorschaubilder fertig (2.1 s)',
].join('\n')

const findings: FindingDto[] = [
  { id: 'f1', tool: 'trivy', severity: 'critical', title: 'CVE-2026-31337 in openssl 3.0.13 (Remote Code Execution)', location: 'image: kontoauszug-reader-api · /usr/lib/libssl.so.3', description: 'Ein präpariertes Zertifikat kann beim TLS-Handshake Code ausführen.', fix: 'Basis-Image auf debian:12.8-slim oder neuer aktualisieren.', status: 'open', acceptReason: null },
  { id: 'f2', tool: 'zap', severity: 'high', title: 'Session-Cookie ohne Secure-Attribut', location: 'https://kontoauszug-reader.int.example.ch/login', description: 'Das Cookie «sid» wird auch über http gesendet.', fix: 'Cookie mit Secure und SameSite=Lax setzen.', status: 'open', acceptReason: null },
  { id: 'f3', tool: 'trivy', severity: 'medium', title: 'Container läuft als root', location: 'compose: service api', description: 'Der Prozess läuft mit UID 0.', fix: 'user: "1000:1000" im Compose-Service setzen.', status: 'open', acceptReason: null },
  { id: 'f4', tool: 'header-check', severity: 'medium', title: 'Content-Security-Policy fehlt', location: 'https://kontoauszug-reader.int.example.ch/', description: 'Ohne CSP kann eingeschleustes Skript (XSS) ungehindert laufen und Daten abfliessen lassen.', fix: "Header Content-Security-Policy setzen, z.B. \"default-src 'self'\" als Ausgangspunkt.", status: 'open', acceptReason: null },
  // M8: Header-Befunde mit «Header setzen»
  { id: 'f7', tool: 'header-check', severity: 'medium', title: 'Strict-Transport-Security fehlt', location: 'https://kontoauszug-reader.int.example.ch/', description: 'Ohne HSTS kann eine erste Verbindung auf HTTP herabgestuft werden.', fix: 'Header Strict-Transport-Security: max-age=31536000 setzen.', status: 'open', acceptReason: null },
  { id: 'f8', tool: 'header-check', severity: 'low', title: 'X-Content-Type-Options: nosniff fehlt', location: 'https://kontoauszug-reader.int.example.ch/', description: 'Browser könnten Inhalte anders deuten als ausgeliefert (MIME-Sniffing).', fix: 'Header X-Content-Type-Options: nosniff setzen.', status: 'open', acceptReason: null },
  { id: 'f9', tool: 'header-check', severity: 'medium', title: 'Schutz gegen Einbetten fehlt (frame-ancestors / X-Frame-Options)', location: 'https://kontoauszug-reader.int.example.ch/', description: 'Die Seite lässt sich in fremde Seiten einbetten (Clickjacking).', fix: "In der CSP \"frame-ancestors 'self'\" setzen oder X-Frame-Options: DENY.", status: 'fixed', acceptReason: null },
  { id: 'f5', tool: 'nuclei', severity: 'medium', title: 'Server-Version im Header sichtbar', location: 'Server: uvicorn', description: 'Verrät die Version des Webservers.', fix: 'Server-Header entfernen (--no-server-header).', status: 'accepted', acceptReason: 'Nur im Tailnet erreichbar' },
  { id: 'f6', tool: 'trivy', severity: 'low', title: 'Veraltetes Paket: tzdata 2024a', location: 'image: kontoauszug-reader-api', description: 'Zeitzonendaten sind nicht aktuell.', fix: 'Image neu bauen.', status: 'open', acceptReason: null },
]

const CHECKS = {
  trivyImage: 'Trivy: bekannte Schwachstellen in Paketen und Image, Secrets, Fehlkonfiguration',
  trivySource: 'Trivy: Secrets im Code und Fehlkonfiguration (Dockerfile, Compose)',
  headers: 'Header-Check: Security-Header und Cookies der Antwort',
  zap: 'ZAP Baseline: Seite crawlen und passiv auf typische Web-Schwachstellen prüfen',
  nuclei: 'Nuclei: offen erreichbare Dateien, Admin-Oberflächen, Standard-Logins',
}

/** Projekt, dessen Scan in den Screenshots gerade läuft */
export const runningScanProjectId = 'p-haushalt'

/** hallo-welt: nur die fehlende CSP offen (Referenz «Mit offenem Befund») */
const halloFindings: FindingDto[] = [
  { id: 'h1', tool: 'header-check', severity: 'medium', title: 'Content-Security-Policy fehlt', location: 'https://hallo-welt.example.ch/', description: 'Ohne CSP kann eingeschleustes Skript (XSS) ungehindert laufen.', fix: "Header Content-Security-Policy setzen, z.B. \"default-src 'self'\".", status: 'open', acceptReason: null },
  { id: 'h2', tool: 'header-check', severity: 'low', title: 'X-Content-Type-Options: nosniff fehlt', location: 'https://hallo-welt.example.ch/', description: 'MIME-Sniffing möglich.', fix: 'Header X-Content-Type-Options: nosniff setzen.', status: 'fixed', acceptReason: null },
]

export function scan(id: string, onlyDone = false): ScanReportDto | null {
  const p = allProjects.find((x) => x.id === id)
  if (!p?.security) return null
  if (id === runningScanProjectId && !onlyDone) return runningScan(p)
  const f = id === securityProjectId ? findings : id === 'p-hallo' ? halloFindings : id === 'p-foto' ? [] : findings.slice(5)
  const isStatic = p.runtimeKind === 'static'
  const startedAt = new Date(new Date(p.security.finishedAt ?? ago(0)).getTime() - 5 * MIN - 4_000).toISOString()
  const previous: Record<string, number> = { 'p-hallo': 90, 'p-foto': 100, 'p-kontoauszug': 41 }
  return {
    scan: {
      id: p.security.scanId, status: 'done', level: 'standard',
      startedAt, finishedAt: p.security.finishedAt,
      score: p.security.score, grade: p.security.grade, error: null, trigger: 'deploy', actor: 'admin', queue: null,
      previousScore: previous[id] ?? (p.security.score ?? 0) - 3,
      nextScheduledAt: new Date(Date.parse(startedAt) + 7 * DAY).toISOString(),
      stages: isStatic ? {
        'trivy-image': { ran: false, state: 'skipped', note: 'kein Image, statische Seite', checks: CHECKS.trivyImage },
        'trivy-source': { ran: true, state: 'done', findings: 0, checks: CHECKS.trivySource, durationMs: 12_000 },
        headers: { ran: true, state: 'done', findings: 1, checks: CHECKS.headers, durationMs: 900 },
        'zap-baseline': { ran: true, state: 'done', findings: 0, checks: CHECKS.zap, durationMs: 98_000 },
        nuclei: { ran: true, state: 'done', findings: 0, checks: CHECKS.nuclei, durationMs: 41_000 },
      } : {
        'trivy-image': { ran: true, state: 'done', findings: 4, checks: CHECKS.trivyImage, durationMs: 98_000 },
        'trivy-source': { ran: false, state: 'skipped', note: 'kein Quellordner: fertiges Image ohne Quellcode', checks: CHECKS.trivySource },
        // M8: Header über Caddy geprüft
        headers: id === securityProjectId
          ? { ran: true, state: 'done', findings: 4, checks: CHECKS.headers, checked: 'über Caddy, wie Besucher die Seite sehen', durationMs: 1_200 }
          : { ran: true, state: 'done', findings: 0, checks: CHECKS.headers, durationMs: 1_200 },
        'zap-baseline': { ran: true, state: 'done', findings: 2, checks: CHECKS.zap, durationMs: 142_000 },
        nuclei: { ran: true, state: 'done', findings: 1, checks: CHECKS.nuclei, durationMs: 61_000 },
        testssl: { ran: false, state: 'skipped', note: 'TLS endet zentral bei Caddy, siehe Systemseite' },
      },
    },
    counts: p.security.open,
    top: f.filter((x) => x.status === 'open').slice(0, 3).map(({ id: fid, severity, title, location, fix }) => ({ id: fid, severity, title, location, fix })),
    findings: f,
  }
}

function runningScan(p: ProjectDto): ScanReportDto {
  return {
    scan: {
      id: 'scan-live', status: 'running', level: 'standard', startedAt: ago(5 * MIN + 12_000), finishedAt: null,
      score: null, grade: null, error: null, trigger: 'mcp', actor: 'token:claude-code-mac', queue: null,
      stages: {
        'trivy-image': { ran: true, state: 'done', findings: 0, checks: CHECKS.trivyImage, durationMs: 74_000, startedAt: ago(5 * MIN), finishedAt: ago(3 * MIN + 46_000) },
        'trivy-source': { ran: false, state: 'skipped', note: 'kein Quellordner: fertiges Image ohne Quellcode', checks: CHECKS.trivySource },
        headers: { ran: true, state: 'done', findings: 1, checks: CHECKS.headers, durationMs: 900 },
        'zap-baseline': {
          ran: false, state: 'running', checks: CHECKS.zap, startedAt: ago(3 * MIN + 40_000), timeoutMs: 15 * MIN, progress: '37 URLs gecrawlt',
          tail: [
            'Using the Automation Framework',
            `Spidering http://${p.slug}.int.example.ch/ …`,
            'Total of 37 URLs',
            'PASS: Vulnerable JS Library (Powered by Retire.js) [10003]',
            'PASS: Cookie No HttpOnly Flag [10010]',
            'WARN-NEW: Content Security Policy (CSP) Header Not Set [10038] x 4',
          ],
        },
        nuclei: { ran: false, state: 'waiting', checks: CHECKS.nuclei, timeoutMs: 15 * MIN },
        testssl: { ran: false, state: 'skipped', note: 'TLS endet zentral bei Caddy, siehe Systemseite' },
      },
    },
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    top: [],
    findings: [],
  }
}

/** M8: Header über Caddy – CSP im Report-Only mit gesammelten Verstössen, frame-ancestors aktiv. */
export function headerRules(id: string, reverted = false): HeaderRulesDto {
  const none = { violations: [], total: 0, suggestion: null, notes: [], readiness: null, inlinePrompt: null }
  if (id === 'p-hallo') {
    // Noch keine Regel; die Analyse läuft trotzdem (Unterzeile in der Security-Karte)
    return { rules: [], hsts: { ok: true, reason: null }, viaCaddy: true, csp: { ...none, analysis: { pages: ['/'], inlineScripts: 1, inlineStyles: 1, styleAttributes: 0, eventHandlers: 0, external: {}, conflicts: ['Inline-Skript auf /', 'Inline-Style auf /'], error: null } } }
  }
  if (id === 'p-foto') {
    const r = (header: HeaderRulesDto['rules'][number]['header'], value: string) => ({ header, value, mode: 'enforce' as const, createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY) })
    return {
      rules: [
        r('content-security-policy', "default-src 'self'; img-src 'self' data:"), r('frame-ancestors', "'self'"), r('referrer-policy', 'strict-origin-when-cross-origin'),
        r('strict-transport-security', 'max-age=31536000'), r('x-content-type-options', 'nosniff'),
      ],
      hsts: { ok: true, reason: null }, viaCaddy: true, csp: { ...none, analysis: null },
    }
  }
  if (id !== securityProjectId) return { rules: [], hsts: { ok: false, reason: 'HTTPS ist nicht eingerichtet (System → Cloudflare → Zertifikat).' }, viaCaddy: true, csp: { violations: [], total: 0, suggestion: null, notes: [], analysis: null, readiness: null, inlinePrompt: null } }
  const policy = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'"
  // CSP-Fix: der Fall hallo-welt – Inline-Skript und Inline-Style; nach einem Scharfschalten automatisch zurück
  const check = reverted
    ? { state: 'failed' as const, at: ago(2 * MIN), pages: ['/', '/auswertung'], violations: ['Inline-Skript (script-src) auf /', 'Inline-Style (style-src) auf /'], message: 'Zurück auf Report-Only. 2 Verstösse beim Laden im Browser.' }
    : null
  return {
    rules: [
      { header: 'content-security-policy', value: policy, mode: 'report-only', createdAt: ago(2 * HOUR), updatedAt: ago(reverted ? 2 * MIN : 2 * HOUR), reportOnlySince: ago(reverted ? 2 * MIN : 2 * HOUR), check },
      { header: 'frame-ancestors', value: "'self'", mode: 'enforce', createdAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) },
    ],
    hsts: { ok: true, reason: null },
    viaCaddy: true,
    csp: {
      violations: [
        { directive: 'script-src', blocked: 'https://cdn.jsdelivr.net', samplePath: '/auswertung', count: 42, lastSeen: ago(6 * MIN) },
        { directive: 'style-src', blocked: 'inline', samplePath: '/', count: 17, lastSeen: ago(9 * MIN) },
        { directive: 'connect-src', blocked: 'wss://kontoauszug-reader.int.example.ch', samplePath: '/live', count: 5, lastSeen: ago(31 * MIN) },
      ],
      total: 64,
      suggestion: "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' wss://kontoauszug-reader.int.example.ch; object-src 'none'; base-uri 'self'; form-action 'self'",
      notes: [
        'Diese CSP blockiert 1 Inline-Skript und 1 Inline-Style – zuerst auslagern.',
        "Inline-Code in style-src: in eine Datei auslagern oder per Hash/Nonce erlauben – 'unsafe-inline' schlägt Airlock nicht vor.",
      ],
      analysis: {
        pages: ['/', '/auswertung', '/live'],
        inlineScripts: 1, inlineStyles: 1, styleAttributes: 0, eventHandlers: 0,
        external: { 'script-src': ['https://cdn.jsdelivr.net'] },
        conflicts: ['1 Inline-Skript (<script> ohne src)', '1 Inline-Style (<style>)', 'script-src: https://cdn.jsdelivr.net'],
        error: null,
      },
      readiness: {
        ok: false,
        reason: "Die Regel würde blockieren: 1 Inline-Skript (<script> ohne src); 1 Inline-Style (<style>); script-src: https://cdn.jsdelivr.net. 7 von 20 Aufrufen im Report-Only, 3 Verstösse gemeldet.",
        views: 7, viewsNeeded: 20, violationsSince: 3,
      },
      inlinePrompt: [
        "Lagere im Airlock-Projekt «Kontoauszug-Reader» (kontoauszug-reader) den Inline-Code in eigene Dateien aus, damit eine Content-Security-Policy ohne 'unsafe-inline' funktioniert. Diese CSP blockiert 1 Inline-Skript und 1 Inline-Style – zuerst auslagern.",
        'Hole Befund und Dateien mit dem Airlock-MCP: get_fix_context mit project "kontoauszug-reader" und finding "f4".',
        'Verschiebe <script>-Inhalte in .js-Dateien und <style>-Inhalte in .css-Dateien, ersetze style="…" durch Klassen und onclick=… durch addEventListener. Schlage die Änderung mit propose_fix vor; ich prüfe den Diff in Airlock.',
      ].join('\n'),
    },
  }
}

/** M8, Etappe 2: Auftrag am Befund «Container läuft als root» und am CVE (fertiges Image) */
export function fixHint(findingId: string): FixHintDto {
  if (findingId === 'f1') {
    return {
      way: 'image', prompt: null,
      explanation: 'Fertiges Image: Airlock kann nichts daran ändern. Abhilfe ist eine neuere Image-Version, in der das Paket aktualisiert ist.',
      image: { image: 'ghcr.io/example/kontoauszug-reader-api:1.4-bookworm', fixedIn: 'openssl 3.0.15-1~deb12u1', candidates: ['1.6-bookworm', '2.1-bookworm'], note: 'Kandidaten derselben Linie; ob sie das Paket wirklich aktualisieren, zeigt erst der Scan nach dem Wechsel.' },
    }
  }
  return {
    way: 'files',
    prompt: fixPrompt({ projectName: 'Kontoauszug-Reader', slug: 'kontoauszug-reader', findingId: '3f1c9a52-7d40-4e8b-9b1a-0c2d6e8f4a17', title: 'Container läuft als root', severity: 'medium', way: 'files' }),
    explanation: 'Chat-Projekt: Die Änderung wird als Vorschlag mit Diff angelegt (propose_fix). Erst nach Zustimmung entsteht eine neue Version, Airlock deployt und scannt nach.',
    image: null,
  }
}

export function fixRequests(id: string): FixRequestDto[] {
  if (id !== securityProjectId) return []
  const base = { findingId: 'f3', tool: 'trivy', way: 'mcp' as const, baseCommit: 'a3f9c21d0be4', branch: null, prUrl: null, actor: 'token:claude-code' }
  return [
    {
      ...base, id: 'x1', findingTitle: 'Container läuft als root', status: 'proposed', commit: null, note: null,
      explanation: 'Der API-Dienst läuft jetzt als Benutzer node (UID 1000). Das Volume /data gehört diesem Benutzer bereits; sonst ändert sich nichts.',
      diff: ['--- a/compose.yaml', '+++ b/compose.yaml', '@@ -4,6 +4,7 @@', '   api:', '     build: ./api', '     restart: unless-stopped', '+    user: "1000:1000"', '     volumes:', '       - data:/data', '     environment:'].join('\n'),
      createdAt: ago(7 * MIN), updatedAt: ago(7 * MIN),
    },
    {
      ...base, id: 'x2', findingTitle: 'Offene Datei /backup.sql', tool: 'nuclei', status: 'verified', commit: '9c1e07b2aa41', note: 'Der Nachscan findet den Befund nicht mehr.',
      explanation: 'backup.sql aus dem Projekt entfernt und in .dockerignore aufgenommen.',
      diff: ['--- a/backup.sql', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-«Binärdatei»'].join('\n'),
      createdAt: ago(26 * HOUR), updatedAt: ago(25 * HOUR),
    },
  ]
}

/** M8, Etappe 3: GitHub-Seite – vor dem Anlegen oder fertig installiert */
export function github(connected: boolean): GithubStatusDto {
  const base = {
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read (von GitHub immer dabei)' },
    suggestedName: 'airlock heimserver 4f2a',
    callbackUrl: `https://deployer.${BASE}/api/v1/github/manifest/callback`,
  }
  if (!connected) return { ...base, connected: false, app: null, installed: false, repos: [], installUrl: null }
  return {
    ...base, connected: true, installed: true,
    app: { name: 'airlock heimserver 4f2a', slug: 'airlock-heimserver-4f2a', htmlUrl: 'https://github.com/apps/airlock-heimserver-4f2a', owner: 'example', createdAt: ago(2 * HOUR) },
    repos: ['example/fotoalbum', 'example/rezepte-api'],
    installUrl: 'https://github.com/apps/airlock-heimserver-4f2a/installations/new',
  }
}

export function autoDeploy(id: string) {
  const repo = id === 'p-foto' || id === 'p-rezepte'
  return { autoDeploy: id === 'p-foto', checkedAt: ago(3 * MIN), available: repo, viaGithubApp: repo }
}

export function audit(targetId?: string): AuditEventDto[] {
  const rows: [number, string, string, string | null, 'ok' | 'error', string | null][] = [
    [4 * MIN, 'ui', 'project.deploy', 'p-rezepte', 'ok', null],
    [9 * MIN, 'ui', 'auth.login', null, 'ok', null],
    [13 * MIN, 'system', 'deploy.failed', 'p-wetter', 'error', 'Healthcheck /health antwortet nicht'],
    [40 * MIN, 'ip:192.168.1.77', 'auth.login', null, 'error', 'falsches Passwort'],
    [70 * MIN, 'ui', 'auth.login', null, 'ok', null],
    [2 * HOUR, 'ui', 'project.deploy', 'p-foto', 'ok', null],
    [3 * HOUR, 'system', 'scan.done', 'p-kontoauszug', 'ok', null],
    [4 * HOUR, 'ui', 'auth.login', null, 'ok', null],
    [5 * HOUR, 'mcp:claude', 'project.env', 'p-haushalt', 'ok', null],
    [7 * HOUR, 'ui', 'auth.login', null, 'ok', null],
    [26 * HOUR, 'ui', 'cloudflare.tls', 'cloudflare', 'ok', null],
  ]
  return rows
    .filter((r) => !targetId || r[3] === targetId)
    .map(([t, actor, action, tid, result, error], i) => ({ id: String(100 - i), at: ago(t), actor, action, targetType: tid?.startsWith('p-') ? 'project' : 'system', targetId: tid, paramsMasked: {}, result, error }))
}

export const system: SystemStatusDto = {
  version: '0.9.0',
  checks: [
    { name: 'Datenbank', ok: true, detail: 'PostgreSQL 17.2' },
    { name: 'Caddy', ok: true, detail: 'v2.10.0, 14 Routen' },
    { name: 'Caddy-Admin nur über Unix-Socket', ok: true, detail: '/run/caddy/admin.sock' },
    { name: 'Docker', ok: true, detail: 'über socket-proxy, 27.3.1' },
  ],
  diskFreeBytes: 182e9,
  ipFilterEnabled: true,
  baseDomain: BASE,
  serverLanIp: '192.168.1.20',
  network: { mode: 'detected', checkedAt: ago(20 * MIN), lanIp: '192.168.1.20', lanCidr: '192.168.1.0/24', lanDev: 'enp3s0', tailscaleIp: '100.88.41.12', tailscaleSource: 'erkannt', detectedTailscaleIp: '100.88.41.12' },
  nipioEnabled: true,
  hostsBlock: null,
  tls: { mode: 'cloudflare', acmeCa: 'production', cert: null, tailscaleIp: '100.88.41.12' },
  server: { name: 'heimserver', cpuPercent: 14, memUsedBytes: 9.8e9, memTotalBytes: 32e9, diskUsedBytes: 318e9, diskTotalBytes: 500e9 },
  scanQueue: 0,
  publicTunnel: { configured: false, status: null, connections: 0 },
  // Wie auf dem Server vor dem Fix: Tailnet-Anfragen kommen maskiert vom Docker-Gateway
  clientIps: { total: 14, fromGateway: 9, gatewayIps: ['172.20.0.1'], gatewayOnly: false, blocked: 9, since: ago(30 * MIN) },
  reachability: [
    { way: 'dns', label: `Interner Name (deployer.${BASE})`, url: `https://deployer.${BASE}/health` },
    { way: 'nipio', label: 'nip.io (100-88-41-12)', url: 'http://deployer.100-88-41-12.nip.io/health' },
  ],
}

/** Assistent mitten in Schritt 5: Token, Domains, Tunnel übersprungen, Zertifikat läuft. */
export const cloudflare: CfStatusDto = {
  source: 'ui',
  token: {
    present: true, source: 'ui', savedAt: ago(26 * MIN),
    lastCheck: {
      valid: true, complete: true, message: null, expiresOn: null,
      accounts: [{ id: 'acc1', name: 'Privat' }],
      zones: [{ id: 'z1', name: 'example.ch', dnsEdit: true }],
      permissions: [
        { key: 'zone_read', label: 'Zone → Zone → Lesen', required: true, ok: true, detail: null },
        { key: 'dns_edit', label: 'Zone → DNS → Bearbeiten', required: true, ok: true, detail: null },
        { key: 'tunnel_edit', label: 'Konto → Cloudflare Tunnel → Bearbeiten', required: true, ok: true, detail: null },
        { key: 'access_edit', label: 'Konto → Access: Apps und Richtlinien → Bearbeiten', required: false, ok: false, detail: 'Nur für öffentliche Projekte hinter Access' },
      ],
    },
  },
  account: { id: 'acc1', name: 'Privat' },
  zones: [{ id: 'z1', name: 'example.ch', isDefault: true }],
  baseDomain: BASE,
  defaultZone: 'example.ch',
  tailscaleIp: '100.88.41.12',
  detectedTailscaleIp: '100.88.41.12',
  accessEmail: null,
  acmeEmail: null,
  tunnel: null,
  tunnelSkipped: true,
  tls: {
    enabled: true,
    phase: 'production',
    ca: 'production',
    startedAt: ago(70_000),
    retryAt: null,
    reusesCert: false,
    steps: [
      { at: ago(70_000), text: `Probelauf: Zertifikat für *.${BASE} bei der Staging-CA von Let's Encrypt anfordern (DNS-Challenge über Cloudflare)`, tone: 'info' },
      { at: ago(44_000), text: `Caddy meldet: Zertifikat für *.${BASE} bezogen (acme-staging-v02.api.letsencrypt.org-directory)`, tone: 'ok' },
      { at: ago(40_000), text: "Probelauf erfolgreich: (STAGING) Let's Encrypt – (STAGING) Ersatz Edamame E1", tone: 'ok' },
      { at: ago(38_000), text: `Echtes Zertifikat für *.${BASE} bei Let's Encrypt anfordern`, tone: 'info' },
    ],
    cert: null,
  },
  tokenTemplateUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  requiredPermissions: [],
  publicProjects: 0,
}

export const domains: { domains: DomainDto[]; publicEnabled: boolean } = { domains: [{ id: 'd1', name: 'example.ch', zoneId: 'z1', isDefault: true }], publicEnabled: false }

export const notifications: NotifySettingsDto = {
  ntfy: { url: 'https://ntfy.sh', topic: 'heimserver-7f3a', hasToken: false },
  email: null,
  matrix: {
    deploy_failed: { push: true, email: false },
    finding_critical: { push: true, email: false },
    finding_high: { push: true, email: false },
    project_public: { push: true, email: false },
    external_verification_lost: { push: true, email: false },
    infra_problem: { push: true, email: false },
    expiry: { push: false, email: false },
    weekly_summary: { push: false, email: false },
  },
}

export const failedLog = [
  '[22:31:02] Quelle holen: ghcr.io/example/wetterstation:2.0.1',
  '[22:31:09] Container starten, Healthcheck /health',
  '[22:31:10] wetterstation  | Traceback (most recent call last):',
  '[22:31:10] wetterstation  |   File "/app/main.py", line 12, in <module>',
  '[22:31:10] wetterstation  | KeyError: \'SENSOR_URL\'',
  '[22:32:10] Healthcheck /health antwortet nicht (Verbindung abgelehnt auf Port 8080 nach 60 s)',
  '[22:32:10] Deploy fehlgeschlagen – Version a3f9c21 läuft unverändert weiter',
].join('\n')

export const tokens: ApiTokenDto[] = [
  { id: 't1', name: 'Claude (MacBook)', createdAt: ago(30 * DAY), lastUsedAt: ago(5 * HOUR), revokedAt: null },
  { id: 't2', name: 'Backup-Skript', createdAt: ago(80 * DAY), lastUsedAt: ago(26 * HOUR), revokedAt: null },
  { id: 't3', name: 'Altes Notebook', createdAt: ago(200 * DAY), lastUsedAt: ago(120 * DAY), revokedAt: ago(90 * DAY) },
]

export const externalTargets: ExternalTargetDto[] = [
  { id: 'e1', hostname: 'blog.example.ch', verified: true, verifiedAt: ago(12 * DAY), lastCheckAt: ago(6 * HOUR), scanInterval: 'weekly', txt: { name: '_airlock-verify.blog.example.ch', value: 'airlock-verify=7f3a9c21e04d' } },
  { id: 'e2', hostname: 'shop.example.ch', verified: false, verifiedAt: null, lastCheckAt: null, scanInterval: 'off', txt: { name: '_airlock-verify.shop.example.ch', value: 'airlock-verify=51c0aa8e2d93' } },
]

export const externalScan: ScanReportDto | null = null

export function env(id: string) {
  return id === detailProjectId
    ? [
        { key: 'DATABASE_URL', isSecret: true, value: null },
        { key: 'THUMBNAIL_SIZE', isSecret: false, value: '480' },
        { key: 'TZ', isSecret: false, value: 'Europe/Zurich' },
      ]
    : []
}
