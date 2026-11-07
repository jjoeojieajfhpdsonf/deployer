# Meilenstein 3 – MCP und Chat-Deploy

Stand: 7. November 2026

Umfang laut [SPEC.md](SPEC.md): MCP-Server mit Token, Quelle `files` mit lokalem Git-Repo, Bestätigungen. Dazu der automatische Ablauf von Chat-Deploys nach 30 Tagen. Ab hier kann Claude beim Weiterbauen von deployer selbst Testprojekte deployen.

Die Werkzeuge für Scans und externe Ziele (`run_scan`, `get_scan_report`, `accept_finding`, `add_external_target`, `verify_external_target`) kommen mit M6, `list_domains` liefert bis M5 eine leere Liste, und `public` als Ziel lehnt der Server bis M5 ab.

## 1. API-Tokens

Neue Tabelle `api_tokens`: `id`, `name`, `token_hash`, `created_at`, `last_used_at`, `revoked_at`.

- Ein Token sind 32 Zufallsbytes, Präfix `dpl_` (erkennbar in Logs und beim Secret-Scanning). Gespeichert wird nur **SHA-256** davon. Ein langsamer Hash wie scrypt ist hier unnötig: das Token ist zufällig und lang, Wörterbuchangriffe greifen nicht.
- Der Klartext erscheint **genau einmal**, beim Anlegen in der UI.
- Widerrufen setzt `revoked_at`; ab dann wird jeder Aufruf mit 401 abgewiesen, auch eine offene MCP-Sitzung.
- Vergleich in konstanter Zeit über den Hash.
- Gilt auch für die REST-API (`Authorization: Bearer dpl_…`), damit Skripte sie nutzen können (SPEC: «für die UI und für Skripte»). Im Audit-Log steht dann `token:<name>` als Akteur.

## 2. MCP-Server

Streamable HTTP unter `/mcp`, über das offizielle SDK `@modelcontextprotocol/sdk`. Caddy leitet ihn mit der UI weiter, der IP-Filter gilt (nur LAN und Tailnet).

- **Sitzungen** (Header `Mcp-Session-Id`) sind an das Token gebunden, das sie eröffnet hat. Ein anderes Token kann eine fremde Sitzung nicht benutzen. Widerruf beendet die Sitzung beim nächsten Aufruf.
- Jeder Tool-Aufruf landet im Audit-Log: Akteur `token:<name>`, Werkzeug, Parameter (Secrets maskiert, Dateiinhalte nur als Pfad und Grösse), Ergebnis.
- Alle Tools rufen dieselbe Service-Schicht wie REST und UI auf (`domain/`, `deploy/`). Die SPEC verlangt genau das, M1 hat die Schicht dafür angelegt.

**Tools in M3:**

| Tool | Bestätigung |
| --- | --- |
| `list_projects`, `get_project`, `get_logs` (max. 500 Zeilen) | nein |
| `create_project` (Quelle `files`, Repo, Image, Upload) | nur bei `public` – in M3 abgelehnt |
| `update_files`, `read_files`, `export_repo` | nein |
| `deploy`, `start`, `stop` | nein |
| `rollback` | **ja** |
| `delete_project` | **ja** |
| `set_targets` | nur bei `public` – in M3 abgelehnt |
| `list_domains` | nein (leer bis M5) |

## 3. Bestätigungen

Unterstützt der Client **Elicitation**, fragt deployer dort nach («Projekt shop löschen?»). Sonst antwortet das Tool mit einer Zusammenfassung und einem `confirmation_token`; erst ein zweiter Aufruf **mit denselben Parametern** und diesem Token innerhalb von **5 Minuten** führt die Aktion aus.

Das Bestätigungs-Token ist gebunden an: das API-Token des Aufrufers, das Werkzeug, einen Hash der Parameter. Es gilt genau einmal. So kann ein Agent weder ein Token für «Projekt A löschen» für Projekt B benutzen noch ein Token eines anderen Clients.

## 4. Quelle `files`: lokales Git-Repo

Pro Projekt ein Repo unter `/data/repos/<slug>`. Dateien kommen als Pfad und Inhalt (UTF-8 oder Base64), **höchstens 20 MB pro Aufruf**, höchstens 2 000 Dateien.

