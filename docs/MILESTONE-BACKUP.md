# Meilenstein Backup & Wiederherstellung

Stand: 11. November 2026

Die SPEC verlangt nächtliche Backups («PostgreSQL-Dump und Projekt-Volumes nächtlich, 7 Generationen», Abschnitt Betrieb); im Code fehlt das. Dieser Meilenstein baut es, auf dem Branch `backup` (abgezweigt von `main` @ `2be9dc0`), ein Commit pro Etappe. Nicht gepusht.

## 1. Grundsätze

- **Der Schlüssel `secrets.key` ist nie im normalen Backup im Klartext.** Ohne ihn sind die gesicherten Secrets (Projekt-Env, Cloudflare-Token, Tunnel-Token, SMTP, Repository-Passwort) wertlos; mit ihm im selben Backup wäre ein gestohlenes Backup alles. Er wird getrennt gesichert (Etappe 4).
- **Ein Werkzeug, viele Ziele:** restic in einem eigenen Container; Ziele lokal (Pfad, auch NAS per SMB/NFS-Mount), S3-kompatibel (Backblaze B2, Cloudflare R2, MinIO). Verschlüsselt, dedupliziert, prüfbar.
- **Konsistent statt schnell:** PostgreSQL per `pg_dump` (nicht das Datenverzeichnis); Compose-Volumes pro Projekt wählbar mit kurzem Stopp oder mit Hinweis, dass ein Live-Abzug inkonsistent sein kann.
- **Wiederherstellen ist getestet, nicht behauptet:** ein automatischer Test gegen einen Wegwerf-Stack sichert, löscht, stellt wieder her und prüft Anmeldung, Projekte, entschlüsselbare Secrets und erkanntes Zertifikat.
- **Kein Restore per MCP.** MCP liest nur den Status.
- **Kein `docker exec`.** Der Socket-Proxy bleibt bei `EXEC: 0` (er könnte exec nicht auf einen Container beschränken). Der Backup-Container ist ein eigener Dienst, der Aufträge aus einem gemeinsamen Volume abholt und nur feste Vorgänge ausführt; Zeitplan und Regeln bleiben in Airlock. Geheimnisse reisen nie dauerhaft durch das Volume.

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

- Service `backup` in `compose.yaml` (restic, gepinnte Version), nur im internen Netz; liest die Volumes read-only, schreibt nur ins Staging-Volume `backup_staging` und ins Ziel. Gesteuert von Airlock über Aufträge in einem gemeinsamen Volume (ursprünglich per `exec` geplant, siehe Grundsätze).
- Ziel-Einstellung (Server-Teil, serverweit): Art (`local` mit Pfad, `s3` mit Endpoint, Bucket, Region, Access-Key, Secret-Key), Repository-Passwort. Alle Geheimnisse wie andere Secrets verschlüsselt (`lib/crypto.ts`), Prüfung «Verbindung testen» (`restic cat config` bzw. `init` beim ersten Mal).
- Tabelle `backup_runs` (Start, Ende, Ergebnis, Grösse neu/gesamt, Dauer, Snapshot-ID, Fehler) und `backup_settings` in `app_settings`.
- Abnahme: Ziel lokal und S3 (MinIO im Test) einrichten, Repository wird angelegt, Passwort steht nicht im Klartext in DB oder Logs.

**Stand (11. November 2026): umgesetzt.**

