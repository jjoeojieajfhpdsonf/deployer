# Airlock

Airlock bringt eigene Web-Projekte auf den Homeserver: aus dem Chat (MCP), aus einem Git-Repo, als Compose-Projekt, als statische Seite oder als fertiges Image. Jedes Projekt ist wahlweise im Tailnet, im Heimnetz oder öffentlich über Cloudflare Tunnel erreichbar und wird bei jedem Deploy auf Sicherheit geprüft.

- Installation: [`docs/INSTALL.md`](docs/INSTALL.md)
- Was Airlock kann und wie: [`docs/SPEC.md`](docs/SPEC.md)
- Wiederherstellen aus dem Backup: [`docs/RESTORE.md`](docs/RESTORE.md)

Airlock ist für **eigene Web-Projekte** zuständig. Den ganzen Homeserver – CPU, Arbeitsspeicher, andere Dienste wie Jellyfin oder Pi-hole – zeigt [HomeBento](https://github.com/jjoeojieajfhpdsonf/homebento).

## Mit HomeBento

HomeBento ist das Dashboard für den ganzen Homeserver. Airlock liefert ihm drei Dinge:

### 1. Labels an den Containern

HomeBento schlägt Container anhand ihrer Docker-Labels als Kacheln vor. Airlock setzt sie beim Deploy:

| Container | Labels |
|---|---|
| Projekt (ein Container) | `homebento.name` = Projektname, `homebento.href` = Hauptadresse, `homebento.icon` bei bekanntem Image |
| Compose-Projekt, Web-Dienst | `homebento.name` = «Projekt · Dienst», `homebento.href` = Hauptadresse |
| Compose-Projekt, übrige Dienste | `homebento.name` = «Projekt · Dienst», `homebento.icon` bei bekanntem Image (z. B. `postgres`, `redis`) |
| Airlock selbst (airlock, caddy, postgres, socket-proxy, cloudflared, airlock-status, backup, firewall) | `homebento.ignore: "true"` |
| Wegwerf-Container (Scan, Build, Kopien, Prüfungen, Smoke-Tests) | `homebento.ignore: "true"` |

- **Hauptadresse:** die öffentliche, solange sie live ist, sonst die im Tailnet, dann die im LAN. Ohne Adresse fehlt `homebento.href`.
- **Icons** stammen aus [dashboard-icons](https://github.com/homarr-labs/dashboard-icons); Airlock setzt sie nur für bekannte Hilfsdienste. Eigene Apps haben keins.
- **Eigene Labels gewinnen:** Steht in der `compose.yaml` eines Projekts schon `homebento.*`, übernimmt Airlock diese Werte.
- **Wann die Labels nachziehen:** Docker kann Labels laufender Container nicht ändern. Neuer Name oder neue Hauptadresse (öffentlich gemacht, pausiert) erscheinen beim nächsten Deploy. Bei Compose erzeugt Compose den betroffenen Dienst dann neu; Volumes bleiben.
- **Bestehende Installation:** Die eigenen Dienste bekommen das Label mit `docker compose up -d`. Der von Airlock gestartete cloudflared-Container bekommt es erst, wenn Airlock ihn neu anlegt, etwa beim nächsten Update von cloudflared (Einstellungen › Cloudflare). Bis dahin in HomeBento von Hand ausblenden.

### 2. Token «Nur lesen»

Für Dashboards gibt es einen eigenen Token-Umfang. Ein Token «Nur lesen»

- kommt nur an `GET /api/v1/summary` – jede andere Route antwortet mit 403, auch MCP;
- kann nichts ändern und sieht nichts Geheimes: keine Variablen, keine Logs, keine Quelle, keine Befund-Texte;
- gehört wie jedes Token zu genau einer Umgebung.

Anlegen unter **Einstellungen › Tokens › Vorlage «Für HomeBento»**. Bestehende Tokens behalten vollen Zugriff.

`GET /api/v1/summary` liefert je Projekt:

- Name, Zustand, Hauptadresse und ob es öffentlich ist
- Note und offene Befunde
- «braucht Aufmerksamkeit» mit Grund (dieselbe Regel wie der Filter in Airlock)
- Besucher heute
- Verfügbarkeit 24 h und 30 Tage
- Ablauf des Zertifikats
- ob gerade ein Deploy läuft

Dazu die laufenden Deploys und Summen. Den genauen Aufbau beschreibt `SummaryDto` in [`packages/shared/src/summary.ts`](packages/shared/src/summary.ts).

```sh
read -rs "AIRLOCK_TOKEN?Token: "   # zsh; in bash: read -rsp "Token: " AIRLOCK_TOKEN
curl -s -H "Authorization: Bearer $AIRLOCK_TOKEN" https://deployer.int.example.ch/api/v1/summary
unset AIRLOCK_TOKEN
```

Zur Verfügbarkeit: Sie stammt aus der Messung der Statusseite (jede Minute, gezählt je Tag). Gemessen werden nur Projekte, die auf der Statusseite erscheinen. «24 h» heisst deshalb heute und gestern; ohne Messung steht `null`.

### 3. Plugin für HomeBento

[`docs/homebento/airlock.js`](docs/homebento/airlock.js) ist ein HomeBento-Plugin ohne Abhängigkeiten. Die Kachel zeigt:

- wie viele Projekte laufen
- wie viele Aufmerksamkeit brauchen
- hohe und kritische Befunde
- Besucher heute
- in der Liste jedes Projekt mit Zustand bzw. Grund, Note, Besuchern und Verfügbarkeit

Projekte, die Aufmerksamkeit brauchen, und ein bald ablaufendes Zertifikat (unter 14 Tagen) erscheinen als Warnung.

1. `docs/homebento/airlock.js` nach `data/plugins/airlock.js` von HomeBento kopieren (in Docker `./data/plugins` neben der Compose-Datei) und HomeBento neu starten.
2. In HomeBento einen Dienst «Airlock» mit der Adresse von Airlock anlegen, z. B. `https://deployer.int.example.ch`, und als Art «Airlock» wählen. Der Container von Airlock trägt `homebento.ignore` und wird deshalb nicht vorgeschlagen.
3. Das Token «Nur lesen» ins Feld «API-Token» eintragen.

### Wer meldet was

Die Auslastung des Servers (CPU, Arbeitsspeicher) zeigt und meldet nur HomeBento. Airlock zeigt auf der Platte nur noch den Speicher (mit «Aufräumen»), weil Deploys davon abhängen: ab 80 % ein Hinweis, ab 95 % keine Deploys mehr.

Airlock meldet:

- gescheiterte Deploys
- neue kritische und hohe Befunde
- Einbruchsindizien (Vorfälle)
- Zertifikat und Tunnel
- volle Platte

Dazu meldet es, was es selbst betreibt: Backup, Ablauf von Chat-Projekten, öffentlich geschaltete Projekte, Anfragen über das Docker-Gateway und die Wochenübersicht.
