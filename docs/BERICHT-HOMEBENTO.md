# Bericht – Abgrenzung zu HomeBento

Branch `abgrenzung-homebento` (ab main adf532e), lokal committet, nicht gepusht.

HomeBento ist das Dashboard für den ganzen Homeserver. Airlock ist nur für eigene Web-Projekte zuständig. Airlock zeigt deshalb keine Server-Auslastung mehr, gibt HomeBento aber Labels, ein Token «Nur lesen» und eine lesende Übersicht.

## Übersicht

| Punkt | Stand | Wo |
|---|---|---|
| 1 CPU/RAM raus, «Besucher heute» | fertig | `pages/Projects.tsx`, `routes/system.ts`, `traffic/*` |
| 2 Labels für HomeBento | fertig | `lib/names.ts`, `domain/homebento.ts`, `lib/compose.ts`, `compose*.yaml`, `scripts/smoke-*.sh` |
| 3 `GET /api/v1/summary` und Token «lesen» | fertig, Migration 0031 | `shared/src/summary.ts`, `domain/summary.ts`, `routes/summary.ts`, `http/auth.ts`, `mcp/http.ts`, `pages/Tokens.tsx` |
| 4 Benachrichtigungen | nichts zu entfernen, mit Test festgehalten | `notify/render.test.ts` |
| 5 README «Mit HomeBento» und Plugin | fertig | `README.md` (neu), `docs/homebento/airlock.js`, `docs/SPEC.md` |

## 1. CPU/RAM raus, «Besucher heute»

**Projekte-Seite**

- Die Kennzahl «Arbeitsspeicher» ist ersetzt durch **«Besucher heute»**.
  - Wert: eindeutige Besucher seit Mitternacht über alle Projekte der Umgebung.
  - Darunter die Aufrufe und das meistbesuchte Projekt.
  - Liest Airlock das Zugriffs-Log nicht, steht «–» mit «Zugriffs-Log wird nicht gelesen» bzw. «noch keine Zahlen», nie eine falsche 0.
- Die Karte **«Server»** (CPU, RAM, Platte, Scanner-Warteschlange) ist weg.
- Die **Platten-Warnung bleibt** als eigener Hinweis unter den Kennzahlen, mit Text und Symbol, nicht nur Farbe:
  - ab 80 % «Platte zu N % belegt», in Warnfarbe
  - ab 95 % «– Deploys gesperrt», rot
  - jeweils mit «Aufräumen»
- Unten stehen jetzt nur noch «Letzte Aktivität» und «Aufrufe heute». Die Karte «Aufrufe heute» erscheint ab 1100 px daneben (bisher erst ab 1700 px als dritte Karte). Ohne Zahlen nimmt die Aktivität die ganze Breite.

**API**

- `GET /traffic/today` liefert zusätzlich `visitors` je Projekt. Das sind die schon gespeicherten Tageswerte (`visitors` werden beim ersten Aufruf des Tages gezählt), es braucht keine Migration.
- `GET /system/status` liefert kein `cpuPercent` mehr. Damit fällt auch die Messung (200 ms) bei jedem Aufruf weg. Der Arbeitsspeicher bleibt in der Antwort, weil der Vorschlag für die RAM-Grenze eines Projekts ihn braucht («noch X GB frei»). Angezeigt wird er nicht mehr.

**Server › Übersicht** zeigte schon vorher kein CPU/RAM, nur die Platte. Dort bleibt alles: Speicher mit Aufräumen und Warnung, Backup, Netz-Warnungen, GitHub, Besucher-Quellen.

Die CPU/RAM-Anzeigen **je Projekt** (Übersicht, Aufbau, Grenzen) bleiben. Sie zeigen den Verbrauch gegen die Grenze des Containers und gehören zu Airlock.

## 2. Labels für HomeBento

| Container | Labels |
|---|---|
| Einzelcontainer eines Projekts | `homebento.name` = Projektname, `homebento.href` = Hauptadresse, `homebento.icon` bei bekanntem Image |
| Compose, Web-Dienst | `homebento.name` = «Projekt · Dienst», `homebento.href` |
| Compose, übrige Dienste | `homebento.name` = «Projekt · Dienst», `homebento.icon` bei bekanntem Image |
| `compose.yaml`: airlock, caddy, postgres, socket-proxy, status, firewall, backup; `compose.public.yaml`: cloudflared | `homebento.ignore: "true"` |
| Von Airlock gestartet: cloudflared, Netzprüfung | `homebento.ignore: "true"` |
| Wegwerf-Container: Scan, Build, Kopien für Backup und Volumes, CSP-Prüfung | `homebento.ignore: "true"` |
| Container der Smoke-Skripte | `homebento.ignore=true` |

