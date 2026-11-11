# Milestone «UI-Qualität»

Branch `ui-qualitaet`, abgezweigt vom letzten Commit von `ui-grundlagen` (`602b2e1`, Milestone
«UI-Grundlagen», noch nicht in `main`). Ein Commit pro Etappe. Nicht gemergt, nicht gepusht.

Hell und Dunkel, nur Desktop (1440 px). Nach jeder Etappe: Typecheck, alle Tests, Build,
`pnpm test:visual` (inklusive axe und Tastatur), Kontrast-Skript, Impeccable als Gutachter.
Gewollte Bildänderungen werden mit `pnpm test:visual:update` übernommen und in der Commit-Nachricht
benannt (welche Bilder, warum).

Offene Entscheidungen stehen als Fragen in `docs/FRAGEN-NACHT.md` (Hauptordner, nicht committet);
hier als «offen, Frage Nr. n» vermerkt. Was `ui-projektseite` schon gebaut hat (Reiter «Zugriffe»,
Aktivität, Deployments-Liste), wird erweitert, nicht doppelt gebaut.

## Etappen

| Nr. | Inhalt | Stand |
|---|---|---|
| 1 | Widersprüche in den Daten: ein Projektzustand vom Server, eine Befundzählung, Stufen | erledigt; Header-Themen nur in ZAP offen, Frage Nr. 7 |
| 2 | Fehler erklären: Muster aus Build-/Container-Log und Healthcheck, auch im MCP-Ergebnis | erledigt; Ändern von Port/RAM ausserhalb der Fehlerbox offen, Frage Nr. 8 |
| 3 | Seitentitel, Favicon-Punkt, Server-Sent Events statt Polling | erledigt |
| 4 | Logs: Werkzeugleiste, Zeiten, Compose-Dienste, Zugriffe im gleichen Muster | geplant |
| 5 | Neues Projekt: Validierung, Vorschau der Adresse, «Per Chat», Deploy-Fortschritt | geplant |
| 6 | Informationsarchitektur: Seitenleiste, Weiterleitungen, Badges, Cloudflare-Zusammenfassung, Breadcrumbs | geplant |
| 7 | Schweregrade und Farbregeln, Schriftskala (nichts unter 12 px) | geplant |
| 8 | Sitzung, ungespeicherte Änderungen, Löschen mit Namen, Token-Befehle, Benachrichtigungen | geplant |

## Abnahmekriterien

### 1 – Widersprüche in den Daten
- Der Server liefert einen fertig berechneten Projektzustand: läuft · neue Version gescheitert,
  alte läuft weiter · gestoppt · pausiert · deployt gerade · nichts läuft. Pille, Unterzeile,
  Fehlerbox und Deployments-Liste verwenden nur diesen.
- Gescheiterte Deployments stehen in der Liste an ihrer zeitlichen Stelle, auch das neueste.
- Eine Funktion zählt «offene» Befunde (ohne akzeptierte und behobene); überall dieselbe Zahl
  (Kopf, Zähler-Pillen, Reiter-Badge, Seitenleiste, Projektkarte); ein Test vergleicht die Stellen.
- Header-Themen nur aus dem Header-Check; ZAP-Regeln dazu werden unterdrückt
  (`ZAP_COVERED_BY_HEADERS` konsequent). Stufen-Anzeige und Befundliste stimmen überein.
- Stufennamen einheitlich: «Abhängigkeiten & Image (Trivy)», «Eigener Code», «Security-Header»,
  «Webseite passiv (ZAP)», «Offene Dateien & Panels (Nuclei)», «TLS» – mit korrektem Grund beim
  Überspringen. Fixtures der Screenshots in sich stimmig.

