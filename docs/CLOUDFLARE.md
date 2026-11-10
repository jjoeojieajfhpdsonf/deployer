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
| 4. Tunnel anlegen | Tunnel `airlock-<servername>` per API (remote verwaltet), Token holen, `cloudflared` als eigenen Container starten | Tunnel verbunden, noch nichts öffentlich |
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

**Vorlagen-Link:** `dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[…]&name=airlock&accountId=*&zoneId=all` mit den Schlüsseln `zone`, `dns`, `argotunnel`, `access`. Kennt Cloudflare einen Schlüssel nicht, bleibt das Recht leer; die Liste daneben nennt es trotzdem.

## Wo das Token liegt

- **Datenbank** (`app_settings`, Schlüssel `cloudflare`), verschlüsselt mit AES-256-GCM und demselben Schlüssel wie die Benachrichtigungs-Zugangsdaten (`/data/keys/secrets.key`). Das Tunnel-Token ebenso.
- **Caddy:** Airlock schreibt es nach `/run/caddy-secrets/cloudflare_token` (Volume `caddy_secrets`, Rechte 600, in Caddy nur lesend). Die Konfiguration enthält den Platzhalter `{file./run/caddy-secrets/cloudflare_token}`, den Caddy beim Laden auflöst. In `autosave.json` steht nur der Pfad. Nach einem Token-Wechsel lädt Airlock Caddy neu, auch wenn sich die Konfiguration sonst nicht ändert.
- **cloudflared:** Das Tunnel-Token wird vor dem Start als Datei in den Container gelegt (`/etc/cloudflared/token`, Rechte 400) und mit `--token-file` gelesen – nicht in Umgebung oder Argumenten, also nicht in `docker inspect`.
- **Nie** in Logs, Fehlermeldungen, API-Antworten oder dem Audit-Log.

Alle Endpunkte unter `/api/v1/system/cloudflare` verlangen eine Anmeldung; ein API-Token bekommt 403.

## cloudflared

Eigener Container `airlock-cloudflared` mit Label `airlock.system=cloudflared`, `restart: unless-stopped`, ohne Capabilities, 256 MB, 0,5 CPU. Beim Start von Airlock wird er wieder hochgefahren, falls er fehlt (oder neu angelegt, falls er noch im alten edge-Netz hängt). Eine Neustart-Schleife (etwa wegen eines ungültigen Tokens) zeigt die Systemseite als «startet ständig neu» mit der letzten Meldung.

### Netz «tunnel»

`airlock_tunnel` gehört nur cloudflared und Caddy. cloudflared hängt **nur** dort, nicht im edge-Netz: Was durch den Tunnel kommt, erreicht ausschliesslich Caddy (`http://caddy:80`) – nie Airlock, nie ein Projekt-Netz. Das Netz ist nicht `internal`, weil cloudflared die ausgehende Verbindung zu Cloudflare braucht. Caddy behält sein Gateway im edge-Netz (`gw_priority`). `trusted_proxies` und der Absender-Filter öffentlicher Routen nehmen die Adresse von cloudflared in diesem Netz.

**Warnung bei fremden Regeln:** Die Systemseite liest die Ingress-Regeln des Tunnels bei Cloudflare (höchstens einmal pro Minute) und warnt, wenn eine auf etwas anderes als `http://caddy:80` zeigt – etwa eine von Hand im Dashboard ergänzte Regel auf einen anderen Dienst. Die Auffangregel `http_status:404` ist erlaubt.

### Version und Update

Die Systemseite zeigt die cloudflared-Version (aus dem festen Image-Tag) und fragt Docker Hub nach der neuesten Release-Version (Tags `JJJJ.M.P`, ohne `latest` und Architektur-Varianten; sechs Stunden zwischengespeichert). Ist eine neuere da: Knopf «Auf … aktualisieren» mit Rückfrage. Das Update holt ein frisches Tunnel-Token, legt den Container mit dem neuen Image neu an und legt das Image erst danach fest – scheitert das Holen, bleibt die alte Version. Läuft cloudflared noch aus `compose.public.yaml`, gibt es nur den Hinweis.

