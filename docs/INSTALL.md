# Installation auf dem Server

Stand: 10. November 2026

**Tailscale ist die Hauptadresse des Servers.** Eine feste LAN-IP braucht es nicht: Airlock liest LAN-IP, LAN-Netz und Tailscale-IP beim Start und stündlich selbst vom Host und zieht Adressen und den IP-Filter von Caddy nach, wenn sich etwas ändert.

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
- Die Systemseite warnt «Caddy sieht … Docker-Gateway-Adressen statt der Geräte» (aus Caddys Zugriffs-Log für Airlock).

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

- `br-+` trifft alle Bridges, die Docker Compose anlegt (Airlock und Projekte). Laufen Container im Standard-Netz `docker0`, eine zweite Regel mit `-o docker0` ergänzen.
- **Eine NAT-Regel an Position 1 reicht nicht:** Tailscale setzt seine Regeln verzögert neu und schiebt `ts-postrouting` wieder nach oben. Die Markierung in `mangle` greift unabhängig von der Reihenfolge in `nat`.
- **Alternative** `tailscale up --snat-subnet-routes=false`: nur, wenn der Server nicht als Subnet-Router arbeitet. Mit Subnet-Routing das Skript oben verwenden.
- Anfragen vom Server selbst auf `localhost` laufen über `docker-proxy` und erscheinen in Caddy ebenfalls mit der Gateway-Adresse; das ist normal und kein Hinweis auf dieses Problem.

## 2. Airlock starten

```sh
git clone <repo> airlock && cd airlock
cp .env.example .env    # POSTGRES_PASSWORD und ADMIN_PASSWORD setzen
docker compose up -d --build
```

Bestehende Installation mit altem Namen deployer: Umzug siehe [RENAME.md](RENAME.md) (docs/RENAME.md). Neuer Server aus einem Backup: [RESTORE.md](RESTORE.md) – dort vor dem ersten `docker compose up` weiterlesen.

In `.env` steht nur, was zum Starten nötig ist. `SERVER_LAN_IP` und `LAN_CIDR` bleiben leer bzw. beim Standard: auf Linux erkennt Airlock beide selbst (nur Docker Desktop auf dem Mac braucht sie).

Danach von einem Gerät mit Tailscale öffnen:

```
http://deployer.100-101-102-103.nip.io       (mit der eigenen Tailscale-IP)
```

Die Systemseite zeigt unter «Netz des Servers» die erkannte Tailscale-IP, LAN-IP und das LAN-Netz.

## 3. Cloudflare verbinden (optional, für eigene Namen und HTTPS)

System → «Cloudflare verbinden», siehe [CLOUDFLARE.md](CLOUDFLARE.md). In **Schritt 3** die **Tailscale-IP des Servers** eintragen; sie ist mit der erkannten vorausgefüllt. Airlock legt dann `*.<basisdomain>` → Tailscale-IP bei Cloudflare an (nicht proxied): Die internen Namen lösen überall auf, erreichbar sind sie aber nur mit Tailscale.

## 4. GitHub verbinden (optional, für Fixes als Pull Request)

Damit Airlock Fixes zu Security-Befunden als Pull Request anlegen und nach dem Merge selbst deployen kann (Meilenstein 8). Airlock bleibt dabei intern: Die Rückleitungen von GitHub laufen über deinen Browser, ein Webhook gibt es nicht.

1. Im Browser bei GitHub angemeldet sein, mit dem Konto (oder der Organisation), dem die Repos gehören.
2. Airlock über seinen **Hauptnamen** öffnen (`https://deployer.<basisdomain>`, sonst die nip.io-Adresse, die die Systemseite als erste nennt). GitHub leitet genau dorthin zurück – die Adresse steht auf der Seite unter «GitHub schickt dich danach hierher zurück».
3. System → **GitHub** → Name der App prüfen (muss bei GitHub einmalig sein), bei Bedarf eine Organisation eintragen → **Weiter zu GitHub …**.
4. Bei GitHub die Angaben ansehen (Rechte: Contents und Pull requests jeweils «Read and write», Metadata «Read-only»; kein Webhook) und **Create GitHub App** klicken. GitHub leitet zurück, Airlock meldet «App angelegt» und speichert den Schlüssel verschlüsselt.
5. **App installieren** → bei GitHub «Only select repositories» wählen und die Repos der Projekte anhaken → **Install**. Zurück in Airlock stehen die Repos unter Schritt 3.
6. Am Projekt (Reiter Einstellungen) **Nach einem Merge neu deployen** einschalten, wo gewünscht.

