import { markSessionExpired } from './lib/session.js'
import type {
  ProjectDto, DeploymentDto, EnvEntryDto, EnvEntryInput, AuditEventDto,
  SystemStatusDto, Source, RouteTarget, AddressCheckDto, ScanReportDto, FindingDto, ProjectHealthDto, CfStatusDto, CfTokenCheckDto, ThemePref, UiPrefs, UiPrefsPatch, SetupPrefs,
  PublicStatusDto, PublicProgressDto, OutsideCheckDto, PausePage, PauseOptions,
  HeaderKey, HeaderMode, HeaderRuleDto, HeaderRulesDto, HeaderRecheckDto, FixHintDto, FixRequestDto, GithubStatusDto,
  SiteAccessEntryDto,
  LogLineDto,
  LogLinesDto,
  NamePreviewDto,
  EnvironmentDto, HeaderTemplateDto, LanDnsCheckDto, MovePreviewDto,
} from '@airlock/shared'

export type {
  ScanReportDto, FindingDto, ProjectHealthDto, CfStatusDto, CfTokenCheckDto, PublicStatusDto, PublicProgressDto, OutsideCheckDto,
  HeaderRulesDto, HeaderRecheckDto, HeaderRuleDto, FixHintDto, FixRequestDto,
  EnvironmentDto, HeaderTemplateDto, LanDnsCheckDto, MovePreviewDto,
}

export interface PublicFlowResult {
  hostname: string | null
  check: OutsideCheckDto | null
  changed: boolean
  project: ProjectDto
  status: PublicStatusDto
}

export interface ExternalTargetDto {
  id: string
  hostname: string
  verified: boolean
  verifiedAt: string | null
  lastCheckAt: string | null
  scanInterval: 'off' | 'daily' | 'weekly' | 'monthly'
  txt: { name: string; value: string }
}

export type NotifyEvent = 'deploy_failed' | 'finding_critical' | 'finding_high' | 'project_public' | 'external_verification_lost' | 'infra_problem' | 'expiry' | 'weekly_summary' | 'gateway_warning'

export interface NotifySettingsDto {
  ntfy: { url: string; topic: string; hasToken: boolean } | null
  email: { host: string; port: number; secure: boolean; user: string | null; hasPassword: boolean; from: string; to: string } | null
  matrix: Record<NotifyEvent, { push: boolean; email: boolean }>
}

/** Frist der Chat-Projekte; fromEnv = CHAT_EXPIRY_DAYS, changed = in den Einstellungen geändert */
export interface ExpirySettingDto { days: number; fromEnv: number; changed: boolean }

export interface MeDto {
  loggedIn: boolean
  name?: string
  sessionSince?: string | null
  viaHttps?: boolean
  passwordChangedAt?: string | null
  passwordSource?: 'env' | 'ui' | null
  /** Darstellung, auf dem Server gespeichert (Profilmenü) */
  theme?: ThemePref | null
  /** Einrichtungs-Assistent: ausgeblendet? übersprungene Schritte (null: noch nie angefasst) */
  setup?: SetupPrefs | null
  /** Glocke: bis wann gelesen (UI-Qualität 8) */
  bellSeenAt?: string | null
  /** M9: zuletzt gewählte Umgebung (Slug) */
  lastEnvironment?: string | null
}

export interface DomainDto { id: string; name: string; zoneId: string; isDefault: boolean }

