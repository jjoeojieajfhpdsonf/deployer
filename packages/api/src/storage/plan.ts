import {
  BUILD_CACHE_MAX_AGE_DAYS, RESERVED_SLUGS, SLUG_RE,
  type CleanupItemDto, type CleanupItemKind, type CleanupPlanDto, type OrphanVolumeDto, type StorageSettingsDto,
} from '@airlock/shared'
import type { DfBuildCache, DfContainer, DfImage, DfVolume } from '../drivers/docker.js'
import { isOwnImage } from '../lib/names.js'

/**
 * Nacht 3, Etappe 3: was das Aufräumen freigeben darf. Reine Funktionen –
 * Docker, Datenbank und Dateisystem liefert storage/service.ts als Daten.
 *
 * Grundregeln (Auftrag):
 * - Docker-Objekte nur mit Airlock-Label (`airlock.*`, aus der deployer-Zeit
 *   `deployer.*`). Images fremder Container (Portainer usw.) bleiben.
 * - Nie das aktive Image eines Projekts, nie ein Image, das ein Container
 *   benutzt, nie eins mit einem fremden Tag.
 * - Volumes nie (nur auflisten: findOrphanVolumes).
 * - Frisch Angelegtes (minAgeMs) bleibt: ein Deploy könnte gerade laufen.
 */

/** Höchstens so viele Posten gehen an Oberfläche und MCP (der Rest zählt nur) */
export const PLAN_ITEMS_MAX = 200
/** Fehlgeschlagene Versuche, die wegen ihrer Logs bleiben (wie bisher) */
export const KEEP_FAILED = 10
/** Wegwerf-Container: Build, Scan, Backup, Kopie der Volumes beim Übergang */
export const DISPOSABLE_ROLES = ['build', 'scanner', 'backup-copy', 'backup-restore', 'volume-copy'] as const

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Uploads ohne Projekt bleiben so lange (ein Upload wird gleich danach einem Projekt zugeordnet) */
export const UPLOAD_MAX_AGE_MS = 7 * DAY
/** Ordner gelöschter Projekte und verwaiste Dateien: erst nach dieser Zeit */
export const ORPHAN_MIN_AGE_MS = DAY
/** Standard für Images, Container, Versionsordner: nichts, was jünger ist */
export const DEFAULT_MIN_AGE_MS = HOUR

export interface DeploymentRow {
  id: string
  projectId: string
  status: string
  isActive: boolean
  startedAt: number
  imageRef: string | null
  builtImages: string[]
  /** Ordner der statischen Fassung (artifact.siteVersion ?? version) */
  siteVersion: string | null
}

export interface ProjectRow {
  id: string
  slug: string
  /** Hochgeladene Datei, auf die die Quelle zeigt (Redeploy braucht sie) */
  uploadId: string | null
}

/** Ein Label, das zusätzlich passen muss (Smoke-Test: nur eigene Test-Objekte) */
export interface ScopeLabel { key: string; value: string }

const IN_PROGRESS = new Set(['pending', 'pulling', 'starting', 'healthchecking'])

/**
 * Welche Fassungen bleiben: die aktive, die letzten `keepVersions`
 * abgelösten (Rollback), laufende Versuche und die letzten KEEP_FAILED
 * übrigen (wegen ihrer Logs). Zeilen eines Projekts, neueste zuerst.
 * Dieselbe Regel nimmt pruneOldDeployments nach jedem Deploy.
 */
export function keptDeploymentIds(rowsNewestFirst: Pick<DeploymentRow, 'id' | 'status' | 'isActive'>[], keepVersions: number): Set<string> {
  const keep = new Set<string>()
  let good = 0
  let other = 0
  for (const r of rowsNewestFirst) {
    if (r.isActive) keep.add(r.id)
    else if (r.status === 'superseded') { if (good++ < keepVersions) keep.add(r.id) }
    else if (IN_PROGRESS.has(r.status)) keep.add(r.id)
    else if (other++ < KEEP_FAILED) keep.add(r.id)
  }
  return keep
}

/** Hat das Objekt ein Airlock-Label (neu oder aus der deployer-Zeit)? */
export function isAirlockManaged(labels: Record<string, string>): boolean {
  return labels['airlock.managed'] === 'true' || labels['deployer.managed'] === 'true'
}

const labelOf = (labels: Record<string, string>, key: string): string | null => labels[`airlock.${key}`] ?? labels[`deployer.${key}`] ?? null

const inScope = (labels: Record<string, string>, scope: ScopeLabel | null | undefined) => !scope || labels[scope.key] === scope.value

