# Meilenstein 5 – Öffentlich über Cloudflare

Stand: 7. November 2026

> **Neu (8.11.2026):** Den Tunnel legt deployer selbst an und startet cloudflared als eigenen Container – System → «Cloudflare verbinden», siehe [CLOUDFLARE.md](CLOUDFLARE.md). `compose.public.yaml` und die Variablen unten gelten nur noch als Rückfall.

Umfang laut [SPEC.md](SPEC.md): Cloudflare Tunnel, DNS-Verwaltung, optional Cloudflare Access. Dazu aus M6 die Schwelle für «öffentlich» und die Benachrichtigung «Projekt öffentlich geschaltet».

**Ohne Domain, Token und Tunnel gebaut.** Code und Unit-Tests mit einer Cloudflare-Attrappe; nichts davon lief gegen die echte API.

## 1. Grundsätze

- **Öffentlich nur auf ausdrücklichen Wunsch.** Standard bleibt «nur intern». `public` verlangt über MCP eine Bestätigung (Elicitation oder `confirmation_token`), in der UI eine Rückfrage.
- **Schwelle aus M6:** `assertPublishable()` vor jedem Schritt, der ein Projekt öffentlich macht – kein offener kritischer Befund, und es muss ein abgeschlossener Scan vorliegen. Gilt für `create_project`, `set_targets`, `PUT /routes` und die UI gleich (gemeinsame Service-Funktion).
- **Kein offener Port.** Öffentlicher Verkehr kommt nur über `cloudflared` (ausgehende Verbindung) zu Caddy.
- **deployer selbst wird nie öffentlich.** Der Name `deployer` ist reserviert (M6); zusätzlich weigert sich der Tunnel-Abgleich, eine Ingress-Regel auf die deployer-Route zu setzen.
- **Die Datenbank ist die Wahrheit.** Tunnel-Ingress und DNS werden aus den Routen abgeleitet, wie bei Caddy. Ein Abgleich beim Start und nach jeder Änderung; was deployer angelegt hat (Kommentar `managed by deployer`), räumt deployer auch wieder ab.

## 2. Tunnel

- **Remote verwalteter Tunnel** (SPEC): Konfiguration über die API, keine Datei. `cloudflared` läuft als Container im Stack mit `TUNNEL_TOKEN` aus einer Secret-Datei, nur in `compose.public.yaml` (wie `compose.tls.yaml` in M4: ohne Konfiguration startet der Basis-Stack unverändert).
- `cloudflared` hängt nur im Netz `deployer_edge` und erreicht dort Caddy (`http://caddy:80`). Bei `TLS_MODE=cloudflare` (M4) ist das richtig so: TLS zu den Besuchern macht Cloudflare, zwischen `cloudflared` und Caddy läuft die Verbindung im Docker-Netz. Kein Zugang zu Projekt-Netzen, keiner zum internen Netz.
- **Ingress-Regeln:** pro öffentlichem Hostnamen `{ hostname, service: "http://caddy:80" }`, am Ende die Pflicht-Regel `http_status:404`. Gesetzt mit `PUT /accounts/{account}/cfd_tunnel/{tunnel}/configurations`. Regeln, die nicht von deployer stammen, bleiben erhalten (Hostnamen, die keiner Route gehören und nicht in der deployer-Liste stehen).
  - deployer merkt sich, welche Hostnamen es gesetzt hat (Tabelle `app_settings`, Schlüssel `tunnel_managed_hosts`), damit fremde Regeln unangetastet bleiben.

## 3. DNS

- Pro öffentlicher Route ein **CNAME** `<hostname>` → `<tunnel-id>.cfargotunnel.com`, **proxied**. Die ID steht in `routes.cf_dns_record_id`.
- **Domains:** Tabelle `domains` (`id`, `cf_zone_id`, `name`, `is_default`). `GET /domains` listet die Zonen des Kontos und welche Standard ist; `PUT /domains/default` setzt sie. Ohne Standard und ohne vollen Hostnamen ist `public` nicht möglich.
- **Öffentlicher Name:** `subdomain` + Standard-Zone (`solar.deinedomain.ch`) oder ein voller Hostname, der auf eine Zone des Kontos endet. Abgelehnt: Namen unter der internen Basisdomain, die Zone selbst (Apex), mehr als eine Ebene unter der Zone (Universal-SSL deckt nur eine Ebene).
- Ein bestehender DNS-Eintrag mit demselben Namen, der nicht von deployer stammt, wird **nicht** überschrieben: Fehler mit Hinweis.
- **Löschen eines Projekts** oder Entfernen von `public`: CNAME weg, Ingress-Regel weg, Access-App weg. Fehler beim Aufräumen bei Cloudflare blockieren das Löschen nicht, werden aber protokolliert und als `infra_problem` gemeldet.

