# Offene Fragen und getroffene Annahmen

Während der Nacht vom 6. auf den 7. November 2026 gab es niemanden zum Fragen. Wo etwas unklar war, habe ich die vernünftigste Annahme getroffen und hier festgehalten. Jede Zeile lässt sich umentscheiden; der Verweis zeigt, wo die Annahme im Code oder Plan steckt.

Format: **Frage** – getroffene Annahme – *wo*.

## Allgemein

- **Meilenstein 7 (Angriffserkennung: CrowdSec, Cloudflare Security Events, Drift-Prüfung, Quarantäne)** wurde wie beauftragt nicht gebaut. Die MCP-Werkzeuge `list_security_events` und `quarantine_project` fehlen deshalb; ebenso das Objekt `SecurityEvent`. – *docs/SPEC.md, Meilensteine*
- **Installierte Skills einchecken?** Nein. `.agents/` und `.claude/skills/` (zusammen rund 77 MB) lassen sich aus `skills-lock.json` wiederherstellen und sind wie `node_modules` ignoriert. Eingecheckt sind `skills-lock.json` und `.claude/agents/`. – *.gitignore*
- **Git-Repository anlegen?** Der Ordner war kein Repository; für die verlangten Commits habe ich `git init` ausgeführt. Commits nur lokal, kein Remote, keine Co-Authored-By-Zeile (globale Regel). – *.git*
- **Arbeitsdateien.** Testdaten und Zwischenstände liegen in `.tmp/` im Projektordner (ignoriert), damit nichts ausserhalb des Ordners geschrieben wird. Ausnahmen, die sich nicht vermeiden lassen: Docker-Images, -Container, -Volumes und -Netze auf dem lokalen Docker sowie der pnpm-Paketspeicher. – *.tmp/*
- **Wechselnde IP des Servers.** In der Nacht hat der Mac per DHCP eine neue Adresse bekommen; die nip.io-Adressen änderten sich mit. Der deployer zieht beim Neustart nach (`SERVER_LAN_IP` anpassen), aber Links in Lesezeichen brechen. Annahme: Der Server bekommt eine feste IP oder eine DHCP-Reservierung. – *.env, SERVER_LAN_IP*

## Meilenstein 2

- **Private Repos?** Nicht in M2. Nur öffentliche Repos über `https://` (oder `http://` im LAN). Zugangsdaten in der URL werden abgelehnt, weil sie sonst in Logs und Datenbank landen. Für private Repos wäre ein Deploy-Key pro Projekt der saubere Weg. – *lib/repo-url.ts*
- **Weiterleitungen bei Git?** Werden nicht verfolgt (`http.followRedirects=false`): Die geprüfte Adresse wird für den Clone festgeschrieben, eine Weiterleitung auf einen anderen Host würde diese Prüfung umgehen. Folge: `http://` auf einen Server, der nach `https://` umleitet, scheitert – dann gleich die `https://`-URL angeben. – *lib/git.ts*
- **Symlinks im Repo?** Werden als einfache Textdatei ausgecheckt (`core.symlinks=false`). Sonst könnte ein Repo z.B. `env_file` auf `/proc/self/environ` zeigen lassen und die Umgebung des deployers in einen Container leiten. Repos, die Symlinks wirklich brauchen, funktionieren damit nicht. – *lib/git.ts, lib/repo-files.ts*
- **Compose ohne Ausfall?** Nein, an Ort und Stelle (`up -d`). Ein zweites Compose-Projekt neben dem alten würde benannte Volumes gleichzeitig benutzen – eine Datenbank liefe zweimal auf denselben Dateien. Geänderte Dienste starten kurz neu. Image-, Dockerfile- und statische Projekte schalten ohne Ausfall um. – *deploy/pipeline.ts, runCompose*
- **Bind-Mounts in Compose, auch relativ ins Repo?** Abgelehnt. Die CLI läuft im deployer-Container und gäbe dem Host-Daemon Pfade wie `/data/work/...`, die es auf dem Host nicht gibt – der Dienst bekäme einen leeren Ordner. Konfigurationsdateien gehören ins Image. – *lib/compose.ts*
- **`${VAR}` in einer compose.yaml?** Wird nicht ersetzt, `$` bleibt wörtlich. Compose nähme die Werte sonst aus der Umgebung des deployers (Datenbank-URL, Passwörter). Werte kommen über die Projekt-Env. Ebenso abgelehnt: `environment`-Einträge ohne Wert. – *lib/compose.ts, drivers/compose-cli.ts*
- **Grenzen bei Compose.** Jeder Dienst bekommt die Grenzen des Projekts (z.B. 512 MB), nicht einen Anteil davon. Drei Dienste können zusammen also das Dreifache belegen. Eigene `mem_limit`/`deploy`-Angaben werden abgelehnt. – *lib/compose.ts*
- **Volumes beim Löschen.** Benannte Volumes (z.B. einer Datenbank) bleiben beim Löschen erhalten, ausser der Haken «Auch die Daten-Volumes löschen» ist gesetzt. Ein neues Projekt mit demselben Slug fände die alten Daten wieder. – *domain/projects.ts*
- **Env bei statischen Builds.** Der Build-Container bekommt nur die nicht-geheimen Variablen: was dort hineingeht, kann in der ausgelieferten Seite landen. – *domain/env.ts, resolvePublicEnv*
- **Grenzen für Builds.** 2 GB Speicher, 2 CPUs, 10 Minuten – als Konstanten, nicht pro Projekt einstellbar. – *deploy/sources/dockerfile.ts*
- **Quellenart wechseln?** Nicht per PATCH: Compose-Dienste werden anders verwaltet als einzelne Container, beim Wechsel blieben Reste. Für eine andere Art ein neues Projekt anlegen. – *http/routes/projects.ts*
- **Rollback und Umgebungsvariablen.** Ein Rollback nimmt die heutigen Variablen, nicht die damaligen. Dafür liegen in den aufbewahrten Artefakten keine Secrets. – *deploy/sources/compose.ts*
- **Aufbewahrung.** Die letzten 5 erfolgreichen Fassungen (Rollback-Ziele) und die letzten 10 fehlgeschlagenen Versuche (wegen ihrer Logs). – *deploy/pipeline.ts, pruneOldDeployments*

## Meilenstein 3

- **API-Tokens auch für REST?** Ja, damit Skripte die API nutzen können (SPEC: «für die UI und für Skripte»). **Tokens verwalten** geht aber nur mit Anmeldung: Ein gestohlenes Token könnte sich sonst ein zweites anlegen und den Widerruf überdauern. – *http/auth.ts*
- **Hash der Tokens.** SHA-256 statt scrypt: Die Tokens sind 32 Zufallsbytes; Wörterbuchangriffe, gegen die ein langsamer Hash hilft, greifen nicht. – *lib/tokens.ts*
- **Warten MCP-Werkzeuge auf den Deploy?** Ja, standardmässig (`wait: true`, höchstens 10 Minuten). Ein Agent soll ohne Nachfragen wissen, ob es geklappt hat; bei Fehlern kommen die letzten 20 Log-Zeilen mit. `wait: false` antwortet sofort. – *mcp/server.ts*
- **Keep-Alive auf der deployer-Route.** Caddy setzt dort `Connection: close`. Grund: MCP antwortet per SSE; lädt ein Deploy Caddy neu, schliesst Caddy die Verbindung nach der Antwort, ohne dass der Client es weiss – sein nächster Aufruf scheiterte. Im LAN kostet eine neue TCP-Verbindung pro Anfrage nichts; mit HTTP/2 ab M4 entfällt das Problem. Projekt-Routen behalten Keep-Alive. – *drivers/caddy-config.ts*
- **Caddy neu laden nur bei Änderung.** Verglichen wird kanonisch mit Caddys tatsächlich geladener Konfiguration. Ein Image-Redeploy ändert den Upstream (neuer Container) und lädt deshalb weiterhin neu. Mögliche Verbesserung: ein stabiler Netz-Alias pro Projekt, der nach dem Healthcheck auf den neuen Container wandert – dann bräuchte ein Redeploy gar kein Neuladen. Nicht umgesetzt. – *domain/routes.ts*
- **Port bei Chat-Projekten.** Die Art wird erst beim Deploy erkannt. Wird ein Chat-Projekt zum Dockerfile- oder Compose-Projekt, braucht es einen Port; `update_files` nimmt dafür `port` an. Ohne Port scheitert der Deploy mit klarer Meldung. – *deploy/pipeline.ts, runFiles*
- **Vorgaben bei Chat-Projekten.** Compose: Web-Dienst `web`. Statischer Build: `npm run build`, Ausgabe `dist`. Beides über `source` änderbar. – *deploy/sources/files.ts*
- **Deploy auf einen bestimmten Stand.** Bei Chat-Projekten nimmt `deploy` als `ref` nur einen Commit-Hash an, keine Branches. – *deploy/sources/files.ts*
- **export_repo mit push.** Veröffentlicht Code auf einem fremden Server – nur auf ausdrücklichen Aufruf, mit derselben URL-Prüfung wie beim Clone; das Zugangs-Token wird weder gespeichert noch geloggt. In der Nacht nur gegen einen lokalen Git-Server getestet, nie gegen GitHub. – *lib/git.ts, pushRepo*
- **MCP-Sitzungen** liegen im Speicher. Ein Neustart des deployers beendet sie; Clients verbinden sich neu. – *mcp/http.ts*
- **«Läuft bald ab»** landet in M3 nur im Audit-Log; Push und E-Mail kommen mit M6. – *jobs/expiry.ts*
- **Tests der Werkzeuge.** Statt der geplanten In-Memory-Tests laufen die Werkzeuge Ende-zu-Ende mit dem offiziellen MCP-Client über HTTP gegen den echten Stack: Sie brauchen ohnehin Datenbank und Docker. – *e2e/m3.e2e.ts*

## Meilenstein 6

- **Scan vor oder nach dem Start?** Nach einem erfolgreichen Deploy, im Hintergrund. Die SPEC nennt Stufe 1 «vor dem Start», verlangt aber keine Blockade. Trivy mit Datenbank-Update und ZAP dauern Minuten; vorgeschaltet würden Deploys die Zeitziele reissen. Die Schwelle, auf die es ankommt (öffentlich), wirkt unabhängig davon. Abschaltbar mit `SCAN_AFTER_DEPLOY=off`. – *deploy/pipeline.ts, config.ts*
- **Welche CVEs zählen?** Nur solche mit verfügbarem Fix (`--ignore-unfixed`), zusammengefasst je Paket mit der höchsten Schwere. Ungefixte CVEs kann niemand beheben; eine Debian-Basis hätte sonst sofort Score 0 und der Score sagte nichts mehr aus. – *security/parsers.ts*
- **Wo prüft der Header-Check?** Direkt am Container, nicht über Caddy. Header, die Caddy später zentral setzen könnte, fehlen also im Befund, solange die App sie nicht selbst setzt – das ist gewollt, weil es heute keine zentrale Header-Regel gibt. HSTS und gemischte Inhalte zählen nur bei HTTPS (ab M4 bzw. extern). – *security/headers.ts*
- **Statische Seiten scannen.** Statische Seiten haben keinen eigenen Container. Für den Scan startet deployer einen kurzlebigen Caddy (`caddy file-server`, dasselbe Image wie im Stack), der den Seitenordner nur lesend einbindet. Er liefert wie der echte Caddy auch Punktdateien wie `.env` aus; ein zuerst verwendeter busybox-httpd verweigerte sie, und Nuclei übersah so genau die offene `.env` (gefunden in der Abnahme). Header setzt keiner von beiden; der Header-Check bewertet also, was die Seite heute tatsächlich ausliefert. – *security/stages.ts, startStaticTarget*
- **TXT-Nachweis: wie viele Resolver?** Zwei von drei (1.1.1.1, 8.8.8.8, 9.9.9.9) müssen den Eintrag liefern. Einer allein kann gerade ausfallen oder veraltet sein; alle drei zu verlangen, scheiterte an jeder Störung. – *security/external.ts*
- **Wo stehen die Einstellungen der Benachrichtigungen?** In der Datenbank (`app_settings`), nicht in `.env` wie im Plan: Die SPEC verlangt «pro Ereignis und Kanal schaltbar» in der UI, und ein Neustart pro Änderung wäre unpraktisch. ntfy-Token und SMTP-Passwort liegen verschlüsselt (gleicher Schlüssel wie die Projekt-Secrets) und kommen nie zurück an die UI. Ändern geht nur mit Anmeldung, nicht mit API-Token. – *notify/send.ts, http/auth.ts*
- **Ereignisse.** Die acht Ereignisse aus dem Plan, mit den Standards von dort. «Tunnel oder Zertifikat mit Problem» heisst im Code `infra_problem` und wird erst ab M4/M5 ausgelöst; «Projekt öffentlich» erst ab M5. – *notify/render.ts*
- **Externe Ziele: TLS ohne Zertifikat?** testssl.sh läuft extern immer, intern erst ab M4. – *security/scan.ts*
- **Ein externer Scan scheitert am Netz.** Externe Ziele laufen über das eigene Netz `dep_ext-scan` mit Internetzugang; im Docker Desktop des Macs geht das, ohne Internetzugang auf dem Server scheitert der Scan mit Meldung. Eine echte externe Domain wurde in der Nacht nicht gescannt (keine verfügbar). – *security/scan.ts*
- **Wöchentliche Zusammenfassung.** Kein fester Wochentag: Der Job prüft stündlich (erstmals fünf Minuten nach dem Start) und verschickt sie, wenn die letzte sieben Tage zurückliegt. Die erste geht also kurz nach der Inbetriebnahme raus. – *jobs/security.ts*
- **Externes Ziel zeigt ins LAN?** Vor dem Nachweis und vor jedem Scan löst deployer den Namen über 1.1.1.1 auf; zeigt auch nur eine Adresse in einen privaten, Loopback-, CGNAT- oder Link-local-Bereich, gibt es keinen Scan. **Rest-Risiko:** Die Scanner lösen den Namen danach selbst auf. Wer den DNS-Eintrag zwischen Prüfung und Scan umstellt (DNS-Rebinding), könnte sie trotzdem ins LAN lenken. Dagegen hülfe nur eine Firewall-Regel für das Netz `dep_ext-scan` auf dem Server (kein Verkehr in private Bereiche); das geht über Docker allein nicht und ist nicht umgesetzt. Voraussetzung für den Missbrauch ist ein gültiges API-Token. – *security/external.ts*
- **get_scan_report wartet höchstens 50 Sekunden.** MCP-Clients brechen meist nach 60 s ab; ein länger laufender Scan liefert den Zwischenstand mit dem Hinweis, erneut zu fragen. – *mcp/server.ts*
- **Fingerabdruck.** Wo Titel oder Ort von Lauf zu Lauf schwanken (Anzahl CVEs, installierte Version, Image-Tag, erste ZAP-Fundstelle, «+N ähnliche» bei Nuclei), bildet ein stabiler Schlüssel den Fingerabdruck: Paket, ZAP-Regel, Pfad. Eine Akzeptanz überlebt damit neue Deploys und neue CVEs desselben Pakets – solange der höchste Schweregrad gleich bleibt; wird das Paket kritischer, ist es ein neuer Befund. – *security/parsers.ts*
- **«Behoben»** heisst: Das Werkzeug lief diesmal vollständig und fand den Befund nicht mehr. Scheiterte eine Stufe, bleiben ihre alten Befunde offen. – *security/scan.ts, toolsChecked*
- **Wöchentlicher Rescan** betrifft nur Projekte, die laufen sollen (`desiredState = running`); gestoppte Projekte haben kein Laufzeit-Ziel. – *jobs/security.ts*

## Meilenstein 4 (Code, ungetestet gegen echte Dienste)

- **TLS nur über eine Compose-Ergänzung.** `compose.tls.yaml` baut Caddy mit dem DNS-Modul und öffnet :443. Ohne sie läuft alles wie bisher über HTTP; so bleibt der lokale Betrieb auf dem Mac testbar und ein fehlendes Token bricht den Basis-Stack nicht. – *compose.tls.yaml*
- **Token als Datei, nicht in `.env`.** `secrets/cloudflare_token` (Rechte 600, von Git ignoriert), als Compose-Secret in Caddy und deployer. Caddy bekommt es über ein Startskript in die Umgebung und sieht in der Konfiguration nur `{env.CF_API_TOKEN}` – so steht es weder in `docker inspect` noch in Caddys `autosave.json`. – *caddy/entrypoint.sh, drivers/caddy-config.ts*
- **Eigener Cloudflare-Client statt des SDK `cloudflare`** (SPEC schlägt das SDK vor): wenige Endpunkte, keine weitere Abhängigkeit, in Tests durch eine Attrappe ersetzbar. – *drivers/cloudflare.ts*
- **Versionen:** Caddy 2.10.0, `caddy-dns/cloudflare` v0.2.1, fest im Dockerfile. Lokal gebaut; `caddy validate` nimmt die erzeugte Konfiguration an. – *caddy/Dockerfile*
- **Weiterleitung auf HTTPS** nur für Namen unter der Basisdomain; nip.io bleibt HTTP (kein Zertifikat möglich). – *drivers/caddy-config.ts*
- **Kein HSTS.** Würde TLS später wieder abgeschaltet, kämen Browser ein Jahr lang nicht mehr auf die HTTP-Adressen. Kann nachgerüstet werden, wenn TLS stabil läuft. – *drivers/caddy-config.ts*
- **Kein HTTP/3.** Bräuchte UDP :443 und ist mit dem IP-Filter nicht geprüft. – *drivers/caddy-config.ts*
- **Secure-Cookie** nur, wenn die Anmeldung über HTTPS kam (`X-Forwarded-Proto` von Caddy). Über nip.io bleibt die Anmeldung möglich, dann ohne Secure. – *http/auth.ts*
- **LAN und Tailnet:** ein Name, zwei Zeilen in `routes` (Migration 0005: eindeutig pro Ziel statt global), eine Route in Caddy. Bestehende `tailnet-<host>`-Einträge zieht die Migration nach. – *migrations/0005_tailnet.sql*
- **Tailnet-DNS** wird beim Start und auf Knopfdruck gesetzt, nicht bei jedem Deploy: Es ist ein einziger Wildcard-Eintrag. Ein fremder Eintrag gleichen Namens wird nicht überschrieben. – *domain/tailnet.ts*
- **testssl.sh intern** weiterhin nicht: TLS endet bei Caddy; der Zertifikatsstatus steht auf der Systemseite, ein stündlicher Job meldet Probleme (höchstens einmal pro Tag). – *jobs/cert.ts*
- **Erster Versuch auf dem Server** mit `ACME_CA=staging`, damit ein Fehler nicht ins Rate-Limit von Let's Encrypt läuft. Danach auf `production` umstellen und Caddys Daten-Volume behalten. – *compose.tls.yaml*
- **«Nur LAN» heisst wirklich nur LAN.** Caddy lässt pro Route nur die Bereiche der gewählten Ziele zu (LAN-Subnetz, `100.64.0.0/10` oder beides). Mit `CADDY_IP_FILTER=off` (Mac) gibt es diese Unterscheidung nicht. Auf dem Linux-Server ungetestet. – *domain/routes.ts, cidrsForTargets*

## Meilenstein 5 (Code, ungetestet gegen echte Dienste)

- **«public» beim Anlegen?** Geht nicht. Die Schwelle aus M6 verlangt einen abgeschlossenen Scan, den es vor dem ersten Deploy nicht gibt. `create_project` mit `public` antwortet mit der Reihenfolge: intern anlegen, Scan abwarten, dann `set_targets`. Die SPEC sieht für `create_project` mit `public` eine Bestätigung vor; das erübrigt sich damit. – *mcp/server.ts, PUBLIC_AT_CREATE*
- **Öffentlich schalten mit einem API-Token über REST?** Nein (403). Über REST gäbe es keine Rückfrage; mit Token geht es nur über MCP mit Bestätigung, sonst mit Anmeldung in der UI. Ebenso Domains ändern und den Cloudflare-Abgleich anstossen. – *http/routes/projects.ts, http/auth.ts*
- **Schwelle vor der Rückfrage.** MCP prüft Konfiguration und Schwelle, bevor es nach einer Bestätigung fragt; die UI zeigt den Grund einer Ablehnung. Scheitert «public», bleiben die internen Ziele unverändert. – *domain/public.ts, preflightPublic*
- **Eine öffentliche Route pro Projekt.** Subdomain der Standard-Domain (Vorgabe: der Slug) oder ein voller Name in einer Zone des Kontos; genau eine Ebene unter der Zone (Universal-SSL), kein Apex, nichts unter der internen Basisdomain, `deployer` und `ext-scan` reserviert. – *lib/public-hosts.ts*
- **Fremde Einträge und Regeln bleiben.** Ein DNS-Eintrag gleichen Namens ohne den Kommentar `managed by deployer` wird nicht überschrieben (409). Im Tunnel bleiben Regeln für Namen, die deployer nie gesetzt hat; welche es selbst gesetzt hat, merkt es sich in `app_settings`. – *drivers/cloudflare.ts, lib/public-hosts.ts*
- **Öffentliche Namen in Caddy** nur von Absendern aus dem edge-Netz (dort hängt cloudflared), ohne nip.io-Alias, auf :80 (TLS macht Cloudflare). Nur von dort wird `CF-Connecting-IP` als Besucher-IP übernommen. – *drivers/caddy-config.ts, domain/routes.ts*
- **Löschen scheitert nicht an Cloudflare.** Sind CNAME, Access-App oder Tunnel-Regel nicht entfernbar (Netz, Rechte), wird trotzdem gelöscht, protokolliert und `infra_problem` gemeldet. – *domain/public.ts, removePublic*
- **Access** nur mit `ACCESS_EMAIL`, eine Richtlinie «diese E-Mail», Sitzungsdauer 24 h. – *drivers/cloudflare.ts*
- **cloudflared liest das Token aus einer Datei** (`--token-file`, Version 2025.8.1), nicht aus der Umgebung. – *compose.public.yaml*
- **Neue Projekte** sind standardmässig im LAN und im Tailnet (die UI zeigte das schon so, schickte aber nur `lan`). – *web/pages/NewProject.tsx*
- **Getestet** gegen eine Cloudflare-Attrappe, mit der der laufende deployer spricht (`pnpm --filter @deployer/api e2e:cf`). Nie gegen die echte API. – *e2e/m5.e2e.ts*

