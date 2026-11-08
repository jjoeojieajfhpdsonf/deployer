# Installation auf dem Server

Stand: 8. November 2026

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
- [ ] Laptop im Heimnetz **ohne** Tailscale, Projekt nur «Tailnet», über den LAN-nip.io-Namen → Caddy antwortet mit 404 «Zugriff nicht aus LAN/Tailnet» (IP-Filter)
- [ ] Systemseite: Tailscale-IP und LAN-IP erkannt; nach einem Wechsel des LAN (z.B. anderer Router oder DHCP-Lease) zieht «Jetzt prüfen» den Filter nach
