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
| 4 | Logs: Werkzeugleiste, Zeiten, Compose-Dienste, Zugriffe im gleichen Muster | erledigt |
| 5 | Neues Projekt: Validierung, Vorschau der Adresse, «Per Chat», Deploy-Fortschritt | erledigt |
| 6 | Informationsarchitektur: Seitenleiste, Weiterleitungen, Badges, Cloudflare-Zusammenfassung, Breadcrumbs | erledigt; fester Ort für Tokens offen, Frage Nr. 9 |
| 7 | Schweregrade und Farbregeln, Schriftskala (nichts unter 12 px) | erledigt |
| 8 | Sitzung, ungespeicherte Änderungen, Löschen mit Namen, Token-Befehle, Benachrichtigungen | erledigt; Löschname offen (Frage 10), Auswahl der Glocke offen (Frage 11) |

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

Befunde aus dem Gutachten (behoben):
- Herunterfahren hing, solange ein Tab offen war (Fastify schliesst nur ruhende Verbindungen):
  alle SSE-Antworten melden sich an (`trackStream`), `preClose` schliesst sie (Test).
- Verbindungslimit von HTTP/1.1 (6 je Server): ein versteckter Tab schliesst den Strom nach 10 s
  und verbindet beim Zurückkommen neu (holt dann Verpasstes nach); versteckt wird auch nicht neu
  verbunden.
- Kein «alles neu laden» mehr: reine Lesezugriffe (MCP get_/list_/read_, Anmeldung) erzeugen kein
  Ereignis; Audit-Ereignisse laden gezielt nach Ziel (Projekt, Token, externes Ziel, System);
  Deploy-Ereignisse tragen die Projekt-ID; Scan-Stufen laden nur die Scan-Ansicht, Start/Ende auch
  Liste und Warteschlange; Nachladen gebündelt (300 ms); im versteckten Tab nur als veraltet
  markiert. Kein doppeltes Laden beim ersten Verbinden; nach Verbindungsverlust erst nach 5 s und
  nur beim Wechsel verbunden → getrennt.
- Log-Stufe der Ströme wirkte nicht (nach writeHead kennt Node den Content-Type nicht): erkannt am
  Routenmuster (`isStreamRoute`, Test); der Ereignisstrom loggt gar nicht (hijack).
- Cloudflare-Status (Tunnel, Zertifikatsprobe – Messwerte ohne Ereignis) auch mit Strom einmal pro
  Minute; Fortschritt von «Öffentlich» als Ereignis je Schritt (auch für andere Tabs und Claude).
- Abmelden schliesst nur Ströme derselben Sitzung (andere Geräte bleiben verbunden).
- Titel: Vorgang eines anderen Projekts mit Namen («Deploy Rezepte-API läuft · Fotoalbum · …»);
  beim Seitenwechsel kein kurzes «Airlock». Titeltest mit fester Erwartung und Fall ohne Punkt.
- Anfragen pro Minute danach: mit Strom 2 bzw. 3 (Server-Status, Cloudflare, Health), ohne 6 bzw. 9,
  versteckter Tab 0 (mit und ohne Strom).

### 4 – Logs
- Werkzeugleiste: Suche mit Hervorhebung, Filter nach Stufe, Live folgen/Pausieren, Zeilenumbruch,
  Herunterladen, Zeitraum (15 Min., 1 Std., 24 Std.). Ortszeit (Schweizer Format), UTC im Tooltip.
  WARN/ERROR farbig und mit Wort, Zeilennummern optional. Compose: Dienst wählen, Dienstname als
  Spalte. Statische Seiten: «Zugriffe» im gleichen Muster. Leerer Zustand statt leerem Kasten.

