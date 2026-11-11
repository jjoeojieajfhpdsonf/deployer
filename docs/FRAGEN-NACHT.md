# Fragen aus dem Nachtlauf (11.11.2026)

Nachtlauf: Milestone A «UI-Grundlagen» (Branch `ui-grundlagen`), danach Milestone B «UI-Qualität»
(Branch `ui-qualitaet`). Alles, was der Auftrag nicht eindeutig festlegt, steht hier als Frage –
ohne Empfehlung und ohne Vorauswahl (ausser wo der Auftrag eine Empfehlung verlangt). Der
betroffene Teil ist im Code offen geblieben und in der MILESTONE-Datei als «offen, Frage Nr. n»
vermerkt.

**Beantwortet am 11.11.2026 (Joël).** Die Antworten stehen gesammelt hier; die Fragen darunter
bleiben unverändert als Begründung.

## Antworten

1. **Sprache:** (b) – feste Liste bleibt englisch, alles andere deutsch. Uneinheitlichkeiten auf je
   ein Wort bringen: immer «Audit-Log», «Umgebungsvariablen», «Rollback» im Text / «Zurückrollen» als
   Knopf, «Tailnet» in der Oberfläche. Umbenennen als eigene Etappe.
2. **main in die UI-Branches:** (a). Umgesetzt mit Rückfrage zur Reihenfolge: `ui-qualitaet`
   enthielt `ui-grundlagen` und `main` schon; daher direkt `ui-qualitaet` per Merge-Commit nach
   `main` (66bddf2). Worktrees danach aufgeräumt.
3. **Bestätigungen:** (c) mit (b) – eine gemeinsame Inline-Komponente für normale Rückfragen; ein
   modaler Dialog nur für Zerstörerisches (Projekt löschen, Cloudflare trennen, ganz offline nehmen,
   Token widerrufen, Umgebung löschen). Regel in `docs/design-cal/README.md` ersetzen.
4. **Zeichen:** eine Familie – Strichstärke 1,6, runde Enden und Ecken, alle nur in `Icons.tsx`.
   IconWarn: abgerundetes Dreieck (Fassung aus `Security.tsx`); IconCheck: längerer Haken
   (`ProjectOverview.tsx`), Strich 1,6; IconUp: die Fassung, die mit Strich 1,6 und runden Enden am
   saubersten wirkt, die andere entfernen; IconKey: ein Bart (`Actor.tsx`). Screenshots bewusst
   aktualisieren.
5. **Kürzel:** (a) so lassen – ⌘K/Ctrl+K und «/» nur solange Airlock den Fokus hat und nicht in
   Eingabefeldern. Im Hilfe-Dialog (?) vermerken, dass sie die Browser-Kürzel in dieser Seite ersetzen.
6. **Marke:** Variante 1 (Doppeltor). Platz: (b) – in der Seitenleiste vor «Airlock», der Knopf zum
   Einklappen bleibt daneben; zusätzlich Favicon und Anmeldeseite. Variante 3 nicht verwenden (wirkt
   bei 16 px wie ein Pause-Symbol).
7. **Header-Themen nur von ZAP:** gemischt – Permissions-Policy, X-AspNet-Version,
   X-Backend-Server: (b) in den Header-Check übernehmen (Permissions-Policy mit «Header setzen», die
   beiden Versions-Header wie Server/X-Powered-By), ZAP-Regeln 10063, 10061, 10039 unterdrücken.
   CSP-Qualität (10055) und CORS (10098): (a) bleiben ZAP-Befunde; bei 10055 als Aktion auf den
   CSP-Ablauf (Report-Only, Vorschlag) verweisen.
8. **Port/Healthcheck/Grenzen:** (b) neuer Abschnitt «Container» in den Einstellungen (nur bei
   Container-Projekten: Port, Healthcheck-Pfad, CPU, RAM); Fehlerbox springt dorthin, Feld fokussiert
   und vorbelegt. «Grenze erhöhen» schlägt den nächsten sinnvollen Wert vor (Verdopplung, gedeckelt
   durch freien Server-RAM), mit aktuellem Verbrauch daneben. Gleiche Felder per MCP (update_project).
