# deployer – Spezifikation

Stand: 6. November 2026

deployer bringt ein Projekt mit einem Befehl auf den Homeserver und macht es wahlweise öffentlich über Cloudflare Tunnel, im Heimnetz oder im Tailnet erreichbar. Jedes Deployment wird automatisch auf Sicherheit geprüft, und alles lässt sich per Web-UI oder MCP steuern.

## Ziel und Umfang

Ziel: Ein Projekt soll in unter 5 Minuten von der Idee im Chat oder vom Git-Repo zur erreichbaren URL kommen, ohne Router-Konfiguration und ohne Handarbeit an DNS oder Zertifikaten. deployer ist ein Werkzeug für eine Person (Joël) und einen Homeserver.

**Im Umfang**

- Deployen aus fünf Quellen: direkt aus dem Chat per MCP (ohne Repo), Git-Repo mit Dockerfile, Docker Compose, statische Seiten, fertige Images aus einer Registry
- Pro Projekt wählbar, wo es erreichbar ist: öffentlich über Cloudflare Tunnel, im Heimnetz (LAN), im Tailnet, oder eine Kombination
- Domains und DNS-Einträge über die Cloudflare-API anlegen und entfernen
- Automatische Security-Prüfung nach jedem Deployment, mit Score und Befunden, sowie Erkennung von Angriffsversuchen und Einbruchsindizien
- Befunde direkt beheben: Security-Header per Klick, Codeänderungen mit Claude (Diff oder Pull Request)
- Steuerung über Web-UI und über einen MCP-Server, damit Claude Projekte hochfahren und prüfen kann
- Logs, Status, Redeploy, Rollback auf die vorherige Version

**Bewusst nicht im Umfang**

- Mehrere Server oder Cluster (kein Kubernetes)
- Mehrere Benutzer und Rollen
- Datenbanken als Managed Service (eine Datenbank läuft als normaler Container im Compose-Projekt)
- Aktive Angriffe auf fremde Systeme: Der Scanner prüft ausschliesslich Projekte, die deployer selbst verwaltet, und externe Domains mit Besitznachweis

## Architektur

```mermaid
flowchart TB
    visitors["Besucher im Internet<br/>nur öffentliche Projekte"]
    claude["Claude (MCP-Client)<br/>deployt per Chat"]
    you["Du<br/>Web-UI im LAN oder Tailnet"]
    cf["Cloudflare<br/>DNS, Tunnel, Access"]

    subgraph server["Homeserver · Ubuntu Server, Docker"]
        cfd["cloudflared<br/>Tunnel-Endpunkt"]
        caddy["Caddy<br/>Routing, TLS, IP-Filter"]
        deployer["deployer<br/>UI, API, MCP, PostgreSQL"]
        projects["Projekt-Container<br/>je eigenes Netzwerk"]
        scanner["Scanner<br/>Trivy, ZAP, Nuclei, testssl"]
        proxy["Docker-Socket-Proxy<br/>eingeschränkte Docker-API"]
    end

    visitors -- HTTPS --> cf
    cf -- "Tunnel, nur ausgehend" --> cfd
    cfd --> caddy
    claude -- "MCP, Token" --> caddy
    you -- "LAN oder Tailnet" --> caddy
    caddy --> deployer
    caddy -- "leitet weiter" --> projects
    deployer -- "startet Scans" --> scanner
    deployer -- "startet Container" --> proxy
    scanner -- prüft --> projects
    deployer -. "API: DNS, Tunnel, Access" .-> cf
```

Am Router ist kein Port offen: Öffentlicher Verkehr kommt über den ausgehenden Cloudflare Tunnel, alles andere über LAN oder Tailnet zu Caddy. deployer selbst ist nur intern erreichbar und steuert Cloudflare (DNS, Tunnel, Access) über deren API.

## Funktionen

### Deploy-Quellen

| Quelle | Eingabe | Was deployer tut |
| --- | --- | --- |
| **Direkt aus dem Chat (MCP)** | Dateien, die Claude im Gespräch schreibt (Pfad und Inhalt), kein Repo nötig | Dateien in ein lokales Git-Repo auf dem Server schreiben, Typ erkennen, deployen |
| Git-Repo mit Dockerfile | Repo-URL, Branch oder Tag, Port im Container | Klonen, `docker build`, Container starten |
| Docker Compose | Repo-URL oder hochgeladene `compose.yaml`, Name des Web-Services und Port | `docker compose up -d` mit eigenem Projektnamen |
| Statische Seite | Repo-URL oder ZIP, optional Build-Befehl (z.B. `npm run build`) und Ausgabeordner | Build in einem Wegwerf-Container, Ausgabe über Caddy ausliefern |
| Fertiges Image | Image-Referenz (z.B. `ghcr.io/user/app:1.2`), Port | `docker pull`, Container starten |

