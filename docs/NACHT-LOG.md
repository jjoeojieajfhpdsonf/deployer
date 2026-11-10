# Nacht-Log

Arbeit ohne Rückfragen, Nacht vom 6. auf den 7. November 2026. Pro Meilenstein: Stand, was getestet ist, was nicht, bekannte Probleme. Annahmen stehen in [OFFENE-FRAGEN.md](OFFENE-FRAGEN.md).

Reihenfolge laut Auftrag: M2, M3, M6, danach Code für M4 und M5 (ohne echte Domain, Token oder Server, also ungetestet).

## Ausgangslage: Meilenstein 1

**Stand:** fertig, als erster Commit eingecheckt. Details und Abnahme in [MILESTONE-1.md](MILESTONE-1.md).

**Getestet:** 56 Unit-Tests; Abnahme lokal mit Docker Desktop (13 von 14 Kriterien).

**Nicht getestet:** IP-Filter auf dem Linux-Server; die Ansichten nach dem Login und der Hell-Modus nicht im Browser angesehen.

**Letzte Änderung vor dem Commit:** Ohne Basisdomain zeigt die Oberfläche jetzt die nip.io-Adresse statt des Platzhalters `int.example.ch`. Wird die Basisdomain später gesetzt, ziehen bestehende Projekte beim Start mit.

## Meilenstein 2 – Alle Quellen

**Stand:** fertig und committet. Plan, Abnahme und Befunde in [MILESTONE-2.md](MILESTONE-2.md).

Neu: Quellen `dockerfile` (Clone + Build), `compose` (Upload oder Repo, mit eigener Erlaubnisliste und neu geschriebener Datei), `static` aus einem Repo mit optionalem Build im Wegwerf-Container; Rollback für alle vier Quellen; Umschalten ohne Ausfall für Image, Dockerfile und statisch.

**Getestet:**
- 165 Unit-Tests, darunter 50 für die Compose-Prüfung, die Repo-URL-Sperren, Zip Slip/Tar Slip und `.dockerignore`.
- Neue Ende-zu-Ende-Suite gegen den laufenden Stack (`pnpm --filter @airlock/api e2e`): 33 Tests für M1 und M2, alle grün. Darin: ein echter Git-Server (Smart HTTP) auf dem Host, Builds über den Socket-Proxy, Compose mit Redis und Datenpersistenz, Rollbacks, und ein Umschalt-Test, der alle 100 ms abfragt – keine einzige Antwort ohne 200.
- `/code-review high`: zehn Befunde, alle behoben (Tabelle in MILESTONE-2.md).

**Nicht getestet:**
- Drei Fehlerpfade aus dem Review (Rollback-Images, Caddy-Fehler nach Umschalten, frisches Pull von `:latest`) nur per Code, nicht mit Docker.
- Private Repos gibt es bewusst nicht.
- Die Oberfläche (neues Formular mit vier Quellen, Rollback-Knopf) ist typgeprüft, aber nicht im Browser angesehen – wie in M1.

**Bekannte Probleme / Hinweise:**
- Der Mac hat nachts per DHCP eine neue IP bekommen; `SERVER_LAN_IP` musste nachgezogen werden. Für den Server: feste IP oder DHCP-Reservierung.
- Compose-Deploys haben einen kurzen Ausfall der geänderten Dienste (bewusst, siehe OFFENE-FRAGEN).
- Das Airlock-Image ist durch git und die Docker-CLI grösser geworden.

## Meilenstein 3 – MCP und Chat-Deploy

**Stand:** fertig und committet. Plan, Abnahme, Review in [MILESTONE-3.md](MILESTONE-3.md).

> **Wichtig, aus dem Review:** Seit Meilenstein 1 liess sich die Anmeldung mit einem prozentkodierten Pfad umgehen (`/%61pi/v1/projects` lieferte ohne Login die Projektliste; POST hätte Container gestartet). Erreichbar aus dem LAN. Im M3-Commit behoben, mit Regressionstest in der M1-Suite. Der M1- und der M2-Commit enthalten die Lücke noch.

Neu: API-Tokens (Anlegen, Widerrufen, nur der Hash gespeichert), MCP-Server unter `/mcp` mit 14 Werkzeugen, Bestätigungen per Elicitation oder Bestätigungs-Token, Quelle `files` mit lokalem Git-Repo und Typ-Erkennung bei jedem Deploy, Ablauf von Chat-Projekten nach 30 Tagen, Tokens-Ansicht in der UI.

