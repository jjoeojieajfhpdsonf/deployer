# Umstellung auf das cal.com-Design

Branch `design/cal` (abgezweigt von `design/cal-prototype`). Das neue Design ersetzt Midnight
vollständig: Hell ist Standard, Dunkel im gleichen Stil, umschaltbar im Profilmenü.
Grundlage ist die gemessene Formensprache der Startseite cal.com
(`docs/prototype-cal/referenz/stil.md`).

## Etappen (je ein Commit)

| Etappe | Inhalt |
|---|---|
| 0 (auf `main`) | «…»-Knöpfe: gefüllte Punkte statt Linien der Länge 0,01 |
| 1 Prototyp | weisser Grund, «Offene Befunde» hell mit roter Kennzahl, Security-Ergebnis als Bento, System in Unterseiten |
| 2 Fundament | `styles.css` neu mit allen Tokens, Theme-Mechanik (Server), Schriften lokal |
| 3a Shell | Seitenleiste, Kopf, Profilmenü mit Darstellung, Anmeldung |
| 3b Projekte | Projekt-Karten statt Tabelle, Projektdetail mit allen Reitern |
| 3c Formulare | Neues Projekt, Konto, Einstellungen; Bestätigungsmuster |
| 3d Security | Security (global), Externe Ziele |
| 3e Verwaltung | Domains, Tokens, Audit |
| 3f System | Übersicht, Cloudflare & HTTPS (Assistent), Benachrichtigungen |
| 3g Zustände | leer, laden, API nicht erreichbar, Rückmeldung, Bestätigung im Menü |
| 4 Aufräumen | Prototyp, DemoToggle, Midnight-Reste entfernt; Prüfskript für tote Klassen |

Die Screenshots je Etappe lagen in `docs/design-cal/<etappe>/` und sind nach dem Merge
gelöscht (im Git-Verlauf bis Commit `0fb7c58` noch abrufbar). Im Repo bleiben: Endstand der
wichtigsten Seiten in `aktuell/` und der Vergleich mit cal.com in `vergleich-*.png`
(links Airlock, rechts der cal.com-Ausschnitt; Hell und Dunkel).

## Fundament

- **Tokens zentral** im Kopf von `packages/web/src/styles.css`: Farben (Flächen, Linien, Tinte,
  Zustände mit Tönung und Ring), Radien (6/8/10/12/20/Pille), Schatten (Ring, Karte, erhöht,
  Menü, Buttons), Abstände (`--sp-1` … `--sp-14`), Schriftgrössen (12/13/14/15/16/18/24/30/40/44).
  Ausserhalb der Token-Blöcke steht kein fester Farbwert mehr (vorher 39).
- **Theme:** `html[data-theme]`. Wahl im Profilmenü (Hell, Dunkel, «Wie das Gerät»), gespeichert
  auf dem Server (`PUT /auth/preferences`, `app_settings.ui_prefs`), ausgeliefert mit
  `/auth/me`. `index.html` setzt das Theme vor dem ersten Bild aus einer lokalen Kopie, damit
  nichts aufblitzt; «Wie das Gerät» folgt `prefers-color-scheme` auch während der Sitzung.
- **Schriften lokal** über `@fontsource`: Cal Sans (OFL), Inter, Geist Mono. Kein externer
  Schrift-Server. Geist Sans ist entfernt.

## Entscheidungen (nach der gemessenen Referenz)

- **Buttons:** Radius 10 (36 hoch) bzw. 12 (40 hoch, Hauptaktion von Seite und Formular),
  Primär `#242424` mit Lichtkante – gemessen, keine Pillen.
- **Grund weiss**, Karten nur über Ring + weichen Schatten abgesetzt (Radius 20, Polster 24–28).
- **Cal Sans nur ab 24 px** (Seitentitel 40, Abschnitte 24, Kennzahlen 44, aktueller
  Assistenten-Schritt 24); sonst Inter. **Monospace nur** für Logs, Commit-Hashes und Code
  (z. B. TXT-Einträge); Adressen, Zeiten und Zahlen in Inter mit Tabellenziffern.