Umsetzung:
- `projectState()` in `packages/shared` (getestet, `project-state.test.ts`): Reihenfolge deployt
  gerade → gestoppt → nichts läuft (keine aktive Fassung, Container fehlt/beendet) → pausiert
  (öffentlich pausiert – die einzige Pause, die Airlock kennt) → neue Version gescheitert, alte
  läuft weiter → läuft. Jeder Zustand mit Wort, Ton und Unterzeile (z. B. der Grund des
  gescheiterten Deploys). Der Server liefert ihn als `ProjectDto.state`; den Containerzustand merkt
  sich der Monitor je Runde (`containerSnapshot`), `toDto` fragt Docker nicht.
- Oberfläche: Pille (Karte, Projektkopf), Unterzeile der Karte, Fehlerbox und «Container läuft
  nicht» der Übersicht, Kennzahlen, Filter «Laufen», Hinweise und Befehlspalette lesen nur noch
  `p.state` (`runtimeStatus` und die Gesundheits-Überschreibung im Projektkopf sind weg; die
  Gesundheitsabfrage liefert nur noch Einzelheiten wie den Exit-Code).
- Deployments-Liste: war schon zeitlich sortiert (gescheiterte werden nie zusammengefasst); die
  Fixtures führten den neuesten gescheiterten Deploy der Wetterstation aber nicht in der Liste –
  jetzt steht er oben.
- Befunde: `countOpenFindings`, `openTotal`, `openUrgent`, `sumCounts` in `shared`; Server
  (Projektübersicht und Scan-Bericht) und alle Stellen der Oberfläche nutzen sie.
  `visual/konsistenz.spec.ts` vergleicht in der fertigen Oberfläche: Reiter-Badge = Summe der
  Zähler-Pillen, Projektkarte nennt dieselbe kritische/hohe Zahl, Seitenleiste = kritisch + hoch der
  Security-Seite, Pille der Karte = Pille im Kopf. Die Fixtures waren genau so widersprüchlich
  (Kurzform am Projekt und Bericht kopiert statt gezählt, Stufenzahlen fest) – jetzt gezählt.
- ZAP: Regel 10040 (gemischte Inhalte) zusätzlich unterdrückt, weil der Header-Check sie prüft
  (Test). Header-Themen, die nur ZAP meldet: offen, Frage Nr. 7.
- Stufennamen einheitlich aus `shared` (`SCAN_STAGE_LABEL`) in Reiter, Security-Karte, Fortschritt
  und MCP; «Webseite aktiv (ZAP)» für den aktiven Scan nach dem Muster der passiven Stufe. Gründe
  beim Überspringen geprüft (Image/Quellcode/TLS) – stimmten.
- Bekannte Grenze: Befunde tragen nur das Werkzeug, nicht die Stufe. Laufen zwei Trivy-Stufen
  (Image und eigener Code) mit Befunden, zählt jede alle offenen Trivy-Befunde.

Befunde aus dem Gutachten (behoben):
- Reihenfolge in `projectState`: «keine aktive Fassung» kommt vor «gestoppt»; ein neues Projekt,
  dessen erster Deploy scheiterte, heisst «nichts läuft» mit Grund (Test).
- Nach einem Neustart von Airlock hängende Deploys (pending … healthchecking) werden als gescheitert
  markiert («Abgebrochen durch Neustart von Airlock») und der Projektstatus zurückgesetzt
  (`abandonUnfinishedDeploys` in `reconcileOnBoot`), sonst blieb «deployt gerade» für immer.
- Der gemerkte Containerzustand wird nach Start, Stopp und erfolgreichem Deploy vergessen
  (`forgetContainer`), damit der Zustand nicht bis zur nächsten Monitor-Runde veraltet.
- MCP `list_projects`/`get_project` liefern `state`, `state_label`, `state_detail`.
- Eine Definition «Deploy gescheitert» (`deployFailedState`) für Liste, Filter, Hinweise und
  Fehlerbox; Kennzahl «laufen» und Filter «Laufen» zählen gleich (läuft oder pausiert; gescheiterte
  stehen unter «Brauchen Aufmerksamkeit») – zusätzlicher Test in `konsistenz.spec.ts`.
