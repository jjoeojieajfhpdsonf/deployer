/**
 * Daten für die Prototyp-Screenshots (docs/prototype-cal). Typisiert gegen
 * die echten DTOs aus @airlock/shared und api.ts: Der Compiler prüft, dass
 * die Seiten dieselben Formen bekommen wie von der API. Erfundene Projekte
 * und Werte, keine echten Server- oder Zugangsdaten.
 */
import type {
  AuditEventDto, CfStatusDto, DeploymentDto, FindingDto, ProjectDto, ProjectHealthDto, PublicProgressDto, PublicStatusDto, RouteDto, ScanReportDto, SystemStatusDto,
  HeaderRulesDto, FixHintDto, FixRequestDto, GithubStatusDto, PausePage,
  EnvironmentDto, HeaderTemplateDto, LanDnsCheckDto, MovePreviewDto, PublicNameCheckDto,
  BackupRunDto, BackupSettingsDto, BackupSnapshotDto, BackupStatusDto, BackupKeyPaperDto, BackupRestorePreviewDto,
  TrafficPointDto, TrafficRange, TrafficRowDto, TrafficSummaryDto, TrafficTodayDto, TrafficWay,
  PreviewDto, PreviewsDto,
} from '@airlock/shared'
import { TRAFFIC_RANGES, TRAFFIC_WAYS } from '@airlock/shared'
import { addDays, availabilityOf, dayInZone, overallOf, statusDays } from '@airlock/shared'
import type { IncidentDto, PublicStatusIncident, PublicStatusJson, PublicStatusProject, StatusDayCount, StatusPageDto } from '@airlock/shared'
import { countOpenFindings, explainFailure, fixPrompt, projectState, RESERVED_SLUGS, RESERVED_PUBLIC_LABELS, normalizePublicLabel, slugify } from '@airlock/shared'
import type { ApiTokenDto, DomainDto, ExternalTargetDto, MeDto, NotifySettingsDto, PublicFlowResult } from '../src/api.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const BASE = 'int.example.ch'

function route(targets: RouteDto['target'][], host: string): RouteDto {
  return { target: targets[0]!, targets, hostname: host, aliases: [], urls: [`https://${host}`] }
}

/* Deploy-Logs gescheiterter Deploys im Format der Pipeline (Grundlage der Fehlererklärung, UI-Qualität 2) */
const stamp = (msAgo: number) => `[${new Date(Date.now() - msAgo).toISOString()}]`
export const HEALTH_FAILED = 'Healthcheck nicht bestanden'
export const BUILD_FAILED = "Build fehlgeschlagen: The command '/bin/sh -c npm ci' returned a non-zero code: 1"

/** Wetterstation: der Healthcheck scheitert, weil SENSOR_URL fehlt */
export const failedLog = [
  `${stamp(14 * MIN)} --- pulling ---`,
  `${stamp(14 * MIN - 1_000)} Image ghcr.io/example/wetterstation:2.0.1 holen`,
  `${stamp(14 * MIN - 6_000)} --- starting ---`,
  `${stamp(14 * MIN - 7_000)} --- healthchecking ---`,
  `${stamp(14 * MIN - 7_100)} Healthcheck gegen http://wetterstation-d9:8080/health`,
  `${stamp(14 * MIN - 7_200)} Healthcheck 1: noch nicht erreichbar (connect ECONNREFUSED 172.20.0.7:8080)`,
  `${stamp(13 * MIN)} Healthcheck nach 58 Versuchen nicht bestanden (getaddrinfo ENOTFOUND wetterstation-d9)`,
  `${stamp(13 * MIN - 100)} Container beendet: Exit-Code 1`,
  `${stamp(13 * MIN - 200)} Letzte Container-Ausgabe:`,
  'Traceback (most recent call last):',
  '  File "/app/main.py", line 12, in <module>',
  "    SENSOR_URL = os.environ['SENSOR_URL']",
  '  File "<frozen os>", line 714, in __getitem__',
  "KeyError: 'SENSOR_URL'",
  `${stamp(13 * MIN - 500)} FEHLGESCHLAGEN: ${HEALTH_FAILED}`,
].join('\n')

/** Build mit npm gescheitert (sharp ohne passende Binärdateien) */
export const buildFailedLog = [
  `${stamp(5 * HOUR)} --- pulling ---`,
  `${stamp(5 * HOUR - 1_000)} Repo klonen (main)`,
  `${stamp(5 * HOUR - 3_000)} Step 1/7 : FROM node:22-alpine`,
  `${stamp(5 * HOUR - 3_100)} Step 4/7 : RUN npm ci`,
  `${stamp(5 * HOUR - 20_000)} npm error code 1`,
  `${stamp(5 * HOUR - 20_000)} npm error path /app/node_modules/sharp`,
  `${stamp(5 * HOUR - 20_000)} npm error command failed`,
  `${stamp(5 * HOUR - 20_000)} npm error sharp: Prebuilt libvips 8.15.3 binaries are not yet available for linuxmusl-arm64v8`,
  `${stamp(5 * HOUR - 20_000)} npm error A complete log of this run can be found in: /root/.npm/_logs/debug-0.log`,
  `${stamp(5 * HOUR - 21_000)} FEHLGESCHLAGEN: ${BUILD_FAILED}`,
].join('\n')

/** Logs einzelner Deployments (Fehlermuster-Projekte unten); sonst nach der Meldung */
const FAILURE_LOGS: Record<string, string> = {}
/** Log zu einem gescheiterten Deploy */
export const logForFailure = (message: string | null, deploymentId?: string) =>
  (deploymentId && FAILURE_LOGS[deploymentId]) || (message?.startsWith('Build') ? buildFailedLog : failedLog)

function dep(projectId: string, n: number, over: Partial<DeploymentDto> = {}): DeploymentDto {
  const d = depRaw(projectId, n, over)
  // Wie der Server (recordFailure): gescheiterte mit der beim Scheitern festgehaltenen Erklärung
  if (d.status !== 'failed' || d.failure !== undefined) return d
  return { ...d, failure: explainFailure({ message: d.errorMessage, log: logForFailure(d.errorMessage, d.id), port: 8080, healthcheckPath: '/health', memoryLimitMb: 512, envKeys: [] }) }
}

function depRaw(projectId: string, n: number, over: Partial<DeploymentDto> = {}): DeploymentDto {
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
/** Zustand wie auf dem Server berechnet (projectState), damit Pille, Liste und Fehlerbox stimmen */
function project(p: P): ProjectDto {
  const raw = projectRaw(p)
  return { ...raw, state: p.state ?? projectState({ ...raw, container: null }) }
}
function projectRaw(p: P): Omit<ProjectDto, 'state'> {
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
    lastDeployment: dep('p-wetter', 9, { status: 'failed', startedAt: ago(14 * MIN), finishedAt: ago(13 * MIN), durationMs: 52_000, errorMessage: HEALTH_FAILED, canRollback: false }),
    // Note passend zu den gezählten Befunden (zwei niedrige offen)
    security: { scanId: 'p-wetter-s', status: 'done', score: 94, grade: 'A', finishedAt: ago(2 * DAY), open: { critical: 0, high: 0, medium: 0, low: 2 } },
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
  expiryDays: 30, createdBy: 'mcp:claude-code-mac',
  routes: [route(['tailnet', 'lan'], `hallo-welt.${BASE}`), route(['public'], 'hallo-welt.example.ch')],
  security: { scanId: 'p-hallo-s', status: 'done', score: 96, grade: 'A', finishedAt: ago(48 * MIN), open: { critical: 0, high: 0, medium: 1, low: 0 } },
  lastDeployment: dep('p-hallo', 0, { version: '5a19cd4e8b21', status: 'active', isActive: true, canRollback: false, startedAt: ago(57 * MIN), finishedAt: ago(57 * MIN - 400), durationMs: 400 }),
})
halloWelt.activeDeployment = halloWelt.lastDeployment

/**
 * Projektliste mit fester Anzahl (0 bis 7) für die Screenshots der Übersicht.
 * Reihenfolge so, dass wenige Projekte einen typischen Anfang zeigen.
 */
export function projectsFor(count: number): ProjectDto[] {
  const byId = (id: string) => projects.find((x) => x.id === id)!
  return [halloWelt, ...['p-foto', 'p-haushalt', 'p-wetter', 'p-rezepte', 'p-notizen', 'p-kontoauszug'].map(byId)].slice(0, count)
}
/* --- Fehler erklären (UI-Qualität 2): je Muster ein Projekt, nur für die Projektseite --- */

function failing(id: string, name: string, message: string, log: string, over: Partial<ProjectDto> = {}): ProjectDto {
  FAILURE_LOGS[`${id}-d9`] = log
  const active = dep(id, 0, { status: 'active', isActive: true, canRollback: false, startedAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR - 38_000), durationMs: 38_000 })
  return project({
    id, name, slug: id.replace(/^p-/, ''), security: null, activeDeployment: active,
    routes: [route(['tailnet', 'lan'], `${id.replace(/^p-/, '')}.${BASE}`)],
    lastDeployment: dep(id, 9, { status: 'failed', startedAt: ago(14 * MIN), finishedAt: ago(13 * MIN), durationMs: 52_000, errorMessage: message, canRollback: false }),
    ...over,
  })
}

export const failureProjects: ProjectDto[] = [
  failing('p-fehler-build', 'Rezeptbuch', BUILD_FAILED, buildFailedLog, {
    sourceType: 'files', source: { type: 'files' } as ProjectDto['source'], runtimeKind: 'dockerfile',
  }),
  failing('p-fehler-port', 'Pegelstand', HEALTH_FAILED, [
    `${stamp(14 * MIN)} --- starting ---`,
    `${stamp(14 * MIN - 1_000)} --- healthchecking ---`,
    `${stamp(14 * MIN - 1_100)} Healthcheck gegen http://pegelstand-d9:8080/health`,
    `${stamp(14 * MIN - 1_200)} Healthcheck 1: noch nicht erreichbar (connect ECONNREFUSED 172.20.0.8:8080)`,
    `${stamp(13 * MIN)} Healthcheck nach 60 Versuchen nicht bestanden (connect ECONNREFUSED 172.20.0.8:8080)`,
    `${stamp(13 * MIN - 200)} Letzte Container-Ausgabe:`,
    '{"level":30,"msg":"Messstationen geladen (14)"}',
    '{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}',
    `${stamp(13 * MIN - 500)} FEHLGESCHLAGEN: ${HEALTH_FAILED}`,
  ].join('\n')),
  failing('p-fehler-oom', 'Bildarchiv', HEALTH_FAILED, [
    `${stamp(14 * MIN)} --- starting ---`,
    `${stamp(14 * MIN - 1_000)} --- healthchecking ---`,
    `${stamp(13 * MIN)} Healthcheck nach 41 Versuchen nicht bestanden (getaddrinfo ENOTFOUND bildarchiv-d9)`,
    `${stamp(13 * MIN - 100)} Container beendet: Exit-Code 137 (Speichergrenze überschritten, OOMKilled)`,
    `${stamp(13 * MIN - 200)} Letzte Container-Ausgabe:`,
    'Vorschaubilder werden erzeugt …',
    'Baue Index auf (48 213 Bilder)',
    `${stamp(13 * MIN - 500)} FEHLGESCHLAGEN: ${HEALTH_FAILED}`,
  ].join('\n'), { memoryLimitMb: 512 }),
]

