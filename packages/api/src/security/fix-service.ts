import { and, desc, eq, inArray } from 'drizzle-orm'
import { fixPrompt, type FixHintDto, type FixRequestDto, type FixWay, type ImageHintDto } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import type { FixChanges } from '../db/schema.js'
import { config } from '../config.js'
import { findProject } from '../domain/projects.js'
import { serverJob, type Scope } from '../lib/scope.js'

/** Fix-Abläufe arbeiten nach der Prüfung am Eingang mit der schon geprüften Projekt-ID. */
const FIX_JOB = serverJob('fix-assistent')
import { activeDeployment, effectiveKind } from '../domain/deployments.js'
import { resolveEnv } from '../domain/env.js'
import { readProjectFiles, listProjectFiles, updateProjectFiles } from '../domain/files.js'
import { audit } from '../domain/audit.js'
import { startDeploy } from '../deploy/pipeline.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { validateFilePath, decodeFiles, type FileInput } from '../lib/local-repo.js'
import { listTags } from '../lib/registry.js'
import { unifiedDiff } from '../lib/diff.js'
import { log } from '../lib/log.js'
import {
  fixWay, affectedPaths, secretLocation, maskContent, containsMask, isWithheld, wayExplanation, tagCandidates, fixedInFrom,
} from './fix-context.js'

/**
 * M8, Etappe 2: «Mit Claude lösen». Claude holt sich über MCP den Kontext
 * eines Befunds und legt einen Vorschlag an; übernommen wird er erst nach
 * Zustimmung (Oberfläche oder MCP mit Bestätigung). Danach deployt Airlock,
 * der Scan nach dem Deploy bestätigt die Behebung.
 */

type Project = Awaited<ReturnType<typeof findProject>>
type Finding = typeof schema.findings.$inferSelect
type FixRow = typeof schema.fixRequests.$inferSelect

/** Etappe 3 hängt hier die GitHub-Verbindung an. */
export let githubConnected: (p: Project) => Promise<boolean> = async () => false
export function setGithubCheck(fn: (p: Project) => Promise<boolean>): void {
  githubConnected = fn
}

export const toFixDto = (r: FixRow): FixRequestDto => ({
  id: r.id, findingId: r.findingId, findingTitle: r.findingTitle, tool: r.tool, way: r.way, status: r.status,
  explanation: r.explanation, diff: r.diff, baseCommit: r.baseCommit, commit: r.commit, branch: r.branch, prUrl: r.prUrl,
  note: r.note, actor: r.actor, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
})

/** Befund laden und prüfen, dass er zum Projekt gehört (sonst 404, wie bei accept_finding). */
export async function findingOf(projectId: string, findingId: string): Promise<Finding> {
  const r = await db
    .select({ f: schema.findings, projectId: schema.scanRuns.projectId })
    .from(schema.findings)
    .innerJoin(schema.scanRuns, eq(schema.findings.scanRunId, schema.scanRuns.id))
    .where(eq(schema.findings.id, findingId))
    .limit(1)
  if (!r[0] || r[0].projectId !== projectId) throw notFound('Befund')
  return r[0].f
}

async function wayFor(p: Project, f: Finding): Promise<FixWay> {
  const active = await activeDeployment(p.id)
  return fixWay(f, { sourceType: p.sourceType, runtimeKind: effectiveKind(p.sourceType, active?.artifact), github: await githubConnected(p) })
}

/* --- Fertige Images -------------------------------------------------------------- */

export async function imageHint(p: Project, f: Finding): Promise<ImageHintDto | null> {
  if (p.sourceType !== 'image') return null
  const active = await activeDeployment(p.id)
  const image = active?.imageRef ?? ((p.sourceConfig as { image?: string }).image ?? null)
  if (!image) return null
  const fixedIn = fixedInFrom(f)
  const tag = image.includes('@') ? null : image.slice(image.lastIndexOf('/') + 1).split(':')[1] ?? 'latest'
  if (!tag || !/\d/.test(tag)) {
    return { image, fixedIn, candidates: [], note: tag === 'latest' || !tag ? 'Das Image läuft ohne Versionsnummer im Tag (latest oder Digest). Neu ziehen per Deploy holt die aktuelle Fassung.' : 'Der Tag enthält keine Versionsnummer; Kandidaten lassen sich nicht bestimmen.' }
  }
  try {
    const candidates = tagCandidates(tag, await listTags(image, config.DOCKER_HUB_API))
    return {
      image, fixedIn, candidates,
      note: candidates.length ? 'Kandidaten derselben Linie; ob sie das Paket wirklich aktualisieren, zeigt erst der Scan nach dem Wechsel.' : 'Keine neuere Version derselben Linie gefunden.',
    }
  } catch (err) {
    return { image, fixedIn, candidates: [], note: `Registry nicht erreichbar: ${(err as Error).message.slice(0, 120)}` }
  }
}

