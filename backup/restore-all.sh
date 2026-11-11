#!/bin/sh
# Komplett-Restore eines Airlock-Servers aus einem restic-Stand
# (docs/RESTORE.md, Schritt «Stand zurückholen").
#
# Läuft NICHT über die Aufträge von Airlock, sondern von Hand auf dem Server,
# einmal, mit den Volumes des Stacks beschreibbar eingehängt:
#
#   docker compose up -d postgres
#   docker compose run --rm \
#     -e RESTIC_REPOSITORY=/target/airlock -e RESTIC_PASSWORD \
#     -v airlock_data:/restore/data -v airlock_sites:/restore/sites \
#     -v airlock_caddy_data:/restore/caddy_data \
#     backup airlock-restore latest
#
# Holt zurück: Datenbank (pg_restore aus dem Dump), Caddy-Speicher
# (Zertifikate, ACME-Konten), statische Seiten, Airlock-Daten (Chat-Repos,
# Uploads). Nicht: secrets.key (liegt nie im Backup – vorher von Hand nach
# keys/secrets.key legen, sonst bricht das Skript ab) und Projekt-Volumes
# (die legt Compose erst beim Deploy an; danach je Projekt unter
# Server › Backup › Wiederherstellen).
#
# POSIX-sh, nur BusyBox, restic und pg_restore aus dem Backup-Image.
set -eu

SNAP=${1:-latest}
WORK=/staging/full-restore
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-/staging/cache}

die() {
  echo "airlock-restore: $*" >&2
  exit 1
}

case "$SNAP" in
  latest) ;;
  *[!0-9a-f]* | '') die "Stand «$SNAP»: «latest» oder die Kennung (Hex) aus «restic snapshots»" ;;
esac
[ -n "${RESTIC_REPOSITORY:-}" ] || die 'RESTIC_REPOSITORY fehlt (lokal z. B. /target/airlock, S3 s3:https://host/bucket/ordner)'
[ -n "${RESTIC_PASSWORD:-}" ] || die 'RESTIC_PASSWORD fehlt (das Repository-Passwort aus dem Passwort-Manager)'
for d in /restore/data /restore/sites /restore/caddy_data; do
  [ -d "$d" ] || die "$d ist nicht eingehängt (siehe Aufruf oben)"
done
KEY=/restore/data/keys/secrets.key
[ -f "$KEY" ] || die "Erst den Schlüssel nach keys/secrets.key im Daten-Volume legen (docs/RESTORE.md) – ohne ihn sind die Secrets wertlos"
[ "$(wc -c <"$KEY")" -eq 32 ] || die "$KEY hat nicht 32 Bytes – falsche Datei?"

echo "airlock-restore: Stand $SNAP aus $RESTIC_REPOSITORY"
rm -rf "$WORK"
mkdir -p "$WORK"
restic restore "$SNAP" --host airlock --target "$WORK" \
  --include /staging/db --include /source/caddy_data --include /source/sites --include /source/data
[ -f "$WORK/staging/db/airlock.dump" ] || die 'Im Stand fehlt der Datenbank-Dump'

echo 'airlock-restore: Datenbank (pg_restore)'
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="${PGDATABASE:-airlock}" "$WORK/staging/db/airlock.dump"

for v in caddy_data sites data; do
  if [ -d "$WORK/source/$v" ]; then
    echo "airlock-restore: $v"
    cp -a "$WORK/source/$v/." "/restore/$v/"
  fi
done
# Der Schlüssel bleibt, wie er ist (er war nie im Stand); Rechte wie bei Airlock
chmod 700 /restore/data/keys
chmod 600 "$KEY"

rm -rf "$WORK"
echo 'airlock-restore: fertig. Jetzt «docker compose up -d» und anmelden; Projekt-Volumes danach je Projekt unter Server › Backup › Wiederherstellen.'
