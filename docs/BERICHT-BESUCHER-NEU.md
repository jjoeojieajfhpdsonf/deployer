# Bericht «Besucher neu» (Branch `ui-besucher`)

Basis `main` fae3303, eigener Worktree `.claude/worktrees/ui-besucher`. Nicht gepusht, nicht nach main gemergt.
Vorlage: `docs/design-cal/besucher-neu/` (liegt in main unversioniert; im Branch nur die Ergebnisbilder
`umgesetzt-*.png`).

## Commits

Siehe `git log main..ui-besucher`:

1. **Server und shared:** Zähler für Merkmale, Messbeginn, Bot-Regel, Auswertung in shared
2. **Oberfläche:** Reiter «Besucher» neu, Server › Besucher, Präferenz Fläche/Säulen, Tests, Szenen
3. **Referenzbilder, Ergebnisbilder, Doku:** SPEC, Datenschutz-Vorlage, dieser Bericht

## Punkt 9: Warum stimmten «145 Aufrufe» und die Listen nicht überein, und warum hatte «direkt» 141 Aufrufe, aber 0 Besucher?

Echte Serverdaten konnte ich nicht ansehen (kein Zugriff vorgesehen); die Ursachen folgen aus dem Code und
lassen sich mit Tests nachstellen.

**«direkt» mit vielen Aufrufen und 0 Besuchern – das war ein Fehler.** Der Referrer wurde für *jede* Anfrage
gespeichert, ein Besucher aber nur bei seiner *ersten* Anfrage des Tages gezählt. Klicks innerhalb der Seite
(Referer = Name des Projekts) landeten dabei als «direkt oder unbekannt». Wer die Seite über einen Link öffnet
(z. B. «Öffnen» in Airlock, die Statusseite, Google), zählt als Besucher beim ersten Aufruf mit *diesem*
Referrer – alle weiteren Seiten wanderten mit 0 Besuchern nach «direkt». Bei einer kleinen Seite, die man vor
allem selbst aus Airlock heraus öffnet, ist «direkt» so die grösste Quelle ohne einen einzigen Besucher.

**145 vs. Summe der Listen – mehrere Gründe:**
- «Aufrufe heute» in der Projektliste zählt ab Mitternacht, der Reiter zeigte 24 Stunden bzw. 7 Tage.
- Aufrufe enthielten alle Statuscodes (404 von Scannern und Tippfehlern, 5xx); die Liste «Seiten» zeigte
  dieselben 404-Pfade gemischt mit echten Seiten.
- Beide Listen zeigten nur die obersten 10 Einträge, dazu konnte «(weitere Pfade)» (Schutz gegen
  Pfad-Scanner) stehen.

**Behoben:**
- Klicks innerhalb der Seite heissen jetzt `(intern)` und fehlen in «Woher»; ohne Referer steht «Direkt /
  Lesezeichen». Namen von Airlock selbst (Oberfläche, Statusseiten) werden ausgeblendet und unter der Liste
  gezählt. Test: Woher + ausgeblendet = Aufrufe (`summary.test.ts`, «Punkt 9»).
- Aufrufe = nur 2xx/3xx (auch «Aufrufe heute» in der Projektliste). 404 stehen in «Nicht gefunden»,
  5xx darunter mit Link zu den Logs. Summe der Liste «Seiten» = Aufrufe (getestet).
- Besucher zählen erst beim ersten *erfolgreichen* Aufruf (wer nur 404 sieht, ist kein Besucher).
- Alle Listen bis 100 Einträge, «› x weitere» klappt auf.
- Ältere Zeilen in der Datenbank bleiben wie sie sind (dort sind «intern» und «direkt» nicht zu trennen).

## Was wie umgesetzt ist

### Teil A – Seite

