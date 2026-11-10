# Umbenennung deployer → Airlock

Ab Commit `520826c` heisst das Projekt **Airlock**, auch technisch: Compose-Projekt `airlock`, Container `airlock-app`, `airlock-caddy`, `airlock-postgres`, `airlock-socket-proxy`, `airlock-cloudflared`, Netze und Volumes `airlock_*`, Datenbank und Benutzer `airlock`, Labels `airlock.*`, Projekt-Netze und -Container `air_<slug>…`.

**Vorerst unverändert:** die Adresse der Oberfläche `deployer.int.jherren.com` bzw. `deployer.<ip>.nip.io` (Konstante `UI_HOST_LABEL` in `packages/shared/src/index.ts`). Die Umstellung auf `airlock.int…` kommt separat; der Slug `airlock` ist dafür schon reserviert.

Ein bestehender Server mit dem alten Stack darf **nicht** einfach mit `docker compose up` neu gestartet werden: Docker legte dann einen leeren Stack `airlock` neben den alten. Der Umzug läuft mit `scripts/rename-to-airlock.sh`.

## Ablauf auf dem Server

```bash
cd ~/deployer            # Repo-Ordner auf dem Server (Name egal)
git pull
scripts/rename-to-airlock.sh
```

Das Skript fragt vor jedem Schritt, der etwas verändert (`j` zum Bestätigen). Jede andere Antwort bricht ab, ohne weiter etwas zu tun; ein erneuter Aufruf setzt beim offenen Schritt fort. Erledigtes steht in `~/airlock-backup/state`. `scripts/rename-to-airlock.sh --status` zeigt den Stand.

| Schritt | Was passiert |
|---|---|
| a. Vorprüfung | Docker erreichbar, `.env` mit `POSTGRES_PASSWORD`, alte Volumes `deployer_pgdata` und `deployer_deployer_data` da, neue `airlock_*` noch nicht (sonst Abbruch). Erkennt am laufenden Stack, ob `compose.tls.yaml`/`compose.public.yaml` dazugehören (überschreibbar mit `COMPOSE_FILES="compose.yaml compose.tls.yaml"`). |
| b. Sicherung | `pg_dump` der Datenbank `deployer` (laufend) und `pg_dumpall --globals-only` nach `~/airlock-backup/<datum>/`, dazu die alte `compose.yaml` aus git (für den Rückweg). Nach dem Stoppen: `tar` aller `deployer_*`-Volumes (ohne `caddy_admin` mit den Sockets und ohne die Scanner-Caches). Dateien 0600, Ordner 0700. |
| c. Alten Stack stoppen | `deployer-cloudflared` stoppen (nicht löschen), dann `docker compose -p deployer down` **ohne** `-v`. Die Projekt-Container (`dep_*`) laufen weiter, nur die Oberfläche und Caddy sind kurz weg. |
| d. Volumes kopieren | `deployer_X` → `airlock_X` mit `cp -a` in einem Alpine-Container (Rechte und Besitzer bleiben), danach Vergleich von Anzahl Einträgen und Grösse. Das Daten-Volume heisst neu `airlock_data` (früher `deployer_deployer_data`). Die neuen Volumes tragen die Compose-Labels von `airlock`. |
| e. Datenbank | Nur Postgres von `airlock` starten (mit den kopierten Daten), über eine vorübergehende Hilfsrolle Rolle und Datenbank `deployer` → `airlock` umbenennen, Passwort aus `.env` setzen, Hilfsrolle löschen. Prüft, dass gleich viele Projekte da sind. |
| f. Airlock starten | `docker compose -p airlock up -d --build`, warten bis `airlock-app` gesund ist, dann: Login (fragt nach dem Passwort; leer = `ADMIN_PASSWORD` aus `.env`), Selbstprüfung im Container (`node packages/api/dist/selfcheck.js`): Projekte vorhanden, alle verschlüsselten Werte (Projekt-Secrets, GitHub-App, Cloudflare-Token) entschlüsselbar, produktives Wildcard-Zertifikat in Caddys Speicher erkannt, Tunnel verbunden (cloudflared braucht ein paar Sekunden; das Skript wartet bis 60 s). |
| g. Ende | Alte Volumes bleiben. Das Skript zeigt den Befehl zum Löschen nur an. |

