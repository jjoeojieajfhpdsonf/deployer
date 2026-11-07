import { Client } from 'undici'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { adminAddress } from './caddy-config.js'

export {
  buildCaddyConfig,
  adminAddress,
  type RouteSpec,
  type CaddyBuildOptions,
} from './caddy-config.js'

/**
 * Einziger Ort im Projekt, der mit Caddy spricht.
 *
 * Die Admin-API laeuft ueber einen Unix-Socket, nicht ueber TCP :2019. Grund:
 * Caddy wird dynamisch in jedes Projekt-Netz gehaengt; ein offener TCP-Admin
 * waere dort fuer jeden deployten Container erreichbar und ist
 * unauthentifiziert. Ein Unix-Socket ist ueber das Netz nicht erreichbar.
 *
 * Die Konfiguration wird immer vollstaendig aus der Datenbank gebaut und per
 * POST /load geladen: Die Datenbank ist die Wahrheit, Caddys Zustand ist
 * abgeleitet.
 */

let client: Client | null = null

function adminClient(): Client {
  if (!client) {
    client = new Client('http://caddy-admin.invalid', {
      socketPath: config.CADDY_ADMIN_SOCKET,
      keepAliveTimeout: 10_000,
    })
  }
  return client
}

async function adminRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<string> {
  let res
  try {
    res = await adminClient().request({
      path,
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new AppError(
      'caddy_unreachable',
      `Caddy-Admin-Socket ${config.CADDY_ADMIN_SOCKET} nicht erreichbar: ${(err as Error).message}`,
      503,
    )
  }
  const text = await res.body.text()
  if (res.statusCode >= 400) {
    throw new AppError('caddy_error', `Caddy antwortete ${res.statusCode}: ${text}`, 502)
  }
  return text
}

export async function loadConfig(cfg: Record<string, unknown>): Promise<void> {
  await adminRequest('/load', 'POST', cfg)
}

/** JSON mit sortierten Schlüsseln, damit Caddys Rückgabe vergleichbar ist. */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
    }
    return x
  }
  return JSON.stringify(sort(v))
}

/**
 * Lädt nur, wenn sich die Konfiguration wirklich ändert. Jedes Neuladen
 * schliesst ruhende Keep-Alive-Verbindungen (Go-Server); ein Client, der
 * genau dann seine nächste Anfrage schickt, bekommt "connection closed".
 * Verglichen wird mit dem, was Caddy tatsächlich geladen hat – nicht mit
 * einem Zwischenspeicher, der nach einem Caddy-Neustart falsch wäre.
 */
export async function loadConfigIfChanged(cfg: Record<string, unknown>): Promise<boolean> {
  const current = await getConfig().catch(() => null)
  if (current && canonicalJson(current) === canonicalJson(cfg)) return false
  await loadConfig(cfg)
  return true
}

export async function getConfig(): Promise<unknown> {
  const text = await adminRequest('/config/', 'GET')
  return text ? JSON.parse(text) : null
}

/**
 * Nach dem Laden pruefen, dass die Admin-API weiterhin auf dem Unix-Socket
 * lauscht. Billige Zusicherung gegen den Fall, dass jemand den admin-Block
 * aus dem Konfigurationsbau entfernt.
 */
export async function assertAdminOnUnixSocket(): Promise<void> {
  const cfg = (await getConfig()) as { admin?: { listen?: string } } | null
  const listen = cfg?.admin?.listen
  const expected = adminAddress(config.CADDY_ADMIN_SOCKET)
  if (listen !== expected) {
    throw new AppError(
      'caddy_admin_exposed',
      `Caddy-Admin lauscht auf "${listen ?? 'Standard :2019'}" statt auf "${expected}". ` +
        `Das waere aus jedem Projekt-Netz erreichbar.`,
      500,
    )
  }
}

export async function ping(): Promise<void> {
  await adminRequest('/config/', 'GET')
}
