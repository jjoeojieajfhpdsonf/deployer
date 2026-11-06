# Meilenstein 2 – Alle Quellen

Stand: 6. November 2026

Umfang laut [SPEC.md](SPEC.md): Dockerfile, Compose, Healthcheck, Umschalten ohne Ausfall, Rollback. Dazu gehört die in M1 aufgeschobene statische Seite aus einem Repo mit Build-Befehl – sie ist Teil von «alle Quellen» und wird in M3 für Chat-Deploys gebraucht.

Vorab geprüft (Docker Desktop 29.9, API 1.56):
- Der klassische Builder ist über `POST /build?version=1` weiterhin nutzbar. dockerode kann keine BuildKit-Sitzung aufbauen, deshalb ist das der Weg.
- Die Compose-CLI arbeitet durch den Socket-Proxy mit den Rechten aus M1. Für `build:` in Compose und für Dockerfile-Builds kommt `BUILD=1` dazu.

## 1. Quellen

| Quelle | Eingabe | Ablauf | Umschalten |
| --- | --- | --- | --- |
| `image` (M1) | Image-Referenz, Port | Pull, Container, Healthcheck | ohne Ausfall |
| `dockerfile` | Repo-URL, Ref, Pfad zum Dockerfile, Kontext, Port | Clone, Build, Container, Healthcheck | ohne Ausfall |
| `compose` | Repo-URL **oder** hochgeladene `compose.yaml`, Web-Dienst, Port | Prüfen, normalisieren, `docker compose up -d`, Healthcheck | **mit kurzem Ausfall**, siehe 4 |
| `static` (M1: ZIP) | dazu neu: Repo-URL, optional Build-Befehl und Ausgabeordner | Clone, Build im Wegwerf-Container, Ausgabe entpacken | ohne Ausfall (Symlink) |

## 2. Git

`lib/git.ts` ruft die `git`-CLI im deployer-Container auf, immer per `execFile` (keine Shell) und mit `--` vor der URL.

**Erlaubte URLs:** nur `https://` und `http://`. Abgelehnt werden `file://`, `ssh://`, `git://` und Remote-Helfer wie `ext::` – Letztere führen beliebige Befehle aus. Zusätzlich setzt jeder Aufruf `-c protocol.allow=never -c protocol.https.allow=always -c protocol.http.allow=always`. Damit greift das Verbot auch für Weiterleitungen und Submodule; Submodule werden ohnehin nicht geholt.

**Kein Zugriff auf den eigenen Stack:** Die Repo-URL darf nicht auf `localhost`, Loopback-Adressen, die Dienstnamen des Stacks (`postgres`, `socket-proxy`, `caddy`, `deployer-*`) oder eine Adresse in den Netzen `deployer_internal`/`deployer_edge` zeigen. Sonst könnte ein Clone – ab M3 auch von einem Agenten angestossen – interne Dienste abtasten. Ein Git-Server im LAN bleibt erlaubt.

**Version:** der Commit-Hash nach dem Checkout (`git rev-parse HEAD`). Ein Ref kann Branch, Tag oder Commit sein; Commits werden per `git fetch --depth 1 origin <sha>` geholt.

**Grenzen:** 5 Minuten für den Clone, `GIT_TERMINAL_PROMPT=0` (nie auf ein Passwort warten). Private Repos kommen nicht in M2 (siehe OFFENE-FRAGEN).

## 3. Dockerfile

1. Clone nach `/data/work/<deployment>/`, `.git` wird nicht mitgeschickt.
2. Kontext als Tar packen, `.dockerignore` beachten. Kontext und Dockerfile-Pfad müssen nach dem Auflösen im Repo liegen (dieselbe Prüfung wie bei Zip Slip).
3. `POST /build` mit Tag `deployer/<slug>:<deployment-kurz>`, Labels `deployer.managed`/`deployer.project`, Speicher- und CPU-Grenze, **Zeitlimit 10 Minuten** (Abbruch per AbortSignal).
4. Ab hier wie `image`: Container über die Erlaubnisliste, Healthcheck, Umschalten.

