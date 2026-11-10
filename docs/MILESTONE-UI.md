# Milestone «UI-Grundlagen»

Branch `ui-grundlagen`, abgezweigt von `ui-projektseite` (Commit `ef34124`, weil `ui-projektseite`
um Mitternacht noch nicht in `main` war; die Session «Projektseite neu gestalten» lief nicht mehr,
ihr letzter Commit ist die Grundlage). Ein Commit pro Etappe. Nicht nach `main` gemergt, nicht
gepusht.

Alles in Hell und Dunkel, im bestehenden Design (Tokens in `packages/web/src/styles.css`, Cal Sans,
Inter, Geist Mono). Nur Desktop: geprüft wird bei 1440 px.

Offene Entscheidungen stehen als Fragen in `docs/FRAGEN-NACHT.md` (Hauptordner, nicht committet);
hier sind die betroffenen Teile mit «offen, Frage Nr. n» vermerkt.

## Prüfungen je Etappe

- `pnpm -r typecheck`, alle Tests (`pnpm -r test`, API: `node:test`), `pnpm -r build`
- Screenshots: bis Etappe 2 mit `design-shots/shoot.ts`, ab Etappe 3 `pnpm test:visual`
  (zusätzlich `shoot.ts` für die Bilder der Etappe in `docs/design-cal/ui-grundlagen/`)
- Kontrast: `node docs/design-cal/contrast.mjs`
- Impeccable nur als Gutachter (audit/critique/detect); Befunde zu Kontrast, Schriftgrösse und
  kaputter Darstellung werden behoben, Stilfragen gehen nach dem Taste Skill.

## Etappen

| Nr. | Inhalt | Stand |
|---|---|---|
| 1 | Zustände: Error Boundary, fünf Zustände je Ansicht, Datumswerte absichern | erledigt |
| 2 | Rückmeldung bei Aktionen: Ladeknopf, Toast, Rückgängig, Aktivitätsanzeige | erledigt; Bestätigung offen, Frage Nr. 3 |
| 3 | Visuelle Regressionstests (`pnpm test:visual`, `test:visual:update`) | erledigt |
| 4 | Komponenten-Übersicht `/design`, doppelte Varianten zusammenführen | erledigt; 4 Zeichen offen, Frage Nr. 4 |
| 5 | Sprache und Texte: `docs/TEXTE.md` (Vorschlag, nichts umbenannt) | erledigt; Wahl a/b offen, Frage Nr. 1 |
| 6 | Befehlspalette und Tastatur | geplant |
| 7 | Erster Start, Login, Marke | geplant |
| 8 | Barrierefreiheit (axe-core in den Playwright-Tests) | geplant |
| 9 | Handyansicht | **entfällt auf Wunsch** («Handy egal») |

### Etappe 1 – Zustände

Schon vorhanden (Commit `1d4c8fc` auf `main`, über `ui-projektseite` enthalten):
- Error Boundary um die App und um jede Seite (`components/ErrorBoundary.tsx`): «Etwas ist
  schiefgelaufen», «Neu laden», Details einklappbar, Meldung an `POST /api/v1/client-errors`
  (gekürzt, Secrets entfernt, Rate-Limit), Log auf dem Server.
- Datumsprüfung für «Voraussichtlich zurück» (`parseLocalDateTime`, `backAtProblem` in
  `packages/shared/src/pause-page.ts`), `lib/dates.ts` in der API.

Abnahme:
- Keine Ansicht zeigt je eine leere oder schwarze Seite; jeder Renderfehler endet in der Fehlerseite.
- Jede Ansicht hat die fünf Zustände Laden, Leer, Fehler, Teilweise, Veraltet (Tabelle unten).
- Laden: Skeletons in der Form des Inhalts; kein «wird geladen…»-Text mehr.
- Leer: Satz mit nächstem Schritt (Knopf oder Link).
- Fehler: verständlicher Satz und «Erneut versuchen».
- Teilweise: was da ist, wird gezeigt; der fehlende Teil hat einen eigenen Hinweis.
- Veraltet: Server nicht erreichbar → letzte Daten bleiben, Hinweisleiste mit «Stand vor n Min.».
- Kein `new Date(…)`, `toISOString()` oder `toLocale…()` auf ungeprüften Werten (Test).