9. **Tokens:** weder Konto noch System – Tokens gehören seit Meilenstein 9 zur Umgebung. Fest in die
   Einstellungen der Umgebung (Reiter «Tokens»), Brotkrumen «Airlock › <Umgebung> › Tokens». Weiter
   erreichbar über ⌘K und «Per Chat».
10. **Löschen:** (a) Kurzname – mit Kopier-Knopf neben dem Namen im Dialog.
11. **Glocke:** (b) nur Ereignisse, für die es Benachrichtigungen gibt (Deploy gescheitert, neuer
    kritischer/hoher Befund, öffentlich geschaltet/offline, externes Ziel verloren,
    Zertifikat/Tunnel/Infrastruktur, Chat-Projekt läuft bald ab, Gateway-Warnung). Höchstens 8,
    «Alle im Audit-Log».
12. **Zurück-Knopf:** (b) Umstieg auf `createBrowserRouter` + `useBlocker`.
13. **Passwort-Formular:** (a) nein.
14. **Befehl auf der Tokens-Seite:** `--scope user`, Token nicht im Befehl, sondern über eine Variable
    (`read -rs "AIRLOCK_TOKEN?Token: "` in zsh bzw. `read -rsp "Token: " AIRLOCK_TOKEN` in bash), dann
    `claude mcp add --transport http --scope user airlock <url>/mcp --header "Authorization: Bearer
    $AIRLOCK_TOKEN"` und `unset AIRLOCK_TOKEN`. Umschalter zsh/bash; Token weiter nur einmal sichtbar.
15. **Sitzung abgelaufen:** (b) Link «Zur Anmeldeseite» mit Hinweis, dass ungespeicherte Eingaben
    verloren gehen.
16. **Nach der Anmeldung:** (b) Knopf «Erneut ausführen» für nicht zerstörerische Aktionen; nichts
    automatisch.

## Ausgangslage

- `ui-projektseite` war um Mitternacht nicht in `main` gemergt. Die Session «Projektseite neu
  gestalten» lief nicht mehr (letzte Aktivität 10.11. 22:26). `ui-grundlagen` ist deshalb von deren
  letztem Commit `ef34124` («Projektseite 6: Einstellungen mit Sprungnavigation …») abgezweigt.
  Etappe 7 der Projektseite (falls geplant) ist darin nicht enthalten.
- `main` steht bei `7cf4f5a` (Gateway-Warnung). Dieser Commit ist nicht in `ui-projektseite` und
  damit auch nicht in `ui-grundlagen`/`ui-qualitaet`. Er wurde nicht hineingemergt (siehe Frage 2).

---

## Frage 1 – A, Etappe 5: Sprache der Oberfläche (a) oder (b)

- Fakten: `docs/TEXTE.md` (Branch `ui-grundlagen`) listet alle Begriffe der Oberfläche mit beiden
  Varianten und die heutigen Uneinheitlichkeiten (z. B. «Audit»/«Audit-Log»/«Aktivität»,
  «Umgebung»/«Variablen», «Rollback»/«Zurückrollen»). Nichts ist umbenannt.
- Frage: Welche Variante soll gelten?
- Optionen:
  - (a) **Alles deutsch** (nur Eigennamen und CSP/HSTS englisch): z. B. *Sicherheit*, *Protokoll*,
    *Auslieferungen*, *Ausliefern*, *Ausgabe*, *Zugangsschlüssel*. Folge: Oberfläche weicht von
    Docker-, Git- und MCP-Wörtern ab; einige Ersatzwörter sind mehrdeutig (Protokoll, Prüfung).
  - (b) **Feste Liste bleibt englisch** (Deploy, Rollback, Security, Scan, Header, Healthcheck,
    Container, Image, Repo, Commit, Pull Request, Logs, Audit-Log, Token, Auto-Deploy, Upload,
    Tunnel …), alles andere deutsch. Folge: näher am heutigen Stand; die Liste muss abschliessend
    gepflegt werden.
- Empfehlung (vom Auftrag verlangt): **(b)** – Begründung in `docs/TEXTE.md` (gleiche Wörter wie
  Docker/GitHub/Claude und die MCP-Werkzeuge; deutsche Ersatzwörter teils mehrdeutig).
