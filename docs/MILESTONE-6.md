# Meilenstein 6 – Security

Stand: 7. November 2026

Umfang laut [SPEC.md](SPEC.md): drei Scan-Stufen, Score, Schwelle für «öffentlich», externe Domains, wöchentlicher Rescan, Benachrichtigungen. Dazu die MCP-Werkzeuge `run_scan`, `get_scan_report`, `accept_finding`, `add_external_target`, `verify_external_target`.

M6 kommt laut Auftrag **vor** M4 und M5. Die Schwelle für «öffentlich» wird deshalb hier als Funktion gebaut und erst in M5 an `set_targets` angeschlossen. TLS-Prüfungen (testssl.sh) haben intern noch kein Ziel: bis M4 laufen Projekte nur über HTTP.

## 1. Grundsätze

- **Ziele** sind ausschliesslich Container, die Airlock verwaltet, oder externe Domains mit DNS-Besitznachweis. Eine beliebige URL lässt sich weder über UI noch über MCP scannen; es gibt dafür schlicht keinen Parameter.
- **Scanner sind Wegwerf-Container** über die Erlaubnisliste aus `drivers/policy.ts`, ohne Docker-Socket, ohne Bind-Mount. Eingaben kommen per `PUT /archive` hinein, Berichte per `GET /archive` heraus.
- Ein Scanner hängt **nur im Netz des Projekts**, das er prüft (SPEC). Er spricht den Container direkt an (`http://<container>:<port>`), nicht über Caddy.
  - Warum nicht über Caddy: Dann müsste das Netz `airlock_edge` im IP-Filter erlaubt werden. Datenverkehr, den Dockers Userland-Proxy weiterreicht (etwa über IPv6), kommt mit einer Absenderadresse aus genau diesem Netz an und würde den Filter umgehen.
- Externe Ziele werden über ein eigenes Netz `air_ext-scan` (damals `dep_ext-scan`) mit Internetzugang geprüft. Der Slug `ext-scan` wird dafür reserviert; ebenso `deployer` (Name der Oberfläche) und `airlock`; `deployer` konnte bisher mit der Adresse der Oberfläche kollidieren (Fehler aus M1, wird hier behoben).
- Scans laufen **nacheinander** in einer Warteschlange; sie sind schwer (ZAP braucht über 1 GB Speicher).
- Ein Scan blockiert keinen Deploy: Er startet nach einem erfolgreichen Deploy im Hintergrund. Die SPEC nennt Stufe 1 «vor dem Start», verlangt aber keine Blockade; die Schwelle, die zählt (öffentlich), wirkt unabhängig von der Reihenfolge. Das hält Deploys unter den Zeitzielen.

## 2. Die Stufen

| Stufe | Werkzeug | Ziel | Was |
| --- | --- | --- | --- |
| 1 Artefakt | Trivy (`aquasec/trivy`) | Image als Tar (`GET /images/{name}/get`) und Quellordner | CVEs mit verfügbarem Fix (`--ignore-unfixed`), gruppiert je Paket; Secrets; Fehlkonfiguration im Dockerfile |
| 2 Laufzeit | eigener Header-Check | Container | CSP, frame-ancestors/X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS (nur HTTPS), Cookie-Flags, Versionsangaben in `Server`/`X-Powered-By`, gemischte Inhalte (nur HTTPS) |
| 2 Laufzeit | OWASP ZAP Baseline (`zaproxy/zap-stable`) | Container | passive Prüfungen, kurzer Spider |
| 3 Exposition | Nuclei (`projectdiscovery/nuclei`), nur nicht-invasive Vorlagen | Container | `.git`, `.env`, Backups, Admin-Panels, Standard-Logins |
| 3 Exposition | testssl.sh (`drwetter/testssl.sh`) | nur HTTPS-Ziele | TLS-Konfiguration |
| aktiv, optional | ZAP Full Scan | **nur** interner Container, nur auf Knopfdruck mit Bestätigung | XSS, SQL-Injection |

Bei externen Zielen: nur Stufe 2 und 3, höchstens 5 Anfragen pro Sekunde (Nuclei `-rl 5`, ZAP mit einem Thread und Pause), aktiv nur auf Knopfdruck.

**CVEs** nur mit verfügbarem Fix und zusammengefasst je Paket. Ungefixte CVEs sind nicht umsetzbar, und eine Debian-Basis hätte sonst sofort den Score 0. Dieselbe Begründung steht in OFFENE-FRAGEN.

**Secrets aus Trivy**: Gespeichert werden Regel, Datei und Zeile, **nie** die gefundene Zeichenfolge.

