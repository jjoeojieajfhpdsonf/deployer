#!/usr/bin/env bash
# Smoke-Test «Server aufräumen» (Nacht 3, Etappe 3) gegen echtes Docker.
#
# Baut das Airlock-Image aus diesem Checkout und lässt darin genau die
# Aufräum-Logik von Airlock laufen (node dist/cli.js cleanup), über einen
# eigenen Socket-Proxy mit den Rechten aus compose.yaml (inkl. SYSTEM=1 für
# GET /system/df) und mit einer Wegwerf-Datenbank.
#
#   scripts/smoke-aufraeumen.sh
#
# Sicherheit: Jedes Test-Objekt trägt das Label airlock.smoke=<zufall>, und
# die CLI läuft mit --only-label airlock.smoke=<zufall>. Damit sieht das
# Aufräumen NUR die Objekte dieses Laufs – keine Images, Container oder
# Volumes der laufenden Installation oder anderer Arbeit, keinen Build-Cache
# und keine Dateien. Am Ende wird alles mit diesem Label wieder entfernt.
# Braucht nur bash und docker (Basis-Image postgres:17-alpine, wie compose.yaml);
# liest keine .env.
#
# Geprüft:
#   - Vorschau löscht nichts; --apply entfernt genau:
#       Image eines gelöschten Projekts, dangling Image mit Airlock-Label,
#       Image einer Fassung über der Rollback-Grenze, gestoppten Build-Container,
#       Fassungen über der Grenze in der Liste (Datenbank)
#   - bleibt: aktives Image (ohne Container!), Image in Benutzung, fremdes Image
#     ohne Airlock-Label, gestoppter Projekt-Container ohne Wegwerf-Rolle,
#     verwaistes Volume (nur aufgelistet)
#   - Audit-Eintrag storage.cleanup
#   - ohne SYSTEM=1 im Proxy: klare Meldung statt Absturz

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAND="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)"
[ -n "$RAND" ] || RAND="$$$(date +%s)"
LBL="airlock.smoke=${RAND}"
P="smk${RAND}"
# Wiederholen ohne neuen Build: KEEP_IMAGE=1 SMOKE_IMAGE=airlock-smoke-aufraeumen:test (einmal gebaut)
IMAGE="${SMOKE_IMAGE:-airlock-smoke-aufraeumen:${RAND}}"
NET="airlock_smoke_aufr_${RAND}"
DB="airlock-smoke-aufr-db-${RAND}"
PROXY="airlock-smoke-aufr-proxy-${RAND}"
PROXY_NOSYS="airlock-smoke-aufr-nosys-${RAND}"
BASE=postgres:17-alpine
PW=smoke-only-not-secret # allowlist-secret (Wegwerf-Datenbank)
URL="postgres://airlock:${PW}@${DB}:5432/airlock" # allowlist-secret (Wegwerf-Datenbank)

cleanup() {
  set +e
  for c in $(docker ps -aq --filter "label=${LBL}"); do docker rm -f "$c" >/dev/null 2>&1; done
  docker rm -f "$DB" "$PROXY" "$PROXY_NOSYS" >/dev/null 2>&1
  for i in $(docker images -aq --filter "label=${LBL}" | sort -u); do docker image rm -f "$i" >/dev/null 2>&1; done
  for v in $(docker volume ls -q --filter "label=${LBL}"); do docker volume rm "$v" >/dev/null 2>&1; done
  docker network rm "$NET" >/dev/null 2>&1
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1; fi
}
trap cleanup EXIT

fail() { echo "FEHLER: $*" >&2; exit 1; }
psql() { docker exec -i "$DB" psql -U airlock -d airlock -tAq "$@"; }
has_image() { docker image inspect "$1" >/dev/null 2>&1; }
has_container() { docker container inspect "$1" >/dev/null 2>&1; }
cli() {
  local proxy="$1"; shift
  docker run --rm --network "$NET" -e DATABASE_URL="$URL" -e ADMIN_PASSWORD=x -e DATA_DIR=/tmp/data -e SITES_DIR=/tmp/sites \
    -e DOCKER_HOST="tcp://${proxy}:2375" "$IMAGE" node dist/cli.js "$@"
}
# Image mit Labels ohne Build (kein Build-Cache): Container anlegen, mit Labels committen
mkimage() {
  local tag="$1"; shift
  local c changes=()
  c="$(docker create --label "$LBL" "$BASE" true)"
  for l in "$LBL" "$@"; do changes+=(--change "LABEL ${l}"); done
  docker commit "${changes[@]}" "$c" "$tag" >/dev/null
  docker rm "$c" >/dev/null
  docker image inspect -f '{{.Id}}' "$tag"
}