### Direkt aus dem Chat

Du beschreibst im Chat, was du willst («Mach mir eine Seite, die den Solarertrag von heute zeigt, nur intern»). Claude schreibt den Code und übergibt die Dateien per MCP an deployer. Ein GitHub-Repo brauchst du dafür nicht.

1. Claude ruft `create_project` mit `source.type: files` und den Dateien auf (Pfad und Inhalt, max. 20 MB pro Aufruf).
2. deployer legt pro Projekt ein lokales Git-Repo auf dem Server an und committet die Dateien. Jede Änderung ist damit eine Version, Rollback funktioniert wie bei jedem anderen Projekt.
3. deployer erkennt den Typ selbst: `compose.yaml` vorhanden → Compose, `Dockerfile` → Image bauen, sonst `package.json` mit Build-Skript → statischer Build, sonst reine HTML-Dateien → statisch ausliefern.
4. Der normale Deploy-Ablauf mit Healthcheck und Security-Scan folgt.
5. Spätere Änderungen («mach den Titel grösser») schickt Claude mit `update_files` nur als geänderte Dateien. Mit `read_files` holt sich Claude den aktuellen Stand, auch in einem neuen Chat.

Das lokale Repo lässt sich jederzeit mit `export_repo` als ZIP holen oder auf GitHub pushen, wenn aus dem schnellen Experiment ein richtiges Projekt wird.

**Automatischer Ablauf.** Chat-Deploys werden nach 30 Tagen ohne Änderung gestoppt, nicht gelöscht. 3 Tage vorher kommt eine Benachrichtigung. Ein gestopptes Projekt lässt sich mit einem Klick oder per MCP (`start`) wieder starten. Die Frist ist einstellbar, und pro Projekt kann der Ablauf mit «behalten» abgeschaltet werden.

Zu jedem Projekt gehören Umgebungsvariablen und Secrets. Secrets werden verschlüsselt gespeichert und nie in Logs oder MCP-Antworten ausgegeben.

### Deploy-Ablauf

1. Quelle holen (Clone, Pull oder Upload) und die genaue Version festhalten (Commit-Hash oder Image-Digest).
2. Bauen, mit Zeitlimit von 10 Minuten und Ressourcenlimits.
3. Neue Container in einem projekteigenen Docker-Netzwerk starten. Kein Container bekommt einen Port am Host.
4. Healthcheck abwarten (HTTP 2xx/3xx auf `/` oder einem konfigurierten Pfad).
5. Erst dann den Verkehr auf die neue Version umschalten. Schlägt etwas fehl, bleibt die alte Version aktiv.
6. Routen setzen (Caddy, Cloudflare), dann den Security-Scan starten.
7. Ergebnis in UI, Log und MCP-Antwort melden. Die letzten 5 Versionen bleiben für ein Rollback erhalten.

### Erreichbarkeit

Pro Projekt lassen sich die Ziele frei kombinieren. Standard für neue Projekte ist **nur intern**, öffentlich wird ein Projekt nur auf ausdrücklichen Wunsch.

| Ziel | Adresse | Technik |
| --- | --- | --- |
| Öffentlich | `projekt.deinedomain.ch` (frei wählbar) | Cloudflare Tunnel: deployer setzt per API eine Ingress-Regel und einen proxied CNAME auf den Tunnel. TLS übernimmt Cloudflare. Keine offenen Ports am Router. |
| LAN | `projekt.int.deinedomain.ch` | Lokaler DNS (Router, AdGuard oder Pi-hole) zeigt `*.int.deinedomain.ch` auf die LAN-IP des Servers |
| Tailnet | `projekt.int.deinedomain.ch` (dieselbe Adresse) | Cloudflare-DNS-Eintrag `*.int.deinedomain.ch` (nicht proxied) auf die Tailscale-IP des Servers |

Damit gilt im Heimnetz und unterwegs dieselbe interne Adresse. Caddy holt dafür ein Wildcard-Zertifikat von Let's Encrypt über die DNS-Challenge bei Cloudflare, also gültiges HTTPS ohne Warnungen. Caddy beantwortet interne Hostnamen nur für Anfragen aus dem LAN-Subnetz und aus dem Tailscale-Bereich `100.64.0.0/10`.

### Cloudflare verbinden

Cloudflare wird vollständig in der Oberfläche eingerichtet (System → «Cloudflare verbinden»), nicht über `.env` oder Compose-Dateien:

1. **Token einfügen.** Ein Link öffnet die Token-Seite bei Cloudflare mit vorausgefüllten Rechten; die Seite listet die nötigen Rechte mit Zweck auf.
2. **Token sofort prüfen:** gültig, aktiv, jedes Recht vorhanden. Fehlende Rechte werden konkret genannt (welches Recht, für welche Zone oder welches Konto). Geprüft wird ohne Seiteneffekt.
3. **Domains wählen:** interne Basisdomain (Präfix + Zone, z.B. `int.deinedomain.ch`) und Standard-Domain für öffentliche Projekte; optional Tailscale-IP, E-Mail für Access und für Let's Encrypt.
4. **Tunnel per API anlegen,** Tunnel-Token holen, `cloudflared` als Container durch deployer selbst starten und verwalten – in einem eigenen Netz nur mit Caddy, damit der Tunnel nie den deployer erreicht. Die Systemseite warnt vor Ingress-Regeln, die nicht auf Caddy zeigen, zeigt die cloudflared-Version und bietet ein Update per Knopf.
5. **Wildcard-Zertifikat:** erst ACME-Staging, dann Produktion, mit sichtbarem Fortschritt. `https://` in Adressen und die Weiterleitung erst, wenn das echte Zertifikat da ist.

Dazu: Verbindung trennen (erst wenn kein Projekt öffentlich ist) und Token ersetzen. Das Token liegt verschlüsselt in der Datenbank wie die übrigen Secrets; Änderungen nur mit Anmeldung, nicht mit einem API-Token. Caddy bekommt das Token als Datei in einem eigenen Volume; seine Konfiguration und `autosave.json` enthalten nur den Pfad. In `.env` bleibt nur, was zum Starten nötig ist; die alten Variablen (`INTERNAL_BASE_DOMAIN`, `TLS_MODE`, `CLOUDFLARE_*`) gelten weiter als Rückfall, solange in der Oberfläche nichts gesetzt ist.

### Domains

- Cloudflare-Zonen des Kontos auflisten und eine als Standard setzen
- Subdomains pro Projekt anlegen, ändern, entfernen; beim Löschen eines Projekts werden seine DNS-Einträge und Tunnel-Regeln mit entfernt
- Optional pro öffentlichem Projekt Cloudflare Access davorschalten (Login per E-Mail-Code), für Seiten, die nur du sehen sollst

### Benachrichtigungen

deployer meldet wichtige Ereignisse per Push und E-Mail. Für Push bietet sich ntfy an (self-hosted als eigenes Projekt oder ntfy.sh), für E-Mail ein beliebiger SMTP-Zugang.

| Ereignis | Standard |
| --- | --- |
| Deploy fehlgeschlagen | Push |
| Neuer kritischer Befund | Push und E-Mail |
| Neuer hoher Befund | E-Mail |
| Projekt wurde öffentlich geschaltet (auch per MCP) | Push |
| Besitznachweis einer externen Domain verloren | E-Mail |
| Tunnel oder Zertifikat mit Problem | Push und E-Mail |
| Einbruchsindiz (Drift, unerwarteter Prozess) | Push und E-Mail |
| Gehäufte Angriffsversuche auf ein Projekt | Push |
| Fix-PR geöffnet oder Befund nach Merge bestätigt behoben | Push |
| Wöchentliche Zusammenfassung (Status, Scores, offene Befunde) | E-Mail |

Jedes Ereignis lässt sich pro Kanal ein- und ausschalten. Benachrichtigungen enthalten nie Secrets.

## Security-Scanner

Jedes Deployment wird automatisch in drei Stufen geprüft, und ein Projekt mit kritischen Befunden wird nicht öffentlich geschaltet. Alle Werkzeuge laufen als Container und werden nur bei Bedarf gestartet.

| Stufe | Wann | Werkzeug | Prüft |
| --- | --- | --- | --- |
| 1. Artefakt | Nach dem Build, vor dem Start | Trivy | Bekannte Schwachstellen (CVEs) im Image, Secrets im Code, Fehlkonfiguration in Dockerfile und Compose (z.B. Container als root, privileged) |
| 2. Laufzeit, passiv | Nach dem Healthcheck | OWASP ZAP Baseline, eigener Header-Check | Security-Header (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors), Cookie-Flags, Informationslecks, gemischte Inhalte |
| 3. Exposition | Nach dem Healthcheck | Nuclei (nur nicht-invasive Templates), testssl.sh | Offen erreichbare Dateien (`.git`, `.env`, Backups), Admin-Panels, Standard-Logins, TLS-Konfiguration |
| Optional: aktiv | Nur auf Knopfdruck | OWASP ZAP Full Scan | Aktive Tests wie XSS und SQL-Injection |

**Regeln für den Scanner**