**Getestet:**
- 228 Unit-Tests.
- 58 Ende-zu-Ende-Tests über M1–M3, alle grün. M3 mit dem offiziellen MCP-Client über HTTP: Zugang und Widerruf, Sitzungsbindung, alle drei erkannten Arten, Pfad- und Grössengrenzen, Bestätigungen (auch per Elicitation), Audit, Ablauf-Job.
- `/code-review high`: zehn Befunde, alle behoben (Tabelle in MILESTONE-3.md).

**Nicht getestet:**
- `export_repo` mit `push` gegen einen echten Anbieter (bewusst nicht – das wäre Veröffentlichen).
- Ablauf eines Bestätigungs-Tokens nach 5 Minuten nur als Unit-Test.
- Tokens-Ansicht und Chat-Angaben in der UI nicht im Browser angesehen.

**Bekannte Probleme / Hinweise:**
- Ein Image-Redeploy lädt Caddy weiterhin neu (neuer Upstream). Auf Projekt-Routen mit Keep-Alive kann ein Client dabei eine Anfrage verlieren; Browser wiederholen GET-Anfragen von selbst. Verbesserung wäre ein stabiler Netz-Alias pro Projekt (siehe OFFENE-FRAGEN).
- MCP-Sitzungen liegen im Speicher und enden mit einem Neustart von Airlock.

## Meilenstein 6 – Security

**Stand:** fertig und committet. Plan, Abnahme, Review in [MILESTONE-6.md](MILESTONE-6.md).

Neu: Scans nach jedem Deploy im Hintergrund (Trivy für Image und Quellen, eigener Header-Check, ZAP Baseline, Nuclei; testssl.sh bei externen Zielen), Score und Note, Akzeptieren mit Begründung über Scans hinweg, Schwelle für «öffentlich» (`assertPublishable`, an M5 anzuschliessen), externe Ziele mit TXT-Nachweis (2 von 3 öffentlichen Resolvern), wöchentlicher Rescan und Wochenübersicht, Benachrichtigungen über ntfy und SMTP pro Ereignis und Kanal schaltbar. MCP: `run_scan`, `get_scan_report`, `accept_finding`, `add_external_target`, `verify_external_target`. UI: Reiter Security, Seite Externe Ziele, Benachrichtigungen unter System, Note in der Projektliste.

**Getestet:**
- 312 Unit-Tests (Score, Fingerabdruck, Parser gegen echte Berichte, Header-Regeln, TXT-Quorum, öffentliche Adressen, Netz-Zähler, Benachrichtigungs-Matrix und Schwärzung).
- 15 neue Ende-zu-Ende-Tests mit echten Scannern (`e2e/m6.e2e.ts`), alle grün.
- Gesamtsuite M1–M6 (73 Tests) dreimal gelaufen: 72 von 73 grün im letzten Lauf. Die Fehlschläge davor waren Testfilter, die Scanner-Container (tragen jetzt das Projekt-Label) als Projekt-Container zählten – behoben – und ein liegengebliebener Scan-Server (behoben, siehe unten). Der verbleibende Fehlschlag ist **sporadisch**, siehe «Bekannte Probleme».
- `/code-review high`: zehn Befunde, alle behoben.

**Die Abnahme hat drei echte Fehler gefunden** (Details in MILESTONE-6.md): Nuclei hatte nie Vorlagen und prüfte darum nichts (auch der frühere Probelauf gegen whoami war wertlos); der Scan statischer Seiten lief über einen Server, der `.env` verweigert, während Caddy sie ausliefert; der Header-Check lief in eine tote Keep-Alive-Verbindung. Dazu in der Gesamtsuite: ein Scan-Server blieb liegen, wenn das Projekt während des Scans gelöscht wurde; und zwei Caddy-Abgleiche konnten gleichzeitig laufen (jetzt nacheinander). Alles behoben.

