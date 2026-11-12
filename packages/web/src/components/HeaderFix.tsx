import { useState, type ReactNode } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HEADER_DEFAULT, HEADER_LABEL, headerFixFor, isCspQualityFinding, type HeaderKey, type HeaderMode } from '@airlock/shared'
import { api, type FindingDto, type HeaderRecheckDto, type HeaderRuleDto, type HeaderRulesDto } from '../api.js'
import { relativeTime, since } from '../lib/format.js'
import { poll } from '../lib/live.js'
import { copyText } from '../lib/clipboard.js'
import { IconWarn } from './Icons.js'
import { IconSpark } from './Actor.js'
import { notifyOk } from '../lib/feedback.js'
import { InlineConfirm, useConfirmState } from './Confirm.js'
import { Loading, SkLines, SkRows } from './States.js'
import { headerStates, settableInOne, wouldBlock, type HeaderState } from '../lib/security-view.js'

/**
 * M8: Header über Caddy im Security-Reiter. Knopf am Befund («Header
 * setzen») und die Ansicht «Header & CSP»: links alle relevanten Header mit
 * Zustand und Aktion, rechts der CSP-Ablauf in drei Schritten. Zustände
 * stehen immer als Wort da.
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
    // Das Ende der Funktionsprüfung einer scharfen CSP kommt über den Ereignisstrom (Audit); ohne ihn alle 60 s
    refetchInterval: (q) => (q.state.data?.rules.some((r) => r.check?.state === 'running') ? poll() : false),
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

type SetVars = { header: HeaderKey; value?: string; mode: HeaderMode; confirm?: boolean; undo?: boolean; quiet?: boolean }

function useHeaderMutation(projectId: string, onDone: (msg: string) => void) {
  const qc = useQueryClient()
  const busy = useIsMutating({ mutationKey: mutationKey(projectId) }) > 0
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['scan', projectId] })
    void qc.invalidateQueries({ queryKey: headerRulesKey(projectId) })
  }
  // Regel vor der Änderung, für «Rückgängig»
  const ruleBefore = (header: HeaderKey) => qc.getQueryData<HeaderRulesDto>(headerRulesKey(projectId))?.rules.find((r) => r.header === header) ?? null
  /** Rückweg zur Regel davor: wieder setzen (bestätigt war sie schon) oder entfernen */
  const restore = (header: HeaderKey, before: HeaderRuleDto | null) => {
    if (before) set.mutate({ header, value: before.value, mode: before.mode, confirm: true, undo: true })
    else remove.mutate({ header, undo: true })
  }
  const set = useMutation({
    mutationKey: mutationKey(projectId),
    meta: { errorTitle: 'Header nicht gesetzt' },
    onMutate: (v: SetVars) => ({ before: ruleBefore(v.header) }),
    mutationFn: (v: SetVars) => api.setHeaderRule(projectId, v.header, { value: v.value, mode: v.mode, confirm: v.confirm }),
    onSuccess: (r, v, ctx) => {
      const title = `${HEADER_LABEL[r.rule.header]}${r.rule.mode === 'report-only' ? ' als Report-Only' : ''} gesetzt`
      if (!v.quiet) {
        onDone(`${title}. ${recheckText(r.recheck)}`)
        notifyOk(v.undo ? `Rückgängig: ${title}` : title, { id: `header-${projectId}`, undo: v.undo ? undefined : () => restore(v.header, ctx?.before ?? null) })
      }
      refresh()
    },
  })
  const remove = useMutation({
    mutationKey: mutationKey(projectId),
    meta: { errorTitle: 'Header-Regel nicht entfernt' },
    onMutate: (v: { header: HeaderKey; undo?: boolean }) => ({ before: ruleBefore(v.header) }),
    mutationFn: (v: { header: HeaderKey; undo?: boolean }) => api.removeHeaderRule(projectId, v.header),
    onSuccess: (r, v, ctx) => {
      const title = `Regel für ${HEADER_LABEL[v.header]} entfernt`
      onDone(`${title}. ${recheckText(r.recheck)}`)
      notifyOk(v.undo ? `Rückgängig: ${title}` : title, { id: `header-${projectId}`, undo: v.undo || !ctx?.before ? undefined : () => restore(v.header, ctx.before) })
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
    meta: { errorTitle: 'Header nicht zurückgesetzt' },
    onMutate: (header: HeaderKey) => ({ before: ruleBefore(header) }),
    mutationFn: (header: HeaderKey) => api.resetHeaderRule(projectId, header),
    onSuccess: (r, header, ctx) => {
      const title = `${HEADER_LABEL[header]} ${r.result === 'report-only' ? 'zurück auf Report-Only' : 'entfernt'}`
      onDone(`${HEADER_LABEL[header]} ${r.result === 'report-only' ? 'zurück auf Report-Only (blockiert nichts mehr)' : 'entfernt'}. ${recheckText(r.recheck)}`)
      notifyOk(title, { id: `header-${projectId}`, undo: ctx?.before ? () => restore(header, ctx.before) : undefined })
      refresh()
    },
  })
  return { set, remove, recheck, reset, busy }
}

