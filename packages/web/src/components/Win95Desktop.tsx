import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'
import { useMenu } from './useMenu.js'
import { useEnvPath } from '../lib/env.js'
import { confirmLeave } from '../lib/unsaved.js'
import { markLoggedOut } from '../lib/session.js'
import { fmtTime } from '../lib/dates.js'
import { NORMAL, nextWin, type Win, type WinAction } from '../lib/win95-windows.js'
import { useIsWin95 } from './Win95.js'

/**
 * Windows 95 als Desktop: Fenster-Knöpfe _ □ ✕ an jeder Karte und am
 * Hauptfenster «Airlock», Taskleiste mit Startmenü, minimierten Fenstern und
 * Uhr, Dialog «Airlock beenden» (neu starten oder abmelden; Herunterfahren
 * gesperrt). Nur aktiv, solange das Theme gilt.
 *
 * Die Karten gehören vielen Komponenten; statt in jede einen Knopf zu bauen,
 * hängt der Fenster-Manager eine Knopfleiste an (wie die Titelleiste reine
 * Mausbedienung, wie im Original: aria-hidden, nicht im Tab-Lauf). Alles
 * bleibt per Tastatur erreichbar: Minimierte Fenster holt die Taskleiste
 * zurück (echte Knöpfe), maximierte schliesst Esc, geschlossene öffnet das
 * Startmenü wieder; Neuladen setzt alles zurück.
 */

/** Was ein Fenster ist (Gestaltungskatalog /design ausgenommen) */
const CARDS = ':is(.panel, .stat, .pcard, .set-card, .bento-card, .gh-step):not(.design-col *)'
const MAIN = '.shell > .main'
const TITLE = '.ov-title, .set-head h2, .panel-head h2, .stat .label, .pcard-title h2, .pcard-title h3, h2, h3'

/* --- Zustand aller Fenster (ausserhalb von React: die Karten gehören fremden Komponenten) --- */

type Entry = { id: number; el: HTMLElement; title: string; win: Win }
let seq = 0
const entries = new Map<HTMLElement, Entry>()
let mainWin: Win = NORMAL
let askQuit = false
let version = 0
const listeners = new Set<() => void>()
const emit = () => { version++; listeners.forEach((f) => f()) }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
const useDesktop = () => useSyncExternalStore(subscribe, () => version, () => version)

const titleOf = (el: HTMLElement) => el.querySelector(TITLE)?.textContent?.trim().slice(0, 40) || 'Fenster'

function setCard(el: HTMLElement, win: Win): void {
  if (win.state === 'normal') {
    el.removeAttribute('data-w95')
    entries.delete(el)
  } else {
    el.setAttribute('data-w95', win.state)
    entries.set(el, { id: entries.get(el)?.id ?? ++seq, el, title: entries.get(el)?.title ?? titleOf(el), win })
  }
  emit()
}
const actCard = (el: HTMLElement, a: WinAction) => setCard(el, nextWin(entries.get(el)?.win ?? NORMAL, a))

function setMain(win: Win): void {
  mainWin = win
  const shell = document.querySelector('.shell')
  if (win.state === 'normal') shell?.removeAttribute('data-w95-main')
  else shell?.setAttribute('data-w95-main', win.state)
  emit()
}
const requestQuit = () => { askQuit = true; emit() }

/** Knopfleiste _ □ ✕ (Maus, wie im Original; Tastatur siehe oben) */
function caption(): HTMLElement {
  const c = document.createElement('span')
  c.className = 'w95-caption'
  c.setAttribute('aria-hidden', 'true')
  for (const a of ['min', 'max', 'close']) {
    const b = document.createElement('span')
    b.className = `w95-cap w95-cap-${a}`
    b.dataset.w95Act = a
    c.append(b)
  }
  return c
}

/** Neue Karten bekommen Knöpfe; verschwundene fallen aus der Taskleiste. */
function scan(): void {
  const els = [...document.querySelectorAll<HTMLElement>(`${CARDS}, ${MAIN}`)]
  for (const el of els) if (!el.querySelector(':scope > .w95-caption')) el.append(caption())
  let gone = false
  for (const el of entries.keys()) if (!el.isConnected) { entries.delete(el); gone = true }
  if (gone) emit()
}