Danach legt Claude über MCP (`propose_fix`) für Projekte aus diesen Repos einen Branch `airlock/fix-…` mit Pull Request an. Nach dem Merge deployt Airlock innerhalb von 5 Minuten, scannt nach und kommentiert das Ergebnis am Pull Request.

Wenn etwas schiefgeht: Die Rückleitung ist eine Stunde gültig; danach auf der Seite neu starten. Eine schon angelegte, aber nicht verbundene App bei GitHub unter Settings → Developer settings → GitHub Apps löschen. «Verbindung trennen» in Airlock löscht Schlüssel und Secrets, nicht die App bei GitHub.

### Private Repos

- **GitHub:** Ein privates Repo deployt Airlock über die App, sobald es in der Installation freigegeben ist (GitHub → Settings → Applications → die App → Configure → Repository access). An den Rechten der App ändert sich nichts: zum Klonen holt Airlock ein eigenes Token mit nur «Contents: read» für dieses eine Repo.
- **GitLab, Gitea, eigener Server:** Neues Projekt → Repo-Adresse als SSH (`git@gitlab.com:user/app.git`) → Zugang «Deploy-Key» → **Deploy-Key erzeugen** → den öffentlichen Schlüssel beim Repo eintragen (GitLab: Settings → Repository → Deploy keys, «Grant write permissions» aus) → **Repo prüfen** → Fingerabdruck des Servers mit dem veröffentlichten vergleichen (GitLab.com: docs.gitlab.com, «SSH host keys fingerprints») und bestätigen. Alternativ «Zugangstoken (HTTPS)» mit einem Token, das nur lesen darf (GitLab: `read_repository`).
- Prüfen, dass das Image ssh mitbringt und ein Clone per Deploy-Key klappt (baut das Image, startet einen Wegwerf-Git-Server, braucht nur `docker`): `scripts/smoke-git-privat.sh` – endet mit «OK: privates Repo per Deploy-Key geklont».

## 5. Passkey und zweiter Faktor (empfohlen)

Konto (Profil-Menü) → **Sicherheit**. Jede Änderung dort fragt einmal nach dem Passwort (erneute Bestätigung, gilt 10 Minuten).

1. **Passkey hinzufügen** – geht nur unter der Hauptadresse `https://deployer.<basisdomain>` (mit Zertifikat aus Schritt 3); auf nip.io-Adressen bietet der Browser keine Passkeys an. Mehrere Passkeys mit Namen («MacBook», «iPhone») sind möglich.
2. **Authenticator-App einrichten** – QR-Code scannen, den angezeigten Code eingeben. Geht auf jeder Adresse und ist der Weg über nip.io.
3. Beim ersten Faktor zeigt Airlock **10 Wiederherstellungscodes** genau einmal: herunterladen (.txt) oder in den Passwort-Manager kopieren.
4. «**Zweiter Faktor erforderlich**» ist danach von selbst an: Anmelden geht dann nur mit Passkey oder mit Passwort plus Code (bzw. Wiederherstellungscode). Nach jeder Änderung am zweiten Faktor werden alle anderen Geräte abgemeldet.

API-Tokens und MCP sind davon nicht betroffen; neue Tokens verlangen aber die erneute Bestätigung.