Umsetzung:
- `components/States.tsx`: Skeleton-Bausteine (`Sk`, `SkLines`, `SkStats`, `SkProjectCards`, `SkCard`,
  `SkRows`, `SkLog`, `SkHead`, `SkProjectDetail`), `EmptyState`, `ErrorState` (Grund in Worten,
  «Erneut versuchen»), `PartialNote`, `QueryView`. Regel: **Daten gehen vor** – scheitert nur ein
  späteres Nachladen, bleibt die Ansicht stehen (vorher sprang z. B. die Projektliste auf «konnten
  nicht geladen werden», sobald ein Hintergrund-Abruf scheiterte).
- `lib/connection.ts` + `components/StaleBar.tsx`: hört auf alle Abfragen; antwortet der Server nicht
  (Netz weg, 502/503/504), erscheint über dem Inhalt «Keine Verbindung zum Server. Angezeigt ist der
  Stand vor n Min.» mit «Erneut versuchen»; die nächste erfolgreiche Antwort blendet sie aus.
- `api.ts`: Netzabbruch und Nicht-JSON-Antworten (Proxy-Fehlerseite) werden zu `ApiError` mit
  Status 0 bzw. dem HTTP-Status statt eines rohen `TypeError`/`SyntaxError`.
- `lib/dates.ts` (Oberfläche): einzige Stelle für Datumsumwandlung und -format; ungültige Werte
  ergeben «–». 40 Stellen umgestellt. `lib/dates.test.ts` prüft die Formatierer mit kaputten Werten
  (u. a. Jahr 333333) und durchsucht den Quelltext nach `new Date(wert)`, `Date.parse`,
  `toISOString`, `toLocaleDateString/TimeString` ausserhalb von `lib/dates.ts`.
- Neues Test-Skript für die Oberfläche: `pnpm --filter @airlock/web test`.

Zustände je Ansicht («V» = gemeinsame Leiste «Keine Verbindung», gilt überall in der Shell):

| Ansicht | Laden | Leer (nächster Schritt) | Fehler | Teilweise | Veraltet |
|---|---|---|---|---|---|
| Shell (Anmeldung prüfen) | Skeleton Seitenleiste + Inhalt | – | «Keine Verbindung zur API» + «Erneut versuchen» | – | V |
| Projekte | Kennzahlen + Karten | «Erstes Projekt anlegen» | ErrorState | Karte «Letzte Aktivität» mit eigenem Fehler | V |
| Projektseite | Kopf, Reiter, Karten | – | ErrorState; 404 → «Projekt nicht gefunden» | Deployments-, Aktivitäts-, Security-Karte je mit eigenem Fehler; Fehlerbox ohne Log → Hinweis | V |
| – Deployments | Zeilen | «Noch kein Deployment» | ErrorState | Log je Deployment mit eigenem Fehler | V |
| – Logs | Log-Zeilen | «Noch keine Ausgabe» (Start über «⋯») | ErrorState | – | V |
| – Zugriffe (statisch) | Zeilen | «Noch keine Aufrufe» / «Alle zeigen» | ErrorState | – | V |
| – Security | Kennzahlen + Zeilen | «Jetzt scannen» | ErrorState | gescheiterte Stufe: Hinweis, Rest vollständig | V |
| – Einstellungen | Zeilen je Karte | – | je Karte (Veröffentlichung, Header) | Karten unabhängig | V |
| Neues Projekt | – (Formular) | – | Feld- und Formularfehler (bestehend) | – | V |
| Security (global) | Kennzahlen + Zeilen | «Projekt anlegen» | ErrorState | – | V |
| Domains | Karten | Zonen: «Mit Cloudflare abgleichen» | ErrorState (Systemstatus, Zonen) | Zonenliste unabhängig | V |
| Externe Ziele | Zeilen | «Ziel hinzufügen» (Fokus ins Feld) | ErrorState | Scan je Ziel mit eigenem Fehler | V |
| Tokens | Zeilen | «Token anlegen» (Fokus ins Feld) | ErrorState | – | V |
| Audit | Zeilen | Suche leeren / alle zeigen / Projekt anlegen | ErrorState | – | V |
| System (alle Unterseiten) | Karten | – | ErrorState je Bereich (Status, Cloudflare, GitHub, Benachrichtigungen, Pause-Vorlage) | Bereiche unabhängig | V |
| Konto | Platzhalter in den Werten | – | «nicht abrufbar» beim Token-Zähler | – | V |
| Nicht gefunden | – | «Zu den Projekten» | – | – | – |

