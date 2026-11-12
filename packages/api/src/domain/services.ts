import type {
  ServiceChangeDto, ServiceChangeInput, ServiceChangeStatus, ServiceEditWay, ServicePlanDto, ServiceTemplateId,
} from '@airlock/shared'
import { serviceTemplate } from '@airlock/shared'
import { addService, composeBase, removeService, type PlannedVariable } from '../lib/compose-edit.js'
import { unifiedDiff } from '../lib/diff.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'

/**
 * Etappe 4 «Dienst hinzufügen/entfernen» (Reiter «Aufbau»): Vorschau und
 * Übernehmen. Der Ablauf hier ist ohne Datenbank, Docker und GitHub testbar –
 * services-real.ts hängt die echten Wege an (lokales Repo, Upload, GitHub-App).
 *
 *   Chat-Projekt (files) und hochgeladene compose.yaml: neue Fassung der
 *   Datei, dann Deploy («Übernehmen & deployen»).
 *   Git-Repo: Pull Request über die GitHub-App, nie direkt in den
 *   Hauptbranch. Ohne App: nicht möglich (Knopf erklärt warum).
 *   Einzelcontainer, Image, statische Seite: nicht angeboten – ein zweiter
 *   Dienst setzt Compose voraus.
 */

/** Woher die compose.yaml kommt und wie eine neue Fassung hineinkommt */
export interface ComposeSource {
  way: ServiceEditWay
  path: string
  text: string
  /** Pull Request: Ziel-Branch */
  branch: string | null
  /** Neue Fassung übernehmen: Deploy starten bzw. Pull Request anlegen */
  write: (o: { text: string; message: string; title: string; body: string; changeId: string; kind: 'add' | 'remove'; service: string }) =>
    Promise<{ deploymentId?: string; pr?: { number: number; url: string; branch: string } }>
}

export type ChangeRow = {
  id: string
  projectId: string
  kind: 'add' | 'remove'
  service: string
  template: ServiceTemplateId | null
  status: ServiceChangeStatus
  way: ServiceEditWay
  deploymentId: string | null
  prUrl: string | null
  prNumber: number | null
  branch: string | null
  dropVolumes: string[]
  diff: string
  note: string | null
  actor: string
  createdAt: Date
  updatedAt: Date
  dismissedAt: Date | null
}

export interface ServiceDeps {
  /** Quelle der compose.yaml; wirft mit Begründung, wenn das Projekt das nicht kann */
  source: () => Promise<ComposeSource>
  webService: string
  /** Umgebungsvariablen des Projekts, entschlüsselt (nur hier im Server) */
  env: () => Promise<Record<string, string>>
  /** Neue Variablen anlegen (nie bestehende überschreiben) */
  addEnv: (vars: { key: string; value: string; secret: boolean }[]) => Promise<void>
  newId: () => string
  insert: (row: Omit<ChangeRow, 'projectId' | 'createdAt' | 'updatedAt' | 'dismissedAt'>) => Promise<ChangeRow>
  /** Deploy beobachten: an seinem Ende die Änderung abschliessen (Volumes löschen usw.) */
  watch: (deploymentId: string) => void
  audit: (action: string, params: Record<string, unknown>, result: 'ok' | 'error', error?: string) => Promise<void>
  /** Passwort-Erzeuger (Tests: fest) */
  password?: () => string
  slug?: string
  /**
   * Etappe 6: würde die Dienst-Adresse <dienst>--<projekt> eine Vorschau-Adresse
   * überdecken? Liefert das belegte Label, sonst null.
   */
  nameClash?: (service: string) => Promise<string | null>
}

export const toChangeDto = (r: ChangeRow): ServiceChangeDto => ({
  id: r.id, kind: r.kind, service: r.service, template: r.template, status: r.status, deploymentId: r.deploymentId,
  prUrl: r.prUrl, prNumber: r.prNumber, note: r.note, createdAt: r.createdAt.toISOString(),
})

interface Planned {
  source: ComposeSource
  text: string
  diff: string
  variables: PlannedVariable[]
  notes: string[]
  volumes: string[]
  dropped: string[]
}

async function computePlan(change: ServiceChangeInput, d: ServiceDeps): Promise<Planned> {
  if (change.action === 'add' && d.nameClash) {
    const clash = await d.nameClash(change.name)
    if (clash) {
      const message = `Die Adresse ${clash} gehört schon einer Vorschau dieses Projekts. Bitte einen anderen Namen wählen.`
      throw badRequest(message, [{ path: 'name', message }])
    }
  }
  const source = await d.source()
  if (change.action === 'add') {
    const r = await addService(source.text, change, { webService: d.webService, env: await d.env(), password: d.password, slug: d.slug })
    return { source, text: r.text, diff: unifiedDiff(source.path, source.text, r.text), variables: r.variables, notes: r.notes, volumes: r.volume ? [r.volume] : [], dropped: [] }
  }
  // Bei einem Pull Request löscht Airlock nie Daten auf Grund eines Merges
  if (change.dropVolume && source.way === 'pull_request') {
    throw badRequest('Bei Git-Projekten bleibt das Volume erhalten – Airlock löscht keine Daten auf Grund eines Merges.', [{ path: 'dropVolume', message: 'Bei Git-Projekten bleibt das Volume erhalten' }])
  }
  const r = await removeService(source.text, change, { webService: d.webService })
  return { source, text: r.text, diff: unifiedDiff(source.path, source.text, r.text), variables: [], notes: r.notes, volumes: r.volumes, dropped: r.dropped }
}

