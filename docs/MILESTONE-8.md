# Meilenstein 8 – Fix-Assistent

Stand: 10. November 2026

Umfang laut [SPEC.md](SPEC.md), Abschnitt «Fix-Assistent»: Befunde beheben statt nur akzeptieren. Fehlende Security-Header ergänzt Caddy, Codeänderungen schlägt Claude über MCP vor, und für Git-Repos kommt ein Weg über Pull Requests dazu. Jede Änderung braucht eine Zustimmung, erzeugt eine neue Version oder Caddy-Konfiguration und wird durch einen Nachscan bestätigt.

Gebaut in drei Etappen mit je einem Commit auf dem Branch `milestone-8`. Parallel entstehen auf `main` die live sichtbaren Scan-Stufen (Migration `0007_scan_live.sql`); M8 nimmt deshalb die Migrationsnummern ab `0008`. Beim Zusammenführen sind Konflikte in `security/stages.ts`, `security/scan.ts`, `Security.tsx` und `mcp/server.ts` zu erwarten.

## 1. Grundsätze

- **Zustimmung vor jeder Änderung.** Header, die etwas kaputt machen können (CSP scharf, HSTS), verlangen in der Oberfläche eine Rückfrage und über MCP ein Bestätigungs-Token. Codeänderungen sind zuerst nur ein Vorschlag (Diff).
- **Die App gewinnt.** Caddy ergänzt einen Header nur, wenn die Antwort ihn nicht schon hat. Setzt die App später eigene Header, verdrängt Caddy sie nie.
- **Prüfen wie Besucher.** Der Header-Check geht künftig durch Caddy, also mit allen Headern, die Caddy ergänzt.
- **Nie Secrets an Claude.** `get_fix_context` liefert Befund, Erklärung und betroffene Dateien. Werte aus der Projekt-Env und Zeilen, in denen Trivy ein Secret gefunden hat, werden vorher ersetzt; `.env`-Dateien gehen nie hinaus.
- **Nie direkt auf den Standard-Branch.** Über GitHub immer ein eigener Branch `deployer/fix-<befund>` und ein Pull Request.

## 2. Etappe 1 – Header über Caddy

### Datenmodell (Migration 0008)

- `header_rules`: `id`, `project_id`, `header`, `value`, `mode` (`report-only`, `enforce`), `report_key`, `created_at`, `updated_at`; eine Regel pro Projekt und Header.
- `csp_violations`: gemeldete Verstösse, zusammengefasst je Projekt, Direktive und blockierter Quelle (`count`, `first_seen`, `last_seen`, Beispielpfad); höchstens 300 verschiedene pro Projekt.

### Header und Vorgehen

| Header (Schlüssel) | Was Caddy ergänzt | Zustimmung |
| --- | --- | --- |
| `x-content-type-options` | `X-Content-Type-Options: nosniff` | ein Klick |
| `referrer-policy` | `Referrer-Policy: strict-origin-when-cross-origin` | ein Klick |
| `frame-ancestors` | `Content-Security-Policy: frame-ancestors 'self'` und `X-Frame-Options: SAMEORIGIN`, jeweils nur wenn die App keinen eigenen setzt | ein Klick |
| `content-security-policy` | zuerst `Content-Security-Policy-Report-Only: <regel>; report-uri <deployer>`; nach Bestätigung `Content-Security-Policy` | Report-Only ein Klick, scharf mit Rückfrage |
| `strict-transport-security` | `Strict-Transport-Security: max-age=300` (5 Minuten zum Start) | Rückfrage; nur bei HTTPS und wenn TLS stabil läuft |