Screenshots: `docs/design-cal/ui-grundlagen/1-zustaende/` (Gruppe `zustand` in `design-shots/shoot.ts`).

### Etappe 2 – Rückmeldung bei Aktionen

Abnahme:
- Ein Knopf-Muster: Ladezustand mit Spinner, Breite bleibt stabil.
- Ergebnis als Toast; «Rückgängig» bei Offline nehmen, Header setzen/entfernen, Schaltern.
- Fehler-Toast mit Grund und Aktion.
- Aktivitätsanzeige im Kopf für Deploy, Scan, Zertifikat, Tunnel: Zahl laufender Vorgänge, Klick
  öffnet Liste mit Fortschritt und Link; bleibt beim Seitenwechsel.
- Ein gemeinsamer Toast und eine gemeinsame Bestätigung für die ganze App; Übergänge nach Emils
  Skills, `prefers-reduced-motion` beachtet.

Umsetzung:
- **Ladeknopf:** `aria-busy` auf dem Knopf. Der Text bleibt im Fluss (Breite stabil) und wird
  unsichtbar, ein Ring dreht darüber; gefüllte Knöpfe behalten ihre Füllung. Ohne Bewegung steht
  der Ring still. 44 Stellen umgestellt, die vorher den Text tauschten («Wird gespeichert…»,
  «Startet…», «Prüft …»).
- **Toast:** `lib/feedback.ts` (`notifyOk`, `notifyWarn`, `notifyError`, `UNDO_MS`). Fehler jeder
  Aktion laufen über den `MutationCache` in einen Fehler-Toast mit Titel (`meta.errorTitle`), Grund
  (`errorReason`) und «Erneut versuchen». Feldfehler (400 mit `details`) und Stellen mit eigener
  Anzeige (`meta.quiet`: Passwort, Begründung beim Akzeptieren, Pause-Dialog, Veröffentlichung,
  Erreichbarkeit) bleiben am Formular. Die verstreuten Fehlerzeilen unter Knöpfen (rund 30) sind
  entfernt, ebenso die eigenen Hinweiszeilen nach Start/Stopp und Speichern.
- **Rückgängig:** Offline nehmen/Pausieren/Access (schon vorhanden, `lib/public.ts`), Erreichbarkeit
  (schon vorhanden), Header setzen/entfernen/zurücksetzen (neu: Regel davor wird wieder gesetzt bzw.
  entfernt), Schalter «Nach Merge» (Auto-Deploy), «Behalten»/«Ablauf wieder aktivieren», Stoppen
  (→ Starten).
- **Aktivitätsanzeige** (`components/ActivityIndicator.tsx`, `lib/activities.ts`): im Kopf neben dem
  Profil, nur solange etwas läuft – Ring, Zahl, «Vorgang/Vorgänge». Klick öffnet die Liste
  (gleiches Menü-Verhalten wie das Profil): Deploy mit Schritt n von 4, Scan mit Stufe n von m,
  Zertifikat mit Schritt 1/2 von 2, Tunnel; je mit Balken und Link. Quellen: Projektliste,
  Cloudflare-Status, laufende Mutation mit festem Schlüssel (Tunnel) – deshalb bleibt sie beim
  Seitenwechsel. Endet ein Deploy oder Scan, solange die Oberfläche offen ist: Toast mit Ergebnis
  und Link («Log ansehen», «Ansehen»).
