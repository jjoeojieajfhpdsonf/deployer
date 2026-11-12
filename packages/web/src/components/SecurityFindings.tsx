import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { FixRequestDto, HeaderRulesDto } from '@airlock/shared'
import type { FindingDto } from '../api.js'
import { fmtDayMonth } from '../lib/dates.js'
import {
  SEVERITIES, SEVERITY_LABEL, SORT_LABEL, detailsLink, findingHint, fixesFor, hasReadyFix, shortLocation, sortFindings, sourceOf,
  type Sev, type SortKey,
} from '../lib/security-view.js'
import { useFixRequestPrefix } from '../lib/fix-request.js'
import { AcceptFindingForm, TOOL_LABEL } from './Security.js'
import { HeaderFixAction } from './HeaderFix.js'
import { ClaudeFixAction, FixCard, fixInFlight } from './ClaudeFix.js'
import { IconSpark } from './Actor.js'
import { IconExternal, IconLock } from './Icons.js'

/**
 * Reiter Security › Befunde: links die Liste (Filter nach Schwere,
 * Sortierung), rechts die Detailkarte des gewählten Befunds (Standard: der
 * schwerste). Pfeiltasten wechseln die Zeile. Unter 1100 px ist die
 * Detailkarte eine Schublade von rechts, unter 700 px eine eigene Seite.
 */

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

export const DRAWER_QUERY = '(max-width: 1099px)'

interface Props {
  projectId: string
  sourceType?: string
  findings: FindingDto[]
  fixes: FixRequestDto[]
  rules: HeaderRulesDto | undefined
  /** Nur Befunde dieses Werkzeugs (aus «Prüfungen») */
  toolFilter: string | null
  onClearTool: () => void
  onAccepted: () => void
  onFixDone: (msg: string) => void
  onCopied: () => void
  onOpenCsp: () => void
}