- `compose.yaml`: Service `backup` (Image `airlock/backup:local` aus `backup/Dockerfile`: restic 0.17.3 aus `restic/restic:0.17.3`, dazu `pg_dump` aus `postgres:17-alpine`, also dieselbe Hauptversion wie die Datenbank). Liest `caddy_data`, `sites`, `data` read-only unter `/source/…`, schreibt nur ins Staging-Volume `airlock_backup_staging` (`/staging`) und ins Ziel (`/target`: `BACKUP_LOCAL_DIR` aus `.env`, auch ein NAS-Mount; sonst Volume `backup_local`). Feste Host-Kennung, `init: true`.
- Abweichung «nur internes Netz»: zusätzlich das Netz `airlock_backup_egress` (nicht internal, nur dieser Container darin) – S3-Ziele wie B2 oder R2 sind sonst nicht erreichbar.
- Ohne exec (Socket-Proxy `EXEC: 0` wie vor dem Meilenstein): Der Backup-Container führt `backup/runner.sh` aus (POSIX-sh, nur BusyBox aus dem Image). Airlock legt Aufträge in das Volume `airlock_backup_jobs` (bei Airlock `/backup-jobs` = `BACKUP_JOBS_DIR`, im Container `/jobs`); Format und Fristen in `packages/api/src/backup/jobs.ts`, Schreiben und Warten in `backup/dispatch.ts`.
  - Auftrag `<id>.job`, zeilenweise (`op …`, `timeout …`, je Argument `arg …`), erscheint per rename. Der Ausführer schaut jede Sekunde, holt ihn per rename nach `<id>.run` ab (atomar, nie doppelt) und führt ihn im Hintergrund aus – mehrere gleichzeitig, wie früher exec. Nur feste Vorgänge: `restic` mit den Unterbefehlen `backup`, `check`, `forget`, `init`, `snapshots` und `cat config` (nicht `cat masterkey`), ohne `--repo`, `--password-command`, `--password-file`, `-o`; `pg-dump` in die feste Datei; `staging-prepare`, `staging-clean`. Alles andere: Exit 126.
  - Rückweg: Ausgabe in `<id>.out`/`<id>.err`, Lebenszeichen über die mtime von `<id>.run` (jede Sekunde), Ergebnis `<id>.result` (Exit, Zeitlimit, Abbruch) per rename. Airlock liest es, schwärzt wie bisher und löscht alle Dateien des Auftrags.
  - Zeitlimit: setzt der Ausführer selbst durch (TERM, nach 15 s KILL). Airlock wartet Zeitlimit + 60 s; nicht abgeholt nach 30 s → Fehler «Backup-Container nimmt keine Aufträge an», Auftrag und Geheimnis werden zurückgezogen; 90 s ohne Lebenszeichen → Fehler statt Hängen. Abbruch über `<id>.cancel` (auch beim Start von Airlock für Aufträge eines früheren Prozesses). Ein Neustart des Containers meldet laufende Aufträge als abgebrochen (Exit 255).
  - Geheimnisse (Repository-Passwort, S3-Schlüssel): nie im Auftrag, sondern in `<id>.env` mit Rechten 0600, geschrieben vor dem Auftrag; der Ausführer liest sie beim Abholen, löscht die Datei sofort und gibt die Werte nur dem einen Prozess in die Umgebung (nur Variablen aus einer Erlaubnisliste). Das Volume ist ein tmpfs (`size=64m,mode=0700`): die Datei erreicht keine Platte, lebt höchstens bis zum Abholen (≤ 1 s) und ist nach einem Neustart des Servers weg; verwaiste `.env` löscht der Ausführer nach 2 Minuten. Verschlüsseln mit einem Auftragsschlüssel brächte nichts dazu – der Schlüssel müsste denselben Weg nehmen.
  - Stopp/Start der Projekt-Container (Modus `stop`) macht Airlock selbst über den Socket-Proxy (`CONTAINERS`, `POST`); die Kopie der Projekt-Volumes ins Staging macht wie bisher ein kurzlebiger Hilfscontainer über die Create-API, durch die Erlaubnisliste. Den Backup-Container die Projekt-Volumes einbinden zu lassen ginge nicht: sie entstehen zur Laufzeit und stehen nicht in `compose.yaml`.
