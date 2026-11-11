/**
 * Szenen der visuellen und der Barrierefreiheits-Tests (Namen aus
 * design-shots/shoot.ts). Neue Ansicht: Szene in shoot.ts anlegen, Namen
 * hier eintragen, `pnpm test:visual:update` und die neuen Bilder bewusst
 * ansehen.
 */
export const VISUAL_SCENES = [
  // Shell und Anmeldung
  'login', 'shell-profilmenue',
  // Projekte
  'projekte', 'projekt-uebersicht', 'projekt-fehler', 'fehler-build-claude', 'fehler-port', 'fehler-speicher', 'projekt-deployments', 'projekt-logs', 'logs-suche', 'logs-fehler', 'logs-leer', '5-zugriffe',
  'projekt-security', 'projekt-security-laeuft', 'projekt-einstellungen', 'veroeffentlichung-live', 'veroeffentlichung-pausiert',
  'neues-projekt-validierung', 'projekte-anzahl-0', 'projekte-anzahl-1',
  // Verwaltung und Security
  'security-global', 'externe-ziele', 'domains', 'tokens', 'audit', 'konto',
  // System
  'system-uebersicht', 'system-cloudflare', 'system-benachrichtigungen', 'system-github', 'pauseseite-vorlage',
  // Zustände (Etappe 1) und Rückmeldung (Etappe 2)
  'nicht-gefunden', 'fehlerseite', 'api-offline', 'laden-projekte', 'leer-projekte',
  'zustand-laden-projektseite', 'zustand-laden-audit', 'zustand-fehler-projekte', 'zustand-fehler-karte',
  'zustand-leer-audit', 'zustand-teilweise-scan', 'zustand-veraltet',
  'bestaetigung-stoppen', 'aktion-vorgaenge', 'aktion-knopf-laedt',
  // Komponenten-Übersicht (Etappe 4), Befehlspalette und Kürzel (Etappe 6)
  'design-bausteine', 'palette', 'palette-offline', 'kuerzel',
  // Erster Start (Etappe 7)
  'einrichtung', 'einrichtung-uebersprungen', 'einrichtung-system',
] as const

/**
 * Barrierefreiheit (axe-core): die Hauptseiten und die Zustände mit eigenem
 * Markup. Ladezustände ohne Inhalt sind ausgenommen (nur Skeletons).
 */
export const A11Y_SCENES = VISUAL_SCENES.filter((n) => !['laden-projekte', 'zustand-laden-projektseite', 'zustand-laden-audit', 'aktion-knopf-laedt'].includes(n))