/**
 * Rückfrage mit Fokus: beim Öffnen auf «Abbrechen» (zweimal Enter bestätigt
 * nichts), beim Schliessen zurück auf den auslösenden Knopf (Confirm.tsx).
 */
const useConfirm = useConfirmState

const SET_LABEL: Record<HeaderKey, string> = {
  'x-content-type-options': 'Header setzen',
  'referrer-policy': 'Header setzen',
  'permissions-policy': 'Header setzen',
  'frame-ancestors': 'Header setzen',
  'content-security-policy': 'Als Report-Only testen',
  'strict-transport-security': 'HSTS setzen',
}

const HSTS_NOTE = <>Browser erzwingen danach HTTPS für diesen Namen. Airlock startet mit {HEADER_DEFAULT['strict-transport-security']} (5 Minuten); länger erst, wenn alles läuft.</>

/** Aktion neben einem Header-Befund: setzen statt nur akzeptieren. */
export function HeaderFixAction({
  projectId,
  finding,
  rules,
  onDone,
  onOpenCsp,
}: {
  projectId: string
  finding: FindingDto
  rules: HeaderRulesDto | undefined
  onDone: (msg: string) => void
  /** Wechselt zu «Header & CSP» (CSP-Ablauf) */
  onOpenCsp: () => void
}) {
  const key = headerFixFor(finding)
  const c = useConfirm()
  const m = useHeaderMutation(projectId, onDone)
  if (isCspQualityFinding(finding) && finding.status === 'open' && rules) return <CspFlowAction rules={rules} onOpenCsp={onOpenCsp} />
  if (!key || finding.status !== 'open' || !rules) return null
  const rule = rules.rules.find((r) => r.header === key)

  if (rule?.header === 'content-security-policy' && rule.mode === 'report-only') {
    return (
      <>
        <button type="button" className="button-small button-primary" onClick={onOpenCsp}>Zum CSP-Ablauf</button>
        <span className="fix-note">Report-Only läuft: Browser melden Verstösse.</span>
      </>
    )
  }
  if (rule) {
    return (
      <span className="fix-note">
        Caddy ergänzt den Header bereits.
        <button type="button" className="button-small" onClick={() => m.recheck.mutate()} disabled={m.busy} aria-busy={m.recheck.isPending || undefined}>
          Erneut prüfen
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
        <InlineConfirm label="HSTS bestätigen" small tone="primary" focus="cancel"
          note={HSTS_NOTE}
          confirmLabel="Ja, HSTS setzen" busy={m.set.isPending} disabled={m.busy}
          onCancel={c.close} onConfirm={() => m.set.mutate({ header: key, mode, confirm: true }, { onSettled: c.close })} />
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
          aria-busy={(m.set.isPending && m.set.variables?.header === key) || undefined}
        >
          {SET_LABEL[key]}
        </button>
      )}
      {hstsBlocked && <span id={reasonId} className="fix-note">{rules.hsts.reason}</span>}
    </>
  )
}

/**
 * Antwort 7: ZAP-Befund zur Qualität der CSP (10055). Bleibt ein ZAP-Befund;
 * verbessern lässt sich die Regel im CSP-Ablauf unter «Header & CSP»
 * (Report-Only, Verstösse, Vorschlag). Setzt die App die CSP selbst, ergänzt
 * Caddy sie nicht – dann gibt es dort nichts zu tun.
 */
