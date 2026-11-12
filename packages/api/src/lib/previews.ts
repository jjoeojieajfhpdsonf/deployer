import { createHash } from 'node:crypto'
import {
  PREVIEW_IDLE_DAYS, PREVIEW_MAX, RESERVED_PUBLIC_LABELS, UI_HOST_LABEL, previewStateLabel,
  type PreviewScanDto, type PreviewState,
} from '@airlock/shared'

/**
 * Etappe 6 «Vorschau-Deploys» – der reine Teil (ohne Datenbank, Docker und
 * GitHub), damit Slug, Entscheidungen, Aufräumen, Vererbung und Texte
 * testbar sind. domain/previews.ts hängt die echten Wege an.
 *
 *   Adresse:   <branch-slug>--<projekt>.int.<basis>, ein DNS-Label ≤ 63
 *   Auslöser:  Abfrage der GitHub-API (wie Auto-Deploy), kein Webhook –
 *              Airlock ist nie öffentlich erreichbar. Ein neuer Branch-Kopf
 *              gilt als Push, eine neue PR-Nummer als «opened».
 *   Aufräumen: PR zu/gemergt, Branch gelöscht, 7 Tage ohne Push; höchstens
 *              3 je Projekt, die mit dem ältesten Push fällt raus.
 */

/** Ein DNS-Label hat höchstens 63 Zeichen */
export const LABEL_MAX = 63
/** Trenner zwischen Branch und Projekt (wie Etappe 4: <dienst>--<projekt>) */
export const PREVIEW_SEP = '--'

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Gültiges DNS-Label für eine Vorschau? Kleinbuchstaben, Ziffern, Bindestrich,
 * nicht am Rand, ≤ 63 Zeichen. Dazu nie «--» an Stelle 3 und 4: solche Labels
 * sind für IDN reserviert («xn--…», RFC 5890) und werden teils abgelehnt.
 */
export function isPreviewLabel(label: string): boolean {
  return label.length <= LABEL_MAX && LABEL_RE.test(label) && label.slice(2, 4) !== '--'
}

/**
 * Branch-Name → Teil des Labels: Kleinbuchstaben, ä/ö/ü → ae/oe/ue, ß → ss,
 * Akzente weg, alles andere (/, _, ., Leerzeichen, Emoji …) → ein Bindestrich,
 * keine Bindestriche am Rand. Läufe von Bindestrichen werden zu einem – so
 * steht «--» im Label nur als Trenner zum Projekt.
 */
