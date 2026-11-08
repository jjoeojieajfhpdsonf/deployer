# Cloudflare verbinden

Stand: 8. November 2026

Cloudflare wird in der Oberfläche eingerichtet: **System → «Cloudflare verbinden»**. Dafür braucht es weder `.env`-Einträge noch `compose.tls.yaml` oder `compose.public.yaml`. Der Basis-Stack enthält Caddy mit dem DNS-Modul, Port 443 und ein Volume für das Token.

```sh
docker compose up -d --build
```

## Ablauf

| Schritt | Was passiert | Ergebnis |
| --- | --- | --- |
| 1. Token einfügen | Link zur Token-Seite bei Cloudflare, Rechte vorausgefüllt; Liste der nötigen Rechte mit Zweck | Token im Feld |
| 2. Token prüfen | Sofort beim Einfügen: gültig, aktiv, jedes Recht einzeln. Fehlendes wird konkret genannt («Fehlt für: a.ch», «Fehlt im Konto X») | Speichern erst, wenn alle Pflichtrechte da sind |
| 3. Domains wählen | Zonen des Kontos; interne Basisdomain = Präfix + Zone, Standard-Domain für öffentliche Projekte; optional Tailscale-IP, E-Mail für Access und Let's Encrypt | Projekte ziehen auf die neue Basisdomain um |
| 4. Tunnel anlegen | Tunnel `deployer-<servername>` per API (remote verwaltet), Token holen, `cloudflared` als eigenen Container starten | Tunnel verbunden, noch nichts öffentlich |
| 5. Zertifikat | Caddy holt `*.<basis>` erst bei der Staging-CA, dann bei der echten; Fortschritt und Meldungen von Caddy live | `https://` für interne Adressen |

Danach unter «Verbindung»: **Token ersetzen** (gleiches Konto; Tunnel und Zertifikat bleiben) und **Verbindung trennen** (erst, wenn kein Projekt mehr öffentlich ist: cloudflared weg, Tunnel bei Cloudflare gelöscht, Token und Zertifikat vergessen; die Basisdomain bleibt, Adressen laufen über http).

## Rechte des Tokens

| Recht | Pflicht | Wofür |
| --- | --- | --- |
| Zone → Zone → Lesen | ja | Zonen auflisten |
| Zone → DNS → Bearbeiten | ja | DNS-Challenge, Tailnet-Eintrag, öffentliche Namen |
| Konto → Cloudflare Tunnel → Bearbeiten | ja | Tunnel anlegen, Regeln setzen |
| Konto → Access: Apps und Richtlinien → Bearbeiten | nein | Projekte hinter Cloudflare Access |

**Geprüft ohne Seiteneffekt.** Lesen über die Listen (`/zones`, `/accounts`). Schreiben mit einer absichtlich ungültigen Anfrage pro Recht (DNS-Eintrag vom Typ `INVALID`, Tunnel ohne Namen, Access-App mit falschem Typ): Mit dem Recht antwortet Cloudflare mit einem Prüffehler (400), ohne das Recht mit «Authentication error» (403). Angelegt wird so nichts. Antwortet Cloudflare anders, steht «nicht sicher prüfbar».

**Vorlagen-Link:** `dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[…]&name=deployer&accountId=*&zoneId=all` mit den Schlüsseln `zone`, `dns`, `argotunnel`, `access`. Kennt Cloudflare einen Schlüssel nicht, bleibt das Recht leer; die Liste daneben nennt es trotzdem.

## Wo das Token liegt

- **Datenbank** (`app_settings`, Schlüssel `cloudflare`), verschlüsselt mit AES-256-GCM und demselben Schlüssel wie die Benachrichtigungs-Zugangsdaten (`/data/keys/secrets.key`). Das Tunnel-Token ebenso.
- **Caddy:** Der deployer schreibt es nach `/run/caddy-secrets/cloudflare_token` (Volume `caddy_secrets`, Rechte 600, in Caddy nur lesend). Die Konfiguration enthält den Platzhalter `{file./run/caddy-secrets/cloudflare_token}`, den Caddy beim Laden auflöst. In `autosave.json` steht nur der Pfad. Nach einem Token-Wechsel lädt der deployer Caddy neu, auch wenn sich die Konfiguration sonst nicht ändert.
- **cloudflared:** Das Tunnel-Token wird vor dem Start als Datei in den Container gelegt (`/etc/cloudflared/token`, Rechte 400) und mit `--token-file` gelesen – nicht in Umgebung oder Argumenten, also nicht in `docker inspect`.
- **Nie** in Logs, Fehlermeldungen, API-Antworten oder dem Audit-Log.