| Punkt | Umsetzung |
|---|---|
| 1 Kopfzeile | Zeitraum (Heute · 7 Tage · 30 Tage · 12 Monate), Zugang mit Anzahl, rechts «x gerade aktiv · zuletzt vor 12 s aus 🇨🇭 Zürich» (Seitenaufrufe der letzten 5 Min. aus «Gerade eben», ohne Kennung). Adresse: `?tab=besucher&zeitraum=30-tage&zugang=internet` (7 Tage/Alle ohne Parameter). |
| 2 Kennzahlen | Eine Karte mit Kurve: Aufrufe, Besucher («eindeutig pro Tag»), Seiten pro Besuch (Aufrufe ÷ Besucher), Nicht gefunden (404, Anteil an allen Anfragen, Warnfarbe + «auffällig viele» für Screenreader ab 10 %), Bots («nicht mitgezählt»). Vergleich «+7 % zum Vorzeitraum» nur bei ganz gemessenem und noch aufbewahrtem Vorzeitraum, sonst «seit Messbeginn …» bzw. «erst seit … gemessen». Kennzahlen sind Knöpfe (`aria-pressed`) und wählen die Kurve. |
| 3 Diagramm | `VisitorsChart.tsx`: Fläche (Linie + Verlauf, Besucher gestrichelt bei «Aufrufe») oder Säulen (gestapelt Internet/Tailnet/Heimnetz, Legende mit Wort). Fadenkreuz + Tooltip (Zeitfenster, Wert, Besucher, Aufteilung) per Maus und Pfeiltasten/Pos1/Ende/Esc. y-Achse rechts (0, Mitte wenn rund, Max). Auflösung `trafficResolution` (shared, getestet). Messbeginn im Zeitraum: Achse beginnt dort, Marke «▸ Messbeginn 9.11., 19:40», Hinweis darunter. Wahl Fläche/Säulen als Präferenz `trafficChart` auf dem Server. Wechsel: 150 ms Überblenden; reduced-motion: keiner. |
| 4 Karte | Weltkarte gross, bis vier Stufen mit runden Grenzen (`mapSteps`, Legende «1–2 · 3–9 · 10–29 · 30+»), Tokens `--map-0…4`, Länder mit Aufrufen per Tab erreichbar (Tooltip Land + Anzahl), grüner Punkt in der Mitte des Landes des letzten Aufrufs. Welt · Europa. Rechts Länder (Flagge, Anzahl, Anteil; Umschalter Städte, wenn vorhanden), Hinweis Städte-Datenbank, Geräte · Browser · System als gestapelter Balken mit Wörtern. Unter 1100 px Liste unter der Karte. Interne Projekte: nur Geräte. |
| 5 Seiten | nur 2xx/3xx, Pfad, Aufrufe, Anteil, Balken hinter der Zeile, «› x weitere». Umschalter Alle · Einstieg · Ausstieg. |
| 6 Nicht gefunden | 404-Pfade mit Anzahl/Anteil, Scanner-Pfade (`SCANNER_PATHS` in shared) mit «bot?». Darunter 5xx mit Link zu Logs bzw. Zugriffe. |
| 7 Woher | «Direkt / Lesezeichen», Airlock-eigene Namen ausgeblendet und vermerkt, Klicks innerhalb der Seite vermerkt. |
| 8 Gerade eben | Letzte 8 Seitenaufrufe: `GET …/traffic/recent` (Speicher, 50 je Projekt) plus Live-Strom. Zeit, Flagge + Zugang (+ Stadt/Land), Pfad, Status. Pausiert bei verstecktem Tab (Strom zu, beim Zurückkommen neu geladen), Neuverbindung nach 5 s bei Abbruch. Neue Zeilen 200 ms einblenden, reduced-motion ohne. |

### Teil B – Merkmale (nur Zähler, Tabelle `traffic_dims`)

| Punkt | Umsetzung |
|---|---|
| 10 Netz | DB-IP «IP to ASN Lite» wie die Städte-Datei (`AsnDb`, Knopf, monatlich, Quelle genannt). Karte «Netz» mit Top-Providern; Rechenzentren (`DATACENTER_ASNS` in shared) zählen als Bot, Regel `botReason` (rein, getestet), unter der Liste «vermutlich Bot». |
| 11 Sprache | erste Sprache aus Accept-Language → «de-CH», Anzeige «Deutsch (Schweiz)». |
| 12 Browser/System | Familie + Hauptversion, Client Hints vor User-Agent (`agent.ts`, getestet; Brave/Edge über Sec-CH-UA, Windows 11 nur mit Plattform-Version). In der Karte als Umschalter. |
| 13 UTM | `utm_source/medium/campaign` als Liste «Kampagnen» (nur wenn vorhanden); übrige Query nie gespeichert (getestet). |
| 14 Einstieg/Ausstieg | Besuch = Folge erfolgreicher Aufrufe desselben Tages-Hashes, endet nach 30 Min. Pause, beim Tageswechsel oder Herunterfahren. Nur Zähler je Pfad. |
| 15 Cloudflare | `cf-ipcity` geht vor DB-IP; Koordinaten und PLZ werden nicht gelesen (getestet). Server › Besucher erklärt das Einschalten (Rules › Settings › Managed Transforms › «Add visitor location headers») und zeigt, ob Cloudflare schon Städte schickt. |
| 16 DNT/Sec-GPC | zählen in allen Summen, aber nicht in Einstieg/Ausstieg. **Begründung:** Der Tages-Hash beantwortet nur «heute schon gesehen?». Für Einstieg/Ausstieg hält Airlock dagegen pro Besucher im Speicher fest, welche Seite er zuletzt wann aufgerufen hat – das ist ein (kurzer) Verlauf seines Besuchs. Genau dem widerspricht ein Opt-out-Signal; die reinen Zähler sind dagegen nicht personenbezogen. |
| 17 MCP | `get_traffic(project, range: today/24h/7d/30d/12m, access)`: Messbeginn, Auflösung, Vorzeitraum, Nicht gefunden (mit Scanner-Hinweis), Einstieg/Ausstieg, Kampagnen, Browser, Systeme, Sprachen, Netze, ausgeblendete Referrer. |

