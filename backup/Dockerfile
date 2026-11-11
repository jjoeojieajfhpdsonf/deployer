# Backup-Container (docs/MILESTONE-BACKUP.md): restic in fester Version und
# pg_dump in derselben Hauptversion wie der Datenbank-Container
# (compose.yaml: postgres:17-alpine) – ein älteres pg_dump verweigert den
# Abzug eines neueren Servers.
#
# Läuft dauerhaft als eigener Dienst: runner.sh holt Aufträge aus dem
# gemeinsamen Auftrags-Volume (/jobs), führt restic bzw. pg_dump aus und
# schreibt Ausgabe und Ergebnis zurück. Airlock braucht dafür kein docker exec
# (Socket-Proxy EXEC=0); die Gegenseite steht in packages/api/src/backup/.
ARG RESTIC_VERSION=0.17.3
ARG POSTGRES_IMAGE=postgres:17-alpine

FROM restic/restic:${RESTIC_VERSION} AS restic

FROM ${POSTGRES_IMAGE}
# restic ist ein statisches Go-Programm und läuft so auf Alpine
COPY --from=restic /usr/bin/restic /usr/bin/restic
RUN restic version
# Ausführer: POSIX-sh, nur BusyBox aus dem Image
COPY runner.sh /usr/local/bin/airlock-backup-runner
RUN chmod 0755 /usr/local/bin/airlock-backup-runner && sh -n /usr/local/bin/airlock-backup-runner
# Kein Datenbank-Server hier: Einstieg des Postgres-Images abschalten
ENTRYPOINT []
CMD ["/usr/local/bin/airlock-backup-runner"]