Nach 5 Fehlversuchen (Passwort oder Code) sperrt Airlock die Anmeldung mit Passwort 15 Minuten lang, bei Wiederholung jeweils doppelt so lang (höchstens 24 Stunden) – je Absender-Adresse und für das Konto. Mit einem Passkey geht die Anmeldung trotzdem. Fehlversuche und Sperren stehen im Audit-Log.

### Notausgang: zweiter Faktor verloren

Telefon und Passkeys weg, keine Wiederherstellungscodes mehr – auf dem Server im Ordner des Repos:

```sh
docker compose exec airlock node dist/cli.js reset-2fa admin
# gleichwertig, ohne Compose:
docker exec airlock-app node dist/cli.js reset-2fa admin
```

Das entfernt alle Passkeys, die Authenticator-App und die Wiederherstellungscodes, setzt «Zweiter Faktor erforderlich» zurück, meldet alle Sitzungen ab und schreibt `auth.2fa.reset` ins Audit-Log. Danach geht die Anmeldung wieder mit dem Passwort allein; den zweiten Faktor neu einrichten. Statt `admin` geht auch der Anzeigename aus `ADMIN_NAME` (ohne Akzente, z. B. `joel`). Läuft eine Sperre nach Fehlversuchen, hebt `docker restart airlock-app` sie sofort auf (Sperren liegen nur im Arbeitsspeicher).

**Passwort vergessen:** `ADMIN_PASSWORD` in `.env` ändern und `docker compose up -d` (Airlock übernimmt ein geändertes Passwort aus `.env` beim Start). Ist zusätzlich ein zweiter Faktor verloren: danach der Befehl oben.

Prüfen, dass der Notausgang im Image steckt (baut das Image, nimmt eine Wegwerf-Datenbank, braucht nur `docker`): `scripts/smoke-notausgang.sh`.

## 6. Speicher und Aufräumen

Server › Speicher zeigt die Belegung und räumt wöchentlich auf (Images alter Fassungen und gelöschter Projekte, Build-Cache älter als 7 Tage, gestoppte Wegwerf-Container, alte Uploads). Volumes löscht Airlock nie von selbst. Ab 95 % belegter Platte nimmt Airlock keine Deploys an.

Die Belegung braucht im Socket-Proxy `SYSTEM: 1` (nur `GET /system/df`, steht in `compose.yaml`). Das Update wie gewohnt erzeugt den Proxy wegen der geänderten Umgebung selbst neu:

```sh
docker compose up -d --build
docker inspect airlock-socket-proxy --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SYSTEM   # SYSTEM=1
```

Vor dem ersten Aufräumen ansehen, was weg würde (löscht nichts):

```sh
docker exec airlock-app node dist/cli.js cleanup
# aufräumen wie «Jetzt aufräumen»:
docker exec airlock-app node dist/cli.js cleanup --apply
```

Prüfen, dass die Aufräum-Logik im Image nur Objekte mit Airlock-Label anfasst (baut das Image, eigener Socket-Proxy, Wegwerf-Datenbank, Test-Objekte mit eigenem Label, braucht nur `docker`): `scripts/smoke-aufraeumen.sh` – endet mit «OK: Aufräumen entfernt nur Airlock-Objekte über der Grenze …».

## 7. Ausgang der Projekte (Firewall-Dienst)

Projekt-Container erreichen das Internet, aber nicht das Heimnetz, das Tailnet, andere Docker-Netze oder den Server selbst (Projekt › Einstellungen › «Ausgehende Verbindungen»). Die Regeln setzt der Dienst `airlock-firewall` in einer eigenen nftables-Tabelle `inet airlock`; er gilt nur für Verkehr aus den Netzen `air_*`. Caddy, Airlock, Datenbank, Socket-Proxy, cloudflared, Backup und Statusseite sind nicht betroffen; Dockers Regeln und die Tailscale-Regel aus Abschnitt 1 (`ts-docker-nosnat`, mangle POSTROUTING) fasst er nicht an.