- **Weniger Linien:** Tabellen und Listen ohne Trennlinie je Zeile; Pillen mit Fläche statt Rahmen.
- **Hervorhebung:** Die Kennzahl «Offene Befunde» bleibt hell; Zahl und Statuspunkt in der
  Zustandsfarbe, dazu das Wort («kritisch»/«hoch»).
- **Zustände nie nur Farbe:** Status, Deploy-Ergebnis, Audit-Ergebnis, Token und Verifizierung
  als Pille mit Punkt und Wort. Die rot gefüllte Tabellenzeile für Fehler ist entfallen.
- **Rückfragen: inline für Normales, modal nur für Zerstörerisches** (Antwort 3 und 10, ersetzt
  «Bestätigungen einheitlich»). Erster Klick «Aktion …» als Umriss.
  - **Normale Rückfragen** laufen über eine gemeinsame Komponente, `InlineConfirm`
    (`packages/web/src/components/Confirm.tsx`): an derselben Stelle eine Warnzeile mit Zeichen
    (statt «!»), «Abbrechen» und der bestätigende Knopf (rot gefüllt; bei nicht zerstörerischen
    Aktionen primär). Kein Markup mehr von Hand.
  - **Modaler Dialog** (`ConfirmDialog`) nur für genau diese fünf: Projekt löschen, Cloudflare
    trennen, ganz offline nehmen, Token widerrufen, Umgebung löschen. Überschrift als Frage,
    Text der Warnung, rechts «Abbrechen» und die Aktion rot gefüllt; Esc und Klick daneben brechen
    ab, Fehler stehen im Dialog, danach Fokus zurück auf den Auslöser.
  - **Löschen** (Projekt, Umgebung): Kurzname eintippen, bevor «Endgültig löschen» aktiv wird;
    neben dem Namen im Dialog ein Knopf «Kopieren».
  - **Menüs** behalten ihre eigene Rückfrage im Menü (`menu-confirm`, `useMenu`), auch im
    Zeilenmenü. Während der Bestätigung verliert «Neu deployen» die Füllung.
  - Knopfpaare eines Formulars («Abbrechen / Adresse ändern») sind keine Rückfrage (`form-buttons`).
- **System in Unterseiten** (Übersicht, Cloudflare & HTTPS, Benachrichtigungen) statt einer
  langen Seite; Reiter als graue Schiene mit weissem Feld, wie die Filter.
- **Projektübersicht nur Karten** (Tabelle entfernt); bei Image-Projekten steht das Image-Tag,
  sonst der Commit-Hash in Monospace.
- **Bewegung (Emil):** Druck-Feedback auf Buttons (`scale(.97)`, 160 ms), Menüs klappen von der
  Auslöser-Ecke auf (150 ms, `@starting-style`), Karten reagieren auf Hover nur mit dem Schatten,
  Ladepunkt pulsiert; kein Übergang beim Theme-Wechsel; unter «weniger Bewegung» nur Farbe.
- **Feldrahmen dunkler als bei cal.com** (`#8a8d95`): WCAG 1.4.11 verlangt ≥ 3 : 1.
- **«Statusflächen ≥ 3 : 1»** gilt für Elemente, die einen Zustand ohne Text tragen (Punkte,
  Balken, Diagrammlinien, Primärfläche). Die blassen Tönungen hinter Status-Pillen tragen immer
  ein Wort; geprüft wird dort der Text auf der Tönung (≥ 4,5 : 1).
- **«Pro Nutzer»:** Airlock hat genau ein Konto; die Darstellung ist die Wahl dieses Kontos,
  gespeichert auf dem Server (gilt auf jedem Gerät).

## Prüfungen (nach jeder Etappe)

