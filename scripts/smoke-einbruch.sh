#!/usr/bin/env bash
# Smoke-Test «Einbruchserkennung» (Nacht 3, Etappe 5) gegen echtes Docker.
#
# Baut das Airlock-Image aus diesem Checkout und lässt darin genau die
# Erkennung von Airlock laufen (node dist/cli.js intrusion-check), über einen
# eigenen Socket-Proxy mit den Rechten aus compose.yaml (CONTAINERS an, EXEC
# aus) und mit einer Wegwerf-Datenbank.
#
#   scripts/smoke-einbruch.sh
#
# Ablauf: Ein Test-Container (Projekt-Labels wie ein Deploy) lernt seine
# Grundlinie (nur «sleep»). Danach startet darin eine Shell und schreibt eine
# Datei ins Webroot (/usr/share/nginx/html) – beide Vorfälle müssen
# erscheinen: «Shell gestartet: sh» (hoch) und «Dateien im Webroot geändert»
# (hoch). Dazu: vorher kein Fehlalarm, Bündeln (Zähler statt neuer Vorfälle),
# und der Notausgang «release-isolation» stellt die Restart-Policy zurück.
#
# Sicherheit: Jeder Test-Container trägt das Label airlock.smoke=<zufall>, die
# CLI läuft mit --only-label airlock.smoke=<zufall> (sieht nur diese Container,
# keine Anmeldung, keine Benachrichtigung). Die laufende Installation wird
# nicht berührt (eigene Datenbank, eigener Proxy, eigenes Netz). Am Ende wird
# alles mit diesem Label entfernt. Braucht nur bash und docker (Basis-Image
# postgres:17-alpine wie compose.yaml); liest keine .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAND="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)"
[ -n "$RAND" ] || RAND="$$$(date +%s)"
LBL="airlock.smoke=${RAND}"
SLUG="smk${RAND}"
# Wiederholen ohne neuen Build: KEEP_IMAGE=1 SMOKE_IMAGE=airlock-smoke-einbruch:test (einmal gebaut)
IMAGE="${SMOKE_IMAGE:-airlock-smoke-einbruch:${RAND}}"
NET="airlock_smoke_einb_${RAND}"
DB="airlock-smoke-einb-db-${RAND}"
PROXY="airlock-smoke-einb-proxy-${RAND}"
WEB="airlock-smoke-einb-web-${RAND}"
BASE=postgres:17-alpine
PW=smoke-only-not-secret # allowlist-secret (Wegwerf-Datenbank)
URL="postgres://airlock:${PW}@${DB}:5432/airlock" # allowlist-secret (Wegwerf-Datenbank)

cleanup() {
  set +e
  for c in $(docker ps -aq --filter "label=${LBL}"); do docker rm -f "$c" >/dev/null 2>&1; done
  docker rm -f "$DB" "$PROXY" "$WEB" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1; fi
}
trap cleanup EXIT

fail() { echo "FEHLER: $*" >&2; exit 1; }
psql() { docker exec -i "$DB" psql -U airlock -d airlock -tAq "$@"; }
has_image() { docker image inspect "$1" >/dev/null 2>&1; }
cli() {
  docker run --rm --network "$NET" -e DATABASE_URL="$URL" -e ADMIN_PASSWORD=x -e DATA_DIR=/tmp/data -e SITES_DIR=/tmp/sites \
    -e FIREWALL_DIR=/tmp/firewall -e DOCKER_HOST="tcp://${PROXY}:2375" "$IMAGE" node dist/cli.js "$@" 2>&1 | grep -v '^{"level"'
}
check() { cli intrusion-check --only-label "$LBL" "$@"; }

command -v docker >/dev/null || fail "docker fehlt"
grep -q '^      CONTAINERS: 1' "$ROOT/compose.yaml" || fail "compose.yaml: socket-proxy braucht CONTAINERS: 1"
grep -q '^      EXEC: 0' "$ROOT/compose.yaml" || fail "compose.yaml: EXEC muss aus bleiben"
has_image "$BASE" || fail "$BASE fehlt (kommt mit compose.yaml; sonst: docker pull $BASE)"

echo "Lauf ${RAND}: nur Container mit Label ${LBL}"
echo "1. Airlock-Image bauen (dauert ein paar Minuten)"
if [ -n "${SMOKE_IMAGE:-}" ] && has_image "$IMAGE"; then echo "   (vorhandenes $IMAGE)"; else docker build -q -t "$IMAGE" "$ROOT" >/dev/null; fi
help_text="$(docker run --rm "$IMAGE" node dist/cli.js help)"
grep -q 'intrusion-check' <<<"$help_text" || fail "Hilfe nennt intrusion-check nicht"
grep -q 'release-isolation' <<<"$help_text" || fail "Hilfe nennt release-isolation nicht"

echo "2. Netz, Wegwerf-Datenbank, Socket-Proxy wie compose.yaml (EXEC aus)"
docker network create --label "$LBL" --label homebento.ignore=true "$NET" >/dev/null
docker run -d --name "$DB" --label "$LBL" --label homebento.ignore=true --network "$NET" -e POSTGRES_USER=airlock -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=airlock "$BASE" >/dev/null
docker run -d --name "$PROXY" --label "$LBL" --label homebento.ignore=true --network "$NET" \
  -e CONTAINERS=1 -e IMAGES=1 -e NETWORKS=1 -e VOLUMES=1 -e INFO=1 -e VERSION=1 -e POST=1 -e BUILD=1 -e SYSTEM=1 -e EXEC=0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro tecnativa/docker-socket-proxy:0.3.0 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 || fail "Datenbank startet nicht"