- **Bestätigung:** offen, Frage Nr. 3 (inline wie heute, ein modaler Dialog, oder gemischt).
- Gutachten (Impeccable) behoben: Projektseite je Projekt neu aufgebaut (`key`), damit «Rückgängig»
  nach einem Projektwechsel das richtige Projekt trifft; «Erneut versuchen» nur bei Server weg/5xx
  und nie bei Löschen/Trennen; Balken der Aktivitätsliste gleich lang; Fokus geht beim Verschwinden
  der Anzeige zum Profil; Ergebnis-Toast auch für das Zertifikat; ohne Bewegung kein Teilbalken, der
  wie 30 % aussieht; ein Tempo für alle Ringe.
- Bewegung: Emils Skill `review-animations` lässt sich nur von Hand aufrufen
  (`/review-animations`); das Gutachten dazu steht noch aus.
- Screenshots: `docs/design-cal/ui-grundlagen/2-rueckmeldung/` (Gruppe `aktion`).

### Etappe 3 – Visuelle Regressionstests

Abnahme:
- Playwright-Screenshot-Tests aller Hauptseiten und wichtigen Zustände mit Fixtures, Hell und
  Dunkel, 1440 px; feste Uhrzeit, damit die Bilder stabil sind.
- Vergleich mit Referenzbildern, kleine Schwelle, Diff-Bilder bei Abweichung.
- `pnpm test:visual` und `pnpm test:visual:update`; Regel in `CLAUDE.md`.

Umsetzung:
- `@playwright/test` 1.65.0 (gleiche Version wie `playwright`), installiertes Chrome.
- `packages/web/visual/`: `playwright.config.ts` (eigener Vite-Server auf Port 5299, 4 Worker,
  Schwelle höchstens 20 abweichende Pixel – ein Anteil von 0,2 % liess einen halb so langen Balken
  durch –, Animationen aus, feste Schriftglättung ohne LCD-Text und GPU, sonst schwankte die Seite
  mit offenem Menü), `ui.spec.ts` (42 Szenen × Hell/Dunkel = 84
  Bilder), `fixed-clock.ts` (feste Uhr 10.11.2026 14:00 in Node für die Fixtures und im Browser über
  `page.clock`). Referenzen in `visual/referenz/` (eingecheckt, rund 11 MB), Ergebnisse und
  Diff-Bilder in `visual/ergebnis/`, HTML-Bericht in `visual/bericht/` (beide in `.gitignore`).
- `design-shots/shoot.ts` exportiert jetzt Szenen, Kontext-Optionen, API-Attrappe (`installRoutes`)
  und `openShot`; dieselben Fixtures für Screenshots und Tests. Als Skript gestartet verhält es sich
  wie bisher.
- Stabilität: drei Läufe hintereinander, 84 von 84 ohne Abweichung (rund 35 s). Probe: eine
  absichtlich geänderte Balkenbreite wird erkannt (Diff-Bild in `visual/ergebnis/`).

### Etappe 4 – Komponenten-Übersicht

Abnahme:
- `/design` (nur angemeldet) zeigt alle Bausteine in Hell und Dunkel nebeneinander.
- Doppelte oder abweichende Varianten im Code zusammengeführt; Liste unten.

Umsetzung:
- `pages/Design.tsx`, Route `/design` (hinter der Anmeldung, nicht in der Seitenleiste): Knöpfe
  (alle Varianten, deaktiviert, lädt), Pillen und Zähler (Status, Öffentlich, Schwere, Note,
  Reiter-Zähler), Zeilen (Einstellungskarte mit Schalter), Karten (Kennzahl, Karte), Reiter und
  Filter, Menü, Dialog, Toasts (Knöpfe lösen echte Toasts aus), Formularfelder mit Fehler,
  Code-Feld und Log, Skeletons, Leer/Fehler/Teilweise/Veraltet/Hinweise, Zeichen, Diagramme
  (Note im Ring, CPU/RAM-Verlauf).
