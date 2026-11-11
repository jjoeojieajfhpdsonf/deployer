import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  { keys: ['⌘', 'K'], what: 'Befehlspalette öffnen (Windows/Linux: Ctrl+K)' },
  { keys: ['/'], what: 'Suche der Seite, sonst Befehlspalette' },
  { keys: ['g', 'p'], what: 'Zu den Projekten' },
  { keys: ['g', 's'], what: 'Zu Security' },
  { keys: ['g', 'a'], what: 'Zum Audit-Log' },
  { keys: ['?'], what: 'Diese Übersicht' },
  { keys: ['Esc'], what: 'Dialog, Menü oder Palette schliessen' },
]

const GO: Record<string, string> = { p: '/projekte', s: '/security', a: '/audit' }

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

export function Shortcuts() {
  const navigate = useNavigate()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const pendingG = useRef<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Palette: ⌘K (Mac) bzw. Ctrl+K, auch aus Feldern heraus
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((o) => !o)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return
      // Offener Dialog (Palette, Hilfe, Pause-Editor …): keine Einzeltasten
      if (document.querySelector('dialog[open]')) return

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        const to = GO[e.key.toLowerCase()]
        if (to) { e.preventDefault(); navigate(to) }
        return
      }
      if (e.key === 'g') {
        pendingG.current = window.setTimeout(() => { pendingG.current = null }, 1200)
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        const search = document.querySelector<HTMLInputElement>('[data-page-search]')
        if (search) search.focus()
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
  }, [navigate])

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
