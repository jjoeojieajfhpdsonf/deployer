// Nur im Prototyp geladen (main.tsx): Schriften lokal über @fontsource,
// nicht von Google Fonts. Cal Sans (OFL) für Überschriften, Inter für Text;
// Geist Mono bleibt für Adressen, Versionen und Logs.
import '@fontsource/cal-sans/400.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './prototype-cal.css'
import { applyTheme, initialTheme } from './flag.js'

document.documentElement.dataset.proto = 'cal'
applyTheme(initialTheme())
