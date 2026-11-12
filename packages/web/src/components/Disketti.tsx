import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useEnvPath } from '../lib/env.js'
import { diskettiTip, type DiskettiTip } from '../lib/disketti.js'
import { requestFix, revealFix } from '../lib/fix-request.js'
import { useFunPrefs, useResolvedTheme } from '../lib/fun.js'
import { confirmLeave } from '../lib/unsaved.js'

/**
 * Etappe 7: Helferfigur «Disketti» – eine kleine Diskette mit Augen (eigenes
 * SVG, keine Büroklammer). Nur im Windows-95-Theme, nur auf der Seite eines
 * Projekts, nur mit einem echten offenen Fehler oder Befund dieses Projekts
 * (lib/disketti.ts). Unten rechts über der Taskleiste, mit Sprechblase:
 *
 * - «Ja» öffnet den bestehenden Fix-Ablauf (Fehlerbox bzw. Befund im Reiter Security)
 * - «Nein» schliesst – für diesen Hinweis in dieser Sitzung
 * - «Nie wieder» schaltet Disketti dauerhaft aus (Präferenz auf dem Server;
 *   wieder einzuschalten im Profilmenü › Darstellung)
 *
 * Nicht aufdringlich: die Blase öffnet sich je Hinweis nur einmal pro Sitzung
 * von selbst (nicht bei jedem Seitenwechsel), nimmt nie den Fokus, und die
 * Seite bekommt unten Platz (styles.css), damit die Figur nie dauerhaft einen
 * Knopf verdeckt. Danach bleibt die Figur still stehen; ein Klick öffnet die
 * Blase wieder.
 */
const SEEN_KEY = 'airlock.disketti.gezeigt'
const DISMISSED_KEY = 'airlock.disketti.nein'
/** Erst nach einem Moment auf der Seite – nicht schon beim Durchklicken */
const DELAY_MS = 900

const readList = (k: string): string[] => {
  try { return JSON.parse(sessionStorage.getItem(k) ?? '[]') as string[] } catch { return [] }
}
const addToList = (k: string, v: string) => {
  try { sessionStorage.setItem(k, JSON.stringify([...new Set([...readList(k), v])])) } catch { /* privat: nur im Speicher */ }
}

export function Disketti() {
  const theme = useResolvedTheme()
  const prefs = useFunPrefs()
  const match = useMatch('/u/:env/projekte/:id')
  const id = match?.params.id && match.params.id !== 'neu' ? match.params.id : null
  const on = theme === 'win95' && prefs.fun && prefs.disketti && id !== null
  // Dieselbe Abfrage wie die Projektseite (Projekt mit letztem Deploy und Zähler der Befunde)
  const detail = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id!), enabled: on })
  const project = on ? detail.data?.project ?? null : null
  // Befunde nur, wenn das Projekt offene hat (dieselbe Abfrage wie die Security-Karte)
  const hasOpen = Boolean(project?.security && Object.values(project.security.open).some((n) => n > 0))
  const scan = useQuery({
    queryKey: ['scan-done', id],
    queryFn: () => api.latestScan(id!, true),
    enabled: on && hasOpen,
  })
  const tip = on ? diskettiTip({ project, findings: hasOpen ? scan.data?.report?.findings ?? null : [] }) : null
  // Nach «Nein» oder «Ja» ist dieser Hinweis für die Sitzung erledigt
  const [dismissed, setDismissed] = useState<string[]>(() => readList(DISMISSED_KEY))
  const visibleTip = tip && !dismissed.includes(tip.key) ? tip : null
  return visibleTip ? <DiskettiFigure key={visibleTip.key} tip={visibleTip} onDone={() => { addToList(DISMISSED_KEY, visibleTip.key); setDismissed(readList(DISMISSED_KEY)) }} onNever={() => void prefs.set({ disketti: false })} /> : null
}

