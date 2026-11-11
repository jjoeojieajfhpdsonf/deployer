import { Link, useNavigate } from 'react-router-dom'
import type { SetupStep } from '@airlock/shared'
import { PageHead } from '../components/PageHead.js'
import { ErrorState, Loading, SkCard, SkHead } from '../components/States.js'
import { IconOk, IconPending, IconSkipped } from '../components/Icons.js'
import { useSaveSetup, useSetup, type SetupStepState } from '../lib/setup.js'

/**
 * Einrichtungs-Assistent: erscheint beim ersten Start (bzw. solange etwas
 * fehlt und er nicht mit «Später» ausgeblendet ist), jederzeit überspringbar,
 * unter System → Übersicht fortsetzbar. Jeder Schritt führt an die Stelle,
 * an der das eingerichtet wird; der Stand kommt aus den Daten selbst.
 */
export function Setup() {
  const s = useSetup()
  const save = useSaveSetup()
  const navigate = useNavigate()

  if (!s.ready) {
    return (
      <section className="page page-medium">
        {s.error ? <ErrorState what="Der Stand der Einrichtung" error={s.error} /> : <Loading label="Einrichtung wird geladen"><SkHead /><SkCard lines={3} /><SkCard lines={3} className="sk-gap-lg" /></Loading>}
      </section>
    )
  }

  const setSkipped = (key: SetupStep, skip: boolean) => {
    const skipped = skip ? [...new Set([...s.prefs.skipped, key])] : s.prefs.skipped.filter((k) => k !== key)
    save.mutate({ ...s.prefs, skipped })
  }
  const later = () => {
    save.mutate({ ...s.prefs, dismissed: true })
    navigate('/projekte')
  }
  const finished = s.open === 0

  return (
    <section className="page page-medium setup">
      <PageHead crumbs={[{ label: 'System', to: '/system' }, { label: 'Einrichtung' }]} title="Einrichtung">
        <p className="lede">Fünf Schritte, bis Airlock fertig eingerichtet ist. Jeder lässt sich überspringen und später unter System fortsetzen.</p>
      </PageHead>

      <div className="setup-progress" role="group" aria-label="Fortschritt der Einrichtung">
        <div className="setup-progress-text">
          <strong className="num">{s.done} von {s.total}</strong> erledigt
          {s.steps.some((x) => x.skipped) && <span className="muted"> · {s.steps.filter((x) => x.skipped).length} übersprungen</span>}
        </div>
        <span className="setup-bar" aria-hidden="true"><span style={{ width: `${(s.done / s.total) * 100}%` }} /></span>
        <button type="button" onClick={later}>{finished ? 'Fertig' : 'Später fortsetzen'}</button>
      </div>

      {/* role=list: Safari/VoiceOver nimmt Listen ohne Aufzählungszeichen sonst die Semantik */}
      <ol className="setup-steps" role="list">
        {s.steps.map((step, i) => (
          <StepCard key={step.key} n={i + 1} step={step} current={step.key === s.current} onSkip={(skip) => setSkipped(step.key, skip)} busy={save.isPending} />
        ))}
      </ol>
    </section>
  )
}

function StepCard({ n, step, current, onSkip, busy }: { n: number; step: SetupStepState; current: boolean; onSkip: (skip: boolean) => void; busy: boolean }) {
  // Zustand immer mit Zeichen und Wort
  const state = step.done ? { cls: 'done', word: 'erledigt', icon: <IconOk /> }
    : step.running ? { cls: 'open', word: 'läuft', icon: <IconPending /> }
    : step.skipped ? { cls: 'skipped', word: 'übersprungen', icon: <IconSkipped /> }
    : { cls: 'open', word: current ? 'als Nächstes' : 'offen', icon: <IconPending /> }
  return (
    <li className={`setup-step setup-step-${state.cls}${current ? ' setup-step-current' : ''}`} aria-current={current ? 'step' : undefined}>
      <span className="setup-step-n num" aria-hidden="true">{n}</span>
      <div className="setup-step-body">
        <div className="setup-step-head">
          <h2>{step.title}</h2>
          <span className={`setup-state setup-state-${state.cls}`}>{state.icon}{state.word}</span>
        </div>
        <p className="setup-step-detail">{step.detail}</p>
        {!step.done && <p className="setup-step-why">{step.why}</p>}
        {!step.done && (
          <div className="setup-step-actions">
            <Link className={current ? 'button button-primary' : 'button'} to={step.action.to}>{step.action.label}</Link>
            {/* aria-disabled statt disabled: der Fokus bleibt auf dem Knopf, solange gespeichert wird */}
            {step.skipped
              ? <button type="button" className="link-button" onClick={() => { if (!busy) onSkip(false) }} aria-disabled={busy || undefined}>Doch einrichten</button>
              : <button type="button" className="link-button" onClick={() => { if (!busy) onSkip(true) }} aria-disabled={busy || undefined}>Überspringen</button>}
          </div>
        )}
      </div>
    </li>
  )
}

/** Karte unter System → Übersicht: Stand und «Fortsetzen» */
export function SetupSummary() {
  const s = useSetup()
  const save = useSaveSetup()
  // Sichtbar, solange nicht alles erledigt ist – auch wenn der Rest nur übersprungen ist
  if (!s.ready || s.done === s.total) return null
  return (
    <section className="panel panel-pad setup-summary" aria-labelledby="setup-summary-h">
      <div className="panel-head">
        <h2 id="setup-summary-h">Einrichtung</h2>
        <span className="muted num">{s.done} von {s.total} erledigt</span>
      </div>
      <p className="muted">
        {s.open > 0 ? <>Offen: {s.steps.filter((x) => !x.done && !x.skipped).map((x) => x.title).join(', ')}.</> : <>Übersprungen: {s.steps.filter((x) => x.skipped).map((x) => x.title).join(', ')}.</>}
        {s.dismissed ? ' Der Assistent erscheint nicht mehr von selbst.' : ''}
      </p>
      <div className="form-actions">
        <Link className="button button-primary" to="/einrichtung" onClick={() => { if (s.dismissed) save.mutate({ ...s.prefs, dismissed: false }) }}>Einrichtung fortsetzen</Link>
      </div>
    </section>
  )
}
