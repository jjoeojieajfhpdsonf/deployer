import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FIX_STATUS_LABEL, headerFixFor } from '@airlock/shared'
import { api, ApiError, type FindingDto, type FixRequestDto } from '../api.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { copyText } from '../lib/clipboard.js'
import { relativeTime } from '../lib/format.js'
import { IconWarn } from './Security.js'
import { IconSpark } from './Actor.js'

/**
 * M8, Etappe 2: «Mit Claude lösen». Am Befund ein fertiger Auftrag zum
 * Kopieren (Claude holt sich den Rest über MCP), darunter die Vorschläge,
 * die Claude angelegt hat – als Diff, übernommen erst nach Rückfrage.
 */

const fixesKey = (projectId: string) => ['fix-requests', projectId]

/** Rückfrage mit Fokus zurück auf den auslösenden Knopf (auch nach einem Fehler). */
function useConfirm() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const back = useRef(false)
  useEffect(() => {
    if (!open && back.current) {
      back.current = false
      trigger.current?.focus()
    }
  }, [open])
  return { open, trigger, show: () => setOpen(true), close: () => { back.current = true; setOpen(false) } }
}

/** Fertiges Image mit CVE: kein Auftrag, nur Abhilfe (ohne den Hinweis erst laden zu müssen) */
const isImageCve = (f: FindingDto, sourceType?: string) => sourceType === 'image' && f.tool === 'trivy' && /bekannte Schwachstelle/.test(f.title)

/**
 * Knopfzeile eines Befunds: before (z.B. «Header setzen»), «Mit Claude
 * lösen» bzw. «Abhilfe zeigen», after («Akzeptieren …»); das Panel darunter,
 * ausserhalb der Zeile – so folgt die Tab-Reihenfolge der Anzeige.
 */