Umsetzung:
- Server: `GET /projects/:id/log-lines?range=15m|1h|24h&service=` liefert Zeilen mit Zeit (UTC von
  Docker, `timestamps: true`), Dienst und erkannter Stufe (`shared/logs.ts`: Wörter, logfmt, JSON/
  pino, Traceback). Compose: alle laufenden Dienste des Projekts (`domain/logs.ts`), nach Zeit
  gemischt, höchstens 2000 Zeilen. Der Live-Strom sendet dieselben Zeilen, nur neue (tail 0 – vorher
  standen bis zu 100 Zeilen doppelt), für einen oder alle Dienste.
- Zugriffe: `?range=` und neu `GET /projects/:id/access/stream` (Caddys Log live, gefiltert auf
  die Adressen des Projekts) – damit pollt auch dieser Reiter nicht mehr.
- Oberfläche: gemeinsame Werkzeugleiste (`LogTools.tsx`): Suche mit Hervorhebung, Filter (Stufe
  bzw. Statusklasse), Zeitraum, Live/Pausiert (pausiert sammeln sich neue Zeilen: «Pausiert · 3
  neu», Fortsetzen hängt sie an), Herunterladen (gefilterte Zeilen; Logs als .log, Zugriffe als
  CSV). Logs zusätzlich: Zeilenumbruch und Zeilennummern (pro Browser gemerkt), Dienst-Auswahl und
  Dienst-Spalte bei Compose. Zeit in Ortszeit (Schweizer Format), UTC im Tooltip (`fmtUtc`). WARN/
  ERROR als Wort mit Farbe und getönter Zeile. Wer hochscrollt, wird nicht ans Ende gerissen.
  Bricht der Live-Strom ab, steht es in der Kopfzeile.
- Leere Zustände: keine Ausgabe in der Zeitspanne (mit «Letzte 24 Std. zeigen»), Suche/Filter ohne
  Treffer (mit «Filter zurücksetzen»), kein Container (Hinweis).
- Neue Szenen: `logs-suche`, `logs-fehler`, `logs-leer`; Bilder `projekt-logs`, `5-zugriffe` neu.

Befunde aus dem Gutachten (behoben):
- Docker-Rahmen und Zeilen, die über zwei Stücke gehen, gingen verloren bzw. wurden zerteilt: ein
  Decoder je Strom hält Angefangenes zurück (`DockerLogDecoder`, Test mit 7-Byte-Stücken und Umlaut).
- Lücke zwischen Stand und Live-Strom: der Strom schliesst mit `?since=` an die letzte Zeile an
  (Docker liest ab dort, der Server lässt Älteres weg). Kein Neuladen beim Fokus mehr (das ersetzte
  den Stand und verlor gesammelte Zeilen); ein neuer Container (Deploy) lädt neu.
- Abbruch: Wiederverbinden mit wachsender Pause ab der letzten Zeile (`useLiveFeed`), auch bei
  «Zugriffe»; endet ein Compose-Dienst, laufen die anderen weiter; scheitert das Öffnen eines
  Dienstes, werden die schon offenen geschlossen.
- Auto-Scroll auch bei 2000 Zeilen (hängt an der letzten Zeile, nicht an der Anzahl); feste
  Zeilennummern als Schlüssel; neue Zeilen gesammelt einmal pro Bild; Suchmuster einmal gebaut;
  Zeilen als memo-Komponente; Suche mit `useDeferredValue`.
- Screenreader: die Zeilenzahl wird nicht mehr bei jeder Live-Zeile angesagt, nur das Ergebnis von
  Suche/Filter und ein Abbruch. Knopf heisst fest «Live folgen» (aria-pressed), «Pausiert · n neu»
  steht daneben. Gruppe statt «toolbar» (keine Pfeiltasten-Navigation gebaut).
- Deutsch: «aus der letzten Stunde», «Keine Ausgabe in den letzten 24 Stunden» statt «letzte 1
  Std.»; eigener leerer Zustand für einen verschwundenen Dienst und für «kein Container».
- Zugriffe: zeitliche Reihenfolge innerhalb eines Stücks; Stand bis 2000 statt still 500 («die
  neuesten 2000», wenn gekürzt); CSV gegen Formeln abgesichert (= + - @).