- Ziele sind ausschliesslich Hostnamen, die deployer verwaltet, oder externe Domains mit Besitznachweis (siehe unten). Eine beliebige URL lässt sich nicht scannen, weder über UI noch über MCP.
- Aktive Scans laufen nur gegen die interne Adresse, nie über Cloudflare, und nur nach ausdrücklicher Bestätigung.
- Wöchentlicher Rescan aller laufenden Projekte, weil neue CVEs auch alte Images betreffen.
- Jeder Befund hat Schweregrad, Beschreibung, betroffene Stelle und einen Lösungsvorschlag. Befunde lassen sich mit Begründung als akzeptiert markieren.

**Externe Domains (Freigabeliste)**

Eigene Seiten, die nicht über deployer laufen (z.B. bei einem Hoster), lassen sich scannen, sobald du den Besitz per DNS nachweist:

1. Hostnamen in der UI oder per MCP (`add_external_target`) eintragen, z.B. `shop.deinedomain.ch`.
2. deployer erzeugt ein zufälliges Token und verlangt einen TXT-Eintrag `_deployer-verify.shop.deinedomain.ch` mit dem Wert `deployer-verify=<token>`. Liegt die Zone im verbundenen Cloudflare-Konto, setzt deployer den Eintrag auf Wunsch selbst.
3. `verify_external_target` prüft den Eintrag über öffentliche DNS-Resolver. Erst danach ist das Ziel freigegeben.
4. Vor jedem Scan prüft deployer den Eintrag erneut. Fehlt er, ist die Freigabe aufgehoben.

Für externe Ziele gelten zusätzliche Grenzen: nur Stufe 2 und 3 (Stufe 1 entfällt, es gibt kein Image), höchstens 5 Anfragen pro Sekunde, aktive Scans nur auf Knopfdruck. Vorher die Bedingungen des Hosters prüfen, manche verbieten Angriffs-Scans auch auf eigene Seiten. Gespeichert wird das im Objekt `ExternalTarget` (`id`, `hostname`, `txt_token`, `verified_at`, `last_check_at`).

Das Scan-Intervall ist pro externer Domain einstellbar: aus, täglich, wöchentlich oder monatlich. Standard ist wöchentlich, nur passiv (Stufe 2 und 3).

**Bewertung**

Der Score startet bei 100. Pro offenem Befund werden abgezogen: kritisch 25, hoch 10, mittel 4, niedrig 1 (Minimum 0). Daraus ergibt sich die Note: A ab 90, B ab 75, C ab 50, D darunter.

Schwelle für «öffentlich»: kein offener kritischer Befund. Wer trotzdem veröffentlichen will, muss den Befund mit Begründung akzeptieren; das wird im Audit-Log festgehalten.

## Angriffserkennung

Der Scanner beantwortet, ob ein Angriff klappen *würde*. Die Angriffserkennung beantwortet, ob jemand angreift und ob etwas durchgekommen ist. Sie arbeitet auf drei Ebenen:

| Ebene | Frage | Werkzeug | Was deployer zeigt |
| --- | --- | --- | --- |
| Versuche, intern und über den Tunnel | Wird ein Projekt gerade angegriffen? | CrowdSec liest die Zugriffs-Logs von Caddy | Angreifer-IP, erkanntes Muster (Port- und Pfad-Scans, Brute-Force auf Logins, bekannte Exploit-Muster), Zeitpunkt, betroffenes Projekt |
| Versuche, öffentlich | Was hat Cloudflare abgefangen? | Cloudflare Security Events über die Analytics-API | Blockierte Anfragen pro Projekt, auslösende Regel, Herkunftsland |
| Erfolg | Ist etwas durchgekommen? | Drift-Prüfung über die Docker-API, optional Falco | Neue oder geänderte Dateien im Container gegenüber dem Image, unerwartete Prozesse (z.B. eine Shell im Web-Container), unerwartete ausgehende Verbindungen |

**Drift-Prüfung.** deployer vergleicht regelmässig das Dateisystem jedes laufenden Containers mit seinem Image (`docker diff`). Ein Web-Container, in dem plötzlich neue ausführbare Dateien liegen, ist ein starkes Einbruchsindiz. Bekannte, gewollte Änderungen (Upload-Ordner, Cache) lassen sich pro Projekt ausnehmen. Falco überwacht zusätzlich Prozesse und Systemaufrufe in Echtzeit, braucht aber Kernel-Zugriff und mehr Ressourcen; es ist deshalb optional.

**Reaktion.**