Ein Build führt fremde `RUN`-Schritte auf dem Host-Daemon aus. Er läuft isoliert in einem Build-Container ohne `privileged` (das bräuchte eine Entitlement, die die API hier nicht setzt), aber mit Netzzugang – sonst scheitert jedes `npm install`. Die Image-Prüfung mit Trivy kommt in M6.

## 4. Compose

Die Compose-CLI geht **an der Erlaubnisliste in `drivers/policy.ts` vorbei** – darauf hat M1 bereits hingewiesen. Die Schranke ist deshalb eine eigene, gleich strenge Prüfung der `compose.yaml`, und die CLI bekommt nie die Datei des Nutzers, sondern nur eine Datei, die deployer aus geprüften Werten neu schreibt.

**Erlaubnisliste pro Dienst** (alles andere wird abgelehnt, mit Name des Feldes):

| Feld | Regel |
| --- | --- |
| `image` | Pflicht, ausser `build` ist gesetzt |
| `build` | nur `context` und `dockerfile`, beide relativ und nach dem Auflösen im Repo; nicht bei hochgeladener `compose.yaml` ohne Repo |
| `command`, `entrypoint`, `working_dir`, `user`, `init`, `stop_grace_period`, `labels`, `expose`, `healthcheck`, `depends_on` | übernommen |
| `environment` | übernommen; Projekt-Env und Secrets kommen beim Web-Dienst dazu |
| `env_file` | nur relative Pfade im Repo; der Inhalt wird beim Normalisieren in `environment` übernommen, die CLI sieht die Datei nie |
| `volumes` | **nur benannte Volumes** (`daten:/var/lib/x`). Bind-Mounts (`./x:/y`, `/x:/y`) werden abgelehnt |
| `restart` | wird immer auf `unless-stopped` gesetzt |

Abgelehnt, weil sie aus dem Container ausbrechen oder den Host berühren: `privileged`, `cap_add`, `devices`, `network_mode`, `pid`, `ipc`, `uts`, `userns_mode`, `security_opt`, `sysctls`, `cgroup_parent`, `volumes_from`, **`ports`** (auch `"80"` allein veröffentlicht einen zufälligen Host-Port), `networks`, `extra_hosts`, `configs`, `secrets`, `deploy`, `container_name`.

**Auf oberster Ebene:** `services` und `volumes`; Volumes ohne `driver`, `driver_opts` und `external` – über `driver_opts: {type: none, o: bind, device: /}` liesse sich sonst ein Bind-Mount durch die Hintertür bauen. `x-*`-Erweiterungen werden verworfen, alles andere abgelehnt.

**Warum keine Bind-Mounts, auch keine relativen ins Repo:** Die CLI läuft im deployer-Container und schickt den aufgelösten Pfad an den Host-Daemon. `./nginx.conf` würde zu `/data/work/...` – ein Pfad, den es auf dem Host nicht gibt. Docker legt dann einen leeren Ordner an, der Dienst startet mit leerer Konfiguration. Abgelehnt mit dem Hinweis, die Datei ins Image zu bauen.

**Normalisiert** wird jeder Dienst auf: Netz `dep_<slug>` (extern), feste Log-Rotation, `mem_limit`/`cpus` aus dem Projekt, `security_opt: [no-new-privileges:true]`, `restart: unless-stopped`, Labels `deployer.*`. Dienste mit `build` bekommen `image: deployer/<slug>-<dienst>:<deployment-kurz>` – so hat jede Fassung ihr eigenes Image, und ein Rollback findet es wieder.

**Projektname** ist fest `dep_<slug>`. Benannte Volumes heissen damit `dep_<slug>_<name>` und überleben jeden Deploy.

