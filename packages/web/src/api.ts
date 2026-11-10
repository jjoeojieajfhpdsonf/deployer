import type {
  ProjectDto, DeploymentDto, EnvEntryDto, EnvEntryInput, AuditEventDto,
  SystemStatusDto, Source, RouteTarget, AddressCheckDto, ScanReportDto, FindingDto, ProjectHealthDto, CfStatusDto, CfTokenCheckDto, ThemePref, UiPrefs,
  PublicStatusDto, PublicProgressDto, OutsideCheckDto,
} from '@deployer/shared'

export type { ScanReportDto, FindingDto, ProjectHealthDto, CfStatusDto, CfTokenCheckDto, PublicStatusDto, PublicProgressDto, OutsideCheckDto }

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

export type NotifyEvent = 'deploy_failed' | 'finding_critical' | 'finding_high' | 'project_public' | 'external_verification_lost' | 'infra_problem' | 'expiry' | 'weekly_summary'

export interface NotifySettingsDto {
  ntfy: { url: string; topic: string; hasToken: boolean } | null
  email: { host: string; port: number; secure: boolean; user: string | null; hasPassword: boolean; from: string; to: string } | null
  matrix: Record<NotifyEvent, { push: boolean; email: boolean }>
}

export interface MeDto {
  loggedIn: boolean
  name?: string
  sessionSince?: string | null
  viaHttps?: boolean
  passwordChangedAt?: string | null
  passwordSource?: 'env' | 'ui' | null
  /** Darstellung, auf dem Server gespeichert (Profilmenü) */
  theme?: ThemePref | null
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
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    // Content-Type nur bei einem JSON-Body: Ohne Body würde der Server
    // «Body cannot be empty when content-type is set to 'application/json'» melden.
    headers: typeof init.body === 'string' ? { 'content-type': 'application/json' } : {},
    ...init,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; details?: unknown } }).error
    throw new ApiError(e?.code ?? 'unknown', e?.message ?? `HTTP ${res.status}`, res.status, e?.details)
  }
  return data as T
}

const body = (v: unknown) => JSON.stringify(v)