- CrowdSec sperrt erkannte Angreifer-IPs automatisch über einen Bouncer in Caddy, standardmässig für 4 Stunden.
- Für öffentliche Projekte kann deployer gesperrte IPs zusätzlich als Cloudflare-Regel setzen, damit sie gar nicht erst durch den Tunnel kommen.
- Bei Einbruchsindizien (Drift, unerwarteter Prozess) kommt eine kritische Benachrichtigung per Push und E-Mail. Das Projekt lässt sich mit einem Klick oder per MCP in **Quarantäne** setzen: Container stoppen, Routen entfernen, Zustand für die Analyse aufbewahren. Automatische Quarantäne ist einstellbar, standardmässig aus.

**Wichtig für öffentliche Projekte.** Über den Cloudflare Tunnel kommen alle Anfragen von `cloudflared`. Caddy muss deshalb die echte Besucher-IP aus dem Header `CF-Connecting-IP` übernehmen, und zwar nur von `cloudflared`. Sonst sieht CrowdSec nur eine einzige IP und würde im Ernstfall den eigenen Tunnel sperren.

**Ablage.** Neues Objekt `SecurityEvent` (siehe Datenmodell). Zugriffs-Logs von Caddy werden 30 Tage aufbewahrt; sie enthalten IP-Adressen, also Personendaten von Besuchern öffentlicher Projekte.

**Grenze.** Ob ein Angriff erfolgreich war, lässt sich nie lückenlos beweisen. deployer liefert Indizien und meldet sie früh; die Beurteilung bleibt bei dir.

## Fix-Assistent

Neben jedem Befund bietet deployer einen Weg an, ihn zu beheben statt nur zu akzeptieren. Welcher Weg angeboten wird, hängt vom Befund und von der Quelle des Projekts ab. Jede Änderung braucht deine Zustimmung, erzeugt eine neue Version und wird durch einen Nachscan bestätigt.

### Header über Caddy setzen

Fehlende Security-Header behebt deployer ohne Codeänderung: Caddy ergänzt sie in der Antwort des Projekts. Kein Redeploy nötig, ein Neuladen von Caddy genügt.

| Header | Vorgehen |
| --- | --- |
| `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors` | Ein Klick, sofort aktiv |
| `Content-Security-Policy` | Zuerst als `Content-Security-Policy-Report-Only`. deployer sammelt die Verstösse, die Browser melden, und schlägt daraus eine Regel vor. Erst nach Bestätigung wird sie scharf geschaltet. |
| `Strict-Transport-Security` | Nur bei HTTPS und erst, wenn TLS stabil läuft; kurze `max-age` zum Start |

Setzt die App einen Header selbst, gewinnt der Wert der App; Caddy ergänzt nur, was fehlt. Jede Header-Regel lässt sich pro Projekt wieder entfernen.

Der Header-Check prüft dafür künftig über Caddy, also so, wie Besucher die Seite sehen, und nicht mehr direkt am Container.

### Mit Claude lösen

Für Befunde, die eine Codeänderung brauchen (veraltete Pakete, Dockerfile-Fehlkonfiguration, offen erreichbare Dateien), schlägt Claude eine Änderung vor.

| Quelle | Was passiert |
| --- | --- |
| Chat (`files`) | Vorschlag als Diff in deployer. Nach Bestätigung neue Version im lokalen Repo, Deploy, Nachscan. |
| GitHub- oder GitLab-Repo | Claude erstellt einen Branch `deployer/fix-<befund>`, committet die Änderung und öffnet einen Pull Request bzw. Merge Request mit Befund, Erklärung und Link zum Scan. Nach dem Merge deployt deployer automatisch und scannt nach. |
| Fertiges Image | Kein Eingriff möglich; deployer zeigt nur, welche Image-Version das Problem behebt. |

Nie direkt auf den Standard-Branch pushen, immer über einen eigenen Branch. Branch-Schutzregeln des Repos gelten unverändert.

**Zwei Wege zu Claude:**

1. **Über MCP (Standard).** Der Knopf erzeugt einen fertigen Auftrag («Behebe Befund X in Projekt Y») und kopiert ihn. In Claude oder Claude Code holt sich Claude Befund und Dateien über MCP, schlägt die Änderung vor und spielt sie nach Zustimmung ein bzw. öffnet den PR selbst. Kein API-Schlüssel nötig, läuft über das eigene Abo.
2. **Direkt in deployer (optional).** Mit `ANTHROPIC_API_KEY` in `.env` fragt deployer Claude selbst und zeigt den Vorschlag als Diff in der Oberfläche. Abrechnung pro Nutzung über die API. Ohne Schlüssel ist dieser Weg ausgeblendet.

An Claude gehen nur der Befund und die betroffenen Dateien, nie Secrets oder Werte aus der Projekt-Env.

### Mit GitHub und GitLab verbinden

