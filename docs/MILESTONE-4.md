# Meilenstein 4 – Tailnet und Zertifikate

Stand: 7. November 2026

> **Neu (8.11.2026):** Eingerichtet wird über die Oberfläche, System → «Cloudflare verbinden» – siehe [CLOUDFLARE.md](CLOUDFLARE.md). `compose.tls.yaml` und die Variablen unten gelten nur noch als Rückfall für bestehende Installationen.

Umfang laut [SPEC.md](SPEC.md): Wildcard-Zertifikat per DNS-Challenge bei Cloudflare, dieselbe interne Adresse `projekt.int.deinedomain.ch` im LAN und im Tailnet, gültiges HTTPS ohne Warnung.

**Ohne echte Domain, ohne Cloudflare-Token, ohne Server gebaut.** Der Auftrag für die Nacht: Code schreiben, mit Unit-Tests absichern, aber nicht gegen Cloudflare oder Let's Encrypt testen. Was davon lokal doch prüfbar ist, steht unter «Abnahme».

## 1. Grundsätze

- **Ohne Konfiguration ändert sich nichts.** `TLS_MODE=off` (Standard) lässt den Stack exakt wie in M1–M6 laufen: nur HTTP auf :80, nip.io als Adresse. Der lokale Docker-Desktop-Betrieb bleibt so testbar.
- **TLS nur über eine Compose-Ergänzung.** `compose.tls.yaml` baut Caddy mit dem Modul `caddy-dns/cloudflare`, öffnet :443 und reicht das Cloudflare-Token als Datei herein. Ohne Token-Datei startet der Basis-Stack trotzdem.
  - Start auf dem Server: `docker compose -f compose.yaml -f compose.tls.yaml up -d`
- **Das Token liegt in einer Datei** (`secrets/cloudflare_token`, Rechte 600, ignoriert von Git), als Compose-Secret eingebunden – nicht in `.env`, nicht in `docker inspect`, nicht in der Caddy-Konfiguration. Caddy liest es über einen Platzhalter `{env.CF_API_TOKEN}`; ein kleines Startskript im Caddy-Image setzt die Variable aus der Datei. In Caddys `autosave.json` (wegen `--resume`) steht damit nur der Platzhalter.
- **Minimale Rechte** (SPEC): Zone → DNS → Bearbeiten, nur für die Zone der internen Basisdomain. M5 braucht zusätzlich Tunnel-Rechte; dasselbe Token darf beides haben.
- **nip.io bleibt** als Rückfall über HTTP. Für nip.io-Namen gibt es kein Zertifikat (kein Zugriff auf deren DNS); sie leiten nicht auf HTTPS um.

## 2. Zertifikat

- Ein Wildcard-Zertifikat für `*.<INTERNAL_BASE_DOMAIN>` über ACME DNS-01 bei Let's Encrypt. Caddy erneuert selbst.
- Eine Wildcard deckt genau eine Ebene. Alle internen Namen sind deshalb einstufig: `<label>.<basis>`. Das ist schon heute so (Slug bzw. Subdomain ohne Punkt, Schema in `@airlock/shared`).
- `ACME_CA=staging` schaltet auf die Staging-CA von Let's Encrypt (für den ersten Versuch auf dem Server, ohne Rate-Limit-Risiko). Standard `production`.
- `ACME_EMAIL` optional für Ablauf-Warnungen von Let's Encrypt.
- DNS-Resolver für die Challenge-Prüfung: `1.1.1.1` – sonst fragt Caddy den lokalen DNS, und ein Split-Horizon-Setup (AdGuard mit `*.int`) beantwortet die `_acme-challenge`-Abfrage falsch.

## 3. Caddy-Konfiguration bei `TLS_MODE=cloudflare`

| Server | Lauscht | Routen |
| --- | --- | --- |
| `srv0` | `:80` | nip.io-Namen wie bisher; für Namen unter der Basisdomain eine Weiterleitung 308 auf `https://` |
| `srv1` | `:443` | alle Namen unter der Basisdomain, mit dem Wildcard-Zertifikat |

- `apps.tls.automation.policies`: ein Eintrag mit `subjects: ["*.<basis>"]`, Aussteller `acme` mit `challenges.dns.provider = { name: "cloudflare", api_token: "{env.CF_API_TOKEN}" }`.
- `automatic_https.disable_redirects: true` und eigene Weiterleitung: Caddys automatische Weiterleitung würde auch nip.io erfassen.
- `tls_connection_policies` mit dem Wildcard-Namen; unbekannte SNI bekommen den Fehler von Caddy, keine fremde Seite.
- Der IP-Filter (`remote_ip`: LAN-Bereich, `100.64.0.0/10`) gilt auf beiden Servern gleich.
- Der Admin-Block bleibt der Unix-Socket (M1).
- `http3` aus: UDP :443 müsste zusätzlich veröffentlicht werden, und der IP-Filter ist für QUIC nicht getestet.
- Der reine Konfigurationsbau bleibt eine Funktion ohne Umgebung (`buildCaddyConfig`), mit Unit-Tests für beide Modi.

