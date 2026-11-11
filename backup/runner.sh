#!/bin/sh
# Ausführer des Backup-Containers (docs/MILESTONE-BACKUP.md).
#
# Airlock hat kein docker exec (Socket-Proxy EXEC=0). Stattdessen legt es
# Aufträge in das gemeinsame Auftrags-Volume (/jobs, tmpfs), dieser Ausführer
# holt sie dort ab, führt sie aus und schreibt Ausgabe und Ergebnis zurück.
# Die Gegenseite steht in packages/api/src/backup/{jobs,dispatch}.ts.
#
# Dateien je Auftrag (<id>: nur a-z, 0-9 und -):
#   <id>.env     Geheimnisse (RESTIC_PASSWORD, AWS_*), Rechte 0600, von
#                Airlock VOR dem Auftrag geschrieben. Wird beim Abholen
#                gelesen und sofort gelöscht.
#   <id>.job     Auftrag, eine Angabe pro Zeile: «op <name>», «timeout <s>»,
#                «arg <wert>» (je ein Argument, ohne Shell dazwischen).
#                Erscheint per rename, ist also immer vollständig.
#   <id>.run     der abgeholte Auftrag; mtime = Lebenszeichen (jede Sekunde)
#   <id>.out/.err  Ausgabe des Befehls (keine Geheimnisse: die stehen nur in
#                der Umgebung des Prozesses)
#   <id>.cancel  von Airlock: abbrechen
#   <id>.result  Ergebnis, per rename: «exit <n>», «timedout 0|1», «cancelled 0|1»
#
# Nur feste Vorgänge, kein beliebiger Befehl: restic (Unterbefehle aus einer
# Erlaubnisliste), pg_dump in die feste Datei, Staging leeren/anlegen.
# POSIX-sh (BusyBox im Alpine-Image), keine weiteren Abhängigkeiten.
set -u

JOBS=${JOBS_DIR:-/jobs}
POLL=${POLL_SECONDS:-1}
STAGING=/staging
# Nach dem Abbruch (Zeitlimit, cancel): so lange auf das Ende warten, dann KILL
KILL_AFTER=15

say() { echo "runner: $*"; }

# Nur diese Variablen darf ein Auftrag setzen
env_key_ok() {
  case "$1" in
    RESTIC_REPOSITORY | RESTIC_PASSWORD | RESTIC_CACHE_DIR | RESTIC_PROGRESS_FPS | \
      AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION) return 0 ;;
  esac
  return 1
}

# Ergebnis schreiben (per rename, damit Airlock nie eine halbe Datei liest)
# finish <id> <exit> <timedout> <cancelled>
finish() {
  printf 'exit %s\ntimedout %s\ncancelled %s\n' "$2" "$3" "$4" >"$JOBS/$1.result.tmp"
  mv -f "$JOBS/$1.result.tmp" "$JOBS/$1.result"
  rm -f "$JOBS/$1.run" "$JOBS/$1.timedout"
}

# Abgelehnter Auftrag: Grund in .err, Exit 126
reject() {
  echo "Auftrag abgelehnt: $2" >>"$JOBS/$1.err"
  say "Auftrag $1 abgelehnt: $2"
  finish "$1" 126 0 0
  exit 0
}

# Wächter neben dem laufenden Befehl: Lebenszeichen, Abbruch, Zeitlimit.
# watch <id> <pid> <timeout-s>
watch() {
  w_id=$1 w_pid=$2 w_timeout=$3
  w_start=$(date +%s) w_killed=
  # Ende auf Zuruf von run_job, ohne «Terminated» im Log
  trap 'exit 0' TERM
  while kill -0 "$w_pid" 2>/dev/null; do
    w_now=$(date +%s)
    if [ -z "$w_killed" ]; then
      if [ -e "$JOBS/$w_id.cancel" ]; then
        kill -TERM "$w_pid" 2>/dev/null
        w_killed=$w_now
      elif [ "$w_timeout" -gt 0 ] && [ $((w_now - w_start)) -ge "$w_timeout" ]; then
        : >"$JOBS/$w_id.timedout"
        kill -TERM "$w_pid" 2>/dev/null
        w_killed=$w_now
      fi
    elif [ $((w_now - w_killed)) -ge "$KILL_AFTER" ]; then
      kill -KILL "$w_pid" 2>/dev/null
    fi
    touch "$JOBS/$w_id.run" 2>/dev/null
    sleep 1 &
    wait $!
  done
}