Beim Start stoppt Airlock einen noch laufenden `deployer-cloudflared` von sich aus und startet `airlock-cloudflared` mit demselben Tunnel (Tunnel, DNS-Einträge und Access-Apps bei Cloudflare bleiben, wie sie sind).

Einmal neu anmelden: das Session-Cookie heisst jetzt `airlock_session`.

## Projekte aus der deployer-Zeit

Die Projekt-Container laufen beim Umzug einfach weiter. Airlock erkennt Container mit `deployer.*`-Labels und bedient sie weiter in ihren alten Netzen `dep_<slug>` (Caddy, Healthcheck, Monitor, Scans). Neu angelegt wird nur noch mit `airlock.*`-Labels in `air_<slug>`.

Ersetzt werden sie

- beim nächsten **Deploy** oder Rollback des Projekts, oder
- per **«Neu erstellen»**: Die Projektseite zeigt bei solchen Projekten den Hinweis «Läuft noch mit Containern aus der deployer-Zeit» mit dem Knopf. Er legt die aktive Fassung genau so noch einmal an (gleiches Image bzw. dieselbe Compose-Datei), nur mit den neuen Namen (`POST /api/v1/projects/:id/recreate`, im Audit `project.recreate`).

Compose-Projekte mit benannten Volumes: Airlock stoppt die alten Dienste, kopiert jedes Volume `dep_<slug>_<name>` nach `air_<slug>_<name>` (gleiches `cp -a` wie oben) und startet das Projekt unter `air_<slug>`. Die Dienste sind dabei kurz offline. Scheitert etwas, laufen die alten Dienste wieder. Die alten Volumes bleiben in jedem Fall liegen.

Danach räumt Airlock die alten Container und das Netz `dep_<slug>` weg; übrig gebliebene `dep_*`-Netze ohne Container entfernt der Aufräum-Job (alle 6 Stunden).

Weiter gültig, ohne dass etwas zu tun ist: DNS-Einträge mit Kommentar `managed by deployer` (gelten als eigene und bekommen `managed by airlock`, sobald Airlock sie ändert), TXT-Nachweise `_deployer-verify.<host>` externer Ziele, Fix-Branches `deployer/fix-…` und offene Pull Requests, der Header `X-Deployer-State` bei der Prüfung von aussen, Token-Präfixe `dpl_`/`cfm_`.

## Rückweg

Solange die alten Volumes nicht gelöscht sind:

```bash
scripts/rename-to-airlock.sh --rollback
```

Das stoppt Airlock (`docker compose -p airlock down`, ohne `-v`), startet den alten Stack mit der gesicherten alten `compose.yaml` (`docker compose -p deployer … up -d --no-build`, die alten Images sind noch da) und startet `deployer-cloudflared` wieder, falls er vorher lief. Danach den Code auf den alten Stand bringen, damit ein späteres `up` nicht den neuen baut: `git switch --detach 520826c^`.

Von Hand, falls das Skript nicht greift:

```bash
docker compose -p airlock down
git switch --detach 520826c^
docker compose -p deployer up -d
docker start deployer-cloudflared   # falls verwendet
```

Was in Airlock nach dem Umzug geändert wurde (neue Deploys, Einstellungen), fehlt nach dem Rückweg; deployer startet mit dem Stand vom Umzug. Projekte, die unter Airlock schon neu erstellt wurden (`air_*`), kennt deployer nicht mehr: dort einmal neu deployen. Ein späterer neuer Umzug überschreibt die liegengebliebenen `airlock_*`-Volumes (das Skript fragt).

## Aufräumen danach

Erst, wenn Airlock einige Tage ohne Probleme läuft:

1. In Airlock alle Projekte mit dem Hinweis «Neu erstellen» umstellen (oder neu deployen). `docker ps --filter label=deployer.managed=true` muss leer sein.
2. Alte Volumes und Images löschen (das Skript zeigt den Befehl am Ende noch einmal):
   ```bash
   docker volume rm deployer_pgdata deployer_caddy_data deployer_caddy_config deployer_caddy_secrets deployer_sites deployer_deployer_data deployer_caddy_admin deployer_scan-trivy deployer_scan-nuclei
   docker rm deployer-cloudflared
   docker image rm deployer-deployer deployer/caddy-cloudflare:local
   ```