**Kein Umschalten ohne Ausfall bei Compose.** Ein zweites Compose-Projekt neben dem alten würde die benannten Volumes gleichzeitig benutzen – eine Datenbank liefe zweimal auf denselben Dateien. Compose-Deploys sind deshalb `up -d` an Ort und Stelle: Dienste, die sich geändert haben, starten neu, die anderen laufen weiter. Scheitert der Healthcheck, wird die vorherige normalisierte Datei wieder hochgefahren.

## 5. Statische Seite aus einem Repo

Build in einem Wegwerf-Container (`node:22-alpine`), ohne Bind-Mount:

1. Container über die Erlaubnisliste anlegen (Arbeitsverzeichnis `/work`, Netz `dep_<slug>` für den Zugang zur Registry).
2. Repo per `PUT /containers/{id}/archive` hineinkopieren.
3. Installieren je nach Lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, sonst `npm install`), dann den Build-Befehl. Zeitlimit 10 Minuten.
4. Ausgabeordner per `GET /containers/{id}/archive` holen und **mit denselben Regeln wie beim ZIP** entpacken: keine Pfade aus dem Ziel heraus, keine Symlinks oder Hardlinks, Grössen- und Anzahlgrenzen.
5. Container löschen. Danach wie in M1: Symlink `current` umhängen.

Die Erlaubnisliste bekommt dafür auf oberster Ebene `Cmd`, `Entrypoint`, `WorkingDir` und `User` dazu – Felder, die den Host nicht berühren.

## 6. Rollback

`POST /projects/{id}/rollback` mit optionaler `deploymentId`; ohne Angabe die zuletzt aktive Fassung vor der jetzigen.

| Quelle | Was zurückkommt |
| --- | --- |
| `image`, `dockerfile` | Container aus `deployments.image_ref` (Digest bzw. eigener Tag), danach wie ein normaler Deploy mit Healthcheck und Umschalten ohne Ausfall |
| `compose` | die gespeicherte normalisierte Datei der Fassung, `up -d` |
| `static` | `current` zeigt wieder auf den alten Versionsordner |

Ein Rollback ist ein eigener Eintrag in `deployments` (`trigger = rollback`, `rollback_of`), mit eigenem Log. Die Umgebungsvariablen sind die aktuellen, nicht die von damals. Aufbewahrt werden die letzten **5** Fassungen; deren Images, Compose-Dateien und Versionsordner räumt das Aufräumen erst danach weg.

## 7. Datenmodell (Migration 0002)

- `deployments`: `image_ref text`, `artifact jsonb` (z.B. Pfad der Compose-Datei, Versionsordner), `trigger text` (`deploy`, `rollback`), `rollback_of uuid`.
- `uploads`: `kind text` (`zip` oder `compose`).
- `source_config` bekommt die neuen Felder; das Schema dazu steht in `packages/shared`.

## 8. API und Oberfläche

- `POST /projects/{id}/rollback` – `409`, wenn gerade ein Deploy läuft (derselbe Advisory Lock).
- `POST /uploads` nimmt zusätzlich `.yaml`/`.yml` bis 256 KB für Compose an.
- **Neues Projekt:** Quelle als erste Wahl mit vier Möglichkeiten, die Felder passen sich an.
- **Deployments:** Knopf «Zurückrollen» bei älteren Fassungen, deren Artefakt noch vorhanden ist, mit Rückfrage.

## 9. Reihenfolge

1. Migration, Schemas, Erlaubnisliste erweitern (Tests zuerst)
2. Git mit URL-Prüfung (Tests zuerst)
3. Tar-Entpacken mit denselben Regeln wie ZIP (Tests zuerst)
4. Compose-Prüfung und -Normalisierung (Tests zuerst – das ist die neue Schranke)
5. Dockerfile-Pipeline
6. Compose-Pipeline
7. Statischer Build aus Repo
8. Rollback
9. Oberfläche
10. Abnahme mit Docker, M1-Abnahme erneut

## Abnahmekriterien

Stand 7.11.2026, geprüft lokal auf Docker Desktop 29 mit der Ende-zu-Ende-Suite (`pnpm --filter @deployer/api e2e`, Dateien `e2e/m1.e2e.ts` und `e2e/m2.e2e.ts`). Ein kleiner Git-Server auf dem Host (Smart HTTP) liefert die Test-Repos; der deployer erreicht ihn über `host.docker.internal`.

