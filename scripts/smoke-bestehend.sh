#!/usr/bin/env bash
# Smoke-Test «Bestehender Dienst» gegen echtes Docker.
#
# Startet ein vollständiges, abgeschottetes Airlock (eigene Datenbank, eigener
# Socket-Proxy mit den Rechten aus compose.yaml, eigener Caddy mit dem Image
# airlock/caddy-cloudflare:local) und einen fremden Testcontainer «whoami» in
# einem eigenen Netz – ohne Labels von Airlock, wie ein Dienst, den jemand
# selbst gestartet hat.
#
#   scripts/smoke-bestehend.sh
#
# Ablauf:
#   1. whoami als bestehenden Dienst anlegen (Container + Port 80, LAN)
#      → Airlock hängt Caddy in das Netz von whoami, nichts an whoami selbst
#   2. über Caddy intern erreichbar (200, Antwort von whoami)
#   3. Zugang «Airlock-Login» → ohne Anmeldung 302 auf /api/v1/gate/start
#   4. mit Anmeldung: Code über die Oberfläche → Rückruf /.airlock/gate setzt
#      den Cookie für genau diesen Host → 200; whoami sieht den Cookie NICHT
#   5. whoami hat danach keine Labels von Airlock und hängt nur in seinem Netz
#
# Sicherheit: Alles trägt das Label airlock.smoke=<zufall> bzw. (whoami, damit
# Airlock es nicht als eigenen Container ausblendet) smoke.bestehend=<zufall>
# und wird am Ende entfernt. Die laufende Installation wird nicht berührt.
# Braucht bash, docker, curl und python3. Der erste Scan ist aus
# (SCAN_AFTER_DEPLOY=off), sonst zöge er ZAP und Nuclei.
#
# Wiederholen ohne neuen Build: KEEP_IMAGE=1 SMOKE_IMAGE=airlock-smoke-bestehend:test

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAND="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)"
[ -n "$RAND" ] || RAND="$$$(date +%s)"
LBL="airlock.smoke=${RAND}"
WLBL="smoke.bestehend=${RAND}"
IMAGE="${SMOKE_IMAGE:-airlock-smoke-bestehend:${RAND}}"
CADDY_IMAGE="${SMOKE_CADDY_IMAGE:-airlock/caddy-cloudflare:local}"
NET="airlock_smoke_best_${RAND}"
WNET="smoke_whoami_${RAND}"
DB="airlock-smoke-best-db-${RAND}"
PROXY="airlock-smoke-best-proxy-${RAND}"
CADDY="airlock-smoke-best-caddy-${RAND}"
APP="airlock-smoke-best-app-${RAND}"
WHOAMI="smoke-whoami-${RAND}"
VOL_ADMIN="airlock_smoke_best_admin_${RAND}"
PW=smoke-only-not-secret # allowlist-secret (Wegwerf-Datenbank)
ADMIN_PW=smoke-admin-only-not-secret # allowlist-secret (Wegwerf-Anmeldung)
URL="postgres://airlock:${PW}@${DB}:5432/airlock" # allowlist-secret (Wegwerf-Datenbank)
LAN_IP=192.168.77.20
JAR="$(mktemp)"

cleanup() {
  set +e
  docker logs "$APP" >"${SMOKE_LOG:-/dev/null}" 2>&1
  for c in $(docker ps -aq --filter "label=${LBL}") $(docker ps -aq --filter "label=${WLBL}"); do docker rm -f "$c" >/dev/null 2>&1; done
  # Was Airlock selbst angelegt hat (Projekt-Netz air_<slug>, falls ein Scan lief)
  for n in $(docker network ls -q --filter "name=air_smoke-whoami"); do docker network rm "$n" >/dev/null 2>&1; done
  docker network rm "$NET" "$WNET" >/dev/null 2>&1
  docker volume rm "$VOL_ADMIN" >/dev/null 2>&1
  rm -f "$JAR"
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1; fi
}
trap cleanup EXIT