- **Hauptadresse:** öffentlich, solange live; sonst Tailnet, dann LAN (`mainUrlOf` in shared). Ohne Adresse fehlt `homebento.href`.
- **Sicherung gegen Vergessen:** `buildCreateOptions` setzt `homebento.ignore=true` an jeden Container ohne `homebento.name`. Ein neuer Wegwerf-Container ist damit automatisch ausgeblendet.
- **Icons:** Namen aus dashboard-icons (das Format von HomeBento), nur für bekannte Hilfs-Images: postgres, redis, mariadb, adminer, nginx, minio … Selbst gebaute Images (`airlock/<slug>`) bekommen nie ein Icon.
- **Eigene `homebento.*`-Labels** in der `compose.yaml` eines Projekts gewinnen.

**Folgen, bewusst so gelassen**

- Docker ändert Labels laufender Container nicht. Neue Labels erscheinen erst beim nächsten Deploy.
- Bei Compose erzeugt Compose die Dienste beim ersten Deploy nach dem Update einmal neu, weil sich ihre Labels ändern. Die Volumes bleiben. Dasselbe passiert, wenn sich Projektname oder Hauptadresse ändern.
- Ein Rollback nutzt das alte Artefakt und damit die alten Labels.
- Der laufende cloudflared-Container bekommt das Label erst, wenn Airlock ihn neu anlegt, etwa beim nächsten cloudflared-Update. Steht so in der README.

**Tests:** `lib/homebento.test.ts`

- Hauptadresse
- Labels und Icons
- jede Rolle eines Wegwerf-Containers
- Compose (inkl. «eigene Labels gewinnen»)
- jeder Dienst in `compose.yaml` und `compose.public.yaml`

## 3. `GET /api/v1/summary` und Token «lesen»

**Token-Umfang**

- Migration **0031**: Spalte `api_tokens.scope` mit `voll` (Standard, alle bestehenden Tokens) oder `lesen`.
- **Erlaubnisliste statt Sperrliste:** Ein Token «lesen» kommt im Auth-Wächter nur an `GET /api/v1/summary` und `GET /api/v1/environments/:env/summary`. Alles andere antwortet mit 403, bevor ein Handler läuft. Eine neue Route ist damit nie aus Versehen für Dashboards offen.
- `/mcp` lehnt ein Token «lesen» ebenfalls ab.
- **Test** `http/read-token.test.ts`:
  - geht über die echte App **jede registrierte Route** mit jeder Methode durch (403 «nur lesen»)
  - prüft, dass die Summary am Wächter vorbeikommt
  - prüft, dass MCP ablehnt
  - prüft, dass ein volles Token unverändert bleibt
  - prüft, dass ein Token «lesen» kein Token anlegen kann
- Für den Test lassen sich Tokens ohne Datenbank prüfen (`setTokenVerifier` in `domain/tokens.ts`). REST und MCP nutzen dieselbe Prüfung.

**Summary** (`SummaryDto` in `shared/src/summary.ts`), je Projekt:

- id, slug, name, Zustand (key/label/tone)
- Hauptadresse, `public`
- Note, offene Befunde
- `attention`, `attentionReason`, `attentionTone`
- `visitorsToday`
- `uptime24h`, `uptime30d`
- `certificateExpiresAt`
- `deploying`

Dazu die laufenden Deploys, Summen und das Zertifikat.

- Bewusst aus `ProjectDto` herausgeschnitten, nicht durchgereicht. Ein Test sucht in der Antwort nach Repo-URL mit Token, Fehlermeldung, Zustandsdetail, Grenzen und Projekten anderer Umgebungen.
- **«Braucht Aufmerksamkeit»** liegt jetzt in shared (`attentionOf`). Projektliste und Summary nutzen dieselbe Regel; die Oberfläche ruft sie nur noch auf.

**Einstellungen › Tokens**

- Umschalter «Voller Zugriff / Nur lesen» mit Erklärung.
- Link **«Vorlage «Für HomeBento»»**: setzt den Namen «HomeBento» und «Nur lesen».
- Nach dem Anlegen eines Tokens «lesen» erscheinen statt der Claude-Einrichtung die drei Schritte für HomeBento und ein `curl` zum Prüfen. Das Token wird dabei verdeckt eingelesen.
- Neue Tabellenspalte «Umfang».