- **GitHub:** über eine eigene GitHub App, angelegt per App-Manifest mit wenigen Klicks. Du wählst die Repos, für die sie gilt. Rechte nur «Contents: write» und «Pull requests: write». deployer holt pro Vorgang ein Installations-Token, das nach einer Stunde abläuft. Der private Schlüssel der App liegt verschlüsselt wie die Projekt-Secrets.
- **GitLab:** über eine OAuth-App (Rechte `api`, `write_repository`) oder ein Projekt-Zugangstoken pro Repo.
- Die Rückleitung nach der Anmeldung läuft über den Browser, deployer muss dafür nicht öffentlich erreichbar sein.
- Damit werden auch private Repos als Quelle möglich (bisher nur öffentliche).

### Automatisch deployen nach Merge

Pro Projekt einstellbar (`auto_deploy`): deployer prüft alle 5 Minuten, ob der Deploy-Branch einen neuen Commit hat, und deployt dann neu. Kein Webhook, weil deployer nie öffentlich erreichbar ist. Ein Befund, der nach dem Nachscan fehlt, wird als behoben markiert; beim Pull Request hinterlässt deployer einen Kommentar mit dem Ergebnis.

## MCP-Schnittstelle

deployer bietet einen MCP-Server (Streamable HTTP) unter `https://deployer.int.deinedomain.ch/mcp`. Er ist nur aus LAN und Tailnet erreichbar und verlangt ein Bearer-Token pro Client, das sich in der UI erstellen und widerrufen lässt.

| Tool | Parameter | Bestätigung nötig |
| --- | --- | --- |
| `list_projects` | – | Nein |
| `get_project` | `project` | Nein |
| `create_project` | `name`, `source` (Typ `files` mit Dateien, oder Repo, Image, Upload), `port`, `env`, `targets` (`public`, `lan`, `tailnet`), `subdomain` | Ja, wenn `public` dabei ist |
| `update_files` | `project`, geänderte oder gelöschte Dateien, `message`; deployt automatisch neu | Nein |
| `read_files` | `project`, optional `paths` | Nein |
| `export_repo` | `project`, `format` (`zip` oder Push-URL) | Nein |
| `deploy` | `project`, optional `ref` (Branch, Tag, Commit) | Nein |
| `start` / `stop` | `project` | Nein |
| `rollback` | `project`, optional `version` | Ja |
| `delete_project` | `project` | Ja |
| `get_logs` | `project`, `lines` (max. 500), `since` | Nein |
| `set_targets` | `project`, `targets`, `subdomain` | Ja, wenn `public` dazukommt |
| `list_domains` | – | Nein |
| `add_external_target` | `hostname` | Nein |
| `verify_external_target` | `hostname` | Nein |
| `run_scan` | `project` oder externer `hostname`, `level` (`standard` oder `active`) | Ja bei `active` |
| `get_scan_report` | `project`, optional `scan` | Nein |
| `accept_finding` | `project`, `finding`, `reason` | Ja |
| `list_security_events` | `project`, `since`, `severity` | Nein |
| `quarantine_project` | `project` | Ja |
| `get_fix_context` | `project`, `finding` | Nein |
| `set_security_header` | `project`, `header`, `value`, `mode` (`report-only` oder `enforce`) | Ja bei `enforce` für CSP und HSTS |

**Bestätigungen.** Unterstützt der Client MCP-Elicitation, fragt deployer direkt dort nach. Sonst antwortet das Tool mit einer Zusammenfassung und einem `confirmation_token`; erst ein zweiter Aufruf mit diesem Token innerhalb von 5 Minuten führt die Aktion aus. So kann ein Agent nichts versehentlich öffentlich machen oder löschen.

**Beispiel.** «Bau mir eine Seite mit dem Solarertrag von heute und stell sie intern bereit.» → Claude schreibt die Dateien → `create_project` mit `source.type: files` und `targets: [lan, tailnet]` → deployer deployt und scannt → `get_scan_report`. Die Antwort enthält URL, Status, Score und die drei wichtigsten Befunde.

Alle MCP-Aufrufe landen im Audit-Log, mit Client-Name, Tool, Parametern (Secrets maskiert) und Ergebnis.

## Datenmodell und API

Alle Daten liegen in PostgreSQL, als eigener Container im deployer-Stack; Web-UI, REST-API und MCP-Server nutzen dieselbe Service-Schicht, damit sich alle Wege gleich verhalten.