## 4. LAN und Tailnet unter derselben Adresse

- **LAN:** Der lokale DNS (Router, AdGuard, Pi-hole) zeigt `*.int.deinedomain.ch` auf `SERVER_LAN_IP`. Das richtet Joël ein; die Systemseite zeigt die Anleitung mit den richtigen Werten.
- **Tailnet:** Airlock legt bei Cloudflare einen DNS-Eintrag `*.int.deinedomain.ch` → `TAILSCALE_IP` an, Typ A, **nicht proxied** (SPEC). Beim Start und über `POST /api/v1/system/tailnet-dns` (nur mit Anmeldung). Bestehender Eintrag mit anderem Ziel wird aktualisiert, ein gleicher bleibt unverändert.
  - Zone: die längste Zone des Kontos, auf die die Basisdomain endet (`int.deinedomain.ch` → Zone `deinedomain.ch`).
  - Kommentar am Eintrag: `managed by airlock` (früher `managed by deployer`), damit er in Cloudflare erkennbar ist.
- **Routen-Modell:** Bisher legte ein zweites Ziel einen Eintrag `tailnet-<host>` an (wegen des Unique-Index auf `hostname`). Neu (Migration 0005): Unique auf `(target, hostname)`; LAN und Tailnet tragen denselben Namen. Caddy bekommt pro Name eine Route, nicht zwei.
- Aus dem Tailnet kommen Anfragen mit Absender `100.x.y.z` am Server an; der IP-Filter erlaubt `100.64.0.0/10` schon seit M1.

## 5. Airlock selbst

- **Sitzungs-Cookie mit `Secure`,** sobald die Anfrage über HTTPS kam (`X-Forwarded-Proto: https`, gesetzt von Caddy). Über nip.io (HTTP) bleibt der Login möglich, aber ohne `Secure` – sonst wäre der Rückfall ausgesperrt.
  - Bewusst nur dieser Header, nicht `trustProxy` für alles: `X-Forwarded-For` bleibt unbeachtet, damit niemand im Projekt-Netz eine Absenderadresse vortäuschen kann.
- **URLs:** `https://` für Namen unter der Basisdomain bei `TLS_MODE=cloudflare`, sonst `http://`. Gilt für UI, REST, MCP und Benachrichtigungen.
- **Zertifikatsstatus** auf der Systemseite: Airlock verbindet sich per TLS mit `caddy:443` (SNI `deployer.<basis>`) und zeigt Aussteller und Ablaufdatum. Ein stündlicher Job meldet `infra_problem` (M6), wenn kein gültiges Zertifikat da ist oder es in weniger als 14 Tagen abläuft – höchstens einmal pro Tag.
- **Scanner:** testssl.sh prüft intern weiterhin nichts. TLS endet bei Caddy, nicht im Projekt-Container; geprüft würde für jedes Projekt dieselbe Caddy-Konfiguration. Stattdessen ein Eintrag «TLS: zentral über Caddy, siehe Systemseite».

## 6. Konfiguration (neu)

| Variable | Standard | Zweck |
| --- | --- | --- |
| `TLS_MODE` | `off` | `off` oder `cloudflare` |
| `ACME_CA` | `production` | `production` oder `staging` |
| `ACME_EMAIL` | leer | Kontakt bei Let's Encrypt |
| `TAILSCALE_IP` | leer | Ziel des Tailnet-Eintrags; leer = kein Eintrag |
| `CLOUDFLARE_API_TOKEN_FILE` | `/run/secrets/cloudflare_token` | Token für Airlock (Tailnet-DNS, ab M5 Tunnel) |
| `CLOUDFLARE_API_BASE` | `https://api.cloudflare.com/client/v4` | austauschbar für Tests |

Prüfung beim Start: `TLS_MODE=cloudflare` verlangt `INTERNAL_BASE_DOMAIN` und eine lesbare Token-Datei, sonst Abbruch mit klarer Meldung (lieber nicht starten als halb konfiguriert, wie in M1).

## 7. Cloudflare-Anbindung

Eigener schlanker Client `drivers/cloudflare.ts` über `fetch` statt des SDK `cloudflare`: wenige Endpunkte (Zonen, DNS-Einträge, ab M5 Tunnel und Access), keine zusätzliche Abhängigkeit, und in Tests per Attrappen-Server ersetzbar. Fehler von Cloudflare werden mit Code und Meldung weitergereicht, das Token erscheint nie in Logs oder Fehlermeldungen.

## 8. Reihenfolge