## 4. Caddy hinter dem Tunnel

- Öffentliche Hostnamen bekommen in Caddy eigene Routen **ohne LAN-/Tailnet-Filter**, aber **nur** für Anfragen von der Adresse von `cloudflared` (`remote_ip` = `<ip>/32`, über die Docker-API gelesen). Damit ist ein öffentlicher Name nicht an Cloudflare vorbei erreichbar, und interne Namen bleiben aus dem Tunnel unerreichbar (dort gilt weiter der LAN-/Tailnet-Filter).
- **Echte Besucher-IP** (SPEC, wichtig für M7): `trusted_proxies` = dieselbe Adresse, `client_ip_headers: ["CF-Connecting-IP"]`. Bewusst nicht das ganze edge-Subnetz: darin liegt das Docker-Gateway, über das veröffentlichte Ports weitergereicht werden (Review).
- `cloudflared` bekommt bei jedem Neustart eine neue Adresse; deployer prüft alle 30 Sekunden und gleicht Caddy bei einer Änderung neu ab. Läuft `cloudflared` nicht, gibt es keine öffentlichen Routen.

## 5. Cloudflare Access (optional pro Projekt)

- `access_protected` auf der Route. Eingeschaltet: Access-Anwendung (`type: self_hosted`, `domain: <hostname>`) mit einer Richtlinie «E-Mail ist `ACCESS_EMAIL`», Login per Einmal-Code. Ausgeschaltet oder Projekt gelöscht: Anwendung weg.
- Nur mit `ACCESS_EMAIL` gesetzt; sonst Fehler mit Hinweis.

## 6. Schnittstellen

- REST: `PUT /projects/{id}/routes` nimmt `public` mit `publicHostname` und `accessProtected`; `GET /domains`, `PUT /domains/default`, `POST /system/cloudflare-sync`.
- MCP: `create_project` und `set_targets` mit `public` → Bestätigung, dann Schwelle, dann anlegen. `list_domains` liefert Zonen und Standard.
- UI: Erreichbarkeit «Öffentlich» mit Hostname-Feld, Access-Schalter, Rückfrage; Grund bei Ablehnung durch die Schwelle sichtbar. Systemseite: Tunnel-Status (verbunden ja/nein über die API).
- Benachrichtigung `project_public` (M6) bei jedem Wechsel auf öffentlich.

## 7. Konfiguration (neu)

| Variable | Zweck |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Konto für Tunnel und Access |
| `CLOUDFLARE_TUNNEL_ID` | der remote verwaltete Tunnel |
| `TUNNEL_TOKEN` (Datei `secrets/tunnel_token`) | nur für den `cloudflared`-Container |
| `ACCESS_EMAIL` | wer sich bei Access anmelden darf |

Token-Rechte: Zone DNS bearbeiten (Zonen der öffentlichen Domains), Cloudflare Tunnel bearbeiten, optional Access-Apps bearbeiten. Kein globaler API-Key.

## 8. Reihenfolge

1. Cloudflare-Client erweitern (Zonen, DNS, Tunnel-Konfiguration, Access), Attrappe für Tests
2. Hostname-Prüfung und Ingress-Abgleich als reine Funktionen, Tests zuerst
3. Migration 0006 (`domains`), Routen mit `public`
4. Caddy: öffentliche Routen, vertrauenswürdiger Proxy
5. Service `setRoutes` mit Schwelle, Bestätigung über MCP, UI
6. Aufräumen beim Löschen, Abgleich beim Start
7. Review, M1–M6 erneut

## Abnahmekriterien

Stand 7.11.2026. Ohne Domain, Token und Tunnel – wie beauftragt. Geprüft gegen eine **Cloudflare-Attrappe**, mit der der laufende deployer spricht (`pnpm --filter @deployer/api e2e:cf`, `e2e/m5.e2e.ts`); nie gegen die echte API. 11 Tests gegen die Attrappe, 339 Unit-Tests, Gesamtsuite 80 von 80.