Alle Endpunkte unter `/api/v1/system/cloudflare` verlangen eine Anmeldung; ein API-Token bekommt 403.

## cloudflared

Eigener Container `deployer-cloudflared` mit Label `deployer.system=cloudflared`, nur im Netz `deployer_edge`, `restart: unless-stopped`, ohne Capabilities, 256 MB, 0,5 CPU. Beim Start des deployers wird er wieder hochgefahren, falls er fehlt. Eine Neustart-Schleife (etwa wegen eines ungültigen Tokens) zeigt die Systemseite als «startet ständig neu» mit der letzten Meldung.

Läuft noch ein `cloudflared` aus `compose.public.yaml`, lehnt die Oberfläche den Tunnel ab (gleicher Name). Zuerst den Stack ohne diese Datei starten.

## Zertifikat

- Phase **Staging:** TLS-Server und Wildcard-Policy mit der Staging-CA, aber **ohne** Weiterleitung von http auf https und mit `http://`-Adressen – wer intern unterwegs ist, merkt nichts.
- Phase **Produktion:** gleiche Policy, echte CA.
- **Fertig:** Weiterleitung an, Adressen mit `https://`.
- Pro Phase höchstens sechs Minuten. Der deployer fragt Caddy alle fünf Sekunden per TLS nach dem Zertifikat und zeigt neue ACME-Fehler aus Caddys Log. Scheitert es, bleibt alles auf http; «Nochmals versuchen» beginnt wieder mit Staging.
- Ein Neustart des deployers mitten in der Einrichtung führt sie weiter.
- Ändert sich die Basisdomain, gilt das Zertifikat nicht mehr: Schritt 5 erscheint wieder.

## Alte Einrichtung (.env)

Was in der Oberfläche nicht gesetzt ist, kommt weiter aus `.env`: `INTERNAL_BASE_DOMAIN`, `TLS_MODE`, `ACME_CA`, `ACME_EMAIL`, `TAILSCALE_IP`, `CLOUDFLARE_API_TOKEN_FILE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ID`, `ACCESS_EMAIL`. `compose.tls.yaml` und `compose.public.yaml` funktionieren weiter. Die Systemseite zeigt dann «noch über .env eingerichtet». Wer in der Oberfläche verbindet, übernimmt; die alten Werte bleiben als Rückfall.

## Prüfung

Stand 8.11.2026, ohne echtes Konto: gegen die Cloudflare-Attrappe (`lib/cf-fixture.ts`), mit der der laufende deployer spricht.

- [x] Token-Prüfung: vollständig, fehlendes Tunnel-Recht mit Kontoname, ohne Zonen-Recht, ungültiges Token; nichts angelegt (Unit, Attrappe)
- [x] Token verschlüsselt in der Datenbank (kein Klartext im Wert), Datei für Caddy mit Rechten 600 (Docker lokal)
- [x] `autosave.json` enthält nur `{file./run/caddy-secrets/cloudflare_token}`, das Token kommt darin nicht vor (Docker lokal)
- [x] Caddy 2.10 löst `{file.*}` zur Laufzeit auf (eigener Test mit dem gebauten Image)
- [x] Tunnel per API angelegt, cloudflared gestartet, liest das Token aus der Datei; Token nicht in `docker inspect` (Docker lokal, Attrappe)
- [x] Zertifikats-Ablauf startet mit Staging; ein ACME-Fehler erscheint als Fortschrittsmeldung (lokal; Let's Encrypt lehnt die Testdomain `.invalid` ab)
- [ ] (ungetestet) gegen die echte Cloudflare-API: Prüf-Anfragen (400 statt 403), Vorlagen-Link, Tunnel-Token
- [ ] (ungetestet) echtes Wildcard-Zertifikat Staging → Produktion