- **Nur ergänzen:** pro Header ein eigener `headers`-Handler mit `require` (Header fehlt) und `deferred` – entspricht `header ?Name Wert` im Caddyfile.
- **frame-ancestors** steckt in der CSP. Gibt es zugleich eine scharfe CSP-Regel, wird die Direktive dort angehängt; setzt die App eine eigene CSP ohne `frame-ancestors`, deckt `X-Frame-Options` die Lücke.
- **HSTS** nur auf den HTTPS-Routen und nur, solange Caddy das Wildcard-Zertifikat mit der Produktions-CA verwaltet. «Stabil» heisst: Phase «HTTPS aktiv» unter System → Cloudflare. Fällt TLS zurück (Staging, aus), nimmt der nächste Abgleich HSTS sofort heraus; die kurze `max-age` begrenzt, wie lange Browser sich erinnern.

### CSP mit Report-Only

1. «Report-Only starten» setzt eine Ausgangsregel (`default-src 'self'; …`) mit `report-uri` auf deployer.
2. Browser melden Verstösse an `POST /api/v1/csp-reports/<report_key>` (ohne Anmeldung, aber nur mit dem zufälligen Schlüssel der Regel; Formate `application/csp-report` und `application/reports+json`; höchstens 64 KB).
3. deployer fasst sie zusammen und schlägt daraus eine Regel vor (reine Funktion `suggestCsp`): erlaubte Quellen je Direktive, `'self'` für die eigene Herkunft; Inline-Skript wird nicht stillschweigend mit `'unsafe-inline'` erlaubt, sondern als Hinweis gezeigt.
4. «Vorschlag übernehmen» ändert die Report-Only-Regel; «Scharf schalten» (mit Rückfrage) setzt `Content-Security-Policy`.

**Woher Meldungen kommen dürfen:** Die `report-uri` zeigt auf deployers eigene Adresse. Caddy lässt diesen Namen nur aus LAN und Tailnet durch; ausserdem erreichen Container im Projekt-Netz deployer direkt, solange er dort hängt. Aus dem Internet (Tunnel) kommt nichts an – Verstösse öffentlicher Besucher fehlen deshalb, das ist gewollt (deployer bleibt intern).

### Header-Check über Caddy

Caddys IP-Filter würde den deployer selbst aussperren: seine Adresse im Netz `edge` liegt weder im LAN noch im Tailnet, und das Netz freizugeben hiesse, auch Verkehr durchzulassen, den Docker über das Gateway desselben Netzes weiterreicht (Begründung in MILESTONE-6, Abschnitt 1).

Lösung: ein **dritter Caddy-Server auf einem Unix-Socket** (`/run/caddy/probe.sock`, im selben Volume wie der Admin-Socket). Er kennt dieselben Namen und Handler wie die Besucher-Server – inklusive der ergänzten Header –, aber ohne IP-Filter. Über das Netz ist ein Unix-Socket nicht erreichbar; nur deployer und Caddy sehen die Datei. Der Filter für fremde Absender bleibt unverändert.

- Für Namen unter der Basisdomain (bei aktivem Zertifikat) bildet der Probe-Server die HTTPS-Route nach: dieselben Header inklusive HSTS, und die App bekommt `X-Forwarded-Proto: https` wie bei einem Besucher.
- Der Header-Check fragt `http://<projektname>/` über den Socket. Hat das Projekt keine Caddy-Route (etwa nur öffentlich ohne Tunnel), prüft er wie bisher direkt am Container und vermerkt das an der Stufe.
- Statische Seiten werden damit erstmals so geprüft, wie Caddy sie ausliefert.

### Nachscan

Nach jedem Setzen oder Entfernen einer Regel: Caddy abgleichen, dann **nur die Stufe «headers»** erneut prüfen. Das Ergebnis fliesst in den letzten abgeschlossenen Scan: verschwundene Header-Befunde werden «behoben», neue kommen dazu, Score und Note werden neu gerechnet, die Stufe bekommt den Vermerk «Nachscan». Ein eigener Scan-Lauf nur mit Headern würde sonst die Befunde aller anderen Werkzeuge im «letzten Scan» verstecken.

### Schnittstellen

