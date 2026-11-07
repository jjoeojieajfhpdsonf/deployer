import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Nur in der Entwicklung (break-ui): Umschalter zwischen echten Daten und
 * Testdaten für Extremfälle. Steht im URL-Parameter ?demo=, ein Neuladen
 * behält die Wahl. Bewusst schlicht – gehört nicht zum Design.
 */
const STATES: [string | null, string][] = [
  [null, 'Echte Daten'],
  ['lang', 'Worst case'],
  ['leer', 'Leer'],
  ['eins', 'Eins'],
  ['viele', '50'],
  ['hunderte', '200'],
]

export function DemoToggle() {
  const location = useLocation()
  const navigate = useNavigate()
  if (!import.meta.env.DEV) return null
  const current = new URLSearchParams(location.search).get('demo')
  const go = (v: string | null) => {
    const p = new URLSearchParams(location.search)
    if (v) p.set('demo', v)
    else p.delete('demo')
    const q = p.toString()
    // Volle Navigation: die Projektliste liest den Parameter beim Laden der Daten
    navigate({ pathname: location.pathname, search: q ? `?${q}` : '' }, { replace: true })
  }
  return (
    <div
      role="group"
      aria-label="Testdaten (nur Entwicklung)"
      style={{
        position: 'fixed', left: '50%', bottom: 12, transform: 'translateX(-50%)', zIndex: 1000,
        display: 'flex', gap: 2, padding: 3, borderRadius: 999, background: '#d4d4d8',
        font: '12px/1 -apple-system, system-ui, sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}
    >
      {STATES.map(([v, label]) => (
        <button
          key={label}
          type="button"
          onClick={() => go(v)}
          aria-pressed={current === v}
          style={{
            all: 'unset', cursor: 'pointer', padding: '6px 10px', borderRadius: 999,
            background: current === v ? '#ffffff' : 'transparent', color: '#18181b',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