function teardown(): void {
  document.querySelectorAll('.w95-caption').forEach((c) => c.remove())
  for (const el of entries.keys()) el.removeAttribute('data-w95')
  entries.clear()
  askQuit = false
  setMain(NORMAL)
}

/** Fenster-Manager: Knöpfe anhängen, Klicks, Doppelklick auf die Titelleiste, Esc. */
function useWindowManager(on: boolean): void {
  useEffect(() => {
    if (!on) return
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan() }) }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    scan()

    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.('[data-w95-act]')
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      const win = btn.parentElement?.parentElement as HTMLElement | null
      if (!win) return
      const a = btn.getAttribute('data-w95-act') as 'min' | 'max' | 'close'
      if (win.matches(MAIN)) {
        if (a === 'close') requestQuit()
        else setMain(nextWin(mainWin, a))
      } else actCard(win, a)
    }
    const onDouble = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t?.closest || t.closest('.w95-caption, a, button, input, select, textarea, label')) return
      const win = t.closest(`${CARDS}, ${MAIN}`) as HTMLElement | null
      // Nur die Titelleiste (oberste 24 px des Fensters)
      if (!win || e.clientY - win.getBoundingClientRect().top > 24) return
      window.getSelection()?.removeAllRanges()
      if (win.matches(MAIN)) setMain(nextWin(mainWin, 'titlebar'))
      else actCard(win, 'titlebar')
    }
    // Esc: maximierte Karte zurück auf normal (nicht, wenn ein Menü oder Dialog das Esc braucht)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      const max = [...entries.values()].filter((x) => x.win.state === 'max').sort((a, b) => b.id - a.id)[0]
      if (max) setCard(max.el, NORMAL)
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('dblclick', onDouble)
    document.addEventListener('keydown', onKey)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('dblclick', onDouble)
      document.removeEventListener('keydown', onKey)
      teardown()
    }
  }, [on])
}

const clock = () => fmtTime(Date.now())

/** Taskleiste: Start, «Airlock», minimierte und maximierte Fenster, Uhr. Nur bei «Windows 95». */
export function Taskbar() {
  const on = useIsWin95()
  useDesktop()
  useWindowManager(on)
  const [now, setNow] = useState(clock)
  useEffect(() => {
    if (!on) return
    setNow(clock())
    const t = setInterval(() => setNow(clock()), 15_000)
    return () => clearInterval(t)
  }, [on])
  if (!on) return null
  const all = [...entries.values()].sort((a, b) => a.id - b.id)
  const open = all.filter((e) => e.win.state === 'min' || e.win.state === 'max')
  const closed = all.filter((e) => e.win.state === 'closed')
  // Direkt in <body>: Die Taskleiste darf nicht mit dem Hauptfenster verschwinden, wenn es minimiert ist
  return createPortal(
    <>
    <DesktopIcons closed={closed} />
    <div className="w95-taskbar" role="region" aria-label="Taskleiste">
      <StartMenu closed={closed} />
      <button
        type="button"
        className="w95-task"
        aria-pressed={mainWin.state !== 'min'}
        aria-label={mainWin.state === 'min' ? 'Airlock (minimiert) wiederherstellen' : 'Airlock minimieren'}
        onClick={() => setMain(nextWin(mainWin, 'taskbar'))}
      >
        <span className="w95-task-icon" aria-hidden="true" />Airlock
      </button>
      {open.map((e) => (
        <button
          key={e.id}
          type="button"
          className="w95-task"
          aria-pressed={e.win.state === 'max'}
          aria-label={e.win.state === 'min' ? `${e.title} (minimiert) wiederherstellen` : `${e.title} minimieren`}
          title={e.title}
          onClick={() => actCard(e.el, 'taskbar')}
        >
          <span className="w95-task-label">{e.title}</span>
        </button>
      ))}
      <span className="w95-tray num" aria-hidden="true">{now}</span>
      <QuitDialog />
    </div>
    {/* App minimiert: das echte <main> ist weg; der Desktop ist dann der Hauptbereich (Screenreader) */}
    {mainWin.state === 'min' && (
      <main className="w95-desktop">
        <h1 className="sr-only">Airlock ist minimiert</h1>
        <p className="sr-only">Mit dem Knopf «Airlock» in der Taskleiste wiederherstellen.</p>
      </main>
    )}
    </>,
    document.body,
  )
}

