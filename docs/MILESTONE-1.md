# Meilenstein 1 – Lokal deployen

Stand: 6. November 2026

Umfang laut [SPEC.md](SPEC.md): fertige Images und statische Seiten, Caddy mit LAN-Adressen, einfache Web-UI. Alles andere (Dockerfile-Build, Compose, MCP, Tunnel, Scanner) bleibt draussen – aber Datenmodell und Service-Schicht werden so geschnitten, dass die späteren Meilensteine nur noch andocken.

## 1. Projektstruktur

pnpm-Monorepo, drei Pakete. Die API liefert im Betrieb das gebaute Frontend mit aus (ein Container statt zwei, hilft beim 300-MB-Ziel); in der Entwicklung läuft Vite daneben mit Proxy auf die API.

```
deployer/
  compose.yaml              # der deployer-Stack selbst
  .env.example
  docs/SPEC.md
  caddy/Caddyfile           # Minimal-Basis, Rest zur Laufzeit per Admin-API
  packages/
    shared/                 # Zod-Schemas + Typen, von API und Web geteilt
    api/
    web/
  data/                     # gitignored, Bind-Mounts: logs, sites, keys
```

`packages/api/src`:

| Ordner | Inhalt | Warum so |
| --- | --- | --- |
| `config.ts` | Env per Zod validiert, Start bricht bei fehlender Variable ab | Keine halb-konfigurierten Starts |
| `db/` | Drizzle-Schema, Migrationen, Pool | Migration läuft beim Boot (NFR «Update») |
| `domain/` | `projects`, `deployments`, `routes`, `env`, `audit` | **Die eine Service-Schicht.** HTTP-Routen sind dünne Wrapper. MCP (M3) hängt sich hier an, nicht an die REST-API |
| `drivers/docker.ts` | dockerode gegen den Socket-Proxy, **plus Richtlinienprüfung** | Einziger Ort, der Docker kennt – und die Stelle, die gefährliche Container-Optionen verweigert |
| `drivers/caddy.ts` | Admin-API über Unix-Socket: Route setzen, löschen, voller Reconcile | Einziger Ort, der Caddy kennt |
| `deploy/pipeline.ts` | Deploy als Zustandsautomat, pro Quelle ein Adapter | M2 fügt `dockerfile.ts`/`compose.ts` als Adapter dazu, Pipeline bleibt |
| `deploy/sources/` | `image.ts`, `static.ts` | |
| `http/routes/` | REST, Auth, SSE | |
| `jobs/` | Reconcile beim Start, nächtliches Aufräumen | |

Begründung für `domain/` als eigene Schicht schon in M1: Die Spec verlangt, dass UI, REST und MCP sich identisch verhalten. Das ist später nicht mehr nachrüstbar, ohne alles anzufassen.

## 2. Docker-Compose-Stack

Fünf Dienste, zwei feste Netze, Projekt-Netze kommen zur Laufzeit dazu.

| Dienst | Image | Netz | Ports am Host | Zweck |
| --- | --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | `edge`, dynamisch Projekt-Netze | **80** (M1 nur HTTP) | Einziger Dienst mit Host-Port. Admin-API nur über Unix-Socket, kein TCP |
| `deployer` | selbst gebaut, Node 22 | `edge`, `internal`, Projekt-Netze | keine | UI, API, Pipeline |
| `postgres` | `postgres:17-alpine` | `internal` | keine | Daten |
| `socket-proxy` | `tecnativa/docker-socket-proxy` | `internal` | keine | Einzige Tür zur Docker-API |
| *(später)* `cloudflared` | – | – | – | M5 |

**Volumes:** `pgdata`, `caddy_data`, `caddy_config`, `deployer_data` (Deploy-Logs, Schlüsseldatei), `sites` (statische Seiten – von `deployer` beschrieben, von `caddy` gelesen), `caddy_admin` (nur der Admin-Socket, siehe unten).

**Socket-Proxy-Rechte in M1:** `CONTAINERS=1, IMAGES=1, NETWORKS=1, VOLUMES=1, INFO=1, VERSION=1, POST=1` – und ausdrücklich `EXEC=0, BUILD=0, SWARM=0, SECRETS=0, SYSTEM=0`. `BUILD` kommt erst mit M2. Der Proxy filtert pro Pfad, nicht pro Methode-und-Pfad.

**Der Socket-Proxy allein verhindert keinen Root-Zugriff.** Das muss klar benannt sein, sonst wiegt man sich in falscher Sicherheit: Wer `POST /containers/create` aufrufen darf, kann einen Container mit `privileged: true` und `/` als Bind-Mount starten und ist damit Root auf dem Host – ganz ohne `exec`, `BUILD` oder `SYSTEM`. Der Proxy schränkt ein, *welche Endpunkte* erreichbar sind, nicht *was in der Nutzlast steht*. Zugang zur Container-API ist und bleibt gleichwertig mit Root auf dem Host.

