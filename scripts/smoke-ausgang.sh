#!/usr/bin/env bash
# Smoke-Test «Container-Ausgang begrenzen» (Nacht 3, Etappe 4) gegen echtes
# Docker und den echten Kernel.
#
#   scripts/smoke-ausgang.sh
#
# Baut das Image des Firewall-Dienstes (firewall/) und startet ihn wie in
# compose.yaml (network_mode: host, nur NET_ADMIN, nur lesend), aber mit
# EIGENER Tabelle (inet airlock_smoke), eigenen NFLOG-Gruppen (7811/7812) und
# eigenem Ordner. Die Regeln sind die Vorlagen aus der Regel-Erzeugung von
# Airlock (packages/api/src/egress/golden/smoke-*.nft, dort per Test mit
# egress/rules.ts abgeglichen); das Skript setzt nur die Bridge des Test-Netzes,
# das Gateway und einen freien Port ein.
#
# Berührt die laufende Installation nicht: Regeln greifen nur für Verkehr aus
# der Bridge des eigenen Test-Netzes air_smoke_<zufall>; die Tabelle
# inet airlock (der echte Dienst) wird vorher und nachher verglichen. Alle
# Test-Objekte tragen das Label airlock.smoke=<zufall> und werden am Ende
# entfernt, die Test-Tabelle ebenso (auch bei Abbruch, trap).
# Braucht nur bash und docker; liest keine .env.
#
# Geprüft (je Modus mit einem Test-Container im Test-Netz):
#   ohne Regeln   Internet (1.1.1.1:443), Server (Gateway:Port), DNS gehen
#   beobachten    alles geht weiter; Versuche ins LAN (192.168.0.1:80), zum
#                 Server und in ein anderes Docker-Netz stehen im Protokoll
#   durchsetzen   Internet und DNS gehen, eigenes Netz geht, Ausnahme
#                 (Server-Port) geht; Server-Port ohne Ausnahme, 192.168.0.1:80
#                 und das andere Netz scheitern und stehen als «gesperrt» im Protokoll
#   abgeschottet  auch Internet scheitert; eigenes Netz und Ausnahme gehen
#   Prüfung       ein Stand ausserhalb der Grammatik wird abgelehnt, der alte bleibt
#   Neustart      docker restart des Dienstes: Regeln bleiben, Tabelle neu aufgebaut
#   Notausgang    airlock-fw flush entfernt die Tabelle vollständig und schaltet ab;
#                 airlock-fw enable baut sie wieder auf

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAND="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)"
[ -n "$RAND" ] || RAND="$$$(date +%s)"
LBL="airlock.smoke=${RAND}"
IMAGE="${SMOKE_IMAGE:-airlock-smoke-ausgang:${RAND}}"
NET="air_smoke_${RAND}"
OTHER="air_smokeother_${RAND}"
FW="airlock-smoke-fw-${RAND}"
CLI="airlock-smoke-cli-${RAND}"
WEB="web"
WEBC="airlock-smoke-web-${RAND}"
OTHERC="airlock-smoke-other-${RAND}"
HOSTL="airlock-smoke-hostl-${RAND}"
TABLE=airlock_smoke
OG=7811
BG=7812
GOLDEN="$ROOT/packages/api/src/egress/golden"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/airlock-smoke-ausgang.XXXXXX")"
chmod 0755 "$WORK"
LAN_TARGET="${SMOKE_LAN_TARGET:-192.168.0.1}"
PASSED=0

nft_host() { docker run --rm --net host --cap-drop ALL --cap-add NET_ADMIN "$IMAGE" nft "$@"; }