| Prüfung | Befehl | Ergebnis Endstand |
|---|---|---|
| Typecheck | `npm run typecheck` | grün |
| Tests | `npm test` | 416 von 416 (4 neu: Darstellung) |
| Kontrast | `node docs/design-cal/contrast.mjs` (liest die Tokens aus `styles.css`) | alle erfüllt; schwächster Text 4,67 : 1 (ok auf surface-3), Feldrahmen 3,10 : 1 |
| Tote CSS-Klassen | `node docs/design-cal/dead-css.mjs` | 0 von 391 |
| Impeccable (Gutachter) | `.claude/skills/impeccable/scripts/impeccable detect` + Durchsicht der Screenshots | Detektor ohne Befund; Befunde der Durchsicht siehe unten |
| Screenshots | `pnpm --filter @airlock/web exec tsx design-shots/shoot.ts --out <ordner> --only <gruppen>` | Hell und Dunkel, 1440 px |

Die Screenshots laufen gegen Fixtures (`packages/web/design-shots/fixtures.ts`, typisiert gegen
die echten DTOs, erfundene Projekte); dazu Varianten für leere Daten, hängende Anfragen und eine
nicht erreichbare API.

**Behobene Befunde der Durchsicht:** Fehler-Log zeigte das Log eines anderen Projekts (Fixture);
rot gefüllte Fehlerzeilen → Pillen; «!»-Warnungen → Zeichen + Wort; zwei gefüllte Knöpfe bei
Bestätigungen; Suchfeld zu schmal (Platzhalter abgeschnitten); doppelter Abstand unter Reitern;
Beschreibungen weit unter dem Titel; Domains verwies auf Compose-Dateien und zeigte «noch – Tage»;
Menü wurde von Pillen der Nachbarkarte überdeckt; Titel «Keine Verbindung zur API» brach um;
Checkbox im Audit-Kopf nicht auf der Linie.

## Entfernt (Etappe 4)

- Dateien: `src/prototype/` (Route `/prototype`, `prototype-cal.css`, `ProtoBar`, Flag),
  `components/DemoToggle.tsx`, `lib/demo.ts` (Testdaten-Weiche `?demo=`; Extremfälle zeigen
  jetzt die Screenshot-Fixtures), Paket `@fontsource/geist`.
- Klassen gegenüber Midnight (`main`): `alert-warn`, `badge-ok`, `badge-warn`, `badge-bad`,
  `facts-plain`, `menu-danger`, `mono`, `projects-table`, `row-error`, `row-link`, `sev-chip-low`,
  `stage-list`, `stage-mark`, `url-list` (dazu alle Midnight-Werte und -Hilfsregeln).
- Neu: `bento*`, `pcard*`, `status-warn`, `button-danger-solid`, `menu-danger-solid`,
  `confirm-note`, `menu-group-label`, `menu-check`, `banner`, `lede-tight`, `login-lede`.

## Offen

- **Dunkel ohne Vorbild:** cal.com hat auf der Startseite kein Dunkel; die dunkle Variante ist
  eine eigene Ableitung in Schwarz und Grau (alle Kontraste geprüft).
- **Kein Handy-Layout** (bewusst, Desktop-Werkzeug); die bisherigen Umbrüche gelten weiter.
- **Screenshots mit Fixtures**, nicht mit echten Daten; ein Blick auf den echten Server nach dem
  Merge lohnt (lange Namen, viele Projekte, echte Logs).
- **Inter** setzt den Bindestrich zwischen Grossbuchstaben etwas höher («Kontoauszug-Reader»).
- **Speicherplatz:** Die Etappen-Ordner sind gelöscht (von 24 MB auf rund 6 MB); im
  Git-Verlauf bleiben sie enthalten.
- **PRODUCT.md / DESIGN.md** fehlen weiterhin; mit `impeccable init` würde der neue Stil für
  spätere Gutachten zum Massstab.
- Impeccable meldet eine neuere Version (v4.8.2); nicht aktualisiert.
