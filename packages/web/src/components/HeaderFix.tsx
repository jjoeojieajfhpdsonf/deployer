import { useEffect, useRef, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HEADER_DEFAULT, HEADER_LABEL, headerFixFor, type HeaderKey, type HeaderMode } from '@airlock/shared'
import { api, ApiError, type FindingDto, type HeaderRecheckDto, type HeaderRuleDto, type HeaderRulesDto } from '../api.js'
import { relativeTime } from '../lib/format.js'
import { copyText } from '../lib/clipboard.js'
import { IconWarn } from './Security.js'

/**
 * M8, Etappe 1: Header über Caddy im Security-Reiter. Knopf am Befund
 * («Header setzen») und Abschnitt mit den aktiven Regeln und den
 * gemeldeten CSP-Verstössen. Zustände stehen immer als Wort da.
 *
 * Alle Header-Aktionen eines Projekts teilen sich einen Mutations-Schlüssel:
 * solange eine läuft (Caddy wird neu geladen, Nachscan), sind die anderen
 * gesperrt.
 */

export const headerRulesKey = (projectId: string) => ['header-rules', projectId]
const mutationKey = (projectId: string) => ['header', projectId]

export function useHeaderRules(projectId: string) {
  return useQuery({
    queryKey: headerRulesKey(projectId),
    queryFn: () => api.headerRules(projectId),
    // Solange die Funktionsprüfung einer scharfen CSP läuft, nachsehen
    refetchInterval: (q) => (q.state.data?.rules.some((r) => r.check?.state === 'running') ? 3000 : false),
  })
}

/** Ergebnis des Nachscans als ein Satz */
export function recheckText(r: HeaderRecheckDto): string {
  if (r.pending) return r.pending
  if (!r.ok) return `Regel gespeichert. Nachscan nicht möglich: ${r.error}`
  const parts: string[] = []
  if (r.fixed.length) parts.push(`${r.fixed.length === 1 ? '1 Befund' : `${r.fixed.length} Befunde`} behoben`)
  if (r.opened.length) parts.push(`${r.opened.length === 1 ? '1 Befund' : `${r.opened.length} Befunde`} wieder offen`)
  if (!parts.length) parts.push('keine Änderung bei den Befunden')
  return `Nachscan über Caddy: ${parts.join(', ')}${r.grade ? ` – Note ${r.grade}, ${r.score} / 100` : ''}.`
}

type SetVars = { header: HeaderKey; value?: string; mode: HeaderMode; confirm?: boolean }

function useHeaderMutation(projectId: string, onDone: (msg: string) => void) {
  const qc = useQueryClient()
  const busy = useIsMutating({ mutationKey: mutationKey(projectId) }) > 0
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['scan', projectId] })
    void qc.invalidateQueries({ queryKey: headerRulesKey(projectId) })
  }
  const set = useMutation({
    mutationKey: mutationKey(projectId),
    mutationFn: (v: SetVars) => api.setHeaderRule(projectId, v.header, { value: v.value, mode: v.mode, confirm: v.confirm }),
    onSuccess: (r) => {
      onDone(`${HEADER_LABEL[r.rule.header]}${r.rule.mode === 'report-only' ? ' als Report-Only' : ''} gesetzt. ${recheckText(r.recheck)}`)
      refresh()
    },
  })
  const remove = useMutation({
    mutationKey: mutationKey(projectId),
    mutationFn: (header: HeaderKey) => api.removeHeaderRule(projectId, header),
    onSuccess: (r, header) => {
      onDone(`Regel für ${HEADER_LABEL[header]} entfernt. ${recheckText(r.recheck)}`)
      refresh()
    },
  })
  const recheck = useMutation({
    mutationKey: mutationKey(projectId),
    mutationFn: () => api.recheckHeaders(projectId),
    onSuccess: (r) => {
      onDone(recheckText(r))
      refresh()
    },
  })
  // Rückweg in einem Klick: scharfe CSP -> Report-Only, sonst Regel entfernen
  const reset = useMutation({
    mutationKey: mutationKey(projectId),
    mutationFn: (header: HeaderKey) => api.resetHeaderRule(projectId, header),
    onSuccess: (r, header) => {
      onDone(`${HEADER_LABEL[header]} ${r.result === 'report-only' ? 'zurück auf Report-Only (blockiert nichts mehr)' : 'entfernt'}. ${recheckText(r.recheck)}`)
      refresh()
    },
  })
  return { set, remove, recheck, reset, busy }
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Nicht gespeichert')

