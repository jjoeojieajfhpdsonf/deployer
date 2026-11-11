/**
 * Szenen der visuellen und der Barrierefreiheits-Tests (Namen aus
 * design-shots/shoot.ts). Neue Ansicht: Szene in shoot.ts anlegen, Namen
 * hier eintragen, `pnpm test:visual:update` und die neuen Bilder bewusst
 * ansehen.
 */
export const VISUAL_SCENES = [
  // Shell und Anmeldung
  'login', 'shell-profilmenue', 'win95-freigeschaltet',
  // Projekte
  'projekte', 'projekt-uebersicht', 'projekt-fehler', 'fehler-build-claude', 'fehler-port', 'fehler-speicher', 'projekt-deployments', 'projekt-logs', 'logs-suche', 'logs-fehler', 'logs-leer', '5-zugriffe',
  'projekt-security', 'projekt-security-laeuft', 'projekt-einstellungen', 'veroeffentlichung-live', 'veroeffentlichung-pausiert',
  'neues-projekt-validierung', 'neues-projekt-vorschau', 'neues-projekt-chat','projekte-anzahl-0', 'projekte-anzahl-1',
  // Verwaltung und Security
  'security-global', 'externe-ziele', 'domains', 'tokens', 'audit', 'konto', 'glocke', 'sitzung-abgelaufen', 'sitzung-abgelaufen-aktion', 'verlassen-rueckfrage', 'tokens-neu',
  // System
  'system-uebersicht', 'system-cloudflare', 'system-cloudflare-fertig', 'system-benachrichtigungen', 'system-github', 'pauseseite-vorlage',
  // Zustände (Etappe 1) und Rückmeldung (Etappe 2)
  'nicht-gefunden', 'fehlerseite', 'api-offline', 'laden-projekte', 'leer-projekte',
  'zustand-laden-projektseite', 'zustand-laden-audit', 'zustand-fehler-projekte', 'zustand-fehler-karte',
  'zustand-leer-audit', 'zustand-teilweise-scan', 'zustand-veraltet',
  'bestaetigung-stoppen', 'aktion-vorgaenge', 'aktion-knopf-laedt',
  // Komponenten-Übersicht (Etappe 4), Befehlspalette und Kürzel (Etappe 6)
  'design-bausteine', 'palette', 'palette-offline', 'kuerzel',
  // Erster Start (Etappe 7)
  'einrichtung', 'einrichtung-uebersprungen', 'einrichtung-system',
  // M9: Umgebungen (Umschalter, Einstellungen, anlegen, verschieben, Server)
  'm9-projekte', 'm9-umschalter', 'm9-einstellungen', 'm9-einstellungen-cloudflare', 'm9-einstellungen-standards',
  'm9-umgebungen', 'm9-umgebung-anlegen', 'm9-einrichtung', 'm9-verschieben', 'm9-audit', 'm9-server', 'm9-tokens',
] as const

/**
 * Barrierefreiheit (axe-core): die Hauptseiten und die Zustände mit eigenem
 * Markup. Ladezustände ohne Inhalt sind ausgenommen (nur Skeletons).
 */
/**
 * Verstecktes Theme «Windows 95»: dieselben Szenen zusätzlich in diesem Theme
 * (Bilder *-win95.png), visuell und mit axe. Die wichtigsten Seiten genügen –
 * das Theme ändert nur Tokens und den Zusatz-Block in styles.css.
 */
export const WIN95_SCENES: readonly string[] = [
  'login', 'shell-profilmenue', 'projekte', 'projekt-uebersicht', 'projekt-einstellungen', 'audit', 'bestaetigung-stoppen', 'design-bausteine',
  // Nur in Windows 95: Fenster minimiert (Taskleiste), maximiert, Hauptfenster maximiert, Startmenü, «Airlock beenden»
  'win95-minimiert', 'win95-maximiert', 'win95-hauptfenster-maximiert', 'win95-startmenue', 'win95-beenden',
]

export const A11Y_SCENES = VISUAL_SCENES.filter((n) => !['laden-projekte', 'zustand-laden-projektseite', 'zustand-laden-audit', 'aktion-knopf-laedt'].includes(n))