Die eigentliche Schranke liegt deshalb in `drivers/docker.ts`, nicht im Proxy.

**Für alle Dienste gesetzt:** `restart: unless-stopped` (NFR Serverneustart) und `logging: json-file, max-size 10m, max-file 5`. Dieselben Log-Optionen setzt die Pipeline auch an jedem Projekt-Container – die Spec nennt das ausdrücklich als Absicht.

**Zwei Netz-Entscheidungen:**

1. **Caddy wird pro Projekt dynamisch ins Projekt-Netz gehängt** (`network connect` beim Aktivieren der Route, `disconnect` beim Löschen). Entspricht der Spec-Regel «nur ins Netzwerk des Projekts, das es gerade bedient».
2. **Der deployer wird nur für den Healthcheck ins Projekt-Netz gehängt und danach wieder getrennt.** Also `connect` → pollen → `disconnect`, und das `disconnect` läuft im `finally`, damit ein fehlgeschlagener Healthcheck die Verbindung nicht stehen lässt. Der Reconcile beim Start räumt übrig gebliebene Anhänge ab – das ist der Zustand, in dem dieses Muster sonst leise verrottet. Damit hängt niemand dauerhaft in fremden Projekt-Netzen, auch die Steuerebene nicht.

### Caddy-Admin-API nur über einen Unix-Socket

Caddys Admin-API lauscht **nicht** auf TCP `:2019`, sondern auf einem Unix-Socket:

```
{
	admin unix//run/caddy/admin.sock
}
```

Das Verzeichnis `/run/caddy` liegt im Volume `caddy_admin` und ist in `caddy` und `deployer` gemountet, sonst nirgends. `drivers/caddy.ts` spricht die API über diesen Socket an (in Node über `undici` mit `socketPath`), nicht über HTTP zu einem Hostnamen.

**Der Grund folgt direkt aus Netz-Entscheidung 1.** Caddy wird dynamisch in jedes Projekt-Netz gehängt. Lauschte die Admin-API auf TCP, säße jeder Projekt-Container im selben Netz wie ein ungeschütztes `caddy:2019` – und die Caddy-Admin-API ist unauthentifiziert. Ein beliebiger deployter Container könnte damit die gesamte Proxy-Konfiguration umschreiben: fremde Projekte auf sich selbst umleiten, die deployer-UI abgreifen, den IP-Filter entfernen. Das ist kein theoretisches Risiko, sondern die direkte Folge daraus, dass Caddy sich zu fremdem Code ins Netz setzt. Ein Unix-Socket ist über das Netz grundsätzlich nicht erreichbar und beendet die Frage.

Ein Detail für die Umsetzung: Der Socket gehört dem Benutzer, unter dem Caddy läuft. `deployer` muss ihn lesen und schreiben dürfen, also brauchen beide Container eine gemeinsame GID (`group_add`) oder denselben Benutzer. Das wird beim Aufsetzen geprüft, nicht angenommen.

### Richtlinien in `drivers/docker.ts`

Die Prüfung ist eine **Erlaubnisliste, keine Sperrliste**: In `HostConfig` sind genau die unten aufgeführten Felder zulässig, **jedes andere Feld führt zur Ablehnung** – auch eines, das heute noch niemand kennt. Eine Sperrliste wäre nach dem nächsten Docker-Release still löchrig, weil ein neues Feld standardmässig durchginge. Bei Verstoss wird **abgebrochen**, nicht korrigiert; stilles Zurechtbiegen würde den Fehler verstecken.

| Erlaubtes Feld in `HostConfig` | Zulässiger Wert |
| --- | --- |
| `NetworkMode` | genau das Projekt-Netz `dep_<slug>` |
| `Memory` | `memory_limit_mb` des Projekts, in Bytes |
| `NanoCpus` | `cpu_limit` des Projekts |
| `RestartPolicy` | `{ Name: 'unless-stopped' }` |
| `LogConfig` | `json-file` mit `max-size: 10m`, `max-file: 5` |
| `SecurityOpt` | genau `['no-new-privileges:true']` |
| `Mounts` | nur benannte Volumes `dep_<slug>_*`; Typ `bind` ist in M1 gar nicht erlaubt |

Was dadurch **ohne eigene Regel** wegfällt, ist genau das Gefährliche: `Privileged`, `CapAdd`, `Devices`, `DeviceRequests`, `PidMode`, `IpcMode`, `UTSMode`, `PortBindings`, `Binds`, `ExtraHosts`, `Sysctls`, `CgroupParent` – und alles Künftige. Das ist der Punkt der Erlaubnisliste: Die Sicherheitsaussage hängt nicht daran, ob die Liste der bekannten Gefahren vollständig ist.