command -v docker >/dev/null || fail "docker fehlt"
grep -q '^      SYSTEM: 1' "$ROOT/compose.yaml" || fail "compose.yaml: socket-proxy braucht SYSTEM: 1"
has_image "$BASE" || fail "$BASE fehlt (kommt mit compose.yaml; sonst: docker pull $BASE)"

echo "Lauf ${RAND}: nur Objekte mit Label ${LBL}"
echo "1. Airlock-Image bauen (dauert ein paar Minuten)"
if [ -n "${SMOKE_IMAGE:-}" ] && has_image "$IMAGE"; then echo "   (vorhandenes $IMAGE)"; else docker build -q -t "$IMAGE" "$ROOT" >/dev/null; fi
docker run --rm "$IMAGE" node dist/cli.js help | grep -q 'cleanup --apply' || fail "Hilfe nennt cleanup nicht"

echo "2. Netz, Wegwerf-Datenbank, Socket-Proxy wie compose.yaml"
docker network create --label "$LBL" "$NET" >/dev/null
docker run -d --name "$DB" --label "$LBL" --network "$NET" -e POSTGRES_USER=airlock -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=airlock "$BASE" >/dev/null
proxy_env=(-e CONTAINERS=1 -e IMAGES=1 -e NETWORKS=1 -e VOLUMES=1 -e INFO=1 -e VERSION=1 -e POST=1 -e BUILD=1 -e EXEC=0)
docker run -d --name "$PROXY" --label "$LBL" --network "$NET" "${proxy_env[@]}" -e SYSTEM=1 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro tecnativa/docker-socket-proxy:0.3.0 >/dev/null
docker run -d --name "$PROXY_NOSYS" --label "$LBL" --network "$NET" "${proxy_env[@]}" -e SYSTEM=0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro tecnativa/docker-socket-proxy:0.3.0 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 || fail "Datenbank startet nicht"
sleep 2

echo "3. Test-Objekte anlegen"
GONE="${P}-gone"
LIVE="${P}-live"
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z'; }
D_ACTIVE="$(uuid)"
D_OLD="$(uuid)"
D_GONE="$(uuid)"
P_ID="$(uuid)"
mkimage "airlock/${GONE}:a1" airlock.managed=true "airlock.project=${GONE}" "airlock.deployment=${D_GONE}" >/dev/null
ID_ACTIVE="$(mkimage "airlock/${LIVE}:b1" airlock.managed=true "airlock.project=${LIVE}" "airlock.deployment=${D_ACTIVE}")"
mkimage "airlock/${LIVE}:old" airlock.managed=true "airlock.project=${LIVE}" "airlock.deployment=${D_OLD}" >/dev/null
mkimage "${P}-fremd:c1" >/dev/null
# dangling: zweimal derselbe Tag, das erste Image verliert ihn
ID_DANGLING="$(mkimage "airlock/${GONE}:d1" airlock.managed=true "airlock.project=${GONE}" smoke.n=1)"
mkimage "airlock/${GONE}:d1" airlock.managed=true "airlock.project=${GONE}" smoke.n=2 >/dev/null
ID_USED="$(mkimage "airlock/${GONE}:e1" airlock.managed=true "airlock.project=${GONE}")"
docker run -d --name "${P}-benutzt" --label "$LBL" --entrypoint sleep "airlock/${GONE}:e1" 600 >/dev/null
docker create --name "${P}-build" --label "$LBL" --label airlock.managed=true --label "airlock.project=${GONE}" --label airlock.role=build "$BASE" true >/dev/null
docker create --name "${P}-gestoppt" --label "$LBL" --label airlock.managed=true --label "airlock.project=${LIVE}" "$BASE" true >/dev/null
docker volume create --label "$LBL" --label "com.docker.compose.project=air_${GONE}" --label com.docker.compose.volume=data "air_${GONE}_data" >/dev/null

echo "4. Datenbank: Projekt ${LIVE} mit aktiver Fassung und 7 abgelösten (Grenze 5)"
cli "$PROXY" cleanup --only-label "$LBL" --min-age-minutes 0 >/dev/null # führt die Migrationen aus
psql <<SQL
INSERT INTO projects (id, name, slug, source_type, environment_id)
  SELECT '${P_ID}', '${LIVE}', '${LIVE}', 'image', id FROM environments LIMIT 1;
INSERT INTO deployments (id, project_id, status, is_active, image_ref, started_at)
  VALUES ('${D_ACTIVE}', '${P_ID}', 'active', true, 'airlock/${LIVE}:b1', now());
