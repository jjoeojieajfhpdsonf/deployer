# Bericht – Bestehender Dienst

Branch `bestehender-dienst`, ab `abgrenzung-homebento` (65fb7a5), weil Punkt 5 den Summary-Endpunkt von dort braucht. Lokal committet, nicht gepusht. Migration **0032**.

Ziel: etwas, das schon läuft und nicht von Airlock deployt wurde, über Airlock erreichbar machen – intern und auf Wunsch öffentlich –, ohne es zu verwalten.

## Übersicht

| Punkt | Stand |
|---|---|
| 1 Neues Projekt › «Bestehender Dienst» (Container / Adresse, Prüfung vor dem Anlegen) | fertig |
| 2 Verhalten (kein Deploy, Übersicht, Healthcheck, Aufbau, Scans, Vorfälle) | fertig |
| 3 Zugang: Offen, Airlock-Login (forward_auth), Cloudflare Access; Schutz-Pflicht für Admin-Oberflächen | fertig |
| 4 Konflikte, Wiederfinden, «Ziel fehlt» | fertig |
| 5 Nur lesen, Summary `kind: external` | fertig |
| 6 MCP `create_project` mit `source external` | fertig |
| Tests, Smoke-Skript, Screenshots | fertig, Smoke gegen echtes Docker grün |

## 1. Neues Projekt › Bestehender Dienst

Neue Kachel «Bestehender Dienst» (auch `?quelle=bestehend`) mit zwei Wegen.

**Container auf diesem Server**

- Liste laufender Container über den Socket-Proxy (nur `GET /containers/json`).
- Nicht angeboten werden Airlocks eigene und verwaltete Container:
  - `airlock.managed` / `deployer.managed`
  - `airlock.role` / `airlock.system` / `airlock.check` / `airlock.smoke`
  - Compose-Projekt `airlock` / `deployer`
  - Namen `airlock-*`
- Container mit Route sind ausgegraut: «Schon über Airlock erreichbar: <Projekt>» (Punkt 4).
- Der Port wird aus EXPOSE bzw. den veröffentlichten Ports vorgeschlagen (Datalist); fehlt einer, gibt man ihn ein.
- Erkannte Admin-Oberflächen sind markiert und schalten «Mit Airlock-Login schützen» gleich ein.

**Netz**

| Fall | Ziel für Caddy |
|---|---|
| eigenes Netz | Caddy hängt im alphabetisch ersten Netz, Ziel `Name:Port` |
| nur `bridge` | die IP des Containers |
| `network_mode: host` | `host.docker.internal:Port` (`extra_hosts: host-gateway` für Caddy und Airlock in compose.yaml) |
| nur Netze von Airlock oder kein Netz | Fehlermeldung |

- Welche fremden Netze Airlock Caddy angehängt hat, merkt es sich in `app_settings`. Nur diese trennt es wieder; ein Netz, in dem Caddy aus anderem Grund hängt, bleibt.

**Adresse im Heimnetz**

- Nur IPv4 aus 10/8, 172.16/12, 192.168/16 und 100.64/10.
- Abgelehnt werden:
  - Namen (DNS könnte später woanders hinzeigen)
  - Zugangsdaten
  - Pfade
  - IPv6
  - 127.x, 169.254.x und öffentliche Adressen
- Option «Eigenes Zertifikat erlauben» für selbstsigniertes HTTPS.

**Vor dem Anlegen**

- «Erreichbarkeit prüfen» zeigt Status, Antwortzeit, Seitentitel, Weg (Netz bzw. Bereich) und eine erkannte Admin-Oberfläche.
- Selbstsigniertes HTTPS ohne die Option wird erkannt und erklärt.
- «Prüfen und anlegen» prüft zuerst. Antwortet das Ziel nicht, steht der Grund da, und der Knopf heisst «Trotzdem anlegen».

## 2. Verhalten

- Projekt mit `source_type = external`; es läuft sofort (`running`), ohne Fassung.
- Gesperrt mit 409 «nicht verwaltet»: Deploy, Start, Stopp, Neustart, Rollback und «Neu erstellen». Das gilt in Pipeline und Lifecycle, also für Oberfläche, REST, MCP und Auto-Deploy.
- Der Abgleich beim Start überspringt bestehende Dienste.

**Oberfläche**