/**
 * Rückfrage mit Fokus: beim Öffnen auf «Abbrechen» (zweimal Enter bestätigt
 * nichts), beim Schliessen zurück auf den auslösenden Knopf.
 */
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
  return {
    open,
    trigger,
    show: () => setOpen(true),
    close: () => {
      back.current = true
      setOpen(false)
    },
  }
}

const SET_LABEL: Record<HeaderKey, string> = {
  'x-content-type-options': 'Header setzen',
  'referrer-policy': 'Header setzen',
  'frame-ancestors': 'Header setzen',
  'content-security-policy': 'Als Report-Only testen',
  'strict-transport-security': 'HSTS setzen',
}

/** Aktion neben einem Header-Befund: setzen statt nur akzeptieren. */
export function HeaderFixAction({
  projectId,
  finding,
  rules,
  onDone,
}: {
  projectId: string
  finding: FindingDto
  rules: HeaderRulesDto | undefined
  onDone: (msg: string) => void
}) {
  const key = headerFixFor(finding)
  const c = useConfirm()
  const m = useHeaderMutation(projectId, onDone)
  if (!key || finding.status !== 'open' || !rules) return null
  const rule = rules.rules.find((r) => r.header === key)

  if (rule?.header === 'content-security-policy' && rule.mode === 'report-only') {
    return (
      <span className="fix-note">
        Report-Only läuft: Browser melden Verstösse. <a href="#header-caddy">Verstösse und Vorschlag</a>
      </span>
    )
  }
  if (rule) {
    return (
      <span className="fix-note">
        Caddy ergänzt den Header bereits.
        <button type="button" className="button-small" onClick={() => m.recheck.mutate()} disabled={m.busy}>
          {m.recheck.isPending ? 'Prüft …' : 'Erneut prüfen'}
        </button>
      </span>
    )
  }

  const hstsBlocked = key === 'strict-transport-security' && !rules.hsts.ok
  const mode: HeaderMode = key === 'content-security-policy' ? 'report-only' : 'enforce'
  const reasonId = `hsts-why-${finding.id}`

  return (
    <>
      {key === 'strict-transport-security' && c.open ? (
        <span className="confirm-inline" role="group" aria-label="HSTS bestätigen">
          <span className="confirm-note">
            <IconWarn />Browser erzwingen danach HTTPS für diesen Namen. Airlock startet mit {HEADER_DEFAULT['strict-transport-security']} (5 Minuten); länger erst, wenn alles läuft.
          </span>
          <button type="button" className="button-small" onClick={c.close} autoFocus>Abbrechen</button>
          <button
            type="button"
            className="button-small button-primary"
            disabled={m.busy}
            onClick={() => m.set.mutate({ header: key, mode, confirm: true }, { onSettled: c.close })}
          >
            {m.set.isPending ? 'Wird gesetzt …' : 'Ja, HSTS setzen'}
          </button>
        </span>
      ) : (
        <button
          ref={c.trigger}
          type="button"
          className="button-small button-primary"
          disabled={m.busy}
          // Gesperrt, aber fokussierbar: so wird die Begründung vorgelesen
          aria-disabled={hstsBlocked || undefined}
          aria-describedby={hstsBlocked ? reasonId : undefined}
          onClick={() => {
            if (hstsBlocked) return
            if (key === 'strict-transport-security') c.show()
            else m.set.mutate({ header: key, mode })
          }}
        >
          {m.set.isPending ? 'Wird gesetzt …' : SET_LABEL[key]}
        </button>
      )}
      {hstsBlocked && <span id={reasonId} className="fix-note">{rules.hsts.reason}</span>}
      {m.set.isError && <p role="alert" className="error">{errorText(m.set.error)}</p>}
    </>
  )
}

