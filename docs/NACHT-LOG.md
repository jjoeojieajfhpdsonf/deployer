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
