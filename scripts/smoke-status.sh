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
# Braucht: docker mit Compose v2, node (für das Umschreiben der Konfiguration).
# Liest keine .env: die Pflichtvariablen der übrigen Dienste bekommen
# Platzhalter, sie werden nicht gestartet.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=airlock-smoke-status
NET=airlock_smoke_status
TMP="$(mktemp -d)"
SMOKE="$TMP/compose.smoke.json"
MARK="airlock-smoke-$(date +%s)-$$"

compose() { docker compose -p "$PROJECT" -f "$SMOKE" "$@"; }

cleanup() {
  [ -f "$SMOKE" ] && compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $*" >&2
  compose logs status 2>/dev/null | tail -20 >&2 || true
  exit 1
}

# 1. Dienst «status» aus compose.yaml, wie Compose ihn auflöst (Anker, Kurzformen)
POSTGRES_PASSWORD=smoke ADMIN_PASSWORD=smoke \
  docker compose -f "$ROOT/compose.yaml" --env-file /dev/null config --format json > "$TMP/full.json"

# 2. Eigene Namen für Container, Netz und Volume; alles andere bleibt, wie es ist.
#    Ein Einmal-Dienst legt eine Datei ins Volume (wie Airlock es tut).
node - "$TMP/full.json" "$SMOKE" "$MARK" "$NET" <<'EOF'
const fs = require('node:fs')
const [full, out, mark, net] = process.argv.slice(2)
const status = JSON.parse(fs.readFileSync(full, 'utf8')).services.status
if (!status) throw new Error('Dienst «status» fehlt in compose.yaml')
const smoke = {
  services: {
    seed: {
      image: 'busybox:1.37',
      command: ['sh', '-c', `mkdir -p /site/smoke && printf '%s' '${mark}' > /site/smoke/index.html`],
      volumes: [{ type: 'volume', source: 'site', target: '/site' }],
      network_mode: 'none',
      restart: 'no',
    },
    status: {
      ...status,
      container_name: 'airlock-smoke-status',
      networks: { smoke: {} },
      volumes: [{ type: 'volume', source: 'site', target: '/srv/status', read_only: true }],
      depends_on: { seed: { condition: 'service_completed_successfully' } },
    },
  },
  networks: { smoke: { name: net, internal: true } },
  volumes: { site: { name: `${net}_site` } },
}
fs.writeFileSync(out, JSON.stringify(smoke, null, 2))
EOF

# 3. Starten und warten, bis er läuft (ein Startfehler zeigt sich als exited/restarting)
compose up -d --quiet-pull status >/dev/null 2>&1 || fail "docker compose up scheiterte"
state=""
for _ in $(seq 1 20); do
  state="$(docker inspect -f '{{.State.Status}}' airlock-smoke-status 2>/dev/null || true)"
  [ "$state" = running ] && break
  [ "$state" = exited ] || [ "$state" = restarting ] && fail "Container startet nicht (Zustand: $state)"
  sleep 0.5
done
[ "$state" = running ] || fail "Container läuft nach 10 s nicht (Zustand: ${state:-unbekannt})"

# 4. Härtung am laufenden Container prüfen (nicht nur in der Datei)
inspect() { docker inspect -f "$1" airlock-smoke-status; }
[ "$(inspect '{{.Config.User}}')" = "65534:65534" ] || fail "läuft nicht als nobody (65534)"
[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "Dateisystem nicht nur lesend"
[ "$(inspect '{{json .HostConfig.CapDrop}}')" = '["ALL"]' ] || fail "cap_drop ist nicht [ALL]"
case "$(inspect '{{json .HostConfig.CapAdd}}')" in
  '["NET_BIND_SERVICE"]'|'["CAP_NET_BIND_SERVICE"]') ;;
  *) fail "cap_add ist nicht genau NET_BIND_SERVICE: $(inspect '{{json .HostConfig.CapAdd}}')" ;;
esac
inspect '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges:true' || fail "no-new-privileges fehlt"

# 5. Datei abrufen (aus dem internen Netz, wie Caddy es tut)
port="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).services.status.command; const i=c.indexOf("--listen"); console.log((c[i+1]||":80").split(":").pop())' "$SMOKE")"
body="$(docker run --rm --network "$NET" busybox:1.37 wget -qO- -T 5 "http://status:${port}/smoke/index.html" 2>&1)" \
  || fail "wget auf http://status:${port}/smoke/index.html scheiterte: $body"
[ "$body" = "$MARK" ] || fail "falscher Inhalt: «$body»"

echo "ok: airlock-status startet mit der Härtung aus compose.yaml und liefert Dateien aus (Port ${port})"