# Einen abgeholten Auftrag ausführen (läuft im Hintergrund, eigene Umgebung)
run_job() {
  id=$1
  op= timeout=0
  set --
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'v 1' | '') ;;
      'op '*) op=${line#op } ;;
      'timeout '*) timeout=${line#timeout } ;;
      'arg '*) set -- "$@" "${line#arg }" ;;
      *) bad_line=1 ;;
    esac
  done <"$JOBS/$id.run"

  # Geheimnisse übernehmen und die Datei sofort löschen
  if [ -f "$JOBS/$id.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      key=${line%%=*}
      if env_key_ok "$key"; then
        export "$key=${line#*=}"
      else
        rm -f "$JOBS/$id.env"
        reject "$id" "Variable $key nicht erlaubt"
      fi
    done <"$JOBS/$id.env"
    rm -f "$JOBS/$id.env"
  fi

  [ -z "${bad_line:-}" ] || reject "$id" 'unbekannte Zeile im Auftrag'
  case "$timeout" in '' | *[!0-9]*) reject "$id" 'Zeitlimit ist keine Zahl' ;; esac

  what=$op
  case "$op" in
    restic)
      what="restic ${1:-}"
      case "${1:-}" in
        backup | check | forget | init | snapshots) ;;
        # «cat masterkey» gäbe den Schlüssel im Klartext aus: nur «cat config»
        cat) [ "${2:-}" = config ] && [ $# -eq 2 ] || reject "$id" 'restic cat nur mit config' ;;
        *) reject "$id" "restic ${1:-} ist nicht erlaubt" ;;
      esac
      # Repository und Passwort kommen nur aus der Umgebung, nie aus Argumenten
      for a in "$@"; do
        case "$a" in
          -r | --repo* | --repository-file* | --password-command* | --password-file* | -o | --option*)
            reject "$id" "restic-Argument $a ist nicht erlaubt" ;;
        esac
      done
      set -- restic "$@"
      ;;
    pg-dump)
      [ $# -eq 0 ] || reject "$id" 'pg-dump nimmt keine Argumente'
      # Verbindung über PGHOST/PGUSER/PGPASSWORD aus compose.yaml
      set -- pg_dump --format=custom --no-owner "--file=$STAGING/db/airlock.dump"
      ;;
    staging-prepare)
      [ $# -eq 0 ] || reject "$id" 'staging-prepare nimmt keine Argumente'
      set -- sh -c "rm -rf $STAGING/db $STAGING/volumes && mkdir -p $STAGING/db $STAGING/volumes $STAGING/cache"
      ;;
    staging-clean)
      [ $# -eq 0 ] || reject "$id" 'staging-clean nimmt keine Argumente'
      set -- sh -c "rm -rf $STAGING/db $STAGING/volumes"
      ;;
    *) reject "$id" "unbekannter Vorgang «$op»" ;;
  esac

  say "Auftrag $id: $what (Zeitlimit ${timeout}s)"
  "$@" >"$JOBS/$id.out" 2>"$JOBS/$id.err" </dev/null &
  pid=$!
  watch "$id" "$pid" "$timeout" &
  wpid=$!
  # 2>/dev/null: kein «Terminated» der Shell nach Zeitlimit oder Abbruch
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$wpid" 2>/dev/null
  wait "$wpid" 2>/dev/null
  timedout=0 cancelled=0
  [ -e "$JOBS/$id.timedout" ] && timedout=1
  [ "$timedout" = 0 ] && [ -e "$JOBS/$id.cancel" ] && cancelled=1
  finish "$id" "$rc" "$timedout" "$cancelled"
  say "Auftrag $id: Ende, Exit $rc"
}

# Aufräumen: verwaiste Geheimnisse (Airlock brach zwischen .env und .job ab)
# nach 2 Minuten, liegengebliebene Ergebnisse nach einem Tag
tidy() {
  find "$JOBS" -maxdepth 1 -type f -name '*.env' -mmin +2 -exec rm -f {} + 2>/dev/null
  find "$JOBS" -maxdepth 1 -type f \( -name '*.result' -o -name '*.out' -o -name '*.err' -o -name '*.cancel' \) -mmin +1440 -exec rm -f {} + 2>/dev/null
}

trap 'exit 0' TERM INT
mkdir -p "$JOBS"
umask 022

# Was ein Neustart mitten im Auftrag hinterlassen hat: als abgebrochen melden
for f in "$JOBS"/*.run; do
  [ -e "$f" ] || continue
  id=$(basename "$f" .run)
  echo 'Abgebrochen: der Backup-Container wurde während des Auftrags neu gestartet' >>"$JOBS/$id.err"
  finish "$id" 255 0 0
done
tidy

say "bereit, Aufträge in $JOBS"
n=0
while :; do
  for f in "$JOBS"/*.job; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .job)
    case "$id" in
      '' | *[!a-z0-9-]*)
        rm -f "$f"
        continue
        ;;
    esac
    # Abholen per rename: atomar, nie zweimal
    mv "$f" "$JOBS/$id.run" 2>/dev/null || continue
    run_job "$id" &
  done
  n=$((n + 1))
  if [ "$n" -ge 60 ]; then
    n=0
    tidy
  fi
  sleep "$POLL" &
  wait $!
done