cleanup() {
  set +e
  # Test-Tabelle sicher weg, auch wenn der Dienst schon tot ist
  nft_host delete table inet "$TABLE" >/dev/null 2>&1
  for c in $(docker ps -aq --filter "label=${LBL}"); do docker rm -f "$c" >/dev/null 2>&1; done
  docker network rm "$NET" "$OTHER" >/dev/null 2>&1
  if nft_host list table inet "$TABLE" >/dev/null 2>&1; then echo "WARNUNG: Tabelle inet $TABLE ist noch da" >&2; fi
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FEHLER: $*" >&2
  echo "--- Protokoll des Dienstes ---" >&2
  docker logs --tail 30 "$FW" >&2 2>&1 || true
  echo "--- events.log (Ende) ---" >&2
  tail -n 15 "$WORK/events.log" >&2 2>/dev/null || true
  exit 1
}
ok() { PASSED=$((PASSED + 1)); echo "  ok  $*"; }

# Verbindung vom Test-Container; Exit-Code von nc -z (0 = verbunden)
conn() { docker exec "$CLI" nc -z -w "${3:-3}" "$1" "$2" >/dev/null 2>&1; }
dns() { docker exec "$CLI" nslookup -timeout=3 "$1" >/dev/null 2>&1; }
must() { local what="$1"; shift; "$@" || fail "$what"; ok "$what"; }
mustnot() { local what="$1"; shift; if "$@"; then fail "$what"; fi; ok "$what"; }

# Stand einsetzen: Vorlage → Bridge, Gateway und Port des Laufs
use_rules() {
  sed -e "s/br-5e0b0000c0de/${BRIDGE}/g" -e "s/5e0b0000c0de/${BRID}/g" \
    -e "s/192\.0\.2\.80 tcp dport 18080/${GW} tcp dport ${P_ALLOW}/g" "$GOLDEN/$1.nft" >"$WORK/rules.nft.tmp"
  mv -f "$WORK/rules.nft.tmp" "$WORK/rules.nft"
  wait_applied
}
# Bis status.json den Stand der Datei als angewendet meldet (höchstens 20 s)
wait_applied() {
  local want got i
  want="$(docker exec "$FW" sha256sum /firewall/rules.nft | cut -d' ' -f1)"
  for i in $(seq 1 40); do
    got="$(docker exec "$FW" sh -c 'jq -r ".applied.sha256 // empty" /firewall/status.json 2>/dev/null' || true)"
    [ "$got" = "$want" ] && return 0
    sleep 0.5
  done
  fail "Stand nicht angewendet (status.json: $(cat "$WORK/status.json" 2>/dev/null))"
}
# Zeile im Protokoll: Gruppe und Ziel «addr.port:» bzw. «addr:» (ICMP)
logged() {
  local i
  for i in $(seq 1 10); do
    grep -E "^$1 [0-9.]+ IP [0-9.]+ > $(printf '%s' "$2" | sed 's/\./\\./g')[.:]" "$WORK/events.log" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

command -v docker >/dev/null || fail "docker fehlt"
for f in smoke-beobachten smoke-durchsetzen smoke-abgeschottet; do [ -f "$GOLDEN/$f.nft" ] || fail "Vorlage $f.nft fehlt"; done

echo "Baue Firewall-Image ($IMAGE) …"
docker build -q -t "$IMAGE" --label "$LBL" "$ROOT/firewall" >/dev/null || fail "Build von firewall/ gescheitert"

nft_host list tables >/dev/null 2>&1 || fail "nft im Container geht nicht (NET_ADMIN? nf_tables im Kernel?)"
if nft_host list table inet "$TABLE" >/dev/null 2>&1; then
  fail "Tabelle inet $TABLE gibt es schon – läuft ein anderer Smoke-Test? (sonst: docker run --rm --net host --cap-add NET_ADMIN $IMAGE nft delete table inet $TABLE)"
fi
# Tabelle des echten Dienstes merken (darf sich nicht ändern)
PROD_BEFORE="$(nft_host list table inet airlock 2>/dev/null | grep -v '^#' || true)"

echo "Test-Netze und -Container …"
docker network create --label "$LBL" "$NET" >/dev/null
docker network create --label "$LBL" "$OTHER" >/dev/null
NETID="$(docker network inspect -f '{{.Id}}' "$NET")"
BRID="${NETID:0:12}"
BRIDGE="br-${BRID}"
CUSTOM="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NET")"
[ -z "$CUSTOM" ] || [ "$CUSTOM" = "$BRIDGE" ] || fail "Test-Netz hat einen eigenen Bridge-Namen ($CUSTOM)"
GW="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NET")"
[ -n "$GW" ] || fail "Gateway des Test-Netzes unbekannt"
# Ist das LAN-Ziel selbst eine Adresse dieses Rechners (Gateway eines anderen Docker-Netzes)?
# Dann landet die Verbindung per Docker-DNAT woanders – ein anderes, sicher fremdes Ziel nehmen.
if docker network inspect $(docker network ls -q) -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -qx "$LAN_TARGET"; then
  echo "  Hinweis: $LAN_TARGET ist hier das Gateway eines Docker-Netzes – nehme 10.255.255.1 als LAN-Ziel"
  LAN_TARGET=10.255.255.1