**Abhängigkeiten im Quellcode** (Nachtrag 10.11.2026): `trivy fs` lief anfangs nur mit `--scanners secret,misconfig`. Projekte ohne Image (statische Seite mit Build, Chat-Projekte) wurden so nie auf verwundbare Abhängigkeiten geprüft. Jetzt `vuln,secret,misconfig` mit `--ignore-unfixed` wie beim Image und `--list-all-pkgs`. Trivy liest die Lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock/uv.lock/requirements.txt, go.sum, Cargo.lock, composer.lock, Gemfile.lock). Dazu kommt `security/deps.ts`:
- Manifest mit Abhängigkeiten, aber ohne Lockfile daneben → Befund «niedrig»: «Ohne Lockfile keine verlässliche Prüfung der Abhängigkeiten».
- Die Stufe nennt, was geprüft wurde: «Abhängigkeiten: 214 Pakete aus pnpm-lock.yaml» bzw. «keine Abhängigkeiten gefunden». Ein Lauf ohne Lockfile sieht so nie wie «alles sicher» aus.
- Statische Seiten ohne Build: Bibliotheken als Einzeldateien im Ausgabeordner (`jquery-3.4.1.min.js`, Kopfkommentar `Bootstrap v4.3.1`) werden erkannt und in der Stufe genannt.

**Offener Punkt – JS-Bibliotheken als Einzeldateien:** Trivy erkennt sie nicht; es liest nur Paket-Metadaten, gegen die Fixture `fixtures/deps/static-site` geprüft. Nuclei deckt es mit unseren Tags (`exposure,config,misconfig,panel,default-login`) auch nicht ab. Nur ZAP Baseline meldet sie über Retire.js (Regel 10003 «Vulnerable JS Library»), und nur, wenn eine gecrawlte Seite die Datei lädt. Eine Bibliothek, die im Ordner liegt, aber nicht verlinkt ist, bleibt ungeprüft. Möglicher Weg: Retire.js-Datenbank (`jsrepository.json`) als Cache wie die Trivy-DB und die erkannten Versionen selbst abgleichen.

## 3. Score und Note

Pro offenem Befund: kritisch −25, hoch −10, mittel −4, niedrig −1, Minimum 0. Note A ab 90, B ab 75, C ab 50, sonst D. Akzeptierte Befunde zählen nicht. Reine Funktion mit Tests.

**Befunde über Scans hinweg**: Jeder Befund hat einen Fingerabdruck (Werkzeug, Titel, Stelle). Ein akzeptierter Befund bleibt akzeptiert, wenn er im nächsten Scan wieder auftaucht. Taucht ein offener Befund nicht mehr auf, gilt er als behoben.

**Schwelle für «öffentlich»**: kein offener kritischer Befund im letzten Scan, und es muss überhaupt ein Scan vorliegen. `assertPublishable()` wirft sonst mit der Liste der kritischen Befunde. Akzeptieren verlangt eine Begründung und landet im Audit-Log.

## 4. Externe Domains

Tabelle `external_targets`: `id`, `hostname`, `txt_token`, `verified_at`, `last_check_at`, `scan_interval` (`off`, `daily`, `weekly`, `monthly`; Standard `weekly`).

1. Eintragen: Hostname wird geprüft (gültiger DNS-Name, keine IP, nicht `localhost`, nicht unter der internen Basisdomain).
2. Airlock erzeugt ein Zufalls-Token und verlangt `_airlock-verify.<host>` als TXT mit `airlock-verify=<token>` (der alte Name `_deployer-verify` gilt weiter).
3. Prüfen über **öffentliche** Resolver (1.1.1.1, 8.8.8.8, 9.9.9.9), nicht über den lokalen.
4. Vor jedem Scan erneut prüfen. Fehlt der Eintrag: Freigabe weg, Benachrichtigung «Besitznachweis verloren».

Den Eintrag selbst setzen (Zone im Cloudflare-Konto) kommt mit M5.

## 5. Benachrichtigungen

Kanäle: **ntfy** (`NTFY_URL`, `NTFY_TOPIC`, optional `NTFY_TOKEN`) und **E-Mail** über SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `NOTIFY_EMAIL_TO`). Ohne Konfiguration ist ein Kanal aus.

| Ereignis | Standard |
| --- | --- |
| Deploy fehlgeschlagen | Push |
| Neuer kritischer Befund | Push und E-Mail |
| Neuer hoher Befund | E-Mail |
| Projekt öffentlich geschaltet (M5) | Push |
| Besitznachweis einer externen Domain verloren | E-Mail |
| Tunnel oder Zertifikat mit Problem (M4/M5) | Push und E-Mail |
| Chat-Projekt läuft bald ab / wurde gestoppt (aus M3) | E-Mail |
| Wöchentliche Zusammenfassung | E-Mail |