function DiskettiFigure({ tip, onDone, onNever }: { tip: DiskettiTip; onDone: () => void; onNever: () => void }) {
  const [ready, setReady] = useState(false)
  // Die Blase öffnet sich je Hinweis einmal von selbst
  const [open, setOpen] = useState(false)
  const bubbleId = useId()
  const titleId = useId()
  const navigate = useNavigate()
  const ep = useEnvPath()
  const match = useMatch('/u/:env/projekte/:id')
  const projectId = match?.params.id ?? ''

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true)
      if (!readList(SEEN_KEY).includes(tip.key)) { addToList(SEEN_KEY, tip.key); setOpen(true) }
    }, DELAY_MS)
    return () => clearTimeout(t)
  }, [tip.key])

  async function yes() {
    onDone()
    if (tip.kind === 'finding' && tip.findingId) {
      if (!(await confirmLeave())) return
      requestFix(`finding:${tip.findingId}`)
      navigate(ep(`/projekte/${projectId}?tab=security`))
      revealFix(`#befund-${CSS.escape(tip.findingId)}`, '.finding-actions button')
    } else if (tip.kind === 'deploy' && tip.deploymentId) {
      if (!(await confirmLeave())) return
      requestFix(`deploy:${tip.deploymentId}`)
      navigate(ep(`/projekte/${projectId}`))
      revealFix('.failure', '.failure-actions button')
    }
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }
  if (!ready) return null
  return (
    <div className="disketti" onKeyDown={onKey}>
      {open && (
        <section className="disketti-bubble" id={bubbleId} aria-labelledby={titleId}>
          <p className="disketti-title" id={titleId}>Disketti</p>
          <p>{tip.text} {tip.question}</p>
          <div className="disketti-actions">
            <button type="button" onClick={() => void yes()}>Ja</button>
            <button type="button" onClick={onDone}>Nein</button>
            <button type="button" onClick={onNever}>Nie wieder</button>
          </div>
        </section>
      )}
      <button
        type="button"
        className="disketti-figure"
        aria-expanded={open}
        aria-controls={open ? bubbleId : undefined}
        aria-label={open ? 'Disketti: Hinweis schliessen' : 'Disketti: Hinweis zeigen'}
        onClick={() => setOpen((v) => !v)}
      >
        <DiskettiSvg />
      </button>
    </div>
  )
}

/**
 * Die Figur: eine 3,5-Zoll-Diskette (blau, Metallschieber oben, Etikett
 * unten) mit zwei Augen und einem Lächeln auf dem Etikett. Pixel-Optik wie
 * das Theme. Reine Deko – beschriftet ist der Knopf darum.
 */
export function DiskettiSvg() {
  return (
    <svg width="56" height="64" viewBox="0 0 28 32" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      {/* Gehäuse mit abgeschrägter Ecke */}
      <path d="M1.5 1.5h22l3 3v26h-25z" fill="#1d4fa0" stroke="#000" />
      {/* Metallschieber mit Fenster */}
      <rect x="7.5" y="1.5" width="13" height="9" fill="#c0c0c0" stroke="#000" />
      <rect x="15" y="3" width="3" height="6" fill="#1d4fa0" />
      {/* Etikett */}
      <rect x="4.5" y="13.5" width="19" height="15" fill="#ffffff" stroke="#000" />
      {/* Augen mit Glanzpunkt */}
      <ellipse cx="10.5" cy="19.5" rx="2" ry="2.8" fill="#000" shapeRendering="geometricPrecision" />
      <ellipse cx="17.5" cy="19.5" rx="2" ry="2.8" fill="#000" shapeRendering="geometricPrecision" />
      <rect x="10" y="18" width="1" height="1" fill="#fff" />
      <rect x="17" y="18" width="1" height="1" fill="#fff" />
      {/* Lächeln */}
      <path d="M11 24.5q3 2.2 6 0" fill="none" stroke="#000" strokeWidth="1" strokeLinecap="round" shapeRendering="geometricPrecision" />
      {/* Schreibschutz-Loch */}
      <rect x="2.5" y="27" width="1.5" height="2" fill="#000" />
    </svg>
  )
}
