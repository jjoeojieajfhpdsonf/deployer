#!/usr/bin/env bash
# Smoke-Test für den Notausgang der Anmeldung (Nacht 3, Etappe 1).
#
# Baut das Airlock-Image aus diesem Checkout, startet eine Wegwerf-Datenbank
# und prüft im Image genau den dokumentierten Befehl:
#
#   node dist/cli.js reset-2fa admin
#
# (auf dem Server: docker exec airlock-app node dist/cli.js reset-2fa admin).
# Dazu legt der Test vorher einen Passkey, TOTP, Codes und eine Sitzung in
# der Datenbank an und prüft danach, dass alles weg ist und das Audit-Log
# einen Eintrag «auth.2fa.reset» hat. Danach wird alles abgeräumt.
#
#   scripts/smoke-notausgang.sh
#
# Eigene Namen (airlock-smoke-cli-*), die laufende Installation bleibt
# unangetastet. Braucht nur bash und docker; liest keine .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=airlock-smoke-cli:test
NET=airlock_smoke_cli
DB=airlock-smoke-cli-db
PW=smoke-only-not-secret # allowlist-secret (Wegwerf-Datenbank)
URL="postgres://airlock:${PW}@${DB}:5432/airlock" # allowlist-secret (Wegwerf-Datenbank)

cleanup() {
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() { echo "FEHLER: $*" >&2; exit 1; }
psql() { docker exec -i "$DB" psql -U airlock -d airlock -tAq "$@"; }
cli() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -e ADMIN_PASSWORD=x -e DATA_DIR=/tmp/data "$IMAGE" node dist/cli.js "$@"; }

command -v docker >/dev/null || fail "docker fehlt"

echo "1. Image bauen (dauert ein paar Minuten)"
docker build -q -t "$IMAGE" "$ROOT" >/dev/null

echo "2. dist/cli.js liegt im Image, Hilfe ohne Datenbank"
docker run --rm "$IMAGE" sh -c 'test -L /app/dist && test -f /app/dist/cli.js' || fail "/app/dist/cli.js fehlt im Image"
docker run --rm "$IMAGE" node dist/cli.js help | grep -q 'reset-2fa <benutzer>' || fail "Hilfe fehlt"

echo "3. Wegwerf-Datenbank"
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --label homebento.ignore=true --network "$NET" -e POSTGRES_USER=airlock -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=airlock postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 || fail "Datenbank startet nicht"
sleep 2

echo "4. Unbekannter Benutzer: abgelehnt, nichts passiert"
set +e
cli reset-2fa mallory >/dev/null 2>&1
code=$?
set -e
[ "$code" = 2 ] || fail "unbekannter Benutzer: Code $code statt 2"

echo "5. Faktoren und Sitzung anlegen"
# Leere Datenbank: der erste gültige Aufruf führt die Migrationen selbst aus
# (Notausgang auch dann, wenn Airlock nie fertig gestartet ist)
cli reset-2fa admin >/dev/null
psql <<'SQL'
INSERT INTO auth_passkeys (credential_id, public_key, name, rp_id) VALUES ('smoke', '\x01', 'MacBook', 'deployer.int.example.ch');
INSERT INTO auth_totp (id, secret_enc, enabled_at, last_step) VALUES (1, '\x01', now(), 1);
INSERT INTO auth_recovery_codes (code_hash) VALUES ('a'), ('b');
INSERT INTO auth_sessions (token_hash, expires_at, method) VALUES ('smoke', now() + interval '1 day', 'passkey');
INSERT INTO app_settings (key, value) VALUES ('auth_2fa_required', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true';
SQL

echo "6. Notausgang: node dist/cli.js reset-2fa admin"
out="$(cli reset-2fa admin)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q 'Passkeys entfernt: *1' || fail "Passkey nicht entfernt"
echo "$out" | grep -q 'Sitzungen abgemeldet: *1' || fail "Sitzung nicht abgemeldet"

[ "$(psql -c 'SELECT count(*) FROM auth_passkeys')" = 0 ] || fail "Passkeys noch da"
[ "$(psql -c 'SELECT count(*) FROM auth_totp')" = 0 ] || fail "TOTP noch da"
[ "$(psql -c 'SELECT count(*) FROM auth_recovery_codes')" = 0 ] || fail "Codes noch da"
[ "$(psql -c 'SELECT count(*) FROM auth_sessions WHERE revoked_at IS NULL')" = 0 ] || fail "Sitzung noch gültig"
[ "$(psql -c "SELECT value FROM app_settings WHERE key = 'auth_2fa_required'")" = "" ] || fail "Pflicht nicht zurückgesetzt"
[ "$(psql -c "SELECT count(*) FROM audit_events WHERE action = 'auth.2fa.reset' AND actor = 'cli:admin'")" -ge 1 ] || fail "kein Audit-Eintrag"

echo "OK: Notausgang funktioniert im Image (dist/cli.js, reset-2fa, Audit)."
