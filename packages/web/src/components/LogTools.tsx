import { useEffect, useRef, useState } from 'react'

/**
 * UI-Qualität 4: gemeinsame Werkzeuge des Reiters «Logs» und der
 * Einzelaufrufe im Reiter «Besucher» (bis «Besucher zusammen» Reiter
 * «Zugriffe»): Suche mit Hervorhebung, Herunterladen, Live-Strom mit
 * Wiederverbinden. Die Werkzeugleiste der Logs steht in LogsTab.tsx.
 */

/** Suchmuster einmal bauen (nicht je Zeile); Eingabe wird als Text behandelt, nicht als RegExp */
export const searchPattern = (query: string): RegExp | null => {
  const q = query.trim()
  return q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig') : null
}

/** Fundstellen hervorheben (Gross-/Kleinschreibung egal) */
export function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>
  const parts = text.split(re)
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="log-hit">{p}</mark> : p))}</>
}

/** Text als Datei speichern (im Browser, ohne Server) */
export function downloadText(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Live-Strom mit Wiederverbinden: bricht er ab (Netz, Neustart, neuer
 * Container), wird mit wachsender Pause neu verbunden – `open` bekommt dann
 * den aktuellen Anschlusspunkt. Gibt zurück, ob der Strom gerade offen ist
 * (null = noch nicht bekannt).
 */
export function useLiveFeed(open: (onState: (ok: boolean) => void) => () => void, deps: unknown[], enabled: boolean): boolean | null {
  const [state, setState] = useState<boolean | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    setState(null)
    if (!enabled) return
    let stop: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let tries = 0
    let dead = false
    const start = () => {
      stop = openRef.current((ok) => {
        if (dead) return
        setState(ok)
        if (ok) { tries = 0; return }
        stop?.()
        tries++
        timer = setTimeout(start, Math.min(30_000, 2_000 * 2 ** Math.min(tries, 4)))
      })
    }
    start()
    return () => { dead = true; if (timer) clearTimeout(timer); stop?.() }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}