- `secrets.key`: `keys/` ist per `--exclude /source/data/keys` ausgeschlossen (Pflicht, Unit-Test); ebenso `work/`, `scan/`, `scan-src/`.
- Einstellungen in `app_settings` `backup_settings` (Ziel, Passwort und S3-Schlüssel verschlüsselt mit `lib/crypto.ts`, Zeitplan, Aufbewahrung, Projekte), Zustand getrennt in `backup_state`. Tabelle `backup_runs` (Migration `0018_backup_runs.sql`).
- REST (nur mit Anmeldung, Token → 403): `GET/PUT /api/v1/system/backup/settings` (Antwort ohne Geheimnisse, nur `hasPassword`, `hasAccessKey`, `hasSecretKey`), `POST …/test` («Verbindung testen»: `restic cat config`, fehlt das Repository → `init`; falsches Passwort wird erkannt), `GET …/runs`, `GET …/snapshots`. Zod-Schemas in `packages/shared/src/backup.ts`.
- Dateien: `compose.yaml`, `backup/Dockerfile`, `backup/runner.sh`, `.env.example`, `packages/api/src/backup/{restic,settings,service,jobs,dispatch}.ts`, `packages/api/src/backup/{restic,jobs}.test.ts`, `packages/api/src/http/routes/backup.ts`, `config.ts`, `db/schema.ts`, `http/{app,auth}.ts`, `packages/shared/src/backup.ts`.
- Offen: das Repository-Passwort muss Joël getrennt aufbewahren (ohne es ist jedes Backup wertlos; es steht verschlüsselt in der Datenbank, die selbst im Backup liegt) – Hinweis gehört in die Oberfläche (Etappe 3). Ein Wechsel des Passworts ändert nur die Einstellung, nicht das Repository (`restic key passwd` gibt es nicht).

### Etappe 2 – Sichern: nächtlicher Lauf, «Jetzt sichern», Aufbewahrung

- Ablauf: Sperre (kein paralleler Lauf), `pg_dump` → Staging, Projekt-Volumes nach Einstellung (Stopp/Live), `restic backup` mit Tags (`airlock`, Version, Umgebungen), danach `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` (einstellbar), `restic check` einmal pro Woche.
- Zeitplan: nächtlich (Standard 03:30, einstellbar); Job wie die übrigen (`jobs/backup.ts`), Audit-Einträge, Ereignis in der Glocke.
- Benachrichtigung: neue Art `backup_failed` (Fehlschlag) und `backup_stale` (über 48 h kein Erfolg, höchstens einmal pro Tag).
- Abnahme: zwei Läufe hintereinander, der zweite ist dedupliziert klein; Aufbewahrung entfernt alte Stände; ein absichtlich falsches Ziel ergibt Fehlschlag mit Benachrichtigung.

**Stand (11. November 2026): umgesetzt.**