/** Alle Projekte, die irgendeine Variante zeigt (für Detail-Anfragen) */
export const allProjects: ProjectDto[] = [...projects, halloWelt, ...failureProjects]

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

// Etappe 7: Disketti in den Fixtures aus – sie erschiene in allen Windows-95-Szenen eines Projekts
// mit Befund nach knapp einer Sekunde (Bilder liefen je nach Tempo anders); eigene Szenen schalten sie ein
export const me: MeDto = { loggedIn: true, name: 'Joël', sessionSince: ago(3 * HOUR), loginMethod: 'passkey', viaHttps: true, passwordChangedAt: ago(20 * DAY), passwordSource: 'ui', theme: 'system', setup: { dismissed: true, skipped: [] }, bellSeenAt: ago(40 * MIN), fun: true, matrix: false, disketti: false }

/**
 * Etappe 7: Achievements im Konto. Standard: vier erreicht (alle schon gemeldet –
 * sonst gäbe es in jeder Szene eine Meldung), drei offen. «neu»: «Nachtschicht»
 * eben erreicht und noch nicht gemeldet (Meldung; Konfetti nur ohne reduzierte Bewegung).
 */
export function achievements(variant: 'standard' | 'neu' = 'standard'): import('@airlock/shared').AchievementsDto {
  const list = [
    { id: 'first_deploy', title: 'Erster Deploy', description: 'Ein Projekt ist zum ersten Mal erfolgreich gelaufen.', achievedAt: ago(212 * DAY), seen: true },
    { id: 'first_public', title: 'Erstes öffentliches Projekt', description: 'Ein Projekt war zum ersten Mal aus dem Internet erreichbar.', achievedAt: ago(180 * DAY), seen: true },
    { id: 'grade_a', title: 'Note A', description: 'Ein Security-Scan hat die Note A ergeben.', achievedAt: ago(41 * DAY), seen: true },
    { id: 'uptime_100', title: '100 Tage ohne Ausfall', description: 'Ein Projekt war 100 gemessene Tage am Stück ohne Störung.', achievedAt: null, seen: false },
    { id: 'all_fixed', title: 'Alle Befunde behoben', description: 'Kein gescanntes Projekt hat mehr einen offenen Befund.', achievedAt: null, seen: false },
    { id: 'night_shift', title: 'Nachtschicht', description: 'Ein Deploy zwischen 0 und 4 Uhr (Zürcher Zeit) von Hand gestartet.', achievedAt: variant === 'neu' ? ago(2 * MIN) : ago(9 * DAY), seen: variant !== 'neu' },
    { id: 'secrets', title: 'Geheimnisse gefunden', description: 'Alle versteckten Freischaltungen entdeckt.', achievedAt: null, seen: false },
  ] as import('@airlock/shared').AchievementDto[]
  return { achievements: list, enabled: true }
}

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
      dep(id, 5, { version: '51c0aa8e2d93', ...at(5 * HOUR, 26), status: 'failed', errorMessage: BUILD_FAILED, canRollback: false, seq: 5, reason: { kind: 'redeploy' }, actor: 'ui:joel', message: 'Bildvorschau mit sharp' }),
      dep(id, 4, { version: 'e04d17b6c2fa', ...at(26 * HOUR, 44), seq: 4, reason: { kind: 'auto_merge', detail: 'Upload-Grenze auf 20 MB' }, actor: 'system:auto-deploy', message: 'Upload-Grenze auf 20 MB' }),
      dep(id, 3, { version: '9be20c4d7f11', ...at(3 * DAY, 39), seq: 3, reason: { kind: 'headers', detail: 'X-Frame-Options' }, actor: 'ui:joel', message: 'Alben teilen per Link' }),
      dep(id, 2, { version: '9be20c4d7f11', ...at(4 * DAY, 41), seq: 2, reason: { kind: 'public', detail: null }, actor: 'ui:joel', message: 'Alben teilen per Link' }),
      dep(id, 1, { version: '9be20c4d7f11', ...at(9 * DAY, 52), seq: 1, reason: { kind: 'first' }, actor: 'mcp:claude-code-mac', message: 'Alben teilen per Link' }),
    ]
  }
  // Stimmig mit dem Projekt: ein neuerer, gescheiterter Deploy steht an seiner zeitlichen Stelle oben
  const newer = p.lastDeployment && p.lastDeployment.id !== active.id
    ? [{ ...p.lastDeployment, seq: 6, reason: { kind: 'code' as const, detail: 'Sensor-Intervall einstellbar' }, actor: 'mcp:claude-code-mac', message: 'Sensor-Intervall einstellbar' }]
    : []
  return [
    ...newer,
    { ...active, seq: 5, reason: { kind: 'redeploy' }, actor: 'ui:joel' },
    dep(id, 4, { version: same, ...at(9 * HOUR, 37), seq: 4, reason: { kind: 'paused' }, actor: 'token:backup-skript', canRollback: true }),
    dep(id, 3, { version: '9be20c4d7f11', ...at(2 * DAY, 41), status: 'failed', errorMessage: BUILD_FAILED, canRollback: false, seq: 3, reason: { kind: 'code', detail: 'Abhängigkeiten aktualisiert' }, actor: 'mcp:claude-code-mac' }),
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
  // Antwort 8: Bildarchiv (Speichergrenze 512 MB) läuft mit der alten Fassung knapp unter der Grenze
  const tight = id === 'p-fehler-oom'
  const samples = Array.from({ length: 60 }, (_, i) => ({
    at: new Date(Date.now() - (59 - i) * MIN).toISOString(),
    cpu: Math.round((0.12 + 0.08 * Math.sin(i / 5) + (i > 44 && i < 50 ? 0.35 : 0)) * 100) / 100,
    memMb: tight ? Math.round(402 + i * 1.5 + 8 * Math.sin(i / 4)) : Math.round(310 + 40 * Math.sin(i / 9) + i * 1.2),
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

/* --- Reiter «Aufbau» (wie GET /projects/:id/topology) ------------------------------- */

const LAN_IP = '192-168-0-31'
type Topo = import('@airlock/shared').TopologyDto
type TopoHost = Topo['hosts'][number]
type TopoService = Topo['services'][number]

const way = (w: 'public' | 'tailnet' | 'lan', on: boolean, detail: string | null, paused = false): Topo['access'][number] => ({ id: `way:${w}`, way: w, on, paused, detail })
const host = (hostname: string, o: Partial<TopoHost> = {}): TopoHost => ({
  id: `host:${hostname}`, hostname, url: `https://${hostname}`, ways: ['tailnet', 'lan'], fallback: false, headers: 4, tls: 'https', tlsProblem: null, accessProtected: false, paused: false, service: null, ...o,
})
const svc = (name: string, o: Partial<TopoService> = {}): TopoService => ({
  id: `svc:${name}`, name, image: null, port: null, state: 'running', health: null, exitCode: null, version: null, web: false, oneShot: false, database: null, usage: null, volumes: [], ...o,
})
const nip = (slug: string, service: string): TopoHost => host(`${slug}.${LAN_IP}.nip.io`, { url: `http://${slug}.${LAN_IP}.nip.io`, ways: ['lan'], fallback: true, tls: 'http', service })
/** Linien wie der Server: Zugang → Host, Host → Dienst; aus = gestrichelt */
const routeEdges = (access: Topo['access'], hosts: TopoHost[], up: boolean): Topo['edges'] => {
  const out: Topo['edges'] = []
  const main = hosts.find((h) => !h.fallback && !h.ways.includes('public'))
  for (const a of access) {
    const reached = hosts.filter((h) => h.ways.includes(a.way))
    if (reached.length) for (const h of reached) out.push({ from: a.id, to: h.id, on: a.on && !h.paused, via: 'route' })
    else if (main) out.push({ from: a.id, to: main.id, on: false, via: 'route' })
  }
  for (const h of hosts) if (h.service) out.push({ from: h.id, to: h.service, on: up && !h.paused, via: 'route' })
  return out
}

export function topology(id: string): Topo {
  const p = allProjects.find((x) => x.id === id) ?? projects[0]!
  const limits = { cpu: p.cpuLimit, memoryMb: p.memoryLimitMb }
  const lanCidr = '192.168.0.0/24'
  const tailCidr = '100.64.0.0/10'
  if (id === 'p-foto') {
    // Compose: Web, Worker, Postgres; Fotos-Volume geteilt, Daten der Datenbank im eigenen Volume
    const access = [way('public', false, null), way('tailnet', true, tailCidr), way('lan', true, lanCidr)]
    const hosts = [host('fotoalbum.int.example.ch', { headers: 5, service: 'svc:web' }), nip('fotoalbum', 'svc:web')]
    const services = [
      svc('web', { image: 'airlock/fotoalbum-web:a3f9c21d0be4', port: 8080, health: 'healthy', version: 'a3f9c21d0be4', web: true, usage: { cpu: 0.04, memMb: 160 }, volumes: ['vol:fotos'] }),
      svc('worker', { image: 'ghcr.io/example/fotoalbum-worker:1.4', version: '1.4', usage: { cpu: 0.04, memMb: 96 }, volumes: ['vol:fotos'] }),
      svc('db', { image: 'postgres:16-alpine', port: 5432, version: '16-alpine', database: 'postgres', usage: { cpu: 0.01, memMb: 220 }, volumes: ['vol:pgdata'] }),
    ]
    return {
      kind: 'compose', access, hosts, services, main: 'svc:web', limits,
      // Etappe 4: Git-Repo mit verbundener GitHub-App → Dienste über Pull Request
      edit: { way: 'pull_request', reason: null, changes: [], webService: 'web' },
      volumes: [
        { id: 'vol:fotos', name: 'fotos', mountPath: '/srv/fotos', sizeBytes: null, usedBy: ['svc:web', 'svc:worker'], paths: { 'svc:web': '/srv/fotos', 'svc:worker': '/data' } },
        { id: 'vol:pgdata', name: 'pgdata', mountPath: '/var/lib/postgresql/data', sizeBytes: null, usedBy: ['svc:db'], paths: { 'svc:db': '/var/lib/postgresql/data' } },
      ],
      edges: [
        ...routeEdges(access, hosts, true),
        { from: 'svc:web', to: 'svc:db', on: true, via: 'depends_on' },
        { from: 'svc:worker', to: 'svc:db', on: true, via: 'depends_on' },
        { from: 'svc:web', to: 'vol:fotos', on: true, via: 'mount' },
        { from: 'svc:worker', to: 'vol:fotos', on: true, via: 'mount' },
        { from: 'svc:db', to: 'vol:pgdata', on: true, via: 'mount' },
      ],
    }
  }
  if (p.runtimeKind === 'static') {
    // Statische Seite: Caddy liefert aus; Vereinsseite öffentlich pausiert, nur im Tailnet
    const pub = p.routes.find((r) => r.target === 'public')
    const internal = p.routes.find((r) => r.target !== 'public')!
    const ways = (internal.targets ?? [internal.target]) as ('tailnet' | 'lan')[]
    const access = [
      way('public', Boolean(pub) && !pub?.pausedAt, pub ? (pub.accessProtected ? 'Cloudflare Access' : 'Cloudflare Tunnel') : null, Boolean(pub?.pausedAt)),
      way('tailnet', ways.includes('tailnet'), tailCidr), way('lan', ways.includes('lan'), lanCidr),
    ]
    const s = `svc:${p.slug}`
    const hosts = [
      ...(pub ? [host(pub.hostname, { ways: ['public'], tls: 'cloudflare', paused: Boolean(pub.pausedAt), accessProtected: Boolean(pub.accessProtected), headers: 3, service: s })] : []),
      host(internal.hostname, { ways, headers: 3, service: s }),
    ]
    return {
      kind: 'static', access, hosts, main: s, limits, volumes: [],
      services: [svc(p.slug, { state: 'static', version: p.activeDeployment?.version ?? null, web: true })],
      edges: routeEdges(access, hosts, true),
    }
  }
  // Ein Container (Image oder Dockerfile)
  const failed = id === 'p-wetter'
  const stopped = p.desiredState !== 'running'
  const pub = p.routes.find((r) => r.target === 'public')
  const internal = p.routes.find((r) => r.target !== 'public')!
  const s = `svc:${p.slug}`
  const access = [
    way('public', Boolean(pub) && !pub?.pausedAt, pub ? (pub.accessProtected ? 'Cloudflare Access' : 'Cloudflare Tunnel') : null, Boolean(pub?.pausedAt)),
    way('tailnet', true, tailCidr), way('lan', true, lanCidr),
  ]
  const hosts = [
    ...(pub ? [host(pub.hostname, { ways: ['public'], tls: 'cloudflare', accessProtected: Boolean(pub.accessProtected), headers: 4, service: s })] : []),
    host(internal.hostname, { service: s }),
    nip(p.slug, s),
  ]
  const image = (p.source as { image?: string } | null)?.image ?? null
  const withData = id === 'p-haushalt'
  return {
    kind: p.runtimeKind, access, hosts, main: s, limits,
    services: [svc(p.slug, {
      image, port: p.port, web: true,
      version: p.runtimeKind === 'dockerfile' ? p.activeDeployment?.version ?? null : image?.split(':').at(-1) ?? null,
      state: failed ? 'exited' : stopped ? 'stopped' : 'running', exitCode: failed ? 1 : null,
      usage: failed || stopped ? null : { cpu: 0.12, memMb: 318 },
      volumes: withData ? ['vol:haushalt-daten'] : [],
    })],
    volumes: withData ? [{ id: 'vol:haushalt-daten', name: 'haushalt-daten', mountPath: '/data', sizeBytes: null, usedBy: [s], paths: { [s]: '/data' } }] : [],
    edges: [...routeEdges(access, hosts, !failed && !stopped), ...(withData ? [{ from: s, to: 'vol:haushalt-daten', on: true, via: 'mount' as const }] : [])],
  }
}

/* --- Etappe 4: Aufbau mit Live-Verkehr und «Dienst hinzufügen/entfernen» --------------- */

export type TopoVariant = 'chat' | 'ohne-github' | 'wird-erstellt' | 'pr-offen' | 'gescheitert' | 'adminer'

/** Varianten, in denen Fotoalbum als Chat-Projekt deployt (statt Pull Request) */
export const DEPLOY_VARIANTS: TopoVariant[] = ['chat', 'wird-erstellt', 'gescheitert']

type Change = import('@airlock/shared').ServiceChangeDto
const change = (o: Partial<Change>): Change => ({
  id: 'c-1', kind: 'add', service: 'cache', template: 'redis', status: 'deploying', deploymentId: 'p-foto-d9', prUrl: null, prNumber: null, note: null, createdAt: ago(40_000), ...o,
})

/** Aufbau von Fotoalbum in einem Zustand der Etappe 4 (sonst wie topology()) */
export function topologyVariant(id: string, v: TopoVariant): Topo {
  const t = topology(id)
  const edit = t.edit ?? { way: 'pull_request' as const, reason: null, changes: [], webService: 'web' }
  switch (v) {
    case 'chat':
      return { ...t, edit: { ...edit, way: 'deploy' } }
    case 'ohne-github':
      return { ...t, edit: { ...edit, way: null, reason: 'Bei Git-Projekten ändert Airlock die compose.yaml nur über einen Pull Request der GitHub-App – für dieses Repo ist sie nicht verbunden (Server › GitHub).' } }
    case 'wird-erstellt':
      // Chat-Projekt mit compose.yaml: «Übernehmen & deployen», Deploy läuft
      return { ...t, edit: { ...edit, way: 'deploy', changes: [change({})] } }
    case 'pr-offen':
      return { ...t, edit: { ...edit, changes: [change({ id: 'c-2', service: 'adminer', template: 'adminer', status: 'pr_open', deploymentId: null, prNumber: 12, prUrl: 'https://github.com/example/fotoalbum/pull/12', note: 'Pull Request #12 auf main' })] } }
    case 'gescheitert':
      return { ...t, edit: { ...edit, way: 'deploy', changes: [change({ status: 'failed', note: 'Der Deploy ist gescheitert; die vorherige Fassung läuft weiter. Details unter Deployments.' })] } }
    case 'adminer': {
      // Nach dem Merge: Adminer mit eigener interner Adresse (nur Tailnet und LAN)
      const h = host('adminer--fotoalbum.int.example.ch', { headers: 5, service: 'svc:adminer', internal: true })
      return {
        ...t,
        hosts: [...t.hosts, h],
        services: [...t.services.slice(0, 2), svc('adminer', { image: 'adminer:latest', port: 8080, version: 'latest', usage: { cpu: 0.01, memMb: 24 } }), ...t.services.slice(2)],
        edges: [
          ...t.edges,
          { from: 'way:tailnet', to: h.id, on: true, via: 'route' },
          { from: 'way:lan', to: h.id, on: true, via: 'route' },
          { from: h.id, to: 'svc:adminer', on: true, via: 'route' },
        ],
      }
    }
  }
}

/** Live-Strom von Fotoalbum: feste Anfragen der letzten Minute (Bilder ohne Animation, reduced-motion) */
export function trafficLive(): import('@airlock/shared').TrafficLiveEventDto[] {
  const at = new Date().toISOString()
  const e = (access: 'tailnet' | 'lan', host: string, status: number, n: number) =>
    Array.from({ length: n }, () => ({ at, access, host, service: 'web', status, blocked: false, bot: false }))
  return [
    ...e('tailnet', 'fotoalbum.int.example.ch', 200, 22),
    ...e('tailnet', 'fotoalbum.int.example.ch', 404, 2),
    ...e('lan', 'fotoalbum.int.example.ch', 200, 9),
    ...e('lan', 'fotoalbum.int.example.ch', 502, 1),
    ...e('lan', `fotoalbum.${LAN_IP}.nip.io`, 200, 3),
  ]
}

const FOTO_COMPOSE_DIFF = {
  addRedis: '--- a/compose.yaml\n+++ b/compose.yaml\n@@ -2,20 +2,37 @@\n   web:\n     build: .\n     expose: ["8080"]\n-    depends_on: [worker, db]\n+    depends_on: [worker, db, cache]\n     volumes:\n       - fotos:/srv/fotos\n   worker:\n     image: ghcr.io/example/fotoalbum-worker:1.4\n-    depends_on: [db]\n+    depends_on: [db, cache]\n     volumes:\n       - fotos:/data\n+    x-airlock-env:\n+      REDIS_URL: REDIS_URL\n   db:\n     image: postgres:16-alpine\n     environment:\n       POSTGRES_DB: fotoalbum\n     volumes:\n       - pgdata:/var/lib/postgresql/data\n+  cache:\n+    image: redis:7.4\n+    command:\n+      - sh\n+      - -c\n+      - exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"\n+    x-airlock-env:\n+      REDIS_PASSWORD: CACHE_PASSWORD\n+    healthcheck:\n+      test:\n+        - CMD-SHELL\n+        - redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG\n+      interval: 10s\n+      timeout: 5s\n+      retries: 5\n volumes:\n   fotos: {}\n   pgdata: {}',
  removeDb: '--- a/compose.yaml\n+++ b/compose.yaml\n@@ -2,20 +2,13 @@\n   web:\n     build: .\n     expose: ["8080"]\n-    depends_on: [worker, db]\n+    depends_on: [worker]\n     volumes:\n       - fotos:/srv/fotos\n   worker:\n     image: ghcr.io/example/fotoalbum-worker:1.4\n-    depends_on: [db]\n     volumes:\n       - fotos:/data\n-  db:\n-    image: postgres:16-alpine\n-    environment:\n-      POSTGRES_DB: fotoalbum\n-    volumes:\n-      - pgdata:/var/lib/postgresql/data\n volumes:\n   fotos: {}\n   pgdata: {}',
}

/** Vorschau (POST /projects/:id/services/plan) – Diffs wie die API sie für die compose.yaml von Fotoalbum erzeugt */
export function servicePlan(change: import('@airlock/shared').ServiceChangeInput, way: 'deploy' | 'pull_request' = 'pull_request'): import('@airlock/shared').ServicePlanDto {
  const base = { way, composePath: 'compose.yaml', base: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', branch: way === 'pull_request' ? 'main' : null }
  if (change.action === 'remove') {
    return {
      ...base, diff: FOTO_COMPOSE_DIFF.removeDb, variables: [], volumes: ['pgdata'],
      notes: [
        'depends_on von web, worker verweist nicht mehr auf «db».',
        'Volume «pgdata» bleibt mit allen Daten erhalten (im Aufbau als «nicht eingehängt»).',
        'Umgebungsvariablen des Dienstes (Passwörter, Verbindung) bleiben im Projekt; löschen unter Einstellungen › Umgebungsvariablen.',
      ],
    }
  }
  return {
    ...base, diff: FOTO_COMPOSE_DIFF.addRedis, volumes: [],
    variables: [
      { key: 'CACHE_PASSWORD', secret: true, state: 'new', purpose: 'Passwort von cache' },
      { key: 'REDIS_URL', secret: true, state: 'new', purpose: 'Verbindung für web, worker' },
    ],
    notes: [
      'Passwörter stehen nicht in der Datei: Airlock erzeugt sie und speichert sie als geheime Variablen des Projekts.',
      'Der Web-Dienst «web» bekommt alle Variablen des Projekts, also auch REDIS_URL.',
    ],
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
  const f = findingsFor(id)
  // Befunde je Werkzeug, damit Stufen-Anzeige und Befundliste übereinstimmen
  const by = (tool: string) => f.filter((x) => x.tool === tool).length
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
        'trivy-source': { ran: true, state: 'done', findings: by('trivy'), checks: CHECKS.trivySource, durationMs: 12_000 },
        headers: { ran: true, state: 'done', findings: by('header-check'), checks: CHECKS.headers, durationMs: 900 },
        'zap-baseline': { ran: true, state: 'done', findings: by('zap'), checks: CHECKS.zap, durationMs: 98_000 },
        nuclei: { ran: true, state: 'done', findings: by('nuclei'), checks: CHECKS.nuclei, durationMs: 41_000 },
      } : {
        'trivy-image': { ran: true, state: 'done', findings: by('trivy'), checks: CHECKS.trivyImage, durationMs: 98_000 },
        'trivy-source': { ran: false, state: 'skipped', note: 'kein Quellordner: fertiges Image ohne Quellcode', checks: CHECKS.trivySource },
        // M8: Header über Caddy geprüft
        headers: id === securityProjectId
          ? { ran: true, state: 'done', findings: by('header-check'), checks: CHECKS.headers, checked: 'über Caddy, wie Besucher die Seite sehen', durationMs: 1_200 }
          : { ran: true, state: 'done', findings: by('header-check'), checks: CHECKS.headers, durationMs: 1_200 },
        'zap-baseline': { ran: true, state: 'done', findings: by('zap'), checks: CHECKS.zap, durationMs: 142_000 },
        nuclei: { ran: true, state: 'done', findings: by('nuclei'), checks: CHECKS.nuclei, durationMs: 61_000 },
        testssl: { ran: false, state: 'skipped', note: 'TLS endet zentral bei Caddy, siehe Systemseite' },
      },
    },
    // Wie auf dem Server: dieselbe Zählung wie in der Projektübersicht
    counts: countOpenFindings(f),
    top: f.filter((x) => x.status === 'open').slice(0, 3).map(({ id: fid, severity, title, location, fix }) => ({ id: fid, severity, title, location, fix })),
    findings: f,
  }
}

/** Befunde des letzten abgeschlossenen Scans je Projekt */
/** Antwort 7: ZAP-Befund zur Qualität der CSP (Regel 10055) – nur in der Szene «security-csp-qualitaet» */
export const cspQualityFinding: FindingDto = {
  id: 'f10', tool: 'zap', severity: 'medium', title: 'CSP: Failure to Define Directive with No Fallback', location: 'https://kontoauszug-reader.int.example.ch/',
  description: 'Die Content-Security-Policy legt frame-ancestors nicht fest; für diese Direktive gilt default-src nicht.',
  fix: 'Die fehlende Direktive in der CSP ergänzen.', status: 'open', acceptReason: null,
}

/** Bericht mit dem CSP-Befund von ZAP (Zählung und Stufe passend) */
export function withCspQuality(r: ScanReportDto): ScanReportDto {
  const all = [...r.findings, cspQualityFinding]
  const zap = r.scan.stages['zap-baseline']
  return {
    ...r,
    scan: { ...r.scan, stages: zap ? { ...r.scan.stages, 'zap-baseline': { ...zap, findings: (zap.findings ?? 0) + 1 } } : r.scan.stages },
    counts: countOpenFindings(all),
    findings: all,
  }
}

function findingsFor(id: string): FindingDto[] {
  return id === securityProjectId ? findings : id === 'p-hallo' ? halloFindings : id === 'p-foto' ? [] : findings.slice(5)
}

// Stimmig wie auf dem Server: Die Kurzform am Projekt (security.open) zählt dieselben Befunde wie der Bericht
for (const p of allProjects) {
  if (p.security) p.security = { ...p.security, open: countOpenFindings(findingsFor(p.id)) }
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

/**
 * Audit-Log. hallo-welt zeigt den Ablauf der Referenz «Aktivität»: Header
 * gesetzt + Nachprüfung, pausiert + Pause-Seite angepasst, wieder öffentlich,
 * vier Header auf einmal, Scan über MCP; dazu ein unbekannter Typ
 * («deploy.failed») und Anmeldungen für das globale Log.
 */
export function audit(targetId?: string): AuditEventDto[] {
  const C = 'token:claude-code-mac'
  const H = 'p-hallo'
  const hh = 'hallo-welt.example.ch'
  type Row = [number, string, string, string | null, 'ok' | 'error', string | null, Record<string, unknown>?]
  const rows: Row[] = [
    [3 * MIN, 'ui:joel', 'scan.recheck_headers', H, 'ok', null, { scan: 's9', fixed: ['Strict-Transport-Security fehlt'], opened: [], before: 93, after: 96, grade: 'A' }],
    [3 * MIN + 20_000, 'ui:joel', 'header.set', H, 'ok', null, { header: 'strict-transport-security', mode: 'enforce' }],
    [4 * MIN, 'ui:joel', 'project.deploy', 'p-rezepte', 'ok', null, { deployment: 'x' }],
    [9 * MIN, 'ui:joel', 'auth.login', null, 'ok', null],
    [13 * MIN, 'ui:joel', 'project.public.resume', H, 'ok', null, { hostname: hh, pausedSince: ago(17 * MIN) }],
    [13 * MIN + 30_000, 'system', 'deploy.failed', 'p-wetter', 'error', 'Umgebungsvariable SENSOR_URL fehlt (Healthcheck nicht bestanden)'],
    // Antwort 11: Benachrichtigungen als Ereignisse (Glocke)
    [13 * MIN + 29_000, 'system', 'notify.deploy_failed', 'p-wetter', 'ok', null, { title: 'Deploy fehlgeschlagen: Wetterstation', body: 'Umgebungsvariable SENSOR_URL fehlt (Healthcheck nicht bestanden)\nDie vorherige Fassung läuft weiter.' }],
    [50 * MIN, 'system', 'notify.gateway_warning', 'notify', 'ok', null, { title: 'Anfragen über das Docker-Gateway', body: 'In den letzten 30 Minuten kamen 9 von 14 fremden Anfragen auf Airlock von 172.20.0.1.' }],
    [3 * HOUR - 1_000, 'system', 'notify.finding_critical', 'p-kontoauszug', 'ok', null, { title: '1 neuer kritischer Befund: Kontoauszug-Reader', body: '• Veraltete Bibliothek mit bekannter Lücke (package-lock.json)' }],
    [6 * HOUR, 'system', 'notify.expiry', H, 'ok', null, { title: 'hallo-welt läuft am 18.11.2026 ab', body: 'Ohne Änderung wird das Chat-Projekt am 18.11.2026 gestoppt.' }],
    [14 * MIN, 'ui:joel', 'project.public.pause_page', H, 'ok', null, { custom: 'Kurz in Wartung', backAt: null }],
    [17 * MIN, 'ui:joel', 'project.public.pause', H, 'ok', null, { hostname: hh }],
    [32 * MIN, 'ui:joel', 'scan.recheck_headers', H, 'ok', null, { scan: 's9', fixed: ['Schutz gegen Einbetten fehlt'], opened: [], before: 90, after: 93, grade: 'A' }],
    [32 * MIN + 10_000, 'ui:joel', 'header.set', H, 'ok', null, { header: 'referrer-policy', mode: 'enforce' }],
    [32 * MIN + 20_000, 'ui:joel', 'header.set', H, 'ok', null, { header: 'x-content-type-options', mode: 'enforce' }],
    [32 * MIN + 30_000, 'ui:joel', 'header.set', H, 'ok', null, { header: 'frame-ancestors', mode: 'enforce' }],
    [32 * MIN + 40_000, 'ui:joel', 'header.set', H, 'ok', null, { header: 'content-security-policy', mode: 'report-only' }],
    [33 * MIN, 'system', 'scan.done', H, 'ok', null, { scan: 's9', level: 'standard', score: 90, grade: 'A', open: 4, durationMs: 7 * MIN }],
    [40 * MIN, 'ip:192.168.1.77', 'auth.login', null, 'error', 'falsches Passwort'],
    [40 * MIN, C, 'mcp.run_scan', H, 'ok', null, { project: 'hallo-welt' }],
    [40 * MIN + 2_000, C, 'scan.start', H, 'ok', null, { scan: 's9', level: 'standard' }],
    [62 * MIN, C, 'mcp.get_project', H, 'ok', null, { project: 'hallo-welt' }],
    [70 * MIN, 'ui:joel', 'auth.login', null, 'ok', null],
    [2 * HOUR, 'ui:joel', 'project.deploy', 'p-foto', 'ok', null, { deployment: 'p-foto-d0' }],
    [26 * HOUR, 'system', 'scan.done', H, 'ok', null, { scan: 's8', level: 'standard', score: 86, grade: 'B', open: 5, durationMs: 6 * MIN }],
    [26 * HOUR + 6 * MIN, 'system', 'scan.start', H, 'ok', null, { scan: 's8', level: 'standard' }],
    [26 * HOUR + 6 * MIN + 1_000, C, 'project.deploy', H, 'ok', null, { deployment: 'p-hallo-d1' }],
    [26 * HOUR + 6 * MIN + 5_000, C, 'mcp.create_project', H, 'ok', null, { name: 'hallo-welt' }],
    [26 * HOUR + 6 * MIN + 6_000, C, 'files.init', H, 'ok', null, { files: ['index.html', 'style.css', 'app.js'], commit: '5a19cd4e8b21' }],
    [3 * HOUR, 'system', 'scan.done', 'p-kontoauszug', 'ok', null, { scan: 'k1', level: 'standard', score: 38, grade: 'D', open: 9, durationMs: 11 * MIN }],
    [4 * HOUR, 'ui:joel', 'auth.login', null, 'ok', null],
    [5 * HOUR, C, 'project.env.replace', 'p-haushalt', 'ok', null, { keys: ['DATABASE_URL', 'SESSION_SECRET'] }],
    [7 * HOUR, 'ui:joel', 'auth.login', null, 'ok', null],
    [27 * HOUR, 'ui:joel', 'cloudflare.tls', 'cloudflare', 'ok', null],
  ]
  return rows
    .filter((r) => !targetId || r[3] === targetId)
    .sort((a, b) => a[0] - b[0])
    .map(([t, actor, action, tid, result, error, params], i) => {
      // M9: Anmeldungen sind Server-Ereignisse (in jeder Umgebung sichtbar, markiert)
      const isServer = action.startsWith('auth.')
      return {
        id: String(200 - i), at: ago(t), actor, action, targetType: tid?.startsWith('p-') ? 'project' : 'system', targetId: tid, paramsMasked: params ?? {}, result, error,
        environmentId: isServer ? null : 'env-example', server: isServer,
      }
    })
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
  clientIps: {
    total: 14, fromGateway: 9, gatewayIps: ['172.20.0.1'], gatewayOnly: false, blocked: 9, since: ago(30 * MIN), ownProbes: 31,
    groups: [
      { source: 'server', count: 6, blocked: 6, hosts: ['deployer.int.example.ch'], paths: ['GET /health', 'GET /api/v1/system/status'], userAgents: ['curl/8.5.0'], last: ago(2 * MIN) },
      { source: 'tailnet', count: 3, blocked: 3, hosts: ['deployer.int.example.ch'], paths: ['GET /projekte', 'GET /api/v1/projects'], userAgents: ['Safari 18'], last: ago(9 * MIN) },
    ],
  },
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

export const domains: { domains: DomainDto[]; publicEnabled: boolean } = { domains: [{ id: 'd1', name: 'example.ch', zoneId: 'z1', isDefault: true }], publicEnabled: true }

/** Umgebung mit zwei Zonen (Auswahl der Domain im Feld «Öffentliche Adresse») */
export const domainsTwo: { domains: DomainDto[]; publicEnabled: boolean } = {
  domains: [{ id: 'd1', name: 'example.ch', zoneId: 'z1', isDefault: true }, { id: 'd4', name: 'example.org', zoneId: 'z4', isDefault: false }],
  publicEnabled: true,
}

/**
 * Prüfung eines öffentlichen Namens (GET …/public/check), wie die API:
 * reserviert (int, deployer, airlock, acme-probe …), in Airlock vergeben
 * (öffentliche Routen der Fixtures), fremder DNS-Eintrag («alt»), Worker
 * bzw. Custom Domain (direkt unter example.org), sonst frei.
 */
export function publicCheck(projectId: string | null, name: string, zone: string, apex: boolean): PublicNameCheckDto {
  const zones = domainsTwo.domains.map((d) => d.name)
  const label = apex ? '' : normalizePublicLabel(name)
  const host = apex ? zone : label ? `${label}.${zone}` : null
  const out: PublicNameCheckDto = { host, label, zone, apex, zones, problems: [], existing: null }
  if (!host) return { ...out, problems: [{ kind: 'format', message: 'Gib einen Namen an, z.B. solar' }] }
  if (!apex && (RESERVED_PUBLIC_LABELS as readonly string[]).includes(label)) out.problems.push({ kind: 'reserved', message: `«${label}» ist reserviert` })
  const owner = allProjects.find((p) => p.routes.some((r) => r.target === 'public' && r.hostname === host))
  if (owner && owner.id !== projectId) out.problems.push({ kind: 'taken', message: `${host} ist in Airlock schon vergeben` })
  if (label === 'alt') {
    out.existing = { type: 'CNAME', content: 'alter-server.example.net', worker: false }
    out.problems.push({ kind: 'dns', message: `Für ${host} gibt es bei Cloudflare schon einen Eintrag (CNAME → alter-server.example.net), der nicht von Airlock stammt` })
  }
  if (apex && zone === 'example.org') {
    out.existing = { type: 'AAAA', content: '100::', worker: true }
    out.problems.push({ kind: 'dns', message: `Für ${host} gibt es bei Cloudflare schon einen Worker bzw. eine Custom Domain` })
  }
  return out
}

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
    backup_failed: { push: true, email: true },
    backup_stale: { push: true, email: true },
    gateway_warning: { push: false, email: false },
  },
}


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

/** Zugriffs-Log einer statischen Seite (Reiter «Zugriffe») */
export function siteAccess(id: string) {
  if (id !== 'p-hallo') return { entries: [], since: ago(DAY), error: null }
  const rows: [number, string, string, number, number, string][] = [
    [12_000, 'GET', '/', 200, 1.4, '84.72.10.x'],
    [12_400, 'GET', '/style.css', 200, 0.6, '84.72.10.x'],
    [12_500, 'GET', '/app.js', 200, 0.5, '84.72.10.x'],
    [13_000, 'GET', '/favicon.ico', 404, 0.3, '84.72.10.x'],
    [4 * MIN, 'GET', '/', 200, 1.1, '100.88.41.x'],
    [9 * MIN, 'HEAD', '/', 200, 0.4, '172.25.0.x'],
    [26 * MIN, 'GET', '/wp-login.php', 404, 0.2, '45.155.205.x'],
    [26 * MIN + 2_000, 'GET', '/.env', 404, 0.2, '45.155.205.x'],
    [47 * MIN, 'GET', '/alt', 301, 0.3, '2a02:1210:4e3a:…'],
    [2 * HOUR, 'POST', '/', 405, 0.4, '193.32.249.x'],
    [3 * HOUR, 'GET', '/', 200, 1.6, '2a02:1210:4e3a:…'],
  ]
  return { entries: rows.map(([t, method, path, status, durationMs, ip]) => ({ at: ago(t), method, path, status, durationMs, bytes: null, ip, host: 'hallo-welt.example.ch' })), since: ago(DAY), error: null }
}

/**
 * UI-Qualität 4: Zeilen des Reiters «Logs» (wie GET /log-lines). Fotoalbum ist
 * ein Compose-Projekt mit drei Diensten; andere Projekte haben einen Container.
 */
export function logLines(id: string, service: string | null): import('@airlock/shared').LogLinesDto {
  const compose = id === 'p-foto'
  // Wetterstation: in der Zeitspanne still (leerer Zustand)
  if (id === 'p-wetter') return { lines: [], services: [], hint: null }
  // Notizen ist gestoppt: kein laufender Container (wie der Server)
  if (id === 'p-notizen') return { lines: [], services: [], hint: 'Kein laufender Container – es gibt noch keine Ausgabe.' }
  const rows: [number, string | null, string][] = [
    [14 * MIN, 'db', 'LOG:  database system is ready to accept connections'],
    [14 * MIN - 2_000, 'web', 'Server listening at http://0.0.0.0:8080'],
    [14 * MIN - 2_100, 'worker', 'Vorschau-Warteschlange verbunden (redis:6379)'],
    [11 * MIN, 'web', 'GET /api/albums 200 12 ms'],
    [11 * MIN - 3_000, 'web', 'GET /api/albums/41/photos?page=2 200 38 ms'],
    [9 * MIN, 'web', 'POST /api/upload 201 412 ms (3 Dateien, 11,4 MB)'],
    [9 * MIN - 1_000, 'worker', 'Vorschaubilder: 3 in Warteschlange'],
    [9 * MIN - 5_000, 'worker', 'WARN Vorschau IMG_4412.HEIC: Format ohne Farbprofil, sRGB angenommen'],
    [9 * MIN - 6_000, 'worker', 'Vorschaubilder fertig (2,1 s)'],
    [6 * MIN, 'db', 'LOG:  checkpoint complete: wrote 412 buffers (2.5%)'],
    [4 * MIN, 'web', 'GET /api/albums/7 404 3 ms'],
    [3 * MIN, 'worker', 'ERROR Vorschau IMG_5120.MOV: Video wird nicht unterstützt, übersprungen'],
    [2 * MIN, 'web', 'GET /health 200 1 ms'],
    [40_000, 'web', 'GET /api/albums 200 9 ms'],
  ]
  const lines = rows
    .filter(([, s]) => !service || s === service)
    .map(([t, s, text]) => ({ at: ago(t), service: compose ? s : null, text, level: (/\bERROR\b/.test(text) ? 'error' : /\bWARN\b/.test(text) ? 'warn' : null) as import('@airlock/shared').LogLevel | null }))
  return { lines, services: compose ? ['db', 'web', 'worker'] : [], hint: null }
}

/** UI-Qualität 5: Vorschau von Kurzname und Adresse (wie GET /projects/name-preview) */
export function namePreview(name: string): import('@airlock/shared').NamePreviewDto {
  const wanted = slugify(name)
  if (!wanted) return { wanted: '', slug: '', takenBy: null, reserved: false, host: null, urls: [] }
  const owner = allProjects.find((p) => p.slug === wanted) ?? null
  const reserved = (RESERVED_SLUGS as readonly string[]).includes(wanted)
  const slug = owner || reserved ? `${wanted.slice(0, 37)}-2` : wanted
  const host = `${slug}.${BASE}`
  return { wanted, slug, takenBy: owner ? { id: owner.id, name: owner.name } : null, reserved, host, urls: [`https://${host}`] }
}

/** Dateien eines Chat-Projekts (Eckdaten «Inhalt», Dialog «Dateien ansehen») */
export function files(id: string): { commit: string | null; files: { path: string; size: number }[] } {
  if (id !== 'p-hallo') return { commit: null, files: [] }
  return { commit: '5a19cd4e8b21', files: [{ path: 'index.html', size: 1_840 }, { path: 'style.css', size: 1_310 }, { path: 'app.js', size: 912 }] }
}

export function env(id: string) {
  return id === detailProjectId
    ? [
        { key: 'DATABASE_URL', isSecret: true, value: null },
        { key: 'THUMBNAIL_SIZE', isSecret: false, value: '480' },
        { key: 'TZ', isSecret: false, value: 'Europe/Zurich' },
      ]
    : []
}

/* --- M9: Umgebungen ------------------------------------------------------------------ */

/** «example.ch» steht für die heutige Installation; «Verein» und «Labor» sind erfunden. */
export const environments: EnvironmentDto[] = [
  {
    id: 'env-example', slug: 'example', name: 'example.ch', short: 'EX', isDefault: true, zone: 'example.ch', baseDomain: BASE,
    projects: 7, critical: 1, internalPrefix: 'int', account: { name: 'Privat', sharedWith: ['Labor'] }, tlsPhase: 'done',
    accessDefault: false, accessEmails: ['hallo@example.ch'], notifyMuted: false, externalTargets: 2,
  },
  {
    id: 'env-verein', slug: 'verein', name: 'Verein', short: 'VB', isDefault: false, zone: 'verein-beispiel.ch', baseDomain: 'int.verein-beispiel.ch',
    projects: 2, critical: 0, internalPrefix: 'int', account: { name: 'Vereinskonto', sharedWith: [] }, tlsPhase: 'done',
    accessDefault: true, accessEmails: ['vorstand@verein-beispiel.ch'], notifyMuted: false, externalTargets: 0,
  },
  {
    id: 'env-labor', slug: 'labor', name: 'Labor', short: 'LA', isDefault: false, zone: null, baseDomain: null,
    projects: 0, critical: 0, internalPrefix: 'int', account: { name: 'Privat', sharedWith: ['example.ch'] }, tlsPhase: 'off',
    accessDefault: false, accessEmails: [], notifyMuted: false, externalTargets: 0,
  },
]

export const headerTemplates: HeaderTemplateDto[] = [
  { header: 'x-content-type-options', value: 'nosniff', mode: 'enforce', appliesTo: 7, projects: 7, overriddenBy: [] },
  { header: 'referrer-policy', value: 'strict-origin-when-cross-origin', mode: 'enforce', appliesTo: 6, projects: 7, overriddenBy: [{ project: 'Fotoalbum', mode: 'own' }] },
  { header: 'frame-ancestors', value: "'self'", mode: 'enforce', appliesTo: 6, projects: 7, overriddenBy: [{ project: 'Vereinsseite', mode: 'off' }] },
]

export const lanDns: LanDnsCheckDto = {
  baseDomain: BASE, line: `*.${BASE} → 192.168.1.20`, expected: '192.168.1.20', resolved: ['192.168.1.20'], ok: true,
  detail: `Umschreibung greift: ${BASE} → 192.168.1.20`,
}

/** Labor im Assistenten: verbunden über das Token von example.ch, noch ohne Zone */
export const cloudflareLabor: CfStatusDto = {
  ...cloudflare,
  // Nur die freie Zone des geteilten Kontos (example.ch ist Hauptzone von «example.ch»)
  zones: [{ id: 'z3', name: 'example.dev', isDefault: false }],
  baseDomain: null, defaultZone: null, tunnelSkipped: false, publicProjects: 0,
  tls: { ...cloudflare.tls, enabled: false, phase: 'off', steps: [], startedAt: null },
}

export function movePreview(id: string, to: string): MovePreviewDto {
  const p = allProjects.find((x) => x.id === id) ?? projects[0]!
  const target = environments.find((e) => e.slug === to) ?? environments[1]!
  const internal = p.routes.find((r) => r.target !== 'public')
  const pub = p.routes.find((r) => r.target === 'public')
  return {
    from: { id: 'env-example', name: 'example.ch', slug: 'example' },
    to: { id: target.id, name: target.name, slug: target.slug },
    internal: internal ? { from: internal.hostname, to: `${p.slug}.${target.baseDomain}`, redirectDays: 30 } : null,
    public: pub ? { hostname: pub.hostname, paused: Boolean(pub.pausedAt), pendingRequest: false } : null,
    headers: [{ header: 'referrer-policy', from: 'strict-origin-when-cross-origin', to: 'no-referrer' }],
    tokensLosingAccess: ['Claude Code Mac', 'Backup-Skript'],
    blocked: null,
  }
}

/* --- Meilenstein Backup: Server › Backup ------------------------------------------- */

export type BackupVariant = 'ok' | 'leer' | 'veraltet'

/** Ein Lauf heute Nacht um 03:30 (vor `h` Stunden) */
function backupRun(id: string, h: number, patch: Partial<BackupRunDto> = {}): BackupRunDto {
  const secs = patch.durationMs !== undefined && patch.durationMs !== null ? patch.durationMs / 1000 : 94
  return {
    id, trigger: 'schedule', actor: 'system', status: 'ok',
    startedAt: ago(h * HOUR), finishedAt: new Date(Date.now() - h * HOUR + secs * 1000).toISOString(), durationMs: secs * 1000,
    snapshotId: `${id}9f3c2a7b1e04d5c6a8b9`, bytesNew: 38_400_000, bytesTotal: 2_310_000_000, filesNew: 214, error: null, warnings: [],
    ...patch,
  }
}

const backupSettings: BackupSettingsDto = {
  configured: true, enabled: true,
  target: { kind: 's3', endpoint: 'https://s3.eu-central-003.backblazeb2.com', bucket: 'heimserver-backup', prefix: 'airlock', region: 'eu-central-003', hasAccessKey: true, hasSecretKey: true },
  hasPassword: true, time: '03:30', timeZone: 'Europe/Zurich', retention: { daily: 7, weekly: 4, monthly: 6 },
  projects: { fotoalbum: 'stop' }, repositoryCheckedAt: ago(9 * HOUR), lastCheckAt: ago(3 * DAY + 9 * HOUR),
}

const backupProjects = [
  { slug: 'fotoalbum', name: 'Fotoalbum', environment: 'example.ch', sourceType: 'compose' },
  { slug: 'hallo-welt', name: 'hallo-welt', environment: 'example.ch', sourceType: 'files' },
  { slug: 'kontoauszug-reader', name: 'Kontoauszug-Reader', environment: 'example.ch', sourceType: 'compose' },
  { slug: 'vereinsseite', name: 'Vereinsseite', environment: 'Verein', sourceType: 'files' },
]

/** Etappe 5: Vorschau eines Restores (Fotoalbum aus dem neuesten Stand) */
export function backupRestorePreview(snapshot: string, project: string): BackupRestorePreviewDto {
  const sn = backupSnapshots.find((s) => s.id === snapshot) ?? backupSnapshots[0]!
  const p = backupProjects.find((x) => x.slug === project) ?? backupProjects[0]!
  return {
    snapshot: { id: sn.id, shortId: sn.shortId, time: sn.time },
    project: { id: `p-${p.slug}`, slug: p.slug, name: p.name },
    parts: p.sourceType === 'compose'
      ? [{ kind: 'volume', name: 'db', files: 1_284, bytes: 412_000_000 }, { kind: 'volume', name: 'fotos', files: 18_032, bytes: 1_610_000_000 }]
      : [{ kind: 'site', name: p.slug, files: 14, bytes: 220_000 }, { kind: 'repo', name: p.slug, files: 41, bytes: 96_000 }],
    truncated: false,
    runningContainers: p.sourceType === 'compose' ? 2 : 0,
  }
}

/* Etappe 4: Beispielschlüssel (SHA-256 eines festen Texts, kein echter Schlüssel) mit QR-Code */
const KEY_FP = '48b9 3c72 cbcd 952a'

export const backupKeyPaper: BackupKeyPaperDto = {
  key: '81EyJIF+4mh3B3VTk212SOgni4OEXGrY0h5FovCo8zU=', // allowlist-secret: Beispielwert für Screenshots
  hex: ['f351', '3224', '817e', 'e268', '7707', '7553', '936d', '7648', 'e827', '8b83', '845c', '6ad8', 'd21e', '45a2', 'f0a8', 'f335'],
  fingerprint: KEY_FP,
  sha256: '48b93c72cbcd952ac496af32992e2b85c701706668e82b195f9b8138f867e4dd',
  qr: [
    '111111101100110111101011101111111', '100000101111110000100111001000001', '101110100110000011000111001011101', '101110101010001010001110101011101',
    '101110100110001000001001001011101', '100000100100001001111110101000001', '111111101010101010101010101111111', '000000001011100001101011100000000',
    '101101110001001001111001001001011', '111111010011101110101110001100101', '001010111100001011001001101010011', '000110010101011000100001001111010',
    '010101100111000100100100010100100', '011000001111000011100010000101110', '011110101101111111100100111000010', '110101010110001010011100011000100',
    '001011111100110100110011101000100', '001011011100011001000101001111001', '110111110111111111001010111001100', '010000010101011110001101010010011',
    '001111110111100100111001110101111', '110111011011110101100100011001111', '000110111010011010100011011110001', '011011011110100010010011010101010',
    '101010100101000101001011111110111', '000000001110011011011001100011111', '111111101100000010010011101011000', '100000101010000110010111100011101',
    '101110100010011001001001111111001', '101110101001001001111101000011011', '101110101010000000110001001000000', '100000100010100111110010100010001',
    '111111101010010101001111010000100',
  ],
  server: 'heimserver',
  createdAt: ago(0),
}

export function backupStatus(v: BackupVariant): BackupStatusDto {
  if (v === 'leer') {
    return {
      settings: { ...backupSettings, configured: false, target: null, hasPassword: false, projects: {}, repositoryCheckedAt: null, lastCheckAt: null },
      projects: backupProjects, key: { fingerprint: KEY_FP, savedAt: null, method: null }, restore: null,
      running: false, lastRun: null, lastSuccessAt: null, stale: false, nextRunAt: null, runs: [],
    }
  }
  const runs = v === 'veraltet'
    ? [
        backupRun('r5', 9, { status: 'failed', snapshotId: null, bytesNew: null, bytesTotal: null, filesNew: null, durationMs: 31_000, error: 'Repository nicht erreichbar (Exit 1): Fatal: unable to open repository: dial tcp: lookup s3.eu-central-003.backblazeb2.com: no such host' }),
        backupRun('r4', 33, { status: 'failed', snapshotId: null, bytesNew: null, bytesTotal: null, filesNew: null, durationMs: 30_000, error: 'Repository nicht erreichbar (Exit 1): Fatal: unable to open repository: dial tcp: i/o timeout' }),
        backupRun('r3', 57),
      ]
    : [
        backupRun('r5', 9, { warnings: ['fotoalbum: ein Deploy lief gerade – Volumes live statt gestoppt gesichert'], status: 'warning' }),
        backupRun('r4', 33, { bytesNew: 12_900_000, durationMs: 81_000 }),
        backupRun('r3', 57, { bytesNew: 41_200_000, durationMs: 102_000 }),
        backupRun('r2', 70, { trigger: 'manual', actor: 'ui:joel', bytesNew: 1_880_000_000, bytesTotal: 2_290_000_000, durationMs: 742_000, filesNew: 18_312 }),
      ]
  const lastOk = runs.find((r) => r.status !== 'failed')!
  return {
    settings: backupSettings,
    projects: backupProjects,
    key: { fingerprint: KEY_FP, savedAt: ago(12 * DAY), method: 'file' },
    restore: null,
    running: false,
    lastRun: runs[0]!,
    lastSuccessAt: lastOk.finishedAt,
    stale: v === 'veraltet',
    nextRunAt: new Date(Date.now() + 15 * HOUR).toISOString(),
    runs,
  }
}

export const backupSnapshots: BackupSnapshotDto[] = [9, 33, 57, 70, 30 * 24].map((h, i) => ({
  id: `${['3f9c2a7b', 'a81d0c55', '5be4f019', 'c0d7e2a6', '7e19b4d3'][i]}e04d5c6a8b9f3c2a7b1e04d5c6a8b9f3c2a7b1e04d5c6a8b9f3c2a`,
  shortId: ['3f9c2a7b', 'a81d0c55', '5be4f019', 'c0d7e2a6', '7e19b4d3'][i]!,
  time: ago(h * HOUR),
  tags: ['airlock', 'airlock-0.1.0', 'env-example', ...(i < 2 ? ['env-verein'] : [])],
  paths: ['/staging/db', '/staging/volumes', '/source/caddy_data', '/source/sites', '/source/data'],
  bytesTotal: i === 4 ? 2_150_000_000 : 2_310_000_000 - i * 9_000_000,
}))

/* --- Etappe 3: Besucher ----------------------------------------------------------------
 * Erfundene, aber plausible Zahlen einer kleinen öffentlichen Seite (hallo-welt) und eines
 * internen Projekts (Fotoalbum: nur Tailnet und Heimnetz, also ohne Länder). Deterministisch
 * (keine Zufallszahlen), damit die Referenzbilder stabil bleiben.
 */

export type TrafficVariant = 'ok' | 'staedte' | 'leer' | 'wartet' | 'aus'

/** Tagesverlauf (Ortszeit-Stunde → Gewicht): nachts wenig, abends am meisten */
const HOUR_SHAPE = [2, 1, 1, 1, 1, 2, 4, 7, 9, 10, 10, 11, 12, 11, 10, 10, 11, 13, 15, 16, 14, 11, 7, 4]
/** Wochentag-Schwankung, fest */
const DAY_SHAPE = [0.92, 1.04, 1.1, 0.97, 1.21, 0.78, 0.71]

export function traffic(id: string, range: TrafficRange, way: TrafficWay | 'all', v: TrafficVariant = 'ok'): TrafficSummaryDto {
  const r = TRAFFIC_RANGES.find((x) => x.key === range)!
  const internal = id !== 'p-hallo' && id !== 'p-haushalt'
  // Anteile je Zugang (intern: kein Internet)
  const share: Record<TrafficWay, number> = internal ? { public: 0, tailnet: 0.7, lan: 0.3 } : { public: 0.93, tailnet: 0.05, lan: 0.02 }
  const perDay = v === 'leer' ? 0 : internal ? 46 : 280
  const f = way === 'all' ? 1 : share[way]
  const now = Date.now()
  const series: TrafficPointDto[] = []
  if (r.bucket === 'hour') {
    const h0 = Math.floor(now / HOUR) * HOUR
    for (let i = 23; i >= 0; i--) {
      const at = h0 - i * HOUR
      const local = new Date(at).getHours()
      const views = Math.round((perDay * f * HOUR_SHAPE[local]!) / 206 * (1 + ((i * 7) % 5) / 10))
      series.push({ at: new Date(at).toISOString(), views, visitors: Math.round(views * 0.42) })
    }
  } else {
    const days = r.hours / 24
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const growth = 0.75 + (0.25 * (days - i)) / days
      const views = Math.round(perDay * f * DAY_SHAPE[d.getDay()]! * growth * (i === 0 ? 0.6 : 1))
      series.push({ at: d.toISOString(), views, visitors: Math.round(views * 0.38) })
    }
  }
  const views = series.reduce((a, p) => a + p.views, 0)
  const visitors = series.reduce((a, p) => a + p.visitors, 0)
  const rows = (list: [string, number][]): TrafficRowDto[] => list.map(([key, p]) => ({ key, views: Math.round(views * p), visitors: Math.round(visitors * p) })).filter((x) => x.views > 0)
  const pages = internal
    ? rows([['/', 0.38], ['/alben/sommer-2026', 0.21], ['/alben/hochzeit', 0.14], ['/suche', 0.11], ['/alben/neu', 0.08], ['/einstellungen', 0.05], ['/alt/galerie', 0.03]])
    : rows([['/', 0.41], ['/blog/homeserver-mit-airlock', 0.22], ['/blog/caddy-und-tailscale', 0.12], ['/projekte', 0.09], ['/kontakt', 0.06], ['/impressum', 0.04], ['/feed.xml', 0.03], ['/wp-login.php', 0.02]])
  const referrers = internal
    ? rows([['', 0.97], ['nas.int.example.ch', 0.03]])
    : rows([['', 0.46], ['google.com', 0.24], ['news.ycombinator.com', 0.11], ['duckduckgo.com', 0.07], ['github.com', 0.05], ['newsletter', 0.04], ['linkedin.com', 0.03]])
  const showCountries = !internal && (way === 'all' || way === 'public')
  const pub = Math.round(views * (way === 'all' ? share.public : 1))
  const cRows = (list: [string, number][]): TrafficRowDto[] => list.map(([key, p]) => ({ key, views: Math.round(pub * p), visitors: Math.round(pub * p * 0.4) })).filter((x) => x.views > 0)
  const countries = showCountries
    ? cRows([['CH', 0.48], ['DE', 0.19], ['US', 0.09], ['AT', 0.06], ['FR', 0.04], ['NL', 0.03], ['GB', 0.03], ['IT', 0.02], ['SE', 0.015], ['CA', 0.012], ['JP', 0.01], ['BR', 0.008], ['IN', 0.006], ['AU', 0.005], ['', 0.004]])
    : []
  const cities = showCountries && v === 'staedte'
    ? cRows([['Zürich', 0.17], ['Bern', 0.08], ['Berlin', 0.07], ['Basel', 0.06], ['Wien', 0.05], ['Luzern', 0.04], ['München', 0.04], ['St. Gallen', 0.03], ['Winterthur', 0.03], ['Hamburg', 0.02]])
      .map((c) => ({ ...c, country: ({ Berlin: 'DE', München: 'DE', Hamburg: 'DE', Wien: 'AT' } as Record<string, string>)[c.key] ?? 'CH' }))
    : []
  const ways = TRAFFIC_WAYS.map((w) => {
    const total = views / f
    return { way: w, views: Math.round(total * share[w]), visitors: Math.round(total * share[w] * 0.38) }
  })
  // Gesamt: Summe der Wege gleich der angezeigten Summe (Rundung dem grössten Weg zuschlagen)
  if (way === 'all') ways[internal ? 1 : 0]!.views += views - ways.reduce((a, w) => a + w.views, 0)
  return {
    range, way,
    from: series[0]?.at ?? new Date(now).toISOString(),
    to: new Date(now).toISOString(),
    bucket: r.bucket,
    totals: { views, visitors, bots: v === 'leer' ? 0 : Math.round(views * (internal ? 0.1 : 0.62)) },
    ways: v === 'leer' ? ways.map((w) => ({ ...w, views: 0, visitors: 0 })) : ways,
    series,
    pages, referrers, countries, cities,
    devices: rows([['desktop', internal ? 0.44 : 0.58], ['mobile', internal ? 0.49 : 0.37], ['tablet', internal ? 0.07 : 0.05]]),
    statuses: views ? [
      { status: 200, views: Math.round(views * 0.86) },
      { status: 304, views: Math.round(views * 0.09) },
      { status: 404, views: Math.round(views * (internal ? 0.04 : 0.045)) },
      ...(internal ? [] : [{ status: 500, views: Math.max(1, Math.round(views * 0.005)) }]),
    ] : [],
    source: {
      ingest: v === 'wartet' ? 'waiting' : v === 'aus' ? 'off' : 'ok',
      since: ago(41 * DAY),
      cityDb: v === 'staedte' ? '2026-11' : null,
    },
  }
}

/** Projektliste: Aufrufe heute (nur mit Besucher-Auswertung) */
export const trafficToday: TrafficTodayDto = { views: { 'p-foto': 31, 'p-haushalt': 214, 'p-wetter': 4, 'p-kontoauszug': 12, 'p-verein': 57, 'p-hallo': 168 }, ingest: 'ok' }

/* --- Etappe 5: Statusseite --------------------------------------------------------- */

/** Einstellungen › Statusseite: «an» (example), «aus» ohne Hauptzone (labor) */
export function statusPage(env: string): StatusPageDto {
  const projects: StatusPageDto['projects'] = [
    // Wie die Projektliste: öffentlich sind Haushaltsbuch und Vereinsseite
    { id: 'p-foto', name: 'Fotoalbum', shown: true, explicit: true, public: false },
    { id: 'p-haushalt', name: 'Haushaltsbuch', shown: false, explicit: true, public: true },
    { id: 'p-kontoauszug', name: 'Kontoauszug-Reader', shown: false, explicit: false, public: false },
    { id: 'p-notizen', name: 'Notizen', shown: false, explicit: false, public: false },
    { id: 'p-rezepte', name: 'Rezepte-API', shown: false, explicit: false, public: false },
    { id: 'p-verein', name: 'Vereinsseite', shown: true, explicit: false, public: true },
    { id: 'p-wetter', name: 'Wetterstation', shown: true, explicit: true, public: false },
  ]
  if (env === 'labor') {
    return { enabled: false, title: 'Status', hostname: null, publicReady: false, problem: 'Noch keine Hauptzone gewählt (Einstellungen › Cloudflare & HTTPS).', writtenAt: null, storage: true, projects: [] }
  }
  return { enabled: true, title: 'Status example.ch', hostname: 'status.example.ch', publicReady: true, problem: null, writtenAt: ago(40_000), storage: true, projects }
}

export function incidents(env: string): IncidentDto[] {
  if (env === 'labor') return []
  return [
    {
      id: 'i-wetter', title: 'Wetterstation nicht erreichbar', state: 'erkannt', auto: true,
      projects: [{ id: 'p-wetter', name: 'Wetterstation', shown: true }], createdAt: ago(26 * MIN), resolvedAt: null,
      updates: [
        { id: 'u2', state: 'erkannt', body: 'Der Sensor-Dienst liefert keine Daten mehr. Ein neues Deployment ist unterwegs.', at: ago(9 * MIN), actor: 'ui:joel' },
        { id: 'u1', state: 'untersucht', body: 'Wetterstation ist seit mehr als 5 Minuten nicht erreichbar (automatisch erkannt).', at: ago(21 * MIN), actor: 'system' },
      ],
    },
    {
      id: 'i-wartung', title: 'Kurze Unterbrechung beim Fotoalbum', state: 'behoben', auto: false,
      projects: [{ id: 'p-foto', name: 'Fotoalbum', shown: true }], createdAt: ago(3 * DAY + 2 * HOUR), resolvedAt: ago(3 * DAY + HOUR),
      updates: [
        { id: 'u4', state: 'behoben', body: 'Läuft wieder. Ursache war ein voller Datenträger.', at: ago(3 * DAY + HOUR), actor: 'ui:joel' },
        { id: 'u3', state: 'untersucht', body: 'Bilder laden nicht. Wir schauen nach.', at: ago(3 * DAY + 2 * HOUR), actor: 'ui:joel' },
      ],
    },
  ]
}

/**
 * Öffentliche Seite (eigene Szene): Messung seit 41 Tagen, davor «keine Daten»
 * – wie nach dem Einführen der Tageswerte. Variante «ruhig»: alles läuft,
 * keine Störungen, erst 6 Tage gemessen.
 */
export function statusPublic(variant: 'stoerung' | 'ruhig'): PublicStatusJson {
  const tz = 'Europe/Zurich'
  const now = new Date()
  const today = dayInZone(now, tz)
  const measured = variant === 'ruhig' ? 6 : 41
  const counts = (pattern: (d: number) => { up: number; down: number; paused?: number }): StatusDayCount[] =>
    Array.from({ length: measured }, (_, i) => {
      const c = pattern(i)
      return { date: addDays(today, -i), upMinutes: c.up, downMinutes: c.down, pausedMinutes: c.paused ?? 0 }
    })
  const full = (d: number) => (d === 0 ? 840 : 1440)
  const list: { name: string; state: PublicStatusProject['state']; counts: StatusDayCount[] }[] = variant === 'ruhig'
    ? [
        { name: 'Fotoalbum', state: 'ok', counts: counts((d) => ({ up: full(d), down: 0 })) },
        { name: 'Vereinsseite', state: 'ok', counts: counts((d) => ({ up: full(d), down: 0 })) },
      ]
    : [
        { name: 'Fotoalbum', state: 'ok', counts: counts((d) => ({ up: full(d) - (d === 3 ? 62 : d % 13 === 7 ? 9 : 0), down: d === 3 ? 62 : d % 13 === 7 ? 9 : 0 })) },
        { name: 'Vereinsseite', state: 'pausiert', counts: counts((d) => (d < 1 ? { up: 0, down: 0, paused: full(d) } : { up: full(d), down: 0 })) },
        { name: 'Wetterstation', state: 'stoerung', counts: counts((d) => ({ up: full(d) - (d === 0 ? 26 : d === 18 ? 4 : 0), down: d === 0 ? 26 : d === 18 ? 4 : 0 })) },
      ]
  const projects: PublicStatusProject[] = list.map((p) => ({ name: p.name, state: p.state, availability: availabilityOf(p.counts), days: statusDays(p.counts, today) }))
  const incidentsList: PublicStatusIncident[] = variant === 'ruhig' ? [] : incidents('example').map((i, n) => ({
    key: n === 0 ? '3f9a1c0b7e24' : '8d21e6a4c95f', title: i.title, state: i.state, startedAt: i.createdAt, resolvedAt: i.resolvedAt,
    projects: i.projects.map((p) => p.name), updates: i.updates.map((u) => ({ at: u.at, state: u.state, text: u.body })),
  }))
  return {
    version: 1, title: 'Status example.ch', generatedAt: now.toISOString(), timeZone: tz,
    overall: overallOf(projects, incidentsList), incidents: incidentsList, projects,
  }
}

/* --- Etappe 6: Vorschau-Deploys ------------------------------------------------------- */

/** an: drei Vorschauen (bereit mit PR und Scan, wird deployt, fehlgeschlagen); leer: an, noch keine; sonst: Standard aus */
export type PreviewVariant = 'an' | 'leer'

const PREVIEW_REASON: Record<string, string> = {
  files: 'Vorschauen gibt es nur für Projekte aus einem Git-Repo; dieses Projekt kommt aus dem Chat.',
  image: 'Vorschauen gibt es nur für Projekte aus einem Git-Repo; dieses Projekt läuft aus einem fertigen Image.',
}

export function previews(id: string, variant?: PreviewVariant): { previews: PreviewsDto } {
  const p = allProjects.find((x) => x.id === id)
  const repo = id === 'p-foto' ? 'example/fotoalbum' : id === 'p-rezepte' ? 'example/rezepte-api' : null
  const slug = p?.slug ?? 'projekt'
  const host = (label: string) => `${label}.int.example.ch`
  const reason = repo ? null : PREVIEW_REASON[p?.sourceType ?? ''] ?? 'Vorschauen brauchen ein Git-Repo; die Quelle dieses Projekts ist hochgeladen.'
  const on = Boolean(repo && variant)
  const list: PreviewDto[] = on && variant === 'an' ? [
    {
      id: 'v-login', branch: 'feature/login-mit-passkey', label: `feature-login-mit-passkey--${slug}`,
      url: `https://${host(`feature-login-mit-passkey--${slug}`)}`, host: host(`feature-login-mit-passkey--${slug}`),
      prNumber: 42, prUrl: `https://github.com/${repo}/pull/42`, headSha: '3f9c2a17b0d84e6f5a1c9e0b7d2f4a6c8e1b3d5f',
      lastPushAt: ago(2 * HOUR), createdAt: ago(2 * DAY), expiresAt: new Date(Date.now() - 2 * HOUR + 7 * DAY).toISOString(),
      state: 'ready', deploymentId: 'd-v-login', failure: null, failureSecrets: false,
      scan: { status: 'done', grade: 'B', score: 82, open: { critical: 0, high: 1, medium: 2, low: 0 } },
    },
    {
      id: 'v-galerie', branch: 'galerie-raster', label: `galerie-raster--${slug}`,
      url: `https://${host(`galerie-raster--${slug}`)}`, host: host(`galerie-raster--${slug}`),
      prNumber: null, prUrl: null, headSha: 'a71e04c9d3b25f8e6c0a9b1d7e3f5c2a4b6d8e0f',
      lastPushAt: ago(4 * MIN), createdAt: ago(4 * MIN), expiresAt: new Date(Date.now() - 4 * MIN + 7 * DAY).toISOString(),
      state: 'deploying', deploymentId: 'd-v-galerie', failure: null, failureSecrets: false, scan: null,
    },
    {
      id: 'v-deps', branch: 'dependabot/npm_and_yarn/sharp-0.33.5', label: `dependabot-npm-and-yarn-sharp-0-33-5--${slug}`,
      url: `https://${host(`dependabot-npm-and-yarn-sharp-0-33-5--${slug}`)}`, host: host(`dependabot-npm-and-yarn-sharp-0-33-5--${slug}`),
      prNumber: 39, prUrl: `https://github.com/${repo}/pull/39`, headSha: 'c2d8f1a0e9b47365d1c0e8f2a9b3d4c5e6f7a8b9',
      lastPushAt: ago(5 * DAY + 3 * HOUR), createdAt: ago(5 * DAY + 3 * HOUR), expiresAt: new Date(Date.now() - (5 * DAY + 3 * HOUR) + 7 * DAY).toISOString(),
      state: 'failed', deploymentId: 'd-v-deps', failure: 'Geheime Variable DATABASE_URL fehlt – in Einstellungen › Vorschauen › Variablen setzen', failureSecrets: true, scan: null,
    },
  ] : []
  return {
    previews: {
      enabled: on, available: Boolean(repo), reason, repo, checkedAt: on ? ago(3 * MIN) : null,
      pattern: `<branch>--${slug}.int.example.ch`, max: 3, idleDays: 7, previews: list,
    },
  }
}

export function previewEnv(id: string, variant?: PreviewVariant) {
  if (id !== detailProjectId || !variant) return { env: [], inherited: env(id).map((e) => ({ key: e.key, source: e.isSecret ? 'nicht_vererbt' as const : 'projekt' as const })) }
  return {
    env: [
      { key: 'THUMBNAIL_SIZE', isSecret: false, value: '240' },
      { key: 'MAIL_DRY_RUN', isSecret: false, value: '1' },
    ],
    inherited: [
      { key: 'DATABASE_URL', source: 'nicht_vererbt' as const }, { key: 'MAIL_DRY_RUN', source: 'vorschau' as const },
      { key: 'THUMBNAIL_SIZE', source: 'ueberschrieben' as const }, { key: 'TZ', source: 'projekt' as const },
    ],
  }
}

/* --- Nacht 3, Etappe 1: Passkeys, Authenticator, Wiederherstellungscodes, Sitzungen --- */

const UI_HOST = 'deployer.int.example.ch'
const hostHere: import('@airlock/shared').PasskeyHostDto = { available: true, rpId: UI_HOST, mainUrl: null, reason: null }
const hostNip: import('@airlock/shared').PasskeyHostDto = { available: false, rpId: UI_HOST, mainUrl: `https://${UI_HOST}`, reason: 'other_host' }

/** Anmeldeseite: Passkey hier möglich bzw. Seite unter nip.io offen (Passkey nur unter der Hauptadresse) */
export type LoginVariant = 'passkey' | 'nip'
export function loginMe(v: LoginVariant): MeDto {
  return { loggedIn: false, login: { passkeyHost: v === 'nip' ? hostNip : hostHere, passkeys: true } }
}

/** Konto › Sicherheit: alles eingerichtet, noch nichts, oder unter nip.io geöffnet */
export type SecurityVariant = 'voll' | 'leer' | 'nip'
export function security(v: SecurityVariant): import('@airlock/shared').SecurityDto {
  if (v === 'leer' || v === 'nip') {
    return {
      passkeys: [], totp: { enabled: false, enabledAt: null }, recovery: { total: 0, remaining: 0, createdAt: null },
      required: false, requiredSetting: null, hasFactor: false, sudoUntil: null, passkeyHost: v === 'nip' ? hostNip : hostHere,
    }
  }
  return {
    passkeys: [
      { id: 'pk1', name: 'MacBook Air', createdAt: ago(41 * DAY), lastUsedAt: ago(3 * HOUR), synced: true, rpId: UI_HOST },
      { id: 'pk2', name: 'iPhone', createdAt: ago(40 * DAY), lastUsedAt: ago(6 * DAY), synced: true, rpId: UI_HOST },
      { id: 'pk3', name: 'YubiKey 5C', createdAt: ago(12 * DAY), lastUsedAt: null, synced: false, rpId: UI_HOST },
    ],
    totp: { enabled: true, enabledAt: ago(41 * DAY) },
    recovery: { total: 10, remaining: 8, createdAt: ago(41 * DAY) },
    required: true, requiredSetting: null, hasFactor: true, sudoUntil: null, passkeyHost: hostHere,
  }
}

export const authSessions: import('@airlock/shared').SessionDto[] = [
  { id: 's1', current: true, createdAt: ago(3 * HOUR), lastSeenAt: ago(0), device: 'Safari auf macOS', ip: '192.168.1.24', access: 'lan', method: 'passkey' },
  { id: 's2', current: false, createdAt: ago(2 * DAY), lastSeenAt: ago(25 * MIN), device: 'Safari auf iPhone', ip: '100.101.12.7', access: 'tailnet', method: 'passkey' },
  { id: 's3', current: false, createdAt: ago(5 * DAY), lastSeenAt: ago(2 * DAY), device: 'Firefox auf Linux', ip: '192.168.1.31', access: 'lan', method: 'password_totp' },
]

/** Beispiel-Einrichtung (Geheimnis nur für Screenshots); QR-Code wie beim Papier-Schlüssel */
export const totpSetup = (): import('@airlock/shared').TotpSetupDto => ({
  secret: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP', // allowlist-secret: Beispielwert für Screenshots
  uri: 'otpauth://totp/Airlock%3AJo%C3%ABl?secret=JBSWY3DPEHPK3PXP', // allowlist-secret: Beispielwert für Screenshots
  qr: backupKeyPaper.qr,
})

export const recoveryCodes: import('@airlock/shared').RecoveryCodesDto = {
  codes: ['7kq2-m9xd-4hfa', 'p3vr-8w2n-c6ty', 'h5ze-2bk9-qm4s', 'x8ca-r7pw-3ndj', 'e4tn-6gy2-kv8b', 'w2mh-9fq5-zr3c', 'b6pd-4xk8-ta2e', 'n9js-3cv7-hw5g', 'q4yb-5ze2-mk9x', 'f7rt-2nd6-pc4w'], // allowlist-secret: Beispielwerte
  createdAt: new Date().toISOString(),
  text: '',
}

export const sudoStatus: import('@airlock/shared').SudoStatusDto = { until: null, needs: { password: true, passkey: true, totp: true, recovery: true } }

/* --- Nacht 3, Etappe 2: private Git-Repos ----------------------------------------------- */

/** Nur öffentliche Schlüssel und Fingerabdrücke (Beispielwerte, kein Geheimnis) */
const ED_PUB = 'AAAAC3NzaC1lZDI1NTE5AAAAIL4YROAWh8lwT3fJvYpHN6lQTfVsfMne6rBWf10pmrsA'
const gitlabHostKeys: import('@airlock/shared').GitHostKeyDto[] = [
  { type: 'ssh-ed25519', fingerprint: 'SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8' },
  { type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw' },
  { type: 'ssh-rsa', fingerprint: 'SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ' },
]

export type GitAccessVariant = 'deploy-key' | 'deploy-key-neu'
export type RepoCheckVariant = 'erreichbar' | 'github-kein-zugriff' | 'server-bestaetigen'

export const deployKey = (fresh = false): import('@airlock/shared').GitCredentialDto => ({
  id: '7d0c6a51-2f7e-4c1a-9b8e-0d3f5a6b7c81',
  kind: 'ssh_key',
  publicKey: `ssh-ed25519 ${ED_PUB} airlock-homeserver-fotoalbum-2026-11-12`,
  keyFingerprint: 'SHA256:1I/Wlmie4RkkJ2wFkgP8SQQ5NZgpcIr1MhEI7UeCyr0',
  username: null,
  host: fresh ? null : 'gitlab.com',
  hostKeys: fresh ? [] : gitlabHostKeys.slice(0, 1),
  hostConfirmedAt: fresh ? null : ago(9 * DAY),
  createdAt: ago(fresh ? 1 * MIN : 9 * DAY),
  lastUsedAt: fresh ? null : ago(2 * HOUR),
})

/** Einstellungen › Repo-Zugang: GitHub-App (Standard) oder Deploy-Key (GitLab) */
export function gitAccess(id: string, variant?: GitAccessVariant): import('@airlock/shared').ProjectGitAccessDto {
  if (variant) return { via: 'deploy_key', credential: deployKey(variant === 'deploy-key-neu'), githubRepo: null, githubAppAccess: false }
  const repo = id === 'p-foto' ? 'example/fotoalbum' : id === 'p-rezepte' ? 'example/rezepte-api' : null
  return repo ? { via: 'github_app', credential: null, githubRepo: repo, githubAppAccess: true } : { via: null, credential: null, githubRepo: null, githubAppAccess: false }
}

export function repoCheck(variant: RepoCheckVariant): import('@airlock/shared').RepoCheckDto {
  if (variant === 'erreichbar') return { ok: true, via: 'github_app', commit: '3f9c2a17e4b85d06c1a2f3e4d5c6b7a8f9e0d1c2', message: 'Erreichbar über GitHub-App – Standard-Branch steht auf 3f9c2a1.' }
  if (variant === 'github-kein-zugriff') {
    return {
      ok: false, code: 'github_no_access', hostKey: null,
      message: 'Die GitHub-App hat keinen Zugriff auf dieses Repo – in GitHub unter Installation › Repository access freigeben.',
      link: { href: 'https://github.com/apps/airlock-homeserver-ab12/installations/new', label: 'In GitHub freigeben', external: true },
    }
  }
  return {
    ok: false, code: 'host_key_unknown', link: null,
    message: 'Erste Verbindung zu gitlab.com: Vergleiche den Fingerabdruck mit dem, den der Anbieter veröffentlicht, und bestätige ihn. Danach verbindet Airlock nur noch mit genau diesem Schlüssel.',
    hostKey: { host: 'gitlab.com', keys: gitlabHostKeys },
  }
}