**Nicht getestet:**
- Echte externe Domain (keine vorhanden): Nachweis nur mit Attrappen-Resolver, Scan eines externen Ziels nur bis zur Ablehnung ohne Nachweis.
- testssl.sh nie gelaufen (intern kein TLS, extern kein Ziel).
- Aktiver Scan (ZAP Full) nur bis zur Bestätigungsfrage, nicht durchgelaufen.
- Echter ntfy-Dienst und echter Mailserver (bewusst nicht – Attrappen auf dem Host).
- Wochenübersicht und wöchentlicher Rescan nur per Code; die Zeitpunkte nicht abgewartet.
- Die neuen Ansichten sind typgeprüft und gebaut, aber nicht im Browser angesehen.

**Bekannte Probleme / Hinweise:**
- **Sporadische Fehlschläge in der M3-Suite** (MCP), etwa einer von vier Läufen, nie derselbe Test: einmal eine Zeitüberschreitung bei `delete_project` mit Elicitation, einmal 404 direkt nach dem Deploy einer Chat-Seite, einmal ein Fehler direkt nach einem Compose-Deploy. Einzeln wiederholt laufen die Tests grün. Gemeinsam ist der Zeitpunkt: direkt nach einem Deploy bzw. Neuladen von Caddy, mit Scans im Hintergrund. Gefunden und behoben wurde dabei, dass zwei Caddy-Abgleiche gleichzeitig laufen konnten (ein älterer Stand konnte zuletzt geladen werden) – das erklärt aber nicht alle Fälle. Verdacht für den Rest: Caddy wird ins Projekt-Netz gehängt und lädt sofort; die Namensauflösung im neuen Netz ist einen Moment später bereit. Nicht weiter verfolgt, um M4/M5 nicht zu gefährden.
- Rest-Risiko DNS-Rebinding bei externen Zielen (siehe OFFENE-FRAGEN); Voraussetzung ist ein gültiges API-Token.
- Scans laufen nacheinander. Nach vielen Deploys in kurzer Zeit (etwa der ganzen Testsuite) staut sich die Warteschlange; die M6-Suite dauerte in der Gesamtsuite deshalb rund 15 Minuten.
- ZAP filtert Regeln, die der Header-Check schon abdeckt; bei kleinen Seiten bleiben dann oft keine ZAP-Befunde übrig.

## Meilenstein 4 – Tailnet und Zertifikate (Code, ungetestet gegen echte Dienste)

**Stand:** Code fertig und committet. Plan, Abnahme, Review in [MILESTONE-4.md](MILESTONE-4.md). Ohne Domain, Token und Server – wie beauftragt.

Neu: `TLS_MODE=cloudflare` über die Compose-Ergänzung `compose.tls.yaml` (Caddy mit `caddy-dns/cloudflare`, :443, Token als Compose-Secret); Wildcard-Zertifikat `*.<basisdomain>` per DNS-01, Weiterleitung auf HTTPS nur für interne Namen, nip.io bleibt HTTP; Tailnet-DNS-Eintrag bei Cloudflare (A, nicht proxied); LAN und Tailnet unter einem Namen (Migration 0005), mit Quell-Bereichen nach Ziel; Secure-Cookie über HTTPS; Zertifikatsstatus auf der Systemseite mit stündlicher Prüfung; Erreichbarkeit (LAN/Tailnet) in den Projekt-Einstellungen.

**Getestet:**
- 325 Unit-Tests, darunter der TLS-Konfigurationsbau, der Cloudflare-Client gegen eine Attrappe, Zertifikatsregeln gegen einen lokalen TLS-Server.
- Lokal mit Docker: Caddy-Image mit dem Modul gebaut; `caddy validate` nimmt die erzeugte TLS-Konfiguration an; Startskript liest das Secret; Compose-Ergänzung ergibt :80 + :443.
- `e2e/m4.e2e.ts` (7 Tests) und die **Gesamtsuite M1–M6 + M4: 80 von 80 grün** (diesmal ohne den sporadischen Fehlschlag).
- `/code-review high`: zehn Befunde, alle behoben – darunter, dass «nur LAN» bzw. «nur Tailnet» vorher nichts einschränkte.

**Nicht getestet:**
- Ausstellung eines echten Zertifikats, echte Cloudflare-API, HTTPS im Browser.
- IP-Filter nach Ziel auf dem Linux-Server (lokal ist der Filter aus).
- Systemseite und Erreichbarkeits-Schalter nicht im Browser angesehen.