fail() { echo "FEHLER: $*" >&2; [ -n "${SMOKE_DEBUG:-}" ] && docker logs --tail 80 "$APP" >&2; exit 1; }
ok() { echo "ok: $*"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

command -v docker >/dev/null || fail "docker fehlt"
command -v curl >/dev/null || fail "curl fehlt"
command -v python3 >/dev/null || fail "python3 fehlt"
docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1 || fail "Caddy-Image $CADDY_IMAGE fehlt (docker compose build caddy)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Baue $IMAGE …"
  docker build -q -t "$IMAGE" --label "$LBL" "$ROOT" >/dev/null || fail "Build gescheitert"
fi

docker network create --label "$LBL" "$NET" >/dev/null
docker network create --label "$WLBL" "$WNET" >/dev/null
docker volume create --label "$LBL" "$VOL_ADMIN" >/dev/null

# Der fremde Dienst: eigenes Netz, keine Labels von Airlock
docker run -d --name "$WHOAMI" --label "$WLBL" --network "$WNET" traefik/whoami:latest >/dev/null

docker run -d --name "$DB" --label "$LBL" --label homebento.ignore=true --network "$NET" \
  -e POSTGRES_USER=airlock -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=airlock postgres:17-alpine >/dev/null
docker run -d --name "$PROXY" --label "$LBL" --label homebento.ignore=true --network "$NET" \
  -e CONTAINERS=1 -e IMAGES=1 -e NETWORKS=1 -e VOLUMES=1 -e INFO=1 -e VERSION=1 -e POST=1 -e BUILD=1 -e SYSTEM=1 -e EXEC=0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro tecnativa/docker-socket-proxy:0.3.0 >/dev/null
docker run -d --name "$CADDY" --label "$LBL" --label homebento.ignore=true --network "$NET" -p 127.0.0.1::80 \
  -v "$ROOT/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$VOL_ADMIN:/run/caddy" \
  "$CADDY_IMAGE" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

for _ in $(seq 1 60); do docker exec "$DB" pg_isready -U airlock -d airlock >/dev/null 2>&1 && break; sleep 0.5; done

docker run -d --name "$APP" --label "$LBL" --label homebento.ignore=true --network "$NET" -p 127.0.0.1::3000 \
  -v "$VOL_ADMIN:/run/caddy" \
  -e NODE_ENV=production -e DATABASE_URL="$URL" -e ADMIN_PASSWORD="$ADMIN_PW" -e SESSION_SECRET="smoke-secret-${RAND}-not-secret" \
  -e DOCKER_HOST="tcp://${PROXY}:2375" -e CADDY_ADMIN_SOCKET=/run/caddy/admin.sock -e CADDY_PROBE_SOCKET= \
  -e AIRLOCK_CONTAINER="$APP" -e CADDY_CONTAINER="$CADDY" -e AIRLOCK_UPSTREAM="${APP}:3000" \
  -e SERVER_LAN_IP="$LAN_IP" -e LAN_CIDR=192.168.77.0/24 -e CADDY_IP_FILTER=off -e NIPIO_FALLBACK=on \
  -e SCAN_AFTER_DEPLOY=off -e DATA_DIR=/tmp/data -e SITES_DIR=/tmp/sites -e STATUS_DIR= -e FIREWALL_DIR=/tmp/firewall \
  -e BACKUP_JOBS_DIR=/tmp/backup-jobs -e ACCESS_LOG_DIR=/tmp/access -e CADDY_DATA_DIR=/tmp/caddy-data \
  "$IMAGE" >/dev/null

APORT="$(docker port "$APP" 3000/tcp | head -1 | sed 's/.*://')"
CPORT="$(docker port "$CADDY" 80/tcp | head -1 | sed 's/.*://')"
API="http://127.0.0.1:${APORT}/api/v1"
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:${APORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:${APORT}/health" >/dev/null || fail "Airlock startet nicht"
ok "Airlock läuft (API :$APORT, Caddy :$CPORT)"

# Anmelden (Sitzungs-Cookie der Oberfläche)
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'content-type: application/json' -d "{\"password\":\"${ADMIN_PW}\"}" "$API/auth/login")"
[ "$code" = 200 ] || fail "Anmeldung: HTTP $code"

# Die Liste bietet whoami an, aber keinen Container von Airlock
list="$(curl -s -b "$JAR" "$API/external/containers")"
echo "$list" | json "[c['name'] for c in d['containers']]" | grep -q "$WHOAMI" || fail "whoami fehlt in der Liste: $list"
echo "$list" | json "[c['name'] for c in d['containers']]" | grep -qE "$APP|$CADDY|$DB" && fail "Airlocks eigene Container in der Liste"
ok "Liste: whoami angeboten, Airlocks eigene nicht"

# Erreichbarkeit vor dem Anlegen
probe="$(curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"container\":\"${WHOAMI}\",\"port\":80}" "$API/external/probe")"
[ "$(echo "$probe" | json "d['probe']['ok']")" = True ] || fail "Prüfung vor dem Anlegen: $probe"
ok "Prüfung vor dem Anlegen: $(echo "$probe" | json "d['probe']['detail']")"

# 1. Anlegen
created="$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d "{\"name\":\"smoke-whoami\",\"source\":{\"type\":\"external\",\"container\":\"${WHOAMI}\",\"port\":80},\"targets\":[\"lan\"],\"deploy\":false}" "$API/projects")"
ID="$(echo "$created" | json "d['project']['id']")" || fail "Anlegen: $created"
HOST="$(echo "$created" | json "[u for r in d['project']['routes'] for u in r['urls']][0].split('://')[1]")"
[ "$(echo "$created" | json "d['project']['sourceType']")" = external ] || fail "Art: $created"
ok "angelegt: $ID unter $HOST"

# 2. intern erreichbar über Caddy
for _ in $(seq 1 30); do
  body="$(curl -s -H "Host: ${HOST}" "http://127.0.0.1:${CPORT}/" || true)"
  echo "$body" | grep -q "Hostname:" && break
  sleep 0.5
