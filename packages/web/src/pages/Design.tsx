import { useId, useMemo, useState, type ReactNode } from 'react'
import { projectState, type ResourceSample } from '@airlock/shared'
import { PageHead } from '../components/PageHead.js'
import { StatusBadge } from '../components/Status.js'
import { PublicPill } from '../components/Publication.js'
import { SetRow } from '../components/Publication.js'
import { GradeBadge, SeverityChips, SEVERITY_LABEL } from '../components/Security.js'
import { Ring } from '../components/SecurityCard.js'
import { Meter } from '../components/ProjectOverview.js'
import { Switch } from '../components/Switch.js'
import { Field } from '../components/Field.js'
import { EmptyState, ErrorState, PartialNote, Loading, SkCard, SkLines, SkRows, SkStats } from '../components/States.js'
import { IconAlert, IconBad, IconMore, IconOk, IconPending, IconPlus, IconSearch, IconWarn } from '../components/Icons.js'
import { notifyError, notifyOk, notifyWarn } from '../lib/feedback.js'
import { Logo } from '../components/Logo.js'
import { ConfirmDialogBody, InlineConfirm } from '../components/Confirm.js'
import { isoOf } from '../lib/dates.js'

/**
 * Interne Komponenten-Übersicht (nur angemeldet, nicht in der Navigation):
 * alle Bausteine in Hell und Dunkel nebeneinander. Die beiden Spalten setzen
 * die Tokens über .theme-light / .theme-dark (styles.css), unabhängig vom
 * Theme der Seite. Neue Bausteine hier eintragen, damit Varianten sichtbar
 * bleiben und nicht doppelt entstehen.
 */
export function Design() {
  return (
    <section className="page page-design">
      <PageHead crumbs={[{ label: 'Bausteine' }]} title="Bausteine">
        <p className="lede">Alle Bausteine der Oberfläche in Hell und Dunkel. Interne Seite, nur zum Nachschlagen.</p>
      </PageHead>
      <div className="design-cols">
        <section className="design-col theme-light" aria-labelledby="design-hell"><p className="design-col-label" id="design-hell">Hell</p><Catalog /></section>
        <section className="design-col theme-dark" aria-labelledby="design-dunkel"><p className="design-col-label" id="design-dunkel">Dunkel</p><Catalog /></section>
      </div>
    </section>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="design-block">
      <h2 className="design-title">{title}</h2>
      {children}
    </section>
  )
}