function CspFlowAction({ rules, onOpenCsp }: { rules: HeaderRulesDto; onOpenCsp: () => void }) {
  const rule = rules.rules.find((r) => r.header === 'content-security-policy')
  if (!rule) return <span className="fix-note">Die CSP setzt die App selbst; anpassen lässt sie sich nur im Code.</span>
  return (
    <>
      <button type="button" className="button-small button-primary" onClick={onOpenCsp}>Zum CSP-Ablauf</button>
      <span className="fix-note">{rule.mode === 'report-only' ? 'CSP läuft über Caddy als Report-Only.' : 'CSP läuft über Caddy.'}</span>
    </>
  )
}

/* --- Ansicht «Header & CSP» ------------------------------------------------------------ */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const STATE_WORD: Record<HeaderState['state'], string> = {
  missing: 'fehlt', accepted: 'fehlt, akzeptiert', app: 'App', caddy: 'Caddy', template: 'Caddy-Vorlage', present: 'vorhanden',
}
const STATE_TONE: Record<HeaderState['state'], string> = {
  missing: 'warn', accepted: 'neutral', app: 'ok', caddy: 'ok', template: 'ok', present: 'ok',
}

/** Zustand als Punkt und Wort, mit Wert */
function HeaderStateCell({ s, rule }: { s: HeaderState; rule: HeaderRuleDto | undefined }) {
  return (
    <div className="hdr-state">
      <span className={`hdr-state-line tone-${s.mode === 'report-only' ? 'warn' : STATE_TONE[s.state]}`}>
        <span className="hdr-dot" aria-hidden="true" />
        <span>{STATE_WORD[s.state]}{s.mode === 'report-only' && <> · Report-Only</>}</span>
        {s.value && s.key !== 'content-security-policy' && <code className="hdr-value">{s.value}</code>}
      </span>
      {(s.note || (rule && s.state === 'caddy')) && (
        <span className="hdr-sub" id={`hdr-why-${s.key}`}>{s.note ??`gesetzt ${relativeTime(rule!.updatedAt)}`}</span>
      )}
    </div>
  )
}

function HeaderRow({ s, rule, rules, m }: {
  s: HeaderState
  rule: HeaderRuleDto | undefined
  rules: HeaderRulesDto
  m: ReturnType<typeof useHeaderMutation>
}) {
  const c = useConfirm()
  const hstsBlocked = s.key === 'strict-transport-security' && !rules.hsts.ok
  const setting = m.set.isPending && m.set.variables?.header === s.key
  const resetting = m.reset.isPending && m.reset.variables === s.key
  let action: ReactNode = null
  if (s.key === 'content-security-policy') {
    action = <span className="hdr-see">siehe rechts<span aria-hidden="true"> →</span></span>
  } else if (s.state === 'missing' || s.state === 'accepted') {
    // HSTS: Rückfrage in eigener Zeile darunter (volle Breite)
    if (!(s.key === 'strict-transport-security' && c.open)) {
      const reasonId = `hdr-why-${s.key}`
      action = (
        <button ref={c.trigger} type="button" className="button-small button-primary"
          aria-disabled={m.busy || hstsBlocked || undefined} aria-busy={setting || undefined}
          aria-describedby={hstsBlocked ? reasonId : undefined} aria-label={`${HEADER_LABEL[s.key]} setzen`}
          onClick={() => {
            if (m.busy || hstsBlocked) return
            if (s.key === 'strict-transport-security') c.show()
            else m.set.mutate({ header: s.key, mode: 'enforce' })
          }}>
          Setzen
        </button>
      )
    }
  } else if (rule) {
    action = (
      <button type="button" className="button-small button-ghost" aria-label={`Regel für ${HEADER_LABEL[s.key]} entfernen`}
        aria-disabled={m.busy || undefined} aria-busy={resetting || undefined} onClick={() => !m.busy && m.reset.mutate(s.key)}>
        Entfernen
      </button>
    )
  }
  return (
    <>
      <tr>
        <th scope="row" className="hdr-name">{s.label}</th>
        <td><HeaderStateCell s={s} rule={rule} /></td>
        <td className="row-actions">{action}</td>
      </tr>
      {s.key === 'strict-transport-security' && c.open && (
        <tr className="hdr-confirm-row">
          <td colSpan={3}>
            <InlineConfirm label="HSTS bestätigen" small tone="primary" focus="cancel" note={HSTS_NOTE}
              confirmLabel="Ja, HSTS setzen" busy={setting} disabled={m.busy}
              onCancel={c.close} onConfirm={() => m.set.mutate({ header: s.key, mode: 'enforce', confirm: true }, { onSettled: c.close })} />
          </td>
        </tr>
      )}
    </>
  )
}

