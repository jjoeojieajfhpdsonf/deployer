---
target: packages/web/src (alle Ansichten)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/joel/Desktop/private/deployer/packages/web/src"
timestamp: 2026-11-07T13-07-59Z
slug: packages-web-src
closed: true
---
Method: dual-agent (A: Design-Review · B: Detector + Browser-Overlay)

## Design Health Score

| # | Heuristik | Score | Kernproblem |
|---|---|---|---|
| 1 | Sichtbarkeit des Systemstatus | 3 | Aktionen (Stoppen, Deploy) ohne sofortige Rückmeldung, erst nach Polling |
| 2 | Sprache der Nutzer | 3 | Audit zeigt Rohschlüssel (`reconcile.container_missing`, `{}`), die Übersicht dieselben Ereignisse lesbar |
| 3 | Kontrolle und Freiheit | 2 | «Stoppen» ein Klick ohne Rückfrage, auch bei öffentlichen Projekten |
| 4 | Konsistenz | 2 | Breiten 760/1040/voll; `.state{max-width:none}` überstimmt die Seitenbreite; Audit- vs. Übersichts-Texte |
| 5 | Fehlervermeidung | 3 | Guards bei Löschen/Öffentlich gut; Stop und «Erneut deployen» ohne Kontext |
| 6 | Wiedererkennen | 3 | Deploy-Tabelle zeigt vollen Digest identisch in jeder Zeile |
| 7 | Effizienz | 2 | Keine Tastenkürzel, keine Sortierung, ganze Zeile nicht klickbar, Audit voller Anmeldungen |
| 8 | Ästhetik/Minimalismus | 3 | Projektliste ruhig; Detail-Übersicht dünn, ohne Erreichbarkeit/Security |
| 9 | Fehler beheben | 3 | Banner sagt, was weiterläuft; Fehlertext ist roher Stack-Auszug |
| 10 | Hilfe | 3 | Gute Inline-Hinweise; Verweise auf Dateien ohne Kontext |
| **Total** | | **27/40** | **Acceptable** |

## Design Specificity Verdict
LLM: Inhalt und Sprache sind eigen (was weiterläuft, wer schuld ist, «verhindern öffentlich»), die Hülle ist Kategorie-Standard (Vercel/Linear-Dunkel, Geist, Mono-Versalien, 4er-Kennzahlen, gestrichelte Leerzustände). Ohne Text wäre es austauschbar.
Detektor: 1 CLI-Befund (side-tab, styles.css .row-error), Overlay: Placeholder-Kontrast 3.0:1 (--faint), .rail-count 4.47:1 aktiv, nested-cards in den Benachrichtigungen (Tabelle in Karte), overused-font (Geist, gewollt).

## Priority Issues
- [P1] Status vermischt Deploy-Ergebnis und Laufzustand: «fehlgeschlagen» rot, obwohl die alte Fassung läuft. Fix: Laufzustand im Badge, Deploy-Ergebnis als eigene Zeile.
- [P1] «Stoppen» ohne Rückfrage und ohne Rückmeldung. Fix: Inline-Bestätigung (strenger bei öffentlich), Rückmeldung nach jeder Aktion.
- [P2] Audit als Rohdaten: Anmeldungen überdecken echte Ereignisse. Fix: lesbare Sätze, Aktion als Nebenzeile, Filter Alle/Fehler/Deploys, Anmeldungen standardmässig aus.
- [P2] Breitensystem uneinheitlich (Leerzustände ragen über Formulare hinaus). Fix: eine Breite pro Seite, Leerzustand folgt ihr.
- [P2] Schmale Fenster: Kennzahlen füllen den ersten Bildschirm, Tabelle wird schon bei 860px zu Karten, Seitenleiste scrollt ohne Hinweis. Fix: Kennzahlen 2×2 kompakt, Umbruch erst ~700px, Sortierung nach Dringlichkeit.

## Persona Red Flags
Alex: kein «/» für die Suche, Zeile nicht klickbar, Logs zwei Klicks, identische Digests. Sam: --faint 3:1 für Daten («0 kritisch») und Platzhalter; deaktivierter Primärknopf sieht wie ein anderer Stil aus, ohne Grund; Aktivitätspunkte nur Farbe. Riley: Banner auf dem Telefon unter 700px Kennzahlen; «Erneut deployen» sagt nicht, was.

## Minor Observations
Zeilen-Hover unsichtbar (.015); gestrichelte Leerzustände generisch; «Öffentlich»-Chip kaum unterscheidbar; «Keins.» statt «Keine»; Test-Push/Test-E-Mail deaktiviert ohne Grund; Rail-Zähler bleibt bernstein auch bei kritisch; Menü «…» in scrollendem Container kann abgeschnitten werden.

## Questions to Consider
Ist «fehlgeschlagen» Eigenschaft des Projekts oder des Deploys? Was macht es unverkennbar zum Homeserver-Werkzeug statt zur Vercel-Kopie?