export const api = {
  /* Auth */
  me: () => call<MeDto>('/auth/me'),
  changePassword: (current: string, next: string) => call<{ ok: true }>('/auth/password', { method: 'POST', body: body({ current, next }) }),
  login: (password: string) => call<{ ok: true }>('/auth/login', { method: 'POST', body: body({ password }) }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  setPreferences: (prefs: UiPrefs) => call<UiPrefs>('/auth/preferences', { method: 'PUT', body: body(prefs) }),

  /* Projekte */
  listProjects: () => call<{ projects: ProjectDto[] }>('/projects'),
  getProject: (id: string) => call<{ project: ProjectDto; env: EnvEntryDto[] }>(`/projects/${id}`),
  createProject: (input: unknown) =>
    call<{ project: ProjectDto; deployment: DeploymentDto | null }>('/projects', { method: 'POST', body: body(input) }),
  updateProject: (id: string, patch: unknown) =>
    call<{ project: ProjectDto }>(`/projects/${id}`, { method: 'PATCH', body: body(patch) }),
  deleteProject: (id: string, purgeVolumes = false) =>
    call<void>(`/projects/${id}${purgeVolumes ? '?purge=true' : ''}`, { method: 'DELETE' }),
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
  publicProgress: (id: string) => call<{ progress: PublicProgressDto | null }>(`/projects/${id}/public/progress`),
  publish: (id: string, pub: { publicSubdomain?: string; publicHostname?: string; accessProtected?: boolean }) =>
    call<PublicFlowResult>(`/projects/${id}/public`, { method: 'POST', body: body(pub) }),
  pausePublic: (id: string) => call<PublicFlowResult>(`/projects/${id}/public/pause`, { method: 'POST' }),
  resumePublic: (id: string) => call<PublicFlowResult>(`/projects/${id}/public/resume`, { method: 'POST' }),
  unpublish: (id: string) => call<PublicFlowResult & { removed: { hostname: string; accessProtected: boolean } }>(`/projects/${id}/public`, { method: 'DELETE' }),

  /* Domains (M5) */
  domains: () => call<{ domains: DomainDto[]; publicEnabled: boolean }>('/domains'),
  syncDomains: () => call<{ domains: DomainDto[] }>('/domains/sync', { method: 'POST' }),
  setDefaultDomain: (name: string) => call<{ domains: DomainDto[] }>('/domains/default', { method: 'PUT', body: body({ name }) }),

  /* Betrieb */
  deploy: (id: string, ref?: string) =>
    call<{ deployment: DeploymentDto }>(`/projects/${id}/deploy`, { method: 'POST', body: body(ref ? { ref } : {}) }),
  start: (id: string) => call<{ started: boolean; deployment?: DeploymentDto }>(`/projects/${id}/start`, { method: 'POST' }),
  stop: (id: string) => call<void>(`/projects/${id}/stop`, { method: 'POST' }),
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
  listTokens: () => call<{ tokens: ApiTokenDto[] }>('/tokens'),
  createToken: (name: string) => call<{ token: string; apiToken: ApiTokenDto }>('/tokens', { method: 'POST', body: body({ name }) }),
  revokeToken: (id: string) => call<void>(`/tokens/${id}`, { method: 'DELETE' }),

  /* Dateien eines Chat-Projekts (M3) */
  listFiles: (id: string) => call<{ commit: string | null; files: { path: string; size: number }[] }>(`/projects/${id}/files`),

  /* Security (M6) */
  startScan: (id: string, level: 'standard' | 'active' = 'standard') =>
    call<{ scan: { id: string; status: string } }>(`/projects/${id}/scans`, { method: 'POST', body: body({ level, confirm: level === 'active' }) }),
  latestScan: (id: string, done = false) => call<{ report: ScanReportDto | null }>(`/projects/${id}/scans/latest${done ? '?done=1' : ''}`),
  cancelScan: (scanId: string) => call<{ report: ScanReportDto }>(`/scans/${scanId}/cancel`, { method: 'POST' }),
  acceptFinding: (findingId: string, reason: string) =>
    call<{ ok: true }>(`/findings/${findingId}`, { method: 'PATCH', body: body({ status: 'accepted', reason }) }),
  externalTargets: () => call<{ targets: ExternalTargetDto[] }>('/external-targets'),
  addExternalTarget: (hostname: string) => call<{ target: ExternalTargetDto }>('/external-targets', { method: 'POST', body: body({ hostname }) }),
  verifyExternalTarget: (id: string) => call<{ target: ExternalTargetDto & { confirmedBy: string[]; errors: string[] } }>(`/external-targets/${id}/verify`, { method: 'POST' }),
  setExternalInterval: (id: string, scanInterval: string) => call<{ target: ExternalTargetDto }>(`/external-targets/${id}`, { method: 'PATCH', body: body({ scanInterval }) }),
  deleteExternalTarget: (id: string) => call<void>(`/external-targets/${id}`, { method: 'DELETE' }),
  scanExternal: (id: string) => call<{ scan: { id: string } }>(`/external-targets/${id}/scans`, { method: 'POST', body: body({}) }),
  latestExternalScan: (id: string) => call<{ report: ScanReportDto | null }>(`/external-targets/${id}/scans/latest`),
  notifications: () => call<NotifySettingsDto>('/notifications'),
  putNotifications: (s: unknown) => call<NotifySettingsDto>('/notifications', { method: 'PUT', body: body(s) }),
  testNotification: (channel: 'push' | 'email') => call<{ ok: true }>('/notifications/test', { method: 'POST', body: body({ channel }) }),

  /* Cloudflare verbinden */
  cloudflare: () => call<CfStatusDto>('/system/cloudflare'),
  cloudflareCheck: (token: string) => call<{ check: CfTokenCheckDto }>('/system/cloudflare/check', { method: 'POST', body: body({ token }) }),
  cloudflareToken: (token: string) => call<{ check: CfTokenCheckDto; status: CfStatusDto }>('/system/cloudflare/token', { method: 'PUT', body: body({ token }) }),
  cloudflareDomains: (d: unknown) => call<CfStatusDto>('/system/cloudflare/domains', { method: 'PUT', body: body(d) }),
  cloudflareTunnel: () => call<CfStatusDto>('/system/cloudflare/tunnel', { method: 'POST' }),
  cloudflareTunnelSkip: () => call<CfStatusDto>('/system/cloudflare/tunnel/skip', { method: 'POST' }),
  cloudflareTunnelRestart: () => call<CfStatusDto>('/system/cloudflare/tunnel/restart', { method: 'POST' }),
  cloudflareTunnelUpdate: () => call<CfStatusDto>('/system/cloudflare/tunnel/update', { method: 'POST' }),
  cloudflareTls: () => call<CfStatusDto>('/system/cloudflare/tls', { method: 'POST' }),
  cloudflareDisconnect: () => call<CfStatusDto>('/system/cloudflare', { method: 'DELETE' }),

  /* System */
  checkNetwork: () => call<{ changed: boolean }>('/system/network/check', { method: 'POST' }),
  system: () => call<SystemStatusDto>('/system/status'),
  tailnetDns: () => call<{ record: { name: string; content: string; action: 'created' | 'updated' | 'unchanged'; zone: string } }>('/system/tailnet-dns', { method: 'POST' }),
  audit: (limit = 100, targetId?: string) => call<{ events: AuditEventDto[] }>(`/audit?limit=${limit}${targetId ? `&targetId=${targetId}` : ''}`),
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

export function subscribeLogs(projectId: string, onLine: (line: string) => void): () => void {
  const es = new EventSource(`/api/v1/projects/${projectId}/logs/stream`)
  es.onmessage = (m) => {
    try {
      onLine(JSON.parse(m.data) as string)
    } catch {
      /* ignorieren */
    }
  }
  es.onerror = () => es.close()
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
