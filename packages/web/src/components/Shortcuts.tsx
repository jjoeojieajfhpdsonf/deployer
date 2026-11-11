import { useEffect, useRef, useState } from 'react'
import { useGuardedNavigate } from '../lib/unsaved.js'
import { useEnv } from '../lib/env.js'
import { CommandPalette } from './CommandPalette.js'

/**
 * Tastatur für die ganze App:
 *   ⌘K / Ctrl+K   Befehlspalette
 *   /             Suche der Seite (gibt es keine: Befehlspalette)
 *   g p · g s · g a   Projekte, Security, Audit-Log
 *   ?             alle Kürzel
 * Einzeltasten nur ausserhalb von Eingabefeldern und ohne ⌘/Ctrl/Alt –
 * Tippen in Feldern und die Kürzel des Browsers bleiben unberührt.
 */
export const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['⌘', 'K'], what: 'Befehlspalette öffnen (Mac; Windows/Linux: Ctrl+K)' },
  { keys: ['/'], what: 'Suche der Seite, sonst Befehlspalette' },
  { keys: ['g', 'p'], what: 'Zu den Projekten' },
  { keys: ['g', 's'], what: 'Zu Security' },
  { keys: ['g', 'a'], what: 'Zum Audit-Log' },
  { keys: ['?'], what: 'Diese Übersicht' },
  { keys: ['Esc'], what: 'Dialog, Menü oder Palette schliessen' },
]

const GO: Record<string, string> = { p: '/projekte', s: '/security', a: '/audit' }

/** Tippt man gerade Text? (Ankreuzfelder, Optionen, Schieber zählen nicht) */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week'])
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el as HTMLInputElement).type)
}

/** Mac: ⌘K (Ctrl+K löscht dort im Feld bis zum Zeilenende); sonst Ctrl+K */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function Shortcuts() {
  // Mit Rückfrage bei ungespeicherten Änderungen (UI-Qualität 8)
  const navigate = useGuardedNavigate()
  const { slug } = useEnv()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const pendingG = useRef<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Palette: ⌘K (Mac) bzw. Ctrl+K, auch aus Feldern heraus
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // Gedrückt halten schaltet nicht ständig auf und zu
        if (!e.repeat) setPalette((o) => !o)
        return
      }
      if (e.repeat) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return
      // Offener Dialog (Palette, Hilfe, Pause-Editor …): keine Einzeltasten
      if (document.querySelector('dialog[open]')) return

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        const to = GO[e.key.toLowerCase()]
        // M9: in der gewählten Umgebung
        if (to) { e.preventDefault(); void navigate(`/u/${slug}${to}`) }
        return
      }
      if (e.key === 'g') {
        pendingG.current = window.setTimeout(() => { pendingG.current = null }, 1200)
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        // Nur eine sichtbare Suche der Seite; Text markieren, damit man gleich neu tippen kann
        const search = [...document.querySelectorAll<HTMLInputElement>('[data-page-search]')].find((el) => el.offsetParent !== null)
        if (search) { search.focus(); search.select() }
        else setPalette(true)
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        setHelp(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, slug])

  return (
    <>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
    </>
  )
}

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="shortcuts-h" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog-body">
        <h2 id="shortcuts-h">Tastaturkürzel</h2>
        <dl className="shortcut-list">
          {SHORTCUTS.map((s) => (
            <div key={s.what}>
              <dt>{s.keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions"><button type="button" onClick={onClose} autoFocus>Schliessen</button></div>
      </div>
    </dialog>
  )
}
