import type {
  ProjectDto, DeploymentDto, EnvEntryDto, EnvEntryInput, AuditEventDto,
  SystemStatusDto, Source, RouteTarget,
} from '@deployer/shared'

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    headers: init.body instanceof FormData ? {} : { 'content-type': 'application/json' },
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
  me: () => call<{ loggedIn: boolean }>('/auth/me'),
  login: (password: string) => call<{ ok: true }>('/auth/login', { method: 'POST', body: body({ password }) }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),

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
  putRoutes: (id: string, targets: RouteTarget[], subdomain?: string) =>
    call<{ project: ProjectDto }>(`/projects/${id}/routes`, { method: 'PUT', body: body({ targets, subdomain }) }),

  /* Betrieb */
  deploy: (id: string, ref?: string) =>
    call<{ deployment: DeploymentDto }>(`/projects/${id}/deploy`, { method: 'POST', body: body(ref ? { ref } : {}) }),
  start: (id: string) => call<{ started: boolean; deployment?: DeploymentDto }>(`/projects/${id}/start`, { method: 'POST' }),
  stop: (id: string) => call<void>(`/projects/${id}/stop`, { method: 'POST' }),
  listDeployments: (id: string) => call<{ deployments: DeploymentDto[] }>(`/projects/${id}/deployments`),
  getDeployment: (id: string) => call<{ deployment: DeploymentDto; log: string }>(`/deployments/${id}`),
  getLogs: (id: string, lines = 200) => call<{ logs: string; hint?: string }>(`/projects/${id}/logs?lines=${lines}`),

  /* Uploads */
  upload: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return call<{ upload: { id: string; filename: string; sizeBytes: number; kind: 'zip' | 'compose' } }>('/uploads', { method: 'POST', body: fd })
  },

  /* System */
  system: () => call<SystemStatusDto>('/system/status'),
  audit: (limit = 100) => call<{ events: AuditEventDto[] }>(`/audit?limit=${limit}`),
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
export async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}