| Objekt | Wichtige Felder |
| --- | --- |
| Project | `id`, `name`, `slug`, `source_type` (`files`, `dockerfile`, `compose`, `static`, `image`), `local_repo_path`, `source_ref`, `port`, `healthcheck_path`, `status` (`running`, `stopped`, `failed`, `deploying`), `keep` (vom Ablauf ausgenommen), `auto_deploy`, `created_at` |
| Deployment | `id`, `project_id`, `version` (Commit-Hash oder Digest), `started_at`, `finished_at`, `result`, `log_ref`, `is_active` |
| Route | `id`, `project_id`, `target` (`public`, `lan`, `tailnet`), `hostname`, `cf_dns_record_id`, `access_protected` |
| Domain | `id`, `cf_zone_id`, `name`, `is_default` |
| ExternalTarget | `id`, `hostname`, `txt_token`, `verified_at`, `last_check_at`, `scan_interval` |
| Secret | `id`, `project_id`, `key`, `value_encrypted` |
| ScanRun | `id`, `deployment_id` oder `external_target_id`, `level`, `started_at`, `score`, `grade` |
| Finding | `id`, `scan_run_id`, `tool`, `severity`, `title`, `location`, `fix`, `status` (`open`, `accepted`, `fixed`), `accept_reason` |
| HeaderRule | `id`, `project_id`, `header`, `value`, `mode` (`report-only`, `enforce`), `created_at` |
| GitConnection | `id`, `provider` (`github`, `gitlab`), `app_id`, `installation_id`, `repos`, `private_key_encrypted`, `created_at` |
| FixRequest | `id`, `finding_id`, `way` (`mcp`, `api`), `status` (`proposed`, `applied`, `pr_open`, `merged`, `verified`, `rejected`), `branch`, `pr_url`, `diff`, `created_at` |
| SecurityEvent | `id`, `project_id`, `source` (`crowdsec`, `cloudflare`, `drift`, `falco`), `severity`, `kind`, `ip`, `details`, `at`, `status` (`open`, `acknowledged`) |
| ApiToken | `id`, `name`, `token_hash`, `last_used_at`, `revoked_at` |
| AuditEvent | `id`, `at`, `actor` (UI oder Token-Name), `action`, `params_masked`, `result` |

**REST-API** unter `/api/v1` (für die UI und für Skripte):

- `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}`
- `POST /projects/{id}/deploy`, `/start`, `/stop`, `/rollback`
- `GET /projects/{id}/logs` (auch als Server-Sent Events für Live-Logs)
- `PUT /projects/{id}/routes`
- `POST /projects/{id}/scans`, `GET /scans/{id}`, `PATCH /findings/{id}`
- `GET/POST /external-targets`, `POST /external-targets/{id}/verify`
- `GET /domains`, `GET /audit`

## Sicherheit von deployer und Betrieb

deployer selbst ist das wertvollste Ziel auf dem Server, weil es Container starten und DNS ändern kann. Deshalb gelten diese Regeln:

- **Nie öffentlich.** UI, API und MCP laufen nur unter `deployer.int.deinedomain.ch`, erreichbar aus LAN und Tailnet. Login per Passkey oder Passwort mit Session; MCP nur mit Token.
- **Docker-Socket abschirmen.** deployer spricht nicht direkt mit `/var/run/docker.sock`, sondern über einen Socket-Proxy, der nur die nötigen API-Bereiche freigibt (Container, Images, Netzwerke, Build).
- **Cloudflare-Token mit minimalen Rechten:** Zone lesen, Zone DNS bearbeiten (nur ausgewählte Zonen), Cloudflare Tunnel bearbeiten, optional Access-Apps bearbeiten. Kein globaler API-Key. Verschlüsselt in der Datenbank, nie in Umgebung, `docker inspect`, Logs oder Caddys Konfiguration.
- **Secrets verschlüsselt.** Der Schlüssel liegt in einer separaten Datei (Rechte 600) und nicht in der Datenbank.
- **Container eingeschränkt.** Keine Host-Ports, kein `privileged`, eigenes Docker-Netzwerk pro Projekt. Caddy und der Scanner werden jeweils nur ins Netzwerk des Projekts gehängt, das sie gerade bedienen.
- **Audit-Log** für jede Änderung, egal ob aus UI, API oder MCP.

### Nicht-funktionale Anforderungen

| Anforderung | Ziel |
| --- | --- |
| Deploy-Zeit, fertiges Image oder statische Seite | unter 2 Minuten bis zur erreichbaren URL |
| Deploy-Zeit, Dockerfile-Build | unter 5 Minuten (abhängig vom Build) |
| Speicherbedarf von deployer im Leerlauf | unter 300 MB RAM (Server: ThinkPad, 16 GB) |
| Standardlimits pro Projekt | 1 CPU, 512 MB RAM, anpassbar |
| Container-Logs | Rotation fest eingestellt: max. 10 MB pro Datei, 5 Dateien pro Container |
| Neustart des Servers | Alle aktiven Projekte, Caddy und `cloudflared` starten von selbst wieder |
| Backup | PostgreSQL-Dump und Projekt-Volumes nächtlich, 7 Generationen |
| Update von deployer | Neues Image ziehen, Datenbank-Migrationen laufen automatisch |