- [x] Ein Repo mit Dockerfile wird geklont, gebaut und ist erreichbar; die Version ist der Commit-Hash
- [x] Ein Repo mit `npm run build` wird im Wegwerf-Container gebaut und als statische Seite ausgeliefert; danach steht kein Build-Container mehr – *die Seite zeigt die Node-Version des Build-Containers (v22)*
- [x] Eine hochgeladene `compose.yaml` mit Web-Dienst und Datenbank läuft; die Datenbank behält ihre Daten über einen erneuten Deploy – *Redis mit AOF, Wert über Deploy und Neustart erhalten*
- [x] Compose mit `privileged`, `ports`, Bind-Mount, `network_mode: host`, `cap_add` oder Volume-`driver_opts` wird abgelehnt, mit Name des Feldes – *bei hochgeladener Datei schon beim Anlegen (400), bei Repos beim Deploy*
- [x] Ein unbekanntes Feld in einem Compose-Dienst wird abgelehnt (Unit-Test)
- [x] Repo-URLs mit `file://`, `ext::`, `ssh://` oder auf `postgres`/`socket-proxy`/Loopback werden abgelehnt – *schon beim Anlegen*
- [x] Ein Tar aus dem Build-Container mit `../` oder Symlink schreibt nichts ausserhalb des Ziels (Unit-Tests)
- [x] **Umschalten ohne Ausfall:** Während eines Re-Deploys eines Images antwortet die Adresse durchgehend mit 200 – *alle 100 ms abgefragt, keine einzige Antwort ohne 200*
- [x] Rollback bei Image, Dockerfile, Compose und statisch bringt die vorherige Version zurück, mit eigenem Deployment-Eintrag
- [x] Ein fehlgeschlagener Build lässt die laufende Fassung unberührt
- [x] Alle M1-Kriterien gelten weiter – *M1-Abnahme als `e2e/m1.e2e.ts` erneut gelaufen*

Zusätzlich geprüft: Die aufbewahrte Compose-Datei enthält keine Secrets (Suche nach dem Wert über `/data` ohne Treffer), der Web-Dienst bekommt sie trotzdem.

## Befunde aus der Umsetzung

Die Abnahme und das Schreiben der Tests haben Fehler gefunden, die über den Plan hinausgingen. Alle sind behoben:

1. **Secrets der Umgebung über Compose abgreifbar.** Compose ersetzt `${DATABASE_URL}` aus der Umgebung der CLI, und `environment: [ADMIN_PASSWORD]` ohne Wert übernimmt sie ebenso. Gegenmittel: `$` wird zu `$$` maskiert, Einträge ohne Wert werden abgelehnt, die CLI läuft mit leerer Umgebung und `--env-file /dev/null`.
2. **Secrets im Klartext in Rollback-Artefakten.** Die normalisierte Datei wird fünf Fassungen lang aufbewahrt. Sie wird jetzt ohne Projekt-Env gespeichert; die Env kommt nur für die Dauer von `compose up` in eine Temporärdatei.
3. **Fremde Volumes und Labels.** `volumes: {x: {name: dep_anderes_db}}` hätte das Volume eines anderen Projekts eingehängt, Labels `deployer.*` hätten Aufräumen und Löschen getäuscht. Beides abgelehnt.
4. **Symlinks im Repo.** Ein `env_file` als Symlink auf `/proc/self/environ` hätte die Umgebung des deployers in einen Container geleitet. Git checkt Symlinks jetzt als Textdateien aus; Dateizugriffe lehnen Symlinks zusätzlich ab.
5. **DNS-Rebinding beim Clone.** Die geprüfte Adresse wird mit `http.curloptResolve` festgeschrieben. Dabei ein eigener Fehler: zwei Einträge für denselben Host ersetzen sich in curl gegenseitig, übrig blieb eine nicht routbare IPv6-Adresse. Jetzt ein Eintrag mit allen Adressen, IPv4 zuerst.
6. **409 direkt nach «active».** Das Deployment meldete `active`, hielt den Lock aber noch fürs Aufräumen. Ein Client, der darauf wartet und sofort neu deployt (ab M3 typischerweise ein Agent), bekam 409. Jetzt erst aufräumen, dann Endstatus, dann sofort Lock frei.
7. **Caddy scheitert nach dem Umschalten.** Die alte Fassung stand in der Datenbank schon auf «abgelöst», obwohl Caddy sie weiter ausliefert. Jetzt wird sie in diesem Fall wieder aktiv gesetzt.
8. **Build-Container mit `unless-stopped`** hätten sich nach Ende endlos neu gestartet. Die Erlaubnisliste erlaubt zusätzlich `no`.
9. **Label `deployer.deployment` bei Compose** hätte bei jedem Deploy alle Dienste neu erzeugt, auch die Datenbank. Compose-Dienste tragen es nicht.
10. **Ungültige Eingaben erst beim Deploy erkannt.** Gesperrte Repo-URLs und unzulässige hochgeladene `compose.yaml` kommen jetzt schon beim Anlegen als 400 mit Feldnamen zurück.