Pro Ereignis und Kanal schaltbar (UI unter System). **Nie Secrets:** Nachrichten bestehen aus Projektnamen, Adressen, Befund-Titeln und Zahlen; ein Prüfschritt entfernt zusätzlich jeden Wert, der einem Secret eines Projekts gleicht.

## 6. Datenmodell (Migration 0004)

- `scan_runs`: `id`, `project_id` oder `external_target_id`, `deployment_id`, `level` (`standard`, `active`), `status` (`queued`, `running`, `done`, `failed`), `started_at`, `finished_at`, `score`, `grade`, `error`, `stages` (jsonb: was lief, was nicht anwendbar war).
- `findings`: `id`, `scan_run_id`, `tool`, `severity`, `title`, `location`, `description`, `fix`, `fingerprint`, `status` (`open`, `accepted`, `fixed`), `accept_reason`.
- `finding_acceptances`: Fingerabdruck pro Projekt bzw. externem Ziel mit Begründung, Zeit und Akteur – damit Akzeptieren einen neuen Scan überdauert.
- `external_targets` wie oben.

## 7. API, MCP, Oberfläche

- REST: `POST /projects/{id}/scans`, `GET /projects/{id}/scans`, `GET /scans/{id}`, `PATCH /findings/{id}`, `GET/POST /external-targets`, `POST /external-targets/{id}/verify`, `PATCH/DELETE /external-targets/{id}`, `GET/PUT /notifications`, `POST /notifications/test`.
- MCP: `run_scan` (Bestätigung bei `active`), `get_scan_report` (URL, Status, Score, Note, die drei wichtigsten Befunde; optional warten), `accept_finding` (Bestätigung), `add_external_target`, `verify_external_target`.
- UI: Reiter **Security** am Projekt (Score, Note, Befunde, Akzeptieren mit Begründung, Scan starten, aktiver Scan mit Rückfrage); Ansicht **Externe Ziele**; **Benachrichtigungen** unter System mit Testknopf; Note in der Projektliste (Buchstabe und Zahl, nicht nur Farbe).

## 8. Reihenfolge

1. Score, Note, Fingerabdruck, Header-Check, Parser der Werkzeug-Berichte – alles reine Funktionen, Tests zuerst
2. Migration, Scan-Warteschlange, Scanner-Container
3. Stufen nacheinander mit Docker ausprobieren (Trivy, Header, ZAP, Nuclei)
4. Externe Ziele mit TXT-Nachweis (Resolver austauschbar, Tests ohne echte Domain)
5. Benachrichtigungen; Test mit lokalem ntfy- und SMTP-Ersatz, nie mit echten Diensten
6. Wöchentlicher Rescan, wöchentliche Zusammenfassung
7. MCP, REST, Oberfläche
8. Abnahme, M1–M3 erneut

## Abnahmekriterien

Stand 7.11.2026. Geprüft gegen den laufenden Stack mit echten Scannern (Trivy 0.58.1, ZAP 2.16.0, Nuclei 3.3.8) in Wegwerf-Containern: `e2e/m6.e2e.ts`, **15 Tests, alle grün**; Gesamtsuite M1–M6: 72 von 73, der Rest sporadisch (siehe NACHT-LOG). 312 Unit-Tests.

- [x] Nach einem Deploy läuft automatisch ein Scan; Score und Note stehen am Projekt und in der Projektliste
- [x] Trivy findet in `nginx:1.21-alpine` CVEs mit Fix (darunter kritische) und in einer Chat-Datei ein (erfundenes) GitHub-Token; das Token steht weder im Bericht noch in der Datenbank (`findings`, `audit_events`)
- [x] Der Header-Check meldet bei nginx fehlende CSP, frame-ancestors und die Versionsangabe im `Server`-Header; bei einer Seite mit allen Headern nichts
- [x] Nuclei findet eine offen ausgelieferte `/.env` einer statischen Seite – *erst nach zwei Korrekturen aus der Abnahme, siehe unten*
- [x] ZAP Baseline läuft (Stufe in jedem Scan durchgelaufen); Befunde von Hand gegen whoami geprüft – *bei den kleinen Testseiten deckt der Header-Check die meisten ZAP-Regeln ab, die deshalb ausgefiltert werden*
- [x] Score und Note entsprechen der Formel; ein akzeptierter Befund zählt nicht und ist im nächsten Scan wieder akzeptiert, mit Begründung
- [x] `assertPublishable` verweigert bei offenem kritischem Befund und ohne abgeschlossenen Scan; nach Akzeptieren der kritischen Befunde geht es; das Audit-Log hält `finding.accept` fest
- [x] Scanner-Container sind nach dem Scan entfernt – *dass sie nur im Projekt-Netz hängen, folgt aus dem Code (ein Netz pro Container, Erlaubnisliste), nicht eigens im Test geprüft*
- [x] Eine beliebige URL lässt sich nicht scannen; ein externes Ziel ohne TXT-Nachweis gibt `not_verified` (REST) bzw. einen Fehler (MCP); private und interne Namen werden abgelehnt – *der Nachweis selbst nur mit austauschbarem Resolver (Unit), keine echte Domain*
- [x] Aktiver Scan nur mit Bestätigung: REST ohne `confirm` 400, MCP liefert ein Bestätigungs-Token statt eines Scans
- [x] Benachrichtigungen kommen bei einer ntfy-Attrappe (HTTP) und einem SMTP-Ersatz (`smtp-server`) auf dem Host an; Test-Push, Test-Mail und ein echter `deploy_failed`; kein Secret-Wert darin; Einstellungen nur mit Anmeldung (Token: 403)
- [x] Die Slugs `deployer`, `airlock` und `ext-scan` lassen sich nicht vergeben
- [x] Alle M1- bis M3-Kriterien gelten weiter – *mit einem sporadischen, nicht gezielt reproduzierbaren Fehlschlag in der M3-Suite, siehe NACHT-LOG*