Gleiches Prinzip auf oberster Ebene: deployer reicht nie eine von aussen gelieferte Docker-Nutzlast durch, sondern baut sie aus einem engen eigenen Typ `ContainerSpec` (Image, Env, Labels, Limits, Netz). Die Prüfung läuft als Zusicherung unmittelbar vor dem API-Aufruf. Sie schützt damit nicht vor einer Eingabe, die es in M1 noch gar nicht gibt, sondern vor dem künftigen Codepfad, der ein Feld ergänzt, ohne an die Folgen zu denken.

`CapDrop: ALL` wird in M1 **nicht** erzwungen: zu viele gängige Images brauchen `CHOWN`, `SETUID`, `SETGID` oder `NET_BIND_SERVICE` und würden kommentarlos nicht starten. Läuft ein Container als root, wird das protokolliert und in der UI angezeigt, aber nicht verhindert.

Damit diese Schranke hält, muss sie die einzige Tür sein: **kein anderer Code im Projekt ruft dockerode direkt auf.** Durchgesetzt per ESLint-Regel (`no-restricted-imports` auf `dockerode` ausserhalb von `drivers/`), nicht per Absprache. Jede Ablehnung landet im Audit-Log mit der verletzten Regel.

Für M2 vorgemerkt: `docker compose up` läuft über die CLI und geht damit **an dieser Prüfung vorbei**. Eine hochgeladene `compose.yaml` muss vorher gelesen und auf dieselben Regeln geprüft werden – genau die Stelle, an der sonst ein `privileged: true` hereinspaziert.

**Hostnamen in M1:** `<slug>.int.<basisdomain>`, UI unter `deployer.int.<basisdomain>`. TLS gibt es in M1 nicht (Wildcard-Zertifikat ist M4); alle internen Namen beantwortet Caddy nur für `remote_ip` aus dem LAN-CIDR und `100.64.0.0/10` – das gilt auch für die Rückfallwege unten.

**Der IP-Filter ist per `CADDY_IP_FILTER=on|off` abschaltbar, Vorgabe `on`.** Grund: Unter Docker Desktop auf dem Mac kommt der Verkehr über das Gateway der VM an, die Client-IP ist also nicht die LAN-IP – der Filter sperrt einen dort aus dem eigenen Rechner aus. Weil ein stiller Schalter irgendwann unbemerkt auf dem Server landet, ist er laut: Warnung beim Start im Log, Eintrag im Audit-Log, und ein Hinweisband in der System-Ansicht, solange er aus ist.

### Erreichbarkeit in M1 – drei Wege

In `routes.hostname` steht die **primäre Adresse – die, die tatsächlich erreichbar ist**: mit Basisdomain `<slug>.<basisdomain>`, ohne Basisdomain der nip.io-Name. Die Oberfläche zeigt diese Adresse zuerst. Ein Platzhalter wie `int.example.ch` erscheint nie: er sieht echt aus und führt ins Leere. Ist weder Basisdomain noch LAN-IP gesetzt, endet die Adresse auf `.int.invalid` (reserviert, löst nie auf) und der Start meldet einen Fehler.

Weitere Namen (nip.io neben der Basisdomain) sind **keine zusätzlichen Routen**, sondern zusätzliche Host-Matcher auf derselben Caddy-Route – sonst kollidieren sie mit dem Unique-Index auf `hostname` und später mit der Cloudflare-Zuordnung in M5. Wird die Basisdomain später gesetzt oder geändert, leitet der deployer beim Start alle LAN-/Tailnet-Adressen neu ab; bestehende Projekte ziehen mit (geprüft in beide Richtungen).

| Weg | Adresse | Voraussetzung | Rolle |
| --- | --- | --- | --- |
| 1. Lokaler DNS | `<slug>.int.<domain>` | Wildcard `*.int.<domain>` → LAN-IP in Router, AdGuard oder Pi-hole | Ziel |
| 2. nip.io | `<slug>.192-168-1-10.nip.io` | Funktionierende Internet-Auflösung, kein DNS-Rebinding-Schutz | Rückfall, in M1 immer aktiv |
| 3. `/etc/hosts` | `<slug>.int.<domain>` | Eine Zeile pro Gerät, von Hand eingetragen | Notlösung |

**nip.io** löst `<beliebig>.192-168-1-10.nip.io` öffentlich auf `192.168.1.10` auf. Kosten: ein zusätzlicher Host-Matcher pro Route, sonst nichts. Der Alias wird aus `SERVER_LAN_IP` gebildet (Auto-Erkennung als Vorgabe, per Env überschreibbar).

Die häufigste Störung ist **DNS-Rebinding-Schutz**: Fritz!Box, AdGuard Home und Pi-hole verwerfen öffentliche DNS-Antworten, die auf private IPs zeigen. AdGuard und Pi-hole haben Ausnahmelisten, bei der Fritz!Box muss `nip.io` als Ausnahme eingetragen werden. Geht das nicht, bleibt Weg 3.