- Lange Zustands-Pille bricht in der Karte um statt den Namen zu verdrängen.
- Fixture Wetterstation: Security-Werte passend zu den Befunden (94, A, 2 niedrig).

### 2 – Fehler erklären
- Erkannte Muster mit Klartext und Aktion: fehlende Umgebungsvariable → «Variable X fehlt» +
  «Hinzufügen»; anderer Port (Log «listening on :3000») → «Port ändern auf 3000»; Container beendet
  (Exit-Code) → Code und letzte Zeilen; npm/pip-Build-Fehler → Build-Log + «Mit Claude lösen»; Image
  nicht gefunden/Pull verweigert; OOMKilled → «Grenze erhöhen». Unbekannt: letzte Zeilen + «Mit
  Claude lösen». Gleiche Erklärung im MCP-Ergebnis von `deploy`. Tests mit Log-Fixtures je Muster.

Umsetzung:
- Eine Funktion `explainFailure` in `packages/shared/src/failure.ts` (Fehlermeldung + Deploy-Log →
  Art, Titel, Satz, Aktion, massgebliche Zeilen). Die Oberfläche (Fehlerbox) und der Server
  (`api/src/deploy/explain.ts`) rufen sie mit denselben Angaben auf. Die alte
  `web/src/lib/failure.ts` ist weg.
- Die Pipeline schreibt nach gescheitertem Healthcheck «Container beendet: Exit-Code n» und
  «OOMKilled» ins Log (`noteExit`, `inspectContainer` liefert jetzt `oomKilled`), die letzte
  Container-Ausgabe stand schon drin.
- Muster und Aktion: Variable fehlt (Node, Python-KeyError, envalid-Liste; gesetzte, aber abgelehnte
  Variable heisst «… wird nicht akzeptiert») → «Hinzufügen» springt in die Einstellungen, die Zeile ist
  vorbelegt, der Fokus liegt auf dem Wert. Anderer Port im Log → «Port ändern auf 3000» (ein Schritt).
  Nur 127.0.0.1 → Erklärung + Claude. Container beendet → Exit-Code im Titel, letzte Zeilen.
  OOMKilled → «Grenze erhöhen» (Eingabefeld). npm-/pip-Build → Meldung im Satz, Build-Log, «Mit
  Claude lösen». Image nicht gefunden / verweigert → «Image ändern» (bei Image-Quellen). Healthcheck
  4xx → «Healthcheck-Pfad ändern». Unbekannt → letzte Zeilen + «Mit Claude lösen» (fertiger Auftrag
  zum Kopieren, `deployFixPrompt`). Port/Pfad/RAM sind sonst in der Oberfläche nicht änderbar:
  offen, Frage Nr. 8.
- MCP: `deploy`, `create_project`, `update_files` usw. liefern bei Fehlschlag
  `explanation {kind, title, cause, next_step, lines}`.
- Gleicher Titel überall: `DeploymentDto.failure` (Server, `withFailure`) – Unterzeile der Pille,
  Banner der Projektliste, Deployments-Liste und Meldung nach dem Deploy zeigen ihn statt der rohen
  Meldung.
- Tests: `api/src/deploy/failure.test.ts` mit 13 Log-Fixtures (`deploy/fixtures/failure/`), dazu
  ein Zustandstest. Screenshots je Muster: `fehler-build-claude`, `fehler-port`, `fehler-speicher`.

Befunde aus dem Gutachten (behoben):
- Erkennung enger: npm/pip nur aus der Build-Phase (ein abstürzendes `npm start` ist kein
  Build-Fehler); Image-Fehler nur aus der Fehlermeldung, nie aus der App-Ausgabe; bei Dockerfile/
  Compose heisst es «Basis-Image» mit Claude statt «Image ändern»; Port: keine Uhrzeiten, keine
  Verbindungen zu Redis/DB, «listen» hat Vorrang; Variable: von unten, Warnungen («defaulting»)
  zählen nicht, KeyError nur mit `os.environ`/`getenv` davor, keine Build-Zeilen; Richtlinie nur
  über den Fehlercode `policy_violation`; kein doppelter Punkt. Negativ-Tests dazu (24 Tests).