### Fehler, die erst die Abnahme gezeigt hat

1. **Nuclei prüfte nie etwas.** `-duc` unterdrückt auch das erste Herunterladen der Vorlagen; ohne Vorlagen bricht Nuclei mit «no templates provided» ab, liefert keine Datei – und die Stufe galt als durchgelaufen ohne Befund. Auch der frühere Probelauf gegen whoami war damit wertlos. Jetzt: Vorlagen laden, wenn sie fehlen oder älter als 7 Tage sind; Abbruch oder `[FTL]` macht die Stufe zum Fehler.
2. **busybox-httpd verweigert Punktdateien.** Statische Seiten wurden über einen busybox-httpd gescannt, Caddy liefert `.env` aber aus. Jetzt scannt ein kurzlebiger `caddy file-server`.
3. **Header-Check lief in eine tote Verbindung.** Der Healthcheck des Deploys hatte dieselbe Adresse gerade angefragt; die Keep-Alive-Verbindung im globalen Pool war tot, seit Airlock das Projekt-Netz verlassen hatte. Jetzt ein eigener Agent ohne Keep-Alive.

## Review

`/code-review high` über alle M6-Änderungen: zehn Befunde, alle behoben.

| # | Befund | Behebung | Test |
| --- | --- | --- | --- |
| 1 | Fiel eine Stufe aus (etwa ZAP), galten ihre alten Befunde als «behoben» und wurden beim nächsten Lauf als neu gemeldet | «Behoben» nur für Werkzeuge, deren Stufen diesmal alle durchliefen (`toolsChecked`) | Unit |
| 2 | `withProjectNetwork` zählte vor dem Verbinden; scheiterte es, liefen alle späteren Healthchecks ohne Verbindung. Dazu ein Wettlauf zwischen Trennen und Verbinden | Warteschlange pro Netz; Zähler steigt erst nach erfolgreichem Verbinden | Unit |
| 3 | Das Aufräumen löschte `dep_ext-scan` (kein Projekt) und brach bei einem Netz mit Teilnehmern ganz ab | Reservierte Namen ausgenommen; Fehler pro Netz | – |
| 4 | `accept_finding` (MCP) prüfte nicht, ob der Befund zum genannten Projekt gehört | Prüfung vor der Rückfrage und im Service | – |
| 5 | Ein externes Ziel konnte per DNS ins LAN zeigen; die Scanner (bis zum aktiven ZAP) hätten den Router geprüft | Name muss auf öffentliche Adressen zeigen, vor Nachweis und vor jedem Scan; Rest-Risiko DNS-Rebinding in OFFENE-FRAGEN | Unit |
| 6 | Kopie des Quellcodes (`scan-src`) blieb auf vielen Wegen liegen; Scanner nach Neustart verwaist | Aufräumen im `finally` jedes Scans, beim Prune, beim Start (Container und Ordner) | – |
| 7 | `get_scan_report` wartete bis 10 Minuten, MCP-Clients brechen nach 60 s ab | höchstens 50 s, dann Zwischenstand mit Hinweis | – |
| 8 | Akzeptieren rechnete nur den Score des Scans neu, aus dem der Befund stammte | alle abgeschlossenen Scans des Ziels | – |
| 9 | Fingerabdrücke enthielten schwankende Teile (Anzahl CVEs, Version, Image-Tag, erste ZAP-Fundstelle, «+N ähnliche») | stabiler Schlüssel pro Befund (Paket + Schwere, ZAP-Regel, Pfad) | Unit |
| 10 | Benachrichtigungs-Einstellungen: bei einem Ladefehler ewige Ladeanzeige | Fehler zuerst prüfen | – |
