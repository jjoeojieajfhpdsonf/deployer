import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { findProject } from '../domain/projects.js'
import { findExternalTarget } from '../security/external-targets.js'
import { environmentById, environmentBySlug, defaultEnvironmentId } from '../domain/environments.js'
import { inEnvironment, allows, type EnvScope, type Scope } from '../lib/scope.js'
import { notFound } from '../lib/errors.js'

/**
 * M9: Umgebungen in der REST-API.
 *
 * request.scope setzt der Auth-Guard (http/auth.ts): API-Token → seine
 * Umgebung, Anmeldung → alle Umgebungen für Einzelobjekte.
 *
 * Der Guard hier prüft ZENTRAL jeden Pfad mit einem Objekt (:id), bevor ein
 * Handler läuft: Gehört das Objekt zu einer Umgebung, die der Aufrufer nicht
 * sieht, kommt dieselbe 404 wie für ein unbekanntes Objekt. So kann kein
 * Handler die Prüfung vergessen; die Service-Schicht prüft zusätzlich selbst
 * (findProject mit Scope).
 */

declare module 'fastify' {
  interface FastifyRequest {
    scope: Scope
  }
}

type Params = { id?: string; env?: string }

/** Umgebung zu einem Slug oder einer ID; null, wenn unbekannt. */
export function resolveEnvironment(key: string): string | null {
  return (environmentBySlug(key) ?? environmentById(key))?.id ?? null
}

/**
 * Scope für eine Liste (Projekte, Domains, Tokens, Audit, externe Ziele):
 * aus dem Pfad (/environments/:env/…) oder ?environment=; ohne Angabe die
 * Standard-Umgebung. Ein API-Token bekommt immer nur seine eigene – eine
 * andere angefragte Umgebung ist «nicht gefunden».
 */
export function listScopeFor(request: FastifyRequest): EnvScope {
  const wanted = (request.params as Params | undefined)?.env ?? (request.query as { environment?: string } | undefined)?.environment
  const scope = request.scope
  if (scope.kind === 'env') {
    if (wanted && resolveEnvironment(wanted) !== scope.envId) throw notFound('Umgebung')
    return scope
  }
  if (wanted) {
    const id = resolveEnvironment(wanted)
    if (!id) throw notFound('Umgebung')
    return inEnvironment(id)
  }
  return inEnvironment(defaultEnvironmentId())
}

/** Umgebung eines Scan-Laufs (Projekt oder externes Ziel). */
async function scanEnvironment(runId: string): Promise<string | null | undefined> {
  const run = (await db.select({ projectId: schema.scanRuns.projectId, targetId: schema.scanRuns.externalTargetId }).from(schema.scanRuns).where(eq(schema.scanRuns.id, runId)).limit(1))[0]
  if (!run) return undefined
  if (run.projectId) return (await db.select({ env: schema.projects.environmentId }).from(schema.projects).where(eq(schema.projects.id, run.projectId)).limit(1))[0]?.env
  if (run.targetId) return (await db.select({ env: schema.externalTargets.environmentId }).from(schema.externalTargets).where(eq(schema.externalTargets.id, run.targetId)).limit(1))[0]?.env
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prüft das Objekt eines Pfads gegen den Scope; wirft «nicht gefunden». */
export async function assertPathObject(route: string, params: Params, scope: Scope): Promise<void> {
  const id = params.id
  if (route.startsWith('/api/v1/environments/:env')) {
    const env = params.env ? resolveEnvironment(params.env) : null
    if (!env || !allows(scope, env)) throw notFound('Umgebung')
  }
  if (!id) return
  if (route.startsWith('/api/v1/projects/:id')) {
    await findProject(scope, id)
    return
  }
  if (route.startsWith('/api/v1/external-targets/:id')) {
    await findExternalTarget(scope, id)
    return
  }
  if (scope.kind !== 'env') return // Anmeldung: alle Umgebungen; nur noch Existenz prüfen die Handler
  if (route.startsWith('/api/v1/deployments/:id')) {
    if (!UUID_RE.test(id)) throw notFound('Deployment')
    const row = (await db.select({ env: schema.projects.environmentId }).from(schema.deployments)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.deployments.projectId))
      .where(eq(schema.deployments.id, id)).limit(1))[0]
    if (!row || !allows(scope, row.env)) throw notFound('Deployment')
    return
  }
  if (route.startsWith('/api/v1/scans/:id')) {
    if (!UUID_RE.test(id)) throw notFound('Scan')
    const env = await scanEnvironment(id)
    if (env === undefined || !allows(scope, env)) throw notFound('Scan')
    return
  }
  if (route.startsWith('/api/v1/findings/:id')) {
    if (!UUID_RE.test(id)) throw notFound('Befund')
    const f = (await db.select({ run: schema.findings.scanRunId }).from(schema.findings).where(eq(schema.findings.id, id)).limit(1))[0]
    const env = f ? await scanEnvironment(f.run) : undefined
    if (env === undefined || !allows(scope, env)) throw notFound('Befund')
    return
  }
  if (route.startsWith('/api/v1/tokens/:id')) {
    if (!UUID_RE.test(id)) throw notFound('Token')
    const t = (await db.select({ env: schema.apiTokens.environmentId }).from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).limit(1))[0]
    if (!t || !allows(scope, t.env)) throw notFound('Token')
  }
}

/** Präfixe mit Objekt im Pfad, die der Guard kennt. Ein neuer Pfad mit :id ohne Eintrag hier fällt im Test auf. */
export const GUARDED_PREFIXES = [
  '/api/v1/projects/:id', '/api/v1/external-targets/:id', '/api/v1/deployments/:id', '/api/v1/scans/:id',
  '/api/v1/findings/:id', '/api/v1/tokens/:id', '/api/v1/environments/:env',
  // Nacht 3, Etappe 1: Passkeys und Sitzungen gehören zum Konto, nicht zu einer Umgebung;
  // nur mit Anmeldung (der Auth-Wächter weist Tokens unter /auth/ ab)
  '/api/v1/auth/passkeys/:id', '/api/v1/auth/sessions/:id',
] as const

export function registerScopeGuard(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url
    if (!route?.startsWith('/api/') || !request.scope) return
    await assertPathObject(route, (request.params ?? {}) as Params, request.scope)
  })
}