## 4. Benachrichtigungen

Server-Alarme zu CPU oder RAM gab es nicht. Ein Test (`notify/render.test.ts`) hält fest, dass keiner dazukommt, und listet die verbleibenden Meldungen.

## 5. README und Plugin

- **`README.md`** (gab es noch nicht): kurze Einleitung, dann «Mit HomeBento» mit Labels, Token, Summary, Plugin und «Wer meldet was».
- **`docs/homebento/airlock.js`**: HomeBento-Plugin ohne Abhängigkeiten im Format von `lib/plugins/` (kind, label, match, fields, fetch).
  - Kennzahlen: laufen, Aufmerksamkeit, Befunde hoch+, Besucher heute
  - Liste: je Projekt
  - Warnungen: Projekte, die Aufmerksamkeit brauchen, und ein Zertifikat unter 14 Tagen
  - Mit einer Beispielantwort ausprobiert, nicht gegen ein echtes HomeBento.
- **`docs/SPEC.md`**, Abschnitt Tokens: Umfang «Nur lesen» und `/summary`.

## Prüfungen

- `pnpm -r typecheck`: grün
- `pnpm -r test`: API 1401 und Web 118 Tests, grün
- `pnpm test:visual`: a11y und Tastatur grün, 72 Bildabweichungen gesichtet
  - Zwei neue Szenen: `tokens-homebento-vorlage` und `tokens-neu-homebento`.
  - `projekte-platte-voll` zeigt jetzt den Hinweis statt der Server-Karte.
- `docker compose config` mit den neuen Labels: gültig

**Übernommene Referenzbilder** (71):

| Bilder | Warum |
|---|---|
| projekte*, breite-projekte-*, m9-projekte, leer-projekte, zustand-*, aktion-vorgaenge | Kennzahl «Besucher heute», Server-Karte weg |
| Szenen über der Projekte-Seite: shell-*, palette*, kuerzel, matrix-regen, terminal-/win95-freigeschaltet, win95-*, achievement-neu, m9-umschalter | dieselbe Änderung im Hintergrund |
| projekte-platte-voll | Hinweis statt Server-Karte |
| tokens*, m9-tokens | Umfang, Vorlage, Spalte «Umfang», neues Fixture-Token «HomeBento» |
| konto | «3 gültig» statt «2 gültig» (dasselbe Fixture-Token) |

**Nicht übernommen**

- `security-csp-qualitaet-hell` weicht um 285 Pixel ab (Kantenglättung im Befundtitel). Auf `main` ist es genauso, es hängt also nicht an dieser Etappe.
- Kontrolllauf danach: 1411 Prüfungen grün, 2 rot.
  - `security-csp-qualitaet-hell`: der Ausreisser von oben.
  - `sitzung-abgelaufen-hell`: einmalig. Einzeln zweimal grün, war im ersten Lauf ebenfalls grün.
- `aufbau-breit-hell` und `projekt-einstellungen-win95` wurden beim Aktualisieren mit erfasst. Sie wichen im ersten Lauf nicht ab und sind zurückgesetzt.

## Fragen und Entscheidungen

1. **«Airlock meldet nur Deploy, Security, Vorfälle, Zertifikat, Disk voll».** Das habe ich als «keine Server-Alarme» umgesetzt. Diese Meldungen bleiben, weil sie Airlocks eigene Aufgaben betreffen:
   - Backup fehlgeschlagen bzw. zu alt
   - Ablauf von Chat-Projekten
   - Projekt öffentlich geschaltet
   - Besitznachweis externer Domains
   - Docker-Gateway
   - Wochenübersicht

   Sollen davon welche weg (z. B. die Wochenübersicht)?
2. **Verfügbarkeit 24 h** stammt aus der Messung der Statusseite. Die zählt nur je Tag und nur Projekte, die auf der Statusseite erscheinen. «24 h» ist deshalb heute plus gestern, ohne Messung `null`. Eine echte Stundenmessung für alle Projekte wäre eine eigene Etappe (neue Tabelle).
3. **Zertifikat-Ablauf je Projekt** ist das Zertifikat der internen Adressen (Wildcard von Airlock). Es steht nur bei Projekten mit HTTPS-Adresse im Tailnet oder LAN. Öffentliche Adressen zertifiziert Cloudflare; das sieht Airlock nicht.
4. **Airlock selbst** trägt `homebento.ignore` (so verlangt), wird in HomeBento also nicht vorgeschlagen. Für das Plugin legt man den Dienst «Airlock» deshalb von Hand an; so steht es in der README.