INSERT INTO deployments (id, project_id, status, is_active, image_ref, started_at)
  VALUES ('${D_OLD}', '${P_ID}', 'superseded', false, 'airlock/${LIVE}:old', now() - interval '30 days');
INSERT INTO deployments (project_id, status, is_active, started_at)
  SELECT '${P_ID}', 'superseded', false, now() - (n || ' days')::interval FROM generate_series(1, 6) AS n;
SQL
[ "$(psql -c "SELECT count(*) FROM deployments")" = 8 ] || fail "Fassungen nicht angelegt"

echo "5. Vorschau (löscht nichts)"
out="$(cli "$PROXY" cleanup --only-label "$LBL" --min-age-minutes 0)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q "airlock/${GONE}:a1" || fail "Vorschau: Image des gelöschten Projekts fehlt"
echo "$out" | grep -q "Ohne Tag (dangling)" || fail "Vorschau: dangling Image fehlt"
echo "$out" | grep -q "airlock/${LIVE}:old" || fail "Vorschau: Image über der Grenze fehlt"
echo "$out" | grep -q "${P}-build" || fail "Vorschau: gestoppter Build-Container fehlt"
echo "$out" | grep -q "air_${GONE}_data" || fail "Vorschau: verwaistes Volume nicht aufgelistet"
for keep in "airlock/${LIVE}:b1" "${P}-fremd" "airlock/${GONE}:e1" "${P}-gestoppt" "${P}-benutzt"; do
  if echo "$out" | grep -E "^  (image|container) " | grep -q -- "$keep"; then fail "Vorschau will ${keep} entfernen"; fi
done
has_image "airlock/${GONE}:a1" && has_container "${P}-build" || fail "Vorschau hat gelöscht"
[ "$(psql -c "SELECT count(*) FROM deployments")" = 8 ] || fail "Vorschau hat Fassungen gelöscht"

echo "6. Aufräumen (--apply)"
out="$(cli "$PROXY" cleanup --apply --only-label "$LBL" --min-age-minutes 0)"
echo "$out" | sed 's/^/   /'
! has_image "airlock/${GONE}:a1" || fail "Image des gelöschten Projekts ist noch da"
! has_image "$ID_DANGLING" || fail "dangling Image ist noch da"
! has_image "airlock/${LIVE}:old" || fail "Image über der Grenze ist noch da"
! has_container "${P}-build" || fail "gestoppter Build-Container ist noch da"
has_image "$ID_ACTIVE" || fail "AKTIVES Image wurde entfernt"
has_image "${P}-fremd:c1" || fail "FREMDES Image ohne Airlock-Label wurde entfernt"
has_image "$ID_USED" || fail "Image in Benutzung wurde entfernt"
has_container "${P}-benutzt" || fail "laufender Container wurde entfernt"
has_container "${P}-gestoppt" || fail "gestoppter Projekt-Container wurde entfernt"
docker volume inspect "air_${GONE}_data" >/dev/null 2>&1 || fail "VOLUME wurde entfernt (darf nie automatisch)"
has_image "$BASE" || fail "Basis-Image wurde entfernt"
[ "$(psql -c "SELECT count(*) FROM deployments")" = 6 ] || fail "Fassungen über der Grenze nicht aus der Liste (erwartet 6: aktiv + 5)"
[ "$(psql -c "SELECT count(*) FROM deployments WHERE id = '${D_ACTIVE}'")" = 1 ] || fail "aktive Fassung fehlt"
[ "$(psql -c "SELECT count(*) FROM audit_events WHERE action = 'storage.cleanup' AND actor = 'cli'")" -ge 1 ] || fail "kein Audit-Eintrag"

echo "7. Zweiter Lauf: nichts mehr zu tun"
out="$(cli "$PROXY" cleanup --only-label "$LBL" --min-age-minutes 0)"
echo "$out" | grep -q "^Posten: 0" || { echo "$out"; fail "zweiter Lauf findet noch etwas"; }

echo "8. Socket-Proxy ohne SYSTEM: klare Meldung"
set +e
msg="$(cli "$PROXY_NOSYS" cleanup --only-label "$LBL" --min-age-minutes 0 2>&1)"
set -e
echo "$msg" | grep -q "SYSTEM: 1" || { echo "$msg"; fail "keine Meldung zu SYSTEM: 1"; }

echo "OK: Aufräumen entfernt nur Airlock-Objekte über der Grenze; aktives, benutztes und fremdes Image, Projekt-Container und Volume bleiben."