- Ohne «Neu deployen»; «Öffnen» ist die Hauptaktion.
- Ohne die Reiter Deployments und Logs; im Menü kein Neustart und kein Stopp, «Aus Airlock entfernen».
- Übersicht: Karte «Wird nicht von Airlock verwaltet» mit Ziel, Image, Compose, Weg für Caddy, HTTPS zum Ziel und Healthcheck.
- Eckdaten: Quelle, Ziel, Zugang, Healthcheck-Pfad.
- Einstellungen ohne Ausgang, Variablen, Container, Auto-Deploy, Vorschauen und Ablauf.
- Healthcheck = HTTP auf das Ziel (Pfad aus den Einstellungen); jede Antwort unter 500 zählt. Statusseite und automatische Störungen nutzen ihn.

**Aufbau**

- Nur Zugang → Eingang → Ziel.
- Spalte «Ziel» («Container, nicht verwaltet» bzw. «Adresse im Heimnetz»); die Datenspalte sagt «Nicht von Airlock verwaltet».
- Seitenkarte nur mit Erreichbarkeit und Ziel: keine Messwerte, keine Logs, kein Neustart, kein Ausgang.

**Scans**

- Stufen: Webseite (ZAP), Header (über Caddy), Dateien/Panels (Nuclei), TLS (testssl, nur bei https-Ziel). Keine Image- und Code-Stufen.
- Der erste Scan läuft nach dem Anlegen (folgt `SCAN_AFTER_DEPLOY`). Ein bestandener Scan ist wie immer die Voraussetzung für «öffentlich».
- Scanner entstehen weiter nur in `air_<slug>`; die Richtlinie ist unverändert.
- Airlock leitet für die Dauer des Scans eine TCP-Verbindung zum Ziel durch (`security/external-relay.ts`, lauscht nur auf seiner Adresse im Projekt-Netz). TLS bleibt dabei Ende-zu-Ende, am fremden Container ändert sich nichts.

**Vorfälle**

- Nur Web und Netz; Zustand «Web und Netz» mit Erklärung.
- Prozess- und Datei-Überwachung entfallen (Airlock kennt fremde Container nicht), ebenso «Container stoppen» und «Isolieren».

## 3. Zugang (alle Projekte)

Einstellungen › **Zugang**, bei bestehenden Diensten als erste Karte (hervorgehoben): «Offen», «Airlock-Login», «Cloudflare Access».

**Airlock-Login** (Caddy `forward_auth`, Ablauf in `lib/gate.ts`)

1. Caddy fragt vor jeder Anfrage `GET /api/v1/gate/check`. Ohne gültigen Cookie folgt eine 302 auf `https://<Oberfläche>/api/v1/gate/start`.
2. Nicht angemeldet: Die Oberfläche zeigt die normale Anmeldung (Passwort, Passkey, zweiter Faktor). Danach führt die Seite `/zugang` weiter.
3. Angemeldet: ein einmaliger Code (60 s, an Host und Sitzung gebunden) und 302 auf `<Projekt-Host>/.airlock/gate`.
4. Caddy gibt diesen Pfad an Airlock (`/api/v1/gate/callback`). Airlock setzt den Cookie `airlock_gate` **nur für diesen Host** (kein Domain-Attribut), HttpOnly, SameSite=Lax, Secure bei HTTPS.
5. Das Token ist mit dem Schlüssel von Airlock signiert, an Host und Sitzung gebunden und gilt, solange die Sitzung gilt. Abmelden meldet auch hier ab; der Cache dafür beträgt 30 s.
6. Caddy entfernt den Cookie aus jeder Anfrage an eine App (Go-RE2-Regex). Andere Cookies gehen durch.

Weitere Schutzregeln:

- `check` und `callback` beantwortet Airlock nur, wenn die Anfrage von Caddy kommt.
- `start` geht nur für geschützte Namen, der Rücksprung nur auf Pfade desselben Hosts (keine offene Weiterleitung).
- Header-Check und Scan laufen ohne Login (Probe-Server); die Pause-Seite ebenso.
- Gilt auch für statische Seiten und für die internen Adressen von Compose-Diensten (Adminer & Co.).

**Cloudflare Access**

- Nur für öffentliche Adressen. Airlock legt die Access-Anwendung über die API an (vorhandener Ablauf).
- Fehlt dem Token das Recht, sagt die Meldung, welches Recht fehlt und wie man die Anwendung von Hand anlegt.

**Schwächer machen** (z. B. Login → Offen) geht nur mit Anmeldung und erneuter Bestätigung, nie mit einem Token. Stärker machen geht direkt.