- **Pfade** werden geprüft wie beim ZIP: relativ, kein `..`, kein `.git/`, keine Nullbytes, höchstens 255 Zeichen. Es gibt keinen Weg, einen Symlink anzulegen – Dateien sind immer reguläre Dateien.
- Jede Änderung ist ein Commit (Autor `deployer`, Nachricht vom Aufrufer). Die Version eines Deploys ist der Commit-Hash; Rollback funktioniert wie bei jeder anderen Quelle.
- **Deploy:** `git archive <commit>` wird mit den Regeln aus `lib/untar.ts` in den Arbeitsordner entpackt – auch der eigene Repo-Inhalt geht durch die sichere Strecke.
- **Typ-Erkennung** in dieser Reihenfolge (SPEC): `compose.yaml`/`compose.yml`/`docker-compose.yml` → Compose; `Dockerfile` → Build; `package.json` mit Skript `build` → statischer Build (Ausgabe `dist`, über `output_dir` änderbar); sonst → statisch, so wie es ist.
- Die erkannte Art wird beim Deploy gewählt, nicht beim Anlegen festgeschrieben: ein Chat-Projekt, das mit HTML beginnt und später ein Dockerfile bekommt, wird ab dann gebaut.
- `read_files` liefert den Stand (optional nur bestimmte Pfade, höchstens 2 MB Antwort).
- `export_repo`: `zip` liefert das Repo als ZIP (Base64, höchstens 20 MB). `push` schiebt es auf eine `https://`-URL; die URL-Prüfung aus M2 gilt, Zugangsdaten kommen in einem eigenen Parameter, der nie geloggt wird.

## 5. Automatischer Ablauf von Chat-Deploys

Projekte mit Quelle `files` werden nach **30 Tagen ohne Änderung** gestoppt, nicht gelöscht. «Änderung» heisst: letzter Commit oder letzter Deploy. Die Frist ist per `CHAT_EXPIRY_DAYS` einstellbar; `keep` nimmt ein Projekt aus.

- 3 Tage vorher entsteht ein Ereignis «läuft bald ab». In M3 nur Audit-Log und Hinweis in der UI; Push und E-Mail kommen mit den Benachrichtigungen in M6.
- Ein stündlicher Job prüft die Fristen; gestoppt wird über `stopProject`, also mit Audit-Eintrag.
- Neu starten per UI oder MCP (`start`).

## 6. Oberfläche

- **Tokens** (neue Ansicht): anlegen (Name), Klartext einmal anzeigen mit Kopieren, Liste mit «zuletzt benutzt», widerrufen mit Rückfrage. Dazu die MCP-Adresse und ein Beispiel für die Client-Konfiguration.
- **Projekt-Detail** bei Quelle `files`: erkannte Art, letzter Commit, «läuft ab am …», Schalter «behalten».

## 7. Reihenfolge

1. Migration `api_tokens`, Token-Logik und Auth für REST (Tests zuerst)
2. Lokales Repo: Pfadprüfung, Commit, Archiv, Typ-Erkennung (Tests zuerst)
3. Pipeline-Quelle `files`
4. Bestätigungs-Tokens (Tests zuerst)
5. MCP-Server mit allen Tools; Tests über einen In-Memory-Transport
6. Ablauf-Job
7. Oberfläche
8. Abnahme mit Docker über einen echten MCP-Client (SDK, Streamable HTTP), M1/M2-Abnahme erneut

## Abnahmekriterien

Stand 7.11.2026. Geprüft mit dem offiziellen MCP-Client (SDK 1.32, Streamable HTTP) gegen den laufenden Stack: `e2e/m3.e2e.ts`, zusammen mit M1 und M2 **58 Ende-zu-Ende-Tests, alle grün**; 228 Unit-Tests.