3. Alte Projekt-Volumes von Compose-Projekten, nachdem sie neu erstellt sind: `docker volume ls -q | grep '^dep_'` prüfen, dann löschen.
4. Alte Images `deployer/<slug>:…` (Dockerfile-Builds): `docker image ls 'deployer/*'`. Airlock räumt sie mit der Aufbewahrung von Fassungen selbst weg, sobald die zugehörigen Fassungen herausfallen.
5. Sicherung `~/airlock-backup/<datum>/` aufheben oder löschen (enthält den Datenbank-Dump und den Schlüssel `secrets.key` im Daten-Volume).

## Wann der Übergangscode weg kann

Sobald auf dem Server keine `deployer.*`-Container mehr laufen (Schritt 1 oben) und die alten Fix-Branches gemergt oder geschlossen sind. Dann entfallen:

- `packages/api/src/lib/names.ts`: alles mit `LEGACY` und `normalizeLabels`; in `drivers/docker.ts` die zweite Abfrage in `listManagedContainers`, `LegacyState`, `legacyNetworkName`, `networkOf`/`webContainerOf` auf die neuen Namen vereinfachen
- `deploy/sources/compose.ts`: `takeOverLegacyCompose`, `restoreLegacyCompose`, `retargetCompose` in `lib/compose.ts` (erst, wenn keine aufbewahrte Fassung mehr aus der deployer-Zeit stammt, d.h. nach `KEEP_VERSIONS` Deploys pro Compose-Projekt)
- `deploy/pipeline.ts`: `dropLegacyNetwork`, `startRecreate`, das `replace(/^dep_/, 'air_')` beim Compose-Rollback; Route `POST /projects/:id/recreate`, `ProjectDto.legacyContainers` und der Hinweis in `ProjectDetail.tsx`
- `security/scan.ts`: das Einhängen alter Container ins Netz `air_<slug>`
- `drivers/cloudflared.ts`: `stopLegacyCloudflared`
- `drivers/cloudflare.ts`: `LEGACY_MANAGED_COMMENT` (erst, wenn alle DNS-Einträge den neuen Kommentar tragen)
- `security/external.ts`: `LEGACY_TXT_PREFIX` und `deployer-verify=` (erst, wenn alle externen Ziele mit dem neuen TXT-Eintrag nachgewiesen sind)
- `lib/github.ts`: `LEGACY_FIX_BRANCH_PREFIX`
- `shared/src/pause-page.ts`: `LEGACY_PAUSE_STATE_HEADER`, in `lib/outside-probe.ts` das Lesen von `x-deployer-state`
- `jobs/cleanup.ts`: der Zweig für `dep_`-Netze
- Oberfläche: das Übernehmen der alten localStorage-Schlüssel `deployer.theme` und `deployer.rail.collapsed`
- dieses Skript und diese Datei

Bleiben muss der Fingerabdruck-Text `deployer-env` in `packages/api/src/http/auth.ts`: daran erkennt Airlock, ob sich `ADMIN_PASSWORD` geändert hat; ein anderer Text setzte das in der Oberfläche gesetzte Passwort zurück.

## Lokal getestet

Am 10.11.2026 auf dem Mac in einem eigenen Docker-Daemon (Docker-in-Docker, Docker 27.5), nie gegen einen echten Stack: alter Stack aus `520826c^` mit drei Projekten (Image mit Secret, statische Seite, Compose mit Daten-Volume), Umzug, Projekte über den neuen Caddy erreichbar, Rückweg, erneuter Umzug über die liegengebliebenen Volumes, dritter Aufruf («schon abgeschlossen»), dann «Neu erstellen» für beide Container-Projekte: neue Namen und Labels, Daten im neuen Volume, alte Container und Netze weg, alte Volumes noch da. Nicht lokal prüfbar: Zertifikat und Tunnel (ohne Cloudflare-Konto übersprungen) und der Build auf dem Server (`--build`; im Test mit vorgebauten Images).