**Admin-Oberflächen**

- Liste `ADMIN_UIS` in shared: *arr, Portainer, Proxmox, Router (OpenWrt, OPNsense, pfSense, FRITZ!Box, UniFi …), NAS (Synology, TrueNAS, OMV, QNAP, Unraid), Home Assistant, Torrent-Clients, Pi-hole/AdGuard, Adminer/phpMyAdmin/pgAdmin, Nginx Proxy Manager, Dockge/Yacht, Cockpit/Webmin.
- Erkennung über das Image (ohne Registry, Tag, Digest) bzw. den Seitentitel aus der Prüfung.
- Öffentlich nur mit Schutz. Geprüft wird in `planPublic`, also bei jedem Weg (Oberfläche, MCP, «nach dem ersten Scan», Umbenennen) und beim Abschalten des Schutzes an einer öffentlichen Route.
- Die Meldung nennt den Grund.
- In «Veröffentlichung» steht vorab ein Hinweis mit «Airlock-Login einschalten» und «Ohne Schutz erlauben …» (sudo, Audit `project.admin_override`, wieder verbietbar).
- Gilt auch für deployte Images solcher Oberflächen (z. B. `adminer`).

## 4. Konflikte und Wiederfinden

- Ein Container bekommt nur eine Route (Name, sonst Compose-Projekt und -Dienst). Die Liste zeigt ihn ausgegraut; das Anlegen lehnt mit 409 ab.
- Jede Minute (Monitor-Runde) sucht Airlock das Ziel wieder: am Namen, sonst am Compose-Projekt und -Dienst, laufende zuerst.
  - Name, ID, Netz und IP werden nachgeführt.
  - Fehlt es: Zustand **«Ziel fehlt»** (rote Pille, Hinweis in der Übersicht, Healthcheck rot). Die Route bleibt und zeigt die Pause-Seite.
  - Ist es wieder da, verschwindet der Zustand von selbst.

## 5. Nur lesen, HomeBento

- Airlock setzt an fremden Containern nichts: keine Labels, kein Netz, kein Start oder Stopp. Der Smoke-Test prüft das am Ende.
- `GET /api/v1/summary`: neues Feld `kind: "managed" | "external"`.

## 6. MCP

`create_project` mit `source {type:"external", container:"<Name>", port}` oder `{type:"external", url:"http://192.168.1.20:8123", insecureTls?}`, dazu `login: true`.

- Kein Deploy; die Antwort nennt das Ziel.
- Bei einer erkannten Admin-Oberfläche ohne Login steht eine Warnung dabei.

## Tests

| Datei | Prüft |
|---|---|
| `api/src/lib/external.test.ts` | Adress-Prüfung (erlaubt, Grenzen der Bereiche, Namen/Zugangsdaten/Pfade/IPv6), Netzwahl, Liste (eigene, gestoppte, UDP-Ports, vergebene), Wiederfinden, Admin-Erkennung, Schutz-Pflicht inkl. Übersteuern, «nicht verwaltet», Zugang, Zustand («Ziel fehlt», gestoppt, pausiert) |
| `api/src/drivers/caddy-external.test.ts` | Caddy-Konfiguration: Ziel, HTTPS mit eigenem Zertifikat, forward_auth (zuerst, Methode/Pfad, ohne Authorization, 2xx weiter), Rückruf-Route vor der Route, nichts im Probe-Server, Pause-Seite ohne Login, Cookie-Regex |
| `api/src/http/routes/gate.test.ts` | forward_auth-Ablauf über HTTP: 302 zur Anmeldung, Weg über `/zugang`, Code einmalig und an den Host gebunden, Cookie-Attribute, fremder Host, verändertes Token, abgemeldete Sitzung, nur Caddy, keine offene Weiterleitung, HTTP ohne Secure |
| `api/src/domain/topology-build.test.ts` | Aufbau: Ziel, fehlt, gestoppt |
| `api/src/http/read-token.test.ts` | Summary `kind`; die neuen Routen fallen unter «jede Route → 403» für Tokens «lesen» |

**`scripts/smoke-bestehend.sh`**: ein vollständiges, abgeschottetes Airlock mit echtem Caddy, Socket-Proxy und Postgres sowie `traefik/whoami` in einem eigenen Netz ohne Labels. Lokal grün:

```
ok: Airlock läuft
ok: Liste: whoami angeboten, Airlocks eigene nicht
ok: Prüfung vor dem Anlegen: Antwortet mit HTTP 200.
ok: angelegt: … unter smoke-whoami.192-168-77-20.nip.io
ok: intern erreichbar (Caddy im Netz smoke_whoami_…)
ok: Deploy abgelehnt (409, nicht verwaltet)
ok: ohne Anmeldung: 302 → http://deployer.192-168-77-20.nip.io/api/v1/gate/start
ok: mit Anmeldung: 200; whoami sieht den Login-Cookie nicht
ok: verändertes Cookie: 302
ok: whoami unverändert (keine Labels, nur sein Netz)
ok: gelöscht: Caddy aus smoke_whoami_… getrennt, whoami läuft weiter
```

Damit sind die von Airlock gebaute `forward_auth`-Konfiguration und der Cookie-Regex in echtem Caddy geprüft.

**Gesamtlauf**

- `pnpm -r test`: API 1439, Web 118, grün.
- `pnpm test:visual`: 1448 grün, 1 rot (`security-csp-qualitaet-hell`, weicht auch auf `main` ab, siehe Bericht HomeBento).
- Zwei axe-Befunde unterwegs behoben:
  - `<ul role="radiogroup">` der Container-Liste
  - ein Hinweistext, der mit dem Feld «Öffentliche Adresse» kollidierte

**Übernommene Referenzbilder**

| Bilder | Warum |
|---|---|
| projekt-einstellungen, einstellungen-*, veroeffentlichung-*, statusseite-projekt, vorschauen-*, loeschen-dialog, m9-verschieben, fehler-grenze-vorschlag, ausgang-frei-bestaetigen, aktion-knopf-laedt, sitzung-*, verlassen-* | neue Karte und Navigationseintrag «Zugang» in den Einstellungen jedes Projekts |
| neues-projekt-chat, neues-projekt-validierung | neue Kachel «Bestehender Dienst» |
| bestehend-* (14) | neu |

**Screenshots** (Szenen `bestehend-*`, hell und dunkel, in `packages/web/visual/referenz/`):

- `bestehend-uebersicht` (Container), `bestehend-adresse` (NAS, Login), `bestehend-ziel-fehlt`
- `bestehend-aufbau`, `bestehend-zugang` (Pflicht-Hinweis)
- `bestehend-neu-container` (gewählt und geprüft), `bestehend-neu-adresse` (selbstsigniert erkannt)

## Entscheidungen und offene Punkte

1. **Cookie nur für den Host statt auf der Basisdomain.** Im Auftrag stand «eigener Cookie auf der Basisdomain, nur für diese Route». Umgesetzt ist ein Cookie ohne Domain-Attribut, also genau für den Host der Route. Gründe:
   - Er gilt damit wirklich nur für diese Route.
   - Er funktioniert auch für öffentliche Namen unter einer anderen Domain.
   - Andere Projekte unter der Basisdomain bekommen ihn nie zu sehen.

   Preis: eine Anmeldung je geschütztem Host (ein Klick, solange die Oberfläche angemeldet ist).
2. **Airlock-Login klappt nur von Geräten, die die Oberfläche erreichen** (Tailnet/LAN). Für eine öffentliche Adresse heisst das: Besucher aus dem Internet kommen nicht durch. Für Fremde ist Cloudflare Access der richtige Schutz; so steht es in der Oberfläche.
3. **Scan über Airlock als Durchleitung** statt die Richtlinie für Scanner zu lockern (fremde Netze). Gegen echtes Docker nur im Smoke-Aufbau getestet, dort mit `SCAN_AFTER_DEPLOY=off`, weil sonst ZAP und Nuclei (GB) gezogen würden. Der erste echte Scan eines bestehenden Dienstes auf dem Server ist noch ungeprüft.
4. **Ziel nachträglich ändern** (anderer Container, andere Adresse) gibt es in der Oberfläche nicht; dafür ein neues Projekt anlegen. Der Healthcheck-Pfad ist noch nicht einstellbar (Standard `/`; die Karte «Container» mit diesem Feld fehlt bei bestehenden Diensten).
5. **Erkennung über den Seitentitel** läuft nur bei der Prüfung vor dem Anlegen. Bei Containern zählt danach das Image.
6. **IPv6 und Namen** für Adressen im Heimnetz sind bewusst nicht erlaubt (siehe Auftrag: IP:Port).