export interface PlanInput {
  now: number
  projects: ProjectRow[]
  deployments: DeploymentRow[]
  images: DfImage[]
  containers: DfContainer[]
  buildCache: DfBuildCache[]
  settings: StorageSettingsDto
  /** Nichts, was jünger ist (Images, Container, Versionsordner); Standard 1 Stunde */
  minAgeMs?: number
  scope?: ScopeLabel | null
  files?: FileListing
}

export interface FileEntry { name: string; bytes: number; mtimeMs: number }

export interface FileListing {
  /** Ordner unter SITES_DIR: je Slug die Versionsordner und das Ziel von «current» */
  sites: { slug: string; bytes: number; mtimeMs: number; current: string | null; versions: FileEntry[] }[]
  /** Dateien unter DATA_DIR/uploads */
  uploads: FileEntry[]
  /** Ordner unter DATA_DIR/deployments (Name = Deployment-ID) */
  artifacts: FileEntry[]
  /** Dateien unter DATA_DIR/logs/deployments (<id>.log) */
  logs: FileEntry[]
}

export interface PlannedImage { id: string; tags: string[]; project: string | null; reason: string; bytes: number }
export interface PlannedContainer { id: string; name: string; project: string | null; reason: string; bytes: number }
export interface PlannedDeployment { id: string; projectId: string; project: string | null }
export interface PlannedFile { kind: 'site-version' | 'upload' | 'artifact' | 'log'; path: string[]; name: string; project: string | null; reason: string; bytes: number; uploadId?: string }

export interface Plan {
  deployments: PlannedDeployment[]
  images: PlannedImage[]
  containers: PlannedContainer[]
  files: PlannedFile[]
  buildCache: { count: number; bytes: number } | null
}