/* --- Desktop-Symbole (wie in der Vorlage): Klick wählt, Doppelklick oder Enter öffnet --- */

const ico = { width: 32, height: 32, viewBox: '0 0 32 32', 'aria-hidden': true, shapeRendering: 'crispEdges' as const }
const ICONS = {
  // Bildschirm mit Fuss
  server: () => (
    <svg {...ico}><rect x="3" y="3" width="26" height="19" fill="#c0c0c0" stroke="#000" /><rect x="6" y="6" width="20" height="13" fill="#008080" stroke="#808080" /><rect x="7" y="7" width="8" height="2" fill="#fff" /><rect x="12" y="22" width="8" height="3" fill="#808080" /><rect x="7" y="25" width="18" height="3" fill="#c0c0c0" stroke="#000" /></svg>
  ),
  // Schild
  security: () => (
    <svg {...ico} shapeRendering="auto"><path d="M16 2 28 6v9c0 7.5-5 12.5-12 15C9 27.5 4 22.5 4 15V6Z" fill="#c0c0c0" stroke="#000" /><path d="M16 5 25 8v7c0 5.8-3.7 9.8-9 12Z" fill="#000080" /><path d="m11 16 3.5 3.5L21 12" fill="none" stroke="#fff" strokeWidth="2.4" /></svg>
  ),
  // Liste auf Papier
  audit: () => (
    <svg {...ico}><rect x="6" y="2" width="20" height="28" fill="#fff" stroke="#000" /><rect x="22" y="2" width="4" height="4" fill="#c0c0c0" /><rect x="9" y="8" width="14" height="2" fill="#000080" /><rect x="9" y="13" width="14" height="1" fill="#808080" /><rect x="9" y="17" width="14" height="1" fill="#808080" /><rect x="9" y="21" width="10" height="1" fill="#808080" /><rect x="9" y="25" width="12" height="1" fill="#808080" /></svg>
  ),
  // Drahtkorb; voll mit Blättern, wenn Fenster geschlossen sind
  bin: (full: boolean) => (
    <svg {...ico}>
      {full && <><rect x="9" y="4" width="9" height="8" fill="#fff" stroke="#000" transform="rotate(-12 13 8)" /><rect x="15" y="5" width="9" height="7" fill="#ffffc0" stroke="#000" transform="rotate(10 19 8)" /></>}
      <path d="M6 9h20l-2 20H8Z" fill="#c0c0c0" stroke="#000" /><path d="M11 12v14M16 12v14M21 12v14" stroke="#808080" /><rect x="5" y="8" width="22" height="2" fill="#808080" />
    </svg>
  ),
}

function DesktopIcons({ closed }: { closed: Entry[] }) {
  const ep = useEnvPath()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string | null>(null)
  const root = useRef<HTMLElement>(null)
  // Klick daneben hebt die Auswahl auf
  useEffect(() => {
    if (!selected) return
    const off = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setSelected(null) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [selected])

  const restore = () => closed.forEach((e) => setCard(e.el, NORMAL))
  const items: { id: string; label: string; icon: ReactNode; open: () => void; hint?: string }[] = [
    { id: 'server', label: 'homeserver', icon: ICONS.server(), open: () => navigate('/server') },
    { id: 'security', label: 'Security', icon: ICONS.security(), open: () => navigate(ep('/security')) },
    { id: 'audit', label: 'Audit-Log', icon: ICONS.audit(), open: () => navigate(ep('/audit')) },
    {
      id: 'bin', label: 'Papierkorb', icon: ICONS.bin(closed.length > 0), open: restore,
      hint: closed.length === 0 ? 'leer'
        : closed.length === 1 ? '1 geschlossenes Fenster – öffnen stellt es wieder her'
        : `${closed.length} geschlossene Fenster – öffnen stellt sie wieder her`,
    },
  ]
  return (
    <nav className="w95-desktop-icons" aria-label="Desktop" ref={root}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="w95-icon"
          data-selected={selected === it.id || undefined}
          aria-label={it.hint ? `${it.label} (${it.hint})` : it.label}
          title={it.hint}
          // Maus: Klick wählt, Doppelklick öffnet. Tastatur (Enter, Leertaste): öffnet sofort.
          onClick={(e) => { if (e.detail === 0) it.open(); else setSelected(it.id) }}
          onDoubleClick={() => { setSelected(null); it.open() }}
        >
          {it.icon}
          <span className="w95-icon-label">{it.label}</span>
        </button>
      ))}
    </nav>
  )
}