/* --- Hinweis und Auftrag (Oberfläche) -------------------------------------------- */

export async function fixHint(scope: Scope, idOrSlug: string, findingId: string): Promise<FixHintDto> {
  const p = await findProject(scope, idOrSlug)
  const f = await findingOf(p.id, findingId)
  const way = await wayFor(p, f)
  const prompt = way === 'files' || way === 'github' || way === 'repo'
    ? fixPrompt({ projectName: p.name, slug: p.slug, findingId: f.id, title: f.title, severity: f.severity, way })
    : null
  return { way, prompt, explanation: wayExplanation(way), image: way === 'image' ? await imageHint(p, f) : null }
}

/* --- get_fix_context (MCP) --------------------------------------------------------- */

export interface FixContext {
  project: { slug: string; name: string; source: string }
  finding: { id: string; tool: string; severity: string; title: string; location: string; description: string; fix: string; status: string }
  way: FixWay
  explanation: string
  files: { path: string; content: string }[]
  /** Dateien, die es gibt, aber nicht mitgeschickt werden (Env-Dateien, Schlüssel) */
  withheld: string[]
  /** Alle Pfade des Repos, falls Claude weitere Dateien mit read_files holen will */
  repo_paths: string[]
  masked: { secret_lines: number; env_values: number }
  commit: string | null
  image: ImageHintDto | null
  next: string
}

export async function getFixContext(scope: Scope, idOrSlug: string, findingId: string): Promise<FixContext> {
  const p = await findProject(scope, idOrSlug)
  const f = await findingOf(p.id, findingId)
  const way = await wayFor(p, f)
  const base: FixContext = {
    project: { slug: p.slug, name: p.name, source: p.sourceType },
    finding: { id: f.id, tool: f.tool, severity: f.severity, title: f.title, location: f.location, description: f.description, fix: f.fix, status: f.status },
    way, explanation: wayExplanation(way), files: [], withheld: [], repo_paths: [], masked: { secret_lines: 0, env_values: 0 }, commit: null, image: null,
    next: '',
  }
  if (way === 'header') return { ...base, next: `set_security_header mit project "${p.slug}" aufrufen; keine Codeänderung nötig.` }
  if (way === 'image') return { ...base, image: await imageHint(p, f), next: 'Keine Codeänderung möglich. Eine neuere Image-Version vorschlagen; Joël stellt das Projekt selbst um.' }
  const source = way === 'files' ? await localSource(p) : way === 'github' ? await githubSource(p) : null
  if (!source) {
    return { ...base, next: 'Die Änderung im Git-Repo des Projekts auf einem eigenen Branch machen; Airlock kennt die Dateien nicht.' }
  }

  const paths = source.paths
  const wanted = affectedPaths(f, paths)
  const secret = secretLocation(f)
  // Alle Werte der Projekt-Env, auch nicht geheime: an Claude gehen keine Env-Werte (SPEC)
  const envValues = Object.values(await resolveEnv(p.id))
  const read = wanted.length ? await source.read(wanted) : []
  let secretLines = 0
  let envHits = 0
  const files = read
    .filter((x) => x.encoding === 'utf8')
    .map((x) => {
      const lines = secret && (x.path === secret.path || x.path.endsWith(`/${secret.path}`)) ? [secret.line] : []
      const m = maskContent(x.content, { secretLines: lines, envValues })
      secretLines += m.maskedLines
      envHits += m.maskedValues
      return { path: x.path, content: m.content }
    })
  return {
    ...base,
    files,
    withheld: paths.filter(isWithheld),
    repo_paths: paths.filter((x) => !isWithheld(x)).slice(0, 500),
    masked: { secret_lines: secretLines, env_values: envHits },
    commit: source.commit,
    next:
      'Änderung mit propose_fix vorschlagen: geänderte Dateien vollständig (nicht als Diff), gelöschte unter delete, kurze Erklärung. ' +
      (way === 'github' ? 'Airlock legt dafür einen Branch und einen Pull Request an. ' : '') +
      'Ersetzte Stellen («Airlock: …») nicht zurückschreiben: ein Secret gehört in die Projekt-Env (Oberfläche), nicht in den Code.',
  }
}