/** Vorschau: Diff, Variablen (nur Namen), Hinweise – ändert nichts */
export async function planServiceChange(change: ServiceChangeInput, d: ServiceDeps): Promise<ServicePlanDto> {
  const p = await computePlan(change, d)
  return {
    way: p.source.way,
    composePath: p.source.path,
    diff: p.diff,
    base: composeBase(p.source.text),
    variables: p.variables.map((v) => ({ key: v.key, secret: v.secret, state: v.state, purpose: v.purpose })),
    notes: p.notes,
    branch: p.source.branch,
    volumes: p.volumes,
  }
}

/**
 * Übernehmen: nur auf dem Stand der Vorschau (base). Erst die Variablen
 * (der Deploy braucht sie), dann die Datei – Deploy bzw. Pull Request.
 */
export async function applyServiceChange(change: ServiceChangeInput, base: string, actor: string, d: ServiceDeps): Promise<ServiceChangeDto> {
  const p = await computePlan(change, d)
  if (composeBase(p.source.text) !== base) {
    throw new AppError('stale_compose', 'Die compose.yaml hat sich seit der Vorschau geändert. Bitte die Vorschau neu laden.', 409)
  }
  if (!p.diff) throw conflict('Die Änderung ändert nichts an der compose.yaml')
  const id = d.newId()
  const service = change.name
  const kind = change.action
  const label = kind === 'add' ? `Dienst ${service} hinzugefügt (${serviceTemplate(change.template).label})` : `Dienst ${service} entfernt`

  const fresh = p.variables.filter((v) => v.state === 'new')
  if (fresh.length) await d.addEnv(fresh.map((v) => ({ key: v.key, value: v.value, secret: v.secret })))

  const body = [
    kind === 'add'
      ? `Airlock fügt den Dienst **${service}** (${serviceTemplate(change.template).label}) hinzu.`
      : `Airlock entfernt den Dienst **${service}**.`,
    '',
    ...p.notes.map((n) => `- ${n}`),
    ...(p.variables.length ? ['', 'Variablen in Airlock (Werte nur dort, nie im Repo):', ...p.variables.map((v) => `- \`${v.key}\`${v.secret ? ' (geheim)' : ''} – ${v.purpose}`)] : []),
    '',
    '_Angelegt von Airlock. Nach dem Merge deployt Airlock, wenn Auto-Deploy an ist._',
  ].join('\n')

  let result: Awaited<ReturnType<ComposeSource['write']>>
  try {
    result = await p.source.write({ text: p.text, message: label, title: label, body, changeId: id, kind, service })
  } catch (err) {
    await d.audit(`service.${kind}`, { service, way: p.source.way, variables: fresh.map((v) => v.key) }, 'error', (err as Error).message)
    throw err
  }
  const row = await d.insert({
    id, kind, service, template: kind === 'add' ? change.template : null,
    status: result.pr ? 'pr_open' : 'deploying', way: p.source.way,
    deploymentId: result.deploymentId ?? null,
    prUrl: result.pr?.url ?? null, prNumber: result.pr?.number ?? null, branch: result.pr?.branch ?? null,
    dropVolumes: p.dropped, diff: p.diff,
    note: result.pr ? `Pull Request #${result.pr.number} auf ${p.source.branch ?? 'den Hauptbranch'}` : null,
    actor,
  })
  await d.audit(`service.${kind}`, {
    service, template: kind === 'add' ? change.template : null, way: p.source.way, variables: fresh.map((v) => v.key),
    ...(result.pr ? { pr: result.pr.number, branch: result.pr.branch } : { deployment: result.deploymentId }),
    ...(p.dropped.length ? { dropVolumes: p.dropped } : {}),
  }, 'ok')
  if (result.deploymentId) d.watch(result.deploymentId)
  return toChangeDto(row)
}

/**
 * Nächster Zustand einer Änderung – rein. Fertig ist sie, sobald die aktive
 * Fassung den Dienst enthält (hinzufügen) bzw. nicht mehr (entfernen).
 */