fi
P_ALLOW=$((20000 + RANDOM % 5000))
P_DENY=$((P_ALLOW + 1))

# Dienst wie in compose.yaml, eigene Tabelle/Gruppen/Ordner
docker run -d --name "$FW" --label "$LBL" --net host --cap-drop ALL --cap-add NET_ADMIN \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true --memory 64m --pids-limit 64 \
  -e AIRLOCK_FW_TABLE="$TABLE" -e AIRLOCK_FW_OBSERVE_GROUP="$OG" -e AIRLOCK_FW_BLOCK_GROUP="$BG" \
  -v "$WORK:/firewall" "$IMAGE" >/dev/null
# Lauscher: Projekt-Dienst im Test-Netz, Container in einem anderen Netz, zwei Ports auf dem Server (nur am Gateway)
docker run -d --name "$WEBC" --label "$LBL" --network "$NET" --network-alias "$WEB" "$IMAGE" nc -lk -p 8000 -e true >/dev/null
docker run -d --name "$OTHERC" --label "$LBL" --network "$OTHER" "$IMAGE" nc -lk -p 8000 -e true >/dev/null
docker run -d --name "$HOSTL" --label "$LBL" --net host "$IMAGE" sh -c \
  "nc -lk -s $GW -p $P_ALLOW -e true & nc -lk -s $GW -p $P_DENY -e true & wait" >/dev/null
docker run -d --name "$CLI" --label "$LBL" --network "$NET" "$IMAGE" sleep 3600 >/dev/null
OTHER_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$OTHER\").IPAddress}}" "$OTHERC")"
sleep 2
docker exec "$FW" sh -c 'cat /tmp/tcpdump-*.err 2>/dev/null' | grep -q "listening on nflog" || {
  sleep 3
  docker exec "$FW" sh -c 'cat /tmp/tcpdump-*.err 2>/dev/null' | grep -q "listening on nflog" || fail "tcpdump lauscht nicht auf NFLOG: $(docker exec "$FW" sh -c 'cat /tmp/tcpdump-*.err')"
}

echo "Ohne Regeln (Ausgangslage) …"
INTERNET=1
conn 1.1.1.1 443 5 || { INTERNET=0; echo "  Hinweis: 1.1.1.1:443 ist von hier aus nicht erreichbar – Internet-Prüfungen entfallen"; }
DNSOK=1
dns cloudflare.com || { DNSOK=0; echo "  Hinweis: DNS geht schon ohne Regeln nicht – DNS-Prüfungen entfallen"; }
# Eine Host-Firewall (z. B. ufw mit «deny incoming») sperrt Container→Server schon vorher
HOSTOK=1
if conn "$GW" "$P_DENY"; then ok "Server-Port (Gateway $GW:$P_DENY) erreichbar"; else
  HOSTOK=0
  echo "  Hinweis: der Server-Port ist schon ohne Regeln nicht erreichbar (Firewall des Hosts, z. B. ufw) – Prüfungen «geht» zum Server entfallen, das Protokoll wird trotzdem geprüft"