- [x] Ohne Cloudflare-Konfiguration laufen alle Tests aus M1–M6 weiter; `public` wird mit klarer Meldung abgelehnt (E2E M3/M4)
- [x] `public` ohne abgeschlossenen Scan wird abgelehnt (409 `not_publishable`), die internen Ziele bleiben; nach Akzeptieren der kritischen Befunde geht es (Attrappe)
- [x] `public` über MCP verlangt eine Bestätigung; ohne Token wird nichts angelegt. Über REST mit einem API-Token: 403 (Attrappe)
- [x] Der Ingress-Abgleich setzt genau die öffentlichen Namen, eigene zuerst, lässt fremde Regeln (auch Wildcards, Pfad-Regeln, eigene Auffangregel) stehen (Unit, Attrappe)
- [x] CNAME proxied auf `<tunnel>.cfargotunnel.com` mit Kommentar; ein fremder Eintrag gleichen Namens wird nicht überschrieben (409) (Attrappe)
- [x] Hostname-Prüfung: keine internen Namen, kein Apex, keine zweite Ebene, nur Zonen des Kontos, reservierte Labels (Unit, Attrappe)
- [x] Umbenennen: alter CNAME weg, neuer da, Ingress nachgezogen; Access an/aus; ein erneuter Aufruf ohne Angaben lässt Name und Access, wie sie sind (Attrappe)
- [x] Entfernen und Löschen räumen CNAME, Ingress-Regel und Access-App ab (Attrappe)
- [x] Caddy: öffentliche Routen nur von der Adresse von cloudflared, `CF-Connecting-IP` nur von dort (Unit; `caddy validate` nimmt die Konfiguration an); der öffentliche Name wird von Caddy ausgeliefert (Attrappe, lokal ohne IP-Filter)
- [x] Benachrichtigung `project_public` beim ersten Öffentlich-Schalten – *im Code, nicht eigens getestet*
- [x] `compose.public.yaml`: cloudflared mit `--token-file`, nur im edge-Netz (`docker compose config`)
- [ ] (ungetestet) gegen die echte Cloudflare-API, echter Tunnel, echte Domain, Access-Login

## Review

`/code-review high` über alle M5-Änderungen: zehn Befunde, alle behoben.

| # | Befund | Behebung | Test |
| --- | --- | --- | --- |
| 1 | **Ein erneuter `set_targets`-Aufruf ohne `access` schaltete Cloudflare Access still ab** und verschob einen eigenen öffentlichen Namen auf den Slug | Fehlende Angaben heissen «wie bisher» | E2E (Attrappe) |
| 2 | Zwei gleichzeitige Tunnel-Abgleiche konnten einen eben gesetzten Namen überschreiben | Abgleich nacheinander | – |
| 3 | Scheiterte «public» an Name, Belegung, fremdem Eintrag oder ACCESS_EMAIL, waren die internen Ziele schon umgestellt (gegen die eigene Zusage in OFFENE-FRAGEN) | Plan (alle Prüfungen, ohne Änderung) vor jeder Änderung, Caddy-Abgleich im `finally` | E2E (Attrappe) |
| 4 | Eigene Regeln hinter fremden: eine fremde Wildcard verdeckte sie; Pfad-Regeln und eigene Auffangregel gingen verloren | Eigene Namen zuerst, fremde in alter Reihenfolge, Auffangregel bleibt | Unit |
| 5 | Beim Löschen lief das Cloudflare-Aufräumen nach dem Entfernen des Netzes; der Caddy-Abgleich darin warf, Audit und Meldung fielen weg | Aufräumen zuerst; Fehler im Caddy-Abgleich verhindern Audit und Meldung nicht mehr | – |
| 6 | `trusted_proxies` umfasste das ganze edge-Subnetz samt Docker-Gateway; ein LAN-Client hätte `CF-Connecting-IP` vortäuschen können | Nur die Adresse von cloudflared; Abgleich bei neuer Adresse (alle 30 s geprüft) | Unit |
| 7 | Zonen-Abgleich löschte noch benutzte Zonen; das Aufräumen übersprang dann den CNAME ohne Meldung | Benutzte Zonen bleiben; fehlende Zone wird als Problem gemeldet | – |
| 8 | Scheiterte ein Schritt nach dem Anlegen von CNAME oder Access-App, blieben sie verwaist | Rücknahme dessen, was dieser Aufruf neu angelegt hat; Belegung unter Sperre erneut geprüft | – |
| 9 | `pnpm e2e:cf` meldete Erfolg auch bei Fehlschlägen | Exit-Code der Tests | – |
| 10 | Systemseite wartete auf Cloudflare; Token-Datei bei jedem Aufruf gelesen; Schwelle doppelt geprüft | Tunnel-Status im Hintergrund aufgefrischt, Token 30 s zwischengespeichert, Schwelle einmal | – |