export function branchSlug(branch: string): string {
  return branch
    .replace(/^refs\/heads\//, '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6)

/** Namen, die nie eine Vorschau tragen (Oberfläche, Statusseite, interne Basis …) */
const RESERVED = new Set<string>([...RESERVED_PUBLIC_LABELS, UI_HOST_LABEL, 'airlock', 'deployer'])

/**
 * Label einer Vorschau: <branch-slug>--<projekt>. Zu lang, ungültig oder
 * belegt (Projekt, interne Adresse, Dienst-Adresse <dienst>--<projekt> aus
 * Etappe 4, andere Vorschau) → Branch-Teil gekürzt plus Hash-Suffix aus dem
 * vollen Branch-Namen. Gleicher Branch ergibt immer dieselbe Adresse.
 */
export function previewLabel(branch: string, projectSlug: string, isTaken: (label: string) => boolean = () => false): string {
  const tail = `${PREVIEW_SEP}${projectSlug}`
  const room = LABEL_MAX - tail.length
  if (room < 8) throw new Error(`Der Kurzname «${projectSlug}» ist für eine Vorschau-Adresse zu lang`)
  const b = branchSlug(branch) || 'branch'
  const hashed = (seed: string) => {
    const h = shortHash(seed)
    const cut = b.slice(0, room - h.length - 1).replace(/-+$/, '')
    return `${cut || 'b'}-${h}`
  }
  const candidates = [b, hashed(branch)]
  for (let i = 2; i < 50; i++) candidates.push(hashed(`${branch}#${i}`))
  for (const c of candidates) {
    const label = `${c}${tail}`
    if (!isPreviewLabel(label) || RESERVED.has(label) || isTaken(label)) continue
    return label
  }
  throw new Error(`Keine freie Vorschau-Adresse für den Branch «${branch}» gefunden`)
}

/**
 * Umgekehrt (Etappe 4 «+ Dienst»): würde die Dienst-Adresse <dienst>--<projekt>
 * eine bestehende Vorschau-Adresse überdecken? Dann den Namen ablehnen.
 */
export function serviceLabelClash(service: string, projectSlug: string, previewLabels: Iterable<string>): string | null {
  const label = `${service.toLowerCase()}${PREVIEW_SEP}${projectSlug}`
  for (const l of previewLabels) if (l === label) return label
  return null
}

/* --- Wo die Vorschau erreichbar ist: nur intern ----------------------------------- */

export type InternalTarget = 'lan' | 'tailnet'

export class PreviewPublicError extends Error {
  constructor() {
    super('Vorschauen sind immer nur intern erreichbar (Heimnetz/Tailnet), nie öffentlich.')
  }
}

/**
 * Ziele einer Vorschau: die internen Wege des Projekts (LAN und/oder
 * Tailnet), ohne «öffentlich». Hat das Projekt keinen internen Weg, gilt
 * Tailnet (Standard neuer Projekte).
 */
export function previewTargets(parentTargets: readonly string[]): InternalTarget[] {
  const out = [...new Set(parentTargets.filter((t): t is InternalTarget => t === 'lan' || t === 'tailnet'))].sort()
  return out.length ? out : ['tailnet']
}

/** Durchsetzung am Server: eine Vorschau bekommt nie ein öffentliches Ziel */
export function assertPreviewTargets(targets: readonly string[]): void {
  if (targets.some((t) => t !== 'lan' && t !== 'tailnet')) throw new PreviewPublicError()
}

/**
 * Caddy-Abgleich (zweite Sicherung): Routen mit Ziel «öffentlich» eines
 * Vorschau-Projekts fallen weg, falls je eine in der Datenbank stünde.
 */
export function withoutPublicPreviewRoutes<T extends { projectId: string; target: string }>(rows: T[], isPreview: (projectId: string) => boolean): T[] {
  return rows.filter((r) => !(r.target === 'public' && isPreview(r.projectId)))
}

/* --- Geht das bei diesem Projekt? ------------------------------------------------------ */

export function previewAbility(o: { sourceType: string; repoUrl: string | null; githubRepo: string | null; isPreview?: boolean }): { available: boolean; reason: string | null } {
  if (o.isPreview) return { available: false, reason: 'Eine Vorschau hat selbst keine Vorschauen.' }
  if (o.sourceType === 'files') return { available: false, reason: 'Vorschauen gibt es nur für Projekte aus einem Git-Repo; dieses Projekt kommt aus dem Chat.' }
  if (o.sourceType === 'image') return { available: false, reason: 'Vorschauen gibt es nur für Projekte aus einem Git-Repo; dieses Projekt läuft aus einem fertigen Image.' }
  if (!o.repoUrl) return { available: false, reason: 'Vorschauen brauchen ein Git-Repo; die Quelle dieses Projekts ist hochgeladen.' }
  if (!o.githubRepo) return { available: false, reason: 'Das Repo ist nicht mit der GitHub-App verbunden (Server › GitHub). Ohne App sieht Airlock keine Branches und Pull Requests.' }
  return { available: true, reason: null }
}

/* --- Entscheidungen bei jeder Abfrage ---------------------------------------------- */

export interface PreviewSeenState {
  heads: Record<string, string>
  prs: number[]
}

export interface PlanPull {
  number: number
  url: string
  branch: string
  sha: string
  /** Kopf liegt in einem anderen Repo (Fork): nie deployen – fremder Code */
  fromFork: boolean
}

export interface PlanPreview {
  id: string
  branch: string
  headSha: string | null
  lastPushAt: Date
  prNumber: number | null
  /** Deploy läuft gerade: nicht anfassen */
  busy: boolean
}

export type RemoveReason = 'pr_closed' | 'branch_deleted' | 'idle' | 'limit' | 'disabled'

export const REMOVE_REASON_TEXT: Record<RemoveReason, string> = {
  pr_closed: 'Pull Request geschlossen oder gemergt',
  branch_deleted: 'Branch gelöscht',
  idle: `${PREVIEW_IDLE_DAYS} Tage ohne Push`,
  limit: `mehr als ${PREVIEW_MAX} Vorschauen, die mit dem ältesten Push fällt raus`,
  disabled: 'Vorschauen am Projekt ausgeschaltet',
}

export interface PlanInput {
  now: Date
  defaultBranch: string
  branches: { name: string; sha: string }[]
  pulls: PlanPull[]
  /** null: erste Abfrage nach dem Einschalten */
  seen: PreviewSeenState | null
  previews: PlanPreview[]
  max?: number
  idleDays?: number
}

type Pr = { number: number; url: string } | null

export interface PlanOutput {
  seen: PreviewSeenState
  create: { branch: string; sha: string; pr: Pr }[]
  /** Neuer Push auf einen Branch mit Vorschau */
  update: { id: string; branch: string; sha: string; pr: Pr }[]
  /** Pull Request dazugekommen, gewechselt oder weg (ohne Push) */
  link: { id: string; pr: Pr }[]
  remove: { id: string; branch: string; reason: RemoveReason }[]
}

/**
 * Was bei dieser Abfrage zu tun ist – rein.
 *
 * - Neue Vorschau: Branch (nicht der Hauptbranch) mit neuem Kopf seit der
 *   letzten Abfrage (Push) oder mit neu geöffnetem Pull Request. Bei der
 *   ersten Abfrage nach dem Einschalten nur Branches mit offenem PR.
 * - Bestehende Vorschau: neuer Kopf → neu deployen.
 * - Aufräumen: Branch gelöscht; ihr Pull Request geschlossen oder gemergt;
 *   7 Tage ohne Push; mehr als 3 → die mit dem ältesten Push fällt raus.
 * - Pull Requests aus Forks zählen nie (fremder Code auf dem Homeserver).
 */
export function planPreviews(i: PlanInput): PlanOutput {
  const max = i.max ?? PREVIEW_MAX
  const idleMs = (i.idleDays ?? PREVIEW_IDLE_DAYS) * 86_400_000
  const heads = new Map(i.branches.map((b) => [b.name, b.sha]))
  const prOf = new Map<string, PlanPull>()
  for (const p of i.pulls) {
    if (p.fromFork || p.branch === i.defaultBranch) continue
    const have = prOf.get(p.branch)
    if (!have || p.number > have.number) prOf.set(p.branch, p)
  }
  const prRef = (b: string): Pr => {
    const p = prOf.get(b)
    return p ? { number: p.number, url: p.url } : null
  }

  const remove: PlanOutput['remove'] = []
  const update: PlanOutput['update'] = []
  const link: PlanOutput['link'] = []
  const kept: { p: PlanPreview; at: number }[] = []
  for (const p of i.previews) {
    const head = heads.get(p.branch)
    if (head === undefined || p.branch === i.defaultBranch) { remove.push({ id: p.id, branch: p.branch, reason: 'branch_deleted' }); continue }
    if (p.prNumber !== null && !prOf.has(p.branch)) { remove.push({ id: p.id, branch: p.branch, reason: 'pr_closed' }); continue }
    const pushed = head !== p.headSha
    if (!pushed && !p.busy && i.now.getTime() - p.lastPushAt.getTime() > idleMs) { remove.push({ id: p.id, branch: p.branch, reason: 'idle' }); continue }
    const pr = prRef(p.branch)
    if ((pr?.number ?? null) !== p.prNumber) link.push({ id: p.id, pr })
    if (pushed && !p.busy) update.push({ id: p.id, branch: p.branch, sha: head, pr })
    kept.push({ p, at: pushed || p.busy ? i.now.getTime() : p.lastPushAt.getTime() })
  }

  const known = new Set(i.previews.map((p) => p.branch))
  const seenHeads = i.seen?.heads ?? {}
  const seenPrs = new Set(i.seen?.prs ?? [])
  const fresh: { branch: string; sha: string; pr: Pr }[] = []
  for (const [branch, sha] of heads) {
    if (branch === i.defaultBranch || known.has(branch)) continue
    const pr = prOf.get(branch)
    const pushed = i.seen !== null && seenHeads[branch] !== sha
    const opened = pr !== undefined && !seenPrs.has(pr.number)
    if (pushed || opened) fresh.push({ branch, sha, pr: prRef(branch) })
  }
  // Neue zuerst nach PR-Nummer (neuester PR vorn), dann nach Namen – stabil
  fresh.sort((a, b) => (b.pr?.number ?? 0) - (a.pr?.number ?? 0) || a.branch.localeCompare(b.branch))

  // Höchstens max: neueste Pushes behalten (neu und eben aktualisiert zählen als «jetzt»)
  const ranked = [
    ...fresh.map((f, idx) => ({ kind: 'new' as const, f, at: i.now.getTime(), order: idx })),
    ...kept.map((k, idx) => ({ kind: 'kept' as const, k, at: k.at, order: fresh.length + idx })),
  ].sort((a, b) => b.at - a.at || (a.kind === b.kind ? a.order - b.order : a.kind === 'kept' ? -1 : 1))
  const create: PlanOutput['create'] = []
  ranked.forEach((r, idx) => {
    const fits = idx < max
    if (r.kind === 'new') { if (fits) create.push(r.f); return }
    if (fits || r.k.p.busy) return
    remove.push({ id: r.k.p.id, branch: r.k.p.branch, reason: 'limit' })
  })
  const evicted = new Set(remove.map((r) => r.id))

  return {
    seen: {
      heads: Object.fromEntries(heads),
      prs: [...prOf.values()].map((p) => p.number).sort((a, b) => a - b),
    },
    create,
    update: update.filter((u) => !evicted.has(u.id)),
    link: link.filter((l) => !evicted.has(l.id)),
    remove,
  }
}

/* --- Variablen-Ebene «Vorschau» ------------------------------------------------------ */

export interface EnvLevelEntry { key: string; value: string; isSecret: boolean }

/**
 * Projekt → Ebene «Vorschau» → (eigene Werte der einzelnen Vorschau). Spätere
 * Ebenen überschreiben gleichnamige Variablen; der Rest wird geerbt.
 */
export function mergeEnvLevels(...levels: EnvLevelEntry[][]): EnvLevelEntry[] {
  const out = new Map<string, EnvLevelEntry>()
  for (const level of levels) for (const e of level) out.set(e.key, e)
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** Für die Anzeige: welche Variablen eine Vorschau erbt und welche überschrieben sind */
export function envInheritance(project: string[], preview: string[]): { key: string; source: 'projekt' | 'vorschau' | 'ueberschrieben' }[] {
  const keys = [...new Set([...project, ...preview])].sort()
  const p = new Set(project)
  const v = new Set(preview)
  return keys.map((key) => ({ key, source: v.has(key) ? (p.has(key) ? 'ueberschrieben' : 'vorschau') : 'projekt' }))
}

/* --- Zustand, Kommentar und Check am Pull Request -------------------------------------- */

const BUSY = new Set(['pending', 'pulling', 'starting', 'healthchecking'])

/** Zustand aus Projekt und letztem Deployment der Vorschau */
export function previewStateOf(o: { desiredState: string; last: { status: string } | null; hasActive: boolean }): PreviewState {
  if (!o.last || BUSY.has(o.last.status)) return 'deploying'
  if (o.last.status === 'failed') return 'failed'
  if (o.desiredState !== 'running' || !o.hasActive) return 'stopped'
  return 'ready'
}

export const PREVIEW_COMMENT_MARK = '<!-- airlock-preview -->'

export interface PreviewReport {
  label: string
  branch: string
  sha: string | null
  url: string | null
  state: PreviewState
  failure: string | null
  scan: PreviewScanDto | null
  /** Seite des Projekts in Airlock (Reiter Deployments) */
  airlockUrl: string
  /** Entfernt: Grund */
  removed?: RemoveReason | null
}

const scanLine = (s: PreviewScanDto | null): string => {
  if (!s) return 'noch nicht gestartet'
  if (s.status === 'queued' || s.status === 'running') return 'läuft …'
  if (s.status !== 'done') return 'nicht abgeschlossen'
  const o = s.open
  return `Note ${s.grade ?? '–'} (${s.score ?? '–'} / 100) · offen: ${o.critical} kritisch, ${o.high} hoch, ${o.medium} mittel, ${o.low} niedrig`
}

const STATE_MARK: Record<PreviewState, string> = { deploying: '⏳', ready: '✅', failed: '❌', stopped: '⏸️' }

/** Kommentar am Pull Request; wird bei jedem Push und jedem neuen Zustand ersetzt */
export function previewComment(r: PreviewReport): string {
  if (r.removed) {
    return [
      PREVIEW_COMMENT_MARK,
      `**Airlock-Vorschau** · \`${r.label}\``,
      '',
      `🧹 Entfernt: ${REMOVE_REASON_TEXT[r.removed]}. Container, Volumes und Adresse sind weg.`,
    ].join('\n')
  }
  return [
    PREVIEW_COMMENT_MARK,
    `**Airlock-Vorschau** · \`${r.label}\``,
    '',
    `- **Zustand:** ${STATE_MARK[r.state]} ${previewStateLabel(r.state)}${r.state === 'failed' && r.failure ? ` – ${r.failure}` : ''}`,
    `- **Adresse:** ${r.url ?? 'noch keine'} (nur im Heimnetz und im Tailnet erreichbar, nie öffentlich)`,
    `- **Branch:** \`${r.branch}\`${r.sha ? ` · Commit \`${r.sha.slice(0, 7)}\`` : ''}`,
    `- **Security-Scan:** ${r.state === 'ready' ? scanLine(r.scan) : '–'}`,
    '',
    `Details und Log in Airlock: ${r.airlockUrl}`,
    '',
    `_Airlock aktualisiert diesen Kommentar bei jedem Push. Die Vorschau verschwindet, wenn der Pull Request geschlossen oder der Branch gelöscht wird, spätestens nach ${PREVIEW_IDLE_DAYS} Tagen ohne Push._`,
  ].join('\n')
}

export interface PreviewCheck {
  status: 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'neutral'
  title: string
  summary: string
}

/**
 * Check «Airlock-Vorschau» am Commit (nur wenn die App «Checks: write» hat).
 * Rot nur bei gescheitertem Deploy oder offenem kritischem Befund – dieselbe
 * Schwelle wie fürs Veröffentlichen.
 */
export function previewCheck(r: PreviewReport): PreviewCheck {
  const summary = previewComment(r).split('\n').slice(2).join('\n')
  if (r.state === 'deploying') return { status: 'in_progress', title: 'Vorschau wird deployt', summary }
  if (r.state === 'failed') return { status: 'completed', conclusion: 'failure', title: `Deploy fehlgeschlagen${r.failure ? `: ${r.failure}` : ''}`.slice(0, 200), summary }
  if (r.state === 'stopped') return { status: 'completed', conclusion: 'neutral', title: 'Vorschau gestoppt', summary }
  const s = r.scan
  if (!s || s.status === 'queued' || s.status === 'running') return { status: 'in_progress', title: 'Vorschau bereit, Security-Scan läuft', summary }
  if (s.status !== 'done') return { status: 'completed', conclusion: 'neutral', title: 'Security-Scan nicht abgeschlossen', summary }
  if (s.open.critical > 0) return { status: 'completed', conclusion: 'failure', title: `Note ${s.grade} · ${s.open.critical} kritische Befunde`, summary }
  return { status: 'completed', conclusion: 'success', title: `Note ${s.grade} (${s.score} / 100)`, summary }
}

/** Kurzer Fingerabdruck eines Textes: nur bei Änderung an GitHub schicken */
export const fingerprint = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)
