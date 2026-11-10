# Installation auf dem Server

Stand: 10. November 2026

**Tailscale ist die Hauptadresse des Servers.** Eine feste LAN-IP braucht es nicht: deployer liest LAN-IP, LAN-Netz und Tailscale-IP beim Start und stündlich selbst vom Host und zieht Adressen und den IP-Filter von Caddy nach, wenn sich etwas ändert.

## 1. Tailscale auf dem Server

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4        # z.B. 100.101.102.103 – die Hauptadresse des Servers
```

Dann in der Tailscale-Verwaltung (login.tailscale.com → Machines) beim Server:

- **«Disable key expiry»** (Menü ⋯ am Server). Sonst läuft der Schlüssel nach 180 Tagen ab, der Server fällt aus dem Tailnet, und alle Projekte im Tailnet sind unerreichbar, bis jemand am Server neu anmeldet.
- Optional einen sprechenden Namen vergeben (z.B. `thinkpad`).

Die Tailscale-IP bleibt fest, solange der Server im Tailnet bleibt.

### Tailscale als Subnet-Router

Bietet der Server zusätzlich Routen ins Heimnetz an (`tailscale up --advertise-routes=…`), maskiert Tailscale Verkehr aus dem Tailnet, der in ein Docker-Netz geht: Die Kette `ts-postrouting` (Tabelle `nat`) setzt `MASQUERADE` für alle Pakete mit der Markierung `0x40000`. Caddy sieht dann statt der Tailnet-Adresse (`100.x`) die Gateway-Adresse des Docker-Netzes (`172.x.0.1`), und der IP-Filter sperrt den Zugriff aus dem Tailnet.

Erkennbar daran:

- Die Sperrseite meldet «Kein Zugriff von 172.x.0.1 auf …» statt der Tailnet-Adresse des Geräts.
- Die Systemseite warnt «Caddy sieht … Docker-Gateway-Adressen statt der Geräte» (aus Caddys Zugriffs-Log für deployer).

**Abhilfe:** Die Markierung für Verkehr aus dem Tailnet in Docker-Netze löschen, bevor `ts-postrouting` greift. Die Tabelle `mangle` läuft in `POSTROUTING` vor `nat`; ohne Markierung maskiert Tailscale diese Pakete nicht.

`/usr/local/sbin/ts-docker-nosnat.sh`:

```sh
#!/bin/sh
# Tailnet-Verkehr in Docker-Netze nicht maskieren: Tailscales Markierung
# (0x40000 in der Maske 0xff0000) vor ts-postrouting entfernen.
set -eu
RULE="-s 100.64.0.0/10 -o br-+ -j MARK --set-xmark 0x0/0xff0000"
# Nur einmal eintragen (Skript läuft bei jedem Start von tailscaled)
iptables -t mangle -C POSTROUTING $RULE 2>/dev/null || iptables -t mangle -A POSTROUTING $RULE
```

```sh
sudo install -m 0755 ts-docker-nosnat.sh /usr/local/sbin/ts-docker-nosnat.sh
```

Systemd-Drop-in, damit die Regel nach jedem Start von `tailscaled` gesetzt ist – `/etc/systemd/system/tailscaled.service.d/docker-nosnat.conf`:

```ini
[Service]
ExecStartPost=/usr/local/sbin/ts-docker-nosnat.sh
```

```sh
sudo systemctl daemon-reload
sudo systemctl restart tailscaled
sudo iptables -t mangle -S POSTROUTING | grep 100.64.0.0/10   # Regel ist da
```

Hinweise:

- `br-+` trifft alle Bridges, die Docker Compose anlegt (deployer und Projekte). Laufen Container im Standard-Netz `docker0`, eine zweite Regel mit `-o docker0` ergänzen.
- **Eine NAT-Regel an Position 1 reicht nicht:** Tailscale setzt seine Regeln verzögert neu und schiebt `ts-postrouting` wieder nach oben. Die Markierung in `mangle` greift unabhängig von der Reihenfolge in `nat`.
- **Alternative** `tailscale up --snat-subnet-routes=false`: nur, wenn der Server nicht als Subnet-Router arbeitet. Mit Subnet-Routing das Skript oben verwenden.
- Anfragen vom Server selbst auf `localhost` laufen über `docker-proxy` und erscheinen in Caddy ebenfalls mit der Gateway-Adresse; das ist normal und kein Hinweis auf dieses Problem.

## 2. deployer starten

```sh
git clone <repo> deployer && cd deployer
cp .env.example .env    # POSTGRES_PASSWORD und ADMIN_PASSWORD setzen
docker compose up -d --build
```

In `.env` steht nur, was zum Starten nötig ist. `SERVER_LAN_IP` und `LAN_CIDR` bleiben leer bzw. beim Standard: auf Linux erkennt deployer beide selbst (nur Docker Desktop auf dem Mac braucht sie).

Danach von einem Gerät mit Tailscale öffnen:

```
http://deployer.100-101-102-103.nip.io       (mit der eigenen Tailscale-IP)
```

Die Systemseite zeigt unter «Netz des Servers» die erkannte Tailscale-IP, LAN-IP und das LAN-Netz.

## 3. Cloudflare verbinden (optional, für eigene Namen und HTTPS)

System → «Cloudflare verbinden», siehe [CLOUDFLARE.md](CLOUDFLARE.md). In **Schritt 3** die **Tailscale-IP des Servers** eintragen; sie ist mit der erkannten vorausgefüllt. deployer legt dann `*.<basisdomain>` → Tailscale-IP bei Cloudflare an (nicht proxied): Die internen Namen lösen überall auf, erreichbar sind sie aber nur mit Tailscale.

## 4. GitHub verbinden (optional, für Fixes als Pull Request)

Damit deployer Fixes zu Security-Befunden als Pull Request anlegen und nach dem Merge selbst deployen kann (Meilenstein 8). deployer bleibt dabei intern: Die Rückleitungen von GitHub laufen über deinen Browser, ein Webhook gibt es nicht.

1. Im Browser bei GitHub angemeldet sein, mit dem Konto (oder der Organisation), dem die Repos gehören.
2. deployer über seinen **Hauptnamen** öffnen (`https://deployer.<basisdomain>`, sonst die nip.io-Adresse, die die Systemseite als erste nennt). GitHub leitet genau dorthin zurück – die Adresse steht auf der Seite unter «GitHub schickt dich danach hierher zurück».
3. System → **GitHub** → Name der App prüfen (muss bei GitHub einmalig sein), bei Bedarf eine Organisation eintragen → **Weiter zu GitHub …**.
4. Bei GitHub die Angaben ansehen (Rechte: Contents und Pull requests jeweils «Read and write», Metadata «Read-only»; kein Webhook) und **Create GitHub App** klicken. GitHub leitet zurück, deployer meldet «App angelegt» und speichert den Schlüssel verschlüsselt.
5. **App installieren** → bei GitHub «Only select repositories» wählen und die Repos der Projekte anhaken → **Install**. Zurück in deployer stehen die Repos unter Schritt 3.
6. Am Projekt (Reiter Einstellungen) **Nach einem Merge neu deployen** einschalten, wo gewünscht.