Datenschutz unverändert (keine IP, keine Cookies, kein Skript, 13 Monate – gilt auch für `traffic_dims`).
Vorlage zum Kopieren: `docs/DATENSCHUTZ-VORLAGE.md`.

### Technik

- Auswertung (`summarize`, Zeiträume, Abschnitte, Vorzeitraum) liegt rein in `packages/shared/src/traffic-summary.ts`;
  die Bilder der Oberfläche entstehen aus erzeugten Stundenzeilen mit derselben Rechnung (`design-shots/fixtures-traffic.ts`).
- Migration `0024_traffic_dims.sql`: `traffic_dims`, `traffic_projects` (Messbeginn; Bestand aus `min(hour)`).
- Messbeginn: erste gelesene Zeile eines Projekts bzw. erster Lauf, in dem das Projekt Namen hat (auch ohne Aufrufe).
- Neue Tokens in allen vier Themes: `--chart-*`, `--map-0…4`, `--seg-1…5`; Kontrastprüfung erweitert.
- Keine neue Abhängigkeit.

## Prüfungen

- `pnpm --filter @airlock/shared build`, `pnpm -r typecheck`: grün
- `pnpm -r test`: grün (API 1149+, Web 86)
- `node docs/design-cal/contrast.mjs`: grün (Win95-Tailnet-Farbe dafür auf `#006868` gesetzt)
- `pnpm test:visual`: grün im letzten Lauf (siehe Commit-Nachricht der Referenzbilder). Ein Zwischenlauf hatte
  `neues-projekt-validierung · dunkel` mit 1 % Abweichung (nicht berührt, Rechnerlast) – einzeln wiederholt: grün.

Geänderte Referenzbilder (bewusst angesehen): alle `besucher*`, `projekt-uebersicht-besucher*` (neue,
konsistente Testdaten), `system-*`, `einrichtung-system`, `m9-server` (neuer Reiter «Besucher» unter Server).
Neu: `besucher-messbeginn`, `-saeulen`, `-heute`, `-12-monate`, `-kennzahl`, `-europa`, `-einstieg`,
`server-besucher(-geladen)`, dazu Win95/Terminal.

## Wie testen

1. Worktree starten (`pnpm dev` wie gewohnt) oder Bilder ansehen: `docs/design-cal/besucher-neu/umgesetzt-*.png`.
2. Projekt › Besucher: Zeitraum/Zugang wechseln (Adresse ändert sich), Kennzahl anklicken, Fläche/Säulen
   (bleibt nach Neuladen), Kurve mit Tab fokussieren und Pfeiltasten.
3. Karte: Welt/Europa, Tab durch die Länder, Geräte/Browser/System.
4. Seiten: Einstieg/Ausstieg (Ausstiege erscheinen erst 30 Min. nach einem Besuch).
5. Server › Besucher: Provider-Datenbank laden → nach neuen Aufrufen erscheint «Netz».
6. MCP: `get_traffic` mit `range: "today"` und `access: "public"`.

## Was auf dem Server zu tun ist

1. Nach dem Merge deployen wie üblich; Migration 0024 läuft beim Start (nur neue Tabellen, Bestand bleibt).
2. Optional: Server › Besucher › «Provider-Datenbank laden» (rund 10 MB von download.db-ip.com).
3. Optional: in Cloudflare «Add visitor location headers» einschalten (Anleitung auf derselben Seite).
4. Optional: `docs/DATENSCHUTZ-VORLAGE.md` in die Datenschutzerklärung der öffentlichen Seiten übernehmen.

## Risiken und Hinweise

- **Migrationsnummer:** Nacht 3 hat `0024_auth_2fa.sql`. Der Migrator merkt sich ganze Dateinamen, beide laufen;
  sie sind unabhängig. Für eine saubere Reihenfolge beim Mergen eine der beiden umbenennen, bevor sie irgendwo lief.
- **Zahlen ändern sich:** «Aufrufe» sinken (ohne 404/5xx), «direkt» schrumpft deutlich (Klicks innerhalb der
  Seite fehlen jetzt). Alte Zeilen bleiben gemischt.
- **Rechenzentren als Bot:** Nutzer mit VPN eines Hosters (z. B. M247) zählen als Bot. Liste in shared, leicht anzupassen.
- **Gerade eben** liegt nur im Speicher: nach einem Neustart von Airlock zunächst leer.
- **Einstieg/Ausstieg** kosten Speicher je offenem Besuch (begrenzt auf 100 000); nach einem Neustart beginnen alle Besuche neu.
- **Live-Strom** trägt jetzt bei Seitenaufrufen Pfad und Herkunft (nur für angemeldete Nutzer, wie bisher).
- `TrafficSummaryDto` ist erweitert (Pflichtfelder) – Fremdclients der API sehen mehr Felder, keine entfallen
  (ausser: `bucket` kann jetzt auch `week`/`month` sein).