/** Startmenü: Navigation, geschlossene Fenster wieder öffnen, Beenden. */
function StartMenu({ closed }: { closed: Entry[] }) {
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  const ep = useEnvPath()
  const id = useId()
  const go = [
    ['Projekte', ep('/projekte')], ['Security', ep('/security')], ['Audit', ep('/audit')],
    ['Einstellungen', ep('/einstellungen')], ['Server', '/server'], ['Konto', '/konto'],
  ] as const
  return (
    <div className="menu w95-start-menu" ref={rootRef}>
      <button ref={triggerRef} type="button" className="w95-start" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        <span className="w95-logo" aria-hidden="true" />Start
      </button>
      <div {...listProps} role="menu" id={id} aria-label="Startmenü">
        {go.map(([label, to]) => <Link key={label} role="menuitem" to={to} onClick={close}>{label}</Link>)}
        {closed.length > 0 && (
          <>
            <div className="menu-sep" />
            <button role="menuitem" onClick={() => { close(); closed.forEach((e) => setCard(e.el, NORMAL)) }}>
              {closed.length === 1 ? 'Geschlossenes Fenster wieder öffnen' : `${closed.length} geschlossene Fenster wieder öffnen`}
            </button>
          </>
        )}
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => { close(); requestQuit() }}>Beenden …</button>
      </div>
    </div>
  )
}

type Quit = 'restart' | 'logout'

/**
 * «Airlock beenden»: neu starten (lädt nur die Seite neu) oder abmelden.
 * «Herunterfahren» steht wie im Original in der Liste, ist aber gesperrt:
 * Airlock läuft auf dem Server und lässt sich von hier nicht ausschalten.
 */
function QuitDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const yes = useRef<HTMLButtonElement>(null)
  const [choice, setChoice] = useState<Quit>('restart')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ask = askQuit

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (ask && !d.open) { setChoice('restart'); d.showModal(); requestAnimationFrame(() => yes.current?.focus()) }
    if (!ask && d.open) d.close()
  }, [ask])

  const dismiss = () => { askQuit = false; emit() }
  async function confirm() {
    dismiss()
    if (choice === 'restart') { location.reload(); return }
    if (!(await confirmLeave())) return
    markLoggedOut()
    try { await api.logout() } finally { navigate('/'); await qc.invalidateQueries({ queryKey: ['me'] }) }
  }

  const opts: [Quit, string][] = [['restart', 'Airlock neu starten'], ['logout', 'Abmelden und als anderer Benutzer anmelden']]
  return (
    <dialog ref={ref} className="dialog w95-quit" aria-labelledby="w95-quit-h" onCancel={(e) => { e.preventDefault(); dismiss() }} onClose={() => { if (askQuit) dismiss() }}>
      <div className="dialog-body">
        <h2 id="w95-quit-h">Airlock beenden</h2>
        <fieldset className="w95-quit-options">
          <legend>Wählen Sie eine Option:</legend>
          <label className="choice w95-quit-off">
            <input type="radio" name="w95-quit" value="shutdown" disabled aria-describedby="w95-quit-off-note" />
            <span>Airlock herunterfahren <small id="w95-quit-off-note">nicht möglich – Airlock läuft auf dem Server weiter</small></span>
          </label>
          {opts.map(([v, label]) => (
            <label key={v} className="choice">
              <input type="radio" name="w95-quit" value={v} checked={choice === v} onChange={() => setChoice(v)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button ref={yes} type="button" className="button-primary" onClick={() => void confirm()}>Ja</button>
          <button type="button" onClick={dismiss}>Nein</button>
        </div>
      </div>
    </dialog>
  )
}
