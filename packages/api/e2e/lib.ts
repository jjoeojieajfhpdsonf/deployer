import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hilfen für die Ende-zu-Ende-Abnahme gegen den laufenden lokalen Stack
 * (docker compose up). Läuft auf dem Host, nicht im Container.
 *
 *   pnpm --filter @deployer/api e2e
 *
 * Erwartet SERVER_LAN_IP und ADMIN_PASSWORD in der .env im Projektordner.
 */

const root = join(import.meta.dirname, '..', '..', '..')

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]!] = m[2]!
    }
  } catch {
    /* keine .env */
  }
  return out
}

export const env = { ...readEnv(), ...process.env } as Record<string, string>
export const lanIp = env.SERVER_LAN_IP ?? ''
export const dashIp = lanIp.replace(/\./g, '-')
export const BASE = env.E2E_BASE ?? `http://deployer.${dashIp}.nip.io`
export const host = (slug: string) => `http://${slug}.${dashIp}.nip.io`

let cookie = ''

export async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  })
  if (!res.ok) throw new Error(`Login fehlgeschlagen: ${res.status}`)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const isForm = body instanceof FormData
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as T }
}

export async function upload(name: string, content: Buffer | string): Promise<string> {
  const fd = new FormData()
  fd.append('file', new Blob([content]), name)
  const r = await api('POST', '/uploads', fd)
  if (r.status !== 201) throw new Error(`Upload fehlgeschlagen: ${JSON.stringify(r.data)}`)
  return r.data.upload.id
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wartet, bis ein Deployment fertig ist; gibt den Endstatus zurück. */
export async function waitDeployment(id: string, timeoutMs = 300_000): Promise<{ status: string; errorMessage: string | null; log: string }> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const r = await api('GET', `/deployments/${id}`)
    const d = r.data.deployment
    if (['active', 'failed', 'superseded'].includes(d.status)) return { status: d.status, errorMessage: d.errorMessage, log: r.data.log }
    await sleep(1000)
  }
  throw new Error(`Deployment ${id} nicht fertig nach ${timeoutMs} ms`)
}

export async function createProject(input: Record<string, unknown>): Promise<{ id: string; slug: string; deploymentId: string }> {
  const r = await api('POST', '/projects', { targets: ['lan'], ...input })
  if (r.status !== 201) throw new Error(`Anlegen fehlgeschlagen (${r.status}): ${JSON.stringify(r.data)}`)
  return { id: r.data.project.id, slug: r.data.project.slug, deploymentId: r.data.deployment?.id }
}

export async function deleteProject(id: string, purge = true): Promise<void> {
  await api('DELETE', `/projects/${id}${purge ? '?purge=true' : ''}`)
}

/** Alle Projekte löschen, deren Slug mit dem Präfix beginnt (Aufräumen nach Tests). */
export async function deleteByPrefix(prefix: string): Promise<void> {
  const r = await api('GET', '/projects')
  for (const p of r.data.projects ?? []) if (p.slug.startsWith(prefix)) await deleteProject(p.id)
}

export async function get(url: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { status: res.status, body: await res.text() }
  } catch {
    return { status: 0, body: '' }
  }
}

export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

export function dockerOk(...args: string[]): boolean {
  try {
    docker(...args)
    return true
  } catch {
    return false
  }
}
