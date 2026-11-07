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
- Neue Ende-zu-Ende-Suite gegen den laufenden Stack (`pnpm --filter @deployer/api e2e`): 33 Tests für M1 und M2, alle grün. Darin: ein echter Git-Server (Smart HTTP) auf dem Host, Builds über den Socket-Proxy, Compose mit Redis und Datenpersistenz, Rollbacks, und ein Umschalt-Test, der alle 100 ms abfragt – keine einzige Antwort ohne 200.
- `/code-review high`: zehn Befunde, alle behoben (Tabelle in MILESTONE-2.md).

**Nicht getestet:**
- Drei Fehlerpfade aus dem Review (Rollback-Images, Caddy-Fehler nach Umschalten, frisches Pull von `:latest`) nur per Code, nicht mit Docker.
- Private Repos gibt es bewusst nicht.
- Die Oberfläche (neues Formular mit vier Quellen, Rollback-Knopf) ist typgeprüft, aber nicht im Browser angesehen – wie in M1.

**Bekannte Probleme / Hinweise:**
- Der Mac hat nachts per DHCP eine neue IP bekommen; `SERVER_LAN_IP` musste nachgezogen werden. Für den Server: feste IP oder DHCP-Reservierung.
- Compose-Deploys haben einen kurzen Ausfall der geänderten Dienste (bewusst, siehe OFFENE-FRAGEN).
- Das deployer-Image ist durch git und die Docker-CLI grösser geworden.

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
- MCP-Sitzungen liegen im Speicher und enden mit einem Neustart des deployers.