export interface ApiTokenDto {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/v1${path}`, {
      credentials: 'same-origin',
      // Content-Type nur bei einem JSON-Body: Ohne Body würde der Server
      // «Body cannot be empty when content-type is set to 'application/json'» melden.
      headers: typeof init.body === 'string' ? { 'content-type': 'application/json' } : {},
      ...init,
    })
  } catch (e) {
    // Netz weg, Server aus: eigener Code, damit die Oberfläche «nicht erreichbar» zeigt (Status 0)
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError('unreachable', 'Der Airlock-Server antwortet nicht.', 0)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // Kein JSON: meist eine Fehlerseite eines Proxys (502 vom Gateway)
    if (!res.ok) throw new ApiError(res.status >= 502 && res.status <= 504 ? 'unreachable' : 'bad_response', `HTTP ${res.status}`, res.status)
    throw new ApiError('bad_response', 'Unerwartete Antwort vom Server.', res.status)
  }
  if (!res.ok) {
    // UI-Qualität 8: Sitzung abgelaufen → Anmeldedialog über der Seite. Nicht bei der Anmeldung selbst
    // (falsches Passwort) und nicht bei /auth/me (das sagt «nicht angemeldet» als Antwort, nicht als 401);
    // Glocke, Darstellung, Passwort und Abmelden sollen den Dialog dagegen auslösen
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') markSessionExpired()
    const e = (data as { error?: { code: string; message: string; details?: unknown } }).error
    throw new ApiError(e?.code ?? 'unknown', e?.message ?? `HTTP ${res.status}`, res.status, e?.details)
  }
  return data as T
}

const body = (v: unknown) => JSON.stringify(v)

/*
 * M9: Umgebung der Oberfläche. Listen, Anlegen und Einstellungen gehen an
 * /environments/<slug>/…; Einzelobjekte (Projekt, Deployment, Scan) bleiben
 * unter ihrer ID. Gesetzt von lib/env.tsx, bevor eine Seite der Umgebung lädt.
 */
let envSlug = ''
export function setApiEnvironment(slug: string): void {
  envSlug = slug
}
export const apiEnvironment = (): string => envSlug
const e = (p: string, slug = envSlug) => `/environments/${encodeURIComponent(slug)}${p}`

export const api = {
  /* M9: Umgebungen */
  environments: () => call<{ environments: EnvironmentDto[] }>('/environments'),
  createEnvironment: (input: unknown) => call<{ environment: EnvironmentDto }>('/environments', { method: 'POST', body: body(input) }),
  updateEnvironment: (slug: string, patch: unknown) => call<{ environment: EnvironmentDto }>(e('', slug), { method: 'PATCH', body: body(patch) }),
  deleteEnvironment: (slug: string) => call<void>(e('', slug), { method: 'DELETE' }),
  copyStandards: (from: string) => call<{ environment: EnvironmentDto }>(e('/standards/copy'), { method: 'POST', body: body({ from }) }),
  headerTemplates: () => call<{ templates: HeaderTemplateDto[] }>(e('/header-templates')),
  setHeaderTemplate: (header: string, value: string) => call<{ templates: HeaderTemplateDto[] }>(e(`/header-templates/${header}`), { method: 'PUT', body: body({ value }) }),
  removeHeaderTemplate: (header: string) => call<{ templates: HeaderTemplateDto[] }>(e(`/header-templates/${header}`), { method: 'DELETE' }),
  lanDns: () => call<LanDnsCheckDto>(e('/lan-dns')),
  movePreview: (id: string, to: string) => call<{ preview: MovePreviewDto }>(`/projects/${id}/move?to=${encodeURIComponent(to)}`),
  moveProject: (id: string, to: string) => call<{ moved: MovePreviewDto }>(`/projects/${id}/move`, { method: 'POST', body: body({ to, confirm: true }) }),
  setTemplateOff: (id: string, header: string, off: boolean) => call<void>(`/projects/${id}/header-templates/${header}/off`, { method: off ? 'PUT' : 'DELETE' }),

  /* Auth */
  me: () => call<MeDto>('/auth/me'),
  changePassword: (current: string, next: string) => call<{ ok: true }>('/auth/password', { method: 'POST', body: body({ current, next }) }),
  login: (password: string) => call<{ ok: true }>('/auth/login', { method: 'POST', body: body({ password }) }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  /** Nur geänderte Teile (Darstellung, Einrichtung, Umgebung); der Server führt zusammen */
  setPreferences: (prefs: UiPrefsPatch) => call<UiPrefs>('/auth/preferences', { method: 'PUT', body: body(prefs) }),

  /* Projekte */
  listProjects: () => call<{ projects: ProjectDto[] }>(e('/projects')),
  getProject: (id: string) => call<{ project: ProjectDto; env: EnvEntryDto[] }>(`/projects/${id}`),
  /** UI-Qualität 5: Kurzname und Adresse vor dem Anlegen */
  namePreview: (name: string) => call<{ preview: NamePreviewDto }>(`/projects/name-preview?name=${encodeURIComponent(name)}`),
  createProject: (input: unknown) =>
    call<{ project: ProjectDto; deployment: DeploymentDto | null }>(e('/projects'), { method: 'POST', body: body(input) }),
  updateProject: (id: string, patch: unknown) =>
    call<{ project: ProjectDto }>(`/projects/${id}`, { method: 'PATCH', body: body(patch) }),
  deleteProject: (id: string, purgeVolumes = false) =>
    call<void>(`/projects/${id}${purgeVolumes ? '?purge=true' : ''}`, { method: 'DELETE' }),
  /** Übergang deployer → Airlock: aktive Fassung mit neuen Namen neu anlegen */
  recreate: (id: string) =>
    call<{ deployment: DeploymentDto }>(`/projects/${id}/recreate`, { method: 'POST', body: body({}) }),
  rollback: (id: string, deploymentId?: string) =>
    call<{ deployment: DeploymentDto }>(`/projects/${id}/rollback`, {
      method: 'POST',
      body: body(deploymentId ? { deploymentId } : {}),
    }),

  putEnv: (id: string, entries: EnvEntryInput[]) =>
    call<{ env: EnvEntryDto[] }>(`/projects/${id}/env`, { method: 'PUT', body: body({ entries }) }),
  putRoutes: (id: string, targets: RouteTarget[], subdomain?: string, pub?: { publicSubdomain?: string; publicHostname?: string; accessProtected?: boolean }) =>
    call<{ project: ProjectDto }>(`/projects/${id}/routes`, { method: 'PUT', body: body({ targets, subdomain, ...(pub ?? {}) }) }),
  /** Nur Tailnet/LAN; die öffentliche Route bleibt, wie sie ist. */
  putInternalRoutes: (id: string, targets: ('lan' | 'tailnet')[], subdomain?: string) =>
    call<{ project: ProjectDto }>(`/projects/${id}/routes/internal`, { method: 'PUT', body: body({ targets, subdomain }) }),

  /* Veröffentlichung (Karte) */
  publicStatus: (id: string) => call<PublicStatusDto>(`/projects/${id}/public`),
  /** Vorgemerkte Öffentlich-Anfrage bestätigen bzw. verwerfen */
  approvePublicRequest: (id: string) => call<{ status: PublicStatusDto }>(`/projects/${id}/public/request/approve`, { method: 'POST' }),
  discardPublicRequest: (id: string) => call<{ status: PublicStatusDto }>(`/projects/${id}/public/request`, { method: 'DELETE' }),
  publicProgress: (id: string) => call<{ progress: PublicProgressDto | null }>(`/projects/${id}/public/progress`),
  publish: (id: string, pub: { publicSubdomain?: string; publicHostname?: string; accessProtected?: boolean }) =>
    call<PublicFlowResult>(`/projects/${id}/public`, { method: 'POST', body: body(pub) }),
  /** opts: eigene Pause-Seite (null = Vorlage) und «Voraussichtlich zurück» */
  pausePublic: (id: string, opts?: PauseOptions) =>
    call<PublicFlowResult>(`/projects/${id}/public/pause`, { method: 'POST', ...(opts ? { body: body(opts) } : {}) }),
  putPausePage: (id: string, opts: PauseOptions) => call<{ status: PublicStatusDto }>(`/projects/${id}/public/pause-page`, { method: 'PUT', body: body(opts) }),
  pausePageTemplate: () => call<{ page: PausePage; defaults: PausePage }>(e('/settings/pause-page')),
  putPausePageTemplate: (page: PausePage | null) => call<{ page: PausePage; defaults: PausePage }>(e('/settings/pause-page'), { method: 'PUT', body: body({ page }) }),
  resumePublic: (id: string) => call<PublicFlowResult>(`/projects/${id}/public/resume`, { method: 'POST' }),
  unpublish: (id: string) => call<PublicFlowResult & { removed: { hostname: string; accessProtected: boolean } }>(`/projects/${id}/public`, { method: 'DELETE' }),

  /* Domains (M5) */
  domains: () => call<{ domains: DomainDto[]; publicEnabled: boolean }>(e('/domains')),
  syncDomains: () => call<{ domains: DomainDto[] }>(e('/domains/sync'), { method: 'POST' }),
  setDefaultDomain: (name: string) => call<{ domains: DomainDto[] }>(e('/domains/default'), { method: 'PUT', body: body({ name }) }),

  /* Betrieb */
  deploy: (id: string, ref?: string) =>
    call<{ deployment: DeploymentDto }>(`/projects/${id}/deploy`, { method: 'POST', body: body(ref ? { ref } : {}) }),
  start: (id: string) => call<{ started: boolean; deployment?: DeploymentDto }>(`/projects/${id}/start`, { method: 'POST' }),
  stop: (id: string) => call<void>(`/projects/${id}/stop`, { method: 'POST' }),
  restart: (id: string) => call<{ started: boolean; deployment?: DeploymentDto }>(`/projects/${id}/restart`, { method: 'POST' }),
  listDeployments: (id: string) => call<{ deployments: DeploymentDto[] }>(`/projects/${id}/deployments`),
  getDeployment: (id: string) => call<{ deployment: DeploymentDto; log: string }>(`/deployments/${id}`),
  health: (id: string, fresh = false) => call<ProjectHealthDto>(`/projects/${id}/health${fresh ? '?fresh=1' : ''}`),
  /** Adresse vom Server aus prüfen (http-Adressen auf einer https-Seite) */
  addressCheck: (id: string, url: string) => call<AddressCheckDto>(`/projects/${id}/address-check?url=${encodeURIComponent(url)}`),
  getLogs: (id: string, lines = 200) => call<{ logs: string; hint?: string }>(`/projects/${id}/logs?lines=${lines}`),

  /* Uploads */
  upload: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return call<{ upload: { id: string; filename: string; sizeBytes: number; kind: 'zip' | 'compose' } }>('/uploads', { method: 'POST', body: fd })
  },

  /* Tokens (M3) */
  listTokens: () => call<{ tokens: ApiTokenDto[] }>(e('/tokens')),
  createToken: (name: string) => call<{ token: string; apiToken: ApiTokenDto }>(e('/tokens'), { method: 'POST', body: body({ name }) }),
  revokeToken: (id: string) => call<void>(`/tokens/${id}`, { method: 'DELETE' }),

  /* Dateien eines Chat-Projekts (M3) */
  /** Statische Seiten: Aufrufe aus Caddys Zugriffs-Log (24 Stunden) */
  siteAccess: (id: string, range?: string) => call<{ entries: SiteAccessEntryDto[]; since: string; error: string | null }>(`/projects/${id}/access${range ? `?range=${range}` : ''}`),
  /** UI-Qualität 4: Zeilen mit Zeit, Dienst und Stufe */
  logLines: (id: string, range: string, service: string | null) =>
    call<LogLinesDto>(`/projects/${id}/log-lines?range=${range}${service ? `&service=${encodeURIComponent(service)}` : ''}`),
  listFiles: (id: string) => call<{ commit: string | null; files: { path: string; size: number }[] }>(`/projects/${id}/files`),

  /* Security (M6) */
  startScan: (id: string, level: 'standard' | 'active' = 'standard') =>
    call<{ scan: { id: string; status: string } }>(`/projects/${id}/scans`, { method: 'POST', body: body({ level, confirm: level === 'active' }) }),
  latestScan: (id: string, done = false) => call<{ report: ScanReportDto | null }>(`/projects/${id}/scans/latest${done ? '?done=1' : ''}`),
  cancelScan: (scanId: string) => call<{ report: ScanReportDto }>(`/scans/${scanId}/cancel`, { method: 'POST' }),
  acceptFinding: (findingId: string, reason: string) =>
    call<{ ok: true }>(`/findings/${findingId}`, { method: 'PATCH', body: body({ status: 'accepted', reason }) }),
  externalTargets: () => call<{ targets: ExternalTargetDto[] }>(e('/external-targets')),
  addExternalTarget: (hostname: string) => call<{ target: ExternalTargetDto }>(e('/external-targets'), { method: 'POST', body: body({ hostname }) }),
  verifyExternalTarget: (id: string) => call<{ target: ExternalTargetDto & { confirmedBy: string[]; errors: string[] } }>(`/external-targets/${id}/verify`, { method: 'POST' }),
  setExternalInterval: (id: string, scanInterval: string) => call<{ target: ExternalTargetDto }>(`/external-targets/${id}`, { method: 'PATCH', body: body({ scanInterval }) }),
  deleteExternalTarget: (id: string) => call<void>(`/external-targets/${id}`, { method: 'DELETE' }),
  scanExternal: (id: string) => call<{ scan: { id: string } }>(`/external-targets/${id}/scans`, { method: 'POST', body: body({}) }),
  latestExternalScan: (id: string) => call<{ report: ScanReportDto | null }>(`/external-targets/${id}/scans/latest`),

  /* Fix-Assistent (M8): Header über Caddy */
  headerRules: (id: string) => call<HeaderRulesDto>(`/projects/${id}/header-rules`),
  setHeaderRule: (id: string, header: HeaderKey, v: { value?: string; mode: HeaderMode; confirm?: boolean }) =>
    call<{ rule: HeaderRuleDto; recheck: HeaderRecheckDto }>(`/projects/${id}/header-rules/${header}`, { method: 'PUT', body: body(v) }),
  removeHeaderRule: (id: string, header: HeaderKey) =>
    call<{ recheck: HeaderRecheckDto }>(`/projects/${id}/header-rules/${header}`, { method: 'DELETE' }),
  recheckHeaders: (id: string) => call<HeaderRecheckDto>(`/projects/${id}/header-recheck`, { method: 'POST' }),
  resetHeaderRule: (id: string, header: HeaderKey) =>
    call<{ recheck: HeaderRecheckDto; result: 'report-only' | 'removed' }>(`/projects/${id}/header-rules/${header}/reset`, { method: 'POST' }),

  /* Fix-Assistent (M8): Mit Claude lösen */
  fixHint: (id: string, findingId: string) => call<FixHintDto>(`/projects/${id}/findings/${findingId}/fix-hint`),
  fixRequests: (id: string) => call<{ fixes: FixRequestDto[] }>(`/projects/${id}/fix-requests`),
  applyFix: (id: string, fixId: string) => call<{ fix: FixRequestDto }>(`/projects/${id}/fix-requests/${fixId}/apply`, { method: 'POST', body: body({ confirm: true }) }),
  /* GitHub App und Auto-Deploy (M8, Etappe 3) */
  github: () => call<GithubStatusDto>('/github'),
  githubManifest: (name: string, org?: string) => call<{ action: string; manifest: string; state: string }>('/github/manifest', { method: 'POST', body: body({ name, ...(org ? { org } : {}) }) }),
  githubRefresh: () => call<{ repos: string[] }>('/github/refresh', { method: 'POST' }),
  githubDisconnect: () => call<void>('/github', { method: 'DELETE' }),
  autoDeploy: (id: string) => call<{ autoDeploy: boolean; checkedAt: string | null; available: boolean; viaGithubApp: boolean }>(`/projects/${id}/auto-deploy`),
  setAutoDeploy: (id: string, enabled: boolean) => call<{ autoDeploy: boolean; viaGithubApp: boolean }>(`/projects/${id}/auto-deploy`, { method: 'PUT', body: body({ enabled }) }),
  rejectFix: (id: string, fixId: string) => call<{ fix: FixRequestDto }>(`/projects/${id}/fix-requests/${fixId}/reject`, { method: 'POST', body: body({}) }),
  notifications: () => call<NotifySettingsDto>('/notifications'),
  putNotifications: (s: unknown) => call<NotifySettingsDto>('/notifications', { method: 'PUT', body: body(s) }),
  testNotification: (channel: 'push' | 'email') => call<{ ok: true }>('/notifications/test', { method: 'POST', body: body({ channel }) }),

  /* Cloudflare verbinden */
  /** Frist der Chat-Projekte (Tage ohne Änderung bis zum Stopp) */
  expiry: () => call<ExpirySettingDto>('/system/expiry'),
  setExpiry: (days: number) => call<ExpirySettingDto>('/system/expiry', { method: 'PUT', body: body({ days }) }),
  /* Cloudflare verbinden (M9: je Umgebung) */
  cloudflare: () => call<CfStatusDto>(e('/cloudflare')),
  cloudflareCheck: (token: string) => call<{ check: CfTokenCheckDto }>(e('/cloudflare/check'), { method: 'POST', body: body({ token }) }),
  cloudflareToken: (token: string) => call<{ check: CfTokenCheckDto; status: CfStatusDto }>(e('/cloudflare/token'), { method: 'PUT', body: body({ token }) }),
  cloudflareDomains: (d: unknown) => call<CfStatusDto>(e('/cloudflare/domains'), { method: 'PUT', body: body(d) }),
  cloudflareTunnel: () => call<CfStatusDto>(e('/cloudflare/tunnel'), { method: 'POST' }),
  cloudflareTunnelSkip: () => call<CfStatusDto>(e('/cloudflare/tunnel/skip'), { method: 'POST' }),
  cloudflareTunnelRestart: () => call<CfStatusDto>(e('/cloudflare/tunnel/restart'), { method: 'POST' }),
  cloudflareTunnelUpdate: () => call<CfStatusDto>(e('/cloudflare/tunnel/update'), { method: 'POST' }),
  cloudflareTls: () => call<CfStatusDto>(e('/cloudflare/tls'), { method: 'POST' }),
  cloudflareDisconnect: () => call<CfStatusDto>(e('/cloudflare'), { method: 'DELETE' }),

  /* System */
  checkNetwork: () => call<{ changed: boolean }>('/system/network/check', { method: 'POST' }),
  system: () => call<SystemStatusDto>('/system/status'),
  /** M9: Einträge aller Umgebungen; «record» ist der der Standard-Umgebung */
  tailnetDns: () => call<{
    record: { name: string; content: string; action: 'created' | 'updated' | 'unchanged'; zone: string } | null
    records: { name: string; content: string; action: 'created' | 'updated' | 'unchanged'; zone: string; environment?: string }[]
  }>('/system/tailnet-dns', { method: 'POST' }),
  audit: (limit = 100, targetId?: string) => call<{ events: AuditEventDto[] }>(e(`/audit?limit=${limit}${targetId ? `&targetId=${targetId}` : ''}`)),
}

export type { ProjectDto, DeploymentDto, EnvEntryDto, AuditEventDto, SystemStatusDto, Source }

/* --- Server-Sent Events ---------------------------------------------------- */

export interface DeployEvent {
  type: 'line' | 'status' | 'done'
  line?: string
  status?: string
  ok?: boolean
  at: string
}

export function subscribeDeployment(id: string, onEvent: (e: DeployEvent) => void): () => void {
  const es = new EventSource(`/api/v1/deployments/${id}/events`)
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as DeployEvent)
    } catch {
      /* unvollständige Nachricht ignorieren */
    }
  }
  es.onerror = () => es.close()
  return () => es.close()
}

/**
 * UI-Qualität 4: neue Zeilen live (Zeit, Dienst, Stufe). onState meldet, ob
 * der Strom offen ist – bricht er ab, zeigt der Reiter es an, statt still zu stehen.
 */
export function subscribeLogs(projectId: string, o: { service: string | null; since: string | null }, onLine: (line: LogLineDto) => void, onState?: (open: boolean) => void): () => void {
  const q = new URLSearchParams()
  if (o.service) q.set('service', o.service)
  // Anschluss an den Stand: nur Zeilen danach (nichts doppelt, nichts verloren)
  if (o.since) q.set('since', o.since)
  return subscribeJson<LogLineDto>(`/api/v1/projects/${projectId}/logs/stream${q.size ? `?${q}` : ''}`, onLine, onState)
}

/** UI-Qualität 4: neue Zugriffe einer statischen Seite live */
export function subscribeAccess(projectId: string, since: string | null, onEntry: (e: SiteAccessEntryDto) => void, onState?: (open: boolean) => void): () => void {
  return subscribeJson<SiteAccessEntryDto>(`/api/v1/projects/${projectId}/access/stream${since ? `?since=${encodeURIComponent(since)}` : ''}`, onEntry, onState)
}

function subscribeJson<T>(url: string, on: (v: T) => void, onState?: (open: boolean) => void): () => void {
  const es = new EventSource(url)
  es.onopen = () => onState?.(true)
  es.onmessage = (m) => {
    try {
      on(JSON.parse(m.data as string) as T)
    } catch {
      /* ignorieren */
    }
  }
  es.onerror = () => { es.close(); onState?.(false) }
  return () => es.close()
}

/**
 * Prueft aus dem BROWSER, ob ein Name auf diesem Geraet aufloest. Genau das
 * kann der Server nicht beantworten.
 */
/**
 * Wie checkReachable, aber ohne CORS: eine undurchsichtige Antwort heisst
 * «der Name löst auf und der Server antwortet». Für Projekt-Adressen, die
 * keine CORS-Header schicken.
 */
export async function probeUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    return true
  } catch {
    return false
  }
}

export async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}