function Catalog() {
  const uid = useId()
  const [on, setOn] = useState(true)
  const [tab, setTab] = useState('a')
  // Messpunkte einmal pro Aufruf der Seite (bei jedem Rendern neu wäre die Linie unruhig)
  const [now] = useState(() => Date.now())
  const samples = useMemo<ResourceSample[]>(
    () => Array.from({ length: 60 }, (_, i) => ({ at: isoOf(now - (59 - i) * 60_000)!, cpu: 0.12 + 0.08 * Math.sin(i / 6) + (i === 44 ? 0.4 : 0), memMb: 380 + 12 * Math.sin(i / 9) })),
    [now],
  )
  return (
    <div className="design-catalog">
      <Block title="Knöpfe">
        <div className="design-row">
          <button type="button" className="button-primary">Primär</button>
          <button type="button">Sekundär</button>
          <button type="button" className="button-ghost">Ruhig</button>
          <button type="button" className="button-warn">Warnung</button>
          <button type="button" className="button-danger">Gefährlich</button>
          <button type="button" className="button-danger-solid">Ja, löschen</button>
        </div>
        <div className="design-row">
          <button type="button" className="button-primary button-small">Klein primär</button>
          <button type="button" className="button-small">Klein</button>
          <button type="button" className="link-button">Textknopf</button>
          <button type="button" className="button-icon" aria-label="Weitere Aktionen"><IconMore /></button>
          <button type="button" className="button-primary"><IconPlus /> Mit Zeichen</button>
        </div>
        <div className="design-row">
          <button type="button" className="button-primary" disabled>Deaktiviert</button>
          <button type="button" disabled>Deaktiviert</button>
          <button type="button" className="button-primary" disabled aria-busy="true">Lädt</button>
          <button type="button" disabled aria-busy="true">Lädt</button>
          <button type="button" className="button-danger-solid" disabled aria-busy="true">Lädt</button>
        </div>
      </Block>

      <Block title="Pillen und Zähler">
        <div className="design-row">
          {/* Alle Zustände aus projectState() (shared) */}
          {(['running', 'failed_old_running', 'paused', 'deploying', 'stopped', 'down'] as const).map((k) => {
            const s = projectState({
              status: k === 'deploying' ? 'deploying' : 'running', desiredState: k === 'stopped' ? 'stopped' : 'running',
              activeDeployment: k === 'down' ? null : { id: 'a' }, lastDeployment: k === 'failed_old_running' ? { id: 'b', status: 'failed' } : null,
              routes: k === 'paused' ? [{ target: 'public', pausedAt: 'x' }] : [], container: null,
            })
            return <StatusBadge key={k} state={s} />
          })}
        </div>
        <div className="design-row">
          <PublicPill state="live" /><PublicPill state="paused" /><PublicPill state="private" />
          <span className="chip">LAN</span><span className="chip">Tailnet</span>
        </div>
        <div className="design-row">
          <SeverityChips counts={{ critical: 1, high: 2, medium: 3, low: 4 }} />
        </div>
        <div className="design-row">
          <GradeBadge grade="A" score={97} /><GradeBadge grade="C" score={61} /><GradeBadge grade="D" score={38} />
          <span className="tab-count">6</span><span className="tab-count tab-count-warn">9</span><span className="tab-count tab-count-bad">2</span>
        </div>
      </Block>

      {/* UI-Qualität 7: Schweregrade mit eigener Form; Regel auch in docs/TEXTE.md */}
      <Block title="Schweregrade und Farbregel">
        <div className="design-row">
          {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
            <span key={s} className={`sev sev-${s}`}>{SEVERITY_LABEL[s]}</span>
          ))}
        </div>
        <div className="design-row sc-sevs">
          {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
            <span key={s} className={`sc-sev sc-sev-${s}`}><span className="sc-sev-mark" aria-hidden="true" />{s === 'critical' ? 1 : s === 'high' ? 2 : 3} {SEVERITY_LABEL[s]}</span>
          ))}
        </div>
        <ul className="design-rules">
          <li><strong>kritisch</strong> gefüllt rot, fett · <strong>hoch</strong> rot getönt · <strong>mittel</strong> gelb getönt · <strong>niedrig</strong> neutral – immer mit dem Wort.</li>
          <li>Rot: kaputt oder gefährlich. Gelb: Aufmerksamkeit. Grün: in Ordnung. Blau: läuft gerade, Hinweis. Grau: neutral.</li>
          <li>Farbe nie allein: immer mit Wort oder Zahl mit Wort. Schriftgrössen nur aus der Skala, nichts unter 12 px.</li>
        </ul>
      </Block>

      <Block title="Zeilen">
        <div className="set-card">
          <div className="set-head"><h2>Karte mit Zeilen</h2><span className="set-count">2 aktiv</span></div>
          <SetRow label="Bezeichnung"><strong className="set-strong">Wert</strong> <span className="muted">· Erklärung dazu</span></SetRow>
          <SetRow label={<span id={`${uid}-sw`}>Mit Schalter</span>} action={<Switch checked={on} onChange={setOn} labelledBy={`${uid}-sw`} />}><span className="muted">{on ? 'an' : 'aus'}</span></SetRow>
          <SetRow label={<span id={`${uid}-sw2`}>Schalter speichert</span>} action={<Switch checked onChange={() => {}} labelledBy={`${uid}-sw2`} busy />}><span className="muted">busy</span></SetRow>
          <SetRow label={<span id={`${uid}-sw3`}>Schalter gesperrt</span>} action={<Switch checked={false} onChange={() => {}} labelledBy={`${uid}-sw3`} disabled />}><span className="muted">deaktiviert</span></SetRow>
        </div>
        <div className="table-scroll design-gap">
          <table className="table">
            <thead><tr><th>Name</th><th>Zuletzt</th><th><span className="visually-hidden">Aktion</span></th></tr></thead>
            <tbody>
              <tr><td>Claude Desktop</td><td>vor 3 Min.</td><td className="row-actions"><button type="button" className="button-small">Widerrufen</button></td></tr>
              <tr><td>CI</td><td className="muted">nie</td><td className="row-actions"><button type="button" className="button-small">Widerrufen</button></td></tr>
            </tbody>
          </table>
        </div>
      </Block>

      <Block title="Karten">
        <div className="stats design-stats">
          <div className="stat"><div className="label">Kennzahl</div><div className="stat-value">7</div><div className="stat-sub">Unterzeile</div></div>
          <div className="stat"><div className="label">Mit Befund</div><div className="stat-value tone-bad">1 kritisch</div><div className="stat-sub">Zustandsfarbe mit Wort</div></div>
        </div>
        <div className="panel panel-pad design-gap">
          <div className="panel-head"><h2>Karte</h2><button type="button" className="link-button">Aktion</button></div>
          <p className="muted">Inhalt einer Karte auf der Projektseite.</p>
        </div>
      </Block>

      <Block title="Reiter">
        <div className="tabs design-tabs" role="tablist" aria-label="Beispiel">
          {[['a', 'Übersicht', 0], ['b', 'Security', 9], ['c', 'Deployments', 6]].map(([k, label, n]) => (
            <button key={k as string} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' tab-active' : ''}`} onClick={() => setTab(k as string)}>
              {label}{(n as number) > 0 && <span className={`tab-count${k === 'b' ? ' tab-count-warn' : ''}`}>{n}</span>}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          <button type="button" aria-pressed="true">Alle <span className="num">7</span></button>
          <button type="button" aria-pressed="false">Laufen <span className="num">4</span></button>
          <button type="button" aria-pressed="false">Fehler</button>
        </div>
      </Block>

      <Block title="Menü">
        <div className="menu design-static">
          <div className="menu-list" data-open="" role="menu" aria-label="Beispielmenü">
            <div className="menu-group-label" aria-hidden="true">Gruppe</div>
            <button type="button" role="menuitem">Neu starten …</button>
            <button type="button" role="menuitem">Offline nehmen …</button>
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-danger">Löschen …</button>
          </div>
        </div>
        <div className="menu design-static">
          <div className="menu-list" data-open="" role="menu" aria-label="Rückfrage im Menü">
            <div className="menu-confirm"><IconWarn /><span>Rückfrage im Menü: was passiert, in einem Satz.</span></div>
            <button type="button" role="menuitem" className="menu-danger-solid">Ja, stoppen</button>
            <button type="button" role="menuitem">Abbrechen</button>
          </div>
        </div>
      </Block>

      <Block title="Dialog">
        <div className="dialog design-static-dialog" role="group" aria-label="Beispieldialog">
          <div className="dialog-body">
            <h2>Titel des Dialogs</h2>
            <p className="dialog-lede">Ein Satz, worum es geht.</p>
            <div className="dialog-actions"><button type="button">Abbrechen</button><button type="button" className="button-primary">Speichern</button></div>
          </div>
        </div>
      </Block>

      <Block title="Rückfragen">
        {/* Antwort 3/10: inline für normale Rückfragen, modal nur für Zerstörerisches (components/Confirm.tsx) */}
        <div className="design-row">
          <InlineConfirm label="Beispiel-Rückfrage" focus="none" note="Was passiert, in einem Satz." confirmLabel="Ja, stoppen" onCancel={() => {}} onConfirm={() => {}} />
        </div>
        <div className="design-row">
          <InlineConfirm label="Beispiel-Rückfrage klein" focus="none" small tone="primary" note="Kleine Variante in Zeilen und Karten." confirmLabel="Ja, übernehmen" onCancel={() => {}} onConfirm={() => {}} />
        </div>
        <div className="dialog confirm-dialog design-static-dialog" role="group" aria-label="Beispiel: Löschen bestätigen">
          <ConfirmDialogBody title="«Beispiel» löschen?" confirmLabel="Endgültig löschen" ready={false} typeToConfirm={{ value: 'beispiel', label: 'Kurzname zur Bestätigung' }}>
            <p>Lässt sich nicht rückgängig machen.</p>
          </ConfirmDialogBody>
        </div>
      </Block>

      <Block title="Toasts">
        <p className="muted">Ein Toaster für die ganze App (unten rechts), Muster in lib/feedback.ts.</p>
        <div className="design-row">
          <button type="button" className="button-small" onClick={() => notifyOk('Gespeichert', { description: 'Mit Beschreibung und Rückgängig.', undo: () => notifyOk('Rückgängig gemacht') })}>Erfolg</button>
          <button type="button" className="button-small" onClick={() => notifyWarn('Mit Warnung', { description: 'Hat geklappt, aber …' })}>Warnung</button>
          <button type="button" className="button-small" onClick={() => notifyError('Nicht gespeichert', new Error('Der Grund in einem Satz.'))}>Fehler</button>
        </div>
      </Block>

      <Block title="Formularfelder">
        <Field id={`${uid}-name`} label="Name" hint="Hinweis unter dem Feld.">
          <input id={`${uid}-name`} defaultValue="hallo-welt" aria-describedby={`${uid}-name-hint`} />
        </Field>
        <Field id={`${uid}-port`} label="Port" error="Port zwischen 1 und 65535 angeben, z. B. 8080.">
          <input id={`${uid}-port`} defaultValue="99999" aria-invalid="true" aria-describedby={`${uid}-port-error`} />
        </Field>
        <Field id={`${uid}-sel`} label="Auswahl" optional>
          <select id={`${uid}-sel`} defaultValue="b"><option value="a">Erste</option><option value="b">Zweite</option></select>
        </Field>
        <label className="choice"><input type="checkbox" defaultChecked /><span>Ankreuzfeld</span></label>
        <div className="search design-gap"><IconSearch /><input type="search" aria-label="Suchen" placeholder="Suchen …  /" /></div>
      </Block>

      <Block title="Code-Feld und Log">
        <textarea className="code-input" rows={4} aria-label="Code" defaultValue={'<!doctype html>\n<title>Wartung</title>\n<p>Gleich zurück.</p>'} spellCheck={false} />
        <pre className="log design-gap">{'12:04:01 listening on :8080\n12:04:02 WARN cache leer\n12:04:03 ERROR Verbindung abgelehnt'}</pre>
      </Block>

      <Block title="Skeletons">
        <Loading label="Beispiel lädt"><SkStats n={2} /></Loading>
        <div className="design-gap"><Loading label="Beispiel lädt"><SkRows n={2} /></Loading></div>
        <div className="design-gap"><Loading label="Beispiel lädt"><SkCard lines={2} /></Loading></div>
        <div className="design-gap"><Loading label="Beispiel lädt"><SkLines n={2} /></Loading></div>
      </Block>

      <Block title="Leer, Fehler, Teilweise, Hinweise">
        <EmptyState title="Noch nichts da" action={<button type="button">Nächster Schritt</button>}>Ein Satz, was hier erscheinen wird.</EmptyState>
        {/* Hier kompakt (role=status): ein Seitenfehler (role=alert) würde beim Laden der Übersicht angesagt */}
        <ErrorState compact what="Die Liste" error={new Error('Datenbank antwortet nicht.')} onRetry={() => {}} />
        <ErrorState compact plural what="Die Einträge" error={new Error('Zeitüberschreitung nach 5 s.')} onRetry={() => {}} />
        <PartialNote onRetry={() => {}}>Ein Teil fehlt, der Rest ist vollständig.</PartialNote>
        <div className="stale-bar"><span className="stale-bar-icon" aria-hidden="true"><IconWarn size={16} /></span><p><strong>Keine Verbindung zum Server.</strong> Angezeigt ist der Stand vor 3 Min.</p><button type="button" className="button-small">Erneut versuchen</button></div>
        <div className="alert" role="note"><span className="alert-icon"><IconAlert /></span><div className="alert-body"><strong>Hinweis mit Aktion</strong><span>Erklärung in einem Satz.</span></div><div className="alert-actions"><button type="button">Aktion</button></div></div>
        <p className="banner banner-warn"><strong>Warnung:</strong> Banner über einer Seite.</p>
        <p className="banner banner-info">Info-Banner.</p>
        <p className="notice notice-info">Hinweis in einer Zeile (notice).</p>
        <p className="error" role="note">Fehlerzeile unter einem Formular (error).</p>
        <p className="hint">Hinweistext unter einem Bereich.</p>
      </Block>

      <Block title="Zeichen">
        <div className="design-row design-icons">
          <span><Logo size={24} /> Bildmarke (provisorisch)</span>
          <span className="cf-ok"><IconOk /> ok</span><span className="cf-bad"><IconBad /> Fehler</span><span className="muted"><IconPending /> offen</span><span className="muted"><IconWarn /> Warnung</span>
        </div>
      </Block>

      <Block title="Diagramme">
        <div className="design-ring"><Ring grade="B" score={84} /></div>
        <div className="ov-meters">
          <Meter label="CPU" unit="CPU" limit={1} samples={samples} pick={(s) => s.cpu} fmt={(v) => v.toLocaleString('de-CH', { maximumFractionDigits: 2 })} />
          <Meter label="RAM" unit="MB" limit={1024} samples={samples} pick={(s) => s.memMb} fmt={(v) => Math.round(v).toLocaleString('de-CH')} />
        </div>
      </Block>
    </div>
  )
}