- REST: `GET /projects/{id}/header-rules` (Regeln, gesammelte Verstösse, Vorschlag, ob HSTS möglich ist), `PUT /projects/{id}/header-rules/{header}` (`value`, `mode`, `confirm`), `DELETE /projects/{id}/header-rules/{header}`, `POST /csp-reports/{key}` (offen).
- MCP: `set_security_header` mit `project`, `header`, `value`, `mode` (`report-only`, `enforce`), `remove`; Bestätigung bei `enforce` für CSP und HSTS.
- UI: neben jedem Header-Befund «Header setzen» (bzw. «Report-Only starten», «HSTS setzen …») statt nur «Akzeptieren»; Abschnitt «Header über Caddy» im Security-Reiter mit aktiven Regeln, Entfernen, CSP-Verstössen und Vorschlag.

## 3. Etappe 2 – «Mit Claude lösen» über MCP

### Datenmodell (Migration 0009)

`fix_requests`: `id`, `project_id`, `finding_id`, `fingerprint`, `finding_title`, `way` (`mcp`, `api`, `github`), `status` (`proposed`, `applied`, `pr_open`, `merged`, `verified`, `rejected`, `failed`), `explanation`, `diff`, `changes` (Dateien zum Anwenden), `base_commit`, `commit`, `deployment_id`, `branch`, `pr_url`, `note`, `created_at`, `updated_at`.

### Ablauf

1. Knopf «Mit Claude lösen» am Befund: zeigt einen fertigen Auftrag zum Kopieren («Behebe Befund X in Projekt Y …» mit Projekt-Slug und Befund-ID).
2. In Claude oder Claude Code: `get_fix_context(project, finding)` liefert Befund, Erklärung, empfohlenen Weg und die betroffenen Dateien (nie Secrets, nie Env-Werte).
3. Je nach Quelle:
   - **Header-Befund:** Hinweis auf `set_security_header`, keine Codeänderung.
   - **Chat (`files`):** `propose_fix(project, finding, files, delete, explanation)` legt einen Vorschlag mit Diff an. Er erscheint im Security-Reiter; «Übernehmen» (Rückfrage) bzw. `apply_fix` mit Bestätigungs-Token erzeugt eine neue Version im lokalen Repo, deployt und scannt nach. Verschwindet der Befund, wird der Vorschlag «bestätigt».
   - **Fertiges Image:** kein Eingriff. deployer zeigt, welche Paketversion den Fehler behebt, und sucht in der Registry nach neueren Tags derselben Linie (z.B. `1.21-alpine` → `1.27-alpine`) als Kandidaten.
   - **Git-Repo:** Pull Request über die GitHub App (Etappe 3); bis dahin der Hinweis, die Änderung im Repo zu machen.
4. Ein Vorschlag gilt nur für den Stand, auf dem er beruht (`base_commit`); hat sich das Repo inzwischen geändert, verweigert «Übernehmen» und verlangt einen neuen Vorschlag.

## 4. Etappe 3 – GitHub (vorbereitet, Anlegen der App durch Joël)

### Datenmodell (Migration 0010)

`git_connections`: `id`, `provider` (`github`, `gitlab`), `app_id`, `app_slug`, `client_id`, `installation_id`, `repos`, `private_key_encrypted`, `client_secret_encrypted`, `webhook_secret_encrypted`, `created_at`. Dazu `projects.auto_deploy` (falls noch nicht vorhanden) und `projects.auto_deploy_checked_at`.

### GitHub App per Manifest

- System → GitHub: «GitHub App anlegen» schickt ein Formular mit dem App-Manifest an GitHub (`/settings/apps/new`). Name `deployer-<server>`, nicht öffentlich, ohne Webhook (deployer ist nie öffentlich erreichbar), Rechte nur **Contents: write** und **Pull requests: write** (GitHub fügt «Metadata: read» immer hinzu).
- GitHub leitet den Browser zurück auf deployer (`/api/v1/github/manifest/callback?code=…&state=…`); deployer tauscht den Code gegen App-ID, privaten Schlüssel und Client-Secret und speichert sie verschlüsselt wie die Projekt-Secrets. Die Rückleitung läuft über den Browser, deployer muss dafür nicht öffentlich sein.
- Danach «App installieren» (Repos auswählen); GitHub leitet mit `installation_id` zurück.
- Pro Vorgang ein Installations-Token (JWT mit dem App-Schlüssel signiert, Token läuft nach einer Stunde ab), beschränkt auf das eine Repo.