- Nach der Wahl: Umbenennen und Vereinheitlichen als eigene Etappe (Texte, Screenshots, Tests).

---

## Frage 3 – A, Etappe 2: «Ein gemeinsamer … Bestätigungsdialog für die ganze App»

- Fakten: Bestätigungen laufen heute **inline** – erster Klick «Aktion …», danach erscheint an
  derselben Stelle eine Warnzeile mit «Abbrechen» und einem roten Bestätigungsknopf; in Menüs
  dasselbe im Menü (`menu-confirm`). Das Muster ist in `docs/design-cal/README.md` als Entscheidung
  festgehalten («Bestätigungen einheitlich»). Es gibt 23 Stellen in 11 Dateien (u. a.
  `ProjectMenuItems.tsx`, `DeployList.tsx`, `Publication.tsx`, `HeaderFix.tsx`, `CloudflareSetup.tsx`,
  `ClaudeFix.tsx`, `Security.tsx`), jeweils mit eigenem Markup (`confirm-inline`, `useConfirm` in
  `HeaderFix.tsx`). Einen modalen Bestätigungsdialog gibt es nicht.
- Was gebaut ist: der gemeinsame Toast (alle Rückmeldungen über `lib/feedback.ts`, ein Toaster).
  Die Bestätigung ist **nicht** angefasst (offen).
- Frage: Was ist mit «ein gemeinsamer Bestätigungsdialog» gemeint?
- Optionen:
  - (a) Ein modaler Dialog (Overlay, Fokus gefangen, Esc schliesst) ersetzt alle Inline-
    Bestätigungen. Folge: anderes Bild an 23 Stellen, Screenshots ändern sich; die Entscheidung im
    README wird ersetzt.
  - (b) Das Inline-Muster bleibt, wird aber zu **einer** Komponente zusammengeführt (gleiches Markup,
    gleiche Texte, gleicher Fokus-Ablauf). Folge: Aussehen fast gleich, Code einheitlich.
  - (c) Gemischt: modal nur für zerstörerische Aktionen (Löschen, Trennen, Offline nehmen), inline
    für den Rest. Folge: zwei Muster, klar abgegrenzt.
  - (d) Nichts ändern.

---

## Frage 4 – A, Etappe 4: Zeichen mit zwei verschiedenen Formen

- Fakten: Beim Zusammenführen der Bausteine gab es Zeichen, die doppelt definiert sind. Gleiche
  Formen sind zusammengelegt (`IconOk`, `IconBad`, `IconPending`, `IconChevron` jetzt nur in
  `components/Icons.tsx`). Bei vier Zeichen sind die beiden Fassungen **verschieden gezeichnet**;
  sie sind nicht angefasst (offen):
  - `IconWarn`: `Icons.tsx` (spitzes Dreieck, u. a. Zustände, Leiste «Keine Verbindung», Menü-
    Rückfragen) und `Security.tsx` (abgerundetes Dreieck, u. a. Audit, Header, Claude-Fix, Eckdaten).
  - `IconCheck`: `DeployList.tsx` (kurzer Haken, Strich 1,7) und `ProjectOverview.tsx` (längerer Haken,
    Strich 1,6).
  - `IconUp`: `DeployList.tsx` (Pfeil «M8 13V3.5») und `CloudflareSetup.tsx` (Pfeil «M8 12.5v-9»,
    andere Spitze).
  - `IconKey`: `Actor.tsx` (Schlüssel mit einem Bart) und `Icons.tsx` (Schlüssel mit zwei Bärten).
- Frage: Welche Fassung soll je Zeichen bleiben?
- Optionen (je Zeichen):
  - (a) die Fassung aus `Icons.tsx` bzw. der zuerst genannten Datei – die andere Stelle ändert ihr Bild
    leicht;
  - (b) die jeweils andere Fassung – die Stellen der ersten ändern ihr Bild leicht;
  - (c) beide behalten (bewusst verschiedene Bedeutung), dann mit unterschiedlichen Namen.
  Die Seite `/design` (Abschnitt «Zeichen») zeigt das Zusammenspiel; Screenshots ändern sich je
  nach Wahl an einigen Stellen.