**`/etc/hosts`** kennt keine Wildcards, also braucht jedes Projekt eine eigene Zeile. Deshalb erzeugt deployer den Block selbst und bietet ihn zum Kopieren an (`GET /system/hosts`):

```
192.168.1.10  deployer.int.example.ch whoami.int.example.ch solar.int.example.ch
```

Der Block ändert sich bei jedem neuen oder gelöschten Projekt – die System-Ansicht markiert das sichtbar, damit man nicht rätselt, warum genau das neue Projekt nicht aufgeht.

**Geprüft wird im Browser, nicht auf dem Server.** Die Frage ist «kann *dieses Gerät* den Namen auflösen», und eine Auflösung auf dem Server beantwortet sie nicht. Die System-Ansicht holt darum per `fetch` `/health` über jeden der drei Namen und zeigt pro Weg erreichbar oder nicht. `/health` erlaubt dafür CORS für interne Herkünfte, sonst ist die Antwort opak und nicht auswertbar.

Zwei Dinge zum Mitnehmen: nip.io trägt Slug und LAN-IP in öffentliche DNS-Anfragen – kein Geheimnisverlust, aber ein Grund, es als Rückfall und nicht als Normalweg zu führen. Und mit M4 deckt das Wildcard-Zertifikat nur `*.int.<domain>` ab; nip.io bekommt kein Zertifikat und bleibt HTTP. Die Krücke ist für M1 gedacht und verliert ihren Zweck, sobald der lokale DNS steht.

## 3. Datenbank-Schema

PostgreSQL 17, Drizzle, Migrationen laufen beim Boot. Die Tabellen werden in voller Spec-Breite angelegt, auch wenn M1 nur einen Teil füllt – Spalten später nachzuziehen ist billig, ein Datenmodell umzubauen nicht.

**`projects`**
`id` uuid pk · `name` text · `slug` text unique (`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`) · `source_type` enum(`image`,`static`,`dockerfile`,`compose`,`files`) · `source_config` jsonb · `port` int null · `healthcheck_path` text default `/` · `status` enum(`created`,`deploying`,`running`,`stopped`,`failed`) · `desired_state` enum(`running`,`stopped`) · `keep` bool · `cpu_limit` numeric default 1 · `memory_limit_mb` int default 512 · `created_at`/`updated_at`

Zusätze gegenüber der Spec-Tabelle:

- **`desired_state`** getrennt vom `status`. Ohne das weiss der deployer nach einem Serverneustart nicht, ob ein gestoppter Container gewollt gestoppt oder abgestürzt ist. Die Spec fordert «Alle aktiven Projekte starten von selbst wieder» – das braucht genau diese Unterscheidung.
- **`source_config` als jsonb** statt vieler Spalten, weil die fünf Quelltypen sehr unterschiedliche Felder haben. Validierung über das Zod-Schema in `shared`, nicht über die Spaltendefinition.
- `local_repo_path` aus der Spec kommt erst mit M3 dazu.

**`deployments`**
`id` uuid pk · `project_id` fk cascade · `version` text (Image-Digest, oder sha256 des Inhalts bei statisch) · `source_ref` text (das angefragte Tag, z.B. `:1.2`) · `status` enum(`pending`,`pulling`,`starting`,`healthchecking`,`active`,`failed`,`superseded`,`rolled_back`) · `error_message` text · `container_id` text · `started_at`/`finished_at` · `log_ref` text · `is_active` bool

**Partieller Unique-Index** `(project_id) WHERE is_active` – erzwingt in der Datenbank, dass es pro Projekt genau eine aktive Version gibt. Absicherung gegen den klassischen Fehler, dass zwei Deployments parallel durchlaufen und beide «aktiv» bleiben.

**`routes`**
`id` · `project_id` fk cascade · `target` enum(`public`,`lan`,`tailnet`) · `hostname` text unique · `cf_dns_record_id` text null · `access_protected` bool · unique(`project_id`,`target`)

M1 schreibt hier nur `lan`. In `hostname` steht die primäre, erreichbare Adresse (siehe «Erreichbarkeit in M1»); ein nip.io-Alias wird daraus berechnet und nicht gespeichert.

**`project_env`** (ersetzt die Spec-Tabelle `Secret`)
`id` · `project_id` fk cascade · `key` text · `is_secret` bool · `value` text null · `value_encrypted` bytea null · unique(`project_id`,`key`)

Ein fertiges Image ohne Umgebungsvariablen ist praktisch nicht nutzbar, deshalb schon in M1. Secrets per AES-256-GCM, Schlüssel aus `data/keys/secrets.key` (Modus 600, nicht in der DB – so verlangt es die Spec). Ein Feld mit `is_secret` statt zwei Tabellen, weil die UI beides in einer Liste zeigt. Die Serialisierung maskiert `value_encrypted` grundsätzlich; es gibt keinen Lese-Endpunkt für Klartext-Secrets.