export function nextStatus(c: { status: ServiceChangeStatus; kind: 'add' | 'remove'; service: string }, o: {
  deploymentStatus?: string | null
  activeServices: string[] | null
  pr?: { state: string; merged: boolean } | null
}): ServiceChangeStatus {
  if (c.status === 'done' || c.status === 'failed' || c.status === 'closed') return c.status
  if (c.status === 'deploying') {
    if (o.deploymentStatus === 'active' || o.deploymentStatus === 'superseded') return 'done'
    if (o.deploymentStatus === 'failed' || o.deploymentStatus === 'rolled_back') return 'failed'
    return 'deploying'
  }
  // pr_open, merged
  if (o.activeServices) {
    const has = o.activeServices.includes(c.service)
    if ((c.kind === 'add' && has) || (c.kind === 'remove' && !has)) return 'done'
  }
  if (o.pr?.merged) return 'merged'
  if (o.pr && o.pr.state === 'closed') return 'closed'
  return c.status
}

export interface ResolveDeps {
  deploymentStatus: (id: string) => Promise<string | null>
  /** Dienste der aktiven Fassung (null: unbekannt) */
  activeServices: () => Promise<string[] | null>
  /** Zustand des Pull Requests (gedrosselt); null: unbekannt */
  pullState: (row: ChangeRow) => Promise<{ state: string; merged: boolean } | null>
  /** Volumes des Compose-Projekts löschen (Name in compose.yaml) */
  removeVolumes: (names: string[]) => Promise<{ removed: string[]; failed: string[] }>
  update: (id: string, patch: Partial<ChangeRow>) => Promise<ChangeRow>
  audit: (action: string, params: Record<string, unknown>, result: 'ok' | 'error', error?: string) => Promise<void>
}

/**
 * Offene Änderungen abgleichen (nach einem Deploy und beim Lesen des
 * Aufbaus). Entfernen mit Volume: erst wenn die neue Fassung läuft (der
 * Container hängt es dann nicht mehr ein), wird das Volume gelöscht.
 */
export async function resolveChanges(rows: ChangeRow[], d: ResolveDeps): Promise<ChangeRow[]> {
  const open = rows.filter((r) => r.status === 'deploying' || r.status === 'pr_open' || r.status === 'merged')
  if (!open.length) return rows
  const active = await d.activeServices()
  const out = new Map(rows.map((r) => [r.id, r]))
  for (const r of open) {
    const next = nextStatus(r, {
      deploymentStatus: r.deploymentId ? await d.deploymentStatus(r.deploymentId) : null,
      activeServices: active,
      pr: r.status === 'deploying' ? null : await d.pullState(r),
    })
    if (next === r.status) continue
    const patch: Partial<ChangeRow> = { status: next }
    if (next === 'failed') patch.note = 'Der Deploy ist gescheitert; die vorherige Fassung läuft weiter. Details unter Deployments.'
    if (next === 'closed') patch.note = `Pull Request #${r.prNumber ?? ''} wurde ohne Merge geschlossen.`
    if (next === 'merged') patch.note = `Pull Request #${r.prNumber ?? ''} ist gemergt; der Dienst erscheint mit dem nächsten Deploy.`
    if (next === 'done' && r.kind === 'remove' && r.dropVolumes.length && r.way === 'deploy') {
      const v = await d.removeVolumes(r.dropVolumes)
      patch.note = v.failed.length ? `Volume ${v.failed.join(', ')} liess sich nicht löschen (noch eingehängt?).` : `Volume ${r.dropVolumes.join(', ')} gelöscht.`
      await d.audit('service.volume_remove', { service: r.service, volumes: r.dropVolumes, removed: v.removed, failed: v.failed }, v.failed.length ? 'error' : 'ok')
    }
    out.set(r.id, await d.update(r.id, patch))
  }
  return [...out.values()]
}

/** Was der Aufbau zeigt: offene und gescheiterte (7 Tage, bis ausgeblendet) */
export function visibleChanges(rows: ChangeRow[], now = Date.now()): ChangeRow[] {
  return rows.filter((r) => !r.dismissedAt && r.status !== 'done' && (r.status === 'deploying' || r.status === 'pr_open' || r.status === 'merged' || now - r.updatedAt.getTime() < 7 * 86_400_000))
}

/**
 * Ob und wie ein Projekt Dienste ändern kann. Nur Compose; Git nur mit der
 * GitHub-App (Pull Request), sonst erklärend nicht.
 */
export function serviceEditAbility(o: { runtimeKind: string; sourceType: string; repoUrl: string | null; uploadId: string | null; github: boolean }): { way: ServiceEditWay | null; reason: string | null } {
  if (o.runtimeKind !== 'compose') {
    return { way: null, reason: 'Weitere Dienste gibt es nur bei Compose-Projekten; dieses Projekt läuft als ein Container bzw. als statische Seite.' }
  }
  if (o.sourceType === 'files') return { way: 'deploy', reason: null }
  if (o.repoUrl) {
    return o.github
      ? { way: 'pull_request', reason: null }
      : { way: null, reason: 'Bei Git-Projekten ändert Airlock die compose.yaml nur über einen Pull Request der GitHub-App – für dieses Repo ist sie nicht verbunden (Server › GitHub).' }
  }
  if (o.uploadId) return { way: 'deploy', reason: null }
  return { way: null, reason: 'Die compose.yaml dieses Projekts ist nicht zugänglich.' }
}