- Die Erklärung wird beim Scheitern am Deployment festgehalten (Migration 0017, Spalte `failure`,
  `recordFailure`): mit Variablen und Port *dieses* Deploys. Nach «Hinzufügen» oder «Port ändern»
  bleibt der Titel, die Box sagt «… ist jetzt gesetzt. Wirksam beim nächsten Deploy.» und
  «Erneut deployen» wird Hauptknopf. Die Projektliste liest keine Logs mehr; ältere Deployments
  werden beim ersten Lesen erklärt und nachgetragen. Kein Wechsel des Titels während das Log lädt.
- Audit und Push-Meldung: «Titel (rohe Meldung)», damit die Aktivität dasselbe sagt.
- Barrierefreiheit: kein `role="alert"` auf der ganzen Box (die Seite meldet das Ende des Deploys
  schon); «Letzte Zeile»/«Letzte n Zeilen»; Knopf «SENSOR_URL hinzufügen»; Logzeilen und Auftrag als
  Region mit Namen und per Tastatur scrollbar; `aria-controls` nur bei offenem Feld; kein
  Fehler-Aufblitzen beim Klick auf «Abbrechen». «Container läuft nicht» nutzt dieselben Worte
  (`envTexts`).
- Zahlenfelder (RAM, Port) leer mit «Aktuell 512 MB» als Hinweis statt vorbelegt (kein
  Vorschlag – Frage Nr. 8). Claude-Funke auf dem Hauptknopf in Schriftfarbe (Kontrast); Vorschau
  des Auftrags begrenzt.

### 3 – Seitentitel und Live-Aktualisierung
- `document.title` «<Seite/Projekt> · Airlock», bei laufendem Vorgang mit Präfix; Favicon mit Punkt
  bei gescheitertem Deploy/kritischem Befund.
- Ein SSE-Strom `/api/v1/events` (an die Sitzung gebunden) für Projekt-, Deploy-, Scan-, Audit-,
  Zertifikats- und Öffentlich-Ereignisse; die Oberfläche invalidiert gezielt. Polling nur noch als
  Rückfall (60 s), pausiert bei verstecktem Tab. Anfragen pro Minute vorher/nachher hier notiert.
  Polling und Heartbeats nicht auf info loggen.

Umsetzung:
- Tab-Titel «<Seite/Projekt> · Airlock» (Seiten melden ihren Namen über `PageHead`, die Projektseite
  den Projektnamen); laufende Vorgänge als Präfix: «Deploy läuft · …», «Scan läuft · …»,
  «Zertifikat wird geholt · …», bei mehreren «2 Vorgänge laufen · …» (`lib/title.ts`).
- Favicon mit Punkt (hell/dunkel), solange ein Deploy gescheitert oder ein kritischer Befund offen
  ist. Der Punkt ist ein Zusatz; die Seiten sagen es in Worten.
- Server: `lib/events.ts` (Bus) und `GET /api/v1/events` (`http/routes/events.ts`). Nur mit
  Anmeldung (API-Token: 403); bei jedem Herzschlag (25 s) wird die Sitzung geprüft, Abmelden
  schliesst alle Ströme («session_ended»; die Oberfläche prüft dann ihre Anmeldung und verbindet
  neu, wenn sie noch gilt). Ereignisse tragen nur, *was* sich geändert hat: Deploy-Schritt und
  -Ende (journal), Scan-Stufen, -Start und -Ende, Zertifikat/Cloudflare, Container-Zustandswechsel
  (Monitor) und jeder Audit-Eintrag (fast jede Änderung, auch Öffentlich, Header, Vorschläge von
  Claude). Ströme loggen auf debug, auch wenn sie Minuten dauern; Heartbeats gar nicht.
