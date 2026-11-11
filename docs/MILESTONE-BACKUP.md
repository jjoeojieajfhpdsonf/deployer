# Meilenstein Backup & Wiederherstellung

Stand: 11. November 2026

Die SPEC verlangt nächtliche Backups («PostgreSQL-Dump und Projekt-Volumes nächtlich, 7 Generationen», Abschnitt Betrieb); im Code fehlt das. Dieser Meilenstein baut es, auf dem Branch `backup` (abgezweigt von `main` @ `2be9dc0`), ein Commit pro Etappe. Nicht gepusht.

## 1. Grundsätze

- **Der Schlüssel `secrets.key` ist nie im normalen Backup im Klartext.** Ohne ihn sind die gesicherten Secrets (Projekt-Env, Cloudflare-Token, Tunnel-Token, SMTP, Repository-Passwort) wertlos; mit ihm im selben Backup wäre ein gestohlenes Backup alles. Er wird getrennt gesichert (Etappe 4).
- **Ein Werkzeug, viele Ziele:** restic in einem eigenen Container; Ziele lokal (Pfad, auch NAS per SMB/NFS-Mount), S3-kompatibel (Backblaze B2, Cloudflare R2, MinIO). Verschlüsselt, dedupliziert, prüfbar.
- **Konsistent statt schnell:** PostgreSQL per `pg_dump` (nicht das Datenverzeichnis); Compose-Volumes pro Projekt wählbar mit kurzem Stopp oder mit Hinweis, dass ein Live-Abzug inkonsistent sein kann.
- **Wiederherstellen ist getestet, nicht behauptet:** ein automatischer Test gegen einen Wegwerf-Stack sichert, löscht, stellt wieder her und prüft Anmeldung, Projekte, entschlüsselbare Secrets und erkanntes Zertifikat.
- **Kein Restore per MCP.** MCP liest nur den Status.

## 2. Umfang

| Was | Woher | Wie |
| --- | --- | --- |
| Datenbank | Container `postgres` | `pg_dump --format=custom` über das interne Netz in eine Datei im Staging-Verzeichnis, dann in restic |
| Caddy-Speicher (Zertifikate, ACME-Konten) | Volume `caddy_data` | Dateien, read-only eingebunden |
| Statische Seiten | Volume `sites` | Dateien |
| Airlock-Daten (lokale Chat-Repos, Artefakte, Uploads) | Volume `data` **ohne** `keys/` | Dateien; `keys/secrets.key` per `--exclude` ausgeschlossen |
| Projekt-Volumes (Compose) | benannte Volumes mit Label des Projekts | je Projekt: Stopp → Sichern → Start, oder live (Einstellung pro Projekt) |
| Airlock-Einstellungen | stehen in der Datenbank (`app_settings`, Umgebungen, Header-Vorlagen) | über den Dump; dazu `compose.yaml`/`.env` **nicht** (gehören zur Installation, siehe RESTORE.md) |
| `secrets.key` | Volume `data`, `keys/` | **nicht** im Backup; getrennter Export (Etappe 4) |

Nicht gesichert: Images (werden neu gebaut bzw. gezogen), Container-Logs, Caddy-Konfiguration (wird aus der Datenbank erzeugt), Scanner-Caches.

## 3. Etappen

### Etappe 1 – Grundlage: restic-Container, Ziele, Repository-Passwort

- Service `backup` in `compose.yaml` (restic, gepinnte Version), nur im internen Netz; liest die Volumes read-only, schreibt nur ins Staging-Volume `backup_staging` und ins Ziel. Gesteuert von Airlock über den Socket-Proxy (`exec`) wie die Scanner.
- Ziel-Einstellung (Server-Teil, serverweit): Art (`local` mit Pfad, `s3` mit Endpoint, Bucket, Region, Access-Key, Secret-Key), Repository-Passwort. Alle Geheimnisse wie andere Secrets verschlüsselt (`lib/crypto.ts`), Prüfung «Verbindung testen» (`restic cat config` bzw. `init` beim ersten Mal).
- Tabelle `backup_runs` (Start, Ende, Ergebnis, Grösse neu/gesamt, Dauer, Snapshot-ID, Fehler) und `backup_settings` in `app_settings`.
- Abnahme: Ziel lokal und S3 (MinIO im Test) einrichten, Repository wird angelegt, Passwort steht nicht im Klartext in DB oder Logs.

**Stand (11. November 2026): umgesetzt.**