---

## Frage 5 – A, Etappe 6: Kürzel, die mit dem Browser kollidieren

- Fakten: Der Auftrag verlangt «⌘K / Ctrl+K» und «/ (Suche)» und zugleich «Keine Kürzel, die
  Browser-Standards überschreiben». Umgesetzt ist der Wortlaut: ⌘K (Mac) bzw. Ctrl+K (Windows/Linux)
  öffnen die Palette, «/» springt in die Suche der Seite (sonst Palette), beides mit
  `preventDefault` (`components/Shortcuts.tsx`). Auf dem Mac greift Ctrl+K nicht (dort löscht es im
  Feld bis zum Zeilenende – das bleibt). Dabei gilt:
  - **Ctrl+K** ist in Chrome und Firefox unter Windows/Linux «Suche in der Adressleiste»; in Firefox
    auf dem Mac ist **⌘K** «Suchfeld». Safari und Chrome auf dem Mac belegen ⌘K nicht.
  - **«/»** öffnet in Firefox die Schnellsuche auf der Seite (nur ausserhalb von Feldern).
  - Alle anderen Kürzel (g p, g s, g a, ?) haben keine Browser-Belegung; Einzeltasten wirken nur
    ausserhalb von Eingabefeldern und ohne ⌘/Ctrl/Alt.
- Frage: Sollen diese beiden Kürzel so bleiben?
- Optionen:
  - (a) So lassen (Wortlaut des Auftrags): Palette überschreibt in den genannten Browsern deren
    Kürzel, solange Airlock den Fokus hat.
  - (b) Nur ⌘K auf dem Mac, Ctrl+K nirgends; Windows/Linux ohne Palette-Kürzel (Zugang über «/»).
  - (c) Anderes Kürzel für Windows/Linux (z. B. Ctrl+Shift+K – in Firefox die Webkonsole, also auch
    belegt) oder nur über einen Knopf im Kopf.
  - (d) «/» nur in die Suche der Seite, ohne Rückfall auf die Palette (Firefox-Schnellsuche bleibt auf
    Seiten ohne eigene Suche frei).

---

## Frage 6 – A, Etappe 7: Welche Bildmarke, und wo?

- Fakten: Drei Varianten liegen in `docs/design-cal/marke/` (SVG, Favicon, Proben bei 16/32/128 px
  in Hell und Dunkel, Beschreibung in `README.md`), entworfen nach dem Taste Skill:
  - **Variante 1 – Doppeltor:** Rundbogen-Portal mit zweitem, geschlossenem Tor darin.
  - **Variante 2 – Kammer:** Schleusenkammer von oben, versetzte Öffnungen, Projekt als Block.
  - **Variante 3 – Schiebetore:** Block aus zwei verschobenen Torflügeln, der Spalt ist der Durchgang.
- Eingebaut (weil der Auftrag es verlangt): **Variante 1**, gewählt nur nach der Nummer, nicht nach
  Vorzug. Eingebaut als Favicon (`packages/web/index.html`) und auf der Anmeldeseite anstelle des
  bisherigen Zeichens (dunkles Quadrat mit Pfeil); `components/Logo.tsx`. In der Seitenleiste ist
  **nichts** geändert – dort ist das dunkle Quadrat zugleich der Knopf zum Einklappen.
- Frage 1: Welche Variante soll es sein (1, 2, 3 oder keine davon)?
- Frage 2: Wo soll die Marke stehen?
  - (a) nur Favicon und Anmeldeseite (wie jetzt);
  - (b) zusätzlich in der Seitenleiste vor «Airlock», Einklappen bleibt das Quadrat daneben;
  - (c) in der Seitenleiste **statt** des Quadrats, Einklappen wandert an eine andere Stelle.

---

## Frage 7 – B, Etappe 1: Header-Themen, die nur ZAP meldet

