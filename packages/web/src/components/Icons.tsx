/** Wenige Linien-Icons, 16 px, Strichstärke 1.6 – mehr braucht die Oberfläche nicht. */
type P = { size?: number; className?: string }
const base = (size = 16) => ({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true })

export const IconSearch = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
)
export const IconDownload = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg>
)
/** Vergrössern: zwei Pfeile in die Ecken (Aufbau im ganzen Fenster) */
export const IconExpand = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>
)
export const IconPlus = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 3v10M3 8h10" /></svg>
)
export const IconMinus = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M3 8h10" /></svg>
)
/** Ganzer Ausschnitt: vier Ecken eines Rahmens (Karte zurücksetzen) */
export const IconFit = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
)
export const IconAlert = ({ size = 20, className }: P) => (
  <svg {...base(size)} viewBox="0 0 16 16" className={className}><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v3.6M8 10.9v.1" /></svg>
)
/** Warnung (abgerundetes Dreieck) – zu einer Warnung gehört immer auch das Wort */
export const IconWarn = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}><path d="M7.1 2.6 1.6 12.2a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z" /><path d="M8 6.2v3.1M8 11.4v.1" /></svg>
)
/** Haken ohne Kreis (aktive Fassung, «kopiert») */
export const IconCheck = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="m3.5 8.5 3 3 6-7" /></svg>
)
/** Pfeil nach oben – Spiegelbild von IconDownload (neue Fassung, Update verfügbar) */
export const IconUp = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" /></svg>
)
/* Ergebnis einer Prüfung: im Kreis, gemeinsam für Übersicht und Cloudflare-Assistent */
export const IconOk = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6.2" /><path d="m5.4 8.2 1.8 1.8 3.4-3.6" /></svg>
)
export const IconBad = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6.2" /><path d="m6 6 4 4M10 6l-4 4" /></svg>
)
export const IconPending = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6.2" strokeDasharray="2.4 2.4" /></svg>
)
/** Übersprungen / nicht nötig: Kreis mit Strich */
export const IconSkipped = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8h5.6" /></svg>
)
export const IconMore =({ size, className }: P) => (
  // Gefüllte Punkte statt Linien der Länge 0,01: die wurden kaum 2 px gross und wirkten leer
  <svg {...base(size)} className={className}><g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.5" cy="8" r="1.35" /></g></svg>
)
/* Quellen eines neuen Projekts */
export const IconGit = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.4" /></svg>
)
export const IconBox = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8Z" /><path d="M2.5 4.8 8 7.8l5.5-3M8 7.8v6.4" /></svg>
)
export const IconUpload = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 10.5V2.5M4.8 5.5 8 2.3l3.2 3.2M2.5 10v3.5h11V10" /></svg>
)
export const IconChat = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5Z" /><path d="M5.5 7.2h5" /></svg>
)
export const IconChevron =({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
)
export const IconExternal = ({ size = 12, className }: P) => (
  <svg {...base(size)} className={className}><path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7.5 8.5" /></svg>
)

/* Navigation (Seitenleiste, eingeklappt nur Icons) */
export const IconProjects = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
)
export const IconShield = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6Z" /><path d="m5.8 8 1.5 1.5 3-3" /></svg>
)
export const IconGlobe = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>
)
/** Pausiert: zwei Balken – immer mit dem Wort «Pausiert» */
export const IconPause = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6" /><path d="M6.5 5.8v4.4M9.5 5.8v4.4" /></svg>
)
/** Privat: Schloss – immer mit dem Wort «Privat» */
export const IconLock = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>
)
export const IconTarget =({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /></svg>
)
export const IconKey = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><circle cx="5.5" cy="10.5" r="3" /><path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.6 1.6" /></svg>
)
export const IconList = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></svg>
)
export const IconServer = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.75h.01M5 11.25h.01" /></svg>
)
/** M9: Einstellungen der Umgebung */
export const IconSliders = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></svg>
)
