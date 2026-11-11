import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { publicStateOf, type ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { useProjects } from '../lib/projects.js'
import { usePublicActions } from '../lib/public.js'
import { notifyOk } from '../lib/feedback.js'
import { IconSearch, IconWarn } from './Icons.js'

/**
 * Befehlspalette (⌘K / Ctrl+K): Seiten und Projekte finden, Aktionen
 * ausführen. Aktionen mit Rückfrage in der Oberfläche fragen hier gleich
 * nach (Offline nehmen: derselbe Text und dieselben Knöpfe wie im
 * «⋯»-Menü des Projekts); Aktionen ohne Rückfrage laufen sofort und melden
 * sich mit Toast.
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
  run: () => void
}

const PAGES: { label: string; to: string; words?: string }[] = [
  { label: 'Projekte', to: '/projekte', words: 'übersicht start' },
  { label: 'Neues Projekt', to: '/projekte/neu', words: 'anlegen erstellen' },
  { label: 'Security', to: '/security', words: 'sicherheit befunde scan' },
  { label: 'Domains', to: '/domains', words: 'zonen' },
  { label: 'Externe Ziele', to: '/extern', words: 'extern domain' },
  { label: 'Tokens', to: '/tokens', words: 'mcp claude schlüssel' },
  { label: 'Audit-Log', to: '/audit', words: 'audit protokoll aktivität' },
  { label: 'System', to: '/system', words: 'server dienste netz' },
  { label: 'Cloudflare & HTTPS', to: '/system/cloudflare', words: 'tunnel zertifikat https' },
  { label: 'Veröffentlichung', to: '/system/veroeffentlichung', words: 'pause-seite vorlage' },
  { label: 'Benachrichtigungen', to: '/system/benachrichtigungen', words: 'ntfy e-mail' },
  { label: 'GitHub', to: '/system/github', words: 'app repos' },
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

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const navigate = useNavigate()
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

  const go = (to: string) => { onClose(); navigate(to) }

  const items = useMemo<Item[]>(() => {
    // Nur vollständige Projekte (kaputte Einträge legen die Palette nicht lahm)
    const list = (projects.data?.projects ?? []).filter((p) => p && typeof p.name === 'string' && Array.isArray(p.routes))
    const out: Item[] = PAGES.map((pg) => ({ id: `page:${pg.to}`, group: 'Seiten', label: pg.label, hint: pg.to, words: pg.words, run: () => go(pg.to) }))
    for (const p of list) out.push({ id: `proj:${p.id}`, group: 'Projekte', label: p.name, hint: p.slug, run: () => go(`/projekte/${p.id}`) })
    out.push({ id: 'act:new', group: 'Aktionen', label: 'Neues Projekt anlegen', words: 'erstellen', run: () => go('/projekte/neu') })
    out.push({ id: 'act:token', group: 'Aktionen', label: 'Token erstellen', words: 'mcp claude anlegen', run: () => go('/tokens?neu=1') })
    for (const p of list) {
      out.push({ id: `act:deploy:${p.id}`, group: 'Aktionen', label: `Neu deployen · ${p.name}`, hint: p.slug, words: 'deploy', run: () => { onClose(); deploy.mutate(p) } })
      out.push({ id: `act:scan:${p.id}`, group: 'Aktionen', label: `Scan starten · ${p.name}`, hint: p.slug, words: 'security prüfen', run: () => { onClose(); scan.mutate(p) } })
      if (publicStateOf(p.routes) !== 'private') {
        out.push({ id: `act:offline:${p.id}`, group: 'Aktionen', label: `${publicStateOf(p.routes) === 'live' ? 'Offline nehmen' : 'Ganz offline nehmen'} · ${p.name}`, hint: p.slug, words: 'pausieren öffentlich', run: () => setConfirm(p) })
      }
    }
    return out
    // go/deploy/scan ändern sich nicht in einer Weise, die die Liste betrifft
  }, [projects.data])

  // Gefiltert und je Gruppe begrenzt; ohne Suche nur Seiten und Projekte, Aktionen ab dem ersten Zeichen
  const shown = useMemo(() => {
    const q = query.trim()
    const groups: Group[] = q ? ['Aktionen', 'Projekte', 'Seiten'] : ['Seiten', 'Projekte']
    return groups.flatMap((g) => items.filter((it) => it.group === g && matches(it, q)).slice(0, PER_GROUP))
  }, [items, query])

  useEffect(() => { setActive(0) }, [query])
  const current = shown[Math.min(active, shown.length - 1)]

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (confirm) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && current) { e.preventDefault(); current.run() }
  }

  useEffect(() => {
    if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [current, listId])

  let lastGroup: Group | null = null
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Befehle und Suche" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {confirm ? (
        <OfflineStep p={confirm} onBack={() => { setConfirm(null); requestAnimationFrame(() => inputRef.current?.focus()) }} onDone={onClose} />
      ) : (
        <>
          <div className="palette-search">
            <IconSearch />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
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
          <ul className="palette-list" id={listId} role="listbox" aria-label="Ergebnisse">
            {shown.length === 0 && <li className="palette-empty" role="presentation">Nichts gefunden. Versuche einen Projektnamen oder «deployen».</li>}
            {shown.map((it, i) => {
              const head: ReactNode = it.group !== lastGroup ? <li key={`h-${it.group}`} className="palette-group" role="presentation">{it.group}</li> : null
              lastGroup = it.group
              return [
                head,
                <li
                  key={it.id}
                  id={`${listId}-${it.id}`}
                  role="option"
                  aria-selected={it === current}
                  className="palette-item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => it.run()}
                >
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </li>,
              ]
            })}
          </ul>
          <p className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> auswählen · <kbd>Enter</kbd> ausführen · <kbd>?</kbd> alle Kürzel</p>
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
  useEffect(() => { first.current?.focus() }, [])
  return (
    <div className="palette-confirm" role="group" aria-label={`${p.name} offline nehmen bestätigen`}>
      <p className="palette-confirm-title">{state === 'live' ? 'Offline nehmen' : 'Ganz offline nehmen'} · {p.name}</p>
      <div className="menu-confirm">
        <IconWarn />
        <span>
          {state === 'live' ? <>Pausieren: Wartungsseite unter {host}. Ganz offline: der Name wird frei.</> : <>Der Name {host} wird frei.</>}
          {internal ? <> Intern weiter: {internal}</> : null}
        </span>
      </div>
      <div className="palette-confirm-actions">
        <button type="button" ref={first} onClick={onBack}>Abbrechen</button>
        {state === 'live' && <button type="button" className="button-danger-solid" onClick={() => { onDone(); pub.run({ op: 'pause' }) }}>Ja, pausieren</button>}
        <button type="button" className={state === 'live' ? 'button-danger' : 'button-danger-solid'} onClick={() => { onDone(); pub.run({ op: 'unpublish' }) }}>Ja, ganz offline nehmen</button>
      </div>
    </div>
  )
}