/** Rein: der ganze Plan aus einem Schnappschuss. */
export function planCleanup(input: PlanInput): Plan {
  const minAge = input.minAgeMs ?? DEFAULT_MIN_AGE_MS
  const slugOfProject = new Map(input.projects.map((p) => [p.id, p.slug]))
  const knownSlugs = new Set(input.projects.map((p) => p.slug))

  // Fassungen: welche bleiben, welche fallen über die Grenze
  const byProject = new Map<string, DeploymentRow[]>()
  for (const d of input.deployments) byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), d])
  const kept = new Set<string>()
  const dropped: PlannedDeployment[] = []
  for (const [projectId, rows] of byProject) {
    rows.sort((a, b) => b.startedAt - a.startedAt)
    const k = keptDeploymentIds(rows, input.settings.keepVersions)
    for (const r of rows) {
      if (k.has(r.id)) kept.add(r.id)
      else dropped.push({ id: r.id, projectId, project: slugOfProject.get(projectId) ?? null })
    }
  }
  const allDeploymentIds = new Set(input.deployments.map((d) => d.id))

  // Geschützt: alles, worauf eine aufbewahrte Fassung zeigt (die aktive ist immer dabei)
  const protectedRefs = new Set<string>()
  for (const d of input.deployments) {
    if (!kept.has(d.id)) continue
    if (d.imageRef) protectedRefs.add(d.imageRef)
    for (const i of d.builtImages) protectedRefs.add(i)
  }
  // Bilder abgelöster Fassungen, die Airlock selbst gebaut hat (auch ohne Label, wie bisher)
  const droppedIds = new Set(dropped.map((d) => d.id))
  const droppedRefs = new Map<string, string | null>()
  for (const d of input.deployments) {
    if (!droppedIds.has(d.id)) continue
    const slug = slugOfProject.get(d.projectId) ?? null
    for (const ref of [...d.builtImages, ...(d.imageRef && isOwnImage(d.imageRef) ? [d.imageRef] : [])]) droppedRefs.set(ref, slug)
  }

  const usedImages = new Set(input.containers.map((c) => c.imageId))

  const images: PlannedImage[] = []
  for (const img of input.images) {
    if (!inScope(img.labels, input.scope)) continue
    const managed = isAirlockManaged(img.labels)
    const droppedTag = img.tags.find((t) => droppedRefs.has(t))
    if (!managed && !droppedTag) continue
    // Nie: benutzt, geschützt, fremder Tag, zu jung
    if (img.containers > 0 || usedImages.has(img.id)) continue
    if (protectedRefs.has(img.id) || img.tags.some((t) => protectedRefs.has(t))) continue
    if (img.tags.some((t) => !isOwnImage(t))) continue
    if (input.now - img.created * 1000 < minAge) continue
    const dep = labelOf(img.labels, 'deployment')
    if (dep && kept.has(dep)) continue
    const slug = labelOf(img.labels, 'project') ?? (droppedTag ? droppedRefs.get(droppedTag) ?? null : null)
    const reason = img.tags.length === 0
      ? 'Ohne Tag (dangling)'
      : slug && !knownSlugs.has(slug)
        ? 'Projekt oder Vorschau gelöscht'
        : 'Ältere Fassung über der Rollback-Grenze'
    images.push({ id: img.id, tags: img.tags, project: slug, reason, bytes: Math.max(0, img.size - Math.max(0, img.sharedSize)) })
  }

  const containers: PlannedContainer[] = []
  for (const c of input.containers) {
    if (!inScope(c.labels, input.scope)) continue
    const role = labelOf(c.labels, 'role')
    const disposable = (role !== null && (DISPOSABLE_ROLES as readonly string[]).includes(role))
      || c.labels['airlock.check'] !== undefined
      || c.labels['airlock.scan'] !== undefined
    if (!disposable) continue
    // Nie ein Dienst eines Compose-Projekts, nie ein laufender, nie ein frischer
    if (labelOf(c.labels, 'compose-service')) continue
    if (!['exited', 'created', 'dead'].includes(c.state)) continue
    if (input.now - c.created * 1000 < minAge) continue
    containers.push({
      id: c.id,
      name: c.names[0] ?? c.id.slice(0, 12),
      project: labelOf(c.labels, 'project'),
      reason: `Gestoppter Wegwerf-Container (${role === 'build' ? 'Build' : role === 'scanner' || c.labels['airlock.check'] !== undefined || c.labels['airlock.scan'] !== undefined ? 'Scan' : role === 'volume-copy' ? 'Kopie' : 'Backup'})`,
      bytes: c.sizeRw,
    })
  }

  // Build-Cache: kann kein Label tragen, enthält keine Daten. Nicht im Smoke-Test (scope).
  let buildCache: Plan['buildCache'] = null
  if (input.settings.pruneBuildCache && !input.scope) {
    const limit = input.now - BUILD_CACHE_MAX_AGE_DAYS * DAY
    const old = input.buildCache.filter((b) => {
      if (b.inUse) return false
      const t = Date.parse(b.lastUsedAt ?? b.createdAt ?? '')
      return Number.isFinite(t) && t < limit
    })
    buildCache = { count: old.length, bytes: old.reduce((s, b) => s + b.size, 0) }
  }

  const files = input.files ? planFiles(input.files, {
    now: input.now, minAgeMs: minAge, knownSlugs, kept, allDeploymentIds, deployments: input.deployments, projects: input.projects,
  }) : []

  return { deployments: dropped, images, containers, files, buildCache }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function planFiles(f: FileListing, o: {
  now: number; minAgeMs: number; knownSlugs: Set<string>; kept: Set<string>; allDeploymentIds: Set<string>
  deployments: DeploymentRow[]; projects: ProjectRow[]
}): PlannedFile[] {
  const out: PlannedFile[] = []
  const slugOfProject = new Map(o.projects.map((p) => [p.id, p.slug]))
  const projectOfDeployment = new Map(o.deployments.map((d) => [d.id, slugOfProject.get(d.projectId) ?? null]))

  // Versionsordner statischer Seiten, auf die keine aufbewahrte Fassung zeigt
  const keptVersions = new Map<string, Set<string>>()
  for (const d of o.deployments) {
    if (!o.kept.has(d.id) || !d.siteVersion) continue
    const slug = slugOfProject.get(d.projectId)
    if (!slug) continue
    keptVersions.set(slug, (keptVersions.get(slug) ?? new Set()).add(d.siteVersion))
  }
  for (const s of f.sites) {
    // «_pause» (Pause-Seiten) und Versteckte gehören nicht zu einem Projekt
    if (s.slug.startsWith('_') || s.slug.startsWith('.') || !SLUG_RE.test(s.slug)) continue
    if (!o.knownSlugs.has(s.slug)) {
      if ((RESERVED_SLUGS as readonly string[]).includes(s.slug)) continue
      if (o.now - s.mtimeMs < ORPHAN_MIN_AGE_MS) continue
      out.push({ kind: 'site-version', path: [s.slug], name: `${s.slug}/`, project: s.slug, reason: 'Seite eines gelöschten Projekts', bytes: s.bytes })
      continue
    }
    const keep = keptVersions.get(s.slug) ?? new Set<string>()
    for (const v of s.versions) {
      if (v.name === 'current' || v.name.startsWith('.') || v.name === s.current || keep.has(v.name)) continue
      if (o.now - v.mtimeMs < o.minAgeMs) continue
      out.push({ kind: 'site-version', path: [s.slug, v.name], name: `${s.slug}/${v.name}`, project: s.slug, reason: 'Fassung über der Rollback-Grenze', bytes: v.bytes })
    }
  }

  // Hochgeladene Dateien, auf die kein Projekt mehr zeigt
  const referencedUploads = new Set(o.projects.map((p) => p.uploadId).filter((x): x is string => !!x))
  for (const u of f.uploads) {
    const m = /^([0-9a-f-]{36})\.(zip|yaml)$/.exec(u.name)
    if (!m || !UUID_RE.test(m[1]!)) continue
    if (referencedUploads.has(m[1]!)) continue
    if (o.now - u.mtimeMs < UPLOAD_MAX_AGE_MS) continue
    out.push({ kind: 'upload', path: [u.name], name: u.name, project: null, reason: 'Kein Projekt benutzt diese Datei mehr', bytes: u.bytes, uploadId: m[1]! })
  }

  // Artefakte (Compose-Dateien) und Deploy-Logs: Fassung entfernt oder über der Grenze
  const orphan = (id: string, mtimeMs: number) => {
    if (o.kept.has(id)) return null
    if (o.allDeploymentIds.has(id)) return 'Fassung über der Rollback-Grenze'
    return o.now - mtimeMs >= o.minAgeMs ? 'Gehört zu keiner Fassung mehr' : null
  }
  for (const a of f.artifacts) {
    if (!UUID_RE.test(a.name)) continue
    const why = orphan(a.name, a.mtimeMs)
    if (why) out.push({ kind: 'artifact', path: [a.name], name: a.name, project: projectOfDeployment.get(a.name) ?? null, reason: why, bytes: a.bytes })
  }
  for (const l of f.logs) {
    const m = /^(.+)\.log$/.exec(l.name)
    if (!m || !UUID_RE.test(m[1]!)) continue
    const why = orphan(m[1]!, l.mtimeMs)
    if (why) out.push({ kind: 'log', path: [l.name], name: l.name, project: projectOfDeployment.get(m[1]!) ?? null, reason: why, bytes: l.bytes })
  }
  return out
}

