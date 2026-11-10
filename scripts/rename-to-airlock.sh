#!/usr/bin/env bash
# Umzug einer bestehenden Installation von «deployer» auf «Airlock».
# Ablauf, Rückweg und Aufräumen: docs/RENAME.md
#
#   scripts/rename-to-airlock.sh             Umzug (fragt vor jedem Schritt, der etwas verändert)
#   scripts/rename-to-airlock.sh --status    Stand anzeigen
#   scripts/rename-to-airlock.sh --rollback  Rückweg: Airlock stoppen, deployer wieder starten
#
# Idempotent: Erledigte Schritte stehen in $BACKUP_ROOT/state und werden beim
# nächsten Aufruf übersprungen. Alte Volumes werden nie gelöscht; der Befehl
# dafür wird am Ende nur angezeigt.
#
# Alles ist über Umgebungsvariablen einstellbar (Standard = Server):
#   OLD_PROJECT=deployer NEW_PROJECT=airlock OLD_DB=deployer NEW_DB=airlock
#   ENV_FILE=<repo>/.env BACKUP_ROOT=~/airlock-backup COMPOSE_FILES="compose.yaml …"
#   OLD_CLOUDFLARED=deployer-cloudflared HELPER_IMAGE=alpine:3.20
#   ASSUME_YES=1 (nur für Tests: keine Rückfragen), LOGIN_PASSWORD (Login-Test),
#   NO_BUILD=1 (nur für Tests: vorhandene Images nehmen statt zu bauen)

set -euo pipefail

OLD_PROJECT=${OLD_PROJECT:-deployer}
NEW_PROJECT=${NEW_PROJECT:-airlock}
OLD_DB=${OLD_DB:-deployer}
NEW_DB=${NEW_DB:-airlock}
OLD_CLOUDFLARED=${OLD_CLOUDFLARED:-deployer-cloudflared}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-$REPO_DIR/.env}
BACKUP_ROOT=${BACKUP_ROOT:-$HOME/airlock-backup}
HELPER_IMAGE=${HELPER_IMAGE:-alpine:3.20}
ASSUME_YES=${ASSUME_YES:-0}
STATE="$BACKUP_ROOT/state"
TMP_ROLE="${NEW_DB}_rename"

# Volumes: alter Schlüssel:neuer Schlüssel (Docker-Name <projekt>_<schlüssel>).
# caddy_admin fehlt bewusst: darin liegen nur Sockets, Caddy legt sie neu an.
VOLUMES="pgdata:pgdata caddy_data:caddy_data caddy_config:caddy_config caddy_secrets:caddy_secrets sites:sites deployer_data:data"
REQUIRED_VOLUMES="pgdata deployer_data"
# Anzahl Einträge und Summe der Dateigrössen (Bytes) eines Volumes unter /v
VOLUME_SUMMARY='find /v | wc -l; find /v -type f -exec stat -c %s {} + | awk "{s+=\$1} END {print s+0}"'

cd "$REPO_DIR"

# --- Hilfen -------------------------------------------------------------------

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '\nAbbruch: %s\n' "$*" >&2; exit 1; }

confirm() {
  # Rückfrage vor jedem Schritt, der etwas verändert. Nur «j» oder «ja» gilt.
  if [ "$ASSUME_YES" = "1" ]; then info "→ $1 (ASSUME_YES)"; return 0; fi
  local a
  printf '\n  ? %s [j/N] ' "$1"
  read -r a || a=""
  case "$a" in j|J|ja|Ja|JA) return 0 ;; *) die "nicht bestätigt – nichts weiter verändert. Erneut aufrufen setzt hier fort." ;; esac
}

state_get() { [ -f "$STATE" ] && grep -E "^$1=" "$STATE" | tail -n1 | cut -d= -f2- || true; }
state_set() {
  mkdir -p "$BACKUP_ROOT"
  local tmp="$STATE.tmp"
  { [ -f "$STATE" ] && grep -vE "^$1=" "$STATE" || true; echo "$1=$2"; } > "$tmp"
  mv "$tmp" "$STATE"
}
state_del() { [ -f "$STATE" ] || return 0; local tmp="$STATE.tmp"; grep -vE "^$1=" "$STATE" > "$tmp" || true; mv "$tmp" "$STATE"; }

vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# Container eines Compose-Projekts und Dienstes (unabhängig von container_name)
container_of() { docker ps -aq --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" | head -n1; }
running_of()   { docker ps -q  --filter "label=com.docker.compose.project=$1" | head -n1; }

env_value() {
  # Wert aus .env lesen, ohne ihn auszugeben (einfache KEY=VALUE-Zeilen, Anführungszeichen optional)
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-) || true
  v=${v%$'\r'}
  v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
  printf '%s' "$v"
}

compose_new() {
  local args=(-p "$NEW_PROJECT" --env-file "$ENV_FILE")
  local f
  for f in $(state_get compose_files); do args+=(-f "$f"); done
  docker compose "${args[@]}" "$@"
}

compose_old() {
  local dir; dir=$(state_get backup_dir)
  local args=(-p "$OLD_PROJECT" --env-file "$ENV_FILE" --project-directory "$REPO_DIR")
  local f
  for f in "$dir"/compose.old.*.yaml; do [ -f "$f" ] && args+=(-f "$f"); done
  docker compose "${args[@]}" "$@"
}

wait_healthy() {
  local c=$1 i s
  for i in $(seq 1 90); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo fehlt)
    [ "$s" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

# psql im Container: psql_in mit -c, psql_stdin mit SQL auf stdin (Heredoc)
psql_in()    { local c=$1; shift; docker exec    "$c" psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
psql_stdin() { local c=$1; shift; docker exec -i "$c" psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

wait_pg() {
  local c=$1 i
  for i in $(seq 1 60); do docker exec "$c" pg_isready -q >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

cleanup_hint() {
  say "Aufräumen (erst, wenn Airlock einige Tage ohne Probleme läuft – NICHT automatisch):"
  local pair old vols=""
  for pair in $VOLUMES; do old="${OLD_PROJECT}_${pair%%:*}"; vols="$vols $old"; done
  info "docker volume rm${vols} ${OLD_PROJECT}_caddy_admin ${OLD_PROJECT}_scan-trivy ${OLD_PROJECT}_scan-nuclei"
  info "docker rm ${OLD_CLOUDFLARED}   # falls vorhanden (gestoppt)"
  info "docker image rm ${OLD_PROJECT}-${OLD_PROJECT} ${OLD_PROJECT}/caddy-cloudflare:local"
  info "Sicherung: $(state_get backup_dir)"
  info "Projekte mit Containern aus der deployer-Zeit: in Airlock «Neu erstellen» (siehe docs/RENAME.md)."
}

# --- Modi ---------------------------------------------------------------------

show_status() {
  say "Stand ($STATE)"
  if [ -f "$STATE" ]; then sed 's/^/  /' "$STATE"; else info "noch nichts begonnen"; fi
  say "Container"
  info "alt ($OLD_PROJECT): $(docker ps --filter "label=com.docker.compose.project=$OLD_PROJECT" --format '{{.Names}}' | tr '\n' ' ')"
  info "neu ($NEW_PROJECT): $(docker ps --filter "label=com.docker.compose.project=$NEW_PROJECT" --format '{{.Names}}' | tr '\n' ' ')"
}

rollback() {
  say "Rückweg: Airlock stoppen, deployer wieder starten"
  local dir; dir=$(state_get backup_dir)
  [ -n "$dir" ] && ls "$dir"/compose.old.*.yaml >/dev/null 2>&1 || die "keine gesicherte alte compose.yaml in der Sicherung – Rückweg von Hand, siehe docs/RENAME.md"
  info "Die alten Volumes ($OLD_PROJECT""_*) sind unverändert; was seit dem Umzug in Airlock geändert wurde, fehlt danach."
  confirm "Neuen Stack «$NEW_PROJECT» stoppen (docker compose down, ohne -v) und «$OLD_PROJECT» wieder starten?"
  if [ -n "$(running_of "$NEW_PROJECT")" ] || [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$NEW_PROJECT")" ]; then
    compose_new down
  fi
  docker stop "${NEW_PROJECT}-cloudflared" >/dev/null 2>&1 || true
  compose_old up -d --no-build
  if [ "$(state_get cloudflared_was_running)" = "1" ]; then docker start "$OLD_CLOUDFLARED" >/dev/null 2>&1 || true; fi
  # Nächster Umzug: neue Volumes dürfen überschrieben werden, alles andere neu
  local k
  for k in dump backup_dir volumes_saved copied db started done compose_files old_ref; do state_del "$k"; done
  state_set copy_started 1
  state_set rolled_back "$(date +%Y-%m-%dT%H:%M:%S)"
  say "deployer läuft wieder. Die Volumes ${NEW_PROJECT}_* bleiben liegen und werden beim nächsten Umzug überschrieben."
}

# --- a. Vorprüfung ------------------------------------------------------------

preflight() {
  say "a. Vorprüfung"
  docker info >/dev/null 2>&1 || die "Docker ist nicht erreichbar"
  docker compose version >/dev/null 2>&1 || die "docker compose fehlt"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE fehlt"
  [ -n "$(env_value POSTGRES_PASSWORD)" ] || die "POSTGRES_PASSWORD fehlt in $ENV_FILE"

  local v
  for v in $REQUIRED_VOLUMES; do
    vol_exists "${OLD_PROJECT}_$v" || die "altes Volume ${OLD_PROJECT}_$v fehlt – ist das die richtige Installation?"
  done
  info "alte Volumes vorhanden"

  local pair new existing=""
  for pair in $VOLUMES; do new="${NEW_PROJECT}_${pair##*:}"; vol_exists "$new" && existing="$existing $new"; done
  if [ -n "$existing" ] && [ "$(state_get copy_started)" != "1" ]; then
    die "neue Volumes gibt es schon:${existing}. Läuft Airlock schon? Wenn sie leer bzw. Reste eines Fehlversuchs sind: docker volume rm${existing}"
  fi
  [ -z "$existing" ] && info "neue Volumes noch nicht vorhanden"

  # Welche Compose-Dateien? Aus dem laufenden alten Stack ableiten.
  if [ -z "$(state_get compose_files)" ]; then
    local files="compose.yaml" app
    app=$(container_of "$OLD_PROJECT" "$OLD_PROJECT")
    if [ -n "$app" ] && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app" | grep -q '^TLS_MODE=cloudflare$'; then files="$files compose.tls.yaml"; fi
    if [ -n "$(container_of "$OLD_PROJECT" cloudflared)" ]; then files="$files compose.public.yaml"; fi
    [ -n "${COMPOSE_FILES:-}" ] && files="$COMPOSE_FILES"
    state_set compose_files "$files"
  fi
  info "Compose-Dateien für Airlock: $(state_get compose_files)"

  # Alte Fassung der Compose-Dateien (für den Rückweg) aus git
  if [ -z "$(state_get old_ref)" ]; then
    local ref=""
    if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      ref=$(git -C "$REPO_DIR" log -1 --format=%H -G"^name: ${OLD_PROJECT}\$" -- compose.yaml 2>/dev/null || true)
      [ -n "$ref" ] && ref="${ref}^"
    fi
    state_set old_ref "${OLD_REF:-$ref}"
  fi
  [ -n "$(state_get old_ref)" ] && info "alte Compose-Dateien aus git: $(state_get old_ref)" || warn "alte Compose-Dateien nicht in git gefunden; Rückweg dann von Hand"
}

# --- b. Sicherung -------------------------------------------------------------

backup_db() {
  say "b. Sicherung: Datenbank"
  if [ "$(state_get dump)" = "1" ]; then info "schon erledigt: $(state_get backup_dir)"; return; fi
  local dir; dir="$BACKUP_ROOT/$(date +%Y-%m-%d_%H%M%S)"
  mkdir -p "$dir"; chmod 700 "$dir"
  state_set backup_dir "$dir"

  local pg; pg=$(container_of "$OLD_PROJECT" postgres)
  [ -n "$pg" ] || die "Postgres-Container von $OLD_PROJECT nicht gefunden"
  if [ "$(docker inspect -f '{{.State.Running}}' "$pg")" != "true" ]; then
    info "Postgres von $OLD_PROJECT läuft nicht, wird für den Dump gestartet"
    docker start "$pg" >/dev/null
  fi
  wait_pg "$pg" || die "Postgres von $OLD_PROJECT antwortet nicht"

  docker exec "$pg" pg_dump -U "$OLD_DB" -Fc "$OLD_DB" > "$dir/$OLD_DB.dump"
  docker exec "$pg" pg_dumpall -U "$OLD_DB" --globals-only > "$dir/globals.sql"
  chmod 600 "$dir/$OLD_DB.dump" "$dir/globals.sql"
  local n; n=$(psql_in "$pg" -U "$OLD_DB" -d "$OLD_DB" -c 'select count(*) from projects')
  state_set projects "$n"
  info "pg_dump: $dir/$OLD_DB.dump ($(du -h "$dir/$OLD_DB.dump" | cut -f1)), $n Projekte"

  local ref; ref=$(state_get old_ref)
  if [ -n "$ref" ]; then
    local f
    for f in compose.yaml compose.tls.yaml compose.public.yaml; do
      case " $(state_get compose_files) " in *" $f "*) ;; *) continue ;; esac
      git -C "$REPO_DIR" show "$ref:$f" > "$dir/compose.old.$f" 2>/dev/null || rm -f "$dir/compose.old.$f"
    done
    info "alte Compose-Dateien gesichert (für den Rückweg)"
  fi
  state_set dump 1
}

backup_volumes() {
  say "b. Sicherung: Volumes (tar)"
  if [ "$(state_get volumes_saved)" = "1" ]; then info "schon erledigt"; return; fi
  local dir; dir=$(state_get backup_dir)
  docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || docker pull -q "$HELPER_IMAGE" >/dev/null
  local name
  for name in $(docker volume ls -q | grep "^${OLD_PROJECT}_" || true); do
    # Sockets und Scanner-Caches (Trivy-Datenbank, Nuclei-Vorlagen) lassen sich neu holen
    case "$name" in "${OLD_PROJECT}_caddy_admin"|"${OLD_PROJECT}_scan-"*) continue ;; esac
    [ -f "$dir/$name.tar.gz" ] && continue
    docker run --rm -v "$name":/v:ro -v "$dir":/b "$HELPER_IMAGE" tar czf "/b/$name.tar.gz" -C /v .
    # Enthält Schlüssel und Secrets (Daten-Volume, Datenbank)
    chmod 600 "$dir/$name.tar.gz" 2>/dev/null || docker run --rm -v "$dir":/b "$HELPER_IMAGE" chmod 600 "/b/$name.tar.gz"
    info "$name → $dir/$name.tar.gz ($(du -h "$dir/$name.tar.gz" | cut -f1))"
  done
  state_set volumes_saved 1
}

# --- c. Alten Stack stoppen ---------------------------------------------------

stop_old() {
  say "c. Alten Stack stoppen"
  local cf_running
  cf_running=$(docker inspect -f '{{.State.Running}}' "$OLD_CLOUDFLARED" 2>/dev/null || echo false)
  if [ -z "$(running_of "$OLD_PROJECT")" ] && [ "$cf_running" != "true" ]; then info "läuft schon nicht mehr"; return; fi
  info "Die Projekt-Container laufen weiter; nur die Oberfläche ist bis zum Start von Airlock weg."
  confirm "Stack «$OLD_PROJECT» stoppen (docker compose -p $OLD_PROJECT down, OHNE -v) und $OLD_CLOUDFLARED stoppen?"
  if [ "$cf_running" = "true" ]; then
    state_set cloudflared_was_running 1
    docker stop "$OLD_CLOUDFLARED" >/dev/null
    info "$OLD_CLOUDFLARED gestoppt (nicht gelöscht)"
  fi
  if ls "$(state_get backup_dir)"/compose.old.*.yaml >/dev/null 2>&1; then
    compose_old down --remove-orphans
  else
    (cd "$(mktemp -d)" && docker compose -p "$OLD_PROJECT" down --remove-orphans)
  fi
  [ -z "$(running_of "$OLD_PROJECT")" ] || die "es laufen noch Container von $OLD_PROJECT"
}

# --- d. Volumes kopieren ------------------------------------------------------

copy_volumes() {
  say "d. Volumes kopieren ${OLD_PROJECT}_* → ${NEW_PROJECT}_*"
  if [ "$(state_get copied)" = "1" ]; then info "schon erledigt"; return; fi
  [ -z "$(running_of "$OLD_PROJECT")" ] || die "$OLD_PROJECT läuft noch – erst stoppen"
  [ -z "$(running_of "$NEW_PROJECT")" ] || die "$NEW_PROJECT läuft schon – Volumes nicht überschreiben"
  confirm "Volumes kopieren (cp -a über $HELPER_IMAGE; vorhandene ${NEW_PROJECT}_*-Volumes werden überschrieben)?"
  state_set copy_started 1
  state_del db; state_del started
  docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || docker pull -q "$HELPER_IMAGE" >/dev/null
  local pair oldk newk old new a b
  for pair in $VOLUMES; do
    oldk=${pair%%:*}; newk=${pair##*:}
    old="${OLD_PROJECT}_$oldk"; new="${NEW_PROJECT}_$newk"
    if ! vol_exists "$old"; then info "$old gibt es nicht – übersprungen"; continue; fi
    # Wie Compose es selbst anlegen würde: dann gibt es beim Start keine Warnung
    vol_exists "$new" || docker volume create --label "com.docker.compose.project=$NEW_PROJECT" --label "com.docker.compose.volume=$newk" "$new" >/dev/null
    docker run --rm -v "$old":/from:ro -v "$new":/to "$HELPER_IMAGE" sh -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/'
    # Vergleich: Anzahl Einträge und Summe der Dateigrössen in Bytes. Nicht du:
    # das zählt Blöcke von Verzeichnissen mit, die in der Quelle nach dem
    # Löschen von Dateien nie schrumpfen – die Kopie ist dann ein paar KB kleiner.
    a=$(docker run --rm -v "$old":/v:ro "$HELPER_IMAGE" sh -c "$VOLUME_SUMMARY" | tr '\n' ' ')
    b=$(docker run --rm -v "$new":/v:ro "$HELPER_IMAGE" sh -c "$VOLUME_SUMMARY" | tr '\n' ' ')
    [ "$a" = "$b" ] || die "Kopie $old → $new weicht ab (Einträge/Bytes alt: $a, neu: $b)"
    info "$old → $new (Einträge, Bytes: $a)"
  done
  state_set copied 1
}

# --- e. Datenbank -------------------------------------------------------------

rename_db() {
  say "e. Datenbank: Rolle und Datenbank $OLD_DB → $NEW_DB"
  if [ "$(state_get db)" = "1" ]; then info "schon erledigt"; return; fi
  confirm "Postgres von «$NEW_PROJECT» starten und Rolle/Datenbank umbenennen (Passwort aus $ENV_FILE)?"
  compose_new up -d postgres
  local pg; pg=$(container_of "$NEW_PROJECT" postgres)
  [ -n "$pg" ] || die "Postgres von $NEW_PROJECT nicht gefunden"
  wait_pg "$pg" || die "Postgres von $NEW_PROJECT antwortet nicht"

  if psql_in "$pg" -U "$NEW_DB" -d "$NEW_DB" -c 'select 1' >/dev/null 2>&1; then
    info "Rolle und Datenbank $NEW_DB gibt es schon"
  else
    # Die eigene Sitzungsrolle lässt sich nicht umbenennen: dafür eine
    # vorübergehende Hilfsrolle (lokaler Socket im Container, ohne Netz).
    psql_stdin "$pg" -U "$OLD_DB" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$TMP_ROLE') THEN CREATE ROLE "$TMP_ROLE" SUPERUSER LOGIN; END IF;
END \$\$;
SQL
    psql_stdin "$pg" -U "$TMP_ROLE" -d postgres <<SQL
ALTER ROLE "$OLD_DB" RENAME TO "$NEW_DB";
ALTER DATABASE "$OLD_DB" RENAME TO "$NEW_DB";
SQL
    info "umbenannt"
  fi
  # Passwort aus .env (über stdin, erscheint nicht in der Prozessliste)
  local pw; pw=$(env_value POSTGRES_PASSWORD); pw=${pw//\'/\'\'}
  psql_stdin "$pg" -U "$NEW_DB" -d postgres <<SQL
ALTER ROLE "$NEW_DB" PASSWORD '$pw';
DROP ROLE IF EXISTS "$TMP_ROLE";
SQL
  local n; n=$(psql_in "$pg" -U "$NEW_DB" -d "$NEW_DB" -c 'select count(*) from projects')
  info "Datenbank $NEW_DB: $n Projekte (vorher $(state_get projects))"
  [ "$n" = "$(state_get projects)" ] || die "Anzahl Projekte stimmt nicht"
  state_set db 1
}

# --- f. Neuen Stack starten und prüfen ------------------------------------------

start_new() {
  say "f. Airlock starten"
  if [ "$(state_get started)" != "1" ]; then
    confirm "Stack «$NEW_PROJECT» bauen und starten (docker compose up -d --build)?"
    if [ "${NO_BUILD:-0}" = "1" ]; then compose_new up -d --no-build; else compose_new up -d --build; fi
    state_set started 1
  else
    compose_new up -d
  fi
  local app; app=$(container_of "$NEW_PROJECT" "$NEW_PROJECT")
  [ -n "$app" ] || die "App-Container von $NEW_PROJECT nicht gefunden"
  info "warte auf $app …"
  wait_healthy "$app" || { docker logs --tail 40 "$app" >&2 || true; die "$app wird nicht gesund"; }
  info "$app ist gesund"
  verify "$app"
}

verify() {
  local app=$1 failed=0
  say "Gesundheitsprüfung"

  # Login
  local pw=${LOGIN_PASSWORD:-}
  if [ -z "$pw" ] && [ "$ASSUME_YES" != "1" ]; then
    printf '  Passwort für den Login-Test (leer: ADMIN_PASSWORD aus .env): '
    read -rs pw || pw=""; echo
  fi
  [ -n "$pw" ] || pw=$(env_value ADMIN_PASSWORD)
  if docker exec -e LOGIN_PW="$pw" "$app" node -e "fetch('http://127.0.0.1:3000/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:process.env.LOGIN_PW})}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))"; then
    info "✓ Login möglich"
  else
    warn "✗ Login gescheitert (anderes Passwort in der Oberfläche gesetzt? LOGIN_PASSWORD=… erneut aufrufen)"; failed=1
  fi

  # Projekte, Secrets, Zertifikat, Tunnel: Selbstprüfung im Container. Der
  # Tunnel braucht nach dem Start ein paar Sekunden.
  local out="" rc=1 i
  for i in $(seq 1 12); do
    if out=$(docker exec "$app" node packages/api/dist/selfcheck.js 2>&1); then rc=0; break; fi
    rc=$?
    sleep 5
  done
  printf '%s\n' "$out" | sed 's/^/  /'
  if [ "$rc" = "0" ]; then info "✓ Selbstprüfung bestanden"; else warn "✗ Selbstprüfung nicht bestanden"; failed=1; fi

  if [ "$failed" = "1" ]; then
    say "Nicht alles in Ordnung. Airlock läuft, die alten Volumes sind unverändert."
    info "Rückweg: scripts/rename-to-airlock.sh --rollback"
    exit 1
  fi
  state_set done 1
  say "Umzug abgeschlossen."
  cleanup_hint
}

# --- Ablauf ---------------------------------------------------------------------

case "${1:-}" in
  --status) show_status; exit 0 ;;
  --rollback) rollback; exit 0 ;;
  "") ;;
  *) die "unbekannte Option $1 (erlaubt: --status, --rollback)" ;;
esac

if [ "$(state_get done)" = "1" ]; then
  say "Der Umzug ist schon abgeschlossen ($STATE)."
  cleanup_hint
  exit 0
fi

say "Umzug ${OLD_PROJECT} → ${NEW_PROJECT} (Repo $REPO_DIR, Sicherung $BACKUP_ROOT)"
preflight
backup_db
stop_old
backup_volumes
copy_volumes
rename_db
start_new