/** Dateien eines Repos, aus dem der Kontext liest (lokal oder über GitHub). */
export interface RepoSource {
  commit: string | null
  paths: string[]
  read: (paths: string[]) => Promise<{ path: string; content: string; encoding: 'utf8' | 'base64' }[]>
}

async function localSource(p: Project): Promise<RepoSource> {
  const listing = await listProjectFiles(FIX_JOB, p.id)
  return { commit: listing.commit, paths: listing.files.map((x) => x.path), read: async (paths) => (await readProjectFiles(FIX_JOB, p.id, paths)).files }
}

/** Etappe 3: Dateien über die GitHub App. */
export let githubSource: (p: Project) => Promise<RepoSource | null> = async () => null
export function setGithubSource(fn: typeof githubSource): void {
  githubSource = fn
}

/* --- Vorschlag ------------------------------------------------------------------------ */

const MAX_EXPLANATION = 4000

export async function proposeFix(
  scope: Scope,
  idOrSlug: string,
  findingId: string,
  input: { files?: FileInput[]; delete?: string[]; explanation: string },
  actor: string,
): Promise<FixRequestDto> {
  const p = await findProject(scope, idOrSlug)
  const f = await findingOf(p.id, findingId)
  if (f.status !== 'open') throw conflict(`Der Befund ist nicht mehr offen (${f.status === 'fixed' ? 'behoben' : 'akzeptiert'})`)
  const way = await wayFor(p, f)
  if (way === 'header') throw badRequest('Header-Befunde löst set_security_header, ohne Codeänderung')
  if (way === 'image') throw badRequest('Bei einem fertigen Image ist keine Codeänderung möglich; get_fix_context nennt neuere Versionen')
  if (way === 'repo' || way === 'none') throw badRequest('Für dieses Projekt kennt Airlock die Dateien nicht; die Änderung gehört ins Git-Repo')
  const files = input.files ?? []
  const remove = (input.delete ?? []).map(validateFilePath)
  if (!files.length && !remove.length) throw badRequest('Keine Dateien im Vorschlag')
  const explanation = input.explanation.trim().slice(0, MAX_EXPLANATION)
  if (explanation.length < 10) throw badRequest('Bitte kurz erklären, was die Änderung behebt')
  const decoded = decodeFiles(files) // prüft Pfade und Grössen
  for (const x of decoded) {
    if (isWithheld(x.path)) throw badRequest(`${x.path}: Env-Dateien und Schlüssel ändert Airlock nicht über Vorschläge`)
    if (containsMask(x.data.toString('utf8'))) throw badRequest(`${x.path} enthält einen Platzhalter von Airlock («Airlock: …»); das Secret gehört in die Projekt-Env, nicht in den Code`)
  }

  let diff = ''
  let baseCommit: string | null = null
  if (way === 'files') {
    const listing = await listProjectFiles(FIX_JOB, p.id)
    baseCommit = listing.commit
    const existing = new Set(listing.files.map((x) => x.path))
    const touched = [...decoded.map((x) => x.path), ...remove].filter((x) => existing.has(x))
    const old = new Map(touched.length ? (await readProjectFiles(FIX_JOB, p.id, touched)).files.map((x) => [x.path, x]) : [])
    const parts: string[] = []
    for (const x of decoded) {
      const before = old.get(x.path)
      const oldText = before ? (before.encoding === 'utf8' ? before.content : '«Binärdatei»') : null
      const d = unifiedDiff(x.path, oldText, x.data.includes(0) ? '«Binärdatei»' : x.data.toString('utf8'))
      if (d) parts.push(d)
    }
    for (const r of remove) {
      if (!existing.has(r)) throw badRequest(`"${r}" gibt es im Projekt nicht`)
      const before = old.get(r)
      parts.push(unifiedDiff(r, before?.encoding === 'utf8' ? before.content : '«Binärdatei»', null))
    }
    diff = parts.join('\n')
    if (!diff) throw badRequest('Der Vorschlag ändert nichts am aktuellen Stand')
  }

  const changes: FixChanges = { files: files.map((x, i) => ({ path: decoded[i]!.path, content: x.content, encoding: x.encoding ?? 'utf8' })), delete: remove }
  const row = await db.transaction(async (tx) => {
    // Ein neuer Vorschlag ersetzt ältere offene für denselben Befund
    await tx
      .update(schema.fixRequests)
      .set({ status: 'rejected', note: 'durch einen neueren Vorschlag ersetzt', updatedAt: new Date() })
      .where(and(eq(schema.fixRequests.projectId, p.id), eq(schema.fixRequests.fingerprint, f.fingerprint), eq(schema.fixRequests.status, 'proposed')))
    return (await tx.insert(schema.fixRequests).values({
      projectId: p.id, findingId: f.id, fingerprint: f.fingerprint, findingTitle: f.title, tool: f.tool,
      way: way === 'github' ? 'github' : 'mcp', status: 'proposed', explanation, diff, changes, baseCommit, actor,
    }).returning())[0]!
  })
  await audit({
    actor, action: 'fix.propose', targetType: 'project', targetId: p.id,
    params: { fix: row.id, finding: f.id, title: f.title, files: decoded.map((x) => x.path), delete: remove }, result: 'ok',
  })
  // Etappe 3: Pull Request statt Vorschlag in Airlock
  if (way === 'github') return toFixDto(await openPullRequestHook(row, p, actor))
  return toFixDto(row)
}