## Code-Review

Das Review (`/code-review high`) hat zehn Befunde geliefert; alle waren berechtigt und sind behoben, jeweils mit Test:

| # | Befund | Behebung | Test |
| --- | --- | --- | --- |
| 1 | `build.dockerfile: /proc/1/environ` mit Kontext ≠ `.` bestand die Repo-Prüfung und ging unverändert an Compose → Secrets im Deploy-Log | nur relative Pfade; in die Ausgabe kommt der aus den aufgelösten Pfaden neu berechnete Pfad | Unit |
| 2 | `NODE_ENV=production` vor `npm ci` → devDependencies fehlen, Vite & Co. scheitern | kein `NODE_ENV` im Build-Container, Projekt-Env gewinnt | E2E |
| 3 | Fehlgeschlagener Compose-Rollback löschte die Images seines Ziels | gebaute Images räumt nur ein gescheiterter `deploy` weg, kein `rollback` | – |
| 4 | Compose-Builds brauchten BuildKit-Sitzungen, die der Proxy sperrt | `DOCKER_BUILDKIT=0` für die CLI | E2E |
| 5 | `.output/public` wurde zu `output/public` | eigene Funktion, nur führendes `./` wird entfernt | Unit |
| 6 | Statischer Build ignorierte geänderte Env | Env gehört zum Fassungs-Hash | Unit |
| 7 | Caddy-Rückfall setzte bei statisch/Compose die falsche Fassung aktiv | Rückfall nur bei Container-Quellen; sonst Warnung, neue Fassung bleibt aktiv | – |
| 8 | Start und Abgleich starteten Einmal-Dienste (`restart: no`) erneut | Label `deployer.compose-restart`, nur dauerhafte Dienste werden gestartet | E2E |
| 9 | Compose holte `:latest` beim Redeploy nicht neu | `compose pull --ignore-buildable` vor `up`, nicht bei Rollbacks | – |
| 10 | `.dockerignore` verwarf eigene Dockerfile-Pfade und `!`-Ausnahmen | Dockerfile immer dabei; mit `!` wird Datei für Datei entschieden | Unit |

Beim Beheben von 8 fiel ein eigener Fehler auf, den das Review nicht gemeldet hat: Das Label `deployer.deployment` stand trotz Plan noch an den Compose-Diensten und hätte bei jedem Deploy alle Dienste neu erzeugt. Entfernt.

**Nicht mit Docker geprüft:** Nr. 3, 7 und 9. Für 9 bräuchte es eine Registry, in der sich ein Tag ändert; 3 und 7 sind Fehlerpfade, die sich lokal nur mit absichtlich kaputtem Caddy bzw. kaputtem Healthcheck beim Rollback erzwingen liessen.