- [x] Ein MCP-Client mit gültigem Token listet die Tools und Projekte; ohne Token oder mit widerrufenem Token gibt es 401 – *auch eine offene Sitzung endet beim nächsten Aufruf nach dem Widerruf*
- [x] Eine MCP-Sitzung lässt sich nicht mit einem anderen Token weiterbenutzen (403)
- [x] `create_project` mit `source.type: files` und einer `index.html` ergibt eine erreichbare Seite; die Antwort enthält URL und Status
- [x] `update_files` ändert eine Datei, committet und deployt; die Seite zeigt den neuen Stand; `read_files` liefert ihn
- [x] Ein Chat-Projekt mit `Dockerfile` wird gebaut, eines mit `package.json`+`build` statisch gebaut, eines mit `compose.yaml` als Compose deployt
- [x] Dateipfade mit `..`, absolutem Pfad oder `.git/` werden abgelehnt; mehr als 20 MB pro Aufruf auch
- [x] `delete_project` ohne Bestätigung löscht nichts und liefert ein `confirmation_token`; mit Token löscht es; dasselbe Token für ein anderes Projekt wird abgelehnt, ein zweites Mal ebenso – *Ablauf nach 5 Minuten als Unit-Test*
- [x] `rollback` verlangt ebenso eine Bestätigung
- [x] **Elicitation:** Ein Client, der sie anbietet, wird direkt gefragt; Ablehnen löscht nichts, Zustimmen löscht ohne Token
- [x] `export_repo` als ZIP enthält die Dateien des Projekts – *`push` nur gegen einen lokalen Git-Server, nie gegen GitHub*
- [x] Jeder MCP-Aufruf steht im Audit-Log mit Token-Name; Dateiinhalte stehen dort nicht
- [x] Ein Chat-Projekt, dessen letzte Änderung länger als die Frist zurückliegt, wird vom Ablauf-Job gestoppt; mit `keep` nicht
- [x] REST mit `Authorization: Bearer` funktioniert für Skripte; Tokens verwalten damit nicht (403)
- [x] Alle M1- und M2-Kriterien gelten weiter

## Befunde aus der Umsetzung

1. **Verlorene MCP-Aufrufe nach einem Deploy.** MCP antwortet per SSE, die Header gehen also vor dem Deploy hinaus. Der Deploy lädt Caddy neu, Caddy schliesst die Verbindung nach der Antwort, der Client weiss es nicht und schickt seinen nächsten Aufruf ins Leere. Genau der Hauptfall der SPEC (`create_project`, dann `update_files`) scheiterte daran. Behoben mit `Connection: close` auf der Route des deployers und mit Neuladen nur bei echter Änderung.
2. **Tokens können keine Tokens verwalten** – nicht im Plan, aber nötig: Ein gestohlenes Token könnte sich sonst ein zweites anlegen und den Widerruf überdauern.

## Code-Review

`/code-review high` lieferte zehn Befunde, alle berechtigt und behoben:

| # | Befund | Behebung | Test |
| --- | --- | --- | --- |
| 1 | **Prozentkodierung umgeht den Auth-Wächter.** Gemeldet für die Token-Verwaltung (`/api/v1/%74okens`). Beim Nachprüfen zeigte sich: **schlimmer, und seit M1** – `/%61pi/v1/projects` lieferte ohne jede Anmeldung die Projektliste, und POST hätte Container gestartet. Der Wächter prüfte den rohen Pfad, der Router dekodiert ihn. | Entscheidung am Routenmuster, das der Router gewählt hat | Unit + E2E (M1-Suite) |
| 2 | Ein abgelaufenes Projekt wurde nach einem Start von Hand in der nächsten Stunde wieder gestoppt | Start zählt als Aktivität | E2E |
| 3 | Artwechsel Compose → Dockerfile/statisch liess die Compose-Dienste weiterlaufen | Compose-Dienste werden mit entfernt, wenn die neue Fassung nicht mehr Compose ist | E2E |
| 4 | Gescheiterter oder gleichzeitiger `commitFiles` hinterliess halbe Änderungen für den nächsten Commit | Sperre pro Repo, bei Fehler zurück auf den letzten Commit | Unit |
| 5 | Pfade mit Umlauten kamen von `git ls-tree` maskiert zurück | `ls-tree -z` | Unit |
| 6, 7 | Warnung nach Deploy nicht zurückgesetzt; Ablaufdatum in der UI und im Job verschieden berechnet | «Aktivität» ist genau ein Feld; Deploy, Rollback, Start, Dateiänderung setzen es | Unit |
| 8 | Aufräumen nach Fehlschlag kannte die erkannte Art von Chat-Projekten nicht | `effectiveKind` | – |
| 9 | Kopieren in die Zwischenablage scheiterte über HTTP (kein sicherer Kontext) – betraf auch den `/etc/hosts`-Block aus M1 | Rückfall über ein Textfeld, Hinweis bei Fehlschlag | – |
| 10 | Ablauf-Job lief erst eine Stunde nach dem Start | erster Lauf nach einer Minute | – |