/** Rein: Plan → Antwort für Oberfläche und MCP. */
export function planToDto(plan: Plan): CleanupPlanDto {
  const items: CleanupItemDto[] = [
    ...plan.deployments.map((d) => ({ kind: 'deployment' as const, name: d.id.slice(0, 8), project: d.project, reason: 'Fassung über der Rollback-Grenze (Eintrag in der Liste)', bytes: null })),
    ...plan.images.map((i) => ({ kind: 'image' as const, name: i.tags[0] ?? i.id.replace(/^sha256:/, '').slice(0, 12), project: i.project, reason: i.reason, bytes: i.bytes })),
    ...plan.containers.map((c) => ({ kind: 'container' as const, name: c.name, project: c.project, reason: c.reason, bytes: c.bytes })),
    ...plan.files.map((f) => ({ kind: f.kind, name: f.name, project: f.project, reason: f.reason, bytes: f.bytes })),
  ]
  const kinds: CleanupItemKind[] = ['deployment', 'image', 'container', 'site-version', 'upload', 'artifact', 'log']
  const byKind = kinds
    .map((kind) => {
      const of = items.filter((i) => i.kind === kind)
      return { kind, count: of.length, bytes: of.reduce((s, i) => s + (i.bytes ?? 0), 0) }
    })
    .filter((k) => k.count > 0)
  const bytes = byKind.reduce((s, k) => s + k.bytes, 0) + (plan.buildCache?.bytes ?? 0)
  return { items: items.slice(0, PLAN_ITEMS_MAX), total: items.length, byKind, buildCache: plan.buildCache, bytes }
}

/**
 * Rein: Volumes mit Airlock-Bezug, deren Projekt es nicht mehr gibt. Bezug:
 * Label airlock.project/deployer.project (mit managed) oder das
 * Compose-Projekt air_<slug>/dep_<slug>. Ohne Projekt-Bezug (z. B. der
 * Cache des Scanners) ist ein Volume nie verwaist.
 */
export function findOrphanVolumes(volumes: DfVolume[], knownSlugs: Set<string>, containers: DfContainer[], scope?: ScopeLabel | null): OrphanVolumeDto[] {
  const mounted = new Set(containers.flatMap((c) => c.mounts))
  const out: OrphanVolumeDto[] = []
  for (const v of volumes) {
    if (!inScope(v.labels, scope)) continue
    let slug: string | null = null
    if (isAirlockManaged(v.labels)) slug = labelOf(v.labels, 'project')
    if (!slug) {
      const m = /^(?:air|dep)_(.+)$/.exec(v.labels['com.docker.compose.project'] ?? '')
      if (m) slug = m[1]!
    }
    if (!slug || knownSlugs.has(slug) || (RESERVED_SLUGS as readonly string[]).includes(slug)) continue
    out.push({ name: v.name, project: slug, bytes: v.size, createdAt: v.createdAt, inUse: (v.refCount ?? 0) > 0 || mounted.has(v.name) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
