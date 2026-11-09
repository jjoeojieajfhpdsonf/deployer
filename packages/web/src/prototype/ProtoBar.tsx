import { useState } from 'react'
import { applyTheme, initialTheme, type ProtoTheme } from './flag.js'

const svg = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconSun = () => <svg {...svg}><circle cx="8" cy="8" r="2.8" /><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1" /></svg>
const IconMoon = () => <svg {...svg}><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" /></svg>

/**
 * Nur im Prototyp: Hell/Dunkel und der Weg zurück zum bestehenden Design.
 * Kein Teil des späteren Designs; der Theme-Wechsel ist bewusst nicht
 * animiert (Emil: ein Farbwechsel aller Flächen hätte keinen Zweck).
 */
export function ProtoBar() {
  const [theme, setTheme] = useState<ProtoTheme>(initialTheme)
  const pick = (t: ProtoTheme) => {
    setTheme(t)
    applyTheme(t)
  }
  return (
    <div className="proto-bar">
      <div className="proto-theme" role="group" aria-label="Darstellung">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => pick('light')}>
          <IconSun /> <span>Hell</span>
        </button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => pick('dark')}>
          <IconMoon /> <span>Dunkel</span>
        </button>
      </div>
      {/* Bewusst <a>: verlässt den Router-Basename /prototype */}
      <a className="proto-exit" href="/projekte">Original</a>
    </div>
  )
}
