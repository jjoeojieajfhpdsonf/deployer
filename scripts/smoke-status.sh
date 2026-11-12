#!/usr/bin/env bash
# Smoke-Test für den Dienst «status» (airlock-status, Statusseite).
#
# Startet den Dienst genau so, wie er in compose.yaml steht – Image, Befehl,
# Benutzer, read_only, cap_drop/cap_add, no-new-privileges, tmpfs, Grenzen –,
# ruft eine Datei per wget ab und räumt danach alles wieder ab. Geändert wird
# nur, was den echten Betrieb nicht berühren darf: Container-Name, Netz und
# Volume sind eigene (airlock-smoke-status, airlock_smoke_status,
# airlock_smoke_status_site). Die laufende Installation bleibt unangetastet.
#
#   scripts/smoke-status.sh
#
# Wann: nach jeder Änderung am Dienst «status» in compose.yaml und nach einem
# Wechsel des Caddy-Images (Tag), vor `docker compose up -d` auf dem Server.
# Hätte den Startfehler «exec /usr/bin/caddy: operation not permitted»
# (cap_drop: ALL ohne NET_BIND_SERVICE) gefangen.
#
# Braucht nur docker mit Compose v2.24 oder neuer (für «!override» in der
# Zusatzdatei). Liest keine .env: die Pflichtvariablen der übrigen Dienste
# bekommen Platzhalter; gestartet werden sie nicht, und die erzeugte Datei
# enthält nur die beiden Smoke-Dienste mit eigenem Netz und Volume.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=airlock-smoke-status
CONTAINER=airlock-smoke-status
NET=airlock_smoke_status
VOLUME=airlock_smoke_status_site
TMP="$(mktemp -d)"
OVERRIDE="$TMP/override.yaml"
SMOKE="$TMP/compose.smoke.yaml"
export SMOKE_MARK="airlock-smoke-$(date +%s)-$$"

compose() { docker compose -p "$PROJECT" -f "$SMOKE" "$@"; }

cleanup() {
  # Nur die eigenen Namen; die erzeugte Datei kennt nichts von der echten Installation
  [ -f "$SMOKE" ] && compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $*" >&2
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/  /' >&2 || true
  exit 1
}

command -v docker >/dev/null || fail "docker fehlt"
docker compose version >/dev/null 2>&1 || fail "docker compose (v2) fehlt"

# 1. Zusatzdatei: eigene Namen für Container, Netz und Volume; ein Einmal-Dienst
#    legt eine Datei ins Volume (wie Airlock es tut). Alles andere am Dienst
#    «status» kommt unverändert aus compose.yaml.
cat > "$OVERRIDE" <<'EOF'
services:
  seed:
    image: busybox:1.37
    command: ["sh", "-c", "mkdir -p /site/smoke && printf '%s' \"$$SMOKE_MARK\" > /site/smoke/index.html"]
    environment:
      SMOKE_MARK: ${SMOKE_MARK}
    volumes: ["smoke_site:/site"]
    network_mode: none
    restart: "no"
  status:
    container_name: airlock-smoke-status
    networks: !override [smoke]
    volumes: !override ["smoke_site:/srv/status:ro"]
    depends_on:
      seed:
        condition: service_completed_successfully
networks:
  smoke:
    name: airlock_smoke_status
    internal: true
volumes:
  smoke_site:
    name: airlock_smoke_status_site
EOF

# 2. Zusammengeführt und auf die beiden Dienste beschränkt (nur ihr Netz und Volume)
POSTGRES_PASSWORD=smoke ADMIN_PASSWORD=smoke \
  docker compose -p "$PROJECT" -f "$ROOT/compose.yaml" -f "$OVERRIDE" --env-file /dev/null config seed status > "$SMOKE" \
  || fail "docker compose config scheiterte (Compose v2.24 oder neuer nötig: docker compose version)"
grep -q 'airlock_smoke_status' "$SMOKE" || fail "erzeugte Datei ohne eigenes Netz – abgebrochen"
if grep -Eq 'name: airlock_(status|pgdata|data)$' "$SMOKE"; then fail "erzeugte Datei enthält Namen der echten Installation – abgebrochen"; fi

# 3. Starten und warten, bis er läuft (ein Startfehler zeigt sich als exited/restarting)
compose up -d --quiet-pull status >/dev/null 2>&1 || fail "docker compose up scheiterte"
state=""
for _ in $(seq 1 20); do
  state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
  [ "$state" = running ] && break
  if [ "$state" = exited ] || [ "$state" = restarting ]; then fail "Container startet nicht (Zustand: $state)"; fi
  sleep 0.5
done
[ "$state" = running ] || fail "Container läuft nach 10 s nicht (Zustand: ${state:-unbekannt})"
sleep 1
state="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$CONTAINER")"
[ "$state" = "running 0" ] || fail "Container ist nicht stabil (Zustand, Neustarts: $state)"

# 4. Härtung am laufenden Container prüfen (nicht nur in der Datei)
inspect() { docker inspect -f "$1" "$CONTAINER"; }
[ "$(inspect '{{.Config.User}}')" = "65534:65534" ] || fail "läuft nicht als nobody (65534)"
[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "Dateisystem nicht nur lesend"
[ "$(inspect '{{json .HostConfig.CapDrop}}')" = '["ALL"]' ] || fail "cap_drop ist nicht [ALL]"
case "$(inspect '{{json .HostConfig.CapAdd}}')" in
  '["NET_BIND_SERVICE"]'|'["CAP_NET_BIND_SERVICE"]') ;;
  *) fail "cap_add ist nicht genau NET_BIND_SERVICE: $(inspect '{{json .HostConfig.CapAdd}}')" ;;
esac
inspect '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' || fail "no-new-privileges fehlt"

# 5. Datei abrufen (aus dem internen Netz, wie Caddy es tut); Port aus dem Befehl (--listen :8080)
port="$(inspect '{{json .Config.Cmd}}' | sed -n 's/.*"--listen","[^"]*:\([0-9][0-9]*\)".*/\1/p')"
port="${port:-80}"
body="$(docker run --rm --network "$NET" busybox:1.37 wget -qO- -T 5 "http://status:${port}/smoke/index.html" 2>&1)" \
  || fail "wget auf http://status:${port}/smoke/index.html scheiterte: $body"
[ "$body" = "$SMOKE_MARK" ] || fail "falscher Inhalt: «$body»"

echo "ok: airlock-status startet mit der Härtung aus compose.yaml und liefert Dateien aus (Port ${port})"