- Fakten: «Header-Themen kommen nur aus dem Header-Check, ZAP-Regeln dazu werden unterdrückt.»
  Unterdrückt sind jetzt alle ZAP-Regeln, die der eigene Header-Check auch prüft
  (`ZAP_COVERED_BY_HEADERS` in `packages/api/src/security/headers.ts`, neu dazu 10040 «gemischte
  Inhalte»). Einige ZAP-Regeln betreffen ebenfalls Header, der eigene Check prüft sie aber **nicht**:
  10063 «Permissions Policy Header Not Set», 10055 «CSP»-Qualität (z. B. `unsafe-inline`,
  Wildcards), 10098 «Cross-Domain Misconfiguration» (CORS), 10061 «X-AspNet-Version»,
  10039 «X-Backend-Server». Diese bleiben heute als ZAP-Befunde stehen (Test
  `security.test.ts` erwartet «Permissions Policy» ausdrücklich).
- Frage: Was soll mit diesen Header-Themen geschehen?
- Optionen:
  - (a) So lassen: ZAP meldet sie weiter (Header-Themen kommen dann nicht *nur* aus dem
    Header-Check).
  - (b) Den Header-Check um diese Themen erweitern und die ZAP-Regeln unterdrücken (mehr Arbeit;
    gleiche Befunde, aber eine Quelle, mit «Header setzen»-Weg für Permissions-Policy).
  - (c) Die ZAP-Regeln einfach unterdrücken (die Themen verschwinden ganz aus dem Bericht).

---

## Frage 8 – B, Etappe 2: Wo lassen sich Port, Healthcheck-Pfad und RAM-Grenze ändern?

- Fakten: Port, Healthcheck-Pfad, CPU- und RAM-Grenze werden beim Anlegen gesetzt
  (`packages/web/src/pages/NewProject.tsx`). Danach gibt es in der Oberfläche **keine** Stelle, um
  sie zu ändern; die API kann es (`PATCH /projects/:id`, `updateProjectSchema` in
  `packages/shared/src/index.ts`), das MCP nicht. Die alte Fehlerbox verwies mit «Einstellungen
  ändern» auf die Einstellungen, wo diese Felder fehlen.
  Umgesetzt (Etappe 2): Die Fehlerbox ändert den Wert direkt – «Port ändern auf 3000» in einem
  Schritt (Wert aus dem Log), «Grenze erhöhen» und «Healthcheck-Pfad ändern» mit einem kleinen
  Eingabefeld (vorbelegt mit dem aktuellen Wert, kein vorgeschlagener neuer Wert). Ohne Fehler
  bleiben die Werte weiter nur über die API änderbar.
- Frage: Sollen diese Werte auch ohne Fehler in der Oberfläche änderbar sein, und wo?
- Optionen:
  - (a) So lassen: nur aus der Fehlerbox heraus (und per API).
  - (b) Neuer Abschnitt «Container» in den Einstellungen (Port, Healthcheck-Pfad, CPU, RAM);
    die Fehlerbox könnte dann statt des Eingabefelds dorthin springen.
  - (c) In den «Eckdaten» der Übersicht bearbeitbar machen (dort stehen die Werte schon).
  - Dazu: Soll «Grenze erhöhen» einen neuen Wert vorschlagen (z. B. das Doppelte), oder wie jetzt
    nur den aktuellen zeigen?

---

## Frage 9 – B, Etappe 6: Wo gehören die Tokens hin?

- Fakten: Die Aufgabe nennt für die Seitenleiste genau «Projekte, Security, Audit, System» und
  verlegt Domains und Externe Ziele – Tokens werden nicht erwähnt. Umgesetzt ist die Leiste mit
  den vier Einträgen; die Seite `/tokens` bleibt und ist erreichbar über Konto («verwalten»), die
  Befehlspalette (⌘K «Tokens») und die Anleitung «Per Chat» (Neues Projekt, Projektliste). Die
  Brotkrumen zeigen sie provisorisch als «Airlock › Konto › Tokens».
- Frage: Wo sollen die Tokens fest stehen?
- Optionen:
  - (a) Unter Konto (wie jetzt über «verwalten»; Brotkrumen passen schon).
  - (b) Als Reiter unter System («System › Tokens»), neben GitHub und Benachrichtigungen.
  - (c) Wieder als fünfter Eintrag in der Seitenleiste (weicht von «nur vier» ab).