### Fix als Pull Request

`propose_fix` für ein GitHub-Projekt legt Branch `deployer/fix-<kurz-id>` an, committet die Änderung über die Git-Data-API und öffnet einen Pull Request mit Befund, Erklärung und Link zum Scan. Status `pr_open`.

### Auto-Deploy nach Merge

Alle 5 Minuten (kein Webhook): Projekte mit `auto_deploy` vergleichen den Kopf des Deploy-Branches mit der aktiven Version und deployen bei einem neuen Commit. Offene Pull Requests von deployer werden abgefragt; nach dem Merge Status `merged`, nach dem Nachscan `verified` und ein Kommentar mit dem Ergebnis am Pull Request.

### Wo Joël übernimmt

Alles ist gebaut und mit einer GitHub-Attrappe getestet. Angehalten wird **vor dem Anlegen der App**: Joël öffnet System → GitHub, klickt «GitHub App anlegen», bestätigt bei GitHub und installiert die App für die gewünschten Repos. Die Schritte stehen in `docs/INSTALL.md`.

GitLab (OAuth-App oder Projekt-Token) ist im Datenmodell vorgesehen, aber nicht gebaut.

## 5. Prüfung pro Etappe

- Unit-Tests: `pnpm --filter @deployer/api test`; Typecheck: `pnpm -r typecheck`.
- Etappe 1 zusätzlich gegen ein echtes Caddy (Wegwerf-Container): `scripts/caddy-headers-e2e.ts`.
- Screenshots Hell und Dunkel mit `packages/web/design-shots/` (nur Desktop), Impeccable nur als Gutachter.
- Pro Etappe ein lokaler Commit, kein Push.

## Abnahmekriterien

### Etappe 1

Stand 10.11.2026. Geprüft mit Unit-Tests (468, alle grün), gegen ein echtes Caddy im Wegwerf-Container (`scripts/caddy-headers-e2e.ts`, 13 Prüfungen) und gegen ein Wegwerf-Postgres (Migration, Service, REST über `inject`, MCP über einen In-Memory-Client). **Nicht** geprüft im laufenden Stack: der läuft von `main` und wird parallel benutzt; der Gesamtweg Oberfläche → API → Caddy → Nachscan ist deshalb nur in Teilen belegt.

- [x] Ein Klick auf «Header setzen» bei «X-Content-Type-Options: nosniff fehlt», «Referrer-Policy fehlt» und «Schutz gegen Einbetten fehlt» lässt Caddy den Header ergänzen, ohne Redeploy – *Konfiguration gegen echtes Caddy; Knopf → API im Screenshot-Werkzeug, nicht im Stack*
- [x] Setzt die App einen Header selbst, bleibt ihr Wert (echtes Caddy)
- [x] CSP startet als `Content-Security-Policy-Report-Only` mit `report-uri`; gemeldete Verstösse erscheinen zusammengefasst, der Vorschlag lässt sich übernehmen; scharf erst nach Rückfrage bzw. Bestätigungs-Token
- [x] HSTS lässt sich nur bei HTTPS mit Produktions-Zertifikat setzen, mit `max-age=300`; ohne TLS lehnt deployer mit Begründung ab, und ein Rückfall auf Staging nimmt HSTS aus der Konfiguration – *HTTPS-Fall nur als Konfiguration (Unit), ohne echtes Zertifikat*
- [x] Der Header-Check geht über Caddy (Probe-Socket) und sieht die ergänzten Header; der IP-Filter für fremde Absender ist unverändert (echtes Caddy: Besucher-Port 403, Probe-Socket 200; Socket übersteht einen Neustart von Caddy mit Volume)
- [x] Nach dem Setzen läuft der Nachscan der Stufe «headers» automatisch; behobene Befunde stehen als «behoben», Score und Note steigen – *Planung als reine Funktion getestet; der Ablauf im Stack ist offen*
- [x] Jede Regel lässt sich entfernen; danach fehlt der Header wieder und der Befund ist wieder offen (echtes Caddy, Unit)
- [x] `set_security_header` über MCP, mit Bestätigung bei `enforce` für CSP und HSTS; Audit-Log
- [x] Report-Endpunkt: ohne gültigen Schlüssel 404, zu grosse Meldungen 413, höchstens 300 verschiedene Verstösse pro Projekt, ohne Anmeldung nur dieser eine Pfad