done
echo "$body" | grep -q "Hostname:" || fail "über Caddy nicht erreichbar: $body"
docker inspect -f '{{json .NetworkSettings.Networks}}' "$CADDY" | grep -q "$WNET" || fail "Caddy hängt nicht im Netz von whoami"
ok "intern erreichbar (Caddy im Netz $WNET)"

# Kein Deploy, kein Neustart
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$API/projects/$ID/deploy")"
[ "$code" = 409 ] || fail "Deploy sollte 409 sein, war $code"
ok "Deploy abgelehnt (409, nicht verwaltet)"

# 3. Airlock-Login vorschalten → ohne Anmeldung 302 zur Anmeldung
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT -H 'content-type: application/json' -d '{"guard":"login"}' "$API/projects/$ID/access")"
[ "$code" = 200 ] || fail "Zugang setzen: HTTP $code"
sleep 1
read -r code loc < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Host: ${HOST}" "http://127.0.0.1:${CPORT}/seite?x=1")
[ "$code" = 302 ] || fail "ohne Anmeldung: HTTP $code statt 302"
echo "$loc" | grep -q "/api/v1/gate/start?host=${HOST}" || fail "Weiterleitung: $loc"
ok "ohne Anmeldung: 302 → $(echo "$loc" | sed 's/?.*//')"

# 4. Anmeldung durchlaufen: Oberfläche (über Caddy, Name der Oberfläche) → Rückruf am Projekt-Host → Cookie
UIHOST="$(echo "$loc" | sed -E 's#^https?://([^/]+)/.*#\1#')"
START="$(echo "$loc" | sed -E 's#^https?://[^/]+##')"
# Mit eigenem Host-Header ordnet curl Cookies diesem Host zu – den Sitzungs-Cookie deshalb ausdrücklich mitgeben
SESSION="$(awk '$6 == "airlock_session" { print $6 "=" $7 }' "$JAR" | tail -1)"
[ -n "$SESSION" ] || fail "kein Sitzungs-Cookie nach der Anmeldung"
read -r code cb < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Cookie: ${SESSION}" -H "Host: ${UIHOST}" "http://127.0.0.1:${CPORT}${START}")
[ "$code" = 302 ] || fail "gate/start: HTTP $code"
echo "$cb" | grep -q "/.airlock/gate?code=" || fail "Rückruf-Adresse: $cb"
CBPATH="$(echo "$cb" | sed -E 's#^https?://[^/]+##')"
hdrs="$(curl -s -D - -o /dev/null -H "Host: ${HOST}" "http://127.0.0.1:${CPORT}${CBPATH}")"
GATE="$(echo "$hdrs" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(airlock_gate=[^;]*\).*/\1/p')"
[ -n "$GATE" ] || fail "kein Cookie aus dem Rückruf: $hdrs"
echo "$hdrs" | grep -qi "domain=" && fail "Cookie mit Domain-Attribut (soll nur für den Host gelten)"
body="$(curl -s -H "Host: ${HOST}" -H "Cookie: andere=1; ${GATE}" "http://127.0.0.1:${CPORT}/")"
echo "$body" | grep -q "Hostname:" || fail "mit Anmeldung nicht durchgelassen: $body"
echo "$body" | grep -q "airlock_gate" && fail "whoami hat den Login-Cookie gesehen"
echo "$body" | grep -q "andere=1" || fail "andere Cookies sollten durchgehen: $body"
ok "mit Anmeldung: 200; whoami sieht den Login-Cookie nicht"

# Falscher Host: Cookie gilt nicht für einen anderen Namen
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${HOST}" -H "Cookie: ${GATE}x" "http://127.0.0.1:${CPORT}/")"
[ "$code" = 302 ] || fail "verändertes Cookie: HTTP $code statt 302"
ok "verändertes Cookie: 302"

# 5. Airlock hat whoami nicht angefasst
labels="$(docker inspect -f '{{json .Config.Labels}}' "$WHOAMI")"
echo "$labels" | grep -qE 'airlock\.|homebento\.' && fail "Labels an whoami: $labels"
nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$WHOAMI")"
[ "$(echo $nets)" = "$WNET" ] || fail "whoami in fremden Netzen: $nets"
ok "whoami unverändert (keine Labels, nur sein Netz)"

# Entfernen: Caddy verlässt das Netz wieder, whoami läuft weiter
curl -s -o /dev/null -b "$JAR" -X POST "$API/auth/sudo" -H 'content-type: application/json' -d "{\"password\":\"${ADMIN_PW}\"}"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$API/projects/$ID")"
[ "$code" = 204 ] || fail "Löschen: HTTP $code"
sleep 1
docker inspect -f '{{json .NetworkSettings.Networks}}' "$CADDY" | grep -q "$WNET" && fail "Caddy hängt nach dem Löschen noch im Netz von whoami"
[ "$(docker inspect -f '{{.State.Running}}' "$WHOAMI")" = true ] || fail "whoami läuft nicht mehr"
ok "gelöscht: Caddy aus $WNET getrennt, whoami läuft weiter"

echo "Smoke-Test «Bestehender Dienst»: alles grün"