- Ablauf in `packages/api/src/backup/run.ts` (jeder Schritt im Backup-Container ist ein Auftrag, siehe Etappe 1): Sperre (im Prozess und `pg_advisory_lock`, zweiter Start → 409), Repository prüfen bzw. anlegen, Staging leeren, `pg_dump --format=custom` über das interne Netz, Projekt-Volumes (Compose, `air_<slug>_*`) per Wegwerf-Container (`alpine:3.20`, durch die Erlaubnisliste, Staging als erlaubtes Zusatz-Volume) nach `/staging/volumes/<slug>/<volume>` – je Projekt `live` (Vorgabe), `stop` (Container kurz anhalten, danach wieder starten; läuft gerade ein Deploy, live mit Hinweis) oder `skip`. Danach `restic backup --json --host airlock` mit Tags `airlock`, `airlock-<version>`, `env-<umgebung>`; `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` (einstellbar, gruppiert nach Host); `restic check` einmal pro Woche; Staging wieder leeren.
- Ergebnis je Lauf: `ok`, `warning` (Stand gesichert, aber z. B. Aufbewahrung gescheitert, Datei unlesbar, Projekt-Volume fehlt) oder `failed`. Grösse neu/gesamt, Dateien, Dauer, Snapshot-ID, Fehler geschwärzt.
- Zeitplan `jobs/backup.ts`: Takt jede Minute, fällig nach `backup/rules.ts` (Standard 03:30 Ortszeit, `TZ` oder Europe/Zurich; ein verpasster Termin wird einmal nachgeholt; kein Sofortlauf nach dem Einrichten am Tag). «48 h ohne Erfolg»: Benachrichtigung `backup_stale` höchstens einmal pro Tag, dazu Audit `backup.stale` (Glocke). Beim Start werden abgebrochene Läufe als gescheitert markiert.
- Audit `backup.run` (Akteur `system` beim Zeitplan → Glocke; Fehlschläge immer), Benachrichtigung `backup_failed` mit Ziel, Fehler und letztem Erfolg. Neue Arten in `notify/render.ts` (Vorgabe Push und E-Mail), in der Oberfläche in der Matrix der Benachrichtigungen und mit Texten im Verlauf (`lib/activity.ts`).
- REST zusätzlich: `GET /api/v1/system/backup` (Status: Einstellungen, letzte Läufe, letzter Erfolg, `stale`, nächster Termin), `POST /api/v1/system/backup/run` («Jetzt sichern», 202 mit dem Lauf).
- Tests: `backup/rules.test.ts` (Termin über Sommer-/Winterzeit, fällig, nachholen, 48 h, einmal pro Tag, wöchentliche Prüfung), `backup/messages.test.ts`, `backup/jobs.test.ts` (Auftrag bauen, Umgebungsdatei 0600 und nur erlaubte Variablen, Ergebnis lesen, Zeitüberschreitung, nicht abgeholt, kein Lebenszeichen, Aufräumen beim Start – gegen einen nachgebauten Ausführer im Dateisystem). Mit echtem Docker: `pnpm --filter @airlock/api e2e:backup` (`scripts/backup-e2e.ts`) – Wegwerf-Postgres, Backup-Container mit Ausführer, Socket-Proxy wie in `compose.yaml` (`EXEC=0`), S3-Testserver; 38 Prüfungen grün am 11. November 2026: exec über den Proxy abgelehnt, lokal und S3 angelegt, Passwort und Schlüssel nicht im Klartext in DB und Audit, zwei Läufe (zweiter dedupliziert ~65 KB statt ~2 MB), `secrets.key` in keinem Stand, Aufbewahrung entfernt alte Stände, Modus `stop` und `skip`, falsches Passwort erkannt, falsches Ziel → Fehlschlag mit Push, «48 h ohne Erfolg» einmal gemeldet; Ausführer lehnt `restic cat masterkey` und `--password-command` ab; kein Geheimnis im Auftrags-Verzeichnis und im Log des Ausführers. Zeitlimit, Abbruch über `.cancel` und Neustart des Containers mitten im Auftrag von Hand mit einer restic-Attrappe geprüft.
- Abweichung im Test: MinIO-Images sind nicht mehr öffentlich zu ziehen; der S3-Test nimmt SeaweedFS (`chrislusf/seaweedfs:3.97`). Dort muss der Bucket vorher angelegt sein (SeaweedFS merkt sich «Bucket fehlt» aus dem ersten Zugriff); bei echten Anbietern legt restic ihn selbst an.
- Offen: nicht geprüft gegen einen echten Anbieter (B2, R2) und nicht im laufenden Stack (`docker compose up`; dort ist das Auftrags-Volume ein tmpfs, im e2e ein Host-Ordner). Lange Läufe hängen nicht mehr an einer Verbindung über den Socket-Proxy (früher: HAProxy-Zeitlimits bei exec). Die Bildtests der Seite «Benachrichtigungen» zeigen zwei neue Zeilen und brauchen neue Referenzbilder (nicht ausgeführt, Port belegt).

