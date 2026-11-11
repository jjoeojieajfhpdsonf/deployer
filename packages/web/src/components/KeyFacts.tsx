import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { EnvEntryDto, ProjectDto, ProjectHealthDto } from '@airlock/shared'
import { api } from '../api.js'
import { relativeTime, shortVersion } from '../lib/format.js'
import { ageMs, fmtDate, msOf } from '../lib/dates.js'
import { actorKind, actorText, IconSpark } from './Actor.js'
import { IconGit, IconBox, IconUpload } from './Icons.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { IconWarn } from './Security.js'

/**
 * Eckdaten: zweispaltige Zeilen, nur was für die Art des Projekts zutrifft.
 * Statische Seiten ohne Grenzen und Verbrauch (Caddy liefert sie aus),
 * Container mit Port, Healthcheck, Grenzen, Verbrauch und Umgebung. Der
 * Ablauf eines Chat-Projekts steht als eigener Hinweis darunter.
 */

type Tab = 'einstellungen'

const DAY = 86_400_000
/** Ab so vielen Tagen vor dem Ablauf in Warnfarbe */
export const EXPIRY_WARN_DAYS = 7

const KIND: Record<string, string> = { dockerfile: 'Dockerfile', compose: 'Docker Compose', image: 'Image', static: 'Statische Seite' }

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 ** 2).toLocaleString('de-CH', { maximumFractionDigits: 1 })} MB`
}
const fmtCpu = (v: number) => v.toLocaleString('de-CH', { maximumFractionDigits: 2 })

/** «github.com/jherren/wetter» aus einer Repo-URL */
export function repoLabel(url: string | undefined): string {
  if (!url) return '–'
  return url.replace(/^https?:\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '').replace(/\/$/, '')
}

/** «ghcr.io/example/app:1.4.2» → ['ghcr.io/example/app', '1.4.2'] */
export function splitImage(image: string | undefined): [string, string | null] {
  if (!image) return ['–', null]
  const at = image.indexOf('@')
  if (at > 0) return [image.slice(0, at), image.slice(at + 1, at + 20)]
  const colon = image.lastIndexOf(':')
  return colon > image.lastIndexOf('/') ? [image.slice(0, colon), image.slice(colon + 1)] : [image, 'latest']
}

function Row({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="kf-row">
      <dt>{label}</dt>
      <dd><span className="kf-value">{children}</span>{action && <span className="kf-action">{action}</span>}</dd>
    </div>
  )
}

function Source({ p }: { p: ProjectDto }) {
  const s = (p.source ?? {}) as Record<string, string | undefined>
  if (p.sourceType === 'files') {
    const who = p.createdBy && (actorKind(p.createdBy) === 'claude' || actorKind(p.createdBy) === 'token') ? actorText(p.createdBy).replace(/^Claude \((.*)\)$/, '$1') : null
    return <><span className="kf-icon kf-icon-claude"><IconSpark /></span>Chat{who && <span className="kf-dim"> · über {who}</span>}</>
  }
  if (p.sourceType === 'image') {
    const [name, tag] = splitImage(s.image)
    return <><span className="kf-icon"><IconBox size={13} /></span><code className="kf-code">{name}</code>{tag && <span className="kf-dim"> · {tag}</span>}</>
  }
  if (s.repoUrl) {
    return <><span className="kf-icon"><IconGit size={13} /></span><span className="kf-strong kf-repo">{repoLabel(s.repoUrl)}</span>{s.ref && <span className="kf-dim"> · {s.ref}</span>}</>
  }
  return <><span className="kf-icon"><IconUpload size={13} /></span>{p.sourceType === 'compose' ? 'hochgeladene compose.yaml' : 'ZIP-Upload'}</>
}

function Usage({ p, h }: { p: ProjectDto; h: ProjectHealthDto | null }) {
  const last = h?.samples.at(-1)
  if (!last) return <span className="kf-dim">noch keine Messung</span>
  const ratio = Math.min(1, last.memMb / p.memoryLimitMb)
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok'
  return (
    <span className="kf-usage">
      <span className={`kf-bar kf-bar-${tone}`} role="img" aria-label={`RAM ${Math.round(ratio * 100)} % der Grenze`}><span style={{ width: `${Math.max(2, ratio * 100)}%` }} /></span>
      <span className="kf-strong num">{Math.round(last.memMb).toLocaleString('de-CH')} MB</span>
      <span className="kf-dim num"> · CPU {Math.round((last.cpu / Math.max(p.cpuLimit, 0.01)) * 100)} %</span>
      {tone !== 'ok' && <span className={`kf-tone kf-tone-${tone}`}><IconWarn /> {tone === 'bad' ? 'fast an der Grenze' : 'knapp'}</span>}
    </span>
  )
}

/** Ablauf eines Chat-Projekts: neutral, ab 7 Tagen vorher in Warnfarbe; nach «Behalten» unbegrenzt. */
export function ExpiryNotice({ p, onToggleKeep, busy }: { p: ProjectDto; onToggleKeep: () => void; busy?: boolean }) {
  if (p.sourceType !== 'files') return null
  // Ungültiges Ablaufdatum wie kein Ablauf behandeln, statt «Abgelaufen» zu behaupten
  if (p.keep || msOf(p.expiresAt) === null) {
    return (
      <div className="kf-expiry kf-expiry-keep" role="status">
        <div className="kf-expiry-head">
          <p className="kf-expiry-title">Läuft unbegrenzt</p>
          <button type="button" className="link-button" onClick={onToggleKeep} disabled={busy}>Ablauf wieder aktivieren</button>
        </div>
        <p className="kf-expiry-text">Wird nicht automatisch gestoppt, auch wenn sich lange nichts ändert.</p>
      </div>
    )
  }
  const total = p.expiryDays ?? 30
  const left = Math.ceil(-(ageMs(p.expiresAt) ?? 0) / DAY)
  const warn = left <= EXPIRY_WARN_DAYS
  const date = fmtDate(p.expiresAt)
  const elapsed = Math.min(1, Math.max(0, 1 - left / total))
  const title = left <= 0 ? 'Abgelaufen' : left === 1 ? 'Läuft noch 1 Tag' : `Läuft noch ${left} Tage`
  return (
    <div className={`kf-expiry${warn ? ' kf-expiry-warn' : ''}`} role="status">
      <div className="kf-expiry-head">
        <p className="kf-expiry-title">{warn && <IconWarn />}{title}</p>
        <button type="button" className="button-small" onClick={onToggleKeep} disabled={busy}>Behalten</button>
      </div>
      <p className="kf-expiry-text">Chat-Projekte stoppen nach {total} Tagen ohne Änderung{left > 0 ? `, dieses am ${date}` : ` – gestoppt am ${date}`}.</p>
      <span className="kf-expiry-bar" role="progressbar" aria-label="Verstrichene Frist" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(elapsed * total)}><span style={{ width: `${Math.max(2, elapsed * 100)}%` }} /></span>
    </div>
  )
}

function FilesDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const files = useQuery({ queryKey: ['files', projectId], queryFn: () => api.listFiles(projectId), enabled: open })
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  const list = files.data?.files ?? []
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="files-h" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog-body">
        <h2 id="files-h">Dateien</h2>
        <p className="dialog-lede">Stand {files.data?.commit ? <code className="dl-version">{files.data.commit.slice(0, 7)}</code> : '–'} im Repo des Chat-Projekts. Ändern geht über Claude (update_files).</p>
        {!files.data && files.isError ? <ErrorState compact what="Die Dateiliste" error={files.error} retrying={files.isFetching} onRetry={() => void files.refetch()} />
          : !files.data ? <Loading label="Dateien werden geladen"><SkLines n={5} /></Loading> : (
          <ul className="kf-files">
            {list.map((f) => <li key={f.path}><code>{f.path}</code><span className="num">{fmtBytes(f.size)}</span></li>)}
          </ul>
        )}
        <div className="dialog-actions"><button type="button" onClick={onClose}>Schliessen</button></div>
      </div>
    </dialog>
  )
}

export function KeyFacts({
  p, env, health, onTab, onToggleKeep, keepBusy,
}: {
  p: ProjectDto
  env: EnvEntryDto[]
  health: ProjectHealthDto | null
  onTab: (t: Tab) => void
  onToggleKeep: () => void
  keepBusy?: boolean
}) {
  const isStatic = p.runtimeKind === 'static'
  const isFiles = p.sourceType === 'files'
  const [filesOpen, setFilesOpen] = useState(false)
  const files = useQuery({ queryKey: ['files', p.id], queryFn: () => api.listFiles(p.id), enabled: isFiles && isStatic })
  const running = p.desiredState === 'running' && Boolean(p.activeDeployment)
  const secret = env.filter((e) => e.isSecret).length
  const kind = isFiles && !isStatic ? (p.filesKind === 'compose' ? 'compose' : 'dockerfile') : p.runtimeKind
  const total = (files.data?.files ?? []).reduce((n, f) => n + f.size, 0)

  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-facts">
      <div className="ov-head">
        <h2 className="ov-title" id="ov-facts">Eckdaten</h2>
        <button type="button" className="link-button" onClick={() => onTab('einstellungen')}>Einstellungen</button>
      </div>
      <dl className="kf">
        <Row label="Quelle"><Source p={p} /></Row>
        <Row label="Art">
          {isStatic
            ? <><span className="kf-strong">Statische Seite</span><span className="kf-dim"> · von Caddy ausgeliefert</span></>
            : <><span className="kf-strong">{KIND[kind] ?? kind}</span>{p.port !== null && <span className="kf-dim"> · Port {p.port}</span>}{p.healthcheckPath && <span className="kf-dim"> · {p.healthcheckPath}</span>}</>}
        </Row>
        {isStatic && isFiles && (
          <Row label="Inhalt" action={<button type="button" className="link-button kf-link" onClick={() => setFilesOpen(true)}>Dateien ansehen</button>}>
            {files.data ? <><span className="kf-strong num">{files.data.files.length} {files.data.files.length === 1 ? 'Datei' : 'Dateien'}</span><span className="kf-dim num"> · {fmtBytes(total)}</span></> : <span className="kf-dim">wird gelesen…</span>}
          </Row>
        )}
        <Row label="Version">
          {p.activeDeployment
            ? <><code className="dl-version" title={p.activeDeployment.version ?? undefined}>{shortVersion(p.activeDeployment.version)}</code> <span className="kf-dim">{relativeTime(p.activeDeployment.startedAt)}</span></>
            : <span className="kf-dim">keine aktive Fassung</span>}
        </Row>
        {!isStatic && <Row label="Grenzen"><span className="kf-strong num">{fmtCpu(p.cpuLimit)} CPU · {p.memoryLimitMb.toLocaleString('de-CH')} MB</span></Row>}
        {!isStatic && running && <Row label="Verbrauch"><Usage p={p} h={health} /></Row>}
        <Row
          label="Umgebung"
          action={!isStatic || env.length > 0 ? <button type="button" className="link-button kf-link" onClick={() => onTab('einstellungen')}>Bearbeiten</button> : undefined}
        >
          {env.length === 0
            ? <span className="kf-dim">{isStatic ? 'keine Variablen nötig' : 'keine Variablen'}</span>
            : <><span className="kf-strong num">{env.length} {env.length === 1 ? 'Variable' : 'Variablen'}</span>{secret > 0 && <span className="kf-dim num"> · {secret} geheim</span>}</>}
        </Row>
        {!isFiles && <Row label="Ablauf"><span className="kf-dim">kein Ablauf ({p.sourceType === 'image' ? 'Image' : p.source && 'repoUrl' in (p.source as object) ? 'Repo' : 'Upload'})</span></Row>}
      </dl>
      <ExpiryNotice p={p} onToggleKeep={onToggleKeep} busy={keepBusy} />
      {p.runsAsRoot && <p className="side-note"><IconWarn /> Der Container läuft als root. Erlaubt, aber vermeidbar.</p>}
      {isFiles && isStatic && <FilesDialog projectId={p.id} open={filesOpen} onClose={() => setFilesOpen(false)} />}
    </section>
  )
}