**`audit_events`**
`id` bigserial · `at` timestamptz · `actor` text (`ui:joel`, später `token:<name>`, `system`) · `action` text (`project.create`, `project.deploy`, `route.set`, …) · `target_type`/`target_id` · `params_masked` jsonb · `result` enum(`ok`,`error`) · `error` text

**Noch nicht in M1:** `domains` (die Basisdomain ist in M1 eine Env-Variable, die Tabelle kommt mit M5/Cloudflare), `external_targets`, `scan_runs`, `findings`, `api_tokens`.

## 4. API-Endpunkte

Basis `/api/v1`. Fehlerformat durchgehend `{ error: { code, message, details? } }`. Jeder schreibende Endpunkt erzeugt einen Audit-Eintrag.

**Auth** – einfaches Passwort (Argon2id-Hash aus Env) plus Session-Cookie (httpOnly, SameSite=Lax). Passkey erst später. Auch wenn der Dienst nur im LAN hängt: ohne Login kann jedes Gerät im Netz Container starten.

`POST /auth/login` · `POST /auth/logout` · `GET /auth/me`

**Projekte**

| Methode | Pfad | Anmerkung |
| --- | --- | --- |
| `GET` | `/projects` | Liste mit Status, URLs, aktiver Version |
| `POST` | `/projects` | legt an, optional `deploy: true` |
| `GET` | `/projects/{id}` | Detail inkl. Env (Secrets maskiert) |
| `PATCH` | `/projects/{id}` | Name, Port, Healthcheck-Pfad, Limits, `keep` |
| `DELETE` | `/projects/{id}` | stoppt, entfernt Container, Netz, Routen; `?purge=true` auch Volumes |
| `PUT` | `/projects/{id}/env` | ganze Liste ersetzen, atomar |

**Betrieb**

| Methode | Pfad | Anmerkung |
| --- | --- | --- |
| `POST` | `/projects/{id}/deploy` | Body `{ ref? }`, antwortet sofort mit `deployment`, Fortschritt per SSE; `409`, wenn für das Projekt schon ein Deploy läuft |
| `POST` | `/projects/{id}/start` · `/stop` | setzt `desired_state` und führt aus |
| `GET` | `/projects/{id}/deployments` | letzte 20 |
| `GET` | `/deployments/{id}` | Detail + Log-Inhalt |
| `GET` | `/deployments/{id}/events` | **SSE**, Fortschritt der Pipeline |
| `GET` | `/projects/{id}/logs` | Container-Logs, `?lines=` (max 500), `?since=` |
| `GET` | `/projects/{id}/logs/stream` | **SSE**, Live-Logs |
| `PUT` | `/projects/{id}/routes` | Body `{ targets: ['lan'], subdomain }` |

`POST /projects/{id}/rollback` ist laut Spec M2 – im Datenmodell vorbereitet, in M1 nicht umgesetzt.

**Sonstiges**

`POST /uploads` (multipart, ZIP für statische Seiten, gibt `upload_id` für `source_config`; Grössen- und Anzahlgrenzen siehe Deploy-Ablauf) · `GET /audit?limit=&cursor=` · `GET /system/status` (Docker, Caddy, DB, freier Plattenplatz, Version) · `GET /system/hosts` (`text/plain`, fertiger Block für `/etc/hosts`) · `GET /health` (ohne Auth, für den Compose-Healthcheck und für die Erreichbarkeitsprüfung aus dem Browser – CORS für interne Herkünfte erlaubt)

**SSE statt WebSockets** für Logs und Deploy-Fortschritt: Die Spec nennt SSE bereits für Logs, es ist einseitig, überlebt Proxy und Reconnect von selbst und spart eine Abhängigkeit.

## 5. Web-UI

Der visuelle Stil wird hier nicht festgelegt – laut Projektregel bestimmt den ausschliesslich der Taste Skill. Unten steht nur Informationsarchitektur, Zustände und Abläufe; Layout, Farben und Typografie kommen in einem eigenen Schritt.

React 19 + Vite, TanStack Query für Serverzustand, React Router, Zod-Schemas aus `packages/shared` (ein Typ für Backend und Frontend).

**Fünf Ansichten:**

1. **Projekte** – Liste: Name, Statuspunkt, URL (klickbar), Quelle, letzter Deploy. Aktionen direkt in der Zeile: Öffnen, Neu deployen, Stoppen.
2. **Neues Projekt** – ein Formular, Quelle als erste Entscheidung:
   - *Fertiges Image:* Image-Referenz, Port, Healthcheck-Pfad
   - *Statische Seite:* ZIP hochladen (Drag & Drop)
   - dann gemeinsam: Name → Slug-Vorschau mit der fertigen URL, Umgebungsvariablen (Key/Value, Schalter «geheim»), Erreichbarkeit (in M1 nur LAN; `öffentlich`/`Tailnet` sichtbar, aber deaktiviert mit Hinweis – zeigt den Weg, ohne zu lügen)