- Hell und Dunkel nebeneinander: die Tokens gelten jetzt auch für `.theme-light`/`.theme-dark`
  (`:root, .theme-light` und `:root[data-theme='dark'], .theme-dark`); die sechs Dunkel-Regeln für
  einzelne Bausteine greifen auch in `.theme-dark`, nicht aber in `.theme-light`. Seite selbst
  unverändert (alle bisherigen Referenzbilder gleich). `contrast.mjs` liest die neuen Blöcke.
- Gefunden über die Übersicht und behoben: Ladeknopf «Ja, löschen» zeigte im Dunkelmodus den
  Text durch den Ring (Dunkel-Regel war spezifischer).
- Screenshot `docs/design-cal/ui-grundlagen/4-bausteine/`, visuelle Szene `design-bausteine`.

Zusammengeführt bzw. entfernt:
| Was | Vorher | Jetzt |
|---|---|---|
| `IconOk`, `IconBad`, `IconPending` | gleich gezeichnet in `ProjectOverview.tsx` und `CloudflareSetup.tsx` | nur `Icons.tsx` |
| `IconChevron` | `DeployList.tsx` (Strich 1,7) und `Icons.tsx` (1,6), gleiche Form | nur `Icons.tsx` |
| `relativeTime`, `duration` | zusätzlich aus `components/Status.tsx` weitergereicht | nur `lib/format.ts` |
| Lade-Texte auf Knöpfen («Wird gespeichert…», «Startet…» u. a.) | 44 Varianten | ein Muster `aria-busy` (Etappe 2) |
| Fehlerzeilen unter Knöpfen (`.error`, `.error-inline` je Stelle) | rund 30 Stellen | Fehler-Toast (Etappe 2) |
| Hinweiszeilen nach Aktionen (`.notice-ok`, eigene «✓ Gespeichert») | Projekte, Projektseite, Benachrichtigungen, Auto-Deploy | Toast (Etappe 2); Klasse `.notice-ok` entfernt |
| Ladeanzeige `.state-loading` | Punkt + «Wird geladen…» | Skeletons (Etappe 1); Klasse entfernt |

Offen, Frage Nr. 4: `IconWarn`, `IconCheck`, `IconUp`, `IconKey` gibt es je zweimal mit
**verschiedener** Form; welche bleibt, ist eine Gestaltungsfrage. Offen, Frage Nr. 3: die
Bestätigungen (23 Stellen mit eigenem Markup).

### Etappe 5 – Sprache und Texte

Abnahme:
- `docs/TEXTE.md`: Glossar mit Varianten (a) alles deutsch und (b) feste Fachbegriffe englisch,
  Empfehlung mit Begründung, Text-Leitfaden. Nichts umbenannt.
- Wahl a/b: offen, Frage Nr. 1.

### Etappe 6 – Befehlspalette und Tastatur

Abnahme:
- ⌘K / Ctrl+K öffnet die Palette: Projekte und Seiten suchen, Aktionen (Neu deployen, Offline
  nehmen, Scan starten, Token erstellen) mit denselben Bestätigungen wie in der Oberfläche.
- Kürzel `/`, `g p`, `g s`, `g a`, `?`; keine Kürzel, die Browser-Standards überschreiben.

### Etappe 7 – Erster Start, Login, Marke

Abnahme:
- Login-Seite im Design.
- Einrichtungs-Assistent (Passwort → Cloudflare → Tailscale/Adressen → Zertifikat → erstes
  Projekt) mit Fortschritt, jederzeit überspringbar, unter System fortsetzbar.
- Drei Logo-Varianten in `docs/design-cal/marke/`, eine eingebaut (Wahl offen, siehe Fragen).

### Etappe 8 – Barrierefreiheit

Abnahme:
- axe-core in den Playwright-Tests (alle Hauptseiten, Hell/Dunkel), ohne Befunde.
- Sichtbarer Fokus überall; Bedienung per Tastatur (Menüs, Dialoge, Reiter, Palette).
- `aria-label` für alle Icon-Knöpfe; Live-Regionen für Statuswechsel.
