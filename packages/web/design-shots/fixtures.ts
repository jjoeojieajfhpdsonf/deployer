/**
 * Daten für die Prototyp-Screenshots (docs/prototype-cal). Typisiert gegen
 * die echten DTOs aus @deployer/shared und api.ts: Der Compiler prüft, dass
 * die Seiten dieselben Formen bekommen wie von der API. Erfundene Projekte
 * und Werte, keine echten Server- oder Zugangsdaten.
 */
import type {
  AuditEventDto, CfStatusDto, DeploymentDto, FindingDto, ProjectDto, ProjectHealthDto, RouteDto, ScanReportDto, SystemStatusDto,
  HeaderRulesDto,
} from '@deployer/shared'
import type { ApiTokenDto, DomainDto, ExternalTargetDto, MeDto, NotifySettingsDto } from '../src/api.js'

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
    ...p,
  }
}

export const projects: ProjectDto[] = [
  project({ id: 'p-foto', name: 'Fotoalbum', slug: 'fotoalbum', runtimeKind: 'compose', sourceType: 'compose', source: { type: 'compose', repoUrl: 'https://github.com/example/fotoalbum.git', ref: 'main', composePath: 'compose.yaml', webService: 'web' } as ProjectDto['source'], memoryLimitMb: 1024 }),
  project({
    id: 'p-haushalt', name: 'Haushaltsbuch', slug: 'haushaltsbuch',
    routes: [route(['tailnet', 'lan'], `haushaltsbuch.${BASE}`), { ...route(['public'], 'haushalt.example.ch'), accessProtected: true }],
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
]

export const detailProjectId = 'p-foto'
export const securityProjectId = 'p-kontoauszug'

export const me: MeDto = { loggedIn: true, name: 'Joël', sessionSince: ago(3 * HOUR), viaHttps: true, passwordChangedAt: ago(20 * DAY), passwordSource: 'ui', theme: 'system' }

export function deployments(id: string): DeploymentDto[] {
  const p = projects.find((x) => x.id === id)!
  const list = [0, 1, 2, 3, 4].map((n) => dep(id, n + 1))
  list[1] = { ...list[1]!, status: 'failed', errorMessage: 'Build fehlgeschlagen: npm ci (exit 1)', canRollback: false }
  return [p.activeDeployment!, ...list]
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

export function scan(id: string): ScanReportDto | null {
  const p = projects.find((x) => x.id === id)
  if (!p?.security) return null
  const f = id === securityProjectId ? findings : findings.slice(5)
  return {
    scan: {
      id: p.security.scanId, status: 'done', level: 'standard', startedAt: ago(3 * HOUR + 4 * MIN), finishedAt: p.security.finishedAt,
      score: p.security.score, grade: p.security.grade, error: null,
      stages: {
        trivy: { ran: true, findings: 4 },
        zap: { ran: true, findings: 2 },
        nuclei: { ran: true, findings: 1 },
        headers: id === securityProjectId ? { ran: true, findings: 4, note: 'über Caddy, wie Besucher die Seite sehen' } : { ran: true, findings: 0 },
        tls: { ran: false, note: 'nur für öffentliche Adressen' },
      },
    },
    counts: p.security.open,
    top: f.filter((x) => x.status === 'open').slice(0, 3).map(({ id: fid, severity, title, location, fix }) => ({ id: fid, severity, title, location, fix })),
    findings: f,
  }
}

/** M8: Header über Caddy – CSP im Report-Only mit gesammelten Verstössen, frame-ancestors aktiv. */
export function headerRules(id: string): HeaderRulesDto {
  if (id !== securityProjectId) return { rules: [], hsts: { ok: false, reason: 'HTTPS ist nicht eingerichtet (System → Cloudflare → Zertifikat).' }, viaCaddy: true, csp: { violations: [], total: 0, suggestion: null, notes: [] } }
  return {
    rules: [
      { header: 'content-security-policy', value: "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'", mode: 'report-only', createdAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) },
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
      notes: ["Inline-Code in style-src: in eine Datei auslagern oder per Hash/Nonce erlauben – 'unsafe-inline' schlägt deployer nicht vor."],
    },
  }
}

export function audit(targetId?: string): AuditEventDto[] {
  const rows: [number, string, string, string | null, 'ok' | 'error', string | null][] = [
    [4 * MIN, 'ui', 'project.deploy', 'p-rezepte', 'ok', null],
    [13 * MIN, 'system', 'deploy.failed', 'p-wetter', 'error', 'Healthcheck /health antwortet nicht'],
    [2 * HOUR, 'ui', 'project.deploy', 'p-foto', 'ok', null],
    [3 * HOUR, 'system', 'scan.done', 'p-kontoauszug', 'ok', null],
    [5 * HOUR, 'mcp:claude', 'project.env', 'p-haushalt', 'ok', null],
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
  { id: 'e1', hostname: 'blog.example.ch', verified: true, verifiedAt: ago(12 * DAY), lastCheckAt: ago(6 * HOUR), scanInterval: 'weekly', txt: { name: '_deployer-verify.blog.example.ch', value: 'dpl-verify=7f3a9c21e04d' } },
  { id: 'e2', hostname: 'shop.example.ch', verified: false, verifiedAt: null, lastCheckAt: null, scanInterval: 'off', txt: { name: '_deployer-verify.shop.example.ch', value: 'dpl-verify=51c0aa8e2d93' } },
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