1. Konfigurationsbau mit TLS (reine Funktion), Tests zuerst
2. `cloudflare.ts` mit Attrappen-Server in Tests; Zone finden, Eintrag anlegen/aktualisieren
3. Migration 0005 (Routen), URLs mit Schema, Cookie
4. Zertifikatsstatus, Job, Systemseite
5. `compose.tls.yaml`, Caddy-Image mit Modul
6. Review, M1–M6 erneut

## Abnahmekriterien

Stand 7.11.2026. Ungetestet heisst: Code und Unit-Tests vorhanden, aber nicht gegen echte Dienste geprüft – keine Domain, kein Token, kein Server. Neu: `e2e/m4.e2e.ts` (7 Tests, grün) gegen den lokalen Stack mit `TLS_MODE=off`; 325 Unit-Tests.

- [x] Mit `TLS_MODE=off` laufen die Tests aus M1–M6 weiter – *Gesamtsuite 80 von 80 grün*
- [x] Der Konfigurationsbau erzeugt für `TLS_MODE=cloudflare` :80 mit Weiterleitung, :443 mit Wildcard-Policy und DNS-Challenge, nip.io weiter über HTTP; das Token steht nur als Platzhalter in der Konfiguration (Unit)
- [x] Das Caddy-Image mit `caddy-dns/cloudflare` baut (Caddy 2.10.0, Modul v0.2.1), und `caddy validate` nimmt die erzeugte TLS-Konfiguration an; das Startskript liest das Token aus dem Secret (lokal mit Docker)
- [x] `docker compose -f compose.yaml -f compose.tls.yaml config` ergibt :80 und :443, das Secret und `TLS_MODE=cloudflare` (lokal, mit Platzhalter-Datei)
- [ ] (ungetestet) Caddy holt ein Wildcard-Zertifikat von Let's Encrypt
- [x] Der Tailnet-Eintrag wird angelegt, ist nicht proxied, wird bei gleichem Ziel nicht doppelt angelegt, ein fremder Eintrag nicht überschrieben (Attrappe)
- [ ] (ungetestet) gegen die echte Cloudflare-API
- [x] LAN und Tailnet teilen sich einen Namen (zwei Zeilen, eine Adresse, eine Caddy-Route); die Quell-Bereiche folgen den Zielen (E2E, Unit)
- [x] Sitzungs-Cookie mit `Secure` über HTTPS (Unit); über HTTP ohne, auch mit vorgetäuschtem `X-Forwarded-Proto` (E2E: Caddy überschreibt den Header)
- [x] URLs mit `https://` bei TLS unter der Basisdomain, nip.io mit `http://` (Unit)
- [x] Zertifikatsstatus auf der Systemseite; Warnung bei weniger als 14 Tagen; Staging-CA gilt nicht als Fehler (Unit; Abruf gegen einen lokalen TLS-Server)
- [x] Start bricht mit klarer Meldung ab, wenn `TLS_MODE=cloudflare` ohne Basisdomain oder Token-Datei gesetzt ist (Unit)
- [ ] (ungetestet) IP-Filter auf dem Linux-Server: LAN-Projekt aus dem Tailnet nicht erreichbar und umgekehrt

## Review

`/code-review high` über alle M4-Änderungen: zehn Befunde, alle behoben.

| # | Befund | Behebung | Test |
| --- | --- | --- | --- |
| 1 | Mit der Staging-CA (empfohlen für den ersten Versuch) galt das Zertifikat immer als kaputt, mit täglicher Warnung | Bei `ACME_CA=staging` zählt eine nicht vertrauenswürdige Kette der Staging-CA nicht; Ablauf schon | Unit |
| 2 | **Die Wahl «LAN» oder «Tailnet» änderte nichts:** Caddy liess für jede Route LAN und Tailnet zu | Quell-Bereiche pro Route nach ihren Zielen | Unit |
| 3 | LAN + Tailnet ergab jede Adresse doppelt (UI, MCP) | Routen pro Name zusammengefasst, `targets` im DTO | E2E |
| 4 | Ohne globalen Unique-Index konnten zwei Projekte gleichzeitig denselben Namen bekommen | Prüfung und Einfügen unter Sperre in einer Transaktion | E2E (Ablehnung) |
| 5 | Jeder Status-Abruf (alle 15 s) machte einen TLS-Handshake zu Caddy | Ergebnis fünf Minuten zwischengespeichert | – |
| 6 | Ein langsames Cloudflare verzögerte den Start | Tailnet-DNS im Hintergrund | – |
| 7 | Fundstellen in Scans weiter mit `http://` | `urlForHost` | – |
| 8 | Zwei Wildcard-Regeln, eine davon ohne Kleinschreibung | Eine Regel in `lib/hostnames.ts` | Unit |
| 9 | `certProblem` veränderte sein Argument | Rein, `daysLeftOf` | Unit |
| 10 | `TAILSCALE_IP=100.64.999.1` ging durch | `isIPv4` und Bereich | Unit |