**Vor dem Update** (prüft Dienst, Regeln und Notausgang am echten Kernel, mit eigener Tabelle `inet airlock_smoke` und eigenen Test-Netzen, räumt alles ab, braucht nur `bash` und `docker`):

```sh
scripts/smoke-ausgang.sh
```

Erwartet: rund 35 Zeilen `ok …` (je nach Server 35 oder 36; dazwischen höchstens `Hinweis: …`) und am Ende

```
OK: Ausgang – beobachten protokolliert, durchsetzen sperrt LAN/Server/andere Netze, abgeschottet sperrt Internet, Notausgang entfernt alles (36 Prüfungen)
```

Auf Docker Desktop (Mac) erscheint `Hinweis: DNS nach draussen ging trotz «abgeschottet»` (Docker fragt dort den Resolver vom Host aus); dann sind es 35.

Ein `FEHLER: …` zeigt die letzten Zeilen des Test-Dienstes und dessen Protokoll; der Exit-Code ist dann 1, die laufende Installation bleibt unberührt. Ist `192.168.0.1` auf dem Server die Adresse eines Docker-Netzes, nimmt das Skript `10.255.255.1`; ein eigenes LAN-Ziel geht mit `SMOKE_LAN_TARGET=192.168.1.1 scripts/smoke-ausgang.sh`.

**Update** wie gewohnt; Compose baut `airlock/firewall:local` und startet `airlock-firewall`:

```sh
docker compose up -d --build
docker exec airlock-firewall airlock-fw status     # state "ok", darunter die Tabelle inet airlock
sudo nft list table inet airlock                    # dieselbe Tabelle, vom Host aus gesehen
```

**Beobachten, dann durchsetzen:** Nach dem Update stehen alle bestehenden Projekte auf «Beobachten» – nichts wird gesperrt, Airlock zählt nur, was gesperrt *würde*. Neue Projekte setzen sofort durch. Nach ein paar Tagen je Projekt unter Einstellungen › Ausgehende Verbindungen die Liste «Hätte gesperrt» ansehen: Was das Projekt wirklich braucht (z. B. das NAS), als Ausnahme eintragen, dann «Sperren» einschalten. Server › Übersicht zeigt den Dienst, die Zahl der beobachtenden Projekte und «Alle auf Durchsetzen».

### Notausgang: Ausgangsregeln sofort entfernen

```sh
docker exec airlock-firewall airlock-fw flush
```

Entfernt die Tabelle `inet airlock` vollständig (alle Ausgangsregeln weg, wie vor dem Update) und schaltet den Dienst ab, bis `docker exec airlock-firewall airlock-fw enable` – auch über Neustarts hinweg (Marke `disabled` im Volume `airlock_firewall`). Die Oberfläche zeigt dann «Notausgang aktiv».

Läuft der Dienst nicht (Image kaputt, Container gelöscht), gleichwertig:

```sh
docker compose run --rm firewall airlock-fw flush            # im Ordner von Airlock
# oder ohne Compose, mit dem schon gebauten Image:
docker run --rm --net host --cap-add NET_ADMIN airlock/firewall:local nft delete table inet airlock
# oder direkt auf dem Host:
sudo nft delete table inet airlock
```

(Die letzten beiden entfernen die Tabelle, schalten aber nicht ab: Ein laufender Dienst baut sie aus `rules.nft` neu auf. Dann zusätzlich `docker compose stop firewall`.)

**Was passiert wann:**

- *Dienst gestoppt oder abgestürzt:* Die Regeln bleiben im Kernel stehen und wirken weiter (ein Update des Dienstes öffnet keine Lücke). Neue Projekt-Netze bekommen erst Regeln, wenn er wieder läuft; die Oberfläche zeigt «Firewall-Dienst aus». `restart: unless-stopped` startet ihn neu.
- *Neustart des Servers oder von Docker/nftables:* Die Tabelle ist weg; der Dienst startet mit Docker und baut sie sofort aus `rules.nft` neu auf (auch bevor Airlock läuft). Fehlt sie im Betrieb (z. B. nach `nft flush ruleset`), baut er sie innerhalb von 30 s neu.
- *Falscher Stand:* Jede Datei wird gegen eine feste Grammatik geprüft (nur Sprünge aus `br-<id>`-Bridges, nur Sperren in den Ketten der Projekt-Netze); ein abgelehnter Stand ändert nichts, `airlock-fw status` zeigt den Grund.