fi
must "eigenes Netz (web:8000) erreichbar" conn "$WEB" 8000

echo "Modus internet, beobachten …"
use_rules smoke-beobachten
[ "$INTERNET" = 1 ] && must "Internet geht (1.1.1.1:443)" conn 1.1.1.1 443 5
[ "$DNSOK" = 1 ] && must "DNS geht" dns cloudflare.com
if [ "$HOSTOK" = 1 ]; then must "Server-Port geht weiter (nur beobachtet)" conn "$GW" "$P_DENY"; else conn "$GW" "$P_DENY" || true; fi
conn "$LAN_TARGET" 80 2 || true
conn "$OTHER_IP" 8000 2 || true
must "Protokoll: Server-Port als «hätte gesperrt»" logged "$OG" "$GW.$P_DENY"
must "Protokoll: $LAN_TARGET:80 als «hätte gesperrt»" logged "$OG" "$LAN_TARGET.80"
must "Protokoll: anderes Docker-Netz ($OTHER_IP:8000) als «hätte gesperrt»" logged "$OG" "$OTHER_IP.8000"
if logged "$BG" "$GW"; then fail "im Beobachten darf nichts als gesperrt protokolliert sein"; fi
ok "nichts als gesperrt protokolliert"

echo "Modus internet, durchsetzen …"
use_rules smoke-durchsetzen
[ "$INTERNET" = 1 ] && must "Internet geht (1.1.1.1:443)" conn 1.1.1.1 443 5
[ "$DNSOK" = 1 ] && must "DNS geht" dns cloudflare.com
must "eigenes Netz geht (web:8000)" conn "$WEB" 8000
[ "$HOSTOK" = 1 ] && must "Ausnahme geht (Server-Port $P_ALLOW)" conn "$GW" "$P_ALLOW"
mustnot "Server-Port ohne Ausnahme gesperrt" conn "$GW" "$P_DENY"
mustnot "$LAN_TARGET:80 gesperrt" conn "$LAN_TARGET" 80 2
mustnot "anderes Docker-Netz gesperrt" conn "$OTHER_IP" 8000 2
must "Protokoll: Server-Port als «gesperrt»" logged "$BG" "$GW.$P_DENY"
must "Protokoll: $LAN_TARGET:80 als «gesperrt»" logged "$BG" "$LAN_TARGET.80"
START="$(date +%s)"; conn "$LAN_TARGET" 80 5 || true; DUR=$(( $(date +%s) - START ))
[ "$DUR" -le 2 ] && ok "gesperrt antwortet sofort (abgewiesen, kein Warten auf Zeitlimit)" || echo "  Hinweis: Abweisen dauerte ${DUR}s"

echo "Modus abgeschottet, durchsetzen …"
use_rules smoke-abgeschottet
[ "$INTERNET" = 1 ] && mustnot "Internet gesperrt (1.1.1.1:443)" conn 1.1.1.1 443 3
must "eigenes Netz geht (web:8000)" conn "$WEB" 8000
[ "$HOSTOK" = 1 ] && must "Ausnahme geht (Server-Port $P_ALLOW)" conn "$GW" "$P_ALLOW"
must "Name im eigenen Netz löst Docker auf (web)" dns "$WEB"
if [ "$DNSOK" = 1 ]; then
  if dns cloudflare.com; then echo "  Hinweis: DNS nach draussen ging trotz «abgeschottet» (Docker fragt den Resolver dann vom Host aus)"; else ok "DNS nach draussen gesperrt"; fi
fi
[ "$INTERNET" = 1 ] && { must "Protokoll: 1.1.1.1:443 als «gesperrt»" logged "$BG" "1.1.1.1.443"; }