Danach legt Claude über MCP (`propose_fix`) für Projekte aus diesen Repos einen Branch `deployer/fix-…` mit Pull Request an. Nach dem Merge deployt deployer innerhalb von 5 Minuten, scannt nach und kommentiert das Ergebnis am Pull Request.

Wenn etwas schiefgeht: Die Rückleitung ist eine Stunde gültig; danach auf der Seite neu starten. Eine schon angelegte, aber nicht verbundene App bei GitHub unter Settings → Developer settings → GitHub Apps löschen. «Verbindung trennen» in deployer löscht Schlüssel und Secrets, nicht die App bei GitHub.

## Adressen und Wege

| Weg | Adresse | Erreichbar |
| --- | --- | --- |
| Tailnet (Standard für neue Projekte) | `app.<basisdomain>` oder `app.100-101-102-103.nip.io` | jedes Gerät mit Tailscale, zu Hause und unterwegs |
| LAN (auf Wunsch) | eigener Name nur mit lokalem DNS (Router, AdGuard, Pi-hole: `*.<basisdomain>` → LAN-IP); sonst `app.192-168-1-23.nip.io` | Geräte im Heimnetz ohne Tailscale |
| Öffentlich | über Cloudflare Tunnel | alle |

- Ohne Basisdomain bilden die nip.io-Namen sich aus der Tailscale-IP; der Name mit der LAN-IP bleibt als zweiter Name, damit «LAN» auch ohne lokalen DNS geht. Er ändert sich mit der LAN-IP – deployer zieht ihn nach.
- Caddy lässt einen Namen nur aus den gewählten Wegen zu: Tailnet = `100.64.0.0/10`, LAN = das erkannte LAN-Netz.

## Wenn sich die LAN-IP ändert

Nichts tun. deployer prüft beim Start und stündlich (oder per «Jetzt prüfen» auf der Systemseite), setzt den IP-Filter für «LAN» auf das neue Netz, benennt nip.io-Namen mit der LAN-IP um und vermerkt die Änderung im Audit-Log (`network.change`). Projekte im Tailnet betrifft das nicht.

## Abnahme auf dem Server

Noch offen (braucht den Server und ein Handy):

- [ ] Gerät mit Tailscale (Laptop im Heimnetz): `http://deployer.<tailscale-ip>.nip.io` und ein Projekt im Tailnet öffnen → geht
- [ ] Handy im Mobilnetz **mit** Tailscale: dasselbe Projekt → geht
- [ ] Handy im Mobilnetz **ohne** Tailscale (App getrennt): dasselbe Projekt → geht nicht (der Name zeigt auf eine 100.x-Adresse, die ohne Tailscale nicht erreichbar ist)
- [ ] Laptop im Heimnetz **ohne** Tailscale, Projekt nur «Tailnet», über den LAN-nip.io-Namen → Caddy antwortet mit 403 «Kein Zugriff von <adresse> auf <name> …» (IP-Filter); ein unbekannter Name gibt dagegen 404 «Kein Projekt unter diesem Namen.»
- [ ] Systemseite: Tailscale-IP und LAN-IP erkannt; nach einem Wechsel des LAN (z.B. anderer Router oder DHCP-Lease) zieht «Jetzt prüfen» den Filter nach