**Fehler, den erst das echte Caddy gezeigt hat:** Die kleine CSP `frame-ancestors 'self'` liess den Header-Check glauben, es gebe eine CSP – «Content-Security-Policy fehlt» verschwand, ohne dass etwas vor XSS schützte. Jetzt zählt eine CSP nur mit `default-src` oder `script-src`. Titel unverändert, damit Fingerabdrücke und Akzeptanzen bleiben. Folge: Apps mit einer CSP ganz ohne Quellen-Direktive bekommen den Befund jetzt neu.

**Gutachten (Impeccable, nur audit/critique):** behoben – Meldung nach einer Aktion stand ausser Sicht (jetzt dauerhafter Live-Bereich, oben eingeblendet bzw. direkt unter der Regel-Tabelle), Fokus fiel nach «Abbrechen» auf `body`, Rückfragen schlossen vor dem Ende des Speicherns (Doppelklick möglich), Autofokus lag auf «Ja, …» statt «Abbrechen», HSTS-Rückfrage widersprach der Behebungszeile (300 statt 31536000 erklärt), gesperrter HSTS-Knopf war nicht fokussierbar (jetzt `aria-disabled` mit Begründung), parallele Header-Aktionen (jetzt gemeinsamer Mutations-Schlüssel), widersprüchliche Stufe in den Screenshot-Daten. Nicht umgesetzt (Stil): Gewichtung der Knöpfe.

Screenshots: `docs/design-cal/m8-etappe1/` (Hell und Dunkel, 1440 px).

### Etappe 2

- [ ] «Mit Claude lösen» zeigt einen kopierbaren Auftrag mit Projekt und Befund
- [ ] `get_fix_context` liefert Befund, Erklärung, Weg und Dateien – ohne Env-Werte, ohne Secret-Zeilen, ohne `.env`-Dateien
- [ ] `propose_fix` bei einem Chat-Projekt legt einen Vorschlag mit Diff an; «Übernehmen» bzw. `apply_fix` (Bestätigung) erzeugt einen Commit, deployt und scannt nach; ein verschwundener Befund macht den Vorschlag «bestätigt»
- [ ] Ein veralteter Vorschlag (Repo inzwischen geändert) wird nicht übernommen
- [ ] Bei fertigen Images: Hinweis mit behebender Paketversion und Tag-Kandidaten aus der Registry

### Etappe 3

- [ ] Manifest für die GitHub App mit genau Contents: write und Pull requests: write, ohne Webhook
- [ ] Rückleitung tauscht den Code gegen die App-Daten und speichert Schlüssel und Secrets verschlüsselt (Test mit Attrappe)
- [ ] Installations-Token pro Vorgang, auf das Repo beschränkt (JWT-Test)
- [ ] Fix als Branch `deployer/fix-…` und Pull Request, nie auf den Standard-Branch (Attrappe)
- [ ] Auto-Deploy-Polling deployt bei neuem Commit und markiert gemergte Pull Requests (Attrappe)
- [ ] Anleitung in INSTALL.md; angehalten vor dem Anlegen der echten App