3. **Projekt-Detail** – vier Reiter: *Übersicht* (Status, URLs, Limits, Start/Stopp/Neu deployen/Löschen), *Deployments* (Liste mit Version, Dauer, Ergebnis; Klick öffnet das Log), *Logs* (live), *Einstellungen* (Env, Limits, Healthcheck)
4. **Audit** – Tabelle, filterbar nach Aktion und Projekt
5. **System** – Docker/Caddy/DB erreichbar, Plattenplatz, Version; dazu **Erreichbarkeit**: die drei Wege je mit Live-Prüfung aus dem Browser und der kopierfertige `/etc/hosts`-Block

**Zustände, die jede Ansicht braucht** (der Teil, der sonst vergessen wird): leer · lädt · Deploy läuft (Schrittanzeige aus dem SSE-Stream: Ziehen → Starten → Healthcheck → Umschalten) · fehlgeschlagen (Fehlermeldung plus Log direkt daneben, nicht zwei Klicks entfernt) · API nicht erreichbar.

Löschen fragt nach und verlangt das Eintippen des Slugs. Secrets werden in der UI nie zurückgelesen, nur überschrieben.

## Deploy-Ablauf in M1

**Fertiges Image:** Projekt-Lock holen → Deployment anlegen → `docker pull`, Digest als `version` festhalten → Projekt-Netz sicherstellen → Container anlegen (kein Host-Port, Labels `deployer.project`/`deployer.deployment`, Env, CPU/RAM-Limit, `no-new-privileges`, Log-Rotation, `restart: unless-stopped`; die Richtlinienprüfung läuft hier) → starten → deployer ins Projekt-Netz hängen, Healthcheck pollen (max 60 s), wieder trennen → Caddy ins Netz hängen und Route setzen → neues Deployment aktiv, altes `superseded`, alter Container weg (Image bleibt für Rollback) → Lock freigeben.

**Sperre gegen parallele Deploys.** Pro Projekt ein Postgres Advisory Lock, geholt mit `pg_try_advisory_lock` auf einer eigenen Verbindung; der Schlüssel ist eine feste Klassen-ID plus ein Hash der Projekt-ID. Drei Gründe für genau diese Variante:

- **Sitzungsweit, nicht transaktionsweit.** Ein Deploy dauert Minuten und umfasst viele Transaktionen; `pg_advisory_xact_lock` wäre nach der ersten wieder offen.
- **`try` statt blockierend.** Läuft schon ein Deploy, antwortet die API sofort mit `409` statt den zweiten Aufruf minutenlang hängen zu lassen.
- **Selbstheilend.** Stirbt der Prozess, schliesst Postgres die Verbindung und gibt den Lock frei. Ein Statusfeld in einer Tabelle bliebe dagegen für immer auf «läuft» stehen und müsste von Hand aufgeräumt werden.

Freigabe im `finally`. Der partielle Unique-Index auf `is_active` bleibt als letzte Absicherung in den Daten – der Lock verhindert das Rennen, der Index fängt ab, was trotzdem durchkommt.

Das Muster «erst starten, dann umschalten» ist in M1 praktisch gratis und ist genau die Grundlage, auf der M2 das Umschalten ohne Ausfall aufsetzt.

**Statische Seite:** ZIP prüfen und entpacken nach `/srv/sites/<slug>/<sha256>/` → Symlink `current` umhängen (das ist das Umschalten) → Caddy-Route auf `file_server`. Kein Container, kein Netz. Die letzten 5 Versionsordner bleiben. Ein optionaler Build-Befehl in einem Wegwerf-Container ist in M1 machbar, gehört aber ans Ende von M1, nicht in die Voraussetzungen.

**Entpacken ist der gefährlichste Teil von M1**, weil hier fremde Daten Pfade auf dem Dateisystem bestimmen. Regeln:

- **Zip Slip:** Jeder Eintragspfad wird normalisiert und aufgelöst und muss danach unterhalb des Zielordners liegen. Absolute Pfade, `..`-Segmente und Laufwerksangaben werden abgelehnt – geprüft am aufgelösten Ergebnis, nicht per Textsuche nach `..`.
- **Links:** Symlinks und Hardlinks im Archiv werden abgelehnt. Das ist die zweite Hälfte von Zip Slip: Ein Symlink-Eintrag auf `/etc` und eine nachfolgende Datei «darunter» schreiben sonst am Zielordner vorbei, obwohl jeder einzelne Pfad harmlos aussieht.
- **Nur reguläre Dateien und Ordner**, Modus-Bits auf `0644`/`0755` normalisiert.
- **Grenzen:** Archiv max. 100 MB, entpackt max. 500 MB gesamt, max. 10 000 Einträge, max. 50 MB pro Datei. Überschreitung bricht ab und räumt auf.
- **Die Grenzen werden beim Entpacken mitgezählt, nicht vorher aus dem Zip-Verzeichnis gelesen** – bei einer Zip-Bombe lügen genau diese Angaben.
- Entpackt wird in einen temporären Ordner; erst nach vollständig bestandener Prüfung wird er an seinen Platz verschoben. Ein abgebrochener Upload hinterlässt damit keine halbe Seite.