const MODE_LABEL: Record<HeaderMode, string> = { 'report-only': 'Report-Only', enforce: 'aktiv' }

/**
 * Einfacher Rückweg (CSP-Fix): «Zurücksetzen» ohne Rückfrage – es macht
 * nichts kaputt. Scharfe CSP -> Report-Only, jede andere Regel wird entfernt.
 */
function RuleRow({ r, m }: { r: HeaderRuleDto; m: ReturnType<typeof useHeaderMutation> }) {
  const resetting = m.reset.isPending && m.reset.variables === r.header
  const toReportOnly = r.header === 'content-security-policy' && r.mode === 'enforce'
  const what = toReportOnly ? 'zurück auf Report-Only' : 'Regel entfernen'
  const descId = `reset-${r.header}`
  return (
    <tr>
      <td>{HEADER_LABEL[r.header]}</td>
      <td><code className="header-value">{r.value}</code></td>
      <td>{MODE_LABEL[r.mode]}</td>
      <td>{relativeTime(r.updatedAt)}</td>
      <td className="row-actions">
        <span id={descId} className="reset-what">{what}</span>
        <button type="button" className="button-small" aria-describedby={descId}
          aria-disabled={m.busy || undefined} onClick={() => !m.busy && m.reset.mutate(r.header)}>
          {resetting ? 'Wird zurückgesetzt …' : 'Zurücksetzen'}
        </button>
      </td>
    </tr>
  )
}

/** Ergebnis der Funktionsprüfung nach dem Scharfschalten */
function CheckStatus({ check }: { check: NonNullable<HeaderRuleDto['check']> }) {
  if (check.state === 'running') return <p className="csp-check" role="status"><span className="status-dot" aria-hidden="true" />{check.message}</p>
  if (check.state === 'ok') return <p className="csp-check csp-check-ok" role="status">✓ {check.message} <span className="muted">({relativeTime(check.at)})</span></p>
  return (
    <div className="csp-check csp-check-failed" role="alert">
      <p><IconWarn /><span><strong>{check.message}</strong> <span className="muted">{relativeTime(check.at)}</span></span></p>
      {check.violations.length > 0 && <ul>{check.violations.map((v) => <li key={v}>{v}</li>)}</ul>}
    </div>
  )
}

