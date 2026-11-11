# Wiederherstellen

Stand: 11. November 2026

Zwei Fälle:

- **Ein Projekt zurückholen** (Server läuft, ein Projekt ist kaputt oder Daten sind weg): in der Oberfläche, Abschnitt 1.
- **Ganzer Server weg** (neue Platte, neuer Rechner): frischer Server, Schlüssel einspielen, Stand zurückholen, Abschnitt 2.

Was im Backup steckt und was nicht, steht in [MILESTONE-BACKUP.md](MILESTONE-BACKUP.md), Abschnitt 2. Kurz: Datenbank (alle Einstellungen, Projekte, verschlüsselten Secrets), Caddy-Speicher (Zertifikate), statische Seiten, Airlock-Daten (Chat-Repos, Uploads) und die Volumes der Compose-Projekte. **Nicht** darin: `secrets.key` (absichtlich, siehe unten), `.env`, Images, Logs.

## Was du dafür brauchst

| Was | Wo es liegt | Ohne es |
| --- | --- | --- |
| Zugang zum Backup-Ziel (lokaler Ordner/NAS oder S3 mit Access-Key und Secret-Key) | beim Anbieter bzw. auf dem NAS | kein Restore |
| **Repository-Passwort** | Passwort-Manager (Server › Backup › Einstellungen sagt es beim Einrichten) | das Backup ist nicht lesbar |
| **Schlüssel der Secrets** (`secrets.key`): Datei `airlock-secrets-key-….age` mit Passphrase, oder das Papier mit QR-Code | getrennt abgelegt (Server › Backup › Schlüssel der Secrets, «gesichert am …») | Projekte, Seiten und Zertifikate kommen zurück, aber alle Secrets (Variablen der Projekte, Cloudflare-Token, Tunnel, SMTP, ntfy, das Repository-Passwort in der Datenbank) sind unlesbar und müssen neu eingegeben werden |
| `.env` des alten Servers (mindestens `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `BACKUP_LOCAL_DIR`) | Passwort-Manager oder neu setzen | geht auch neu (siehe 2.1) |

Der Schlüssel liegt nie im Backup: Mit ihm im selben Backup wäre ein gestohlenes Backup alles. Darum zeigt Server › Backup eine Warnung, solange er nicht getrennt gesichert ist.

## 1. Ein Projekt zurückholen

Server › Backup › Stände im Repository › beim gewünschten Stand **Wiederherstellen**.

1. Projekt wählen. Airlock zeigt, was der Stand davon enthält: Volumes (Compose-Projekte), statische Seite, lokales Repository (Chat-Projekte) – je mit Zahl der Dateien und Grösse – und wie viele Container dafür angehalten werden.
2. Zur Bestätigung den Slug des Projekts eintippen. **Zerstörerisch:** was jetzt in diesen Volumes und Ordnern liegt, wird ersetzt. Die Projekt-Datenbank (z. B. ein Postgres im Compose-Projekt) steht danach auf dem Stand des Backups.
3. Airlock holt die Teile aus dem Repository, hält die laufenden Container des Projekts an, ersetzt Volumes, Seite und Repository und startet die Container wieder. Der Fortschritt steht oben unter «Vorgänge», das Ergebnis im Verlauf des Projekts (Aktivität «Aus Backup wiederhergestellt»).

Läuft gerade eine Sicherung oder ein Deploy des Projekts, lehnt Airlock ab – danach erneut versuchen. Über MCP oder ein API-Token geht das nicht, nur angemeldet in der Oberfläche.

## 2. Ganzer Server

### 2.1 Frischen Server aufsetzen, Airlock noch nicht starten

Nach [INSTALL.md](INSTALL.md) Schritt 1 (Tailscale) und den ersten Teil von Schritt 2:

```sh
git clone <repo> airlock && cd airlock
cp .env.example .env
```

In `.env` setzen:

- `POSTGRES_PASSWORD`: beliebig neu (die Datenbank wird neu angelegt und aus dem Dump gefüllt).
- `ADMIN_PASSWORD`: das alte oder ein neues. Gilt nur, falls das Passwort in der Oberfläche nie geändert wurde – sonst gilt nach dem Restore das zuletzt in der Oberfläche gesetzte (es steht in der Datenbank). Ein neuer Wert in `.env` setzt es beim Start zurück (der Weg zurück bei vergessenem Passwort).
- Lokales Ziel: `BACKUP_LOCAL_DIR` auf den Ordner bzw. NAS-Mount mit dem Repository (derselbe Ordner wie vorher; das Repository liegt darin z. B. unter `airlock/`).

**Noch nicht `docker compose up`.** Erst Container und Volumes anlegen, ohne zu starten:

```sh
docker compose build
docker compose create
```

### 2.2 Schlüssel einspielen

**Aus der Datei** (age, Passphrase): mit `age` (Debian/Ubuntu: `apt install age`, macOS: `brew install age`)

```sh
age -d -o secrets.key airlock-secrets-key-<server>-<datum>.age   # fragt nach der Passphrase
```

Ohne age auf dem Server, mit Docker:

```sh
docker run --rm -it -v "$PWD":/w alpine:3.20 sh -c 'apk add -q age && age -d -o /w/secrets.key /w/airlock-secrets-key-<server>-<datum>.age'
```

**Vom Papier:** den Base64-Text abtippen (oder den QR-Code scannen)

```sh
echo '<Base64 vom Blatt>' | base64 -d > secrets.key
```

Prüfen – die ersten 16 Zeichen müssen der «Prüfsumme» auf dem Blatt bzw. unter Server › Backup entsprechen (ohne Leerzeichen):

```sh
wc -c secrets.key        # 32
sha256sum secrets.key    # macOS: shasum -a 256 secrets.key
```

Dann ins Daten-Volume legen (Rechte wie bei Airlock) und die Datei auf dem Server löschen:

```sh
docker run --rm -v airlock_data:/data -v "$PWD":/w alpine:3.20 sh -c \
  'mkdir -p /data/keys && cp /w/secrets.key /data/keys/secrets.key && chmod 700 /data/keys && chmod 600 /data/keys/secrets.key'
shred -u secrets.key 2>/dev/null || rm -f secrets.key
```

### 2.3 Stand zurückholen

Datenbank starten, dann der Komplett-Restore im Backup-Container (`airlock-restore`, backup/restore-all.sh). Das Repository-Passwort nicht in die Shell-History schreiben:

```sh
docker compose up -d postgres
read -rs RESTIC_PASSWORD && export RESTIC_PASSWORD     # Repository-Passwort eingeben
```

Lokales Ziel (Pfad wie unter Server › Backup › Ziel, z. B. `/target/airlock`):

```sh
docker compose run --rm \
  -e RESTIC_REPOSITORY=/target/airlock -e RESTIC_PASSWORD \
  -v airlock_data:/restore/data -v airlock_sites:/restore/sites -v airlock_caddy_data:/restore/caddy_data \
  backup airlock-restore latest
```

S3-Ziel:

```sh
read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY
docker compose run --rm \
  -e RESTIC_REPOSITORY=s3:https://s3.eu-central-003.backblazeb2.com/<bucket>/<unterordner> -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID=<access-key> -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION=<region> \
  -v airlock_data:/restore/data -v airlock_sites:/restore/sites -v airlock_caddy_data:/restore/caddy_data \
  backup airlock-restore latest
```

Statt `latest` geht die Kennung eines bestimmten Stands (`restic snapshots` bzw. die Liste unter Server › Backup). Das Skript bricht ab, wenn `keys/secrets.key` fehlt oder nicht 32 Bytes hat, und holt zurück:

- Datenbank (`pg_restore --clean` aus dem Dump),
- Caddy-Speicher (Zertifikate und ACME-Konto – Caddy muss nicht neu bei Let’s Encrypt anfragen),
- statische Seiten,
- Airlock-Daten (Chat-Repos, Uploads); `keys/` bleibt, wie in 2.2 gelegt.

### 2.4 Starten und prüfen

```sh
unset RESTIC_PASSWORD AWS_SECRET_ACCESS_KEY
docker compose up -d
```

Prüfen:

1. Anmelden (Passwort siehe 2.1).
2. Projekte sind in allen Umgebungen da; die Variablen eines Projekts lassen sich öffnen (Secrets entschlüsselbar). Server › Backup zeigt «Schlüssel getrennt gesichert ✓» – sonst stimmt der Schlüssel nicht.
3. Einstellungen › Cloudflare & HTTPS: Zertifikat erkannt, interne Adressen über https.
4. Server › Backup › «Verbindung testen»: das Repository ist erreichbar.
5. **Projekt-Volumes** (Compose-Projekte): Airlock deployt die Projekte beim Start neu, Compose legt ihre Volumes leer an. Je Projekt unter Server › Backup › Wiederherstellen (Abschnitt 1) die Volumes zurückholen.
6. Server-Adresse geändert (neue Tailscale-IP)? Die Systemseite zieht sie selbst nach; DNS-Einträge bei Cloudflare siehe INSTALL.md.

## Getestet

`pnpm --filter @airlock/api e2e:restore` (packages/api/scripts/restore-e2e.ts) spielt Abschnitt 2 und Abschnitt 1 gegen einen Wegwerf-Aufbau durch: Backup → Datenbank, Daten, Seiten, Caddy-Speicher, Projekt-Volume und Staging löschen → Schlüssel mit dem echten `age` aus der exportierten Datei → `airlock-restore latest` → Anmeldung mit dem in der Oberfläche geänderten Passwort, Projekte da, Secrets entschlüsselbar, Zertifikat erkannt → Projekt-Restore über die API (Volume, Seite, Repository).