**Für die Inbetriebnahme auf dem Server:** `INTERNAL_BASE_DOMAIN`, `TAILSCALE_IP` und `ACME_CA=staging` in `.env`; Token (Zone → DNS → Bearbeiten) nach `secrets/cloudflare_token` (Rechte 600); `docker compose -f compose.yaml -f compose.tls.yaml up -d --build`; Systemseite prüfen; dann `ACME_CA=production`. Lokaler DNS: `*.int…` auf die LAN-IP.

## Meilenstein 5 – Öffentlich über Cloudflare (Code, ungetestet gegen echte Dienste)

**Stand:** Code fertig und committet. Plan, Abnahme, Review in [MILESTONE-5.md](MILESTONE-5.md). Ohne Domain, Token und Tunnel.

Neu: öffentliche Route pro Projekt über Cloudflare Tunnel (`compose.public.yaml` mit cloudflared, Token als Datei); CNAME proxied auf den Tunnel, Ingress-Regeln per API (fremde Regeln bleiben), optional Cloudflare Access; Domains (Zonen) mit Standard; Schwelle aus M6 vor jedem Öffentlich-Schalten; Bestätigung über MCP, Rückfrage in der UI; Aufräumen bei Cloudflare beim Entfernen und Löschen; Caddy lässt öffentliche Namen nur von cloudflared zu und übernimmt `CF-Connecting-IP` nur von dort; Benachrichtigung `project_public`.

**Getestet:**
- 339 Unit-Tests (neu: Hostname-Regeln, Ingress-Abgleich, Caddy-Konfiguration); `caddy validate` nimmt die Konfiguration mit `trusted_proxies` an.
- Gesamtsuite M1–M6 + M4 danach: **80 von 80 grün** (die M5-Suite läuft nur mit der Attrappe und wird dort übersprungen).
- **Gegen eine Cloudflare-Attrappe** (das laufende Airlock spricht mit ihr): `pnpm --filter @airlock/api e2e:cf`, 11 Tests grün – Domains, Schwelle, CNAME, Ingress, Access, Umbenennen, fremde Einträge, unzulässige Namen, Token-Sperre, MCP-Bestätigung, Entfernen, Löschen.
- `/code-review high`: zehn Befunde, alle behoben – darunter, dass ein erneuter Aufruf ohne `access` Cloudflare Access still abschaltete.

**Nicht getestet:**
- Echte Cloudflare-API, echter Tunnel, echte Domain, Access-Login, cloudflared mit echtem Token.
- `project_public`-Benachrichtigung nicht eigens geprüft.
- Die neuen Ansichten (Erreichbarkeit mit Rückfrage, Domains und Tunnel unter System) sind typgeprüft, nicht im Browser angesehen.

**Für die Inbetriebnahme:** Tunnel im Dashboard anlegen (remote verwaltet), Token nach `secrets/tunnel_token`; `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ID`, optional `ACCESS_EMAIL` in `.env`; das Cloudflare-Token um die Rechte «Tunnel bearbeiten» und DNS der öffentlichen Zonen erweitern; `docker compose -f compose.yaml -f compose.tls.yaml -f compose.public.yaml up -d --build`; unter System die Standard-Domain wählen.

## Zusammenfassung der Nacht

- **Committet:** M6, M4, M5 (in dieser Reihenfolge, wie beauftragt; M2 und M3 davor). M7 nicht.
- **Wichtigster Fund der Nacht** (aus M3): die Anmeldung liess sich seit M1 mit einem prozentkodierten Pfad umgehen – behoben. Die Commits von M1 und M2 enthalten die Lücke noch.
- **Fehler, die erst Docker-Tests gezeigt haben** (M6): Nuclei prüfte nie etwas; der Scan statischer Seiten übersah `.env`; Header-Check in toter Verbindung; gleichzeitige Caddy-Abgleiche.
- **Offen:** ein sporadischer Fehlschlag in der M3-Suite (siehe M6, «Bekannte Probleme»); alle Cloudflare-, Zertifikats- und Server-Teile ungetestet gegen echte Dienste; keine der neuen Ansichten im Browser angesehen.
- **Nichts veröffentlicht, nicht gepusht**, keine echten Tokens angelegt. Die Attrappen-Werte (`cf-test-token`, erfundene Konto- und Tunnel-ID) stehen nur in `packages/api/e2e/`.

