import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useGuardedNavigate } from '../lib/unsaved.js'
import { useEnv, useEnvPath } from '../lib/env.js'
import { publicStateOf, type ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { useProjects, isLive } from '../lib/projects.js'
import { usePublicActions } from '../lib/public.js'
import { notifyOk } from '../lib/feedback.js'
import { isScanRunning } from '../lib/activities.js'
import { IconSearch, IconWarn } from './Icons.js'

/**
 * Befehlspalette (⌘K / Ctrl+K): Seiten und Projekte finden, Aktionen
 * ausführen. Aktionen mit Rückfrage in der Oberfläche fragen hier gleich
 * nach (Offline nehmen: derselbe Text und dieselben Knöpfe wie im
 * «⋯»-Menü des Projekts); Aktionen ohne Rückfrage laufen sofort und melden
 * sich mit Toast. Gesperrt ist, was auch in der Oberfläche gesperrt ist
 * (Deploy läuft schon, Scan läuft schon, Projekt gestoppt) – mit Grund.
 */

type Group = 'Seiten' | 'Projekte' | 'Aktionen'
interface Item {
  id: string
  group: Group
  label: string
  /** Zusatz rechts, z. B. Kurzname oder Pfad */
  hint?: string
  /** Weitere Suchwörter */
  words?: string
  /** Gesperrt, mit Grund (wird statt des Hinweises gezeigt) */
  blocked?: string
  run: () => void
}

/** env: Pfad in der gewählten Umgebung (M9: /u/<umgebung>/…); sonst gilt er für alle Umgebungen */
const PAGES: { label: string; to: string; env?: boolean; words?: string }[] = [
  { label: 'Projekte', to: '/projekte', env: true, words: 'übersicht start' },
  { label: 'Neues Projekt', to: '/projekte/neu', env: true, words: 'anlegen erstellen' },
  { label: 'Security', to: '/security', env: true, words: 'sicherheit befunde scan' },
  // UI-Qualität 6: neue Orte (die alten Adressen leiten ebenfalls weiter)
  { label: 'Externe Ziele', to: '/security/extern', env: true, words: 'extern domain security' },
  { label: 'Audit-Log', to: '/audit', env: true, words: 'audit protokoll aktivität' },
  { label: 'Tokens', to: '/einstellungen/tokens', env: true, words: 'mcp claude schlüssel' },
  { label: 'Einstellungen', to: '/einstellungen', env: true, words: 'umgebung name kürzel' },
  { label: 'Cloudflare & HTTPS', to: '/einstellungen/cloudflare', env: true, words: 'tunnel zertifikat https' },
  { label: 'Domains', to: '/einstellungen/cloudflare#domains', env: true, words: 'zonen cloudflare' },
  { label: 'Standards', to: '/einstellungen/standards', env: true, words: 'header access pause-seite vorlage veröffentlichung' },
  { label: 'Umgebungen', to: '/umgebungen', words: 'umgebung wechseln anlegen' },
  { label: 'Server', to: '/server', words: 'system dienste netz' },
  { label: 'Benachrichtigungen', to: '/server/benachrichtigungen', words: 'ntfy e-mail' },
  { label: 'GitHub', to: '/server/github', words: 'app repos' },
  { label: 'Backup', to: '/server/backup', words: 'sicherung restic wiederherstellen schlüssel' },
  { label: 'Einrichtung', to: '/einrichtung', words: 'assistent erster start' },
  { label: 'Konto', to: '/konto', words: 'passwort profil' },
  { label: 'Bausteine', to: '/design', words: 'design komponenten' },
]

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
/** Alle Wörter der Suche müssen vorkommen (in beliebiger Reihenfolge) */
const matches = (it: Item, q: string) => {
  if (!q) return true
  const hay = norm(`${it.label} ${it.hint ?? ''} ${it.words ?? ''} ${it.group}`)
  return norm(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

const PER_GROUP = 8

/** Nach einem Seitenwechsel: Fokus an den Anfang des Inhalts, nicht ins Leere */
function focusMain() {
  requestAnimationFrame(() => {
    const main = document.querySelector<HTMLElement>('main.main')
    if (!main) return
    main.tabIndex = -1
    main.focus({ preventScroll: true })
  })
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  // Mit Rückfrage bei ungespeicherten Änderungen (UI-Qualität 8)
  const navigate = useGuardedNavigate()
  const qc = useQueryClient()
  const projects = useProjects()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Rückfrage innerhalb der Palette (wie im Menü)
  const [confirm, setConfirm] = useState<ProjectDto | null>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setQuery('')
      setActive(0)
      setConfirm(null)
      d.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    if (!open && d.open) d.close()
  }, [open])

  const deploy = useMutation({
    meta: { errorTitle: 'Deploy nicht gestartet' },
    mutationFn: (p: ProjectDto) => api.deploy(p.id),
    onSuccess: (_r, p) => {
      notifyOk(`Deploy für «${p.name}» gestartet`, { id: `act-${p.id}`, description: 'Der Fortschritt steht oben bei «Vorgänge» und auf der Projektseite.' })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const scan = useMutation({
    meta: { errorTitle: 'Scan nicht gestartet' },
    mutationFn: (p: ProjectDto) => api.startScan(p.id),
    onSuccess: (_r, p) => {
      notifyOk(`Scan für «${p.name}» gestartet`, { id: `scan-start-${p.id}`, description: 'Das Ergebnis erscheint im Reiter Security.' })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  // Nach dem Seitenwechsel den Inhalt fokussieren – erst im close-Ereignis des Dialogs, denn
  // der native Dialog gibt den Fokus beim Schliessen an das vorherige Element (<body>) zurück
  const focusAfterClose = useRef(false)
  const go = (to: string) => { focusAfterClose.current = true; onClose(); void navigate(to) }
  const ep = useEnvPath()
  const { slug } = useEnv()

  const items = useMemo<Item[]>(() => {
    // Nur vollständige Projekte (kaputte Einträge legen die Palette nicht lahm)
    const list = (projects.data?.projects ?? []).filter((p) => p && typeof p.name === 'string' && Array.isArray(p.routes))
    const out: Item[] = PAGES.map((pg) => {
      const to = pg.env ? ep(pg.to) : pg.to
      return { id: `page:${pg.to}`, group: 'Seiten', label: pg.label, hint: to, words: pg.words, run: () => go(to) }
    })
    for (const p of list) out.push({ id: `proj:${p.id}`, group: 'Projekte', label: p.name, hint: p.slug, run: () => go(ep(`/projekte/${p.id}`)) })
    out.push({ id: 'act:new', group: 'Aktionen', label: 'Neues Projekt anlegen', words: 'erstellen', run: () => go(ep('/projekte/neu')) })
    out.push({ id: 'act:token', group: 'Aktionen', label: 'Token erstellen', words: 'mcp claude anlegen', run: () => go(ep('/einstellungen/tokens?neu=1')) })
    for (const p of list) {
      // Gleiche Sperren wie Projektkopf und Security-Übersicht
      const deploying = p.state.key === 'deploying' || (deploy.isPending && deploy.variables?.id === p.id)
      out.push({
        id: `act:deploy:${p.id}`, group: 'Aktionen', label: `Neu deployen · ${p.name}`, hint: p.slug, words: 'deploy',
        blocked: deploying ? 'Deploy läuft schon' : undefined,
        run: () => { onClose(); deploy.mutate(p) },
      })
      const scanning = isScanRunning(p) || (scan.isPending && scan.variables?.id === p.id)
      const stopped = !isLive(p) && p.runtimeKind !== 'static'
      out.push({
        id: `act:scan:${p.id}`, group: 'Aktionen', label: `Scan starten · ${p.name}`, hint: p.slug, words: 'security prüfen',
        blocked: scanning ? 'Scan läuft schon' : stopped ? 'Projekt läuft nicht' : undefined,
        run: () => { onClose(); scan.mutate(p) },
      })
      if (publicStateOf(p.routes) !== 'private') {
        out.push({ id: `act:offline:${p.id}`, group: 'Aktionen', label: `${publicStateOf(p.routes) === 'live' ? 'Offline nehmen' : 'Ganz offline nehmen'} · ${p.name}`, hint: p.slug, words: 'pausieren öffentlich', run: () => setConfirm(p) })
      }
    }
    return out
    // go/onClose ändern sich nicht in einer Weise, die die Liste betrifft
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ep hängt nur an der Umgebung (slug)
  }, [projects.data, deploy.isPending, deploy.variables, scan.isPending, scan.variables, slug])

  // Gefiltert und je Gruppe begrenzt; ohne Suche nur Seiten und Projekte, Aktionen ab dem ersten Zeichen
  const groups = useMemo(() => {
    const q = query.trim()
    const order: Group[] = q ? ['Aktionen', 'Projekte', 'Seiten'] : ['Seiten', 'Projekte']
    return order.map((g) => ({ group: g, items: items.filter((it) => it.group === g && matches(it, q)).slice(0, PER_GROUP) })).filter((g) => g.items.length > 0)
  }, [items, query])
  const shown = groups.flatMap((g) => g.items)

  useEffect(() => { setActive(0) }, [query])
  const current = shown[Math.min(active, shown.length - 1)]

  const pick = (it: Item | undefined) => { if (it && !it.blocked) it.run() }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Eingabe mit IME noch nicht bestätigt: Enter gehört der Eingabe
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(current) }
  }

  useEffect(() => {
    if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [current, listId])

  // Esc in der Rückfrage: zurück zur Liste (wie «Abbrechen»), nicht gleich alles zu
  const backToList = () => { setConfirm(null); requestAnimationFrame(() => inputRef.current?.focus()) }

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Befehle und Suche"
      onClose={() => {
        onClose()
        if (focusAfterClose.current) { focusAfterClose.current = false; focusMain() }
      }}
      onCancel={(e) => { if (confirm) { e.preventDefault(); backToList() } }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {confirm ? (
        <OfflineStep p={confirm} onBack={backToList} onDone={onClose} />
      ) : (
        <>
          <div className="palette-search">
            <IconSearch />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls={listId}
              aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
              aria-autocomplete="list"
              aria-label="Seite, Projekt oder Aktion suchen"
              placeholder="Seite, Projekt oder Aktion suchen"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="palette-kbd">Esc</kbd>
          </div>
          <div className="palette-list" id={listId} role="listbox" aria-label="Ergebnisse">
            {groups.map(({ group, items: list }) => (
              <div key={group} role="group" aria-labelledby={`${listId}-g-${group}`}>
                <div className="palette-group" id={`${listId}-g-${group}`} role="presentation">{group}</div>
                {list.map((it) => {
                  const i = shown.indexOf(it)
                  const isActive = it === current
                  return (
                    <div
                      key={it.id}
                      id={`${listId}-${it.id}`}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={it.blocked ? true : undefined}
                      className={`palette-item${it.blocked ? ' palette-item-blocked' : ''}`}
                      onMouseMove={() => setActive(i)}
                      onClick={() => pick(it)}
                    >
                      <span className="palette-label">{it.label}</span>
                      <span className="palette-hint">{it.blocked ?? it.hint}</span>
                      {/* Aktive Zeile: Zeichen dazu, nicht nur die Fläche */}
                      {isActive && !it.blocked && <kbd className="palette-enter" aria-hidden="true">↵</kbd>}
                    </div>
                  )
                })}
              </div>
            ))}
            {shown.length === 0 && <p className="palette-empty">Nichts gefunden. Versuche einen Projektnamen oder «deployen».</p>}
          </div>
          {/* Trefferzahl für Screenreader */}
          <p className="sr-only" role="status">{query.trim() ? (shown.length === 0 ? 'Nichts gefunden' : shown.length === 1 ? '1 Treffer' : `${shown.length} Treffer`) : ''}</p>
          <p className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> auswählen · <kbd>Enter</kbd> ausführen · <kbd>Esc</kbd> schliessen</p>
        </>
      )}
    </dialog>
  )
}

/** Rückfrage «Offline nehmen» – Text und Knöpfe wie im «⋯»-Menü (ProjectMenuItems) */
function OfflineStep({ p, onBack, onDone }: { p: ProjectDto; onBack: () => void; onDone: () => void }) {
  const pub = usePublicActions(p)
  const state = publicStateOf(p.routes)
  const host = p.routes.find((r) => r.target === 'public')?.hostname
  const internal = p.routes.find((r) => r.target !== 'public')?.urls[0]?.replace(/^https?:\/\//, '')
  const first = useRef<HTMLButtonElement>(null)
  const noteId = useId()
  useEffect(() => { first.current?.focus() }, [])
  return (
    <div className="palette-confirm" role="group" aria-label={`${p.name} offline nehmen bestätigen`} aria-describedby={noteId}>
      <p className="palette-confirm-title">{state === 'live' ? 'Offline nehmen' : 'Ganz offline nehmen'} · {p.name}</p>
      <div className="menu-confirm" id={noteId}>
        <IconWarn />
        <span>
          {state === 'live' ? <>Pausieren: Wartungsseite unter {host}. Ganz offline: der Name wird frei.</> : <>Der Name {host} wird frei.</>}
          {internal ? <> Intern weiter: {internal}</> : null}
        </span>
      </div>
      <div className="palette-confirm-actions">
        <button type="button" ref={first} onClick={onBack}>Abbrechen</button>
        {state === 'live' && <button type="button" className="button-danger-solid" disabled={pub.pending} onClick={() => { onDone(); pub.run({ op: 'pause' }) }}>Ja, pausieren</button>}
        <button type="button" className={state === 'live' ? 'button-danger' : 'button-danger-solid'} disabled={pub.pending} onClick={() => { onDone(); pub.run({ op: 'unpublish' }) }}>Ja, ganz offline nehmen</button>
      </div>
    </div>
  )
}