## 8. Einbruchserkennung

Airlock sammelt Hinweise auf einen Einbruch und zeigt sie unter **Security › Vorfälle** und im Reiter **Security** jedes Projekts: neue Programme und Shells in Projekt-Containern (`docker top`, jede Minute), geänderte Dateien gegenüber dem Image (`docker diff`, alle 5 Minuten), ausgelieferte Dateien statischer Seiten gegen ihre Fassung (stündlich), Fehlversuche, Sperren und neue Geräte bei der Anmeldung, gesperrte Ausgangsversuche (Abschnitt 7), Scanner-Pfade aus dem Besucher-Log und Abstürze von Containern. Hoch und kritisch kommen zusätzlich per Push und E-Mail (Server › Benachrichtigungen, Ereignis «Einbruchsindiz»; je Vorfall einmal, höchstens 5 Meldungen pro Stunde). Kein Falco, keine Kernel-Module, keine neuen Rechte des Socket-Proxys (`top`, `changes`, `archive` liegen unter `CONTAINERS`; `EXEC` bleibt aus).

**Vor dem Update** (baut das Image, eigener Socket-Proxy ohne exec, Wegwerf-Datenbank, Test-Container mit eigenem Label, räumt alles ab, braucht nur `bash` und `docker`):

```sh
scripts/smoke-einbruch.sh
```

Erwartet am Ende:

```
OK: Shell und Datei im Webroot erkannt (je ein Vorfall, hoch), kein Fehlalarm vorher, Wiederholung gebündelt, Notausgang hebt die Isolation auf.
```

**Nach dem Update** passiert zuerst nichts Sichtbares: Jeder laufende Container lernt 10 Minuten lang seine Grundlinie (Programme, geschriebene Dateien); erst danach meldet Airlock Neues. Ausnahme: Namen bekannter Krypto-Miner (`xmrig` u. a.) sind immer kritisch. Alte Anmeldungen und Sitzungen ergeben keine Vorfälle; statische Seiten werden beim ersten Prüfen festgehalten. Eine Runde von Hand (zeigt, was Airlock gerade sieht, meldet aber nichts doppelt):

```sh
docker exec airlock-app node dist/cli.js intrusion-check
```

**Fehlalarm?** Im Vorfall «Als normal markieren»: das Programm bzw. der Ordner gilt für dieses Projekt ab jetzt als normal (auch nach Deploys). Rückgängig unter Projekt › Security › «Als normal markiert». Ein `docker exec … sh` von Hand in einen Container erscheint als «Shell gestartet» – gewollt.

**Reaktion:** Standard ist nur melden. Je Projekt (Reiter Security) lässt sich «Bei kritischem Vorfall Container stoppen und Seite pausieren» einschalten (Standard aus). «Container jetzt isolieren» (mit erneuter Bestätigung) stellt den Ausgang auf «Abgeschottet» (durchgesetzt), die Restart-Policy der Container auf `no` und sperrt Start, Neustart, Deploy und Rollback bis zur Freigabe. Die Container laufen weiter (Zustand für die Analyse), die Seite bleibt erreichbar.

### Notausgang: Isolation aufheben ohne Oberfläche

```sh
docker exec airlock-app node dist/cli.js release-isolation <projekt-slug>
```

Stellt die Restart-Policies zurück und gibt Start und Deploy frei (Eintrag `project.isolate.release` im Audit-Log). Der Ausgang bleibt «Abgeschottet» – öffnen unter Projekt › Einstellungen › Ausgehende Verbindungen oder alle Ausgangsregeln sofort entfernen mit `docker exec airlock-firewall airlock-fw flush` (Abschnitt 7). Startet Airlock selbst nicht mehr, gleichwertig in der Datenbank (danach Restart-Policy von Hand, z. B. `docker update --restart unless-stopped <container>`):