/** Ansicht «Header & CSP»: links Header-Tabelle, rechts CSP in drei Schritten. */
export function HeaderCspView({ projectId, findings, observed }: {
  projectId: string
  findings: FindingDto[]
  observed: Record<string, string> | null
}) {
  const q = useHeaderRules(projectId)
  // Eigene Meldung direkt hier: wer hier klickt, sieht das Ergebnis hier
  const [notice, setNotice] = useState('')
  const m = useHeaderMutation(projectId, setNotice)
  const [allBusy, setAllBusy] = useState(false)
  const d = q.data
  if (!d) return <div className="sec-two"><Loading label="Header werden geladen"><SkRows n={5} /></Loading><Loading label="CSP wird geladen"><SkLines n={5} /></Loading></div>
  const states = headerStates({ rules: d, observed, findings })
  const missing = settableInOne(states)
  const setAll = async () => {
    if (m.busy || !missing.length) return
    setAllBusy(true)
    try {
      for (const h of missing) await m.set.mutateAsync({ header: h, mode: 'enforce', quiet: true })
      const title = `${plural(missing.length, 'Header', 'Header')} gesetzt`
      setNotice(`${title}: ${missing.map((h) => HEADER_LABEL[h]).join(', ')}. Der Nachscan über Caddy lief nach jedem.`)
      notifyOk(title, { id: `header-${projectId}` })
    } catch {
      // Fehler meldet die Mutation selbst (errorTitle); gesetzt bleibt, was durchging
    } finally {
      setAllBusy(false)
    }
  }
  const cspState = states.find((s) => s.key === 'content-security-policy')!

  return (
    <div className="sec-two">
      <section className="panel sec-card" id="header-caddy" aria-labelledby="header-caddy-title">
        <div className="sec-card-head">
          <h2 id="header-caddy-title" className="sec-card-title">Security-Header</h2>
          <p className="sec-card-sub">Fehlt ein Header in der App, setzt Caddy ihn. Kein neuer Deploy nötig.</p>
        </div>
        {!d.viaCaddy && (
          <p className="confirm-note sec-card-note"><IconWarn />Caddy bedient das Projekt gerade nicht. Die Regeln wirken, sobald es wieder läuft.</p>
        )}
        <div className="table-scroll sec-table-scroll">
          <table className="table hdr-table">
            <thead><tr><th scope="col">Header</th><th scope="col">Zustand</th><th scope="col"><span className="visually-hidden">Aktion</span></th></tr></thead>
            <tbody>
              {states.map((s) => <HeaderRow key={s.key} s={s} rule={d.rules.find((r) => r.header === s.key)} rules={d} m={m} />)}
            </tbody>
          </table>
        </div>
        <div className="sec-card-foot">
          {missing.length > 0 && (
            <button type="button" className="button-small" aria-disabled={m.busy || undefined} aria-busy={allBusy || undefined} onClick={() => void setAll()}>
              Alle fehlenden setzen ({missing.length})
            </button>
          )}
          <p className="hint">«Entfernen» nimmt die Regel bei Caddy weg; eine scharfe CSP geht rechts zurück auf Report-Only. HSTS fragt vorher nach.</p>
          <div role="status" aria-live="polite" className="fix-live">{notice && <p className="fix-notice">{notice}</p>}</div>
        </div>
      </section>
      <CspFlow projectId={projectId} d={d} m={m} appCsp={cspState.state === 'app' ? cspState : null} />
    </div>
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
      <button type="button" className="button-small button-claude" aria-expanded={open} aria-controls="csp-inline-prompt" onClick={() => setOpen((v) => !v)}>
        <span className="claude-spark"><IconSpark /></span>Konflikte mit Claude lösen
      </button>
      {open && (
        <div id="csp-inline-prompt" className="claude-fix csp-inline-prompt">
          <p className="claude-fix-label">Auftrag für Claude oder Claude Code (mit dem Airlock-MCP verbunden):</p>
          <pre className="code-block">{prompt}</pre>
          <div className="claude-fix-actions">
            <button type="button" className="button-small button-primary" onClick={async () => setCopied((await copyText(prompt)) ? 'ok' : 'manual')}>Auftrag kopieren</button>
            <span role="status" className="fix-note">
              {copied === 'ok' && 'Kopiert. Der Vorschlag erscheint unter «Befunde» beim Befund zur CSP.'}
              {copied === 'manual' && 'Kopieren ging nicht. Bitte den Text von Hand markieren.'}
            </span>
          </div>
        </div>
      )}
    </>
  )
}