/** Etappe 3 ersetzt das durch den Weg über GitHub. */
export let openPullRequestHook: (row: FixRow, p: Project, actor: string) => Promise<FixRow> = async (row) => row
export function setPullRequestHook(fn: typeof openPullRequestHook): void {
  openPullRequestHook = fn
}

async function loadFix(scope: Scope, projectId: string | null, fixId: string): Promise<FixRow> {
  const r = (await db.select().from(schema.fixRequests).where(eq(schema.fixRequests.id, fixId)).limit(1))[0]
  if (!r || (projectId && r.projectId !== projectId)) throw notFound('Vorschlag')
  // M9: Vorschlag eines Projekts einer anderen Umgebung = unbekannt
  await findProject(scope, r.projectId).catch(() => {
    throw notFound('Vorschlag')
  })
  return r
}

/**
 * Vorschlag übernehmen: neue Version im lokalen Repo, Deploy (der Scan danach
 * bestätigt die Behebung). Nur auf dem Stand, auf dem der Vorschlag beruht.
 */
export async function applyFix(scope: Scope, fixId: string, actor: string, o: { projectId?: string } = {}): Promise<FixRequestDto> {
  const fix = await loadFix(scope, o.projectId ?? null, fixId)
  if (fix.status !== 'proposed') throw conflict(`Der Vorschlag ist nicht mehr offen (Status «${fix.status}»)`)
  if (fix.way !== 'mcp' && fix.way !== 'api') throw badRequest('Dieser Vorschlag läuft über einen Pull Request')
  const listing = await listProjectFiles(FIX_JOB, fix.projectId)
  if (listing.commit !== fix.baseCommit) {
    await db.update(schema.fixRequests).set({ status: 'rejected', note: 'veraltet: die Dateien haben sich seit dem Vorschlag geändert', updatedAt: new Date() }).where(eq(schema.fixRequests.id, fix.id))
    throw new AppError('stale_fix', 'Die Dateien haben sich seit dem Vorschlag geändert. Bitte einen neuen Vorschlag anlegen lassen.', 409)
  }
  const files = (fix.changes.files ?? []).map((x) => ({ path: x.path, content: x.content, encoding: x.encoding }))
  const r = await updateProjectFiles(FIX_JOB, fix.projectId, { files, delete: fix.changes.delete, message: `Fix: ${fix.findingTitle}` }, actor)
  let deploymentId: string | null = null
  let status: FixRow['status'] = 'applied'
  let note: string | null = 'Deploy läuft; der Scan danach bestätigt die Behebung.'
  try {
    deploymentId = (await startDeploy(FIX_JOB, fix.projectId, actor)).id
  } catch (err) {
    status = 'failed'
    note = `Commit ${r.commit.slice(0, 12)} angelegt, Deploy nicht gestartet: ${(err as Error).message.slice(0, 200)}`
    log.warn('Fix übernommen, Deploy gescheitert', { fix: fix.id, err: String(err) })
  }
  const row = (await db.update(schema.fixRequests).set({ status, commit: r.commit, deploymentId, note, updatedAt: new Date() }).where(eq(schema.fixRequests.id, fix.id)).returning())[0]!
  await audit({ actor, action: 'fix.apply', targetType: 'project', targetId: fix.projectId, params: { fix: fix.id, title: fix.findingTitle, commit: r.commit, deployment: deploymentId }, result: status === 'failed' ? 'error' : 'ok' })
  return toFixDto(row)
}

