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
  'projekte', 'projekt-uebersicht',
  // Reiter «Aufbau»: Compose, Einzelcontainer, statisch, nicht öffentlich, Host gewählt, schmal (< 1100 px), sehr schmal (< 700 px),
  // grosser Bildschirm (Seite bis 1440 px), vergrössert (Dialog übers ganze Fenster)
  'aufbau', 'aufbau-einzelcontainer', 'aufbau-statisch', 'aufbau-nicht-oeffentlich', 'aufbau-host', 'aufbau-schmal', 'aufbau-sehr-schmal', 'aufbau-breit', 'aufbau-vergroessert',
  // Etappe 4: Live-Verkehr (fester Zustand, nur Zähler), auch vergrössert; «+ Dienst» (Vorlage, Diff), neuer Dienst
  // «wird erstellt», Pull Request offen, gescheitert, ohne GitHub-App, Adminer mit interner Adresse, Entfernen
  'aufbau-live', 'aufbau-live-vergroessert', 'aufbau-dienst-dialog', 'aufbau-dienst-diff', 'aufbau-dienst-wird-erstellt',
  'aufbau-dienst-pr-offen', 'aufbau-dienst-gescheitert', 'aufbau-ohne-github', 'aufbau-adminer', 'aufbau-dienst-entfernen',
  'projekt-fehler', 'fehler-build-claude', 'fehler-port', 'fehler-speicher', 'projekt-deployments', 'projekt-logs', 'logs-suche', 'logs-fehler', 'logs-leer', '5-zugriffe',
  // Etappe 3: Besucher (Reiter, Städte, Zugang, intern, Zustände, Wert per Tastatur, Übersicht, Projektliste)
  'besucher', 'besucher-staedte', 'besucher-tailnet', 'besucher-intern', 'besucher-leer', 'besucher-wartet', 'besucher-aus', 'besucher-wert',
  'projekt-uebersicht-besucher', 'projekte-besucher',
  // Besucher neu: Messbeginn im Zeitraum, Säulen, Heute, 12 Monate, Kennzahl als Kurve, Europa, Einstieg, Server › Besucher
  'besucher-messbeginn', 'besucher-saeulen', 'besucher-heute', 'besucher-12-monate', 'besucher-kennzahl', 'besucher-europa', 'besucher-einstieg',
  'server-besucher', 'server-besucher-geladen',
  'projekt-security', 'projekt-security-laeuft', 'projekt-einstellungen', 'veroeffentlichung-live', 'veroeffentlichung-pausiert',
  // Öffentliche Adressen: Name · Domain, Vorschau, Prüfung (frei, fremder DNS-Eintrag, apex mit Worker, Neues Projekt)
  'adresse-frei', 'adresse-dns-fremd', 'adresse-apex', 'adresse-neues-projekt',
  // Antwort 8: Abschnitt Container, Sprung aus der Fehlerbox mit Vorschlag; Antwort 7: CSP-Qualität (ZAP 10055)
  'einstellungen-container', 'fehler-grenze-vorschlag', 'security-csp-qualitaet',
  'neues-projekt-validierung', 'neues-projekt-vorschau', 'neues-projekt-chat','projekte-anzahl-0', 'projekte-anzahl-1',
  // Verwaltung und Security
  'security-global', 'externe-ziele', 'domains', 'tokens', 'audit', 'konto', 'glocke', 'sitzung-abgelaufen', 'sitzung-abgelaufen-aktion', 'sitzung-erneut-ausfuehren', 'verlassen-rueckfrage', 'verlassen-zurueck', 'tokens-neu', 'tokens-neu-claude-code',
  // System
  'system-uebersicht', 'system-cloudflare', 'system-cloudflare-fertig', 'system-benachrichtigungen', 'system-github', 'pauseseite-vorlage',
  // Meilenstein Backup: Server › Backup
  'system-backup', 'system-backup-leer', 'system-backup-veraltet', 'backup-schluessel-datei', 'backup-schluessel-papier', 'backup-wiederherstellen',
  // Zustände (Etappe 1) und Rückmeldung (Etappe 2)
  'nicht-gefunden', 'fehlerseite', 'api-offline', 'laden-projekte', 'leer-projekte',
  'zustand-laden-projektseite', 'zustand-laden-audit', 'zustand-fehler-projekte', 'zustand-fehler-karte',
  'zustand-leer-audit', 'zustand-teilweise-scan', 'zustand-veraltet',
  'bestaetigung-stoppen', 'aktion-vorgaenge', 'aktion-knopf-laedt',
  // Rückfragen (Antwort 3/10): Löschen im modalen Dialog
  'loeschen-dialog',
  // Komponenten-Übersicht (Etappe 4), Befehlspalette und Kürzel (Etappe 6)
  'design-bausteine', 'palette', 'palette-offline', 'kuerzel',
  // Erster Start (Etappe 7)
  'einrichtung', 'einrichtung-uebersprungen', 'einrichtung-system',
  // M9: Umgebungen (Umschalter, Einstellungen, anlegen, verschieben, Server)
  'm9-projekte', 'm9-umschalter', 'm9-umschalter-domain', 'm9-umschalter-lang', 'm9-umschalter-schmal', 'm9-einstellungen', 'm9-einstellungen-cloudflare', 'm9-einstellungen-standards',
  'm9-umgebungen', 'm9-umgebung-anlegen', 'm9-einrichtung', 'm9-verschieben', 'm9-audit', 'm9-server', 'm9-tokens',
  // Etappe 5: Statusseite – Einstellungen (an, Störung melden, aus), Projekteinstellungen; die öffentliche Seite selbst
  'statusseite-einstellungen', 'statusseite-melden', 'statusseite-aus', 'statusseite-projekt',
  'statusseite-oeffentlich', 'statusseite-oeffentlich-tooltip', 'statusseite-oeffentlich-ruhig',
  // Etappe 6: Vorschau-Deploys – Liste, Löschen bestätigen, an und leer, aus; Einstellungen, Variablen, ohne Git-Repo
  'vorschauen', 'vorschauen-loeschen', 'vorschauen-leer', 'vorschauen-aus', 'vorschauen-einstellungen', 'vorschauen-variablen', 'vorschauen-nicht-moeglich',
  // Etappe 7: Spass-Paket – «sudo» in ⌘K, Matrix-Regen (festes Bild, Schalter an), Achievements im Konto und als
  // Meldung, Snake-Seite für unbekannte interne Namen (eigenes HTML, hell/dunkel nach dem Gerät)
  'terminal-freigeschaltet', 'matrix-regen', 'konto-achievements', 'achievement-neu', 'snake-404',
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
  // Etappe 3: Besucher (Besucher neu: dazu Säulen nach Zugang)
  'besucher', 'projekt-uebersicht-besucher', 'besucher-saeulen',
  // Etappe 5: Einstellungen › Statusseite (die öffentliche Seite selbst hat kein Theme)
  'statusseite-einstellungen',
  // Etappe 6: Vorschauen (Liste, Einstellungen)
  'vorschauen', 'vorschauen-einstellungen',
  // Nur in Windows 95: Fenster minimiert (Taskleiste), maximiert, Hauptfenster maximiert, Startmenü, «Airlock beenden»
  'win95-minimiert', 'win95-maximiert', 'win95-hauptfenster-maximiert', 'win95-startmenue', 'win95-beenden',
  // Ganze App über den Taskleisten-Knopf minimiert und wieder geholt (die Taskleiste muss stehen bleiben)
  'win95-app-minimiert', 'win95-app-zurueck',
  // Desktop-Symbole: Papierkorb voll (eine Karte geschlossen) und ausgewählt
  'win95-papierkorb',
  // Etappe 7: Disketti (nur in Windows 95) – offener Befund, gescheiterter Deploy, «Ja» öffnet den Ablauf
  'disketti', 'disketti-fehler', 'disketti-ja',
]

/**
 * Etappe 7: verstecktes Theme «Terminal» – die Hauptseiten (Bilder *-terminal.png),
 * visuell und mit axe. Cursor und Matrix-Regen ruhen (reduzierte Bewegung); die
 * Matrix-Szene zeichnet ein festes Bild.
 */
export const TERMINAL_SCENES: readonly string[] = [
  'login', 'shell-profilmenue', 'projekte', 'projekt-uebersicht', 'projekt-deployments', 'projekt-security', 'projekt-einstellungen',
  'audit', 'konto', 'bestaetigung-stoppen', 'design-bausteine', 'palette', 'terminal-freigeschaltet', 'matrix-regen',
  // Besucher neu: Reiter und Säulen in Grünstufen
  'besucher-messbeginn', 'besucher-saeulen',
]

export const A11Y_SCENES = VISUAL_SCENES.filter((n) => !['laden-projekte', 'zustand-laden-projektseite', 'zustand-laden-audit', 'aktion-knopf-laedt'].includes(n))