Die feste Log-Rotation ist Absicht: Ohne Grössenlimit können Container-Logs eine Festplatte unbemerkt füllen.

## Tech-Stack und Meilensteine

Vorschlag mit Technik, die du aus dem Alltag kennst (TypeScript, React, Vite, Docker); jeder Punkt lässt sich austauschen.

| Bereich | Wahl | Begründung |
| --- | --- | --- |
| Backend | TypeScript, Node 22, Fastify | Ein Stack für API, MCP und Hintergrundjobs |
| Datenbank | PostgreSQL 17 mit Drizzle ORM | Robust, gute Werkzeuge für Backup und Migrationen |
| Docker-Steuerung | dockerode über einen Docker-Socket-Proxy | Programmierbarer Zugriff, eingeschränkte Rechte |
| Lokale Repos | Git auf dem Server (isomorphic-git oder `git`-CLI) | Versionen für Chat-Deploys |
| MCP | Offizielles TypeScript-SDK `@modelcontextprotocol/sdk`, Streamable HTTP | Standard, funktioniert mit Claude |
| Cloudflare | Schlanker eigener Client über `fetch` | DNS, Tunnel anlegen und konfigurieren, Access, Token-Prüfung (siehe MILESTONE-4.md) |
| Reverse Proxy | Caddy mit Modul `caddy-dns/cloudflare` | Konfiguration per Admin-API zur Laufzeit, automatische Zertifikate |
| Tunnel | `cloudflared` als Container, von deployer gestartet, remote verwaltet | Tunnel und Ingress-Regeln per API, Token als Datei im Container |
| Scanner | Trivy, OWASP ZAP, Nuclei, testssl.sh als Container | Etablierte Open-Source-Werkzeuge, nur bei Bedarf gestartet |
| Angriffserkennung | CrowdSec mit Caddy-Bouncer, Cloudflare Analytics-API, `docker diff`, optional Falco | Etablierte Werkzeuge, CrowdSec läuft als eigener Container |
| Benachrichtigungen | ntfy (Push), SMTP (E-Mail) | Self-hosted möglich, einfache HTTP-API |
| Frontend | React mit Vite | Bekannt aus anderen Projekten |
| Betrieb | Docker Compose auf Ubuntu Server | deployer, Caddy, `cloudflared`, Socket-Proxy und PostgreSQL als ein Stack |

### Meilensteine

Jeder Meilenstein ist für sich nutzbar.

1. **Lokal deployen:** fertige Images und statische Seiten, Caddy mit LAN-Adressen, einfache Web-UI.
2. **Alle Quellen:** Dockerfile, Compose, Healthcheck, Umschalten ohne Ausfall, Rollback.
3. **MCP und Chat-Deploy:** MCP-Server mit Token, Quelle `files` mit lokalem Git-Repo, Bestätigungen.
4. **Tailnet und Zertifikate:** Wildcard-Zertifikat per DNS-Challenge, interne Adresse im LAN und im Tailnet.
5. **Öffentlich:** Cloudflare Tunnel, DNS-Verwaltung, optional Cloudflare Access.
6. **Security:** drei Scan-Stufen, Score, Schwelle für «öffentlich», externe Domains, wöchentlicher Rescan, Benachrichtigungen.
7. **Angriffserkennung:** CrowdSec mit Caddy-Bouncer, Cloudflare Security Events, Drift-Prüfung, Quarantäne; Falco optional. Setzt Meilenstein 5 (Tunnel) und 6 (Benachrichtigungen) voraus.
8. **Fix-Assistent:** Header über Caddy (CSP mit Report-Only), Header-Check über Caddy, Mit Claude lösen über MCP und optional API, GitHub App und GitLab, private Repos, Auto-Deploy nach Merge.

MCP kommt bewusst früh (Meilenstein 3): Ab dann kann Claude beim Weiterbauen von deployer selbst schon Testprojekte deployen.

## Offene Fragen

- [ ] Welche Domain(s) sollen verwaltet werden, und liegen sie schon bei Cloudflare?
- [ ] Läuft im Heimnetz bereits ein lokaler DNS (Router, AdGuard, Pi-hole) für die Weiterleitung von `*.int.deinedomain.ch`?
- [ ] ntfy oder anderer Push-Dienst?
- [x] Scan-Intervall pro externer Domain einstellbar (Standard wöchentlich, nur passiv).
- [x] Benachrichtigungen per Push und E-Mail, siehe Abschnitt Benachrichtigungen.
- [x] Chat-Deploys stoppen nach 30 Tagen ohne Änderung, Frist einstellbar.