Läuft noch ein `cloudflared` aus `compose.public.yaml`, lehnt die Oberfläche den Tunnel ab (gleicher Name). Zuerst den Stack ohne diese Datei starten.

## Zertifikat

- Phase **Staging:** TLS-Server und Wildcard-Policy mit der Staging-CA, aber **ohne** Weiterleitung von http auf https und mit `http://`-Adressen – wer intern unterwegs ist, merkt nichts.
- Phase **Produktion:** gleiche Policy, echte CA.
- **Fertig:** Weiterleitung an, Adressen mit `https://`.
- Pro Phase höchstens sechs Minuten. Airlock fragt Caddy alle fünf Sekunden per TLS nach dem Zertifikat und zeigt neue ACME-Fehler aus Caddys Log. Scheitert es, bleibt alles auf http; «Nochmals versuchen» beginnt wieder mit Staging.
- Ein Neustart von Airlock mitten in der Einrichtung führt sie weiter.
- Ändert sich die Basisdomain, gilt das Zertifikat nicht mehr: Schritt 5 erscheint wieder.

## Alte Einrichtung (.env)

Was in der Oberfläche nicht gesetzt ist, kommt weiter aus `.env`: `INTERNAL_BASE_DOMAIN`, `TLS_MODE`, `ACME_CA`, `ACME_EMAIL`, `TAILSCALE_IP`, `CLOUDFLARE_API_TOKEN_FILE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ID`, `ACCESS_EMAIL`. `compose.tls.yaml` und `compose.public.yaml` funktionieren weiter. Die Systemseite zeigt dann «noch über .env eingerichtet». Wer in der Oberfläche verbindet, übernimmt; die alten Werte bleiben als Rückfall.

## Prüfung

Stand 8.11.2026, ohne echtes Konto: gegen die Cloudflare-Attrappe (`lib/cf-fixture.ts`), mit der das laufende Airlock spricht.

- [x] Token-Prüfung: vollständig, fehlendes Tunnel-Recht mit Kontoname, ohne Zonen-Recht, ungültiges Token; nichts angelegt (Unit, Attrappe)
- [x] Token verschlüsselt in der Datenbank (kein Klartext im Wert), Datei für Caddy mit Rechten 600 (Docker lokal)
- [x] `autosave.json` enthält nur `{file./run/caddy-secrets/cloudflare_token}`, das Token kommt darin nicht vor (Docker lokal)
- [x] Caddy 2.10 löst `{file.*}` zur Laufzeit auf (eigener Test mit dem gebauten Image)
- [x] Tunnel per API angelegt, cloudflared gestartet, liest das Token aus der Datei; Token nicht in `docker inspect` (Docker lokal, Attrappe)
- [x] Zertifikats-Ablauf startet mit Staging; ein ACME-Fehler erscheint als Fortschrittsmeldung (lokal; Let's Encrypt lehnt die Testdomain `.invalid` ab)
- [x] Netz «tunnel»: aus dem Netz-Namensraum von cloudflared (`--network container:`) antwortet Caddy, der Airlock-Port ist weder über den Namen noch über seine Adressen erreichbar (`e2e/tunnel-net.e2e.ts`, lokal mit der Attrappe)
- [x] Warnung, wenn eine Ingress-Regel nicht auf Caddy zeigt (Attrappe mit einer Regel auf `http://airlock-app:3000`)
- [x] cloudflared-Version aus dem Tag, neueste Version von Docker Hub (Unit; Docker Hub echt abgefragt)
- [ ] (ungetestet) **Rechte-Prüfung beim ersten echten Einrichten gegenprüfen:** mit einem Token **ohne** das Recht «Cloudflare Tunnel → Bearbeiten» muss Schritt 2 genau dieses Recht als fehlend melden. Erst damit ist bestätigt, dass Cloudflare auf die absichtlich ungültige Anfrage mit 403 (ohne Recht) und 400 (mit Recht) antwortet; danach das Recht ergänzen und erneut prüfen.
- [ ] (ungetestet) gegen die echte Cloudflare-API: Vorlagen-Link, Tunnel-Token
- [ ] (ungetestet) Update auf eine neue cloudflared-Version mit echtem Tunnel
- [ ] (ungetestet) echtes Wildcard-Zertifikat Staging → Produktion