---

## Frage 10 – B, Etappe 8: Löschen – Kurzname oder Anzeigename eintippen?

- Fakten: «Projekt löschen nur nach Eintippen des Namens.» Schon vor diesem Milestone verlangt die
  Gefahrenzone das Eintippen des **Kurznamens** (z.B. `fotoalbum`, Feld «Kurzname zur
  Bestätigung», `ProjectSettings.tsx`, `DangerZone`). Der **Anzeigename** wäre z.B. «Fotoalbum».
  Geändert habe ich nichts.
- Frage: Welcher Name soll zur Bestätigung eingetippt werden?
- Optionen:
  - (a) Kurzname wie jetzt (eindeutig, ohne Gross-/Kleinschreibung und Umlaute).
  - (b) Anzeigename (so, wie er im Kopf steht; mit Leerzeichen und Umlauten).
  - (c) Beides akzeptieren.

---

## Frage 11 – B, Etappe 8: Welche Ereignisse gehören in die Glocke?

- Fakten: «Glocke im Kopf mit ungelesenen Ereignissen.» Umgesetzt ist vorläufig: Ereignisse aus dem
  Audit-Log, die **nicht** du selbst in der Oberfläche ausgelöst hast (Claude über MCP, Airlock
  selbst, Auto-Deploy) **oder** die gescheitert sind; ohne reine Lesezugriffe, Anmeldungen und
  Einstellungen der Oberfläche (`components/Bell.tsx`, `isBellEvent`). «Gelesen bis» wird auf dem
  Server gespeichert (gilt auf jedem Gerät, ohne Audit-Eintrag). Höchstens 8 in der Liste.
- Frage: Welche Ereignisse sollen in die Glocke?
- Optionen:
  - (a) So lassen (alles von anderen als dir, plus alles Gescheiterte).
  - (b) Nur die Ereignisse, für die es Benachrichtigungen gibt (Deploy gescheitert, neuer
    kritischer/hoher Befund, öffentlich geschaltet, externes Ziel verloren, Infrastruktur, Ablauf).
  - (c) Alles aus dem Audit-Log ausser Lesezugriffen (auch deine eigenen Aktionen).

---

## Frage 2 – A, Ausgangslage: `main` in die UI-Branches holen?

- Fakten: `ui-grundlagen` zweigt von `ef34124` (ui-projektseite) ab. `main` hat seither `7cf4f5a`
  (Gateway-Warnung, Kennung «airlock-probe»). Berührte Dateien u. a. `packages/web/src/pages/System.tsx`,
  `packages/shared/src/index.ts`, mehrere API-Dateien.
- Frage: Soll `main` vor dem Zusammenführen in `ui-grundlagen` (und `ui-qualitaet`) gemergt werden,
  oder erst beim Merge nach `main` zusammenkommen?
- Optionen:
  - (a) Jetzt `main` in die UI-Branches mergen: Branches enthalten die Gateway-Warnung; ein
    Merge-Commit mehr in jedem Branch; Konflikte (falls welche) werden im Branch gelöst.
  - (b) Nicht mergen: Branches bleiben, wie sie sind; Zusammenführung erst beim Merge nach `main`,
    Konflikte dann dort.

---

## Frage 12 – B, Etappe 8: Zurück-Knopf des Browsers bei ungespeicherten Änderungen

- Fakten: Die Rückfrage «Änderungen verwerfen?» kommt bei Links der Oberfläche, Reiterwechsel,
  Tastenkürzeln (`g p` …), Befehlspalette, Aktionen in Toasts und beim Abmelden; Neu laden und Tab
  schliessen fragt der Browser. Der **Zurück-Knopf des Browsers** wird nicht abgefangen: die App
  nutzt `BrowserRouter` (`packages/web/src/main.tsx`), dort gibt es keinen `useBlocker`
  (`lib/unsaved.ts`, `components/LeaveGuard.tsx`).