**Caddy-Konfiguration immer vollständig neu laden:** Nach jeder Änderung und beim Start baut der deployer die komplette Caddy-Konfiguration aus der Datenbank und lädt sie per `POST /load` – **die Datenbank ist die Wahrheit, Caddys Zustand ist abgeleitet.** *(Umgesetzt anders als ursprünglich geplant: statt einzelner Routen per `@id` gibt es nur diesen einen Weg. Bei einer Handvoll Projekte ist der volle Neuaufbau billig, und es kann kein Drift zwischen Einzeländerungen entstehen.)* Nach jedem Laden prüft der deployer, dass die Admin-API noch auf dem Unix-Socket lauscht.

## Reihenfolge der Umsetzung

1. Monorepo-Gerüst, Compose-Stack hochfahren mit einem Hello-World-deployer → Caddy liefert die UI im LAN aus, über lokalen DNS *und* über nip.io (die Rückfallwege früh prüfen, nicht am Ende)
2. DB-Schema, Migrationen, Konfigurationsvalidierung
3. `drivers/docker.ts` und `drivers/caddy.ts` isoliert, mit einem Skript von Hand durchgespielt – die Richtlinienprüfung bekommt dabei als Erstes Tests, die bewusst `privileged`, `/`-Mounts und `network_mode: host` versuchen
4. Pipeline für `image` plus Audit-Log
5. REST-API und Auth
6. Web-UI
7. Quelle `static` plus Upload
8. Reconcile beim Start, nächtliches Aufräumen (alte Deployments, verwaiste Netze, ungenutzte Images)
9. Abnahme

**Abnahmekriterien für M1** (Stand 6.11.2026, geprüft lokal auf Docker Desktop 29 / macOS):

- [x] `traefik/whoami` ist in unter 2 Minuten erreichbar – *gemessen: 6 s*
- [x] Server neu starten → Projekte mit `desired_state: running` laufen wieder – *Projekt-Container gestoppt, deployer neu gestartet: Reconcile startet ihn, URL wieder 200. Caddy allein neu gestartet: Routen bleiben dank `--resume`.*
- [x] Projekt löschen hinterlässt keinen Container, kein Netz, keine Route, keinen Seitenordner
- [x] Kein Projekt-Container hat einen Host-Port – *`PortBindings` leer, `Privileged=false`, `CapAdd=[]`, `no-new-privileges`*
- [x] deployer-Stack im Leerlauf unter 300 MB RAM – *gemessen: zusammen rund 90 MiB (deployer 42, Postgres 23, Caddy 14, Proxy 10)*
- [x] Ein fehlgeschlagener Deploy lässt die vorherige Version laufen – *falscher Port → Healthcheck scheitert, alte Fassung antwortet weiter mit 200, Log im Deployment*
- [x] Ein Gerät ohne DNS-Eintrag erreicht ein Projekt über nip.io – *`whoami-test.192-168-0-63.nip.io` → 200. Die Browser-Prüfung in der System-Ansicht ist gebaut, aber nicht im Browser angesehen (siehe unten).*
- [ ] **IP-Filter auf dem Linux-Server getestet** – *offen. Auf dem Mac nicht prüfbar, dort läuft er bewusst mit `off`.*
- [x] `privileged`, Host-Bind-Mount, `network_mode: host` werden abgelehnt – *als Unit-Tests der Richtlinienprüfung. Über die API lässt sich keines dieser Felder setzen, deshalb gibt es dafür keinen Ende-zu-Ende-Fall; die Prüfung schützt künftige Codepfade.*
- [x] Ein **unbekanntes** Feld in `HostConfig` wird abgelehnt (Unit-Test)
- [x] **Ein Projekt-Container erreicht die Caddy-Admin-API nicht** – *`curl deployer-caddy:2019` aus dem Projekt-Netz scheitert, `deployer-caddy:80` aus demselben Netz antwortet: die Trennung liegt am Socket, nicht am Netz*
- [x] Zwei gleichzeitige Deploys: der zweite bekommt `409`, es entsteht kein zweiter Container
- [x] Präpariertes ZIP mit `../` und mit Symlink schreibt nichts ausserhalb – *Unit-Tests plus Ende-zu-Ende über Upload und Deploy*
- [x] Nach einem fehlgeschlagenen Healthcheck hängt der deployer in keinem Projekt-Netz mehr