type StepState = 'done' | 'active' | 'todo'
const STEP_WORD: Record<StepState, string> = { done: 'erledigt', active: 'aktueller Schritt', todo: 'noch offen' }

/** CSP in drei Schritten: Beobachten → Konflikte lösen → Scharf schalten */
function CspFlow({ projectId, d, m, appCsp }: {
  projectId: string
  d: HeaderRulesDto
  m: ReturnType<typeof useHeaderMutation>
  appCsp: HeaderState | null
}) {
  const [notice, setNotice] = useState('')
  const own = useHeaderMutation(projectId, setNotice)
  const enforce = useConfirm()
  const [showRule, setShowRule] = useState(false)
  const csp = d.rules.find((r) => r.header === 'content-security-policy')
  const settingCsp = own.set.isPending && own.set.variables?.header === 'content-security-policy'
  const a = d.csp.analysis
  const ready = d.csp.readiness
  const rows = wouldBlock(d.csp.violations, a)
  const busy = m.busy || own.busy

  const head = (
    <div className="sec-card-head">
      {/* Ziel von «Zum CSP-Ablauf» am Befund (Fokus ohne Tab-Stopp) */}
      <h2 id="header-caddy-csp-title" className="sec-card-title" tabIndex={-1}>Content-Security-Policy</h2>
    </div>
  )

  if (!csp) {
    return (
      <section className="panel sec-card sec-csp" id="header-caddy-csp" aria-labelledby="header-caddy-csp-title">
        {head}
        {appCsp ? (
          <p className="hint">Die App setzt die CSP selbst{appCsp.mode === 'report-only' ? ' (Report-Only)' : ''}; anpassen lässt sie sich nur im Code. <code className="hdr-value">{appCsp.value}</code></p>
        ) : (
          <>
            <Steps steps={[
              { name: 'Beobachten', sub: 'noch nicht gestartet', state: 'active' },
              { name: 'Konflikte lösen', sub: 'nach den ersten Meldungen', state: 'todo' },
              { name: 'Scharf schalten', sub: 'gesperrt', state: 'todo' },
            ]} />
            <p className="hint">Als Report-Only blockiert die Regel nichts: Browser melden nur, was sie blockieren würde. Daraus entsteht der Vorschlag für die scharfe Regel.</p>
            {rows.length > 0 && <BlockList rows={rows} />}
            <div className="sec-actions">
              <button type="button" className="button-small button-primary" aria-disabled={busy || undefined} aria-busy={settingCsp || undefined}
                onClick={() => !busy && own.set.mutate({ header: 'content-security-policy', mode: 'report-only' })}>
                Als Report-Only testen
              </button>
            </div>
          </>
        )}
        <div role="status" aria-live="polite" className="fix-live">{notice && <p className="fix-notice">{notice}</p>}</div>
      </section>
    )
  }

  const enforced = csp.mode === 'enforce'
  const conflicts = enforced ? 0 : rows.length
  const views = ready?.views ?? null
  const needed = ready?.viewsNeeded ?? 0
  const share = views === null || !needed ? 0 : Math.min(1, views / needed)
  const steps: { name: string; sub: string; state: StepState; progress?: number }[] = [
    { name: 'Beobachten', sub: enforced ? 'abgeschlossen' : `Report-Only ${since(csp.reportOnlySince ?? csp.updatedAt)}`, state: 'done' },
    {
      name: 'Konflikte lösen',
      sub: enforced ? 'erledigt' : conflicts ? `${conflicts} offen` : 'keine Konflikte',
      state: enforced || !conflicts ? 'done' : 'active',
      progress: enforced || !conflicts ? undefined : share,
    },
    {
      name: 'Scharf schalten',
      sub: enforced ? (csp.check?.state === 'running' ? 'Prüfung läuft' : 'scharf') : ready?.ok ? 'möglich' : 'gesperrt',
      state: enforced ? 'done' : ready?.ok ? 'active' : 'todo',
    },
  ]
  const resetting = own.reset.isPending

  return (
    <section className="panel sec-card sec-csp" id="header-caddy-csp" aria-labelledby="header-caddy-csp-title">
      {head}
      <Steps steps={steps} />
      {csp.check && <CheckStatus check={csp.check} />}
      {!enforced && rows.length > 0 && <BlockList rows={rows} />}
      {!enforced && d.csp.violations.length === 0 && rows.length === 0 && (
        <p className="hint">
          Noch keine Meldungen. Benutze die Seite im Browser; Browser melden jeden Verstoss an die Seite selbst
          (<code>/.well-known/airlock/csp-report/…</code>), Caddy reicht die Meldung an Airlock weiter.
        </p>
      )}
      {!enforced && ready && (
        <div className="sec-block">
          <h3 className="sec-label">Fortschritt bis «scharf»</h3>
          <p className="csp-progress">
            <span className="csp-bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
            <span>{views === null ? 'Aufrufe nicht zählbar' : `${views} von ${needed} Aufrufen im Report-Only`}{ready.violationsSince > 0 ? `, ${plural(ready.violationsSince, 'Verstoss', 'Verstösse')} gemeldet` : ' ohne Verstoss'}</span>
          </p>
          <p id="csp-ready" className={ready.ok ? 'hint' : 'csp-ready-blocked'}>
            {ready.ok ? <>Scharf schalten möglich: {ready.reason}</> : (
              <><IconWarn /><span>Scharf schalten noch gesperrt: {a?.conflicts.length
                ? 'die Analyse findet Konflikte'
                : a?.error ? `Analyse nicht möglich (${a.error})` : 'kein Nachweis'}.
                {' '}Frei wird es, sobald die Analyse keinen Konflikt mehr findet oder {needed} Aufrufe ohne Verstoss vorliegen.</span></>
            )}
          </p>
        </div>
      )}
      <div className="sec-actions">
        {d.csp.inlinePrompt && <InlinePrompt prompt={d.csp.inlinePrompt} />}
        <button type="button" className="button-small" aria-expanded={showRule} aria-controls="csp-rule" onClick={() => setShowRule((v) => !v)}>
          {showRule ? 'Regel ausblenden' : 'Regel ansehen'}
        </button>
        {!enforced && !enforce.open && (
          // Gesperrt, aber fokussierbar: der Grund wird vorgelesen
          <button ref={enforce.trigger} type="button" className="button-small button-warn"
            aria-disabled={busy || !ready?.ok || undefined} aria-describedby={ready ? 'csp-ready' : undefined}
            onClick={() => { if (!busy && ready?.ok) enforce.show() }}>
            Scharf schalten
          </button>
        )}
        {enforced && csp.check?.state !== 'running' && (
          <button type="button" className="button-small button-ghost" aria-disabled={busy || undefined} aria-busy={resetting || undefined}
            onClick={() => !busy && own.reset.mutate('content-security-policy')}>
            Zurück auf Report-Only
          </button>
        )}
      </div>
      {!enforced && enforce.open && (
        <InlineConfirm label="CSP scharf schalten" small tone="primary" focus="cancel"
          note="Eine scharfe CSP blockiert alles, was die Regel nicht erlaubt. Danach prüft Airlock die Seiten im Browser; bei einem Verstoss geht sie von selbst auf Report-Only zurück."
          confirmLabel="Ja, scharf schalten" busy={settingCsp} disabled={busy}
          onCancel={enforce.close} onConfirm={() => own.set.mutate({ header: 'content-security-policy', mode: 'enforce', confirm: true }, { onSettled: enforce.close })} />
      )}
      {enforced && csp.check?.state !== 'running' && <p className="fix-note csp-enforced">CSP ist scharf; Verstösse werden weiter gemeldet.</p>}
      <div role="status" aria-live="polite" className="fix-live">{notice && <p className="fix-notice">{notice}</p>}</div>

      {showRule && (
        <div id="csp-rule" className="csp-rule">
          <h3 className="sec-label">Aktuelle Regel <span className="muted">({enforced ? 'scharf' : 'Report-Only'}, gesetzt {relativeTime(csp.updatedAt)})</span></h3>
          <pre className="code-block">{csp.value}</pre>
          {a && (
            <div className="csp-analysis">
              <h3 className="sec-label">Analyse der Seiten</h3>
              {a.error ? <p className="hint">{a.error}</p> : (
                <p className="hint">
                  {plural(a.pages.length, 'Seite', 'Seiten')} gelesen ({a.pages.join(', ')}): {plural(a.inlineScripts, 'Inline-Skript', 'Inline-Skripte')}, {plural(a.inlineStyles, 'Inline-Style', 'Inline-Styles')}, {plural(a.styleAttributes, 'style-Attribut', 'style-Attribute')}, {plural(a.eventHandlers, 'Ereignis-Attribut', 'Ereignis-Attribute')}.
                  {Object.keys(a.external).length > 0 && <> Externe Quellen: {Object.entries(a.external).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')}.</>}
                </p>
              )}
            </div>
          )}
          {d.csp.suggestion && (
            <>
              <h3 className="sec-label">Vorschlag aus den Meldungen und der Analyse</h3>
              <pre className="code-block">{d.csp.suggestion}</pre>
              <button type="button" className="button-small" aria-disabled={busy || undefined} aria-busy={settingCsp || undefined}
                onClick={() => !busy && own.set.mutate({ header: 'content-security-policy', value: d.csp.suggestion!, mode: csp.mode })}>
                {`Vorschlag übernehmen${csp.mode === 'report-only' ? ' (weiter Report-Only)' : ''}`}
              </button>
            </>
          )}
          {d.csp.notes.length > 0 && <ul className="hint csp-notes">{d.csp.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {!enforced && (
            <p className="hint">
              <button type="button" className="link-button" aria-disabled={busy || undefined} onClick={() => !busy && own.reset.mutate('content-security-policy')}>CSP-Regel entfernen</button>
              {' '}– Caddy setzt dann keine CSP mehr.
            </p>
          )}
        </div>
      )}

      {d.csp.violations.length > 0 && (
        <details className="csp-all">
          <summary>Alle Verstösse <span className="muted">{d.csp.total.toLocaleString('de-CH')}</span></summary>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th scope="col">Direktive</th><th scope="col">Blockierte Quelle</th><th scope="col">Seite</th><th scope="col">Anzahl</th><th scope="col">Zuletzt</th></tr></thead>
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
        </details>
      )}
    </section>
  )
}

function Steps({ steps }: { steps: { name: string; sub: string; state: StepState; progress?: number }[] }) {
  return (
    <ol className="csp-steps">
      {steps.map((s, i) => (
        <li key={s.name} className={`csp-step csp-step-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
          <span className="csp-step-bar" aria-hidden="true"><span style={{ width: s.state === 'done' ? '100%' : s.state === 'active' ? `${Math.max(12, Math.round((s.progress ?? 0.35) * 100))}%` : '0%' }} /></span>
          <span className="csp-step-name">{i + 1} · {s.name}<span className="visually-hidden"> ({STEP_WORD[s.state]})</span></span>
          <span className="csp-step-sub">{s.sub}</span>
        </li>
      ))}
    </ol>
  )
}

function BlockList({ rows }: { rows: ReturnType<typeof wouldBlock> }) {
  return (
    <div className="sec-block">
      <h3 className="sec-label">Würde blockieren</h3>
      <ul className="csp-block-list">
        {rows.map((r) => (
          <li key={`${r.text}${r.code}`}>
            <span>{r.text}{r.code && <> <code>{r.code}</code></>}</span>
            <span className="csp-block-n">{r.count === null ? 'Analyse' : `${r.count.toLocaleString('de-CH')}×`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