sleep 2

echo "3. Datenbank (Migrationen) und Projekt ${SLUG}"
check >/dev/null # führt die Migrationen aus
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z'; }
P_ID="$(uuid)"
D_ID="$(uuid)"
psql -c "INSERT INTO projects (id, name, slug, source_type, environment_id) SELECT '${P_ID}', 'Smoke ${RAND}', '${SLUG}', 'image', id FROM environments LIMIT 1;"
[ "$(psql -c "SELECT count(*) FROM projects WHERE id = '${P_ID}'")" = 1 ] || fail "Projekt nicht angelegt"

echo "4. Test-Container mit Projekt-Labels (Grundlinie: nur «sleep»)"
docker run -d --name "$WEB" --label "$LBL" --label homebento.ignore=true --label airlock.managed=true --label "airlock.project=${SLUG}" \
  --label "airlock.deployment=${D_ID}" --restart unless-stopped --entrypoint sleep "$BASE" 3600 >/dev/null
sleep 1

echo "5. Erste Runde: Container lernt seine Grundlinie (10 Minuten)"
out="$(check)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q 'Container geprüft: 1 (davon lernen noch: 1)' || fail "Container lernt nicht"
echo "$out" | grep -q '^Hinweise: 0' || fail "Hinweise beim Lernen"

echo "6. Lernzeit vorbei, nichts passiert: kein Fehlalarm"
out="$(check --learn-minutes 0)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q 'davon lernen noch: 0' || fail "Lernzeit nicht vorbei"
echo "$out" | grep -q '^Hinweise: 0' || fail "Fehlalarm ohne Einbruch"

echo "7. Einbruch: Shell im Container schreibt eine Datei ins Webroot"
docker exec -d "$WEB" sh -c 'mkdir -p /usr/share/nginx/html && echo "<?php system(\$_GET[1]);" > /usr/share/nginx/html/shell.php; sleep 300; true'
sleep 2
out="$(check --learn-minutes 0)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -Eq 'hoch +prozess_verdaechtig .*Shell gestartet: sh' || fail "Shell nicht erkannt"
echo "$out" | grep -Eq 'hoch +datei_webroot .*Dateien im Webroot geändert' || fail "Datei im Webroot nicht erkannt"
echo "$out" | grep -q '/usr/share/nginx/html/shell.php (neu)' || fail "Pfad fehlt"
echo "$out" | grep -q '^Vorfälle: 2 neu' || fail "nicht genau zwei neue Vorfälle"
[ "$(psql -c "SELECT count(*) FROM incidents WHERE project_id = '${P_ID}' AND status = 'offen'")" = 2 ] || fail "nicht genau zwei offene Vorfälle in der Datenbank"
[ "$(psql -c "SELECT count(*) FROM incident_events e JOIN incidents i ON i.id = e.incident_id WHERE i.project_id = '${P_ID}' AND e.kind = 'erkannt'")" = 2 ] || fail "Verlauf «erkannt» fehlt"

echo "8. Nächste Runde: schon gemeldet, nichts Neues"
out="$(check --learn-minutes 0)"
echo "$out" | grep -q '^Hinweise: 0' || { echo "$out"; fail "derselbe Einbruch wird erneut gezählt"; }

echo "9. Zweite Shell: gebündelt (Zähler 2, kein neuer Vorfall)"
docker exec -d "$WEB" sh -c 'sleep 200; true'
sleep 2
out="$(check --learn-minutes 0)"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q '^Vorfälle: 0 neu, 1 gebündelt' || fail "nicht gebündelt"
[ "$(psql -c "SELECT count FROM incidents WHERE project_id = '${P_ID}' AND kind = 'prozess_verdaechtig'")" = 2 ] || fail "Zähler der Shell nicht 2"
[ "$(psql -c "SELECT count(*) FROM incidents WHERE project_id = '${P_ID}'")" = 2 ] || fail "zusätzlicher Vorfall statt Bündelung"

echo "10. Notausgang: Isolation per Kommandozeile aufheben (Restart-Policy zurück)"
CID="$(docker inspect -f '{{.Id}}' "$WEB")"
docker update --restart no "$WEB" >/dev/null
psql -c "UPDATE projects SET isolated_at = now(), isolated_by = 'smoke', isolation = '{\"egress\":{\"mode\":\"internet\",\"enforce\":true},\"restartPolicies\":{\"${CID}\":\"unless-stopped\"}}' WHERE id = '${P_ID}';"
out="$(cli release-isolation "$SLUG")"
echo "$out" | sed 's/^/   /'
echo "$out" | grep -q 'Restart-Policy zurückgestellt: 1 Container' || fail "Restart-Policy nicht zurückgestellt"
[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$WEB")" = unless-stopped ] || fail "Restart-Policy ist nicht wieder unless-stopped"
[ "$(psql -c "SELECT count(*) FROM projects WHERE id = '${P_ID}' AND isolated_at IS NULL")" = 1 ] || fail "Projekt ist noch isoliert"
[ "$(psql -c "SELECT count(*) FROM audit_events WHERE action = 'project.isolate.release' AND actor = 'cli'")" -ge 1 ] || fail "kein Audit-Eintrag"

echo "OK: Shell und Datei im Webroot erkannt (je ein Vorfall, hoch), kein Fehlalarm vorher, Wiederholung gebündelt, Notausgang hebt die Isolation auf."