### Etappe 3 – Oberfläche: Server › Backup

- Reiter «Backup» unter Server: Status (letztes erfolgreiches, Grösse, Dauer, Ziel), «Jetzt sichern» (mit Fortschritt in «Vorgänge»), Liste der Stände (Zeit, Grösse, Inhalt), Einstellungen (Ziel, Zeitplan, Aufbewahrung, Projekte Stopp/Live), Warnung bei > 48 h ohne Erfolg.
- MCP: `get_backup_status` (nur lesen: letzter Lauf, Alter, Ziel-Art ohne Zugangsdaten).
- Abnahme: Szenen hell/dunkel, axe, Tastatur, Schrift ≥ 12 px.

**Stand (11. November 2026): umgesetzt.**

- Reiter «Backup» unter Server (`/server/backup`, alte Adresse `/system/backup` leitet weiter, Befehlspalette «Backup»): `packages/web/src/components/Backup.tsx`.
  - Warnungen oben: «Seit über 48 Stunden kein erfolgreiches Backup» (mit letztem Fehler, `role="alert"`), «noch nicht eingerichtet», «nächtlicher Lauf ausgeschaltet».
  - «Stand»: letztes erfolgreiches Backup (Zeit und Alter), Grösse gesamt und neu, Dauer, Ziel (ohne Zugangsdaten), nächster Lauf, letzte Prüfung (`restic check`). Knöpfe «Jetzt sichern» und «Verbindung testen» (Ergebnis daneben bzw. als Fehlermeldung mit Symbol).
  - «Jetzt sichern» erscheint unter «Vorgänge» im Kopf (`lib/activities.ts`, Art `backup`) und im Tab-Titel; am Ende ein Toast mit dem Ergebnis. Abgefragt wird `GET /system/backup` nur, solange ein Lauf bekannt ist (alle 3 s) – die übrigen Seiten machen dafür keine Anfrage (Anfragen pro Minute unverändert). Ende eines Laufs kommt zusätzlich über den Ereignisstrom (Audit → `['backup']`).
  - «Letzte Läufe» (Start, Auslöser, Ergebnis als Pille mit Text, neu/gesamt, Dauer, Fehler bzw. Hinweise), «Stände im Repository» (fragt das Ziel live ab; Zeit, Kennung, Grösse, Inhalt aus den Tags: Version, Umgebungen).
  - «Einstellungen»: Ziel lokal/NAS oder S3 (Schlüssel nur hinein, «gesetzt – leer lassen für unverändert»), Repository-Passwort mit dem Hinweis, es getrennt aufzubewahren (offener Punkt aus Etappe 1), Zeitplan (an/aus, Uhrzeit mit Zeitzone), Aufbewahrung 7/4/6, Volumes je Compose-Projekt aller Umgebungen (live, kurz stoppen, nicht sichern). Prüfung mit `backupSettingsInputSchema` wie in der API, Rückfrage beim Verlassen mit ungespeicherten Änderungen.
- API: `GET /system/backup` liefert zusätzlich `projects` (Compose-Projekte aller Umgebungen).
- MCP `get_backup_status` (nur lesen): konfiguriert, an/aus, läuft, Art des Ziels, letzter Lauf (Status, Auslöser, Zeiten, Dauer, Fehler, Zahl der Hinweise), letzter Erfolg und Alter in Stunden, «48 h ohne Erfolg», nächster Termin. Kein Pfad, kein Endpoint, kein Bucket, keine Projekte (`backup/summary.ts`, Test `summary.test.ts`). In SPEC.md in der Werkzeugliste.
- Szenen `system-backup`, `system-backup-leer`, `system-backup-veraltet` (hell/dunkel, axe, Schrift ≥ 12 px). Wegen des neuen Reiters neue Referenzbilder: `system-uebersicht`, `system-benachrichtigungen`, `system-github`, `m9-server`, `einrichtung-system`.

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