export async function rejectFix(scope: Scope, fixId: string, actor: string, o: { projectId?: string } = {}): Promise<FixRequestDto> {
  const fix = await loadFix(scope, o.projectId ?? null, fixId)
  if (fix.status !== 'proposed') throw conflict(`Der Vorschlag ist nicht mehr offen (Status «${fix.status}»)`)
  const row = (await db.update(schema.fixRequests).set({ status: 'rejected', note: 'verworfen', updatedAt: new Date() }).where(eq(schema.fixRequests.id, fix.id)).returning())[0]!
  await audit({ actor, action: 'fix.reject', targetType: 'project', targetId: fix.projectId, params: { fix: fix.id, title: fix.findingTitle }, result: 'ok' })
  return toFixDto(row)
}

export async function listFixRequests(scope: Scope, idOrSlug: string, limit = 30): Promise<FixRequestDto[]> {
  const p = await findProject(scope, idOrSlug)
  const rows = await db.select().from(schema.fixRequests).where(eq(schema.fixRequests.projectId, p.id)).orderBy(desc(schema.fixRequests.createdAt)).limit(limit)
  // Scheiterte der Deploy nach dem Übernehmen, kommt kein Scan: hier nachtragen
  const waiting = rows.filter((r) => r.status === 'applied' && r.deploymentId)
  if (waiting.length) {
    const deps = await db.select({ id: schema.deployments.id, status: schema.deployments.status, error: schema.deployments.errorMessage })
      .from(schema.deployments).where(inArray(schema.deployments.id, waiting.map((r) => r.deploymentId!)))
    for (const d of deps.filter((x) => x.status === 'failed')) {
      const r = waiting.find((x) => x.deploymentId === d.id)!
      r.status = 'failed'
      r.note = `Commit ${r.commit?.slice(0, 12) ?? ''} angelegt, Deploy gescheitert: ${(d.error ?? '').slice(0, 200)}`
      await db.update(schema.fixRequests).set({ status: r.status, note: r.note, updatedAt: new Date() }).where(eq(schema.fixRequests.id, r.id))
    }
  }
  return rows.map(toFixDto)
}

/**
 * Nach einem abgeschlossenen Scan (scan.ts, finalize): übernommene bzw.
 * gemergte Vorschläge prüfen. Fehlt der Befund, ist er behoben («verified»);
 * nur für Werkzeuge, die durchliefen. Ist er nach dem Scan seines Deploys
 * noch offen, steht das im Vermerk.
 */
export async function verifyFixesAfterScan(o: { projectId: string; deploymentId: string | null; openFingerprints: Set<string>; checkedTools: Set<string> }): Promise<string[]> {
  const pending = await db
    .select()
    .from(schema.fixRequests)
    .where(and(eq(schema.fixRequests.projectId, o.projectId), inArray(schema.fixRequests.status, ['applied', 'merged'])))
  const verified: string[] = []
  for (const fx of pending) {
    if (!o.checkedTools.has(fx.tool)) continue
    if (!o.openFingerprints.has(fx.fingerprint)) {
      await db.update(schema.fixRequests).set({ status: 'verified', note: 'Der Nachscan findet den Befund nicht mehr.', updatedAt: new Date() }).where(eq(schema.fixRequests.id, fx.id))
      verified.push(fx.id)
    } else if (fx.deploymentId && fx.deploymentId === o.deploymentId) {
      await db.update(schema.fixRequests).set({ note: 'Der Nachscan findet den Befund noch: die Änderung hat ihn nicht behoben.', updatedAt: new Date() }).where(eq(schema.fixRequests.id, fx.id))
    }
  }
  return verified
}