```sh
docker exec airlock-postgres psql -U airlock -d airlock -c "UPDATE projects SET isolated_at = NULL, isolated_by = NULL, isolation = NULL WHERE slug = '<projekt-slug>';"
```

## Adressen und Wege

| Weg | Adresse | Erreichbar |
| --- | --- | --- |
| Tailnet (Standard für neue Projekte) | `app.<basisdomain>` oder `app.100-101-102-103.nip.io` | jedes Gerät mit Tailscale, zu Hause und unterwegs |
| LAN (auf Wunsch) | eigener Name nur mit lokalem DNS (Router, AdGuard, Pi-hole: `*.<basisdomain>` → LAN-IP); sonst `app.192-168-1-23.nip.io` | Geräte im Heimnetz ohne Tailscale |
| Öffentlich | über Cloudflare Tunnel | alle |

- Ohne Basisdomain bilden die nip.io-Namen sich aus der Tailscale-IP; der Name mit der LAN-IP bleibt als zweiter Name, damit «LAN» auch ohne lokalen DNS geht. Er ändert sich mit der LAN-IP – Airlock zieht ihn nach.
- Caddy lässt einen Namen nur aus den gewählten Wegen zu: Tailnet = `100.64.0.0/10`, LAN = das erkannte LAN-Netz.

## Wenn sich die LAN-IP ändert

Nichts tun. Airlock prüft beim Start und stündlich (oder per «Jetzt prüfen» auf der Systemseite), setzt den IP-Filter für «LAN» auf das neue Netz, benennt nip.io-Namen mit der LAN-IP um und vermerkt die Änderung im Audit-Log (`network.change`). Projekte im Tailnet betrifft das nicht.

## Vor einem Update: Statusseite prüfen

Nach jeder Änderung am Dienst `status` in `compose.yaml` (Härtung, Befehl, Image-Tag von Caddy) und vor `docker compose up -d` auf dem Server:

```sh
scripts/smoke-status.sh
```

Das Skript startet den Dienst genau mit der Konfiguration aus `compose.yaml`, aber mit eigenem Container, Netz und Volume, sodass die laufende Installation nicht berührt wird. Es prüft die Härtung am laufenden Container (nobody, nur lesend, `cap_drop: ALL` plus nur `NET_BIND_SERVICE`, `no-new-privileges`), ruft eine Datei per `wget` ab und räumt alles wieder ab. Es liest keine `.env` und braucht nur `docker` mit Compose v2.24 oder neuer (`docker compose version`). Bei einem Fehler zeigt es die letzten Zeilen des Container-Logs; der Exit-Code ist dann 1.

## Abnahme auf dem Server

Noch offen (braucht den Server und ein Handy):

- [ ] Gerät mit Tailscale (Laptop im Heimnetz): `http://deployer.<tailscale-ip>.nip.io` und ein Projekt im Tailnet öffnen → geht
- [ ] Handy im Mobilnetz **mit** Tailscale: dasselbe Projekt → geht
- [ ] Handy im Mobilnetz **ohne** Tailscale (App getrennt): dasselbe Projekt → geht nicht (der Name zeigt auf eine 100.x-Adresse, die ohne Tailscale nicht erreichbar ist)
- [ ] Laptop im Heimnetz **ohne** Tailscale, Projekt nur «Tailnet», über den LAN-nip.io-Namen → Caddy antwortet mit 403 «Kein Zugriff von <adresse> auf <name> …» (IP-Filter); ein unbekannter Name gibt dagegen 404 «Kein Projekt unter diesem Namen.»
- [ ] Systemseite: Tailscale-IP und LAN-IP erkannt; nach einem Wechsel des LAN (z.B. anderer Router oder DHCP-Lease) zieht «Jetzt prüfen» den Filter nach