### Befunde aus der Umsetzung

Die Abnahme hat vier Fehler gefunden, die die Unit-Tests nicht gefunden hätten. Alle sind behoben:

1. **Docker-Gateway wanderte ins Projekt-Netz.** Bei gleicher Priorität wählt Docker das alphabetisch erste Netz als Gateway eines Containers – `dep_…` sortiert vor `deployer_edge`. Sobald Caddy in ein Projekt-Netz gehängt wurde, lief seine ausgehende Standardroute durch dieses Netz, und beim Trennen riss die Veröffentlichung von Port 80 ab: der ganze Dienst war vom Host aus nicht mehr erreichbar. Behoben mit `gw_priority: 100` auf `edge` in `compose.yaml` und zusätzlich `GwPriority: -100` beim Einhängen in Projekt-Netze.
2. **Caddy verlor nach eigenem Neustart alle Routen.** Ohne `--resume` lädt Caddy nur das Bootstrap-Caddyfile, bis der deployer neu startet. Behoben mit `caddy run --resume`.
3. **Netz trennen warf unter Docker 29 HTTP 500** statt 403/404 für „nicht verbunden“. Löschen brach dadurch ab – nachdem die Container schon entfernt waren. Verbinden und Trennen prüfen jetzt zuerst die Mitgliedschaft.
4. **Harmlose ZIPs aus Pythons `zipfile` wurden abgelehnt**, weil sie Rechte-Bits ohne Dateityp-Bits speichern. Typ-Bits 0 gelten jetzt als Datei; abgelehnt bleiben Symlinks, Geräte, FIFOs, Sockets.

Dazu: Ein `host`-Matcher `"*"` trifft in Caddy nicht auf alles – die Auffangroute hat deshalb keinen Matcher.

### Nachtrag: Lücke in der Anmeldung (behoben in M3)

Das Code-Review von M3 hat eine Lücke gefunden, die seit diesem Meilenstein bestand: Der Auth-Wächter prüfte den rohen Pfad (`beginnt mit /api/`), der Router dekodiert Prozentkodierung aber vorher. `/%61pi/v1/projects` lieferte damit **ohne Anmeldung** die Projektliste, und ein POST darauf hätte Container gestartet. Erreichbar war das aus dem LAN. Behoben im M3-Commit: Der Wächter entscheidet am Routenmuster; ein Regressionstest steht in `e2e/m1.e2e.ts`.

### Noch nicht gesehen

- **Die Ansichten nach dem Login** sind gebaut und typgeprüft, aber nicht im Browser angesehen. Das Screenshot-Skript des Taste Skills kann keine Sitzung setzen; geprüft ist nur die Anmeldeseite (dunkel, 1440 und 390).
- **Der Hell-Modus** ist nicht sichtbar geprüft: das Skript erzwingt ohne `--dark` kein helles Farbschema.

## Entscheidungen

### Noch offen

- [ ] **Basisdomain** – welche Domain wird `int.<basisdomain>`? Blockiert den Start nicht: `INTERNAL_BASE_DOMAIN` bleibt leer, bis dahin ist die nip.io-Adresse die Hauptadresse.

### Getroffen (6. November 2026)

- [x] **Rückfallwege für die Erreichbarkeit:** lokaler DNS als Ziel, nip.io als Rückfall, `/etc/hosts` als Notlösung – siehe «Erreichbarkeit in M1 – drei Wege».
- [x] **Kein TLS in M1.** `tls internal` bringt bei einer Browser-Warnung kaum Sicherheit und stört beim Testen. HTTP im LAN, richtige Zertifikate ab M4.
- [x] **Login ja**, schon in M1: Passwort plus Session-Cookie. Passkey später.
- [x] **Env/Secrets ja**, schon in M1: `project_env` mit `is_secret`, verschlüsselt über eine Schlüsseldatei.
- [x] **pnpm-Monorepo ja** – das geteilte Zod-Paket `shared` zwischen API und Web ist der Grund: ein Typ für beide Seiten.
- [x] **Richtlinienprüfung in `drivers/docker.ts`** statt Vertrauen in den Socket-Proxy, der nur Endpunkte filtert und keinen Root-Zugriff verhindert.
- [x] **deployer hängt nur für den Healthcheck im Projekt-Netz** und trennt sich danach wieder.
- [x] **IP-Filter per Env abschaltbar** für Docker Desktop, Vorgabe an, mit sichtbarer Warnung wenn aus.
- [x] **Caddy-Admin-API nur über Unix-Socket** im Volume `caddy_admin`, kein TCP `:2019` – sonst erreichbar aus jedem Projekt-Netz.
- [x] **Richtlinienprüfung als Erlaubnisliste**, nicht als Sperrliste: unbekannte `HostConfig`-Felder werden abgelehnt.