echo "Prüfung eines falschen Stands …"
GOOD_SHA="$(docker exec "$FW" jq -r .applied.sha256 /firewall/status.json)"
printf 'table inet %s {\n  chain egress {\n    type filter hook forward priority -1; policy accept;\n    reject with icmpx admin-prohibited\n  }\n}\nflush ruleset\n' "$TABLE" >"$WORK/rules.nft.tmp"
mv -f "$WORK/rules.nft.tmp" "$WORK/rules.nft"
for i in $(seq 1 20); do
  [ "$(docker exec "$FW" jq -r .state /firewall/status.json)" = error ] && break
  sleep 0.5
done
[ "$(docker exec "$FW" jq -r .state /firewall/status.json)" = error ] || fail "falscher Stand nicht als Fehler gemeldet"
ok "falscher Stand abgelehnt: $(docker exec "$FW" jq -r .error /firewall/status.json | head -n1)"
[ "$(docker exec "$FW" jq -r .applied.sha256 /firewall/status.json)" = "$GOOD_SHA" ] || fail "angewendeter Stand hat sich geändert"
must "alter Stand bleibt aktiv (eigenes Netz geht, Server-Port gesperrt)" sh -c "docker exec $CLI nc -z -w 3 $WEB 8000 && ! docker exec $CLI nc -z -w 3 $GW $P_DENY"

echo "Neustart des Dienstes …"
use_rules smoke-durchsetzen
docker stop -t 5 "$FW" >/dev/null
nft_host list table inet "$TABLE" >/dev/null 2>&1 || fail "nach dem Stoppen ist die Tabelle weg (soll bleiben)"
ok "gestoppt: Regeln bleiben im Kernel"
mustnot "gestoppt: Server-Port weiter gesperrt" conn "$GW" "$P_DENY"
nft_host delete table inet "$TABLE"
docker start "$FW" >/dev/null
for i in $(seq 1 20); do nft_host list table inet "$TABLE" >/dev/null 2>&1 && break; sleep 0.5; done
nft_host list table inet "$TABLE" >/dev/null 2>&1 || fail "nach dem Start nicht neu aufgebaut"
ok "beim Start aus rules.nft neu aufgebaut"
mustnot "nach dem Start: Server-Port gesperrt" conn "$GW" "$P_DENY"

echo "Notausgang …"
docker exec "$FW" airlock-fw flush
if nft_host list table inet "$TABLE" >/dev/null 2>&1; then fail "flush: Tabelle noch da"; fi
ok "airlock-fw flush: Tabelle inet $TABLE vollständig entfernt"
if [ "$HOSTOK" = 1 ]; then must "nach flush: Server-Port wieder erreichbar" conn "$GW" "$P_DENY"; fi
sleep 3
if nft_host list table inet "$TABLE" >/dev/null 2>&1; then fail "der Dienst hat die Tabelle nach flush wieder angelegt"; fi
ok "bleibt aus (Marke disabled), Dienst meldet $(docker exec "$FW" jq -r .state /firewall/status.json)"
docker exec "$FW" airlock-fw enable >/dev/null
for i in $(seq 1 20); do nft_host list table inet "$TABLE" >/dev/null 2>&1 && break; sleep 0.5; done
nft_host list table inet "$TABLE" >/dev/null 2>&1 || fail "enable: Tabelle nicht neu aufgebaut"
ok "airlock-fw enable: wieder aufgebaut"
docker exec "$FW" airlock-fw flush >/dev/null

PROD_AFTER="$(nft_host list table inet airlock 2>/dev/null | grep -v '^#' || true)"
[ "$PROD_BEFORE" = "$PROD_AFTER" ] || fail "Tabelle inet airlock des echten Dienstes hat sich verändert"
ok "Tabelle inet airlock (echter Dienst) unverändert"

echo "OK: Ausgang – beobachten protokolliert, durchsetzen sperrt LAN/Server/andere Netze, abgeschottet sperrt Internet, Notausgang entfernt alles (${PASSED} Prüfungen)"