export function ClaudeFixAction({
  projectId,
  finding,
  sourceType,
  before,
  after,
  onCopied,
}: {
  projectId: string
  finding: FindingDto
  sourceType?: string
  before?: ReactNode
  after?: ReactNode
  onCopied?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null)
  const panelId = `claude-fix-${finding.id}`
  const offered = finding.status === 'open' && !headerFixFor(finding) && sourceType !== 'static'
  const hint = useQuery({ queryKey: ['fix-hint', projectId, finding.id], queryFn: () => api.fixHint(projectId, finding.id), enabled: open && offered })
  const h = hint.data
  const label = isImageCve(finding, sourceType) || h?.way === 'image' ? 'Abhilfe zeigen' : 'Mit Claude lösen'

  return (
    <>
      <div className="finding-actions">
        {before}
        {offered && (
          <button type="button" className="button-small" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
            {label === 'Mit Claude lösen' && <span className="claude-spark"><IconSpark /></span>}{label}
          </button>
        )}
        {after}
      </div>
      {offered && open && (
        <div id={panelId} className="claude-fix">
          {!hint.data && !hint.isError && <Loading label="Hinweis wird geladen"><SkLines n={3} /></Loading>}
          {!hint.data && hint.isError && <ErrorState compact what="Der Hinweis" error={hint.error} retrying={hint.isFetching} onRetry={() => void hint.refetch()} />}
          {h && (
            <>
              <p className="hint">{h.explanation}</p>
              {h.prompt && (
                <>
                  <p className="claude-fix-label">Auftrag für Claude oder Claude Code (mit dem Airlock-MCP verbunden):</p>
                  <pre className="code-block">{h.prompt}</pre>
                  <div className="claude-fix-actions">
                    <button
                      type="button"
                      className="button-small button-primary"
                      onClick={async () => {
                        const ok = await copyText(h.prompt!)
                        setCopied(ok ? 'ok' : 'manual')
                        if (ok) onCopied?.()
                      }}
                    >
                      Auftrag kopieren
                    </button>
                    <span role="status" className="fix-note">
                      {copied === 'ok' && 'Kopiert. In Claude einfügen; der Vorschlag erscheint nach kurzer Zeit unter «Vorschläge von Claude».'}
                      {copied === 'manual' && 'Kopieren ging nicht. Bitte den Text oben von Hand markieren.'}
                    </span>
                  </div>
                </>
              )}
              {h.image && (
                <dl className="image-hint">
                  <dt>Image</dt><dd><code>{h.image.image}</code></dd>
                  {h.image.fixedIn && <><dt>Behoben in</dt><dd><code>{h.image.fixedIn}</code></dd></>}
                  <dt>Neuere Versionen</dt>
                  <dd>{h.image.candidates.length ? h.image.candidates.map((c, i, all) => <span key={c}><code className="image-tag">{c}</code>{i < all.length - 1 && ','}</span>) : 'keine gefunden'}</dd>
                  {h.image.note && <><dt>Hinweis</dt><dd className="muted">{h.image.note}</dd></>}
                </dl>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}

/** Diff mit Vorzeichen; Farbe nur zusätzlich zum + und −. Scrollbar, per Tastatur erreichbar. */
function Diff({ text }: { text: string }) {
  return (
    <div className="diff-scroll" role="region" aria-label="Änderung als Diff" tabIndex={0}>
      <pre className="code-block diff">
        {text.split('\n').map((l, i) => {
          const cls = l.startsWith('+++') || l.startsWith('---') ? 'diff-file' : l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : undefined
          return <span key={i} className={cls}>{l}{'\n'}</span>
        })}
      </pre>
    </div>
  )
}

function FixCard({ projectId, fix, onDone }: { projectId: string; fix: FixRequestDto; onDone: (msg: string) => void }) {
  const qc = useQueryClient()
  const applyC = useConfirm()
  const rejectC = useConfirm()
  const done = (msg: string) => {
    onDone(msg)
    void qc.invalidateQueries({ queryKey: fixesKey(projectId) })
    void qc.invalidateQueries({ queryKey: ['scan', projectId] })
  }
  const apply = useMutation({
    mutationFn: () => api.applyFix(projectId, fix.id),
    onSuccess: (r) => done(r.fix.status === 'failed' ? `Vorschlag übernommen, aber: ${r.fix.note}` : 'Vorschlag übernommen. Deploy und Nachscan laufen; der Status erscheint unter «Vorschläge von Claude».'),
    onSettled: applyC.close,
  })
  const reject = useMutation({
    mutationFn: () => api.rejectFix(projectId, fix.id),
    onSuccess: () => done('Vorschlag verworfen. Ein neuer Auftrag an Claude legt bei Bedarf einen neuen an.'),
    onSettled: rejectC.close,
  })
  const busy = apply.isPending || reject.isPending
  const err = apply.error ?? reject.error

  return (
    <li className={`finding fix-card fix-${fix.status}`}>
      <div className="finding-head">
        <span className={`badge fix-status fix-status-${fix.status}`}>{FIX_STATUS_LABEL[fix.status]}</span>
        <strong>Fix für «{fix.findingTitle}»</strong>
        <span className="muted">von {fix.actor.replace(/^token:/, '')} · {relativeTime(fix.createdAt)}</span>
      </div>
      {fix.explanation && <p>{fix.explanation}</p>}
      {fix.prUrl && <p><a href={fix.prUrl} target="_blank" rel="noreferrer">Pull Request auf {fix.branch}<span className="visually-hidden"> (öffnet neues Fenster)</span></a></p>}
      {fix.diff && (fix.status === 'proposed' ? <Diff text={fix.diff} /> : (
        <details><summary>Änderung ansehen</summary><Diff text={fix.diff} /></details>
      ))}
      {fix.note && <p className="muted">{fix.note}</p>}
      {fix.status === 'proposed' && fix.way !== 'github' && (
        <div className="finding-actions">
          {!applyC.open && !rejectC.open && (
            <>
              <button ref={applyC.trigger} type="button" className="button-small button-primary" disabled={busy} onClick={applyC.show}>Übernehmen</button>
              <button ref={rejectC.trigger} type="button" className="button-small" disabled={busy} onClick={rejectC.show}>Verwerfen</button>
            </>
          )}
          {applyC.open && (
            <span className="confirm-inline" role="group" aria-label="Vorschlag übernehmen">
              <span className="confirm-note"><IconWarn />Neue Version im Projekt, Deploy und Nachscan.</span>
              <button type="button" className="button-small" onClick={applyC.close} autoFocus>Abbrechen</button>
              <button type="button" className="button-small button-primary" disabled={busy} onClick={() => apply.mutate()}>
                {apply.isPending ? 'Wird übernommen …' : 'Ja, übernehmen und deployen'}
              </button>
            </span>
          )}
          {rejectC.open && (
            <span className="confirm-inline" role="group" aria-label="Vorschlag verwerfen">
              <span className="confirm-note"><IconWarn />Verworfene Vorschläge lassen sich nicht wieder öffnen.</span>
              <button type="button" className="button-small" onClick={rejectC.close} autoFocus>Abbrechen</button>
              <button type="button" className="button-small button-danger-solid" disabled={busy} onClick={() => reject.mutate()}>
                {reject.isPending ? 'Wird verworfen …' : 'Ja, verwerfen'}
              </button>
            </span>
          )}
        </div>
      )}
      {err && <p role="alert" className="error">{err instanceof ApiError ? err.message : 'Nicht gespeichert'}</p>}
    </li>
  )
}

/** Abschnitt «Vorschläge von Claude» (nur wenn es welche gibt). */
export function FixRequestsSection({ projectId, onDone, watch }: { projectId: string; onDone: (msg: string) => void; watch?: boolean }) {
  const q = useQuery({
    queryKey: fixesKey(projectId),
    queryFn: () => api.fixRequests(projectId),
    // Wartet ein Vorschlag auf Deploy und Nachscan oder wurde eben ein Auftrag kopiert: oft nachsehen
    refetchInterval: (query) => (watch || query.state.data?.fixes.some((f) => f.status === 'applied' || f.status === 'merged') ? 5000 : 30_000),
  })
  const fixes = q.data?.fixes ?? []
  if (!fixes.length) return null
  const open = fixes.filter((f) => f.status === 'proposed' || f.status === 'applied' || f.status === 'pr_open' || f.status === 'merged')
  const rest = fixes.filter((f) => !open.includes(f))
  return (
    <section className="fix-requests" aria-labelledby="fix-requests-title">
      <div className="section-head findings-head">
        <div>
          <h2 id="fix-requests-title">Vorschläge von Claude <span className="muted findings-count">{open.length}<span className="visually-hidden"> offen</span></span></h2>
          <p>Claude legt sie über MCP an. Übernommen wird erst nach deiner Rückfrage; der Scan nach dem Deploy bestätigt die Behebung.</p>
        </div>
      </div>
      {open.length > 0 && <ul className="finding-list">{open.map((f) => <FixCard key={f.id} projectId={projectId} fix={f} onDone={onDone} />)}</ul>}
      {rest.length > 0 && (
        <details>
          <summary>{rest.length === 1 ? '1 abgeschlossener Vorschlag' : `${rest.length} abgeschlossene Vorschläge`}</summary>
          <ul className="finding-list">{rest.map((f) => <FixCard key={f.id} projectId={projectId} fix={f} onDone={onDone} />)}</ul>
        </details>
      )}
    </section>
  )
}