export function FindingsView(p: Props) {
  const open = p.findings.filter((f) => f.status === 'open')
  const other = p.findings.filter((f) => f.status !== 'open')
  const [sev, setSev] = useState<Sev | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('schwere')
  const [selected, setSelected] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const narrow = useMedia(DRAWER_QUERY)
  const listRef = useRef<HTMLUListElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const returnTo = useRef<string | null>(null)

  const byTool = p.toolFilter ? open.filter((f) => f.tool === p.toolFilter) : open
  const shown = useMemo(() => sortFindings(sev === 'all' ? byTool : byTool.filter((f) => f.severity === sev), sort, p.sourceType), [byTool, sev, sort, p.sourceType])
  // Standard: der schwerste der sichtbaren Befunde
  const fallback = sortFindings(shown, 'schwere')[0] ?? null
  const current = p.findings.find((f) => f.id === selected && (shown.includes(f) || f.status !== 'open')) ?? fallback
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, byTool.filter((f) => f.severity === s).length])) as Record<Sev, number>

  // Disketti «Ja»: den Befund wählen; sein Ablauf öffnet sich dann selbst
  useFixRequestPrefix('finding:', (id) => {
    if (!p.findings.some((f) => f.id === id)) return
    setSev('all')
    setSelected(id)
    if (narrow) setDrawer(true)
  })

  const choose = (id: string, focus = true) => {
    setSelected(id)
    if (focus) requestAnimationFrame(() => document.getElementById(`sec-row-${id}`)?.focus())
  }
  /** Klick wählt (breit: Fokus bleibt in der Liste); Enter und schmal: Fokus in die Detailkarte */
  const openDetail = (id: string, focusDetail = narrow) => {
    setSelected(id)
    returnTo.current = id
    if (narrow) setDrawer(true)
    if (focusDetail) requestAnimationFrame(() => detailHeading.current?.focus({ preventScroll: !narrow }))
  }
  const closeDrawer = () => {
    setDrawer(false)
    const id = returnTo.current ?? current?.id
    requestAnimationFrame(() => (id && document.getElementById(`sec-row-${id}`) || listRef.current)?.focus())
  }

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!shown.length) return
    // Massgeblich ist die Zeile mit dem Fokus (Klick, Tab); sonst die gewählte
    const focused = (e.target as HTMLElement).closest('[role="option"]')?.id.replace(/^sec-row-/, '')
    const i = Math.max(0, shown.findIndex((f) => f.id === (focused ?? current?.id)))
    const go = (j: number) => { e.preventDefault(); choose(shown[Math.max(0, Math.min(shown.length - 1, j))]!.id) }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(shown.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(shown[i]!.id, true) }
  }

  // Schublade: Escape schliesst; Hintergrund rollt nicht mit
  useEffect(() => {
    if (!narrow || !drawer) return
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeDrawer() } }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!narrow) setDrawer(false) }, [narrow])

  const readyElsewhere = current ? open.find((f) => f.id !== current.id && hasReadyFix(f, p.fixes)) ?? null : null
  // Vorschläge ohne offenen Befund (Befund inzwischen behoben, akzeptiert oder aus einem älteren Scan)
  const orphans = p.fixes.filter((x) => !p.findings.some((f) => fixesFor(f, [x]).length > 0))

  return (
    <div className={`sec-findings${narrow ? ' sec-findings-narrow' : ''}`}>
      <section className="panel sec-list" aria-labelledby="sec-list-title">
        <h2 id="sec-list-title" className="visually-hidden">Offene Befunde</h2>
        <div className="sec-toolbar">
          <div className="sec-filter" role="group" aria-label="Nach Schwere filtern">
            <button type="button" aria-pressed={sev === 'all'} onClick={() => setSev('all')}>Alle <span className="num">{byTool.length}</span></button>
            {SEVERITIES.map((s) => (
              <button key={s} type="button" aria-pressed={sev === s} disabled={counts[s] === 0 && sev !== s} onClick={() => setSev(s)}>
                {SEVERITY_LABEL[s][0]!.toUpperCase() + SEVERITY_LABEL[s].slice(1)} <span className="num">{counts[s]}</span>
              </button>
            ))}
          </div>
          <label className="sec-sort">
            <span className="visually-hidden">Sortierung</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        {p.toolFilter && (
          <p className="sec-toolnote">
            Nur Befunde von {TOOL_LABEL[p.toolFilter] ?? p.toolFilter}.{' '}
            <button type="button" className="link-button" onClick={p.onClearTool}>Alle Befunde zeigen</button>
          </p>
        )}
        {shown.length === 0 ? (
          <p className="sec-empty">{open.length === 0 ? 'Keine offenen Befunde.' : 'Keine Befunde mit diesem Filter.'}</p>
        ) : (
          <ul ref={listRef} className="sec-rows" role="listbox" aria-label="Offene Befunde" aria-orientation="vertical" onKeyDown={onListKey}>
            {shown.map((f) => {
              const hint = findingHint(f, { fixes: p.fixes, rules: p.rules, sourceType: p.sourceType })
              const loc = shortLocation(f.location)
              const sel = current?.id === f.id
              return (
                <li key={f.id} id={`sec-row-${f.id}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1}
                  className={`sec-row${sel ? ' is-selected' : ''}`}
                  // Breit folgt die Auswahl dem Fokus (Detail rechts); schmal erst mit Enter oder Klick
                  onFocus={() => { if (!narrow && !sel) setSelected(f.id) }}
                  onClick={() => openDetail(f.id)}>
                  <span className={`sev sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                  <span className="sec-row-main">
                    <span className="sec-row-title">{f.title}</span>
                    <span className="sec-row-sub">{sourceOf(f, p.sourceType)}{loc && <> · {loc}</>}</span>
                  </span>
                  {hint && (
                    <span className={`sec-hint sec-hint-${hint.kind}`}>
                      {hint.kind === 'claude' && <IconSpark />}
                      {hint.kind === 'csp' && <span aria-hidden="true">→ </span>}
                      {hint.label}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {(other.length > 0 || orphans.length > 0) && (
          <details className="sec-more">
            <summary>{other.length} akzeptiert oder behoben{orphans.length > 0 && `, ${orphans.length} ${orphans.length === 1 ? 'früherer Vorschlag' : 'frühere Vorschläge'} von Claude`}</summary>
            {other.length > 0 && (
              <ul className="sec-more-list">
                {other.map((f) => (
                  <li key={f.id}>
                    <button type="button" className={`sec-more-row${current?.id === f.id ? ' is-selected' : ''}`} aria-pressed={current?.id === f.id} onClick={() => openDetail(f.id)}>
                      <span className={`sev sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                      <span className="sec-row-title">{f.title}</span>
                      <span className="sec-row-sub">{f.status === 'accepted' ? 'akzeptiert' : 'behoben'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {orphans.length > 0 && (
              <ul className="finding-list sec-orphans">
                {orphans.map((x) => <FixCard key={x.id} projectId={p.projectId} fix={x} onDone={p.onFixDone} />)}
              </ul>
            )}
          </details>
        )}
      </section>

      {narrow && <div className="sec-scrim" data-open={drawer ? 'true' : 'false'} aria-hidden="true" onClick={closeDrawer} />}
      <div
        className={`panel sec-detail${narrow ? ' sec-drawer' : ''}`}
        data-open={narrow ? (drawer ? 'true' : 'false') : undefined}
        inert={narrow && !drawer ? true : undefined}
        aria-label={narrow && drawer ? 'Befund im Detail' : undefined}
        role={narrow && drawer ? 'dialog' : undefined}
        aria-modal={narrow && drawer ? true : undefined}
      >
        {narrow && (
          <div className="sec-drawer-top">
            <button type="button" className="button-small button-ghost" onClick={closeDrawer}><span aria-hidden="true">‹ </span>Zurück zur Liste</button>
          </div>
        )}
        {current ? (
          <FindingDetail key={current.id} f={current} p={p} headingRef={detailHeading}
            readyElsewhere={readyElsewhere} onSelect={(id) => openDetail(id, true)} />
        ) : (
          <p className="sec-empty">Kein Befund gewählt.</p>
        )}
      </div>
    </div>
  )
}

function FindingDetail({ f, p, headingRef, readyElsewhere, onSelect }: {
  f: FindingDto
  p: Props
  headingRef: RefObject<HTMLHeadingElement | null>
  readyElsewhere: FindingDto | null
  onSelect: (id: string) => void
}) {
  const [accepting, setAccepting] = useState(false)
  const link = detailsLink(f)
  const fixes = fixesFor(f, p.fixes)
  const shownFixes = f.status === 'open' ? fixes.filter((x) => fixInFlight(x) || x.status === 'failed').slice(0, 2) : fixes.slice(0, 1)
  const acceptButton = f.status === 'open' && !accepting
    ? <button type="button" className="button-small" onClick={() => setAccepting(true)}>Akzeptieren …</button>
    : null
  const details = link
    ? <a className="button-small button-ghost sec-ext" href={link.href} target="_blank" rel="noreferrer">{link.label}<IconExternal /><span className="visually-hidden"> (öffnet neues Fenster)</span></a>
    : null
  const titleId = `sec-detail-title-${f.id}`
  return (
    <section className="sec-detail-body" id={`befund-${f.id}`} aria-labelledby={titleId}>
      <div className="sec-detail-tags">
        <span className={`sev sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
        {f.status === 'accepted' && <span className="badge badge-neutral">akzeptiert</span>}
        {f.status === 'fixed' && <span className="badge badge-neutral">behoben</span>}
      </div>
      <h3 id={titleId} ref={headingRef} tabIndex={-1} className="sec-detail-title">{f.title}</h3>
      <p className="sec-detail-src">
        {TOOL_LABEL[f.tool] ?? f.tool} · <code>{f.location}</code>
        {f.firstSeenAt && <><br />gefunden {fmtDayMonth(f.firstSeenAt)}{f.seenIn ? ` · in ${f.seenIn} ${f.seenIn === 1 ? 'Scan' : 'Scans'}` : ''}</>}
      </p>
      {f.description && (
        <div className="sec-block">
          <h4 className="sec-label">Was heisst das?</h4>
          <p>{f.description}</p>
        </div>
      )}
      {f.fix && (
        <div className="sec-block">
          <h4 className="sec-label">So behebst du es</h4>
          <p>{f.fix}</p>
        </div>
      )}
      {f.status === 'open' && f.severity === 'critical' && (
        <p className="sec-lock"><IconLock />Solange offen, lässt sich das Projekt nicht öffentlich machen.</p>
      )}
      {f.status === 'accepted' && <p className="sec-state-note">✓ akzeptiert: {f.acceptReason}</p>}
      {f.status === 'fixed' && <p className="sec-state-note">✓ behoben</p>}
      {f.status === 'open' && (
        <div className="sec-detail-actions">
          <ClaudeFixAction
            projectId={p.projectId}
            finding={f}
            sourceType={p.sourceType}
            strong
            before={<HeaderFixAction projectId={p.projectId} finding={f} rules={p.rules} onDone={p.onFixDone} onOpenCsp={p.onOpenCsp} />}
            after={<>{acceptButton}{details}</>}
            onCopied={p.onCopied}
          />
        </div>
      )}
      {f.status !== 'open' && details && <div className="finding-actions">{details}</div>}
      {accepting && <AcceptFindingForm f={f} onAccepted={p.onAccepted} onClose={() => setAccepting(false)} />}
      {shownFixes.map((x) => <FixCard key={x.id} projectId={p.projectId} fix={x} onDone={p.onFixDone} compact />)}
      {readyElsewhere && !shownFixes.some((x) => x.status === 'proposed') && (
        <button type="button" className="sec-also" onClick={() => onSelect(readyElsewhere.id)}>
          <span className="claude-spark"><IconSpark /></span>
          <span>Auch bereit: Fix für «{readyElsewhere.title}»</span>
          <span className="sec-also-go">ansehen<span aria-hidden="true"> ›</span></span>
        </button>
      )}
    </section>
  )
}