- Oberfläche: `lib/live.ts` lädt je Ereignis gezielt nach (react-query invalidieren). Polling nur
  als Rückfall ohne Strom: 60 s (`poll`), nicht bei verstecktem Tab. Ausnahmen: Messwerte (CPU/RAM
  der Projektseite, Server-Status der Seitenleiste) einmal pro Minute auch mit Strom; Fortschritt
  von «Öffentlich» (500 ms nur während des eigenen Aufrufs); Reiter «Zugriffe» bleibt bis Etappe 4.
- Anfragen pro Minute bei offener Seite (`visual/anfragen.spec.ts`, Uhr künstlich 60 s vor):
  Projektliste vorher 42, nachher 1 (mit Strom) bzw. 6 (ohne); Projektseite vorher 59, nachher 2
  bzw. 9; versteckter Tab ohne Strom 0 Abfragen (nur Wiederverbinden des Stroms).
- Tests: `events.test.ts` (Token abgelehnt, Ereignisse, Abmelden beendet den Strom),
  `live.test.ts` (Titel, Favicon, Zuordnung Ereignis → Abfragen), `konsistenz.spec.ts` (Tab-Titel
  und Favicon in der echten Oberfläche).

### 4 – Logs
- Werkzeugleiste: Suche mit Hervorhebung, Filter nach Stufe, Live folgen/Pausieren, Zeilenumbruch,
  Herunterladen, Zeitraum (15 Min., 1 Std., 24 Std.). Ortszeit (Schweizer Format), UTC im Tooltip.
  WARN/ERROR farbig und mit Wort, Zeilennummern optional. Compose: Dienst wählen, Dienstname als
  Spalte. Statische Seiten: «Zugriffe» im gleichen Muster. Leerer Zustand statt leerem Kasten.

### 5 – Neues Projekt
- Validierung erst beim Verlassen eines Feldes bzw. beim Absenden. Platzhalter und Fehlermeldung mit
  gleichen Beispielen. Vorschau unter dem Namen (Slug, Adressen) mit Kollisionsprüfung. Fünfte
  Quelle «Per Chat» mit Anleitung und Link zu Tokens. Nach dem Anlegen zur Projektseite mit
  laufendem Deploy-Fortschritt.

### 6 – Informationsarchitektur
- Seitenleiste: Projekte, Security, Audit, System. Domains → System › Cloudflare & HTTPS, Externe
  Ziele → Reiter unter Security; `/domains` und `/extern` leiten weiter.
- Badge Security = offene kritische + hohe Befunde, mit `aria-label`/Tooltip; keine Badge bei 0.
- Cloudflare nach der Einrichtung: Statuszusammenfassung und «Einrichtung anzeigen»; übersprungene
  Schritte neutral «übersprungen». Breadcrumbs ab zweiter Ebene, echte Namen, klickbar, Wurzel
  «Airlock». «Server <name> · Version» unten in der Seitenleiste fixiert.

### 7 – Schweregrade und Farbregeln
- Eigene Darstellung je Stufe (kritisch gefüllt, hoch getönt Fehlerfarbe, mittel getönt Warnfarbe,
  niedrig neutral), immer mit Wort. Farbregel dokumentiert (TEXTE.md bzw. /design). Feste
  Schriftgrössen auf die Skala, nichts unter 12 px.

### 8 – Sitzung und Sicherheit in der Bedienung
- 401: Login-Dialog über der Seite, danach zurück; Formulareingaben bleiben. Warnung beim Verlassen
  mit ungespeicherten Änderungen (Pause-Editor, Umgebungsvariablen, Einstellungen). Projekt löschen
  nur nach Eintippen des Namens. Tokens: fertiger Befehl zum Kopieren (Claude Code, Claude Desktop),
  Token nur einmal sichtbar. Glocke im Kopf mit ungelesenen Ereignissen, als gelesen markieren, Link.