- `compose.yaml`: Service `backup` (Image `airlock/backup:local` aus `backup/Dockerfile`: restic 0.17.3 aus `restic/restic:0.17.3`, dazu `pg_dump` aus `postgres:17-alpine`, also dieselbe Hauptversion wie die Datenbank). Liest `caddy_data`, `sites`, `data` read-only unter `/source/…`, schreibt nur ins Staging-Volume `airlock_backup_staging` (`/staging`) und ins Ziel (`/target`: `BACKUP_LOCAL_DIR` aus `.env`, auch ein NAS-Mount; sonst Volume `backup_local`). Feste Host-Kennung, `init: true`.
- Abweichung «nur internes Netz»: zusätzlich das Netz `airlock_backup_egress` (nicht internal, nur dieser Container darin) – S3-Ziele wie B2 oder R2 sind sonst nicht erreichbar.
- Socket-Proxy: `EXEC: 1`. Die Schranke ist `execIn` in `drivers/docker.ts`: exec nur im Container `BACKUP_CONTAINER` (`airlock-backup`). Geheimnisse gehen nur über die Umgebung des exec-Prozesses an restic, nie über Argumente (die stehen in `exec inspect`).
- `secrets.key`: `keys/` ist per `--exclude /source/data/keys` ausgeschlossen (Pflicht, Unit-Test); ebenso `work/`, `scan/`, `scan-src/`.
- Einstellungen in `app_settings` `backup_settings` (Ziel, Passwort und S3-Schlüssel verschlüsselt mit `lib/crypto.ts`, Zeitplan, Aufbewahrung, Projekte), Zustand getrennt in `backup_state`. Tabelle `backup_runs` (Migration `0018_backup_runs.sql`).
- REST (nur mit Anmeldung, Token → 403): `GET/PUT /api/v1/system/backup/settings` (Antwort ohne Geheimnisse, nur `hasPassword`, `hasAccessKey`, `hasSecretKey`), `POST …/test` («Verbindung testen»: `restic cat config`, fehlt das Repository → `init`; falsches Passwort wird erkannt), `GET …/runs`, `GET …/snapshots`. Zod-Schemas in `packages/shared/src/backup.ts`.
- Dateien: `compose.yaml`, `backup/Dockerfile`, `.env.example`, `packages/api/src/backup/{restic,settings,service}.ts`, `packages/api/src/backup/restic.test.ts`, `packages/api/src/http/routes/backup.ts`, `drivers/docker.ts`, `config.ts`, `db/schema.ts`, `http/{app,auth}.ts`, `packages/shared/src/backup.ts`.
- Offen: das Repository-Passwort muss Joël getrennt aufbewahren (ohne es ist jedes Backup wertlos; es steht verschlüsselt in der Datenbank, die selbst im Backup liegt) – Hinweis gehört in die Oberfläche (Etappe 3). Ein Wechsel des Passworts ändert nur die Einstellung, nicht das Repository (`restic key passwd` gibt es nicht).

### Etappe 2 – Sichern: nächtlicher Lauf, «Jetzt sichern», Aufbewahrung

- Ablauf: Sperre (kein paralleler Lauf), `pg_dump` → Staging, Projekt-Volumes nach Einstellung (Stopp/Live), `restic backup` mit Tags (`airlock`, Version, Umgebungen), danach `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` (einstellbar), `restic check` einmal pro Woche.
- Zeitplan: nächtlich (Standard 03:30, einstellbar); Job wie die übrigen (`jobs/backup.ts`), Audit-Einträge, Ereignis in der Glocke.
- Benachrichtigung: neue Art `backup_failed` (Fehlschlag) und `backup_stale` (über 48 h kein Erfolg, höchstens einmal pro Tag).
- Abnahme: zwei Läufe hintereinander, der zweite ist dedupliziert klein; Aufbewahrung entfernt alte Stände; ein absichtlich falsches Ziel ergibt Fehlschlag mit Benachrichtigung.

### Etappe 3 – Oberfläche: Server › Backup

- Reiter «Backup» unter Server: Status (letztes erfolgreiches, Grösse, Dauer, Ziel), «Jetzt sichern» (mit Fortschritt in «Vorgänge»), Liste der Stände (Zeit, Grösse, Inhalt), Einstellungen (Ziel, Zeitplan, Aufbewahrung, Projekte Stopp/Live), Warnung bei > 48 h ohne Erfolg.
- MCP: `get_backup_status` (nur lesen: letzter Lauf, Alter, Ziel-Art ohne Zugangsdaten).
- Abnahme: Szenen hell/dunkel, axe, Tastatur, Schrift ≥ 12 px.

### Etappe 4 – Schlüssel getrennt sichern

- Einmaliger Export von `secrets.key`: als mit einer Passphrase verschlüsselte Datei (age/scrypt) zum Herunterladen, oder als Papier-Anleitung mit QR-Code und Prüfsumme zum Ausdrucken. Der Schlüssel erscheint nie im Backup, nie im Log, nie in einer API-Antwort ohne frische Anmeldung.
- Merker «Schlüssel gesichert am …» (wann, wie) auf der Systemseite; ohne Merker eine dauerhafte Warnung im Backup-Reiter.
- Abnahme: Export und Wiedereinlesen ergeben denselben Schlüssel (Prüfsumme); Schlüssel nicht im restic-Snapshot (Test sucht danach).

### Etappe 5 – Wiederherstellen und Test

- Einzelnes Projekt aus einem Stand: Volumes bzw. Dateien (statische Seite, Chat-Repo) zurückholen, mit Vorschau und Bestätigung (modal, zerstörerisch); Projekt wird dafür gestoppt.
- `docs/RESTORE.md`: frischer Server → Airlock installieren (INSTALL.md) → Schlüssel einspielen → Stand zurückholen (Datenbank, Caddy, Seiten, Daten, Volumes) → Start und Prüfung.
- Automatischer Wiederherstellungstest (`pnpm e2e:restore`) gegen einen Wegwerf-Stack: Backup → alles löschen (Volumes) → Restore → Login klappt, Projekte da, Secrets entschlüsselbar, Zertifikat von Caddy erkannt.
- Abnahme: der Test läuft grün; RESTORE.md einmal Schritt für Schritt nachvollzogen.

## 4. Abnahme gesamt

- Nächtlich ein erfolgreicher Stand, Aufbewahrung 7/4/6, einstellbar.
- Fehlschlag und «48 h ohne Erfolg» melden sich über Benachrichtigung und Glocke.
- Projekt-Restore und Komplett-Restore funktionieren; der automatische Test ist grün.
- `secrets.key` ist in keinem Snapshot; der getrennte Export ist geprüft und datiert.
- Prüfungen je Etappe: Typecheck, Tests, Build, Bildtests (inkl. axe, Tastatur, Schrift), Kontraste.

## 5. Offene Punkte

- Volume-Snapshots auf Dateisystemebene (ZFS/Btrfs) statt Stopp: nur als Hinweis pro Projekt, nicht im Umfang.
- Mehrere Ziele gleichzeitig (lokal **und** S3): nicht im Umfang; ein Ziel.