/** Auftrag an Claude, Inline-Code auszulagern (zum Kopieren) */
function InlinePrompt({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null)
  return (
    <>
      <button type="button" className="button-small" aria-expanded={open} aria-controls="csp-inline-prompt" onClick={() => setOpen((v) => !v)}>Mit Claude lösen</button>
      {open && (
        <div id="csp-inline-prompt" className="claude-fix csp-inline-prompt">
          <p className="claude-fix-label">Auftrag für Claude oder Claude Code (mit dem Airlock-MCP verbunden):</p>
          <pre className="code-block">{prompt}</pre>
          <div className="claude-fix-actions">
            <button type="button" className="button-small button-primary" onClick={async () => setCopied((await copyText(prompt)) ? 'ok' : 'manual')}>Auftrag kopieren</button>
            <span role="status" className="fix-note">
              {copied === 'ok' && 'Kopiert. Der Vorschlag erscheint unter «Vorschläge von Claude».'}
              {copied === 'manual' && 'Kopieren ging nicht. Bitte den Text von Hand markieren.'}
            </span>
          </div>
        </div>
      )}
    </>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Abschnitt «Header über Caddy»: Regeln, Entfernen, CSP-Verstösse und Vorschlag. */
export function HeaderRulesSection({ projectId }: { projectId: string }) {
  const q = useHeaderRules(projectId)
  // Eigene Meldung direkt hier: wer unten klickt, sieht das Ergebnis dort
  const [notice, setNotice] = useState('')
  const m = useHeaderMutation(projectId, setNotice)
  const enforce = useConfirm()
  const d = q.data
  if (!d || (d.rules.length === 0 && d.csp.violations.length === 0)) return null
  const csp = d.rules.find((r) => r.header === 'content-security-policy')
  const settingCsp = m.set.isPending && m.set.variables?.header === 'content-security-policy'
  const a = d.csp.analysis
  const ready = d.csp.readiness

  return (
    <section className="header-caddy" id="header-caddy" aria-labelledby="header-caddy-title">
      <div className="section-head findings-head">
        <div>
          <h2 id="header-caddy-title">Header über Caddy</h2>
          <p>Caddy ergänzt diese Header nur, wenn die App sie nicht selbst setzt. Kein Redeploy nötig.</p>
        </div>
      </div>
      {!d.viaCaddy && (
        <p className="confirm-note"><IconWarn />Caddy bedient das Projekt gerade nicht. Die Regeln wirken, sobald es wieder läuft.</p>
      )}
      <div className="table-scroll">
        <table className="table header-rules-table">
          <thead>
            <tr><th>Header</th><th>Wert</th><th>Modus</th><th>Gesetzt</th><th><span className="visually-hidden">Aktion</span></th></tr>
          </thead>
          <tbody>
            {d.rules.map((r) => <RuleRow key={r.header} r={r} m={m} />)}
          </tbody>
        </table>
      </div>
      <p className="hint">«Zurücksetzen» macht eine scharfe CSP wieder zu Report-Only (blockiert nichts mehr) und entfernt jede andere Regel.</p>
      <div role="status" aria-live="polite" className="fix-live">{notice && <p className="fix-notice">{notice}</p>}</div>
      {m.remove.isError && <p role="alert" className="error">{errorText(m.remove.error)}</p>}
      {m.reset.isError && <p role="alert" className="error">{errorText(m.reset.error)}</p>}

      {csp && (
        <div className="csp-reports">
          <h3>CSP-Verstösse <span className="muted findings-count">{d.csp.total.toLocaleString('de-CH')}</span></h3>
          {d.csp.violations.length === 0 ? (
            <p className="hint">
              Noch keine Meldungen. Benutze die Seite im Browser; Browser melden jeden Verstoss an die Seite selbst
              (<code>/.well-known/airlock/csp-report/…</code>), Caddy reicht die Meldung an Airlock weiter.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Direktive</th><th>Blockierte Quelle</th><th>Seite</th><th>Anzahl</th><th>Zuletzt</th></tr></thead>
                <tbody>
                  {d.csp.violations.map((v) => (
                    <tr key={`${v.directive} ${v.blocked}`}>
                      <td><code>{v.directive}</code></td>
                      <td><code>{v.blocked === 'self' ? "'self'" : v.blocked}</code></td>
                      <td>{v.samplePath ?? '–'}</td>
                      <td>{v.count.toLocaleString('de-CH')}</td>
                      <td>{relativeTime(v.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {csp.check && <CheckStatus check={csp.check} />}
          {a && (
            <div className="csp-analysis">
              <h3>Analyse der Seiten</h3>
              {a.error ? <p className="hint">{a.error}</p> : (
                <>
                  <p className="hint">
                    {plural(a.pages.length, 'Seite', 'Seiten')} gelesen ({a.pages.join(', ')}): {plural(a.inlineScripts, 'Inline-Skript', 'Inline-Skripte')}, {plural(a.inlineStyles, 'Inline-Style', 'Inline-Styles')}, {plural(a.styleAttributes, 'style-Attribut', 'style-Attribute')}, {plural(a.eventHandlers, 'Ereignis-Attribut', 'Ereignis-Attribute')}.
                    {Object.keys(a.external).length > 0 && <> Externe Quellen: {Object.entries(a.external).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')}.</>}
                  </p>
                  {a.conflicts.length > 0 && (
                    <div className="csp-conflicts" role="note">
                      <p><IconWarn /><strong>Die aktuelle Regel würde blockieren:</strong></p>
                      <ul>{a.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {d.csp.suggestion && (
            <>
              <p className="hint">Vorschlag aus den Meldungen und der Analyse:</p>
              <pre className="code-block">{d.csp.suggestion}</pre>
            </>
          )}
          {d.csp.notes.length > 0 && (
            <ul className="hint csp-notes">{d.csp.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
          {d.csp.inlinePrompt && <div className="csp-inline"><InlinePrompt prompt={d.csp.inlinePrompt} /></div>}
          {csp.mode === 'report-only' && ready && (
            <p id="csp-ready" className={ready.ok ? 'hint' : 'csp-ready-blocked'}>
              {ready.ok ? <>Scharf schalten möglich: {ready.reason}</> : (
                <><IconWarn /><span>Scharf schalten noch gesperrt: {a?.conflicts.length
                  ? 'die Analyse findet Konflikte (oben)'
                  : a?.error ? `Analyse nicht möglich (${a.error})` : 'kein Nachweis'}
                  {' '}und {ready.views === null ? 'Aufrufe nicht zählbar' : `${ready.views} von ${ready.viewsNeeded} Aufrufen im Report-Only`}
                  {ready.violationsSince > 0 ? `, ${plural(ready.violationsSince, 'Verstoss', 'Verstösse')} gemeldet` : ' ohne Verstoss'}.
                  {' '}Frei wird es, sobald die Analyse keinen Konflikt mehr findet oder {ready.viewsNeeded} Aufrufe ohne Verstoss vorliegen.</span></>
              )}
            </p>
          )}
          <div className="form-actions">
            {d.csp.suggestion && !enforce.open && (
              <button type="button" className="button-small" disabled={m.busy}
                onClick={() => m.set.mutate({ header: 'content-security-policy', value: d.csp.suggestion!, mode: csp.mode })}>
                {settingCsp ? 'Wird übernommen …' : `Vorschlag übernehmen${csp.mode === 'report-only' ? ' (weiter Report-Only)' : ''}`}
              </button>
            )}
            {csp.mode === 'report-only' && !enforce.open && (
              // Gesperrt, aber fokussierbar: der Grund wird vorgelesen
              <button ref={enforce.trigger} type="button" className="button-small button-warn"
                aria-disabled={m.busy || !ready?.ok || undefined} aria-describedby="csp-ready"
                onClick={() => { if (!m.busy && ready?.ok) enforce.show() }}>
                Scharf schalten
              </button>
            )}
            {csp.mode === 'report-only' && enforce.open && (
              <span className="confirm-inline" role="group" aria-label="CSP scharf schalten">
                <span className="confirm-note"><IconWarn />Eine scharfe CSP blockiert alles, was die Regel nicht erlaubt. Danach prüft Airlock die Seiten im Browser; bei einem Verstoss geht sie von selbst auf Report-Only zurück.</span>
                <button type="button" className="button-small" onClick={enforce.close} autoFocus>Abbrechen</button>
                <button type="button" className="button-small button-primary" disabled={m.busy}
                  onClick={() => m.set.mutate({ header: 'content-security-policy', mode: 'enforce', confirm: true }, { onSettled: enforce.close })}>
                  {settingCsp ? 'Wird geschaltet …' : 'Ja, scharf schalten'}
                </button>
              </span>
            )}
            {csp.mode === 'enforce' && csp.check?.state !== 'running' && <span className="fix-note">CSP ist scharf; Verstösse werden weiter gemeldet.</span>}
          </div>
          {m.set.isError && <p role="alert" className="error">{errorText(m.set.error)}</p>}
        </div>
      )}
    </section>
  )
}