- Dienstname mit vollem Namen als Tooltip; «Herunterladen» mit Hinweis auf gefilterte Zeilen.

### 5 – Neues Projekt
- Validierung erst beim Verlassen eines Feldes bzw. beim Absenden. Platzhalter und Fehlermeldung mit
  gleichen Beispielen. Vorschau unter dem Namen (Slug, Adressen) mit Kollisionsprüfung. Fünfte
  Quelle «Per Chat» mit Anleitung und Link zu Tokens. Nach dem Anlegen zur Projektseite mit
  laufendem Deploy-Fortschritt.

Umsetzung:
- Prüfung beim Verlassen eines Felds, sobald darin getippt wurde (nicht beim blossen Durchtabben,
  nicht während des Tippens), und beim Absenden alles (`lib/form.ts`, gilt für alle Formulare).
- Gleiche Beispiele: Platzhalter, Hinweis und Fehlermeldung nennen dasselbe (Name «Solarertrag
  heute», Image «nginx:alpine», Repo «https://github.com/user/app.git» …); die Quelle «Fertiges
  Image» nennt ebenfalls nginx:alpine.
- Vorschau unter dem Namen: Kurzname und Adresse vom Server (`GET /projects/name-preview`, gleiche
  Regeln wie beim Anlegen); ist der Kurzname belegt oder reserviert, steht es mit Link zum Projekt
  da und welcher Kurzname stattdessen entsteht («fotoalbum-2»).
- Fünfte Quelle «Per Chat»: Anleitung (dieselbe wie im Dialog der Projektliste, `ChatSteps`) und
  «Token anlegen» statt Formular.
- Nach «Anlegen und deployen» zeigt die Projektseite gleich den Fortschritt des ersten Deploys.
- Szenen: `neues-projekt-vorschau` (Kollision, Meldung beim Verlassen), `neues-projekt-chat`.

Befunde aus dem Gutachten (behoben):
- Der Fortschritt nach dem Anlegen kam nach Neuladen oder «Zurück» wieder (Router-Zustand im
  Verlauf): wird nach dem Lesen entfernt. Beim ersten Deploy heisst es nicht mehr «die vorherige
  Fassung läuft weiter», sondern «Es läuft noch keine Fassung». Der Fortschritt verbindet nicht mehr
  bei jedem Rendern neu.
- Prüfung beim Verlassen nicht, wenn der Fokus auf einen Knopf geht (die Meldung verschob sonst
  den Knopf zwischen Drücken und Loslassen; Absenden prüft ohnehin alles).
- Pfadfelder mit eigenen Beispielen in der Meldung (Dockerfile, Build-Kontext «.», compose.yaml,
  Ausgabeordner «dist») statt einer Meldung für alle.
- Kollision auch über belegte Adressen (eigene Subdomain eines anderen Projekts), in derselben
  Funktion für Vorschau und Anlegen; gleichzeitiges Anlegen gibt eine verständliche Meldung (409).
  «name-preview» ist als Kurzname reserviert.
- Screenreader: die Vorschau ist keine Live-Region mehr; angesagt wird nur eine Kollision. Die
  Vorschau zeigt keine Antwort zu einem alten Namen.
- «Per Chat»: kein doppelter Einleitungssatz.

### 6 – Informationsarchitektur
- Seitenleiste: Projekte, Security, Audit, System. Domains → System › Cloudflare & HTTPS, Externe
  Ziele → Reiter unter Security; `/domains` und `/extern` leiten weiter.
- Badge Security = offene kritische + hohe Befunde, mit `aria-label`/Tooltip; keine Badge bei 0.
- Cloudflare nach der Einrichtung: Statuszusammenfassung und «Einrichtung anzeigen»; übersprungene
  Schritte neutral «übersprungen». Breadcrumbs ab zweiter Ebene, echte Namen, klickbar, Wurzel
  «Airlock». «Server <name> · Version» unten in der Seitenleiste fixiert.

Umsetzung:
- Seitenleiste: Projekte, Security, Audit, System. Tokens sind nicht mehr in der Leiste, aber über
  Konto («verwalten»), die Befehlspalette und die Anleitung «Per Chat» erreichbar – wo Tokens fest
  hingehören, ist offen, Frage Nr. 9.
- Domains ist ein Abschnitt von System › Cloudflare & HTTPS (`#domains`); Externe Ziele ein Reiter
  unter Security (`/security/extern`). `/domains` und `/extern` leiten dorthin weiter, ebenso die
  Befehlspalette.
- Badge «Security»: offene kritische + hohe Befunde, Tooltip und Name sagen, was gezählt wird; bei
  0 keine Zahl.
- Cloudflare nach der Einrichtung (Token, Domains, Tunnel oder übersprungen, Zertifikat aktiv):
  Zusammenfassung mit «Einrichtung anzeigen»; ein übersprungener Tunnel ist neutral «übersprungen»
  (Strich statt Haken, kein Fehler), auch in den Schritten.
- Brotkrumen erst ab der zweiten Ebene, mit echten Namen (Projektname statt Kurzname) und
  klickbaren Vorgängern, Wurzel «Airlock» (statt des Servernamens), Trennzeichen «›».
- Fusszeile der Seitenleiste unten fixiert wie bisher (zur Zeilenaufteilung siehe Befunde).
- Szenen: `system-cloudflare-fertig` neu; `externe-ziele` und `domains` zeigen die Weiterleitungen.
  Zwei Szenen der Projekteinstellungen mit höherer Pixel-Toleranz (schwankende Kantenglättung der
  klebenden Sprungnavigation, sichtbar gleich).

Befunde aus dem Gutachten (behoben):
- Cloudflare: Umschalten Zusammenfassung ↔ Einrichtung setzt den Fokus auf das Gegenstück (nicht
  mehr auf <body>); «Token ersetzen» aus der Zusammenfassung führt nach Speichern oder Abbrechen
  dorthin zurück. Gleiches Verb: «Einrichtung anzeigen» / «Zusammenfassung anzeigen».
- Sprung zu `#domains` erst, wenn alles darüber geladen ist, mit Abstand oben.
- Badge-Text in der Einzahl («1 offener kritischer oder hoher Befund», «1 Projekt»).
- Fusszeile der Seitenleiste: «Server … · Version …» passt bei 192 px nicht in eine Zeile; jetzt
  bewusst zwei Zeilen ohne hängenden Punkt.
- Meldungen des Servers nennen den neuen Ort «System › Cloudflare & HTTPS» (Standard-Domain,
  Tailnet, HSTS, Öffentlich, Access).
- Eingeklappte Seitenleiste: Zähler 12 px statt 10 px.
- Beide Security-Reiter gleich breit.
- Tastaturtests: Reiter «Externe Ziele», Weiterleitung `/domains` mit Fokus auf «Domains»,
  Umschalten der Cloudflare-Zusammenfassung, «Token ersetzen» und zurück, Kürzel «g s».

### 7 – Schweregrade und Farbregeln
- Eigene Darstellung je Stufe (kritisch gefüllt, hoch getönt Fehlerfarbe, mittel getönt Warnfarbe,
  niedrig neutral), immer mit Wort. Farbregel dokumentiert (TEXTE.md bzw. /design). Feste
  Schriftgrössen auf die Skala, nichts unter 12 px.

Umsetzung:
- Pillen (`.sev-*`), Zähler (`.sev-chip-*`) und Zeichen der Security-Karte (`.sc-sev-*`): kritisch
  gefüllt rot mit Schrift in der Grundfarbe und fett, hoch rot getönt, mittel gelb getönt, niedrig
  neutral; das Zeichen der Karte ist gefüllt, getönt mit Rand bzw. leer. Immer mit dem Wort.
- Farbregel: `docs/TEXTE.md` (Abschnitt «Farbregel») und `/design` (Baustein «Schweregrade und
  Farbregel»). Kontrast der gefüllten Pille im Kontrast-Skript.
- Feste Schriftgrössen auf die Skala (`--fs-12` … `--fs-24`): Marke 22→24, Note 17/20→18/24,
  Kartentitel und Fehlertitel 17→18, Log und Code 12,5→13, alles unter 12 (10/11 px: Diagramm-Fuss,
  Avatar, Ring, Tag, Hinweispunkt) → 12. `.version` (0,92 em) nie unter 12 px.
- Neuer Test `visual/schrift.spec.ts`: in allen Szenen kein sichtbarer Text unter 12 px.

Befunde aus dem Gutachten (behoben):
- «hoch» war an fünf Stellen gelb (Kennzahl der Projektliste und der Security-Seite, Zähler der
  Seitenleiste ohne kritische, Hinweis «hohe Befunde», Zähler des Reiters Security): jetzt rot wie
  die Regel sagt. Kritisch und hoch unterscheiden sich in der Form: Kennzahl Punkt gefüllt bzw.
  Ring, Zähler gefüllt bzw. getönt; der Reiter-Zähler nimmt die Form der schwersten Stufe an.
- Projektkarte: «1 kritisch» / «2 hoch» als kleine Pille der Stufe; Stufenliste: kritisch fett.
- Zeichen der Security-Karte in vier Formen (Quadrat gefüllt / mit Rand, Kreis gefüllt / leer);
  «niedrig» mit feinem Rand, damit die Pille auf grauem Grund sichtbar bleibt.
- Sortierung «hoch» griff nie (Text «hohe Befunde»): jetzt nach Art (`kind`); Einzahl «1 kritischer
  Befund», «1 hoher Befund», «1 offener Befund».
- Security-Karte: Gruppe mit Namen statt `aria-label` auf `<p>`.
- Farbregel ergänzt (Note B blau, Formen der Zeichen, Zähler); doppelte Zeile im Kontrast-Skript weg.
- Schrifttest strenger: Grenze 12 px genau, auch ::before/::after mit Text, Formularfelder und eine
  Szene mit eingeklappter Seitenleiste.

### 8 – Sitzung und Sicherheit in der Bedienung
- 401: Login-Dialog über der Seite, danach zurück; Formulareingaben bleiben. Warnung beim Verlassen
  mit ungespeicherten Änderungen (Pause-Editor, Umgebungsvariablen, Einstellungen). Projekt löschen
  nur nach Eintippen des Namens. Tokens: fertiger Befehl zum Kopieren (Claude Code, Claude Desktop),
  Token nur einmal sichtbar. Glocke im Kopf mit ungelesenen Ereignissen, als gelesen markieren, Link.

Umsetzung:
- 401 unterwegs (oder Abmeldung in einem anderen Tab): Dialog «Sitzung abgelaufen» über der Seite
  (`SessionDialog`, `lib/session.ts`); die Seite bleibt gemountet, Eingaben bleiben; nach der
  Anmeldung lädt alles Sichtbare neu, der Fokus geht zurück. Esc schliesst nicht (ohne Anmeldung geht
  nichts). Die Anmeldeseite gibt es nur noch beim ersten Öffnen ohne Sitzung.
- Ungespeicherte Änderungen (`lib/unsaved.ts`, `LeaveGuard`): Umgebungsvariablen, Pause-Seite
  (Abbrechen, Esc, Klick daneben) und ein neues, noch nicht kopiertes Token. Rückfrage «Änderungen
  verwerfen?» bei Links der Oberfläche und beim Reiterwechsel, «Bleiben und speichern» vorgewählt;
  Neu laden/Schliessen fragt der Browser. Der Zurück-Knopf des Browsers wird nicht abgefangen
  (BrowserRouter ohne Daten-Router).
- Löschen: verlangt schon das Eintippen des Kurznamens – ob Kurzname oder Anzeigename, ist offen,
  Frage Nr. 10.
- Tokens: Token einmal sichtbar wie bisher; dazu fertig zum Kopieren für Claude Code (Befehl; ein
  fehlendes Leerzeichen vor der URL behoben) und Claude Desktop (Eintrag für
  `claude_desktop_config.json` über `mcp-remote`).
- Glocke im Kopf: ungelesene Ereignisse mit Zahl (Name des Knopfs sagt sie in Worten), Liste mit
  Ton, Zeit und Auslöser, «neu»-Markierung, «Alle als gelesen markieren» (auf dem Server, ohne
  Audit-Eintrag), Link je Ereignis und «Alle im Audit-Log». Welche Ereignisse hineingehören: offen,
  Frage Nr. 11.
- Szenen: `glocke`, `sitzung-abgelaufen`, `verlassen-rueckfrage`, `tokens-neu`.

Befunde aus dem Gutachten (behoben):
- «Gelesen bis» der Glocke ging beim Lesen verloren (nach jedem Neuladen alles wieder ungelesen);
  jetzt mitgelesen, auf dem Server nie in der Zukunft, gesetzt auf die Zeit des neuesten Ereignisses
  (Uhr des Servers); scheitert das Speichern, kommt der alte Stand zurück, mit Fehlermeldung.
  Gezählt wird über alle geladenen Ereignisse (vorher höchstens 8, «9+» kam nie).
- Bewusstes Abmelden zeigte «Sitzung abgelaufen»: jetzt die Anmeldeseite; vorher Rückfrage, wenn
  etwas ungespeichert ist.
- An der abgelaufenen Sitzung gescheiterte Aktionen: kein Toast hinter dem Dialog mehr, der Dialog
  nennt sie («Variablen nicht gespeichert …»). Ob nach der Anmeldung mehr passieren soll: offen,
  Frage Nr. 16. Neue Szene `sitzung-abgelaufen-aktion`.
- 401 auf `/auth/preferences`, `/auth/password` und `/auth/logout` öffnet jetzt auch den Dialog
  (ausgenommen nur Anmeldung und `/auth/me`).
- Schliesst der Browser einen Dialog trotz `preventDefault` (zweites Esc): Sitzungsdialog öffnet
  wieder, Rückfrage gilt als «Bleiben», Pause-Editor fragt statt still zu verwerfen.
- Rückfrage auch bei Tastenkürzeln, Befehlspalette, Aktionen in Toasts und Abmelden
  (`useGuardedNavigate`); dazu angeschlossen: neue öffentliche Adresse, Ablauf von Chat-Projekten,
  Benachrichtigungen. Zurück-Knopf des Browsers: offen, Frage Nr. 12. Passwort-Formular: offen,
  Frage Nr. 13.
- Reiterwechsel: «Löschen» und «Variable hinzufügen» merken sich ihr Ziel nur, wenn der Wechsel
  stattfindet; Pfeiltasten fokussieren nur den gewählten Reiter; nach gestartetem Deploy/Rollback
  wechselt die Seite nur zur Übersicht, wenn nichts ungespeichert ist (keine Rückfrage aus dem Nichts).
- Texte der Rückfrage: «Weiter bearbeiten» statt «Bleiben und speichern»; für das nicht kopierte
  Token eigener Text («… ist noch nicht kopiert und wird nicht noch einmal angezeigt», «Trotzdem
  weiter»). Links im Glocken-Menü schliessen das Menü wieder (kein `stopPropagation` mehr).
- Glocke: nach «Alle als gelesen markieren» geht der Fokus zurück auf die Glocke; Stand im Namen
  des Menüs, Leerzustand als gesperrter Eintrag.
- Tokens: Codeblöcke als benannte Gruppe; Claude-Desktop-Eintrag mit Kopfzeile über `env`
  (Leerzeichen in `args` zerteilen das Argument unter Windows); Abstand zwischen Eingabezeile und
  Banner. `--scope` im Befehl für Claude Code: offen, Frage Nr. 14.
- Sitzungsdialog: Überschrift `h2` statt zweiter `h1`. Ausweg aus dem Dialog: offen, Frage Nr. 15.