- Frage: Soll auch der Zurück-Knopf fragen?
- Optionen:
  - (a) Nein, so lassen.
  - (b) Ja, Umstieg auf den Daten-Router (`createBrowserRouter` + `useBlocker`); betrifft den Aufbau
    der Routen in `App.tsx`/`main.tsx`.
  - (c) Ja, ohne Umstieg: `popstate` abfangen und den alten Eintrag wieder in den Verlauf legen
    (kleiner Eingriff, aber ein Behelf; der Verlauf bekommt dabei einen zusätzlichen Eintrag).

---

## Frage 13 – B, Etappe 8: Passwort-Formular mit Rückfrage beim Verlassen?

- Fakten: Angeschlossen an die Rückfrage sind jetzt Umgebungsvariablen, Pause-Seite, neue
  öffentliche Adresse, Ablauf von Chat-Projekten, Benachrichtigungen und das noch nicht kopierte
  neue Token. **Nicht** angeschlossen: «Passwort ändern» unter Konto (`pages/Account.tsx`). Das
  Gutachten zählt es zu den fehlenden Formularen; im Auftrag stehen «Pause-Editor,
  Umgebungsvariablen, Einstellungen».
- Frage: Soll ein angefangenes Passwort-Formular beim Verlassen nachfragen?
- Optionen:
  - (a) Nein (eingetippte Passwörter gehen verloren, das ist gewollt).
  - (b) Ja, wie die anderen Formulare.

---

## Frage 14 – B, Etappe 8: Befehl für Claude Code mit `--scope user`?

- Fakten: Der kopierbare Befehl auf der Tokens-Seite lautet
  `claude mcp add --transport http airlock <url>/mcp --header "Authorization: Bearer …"`
  (`pages/Tokens.tsx`). Ohne `--scope` gilt der Eintrag nur im aktuellen Ordner (Bereich «local»).
  Das Gutachten schlägt `--scope user` vor (gilt in allen Ordnern) und weist darauf hin, dass das
  Token so in der Shell-History landet.
- Frage: Welcher Bereich soll im Befehl stehen, und soll ein Hinweis zur History dazu?
- Optionen:
  - (a) So lassen (nur aktueller Ordner, kein Hinweis).
  - (b) `--scope user` (überall), kein Hinweis.
  - (c) `--scope user` und ein kurzer Hinweis zur Shell-History.
  - (d) Wahl zwischen «nur dieser Ordner» und «überall» neben dem Befehl.

---

## Frage 15 – B, Etappe 8: Ausweg im Dialog «Sitzung abgelaufen»?

- Fakten: Der Dialog lässt sich nicht schliessen (Esc und Klick daneben tun nichts); einziger Weg
  ist die Anmeldung (`components/SessionDialog.tsx`). Das Gutachten merkt an, dass es keinen
  Ausweg gibt (z.B. zur Anmeldeseite oder Abmelden).
- Frage: Soll der Dialog einen zweiten Weg bekommen?
- Optionen:
  - (a) Nein, so lassen.
  - (b) Link «Zur Anmeldeseite» (verwirft die Seite und alle Eingaben).
  - (c) Knopf «Abmelden» (wie im Profil-Menü).

---

## Frage 16 – B, Etappe 8: Aktionen, die am Ablauf der Sitzung gescheitert sind

- Fakten: Scheitert eine Aktion (Speichern, Deploy …) an einer abgelaufenen Sitzung, kommt kein
  Toast mehr (der lag hinter dem Dialog); der Dialog nennt sie stattdessen («Wegen der abgelaufenen
  Sitzung: Variablen nicht gespeichert. Nach der Anmeldung bitte noch einmal auslösen.»,
  `lib/feedback.ts`, `lib/session.ts`, `pages/Login.tsx`). Nach der Anmeldung wird nichts von selbst
  wiederholt.
- Frage: Soll nach der Anmeldung mehr passieren?
- Optionen:
  - (a) So lassen (nennen, selbst noch einmal auslösen).
  - (b) Knopf «Erneut ausführen» nach der Anmeldung, nur für Aktionen, die nicht zerstörerisch sind
    (die schon heute «Erneut versuchen» anbieten dürfen).
  - (c) Nach der Anmeldung automatisch wiederholen (nicht zerstörerische Aktionen).

---
